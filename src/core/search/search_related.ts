/**
 * search_related — the inverse-relation engine (SQO mode 'related'; PHP
 * class.search_related). Answers "which records link TO these targets?" —
 * the back-link machinery behind relation_list panels, inverse-reference
 * checks, and delete propagation.
 *
 * ONE ROW-SET ENGINE (2026-07-20): matrix_relation_index is THE relation
 * search. Finds/counts run as ONE btree query over the typed per-locator
 * index — measured 7-19× faster than the retired flat GIN, with honest
 * planner statistics. Locator narrowing dispatch (locatorIndexClause) mirrors
 * the v6-era switch exactly:
 *   1. no section_id + type    → (type, target_section_tipo)
 *   2. from_component_tipo     → (fct, target st, target si)
 *   3. type + section_id       → (type, target st, target si)
 *   4. default                 → (target st, target si)
 *
 * The v6-era pre-flattening functions (data_relations_flat_*) and their SQL
 * paths were REMOVED outright with their GIN indexes — v7 ships no legacy
 * engine. Coverage (triggers + backfill, requireRelationIndex) is therefore a
 * REQUIREMENT: an uncovered instance fails loudly with the maintenance
 * remediation instead of degrading (never silently narrow scope).
 *
 * Tables: the ontology-enumerated relation-capable matrix tables (dd627
 * children with properties.inverse_relations === true; matrix_test joins in
 * dev, matching this install's PHP).
 *
 * COUNT (countInverseReferences): the relation_list paginator total — the
 * owners of the find engine's own question counted in SQL, optionally grouped
 * by section_tipo (the only grouping any caller uses; identifier-regex-validated,
 * PHP SEC rule).
 *
 * ONE SCOPED QUESTION (D1, 2026-10-21): this sink is principal-free, but its
 * user-facing askers — the page (findInverseReferences), the count and the
 * past-the-page probe (anyInverseReferencePast) — take the caller's `scope`
 * (security/record_scope.ts rowScopeFor) and apply it IN SQL to the same owner
 * question (inverseReferencesQuery) before counting / windowing / probing. So
 * the count equals the paged walk equals the probe for every principal, and no
 * asker enumerates owners into the application to filter them there.
 *
 * BREAKDOWN (findInverseReferenceLocators): cross-join with
 * jsonb_path_query(relation, '$.*[*]') so each individual locator entry is
 * its own row, narrowed by locator_data field equalities — the exact-locator
 * recovery used by delete propagation and reference rewrites. Since 2026-08-07
 * it resolves the OWNERS first (one standalone index probe) and carries them
 * into the UNION as array parameters; the planner cannot be trusted to cost
 * the inline semi-join (see the function's own note).
 *
 * filter_by_locators_op: OR (default) and AND are both modeled — AND
 * returns only records whose relation column matches EVERY locator.
 */

import { assertMatrixTable } from '../db/matrix.ts';
import { sql } from '../db/postgres.ts';
import { DedaloError } from '../errors/dedalo_error.ts';
import { registerOntologyCacheClearer } from '../ontology/cache_invalidation.ts';
import { nameOrLabelOf } from '../ontology/labels.ts';
import { getMatrixTableFromTipo } from '../ontology/resolver.ts';
import { assertValidTipo, VALID_DATA_COLUMNS } from './identifier_gate.ts';
import { requireRelationIndex } from './search_store.ts';

/** One inverse-reference hit: the record that HOLDS the pointing locator. */
export interface InverseReferenceHit {
	section_tipo: string;
	section_id: number;
	table: string;
}

export interface RelatedLocatorFilter {
	section_tipo: string;
	/**
	 * KEPT UNION: the probe target as the CALLER holds it — canonicalized
	 * stored locators (buildRelatedSections) still carry the verbatim form of
	 * anything not convertible. The two clause builders normalize per column:
	 * `locatorIndexClause` casts to the int index column, `locatorDataFieldClauses`
	 * compares the raw jsonb text (see their asymmetry note).
	 */
	section_id?: string | number;
	from_component_tipo?: string;
	type?: string;
}

/**
 * THE sink page window (READ-4) — the one place the relation sink turns a
 * caller's limit/offset into the numbers it interpolates into `LIMIT` /
 * `OFFSET` (both sinks, and the JS window of the `tables` branch).
 *
 * TOLERANT of every window a SERVER caller legitimately passes, rendered
 * exactly as before: `false` / `undefined` = no LIMIT; any value whose
 * `Number(v)` is finite with |floor| <= MAX_SAFE_INTEGER — numeric strings, 0
 * (still "at least one": `max(1, floor)`), over-ceiling ontology limits. No
 * ceiling here: CLIENT pages are bounded at their doors (clampClientPage) and
 * at the wire (wireSqoSchema); the sink only refuses what it cannot NAME.
 *
 * REFUSES — a typed `search.invalid_sqo` (400) naming the value — NaN,
 * ±Infinity, non-numeric strings, and anything past MAX_SAFE_INTEGER. Before,
 * those rendered `LIMIT NaN` / `LIMIT 1e+21` (a raw Postgres 500) or dropped a
 * non-numeric offset silently (page 1 served for any page asked).
 *
 * @returns limit — the LIMIT to render (null = none); offset — the rows to skip (0 = none)
 */
export function pageWindow(
	limit: unknown,
	offset: unknown,
	door: string,
): { limit: number | null; offset: number } {
	const nameable = (value: unknown): number | null => {
		const numeric = Math.floor(Number(value));
		return Number.isFinite(numeric) && Math.abs(numeric) <= Number.MAX_SAFE_INTEGER
			? numeric
			: null;
	};
	const refuse = (key: 'limit' | 'offset', value: unknown): never => {
		const shown = typeof value === 'string' ? JSON.stringify(value.slice(0, 32)) : String(value);
		throw new DedaloError('search.invalid_sqo', {
			message: `${door}: ${key} ${shown} is not a page window the search can render`,
			publicMessage: `The search ${key} is not a valid number`,
		});
	};
	let windowLimit: number | null = null;
	if (limit !== false && limit !== undefined) {
		const numeric = nameable(limit);
		windowLimit = numeric === null ? refuse('limit', limit) : Math.max(1, numeric);
	}
	let windowOffset = 0;
	if (offset !== undefined) {
		const numeric = nameable(offset);
		windowOffset = numeric === null ? refuse('offset', offset) : Math.max(0, numeric);
	}
	return { limit: windowLimit, offset: windowOffset };
}

/** Cached relation-capable table list (ontology dd627 walk). */
let relationTablesCache: string[] | null = null;

export function clearRelatedTablesCache(): void {
	relationTablesCache = null;
}
registerOntologyCacheClearer(clearRelatedTablesCache);

/**
 * The matrix tables that participate in inverse-relation searches (PHP
 * common::get_matrix_tables_with_relations): dd627 children of model
 * matrix_table with properties.inverse_relations === true, plus matrix_test
 * (this server always runs in the development posture PHP gates it behind).
 */
