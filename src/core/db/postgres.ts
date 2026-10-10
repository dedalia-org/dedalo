/**
 * PostgreSQL access for the Dédalo TS server.
 *
 * SQL CONFINEMENT — the TIERED rule (DEC-09; replaces the dead "SQL only in
 * core/db" absolute):
 *   T1 — CONNECTIONS: `new SQL(...)` (pool creation) is confined to core/db/,
 *        ai/rag/vector_store.ts (the separate RAG DB) and
 *        diffusion/targets/mariadb/ (the MariaDB publication target).
 *        Everything else uses the `sql` handle exported here.
 *   T2 — MATRIX DML: writes to matrix jsonb columns go through
 *        db/matrix_write.ts + db/json_codec.ts (the byte-compat chokepoint);
 *        raw `sql.unsafe` matrix writes are the audited exception list, and
 *        every `$n::jsonb` bind must be `$n::text::jsonb` (the Bun
 *        double-encode trap — found on 1.3.9, RE-VERIFIED STILL PRESENT on
 *        1.4.0, 2026-08-25) unless the file is on the object-binding
 *        allowlist — grep-gated by test/unit/ws_a_tripwires.test.ts.
 *   T3 — dd_ontology READS: converge on ontology/resolver.ts accessors
 *        (ratcheted; see WS-D).
 * Prepared-statement discipline (spec §7.7) is unchanged: values are ALWAYS
 * bound parameters; identifiers come from fixed allowlists (§7.6).
 *
 * Client: Bun's built-in SQL (Postgres). Queries use the tagged-template form
 * (sql`... ${value} ...`), which ALWAYS sends values as bound parameters —
 * string concatenation of user values is structurally impossible through this
 * API. Identifiers (table/column names) cannot be parameterized; they must
 * come from fixed allowlists validated at the §7.6 chokepoint BEFORE reaching
 * this layer.
 *
 * Connection: DB_SOCKET (a unix-socket DIRECTORY) wins; else a DB_HOST starting
 * with '/' is one too (Postgres convention, e.g. '/tmp'); otherwise DB_HOST is a
 * TCP hostname. Decided by src/config/pg_transport.ts, shared with the install
 * probe and every spawned libpq client. Verified against Bun 1.4.2 (2026-10-09).
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { SQL } from 'bun';
import { config } from '../../config/config.ts';
import {
	bunSqlTransportOptions,
	pgSocketProblem,
	resolvePgTransport,
} from '../../config/pg_transport.ts';
import { suiteDatabaseRefusal } from '../../config/suite_database.ts';
import { recordPoolWait } from '../api/counters.ts';
import { DedaloError } from '../errors/dedalo_error.ts';
import { DEDICATED_CONNECTIONS_MAX } from './connection_budget.ts';
import { observeStatement } from './query_tap.ts';
import {
	DO_BLOCK,
	doBodyHoldsSessionState,
	setConfigCalls,
	sqlStatements,
	stripLeadingSqlComments,
	stripSqlLiterals,
} from './sql_lexer.ts';

/**
 * Operations posture (audit S2-32/S2-37, PERF-11; config catalog `config.ops` —
 * see engineering/PRODUCTION.md §4). `0` disables each bound; the defaults are
 * the catalog's (src/config/catalog/db.ts — the flip to on-by-default is gated
 * on every legitimately long statement being in the unbounded scope first).
 *  - DB_POOL_MAX: request-pool connections per process (default 10);
 *  - DB_POOL_ACQUIRE_TIMEOUT_MS: max ms a caller may QUEUE for a connection of
 *    either pool before failing with the typed 503 `db.pool_exhausted`;
 *  - DB_STATEMENT_TIMEOUT_MS: the REQUEST pool's startup `statement_timeout`.
 *    A statement stopped by it is the typed 503 `db.statement_timeout`, never
 *    `internal.unexpected`;
 *  - DB_MAINTENANCE_POOL_MAX: the MAINTENANCE pool (default 2) — a separate,
 *    lazily built pool whose startup `statement_timeout` is 0. Work declared
 *    long (`withUnboundedStatements`) runs there, so the request ceiling never
 *    has to be sized around REINDEX/VACUUM/migrations and NO pooled
 *    connection's GUC is ever mutated to lift it. A session
 *    `SET`/`RESET`/`DISCARD` (a `DO` body's included), a `set_config` not
 *    provably transaction-local, or TRANSACTION CONTROL (`COMMIT`, `BEGIN`, …)
 *    in ANY statement of a pooled or transaction-lane text is refused before it
 *    is sent (the WC-055 leak class, and the atomic unit's COMMIT slip); the
 *    residual blind spot — dynamic SQL a FUNCTION EXECUTEs — is ledgered at
 *    refuseSessionState;
 *  - DEDALO_SLOW_QUERY_MS: statements slower than this log a warn line —
 *    applied by db/query_tap.ts on EVERY lane (OPS-13).
 */
const POOL_MAX = config.ops.dbPoolMax;
const ACQUIRE_TIMEOUT_MS = config.ops.dbAcquireTimeoutMs;
const DB_STATEMENT_TIMEOUT_MS = config.ops.dbStatementTimeoutMs;
const MAINTENANCE_POOL_MAX = config.ops.dbMaintenancePoolMax;

/*
 * NO `idleTimeout` on any pool (measured 2026-10-10, Bun 1.4.2): Bun's SQL
 * `idleTimeout` is NOT an idle-CONNECTION reaper — it fires on a connection
 * that has been silent on the wire for N seconds, a statement STILL RUNNING
 * included, and kills it with ERR_POSTGRES_IDLE_TIMEOUT. The maintenance lanes
 * exist precisely for long statements (CREATE INDEX on matrix_time_machine,
 * REINDEX, VACUUM), so the former 30 s value rolled back every index rebuild
 * longer than 30 s. Idle maintenance sockets are bounded by
 * DB_MAINTENANCE_POOL_MAX instead (connection_budget.ts counts them). Gate:
 * test/unit/sql_idle_timeout_canary.test.ts (goes red when Bun changes the
 * semantics, so the choice can be revisited).
 */

/**
 * The maintenance pool's `application_name`, UNIQUE PER PROCESS BOOT: shutdown
 * finds (and cancels) this process's running maintenance statements by it, and
 * an operator reading pg_stat_activity sees which backends are maintenance.
 * The pid alone is not unique — pg_stat_activity is CLUSTER-wide, and in a
 * container every engine and every one-off CLI container is PID 1 — so a
 * per-boot nonce follows it; the shutdown cancel additionally scopes itself to
 * this database and role (cancelMaintenanceStatements). Well under Postgres's
 * 63-byte identifier limit (a longer name would be truncated, not refused).
 */
const BOOT_NONCE = randomUUID().slice(0, 8);
const MAINTENANCE_APPLICATION_NAME = `dedalo_maintenance:${process.pid}:${BOOT_NONCE}`;

/**
 * The NON-TRANSACTIONAL maintenance lane's `application_name` (see
 * getNonTransactionalLane) — deliberately NOT the one the shutdown cancel names.
 */
const NON_TRANSACTIONAL_APPLICATION_NAME = `dedalo_maintenance:nontx:${process.pid}:${BOOT_NONCE}`;

/**
 * Cancel and shutdown bounds: how long one cancel (a stopped maintenance run's,
 * or the shutdown's of every running maintenance statement — sendCancel) may
 * take, and how long the maintenance pool may take to close after the shutdown
 * cancel (seconds — Bun's `close({ timeout })` unit).
 */
const MAINTENANCE_CANCEL_BUDGET_MS = 2000;
/** How long one `pg_xact_status` read (readTransactionStatus) may take. */
const XACT_STATUS_BUDGET_MS = 2000;
const MAINTENANCE_CLOSE_TIMEOUT_S = 5;

/** SQLSTATE query_canceled — a statement_timeout, a pg_cancel_backend, … */
const QUERY_CANCELED = '57014';
/** SQLSTATE lock_not_available — a `lock_timeout` fired. */
const LOCK_NOT_AVAILABLE = '55P03';

/**
 * THE MAINTENANCE LOCK BOUND — the transactional maintenance pool's STARTUP
 * `lock_timeout`, and the data-update unit's default `SET LOCAL lock_timeout`.
 * Lifting the statement ceiling must NOT lift the bound on a lock WAIT: a
 * maintenance statement queued for ACCESS EXCLUSIVE (a store rebuild's TRUNCATE,
 * an ALTER) behind a long reader holds every LATER reader of that table queued
 * behind it — Postgres grants locks in queue order — for as long as the long
 * reader runs. Bounded, the waiter gives up (SQLSTATE 55P03, its transaction
 * rolls back) and the readers behind it proceed. Only the WAIT is bounded; a
 * granted lock is held for the work's whole span. The NON-TRANSACTIONAL lane
 * keeps no bound, and only the WEAK-LOCK class runs on it (REINDEX / CREATE /
 * DROP INDEX CONCURRENTLY, plain VACUUM / ANALYZE — SHARE UPDATE EXCLUSIVE, which
 * no reader or writer conflicts with, queued or granted; and a cancelled
 * CONCURRENTLY build leaves an INVALID index behind). Every other statement
 * `runWithoutStatementTimeout` is handed — `REINDEX TABLE` (SHARE: blocks
 * writers), `VACUUM FULL` (ACCESS EXCLUSIVE: blocks everything) — waits under
 * THIS bound on the maintenance pool (nonTransactionalLockClass).
 */
export const MAINTENANCE_LOCK_TIMEOUT = '5s';

/**
 * PostgreSQL's own `sslmode` vocabulary, which Bun.sql accepts verbatim for
 * `tls`. Spelled out rather than derived from @types/bun so a types change
 * cannot silently widen what the catalog is allowed to hand the driver.
 */
type PostgresSslMode = 'disable' | 'allow' | 'prefer' | 'require' | 'verify-ca' | 'verify-full';

/** The startup parameters that have a value (an undefined one is not sent at all). */
function definedParameters(values: Record<string, string | undefined>): Record<string, string> {
	return Object.fromEntries(
		Object.entries(values).filter((entry): entry is [string, string] => entry[1] !== undefined),
	);
}

/**
 * Build the Bun SQL options for the configured database. `statementTimeoutMs`
 * is the pool's STARTUP `statement_timeout` (sent in the startup packet, so it
 * takes precedence over ALTER ROLE / ALTER DATABASE defaults — `pg_settings.source`
 * reads `client`); `undefined` sends none (the request pool with the ceiling
 * disabled keeps the server's own default). `lockTimeout` likewise is the
 * STARTUP `lock_timeout` — only the transactional maintenance pool sends one
 * (MAINTENANCE_LOCK_TIMEOUT).
 */
function buildSqlOptions(
	max: number,
	statementTimeoutMs: number | undefined,
	applicationName?: string,
	lockTimeout?: string,
): ConstructorParameters<typeof SQL>[0] {
	const { database, user, password, sslMode } = config.db;
	// A TEST process opens only the database the suite preload armed: a `bun test`
	// run outside the repo root never reads bunfig.toml, so DB_NAME would still
	// name the APPLICATION database (src/config/suite_database.ts).
	const suiteRefusal = suiteDatabaseRefusal(database);
	if (suiteRefusal !== null) {
		throw new DedaloError('internal.invariant', {
			message: suiteRefusal,
			coordinates: { database },
		});
	}
	// A relative DB_SOCKET is no socket to libpq (it would read it as a TCP host
	// name): refuse the pool — at import, so the boot itself refuses.
	const socketProblem = pgSocketProblem(config.db.socket);
	if (socketProblem !== null) {
		throw new DedaloError('internal.invariant', {
			message: `Config key 'DB_SOCKET': ${socketProblem} (../private/.env).`,
			coordinates: { key: 'DB_SOCKET' },
		});
	}
	// Startup parameters (sent in the startup packet — they outrank ALTER ROLE /
	// ALTER DATABASE defaults). Omitted entirely when there are none.
	const startupParameters = definedParameters({
		statement_timeout: statementTimeoutMs?.toString(),
		application_name: applicationName,
		lock_timeout: lockTimeout,
	});
	const commonOptions = {
		database,
		username: user,
		password: password || undefined,
		// ALWAYS explicit (2026-08-25, Bun 1.3.9 -> 1.4.0). Bun 1.4's option parser
		// falls back to the ambient `PGSSLMODE`/`PG_SSLMODE` environment variables
		// when `tls` is absent; 1.3.9's did not read them at all. Those variables
		// are commonly exported for psql/pg_dump, so leaving this unset would let
		// the surrounding shell, systemd unit or CI image decide the engine's TLS
		// mode — an input `readEnv`/the typed catalog cannot see, and one the
		// operator has nothing to correct in ../private/.env. Passing the value
		// always means the fallback can never apply. Gate: ws_a_tripwires.
		tls: sslMode as PostgresSslMode,
		max,
		...(Object.keys(startupParameters).length === 0 ? {} : { connection: startupParameters }),
	};
	// DB_SOCKET > a `/` DB_HOST > TCP — the one decision the install probe and
	// every psql/pg_dump share (src/config/pg_transport.ts). A socket transport
	// also sets `hostname` to the socket path so a missing socket fails loudly
	// instead of Bun.sql's silent fallback to TCP localhost.
	return { ...commonOptions, ...bunSqlTransportOptions(resolvePgTransport(config.db)) };
}

