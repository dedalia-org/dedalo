/**
 * TS-NATIVE INSTALL CLI (DEC-19) — the installer's body, loaded by the
 * LAUNCHER scripts/install.ts once the tree has its dependencies (the launcher
 * refuses a tree without node_modules). Never run it directly:
 * every command below names the launcher. Headless, unattended install of a fresh
 * Dédalo instance with no PHP anywhere. A FRONT END of the install plan
 * (src/core/install/install_plan.ts): the screens, the flags and an answers file
 * become the same answers, the plan turns them into the .env and the step list,
 * and the EXECUTOR (src/core/install/executor.ts) runs those steps through the
 * ONE step table (steps.ts) — resumably:
 * a plan file and a state file under `<private>/install/` record every step, so
 * an install that dies anywhere is finished with `--resume` or undone with
 * `--abort --confirm-database <db>`. install.sh drives this script; it carries no
 * install logic of its own either.
 *
 * The one subtlety: `config` freezes at import from the environment. So the
 * plan is built first (config-free), its boot environment is seeded into the
 * process (cliBootEnv), and only THEN is the engine imported — config then
 * resolves the REAL values (not install-mode sentinels), the pool points at the
 * target DB, and no restart is needed. A resume does the same from the SAVED
 * plan (its secrets from the install's own .env once persist_config is done).
 *
 * INTERACTIVE (terminal installer phase 2, 2026-10-12): run with NO answer
 * (no answer flag, no --answers, --plan, --list-*, --resume, --abort,
 * --secrets-stdin, --execute or --root-password) on a terminal and the
 * installer ASKS — screen by screen, in the route's order
 * (src/core/install/screen_model.ts), each screen's probe run in a child
 * process, then a Review (install / edit <n> / write <path> / quit). ONE
 * session walks it (src/core/install/install_session.ts) through one of two
 * prompters: the FULL-SCREEN UI (src/core/install/ui/, OpenTUI — phase 3,
 * loaded only here, through src/core/install/tui_loader.ts; when it cannot
 * start, one line says why and the plain mode takes over), or the PLAIN line
 * mode (src/core/install/ui_plain/) — selected by --plain, TERM=dumb or unset,
 * a redirected stdout (the prompts then go to stderr or /dev/tty) or a
 * terminal under 80×24. The full-screen UI also draws the run (the
 * executor's step events) and the Done screen; it restores the terminal on
 * every exit path. An unfinished install found on start offers resume, abort
 * (the database name typed back) or quit. The interactive answers run
 * through the SAME plan and executor as the flags below; the catalog is
 * re-resolved here and a decision that changed since the Review is refused.
 * Piped stdin with no answer source is REFUSED (use --answers).
 *
 * HOST ROUTES (phase 4, 2026-10-12): `--route production` (and docker/trial)
 * plans HOST steps (src/core/install/host/) and runs them through the HOST
 * executor (host/host_executor.ts) — in THIS process, which then stays
 * config-free: it never seeds the engine environment nor imports the engine
 * executor (the catalog is resolved in the probe child). Production needs
 * root (`sudo sh install.sh …`); its record is /var/lib/dedalo-install/<i>/,
 * so a resume or abort names the route and instance again. The engine steps
 * run in ONE child, as the instance user: `--request-stdin --execute
 * --events-jsonl` (answers + secrets as one JSON object on stdin; events as
 * JSON lines on stdout), verified with `--status --json`.
 *
 * --write-answers <file> writes the reviewed (or, headless, the planned)
 * answers as a dedalo.install.answers/1 file (0600, atomic, no secret; never
 * inside the private dir, never over a file that is not an answers file).
 *
 * Usage (npm script `dedalo:install` — NOT `install`, which is a reserved
 * package-manager lifecycle hook):
 *   bun run scripts/install.ts                      # interactive (a terminal)
 *   bun run scripts/install.ts --plain [--write-answers answers.json]
 *   DEDALO_INSTALL_ROOT_PASSWORD='...' [DEDALO_INSTALL_DB_PASSWORD='...'] \
 *   bun run scripts/install.ts --db-name dedalo_x --db-user u --entity myentity \
 *       [--route production|docker|trial|developer] [--instance <name>] \
 *       [--answers answers.json] [--write-answers out.json] \
 *       [--db-host localhost] [--db-port 5432] [--db-socket ...] \
 *       [--entity-label ...] [--information ...] [--info-key ...] \
 *       [--timezone Europe/Madrid] [--locale es-ES] \
 *       [--langs lg-eng,lg-spa] [--app-lang lg-eng] [--data-lang lg-eng] \
 *       [--hierarchies es,fr | default | none] \
 *       [--ontologies oh,tch | default] [--ontology-source <dir|archive>] \
 *       [--decline-dependencies tchi,ts:hierarchy1] \
 *       [--diffusion --mysql-host ... --mysql-port ... --mysql-socket ... \
 *          --mysql-name ... --mysql-user ...] \
 *       [--mailer --smtp-host smtp.example.org --smtp-port 587 --smtp-secure tls \
 *          --smtp-user ... --smtp-from ... --smtp-from-name ...] \
 *       [--media-path /srv/dedalo/media] [--socket /run/dedalo/dedalo_ts.sock] \
 *       [--media-access-mode publication] \
 *       [--no-update-servers] [--skip-tools] [--plan] [--list-ontologies] [--list-hierarchies] \
 *       [--list-langs] [--secrets-stdin] [--execute]
 * Any value flag also takes the `--flag=value` form (a value may then start
 * with `--`).
 *   bun run scripts/install.ts --resume [same answers, or none]
 *   bun run scripts/install.ts --abort --confirm-database dedalo_x
 *
 * SECRETS (never in an answers file, never in the plan/state files, never
 * printed — the generated salt is shown ONCE in the final summary), highest
 * precedence first: `--secrets-stdin` (one JSON object {db_password,
 * mysql_password, smtp_pass, root_password}); the environment variables
 * DEDALO_INSTALL_DB_PASSWORD / _MYSQL_PASSWORD / _SMTP_PASSWORD / _ROOT_PASSWORD
 * (removed from this process's environment once read); the legacy argv flags
 * --db-password / --mysql-password / --smtp-password / --root-password, which
 * still work but warn (visible to other users in `ps`). On a TERMINAL, without
 * --execute, a fresh run with no root password and a --resume missing a secret
 * it still needs ASK for it (hidden, twice; the root password against the
 * policy); --execute never prompts.
 *
 * VALIDATION BEFORE ANY WRITE: every answer-only refusal — the root password
 * policy included — is the PLAN's (install_validation.ts), and the target
 * database must exist and be EMPTY (zero user objects); nothing is written
 * until both pass.
 *
 * Defaults live in the plan, not here: --hierarchies omitted (or `default`) =
 * NO optional thesaurus beyond the ones the chosen ontologies DECLARE
 * (hierarchy60 — the same boxes the screens pre-tick; 2026-10-10). The offer is
 * every entry of the vendored thesaurus manifest (install/import/hierarchy/
 * hierarchy.json), with or without data files (one without installs as an empty
 * thesaurus). No toponymy is ever a default: a plan without one prints a
 * SUGGESTION to import the operator's own country. Languages (lg) is ALWAYS
 * activated by the seed restore and is not a choice. The official update server
 * is written unless --no-update-servers (air-gapped: ONTOLOGY_SERVERS /
 * CODE_SERVERS = []). An unknown flag is an error, never ignored.
 *
 * DOMAIN ONTOLOGIES (A4/A5/A6): --ontologies omitted = `oh`, installed from the
 * one vendored file; any other TLD comes from the first configured ontology
 * server (the official master by default) or from --ontology-source (a
 * directory in the server export layout — ontology.json + <tld>.copy.gz
 * [+ matrix_dd.copy.gz] — or a .tar/.tar.gz/.tgz of one: a fully offline
 * install). The DECLARED dependencies of the chosen TLDs (hierarchy60) are
 * installed with them: ontologies (`main: ontology35`) deps first, thesauri
 * (`main: hierarchy1`) added to --hierarchies. A MANDATORY ONTOLOGY cannot be
 * declined; an OPTIONAL ontology and EVERY thesaurus are installed unless
 * --decline-dependencies names them (a TLD, or `<tld>:ontology35|hierarchy1`).
 * A thesaurus never blocks the install (owner decision 2026-10-10): declining a
 * MANDATORY one, or one with no hierarchy.json entry, is a warning — strongly
 * recommended, installable later from Maintenance › Install hierarchies. The
 * catalog is resolved ONCE, before anything is written; the files are staged and
 * verified before the database is touched (stage_ontologies) and imported right
 * after the seed restore (install_ontologies).
 *
 * --plan prints ONE JSON line (env_keys, steps, hierarchies,
 * hierarchy_dependencies, suggestions, ontologies, declined_dependencies,
 * ontology_source, ontology_install, active_ontology_tlds, notes, warnings,
 * errors) and exits — 0 when the answers are valid, 1 otherwise — touching no
 * database and no file (a non-vendored choice reads the source's manifest). No
 * root password is needed; one that IS supplied is checked against the policy.
 *
 * --list-ontologies prints ONE JSON line — the catalog view the installer's
 * Ontologies screen shows (source, default, core, entries with their declared
 * dependencies and what each also installs, warnings) + errors — for the source
 * the other answers select (--ontology-source, --no-update-servers, or the
 * configured server), and exits. It needs no other answer.
 *
 * --list-hierarchies prints ONE JSON line — the thesaurus offer of the vendored
 * manifest (core, typologies, entries {tld, name, typology_id, typology_name,
 * has_data, dependencies}, the toponymy suggestion) + errors — and exits. It
 * needs no other answer.
 *
 * --list-langs prints ONE JSON line — {langs: [{code, label}], default} — and
 * exits.
 *
 * Exit codes: 0 done (an interactive `quit` typed too: nothing installed), 1
 * refused or failed (a failure after the first write prints how to resume or
 * undo; an interactive answer refused too often), 130 SIGINT (Ctrl-C / Ctrl-D
 * at an interactive question included), 143 SIGTERM.
 */

