/**
 * Diffusion RUNNER — the data-plane process (DIFFUSION_SPEC §4.2).
 *
 * Spawned by the scheduler as
 * `bun run src/diffusion/runner.ts --job <uuid> --epoch <attempt>`
 * (or run by an out-of-machine runner daemon — it only needs Postgres + the
 * publication targets). One process per run: own memory ceiling, crash-
 * isolated from the interactive server, killable. Communicates EXCLUSIVELY
 * through the job row: heartbeat, progress totals, checkpoint, terminal
 * state. Zero runner↔server RPC by design.
 *
 * THE LEASE (PUB-13). The row can be re-claimed under this process — the
 * sweeper requeues a run whose heartbeat went stale and a later claim hands it
 * to a new runner while this one is merely slow, not dead. The claim's epoch
 * (`attempt`) therefore arrives on the ARGV, is never re-read from the row, and
 * fences every write: the first refused write throws `diffusion.lease_revoked`
 * and this process exits WITHOUT writing anything — a terminal state written by
 * the loser would overwrite the run the live attempt is still doing
 * (engineering/wire_contract/WC-2026-09-05-diffusion-lease-epoch-fence.md).
 *
 * THE TARGET FENCE (DIFF-2, WC-2026-09-30-diffusion-target-fence). The lease
 * fences the job row; the TARGET (a MariaDB database, a files directory) is
 * fenced too: every durable effect of a run — the schema step, each batch, the
 * close — is ONE unit (jobs/target_fence.ts withFencedBatch): one Postgres
 * transaction holding the target's advisory lock, THEN the lease re-read `FOR
 * KEY SHARE`, then the target I/O and the batch's tail (dd1758 rows, run
 * ledger, progress, checkpoint), committed together. A runner revoked while it
 * waited for a busy target writes nothing; the sweeper cannot revoke a runner
 * in the middle of its batch; a record deleted while its batch waited is
 * revalidated under the lock and unpublished, never written.
 *
 * REAL PIPELINE (stages B→G, spec §4.1): compiled plan → resolvePublication
 * async generator (selection → resolution → transform → projection) → format
 * writer session (schema-ensure once, batched idempotent writes). THE RESUME
 * (DIFF-1, WC-2026-09-30-diffusion-run-ledger): each committed batch appends
 * its run-state events (the frontier's queue/open/used, the writer's per-record
 * wrote/removed) to the job's RUN LEDGER and commits the checkpoint
 *   checkpoint = { v: 2, cursor, run_started_at, processed, batch_seq, writer, errors }
 * in the same unit. A resumed runner replays the ledger into the exact frontier
 * the dead one held (resolve/frontier_ledger.ts), restarts the primaries after
 * `cursor`, reopens its writer from `writer`, and its close() consolidates the
 * artifacts of the WHOLE run (the ledger's manifest) — gate:
 * diffusion_resume_ledger_native (crash among the primaries, crash in the
 * frontier drain, kill -9: byte-identical trees). A checkpoint without `v: 2`
 * (pre-ledger) restarts the run from zero. `run_started_at` is captured ONCE
 * on the first attempt and reused on resume so the publish_timestamp system
 * field stays deterministic. A cancelled run never consolidates.
 *
 * STUB MODE (spec.options.stub_run === true): the P0 lifecycle harness —
 * deterministic fake batches, no plan, no writes. Kept for the queue/SSE
 * gates (test/unit/diffusion_actions.test.ts); the real client never sends
 * the flag, and a stub run publishes nothing (no dd1758 'published' rows).
 */