/**
 * The single shared REQUEST pool. Module-level by design: a pool is one of the
 * few legitimate pieces of process-wide state (it holds no request identity —
 * see the persistent-runtime discipline, spec §4). Its ceiling is the startup
 * GUC and nothing ever changes it on a connection (see the session-SET refusal).
 */
const pool = new SQL(
	buildSqlOptions(POOL_MAX, DB_STATEMENT_TIMEOUT_MS > 0 ? DB_STATEMENT_TIMEOUT_MS : undefined),
);

/**
 * POOL ACQUIRE GATE (S2-32, PERF-11): Bun's pool queues silently and
 * indefinitely when saturated — an exhausted pool was an invisible, unbounded
 * hang. A semaphore fronts EACH pool with the SAME capacity, so saturation
 * becomes observable (every wait feeds the db_pool_waits counter via
 * recordPoolWait) and bounded (a waiter fails with the typed 503
 * `db.pool_exhausted` after DB_POOL_ACQUIRE_TIMEOUT_MS).
 *
 * THE RULE: every path that takes a Bun connection takes a slot. A pooled
 * statement holds one for its own span; a transaction holds ONE for its whole
 * span (acquired around pool.begin — queries routed onto the ambient tx
 * connection bypass the gate: they consume no extra connection, and gating
 * them would deadlock at capacity); a `sql.reserve()` holds one until its
 * `release()` (before PERF-11 reserve was ungated, so reserved connections
 * could exhaust the pool BEHIND the gate and the next pooled query hung).
 */
interface PoolSlotWaiter {
	grant: () => void;
	cancelled: boolean;
}

interface SlotGate {
	/** Take a slot; rejects with `signal.reason` if `signal` aborts first (the waiter leaves the queue). */
	acquire(signal?: AbortSignal): Promise<void>;
	release(): void;
	stats(): { max: number; inUse: number; waiters: number };
}

/** The typed 503 of a waiter that outlived DB_POOL_ACQUIRE_TIMEOUT_MS. */
function poolExhausted(poolName: 'main' | 'maintenance', max: number): DedaloError {
	return new DedaloError('db.pool_exhausted', {
		message:
			`postgres: no ${poolName} connection became available within ` +
			`DB_POOL_ACQUIRE_TIMEOUT_MS=${ACQUIRE_TIMEOUT_MS}ms (pool max ${max} saturated — ` +
			'S2-32 fail-loud instead of an indefinite hang)',
		coordinates: { pool: poolName, pool_max: max, acquire_timeout_ms: ACQUIRE_TIMEOUT_MS },
	});
}

/** One acquire gate for one pool — both pools share this implementation. */
function makeSlotGate(poolName: 'main' | 'maintenance', max: number): SlotGate {
	let available = max;
	const waiters: PoolSlotWaiter[] = [];
	/** Queue for a slot until granted, timed out (`db.pool_exhausted`) or aborted. */
	const waitForSlot = (signal: AbortSignal | undefined) =>
		new Promise<void>((resolve, reject) => {
			const waiter: PoolSlotWaiter = { grant: resolve, cancelled: false };
			// Leave the queue with `error` — once: a granted, timed-out or aborted
			// waiter is `cancelled`, and a later exit is a no-op.
			const leave = (error: unknown) => {
				if (waiter.cancelled) return;
				waiter.cancelled = true;
				const index = waiters.indexOf(waiter);
				if (index !== -1) waiters.splice(index, 1);
				reject(error);
			};
			const onAbort = () => leave(signal?.reason);
			waiter.grant = () => {
				signal?.removeEventListener('abort', onAbort);
				resolve();
			};
			waiters.push(waiter);
			signal?.addEventListener('abort', onAbort, { once: true });
			if (ACQUIRE_TIMEOUT_MS > 0) {
				const timer = setTimeout(() => leave(poolExhausted(poolName, max)), ACQUIRE_TIMEOUT_MS);
				// Do not keep the process alive for a pending acquire timeout.
				timer.unref?.();
			}
		});
	return {
		async acquire(signal?: AbortSignal): Promise<void> {
			signal?.throwIfAborted();
			if (available > 0) {
				available--;
				return;
			}
			const startedAt = performance.now();
			await waitForSlot(signal);
			recordPoolWait(performance.now() - startedAt);
		},
		release(): void {
			for (;;) {
				const waiter = waiters.shift();
				if (waiter === undefined) {
					available++;
					return;
				}
				if (waiter.cancelled) continue; // timed out — already rejected
				waiter.cancelled = true; // consume: the pending timeout becomes a no-op
				waiter.grant();
				return;
			}
		},
		stats() {
			return { max, inUse: max - available, waiters: waiters.length };
		},
	};
}

/** A pool, its gate, and the statement ceiling its connections carry. */
interface PoolLane {
	readonly name: 'main' | 'maintenance';
	readonly pool: SQL;
	readonly gate: SlotGate;
	/** The startup `statement_timeout` in ms; 0 = unbounded (never mapped). */
	readonly ceilingMs: number;
}

const mainLane: PoolLane = {
	name: 'main',
	pool,
	gate: makeSlotGate('main', POOL_MAX),
	ceilingMs: DB_STATEMENT_TIMEOUT_MS,
};

/**
 * The MAINTENANCE pool, built on first use (most processes — a diffusion
 * runner, a CLI — never run maintenance). Its startup `statement_timeout` is an
 * EXPLICIT '0', which overrides both the catalog ceiling and any ALTER ROLE /
 * ALTER DATABASE default; its startup `lock_timeout` is MAINTENANCE_LOCK_TIMEOUT
 * (the ceiling is lifted, the lock-wait bound never is — a 55P03 that escapes a
 * declared widget action reaches the wire as `db.lock_timeout`,
 * typedMaintenanceLockWait). Process-wide like the request pool; holds no identity.
 */
let maintenanceLane: PoolLane | null = null;

function getMaintenanceLane(): PoolLane {
	maintenanceLane ??= {
		name: 'maintenance',
		pool: new SQL({
			...buildSqlOptions(
				MAINTENANCE_POOL_MAX,
				0,
				MAINTENANCE_APPLICATION_NAME,
				MAINTENANCE_LOCK_TIMEOUT,
			),
		} as ConstructorParameters<typeof SQL>[0]),
		gate: makeSlotGate('maintenance', MAINTENANCE_POOL_MAX),
		ceilingMs: 0,
	};
	return maintenanceLane;
}

/**
 * The maintenance pool's NON-TRANSACTIONAL twin — the lane of
 * runWithoutStatementTimeout's WEAK-LOCK class (REINDEX / CREATE / DROP INDEX
 * CONCURRENTLY, plain VACUUM / ANALYZE — nonTransactionalLockClass). Same GATE as the maintenance pool (DB_MAINTENANCE_POOL_MAX bounds
 * the two lanes' IN-USE connections together — not their open sockets: each Bun
 * pool keeps its own idle connections, so the physical budget counts both,
 * connection_budget.ts), same startup `statement_timeout` 0, its OWN
 * application_name, which the shutdown cancel does NOT name
 * (cancelMaintenanceStatements).
 *
 * WHY A SEPARATE IDENTITY: these statements are not transactions. A cancelled
 * transaction rolls back; a cancelled `REINDEX … CONCURRENTLY` leaves an INVALID
 * `<index>_ccnew` behind — every write keeps maintaining it, and a later
 * `REINDEX TABLE CONCURRENTLY` skips invalid indexes, so it is permanent until
 * someone drops it. Shutdown therefore never cancels them: the bounded close
 * drops the client connection and the server finishes the statement on its own
 * (unless an operator set `client_connection_check_interval`, which aborts it —
 * the optimize door sweeps such leftovers: database_info.ts
 * sweepInvalidConcurrentIndexes).
 */
let nonTransactionalLane: PoolLane | null = null;

function getNonTransactionalLane(): PoolLane {
	nonTransactionalLane ??= {
		name: 'maintenance',
		pool: new SQL({
			...buildSqlOptions(MAINTENANCE_POOL_MAX, 0, NON_TRANSACTIONAL_APPLICATION_NAME),
		} as ConstructorParameters<typeof SQL>[0]),
		gate: getMaintenanceLane().gate,
		ceilingMs: 0,
	};
	return nonTransactionalLane;
}

/**
 * THE UNBOUNDED SCOPE (PERF-11). Work that is legitimately long — a maintenance
 * action, a data migration, a store rebuild — declares it with
 * `withUnboundedStatements`, and every statement it issues (pooled, in a
 * transaction it opens, on a connection it reserves) runs on the maintenance
 * pool. The store is ALS so the lift follows exactly the awaited work and
 * nothing else.
 *
 * EXPIRY (the S2-14 analogue): the store is flipped `expired` when the scope
 * returns, so a continuation LEAKED from inside it (an unawaited promise, a
 * timer, a scheduler first started there) falls back to the bounded request
 * pool instead of inheriting the lift forever. A detached job exits it
 * (runDetachedFromTransaction) — a job that must be unbounded declares its own
 * scope.
 */
interface CeilingLift {
	expired: boolean;
}

const ceilingLiftStore = new AsyncLocalStorage<CeilingLift>();

/** True inside a live (unexpired) `withUnboundedStatements` scope. */
function isUnbounded(): boolean {
	const lift = ceilingLiftStore.getStore();
	return lift !== undefined && !lift.expired;
}

/** The pool a non-transactional statement / BEGIN / reserve goes to right now. */
function currentPoolLane(): PoolLane {
	return isUnbounded() ? getMaintenanceLane() : mainLane;
}

/**
 * Run `work` with the statement ceiling lifted: its pooled statements,
 * transactions and reservations go to the maintenance pool (startup
 * `statement_timeout` 0). No pooled connection's GUC is touched.
 *
 * - Nested inside a live scope → a no-op (the outer scope owns it).
 * - Inside an ambient transaction that is unbounded BY CONSTRUCTION → a no-op:
 *   it was opened on the maintenance lane (in a scope) and its ceiling is still
 *   0, or a recorded `SET LOCAL statement_timeout = 0` is in force.
 * - Inside any other transaction → refused, WHATEVER `DB_STATEMENT_TIMEOUT_MS`
 *   is: a request-pool transaction carries the configured ceiling, and a scope
 *   cannot move it. Keyed on the transaction's LANE, not its ceiling's current
 *   value — under a configured 0 (the suite, and every install until the C4
 *   default flip) a ceiling-keyed check was a silent no-op there, so a caller
 *   entering the scope inside a request transaction passed every test and threw
 *   only in production. Enter the scope BEFORE opening the transaction.
 */
export async function withUnboundedStatements<T>(work: () => Promise<T>): Promise<T> {
	if (isUnbounded()) return work();
	const handle = transactionStore.getStore();
	if (handle !== undefined) {
		if (isUnboundedByConstruction(handle)) return work();
		throw new DedaloError('internal.invariant', {
			message:
				'postgres: withUnboundedStatements was entered inside a transaction that is not unbounded ' +
				'by construction (a request-pool transaction carries the configured statement ceiling) — ' +
				'a scope cannot move its connection. Enter the unbounded scope before opening the ' +
				'transaction.',
			coordinates: { lane: handle.lane, ceiling_ms: handle.ceilingMs ?? 'unknown' },
		});
	}
	const lift: CeilingLift = { expired: false };
	try {
		return await ceilingLiftStore.run(lift, work);
	} finally {
		lift.expired = true;
	}
}

