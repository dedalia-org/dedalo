/**
 * P5 gate (E2E) — the full TS-native install via the CLI, ending in a real root
 * login. Spawns scripts/install.ts against a throwaway Postgres database with
 * ALL writes redirected to a scratch dir (private/.env, state, sessions), so the
 * live install is never touched. Proves the entire PHP-free path:
 *   pre-flight → db connection → .env → directories → seed restore (+ core
 *   hierarchy activation) → Argon2id root pw → optional thesauri → seal → root
 *   login verified.
 *
 * And, since the installer unification (2026-10-08), what the install LEAVES:
 *  - the step lines the CLI prints are exactly the steps its own `--plan`
 *    announces (the CLI runs the shared plan, not a private sequence);
 *  - Languages (lg) is ACTIVE (hierarchy4 → dd64/1) with ZERO lg rows in
 *    matrix_hierarchy — activated against the seed's matrix_langs terms, never
 *    imported;
 *  - the chosen thesaurus (2026-10-10: there is NO default thesaurus set — the
 *    gate picks the smallest data-carrying entry of the vendored hierarchy.json
 *    at run time) is imported checksum-verified, its registry row CREATED from
 *    the manifest entry (the seed ships only lg's): active, hierarchy8 =
 *    lg1/<lang.section_id>, hierarchy109 as the entry names it, terms in;
 *  - the thesauri the release DECLARES (the core TLDs' + the default domain
 *    ontology's — derived through the production functions) follow it in the
 *    plan and are active too: a data-less entry as an EMPTY thesaurus (its root);
 *  - the written .env carries the official ONTOLOGY_SERVERS / CODE_SERVERS
 *    and no DEDALO_SUPERVISED.
 * And, since the core-only seed + domain ontology choice (2026-10-09):
 *  - the ontologies installed are the core, the DEFAULT domain ontology (no
 *    --ontologies given) and the engine's own — plus only what the thesaurus
 *    step provisions (the chosen hierarchies and their two typology groupers);
 *    NO test TLD row and NO test3 record (installations carry no fixture);
 *  - the default domain ontology came from its ONE vendored file: its `<tld>0`
 *    record count equals that file's line count (tipo BUILT, never spelled);
 *  - the written ACTIVE_ONTOLOGY_TLDS is core + default, in that order;
 *  - the derived relation index is FILLED (the seed ships it empty, the restore
 *    door refills it) and the ontology staging dir is gone (success cleans up).
 * The thesaurus import is why the first case's timeout is generous — measured,
 * never narrowed by passing `--hierarchies none`.
 *
 * Skips loudly when no admin Postgres connection is available.
 *
 * CRASH TEARDOWN: `afterAll` is not a guarantee — a killed process runs no
 * code — so every DROP here is `WITH (FORCE)` and `beforeAll` first sweeps
 * this gate's own orphaned `<prefix><dead pid>` scratch databases through the
 * SHARED helper (test/helpers/scratch_database.ts — ONE implementation; its
 * header carries the measured incident, `dedalo_install_p4_48373`, 218 MB, the
 * refusal grammar, and what the sweep does NOT prove).
 * It also says nothing about the scratch DIRECTORY this gate makes under the
 * system temp dir, which has its own teardown and its own leak.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { config } from '../../src/config/config.ts';
import { parseEnvFile } from '../../src/config/env.ts';
import { offeredHierarchies } from '../../src/core/install/hierarchy_meta.ts';
import {
	OFFICIAL_CODE_SERVER,
	OFFICIAL_ONTOLOGY_SERVER,
} from '../../src/core/install/install_plan.ts';
import {
	collectHierarchyDependencies,
	DEFAULT_DOMAIN_ONTOLOGIES,
	declarersOf,
	hierarchyDependencyPlan,
	vendoredCoreDeclarers,
	vendoredOntologyCatalog,
} from '../../src/core/install/ontology_choice.ts';
import {
	HIERARCHY_IMPORT_DIR,
	installOntologyStagingDir,
	installPrivateDir,
	VENDORED_ONTOLOGY_DIR,
} from '../../src/core/install/paths.ts';
import type { DbConnDescriptor } from '../../src/core/install/pg_exec.ts';
import { runPsql } from '../../src/core/install/pg_exec.ts';
import { CORE_ONTOLOGY_TLDS } from '../../src/core/ontology/core_tlds.ts';
import { ENGINE_TLD } from '../../src/core/ontology/engine_ontology.ts';
import {
	HIERARCHY_MODEL_TYPE_TLD,
	HIERARCHY_TYPE_TLD,
} from '../../src/core/ontology/ontology_tipos.ts';
import { sweepOrphanScratchDatabases } from '../helpers/scratch_database.ts';

const SCRATCH_PREFIX = 'dedalo_install_e2e_';
const SCRATCH_DB = `${SCRATCH_PREFIX}${process.pid}`;
const CLI = resolve(import.meta.dir, '../../scripts/install.ts');
const scratchDir = mkdtempSync(join(tmpdir(), 'dedalo_install_e2e_'));

const admin: DbConnDescriptor = {
	database: 'postgres',
	host: config.db.host,
	port: config.db.port,
	user: config.db.user,
	password: config.db.password,
};

/**
 * DECIDED AT MODULE TOP LEVEL, BEFORE ANY `test.if` IS REGISTERED. `test.if(x)`
 * reads `x` when the test is DECLARED — during collection, long before any
 * `beforeAll` runs — so a flag a hook sets is always its initial `false`: from
 * P2-19 until 2026-10-08 this gate set `available` in `beforeAll` and both cases
 * SKIPPED on every machine, the admin connection notwithstanding (and nobody saw
 * that its root password failed the policy). The probe asks the one thing the
 * gate needs: can this role create a database. Creating it stays in `beforeAll`,
 * so collecting the file (a filtered run) creates nothing; a CREATE that then
 * fails is a red, not a skip — the probe said it would work.
 */
