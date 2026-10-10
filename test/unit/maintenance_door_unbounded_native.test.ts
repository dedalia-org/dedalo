/**
 * MAINTENANCE RUNS UNBOUNDED; REQUEST TRAFFIC STAYS BOUNDED (PERF-11 door wrap).
 *
 * THE DEFECT. The statement ceiling (`DB_STATEMENT_TIMEOUT_MS`) is pool-wide, so
 * turning it on — the only bound on a runaway request query — also killed every
 * legitimately long admin action: the search-store backfill, the move_* bulk
 * transforms (including their in-transaction INSERT…SELECT), the data-update
 * background job. That conflict is why the ceiling shipped disabled. A statement
 * that merely WAITS for a lock counts against the ceiling too, so on a busy
 * install an admin action died just for queueing behind a reader.
 *
 * THE LAW. `dispatchWidgetRequest` enters `withUnboundedStatements` around the
 * handler of every action its widget DECLARES maintenance (`unboundedActions`)
 * — and only those: the scope is entered BEFORE any transaction the handler
 * opens, so its in-transaction statements run on the maintenance pool too.
 * Every other action stays on the request pool: the maintenance pool is small,
 * and a cheap read must not queue behind a REINDEX. The update engine declares
 * its own scope, because a background job is detached and never inherits the
 * door's. dataframe_control is NOT maintenance: its per-table/total budgets
 * bound each batch (SET LOCAL statement_timeout = what is left of them).
 *
 * THE MEASUREMENT. A child process with a 300ms ceiling (config is frozen at
 * import — a child is the honest way to set it) holds a conflicting lock for
 * ~1.2s on the table each action writes, then drives the REAL door:
 *   - database_info.backfill_search_stores (TRUNCATE waits on the lock);
 *   - move_to_table on a zz* scratch section (the in-transaction INSERT waits);
 *   - the data-update engine as a detached mediaJobs job (its INSERT waits; the
 *     row it writes is its own application_name — the maintenance pool's).
 * Pre-fix each dies with 57014 at 300ms; post-fix each completes. The same
 * child then saturates the maintenance pool and drives an UNDECLARED action
 * (counters_status.get_value): it completes on the request pool instead of
 * queueing behind the held maintenance slots (a door-wide wrap would hang it).
 * In this process: every declared name is a registered action, EVERY
 * registered action is classified (declared maintenance XOR listed in
 * REQUEST_BOUNDED with its reason — an unclassified action fails), and a
 * dataframe_control batch blocked past EITHER budget (per-table, total — each
 * pinned alone, the other set far beyond the window) is cut at that budget.
 *
 * SURFACES. Lane SUITE database only (assertTestDatabase first). Scratch rows:
 * section `zzmdu1` in matrix_test/matrix_list (swept, with its Time Machine tail,
 * in afterAll); two scratch tables `dedalo_ts_test_upd_<pid>_bg*` (dropped). The
 * backfill rebuilds the lane's derived search stores from its own matrix tables
 * (a derived store — the rebuild is its normal operation). `matrix_updates` is
 * never written.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	type DataframeScanBudgets,
	dataframeControlScan,
	type TableCoverage,
} from '../../src/core/area_maintenance/widgets/dataframe_control.ts';
import { ALL_WIDGET_MODULES } from '../../src/core/area_maintenance/widgets/registry.ts';
import { sql } from '../../src/core/db/postgres.ts';
import { assertTestDatabase } from '../../src/core/test_data/test_database_marker.ts';
import { childDriver, driverResult, repoModule } from '../helpers/child_driver.ts';

const PID = process.pid;
const SECTION = 'zzmdu1';
const SOURCE = 'matrix_test';
const TARGET = 'matrix_list';
const SECTION_IDS = [1, 2, 3];
const BG_ROWS = `dedalo_ts_test_upd_${PID}_bg`;
const BG_VER = `dedalo_ts_test_upd_${PID}_bgver`;
const DEFINITION_FILE = 'zz_ops6_move.json';
/** The move_tld atomicity leg: a scratch section renamed old → new (tld `zzmdu`, this file's). */
const MOVE_OLD = 'zzmdu5';
const MOVE_NEW = 'zzmdu6';
const MOVE_IDS = [1, 2, 3];
const MOVE_FILE = 'zz_ops6_move_tld.json';

const definitionsDir = mkdtempSync(join(tmpdir(), 'dedalo-perf11-defs-'));
const driver = childDriver('dedalo-maintenance-door');

async function countOf(table: string): Promise<number> {
	const rows = (await sql.unsafe(
		`SELECT count(*)::int AS n FROM "${table}" WHERE section_tipo = $1`,
		[SECTION],
	)) as { n: number }[];
	return rows[0]?.n ?? -1;
}

async function sweepSection(): Promise<void> {
	for (const table of [SOURCE, TARGET, 'matrix_time_machine']) {
		await sql.unsafe(`DELETE FROM "${table}" WHERE section_tipo IN ($1, $2, $3)`, [
			SECTION,
			MOVE_OLD,
			MOVE_NEW,
		]);
	}
	// the move_tld leg's carries (counter + generation epochs), under either name
	for (const table of ['matrix_counter', 'matrix_counter_dd']) {
		await sql.unsafe(`DELETE FROM ${table} WHERE tipo IN ($1, $2)`, [MOVE_OLD, MOVE_NEW]);
	}
	await sql.unsafe(
		`DO $$ BEGIN IF to_regclass('dedalo_ts_record_generation') IS NOT NULL THEN
		   DELETE FROM dedalo_ts_record_generation WHERE section_tipo IN ('${MOVE_OLD}', '${MOVE_NEW}');
		 END IF; END $$`,
		[],
	);
}

interface DoorResult {
	ok: boolean;
	/** The action was observed queued behind the held lock (non-vacuity). */
	waited?: boolean;
	value?: unknown;
	error?: { code?: string; errno?: string; message?: string; publicMessage?: string };
	errors?: string[];
}

