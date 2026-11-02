/**
 * THE STATEMENT CEILING IS TYPED WHEN IT FIRES, AND LIFTED ONLY BY A SCOPE THAT
 * NEVER MUTATES A POOLED CONNECTION (PERF-11, closes the WC-055 class — the
 * precondition of shipping it on by default).
 *
 * THE DEFECTS.
 *  - `DB_STATEMENT_TIMEOUT_MS` / `DB_POOL_ACQUIRE_TIMEOUT_MS` shipped at 0 because
 *    the ceiling is a pool-wide GUC and the only opt-out
 *    (`runWithoutStatementTimeout`) was a session `SET`/`RESET` on a connection
 *    that goes back to the pool — the leak class WC-055 had to patch by hand.
 *  - When the ceiling (57014) or the acquire timeout fired, the caller got a raw
 *    PostgresError / plain Error → 500 `internal.unexpected`, indistinguishable
 *    from an engine bug.
 *  - `sql.reserve()` held a Bun connection WITHOUT a gate slot, so reserved
 *    connections could exhaust the pool behind the gate's back: the next pooled
 *    query hung forever instead of failing at the acquire timeout.
 *  - Nothing stopped a session `SET` on the pooled or transaction lanes, whose
 *    value outlives the caller's span on a pooled connection.
 *
 * THE LAW. `withUnboundedStatements(work)` routes the scope's pooled, transaction
 * and reserve lanes to a SEPARATE maintenance pool whose startup
 * `statement_timeout` is 0 (no pooled GUC is ever mutated); the scope expires on
 * exit (a leaked timer falls back to the bounded pool — the S2-14 analogue) and
 * detached jobs never inherit it; a 57014 at or past the lane's ceiling maps to
 * 503 `db.statement_timeout` (an operator cancel, or a reserved-lane 57014, stays
 * raw); the recorder tracks `SET LOCAL statement_timeout` and savepoints; the
 * acquire timeout is 503 `db.pool_exhausted`; reserve takes a gate slot; a session
 * SET in ANY statement of a text is refused; EVERY connection-taking Bun member
 * (enumerated from a real Bun SQL instance — an allowlist, not a denylist) is
 * refused; shutdown closes the maintenance pool bounded and cancels only THIS
 * process-boot's statements on THIS database and role.
 *
 * ONE CHILD PROCESS runs the pool legs against the lane SUITE database with
 * DB_STATEMENT_TIMEOUT_MS=250, DB_POOL_ACQUIRE_TIMEOUT_MS=300, DB_POOL_MAX=2,
 * DB_MAINTENANCE_POOL_MAX=1 (the pool config is frozen at import, so a child is
 * the only honest way to measure it); a SECOND child runs the shutdown leg (it
 * closes every pool). Each leg reports independently; the children write
 * nothing. The recorder's parser and the shared lexer have pure truth tables.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { SQL } from 'bun';
import {
	DEDICATED_CONNECTIONS_MAX,
	maintenanceConnectionsPerProcess,
} from '../../src/core/db/connection_budget.ts';
import {
	parseStatementTimeoutDirective,
	registerCommitAction,
	sql,
	withTransaction,
} from '../../src/core/db/postgres.ts';
import {
	doBodyHoldsSessionState,
	setConfigCalls,
	sqlStatements,
	strippedStatements,
	stripSqlLiterals,
} from '../../src/core/db/sql_lexer.ts';
import { assertTestDatabase } from '../../src/core/test_data/test_database_marker.ts';
import { childDriver, driverResult, repoModule } from '../helpers/child_driver.ts';

const CEILING_MS = 250;
const CEILING = `${CEILING_MS}ms`;

interface ErrorShape {
	name?: string;
	code?: string;
	errno?: string;
	message?: string;
	coordinates?: Record<string, string | number>;
	status?: number;
	dedalo?: boolean;
}
type LegResult = { ok: true; value: unknown } | { ok: false; error: ErrorShape };

const DRIVER = `
import * as pg from ${repoModule('src/core/db/postgres.ts')};
import { isDedaloError, toErrorEnvelope } from ${repoModule('src/core/errors/index.ts')};
import { assertTestDatabase } from ${repoModule('src/core/test_data/test_database_marker.ts')};
await assertTestDatabase('statement_ceiling_scope_native');
const { sql, withTransaction, runDetachedFromTransaction, runWithoutStatementTimeout, getPoolStats } = pg;
// WATCHDOG: a leg that hangs (a regressed gate that waits without bound) must
// red ITS OWN assertions, not time out the whole file as one unnamed failure —
// report the legs collected so far, and name the one still running.
let runningLeg = null;
setTimeout(() => {
	results.__watchdog = { ok: false, error: { message: 'driver watchdog: leg ' + runningLeg + ' hung' } };
	console.log('RESULT ' + JSON.stringify(results));
	process.exit(0);
}, 60000);

function describe(e) {
	const dedalo = isDedaloError(e);
	return {
		name: e?.name,
		code: e?.code,
		errno: e?.errno ?? e?.cause?.errno,
		message: String(e?.message ?? e).slice(0, 400),
		coordinates: e?.coordinates,
		status: dedalo ? toErrorEnvelope(e, { requestId: 'g3' }).status : undefined,
		dedalo,
	};
}
const results = {};
async function leg(name, fn) {
	runningLeg = name;
	try { results[name] = { ok: true, value: await fn() }; }
	catch (e) { results[name] = { ok: false, error: describe(e) }; }
}
function scope() {
	if (typeof pg.withUnboundedStatements !== 'function') {
		throw new Error('withUnboundedStatements is not exported (PERF-11 scope missing)');
	}
	return pg.withUnboundedStatements;
}
const show = async () => (await sql.unsafe("SELECT current_setting('statement_timeout') AS st", []))[0].st;
async function pooledShows() {
	const { max } = getPoolStats();
	return Promise.all(Array.from({ length: max * 2 }, () => show()));
}
const SLEEP = 'SELECT pg_sleep(0.6)';

await leg('pooled_show', show);
await leg('scope_show', () => scope()(() => show()));
await leg('pooled_template_timeout', async () => { await sql\`SELECT pg_sleep(0.6)\`; return 'NO ERROR'; });
await leg('pooled_unsafe_timeout', async () => { await sql.unsafe(SLEEP, []); return 'NO ERROR'; });
await leg('tx_template_timeout', () => withTransaction(async () => { await sql\`SELECT pg_sleep(0.6)\`; return 'NO ERROR'; }));
await leg('tx_unsafe_timeout', () => withTransaction(async () => { await sql.unsafe(SLEEP, []); return 'NO ERROR'; }));

await leg('operator_cancel_raw', async () => {
	const marker = 'g3_cancel_' + process.pid;
	const running = sql.unsafe('SELECT pg_sleep(0.24) /*' + marker + '*/', []).then(() => 'NO ERROR (cancel missed)', (e) => describe(e));
	let cancelled = false;
	for (let i = 0; i < 20 && !cancelled; i++) {
		await Bun.sleep(5);
		const rows = await sql.unsafe(
			"SELECT pg_cancel_backend(pid) AS c FROM pg_stat_activity WHERE state = 'active' AND pid <> pg_backend_pid() AND position($1 in query) > 0",
			[marker]);
		cancelled = rows.some((row) => row.c === true);
	}
	return running;
});

await leg('recorder_set_local', () => withTransaction(async () => {
	await sql.unsafe("SET LOCAL statement_timeout = '100ms'", []);
	await sql.unsafe('SELECT pg_sleep(0.3)', []);
	return 'NO ERROR';
}));

// A ceiling the recorder cannot parse (set_config, even transaction-local) is
// UNKNOWN: the 57014 that follows must stay raw, never typed against a guess.
// The new ceiling (400ms) is ABOVE the pool's (250ms), so a recorder that lost
// the set_config detection would keep 250 and TYPE the 57014 (400 >= 250).
// The error LEAVES the transaction, as in production: caught inside, the body
// returned normally and committed an aborted transaction — which Bun 1.4.3
// rejects (ERR_POSTGRES_COMMIT_ROLLED_BACK; 1.4.2 resolved it silently).
await leg('recorder_unknown_raw', () => withTransaction(async () => {
	await sql.unsafe("SELECT set_config('statement_timeout', '400', true)", []);
	await sql.unsafe('SELECT pg_sleep(0.6)', []);
	return 'NO ERROR';
}));

// ROLLBACK TO SAVEPOINT reverts a SET LOCAL made after the savepoint (Postgres):
// the recorder must revert with it — the 57014 that follows is the POOL's 250.
await leg('recorder_rollback_to_savepoint', () => withTransaction(async () => {
	await sql.unsafe('SAVEPOINT g3_sp', []);
	await sql.unsafe("SET LOCAL statement_timeout = '100ms'", []);
	await sql.unsafe('ROLLBACK TO SAVEPOINT g3_sp', []);
	await sql.unsafe(SLEEP, []);
	return 'NO ERROR';
}));
// …while a RELEASE keeps it (a SET LOCAL survives RELEASE): the ceiling is 100.
await leg('recorder_release_savepoint', () => withTransaction(async () => {
	await sql.unsafe('SAVEPOINT g3_sp', []);
	await sql.unsafe("SET LOCAL statement_timeout = '100ms'", []);
	await sql.unsafe('RELEASE SAVEPOINT g3_sp', []);
	await sql.unsafe('SELECT pg_sleep(0.3)', []);
	return 'NO ERROR';
}));

