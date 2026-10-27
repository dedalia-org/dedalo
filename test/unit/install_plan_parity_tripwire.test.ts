/**
 * INSTALL PLAN PARITY TRIPWIRE — the flags, the answers record (the shape the
 * answers file and the interactive screens produce) and the answers FILE are
 * FRONT ENDS of one install plan (src/core/install/install_plan.ts; installer
 * unification A1/A3/A7, 2026-10-08), so the same answers must produce the same
 * install. (The browser wizard was a fourth front end until 2026-10-12 —
 * WC-2026-10-12-install-surface-removed; the plain and full-screen modes are
 * held to this same matrix by install_plain_parity / install_tui_parity.)
 *
 * WHY. Before the plan module each front end carried its own answers → .env
 * mapping and its own defaults, and they had drifted (measured): the CLI
 * defaulted the database host to `/tmp`, wrote an empty entity label,
 * installed no optional thesaurus while the old wizard pre-ticked three, silently
 * accepted `--yes` and any other unknown flag, and NO front end wrote
 * ONTOLOGY_SERVERS / CODE_SERVERS — every fresh install's update panels said
 * "No master servers are configured".
 *
 * WHAT IS MEASURED (outcomes, not spellings):
 *  (a) an answer matrix — base, +diffusion, +mailer, +serving keys, air-gapped,
 *      thesauri default / none / explicit / with the core `lg` — as an answers
 *      RECORD (its key names, its value shapes; the defaults read from
 *      install_plan / ontology_choice) and typed the CLI's way (argv through
 *      answersFromCliArgs): identical .env sections, keys, steps, thesauri.
 *  (b) ONE spawned `scripts/install.ts --plan` equals the in-process plan —
 *      the CLI really runs the module, not a copy of it;
 *  (c) persistConfig, run in two scratch private dirs from the CLI-derived and
 *      the raw record answers, writes .env files whose parsed keys AND values are
 *      identical except the generated DEDALO_SALT_STRING;
 *  (d) the default .env carries the official servers, and the plan's official
 *      constants equal the fenced examples the config catalog documents (one
 *      truth); air-gapped writes `[]`; a prior custom server list survives a
 *      non-air-gapped re-run verbatim, but a prior `[]` (an earlier air-gapped
 *      answer) yields to an official re-run;
 *  (e) every engine step any plan emits is a key of the ONE step table the
 *      executor runs (steps.ts INSTALL_STEPS);
 *  (f) unknown flags (`--yes`) and value flags without a value are errors and
 *      the spawned CLI exits 1; `lg` is dropped with a note; a tld hierarchy.json
 *      does not list is an error;
 *  (g) no plan, whatever the answers, owns DEDALO_SUPERVISED — supervision is
 *      declared by the process manager, never by ../private/.env;
 *  (h) DOMAIN ONTOLOGIES (A4/A5/A6, 2026-10-09): the default (no flag ≡ the
 *      record's default, DEFAULT_DOMAIN_ONTOLOGIES), an explicit `--ontologies oh`, a
 *      core TLD dropped with a note, `none` and an air-gapped non-vendored
 *      choice refused the same on both sides; a LOCAL fixture source (a
 *      package this gate builds into a mkdtemp dir — zz TLDs, a declared
 *      dependency chain): the spawned `--plan` equals the in-process plan over
 *      the resolved catalog (closure, ACTIVE_ONTOLOGY_TLDS), `--list-ontologies`
 *      prints exactly describeOntologyCatalog of it, persistConfig writes the
 *      same ACTIVE_ONTOLOGY_TLDS, and that written list maps back
 *      (ontologyRequestFromActive) to the very
 *      request the CLI plan stages.
 *  (i) DECLARED DEPENDENCIES (hierarchy60): every declared one pre-ticked —
 *      the core TLDs' declarations (vendoredCoreDeclarers) in EVERY plan, then
 *      the install order's, derived through the production functions;
 *      a mandatory ONTOLOGY never declinable; a THESAURUS never blocks (owner
 *      decision 2026-10-10) — a declined mandatory one, or one with no
 *      hierarchy.json entry, is a WARNING on both sides, never a plan error.
 *  (j) THE ANSWERS FILE (`--answers`, terminal installer 2026-10-11) is a third
 *      front end: every matrix case, written as a `dedalo.install.answers/1`
 *      file (its secrets apart — a file may not carry one, they ride
 *      DEDALO_INSTALL_*), decides exactly what the record decides; a
 *      spawned `--answers <file> --plan` prints the in-process plan; a key
 *      set by both the file and a flag is an error, never a silent winner;
 *      the run-control flags are front-end flags (key null) and their
 *      meaningless combinations are parser errors.
 *  (k) THE INSTALL FOLDER AND THE SERVICE ACCOUNT (owner decisions
 *      2026-10-12): defaults, a hosting account in its own folder, and that
 *      plus a group of its own — flags ≡ record ≡ answers file give the SAME
 *      plan hash; cliArgsOf round-trips each (the defaults emit no identity
 *      flag); the three flags are refused off production.
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
import {
	CORE_HIERARCHIES,
	hierarchyChoiceView,
	offeredHierarchies,
} from '../../src/core/install/hierarchy_meta.ts';
import {
	ANSWERS_FILE_SCHEMA,
	answersFromAnswersFile,
	answersFromCliArgs,
	buildInstallPlan,
	cliArgsOf,
	INSTALL_CLI_FLAGS,
	INSTALL_STEP_IDS,
	type InstallPlan,
	type InstallStepId,
	isInstallStepId,
	mergeAnswerSources,
	OFFICIAL_CODE_SERVER,
	OFFICIAL_ONTOLOGY_SERVER,
	PRODUCTION_HOST_STEP_IDS,
	SECRET_ANSWER_KEYS,
	STACK_HOST_STEP_IDS,
	TOPONYMY_SUGGESTION,
} from '../../src/core/install/install_plan.ts';
import {
	INSTALL_DEFAULT_LANG_CODES,
	INSTALL_LANG_CATALOG,
} from '../../src/core/install/lang_catalog.ts';
import { resolveOntologyCatalog } from '../../src/core/install/ontology_catalog.ts';
import {
	describeOntologyCatalog,
	offeredHierarchyTlds,
	ontologyRequestFromActive,
	vendoredOntologyCatalog,
} from '../../src/core/install/ontology_choice.ts';
import { buildPlanFile } from '../../src/core/install/run_files_core.ts';
import { INSTALL_STEPS } from '../../src/core/install/steps.ts';
import { CORE_ONTOLOGY_TLDS } from '../../src/core/ontology/core_tlds.ts';
import { buildOntologyPackage } from '../../src/core/test_data/ontology_package_fixture.ts';
import {
	BASE_ARGV,
	BASE_RECORD,
	CASES,
	DEFAULT_ONTOLOGIES,
	DIFFUSION_ARGV,
	DIFFUSION_RECORD,
	decided,
	declaredThesauri,
	MAILER_ARGV,
	MAILER_RECORD,
} from '../helpers/install_answer_cases.ts';

const ROOT = resolve(import.meta.dir, '../..');
const CLI = join(ROOT, 'scripts/install.ts');
const CONFIG_PERSIST = join(ROOT, 'src/core/install/config_persist.ts');
const scratchRoot = mkdtempSync(join(tmpdir(), 'dedalo_install_plan_parity_'));
afterAll(() => rmSync(scratchRoot, { recursive: true, force: true }));

/** The ONE step table's keys — what the executor can run. */
const EXECUTOR_STEPS: readonly string[] = Object.keys(INSTALL_STEPS);