export async function getRelationTables(): Promise<string[]> {
	if (relationTablesCache !== null) return relationTablesCache;
	// The table name is the matrix_table node's MACHINE NAME (a name model —
	// ontology/machine_name.ts), never a label lang: the same reading as
	// resolver.ts relatedMatrixTable (labels.ts nameOrLabelOf, which also
	// bridges a row no parser has derived yet to the legacy lg-spa reading).
	const rows = (await sql`
		SELECT term, machine_name, use_machine_name, properties
		FROM dd_ontology
		WHERE parent = 'dd627' AND model = 'matrix_table'
	`) as {
		term: Record<string, string> | null;
		machine_name: string | null;
		use_machine_name: boolean | null;
		properties: { inverse_relations?: boolean } | null;
	}[];
	const tables: string[] = [];
	for (const node of rows) {
		const row = { table_name: nameOrLabelOf(node), properties: node.properties };
		if (row.table_name === null) continue;
		const include = row.properties?.inverse_relations === true || row.table_name === 'matrix_test';
		if (!include) continue;
		// The name is interpolated into FROM/JOIN downstream; assert it against the
		// allowlist (L2) so a poisoned ontology term can never reach SQL verbatim.
		assertMatrixTable(row.table_name);
		tables.push(row.table_name);
	}
	if (tables.length === 0) {
		// PHP fallback for pre-2018 ontologies — deny loudly instead (a silent
		// default list could hide an ontology-read failure).
		throw new Error('search_related: no relation-capable tables resolved from the ontology');
	}
	relationTablesCache = tables;
	return tables;
}

/**
 * matrix_relation_index column predicate for one locator — the typed twin of
 * locatorClause (same narrowing dispatch, same validation), used when every
 * table in play is index-covered (relationIndexCovers). Values ride as bound
 * params via `push`.
 */
function locatorIndexClause(
	locator: RelatedLocatorFilter,
	push: (value: string) => string,
): string {
	const sectionTipo = assertValidTipo(locator.section_tipo, 'search_related.section_tipo');
	const sectionId =
		locator.section_id === undefined || locator.section_id === null
			? null
			: String(Number(locator.section_id));
	const parts: string[] = [`r.target_section_tipo = ${push(sectionTipo)}::text`];
	if (sectionId === null && typeof locator.type === 'string') {
		parts.push(`r.type = ${push(assertValidTipo(locator.type, 'search_related.type'))}::text`);
		return `(${parts.join(' AND ')})`;
	}
	if (sectionId === null) {
		throw new DedaloError('search.invalid_sqo', {
			message: 'search_related: a locator needs a section_id or a type',
			publicMessage: 'A related-search locator needs a section_id or a type',
		});
	}
	parts.push(`r.target_section_id = ${push(sectionId)}::int`);
	if (typeof locator.from_component_tipo === 'string' && locator.from_component_tipo !== '') {
		parts.push(
			`r.from_component_tipo = ${push(assertValidTipo(locator.from_component_tipo, 'search_related.fct'))}::text`,
		);
	} else if (typeof locator.type === 'string' && locator.type !== '') {
		parts.push(`r.type = ${push(assertValidTipo(locator.type, 'search_related.type'))}::text`);
	}
	return `(${parts.join(' AND ')})`;
}

/**
 * The find engine: one query over matrix_relation_index. Semantics preserved
 * from the retired containment SQL exactly: GROUP BY (owner) dedups locator
 * multiplicity the way per-row `@>` containment did; op AND = HAVING bool_or
 * per clause; the `table` field is resolved from section_tipo (cached
 * resolver) and the 'table' ordering is reproduced IN SQL via a CASE over the
 * (small) set of owning tipos so LIMIT/OFFSET stay correct. Measured vs the
 * retired flat GIN: st_si 14→0.3ms, fct_st_si 6→0.2ms, ty_st 1014→54ms.
 *
 * SCOPED (D1, 2026-10-21): with `options.scope` the owner set is narrowed IN
 * SQL before it is ordered and windowed — the page is a window of the SCOPED
 * sequence, the same set countInverseReferences counts and
 * anyInverseReferencePast probes. Without it (system walks) the SQL is the
 * unscoped question, unchanged.
 */
async function findInverseReferencesViaIndex(
	locators: RelatedLocatorFilter[],
	options: NonNullable<Parameters<typeof findInverseReferences>[1]>,
): Promise<InverseReferenceHit[]> {
	const question = await inverseReferencesQuery(locators, options);
	const scoped = await scopedQuestion(question, options.scope);
	const params = [...scoped.params];
	const push = (value: string): string => {
		params.push(value);
		return `$${params.length}`;
	};
	const { orderSql, tableByTipo } = await inverseReferencesOrder(options.order, question, push);

	// options.tables narrowing (children engine): table = f(section_tipo),
	// which the SQL cannot see, so it is applied AFTER the fetch. With a
	// finite limit that combination must window after filtering (a SQL LIMIT
	// would drop rows) — the query runs unwindowed and slices in JS. No
	// caller pairs tables+limit today; correctness over an optimization
	// nobody hits. Both branches use the SAME validated window (pageWindow).
	const window = pageWindow(options.limit, options.offset, 'findInverseReferences');
	const windowInJs = options.tables !== undefined && window.limit !== null;

	// The scoped set is re-aliased `r`, so the ORDER BY (written over the index
	// alias) reads the same two columns on either shape.
	const selectSql =
		options.scope === undefined
			? question.selectSql
			: `SELECT r.section_tipo, r.section_id FROM (${scoped.sql}) AS r`;
	const rows = (await sql.unsafe(
		`${selectSql}
		 ORDER BY ${orderSql}${windowInJs ? '' : windowSql(window)}`,
		params as (string | number | null)[],
	)) as { section_tipo: string; section_id: number }[];

	const hits = await hitsWithTables(rows, tableByTipo);
	if (options.tables === undefined) return hits;
	const allowed = new Set(options.tables);
	const filtered = hits.filter((hit) => allowed.has(hit.table));
	return windowInJs
		? filtered.slice(window.offset, window.offset + (window.limit as number))
		: filtered;
}

/** A validated window (pageWindow) as SQL: ` LIMIT n` / ` OFFSET n`, each only when it narrows. */
function windowSql(window: { limit: number | null; offset: number }): string {
	const limitSql = window.limit !== null ? ` LIMIT ${window.limit}` : '';
	return window.offset > 0 ? `${limitSql} OFFSET ${window.offset}` : limitSql;
}

/** Index rows → hits, each with its section's matrix table (cached resolver, memoized per call). */
async function hitsWithTables(
	rows: readonly { section_tipo: string; section_id: number }[],
	tableByTipo: Map<string, string>,
): Promise<InverseReferenceHit[]> {
	const hits: InverseReferenceHit[] = [];
	for (const row of rows) {
		let table = tableByTipo.get(row.section_tipo);
		if (table === undefined) {
			table = (await getMatrixTableFromTipo(row.section_tipo)) ?? 'matrix';
			tableByTipo.set(row.section_tipo, table);
		}
		hits.push({ section_tipo: row.section_tipo, section_id: Number(row.section_id), table });
	}
	return hits;
}

/**
 * A bound row-set question (`section_tipo, section_id` rows on its own
 * `$1..$N`) — what a {@link RowScope} narrows. Structurally the record-scope
 * module's `BoundRows`; declared here so this principal-free sink never
 * imports the security layer.
 */
export interface BoundRowSet {
	sql: string;
	params: readonly unknown[];
}

/**
 * The caller's scope over the owner set — `security/record_scope.ts`
 * `rowScopeFor` bound to the caller at every user-facing door, absent on a
 * system walk.
 * It returns the SCOPED rows as SQL (same columns), never a row list: the
 * count, the page and the probe of one related question then ask the database
 * about the same scoped set (D1, 2026-10-21).
 */
export type RowScope = (rows: BoundRowSet) => Promise<BoundRowSet>;

/** The owner set of `question`, through `scope` when one is given. */
async function scopedQuestion(
	question: { selectSql: string; params: readonly string[] },
	scope: RowScope | undefined,
): Promise<BoundRowSet> {
	const rows: BoundRowSet = { sql: question.selectSql, params: [...question.params] };
	return scope === undefined ? rows : scope(rows);
}

