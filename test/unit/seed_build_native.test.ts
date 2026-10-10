/**
 * The install SEED COMPILER, end to end (src/core/install/seed_build.ts — the
 * build_database_version.build_install_version action and `bun run seed:build`).
 *
 * WHAT IT PROVES. The compiler runs for real — repo sources → scratch database
 * → dump → verified by a fresh install — into a temp file; the result is
 * restored into a scratch database and held to the CONTENT CONTRACT
 * (test/helpers/seed_contract.ts, the same one the committed seed is held to).
 * Then:
 *  - REPRODUCIBLE: its content digest equals the COMMITTED manifest's, i.e. the
 *    seed in the tree is exactly what these sources compile to, on this machine;
 *  - its own manifest agrees with it (manifestFindings === []);
 *  - the run's verification really ran the install (lg active, root verified,
 *    every TLD in sync) and left no scratch database behind;
 *  - under the cluster lock a MARKED orphan of a dead run is swept and an
 *    UNMARKED look-alike is left alone and named;
 *  - a held lock refuses a second compile.
 * Pure halves: the registry rule, the data/finish scripts, the pinned child
 * environment (nothing of the installation's config reaches the compile).
 *
 * Reads no installation database: the compiler takes only the cluster's
 * credentials (the suite's), and every database it touches it created.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from '../../src/config/config.ts';
import { isDedaloError } from '../../src/core/errors/index.ts';
import { SEED_MANIFEST_PATH } from '../../src/core/install/paths.ts';
import { resolvePgBinary } from '../../src/core/install/pg_bin.ts';
import { connArgs, type DbConnDescriptor, pgClientEnv } from '../../src/core/install/pg_exec.ts';
import {
	buildInstallVersion,
	childEnv,
	nonCoreRegistryRows,
	type RegistryProvisionInput,
	registryBlockers,
	releaseDependencies,
	SEED_CHILD_CONFIG,
	type SeedBuildResult,
	seedDataSql,
	seedFinishSql,
} from '../../src/core/install/seed_build.ts';
import {
	manifestFindings,
	observeCommittedSeed,
	type SeedManifest,
} from '../../src/core/install/seed_manifest.ts';
import {
	SEED_BUILD_MARKER_TABLE,
	SEED_ONTOLOGY_TLDS,
} from '../../src/core/install/seed_sources.ts';
import { sweepOrphanScratchDatabases } from '../helpers/scratch_database.ts';
import { assertSeedContract, column, restoreSeedRaw } from '../helpers/seed_contract.ts';

const CHECK_PREFIX = 'dedalo_seedcheck_';
const CHECK_DB = `${CHECK_PREFIX}${process.pid}`;
/** Look-alike orphans for the sweep leg (no live run uses such a pid). */
const MARKED_ORPHAN = 'dedalo_seed_build_999999901';
const UNMARKED_LOOKALIKE = 'dedalo_seed_verify_999999902';

const admin: DbConnDescriptor = {
	database: 'postgres',
	host: config.db.host,
	port: config.db.port,
	user: config.db.user,
	password: config.db.password,
};
const check: DbConnDescriptor = { ...admin, database: CHECK_DB };

const workDir = mkdtempSync(join(tmpdir(), 'dedalo_seed_compile_'));
const outFile = join(workDir, 'seed.pgsql.gz');
let built: SeedBuildResult;