const DRIVER = `
import { getPoolStats, sql, withTransaction, withUnboundedStatements } from ${repoModule('src/core/db/postgres.ts')};
import { dispatchWidgetRequest } from ${repoModule('src/core/area_maintenance/widgets/registry.ts')};
import { mediaJobs } from ${repoModule('src/core/media/jobs.ts')};
import { updateVersion } from ${repoModule('src/core/update/engine.ts')};
import { assertTestDatabase } from ${repoModule('src/core/test_data/test_database_marker.ts')};
await assertTestDatabase('maintenance_door_unbounded_native');
const ROOT = { userId: -1, isGlobalAdmin: true, isDeveloper: true };
/** How long the holder keeps the lock AFTER the action is seen waiting on it (> the 300ms ceiling). */
const HOLD_AFTER_WAIT_MS = 1000;

/**
 * Hold \`statement\`'s lock on a SEPARATE connection. The release is keyed to the
 * OUTCOME, not a timer: once an ungranted lock on \`table\` appears (the action is
 * queued behind us) it is held HOLD_AFTER_WAIT_MS longer, so the action provably
 * waits past the ceiling. \`done\` resolves (after release) to whether a waiter was seen.
 */
async function holdLock(statement, table) {
	const holder = await sql.reserve();
	await holder.unsafe('BEGIN', []);
	await holder.unsafe(statement, []);
	let waited = false;
	const done = (async () => {
		const deadline = Date.now() + 20000;
		while (Date.now() < deadline) {
			const rows = await sql.unsafe(
				'SELECT count(*)::int AS n FROM pg_locks WHERE relation = to_regclass($1) AND NOT granted', [table]);
			if (rows[0].n > 0) { waited = true; break; }
			await Bun.sleep(10);
		}
		await Bun.sleep(HOLD_AFTER_WAIT_MS);
		await holder.unsafe('COMMIT', []);
		holder.release();
		return waited;
	})();
	// Wrapped: an async function returning the bare promise would be FLATTENED by the
	// caller's await, which would then wait out the whole hold before acting.
	return { done };
}
/**
 * A move_* EXECUTE through the door is a maintenance JOB (OPS-6/PERF-11 r3): the
 * door answers {pid, pfile} at once; the report is the job's final data. Resolves
 * to the report like the pre-job inline response, and rejects the same way a
 * failed run ends (the job's status 'error' with a typed maintenance.action_failed).
 */
async function runExecute(source, options) {
	const response = await dispatchWidgetRequest(ROOT, source, options);
	const id = String(response.extend?.pfile ?? '').slice(0, -'.json'.length);
	const deadline = Date.now() + 60000;
	let status = mediaJobs.status(id);
	while (status !== null && (status.status === 'queued' || status.status === 'running') && Date.now() < deadline) {
		await Bun.sleep(50);
		status = mediaJobs.status(id);
	}
	if (status?.status !== 'done' || status.data?.ok !== true) {
		throw Object.assign(new Error(\`\${source.model} job \${id} ended \${status?.status}: \${status?.data?.msg} \${JSON.stringify(status?.data?.errors ?? status?.errors)}\`), { code: 'maintenance.action_failed' });
	}
	return { msg: status.data.msg, ...(status.data.errors.length === 0 ? {} : { errors: status.data.errors }) };
}
function describe(e) {
	return { code: e?.code, errno: e?.errno ?? e?.cause?.errno, message: String(e?.message ?? e).slice(0, 400),
		publicMessage: e?.publicMessage };
}
const results = {};

// 1. the search-store backfill (TRUNCATE needs ACCESS EXCLUSIVE).
{
	const { done: held } = await holdLock('LOCK TABLE matrix_string_search IN ACCESS SHARE MODE', 'matrix_string_search');
	try {
		const response = await dispatchWidgetRequest(ROOT,
			{ model: 'database_info', action: 'backfill_search_stores' }, {});
		results.backfill = { ok: true, errors: response.errors ?? [] };
	} catch (e) { results.backfill = { ok: false, error: describe(e) }; }
	results.backfill.waited = await held;
}

// 2. move_to_table: the in-transaction INSERT…SELECT into the target table.
{
	const { done: held } = await holdLock('LOCK TABLE ${TARGET} IN SHARE MODE', '${TARGET}');
	try {
		const response = await runExecute(
			{ model: 'move_to_table', action: 'move_to_table' },
			{ files_selected: [${JSON.stringify(DEFINITION_FILE)}], dry_run: false });
		results.move_to_table = { ok: true, errors: response.errors ?? [], value: response.msg };
	} catch (e) { results.move_to_table = { ok: false, error: describe(e) }; }
	results.move_to_table.waited = await held;
}

// 3. the data-update engine as a DETACHED background job (the widget's worker shape).
{
	const descriptor = {
		versionMajor: 7, versionMedium: 0, versionMinor: 1,
		updateFromMajor: 7, updateFromMedium: 0, updateFromMinor: 0,
		updateData: true,
		sqlUpdate: ["INSERT INTO \\"${BG_ROWS}\\" (tag) VALUES (current_setting('application_name'))"],
	};
	const { done: held } = await holdLock('LOCK TABLE "${BG_ROWS}" IN SHARE MODE', '"${BG_ROWS}"');
	const record = mediaJobs.submit('update_data', async ({ signal }) => updateVersion(
		{ SQL_update_0: true },
		{
			catalog: { '701': descriptor },
			currentVersion: [7, 0, 0],
			logPath: ${JSON.stringify(join(tmpdir(), `dedalo_perf11_bg_${PID}.log`))},
			writeVersionRow: async (v) => { await sql.unsafe('INSERT INTO "${BG_VER}" (version) VALUES ($1)', [v]); },
			readVersionInTx: async () => {
				const rows = await sql.unsafe('SELECT version FROM "${BG_VER}" ORDER BY id DESC LIMIT 1', []);
				return rows[0] === undefined ? [7, 0, 0] : rows[0].version.split('.').map(Number);
			},
			reconcileMirrors: async () => ({ repaired: 0, shrinksSkipped: 0 }),
		},
		{ signal },
	), { lane: 'maintenance' });
	const deadline = Date.now() + 20000;
	let status = mediaJobs.status(record.id);
	while (status !== null && (status.status === 'queued' || status.status === 'running') && Date.now() < deadline) {
		await Bun.sleep(50);
		status = mediaJobs.status(record.id);
	}
	results.background = { ok: status?.status === 'done', value: { status: status?.status, data: status?.data, errors: status?.errors } };
	results.background.waited = await held;
}

// 4. an UNDECLARED action with the maintenance pool SATURATED: it runs on the
// request pool, so it completes (a door-wide wrap would queue it behind the
// held slots — forever, at this child's acquire timeout of 0).
{
	let release;
	const gate = new Promise((resolve) => { release = resolve; });
	const max = getPoolStats().maintenance.max;
	const holders = Array.from({ length: max }, () => withUnboundedStatements(() => withTransaction(() => gate)));
	await Bun.sleep(100);
	const saturated = getPoolStats().maintenance.inUse === max;
	const outcome = await Promise.race([
		dispatchWidgetRequest(ROOT, { model: 'counters_status', action: 'get_value' }, {})
			.then((response) => ({ ok: true, rows: response.data?.datalist?.length ?? 0 }), (e) => ({ ok: false, error: describe(e) })),
		Bun.sleep(10000).then(() => ({ ok: false, hung: true })),
	]);
	release();
	await Promise.allSettled(holders);
	results.undeclared = { ...outcome, value: { saturated } };
}

// 5-6. THE LOCK BOUND. Lifting the ceiling must not lift the bound on a LOCK WAIT:
// a declared action queued for ACCESS EXCLUSIVE behind a long reader would
// otherwise hold every LATER reader of that table queued behind it for as long as
// the long reader runs. The holder below keeps its lock until released, or until
// LOCK_HOLD_CAP_MS after it is ARMED (once the action is seen waiting — so a
// pre-fix run settles instead of hanging, and a slow runner cannot expire the
// hold before the action even queues).
const LOCK_HOLD_CAP_MS = 15000;
async function holdUntilReleased(statement) {
	const holder = await sql.reserve();
	await holder.unsafe('BEGIN', []);
	await holder.unsafe(statement, []);
	let released = false;
	let requestRelease;
	let armCap;
	const requested = new Promise((resolve) => { requestRelease = resolve; });
	const armed = new Promise((resolve) => { armCap = resolve; });
	const done = (async () => {
		await Promise.race([requested, armed.then(() => Bun.sleep(LOCK_HOLD_CAP_MS))]);
		await holder.unsafe('COMMIT', []);
		holder.release();
		released = true;
	})();
	return {
		arm: () => armCap(),
		release: () => { requestRelease(); return done; },
		isHeld: () => !released,
	};
}
async function sawWaiter(table, mode) {
	const deadline = Date.now() + 20000;
	while (Date.now() < deadline) {
		const rows = await sql.unsafe(
			'SELECT count(*)::int AS n FROM pg_locks WHERE relation = to_regclass($1) AND mode = $2 AND NOT granted',
			[table, mode]);
		if (rows[0].n > 0) return true;
		await Bun.sleep(10);
	}
	return false;
}

// 5. backfill_search_stores queued for ACCESS EXCLUSIVE (its TRUNCATE) behind a long
// reader; a SECOND reader arrives behind it. The second reader must get through
// while the long reader still holds its lock.
{
	const hold = await holdUntilReleased('LOCK TABLE matrix_string_search IN ACCESS SHARE MODE');
	const startedAt = performance.now();
	const action = dispatchWidgetRequest(ROOT, { model: 'database_info', action: 'backfill_search_stores' }, {})
		.then((response) => ({ ok: true, errors: response.errors ?? [] }), (e) => ({ ok: false, error: describe(e) }));
	const waited = await sawWaiter('matrix_string_search', 'AccessExclusiveLock');
	hold.arm();
	// The reader runs on its own connection with NO ceiling, so only the lock
	// queue decides when it finishes (this child's request ceiling is 300ms).
	const reader = await sql.reserve();
	let readerDoneWhileHeld = false;
	try {
		await reader.unsafe('BEGIN', []);
		await reader.unsafe('SET LOCAL statement_timeout = 0', []);
		await reader.unsafe('SELECT count(*) FROM matrix_string_search', []);
		readerDoneWhileHeld = hold.isHeld();
		await reader.unsafe('COMMIT', []);
	} finally {
		reader.release();
	}
	const outcome = await action;
	const value = { readerDoneWhileHeld, heldAtVerdict: hold.isHeld(), actionMs: performance.now() - startedAt };
	await hold.release();
	results.lock_bound_backfill = { ...outcome, waited, value };
}

// 6. an action that lets the failure escape (relation_integrity_report reads the
// relation store under a held ACCESS EXCLUSIVE): the bounded wait reaches the
// wire as the typed, retryable 503 — not a 500 internal.unexpected.
{
	const hold = await holdUntilReleased('LOCK TABLE matrix_relation_index IN ACCESS EXCLUSIVE MODE');
	const startedAt = performance.now();
	const action = dispatchWidgetRequest(ROOT, { model: 'database_info', action: 'relation_integrity_report' }, {})
		.then((response) => ({ ok: true, value: response.data }), (e) => ({ ok: false, error: describe(e) }));
	const waited = await sawWaiter('matrix_relation_index', 'AccessShareLock');
	hold.arm();
	const outcome = await action;
	const value = { heldAtVerdict: hold.isHeld(), actionMs: performance.now() - startedAt };
	await hold.release();
	results.lock_bound_typed = { ...outcome, waited, value };
}

// 7. move_tld is ONE atomic unit per definition file. Its section rename spans
// every matrix table, the Time Machine tail, and the generation/counter carries;
// on the maintenance lane every statement carries the 5s lock-wait bound. A row
// lock on the section's TM row, held PAST that bound, must never leave the section
// split between the old and the new tipo — not while held (a committed half), not
// after (a half the report calls an error). Sampled from outside, every instant.
{
	const MOVE_HOLD_MS = 6500; // > MAINTENANCE_LOCK_TIMEOUT: the first attempt's wait runs out
	const holder = await sql.reserve();
	await holder.unsafe('BEGIN', []);
	await holder.unsafe("SELECT id FROM matrix_time_machine WHERE section_tipo = '${MOVE_OLD}' FOR UPDATE", []);
	const splitState = async () => (await sql.unsafe(
		"SELECT (SELECT count(*)::int FROM matrix_test WHERE section_tipo = '${MOVE_OLD}') AS data_old, " +
		"(SELECT count(*)::int FROM matrix_test WHERE section_tipo = '${MOVE_NEW}') AS data_new, " +
		"(SELECT count(*)::int FROM matrix_time_machine WHERE section_tipo = '${MOVE_OLD}') AS tm_old, " +
		"(SELECT count(*)::int FROM matrix_time_machine WHERE section_tipo = '${MOVE_NEW}') AS tm_new", []))[0];
	const startedAt = performance.now();
	const action = runExecute({ model: 'move_tld', action: 'move_tld' },
		{ files_selected: [${JSON.stringify(MOVE_FILE)}], dry_run: false })
		.then((response) => ({ ok: true, errors: response.errors ?? [], value: response.msg }), (e) => ({ ok: false, error: describe(e) }));
	let waited = false;
	const waitDeadline = Date.now() + 20000;
	while (Date.now() < waitDeadline) {
		const rows = await sql.unsafe(
			"SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND application_name LIKE 'dedalo_maintenance:%' AND wait_event_type = 'Lock'", []);
		if (rows[0].n > 0) { waited = true; break; }
		await Bun.sleep(10);
	}
	const samples = [];
	const heldUntil = Date.now() + MOVE_HOLD_MS;
	while (Date.now() < heldUntil) {
		samples.push(await splitState());
		await Bun.sleep(200);
	}
	await holder.unsafe('COMMIT', []);
	holder.release();
	const outcome = await action;
	results.move_tld_atomic = { ...outcome, waited,
		value: { samples, final: await splitState(), actionMs: performance.now() - startedAt, holdMs: MOVE_HOLD_MS } };
}

console.log('RESULT ' + JSON.stringify(results));
process.exit(0);
`;