await leg('reserved_raw', async () => {
	const reserved = await sql.reserve();
	try { await reserved.unsafe(SLEEP, []); return 'NO ERROR'; }
	catch (e) { return describe(e); }
	finally { reserved.release(); }
});

await leg('scope_lanes', () => scope()(async () => {
	await sql\`SELECT pg_sleep(0.6)\`;
	await sql.unsafe(SLEEP, []);
	await withTransaction(async () => { await sql.unsafe(SLEEP, []); });
	const reserved = await sql.reserve();
	try { await reserved.unsafe(SLEEP, []); } finally { reserved.release(); }
	return 'all lanes completed';
}));
await leg('after_scope_pooled', pooledShows);

await leg('timer_expiry', async () => {
	let fired;
	await scope()(async () => {
		fired = new Promise((resolve) => setTimeout(() => { show().then(resolve, (e) => resolve(describe(e))); }, 300));
	});
	return fired;
});
await leg('detached_exit', () => scope()(() => runDetachedFromTransaction(() => show())));
await leg('scope_inside_bounded_tx', () => withTransaction(async () => scope()(async () => 'entered')));

await leg('pool_exhausted_tx', async () => {
	let release;
	const gate = new Promise((resolve) => { release = resolve; });
	const holders = [withTransaction(() => gate), withTransaction(() => gate)];
	await Bun.sleep(100);
	const startedAt = performance.now();
	const query = sql.unsafe('SELECT 1', []).then(() => 'NO ERROR', (e) => describe(e));
	// Raced: a gate that waits without bound reds THIS leg ('HUNG 3s'), and the
	// holders are released either way, so the next legs still run.
	const outcome = await Promise.race([query, Bun.sleep(3000).then(() => 'HUNG 3s')]);
	const elapsedMs = performance.now() - startedAt;
	release();
	await Promise.allSettled(holders);
	await Promise.race([query, Bun.sleep(3000)]);
	return { outcome, elapsedMs };
});

// A connection-taking Bun member is refused, never a way around the gate: with
// the pool SATURATED by two held transactions, sql.begin / sql.transaction fail
// at once with internal.invariant instead of taking a third connection ungated.
await leg('begin_refused_saturated', async () => {
	let release;
	const gate = new Promise((resolve) => { release = resolve; });
	const holders = [withTransaction(() => gate), withTransaction(() => gate)];
	await Bun.sleep(100);
	const outcomes = {};
	for (const member of ['begin', 'transaction']) {
		const startedAt = performance.now();
		const outcome = await Promise.race([
			Promise.resolve().then(() => sql[member](async (tx) => { await tx\`SELECT 1\`; return 'RAN UNGATED'; }))
				.then((v) => v, (e) => describe(e)),
			Bun.sleep(3000).then(() => 'HUNG 3s'),
		]);
		outcomes[member] = { outcome, elapsedMs: performance.now() - startedAt };
	}
	release();
	await Promise.allSettled(holders);
	return outcomes;
});

await leg('pool_exhausted_reserve', async () => {
	const held = [await sql.reserve(), await sql.reserve()];
	const startedAt = performance.now();
	const query = sql.unsafe('SELECT 1', []).then(() => 'NO ERROR', (e) => describe(e));
	const outcome = await Promise.race([query, Bun.sleep(3000).then(() => 'HUNG 3s')]);
	const elapsedMs = performance.now() - startedAt;
	for (const reserved of held) reserved.release();
	await Promise.race([query, Bun.sleep(3000)]);
	return { outcome, elapsedMs };
});

// The MAINTENANCE pool's own gate (DB_MAINTENANCE_POOL_MAX=1 here): one held
// scoped transaction saturates it, and the next scoped statement is the same
// typed 503 — naming the maintenance pool — never an indefinite wait.
async function holdMaintenanceSlot() {
	let release;
	const gate = new Promise((resolve) => { release = resolve; });
	const holder = scope()(() => withTransaction(() => gate));
	await Bun.sleep(100);
	return { release: () => { release(); return holder; } };
}
await leg('maintenance_pool_exhausted', async () => {
	const held = await holdMaintenanceSlot();
	const startedAt = performance.now();
	const outcome = await Promise.race([
		scope()(() => sql.unsafe('SELECT 1', [])).then(() => 'NO ERROR', (e) => describe(e)),
		Bun.sleep(3000).then(() => 'HUNG 3s'),
	]);
	const elapsedMs = performance.now() - startedAt;
	await held.release();
	return { outcome, elapsedMs };
});
// A maintenance run WAITING for its slot honours its abort at once: the waiter
// leaves the queue with the abort reason, well before the 300ms acquire timeout
// would have typed it db.pool_exhausted.
await leg('maintenance_waiter_abort', async () => {
	const held = await holdMaintenanceSlot();
	const controller = new AbortController();
	const waiting = pg.withMaintenanceTransaction(async () => 'RAN', {
		lockTimeout: '5s', signal: controller.signal, lockRetryDelaysMs: [],
	}).then((v) => v, (e) => describe(e));
	await Bun.sleep(50);
	const waitersBefore = getPoolStats().maintenance.waiters;
	const abortedAt = performance.now();
	controller.abort();
	const outcome = await Promise.race([waiting, Bun.sleep(3000).then(() => 'HUNG 3s')]);
	const settleMs = performance.now() - abortedAt;
	const waitersAfter = getPoolStats().maintenance.waiters;
	await held.release();
	return { outcome, settleMs, waitersBefore, waitersAfter };
});

await leg('helper_no_guc_mutation', async () => {
	const startedAt = performance.now();
	await runWithoutStatementTimeout(SLEEP);
	const elapsedMs = performance.now() - startedAt;
	const settings = await runWithoutStatementTimeout(
		"SELECT setting, source FROM pg_settings WHERE name = 'statement_timeout'");
	return { elapsedMs, setting: settings[0]?.setting, source: settings[0]?.source, pooled: await pooledShows() };
});

// withStatementBudget with NO ambient transaction (postgres.ts): it opens its own
// on the lane in force — the bounded request pool, or, inside an unbounded scope,
// the maintenance pool (startup ceiling 0) — and SET LOCALs the budget there. The
// budget applies on BOTH lanes, never above the ceiling in force; the lane is the
// scope's (never moved); nothing leaks onto a pooled connection; and the
// non-transactional lane (runWithoutStatementTimeout) cannot be entered under it.
const budgetProbe = (appliedMs) => (async () => ({
	appliedMs,
	shown: await show(),
	app: (await sql.unsafe("SELECT current_setting('application_name') AS a", []))[0].a,
	inTx: pg.isInTransaction(),
}))();
await leg('budget_request_lane', async () => ({
	inside: await pg.withStatementBudget(100, budgetProbe),
	above: await pg.withStatementBudget(5000, budgetProbe),
	after: await pooledShows(),
}));
await leg('budget_request_lane_cut', () => pg.withStatementBudget(100, async () => { await sql.unsafe(SLEEP, []); return 'NO ERROR'; }));
await leg('budget_unbounded_lane', async () => ({
	inside: await scope()(() => pg.withStatementBudget(200, budgetProbe)),
	scopeAfter: await scope()(() => show()),
	after: await pooledShows(),
}));
await leg('budget_unbounded_lane_cut', () => scope()(() => pg.withStatementBudget(200, async () => { await sql.unsafe(SLEEP, []); return 'NO ERROR'; })));
await leg('budget_refuses_nontx_lane', () => pg.withStatementBudget(100, async () => { await runWithoutStatementTimeout('SELECT 1'); return 'NO ERROR'; }));
await leg('nontx_after_budget', async () => {
	const startedAt = performance.now();
	await runWithoutStatementTimeout(SLEEP);
	return { elapsedMs: performance.now() - startedAt, pooled: await pooledShows() };
});

// LAST: pre-fix these succeed and leak an unbounded GUC onto pooled connections.
await leg('session_set_pooled', async () => { await sql.unsafe('SET statement_timeout = 0', []); return 'NO ERROR'; });
await leg('after_session_set_pooled', pooledShows);
await leg('session_set_tx', () => withTransaction(async () => { await sql.unsafe('SET statement_timeout = 0', []); return 'NO ERROR'; }));
await leg('after_session_set_tx', pooledShows);
await leg('session_set_template', async () => { await sql\`SET statement_timeout = 0\`; return 'NO ERROR'; });
await leg('after_session_set_template', pooledShows);
// A session SET in a LATER statement of a multi-statement text leaks the same.
await leg('multi_set_pooled_params', async () => { await sql.unsafe('SELECT 1; SET statement_timeout = 0', []); return 'NO ERROR'; });
await leg('after_multi_set_pooled_params', pooledShows);
await leg('multi_set_pooled_bare', async () => { await sql.unsafe('SELECT 1; SET statement_timeout = 0'); return 'NO ERROR'; });
await leg('after_multi_set_pooled_bare', pooledShows);
await leg('multi_set_template', async () => { await sql\`SELECT 1; SET statement_timeout = 0\`; return 'NO ERROR'; });
await leg('after_multi_set_template', pooledShows);
await leg('multi_set_tx', () => withTransaction(async () => { await sql.unsafe('SELECT 1; RESET statement_timeout', []); return 'NO ERROR'; }));
await leg('after_multi_set_tx', pooledShows);
// The function form of a session SET: set_config(…, false) outlives the caller too.
await leg('set_config_session_pooled', async () => { await sql.unsafe("SELECT set_config('statement_timeout', '0', false)", []); return 'NO ERROR'; });
await leg('after_set_config_session_pooled', pooledShows);
await leg('set_config_session_tx', () => withTransaction(async () => { await sql.unsafe("SELECT set_config('statement_timeout', '0', false)", []); return 'NO ERROR'; }));
await leg('after_set_config_session_tx', pooledShows);
// A leading comment does not hide it either (the anchored rule once saw ' SET …').
await leg('comment_set_pooled', async () => { await sql.unsafe('/* why */ SET statement_timeout = 0', []); return 'NO ERROR'; });
await leg('after_comment_set_pooled', pooledShows);
// A NESTED leading comment is one comment to Postgres: a flat stripper that left
// 'c */ SET …' behind let this one through (review 2026-09-30).
await leg('nested_comment_set_pooled', async () => { await sql.unsafe('/* a /* b */ c */ SET statement_timeout = 0', []); return 'NO ERROR'; });
await leg('after_nested_comment_set_pooled', pooledShows);
await leg('nested_comment_set_tx', () => withTransaction(async () => { await sql.unsafe('/* a /* b */ c */ -- d\\n SET statement_timeout = 0', []); return 'NO ERROR'; }));
await leg('after_nested_comment_set_tx', pooledShows);
// Non-vacuity: a ';' and a SET inside a literal split nothing — this one runs.
await leg('multi_literal_allowed', async () => (await sql.unsafe("SELECT 'x; SET statement_timeout = 0' AS v", []))[0].v);

// A DO body is PL/pgSQL executed NOW: to the lexer a literal, so the refusal
// reads it RAW (review 2026-09-30 — both forms passed as 'DO $$').
await leg('do_set_pooled', async () => { await sql.unsafe('DO $$BEGIN SET statement_timeout = 0; END$$', []); return 'NO ERROR'; });
await leg('after_do_set_pooled', pooledShows);
await leg('do_execute_set_pooled', async () => { await sql.unsafe("DO $$BEGIN EXECUTE 'SET statement_timeout = 0'; END$$", []); return 'NO ERROR'; });
await leg('after_do_execute_set_pooled', pooledShows);
await leg('do_set_config_pooled', async () => { await sql.unsafe("DO $$BEGIN PERFORM set_config('statement_timeout', '0', false); END$$", []); return 'NO ERROR'; });
await leg('after_do_set_config_pooled', pooledShows);
await leg('do_set_config_tx', () => withTransaction(async () => { await sql.unsafe("DO $$BEGIN PERFORM set_config('statement_timeout', '0', false); END$$", []); return 'NO ERROR'; }));
await leg('after_do_set_config_tx', pooledShows);
// A third argument that is not a literal true is session-scoped, whatever it spells.
await leg('set_config_expr_pooled', async () => { await sql.unsafe("SELECT set_config('statement_timeout', lower('0'), false)", []); return 'NO ERROR'; });
await leg('after_set_config_expr_pooled', pooledShows);
await leg('set_config_nonliteral_pooled', async () => { await sql.unsafe("SELECT set_config('statement_timeout', '0', 1=0)", []); return 'NO ERROR'; });
await leg('after_set_config_nonliteral_pooled', pooledShows);
// Non-vacuity: a DO body with no session state, and a transaction-local set_config, run.
await leg('do_local_allowed', async () => {
	await sql.unsafe("DO $$BEGIN PERFORM set_config('application_name', current_setting('application_name'), true); END$$", []);
	return 'ran';
});
// THE OUTCOME PROBE, after every scope and session leg: no pooled, maintenance
// or non-transactional maintenance connection carries a SESSION-set ceiling.
const sourceOf = async () => (await sql.unsafe("SELECT source FROM pg_settings WHERE name = 'statement_timeout'", []))[0].source;
await leg('no_session_source', async () => ({
	pooled: await Promise.all(Array.from({ length: getPoolStats().max * 2 }, () => sourceOf())),
	maintenance: await scope()(() => Promise.all(Array.from({ length: getPoolStats().maintenance.max * 2 }, () => sourceOf()))),
	// runWithoutStatementTimeout routes a text by its LOCK CLASS (postgres.ts
	// nonTransactionalLockClass): a SELECT is not one of the weak forms the
	// non-transactional lane admits (VACUUM / ANALYZE / CONCURRENTLY — none of
	// which can read a setting or set one), so it runs on the bounded
	// maintenance pool, and its source is read there.
	helper: (await runWithoutStatementTimeout(
		"SELECT source, current_setting('application_name') AS app FROM pg_settings WHERE name = 'statement_timeout'"))[0],
}));

console.log('RESULT ' + JSON.stringify(results));
process.exit(0);
`;

const SHUTDOWN_MARKER = `g3_shutdown_${process.pid}`;
const NONTX_MARKER = `g3_nontx_${process.pid}`;
const FOREIGN_MARKER = `g3_foreign_${process.pid}`;

/**
 * THE SHUTDOWN LEG (its own child: closeDatabasePool ends every pool). An
 * unbounded maintenance statement (20s) is running when the pools are closed;
 * the close must return promptly and leave no backend running it — pre-fix the
 * maintenance pool's `end()` waited for the statement (and a killed process
 * would have left the backend running, holding its locks).
 *
 * AND IT CANCELS ONLY ITS OWN. pg_stat_activity is cluster-wide and in a
 * container every engine / one-off CLI is PID 1, so three FOREIGN backends run
 * a 20s statement across the close and must all survive it:
 *  - 'pid_sibling': this DB, application_name \`dedalo_maintenance:<pid>\` —
 *    what a same-PID process carried when the name was the pid alone;
 *  - 'nonce_sibling': this DB, \`dedalo_maintenance:<pid>:zzzzzzzz\` — a
 *    same-PID process of another boot (a prefix match would take it);
 *  - 'other_database': database \`postgres\`, THIS process's exact
 *    application_name — another install on the same cluster (only the
 *    datname scope spares it, whatever the name).
 */
const SHUTDOWN_DRIVER = `
import { SQL } from 'bun';
import * as pg from ${repoModule('src/core/db/postgres.ts')};
import { config } from ${repoModule('src/config/config.ts')};
import { assertTestDatabase } from ${repoModule('src/core/test_data/test_database_marker.ts')};
import { bunSqlTransportOptions, resolvePgTransport } from ${repoModule('src/config/pg_transport.ts')};
await assertTestDatabase('statement_ceiling_scope_native:shutdown');
const { sql, withUnboundedStatements, closeDatabasePool } = pg;
function connect(database, applicationName) {
	const { user, password, sslMode } = config.db;
	const common = { database, username: user, password: password || undefined, tls: sslMode, max: 1,
		...(applicationName ? { connection: { application_name: applicationName } } : {}) };
	return new SQL({ ...common, ...bunSqlTransportOptions(resolvePgTransport(config.db)) });
}
const checker = connect(config.db.database);
const activeWith = async (marker) => (await checker.unsafe(
	"SELECT datname, application_name AS app FROM pg_stat_activity WHERE state = 'active' AND pid <> pg_backend_pid() AND position($1 in query) > 0",
	[marker]));
const running = withUnboundedStatements(() => sql.unsafe('SELECT pg_sleep(20) /*${SHUTDOWN_MARKER}*/', []))
	.then(() => 'completed', (e) => String(e?.errno ?? e?.code ?? e));
// A NON-TRANSACTIONAL statement (runWithoutStatementTimeout — REINDEX/DROP INDEX
// CONCURRENTLY in production) is running too: it does not roll back, so the
// shutdown must let the server finish it, never cancel it. Only the WEAK-lock
// forms ride that lane (postgres.ts nonTransactionalLockClass), so the stand-in
// is a real one: a VACUUM held ~2.5s behind a SHARE UPDATE EXCLUSIVE holder.
const NONTX_TABLE = 'dedalo_ts_test_ceil_' + process.pid;
await checker.unsafe('CREATE TABLE IF NOT EXISTS "' + NONTX_TABLE + '" (id int)', []);
const lockHolder = connect(config.db.database);
await lockHolder.unsafe('BEGIN', []);
await lockHolder.unsafe('LOCK TABLE "' + NONTX_TABLE + '" IN SHARE UPDATE EXCLUSIVE MODE', []);
const lockReleased = Bun.sleep(2500).then(() => lockHolder.unsafe('COMMIT', []));
const nontx = pg.runWithoutStatementTimeout('VACUUM ANALYZE "' + NONTX_TABLE + '" /*${NONTX_MARKER}*/')
	.then(() => 'completed', (e) => String(e?.errno ?? e?.code ?? e));
let own = [];
for (let i = 0; i < 100 && own.length === 0; i++) { await Bun.sleep(20); own = await activeWith('${SHUTDOWN_MARKER}'); }
const seen = own.length > 0;
const ownName = own[0]?.app ?? '';
let nontxRows = [];
for (let i = 0; i < 100 && nontxRows.length === 0; i++) { await Bun.sleep(20); nontxRows = await activeWith('${NONTX_MARKER}'); }
const nontxName = nontxRows[0]?.app ?? '';
const foreignSpecs = {
	pid_sibling: [config.db.database, 'dedalo_maintenance:' + process.pid],
	nonce_sibling: [config.db.database, 'dedalo_maintenance:' + process.pid + ':zzzzzzzz'],
	other_database: ['postgres', ownName],
};
const foreign = {};
for (const [leg, [database, app]] of Object.entries(foreignSpecs)) {
	const connection = connect(database, app);
	const marker = '${FOREIGN_MARKER}_' + leg;
	foreign[leg] = { connection, marker, app, done: connection.unsafe('SELECT pg_sleep(20) /*' + marker + '*/', [])
		.then(() => 'completed', (e) => String(e?.errno ?? e?.code ?? e)) };
}
const foreignSeen = {};
for (const [leg, entry] of Object.entries(foreign)) {
	let rows = [];
	for (let i = 0; i < 100 && rows.length === 0; i++) { await Bun.sleep(20); rows = await activeWith(entry.marker); }
	foreignSeen[leg] = rows[0] ?? null;
}
const startedAt = performance.now();
await closeDatabasePool();
const closeMs = performance.now() - startedAt;
const statement = await Promise.race([running, Bun.sleep(1000).then(() => 'still pending')]);
const nontxOutcome = await Promise.race([nontx, Bun.sleep(4000).then(() => 'still pending')]);
// Give a wrongly-sent cancel time to land before reading the survivors.
await Bun.sleep(300);
const foreignAfter = {};
for (const [leg, entry] of Object.entries(foreign)) {
	foreignAfter[leg] = (await activeWith(entry.marker)).length > 0;
	await checker.unsafe("SELECT pg_cancel_backend(pid) FROM pg_stat_activity WHERE pid <> pg_backend_pid() AND position($1 in query) > 0", [entry.marker]);
	await entry.done;
	await entry.connection.close({ timeout: 1 });
}
await lockReleased;
await lockHolder.close({ timeout: 1 });
await checker.unsafe('DROP TABLE IF EXISTS "' + NONTX_TABLE + '"', []);
await checker.close({ timeout: 1 });
console.log('RESULT ' + JSON.stringify({ seen, closeMs, statement, ownName, foreignSeen, foreignAfter, nontxName, nontxOutcome }));
process.exit(0);
`;

/**
 * THE ZERO-SLOT LEG (its own child: the pool size is frozen at import). An
 * operator's DB_MAINTENANCE_POOL_MAX=0 must not build a gate with no slot —
 * every maintenance action would then wait forever (the shipped acquire timeout
 * is 0). The config clamps it to 1, and a scoped statement completes.
 */
const ZERO_SLOT_DRIVER = `
import * as pg from ${repoModule('src/core/db/postgres.ts')};
import { config } from ${repoModule('src/config/config.ts')};
import { assertTestDatabase } from ${repoModule('src/core/test_data/test_database_marker.ts')};
await assertTestDatabase('statement_ceiling_scope_native:zero_slot');
const outcome = await Promise.race([
	pg.withUnboundedStatements(() => pg.sql.unsafe('SELECT 1 AS one', [])).then((rows) => rows[0].one, (e) => String(e?.code ?? e)),
	Bun.sleep(3000).then(() => 'HUNG 3s'),
]);
console.log('RESULT ' + JSON.stringify({ configured: config.ops.dbMaintenancePoolMax, gateMax: pg.getPoolStats().maintenance.max, outcome }));
process.exit(0);
`;

/**
 * THE UNCONFIGURED-CEILING LEG (its own child, DB_STATEMENT_TIMEOUT_MS=0 — the
 * suite's and every install's value until the C4 flip). The scope's refusal
 * inside a transaction is keyed on the transaction's LANE: a request-pool
 * transaction is refused even though its ceiling reads 0 today, so a caller
 * that enters the scope there is red HERE, not first in production. Only an
 * explicit `SET LOCAL statement_timeout = 0` in force makes it joinable
 * (DEFAULT restores the configured ceiling; a ROLLBACK TO past the SET LOCAL
 * undoes it).
 */
const ZERO_CEILING_DRIVER = `
import * as pg from ${repoModule('src/core/db/postgres.ts')};
import { assertTestDatabase } from ${repoModule('src/core/test_data/test_database_marker.ts')};
import { config } from ${repoModule('src/config/config.ts')};
await assertTestDatabase('statement_ceiling_scope_native:zero_ceiling');
const { sql, withTransaction, withUnboundedStatements } = pg;
const results = {};
async function leg(name, fn) {
	try { results[name] = { ok: true, value: await fn() }; }
	catch (e) { results[name] = { ok: false, error: { code: e?.code, message: String(e?.message ?? e), coordinates: e?.coordinates } }; }
}
const enter = () => withUnboundedStatements(async () => 'entered');
await leg('ceiling', async () => config.ops.dbStatementTimeoutMs);
await leg('request_tx', () => withTransaction(enter));
await leg('set_local_zero', () => withTransaction(async () => { await sql.unsafe('SET LOCAL statement_timeout = 0', []); return enter(); }));
await leg('set_local_default', () => withTransaction(async () => { await sql.unsafe('SET LOCAL statement_timeout = 0', []); await sql.unsafe('SET LOCAL statement_timeout = DEFAULT', []); return enter(); }));
await leg('rolled_back_set_local', () => withTransaction(async () => {
	await sql.unsafe('SAVEPOINT zz_s', []);
	await sql.unsafe('SET LOCAL statement_timeout = 0', []);
	await sql.unsafe('ROLLBACK TO SAVEPOINT zz_s', []);
	return enter();
}));
console.log('RESULT ' + JSON.stringify(results));
process.exit(0);
`;

/**
 * THE CONNECTION-BUDGET LEG (its own child: pool sizes are frozen at import;
 * DB_POOL_MAX=2, DB_MAINTENANCE_POOL_MAX=2). The budget every consumer states
 * (src/core/db/connection_budget.ts — test_shard's per-child allowance, the ops
 * arithmetic) must be a bound on PHYSICAL backends, not on gate slots: the gate
 * counts connections in use, a Bun pool keeps idle ones open. Measured in
 * pg_stat_activity, by this child's own application_names:
 *  - maintenance: scoped statements fill the maintenance pool, THEN
 *    non-transactional ones fill its twin (the optimize door's order) — both
 *    pools' idle connections are still open when they are counted;
 *  - dedicated: many concurrent pg_xact_status verdicts (each on a dedicated
 *    connection that takes no pool slot), sampled while they run.
 */
const BUDGET_DRIVER = `
import * as pg from ${repoModule('src/core/db/postgres.ts')};
import { config } from ${repoModule('src/config/config.ts')};
import { assertTestDatabase } from ${repoModule('src/core/test_data/test_database_marker.ts')};
await assertTestDatabase('statement_ceiling_scope_native:budget');
const { sql, withTransaction, withUnboundedStatements, runWithoutStatementTimeout, readTransactionStatus } = pg;
const maintenancePoolMax = config.ops.dbMaintenancePoolMax;
const countApps = async (pattern) => Number((await sql.unsafe(
	"SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND application_name LIKE $1",
	[pattern]))[0].n);
const SLEEP = 'SELECT pg_sleep(0.3)';
await Promise.all(Array.from({ length: maintenancePoolMax }, () => withUnboundedStatements(() => sql.unsafe(SLEEP, []))));
// The non-transactional twin admits only the WEAK-lock forms (postgres.ts
// nonTransactionalLockClass): fill it with real ones — VACUUMs held ~0.3s
// behind a SHARE UPDATE EXCLUSIVE holder, each on its own connection.
const NONTX_TABLE = 'dedalo_ts_test_ceilb_' + process.pid;
await sql.unsafe('CREATE TABLE IF NOT EXISTS "' + NONTX_TABLE + '" (id int)', []);
const lockHolder = await sql.reserve();
await lockHolder.unsafe('BEGIN', []);
await lockHolder.unsafe('LOCK TABLE "' + NONTX_TABLE + '" IN SHARE UPDATE EXCLUSIVE MODE', []);
const vacuums = Promise.all(Array.from({ length: maintenancePoolMax }, () => runWithoutStatementTimeout('VACUUM ANALYZE "' + NONTX_TABLE + '"')));
await Bun.sleep(300);
await lockHolder.unsafe('COMMIT', []);
lockHolder.release();
await vacuums;
await sql.unsafe('DROP TABLE IF EXISTS "' + NONTX_TABLE + '"', []);
const maintenance = await countApps('dedalo_maintenance:%' + process.pid + ':%');
// A committed xid for the verdicts to read.
const xid = await withTransaction(async () => (await sql.unsafe('SELECT pg_current_xact_id()::text AS x', []))[0].x);
const DEDICATED_APP = 'dedalo_xact_status:' + process.pid;
let dedicatedPeak = 0;
let sampling = true;
const sampler = (async () => {
	while (sampling) {
		dedicatedPeak = Math.max(dedicatedPeak, await countApps(DEDICATED_APP));
	}
})();
const verdicts = await Promise.all(Array.from({ length: 32 }, () => readTransactionStatus(xid).catch((e) => 'THREW ' + String(e?.code ?? e))));
// Let the background closes land, then take one last sample.
await Bun.sleep(50);
sampling = false;
await sampler;
console.log('RESULT ' + JSON.stringify({ poolMax: config.ops.dbPoolMax, maintenancePoolMax, maintenance, dedicatedPeak, verdicts }));
process.exit(0);
`;

const driver = childDriver('dedalo-statement-ceiling');
let budget: {
	poolMax: number;
	maintenancePoolMax: number;
	maintenance: number;
	dedicatedPeak: number;
	verdicts: string[];
} | null = null;
let zeroCeiling: Record<string, LegResult> = {};
let legs: Record<string, LegResult> = {};
let shutdown: {
	seen: boolean;
	closeMs: number;
	statement: string;
	ownName: string;
	foreignSeen: Record<string, { datname: string; app: string } | null>;
	foreignAfter: Record<string, boolean>;
	nontxName: string;
	nontxOutcome: string;
} | null = null;
let zeroSlot: { configured: number; gateMax: number; outcome: unknown } | null = null;

beforeAll(async () => {
	await assertTestDatabase('statement_ceiling_scope_native');
	const { exitCode, stdout, stderr } = await driver.run('ceiling_scope_driver.ts', DRIVER, {
		DB_STATEMENT_TIMEOUT_MS: String(CEILING_MS),
		DB_POOL_ACQUIRE_TIMEOUT_MS: '300',
		DB_POOL_MAX: '2',
		DB_MAINTENANCE_POOL_MAX: '1',
	});
	if (exitCode !== 0) throw new Error(`ceiling driver exited ${exitCode}:\n${stderr}`);
	legs = driverResult<Record<string, LegResult>>(stdout, stderr);
	const closing = await driver.run('ceiling_shutdown_driver.ts', SHUTDOWN_DRIVER, {
		DB_STATEMENT_TIMEOUT_MS: String(CEILING_MS),
		// Two slots: the transactional and the non-transactional statement run
		// at once (the two maintenance lanes share one gate).
		DB_MAINTENANCE_POOL_MAX: '2',
	});
	if (closing.exitCode !== 0) {
		throw new Error(`shutdown driver exited ${closing.exitCode}:\n${closing.stderr}`);
	}
	shutdown = driverResult(closing.stdout, closing.stderr);
	const zero = await driver.run('ceiling_zero_slot_driver.ts', ZERO_SLOT_DRIVER, {
		DB_MAINTENANCE_POOL_MAX: '0',
		DB_POOL_ACQUIRE_TIMEOUT_MS: '0',
	});
	if (zero.exitCode !== 0)
		throw new Error(`zero-slot driver exited ${zero.exitCode}:\n${zero.stderr}`);
	zeroSlot = driverResult(zero.stdout, zero.stderr);
	const unconfigured = await driver.run('ceiling_zero_ceiling_driver.ts', ZERO_CEILING_DRIVER, {
		DB_STATEMENT_TIMEOUT_MS: '0',
	});
	if (unconfigured.exitCode !== 0) {
		throw new Error(`zero-ceiling driver exited ${unconfigured.exitCode}:\n${unconfigured.stderr}`);
	}
	zeroCeiling = driverResult(unconfigured.stdout, unconfigured.stderr);
	const budgeted = await driver.run('ceiling_budget_driver.ts', BUDGET_DRIVER, {
		DB_POOL_MAX: '2',
		DB_MAINTENANCE_POOL_MAX: '2',
		DB_POOL_ACQUIRE_TIMEOUT_MS: '0',
	});
	if (budgeted.exitCode !== 0) {
		throw new Error(`budget driver exited ${budgeted.exitCode}:\n${budgeted.stderr}`);
	}
	budget = driverResult(budgeted.stdout, budgeted.stderr);
}, 120000);

afterAll(() => driver.dispose());

function legValue(name: string): unknown {
	const result = legs[name];
	if (result === undefined) throw new Error(`leg ${name} did not run`);
	if (!result.ok) throw new Error(`leg ${name} threw: ${JSON.stringify(result.error)}`);
	return result.value;
}

function errorOf(name: string): ErrorShape {
	const result = legs[name];
	if (result === undefined) throw new Error(`leg ${name} did not run`);
	if (result.ok) throw new Error(`leg ${name} did not fail: ${JSON.stringify(result.value)}`);
	return result.error;
}

function expectTypedTimeout(error: ErrorShape, lane: string, ceilingMs: number): void {
	expect(error.code, `a 57014 escaped untyped: ${JSON.stringify(error)}`).toBe(
		'db.statement_timeout',
	);
	expect(error.status).toBe(503);
	expect(error.coordinates?.lane).toBe(lane);
	expect(error.coordinates?.ceiling_ms).toBe(ceilingMs);
}

describe('the pool ceiling is real, and the scope lifts it', () => {
	test('a pooled connection carries the configured ceiling', () => {
		expect(legValue('pooled_show')).toBe(CEILING);
	});
	test('inside withUnboundedStatements the ceiling is 0', () => {
		expect(legValue('scope_show')).toBe('0');
	});
	test('in scope, the pooled template, unsafe, transaction and reserve lanes all run past the ceiling', () => {
		expect(legValue('scope_lanes')).toBe('all lanes completed');
	});
	test('after the scope, every pooled connection still reads the ceiling (no GUC leaked)', () => {
		expect(legValue('after_scope_pooled')).toEqual(Array(4).fill(CEILING));
	});
	test('a timer created in scope that fires after exit is bounded again (scope expiry)', () => {
		expect(legValue('timer_expiry')).toBe(CEILING);
	});
	test('a detached job started in scope does not inherit the lift', () => {
		expect(legValue('detached_exit')).toBe(CEILING);
	});
	test('entering the scope inside a bounded transaction is refused', () => {
		expect(errorOf('scope_inside_bounded_tx').code).toBe('internal.invariant');
	});
});

describe('the scope refusal is keyed on the LANE, not on the configured ceiling', () => {
	const zeroLeg = (name: string): LegResult => {
		const result = zeroCeiling[name];
		if (result === undefined) throw new Error(`zero-ceiling leg ${name} did not run`);
		return result;
	};
	test('non-vacuity: the child really runs with the configured request ceiling at 0', () => {
		expect(zeroLeg('ceiling')).toEqual({ ok: true, value: 0 });
	});
	test('a request-pool transaction is refused though its ceiling reads 0', () => {
		const result = zeroLeg('request_tx');
		expect(result.ok, JSON.stringify(result)).toBe(false);
		if (!result.ok) {
			expect(result.error.code).toBe('internal.invariant');
			expect(result.error.coordinates?.lane).toBe('main');
			// …whose recorded ceiling IS 0: a ceiling-keyed check let exactly this through.
			expect(result.error.coordinates?.ceiling_ms).toBe(0);
		}
	});
	test('an explicit SET LOCAL statement_timeout = 0 in force makes it joinable', () => {
		expect(zeroLeg('set_local_zero')).toEqual({ ok: true, value: 'entered' });
	});
	for (const [leg, why] of [
		['set_local_default', 'SET LOCAL … = DEFAULT restores the configured ceiling'],
		['rolled_back_set_local', 'a ROLLBACK TO past the SET LOCAL undid it'],
	] as const) {
		test(`refused again when ${why}`, () => {
			const result = zeroLeg(leg);
			expect(result.ok, JSON.stringify(result)).toBe(false);
			if (!result.ok) expect(result.error.code).toBe('internal.invariant');
		});
	}
});

describe('savepoints carry the commit-only queue (W12)', () => {
	test('ROLLBACK TO drops the actions queued after its savepoint; RELEASE keeps them', async () => {
		const ran: string[] = [];
		const queue = (name: string) => {
			expect(registerCommitAction(() => void ran.push(name))).toBe(true);
		};
		await withTransaction(async () => {
			queue('before');
			await sql.unsafe('SAVEPOINT zz_undone', []);
			queue('undone');
			await sql.unsafe('SAVEPOINT zz_inner', []);
			queue('undone_inner');
			await sql.unsafe('ROLLBACK TO SAVEPOINT zz_undone', []);
			await sql.unsafe('SAVEPOINT zz_kept', []);
			queue('kept');
			await sql.unsafe('RELEASE SAVEPOINT zz_kept', []);
			queue('after');
		});
		expect(ran).toEqual(['before', 'kept', 'after']);
	});

	test('a ROLLBACK TO the recorder cannot pair, with commit actions queued, refuses the COMMIT', async () => {
		const ran: string[] = [];
		let thrown: unknown = null;
		try {
			await withTransaction(async () => {
				await sql.unsafe('SAVEPOINT zz_u', []);
				registerCommitAction(() => void ran.push('maybe_undone'));
				// A trailing comment: valid SQL the single-statement pattern does not pair.
				await sql.unsafe('ROLLBACK TO SAVEPOINT zz_u /* why */', []);
			});
		} catch (error) {
			thrown = error;
		}
		expect((thrown as { code?: string } | null)?.code, String(thrown)).toBe('internal.invariant');
		expect(ran).toEqual([]);
	});

	test('an unpaired ROLLBACK TO with no commit action queued commits as before', async () => {
		const out = await withTransaction(async () => {
			await sql.unsafe('SAVEPOINT zz_v', []);
			await sql.unsafe('ROLLBACK TO SAVEPOINT zz_v /* why */', []);
			return 'committed';
		});
		expect(out).toBe('committed');
	});
});

describe('withStatementBudget with no ambient transaction: the bound applies, the lane is respected', () => {
	type Probe = { appliedMs: number; shown: string; app: string; inTx: boolean };
	test('request lane: its own transaction, the budget SET LOCAL (never above the ceiling), nothing leaked', () => {
		const value = legValue('budget_request_lane') as {
			inside: Probe;
			above: Probe;
			after: string[];
		};
		expect(value.inside).toMatchObject({ appliedMs: 100, shown: '100ms', inTx: true });
		expect(value.inside.app.startsWith('dedalo_maintenance')).toBe(false);
		// A budget above the pool ceiling is clamped to it.
		expect(value.above).toMatchObject({ appliedMs: CEILING_MS, shown: CEILING, inTx: true });
		expect(value.after).toEqual(Array(4).fill(CEILING));
	});
	test('request lane: a statement past the budget is the typed 503 at the BUDGET', () => {
		expectTypedTimeout(errorOf('budget_request_lane_cut'), 'transaction', 100);
	});
	test('unbounded scope: the bound still applies (tighter than its 0), on the MAINTENANCE lane, and the scope keeps its 0', () => {
		const value = legValue('budget_unbounded_lane') as {
			inside: Probe;
			scopeAfter: string;
			after: string[];
		};
		expect(value.inside).toMatchObject({ appliedMs: 200, shown: '200ms', inTx: true });
		expect(value.inside.app.startsWith('dedalo_maintenance:')).toBe(true);
		expect(value.inside.app.includes(':nontx:')).toBe(false);
		expect(value.scopeAfter).toBe('0');
		expect(value.after).toEqual(Array(4).fill(CEILING));
	});
	test('unbounded scope: a statement past the budget is cut, typed, at the budget', () => {
		expectTypedTimeout(errorOf('budget_unbounded_lane_cut'), 'transaction', 200);
	});
	test('the non-transactional lane is refused under a budget, and stays unbounded after one', () => {
		expect(errorOf('budget_refuses_nontx_lane').code).toBe('internal.invariant');
		const after = legValue('nontx_after_budget') as { elapsedMs: number; pooled: string[] };
		expect(after.elapsedMs).toBeGreaterThanOrEqual(550);
		expect(after.pooled).toEqual(Array(4).fill(CEILING));
	});
});

describe('a fired ceiling is the typed 503 db.statement_timeout', () => {
	test('pooled tagged template', () =>
		expectTypedTimeout(errorOf('pooled_template_timeout'), 'pooled', CEILING_MS));
	test('pooled unsafe', () =>
		expectTypedTimeout(errorOf('pooled_unsafe_timeout'), 'pooled', CEILING_MS));
	test('in-transaction tagged template', () =>
		expectTypedTimeout(errorOf('tx_template_timeout'), 'transaction', CEILING_MS));
	test('in-transaction unsafe', () =>
		expectTypedTimeout(errorOf('tx_unsafe_timeout'), 'transaction', CEILING_MS));
	test('the recorder: SET LOCAL statement_timeout=100ms makes 100 the ceiling that fired', () =>
		expectTypedTimeout(errorOf('recorder_set_local'), 'transaction', 100));
	test('the recorder: ROLLBACK TO SAVEPOINT restores the ceiling the savepoint was taken under', () =>
		expectTypedTimeout(errorOf('recorder_rollback_to_savepoint'), 'transaction', CEILING_MS));
	test('the recorder: RELEASE SAVEPOINT keeps a SET LOCAL made after it', () =>
		expectTypedTimeout(errorOf('recorder_release_savepoint'), 'transaction', 100));
});

describe('a 57014 that is NOT the ceiling stays raw', () => {
	test('an operator pg_cancel_backend before the ceiling is not mapped', () => {
		const cancelled = legValue('operator_cancel_raw') as ErrorShape | string;
		expect(typeof cancelled, `cancel did not land: ${JSON.stringify(cancelled)}`).toBe('object');
		expect((cancelled as ErrorShape).errno).toBe('57014');
		expect((cancelled as ErrorShape).dedalo).toBe(false);
	});
	test('a ceiling changed in a way the recorder cannot parse (set_config) is unknown: its 57014 stays raw', () => {
		const unknown = errorOf('recorder_unknown_raw');
		expect(unknown.name, `not the driver's raw error: ${JSON.stringify(unknown)}`).toBe(
			'PostgresError',
		);
		expect(unknown.errno).toBe('57014');
		expect(unknown.dedalo).toBe(false);
	});
	test('the reserved lane is never mapped (migrate.ts isStoppedRun reads the raw errno)', () => {
		const reserved = legValue('reserved_raw') as ErrorShape;
		expect(reserved.errno).toBe('57014');
		expect(reserved.dedalo).toBe(false);
	});
});

describe('the acquire gate is total and typed', () => {
	test('a connection-taking Bun member (begin, transaction) is refused at once, even with the pool saturated', () => {
		const outcomes = legValue('begin_refused_saturated') as Record<
			string,
			{ outcome: ErrorShape | string; elapsedMs: number }
		>;
		for (const member of ['begin', 'transaction']) {
			const entry = outcomes[member];
			expect(entry, `${member} leg missing`).toBeDefined();
			expect(
				(entry?.outcome as ErrorShape).code,
				`sql.${member} was not refused: ${JSON.stringify(entry)}`,
			).toBe('internal.invariant');
			expect(entry?.elapsedMs ?? Number.POSITIVE_INFINITY).toBeLessThan(1000);
		}
	});
	test('the refusal is an ALLOWLIST: EVERY function member of a Bun SQL pool but the three doors is refused, on the pooled and the transaction lane', async () => {
		// Enumerated from a REAL Bun SQL instance (prototype chain included; it
		// never connects), so a member Bun adds tomorrow is covered by the same
		// run: a regression to a begin/transaction denylist lets `sql.file()`,
		// `sql.listen()` or `sql.beginDistributed()` take a connection past the
		// acquire gate, the session-SET refusal, the recorder and 57014 typing.
		const DOORS = new Set<PropertyKey>(['unsafe', 'reserve', 'array']);
		const probe = new SQL({ hostname: '127.0.0.1', port: 1, database: 'never_connects', max: 1 });
		const members = new Set<PropertyKey>();
		for (
			let level: object | null = probe;
			level !== null && level !== Object.prototype && level !== Function.prototype;
			level = Object.getPrototypeOf(level)
		) {
			for (const key of Reflect.ownKeys(level)) {
				if (DOORS.has(key)) continue;
				if (typeof (probe as unknown as Record<PropertyKey, unknown>)[key] === 'function') {
					members.add(key);
				}
			}
		}
		await probe.close({ timeout: 0 }).catch(() => undefined);
		// Non-vacuity: the enumeration saw the members the refusal exists for.
		for (const expected of ['file', 'listen', 'begin', 'transaction', 'beginDistributed']) {
			expect(members.has(expected), `enumeration missed ${expected} (vacuous)`).toBe(true);
		}
		const codeOf = (call: () => unknown): string => {
			try {
				call();
				return 'NOT REFUSED';
			} catch (error) {
				return String((error as { code?: unknown }).code);
			}
		};
		const handle = sql as unknown as Record<PropertyKey, unknown>;
		const pooledLeaks = [...members]
			.map((member) => ({
				member: String(member),
				code: codeOf(() => (handle[member] as () => unknown)()),
			}))
			.filter(({ code }) => code !== 'internal.invariant');
		expect(pooledLeaks, 'a connection-taking member was not refused on the pooled lane').toEqual(
			[],
		);
		// The transaction lane forwards through the same rule, plus its own
		// connection-taking member (savepoint).
		const txLeaks = await withTransaction(async () =>
			[...members, 'savepoint']
				.map((member) => ({
					member: String(member),
					code: codeOf(() => (handle[member] as () => unknown)()),
				}))
				.filter(({ code }) => code !== 'internal.invariant'),
		);
		expect(txLeaks, 'a connection-taking member was not refused on the transaction lane').toEqual(
			[],
		);
	});
	test('two held transactions → the next pooled query is 503 db.pool_exhausted in < 1s', () => {
		const { outcome, elapsedMs } = legValue('pool_exhausted_tx') as {
			outcome: ErrorShape | string;
			elapsedMs: number;
		};
		expect((outcome as ErrorShape).code, JSON.stringify(outcome)).toBe('db.pool_exhausted');
		expect((outcome as ErrorShape).status).toBe(503);
		expect(elapsedMs).toBeLessThan(1000);
	});
	test('the MAINTENANCE pool has the same bound: one held scoped transaction → the next scoped statement is 503 db.pool_exhausted naming it, in < 1s', () => {
		const { outcome, elapsedMs } = legValue('maintenance_pool_exhausted') as {
			outcome: ErrorShape | string;
			elapsedMs: number;
		};
		expect(outcome, 'the maintenance gate waited without bound').not.toBe('HUNG 3s');
		expect((outcome as ErrorShape).code, JSON.stringify(outcome)).toBe('db.pool_exhausted');
		expect((outcome as ErrorShape).status).toBe(503);
		expect((outcome as ErrorShape).coordinates?.pool).toBe('maintenance');
		expect(elapsedMs).toBeLessThan(1000);
	});
	test('a maintenance run waiting for its slot leaves the queue at once when aborted (not at the acquire timeout)', () => {
		const leg = legValue('maintenance_waiter_abort') as {
			outcome: ErrorShape | string;
			settleMs: number;
			waitersBefore: number;
			waitersAfter: number;
		};
		expect(leg.waitersBefore, 'the run never queued for the slot (vacuous leg)').toBe(1);
		expect(leg.outcome, 'the run ran while its slot was held').not.toBe('RAN');
		expect((leg.outcome as ErrorShape).name, JSON.stringify(leg.outcome)).toBe('AbortError');
		expect(leg.settleMs, 'the abort waited for the acquire timeout').toBeLessThan(150);
		expect(leg.waitersAfter, 'the aborted waiter stayed in the queue').toBe(0);
	});
	test('DB_MAINTENANCE_POOL_MAX=0 is clamped to one slot: a scoped statement completes, never a zero-slot hang', () => {
		expect(zeroSlot, 'zero-slot leg did not run').not.toBeNull();
		expect(zeroSlot?.configured).toBe(1);
		expect(zeroSlot?.gateMax).toBe(1);
		expect(zeroSlot?.outcome).toBe(1);
	});
	test('two held reserve()s → the next pooled query is db.pool_exhausted, not a hang', () => {
		const { outcome, elapsedMs } = legValue('pool_exhausted_reserve') as {
			outcome: ErrorShape | string;
			elapsedMs: number;
		};
		expect(outcome, 'reserved connections exhausted the pool behind the gate').not.toBe('HUNG 3s');
		expect((outcome as ErrorShape).code, JSON.stringify(outcome)).toBe('db.pool_exhausted');
		expect(elapsedMs).toBeLessThan(1000);
	});
});

describe('no pooled GUC is ever mutated', () => {
	test('runWithoutStatementTimeout runs past the ceiling on a connection whose 0 was never SET', () => {
		const helper = legValue('helper_no_guc_mutation') as {
			elapsedMs: number;
			setting: string;
			source: string;
			pooled: string[];
		};
		expect(helper.elapsedMs).toBeGreaterThan(540);
		expect(helper.setting).toBe('0');
		expect(helper.source, 'the helper cleared the ceiling with a session SET').not.toBe('session');
		expect(helper.pooled).toEqual(Array(4).fill(CEILING));
	});
	test('a session SET on the pooled lane is refused and leaves the GUC intact', () => {
		expect(errorOf('session_set_pooled').code).toBe('internal.invariant');
		expect(legValue('after_session_set_pooled')).toEqual(Array(4).fill(CEILING));
	});
	test('a session SET inside a transaction is refused and leaves the GUC intact', () => {
		expect(errorOf('session_set_tx').code).toBe('internal.invariant');
		expect(legValue('after_session_set_tx')).toEqual(Array(4).fill(CEILING));
	});
	for (const [leg, where] of [
		['set_config_session_pooled', 'pooled'],
		['set_config_session_tx', 'in a transaction'],
	] as const) {
		test(`a session-scoped set_config(…, false) (${where}) is refused and leaves the GUC intact`, () => {
			expect(errorOf(leg).code).toBe('internal.invariant');
			expect(legValue(`after_${leg}`)).toEqual(Array(4).fill(CEILING));
		});
	}
	test('a session SET through the tagged template is refused and leaves the GUC intact', () => {
		expect(errorOf('session_set_template').code).toBe('internal.invariant');
		expect(legValue('after_session_set_template')).toEqual(Array(4).fill(CEILING));
	});
	for (const [leg, where] of [
		['multi_set_pooled_params', 'a later statement, pooled unsafe (params [])'],
		['multi_set_pooled_bare', 'a later statement, pooled unsafe (no params)'],
		['multi_set_template', 'a later statement, tagged template'],
		['multi_set_tx', 'a later statement, in-transaction unsafe (RESET)'],
		['comment_set_pooled', 'behind a leading comment'],
		['nested_comment_set_pooled', 'behind a NESTED leading comment, pooled'],
		['nested_comment_set_tx', 'behind a NESTED leading comment, in a transaction'],
	] as const) {
		test(`a session SET hidden from a start-anchored check (${where}) is refused and leaves the GUC intact`, () => {
			expect(errorOf(leg).code).toBe('internal.invariant');
			expect(legValue(`after_${leg}`)).toEqual(Array(4).fill(CEILING));
		});
	}
	test('a ";" and a SET inside a string literal split nothing (the lexer, not a substring match)', () => {
		expect(legValue('multi_literal_allowed')).toBe('x; SET statement_timeout = 0');
	});
	for (const [leg, where] of [
		['do_set_pooled', 'a DO body SET, pooled'],
		['do_execute_set_pooled', "a DO body EXECUTE 'SET …', pooled"],
		['do_set_config_pooled', 'a DO body set_config(…, false), pooled'],
		['do_set_config_tx', 'a DO body set_config(…, false), in a transaction'],
		['set_config_expr_pooled', "set_config(…, lower('0'), false) — a nested-paren argument"],
		['set_config_nonliteral_pooled', 'set_config(…, 1=0) — a non-literal third argument'],
	] as const) {
		test(`session state hidden from a text-level rule (${where}) is refused and leaves the GUC intact`, () => {
			expect(errorOf(leg).code).toBe('internal.invariant');
			expect(legValue(`after_${leg}`)).toEqual(Array(4).fill(CEILING));
		});
	}
	test('non-vacuity: a DO body without session state, and a transaction-local set_config, run', () => {
		expect(legValue('do_local_allowed')).toBe('ran');
	});
	test('THE OUTCOME: after every leg, no pooled or maintenance connection carries a session-set statement_timeout', () => {
		const sources = legValue('no_session_source') as {
			pooled: string[];
			maintenance: string[];
			helper: { source: string; app: string };
		};
		// Startup parameters read 'client' — never 'session'.
		expect(sources.pooled).toEqual(Array(4).fill('client'));
		expect(sources.maintenance).toEqual(Array(2).fill('client'));
		expect(sources.helper.source).toBe('client');
		// A non-weak text never reaches the non-transactional lane (which admits
		// only VACUUM / ANALYZE / CONCURRENTLY — no statement there can set state).
		expect(sources.helper.app).toStartWith('dedalo_maintenance:');
		expect(sources.helper.app).not.toStartWith('dedalo_maintenance:nontx:');
	});
	test('the driver never hung (its watchdog did not fire)', () => {
		expect(legs.__watchdog, JSON.stringify(legs.__watchdog)).toBeUndefined();
	});
});

/**
 * TRANSACTION CONTROL is refused before it is sent (review 2026-09-30): on the
 * transaction lane a COMMIT ended the unit mid-way (every later statement
 * autocommitted, and the recorder described a transaction that no longer
 * existed); on the pooled lane a BEGIN handed the next caller a connection
 * inside someone else's transaction. Measured as OUTCOMES: the transaction id
 * never changes across the refused statement, and the transaction still commits
 * as one; ROLLBACK TO / SAVEPOINT / RELEASE stay allowed (legs above).
 */
describe('transaction control never reaches the server', () => {
	const FORMS = [
		'COMMIT',
		'commit work',
		'END',
		'ROLLBACK',
		'ROLLBACK AND CHAIN',
		'ABORT',
		'BEGIN',
		'START TRANSACTION',
		"PREPARE TRANSACTION 'zz_g3'",
		"COMMIT PREPARED 'zz_g3'",
		'/* why */ COMMIT',
		'SELECT 1; COMMIT',
	];
	const xid = async () =>
		((await sql.unsafe('SELECT pg_current_xact_id()::text AS x', [])) as { x: string }[])[0]?.x;
	for (const form of FORMS) {
		test(`${JSON.stringify(form)} in a transaction: refused, and the transaction id never changes`, async () => {
			const out = await withTransaction(async () => {
				const before = await xid();
				let code: string | undefined;
				try {
					await sql.unsafe(form, []);
				} catch (error) {
					code = (error as { code?: string }).code;
				}
				return { before, after: await xid(), code };
			});
			expect(out.code, `${form} was sent`).toBe('internal.invariant');
			expect(out.after, 'the transaction ended').toBe(out.before);
		});
		test(`${JSON.stringify(form)} on the pooled lane: refused`, async () => {
			let code: string | undefined;
			try {
				await sql.unsafe(form, []);
			} catch (error) {
				code = (error as { code?: string }).code;
			}
			expect(code, `${form} was sent`).toBe('internal.invariant');
		});
	}
	test('after the refused BEGINs, no pooled connection is inside a transaction', async () => {
		await Bun.sleep(20);
		const fresh = (await Promise.all(
			Array.from({ length: 20 }, () =>
				sql.unsafe('SELECT now() = statement_timestamp() AS fresh', []),
			),
		)) as { fresh: boolean }[][];
		expect(fresh.map((rows) => rows[0]?.fresh)).toEqual(Array(20).fill(true));
	});
	test('ROLLBACK TO SAVEPOINT (every spelling the recorder pairs) still runs', async () => {
		const out = await withTransaction(async () => {
			await sql.unsafe('SAVEPOINT zz_t', []);
			await sql.unsafe('ROLLBACK TO SAVEPOINT zz_t', []);
			await sql.unsafe('ROLLBACK WORK TO zz_t', []);
			await sql.unsafe('ROLLBACK TRANSACTION TO SAVEPOINT zz_t', []);
			await sql.unsafe('RELEASE zz_t', []);
			return 'ran';
		});
		expect(out).toBe('ran');
	});
});

describe('shutdown closes the maintenance pool bounded', () => {
	test('closeDatabasePool returns promptly with an unbounded statement running, and cancels it', async () => {
		expect(shutdown, 'shutdown leg did not run').not.toBeNull();
		expect(shutdown?.seen, 'the unbounded statement never started (vacuous leg)').toBe(true);
		expect(
			shutdown?.closeMs ?? Number.POSITIVE_INFINITY,
			'the close waited for the unbounded statement',
		).toBeLessThan(9000);
		expect(shutdown?.statement).not.toBe('completed');
		const rows = (await sql.unsafe(
			"SELECT count(*)::int AS n FROM pg_stat_activity WHERE state = 'active' AND position($1 in query) > 0 AND pid <> pg_backend_pid()",
			[SHUTDOWN_MARKER],
		)) as { n: number }[];
		expect(rows[0]?.n, 'the backend outlived the shutdown').toBe(0);
	});

	test('a NON-TRANSACTIONAL maintenance statement (a CONCURRENTLY build in production) is never cancelled by the shutdown: it completes', () => {
		expect(shutdown, 'shutdown leg did not run').not.toBeNull();
		expect(shutdown?.nontxName, 'the non-transactional statement never started').toStartWith(
			'dedalo_maintenance:nontx:',
		);
		// Its OWN identity, not the one the cancel names.
		expect(shutdown?.nontxName).not.toBe(shutdown?.ownName);
		expect(
			shutdown?.nontxOutcome,
			'the shutdown cancelled a non-transactional statement (a REINDEX CONCURRENTLY would leave an invalid index)',
		).toBe('completed');
	});

	test('the shutdown cancel reaches ONLY this process-boot, database and role: foreign namesakes survive', () => {
		expect(shutdown, 'shutdown leg did not run').not.toBeNull();
		const legs = ['pid_sibling', 'nonce_sibling', 'other_database'];
		for (const leg of legs) {
			// Non-vacuity: each foreign backend was really running, under the
			// name/database it was meant to impersonate, when the pools closed.
			expect(shutdown?.foreignSeen[leg], `${leg} never started (vacuous leg)`).toBeTruthy();
		}
		expect(shutdown?.foreignSeen.other_database?.datname).toBe('postgres');
		expect(shutdown?.foreignSeen.other_database?.app).toBe(shutdown?.ownName ?? '');
		expect(shutdown?.ownName, 'the maintenance pool carries no application_name').toStartWith(
			'dedalo_maintenance:',
		);
		const cancelled = legs.filter((leg) => shutdown?.foreignAfter[leg] !== true);
		expect(cancelled, "this process's shutdown cancelled another process's maintenance").toEqual(
			[],
		);
	});
});

describe('the connection budget is physical (what pg_stat_activity counts, not gate slots)', () => {
	test('both maintenance pools linger after an optimize-shaped run, and the budget counts them', () => {
		expect(budget, 'budget leg did not run').not.toBeNull();
		const { maintenancePoolMax, maintenance } = budget as NonNullable<typeof budget>;
		expect(maintenancePoolMax).toBe(2);
		// Non-vacuity: the second pool is real — more backends than ONE pool's max.
		expect(maintenance, 'the non-transactional lane opened no pool of its own').toBeGreaterThan(
			maintenancePoolMax,
		);
		expect(
			maintenance,
			'the maintenance lane holds more backends than the stated budget counts',
		).toBeLessThanOrEqual(maintenanceConnectionsPerProcess(maintenancePoolMax));
	});

	test('dedicated connections (cancel / xact-status verdicts) never exceed DEDICATED_CONNECTIONS_MAX at once', () => {
		expect(budget, 'budget leg did not run').not.toBeNull();
		const { dedicatedPeak, verdicts } = budget as NonNullable<typeof budget>;
		// Every verdict completed (a bounded wait for a dedicated slot is inside
		// its budget, not a failure) — and a committed xid reads 'committed'.
		expect(verdicts).toEqual(Array(32).fill('committed'));
		expect(dedicatedPeak, 'no dedicated connection was ever sampled (vacuous leg)').toBeGreaterThan(
			0,
		);
		expect(
			dedicatedPeak,
			'more dedicated connections were open at once than the budget counts',
		).toBeLessThanOrEqual(DEDICATED_CONNECTIONS_MAX);
	});
});

/**
 * THE RECORDER'S PARSER, as a truth table (pure). A wrong unit or form would
 * record the wrong ceiling and type an operator cancel as a timeout (or miss a
 * real one) — each row pins one form. Pool ceiling 250 (what DEFAULT restores).
 */
describe('parseStatementTimeoutDirective (the recorder)', () => {
	const rows: [string, number | null | undefined][] = [
		['SET LOCAL statement_timeout = 5000', 5000],
		['SET LOCAL statement_timeout = 0', 0],
		["SET LOCAL statement_timeout TO '2s'", 2000],
		["SET LOCAL statement_timeout = '1.5min'", 90_000],
		["SET LOCAL statement_timeout = '250ms'", 250],
		["SET LOCAL statement_timeout = '1h'", 3_600_000],
		["SET LOCAL statement_timeout = '1d'", 86_400_000],
		["SET LOCAL statement_timeout = '500us'", 1],
		['SET LOCAL statement_timeout = DEFAULT', 250],
		['SET LOCAL statement_timeout TO DEFAULT', 250],
		['/* why */ SET LOCAL statement_timeout = 100', 100],
		["SELECT set_config('statement_timeout', '100', true)", null],
		// Which setting a set_config names may be an expression: ANY is unknown.
		["SELECT set_config(lower('STATEMENT_TIMEOUT'), '0', true)", null],
		["SELECT set_config('statement' || '_timeout', '0', true)", null],
		["DO $$BEGIN PERFORM set_config('statement_timeout', '0', true); END$$", null],
		['DO $$BEGIN SET LOCAL statement_timeout = 0; END$$', null],
		['SET LOCAL "statement_timeout" = 100', null],
		["SET LOCAL statement_timeout = 'soon'", null],
		['SELECT 1; SET LOCAL statement_timeout = 100', null],
		['SELECT 1', undefined],
		['SET LOCAL lock_timeout = 100', undefined],
	];
	for (const [text, expected] of rows) {
		test(`${text} → ${String(expected)}`, () => {
			expect(parseStatementTimeoutDirective(text, 250)).toBe(expected);
		});
	}
});

/** The ONE lexer (db/sql_lexer.ts), shared with the update-descriptor validator. */
describe('sql_lexer: statements are split outside literals only', () => {
	const rows: [string, string[] | null][] = [
		['SELECT 1; SET x = 0', ['SELECT 1', 'SET x = 0']],
		["SELECT 'a; SET x = 0'", ["SELECT ''"]],
		["SELECT E'it\\'s; SET x'; RESET x", ["SELECT E''", 'RESET x']],
		['SELECT $q$ ; SET $q$; DISCARD ALL', ['SELECT $$', 'DISCARD ALL']],
		['SELECT $1; SET x = 0', ['SELECT $1', 'SET x = 0']],
		['SELECT 1 /* a; /* nested; */ b; */; SET x', ['SELECT 1', 'SET x']],
		['SELECT 1 -- ; SET x\n', ['SELECT 1']],
		['SELECT "a;b" FROM t; SET x', ['SELECT "" FROM t', 'SET x']],
		["SELECT 'unterminated", null],
	];
	for (const [text, expected] of rows) {
		test(JSON.stringify(text), () => {
			expect(strippedStatements(text)).toEqual(expected);
		});
	}
	test('each statement keeps its RAW text (a DO body is read raw)', () => {
		expect(sqlStatements("SELECT 1; DO $$BEGIN SET x = 0; END$$ ; SELECT 'a;b'")).toEqual([
			{ raw: 'SELECT 1', stripped: 'SELECT 1' },
			{ raw: 'DO $$BEGIN SET x = 0; END$$', stripped: 'DO $$' },
			{ raw: "SELECT 'a;b'", stripped: "SELECT ''" },
		]);
	});
	test('unquote mode renders a quoted identifier by name', () => {
		expect(stripSqlLiterals('SET LOCAL "lock_timeout" = 0', 'unquote')).toBe(
			'SET LOCAL lock_timeout = 0',
		);
		expect(stripSqlLiterals('SELECT "a""b"', 'unquote')).toBe('SELECT a"b');
	});
});

/** The shared GUC rules (db/sql_lexer.ts), read by the pool AND the update validator. */
describe('sql_lexer: set_config is local only with a literal true', () => {
	const rows: [string, { total: number; sessionScoped: number }][] = [
		["SELECT set_config('', '', true)", { total: 1, sessionScoped: 0 }],
		["SELECT set_config('', '', TRUE)", { total: 1, sessionScoped: 0 }],
		["SELECT set_config('', '', false)", { total: 1, sessionScoped: 1 }],
		["SELECT set_config('', lower(''), false)", { total: 1, sessionScoped: 1 }],
		["SELECT set_config('', '', 1=0)", { total: 1, sessionScoped: 1 }],
		["SELECT set_config('', '', $3)", { total: 1, sessionScoped: 1 }],
		["SELECT set_config('', '', '')", { total: 1, sessionScoped: 1 }],
		["SELECT pg_catalog.set_config('', f(1, 2), true)", { total: 1, sessionScoped: 0 }],
		["SELECT set_config('', ''", { total: 1, sessionScoped: 1 }],
		['SELECT 1', { total: 0, sessionScoped: 0 }],
	];
	for (const [stripped, expected] of rows) {
		test(stripped, () => {
			expect(setConfigCalls(stripped)).toEqual(expected);
		});
	}
});

describe('sql_lexer: a DO body is read raw for session state', () => {
	const rows: [string, boolean][] = [
		['DO $$BEGIN SET statement_timeout = 0; END$$', true],
		['DO $x$BEGIN RESET statement_timeout; END$x$', true],
		["DO $$BEGIN EXECUTE 'SET statement_timeout = 0'; END$$", true],
		["DO $$BEGIN PERFORM set_config('statement_timeout', '0', false); END$$", true],
		["DO $$BEGIN PERFORM set_config('statement_timeout', lower('0'), true); END$$", false],
		["DO $$BEGIN EXECUTE 'SELECT set_config(''a.b'', ''1'', true)'; END$$", true],
		["DO 'BEGIN PERFORM set_config(''a.b'', ''1'', false); END'", true],
		["DO LANGUAGE plpgsql $$BEGIN PERFORM set_config('a.b', '1', true); END$$", false],
		['DO $$BEGIN UPDATE t SET x = 1; END$$', false],
		['DO $$BEGIN SET LOCAL lock_timeout = 1; END$$', false],
	];
	for (const [raw, expected] of rows) {
		test(raw, () => {
			expect(doBodyHoldsSessionState(raw)).toBe(expected);
		});
	}
});
