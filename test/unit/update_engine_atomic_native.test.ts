/**
 * THE DATA-UPDATE ENGINE RUNS AS ONE ATOMIC, SINGLE-FLIGHT, UNBOUNDED UNIT (OPS-6).
 *
 * THE DEFECT. `updateVersion` (src/core/update/engine.ts) ran each checked step as
 * an independent pooled statement: a failing step, a hard-failing script, a
 * server restart or a cancelled job left every EARLIER step committed while the
 * version row was never stamped — a half-migrated install whose version claims
 * it was never touched, and whose rerun re-applies the steps that did land. Two
 * concurrent runs both applied. Every statement also inherited the pool-wide
 * `DB_STATEMENT_TIMEOUT_MS` ceiling, so a migration longer than the request
 * ceiling could never finish, and a DDL step queued behind a long lock with no
 * `lock_timeout` stalled every reader of that table behind it.
 *
 * THE LAW (mirrors install/db/migrate.ts:210-214): one transaction on a
 * connection whose statement ceiling is 0, `SET LOCAL lock_timeout` with a
 * bounded retry, an in-transaction advisory try-lock + version re-read
 * (single-flight; a rerun after a crash IS the resume), scripts under a
 * SAVEPOINT (soft failure = rolled-back step, the transaction stays usable),
 * the version row joined to the same transaction, reconcile strictly AFTER
 * COMMIT, an abort that cancels the running statement.
 *
 * SURFACES. Everything lives on the lane SUITE database (assertTestDatabase
 * first) in two scratch tables named `dedalo_ts_test_upd_<pid>` (step rows) and
 * `…_ver` (the version stamp, through the `writeVersionRow`/`readVersionInTx`
 * seams), plus a `…_seq` sequence ((o): nextval is non-transactional, so a
 * statement that was SENT shows after the rollback) — `matrix_updates` is NEVER
 * written. All are dropped in afterAll. Legs that must control a pool size or
 * ceiling, or kill a backend, run in a child process
 * (test/helpers/child_driver.ts) — (d) among them: it pins
 * DB_MAINTENANCE_POOL_MAX=2, because with one slot the second run waits for the
 * first to commit and the RE-READ refuses it, whatever the try-lock does.
 *
 * Mutation map (each must turn a leg red): plain loop → a/b/g; savepoint
 * dropped → f; try-lock dropped → d; BEGIN logged before the claim → d; in-tx
 * re-read dropped → d'; the run routed to the main pool → c (application_name);
 * `SET LOCAL 0` dropped → c (the setting's source); `SET LOCAL`→`SET` → c (leak
 * probe); cancel listener dropped → e; the cancel (or the verdict's status
 * read) sent through the (saturated) request pool → e'; the sticky abort at the
 * statement door dropped → o; retry dropped → h; retry not logged → h;
 * reconcile inside the tx → i; selection rule dropped → j; the verdict read
 * from the installed version instead of pg_xact_status, or 'in progress' not
 * polled → k; an outside cancel logged as a failed query → l; a soft failure's
 * ROLLBACK TO keeping its commit actions → n; the COMMITTED line missing, or
 * written for a run that did not commit → b/c/f; the verdict's status read
 * taken from the maintenance pool → k''; transaction control not refused at
 * the statement door → p; the checkpoint's transaction-ended verdict
 * classified as a rollback → q.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import {
	isInTransaction,
	registerCommitAction,
	runDetachedFromTransaction,
	sql,
	transactionEndedMidUnit,
} from '../../src/core/db/postgres.ts';
import { assertTestDatabase } from '../../src/core/test_data/test_database_marker.ts';
import {
	catalogKeyOf,
	type DataUpdateDescriptor,
	type UpdateDescriptor,
} from '../../src/core/update/catalog.ts';
import type { UpdateEngineSeams, UpdateRunResponse } from '../../src/core/update/engine.ts';
import * as engineModule from '../../src/core/update/engine.ts';
import { COMMIT_ONLY_ACTIONS_DROPPED_LINE } from '../../src/core/update/scripts.ts';
import { childDriver, driverResult, repoModule } from '../helpers/child_driver.ts';
import { refusalOf } from '../helpers/refusal.ts';
import { scratchFile } from '../helpers/scratch_dir.ts';

// ---------------------------------------------------------------------------
// the FINAL engine surface (spec §2.3), typed here so this gate compiles on the
// pre-fix tree too: a third `run` argument and three new seams.
// ---------------------------------------------------------------------------

interface AtomicSeams extends UpdateEngineSeams {
	/** In-transaction version re-read (default: readInstalledDataVersionStrict). */
	readVersionInTx?: () => Promise<readonly number[]>;
	readXactStatus?: (xid: string) => Promise<string | null>;
	lockTimeout?: string;
	lockRetryDelaysMs?: readonly number[];
}
type RunUpdate = (
	checked: Record<string, unknown>,
	seams?: AtomicSeams,
	run?: { signal?: AbortSignal },
) => Promise<UpdateRunResponse>;
const runUpdate = engineModule.updateVersion as unknown as RunUpdate;

const ROLLBACK_LINE = 'Rolled back: no statement of this run persisted';

const PID = process.pid;
const ROWS = `dedalo_ts_test_upd_${PID}`;
const VER = `dedalo_ts_test_upd_${PID}_ver`;
const LOCKED = `dedalo_ts_test_upd_${PID}_h`;
/** (o): a SEQUENCE — nextval is non-transactional, so a statement that was SENT shows after rollback. */
const SEQ = `dedalo_ts_test_upd_${PID}_seq`;
const LOG_PATH = scratchFile('update_atomic', 'update_atomic.log');
/** The (m) legs' own log, made UNWRITABLE mid-run by a script step. */
const LOG_RO = `${LOG_PATH}.unwritable`;
/** What LOG_RO held when the script made it unwritable (the (m) non-vacuity read). */
let logBeforeUnwritable = '';

/**
 * Make LOG_RO unwritable for every later append: replace the file with a
 * DIRECTORY (EISDIR). Unlike chmod, this also holds when the suite runs as root.
 */
function makeLogUnwritable(): void {
	logBeforeUnwritable = readFileSync(LOG_RO, 'utf8');
	rmSync(LOG_RO, { force: true });
	mkdirSync(LOG_RO);
}

const driver = childDriver('dedalo-update-atomic');

beforeAll(async () => {
	await assertTestDatabase('update_engine_atomic_native');
	await sql.unsafe(
		`CREATE TABLE IF NOT EXISTS "${ROWS}" (id serial PRIMARY KEY, tag text NOT NULL)`,
		[],
	);
	await sql.unsafe(
		`CREATE TABLE IF NOT EXISTS "${VER}" (id serial PRIMARY KEY, version text NOT NULL)`,
		[],
	);
	await sql.unsafe(`CREATE TABLE IF NOT EXISTS "${LOCKED}" (id serial PRIMARY KEY)`, []);
	await sql.unsafe(`CREATE SEQUENCE IF NOT EXISTS "${SEQ}"`, []);
});

afterAll(async () => {
	for (const table of [ROWS, VER, LOCKED]) {
		await sql.unsafe(`DROP TABLE IF EXISTS "${table}"`, []);
	}
	await sql.unsafe(`DROP SEQUENCE IF EXISTS "${SEQ}"`, []);
	// The shared log, the (m) legs' log, and the child legs' own logs.
	for (const suffix of ['', '.crash', '.ceiling', '.saturated', '.single_flight', '.verdict']) {
		rmSync(`${LOG_PATH}${suffix}`, { force: true });
	}
	rmSync(LOG_RO, { force: true, recursive: true });
	driver.dispose();
});

beforeEach(async () => {
	await sql.unsafe(`TRUNCATE "${ROWS}", "${VER}"`, []);
});

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

const insertTag = (tag: string) => `INSERT INTO "${ROWS}" (tag) VALUES ('${tag}')`;

async function rowsTagged(tag: string): Promise<number> {
	const rows = (await sql.unsafe(`SELECT count(*)::int AS n FROM "${ROWS}" WHERE tag = $1`, [
		tag,
	])) as { n: number }[];
	return rows[0]?.n ?? -1;
}

async function versionRows(): Promise<number> {
	const rows = (await sql.unsafe(`SELECT count(*)::int AS n FROM "${VER}"`, [])) as { n: number }[];
	return rows[0]?.n ?? -1;
}