/**
 * The find engine's QUESTION, unordered and unwindowed: the grouped SELECT
 * over matrix_relation_index (rows `section_tipo, section_id` — one per
 * owner), its WHERE and the params both are bound to. ONE derivation, shared
 * by the page (findInverseReferencesViaIndex), the count
 * (countInverseReferences) and the past-the-page probe
 * (anyInverseReferencePast), so no asker can ask another question than the
 * others — and each scopes it through the same {@link RowScope}.
 */
async function inverseReferencesQuery(
	locators: RelatedLocatorFilter[],
	options: Pick<NonNullable<Parameters<typeof findInverseReferences>[1]>, 'sectionTipos' | 'op'>,
): Promise<{ selectSql: string; params: string[]; where: string[] }> {
	const params: string[] = [];
	const push = (value: string): string => {
		params.push(value);
		return `$${params.length}`;
	};
	const clauses = locators.map((locator) => locatorIndexClause(locator, push));
	const where: string[] = [`(${clauses.join(' OR ')})`];
	const ownerNarrow = ownerSectionsIn('r.section_tipo', options.sectionTipos, push);
	if (ownerNarrow !== '') where.push(ownerNarrow);
	const having =
		options.op === 'AND' && clauses.length > 1
			? ` HAVING ${clauses.map((clause) => `bool_or(${clause})`).join(' AND ')}`
			: '';
	return {
		selectSql: `SELECT r.section_tipo, r.section_id FROM matrix_relation_index r
		 WHERE ${where.join(' AND ')}
		 GROUP BY r.section_tipo, r.section_id${having}`,
		params,
		where,
	};
}

/**
 * The page's ORDER BY over alias `r` (`section_tipo`, `section_id`), its CASE
 * values bound through `push` (the statement's own params). 'table' ordering:
 * table = f(section_tipo); the mapping is materialized for the owning tipos
 * actually present so the ORDER BY runs in SQL and LIMIT/OFFSET stay exact.
 */
async function inverseReferencesOrder(
	order: NonNullable<Parameters<typeof findInverseReferences>[1]>['order'],
	question: { where: readonly string[]; params: readonly string[] },
	push: (value: string) => string,
): Promise<{ orderSql: string; tableByTipo: Map<string, string> }> {
	if (order === 'section_tipo_section_id') {
		// PHP related-search DEFAULT order (v6 core/search/class.search_related.php
		// :189 — `ORDER BY section_tipo, section_id ASC` when the SQO sets none):
		// pure SQL over the index columns. Deliberately NOT routed through the
		// 'table' branch below — that one fires an extra SELECT DISTINCT probe
		// over matrix_relation_index (9.7M rows) to materialize the tipo→table
		// mapping, a cost the observer WRITE path (which runs this per save)
		// must not pay for an ordering the index already expresses.
		return { orderSql: 'r.section_tipo ASC, r.section_id ASC', tableByTipo: new Map() };
	}
	if (order === 'section_id') return { orderSql: 'r.section_id ASC', tableByTipo: new Map() };
	return tableOrderSql(question.where, question.params, push);
}

/**
 * The 'table' ordering: table = f(section_tipo), so the mapping is
 * materialized for the owning tipos actually present (one DISTINCT over the
 * index, bound to the question's own WHERE and params) and the ORDER BY runs
 * in SQL as a CASE — LIMIT/OFFSET stay exact. No owner matched → the plain id
 * order.
 */
async function tableOrderSql(
	where: readonly string[],
	params: readonly string[],
	push: (value: string) => string,
): Promise<{ orderSql: string; tableByTipo: Map<string, string> }> {
	const tableByTipo = new Map<string, string>();
	const tipoRows = (await sql.unsafe(
		`SELECT DISTINCT r.section_tipo FROM matrix_relation_index r WHERE ${where.join(' AND ')}`,
		[...params],
	)) as { section_tipo: string }[];
	for (const { section_tipo } of tipoRows) {
		tableByTipo.set(section_tipo, (await getMatrixTableFromTipo(section_tipo)) ?? 'matrix');
	}
	if (tableByTipo.size === 0) return { orderSql: 'r.section_id ASC', tableByTipo };
	const cases = [...tableByTipo.entries()]
		.map(([tipo, table]) => `WHEN ${push(tipo)}::text THEN ${push(table)}::text`)
		.join(' ');
	return {
		orderSql: `CASE r.section_tipo ${cases} END, r.section_tipo, r.section_id`,
		tableByTipo,
	};
}

/**
 * The OWNER-section narrowing (`sectionTipos`; 'all' / absent = none) as one
 * predicate over `column` — the same jsonb-array idiom on every sink path.
 */
function ownerSectionsIn(
	column: string,
	sectionTipos: string[] | 'all' | undefined,
	push: (value: string) => string,
): string {
	if (sectionTipos === undefined || sectionTipos === 'all') return '';
	const validated = sectionTipos.map((tipo) =>
		assertValidTipo(tipo, 'search_related.target_section'),
	);
	return `${column} IN (SELECT jsonb_array_elements_text(${push(JSON.stringify(validated))}::text::jsonb))`;
}

/**
 * Find every record holding a locator that points at any of the target
 * locators. `sectionTipos` narrows the OWNING sections ('all' = no narrowing).
 * Ordered by (table, section_tipo, section_id) for a deterministic result.
 */
export async function findInverseReferences(
	locators: RelatedLocatorFilter[],
	options: {
		sectionTipos?: string[] | 'all';
		limit?: number | false;
		offset?: number;
		/**
		 * 'section_id' = plain id order; 'section_tipo_section_id' = the PHP
		 * related-search DEFAULT (v6 class.search_related.php:189, pure SQL —
		 * multi-section scopes need the tipo tiebreak); 'table' materializes the
		 * tipo→table mapping (extra probe — see findInverseReferencesViaIndex).
		 */
		order?: 'table' | 'section_id' | 'section_tipo_section_id';
		/**
		 * Restrict the scan to specific matrix tables (PHP sqo set_tables — the
		 * children engine searches only the parent section's table). Each name
		 * is validated against the ontology-enumerated relation-table list.
		 */
		tables?: string[];
		/** Locator-clause join (PHP filter_by_locators_op; default OR). */
		op?: 'OR' | 'AND';
		/**
		 * The caller's scope (D1): a user-facing door passes
		 * its principal's record-scope (security/record_scope.ts rowScopeFor)
		 * and the window is cut from the SCOPED owner
		 * sequence; a system walk passes none and sees every owner.
		 */
		scope?: RowScope;
	} = {},
): Promise<InverseReferenceHit[]> {
	if (locators.length === 0) {
		throw new DedaloError('search.invalid_sqo', {
			message: 'search_related: filter_by_locators is required',
			publicMessage: 'A related search needs filter_by_locators',
		});
	}
	const tables = await getRelationTables();
	if (options.tables !== undefined) {
		const allowed = new Set(tables);
		if (options.tables.filter((table) => allowed.has(table)).length === 0) {
			// PHP parity (search_related::parse_sql_query): when the caller's
			// requested tables don't intersect the relation-capable set, the query
			// degrades to `SELECT NULL WHERE false;` — an empty result, not a fault.
			// This is the normal shape for a section whose own matrix table isn't
			// inverse-relations-enabled (e.g. matrix_projects, inverse_relations=false):
			// its children search simply finds nothing rather than killing the request.
			console.warn(
				`[search_related] no relation-capable table in requested [${options.tables.join(', ')}] — returning empty`,
			);
			return [];
		}
	}
	// Coverage over ALL relation-capable tables (the index spans them all;
	// options.tables only narrows the RESULT) — uncovered fails loudly.
	await requireRelationIndex(tables);
	return findInverseReferencesViaIndex(locators, options);
}

