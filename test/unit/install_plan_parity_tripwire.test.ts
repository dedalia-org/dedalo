/**
 * INSTALL PLAN PARITY TRIPWIRE — the CLI and the browser wizard are FRONT ENDS
 * of one install plan (src/core/install/install_plan.ts; installer unification
 * A1/A3/A7, 2026-10-08), so the same answers must produce the same install.
 *
 * WHY. Before the plan module each front end carried its own answers → .env
 * mapping and its own defaults, and they had drifted (measured): the CLI
 * defaulted the database host to `/tmp`, wrote an empty entity label,
 * installed no optional thesaurus while the wizard pre-ticked three, silently
 * accepted `--yes` and any other unknown flag, and NO front end wrote
 * ONTOLOGY_SERVERS / CODE_SERVERS — every fresh install's update panels said
 * "No master servers are configured".
 *
 * WHAT IS MEASURED (outcomes, not spellings):
 *  (a) an answer matrix — base, +diffusion, +mailer, +serving keys, air-gapped,
 *      thesauri default / none / explicit / with the core `lg` — posted the
 *      wizard's way (its record shape; the default thesauri read from the
 *      wizard's own context) and typed the CLI's way (argv through
 *      answersFromCliArgs): identical .env sections, keys, steps, thesauri.
 *      (The wizard's thesauri are posted again to install_hierarchies, which
 *      runs the plan's normalizeHierarchyChoice — gated where it is wired, in
 *      install_step_router_native.)
 *  (b) ONE spawned `scripts/install.ts --plan` equals the in-process plan —
 *      the CLI really runs the module, not a copy of it;
 *  (c) persistConfig, run in two scratch private dirs from the CLI-derived and
 *      the wizard answers, writes .env files whose parsed keys AND values are
 *      identical except the generated DEDALO_SALT_STRING;
 *  (d) the default .env carries the official servers, and the plan's official
 *      constants equal the fenced examples the config catalog documents (one
 *      truth); air-gapped writes `[]`; a prior custom server list survives a
 *      non-air-gapped re-run verbatim, but a prior `[]` (an earlier air-gapped
 *      answer) yields to an official re-run;
 *  (e) every plan step is an action the wizard router serves;
 *  (f) unknown flags (`--yes`) and value flags without a value are errors and
 *      the spawned CLI exits 1; `lg` is dropped with a note; a tld hierarchy.json
 *      does not list is an error;
 *  (g) no plan, whatever the answers, owns DEDALO_SUPERVISED — supervision is
 *      declared by the process manager, never by ../private/.env;
 *  (h) DOMAIN ONTOLOGIES (A4/A5/A6, 2026-10-09): the default (no flag ≡ the
 *      wizard posting its context default), an explicit `--ontologies oh`, a
 *      core TLD dropped with a note, `none` and an air-gapped non-vendored
 *      choice refused the same on both sides; a LOCAL fixture source (a
 *      package this gate builds into a mkdtemp dir — zz TLDs, a declared
 *      dependency chain): the spawned `--plan` equals the in-process plan over
 *      the resolved catalog (closure, ACTIVE_ONTOLOGY_TLDS), `--list-ontologies`
 *      prints exactly describeOntologyCatalog of it, persistConfig writes the
 *      same ACTIVE_ONTOLOGY_TLDS, and that written list maps back
 *      (ontologyRequestFromActive — the wizard's restarted process) to the very
 *      request the CLI plan stages.
 *  (i) DECLARED DEPENDENCIES (hierarchy60): every declared one pre-ticked;
 *      a mandatory ONTOLOGY never declinable; a THESAURUS never blocks (owner
 *      decision 2026-10-10) — a declined mandatory one, or one with no
 *      hierarchy.json entry, is a WARNING on both sides, never a plan error.
 *
 * persistConfig runs in CHILD processes (scratch DEDALO_INSTALL_PRIVATE_DIR +
 * DEDALO_TS_STATE_PATH in the child's env), so this gate never mutates its own
 * process environment and never touches the live ../private/.env or state. The
 * spawned CLI reads its prior .env from an EMPTY scratch private dir (it honours
 * a preserved custom server list, which the in-process plan here has none of).
 * No database is touched anywhere in this file, and no network: the only
 * non-vendored source is a local fixture.
 */

import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { MAINTENANCE_KEYS } from '../../src/config/catalog/maintenance.ts';
import { parseEnvFile } from '../../src/config/env.ts';
import { buildInstallContext } from '../../src/core/install/context.ts';
import { INSTALL_ROUTER_ACTIONS } from '../../src/core/install/engine.ts';
import {
	CORE_HIERARCHIES,
	offeredHierarchies,
	TOPONYMY_TYPOLOGY_ID,
} from '../../src/core/install/hierarchy_meta.ts';
import {
	answersFromCliArgs,
	buildInstallPlan,
	INSTALL_CLI_FLAGS,
	INSTALL_STEP_IDS,
	type InstallPlan,
	type InstallStepId,
	OFFICIAL_CODE_SERVER,
	OFFICIAL_ONTOLOGY_SERVER,
	TOPONYMY_SUGGESTION,
} from '../../src/core/install/install_plan.ts';
import { resolveOntologyCatalog } from '../../src/core/install/ontology_catalog.ts';
import {
	describeOntologyCatalog,
	offeredHierarchyTlds,
	ontologyRequestFromActive,
	vendoredOntologyCatalog,
} from '../../src/core/install/ontology_choice.ts';
import { CORE_ONTOLOGY_TLDS } from '../../src/core/ontology/core_tlds.ts';
import { buildOntologyPackage } from '../../src/core/test_data/ontology_package_fixture.ts';