// S2-20 boot registration: the runner is its own process — load the component
// registry so the ontology↔components model lookup is registered before plan
// resolution touches component models (see core/ontology/resolver.ts seam note).
import '../core/components/registry.ts';
import { readOptionalString, readString } from '../config/readers.ts';
import { closeDatabasePool, withTransaction } from '../core/db/postgres.ts';
import {
	ensureDiffusionActivityTable,
	logDiffusionActivity,
} from '../core/diffusion_bridge/diffusion_delete.ts';
import { DedaloError, isDedaloError, logError, toErrorBody } from '../core/errors/index.ts';
import { startRunnerMediaCopyRelay } from './api/media_copy.ts';
import type { DiffusionJobRow, JobLease } from './jobs/queue.ts';
import {
	checkpointJob,
	failedJobResult,
	finishJob,
	getJobById,
	heartbeatJob,
	isCancelRequested,
	updateJobProgress,
} from './jobs/queue.ts';
import {
	appendRunLedger,
	clearRunLedger,
	openArtifactManifest,
	readRunLedger,
	removedIdsFor,
} from './jobs/run_ledger.ts';
import { RUNNER_HEARTBEAT_MS } from './jobs/scheduler.ts';
import {
	assertRunnerPool,
	publicationTargetLockKey,
	withFencedBatch,
} from './jobs/target_fence.ts';
import type { ResolvedBatch } from './resolve/resolver.ts';
import type { WriterCloseContext, WriterRunSummary } from './writers/types.ts';

/** Parse `--<name> <value>` (also tolerates `--<name>=<value>`). */
function parseArgument(argv: string[], name: string): string | null {
	const flagIndex = argv.indexOf(`--${name}`);
	if (flagIndex !== -1 && argv[flagIndex + 1] !== undefined) return argv[flagIndex + 1] ?? null;
	const inline = argv.find((argument) => argument.startsWith(`--${name}=`));
	return inline !== undefined ? inline.slice(`--${name}=`.length) : null;
}

/** The cancellation `msg` line (totals.msg + result.msg) the client renders. */
const CANCELLED_MSG = 'Process cancelled by user';
/**
 * The two running `msg` prefixes — selection, then linked records. Pinned in
 * tool_diffusion's report_model.js MSG (its no-state fallback classifier reads
 * both as 'running'); keep the two in step.
 */
/**
 * A file run's consolidated artifacts → the client result fields the final SSE
 * chunk renders (consolidated_files / diffusion_data, old engine
 * index.ts:529-563; projected by jobs/sse.ts progressDataFromJob). Writers
 * append them as prefixed zero-count table entries (writers/rdf.ts
 * CONSOLIDATED_* docs); every other entry stays a table.
 *
 * The URL is ADMIN-FACING (the tool's Download button), so it rides the media
 * address the client receives everywhere else — `config.media.webBase`, not the
 * hardcoded same-origin `/dedalo/<mediaDir>`: on a split-origin install that
 * opened the application's address and failed (WC-042 addendum 2026-11-22,
 * owner Q10). Published data is untouched — this is the job report only.
 * EXPORTED for test/unit/diffusion_report_url_split_origin.test.ts.
 */
export async function consolidatedFileResults(
	summaryTables: WriterRunSummary['tables'],
	format: string,
): Promise<{ tables: WriterRunSummary['tables']; fileResultFields: Record<string, unknown> }> {
	const { config } = await import('../config/config.ts');
	const mediaUrl = config.media.webBase;
	const consolidated: { merged_url?: string; zip_url?: string } = {};
	const tables: WriterRunSummary['tables'] = [];
	for (const entry of summaryTables) {
		if (entry.table_name.startsWith('consolidated_merged:')) {
			consolidated.merged_url = mediaUrl + entry.table_name.slice('consolidated_merged:'.length);
		} else if (entry.table_name.startsWith('consolidated_zip:')) {
			consolidated.zip_url = mediaUrl + entry.table_name.slice('consolidated_zip:'.length);
		} else {
			tables.push(entry);
		}
	}
	if (consolidated.merged_url === undefined && consolidated.zip_url === undefined) {
		return { tables, fileResultFields: {} };
	}
	return {
		tables,
		fileResultFields: {
			consolidated_files: consolidated,
			diffusion_data: [consolidated.merged_url, consolidated.zip_url]
				.filter((url): url is string => url !== undefined)
				.map((url) => ({ file_url: url })),
			diffusion_class: `diffusion_${format}`,
		},
	};
}

export const PROCESSING_PREFIX = 'Processing records ';
export const LINKED_PREFIX = 'Publishing linked records: ';