import {
	closeSync,
	openSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeSync,
} from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
// All config-free — safe to import BEFORE the environment is seeded.
import {
	liveProcessEnv,
	processEnvValue,
	seedProcessEnv,
	unsetProcessEnv,
} from '../src/config/env.ts';
import {
	type FrontEndChoice,
	type FrontEndResult,
	keptAnswersLines,
	type ReviewedDecisions,
	reviewedDecisionsRefusal,
	selectFrontEndFor,
	type TerminalCaps,
	withKeptAnswers,
	writeAnswersFile,
} from '../src/core/install/front_end.ts';
import { CORE_HIERARCHIES, hierarchyChoiceView } from '../src/core/install/hierarchy_meta.ts';
import {
	ANSWERS_FILE_SCHEMA,
	answersFromAnswersFile,
	answersFromCliArgs,
	buildInstallPlan,
	cliBootEnv,
	type InstallAnswers,
	type InstallPlan,
	isInstallStepId,
	mergeAnswerSources,
	normalizeInstallAnswers,
	offeredThesauri,
	ontologyServersFor,
	ontologySourceFor,
	planCatalogNeeded,
	SECRET_ANSWER_KEYS,
	TOPONYMY_SUGGESTION,
} from '../src/core/install/install_plan.ts';
import type { CliInteractiveDeps } from '../src/core/install/install_session.ts';
import {
	INSTALL_DEFAULT_LANG_CODES,
	INSTALL_LANG_CATALOG,
} from '../src/core/install/lang_catalog.ts';
import {
	describeOntologyCatalog,
	type OntologyCatalog,
	vendoredOntologyCatalog,
} from '../src/core/install/ontology_choice.ts';
import { readPriorEnv } from '../src/core/install/prior_env.ts';
import type { InstallPrompter } from '../src/core/install/prompter_contract.ts';
import type { RunAnnouncement, RunReporter } from '../src/core/install/run_events.ts';
import {
	buildPlanFile,
	liveLockHolder,
	type PlanFile,
	readInstallEnv,
	readPlanFile,
	readStateFile,
	runConfirmed,
	SECRET_KEYS,
	type SecretKey,
	type Secrets,
	secretsFromEnv,
} from '../src/core/install/run_files.ts';
import { ABORT_AND_START_AGAIN } from '../src/core/install/step_loop.ts';
import { plainReporter as plainRunReporter } from '../src/core/install/ui_plain/reporter.ts';

/** Removes the resolved catalog's scratch files (an extracted --ontology-source archive). */
let cleanupCatalog: () => void = () => undefined;

/** The full-screen UI while it is up (every exit path goes through it: the terminal is restored). */
let activeUi: import('../src/core/install/tui_loader.ts').TuiFrontEnd | null = null;

function fail(msg: string, after: readonly string[] = []): never {
	cleanupCatalog();
	// The full-screen UI is restored FIRST; the message is printed on the main screen after it.
	if (activeUi !== null) return activeUi.exitNow(1, [`✖ install failed: ${msg}`, ...after]);
	console.error(`\n✖ install failed: ${msg}`);
	for (const line of after) console.error(line);
	console.error('');
	process.exit(1);
}

const invocation = answersFromCliArgs(Bun.argv.slice(2));

// ── --status (the engine child's record, as its host parent verifies it) ─────

/** What `--status --json` answers (host/production/engine_delegate.ts EngineStatus). */
interface StatusAnswer {
	exists: boolean;
	outcome: string | null;
	failed_step: string | null;
	/** The secrets a --resume of this record still needs (C3-51: the host parent asks only those). */
	needs: string[];
	/** This install generated the salt (C3-18: the host shows it once). */
	salt_generated: boolean;
	/** A live process holding this record's install lock (C3-29: a resume never races it). */
	running: { pid: number; started_at: string } | null;
}

/** The saved record, read config-free (the run files and the config-free step table). */
async function statusAnswer(): Promise<StatusAnswer> {
	const { secretsNeeded } = await import('../src/core/install/steps.ts');
	const state = readStateFile();
	const plan = readPlanFile();
	const failed = Object.entries(state?.steps ?? {}).find(
		([, record]) => record.status === 'failed',
	);
	const holder = liveLockHolder();
	return {
		exists: state !== null,
		outcome: state?.outcome ?? null,
		failed_step: failed?.[0] ?? null,
		needs: plan === null ? [] : secretsNeeded(plan, state),
		salt_generated: state?.created.salt_generated === true,
		running: holder === null ? null : { pid: holder.pid, started_at: holder.started_at },
	};
}

/**
 * The host record of a docker / trial install (F6): the stack's record in the
 * checkout (host/stack/…, `<checkout>/.dedalo-install/`) that the host run writes
 * and resumes. The engine's own record lives in the container's private volume,
 * which this process cannot see — so the host answer reads the host record, the
 * one `--resume` reads, and says what that record says.
 */
async function hostStatusAnswer(given: InstallAnswers): Promise<StatusAnswer> {
	const { hostRunDirOf, readHostRecord } = await import(
		'../src/core/install/host/host_executor.ts'
	);
	const { secretsNeeded } = await import('../src/core/install/steps.ts');
	const record = readHostRecord(given);
	const state = record?.state ?? null;
	const failed = Object.entries(state?.steps ?? {}).find(([, step]) => step.status === 'failed');
	const holder = liveLockHolder(hostRunDirOf(given));
	return {
		exists: state !== null,
		outcome: state?.outcome ?? null,
		failed_step: failed?.[0] ?? null,
		needs: record === null || state === null ? [] : secretsNeeded(record.plan, state),
		salt_generated: state?.created?.salt_generated === true,
		running: holder === null ? null : { pid: holder.pid, started_at: holder.started_at },
	};
}

