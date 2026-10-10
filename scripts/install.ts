/**
 * TS-NATIVE INSTALL CLI (DEC-19) — headless, unattended install of a fresh
 * Dédalo instance with no PHP anywhere. A FRONT END of the install plan
 * (src/core/install/install_plan.ts): the flags become the same answers the
 * browser wizard posts, the plan turns them into the .env and the step list,
 * and this script runs those steps through the SAME engine the wizard routes
 * (src/core/install/), then verifies an actual root login. install.sh drives
 * this script; it carries no install logic of its own either.
 *
 * The one subtlety: `config` freezes at import from the environment. So the
 * plan is built first (config-free), its boot environment is seeded into the
 * process (cliBootEnv), and only THEN is the engine imported — config then
 * resolves the REAL values (not install-mode sentinels), the pool points at the
 * target DB, and no restart is needed.
 *
 * Usage (npm script `dedalo:install` — NOT `install`, which is a reserved
 * package-manager lifecycle hook):
 *   bun run scripts/install.ts --db-name dedalo_x --db-user u --entity myentity \
 *       --root-password '...' [--db-host localhost] [--db-port 5432] [--db-socket ...] \
 *       [--db-password ...] [--entity-label ...] [--information ...] [--info-key ...] \
 *       [--timezone Europe/Madrid] [--locale es-ES] \
 *       [--langs lg-eng,lg-spa] [--app-lang lg-eng] [--data-lang lg-eng] \
 *       [--hierarchies es,fr | default | none] \
 *       [--ontologies oh,tch | default] [--ontology-source <dir|archive>] \
 *       [--decline-dependencies tchi,ts:hierarchy1] \
 *       [--diffusion --mysql-host ... --mysql-port ... --mysql-socket ... \
 *          --mysql-name ... --mysql-user ... --mysql-password ...] \
 *       [--mailer --smtp-host smtp.example.org --smtp-port 587 --smtp-secure tls \
 *          --smtp-user ... --smtp-password ... --smtp-from ... --smtp-from-name ...] \
 *       [--media-path /srv/dedalo/media] [--socket /run/dedalo/dedalo_ts.sock] \
 *       [--media-access-mode publication] \
 *       [--no-update-servers] [--skip-tools] [--plan] [--list-ontologies] [--list-hierarchies]
 *
 * Defaults live in the plan, not here: --hierarchies omitted (or `default`) =
 * NO optional thesaurus beyond the ones the chosen ontologies DECLARE
 * (hierarchy60 — the same boxes the wizard pre-ticks; 2026-10-10). The offer is
 * every entry of the vendored thesaurus manifest (install/import/hierarchy/
 * hierarchy.json), with or without data files (one without installs as an empty
 * thesaurus). No toponymy is ever a default: a plan without one prints a
 * SUGGESTION to import the operator's own country. Languages (lg) is ALWAYS
 * activated by the seed restore and is not a choice. The official update server is written unless --no-update-servers
 * (air-gapped: ONTOLOGY_SERVERS / CODE_SERVERS = []). An unknown flag is an
 * error, never ignored.
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
 * recommended, installable later from Maintenance › Install hierarchies. The catalog is resolved ONCE, before anything is written; the files
 * are staged and verified before the database is touched (stage_ontologies) and
 * imported right after the seed restore (install_ontologies).
 *
 * --plan prints ONE JSON line (env_keys, steps, hierarchies,
 * hierarchy_dependencies, suggestions, ontologies, declined_dependencies, ontology_source,
 * ontology_install, active_ontology_tlds, notes, warnings,
 * errors) and exits — 0 when the answers are valid, 1 otherwise — touching no
 * database and no file (a non-vendored choice reads the source's manifest), no
 * root password needed.
 *
 * --list-ontologies prints ONE JSON line — the catalog view the wizard's
 * Ontologies screen shows (source, default, core, entries with their declared
 * dependencies and what each also installs, warnings) + errors — for the source
 * the other answers select (--ontology-source, --no-update-servers, or the
 * configured server), and exits. It needs no other answer.
 *
 * --list-hierarchies prints ONE JSON line — the thesaurus offer of the vendored
 * manifest (core, typologies, entries {tld, name, typology_id, typology_name,
 * has_data}, the toponymy suggestion) + errors — and exits. It needs no other
 * answer.
 *
 * Secrets: --root-password or DEDALO_INSTALL_ROOT_PASSWORD (never echoed).
 */

