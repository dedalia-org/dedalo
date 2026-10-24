/**
 * Data-migration ENGINE (UPDATE_PROCESS Phase 3, OPS-6) — the TS twin of PHP
 * core/base/update/class.update.php::update_version(). Runs the matched
 * catalog descriptor's steps in execution order, appends the PHP log-line
 * bytes to update.log, and stamps the new matrix_updates version row.
 *
 * THE ATOMIC UNIT (OPS-6 — mirrors install/db/migrate.ts applyMigration). A run
 * is ONE transaction on the maintenance pool (db/postgres.ts
 * withMaintenanceTransaction): `SET LOCAL lock_timeout` + `SET LOCAL
 * statement_timeout = 0`, every checked step, and the version row — all land
 * together or not at all. So:
 *  - a failing statement, a hard-failing script, an ABORT (the job's stop /
 *    deadline / shutdown cancels the running statement) or a server RESTART
 *    mid-run is a ROLLBACK — no half-migrated install whose version claims it
 *    was never touched. The rerun after a restart IS the resume;
 *  - SINGLE-FLIGHT: an in-transaction advisory try-lock
 *    (UPDATE_ENGINE_LOCK_KEY) refuses a concurrent run, and an in-transaction
 *    re-read of the installed version refuses a run whose pre-read went stale
 *    (a second tab, a rerun after a commit) — `update.refused`, 409;
 *  - a step blocked on a lock waits at most `lockTimeout`, and the WHOLE unit
 *    is retried (1s/2s/4s/8s) — readers never queue behind a stalled DDL; each
 *    discarded attempt is written to update.log as ROLLED BACK;
 *  - THE VERDICT OF RECORD is the matrix_updates version row (it commits with
 *    the steps). update.log is ADVISORY, and never able to change a verdict:
 *    an attempt that won the single-flight claim opens with a BEGIN line, and
 *    every attempt's verdict line (COMMITTED — fsynced —, ROLLED BACK, REFUSED)
 *    carries its transaction id (`[xact <xid>]`), so a refused second tab's
 *    one line is never read as part of the running attempt's steps. A write
 *    that fails — a full or read-only private dir — is reported on the server
 *    log and the run goes on (appendUpdateLog). So an absent COMMITTED line
 *    only SUGGESTS "not committed" (a crash between the durable COMMIT and that
 *    line leaves the version row without it); read matrix_updates for the
 *    answer;
 *  - a statement CANCELLED from outside (a server shutdown cancelling the
 *    maintenance pool, an operator's pg_cancel_backend — the maintenance pool
 *    has no ceiling, so a 57014 there is never a timeout) is an INTERRUPTION,
 *    reported as such, never blamed on the step's SQL;
 *  - ONE VERDICT: a failure the engine did not raise itself (a lost
 *    connection, possibly DURING COMMIT) is classified by asking PostgreSQL
 *    what happened to THIS run's transaction (`pg_xact_status(<xid>)`) —
 *    committed, aborted, or (still in progress / unreadable) an unknown
 *    outcome, never a guessed rollback. The installed version is NOT the
 *    answer: another process's run may have stamped the same target, and a
 *    COMMIT still waiting on a synchronous standby reads as the old version.
 *    The status is read on a DEDICATED connection (postgres.ts
 *    readTransactionStatus), never a pooled one: the maintenance slot the run
 *    released goes straight to the next queued maintenance waiter;
 *  - a statement cannot END the unit: transaction control (`COMMIT`, `BEGIN`,
 *    `ROLLBACK`, …) is refused by the pool before it is sent. The checkpoint
 *    between steps still compares transaction ids (defense in depth), and a
 *    changed id is reported PARTIAL (PARTIALLY_COMMITTED_LINE) — what ran
 *    before it persisted — never as a rollback;
 *  - the run is unbounded by the request ceiling (the maintenance pool), and
 *    touches no pooled connection's GUC.
 *
 * PREFLIGHT, before any statement: the descriptor is validated
 * (catalog.ts validateUpdateDescriptor — `componentsUpdate`/`runPreScripts`
 * are `engine.uncovered_scope`, anything the atomic unit cannot honour is
 * `update.refused`), and the SELECTION RULE applies: the version stamp claims
 * every step it covers, so every `SQL_update_i` and every `stopOnError` script
 * MUST be checked (`update.refused` otherwise). A soft (`stopOnError: false`)
 * script may be left unchecked — its skip is the soft failure the descriptor
 * already tolerates — and is reported `Skipped script: <id> (not re-offered)`.
 *
 * Step semantics (PHP parity, made atomic):
 *  - SQL_update: raw statement; a failure rolls the run back.
 *  - run_scripts: SCRIPT_REGISTRY lookup, each under its own SAVEPOINT; a soft
 *    failure rolls back TO the savepoint (its own writes undone, the
 *    transaction stays usable — PHP's soft-continue without 25P02) and the run
 *    continues; a `stopOnError` failure rolls the run back.
 * Observer mirror reconciliation runs strictly AFTER COMMIT (never for a
 * rolled-back run), on its own unbounded scope, non-fatal.
 *
 * Divergences: the TS engine runs IN-PROCESS as a mediaJobs background job
 * (PHP spawns a detached CLI that survives a web-server restart — here a
 * restart rolls the run back and the operator reruns it). PHP's activity-log
 * disable has no TS twin to disable — the engine path writes no activity rows.
 */