/** A sink question rendered as SQL, bound to its own `$1..$N` (never executed here). */
export interface InverseScanSql {
	sql: string;
	params: string[];
}

/**
 * Is there any owner PAST `offset` in the SCOPED owner set of this question —
 * i.e. does the scoped set hold more than `offset` owners? The search.page_clamped
 * probe of get_relation_list / related_search (READ-4): "is there anything for
 * you past this page". ONE statement over the same scoped set the page windows
 * and the count counts (D1) — never a read of the tail. An order is not needed:
 * the answer is a cardinality, and the page it judges is a window of that same
 * set.
 *
 * `scope` is REQUIRED: the only askers are user-facing doors (a principal-free
 * walk has no notice to decide). It is a `*InverseReference*` name so the
 * AUTHZ-05 door registry (security_audit_2026_07_23_tripwire) classifies every
 * caller.
 */
export async function anyInverseReferencePast(
	locators: RelatedLocatorFilter[],
	options: { sectionTipos?: string[] | 'all'; op?: 'OR' | 'AND'; scope: RowScope },
	offset: number,
): Promise<boolean> {
	if (locators.length === 0) {
		throw new DedaloError('search.invalid_sqo', {
			message: 'search_related: filter_by_locators is required',
			publicMessage: 'A related search needs filter_by_locators',
		});
	}
	await requireRelationIndex(await getRelationTables());
	const window = pageWindow(false, offset, 'anyInverseReferencePast');
	const scoped = await scopedQuestion(
		await inverseReferencesQuery(locators, options),
		options.scope,
	);
	const offsetSql = window.offset > 0 ? ` OFFSET ${window.offset}` : '';
	const found = (await sql.unsafe(
		`SELECT EXISTS (SELECT 1 FROM (${scoped.sql}) AS r${offsetSql}) AS found`,
		scoped.params as (string | number | null)[],
	)) as { found: boolean }[];
	return found[0]?.found === true;
}

/** One breakdown hit: the exact locator entry that matched, plus its owner. */
export interface InverseReferenceLocatorHit {
	section_tipo: string;
	section_id: number;
	table: string;
	/** The individual locator object from the owner's relation column. */
	locator_data: Record<string, unknown>;
}

/**
 * BREAKDOWN owner-probe cap for a RECORD-TARGETED filter (every real caller
 * except the sweep below): the number of matrix_relation_index rows the step-1
 * probe is willing to carry back into JS. This one is a MEMORY/wire bound, not
 * a crossover — see the "OWNER CARRIER" note in findInverseReferenceLocators
 * for why no crossover exists on this side.
 */
const BREAKDOWN_OWNER_CAP = 10_000;

/**
 * …and the cap for a SECTION-WIDE SWEEP — a filter with no section_id, i.e.
 * "everything pointing at any record of this section" (builder_relation_index's
 * `{type:'dd96', section_tipo}`, its only shape). Measured separately because
 * this shape behaves differently in kind, not in degree: its owner set is
 * inherently large, and its fallback semi-join is ONE index range the planner
 * costs honestly — over all 9 sections above the cap on this install
 * (989-10,773 owners) the fallback is FLAT and 1.2-1.7× cheaper than the
 * carrier, with no custom/generic divergence at all. Numbers in the OWNER
 * CARRIER note.
 */
const BREAKDOWN_SWEEP_OWNER_CAP = 1_000;

/**
 * Second bound, on the CARRIER rather than on the owners: with N locators the
 * fast path ships one union array PLUS one per-locator array, so the entries
 * materialized in JS are bounded by probe rows × N, not by probe rows. N is
 * caller-supplied (indexation_grid lifts sqo.filter_by_locators straight from
 * the request), so the owner cap alone does not bound it. Above this the
 * breakdown takes the legacy single-statement path, which materializes nothing.
 */
const BREAKDOWN_CARRIER_ENTRY_CAP = 10_000;

/**
 * The owner cap this call gets: the shape's cap, lowered (never raised) by the
 * `ownerCap` test seam. Exported because the gate asserts it — the seam's
 * documented contract has to be mechanically checkable, not merely written down
 * (DEC-12).
 *
 * A sweep is a filter where NO locator names a section_id. One locator with an
 * id is enough to make the call record-targeted: the multi-locator OR-ed
 * fallback WHERE is the worst-planned shape of all (measured: two locators on
 * dd128/67 cost 2,196-2,406 ms on every execution, custom AND generic, against
 * 0.2-0.9 ms carried).
 */
export function resolveBreakdownOwnerCap(
	locators: RelatedLocatorFilter[],
	requested?: number,
): number {
	const isSweep = locators.every(
		(locator) => locator.section_id === undefined || locator.section_id === null,
	);
	const shapeCap = isSweep ? BREAKDOWN_SWEEP_OWNER_CAP : BREAKDOWN_OWNER_CAP;
	return typeof requested === 'number' && Number.isFinite(requested)
		? Math.min(shapeCap, Math.max(0, Math.floor(requested)))
		: shapeCap;
}

/**
 * THE plan decision for the breakdown, in one place: does this call carry the
 * owners back as array parameters (fast path) or emit the original inline
 * semi-join (fallback)? findInverseReferenceLocators calls exactly this, and
 * the gate asserts exactly this, so the seam's documented contract cannot drift
 * from what the function does (DEC-12 — the second code path needs a gate, and
 * the gate needs the decision to be observable).
 *
 * `ownerCap === 0` is the test seam: NO owner carrier, ever — including the
 * zero-owner case, where the fast path would otherwise short-circuit to [] and
 * the gate would silently compare the fast path with itself.
 */
export function breakdownUsesOwnerCarrier(
	ownerCap: number,
	probeRowCount: number,
	locatorCount: number,
): boolean {
	return (
		ownerCap > 0 &&
		probeRowCount <= ownerCap &&
		probeRowCount * locatorCount <= BREAKDOWN_CARRIER_ENTRY_CAP
	);
}

/**
 * PostgreSQL array literals for the owner carrier.
 *
 * Bun.sql does NOT serialize a JS array into a PG array — `sql.unsafe('… =
 * ANY($1::text[])', [['a','b']])` dies with `malformed array literal: "a,b"`
 * (reproduced 2026-08-07). So the carrier is assembled as a literal STRING and
 * bound through `push()` like any other value; it is a BOUND PARAMETER, never
 * interpolated SQL text. A malformed element can therefore only ever raise a
 * bind-time array-literal error — it can never reach the parser.
 */
