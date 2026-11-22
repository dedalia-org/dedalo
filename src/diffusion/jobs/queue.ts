/**
 * Durable diffusion job queue (DIFFUSION_SPEC §4.2, DIFFUSION_PLAN D3-P0).
 *
 * The single Postgres-backed source of truth for diffusion runs. The main
 * server ENQUEUES and OBSERVES; a spawned runner process CLAIMS and EXECUTES.
 * The two sides share nothing but these rows — that is what makes runner
 * placement (local spawn vs separate machine) a deployment choice, keeps a
 * run alive across browser disconnects and server restarts, and lets any
 * server instance stream any run's progress.
 *
 * Identity model (pinned fixtures test/parity/fixtures/diffusion/pinned.ts):
 * - `job_id` (server UUID) is the durable capability — internal only.
 * - `client_process_id` is the copied client's deterministic label
 *   ('process_diffusion_{user}_{element}_{section}') — the CLIENT-FACING
 *   process_id in every wire payload. Authorization is NEVER by id knowledge:
 *   status/cancel are owner-scoped (or global admin).
 *
 * All timing math uses the DB clock (single clock); JS Date appears only in
 * the SSE projection layer (sse.ts) where the client expects epoch ms. A
 * LIVENESS stamp (`heartbeat_at`, the terminal `finished_at`) is the WALL clock
 * (`clock_timestamp()`), never `now()`: `now()` is the TRANSACTION START, and
 * since DIFF-2 the progress/checkpoint/finish writes ride the runner's fenced
 * unit — a `now()` there would set the heartbeat BACK to when a long unit
 * began, overwriting the interval heartbeat's fresher stamp, and the sweeper
 * (its KEY SHARE gone at commit) would revoke a live runner. Gate:
 * diffusion_target_fence_native "liveness stamps".
 *
 * LEASE MODEL (PUB-13, WC-2026-09-05-diffusion-lease-epoch-fence). A row can be
 * claimed more than once: the sweeper requeues a stale-heartbeat run and a later
 * claim hands it to a NEW runner. `attempt` is incremented inside the claim
 * statement and `(job_id, attempt)` is the per-claim EPOCH — the lease. Every
 * write a lease-holder makes carries it and is fenced with
 * `AND attempt = $epoch AND state = 'running'`; zero rows affected means the
 * lease was revoked and the caller throws `diffusion.lease_revoked` WITHOUT
 * writing. Reads are never fenced.
 *
 * `attempt` IS STRICTLY MONOTONIC FOR THE LIFE OF THE ROW — the claim is the
 * ONLY statement that assigns it, and only as `attempt + 1`. Nothing lowers or
 * resets it, because an epoch that can be RE-ISSUED is not an epoch: a reset
 * hands epoch 1 to a second claim while a slow-but-alive runner from the first
 * claim still holds epoch 1, and both fence legs then match for the loser (an
 * ABA on the counter — the defect this model exists to close). The retry BUDGET
 * is therefore carried by `max_attempts`, never by rewinding the epoch: the
 * admin requeue extends the budget (`max_attempts = attempt + N`) and leaves
 * the counter alone. Gate: `queue_fence_tripwire` (census of every assignment
 * to `attempt`) + `queue_fence_native` (the ABA is built and refused).
 *
 * The only unfenced writers are the control plane's own: the claim (which
 * ISSUES the epoch), the sweeper (which REVOKES it), the owner-scoped cancel
 * flag, the queued-row finalizer and the admin requeue — each state-guarded on
 * its own terms and enumerated in `queue_fence_tripwire` (which also censuses
 * the job-scoped run ledger, jobs/run_ledger.ts, on the same epoch).
 *
 * THE TARGET FENCE (DIFF-2). The epoch fences the job ROW; the runner's writes
 * to its publication TARGET are fenced by jobs/target_fence.ts: each batch is
 * one transaction holding the target's advisory lock and the job row `FOR KEY
 * SHARE` on the lease. The sweeper takes stale rows `FOR UPDATE SKIP LOCKED`,
 * so a runner inside a batch is never revoked; heartbeat, progress and the
 * cancel flag (plain UPDATEs, NO KEY UPDATE) never wait on a batch.
 *
 * ATTACH IS OWNER-SCOPED (DIFF-3). One ACTIVE run per (element, section) — the
 * partial unique index — and a second request attaches only when it is the
 * same owner's identical run; otherwise `diffusion.target_busy` (409).
 */

import { sql, withTransaction } from '../../core/db/postgres.ts';
import {
	DedaloError,
	type ErrorCode,
	type FailureRecord,
	isDedaloError,
	toFailureRecord,
} from '../../core/errors/index.ts';
import { assertPublishableElement, excludedElementTipos } from '../api/excluded_elements.ts';
import type { DiffusionJobState } from './schema.ts';
import { DIFFUSION_JOBS_TABLE, ensureDiffusionJobTables } from './schema.ts';

/** Postgres NOTIFY channel bumped on every observable job change. */
export const JOB_PROGRESS_CHANNEL = 'diffusion_job_progress';

/**
 * The heartbeat a lease-holder stamps: the wall clock, and never BACKWARDS (a
 * write that lands after a fresher one keeps the fresher). See the header.
 * Gates: diffusion_target_fence_native H (wall clock) + H2 (never backwards).
 */
const LIVENESS_NOW = 'GREATEST(heartbeat_at, clock_timestamp())';

/** The immutable enqueue spec (sanitized BEFORE it gets here — never raw client SQO). */
export interface DiffusionJobSpec {
	diffusion_element_tipo: string;
	section_tipo: string;
	/** Output format type from the element ('sql'|'rdf'|'xml'|'markdown'|...). */
	type: string;
	/** Sanitized SQO (sanitizeClientSqo output) — the record selection. */
	sqo: Record<string, unknown>;
	/** Client-estimated total records (options.total), display-only. */
	estimated_total: number;
	/** Original request options (levels, lang, ...) for the runner. */
	options: Record<string, unknown>;
}

