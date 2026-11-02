/**
 * THE RELATION-TARGET CENSUS of a source set (WC-2026-10-30-search-referenced-by-leaf):
 * which sections the records of a source set point at, and how many records of
 * each — the question the "Open relationships" modal asks before it offers one
 * window per target section. SQL only; the API door (relation_targets) and its
 * labels live in the handler.
 *
 * Every statement reads the locators the source rows STORE — their own
 * `relation` column, never the derived matrix_relation_index — through exactly
 * the scope a `referenced_by` leaf uses (builder_referenced_by.ts
 * buildOwnerRelationScope → storedLocatorExpansionSql: read >= 1 on every
 * source section, the scoped row set, the SEC-1 component key, the optional
 * from_component_tipo), so the census and the window it opens cannot disagree
 * about which locators exist.
 *
 * THE SOURCE ROW SET IS EXPANDED ONCE, whatever the number of targets or
 * statements — it is an unbounded found set, and reading its stored locators is
 * a full read of its wide rows (measured 2026-10-31 on a 184k-record source:
 * ~1.4 s per expansion; the former two-expansion census took ~6 s, this ~2 s):
 *
 *   0. the expansion, into a transaction-scoped temp table (ON COMMIT DROP):
 *        CREATE TEMP TABLE pg_temp.dedalo_census_targets ON COMMIT DROP AS
 *        SELECT DISTINCT l.target_section_tipo AS tipo, l.target_section_id AS id
 *        FROM (<owner locators>) l WHERE l.target_section_tipo IS NOT NULL
 *   1. the grouped census — the candidate target sections and their UPPER BOUND:
 *        SELECT tipo, count(id) FROM pg_temp.dedalo_census_targets GROUP BY 1
 *      (a hash aggregate; `count(DISTINCT …)` over the raw locators sorted on
 *      disk). Each candidate is kept only when it is openable (a matrix record
 *      table) and the principal may READ it (read >= 1).
 *   2. (`exact`, the default) every kept target's EXACT total in ONE statement:
 *        SELECT 'T1', (SELECT count(*) FROM (<T1 scoped row set>) …
 *                      WHERE (tipo, id) IN (the pairs of T1))
 *      a plain semi-join over the ANALYZEd table (exactBranch says why not
 *      the leaf's `IS TRUE` hashed-SubPlan shape).
 *        UNION ALL …
 *      `<T scoped row set>` is sql_assembler buildScopedRowSetSql of `{section_tipo:[T]}`
 *      — the ONE WHERE composition the opened window's own search uses (section
 *      pin, Users-root exclusion, T's records ACL, dd478). The window's
 *      full_count is `count(*)` over T's table under that WHERE AND the leaf
 *      `(tipo, id) IN (<the same owner locators>)` — the identical row
 *      predicate, so the number the modal shows is the number the window
 *      paginates. A target whose exact total is 0 is dropped (its window would
 *      be empty). `exact: false` returns the grouped totals — an UPPER BOUND,
 *      not yet narrowed by T's records ACL.
 *
 * BOUNDED BY ONE WHOLE-CENSUS DEADLINE: the census runs in one transaction; the
 * deadline is fixed once (RELATION_TARGETS_BUDGET_MS, never above the request
 * pool's own ceiling DB_STATEMENT_TIMEOUT_MS, whose default 0 is NO bound) and
 * before EACH statement `SET LOCAL statement_timeout` is set to the time LEFT —
 * so N statements can never sum past the budget; none left = the typed refusal
 * without sending the statement. The door answers while a person waits and the
 * server has no request.signal handling (a closed modal does not stop it), so
 * without its own budget one huge found set could hold a connection
 * indefinitely. A statement the budget stops is the typed 503
 * `db.statement_timeout` (the transaction lane's recorder types it,
 * db/postgres.ts). The client gives up only after
 * RELATION_TARGETS_BUDGET_MS + RELATION_TARGETS_RESPONSE_MARGIN_MS (its own
 * RELATION_TARGETS_TIMEOUT_MS sits above that sum), so the typed 503 arrives
 * first. Inside a caller's transaction the census joins it and that
 * transaction's ceiling governs (a SET LOCAL here would outlive the census
 * inside the caller's unit).
 *
 * ONE CENSUS PER SESSION (single-flight by supersession): the budget bounds how
 * LONG one census holds its pooled connection, not how MANY abandoned ones run
 * at once — and the modal aborts and re-asks on every scope flip / reopen,
 * client-side only. So a census carrying a `supersessionKey` (the handler
 * passes the session's token hash) first CLAIMS the session's flight: it
 * cancels every earlier census of that session still holding or waiting on the
 * flight lock (pg_cancel_backend through cancelBackendStatement, guarded by the
 * victim's xact_start), then takes the transaction-scoped advisory lock
 * (RELATION_TARGETS_FLIGHT_LOCK_CLASS, key derived from the session) under its
 * own budget — so it waits only for the victim's rollback. The supersession is
 * STICKY: before every statement a census asks whether a newer one waits on its
 * lock and, if so, refuses itself without sending the statement (a cancel that
 * lands while the victim sits idle between two statements is discarded by
 * PostgreSQL). Superseded = the typed 409 `resource.conflict` (coordinates
 * `reason: superseded`). The flight is PER SESSION, not per modal: a scope flip
 * or reopen inside one modal has already aborted the superseded request, but
 * another tab or window of the SAME session (one session cookie) supersedes a
 * census its own modal still waits for — that modal shows the conflict with a
 * reload action (render_open_list_with_direct_relations.js), never a wrong
 * answer. Per process AND across processes (the lock lives in PostgreSQL); no
 * module state. Every pg_locks / pg_stat_activity probe is scoped to THIS
 * database: an advisory lock is database-local, the views are cluster-wide, so
 * another installation on the same cluster is never probed nor cancelled.
 * Residual, accepted: a victim idle at the instant of the cancel that re-checks
 * before the claimant enqueues runs that ONE statement to its budget; and the
 * 28-bit key may collide across two sessions of this database (then one census
 * supersedes the other's — the same 409, re-asked by the user, never a wrong
 * answer).
 */