const ROOT = resolve(import.meta.dir, '../..');
const CLI = join(ROOT, 'scripts/install.ts');
const CONFIG_PERSIST = join(ROOT, 'src/core/install/config_persist.ts');
const scratchRoot = mkdtempSync(join(tmpdir(), 'dedalo_install_plan_parity_'));
afterAll(() => rmSync(scratchRoot, { recursive: true, force: true }));

const WIZARD_PROPERTIES = buildInstallContext().properties as Record<string, unknown> & {
	hierarchies: { tld: string }[];
	toponymy_typology: number;
	ontologies: { default: string[] };
};
/**
 * The thesauri the WIZARD pre-ticks before any declaration is known: NONE
 * (2026-10-10 — pre-selection comes only from the declared dependencies, which
 * the wizard learns from persist_config's plan). Its context carries no default
 * list at all (pinned below), so the empty post IS its default answer.
 */
const WIZARD_DEFAULT_THESAURI: string[] = [];
/** The domain ontologies the WIZARD pre-ticks (its context, not a re-typed list). */
const WIZARD_DEFAULT_ONTOLOGIES = WIZARD_PROPERTIES.ontologies.default;

/** An empty private dir: the spawned CLI's prior .env (none). */
const EMPTY_PRIVATE = mkdtempSync(join(scratchRoot, 'empty_private_'));

/**
 * A LOCAL ontology source in the server export layout, built by this gate:
 * zzpa declares zzpb (+ core), zzpb declares core only — a dependency chain the
 * closure must install deps first.
 */
const FIXTURE_SOURCE = (() => {
	const dir = mkdtempSync(join(scratchRoot, 'ontology_source_'));
	const files = buildOntologyPackage([
		{
			tld: 'zzpa',
			name: 'zz parity A',
			typologyId: 8,
			typologyName: 'Catalog',
			dependencies: [
				{ tld: 'dd', main: 'ontology35', mandatory: true },
				{ tld: 'zzpb', main: 'ontology35', mandatory: true },
			],
			nodes: [{ id: 1, parent: 'zzpa0', model: 'dd6', term: 'A root' }],
		},
		{
			tld: 'zzpb',
			name: 'zz parity B',
			typologyId: 8,
			typologyName: 'Catalog',
			dependencies: [{ tld: 'dd', main: 'ontology35', mandatory: true }],
			nodes: [{ id: 1, parent: 'zzpb0', model: 'dd6', term: 'B root' }],
		},
	]);
	mkdirSync(dir, { recursive: true });
	for (const [name, bytes] of files) writeFileSync(join(dir, name), bytes);
	return dir;
})();

/** Two real VENDORED thesauri (installer data read at run time, never records). */
const [THESAURUS_REQUIRED, THESAURUS_OPTIONAL] = [...offeredHierarchyTlds()] as [string, string];

/**
 * A LOCAL source whose entries declare hierarchy60 OBJECTS (2026-10-10): zzqc
 * declares the ontology zzqd OPTIONAL, THESAURUS_REQUIRED mandatory and
 * THESAURUS_OPTIONAL optional; zzqe declares the thesaurus zzqx MANDATORY —
 * no hierarchy.json entry, so choosing zzqe WARNS (a thesaurus never refuses the plan).
 */
const DECLARED_SOURCE = (() => {
	const dir = mkdtempSync(join(scratchRoot, 'ontology_source_declared_'));
	const files = buildOntologyPackage([
		{
			tld: 'zzqc',
			name: 'zz parity C',
			typologyId: 8,
			typologyName: 'Catalog',
			dependencies: [
				{ tld: 'zzqd', main: 'ontology35', mandatory: false },
				{ tld: THESAURUS_REQUIRED, main: 'hierarchy1', mandatory: true },
				{ tld: THESAURUS_OPTIONAL, main: 'hierarchy1', mandatory: false },
			],
			nodes: [{ id: 1, parent: 'zzqc0', model: 'dd6', term: 'C root' }],
		},
		{
			tld: 'zzqd',
			name: 'zz parity D',
			typologyId: 8,
			typologyName: 'Catalog',
			dependencies: [],
			nodes: [{ id: 1, parent: 'zzqd0', model: 'dd6', term: 'D root' }],
		},
		{
			tld: 'zzqe',
			name: 'zz parity E',
			typologyId: 8,
			typologyName: 'Catalog',
			dependencies: [{ tld: 'zzqx', main: 'hierarchy1', mandatory: true }],
			nodes: [{ id: 1, parent: 'zzqe0', model: 'dd6', term: 'E root' }],
		},
	]);
	for (const [name, bytes] of files) writeFileSync(join(dir, name), bytes);
	return dir;
})();

// ── the answer matrix ─────────────────────────────────────────────────────────

interface AnswerCase {
	name: string;
	argv: string[];
	wizard: Record<string, unknown>;
}

const BASE_ARGV = [
	'--db-name',
	'dedalo_parity',
	'--db-user',
	'parity_user',
	'--db-password',
	'secret pass',
	'--db-host',
	'localhost',
	'--db-port',
	'5432',
	'--entity',
	'parity',
	'--entity-label',
	'Parity Museum',
	'--timezone',
	'Europe/Madrid',
	'--locale',
	'es-ES',
	'--langs',
	'lg-spa,lg-eng',
	'--app-lang',
	'lg-spa',
	'--data-lang',
	'lg-eng',
];