let results: Record<string, DoorResult> = {};

beforeAll(async () => {
	await assertTestDatabase('maintenance_door_unbounded_native');
	await sweepSection();
	for (const sectionId of SECTION_IDS) {
		await sql.unsafe(
			`INSERT INTO "${SOURCE}" (section_id, section_tipo, "data") VALUES ($1, $2, $3::text::jsonb)`,
			[sectionId, SECTION, JSON.stringify({ zzmdu11: [{ note: `perf11 row ${sectionId}` }] })],
		);
	}
	await sql.unsafe(
		`CREATE TABLE IF NOT EXISTS "${BG_ROWS}" (id serial PRIMARY KEY, tag text NOT NULL)`,
		[],
	);
	await sql.unsafe(
		`CREATE TABLE IF NOT EXISTS "${BG_VER}" (id serial PRIMARY KEY, version text NOT NULL)`,
		[],
	);
	for (const sectionId of MOVE_IDS) {
		await sql.unsafe(
			`INSERT INTO "${SOURCE}" (section_id, section_tipo, "data") VALUES ($1, $2, $3::text::jsonb)`,
			[sectionId, MOVE_OLD, JSON.stringify({ zzmdu51: [{ note: `move_tld row ${sectionId}` }] })],
		);
	}
	// ONE Time Machine row of the section: the lock the leg holds sits on it.
	await sql.unsafe(
		`INSERT INTO matrix_time_machine (section_id, section_tipo, tipo, lang, "timestamp", user_id)
		 VALUES (1, $1, $1, 'lg-nolan', now(), '-1')`,
		[MOVE_OLD],
	);
	mkdirSync(join(definitionsDir, 'move_tld'), { recursive: true });
	writeFileSync(
		join(definitionsDir, 'move_tld', MOVE_FILE),
		JSON.stringify([{ old: MOVE_OLD, new: MOVE_NEW, type: 'section' }]),
	);
	mkdirSync(join(definitionsDir, 'move_to_table'), { recursive: true });
	writeFileSync(
		join(definitionsDir, 'move_to_table', DEFINITION_FILE),
		JSON.stringify([{ source_section: SECTION, source_table: SOURCE, target_table: TARGET }]),
	);

	const { exitCode, stdout, stderr } = await driver.run('maintenance_door_driver.ts', DRIVER, {
		DB_STATEMENT_TIMEOUT_MS: '300',
		DB_POOL_ACQUIRE_TIMEOUT_MS: '0',
		DEDALO_TRANSFORM_DEFINITIONS_DIR: definitionsDir,
	});
	if (exitCode !== 0) throw new Error(`door driver exited ${exitCode}:\n${stderr}`);
	results = driverResult<Record<string, DoorResult>>(stdout, stderr);
}, 180000);

