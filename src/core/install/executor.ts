/**
 * THE TERMINAL INSTALLER'S EXECUTOR (phase 1, 2026-10-11) — runs a validated
 * install plan as a RESUMABLE sequence: the plan file is written once, the state
 * file is checkpointed around every step, and a run that dies anywhere is
 * finished by `scripts/install.ts --resume` (or undone by `--abort
 * --confirm-database <db>`).
 *
 * THREE MODES.
 *  - fresh: refuse on an existing install record; prove the target database
 *    EMPTY (zero user objects — db_restore.ts inspectTargetDatabase) and
 *    STAMPABLE (the install role owns it) under the server-side install lock;
 *    record the preflight; write the plan + state; run every step.
 *  - resume: same plan (hash, engine version, answers); re-ask only the secrets
 *    a NOT-done step still consumes; then the step loop below.
 *  - abort: undo, in reverse plan order, only what the state says the install
 *    CREATED. Never a sealed install; never without `--confirm-database` once
 *    the seed started; never a database that does not carry THIS install's
 *    stamp (db_restore.ts header) unless it is empty; never DROP DATABASE.
 *    Always under the server-side install lock when the database is reachable.
 *
 * THE STEP LOOP (resume safety rests on it). For each plan step:
 *  - recorded `done`: a step with a verify must still verify (else DRIFT — the
 *    install was changed outside the installer — refused); one without a verify
 *    (a probe, an idempotent upsert) is skipped;
 *  - recorded `running`/`failed` (a crash or a refusal): a verify that passes
 *    means the work landed before the checkpoint — marked done, skipped
 *    (except a `neverAdopt` step — the seed — which is always re-run);
 *    otherwise the step runs again. No undo is ever needed to resume: the seed
 *    restore is ONE transaction (rolled back by a kill) that stamps the
 *    database with the install id, the seed step re-decides from that stamp on
 *    every run (completes its own seed, restores only into an EMPTY database),
 *    and every other step converges when re-run;
 *  - pending: run, accept, verify, checkpoint.
 *
 * THE LOOP ITSELF lives in step_loop.ts (phase 4, 2026-10-12): the host
 * executor (host/host_executor.ts) drives the same one. This module is the
 * ENGINE wrapper — the engine step table, the database claim, the engine's
 * intents and creations; it refuses a plan that holds a host step (a host
 * route's plan runs in the host executor; its engine steps reach this module
 * through the delegated `--engine-only` child).
 *
 * NOTHING SECRET IS WRITTEN OR PRINTED: run files are built from plain answers
 * (run_files.ts), every message is redacted, and console output is redacted
 * for the run's duration (engine modules print directly). The one exception is
 * the generated DEDALO_SALT_STRING, shown ONCE in the final summary (through
 * ExecutorIo.showOnce when the front end has a terminal for it).
 *
 * A step's `details` (steps.ts — one row per directory, one per tool) are
 * printed after its run, through the same redacted `say`.
 *
 * Imported only AFTER the CLI has seeded the environment config.ts freezes
 * (scripts/install.ts). The step table and the machine-facing host are
 * injectable: test/unit/install_executor_native.test.ts drives a fake table in
 * a temp private dir. Gates: that one, install_resume_drill,
 * install_run_files_secret_tripwire.
 */

