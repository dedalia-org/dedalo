/**
 * THE HOST EXECUTOR (terminal installer phase 4, 2026-10-12) — runs a HOST
 * route's plan (production: in the root process; docker/trial: as the
 * operator) through the SAME loop as the engine executor (step_loop.ts):
 * the same verify-skip / adopt / drift rules, the same intent/created
 * checkpoints, the same fault seam, the same events — and the same state
 * schema, in its OWN run dir (two processes never share one state file: root
 * never writes into a directory the instance user owns):
 *
 *   production   /var/lib/dedalo-install/<instance>/  (0700 root)
 *   docker/trial <checkout>/.dedalo-install/          (the operator's)
 *
 * The engine steps are ONE host step (host_engine / stack_engine) whose child
 * keeps its own record; the host step verifies it by asking the child.
 *
 * MODES: fresh (refuse an existing record; production refuses without root —
 * the sentence carries the `sudo sh install.sh …` form; the preflight's
 * refusals are evaluated BEFORE the record is written, so a refused host
 * keeps nothing of the attempt — campaign 3 C3-23); resume (the saved plan;
 * the frozen facts; a step whose commands no longer equal the ones the run
 * showed is REFUSED — critique A2); abort (reverse order, only what
 * `created` lists — and once the instance HAS SERVED (`created.served`:
 * MEASURED — the unit's start returned, or an issued start found to have
 * taken effect: campaign 3c D1), ONLY the host steps after the engine: a live install is never taken apart — critique B3.
 * Before that, the engine child's own --abort takes apart a completed engine
 * install too, attested unserved — and it refuses unless its database is
 * unchanged since it sealed: C3-11).
 *
 * CONFIG-FREE (the privilege gate): run_files_core, the loop, host/** and the
 * plan module — never config.ts, pg_exec or server_state.
 */

import { appendFileSync, existsSync, readdirSync, rmdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Subprocess } from 'bun';
import { isDedaloError } from '../../errors/dedalo_error.ts';
import { DEDALO_DATA_VERSION, formatVersion } from '../../update/version.ts';
import {
	type HostStepId,
	type InstallAnswers,
	normalizeInstallAnswers,
	type StepId,
} from '../install_plan.ts';
import type { ReviewMeasure } from '../review_measure.ts';
import type { RunIo, RunOutcomeView } from '../run_events.ts';
import {
	acquireRunLock,
	answerDifferences,
	ensureRunDir,
	type InstallPreflight,
	type InstallState,
	LOG_FILE,
	newInstallState,
	PLAN_FILE,
	type PlanFile,
	planHash,
	type RunMode,
	type RunRecord,
	readPlanFile,
	readStateFile,
	releaseRunLock,
	runRecord,
	type SecretKey,
	type Secrets,
	STATE_FILE,
	writePlanFile,
	writeStateFile,
} from '../run_files_core.ts';
import {
	ABORT_AND_START_AGAIN,
	ALREADY_COMPLETE_LINE,
	emit,
	interruptOnce,
	type LoopContext,
	nowIso,
	readInstallFault,
	recordFailure,
	recordOf,
	redact,
	redactConsole,
	runPlanSteps,
	runStarted,
	say,
	stopChildren,
	warnLine,
} from '../step_loop.ts';
import type { HostCtx, HostPlanCtx, HostStepDefinition } from './contract.ts';
import { type HostFacts, pendingFacts } from './facts.ts';
import { type HostFs, hostFs } from './fs.ts';
import { hostTable, stepDigest } from './host_table.ts';
import { INSTALL_STATE_ROOT, pathsFor, STACK_RUN_DIR } from './layout.ts';
import { OS_ROWS, osRowById, supportedOsList } from './os_support.ts';
import { instanceTakenSentence } from './production/identity_rules.ts';
import { ROOT_REQUIRED_SENTENCE } from './production/preflight.ts';
import { hostRefuse } from './refuse.ts';
import { type CommandRunner, scratchRunner, systemRunner } from './runner.ts';
import { readHostRootSeam } from './scratch.ts';
import { bunPinOf, sourceTreeRoot } from './source.ts';
import { emptyHostCreated, type HostCreated } from './state_types.ts';

export interface HostExecutorRequest {
	mode: RunMode;
	execute?: boolean;
	/** fresh: the plan file built from the validated plan. */
	planFile?: PlanFile;
	/** resume: the answers the command line gave, and which keys were given. */
	givenAnswers?: InstallAnswers;
	givenKeys?: readonly string[];
	secrets: Secrets;
	/** abort: must equal the plan's db_database to drop a created database. */
	confirmDatabase?: string;
}

export interface HostExecutorOutcome extends RunOutcomeView {
	/** The lines the operator must act on (firewall, modules, the outside check) — told, never done. */
	told: string[];
	/** An abort of a LIVE install: only the host steps after the engine were undone. */
	keptLive: boolean;
	/** The steps this abort actually undid, in order (the final sentence is built from it — C3-50). */
	undone: string[];
}

/** The machine's seams (a gate injects a recording runner and a scratch fs). */
export interface HostExecutorOptions {
	runner?: CommandRunner;
	fs?: HostFs;
	sleep?: (ms: number) => Promise<void>;
	now?: () => number;
	/** The source tree (default: the one this module belongs to). */
	source?: string;
	/** Skip the euid check (a gate's scratch run; the preflight's `id -u` still decides). */
	skipPrivilegeCheck?: boolean;
	/** The Review build's measurement scope (review_measure.ts) — hostPlanRefusals only. */
	measure?: ReviewMeasure;
}