/** The scratch stamp, as the engine would read matrix_updates ([7,0,0] = nothing applied). */
async function readScratchVersion(): Promise<number[]> {
	const rows = (await sql.unsafe(`SELECT version FROM "${VER}" ORDER BY id DESC LIMIT 1`, [])) as {
		version: string;
	}[];
	return rows[0] === undefined ? [7, 0, 0] : rows[0].version.split('.').map(Number);
}

function dataDescriptor(parts: Partial<DataUpdateDescriptor>): DataUpdateDescriptor {
	return {
		versionMajor: 7,
		versionMedium: 0,
		versionMinor: 1,
		updateFromMajor: 7,
		updateFromMedium: 0,
		updateFromMinor: 0,
		updateData: true,
		...parts,
	} as DataUpdateDescriptor;
}

const catalogOf = (descriptor: UpdateDescriptor) => ({ [catalogKeyOf(descriptor)]: descriptor });

/** Every SQL_update_i and run_scripts_i checked — the selection rule's happy path. */
function checkAll(descriptor: DataUpdateDescriptor): Record<string, boolean> {
	const checked: Record<string, boolean> = {};
	(descriptor.sqlUpdate ?? []).forEach((_, index) => {
		checked[`SQL_update_${index}`] = true;
	});
	(descriptor.runScripts ?? []).forEach((_, index) => {
		checked[`run_scripts_${index}`] = true;
	});
	return checked;
}

const SCRIPTS: Record<string, engineModule.UpdateScriptFn> = {
	'zz.ok_insert': async () => {
		await sql.unsafe(insertTag('script_ok'), []);
		return { ok: true };
	},
	'zz.soft_insert_then_fail': async () => {
		await sql.unsafe(insertTag('f_soft'), []);
		return { ok: false, msg: 'soft broke after writing' };
	},
	'zz.next_insert': async () => {
		await sql.unsafe(insertTag('f_next'), []);
		return { ok: true };
	},
	'zz.soft_noop': async () => ({ ok: true }),
	'zz.alter_locked': async () => {
		await sql.unsafe(`ALTER TABLE "${LOCKED}" ADD COLUMN IF NOT EXISTS zz_c3 int`, []);
		return { ok: true };
	},
	'zz.hard_fail': async () => false,
	// (p): a script that tries to END the run's transaction.
	'zz.insert_then_commit': async () => {
		await sql.unsafe(insertTag('p_script'), []);
		await sql.unsafe('COMMIT', []);
		return { ok: true };
	},
	// (k): the run's own transaction id, read from inside it.
	'zz.capture_xid': async () => {
		const rows = (await sql.unsafe('SELECT pg_current_xact_id()::text AS xid', [])) as {
			xid: string;
		}[];
		capturedXid = rows[0]?.xid;
		return { ok: true };
	},
	// (n): a commit-only action queued by a script, then a soft / passing outcome.
	'zz.commit_action_then_soft_fail': async () => {
		await sql.unsafe(insertTag('n_soft'), []);
		registerCommitAction(() => void commitActionsRan.push('soft'));
		return { ok: false, msg: 'soft broke after queueing a commit action' };
	},
	'zz.commit_action_ok': async () => {
		registerCommitAction(() => void commitActionsRan.push('ok'));
		return { ok: true };
	},
	// (o): stopped BETWEEN statements — the script never polls its signal.
	'zz.between_statements': async () => {
		betweenStatements.reached();
		await betweenStatements.resume;
		try {
			await sql.unsafe(`SELECT nextval('"${SEQ}"')`, []);
			betweenStatements.outcome = 'sent';
		} catch (error) {
			betweenStatements.outcome = `refused: ${(error as Error).name}`;
			throw error;
		}
		return { ok: true };
	},
	// (m): the log becomes unwritable mid-run (a full or read-only private
	// dir) — every later update.log write fails.
	'zz.log_unwritable_ok': async () => {
		makeLogUnwritable();
		return { ok: true };
	},
	'zz.log_unwritable_hard': async () => {
		makeLogUnwritable();
		return false;
	},
};

/** (k): the xid the run's own transaction reported. */
let capturedXid: string | undefined;
/** (n): the commit-only actions that ran. */
const commitActionsRan: string[] = [];
/** (o): the between-statements script's handshake. */
const betweenStatements: {
	reached: () => void;
	resume: Promise<void>;
	outcome: string;
} = { reached: () => {}, resume: Promise.resolve(), outcome: '' };

/** What `LOG_PATH` gained since `offset` (the log is shared by every in-process leg). */
function logSince(offset: number): string {
	return existsSync(LOG_PATH) ? readFileSync(LOG_PATH, 'utf8').slice(offset) : '';
}

function logLength(): number {
	return existsSync(LOG_PATH) ? readFileSync(LOG_PATH, 'utf8').length : 0;
}

/** update.log's verdict line of a committed run (tagged with its transaction id). */
const COMMITTED_LINE = /^COMMITTED 7\.0\.1 \[xact \d+\]$/m;
const BEGIN_LINE = 'BEGIN atomic run 7.0.0 -> 7.0.1';

function seamsFor(descriptor: UpdateDescriptor, extra: AtomicSeams = {}): AtomicSeams {
	return {
		catalog: catalogOf(descriptor),
		scripts: SCRIPTS,
		currentVersion: [7, 0, 0],
		logPath: LOG_PATH,
		writeVersionRow: async (version) => {
			await sql.unsafe(`INSERT INTO "${VER}" (version) VALUES ($1)`, [version]);
		},
		readVersionInTx: readScratchVersion,
		reconcileMirrors: async () => ({ repaired: 0, shrinksSkipped: 0 }),
		...extra,
	};
}

async function activeWithMarker(marker: string): Promise<number[]> {
	const rows = (await sql.unsafe(
		`SELECT pid FROM pg_stat_activity
		  WHERE datname = current_database() AND state = 'active'
		    AND pid <> pg_backend_pid() AND position($1 in query) > 0`,
		[marker],
	)) as { pid: number }[];
	return rows.map((row) => row.pid);
}

async function waitForMarker(marker: string, budgetMs: number): Promise<number[]> {
	const deadline = performance.now() + budgetMs;
	while (performance.now() < deadline) {
		const pids = await activeWithMarker(marker);
		if (pids.length > 0) return pids;
		await Bun.sleep(25);
	}
	return [];
}

// ---------------------------------------------------------------------------
// (a) + (g) — a failure anywhere rolls back EVERY statement of the run
// ---------------------------------------------------------------------------

describe('OPS-6 atomic run: a failed run leaves nothing behind', () => {
	test('(a) [INSERT, failing statement] → 0 rows, no version row, the rollback line', async () => {
		const descriptor = dataDescriptor({
			sqlUpdate: [insertTag('a'), 'SELECT no_such_column FROM pg_class'],
		});
		const logBefore = logLength();
		const out = await runUpdate(checkAll(descriptor), seamsFor(descriptor));
		expect(out.ok).toBe(false);
		expect(logSince(logBefore), 'a rolled-back run was logged COMMITTED').not.toMatch(
			COMMITTED_LINE,
		);
		expect(await rowsTagged('a'), 'step 1 of a failed run persisted (no transaction)').toBe(0);
		expect(await versionRows()).toBe(0);
		expect(out.msg.at(-1)).toBe(ROLLBACK_LINE);
	}, 30000);

	test('(g) a hard-failing script after a SQL step → the SQL step is rolled back', async () => {
		const descriptor = dataDescriptor({
			sqlUpdate: [insertTag('g')],
			runScripts: [{ info: 'hard', scriptId: 'zz.hard_fail', stopOnError: true }],
		});
		const out = await runUpdate(checkAll(descriptor), seamsFor(descriptor));
		expect(out.ok).toBe(false);
		expect(await rowsTagged('g'), 'the SQL step before a hard-failing script persisted').toBe(0);
		expect(await versionRows()).toBe(0);
		expect(out.msg.at(-1)).toBe(ROLLBACK_LINE);
	}, 30000);

	test('(f) a SOFT script failure rolls back ITS writes only; the run continues and stamps', async () => {
		const descriptor = dataDescriptor({
			runScripts: [
				{ info: 'soft', scriptId: 'zz.soft_insert_then_fail', stopOnError: false },
				{ info: 'next', scriptId: 'zz.next_insert', stopOnError: true },
			],
		});
		const logBefore = logLength();
		const out = await runUpdate(checkAll(descriptor), seamsFor(descriptor));
		expect(out.ok, out.msg.join(' | ')).toBe(true);
		expect(logSince(logBefore)).toContain(BEGIN_LINE);
		expect(logSince(logBefore), 'a committed run has no COMMITTED line in update.log').toMatch(
			COMMITTED_LINE,
		);
		expect(await rowsTagged('f_soft'), 'a soft-failed script kept its partial write').toBe(0);
		expect(await rowsTagged('f_next')).toBe(1);
		expect(await versionRows()).toBe(1);
	}, 30000);
});