import { existsSync, readdirSync, rmdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { processEnvValue } from '../../config/env.ts';
import { isDedaloError } from '../errors/index.ts';
import { DirectoryBarrier, removeFileDurably } from '../files/durable.ts';
import { divertRetiredPropertyNotices } from '../ontology/retired_property_notice.ts';
import { getServerState } from '../resolve/server_state.ts';
import { DEDALO_DATA_VERSION, formatVersion } from '../update/version.ts';
import type { InstallLockHandle, TargetDatabaseState } from './db_restore.ts';
import type { DevCertificatePlan } from './dev_certificate.ts';
import type { DevListenerPlan } from './dev_listener.ts';
import {
	type InstallAnswers,
	type InstallPlan,
	type InstallStepId,
	isInstallStepId,
	type StepId,
} from './install_plan.ts';
import type { OntologyCatalog } from './ontology_choice.ts';
import { devTlsDir, installPrivateDir } from './paths.ts';
import { trackPsqlChildren } from './pg_exec.ts';
import { refuseInstall } from './refuse.ts';
import type { RunIo } from './run_events.ts';
import {
	acquireRunLock,
	answerDifferences,
	buildPlanFile,
	canonicalJson,
	ensureRunDir,
	envBackups,
	type InstallPreflight,
	type InstallState,
	installEnvPath,
	installRunDir,
	newInstallState,
	ontologyDecisions,
	PLAN_FILE,
	type PlanFile,
	planHash,
	type RunMode,
	type RunRecord,
	readInstallEnv,
	readPlanFile,
	readStateFile,
	releaseRunLock,
	runRecord,
	type SecretKey,
	type Secrets,
	STATE_FILE,
	sha256Of,
	writePlanFile,
	writeStateFile,
} from './run_files.ts';
// B14 — one private dir for .env and the state file (the same guard persistConfig runs).
import { statePathOutsidePrivateDir } from './state_path_guard.ts';
import {
	ABORT_AND_START_AGAIN,
	ALREADY_COMPLETE_LINE,
	advanceStep,
	emit,
	type InstallFault,
	interruptOnce,
	type LoopContext,
	nowIso,
	type Performed,
	readInstallFault,
	recordFailure,
	recordOf,
	redact,
	redactConsole,
	runStarted,
	say,
	stopChildren,
	warnLine,
} from './step_loop.ts';
import {
	INSTALL_STEPS,
	type InstallStepDefinition,
	type InstallStepInputs,
	installCreatedBackups,
	type StepRawOutcome,
	secretsNeeded,
	type VerifyContext,
} from './steps.ts';

// secretsNeeded lives in the config-free step table (scripts/install.ts asks for
// a resume's missing secrets BEFORE it seeds the environment config freezes).
// The fault seam lives in the shared loop (host steps are fault points too).
export { type InstallFault, readInstallFault, secretsNeeded };

/**
 * What the run writes to: log/warn lines, the one-time display of the salt,
 * and (optional, the full-screen front end) the step events and the signal
 * arming — run_events.ts RunIo.
 */
export type ExecutorIo = RunIo;

/** What the executor needs from the machine — injectable so the loop is testable without one. */
export interface ExecutorHost {
	initTest(): Promise<{ ok: boolean; errors: string[] }>;
	inspectDatabase(): Promise<TargetDatabaseState>;
	/** The server-side one-install-per-database lock; null = another session holds it. */
	holdDatabaseLock(): Promise<InstallLockHandle | null>;
	/** The directories check_directories manages. */
	directoryPaths(): Promise<string[]>;
	installStatus(): string | null;
	verifyRootLogin(password: string): Promise<boolean>;
	/** Why the server state file is not under the install's private dir, or null. */
	statePathProblem(): string | null;
	/** The media root check_directories provisions (null: none configured). */
	mediaRoot?(): Promise<string | null>;
	/** The server's runtime files an install may create (the state file, the session store). */
	runtimeFiles?(): Promise<string[]>;
	/** The database's row fingerprint (served_guard.ts), or null. */
	databaseFingerprint?(): Promise<string | null>;
	/**
	 * End THIS install's seed restore on the server (db_restore.ts endSeedRestore —
	 * campaign 3e F5): the pids ended.
	 */
	endSeedRestore?(installId: string): Promise<number[]>;
	/**
	 * What the developer listener's address refuses right now (D3: a port in use,
	 * the next free one suggested — dev_listener_check.ts; a running server on
	 * its unix socket; and a local authority already there for other names); []
	 * for a plan that opens none. The SAME
	 * function the interactive Review asks. REQUIRED, not optional: a host
	 * without it would answer "no refusal" silently and a fresh run would write
	 * a .env whose `bun run dev` collides.
	 */
	devListenerRefusals(
		listener: DevListenerPlan | null,
		certificate: DevCertificatePlan | null,
	): Promise<string[]>;
}

export interface ExecutorRequest {
	mode: RunMode;
	/** --execute given (recorded on the run). */
	execute?: boolean;
	/** fresh: built by the caller from the validated plan; resume/abort: read from disk here. */
	planFile?: PlanFile;
	/** fresh, or a resume that re-resolved the ontology catalog (its request carries the files). */
	plan?: InstallPlan;
	/** resume: the answers the command line gave (normalized), compared with the saved plan. */
	givenAnswers?: InstallAnswers;
	/** resume: the answer keys the operator actually supplied (only those are compared). */
	givenKeys?: readonly string[];
	secrets: Secrets;
	ontologyCatalog?: OntologyCatalog;
	/** abort: must equal the plan's db_database once the seed started. */
	confirmDatabase?: string;
	/**
	 * abort, a host route's engine child only: the host attests the instance
	 * never served (its request's `unserved` — C3-11). A SEALED install is then
	 * undone only when its database also proves it (served_guard.ts).
	 */
	unservedAttested?: boolean;
}

export interface ExecutorOutcome {
	exitCode: 0 | 1 | 130 | 143;
	result: 'complete' | 'already_complete' | 'aborted' | 'failed' | 'refused';
	/** The refusal/failure sentence (redacted). */
	message: string | null;
	failedStep: StepId | null;
	/** The resume/abort hint — empty when no state file exists. */
	hint: string[];
}

export interface ExecutorOptions {
	table?: { readonly [K in InstallStepId]: InstallStepDefinition };
	host?: ExecutorHost;
}

// ── secrets and the hint ─────────────────────────────────────────────────────

/** Is the step recorded done (in the state, when there is one)? */
function recordedDone(state: InstallState | null, step: InstallStepId): boolean {
	return state?.steps[step]?.status === 'done';
}

const SECRET_SOURCE: Readonly<Record<SecretKey, string>> = Object.freeze({
	db_password:
		'database password (DEDALO_INSTALL_DB_PASSWORD, --secrets-stdin, or typed at the prompt)',
	mysql_password:
		'diffusion password (DEDALO_INSTALL_MYSQL_PASSWORD, --secrets-stdin, or typed at the prompt)',
	smtp_pass:
		'SMTP password (DEDALO_INSTALL_SMTP_PASSWORD, --secrets-stdin, or typed at the prompt)',
	root_password:
		'root password (DEDALO_INSTALL_ROOT_PASSWORD, --secrets-stdin, or typed at the prompt)',
});

/** The command prefix that reaches the same private dir. */
function commandPrefix(): string {
	const dir = processEnvValue('DEDALO_INSTALL_PRIVATE_DIR') ?? '';
	return `${dir === '' ? '' : `DEDALO_INSTALL_PRIVATE_DIR=${dir} `}bun run scripts/install.ts`;
}

/** The lines that tell the operator how to resume or undo (the failure hint). */
export function resumeHint(
	plan: PlanFile,
	state: InstallState,
	needed: readonly SecretKey[],
): string[] {
	const secretsLine =
		needed.length === 0
			? []
			: [`    secrets needed again: ${needed.map((key) => SECRET_SOURCE[key]).join('; ')}`];
	const db = String(plan.answers.db_database ?? '<db>');
	// A step after the seal (the developer route's verify_dev_server) fails on a
	// SEALED install, which --abort refuses (SEALED_REFUSAL): offering it there
	// points the operator at a command that cannot work. An engine-only child's
	// host may still attest an unserved seal (assertUnservedSeal), so it keeps it.
	const sealed = recordedDone(state, 'install_finish') && plan.answers.engine_only !== true;
	return [
		`  Progress saved: ${join(installRunDir(), STATE_FILE)} (plan: ${PLAN_FILE})`,
		`  Fix the cause, then resume:  ${againWith(plan, '--resume')}`,
		...secretsLine,
		...(sealed
			? []
			: [`  Or undo this install:        ${againWith(plan, `--abort --confirm-database ${db}`)}`]),
	];
}

/**
 * The command that runs this install again with `flags`. An `--engine-only`
 * run is the by-hand host procedure's (manual_install.md host_engine): its
 * command is the service user's (`runuser … /opt/dedalo/bun/<pin>/bun run …`
 * with every answer flag), which this process cannot reprint — a bare
 * `bun run scripts/install.ts` there runs as root, with another Bun and no
 * answers (campaign 3b C3-54). It is named, never guessed.
 */
function againWith(plan: PlanFile, flags: string): string {
	if (plan.answers.engine_only === true) {
		return `the same command you ran, with ${flags} added (docs/install/manual_install.md#manual-host_engine)`;
	}
	return `${commandPrefix()} ${flags}`;
}

// ── the real host ────────────────────────────────────────────────────────────

/** The machine as the CLI sees it (config is frozen to the install's database by now). */
export function engineHost(appName: string): ExecutorHost {
	return {
		initTest: async () => {
			const { runInitTest } = await import('./init_test.ts');
			const report = runInitTest();
			return { ok: report.result, errors: report.errors };
		},
		inspectDatabase: async () => {
			const { inspectTargetDatabase } = await import('./db_restore.ts');
			const { connFromConfig } = await import('./pg_exec.ts');
			return inspectTargetDatabase(connFromConfig(), appName);
		},
		holdDatabaseLock: async () => {
			const { holdInstallLock } = await import('./db_restore.ts');
			const { connFromConfig } = await import('./pg_exec.ts');
			return holdInstallLock(connFromConfig(), appName);
		},
		directoryPaths: async () => (await import('./directories.ts')).installDirectoryPaths(),
		installStatus: () => getServerState().install_status ?? null,
		verifyRootLogin: async (password) => {
			const { login } = await import('../security/auth.ts');
			return (await login('root', password, 'local')).ok === true;
		},
		statePathProblem: statePathOutsidePrivateDir,
		mediaRoot: async () => {
			const { config } = await import('../../config/config.ts');
			const { assertTestMediaRoot } = await import('../media/test_media_root.ts');
			const root = config.media.rootPath;
			return root === null ? null : assertTestMediaRoot(root, 'install preflight');
		},
		runtimeFiles: async () => {
			const { RUNTIME_PATH_CENSUS } = await import('./runtime_paths.ts');
			return RUNTIME_PATH_CENSUS.filter((entry) => RUNTIME_FILE_IDS.includes(entry.id))
				.map((entry) => entry.resolve())
				.filter((path): path is string => path !== null);
		},
		databaseFingerprint: async () => {
			const { databaseFingerprint } = await import('./served_guard.ts');
			const { connFromConfig } = await import('./pg_exec.ts');
			return databaseFingerprint(connFromConfig());
		},
		devListenerRefusals: async (listener, certificate) => {
			const { devListenerRefusals } = await import('./dev_listener_check.ts');
			return devListenerRefusals(listener, certificate);
		},
		endSeedRestore: async (installId) => {
			const { endSeedRestore } = await import('./db_restore.ts');
			const { connFromConfig } = await import('./pg_exec.ts');
			return endSeedRestore(connFromConfig(), installId);
		},
	};
}

/** The runtime files a server creates in the private dir (runtime_paths.ts census ids). */
const RUNTIME_FILE_IDS: readonly string[] = Object.freeze(['ts_state_path', 'session_db_path']);

// ── the run ──────────────────────────────────────────────────────────────────

/** One executor run's mutable context (never module state — one per call). */
interface RunContext extends LoopContext {
	readonly table: { readonly [K in InstallStepId]: InstallStepDefinition };
	readonly host: ExecutorHost;
	readonly request: ExecutorRequest;
	run: RunRecord | null;
	secrets: Secrets;
	dbLock: InstallLockHandle | null;
	runLock: boolean;
	/** The last engine step's raw outcome (what its `created` hook records from). */
	lastOutcome: StepRawOutcome | null;
}

type RefusalCode = 'install.invalid_input' | 'install.state_conflict' | 'install.step_failed';

/** Throw `code` with `detail` when `condition` holds. */
function refuseIf(condition: boolean, code: RefusalCode, detail: () => string): void {
	if (condition) refuseInstall(code, detail());
}

function saveState(ctx: RunContext): void {
	if (ctx.state !== null) writeStateFile(ctx.state);
}

function verifyContext(ctx: RunContext): VerifyContext {
	return { plan: ctx.plan as PlanFile, state: ctx.state as InstallState, secrets: ctx.secrets };
}

/** The inputs every executor step runs with. */
function stepInputs(ctx: RunContext): InstallStepInputs {
	const plan = ctx.plan as PlanFile;
	const { secrets } = ctx;
	return {
		posted: {
			...plan.answers,
			db_password: secrets.db_password ?? '',
			mysql_password: secrets.mysql_password ?? '',
			smtp_pass: secrets.smtp_pass ?? '',
		},
		createDirectories: true,
		ontologyCatalog: ctx.request.ontologyCatalog,
		ontologyRequest: ctx.request.plan?.ontologyRequest ?? undefined,
		hierarchies: plan.hierarchies,
		actorUserId: -1,
		rootPassword: secrets.root_password,
		installId: (ctx.state as InstallState).install_id,
	};
}

/** The intent each step writes BEFORE its work (B13): what --abort must clean even without a checkpoint. */
const INTENT: Partial<Record<InstallStepId, (created: InstallState['created']) => void>> = {
	install_db_from_default_file: (created) => {
		created.seed_started = true;
	},
	stage_ontologies: (created) => {
		created.staging_dir = true;
	},
	persist_config: (created) => {
		created.env_file = true;
	},
	// The FIRST attempt decides: a retry finds the directory its own attempt made.
	dev_tls_certificate: (created) => {
		created.dev_tls_dir ??= !existsSync(devTlsDir());
	},
};

/** The pre-install .env's backup among `fresh` (its content hash is the preflight's). */
function originalBackup(fresh: readonly string[], sha: string | null): string | null {
	const dir = installPrivateDir();
	return fresh.find((name) => sha256Of(join(dir, name)) === sha) ?? null;
}

/**
 * persist_config's creations: the backups (every `.env.bak.*` that appeared
 * since the PREFLIGHT's baseline — never minus a per-attempt list, so an
 * operator's own older backup is never recorded, and one written by an attempt
 * that died before its checkpoint is), the original's backup, sample.env, the salt.
 */
function recordPersisted(ctx: RunContext): void {
	const state = ctx.state as InstallState;
	const { created, preflight } = state;
	const fresh = installCreatedBackups(state);
	created.env_backups = fresh;
	if (preflight.env_existed && created.env_backup === null) {
		created.env_backup = originalBackup(fresh, preflight.env_sha256);
	}
	created.sample_env =
		!preflight.sample_env_existed && existsSync(join(installPrivateDir(), 'sample.env'));
	rememberSalt(ctx);
}

/** The salt the .env now holds joins the redaction list (it is printed once, at the end only). */
function rememberSalt(ctx: RunContext): void {
	const salt = readInstallEnv()?.DEDALO_SALT_STRING ?? '';
	if (salt !== '' && !ctx.redactions.includes(salt)) ctx.redactions.push(salt);
}

/**
 * The ENGINE step's work (the loop's `perform`): its run with every psql it
 * starts tracked (ctrl+c stops them), its per-item rows printed, the
 * executor-only accept.
 */
async function performEngineStep(ctx: RunContext, step: InstallStepId): Promise<Performed> {
	const definition = ctx.table[step];
	const inputs = stepInputs(ctx);
	const outcome = await trackPsqlChildren(ctx.children, () => definition.run(inputs));
	ctx.lastOutcome = outcome;
	// The per-item rows first: a refused directory check names each directory.
	for (const line of definition.details?.(outcome) ?? []) say(ctx, `    ${line}`);
	const refusal = definition.accept?.(outcome, inputs) ?? null;
	refuseIf(refusal !== null, 'install.step_failed', () => refusal as string);
	return { message: outcome.msg, warnings: definition.warnings?.(outcome) ?? [] };
}

/** The engine step definition of `step` (the loop only ever hands this executor engine ids). */
function engineStep(ctx: RunContext, step: StepId): InstallStepDefinition {
	return ctx.table[step as InstallStepId];
}

/** The media tree directories a check_directories outcome created, absolute (C3-9). */
function mediaTreeCreated(outcome: StepRawOutcome | null): string[] {
	const tree = outcome?.mediaTree as
		| { root?: string; created?: readonly string[] }
		| null
		| undefined;
	if (typeof tree?.root !== 'string' || !Array.isArray(tree.created)) return [];
	const root = tree.root;
	return tree.created.map((path) => join(root, path));
}

/** What the step created, recorded with its checkpoint. */
const CREATED: Partial<Record<InstallStepId, (ctx: RunContext) => void>> = {
	persist_config: recordPersisted,
	check_directories: (ctx) => {
		const { created, preflight } = ctx.state as InstallState;
		created.directories = preflight.directories_missing.filter((path) => existsSync(path));
		created.media_tree = mediaTreeCreated(ctx.lastOutcome);
	},
	install_db_from_default_file: (ctx) => {
		(ctx.state as InstallState).created.seed_restored = true;
	},
};

// ── the modes ────────────────────────────────────────────────────────────────

/** The preflight a fresh run records (env, status, directories, extensions). */
async function freshPreflight(
	ctx: RunContext,
	database: TargetDatabaseState,
): Promise<InstallPreflight> {
	const envPath = installEnvPath();
	const salt = readInstallEnv(envPath)?.DEDALO_SALT_STRING ?? '';
	return {
		preexisting_extensions: [...database.extensions],
		env_backups_before: envBackups(),
		env_existed: existsSync(envPath),
		env_sha256: sha256Of(envPath),
		env_had_salt: salt !== '',
		sample_env_existed: existsSync(join(installPrivateDir(), 'sample.env')),
		install_status_before: ctx.host.installStatus(),
		directories_missing: missingWithAncestors(await ctx.host.directoryPaths()),
		media_root_empty: emptyOrMissing((await ctx.host.mediaRoot?.()) ?? null),
		runtime_files_before: ((await ctx.host.runtimeFiles?.()) ?? []).filter((path) =>
			existsSync(path),
		),
	};
}

/** Is `dir` absent or empty (null: no media root — nothing to prune)? */
function emptyOrMissing(dir: string | null): boolean {
	if (dir === null) return false;
	try {
		return readdirSync(dir).length === 0;
	} catch {
		return !existsSync(dir);
	}
}

/**
 * The managed directories that do not exist yet, WITH every missing ancestor a
 * recursive mkdir will also create (`backups` for `backups/db`) — so --abort
 * can remove exactly what the install made, and nothing that predates it.
 */
function missingWithAncestors(paths: readonly string[]): string[] {
	const missing = new Set<string>();
	for (const path of paths) {
		for (let current = resolve(path); !existsSync(current); current = dirname(current)) {
			missing.add(current);
		}
	}
	return [...missing];
}

/** The database must exist, be EMPTY for an install, and have no seed restore on it. */
function assertFreshTarget(db: string, target: TargetDatabaseState): void {
	refuseIf(!target.exists, 'install.state_conflict', () => `database '${db}' must exist first`);
	refuseIf(
		target.seedRestoreRunning !== null,
		'install.state_conflict',
		() => `a seed restore into '${db}' is still running (backend pid ${target.seedRestoreRunning})`,
	);
	refuseIf(
		!target.emptyForInstall,
		'install.state_conflict',
		() =>
			`database '${db}' is not empty (${target.userObjectCount} objects, e.g. ${target.userObjects.slice(0, 5).join(', ')}) — the installer only installs into an empty database`,
	);
	// The seed stamps the database (COMMENT ON DATABASE — owner only): what lets a
	// resume and --abort prove the database is this install's. Refused HERE,
	// before any write, not by a rolled-back restore later.
	refuseIf(
		!target.canStamp,
		'install.state_conflict',
		() =>
			`the install role does not own database '${db}' — create it with OWNER set to the install user (CREATE DATABASE ${db} OWNER <db user>)`,
	);
}

/** Take the server-side lock on the target database, or refuse. */
async function lockDatabase(ctx: RunContext, db: string): Promise<void> {
	ctx.dbLock = await ctx.host.holdDatabaseLock();
	refuseIf(
		ctx.dbLock === null,
		'install.state_conflict',
		() => `another install is running against database '${db}'`,
	);
}

/** Take the run-dir lock, or refuse. */
function lockRunDir(ctx: RunContext): void {
	const lock = acquireRunLock(ctx.request.mode, {
		note: (line) => say(ctx, `  ${line}`),
		warn: (line) => warnLine(ctx, `  ⚠ ${line}`),
	});
	if (!lock.ok) {
		refuseInstall(
			'install.state_conflict',
			`another install is running (pid ${lock.holder.pid} on ${lock.holder.host}, since ${lock.holder.started_at})`,
		);
	}
	ctx.runLock = true;
}

/** A fresh run never starts over an existing install record. */
function assertNoRecord(): void {
	const existing = readStateFile();
	if (existing === null) return;
	const db = String(readPlanFile()?.answers.db_database ?? '<db>');
	refuseInstall(
		'install.state_conflict',
		`an install record exists at ${join(installRunDir(), STATE_FILE)} (outcome: ${existing.outcome}) — resume it with --resume, undo it with --abort --confirm-database ${db}, or remove the install directory if this private directory is being reused deliberately`,
	);
}

/** The machine-side checks before the database is even looked at. */
async function assertMachineReady(ctx: RunContext): Promise<void> {
	const problem = ctx.host.statePathProblem();
	refuseIf(problem !== null, 'install.invalid_input', () => problem as string);
	refuseIf(
		ctx.host.installStatus() === 'sealed',
		'install.state_conflict',
		() =>
			'this private directory belongs to a SEALED installation — a fresh install never overwrites a live one',
	);
	say(ctx, '→ pre-flight checks');
	const init = await ctx.host.initTest();
	refuseIf(!init.ok, 'install.step_failed', () => `pre-flight: ${init.errors.join('; ')}`);
}

/** Reach the target, lock it, and prove it empty UNDER the lock (two installs cannot both see it empty). */
async function claimEmptyDatabase(ctx: RunContext, db: string): Promise<TargetDatabaseState> {
	const reachable = await ctx.host.inspectDatabase();
	refuseIf(
		!reachable.reachable,
		'install.step_failed',
		() => `database server not reachable for '${db}'`,
	);
	refuseIf(!reachable.exists, 'install.state_conflict', () => `database '${db}' must exist first`);
	await lockDatabase(ctx, db);
	const target = await ctx.host.inspectDatabase();
	assertFreshTarget(db, target);
	return target;
}

/**
 * The developer listener's port must be free BEFORE anything is written (D3):
 * a fresh install whose `bun run dev` would collide is refused with the next
 * free port named, never moved to it silently.
 */
async function assertListenerFree(ctx: RunContext): Promise<void> {
	const listener = ctx.request.plan?.devListener ?? null;
	const refusals = await ctx.host.devListenerRefusals(
		listener,
		ctx.request.plan?.devCertificate ?? null,
	);
	refuseIf(refusals.length > 0, 'install.state_conflict', () => refusals.join('; '));
}

/** Every refusal of a fresh run happens here — before anything is written. */
async function freshPreconditions(ctx: RunContext, plan: PlanFile): Promise<InstallPreflight> {
	lockRunDir(ctx);
	assertNoRecord();
	await assertMachineReady(ctx);
	await assertListenerFree(ctx);
	const target = await claimEmptyDatabase(ctx, String(plan.answers.db_database ?? ''));
	return freshPreflight(ctx, target);
}

/** A refusal before any write leaves nothing behind (lock released, a dir this run made removed). */
function undoFreshRefusal(ctx: RunContext, createdDir: boolean): void {
	if (ctx.state !== null) return;
	if (ctx.runLock) releaseRunLock();
	ctx.runLock = false;
	if (createdDir) removeRunDirIfEmpty();
}

/**
 * This executor runs ENGINE steps only: a plan holding a host step belongs to
 * the host executor (host/host_executor.ts) — reaching here with one is a front
 * end's programming error, refused before anything is written.
 */
function assertEnginePlan(plan: PlanFile): void {
	const host = plan.steps.filter((step) => !isInstallStepId(step));
	refuseIf(
		host.length > 0,
		'install.invalid_input',
		() =>
			`the plan holds host steps (${host.join(', ')}) — the ${String(plan.answers.route ?? '')} route runs them through the host executor`,
	);
}

/** FRESH: preflight everything, write nothing until it all passes, then run. */
async function freshRun(ctx: RunContext): Promise<void> {
	const plan = ctx.request.planFile as PlanFile;
	assertEnginePlan(plan);
	const createdDir = ensureRunDir();
	try {
		const preflight = await freshPreconditions(ctx, plan);
		// Only now is anything written.
		ctx.plan = plan;
		ctx.state = newInstallState(plan, preflight);
		startRun(ctx, 'fresh');
		writePlanFile(plan);
		saveState(ctx);
	} catch (error) {
		undoFreshRefusal(ctx, createdDir);
		throw error;
	}
	for (const step of plan.steps) await advanceStep(ctx, step);
}

/** Append this process's run record. */
function startRun(ctx: RunContext, mode: RunMode): void {
	ctx.run = runRecord(mode, ctx.request.execute === true);
	(ctx.state as InstallState).runs.push(ctx.run);
}

/** Read + check the saved plan and state (resume/abort). */
function loadRecord(ctx: RunContext): { plan: PlanFile; state: InstallState } {
	const plan = readPlanFile();
	const state = readStateFile();
	if (plan === null || state === null) {
		return refuseInstall(
			'install.state_conflict',
			`no install record at ${installRunDir()} — nothing to ${ctx.request.mode}`,
		);
	}
	refuseIf(
		planHash(plan) !== plan.plan_hash || state.plan_hash !== plan.plan_hash,
		'install.state_conflict',
		() => `the install record at ${installRunDir()} was modified (plan hash mismatch)`,
	);
	assertEnginePlan(plan);
	ctx.plan = plan;
	ctx.state = state;
	return { plan, state };
}

/** A resume's answers must be the saved plan's (resume takes the saved answers). */
function assertSameAnswers(ctx: RunContext, plan: PlanFile): void {
	const given = ctx.request.givenAnswers;
	const differing =
		given === undefined ? [] : answerDifferences(plan.answers, given, ctx.request.givenKeys);
	refuseIf(
		differing.length > 0,
		'install.state_conflict',
		() =>
			`answers differ from the saved plan: ${differing.join(', ')} — resume takes the saved answers: drop the flags, ${ABORT_AND_START_AGAIN}`,
	);
}

/** A resume that re-resolved the ontology source must have reached the same decisions. */
function assertSameOntologyDecisions(ctx: RunContext, plan: PlanFile): void {
	const replanned = ctx.request.plan;
	if (replanned === undefined) return;
	const fresh = ontologyDecisions(buildPlanFile(replanned, {}));
	refuseIf(
		canonicalJson(fresh) !== canonicalJson(ontologyDecisions(plan)),
		'install.state_conflict',
		() =>
			`the ontology source changed since the plan was written — put the source back, then --resume; ${ABORT_AND_START_AGAIN}`,
	);
}

/**
 * THIS install's seed restore still on the server while this run HOLDS the
 * install lock (campaign 3e F5) is an ORPHAN: every live installer of the
 * database holds that lock first, so its client is gone (a killed container
 * whose close never reached the server). It is ended — its one transaction
 * rolls back — and the run says so. Answers the database as it is afterwards.
 * A restore named for another install, or unnamed, is never touched.
 */
async function endOrphanSeedRestore(
	ctx: RunContext,
	db: string,
	target: TargetDatabaseState,
): Promise<TargetDatabaseState> {
	const installId = (ctx.state as InstallState).install_id;
	if (target.seedRestoreRunning === null || target.seedRestoreInstallId !== installId) {
		return target;
	}
	const ended = (await ctx.host.endSeedRestore?.(installId)) ?? [];
	if (ended.length === 0) return target;
	warnLine(
		ctx,
		`  ⚠ ended the seed restore an interrupted run left on '${db}' (backend pid ${ended.join(', ')}) — its installer is gone, its transaction rolled back`,
	);
	return ctx.host.inspectDatabase();
}

/** No other installer session may be working on the target (an orphan psql of a killed run). */
async function assertNoInstallerSessions(ctx: RunContext, db: string): Promise<void> {
	const target = await endOrphanSeedRestore(ctx, db, await ctx.host.inspectDatabase());
	refuseIf(
		!target.reachable,
		'install.step_failed',
		() => `database server not reachable for '${db}'`,
	);
	refuseIf(
		target.seedRestoreRunning !== null,
		'install.state_conflict',
		() => `a seed restore into '${db}' is still running (backend pid ${target.seedRestoreRunning})`,
	);
	refuseIf(
		target.installSessions.length > 0,
		'install.state_conflict',
		() =>
			`another installer session is still active on '${db}' (backend pid ${target.installSessions.join(', ')}) — wait for it to end`,
	);
}

/** The secrets a resume still needs and was not given. */
function assertSecretsGiven(ctx: RunContext, plan: PlanFile, state: InstallState): void {
	const missing = secretsNeeded(plan, state).filter((key) => (ctx.secrets[key] ?? '') === '');
	refuseIf(
		missing.includes('root_password'),
		'install.invalid_input',
		() =>
			'--resume needs the root password (set_root_pw has not run): DEDALO_INSTALL_ROOT_PASSWORD or --secrets-stdin',
	);
	refuseIf(
		missing.length > 0,
		'install.invalid_input',
		() => `--resume needs: ${missing.map((key) => SECRET_SOURCE[key]).join('; ')}`,
	);
}

/** RESUME: same plan, same answers, the missing secrets re-asked, then the loop. */
async function resumeRun(ctx: RunContext): Promise<void> {
	lockRunDir(ctx);
	const { plan, state } = loadRecord(ctx);
	refuseIf(
		plan.engine_version !== formatVersion(DEDALO_DATA_VERSION),
		'install.state_conflict',
		() =>
			`plan was written by engine ${plan.engine_version}; this is ${formatVersion(DEDALO_DATA_VERSION)}`,
	);
	assertSameAnswers(ctx, plan);
	assertSameOntologyDecisions(ctx, plan);
	assertSecretsGiven(ctx, plan, state);
	const db = String(plan.answers.db_database ?? '');
	await lockDatabase(ctx, db);
	await assertNoInstallerSessions(ctx, db);
	startRun(ctx, 'resume');
	saveState(ctx);
	for (const step of plan.steps) await advanceStep(ctx, step);
}

/** Has this install touched the database (the seed started)? */
function touchedDatabase(state: InstallState): boolean {
	return state.created.seed_started || state.created.seed_restored;
}

/**
 * An abort that never reached the seed still takes the server-side lock when
 * the database answers (a live run of the same install on another host holds
 * it); an unreachable server cannot hold it, so the abort proceeds, warned.
 */
async function lockUntouchedDatabase(ctx: RunContext, db: string): Promise<void> {
	if (!(await ctx.host.inspectDatabase()).reachable) {
		warnLine(
			ctx,
			`  ⚠ database '${db}' not reachable — aborting without the server-side install lock`,
		);
		return;
	}
	await lockDatabase(ctx, db);
}

/** The refusal of every sealed install that is not proven unserved (critique B3). */
const SEALED_REFUSAL = 'this install is SEALED (live) — --abort never undoes a sealed installation';

/**
 * A SEALED install is undone only as a host route's engine child whose host
 * attests the instance never served — AND whose database still has exactly
 * the rows it had when it sealed (served_guard.ts, campaign 3 C3-11). Anything
 * else is a live install: refused, nothing undone.
 */
async function assertUnservedSeal(
	ctx: RunContext,
	plan: PlanFile,
	state: InstallState,
): Promise<void> {
	refuseIf(
		ctx.request.unservedAttested !== true || plan.answers.engine_only !== true,
		'install.state_conflict',
		() => SEALED_REFUSAL,
	);
	const { unservedRefusal } = await import('./served_guard.ts');
	const now = (await ctx.host.databaseFingerprint?.()) ?? null;
	const refusal = unservedRefusal(state.created.sealed_fingerprint, now);
	refuseIf(
		refusal !== null,
		'install.state_conflict',
		() => `${SEALED_REFUSAL}: its host says it never served, but ${refusal}`,
	);
	warnLine(
		ctx,
		'  ⚠ the install is sealed but never served (its host attests it; its database is unchanged since the seal) — undoing it',
	);
}

/** The checks before any undo: never sealed (unless proven unserved); the database reset confirmed and safe. */
async function assertAbortable(
	ctx: RunContext,
	plan: PlanFile,
	state: InstallState,
): Promise<void> {
	// B3: a sealed install is a LIVE install — its database holds real records.
	if (recordedDone(state, 'install_finish') || ctx.host.installStatus() === 'sealed') {
		await assertUnservedSeal(ctx, plan, state);
	}
	const db = String(plan.answers.db_database ?? '');
	if (!touchedDatabase(state)) return lockUntouchedDatabase(ctx, db);
	refuseIf(
		ctx.request.confirmDatabase !== db,
		'install.invalid_input',
		() => `--abort resets database '${db}' to empty: confirm with --confirm-database ${db}`,
	);
	await lockDatabase(ctx, db);
	await assertNoInstallerSessions(ctx, db);
	// Checked BEFORE any undo (the seed's own reset checks it again, in its
	// transaction): a database that is neither this install's (its stamp) nor
	// empty is not the install's to reset — and nothing else is undone either.
	const target = await ctx.host.inspectDatabase();
	refuseIf(
		target.installStamp !== state.install_id && !target.emptyForInstall,
		'install.state_conflict',
		() =>
			`database '${db}' is not stamped by this install (${target.installStamp ?? 'no stamp'}) and is not empty — refusing to reset it; nothing was undone`,
	);
}

/** The steps --abort undoes, reverse plan order: every started one that has an undo. */
function undoableSteps(ctx: RunContext, plan: PlanFile, state: InstallState): InstallStepId[] {
	const started = (step: InstallStepId): boolean =>
		recordOf(ctx, step).status !== 'pending' ||
		(step === 'install_db_from_default_file' && touchedDatabase(state));
	return [...plan.steps]
		.filter(isInstallStepId)
		.reverse()
		.filter((step) => started(step) && ctx.table[step].undo !== undefined);
}

/** ABORT: undo, in reverse, only what the install created. */
async function abortRun(ctx: RunContext): Promise<void> {
	lockRunDir(ctx);
	const { plan, state } = loadRecord(ctx);
	await assertAbortable(ctx, plan, state);
	startRun(ctx, 'abort');
	saveState(ctx);
	const undoable = undoableSteps(ctx, plan, state);
	say(ctx, `→ undoing: ${undoable.join(', ') || 'nothing'}`);
	for (const step of undoable) {
		ctx.currentStep = step;
		const undo = ctx.table[step].undo as NonNullable<InstallStepDefinition['undo']>;
		const undone = await undo(verifyContext(ctx));
		say(ctx, `  [${step}] ${undone}`);
		emit(ctx, step, 'undo', { message: undone });
	}
	state.outcome = 'aborted';
	// The record's removal IS the reported "aborted": made power-cut durable before it is
	// reported, or a cut brings back a plan + state that resume would take for a live run.
	const barrier = new DirectoryBarrier();
	removeFileDurably(join(installRunDir(), PLAN_FILE), barrier);
	removeFileDurably(join(installRunDir(), STATE_FILE), barrier);
	barrier.flush();
	ctx.state = null;
}

/** Remove the run dir when nothing is left in it. */
function removeRunDirIfEmpty(): void {
	const dir = installRunDir();
	try {
		if (readdirSync(dir).length === 0) rmdirSync(dir);
	} catch {
		// absent or not empty: kept
	}
}

/** The end-to-end proof: an actual root login — when the password is in hand. */
async function verifyLogin(ctx: RunContext): Promise<void> {
	const password = ctx.secrets.root_password ?? '';
	if (password === '') {
		say(
			ctx,
			'  root login not re-verified (set_root_pw completed in an earlier run; password not re-asked)',
		);
		return;
	}
	say(ctx, '→ verify root login');
	const verified = await ctx.host.verifyRootLogin(password);
	refuseIf(!verified, 'install.step_failed', () => 'root login verification failed after install');
	say(ctx, '  root login verified');
}

/**
 * Print the ONE unredacted line: through the front end's one-time display when
 * it has one (answers whether it reached a terminal), else logged. The console
 * redaction is lifted only for this call.
 */
function displayUnredacted(ctx: RunContext, line: string): boolean {
	ctx.unredacted = true;
	try {
		if (ctx.io.showOnce !== undefined) return ctx.io.showOnce([line]);
		ctx.io.log(line);
		return true;
	} finally {
		ctx.unredacted = false;
	}
}

/**
 * The generated salt, shown ONCE (the one secret line — unredacted by design).
 * Through the front end's terminal when it has one: recorded as shown only
 * when it reached a terminal; otherwise (output redirected to a file) the run
 * says where the salt is stored instead of writing it into a log.
 */
function showSaltOnce(ctx: RunContext): void {
	const { created } = ctx.state as InstallState;
	const salt = readInstallEnv()?.DEDALO_SALT_STRING ?? '';
	if (!created.salt_generated || created.salt_shown || salt === '') return;
	if (displayUnredacted(ctx, `  generated DEDALO_SALT_STRING = ${salt}`)) created.salt_shown = true;
	else say(ctx, `  generated DEDALO_SALT_STRING stored in ${installEnvPath()} (0600)`);
}

/**
 * May this run (re)take the seal fingerprint (C3-11)? A host route's engine
 * child only, and only while the database is still what the last seal saw (or
 * none was taken yet) — so a later run never launders a served database into
 * an "unserved" one.
 */
async function sealStillClean(ctx: RunContext): Promise<boolean> {
	if ((ctx.plan as PlanFile).answers.engine_only !== true) return false;
	const recorded = (ctx.state as InstallState).created.sealed_fingerprint ?? null;
	if (recorded === null) return true;
	return (await ctx.host.databaseFingerprint?.()) === recorded;
}

/** Record the database's fingerprint as the seal's (after the install's own root login). */
async function recordSeal(ctx: RunContext): Promise<void> {
	(ctx.state as InstallState).created.sealed_fingerprint =
		(await ctx.host.databaseFingerprint?.()) ?? null;
}

/** The end of a fresh/resume run: the root login, the salt (once), the seal's fingerprint, the outcome. */
async function finishRun(
	ctx: RunContext,
	wasComplete: boolean,
): Promise<ExecutorOutcome['result']> {
	const clean = await sealStillClean(ctx);
	await verifyLogin(ctx);
	showSaltOnce(ctx);
	if (clean) await recordSeal(ctx);
	(ctx.state as InstallState).outcome = 'complete';
	closeRun(ctx, 'complete');
	return wasComplete && !ctx.ranAny ? 'already_complete' : 'complete';
}

/** Close this process's run record with `result` and checkpoint. */
function closeRun(ctx: RunContext, result: NonNullable<RunRecord['result']>): void {
	if (ctx.run === null || ctx.state === null) return;
	ctx.run.result = result;
	ctx.run.finished_at = nowIso();
	saveState(ctx);
}

/** Release everything this run holds. */
async function releaseAll(ctx: RunContext): Promise<void> {
	const lock = ctx.dbLock;
	ctx.dbLock = null;
	await lock?.release();
	if (ctx.runLock) releaseRunLock();
	ctx.runLock = false;
	if (ctx.request.mode === 'abort' && ctx.state === null) removeRunDirIfEmpty();
}

/**
 * The hint, when there is a saved install to resume — never for --abort, and
 * never in a host route's engine child: its parent tells the route's own
 * commands (C3-54).
 */
function hintFor(ctx: RunContext): string[] {
	const { plan, state } = ctx;
	if (plan === null || state === null || ctx.request.mode === 'abort') return [];
	if (ctx.io.delegated === true) return [];
	return resumeHint(plan, state, secretsNeeded(plan, state));
}

/** The outcome of a run that threw. */
function failedOutcome(ctx: RunContext, error: unknown): ExecutorOutcome {
	const code = isDedaloError(error) ? error.code : 'install.step_failed';
	const message = redact(ctx, error instanceof Error ? error.message : String(error));
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
		hint: hintFor(ctx),
	};
}