/** One host run's context (never module state). */
interface HostRunContext extends LoopContext {
	readonly request: HostExecutorRequest;
	/** The run's install.log (campaign C4 S4: the output lived only in the TUI's `l` view). */
	readonly transcript: RunTranscript;
	readonly runner: CommandRunner;
	readonly fs: HostFs;
	readonly source: string;
	readonly sleep: (ms: number) => Promise<void>;
	readonly now: () => number;
	readonly measure: ReviewMeasure | undefined;
	readonly runDir: string;
	readonly table: { readonly [K in HostStepId]: HostStepDefinition };
	readonly told: string[];
	run: RunRecord | null;
	secrets: Secrets;
	runLock: boolean;
	keptLive: boolean;
	undone: string[];
	/**
	 * What the interrupted step said WHILE IT STOPPED (campaign 3f F2): the
	 * engine child's last lines — "ended the seed restore's database session"
	 * — arrive after the signal; they are kept here and printed INSIDE the ✖
	 * block, which both front ends show (a full screen drops its log pane).
	 */
	readonly stopping: string[];
	/** The runner's commands still in flight — an interruption lets them finish (bounded). */
	readonly inflight: Set<Promise<unknown>>;
}

// ── where the record lives ───────────────────────────────────────────────────

/** The host run dir of a plan's answers (a host path; the fs maps it under a scratch root). */
export function hostRunDirOf(
	answers: Partial<InstallAnswers>,
	source: string = sourceTreeRoot(),
): string {
	if (answers.route === 'production')
		return `${INSTALL_STATE_ROOT}/${String(answers.instance ?? '')}`;
	return join(source, STACK_RUN_DIR);
}

/**
 * The saved host record of these answers (route + instance), read where the
 * executor will read it (the scratch seam's root included), or null.
 */
export function readHostRecord(
	answers: Partial<InstallAnswers>,
	source: string = sourceTreeRoot(),
): { plan: PlanFile; state: InstallState | null } | null {
	const scratch = readHostRootSeam();
	const dir = hostFs(scratch?.root ?? '').real(hostRunDirOf(answers, source));
	const plan = readPlanFile(dir);
	return plan === null ? null : { plan, state: readStateFile(dir) };
}

/** The command a resume/abort is typed as (production: as root, through the bootstrap). */
export function hostCommandPrefix(answers: Partial<InstallAnswers>): string {
	return answers.route === 'production' ? 'sudo sh install.sh' : 'sh install.sh';
}

/** `--route <r> [--instance <i>]` — what names the record on a resume/abort line. */
function recordFlags(answers: Partial<InstallAnswers>): string {
	const instance = String(answers.instance ?? '');
	return `--route ${String(answers.route)}${instance === '' ? '' : ` --instance ${instance}`}`;
}

/**
 * The undo line of the hint — true to what --abort will do (C3-11): before the
 * instance served it removes what the install created, its database included;
 * after, it only partly undoes and keeps the instance.
 */
function undoHint(ctx: HostRunContext, prefix: string): string {
	if (instanceServed(ctx)) {
		return `  Or partly undo it:           ${prefix} --abort  (the instance has served: ${keptWhat(ctx)})`;
	}
	const db = String((ctx.plan as PlanFile).answers.db_database ?? '<db>');
	return `  Or undo this install:        ${prefix} --abort --confirm-database ${db}  (deletes the database this install created)`;
}

/** The hint after a failure. */
function hostHint(ctx: HostRunContext): string[] {
	const plan = ctx.plan;
	if (plan === null || ctx.state === null || ctx.request.mode === 'abort') return [];
	const prefix = `${hostCommandPrefix(plan.answers)} ${recordFlags(plan.answers)}`;
	return [
		`  Progress saved: ${join(ctx.runDir, STATE_FILE)} (plan: ${PLAN_FILE}, log: ${LOG_FILE})`,
		`  Fix the cause, then resume:  ${prefix} --resume`,
		undoHint(ctx, prefix),
		...stepHintLines(ctx, plan),
	];
}

/** What the plan's steps repeat in a failure block (the engine's salt read command — campaign 3e E3). */
function stepHintLines(ctx: HostRunContext, plan: PlanFile): string[] {
	const host = hostContext(ctx);
	return plan.steps.flatMap((step) => hostStep(ctx, step).hintLines?.(host) ?? []);
}

// ── the host context of a step ───────────────────────────────────────────────

/** The answers of the saved plan, normalized (the defaults the plan applied). */
function answersOf(plan: PlanFile): InstallAnswers {
	return normalizeInstallAnswers(plan.answers as Record<string, unknown>).answers;
}

/** The frozen facts (or the pending ones — only the preflight runs before they exist). */
function frozenFacts(state: InstallState | null): HostFacts {
	return state?.preflight.host?.facts ?? pendingFacts();
}

/**
 * The pure plan context: plan, answers, frozen facts, row, paths, source. The
 * paths' service group comes from the FROZEN account facts (critique B2):
 * the frozen digest, the run and every resume compute the same commands.
 */
function planContext(ctx: HostRunContext): HostPlanCtx {
	const plan = ctx.plan as PlanFile;
	const facts = frozenFacts(ctx.state);
	const answers = answersOf(plan);
	return {
		plan,
		answers,
		facts,
		// Before the facts exist only host_preflight runs, and it measures its own row.
		row: facts.os === null ? (OS_ROWS[0] as (typeof OS_ROWS)[number]) : osRowById(facts.os),
		paths: pathsFor(answers, bunPinOf(ctx.source), facts),
		source: ctx.source,
	};
}

function hostCreated(ctx: HostRunContext): HostCreated {
	const state = ctx.state as InstallState;
	state.created.host ??= emptyHostCreated();
	return state.created.host;
}