/**
 * A lock wait that ran out MAINTENANCE_LOCK_TIMEOUT (SQLSTATE 55P03, raw) →
 * the typed, retryable 503 `db.lock_timeout`, its SQLSTATE kept as `cause`
 * (sqlStateOf still reads 55P03). Anything else — a DedaloError already typed
 * by its handler included — is returned unchanged. For a door that ran work in
 * `withUnboundedStatements` (the maintenance widget door); the data-update unit
 * retries its own 55P03 (withMaintenanceTransaction) and classifies the rest.
 *
 * WHAT IT MAY CLAIM: only the transaction (or autocommit statement) that WAITED
 * rolled back. A handler is not one transaction — it may have committed earlier
 * units before the wait (a per-file transform, a per-store rebuild) — so the
 * message never says the ACTION changed nothing. A handler whose partial state
 * would be harmful makes its units atomic and reports per unit instead of
 * letting the 55P03 escape (update/transform/engine.ts runDefinitionFile).
 */
export function typedMaintenanceLockWait(error: unknown): unknown {
	if (error instanceof DedaloError || sqlStateOf(error) !== LOCK_NOT_AVAILABLE) return error;
	return new DedaloError('db.lock_timeout', {
		message:
			`postgres: a maintenance statement waited past its ${MAINTENANCE_LOCK_TIMEOUT} lock_timeout ` +
			'for a lock another session holds — the transaction it ran in rolled back; work the ' +
			'action committed before it stands',
		cause: error,
		coordinates: { lane: 'maintenance', lock_timeout: MAINTENANCE_LOCK_TIMEOUT },
	});
}

/** A transaction the scope may join: maintenance lane still at 0, or an explicit `SET LOCAL … = 0`. */
function isUnboundedByConstruction(handle: TransactionHandle): boolean {
	if (handle.ceilingMs !== 0) return false;
	return handle.lane === 'maintenance' || handle.liftedLocally;
}

/**
 * Read-only snapshot of the acquire-gate counters, for status surfaces (the
 * check_config maintenance widget). NOT a request-identity carrier — it exposes
 * only the process-wide pool gauges (max capacity, slots currently held, and
 * queued waiters), never a connection handle or any per-request state.
 * `maintenance` reads zeros until the maintenance pool is first used.
 */
export function getPoolStats(): {
	max: number;
	inUse: number;
	waiters: number;
	maintenance: { max: number; inUse: number; waiters: number };
} {
	return {
		...mainLane.gate.stats(),
		maintenance: maintenanceLane?.gate.stats() ?? {
			max: MAINTENANCE_POOL_MAX,
			inUse: 0,
			waiters: 0,
		},
	};
}

/**
 * The `idleTimeout` each pool was actually built with, read back from the Bun
 * pool's own options (undefined = none). Builds the lazy maintenance lanes. The
 * evidence of the no-idleTimeout rule (see the note above the pool constants):
 * test/unit/sql_idle_timeout_canary.test.ts. Holds no handle, no identity.
 */
export function poolIdleTimeouts(): Record<'main' | 'maintenance' | 'nonTransactional', unknown> {
	const idleOf = (lane: PoolLane): unknown =>
		(lane.pool as unknown as { options?: { idleTimeout?: unknown } }).options?.idleTimeout;
	return {
		main: idleOf(mainLane),
		maintenance: idleOf(getMaintenanceLane()),
		nonTransactional: idleOf(getNonTransactionalLane()),
	};
}

/**
 * The SQLSTATE of a driver error, or undefined. Bun's PostgresError carries it
 * in `errno` (`code` is Bun's own ERR_POSTGRES_*); a wrapping error (a typed
 * DedaloError) keeps the original as `cause`, so the chain is walked.
 */
export function sqlStateOf(error: unknown): string | undefined {
	let current: unknown = error;
	for (let depth = 0; depth < 5; depth++) {
		const state = ownSqlState(current);
		if (state !== undefined) return state;
		current = (current as { cause?: unknown } | null | undefined)?.cause;
	}
	return undefined;
}

/** The SQLSTATE on this error object itself (not its cause). */
function ownSqlState(value: unknown): string | undefined {
	if (value === null || typeof value !== 'object') return undefined;
	const { errno, code } = value as { errno?: unknown; code?: unknown };
	return [errno, code].find(
		(candidate): candidate is string =>
			typeof candidate === 'string' && /^[0-9A-Z]{5}$/.test(candidate),
	);
}

/**
 * Run `apply`, retrying after each delay while it fails on a lock timeout
 * (SQLSTATE 55P03). Any other failure — and a lock timeout after the last delay
 * — propagates. `apply` must be a WHOLE unit (a transaction): a retry re-runs
 * it from the start. An aborted `signal` stops the retrying.
 */
export async function retryOnLockNotAvailable<T>(
	apply: () => Promise<T>,
	delaysMs: readonly number[],
	onRetry?: (attempt: number, delayMs: number, error: unknown) => void,
	signal?: AbortSignal,
): Promise<T> {
	for (let attempt = 0; ; attempt += 1) {
		try {
			return await apply();
		} catch (error) {
			const delay = delaysMs[attempt];
			if (sqlStateOf(error) !== LOCK_NOT_AVAILABLE || delay === undefined || signal?.aborted) {
				throw error;
			}
			onRetry?.(attempt + 1, delay, error);
			// The backoff itself is abortable: a stop, deadline or shutdown during
			// it settles NOW (with `signal.reason`), not after up to the longest
			// delay — a run sleeping past the shutdown drain would otherwise meet
			// a closed pool and read as 'unknown' instead of 'aborted'.
			await abortableSleep(delay, signal);
			signal?.throwIfAborted();
		}
	}
}

/** Sleep `delayMs`, resolving early when `signal` aborts (the caller then throws). */
function abortableSleep(delayMs: number, signal: AbortSignal | undefined): Promise<void> {
	if (signal === undefined) return Bun.sleep(delayMs);
	if (signal.aborted) return Promise.resolve();
	return new Promise<void>((resolve) => {
		const wake = () => {
			clearTimeout(timer);
			signal.removeEventListener('abort', wake);
			resolve();
		};
		const timer = setTimeout(wake, delayMs);
		signal.addEventListener('abort', wake, { once: true });
	});
}

/**
 * A 57014 that IS the lane's statement ceiling → the typed 503. Mapped only
 * when all four hold: the SQLSTATE is 57014, the ceiling is KNOWN (not null)
 * and positive, and the statement ran at least that long. Everything else — an
 * operator's pg_cancel_backend, the OPS-6 abort cancel, a cancel that landed
 * before the ceiling — is returned raw.
 */
function typedFailure(
	error: unknown,
	lane: 'pooled' | 'transaction',
	ceilingMs: number | null,
	elapsedMs: number,
): unknown {
	if (ceilingMs === null || ceilingMs <= 0) return error;
	if (sqlStateOf(error) !== QUERY_CANCELED || elapsedMs < ceilingMs) return error;
	return new DedaloError('db.statement_timeout', {
		message: `postgres: a ${lane} statement ran past its ${ceilingMs}ms statement ceiling`,
		cause: error,
		coordinates: { lane, ceiling_ms: ceilingMs },
	});
}

/**
 * The text without its leading whitespace and comments, which never change what
 * a statement is. Trimmed at the START too: every rule reading the result is
 * anchored at `^`, and a `/* x *\/ SET …` left as ` SET …` slipped past them.
 */
function stripLeadingComments(text: string): string {
	// The ONE lexer (db/sql_lexer.ts): a nested `/* a /* b *\/ c *\/` is one
	// comment to Postgres, and a flat stripper that disagreed left `c *\/ SET …`
	// — not `^SET` — so a session SET behind it passed the refusal.
	return stripLeadingSqlComments(text);
}

/**
 * WHAT A POOLED OR TRANSACTION-LANE TEXT MAY NOT DO, refused before it is sent,
 * in ANY statement of the text (a `SELECT 1; SET statement_timeout = 0` leaks
 * exactly like a bare `SET`): a text holding a `;` is split into its statements
 * by the shared lexer (db/sql_lexer.ts — a `;` inside a literal splits nothing).
 *
 * SESSION STATE (the WC-055 class): a plain `SET`/`RESET`/`DISCARD` outlives the
 * caller's span on a pooled connection — the next request handed that
 * connection inherits it. So does one inside a `DO` body (PL/pgSQL executed
 * NOW, read RAW by the shared rule — `DO $$BEGIN SET … END$$`, or
 * `EXECUTE 'SET …'`), and a `set_config` that is not provably
 * transaction-local: only a literal `true` third argument is (a `false`, an
 * expression, a bound `$3` are refused — sql_lexer.setConfigCalls). `SET LOCAL`,
 * `SET TRANSACTION` and `SET CONSTRAINTS` die with the transaction and are
 * allowed.
 *
 * TRANSACTION CONTROL (`BEGIN`, `START TRANSACTION`, `COMMIT`, `END`,
 * `ROLLBACK` — never `ROLLBACK TO`, `ABORT`, `PREPARE TRANSACTION`, and the
 * `… PREPARED` forms): on the transaction lane a `COMMIT` ends the unit
 * mid-way (every statement after it autocommits, and the recorder's ceiling,
 * savepoints and commit-only queue describe a transaction that no longer
 * exists); on the pooled lane a `BEGIN` hands the next caller a connection
 * inside someone else's transaction. `SAVEPOINT` / `RELEASE` / `ROLLBACK TO`
 * stay allowed (the recorder tracks them). A `DO` or procedure cannot COMMIT
 * inside a transaction block (Postgres refuses it), so the statement-leading
 * rule is complete for the transaction lane.
 *
 * The reserved lane is exempt: it is caller-owned (install/db/migrate.ts's
 * online run SETs and RESETs on it). Residual blind spot (ledgered): dynamic SQL
 * a FUNCTION (not a DO body) EXECUTEs is invisible to any lexer.
 */
const SESSION_STATE_STATEMENT = /^(SET(?!\s+(LOCAL|TRANSACTION|CONSTRAINTS)\b)|RESET|DISCARD)\b/i;
const TRANSACTION_CONTROL_STATEMENT =
	/^(BEGIN|START\s+TRANSACTION|COMMIT|END|ABORT|ROLLBACK(?!\s+(?:(?:WORK|TRANSACTION)\s+)?TO\b)|PREPARE\s+TRANSACTION)\b/i;

const SESSION_STATE_REFUSAL =
	'postgres: a session-level SET/RESET/DISCARD (or a set_config that is not transaction-local) ' +
	'was issued on a pooled or transaction connection — it would outlive this caller on a ' +
	'connection the pool hands to the next request. Use SET LOCAL inside withTransaction, or ' +
	'withUnboundedStatements to lift the statement ceiling.';
const TRANSACTION_CONTROL_REFUSAL =
	'postgres: transaction control (BEGIN/COMMIT/ROLLBACK/END/ABORT/PREPARE TRANSACTION) was ' +
	"issued on a pooled or transaction connection — it would end the caller's transaction " +
	'mid-unit, or leave a pooled connection inside one. Use withTransaction (and SAVEPOINT / ' +
	'ROLLBACK TO SAVEPOINT inside it).';

/** One statement of a text as the refusal reads it: as written, and its stripped lead. */
interface StatementView {
	raw: string;
	lead: string;
}

/** The statements of `text`: one without a `;` (the hot path), else the lexer's split. */
function statementViews(text: string): StatementView[] {
	if (!text.includes(';')) return [{ raw: text, lead: stripLeadingComments(text) }];
	const statements = sqlStatements(text);
	// An unterminated literal: Postgres refuses the text anyway — judge the raw split.
	if (statements === null) return text.split(';').map((part) => ({ raw: part, lead: part.trim() }));
	return statements.map(({ raw, stripped }) => ({ raw, lead: stripped }));
}

/** Why one statement is refused, or null. */
function statementRefusal({ raw, lead }: StatementView): string | null {
	if (SESSION_STATE_STATEMENT.test(lead)) return SESSION_STATE_REFUSAL;
	if (TRANSACTION_CONTROL_STATEMENT.test(lead)) return TRANSACTION_CONTROL_REFUSAL;
	if (DO_BLOCK.test(lead) && doBodyHoldsSessionState(raw)) return SESSION_STATE_REFUSAL;
	return null;
}