beforeAll(async () => {
	await sweepOrphanScratchDatabases(admin, CHECK_PREFIX);
	for (const name of [MARKED_ORPHAN, UNMARKED_LOOKALIKE]) {
		await column(admin, `DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
		await column(admin, `CREATE DATABASE "${name}"`);
	}
	await column(
		{ ...admin, database: MARKED_ORPHAN },
		`CREATE TABLE ${SEED_BUILD_MARKER_TABLE} (purpose text)`,
	);
	built = await buildInstallVersion({ conn: admin, outFile });
	await column(admin, `DROP DATABASE IF EXISTS "${CHECK_DB}" WITH (FORCE)`);
	await column(admin, `CREATE DATABASE "${CHECK_DB}" TEMPLATE template0 ENCODING 'UTF8'`);
	await restoreSeedRaw(check, outFile);
}, 600_000);

afterAll(async () => {
	for (const name of [CHECK_DB, MARKED_ORPHAN, UNMARKED_LOOKALIKE]) {
		await column(admin, `DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
	}
	rmSync(workDir, { recursive: true, force: true });
});

describe('seed compiler — repo sources → a seed that installs', () => {
	test('the compile answers ok, every step ran, and the fresh install proved it', () => {
		expect(built.steps.length, JSON.stringify(built.steps)).toBeGreaterThanOrEqual(6);
		const checks = built.manifest.verified.checks;
		expect(checks).toContain('lg (Languages) active');
		expect(checks.filter((line) => line.includes('filled by the boot self-heal'))).toHaveLength(2);
		expect(checks).toContain('root password set and verified');
		// Every shipped (core) TLD proved in sync — exactly those: the seed
		// promises the core, never a domain or the test TLD.
		expect(SEED_ONTOLOGY_TLDS.length).toBeGreaterThanOrEqual(6);
		expect(
			checks
				.map((line) => /^ontology (\w+) in sync/.exec(line)?.[1])
				.filter((tld) => tld !== undefined)
				.sort(),
		).toEqual([...SEED_ONTOLOGY_TLDS].sort());
	});

	test('no scratch database of this run survives', async () => {
		for (const name of [`dedalo_seed_build_${process.pid}`, `dedalo_seed_verify_${process.pid}`]) {
			expect(
				await column(admin, `SELECT 1 FROM pg_database WHERE datname = '${name}'`),
				name,
			).toEqual([]);
		}
	});

	test('the sweep drops a MARKED orphan and only names an unmarked look-alike', async () => {
		expect(
			await column(admin, `SELECT 1 FROM pg_database WHERE datname = '${MARKED_ORPHAN}'`),
		).toEqual([]);
		expect(
			await column(admin, `SELECT 1 FROM pg_database WHERE datname = '${UNMARKED_LOOKALIKE}'`),
		).toEqual(['1']);
		expect(built.findings.join(' ')).toContain(`left alone: database '${UNMARKED_LOOKALIKE}'`);
	});

	test('the compiled seed satisfies the content contract', async () => {
		await assertSeedContract(check);
	}, 120_000);

	test('its manifest agrees with it', async () => {
		const manifest = JSON.parse(readFileSync(`${outFile}.manifest.json`, 'utf8')) as SeedManifest;
		expect(manifestFindings(manifest, await observeCommittedSeed(outFile))).toEqual([]);
	});

	test('REPRODUCIBLE: the committed seed is exactly what these sources compile to', () => {
		expect(existsSync(SEED_MANIFEST_PATH), 'no committed manifest — run `bun run seed:build`').toBe(
			true,
		);
		const committed = JSON.parse(readFileSync(SEED_MANIFEST_PATH, 'utf8')) as SeedManifest;
		expect(built.manifest.seed.content_sha256).toBe(committed.seed.content_sha256);
		expect(built.manifest.tables).toEqual(committed.tables);
	});
});

describe('seed compiler — one compile per cluster', () => {
	test('a held advisory lock refuses a second compile, and nothing is written', async () => {
		const holder = Bun.spawn(
			[resolvePgBinary('psql'), '--dbname=postgres', ...connArgs(admin), '-X', '-q', '-tA'],
			{ stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', env: pgClientEnv(admin) },
		);
		holder.stdin.write("SELECT pg_try_advisory_lock(hashtext('dedalo_seed_build'));\n");
		await holder.stdin.flush();
		const reader = holder.stdout.getReader();
		const { value } = await reader.read();
		reader.releaseLock();
		expect(new TextDecoder().decode(value).trim()).toBe('t');
		try {
			const refusedOut = join(workDir, 'refused.pgsql.gz');
			const refusal = await buildInstallVersion({ conn: admin, outFile: refusedOut }).then(
				() => null,
				(error: unknown) => error,
			);
			// The registered refusal, its sentence on the wire, the readout beside it.
			expect(isDedaloError(refusal) && refusal.code).toBe('maintenance.action_failed');
			expect(isDedaloError(refusal) ? refusal.publicMessage : '').toContain(
				'another seed compile is running',
			);
			expect(isDedaloError(refusal) ? refusal.extend : undefined).toEqual({
				steps: [],
				findings: [],
			});
			expect(existsSync(refusedOut)).toBe(false);
		} finally {
			holder.stdin.end();
			await holder.exited;
		}
	});
});

describe('seed compiler — pure halves', () => {
	test('a registry record activation would refuse is named (the 2026-10-09 typo, planted)', () => {
		const record = (
			sectionId: number,
			source: string,
			model: string | null,
		): RegistryProvisionInput => ({
			section_id: sectionId,
			source_model: model,
			string: {
				hierarchy6: [{ value: 'lg' }],
				...(source === '' ? {} : { hierarchy109: [{ value: source }] }),
			},
			relation: { hierarchy9: [{ section_id: 3, section_tipo: 'hierarchy13' }] },
		});
		expect(registryBlockers([record(1, 'hierarchy20', 'section'), record(2, '', null)])).toEqual(
			[],
		);
		const blocked = registryBlockers([record(244, 'hiearachy20', null)]);
		expect(blocked).toHaveLength(1);
		expect(blocked[0]).toContain(
			"hierarchy1/244 (lg): the source section 'hiearachy20' (hierarchy109) is not a section",
		);
		expect(
			registryBlockers([{ ...record(5, 'hierarchy20', 'section'), relation: {} }])[0],
		).toContain('no typology (hierarchy9)');
	});

	test('the registry ships the CORE rows only: a non-core (optional thesaurus) row is named', () => {
		// Optional thesauri are activated from hierarchy.json
		// (WC-2026-10-10-hierarchy-json-manifest); a frozen registry row in the
		// seed would be the metadata the manifest replaced.
		const row = (sectionId: number, tld: string | null): RegistryProvisionInput => ({
			section_id: sectionId,
			source_model: 'section',
			string: tld === null ? {} : { hierarchy6: [{ value: tld }] },
			relation: { hierarchy9: [{ section_id: 3, section_tipo: 'hierarchy13' }] },
		});
		expect(nonCoreRegistryRows([row(244, 'LG'), row(245, 'lg')])).toEqual([]);
		expect(nonCoreRegistryRows([row(244, 'LG'), row(1, 'es'), row(2, null)])).toEqual([
			'hierarchy1/1 (es)',
			'hierarchy1/2 (?)',
		]);
	});

	test("a release entry's declared dependencies reach the package normalized; a malformed one refuses the compile", () => {
		// What stagePackages hands the import door (→ the core row's hierarchy60).
		expect(releaseDependencies({ tld: 'dd' })).toBeNull();
		expect(releaseDependencies({ tld: 'dd', dependencies: [] })).toEqual([]);
		expect(
			releaseDependencies({
				tld: 'dd',
				dependencies: [
					{ tld: ' TS ', main: 'ontology35', mandatory: true },
					{ tld: 'ts', main: 'hierarchy1', mandatory: false },
					{ tld: 'dd', main: 'hierarchy1', mandatory: true },
				],
			}),
		).toEqual([
			{ tld: 'ts', main: 'ontology35', mandatory: true },
			{ tld: 'ts', main: 'hierarchy1', mandatory: false },
			{ tld: 'dd', main: 'hierarchy1', mandatory: true },
		]);
		// The seed must be exact: nothing is silently dropped.
		for (const dependencies of [
			[{ tld: 'ts', main: 'ontology35', mandatory: 'yes' }],
			[{ tld: 'dd', main: 'ontology35', mandatory: true }],
			'ts',
		]) {
			expect(() => releaseDependencies({ tld: 'dd', dependencies })).toThrow(
				expect.objectContaining({
					publicMessage: expect.stringContaining('declares invalid dependencies'),
				}),
			);
		}
	});

	test('the data script empties what the compile child did not write, and refuses a path psql would quote', () => {
		const sql = seedDataSql({
			tables: ['dd_ontology', 'matrix', 'matrix_langs', 'matrix_ontology', 'matrix_time_machine'],
			registryPath: '/tmp/registry.copy',
			releaseDate: '2026-07-14T16:08:54+02:00',
		});
		// matrix_langs is loaded ONCE, before the compile (the registry door
		// resolves STRUCTURE_LANG from it) — kept, never truncated nor reloaded.
		expect(sql).toContain('TRUNCATE "matrix", "matrix_time_machine" RESTART IDENTITY;');
		expect(sql).not.toContain('matrix_langs');
		expect(sql).toContain('\\copy matrix_hierarchy_main (section_id, section_tipo,');
		expect(sql).toContain('INSERT INTO matrix_updates (data)');
		expect(() =>
			seedDataSql({
				tables: [],
				registryPath: "/tmp/x'; DROP",
				releaseDate: 'x',
			}),
		).toThrow(
			expect.objectContaining({ publicMessage: expect.stringContaining('refusing a path') }),
		);
	});

	test('the finish script clusters keyed tables, refuses an unkeyed one, restarts idle sequences, validates nothing', () => {
		const sql = seedFinishSql({
			tables: ['matrix_langs', 'matrix_string_search'],
			primaryKeys: { matrix_langs: 'matrix_langs_pkey' },
			idleSequences: ['matrix_activity_id_seq'],
		});
		expect(sql).toContain('CLUSTER "matrix_langs" USING "matrix_langs_pkey";');
		expect(sql).toContain('ALTER TABLE "matrix_langs" SET WITHOUT CLUSTER;');
		expect(sql).not.toContain('CLUSTER "matrix_string_search"'); // declared key-less: ships empty
		expect(sql.startsWith('TRUNCATE "matrix_string_search";')).toBe(true); // emptied after every load
		expect(sql).toContain('ALTER SEQUENCE "matrix_activity_id_seq" RESTART WITH 1;');
		expect(sql).not.toContain('VALIDATE CONSTRAINT'); // the schema stays schema.sql + migrations
		expect(() =>
			seedFinishSql({ tables: ['matrix_new'], primaryKeys: {}, idleSequences: [] }),
		).toThrow(
			expect.objectContaining({ publicMessage: expect.stringContaining('no primary key') }),
		);
	});

	test('the compile child runs on a PINNED environment: nothing of the parent reaches it', () => {
		const inherited = {
			PATH: '/usr/bin',
			HOME: '/home/x',
			APPLICATION_LANG: 'lg-spa',
			DEDALO_TIMEZONE: 'Europe/Madrid',
			DEDALO_TEST_MEDIA_ROOT: '/suite/media',
			DB_NAME: 'the_installation',
			SOME_SECRET: 's3cret',
		};
		const env = childEnv(
			{ ...admin, password: 'pw' },
			'dedalo_seed_build_1',
			'/scratch',
			inherited,
		);
		expect(env.PATH).toBe('/usr/bin');
		for (const [key, value] of Object.entries(SEED_CHILD_CONFIG)) expect(env[key]).toBe(value);
		expect(env.DB_NAME).toBe('dedalo_seed_build_1');
		expect(env.DEDALO_PRIVATE_DIR).toBe('/scratch/private');
		expect(env.MEDIA_PATH).toBe('/scratch/media');
		expect(env.SOME_SECRET).toBeUndefined();
		expect(env.DEDALO_TEST_MEDIA_ROOT).toBeUndefined();
		const allowed = new Set([
			'PATH',
			'HOME',
			'TMPDIR',
			...Object.keys(SEED_CHILD_CONFIG),
			'DEDALO_PRIVATE_DIR',
			'MEDIA_PATH',
			'DB_NAME',
			'DB_HOST',
			'DB_PORT',
			'DB_USER',
			'DB_SOCKET',
			'DB_PASSWORD',
			'PGPASSWORD',
		]);
		expect(Object.keys(env).filter((key) => !allowed.has(key))).toEqual([]);
	});
});
