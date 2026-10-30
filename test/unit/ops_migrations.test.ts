/**
 * Ordered-migration runner gate (audit S2-39, WS-E item 7).
 *
 * THE GUARANTEES under test, against the REAL Postgres:
 * - pending numbered .sql files apply in filename order, each recorded in the
 *   version table;
 * - a re-run applies nothing (idempotent boot);
 * - a failing migration aborts the run WITHOUT recording itself (the next
 *   boot retries it; later files never leapfrog a hole);
 * - non-matching filenames are ignored;
 * - a migration that times out WAITING for a lock (SQLSTATE 55P03) is retried
 *   after a backoff and lands once the lock is free; with no retry left it
 *   aborts unrecorded (2026-09-27 — 0010_tm_role.sql ALTERs the largest table
 *   of an install, whose instant lock queues behind any long reader);
 * - a migration's RUN is not bounded by the pool's statement_timeout;
 * - an ONLINE file is deferred by the boot run (not a hole) and built by the
 *   post-listen run CONCURRENTLY; an INVALID leftover is dropped and rebuilt;
 *   a file outside the online grammar is refused unrecorded.
 *
 * Scratch surfaces only: a temp migrations dir + a dedalo_ts_test_* version
 * table + dedalo_ts_test_* target tables, all dropped in afterAll.
 */

import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	MIGRATION_LOCK_TIMEOUT,
	MIGRATIONS_DIR,
	MIGRATIONS_VERSION_TABLE,
	pendingMigrations,
	runMigrations,
	runOnlineMigrations,
	stopOnlineMigrations,
} from '../../install/db/migrate.ts';
import {
	type MigrationLedger,
	migrationSha256,
	readMigrationLedger,
} from '../../install/db/migration_ledger.ts';
import { sql, withTransaction } from '../../src/core/db/postgres.ts';
import { assertTestDatabase } from '../../src/core/test_data/test_database_marker.ts';

const VERSION_TABLE = `dedalo_ts_test_migrations_${process.pid}`;
const TARGET_TABLE = `dedalo_ts_test_migr_target_${process.pid}`;
const dir = mkdtempSync(join(tmpdir(), 'dedalo_migrations_'));

afterAll(async () => {
	rmSync(dir, { recursive: true, force: true });
	await sql.unsafe(`DROP TABLE IF EXISTS "${VERSION_TABLE}"`, []);
	await sql.unsafe(`DROP TABLE IF EXISTS "${TARGET_TABLE}"`, []);
});