/** Whether `text` calls a set_config that is not provably transaction-local, outside a literal. */
function holdsSessionSetConfig(text: string): boolean {
	if (!/set_config/i.test(text)) return false;
	return setConfigCalls(stripSqlLiterals(text, 'unquote') ?? text).sessionScoped > 0;
}

function refuseSessionState(text: string): void {
	const refusal = holdsSessionSetConfig(text)
		? SESSION_STATE_REFUSAL
		: (statementViews(text)
				.map(statementRefusal)
				.find((reason) => reason !== null) ?? null);
	if (refusal === null) return;
	throw new DedaloError('internal.invariant', { message: refusal });
}

/** `SET LOCAL statement_timeout {=|TO} <value>` — the one directive the recorder parses. */
const SET_LOCAL_STATEMENT_TIMEOUT =
	/^SET\s+LOCAL\s+statement_timeout\s*(?:=|\s+TO\s+)\s*([\s\S]*?)\s*;?\s*$/i;
/** Anything else that may change statement_timeout — the ceiling becomes UNKNOWN (set_config: always). */
const OTHER_STATEMENT_TIMEOUT_CHANGE = /\b(SET|RESET)\b[\s\S]*\bstatement_timeout\b/i;
const TIMEOUT_UNIT_MS: Readonly<Record<string, number>> = {
	us: 0.001,
	ms: 1,
	s: 1000,
	min: 60_000,
	h: 3_600_000,
	d: 86_400_000,
};

/**
 * THE RECORDER: what a transaction-lane statement did to the transaction's
 * statement ceiling. `undefined` = nothing; a number = the new ceiling (ms);
 * `null` = changed in a way we cannot parse (unknown — never mapped). Exported
 * for its own gate (the truth table in statement_ceiling_scope_native).
 */
export function parseStatementTimeoutDirective(
	text: string,
	poolCeilingMs: number,
): number | null | undefined {
	const directive = readStatementTimeoutDirective(text);
	return directive === 'default' ? poolCeilingMs : directive;
}

/**
 * The directive as written: `undefined` = none, `null` = unknown, `'default'` =
 * `SET LOCAL statement_timeout = DEFAULT` (the lane's own ceiling), else ms.
 */
function readStatementTimeoutDirective(text: string): number | null | 'default' | undefined {
	// ANY set_config (only a transaction-local one gets this far): the setting it
	// names may be an expression (`lower('Statement_Timeout')`, a concatenation),
	// so the ceiling is UNKNOWN — never a guess that types the next 57014.
	if (/set_config/i.test(text)) return null;
	if (!/statement_timeout/i.test(text)) return undefined;
	const body = stripLeadingComments(text);
	const directive = SET_LOCAL_STATEMENT_TIMEOUT.exec(body);
	if (directive === null) return OTHER_STATEMENT_TIMEOUT_CHANGE.test(body) ? null : undefined;
	return parseTimeoutValue((directive[1] ?? '').trim());
}

/** A `statement_timeout` value in ms: an integer (ms), a quoted `'<n><unit>'`, or DEFAULT; null = unparseable. */
function parseTimeoutValue(value: string): number | null | 'default' {
	if (/^DEFAULT$/i.test(value)) return 'default';
	const parsed = /^'?\s*(\d+(?:\.\d+)?)\s*(us|ms|s|min|h|d)?\s*'?$/i.exec(value);
	if (parsed === null) return null;
	const unit = TIMEOUT_UNIT_MS[(parsed[2] ?? 'ms').toLowerCase()] ?? 1;
	return Math.round(Number(parsed[1]) * unit);
}

/**
 * Run one statement on a POOL: the acquire gate, then the query tap (timing +
 * the DEDALO_SLOW_QUERY_MS log + the statement count, S2-37/OPS-13), then the
 * 57014 typing. The gate is what this adds over the transaction lane — that
 * lane holds its slot for the transaction's span. `describeQuery` is lazy.
 */
async function runOnPool<T>(
	lane: PoolLane,
	execute: (target: SQL) => Promise<T>,
	describeQuery: () => string,
): Promise<T> {
	await lane.gate.acquire();
	try {
		const startedAt = performance.now();
		try {
			return await observeStatement('pooled', describeQuery, () => execute(lane.pool));
		} catch (error) {
			throw typedFailure(error, 'pooled', lane.ceilingMs, performance.now() - startedAt);
		}
	} finally {
		lane.gate.release();
	}
}

/** A savepoint name: an identifier (case-folded) or a quoted identifier (verbatim). */
const SAVEPOINT_NAME = '(?:"((?:[^"]|"")+)"|([A-Za-z_][A-Za-z0-9_$]*))';
const SAVEPOINT_STATEMENT = new RegExp(String.raw`^SAVEPOINT\s+${SAVEPOINT_NAME}\s*;?\s*$`, 'i');
const RELEASE_STATEMENT = new RegExp(
	String.raw`^RELEASE\s+(?:SAVEPOINT\s+)?${SAVEPOINT_NAME}\s*;?\s*$`,
	'i',
);
const ROLLBACK_TO_STATEMENT = new RegExp(
	String.raw`^ROLLBACK\s+(?:WORK\s+|TRANSACTION\s+)?TO\s+(?:SAVEPOINT\s+)?${SAVEPOINT_NAME}\s*;?\s*$`,
	'i',
);
/** Any ROLLBACK TO (possibly inside a multi-statement text) — the fallback. */
const ANY_ROLLBACK_TO = /\bROLLBACK\s+(?:WORK\s+|TRANSACTION\s+)?TO\b/i;

/** The canonical name out of a SAVEPOINT_NAME match (groups 1/2). */
function savepointName(match: RegExpExecArray): string {
	const quoted = match[1];
	return quoted !== undefined ? quoted.replaceAll('""', '"') : (match[2] ?? '').toLowerCase();
}

/** The newest savepoint called `name` on the handle's stack, or -1. */
function savepointIndex(handle: TransactionHandle, name: string): number {
	for (let index = handle.savepoints.length - 1; index >= 0; index--) {
		if (handle.savepoints[index]?.name === name) return index;
	}
	return -1;
}

/** SAVEPOINT: push the ceiling in force now. */
function pushSavepoint(handle: TransactionHandle, name: string): void {
	handle.savepoints.push({
		name,
		ceilingMs: handle.ceilingMs,
		liftedLocally: handle.liftedLocally,
		commitActions: handle.commitQueue.actions.length,
	});
}

/** RELEASE: pop the savepoint and every newer one (a `SET LOCAL` survives it). */
function releaseSavepoint(handle: TransactionHandle, name: string): void {
	const index = savepointIndex(handle, name);
	if (index !== -1) handle.savepoints.length = index;
}

/**
 * ROLLBACK TO: restore the savepoint's ceiling, and DROP every commit-only
 * action queued after it (W12: a commit action must never fire for state the
 * rollback undid); newer savepoints go, it stays. Unseen → unpairedRollbackTo.
 */
function rollbackToSavepoint(handle: TransactionHandle, name: string): void {
	const index = savepointIndex(handle, name);
	const savepoint = handle.savepoints[index];
	if (savepoint === undefined) {
		unpairedRollbackTo(handle);
		return;
	}
	handle.ceilingMs = savepoint.ceilingMs;
	handle.liftedLocally = savepoint.liftedLocally;
	handle.commitQueue.actions.length = Math.min(
		handle.commitQueue.actions.length,
		savepoint.commitActions,
	);
	handle.savepoints.length = index + 1;
}

/**
 * A ROLLBACK TO the recorder cannot pair with a savepoint it saw: the ceiling is
 * UNKNOWN (null — never mapped), and which commit-only actions the rollback
 * undid is unknown too — the transaction is marked, and withTransaction refuses
 * to COMMIT it while any commit action is queued (rather than fire one for state
 * that may not exist).
 */
function unpairedRollbackTo(handle: TransactionHandle): void {
	handle.ceilingMs = null;
	handle.liftedLocally = false;
	handle.commitQueueUncertain = true;
}

const SAVEPOINT_HANDLERS: readonly [RegExp, (handle: TransactionHandle, name: string) => void][] = [
	[SAVEPOINT_STATEMENT, pushSavepoint],
	[RELEASE_STATEMENT, releaseSavepoint],
	[ROLLBACK_TO_STATEMENT, rollbackToSavepoint],
];

/**
 * SAVEPOINT bookkeeping for the recorder. `ROLLBACK TO SAVEPOINT` reverts every
 * `SET LOCAL` issued after the savepoint (Postgres semantics), so the recorded
 * ceiling must revert with it: SAVEPOINT pushes the current ceiling, RELEASE
 * pops (a `SET LOCAL` survives a RELEASE), ROLLBACK TO restores the snapshot
 * (the savepoint itself survives). The COMMIT-ONLY queue follows the same
 * stack: a ROLLBACK TO drops the actions queued after its savepoint, a RELEASE
 * keeps them. A ROLLBACK TO the recorder cannot pair with a savepoint it saw
 * makes the ceiling UNKNOWN (null — never mapped) and the queue uncertain
 * (unpairedRollbackTo). The deferred (cache-clear) queue is NOT truncated: it
 * replays on rollback by design, and over-invalidation is harmless.
 */
function recordSavepointStatement(handle: TransactionHandle, text: string): void {
	if (!/\b(SAVEPOINT|RELEASE|ROLLBACK)\b/i.test(text)) return;
	const body = stripLeadingComments(text).trim();
	for (const [pattern, apply] of SAVEPOINT_HANDLERS) {
		const match = pattern.exec(body);
		if (match !== null) {
			apply(handle, savepointName(match));
			return;
		}
	}
	if (ANY_ROLLBACK_TO.test(text)) unpairedRollbackTo(handle);
}

/**
 * The transaction lane's wrapper around one already-tapped statement: time it,
 * type a fired ceiling (against the handle's CURRENT ceiling), and feed the
 * recorder (savepoints, then `statement_timeout` directives) once the statement
 * has succeeded. `run` carries the observeStatement call, so the tap is visible
 * at the trap's call site (query_tap_tripwire).
 */
async function onTransactionLane<T>(
	handle: TransactionHandle,
	text: string,
	run: () => Promise<T>,
): Promise<T> {
	// STICKY ABORT: the unit's one-shot cancel reaches only the statement running
	// when it fires; this door keeps any LATER statement from being sent at all.
	handle.signal?.throwIfAborted();
	const startedAt = performance.now();
	try {
		const result = await run();
		recordSavepointStatement(handle, text);
		recordTimeoutDirective(handle, text);
		return result;
	} catch (error) {
		throw typedFailure(error, 'transaction', handle.ceilingMs, performance.now() - startedAt);
	}
}

/** Feed a statement's `statement_timeout` directive (if any) into the handle. */
function recordTimeoutDirective(handle: TransactionHandle, text: string): void {
	const directive = readStatementTimeoutDirective(text);
	if (directive === undefined) return;
	handle.ceilingMs = directive === 'default' ? handle.laneCeilingMs : directive;
	// Only an EXPLICIT 0 lifts a request-lane transaction for the scope: DEFAULT
	// restores the configured ceiling, whatever it reads today.
	handle.liftedLocally = directive === 0;
}

/**
 * Which lock class a runWithoutStatementTimeout text is (OPS-6/PERF-11 review).
 *
 * 'weak' — EVERY statement is one whose locks are at most SHARE UPDATE EXCLUSIVE
 * (no reader's ACCESS SHARE nor writer's ROW EXCLUSIVE conflicts with it, queued
 * or granted, so its wait stalls nobody): `REINDEX … CONCURRENTLY`, `CREATE
 * [UNIQUE] INDEX CONCURRENTLY`, `DROP INDEX CONCURRENTLY`, `ANALYZE`, and a
 * `VACUUM` without FULL. These run UNBOUNDED on the non-transactional lane —
 * a lock_timeout firing mid-CONCURRENTLY leaves an INVALID index behind.
 *
 * 'strong' — anything else: `REINDEX TABLE`/`INDEX` (SHARE — blocks writers),
 * `VACUUM FULL` (ACCESS EXCLUSIVE — blocks everything), a CLUSTER, a text the
 * lexer cannot split. Queued behind a long reader (a pg_dump holds ACCESS SHARE
 * on every table for hours) such a statement holds every LATER conflicting
 * request queued behind it — PostgreSQL grants locks in queue order — so it
 * waits under MAINTENANCE_LOCK_TIMEOUT. The rule is an ALLOWLIST of the weak
 * forms: an unrecognised statement is bounded, never the reverse. Literals,
 * comments and quoted identifiers are blanked first (a table called "full" is
 * no FULL option). A `FULL` anywhere in a VACUUM (even `(FULL false)`) bounds it.
 */
