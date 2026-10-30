/**
 * THE `referenced_by` FILTER LEAF (WC-2026-10-30-search-referenced-by-leaf).
 *
 *   { "referenced_by": { "section_tipo": ["test3"], "filter": {…},
 *                        "filter_by_locators": […], "from_component_tipo": "test80" } }
 *
 * Inside T's SQO filter the leaf means: the T rows that are the TARGET of a
 * locator STORED by a record of the source set — "records of T referenced by
 * any record matching S". The forward direction (owner → target) reads the
 * ORIGINAL data: each source row's own `relation` jsonb column, expanded in
 * SQL ({@link storedLocatorExpansionSql}) — exactly read_raw's
 * `target_section` harvest (every key of the relation object, array values
 * only, `locator.section_tipo` matched, the component key asked of the row's
 * own section). NOT the derived matrix_relation_index: that copy can drift
 * (replica-role / disabled-trigger / --disable-triggers restores, TRUNCATE,
 * non-int section_id exclusion) and does not exist for log tables. The index
 * stays the engine of the INVERSE lookups (relation_list, delete propagation).
 *
 *   ((alias.section_tipo, alias.section_id) IN (
 *     SELECT DISTINCT l.target_section_tipo, l.target_section_id
 *     FROM (<stored locators of the source scoped row set, keyed>) l
 *     WHERE l.target_section_tipo IN (<T's sections>))) IS TRUE
 *
 * (one hashed SubPlan — see conformReferencedBy for why the shape is fixed)
 *
 * The pair is matched on the row's OWN section_tipo, so a multi-section T
 * (one table or several) is served exactly, never by id alone. T's own read
 * gate, records ACL and pagination are the outer assembler's — `count` runs the
 * same statement, so the count equals the rows.
 *
 * THE SOURCE IS AUTHORIZED AS A READ (the same rule as read_raw): read >= 1 on
 * EVERY source section, else `perm.denied` (one typed question, one answer);
 * its rows are the principal's scoped row set (sql_assembler
 * buildScopedRowSetSql — the list's own WHERE: projects/owner ACL, dd478, the
 * SEC-1/SEC-02 keys of its own filter); and a locator is visible only through a
 * component the principal may read on the OWNING section (the SEC-1 relation
 * key, conform.ts sectionFromComponentCondition — asked of the relation
 * object's key, the component that stores the locator: an explicit hidden
 * `from_component_tipo` refuses, an absent one means, for a non-admin, the
 * section's DECLARED relation components it may read — always as an allowlist,
 * so a stored key outside the ontology is never followed (read_raw's per-key
 * answer) — and, for a global admin, every key; every narrowing by a hidden
 * component records the request's `perm.out_of_scope` notice). A source with no visible locator answers `1=0` (the refusal law:
 * identical hit and miss). Log tables (activity) are legal sources, as in
 * read_raw: every record table carries the `relation` column.
 *
 * Locators whose `section_id` is not an int4 (e.g. an external remote id)
 * cannot name a record row and are skipped (the cast is guarded, never raised).
 */

import {
	MAX_REFERENCED_BY_DEPTH,
	parseReferencedByLeaf,
	type ReferencedBySource,
	type Sqo,
} from '../../concepts/sqo.ts';
import { DedaloError } from '../../errors/dedalo_error.ts';
import { getMatrixTableFromTipo } from '../../ontology/resolver.ts';
import type { SqlFrontierScope } from '../../security/frontier_scope.ts';
import { getPermissions, type Principal } from '../../security/permissions.ts';
import {
	type ConformedFilter,
	combineSectionConditions,
	type RelationLeafLocator,
	type RelationLeafSink,
	sectionFromComponentCondition,
} from '../conform.ts';
import { assertValidTipo } from '../identifier_gate.ts';
import { NamedTokenCollector } from '../params.ts';
import { buildScopedRowSetSql } from '../sql_assembler.ts';
import { fragment } from './types.ts';

/**
 * The stored locators one source set may show: `locatorsSql` is a SELECT whose
 * rows are `(target_section_tipo text, target_section_id int)` — one per stored
 * locator of a source row (duplicates kept), int4-addressable only, already
 * restricted by the component key and the optional from_component_tipo. Its
 * values ride as NAMED tokens (`tokenValues`). Shared by the leaf and the
 * relation_targets census (search/relation_targets.ts), so the two cannot
 * answer differently.
 */
export interface OwnerRelationScope {
	locatorsSql: string;
	tokenValues: Record<string, unknown>;
}