/** The same answers as the wizard posts them (its key names, its value shapes). */
const BASE_WIZARD: Record<string, unknown> = {
	db_database: 'dedalo_parity',
	db_username: 'parity_user',
	db_password: 'secret pass',
	db_hostname: 'localhost',
	db_port: '5432',
	db_socket: '',
	entity: 'parity',
	entity_label: 'Parity Museum',
	timezone: 'Europe/Madrid',
	locale: 'es-ES',
	langs: ['lg-spa', 'lg-eng'],
	app_lang_default: 'lg-spa',
	data_lang_default: 'lg-eng',
	diffusion: false,
	mailer: false,
	update_servers: true,
	hierarchies: WIZARD_DEFAULT_THESAURI,
	ontologies: WIZARD_DEFAULT_ONTOLOGIES,
};

const DIFFUSION_ARGV = [
	'--diffusion',
	'--mysql-host',
	'mariadb.local',
	'--mysql-port',
	'3307',
	'--mysql-name',
	'web_parity',
	'--mysql-user',
	'web_user',
	'--mysql-password',
	'web pw',
];
const DIFFUSION_WIZARD = {
	diffusion: true,
	mysql_hostname: 'mariadb.local',
	mysql_port: '3307',
	mysql_database: 'web_parity',
	mysql_username: 'web_user',
	mysql_password: 'web pw',
};
const MAILER_ARGV = [
	'--mailer',
	'--smtp-host',
	'smtp.example.org',
	'--smtp-port',
	'465',
	'--smtp-secure',
	'ssl',
	'--smtp-user',
	'mailer@example.org',
	'--smtp-password',
	'mail pw',
	'--smtp-from',
	'noreply@example.org',
	'--smtp-from-name',
	'Dédalo',
];
const MAILER_WIZARD = {
	mailer: true,
	smtp_host: 'smtp.example.org',
	smtp_port: '465',
	smtp_secure: 'ssl',
	smtp_user: 'mailer@example.org',
	smtp_pass: 'mail pw',
	smtp_from: 'noreply@example.org',
	smtp_from_name: 'Dédalo',
};

const CASES: AnswerCase[] = [
	{ name: 'base (every default)', argv: BASE_ARGV, wizard: BASE_WIZARD },
	{
		name: '+diffusion',
		argv: [...BASE_ARGV, ...DIFFUSION_ARGV],
		wizard: { ...BASE_WIZARD, ...DIFFUSION_WIZARD },
	},
	{
		name: '+mailer',
		argv: [...BASE_ARGV, ...MAILER_ARGV],
		wizard: { ...BASE_WIZARD, ...MAILER_WIZARD },
	},
	{
		name: '+serving keys',
		argv: [
			...BASE_ARGV,
			'--media-path',
			'/srv/dedalo/media',
			'--socket',
			'/run/dedalo/dedalo_ts.sock',
			'--media-access-mode',
			'publication',
		],
		wizard: {
			...BASE_WIZARD,
			media_path: '/srv/dedalo/media',
			unix_socket: '/run/dedalo/dedalo_ts.sock',
			media_access_mode: 'publication',
		},
	},
	{
		name: 'air-gapped (no update servers)',
		argv: [...BASE_ARGV, '--no-update-servers'],
		wizard: { ...BASE_WIZARD, update_servers: false },
	},
	{
		name: 'thesauri: none',
		argv: [...BASE_ARGV, '--hierarchies', 'none'],
		wizard: { ...BASE_WIZARD, hierarchies: [] },
	},
	{
		name: 'thesauri: explicit',
		argv: [...BASE_ARGV, '--hierarchies', 'ad,fr'],
		wizard: { ...BASE_WIZARD, hierarchies: ['ad', 'fr'] },
	},
	{
		name: 'thesauri: with the core lg',
		argv: [...BASE_ARGV, '--hierarchies', 'lg,fr'],
		wizard: { ...BASE_WIZARD, hierarchies: ['lg', 'fr'] },
	},
	{
		name: 'ontologies: explicit oh',
		argv: [...BASE_ARGV, '--ontologies', 'oh'],
		wizard: { ...BASE_WIZARD, ontologies: ['oh'] },
	},
	{
		name: 'ontologies: a core TLD dropped with a note',
		argv: [...BASE_ARGV, '--ontologies', 'DD,oh'],
		wizard: { ...BASE_WIZARD, ontologies: ['dd', 'oh'] },
	},
	{
		name: 'ontologies: air-gapped default (the vendored oh)',
		argv: [...BASE_ARGV, '--no-update-servers', '--ontologies', 'default'],
		wizard: { ...BASE_WIZARD, update_servers: false },
	},
];

/** What a plan DECIDES (the fields both front ends must agree on). */
function decided(plan: InstallPlan) {
	return {
		env: plan.env,
		envKeys: plan.envKeys,
		steps: plan.steps,
		hierarchies: plan.hierarchies,
		hierarchyDependencies: plan.hierarchyDependencies,
		suggestions: plan.suggestions,
		ontologies: plan.ontologies,
		ontologySource: plan.ontologySource,
		ontologyRequest: plan.ontologyRequest,
		activeOntologyTlds: plan.activeOntologyTlds,
		notes: plan.notes,
		warnings: plan.warnings,
		errors: plan.errors,
	};
}

function cliPlan(argv: readonly string[]): InstallPlan {
	const invocation = answersFromCliArgs(argv);
	expect(invocation.errors).toEqual([]);
	return buildInstallPlan(invocation.raw);
}

