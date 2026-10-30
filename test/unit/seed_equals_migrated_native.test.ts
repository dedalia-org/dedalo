/**
 * SEED ≡ MIGRATED (update audit 2026-10-29, critic finding; design §5 1.7).
 *
 * Two roads reach a release's schema: a FRESH install restores the release's
 * seed (`install/db/dedalo_install.pgsql.gz`, compiled from schema.sql + the
 * migrations); an UPDATED install restored the PREVIOUS release's seed long ago
 * and then ran, at boot, every migration it had not recorded. Nothing proved
 * the two roads end on the same schema — a migration that a seed recompile
 * folded in differently, or a schema.sql edit with no migration, makes the
 * updated install silently not the release.
 *
 * This gate walks both roads on scratch databases and compares the schema
 * fingerprint (tables + columns, indexes, constraints, functions, triggers,
 * views, extensions in `public`):
 *   A  the seed of the NEWEST release tag merged into HEAD (read from the git
 *      object store, never the working tree) + every current migration file A
 *      has not recorded, applied as the runner does (one transaction per boot
 *      file; an ONLINE file outside one);
 *   B  the committed seed + ITS first boot (the seed carries no `dedalo_ts_*`
 *      table nor the version table: a fresh install's first boot runs every
 *      migration file — the same runner rule as A).
 * Only the runner's own version table is excluded: its ledger columns (U-23
 * sha256/release) are added in place by the runner at boot on both roads.
 *
 * Needs the release tags (db.yml checks out with fetch-depth 0); a clone
 * without them says so in the test name instead of passing.
 *
 * Scratch surfaces: `dedalo_seedmigr_{a,b}_<pid>` (swept on entry, FORCE-dropped after).
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MIGRATIONS_DIR, MIGRATIONS_VERSION_TABLE } from '../../install/db/migrate.ts';
import { isOnlineMigration } from '../../install/db/online_migration.ts';
import { config } from '../../src/config/config.ts';
import { type DbConnDescriptor, runPsql } from '../../src/core/install/pg_exec.ts';
import {
	compareReleaseIdentities,
	releaseVersionOfTag,
} from '../../src/core/update/release_identity.ts';
import { sweepOrphanScratchDatabases } from '../helpers/scratch_database.ts';
import { column, restoreSeedRaw } from '../helpers/seed_contract.ts';

const REPO = join(import.meta.dir, '..', '..');
const SEED_PATH = 'install/db/dedalo_install.pgsql.gz';
const PREFIX = 'dedalo_seedmigr_';
const admin: DbConnDescriptor = {
	database: 'postgres',
	host: config.db.host,
	port: config.db.port,
	user: config.db.user,
	password: config.db.password,
	socket: config.db.socket,
};
const migrated: DbConnDescriptor = { ...admin, database: `${PREFIX}a_${process.pid}` };
const fresh: DbConnDescriptor = { ...admin, database: `${PREFIX}b_${process.pid}` };

const git = (...args: string[]) =>
	Bun.spawnSync(['git', ...args], { cwd: REPO, stdout: 'pipe', stderr: 'pipe' });

/** The newest release tag merged into HEAD that carries a seed, or null (a tagless clone). */
function baselineTag(): string | null {
	const tags = git('tag', '--merged', 'HEAD', '-l', 'v*')
		.stdout.toString()
		.split('\n')
		.filter((tag) => releaseVersionOfTag(tag) !== null)
		.filter((tag) => git('cat-file', '-e', `${tag}:${SEED_PATH}`).exitCode === 0)
		.sort((a, b) =>
			compareReleaseIdentities(releaseVersionOfTag(a) as string, releaseVersionOfTag(b) as string),
		);
	return tags.at(-1) ?? null;
}

const BASELINE = baselineTag();
const scratchDir = mkdtempSync(join(tmpdir(), 'dedalo_seedmigr_'));

/** Apply the current migration files `conn` has not recorded — the boot runner's order and transaction rule. */
async function applyPendingMigrations(conn: DbConnDescriptor): Promise<string[]> {
	// A seed carries no version table: the first boot creates it and runs EVERY
	// file (each idempotent by the migration law) — exactly what is mirrored here.
	const [present] = await column(
		conn,
		`SELECT to_regclass('public.${MIGRATIONS_VERSION_TABLE}') IS NOT NULL`,
	);
	const recorded = new Set(
		present === 't' ? await column(conn, `SELECT version FROM "${MIGRATIONS_VERSION_TABLE}"`) : [],
	);
	const pending = readdirSync(MIGRATIONS_DIR)
		.filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name) && !recorded.has(name))
		.sort();
	for (const file of pending) {
		const path = join(MIGRATIONS_DIR, file);
		const online = isOnlineMigration(readFileSync(path, 'utf8'));
		const run = await runPsql(conn, [
			'-X',
			'-q',
			'-v',
			'ON_ERROR_STOP=1',
			...(online ? [] : ['-1']),
			'-f',
			path,
		]);
		expect(run.exitCode, `${file}: ${run.stderr}`).toBe(0);
	}
	return pending;
}