import { config } from '../../config/config.ts';
import { isValidTipo } from '../concepts/ontology.ts';
import type { ReferencedBySource, Sqo } from '../concepts/sqo.ts';
import { isMatrixTable } from '../db/matrix.ts';
import {
	cancelBackendStatement,
	isInTransaction,
	sql,
	sqlStateOf,
	withTransaction,
} from '../db/postgres.ts';
import { DedaloError, isDedaloError } from '../errors/dedalo_error.ts';
import { getMatrixTableFromTipo } from '../ontology/resolver.ts';
import { getPermissions, type Principal } from '../security/permissions.ts';
import {
	buildOwnerRelationScope,
	type OwnerRelationScope,
} from './builders/builder_referenced_by.ts';
import { NamedTokenCollector, ParamsCollector } from './params.ts';
import { buildScopedRowSetSql } from './sql_assembler.ts';

/**
 * The census's WHOLE budget (ms): one deadline across every statement it sends.
 * The client's request timeout (render_open_list_with_direct_relations.js
 * RELATION_TARGETS_TIMEOUT_MS) must exceed this PLUS
 * {@link RELATION_TARGETS_RESPONSE_MARGIN_MS}, so the typed 503 arrives before
 * the transport gives up.
 */
export const RELATION_TARGETS_BUDGET_MS = 30_000;

/**
 * What the door may still spend AFTER the deadline (ms): the aborted
 * statement's cancel round-trip, the rollback, the handler's labels and the
 * envelope on the wire. The ordering law a gate asserts:
 * RELATION_TARGETS_BUDGET_MS + RELATION_TARGETS_RESPONSE_MARGIN_MS <
 * the client's RELATION_TARGETS_TIMEOUT_MS.
 */
export const RELATION_TARGETS_RESPONSE_MARGIN_MS = 2_000;

/**
 * The advisory-lock class of the per-session census flight (see the module
 * header). The two-key form keeps it apart from every single-key lock. Its
 * distinctness from every other declared `*_LOCK_CLASS` — load-bearing here,
 * because claimFlight CANCELS whoever holds this class + key — is not prose: it
 * is the derived census test/unit/advisory_lock_class_tripwire.test.ts.
 */
export const RELATION_TARGETS_FLIGHT_LOCK_CLASS = 17580005;

/**
 * The flight lock's second key for a supersession key: the first 28 bits of
 * its sha256, a non-negative int4 (pg_locks.objid compares to it as-is).
 * Exported for the gate that plays an earlier census of the same session.
 */
export function relationTargetsFlightKey(supersessionKey: string): number {
	const digest = new Bun.CryptoHasher('sha256').update(supersessionKey).digest('hex');
	return Number.parseInt(digest.slice(0, 7), 16);
}