/**
 * THE LATERAL EXPANSION of a row set's stored `relation` column — the ONE
 * spelling of "the locators these rows store" (the leaf and the census both
 * reach it through {@link buildOwnerRelationScope}). `rowSetSql` must project
 * `section_tipo, section_id, relation` (buildScopedRowSetSql `withRelation`).
 * The derived table is aliased `r` with the columns the SEC-1 component key
 * reads (conform.ts combineSectionConditions / componentInList):
 *   r.section_tipo, r.section_id   — the OWNING row (its own section);
 *   r.from_component_tipo          — the relation object's key (the storing component);
 *   r.target_section_tipo          — locator.section_tipo;
 *   r.target_section_id            — locator.section_id as int4, NULL otherwise.
 * read_raw's harvest semantics: a non-object relation contributes nothing, a
 * non-array key value contributes nothing, a non-object entry has no target.
 * The int cast is guarded by NESTED CASE (CASE fixes evaluation order; an AND
 * would not), so a malformed id is skipped, never an error.
 */
export function storedLocatorExpansionSql(rowSetSql: string, depth: number): string {
	const wrap = `rsw${depth}`;
	const kv = `rkv${depth}`;
	const loc = `rloc${depth}`;
	const id = `(${loc}.value ->> 'section_id')`;
	return (
		`SELECT ${wrap}.section_tipo, ${wrap}.section_id, ${kv}.key AS from_component_tipo, ` +
		`${loc}.value ->> 'section_tipo' AS target_section_tipo, ` +
		`CASE WHEN ${id} ~ '^[0-9]{1,10}$' THEN CASE WHEN ${id}::bigint <= 2147483647 ` +
		`THEN ${id}::int END END AS target_section_id ` +
		`FROM (${rowSetSql}) AS ${wrap} ` +
		`CROSS JOIN LATERAL jsonb_each(CASE WHEN jsonb_typeof(${wrap}.relation) = 'object' ` +
		`THEN ${wrap}.relation ELSE '{}'::jsonb END) AS ${kv} ` +
		`CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(${kv}.value) = 'array' ` +
		`THEN ${kv}.value ELSE '[]'::jsonb END) AS ${loc}`
	);
}

/** The source set as the SQO its row set is compiled from (the found set: no page). */
function sourceSqo(source: ReferencedBySource, sections: string[]): Sqo {
	return {
		section_tipo: sections,
		...(source.filter === undefined || source.filter === null ? {} : { filter: source.filter }),
		...(source.filter_by_locators === undefined || source.filter_by_locators === null
			? {}
			: { filter_by_locators: source.filter_by_locators }),
	} as Sqo;
}

/** Refuse a leaf nested past MAX_REFERENCED_BY_DEPTH (server-built SQOs reach here unsanitized). */
function assertDepth(depth: number): void {
	if (depth <= MAX_REFERENCED_BY_DEPTH) return;
	throw new DedaloError('request.invalid_options', {
		message: `search conform: referenced_by nested ${depth} deep (max ${MAX_REFERENCED_BY_DEPTH})`,
		publicMessage: `Invalid referenced_by filter: nested deeper than the maximum of ${MAX_REFERENCED_BY_DEPTH}`,
	});
}

/** read >= 1 on EVERY source section (the read_raw rule) — else perm.denied. */
async function authorizeSourceSections(principal: Principal, sections: readonly string[]) {
	for (const sectionTipo of sections) {
		if ((await getPermissions(principal, sectionTipo, sectionTipo)) < 1) {
			throw new DedaloError('perm.denied', {
				message: `referenced_by: no read grant on source section '${sectionTipo}'`,
				coordinates: { section_tipo: sectionTipo },
			});
		}
	}
}

/** Each source section's record table, aligned with `sections` (a missing one throws). */
async function sourceTables(sections: readonly string[]): Promise<string[]> {
	const tables: string[] = [];
	for (const sectionTipo of sections) {
		const table = await getMatrixTableFromTipo(sectionTipo);
		if (table === null) {
			throw new DedaloError('request.invalid_tipo', {
				message: `referenced_by: no matrix table for source section '${sectionTipo}'`,
				coordinates: { tipo: sectionTipo },
			});
		}
		tables.push(table);
	}
	return tables;
}

/**
 * The SEC-1 key scope of the SOURCE rows: the owning rows are bound to the
 * source sections (their scoped row set pins them), so the component key is
 * asked of THOSE. The record predicate is the row set's own business — this
 * scope only keys components, and refuses loudly if anything asks it for a
 * record predicate.
 */
