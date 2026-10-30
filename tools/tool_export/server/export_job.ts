/**
 * THE EXPORT JOB — tool_export's server-built export (tool_export at scale).
 *
 * Two background actions and one directory read, all owned by tool_export:
 *
 *   build_export_artifact  runs the ONE export producer (`openExportGrid`,
 *                          src/diffusion/export/grid.ts) and writes every line
 *                          it yields into the job's SPOOL (artifact_store.ts),
 *                          byte-identical to the get_export_grid NDJSON stream.
 *   build_export_file      turns an ENDED spool into one downloadable file
 *                          through the writer registry (writers/index.ts) and
 *                          answers the owner-only download URL.
 *   list_export_jobs       the caller's exports of this section, newest first —
 *                          how a reopened tool reconnects (the framework's
 *                          get_background_jobs knows the lane job, not the
 *                          artifact).
 *   delete_export_job      the OWNER deletes one export with all its files
 *                          before its TTL, freeing its quota bytes. Through the
 *                          owned-job door; refused (`export.artifact_busy`)
 *                          while it runs or a file is being built from it — it
 *                          never stops a job itself (stop_process does that).
 *
 * IDENTITY. The job outlives the request that started it, so everything the
 * walk needs is CAPTURED when the handler starts and handed to
 * `openExportGrid` EXPLICITLY — the principal (RE-RESOLVED when the handler
 * starts, never the submit-time one a queued job may have carried for hours:
 * currentExportPrincipal), the
 * export options (their `lang` is the data lang) and the interface lang (the
 * ambient currentApplicationLang() read at handler entry — the SUBMITTER's: the
 * job manager pins the submit-time langs around every job's worker, however
 * late a queued job's turn comes, media/jobs.ts JobRunScope). The producer builds its own identity scope
 * from those, so the spool is the same bytes in a request and in a detached
 * job (gate: tool_export_job_native.test.ts).
 *
 * OWNERSHIP. A job lives under `<root>/<userId>/<jobId>`: the caller's own
 * directory is the only one a lookup opens, so another user's job — a global
 * admin's included — is simply not there (`export.artifact_not_found`, the one
 * answer for absent / expired / not-yours). On every later read the BUILD'S
 * OWN GATES are asked AGAIN over the recorded options (access.ts
 * exportStillReadable — the same functions the build ran): a grant revoked
 * after the build closes the preview and the file too; so does a change of the
 * owner's RECORD SCOPE (projects, global admin — recorded at build as
 * manifest.record_scope) and the export's lifetime ceiling (end + TTL).
 *
 * LIFECYCLE (manifest.status): running → ended | cancelled | failed |
 * interrupted. A stop (stop_process aborts the lane job's signal; the producer
 * returns at the next record boundary with no 'end' line) deletes the
 * partial spool, marks the manifest cancelled and finishes with
 * `export.cancelled`. The SAME signal also fires for the lane deadline
 * ('failed', `export.deadline_exceeded`) and a graceful shutdown
 * ('interrupted'); the abort's cause tells them apart (abortOutcome). A failure
 * (quota, a refused gate, anything thrown) deletes the partial spool too and
 * records the error CODE and its converter-filtered details — never an
 * internal message — in the manifest; list_export_jobs serves them with the
 * registry label_key (summarizeJobError).
 */

import { config } from '../../../src/config/config.ts';
import { isDiffusionLangCode } from '../../../src/config/lang_code.ts';
import { isMediaModel } from '../../../src/core/concepts/media.ts';
import {
	DedaloError,
	type ErrorDetailScalar,
	isDedaloError,
	isErrorCode,
	ok,
	specOf,
	toDedaloError,
	toErrorBody,
} from '../../../src/core/errors/index.ts';
import { jobAbortInfo, mediaJobs } from '../../../src/core/media/jobs.ts';
import { getModelByTipo } from '../../../src/core/ontology/resolver.ts';
import { currentApplicationLang, currentDataLang } from '../../../src/core/resolve/request_lang.ts';
import {
	getPermissions,
	type Principal,
	resolvePrincipal,
} from '../../../src/core/security/permissions.ts';
import { listBackgroundJobs } from '../../../src/core/tools/background.ts';
import {
	type ToolActionContext,
	type ToolAdmissionContext,
	type ToolResponse,
	toolRequestId,
} from '../../../src/core/tools/module.ts';
import {
	type ExportExternalDegradation,
	openExportGrid,
} from '../../../src/diffusion/api/export.ts';
import { type ExportReadCheckMemo, exportRecordScope, exportStillReadable } from './access.ts';
import {
	type ArtifactJobRef,
	type ArtifactStore,
	assertManifestOptionsSize,
	EXPORT_FORMATS,
	type ExportArtifactFile,
	type ExportFormat,
	type ExportJobState,
	type ExportJobStatus,
	type ExportManifest,
	effectiveJobStatus,
	openArtifactStore,
	type SpoolWriter,
	thisBootLaneJobId,
} from './artifact_store.ts';
import { exportArtifactUrl } from './download.ts';
import { assertExportSqoSections, exportSqoSectionTargets } from './tool_export.ts';
import { buildArtifactFile } from './writers/index.ts';
import type { ExportWriterOptions } from './writers/types.ts';

// ---------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------

/** Records between two checkpoints at most (the producer's hydrate chunk). */
export const CHECKPOINT_RECORDS = 500;
/** Minimum spacing of two time-driven checkpoints. */
export const CHECKPOINT_MS = 250;

/**
 * The status a reader should see: artifact_store.ts effectiveJobStatus — the
 * SAME liveness verdict (runningJobLive, with this store's TTL) the sweep and
 * the owner's delete act on. A 'running' export whose writer is certainly gone
 * is reported 'interrupted' now, not after the sweep; one another live process
 * is still writing stays 'running' (and deleteIdleJob refuses it as busy).
 */
export function effectiveStatus(
	manifest: ExportJobState,
	store: Pick<ArtifactStore, 'ttlHours'>,
): ExportJobStatus {
	return effectiveJobStatus(manifest, { ttlHours: store.ttlHours });
}

/** The background actions the per-user cap counts (lanes 'export' and 'export_file'). */
export const EXPORT_LANE_ACTIONS: readonly string[] = [
	'build_export_artifact',
	'build_export_file',
];