/** One target section of a source set and its record total. */
export interface RelationTargetCount {
	/** The target section tipo. */
	tipo: string;
	/** Distinct target records (exact by default — see the module header). */
	total: number;
}

export interface RelationTargetOptions {
	/** The caller; undefined = internal (no read gate, no key, no ACL). */
	principal?: Principal;
	/**
	 * Narrow to the locators one component of the source owns. Equivalent to the
	 * source's own `from_component_tipo`; naming two different ones is refused.
	 */
	fromComponentTipo?: string;
	/** Exact per-target totals through the T row set's own WHERE (default true). */
	exact?: boolean;
	/**
	 * INTERNAL, never from the wire: replace RELATION_TARGETS_BUDGET_MS (still
	 * capped by the pool ceiling) — a gate forces `db.statement_timeout`
	 * deterministically with a budget under 1 ms (e.g. 0.001): less than one
	 * whole ms is left at the first statement, so the clock refuses before
	 * sending it. A positive finite number of ms; anything else is
	 * `internal.invariant`.
	 */
	budgetMs?: number;
	/**
	 * INTERNAL, never from the wire: the single-flight key (the handler passes
	 * the session's token hash). A newer census with the same key supersedes
	 * this one (module header). Absent = no flight (internal callers, gates).
	 */
	supersessionKey?: string;
}

/**
 * The census's deadline: `arm()` before each statement sets the transaction's
 * statement_timeout to the time left, or refuses (typed) when none is left.
 * Null inside a caller's transaction (its ceiling governs).
 */
interface CensusClock {
	arm(): Promise<void>;
	/** The flight lock is now held: from here every arm() also asks the sticky supersession. */
	holdFlight(): void;
}

function startClock(budgetMs: number, flightKey: number | null): CensusClock {
	const deadline = Date.now() + budgetMs;
	let holding = false;
	return {
		async arm() {
			const remainingMs = Math.floor(deadline - Date.now());
			if (remainingMs <= 0) throw budgetExhausted(budgetMs);
			await sql.unsafe(`SET LOCAL statement_timeout = ${remainingMs}`, []);
			if (holding && flightKey !== null && (await newerCensusWaits(flightKey))) {
				throw superseded();
			}
		},
		holdFlight() {
			holding = true;
		},
	};
}

/**
 * The pg_locks rows of this flight's lock held or awaited by OTHER backends OF
 * THIS DATABASE (an advisory lock is database-local; pg_locks is cluster-wide).
 */
const FLIGHT_LOCK_ROWS =
	"FROM pg_locks l WHERE l.locktype = 'advisory' AND l.classid = $1 AND l.objid = $2 " +
	'AND l.objsubid = 2 AND l.pid <> pg_backend_pid() ' +
	'AND l.database = (SELECT oid FROM pg_database WHERE datname = current_database())';

/** Sticky supersession: does a newer census of this flight wait on the lock this one holds? */
async function newerCensusWaits(flightKey: number): Promise<boolean> {
	const [row] = (await sql.unsafe(
		`SELECT EXISTS (SELECT 1 ${FLIGHT_LOCK_ROWS} AND NOT l.granted) AS waits`,
		[RELATION_TARGETS_FLIGHT_LOCK_CLASS, flightKey],
	)) as { waits: boolean }[];
	return row?.waits === true;
}

/**
 * Claim the session's census flight (module header): cancel every earlier
 * census holding or awaiting it, then take the transaction-scoped lock under
 * the clock (it waits only for the victims' rollback).
 */
async function claimFlight(flightKey: number, clock: CensusClock): Promise<void> {
	const params = [RELATION_TARGETS_FLIGHT_LOCK_CLASS, flightKey];
	await clock.arm();
	const victims = (await sql.unsafe(
		'SELECT a.pid, a.xact_start::text AS xact_start FROM pg_stat_activity a ' +
			'WHERE a.xact_start IS NOT NULL AND a.datname = current_database() ' +
			`AND a.pid IN (SELECT l.pid ${FLIGHT_LOCK_ROWS})`,
		params,
	)) as { pid: number; xact_start: string }[];
	for (const victim of victims) {
		await cancelBackendStatement(
			{ pid: victim.pid, xactStart: victim.xact_start },
			'relation_targets',
		);
	}
	await clock.arm();
	// The class bound INLINE: advisory_lock_class_tripwire reads the site's own list.
	await sql.unsafe('SELECT pg_advisory_xact_lock($1::int, $2::int)', [
		RELATION_TARGETS_FLIGHT_LOCK_CLASS,
		flightKey,
	]);
	clock.holdFlight();
}