/** The context a host step runs with. */
/** The most lines a stopping step adds to the ✖ block (the last ones kept). */
const STOPPING_MAX = 20;

/** A step's line: said — or, once an interruption is under way, kept for the ✖ block (F2). */
function stepSays(
	ctx: HostRunContext,
	line: string,
	out: (ctx: HostRunContext, line: string) => void,
): void {
	if (ctx.interruption === null) {
		out(ctx, line);
		return;
	}
	ctx.stopping.push(redact(ctx, line));
	if (ctx.stopping.length > STOPPING_MAX) ctx.stopping.shift();
}

/** A runner whose in-flight commands an interruption can wait for (F2). */
function trackedRunner(inner: CommandRunner, inflight: Set<Promise<unknown>>): CommandRunner {
	return {
		run: (request) => {
			const running = inner.run(request);
			inflight.add(running);
			const done = () => inflight.delete(running);
			running.then(done, done);
			return running;
		},
	};
}

/**
 * Bound of the wait for the in-flight commands' last output on an interrupt:
 * runuser ends its child on a signal after 2 s (util-linux su-common); the
 * engine's own stop is bounded to 8 s.
 */
export const STOP_DRAIN_MS = 10_000;

/** Let the commands still in flight deliver their last lines (bounded; never throws). */
async function drainRuns(ctx: HostRunContext): Promise<void> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	await Promise.race([
		Promise.allSettled([...ctx.inflight]),
		new Promise((done) => {
			timer = setTimeout(done, STOP_DRAIN_MS);
		}),
	]);
	clearTimeout(timer);
}

function hostContext(ctx: HostRunContext): HostCtx {
	return {
		...planContext(ctx),
		state: ctx.state as InstallState,
		created: hostCreated(ctx),
		secrets: ctx.secrets,
		runner: ctx.runner,
		fs: ctx.fs,
		io: ctx.io,
		children: ctx.children,
		say: (line) => stepSays(ctx, line, say),
		warn: (line) => stepSays(ctx, line, warnLine),
		save: () => saveState(ctx),
		sleep: ctx.sleep,
		now: ctx.now,
		...(ctx.request.confirmDatabase === undefined
			? {}
			: { confirmDatabase: ctx.request.confirmDatabase }),
		...(ctx.measure === undefined ? {} : { measure: ctx.measure }),
	};
}

function hostStep(ctx: HostRunContext, step: StepId): HostStepDefinition {
	const definition = ctx.table[step as HostStepId];
	if (definition === undefined) {
		hostRefuse(
			'install.invalid_input',
			`${step} is not a host step — this plan belongs to the engine executor`,
		);
	}
	return definition;
}

/**
 * A resume must run the commands the run SHOWED (critique A2): a step's command
 * list is compared with the digest host_preflight froze.
 */
function assertSameCommands(
	ctx: HostRunContext,
	step: StepId,
	definition: HostStepDefinition,
): void {
	const frozen = ctx.state?.preflight.host?.commands_digest[step];
	if (frozen === undefined) return;
	if (stepDigest(definition, planContext(ctx)) !== frozen) {
		hostRefuse(
			'install.state_conflict',
			`the commands of ${step} are not the ones this install showed (the installer's own files changed since) — put the installer's files back (the same release), then --resume; ${ABORT_AND_START_AGAIN}`,
		);
	}
}

/** A host step's work (the loop's `perform`). */
async function performHostStep(ctx: HostRunContext, step: StepId) {
	const definition = hostStep(ctx, step);
	assertSameCommands(ctx, step, definition);
	const result = await definition.run(hostContext(ctx));
	if (!result.ok) hostRefuse('install.step_failed', result.detail);
	const told = result.told ?? [];
	// Kept with the step (checkpointed by its `done`): the closing To-do of a later run (N19).
	recordOf(ctx, step).told = told.map((line) => redact(ctx, line));
	tell(ctx, told);
	return { message: result.detail, warnings: result.warnings ?? [] };
}

/**
 * The closing To-do of a run that COMPLETES the install: every plan step's
 * told lines in plan order — a step done in an earlier run included (told
 * here now, it never was in this process) — each once (campaign 3b N19: a
 * run completed by --resume listed only the lines of the steps it ran).
 */
function tellEveryStep(ctx: HostRunContext): void {
	const steps = (ctx.state as InstallState).steps;
	const recorded = (ctx.plan as PlanFile).steps.flatMap((step) => steps[step]?.told ?? []);
	tell(
		ctx,
		[...new Set(recorded)].filter((line) => !ctx.told.includes(line)),
	);
	const ordered = [...new Set([...recorded, ...ctx.told])];
	ctx.told.splice(0, ctx.told.length, ...ordered);
}

/** Lines to tell: the front end's own channel when it has one, else the transcript. */
function tell(ctx: HostRunContext, lines: readonly string[]): void {
	if (lines.length === 0) return;
	ctx.told.push(...lines);
	if (ctx.io.tell !== undefined) ctx.io.tell(lines);
	else for (const line of lines) say(ctx, `  → ${line}`);
}

// ── the modes ────────────────────────────────────────────────────────────────

/** The engine-side preflight fields a host state carries (empty — the child records its own). */
function hostPreflight(): InstallPreflight {
	return {
		preexisting_extensions: [],
		env_backups_before: [],
		env_existed: false,
		env_sha256: null,
		env_had_salt: true,
		sample_env_existed: false,
		install_status_before: null,
		directories_missing: [],
	};
}

function saveState(ctx: HostRunContext): void {
	if (ctx.state !== null) writeStateFile(ctx.state, ctx.runDir);
}