export function nonTransactionalLockClass(text: string): 'weak' | 'strong' {
	const statements = sqlStatements(text, 'blank');
	if (statements === null || statements.length === 0) return 'strong';
	return statements.every(({ stripped }) => isWeakLockStatement(stripped)) ? 'weak' : 'strong';
}

/** The weak-lock forms (see nonTransactionalLockClass), on a STRIPPED statement. */
const WEAK_LOCK_STATEMENTS: readonly RegExp[] = [
	/^ANALY[SZ]E\b/i,
	/^REINDEX\b(?:\s*\([^)]*\))?\s*(?:TABLE|INDEX|SCHEMA|DATABASE|SYSTEM)\s+CONCURRENTLY\b/i,
	/^REINDEX\s*\([^)]*\bCONCURRENTLY\b(?!\s+(?:false|off|0)\b)[^)]*\)/i,
	/^CREATE\s+(?:UNIQUE\s+)?INDEX\s+CONCURRENTLY\b/i,
	/^DROP\s+INDEX\s+CONCURRENTLY\b/i,
];

function isWeakLockStatement(stripped: string): boolean {
	if (/^VACUUM\b/i.test(stripped)) return !/\bFULL\b/i.test(stripped);
	return WEAK_LOCK_STATEMENTS.some((rule) => rule.test(stripped));
}

/** The default lock-retry schedule of a strong-lock statement (withMaintenanceTransaction's). */
const STRONG_LOCK_RETRY_DELAYS_MS: readonly number[] = [1000, 2000, 4000, 8000];

/**
 * Run ONE deliberately long, NON-TRANSACTIONAL maintenance statement with no
 * statement ceiling — REINDEX / VACUUM / DROP INDEX CONCURRENTLY on a
 * production-scale table (WC-055). Routed by its lock class
 * (nonTransactionalLockClass):
 *  - WEAK (CONCURRENTLY, plain VACUUM / ANALYZE): the non-transactional lane
 *    (getNonTransactionalLane: startup `statement_timeout` 0, NO lock bound, the
 *    maintenance gate, and an identity the shutdown cancel spares — a cancelled
 *    CONCURRENTLY build is not rolled back, it leaves an invalid index behind);
 *  - STRONG (`REINDEX TABLE`, `VACUUM FULL`, …): the maintenance pool as an
 *    autocommit statement — startup `statement_timeout` 0 AND its startup
 *    `lock_timeout` MAINTENANCE_LOCK_TIMEOUT. A lock wait past the bound gives
 *    up (nothing applied: these statements are atomic), is retried after each
 *    of `options.lockRetryDelaysMs` (default 1s/2s/4s/8s — no lock is queued
 *    during a delay, so the readers behind it run), and escapes as the typed
 *    503 `db.lock_timeout`. Shutdown cancels it like any maintenance statement;
 *    it rolls back cleanly.
 *  Gate: test/unit/maintenance_nontx_lock_bound_native.test.ts.
 *
 * Before PERF-11 this cleared the GUC with a session `SET` on a reserved
 * connection and `RESET` it before release — correct only as long as every
 * path remembered the RESET. Now no GUC is ever mutated: the statement simply
 * runs on a connection that was born unbounded.
 *
 * Refused inside a transaction: its statements (VACUUM, CONCURRENTLY) cannot
 * run in one. NOT for anything request-driven: a statement that can run
 * unbounded on demand is exactly what the ceiling exists to prevent.
 */
export async function runWithoutStatementTimeout(
	statement: string,
	params: (string | number | null)[] = [],
	options: { lockRetryDelaysMs?: readonly number[] } = {},
): Promise<unknown[]> {
	if (transactionStore.getStore() !== undefined) {
		throw new DedaloError('internal.invariant', {
			message:
				'postgres: runWithoutStatementTimeout was called inside a transaction — its statements ' +
				'(VACUUM, CONCURRENTLY) cannot run in one. Call it outside the transaction.',
		});
	}
	refuseSessionState(statement);
	const run = (lane: PoolLane) =>
		runOnPool(
			lane,
			async (target) => (await target.unsafe(statement, params)) as unknown[],
			describeText(statement),
		);
	if (nonTransactionalLockClass(statement) === 'weak') return run(getNonTransactionalLane());
	return retryOnLockNotAvailable(
		() => run(getMaintenanceLane()),
		options.lockRetryDelaysMs ?? STRONG_LOCK_RETRY_DELAYS_MS,
		(attempt, delayMs) => {
			console.warn(
				`[maintenance] strong-lock statement waited past its lock bound (attempt ${attempt}); retrying in ${delayMs}ms`,
			);
		},
	).catch((error: unknown) => {
		throw typedMaintenanceLockWait(error);
	});
}

/**
 * The ambient transaction connection for the current async context, if any.
 *
 * PHP runs each request on ONE pinned connection, so a value written earlier in
 * a request is visible to a read later in the SAME request. Bun's pool hands a
 * possibly-different connection to every query, so an in-flight transaction's
 * uncommitted writes would be invisible to a subsequent pooled read (they live
 * on the reserved tx connection). We reproduce PHP's one-connection semantics
 * with AsyncLocalStorage: `withTransaction` stashes the reserved tx handle here,
 * and the exported `sql` proxy (below) transparently routes every query to it.
 * Nothing outside this module reads the store — request identity never leaks
 * into it (spec §4); it holds a connection handle for the current tx plus the
 * tx-scoped memo (getTransactionMemo), never identity.
 */
interface TransactionHandle {
	executor: SQL;
	/**
	 * S2-14 fail-loud expiry: flipped in withTransaction's finally, AFTER the
	 * transaction settles. A continuation leaked from inside the callback (an
	 * unawaited promise, a setTimeout — the ALS store propagates to all of
	 * them) that issues a query later would otherwise run on the RELEASED tx
	 * connection with timing-dependent results (reproduced: a thrown statement
	 * that still auto-committed). With the flag set, activeTransaction() throws
	 * deterministically and the query is never sent.
	 */
	expired: boolean;
	/**
	 * The statement ceiling this transaction's statements run under (ms): the
	 * pool's at BEGIN (0 on the maintenance pool), then whatever a recorded
	 * `SET LOCAL statement_timeout` made it. `null` = changed in a way the
	 * recorder could not parse — unknown, so a 57014 is never mapped.
	 */
	ceilingMs: number | null;
	/** The pool lane's own ceiling — what `SET LOCAL statement_timeout = DEFAULT` restores. */
	readonly laneCeilingMs: number;
	/** The lane the transaction BEGAN on (withUnboundedStatements keys its refusal on it). */
	readonly lane: PoolLane['name'];
	/** A recorded `SET LOCAL statement_timeout = 0` (explicit — never DEFAULT) is in force. */
	liftedLocally: boolean;
	/**
	 * Savepoints the recorder saw, oldest first, each with the ceiling in force
	 * when it was taken and the commit-only queue's length then — `ROLLBACK TO`
	 * restores the first and truncates the queue to the second (see
	 * recordSavepointStatement).
	 */
	savepoints: {
		name: string;
		ceilingMs: number | null;
		liftedLocally: boolean;
		commitActions: number;
	}[];
	/** This transaction's commit-only queue (see commitActionStore). */
	readonly commitQueue: CommitActionQueue;
	/** An unpaired ROLLBACK TO ran: which commit actions it undid is unknown. */
	commitQueueUncertain: boolean;
	/**
	 * The caller's abort signal (the maintenance unit's): once it fires, NO new
	 * statement is sent on this transaction — a script that never polls it is
	 * stopped at its next statement, not after it.
	 */
	readonly signal: AbortSignal | undefined;
	/**
	 * Transaction-scoped memo (see getTransactionMemo): derived-data snapshots
	 * whose lifetime is exactly this transaction's span. Lazily created; dies
	 * with the handle. Keyed by module-owned symbols so entries can never
	 * collide across subsystems.
	 */
	memo?: Map<symbol, unknown>;
}

const transactionStore = new AsyncLocalStorage<TransactionHandle>();

/**
 * Deferred post-transaction actions for the current async context (S1-14
 * hardening). Shared-cache clears fired INSIDE a transaction are unsafe on
 * both edges: a concurrent request could repopulate the cleared entry from
 * committed-but-about-to-be-stale state before COMMIT, and any future in-tx
 * cached read of tx-written rows would leak uncommitted data process-wide.
 * Cache owners therefore queue their clears here (via `deferPostTransaction`)
 * and `withTransaction` replays the queue in its finally — after COMMIT and
 * after ROLLBACK alike (over-invalidation is harmless; a skipped replay is
 * not).
 */
interface DeferredActionQueue {
	actions: Array<() => void>;
	/** True after the queue has been replayed — late pushes must run inline. */
	closed: boolean;
}

const deferredActionStore = new AsyncLocalStorage<DeferredActionQueue>();

/**
 * COMMIT-ONLY actions for the current async context (W12, 2026-08-02 — the
 * observer-cascade prerequisite). The deferred queue above is the WRONG lane
 * for side effects that must track the transaction's OUTCOME: it replays on
 * ROLLBACK too (correct for cache clears, catastrophic for mirror writes),
 * its actions are `() => void` (an async action's rejection would be an
 * unhandled promise), and callers cannot tell the two intents apart. This
 * SEPARATE lane runs its actions ONLY after a successful COMMIT, awaits each
 * one (async supported; a rejection is logged and the remainder still
 * drains), and drains in withTransaction's finally OUTSIDE the
 * transactionStore context — so the actions run with NO ambient transaction
 * (they may open their own via withTransaction) and after the pool slot is
 * released. On ROLLBACK the queue is discarded wholesale.
 */
interface CommitActionQueue {
	actions: Array<() => void | Promise<void>>;
	/** True once the queue's fate is decided — late registrations must be run
	 * by the caller itself (registerCommitAction returns false). */
	closed: boolean;
}

const commitActionStore = new AsyncLocalStorage<CommitActionQueue>();

/**
 * Queue `action` to run ONLY IF the ambient transaction COMMITS. Returns
 * false when no transaction is active (or the ambient queue already drained —
 * a leaked continuation): the caller then owns the action and must run it
 * itself. Contrast deferPostTransaction, which replays on rollback too and is
 * for idempotent cache invalidation only — never for writes.
 */
export function registerCommitAction(action: () => void | Promise<void>): boolean {
	const queue = commitActionStore.getStore();
	if (queue === undefined || queue.closed) return false;
	queue.actions.push(action);
	return true;
}

/** The ambient tx handle, undefined when none; THROWS when it has expired (S2-14). */
function activeTransaction(): TransactionHandle | undefined {
	const handle = transactionStore.getStore();
	if (handle === undefined) return undefined;
	if (handle.expired) {
		throw new DedaloError('internal.invariant', {
			message:
				'postgres: ambient transaction handle has EXPIRED — a continuation leaked past ' +
				'withTransaction (unawaited promise/timer started inside the callback) tried to ' +
				'query after COMMIT/ROLLBACK. The query was NOT sent. Await every async operation ' +
				'inside the transaction callback (S2-14).',
		});
	}
	return handle;
}

/**
 * Queue `action` to run after the ambient transaction settles (COMMIT or
 * ROLLBACK). Returns false when no transaction is active OR the ambient
 * queue has already been replayed (a leaked continuation) — the caller must
 * then run the action itself. Actions must be synchronous and must not throw
 * for correctness (a throw is logged and swallowed so the remaining queue
 * still drains).
 */
export function deferPostTransaction(action: () => void): boolean {
	const queue = deferredActionStore.getStore();
	if (queue === undefined || queue.closed) return false;
	queue.actions.push(action);
	return true;
}