/** One job row as read back from Postgres (jsonb columns already objects). */
export interface DiffusionJobRow {
	job_id: string;
	client_process_id: string;
	owner_user_id: number;
	kind: string;
	spec: DiffusionJobSpec;
	state: DiffusionJobState;
	checkpoint: Record<string, unknown>;
	totals: {
		counter?: number;
		total?: number;
		msg?: string;
		section_label?: string;
		/** Progress marker echoing `RecordIR.sectionId` — the diffusion IR keeps
		 * the raw/published form (string on an unswept install, or an external
		 * remote id): WC-2026-08-10-section-id-int-canonical. */
		current?: { section_id?: string | number; time?: number };
		total_ms?: number;
		/** Which half of the run is moving: the selection (`counter`, measured
		 * against `total`) or the linked records after it (`linked_counter`, no
		 * estimate exists). Absent on rows written before the split. */
		phase?: JobPhase;
		linked_counter?: number;
	};
	errors: string[];
	result: Record<string, unknown> | null;
	cancel_requested: boolean;
	attempt: number;
	max_attempts: number;
	runner: { pid?: number; host?: string };
	heartbeat_at: Date | null;
	created_at: Date;
	started_at: Date | null;
	finished_at: Date | null;
}

const JOB_COLUMNS = `job_id, client_process_id, owner_user_id, kind, spec, state,
	checkpoint, totals, errors, result, cancel_requested, attempt, max_attempts,
	runner, heartbeat_at, created_at, started_at, finished_at`;

/**
 * Normalize a raw row from Bun.sql into DiffusionJobRow. Defense-in-depth:
 * a jsonb value that was ever written double-encoded (a pre-stringified
 * parameter binds as a jsonb STRING scalar — see the enqueue comment) reads
 * back as a raw JSON string; parse-if-string keeps every caller on objects
 * even if a legacy/buggy row slips through.
 */
function normalizeJobRow(row: Record<string, unknown>): DiffusionJobRow {
	const parse = (value: unknown): unknown =>
		typeof value === 'string' ? JSON.parse(value) : value;
	return {
		...(row as unknown as DiffusionJobRow),
		spec: parse(row.spec) as DiffusionJobSpec,
		checkpoint: parse(row.checkpoint) as Record<string, unknown>,
		totals: parse(row.totals) as DiffusionJobRow['totals'],
		errors: parse(row.errors) as string[],
		result: (row.result === null ? null : parse(row.result)) as Record<string, unknown> | null,
		runner: parse(row.runner) as DiffusionJobRow['runner'],
	};
}

function normalizeJobRows(rows: unknown): DiffusionJobRow[] {
	return (rows as Record<string, unknown>[]).map(normalizeJobRow);
}

/** Notify observers (SSE pollers today, LISTEN subscribers later) of a change. */
async function notifyProgress(jobId: string): Promise<void> {
	await sql.unsafe(`SELECT pg_notify('${JOB_PROGRESS_CHANNEL}', $1)`, [jobId]);
}

/**
 * The per-claim capability: a job row plus the attempt that claimed it. Held by
 * the runner process (passed on its argv, never re-read from the row — a re-read
 * is a second race) and by the scheduler for the row it just claimed.
 */
export interface JobLease {
	job_id: string;
	attempt: number;
}

/**
 * Refuse a fenced write whose predicate matched nothing: another claim owns the
 * row (or it is no longer running). Typed, so the runner can abort its own
 * process without writing a terminal state over the live epoch's run.
 */
function assertLeaseHeld(rows: unknown, lease: JobLease, operation: string): void {
	if ((rows as unknown[]).length > 0) return;
	throw new DedaloError('diffusion.lease_revoked', {
		coordinates: { job: lease.job_id, attempt: lease.attempt, operation },
	});
}

export interface EnqueueResult {
	job: DiffusionJobRow;
	/** True when the caller's OWN identical request was already active — the
	 * caller attaches to it instead of starting a duplicate. */
	attached: boolean;
}

/** Stable JSON: object keys sorted at every depth (arrays keep their order). */
function stableJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
	if (value !== null && typeof value === 'object') {
		const entries = Object.entries(value as Record<string, unknown>)
			.filter(([, entry]) => entry !== undefined)
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
		return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`).join(',')}}`;
	}
	return JSON.stringify(value) ?? 'null';
}

/**
 * The RUN a spec asks for, canonically (DIFF-3): its format, its record
 * selection and its runner options — minus the display-only estimate
 * (`estimated_total`, `options.total`). Element and section are the conflict
 * key itself. Two requests with the same canonical spec are the same run.
 */
export function canonicalRunSpec(spec: DiffusionJobSpec): string {
	const { total: _displayOnly, ...options } = (spec.options ?? {}) as Record<string, unknown>;
	return stableJson({ type: spec.type, sqo: spec.sqo, options });
}

/** How many INSERT → read-the-live-row rounds enqueue makes before it gives up. */
const ENQUEUE_ATTEMPTS = 3;

/**
 * Enqueue a diffusion run — or, when an ACTIVE run already holds the same
 * (element, section), ATTACH to it only if it is the caller's own identical
 * request. The partial unique index is the arbiter (no read-check race), and
 * it stays keyed by the TARGET, not the owner: it is what keeps two writers
 * off one publication target.
 *
 * ATTACH IS SCOPED (DIFF-3, WC-2026-09-30-diffusion-attach-scope): the live
 * run is handed back only when its owner IS the caller (strict — admins
 * included) and its canonical spec equals the request's (canonicalRunSpec). A
 * re-click / page reload on one's own running publication reconnects, as the
 * copied client expects; anyone else — another user, or the same user asking
 * for another selection — is refused with `diffusion.target_busy` (409,
 * retryable), whose body names nothing of the live run (no id, owner or
 * label): user B never receives user A's run, and A's second selection is
 * never silently dropped into the first.
 */