/** The run dir exists at 0700 under 0755 parents (the challenge root's siblings stay readable). */
function prepareRunDir(ctx: HostRunContext): void {
	if (
		ctx.plan?.answers.route === 'production' ||
		ctx.request.planFile?.answers.route === 'production'
	) {
		ctx.fs.mkdir(INSTALL_STATE_ROOT, 0o755, 'root', 'root');
	}
	ensureRunDir(ctx.runDir);
}

function lockRunDir(ctx: HostRunContext): void {
	const lock = acquireRunLock(
		ctx.request.mode,
		{ note: (line) => say(ctx, `  ${line}`), warn: (line) => warnLine(ctx, `  ⚠ ${line}`) },
		ctx.runDir,
	);
	if (!lock.ok) {
		hostRefuse(
			'install.state_conflict',
			`another install is running (pid ${lock.holder.pid} on ${lock.holder.host}, since ${lock.holder.started_at})`,
		);
	}
	ctx.runLock = true;
}

/** Production needs root: refused before anything is written, with the command that has it. */
function assertPrivilege(plan: PlanFile, skip: boolean): void {
	// Under the scratch seam the recording runner's `id -u` (host_preflight) decides.
	if (skip || plan.answers.route !== 'production' || readHostRootSeam() !== null) return;
	if (process.platform !== 'linux') {
		hostRefuse(
			'install.invalid_input',
			`the production route installs on a Linux server (${supportedOsList()}); on this machine (${process.platform}) use the docker or trial route`,
		);
	}
	if (process.geteuid?.() !== 0) {
		hostRefuse(
			'install.invalid_input',
			'the production route installs packages, a user, units and a site: run it as root — sudo sh install.sh (the same arguments)',
		);
	}
}

function startRun(ctx: HostRunContext, mode: RunMode): void {
	ctx.run = runRecord(mode, ctx.request.execute === true);
	(ctx.state as InstallState).runs.push(ctx.run);
}

/** A fresh run never starts over an existing record. */
function assertNoRecord(ctx: HostRunContext): void {
	const state = readStateFile(ctx.runDir);
	if (state === null) return;
	const answers = (ctx.plan as PlanFile).answers;
	if (answers.route === 'production' && state.outcome === 'complete') {
		// A complete instance is never "resumed" or "undone" by a fresh run of its name (C3d-F1).
		hostRefuse(
			'install.state_conflict',
			instanceTakenSentence(String(answers.instance ?? ''), [join(ctx.runDir, STATE_FILE)]),
		);
	}
	hostRefuse(
		'install.state_conflict',
		`an install record exists at ${join(ctx.runDir, STATE_FILE)} — resume it (--resume) or undo it (--abort --confirm-database <db>)`,
	);
}

/** A new state for the plan, in memory (nothing created yet). */
function freshState(plan: PlanFile): InstallState {
	const state = newInstallState(plan, hostPreflight());
	state.created.host = emptyHostCreated();
	return state;
}

/**
 * The preflight's refusals, BEFORE anything is written (campaign 3 C3-23): an
 * unsupported system or an instance folder that already exists is a TERMINAL
 * refusal — no run dir, no record, no resume or abort to offer (there is
 * nothing to resume). The state the measurement runs with lives in memory only.
 */
async function refuseBeforeRecord(ctx: HostRunContext, plan: PlanFile): Promise<void> {
	const refusals = hostStep(ctx, plan.steps[0] as StepId).refusals;
	if (refusals === undefined) return;
	ctx.state = freshState(plan);
	let problems: string[];
	try {
		problems = await refusals(hostContext(ctx));
	} finally {
		ctx.state = null;
	}
	if (problems.length > 0) hostRefuse('install.state_conflict', problems.join('; '));
}

async function freshRun(ctx: HostRunContext, skipPrivilege: boolean): Promise<void> {
	const plan = ctx.request.planFile as PlanFile;
	assertPrivilege(plan, skipPrivilege);
	ctx.plan = plan;
	assertNoRecord(ctx);
	await refuseBeforeRecord(ctx, plan);
	prepareRunDir(ctx);
	lockRunDir(ctx);
	assertNoRecord(ctx);
	ctx.state = freshState(plan);
	startRun(ctx, 'fresh');
	writePlanFile(plan, ctx.runDir);
	saveState(ctx);
	await runPlanSteps(ctx);
}

/** Read and check the saved record. */
function loadRecord(ctx: HostRunContext): void {
	const plan = readPlanFile(ctx.runDir);
	const state = readStateFile(ctx.runDir);
	if (plan === null || state === null) {
		hostRefuse(
			'install.state_conflict',
			`no install record at ${ctx.runDir} — nothing to ${ctx.request.mode}`,
		);
	}
	if (planHash(plan) !== plan.plan_hash || state.plan_hash !== plan.plan_hash) {
		hostRefuse(
			'install.state_conflict',
			`the install record at ${ctx.runDir} was modified (plan hash mismatch)`,
		);
	}
	ctx.plan = plan;
	ctx.state = state;
}

async function resumeRun(ctx: HostRunContext): Promise<void> {
	lockRunDir(ctx);
	loadRecord(ctx);
	const plan = ctx.plan as PlanFile;
	if (plan.engine_version !== formatVersion(DEDALO_DATA_VERSION)) {
		hostRefuse(
			'install.state_conflict',
			`plan was written by engine ${plan.engine_version}; this is ${formatVersion(DEDALO_DATA_VERSION)}`,
		);
	}
	const given = ctx.request.givenAnswers;
	const differing =
		given === undefined ? [] : answerDifferences(plan.answers, given, ctx.request.givenKeys);
	if (differing.length > 0) {
		hostRefuse(
			'install.state_conflict',
			`answers differ from the saved plan: ${differing.join(', ')} — resume takes the saved answers`,
		);
	}
	startRun(ctx, 'resume');
	saveState(ctx);
	await runPlanSteps(ctx);
}