describe('migrations runner (S2-39)', () => {
	test('applies pending files in order, records them, and is idempotent', async () => {
		writeFileSync(
			join(dir, '0001_create_target.sql'),
			`CREATE TABLE IF NOT EXISTS "${TARGET_TABLE}" (id int PRIMARY KEY, label text)`,
		);
		writeFileSync(
			join(dir, '0002_add_column.sql'),
			`ALTER TABLE "${TARGET_TABLE}" ADD COLUMN extra text`,
		);
		writeFileSync(join(dir, 'notes.txt'), 'not a migration'); // ignored shape

		const first = await runMigrations({ dir, versionTable: VERSION_TABLE });
		expect(first.applied).toEqual(['0001_create_target.sql', '0002_add_column.sql']);
		expect(first.skipped).toBe(0);

		// The schema actually changed (the ALTER ran after the CREATE).
		const columns = (await sql.unsafe(
			'SELECT column_name FROM information_schema.columns WHERE table_name = $1 ORDER BY ordinal_position',
			[TARGET_TABLE],
		)) as { column_name: string }[];
		expect(columns.map((column) => column.column_name)).toEqual(['id', 'label', 'extra']);

		// Idempotent re-run: nothing re-applies.
		const second = await runMigrations({ dir, versionTable: VERSION_TABLE });
		expect(second.applied).toEqual([]);
		expect(second.skipped).toBe(2);
	});

	test('a failing migration aborts without being recorded; later files wait', async () => {
		writeFileSync(join(dir, '0003_broken.sql'), 'SELECT * FROM this_table_does_not_exist_42');
		writeFileSync(
			join(dir, '0004_after_hole.sql'),
			`ALTER TABLE "${TARGET_TABLE}" ADD COLUMN late text`,
		);

		await expect(runMigrations({ dir, versionTable: VERSION_TABLE })).rejects.toThrow();

		const recorded = (await sql.unsafe(
			`SELECT version FROM "${VERSION_TABLE}" ORDER BY version`,
			[],
		)) as { version: string }[];
		// Neither the broken file nor its successor was recorded.
		expect(recorded.map((row) => row.version)).toEqual([
			'0001_create_target.sql',
			'0002_add_column.sql',
		]);

		// Fixing the hole lets the run complete in order.
		writeFileSync(join(dir, '0003_broken.sql'), 'SELECT 1');
		const healed = await runMigrations({ dir, versionTable: VERSION_TABLE });
		expect(healed.applied).toEqual(['0003_broken.sql', '0004_after_hole.sql']);
	});

	/**
	 * Hold ACCESS EXCLUSIVE on the target from ANOTHER connection for `holdMs`.
	 * Resolves `locked` once the lock is really held, so the migration is known
	 * to start behind it.
	 */
	function holdTargetLock(holdMs: number): { locked: Promise<void>; released: Promise<void> } {
		let signalLocked: () => void = () => {};
		const locked = new Promise<void>((resolve) => {
			signalLocked = resolve;
		});
		const released = withTransaction(async () => {
			await sql.unsafe(`LOCK TABLE "${TARGET_TABLE}" IN ACCESS EXCLUSIVE MODE`, []);
			signalLocked();
			await Bun.sleep(holdMs);
		});
		return { locked, released };
	}

	test('a lock-timeout migration is RETRIED and lands once the lock is free', async () => {
		writeFileSync(
			join(dir, '0005_behind_a_lock.sql'),
			`SET LOCAL lock_timeout = '150ms';\nALTER TABLE "${TARGET_TABLE}" ADD COLUMN behind_lock text`,
		);
		const holder = holdTargetLock(900);
		await holder.locked;
		const run = await runMigrations({
			dir,
			versionTable: VERSION_TABLE,
			lockRetryDelaysMs: [250, 250, 250, 250, 250, 250, 250, 250],
		});
		await holder.released;
		expect(run.applied).toEqual(['0005_behind_a_lock.sql']);
		const columns = (await sql.unsafe(
			'SELECT column_name FROM information_schema.columns WHERE table_name = $1',
			[TARGET_TABLE],
		)) as { column_name: string }[];
		expect(columns.map((column) => column.column_name)).toContain('behind_lock');
	});

	test('a lock timeout with no retry left aborts WITHOUT recording the file', async () => {
		writeFileSync(
			join(dir, '0006_still_locked.sql'),
			`SET LOCAL lock_timeout = '100ms';\nALTER TABLE "${TARGET_TABLE}" ADD COLUMN still_locked text`,
		);
		const holder = holdTargetLock(600);
		await holder.locked;
		const error = await runMigrations({
			dir,
			versionTable: VERSION_TABLE,
			lockRetryDelaysMs: [50],
		}).catch((caught: unknown) => caught);
		await holder.released;
		expect((error as { errno?: string }).errno).toBe('55P03');
		const recorded = (await sql.unsafe(`SELECT version FROM "${VERSION_TABLE}"`, [])) as {
			version: string;
		}[];
		expect(recorded.map((row) => row.version)).not.toContain('0006_still_locked.sql');
		// The lock gone, the next boot applies it.
		const healed = await runMigrations({ dir, versionTable: VERSION_TABLE });
		expect(healed.applied).toEqual(['0006_still_locked.sql']);
	});

	test('the runner bounds every migration lock wait by default (SET LOCAL, never session-wide)', async () => {
		writeFileSync(
			join(dir, '0007_reads_its_timeout.sql'),
			`CREATE TABLE "${TARGET_TABLE}_timeout" AS SELECT current_setting('lock_timeout') AS value`,
		);
		try {
			const run = await runMigrations({ dir, versionTable: VERSION_TABLE });
			expect(run.applied).toEqual(['0007_reads_its_timeout.sql']);
			const rows = (await sql.unsafe(`SELECT value FROM "${TARGET_TABLE}_timeout"`, [])) as {
				value: string;
			}[];
			expect(rows[0]?.value).toBe(MIGRATION_LOCK_TIMEOUT);
			// SET LOCAL died with the migration's transaction: a pooled read sees the default.
			const after = (await sql.unsafe(`SELECT current_setting('lock_timeout') AS value`, [])) as {
				value: string;
			}[];
			expect(after[0]?.value).not.toBe(MIGRATION_LOCK_TIMEOUT);
		} finally {
			await sql.unsafe(`DROP TABLE IF EXISTS "${TARGET_TABLE}_timeout"`, []);
		}
	});

	test('a migration RUN outlives a pool-level statement_timeout (0011’s full-heap build)', async () => {
		// The pool's DB_STATEMENT_TIMEOUT_MS, simulated on the connection the run
		// joins: a 100ms ceiling, and a file that runs 300ms. Without the runner's
		// own `statement_timeout = 0` it dies 57014, which is never retried.
		writeFileSync(join(dir, '0008_long_build.sql'), 'SELECT pg_sleep(0.3)');
		const run = await withTransaction(async () => {
			await sql.unsafe(`SET LOCAL statement_timeout = '100ms'`, []);
			return runMigrations({ dir, versionTable: VERSION_TABLE });
		});
		expect(run.applied).toEqual(['0008_long_build.sql']);
	});

	/** Whether an index exists, and whether it is VALID (null = absent). */
	async function indexState(name: string): Promise<boolean | null> {
		const rows = (await sql.unsafe(
			`SELECT i.indisvalid AS valid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE c.relname = $1`,
			[name],
		)) as { valid: boolean }[];
		return rows.length === 0 ? null : rows[0]?.valid === true;
	}

	test('an ONLINE file is never run pre-listen — later boot files still land — and the online run builds it CONCURRENTLY', async () => {
		const index = `${TARGET_TABLE}_online_idx`;
		writeFileSync(
			join(dir, '0009_online_index.sql'),
			`-- ONLINE MIGRATION: a full-heap build must not hold the listener.\nCREATE INDEX CONCURRENTLY IF NOT EXISTS ${index} ON "${TARGET_TABLE}" (label);\nANALYZE "${TARGET_TABLE}";\n`,
		);
		writeFileSync(
			join(dir, '0010_after_online.sql'),
			`ALTER TABLE "${TARGET_TABLE}" ADD COLUMN after_online text`,
		);
		const boot = await runMigrations({ dir, versionTable: VERSION_TABLE });
		expect(boot.applied).toEqual(['0010_after_online.sql']);
		expect(boot.deferred).toEqual(['0009_online_index.sql']);
		expect(await indexState(index)).toBeNull();
		const online = await runOnlineMigrations({ dir, versionTable: VERSION_TABLE });
		expect(online.applied).toEqual(['0009_online_index.sql']);
		expect(await indexState(index)).toBe(true);
		// Recorded: neither runner runs it again. FLOOR: both re-runs SAW the
		// recorded set, this file in it (an empty verdict from a runner that read
		// no version table would pass the two emptiness checks on its own).
		const recorded = (await sql.unsafe(`SELECT version FROM "${VERSION_TABLE}"`, [])) as {
			version: string;
		}[];
		expect(recorded.map((row) => row.version)).toContain('0009_online_index.sql');
		const bootAgain = await runMigrations({ dir, versionTable: VERSION_TABLE });
		const onlineAgain = await runOnlineMigrations({ dir, versionTable: VERSION_TABLE });
		expect(bootAgain.skipped).toBeGreaterThanOrEqual(recorded.length);
		expect(onlineAgain.skipped).toBeGreaterThanOrEqual(recorded.length);
		expect(bootAgain.deferred).toEqual([]);
		expect(onlineAgain.applied).toEqual([]);
	});

	test('an INVALID leftover of a killed build is dropped and rebuilt, never kept by IF NOT EXISTS', async () => {
		const index = `${TARGET_TABLE}_unique_label_idx`;
		// A failed CONCURRENTLY build leaves its index INVALID (duplicates here).
		await sql.unsafe(
			`INSERT INTO "${TARGET_TABLE}" (id, label) VALUES (901, 'dup'), (902, 'dup')`,
			[],
		);
		await expect(
			sql.unsafe(`CREATE UNIQUE INDEX CONCURRENTLY ${index} ON "${TARGET_TABLE}" (label)`, []),
		).rejects.toThrow();
		expect(await indexState(index)).toBe(false); // FLOOR: a real INVALID leftover
		await sql.unsafe(`DELETE FROM "${TARGET_TABLE}" WHERE id = 902`, []);
		writeFileSync(
			join(dir, '0011_online_unique.sql'),
			`-- ONLINE MIGRATION: rebuild over a leftover.\nCREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS ${index} ON "${TARGET_TABLE}" (label);\n`,
		);
		const online = await runOnlineMigrations({ dir, versionTable: VERSION_TABLE });
		expect(online.applied).toEqual(['0011_online_unique.sql']);
		expect(await indexState(index)).toBe(true);
	});

	test('an ONLINE file outside the grammar is refused and never recorded', async () => {
		const file = '0012_online_bad.sql';
		writeFileSync(
			join(dir, file),
			`-- ONLINE MIGRATION: not an index build.\nDELETE FROM "${TARGET_TABLE}";\n`,
		);
		try {
			await expect(runOnlineMigrations({ dir, versionTable: VERSION_TABLE })).rejects.toThrow(
				/outside the grammar/,
			);
			const recorded = (await sql.unsafe(`SELECT version FROM "${VERSION_TABLE}"`, [])) as {
				version: string;
			}[];
			expect(recorded.map((row) => row.version)).not.toContain(file);
		} finally {
			rmSync(join(dir, file), { force: true });
		}
	});

	test('a SHUTDOWN stops an online build in flight: bounded, cancelled, unrecorded', async () => {
		// The build a SIGTERM lands in: unbounded on its reserved connection, so
		// without the stop hook pool.end() waited for all of it. A 0.5 s
		// IMMUTABLE expression over 10 rows = seconds per heap pass (CONCURRENTLY
		// makes two), far past the bound asserted below.
		const file = '0013_online_slow.sql';
		const slow = `dedalo_ts_test_slow_${process.pid}`;
		const index = `${TARGET_TABLE}_slow_idx`;
		await sql.unsafe(
			`CREATE OR REPLACE FUNCTION ${slow}(t text) RETURNS text LANGUAGE plpgsql IMMUTABLE
			 AS $$ BEGIN PERFORM pg_sleep(0.5); RETURN t; END $$`,
			[],
		);
		await sql.unsafe(
			`INSERT INTO "${TARGET_TABLE}" (id, label) SELECT g, 'slow' || g FROM generate_series(950, 959) g`,
			[],
		);
		writeFileSync(
			join(dir, file),
			`-- ONLINE MIGRATION: a slow build.\nCREATE INDEX CONCURRENTLY IF NOT EXISTS ${index} ON "${TARGET_TABLE}" (${slow}(label));\n`,
		);
		try {
			const run = runOnlineMigrations({ dir, versionTable: VERSION_TABLE });
			const outcome = run.then(
				() => 'finished',
				(error: unknown) => (error as { errno?: unknown }).errno,
			);
			// FLOOR: the build is really running when the stop arrives.
			let building = false;
			for (let i = 0; i < 100 && !building; i++) {
				const rows = (await sql.unsafe(
					`SELECT 1 FROM pg_stat_activity WHERE state = 'active' AND query LIKE $1`,
					[`%CREATE INDEX CONCURRENTLY%${index}%`],
				)) as unknown[];
				building = rows.length > 0;
				if (!building) await Bun.sleep(50);
			}
			expect(building).toBe(true);
			const started = Date.now();
			await stopOnlineMigrations();
			expect(Date.now() - started).toBeLessThan(3_000);
			expect(await outcome).toBe('57014'); // cancelled, never finished
			const recorded = (await sql.unsafe(`SELECT version FROM "${VERSION_TABLE}"`, [])) as {
				version: string;
			}[];
			expect(recorded.map((row) => row.version)).not.toContain(file);
			expect(await indexState(index)).not.toBe(true); // INVALID leftover (or none): next boot rebuilds
		} finally {
			rmSync(join(dir, file), { force: true });
			await sql.unsafe(`DROP INDEX IF EXISTS "${index}"`, []);
			await sql.unsafe(`DELETE FROM "${TARGET_TABLE}" WHERE id BETWEEN 950 AND 959`, []);
			await sql.unsafe(`DROP FUNCTION IF EXISTS ${slow}(text)`, []);
		}
	}, 30_000);

	test('the census (boot_status) lists exactly what the runner would still apply', async () => {
		// The suite database is migrated by test:db:setup: nothing of the repo's own is pending.
		const suite = await pendingMigrations();
		const repoFiles = (await Array.fromAsync(new Bun.Glob('*.sql').scan(MIGRATIONS_DIR))).filter(
			(name) => /^\d{4}_/.test(name),
		);
		expect(repoFiles.length).toBeGreaterThan(0);
		expect(suite.pending).toEqual([]);
		expect(suite.applied).toBeGreaterThanOrEqual(repoFiles.length);
		// Against the scratch table: after a run nothing is pending; a deleted row reappears,
		// and the runner applies exactly the census's file (same filter, same order).
		const census = join(dir, '0100_census_probe.sql');
		writeFileSync(census, 'SELECT 1');
		try {
			await runMigrations({ dir, versionTable: VERSION_TABLE });
			expect((await pendingMigrations({ dir, versionTable: VERSION_TABLE })).pending).toEqual([]);
			await sql.unsafe(`DELETE FROM "${VERSION_TABLE}" WHERE version = $1`, [
				'0100_census_probe.sql',
			]);
			const pending = (await pendingMigrations({ dir, versionTable: VERSION_TABLE })).pending;
			expect(pending).toEqual(['0100_census_probe.sql']);
			const rerun = await runMigrations({ dir, versionTable: VERSION_TABLE });
			expect(rerun.applied).toEqual(pending);
			// No version table at all: everything is pending, and nothing is created by asking.
			const absent = `dedalo_ts_test_census_absent_${process.pid}`;
			const none = await pendingMigrations({ dir, versionTable: absent });
			expect(none.applied).toBe(0);
			expect(none.pending).toContain('0100_census_probe.sql');
			const [created] = (await sql.unsafe('SELECT to_regclass($1) IS NOT NULL AS present', [
				`public.${absent}`,
			])) as { present: boolean }[];
			expect(created?.present).toBe(false);
		} finally {
			rmSync(census, { force: true });
			await sql.unsafe(`DELETE FROM "${VERSION_TABLE}" WHERE version = $1`, [
				'0100_census_probe.sql',
			]);
		}
	});

	test('refuses an invalid version-table name (identifier chokepoint)', async () => {
		await expect(runMigrations({ dir, versionTable: 'bad"name; DROP TABLE x' })).rejects.toThrow(
			/invalid version table/,
		);
	});
});