/**
 * Ctrl-C during the seed: end the restore's session ON THE SERVER first
 * (campaign 3e F5) — a killed psql's close can be lost with its container's
 * network, leaving the backend waiting on its client for hours. Only while
 * this run holds the install lock (the restore is then provably its own);
 * bounded, never fatal — the resume's lock-held check ends what this misses.
 */
async function endOwnSeedRestore(ctx: RunContext): Promise<void> {
	const installId = ctx.state?.install_id;
	if (ctx.dbLock === null || installId === undefined || ctx.host.endSeedRestore === undefined) {
		return;
	}
	let timer: ReturnType<typeof setTimeout> | undefined;
	const ended = await Promise.race([
		ctx.host.endSeedRestore(installId).catch(() => [] as number[]),
		new Promise<number[]>((done) => {
			timer = setTimeout(() => done([]), 8000);
		}),
	]);
	clearTimeout(timer);
	if (ended.length > 0) {
		say(ctx, `  ended the seed restore's database session (backend pid ${ended.join(', ')})`);
	}
}

/** SIGINT/SIGTERM: stop the children, record the step failed, release, exit 130/143. */
async function interrupted(
	ctx: RunContext,
	signal: 'SIGINT' | 'SIGTERM',
	restoreConsole: () => void,
): Promise<never> {
	await endOwnSeedRestore(ctx);
	await stopChildren(ctx);
	recordFailure(ctx, 'install.step_failed', 'interrupted');
	closeRun(ctx, 'interrupted');
	await releaseAll(ctx);
	restoreConsole();
	if (ctx.currentStep !== null) emit(ctx, ctx.currentStep, 'interrupted', { message: signal });
	ctx.io.interrupted?.(signal);
	ctx.io.warn(interruptLine(signal, ctx.currentStep, ctx.io.delegated === true));
	for (const line of hintFor(ctx)) ctx.io.warn(line);
	return process.exit(signal === 'SIGINT' ? 130 : 143);
}