/**
 * PER-USER ADMISSION over the export lanes (the actions' `admit` hook, run
 * by scheduleBackground in the SAME synchronous step that registers the job —
 * so concurrent submissions cannot all count the same registry and pass the
 * cap together; SYNCHRONOUS by contract, module.ts): a user may have at most `limit`
 * (DEDALO_EXPORT_JOBS_PER_USER) export jobs queued or running at once. The lanes
 * queue FIFO with small budgets, so without this one user could queue N full
 * exports and every other user's export would wait behind them. Refused with
 * `export.too_many_jobs` — synchronous, nothing queued. The count is the
 * framework's own in-process job registry (the jobs die with the process, so
 * it cannot go stale across a restart).
 */
export function admitExportJob(
	context: ToolAdmissionContext,
	limit: number = config.ops.exportJobsPerUser,
): void {
	if (!context.background) return;
	const inFlight = listBackgroundJobs('tool_export', context.userId).filter(
		(job) => job.status === 'running' && EXPORT_LANE_ACTIONS.includes(job.action),
	).length;
	if (inFlight >= limit) {
		throw new DedaloError('export.too_many_jobs', {
			details: { limit },
			coordinates: { user_id: context.userId, in_flight: inFlight },
		});
	}
}

/**
 * How many slots of the SHARED `export_file` lane one user may hold at once:
 * every slot but one (at least one). The lane's budget is small (2 by
 * default) and its jobs have no deadline — a media ZIP of a large selection
 * streams for hours — so the per-user total alone (DEDALO_EXPORT_JOBS_PER_USER,
 * 2) let ONE user fill the whole lane and every other user's CSV wait FIFO
 * behind it: the outcome the lane was split out to prevent. With this share a
 * lane of N >= 2 slots always keeps one for somebody else. (A lane an operator
 * set to 1 slot is one user's by construction.)
 */
export function exportFileLaneShare(laneBudget: number): number {
	return Math.max(1, laneBudget - 1);
}

/**
 * build_export_file's admission: the user's running FILE BUILDS against the
 * smaller of the per-user total (DEDALO_EXPORT_JOBS_PER_USER) and the user's
 * share of the shared `export_file` lane (exportFileLaneShare over the lane's
 * live budget). Same refusal, same synchronous contract.
 *
 * The user's running WALKS (build_export_artifact) are deliberately NOT
 * counted: a file is built from an export that has already ENDED, in a lane of
 * its own, so a walk still running (or two) must never block downloading a
 * finished one (amended 2026-09-24, review). A walk's own admission
 * (admitExportJob) still counts both kinds.
 */
export function admitExportFileJob(
	context: ToolAdmissionContext,
	limits: { perUser?: number; laneBudget?: number } = {},
): void {
	if (!context.background) return;
	const share = Math.max(
		1,
		Math.min(
			limits.perUser ?? config.ops.exportJobsPerUser,
			exportFileLaneShare(limits.laneBudget ?? mediaJobs.laneDepths().export_file.max),
		),
	);
	const inLane = listBackgroundJobs('tool_export', context.userId).filter(
		(job) => job.status === 'running' && job.action === 'build_export_file',
	).length;
	if (inLane >= share) {
		throw new DedaloError('export.too_many_jobs', {
			details: { limit: share },
			coordinates: { user_id: context.userId, lane: 'export_file', in_lane: inLane },
		});
	}
}

/** A background-only action refuses a foreground call (the lane is the concurrency budget). */
function assertBackground(context: ToolActionContext, action: string): void {
	if (context.background !== true) {
		throw new DedaloError('request.invalid_options', {
			publicMessage: `${action} runs as a background job only (options.background_running = true)`,
			coordinates: { tool: 'tool_export', action },
		});
	}
}

/** A required non-empty string option, else request.invalid_options. */
function requiredString(options: Record<string, unknown>, key: string): string {
	const value = options[key];
	if (typeof value !== 'string' || value === '') {
		throw new DedaloError('request.invalid_options', {
			publicMessage: `options.${key} is required`,
		});
	}
	return value;
}

/**
 * THE OWNED-JOB DOOR every read of an existing export goes through (preview,
 * file build, listing): the job must be the CALLER's (it is looked up under
 * the caller's own directory), belong to the section the request was gated on,
 * and the build's own gates must still pass (exportStillReadable). Every
 * refusal is the same `export.artifact_not_found` — no existence oracle.
 */
export async function resolveOwnedJob(
	store: ArtifactStore,
	principal: Principal,
	userId: number,
	sectionTipo: string,
	jobId: unknown,
): Promise<{ job: ArtifactJobRef; manifest: ExportManifest }> {
	const job = store.jobRef(userId, typeof jobId === 'string' ? jobId : '');
	const manifest = await store.readManifest(job);
	const notFound = () =>
		new DedaloError('export.artifact_not_found', {
			coordinates: { user_id: userId, job_id: job.jobId },
		});
	if (manifest.user_id !== userId || manifest.section_tipo !== sectionTipo) throw notFound();
	if (!(await exportStillReadable(principal, manifest, store))) throw notFound();
	return { job, manifest };
}

/**
 * THE OWNER'S DISCARD DOOR (delete_export_job): the job must be the CALLER's
 * (looked up under the caller's own directory, the manifest names the caller)
 * and belong to the gated section — and NOTHING more. Deliberately not
 * resolveOwnedJob: "may read" and "may discard" are different questions. An
 * export its owner may no longer READ (a grant revoked, the record scope
 * changed, past end + TTL) still holds that owner's quota bytes, and deleting
 * it discloses nothing (the answer is the id and the bytes the owner's own
 * export held). Refusing it would leave the owner quota-locked by exports they
 * can neither see nor remove. Same one answer for absent / not-yours.
 */
export async function resolveOwnedJobToDiscard(
	store: ArtifactStore,
	userId: number,
	sectionTipo: string,
	jobId: unknown,
): Promise<ArtifactJobRef> {
	const job = store.jobRef(userId, typeof jobId === 'string' ? jobId : '');
	const manifest = await store.readManifest(job);
	if (manifest.user_id !== userId || manifest.section_tipo !== sectionTipo) {
		throw new DedaloError('export.artifact_not_found', {
			coordinates: { user_id: userId, job_id: job.jobId },
		});
	}
	return job;
}

