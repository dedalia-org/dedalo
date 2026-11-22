/**
 * Diffusion scheduler — the control plane's job dispatcher (DIFFUSION_SPEC §4.2).
 *
 * Claims queued jobs (bounded by DEDALO_DIFFUSION_MAX_RUNNERS, default 2) and
 * spawns one RUNNER PROCESS per claim: `bun run src/diffusion/runner.ts --job
 * <uuid> --epoch <attempt>` — same codebase, separate process, own memory
 * ceiling, killable. The epoch is the claim's LEASE (PUB-13): it fences every
 * write that process makes, so a runner whose row was requeued and re-claimed
 * under it cannot write to the row it lost.
 * The runner talks only to Postgres (and later the publication targets), so a
 * runner daemon on another machine claiming from the same queue needs no code
 * change — this local spawner is just the default deployment.
 *
 * Also hosts the SWEEPER cadence: at boot and on an interval, stale-heartbeat
 * running jobs are re-queued (attempt budget) or failed — the crash-recovery
 * path a durable queue exists for.
 */

import { hostname } from 'node:os';
import { readString } from '../../config/readers.ts';
import { DedaloError, logError, toErrorBody } from '../../core/errors/index.ts';
import {
	claimNextQueuedJob,
	countRunningJobs,
	failedJobResult,
	finishJob,
	type JobLease,
	purgeTerminalJobs,
	recordRunnerPid,
	sweepStaleJobs,
} from './queue.ts';

const MAX_RUNNERS = Math.max(1, Number(readString('DEDALO_DIFFUSION_MAX_RUNNERS')) || 2);

/**
 * Does THIS process claim from the queue at all (DEDALO_DIFFUSION_SCHEDULER_ENABLED)?
 *
 * Read HERE, not only at the boot cadence, because claiming has three entry
 * points: the 2 s cadence (server.ts), the enqueue kick (api/actions.ts) and the
 * widget's requeue kick (area_maintenance). Gating only the cadence left the two
 * kicks claiming the LIVE queue on an instance configured never to touch it —
 * exactly the "second instance sharing the database / smoke-test copy" case the
 * catalog entry promises is safe. The sweeper is deliberately NOT gated here;
 * server.ts skips that cadence separately, as the key's doc states.
 */
const DISPATCH_ENABLED = readString('DEDALO_DIFFUSION_SCHEDULER_ENABLED') !== 'false';

/** Whether this process is configured to claim jobs — read-only admin surface. */
export function isDispatchEnabled(): boolean {
	return DISPATCH_ENABLED;
}

/** The configured runner concurrency limit — read-only surface for the admin widget. */
export function getMaxRunners(): number {
	return MAX_RUNNERS;
}

/** Runner heartbeats every 5s; 3 missed beats + margin marks it stale. */
export const RUNNER_HEARTBEAT_MS = 5000;
export const STALE_AFTER_SECONDS = 20;

/**
 * Job-dispatch pause switch (admin flow control, in-memory). While paused the
 * scheduler claims NO new jobs — in-flight runners finish, queued jobs simply
 * wait. The SWEEPER is deliberately NOT gated by this (crash recovery must keep
 * healing lost runs). This is runtime-only state: a server restart resets it to
 * running, which is the safe default for a short operational hold.
 */
let paused = false;
export function pauseScheduler(): void {
	paused = true;
}
export function resumeScheduler(): void {
	paused = false;
	// Resuming ABORTS an in-flight drain: the waiter below re-reads this flag on
	// every poll, so an admin who changes their mind is never stuck behind a
	// runner that has minutes of work left.
	draining = false;
}
export function isSchedulerPaused(): boolean {
	return paused;
}

/**
 * QUIESCE: pause dispatch, wait for the runners already out there to finish,
 * then resume and kick. The honest analogue of the old PHP "restart" button —
 * there is no daemon to bounce, but "bring dispatch to a full stop, then start
 * it again" is a real operation an admin wants before a backup, a schema change
 * or a config edit.
 *
 * Bounded by construction: cancellation is COOPERATIVE (the runner checks
 * between batches) and a wedged runner would otherwise hold the drain open
 * forever, so the wait has a deadline. On timeout the scheduler stays PAUSED
 * and says so — resuming on top of runners that would not drain is exactly the
 * state the operator asked to avoid, so the decision goes back to them.
 */
export const DRAIN_TIMEOUT_MS = 5 * 60 * 1000;
const DRAIN_POLL_MS = 1000;

let draining = false;
export function isSchedulerDraining(): boolean {
	return draining;
}

