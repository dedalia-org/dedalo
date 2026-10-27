/**
 * THE HOST STEP CONTRACT (terminal installer phase 4, 2026-10-12) — what a
 * production (or docker/trial) host step IS, beside the engine step contract
 * (steps.ts). Both run through the one loop (step_loop.ts): verify-skip,
 * adopt, drift, intent, created, the fault seam, the events.
 *
 * REVIEW EQUALS RUN. Every host step has a PURE `commands(ctx)`: the plan and
 * the FROZEN host facts (host_preflight's — state_types.ts) → the exact
 * commands. The Review lists them; `run` executes exactly them (host/execute.ts)
 * plus the step's own checks; a gate holds the recording runner's argv log to
 * the list. A CHECK (a read-only command whose value the run learns from an
 * earlier command, e.g. the digest a pull brings) may be listed with a
 * placeholder for that value: the run executes it with the value filled in,
 * and the gate holds the logged argv to the listed one with the placeholder
 * replaced (stack_image's cosign line — image.ts PULLED_DIGEST_PLACEHOLDER).
 * A command may carry an `unless` probe (read-only): when it exits 0
 * the command is skipped — what makes a step re-run after a kill converge
 * instead of failing on its own half-done work (`useradd` of a user it already
 * created).
 *
 * NOTHING SECRET IN A COMMAND: argv, a written file's content and a `text`
 * stdin are shown on the Review and logged. A secret reaches a child ONLY as
 * `stdin: {secrets}` — the run supplies the values, the Review shows the keys.
 */

import type { Subprocess } from 'bun';
import type { InstallAnswers } from '../install_plan.ts';
import type { ReviewMeasure } from '../review_measure.ts';
import type { RunIo } from '../run_events.ts';
import type { InstallState, PlanFile, SecretKey, Secrets } from '../run_files_core.ts';
import type { VerifyResult } from '../step_loop.ts';
import type { HostFacts } from './facts.ts';
import type { HostFs } from './fs.ts';
import type { HostStepId } from './ids.ts';
import type { InstancePaths } from './layout.ts';
import type { OsRow } from './os_support.ts';
import type { CommandRunner } from './runner.ts';
import type { HostCreated } from './state_types.ts';

/** Who a command runs as: this (root) process, the instance user, or postgres (runuser). */
export type RunAs = 'root' | 'instance' | 'postgres';

/**
 * The secrets an engine child is handed — the ones the plan USES (campaign 3
 * C3-48: the Review listed `mysql_password, smtp_pass` with Publication and
 * Mail off): the root password; the database password unless the production
 * route creates a peer-login database (no password exists); the MariaDB and
 * SMTP passwords only with publication / mail on. What reaches the child is
 * still only the given ones (execute.ts secretsJson).
 */
export function engineSecretKeys(answers: Partial<InstallAnswers>): SecretKey[] {
	const peerDatabase = answers.route === 'production' && (answers.db_mode ?? 'create') === 'create';
	return [
		'root_password',
		...(peerDatabase ? [] : (['db_password'] as const)),
		...(answers.diffusion === true ? (['mysql_password'] as const) : []),
		...(answers.mailer === true ? (['smtp_pass'] as const) : []),
	];
}

export interface ExecCommand {
	readonly kind: 'exec';
	readonly argv: readonly string[];
	readonly as: RunAs;
	/** One line for the Review (what it does, in words). */
	readonly label: string;
	/** Changes the host (false: a read-only probe — the only kind `verify` may run). */
	readonly mutates: boolean;
	/**
	 * `secrets`: the named secrets as ONE JSON object — wrapped as `{...with,
	 * secrets}` when `with` is given (the engine child's request: answers +
	 * secrets, critique B10); `text`: a non-secret text (SQL…).
	 */
	readonly stdin?:
		| { readonly secrets: readonly SecretKey[]; readonly with?: Readonly<Record<string, unknown>> }
		| { readonly text: string };
	readonly cwd?: string;
	readonly env?: Readonly<Record<string, string>>;
	/** Exit codes that count as success (default: 0 only). */
	readonly okExit?: readonly number[];
	/** Skip the command when this read-only probe exits 0 (already done). */
	readonly unless?: ExecCommand;
	readonly timeoutMs?: number;
	/**
	 * The command dies with this process (campaign 3 C3-29): wrapped in
	 * `setpriv --pdeathsig KILL` at BOTH ends of the runuser chain (runuser
	 * forks, so the outer one kills runuser and the inner one the command it
	 * started) — a killed installer never leaves the engine child working on
	 * as an orphan that a later resume would race.
	 */
	readonly pdeathsig?: true;
}

export interface WriteCommand {
	readonly kind: 'write';
	readonly path: string;
	readonly mode: number;
	readonly owner: string;
	readonly group: string;
	/** The rendered bytes (never a secret: templates hold names and paths only). */
	readonly content: string;
	readonly label: string;
}

export interface MkdirCommand {
	readonly kind: 'mkdir';
	readonly path: string;
	readonly mode: number;
	readonly owner: string;
	readonly group: string;
	readonly label: string;
	/**
	 * `instance`: made BY the service user (`install -d -m <mode>` under runuser
	 * — a directory inside the install folder, where root never works by path:
	 * critique B1); absent: by root through the HostFs.
	 */
	readonly as?: 'instance';
}

export interface RemoveCommand {
	readonly kind: 'remove';
	readonly path: string;
	readonly label: string;
}

export type HostCommand = ExecCommand | WriteCommand | MkdirCommand | RemoveCommand;