/**
 * --status [--json]: the saved record of THIS process's private dir, then exit
 * — config-free (the run files only). What a host route's host_engine step
 * reads (as the instance user) instead of reading another user's tree. On the
 * docker and trial routes the answer is the stack's host record (hostStatusAnswer).
 */
async function printStatus(): Promise<never> {
	let answer: StatusAnswer;
	try {
		const given = normalizeInstallAnswers(invocation.raw).answers;
		answer =
			given.route === 'docker' || given.route === 'trial'
				? await hostStatusAnswer(given)
				: await statusAnswer();
	} catch (error) {
		console.error(`✖ ${(error as Error).message}`);
		process.exit(1);
	}
	console.log(
		invocation.json
			? JSON.stringify(answer)
			: `install record: ${answer.exists ? answer.outcome : 'none'}`,
	);
	process.exit(0);
}

if (invocation.status && invocation.errors.length === 0) await printStatus();

// ── which front end (before ANY read or write) ───────────────────────────────

/**
 * The terminal as this process sees it — THE one place outside src/ that reads
 * it (front_end.ts selectFrontEnd decides from it).
 */
function terminalCaps(): TerminalCaps {
	const stdoutTty = process.stdout.isTTY === true;
	const stderrTty = process.stderr.isTTY === true;
	return {
		stdinTty: process.stdin.isTTY === true,
		stdoutTty,
		stderrTty,
		ttyDevice: !stdoutTty && !stderrTty && ttyDeviceWritable(),
		rawMode: typeof process.stdin.setRawMode === 'function',
		term: processEnvValue('TERM'),
		noColor: (processEnvValue('NO_COLOR') ?? '') !== '',
		columns: process.stdout.columns ?? process.stderr.columns,
		rows: process.stdout.rows ?? process.stderr.rows,
	};
}

/** Can /dev/tty be opened for writing (the last-resort prompt sink)? */
function ttyDeviceWritable(): boolean {
	try {
		closeSync(openSync('/dev/tty', 'w'));
		return true;
	} catch {
		return false;
	}
}

const frontEnd: FrontEndChoice = selectFrontEndFor(terminalCaps(), invocation);
if (frontEnd.kind === 'refuse') {
	console.error(`\n✖ install failed: ${frontEnd.error}\n`);
	process.exit(1);
}
if (frontEnd.kind === 'interactive' && invocation.errors.length > 0) {
	console.error(`\n✖ install failed: ${invocation.errors.join('; ')}\n`);
	process.exit(1);
}

const priorEnv = await readPriorEnv();

for (const flag of invocation.argvSecretFlags) {
	console.warn(
		`⚠ ${flag} on the command line is visible to other users (ps); use DEDALO_INSTALL_* or --secrets-stdin`,
	);
}

// ── the secrets (stdin > environment > argv), then out of the environment ────

/** The environment variable each secret may come from. */
const SECRET_ENV: Readonly<Record<SecretKey, string>> = {
	db_password: 'DEDALO_INSTALL_DB_PASSWORD',
	mysql_password: 'DEDALO_INSTALL_MYSQL_PASSWORD',
	smtp_pass: 'DEDALO_INSTALL_SMTP_PASSWORD',
	root_password: 'DEDALO_INSTALL_ROOT_PASSWORD',
};

/** One JSON object from stdin (`what` names the flag in the refusal), or fail. */
async function stdinObject(what: string): Promise<Record<string, unknown>> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(await Bun.stdin.text());
	} catch {
		// NEVER the parser's message: it quotes the offending token, which is
		// typically an unquoted secret value.
		return fail(`${what}: not one JSON object`);
	}
	if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
		return fail(`${what}: not one JSON object`);
	}
	return parsed as Record<string, unknown>;
}

/** The secrets of a parsed object: known keys, string values only. */
function secretsOf(what: string, parsed: Record<string, unknown>): Secrets {
	const secrets: Secrets = {};
	for (const [key, value] of Object.entries(parsed)) {
		if (!(SECRET_KEYS as readonly string[]).includes(key)) {
			fail(`${what}: unknown key '${key}' (expected ${SECRET_KEYS.join(', ')})`);
		}
		if (typeof value !== 'string') fail(`${what}: '${key}' must be a string`);
		secrets[key as SecretKey] = value;
	}
	return secrets;
}

/** The request a host parent hands its engine child (--request-stdin): answers + secrets. */
const REQUEST_SCHEMA = 'dedalo.install.request/1';

/** `--secrets-stdin` (one JSON object of secrets) or `--request-stdin` ({schema, answers, secrets}). */
async function stdinInput(): Promise<{
	secrets: Secrets;
	answers: Record<string, unknown> | null;
	unserved: boolean;
}> {
	if (invocation.requestStdin) {
		const request = await stdinObject('--request-stdin');
		if (request.schema !== REQUEST_SCHEMA)
			fail(`--request-stdin: schema must be ${REQUEST_SCHEMA}`);
		const secrets = (request.secrets ?? {}) as Record<string, unknown>;
		return {
			secrets: secretsOf('--request-stdin', secrets),
			answers: (request.answers ?? {}) as Record<string, unknown>,
			// The host parent's attestation on an --abort: the instance never served (C3-11).
			unserved: request.unserved === true,
		};
	}
	if (!invocation.secretsStdin) return { secrets: {}, answers: null, unserved: false };
	return {
		secrets: secretsOf('--secrets-stdin', await stdinObject('--secrets-stdin')),
		answers: null,
		unserved: false,
	};
}

/** One secret by precedence; '' counts as not given. */
function pick(...candidates: (string | undefined)[]): string | undefined {
	return candidates.find((value) => value !== undefined && value !== '');
}

const stdinPart = await stdinInput();
const fromStdin = stdinPart.secrets;
const argvSecret = (key: string): string | undefined => {
	const value = invocation.raw[key];
	return typeof value === 'string' ? value : undefined;
};
const secrets: Secrets = {};
for (const key of SECRET_KEYS) {
	const fromArgv = key === 'root_password' ? invocation.rootPassword : argvSecret(key);
	const value = pick(fromStdin[key], processEnvValue(SECRET_ENV[key]), fromArgv);
	if (value !== undefined) secrets[key] = value;
}
// Read once and removed from process.env. Bun's default spawn env is the
// ORIGINAL environ (deletes ignored), so every installer child is spawned with
// an explicit env built from the live one (liveProcessEnv / envSnapshot /
// pgClientEnv) — gate: install_probe_child.test.ts. (The database password does
// reach the psql children the installer starts — as DB_PASSWORD/PGPASSWORD,
// they need it; the root, SMTP and diffusion passwords reach no child.)
unsetProcessEnv(Object.values(SECRET_ENV));

// ── the answers (flags + an answers file; secrets apart) ─────────────────────

/** The flags' answers without their secret values (those live in `secrets`). */
function plainFlagAnswers(): Record<string, unknown> {
	const raw = { ...invocation.raw };
	for (const key of SECRET_ANSWER_KEYS) delete raw[key];
	return raw;
}

function readAnswersFile(path: string): { raw: Record<string, unknown>; errors: string[] } {
	let json: unknown;
	try {
		json = JSON.parse(readFileSync(path, 'utf8'));
	} catch (error) {
		return { raw: {}, errors: [`answers file ${path}: ${(error as Error).message}`] };
	}
	return answersFromAnswersFile(json);
}

