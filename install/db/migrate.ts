/**
 * Ordered schema migrations for TS-OWNED tables (audit S2-39, DEC-17 item 7).
 *
 * Scope: ONLY the `dedalo_ts_*` operational tables this server owns (job
 * queue, locks, session mirrors, future additions). The shared matrix/
 * dd_ontology schema is provisioned by the PHP installer during coexistence —
 * a TS-only matrix provisioning path is a documented CUTOVER blocker
 * (engineering/PRODUCTION.md §Schema; DEC-17/DEC-19), not this runner's job.
 *
 * ONE NAMED EXCEPTION — a "seed-defect correction on shared rows" (2026-08-16,
 * first instance 0004_dd560_drop_view_tree.sql). A shipped seed can carry a
 * data mistake that every install inherits; correcting it belongs to the
 * install lane, not to a user edit, so such a file may UPDATE `matrix_*` /
 * `dd_ontology*` rows under FOUR constraints, mechanically gated by
 * test/unit/migration_shared_row_tripwire.test.ts:
 *   1. an UPDATE only — never INSERT / DELETE / TRUNCATE / ALTER / DROP /
 *      CREATE on a shared table (a seed ships through the ontology, a purge is
 *      a tool, a schema change is the installer's);
 *   2. the file carries the tag comment `-- SHARED-ROW SEED CORRECTION:` with
 *      its reason (the gate requires the literal);
 *   3. every such UPDATE pins its WHERE with a jsonb `@>` containment on the
 *      EXACT defective value, so a row an operator has since changed — or
 *      already fixed — is never overwritten (single row / single record);
 *   4. NO TM audit row, by design: this is an install-level correction whose
 *      operator-facing record is the version table itself, not a user write.
 *      The ordinary write law (save_component.ts, tx + TM) is not weakened —
 *      it simply does not apply to a seed correction.
 * Anything outside that shape is not a migration: it goes through
 * db/matrix_write.ts / ontology/ontology_write.ts like every other write.
 *
 * ONE NAMED SCHEMA EXCEPTION — a "shared-schema additive column" (2026-09-27,
 * first instance 0010_tm_role.sql: the time machine's undo-log role). An
 * existing install receives the shared schema ONLY through this lane (the
 * installer restores a seed once, at birth), so a column the engine needs on a
 * shared table has no other road. Such a file may ALTER a shared table under
 * FOUR constraints, gated by the same tripwire:
 *   1. only `ADD COLUMN IF NOT EXISTS <name> <type> [NULL]` — no DEFAULT, no NOT
 *      NULL, nothing else: a nullable default-less column is metadata-only (no
 *      rewrite, no scan, no backfill on a 50M-row table) and changes the
 *      meaning of no existing row; or `ADD CONSTRAINT <name> CHECK (…) NOT
 *      VALID` (binds new rows, skips the validation scan). Never DROP / RENAME
 *      / ALTER COLUMN / a validated constraint;
 *   2. the file carries the tag comment `-- SHARED-SCHEMA ADDITIVE COLUMN:`
 *      with its reason;
 *   3. the file bounds its lock wait with `SET LOCAL lock_timeout` (the ALTER's
 *      instant ACCESS EXCLUSIVE lock queues behind a long reader, and every
 *      reader queues behind it);
 *   4. the column's meaning is documented in its writer home and ledgered in
 *      engineering/wire_contract/.
 *
 * Model (boring on purpose):
 * - migrations/ holds numbered files `NNNN_name.sql`, applied in filename
 *   order inside one transaction each;
 * - the version table records every applied filename; re-runs skip them
 *   (boot is idempotent);
 * - a failed migration ABORTS the run (later files must not leapfrog a hole)
 *   but the caller (startServer) logs and continues serving — the lazy
 *   CREATE IF NOT EXISTS bootstraps in each subsystem remain the fallback;
 * - a migration's RUN is never bounded (`SET LOCAL statement_timeout = 0`,
 *   whatever the pool's DB_STATEMENT_TIMEOUT_MS) — see applyMigration;
 * - every migration's lock WAIT is bounded (`SET LOCAL lock_timeout`, default
 *   MIGRATION_LOCK_TIMEOUT; a file may set its own), and a file that times out
 *   waiting for a lock (SQLSTATE 55P03) is RETRIED after a backoff before the
 *   run gives up — a boot migration never queues forever behind a long reader,
 *   and never makes every other reader queue behind it.
 *
 * ONLINE CLASS (2026-09-27, install/db/online_migration.ts): a file tagged
 * `-- ONLINE MIGRATION:` is NOT run by the boot runner (it is not a hole —
 * later boot files still apply) but by `runOnlineMigrations`, in the
 * background AFTER the listener binds: `CREATE INDEX CONCURRENTLY` + `ANALYZE`
 * only, outside any transaction, recorded once every index it names is VALID.
 * A full-heap index build on a shared table belongs there — pre-listen it kept
 * the socket closed past the systemd watchdog (migration_shared_row_tripwire).
 *
 * Evolving a TS-owned table = append a new numbered .sql here AND ledger it in
 * install/db/migrations.lock.json (sha256, class, release — migration_ledger.ts).
 * Never edit an applied file: the version table records each file's sha256 (U-23,
 * 2026-10-30), so an edited file REFUSES the run on every install that ran the
 * old bytes, and the in-repo ledger refuses it before it is ever applied
 * (migration_content_hash_tripwire). Rows recorded before the hash column are
 * backfilled with the file's hash once, then verified like any other.
 */