afterAll(async () => {
	await sweepSection();
	for (const table of [BG_ROWS, BG_VER]) await sql.unsafe(`DROP TABLE IF EXISTS "${table}"`, []);
	for (const table of [SOURCE, TARGET]) expect(await countOf(table)).toBe(0);
	const moveLeft = (await sql.unsafe(
		`SELECT count(*)::int AS n FROM "${SOURCE}" WHERE section_tipo IN ($1, $2)`,
		[MOVE_OLD, MOVE_NEW],
	)) as { n: number }[];
	expect(moveLeft[0]?.n).toBe(0);
	rmSync(definitionsDir, { recursive: true, force: true });
	rmSync(join(tmpdir(), `dedalo_perf11_bg_${PID}.log`), { force: true });
	driver.dispose();
});

/**
 * A fired ceiling, in either spelling: the raw driver text (pre-PERF-11, or a
 * lane that is never typed) AND the typed `db.statement_timeout` message
 * ("… ran past its <n>ms statement ceiling"). Matching only the raw text made
 * the backfill leg vacuous once the ceiling became typed (mutation-verified:
 * removing the door's scope left it green).
 */
const TIMEOUT_TEXT = /statement timeout|statement ceiling|canceling statement|57014/i;

describe('admin actions through the widget door run past the request ceiling', () => {
	test('database_info.backfill_search_stores completes while queued behind a reader', async () => {
		const backfill = results.backfill;
		expect(backfill, 'backfill leg did not run').toBeDefined();
		expect(backfill?.waited, 'the backfill never queued behind the held lock (vacuous leg)').toBe(
			true,
		);
		expect(backfill?.ok, JSON.stringify(backfill)).toBe(true);
		expect(
			(backfill?.errors ?? []).filter((line) => TIMEOUT_TEXT.test(line)),
			'the backfill died on the request ceiling',
		).toEqual([]);
		// The backfill reports a per-store failure as an `errors` line, not a throw:
		// ANY error line means a store was not rebuilt (a rolled-back TRUNCATE
		// leaves the old rows, so the row count below cannot tell).
		expect(backfill?.errors ?? [], 'the backfill reported a failed store').toEqual([]);
		const rows = (await sql.unsafe('SELECT count(*)::int AS n FROM matrix_string_search', [])) as {
			n: number;
		}[];
		expect(rows[0]?.n ?? 0).toBeGreaterThan(0);
	});

	test('move_to_table (in-transaction INSERT…SELECT) completes while its target is locked', async () => {
		const move = results.move_to_table;
		expect(move, 'move_to_table leg did not run').toBeDefined();
		expect(move?.waited, 'the transform never queued behind the held lock (vacuous leg)').toBe(
			true,
		);
		expect(move?.ok, `the transform died on the request ceiling: ${JSON.stringify(move)}`).toBe(
			true,
		);
		expect(await countOf(TARGET)).toBe(SECTION_IDS.length);
		expect(await countOf(SOURCE)).toBe(0);
	});
});