const parseErrors = [...invocation.errors];
let plainRaw = plainFlagAnswers();
if (stdinPart.answers !== null) {
	// The request's answers are an answers file's (the same key rules: no secret, no unknown key).
	const request = answersFromAnswersFile({
		schema: ANSWERS_FILE_SCHEMA,
		answers: stdinPart.answers,
	});
	plainRaw = request.raw;
	parseErrors.push(
		...request.errors.map((error) => error.replace(/^answers file/, '--request-stdin')),
	);
}
if (invocation.answersFile !== undefined) {
	const file = readAnswersFile(invocation.answersFile);
	const merged = mergeAnswerSources(plainRaw, file.raw);
	plainRaw = merged.raw;
	parseErrors.push(...file.errors, ...merged.errors);
}
/** The raw answers the plan is built from: the plain ones + the secret answers (memory only). */
function withSecrets(raw: Record<string, unknown>, given: Secrets): Record<string, unknown> {
	return {
		...raw,
		...(given.db_password === undefined ? {} : { db_password: given.db_password }),
		...(given.mysql_password === undefined ? {} : { mysql_password: given.mysql_password }),
		...(given.smtp_pass === undefined ? {} : { smtp_pass: given.smtp_pass }),
	};
}
let raw = withSecrets(plainRaw, secrets);

// ── listings ─────────────────────────────────────────────────────────────────

/**
 * B5 hygiene: an --ontology-source archive is extracted into
 * `<tmp>/dedalo_ontology_source_*` and removed by the catalog's cleanup — which
 * a SIGKILL never runs. Sweep the ones older than a day (a concurrent run's own
 * fresh one is never touched).
 */
function sweepOrphanSourceDirs(): void {
	const dayAgo = Date.now() - 24 * 3600 * 1000;
	try {
		for (const name of readdirSync(tmpdir())) {
			if (!name.startsWith('dedalo_ontology_source_')) continue;
			const path = join(tmpdir(), name);
			if (statSync(path).mtimeMs < dayAgo) rmSync(path, { recursive: true, force: true });
		}
	} catch {
		// hygiene only — never blocks an install
	}
}

/**
 * Resolve the source catalog of `answers` (it imports the engine, so call it only
 * after the environment is seeded — or when the process exits right after).
 */
async function resolveCatalogOf(
	answersRaw: Record<string, unknown>,
	prior: Readonly<Record<string, string>>,
): Promise<{ catalog: OntologyCatalog | undefined; errors: string[] }> {
	const { answers } = normalizeInstallAnswers(answersRaw);
	const source = ontologySourceFor(answers, prior);
	if (!planCatalogNeeded(answers, source)) return { catalog: undefined, errors: [] };
	sweepOrphanSourceDirs();
	const { resolveOntologyCatalog } = await import('../src/core/install/ontology_catalog.ts');
	try {
		const resolved = await resolveOntologyCatalog(source, {
			allowedServers: ontologyServersFor(answers, prior),
		});
		cleanupCatalog = resolved.cleanup;
		return { catalog: resolved.catalog, errors: [] };
	} catch (error) {
		return { catalog: undefined, errors: [error instanceof Error ? error.message : String(error)] };
	}
}

/** --list-ontologies: the catalog view of the selected source, then exit. */
async function listOntologies(): Promise<never> {
	const { answers } = normalizeInstallAnswers(raw);
	const source = ontologySourceFor(answers, priorEnv);
	const { resolveOntologyCatalog } = await import('../src/core/install/ontology_catalog.ts');
	const errors = [...parseErrors];
	let catalog = vendoredOntologyCatalog();
	try {
		const resolved = await resolveOntologyCatalog(source, {
			allowedServers: ontologyServersFor(answers, priorEnv),
		});
		catalog = resolved.catalog;
		resolved.cleanup();
	} catch (error) {
		errors.push(error instanceof Error ? error.message : String(error));
	}
	console.log(JSON.stringify({ ...describeOntologyCatalog(catalog), errors }));
	process.exit(errors.length === 0 ? 0 : 1);
}

if (invocation.listOntologies) await listOntologies();

/** --list-hierarchies: the vendored thesaurus offer, then exit (config-free: the manifest only). */
function listHierarchies(): never {
	const errors = [...parseErrors];
	const offer = offeredThesauri(errors);
	// The declared thesaurus dependencies (hierarchy60) and THE order (by name),
	// from THE client view — the list a script reads is the list the screen shows.
	const dependenciesOf = new Map<string, { tld: string; mandatory: boolean }[]>();
	const labelOf = new Map<string, string>();
	const rank = new Map<string, number>();
	if (errors.length === 0) {
		for (const [index, item] of hierarchyChoiceView('lg-eng').hierarchies.entries()) {
			dependenciesOf.set(item.tld, item.dependencies);
			labelOf.set(item.tld, item.label);
			rank.set(item.tld, index);
		}
	}
	offer.sort((a, b) => (rank.get(a.tld) ?? 0) - (rank.get(b.tld) ?? 0));
	console.log(
		JSON.stringify({
			core: CORE_HIERARCHIES.map((item) => item.tld),
			entries: offer.map((entry) => ({
				tld: entry.tld,
				name: entry.name,
				// The name the screen shows (and sorts by): `name` is the export-time pick.
				label: labelOf.get(entry.tld) ?? entry.name,
				typology_id: entry.typology_id,
				typology_name: entry.typology_name,
				has_data: entry.data_files.length > 0,
				dependencies: dependenciesOf.get(entry.tld) ?? [],
			})),
			suggestion: TOPONYMY_SUGGESTION,
			errors,
		}),
	);
	process.exit(errors.length === 0 ? 0 : 1);
}

if (invocation.listHierarchies) listHierarchies();

/** --list-langs: the language offer, then exit (constants only). */
function listLangs(): never {
	console.log(
		JSON.stringify({
			langs: Object.entries(INSTALL_LANG_CATALOG).map(([code, label]) => ({ code, label })),
			default: [...INSTALL_DEFAULT_LANG_CODES],
			errors: [...parseErrors],
		}),
	);
	process.exit(parseErrors.length === 0 ? 0 : 1);
}

if (invocation.listLangs) listLangs();

// ── running the executor ─────────────────────────────────────────────────────

/**
 * Every psql this process starts names itself `dedalo_install:<pid>` on the
 * server, so a later --resume can see an orphan of a killed run still working
 * (db_restore.ts inspectTargetDatabase) — and tell this run's own apart.
 */
function bootEnvironment(plan: InstallPlan): void {
	seedProcessEnv({ ...cliBootEnv(plan), PGAPPNAME: `dedalo_install:${process.pid}` });
}

/** The plan's notes, warnings and suggestions, as a reporter announces them. */
function announcementOf(plan: InstallPlan): RunAnnouncement {
	const { answers } = plan;
	return {
		title: `Dédalo TS install — entity '${answers.entity}', db '${answers.db_database}'`,
		notes: plan.notes,
		warnings: plan.warnings,
		suggestions: plan.suggestions,
	};
}

/**
 * THE PLAIN REPORTER (src/core/install/ui_plain/reporter.ts): a headless run's
 * salt goes to its own stdout when that is a terminal (campaign 3b C3-18).
 */
function plainReporter(prompter?: InstallPrompter): RunReporter {
	return plainRunReporter(prompter === undefined ? {} : { prompter });
}

/**
 * THE EVENTS REPORTER (--events-jsonl — the engine child of a host route):
 * every transcript line, step event and one-time line as ONE JSON line on
 * stdout, which the host parent relays (host/production/engine_delegate.ts).
 * The salt line is handed over as `show_once` and reported shown: the parent
 * owns the terminal (and records nothing of it).
 */