/** The typed refusal of a census a newer one of the same session superseded. */
function superseded(cause?: unknown): DedaloError {
	return new DedaloError('resource.conflict', {
		message: 'relation_targets: superseded by a newer census of the same session',
		publicMessage:
			'Superseded by a newer relationships count of this session (another tab or window)',
		...(cause === undefined ? {} : { cause }),
		coordinates: { door: 'relation_targets', reason: 'superseded' },
	});
}

/** The typed refusal of a census past its whole budget. */
function budgetExhausted(budgetMs: number, cause?: unknown): DedaloError {
	return new DedaloError('db.statement_timeout', {
		message: `relation_targets: the census ran past its ${budgetMs}ms budget`,
		...(cause === undefined ? {} : { cause }),
		coordinates: { door: 'relation_targets', ceiling_ms: budgetMs },
	});
}

/** The source with the effective from_component_tipo (two different ones refused). */
function withFromComponent(
	source: ReferencedBySource,
	fromComponentTipo: string | undefined,
): ReferencedBySource {
	if (fromComponentTipo === undefined) return source;
	const declared = source.from_component_tipo;
	if (declared !== undefined && declared !== fromComponentTipo) {
		throw new DedaloError('request.invalid_options', {
			message: `relation_targets: from_component_tipo '${fromComponentTipo}' contradicts the source's '${declared}'`,
			publicMessage: 'Invalid relation_targets request: two different from_component_tipo values',
		});
	}
	return { ...source, from_component_tipo: fromComponentTipo };
}

/**
 * The census's distinct (target_section_tipo, target_section_id) pairs, a
 * transaction-scoped temp table (ON COMMIT DROP — it never outlives the unit,
 * so it never reaches the next user of the pooled connection). Schema-qualified
 * `pg_temp.` so no statement can ever name a real table.
 */
const CENSUS_TARGETS = 'pg_temp.dedalo_census_targets';

/**
 * Statement 0, THE ONE EXPANSION: the source rows' stored locators, read once,
 * reduced to their distinct target pairs. Both later statements read this
 * table, so the source row set (the unbounded found set, a full read of its
 * wide rows) is never evaluated twice. A NULL id (a locator the index cannot
 * address) is kept as its tipo's one NULL row: statement 1 counts `count(id)`
 * (NULLs skipped, as before) and a NULL never matches statement 2's IN.
 * `DROP … IF EXISTS` first: inside a caller's transaction a second census
 * would otherwise find the first one's table. ONE NAME PER CONNECTION: two
 * censuses run CONCURRENTLY on one transaction (Promise.all inside one unit)
 * would replace each other's table between statements — callers run them in
 * sequence (the API door never runs inside a transaction). Then ANALYZE: a temp
 * table has no statistics (autovacuum never sees it), and statement 2 is a plain
 * semi-join whose plan rests on them (see exactBranch).
 */
async function materializeTargets(
	owner: OwnerRelationScope,
	clock: CensusClock | null,
): Promise<void> {
	await sql.unsafe(`DROP TABLE IF EXISTS ${CENSUS_TARGETS}`, []);
	const params = new ParamsCollector();
	const locators = params.substitute(owner.locatorsSql, owner.tokenValues);
	await clock?.arm();
	await sql.unsafe(
		`CREATE TEMP TABLE ${CENSUS_TARGETS} ON COMMIT DROP AS ` +
			'SELECT DISTINCT l.target_section_tipo AS tipo, l.target_section_id AS id ' +
			`FROM (${locators}) AS l WHERE l.target_section_tipo IS NOT NULL`,
		params.toArray() as (string | number | null)[],
	);
	await clock?.arm();
	await sql.unsafe(`ANALYZE ${CENSUS_TARGETS}`, []);
}

/**
 * Statement 1, the grouped census: [tipo, upper-bound total] per target section.
 * Over the already-distinct pairs a plain grouped count is a hash aggregate — a
 * `count(DISTINCT …)` over the raw locators always sorted (measured 2026-10-31:
 * a 126 MB on-disk merge for a 184k-record source, half the census time).
 */