async function adminCanCreateDatabase(): Promise<boolean> {
	const probe = await runPsql(admin, [
		'-tAc',
		'SELECT rolcreatedb OR rolsuper FROM pg_roles WHERE rolname = current_user',
	]);
	return probe.exitCode === 0 && probe.stdout.trim() === 't';
}
const available = await adminCanCreateDatabase();

// Crash teardown: the sweep lives ONCE in test/helpers/scratch_database.ts —
// its header carries the measured incident, the refusal grammar, and what the
// sweep does not prove.
beforeAll(async () => {
	if (!available) return;
	// Reclaim what a killed predecessor could not (see the header).
	await sweepOrphanScratchDatabases(admin, SCRATCH_PREFIX);
	await runPsql(admin, ['-c', `DROP DATABASE IF EXISTS "${SCRATCH_DB}" WITH (FORCE)`]);
	const created = await runPsql(admin, ['-c', `CREATE DATABASE "${SCRATCH_DB}"`]);
	expect(created.exitCode, `CREATE DATABASE ${SCRATCH_DB}: ${created.stderr}`).toBe(0);
});

afterAll(async () => {
	if (available)
		await runPsql(admin, ['-c', `DROP DATABASE IF EXISTS "${SCRATCH_DB}" WITH (FORCE)`]);
	rmSync(scratchDir, { recursive: true, force: true });
});

/**
 * The thesaurus every run installs: the vendored entry with the SMALLEST data
 * file (read from the release at run time, never a spelled tld) — enough to
 * prove the checksum-verified import and the creation of its registry row.
 */
const CHOSEN_THESAURUS = (() => {
	const withData = offeredHierarchies().filter((entry) => entry.data_files.length > 0);
	const sized = withData.map((entry) => ({
		entry,
		bytes: entry.data_files.reduce(
			(sum, item) => sum + Bun.file(join(HIERARCHY_IMPORT_DIR, item.file)).size,
			0,
		),
	}));
	sized.sort((a, b) => a.bytes - b.bytes || a.entry.tld.localeCompare(b.entry.tld));
	return sized[0]?.entry;
})();

/**
 * The thesauri the RELEASE declares for the default install — the core TLDs'
 * (every plan) then the default domain ontologies' — the vendored ones the plan
 * pre-ticks, derived through the production functions (never a spelled list).
 */
const DECLARED_THESAURI = hierarchyDependencyPlan(
	collectHierarchyDependencies([
		...vendoredCoreDeclarers(),
		...declarersOf(DEFAULT_DOMAIN_ONTOLOGIES, vendoredOntologyCatalog()),
	]).dependencies,
).install;

/** The answers every run gives. */
function cliArgs(): string[] {
	return [
		'--hierarchies',
		CHOSEN_THESAURUS?.tld ?? 'none',
		'--db-name',
		SCRATCH_DB,
		'--db-user',
		config.db.user,
		'--db-host',
		config.db.host,
		'--db-port',
		String(config.db.port),
		// The admin connection's own password, when it has one: a runner's Postgres
		// (md5/scram) asks for it, where a desk's trust/.pgpass setup does not — without
		// it the CLI's connection check is refused on CI and passes here (2026-10-09).
		...(config.db.password ? ['--db-password', config.db.password] : []),
		'--entity',
		'e2etest',
		'--root-password',
		// Must pass the ONE password policy (src/core/security/password_policy.ts):
		// set_root_pw enforces it, and the old 'RootPw12345' failed it ('sequence').
		'Mosaic-Kestrel-Harbor-47',
		'--skip-tools',
	];
}