function eventsReporter(): RunReporter {
	const emit = (event: Record<string, unknown>) =>
		process.stdout.write(`${JSON.stringify(event)}\n`);
	return {
		io: {
			log: (line) => emit({ event: 'log', line }),
			warn: (line) => emit({ event: 'warn', line }),
			showOnce: (lines) => {
				emit({ event: 'show_once', lines });
				return true;
			},
			step: (event) => emit({ event: 'step', ...event }),
			// The host parent tells how to resume or undo — never this child's own command (C3-54).
			delegated: true,
		},
		announce: (announcement) => emit({ event: 'log', line: announcement.title }),
		finish: async (outcome) => {
			emit({ event: 'outcome', ...outcome });
		},
	};
}

/** The headless reporter: JSON lines for a host parent, else the plain transcript. */
function headlessReporter(): RunReporter {
	return invocation.eventsJsonl ? eventsReporter() : plainReporter();
}

/**
 * Where the answers of an interactive run refused after its typed yes are
 * kept (campaign 3c D2): the operator's own home (root's under sudo — the
 * rerun is sudo too), never the checkout (root never writes in it) nor the
 * private dir.
 */
function keptAnswersPath(): string {
	return join(userInfo().homedir, 'dedalo-install-answers.json');
}

/**
 * An interactive run refused after the typed yes — by the run's own system
 * check, or because the plan changed since the Review: the answers are KEPT
 * (front_end.ts keptAnswersLines) — one mechanism for every route (campaign
 * 3c D2). [] for a headless run (its answers are its command line).
 */
async function keptAnswers(plan: InstallPlan, interactive?: InteractiveRun): Promise<string[]> {
	if (interactive === undefined) return [];
	const { sameAsCommand } = await import('../src/core/install/screen_model.ts');
	return keptAnswersLines(
		plan.answers,
		interactive.writeAnswers ?? keptAnswersPath(),
		sameAsCommand,
	);
}

/**
 * Run the executor and leave with its exit code, the reporter telling the
 * outcome. `keep` is REQUIRED (undefined for a resume/abort, whose answers are
 * the record's): a fresh run's caller cannot drop the kept answers of a
 * refusal by omission — tsc refuses it (campaign 3c D2 wiring).
 */
async function execute(
	request: import('../src/core/install/executor.ts').ExecutorRequest,
	reporter: RunReporter,
	keep: (() => Promise<string[]>) | undefined,
): Promise<never> {
	const { executeInstall } = await import('../src/core/install/executor.ts');
	const outcome = await withKeptAnswers(await executeInstall(request, reporter.io), keep);
	cleanupCatalog();
	const rootVerified = (request.secrets.root_password ?? '') !== '';
	// An --engine-only run (the by-hand host procedure) ends with the systemd pointer only (C3-54).
	const engineOnly = normalizeInstallAnswers(raw).answers.engine_only;
	// The developer route's closing block (TODO-053): the command, the URLs and the
	// certificate, read back from the .env the run WROTE — null when it opens no listener.
	const served =
		outcome.exitCode === 0 && outcome.result !== 'aborted' && !engineOnly
			? await (await import('../src/core/install/dev_serve.ts')).devServedView()
			: null;
	await reporter.finish(outcome, {
		mode: request.mode,
		rootVerified,
		ending: {
			route: engineOnly ? 'engine_only' : 'engine',
			instance: '',
			keptLive: false,
			undone: [],
			...(served === null ? {} : { served }),
		},
	});
	process.exit(outcome.exitCode);
}

/** The steps a run will go through, with their labels (the reporter's Install screen). */
async function beginSteps(reporter: RunReporter, planFile: PlanFile): Promise<void> {
	if (reporter.begin === undefined) return;
	const { INSTALL_STEPS } = await import('../src/core/install/steps.ts');
	const { hostTable } = await import('../src/core/install/host/host_table.ts');
	// Labels only: the host table's digest context is never asked for.
	const host = hostTable(() => fail('no plan context for labels'));
	reporter.begin(
		planFile.steps.map((id) => ({
			id,
			label: isInstallStepId(id) ? INSTALL_STEPS[id].label(planFile) : host[id].label(planFile),
		})),
	);
}

// ── the host routes (phase 4) ────────────────────────────────────────────────

/** Does this plan run HOST steps (a host route that is not the delegated engine child)? */
function hostPlanned(answers: InstallAnswers): boolean {
	return !answers.engine_only && answers.route !== 'developer';
}

/**
 * Run the host executor and leave with its exit code. Its told lines (the
 * firewall, modules, the outside check, the salt's read command) are the
 * reporter's closing To-do — every front end's (campaign 3c D5).
 */
async function executeHost(
	request: import('../src/core/install/host/host_executor.ts').HostExecutorRequest,
	reporter: RunReporter,
	keep: (() => Promise<string[]>) | undefined,
): Promise<never> {
	const { executeHostInstall } = await import('../src/core/install/host/host_executor.ts');
	const outcome = await withKeptAnswers(await executeHostInstall(request, reporter.io), keep);
	cleanupCatalog();
	const answers = request.planFile?.answers ?? request.givenAnswers ?? {};
	const route =
		answers.route === 'production' || answers.route === 'trial' ? answers.route : 'docker';
	await reporter.finish(outcome, {
		mode: request.mode,
		rootVerified: false,
		ending: {
			route,
			instance: String(answers.instance ?? ''),
			keptLive: outcome.keptLive,
			undone: outcome.undone,
			told: outcome.exitCode === 0 ? outcome.told : [],
		},
	});
	process.exit(outcome.exitCode);
}

/**
 * The catalog of a HOST run, resolved in the PROBE CHILD (this process stays
 * config-free: the engine's catalog resolver imports the configuration).
 */
async function hostCatalog(
	answersRaw: Record<string, unknown>,
): Promise<{ catalog: OntologyCatalog | undefined; errors: string[] }> {
	const { answers } = normalizeInstallAnswers(answersRaw);
	if (!planCatalogNeeded(answers, ontologySourceFor(answers, {})))
		return { catalog: undefined, errors: [] };
	const { childProbes } = await import('../src/core/install/install_probe_client.ts');
	const probes = childProbes({ execPath: process.execPath, cwd: process.cwd() });
	const result = await probes.ontologyCatalog(answersRaw, {});
	return result.ok && result.catalog !== null
		? { catalog: result.catalog, errors: [] }
		: { catalog: undefined, errors: [result.detail] };
}

/** A host route's FRESH run: the plan (config-free), its record, the host executor. */
async function hostFreshInstall(
	reporter: RunReporter,
	interactive?: InteractiveRun,
): Promise<never> {
	const resolved = await hostCatalog(raw);
	const plan = buildInstallPlan(raw, {
		priorEnv: {},
		ontologyCatalog: resolved.catalog,
		rootPassword: secrets.root_password,
		requireRootPassword: true,
	});
	const errors = [...parseErrors, ...resolved.errors, ...plan.errors];
	const changed =
		interactive === undefined || errors.length > 0
			? null
			: reviewedDecisionsRefusal(interactive.reviewed, plan);
	if (changed !== null) errors.push(changed);
	if (errors.length === 0)
		writeAnswersOrFail(interactive?.writeAnswers ?? invocation.writeAnswersPath, plan);
	if (errors.length > 0) fail(errors.join('; '), await keptAnswers(plan, interactive));
	reporter.announce(announcementOf(plan));
	const planFile = buildPlanFile(plan, secrets);
	await beginSteps(reporter, planFile);
	return executeHost(
		{
			mode: 'fresh',
			execute: runConfirmed(invocation.execute, interactive !== undefined),
			planFile,
			secrets,
		},
		reporter,
		() => keptAnswers(plan, interactive),
	);
}

