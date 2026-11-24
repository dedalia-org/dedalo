/**
 * MariaDB target access for diffusion (DIFFUSION_SPEC §4.3 / §2.5).
 *
 * THE ONLY MODULE TREE ALLOWED TO CONSTRUCT A MARIADB CLIENT. "Bun owns
 * MariaDB" is a module boundary here: src/core/** never touches MariaDB, and
 * everything under src/diffusion/ reaches the publication targets exclusively
 * through this file's pools (enforced mechanically by
 * test/unit/diffusion_boundaries.test.ts).
 *
 * Driver: Bun-native `Bun.sql` with the 'mariadb' adapter — spike-verified
 * 2026-07-05 against MariaDB 12.2.2 (DIFFUSION_PLAN D1/P2 result): unix-socket
 * auth, utf8mb4 + 4-byte chars, `?` placeholders via `.unsafe(sql, params)`,
 * multi-row upserts, `begin()` transactions, INFORMATION_SCHEMA reads, and
 * MySQLError with a distinct `.errno` (1146 missing table; 1049/1044 for an
 * unknown/ungranted database).
 *
 * Deployment posture (spike facts, non-negotiable):
 * - ALWAYS pass an explicit `database` — a database-less MariaDB session
 *   misbehaves under this adapter.
 * - `CREATE DATABASE` is NOT granted to the diffusion user. A missing target
 *   database is a LOUD configuration error (MissingTargetDatabaseError),
 *   never an auto-create (old-engine check_database posture).
 *
 * Config keys (../private/.env, readEnv precedence — process env wins):
 *   DEDALO_DIFFUSION_DB_SOCKET    unix socket path (default /tmp/mysql.sock)
 *   DEDALO_DIFFUSION_DB_HOST/_DB_PORT  TCP fallback used only when the socket
 *                                 key is explicitly unset-but-host-set
 *   DEDALO_DIFFUSION_DB_USER      MariaDB user (minimal grants, spec §8.6)
 *   DEDALO_DIFFUSION_DB_PASSWORD  password
 */

import { SQL } from 'bun';
import { readEnv } from '../../../config/env.ts';
import { readString } from '../../../config/readers.ts';
import { suitePoolRefusal } from '../../../config/suite_database.ts';
import { DedaloError, type ErrorCode } from '../../../core/errors/index.ts';

/** Rows/mutation results from `.unsafe()` carry MySQL metadata on the array. */
export interface MariadbExecResult {
	affectedRows?: number;
}

/** The distinct MySQL error shape surfaced by the Bun adapter. */
export interface MariadbErrorLike {
	errno?: number;
	message?: string;
}

/** errno 1146 — target table does not exist (tolerated on deletes). */
export const ERRNO_MISSING_TABLE = 1146;
/** errno 1049 — unknown database. */
export const ERRNO_UNKNOWN_DATABASE = 1049;
/** errno 1044 — database exists check denied by grants (same posture as 1049). */
export const ERRNO_DATABASE_ACCESS_DENIED = 1044;

/**
 * Strict-mode VALUE refusals: the row is fine, one value does not fit its live
 * column — 1406 data too long, 1264 out of range, 1366 incorrect value. The
 * driver message names the column and the 1-based row of the statement.
 */
const ERRNOS_VALUE_REJECTED = new Set([1406, 1264, 1366]);

/** The column + 1-based statement row of a strict-mode value refusal; null for any other error. */
export function valueRejection(error: unknown): { errno: number; column: string; row: number } | null {
	const { errno, message } = (error as MariadbErrorLike) ?? {};
	if (errno === undefined || !ERRNOS_VALUE_REJECTED.has(errno)) return null;
	// 1406/1264: column 'v' at row 2 · 1366: column `db`.`table`.`v` at row 2
	const match = /column (?:'([^']+)'|(?:`[^`]*`\.)*`([^`]+)`) at row (\d+)/.exec(message ?? '');
	if (match === null) return null;
	return { errno, column: (match[1] ?? match[2]) as string, row: Number(match[3]) };
}

/** True when `error` is the MariaDB "database missing/ungranted" class. */
export function isMissingDatabaseError(error: unknown): boolean {
	const errno = (error as MariadbErrorLike)?.errno;
	return errno === ERRNO_UNKNOWN_DATABASE || errno === ERRNO_DATABASE_ACCESS_DENIED;
}

/** True when `error` is the MariaDB "table missing" class (delete tolerance). */
export function isMissingTableError(error: unknown): boolean {
	return (error as MariadbErrorLike)?.errno === ERRNO_MISSING_TABLE;
}

/**
 * Typed loud error for an unreachable/ungranted target database — a
 * CONFIGURATION failure (databases are pre-created by the deployment), never
 * something the engine works around. Surfaced by the writer's open() probe.
 */
export class MissingTargetDatabaseError extends DedaloError {
	readonly database: string;
	readonly errno: number | undefined;