export async function enqueueDiffusionJob(input: {
	ownerUserId: number;
	clientProcessId: string;
	spec: DiffusionJobSpec;
}): Promise<EnqueueResult> {
	await ensureDiffusionJobTables();
	for (let attempt = 0; attempt < ENQUEUE_ATTEMPTS; attempt++) {
		const rows = (await sql.unsafe(
			`INSERT INTO "${DIFFUSION_JOBS_TABLE}" (client_process_id, owner_user_id, spec, totals)
			 VALUES ($1, $2, $3::jsonb, $4::jsonb)
			 ON CONFLICT ((spec->>'diffusion_element_tipo'), (spec->>'section_tipo'))
				WHERE state IN ('queued','running')
			 DO NOTHING
			 RETURNING ${JOB_COLUMNS}`,
			[
				input.clientProcessId,
				input.ownerUserId,
				// Objects, NEVER JSON.stringify: a pre-stringified value binds as a
				// jsonb STRING scalar (spec->>'key' = NULL, unique index inert) —
				// verified against Bun 1.4.0 (2026-08-25; unchanged since 1.3.9). Bun
				// serializes objects to jsonb objects.
				input.spec,
				{
					counter: 0,
					total: input.spec.estimated_total,
					msg: 'Starting diffusion...',
				},
			],
		)) as unknown;
		const inserted = normalizeJobRows(rows)[0];
		if (inserted !== undefined) {
			await notifyProgress(inserted.job_id);
			return { job: inserted, attached: false };
		}
		// Conflict path: read the live run for this target.
		const active = normalizeJobRows(
			await sql.unsafe(
				`SELECT ${JOB_COLUMNS} FROM "${DIFFUSION_JOBS_TABLE}"
				 WHERE spec->>'diffusion_element_tipo' = $1 AND spec->>'section_tipo' = $2
				   AND state IN ('queued','running')
				 ORDER BY created_at DESC LIMIT 1`,
				[input.spec.diffusion_element_tipo, input.spec.section_tipo],
			),
		)[0];
		// The active run finished between INSERT and SELECT — try the INSERT again.
		if (active === undefined) continue;
		if (
			active.owner_user_id === input.ownerUserId &&
			canonicalRunSpec(active.spec) === canonicalRunSpec(input.spec)
		) {
			return { job: active, attached: true };
		}
		break;
	}
	throw new DedaloError('diffusion.target_busy', {
		coordinates: {
			element_tipo: input.spec.diffusion_element_tipo,
			section_tipo: input.spec.section_tipo,
		},
	});
}

/**
 * Claim the oldest queued job (scheduler side): queued → running under
 * FOR UPDATE SKIP LOCKED so concurrent schedulers (or a future second server
 * instance) never double-claim. Returns null when the queue is empty.
 *
 * `maxRunning` (audit S3-64): the runner budget is checked INSIDE the claim
 * statement (one snapshot) instead of the old read-count-then-claim two-step,
 * which let two scheduler instances both observe count<max and both claim.
 *
 * That alone was NOT atomic: under READ COMMITTED two CONCURRENT claim
 * statements each snapshot count(running) before either commits, both pass
 * the budget gate, and SKIP LOCKED hands them DIFFERENT queued rows — both
 * admit, overshooting the budget by one per extra concurrent claimer
 * (reproduced by the ops_diffusion_queue.test.ts concurrency gate). Admission
 * is therefore serialized with a transaction-scoped advisory lock keyed on
 * the jobs table: the second claimer's statement only runs after the first
 * COMMITs its 'running' row, so its count subquery sees it. A claim is one
 * fast indexed statement — the serialization window is negligible.
 */
export async function claimNextQueuedJob(
	runnerHost: string,
	maxRunning?: number,
): Promise<DiffusionJobRow | null> {
	await ensureDiffusionJobTables();
	return withTransaction(async () => {
		await sql.unsafe('SELECT pg_advisory_xact_lock(hashtext($1))', [
			`${DIFFUSION_JOBS_TABLE}:claim`,
		]);
		const rows = (await sql.unsafe(
			`UPDATE "${DIFFUSION_JOBS_TABLE}" jobs
			 SET state = 'running', started_at = COALESCE(jobs.started_at, now()),
			     heartbeat_at = now(), attempt = jobs.attempt + 1,
			     runner = jsonb_build_object('host', $1::text)
			 WHERE jobs.job_id = (
				SELECT job_id FROM "${DIFFUSION_JOBS_TABLE}"
				WHERE state = 'queued'
				  AND ($2::int IS NULL OR
				       (SELECT count(*) FROM "${DIFFUSION_JOBS_TABLE}" WHERE state = 'running') < $2::int)
				ORDER BY created_at
				FOR UPDATE SKIP LOCKED
				LIMIT 1
			 )
			 RETURNING ${JOB_COLUMNS}`,
			[runnerHost, maxRunning ?? null],
		)) as unknown;
		return normalizeJobRows(rows)[0] ?? null;
	});
}

/**
 * Record the spawned runner's pid on a claimed job (post-spawn, scheduler side).
 * LEASE-FENCED: by the time the spawn returns the sweeper may already have
 * requeued and re-claimed the row, and stamping the dead runner's pid onto the
 * live epoch would make the sweeper's cross-check name the wrong process.
 */