/** A host route's --resume / --abort: the record under the host run dir the route and instance name. */
async function hostContinue(request: ContinueRequest, given: InstallAnswers): Promise<never> {
	const { hostResumeSecrets, readHostRecord } = await import(
		'../src/core/install/host/host_executor.ts'
	);
	const record = readHostRecord(given);
	if (record === null)
		fail(
			`no install record for the ${given.route} route${given.instance === '' ? '' : ` instance '${given.instance}'`}`,
		);
	if (request.mode === 'resume') {
		// Only what a remaining step still needs — the engine child is asked (C3-51); asked
		// only when this run may prompt at all (the child's answer costs a process).
		if (canPromptSecrets())
			await promptSecrets(await hostResumeSecrets(given), secrets, request.prompter, false);
		request.reporter.prepare?.();
	}
	await beginSteps(request.reporter, record.plan);
	return executeHost(
		{
			mode: request.mode,
			execute: runConfirmed(invocation.execute, request.prompter !== undefined),
			givenAnswers: given,
			givenKeys: Object.keys(plainRaw),
			secrets,
			...(request.confirmDatabase === undefined
				? {}
				: { confirmDatabase: request.confirmDatabase }),
		},
		request.reporter,
		undefined,
	);
}

// ── prompting for a missing secret (a terminal, no --execute) ────────────────

/** May this run ASK for a missing secret? A terminal, not --execute, not a print-and-exit run. */
function canPromptSecrets(): boolean {
	return (
		!invocation.execute &&
		!invocation.planOnly &&
		process.stdin.isTTY === true &&
		typeof process.stdin.setRawMode === 'function'
	);
}

/** The prompt sink of a headless run (the same rule as the interactive one: never a redirected stdout). */
function promptOutput(): { isTTY?: boolean; write(text: string): unknown } | null {
	if (process.stdout.isTTY === true) return process.stdout;
	if (process.stderr.isTTY === true) return process.stderr;
	try {
		const fd = openSync('/dev/tty', 'w');
		return { isTTY: true, write: (text: string) => writeSync(fd, text) };
	} catch {
		return null;
	}
}

/** The words a prompt for each secret uses. */
const SECRET_PROMPT: Readonly<Record<SecretKey, string>> = {
	db_password: 'Database password',
	mysql_password: 'MariaDB (publication) password',
	smtp_pass: 'SMTP password',
	root_password: 'Root password',
};

/** The plain prompter a headless run asks a missing secret on, or null (no terminal sink). */
async function headlessPrompter(): Promise<InstallPrompter | null> {
	const output = promptOutput();
	if (output === null) return null;
	const { ttyInstallPrompter } = await import('../src/core/install/ui_plain/prompter.ts');
	return ttyInstallPrompter(
		{ input: process.stdin, output, signals: process },
		{ columns: process.stdout.columns },
	);
}

/**
 * Ask the missing `keys` on the terminal (the root password held to the policy,
 * rule by rule; hidden, and twice unless `confirm` is false — a resume asks a
 * password the install already set, once) — on the interactive session's
 * prompter when there is one (the full-screen UI asks a resume's secrets
 * itself). Nothing is asked when the run may not prompt.
 */
async function promptSecrets(
	keys: readonly SecretKey[],
	into: Secrets,
	given?: InstallPrompter,
	confirm = true,
): Promise<void> {
	const missing = keys.filter((key) => (into[key] ?? '') === '');
	if (missing.length === 0 || !canPromptSecrets()) return;
	const prompter = given ?? (await headlessPrompter());
	if (prompter === null) return;
	const { isNav } = await import('../src/core/install/prompter_contract.ts');
	const { passwordFeedback } = await import('../src/core/install/screen_model.ts');
	for (const key of missing) {
		const answer = await prompter.secret(
			{
				id: `secret.${key}`,
				key,
				sets: [],
				kind: 'secret',
				label: SECRET_PROMPT[key],
				description: 'never echoed, never written to the plan file or the log',
				value: null,
				default: '',
				answered: false,
				required: true,
				errors: [],
			},
			key === 'root_password' ? passwordFeedback : undefined,
			{ confirm },
		);
		if (isNav(answer)) fail('stopped at the password prompt — nothing was written');
		into[key] = answer;
	}
}

/** Write the answers file (--write-answers, or the interactive Review's choice), or fail. */
function writeAnswersOrFail(path: string | undefined, plan: InstallPlan): void {
	if (path === undefined) return;
	const refusal = writeAnswersFile(path, plan.answers);
	if (refusal !== null) fail(refusal);
	// stderr: --plan's stdout is exactly ONE JSON line.
	console.error(`  answers written to ${path} (no secret is in it)`);
}

/** What an interactive run adds to a fresh install. */
interface InteractiveRun {
	/** The decisions the operator reviewed — the run refuses to decide otherwise. */
	reviewed: ReviewedDecisions;
	writeAnswers?: string;
	/** The front end's side of the run (the full-screen UI, or the plain one). */
	reporter: RunReporter;
}

/**
 * `--plan --route production`: the preflight's read-only measurements of THIS
 * host (the OS, the service account and folder, the names, the certificate) —
 * the refusals a run would stop on, reported before anything is written
 * (campaign 3 C3-25). Only over valid answers.
 */
async function productionPlanChecks(
	plan: InstallPlan,
	errors: readonly string[],
): Promise<{ errors: string[]; warnings: string[] }> {
	if (errors.length > 0 || !hostPlanned(plan.answers) || plan.answers.route !== 'production') {
		return { errors: [], warnings: [] };
	}
	const { hostPlanRefusals } = await import('../src/core/install/host/host_executor.ts');
	return hostPlanRefusals(buildPlanFile(plan, secrets));
}

/** A FRESH install (or --plan). */
async function freshInstall(interactive?: InteractiveRun): Promise<never> {
	const reporter = interactive?.reporter ?? headlessReporter();
	if (interactive === undefined && !invocation.planOnly) {
		// A refused flag combination (or any parse error) is refused BEFORE the first prompt.
		if (parseErrors.length > 0) fail(parseErrors.join('; '));
		await promptSecrets(['root_password'], secrets);
	}
	// A HOST route (phase 4): its own config-free path — never the engine environment here.
	if (hostPlanned(normalizeInstallAnswers(raw).answers) && !invocation.planOnly) {
		return hostFreshInstall(reporter, interactive);
	}
	// The answers alone (no catalog yet): enough for the boot environment.
	const preliminary = buildInstallPlan(raw, { priorEnv });
	const answerErrors = [...parseErrors, ...normalizeInstallAnswers(raw).errors];
	// Seed the environment BEFORE anything imports config (see the header) — the
	// catalog resolver below is the first thing that does.
	if (answerErrors.length === 0) bootEnvironment(preliminary);
	// The ontology catalog, resolved ONCE (a server manifest is fetched here, before
	// any write): the plan's closure, the .env and the staging all use it.
	const resolvedCatalog = await resolveCatalogOf(raw, priorEnv);
	const plan = buildInstallPlan(raw, {
		priorEnv,
		ontologyCatalog: resolvedCatalog.catalog,
		// --plan checks a supplied password; a run requires one.
		rootPassword: secrets.root_password,
		requireRootPassword: !invocation.planOnly,
	});
	const errors = [...parseErrors, ...resolvedCatalog.errors, ...plan.errors];
	// The interactive Review was built on the probe child's catalog; this run
	// re-resolved it — the decisions must be the reviewed ones.
	const changed =
		interactive === undefined || errors.length > 0
			? null
			: reviewedDecisionsRefusal(interactive.reviewed, plan);
	if (changed !== null) errors.push(changed);
	// --write-answers: after a VALID plan, before anything runs (--plan included).
	if (errors.length === 0) {
		writeAnswersOrFail(interactive?.writeAnswers ?? invocation.writeAnswersPath, plan);
	}

	if (invocation.planOnly) {
		cleanupCatalog();
		const host = await productionPlanChecks(plan, errors);
		errors.push(...host.errors);
		console.log(
			JSON.stringify({
				env_keys: [...plan.envKeys],
				steps: [...plan.steps],
				hierarchies: [...plan.hierarchies],
				hierarchy_dependencies: [...plan.hierarchyDependencies],
				suggestions: [...plan.suggestions],
				ontologies: [...plan.ontologies],
				declined_dependencies: [...plan.answers.declined_dependencies],
				ontology_source: plan.ontologySource,
				ontology_install: (plan.ontologyRequest?.items ?? []).map((item) => item.tld),
				active_ontology_tlds: [...plan.activeOntologyTlds],
				notes: [...plan.notes],
				warnings: [...plan.warnings, ...host.warnings],
				errors,
			}),
		);
		process.exit(errors.length === 0 ? 0 : 1);
	}

	if (errors.length > 0) fail(errors.join('; '), await keptAnswers(plan, interactive));
	reporter.announce(announcementOf(plan));
	const planFile = buildPlanFile(plan, secrets);
	await beginSteps(reporter, planFile);
	return execute(
		{
			mode: 'fresh',
			execute: runConfirmed(invocation.execute, interactive !== undefined),
			planFile,
			plan,
			secrets,
			ontologyCatalog: resolvedCatalog.catalog,
		},
		reporter,
		() => keptAnswers(plan, interactive),
	);
}

