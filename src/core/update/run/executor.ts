/**
 * THE UPDATE RUN EXECUTOR (update audit 2026-10-29, design §3.1-3.2; U-01,
 * U-02, U-03, U-10, U-13; owner decisions D-1, D-2, D-9).
 *
 * Drives one run through its journal: every step is written BEFORE and AFTER
 * it happens, so a process that dies anywhere — and a code phase dies by
 * design (the swap restarts into the new tree) — is resumed from the file by
 * the next boot, never guessed at.
 *
 *   startUpdateRun   refuse a second run, plan, take the UPDATE_RUN lock,
 *                    maintenance ON, preflight, backup, then drive.
 *   resumeUpdateRun  at boot: the run in flight (if any) — settle the phase
 *                    that was running when the process went away, then drive.
 *   drive            each remaining phase in plan order; a failure takes the
 *                    side exit rollback.ts decides; all done → verify →
 *                    VERIFIED → confirm → CONFIRMED, maintenance restored.
 *
 * A phase that was RUNNING when the process went away is idempotent (design
 * §3.2) and runs again — except the code phase, whose outcome is a fact of the
 * booted tree: the identity the run installs, or the previous one (the swap
 * did not land, or the supervisor already rolled it back).
 *
 * Maintenance mode is held from PREFLIGHT_OK until the run ends (U-13): a run
 * that ends in NEEDS_DB_RESTORE or MANUAL leaves it ON — a human decides. The
 * state the operator had before the run is journaled and restored, never
 * assumed off.
 *
 * Every effect is a seam (`RunEffects`); production wiring lives in
 * run/production.ts.
 */

import { DedaloError, isDedaloError } from '../../errors/dedalo_error.ts';
import type { ReleasePlan, ReleaseStep } from '../catalog_file.ts';
import {
	blockingRun,
	completedPhases,
	createRunJournal,
	failureSentence,
	finishPhase,
	type RunBackup,
	type RunJournal,
	startPhase,
	transition,
	unclosedRestore,
	writeRunJournal,
} from './journal.ts';
import type { UpdateRunLock } from './lock.ts';
import { planRun, type RunPlan } from './plan.ts';
import { canAutoRollback, dbRestoreReport, failureExit } from './rollback.ts';
import type { PredicateVerdict } from './verify.ts';

/** What one phase did. `restarting`: the process is about to exit into the new tree. */
export interface PhaseResult {
	outcome: 'ok' | 'failed' | 'skipped';
	evidence: Record<string, unknown>;
	restarting?: boolean;
}

export type PhaseRunner = (
	entry: { release: string; step: ReleaseStep },
	journal: RunJournal,
) => Promise<PhaseResult>;

/** The effects a run has on the install — production: run/production.ts. */
export interface RunEffects {
	/** The journals' directory. */
	root: string;
	lock: () => Promise<UpdateRunLock | null>;
	maintenance: { get: () => boolean; set: (on: boolean) => void };
	/** Null when the run may proceed, else the refusal sentence (nothing mutated yet). */
	preflight: (journal: RunJournal) => Promise<string | null>;
	/** Take the run's verified backup (or record the waiver). Throws on failure. */
	backup: (journal: RunJournal) => Promise<RunBackup>;
	runners: Readonly<Record<ReleaseStep['kind'], PhaseRunner>>;
	verify: (journal: RunJournal) => Promise<{ verified: boolean; verdicts: PredicateVerdict[] }>;
	/**
	 * Flip the code sentinel to confirmed (boot_confirm.ts) — the supervisor stands
	 * down. THROWS when the confirmation did not land: the run then stays VERIFIED
	 * (the next boot retries), never CONFIRMED over a pending sentinel.
	 */
	confirm: (journal: RunJournal) => Promise<void>;
	/** Put the previous code back (a restart follows); only ever after canAutoRollback allowed it. */
	rollbackCode: (journal: RunJournal) => Promise<void>;
	/** The release identity of the tree this process runs. */
	bootedRelease: () => string;
	/** The booted tree's install digest (install_stamp.ts), null when unstamped. */
	bootedDigest?: () => string | null;
	/** Called with every journal the run persists (production: /health's update_run facts). */
	report?: (journal: RunJournal) => void;
	/** NEEDS_DB_RESTORE: flip the code sentinel to needs_restore — no supervisor may roll back. */
	markNeedsRestore: (journal: RunJournal) => Promise<void>;
	/** The catalog plans (default: the shipped RELEASE_PLANS) — a gate plants its own. */
	plans?: Readonly<Record<string, ReleasePlan>>;
	/**
	 * True once the process is shutting down (server.ts shutdownGracefully). A phase
	 * that fails then is the shutdown closing its pool, not the release: it stays
	 * RUNNING in the journal and the next boot re-runs it.
	 */
	stopping?: () => boolean;
}