/** Run the install CLI against the scratch DB with fully redirected writes. */
function runCli(extraArgs: string[] = []): { exitCode: number; out: string } {
	const proc = Bun.spawnSync(['bun', 'run', CLI, ...cliArgs(), ...extraArgs], {
		env: {
			...process.env,
			DEDALO_INSTALL_PRIVATE_DIR: scratchDir,
			DEDALO_TS_STATE_PATH: join(scratchDir, 'ts_state.json'),
			DEDALO_SESSION_DB_PATH: join(scratchDir, 'sessions.sqlite'),
		},
		stdout: 'pipe',
		stderr: 'pipe',
	});
	return {
		exitCode: proc.exitCode,
		out: proc.stdout.toString() + proc.stderr.toString(),
	};
}

const scratchConn = (): DbConnDescriptor => ({ ...admin, database: SCRATCH_DB });

/** One scalar from the scratch install's database. */
async function scratchScalar(query: string): Promise<string> {
	const res = await runPsql(scratchConn(), ['-tAc', query]);
	expect(res.exitCode, res.stderr).toBe(0);
	return res.stdout.trim();
}

/** The hierarchy1 registry record of a tld: its active flag's dd64 section_id. */
function registryActiveSql(tld: string): string {
	return `SELECT relation->'hierarchy4'->0->>'section_id' FROM matrix_hierarchy_main
	         WHERE section_tipo = 'hierarchy1' AND lower(string->'hierarchy6'->0->>'value') = '${tld}'`;
}

/** Lines of a gzipped COPY package (one record per non-empty line). */
function packageLineCount(path: string): number {
	return gunzipSync(readFileSync(path))
		.toString('utf8')
		.split('\n')
		.filter((line) => line !== '').length;
}

/**
 * What the install left in its ontology (installer unification A2/A4): core +
 * default domain + engine, nothing of the suite's, the vendored file whole.
 */
async function assertOntologyOutcome(
	hierarchies: readonly string[],
	env: Record<string, string>,
): Promise<void> {
	const installed = (
		await scratchScalar("SELECT string_agg(DISTINCT tld, ',' ORDER BY tld) FROM dd_ontology")
	).split(',');
	const expected = [...CORE_ONTOLOGY_TLDS, ...DEFAULT_DOMAIN_ONTOLOGIES, ENGINE_TLD];
	expect(
		expected.filter((tld) => !installed.includes(tld)),
		'missing ontologies',
	).toEqual([]);
	// Anything else is the thesaurus step's own provisioning: the chosen
	// hierarchies' TLDs and their two typology groupers — never a fixture.
	const provisioned = new Set([...hierarchies, HIERARCHY_TYPE_TLD, HIERARCHY_MODEL_TYPE_TLD]);
	const extra = installed.filter((tld) => !expected.includes(tld) && !provisioned.has(tld));
	expect(extra, 'ontologies the install was not asked for').toEqual([]);
	expect(installed.filter((tld) => tld.startsWith('test'))).toEqual([]);
	expect(await scratchScalar('SELECT count(*) FROM matrix_test')).toBe('0');

	// The default domain ontology: its whole vendored file, record for record.
	const domain = DEFAULT_DOMAIN_ONTOLOGIES[0] as string;
	const records = Number(
		await scratchScalar(
			`SELECT count(*) FROM matrix_ontology WHERE section_tipo = '${domain}${0}'`,
		),
	);
	const vendored = packageLineCount(join(VENDORED_ONTOLOGY_DIR, `${domain}.copy.gz`));
	expect(vendored).toBeGreaterThan(50);
	expect(records).toBe(vendored);

	expect(JSON.parse(env.ACTIVE_ONTOLOGY_TLDS as string)).toEqual([
		...CORE_ONTOLOGY_TLDS,
		...DEFAULT_DOMAIN_ONTOLOGIES,
	]);
	expect(Number(await scratchScalar('SELECT count(*) FROM matrix_relation_index'))).toBeGreaterThan(
		0,
	);
	// The staging dir, resolved the installer's way but under THIS run's private dir.
	const staging = join(scratchDir, relative(installPrivateDir(), installOntologyStagingDir()));
	expect(existsSync(staging), `${staging} left behind`).toBe(false);
}

/**
 * THE REASON GOES IN THE NAME (P2-19 / GATE-25).
 *
 * These two tests used to `return` when no admin connection was available —
 * the first after a console.warn, the second in silence. Bun counts a returning
 * body as a PASS, so the ENTIRE PHP-free install path reported two green ticks
 * having spawned nothing whenever the developer's role lacked CREATEDB. The
 * header above says this file "Skips loudly"; it did not.
 *
 * `test.if` reports a real SKIP, and the name carries why, so an unrunnable
 * gate is legible in the runner's own output instead of indistinguishable from
 * a verified one.
 */