/** Cap on error strings persisted to the job row (full detail goes to stderr). */
const MAX_PERSISTED_ERRORS = 50;

// readEnv (not process.env): keeps the ../private/.env half of the config
// precedence chain working in runner processes too (audit S2-21).
const STUB_BATCH_DELAY_MS = Number(readString('DIFFUSION_RUNNER_STUB_DELAY_MS'));

/** The P0 lifecycle stub (see module header). */
async function runStubJob(job: DiffusionJobRow, lease: JobLease): Promise<void> {
	const jobId = job.job_id;
	const startedAt = Date.now();
	const total = Math.max(1, Math.min(job.spec.estimated_total || 10, 10000));
	const resumeFrom = Number((job.checkpoint as { counter?: unknown }).counter ?? 0) || 0;
	for (let counter = resumeFrom + 1; counter <= total; counter++) {
		if (await isCancelRequested(jobId)) {
			await finishJob(
				lease,
				'cancelled',
				failedJobResult(new DedaloError('diffusion.cancelled'), CANCELLED_MSG),
			);
			return;
		}
		await Bun.sleep(STUB_BATCH_DELAY_MS);
		await updateJobProgress(lease, {
			counter,
			msg: `${PROCESSING_PREFIX}${counter} of ${total}...`,
			current: { section_id: counter, time: STUB_BATCH_DELAY_MS },
			total_ms: Date.now() - startedAt,
		});
		await checkpointJob(lease, { counter });
	}
	await finishJob(lease, 'completed', { ok: true, msg: 'OK. Request done', tables: [] });
}

/** The job's totals.msg while a fenced unit waits for a busy publication target. */
export const TARGET_BUSY_MSG = 'Waiting for the publication target (busy)…';

/** The resolver's keyset batch when DEDALO_DIFFUSION_BATCH_RECORDS is unset (resolver default). */
const DEFAULT_BATCH_RECORDS = 500;

/** DEDALO_DIFFUSION_BATCH_RECORDS, read at run start (never at module level). */
function batchRecords(): number {
	const configured = Number(readOptionalString('DEDALO_DIFFUSION_BATCH_RECORDS'));
	return Number.isInteger(configured) && configured > 0 ? configured : DEFAULT_BATCH_RECORDS;
}

/**
 * The persisted resume point of a run (`checkpoint` column) — v2, the run
 * ledger's companion (DIFF-1): `batch_seq` counts the committed batches whose
 * events the ledger holds; `cursor` is only the PRIMARY keyset position;
 * `writer` is the writer session's own checkpoint (counters, a streamed
 * file's durable length). A non-empty checkpoint without `v: 2` (pre-ledger)
 * cannot say what the run already published and RESTARTS the run.
 * `errors` is the run's summary error lines so far (capped at
 * MAX_PERSISTED_ERRORS): committed with the batch that produced them, so a
 * resumed run still ends "Partial success" for what the batches BEFORE the
 * crash reported (the writer's own lines ride `writer`).
 */
interface RunCheckpoint {
	v: 2;
	cursor?: number;
	run_started_at: number;
	processed?: number;
	/** Records of LINKED (frontier) batches published so far — the second phase. */
	linked_processed?: number;
	batch_seq: number;
	writer?: unknown;
	errors?: string[];
}

/** `lines` then `extra`, deduplicated, capped at MAX_PERSISTED_ERRORS. */
function mergeErrorLines(lines: readonly string[], extra: readonly string[]): string[] {
	const merged = [...lines];
	for (const line of extra) {
		if (merged.length >= MAX_PERSISTED_ERRORS) break;
		if (!merged.includes(line)) merged.push(line);
	}
	return merged;
}

/**
 * The records of a batch this run PUBLISHES — the dd1758 'published' ledger
 * rows and the vanished-record check are theirs: gate 'publish', MINUS the
 * records the resolver held back on an external OUTAGE (owner C49,
 * ResolvedBatch.skipped — no row written, no row removed, the previous
 * publication and its ledger row stand; the next run retries). PURE, exported
 * for the gate (diffusion_external_chain_native).
 */