// ── child processes ──────────────────────────────────────────────────────────

/** Spawn the real CLI in --plan mode (touches nothing; an empty prior .env). */
function spawnPlan(
	argv: readonly string[],
	mode: '--plan' | '--list-ontologies' | '--list-hierarchies' = '--plan',
): { exitCode: number; stdout: string; stderr: string } {
	const proc = Bun.spawnSync([process.execPath, 'run', CLI, mode, ...argv], {
		cwd: ROOT,
		env: { ...Bun.env, DEDALO_INSTALL_PRIVATE_DIR: EMPTY_PRIVATE },
		stdout: 'pipe',
		stderr: 'pipe',
	});
	return {
		exitCode: proc.exitCode,
		stdout: proc.stdout.toString(),
		stderr: proc.stderr.toString(),
	};
}

/**
 * persistConfig in a CHILD with its own scratch private dir + state path; the
 * answers ride stdin. Answers the written .env text.
 */
function persistInChild(answers: Record<string, unknown>, privateDir: string): string {
	const script = `const { persistConfig } = await import(${JSON.stringify(CONFIG_PERSIST)});
const answers = JSON.parse(await Bun.stdin.text());
await persistConfig(answers);`;
	const proc = Bun.spawnSync([process.execPath, '-e', script], {
		cwd: ROOT,
		env: {
			...Bun.env,
			DEDALO_INSTALL_PRIVATE_DIR: privateDir,
			DEDALO_TS_STATE_PATH: join(privateDir, 'ts_state.json'),
			DEDALO_INSTALL_NO_RESTART: 'true',
		},
		stdin: Buffer.from(JSON.stringify(answers)),
		stdout: 'pipe',
		stderr: 'pipe',
	});
	expect(proc.exitCode, `persistConfig child failed: ${proc.stderr.toString()}`).toBe(0);
	return readFileSync(join(privateDir, '.env'), 'utf8');
}

function scratchDir(name: string): string {
	return mkdtempSync(join(scratchRoot, `${name}_`));
}

/** The fenced `KEY=<json>` example a catalog entry documents. */
function catalogExample(key: 'ONTOLOGY_SERVERS' | 'CODE_SERVERS'): unknown {
	const doc = MAINTENANCE_KEYS[key].doc;
	const line = doc.split('\n').find((candidate) => candidate.startsWith(`${key}=`));
	expect(line, `the catalog documents a ${key}= example`).toBeDefined();
	return JSON.parse((line as string).slice(key.length + 1));
}

// ── (a) CLI ≡ wizard ─────────────────────────────────────────────────────────

describe('install plan — CLI ≡ wizard (a)', () => {
	test('the wizard pre-ticks NO thesaurus by default — no default list is served, the offer is real (the matrix is not vacuous)', () => {
		expect('install_checked_default' in WIZARD_PROPERTIES).toBe(false);
		expect(WIZARD_PROPERTIES.hierarchies.length).toBeGreaterThan(0);
		expect(WIZARD_PROPERTIES.toponymy_typology).toBe(TOPONYMY_TYPOLOGY_ID);
		expect(CASES.length).toBeGreaterThanOrEqual(8);
	});

	for (const answerCase of CASES) {
		test(`${answerCase.name}: same .env sections, keys, steps, thesauri`, () => {
			const fromCli = cliPlan(answerCase.argv);
			const fromWizard = buildInstallPlan(answerCase.wizard);
			expect(fromCli.errors).toEqual([]);
			expect(fromCli.envKeys.length).toBeGreaterThan(15);
			expect(decided(fromCli)).toEqual(decided(fromWizard));
		});
	}

	test('the matrix exercises what it claims (the decided fields really differ by case)', () => {
		const base = cliPlan(CASES[0]?.argv ?? []);
		const diffusion = cliPlan(CASES[1]?.argv ?? []);
		const mailer = cliPlan(CASES[2]?.argv ?? []);
		expect(diffusion.steps).toContain('test_diffusion_connection');
		expect(base.steps).not.toContain('test_diffusion_connection');
		expect(mailer.steps).toContain('test_mailer_connection');
		expect(diffusion.envKeys).toContain('DEDALO_DIFFUSION_NATIVE');
		expect(mailer.envKeys).toContain('DEDALO_SMTP_HOST');
		expect(cliPlan(CASES[3]?.argv ?? []).envKeys).toContain('SERVER_UNIX_SOCKET');
		expect(cliPlan(CASES[5]?.argv ?? []).hierarchies).toEqual([]);
		expect(base.hierarchies).toEqual(WIZARD_DEFAULT_THESAURI);
		// No toponymy chosen → the SUGGESTION (never a pre-selection); one chosen → none.
		expect([...base.suggestions]).toEqual([TOPONYMY_SUGGESTION]);
		expect(cliPlan(CASES[6]?.argv ?? []).suggestions).toHaveLength(0);
	});
});

// ── (b) the spawned CLI uses the module ─────────────────────────────────────

/** The --plan JSON line a plan prints (scripts/install.ts). */
function printedPlan(plan: InstallPlan, errors: string[]) {
	return {
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
	};
}