import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { sql, withTransaction } from '../../src/core/db/postgres.ts';
import {
	ensureRecordGenerationTable,
	ensureTmRoleColumn,
} from '../../src/core/db/record_generation.ts';
import { compareVersionArrays, parseVersionString } from '../../src/core/update/version.ts';
import {
	ledgerMismatch,
	type MigrationLedger,
	migrationSha256,
	readMigrationLedger,
} from './migration_ledger.ts';
import {
	isOnlineMigration,
	type OnlineStatement,
	parseOnlineMigration,
} from './online_migration.ts';

/** The in-repo migrations directory (this file's sibling). */
export const MIGRATIONS_DIR = resolve(import.meta.dir, 'migrations');

/** Default version table (dedalo_ts_* prefix like every TS-owned table). */
export const MIGRATIONS_VERSION_TABLE = 'dedalo_ts_schema_migrations';

/**
 * The default bound on how long one migration WAITS for a lock (not how long it
 * runs). Applied as `SET LOCAL`, so it dies with the migration's transaction.
 */
export const MIGRATION_LOCK_TIMEOUT = '5s';

/** Backoff before each retry of a migration that hit its lock timeout. */
export const MIGRATION_LOCK_RETRY_DELAYS_MS: readonly number[] = [1000, 2000, 4000, 8000];

/** SQLSTATE lock_not_available — what a lock_timeout raises. */
const LOCK_NOT_AVAILABLE = '55P03';
/** SQLSTATE query_canceled — what pg_cancel_backend raises in an online build. */
const QUERY_CANCELED = '57014';

const MIGRATION_FILE_PATTERN = /^\d{4}_[a-z0-9_]+\.sql$/;
const TABLE_NAME_PATTERN = /^[a-z_][a-z0-9_]*$/;

export interface MigrationRunResult {
	/** Filenames applied by THIS run, in order. */
	applied: string[];
	/** Count of already-recorded files skipped. */
	skipped: number;
	/** Pending ONLINE files left for runOnlineMigrations (boot run only). */
	deferred?: string[];
}

/**
 * The SHIPPED migration files, as the runner sees them (MIGRATION_FILE_PATTERN,
 * filename order) — the one enumeration a gate reads (migration_content_hash),
 * so the ledger is checked against exactly what boot applies, never a copy.
 */
export function shippedMigrationFiles(): string[] {
	return migrationFiles(MIGRATIONS_DIR);
}

/** The migration files of `dir`, in filename order. */
function migrationFiles(dir: string): string[] {
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((name) => MIGRATION_FILE_PATTERN.test(name))
		.sort();
}