/**
 * Has the instance served (a LIVE install — never taken apart by a host
 * abort)? The flag (C3-11), never cleared: host_first_boot once `systemctl
 * start` returned, stack_up once `up -d dedalo` did (or measured: servedProbe). Read after `settleServed`.
 */
function instanceServed(ctx: HostRunContext): boolean {
	return hostCreated(ctx).served;
}

/** Did an issued start take effect — the steps' own measurement (unreadable: served)? */
async function measuredServed(ctx: HostRunContext): Promise<boolean> {
	for (const step of (ctx.plan as PlanFile).steps) {
		const probe = hostStep(ctx, step).servedProbe;
		if (probe === undefined) continue;
		if (await probe(hostContext(ctx)).catch(() => true)) return true;
	}
	return false;
}

/**
 * SERVED IS MEASURED (campaign 3c D1): a start ISSUED but not known to have
 * taken effect (a run killed while `systemctl start` ran) is decided on the
 * host — the unit ever ran, or the engine answered — before an abort chooses
 * what it undoes and before a hint says it. Measured served: recorded.
 */
async function settleServed(ctx: HostRunContext): Promise<void> {
	const created = hostCreated(ctx);
	if (created.served || created.start_issued !== true) return;
	if (!(await measuredServed(ctx))) return;
	created.served = true;
	saveState(ctx);
}

/** The steps an abort undoes: started ones with an undo, reverse order — after the engine only, when it is live. */
function undoableSteps(ctx: HostRunContext): { steps: StepId[]; live: boolean } {
	const plan = ctx.plan as PlanFile;
	const live = instanceServed(ctx);
	const engineAt = plan.steps.findIndex(
		(step) => step === 'host_engine' || step === 'stack_engine',
	);
	const steps = plan.steps
		.filter((_step, index) => !live || index > engineAt)
		.filter(
			(step) => recordOf(ctx, step).status !== 'pending' && hostStep(ctx, step).undo !== undefined,
		)
		.reverse();
	return { steps, live };
}

/** The engine and database steps whose undo resets or drops the database (or its volumes). */
const DATABASE_STEPS: ReadonlySet<StepId> = new Set([
	'host_engine',
	'host_database',
	'stack_engine',
	'stack_database',
]);

/**
 * Does this abort touch the database: the engine child's --abort (it resets
 * the database — `--db-mode existing` included), a role/database this install
 * created, or the stack volumes it created?
 */
function abortTouchesDatabase(ctx: HostRunContext, steps: readonly StepId[]): boolean {
	const created = (ctx.state as InstallState).created.host;
	return steps.some(
		(step) =>
			DATABASE_STEPS.has(step) &&
			(step.endsWith('_engine') ||
				created?.pg_database === true ||
				created?.pg_role === true ||
				(created?.stack?.volumes.length ?? 0) > 0),
	);
}

/**
 * The operator's confirmation, checked BEFORE anything is undone (never
 * supplied on the operator's behalf — the engine child gets the operator's own
 * value, so its gate decides too): a refused abort leaves the install whole,
 * never half taken apart.
 */
function assertConfirmed(ctx: HostRunContext, steps: readonly StepId[]): void {
	const db = String((ctx.plan as PlanFile).answers.db_database ?? '');
	if (!abortTouchesDatabase(ctx, steps) || ctx.request.confirmDatabase === db) return;
	hostRefuse(
		'install.invalid_input',
		`--abort resets and drops the database ${db} this install set up: confirm with --confirm-database ${db} — nothing was undone`,
	);
}

/**
 * The line an abort of a LIVE instance starts with — route by route (C3-52:
 * the production account's words never on docker/trial).
 */
function keptLiveLine(ctx: HostRunContext): string {
	return `  ⚠ the instance has served (it was started): an abort never takes a live instance apart — only the host steps after the engine are undone; ${keptWhat(ctx)}`;
}

/** What an abort of a live instance keeps, in the route's words. */
function keptWhat(ctx: HostRunContext): string {
	return (ctx.plan as PlanFile).answers.route === 'production'
		? 'its user, database and code are kept'
		: 'its containers, volumes (the database) and files are kept';
}

/** Undo one step and mark it pending again (a --resume puts it back). */
async function undoOne(ctx: HostRunContext, step: StepId): Promise<void> {
	ctx.currentStep = step;
	const undone = await (hostStep(ctx, step).undo as NonNullable<HostStepDefinition['undo']>)(
		hostContext(ctx),
	);
	recordOf(ctx, step).status = 'pending';
	ctx.undone.push(step);
	saveState(ctx);
	say(ctx, `  [${step}] ${undone}`);
	emit(ctx, step, 'undo', { message: undone });
}

async function abortRun(ctx: HostRunContext): Promise<void> {
	lockRunDir(ctx);
	loadRecord(ctx);
	await settleServed(ctx);
	const { steps, live } = undoableSteps(ctx);
	assertConfirmed(ctx, steps);
	ctx.keptLive = live;
	startRun(ctx, 'abort');
	saveState(ctx);
	if (live) warnLine(ctx, keptLiveLine(ctx));
	say(ctx, `→ undoing: ${steps.join(', ') || 'nothing'}`);
	for (const step of steps) await undoOne(ctx, step);
	ctx.currentStep = null;
	if (live) {
		// The instance stays; what was undone is pending again — a --resume puts it back.
		(ctx.state as InstallState).outcome = 'in_progress';
		// The abort RUN ended (campaign 3b N30: its record kept result/finished_at null).
		closeRun(ctx, 'aborted');
		return;
	}
	(ctx.state as InstallState).outcome = 'aborted';
	rmSync(join(ctx.runDir, PLAN_FILE), { force: true });
	rmSync(join(ctx.runDir, STATE_FILE), { force: true });
	// A completed --abort leaves no record: its transcript goes with it.
	ctx.transcript.close();
	rmSync(join(ctx.runDir, LOG_FILE), { force: true });
	ctx.state = null;
}