// ---------------------------------------------------------------------------
// (b) — a crash mid-run is a rollback; the rerun is the resume
// ---------------------------------------------------------------------------

const CRASH_MARKER = `ops6_crash_${PID}`;

const CRASH_DRIVER = `
import { sql } from ${repoModule('src/core/db/postgres.ts')};
import { updateVersion } from ${repoModule('src/core/update/engine.ts')};
import { assertTestDatabase } from ${repoModule('src/core/test_data/test_database_marker.ts')};
await assertTestDatabase('update_engine_atomic_native:crash');
const descriptor = {
	versionMajor: 7, versionMedium: 0, versionMinor: 1,
	updateFromMajor: 7, updateFromMedium: 0, updateFromMinor: 0,
	updateData: true,
	sqlUpdate: [${JSON.stringify(insertTag('b'))}, 'SELECT pg_sleep(5) /*${CRASH_MARKER}*/'],
};
let out;
try {
	out = await updateVersion({ SQL_update_0: true, SQL_update_1: true }, {
		catalog: { '701': descriptor },
		currentVersion: [7, 0, 0],
		logPath: ${JSON.stringify(`${LOG_PATH}.crash`)},
		writeVersionRow: async (v) => { await sql.unsafe('INSERT INTO "${VER}" (version) VALUES ($1)', [v]); },
		readVersionInTx: async () => [7, 0, 0],
		reconcileMirrors: async () => ({ repaired: 0, shrinksSkipped: 0 }),
	});
} catch (error) {
	out = { threw: String(error) };
}
console.log('RESULT ' + JSON.stringify(out));
process.exit(0);
`;

describe('OPS-6 crash: a killed backend commits nothing; the rerun applies exactly once', () => {
	test('(b) terminate the backend mid-run → 0/0; a fast rerun → exactly 1 row + 1 version row', async () => {
		const childRun = driver.run('crash_driver.ts', CRASH_DRIVER, {});
		const pids = await waitForMarker(CRASH_MARKER, 15000);
		expect(pids.length, 'the crash driver never reached its sleeping step').toBeGreaterThan(0);
		for (const pid of pids) await sql.unsafe('SELECT pg_terminate_backend($1::int)', [pid]);
		const { exitCode, stderr } = await childRun;
		expect(exitCode, stderr).toBe(0);
		expect(await rowsTagged('b'), 'a step committed before the crash survived it').toBe(0);
		expect(await versionRows()).toBe(0);
		// The killed run logged its steps as they ran ("result: true") and could
		// log nothing after: its log must still read as NOT committed.
		const crashLog = readFileSync(`${LOG_PATH}.crash`, 'utf8');
		expect(crashLog).toContain(BEGIN_LINE);
		expect(crashLog).toContain('result: true');
		expect(crashLog, 'the killed run reads as committed in update.log').not.toMatch(COMMITTED_LINE);

		// The rerun (what an operator does after a restart) IS the resume.
		const rerun = dataDescriptor({ sqlUpdate: [insertTag('b'), 'SELECT 1'] });
		const out = await runUpdate(
			checkAll(rerun),
			seamsFor(rerun, { currentVersion: await readScratchVersion() }),
		);
		expect(out.ok, out.msg.join(' | ')).toBe(true);
		expect(await rowsTagged('b')).toBe(1);
		expect(await versionRows()).toBe(1);
	}, 60000);
});

// ---------------------------------------------------------------------------
// (c) — the run is unbounded by the pool ceiling, and leaks nothing into it
// ---------------------------------------------------------------------------

const CEILING_DRIVER = `
import { getPoolStats, sql } from ${repoModule('src/core/db/postgres.ts')};
import { updateVersion } from ${repoModule('src/core/update/engine.ts')};
import { assertTestDatabase } from ${repoModule('src/core/test_data/test_database_marker.ts')};
await assertTestDatabase('update_engine_atomic_native:ceiling');
const probe = {};
const descriptor = {
	versionMajor: 7, versionMedium: 0, versionMinor: 1,
	updateFromMajor: 7, updateFromMedium: 0, updateFromMinor: 0,
	updateData: true,
	sqlUpdate: ['SELECT pg_sleep(0.6)', ${JSON.stringify(insertTag('c'))}],
	runScripts: [{ info: 'probe', scriptId: 'zz.probe', stopOnError: true }],
};
let out;
try {
	out = await updateVersion({ SQL_update_0: true, SQL_update_1: true, run_scripts_0: true }, {
		catalog: { '701': descriptor },
		scripts: {
			'zz.probe': async () => {
				const rows = await sql.unsafe(
					"SELECT current_setting('statement_timeout') AS st, current_setting('lock_timeout') AS lt, current_setting('application_name') AS app, (SELECT source FROM pg_settings WHERE name = 'statement_timeout') AS src", []);
				probe.statement_timeout = rows[0].st;
				probe.lock_timeout = rows[0].lt;
				// Two mechanisms lift the ceiling, each hiding the other's loss:
				// the pool the run is on, and the unit's own SET LOCAL.
				probe.maintenance_pool = String(rows[0].app).startsWith('dedalo_maintenance:');
				probe.timeout_source = rows[0].src;
				return { ok: true };
			},
		},
		currentVersion: [7, 0, 0],
		logPath: ${JSON.stringify(`${LOG_PATH}.ceiling`)},
		writeVersionRow: async (v) => { await sql.unsafe('INSERT INTO "${VER}" (version) VALUES ($1)', [v]); },
		readVersionInTx: async () => [7, 0, 0],
		reconcileMirrors: async () => ({ repaired: 0, shrinksSkipped: 0 }),
	});
} catch (error) {
	out = { threw: String(error) };
}
// The leak probe: every pooled connection still carries the configured ceiling.
const { max } = getPoolStats();
const pooled = (await Promise.all(Array.from({ length: max * 2 }, () =>
	sql.unsafe("SELECT current_setting('statement_timeout') AS st", [])))).map((rows) => rows[0].st);
console.log('RESULT ' + JSON.stringify({ out, probe, pooled }));
process.exit(0);
`;

describe('OPS-6 ceiling: the run is exempt from DB_STATEMENT_TIMEOUT_MS without leaking it', () => {
	test('(c) a 600ms step under a 200ms pool ceiling completes; statement_timeout=0 + lock_timeout=5s inside; the pool keeps 200ms', async () => {
		const { exitCode, stdout, stderr } = await driver.run('ceiling_driver.ts', CEILING_DRIVER, {
			DB_STATEMENT_TIMEOUT_MS: '200',
		});
		expect(exitCode, stderr).toBe(0);
		const result = driverResult<{
			out: UpdateRunResponse & { threw?: string };
			probe: {
				statement_timeout?: string;
				lock_timeout?: string;
				maintenance_pool?: boolean;
				timeout_source?: string;
			};
			pooled: string[];
		}>(stdout, stderr);
		expect(
			result.out.ok,
			`the long step died under the pool ceiling: ${JSON.stringify(result.out)}`,
		).toBe(true);
		expect(result.probe).toEqual({
			statement_timeout: '0',
			lock_timeout: '5s',
			// On the MAINTENANCE pool (not merely unbounded on the main one)…
			maintenance_pool: true,
			// …and unbounded by the unit's OWN `SET LOCAL` (source 'session'), not
			// only by the pool's startup 0 (which reads 'client').
			timeout_source: 'session',
		});
		expect(readFileSync(`${LOG_PATH}.ceiling`, 'utf8')).toMatch(COMMITTED_LINE);
		expect(result.pooled.length).toBeGreaterThan(0);
		expect(
			result.pooled.filter((value) => value !== '200ms'),
			'a pooled connection lost the configured ceiling after the run (session SET leak)',
		).toEqual([]);
		expect(await rowsTagged('c')).toBe(1);
		expect(await versionRows()).toBe(1);
	}, 60000);
});

// ---------------------------------------------------------------------------
// (d) + (d') — single-flight
// ---------------------------------------------------------------------------