/**
 * THE MIGRATION CENSUS, read-only (scripts/ops/boot_status.ts — the production
 * installer's first boot waits on it before arming the watchdog): the files
 * this runner would still apply (online ones included) and how many are
 * recorded. The SAME file filter as the runner (migrationFiles), never a copy:
 * a census that disagreed would wait forever or arm the watchdog mid-migration.
 * No version table yet = nothing recorded (it is never created here).
 */
export async function pendingMigrations(
	options: { dir?: string; versionTable?: string } = {},
): Promise<{ applied: number; pending: string[] }> {
	const versionTable = options.versionTable ?? MIGRATIONS_VERSION_TABLE;
	if (!TABLE_NAME_PATTERN.test(versionTable)) {
		throw new Error(`pendingMigrations: invalid version table name '${versionTable}'`);
	}
	const [exists] = (await sql.unsafe('SELECT to_regclass($1) IS NOT NULL AS present', [
		`public.${versionTable}`,
	])) as { present: boolean }[];
	const rows =
		exists?.present === true
			? ((await sql.unsafe(`SELECT version FROM "${versionTable}"`, [])) as { version: string }[])
			: [];
	const done = new Set(rows.map((row) => row.version));
	return {
		applied: done.size,
		pending: migrationFiles(options.dir ?? MIGRATIONS_DIR).filter((name) => !done.has(name)),
	};
}

/**
 * Create the version table if needed (with the U-23 `sha256` + `release`
 * columns, added in place on an older table); return the recorded filenames
 * with the hash each ran (null for a row recorded before the column existed).
 */
async function recordedVersions(versionTable: string): Promise<Map<string, string | null>> {
	if (!TABLE_NAME_PATTERN.test(versionTable)) {
		throw new Error(`runMigrations: invalid version table name '${versionTable}'`);
	}
	await sql.unsafe(
		`CREATE TABLE IF NOT EXISTS "${versionTable}" (
			version    text PRIMARY KEY,
			applied_at timestamptz NOT NULL DEFAULT now()
		)`,
		[],
	);
	await addLedgerColumns(versionTable);
	const rows = (await sql.unsafe(`SELECT version, sha256 FROM "${versionTable}"`, [])) as {
		version: string;
		sha256: string | null;
	}[];
	return new Map(rows.map((row) => [row.version, row.sha256]));
}

/**
 * Add the U-23 columns to an older version table — ONLY when one is missing.
 * (!) `ADD COLUMN IF NOT EXISTS` takes ACCESS EXCLUSIVE BEFORE it checks, so
 * running it on every boot queued the boot behind any reader of the table (a
 * detached pg_dump holds ACCESS SHARE for its whole run) until the statement
 * timeout failed the boot. The catalog read takes no table lock; the one-time
 * ALTER that remains waits at most `lock_timeout`, then fails loudly.
 */
async function addLedgerColumns(versionTable: string): Promise<void> {
	const present = (await sql.unsafe(
		`SELECT column_name FROM information_schema.columns
		  WHERE table_schema = current_schema() AND table_name = $1 AND column_name IN ('sha256', 'release')`,
		[versionTable],
	)) as { column_name: string }[];
	if (present.length === 2) return;
	await withTransaction(async () => {
		await sql.unsafe(`SET LOCAL lock_timeout = '${MIGRATION_LOCK_TIMEOUT}'`, []);
		await sql.unsafe(
			`ALTER TABLE "${versionTable}" ADD COLUMN IF NOT EXISTS sha256 text, ADD COLUMN IF NOT EXISTS release text`,
			[],
		);
	});
}

/**
 * The ledger a run verifies against: the shipped one for the shipped directory,
 * none for a test's scratch directory unless it passes its own.
 */
async function ledgerFor(
	dir: string,
	ledger: MigrationLedger | null | undefined,
): Promise<MigrationLedger | null> {
	if (ledger !== undefined) return ledger;
	return dir === MIGRATIONS_DIR ? readMigrationLedger() : null;
}