	constructor(database: string, cause: unknown) {
		const errno = (cause as MariadbErrorLike)?.errno;
		const detail = (cause as MariadbErrorLike)?.message ?? String(cause);
		const posture =
			'Target databases must be pre-created and granted to the diffusion user ' +
			'(DEDALO_DIFFUSION_DB_USER) — the engine never auto-creates them.';
		// A thin DedaloError family: the registered code IS the identity, the
		// database name and the driver detail stay log-only (message/coordinates).
		super('diffusion.connection_failed', {
			message: `Diffusion target database '${database}' is not reachable (errno ${errno ?? 'unknown'}): ${detail}. ${posture}`,
			coordinates: { database, errno: errno ?? 'unknown' },
			cause,
		});
		this.name = 'MissingTargetDatabaseError';
		this.database = database;
		this.errno = errno;
	}
}

/**
 * One cached pool per target database name. `const` Map of request-INDEPENDENT
 * process state (a pool holds no request identity — same rationale as the
 * core postgres pool, spec §4); keys are database names, values live for the
 * process (or until closeAllTargetPools, used by tests/shutdown).
 */
const poolCache = new Map<string, SQL>();

/** Connection options resolved from env at pool-creation time (lazy, testable). */
function buildTargetOptions(database: string): ConstructorParameters<typeof SQL>[0] {
	// A TEST process opens no MariaDB target the suite preload did not arm
	// (src/config/suite_database.ts): unarmed, this is the installation's server.
	const suiteRefusal = suitePoolRefusal('diffusion MariaDB database', database);
	if (suiteRefusal !== null) {
		throw new DedaloError('internal.invariant', {
			message: suiteRefusal,
			coordinates: { database },
		});
	}
	const socket = readEnv('DEDALO_DIFFUSION_DB_SOCKET');
	const host = readEnv('DEDALO_DIFFUSION_DB_HOST');
	const commonOptions = {
		adapter: 'mariadb' as const,
		username: readString('DEDALO_DIFFUSION_DB_USER'),
		password: readString('DEDALO_DIFFUSION_DB_PASSWORD'),
		// ALWAYS an explicit database (spike: database-less sessions fail weirdly).
		database,
		// Modest per-target pool: the writer runs batches sequentially; deletes
		// and admin ops share it. The old engine used 10 — runners are separate
		// processes here, so keep the per-process footprint small.
		max: 4,
	};
	// Transport precedence: explicit socket > TCP host > default socket.
	if (socket !== undefined && socket !== '') {
		return { ...commonOptions, path: socket };
	}
	if (host !== undefined && host !== '') {
		const port = Number(readString('DEDALO_DIFFUSION_DB_PORT')) || 3306;
		return { ...commonOptions, hostname: host, port };
	}
	return { ...commonOptions, path: '/tmp/mysql.sock' };
}

/**
 * The pool for one target database — created on first use, cached for the
 * process. Creation itself never touches the network (Bun connects lazily);
 * use probeTargetDatabase() to fail loudly at session open.
 */
export function getTargetPool(database: string): SQL {
	const cached = poolCache.get(database);
	if (cached !== undefined) return cached;
	const pool = new SQL(buildTargetOptions(database));
	poolCache.set(database, pool);
	return pool;
}

/**
 * Loud reachability probe for a target database. Converts the driver's
 * errno-1049/1044 class into the typed MissingTargetDatabaseError so callers
 * (the writer's open()) report a CONFIG failure before any schema/DML work.
 * A pool whose probe failed is evicted so a fixed deployment can retry.
 */
export async function probeTargetDatabase(database: string): Promise<SQL> {
	const pool = getTargetPool(database);
	try {
		await pool.unsafe('SELECT 1', []);
		return pool;
	} catch (error) {
		poolCache.delete(database);
		await pool.close().catch(() => {});
		if (isMissingDatabaseError(error)) {
			throw new MissingTargetDatabaseError(database, error);
		}
		throw error;
	}
}

/** How long an info-panel reachability verdict is reused (short by design). */
const PROBE_STATUS_TTL_MS = 10_000;
/**
 * Ceiling for ONE info probe. Bun's default connectionTimeout is 30s, so a
 * black-holed target host would otherwise hang the whole get_diffusion_info
 * request; an observability read must never do that.
 */
const PROBE_STATUS_TIMEOUT_MS = 3_000;

/** The two oracle strings (PHP class.diffusion_utils.php:984 / :988). */
const MSG_DATABASE_READY = 'Database is ready.';
const MSG_DATABASE_NOT_READY = 'Database is NOT ready (missing or engine unreachable).';