/** The cap the lock holder releases at on its own (the driver's LOCK_HOLD_CAP_MS). */
const LOCK_HOLD_CAP_MS = 15000;
const LOCK_TIMEOUT_TEXT = /lock timeout|lock_timeout|lock wait|55P03/i;

describe('a declared action never lifts the LOCK-WAIT bound (readers do not queue behind it)', () => {
	test('backfill_search_stores queued behind a long reader gives up its ACCESS EXCLUSIVE request: a later reader gets through while the long reader still holds', () => {
		const leg = results.lock_bound_backfill as DoorResult & {
			value?: { readerDoneWhileHeld?: boolean; heldAtVerdict?: boolean; actionMs?: number };
		};
		expect(leg, 'lock-bound backfill leg did not run').toBeDefined();
		expect(leg.waited, 'the TRUNCATE never queued behind the held lock (vacuous leg)').toBe(true);
		expect(
			leg.value?.readerDoneWhileHeld,
			`a reader queued behind the waiting TRUNCATE until the long reader let go: ${JSON.stringify(leg)}`,
		).toBe(true);
		expect(leg.value?.heldAtVerdict, 'the action only settled once the lock was released').toBe(
			true,
		);
		expect(leg.value?.actionMs ?? Number.POSITIVE_INFINITY).toBeLessThan(LOCK_HOLD_CAP_MS);
		// The store's own verdict: its rebuild rolled back on the bounded wait (its old
		// rows stay — never a partial store), reported as that store's error line.
		expect(leg.ok, JSON.stringify(leg)).toBe(true);
		const lockLines = (leg.errors ?? []).filter(
			(line) => line.startsWith('matrix_string_search backfill:') && LOCK_TIMEOUT_TEXT.test(line),
		);
		expect(lockLines.length, JSON.stringify(leg.errors)).toBe(1);
	});

	test('a bounded lock wait that escapes the action is the typed, retryable 503 db.lock_timeout', () => {
		const leg = results.lock_bound_typed as DoorResult & {
			value?: { heldAtVerdict?: boolean; actionMs?: number };
		};
		expect(leg, 'lock-bound typed leg did not run').toBeDefined();
		expect(leg.waited, 'the report never queued behind the held lock (vacuous leg)').toBe(true);
		expect(
			leg.value?.heldAtVerdict,
			`the action waited out the whole hold: ${JSON.stringify(leg)}`,
		).toBe(true);
		expect(leg.ok, JSON.stringify(leg)).toBe(false);
		expect(leg.error?.code, JSON.stringify(leg.error)).toBe('db.lock_timeout');
		expect(leg.error?.errno, 'the typed error lost its SQLSTATE cause').toBe('55P03');
	});
});