function sourceKeyScope(principal: Principal, sections: readonly string[]): SqlFrontierScope {
	return {
		principal,
		surface: 'search',
		door: 'search.referenced_by',
		mainSectionTipos: sections,
		recordPredicate: () => {
			throw new DedaloError('internal.invariant', {
				message: 'referenced_by: the source key scope carries no record predicate',
			});
		},
	};
}

/**
 * The component key over the owning rows, per source section on its own table,
 * combined on `r.section_tipo` ('' = unrestricted, null = every locator hidden).
 */
async function componentKey(
	principal: Principal,
	sections: readonly string[],
	tables: readonly string[],
	locator: RelationLeafLocator,
	sink: RelationLeafSink,
): Promise<string | null> {
	const scope = sourceKeyScope(principal, sections);
	// The expansion reads EVERY stored key, so a non-admin is always keyed by
	// the declared, granted components (never "unrestricted" because nothing
	// happens to be hidden): an undeclared key is never followed, as in
	// read_raw's per-key harvest. A global admin reads every key there too.
	const allowlistAlways = !principal.isGlobalAdmin;
	const perSection: [string, string | null][] = [];
	for (const [index, sectionTipo] of sections.entries()) {
		const table = tables[index] as string;
		perSection.push([
			sectionTipo,
			await sectionFromComponentCondition(
				scope,
				sectionTipo,
				table,
				locator,
				sink,
				allowlistAlways,
			),
		]);
	}
	return combineSectionConditions(perSection, sink);
}

/** A token sink minting `_RK<depth>n<i>_` into its own map. */
function keySink(depth: number): RelationLeafSink {
	let index = 0;
	return {
		tokenValues: {},
		nextToken: () => {
			index += 1;
			return `_RK${depth}n${index}_`;
		},
	};
}

/** The row set's tokens that its SQL actually references (no orphan bind). */
function usedTokens(
	sqlText: string,
	tokenValues: Record<string, unknown>,
): Record<string, unknown> {
	return Object.fromEntries(
		Object.entries(tokenValues).filter(([token]) => sqlText.includes(token)),
	);
}

/**
 * THE OWNER-SIDE SCOPE of one source set at nesting `depth` (1 = a leaf in a
 * main filter, or the relation_targets census's source), or null when the
 * principal may read no locator of it (every relation component hidden).
 * Throws `request.invalid_options` (depth), `request.invalid_tipo`,
 * `perm.denied` (no read on a source section).
 */
export async function buildOwnerRelationScope(
	source: ReferencedBySource,
	options: { principal?: Principal; depth: number },
): Promise<OwnerRelationScope | null> {
	assertDepth(options.depth);
	const sections = source.section_tipo.map((tipo) =>
		assertValidTipo(tipo, 'referenced_by.section_tipo'),
	);
	const principal = options.principal;
	if (principal !== undefined) await authorizeSourceSections(principal, sections);
	const tables = await sourceTables(sections);
	const from = explicitFromComponent(source);
	const sink = keySink(options.depth);
	const key = await ownerComponentKey(principal, sections, tables, from, sink);
	if (key === null) return null;
	const rowSet = await buildScopedRowSetSql(sourceSqo(source, sections), {
		...(principal === undefined ? {} : { principal }),
		tokens: new NamedTokenCollector(`RS${options.depth}n`),
		alias: `rs${options.depth}`,
		depth: options.depth,
		withRelation: true,
	});
	return assembleOwnerScope(rowSet, options.depth, key, from, sink);
}

/** The source's from_component_tipo, identifier-gated (undefined = any component). */
function explicitFromComponent(source: ReferencedBySource): string | undefined {
	if (source.from_component_tipo === undefined) return undefined;
	return assertValidTipo(source.from_component_tipo, 'referenced_by.from_component_tipo');
}

/** The component key for a principal ('' for an internal search: nothing to key). */
async function ownerComponentKey(
	principal: Principal | undefined,
	sections: readonly string[],
	tables: readonly string[],
	from: string | undefined,
	sink: RelationLeafSink,
): Promise<string | null> {
	if (principal === undefined) return '';
	const locator: RelationLeafLocator =
		from === undefined ? [] : [['from_component_tipo', 'text', from]];
	return componentKey(principal, sections, tables, locator, sink);
}