/**
 * Target-database reachability verdicts for the INFO panels, keyed by database
 * name. NOT a content cache and not ontology/record-derived — it memoizes a
 * REMOTE SERVER'S LIVENESS, which no write event invalidates, so neither
 * ontology/cache_factory lifecycle fits (module_state_tripwire allowlist).
 * Lifecycle: each entry self-expires PROBE_STATUS_TTL_MS after it was written
 * (checked on read), and the whole map is cleared by closeAllTargetPools
 * (tests / process shutdown). Holds no request identity: a target database
 * name is install state, never per-user/lang/session.
 */
const probeStatusMemo = new Map<string, { at: number; status: TargetDatabaseStatus }>();

/**
 * A target database's reachability verdict — a NESTED PAYLOAD the maintenance
 * widget renders, not an API envelope. It carries `ok` + the registered code
 * (`diffusion.connection_failed`) rather than the retired `{result,msg}` pair,
 * so a reader branches on a code instead of on prose
 * (engineering/ERRORS_SPEC.md §1: one code per failure, never a sentence).
 */
export interface TargetDatabaseStatus {
	ok: boolean;
	/** Present only when `ok` is false. */
	code?: ErrorCode;
	message: string;
}

/**
 * NON-EVICTING, NON-THROWING reachability verdict for one target database —
 * the native answer to PHP diffusion_utils::get_connection_status (:971) /
 * database_exits (:1013), whose verbatim strings this returns.
 *
 * Deliberately NOT probeTargetDatabase(): that one is the WRITER's open() gate
 * and, on failure, evicts AND closes the shared pool — an admin opening an
 * accordion panel must not tear down the pool a live publication run is using.
 * A panel read observes; it never mutates write-path state.
 *
 * Best-effort BY ORACLE CONTRACT: PHP logged a WARNING and returned a NEGATIVE
 * verdict so the panel still rendered (:991-996). Memoized per database for
 * PROBE_STATUS_TTL_MS so N accordion panels cost ONE round-trip.
 */
export async function getTargetDatabaseStatus(database: string): Promise<TargetDatabaseStatus> {
	const cached = probeStatusMemo.get(database);
	if (cached !== undefined && Date.now() - cached.at < PROBE_STATUS_TTL_MS) {
		return cached.status;
	}
	let status: TargetDatabaseStatus;
	try {
		const pool = getTargetPool(database);
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			await Promise.race([
				pool.unsafe('SELECT 1', []),
				new Promise((_resolve, reject) => {
					timer = setTimeout(
						() => reject(new Error(`probe timeout after ${PROBE_STATUS_TIMEOUT_MS}ms`)),
						PROBE_STATUS_TIMEOUT_MS,
					);
				}),
			]);
		} finally {
			if (timer !== undefined) clearTimeout(timer);
		}
		status = { ok: true, message: MSG_DATABASE_READY };
	} catch (error) {
		status = {
			ok: false,
			code: 'diffusion.connection_failed',
			message: MSG_DATABASE_NOT_READY,
		};
		console.warn(`[diffusion] target database probe failed [${database}]`, error);
	}
	probeStatusMemo.set(database, { at: Date.now(), status });
	return status;
}

/**
 * One-shot reachability probe for the INSTALLER (DEC-19
 * test_diffusion_connection): open a throwaway connection from POSTED MariaDB
 * credentials, `SELECT 1`, and close immediately — never cached in poolCache
 * (these creds are unverified and per-request). Lives here because this tree is
 * the only place allowed to construct a MariaDB client (diffusion_boundaries).
 */
export async function probeAdhocMariadbConnection(creds: {
	host: string;
	port: number;
	socket?: string;
	database: string;
	username: string;
	password: string;
}): Promise<TargetDatabaseStatus> {
	if (creds.database === '' || creds.username === '') {
		return {
			ok: false,
			code: 'diffusion.connection_failed',
			message: 'MariaDB database and user are required',
		};
	}
	const common = {
		adapter: 'mariadb' as const,
		username: creds.username,
		password: creds.password,
		database: creds.database,
		max: 1,
	};
	const options =
		creds.socket && creds.socket !== ''
			? { ...common, path: creds.socket }
			: { ...common, hostname: creds.host, port: creds.port };
	const probe = new SQL(options);
	try {
		await probe.unsafe('SELECT 1', []);
		return { ok: true, message: `Connected to MariaDB '${creds.database}' — OK` };
	} catch (error) {
		const detail = (error as MariadbErrorLike)?.message ?? String(error);
		return {
			ok: false,
			code: 'diffusion.connection_failed',
			message: `MariaDB connection failed: ${detail}`,
		};
	} finally {
		await probe.close().catch(() => {});
	}
}

/** Close and drop every cached pool + verdict (tests / process shutdown). */
export async function closeAllTargetPools(): Promise<void> {
	const pools = [...poolCache.values()];
	poolCache.clear();
	// The verdicts describe those pools' targets — outliving them would be a lie.
	probeStatusMemo.clear();
	for (const pool of pools) {
		await pool.close().catch(() => {});
	}
}