export async function recordRunnerPid(lease: JobLease, pid: number): Promise<void> {
	const rows = (await sql.unsafe(
		`UPDATE "${DIFFUSION_JOBS_TABLE}"
		 SET runner = runner || jsonb_build_object('pid', $3::int)
		 WHERE job_id = $1 AND attempt = $2::int AND state = 'running'
		 RETURNING job_id`,
		[lease.job_id, lease.attempt, pid],
	)) as unknown;
	assertLeaseHeld(rows, lease, 'recordRunnerPid');
}

/**
 * Runner heartbeat — proves liveness to the sweeper. LEASE-FENCED: a revoked
 * runner that kept beating would keep the row looking alive and stop the
 * sweeper from ever healing the run the live epoch is doing.
 */
export async function heartbeatJob(lease: JobLease): Promise<void> {
	const rows = (await sql.unsafe(
		`UPDATE "${DIFFUSION_JOBS_TABLE}" SET heartbeat_at = ${LIVENESS_NOW}
		 WHERE job_id = $1 AND attempt = $2::int AND state = 'running'
		 RETURNING job_id`,
		[lease.job_id, lease.attempt],
	)) as unknown;
	assertLeaseHeld(rows, lease, 'heartbeatJob');
}

/**
 * Runner progress update (merged into totals) + observer notify. Mirrors the
 * old engine's update_progress fields (progress_store.ts:62-103) so the SSE
 * projection is a straight read.
 */
export async function updateJobProgress(
	lease: JobLease,
	update: {
		counter: number;
		phase?: JobPhase;
		linked_counter?: number;
		msg?: string;
		section_label?: string;
		/** Same IR-marker union as DiffusionJobRow.totals.current above. */
		current?: { section_id?: string | number; time?: number };
		total_ms?: number;
		error?: string;
	},
): Promise<void> {
	const { error, ...totalsPatch } = update;
	const rows = (await sql.unsafe(
		`UPDATE "${DIFFUSION_JOBS_TABLE}"
		 SET totals = totals || $3::jsonb,
		     heartbeat_at = ${LIVENESS_NOW},
		     errors = CASE WHEN $4::text IS NULL THEN errors ELSE errors || to_jsonb($4::text) END
		 WHERE job_id = $1 AND attempt = $2::int AND state = 'running'
		 RETURNING job_id`,
		[lease.job_id, lease.attempt, totalsPatch, error ?? null],
	)) as unknown;
	assertLeaseHeld(rows, lease, 'updateJobProgress');
	await notifyProgress(lease.job_id);
}

/** Persist the resume checkpoint of the last COMMITTED chunk (runner side). */
export async function checkpointJob(
	lease: JobLease,
	checkpoint: Record<string, unknown>,
): Promise<void> {
	const rows = (await sql.unsafe(
		`UPDATE "${DIFFUSION_JOBS_TABLE}"
		 SET checkpoint = $3::jsonb, heartbeat_at = ${LIVENESS_NOW}
		 WHERE job_id = $1 AND attempt = $2::int AND state = 'running'
		 RETURNING job_id`,
		[lease.job_id, lease.attempt, checkpoint],
	)) as unknown;
	assertLeaseHeld(rows, lease, 'checkpointJob');
}

/**
 * The persisted job OUTCOME (`result` column; the follow stream's terminal
 * chunk copies it as `result`): a success record `{ok:true, msg, tables?,
 * errors?, …}` (per-record diagnostic lines in `errors` — a completed job is
 * not a failure) or a converter-made FailureRecord `{ok:false, error, msg}`
 * (`diffusion.cancelled` / `diffusion.run_failed` / `diffusion.runner_lost` /
 * `diffusion.runner_spawn_failed` / a typed compile failure).
 */
export type DiffusionJobResult =
	| ({ ok: true; msg: string } & Record<string, unknown>)
	| (FailureRecord & { msg: string });

/** A FailureRecord with the `msg` line the client renders (converter-made error, reader-facing extras). */
export function failedJobResult(
	error: unknown,
	msg: string,
	extend: Record<string, unknown> = {},
): DiffusionJobResult {
	return { ...toFailureRecord(error, extend), msg };
}

/**
 * Terminal transition (lease-holder side): completed | failed | cancelled.
 * LEASE-FENCED — the write this fence exists for. A revoked runner finishing
 * "its" job would stamp the loser's outcome onto the row the LIVE attempt is
 * still publishing into, and the follow stream would report the loser's state
 * as the run's ending.
 */
export async function finishJob(
	lease: JobLease,
	state: Extract<DiffusionJobState, 'completed' | 'failed' | 'cancelled'>,
	result: DiffusionJobResult,
): Promise<void> {
	const rows = (await sql.unsafe(
		`UPDATE "${DIFFUSION_JOBS_TABLE}"
		 SET state = $3, result = $4::jsonb, finished_at = clock_timestamp(),
		     totals = totals || jsonb_build_object('msg', $5::text)
		 WHERE job_id = $1 AND attempt = $2::int AND state = 'running'
		 RETURNING job_id`,
		[lease.job_id, lease.attempt, state, result, result.msg],
	)) as unknown;
	assertLeaseHeld(rows, lease, 'finishJob');
	await notifyProgress(lease.job_id);
}

/**
 * Terminal transition for a job that was NEVER claimed (server side): the
 * owner-scoped cancel of a QUEUED row. No lease exists — no runner ever owned
 * it — so the guard is the state itself; a row that got claimed between the
 * cancel flag and this call belongs to its runner, which honors the flag.
 */
export async function finalizeQueuedJob(
	jobId: string,
	state: Extract<DiffusionJobState, 'cancelled' | 'failed'>,
	result: DiffusionJobResult,
): Promise<void> {
	await sql.unsafe(
		`UPDATE "${DIFFUSION_JOBS_TABLE}"
		 SET state = $2, result = $3::jsonb, finished_at = now(),
		     totals = totals || jsonb_build_object('msg', $4::text)
		 WHERE job_id = $1 AND state = 'queued'`,
		[jobId, state, result, result.msg],
	);
	await notifyProgress(jobId);
}