// ── the transcript ───────────────────────────────────────────────────────────

/** The run's install.log: what the screen said, appended, redacted again. */
export interface RunTranscript {
	tee(io: RunIo): RunIo;
	/** Lines the front end draws itself (the failure block): to the file only. */
	note(lines: readonly string[]): void;
	/** No more lines (a completed --abort removes the file). */
	close(): void;
}

/**
 * Every log and warning line of the run, appended to `file` (0600 on creation)
 * once `dir` exists — lines said before it was created (the preflight) are held
 * and written then. The salt never reaches it: the host routes show it only
 * through `showOnce`, which is not teed, and every line is redacted once more
 * against the run's secrets. Writing it never fails the run.
 */
export function runTranscript(
	file: string,
	dir: string,
	redactions: () => readonly string[],
): RunTranscript {
	let pending: string[] = [`--- install run ${new Date().toISOString()} ---`];
	let closed = false;
	const write = (line: string): void => {
		if (closed) return;
		const clean = redactions().reduce(
			(text, secret) => (secret === '' ? text : text.split(secret).join('[redacted]')),
			line,
		);
		pending.push(clean);
		if (!existsSync(dir)) return;
		try {
			appendFileSync(file, `${pending.join('\n')}\n`, { mode: 0o600 });
			pending = [];
		} catch {
			// The transcript is a convenience: a full disk or a read-only dir never stops the install.
		}
	};
	return {
		note: (lines) => {
			for (const line of lines) write(line);
		},
		tee: (io) => ({
			...io,
			log: (line) => {
				write(line);
				io.log(line);
			},
			warn: (line) => {
				write(line);
				io.warn(line);
			},
		}),
		close: () => {
			closed = true;
		},
	};
}

/** No transcript (a probe context). */
const NO_TRANSCRIPT: RunTranscript = { tee: (io) => io, note: () => {}, close: () => {} };

/**
 * The outcome, its failure block also written to install.log: the reporter
 * draws the ✖ line and the hint itself, so without this a failed run's log
 * ended at its last step line with no reason (adversarial review, C4 S4).
 */
function transcribedOutcome(
	ctx: HostRunContext,
	outcome: HostExecutorOutcome,
): HostExecutorOutcome {
	if (outcome.exitCode !== 0) {
		ctx.transcript.note([
			`✖ install ${outcome.result}${outcome.failedStep === null ? '' : ` at step [${outcome.failedStep}]`}: ${outcome.message ?? ''}`,
			...outcome.hint,
		]);
	}
	return outcome;
}

// ── the run ──────────────────────────────────────────────────────────────────

function closeRun(ctx: HostRunContext, result: NonNullable<RunRecord['result']>): void {
	if (ctx.run === null || ctx.state === null) return;
	ctx.run.result = result;
	ctx.run.finished_at = nowIso();
	saveState(ctx);
}

function releaseLock(ctx: HostRunContext): void {
	if (ctx.runLock) releaseRunLock(ctx.runDir);
	ctx.runLock = false;
	// A completed --abort leaves no record: its emptied run dir goes too.
	if (ctx.request.mode === 'abort' && ctx.state === null) removeEmptyDir(ctx.runDir);
}

/** Remove a directory only when it is empty (absent or not empty: kept). */
function removeEmptyDir(dir: string): void {
	try {
		if (readdirSync(dir).length === 0) rmdirSync(dir);
	} catch {
		// absent or not empty: kept
	}
}

function failedOutcome(ctx: HostRunContext, error: unknown): HostExecutorOutcome {
	const code = isDedaloError(error) ? error.code : 'install.step_failed';
	const message = error instanceof Error ? error.message : String(error);
	recordFailure(ctx, code, message);
	if (ctx.currentStep !== null) emit(ctx, ctx.currentStep, 'failed', { message });
	closeRun(ctx, 'failed');
	// REFUSED when this process never started its run (campaign 3b N24).
	const started = runStarted(ctx);
	return {
		exitCode: 1,
		result: started ? 'failed' : 'refused',
		message,
		failedStep: started ? ctx.currentStep : null,
		hint: hostHint(ctx),
		told: ctx.told,
		keptLive: false,
		undone: ctx.undone,
	};
}

/** settleServed for a hint (no record yet, or a probe that throws: the hint says what the flag says). */
async function settleServedQuietly(ctx: HostRunContext): Promise<void> {
	if (ctx.plan === null || ctx.state === null) return;
	try {
		await settleServed(ctx);
	} catch {
		// best effort: --abort measures again before it undoes anything
	}
}

/** The ✖ block's lines of what the step said while it stopped (F2) — none: nothing. */
export function stoppingLines(ctx: { stopping: readonly string[] }): string[] {
	if (ctx.stopping.length === 0) return [];
	return ['  While it stopped, the step said:', ...ctx.stopping.map((line) => `  ${line}`)];
}

/** The interrupted step's own stop (the engine child's container — C3-29); never throws. */
async function stopCurrentStep(ctx: HostRunContext): Promise<void> {
	if (ctx.currentStep === null || ctx.state === null) return;
	try {
		await hostStep(ctx, ctx.currentStep).onInterrupt?.(hostContext(ctx));
	} catch {
		// best effort: the hint below tells the operator how to resume
	}
}