/**
 * (d) runs in a CHILD with DB_MAINTENANCE_POOL_MAX=2 pinned: with ONE slot (the
 * shard children pin 1) run 2 would wait for run 1's slot, meet a free try-lock
 * after run 1 committed, and be refused by the in-transaction RE-READ instead —
 * green with the try-lock deleted. Two slots make both transactions live at
 * once, so only the try-lock can refuse run 2, and the leg asserts it did.
 */
const SINGLE_FLIGHT_MARKER = `ops6_single_flight_${PID}`;
const SINGLE_FLIGHT_DRIVER = `
import { getPoolStats, sql } from ${repoModule('src/core/db/postgres.ts')};
import { updateVersion } from ${repoModule('src/core/update/engine.ts')};
import { assertTestDatabase } from ${repoModule('src/core/test_data/test_database_marker.ts')};
await assertTestDatabase('update_engine_atomic_native:single_flight');
const descriptor = {
	versionMajor: 7, versionMedium: 0, versionMinor: 1,
	updateFromMajor: 7, updateFromMedium: 0, updateFromMinor: 0,
	updateData: true,
	sqlUpdate: ['SELECT pg_sleep(1.5) /*${SINGLE_FLIGHT_MARKER}*/', ${JSON.stringify(insertTag('d'))}],
};
const seams = {
	catalog: { '701': descriptor },
	scripts: {},
	currentVersion: [7, 0, 0],
	logPath: ${JSON.stringify(`${LOG_PATH}.single_flight`)},
	writeVersionRow: async (v) => { await sql.unsafe('INSERT INTO "${VER}" (version) VALUES ($1)', [v]); },
	readVersionInTx: async () => {
		const rows = await sql.unsafe('SELECT version FROM "${VER}" ORDER BY id DESC LIMIT 1', []);
		return rows[0] === undefined ? [7, 0, 0] : rows[0].version.split('.').map(Number);
	},
	reconcileMirrors: async () => ({ repaired: 0, shrinksSkipped: 0 }),
};
const checked = { SQL_update_0: true, SQL_update_1: true };
const settle = (p) => p.then((out) => ({ ok: out.ok, msg: out.msg }), (e) => ({ threw: { code: e?.code, message: e?.message, publicMessage: e?.publicMessage } }));
const sleeping = async () => (await sql.unsafe(
	"SELECT count(*)::int AS n FROM pg_stat_activity WHERE state = 'active' AND pid <> pg_backend_pid() AND position($1 in query) > 0",
	['${SINGLE_FLIGHT_MARKER}']))[0].n;
const first = settle(updateVersion(checked, seams));
let firstSleeping = 0;
for (let i = 0; i < 400 && firstSleeping === 0; i++) { await Bun.sleep(10); firstSleeping = await sleeping(); }
const second = await settle(updateVersion(checked, seams));
// Run 1 is STILL inside its transaction when run 2 has been answered: overlap.
const firstStillSleeping = await sleeping();
const firstOut = await first;
console.log('RESULT ' + JSON.stringify({ maintenanceMax: getPoolStats().maintenance.max, firstSleeping, firstStillSleeping, first: firstOut, second }));
process.exit(0);
`;

describe('OPS-6 single-flight: two runs never both apply', () => {
	test('(d) two LIVE transactions: the try-lock refuses run 2; the steps applied once', async () => {
		rmSync(`${LOG_PATH}.single_flight`, { force: true });
		const { exitCode, stdout, stderr } = await driver.run(
			'single_flight_driver.ts',
			SINGLE_FLIGHT_DRIVER,
			{ DB_MAINTENANCE_POOL_MAX: '2' },
		);
		expect(exitCode, stderr).toBe(0);
		const result = driverResult<{
			maintenanceMax: number;
			firstSleeping: number;
			firstStillSleeping: number;
			first: { ok?: boolean; msg?: string[]; threw?: unknown };
			second: {
				ok?: boolean;
				threw?: { code?: string; message?: string; publicMessage?: string };
			};
		}>(stdout, stderr);
		// Non-vacuity: two maintenance slots, and run 1 was inside its transaction
		// both when run 2 started and after run 2 had been answered.
		expect(result.maintenanceMax).toBe(2);
		expect(result.firstSleeping, 'run 1 never reached its sleeping step').toBeGreaterThan(0);
		expect(result.firstStillSleeping, 'the two runs did not overlap').toBeGreaterThan(0);
		expect(result.first.ok, JSON.stringify(result.first)).toBe(true);
		expect(result.second.threw?.code, JSON.stringify(result.second)).toBe('update.refused');
		// The TRY-LOCK's own refusal — the re-read's ("already applied") must not
		// satisfy this leg.
		expect(result.second.threw?.message).toBe('update refused: another data update is running');
		expect(result.second.threw?.publicMessage).toBe('Another data update is running');
		expect(await rowsTagged('d'), 'both concurrent runs applied their steps').toBe(1);
		expect(await versionRows()).toBe(1);
		// The refused attempt left ONE tagged line and no BEGIN of its own.
		const log = readFileSync(`${LOG_PATH}.single_flight`, 'utf8');
		expect(log.match(/^BEGIN atomic run/gm)?.length ?? 0).toBe(1);
		expect(log).toMatch(
			/^REFUSED \[xact \d+\] \(update refused: another data update is running\) — nothing ran$/m,
		);
		expect(log).toMatch(COMMITTED_LINE);
	}, 60000);

	test("(d') a rerun on a STALE pre-read after a commit is refused by the in-transaction re-read", async () => {
		const descriptor = dataDescriptor({ sqlUpdate: [insertTag('dd')] });
		const first = await runUpdate(checkAll(descriptor), seamsFor(descriptor));
		expect(first.ok, first.msg.join(' | ')).toBe(true);
		// currentVersion is still [7,0,0] — the pre-read a second tab took before
		// the first run committed.
		const refusal = await refusalOf(runUpdate(checkAll(descriptor), seamsFor(descriptor)));
		expect(refusal.code).toBe('update.refused');
		expect(await rowsTagged('dd'), 'an already-applied update applied again').toBe(1);
		expect(await versionRows()).toBe(1);
	}, 30000);
});

// ---------------------------------------------------------------------------
// (e) — abort cancels the running statement and rolls back
// ---------------------------------------------------------------------------

describe('OPS-6 abort: a stopped job cancels its statement and persists nothing', () => {
	test('(e) abort while a step runs → settles < 2s, ok:false, 0 rows, the statement is gone', async () => {
		const marker = `ops6_abort_${PID}`;
		const descriptor = dataDescriptor({
			sqlUpdate: [insertTag('e'), `SELECT pg_sleep(5) /*${marker}*/`],
		});
		const controller = new AbortController();
		const running = runUpdate(checkAll(descriptor), seamsFor(descriptor), {
			signal: controller.signal,
		});
		const pids = await waitForMarker(marker, 10000);
		expect(pids.length, 'the aborted run never reached its sleeping step').toBeGreaterThan(0);
		const abortedAt = performance.now();
		controller.abort();
		const out = await running;
		const settleMs = performance.now() - abortedAt;
		expect(settleMs, 'the abort did not cancel the running statement').toBeLessThan(2000);
		expect(out.ok).toBe(false);
		expect(out.msg[0]).toStartWith('Update aborted');
		expect(out.msg.at(-1)).toBe(ROLLBACK_LINE);
		expect(await rowsTagged('e')).toBe(0);
		expect(await versionRows()).toBe(0);
		expect(await activeWithMarker(marker)).toEqual([]);
	}, 30000);
});