/** Where a drive left the run. */
export type DriveOutcome =
	| { state: 'restarting'; journal: RunJournal }
	| { state: 'ended'; journal: RunJournal };

function refused(rule: string, message: string): DedaloError {
	return new DedaloError('update.refused', {
		message: `update run refused (${rule}): ${message}`,
		publicMessage: message,
		coordinates: { rule },
	});
}

/** Persist and return — every state the run reaches is on disk before the next step. */
async function saved(effects: RunEffects, journal: RunJournal): Promise<RunJournal> {
	await writeRunJournal(effects.root, journal);
	effects.report?.(journal);
	return journal;
}

/** The run input: where the install stands and where it goes. */
export interface StartRunInput {
	installedRelease: string;
	installedData: readonly number[];
	target: string;
	/** The target's data version (default: derived from the catalog). */
	targetData?: readonly number[];
	/** The archive sha256 the target tree will carry (see RunEndpoint.digest). */
	targetDigest?: string;
}

/**
 * Does the booted tree run what the run installs? The digest when the run
 * recorded one (it alone tells a developer build from the tree it replaced),
 * else the release identity.
 */
export function runsTargetTree(
	journal: RunJournal,
	booted: { release: string; digest: string | null },
): boolean {
	const digest = journal.to.digest;
	return digest === undefined ? booted.release === journal.to.release : booted.digest === digest;
}

/** Refused while a run is non-terminal, a journal cannot be read, or a database restore is not closed. */
async function refuseWhileInFlight(root: string): Promise<void> {
	await refuseWhileRestorePending(root);
	const blocking = await blockingRun(root);
	if (blocking === null) return;
	throw refused(
		'run_in_flight',
		blocking.ok
			? `update run ${blocking.journal.run_id} is ${blocking.journal.state} — resume or end it first`
			: `the run journal ${blocking.file} cannot be read (${blocking.reason}) — a human must look at it first`,
	);
}

/** D-2: a NEEDS_DB_RESTORE run blocks until a human closes it (B4). */
async function refuseWhileRestorePending(root: string): Promise<void> {
	const pending = await unclosedRestore(root);
	if (pending === null) return;
	throw refused(
		'restore_pending',
		`update run ${pending.run_id} needs a database restore — restore it, then close the run with: bun run update abort <note>`,
	);
}

/**
 * Start a run: refused while another is in flight (or a journal is unreadable),
 * when the plan cannot be made, or when the lock is held. Then PLANNED →
 * PREFLIGHT_OK → BACKED_UP and the drive. The lock is held for the life of this
 * process's part of the run; a restart releases it with the session.
 */
export async function startUpdateRun(
	input: StartRunInput,
	effects: RunEffects,
): Promise<DriveOutcome> {
	const plan = planRun({
		...input,
		...(effects.plans === undefined ? {} : { plans: effects.plans }),
	});
	return startPlannedRun(withTargetDigest(plan, input.targetDigest), effects);
}

/** The plan with the archive digest the target tree will carry (RunEndpoint.digest). */
function withTargetDigest(plan: RunPlan, digest: string | undefined): RunPlan {
	return plan.ok && digest !== undefined ? { ...plan, to: { ...plan.to, digest } } : plan;
}