/**
 * The interrupt's line. A host route's engine CHILD says it as a sub-line of
 * the parent's step — the parent prints the ONE `✖ install interrupted` block
 * of the run (campaign 3c D11: Ctrl-C in host_engine printed two ✖ lines, the
 * child's SIGTERM and the parent's SIGINT).
 */
export function interruptLine(
	signal: 'SIGINT' | 'SIGTERM',
	step: string | null,
	delegated: boolean,
): string {
	const at = step === null ? '' : ` at step [${step}]`;
	return delegated ? `engine stopped (${signal})${at}` : `\n✖ install interrupted (${signal})${at}`;
}

/** A fresh context for one call: the loop's hooks bound to the engine table. */
function newContext(
	request: ExecutorRequest,
	io: ExecutorIo,
	options: ExecutorOptions,
): RunContext {
	const table = options.table ?? INSTALL_STEPS;
	const ctx: RunContext = {
		io,
		table,
		host: options.host ?? engineHost(`dedalo_install:${process.pid}`),
		request,
		children: new Set(),
		fault: null,
		plan: null,
		state: null,
		run: null,
		secrets: { ...request.secrets },
		redactions: Object.values(request.secrets).filter(
			(value): value is string => typeof value === 'string',
		),
		currentStep: null,
		dbLock: null,
		runLock: false,
		lastOutcome: null,
		ranAny: false,
		unredacted: false,
		interruption: null,
		stepOf: (step) => engineStep(ctx, step),
		verifyOwn: async (step) => {
			const verify = engineStep(ctx, step).verify;
			return verify === undefined ? null : verify(verifyContext(ctx));
		},
		perform: (step) => performEngineStep(ctx, step as InstallStepId),
		intent: (step) => {
			INTENT[step as InstallStepId]?.((ctx.state as InstallState).created);
		},
		created: (step) => {
			CREATED[step as InstallStepId]?.(ctx);
		},
		save: () => saveState(ctx),
	};
	return ctx;
}