/**
 * Read one migration file and prove it is the file the ledger froze AND the
 * file this database ran (when it ran one). Throws naming the file — a
 * divergent history is never applied over, nor silently skipped.
 */
async function verifiedMigration(
	dir: string,
	file: string,
	recorded: Map<string, string | null>,
	ledger: MigrationLedger | null,
	versionTable: string,
): Promise<{ content: string; sha256: string }> {
	const content = await Bun.file(join(dir, file)).text();
	const mismatch = ledger === null ? null : ledgerMismatch(file, content, ledger);
	if (mismatch !== null) throw new Error(`[migrations] REFUSED: ${mismatch}`);
	const sha256 = migrationSha256(content);
	const ran = recorded.get(file);
	if (ran !== undefined && ran !== null && ran !== sha256) {
		throw new Error(
			`[migrations] REFUSED: ${file} was applied here as ${ran.slice(0, 12)}… but the file is now ${sha256.slice(0, 12)}… — an applied migration was edited; restore the file and ship the change as a new migration`,
		);
	}
	if (ran === null) await backfillHash(versionTable, file, sha256, ledger);
	return { content, sha256 };
}

/** A row recorded before the hash column: stamp the hash it is verified by from now on. */
async function backfillHash(
	versionTable: string,
	file: string,
	sha256: string,
	ledger: MigrationLedger | null,
): Promise<void> {
	await sql.unsafe(
		`UPDATE "${versionTable}" SET sha256 = $2, release = COALESCE(release, $3) WHERE version = $1 AND sha256 IS NULL`,
		[file, sha256, ledger?.migrations[file]?.release ?? null],
	);
}

/**
 * Apply all pending migrations in filename order. `dir`/`versionTable` are
 * injectable for tests (scratch `dedalo_ts_test_*` table + temp dir); the
 * production caller uses the defaults.
 */
export async function runMigrations(options?: {
	dir?: string;
	versionTable?: string;
	/** Override MIGRATION_LOCK_RETRY_DELAYS_MS (tests: short delays). */
	lockRetryDelaysMs?: readonly number[];
	/** The frozen ledger to verify against (default: the shipped one for the shipped dir). */
	ledger?: MigrationLedger | null;
	/**
	 * An update run's schema phase (run/production.ts): apply only the files the
	 * ledger assigns to this release or an earlier one, STOPPING at the first file
	 * of a later release — that file belongs to its own release's phase, which may
	 * come after an ontology step, and rollback.ts judges a phase by its own
	 * release's compat (drill 2026-10-30, B2). Absent (the boot): every pending file.
	 */
	throughRelease?: string;
}): Promise<MigrationRunResult> {
	const dir = options?.dir ?? MIGRATIONS_DIR;
	const versionTable = options?.versionTable ?? MIGRATIONS_VERSION_TABLE;
	if (!TABLE_NAME_PATTERN.test(versionTable)) {
		throw new Error(`runMigrations: invalid version table name '${versionTable}'`);
	}
	const files = migrationFiles(dir);
	if (files.length === 0) return { applied: [], skipped: 0, deferred: [] };
	const alreadyApplied = await recordedVersions(versionTable);
	const ledger = await ledgerFor(dir, options?.ledger);

	const applied: string[] = [];
	const deferred: string[] = [];
	let skipped = 0;
	for (const file of files) {
		if (beyondRelease(ledger?.migrations[file]?.release ?? null, options?.throughRelease)) break;
		const verified = await verifiedMigration(dir, file, alreadyApplied, ledger, versionTable);
		if (alreadyApplied.has(file)) {
			skipped += 1;
			continue;
		}
		if (isOnlineMigration(verified.content)) {
			// Post-listen (runOnlineMigrations) — never a pre-listen heap scan.
			deferred.push(file);
			continue;
		}
		const record: MigrationRecord = {
			file,
			sha256: verified.sha256,
			release: ledger?.migrations[file]?.release ?? null,
		};
		await applyWithLockRetry(
			file,
			() => applyMigration(verified.content, record, versionTable),
			options?.lockRetryDelaysMs ?? MIGRATION_LOCK_RETRY_DELAYS_MS,
		);
		applied.push(file);
		console.log(`[migrations] applied ${file}`);
	}
	return { applied, skipped, deferred };
}