/** The schema of `public`, one sortable line per object (the version table excluded — see header). */
async function schemaFingerprint(conn: DbConnDescriptor): Promise<string[]> {
	const skip = `'${MIGRATIONS_VERSION_TABLE}'`;
	const queries = [
		`SELECT 'column ' || table_name || '.' || column_name || ' ' || udt_name || ' null=' || is_nullable || ' default=' || COALESCE(column_default, '-')
		   FROM information_schema.columns WHERE table_schema = 'public' AND table_name <> ${skip}`,
		`SELECT 'index ' || indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename <> ${skip}`,
		`SELECT 'constraint ' || conrelid::regclass || ' ' || conname || ' ' || pg_get_constraintdef(oid)
		   FROM pg_constraint WHERE connamespace = 'public'::regnamespace AND conrelid::regclass::text <> ${skip}`,
		`SELECT 'function ' || p.oid::regprocedure || ' ' || md5(pg_get_functiondef(p.oid))
		   FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.prokind IN ('f', 'p')
		   AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')`,
		`SELECT 'trigger ' || pg_get_triggerdef(oid) FROM pg_trigger WHERE NOT tgisinternal
		   AND tgrelid::regclass::text NOT LIKE 'pg_%'`,
		`SELECT 'view ' || viewname || ' ' || md5(definition) FROM pg_views WHERE schemaname = 'public'`,
		`SELECT 'extension ' || extname FROM pg_extension`,
	];
	const lines = (await Promise.all(queries.map((query) => column(conn, query)))).flat();
	return lines.sort();
}

beforeAll(async () => {
	if (BASELINE === null) return;
	await sweepOrphanScratchDatabases(admin, PREFIX);
	for (const conn of [migrated, fresh]) {
		await column(admin, `DROP DATABASE IF EXISTS "${conn.database}" WITH (FORCE)`);
		await column(admin, `CREATE DATABASE "${conn.database}" TEMPLATE template0 ENCODING 'UTF8'`);
	}
	const baselineSeed = join(scratchDir, 'baseline.pgsql.gz');
	const blob = git('show', `${BASELINE}:${SEED_PATH}`);
	expect(blob.exitCode, blob.stderr.toString()).toBe(0);
	writeFileSync(baselineSeed, blob.stdout, { flag: 'wx', mode: 0o600 });
	await restoreSeedRaw(migrated, baselineSeed);
	await restoreSeedRaw(fresh, join(REPO, SEED_PATH));
	// Both roads walked HERE, so every case below stands on its own (`-t` one case).
	await applyPendingMigrations(migrated);
	await applyPendingMigrations(fresh);
}, 600_000);

afterAll(async () => {
	rmSync(scratchDir, { recursive: true, force: true });
	if (BASELINE === null) return;
	for (const conn of [migrated, fresh]) {
		await column(admin, `DROP DATABASE IF EXISTS "${conn.database}" WITH (FORCE)`);
	}
});

describe('seed ≡ migrated: a fresh install and an updated one end on the same schema', () => {
	if (BASELINE === null) {
		test.skip('seed ≡ migrated (no release tag in this clone — shallow checkout)', () => {});
		return;
	}
	test(`the ${BASELINE} seed + its pending migrations = the committed seed`, async () => {
		const updated = await schemaFingerprint(migrated);
		const installed = await schemaFingerprint(fresh);
		expect(installed.length, 'anti-vacuity: the fingerprint read the schema').toBeGreaterThan(200);
		const onlyUpdated = updated.filter((line) => !installed.includes(line));
		const onlyFresh = installed.filter((line) => !updated.includes(line));
		expect({ onlyUpdated, onlyFresh }).toEqual({ onlyUpdated: [], onlyFresh: [] });
	}, 300_000);

	test('anti-vacuity: one index only the updated road built is a difference', async () => {
		await column(migrated, 'CREATE INDEX seedmigr_probe_idx ON matrix_test (section_id)');
		try {
			const updated = await schemaFingerprint(migrated);
			const installed = await schemaFingerprint(fresh);
			expect(updated.filter((line) => !installed.includes(line))).toEqual([
				'index CREATE INDEX seedmigr_probe_idx ON public.matrix_test USING btree (section_id)',
			]);
		} finally {
			await column(migrated, 'DROP INDEX seedmigr_probe_idx');
		}
	}, 300_000);
});