/** What the core TLDs alone declare (every plan carries it). */
const CORE_DECLARED = declaredThesauri([]);
/** What the DEFAULT install (core + the default domain ontologies) declares. */
const DEFAULT_DECLARED = declaredThesauri(DEFAULT_ONTOLOGIES);

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

/**
 * Two real VENDORED thesauri (installer data read at run time, never records)
 * the core TLDs do NOT declare — so what the fixture declares is told apart
 * from what every plan carries.
 */
const [THESAURUS_REQUIRED, THESAURUS_OPTIONAL] = [...offeredHierarchyTlds()].filter(
	(tld) => !CORE_DECLARED.install.includes(tld),
) as [string, string];

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

// ── the answer matrix: test/helpers/install_answer_cases.ts (shared with the plain-mode gate) ──

function cliPlan(argv: readonly string[]): InstallPlan {
	const invocation = answersFromCliArgs(argv);
	expect(invocation.errors).toEqual([]);
	return buildInstallPlan(invocation.raw);
}

// ── child processes ──────────────────────────────────────────────────────────

/** Spawn the real CLI in --plan mode (touches nothing; an empty prior .env). */
function spawnPlan(
	argv: readonly string[],
	mode: '--plan' | '--list-ontologies' | '--list-hierarchies' | '--list-langs' = '--plan',
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
		},
		stdin: Buffer.from(JSON.stringify(answers)),
		stdout: 'pipe',
		stderr: 'pipe',
	});
	expect(proc.exitCode, `persistConfig child failed: ${proc.stderr.toString()}`).toBe(0);
	return readFileSync(join(privateDir, '.env'), 'utf8');
}