describe('a bulk transform is atomic per definition file under the lock-wait bound', () => {
	test('move_tld held past the lock bound on its TM row: the section is never split between old and new tipo, and ends wholly renamed', () => {
		interface Split {
			data_old: number;
			data_new: number;
			tm_old: number;
			tm_new: number;
		}
		const leg = results.move_tld_atomic as DoorResult & {
			value?: { samples?: Split[]; final?: Split; actionMs?: number; holdMs?: number };
		};
		expect(leg, 'move_tld atomicity leg did not run').toBeDefined();
		expect(leg.waited, 'the rename never queued behind the held TM row lock (vacuous leg)').toBe(
			true,
		);
		const samples = leg.value?.samples ?? [];
		// Non-vacuity: the hold outlived the first attempt's lock_timeout (5s) — the
		// instant a non-atomic rename commits its first half and then gives up.
		expect(samples.length, 'too few samples to cover the lock bound').toBeGreaterThan(20);
		expect(leg.value?.holdMs ?? 0).toBeGreaterThan(5000);
		const whole = (state: Split) =>
			(state.data_new === 0 && state.tm_new === 0) || (state.data_old === 0 && state.tm_old === 0);
		const split = samples.filter((state) => !whole(state));
		expect(split, 'a committed HALF-rename was visible while the TM row was locked').toEqual([]);
		// The unit retried after its bounded wait and applied whole.
		expect(leg.ok, JSON.stringify(leg)).toBe(true);
		expect(leg.errors ?? [], 'the rename reported a failed file').toEqual([]);
		expect(leg.value?.final).toEqual({
			data_old: 0,
			data_new: MOVE_IDS.length,
			tm_old: 0,
			tm_new: 1,
		});
	});
});

describe('the data-update job declares its own scope (a detached job inherits none)', () => {
	test('the background update job completes while its target table is locked', async () => {
		const background = results.background as DoorResult & {
			value?: { status?: string; data?: { ok?: boolean; msg?: string[] } };
		};
		expect(background, 'background leg did not run').toBeDefined();
		expect(background.waited, 'the job never queued behind the held lock (vacuous leg)').toBe(true);
		expect(background.value?.status, JSON.stringify(background.value)).toBe('done');
		expect(
			background.value?.data?.ok,
			`the update job died on the request ceiling: ${JSON.stringify(background.value?.data)}`,
		).toBe(true);
		const rows = (await sql.unsafe(`SELECT tag FROM "${BG_ROWS}"`, [])) as { tag: string }[];
		expect(rows.length).toBe(1);
		// Unbounded by the POOL it ran on (not merely by a SET LOCAL on the
		// request pool, which would hold a request slot for the whole migration).
		expect(rows[0]?.tag, 'the update job did not run on the maintenance pool').toStartWith(
			'dedalo_maintenance:',
		);
	});
});

/**
 * The CENSUS of every widget action that is NOT maintenance, keyed
 * `<widget>.<action>`, each with WHY no statement it runs scales with the
 * install's data — so it may live under the request pool's ceiling. Together
 * with each widget's `unboundedActions` it must cover every registered action
 * EXACTLY (the totality leg below): a new action that is neither declared nor
 * listed here fails, so a data-scaling action cannot silently stay on the
 * request pool and die at the ceiling once C4 enables it. Shrink-honest: an
 * entry naming no registered action, or one that is also declared, fails too.
 */