/** Whether a file shipped by `release` lies past the phase's bound (a file the ledger does not date never does). */
function beyondRelease(release: string | null, bound: string | undefined): boolean {
	if (bound === undefined || release === null) return false;
	return compareVersionArrays(parseVersionString(release), parseVersionString(bound)) > 0;
}

/**
 * One migration in one transaction: the DDL and its version record land
 * together or not at all — a crash mid-file never records a half-applied
 * migration (and never skips a failed one on the next boot). The default lock
 * bound is set FIRST, so a file's own `SET LOCAL lock_timeout` overrides it.
 *
 * The RUN is unbounded (`SET LOCAL statement_timeout = 0`): a migration is a
 * deliberate boot-time maintenance statement — under the pool's
 * `DB_STATEMENT_TIMEOUT_MS` a long one died 57014, which is not retried, so the
 * file never landed and every later file queued behind the hole. (A full-heap
 * index build is NOT such a statement: it runs post-listen as an ONLINE file —
 * unbounded here, it held the socket closed past the systemd watchdog.) LOCAL: the pooled connection keeps its request ceiling after COMMIT.
 */
async function applyMigration(
	content: string,
	record: MigrationRecord,
	versionTable: string,
): Promise<void> {
	await withTransaction(async () => {
		await sql.unsafe(`SET LOCAL lock_timeout = '${MIGRATION_LOCK_TIMEOUT}'`, []);
		await sql.unsafe('SET LOCAL statement_timeout = 0', []);
		await sql.unsafe(content, []);
		await sql.unsafe(
			`INSERT INTO "${versionTable}" (version, sha256, release) VALUES ($1, $2, $3)`,
			[record.file, record.sha256, record.release],
		);
	});
}

/** What a version row records: the file, the bytes it ran, the release that shipped it. */
interface MigrationRecord {
	file: string;
	sha256: string;
	release: string | null;
}

/**
 * Run `apply`, retrying after each delay while it fails on a lock timeout. Any
 * other failure — and a lock timeout after the last delay — propagates: the
 * run aborts with the file unrecorded, and the next boot retries it.
 */
async function applyWithLockRetry(
	file: string,
	apply: () => Promise<void>,
	delaysMs: readonly number[],
): Promise<void> {
	for (let attempt = 0; ; attempt += 1) {
		try {
			await apply();
			return;
		} catch (error) {
			const delay = delaysMs[attempt];
			if (!isLockTimeout(error) || delay === undefined) throw error;
			console.warn(
				`[migrations] ${file}: lock wait timed out (attempt ${attempt + 1}); retrying in ${delay}ms`,
			);
			await Bun.sleep(delay);
		}
	}
}

/** Bun's PostgresError carries the SQLSTATE in `errno` (`code` is Bun's own). */
function isLockTimeout(error: unknown): boolean {
	const { errno, code } = (error ?? {}) as { errno?: unknown; code?: unknown };
	return errno === LOCK_NOT_AVAILABLE || code === LOCK_NOT_AVAILABLE;
}

/**
 * A fixed advisory-lock key: ONE online run per database at a time (two
 * instances on one database must never race a build, nor drop each other's
 * in-progress index as an "invalid leftover").
 */
const ONLINE_MIGRATION_LOCK_KEY = 7_020_926_001;

/**
 * THE ONLINE RUN (see the header and online_migration.ts): every pending
 * ONLINE file, in filename order, on ONE reserved connection holding the
 * advisory lock, with no statement or lock bound (a CONCURRENTLY build waits
 * for every older transaction — a backup included — and that wait blocks
 * nobody). Per index: an INVALID leftover of a killed build is dropped first;
 * after the build the index must be VALID, else the file stays unrecorded and
 * the next boot retries it. A failing file stops the run (later online files
 * never leapfrog it). Another process holding the lock → nothing done here.
 * Must be called OUTSIDE any transaction (CONCURRENTLY refuses one).
 */