/** The mode's run, then (fresh/resume) the end-of-run tasks. */
async function runMode(ctx: RunContext): Promise<ExecutorOutcome> {
	ctx.fault = readInstallFault();
	if (ctx.request.mode === 'abort') {
		await abortRun(ctx);
		return { exitCode: 0, result: 'aborted', message: null, failedStep: null, hint: [] };
	}
	const wasComplete = ctx.request.mode === 'resume' && readStateFile()?.outcome === 'complete';
	await (ctx.request.mode === 'fresh' ? freshRun(ctx) : resumeRun(ctx));
	ctx.currentStep = null;
	const result = await finishRun(ctx, wasComplete);
	if (result === 'already_complete') say(ctx, ALREADY_COMPLETE_LINE);
	return { exitCode: 0, result, message: null, failedStep: null, hint: [] };
}

/**
 * Run the install (fresh), finish it (resume) or undo it (abort). Never throws
 * for a refusal or a failed step — the outcome carries the redacted sentence and
 * the hint; SIGINT/SIGTERM record the step failed, release the locks and exit
 * 130/143 from here.
 */
export async function executeInstall(
	request: ExecutorRequest,
	io: ExecutorIo,
	options: ExecutorOptions = {},
): Promise<ExecutorOutcome> {
	const ctx = newContext(request, io, options);
	const restoreConsole = redactConsole(ctx);
	// The ontology's RETIRED-property lines are for an ontology author, never the operator (C3-72).
	const restoreNotices = divertRetiredPropertyNotices(() => undefined);
	const restore = (): void => {
		restoreNotices();
		restoreConsole();
	};
	const sigint = () => void interruptOnce(ctx, () => interrupted(ctx, 'SIGINT', restore));
	const sigterm = () => void interruptOnce(ctx, () => interrupted(ctx, 'SIGTERM', restore));
	process.on('SIGINT', sigint);
	process.on('SIGTERM', sigterm);
	io.signals?.(true);
	try {
		return await runMode(ctx);
	} catch (error) {
		// A step that died of the operator's Ctrl-C ends as that interruption (N12).
		if (ctx.interruption !== null) return await ctx.interruption;
		return failedOutcome(ctx, error);
	} finally {
		process.off('SIGINT', sigint);
		process.off('SIGTERM', sigterm);
		io.signals?.(false);
		await releaseAll(ctx);
		restore();
	}
}