/**
 * Start a run from a plan already made (startUpdateRun's walk, or an
 * ontology-only plan — plan.ts ontologyOnlyPlan): refused while another run is
 * in flight, when the plan was refused, or when the lock is held.
 */
export async function startPlannedRun(plan: RunPlan, effects: RunEffects): Promise<DriveOutcome> {
	await refuseWhileInFlight(effects.root);
	if (!plan.ok) throw refused(plan.refusal, plan.detail);
	const lock = await effects.lock();
	if (lock === null)
		throw refused('run_locked', 'another update or destructive operation holds the update lock');
	try {
		// Re-checked UNDER the lock: a run that started while this one waited for it
		// releases the lock in its restart window, its journal still in flight
		// (review 2026-10-30 (5) #10).
		await refuseWhileInFlight(effects.root);
		return await preflightAndDrive(createRunJournal(plan), fenced(effects, lock));
	} finally {
		await lock.release();
	}
}

/**
 * The effects of a run that holds `lock`: every phase asks whether the lock is
 * still held, before it runs and after (#8; review 2026-10-30 (5) #7). A lost lock ends the phase as a SHUTDOWN does — left
 * running in the journal for the next boot to resume (leftRunning), never a
 * failure exit: nothing about the install failed, this process just may no
 * longer drive it.
 */
function fenced(effects: RunEffects, lock: UpdateRunLock): RunEffects {
	const held = lock.held;
	if (held === undefined) return effects;
	let lost = false;
	const lose = (summary: string): PhaseResult => {
		lost = true;
		return { outcome: 'failed', evidence: { summary } };
	};
	const guard =
		(runner: RunEffects['runners'][keyof RunEffects['runners']]): typeof runner =>
		async (entry, journal) => {
			if (!(await held())) return lose('the update lock was lost');
			const result = await runner(entry, journal);
			// …and again AFTER: a phase whose lock went while it ran is not settled
			// by this process — left running, the next boot reruns it (idempotent,
			// design §3.2). A code phase handing over to the restart is kept (#7).
			if (result.restarting !== true && !(await held())) {
				return lose('the update lock was lost while the phase ran');
			}
			return result;
		};
	const runners = Object.fromEntries(
		Object.entries(effects.runners).map(([kind, runner]) => [kind, guard(runner)]),
	) as RunEffects['runners'];
	return { ...effects, runners, stopping: () => lost || effects.stopping?.() === true };
}

/** PLANNED → (REFUSED | PREFLIGHT_OK → BACKED_UP → drive). */
async function preflightAndDrive(planned: RunJournal, effects: RunEffects): Promise<DriveOutcome> {
	let journal = await saved(effects, { ...planned, maintenance_before: effects.maintenance.get() });
	const refusal = await effects.preflight(journal);
	if (refusal !== null) {
		return {
			state: 'ended',
			journal: await saved(effects, transition(journal, 'REFUSED', refusal)),
		};
	}
	effects.maintenance.set(true);
	journal = await saved(effects, transition(journal, 'PREFLIGHT_OK'));
	try {
		const backup = await effects.backup(journal);
		journal = await saved(effects, transition({ ...journal, backup }, 'BACKED_UP'));
	} catch (error) {
		// A typed REFUSAL (no fresh, proven backup and no waiver — preconditions.ts
		// freshBackupRefusal) is REFUSED: nothing ran, and the operator's remedy is a
		// backup, not a retry. Anything else the step threw is a failure.
		const refused = isDedaloError(error) && error.code === 'update.refused';
		return endRun(
			effects,
			transition(
				journal,
				refused ? 'REFUSED' : 'FAILED_PRE_SWAP',
				failureSentence('the run backup failed', error),
			),
		);
	}
	return drive(journal, effects);
}

/** The plans a run's phases are judged by: a gate's planted ones, else the journal's own. */
function plansOf(journal: RunJournal, effects: RunEffects): Readonly<Record<string, ReleasePlan>> {
	return effects.plans ?? journal.release_plans;
}