/**
 * RECLAIM what the owner can no longer use, when they need the space: every
 * finished export of theirs (any section) that fails the build's own gates now
 * (access.ts exportStillReadable: a revoked grant, a changed record scope, past
 * end + TTL) is deleted — it is a copy of records its only reader may not read,
 * so nobody can ever be served it, and until the hourly sweep (which reclaims
 * only on expiry) it would count against the quota and refuse the next export
 * with `export.artifact_quota` over bytes the owner cannot even list. Run by the
 * two doors that consume quota (a new export, a file build) before they write.
 * A running export, or one a live file build holds, is left alone (the store's
 * deleteIdleJob refuses it busy). Answers how many were reclaimed.
 */
export async function reclaimUnreadableExports(
	store: ArtifactStore,
	principal: Principal,
	userId: number,
): Promise<number> {
	let reclaimed = 0;
	const memo: ExportReadCheckMemo = {};
	// A running export is never reclaimed: its request (options) is not even read.
	const idle = await store.listJobs(
		userId,
		(state) => state.user_id === userId && effectiveStatus(state, store) !== 'running',
	);
	for (const manifest of idle) {
		if (await exportStillReadable(principal, manifest, store, memo)) continue;
		try {
			await store.deleteIdleJob(store.jobRef(userId, manifest.job_id));
			reclaimed++;
		} catch (error) {
			// busy (a live build) or already gone: the next reclaim or the sweep.
			// Anything else is loud but never blocks the door that asked.
			if (!isDedaloError(error)) {
				console.warn(`[tool_export] reclaim of export ${manifest.job_id} failed`, error);
			}
		}
	}
	return reclaimed;
}

/**
 * Every section an export READS: the exported section, the SQO's sections and
 * every section a declared ddo path steps through — recorded in the manifest as
 * the export's read set (informational; the doors re-check the build's own
 * gates through access.ts exportStillReadable).
 */
export function exportReadSections(options: Record<string, unknown>): string[] {
	const found = new Set<string>();
	const add = (value: unknown): void => {
		if (typeof value === 'string' && value !== '') found.add(value);
		else if (Array.isArray(value)) for (const entry of value) add(entry);
	};
	add(options.section_tipo);
	add(exportSqoSectionTargets(options));
	const ddos = Array.isArray(options.ar_ddo_to_export) ? options.ar_ddo_to_export : [];
	for (const ddo of ddos) {
		const path = (ddo as { path?: unknown } | null)?.path;
		if (!Array.isArray(path)) continue;
		for (const step of path) add((step as { section_tipo?: unknown } | null)?.section_tipo);
	}
	return [...found];
}

// ---------------------------------------------------------------------------
// build_export_artifact
// ---------------------------------------------------------------------------

/** One progress payload (the lane job's frame `data`; job_follow renders `msg`). */
export interface ExportProgress {
	msg: string;
	job_id: string;
	written: number;
	total: number | null;
	is_running: boolean;
}

/** Everything one artifact run needs — explicit, nothing ambient. */
export interface ExportArtifactRun {
	store: ArtifactStore;
	principal: Principal;
	userId: number;
	/** The tool_export options (section_tipo, sqo, ar_ddo_to_export, data_format, breakdown, lang…). */
	options: Record<string, unknown>;
	/** The interface lang, captured at submit. */
	applicationLang: string;
	signal?: AbortSignal;
	publishProgress?: (data: ExportProgress) => void;
	backgroundJobId?: string | null;
	/** Test seams (never from the wire). */
	hydrateBatch?: number;
	indexEvery?: number;
	checkpointRecords?: number;
	checkpointMs?: number;
	/** Awaited after each checkpoint (the spool is flushed and the manifest current). */
	onCheckpoint?: (state: { job: ArtifactJobRef; written: number }) => Promise<void>;
}

/** What a finished artifact run answers (also the lane job's final frame data). */
export interface ExportArtifactSummary {
	job_id: string;
	status: 'ended';
	total: number | null;
	records: number;
	rows: number;
	spool_bytes: number;
	columns: number[];
	unresolved: string[];
	/**
	 * The walk was NARROWED by the ACL frontier (an SQO hop through a component
	 * the owner cannot read answers 1=0, an order hop is dropped): the file holds
	 * fewer or differently ordered records than asked for. A FLAG, never the
	 * refusals themselves — the same one-notice / no-coordinates rule as the
	 * envelope's `perm.out_of_scope` notice (frontier_scope.ts
	 * frontierRefusalNotice): a refusal can name a record the owner may not see.
	 * The coordinates stay in the manifest (server-side) and the operator log.
	 */
	narrowed: boolean;
	/**
	 * The export's EXTERNAL-SOURCE summary (grid.ts
	 * OpenedExportGrid.externalDegradation): null when every component_external
	 * cell resolved cleanly; else counts per (service, state), the records
	 * affected, a capped sample, and whether the files are `incomplete` (a value
	 * the source could not give is missing) and a re-run can plausibly fix it
	 * (`retryable`). Served to the OWNER only (the sample names the owner's own
	 * exported records and the remote ids they reference).
	 */
	external_degraded: ExportExternalDegradation | null;
}

/**
 * The export options the build READS and the later doors RE-CHECK — the only
 * keys that travel into the manifest (an ALLOWLIST: transport flags and any
 * unknown key the caller adds are dropped, never persisted). The producer
 * (grid.ts openExportGridInScope: section_tipo, sqo, ar_ddo_to_export,
 * data_format, breakdown, lang, fill_the_gaps), the re-check (access.ts
 * exportStillReadable: sqo, ar_ddo_to_export) and summarizeJob (data_format,
 * breakdown) read nothing else. A key the producer starts reading is added
 * HERE, or the recorded build and the re-check drift from what ran.
 */
export const EXPORT_MANIFEST_OPTION_KEYS = [
	'section_tipo',
	'sqo',
	'ar_ddo_to_export',
	'data_format',
	'breakdown',
	'lang',
	'fill_the_gaps',
] as const;

/**
 * The options the export RUNS on and RECORDS: the allowlisted keys, refused
 * (request.invalid_options) above MANIFEST_OPTIONS_MAX_BYTES — before the
 * producer opens or a job directory exists.
 */