/** The first literal chunk of a tagged-template call ('' for a non-template call). */
function templateText(argumentsList: unknown[]): string {
	return String(
		(argumentsList[0] as { raw?: readonly string[] } | undefined)?.raw?.join('?') ?? '',
	);
}

/**
 * The database handle used everywhere in the codebase.
 *
 * It is a Proxy over the pool that, on EVERY use, resolves to the ambient
 * transaction connection when one is active (see transactionStore), else to
 * the current POOL LANE — the request pool, or the maintenance pool inside
 * `withUnboundedStatements`. This makes every existing call site — the
 * tagged-template form `sql`...`` and the `sql.unsafe(...)` form —
 * transparently transactional inside `withTransaction` and transparently
 * unbounded inside the scope, with zero signature changes. The `apply` trap
 * handles the tagged-template call; the `get` trap forwards `.unsafe`,
 * `.begin`, etc. (bound to the live executor so `this` is correct).
 */
export const sql: SQL = new Proxy(pool, {
	apply(_target, _thisArg, argumentsList) {
		// Tagged-template call: sql`SELECT ... ${value}`.
		const handle = activeTransaction();
		const text = templateText(argumentsList);
		const describe = describeTemplate(argumentsList);
		refuseSessionState(text);
		if (handle !== undefined) {
			// Ambient tx connection: already holds its pool slot — no gate. It IS
			// measured though (OPS-13): before the tap this branch returned the
			// executor's lazy query object raw and untimed, which is why the whole
			// write path was invisible to DEDALO_SLOW_QUERY_MS. Awaiting the query
			// here changes nothing for callers — every call site awaits the result
			// and none chains a lazy-query method (.simple()/.values()/.execute()/
			// .raw()) on it, pinned by query_tap_tripwire.
			const executor = handle.executor;
			return onTransactionLane(handle, text, () =>
				observeStatement('transaction', describe, async () =>
					(executor as unknown as (...args: unknown[]) => Promise<unknown>)(...argumentsList),
				),
			);
		}
		return runOnPool(
			currentPoolLane(),
			async (target) =>
				(target as unknown as (...args: unknown[]) => Promise<unknown>)(...argumentsList),
			describe,
		);
	},
	get(_target, property, _receiver) {
		const handle = activeTransaction();
		if (property === 'unsafe') {
			if (handle === undefined) {
				const lane = currentPoolLane();
				return (query: string, params?: unknown[]) => {
					refuseSessionState(query);
					return runOnPool(
						lane,
						async (target) => target.unsafe(query, params as never),
						describeText(query),
					);
				};
			}
			const executor = handle.executor;
			return (query: string, params?: unknown[]) => {
				refuseSessionState(query);
				return onTransactionLane(handle, query, () =>
					observeStatement('transaction', describeText(query), async () =>
						executor.unsafe(query, params as never),
					),
				);
			};
		}
		return forwardProperty(handle, property);
	},
}) as unknown as SQL;

/**
 * The Bun SQL METHODS the shared handle forwards as they are: value builders that
 * take no connection. Every other method — `begin`/`transaction`/`savepoint`,
 * the distributed-transaction family, `file`, `listen`/`notify`, `connect`,
 * `close`/`end`, the dispose symbols, and whatever a future Bun adds — takes a
 * connection (or closes the process pool) OUTSIDE the doors above: no acquire
 * slot, no session-SET refusal, no recorder, no 57014 typing, and inside the
 * unbounded scope a silent move to the maintenance pool. So they are REFUSED
 * (an allowlist, not a denylist: a new Bun member is refused until someone
 * decides it is connection-free). The doors: `sql`…``/`sql.unsafe` for a
 * statement, `withTransaction` for a transaction, `sql.reserve()` for a
 * caller-owned connection, `closeDatabasePool` to close.
 */
const CONNECTION_FREE_METHODS: ReadonlySet<PropertyKey> = new Set<PropertyKey>(['array']);

/** Every `sql.<property>` but `unsafe`: the reserve door, a connection-free member, else refused. */
function forwardProperty(handle: TransactionHandle | undefined, property: PropertyKey): unknown {
	if (property === 'reserve') return reserveObserved;
	const executor = handle?.executor ?? currentPoolLane().pool;
	const value = (executor as unknown as Record<PropertyKey, unknown>)[property];
	if (typeof value !== 'function') return value;
	if (CONNECTION_FREE_METHODS.has(property)) return value.bind(executor);
	return refusedMember(property);
}

/** A stand-in for a connection-taking `sql` member: calling it throws, loudly. */
function refusedMember(property: PropertyKey): () => never {
	return () => {
		throw new DedaloError('internal.invariant', {
			message:
				`postgres: sql.${String(property)}() takes a database connection outside the pool's ` +
				'doors (acquire gate, session-SET refusal, ceiling typing). Use withTransaction for a ' +
				'transaction, sql.reserve() for a caller-owned connection, sql`…`/sql.unsafe for a ' +
				'statement, closeDatabasePool to close.',
			coordinates: { member: String(property) },
		});
	};
}

/**
 * Slow-query log cap. Generous so a real filter reads whole (the old 300-char
 * cut hid every join), bounded so an id-list/UNION statement cannot emit MBs.
 */
const SLOW_QUERY_LOG_MAX_CHARS = 16_384;

/** Collapse whitespace; a cut is always announced, never silent. */
export function capQueryText(text: string): string {
	const oneLine = text.replace(/\s+/g, ' ');
	return oneLine.length <= SLOW_QUERY_LOG_MAX_CHARS
		? oneLine
		: `${oneLine.slice(0, SLOW_QUERY_LOG_MAX_CHARS)}… (+${oneLine.length - SLOW_QUERY_LOG_MAX_CHARS} chars)`;
}

/** Lazy one-line description of a tagged-template call, for the slow-query log. */
function describeTemplate(argumentsList: unknown[]): () => string {
	return () => capQueryText(templateText(argumentsList));
}

/** Lazy one-line description of an `.unsafe` statement, for the slow-query log. */
function describeText(query: string): () => string {
	return () => capQueryText(query);
}

/**
 * `sql.reserve()` — a connection held for a caller-owned span (a session-level
 * advisory lock, a GUC that must not ride the pool, a lock holder). It TAKES A
 * GATE SLOT from its pool (see the POOL ACQUIRE GATE rule) until `release()` —
 * which is wrapped to free the slot exactly once — and its statements go
 * through the query tap. Inside `withUnboundedStatements` it reserves from the
 * maintenance pool. The reserved lane is caller-owned: session SET is allowed
 * there, and a 57014 on it is never typed (install/db/migrate.ts reads the raw
 * errno to tell a stopped online run).
 *
 * Reserving INSIDE an ambient transaction is refused: a second connection sees
 * none of the transaction's uncommitted writes, so the caller would silently
 * read a pre-transaction world (and could deadlock against its own row locks).
 * No caller does it today; this makes sure none starts by accident.
 */
async function reserveObserved(): Promise<SQL> {
	if (transactionStore.getStore() !== undefined) {
		throw new DedaloError('internal.invariant', {
			message:
				'postgres: sql.reserve() was called inside an ambient transaction. A reserved ' +
				"connection is a SECOND connection: it sees none of the transaction's uncommitted " +
				'writes and can block on its row locks. Issue the statement through `sql` (it is ' +
				'already pinned to the transaction), or move the reserved work outside the ' +
				'transaction with runDetachedFromTransaction.',
		});
	}
	const lane = currentPoolLane();
	await lane.gate.acquire();
	let reserved: SQL;
	try {
		reserved = (await lane.pool.reserve()) as unknown as SQL;
	} catch (error) {
		lane.gate.release();
		throw error;
	}
	let released = false;
	const releaseSlotOnce = () => {
		if (released) return;
		released = true;
		lane.gate.release();
	};
	return wrapReservedForTap(reserved, releaseSlotOnce);
}

/**
 * The reserved handle, wrapped so its statements are timed and tapped, and its
 * release frees the gate slot (once). Timing ONLY: the slot is held for the
 * reservation's span, so this must never route through runOnPool.
 */
function wrapReservedForTap(reserved: SQL, releaseSlotOnce: () => void): SQL {
	return new Proxy(reserved, {
		apply(_target, _thisArg, argumentsList) {
			return observeStatement('reserved', describeTemplate(argumentsList), async () =>
				(reserved as unknown as (...args: unknown[]) => Promise<unknown>)(...argumentsList),
			);
		},
		get(_target, property, _receiver) {
			if (property === 'unsafe') {
				return (query: string, params?: unknown[]) =>
					observeStatement('reserved', describeText(query), async () =>
						reserved.unsafe(query, params as never),
					);
			}
			const value = (reserved as unknown as Record<PropertyKey, unknown>)[property];
			if (typeof value !== 'function') return value;
			return RELEASING_MEMBERS.has(property)
				? releasingMember(value as (...args: unknown[]) => unknown, reserved, releaseSlotOnce)
				: value.bind(reserved);
		},
	}) as unknown as SQL;
}

/** The members that hand a reserved connection back (each frees the gate slot, once). */
const RELEASING_MEMBERS: ReadonlySet<PropertyKey> = new Set<PropertyKey>([
	'release',
	Symbol.dispose,
	Symbol.asyncDispose,
]);

/** `member` bound to `reserved`, freeing the gate slot after it runs (even when it throws). */
function releasingMember(
	member: (...args: unknown[]) => unknown,
	reserved: SQL,
	releaseSlotOnce: () => void,
): (...args: unknown[]) => unknown {
	return (...args: unknown[]) => {
		try {
			return member.apply(reserved, args);
		} finally {
			releaseSlotOnce();
		}
	};
}

/**
 * Run `work` inside a single database transaction (BEGIN … COMMIT/ROLLBACK on
 * ONE reserved connection). Every query issued through the exported `sql` while
 * `work` runs — directly or in any awaited helper — is pinned to that
 * connection, so in-transaction reads see in-transaction writes, exactly like
 * PHP's per-request connection. A throw rolls the whole transaction back.
 *
 * The connection comes from the current pool lane: inside
 * `withUnboundedStatements` the transaction BEGINs on the maintenance pool and
 * its ceiling is 0.
 *
 * Nesting: an inner `withTransaction` reuses the ambient transaction (no nested
 * BEGIN, no savepoint) — the outer commit/rollback is authoritative. This keeps
 * composed mutation helpers (each defensively wrapping their own writes) from
 * fragmenting one logical operation into independent transactions.
 */
export async function withTransaction<T>(
	work: () => Promise<T>,
	options: { signal?: AbortSignal } = {},
): Promise<T> {
	const ambient = transactionStore.getStore();
	if (ambient !== undefined) {
		// Already inside a transaction — join it (single-connection guarantee
		// holds; the OUTER withTransaction owns the deferred-action replay).
		return work();
	}
	const lane = currentPoolLane();
	const queue: DeferredActionQueue = { actions: [], closed: false };
	const commitQueue: CommitActionQueue = { actions: [], closed: false };
	let handle: TransactionHandle | null = null;
	// COMMIT means pool.begin RESOLVED (Bun issues the COMMIT before resolving;
	// a thrown work callback or a failed COMMIT both reject) — the flag decides
	// whether the commit-only lane drains or is discarded.
	let committed = false;
	// The transaction owns ONE pool slot for its whole span (see the acquire
	// gate above); its inner queries route onto the reserved connection and
	// bypass the gate. A caller's `signal` (the maintenance unit's abort) ends
	// the wait for that slot too — a stopped run never sits in the queue.
	await lane.gate.acquire(options.signal);
	try {
		const result = (await lane.pool.begin(async (transaction: SQL) => {
			const opened: TransactionHandle = {
				executor: transaction,
				expired: false,
				ceilingMs: lane.ceilingMs,
				laneCeilingMs: lane.ceilingMs,
				lane: lane.name,
				liftedLocally: false,
				savepoints: [],
				commitQueue,
				commitQueueUncertain: false,
				signal: options.signal,
			};
			handle = opened;
			return transactionStore.run(opened, () =>
				deferredActionStore.run(queue, async () => {
					const result = await commitActionStore.run(commitQueue, work);
					refuseUncertainCommitQueue(opened);
					return result;
				}),
			);
		})) as T;
		committed = true;
		return result;
	} finally {
		lane.gate.release();
		// S2-14: expire the ambient handle FIRST — from here on, any leaked
		// continuation that tries to query throws instead of running on the
		// released connection.
		if (handle !== null) {
			(handle as TransactionHandle).expired = true;
		}
		queue.closed = true;
		// Replay the deferred cache clears AFTER the transaction has settled
		// (see deferredActionStore) — on rollback too, harmless by design.
		for (const action of queue.actions) {
			try {
				action();
			} catch (error) {
				console.error('withTransaction: deferred post-transaction action failed:', error);
			}
		}
		// COMMIT-ONLY lane (W12): drains here — outside transactionStore.run,
		// so actions see NO ambient transaction and their queries hit the pool
		// (or their own withTransaction) — and ONLY when the COMMIT succeeded.
		// On rollback the queue is discarded: a commit action is by contract a
		// side effect OF the committed state (observer cascade hops, mirror
		// writes) and must never fire for state that does not exist.
		// Each action is awaited: async actions are first-class, a rejection is
		// logged and the remainder still drains (never an unhandled rejection).
		commitQueue.closed = true;
		if (committed) {
			for (const action of commitQueue.actions) {
				try {
					await action();
				} catch (error) {
					console.error(
						'withTransaction: commit-only action failed (remainder still drains):',
						error,
					);
				}
			}
		}
	}
}