/** Run every remaining phase, then verify and confirm. */
export async function drive(start: RunJournal, effects: RunEffects): Promise<DriveOutcome> {
	let journal = start;
	while (completedPhases(journal) < journal.plan.length) {
		const step = await stepOnce(journal, effects);
		if ('outcome' in step) return step.outcome;
		journal = step.journal;
	}
	return verifyAndConfirm(journal, effects);
}

/** One phase: start, guard, run, settle — the next journal, or how the drive ends. */
async function stepOnce(
	current: RunJournal,
	effects: RunEffects,
): Promise<{ journal: RunJournal } | { outcome: DriveOutcome }> {
	const journal = await saved(effects, startPhase(current));
	// The phase about to run crosses the data model (rollback.ts): from its first
	// statement no supervisor may put the previous code back — the sentinel says
	// so BEFORE the phase runs, and the rollback script never acts on it.
	if (!canAutoRollback(journal, plansOf(journal, effects)).allowed) {
		const unflipped = await flipFailure(effects, journal);
		if (unflipped !== null) return { outcome: await refuseCrossing(effects, journal, unflipped) };
	}
	const entry = journal.plan[completedPhases(journal)] as RunJournal['plan'][number];
	const result = await runPhase(effects, entry, journal);
	const handover = await leftRunning(effects, journal, entry, result);
	if (handover !== null) return { outcome: handover };
	const failed = result.outcome === 'failed';
	const settled = await saved(
		effects,
		finishPhase(journal, failed ? 'failed' : 'ok', result.evidence),
	);
	if (!failed) return { journal: settled };
	return { outcome: await failRun(effects, settled, failureNote(entry, result)) };
}