export function manifestOptions(options: Record<string, unknown>): Record<string, unknown> {
	const recorded: Record<string, unknown> = {};
	for (const key of EXPORT_MANIFEST_OPTION_KEYS) {
		if (Object.hasOwn(options, key) && options[key] !== undefined) recorded[key] = options[key];
	}
	assertManifestOptionsSize(recorded);
	return recorded;
}

/**
 * Run one export into the store: gate, open the producer, create the job,
 * write every line, checkpoint, finish. Returns the summary, or throws —
 * `export.cancelled` on a stop (partial spool deleted), the original error on
 * a failure (partial spool deleted, code + wire details recorded).
 */
export async function runExportArtifact(run: ExportArtifactRun): Promise<ExportArtifactSummary> {
	const { store, principal, userId } = run;
	// The build runs on exactly what it records (allowlisted, size-capped), so
	// the later re-checks over manifest.options judge the export that ran.
	const options = manifestOptions(run.options);
	const sectionTipo = requiredString(options, 'section_tipo');
	await assertExportSqoSections(principal, options);
	// The owner's record scope, taken BEFORE the walk: a scope change during the
	// walk then closes the export too (never bound to a scope newer than its rows).
	const recordScope = await exportRecordScope(principal);
	// The space the owner can no longer use is theirs again before the quota asks.
	await reclaimUnreadableExports(store, principal, userId);

	// The producer opens FIRST: its eager gates (Gate B, the dataframe columns)
	// and the selection run here, so a refusal leaves no job directory behind.
	// selectionAdmission 'queue': this job was ADMITTED by its lane, so with
	// every selection slot held (selection_cursor.ts — the lane budget may exceed
	// the slots, and request-path streams hold slots too) it WAITS for the next
	// one instead of failing with export.busy; the job's signal ends the wait.
	const grid = await openExportGrid(
		{ principal, options, applicationLang: run.applicationLang },
		// captureMedia: the spool's media.ndjson — the media ZIP's input (row_media.ts)
		{
			signal: run.signal,
			hydrateBatch: run.hydrateBatch,
			captureMedia: true,
			selectionAdmission: 'queue',
		},
	);
	let created: { job: ArtifactJobRef; manifest: ExportManifest };
	try {
		created = await store.createJob({
			userId,
			sectionTipo,
			sections: exportReadSections(options),
			options,
			recordScope,
			applicationLang: run.applicationLang,
			backgroundJobId: run.backgroundJobId ?? null,
			indexEvery: run.indexEvery,
		});
	} catch (error) {
		await grid.lines.return(undefined);
		throw error;
	}
	const { job, manifest } = created;
	let writer: SpoolWriter;
	try {
		// Can refuse AFTER createJob: its own quota check counts the manifest
		// createJob just wrote, and the spool files open exclusively ('wx').
		writer = await store.openSpoolWriter(job, { indexEvery: manifest.index_every });
	} catch (error) {
		await grid.lines.return(undefined).catch(() => undefined);
		await failJob(store, job, null, error, run.signal);
		throw error;
	}

	try {
		await pumpLines(run, job, grid.lines, writer, grid);
	} catch (error) {
		await grid.lines.return(undefined).catch(() => undefined);
		await failJob(store, job, writer, error, run.signal);
		throw error;
	}
	if (!writer.stats.ended) {
		// No 'end' line: the producer stopped at a record boundary (the signal) —
		// a stop, a deadline or a shutdown (abortOutcome tells them apart).
		const stopped = abortOutcome(job, run.signal, null)?.error ?? cancelledError(job);
		await failJob(store, job, writer, stopped, run.signal);
		throw stopped;
	}
	return finishJob(run, job, writer, grid);
}

/** Write every producer line into the spool, checkpointing on the way. */
async function pumpLines(
	run: ExportArtifactRun,
	job: ArtifactJobRef,
	lines: AsyncGenerator<Record<string, unknown>>,
	writer: SpoolWriter,
	grid: ExportLiveNotes,
): Promise<void> {
	const everyRecords = run.checkpointRecords ?? CHECKPOINT_RECORDS;
	const everyMs = run.checkpointMs ?? CHECKPOINT_MS;
	let lastRecords = 0;
	let lastAt = Date.now();
	for await (const line of lines) {
		await writer.write(line);
		if (line.t === 'meta') {
			await checkpoint(run, job, writer, 0, grid);
			continue;
		}
		if (line.t !== 'row' || Number(line.sub ?? 0) !== 0) continue;
		// A record just STARTED, so every record before it is complete.
		const complete = writer.stats.records - 1;
		const due =
			complete - lastRecords >= everyRecords ||
			(complete > lastRecords && Date.now() - lastAt >= everyMs);
		if (!due) continue;
		await checkpoint(run, job, writer, complete, grid);
		lastRecords = complete;
		lastAt = Date.now();
	}
}

/**
 * Make the complete records visible (spool flushed up to the last whole
 * record), bring the manifest up to date (it is also the heartbeat) and
 * publish one progress frame.
 */
async function checkpoint(
	run: ExportArtifactRun,
	job: ArtifactJobRef,
	writer: SpoolWriter,
	written: number,
	grid: ExportLiveNotes,
): Promise<void> {
	await writer.flush();
	const stats = writer.stats;
	const total = totalOf(stats.meta);
	await run.store.updateManifest(job, {
		// Every grant the committed spool was read under (a superset is fine: a
		// pair allowed for a record not yet committed is still one the walk read).
		frontier_grants: recordedFrontierGrants(grid.frontierGrants),
		// LIVE: a running export's list/preview already warn while it walks
		external_degraded: grid.externalDegradation(),
		media_models: await recordedMediaModels(stats.mediaComponentTipos),
		records: written,
		rows: stats.rows,
		spool_bytes: stats.bytes,
		grid_bytes: stats.committedGridBytes,
		total,
		meta: stats.meta,
	});
	run.publishProgress?.({
		msg: total === null ? `Exported ${written}` : `Exported ${written} / ${total}`,
		job_id: job.jobId,
		written,
		total,
		is_running: true,
	});
	await run.onCheckpoint?.({ job, written });
}