/**
 * Before COMMIT: a transaction whose savepoint history the recorder could not
 * pair (unpairedRollbackTo) and that still queues commit-only actions is rolled
 * back loudly — some of those actions may belong to undone state.
 */
function refuseUncertainCommitQueue(handle: TransactionHandle): void {
	if (!handle.commitQueueUncertain || handle.commitQueue.actions.length === 0) return;
	throw new DedaloError('internal.invariant', {
		message:
			'postgres: a ROLLBACK TO the recorder could not pair with a SAVEPOINT ran in a ' +
			'transaction that queues commit-only actions — which of them the rollback undid is ' +
			'unknown, so the transaction is rolled back. Issue SAVEPOINT / ROLLBACK TO SAVEPOINT ' +
			'as single statements.',
		coordinates: { commit_actions: handle.commitQueue.actions.length },
	});
}

/** What a maintenance transaction's work is handed. */
export interface MaintenanceTransactionContext {
	/** The caller's abort signal (undefined when none was given). */
	signal: AbortSignal | undefined;
	/**
	 * This attempt's transaction id (`pg_current_xact_id()`, xid8 text) — what
	 * `pg_xact_status` answers for after a failure whose outcome the caller did
	 * not decide itself (a connection lost during COMMIT).
	 */
	xid: string | undefined;
	/**
	 * Call between steps: throws when the run was aborted, and when the
	 * transaction id changed — a COMMIT slipped through a step (the atomic unit
	 * would silently have become two).
	 */
	checkpoint: () => Promise<void>;
}

/**
 * ONE atomic maintenance unit (OPS-6) — the shape install/db/migrate.ts's
 * applyMigration + applyWithLockRetry proved: a transaction on the maintenance
 * pool (unbounded), with
 *  1. `SET LOCAL lock_timeout = <opts.lockTimeout>` then
 *     `SET LOCAL statement_timeout = 0` (deliberately redundant with the pool's
 *     startup 0 — it mirrors migrate.ts and survives a routing regression);
 *  2. the backend pid + `xact_start` (the cancel target) and the xid (the
 *     checkpoint's COMMIT detector, and `context.xid` — what a caller asks
 *     `pg_xact_status` about after a failure it did not decide);
 *  3. an ABORT LISTENER: `opts.signal` firing cancels the running statement
 *     with `pg_cancel_backend`, guarded by `xact_start` so it can never hit a
 *     later transaction on that backend; the cancel is sent on a short-lived
 *     DEDICATED connection (sendCancel), so it can starve behind neither pool —
 *     and a run still WAITING for its maintenance slot leaves the queue at once
 *     (the signal reaches the acquire gate). The cancel is one-shot (it reaches
 *     only the statement running when it lands); the abort is STICKY at the
 *     statement door — the transaction carries the signal, and no statement is
 *     sent on it after the abort (onTransactionLane);
 *  4. the whole unit retried on a lock timeout (55P03) after each of
 *     `opts.lockRetryDelaysMs` (default 1s/2s/4s/8s); `opts.onLockRetry` is told
 *     of each discarded attempt (the update engine writes it to update.log, so
 *     a log never shows a rolled-back attempt's steps as if they had landed).
 * Refused inside an ambient transaction (the unit must own its COMMIT).
 */
export async function withMaintenanceTransaction<T>(
	work: (context: MaintenanceTransactionContext) => Promise<T>,
	options: {
		lockTimeout: string;
		signal?: AbortSignal;
		lockRetryDelaysMs?: readonly number[];
		onLockRetry?: (attempt: number, delayMs: number) => void;
	},
): Promise<T> {
	if (transactionStore.getStore() !== undefined) {
		throw new DedaloError('internal.invariant', {
			message:
				'postgres: withMaintenanceTransaction was called inside an ambient transaction — the ' +
				'maintenance unit must own its own BEGIN/COMMIT.',
		});
	}
	if (!/^\d+(\.\d+)?\s*(us|ms|s|min|h|d)?$/.test(options.lockTimeout)) {
		throw new DedaloError('internal.invariant', {
			message: 'postgres: withMaintenanceTransaction lockTimeout must be a Postgres duration',
			coordinates: { lock_timeout: options.lockTimeout },
		});
	}
	const signal = options.signal;
	return retryOnLockNotAvailable(
		() =>
			withUnboundedStatements(() =>
				withTransaction(() => runMaintenanceUnit(work, options.lockTimeout, signal), { signal }),
			),
		options.lockRetryDelaysMs ?? [1000, 2000, 4000, 8000],
		(attempt, delayMs) => {
			console.warn(
				`[maintenance] lock wait timed out (attempt ${attempt}); retrying the whole unit in ${delayMs}ms`,
			);
			options.onLockRetry?.(attempt, delayMs);
		},
		signal,
	);
}

/** The body of one maintenance transaction attempt (see withMaintenanceTransaction). */
async function runMaintenanceUnit<T>(
	work: (context: MaintenanceTransactionContext) => Promise<T>,
	lockTimeout: string,
	signal: AbortSignal | undefined,
): Promise<T> {
	await sql.unsafe(`SET LOCAL lock_timeout = '${lockTimeout}'`, []);
	await sql.unsafe('SET LOCAL statement_timeout = 0', []);
	const [backend] = (await sql.unsafe(
		'SELECT pid, xact_start::text AS xact_start FROM pg_stat_activity WHERE pid = pg_backend_pid()',
		[],
	)) as { pid: number; xact_start: string }[];
	const readXid = async () =>
		((await sql.unsafe('SELECT pg_current_xact_id()::text AS xid', [])) as { xid: string }[])[0]
			?.xid;
	const xid = await readXid();
	signal?.throwIfAborted();
	const cancelRunningStatement = () => {
		if (backend === undefined) return;
		void sendCancel(
			'SELECT pg_cancel_backend(pid) FROM pg_stat_activity WHERE pid = $1 AND xact_start = $2::timestamptz',
			[backend.pid, backend.xact_start],
			'maintenance abort',
		);
	};
	signal?.addEventListener('abort', cancelRunningStatement, { once: true });
	try {
		return await work({
			signal,
			xid,
			checkpoint: async () => {
				signal?.throwIfAborted();
				const now = await readXid();
				if (now !== xid) throw transactionEndedMidUnit(String(xid), String(now));
			},
		});
	} finally {
		// Before COMMIT: a late abort must never cancel the COMMIT itself.
		signal?.removeEventListener('abort', cancelRunningStatement);
	}
}

/** The checkpoint's marker for a transaction that ended mid-unit (isTransactionEndedMidUnit). */
const XACT_CHANGED_RULE = 'xact_changed';

/**
 * The checkpoint's verdict when the transaction id changed mid-unit: a
 * statement ENDED the unit's transaction, so what ran before it is COMMITTED
 * (or rolled back — a ROLLBACK) and what ran after it autocommitted. The pool
 * refuses transaction control before it is sent (refuseSessionState), so this
 * is defense in depth; its caller must NEVER report it as a rollback
 * (isTransactionEndedMidUnit).
 */
export function transactionEndedMidUnit(xidBefore: string, xidNow: string): DedaloError {
	return new DedaloError('internal.invariant', {
		message:
			'postgres: the maintenance transaction id changed mid-unit — a statement ended the ' +
			'transaction (COMMIT/ROLLBACK slipped through a step); what ran before it is not undone.',
		coordinates: { rule: XACT_CHANGED_RULE, xid_before: xidBefore, xid_now: xidNow },
	});
}

/** Whether `error` is the checkpoint's transactionEndedMidUnit verdict. */
export function isTransactionEndedMidUnit(error: unknown): error is DedaloError {
	return error instanceof DedaloError && error.coordinates?.rule === XACT_CHANGED_RULE;
}

/**
 * Run `work` OUTSIDE any ambient transaction context — the inverse of the
 * S2-14 expiry guard, for the one case where a leaked continuation is not a bug
 * but the design: a DETACHED BACKGROUND JOB.
 *
 * `mediaJobs.submit` is called synchronously from a request handler, so the
 * worker it schedules inherits that request's AsyncLocalStorage stores. If the
 * handler ran inside `withTransaction`, the job would still hold the tx handle
 * minutes later, when the request has long since committed and the handle is
 * `expired` — its first query would then throw the S2-14 error instead of
 * running on the pool. A job outlives its submitter by construction; it must
 * therefore own no part of the submitter's connection state.
 *
 * Exits ALL FOUR stores: the tx handle (queries route to the pool), the
 * deferred queue (a job's cache clears must fire on their own, not be appended
 * to a queue that has already been replayed), the commit-only lane (a
 * detached job's registerCommitAction must return false — run inline — never
 * append to a queue whose fate was decided long ago) and the unbounded scope
 * (a job never inherits a lift; one that must be unbounded declares its own
 * withUnboundedStatements).
 */
export function runDetachedFromTransaction<T>(work: () => T): T {
	return transactionStore.exit(() =>
		deferredActionStore.exit(() => commitActionStore.exit(() => ceilingLiftStore.exit(work))),
	);
}

/**
 * The TRANSACTION-SCOPED memo for the current async context, or undefined when
 * no transaction is ambient. For caches that must NOT seed a process-wide
 * store from inside a transaction (S1-14: an in-tx build may observe
 * uncommitted rows) but should not rebuild on every in-tx call either: the
 * memo lives exactly as long as the transaction, so nothing uncommitted ever
 * crosses the tx boundary. Introduced 2026-08-02 for the observer subscription
 * registry (a cold-cache import ran one full registry build per component save
 * inside the per-row import transaction). Keys are module-owned symbols.
 * Nested withTransaction joins the ambient handle, so inner scopes share the
 * outer memo — correct, since they share the same uncommitted read view.
 */
export function getTransactionMemo(): Map<symbol, unknown> | undefined {
	const handle = transactionStore.getStore();
	if (handle === undefined) return undefined;
	handle.memo ??= new Map();
	return handle.memo;
}

/**
 * True when the current async context is inside a `withTransaction` block.
 * NOTE an EXPIRED handle (a leaked continuation, S2-14) still reports true:
 * guards keyed on this stay on the transactional path and the next query
 * fails loud in activeTransaction() — returning false would silently reroute the
 * leaked writes onto the pool, outside any transaction.
 */
export function isInTransaction(): boolean {
	return transactionStore.getStore() !== undefined;
}

/**
 * Run `work` under a SAVEPOINT of the ambient transaction: on success the
 * savepoint is RELEASED (the work stays part of the transaction, its fate the
 * outer COMMIT/ROLLBACK's); on a throw everything `work` wrote is undone with
 * `ROLLBACK TO SAVEPOINT` — the rows, the `SET LOCAL` ceiling and the
 * commit-only actions it queued (the recorder pairs the statements, see
 * recordSavepointStatement) — and the error is RETHROWN: the caller decides
 * whether the transaction goes on. When the rollback itself fails (the
 * connection is gone) the ORIGINAL error is rethrown; the transaction is then
 * beyond repair and its owner's rollback is authoritative.
 *
 * The name is the handle's savepoint depth, so a nested call never shadows its
 * parent and sibling calls reuse one name (each released before the next).
 *
 * REFUSED outside a transaction (there is nothing to roll back to). STATED
 * LIMIT: a row INSERTED under a savepoint carries the SUBtransaction's xid as
 * xmin, so an xmin birth test (`bornInCurrentTransaction`, create_record.ts)
 * answers "not mine" for it — never decide a birth by xmin under this. The
 * create door does not: `createSectionRecord` (and so a save's
 * create-on-first-save) takes its birth from the insert statement itself, exact
 * under a savepoint (gate: rdf_import_execute_native, the MISSING caller).
 */