/**
 * Cancellation request (server side, owner-scoped; admin passes ownerUserId
 * null). Marks the flag — the runner honors it between batches — and returns
 * whether an ACTIVE job matched (the pinned cancel_process contract).
 */
export async function requestCancel(
	clientProcessId: string,
	ownerUserId: number | null,
): Promise<{ cancelled: boolean; job: DiffusionJobRow | null }> {
	await ensureDiffusionJobTables();
	const rows = (await sql.unsafe(
		`UPDATE "${DIFFUSION_JOBS_TABLE}"
		 SET cancel_requested = true,
		     errors = errors || to_jsonb('Process cancelled by user'::text),
		     totals = totals || jsonb_build_object('msg', 'Process cancelled by user')
		 WHERE client_process_id = $1
		   AND state IN ('queued','running')
		   AND ($2::int IS NULL OR owner_user_id = $2::int)
		 RETURNING ${JOB_COLUMNS}`,
		[clientProcessId, ownerUserId],
	)) as unknown;
	const job = normalizeJobRows(rows)[0] ?? null;
	if (job !== null) {
		// A QUEUED job has no runner to honor the flag — finalize it here.
		if (job.state === 'queued') {
			await finalizeQueuedJob(
				job.job_id,
				'cancelled',
				failedJobResult(new DedaloError('diffusion.cancelled'), 'Process cancelled by user'),
			);
		} else {
			await notifyProgress(job.job_id);
		}
		return { cancelled: true, job };
	}
	return { cancelled: false, job: null };
}

/** Runner-side check between batches. */
export async function isCancelRequested(jobId: string): Promise<boolean> {
	const rows = (await sql.unsafe(
		`SELECT cancel_requested FROM "${DIFFUSION_JOBS_TABLE}" WHERE job_id = $1`,
		[jobId],
	)) as { cancel_requested: boolean }[];
	return rows[0]?.cancel_requested ?? true;
}

export async function getJobById(jobId: string): Promise<DiffusionJobRow | null> {
	await ensureDiffusionJobTables();
	const rows = (await sql.unsafe(
		`SELECT ${JOB_COLUMNS} FROM "${DIFFUSION_JOBS_TABLE}" WHERE job_id = $1`,
		[jobId],
	)) as unknown;
	return normalizeJobRows(rows)[0] ?? null;
}

/**
 * One job by id, OWNER-SCOPED (DIFF-3): null unless `ownerUserId` enqueued it.
 * The follow stream of a `diffuse` reads its job through this — a stream is a
 * view of the caller's own run, never of whichever run holds the target. (The
 * runner, which owns no user, reads through the unscoped getJobById.)
 */
export async function getOwnedJobById(
	jobId: string,
	ownerUserId: number,
): Promise<DiffusionJobRow | null> {
	await ensureDiffusionJobTables();
	const rows = (await sql.unsafe(
		`SELECT ${JOB_COLUMNS} FROM "${DIFFUSION_JOBS_TABLE}" WHERE job_id = $1 AND owner_user_id = $2::int`,
		[jobId, ownerUserId],
	)) as unknown;
	return normalizeJobRows(rows)[0] ?? null;
}

/**
 * Newest job for a client label, owner-scoped (admin: ownerUserId null).
 * Client reconnect + get_process_status resolve through this.
 */
export async function getJobByClientProcessId(
	clientProcessId: string,
	ownerUserId: number | null,
): Promise<DiffusionJobRow | null> {
	await ensureDiffusionJobTables();
	const rows = (await sql.unsafe(
		`SELECT ${JOB_COLUMNS} FROM "${DIFFUSION_JOBS_TABLE}"
		 WHERE client_process_id = $1
		   AND ($2::int IS NULL OR owner_user_id = $2::int)
		 ORDER BY created_at DESC LIMIT 1`,
		[clientProcessId, ownerUserId],
	)) as unknown;
	return normalizeJobRows(rows)[0] ?? null;
}

/**
 * Jobs visible to a caller for list_processes — owner-scoped (admin: all),
 * bounded to the old store's 24h retention window so the payload matches the
 * old engine's auto-purged view (progress_store.ts MAX_AGE_MS).
 */
export async function listJobsForCaller(ownerUserId: number | null): Promise<DiffusionJobRow[]> {
	await ensureDiffusionJobTables();
	return normalizeJobRows(
		await sql.unsafe(
			`SELECT ${JOB_COLUMNS} FROM "${DIFFUSION_JOBS_TABLE}"
			 WHERE created_at > now() - interval '24 hours'
			   AND ($1::int IS NULL OR owner_user_id = $1::int)
			 ORDER BY created_at DESC
			 LIMIT 200`,
			[ownerUserId],
		),
	);
}

/** Count of currently claimed runs (scheduler concurrency limit input). */
export async function countRunningJobs(): Promise<number> {
	await ensureDiffusionJobTables();
	const rows = (await sql.unsafe(
		`SELECT count(*)::int AS n FROM "${DIFFUSION_JOBS_TABLE}" WHERE state = 'running'`,
	)) as { n: number }[];
	return rows[0]?.n ?? 0;
}

/** The run's two progress phases (see DiffusionJobRow.totals.phase). */
export type JobPhase = 'selection' | 'linked';

/**
 * One ACTIVE job as read for the admin queue stream. Deliberately NOT
 * DiffusionJobRow: the jsonb columns are projected to scalars in SQL and the
 * unbounded ones are not selected at all (see listActiveJobs).
 *
 * counter/total/msg arrive as TEXT on purpose. A `::int` cast in the query
 * would make ONE malformed legacy totals value abort the whole stream for
 * every admin; coercing per field in the projection degrades that to a single
 * job showing 0.
 */