const REQUEST_BOUNDED: Readonly<Record<string, string>> = {
	'make_backup.make_psql_backup': 'spawns pg_dump as a child process; the pool only starts it',
	'make_backup.get_dedalo_backup_files': 'lists the backup directory; no statement',
	'check_config.set_maintenance_mode': 'one config-state write',
	'check_config.set_recovery_mode': 'one config-state write',
	'check_config.set_notification': 'one config-state write',
	'config_areas.save_config_areas': 'one config record write',
	'menu_skip_tipos.save_menu_skip_tipos': 'one config record write',
	'update_ontology.export_to_translate': 'engine_denied: runs no statement',
	'update_ontology.rebuild_lang_files': 'engine_denied: runs no statement',
	'register_tools.register_tools': 'one dd1324 row per tool on disk (tools-sized, not data-sized)',
	'build_database_version.build_install_version':
		'spawns pg_dump/psql child processes against a scratch database it creates; the pool runs no statement',
	'build_database_version.build_matrix_hierarchy_main_sql': 'engine_denied: runs no statement',
	'update_data_version.update_data_version':
		'the engine enters withUnboundedStatements itself (a detached job inherits no door scope — gated above)',
	'update_code.update_code': 'code-tree file operations; no data-sized statement',
	'update_code.restore_code': 'code-tree file operations; no data-sized statement',
	'update_code.delete_restore_point': 'deletes a restore-point directory; no statement',
	'update_code.request_image_update':
		'writes one request file into <private>/image_update (the host updater does the work); no statement',
	'update_code.cancel_image_update_request': 'removes one request file; no statement',
	'export_hierarchy.sync_hierarchy_active_status':
		'one component save per ACTIVE hierarchy row (hierarchy-count-sized, each a request-sized write)',
	'export_hierarchy.export_hierarchy_json':
		'one registry read (hierarchy-count rows) + one lg1 record read per ACTIVE hierarchy; the data-file digests are disk IO, not statements',
	'diffusion_server_control.get_value': 'job-queue status reads (ops-sized tables)',
	'diffusion_server_control.cancel_process': 'one job-row update',
	'diffusion_server_control.requeue_job': 'one job-row update',
	'diffusion_server_control.purge_jobs':
		'one DELETE of terminal jobs; the purge itself keeps that table ops-sized',
	'diffusion_server_control.set_scheduler': 'in-memory dispatch control; no statement',
	'diffusion_server_control.retry_pending_deletions':
		'a LIMITed batch of dd1758 pending rows (default 100) or one count',
	'unit_test.create_test_record': 'resets one test section record',
	'unit_test.long_process_stream': 'a synthetic job frame stream; no data-sized statement',
	'media_control.get_value': 'config + marker-store status; no data-sized statement',
	'media_control.rebuild_media_index':
		'reads publication targets in MariaDB and rewrites the marker store on disk — not the Postgres pools',
	'media_control.set_media_access_mode': 'writes the generated web-server rule files; no statement',
	'counters_status.get_value':
		'one indexed MAX(section_id) per section tipo (the counter floor), never a scan',
	'counters_status.modify_counter': 'one counter row, floored by an indexed MAX',
	'counters_status.repair_all_counters':
		'one indexed-MAX floor raise per counter row (counter-count-sized, each request-sized)',
	'counters_status.reconcile_media_counters':
		'walks the media TREE on disk, then one indexed-MAX floor raise per section',
	'dataframe_control.get_value':
		'bounded by its own per-table/total budgets (SET LOCAL per batch — gated below)',
	'dataframe_control.run_check':
		'bounded by its own per-table/total budgets (SET LOCAL per batch — gated below)',
	'dataframe_control.run_fix':
		'bounded by its own per-table/total budgets (SET LOCAL per batch — gated below)',
	'runtime_info.clear_cache_files': 'clears in-process caches and cache files; no statement',
	'runtime_info.clear_session_files': 'clears the session store; no data-sized statement',
	'serve_code.build_version_from_git_master': 'packages the code tree from git; no statement',
	// Every bearer call is preceded by the unauthenticated /health pairing proof: cached for a
	// read (status, media.probe), live on EVERY mutation (agent_client.ts mutateCall). A bearer
	// call answered 401 costs one more /health (bearerRefused re-proves before naming auth).
	'publication_hosts.apply_rules':
		'reads the registry file, then up to five bounded round trips to a paired agent (health unless cached + status, health + rules.apply, one more health on a 401), then the phase-6 public-URL probe (two bounded GETs through the public door, 10 s deadline and 1 KiB cap each, + one runtime-file write); no statement',
	'publication_hosts.probe':
		'up to three bounded round trips to a paired agent (health unless cached + media.probe, one more health on a 401); no statement',
	'publication_hosts.rollback_api':
		'up to three bounded round trips to a paired agent (health + release.rollback, one more health on a 401); no statement',
	'publication_hosts.set_host_fields': 'one locked rewrite of the registry file; no statement',
	'publication_hosts.remove_host':
		'deletes one secret dir and rewrites the registry file; no statement',
	// The tree hash + the v2 deps build are file/child-process work; the pool holds nothing.
	'publication_hosts.push_apis':
		'hashes the installed API trees, may run one child `bun install` in the build cache, then per paired agent: health unless cached + status, and per API one release.install behind its live health proof (one more health on a 401); no statement. The REQUEST waits at most pushAnswerWithinMs (min 60 s, half SERVER_IDLE_TIMEOUT_S ≤ 255 s): a longer round answers running and finishes detached',
	// Phase 5: the media_copy reconcile for one host. Its statements are the copy lane's
	// advisory TRY-locks (one short main-pool transaction per control unit, never held across
	// a hash or a transfer — media_copy_apply.ts THE POOL BOUND); the rest is a walk of the
	// public qualities and agent calls, none of it a data-sized statement.
	'publication_hosts.reconcile_media_copy':
		'walks the public-quality media folders, then per paired copy agent: health unless cached + status, health + media.manifest, per unit a short advisory try-lock transaction around media.mark/delete (one more health on a 401) and puts outside it; no data-sized statement. The REQUEST waits at most pushAnswerWithinMs (like push_apis): a longer round answers running and finishes detached in the copy lane',
	// Phase 6: the public-URL probe of one host.
	'publication_hosts.probe_public':
		'two bounded GETs through the public door (10 s deadline, 1 KiB cap each) + one runtime-file write; no database statement',
	'error_reports.get_reports': 'one LIMITed page + one count of the error-report table',
	// "New publication host" (publication_host_setup.ts): drafts, the kit, the sealed package.
	'publication_hosts.propose_draft':
		'reads the registry and the drafts file (both bounded private-file reads) and /etc/group; no database statement, no dial',
	'publication_hosts.save_draft':
		'the drafts file read + one locked atomic write (bounded, 1 MiB cap); the judgement is pure (derive + siblings); no database statement except one activity row',
	'publication_hosts.remove_draft':
		'the drafts file read + one locked atomic write + two unlinks of the cached kit; no database statement except one activity row',
	'publication_hosts.build_kit':
		"the cached kit, or one build: the verified tree re-hashed, one frozen bun install of the agent's production deps (the API bundles' installer, 10 min timeout) and one child parseDraft (60 s); the REQUEST waits at most pushAnswerWithinMs and answers running beyond it (like push_apis); no database statement",
	'publication_hosts.download_kit':
		'one re-hashed read of the cached kit, capped at 64 MiB; no database statement',
	'publication_hosts.pair_package':
		'one scrypt (off the event loop) over a package capped at 1 MiB, then the pairing: one unauthenticated /health proof over mTLS (no bearer is ever sent) and one locked registry write; no database statement except one activity row',
};