/**
 * The Review's view of a pulled image's digest (review.ts): the index digest the
 * registry named before the pull, or `unresolved` when it did not (the Review then
 * shows the cosign line by tag and says the digest is pinned at pull).
 */
export type ReviewImage = { readonly digest: string } | { readonly unresolved: true };

/** What a host step's commands are computed from (pure inputs). */
export interface HostPlanCtx {
	readonly plan: PlanFile;
	readonly answers: InstallAnswers;
	readonly facts: HostFacts;
	readonly row: OsRow;
	readonly paths: InstancePaths;
	/** The source tree the installer runs from (templates, scripts, the release). */
	readonly source: string;
	/**
	 * Set by the Review only (absent in a run and in the frozen digest): a check that
	 * needs the registry's digest shows it here; without it the placeholder stands.
	 */
	readonly reviewImage?: ReviewImage;
}

/** What a host step runs with. */
export interface HostCtx extends HostPlanCtx {
	readonly state: InstallState;
	readonly created: HostCreated;
	readonly secrets: Secrets;
	readonly runner: CommandRunner;
	readonly fs: HostFs;
	readonly io: RunIo;
	readonly children: Set<Subprocess>;
	/** A transcript line, redacted (the executor's say/warn). */
	say(line: string): void;
	warn(line: string): void;
	/** Checkpoint the state file now (what a step records before risky work survives a kill). */
	save(): void;
	/** The pause between polls (a gate passes one that returns at once). */
	sleep(ms: number): Promise<void>;
	now(): number;
	/** --confirm-database (abort only). */
	readonly confirmDatabase?: string;
	/** The Review build's measurement scope (a probe both Review hooks need runs once); absent in a run. */
	readonly measure?: ReviewMeasure;
}

/** A host step's own run result — an internal shape (never the wire's failure spelling). */
export interface HostRunResult {
	ok: boolean;
	detail: string;
	warnings?: string[];
	/** Lines the operator must read and act on (told, never done: firewall, modules). */
	told?: string[];
}

export interface HostStepDefinition {
	readonly id: HostStepId;
	/** `root`: the production root process; `operator`: docker/trial (no root needed). */
	readonly privilege: 'root' | 'operator';
	readonly kind: 'probe' | 'action';
	/** The secrets the step consumes (a resume re-asks them only while it is not done). */
	readonly needs: readonly SecretKey[];
	label(plan: PlanFile): string;
	/** The exact commands (pure) — the Review's list and the run's. */
	commands(ctx: HostPlanCtx): HostCommand[];
	/** Did the work land? Read-only commands only. Absent = always run. */
	verify?(ctx: HostCtx): Promise<VerifyResult>;
	run(ctx: HostCtx): Promise<HostRunResult>;
	/** Recorded BEFORE the work: what --abort may clean even without a checkpoint. */
	intent?(ctx: HostCtx): void;
	/** Recorded with the checkpoint (after the work). */
	created?(ctx: HostCtx): void;
	/** --abort only, only over `created`; answers what it did, in words. */
	undo?(ctx: HostCtx): Promise<string>;
	readonly neverAdopt?: true;
	/**
	 * RESTARTABLE (campaign 3 C3-8/C3-10): the step's run is idempotent and the
	 * loss of its outcome is not a data change (a service it STARTED stopped
	 * since — `compose up -d postgres`, the stack, the first start of the unit).
	 * A resume RE-RUNS such a step recorded done whose verify fails, instead of
	 * refusing it as drift. Never on a step that writes or removes anything an
	 * operator could have changed on purpose (a site file, a database).
	 */
	readonly restartable?: true;
	/**
	 * What the step must stop when the run is interrupted while it runs (the
	 * engine child's container: a killed `compose run` client leaves its
	 * container working — C3-29). Best effort; it never throws.
	 */
	onInterrupt?(ctx: HostCtx): Promise<void>;
	/**
	 * Did the start this step ISSUED take effect (`created.start_issued` set,
	 * `served` not — campaign 3c D1)? MEASURED on the host: the unit (production)
	 * or the engine's container (docker/trial) ever ran, or the engine answered. Asked before an abort decides what it undoes and
	 * before an interruption's hint says it. Unreadable: true (kept — an abort
	 * never takes apart an instance that may have served).
	 */
	servedProbe?(ctx: HostCtx): Promise<boolean>;
	/**
	 * The preflight's refusals, measured and recorded NOWHERE (campaign 3
	 * C3-23/C3-25): a fresh run asks them before it writes its record — a
	 * refused host keeps nothing of the attempt — and `--plan` reports them.
	 */
	refusals?(ctx: HostCtx): Promise<string[]>;
	/**
	 * At the end of EVERY run that completes the install (fresh, resume, a
	 * resume that adopted an orphaned child): the engine steps show the
	 * generated salt once, when no earlier run reached a terminal with it (C3-18).
	 * Answers the lines for the closing To-do (the salt's read command — campaign
	 * 3c D3: a run that completed after the salt was shown said nothing of it).
	 */
	afterComplete?(ctx: HostCtx): Promise<string[] | undefined>;
	/**
	 * What a FAILURE or INTERRUPTION block repeats once this step's work produced
	 * it (campaign 3e E3: the engine steps' generated salt was shown only on the
	 * full screen, which a Ctrl-C leaves — the ✖ block names its read command,
	 * never the value). Sync, never throws: read from the record only.
	 */
	hintLines?(ctx: HostCtx): string[];
	/**
	 * Which of `needs` the step's child still needs (campaign 3 C3-51) — asked
	 * of the child's own record; null when it cannot answer (then all of them).
	 */
	secretsStillNeeded?(ctx: HostCtx): Promise<SecretKey[] | null>;
}