export interface ActiveJobRow {
	job_id: string;
	client_process_id: string;
	state: DiffusionJobState;
	counter_text: string | null;
	total_text: string | null;
	phase_text: string | null;
	linked_counter_text: string | null;
	msg: string | null;
	cancel_requested: boolean;
	attempt: number;
	max_attempts: number;
	/** Window aggregates — exact over the whole active set, see below. */
	n_running: number;
	n_queued: number;
}

/**
 * The active job set for the admin queue stream (WC-067) — the ONLY statement
 * that stream's tick is allowed to run.
 *
 * (!) NOT listJobsForCaller(null). That reader is the 24h HISTORY view behind
 * list_processes and the maintenance widget's get_value: up to 200 rows of six
 * whole jsonb columns, including `spec` (which carries the entire sanitized
 * SQO) and `errors` (an unbounded string[] appended per failing field), every
 * one of them re-parsed by normalizeJobRow on every read. Polling THAT once a
 * second per connected admin re-reads a quarter of a megabyte of rows that
 * cannot change — 24h of completed history — to observe a counter that moves
 * once per batch. This reader returns only rows that can still change, and
 * projects them narrow.
 *
 * The counts are WINDOW aggregates, not a separate query: Postgres evaluates
 * window functions after WHERE but before ORDER BY/LIMIT, so they stay exact
 * over the whole active set even when LIMIT truncates the rows returned. That
 * makes the LIMIT an output cap, never a correctness cap.
 *
 * Served by the partial index <table>_state_idx (schema.ts) — which exists for
 * exactly this predicate and had no observer until now.
 */
export async function listActiveJobs(): Promise<ActiveJobRow[]> {
	await ensureDiffusionJobTables();
	return (await sql.unsafe(
		`SELECT job_id, client_process_id, state,
		        totals->>'counter' AS counter_text,
		        totals->>'total'   AS total_text,
		        totals->>'phase'   AS phase_text,
		        totals->>'linked_counter' AS linked_counter_text,
		        totals->>'msg'     AS msg,
		        cancel_requested, attempt, max_attempts,
		        (count(*) FILTER (WHERE state = 'running') OVER ())::int AS n_running,
		        (count(*) FILTER (WHERE state = 'queued')  OVER ())::int AS n_queued
		   FROM "${DIFFUSION_JOBS_TABLE}"
		  WHERE state IN ('queued','running')
		  ORDER BY created_at DESC
		  LIMIT 100`,
	)) as ActiveJobRow[];
}

/**
 * One of the caller's own ACTIVE jobs, projected for the activity tray.
 *
 * (!) NOT listJobsForCaller(userId). That reader is the 24h HISTORY view — up to
 * 200 rows of whole jsonb columns including `spec` (the entire sanitized SQO) and
 * an unbounded `errors` — and its own comment warns against putting it on a
 * repeating read. The tray asks "what of mine is running right now" on every page
 * load, which is exactly that mistake in a new caller. This reader answers only
 * that question, filtered by owner and projected to scalars in SQL.
 *
 * Served by the same partial `_state_idx` as listActiveJobs; the owner predicate
 * narrows an already-tiny set.
 */
export interface OwnedActiveJobRow {
	job_id: string;
	client_process_id: string;
	state: DiffusionJobState;
	section_tipo: string | null;
	diffusion_element_tipo: string | null;
	counter_text: string | null;
	total_text: string | null;
	msg: string | null;
	created_at: string;
	/** Null while live; the terminal instant once finished. */
	finished_at: string | null;
	/** The job's own error list, so a FAILED publication can say why. */
	errors: unknown;
}

export async function listActiveJobsForOwner(
	ownerUserId: number,
	recentTerminalMs: number,
): Promise<OwnedActiveJobRow[]> {
	await ensureDiffusionJobTables();
	return (await sql.unsafe(
		`SELECT job_id, client_process_id, state,
		        spec->>'section_tipo'            AS section_tipo,
		        spec->>'diffusion_element_tipo'  AS diffusion_element_tipo,
		        totals->>'counter' AS counter_text,
		        totals->>'total'   AS total_text,
		        totals->>'msg'     AS msg,
		        created_at, finished_at, errors
		   FROM "${DIFFUSION_JOBS_TABLE}"
		  WHERE owner_user_id = $1::int
		    AND (state IN ('queued','running')
		         OR finished_at > now() - ($2::int * interval '1 millisecond'))
		  ORDER BY created_at DESC
		  LIMIT 50`,
		[ownerUserId, recentTerminalMs],
	)) as OwnedActiveJobRow[];
}

/** Count of jobs waiting to be claimed (scheduler backlog — admin widget input). */
export async function countQueuedJobs(): Promise<number> {
	await ensureDiffusionJobTables();
	const rows = (await sql.unsafe(
		`SELECT count(*)::int AS n FROM "${DIFFUSION_JOBS_TABLE}" WHERE state = 'queued'`,
	)) as { n: number }[];
	return rows[0]?.n ?? 0;
}

/**
 * Attempts an admin requeue grants, counted FORWARD from the current epoch.
 * Mirrors the schema's `max_attempts` DEFAULT (schema.ts) — the same budget a
 * freshly enqueued job gets.
 */
const ADMIN_REQUEUE_ATTEMPT_BUDGET = 3;