async function interrupted(
	ctx: HostRunContext,
	signal: 'SIGINT' | 'SIGTERM',
	restore: () => void,
): Promise<never> {
	await stopChildren(ctx);
	await stopCurrentStep(ctx);
	await drainRuns(ctx);
	await settleServedQuietly(ctx);
	recordFailure(ctx, 'install.step_failed', 'interrupted');
	closeRun(ctx, 'interrupted');
	releaseLock(ctx);
	restore();
	if (ctx.currentStep !== null) emit(ctx, ctx.currentStep, 'interrupted', { message: signal });
	ctx.io.interrupted?.(signal);
	ctx.io.warn(
		`\n✖ install interrupted (${signal})${ctx.currentStep === null ? '' : ` at step [${ctx.currentStep}]`}`,
	);
	for (const line of stoppingLines(ctx)) ctx.io.warn(line);
	for (const line of hostHint(ctx)) ctx.io.warn(line);
	return process.exit(signal === 'SIGINT' ? 130 : 143);
}

/** The machine seams: injected, else the scratch seam, else the real host. */
function machine(
	options: HostExecutorOptions,
	children: Set<Subprocess>,
	redactions: () => string[],
) {
	if (options.runner !== undefined && options.fs !== undefined)
		return { runner: options.runner, fs: options.fs };
	const scratch = readHostRootSeam();
	if (scratch !== null) {
		return {
			runner: scratchRunner(scratch.markerDir),
			fs: hostFs(scratch.root, `${scratch.markerDir}/owners.json`),
		};
	}
	return { runner: systemRunner({ children, redactions }), fs: hostFs('') };
}

function newContext(
	request: HostExecutorRequest,
	io: RunIo,
	options: HostExecutorOptions,
	transcribed = false,
): HostRunContext {
	const source = options.source ?? sourceTreeRoot();
	const children = new Set<Subprocess>();
	const redactions = Object.values(request.secrets).filter(
		(value): value is string => typeof value === 'string',
	);
	const seams = machine(options, children, () => redactions);
	const inflight = new Set<Promise<unknown>>();
	const answers = request.planFile?.answers ?? request.givenAnswers ?? {};
	const runDir = seams.fs.real(hostRunDirOf(answers, source));
	// Only the real run writes install.log: a --plan, a Review's preflight or a
	// resume's secrets probe is no run (its probe lines would fake one).
	const transcript = transcribed
		? runTranscript(join(runDir, LOG_FILE), runDir, () => redactions)
		: NO_TRANSCRIPT;
	const ctx: HostRunContext = {
		io: transcript.tee(io),
		transcript,
		children,
		plan: null,
		state: null,
		fault: null,
		redactions,
		currentStep: null,
		ranAny: false,
		unredacted: false,
		interruption: null,
		request,
		runner: trackedRunner(seams.runner, inflight),
		stopping: [],
		inflight,
		fs: seams.fs,
		source,
		sleep: options.sleep ?? ((ms) => new Promise((done) => setTimeout(done, ms))),
		now: options.now ?? (() => Date.now()),
		measure: options.measure,
		runDir,
		table: hostTable(() => {
			const { facts: _facts, row: _row, paths: _paths, ...base } = planContext(ctx);
			return { ...base, bunPin: bunPinOf(ctx.source) };
		}),
		told: [],
		run: null,
		secrets: { ...request.secrets },
		runLock: false,
		keptLive: false,
		undone: [],
		stepOf: (step) => hostStep(ctx, step),
		verifyOwn: async (step) => {
			const verify = hostStep(ctx, step).verify;
			return verify === undefined ? null : verify(hostContext(ctx));
		},
		perform: (step) => performHostStep(ctx, step),
		intent: (step) => hostStep(ctx, step).intent?.(hostContext(ctx)),
		created: (step) => hostStep(ctx, step).created?.(hostContext(ctx)),
		save: () => saveState(ctx),
	};
	return ctx;
}

/**
 * Every plan step's end-of-install task (the engine steps: the salt shown once
 * — C3-18); the lines they answer join the closing To-do (campaign 3c D3).
 */
async function afterComplete(ctx: HostRunContext): Promise<void> {
	for (const step of (ctx.plan as PlanFile).steps) {
		const lines = await hostStep(ctx, step).afterComplete?.(hostContext(ctx));
		if (lines !== undefined) tell(ctx, lines);
	}
	saveState(ctx);
}

/** Does the record at `dir` say complete? */
function recordComplete(dir: string): boolean {
	return existsSync(join(dir, STATE_FILE)) && readStateFile(dir)?.outcome === 'complete';
}

/** The end of a run that completed the install: its closing tasks, the record, the result. */
async function completeRun(
	ctx: HostRunContext,
	wasComplete: boolean,
): Promise<'complete' | 'already_complete'> {
	ctx.currentStep = null;
	await afterComplete(ctx);
	tellEveryStep(ctx);
	(ctx.state as InstallState).outcome = 'complete';
	closeRun(ctx, 'complete');
	if (!wasComplete || ctx.ranAny) return 'complete';
	// The docs quote it (campaign 3b N7: only the engine said it).
	say(ctx, ALREADY_COMPLETE_LINE);
	return 'already_complete';
}

async function runMode(
	ctx: HostRunContext,
	options: HostExecutorOptions,
): Promise<HostExecutorOutcome> {
	ctx.fault = readInstallFault();
	if (ctx.request.mode === 'abort') {
		await abortRun(ctx);
		return {
			exitCode: 0,
			result: 'aborted',
			message: null,
			failedStep: null,
			hint: [],
			told: ctx.told,
			keptLive: ctx.keptLive,
			undone: ctx.undone,
		};
	}
	const wasComplete = ctx.request.mode === 'resume' && recordComplete(ctx.runDir);
	await (ctx.request.mode === 'fresh'
		? freshRun(ctx, options.skipPrivilegeCheck === true)
		: resumeRun(ctx));
	const result = await completeRun(ctx, wasComplete);
	return {
		exitCode: 0,
		result,
		message: null,
		failedStep: null,
		hint: [],
		told: ctx.told,
		keptLive: false,
		undone: [],
	};
}