export type DrainOutcome = {
	/** Every runner finished inside the deadline. */
	drained: boolean;
	/** Runners still going when the wait ended. */
	remaining: number;
	/** The deadline expired — the scheduler is left PAUSED. */
	timed_out: boolean;
	/** A drain was already running; this call did nothing. */
	already_draining: boolean;
};

export async function drainAndResume(timeoutMs = DRAIN_TIMEOUT_MS): Promise<DrainOutcome> {
	if (draining) {
		return {
			drained: false,
			remaining: await countRunningJobs(),
			timed_out: false,
			already_draining: true,
		};
	}
	paused = true;
	draining = true;
	const deadline = Date.now() + timeoutMs;
	try {
		while (true) {
			const remaining = await countRunningJobs();
			if (remaining === 0) {
				paused = false;
				draining = false;
				void schedulerTick(); // resume + immediate kick, no 2 s wait
				return { drained: true, remaining: 0, timed_out: false, already_draining: false };
			}
			// resumeScheduler() clears this — an operator abort, not a timeout.
			if (!draining) {
				return { drained: false, remaining, timed_out: false, already_draining: false };
			}
			if (Date.now() >= deadline) {
				draining = false; // stays PAUSED on purpose
				return { drained: false, remaining, timed_out: true, already_draining: false };
			}
			await Bun.sleep(DRAIN_POLL_MS);
		}
	} finally {
		draining = false;
	}
}

const SCHEDULER_TICK_MS = 2000;
const SWEEPER_TICK_MS = 30000;

const runnerModulePath = new URL('../runner.ts', import.meta.url).pathname;

let schedulerTimer: ReturnType<typeof setInterval> | null = null;
let sweeperTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Single-flight with a COALESCED re-run: one `pass` at a time, and a kick that
 * lands DURING a pass buys exactly one more pass after it (any number of such
 * kicks coalesce into that one). The tick's old latch DROPPED that kick, which
 * lost work: the running pass may already have read an empty queue before the
 * kicker's INSERT committed, so the new job waited for the 2 s interval — and
 * forever where no interval runs (a test process: diffusion_actions' crash leg,
 * "runner never registered a pid" under load). State lives in the closure.
 */
export function coalescingKick(pass: () => Promise<void>): () => Promise<void> {
	let running = false;
	let requested = false;
	return async () => {
		if (running) {
			requested = true;
			return;
		}
		running = true;
		try {
			do {
				requested = false;
				await pass();
			} while (requested);
		} finally {
			running = false;
		}
	};
}

/**
 * Spawn the runner process for a claimed job and record its pid.
 *
 * The claim's EPOCH travels on the argv (`--job <id> --epoch <attempt>`), never
 * re-read by the runner: the row it would re-read may already belong to a newer
 * attempt, which is the very race the lease exists to lose safely. Every write
 * this function and that process make is fenced on the pair (PUB-13,
 * engineering/wire_contract/WC-2026-09-05-diffusion-lease-epoch-fence.md).
 *
 * The interpreter is `process.execPath` — the SAME bun binary running this
 * server — not a bare `bun` off PATH. A deployment pins an absolute interpreter
 * in its unit file (deploy/dedalo-ts.service) while systemd's PATH may not
 * contain it at all; the bare name then throws here, the job stays CLAIMED, and
 * nothing frees it until the stale-heartbeat sweep. Same-binary is also the
 * correct semantic: the runner is this codebase, not whatever bun is first on
 * an operator's PATH.
 */
function spawnRunner(lease: JobLease): void {
	const jobId = lease.job_id;
	let child: Bun.Subprocess;
	try {
		child = Bun.spawn(
			[process.execPath, 'run', runnerModulePath, '--job', jobId, '--epoch', String(lease.attempt)],
			{
				cwd: new URL('../../../', import.meta.url).pathname,
				stdout: 'ignore',
				stderr: 'inherit',
				env: { ...process.env },
			},
		);
	} catch (error) {
		// The claim already happened, so NOBODY owns this row: no runner exists to
		// finish it and no heartbeat will ever go stale-then-heal for ~20 s of a
		// spent runner budget. Fail it here — the one place that knows the runner
		// never started. Failed (not requeued): a spawn error is a deployment
		// fault, and requeueing would hot-loop the whole queue against it.
		const typed = new DedaloError('diffusion.runner_spawn_failed', {
			cause: error,
			coordinates: { job: jobId },
		});
		logError(typed, { subsystem: 'diffusion scheduler' });
		finishJob(lease, 'failed', failedJobResult(typed, toErrorBody(typed).message)).catch(
			(failError) =>
				console.error('[diffusion scheduler] releasing the unspawned job failed:', failError),
		);
		return;
	}
	// The pid is informational (sweeper cross-check / cancel SIGTERM on this
	// host); liveness truth is the HEARTBEAT, which also covers remote runners.
	// Caught, not void'd: this runs OUTSIDE the tick's try/catch, and a floating
	// rejection kills the whole Bun process (S1-15).
	recordRunnerPid(lease, child.pid).catch((error) =>
		console.error('[diffusion scheduler] recordRunnerPid failed:', error),
	);
	// Reap on exit so a finished runner never lingers as a zombie. The exit
	// STATE is owned by the runner itself (finishJob) or the sweeper — not here.
	void child.exited;
}