/** An .env's values with its own private dir spelled `<private>` (the runs' only legitimate difference). */
function privateRelative(env: Record<string, string>, privateDir: string): Record<string, string> {
	return Object.fromEntries(
		Object.entries(env).map(([key, value]) => [key, value.split(privateDir).join('<private>')]),
	);
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

// ── (a) flags ≡ record ───────────────────────────────────────────────────────

describe('install plan — flags ≡ record (a)', () => {
	test('the offer is real and the matrix is not vacuous', () => {
		expect(offeredHierarchies().length).toBeGreaterThan(0);
		expect(CASES.length).toBeGreaterThanOrEqual(8);
	});

	for (const answerCase of CASES) {
		test(`${answerCase.name}: same .env sections, keys, steps, thesauri`, () => {
			const fromCli = cliPlan(answerCase.argv);
			const fromRecord = buildInstallPlan(answerCase.record);
			expect(fromCli.errors).toEqual([]);
			expect(fromCli.envKeys.length).toBeGreaterThan(15);
			expect(decided(fromCli)).toEqual(decided(fromRecord));
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
		// The ONLY pre-selection is the release's declared thesauri (core + oh):
		// the default (an empty record) and `none` alike — never anything else.
		expect(DEFAULT_DECLARED.install.length, 'the release declares thesauri').toBeGreaterThan(0);
		expect(base.hierarchies).toEqual(DEFAULT_DECLARED.install);
		expect(base.hierarchyDependencies).toEqual(DEFAULT_DECLARED.dependencies);
		expect(cliPlan(CASES[5]?.argv ?? []).hierarchies).toEqual(DEFAULT_DECLARED.install);
		expect(buildInstallPlan(BASE_RECORD).hierarchies).toEqual(DEFAULT_DECLARED.install);
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
			entries: {
				tld: string;
				label: string;
				has_data: boolean;
				typology_id: number;
				dependencies: { tld: string; mandatory: boolean }[];
			}[];
			suggestion: string;
			errors: string[];
		};
		// The manifest offer, in THE order the screens show (hierarchyChoiceView: by name).
		const shown = hierarchyChoiceView('lg-eng').hierarchies;
		const offerOf = new Map(offeredHierarchies().map((entry) => [entry.tld, entry]));
		expect(shown.length).toBeGreaterThan(0);
		expect(new Set(shown.map((item) => item.tld))).toEqual(new Set(offerOf.keys()));
		expect(printed.core).toEqual(CORE_HIERARCHIES.map((item) => item.tld));
		expect(printed.entries.map((entry) => entry.tld)).toEqual(shown.map((item) => item.tld));
		expect(printed.entries.map((entry) => entry.label)).toEqual(shown.map((item) => item.label));
		expect(printed.entries.map((entry) => entry.has_data)).toEqual(
			shown.map((item) => (offerOf.get(item.tld)?.data_files.length ?? 0) > 0),
		);
		expect(printed.suggestion).toBe(TOPONYMY_SUGGESTION);
		expect(printed.errors).toHaveLength(0);
		// Each entry's DECLARED thesauri (hierarchy60), from THE view the screens read.
		expect(printed.entries.map((entry) => entry.dependencies)).toEqual(
			shown.map((item) => item.dependencies),
		);
	});

	test('`scripts/install.ts --list-langs` prints the language offer and the default set', () => {
		const listed = spawnPlan([], '--list-langs');
		expect(listed.exitCode, listed.stderr).toBe(0);
		const printed = JSON.parse(listed.stdout.trim()) as {
			langs: { code: string; label: string }[];
			default: string[];
			errors: string[];
		};
		expect(printed.langs).toEqual(
			Object.entries(INSTALL_LANG_CATALOG).map(([code, label]) => ({ code, label })),
		);
		expect(printed.default).toEqual([...INSTALL_DEFAULT_LANG_CODES]);
		// The default set is what a plan with no language answer installs (one truth).
		expect(cliPlan(BASE_ARGV.slice(0, 2)).langConfig.projectsDefaultLangs).toEqual(printed.default);
		expect(printed.errors).toEqual([]);
	});
});

// ── (c) + (d) the written .env ───────────────────────────────────────────────

describe('install plan — the written .env (c, d)', () => {
	test('CLI-derived (plan-normalized) and raw record answers write the same .env (salt aside)', () => {
		const answerCase = {
			argv: [...BASE_ARGV, ...DIFFUSION_ARGV, ...MAILER_ARGV],
			record: { ...BASE_RECORD, ...DIFFUSION_RECORD, ...MAILER_RECORD },
		};
		// The CLI hands persistConfig the plan's normalized answers (scripts/install.ts).
		const cliAnswers = { ...cliPlan(answerCase.argv).answers };
		const cliDir = scratchDir('cli');
		const recordDir = scratchDir('record');
		const cliEnv = privateRelative(parseEnvFile(persistInChild(cliAnswers, cliDir)), cliDir);
		const recordEnv = privateRelative(
			parseEnvFile(persistInChild(answerCase.record, recordDir)),
			recordDir,
		);
		// The developer listener's local-CA pair lives in EACH install's own private
		// dir (DEV_ROUTE_SERVE §1.2): the two runs differ only by that prefix.
		expect(recordEnv.SERVER_TCP_TLS_CERT_FILE).toBe('<private>/tls/fullchain.pem');
		expect(Object.keys(cliEnv).length).toBeGreaterThan(30);
		expect(cliEnv.DEDALO_SALT_STRING).toMatch(/^[0-9a-f]{64}$/);
		const { DEDALO_SALT_STRING: _cliSalt, ...cliRest } = cliEnv;
		const { DEDALO_SALT_STRING: _recordSalt, ...recordRest } = recordEnv;
		expect(cliRest).toEqual(recordRest);
		// The default domain ontology, after the core — and that written list maps
		// back to the very request the CLI stages.
		const active = JSON.parse(recordEnv.ACTIVE_ONTOLOGY_TLDS as string) as string[];
		expect(active).toEqual([...CORE_ONTOLOGY_TLDS, ...DEFAULT_ONTOLOGIES]);
		const back = ontologyRequestFromActive(active, vendoredOntologyCatalog());
		expect(back.errors).toEqual([]);
		expect(back.request).toEqual(cliPlan(answerCase.argv).ontologyRequest);
	});

	test('the default .env carries the official servers — the SAME entries the catalog documents', () => {
		expect([OFFICIAL_ONTOLOGY_SERVER]).toEqual(catalogExample('ONTOLOGY_SERVERS') as never);
		expect([OFFICIAL_CODE_SERVER]).toEqual(catalogExample('CODE_SERVERS') as never);
		const env = parseEnvFile(persistInChild(BASE_RECORD, scratchDir('default')));
		expect(JSON.parse(env.ONTOLOGY_SERVERS as string)).toEqual([OFFICIAL_ONTOLOGY_SERVER]);
		expect(JSON.parse(env.CODE_SERVERS as string)).toEqual([OFFICIAL_CODE_SERVER]);
	});

	test('air-gapped writes [] for both lists', () => {
		const env = parseEnvFile(
			persistInChild({ ...BASE_RECORD, update_servers: false }, scratchDir('airgapped')),
		);
		expect(JSON.parse(env.ONTOLOGY_SERVERS as string)).toEqual([]);
		expect(JSON.parse(env.CODE_SERVERS as string)).toEqual([]);
	});

	test('a prior custom server list survives a non-air-gapped re-run verbatim', () => {
		const dir = scratchDir('mirror');
		const mirror =
			'ONTOLOGY_SERVERS=[{"name":"Mirror","url":"https://mirror.example.org/dedalo/core/api/v1/json/","code":"m1"}]';
		writeFileSync(join(dir, '.env'), `DEDALO_SALT_STRING=deadbeef\n${mirror}\n`);
		const body = persistInChild(BASE_RECORD, dir);
		const lines = body.split('\n');
		expect(lines.filter((line) => line.startsWith('ONTOLOGY_SERVERS='))).toEqual([mirror]);
		// The list the operator did not customise is still written official.
		expect(JSON.parse(parseEnvFile(body).CODE_SERVERS as string)).toEqual([OFFICIAL_CODE_SERVER]);
	});

	// A re-run after an air-gapped install, answering the official server. The
	// earlier `[]` is an ANSWER, not a mirror — keeping it would leave the install
	// offline while the operator answered the official server. Same for an
	// unparseable prior value.
	test('an official re-run after an air-gapped one writes the official lists (a prior [] is not preserved)', () => {
		const dir = scratchDir('airgapped_then_official');
		writeFileSync(
			join(dir, '.env'),
			'DEDALO_SALT_STRING=deadbeef\nONTOLOGY_SERVERS=[]\nCODE_SERVERS=not-json\n',
		);
		const body = persistInChild(BASE_RECORD, dir);
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
		const env = parseEnvFile(persistInChild({ ...BASE_RECORD, update_servers: false }, dir));
		expect(JSON.parse(env.ONTOLOGY_SERVERS as string)).toEqual([]);
	});
});

// ── (h) domain ontologies ────────────────────────────────────────────────────

describe('install plan — domain ontologies (h)', () => {
	test('the default is DEFAULT_DOMAIN_ONTOLOGIES, installed from the vendored file', () => {
		const plan = cliPlan(BASE_ARGV);
		expect(DEFAULT_ONTOLOGIES).toEqual(['oh']);
		expect(plan.ontologies).toEqual(DEFAULT_ONTOLOGIES);
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
		expect(buildInstallPlan({ ...BASE_RECORD, ontologies: [] }).errors).toContain(none);
		const spawned = spawnPlan([...BASE_ARGV, '--ontologies', 'none']);
		expect(spawned.exitCode).toBe(1);
		expect((JSON.parse(spawned.stdout.trim()) as { errors: string[] }).errors).toContain(none);
	});

	test('air-gapped + a non-vendored TLD: the same refusal on both sides', () => {
		const refusal =
			"unknown ontology 'tch' — not offered by the built-in set (air-gapped: only oh is available offline)";
		const cli = cliPlan([...BASE_ARGV, '--no-update-servers', '--ontologies', 'oh,tch']);
		const record = buildInstallPlan({
			...BASE_RECORD,
			update_servers: false,
			ontologies: ['oh', 'tch'],
		});
		expect(cli.errors).toContain(refusal);
		expect(decided(cli)).toEqual(decided(record));
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
			// The core TLDs' declared thesauri (every plan), then the fixture's.
			const declared = declaredThesauri(['zzqd', 'zzqc'], resolved.catalog);
			expect(declared.dependencies).toEqual([
				...CORE_DECLARED.dependencies,
				{ tld: THESAURUS_REQUIRED, mandatory: true, dependants: ['zzqc'] },
				{ tld: THESAURUS_OPTIONAL, mandatory: false, dependants: ['zzqc'] },
			]);
			expect(ticked.hierarchies).toEqual([
				...CORE_DECLARED.install,
				THESAURUS_REQUIRED,
				THESAURUS_OPTIONAL,
			]);
			expect(ticked.hierarchyDependencies).toEqual(declared.dependencies);

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
			// only the core TLDs' declared thesauri remain (none of them declined)
			expect(cli.hierarchies).toEqual(CORE_DECLARED.install);
			expect(cli.notes).toContain(
				"the ontology 'zzqd' (an optional dependency of 'zzqc') is declined — not installed",
			);
			expect(cli.warnings).toContain(
				`the thesaurus '${THESAURUS_REQUIRED}' (declared mandatory by 'zzqc') is declined — not installed; it is strongly recommended and can be installed later from Maintenance › Install hierarchies`,
			);
			// the record carries the same answer as a list: the same plan
			const record = buildInstallPlan(
				{
					...answersFromCliArgs(declineArgv).raw,
					declined_dependencies: ['zzqd', THESAURUS_REQUIRED, `${THESAURUS_OPTIONAL}:hierarchy1`],
				},
				{ ontologyCatalog: resolved.catalog },
			);
			expect(decided(record)).toEqual(decided(cli));
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

describe('install plan — every engine step is in the ONE step table (e)', () => {
	test('every INSTALL_STEP_ID — and every step any plan emits — is a key of INSTALL_STEPS', () => {
		expect(INSTALL_STEP_IDS.filter((step) => !EXECUTOR_STEPS.includes(step))).toEqual([]);
		for (const answerCase of CASES) {
			const steps = cliPlan(answerCase.argv).steps;
			// Phase 4: these cases are the developer route — ENGINE steps only (the host
			// routes' host_*/stack_* steps are the host tables': (e2)).
			expect(steps.filter((step) => !isInstallStepId(step))).toEqual([]);
			expect(
				steps.filter((step) => !isInstallStepId(step) || !EXECUTOR_STEPS.includes(step)),
			).toEqual([]);
			expect(steps).toContain('install_hierarchies');
			// the ontology files are staged before the restore and imported right after it
			const order: InstallStepId[] = [
				'stage_ontologies',
				'install_db_from_default_file',
				'install_ontologies',
			];
			expect(steps.filter((step) => (order as readonly string[]).includes(step))).toEqual(order);
		}
	});
});

describe('install plan — the host routes plan host steps; their engine child plans engine steps (e2)', () => {
	const IDENTITY = ['--entity', 'parity', '--langs', 'lg-spa,lg-eng', '--app-lang', 'lg-spa'];
	const HOST_ARGV = [
		'--server-name',
		'prado.example.org',
		'--letsencrypt-email',
		'ops@example.org',
	];
	const ROUTES: readonly { route: string; argv: string[]; ids: readonly string[] }[] = [
		{
			route: 'production',
			argv: ['--route', 'production', '--instance', 'prado', ...HOST_ARGV],
			ids: PRODUCTION_HOST_STEP_IDS,
		},
		{ route: 'docker', argv: ['--route', 'docker', ...HOST_ARGV], ids: STACK_HOST_STEP_IDS },
		{ route: 'trial', argv: ['--route', 'trial'], ids: STACK_HOST_STEP_IDS },
	];
	for (const { route, argv, ids } of ROUTES) {
		test(`${route}: every step is a host step of its table; --engine-only plans the executor's engine steps`, () => {
			const host = cliPlan([...IDENTITY, ...argv]);
			expect(host.errors).toEqual([]);
			expect(host.steps.length).toBeGreaterThan(5);
			expect(host.steps.filter((step) => !ids.includes(step))).toEqual([]);
			const child = cliPlan([...IDENTITY, ...argv, '--engine-only']);
			expect(child.errors).toEqual([]);
			expect(
				child.steps.filter((step) => !isInstallStepId(step) || !EXECUTOR_STEPS.includes(step)),
			).toEqual([]);
			expect(child.steps).toContain('install_db_from_default_file');
		});
	}
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
		// the answer first, then the release's declared thesauri
		expect(withLg.hierarchies).toEqual([
			'fr',
			...DEFAULT_DECLARED.install.filter((tld) => tld !== 'fr'),
		]);
		expect(withLg.notes.some((note) => note.startsWith('lg is a core hierarchy'))).toBe(true);
		expect(withLg.errors).toEqual([]);
		const unknown = buildInstallPlan({ ...BASE_RECORD, hierarchies: ['zzipv'] });
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

// ── (j) the answers file is a third front end ────────────────────────────────

/** An answers record as an answers file's raw answers: the envelope, its secrets apart. */
function answersFileRaw(record: Record<string, unknown>): Record<string, unknown> {
	const plain = Object.fromEntries(
		Object.entries(record).filter(
			([key]) => !(SECRET_ANSWER_KEYS as readonly string[]).includes(key),
		),
	);
	const parsed = answersFromAnswersFile(
		JSON.parse(JSON.stringify({ schema: ANSWERS_FILE_SCHEMA, answers: plain })),
	);
	expect(parsed.errors).toEqual([]);
	return parsed.raw;
}

/** The secret answers of a record (what DEDALO_INSTALL_* carries beside a file). */
function secretsOf(record: Record<string, unknown>): Record<string, unknown> {
	return Object.fromEntries(
		Object.entries(record).filter(([key]) =>
			(SECRET_ANSWER_KEYS as readonly string[]).includes(key),
		),
	);
}

describe('install plan — the answers file decides what the record decides (j)', () => {
	for (const answerCase of CASES) {
		test(`${answerCase.name}: answers file (+ its secrets) ≡ record`, () => {
			const fromFile = buildInstallPlan({
				...answersFileRaw(answerCase.record),
				...secretsOf(answerCase.record),
			});
			expect(fromFile.errors).toEqual([]);
			expect(decided(fromFile)).toEqual(decided(buildInstallPlan(answerCase.record)));
		});
	}

	test('a spawned `--answers <file> --plan` prints the in-process plan (secrets through the environment)', () => {
		const record: Record<string, unknown> = {
			...BASE_RECORD,
			...DIFFUSION_RECORD,
			hierarchies: ['ad'],
		};
		const dir = scratchDir('answers_file');
		const file = join(dir, 'answers.json');
		writeFileSync(
			file,
			JSON.stringify({ schema: ANSWERS_FILE_SCHEMA, answers: answersFileRaw(record) }),
		);
		const proc = Bun.spawnSync([process.execPath, 'run', CLI, '--plan', '--answers', file], {
			cwd: ROOT,
			env: {
				...Bun.env,
				DEDALO_INSTALL_PRIVATE_DIR: EMPTY_PRIVATE,
				DEDALO_INSTALL_DB_PASSWORD: String(record.db_password),
				DEDALO_INSTALL_MYSQL_PASSWORD: String(record.mysql_password),
			},
			stdout: 'pipe',
			stderr: 'pipe',
		});
		expect(proc.exitCode, proc.stderr.toString()).toBe(0);
		const printed = JSON.parse(proc.stdout.toString().trim()) as Record<string, unknown>;
		expect(printed).toEqual(printedPlan(buildInstallPlan(record), []));
		expect(printed.steps).toContain('test_diffusion_connection');
	});

	test('a key set by the file AND a flag is an error naming both — never a silent winner', () => {
		const flags = answersFromCliArgs(BASE_ARGV).raw;
		const merged = mergeAnswerSources(flags, answersFileRaw(BASE_RECORD));
		expect(merged.errors).toContain('db_database is set by both --answers and --db-name');
		expect(merged.errors).toContain('entity is set by both --answers and --entity');
		const disjoint = mergeAnswerSources({ entity: 'x' }, { db_database: 'y' });
		expect(disjoint).toEqual({ raw: { db_database: 'y', entity: 'x' }, errors: [] });
	});

	test('an answers file refuses a wrong schema, an unknown key and every secret key', () => {
		expect(answersFromAnswersFile({ answers: {} }).errors).toEqual([
			`answers file: schema must be ${ANSWERS_FILE_SCHEMA}`,
		]);
		expect(
			answersFromAnswersFile({ schema: ANSWERS_FILE_SCHEMA, answers: { yes: true } }).errors,
		).toEqual(["answers file: unknown key 'yes'"]);
		for (const key of SECRET_ANSWER_KEYS) {
			const parsed = answersFromAnswersFile({
				schema: ANSWERS_FILE_SCHEMA,
				answers: { [key]: 'v' },
			});
			expect(parsed.raw).toEqual({});
			expect(parsed.errors[0]).toStartWith(`answers file: '${key}' is a secret`);
		}
	});

	test('the run-control flags set no answer, and their meaningless combinations are parser errors', () => {
		for (const flag of [
			'--answers',
			'--resume',
			'--abort',
			'--confirm-database',
			'--secrets-stdin',
			'--execute',
			'--plain',
			'--write-answers',
			'--list-langs',
		]) {
			const spec = INSTALL_CLI_FLAGS.find((candidate) => candidate.flag === flag);
			expect(spec, flag).toBeDefined();
			expect(spec?.key, flag).toBeNull();
			const invocation = answersFromCliArgs(spec?.kind === 'value' ? [flag, 'v'] : [flag]);
			expect(invocation.raw, flag).toEqual({});
		}
		const refused: [string[], string][] = [
			[['--resume', '--abort'], '--resume and --abort exclude each other'],
			[['--plan', '--resume'], '--plan cannot be combined with --resume or --abort'],
			[['--list-ontologies', '--abort'], '--list-* cannot be combined with --resume or --abort'],
			[['--confirm-database', 'x'], '--confirm-database is only meaningful with --abort'],
			[['--list-langs', '--resume'], '--list-* cannot be combined with --resume or --abort'],
			[['--plain', '--abort'], '--plain cannot be combined with --abort'],
			[
				['--plain', '--entity', 'x'],
				'--entity cannot be combined with --plain: give the answers on the interactive screens — --plain is the interactive front end and takes no answer flag, --answers, --plan, --list-*, --secrets-stdin, --execute or --root-password',
			],
			[
				['--plain', '--answers', 'a.json'],
				'--answers cannot be combined with --plain: give the answers on the interactive screens — --plain is the interactive front end and takes no answer flag, --answers, --plan, --list-*, --secrets-stdin, --execute or --root-password',
			],
			[
				['--plain', '--route', 'docker'],
				'--route cannot be combined with --plain: give the answers on the interactive screens — --plain is the interactive front end and takes no answer flag, --answers, --plan, --list-*, --secrets-stdin, --execute or --root-password',
			],
			[
				['--plain', '--entity', 'x', '--route', 'docker', '--plan'],
				'--entity, --route, --plan cannot be combined with --plain: give the answers on the interactive screens — --plain is the interactive front end and takes no answer flag, --answers, --plan, --list-*, --secrets-stdin, --execute or --root-password',
			],
			[
				['--write-answers', 'a.json', '--resume'],
				'--write-answers cannot be combined with --resume, --abort or --list-*',
			],
			[
				['--write-answers', 'a.json', '--list-hierarchies'],
				'--write-answers cannot be combined with --resume, --abort or --list-*',
			],
		];
		for (const [argv, error] of refused) {
			expect(answersFromCliArgs(argv).errors, argv.join(' ')).toContain(error);
		}
		expect(answersFromCliArgs(['--abort', '--confirm-database', 'x']).errors).toEqual([]);
		// --plain may join --resume (it prompts the secrets a resume needs) and --write-answers.
		expect(answersFromCliArgs(['--plain', '--resume']).errors).toEqual([]);
		expect(answersFromCliArgs(['--plain', '--write-answers', 'a.json']).errors).toEqual([]);
		// `--flag=value` carries ANY value — one starting with `--` included (cliArgsOf emits it).
		expect(answersFromCliArgs(['--entity-label=--x y']).raw).toEqual({ entity_label: '--x y' });
		expect(answersFromCliArgs(['--entity-label', '--x']).errors).toContain(
			'--entity-label needs a value',
		);
		expect(answersFromCliArgs(['--diffusion=yes']).errors).toContain('--diffusion takes no value');
	});
});

// ── (g) supervision is never configuration ──────────────────────────────────

describe('install plan — never DEDALO_SUPERVISED (g)', () => {
	test('no answer can make a plan own DEDALO_SUPERVISED', () => {
		const smuggled = {
			...BASE_RECORD,
			...DIFFUSION_RECORD,
			...MAILER_RECORD,
			DEDALO_SUPERVISED: 'true',
			supervised: true,
			dedalo_supervised: 'true',
		};
		for (const raw of [smuggled, ...CASES.map((answerCase) => answerCase.record)]) {
			expect(buildInstallPlan(raw).envKeys).not.toContain('DEDALO_SUPERVISED');
		}
		const env = parseEnvFile(persistInChild(smuggled, scratchDir('smuggled')));
		expect(Object.keys(env).length).toBeGreaterThan(30);
		expect(env.DEDALO_SUPERVISED).toBeUndefined();
	});
});

// ── (k) the install folder and the service account ──────────────────────────

/** The production answers every identity case shares. */
const PRODUCTION_IDENTITY_BASE: Record<string, unknown> = {
	route: 'production',
	instance: 'prado',
	entity: 'parity',
	server_name: 'prado.example.org',
	letsencrypt_email: 'ops@example.org',
};

/** The identity cases: record, the argv a typist gives, and the plan's resolved values. */
const IDENTITY_CASES: readonly {
	name: string;
	record: Record<string, unknown>;
	argv: string[];
	resolved: Record<string, string>;
}[] = [
	{
		name: 'defaults',
		record: {},
		argv: [],
		resolved: {
			install_dir: '/home/ded_prado',
			service_user: 'ded_prado',
			service_group: '',
			backup_dir: '/home/ded_prado/backups',
			db_username: 'ded_prado',
		},
	},
	{
		name: 'a hosting account in a folder of its own',
		record: { install_dir: '/home/drill.example.org/dedalo', service_user: 'drill.example.org' },
		argv: [
			'--install-dir',
			'/home/drill.example.org/dedalo',
			'--service-user',
			'drill.example.org',
		],
		resolved: {
			install_dir: '/home/drill.example.org/dedalo',
			service_user: 'drill.example.org',
			service_group: '',
			backup_dir: '/home/drill.example.org/dedalo/backups',
			db_username: 'drill.example.org',
		},
	},
	{
		name: 'a hosting account + a group of its own',
		record: {
			install_dir: '/home/drill.example.org/dedalo',
			service_user: 'drill.example.org',
			service_group: 'webgrp',
		},
		argv: [
			'--install-dir',
			'/home/drill.example.org/dedalo',
			'--service-user',
			'drill.example.org',
			'--service-group',
			'webgrp',
		],
		resolved: {
			install_dir: '/home/drill.example.org/dedalo',
			service_user: 'drill.example.org',
			service_group: 'webgrp',
			backup_dir: '/home/drill.example.org/dedalo/backups',
			db_username: 'drill.example.org',
		},
	},
];

const IDENTITY_FLAGS = ['--install-dir', '--service-user', '--service-group'];
const IDENTITY_SECRETS = { root_password: 'Mosaic-Kestrel-Harbor-47' };

/** The plan hash a run would freeze for `raw`. */
function identityHash(raw: Record<string, unknown>): string {
	const plan = buildInstallPlan(raw);
	expect(plan.errors).toEqual([]);
	return buildPlanFile(plan, IDENTITY_SECRETS).plan_hash;
}

describe('install plan — the install folder and the service account (k)', () => {
	for (const item of IDENTITY_CASES) {
		test(`${item.name}: flags ≡ record ≡ answers file (one plan hash); cliArgsOf round-trips`, () => {
			const record = { ...PRODUCTION_IDENTITY_BASE, ...item.record };
			const base = cliArgsOf(buildInstallPlan(PRODUCTION_IDENTITY_BASE).answers);
			const viaFlags = answersFromCliArgs([...base, ...item.argv]);
			expect(viaFlags.errors).toEqual([]);
			const hash = identityHash(record);
			expect(identityHash(viaFlags.raw)).toBe(hash);
			expect(identityHash(answersFileRaw(record))).toBe(hash);
			const plan = buildInstallPlan(record);
			const picked = Object.fromEntries(
				Object.keys(item.resolved).map((key) => [
					key,
					plan.answers[key as keyof typeof plan.answers],
				]),
			);
			expect(picked).toEqual(item.resolved);
			const argv = cliArgsOf(plan.answers);
			const roundTrip = answersFromCliArgs(argv);
			expect(roundTrip.errors).toEqual([]);
			expect(identityHash(roundTrip.raw)).toBe(hash);
			// A default is never spelled out: only what the operator changed is a flag.
			const emitted = IDENTITY_FLAGS.filter((flag) => argv.some((token) => token.startsWith(flag)));
			expect(emitted).toEqual(IDENTITY_FLAGS.filter((flag) => item.argv.includes(flag)));
		});
	}

	test('the cases differ in their plan hash (the matrix is not vacuous)', () => {
		const hashes = IDENTITY_CASES.map((item) =>
			identityHash({ ...PRODUCTION_IDENTITY_BASE, ...item.record }),
		);
		expect(new Set(hashes).size).toBe(IDENTITY_CASES.length);
	});

	test('the three keys are refused off production, by the plan, with their sentence', () => {
		for (const route of ['developer', 'docker', 'trial'] as const) {
			const errors = buildInstallPlan({
				route,
				entity: 'parity',
				install_dir: '/home/x/dedalo',
				service_user: 'x',
				service_group: 'y',
			}).errors;
			for (const key of ['install_dir', 'service_user', 'service_group'])
				expect(errors, `${route} ${key}`).toContain(
					`${key} is only meaningful on the production route (route is ${route})`,
				);
		}
	});
});