async function groupedTargets(clock: CensusClock | null): Promise<RelationTargetCount[]> {
	await clock?.arm();
	const rows = (await sql.unsafe(
		`SELECT t.tipo, count(t.id)::int AS total FROM ${CENSUS_TARGETS} AS t ` +
			'GROUP BY t.tipo ORDER BY t.tipo',
		[],
	)) as { tipo: string; total: number | string }[];
	return rows.map((row) => ({ tipo: row.tipo, total: Number(row.total) }));
}

/**
 * Can this target be opened as a window at all? A valid tipo whose record table
 * is a matrix record store, readable by the principal. A stored locator naming
 * anything else (a retired section, a non-record table) is reported to the
 * operator, never offered.
 */
async function targetIsOpenable(tipo: string, principal: Principal | undefined): Promise<boolean> {
	const table = isValidTipo(tipo) ? await getMatrixTableFromTipo(tipo) : null;
	if (table === null || !isMatrixTable(table)) {
		console.warn(
			`[relation_targets] target section ${JSON.stringify(tipo)} has no record table — not offered`,
		);
		return false;
	}
	return principal === undefined || (await getPermissions(principal, tipo, tipo)) >= 1;
}

/**
 * One target's branch of statement 2: T's scoped row set (the window's own
 * WHERE, no filter) counted where its identity is one of the census targets.
 * A PLAIN semi-join over the ANALYZEd temp table — NOT the leaf's
 * `(…) IN (…) IS TRUE` hashed-SubPlan shape (builder_referenced_by.ts), which
 * exists for an expansion the planner cannot estimate. Over real statistics
 * that shape is a trap: a SubPlan is hashed only while its ESTIMATED size fits
 * hash_mem, so a large, accurately estimated target set (428k pairs) turns it
 * into a SubPlan re-scanned once per T row — measured 2026-10-31: past 60 s,
 * against 0.26 s for the planner's own Hash Semi Join over the same table.
 */
async function exactBranch(
	tipo: string,
	index: number,
	principal: Principal | undefined,
	params: ParamsCollector,
): Promise<string> {
	const rowSet = await buildScopedRowSetSql({ section_tipo: [tipo] } as unknown as Sqo, {
		...(principal === undefined ? {} : { principal }),
		tokens: new NamedTokenCollector(`RT${index}x`),
		alias: `rt${index}`,
		depth: 0,
	});
	const rows = params.substitute(rowSet.sql, rowSet.tokenValues);
	const tipoParam = params.getPlaceholder(tipo);
	return (
		`SELECT ${tipoParam}::text AS tipo, (SELECT count(*) FROM (${rows}) AS rtw${index} ` +
		`WHERE (rtw${index}.section_tipo, rtw${index}.section_id) IN ` +
		`(SELECT ct.tipo, ct.id FROM ${CENSUS_TARGETS} ct WHERE ct.tipo = ${tipoParam}::text))::int AS total`
	);
}

/** Statement 2: every kept target's exact total, over the materialized pairs. */
async function exactTargetTotals(
	tipos: readonly string[],
	principal: Principal | undefined,
	clock: CensusClock | null,
): Promise<Map<string, number>> {
	const totals = new Map<string, number>();
	if (tipos.length === 0) return totals;
	const params = new ParamsCollector();
	const branches: string[] = [];
	for (const [index, tipo] of tipos.entries()) {
		branches.push(await exactBranch(tipo, index + 1, principal, params));
	}
	await clock?.arm();
	const rows = (await sql.unsafe(
		branches.join(' UNION ALL '),
		params.toArray() as (string | number | null)[],
	)) as { tipo: string; total: number | string }[];
	for (const row of rows) totals.set(row.tipo, Number(row.total));
	return totals;
}

/** Statement 1 plus the openable filter: the grouped targets the principal may open. */
async function openableTargets(
	principal: Principal | undefined,
	clock: CensusClock | null,
): Promise<RelationTargetCount[]> {
	const candidates: RelationTargetCount[] = [];
	for (const candidate of await groupedTargets(clock)) {
		if (await targetIsOpenable(candidate.tipo, principal)) candidates.push(candidate);
	}
	return candidates;
}