describe('install plan — the CLI runs the module (b)', () => {
	test('`scripts/install.ts --plan` prints the in-process plan and exits 0', () => {
		const argv = [...BASE_ARGV, ...DIFFUSION_ARGV, '--hierarchies', 'lg,ad'];
		const spawned = spawnPlan(argv);
		expect(spawned.exitCode, spawned.stderr).toBe(0);
		const printed = JSON.parse(spawned.stdout.trim()) as Record<string, unknown>;
		const local = cliPlan(argv);
		expect(printed).toEqual(printedPlan(local, []));
		expect((printed.notes as string[]).length).toBe(1);
	});

	test('`scripts/install.ts --list-hierarchies` prints the manifest offer (core apart, no default) and the toponymy suggestion', () => {
		const listed = spawnPlan([], '--list-hierarchies');
		expect(listed.exitCode, listed.stderr).toBe(0);
		const printed = JSON.parse(listed.stdout.trim()) as {
			core: string[];
			entries: { tld: string; has_data: boolean; typology_id: number }[];
			suggestion: string;
			errors: string[];
		};
		const offer = offeredHierarchies();
		expect(offer.length).toBeGreaterThan(0);
		expect(printed.core).toEqual(CORE_HIERARCHIES.map((item) => item.tld));
		expect(printed.entries.map((entry) => entry.tld)).toEqual(offer.map((entry) => entry.tld));
		expect(printed.entries.map((entry) => entry.has_data)).toEqual(
			offer.map((entry) => entry.data_files.length > 0),
		);
		expect(printed.suggestion).toBe(TOPONYMY_SUGGESTION);
		expect(printed.errors).toHaveLength(0);
	});
});

// ── (c) + (d) the written .env ───────────────────────────────────────────────

describe('install plan — the written .env (c, d)', () => {
	test('CLI-derived and wizard answers write the same .env (salt aside)', () => {
		const answerCase = {
			argv: [...BASE_ARGV, ...DIFFUSION_ARGV, ...MAILER_ARGV],
			wizard: { ...BASE_WIZARD, ...DIFFUSION_WIZARD, ...MAILER_WIZARD },
		};
		// The CLI hands persistConfig the plan's normalized answers (scripts/install.ts).
		const cliAnswers = { ...cliPlan(answerCase.argv).answers };
		const cliEnv = parseEnvFile(persistInChild(cliAnswers, scratchDir('cli')));
		const wizardEnv = parseEnvFile(persistInChild(answerCase.wizard, scratchDir('wizard')));
		expect(Object.keys(cliEnv).length).toBeGreaterThan(30);
		expect(cliEnv.DEDALO_SALT_STRING).toMatch(/^[0-9a-f]{64}$/);
		const { DEDALO_SALT_STRING: _cliSalt, ...cliRest } = cliEnv;
		const { DEDALO_SALT_STRING: _wizardSalt, ...wizardRest } = wizardEnv;
		expect(cliRest).toEqual(wizardRest);
		// The default domain ontology, after the core — and the wizard's restarted
		// process maps that written list back to the very request the CLI stages.
		const active = JSON.parse(wizardEnv.ACTIVE_ONTOLOGY_TLDS as string) as string[];
		expect(active).toEqual([...CORE_ONTOLOGY_TLDS, ...WIZARD_DEFAULT_ONTOLOGIES]);
		const back = ontologyRequestFromActive(active, vendoredOntologyCatalog());
		expect(back.errors).toEqual([]);
		expect(back.request).toEqual(cliPlan(answerCase.argv).ontologyRequest);
	});

	test('the default .env carries the official servers — the SAME entries the catalog documents', () => {
		expect([OFFICIAL_ONTOLOGY_SERVER]).toEqual(catalogExample('ONTOLOGY_SERVERS') as never);
		expect([OFFICIAL_CODE_SERVER]).toEqual(catalogExample('CODE_SERVERS') as never);
		const env = parseEnvFile(persistInChild(BASE_WIZARD, scratchDir('default')));
		expect(JSON.parse(env.ONTOLOGY_SERVERS as string)).toEqual([OFFICIAL_ONTOLOGY_SERVER]);
		expect(JSON.parse(env.CODE_SERVERS as string)).toEqual([OFFICIAL_CODE_SERVER]);
	});

	test('air-gapped writes [] for both lists', () => {
		const env = parseEnvFile(
			persistInChild({ ...BASE_WIZARD, update_servers: false }, scratchDir('airgapped')),
		);
		expect(JSON.parse(env.ONTOLOGY_SERVERS as string)).toEqual([]);
		expect(JSON.parse(env.CODE_SERVERS as string)).toEqual([]);
	});

	test('a prior custom server list survives a non-air-gapped re-run verbatim', () => {
		const dir = scratchDir('mirror');
		const mirror =
			'ONTOLOGY_SERVERS=[{"name":"Mirror","url":"https://mirror.example.org/dedalo/core/api/v1/json/","code":"m1"}]';
		writeFileSync(join(dir, '.env'), `DEDALO_SALT_STRING=deadbeef\n${mirror}\n`);
		const body = persistInChild(BASE_WIZARD, dir);
		const lines = body.split('\n');
		expect(lines.filter((line) => line.startsWith('ONTOLOGY_SERVERS='))).toEqual([mirror]);
		// The list the operator did not customise is still written official.
		expect(JSON.parse(parseEnvFile(body).CODE_SERVERS as string)).toEqual([OFFICIAL_CODE_SERVER]);
	});

	// The wizard re-save it invites: an air-gapped save, then a reload (the box
	// arrives ticked) and a save with the official server. The earlier `[]` is an
	// ANSWER, not a mirror — keeping it would leave the install offline while the
	// form showed the official server. Same for an unparseable prior value.
	test('an official re-run after an air-gapped one writes the official lists (a prior [] is not preserved)', () => {
		const dir = scratchDir('airgapped_then_official');
		writeFileSync(
			join(dir, '.env'),
			'DEDALO_SALT_STRING=deadbeef\nONTOLOGY_SERVERS=[]\nCODE_SERVERS=not-json\n',
		);
		const body = persistInChild(BASE_WIZARD, dir);
		const env = parseEnvFile(body);
		expect(JSON.parse(env.ONTOLOGY_SERVERS as string)).toEqual([OFFICIAL_ONTOLOGY_SERVER]);
		expect(JSON.parse(env.CODE_SERVERS as string)).toEqual([OFFICIAL_CODE_SERVER]);
		// Owned, so written once — the stale lines are not carried as "Preserved".
		for (const key of ['ONTOLOGY_SERVERS', 'CODE_SERVERS']) {
			expect(body.split('\n').filter((line) => line.startsWith(`${key}=`)).length, key).toBe(1);
		}
	});

	test('an air-gapped re-run OWNS the lists: a prior mirror is replaced by []', () => {
		const dir = scratchDir('mirror_airgapped');
		writeFileSync(
			join(dir, '.env'),
			'DEDALO_SALT_STRING=deadbeef\nONTOLOGY_SERVERS=[{"name":"Mirror","url":"https://m.example.org/","code":"m1"}]\n',
		);
		const env = parseEnvFile(persistInChild({ ...BASE_WIZARD, update_servers: false }, dir));
		expect(JSON.parse(env.ONTOLOGY_SERVERS as string)).toEqual([]);
	});
});