const WHY_SKIPPED =
	'SKIPPED: no admin Postgres connection (DB_ADMIN_* unset, or the role lacks CREATEDB)';
const named = (what: string): string => (available ? what : `${what} — ${WHY_SKIPPED}`);

describe('TS-native install e2e (P5)', () => {
	test.if(available)(
		named('the CLI installs a fresh DB and verifies the root login'),
		async () => {
			const started = performance.now();
			const { exitCode, out } = runCli();
			console.log(`[install_e2e] CLI install took ${Math.round(performance.now() - started)} ms`);
			expect(out).toContain('root login verified');
			expect(exitCode).toBe(0);

			// The CLI ran the SHARED plan: its printed step ids are its own --plan.
			const planned = Bun.spawnSync(['bun', 'run', CLI, ...cliArgs(), '--plan'], {
				stdout: 'pipe',
				stderr: 'pipe',
			});
			expect(planned.exitCode, planned.stderr.toString()).toBe(0);
			const plan = JSON.parse(planned.stdout.toString().trim()) as {
				steps: string[];
				hierarchies: string[];
			};
			const printed = [...out.matchAll(/^→ \[([a-z_]+)\]/gm)].map((match) => match[1]);
			expect(printed.length).toBeGreaterThan(5);
			expect(printed).toEqual(plan.steps);

			// Languages: ACTIVE, and not one lg row imported into matrix_hierarchy.
			expect(await scratchScalar(registryActiveSql('lg'))).toBe('1');
			expect(
				await scratchScalar(
					"SELECT count(*) FROM matrix_hierarchy WHERE section_tipo ~ '^lg[0-9]+$'",
				),
			).toBe('0');

			// The chosen thesaurus reached the CLI: its registry row CREATED from the
			// manifest entry (the seed ships only lg's), active, terms in.
			const chosen = CHOSEN_THESAURUS;
			expect(chosen, 'the vendored manifest lists a data-carrying thesaurus').toBeDefined();
			// The answer first, then every declared thesaurus (pre-ticked, not declined).
			expect(plan.hierarchies).toEqual([
				chosen?.tld ?? '(none)',
				...DECLARED_THESAURI.filter((tld) => tld !== chosen?.tld),
			]);
			expect(
				await scratchScalar(
					`SELECT relation->'hierarchy8'->0->>'section_id' FROM matrix_hierarchy_main
					  WHERE section_tipo = 'hierarchy1' AND lower(string->'hierarchy6'->0->>'value') = '${chosen?.tld}'`,
				),
			).toBe(String(chosen?.lang.section_id));
			expect(
				await scratchScalar(
					`SELECT string->'hierarchy109'->0->>'value' FROM matrix_hierarchy_main
					  WHERE section_tipo = 'hierarchy1' AND lower(string->'hierarchy6'->0->>'value') = '${chosen?.tld}'`,
				),
			).toBe(chosen?.real_section_tipo ?? 'hierarchy20');
			for (const tld of plan.hierarchies) {
				expect(await scratchScalar(registryActiveSql(tld)), `${tld} active`).toBe('1');
				// The section tipo is BUILT (`${tld}1`), never spelled: a literal would
				// feed the suite-fixture allowlist scan (scripts/lib/hierarchy_allowlist.ts).
				const terms = Number(
					await scratchScalar(
						`SELECT count(*) FROM matrix_hierarchy WHERE section_tipo = '${tld}${1}'`,
					),
				);
				// A data-carrying entry brings its terms; one without data files is an
				// EMPTY thesaurus by design — only the General Term root its activation
				// mints (hierarchy_import.ts).
				const carriesData = offeredHierarchies().some(
					(entry) => entry.tld === tld && entry.data_files.length > 0,
				);
				if (carriesData) expect(terms, `${tld} terms imported`).toBeGreaterThan(0);
				else expect(terms, `${tld} empty thesaurus: its root only`).toBe(1);
			}

			// The written .env: the official update servers, never DEDALO_SUPERVISED.
			const env = parseEnvFile(readFileSync(join(scratchDir, '.env'), 'utf8'));
			expect(JSON.parse(env.ONTOLOGY_SERVERS as string)).toEqual([OFFICIAL_ONTOLOGY_SERVER]);
			expect(JSON.parse(env.CODE_SERVERS as string)).toEqual([OFFICIAL_CODE_SERVER]);
			expect(env.DEDALO_SUPERVISED).toBeUndefined();

			await assertOntologyOutcome(plan.hierarchies, env);
		},
		600000,
	);

	test.if(available)(
		named('re-running the CLI on the now-populated DB refuses the restore'),
		() => {
			const { exitCode, out } = runCli();
			expect(exitCode).not.toBe(0);
			expect(out).toContain('not empty');
		},
		60000,
	);
});