export async function withSavepoint<T>(work: () => Promise<T>): Promise<T> {
	const handle = activeTransaction();
	if (handle === undefined) {
		throw new DedaloError('internal.invariant', {
			message: 'withSavepoint: called outside a transaction (no savepoint to roll back to)',
		});
	}
	const name = `dedalo_savepoint_${handle.savepoints.length}`;
	await sql.unsafe(`SAVEPOINT ${name}`, []);
	try {
		const result = await work();
		await sql.unsafe(`RELEASE SAVEPOINT ${name}`, []);
		return result;
	} catch (error) {
		await undoToSavepoint(name).catch(() => undefined);
		throw error;
	}
}

/** Undo to `name` and drop it (the work's own error is the one the caller sees). */
async function undoToSavepoint(name: string): Promise<void> {
	await sql.unsafe(`ROLLBACK TO SAVEPOINT ${name}`, []);
	await sql.unsafe(`RELEASE SAVEPOINT ${name}`, []);
}

/**
 * Acquire the transaction-scoped advisory lock for one node, byte-identical to
 * PHP matrix_db_manager::acquire_node_lock:
 *   SELECT pg_advisory_xact_lock(hashtext('<section_tipo>_<section_id>'))
 *
 * The hashtext input string MUST match PHP exactly — during PHP↔TS coexistence
 * both servers hash the same key, which is what makes them mutually exclusive
 * on the same node. The lock releases automatically at COMMIT/ROLLBACK. Callable
 * only inside a transaction (an advisory-xact lock outside a tx is a no-op).
 */
export async function acquireNodeLock(
	sectionTipo: string,
	sectionId: number | string,
): Promise<void> {
	if (!isInTransaction()) {
		throw new DedaloError('internal.invariant', {
			message:
				'acquireNodeLock: called outside a transaction; the lock would be ineffective (call inside withTransaction)',
			coordinates: { section_tipo: sectionTipo, section_id: sectionId },
		});
	}
	const lockKey = `${sectionTipo}_${sectionId}`;
	await sql.unsafe('SELECT pg_advisory_xact_lock(hashtext($1))', [lockKey]);
}

/**
 * Close both pools (tests and graceful shutdown), MAINTENANCE FIRST and BOUNDED.
 * A maintenance statement is unbounded by design (a data update, a REINDEX), so
 * an unconditional `end()` would wait for it — hours — and the orphaned
 * backend would keep its locks (and the update engine's advisory lock) until
 * its statement ended. So: cancel every running statement of THIS process's
 * maintenance pool (found by its application_name, on a dedicated connection —
 * neither pool, which may both be saturated at shutdown — bounded by
 * MAINTENANCE_CANCEL_BUDGET_MS), then close the maintenance pool
 * with a timeout (a connection still busy after it is closed forcibly), then
 * the request pool. A cancelled transaction rolls back — for the update engine
 * that is its documented restart semantics (the rerun is the resume). The
 * NON-TRANSACTIONAL lane (runWithoutStatementTimeout) is closed with the same
 * bound but never cancelled: its statements do not roll back (a cancelled
 * CONCURRENTLY build leaves an invalid index).
 */
export async function closeDatabasePool(): Promise<void> {
	const closing: Promise<unknown>[] = [];
	if (maintenanceLane !== null) {
		await cancelMaintenanceStatements();
		closing.push(maintenanceLane.pool.close({ timeout: MAINTENANCE_CLOSE_TIMEOUT_S }));
	}
	// NEVER cancelled (getNonTransactionalLane): closed with the same bound, and
	// a statement still running is finished by the server, not interrupted.
	if (nonTransactionalLane !== null) {
		closing.push(nonTransactionalLane.pool.close({ timeout: MAINTENANCE_CLOSE_TIMEOUT_S }));
	}
	await Promise.all(closing);
	await pool.end();
}

/**
 * pg_cancel_backend for this process's active maintenance backends, bounded;
 * never throws. Scoped THREE ways, because pg_stat_activity is cluster-wide: the
 * per-boot application_name (another process — another install, a CLI container
 * that is also PID 1 — never carries it), this DATABASE, and this ROLE (a
 * foreign role's row would make pg_cancel_backend raise and abort the whole
 * SELECT, leaving this process's own statements running).
 */
async function cancelMaintenanceStatements(): Promise<void> {
	await sendCancel(
		`SELECT pg_cancel_backend(pid) FROM pg_stat_activity
		 WHERE application_name = $1 AND datname = current_database() AND usename = current_user
		   AND state <> 'idle' AND pid <> pg_backend_pid()`,
		[MAINTENANCE_APPLICATION_NAME],
		'shutdown',
	);
}

/**
 * The DEDICATED-connection counter: at most DEDICATED_CONNECTIONS_MAX open at
 * once, so the per-process budget (connection_budget.ts) is a bound on physical
 * backends and not a hope. A slot is held from before the connection opens until
 * its close SETTLES — not until the work returns: an open socket is what
 * max_connections counts. FIFO; no timeout of its own (the caller's budget
 * races the wait — onDedicatedConnection).
 */
function makeDedicatedCounter(max: number): { acquire(): Promise<void>; release(): void } {
	let available = max;
	const waiters: (() => void)[] = [];
	return {
		acquire() {
			if (available > 0) {
				available--;
				return Promise.resolve();
			}
			return new Promise<void>((grant) => waiters.push(grant));
		},
		release() {
			const next = waiters.shift();
			if (next === undefined) available++;
			else next();
		},
	};
}

const dedicatedConnections = makeDedicatedCounter(DEDICATED_CONNECTIONS_MAX);

/**
 * Run `work` on a SHORT-LIVED DEDICATED connection (application_name
 * `dedalo_<label>:<pid>`), bounded by `budgetMs`: `{ value }`, or 'timed out'
 * (a rejection propagates). Never a pooled connection: both pools — and their
 * gates — may be saturated exactly when this is needed (a stop under load, a
 * shutdown, the verdict of a run whose released slot went straight to the next
 * queued maintenance waiter), and work queued behind the traffic it should
 * relieve or judge is no bound at all. The connection takes no pool slot — only
 * one of the DEDICATED_CONNECTIONS_MAX dedicated slots (makeDedicatedCounter),
 * whose wait counts inside `budgetMs` — and is closed in the background right
 * after (a statement still pending past the budget gets one more second, then
 * the connection is closed forcibly); its slot returns when the close settles.
 */
async function onDedicatedConnection<T>(
	label: string,
	work: (connection: SQL) => Promise<T>,
	budgetMs: number,
): Promise<{ value: T } | 'timed out'> {
	let connection: SQL | null = null;
	let finished = false;
	const closeOnce = () => {
		if (connection === null) return;
		const opened = connection;
		connection = null;
		void opened
			.close({ timeout: 1 })
			.catch((error: unknown) =>
				console.error(`[${label}] dedicated connection close failed:`, error),
			)
			.finally(() => dedicatedConnections.release());
	};
	const running = (async (): Promise<{ value: T } | 'timed out'> => {
		await dedicatedConnections.acquire();
		// The budget ran out while this waited for a slot: hand it straight back.
		// The race already answered 'timed out' — this is that same verdict, never
		// a failure (nothing reads it; a throw here was an untyped zero-tier site).
		if (finished) {
			dedicatedConnections.release();
			return 'timed out';
		}
		connection = new SQL(buildSqlOptions(1, undefined, `dedalo_${label}:${process.pid}`));
		return { value: await work(connection) };
	})();
	// A rejection after the budget lost the race must not surface as unhandled.
	running.catch(() => undefined);
	try {
		return await Promise.race([running, Bun.sleep(budgetMs).then(() => 'timed out' as const)]);
	} finally {
		finished = true;
		closeOnce();
	}
}

/**
 * Send ONE cancel statement on a dedicated connection (onDedicatedConnection),
 * bounded by MAINTENANCE_CANCEL_BUDGET_MS; never throws (a failed cancel is
 * logged).
 */
async function sendCancel(
	statement: string,
	params: (string | number)[],
	label: string,
): Promise<void> {
	try {
		await onDedicatedConnection(
			'cancel',
			(connection) => connection.unsafe(statement, params),
			MAINTENANCE_CANCEL_BUDGET_MS,
		);
	} catch (error) {
		console.error(`[${label}] cancel failed:`, error);
	}
}

/**
 * PostgreSQL's own record of transaction `xid` (xid8 text — the
 * MaintenanceTransactionContext `xid`): 'committed' | 'aborted' |
 * 'in progress' | null (too old, or never assigned). Read on a dedicated
 * connection (onDedicatedConnection) bounded by XACT_STATUS_BUDGET_MS, so the
 * verdict of a finished run never queues behind either pool. Throws when the
 * read fails or outlives its budget — the caller reports "outcome unknown".
 */
export async function readTransactionStatus(xid: string): Promise<string | null> {
	const outcome = await onDedicatedConnection(
		'xact_status',
		async (connection) =>
			(await connection.unsafe('SELECT pg_xact_status($1::xid8) AS status', [xid])) as {
				status: string | null;
			}[],
		XACT_STATUS_BUDGET_MS,
	);
	if (outcome === 'timed out') {
		throw new DedaloError('internal.unexpected', {
			message: `postgres: reading transaction ${xid}'s status outlived its ${XACT_STATUS_BUDGET_MS}ms budget`,
			coordinates: { xid },
		});
	}
	return outcome.value[0]?.status ?? null;
}

/** What a failed maintenance unit did (outcomeOfFailedUnit). */
export type FailedUnitOutcome = 'committed' | 'rolled_back' | 'unknown';

/** How long outcomeOfFailedUnit waits for a transaction PostgreSQL still reports in progress. */
const XACT_STATUS_POLL_MS: readonly number[] = [100, 200, 400, 800, 1500];

/** pg_xact_status's final answers, as a verdict. */
const XACT_VERDICT: Readonly<Record<string, 'committed' | 'rolled_back'>> = {
	committed: 'committed',
	aborted: 'rolled_back',
};

/**
 * What a failure its caller did not decide itself did to a maintenance unit
 * (MaintenanceTransactionContext `xid`). Such a failure — a lost connection, a
 * cancel, a pool force-closed at shutdown — may strike DURING COMMIT, when the
 * outcome is decided server-side, so PostgreSQL is asked about THIS attempt's
 * transaction (`pg_xact_status`, outside the dead transaction): 'committed' /
 * 'aborted' are the answer; 'in progress' (a COMMIT still waiting, e.g. on a
 * synchronous standby) is polled briefly; still in progress, NULL, or a failed
 * read is UNKNOWN — never "rolled back" on a guess. No xid means the attempt
 * failed before its transaction did any work: a certain rollback. The ONE
 * classifier of the update engine and the move_* transform engine.
 */
export async function outcomeOfFailedUnit(
	xid: string | undefined,
	options: { label: string; readStatus?: (xid: string) => Promise<string | null> },
): Promise<FailedUnitOutcome> {
	if (xid === undefined) return 'rolled_back';
	try {
		return await pollXactStatus(options.readStatus ?? readTransactionStatus, xid);
	} catch (error) {
		console.error(
			`[${options.label}] reading transaction ${xid}'s status after a failure failed:`,
			error,
		);
		return 'unknown';
	}
}

/** Read the status, polling while it is 'in progress'; anything else unfinal is unknown. */
async function pollXactStatus(
	readStatus: (xid: string) => Promise<string | null>,
	xid: string,
): Promise<FailedUnitOutcome> {
	for (const delayMs of [...XACT_STATUS_POLL_MS, null]) {
		const status = await readStatus(xid);
		const verdict = XACT_VERDICT[status ?? ''];
		if (verdict !== undefined) return verdict;
		if (status !== 'in progress' || delayMs === null) return 'unknown';
		await Bun.sleep(delayMs);
	}
	return 'unknown';
}