/** The row set's stored locators, int-addressable, AND the component key, AND the explicit component. */
function assembleOwnerScope(
	rowSet: { sql: string; tokenValues: Record<string, unknown> },
	depth: number,
	key: string,
	from: string | undefined,
	sink: RelationLeafSink,
): OwnerRelationScope {
	const parts = ['r.target_section_tipo IS NOT NULL', 'r.target_section_id IS NOT NULL'];
	if (key !== '') parts.push(key);
	if (from !== undefined) {
		const name = sink.nextToken();
		sink.tokenValues[name] = from;
		parts.push(`r.from_component_tipo = ${name}::text`);
	}
	return {
		locatorsSql:
			'SELECT r.target_section_tipo, r.target_section_id ' +
			`FROM (${storedLocatorExpansionSql(rowSet.sql, depth)}) AS r WHERE ${parts.join(' AND ')}`,
		tokenValues: { ...usedTokens(rowSet.sql, rowSet.tokenValues), ...sink.tokenValues },
	};
}

/**
 * The leaf's restriction to T's own sections (the outer WHERE's pin, which
 * the scope carries as `mainSectionTipos`): only those targets are hashed.
 * '' when the scope names none (the pair match alone is still exact).
 */
function targetSectionPin(
	scope: SqlFrontierScope | undefined,
	locatorsAlias: string,
	depth: number,
	tokenValues: Record<string, unknown>,
): string {
	const sections = scope?.mainSectionTipos ?? [];
	if (sections.length === 0) return '';
	const names = sections.map((sectionTipo, index) => {
		const name = `_RT${depth}n${index + 1}_`;
		tokenValues[name] = assertValidTipo(sectionTipo, 'referenced_by target section');
		return `${name}::text`;
	});
	return ` WHERE ${locatorsAlias}.target_section_tipo IN (${names.join(', ')})`;
}

/**
 * Conform ONE `referenced_by` leaf (conform.ts routes it here BEFORE the path
 * check). `depth` = the leaves already enclosing it; `alias` = T's main alias.
 * A malformed leaf THROWS `request.invalid_options` — it never falls through to
 * the pathless-leaf drop, which would widen T to the whole section.
 */
export async function conformReferencedBy(
	leaf: unknown,
	alias: string,
	scope: SqlFrontierScope | undefined,
	depth: number,
): Promise<ConformedFilter> {
	const leafDepth = depth + 1;
	assertDepth(leafDepth);
	const source = parseReferencedByLeaf(leaf);
	const owner = await buildOwnerRelationScope(source, {
		...(scope?.principal === undefined ? {} : { principal: scope.principal }),
		depth: leafDepth,
	});
	if (owner === null) return { kind: 'leaf', fragment: fragment('1=0') };
	// THE PLAN SHAPE IS PART OF THE CONTRACT. `(…) IN (SELECT DISTINCT …) IS TRUE`
	// keeps the sublink out of the planner's semi-join pull-up, so it runs as ONE
	// hashed SubPlan: the source row set and its lateral expansion execute
	// exactly once, then each T row probes the hash. As a pulled-up semi-join,
	// freshly bulk-inserted rows with stale statistics (estimate rows=1) made
	// the planner pick a nested loop that RE-RAN the whole expansion per T row
	// (measured: 1 038 T rows × 1 037 sources = 3.9 s flat, >20 s at depth 4;
	// hashed: 15 ms / 3 ms). DISTINCT keeps the subplan's row estimate small
	// (the default distinct-count of an expression) so the hash is always
	// chosen — jsonb_each's 100-rows-per-call estimate alone would otherwise
	// push a large source past hash_mem into a per-row materialized rescan.
	// IS TRUE is also the exact two-valued meaning under a negation.
	const tokenValues = { ...owner.tokenValues };
	const locators = `rbl${leafDepth}`;
	const pin = targetSectionPin(scope, locators, leafDepth, tokenValues);
	// `expandsReferencedBy`: the statement this renders into is bounded by the
	// search executor (search/search_statement.ts) — marked HERE, where the
	// expansion is emitted, never inferred from the SQO.
	return {
		kind: 'leaf',
		fragment: {
			...fragment(
				`((${alias}.section_tipo, ${alias}.section_id) IN (SELECT DISTINCT ${locators}.target_section_tipo, ` +
					`${locators}.target_section_id FROM (${owner.locatorsSql}) AS ${locators}${pin})) IS TRUE`,
				tokenValues,
			),
			expandsReferencedBy: true,
		},
	};
}