export function runOnlineMigrations(options?: {
	dir?: string;
	versionTable?: string;
	ledger?: MigrationLedger | null;
}): Promise<MigrationRunResult> {
	const run: OnlineRun = { pid: null, stopping: false, done: Promise.resolve() };
	const result = runOnlineMigrationsAs(run, options);
	run.done = result.then(
		() => undefined,
		() => undefined,
	);
	liveOnlineRuns.add(run);
	void run.done.then(() => liveOnlineRuns.delete(run));
	return result;
}

/**
 * A live online run, as the shutdown sees it: the reserved backend's pid (once
 * reserved), the stop latch the run checks before every statement, and the
 * promise that settles when the run has released its connection.
 */
interface OnlineRun {
	pid: number | null;
	stopping: boolean;
	done: Promise<void>;
}

/**
 * The online runs of THIS process (at most one in practice — boot starts one).
 * Process lifecycle state, never request state: the shutdown must reach a run
 * nobody awaits (startOnlineMigrations is fire-and-forget).
 */
const liveOnlineRuns = new Set<OnlineRun>();

/** Thrown inside a run that a shutdown stopped (the file stays unrecorded). */
class OnlineRunStopped extends Error {}

/**
 * STOP every live online run — the graceful shutdown's hook (server.ts
 * shutdownGracefully, before the pool closes). Without it `pool.end()` waits
 * for the reserved connection's unbounded CONCURRENTLY build, so a SIGTERM
 * mid-build hung the process for the whole build (systemd escalates to
 * SIGKILL; a planned update restart stalls). The latch stops the run between
 * statements; `pg_cancel_backend` cancels the statement in flight (57014). The
 * cancelled file stays UNRECORDED and its INVALID leftover is dropped and
 * rebuilt on the next boot — the same retry as a killed build. Waits at most
 * `timeoutMs` for the run to release its connection; never throws.
 */
export async function stopOnlineMigrations(timeoutMs = 5_000): Promise<void> {
	const runs = [...liveOnlineRuns];
	if (runs.length === 0) return;
	for (const run of runs) {
		run.stopping = true;
		if (run.pid === null) continue;
		try {
			await sql.unsafe('SELECT pg_cancel_backend($1)', [run.pid]);
		} catch (error) {
			console.error('[migrations] cancelling the online build failed:', error);
		}
	}
	await Promise.race([Promise.all(runs.map((run) => run.done)), Bun.sleep(timeoutMs)]);
}

async function runOnlineMigrationsAs(
	run: OnlineRun,
	options?: { dir?: string; versionTable?: string; ledger?: MigrationLedger | null },
): Promise<MigrationRunResult> {
	const dir = options?.dir ?? MIGRATIONS_DIR;
	const versionTable = options?.versionTable ?? MIGRATIONS_VERSION_TABLE;
	const recorded = await recordedVersions(versionTable);
	const ledger = await ledgerFor(dir, options?.ledger);
	const pending: { record: MigrationRecord; statements: OnlineStatement[] }[] = [];
	for (const file of migrationFiles(dir)) {
		if (recorded.has(file)) continue;
		const { content, sha256 } = await verifiedMigration(dir, file, recorded, ledger, versionTable);
		if (isOnlineMigration(content)) {
			const release = ledger?.migrations[file]?.release ?? null;
			pending.push({
				record: { file, sha256, release },
				statements: parseOnlineMigration(file, content),
			});
		}
	}
	if (pending.length === 0) return { applied: [], skipped: recorded.size };
	const reserved = await sql.reserve();
	const applied: string[] = [];
	try {
		const [backend] = (await reserved.unsafe('SELECT pg_backend_pid() AS pid', [])) as {
			pid: number;
		}[];
		run.pid = backend?.pid ?? null;
		const [lock] = (await reserved.unsafe('SELECT pg_try_advisory_lock($1) AS got', [
			ONLINE_MIGRATION_LOCK_KEY,
		])) as { got: boolean }[];
		if (lock?.got !== true) {
			console.warn('[migrations] online run skipped: another process holds the lock');
			return { applied, skipped: recorded.size };
		}
		try {
			await reserved.unsafe('SET statement_timeout = 0', []);
			await reserved.unsafe('SET lock_timeout = 0', []);
			for (const { record, statements } of pending) {
				const { file } = record;
				for (const statement of statements) {
					if (run.stopping) throw new OnlineRunStopped(`online run stopped before ${file}`);
					await runOnlineStatement(reserved, file, statement);
				}
				if (run.stopping) throw new OnlineRunStopped(`online run stopped before recording ${file}`);
				await reserved.unsafe(
					`INSERT INTO "${versionTable}" (version, sha256, release) VALUES ($1, $2, $3) ON CONFLICT (version) DO NOTHING`,
					[file, record.sha256, record.release],
				);
				applied.push(file);
				console.log(`[migrations] applied ${file} (online)`);
			}
		} finally {
			await resetOnlineSession(reserved);
		}
	} finally {
		reserved.release();
	}
	return { applied, skipped: recorded.size };
}