// ── (h) domain ontologies ────────────────────────────────────────────────────

describe('install plan — domain ontologies (h)', () => {
	test('the default is the wizard default, installed from the vendored file', () => {
		const plan = cliPlan(BASE_ARGV);
		expect(WIZARD_DEFAULT_ONTOLOGIES).toEqual(['oh']);
		expect(plan.ontologies).toEqual(WIZARD_DEFAULT_ONTOLOGIES);
		expect(plan.ontologyRequest?.items.map((item) => [item.tld, item.origin])).toEqual([
			['oh', 'vendored'],
		]);
		expect(plan.activeOntologyTlds).toEqual([...CORE_ONTOLOGY_TLDS, 'oh']);
		expect(plan.envKeys).toContain('ACTIVE_ONTOLOGY_TLDS');
		const dropped = cliPlan([...BASE_ARGV, '--ontologies', 'dd,oh']);
		expect(dropped.notes).toContain(
			'dd is a core ontology (always installed) — dropped from the list',
		);
	});

	test('`none` is refused the same way on both sides', () => {
		const none = 'at least one domain ontology is required (the default is oh)';
		expect(cliPlan([...BASE_ARGV, '--ontologies', 'none']).errors).toContain(none);
		expect(buildInstallPlan({ ...BASE_WIZARD, ontologies: [] }).errors).toContain(none);
		const spawned = spawnPlan([...BASE_ARGV, '--ontologies', 'none']);
		expect(spawned.exitCode).toBe(1);
		expect((JSON.parse(spawned.stdout.trim()) as { errors: string[] }).errors).toContain(none);
	});

	test('air-gapped + a non-vendored TLD: the same refusal on both sides', () => {
		const refusal =
			"unknown ontology 'tch' — not offered by the built-in set (air-gapped: only oh is available offline)";
		const cli = cliPlan([...BASE_ARGV, '--no-update-servers', '--ontologies', 'oh,tch']);
		const wizard = buildInstallPlan({
			...BASE_WIZARD,
			update_servers: false,
			ontologies: ['oh', 'tch'],
		});
		expect(cli.errors).toContain(refusal);
		expect(decided(cli)).toEqual(decided(wizard));
		const spawned = spawnPlan([...BASE_ARGV, '--no-update-servers', '--ontologies', 'oh,tch']);
		expect(spawned.exitCode).toBe(1);
		expect((JSON.parse(spawned.stdout.trim()) as { errors: string[] }).errors).toContain(refusal);
	});

	test('a needed catalog that was not resolved is reported, never fetched by the plan', () => {
		const plan = cliPlan([
			...BASE_ARGV,
			'--ontology-source',
			FIXTURE_SOURCE,
			'--ontologies',
			'zzpa',
		]);
		expect(plan.errors).toEqual([
			`the ontology catalog of --ontology-source ${FIXTURE_SOURCE} was not resolved`,
		]);
		expect(plan.ontologyRequest).toBeNull();
	});

	test('a LOCAL source: spawned --plan ≡ in-process plan over the resolved catalog (closure + ACTIVE)', async () => {
		const argv = [...BASE_ARGV, '--ontology-source', FIXTURE_SOURCE, '--ontologies', 'zzpa,oh'];
		const resolved = await resolveOntologyCatalog(
			{ kind: 'local', path: FIXTURE_SOURCE },
			{ allowedServers: [] },
		);
		const local = buildInstallPlan(answersFromCliArgs(argv).raw, {
			ontologyCatalog: resolved.catalog,
		});
		expect(local.errors).toEqual([]);
		expect(local.ontologyRequest?.items.map((item) => [item.tld, item.origin])).toEqual([
			['zzpb', 'local'],
			['zzpa', 'local'],
			['oh', 'vendored'],
		]);
		expect(local.activeOntologyTlds).toEqual([...CORE_ONTOLOGY_TLDS, 'zzpb', 'zzpa', 'oh']);
		expect(local.notes).toContain('zzpa also installs: zzpb');
		const spawned = spawnPlan(argv);
		expect(spawned.exitCode, spawned.stderr).toBe(0);
		expect(JSON.parse(spawned.stdout.trim())).toEqual(printedPlan(local, []));

		// --list-ontologies prints THE view of the same catalog.
		const listed = spawnPlan(['--ontology-source', FIXTURE_SOURCE], '--list-ontologies');
		expect(listed.exitCode, listed.stderr).toBe(0);
		expect(JSON.parse(listed.stdout.trim())).toEqual({
			...describeOntologyCatalog(resolved.catalog),
			errors: [],
		});

		// persistConfig (resolving the source itself) writes that ACTIVE list, and it
		// maps back to the very request the CLI stages.
		const env = parseEnvFile(persistInChild({ ...local.answers }, scratchDir('local_source')));
		const active = JSON.parse(env.ACTIVE_ONTOLOGY_TLDS as string) as string[];
		expect(active).toEqual([...local.activeOntologyTlds]);
		const back = ontologyRequestFromActive(active, resolved.catalog);
		expect(back.errors).toEqual([]);
		expect(back.request).toEqual(local.ontologyRequest);
		resolved.cleanup();
	});
});