// All config-free — safe to import BEFORE the environment is seeded.
import { processEnvValue, seedProcessEnv } from '../src/config/env.ts';
import { CORE_HIERARCHIES } from '../src/core/install/hierarchy_meta.ts';
import {
	answersFromCliArgs,
	buildInstallPlan,
	cliBootEnv,
	type InstallPlan,
	type InstallStepId,
	normalizeInstallAnswers,
	offeredThesauri,
	ontologyServersFor,
	ontologySourceFor,
	planCatalogNeeded,
	TOPONYMY_SUGGESTION,
} from '../src/core/install/install_plan.ts';
import {
	describeOntologyCatalog,
	type OntologyCatalog,
	vendoredOntologyCatalog,
} from '../src/core/install/ontology_choice.ts';
import { readPriorEnv } from '../src/core/install/prior_env.ts';

/** Removes the resolved catalog's scratch files (an extracted --ontology-source archive). */
let cleanupCatalog: () => void = () => undefined;

function fail(msg: string): never {
	cleanupCatalog();
	console.error(`\n✖ install failed: ${msg}\n`);
	process.exit(1);
}

const invocation = answersFromCliArgs(Bun.argv.slice(2));
const priorEnv = await readPriorEnv();

/**
 * Resolve the source catalog of `answers` (it imports the engine, so call it only
 * after the environment is seeded — or when the process exits right after).
 */
async function resolveCatalogOf(
	raw: Record<string, unknown>,
): Promise<{ catalog: OntologyCatalog | undefined; errors: string[] }> {
	const { answers } = normalizeInstallAnswers(raw);
	const source = ontologySourceFor(answers, priorEnv);
	if (!planCatalogNeeded(answers, source)) return { catalog: undefined, errors: [] };
	const { resolveOntologyCatalog } = await import('../src/core/install/ontology_catalog.ts');
	try {
		const resolved = await resolveOntologyCatalog(source, {
			allowedServers: ontologyServersFor(answers, priorEnv),
		});
		cleanupCatalog = resolved.cleanup;
		return { catalog: resolved.catalog, errors: [] };
	} catch (error) {
		return { catalog: undefined, errors: [error instanceof Error ? error.message : String(error)] };
	}
}

/** --list-ontologies: the catalog view of the selected source, then exit. */
async function listOntologies(): Promise<never> {
	const { answers } = normalizeInstallAnswers(invocation.raw);
	const source = ontologySourceFor(answers, priorEnv);
	const { resolveOntologyCatalog } = await import('../src/core/install/ontology_catalog.ts');
	const errors = [...invocation.errors];
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
	const errors = [...invocation.errors];
	const offer = offeredThesauri(errors);
	console.log(
		JSON.stringify({
			core: CORE_HIERARCHIES.map((item) => item.tld),
			entries: offer.map((entry) => ({
				tld: entry.tld,
				name: entry.name,
				typology_id: entry.typology_id,
				typology_name: entry.typology_name,
				has_data: entry.data_files.length > 0,
			})),
			suggestion: TOPONYMY_SUGGESTION,
			errors,
		}),
	);
	process.exit(errors.length === 0 ? 0 : 1);
}

if (invocation.listHierarchies) listHierarchies();

// The answers alone (no catalog yet): enough for the boot environment.
const preliminary = buildInstallPlan(invocation.raw, { priorEnv });
const answerErrors = [...invocation.errors, ...normalizeInstallAnswers(invocation.raw).errors];
// Seed the environment BEFORE anything imports config (see the header) — the
// catalog resolver below is the first thing that does.
if (answerErrors.length === 0) seedProcessEnv(cliBootEnv(preliminary));
// The ontology catalog, resolved ONCE (a server manifest is fetched here, before
// any write): the plan's closure, the .env and the staging all use it.
const resolvedCatalog = await resolveCatalogOf(invocation.raw);
const plan = buildInstallPlan(invocation.raw, {
	priorEnv,
	ontologyCatalog: resolvedCatalog.catalog,
});
const errors = [...invocation.errors, ...resolvedCatalog.errors, ...plan.errors];

if (invocation.planOnly) {
	cleanupCatalog();
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
			warnings: [...plan.warnings],
			errors,
		}),
	);
	process.exit(errors.length === 0 ? 0 : 1);
}

if (errors.length > 0) fail(errors.join('; '));
const rootPassword = invocation.rootPassword ?? processEnvValue('DEDALO_INSTALL_ROOT_PASSWORD');
if (!rootPassword) fail('--root-password (or DEDALO_INSTALL_ROOT_PASSWORD) is required');