/** The producer's live runtime-grant set (grid.ts OpenedExportGrid.frontierGrants). */
type ExportFrontierGrants = ReadonlyMap<string, { section_tipo: string; component_tipo: string }>;

/** The producer's LIVE notes a checkpoint records (grid.ts OpenedExportGrid). */
interface ExportLiveNotes {
	frontierGrants: ExportFrontierGrants;
	externalDegradation: () => ExportExternalDegradation | null;
}

/**
 * The manifest's `media_models`: the distinct MEDIA models of the components
 * the spool's media.ndjson names (the walk captured them — row_media.ts),
 * sorted. Data-exact: an export whose relations reach no stored file records
 * [] and offers no media ZIP.
 */
export async function recordedMediaModels(componentTipos: readonly string[]): Promise<string[]> {
	const models = new Set<string>();
	for (const tipo of componentTipos) {
		const model = await getModelByTipo(tipo);
		if (typeof model === 'string' && isMediaModel(model)) models.add(model);
	}
	return [...models].sort();
}

/** The manifest form of the runtime grants: a sorted, detached copy. */
function recordedFrontierGrants(
	grants: ExportFrontierGrants,
): { section_tipo: string; component_tipo: string }[] {
	return [...grants.entries()]
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
		.map(([, grant]) => ({
			section_tipo: grant.section_tipo,
			component_tipo: grant.component_tipo,
		}));
}

function totalOf(meta: Record<string, unknown> | null): number | null {
	const total = meta?.total;
	return typeof total === 'number' && Number.isFinite(total) ? total : null;
}

/** Close the spool and record the finished export (the notes are complete now). */
async function finishJob(
	run: ExportArtifactRun,
	job: ArtifactJobRef,
	writer: SpoolWriter,
	grid: ExportLiveNotes & {
		unresolved: readonly string[];
		frontierRefusals: readonly unknown[];
	},
): Promise<ExportArtifactSummary> {
	let summary: ExportArtifactSummary;
	try {
		summary = await closeAndRecordEnded(run, job, writer, grid);
	} catch (error) {
		// The final flush (ENOSPC) or the terminal manifest write failed: the job
		// must still END — 'failed', spool deleted, quota freed — never stay
		// 'running' (undeletable, unswept, polled forever) for the rest of the boot.
		await failJob(run.store, job, writer, error, run.signal);
		throw error;
	}
	run.publishProgress?.({
		msg: `Exported ${summary.records}`,
		job_id: job.jobId,
		written: summary.records,
		total: summary.total,
		is_running: false,
	});
	return summary;
}

/** `finishJob`'s fallible half: close the spool, write the 'ended' manifest. */
async function closeAndRecordEnded(
	run: ExportArtifactRun,
	job: ArtifactJobRef,
	writer: SpoolWriter,
	grid: ExportLiveNotes & {
		unresolved: readonly string[];
		frontierRefusals: readonly unknown[];
	},
): Promise<ExportArtifactSummary> {
	const stats = await writer.close();
	const summary: ExportArtifactSummary = {
		job_id: job.jobId,
		status: 'ended',
		total: totalOf(stats.meta),
		records: stats.records,
		rows: stats.rows,
		spool_bytes: stats.bytes,
		columns: stats.columns ?? [],
		unresolved: [...grid.unresolved],
		narrowed: grid.frontierRefusals.length > 0,
		external_degraded: grid.externalDegradation(),
	};
	await run.store.updateManifest(job, {
		status: 'ended',
		ended_at: new Date().toISOString(),
		meta: stats.meta,
		total: summary.total,
		records: summary.records,
		rows: summary.rows,
		spool_bytes: summary.spool_bytes,
		grid_bytes: stats.committedGridBytes,
		columns: summary.columns,
		unresolved: summary.unresolved,
		external_degraded: summary.external_degraded,
		media_models: await recordedMediaModels(stats.mediaComponentTipos),
		// server-side only (never served): the coordinates of every narrowing
		frontier_refusals: structuredClone([...grid.frontierRefusals]),
		// the complete runtime grant set, re-asked by every later read
		frontier_grants: recordedFrontierGrants(grid.frontierGrants),
	});
	return summary;
}

function cancelledError(job: ArtifactJobRef): DedaloError {
	return new DedaloError('export.cancelled', { coordinates: { job_id: job.jobId } });
}

/**
 * THE OUTCOME OF AN ABORTED RUN, by WHY the signal fired (media/jobs.ts
 * jobAbortInfo) — the same controller serves three different events:
 *
 *  - the lane DEADLINE: 'failed' with export.deadline_exceeded {limit_s} (an
 *    operator limit, never presented as the user's Stop);
 *  - a graceful SHUTDOWN (restart, persist_config, code update): 'interrupted',
 *    the state a restart leaves an export in — the user runs it again;
 *  - the user's STOP, or an abort the manager did not label (a caller's own
 *    controller), or a thrown export.cancelled: 'cancelled'.
 *
 * null when the run was not aborted (the error is a failure of its own).
 */
function abortOutcome(
	job: ArtifactJobRef,
	signal: AbortSignal | undefined,
	error: unknown,
): { status: 'cancelled' | 'failed' | 'interrupted'; error: DedaloError | null } | null {
	const abort = jobAbortInfo(signal);
	if (abort?.cause === 'shutdown') return { status: 'interrupted', error: null };
	if (abort?.cause === 'deadline') {
		const limitMs = abort.limitMs ?? 0;
		return {
			status: 'failed',
			error: new DedaloError('export.deadline_exceeded', {
				details: { limit_s: Math.ceil(limitMs / 1000) },
				coordinates: { job_id: job.jobId, limit_ms: limitMs },
			}),
		};
	}
	if (signal?.aborted === true || (isDedaloError(error) && error.code === 'export.cancelled')) {
		return { status: 'cancelled', error: cancelledError(job) };
	}
	return null;
}

/**
 * A run that did not end: delete the partial spool and record why — by
 * `abortOutcome` when the signal fired ('cancelled' for a stop, 'failed' +
 * export.deadline_exceeded for the lane deadline, 'interrupted' for a
 * shutdown), else 'failed' with the error thrown.
 * Only the error CODE and its WIRE details are recorded (the converter's
 * `toErrorBody` filter: `details_keys`, scalars) — never a message or a
 * coordinate: the manifest is served back to the owner.
 */