// (e') the abort's cancel must not queue behind a SATURATED request pool: a
// child with DB_POOL_MAX=1 holds its one request slot for the whole run.
const SATURATED_MARKER = `ops6_saturated_${PID}`;
const SATURATED_ABORT_DRIVER = `
import * as pg from ${repoModule('src/core/db/postgres.ts')};
import { updateVersion } from ${repoModule('src/core/update/engine.ts')};
import { assertTestDatabase } from ${repoModule('src/core/test_data/test_database_marker.ts')};
await assertTestDatabase('update_engine_atomic_native:saturated_abort');
// Watchdog: a cancel that queues forever must fail this leg, not hang the file.
setTimeout(() => { console.log('RESULT ' + JSON.stringify({ watchdog: true })); process.exit(0); }, 20000);
const { sql, withTransaction, withUnboundedStatements, getPoolStats } = pg;
const descriptor = {
	versionMajor: 7, versionMedium: 0, versionMinor: 1,
	updateFromMajor: 7, updateFromMedium: 0, updateFromMinor: 0,
	updateData: true,
	sqlUpdate: [${JSON.stringify(insertTag('e2'))}, 'SELECT pg_sleep(5) /*${SATURATED_MARKER}*/'],
};
let releaseHolder;
const holderGate = new Promise((resolve) => { releaseHolder = resolve; });
const holder = withTransaction(() => holderGate);
await Bun.sleep(100);
const saturated = getPoolStats().inUse === getPoolStats().max;
const controller = new AbortController();
const running = updateVersion({ SQL_update_0: true, SQL_update_1: true }, {
	catalog: { '701': descriptor },
	currentVersion: [7, 0, 0],
	logPath: ${JSON.stringify(`${LOG_PATH}.saturated`)},
	writeVersionRow: async () => {},
	readVersionInTx: async () => [7, 0, 0],
	reconcileMirrors: async () => ({ repaired: 0, shrinksSkipped: 0 }),
}, { signal: controller.signal }).then((out) => out, (e) => ({ threw: String(e) }));
// Watch for the sleeping step from the MAINTENANCE pool (the request pool is full).
let seen = false;
for (let i = 0; i < 200 && !seen; i++) {
	await Bun.sleep(25);
	const rows = await withUnboundedStatements(() => sql.unsafe(
		"SELECT count(*)::int AS n FROM pg_stat_activity WHERE state = 'active' AND pid <> pg_backend_pid() AND position($1 in query) > 0",
		['${SATURATED_MARKER}']));
	seen = rows[0].n > 0;
}
const abortedAt = performance.now();
controller.abort();
const out = await Promise.race([running, Bun.sleep(4000).then(() => 'HUNG 4s')]);
const settleMs = performance.now() - abortedAt;
releaseHolder();
await holder;
console.log('RESULT ' + JSON.stringify({ saturated, seen, settleMs, out }));
process.exit(0);
`;

describe('OPS-6 abort under load: the cancel never queues behind the request pool', () => {
	test("(e') the request pool held at max: an abort still cancels the running statement in < 2s", async () => {
		const { exitCode, stdout, stderr } = await driver.run(
			'saturated_abort_driver.ts',
			SATURATED_ABORT_DRIVER,
			{ DB_POOL_MAX: '1', DB_POOL_ACQUIRE_TIMEOUT_MS: '0' },
		);
		expect(exitCode, stderr).toBe(0);
		const result = driverResult<{
			saturated: boolean;
			seen: boolean;
			settleMs: number;
			out: UpdateRunResponse | string;
			watchdog?: boolean;
		}>(stdout, stderr);
		expect(result.watchdog, 'the saturated-abort driver hung (20s watchdog)').toBeUndefined();
		expect(result.saturated, 'the request pool was not saturated (vacuous leg)').toBe(true);
		expect(result.seen, 'the run never reached its sleeping step').toBe(true);
		expect(result.out, 'the abort cancel queued behind the saturated request pool').not.toBe(
			'HUNG 4s',
		);
		expect(result.settleMs).toBeLessThan(2000);
		expect((result.out as UpdateRunResponse).ok).toBe(false);
		expect((result.out as UpdateRunResponse).msg[0]).toStartWith('Update aborted');
		expect(await rowsTagged('e2')).toBe(0);
		expect(await activeWithMarker(SATURATED_MARKER)).toEqual([]);
	}, 60000);
});

// ---------------------------------------------------------------------------
// (l) — a statement cancelled from OUTSIDE (a shutdown, an operator) is an
// interruption, never blamed on the step's SQL
// ---------------------------------------------------------------------------

describe('OPS-6 interruption: an outside cancel is not a query error', () => {
	test('(l) pg_cancel_backend on the running step (no abort signal) → rolled back, "Interrupted", no "Check your query sentence"', async () => {
		const marker = `ops6_interrupt_${PID}`;
		const descriptor = dataDescriptor({
			sqlUpdate: [insertTag('l'), `SELECT pg_sleep(5) /*${marker}*/`],
		});
		const logBefore = logLength();
		const running = runUpdate(checkAll(descriptor), seamsFor(descriptor));
		const pids = await waitForMarker(marker, 10000);
		expect(pids.length, 'the run never reached its sleeping step').toBeGreaterThan(0);
		for (const pid of pids) await sql.unsafe('SELECT pg_cancel_backend($1::int)', [pid]);
		const out = await running;
		const log = logSince(logBefore);
		expect(out.ok).toBe(false);
		expect(out.msg, out.msg.join(' | ')).toContain(engineModule.INTERRUPTED_LINE);
		expect(
			out.msg.filter((line) => line.startsWith('Error on SQL_update')),
			'an outside cancel was reported as the step’s SQL failing',
		).toEqual([]);
		expect(log).not.toContain('Check your query sentence');
		expect(log).toContain('INTERRUPTED (run):');
		expect(log).not.toMatch(COMMITTED_LINE);
		expect(out.msg.at(-1)).toBe(ROLLBACK_LINE);
		expect(await rowsTagged('l')).toBe(0);
		expect(await versionRows()).toBe(0);
	}, 30000);
});

// ---------------------------------------------------------------------------
// (h) — lock_timeout + bounded retry: a DDL step never queues readers behind it
// ---------------------------------------------------------------------------

describe('OPS-6 lock discipline: bounded lock waits, retried', () => {
	test('(h) a DDL step blocked 1.5s by a reader: other readers are never stalled behind it, and the run still lands', async () => {
		const descriptor = dataDescriptor({
			sqlUpdate: [`ALTER TABLE "${LOCKED}" ADD COLUMN IF NOT EXISTS zz_c int`, insertTag('h')],
		});
		// A long reader (ACCESS SHARE) the migration's ALTER (ACCESS EXCLUSIVE) must wait for.
		const holder = await sql.reserve();
		await holder.unsafe('BEGIN', []);
		await holder.unsafe(`LOCK TABLE "${LOCKED}" IN ACCESS SHARE MODE`, []);
		const release = (async () => {
			await Bun.sleep(1500);
			await holder.unsafe('COMMIT', []);
			holder.release();
		})();
		const logBefore = existsSync(LOG_PATH) ? readFileSync(LOG_PATH, 'utf8').length : 0;
		try {
			const running = runUpdate(
				checkAll(descriptor),
				seamsFor(descriptor, { lockTimeout: '200ms', lockRetryDelaysMs: [500, 1000] }),
			);
			// A second, ordinary reader arriving while the migration is waiting.
			await Bun.sleep(350);
			const readerStartedAt = performance.now();
			await sql.unsafe(`SELECT count(*) FROM "${LOCKED}"`, []);
			const readerMs = performance.now() - readerStartedAt;
			const out = await running;
			expect(
				readerMs,
				'an ordinary reader queued behind the migration’s lock wait (no lock_timeout)',
			).toBeLessThan(700);
			expect(out.ok, out.msg.join(' | ')).toBe(true);
			expect(await rowsTagged('h')).toBe(1);
			expect(await versionRows()).toBe(1);
			// The discarded attempt is in update.log — its steps' "result: true"
			// lines must never read as work that landed.
			// Each attempt's lines carry its OWN transaction id.
			const log = readFileSync(LOG_PATH, 'utf8').slice(logBefore);
			const discarded =
				/^ROLLED BACK attempt 1 \[xact (\d+)\] \(a lock wait timed out\) — nothing of it persisted/m.exec(
					log,
				);
			expect(discarded, log).not.toBeNull();
			const committed = /^COMMITTED 7\.0\.1 \[xact (\d+)\]$/m.exec(log);
			expect(committed, log).not.toBeNull();
			expect(committed?.[1]).not.toBe(discarded?.[1]);
			expect(log).toContain(`BEGIN atomic run 7.0.0 -> 7.0.1 [xact ${committed?.[1]}]`);
		} finally {
			await release;
			await sql.unsafe(`ALTER TABLE "${LOCKED}" DROP COLUMN IF EXISTS zz_c`, []);
		}
	}, 30000);

	// (h') A lock that outlives EVERY retry — from a SQL step and from a script —
	// is a whole-unit lock failure: rolled back, reported with the deliberate
	// sentence (SEC-18), never the raw driver text, and never demoted to an
	// ordinary step failure (which would skip the retry). Held for the whole run.
	for (const [leg, parts, column] of [
		[
			'SQL step',
			{
				sqlUpdate: [insertTag('h2'), `ALTER TABLE "${LOCKED}" ADD COLUMN IF NOT EXISTS zz_c2 int`],
			},
			'zz_c2',
		],
		[
			'script',
			{
				sqlUpdate: [insertTag('h2')],
				runScripts: [{ info: 'alter', scriptId: 'zz.alter_locked', stopOnError: true }],
			},
			'zz_c3',
		],
	] as const) {
		test(`(h') ${leg}: a lock held past every retry rolls back with the SEC-18 sentence, no raw driver text`, async () => {
			const descriptor = dataDescriptor(parts as Partial<DataUpdateDescriptor>);
			const holder = await sql.reserve();
			await holder.unsafe('BEGIN', []);
			await holder.unsafe(`LOCK TABLE "${LOCKED}" IN ACCESS SHARE MODE`, []);
			try {
				const out = await runUpdate(
					checkAll(descriptor),
					seamsFor(descriptor, { lockTimeout: '100ms', lockRetryDelaysMs: [50] }),
				);
				expect(out.ok).toBe(false);
				expect(out.msg, out.msg.join(' | ')).toContain(
					'Error: a table lock stayed unavailable through every retry (see update log)',
				);
				expect(out.msg.at(-1)).toBe(ROLLBACK_LINE);
				expect(
					out.msg.filter((line) => /lock timeout|canceling statement|55P03/i.test(line)),
					'raw driver text reached the admin msg (SEC-18)',
				).toEqual([]);
				expect(await rowsTagged('h2')).toBe(0);
				expect(await versionRows()).toBe(0);
			} finally {
				await holder.unsafe('COMMIT', []);
				holder.release();
				await sql.unsafe(`ALTER TABLE "${LOCKED}" DROP COLUMN IF EXISTS ${column}`, []);
			}
		}, 30000);
	}
});