describe('install plan — declared dependencies: all pre-ticked; a thesaurus never blocks (i)', () => {
	test('vendored thesauri for the test exist (anti-vacuity)', () => {
		expect(THESAURUS_REQUIRED).toMatch(/^[a-z]+$/);
		expect(THESAURUS_OPTIONAL).toMatch(/^[a-z]+$/);
		expect(THESAURUS_OPTIONAL).not.toBe(THESAURUS_REQUIRED);
	});

	test('optional ontology + thesauri installed by default; a MANDATORY thesaurus is declinable (warned)', async () => {
		const resolved = await resolveOntologyCatalog(
			{ kind: 'local', path: DECLARED_SOURCE },
			{ allowedServers: [] },
		);
		try {
			const base = [
				...BASE_ARGV,
				'--ontology-source',
				DECLARED_SOURCE,
				'--ontologies',
				'zzqc',
				'--hierarchies',
				'none',
			];
			const ticked = buildInstallPlan(answersFromCliArgs(base).raw, {
				ontologyCatalog: resolved.catalog,
			});
			expect(ticked.errors).toEqual([]);
			expect(ticked.ontologyRequest?.items.map((item) => item.tld)).toEqual(['zzqd', 'zzqc']);
			expect(ticked.hierarchies).toEqual([THESAURUS_REQUIRED, THESAURUS_OPTIONAL]);
			expect(ticked.hierarchyDependencies).toEqual([
				{ tld: THESAURUS_REQUIRED, mandatory: true, dependants: ['zzqc'] },
				{ tld: THESAURUS_OPTIONAL, mandatory: false, dependants: ['zzqc'] },
			]);

			// The operator declines everything optional — AND the mandatory thesaurus:
			// all of them leave (owner decision 2026-10-10 — a thesaurus never blocks
			// nor is forced), the optional ones noted, the mandatory one WARNED.
			const declineArgv = [
				...base,
				'--decline-dependencies',
				`zzqd,${THESAURUS_REQUIRED},${THESAURUS_OPTIONAL}:hierarchy1`,
			];
			const cli = buildInstallPlan(answersFromCliArgs(declineArgv).raw, {
				ontologyCatalog: resolved.catalog,
			});
			expect(cli.errors).toEqual([]);
			expect(cli.answers.declined_dependencies).toEqual([
				'zzqd',
				THESAURUS_REQUIRED,
				`${THESAURUS_OPTIONAL}:hierarchy1`,
			]);
			expect(cli.ontologyRequest?.items.map((item) => item.tld)).toEqual(['zzqc']);
			expect(cli.activeOntologyTlds).toEqual([...CORE_ONTOLOGY_TLDS, 'zzqc']);
			expect(cli.hierarchies).toEqual([]);
			expect(cli.notes).toContain(
				"the ontology 'zzqd' (an optional dependency of 'zzqc') is declined — not installed",
			);
			expect(cli.warnings).toContain(
				`the thesaurus '${THESAURUS_REQUIRED}' (declared mandatory by 'zzqc') is declined — not installed; it is strongly recommended and can be installed later from Maintenance › Install hierarchies`,
			);
			// the wizard posts the same answer as a list: the same plan
			const wizard = buildInstallPlan(
				{
					...answersFromCliArgs(declineArgv).raw,
					declined_dependencies: ['zzqd', THESAURUS_REQUIRED, `${THESAURUS_OPTIONAL}:hierarchy1`],
				},
				{ ontologyCatalog: resolved.catalog },
			);
			expect(decided(wizard)).toEqual(decided(cli));
			// the spawned CLI prints that plan
			const spawned = spawnPlan(declineArgv);
			expect(spawned.exitCode, spawned.stderr).toBe(0);
			expect(JSON.parse(spawned.stdout.trim())).toEqual(printedPlan(cli, []));
			// the written ACTIVE list maps back without the declined optional ontology
			const back = ontologyRequestFromActive([...cli.activeOntologyTlds], resolved.catalog);
			expect(back.errors).toEqual([]);
			expect(back.request).toEqual(cli.ontologyRequest);
		} finally {
			resolved.cleanup();
		}
	});

	test('a mandatory thesaurus that is not vendored WARNS (never refuses the plan); a malformed decline refuses', async () => {
		const resolved = await resolveOntologyCatalog(
			{ kind: 'local', path: DECLARED_SOURCE },
			{ allowedServers: [] },
		);
		try {
			const argv = [...BASE_ARGV, '--ontology-source', DECLARED_SOURCE, '--ontologies', 'zzqe'];
			const plan = buildInstallPlan(answersFromCliArgs(argv).raw, {
				ontologyCatalog: resolved.catalog,
			});
			expect(plan.errors).toEqual([]);
			expect(plan.ontologyRequest).not.toBeNull();
			expect(plan.hierarchies).not.toContain('zzqx');
			expect(plan.warnings).toContain(
				"the thesaurus 'zzqx' (declared mandatory by 'zzqe') has no entry in hierarchy.json — skipped; it is strongly recommended and can be installed later from Maintenance › Install hierarchies",
			);
			// the spawned CLI agrees: exit 0, the same warning printed
			const spawned = spawnPlan(argv);
			expect(spawned.exitCode, spawned.stderr).toBe(0);
			expect(JSON.parse(spawned.stdout.trim())).toEqual(printedPlan(plan, []));
			expect(cliPlan([...BASE_ARGV, '--decline-dependencies', 'zz-x']).errors).toContain(
				"declined_dependencies: 'zz-x' is not a TLD or <tld>:ontology35|hierarchy1",
			);
		} finally {
			resolved.cleanup();
		}
	});
});