/** One online statement; an index build is checked VALID after it runs. */
async function runOnlineStatement(
	reserved: typeof sql,
	file: string,
	statement: OnlineStatement,
): Promise<void> {
	if (statement.kind === 'analyze') {
		await reserved.unsafe(statement.sql, []);
		return;
	}
	if ((await indexValidity(reserved, statement.indexName)) === false) {
		// A killed CONCURRENTLY build's leftover: IF NOT EXISTS would keep it forever.
		console.warn(`[migrations] ${file}: dropping INVALID leftover ${statement.indexName}`);
		await reserved.unsafe(`DROP INDEX CONCURRENTLY IF EXISTS "${statement.indexName}"`, []);
	}
	await reserved.unsafe(statement.sql, []);
	if ((await indexValidity(reserved, statement.indexName)) !== true) {
		throw new Error(
			`online migration ${file}: ${statement.indexName} is not VALID after its build`,
		);
	}
}

/** `true` valid, `false` present but INVALID, `null` absent. */
async function indexValidity(reserved: typeof sql, indexName: string): Promise<boolean | null> {
	const rows = (await reserved.unsafe(
		`SELECT i.indisvalid AS valid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
		 WHERE c.relname = $1 AND c.relnamespace = 'public'::regnamespace`,
		[indexName],
	)) as { valid: boolean }[];
	return rows.length === 0 ? null : rows[0]?.valid === true;
}

/** Give the reserved connection back as the pool expects it. */
async function resetOnlineSession(reserved: typeof sql): Promise<void> {
	try {
		await reserved.unsafe('RESET statement_timeout', []);
		await reserved.unsafe('RESET lock_timeout', []);
		await reserved.unsafe('SELECT pg_advisory_unlock($1)', [ONLINE_MIGRATION_LOCK_KEY]);
	} catch {
		// a broken connection — the pool discards it; the lock dies with the session
	}
}

/**
 * THE POST-LISTEN ENTRY POINT (startServer, right after the socket binds):
 * the online run in the background. Never throws, never awaited by the boot —
 * a failure is logged and the next boot retries the file.
 */
export function startOnlineMigrations(): Promise<void> {
	return runOnlineMigrations().then(
		() => undefined,
		(error: unknown) => {
			if (isStoppedRun(error)) {
				console.warn('[migrations] online run stopped by shutdown — unrecorded, retried next boot');
				return;
			}
			console.error('[migrations] online migration run failed (retried next boot):', error);
		},
	);
}

/** A run ended by stopOnlineMigrations: the latch, or the cancel (57014). */
function isStoppedRun(error: unknown): boolean {
	if (error instanceof OnlineRunStopped) return true;
	const { errno, code } = (error ?? {}) as { errno?: unknown; code?: unknown };
	return errno === QUERY_CANCELED || code === QUERY_CANCELED;
}