/**
 * One scheduler pass: claim + spawn until the runner budget is spent or the
 * queue is empty. Exported for the enqueue path (immediate kick — no 2s wait)
 * and for tests.
 */
export async function schedulerTick(): Promise<void> {
	if (!DISPATCH_ENABLED) return;
	if (paused) return;
	await claimPass();
}

/** One claim pass, single-flight via coalescingKick — reached only through schedulerTick. */
const claimPass = coalescingKick(async () => {
	if (paused) return; // a coalesced re-run must not claim past a pause/drain
	try {
		// Budget INSIDE the claim (audit S3-64): the old read-count-then-claim
		// two-step let two scheduler instances both observe count<max and both
		// claim past the budget. claimNextQueuedJob returns null when the queue
		// is empty OR the running count has reached MAX_RUNNERS.
		while (true) {
			const claimed = await claimNextQueuedJob(hostname(), MAX_RUNNERS);
			if (claimed === null) break;
			spawnRunner({ job_id: claimed.job_id, attempt: claimed.attempt });
		}
	} catch (error) {
		console.error('[diffusion scheduler] tick failed:', error);
	}
});

/** Terminal jobs older than this are purged by the sweeper cadence (S3-46/62). */
const TERMINAL_PURGE_AFTER_HOURS = 7 * 24;
/** Purge at most once per day (the sweeper ticks every 30 s). */
const PURGE_INTERVAL_MS = 24 * 60 * 60 * 1000;
let lastPurgeAt = 0;

/** Boot + periodic sweep (crash recovery) + residue purge. Exported for tests. */
export async function sweeperTick(): Promise<void> {
	try {
		const { requeued, failed, refused, refusedCode } = await sweepStaleJobs(STALE_AFTER_SECONDS);
		if (requeued.length > 0 || failed.length > 0) {
			console.warn(`[diffusion sweeper] requeued=${requeued.length} failed=${failed.length}`);
		}
		// R3 review MED-1: lost runs the publication guard does not let start again,
		// failed (never re-queued) with the guard's own code — logged as that code.
		if (refused.length > 0) {
			logError(
				new DedaloError(refusedCode, {
					message: `[diffusion sweeper] ${refused.length} lost run(s) failed, not re-queued: ${refused.join(', ')}`,
					coordinates: { job_ids: refused.join(',') },
				}),
				{ subsystem: 'diffusion' },
			);
		}
	} catch (error) {
		console.error('[diffusion sweeper] sweep failed:', error);
	}
	// Residue GC (audit S3-46/62): terminal rows accumulated forever — the old
	// engine's 24 h progress store auto-purged; a week of history is plenty for
	// the admin widget, and the dd1758 ledger keeps the durable audit trail.
	if (Date.now() - lastPurgeAt >= PURGE_INTERVAL_MS) {
		lastPurgeAt = Date.now();
		try {
			const { purged } = await purgeTerminalJobs(TERMINAL_PURGE_AFTER_HOURS);
			if (purged > 0) console.log(`[diffusion sweeper] purged ${purged} terminal job row(s)`);
		} catch (error) {
			console.error('[diffusion sweeper] terminal purge failed:', error);
		}
	}
}

/**
 * Start the scheduler + sweeper cadences. Called once from startServer; safe
 * to call twice (idempotent). Boot order: sweep first (heal interrupted runs
 * from the previous process life), then schedule.
 */
export function startDiffusionScheduler(): void {
	if (schedulerTimer !== null) return;
	void sweeperTick().then(() => schedulerTick());
	schedulerTimer = setInterval(() => void schedulerTick(), SCHEDULER_TICK_MS);
	sweeperTimer = setInterval(() => void sweeperTick(), SWEEPER_TICK_MS);
}

/** Stop cadences (tests / graceful shutdown). Running runners keep running. */
export function stopDiffusionScheduler(): void {
	if (schedulerTimer !== null) clearInterval(schedulerTimer);
	if (sweeperTimer !== null) clearInterval(sweeperTimer);
	schedulerTimer = null;
	sweeperTimer = null;
}
