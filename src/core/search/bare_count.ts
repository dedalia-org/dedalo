/**
 * Browse COUNT(*) cache for the list paginator.
 *
 * On a 33 M-row matrix_activity the paginator total is a ~2.5 s parallel
 * index-only scan, and the deep-page order-flip (sql_assembler flattened path)
 * needs that exact total to fetch a far page from the opposite end. Both want
 * the SAME number, and it changes only when the section grows — i.e. on a save.
 * So cache it, save-event invalidated BY CONSTRUCTION (createDataCache): every
 * persistent record write clears it, with TM_COUNT_CACHE_TTL_MS as the
 * freshness backstop for out-of-band inserts. TTL 0 disables (exact every call
 * — the parity-environment setting).
 *
 * TWO SCOPES, one cache, one door (scopedBrowseCount — both consumers, the
 * paginator total and the deep-page flip, go through sql_assembler
 * cachedBrowseTotal, so they share one key):
 * - BARE: the UNFILTERED browse of ONE section.
 * - ACL-SCOPED: the same browse as a NON-ADMIN sees it — the projects /
 *   filter_records predicate and nothing else (PERF-10). That paint is the
 *   ordinary case, not the exception: a non-admin's ACL predicate lands in
 *   whereParts, so the bare short-circuit could never fire for them and every
 *   single list paint re-counted the section. It is cached under the RENDERED
 *   predicate and its bound values, so two principals with different grants —
 *   and the same principal after a grant change, which re-renders the
 *   predicate — can never read each other's total.
 *
 * A count carrying a CLIENT filter is request-specific and is never routed
 * here. Mirrors read_tm.ts tmCount, which owns the matrix_time_machine twin.
 */

import { config } from '../../config/config.ts';
import { sql } from '../db/postgres.ts';
import { createDataCache } from '../ontology/cache_factory.ts';

const browseCountCache = createDataCache<string, { value: number; at: number }>((cache) =>
	cache.clear(),
);

/** matrixTable is ontology-resolved and spliced into SQL — guard defensively. */
function assertMatrixTable(matrixTable: string): void {
	if (!/^matrix[a-z0-9_]*$/.test(matrixTable)) {
		throw new Error(`browse count: refusing non-matrix table '${matrixTable}'`);
	}
}

/**
 * Run `countSql` under the TTL-floored cache. The query must return ONE row
 * whose FIRST column is the count — read positionally, so the assembler can
 * hand over its own `count(*) as full_count` query verbatim.
 */
async function cachedCount(cacheKey: string, countSql: string, params: unknown[]): Promise<number> {
	const ttl = config.ops.tmCountCacheTtlMs;
	if (ttl > 0) {
		const hit = browseCountCache.get(cacheKey);
		if (hit !== undefined && Date.now() - hit.at < ttl) return hit.value;
	}
	const rows = (await sql.unsafe(countSql, params as (string | number | null)[])) as Record<
		string,
		unknown
	>[];
	const first = rows[0];
	const value = Number(first === undefined ? 0 : (Object.values(first)[0] ?? 0));
	if (ttl > 0) browseCountCache.set(cacheKey, { value, at: Date.now() });
	return value;
}

/**
 * The browse count of a paint whose WHERE holds no client filter (PERF-10) —
 * the bare browse and the ACL-scoped one alike.
 *
 * `countSql` is the assembler's OWN full_count query, never re-derived here, so
 * the cached number is BY CONSTRUCTION the number the uncached paint would have
 * produced — including whatever else the main WHERE carries (the users
 * section's root-record exclusion, say), which a re-derived `count(*) WHERE
 * section_tipo` would silently drop. `scopeSignature` must determine that
 * query completely: the assembler passes the rendered predicate plus its bound
 * values, which is exactly what changes when the principal's grants change.
 */
export async function scopedBrowseCount(
	matrixTable: string,
	sectionTipo: string,
	scopeSignature: string,
	countSql: string,
	params: unknown[],
): Promise<number> {
	assertMatrixTable(matrixTable);
	return cachedCount(`scoped ${matrixTable} ${sectionTipo} ${scopeSignature}`, countSql, params);
}