/** Statement 2 over the openable candidates: each one's exact total, zero totals dropped. */
async function exactCounts(
	candidates: readonly RelationTargetCount[],
	principal: Principal | undefined,
	clock: CensusClock | null,
): Promise<RelationTargetCount[]> {
	const totals = await exactTargetTotals(
		candidates.map((candidate) => candidate.tipo),
		principal,
		clock,
	);
	const counts: RelationTargetCount[] = [];
	for (const candidate of candidates) {
		const total = totals.get(candidate.tipo) ?? 0;
		if (total > 0) counts.push({ tipo: candidate.tipo, total });
	}
	return counts;
}

/** The census proper: the one expansion (statement 0), statement 1 + the openable filter, statement 2. */
async function runCensus(
	source: ReferencedBySource,
	principal: Principal | undefined,
	exact: boolean,
	clock: CensusClock | null,
): Promise<RelationTargetCount[]> {
	const owner = await buildOwnerRelationScope(source, {
		...(principal === undefined ? {} : { principal }),
		depth: 1,
	});
	if (owner === null) return [];
	await materializeTargets(owner, clock);
	const candidates = await openableTargets(principal, clock);
	const counts = exact
		? await exactCounts(candidates, principal, clock)
		: candidates.filter((candidate) => candidate.total > 0);
	// Inside a caller's transaction ON COMMIT DROP would keep it until that unit ends.
	await sql.unsafe(`DROP TABLE IF EXISTS ${CENSUS_TARGETS}`, []);
	return counts;
}

/** The budget actually applied: the census's own (or the gate override), never above the pool ceiling. */
function effectiveBudgetMs(override: number | undefined): number {
	if (override !== undefined && !(Number.isFinite(override) && override > 0)) {
		throw new DedaloError('internal.invariant', {
			message: `relation_targets: budgetMs must be a positive finite number of ms (got ${override})`,
		});
	}
	const budgetMs = override ?? RELATION_TARGETS_BUDGET_MS;
	const poolCeilingMs = config.ops.dbStatementTimeoutMs;
	return poolCeilingMs > 0 ? Math.min(poolCeilingMs, budgetMs) : budgetMs;
}

/** The advisory-lock key of a supersession flight, or null when the census runs unflighted. */
function censusFlightKey(supersessionKey: string | undefined): number | null {
	return supersessionKey === undefined || supersessionKey === ''
		? null
		: relationTargetsFlightKey(supersessionKey);
}

/**
 * A raw 57014 (not the clock's typed ceiling) inside a flight is the newer
 * census's cancel: this one was superseded.
 */
function isSupersededCancel(error: unknown, flightKey: number | null): boolean {
	return flightKey !== null && !isDedaloError(error) && sqlStateOf(error) === '57014';
}

/** The error a failed census throws: a supersession, a door-stated timeout, or the original. */
function censusFailure(error: unknown, flightKey: number | null, budgetMs: number): unknown {
	if (isSupersededCancel(error, flightKey)) return superseded(error);
	if (isDedaloError(error) && error.code === 'db.statement_timeout') {
		// The clock's own refusal is already the door's; a statement the server
		// stopped is re-stated with the door's coordinates.
		const own = error.coordinates?.door === 'relation_targets';
		return own ? error : budgetExhausted(budgetMs, error);
	}
	return error;
}

/**
 * The target sections a source set references, each with its record total
 * (see the module header for exact vs upper bound, and the budget). The source
 * is a parsed `ReferencedBySource` — an untrusted one goes through
 * `sanitizeClientReferencedBySource` (concepts/sqo.ts) first.
 *
 * Throws `request.invalid_options`, `request.invalid_tipo`, `perm.denied` (no
 * read on a source section), `db.statement_timeout` (the census ran past its
 * whole budget), `resource.conflict` (superseded by a newer census carrying the
 * same `supersessionKey`).
 */
export async function countRelationTargets(
	source: ReferencedBySource,
	options: RelationTargetOptions = {},
): Promise<RelationTargetCount[]> {
	const effective = withFromComponent(source, options.fromComponentTipo);
	const principal = options.principal;
	const exact = options.exact !== false;
	if (isInTransaction()) return runCensus(effective, principal, exact, null);
	const budgetMs = effectiveBudgetMs(options.budgetMs);
	const flightKey = censusFlightKey(options.supersessionKey);
	try {
		return await withTransaction(async () => {
			const clock = startClock(budgetMs, flightKey);
			if (flightKey !== null) await claimFlight(flightKey, clock);
			return runCensus(effective, principal, exact, clock);
		});
	} catch (error) {
		throw censusFailure(error, flightKey, budgetMs);
	}
}