// ---------------------------------------------------------------------------
// (e'') — the lock-retry BACKOFF is abortable: a stop during it settles now
// ---------------------------------------------------------------------------

describe('OPS-6 abort during the lock-retry backoff', () => {
	test("(e'') abort while the run sleeps before its retry → settles < 1s as aborted, nothing persisted", async () => {
		const descriptor = dataDescriptor({
			sqlUpdate: [insertTag('e3'), `ALTER TABLE "${LOCKED}" ADD COLUMN IF NOT EXISTS zz_c4 int`],
		});
		const holder = await sql.reserve();
		await holder.unsafe('BEGIN', []);
		await holder.unsafe(`LOCK TABLE "${LOCKED}" IN ACCESS SHARE MODE`, []);
		const logBefore = logLength();
		const controller = new AbortController();
		try {
			const running = runUpdate(
				checkAll(descriptor),
				seamsFor(descriptor, { lockTimeout: '100ms', lockRetryDelaysMs: [5000] }),
				{ signal: controller.signal },
			);
			// Wait until attempt 1 was discarded: the run is now in its 5s backoff.
			const deadline = performance.now() + 10000;
			while (
				!logSince(logBefore).includes('ROLLED BACK attempt 1') &&
				performance.now() < deadline
			) {
				await Bun.sleep(20);
			}
			expect(
				logSince(logBefore),
				'the run never entered its retry backoff (vacuous leg)',
			).toContain('ROLLED BACK attempt 1');
			const abortedAt = performance.now();
			controller.abort();
			const out = await running;
			const settleMs = performance.now() - abortedAt;
			expect(settleMs, 'the abort waited out the retry backoff').toBeLessThan(1000);
			expect(out.ok).toBe(false);
			expect(out.msg[0], out.msg.join(' | ')).toStartWith('Update aborted');
			expect(out.msg.at(-1)).toBe(ROLLBACK_LINE);
			expect(await rowsTagged('e3')).toBe(0);
			expect(await versionRows()).toBe(0);
		} finally {
			await holder.unsafe('COMMIT', []);
			holder.release();
			await sql.unsafe(`ALTER TABLE "${LOCKED}" DROP COLUMN IF EXISTS zz_c4`, []);
		}
	}, 30000);
});

// ---------------------------------------------------------------------------
// (m) — update.log is ADVISORY: an unwritable log never changes the verdict
// ---------------------------------------------------------------------------

describe('OPS-6 advisory log: a log write that fails after BEGIN never changes the verdict', () => {
	for (const leg of [
		{ name: 'committed', scriptId: 'zz.log_unwritable_ok', ok: true, rows: 1, versions: 1 },
		{ name: 'rolled back', scriptId: 'zz.log_unwritable_hard', ok: false, rows: 0, versions: 0 },
	] as const) {
		test(`(m) ${leg.name}: the log becomes unwritable mid-run → the run still reports its real verdict`, async () => {
			rmSync(LOG_RO, { force: true, recursive: true });
			writeFileSync(LOG_RO, '');
			logBeforeUnwritable = '';
			const descriptor = dataDescriptor({
				sqlUpdate: [insertTag('m')],
				runScripts: [{ info: 'log read-only', scriptId: leg.scriptId, stopOnError: true }],
			});
			let reconciled = 0;
			try {
				const out = await runUpdate(
					checkAll(descriptor),
					seamsFor(descriptor, {
						logPath: LOG_RO,
						reconcileMirrors: async () => {
							reconciled += 1;
							return { repaired: 0, shrinksSkipped: 0 };
						},
					}),
				);
				// Non-vacuity: the log WAS written up to the script, and the script
				// really made it unwritable (a directory now stands at its path).
				expect(logBeforeUnwritable).toContain(BEGIN_LINE);
				expect(() => readFileSync(LOG_RO, 'utf8')).toThrow();
				expect(out.ok, out.msg.join(' | ')).toBe(leg.ok);
				if (leg.ok) {
					expect(out.msg.at(-1)).toBe('Updated version successfully');
					expect(reconciled, 'a committed run skipped its mirror reconcile').toBe(1);
				} else {
					expect(out.msg.at(-1)).toBe(ROLLBACK_LINE);
					expect(reconciled).toBe(0);
				}
				expect(await rowsTagged('m')).toBe(leg.rows);
				expect(await versionRows()).toBe(leg.versions);
			} finally {
				rmSync(LOG_RO, { force: true, recursive: true });
			}
		}, 30000);
	}
});

// ---------------------------------------------------------------------------
// (k) — ONE VERDICT: a failure the engine did not raise is classified by THIS
// run's transaction status (pg_xact_status), never by the installed version
// ---------------------------------------------------------------------------

/** A statement-free failure at the very end: the version-row write throws. */
const failAtEnd = async () => {
	throw new Error('simulated: connection lost during COMMIT');
};