export function publishedRecordsOf(
	batch: Pick<ResolvedBatch, 'records' | 'skipped'>,
): ResolvedBatch['records'] {
	const held = new Set(batch.skipped.map((entry) => String(entry.sectionId)));
	return batch.records.filter(
		(record) => record.status === 'publish' && !held.has(String(record.sectionId)),
	);
}

/** The real publication pipeline. */
async function runPublicationJob(job: DiffusionJobRow, lease: JobLease): Promise<void> {
	const jobId = job.job_id;
	const startedAt = Date.now();

	// Lazy imports keep the stub path (and the scheduler's spawn) light.
	const { getCompiledPlan } = await import('./plan/cache.ts');
	const { getDiffusionWriter } = await import('./writers/registry.ts');
	const { resolvePublication } = await import('./resolve/resolver.ts');
	const { replayFrontier } = await import('./resolve/frontier_ledger.ts');
	const { existingSectionIds } = await import('./resolve/selection.ts');
	const { planDegradationReportLines } = await import('./plan/compile.ts');
	const { retryPendingUnpublishOpportunistically } = await import('./jobs/pending_retry.ts');
	const { getMatrixTableFromTipo } = await import('../core/ontology/resolver.ts');

	// Two connections: the fenced unit + the heartbeat beside it.
	assertRunnerPool();
	const plan = await getCompiledPlan(job.spec.diffusion_element_tipo);
	const writer = getDiffusionWriter(plan.format);
	const targetKey = publicationTargetLockKey(plan);
	// DDL outside every unit: its memo must never record a CREATE a rolled-back
	// unit undid.
	await ensureDiffusionActivityTable();

	const stored = job.checkpoint as Partial<RunCheckpoint> & Record<string, unknown>;
	// Deterministic across resumes: the publish timestamp is the FIRST
	// attempt's start, persisted in the checkpoint (never re-stamped — a legacy
	// checkpoint keeps it too).
	const runStartedAt = Number(stored.run_started_at) || Math.floor(startedAt / 1000);
	let batchSeq = stored.v === 2 ? Number(stored.batch_seq) || 0 : 0;
	let afterSectionId = stored.v === 2 ? Number(stored.cursor) || 0 : 0;
	let processed = stored.v === 2 ? Number(stored.processed) || 0 : 0;
	let linkedProcessed = stored.v === 2 ? Number(stored.linked_processed) || 0 : 0;
	let errors: string[] = [];
	const trackError = (message: string): void => {
		errors = mergeErrorLines(errors, [message]);
		console.error(`[diffusion runner] ${message}`);
	};

	/** A run that cannot resume starts over (lease-fenced; the ledger and checkpoint together). */
	const resetRun = async (): Promise<void> => {
		await withTransaction(async () => {
			await clearRunLedger(lease);
			await checkpointJob(lease, { v: 2, run_started_at: runStartedAt, batch_seq: 0 });
		});
		batchSeq = 0;
		afterSectionId = 0;
		processed = 0;
		linkedProcessed = 0;
	};
	if (stored.v !== 2 && Object.keys(stored).length > 0) await resetRun();

	// COMPILE-TIME degradations (audit B3): fields whose ddo chain was narrowed
	// so the element could publish at all. They are seeded into the run's error
	// list — the operator's only view of a partial publication — so the run
	// finishes "Partial success" naming every column that publishes empty
	// instead of quietly shipping nulls forever.
	for (const line of planDegradationReportLines(plan)) trackError(line);

	// Opportunistic dd1758 unpublish retry (PHP dd_diffusion_api::diffuse
	// :171-183): if the targets are up for publishing they are up for deleting.
	// Fire-and-forget by construction — the helper never throws, and it
	// single-flights itself across concurrent runners; its SQL executor takes
	// each target's fence lock itself (bounded).
	//
	// FIRST INVOCATION ONLY, like the oracle (`if (empty($rqo->sqo->offset))`,
	// :174): a RESUME (committed batches in the ledger) is the continuation of a
	// run that already paid this debt, not a new occasion to pay it.
	const isFirstInvocation = batchSeq === 0;
	if (isFirstInvocation) {
		const retryReport = await retryPendingUnpublishOpportunistically();
		for (const line of retryReport.log) console.error(`[diffusion runner] ${line}`);
		// A debt still owed after the retry is a PARTIAL publication in the only
		// sense the operator cares about: records the archive deleted are still
		// live on the public site. It belongs in the job row, not just on stderr.
		for (const line of retryReport.errors) trackError(line);
	}

	// Resume: the frontier the committed batches left, replayed from the run
	// ledger; the writer from its own checkpoint.
	let resume = batchSeq > 0 ? await replayFrontier(readRunLedger(jobId)) : undefined;
	let session = await writer.open(plan, {
		jobId,
		resume: batchSeq > 0 ? (stored.writer ?? null) : null,
	});
	if (session.continuity === 'restart_required') {
		console.error(
			`[diffusion runner] job ${jobId}: the writer cannot honour the checkpoint — the run restarts`,
		);
		await session.abort();
		await resetRun();
		resume = undefined;
		session = await writer.open(plan, { jobId, resume: null });
	}
	// A resumed run's summary covers the WHOLE run: the lines the committed
	// batches reported (re-seeded lines — a plan degradation — are not doubled).
	if (batchSeq > 0 && Array.isArray(stored.errors)) {
		errors = mergeErrorLines(errors, stored.errors.map(String));
	}

	/** Every durable effect is ONE fenced unit on the target (jobs/target_fence.ts). */
	const fenced = <T>(work: () => Promise<T>) =>
		withFencedBatch(lease, targetKey, work, {
			onBusy: () =>
				updateJobProgress(lease, {
					counter: processed,
					msg: TARGET_BUSY_MSG,
					total_ms: Date.now() - startedAt,
				}),
			shouldStop: () => isCancelRequested(jobId),
		});

	/** Cancelled: the session releases its handles; NOTHING is consolidated (DIFF-1). */
	const finishCancelled = async (): Promise<void> => {
		await session.abort();
		await finishJob(
			lease,
			'cancelled',
			failedJobResult(new DedaloError('diffusion.cancelled'), CANCELLED_MSG, {
				tables: session.runSummary().tables,
			}),
		);
	};

	try {
		// Schema first, its own unit, OUTSIDE any row transaction (DDL commits).
		const schema = await fenced(() => session.ensureSchema());
		if (!schema.acquired) {
			await finishCancelled();
			return;
		}

		const options = job.spec.options as {
			levels?: unknown;
			skip_publication_state_check?: unknown;
		};
		// DIFF-01: re-derive the enqueuing principal so the primary selection honors
		// their projects filter (a non-admin publishes only in-scope records). Only
		// a concrete user (real id, or superuser -1 = unscoped) is resolved; a
		// system/unknown owner (id <= 0 and not -1) stays unscoped as before.
		const { resolvePrincipal } = await import('../core/security/permissions.ts');
		const ownerId = job.owner_user_id;
		const ownerPrincipal =
			ownerId === -1 || ownerId > 0 ? await resolvePrincipal(ownerId) : undefined;
		const batches = resolvePublication(plan, {
			sectionTipo: job.spec.section_tipo,
			// Sanitized at enqueue (sanitizeClientSqo) — stored as plain jsonb,
			// re-typed here for the resolver's Sqo signature.
			sqo: job.spec.sqo as Parameters<typeof resolvePublication>[1]['sqo'],
			runStartedAt,
			afterSectionId,
			batchSize: batchRecords(),
			skipPublicationStateCheck: options.skip_publication_state_check === true,
			maxLevels: Number(options.levels) > 0 ? Number(options.levels) : undefined,
			principal: ownerPrincipal,
			...(resume !== undefined ? { resume } : {}),
		})[Symbol.asyncIterator]();

		for (;;) {
			// Resolution and the cancel check hold no transaction.
			const step = await batches.next();
			if (step.done === true) break;
			const batch = step.value;
			if (await isCancelRequested(jobId)) {
				await finishCancelled();
				return;
			}
			// The dd1758 ledger keys on the section tipo (unchanged); PROGRESS keys on
			// the selection: only primary batches advance the counter, so it stays
			// comparable to the estimate, which counted the selection alone.
			const isPrimary = batch.section.sectionTipo === job.spec.section_tipo;
			const nextSeq = batchSeq + 1;
			const batchErrorLines = batch.errors.map(
				(fieldError) =>
					`${fieldError.sectionTipo}:${fieldError.sectionId} ${fieldError.columnName}: ${fieldError.message}`,
			);

			const unit = await fenced(async () => {
				// ── TARGET PHASE ── revalidate under the lock: a record deleted from
				// the archive while this batch waited is unpublished, never written.
				let rows = batch.rows;
				const unpublishIds = [...batch.unpublishIds];
				const publishing = publishedRecordsOf(batch);
				const vanished = new Set<string>();
				if (publishing.length > 0) {
					const table = await getMatrixTableFromTipo(batch.section.sectionTipo);
					if (table !== null) {
						const present = await existingSectionIds(
							table,
							batch.section.sectionTipo,
							publishing.map((record) => record.sectionId),
						);
						for (const record of publishing) {
							const key = String(record.sectionId);
							if (present.has(key)) continue;
							vanished.add(key);
							unpublishIds.push(record.sectionId);
						}
						if (vanished.size > 0)
							rows = rows.filter((row) => !vanished.has(String(row.sectionId)));
					}
				}
				if (rows.length > 0) await session.writeRows(batch.section, rows);
				// rdf: one document per published record (ResolvedBatch.graphs), the
				// same vanished-record filter as rows.
				const documents = (batch.graphs ?? []).filter(
					(document) => !vanished.has(String(document.sectionId)),
				);
				if (documents.length > 0) {
					if (session.writeGraphs === undefined) {
						throw new DedaloError('internal.invariant', {
							message: `diffusion runner: plan '${plan.planId}' resolved rdf graphs but its writer has no writeGraphs`,
						});
					}
					await session.writeGraphs(batch.section, documents);
				}
				if (unpublishIds.length > 0) await session.removeRecords(batch.section, unpublishIds);
				// Owner C49: a record held back on an external OUTAGE keeps its previous
				// publication — for a file writer that publication is a per-record file
				// the close consolidates FROM THE MANIFEST, so the held records are carried
				// into it here (kept, not rewritten); otherwise they vanished from the
				// merged document and zip, and a run holding every record withdrew both.
				if (batch.skipped.length > 0 && session.keepPublished !== undefined) {
					await session.keepPublished(
						batch.section,
						batch.skipped.map((entry) => entry.sectionId),
					);
				}
				const artifacts = session.takeArtifacts();
				const writerCheckpoint = await session.checkpoint();

				// ── TAIL ── committed with the target phase, or not at all.
				// dd1758 publication ledger: one 'published' row per PRIMARY record
				// per element (PHP diffusion_activity_logger convention; linked
				// frontier records ride their primary's trail). FATAL on failure: a
				// published record without its row is never unpublished on delete.
				let nextProcessed = processed;
				if (isPrimary) {
					for (const record of publishing) {
						if (vanished.has(String(record.sectionId))) continue;
						await logDiffusionActivity({
							sectionTipo: record.sectionTipo,
							sectionId: Number(record.sectionId),
							elementTipo: job.spec.diffusion_element_tipo,
							action: 1, // published
							userId: job.owner_user_id,
						});
					}
				}
				// TWO PHASES, reported apart. The selection (primary batches) is what
				// the estimate counted; the linked records (frontier: every record the
				// selection points at, `levels` deep) come after and can be several
				// times the work — a types run writes ~4x its own rows in coins. With
				// one counter the bar sat at 100% for most of the run; the phase and
				// its own counter let every display say what is actually happening.
				let nextLinked = linkedProcessed;
				if (batch.primary) nextProcessed += batch.records.length;
				else nextLinked += batch.records.length;
				await appendRunLedger(lease, nextSeq, [...batch.ledger, ...artifacts]);
				const lastRecord = batch.records[batch.records.length - 1];
				await updateJobProgress(lease, {
					counter: nextProcessed,
					phase: batch.primary ? 'selection' : 'linked',
					linked_counter: nextLinked,
					msg: batch.primary
						? `${PROCESSING_PREFIX}${nextProcessed}${job.spec.estimated_total > 0 ? ` of ${job.spec.estimated_total}` : ''}...`
						: `${LINKED_PREFIX}${nextLinked} (${batch.section.tableName})...`,
					current: { section_id: lastRecord?.sectionId, time: Date.now() - startedAt },
					total_ms: Date.now() - startedAt,
				});
				const checkpoint: RunCheckpoint = {
					v: 2,
					cursor: batch.cursor,
					run_started_at: runStartedAt,
					processed: nextProcessed,
					linked_processed: nextLinked,
					batch_seq: nextSeq,
					writer: writerCheckpoint,
					errors: mergeErrorLines(errors, batchErrorLines),
				};
				await checkpointJob(lease, checkpoint as unknown as Record<string, unknown>);
				return { processed: nextProcessed, linked: nextLinked };
			});
			if (!unit.acquired) {
				await finishCancelled();
				return;
			}
			processed = unit.value.processed;
			linkedProcessed = unit.value.linked;
			batchSeq = nextSeq;
			for (const line of batchErrorLines) trackError(line);
		}

		// ── CLOSE ── the run's consolidated artifacts from the run's manifest,
		// the terminal state and the ledger's end: one unit.
		const closed = await fenced(async () => {
			const context: WriterCloseContext = {
				manifest: () => openArtifactManifest(jobId),
				removed: (sectionTipo) => removedIdsFor(jobId, sectionTipo),
				// This close IS the target's fence holder (a leftover temp is a dead one's).
				fenced: true,
				partialIsOrphan: async (otherJobId) => {
					const other = await getJobById(otherJobId);
					return other === null || other.state === 'completed';
				},
			};
			const summary = await session.close(context);
			const allErrors = [...errors, ...summary.errors];

			// File runs: writers append consolidated artifacts as prefixed
			// zero-count table entries (see writers/rdf.ts CONSOLIDATED_* docs) —
			// lift them into the client result fields the final SSE chunk renders
			// (consolidated_files / diffusion_data, old engine index.ts:529-563;
			// projected by jobs/sse.ts progressDataFromJob finish-parity).
			const { tables, fileResultFields } =
				plan.target.kind === 'files'
					? await consolidatedFileResults(summary.tables, plan.format)
					: { tables: summary.tables, fileResultFields: {} };

			// The ledger ends with the run (fenced: before the terminal transition).
			await clearRunLedger(lease);
			// A completed job is a SUCCESS record even with per-record diagnostic
			// lines: `ok:true` + `errors` (the report model reads `errors.length`
			// for its "partial" verdict); a FAILURE record is `ok:false` + `error`.
			await finishJob(lease, 'completed', {
				ok: true,
				msg:
					allErrors.length === 0
						? 'OK. Request done'
						: `Partial success: ${allErrors.length} error(s) — see errors`,
				tables,
				errors: allErrors.slice(0, MAX_PERSISTED_ERRORS),
				...fileResultFields,
			});
		});
		if (!closed.acquired) await finishCancelled();
	} catch (error) {
		await session.abort().catch(() => {});
		throw error;
	}
}