import { appendFileSync, closeSync, fsyncSync, openSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { privateDir, readEnv } from '../../config/env.ts';
import { appendMatrixUpdateRow } from '../db/matrix_write.ts';
import {
	isInTransaction,
	isTransactionEndedMidUnit,
	MAINTENANCE_LOCK_TIMEOUT,
	type MaintenanceTransactionContext,
	outcomeOfFailedUnit,
	sql,
	sqlStateOf,
	withMaintenanceTransaction,
	withUnboundedStatements,
} from '../db/postgres.ts';
import { DedaloError, isDedaloError } from '../errors/index.ts';
import {
	type DataUpdateDescriptor,
	descriptorRefusal,
	getMatchedDescriptor,
	getUpdateVersion,
	UPDATE_CATALOG,
	type UpdateDescriptor,
	type UpdateScriptStep,
	validateUpdateDescriptor,
} from './catalog.ts';
import {
	COMMIT_ONLY_ACTIONS_DROPPED_LINE,
	SCRIPT_REGISTRY,
	type UpdateScriptFn,
} from './scripts.ts';

export { SCRIPT_REGISTRY, type UpdateScriptFn } from './scripts.ts';

/**
 * The single-flight advisory key (transaction-scoped). A sibling of
 * install/db/migrate.ts ONLINE_MIGRATION_LOCK_KEY (7_020_926_001): distinct, so
 * a data update and an online migration never block each other on the key.
 */
export const UPDATE_ENGINE_LOCK_KEY = 7_020_926_002;

/** The last msg line of every run that rolled back. */
export const ROLLED_BACK_LINE = 'Rolled back: no statement of this run persisted';

/**
 * The line of a run whose failure came AFTER its COMMIT reached the database
 * (a connection lost during COMMIT): PostgreSQL reports its transaction committed.
 */
export const COMMITTED_DESPITE_FAILURE_LINE =
	'The update was committed: the connection failed at the end of the run, and PostgreSQL reports its transaction committed';

/**
 * The last msg line of a run whose transaction a statement ENDED mid-run (the
 * checkpoint saw its id change — postgres.ts transactionEndedMidUnit): what ran
 * before it persisted, the version row was NOT stamped. Never the rollback line.
 */
export const PARTIALLY_COMMITTED_LINE =
	'Partially applied: a statement ended the update transaction mid-run — the steps before it persisted and the version was NOT stamped; inspect the data before rerunning (see update log)';

/** The last msg line of a run whose outcome could not be read back (see outcomeAfterFailure). */
export const OUTCOME_UNKNOWN_LINE =
	"Outcome unknown: the run failed and its transaction's outcome could not be read back — reload the panel to see whether the update was applied";

/** SQLSTATE lock_not_available — rethrown so the whole unit is retried. */
const LOCK_NOT_AVAILABLE = '55P03';
/** SQLSTATE query_canceled — on the maintenance pool, always a cancel from outside. */
const QUERY_CANCELED = '57014';

/** The msg line of a run whose statement was cancelled from outside (not by its own signal). */
export const INTERRUPTED_LINE =
	'Interrupted: a statement of the update was cancelled (a server shutdown or an operator cancel) — nothing is wrong with its SQL (see update log)';

/**
 * The migration run's INTERNAL outcome — never a wire body: the
 * update_data_version widget folds it into its own response (and the background
 * path publishes it as the job frame's `data`). `ok` (not `result`) so nothing
 * envelope-shaped can escape the engine.
 */
export interface UpdateRunResponse {
	ok: boolean;
	/** PHP: an ARRAY of step messages on success/abort paths. */
	msg: string[];
	errors: string[];
}

export interface UpdateEngineSeams {
	catalog?: Readonly<Record<string, UpdateDescriptor>>;
	scripts?: Readonly<Record<string, UpdateScriptFn>>;
	/** Injected installed version (tests); default reads matrix_updates. */
	currentVersion?: readonly number[];
	/**
	 * Injected installed-version read (tests); default readInstalledDataVersionStrict.
	 * Used INSIDE the run's transaction (the single-flight re-read).
	 */
	readVersionInTx?: () => Promise<readonly number[]>;
	/**
	 * Injected `pg_xact_status(<xid>)` read (tests); default a pooled query.
	 * Classifies a failure the engine did not raise itself (outcomeAfterFailure).
	 */
	readXactStatus?: (xid: string) => Promise<string | null>;
	/** Injected update.log path (tests); default UPDATE_LOG_FILE | <private>/update.log. */
	logPath?: string;
	/** Injected version-row writer (tests MUST inject — the real one mutates matrix_updates). */
	writeVersionRow?: (version: string) => Promise<void>;
	/** Injected mirror reconciler (tests inject a stub — the real one writes matrix rows). */
	reconcileMirrors?: (options: { apply: boolean; log: (line: string) => void }) => Promise<{
		repaired: number;
		shrinksSkipped: number;
		sublawRefused?: number;
		bigResultRefused?: number;
	}>;
	/** The run's `SET LOCAL lock_timeout` (default MAINTENANCE_LOCK_TIMEOUT — the maintenance pool's own bound). */
	lockTimeout?: string;
	/** Delays before each whole-unit retry on a lock timeout (default 1s/2s/4s/8s). */
	lockRetryDelaysMs?: readonly number[];
}

/** One run's accumulated lines (reset for each lock-retry attempt). */
interface RunLines {
	msg: string[];
	errors: string[];
}

/**
 * Private sentinel: a step failed and its lines are already in RunLines — the
 * throw only unwinds the transaction (rollback). Never escapes updateVersion.
 */
class UpdateRunRolledBack extends Error {}

/** PHP update_dedalo_data_version: INSERT the new version row (joins the run's transaction). */
async function writeVersionRowReal(version: string): Promise<void> {
	const now = new Date();
	const pad = (value: number) => String(value).padStart(2, '0');
	const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
	await appendMatrixUpdateRow({ dedalo_version: version, update_date: stamp });
}

function resolveLogPath(seams: UpdateEngineSeams): string {
	return (
		seams.logPath ??
		(readEnv('UPDATE_LOG_FILE') as string | undefined) ??
		join(privateDir, 'update.log')
	);
}

/**
 * Append to update.log — BEST EFFORT, never throws. The log is advisory (the
 * version row is the verdict of record): a write that fails (ENOSPC, EIO, a
 * read-only private dir) must not turn a COMMITTED run into a thrown error —
 * nor skip its mirror reconcile — and must not escape the failure paths that
 * classify a run. It goes to the server log instead. `durable` fsyncs the
 * line (the COMMITTED verdict line).
 */
function appendUpdateLog(logPath: string, text: string, durable = false): void {
	try {
		if (!durable) {
			appendFileSync(logPath, text);
			return;
		}
		const descriptor = openSync(logPath, 'a');
		try {
			writeSync(descriptor, text);
			fsyncSync(descriptor);
		} finally {
			closeSync(descriptor);
		}
	} catch (error) {
		console.error(
			`[update] update.log write failed (advisory — the matrix_updates version row holds the verdict): ${logPath}`,
			error,
		);
	}
}

/** PHP log-line bytes: PHP_EOL + date('c') + ' Updating [<step>] N )))…'. */
function logHeader(logPath: string, step: string, index: number, detail: string): void {
	const stamp = new Date().toISOString();
	appendUpdateLog(
		logPath,
		`\n${stamp} Updating [${step}] ${index + 1} )))))))))))))))))))))))))))))))))))))))\n${detail}`,
	);
}

function logLine(logPath: string, line: string, durable = false): void {
	appendUpdateLog(logPath, `\n${line}`, durable);
}

async function readCurrentVersion(seams: UpdateEngineSeams): Promise<readonly number[]> {
	if (seams.currentVersion !== undefined) return seams.currentVersion;
	const { getCurrentDataVersion } = await import('../area_maintenance/backup.ts');
	return getCurrentDataVersion();
}

async function readVersionInTransaction(seams: UpdateEngineSeams): Promise<readonly number[]> {
	if (seams.readVersionInTx !== undefined) return seams.readVersionInTx();
	const { readInstalledDataVersionStrict } = await import('../area_maintenance/backup.ts');
	return readInstalledDataVersionStrict();
}

/**
 * PREFLIGHT (before any statement): the descriptor validator, then the
 * selection rule. Throws the typed refusal; returns nothing on success.
 */
function preflight(
	descriptor: DataUpdateDescriptor,
	updatesChecked: Record<string, unknown>,
	scripts: Readonly<Record<string, UpdateScriptFn>>,
): void {
	const refusal = descriptorRefusal(
		validateUpdateDescriptor(
			`${descriptor.versionMajor}${descriptor.versionMedium}${descriptor.versionMinor}`,
			descriptor,
			Object.keys(scripts),
		),
	);
	if (refusal !== null) throw refusal;
	const unchecked = [
		...(descriptor.sqlUpdate ?? []).map((_, index) => `SQL_update_${index}`),
		...(descriptor.runScripts ?? []).flatMap((step, index) =>
			step.stopOnError ? [`run_scripts_${index}`] : [],
		),
	].filter((key) => updatesChecked[key] !== true);
	if (unchecked.length > 0) {
		throw new DedaloError('update.refused', {
			message: `update selection refused: unchecked required step(s) ${unchecked.join(', ')}`,
			publicMessage: `The version stamp claims every required step: check ${unchecked.join(', ')} too`,
			coordinates: { unchecked: unchecked.join(',') },
		});
	}
}

/** The single-flight guard, inside the run's transaction. */
async function claimRun(descriptor: DataUpdateDescriptor, seams: UpdateEngineSeams): Promise<void> {
	const [lock] = (await sql.unsafe('SELECT pg_try_advisory_xact_lock($1::bigint) AS locked', [
		UPDATE_ENGINE_LOCK_KEY,
	])) as { locked: boolean }[];
	if (lock?.locked !== true) {
		throw new DedaloError('update.refused', {
			message: 'update refused: another data update is running',
			publicMessage: 'Another data update is running',
		});
	}
	const installed = await readVersionInTransaction(seams);
	const from = [
		descriptor.updateFromMajor,
		descriptor.updateFromMedium,
		descriptor.updateFromMinor,
	];
	if (installed.join('.') !== from.join('.')) {
		throw new DedaloError('update.refused', {
			message: `update refused: the installed data version is ${installed.join('.') || 'unknown'}, not ${from.join('.')} — already applied`,
			publicMessage: 'This update was already applied (the installed data version changed)',
			coordinates: { installed: installed.join('.'), expected: from.join('.') },
		});
	}
}

/**
 * A failure that is not the step's own: a lock timeout (the whole unit is
 * retried), a cancel from outside, or the run's abort. Rethrown untouched,
 * never logged as a failed query.
 */
function isInterruption(error: unknown, context: MaintenanceTransactionContext): boolean {
	const state = sqlStateOf(error);
	return (
		state === LOCK_NOT_AVAILABLE || state === QUERY_CANCELED || context.signal?.aborted === true
	);
}

/** One SQL_update step. */
async function runSqlStep(
	statement: string,
	index: number,
	logPath: string,
	lines: RunLines,
	context: MaintenanceTransactionContext,
): Promise<void> {
	await context.checkpoint();
	logHeader(logPath, 'SQL_update', index, `query: ${statement}`);
	try {
		await sql.unsafe(statement, []);
	} catch (error) {
		if (isInterruption(error, context)) throw error;
		logLine(
			logPath,
			`ERROR [SQL_update] ${index + 1}\nThe result is false. Check your query sentence. The update process aborted.`,
		);
		lines.msg.push(`Error on SQL_update: ${(error as Error).message}`);
		throw new UpdateRunRolledBack();
	}
	logLine(logPath, 'result: true');
	lines.msg.push(`Updated SQL_update ${index + 1}`);
}

/** A script's outcome, internal to the engine (deliberately not envelope-shaped). */
interface ScriptOutcome {
	passed: boolean;
	detail: string;
	errors: string[];
}

/** The two return shapes a script may use, folded into one. */
function foldScriptResult(result: Awaited<ReturnType<UpdateScriptFn>>): ScriptOutcome {
	if (typeof result === 'boolean') return { passed: result, detail: '', errors: [] };
	return { passed: result.ok === true, detail: result.msg ?? '', errors: result.errors ?? [] };
}

/**
 * Invoke one script; a thrown error is a failed outcome carrying the script's
 * own message (PHP parity — the admin report shows it), except an interruption
 * (a lock timeout, a cancel, an abort), which rethrows so the whole unit is
 * retried / rolled back.
 */
async function invokeScript(
	fn: UpdateScriptFn,
	step: UpdateScriptStep,
	context: MaintenanceTransactionContext,
): Promise<ScriptOutcome> {
	try {
		return foldScriptResult(await fn({ signal: context.signal }, ...(step.scriptVars ?? [])));
	} catch (error) {
		if (isInterruption(error, context)) throw error;
		const stepMsg = (error as Error).message;
		return { passed: false, detail: stepMsg, errors: [] };
	}
}

/** One run_scripts step, under its own SAVEPOINT. */
async function runScriptStep(
	step: UpdateScriptStep,
	index: number,
	scripts: Readonly<Record<string, UpdateScriptFn>>,
	logPath: string,
	lines: RunLines,
	context: MaintenanceTransactionContext,
): Promise<void> {
	await context.checkpoint();
	logHeader(logPath, 'run_scripts', index, `current_script: ${step.scriptId}`);
	const savepoint = `update_step_${index}`;
	await sql.unsafe(`SAVEPOINT ${savepoint}`, []);
	// The preflight refused an unknown scriptId, so the lookup always resolves.
	const outcome = await invokeScript(scripts[step.scriptId] as UpdateScriptFn, step, context);
	lines.errors.push(...outcome.errors);
	logLine(logPath, `result: script executed: ${outcome.passed}`);
	if (outcome.passed) {
		await sql.unsafe(`RELEASE SAVEPOINT ${savepoint}`, []);
		lines.msg.push(`Updated script: ${step.scriptId}`);
		return;
	}
	await sql.unsafe(`ROLLBACK TO SAVEPOINT ${savepoint}`, []);
	lines.msg.push('Error updating Dédalo data', outcome.detail);
	lines.errors.push(outcome.detail);
	if (step.stopOnError) {
		lines.errors.push('unable to run update script');
		throw new UpdateRunRolledBack();
	}
}

/** Everything one step kind needs; built once per run. */
interface StepRun {
	descriptor: DataUpdateDescriptor;
	updatesChecked: Record<string, unknown>;
	scripts: Readonly<Record<string, UpdateScriptFn>>;
	logPath: string;
	lines: RunLines;
	context: MaintenanceTransactionContext;
}

/** SQL_update: every statement (the selection rule made them all checked). */
async function runSqlSteps(run: StepRun): Promise<void> {
	for (const [index, statement] of (run.descriptor.sqlUpdate ?? []).entries()) {
		await runSqlStep(statement, index, run.logPath, run.lines, run.context);
	}
}

/** run_scripts: the checked ones; an unchecked (necessarily soft) one is reported skipped. */
async function runScriptSteps(run: StepRun): Promise<void> {
	for (const [index, step] of (run.descriptor.runScripts ?? []).entries()) {
		if (run.updatesChecked[`run_scripts_${index}`] !== true) {
			run.lines.msg.push(`Skipped script: ${step.scriptId} (not re-offered)`);
			continue;
		}
		await runScriptStep(step, index, run.scripts, run.logPath, run.lines, run.context);
	}
}

/** Every step of the descriptor, in execution order, inside the transaction. */
async function runSteps(run: StepRun): Promise<void> {
	for (const stepName of run.descriptor.executionOrder ?? ['SQL_update', 'run_scripts']) {
		await (stepName === 'SQL_update' ? runSqlSteps(run) : runScriptSteps(run));
	}
}

/**
 * The reconcile msg line. A refused record is never reported clean: sub-law
 * refusals AND the >2000-reference freeze (computed, not written) must be
 * visible in the update message, not only in the log file (review 2026-08-02).
 */
function reconcileSummaryLine(summary: {
	repaired: number;
	shrinksSkipped: number;
	sublawRefused?: number;
	bigResultRefused?: number;
}): string {
	const sublaw =
		(summary.sublawRefused ?? 0) > 0
			? `, ${summary.sublawRefused} observer(s) REFUSED (unported sub-law)`
			: '';
	const frozen =
		(summary.bigResultRefused ?? 0) > 0
			? `, ${summary.bigResultRefused} record(s) at the >2000-reference freeze (not written)`
			: '';
	return `Observer mirrors reconciled: ${summary.repaired} repaired, ${summary.shrinksSkipped} shrink(s) held${sublaw}${frozen} (see update log)`;
}

/** The observer mirror heal, strictly after COMMIT (see the header). Returns its msg line. */
async function reconcileAfterCommit(seams: UpdateEngineSeams, logPath: string): Promise<string> {
	// Observer mirror reconciliation (2026-07-24): the data update writes
	// records WITHOUT the save chokepoint, so observer mirrors (the
	// hierarchy93 ← rsc387 family) arrive stale by construction — heal them.
	// Since 2026-08-06 this applies the FULL law, drops included. OPS-6: it runs
	// only once the migration has COMMITTED (a rolled-back run has nothing to
	// heal) and outside it (its own writes are not part of the atomic unit).
	// Best-effort — a reconcile failure must not fail the update.
	try {
		if (isInTransaction()) {
			throw new DedaloError('internal.invariant', {
				message: 'update engine: the mirror reconcile must run after COMMIT, never inside the run',
			});
		}
		const reconcileObserverMirrors =
			seams.reconcileMirrors ??
			(await import('../section/record/observer_reconcile.ts')).reconcileObserverMirrors;
		const summary = await withUnboundedStatements(() =>
			reconcileObserverMirrors({ apply: true, log: (line) => logLine(logPath, line) }),
		);
		return reconcileSummaryLine(summary);
	} catch (error) {
		const reason = (error as Error).message;
		logLine(logPath, `observer mirror reconcile FAILED (non-fatal): ${reason}`);
		return `Observer mirror reconcile skipped: ${reason}`;
	}
}

/** Why the run was aborted, for its first msg line. */
async function abortCause(signal: AbortSignal): Promise<string> {
	const { jobAbortInfo } = await import('../media/jobs.ts');
	return jobAbortInfo(signal)?.cause ?? 'aborted';
}

/**
 * What a failure the engine did NOT raise itself did to the install — the
 * shared classifier (postgres.ts outcomeOfFailedUnit): only the sentinel (a
 * step failed; COMMIT was never sent) and a typed refusal are KNOWN rollbacks;
 * anything else is read back from THIS attempt's transaction status, and an
 * unreadable status is UNKNOWN, never "rolled back" on a guess.
 */
function outcomeAfterFailure(
	seams: UpdateEngineSeams,
	xid: string | undefined,
): Promise<'committed' | 'rolled_back' | 'unknown'> {
	return outcomeOfFailedUnit(xid, { label: 'update', readStatus: seams.readXactStatus });
}

/** The attempt's log tag: ` [xact <xid>]`, or '' before its transaction id was read. */
function xactTag(attempt: RunAttempt): string {
	return attempt.xid === undefined ? '' : ` [xact ${attempt.xid}]`;
}

/** The CURRENT attempt of a run (a lock retry starts a new one). */
interface RunAttempt {
	xid: string | undefined;
}

/**
 * The rolled-back outcome, or a rethrow: a typed refusal (and any other
 * DedaloError) propagates unless the run was aborted; everything else — the
 * sentinel, a lock wait that outlived its retries, a lost connection whose
 * re-read shows the old version — is a rolled-back run reported in msg.
 */
async function rolledBack(
	error: unknown,
	lines: RunLines,
	logPath: string,
	signal: AbortSignal | undefined,
	tag: string,
): Promise<UpdateRunResponse> {
	const aborted = signal?.aborted === true;
	if (!aborted && isDedaloError(error)) {
		// Every attempt gets a closing line — a refused one included.
		logLine(
			logPath,
			error.code === 'update.refused'
				? `REFUSED${tag} (${error.message}) — nothing ran`
				: `ROLLED BACK${tag} (${error.code}) — no statement of this run persisted`,
		);
		throw error;
	}
	const msg = [...lines.msg];
	if (aborted) msg.unshift(`Update aborted (${await abortCause(signal as AbortSignal)})`);
	else if (!(error instanceof UpdateRunRolledBack)) msg.push(unexpectedFailureLine(error, logPath));
	msg.push(ROLLED_BACK_LINE);
	logLine(logPath, `ROLLED BACK${tag} — no statement of this run persisted`);
	return failedRun(msg, lines.errors);
}

/** The ONE failed-run outcome shape (internal — the widget folds it; never a wire body). */
function failedRun(msg: string[], errors: string[]): UpdateRunResponse {
	return { ok: false, msg, errors };
}

/**
 * A failure no step reported (a lock wait that outlived every retry, a lost
 * connection, a version-row write): the raw text goes to the update log and the
 * server log; the msg carries a deliberate sentence (SEC-18).
 */
function unexpectedFailureLine(error: unknown, logPath: string): string {
	const state = sqlStateOf(error);
	const verdict = state === QUERY_CANCELED ? 'INTERRUPTED' : 'ERROR';
	logLine(logPath, `${verdict} (run): ${String((error as Error)?.message ?? error)}`);
	console.error('[update] data update failed before COMMIT:', error);
	return (
		UNEXPECTED_FAILURE_LINES[state ?? ''] ??
		'Error: the update failed before COMMIT (see update log)'
	);
}

/** The msg line for a failure no step reported, by SQLSTATE (the default is above). */
const UNEXPECTED_FAILURE_LINES: Readonly<Record<string, string>> = {
	[LOCK_NOT_AVAILABLE]:
		'Error: a table lock stayed unavailable through every retry (see update log)',
	[QUERY_CANCELED]: INTERRUPTED_LINE,
};

/**
 * The main driver (PHP update::update_version). `updatesChecked` is the
 * client's checkbox map; `seams` are test injection points — production
 * callers pass none; `run.signal` is the job's abort signal (a stop, a
 * deadline, a shutdown cancels the running statement and rolls back).
 */
export async function updateVersion(
	updatesChecked: Record<string, unknown>,
	seams: UpdateEngineSeams = {},
	run: { signal?: AbortSignal } = {},
): Promise<UpdateRunResponse> {
	const catalog = seams.catalog ?? UPDATE_CATALOG;
	const scripts = seams.scripts ?? SCRIPT_REGISTRY;
	const current = await readCurrentVersion(seams);
	const descriptor = getMatchedDescriptor(current, catalog);
	if (descriptor === null) {
		return failedRun(['Unable to get proper update version. Nothing to update'], []);
	}
	preflight(descriptor, updatesChecked, scripts);
	const logPath = resolveLogPath(seams);
	const logUnavailable = ensureLogFile(logPath);
	if (logUnavailable !== null) return logUnavailable;

	const target = (getUpdateVersion(current, catalog) as number[]).join('.');
	const outcome = await runAtomically(target, {
		descriptor,
		updatesChecked,
		scripts,
		logPath,
		seams,
		signal: run.signal,
	});
	if (outcome.failed !== undefined) return outcome.failed;

	const reconcileLine = await reconcileAfterCommit(seams, logPath);
	return {
		ok: true,
		msg: [
			...outcome.lines.msg,
			reconcileLine,
			`Updated Dédalo data version: ${target}`,
			'Updated version successfully',
		],
		errors: outcome.lines.errors,
	};
}

/** PHP's log-file precondition: the failure response, or null when the log is usable. */
export function ensureLogFile(logPath: string): UpdateRunResponse | null {
	try {
		// ONE syscall (CodeQL #9566): append-mode open creates a missing log and
		// never truncates one another process created after a separate exists check.
		writeFileSync(logPath, '', { flag: 'a' });
		return null;
	} catch {
		return {
			ok: false,
			msg: ["Error (1). It's not possible set update_log file"],
			errors: ['update_log file is not available'],
		};
	}
}

/** The failed run whose outcome could not be read back: no rollback claimed. */
function unknownOutcome(
	error: unknown,
	lines: RunLines,
	logPath: string,
	tag: string,
): UpdateRunResponse {
	const msg = [...lines.msg, unexpectedFailureLine(error, logPath), OUTCOME_UNKNOWN_LINE];
	logLine(logPath, `OUTCOME UNKNOWN${tag} — the transaction's outcome could not be read back`);
	return failedRun(msg, lines.errors);
}

/**
 * The error was raised by the engine itself: a failed step (sentinel) or a typed
 * refusal — a KNOWN rollback. (The checkpoint's transaction-ended verdict is
 * typed too, but it is a partial commit: afterFailedRun routes it first.)
 */
function raisedByEngine(error: unknown, signal: AbortSignal | undefined): boolean {
	return error instanceof UpdateRunRolledBack || (isDedaloError(error) && signal?.aborted !== true);
}

/** The run whose transaction a statement ended mid-run: a PARTIAL line, never a rollback claim. */
function partiallyCommitted(
	error: DedaloError,
	lines: RunLines,
	logPath: string,
	tag: string,
): UpdateRunResponse {
	const { xid_before: before, xid_now: now } = error.coordinates ?? {};
	logLine(
		logPath,
		`PARTIAL${tag} — the transaction ended mid-run (xact ${before} → ${now}): the statements before it persisted; the version row is NOT stamped`,
		true,
	);
	console.error('[update] a statement ended the update transaction mid-run:', error);
	return failedRun([...lines.msg, PARTIALLY_COMMITTED_LINE], lines.errors);
}

/** A run that threw: committed-after-all, unknown, or rolled back (see runAtomically). */
async function afterFailedRun(
	error: unknown,
	lines: RunLines,
	target: string,
	run: {
		seams: UpdateEngineSeams;
		logPath: string;
		signal: AbortSignal | undefined;
		attempt: RunAttempt;
	},
): Promise<{ lines: RunLines; failed?: UpdateRunResponse }> {
	const tag = xactTag(run.attempt);
	if (isTransactionEndedMidUnit(error)) {
		return { lines, failed: partiallyCommitted(error, lines, run.logPath, tag) };
	}
	const outcome = raisedByEngine(error, run.signal)
		? 'rolled_back'
		: await outcomeAfterFailure(run.seams, run.attempt.xid);
	if (outcome === 'committed') {
		unexpectedFailureLine(error, run.logPath);
		logLine(
			run.logPath,
			`COMMITTED ${target}${tag} — PostgreSQL reports the transaction committed after the failure`,
			true,
		);
		lines.msg.push(COMMITTED_DESPITE_FAILURE_LINE);
		// The commit-only lane never ran (scripts.ts contract): say so, in the log and the msg.
		logLine(run.logPath, `COMMITTED${tag}: ${COMMIT_ONLY_ACTIONS_DROPPED_LINE}`, true);
		lines.msg.push(`The update: ${COMMIT_ONLY_ACTIONS_DROPPED_LINE}`);
		return { lines };
	}
	if (outcome === 'unknown') {
		return { lines, failed: unknownOutcome(error, lines, run.logPath, tag) };
	}
	return { lines, failed: await rolledBack(error, lines, run.logPath, run.signal, tag) };
}

/**
 * THE ATOMIC UNIT: claim → steps → version row, in one maintenance transaction
 * (retried whole on a lock timeout — each discarded attempt is written to
 * update.log). Returns the committed run's lines, or the failed response (a
 * typed refusal propagates). A failure the engine did not raise itself is
 * classified by the attempt's own transaction status (outcomeAfterFailure): a
 * run whose COMMIT landed is reported committed, an unreadable one unknown.
 * BEGIN is logged only once the single-flight claim is won, and every line the
 * attempt writes around its steps carries its xid.
 */
async function runAtomically(
	target: string,
	run: {
		descriptor: DataUpdateDescriptor;
		updatesChecked: Record<string, unknown>;
		scripts: Readonly<Record<string, UpdateScriptFn>>;
		logPath: string;
		seams: UpdateEngineSeams;
		signal: AbortSignal | undefined;
	},
): Promise<{ lines: RunLines; failed?: UpdateRunResponse }> {
	const writeVersionRow = run.seams.writeVersionRow ?? writeVersionRowReal;
	const from = [
		run.descriptor.updateFromMajor,
		run.descriptor.updateFromMedium,
		run.descriptor.updateFromMinor,
	].join('.');
	let lines: RunLines = { msg: [], errors: [] };
	const attempt: RunAttempt = { xid: undefined };
	try {
		await withMaintenanceTransaction(
			async (context) => {
				lines = { msg: [], errors: [] }; // a lock retry starts the unit over
				attempt.xid = context.xid;
				await claimRun(run.descriptor, run.seams);
				logLine(
					run.logPath,
					`BEGIN atomic run ${from} -> ${target}${xactTag(attempt)} (the matrix_updates version row is the verdict; a COMMITTED line follows a committed run)`,
				);
				await runSteps({ ...run, lines, context });
				await context.checkpoint();
				await writeVersionRow(target);
			},
			{
				lockTimeout: run.seams.lockTimeout ?? MAINTENANCE_LOCK_TIMEOUT,
				signal: run.signal,
				lockRetryDelaysMs: run.seams.lockRetryDelaysMs,
				onLockRetry: (number, delayMs) => {
					logLine(
						run.logPath,
						`ROLLED BACK attempt ${number}${xactTag(attempt)} (a lock wait timed out) — nothing of it persisted; retrying the whole update in ${delayMs}ms`,
					);
					attempt.xid = undefined; // the next attempt reads its own
				},
			},
		);
		logLine(run.logPath, `COMMITTED ${target}${xactTag(attempt)}`, true);
		return { lines };
	} catch (error) {
		return afterFailedRun(error, lines, target, { ...run, attempt });
	}
}