describe('OPS-6 one verdict: an unexplained failure is read back from the transaction, not guessed', () => {
	test('(k) PostgreSQL reports the transaction committed (a lost COMMIT): reported committed, success tail', async () => {
		capturedXid = undefined;
		const asked: string[] = [];
		const descriptor = dataDescriptor({
			sqlUpdate: ['SELECT 1'],
			runScripts: [{ info: 'xid', scriptId: 'zz.capture_xid', stopOnError: true }],
		});
		const out = await runUpdate(
			checkAll(descriptor),
			seamsFor(descriptor, {
				writeVersionRow: failAtEnd,
				readXactStatus: async (xid) => {
					asked.push(xid);
					return 'committed';
				},
			}),
		);
		// The status asked for is THIS run's own transaction.
		expect(capturedXid).toMatch(/^\d+$/);
		expect(asked).toEqual([String(capturedXid)]);
		expect(out.ok, out.msg.join(' | ')).toBe(true);
		expect(out.msg).toContain(engineModule.COMMITTED_DESPITE_FAILURE_LINE);
		// cross-ops:r2: the commit-only actions its writes queued were dropped — said, never silent.
		expect(out.msg).toContain(`The update: ${COMMIT_ONLY_ACTIONS_DROPPED_LINE}`);
		expect(out.msg).not.toContain(ROLLBACK_LINE);
		expect(out.msg.at(-1)).toBe('Updated version successfully');
	});

	test('(k) the installed version reads the TARGET but the transaction aborted (another run stamped it): rolled back', async () => {
		const descriptor = dataDescriptor({ sqlUpdate: [insertTag('k_other')] });
		let reads = 0;
		const out = await runUpdate(
			checkAll(descriptor),
			seamsFor(descriptor, {
				writeVersionRow: failAtEnd,
				// A version compare would read "committed" here.
				readVersionInTx: async () => {
					reads += 1;
					return reads === 1 ? [7, 0, 0] : [7, 0, 1];
				},
				readXactStatus: async () => 'aborted',
			}),
		);
		expect(out.ok, out.msg.join(' | ')).toBe(false);
		expect(out.msg).not.toContain(engineModule.COMMITTED_DESPITE_FAILURE_LINE);
		expect(out.msg.at(-1)).toBe(ROLLBACK_LINE);
		expect(await rowsTagged('k_other')).toBe(0);
	});

	test("(k) a COMMIT still 'in progress' (a synchronous-standby wait) is polled, then read as committed", async () => {
		const answers = ['in progress', 'in progress', 'committed'];
		let asks = 0;
		const descriptor = dataDescriptor({ sqlUpdate: ['SELECT 1'] });
		const out = await runUpdate(
			checkAll(descriptor),
			seamsFor(descriptor, {
				writeVersionRow: failAtEnd,
				readXactStatus: async () => answers[Math.min(asks++, answers.length - 1)] ?? null,
			}),
		);
		expect(asks).toBe(3);
		expect(out.ok, out.msg.join(' | ')).toBe(true);
		expect(out.msg).toContain(engineModule.COMMITTED_DESPITE_FAILURE_LINE);
	});

	for (const [leg, readXactStatus] of [
		[
			'the status cannot be read',
			async () => {
				throw new Error('simulated: the database is unreachable');
			},
		],
		['the status stays in progress', async () => 'in progress'],
		['the status is NULL', async () => null],
	] as const) {
		test(`(k) ${leg}: "outcome unknown", never the rollback line`, async () => {
			const descriptor = dataDescriptor({ sqlUpdate: ['SELECT 1'] });
			const out = await runUpdate(
				checkAll(descriptor),
				seamsFor(descriptor, { writeVersionRow: failAtEnd, readXactStatus }),
			);
			expect(out.ok).toBe(false);
			expect(out.msg.at(-1)).toBe(engineModule.OUTCOME_UNKNOWN_LINE);
			expect(out.msg).not.toContain(ROLLBACK_LINE);
			expect(
				out.msg.filter((line) => /simulated/.test(line)),
				'raw error text reached the admin msg (SEC-18)',
			).toEqual([]);
		}, 15000);
	}

	test('(k) the REAL status read: a failure before COMMIT is reported by PostgreSQL as aborted → rolled back', async () => {
		const descriptor = dataDescriptor({ sqlUpdate: [insertTag('k_real')] });
		const out = await runUpdate(
			checkAll(descriptor),
			seamsFor(descriptor, { writeVersionRow: failAtEnd }),
		);
		expect(out.ok, out.msg.join(' | ')).toBe(false);
		expect(out.msg.at(-1)).toBe(ROLLBACK_LINE);
		expect(await rowsTagged('k_real')).toBe(0);
	});
});

// (k'') the verdict read never queues behind the MAINTENANCE pool: the slot the
// aborted run releases goes straight to the next queued maintenance waiter, so a
// status read taken from that pool waited for whatever that waiter runs (a
// REINDEX: hours). A child with DB_MAINTENANCE_POOL_MAX=2 holds the other slot
// and queues a third statement behind it.
const VERDICT_MARKER = `ops6_verdict_${PID}`;
const VERDICT_DRIVER = `
import * as pg from ${repoModule('src/core/db/postgres.ts')};
import { updateVersion } from ${repoModule('src/core/update/engine.ts')};
import { assertTestDatabase } from ${repoModule('src/core/test_data/test_database_marker.ts')};
await assertTestDatabase('update_engine_atomic_native:verdict');
setTimeout(() => { console.log('RESULT ' + JSON.stringify({ watchdog: true })); process.exit(0); }, 30000);
const { sql, withUnboundedStatements, getPoolStats } = pg;
const descriptor = {
	versionMajor: 7, versionMedium: 0, versionMinor: 1,
	updateFromMajor: 7, updateFromMedium: 0, updateFromMinor: 0,
	updateData: true,
	sqlUpdate: [${JSON.stringify(insertTag('k3'))}, 'SELECT pg_sleep(8) /*${VERDICT_MARKER}_run*/'],
};
const active = async (suffix) => (await sql.unsafe(
	"SELECT count(*)::int AS n FROM pg_stat_activity WHERE state = 'active' AND pid <> pg_backend_pid() AND position($1 in query) > 0",
	['${VERDICT_MARKER}_' + suffix]))[0].n;
const waitFor = async (suffix) => { for (let i = 0; i < 200; i++) { if (await active(suffix) > 0) return true; await Bun.sleep(25); } return false; };
const controller = new AbortController();
const running = updateVersion({ SQL_update_0: true, SQL_update_1: true }, {
	catalog: { '701': descriptor },
	currentVersion: [7, 0, 0],
	logPath: ${JSON.stringify(`${LOG_PATH}.verdict`)},
	writeVersionRow: async () => {},
	readVersionInTx: async () => [7, 0, 0],
	reconcileMirrors: async () => ({ repaired: 0, shrinksSkipped: 0 }),
}, { signal: controller.signal }).then((out) => out, (e) => ({ threw: String(e) }));
const runSeen = await waitFor('run');
const holder = withUnboundedStatements(() => sql.unsafe('SELECT pg_sleep(6) /*${VERDICT_MARKER}_hold*/', [])).then(() => 'done', (e) => String(e));
const holderSeen = await waitFor('hold');
const waiter = withUnboundedStatements(() => sql.unsafe('SELECT pg_sleep(6) /*${VERDICT_MARKER}_wait*/', [])).then(() => 'done', (e) => String(e));
await Bun.sleep(50);
const waitersBefore = getPoolStats().maintenance.waiters;
const abortedAt = performance.now();
controller.abort();
const out = await Promise.race([running, Bun.sleep(5000).then(() => 'HUNG 5s')]);
const settleMs = performance.now() - abortedAt;
await Promise.all([holder, waiter, running]);
console.log('RESULT ' + JSON.stringify({ maintenanceMax: getPoolStats().maintenance.max, runSeen, holderSeen, waitersBefore, settleMs, out }));
process.exit(0);
`;

describe('OPS-6 one verdict, under a busy maintenance pool', () => {
	test("(k'') both maintenance slots busy and a waiter queued: an aborted run's verdict is read in < 2s, not after the waiter", async () => {
		const { exitCode, stdout, stderr } = await driver.run('verdict_driver.ts', VERDICT_DRIVER, {
			DB_MAINTENANCE_POOL_MAX: '2',
			DB_POOL_ACQUIRE_TIMEOUT_MS: '0',
		});
		expect(exitCode, stderr).toBe(0);
		const result = driverResult<{
			maintenanceMax: number;
			runSeen: boolean;
			holderSeen: boolean;
			waitersBefore: number;
			settleMs: number;
			out: UpdateRunResponse | string;
			watchdog?: boolean;
		}>(stdout, stderr);
		expect(result.watchdog, 'the verdict driver hung (30s watchdog)').toBeUndefined();
		// Non-vacuity: two slots, both taken, and a third maintenance statement queued.
		expect(result.maintenanceMax).toBe(2);
		expect(result.runSeen, 'the run never reached its sleeping step').toBe(true);
		expect(result.holderSeen, 'the second slot was never held').toBe(true);
		expect(result.waitersBefore, 'no maintenance waiter was queued (vacuous leg)').toBe(1);
		expect(result.out, "the verdict read queued behind the maintenance pool's waiter").not.toBe(
			'HUNG 5s',
		);
		expect(result.settleMs).toBeLessThan(2000);
		const out = result.out as UpdateRunResponse;
		expect(out.ok).toBe(false);
		expect(out.msg[0]).toStartWith('Update aborted');
		expect(out.msg.at(-1)).toBe(ROLLBACK_LINE);
		expect(await rowsTagged('k3')).toBe(0);
	}, 60000);
});

// ---------------------------------------------------------------------------
// (p) + (q) — a statement can never END the unit; if the checkpoint ever sees
// the transaction id change, the verdict is PARTIAL, never a rollback
// ---------------------------------------------------------------------------