/** The engine's step functions take the wizard's posted record — the plan's answers ARE it. */
const posted: Record<string, unknown> = { ...plan.answers };

/** The installed thesauri declared mandatory (strongly recommended — declinable with a warning). */
function requiredThesauriText(): string {
	const required = plan.hierarchyDependencies
		.filter((item) => item.mandatory && plan.hierarchies.includes(item.tld))
		.map((item) => item.tld);
	return required.length === 0
		? ''
		: ` (strongly recommended by the declarations: ${required.join(', ')})`;
}

/** Human text for each step line (`→ [<step id>] <text>`). */
const STEP_TEXT: Readonly<Record<InstallStepId, string>> = {
	test_db_connection: 'database connection',
	test_diffusion_connection: 'diffusion (MariaDB) connection',
	test_mailer_connection: 'SMTP connection',
	persist_config: 'write ../private/.env',
	check_directories: 'directories',
	stage_ontologies: `ontology files: ${(plan.ontologyRequest?.items ?? []).map((item) => item.tld).join(', ')} (fetched + verified before the database is touched)`,
	install_db_from_default_file: 'restore database from seed (+ activate core hierarchies)',
	install_ontologies: `domain ontologies: ${(plan.ontologyRequest?.items ?? []).map((item) => item.tld).join(', ')}`,
	set_root_pw: 'set root password',
	install_hierarchies: `hierarchies: ${plan.hierarchies.join(', ') || 'none'}${requiredThesauriText()}`,
	register_tools: 'register tools',
	install_finish: 'seal install',
};

async function stepDbConnection(): Promise<void> {
	const { testDbConnection } = await import('../src/core/install/db_probe.ts');
	const probe = await testDbConnection(posted);
	if (!probe.can_connect && !probe.db_exists) fail(probe.msg);
	if (!probe.db_exists) {
		fail(`database '${plan.answers.db_database}' must exist (empty) first — ${probe.msg}`);
	}
}

/**
 * The optional probes WARN instead of failing: an unattended install may
 * legitimately configure a target the build host cannot reach yet.
 */
async function stepDiffusionConnection(): Promise<void> {
	const { testDiffusionConnection } = await import('../src/core/install/db_probe.ts');
	const probe = await testDiffusionConnection(posted);
	if (!probe.ok) console.warn(`  ⚠ ${probe.msg} — writing the diffusion config anyway`);
}

async function stepMailerConnection(): Promise<void> {
	const { testMailerConnection } = await import('../src/core/install/mailer_probe.ts');
	const smtp = await testMailerConnection(posted);
	if (!smtp.ok) console.warn(`  ⚠ ${smtp.msg} — writing the SMTP config anyway`);
}

async function stepPersistConfig(): Promise<void> {
	const { persistConfig } = await import('../src/core/install/config_persist.ts');
	// Every install step REFUSES BY THROWING a registered install.* code
	// (src/core/install/refuse.ts); main()'s catch prints its message through
	// fail(), so there is no per-step `result` to test.
	// The catalog resolved above is handed in, so the manifest is fetched once.
	const persisted = await persistConfig(posted, { ontologyCatalog: resolvedCatalog.catalog });
	for (const [key, value] of Object.entries(persisted.generated)) {
		console.log(`  generated ${key} = ${value}`);
	}
}

async function stepCheckDirectories(): Promise<void> {
	const { checkDirectories } = await import('../src/core/install/directories.ts');
	const dirs = checkDirectories({ create: true });
	if (dirs.ok) return;
	// A bare path list read as a crash (measured 2026-10-08: "install failed:
	// /backups/db"). Say what is wrong and as whom, so the operator can chown.
	const who = `uid ${process.getuid?.() ?? '?'}`;
	fail(
		`these directories are missing or not writable by this process (${who}): ` +
			dirs.dirs
				.filter((d) => !d.writable)
				.map((d) => `${d.label} ${d.path}${d.exists ? '' : ' (could not be created)'}`)
				.join(', '),
	);
}

async function stepRestoreSeed(): Promise<void> {
	const { installDbFromSeed } = await import('../src/core/install/db_restore.ts');
	const restored = await installDbFromSeed();
	console.log(`  ${restored.msg}`);
}