/** Has the saved state recorded `step` done? */
function stepDone(state: ReturnType<typeof readStateFile>, step: string): boolean {
	return state?.steps[step]?.status === 'done';
}

/**
 * The secrets a resume/abort runs with: the given ones, and — once
 * persist_config is done — the db/mysql/smtp ones the install's own .env holds
 * (a supplied database password that differs from it is refused).
 */
function resumeSecrets(planFile: PlanFile, state: ReturnType<typeof readStateFile>): Secrets {
	if (!stepDone(state, 'persist_config')) return secrets;
	const env = readInstallEnv();
	if (env === null)
		fail(
			`persist_config is recorded done but the install .env is missing — put it back (it holds the generated salt), then --resume; ${ABORT_AND_START_AGAIN}`,
		);
	const written = secretsFromEnv(env);
	const given = secrets.db_password;
	if (
		given !== undefined &&
		planFile.secrets_supplied.db_password &&
		given !== (written.db_password ?? '')
	) {
		fail('the database password given differs from the one this install wrote to its .env');
	}
	return {
		...written,
		...(secrets.root_password === undefined ? {} : { root_password: secrets.root_password }),
	};
}

/** How a resume / abort is continued (the CLI's flags, or the interactive Resume screen). */
interface ContinueRequest {
	mode: 'resume' | 'abort';
	/** abort: the database name typed back (the executor compares it). */
	confirmDatabase?: string;
	/** The interactive session's prompter (a resume's missing secrets are asked on it). */
	prompter?: InstallPrompter;
	reporter: RunReporter;
}

/** `--resume` / `--abort` (or the interactive Resume screen): the SAVED plan is the authority. */
async function continueInstall(request: ContinueRequest): Promise<never> {
	const abort = request.mode === 'abort';
	if (parseErrors.length > 0) fail(parseErrors.join('; '));
	const given = normalizeInstallAnswers(raw).answers;
	if (hostPlanned(given)) return hostContinue(request, given);
	let planFile: PlanFile | null;
	let state: ReturnType<typeof readStateFile>;
	try {
		planFile = readPlanFile();
		state = readStateFile();
	} catch (error) {
		return fail((error as Error).message);
	}
	if (planFile === null || state === null) {
		return fail(
			'no install record to continue (no install.plan.json / install.state.json in the private dir)',
		);
	}
	const runSecrets = resumeSecrets(planFile, state);
	// The config-free step table (importing the executor here would freeze
	// config BEFORE bootEnvironment seeds the install's database).
	const { secretsNeeded, abortNeedsDatabasePassword } = await import(
		'../src/core/install/steps.ts'
	);
	// On a terminal (no --execute) a resume ASKS the secrets it still needs.
	if (!abort) {
		await promptSecrets(secretsNeeded(planFile, state), runSecrets, request.prompter);
		request.reporter.prepare?.();
	}
	if (abort && abortNeedsDatabasePassword(planFile, state, runSecrets)) {
		fail(
			'--abort resets the database and needs its password: DEDALO_INSTALL_DB_PASSWORD or --secrets-stdin',
		);
	}
	// The boot environment from the SAVED answers (+ the secrets).
	const savedRaw = withSecrets({ ...planFile.answers }, runSecrets);
	const prior = await readPriorEnv();
	bootEnvironment(buildInstallPlan(savedRaw, { priorEnv: prior }));
	// Answers on the command line must be the saved ones (compared in the executor).
	// Only the keys the operator SUPPLIED are compared (an omitted one is not "different").
	const givenKeys = Object.keys(plainRaw);
	const givenAnswers = givenKeys.length > 0 ? normalizeInstallAnswers(raw).answers : undefined;
	if (abort) {
		request.reporter.prepare?.();
		await beginSteps(request.reporter, planFile);
		return execute(
			{
				mode: 'abort',
				execute: runConfirmed(invocation.execute, request.prompter !== undefined),
				secrets: runSecrets,
				confirmDatabase: request.confirmDatabase,
				unservedAttested: stdinPart.unserved,
			},
			request.reporter,
			undefined,
		);
	}
	// The catalog is re-resolved only while a step that needs it is not done;
	// the executor then holds the rebuilt plan's decisions to the saved ones.
	const needsCatalog = !stepDone(state, 'persist_config') || !stepDone(state, 'stage_ontologies');
	let plan: InstallPlan | undefined;
	let catalog: OntologyCatalog | undefined;
	if (needsCatalog) {
		const resolved = await resolveCatalogOf(savedRaw, prior);
		if (resolved.errors.length > 0) fail(resolved.errors.join('; '));
		catalog = resolved.catalog;
		plan = buildInstallPlan(savedRaw, { priorEnv: prior, ontologyCatalog: catalog });
		if (plan.errors.length > 0) fail(plan.errors.join('; '));
	}
	request.reporter.announce({
		title: `Dédalo TS install — resuming '${String(planFile.answers.db_database ?? '')}'`,
		notes: [],
		warnings: [],
		suggestions: [],
	});
	await beginSteps(request.reporter, planFile);
	return execute(
		{
			mode: 'resume',
			execute: runConfirmed(invocation.execute, request.prompter !== undefined),
			givenAnswers,
			givenKeys,
			plan,
			secrets: runSecrets,
			ontologyCatalog: catalog,
		},
		request.reporter,
		undefined,
	);
}

// ── the interactive front end ────────────────────────────────────────────────

/** The prompt sink the selection chose (stdout, stderr, or /dev/tty). */
function interactiveOutput(sink: 'stdout' | 'stderr' | 'tty'): {
	isTTY?: boolean;
	write(text: string): unknown;
} {
	if (sink === 'stdout') return process.stdout;
	if (sink === 'stderr') return process.stderr;
	const output = promptOutput();
	if (output === null) fail('no terminal to show the questions on');
	return output;
}

/** The thesaurus offer the screens show (config-free: the vendored manifest). */
function thesaurusOffer(): { view: ReturnType<typeof hierarchyChoiceView> } | { error: string } {
	try {
		return { view: hierarchyChoiceView('lg-eng') };
	} catch (error) {
		return { error: (error as Error).message };
	}
}

/**
 * OpenTUI's own debug switches, read straight from the environment: one of
 * them appends every raw stdin byte (a typed password) to a file, others keep
 * key logs or redirect the screen. Cleared before the UI loads — the
 * installer's terminal is never anyone else's to configure.
 */