/**
 * Manual admin requeue of a TERMINAL/interrupted job → queued with a FRESH
 * attempt budget. Mirrors the sweepStaleJobs requeue SQL but is user-driven and
 * clears the previous outcome (result/errors/finished_at). The state guard
 * (only failed|cancelled|interrupted) guarantees a live running/queued row is
 * never disturbed. Returns the updated row, or null when no eligible row matched.
 *
 * (!) It does NOT reset `attempt` (PUB-13). Rewinding the counter re-issues an
 * epoch: a runner that was merely SLOW under epoch 1 — the sweeper took its row,
 * the budget ran out, an admin revived it — would find its lease matching the
 * NEW claim's epoch 1 again and every fenced write would land on the live run
 * (measured ABA). The budget is granted by raising `max_attempts` instead, so
 * the epoch only ever moves forward and the loser stays locked out for the life
 * of the row.
 *
 * A requeue STARTS A NEW RUN, so it clears the same publication guard `diffuse`
 * does (R3 review MED-1): an element tool_diffusion's EXCLUDE_DIFFUSION_ELEMENTS
 * lists (or a malformed list) REFUSES — `diffusion.element_excluded` /
 * `tool.config_invalid` — before anything is written.
 */
export async function requeueTerminalJob(jobId: string): Promise<DiffusionJobRow | null> {
	await ensureDiffusionJobTables();
	const eligible = (await sql.unsafe(
		`SELECT spec->>'diffusion_element_tipo' AS element FROM "${DIFFUSION_JOBS_TABLE}"
		 WHERE job_id = $1 AND state IN ('failed','cancelled','interrupted')`,
		[jobId],
	)) as { element: string | null }[];
	const target = eligible[0];
	if (target === undefined) return null;
	// A spec naming NO element is MALFORMED, not unguarded (re-review LOW-3): no
	// door enqueues one, and the guard cannot clear what it cannot name — so it is
	// refused, never re-run on the strength of a missing key.
	if (typeof target.element !== 'string' || target.element === '') {
		throw new DedaloError('diffusion.not_requeueable', {
			message: `requeue: job ${jobId}'s spec names no diffusion element (malformed) — not re-run`,
			coordinates: { job_id: jobId },
		});
	}
	await assertPublishableElement(target.element);
	const rows = (await sql.unsafe(
		`UPDATE "${DIFFUSION_JOBS_TABLE}"
		 SET state = 'queued', runner = '{}'::jsonb, heartbeat_at = NULL,
		     cancel_requested = false, finished_at = NULL, result = NULL,
		     max_attempts = attempt + $2::int,
		     errors = '[]'::jsonb,
		     totals = totals || jsonb_build_object('msg', 'Requeued by admin')
		 WHERE job_id = $1 AND state IN ('failed','cancelled','interrupted')
		 RETURNING ${JOB_COLUMNS}`,
		[jobId, ADMIN_REQUEUE_ATTEMPT_BUDGET],
	)) as unknown;
	const job = normalizeJobRows(rows)[0] ?? null;
	if (job !== null) await notifyProgress(job.job_id);
	return job;
}

/**
 * Housekeeping: hard-delete terminal jobs (completed|failed|cancelled) finished
 * before the cutoff. Returns the number of rows removed.
 */
export async function purgeTerminalJobs(olderThanHours: number): Promise<{ purged: number }> {
	await ensureDiffusionJobTables();
	const rows = (await sql.unsafe(
		`WITH deleted AS (
			DELETE FROM "${DIFFUSION_JOBS_TABLE}"
			WHERE state IN ('completed','failed','cancelled')
			  AND finished_at IS NOT NULL
			  AND finished_at < now() - make_interval(hours => $1)
			RETURNING job_id
		 )
		 SELECT count(*)::int AS n FROM deleted`,
		[olderThanHours],
	)) as { n: number }[];
	return { purged: rows[0]?.n ?? 0 };
}

/**
 * Sweep crashed runs: running jobs whose heartbeat is older than
 * `staleAfterSeconds` re-queue (attempt budget permitting) or fail. Runs at
 * boot and on an interval (spec §4.2 crash recovery). Chunk determinism +
 * idempotent writes make the re-run safe.
 *
 * NEVER MID-BATCH (DIFF-2): the stale rows are taken `FOR UPDATE SKIP LOCKED`,
 * which conflicts with the `FOR KEY SHARE` a fenced batch holds on its job row
 * (jobs/target_fence.ts) — a runner writing its target right now is skipped,
 * whatever its heartbeat says, and revoked (if still stale) once its batch
 * committed. A runner only WAITING for a busy target holds nothing and stays
 * revocable: it re-reads its lease after the lock, before it writes.
 *
 * CRASH-ATOMIC (audit S3-63): both transitions happen in ONE statement — the
 * old two-step (mark 'interrupted', then requeue/fail per job) could crash
 * between the UPDATEs and strand a job in 'interrupted', a black-hole state
 * no automatic path revisited and purge never deleted. 'interrupted' remains
 * a manual-requeue-eligible state (requeueTerminalJob) but the sweeper no
 * longer parks jobs there.
 *
 * THE PUBLICATION GUARD (R3 review MED-1): a re-queue starts a NEW run, so a
 * lost run whose element tool_diffusion's EXCLUDE_DIFFUSION_ELEMENTS excludes
 * — or any lost run while that list is malformed — is FAILED in the same
 * statement with the guard's failure record (`refused`, `refusedCode`), never
 * re-queued. Gate: diffusion_excluded_elements_native F.
 */