async function failJob(
	store: ArtifactStore,
	job: ArtifactJobRef,
	/** null when the spool never opened: whatever it left is deleted by name. */
	writer: SpoolWriter | null,
	error: unknown,
	signal: AbortSignal | undefined,
): Promise<void> {
	try {
		if (writer === null) await store.deleteSpool(job);
		else await writer.abort();
	} catch {
		// Cleanup is best effort; the sweep reclaims a leftover, the manifest says failed.
	}
	const aborted = abortOutcome(job, signal, error);
	const status = aborted?.status ?? 'failed';
	const cause = aborted === null ? toDedaloError(error) : aborted.error;
	const body = cause === null ? null : toErrorBody(cause);
	const recorded: ExportManifest['error'] =
		body === null
			? null
			: body.details === undefined
				? { code: body.code }
				: { code: body.code, details: body.details };
	try {
		await store.updateManifest(job, {
			status,
			ended_at: new Date().toISOString(),
			error: recorded,
		});
	} catch (writeError) {
		// The original error is what surfaces; this one is LOUD, because the
		// manifest now still says 'running'. It is not stuck: its lane job is no
		// longer running, which the liveness rule reads (artifact_store.ts
		// sameBootWriterGone), so readers see 'interrupted' and the sweep and the
		// owner's delete reclaim it without a restart.
		console.error(
			`[tool_export] job ${job.jobId}: the terminal manifest write failed; it stays 'running' until the sweep marks it interrupted`,
			writeError,
		);
	}
}

/**
 * THE PRINCIPAL AS OF NOW, for a background export handler. The executor hands
 * the handler the Principal resolved at SUBMIT; the export lanes queue FIFO
 * with no deadline, so that object can be hours old when the handler starts.
 * `isGlobalAdmin` is the one field that goes stale (grants and projects are
 * re-read by user id), and it decides the whole walk: a global admin's walk is
 * unscoped (no projects filter, no dd478 allow-list, no frontier, Gates A/B
 * skipped). An admin demoted while queued must get the scoped walk — or none —
 * never the unscoped one, whose counts (`meta.total`, the progress frames, the
 * job's response) would reach them. So the handler re-resolves the principal
 * and re-asks the dispatcher's SECTION read grant on it (a refusal is
 * `perm.denied`, before anything is written); every gate, the record scope and
 * the walk then run on it. (The dispatcher's TOOL gate is not re-asked here:
 * it changes no byte the walk produces, and every door that later serves the
 * export — the dispatcher's, and the download route's exportToolAuthorized —
 * asks it on every request.)
 */
export async function currentExportPrincipal(context: ToolActionContext): Promise<Principal> {
	const principal = await resolvePrincipal(context.userId);
	const sectionTipo = requiredString(context.options, 'section_tipo');
	if ((await getPermissions(principal, sectionTipo, sectionTipo)) < 1) {
		throw new DedaloError('perm.denied', {
			coordinates: { user_id: context.userId, section_tipo: sectionTipo, door: 'tool_export' },
		});
	}
	return principal;
}

/**
 * The export's DATA lang: the one the user picked in the tool (`options.lang`),
 * else the submitter's data lang captured at handler entry. A re-run never
 * reaches this (buildOptionsOf returns the recorded options, lang included);
 * an artifact recorded before the language existed takes the submitter's.
 */
export function withExportLang(
	options: Record<string, unknown>,
	submitterDataLang: string,
): Record<string, unknown> {
	const lang = options.lang ?? submitterDataLang;
	if (typeof lang !== 'string' || !isDiffusionLangCode(lang)) {
		throw new DedaloError('request.invalid_options', {
			publicMessage: 'options.lang must be a data language code (e.g. lg-eng)',
		});
	}
	return { ...options, lang };
}

/** tool_export.build_export_artifact — background (lane 'export'). */
export async function toolExportBuildArtifact(context: ToolActionContext): Promise<ToolResponse> {
	assertBackground(context, 'build_export_artifact');
	// The interface lang and the data lang, read at ENTRY (before any await) from
	// the ambient scope — the submitter's, pinned by the job manager at submit
	// (media/jobs.ts JobRunScope) — and handed to the run EXPLICITLY from here on.
	const applicationLang = currentApplicationLang();
	const submitterDataLang = currentDataLang();
	const store = openArtifactStore();
	// as of NOW, not of submit (currentExportPrincipal)
	const principal = await currentExportPrincipal(context);
	const summary = await runExportArtifact({
		store,
		principal,
		userId: context.userId,
		options: withExportLang(await buildOptionsOf(store, principal, context), submitterDataLang),
		// Read at handler entry (above): the submit-time lang the job manager pins.
		applicationLang,
		signal: context.signal,
		publishProgress: context.publishProgress,
		// The lane job writing this export: recorded in the manifest and served
		// as ExportJobSummary.background_job_id (a reopened client follows /
		// stops exactly that job instead of guessing among the lane's).
		backgroundJobId: context.backgroundJobId ?? null,
	});
	return ok(summary, { requestId: toolRequestId(context) });
}

/**
 * THE OPTIONS A BUILD RUNS ON. Normally the request's own. With
 * `options.rerun_of` (an artifact id — the client's "Run again" on an export an
 * external source left INCOMPLETE, ExportArtifactSummary.external_degraded):
 * the RECORDED options of that export — the same selection, columns, format,
 * breakdown and lang, whatever the reopened tool's form now shows. The source
 * export is opened through the owner's READ door (resolveOwnedJob: the caller's
 * own, of the gated section, still readable — anything else is
 * `export.artifact_not_found`), and the recorded options then pass every gate
 * of a fresh build (runExportArtifact → openExportGrid): a re-run is a NEW
 * export, never a privilege the old one carried.
 */
async function buildOptionsOf(
	store: ArtifactStore,
	principal: Principal,
	context: ToolActionContext,
): Promise<Record<string, unknown>> {
	const rerunOf = context.options.rerun_of;
	if (rerunOf === undefined || rerunOf === null) return context.options;
	const { manifest } = await resolveOwnedJob(
		store,
		principal,
		context.userId,
		String(context.options.section_tipo ?? ''),
		rerunOf,
	);
	const recorded = structuredClone(manifest.options);
	// An artifact recorded before the data-lang selector was written in the
	// install's historical default (lg-spa): a re-run keeps that language, it
	// does not take the submitter's.
	if (recorded.lang === undefined) recorded.lang = 'lg-spa';
	return recorded;
}