/** The needs-restore flip's error, or null when it landed. */
async function flipFailure(effects: RunEffects, journal: RunJournal): Promise<string | null> {
	try {
		await effects.markNeedsRestore(journal);
		return null;
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}

/**
 * The sentinel could not say needs_restore: the crossing phase does NOT run
 * (review 2026-10-30 (4) #4). It is journaled `skipped` — the model was not
 * crossed — and the run fails on its own terms (the previous code still fits).
 */
async function refuseCrossing(
	effects: RunEffects,
	journal: RunJournal,
	why: string,
): Promise<DriveOutcome> {
	const summary = `not run: the code sentinel could not be set to needs_restore (${why})`;
	const settled = await saved(effects, finishPhase(journal, 'skipped', { not_run: true, summary }));
	return failRun(effects, settled, summary);
}

/**
 * A phase this process does not close: it stays RUNNING for the next boot.
 * A phase that restarts the process (its outcome is a fact of the tree that
 * boots next — settleCodePhase), and a phase that failed WHILE the process
 * stops (the shutdown ended it, not the phase — review #10). Null otherwise.
 */
async function leftRunning(
	effects: RunEffects,
	journal: RunJournal,
	entry: RunJournal['plan'][number],
	result: PhaseResult,
): Promise<DriveOutcome | null> {
	const failed = result.outcome === 'failed';
	if (result.restarting === true && !failed) {
		const running = await saved(effects, withEvidence(journal, result.evidence));
		return { state: 'restarting', journal: running };
	}
	if (!failed || effects.stopping?.() !== true) return null;
	console.warn(
		`[update run] ${journal.run_id}: ${entry.release} ${entry.step.kind} ended by the shutdown — left running for the next boot`,
	);
	return { state: 'restarting', journal };
}

/**
 * The run's note for a failed phase: which, and WHY — the phase's own summary,
 * else the vetted sentence of the error it threw (runPhase `failure`). Without
 * the second, a gate's refusal ("Release checksum mismatch") reached the
 * operator as a bare "<release> code failed" (refuse.ts: never launder the
 * reason away).
 */
function failureNote(entry: RunJournal['plan'][number], result: PhaseResult): string {
	const reason = result.evidence.summary ?? result.evidence.failure;
	const said = typeof reason === 'string' ? `: ${reason}` : '';
	return `${entry.release} ${entry.step.kind} failed${said}`;
}

/** The running phase's evidence, recorded without closing it. */
function withEvidence(journal: RunJournal, evidence: Record<string, unknown>): RunJournal {
	const phases = journal.phases.map((phase) =>
		phase.outcome === 'running'
			? { ...phase, evidence: { ...phase.evidence, ...evidence } }
			: phase,
	);
	return { ...journal, phases };
}

/** A runner that throws is a failed phase, its error the evidence — never an escaped exception. */
async function runPhase(
	effects: RunEffects,
	entry: RunJournal['plan'][number],
	journal: RunJournal,
): Promise<PhaseResult> {
	try {
		return await effects.runners[entry.step.kind](entry, journal);
	} catch (error) {
		const where = `phase ${entry.release} ${entry.step.kind} threw`;
		// The typed CODE travels beside the sentence (a public registry code, never
		// the raw text): run/start.ts outcomeOrThrow keeps a pre-swap REFUSAL
		// `update.refused` instead of laundering it into `update.failed`.
		const code = isDedaloError(error) ? { code: error.code } : {};
		return { outcome: 'failed', evidence: { failure: failureSentence(where, error), ...code } };
	}
}

/**
 * All phases done: VERIFIED on evidence, then CONFIRMED; a red predicate is a
 * failure. A run resumed AT VERIFIED (the process died, or the confirm did not
 * land) goes straight to the confirm: its verdicts are on the journal.
 */
async function verifyAndConfirm(journal: RunJournal, effects: RunEffects): Promise<DriveOutcome> {
	if (journal.state === 'VERIFIED') return confirmRun(journal, effects);
	const result = await effects.verify(journal);
	const verdicts = { ...journal, verify: result.verdicts };
	if (!result.verified) {
		const red = result.verdicts
			.filter((verdict) => !verdict.ok)
			.map((verdict) => `${verdict.id}: ${verdict.detail}`);
		return failRun(effects, verdicts, `post-verify failed — ${red.join('; ')}`);
	}
	return confirmRun(await saved(effects, transition(verdicts, 'VERIFIED')), effects);
}

/** The confirm, then CONFIRMED; a confirm that did not land leaves the run VERIFIED, noted. */
async function confirmRun(verified: RunJournal, effects: RunEffects): Promise<DriveOutcome> {
	try {
		await effects.confirm(verified);
	} catch (error) {
		const note = failureSentence('the confirm did not land — the next boot retries it', error);
		return { state: 'ended', journal: await saved(effects, { ...verified, note }) };
	}
	return endRun(effects, transition(verified, 'CONFIRMED'));
}

/** The side exit for a failure (rollback.ts), journaled, then its effect. */
async function failRun(
	effects: RunEffects,
	journal: RunJournal,
	why: string,
): Promise<DriveOutcome> {
	const exit = failureExit(journal, plansOf(journal, effects));
	if (exit === 'NEEDS_DB_RESTORE') {
		const report = dbRestoreReport(journal, plansOf(journal, effects));
		const ended = await saved(effects, { ...transition(journal, exit, why), restore: report });
		await effects.markNeedsRestore(ended);
		return { state: 'ended', journal: ended };
	}
	const ended = transition(journal, exit, why);
	if (exit === 'ROLLED_BACK_CODE') {
		// The previous tree boots into a terminal run nothing resumes: maintenance
		// goes back to what the operator had BEFORE the rollback restart.
		effects.maintenance.set(journal.maintenance_before === true);
		await saved(effects, ended);
		await effects.rollbackCode(ended);
		return { state: 'restarting', journal: ended };
	}
	return endRun(effects, ended);
}

/** A run that ended on its own terms: maintenance back to what the operator had. */
async function endRun(effects: RunEffects, journal: RunJournal): Promise<DriveOutcome> {
	effects.maintenance.set(journal.maintenance_before === true);
	return { state: 'ended', journal: await saved(effects, journal) };
}

/**
 * At boot: resume the run in flight, or null when there is none. An unreadable
 * journal is reported and nothing runs (maintenance stays as it is: a human
 * looks). The lock is taken for this process's part of the run.
 */
export async function resumeUpdateRun(
	effects: RunEffects,
	/**
	 * Waits between lock attempts (boot.ts: bounded). A lock still held at boot is
	 * usually a DEAD session the database has not noticed yet (a power-cycled app
	 * host over TCP): give up at once and the run stays in flight, maintenance ON,
	 * until the next reboot (review 2026-10-30 #10). Default: one attempt.
	 */
	lockRetryMs: readonly number[] = [],
	sleep: (ms: number) => Promise<void> = Bun.sleep,
): Promise<DriveOutcome | null> {
	const blocking = await blockingRun(effects.root);
	if (blocking === null) return null;
	if (!blocking.ok) {
		console.error(
			`[update run] the run journal ${blocking.file} cannot be read (${blocking.reason}) — nothing resumed; a human must look at it`,
		);
		return null;
	}
	const lock = await lockWithRetry(effects, blocking.journal.run_id, lockRetryMs, sleep);
	if (lock === null) return null;
	try {
		// Re-read UNDER the lock: while this boot waited (up to the retry window)
		// the holder may have driven or aborted the run — never resume a snapshot
		// (review 2026-10-30 (4) #3).
		const current = await stillInFlight(effects.root, blocking.journal.run_id);
		return current === null ? null : await resumeFrom(current, fenced(effects, lock));
	} finally {
		await lock.release();
	}
}

/** The run `runId` as it stands now, or null when it ended (or another run blocks). */
async function stillInFlight(root: string, runId: string): Promise<RunJournal | null> {
	const current = await blockingRun(root);
	if (current === null || !current.ok) return null;
	return current.journal.run_id === runId ? current.journal : null;
}

/** The lock, tried once and then after each wait (no retry once the process stops); null = still held elsewhere. */
async function lockWithRetry(
	effects: RunEffects,
	runId: string,
	waits: readonly number[],
	sleep: (ms: number) => Promise<void>,
): Promise<UpdateRunLock | null> {
	for (const wait of [0, ...waits]) {
		if (wait > 0) {
			if (effects.stopping?.() === true) return null;
			await sleep(wait);
		}
		const lock = await effects.lock();
		if (lock !== null) return lock;
		console.error(
			`[update run] ${runId}: the update lock is held elsewhere — not resumed by this process${retrySuffix(wait, waits)}`,
		);
	}
	return null;
}

function retrySuffix(wait: number, waits: readonly number[]): string {
	return wait === 0 && waits.length > 0 ? ' yet (retrying)' : '';
}

/** Settle the phase that was running when the process went away, then drive. */
async function resumeFrom(journal: RunJournal, effects: RunEffects): Promise<DriveOutcome> {
	if (journal.state === 'PLANNED' || journal.state === 'PREFLIGHT_OK') {
		return endRun(
			effects,
			transition(
				journal,
				journal.state === 'PLANNED' ? 'REFUSED' : 'FAILED_PRE_SWAP',
				'the process went away before the backup — nothing changed; start again',
			),
		);
	}
	const running = journal.phases.find((phase) => phase.outcome === 'running');
	if (running === undefined) return drive(journal, effects);
	if (running.step.kind !== 'code') {
		const interrupted = await saved(
			effects,
			finishPhase(journal, 'failed', { interrupted: true, rerun: true }),
		);
		return drive(interrupted, effects);
	}
	return settleCodePhase(journal, effects);
}

/** The code phase's outcome is the booted tree: the run's target, or the previous release. */
async function settleCodePhase(journal: RunJournal, effects: RunEffects): Promise<DriveOutcome> {
	const booted = effects.bootedRelease();
	if (runsTargetTree(journal, { release: booted, digest: effects.bootedDigest?.() ?? null })) {
		return drive(await saved(effects, finishPhase(journal, 'ok', { booted })), effects);
	}
	const failed = await saved(
		effects,
		finishPhase(journal, 'failed', { booted, expected: journal.to.release }),
	);
	// The previous tree answers: the swap did not land, or the supervisor already put it back.
	return endRun(
		effects,
		transition(
			failed,
			'FAILED_PRE_SWAP',
			`the code swap did not land: booted ${booted}, expected ${journal.to.release}`,
		),
	);
}