function pgTextArrayLiteral(values: string[]): string {
	return `{${values.map((value) => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`).join(',')}}`;
}
function pgIntArrayLiteral(values: number[]): string {
	return `{${values.join(',')}}`;
}

/**
 * The locator_data field equalities for ONE locator — the entry narrowing that
 * runs AFTER the jsonb cross join, in the PHP order (from_component_tipo /
 * type alternative first, then section_tipo, then section_id when present).
 *
 * ONE definition, shared by both breakdown paths (fast join + legacy
 * fallback), so the two can never drift: same clauses, same order, same param
 * order. Note the deliberate asymmetry with locatorIndexClause: that one
 * normalizes the id (`String(Number(...))` — the index column is int), this one
 * compares the RAW jsonb text (`String(...)`, ids live in jsonb as strings).
 * Both are the oracle's behavior; do not "fix" either.
 */
function locatorDataFieldClauses(
	locator: RelatedLocatorFilter,
	push: (value: string) => string,
): string[] {
	const parts: string[] = [];
	if (typeof locator.from_component_tipo === 'string' && locator.from_component_tipo !== '') {
		parts.push(`locator_data->>'from_component_tipo' = ${push(locator.from_component_tipo)}::text`);
	} else if (typeof locator.type === 'string' && locator.type !== '') {
		parts.push(`locator_data->>'type' = ${push(locator.type)}::text`);
	}
	parts.push(`locator_data->>'section_tipo' = ${push(locator.section_tipo)}::text`);
	if (locator.section_id !== undefined && locator.section_id !== null) {
		parts.push(`locator_data->>'section_id' = ${push(String(locator.section_id))}::text`);
	}
	return parts;
}

/** An owner row resolved by the step-1 probe (the record that HOLDS the locator). */
interface BreakdownOwner {
	section_tipo: string;
	section_id: number;
}

/**
 * BREAKDOWN mode (PHP sqo->breakdown): cross-join each owning row with
 * jsonb_path_query(relation, '$.*[*]') so every individual locator entry
 * becomes its own result row, narrowed to the entries that satisfy the
 * filter — get_referenced_locators() uses this to recover the EXACT matching
 * locator objects (delete propagation, reference rewrites).
 *
 * TWO STATEMENTS, NOT ONE (2026-08-07). The owner narrowing used to be an
 * inline semi-join —
 *   (section_tipo, section_id) IN (SELECT r.section_tipo, r.section_id
 *                                 FROM matrix_relation_index r WHERE <locator>)
 * — inside a UNION ALL over the 9 relation-capable tables. PostgreSQL
 * misestimates that subquery by ~3000× (estimated 63,359 owner rows for the
 * reported record, actual 21) and answers with parallel seq scans of matrix
 * (794k rows / 4.1 GB), matrix_hierarchy and matrix_langs plus hash joins:
 * measured 185.8 ms and shared hit=127376 read=288811 under a custom plan,
 * against 3.68 ms / hit=492 once the pooled prepared statement flipped to the
 * generic plan on its 5th execution. A 50× cliff decided by execution count.
 *
 * So the owner set is resolved FIRST, by itself, against
 * matrix_relation_index alone (single table, btree probe on target_idx /
 * type_idx — measured 0.18-0.92 ms, flat, no cliff), and then carried into the
 * UNION as array parameters joined through unnest(). Measured on the reported
 * record ({type:'dd151', section_tipo:'numisdata3', section_id:1}, owners
 * narrowed to ['tch1','tch100','tch178'] → EMPTY): 243.8 184.9 182.2 184.7
 * 188.3 | 5.9 3.1 2.8 ms before, 1.6 0.2 0.4 0.2 0.2 | 0.2 0.1 0.1 ms after
 * ('|' = the execution where the pool flips to the generic plan). On the
 * delete_record shape (21 owners): 176-179 ms → 2.6-5.5 ms. As a plan: custom
 * 1.99 ms / generic 2.07 ms, node-for-node IDENTICAL, hit=329 in both modes —
 * the cliff is gone, not merely won.
 *
 * OWNER CARRIER / BOUNDING. Owners are materialized in JS and shipped back as
 * array parameters, so the fast path trades ONE hash join per table for ONE
 * INDEX PROBE PER OWNER PER TABLE (9 tables ⇒ 9 probes per owner). Its cost is
 * therefore PREDICTABLE and roughly linear in owners. The fallback's is not:
 * it depends on a plan the planner picks from an estimate it gets wrong by
 * ~3000×, and how wrong it gets it depends on the TARGET RECORD, not on the
 * query shape. That asymmetry — not a crossover — is what sizes the caps.
 *
 * MEASURE THE FIRST EXECUTIONS, NOT A WARM MEDIAN. `limit`/`offset` are
 * interpolated into the SQL text, so every page is a NEW prepared statement and
 * a paginating caller lives in the CUSTOM-plan regime (executions 1-5). A warm
 * median hides exactly the disease this change exists to cure. Chronological,
 * fresh statement, 6-8 executions each (app DB, ms):
 *   rsc170/1 bare (4,684 owners — a delete_record / relation_index shape):
 *     FALLBACK 3433 3371 2657 2556 3461 3762 · CARRIER 101 105 117 122 136 110
 *   rsc170/1 +type, limit 20 (the relation_index page):
 *     FALLBACK 1854 2442 2585 2727 2672 | 369 293 262 · CARRIER 110 104 107 100 99 131
 *   dd128/67, TWO locators (the indexation_grid shape):
 *     FALLBACK 2196 2318 2288 2208 2337 2406 2394 2300 (no relief, ever)
 *     CARRIER 0.92 0.38 0.23 0.22 0.24 0.22 0.21 0.28
 *   reported record ({type:'dd151', numisdata3/1} narrowed to tch*, EMPTY):
 *     FALLBACK 190.8 175.4 171.8 170.2 168.2 | 5.4 3.0 3.1 · CARRIER 2.9 0.29
 *     0.26 0.23 0.25 0.24 0.20 0.18
 * And where the same fallback happens to plan WELL, the carrier's cost is what
 * it costs — 1.4-1.9×, in the sub-300 ms band:
 *   rsc205/1 bare (2,945): FALLBACK 105 82 83 92 130 | 66 63 63 · CARRIER 90 68
 *     67 66 67 | 87 89 88   (carrier wins cold, loses ~1.4× warm)
 *   material1/3 bare (4,849): FALLBACK 131 118 114 118 114 · CARRIER 317 232 234 213 189
 *   rsc197/3511 bare (8,392): FALLBACK 109 91 86 89 93 · CARRIER 183 151 151 153 154
 * There is NO universal crossover: the same bare shape is a 25× carrier win on
 * rsc170/1 and a 1.7× carrier loss on material1/3. Paying ≤2× on the records
 * whose fallback plans well, to remove a 2.5-3.8 SECOND tail on the records
 * whose fallback does not, is the trade this cap takes deliberately — a
 * predictable plan is worth more to a heritage install that must stay
 * responsive for years than a lottery with a better median.
 *
 * THE ONE SHAPE THAT IS DIFFERENT IN KIND is the section-wide sweep with no
 * section_id — builder_relation_index's `{type:'dd96', section_tipo}`, its only
 * shape (INDEX_RELATION_TYPE = 'dd96'; the dd151/dd128 sweep an earlier note
 * cited is a shape no caller can produce). Its owner set is inherently large
 * and its semi-join is ONE index range the planner costs honestly. Chronological
 * over all 9 sections above the sweep cap (owners → FALLBACK vs CARRIER, first
 * execution … last): 989 → 24…21 vs 29…27 · 1,011 → 27…25 vs 37…30 · 1,161 →
 * 26…25 vs 39…30 · 1,592 → 27…24 vs 44…30 · 2,377 → 34…37 vs 55…45 · 3,193 →
 * 39…36 vs 70…55 · 5,002 → 72…73 vs 93…92 · 8,942 → 119…112 vs 183…182 ·
 * 10,773 → 155…167 vs 221…236. FLAT everywhere, no custom/generic divergence,
 * 1.2-1.7× cheaper than the carrier in every one. Hence
 * BREAKDOWN_SWEEP_OWNER_CAP = 1,000: the sweep keeps the carrier only while it
 * is small, and hands the big sections back to the plan that is better for them.
 *
 * So BREAKDOWN_OWNER_CAP (10,000) is a MEMORY/WIRE bound, not a crossover. Above
 * it the carrier's own cost is what breaks: the 97k-row mass shape is a 2× loss
 * and the largest hub in this install (dd153/1, 1,062,392 owners) costs 14.6 s
 * and 1.3 GB of RSS in ONE request against 3.6 s for the fallback. Bounding
 * per-request memory in a process that must stay up for years is real safety;
 * the array literal is ~97 KB at the cap, paid per concurrent request up to
 * DB_POOL_MAX.
 *
 * A LATERAL carrier (one unnest, 9 index probes per owner) and dropping the
 * DISTINCT were both measured as alternatives to the per-arm carrier: neither
 * changes the picture (9,958-owner shape: current 196-210 ms, no-DISTINCT
 * 206-213 ms, LATERAL 226-237 ms). The cost is the 9×N index probes, not the
 * carrier subquery — which is why the answer is a cap and not a cleverer join.
 *
 * Both paths return the identical row multiset AND (since the ORDER BY became
 * total, below) the identical row SEQUENCE: the cap chooses the plan, never the
 * result.
 *
 * CONCURRENCY — say what is true, not what is comfortable. The split into two
 * statements opens a READ COMMITTED torn-read window the single-statement form
 * did not have: an owner committed between the probe and the UNION is invisible
 * to this call. NO LOCK CLOSES IT. Measured 2026-08-08 on two connections: with
 * the delete holding `FOR UPDATE` on the TARGET row, a concurrent insert of a
 * new owner was not blocked (0 ms), the carrier UNION missed it, and the
 * single-statement form run at the same point in the SAME tx saw it.
 * `withTransaction` is a plain `pool.begin` with no isolation level
 * (db/postgres.ts), and the save paths lock only the OWNER row
 * (record/save_component.ts, relations/save.ts) — never the target's — so a
 * locator writer and a delete never conflict. An earlier revision of this
 * comment claimed the delete's row locks narrowed the window; that was FALSE.
 *
 * REPEATABLE READ is NOT the fix: under RR both statements consistently miss
 * the concurrent owner (measured). It would buy internal probe/UNION
 * consistency and zero referential integrity.
 *
 * In proportion: the ORPHANED-LOCATOR race PREDATES this split. At HEAD the
 * window already spanned the whole delete transaction (snapshot → COMMIT,
 * across the multi-second rewrite loop); the split adds a millisecond-scale gap
 * inside a far larger pre-existing one. Real closure needs a WRITE-side
 * protocol — locator writers locking or verifying the target row, or
 * SERIALIZABLE on both sides — not a read-side isolation bump here. Ledgered as
 * a known-open gap in `rewrite/LEDGER.md` (S2-45 lets a header LINK the ledger;
 * it must never restate its state).
 */
export async function findInverseReferenceLocators(
	locators: RelatedLocatorFilter[],
	options: {
		sectionTipos?: string[] | 'all';
		limit?: number | false;
		offset?: number;
		/** 'section_id' = PHP related-search default order (relation_index page). */
		order?: 'table' | 'section_id';
		/**
		 * @internal TEST SEAM (named exemption, DEC-12): forces the plan choice so
		 * the above-cap fallback is reachable by a gate — `ownerCap: 0` skips the
		 * probe entirely and ALWAYS emits the legacy SQL (including for filters
		 * with no owners at all, where the fast path would otherwise short-circuit
		 * to [] and the seam would compare a path with itself). Never set by
		 * production callers; both paths must return the identical row SEQUENCE,
		 * which is exactly what the gate asserts
		 * (test/unit/search_related_breakdown_native.test.ts).
		 *
		 * The seam only ever moves DOWN: values above the shape's cap are clamped
		 * to it, and a non-finite value falls back to it (see
		 * resolveBreakdownOwnerCap). Nothing may raise the per-request carrier
		 * bound — least of all an option object that is one careless `{...sqo}`
		 * away from client input.
		 */
		ownerCap?: number;
	} = {},
): Promise<InverseReferenceLocatorHit[]> {
	if (locators.length === 0) {
		throw new DedaloError('search.invalid_sqo', {
			message: 'search_related: filter_by_locators is required',
			publicMessage: 'A related search needs filter_by_locators',
		});
	}
	const tables = await getRelationTables();
	// Coverage check stays ABOVE the owner probe: an uncovered instance must
	// fail loudly here, never short-circuit to an empty breakdown (that would be
	// exactly the silent scope narrowing the project forbids).
	await requireRelationIndex(tables);

	// The tail is identical on both paths (one validated window, pageWindow).
	const window = pageWindow(options.limit, options.offset, 'findInverseReferenceLocators');
	const limitSql = window.limit !== null ? ` LIMIT ${window.limit}` : '';
	const offsetSql = window.offset > 0 ? ` OFFSET ${window.offset}` : '';
	const orderSql = breakdownOrder(options.order);

	const query = await breakdownQuery(locators, options, tables);
	if (query === null) return [];
	const rows = (await sql.unsafe(
		`${query.sql} ORDER BY ${orderSql}${limitSql}${offsetSql}`,
		query.params,
	)) as InverseReferenceLocatorHit[];
	return rows.map((row) => ({ ...row, section_id: Number(row.section_id) }));
}

/**
 * The breakdown's ORDER BY — one definition for the windowed read and the
 * scoped tail (findInverseReferenceLocatorsPast).
 *
 * TOTAL ORDER (WC-2026-08-07-breakdown-total-order). The PHP orders — `section_id ASC` and
 * `"table", section_tipo, section_id` — are not total over a BREAKDOWN row
 * set: one owner contributes one row per matching locator entry, and those
 * rows tie on every key. Inside a tie group the physical order is whatever
 * the chosen plan emits, so a LIMIT/OFFSET window that cuts through a tie
 * group returned a DIFFERENT ROW depending on the plan — measured between
 * the two paths here (dd128/67, two locators, {order:'section_id', limit:7,
 * offset:2}: same section_ids, different from_component_tipo in the
 * section_id=225 group, deterministic 12/12), and measured WITHIN the old
 * single-statement path across executions (its off=2,limit=7 window
 * contained a row absent from its own off=0,limit=9 window — pagination that
 * is not merely unstable but incoherent).
 *
 * The PHP keys stay FIRST and unchanged, so the sequence they determine is
 * untouched; the tiebreak only refines what neither of them ordered.
 * locator_data closes it: jsonb has a total btree order, and two rows that
 * still tie after it are byte-identical, hence unobservable. Both breakdown
 * paths share this tail, so they now agree row-for-row, not just as
 * multisets. Measured price of the extra sort key on the biggest unwindowed
 * results: 8,391 rows 137→142 ms, 9,958 rows 103→119 ms, 17,963 rows
 * 203→226 ms (3-15%); a windowed read pays a bounded top-N instead.
 */
function breakdownOrder(order: 'table' | 'section_id' | undefined): string {
	return order === 'section_id'
		? 'section_id ASC, section_tipo ASC, "table" ASC, locator_data ASC' // PHP build_sql_query_order_default + tiebreak
		: '"table", section_tipo, section_id, locator_data';
}

/**
 * The breakdown's QUESTION, unordered and unwindowed: the owner probe, the plan
 * choice it decides, and the UNION over every relation-capable table (rows
 * `section_tipo, section_id, "table", locator_data`) — or `null` when nothing
 * points at the filter (the empty-owner short-circuit). ONE derivation, shared
 * by the windowed read (findInverseReferenceLocators) and the scoped tail
 * (findInverseReferenceLocatorsPast), so both ask the same question on the same
 * plan.
 */
async function breakdownQuery(
	locators: RelatedLocatorFilter[],
	options: { sectionTipos?: string[] | 'all'; ownerCap?: number },
	tables: string[],
): Promise<InverseScanSql | null> {
	// ---- STEP 1: resolve the owners. ONE statement, one table, RAW rows.
	// No GROUP BY / DISTINCT: with only a LIMIT above it, NO plan shape can be
	// forced to produce more than cap+1 rows (an aggregate would have to consume
	// its whole input first), and raw >= distinct owners means "raw <= cap"
	// implies "owners <= cap" — the bound errs toward the fallback, which is the
	// safe direction. It does NOT guarantee an index scan: on the 1.06M-owner hub
	// (dd153/1) the custom plan is a Seq Scan — it just stops after 1001 rows.
	// Measured tax on the shapes that pay it for nothing (the fallback's added
	// statement), both plan_cache_mode settings: 0.22-0.63 ms — hub 0.29 ms,
	// {type:'dd151', section_tipo:'rsc205'} 0.28 ms, dd96/tema1 0.29 ms.
	//
	// The seam clamps DOWNWARD only (see the option's doc): an out-of-range or
	// non-numeric value can neither raise the carrier bound nor reach the SQL
	// text as `LIMIT NaN`.
	const ownerCap = resolveBreakdownOwnerCap(locators, options.ownerCap);
	// `ownerCap: 0` = "never carry owners": skip the probe entirely so the seam
	// reaches the legacy SQL even when the filter has NO owners (otherwise the
	// empty-probe short-circuit below would answer, and a gate built on the seam
	// would compare the fast path with itself).
	if (ownerCap > 0) {
		const probeParams: string[] = [];
		const probePush = (value: string): string => {
			probeParams.push(value);
			return `$${probeParams.length}`;
		};
		const probeClauses = locators.map((locator) => locatorIndexClause(locator, probePush));
		// With several locators the arms still need to know WHICH locator each
		// owner belongs to (per-locator pairing, below). One flag column per
		// locator recovers that from the same single round trip.
		const flagColumns =
			locators.length > 1
				? `, ${probeClauses.map((clause, index) => `${clause} AS f${index}`).join(', ')}`
				: '';
		// sectionTipos narrows the OWNER section_tipo — the same thing the old
		// per-arm sectionNarrow did, moved into the probe (same jsonb idiom as the
		// find engine above).
		const probeOwners = ownerSectionsIn('r.section_tipo', options.sectionTipos, probePush);
		const probeNarrow = probeOwners === '' ? '' : ` AND ${probeOwners}`;
		const probeRows = (await sql.unsafe(
			`SELECT r.section_tipo, r.section_id${flagColumns}
			 FROM matrix_relation_index r
			 WHERE (${probeClauses.join(' OR ')})${probeNarrow}
			 LIMIT ${ownerCap + 1}`,
			probeParams,
		)) as Record<string, unknown>[];

		// ---- STEP 2: decide, in JS, which plan the row set deserves.
		// Two bounds: the owner cap (the measured plan crossover) and the carrier
		// entry cap (probe rows × locators — the caller controls the locator
		// count, so the owner cap alone does not bound what we materialize).
		if (breakdownUsesOwnerCarrier(ownerCap, probeRows.length, locators.length)) {
			// Union set + (only when it is read) the per-locator sets.
			const unionOwners = new Map<string, BreakdownOwner>();
			const ownersPerLocator: Map<string, BreakdownOwner>[] =
				locators.length > 1 ? locators.map(() => new Map()) : [];
			for (const row of probeRows) {
				const owner: BreakdownOwner = {
					section_tipo: String(row.section_tipo),
					section_id: Number(row.section_id),
				};
				const key = `${owner.section_tipo}|${owner.section_id}`;
				unionOwners.set(key, owner);
				if (locators.length > 1) {
					// The flag columns are PostgreSQL booleans; a driver that ever
					// stopped mapping them to JS `true` would empty every per-locator
					// set and turn the whole breakdown into a silent `[]` on the
					// delete-propagation path. Decode tolerantly AND fail loudly when
					// a probe row matches no locator — the WHERE guarantees it matched
					// at least one, so that state is impossible unless the decoding is.
					let matched = 0;
					for (let index = 0; index < locators.length; index++) {
						const flag = row[`f${index}`];
						if (flag === true || flag === 't' || flag === 1) {
							ownersPerLocator[index]?.set(key, owner);
							matched++;
						}
					}
					if (matched === 0) {
						throw new Error(
							`search_related: breakdown probe row ${key} matched no locator flag (got ${locators.map((_, index) => `f${index}=${String(row[`f${index}`])}`).join(', ')}) — the per-locator decoding is broken; refusing to answer with a silently narrowed result`,
						);
					}
				}
			}
			// Nothing points at the filter (within the requested owner sections) —
			// the whole UNION disappears. This is the reported record's path: the
			// 21 real owners are numisdata*, the request asked for tch*, and the
			// engine used to seq-scan 3 GB to discover that.
			if (unionOwners.size === 0) return null;

			const params: string[] = [];
			const push = (value: string): string => {
				params.push(value);
				return `$${params.length}`;
			};
			const union = [...unionOwners.values()];
			const unionTipoParam = push(pgTextArrayLiteral(union.map((owner) => owner.section_tipo)));
			const unionIdParam = push(pgIntArrayLiteral(union.map((owner) => owner.section_id)));

			// ---- STEP 3: one arm per table, per-locator pairing INSIDE the arm.
			// The arm count is always tables.length, NEVER (table × locator): a jsonb
			// entry that satisfies two locators must be emitted ONCE, exactly as the
			// single OR-ed WHERE did. (Measured on the overlapping two-locator case
			// rsc197/6848 fct rsc139 ⊂ bare rsc197/6848: 1040 rows, not 1507.)
			const perLocator = locators.map((locator, index) => {
				const parts: string[] = [];
				if (locators.length > 1) {
					const owners = [...(ownersPerLocator[index]?.values() ?? [])];
					if (owners.length === 0) return '(false)';
					// A semi-join PREDICATE, never a second join — a join here could
					// fan out; IN (…) cannot.
					parts.push(
						`(m.section_tipo, m.section_id) IN (SELECT o.t, o.i FROM unnest(${push(pgTextArrayLiteral(owners.map((owner) => owner.section_tipo)))}::text[], ${push(pgIntArrayLiteral(owners.map((owner) => owner.section_id)))}::int[]) AS o(t,i))`,
					);
				}
				// With ONE locator the join below already carries the whole owner
				// narrowing (per-locator set === union set), so no owner predicate.
				parts.push(...locatorDataFieldClauses(locator, push));
				return `(${parts.join(' AND ')})`;
			});
			const wherePerTable = perLocator.join(' OR ');

			// EVERY relation-capable table gets an arm. NEVER prune by
			// getMatrixTableFromTipo: the ontology map disagrees with physical
			// residence for real tipos — numisdata33 maps to `matrix` while its rows
			// live in matrix_hierarchy, so pruning to the mapped table returns 0 rows
			// where the engine returns 1 (measured: filter {type:'dd151',
			// section_tipo:'dd128', section_id:3}, sectionTipos ['numisdata33']).
			// The "skip the UNION" win comes from the empty-owner return above, NOT
			// from per-table pruning. Do not "optimize" this back.
			//
			// The owner set enters through a JOIN so the planner MUST produce a
			// nested loop into each table's (section_tipo, section_id) index — a
			// structural guarantee, not a costing accident. SELECT DISTINCT is
			// load-bearing: it makes fan-out impossible by SQL semantics rather than
			// by trusting the JS dedupe above. The join columns are aliased t/i (never
			// section_tipo/section_id) so ORDER BY can never become ambiguous.
			const unionSql = tables
				.map(
					(table) =>
						`SELECT m.section_tipo, m.section_id, '${table}' AS "table", locator_data
					 FROM "${table}" m
					 JOIN (SELECT DISTINCT o.t, o.i FROM unnest(${unionTipoParam}::text[], ${unionIdParam}::int[]) AS o(t,i)) u
					   ON m.section_tipo = u.t AND m.section_id = u.i
					 CROSS JOIN jsonb_path_query(m.relation, '$.*[*]') AS locator_data
					 WHERE (${wherePerTable})`,
				)
				.join(' UNION ALL ');

			return { sql: unionSql, params };
		}
	}

	// ---- ABOVE THE CAP (or the seam): the original single-statement shape,
	// unchanged. At this cardinality the planner's estimate is honest and its
	// seq-scan/hash choice is the right one — measured on the real caller shapes
	// it BEATS the array carrier from ~1,000 owners up (see the OWNER CARRIER
	// note); the ~3000× misestimate that causes the cliff only exists when the
	// owner set is TINY, the region the fast path above now owns. The owner set
	// genuinely belongs in the database rather than on the wire at this size.
	const params: string[] = [];
	const push = (value: string): string => {
		params.push(value);
		return `$${params.length}`;
	};

	// Per-locator: the row narrowing (index-backed) PLUS the locator_data
	// field equalities (entry narrowing after the cross join).
	const perLocator = locators.map((locator) => {
		const rowNarrow = `(section_tipo, section_id) IN (SELECT r.section_tipo, r.section_id FROM matrix_relation_index r WHERE ${locatorIndexClause(locator, push)})`;
		return `(${[rowNarrow, ...locatorDataFieldClauses(locator, push)].join(' AND ')})`;
	});
	const wherePerTable = perLocator.join(' OR ');

	const owners = ownerSectionsIn('section_tipo', options.sectionTipos, push);
	const sectionNarrow = owners === '' ? '' : ` AND ${owners}`;

	const union = tables
		.map(
			(table) =>
				`SELECT section_tipo, section_id, '${table}' AS "table", locator_data
				 FROM "${table}"
				 CROSS JOIN jsonb_path_query(relation, '$.*[*]') AS locator_data
				 WHERE (${wherePerTable})${sectionNarrow}`,
		)
		.join(' UNION ALL ');

	return { sql: union, params };
}

/**
 * findInverseReferenceLocators' rows PAST `offset` — the same question, plan
 * and total order — as a bound SELECT (`section_tipo, section_id, "table",
 * locator_data`), for a door that asks a SCOPED question of the whole tail in
 * one statement (READ-4: indexation_grid.ts indexationRowsPast). `null` when
 * nothing points at the filter. UNSCOPED like the scan: a user-facing caller
 * must scope it (AUTHZ-05 door registry).
 */
export async function findInverseReferenceLocatorsPast(
	locators: RelatedLocatorFilter[],
	options: { sectionTipos?: string[] | 'all'; order?: 'table' | 'section_id' },
	offset: number,
): Promise<InverseScanSql | null> {
	if (locators.length === 0) {
		throw new DedaloError('search.invalid_sqo', {
			message: 'search_related: filter_by_locators is required',
			publicMessage: 'A related search needs filter_by_locators',
		});
	}
	const tables = await getRelationTables();
	await requireRelationIndex(tables);
	const window = pageWindow(false, offset, 'findInverseReferenceLocatorsPast');
	const query = await breakdownQuery(locators, { sectionTipos: options.sectionTipos }, tables);
	if (query === null) return null;
	const offsetSql = window.offset > 0 ? ` OFFSET ${window.offset}` : '';
	return {
		sql: `${query.sql} ORDER BY ${breakdownOrder(options.order)}${offsetSql}`,
		params: query.params,
	};
}

/** PHP group_by identifier guard (simple, optionally table-qualified). */
const GROUP_BY_IDENTIFIER = /^[a-zA-Z_][a-zA-Z0-9_]*(\.[a-zA-Z_][a-zA-Z0-9_]*)?$/;

export interface RelatedCountResult {
	total: number;
	/** Present only when group_by was requested: one entry per result row. */
	totals_group?: { key: string[]; value: number }[];
}

/**
 * COUNT the inverse references (PHP trait.count with mode 'related'): the
 * owners of the find engine's own question ({@link inverseReferencesQuery} —
 * one row per owner), counted IN SQL, optionally grouped by section_tipo as
 * {key: [section_tipo], value} alongside the total (ordered by section_tipo).
 * With `scope` (D1 — every user-facing door) the owners are the SCOPED set:
 * the same set the page windows and the probe asks about, so a paginator's
 * walk of ceil(total / limit) pages is exactly `total` records. Bounded: the
 * statement returns one row (or one per section), whatever the owner count.
 * Invalid group_by entries are dropped (PHP identifier regex); other valid
 * shapes throw (no caller).
 */
export async function countInverseReferences(
	locators: RelatedLocatorFilter[],
	options: { sectionTipos?: string[] | 'all'; groupBy?: string[]; scope?: RowScope } = {},
): Promise<RelatedCountResult> {
	if (locators.length === 0) {
		throw new DedaloError('search.invalid_sqo', {
			message: 'search_related: filter_by_locators is required',
			publicMessage: 'A related search needs filter_by_locators',
		});
	}
	const tables = await getRelationTables();

	// Identifier filtering FIRST (invalid entries are dropped, PHP regex +
	// the INJ-04 VALID_DATA_COLUMNS allowlist) so the shape decision below
	// sees the EFFECTIVE grouping — an invalid group_by degrades to the plain
	// count, it never becomes an error.
	const groupByFiltered = (options.groupBy ?? []).filter((column) => {
		if (typeof column !== 'string' || !GROUP_BY_IDENTIFIER.test(column)) return false;
		const bare = column.includes('.') ? column.slice(column.lastIndexOf('.') + 1) : column;
		return VALID_DATA_COLUMNS.includes(bare);
	});

	// The only grouped shape any caller uses is ['section_tipo'] (S2-26).
	// The retired per-table containment scan could group by arbitrary matrix
	// columns; the index carries owner identity only — a novel grouping shape
	// is a loud error, not a silent degradation (add it to the index query if
	// a real caller ever appears).
	if (
		groupByFiltered.length > 0 &&
		!(groupByFiltered.length === 1 && groupByFiltered[0] === 'section_tipo')
	) {
		throw new DedaloError('engine.uncovered_scope', {
			message: `search_related: group_by [${groupByFiltered.join(', ')}] is not supported by the relation index (only 'section_tipo'; flat-function scan removed 2026-07-20)`,
		});
	}
	await requireRelationIndex(tables);
	const owners = await scopedQuestion(
		await inverseReferencesQuery(locators, { sectionTipos: options.sectionTipos }),
		options.scope,
	);
	const params = owners.params as (string | number | null)[];
	if (groupByFiltered.length === 1) {
		const rows = (await sql.unsafe(
			`SELECT owners.section_tipo, COUNT(*)::int AS full_count
			 FROM (${owners.sql}) AS owners
			 GROUP BY owners.section_tipo ORDER BY owners.section_tipo`,
			params,
		)) as { section_tipo: string; full_count: number }[];
		let total = 0;
		const totalsGroup: { key: string[]; value: number }[] = [];
		for (const row of rows) {
			const value = Number(row.full_count);
			total += value;
			if (value > 0) totalsGroup.push({ key: [row.section_tipo], value });
		}
		return { total, totals_group: totalsGroup };
	}
	const rows = (await sql.unsafe(
		`SELECT COUNT(*)::int AS full_count FROM (${owners.sql}) AS owners`,
		params,
	)) as { full_count: number }[];
	return { total: Number(rows[0]?.full_count ?? 0) };
}