// ---------------------------------------------------------------------------
// build_export_file
// ---------------------------------------------------------------------------

/** What a built file answers (the lane job's final frame data). */
export interface ExportFileResult {
	job_id: string;
	format: ExportFormat;
	basename: string;
	url: string;
	bytes: number;
	rows: number;
}

/** A browser origin (`scheme://host[:port]`, http/https only), else ''. */
export function validOrigin(value: unknown): string {
	if (typeof value !== 'string' || value === '') return '';
	try {
		const url = new URL(value);
		if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
		return url.origin === value ? value : '';
	} catch {
		return '';
	}
}

function parseFormat(value: unknown): ExportFormat {
	if (typeof value === 'string' && (EXPORT_FORMATS as readonly string[]).includes(value)) {
		return value as ExportFormat;
	}
	throw new DedaloError('request.invalid_options', {
		publicMessage: `options.format must be one of ${EXPORT_FORMATS.join(', ')}`,
	});
}

/** Everything one file build needs. */
export interface ExportFileRun {
	store: ArtifactStore;
	principal: Principal;
	userId: number;
	options: Record<string, unknown>;
	signal: AbortSignal;
}

/** Build one file of an ended export the caller owns. */
export async function runBuildExportFile(run: ExportFileRun): Promise<ExportFileResult> {
	const { store, options } = run;
	const format = parseFormat(options.format);
	const sectionTipo = requiredString(options, 'section_tipo');
	const { job } = await resolveOwnedJob(
		store,
		run.principal,
		run.userId,
		sectionTipo,
		options.job_id,
	);
	// After the door (the export being built from is readable, so never reclaimed).
	await reclaimUnreadableExports(store, run.principal, run.userId);
	const writerOptions: ExportWriterOptions = {
		origin: validOrigin(options.origin),
		showTipoInLabel: options.show_tipo_in_label === true,
	};
	if (format === 'media_zip') {
		// The quality choice, as the client's download modal makes it: PER MEDIA
		// MODEL (`media_qualities` {model: quality} — an export with an image and
		// a pdf column needs one quality each) and/or one quality for every model
		// (`media_quality`). The writer validates both against the ladders
		// (media.invalid_quality / request.invalid_options) before writing.
		const quality = typeof options.media_quality === 'string' ? options.media_quality : '';
		if (quality !== '') writerOptions.mediaQuality = quality;
		const perModel = options.media_qualities;
		if (perModel !== undefined && perModel !== null) {
			if (typeof perModel !== 'object' || Array.isArray(perModel)) {
				throw new DedaloError('request.invalid_options', {
					publicMessage: 'options.media_qualities must be an object {model: quality}',
				});
			}
			writerOptions.mediaQualities = perModel as Record<string, string>;
		}
	}
	// The file NAME is derived by buildArtifactFile from every option that
	// changes the bytes (writers/index.ts artifactFileVariant) — never chosen here.
	const file: ExportArtifactFile = await buildArtifactFile({
		store,
		job,
		format,
		options: writerOptions,
		signal: run.signal,
	});
	return {
		job_id: job.jobId,
		format,
		basename: file.basename,
		url: exportArtifactUrl(job.jobId, file.basename),
		bytes: file.bytes,
		rows: file.rows,
	};
}

/** tool_export.build_export_file — background (lane 'export_file'), owner-only. */
export async function toolExportBuildFile(context: ToolActionContext): Promise<ToolResponse> {
	assertBackground(context, 'build_export_file');
	const result = await runBuildExportFile({
		store: openArtifactStore(),
		// as of NOW, not of submit (currentExportPrincipal)
		principal: await currentExportPrincipal(context),
		userId: context.userId,
		options: context.options,
		signal: context.signal ?? new AbortController().signal,
	});
	return ok(result, { requestId: toolRequestId(context) });
}

// ---------------------------------------------------------------------------
// list_export_jobs
// ---------------------------------------------------------------------------

/** One export as the reconnecting client sees it. */
export interface ExportJobSummary {
	job_id: string;
	status: ExportJobStatus;
	section_tipo: string;
	created_at: string;
	updated_at: string;
	ended_at: string | null;
	total: number | null;
	records: number;
	rows: number;
	data_format: unknown;
	breakdown: unknown;
	files: (ExportArtifactFile & { url: string })[];
	/** The lane job that wrote (or is writing) this export; null when unknown or written by another boot. */
	background_job_id: string | null;
	/** See ExportArtifactSummary.narrowed (known once the export ended). */
	narrowed: boolean;
	/** See ExportArtifactSummary.external_degraded — LIVE while running (checkpoints). */
	external_degraded: ExportExternalDegradation | null;
	error: ExportJobError | null;
}

/**
 * Why an export did not end, as its owner's client renders it: the registry
 * `label_key` + `details` (error_text fills the label in the user's language),
 * the registry English `message` as the fallback, and `retryable`. The same
 * fields and the same disclosure as an envelope v2 error body: the details
 * were filtered by the converter when recorded, and are filtered AGAIN here
 * against the CURRENT registry (a manifest on disk outlives a registry edit).
 * A code the registry no longer knows answers only `{code}`.
 */
export interface ExportJobError {
	code: string;
	label_key?: string;
	message?: string;
	retryable?: boolean;
	details?: Record<string, ErrorDetailScalar>;
}

/** The served error of a manifest (see ExportJobError). */
export function summarizeJobError(error: ExportManifest['error']): ExportJobError | null {
	if (error === null || error === undefined) return null;
	if (!isErrorCode(error.code)) return { code: error.code };
	const spec = specOf(error.code);
	const details: Record<string, ErrorDetailScalar> = {};
	for (const key of spec.details_keys ?? []) {
		const value = error.details?.[key];
		if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
			details[key] = value;
		}
	}
	return {
		code: error.code,
		label_key: spec.label_key,
		message: spec.message,
		retryable: spec.retryable,
		...(Object.keys(details).length === 0 ? {} : { details }),
	};
}