export async function sweepStaleJobs(staleAfterSeconds: number): Promise<{
	requeued: string[];
	failed: string[];
	/** Lost runs NOT re-queued because their element may not start a new run (MED-1). */
	refused: string[];
	/** The code `refused` were failed with (diffusion.element_excluded | tool.config_invalid). */
	refusedCode: ErrorCode;
}> {
	await ensureDiffusionJobTables();
	// The failure RECORDs (`{ok:false, error:{code:'diffusion.runner_lost',…}}`,
	// and the publication guard's) are converter-made in TS and bound as jsonb
	// (`$N::text::jsonb` — the Bun.sql bind rule: a bare `::jsonb` on a string
	// param double-encodes it as a jsonb STRING scalar); only the attempt-count
	// `msg` line is composed in SQL (the count is known only inside the UPDATE).
	const runnerLost = JSON.stringify(toFailureRecord(new DedaloError('diffusion.runner_lost')));
	const block = await staleRunBlock();
	const swept = (await sql.unsafe(
		`WITH stale AS (
		     SELECT job_id,
		            ($3::boolean OR COALESCE((spec->>'diffusion_element_tipo') = ANY($4::text[]), false)) AS blocked
		       FROM "${DIFFUSION_JOBS_TABLE}"
		      WHERE state = 'running'
		        AND (heartbeat_at IS NULL OR heartbeat_at < now() - make_interval(secs => $1))
		      FOR UPDATE SKIP LOCKED)
		 UPDATE "${DIFFUSION_JOBS_TABLE}" AS jobs
		 SET state = CASE WHEN NOT stale.blocked AND jobs.attempt < jobs.max_attempts THEN 'queued' ELSE 'failed' END,
		     runner = CASE WHEN NOT stale.blocked AND jobs.attempt < jobs.max_attempts THEN '{}'::jsonb ELSE jobs.runner END,
		     heartbeat_at = NULL,
		     finished_at = CASE WHEN NOT stale.blocked AND jobs.attempt < jobs.max_attempts THEN jobs.finished_at ELSE now() END,
		     result = CASE
		         WHEN stale.blocked THEN $5::text::jsonb || jsonb_build_object('msg', $6::text)
		         WHEN jobs.attempt < jobs.max_attempts THEN jobs.result
		         ELSE $2::text::jsonb || jsonb_build_object(
		             'msg', 'Interrupted after ' || jobs.attempt || ' attempts (runner lost)') END,
		     totals = CASE
		         WHEN stale.blocked THEN jobs.totals || jsonb_build_object('msg', $6::text)
		         WHEN jobs.attempt < jobs.max_attempts THEN jobs.totals
		         ELSE jobs.totals || jsonb_build_object(
		             'msg', 'Interrupted after ' || jobs.attempt || ' attempts (runner lost)') END
		 -- UNFENCED BY DESIGN: this statement is the REVOKER. It does not check
		 -- runner.pid either — a runner on another host has no pid here, so pid
		 -- liveness could only ever cover the local deployment. The epoch fence is
		 -- the structural closure: whichever process lost the row cannot write to
		 -- it again, alive or not (PUB-13).
		 -- FOR UPDATE SKIP LOCKED (DIFF-2): a runner INSIDE a fenced batch holds
		 -- its row FOR KEY SHARE (jobs/target_fence.ts) — the sweeper skips it
		 -- rather than revoke a lease whose batch is writing the target now.
		 -- BLOCKED (R3 review MED-1): a re-queue starts a NEW run, so a lost run
		 -- whose element is excluded (or every lost run while the list is
		 -- malformed) is FAILED with the guard's own failure record instead.
		 -- 'blocked' is a DEFINITE boolean (re-review LOW-3): a spec with no element
		 -- makes 'NULL = ANY(...)' NULL, and a NULL in the CASEs above split the row
		 -- (state 'failed', result kept) — COALESCE reads it as not excluded.
		 FROM stale
		 WHERE jobs.job_id = stale.job_id AND jobs.state = 'running'
		 RETURNING jobs.job_id, jobs.state, stale.blocked`,
		[
			staleAfterSeconds,
			runnerLost,
			block.all,
			// A REAL array bind (re-review LOW-4): never a joined string the SQL
			// splits again — an entry is matched exactly as the door matches it.
			[...block.tipos],
			JSON.stringify(toFailureRecord(block.error)),
			block.msg,
		],
	)) as { job_id: string; state: string; blocked: boolean }[];
	const requeued: string[] = [];
	const failed: string[] = [];
	const refused: string[] = [];
	for (const job of swept) {
		if (job.blocked) refused.push(job.job_id);
		else (job.state === 'queued' ? requeued : failed).push(job.job_id);
		await notifyProgress(job.job_id);
	}
	return { requeued, failed, refused, refusedCode: block.error.code };
}

/**
 * Which lost runs the sweeper may NOT re-queue (R3 review MED-1): those of an
 * element tool_diffusion's EXCLUDE_DIFFUSION_ELEMENTS excludes (aliases of a
 * listed real element included) — or ALL of them while the list is malformed,
 * because then no element can be told publishable (the `diffuse` door refuses
 * every element the same way). Any other failure propagates: the sweep does not
 * run on a guess.
 */
async function staleRunBlock(): Promise<{
	all: boolean;
	tipos: readonly string[];
	error: DedaloError;
	msg: string;
}> {
	try {
		return {
			all: false,
			tipos: await excludedElementTipos(),
			error: new DedaloError('diffusion.element_excluded'),
			msg: 'Not re-run after the runner was lost: publication to this element is disabled (tool_diffusion EXCLUDE_DIFFUSION_ELEMENTS)',
		};
	} catch (error) {
		if (!isDedaloError(error) || error.code !== 'tool.config_invalid') throw error;
		return {
			all: true,
			tipos: [],
			error,
			msg: 'Not re-run after the runner was lost: the tool_diffusion EXCLUDE_DIFFUSION_ELEMENTS configuration is malformed',
		};
	}
}

/** Test helper: hard-delete rows created by a suite (never used in production). */
export async function deleteJobsForTests(jobIds: string[]): Promise<void> {
	if (jobIds.length === 0) return;
	// Bun.sql serializes JS arrays without the {} wrapper — build the
	// Postgres array literal explicitly (uuids are hex+dashes, no quoting needed).
	await sql.unsafe(`DELETE FROM "${DIFFUSION_JOBS_TABLE}" WHERE job_id = ANY($1::uuid[])`, [
		`{${jobIds.join(',')}}`,
	]);
}
