/**
 * THE SEARCH STATEMENT AND ITS ONE EXECUTOR (WC-2026-10-30-search-referenced-by-leaf).
 *
 * Every statement the search assembler builds (sql_assembler.ts
 * `buildSearchSql`, which covers the plain search and the children_recursive
 * pre-pass) is a {@link SearchStatement}: its SQL text and bound values are
 * `#private`, so outside this module nothing can hand them to `sql.unsafe` — a
 * search runs ONLY through the doors below, and the type checker refuses any
 * other path. The doors:
 *
 *  - {@link runSearch} — execute one statement (the rows).
 *  - {@link wrapSearch} — embed a statement in an outer one (the diffusion
 *    keyset batch); the result is again a SearchStatement and inherits the flag.
 *  - {@link searchCursorSource} — the selection a server-side cursor declares
 *    (diffusion/export/selection_cursor.ts), with the budget it must arm.
 *  - {@link searchStatementText} — INSPECTION ONLY (the admin SQL console's
 *    display, tests); never executed.
 *
 * The importers of the last three, and of {@link createSearchStatement}, are
 * pinned exactly by test/unit/search_statement_chokepoint_tripwire.test.ts.
 *
 * THE `referenced_by` BOUND. A statement into which a `referenced_by` leaf
 * RENDERED (`carriesReferencedBy` — set by the build itself, ParamsCollector
 * `carriesReferencedBy`, never by re-walking an SQO a caller could swap)
 * expands every source row's stored `relation` column inside the statement; its
 * cost grows with the source set (a degraded plan measured ~4 s flat, >20 s at
 * nesting depth 4) and the request pool's own ceiling (DB_STATEMENT_TIMEOUT_MS)
 * defaults to 0 = none. So such a statement runs under
 * `SET LOCAL statement_timeout = <budget>` (REFERENCED_BY_SEARCH_BUDGET_MS, never
 * above the ceiling in force) — in its own transaction, or, inside a caller's
 * transaction (any lane), under a savepoint that restores the caller's ceiling
 * (postgres.ts `withStatementBudget`). Past it: the typed 503
 * `db.statement_timeout`, coordinates `{ door: 'referenced_by_search',
 * ceiling_ms }`. A statement WITHOUT the leaf runs exactly as before: one
 * `sql.unsafe`, pooled or on the caller's transaction, under that lane's ceiling.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { sql, withStatementBudget } from '../db/postgres.ts';
import { DedaloError, isDedaloError } from '../errors/dedalo_error.ts';

/**
 * The per-statement budget (ms) of a search carrying a `referenced_by` leaf.
 * The sibling of RELATION_TARGETS_BUDGET_MS (the census that offers the
 * window): the window's own page and count may each spend what the census
 * that sized it was allowed to.
 */
export const REFERENCED_BY_SEARCH_BUDGET_MS = 30_000;

/** The capability only this module holds: build or open a SearchStatement. */
const ACCESS: unique symbol = Symbol('search_statement.access');

/** A built search statement — opaque outside this module (module header). */
export class SearchStatement {
	readonly #sql: string;
	readonly #params: readonly unknown[];
	/** A `referenced_by` expansion rendered into this statement (module header). */
	readonly carriesReferencedBy: boolean;

	constructor(
		access: typeof ACCESS,
		sqlText: string,
		params: readonly unknown[],
		carriesReferencedBy: boolean,
	) {
		if (access !== ACCESS) {
			throw new DedaloError('internal.invariant', {
				message: 'SearchStatement: built only by search/search_statement.ts',
			});
		}
		this.#sql = sqlText;
		this.#params = Object.freeze([...params]);
		this.carriesReferencedBy = carriesReferencedBy;
	}