async function runJob(jobId: string, epoch: number): Promise<void> {
	const lease: JobLease = { job_id: jobId, attempt: epoch };
	const job = await getJobById(jobId);
	if (job === null) {
		console.error(`[diffusion runner] job not found: ${jobId}`);
		return;
	}
	if (job.state !== 'running') {
		// Claimed state is a precondition — the scheduler transitions it. A
		// re-spawn on an already-terminal job is a no-op (idempotent restart).
		console.error(`[diffusion runner] job ${jobId} not in running state (${job.state})`);
		return;
	}

	// The row may already belong to a newer attempt (a re-spawn after a sweep):
	// refuse before any work rather than publish under a revoked lease.
	if (job.attempt !== epoch) {
		console.error(
			`[diffusion runner] job ${jobId} lease revoked (row attempt ${job.attempt}, argv epoch ${epoch})`,
		);
		return;
	}

	// A missed heartbeat is non-fatal (the sweeper heals on staleness) but a
	// floating rejection kills the runner process outright (S1-15) — catch it.
	// A REVOKED heartbeat is different: the row is gone to a newer attempt, so
	// the interval stops beating instead of logging once per tick forever.
	const heartbeat = setInterval(
		() =>
			void heartbeatJob(lease).catch((error) => {
				if (isDedaloError(error) && error.code === 'diffusion.lease_revoked') {
					clearInterval(heartbeat);
					console.error(`[diffusion runner] heartbeat stopped: ${error.code}`);
					return;
				}
				console.error('[diffusion runner] heartbeat failed:', error);
			}),
		RUNNER_HEARTBEAT_MS,
	);
	try {
		if ((job.spec.options as { stub_run?: unknown }).stub_run === true) {
			await runStubJob(job, lease);
		} else {
			await runPublicationJob(job, lease);
		}
	} catch (error) {
		// The persisted job `result` is a FAILURE RECORD (`{ok:false, error:{code,
		// …}, msg}` — toFailureRecord; progressDataFromJob copies it into the
		// follow stream's terminal chunk as `result`), plus the `msg` line the
		// report model reads. A typed failure (a PlanCompileError — public, its
		// cause list is the message) keeps its code; anything else is
		// `diffusion.run_failed` with the raw error as LOG-ONLY cause
		// (engineering/ERRORS_SPEC.md §5).
		const typed = isDedaloError(error)
			? error
			: new DedaloError('diffusion.run_failed', { cause: error, coordinates: { job: jobId } });
		logError(typed, { subsystem: 'diffusion runner' });
		// A REVOKED LEASE is not this run's outcome to record: the row belongs to
		// a newer attempt that is publishing right now, and a terminal write here
		// would overwrite it. Abort silently — the live epoch owns the ending.
		if (typed.code === 'diffusion.lease_revoked') {
			clearInterval(heartbeat);
			return;
		}
		await finishJob(
			lease,
			'failed',
			failedJobResult(typed, `Error. Diffusion run failed: ${toErrorBody(typed).message}`),
		).catch((finishError) => {
			// The lease can be revoked between the failure and its record — the
			// same law applies, and the abort must not become an unhandled throw.
			if (isDedaloError(finishError) && finishError.code === 'diffusion.lease_revoked') return;
			throw finishError;
		});
	} finally {
		clearInterval(heartbeat);
	}
}