/** The migrations alone, defaults only. */
export function runBootMigrations(): Promise<MigrationRunResult> {
	return runMigrations();
}

/**
 * THE startServer ENTRY POINT: the migrations, then — whatever they did — the
 * `tm_role` column heal, OUTSIDE any transaction, before the first request.
 *
 * A failed run (0010 out of lock retries behind a long dd15 COUNT) is logged
 * and the server serves on (S1-15). Without the heal here, the column stayed
 * missing until some OUTSIDE-transaction reader (a dd15 view, a bulk run's
 * start) happened to heal it — and every door that names it INSIDE its own
 * transaction, where the heal refuses by design (a referenced record's delete,
 * a data wipe, an observer mirror write), failed until then. Now the
 * in-transaction fail-closed path covers only a heal that ALSO failed at boot.
 *
 * THE VERDICT (update audit 2026-10-29, U-01). The server still serves after a
 * failed run, but the failure is no longer only a log line: the verdict is
 * returned, /health goes red on it, and a pending code update is never
 * confirmed by a tree whose schema did not land (src/core/update/boot_state.ts,
 * boot_confirm.ts). `schemaMoved` says whether this run changed the schema at
 * all before it failed — the line between "the old tree can take over" and "a
 * human must restore" (owner rule D-2). `null` = it could not be determined.
 *
 * `migrate` / `tmTable` / `pending` are injectable for the gate (a scratch
 * table, a run that fails, the pending census); production passes none.
 */
export async function runBootSchema(
	options: {
		migrate?: () => Promise<unknown>;
		tmTable?: string;
		pending?: () => Promise<{ pending: string[] }>;
	} = {},
): Promise<BootSchemaVerdict> {
	const pendingOf = options.pending ?? (() => pendingMigrations());
	const before = await pendingFilesOrNull(pendingOf);
	let verdict: BootSchemaVerdict;
	try {
		const result = await (options.migrate ?? runBootMigrations)();
		const run = isMigrationRunResult(result) ? result : null;
		const applied = run?.applied ?? [];
		verdict = {
			state: 'ok',
			applied,
			deferred: run?.deferred ?? [],
			schemaMoved: run === null ? null : applied.length > 0,
			error: null,
		};
	} catch (error) {
		console.error(
			'[migrations] boot migration run FAILED — /health reports it and a pending code update stays unconfirmed:',
			error,
		);
		const after = await pendingFilesOrNull(pendingOf);
		const applied =
			before === null || after === null ? [] : before.filter((file) => !after.includes(file));
		verdict = {
			state: 'failed',
			applied,
			deferred: [],
			schemaMoved: before === null || after === null ? null : applied.length > 0,
			error: error instanceof Error ? error.message : String(error),
		};
	}
	try {
		await ensureRecordGenerationTable();
		await ensureTmRoleColumn(options.tmTable);
	} catch (error) {
		console.error('[migrations] tm_role heal failed at boot (history doors fail closed):', error);
	}
	return verdict;
}

/** The outcome of one boot migration run (runBootSchema). */
export interface BootSchemaVerdict {
	state: 'ok' | 'failed';
	/** Files this run applied (on failure: the ones that landed before it). */
	applied: string[];
	/** ONLINE files left for the post-listen lane. */
	deferred: string[];
	/** Whether this run changed the schema; null = unknown. */
	schemaMoved: boolean | null;
	/** The failure message, null on success. */
	error: string | null;
}

/** The pending files, or null when the census itself cannot be read. */
async function pendingFilesOrNull(
	pendingOf: () => Promise<{ pending: string[] }>,
): Promise<string[] | null> {
	try {
		return (await pendingOf()).pending;
	} catch {
		return null;
	}
}

/** A migrate seam may return anything; only a real run result carries `applied`. */
function isMigrationRunResult(value: unknown): value is MigrationRunResult {
	return (
		typeof value === 'object' &&
		value !== null &&
		Array.isArray((value as { applied?: unknown }).applied)
	);
}