// ── (e) routable steps ───────────────────────────────────────────────────────

describe('install plan — every step is routable (e)', () => {
	test('every INSTALL_STEP_ID — and every step any plan emits — is a wizard router action', () => {
		expect(INSTALL_ROUTER_ACTIONS.length).toBeGreaterThanOrEqual(INSTALL_STEP_IDS.length);
		expect(INSTALL_STEP_IDS.filter((step) => !INSTALL_ROUTER_ACTIONS.includes(step))).toEqual([]);
		for (const answerCase of CASES) {
			const steps = cliPlan(answerCase.argv).steps;
			expect(steps.filter((step) => !INSTALL_ROUTER_ACTIONS.includes(step))).toEqual([]);
			expect(steps).toContain('install_hierarchies');
			// the ontology files are staged before the restore and imported right after it
			const order: InstallStepId[] = [
				'stage_ontologies',
				'install_db_from_default_file',
				'install_ontologies',
			];
			expect(steps.filter((step) => order.includes(step))).toEqual(order);
		}
	});
});

// ── (f) refusals and notes ───────────────────────────────────────────────────

describe('install plan — refusals and notes (f)', () => {
	test('an unknown flag (`--yes`) and a value flag without its value are ERRORS', () => {
		const invocation = answersFromCliArgs([...BASE_ARGV, '--yes', '--db-port', '--entity']);
		expect(invocation.errors).toContain('unknown flag --yes');
		expect(invocation.errors).toContain('--db-port needs a value');
		expect(invocation.errors).toContain('--entity needs a value');
	});

	test('the spawned CLI exits 1 on `--yes`, before touching anything', () => {
		const spawned = spawnPlan([...BASE_ARGV, '--yes']);
		expect(spawned.exitCode).toBe(1);
		const printed = JSON.parse(spawned.stdout.trim()) as { errors: string[] };
		expect(printed.errors).toContain('unknown flag --yes');
	});

	test('lg is dropped from the thesauri with a note; an unvendored tld is an error', () => {
		const withLg = cliPlan([...BASE_ARGV, '--hierarchies', 'lg,fr']);
		expect(withLg.hierarchies).toEqual(['fr']);
		expect(withLg.notes.some((note) => note.startsWith('lg is a core hierarchy'))).toBe(true);
		expect(withLg.errors).toEqual([]);
		const unknown = buildInstallPlan({ ...BASE_WIZARD, hierarchies: ['zzipv'] });
		expect(unknown.errors).toContain("unknown hierarchy 'zzipv' (no entry in hierarchy.json)");
	});

	test('every documented flag maps (the table is complete for the plan answers it names)', () => {
		const keyed = INSTALL_CLI_FLAGS.filter((spec) => spec.key !== null);
		expect(keyed.length).toBeGreaterThan(30);
		for (const spec of keyed) {
			const argv = spec.kind === 'value' ? [spec.flag, 'x'] : [spec.flag];
			const invocation = answersFromCliArgs(argv);
			expect(invocation.errors, spec.flag).toEqual([]);
			expect(Object.keys(invocation.raw), spec.flag).toEqual([spec.key as string]);
		}
	});
});

// ── (g) supervision is never configuration ──────────────────────────────────

describe('install plan — never DEDALO_SUPERVISED (g)', () => {
	test('no answer can make a plan own DEDALO_SUPERVISED', () => {
		const smuggled = {
			...BASE_WIZARD,
			...DIFFUSION_WIZARD,
			...MAILER_WIZARD,
			DEDALO_SUPERVISED: 'true',
			supervised: true,
			dedalo_supervised: 'true',
		};
		for (const raw of [smuggled, ...CASES.map((answerCase) => answerCase.wizard)]) {
			expect(buildInstallPlan(raw).envKeys).not.toContain('DEDALO_SUPERVISED');
		}
		const env = parseEnvFile(persistInChild(smuggled, scratchDir('smuggled')));
		expect(Object.keys(env).length).toBeGreaterThan(30);
		expect(env.DEDALO_SUPERVISED).toBeUndefined();
	});
});