describe('migration content hashes (U-23): an applied file is never edited', () => {
	const hashDir = mkdtempSync(join(tmpdir(), 'dedalo_migrations_hash_'));
	const hashTable = `dedalo_ts_test_migr_hash_${process.pid}`;
	const file = '0001_hash_probe.sql';
	const original = 'SELECT 1';
	const ledgerOf = (content: string, release = '7.0.0'): MigrationLedger => ({
		format: 1,
		migrations: {
			[file]: { sha256: migrationSha256(content), class: 'compatible', release },
		},
	});
	const recordedRow = async () =>
		(
			(await sql.unsafe(`SELECT sha256, release FROM "${hashTable}" WHERE version = $1`, [
				file,
			])) as { sha256: string | null; release: string | null }[]
		)[0];

	afterAll(async () => {
		rmSync(hashDir, { recursive: true, force: true });
		await sql.unsafe(`DROP TABLE IF EXISTS "${hashTable}"`, []);
	});

	test('a run records each file’s sha256 and the release that shipped it', async () => {
		writeFileSync(join(hashDir, file), original);
		const run = await runMigrations({
			dir: hashDir,
			versionTable: hashTable,
			ledger: ledgerOf(original, '7.0.3'),
		});
		expect(run.applied).toEqual([file]);
		expect(await recordedRow()).toEqual({ sha256: migrationSha256(original), release: '7.0.3' });
	});

	test('the file edited after it ran: the run REFUSES, naming it — with or without a ledger', async () => {
		writeFileSync(join(hashDir, file), 'SELECT 2');
		try {
			await expect(runMigrations({ dir: hashDir, versionTable: hashTable })).rejects.toThrow(
				/0001_hash_probe\.sql was applied here as/,
			);
			await expect(
				runOnlineMigrations({ dir: hashDir, versionTable: hashTable }),
			).resolves.toBeDefined(); // recorded files are not the online run's to judge
		} finally {
			writeFileSync(join(hashDir, file), original);
		}
		const healed = await runMigrations({ dir: hashDir, versionTable: hashTable });
		expect(healed.skipped).toBe(1);
	});

	test('a file disagreeing with the frozen ledger is refused BEFORE it is ever applied', async () => {
		const fresh = '0002_hash_unledgered.sql';
		writeFileSync(join(hashDir, fresh), 'SELECT 3');
		try {
			await expect(
				runMigrations({ dir: hashDir, versionTable: hashTable, ledger: ledgerOf(original) }),
			).rejects.toThrow(/0002_hash_unledgered\.sql is not in install\/db\/migrations\.lock\.json/);
			const [row] = (await sql.unsafe(`SELECT 1 FROM "${hashTable}" WHERE version = $1`, [
				fresh,
			])) as unknown[];
			expect(row).toBeUndefined();
			await expect(
				runMigrations({ dir: hashDir, versionTable: hashTable, ledger: ledgerOf('SELECT 9') }),
			).rejects.toThrow(/does not match its frozen hash/);
		} finally {
			rmSync(join(hashDir, fresh), { force: true });
		}
	});

	test('a row recorded before the hash column is backfilled once, then verified', async () => {
		await sql.unsafe(`UPDATE "${hashTable}" SET sha256 = NULL, release = NULL WHERE version = $1`, [
			file,
		]);
		await runMigrations({ dir: hashDir, versionTable: hashTable, ledger: ledgerOf(original) });
		expect(await recordedRow()).toEqual({ sha256: migrationSha256(original), release: '7.0.0' });
		writeFileSync(join(hashDir, file), 'SELECT 4');
		try {
			await expect(runMigrations({ dir: hashDir, versionTable: hashTable })).rejects.toThrow(
				/was applied here as/,
			);
		} finally {
			writeFileSync(join(hashDir, file), original);
		}
	});

	test('throughRelease (an update run’s schema phase): STOPS at the first later-release file; undated files are never beyond', async () => {
		// Scratch dir + planted ledger + scratch version table, a fresh pair per bound.
		const boundDir = mkdtempSync(join(tmpdir(), 'dedalo_migrations_bound_'));
		const files: Record<string, string | null> = {
			'0001_bound_a.sql': '7.0.1',
			'0002_bound_b.sql': '7.0.2',
			'0003_bound_c.sql': '7.1.0',
			'0004_bound_d.sql': '7.0.1', // earlier release AFTER the later one: a break, not a skip
		};
		const contents = (file: string) => `SELECT '${file}'`;
		for (const file of Object.keys(files)) writeFileSync(join(boundDir, file), contents(file));
		const ledger = (planted: Record<string, string | null>): MigrationLedger =>
			({
				format: 1,
				migrations: Object.fromEntries(
					// An undated file: an entry with no release (what `?.release ?? null` reads as null).
					Object.entries(planted).map(([file, release]) => [
						file,
						{
							sha256: migrationSha256(contents(file)),
							class: 'compatible',
							...(release === null ? {} : { release }),
						},
					]),
				),
			}) as unknown as MigrationLedger;
		const tables: string[] = [];
		const run = async (
			planted: Record<string, string | null> | null,
			throughRelease: string | undefined,
		) => {
			const versionTable = `dedalo_ts_test_migr_bound_${process.pid}_${tables.length}`;
			tables.push(versionTable);
			const result = await runMigrations({
				dir: boundDir,
				versionTable,
				ledger: planted === null ? null : ledger(planted),
				...(throughRelease === undefined ? {} : { throughRelease }),
			});
			const recorded = (await sql.unsafe(
				`SELECT version FROM "${versionTable}" ORDER BY version`,
				[],
			)) as { version: string }[];
			return { applied: result.applied, recorded: recorded.map((row) => row.version) };
		};
		try {
			// Bound 7.0.2: the 7.0.1 + 7.0.2 files land; 7.1.0 stops the run, and the
			// later 7.0.1-dated file after it stays unapplied (break, not skip).
			const bounded = await run(files, '7.0.2');
			expect(bounded.applied).toEqual(['0001_bound_a.sql', '0002_bound_b.sql']);
			expect(bounded.recorded).toEqual(['0001_bound_a.sql', '0002_bound_b.sql']);
			// No bound (the boot): every file.
			const all = await run(files, undefined);
			expect(all.applied).toEqual(Object.keys(files));
			// An undated file is never beyond, under any bound — even the lowest one.
			const undated = { ...files, '0001_bound_a.sql': null };
			const lowest = await run(undated, '0.0.1');
			expect(lowest.applied).toEqual(['0001_bound_a.sql']);
			// …and below a dated one it sits in the bounded prefix like any other.
			const undatedMiddle = { ...files, '0002_bound_b.sql': null };
			const middle = await run(undatedMiddle, '7.0.1');
			expect(middle.applied).toEqual(['0001_bound_a.sql', '0002_bound_b.sql']);
			// No ledger at all (a scratch dir): nothing is dated, so a bound stops nothing.
			const unledgered = await run(null, '0.0.1');
			expect(unledgered.applied).toEqual(Object.keys(files));
		} finally {
			rmSync(boundDir, { recursive: true, force: true });
			for (const table of tables) await sql.unsafe(`DROP TABLE IF EXISTS "${table}"`, []);
		}
	});

	test('the shipped run verifies the suite database against the ledger, and records its hashes', async () => {
		// The boot path itself: the default dir + the shipped ledger. It adds the
		// hash column on an older table and backfills — a write, so the marker first.
		await assertTestDatabase('ops_migrations: shipped hash backfill');
		const boot = await runMigrations();
		expect(boot.applied).toEqual([]);
		const ledger = await readMigrationLedger();
		const rows = (await sql.unsafe(
			`SELECT version, sha256 FROM "${MIGRATIONS_VERSION_TABLE}" WHERE sha256 IS NOT NULL`,
			[],
		)) as { version: string; sha256: string }[];
		expect(rows.length).toBeGreaterThanOrEqual(Object.keys(ledger.migrations).length);
		for (const row of rows) {
			expect(row.sha256, row.version).toBe(ledger.migrations[row.version]?.sha256 as string);
		}
	});
});