/** Print a step's message and its non-blocking warnings. */
function report(outcome: { msg: string; warnings: readonly string[] }): void {
	console.log(`  ${outcome.msg}`);
	for (const warning of outcome.warnings) console.warn(`  ⚠ ${warning}`);
}

/** Fetch/copy + verify every ontology file BEFORE the database is touched. */
async function stepStageOntologies(): Promise<void> {
	const { stageOntologies } = await import('../src/core/install/ontology_install.ts');
	const request = plan.ontologyRequest;
	if (request === null) return fail('the ontology choice did not resolve to an install request');
	report(await stageOntologies(request));
}

/** Import the staged ontologies (right after the seed restore) and verify their references. */
async function stepInstallOntologies(): Promise<void> {
	const { installOntologies } = await import('../src/core/install/ontology_install.ts');
	report(await installOntologies({ userId: -1 }));
}

async function stepRootPassword(): Promise<void> {
	const { setRootPassword } = await import('../src/core/install/root_pw.ts');
	await setRootPassword(rootPassword as string);
}

/**
 * A failed hierarchy FAILS the install (nothing is sealed): the wizard cannot
 * pass a failed step either, and a thesaurus the operator asked for but cannot
 * use is not an install that worked.
 */
async function stepHierarchies(): Promise<void> {
	const { installHierarchies } = await import('../src/core/install/hierarchy_import.ts');
	const result = await installHierarchies([...plan.hierarchies]);
	console.log(`  ${result.msg}`);
	if (!result.ok) fail(`hierarchies: ${result.errors.join('; ')}`);
}

async function stepRegisterTools(): Promise<void> {
	const { registerInstallTools } = await import('../src/core/install/register_tools.ts');
	const tools = await registerInstallTools();
	console.log(`  ${tools.msg}`);
}

async function stepFinish(): Promise<void> {
	const { installFinish } = await import('../src/core/install/finish.ts');
	await installFinish();
}

/** One plan step → its engine call. EXHAUSTIVE: a new step id fails to compile here. */
function runStep(step: InstallStepId): Promise<void> {
	switch (step) {
		case 'test_db_connection':
			return stepDbConnection();
		case 'test_diffusion_connection':
			return stepDiffusionConnection();
		case 'test_mailer_connection':
			return stepMailerConnection();
		case 'persist_config':
			return stepPersistConfig();
		case 'check_directories':
			return stepCheckDirectories();
		case 'stage_ontologies':
			return stepStageOntologies();
		case 'install_db_from_default_file':
			return stepRestoreSeed();
		case 'install_ontologies':
			return stepInstallOntologies();
		case 'set_root_pw':
			return stepRootPassword();
		case 'install_hierarchies':
			return stepHierarchies();
		case 'register_tools':
			return stepRegisterTools();
		case 'install_finish':
			return stepFinish();
		default: {
			const unreachable: never = step;
			return fail(`unknown install step '${String(unreachable)}'`);
		}
	}
}

async function main(installPlan: InstallPlan): Promise<void> {
	const { answers } = installPlan;
	console.log(`\nDédalo TS install — entity '${answers.entity}', db '${answers.db_database}'\n`);
	for (const note of installPlan.notes) console.log(`  note: ${note}`);
	for (const warning of installPlan.warnings) console.warn(`  ⚠ ${warning}`);
	for (const suggestion of installPlan.suggestions) console.log(`  suggestion: ${suggestion}`);

	// Front-end affordance, not a plan step (the wizard shows the same report on load).
	const { runInitTest } = await import('../src/core/install/init_test.ts');
	console.log('→ pre-flight checks');
	const init = runInitTest();
	if (!init.result) fail(`pre-flight: ${init.errors.join('; ')}`);

	for (const step of installPlan.steps) {
		console.log(`→ [${step}] ${STEP_TEXT[step]}`);
		await runStep(step);
	}

	// End-to-end proof: an actual root login must succeed against the new DB.
	const { login } = await import('../src/core/security/auth.ts');
	console.log('→ verify root login');
	const auth = await login('root', rootPassword as string, 'local');
	if (!auth.ok) fail('root login verification failed after install');

	cleanupCatalog();
	console.log(
		'\n✔ install complete — root login verified. Start the server under its supervisor ' +
			'(systemd: `systemctl enable --now dedalo-ts` — docs/install/production.md) or with ' +
			'`bun run start:supervised`; plain `bun run start` is unsupervised and cannot take code updates.\n',
	);
	process.exit(0);
}

main(plan).catch((error) => fail(error instanceof Error ? error.message : String(error)));