describe('OPS-6 the unit cannot be ended from inside', () => {
	test('(p) a script that issues COMMIT is refused before it is sent: the whole run rolls back, nothing persisted', async () => {
		const descriptor = dataDescriptor({
			sqlUpdate: [insertTag('p_before')],
			runScripts: [{ info: 'commit', scriptId: 'zz.insert_then_commit', stopOnError: true }],
		});
		const logBefore = logLength();
		const out = await runUpdate(checkAll(descriptor), seamsFor(descriptor));
		const log = logSince(logBefore);
		expect(out.ok, out.msg.join(' | ')).toBe(false);
		expect(out.msg.at(-1)).toBe(ROLLBACK_LINE);
		// THE OUTCOME the rollback line claims: had the COMMIT been sent, the SQL
		// step and the script's own insert before it would have persisted.
		expect(await rowsTagged('p_before'), 'the COMMIT reached the server').toBe(0);
		expect(await rowsTagged('p_script')).toBe(0);
		expect(await versionRows()).toBe(0);
		expect(log).toMatch(/^ROLLED BACK \[xact \d+\] — no statement of this run persisted$/m);
		expect(log).not.toMatch(/^PARTIAL/m);
	}, 30000);

	test("(q) the checkpoint's transaction-ended verdict is reported PARTIAL — never the rollback line, never re-asked", async () => {
		const asked: string[] = [];
		const descriptor = dataDescriptor({ sqlUpdate: [insertTag('q_step')] });
		const logBefore = logLength();
		const out = await runUpdate(
			checkAll(descriptor),
			seamsFor(descriptor, {
				// The verdict the checkpoint raises when a COMMIT slipped through a
				// step (unreachable through the pool since the refusal — defense in
				// depth, so it is injected at the last point before COMMIT).
				writeVersionRow: async () => {
					throw transactionEndedMidUnit('100', '101');
				},
				readXactStatus: async (xid) => {
					asked.push(xid);
					return 'aborted';
				},
			}),
		);
		const log = logSince(logBefore);
		expect(out.ok).toBe(false);
		expect(out.msg.at(-1)).toBe(engineModule.PARTIALLY_COMMITTED_LINE);
		expect(out.msg).not.toContain(ROLLBACK_LINE);
		expect(
			asked,
			'a partial commit was classified by asking about a transaction that ended',
		).toEqual([]);
		expect(log).toMatch(
			/^PARTIAL \[xact \d+\] — the transaction ended mid-run \(xact 100 → 101\): the statements before it persisted; the version row is NOT stamped$/m,
		);
		expect(log).not.toMatch(/^ROLLED BACK/m);
	}, 30000);
});

// ---------------------------------------------------------------------------
// (n) — a soft failure's ROLLBACK TO drops the commit actions it queued (W12)
// ---------------------------------------------------------------------------

describe('OPS-6 savepoint: a soft-failed script leaves no commit action behind', () => {
	test('(n) soft script queues a commit action then fails → it never runs; a passing script’s does', async () => {
		commitActionsRan.length = 0;
		const descriptor = dataDescriptor({
			runScripts: [
				{ info: 'soft', scriptId: 'zz.commit_action_then_soft_fail', stopOnError: false },
				{ info: 'ok', scriptId: 'zz.commit_action_ok', stopOnError: true },
			],
		});
		const out = await runUpdate(checkAll(descriptor), seamsFor(descriptor));
		expect(out.ok, out.msg.join(' | ')).toBe(true);
		expect(await rowsTagged('n_soft')).toBe(0);
		expect(await versionRows()).toBe(1);
		expect(commitActionsRan, 'a commit action fired for state the savepoint rolled back').toEqual([
			'ok',
		]);
	}, 30000);
});

// ---------------------------------------------------------------------------
// (o) — the abort is STICKY: no statement is sent after it
// ---------------------------------------------------------------------------

describe('OPS-6 abort between statements: the next statement is never sent', () => {
	test('(o) abort while a script is idle between statements → its next statement is refused unsent; rolled back as aborted', async () => {
		let reached: () => void = () => {};
		const reachedGate = new Promise<void>((resolve) => {
			reached = resolve;
		});
		let resume: () => void = () => {};
		betweenStatements.reached = reached;
		betweenStatements.resume = new Promise<void>((resolve) => {
			resume = resolve;
		});
		betweenStatements.outcome = '';
		const descriptor = dataDescriptor({
			sqlUpdate: [insertTag('o')],
			runScripts: [{ info: 'idle', scriptId: 'zz.between_statements', stopOnError: true }],
		});
		const controller = new AbortController();
		const running = runUpdate(checkAll(descriptor), seamsFor(descriptor), {
			signal: controller.signal,
		});
		await reachedGate;
		controller.abort();
		// Let the one-shot cancel land on the IDLE backend first (a no-op there).
		await Bun.sleep(150);
		resume();
		const out = await running;
		expect(betweenStatements.outcome).toStartWith('refused');
		const [seq] = (await sql.unsafe(`SELECT is_called FROM "${SEQ}"`, [])) as {
			is_called: boolean;
		}[];
		expect(seq?.is_called, 'the statement after the abort reached the server').toBe(false);
		expect(out.ok).toBe(false);
		expect(out.msg[0], out.msg.join(' | ')).toStartWith('Update aborted');
		expect(out.msg.at(-1)).toBe(ROLLBACK_LINE);
		expect(await rowsTagged('o')).toBe(0);
		expect(await versionRows()).toBe(0);
	}, 30000);
});

// ---------------------------------------------------------------------------
// (i) — reconcile runs after COMMIT, outside the transaction, success only
// ---------------------------------------------------------------------------

describe('OPS-6 reconcile: strictly after COMMIT', () => {
	test('(i) the reconciler sees the committed version row, runs outside any transaction; msg order unchanged', async () => {
		const calls: { inTransaction: boolean; committedVersionRows: number }[] = [];
		const reconcileMirrors: AtomicSeams['reconcileMirrors'] = async () => {
			calls.push({
				inTransaction: isInTransaction(),
				// Through the POOL, never the run's own connection: what another
				// request would see.
				committedVersionRows: await runDetachedFromTransaction(() => versionRows()),
			});
			return { repaired: 0, shrinksSkipped: 0 };
		};
		const descriptor = dataDescriptor({ sqlUpdate: [insertTag('i')] });
		const out = await runUpdate(checkAll(descriptor), seamsFor(descriptor, { reconcileMirrors }));
		expect(out.ok, out.msg.join(' | ')).toBe(true);
		expect(calls).toEqual([{ inTransaction: false, committedVersionRows: 1 }]);
		expect(out.msg).toEqual([
			'Updated SQL_update 1',
			'Observer mirrors reconciled: 0 repaired, 0 shrink(s) held (see update log)',
			'Updated Dédalo data version: 7.0.1',
			'Updated version successfully',
		]);

		calls.length = 0;
		const failing = dataDescriptor({ sqlUpdate: ['SELECT no_such_column FROM pg_class'] });
		await sql.unsafe(`TRUNCATE "${VER}"`, []);
		const failed = await runUpdate(checkAll(failing), seamsFor(failing, { reconcileMirrors }));
		expect(failed.ok).toBe(false);
		expect(calls, 'the reconciler ran for a rolled-back update').toEqual([]);
	}, 30000);
});

// ---------------------------------------------------------------------------
// (j) — the selection rule: the stamp claims every step it covers
// ---------------------------------------------------------------------------

describe('OPS-6 selection rule', () => {
	test('(j) a partial SQL selection is refused before any statement runs', async () => {
		const descriptor = dataDescriptor({ sqlUpdate: [insertTag('j1'), insertTag('j2')] });
		const refusal = await refusalOf(runUpdate({ SQL_update_0: true }, seamsFor(descriptor)));
		expect(refusal.code).toBe('update.refused');
		expect(await rowsTagged('j1')).toBe(0);
		expect(await versionRows()).toBe(0);
	}, 30000);

	test('(j) an unchecked stopOnError script is refused; an unchecked soft script is skipped with a line', async () => {
		const descriptor = dataDescriptor({
			runScripts: [
				{ info: 'soft', scriptId: 'zz.soft_noop', stopOnError: false },
				{ info: 'hard', scriptId: 'zz.ok_insert', stopOnError: true },
			],
		});
		const refusal = await refusalOf(runUpdate({ run_scripts_0: true }, seamsFor(descriptor)));
		expect(refusal.code).toBe('update.refused');
		expect(await rowsTagged('script_ok')).toBe(0);

		const out = await runUpdate({ run_scripts_1: true }, seamsFor(descriptor));
		expect(out.ok, out.msg.join(' | ')).toBe(true);
		expect(out.msg).toContain('Skipped script: zz.soft_noop (not re-offered)');
		expect(await rowsTagged('script_ok')).toBe(1);
		expect(await versionRows()).toBe(1);
	}, 30000);
});