export function summarizeJob(
	manifest: ExportManifest,
	store: Pick<ArtifactStore, 'ttlHours'>,
): ExportJobSummary {
	return {
		job_id: manifest.job_id,
		status: effectiveStatus(manifest, store),
		section_tipo: manifest.section_tipo,
		created_at: manifest.created_at,
		updated_at: manifest.updated_at,
		ended_at: manifest.ended_at,
		total: manifest.total,
		records: manifest.records,
		rows: manifest.rows,
		data_format: manifest.options.data_format ?? null,
		breakdown: manifest.options.breakdown ?? null,
		files: Object.values(manifest.files).map((file) => ({
			...file,
			url: exportArtifactUrl(manifest.job_id, file.basename),
		})),
		// another boot's lane id may repeat in this one: served as null (thisBootLaneJobId)
		background_job_id: thisBootLaneJobId(manifest),
		narrowed: Array.isArray(manifest.frontier_refusals) && manifest.frontier_refusals.length > 0,
		// a manifest written before 2026-09-24 has no key: nothing was recorded
		external_degraded: manifest.external_degraded ?? null,
		error: summarizeJobError(manifest.error),
	};
}

/** The caller's exports of one section that it may still read, newest first. */
export async function listOwnedExportJobs(
	store: ArtifactStore,
	principal: Principal,
	userId: number,
	sectionTipo: string,
): Promise<ExportJobSummary[]> {
	const out: ExportJobSummary[] = [];
	const memo: ExportReadCheckMemo = {};
	// Filtered on the small STATE: another section's export never has its
	// request (up to MANIFEST_OPTIONS_MAX_BYTES of options) read or parsed.
	const ofSection = await store.listJobs(
		userId,
		(state) => state.user_id === userId && state.section_tipo === sectionTipo,
	);
	for (const manifest of ofSection) {
		if (!(await exportStillReadable(principal, manifest, store, memo))) continue;
		out.push(summarizeJob(manifest, store));
	}
	return out;
}

/**
 * A submitted walk of the section that has NO MANIFEST yet: queued behind the
 * lane (budget 1, no deadline — it can wait hours) or about to create it. The
 * manifest is written only when the handler starts, so without this a
 * reopened tool could not see its own queued export: it painted an older one
 * as current, never armed Stop, and the queued job still held a per-user slot.
 */
export interface PendingExportJob {
	/** The lane job: follow it (job_follow) and stop it (`<id>.json` pfile). */
	background_job_id: string;
	/** Date.now() at submit. */
	submitted_at: number;
}

/**
 * The caller's OWN running build_export_artifact lane jobs of `sectionTipo`
 * that no manifest names yet, newest first. Own jobs only — a global admin's
 * reconnect is about their own exports, as list_export_jobs is. The lane is
 * read BEFORE the manifests, so a job that creates its manifest in between is
 * listed there, never as pending.
 */
export async function pendingExportJobs(
	store: Pick<ArtifactStore, 'listJobStates'>,
	userId: number,
	sectionTipo: string,
): Promise<PendingExportJob[]> {
	const lane = listBackgroundJobs('tool_export', userId).filter(
		(job) =>
			job.userId === userId &&
			job.action === 'build_export_artifact' &&
			job.status === 'running' &&
			job.sectionTipo === sectionTipo,
	);
	if (lane.length === 0) return [];
	const written = new Set<string>();
	for (const manifest of await store.listJobStates(userId)) {
		const laneJobId = thisBootLaneJobId(manifest);
		if (laneJobId !== null) written.add(laneJobId);
	}
	return lane
		.filter((job) => !written.has(job.id))
		.map((job) => ({ background_job_id: job.id, submitted_at: job.startedAt ?? 0 }));
}

/**
 * tool_export.list_export_jobs — the caller's own exports of options.section_tipo
 * (`jobs`, newest first) and its submitted walks of it that have no manifest
 * yet (`pending`, newest first — see PendingExportJob).
 */
export async function toolExportListJobs(context: ToolActionContext): Promise<ToolResponse> {
	const sectionTipo = requiredString(context.options, 'section_tipo');
	const store = openArtifactStore();
	const pending = await pendingExportJobs(store, context.userId, sectionTipo);
	const jobs = await listOwnedExportJobs(store, context.principal, context.userId, sectionTipo);
	return ok({ jobs, pending }, { requestId: toolRequestId(context) });
}

// ---------------------------------------------------------------------------
// delete_export_job
// ---------------------------------------------------------------------------

/** What an owner's delete answers. */
export interface ExportDeleteResult {
	job_id: string;
	deleted: true;
	/** The bytes the export held — returned to the user's quota. */
	freed_bytes: number;
}

/**
 * Delete one export the caller owns — through the DISCARD door
 * (resolveOwnedJobToDiscard: the caller's own directory, the gated section),
 * NOT the read door: a job of another user or of another section is
 * `export.artifact_not_found` and never deleted, but one its owner may no
 * longer read (revoked grant, changed record scope, expired) IS deletable —
 * deleting discloses nothing and frees the owner's quota. RUNNING-JOB POLICY: refuse, do
 * not stop. Stopping is its own door (stop_process on the lane job's pfile,
 * which the client already holds); deleting under a live writer would race its
 * quota measure and its terminal manifest write. The store decides under the
 * manifest lock (deleteIdleJob): a running export or a live file build answers
 * `export.artifact_busy` and nothing is removed.
 */
export async function runDeleteExportJob(run: {
	store: ArtifactStore;
	principal: Principal;
	userId: number;
	options: Record<string, unknown>;
}): Promise<ExportDeleteResult> {
	const sectionTipo = requiredString(run.options, 'section_tipo');
	const job = await resolveOwnedJobToDiscard(
		run.store,
		run.userId,
		sectionTipo,
		run.options.job_id,
	);
	const { freedBytes } = await run.store.deleteIdleJob(job);
	return { job_id: job.jobId, deleted: true, freed_bytes: freedBytes };
}

/** tool_export.delete_export_job — foreground, owner-only. */
export async function toolExportDeleteJob(context: ToolActionContext): Promise<ToolResponse> {
	const result = await runDeleteExportJob({
		store: openArtifactStore(),
		principal: context.principal,
		userId: context.userId,
		options: context.options,
	});
	return ok(result, { requestId: toolRequestId(context) });
}