if (import.meta.main) {
	const jobId = parseArgument(process.argv, 'job');
	const epochArgument = parseArgument(process.argv, 'epoch');
	const epoch = Number(epochArgument);
	if (jobId === null || epochArgument === null || !Number.isInteger(epoch)) {
		console.error('Usage: bun run src/diffusion/runner.ts --job <uuid> --epoch <attempt>');
		process.exit(2);
	}
	// SIGTERM (cancel_process on this host / systemd stop): exit promptly; the
	// job row keeps its checkpoint, and the sweeper or cancel flag settles state.
	process.on('SIGTERM', () => process.exit(143));
	// The pub/ seam reaches only this process's sinks: an unpublish this run flips must
	// reach every copy host's agent now, not at the server's next reconcile
	// (PUBLICATION_HOST_SPEC §5.2 M2). Drained, bounded, before exit.
	const relay = startRunnerMediaCopyRelay();
	await runJob(jobId, epoch);
	await relay.stop();
	await closeDatabasePool();
	process.exit(0);
}

/**
 * Exported for test/unit/diffusion_runner_native.test.ts, which drives a
 * claimed job IN-PROCESS on the suite database (enqueue → claim → runJob →
 * job row + published files) — the gate that executes this module's real
 * pipeline rather than spawning it in stub mode. The second argument is the
 * claim's EPOCH (the claimed row's `attempt`), exactly what the argv carries.
 */
export { runJob };