	/** The text and values — for this module's doors only (the capability check). */
	static open(
		statement: SearchStatement,
		access: symbol,
	): { sql: string; params: readonly unknown[] } {
		if (access !== ACCESS) {
			throw new DedaloError('internal.invariant', {
				message: 'SearchStatement: opened only by search/search_statement.ts',
			});
		}
		return { sql: statement.#sql, params: statement.#params };
	}
}

/**
 * Build a statement. The ASSEMBLER's door (sql_assembler.ts) — `carriesReferencedBy`
 * is what its ParamsCollector recorded while rendering. (Gates may build one
 * around a probe statement.)
 */
export function createSearchStatement(
	sqlText: string,
	params: readonly unknown[],
	carriesReferencedBy: boolean,
): SearchStatement {
	return new SearchStatement(ACCESS, sqlText, params, carriesReferencedBy);
}

/** Internal options of {@link runSearch} — never from the wire. */
export interface SearchStatementOptions {
	/**
	 * INTERNAL, never from the wire: replace REFERENCED_BY_SEARCH_BUDGET_MS
	 * (still never above the ceiling in force) — a gate forces the bound with a
	 * small budget. A positive finite number of ms; a budget under 1 ms leaves no
	 * whole ms, so the statement is refused before it is sent. Anything else is
	 * `internal.invariant`. Ignored for a statement without the leaf.
	 */
	budgetMs?: number;
}

/**
 * @internal TEST SEAM (named exemption, DEC-12): a budget override for every
 * leaf-carrying statement executed inside {@link withSearchBudgetOverride} —
 * request-scoped (ALS), so it cannot bleed into another request. Lets a gate
 * prove that a door which takes no options (read_raw, the MCP search, a tool)
 * runs its search through the bound.
 */
const budgetOverrideStore = new AsyncLocalStorage<number>();

/** @internal TEST SEAM — see {@link budgetOverrideStore}. */
export function withSearchBudgetOverride<T>(budgetMs: number, work: () => Promise<T>): Promise<T> {
	return budgetOverrideStore.run(budgetMs, work);
}

/** The budget asked for: the explicit option, else the seam, else the bound's own. */
function requestedBudgetMs(override: number | undefined): number {
	const budgetMs = override ?? budgetOverrideStore.getStore() ?? REFERENCED_BY_SEARCH_BUDGET_MS;
	if (!(Number.isFinite(budgetMs) && budgetMs > 0)) {
		throw new DedaloError('internal.invariant', {
			message: `referenced_by search: budgetMs must be a positive finite number of ms (got ${budgetMs})`,
		});
	}
	return budgetMs;
}

/**
 * The budget a leaf-carrying statement arms, in whole ms (≥ 1), or the typed
 * refusal when none is left; `null` for a statement without the leaf.
 */
function armedBudgetMs(statement: SearchStatement, override: number | undefined): number | null {
	if (!statement.carriesReferencedBy) return null;
	const budgetMs = requestedBudgetMs(override);
	const wholeMs = Math.floor(budgetMs);
	if (wholeMs < 1) throw referencedBySearchTimeout(budgetMs);
	return wholeMs;
}

/**
 * The typed refusal of a referenced_by search past its budget. Exported for
 * the export selection cursor, which arms the same budget as a
 * `transaction_timeout` (searchCursorSource).
 */
export function referencedBySearchTimeout(ceilingMs: number, cause?: unknown): DedaloError {
	return new DedaloError('db.statement_timeout', {
		message: `referenced_by search: the statement ran past its ${ceilingMs}ms budget`,
		...(cause === undefined ? {} : { cause }),
		coordinates: { door: 'referenced_by_search', ceiling_ms: ceilingMs },
	});
}

/**
 * THE EXECUTOR: run one search statement, bounded when a `referenced_by` leaf
 * rendered into it (module header), exactly as a plain `sql.unsafe` otherwise.
 */
export async function runSearch<Row>(
	statement: SearchStatement,
	options: SearchStatementOptions = {},
): Promise<Row[]> {
	const { sql: text, params } = SearchStatement.open(statement, ACCESS);
	const execute = async () => (await sql.unsafe(text, [...params] as never)) as Row[];
	const budgetMs = armedBudgetMs(statement, options.budgetMs);
	if (budgetMs === null) return execute();
	let appliedMs = budgetMs;
	try {
		return await withStatementBudget(budgetMs, (applied) => {
			appliedMs = applied;
			return execute();
		});
	} catch (error) {
		if (isDedaloError(error) && error.code === 'db.statement_timeout') {
			// A statement the server stopped (typed by the transaction lane's
			// recorder) is re-stated with the door's coordinates.
			throw error.coordinates?.door === 'referenced_by_search'
				? error
				: referencedBySearchTimeout(appliedMs, error);
		}
		throw error;
	}
}

/**
 * Embed `statement` in an outer one: `wrap(inner, next)` receives the inner
 * text WITHOUT its terminating `;` and the first free placeholder number
 * (`$next` binds `extraParams[0]`, …). The result is a SearchStatement with the
 * same flag, so the outer statement is bounded exactly when the inner one is.
 */
export function wrapSearch(
	statement: SearchStatement,
	wrap: (innerSql: string, nextPlaceholder: number) => string,
	extraParams: readonly unknown[],
): SearchStatement {
	const { sql: text, params } = SearchStatement.open(statement, ACCESS);
	const inner = text.trim().replace(/;$/, '');
	return createSearchStatement(
		wrap(inner, params.length + 1),
		[...params, ...extraParams],
		statement.carriesReferencedBy,
	);
}

/**
 * The selection a server-side cursor declares over `statement` (no trailing
 * `;`), and the budget (whole ms) its transaction must arm when a
 * `referenced_by` leaf rendered into it — `null` otherwise. A WITH HOLD cursor
 * computes its whole selection in the COMMIT, where PostgreSQL has already
 * disarmed `statement_timeout`, so the cursor arms the budget as its
 * `transaction_timeout` (selection_cursor.ts); its FETCHes then read the
 * materialized rows.
 */
export function searchCursorSource(
	statement: SearchStatement,
	options: SearchStatementOptions = {},
): { selection: string; params: readonly unknown[]; budgetMs: number | null } {
	const { sql: text, params } = SearchStatement.open(statement, ACCESS);
	return {
		selection: text.replace(/;\s*$/, ''),
		params,
		budgetMs: armedBudgetMs(statement, options.budgetMs),
	};
}

/**
 * INSPECTION ONLY: the statement's text and values, to SHOW (the admin SQL
 * console, dd_utils_api convert_search_object_to_sql_query) or to assert in a
 * gate. Executing what this returns is the bypass the chokepoint tripwire
 * forbids — its importers are pinned.
 */
export function searchStatementText(statement: SearchStatement): {
	sql: string;
	params: readonly unknown[];
	carriesReferencedBy: boolean;
} {
	return {
		...SearchStatement.open(statement, ACCESS),
		carriesReferencedBy: statement.carriesReferencedBy,
	};
}