describe('only DECLARED actions are maintenance', () => {
	test('a publication_hosts agent call counts its /health pairing proof (mutations prove live)', () => {
		const agentRows = Object.entries(REQUEST_BOUNDED).filter(
			([key, reason]) => key.startsWith('publication_hosts.') && reason.includes('paired agent'),
		);
		expect(agentRows.length).toBeGreaterThanOrEqual(3); // apply_rules, probe, rollback_api
		for (const [key, reason] of agentRows) {
			expect(reason, key).toContain('health');
			// a 401 is answered by one more /health proof before auth (agent_client bearerRefused)
			expect(reason, key).toContain('401');
		}
		// apply_rules = health? + status, health + rules.apply, + health on a 401 → five
		expect(REQUEST_BOUNDED['publication_hosts.apply_rules']).toContain('up to five');
	});

	test('every unboundedActions name is a registered action of its widget', () => {
		const declared = ALL_WIDGET_MODULES.flatMap((module) =>
			(module.unboundedActions ?? []).map((action) => ({ module, action })),
		);
		expect(declared.length, 'no widget declares a maintenance action (vacuous)').toBeGreaterThan(0);
		const dangling = declared
			.filter(({ module, action }) => !Object.hasOwn(module.apiActions ?? {}, action))
			.map(({ module, action }) => `${module.spec.id}.${action}`);
		expect(dangling, 'a declared maintenance action is not a registered action').toEqual([]);
	});

	test('TOTALITY: every registered action is declared maintenance XOR listed request-bounded', () => {
		const registered = ALL_WIDGET_MODULES.flatMap((module) =>
			Object.keys(module.apiActions ?? {}).map((action) => ({
				key: `${module.spec.id}.${action}`,
				declared: (module.unboundedActions ?? []).includes(action),
			})),
		);
		expect(registered.length, 'no widget action registered (vacuous)').toBeGreaterThan(
			Object.keys(REQUEST_BOUNDED).length,
		);
		const unclassified = registered
			.filter(({ key, declared }) => !declared && !Object.hasOwn(REQUEST_BOUNDED, key))
			.map(({ key }) => key);
		expect(
			unclassified,
			'an action is neither in its widget unboundedActions nor in REQUEST_BOUNDED (with a reason): classify it',
		).toEqual([]);
		const both = registered
			.filter(({ key, declared }) => declared && Object.hasOwn(REQUEST_BOUNDED, key))
			.map(({ key }) => key);
		expect(both, 'an action is declared maintenance AND listed request-bounded').toEqual([]);
		const known = new Set(registered.map(({ key }) => key));
		const stale = Object.keys(REQUEST_BOUNDED).filter((key) => !known.has(key));
		expect(stale, 'a REQUEST_BOUNDED entry names no registered action (drop it)').toEqual([]);
		const reasonless = Object.entries(REQUEST_BOUNDED)
			.filter(([, reason]) => reason.trim().length < 10)
			.map(([key]) => key);
		expect(reasonless, 'a REQUEST_BOUNDED entry without a reason').toEqual([]);
	});

	test('an undeclared action runs on the request pool: a saturated maintenance pool does not starve it', () => {
		const undeclared = results.undeclared as DoorResult & {
			hung?: boolean;
			rows?: number;
			value?: { saturated?: boolean };
		};
		expect(undeclared, 'undeclared leg did not run').toBeDefined();
		expect(undeclared.value?.saturated, 'the maintenance pool was not saturated (vacuous)').toBe(
			true,
		);
		expect(undeclared.hung, 'a cheap action queued behind the held maintenance slots').not.toBe(
			true,
		);
		expect(undeclared.ok, JSON.stringify(undeclared)).toBe(true);
		expect(undeclared.rows ?? 0).toBeGreaterThan(0);
	});
});

/**
 * Scan SOURCE while an ACCESS EXCLUSIVE lock blocks the batch's SELECT. This
 * process has no pool ceiling, so before the per-batch bound the batch waited
 * for the lock however long it was held (the budgets were checked only BETWEEN
 * batches). Returns the table's coverage and the wall time the scan took.
 */
async function scanBlocked(
	budgets: DataframeScanBudgets,
): Promise<{ coverage: TableCoverage[]; elapsedMs: number }> {
	const holder = await sql.reserve();
	await holder.unsafe('BEGIN', []);
	await holder.unsafe(`LOCK TABLE "${SOURCE}" IN ACCESS EXCLUSIVE MODE`, []);
	let coverage: TableCoverage[] = [];
	let elapsedMs = Number.POSITIVE_INFINITY;
	const startedAt = performance.now();
	const scan = dataframeControlScan(false, [SOURCE], budgets);
	try {
		// Bounded wait: an unbounded batch must not hold this file hostage — the
		// lock is released after 4s either way, and the scan then settles.
		const settled = await Promise.race([scan, Bun.sleep(4000).then(() => null)]);
		elapsedMs = performance.now() - startedAt;
		if (settled !== null) {
			coverage = ((settled.data as { coverage?: TableCoverage[] }).coverage ??
				[]) as TableCoverage[];
		}
	} finally {
		await holder.unsafe('COMMIT', []);
		holder.release();
		await scan.catch(() => null);
	}
	return { coverage, elapsedMs };
}

/** The bound the cut batch ran under, read back from its reason ("ran past the <n>ms left"). */
function boundOf(coverage: TableCoverage[]): number {
	const match = /ran past the (\d+)ms left/.exec(coverage[0]?.reason ?? '');
	return match ? Number(match[1]) : Number.NaN;
}

// Each budget is pinned ON ITS OWN: the OTHER budget is set far beyond the
// assertion window (60s), so only the budget under test can cut the batch in
// time. A batch bound computed from one budget alone keeps one of the two legs
// red (it waits for the lock — 4s — or reports a bound of ~60000ms).
describe('dataframe_control is bounded by its own budgets (not maintenance)', () => {
	for (const leg of [
		{ name: 'per-table', budgets: { tableMs: 300, totalMs: 60_000 }, cutMs: 300 },
		{ name: 'total', budgets: { tableMs: 60_000, totalMs: 300 }, cutMs: 300 },
	]) {
		test(`a batch blocked past the ${leg.name} budget is cut AT that budget: budget_exhausted, the scan returns`, async () => {
			const { coverage, elapsedMs } = await scanBlocked(leg.budgets);
			expect(coverage.length, 'the scan did not settle while the lock was held').toBe(1);
			expect(coverage[0]?.status, JSON.stringify(coverage)).toBe('budget_exhausted');
			expect(coverage[0]?.batches).toBe(0);
			expect(boundOf(coverage), JSON.stringify(coverage)).toBeLessThanOrEqual(leg.cutMs);
			expect(elapsedMs, `the blocked batch outlived the ${leg.name} budget`).toBeLessThan(
				leg.cutMs + 400,
			);
		}, 30000);
	}
});