const OPENTUI_ENV = /^(OTUI_|SHOW_CONSOLE$)/;

function clearOpenTuiEnv(): void {
	unsetProcessEnv(Object.keys(liveProcessEnv()).filter((key) => OPENTUI_ENV.test(key)));
}

/** The probe children alive now (the full-screen UI kills them when it closes). */
const probeChildren = new Set<{
	kill(signal?: number | NodeJS.Signals): void;
	exited: Promise<number>;
}>();

/** The full-screen UI when it can be drawn; null (one line saying why) when it cannot. */
async function openTuiFront(): Promise<
	import('../src/core/install/tui_loader.ts').TuiFrontEnd | null
> {
	clearOpenTuiEnv();
	const { openFullScreen } = await import('../src/core/install/tui_loader.ts');
	const { installerVersionLabel } = await import('../src/core/install/installer_identity.ts');
	const opened = await openFullScreen({
		stdin: process.stdin,
		stdout: process.stdout,
		noColor: terminalCaps().noColor,
		// The header names the release identity and its kind (`7.0.0-beta.7 (prerelease)`).
		version: installerVersionLabel(),
	});
	if (opened.kind === 'tui') return opened.front;
	process.stderr.write(
		`full-screen UI unavailable (${opened.reason}) — continuing in plain mode\n`,
	);
	return null;
}

/** The exit code of a session that ended without installing. */
function quitCode(reason: string | undefined): number {
	if (reason === 'interrupted') return 130;
	return reason === 'refused' ? 1 : 0;
}

/**
 * Leave: through the full-screen UI when it is up (the terminal restored
 * first, then `lines` printed); the plain mode prints the same closing lines
 * itself (campaign 3c D21: a plain `quit` ended with none).
 */
async function leave(code: number, lines: readonly string[] = []): Promise<never> {
	if (activeUi !== null) return activeUi.close(code, lines);
	for (const line of lines) console.log(line);
	return process.exit(code);
}

/** The main-screen line after a quit: an unfinished install (its state file) is KEPT, never "nothing". */
function quitNotice(): string[] {
	let unfinished: boolean;
	try {
		unfinished = readStateFile() !== null;
	} catch {
		unfinished = true;
	}
	return [
		unfinished
			? 'the unfinished install is kept — run the installer again to resume or abort it'
			: 'nothing was installed',
	];
}

/** The session's outcome, acted on. */
async function actOn(
	result: FrontEndResult,
	prompter: InstallPrompter,
	reporter: RunReporter,
): Promise<never> {
	if (result.kind === 'resume' || result.kind === 'abort') {
		if (result.kind === 'abort' && result.secrets.db_password !== undefined) {
			secrets.db_password = result.secrets.db_password;
		}
		// No prepare here: a resume first asks the secrets it still needs ON the
		// walk's screens (continueInstall enters the run once they are in).
		return continueInstall({
			mode: result.kind,
			...(result.kind === 'abort' ? { confirmDatabase: result.confirmDatabase } : {}),
			prompter,
			reporter,
		});
	}
	if (result.kind === 'quit') {
		return leave(quitCode(result.reason), [...quitNotice(), ...(result.notices ?? [])]);
	}
	if (result.kind === 'written') {
		return activeUi === null ? process.exit(0) : activeUi.written(result.path);
	}
	// REPLACE, never merge: a secret the environment supplied for a service the
	// operator then turned off (or cleared) is not in result.secrets (givenOnly)
	// and must not be recorded as supplied nor used.
	for (const key of SECRET_KEYS) delete secrets[key];
	Object.assign(secrets, result.secrets);
	raw = withSecrets(result.raw, secrets);
	reporter.prepare?.();
	return freshInstall({
		reviewed: result.reviewed,
		reporter,
		...(result.writeAnswers === undefined ? {} : { writeAnswers: result.writeAnswers }),
	});
}

/**
 * Walk the screens — on the full-screen UI when the terminal can draw it, in
 * plain line mode otherwise — then act on the outcome.
 */
async function interactiveInstall(
	choice: Extract<FrontEndChoice, { kind: 'interactive' }>,
): Promise<never> {
	const { runInteractiveInstall } = await import('../src/core/install/install_session.ts');
	const { childProbes } = await import('../src/core/install/install_probe_client.ts');
	const { installerVersionLabel } = await import('../src/core/install/installer_identity.ts');
	activeUi = choice.ui === 'tui' ? await openTuiFront() : null;
	let prompter: InstallPrompter;
	let reporter: RunReporter;
	if (activeUi !== null) {
		prompter = activeUi.prompter;
		reporter = activeUi.reporter;
		activeUi.onClose(() => {
			for (const child of probeChildren) child.kill('SIGKILL');
		});
	} else {
		const { ttyInstallPrompter } = await import('../src/core/install/ui_plain/prompter.ts');
		prompter = ttyInstallPrompter(
			{ input: process.stdin, output: interactiveOutput(choice.sink), signals: process },
			{ columns: process.stdout.columns ?? process.stderr.columns },
		);
		reporter = plainReporter(prompter);
	}
	// The host's own zone and locale (TZ / LC_ALL / LANG — C3-21): the same
	// values the plan defaults to, so the screen and the plan never disagree.
	const { hostLocaleDefaults } = await import('../src/core/install/install_validation.ts');
	const host = hostLocaleDefaults();
	const result = await runInteractiveInstall({
		prompter,
		probes: childProbes({
			execPath: process.execPath,
			cwd: process.cwd(),
			onSpawn: (child) => {
				probeChildren.add(child);
				void child.exited.then(() => probeChildren.delete(child));
			},
		}),
		priorEnv,
		thesauri: thesaurusOffer(),
		host: { timezone: host.timezone, locale: host.locale },
		givenSecrets: { ...secrets },
		version: installerVersionLabel(),
		// Both hooks of one Review build share `measure`: the registry is asked once (C3i-F2).
		hostCommands: async (plan, measure) => {
			if (!hostPlanned(plan.answers)) return [];
			const { reviewHostCommands } = await import('../src/core/install/host/review.ts');
			return reviewHostCommands(plan, measure);
		},
		// What the run's own system check would refuse, asked BEFORE `yes` (campaign 3c D2).
		// The developer listener's port too (D3): the Review refuses while it is in use —
		// a running server on its unix socket, and a local authority already there for
		// other names (dev_tls.ts).
		preflightRefusals: async (plan, measure) => {
			const { reviewPreflightRefusals } = await import('../src/core/install/host/review.ts');
			const { devListenerRefusals } = await import('../src/core/install/dev_listener_check.ts');
			return [
				...(await reviewPreflightRefusals(plan, { measure })),
				...(await devListenerRefusals(plan.devListener, plan.devCertificate)),
			];
		},
		routeRefusal: (plan) =>
			plan.answers.route === 'production' &&
			process.geteuid?.() !== 0 &&
			(processEnvValue('DEDALO_INSTALL_HOST_ROOT') ?? '') === ''
				? 'the production route runs as root: quit, then sudo sh install.sh (the same arguments)'
				: null,
		...(invocation.writeAnswersPath === undefined
			? {}
			: { writeAnswersPath: invocation.writeAnswersPath }),
	} satisfies CliInteractiveDeps);
	return actOn(result, prompter, reporter);
}

if (frontEnd.kind === 'interactive') await interactiveInstall(frontEnd);
else if (invocation.resume || invocation.abort) {
	await continueInstall({
		mode: invocation.abort ? 'abort' : 'resume',
		...(invocation.confirmDatabase === undefined
			? {}
			: { confirmDatabase: invocation.confirmDatabase }),
		reporter: headlessReporter(),
	});
} else await freshInstall();