/**
 * Run the host steps (fresh), finish them (resume) or undo them (abort). Never
 * throws for a refusal or a failed step; SIGINT/SIGTERM stop the children,
 * record the step failed and exit 130/143 from here.
 */
export async function executeHostInstall(
	request: HostExecutorRequest,
	io: RunIo,
	options: HostExecutorOptions = {},
): Promise<HostExecutorOutcome> {
	const ctx = newContext(request, io, options, true);
	const restore = redactConsole(ctx);
	const sigint = () => void interruptOnce(ctx, () => interrupted(ctx, 'SIGINT', restore));
	const sigterm = () => void interruptOnce(ctx, () => interrupted(ctx, 'SIGTERM', restore));
	process.on('SIGINT', sigint);
	process.on('SIGTERM', sigterm);
	io.signals?.(true);
	try {
		return transcribedOutcome(ctx, await runMode(ctx, options));
	} catch (error) {
		// The engine child (or any step's child) that died of the operator's Ctrl-C:
		// the run ends as that ONE interruption — exit 130, recorded interrupted (N12).
		if (ctx.interruption !== null) return await ctx.interruption;
		await settleServedQuietly(ctx);
		return transcribedOutcome(ctx, failedOutcome(ctx, error));
	} finally {
		process.off('SIGINT', sigint);
		process.off('SIGTERM', sigterm);
		io.signals?.(false);
		releaseLock(ctx);
		restore();
	}
}

/** The secrets one step consumes that the plan was given (the root password always). */
function stepNeeds(plan: PlanFile, definition: HostStepDefinition | undefined): SecretKey[] {
	return (definition?.needs ?? []).filter(
		(key) => key === 'root_password' || plan.secrets_supplied[key],
	);
}

/** The secrets a host run must be given: those of every not-done step that needs one. */
export function hostSecretsNeeded(plan: PlanFile, state: InstallState | null): SecretKey[] {
	// Only `needs` is read: the digest context is never asked for.
	const table = hostTable(() => hostRefuse('install.step_failed', 'no plan context here'));
	const pending = plan.steps.filter((step) => state?.steps[step]?.status !== 'done');
	return [...new Set(pending.flatMap((step) => stepNeeds(plan, table[step as HostStepId])))];
}

/** A run's io that says nothing (a read-only measurement before the run). */
const QUIET_IO: RunIo = { log: () => {}, warn: () => {} };

/**
 * The secrets a --resume must ASK for (campaign 3 C3-51): those of the
 * not-done steps — but for a not-done ENGINE step, only what its child still
 * needs, asked of the child itself (an orphaned child that went on to set the
 * root password needs it no more). A child that cannot answer: all of them.
 */
export async function hostResumeSecrets(
	given: InstallAnswers,
	options: HostExecutorOptions = {},
): Promise<SecretKey[]> {
	const ctx = newContext({ mode: 'resume', givenAnswers: given, secrets: {} }, QUIET_IO, options);
	loadRecord(ctx);
	const plan = ctx.plan as PlanFile;
	const pending = plan.steps.filter((step) => recordOf(ctx, step).status !== 'done');
	const asked: SecretKey[] = [];
	for (const step of pending) asked.push(...(await stepStillNeeds(ctx, step)));
	return [...new Set(asked)];
}

/** One not-done step's secrets: the child's own answer when the step can ask it, else its `needs`. */
async function stepStillNeeds(ctx: HostRunContext, step: StepId): Promise<SecretKey[]> {
	const definition = hostStep(ctx, step);
	const needs = stepNeeds(ctx.plan as PlanFile, definition);
	const still = await childStillNeeds(ctx, definition);
	return still === null ? needs : needs.filter((key) => still.includes(key));
}

/** The step's child's own answer (null: none, or it could not be asked — then all of them). */
async function childStillNeeds(
	ctx: HostRunContext,
	definition: HostStepDefinition,
): Promise<SecretKey[] | null> {
	try {
		return (await definition.secretsStillNeeded?.(hostContext(ctx))) ?? null;
	} catch {
		return null;
	}
}

/**
 * The preflight's refusals for `--plan` (campaign 3 C3-25): the same
 * read-only measurement a fresh run makes before it writes its record — the
 * OS, the service account and folder, the names, the certificate. Run as a
 * normal user, the root refusal is left out and said as a warning instead.
 */
export async function hostPlanRefusals(
	planFile: PlanFile,
	options: HostExecutorOptions = {},
): Promise<{ errors: string[]; warnings: string[] }> {
	const ctx = newContext({ mode: 'fresh', planFile, secrets: {} }, QUIET_IO, options);
	ctx.plan = planFile;
	const refusals = hostStep(ctx, planFile.steps[0] as StepId).refusals;
	if (refusals === undefined) return { errors: [], warnings: [] };
	ctx.state = freshState(planFile);
	const problems = await refusals(hostContext(ctx));
	const asUser = problems.includes(ROOT_REQUIRED_SENTENCE);
	return {
		errors: problems.filter((problem) => problem !== ROOT_REQUIRED_SENTENCE),
		warnings: asUser
			? [
					'measured as a normal user: what only root can read was not checked — run --plan with sudo for the whole system check',
				]
			: [],
	};
}
