/**
 * SQO conform stage (Phase A of the two-phase search pipeline, spec §3.3).
 *
 * Walks the sanitized SQO's filter tree; for every LEAF:
 *   1. validates all identifiers at the §7.6 chokepoint (tipos, lang),
 *   2. resolves the component's model/column/translatability from the ontology,
 *   3. dispatches to the per-model fragment builder,
 * and returns a ConformedFilter tree whose leaves carry BuilderResults
 * (`fragment` — never an envelope `result`).
 *
 * PHP reference: search::parse_sqo/conform_filter (class.search.php:733/:809)
 * and the per-component resolve_query_object_sql traits.
 *
 * DISPATCH (header re-dated 2026-07-07, S2-45 — the old UNCOVERED list here
 * described long-landed gaps; coverage-state lists live in rewrite/STATUS.md):
 * non-relation models dispatch by their descriptor's `searchBuilder` family
 * (components/registry.ts, S2-26); relation-column models dispatch through
 * the relations registry. A model with no declared family and no relation
 * column throws loudly (plan §9 no-silent-narrowing) — that throw is the
 * ledger, not a bug.
 */

import { readString } from '../../config/readers.ts';
import { getSearchBuilderFamily } from '../components/registry.ts';
import { isReferencedByLeaf, type SqoFilterLeaf, type SqoFilterNode } from '../concepts/sqo.ts';
import { DedaloError } from '../errors/dedalo_error.ts';
import { createOntologyCache } from '../ontology/cache_factory.ts';
import {
	getColumnNameByModel,
	getModelByTipo,
	getNode,
	getTranslatableByTipo,
	savesInRequestLang,
} from '../ontology/resolver.ts';
import {
	frontierComponentAllowed,
	frontierSectionIsGloballyVisible,
	noteFrontierRefusal,
	type SqlFrontierScope,
} from '../security/frontier_scope.ts';
import { metadataComponentTipos, searchSurfaceGrants } from '../security/permissions.ts';
import { buildDateFragment, classifyDate } from './builders/builder_date.ts';
import { buildIriFragment, classifyIri } from './builders/builder_iri.ts';
import { buildJsonFragment, classifyJson } from './builders/builder_json.ts';
import { buildNumberFragment, classifyNumber } from './builders/builder_number.ts';
import { buildSectionIdFragment, classifySectionId } from './builders/builder_section_id.ts';
import { buildStringFragment, classifyString } from './builders/builder_string.ts';
import type { BuilderContext, BuilderOpts, BuilderResult, LeafPolarity } from './builders/types.ts';
import {
	compound,
	extractNormalizedQ,
	fragment as fragmentResult,
	splitSearchTerms,
} from './builders/types.ts';
import { firstHopSources, hopScopeClause } from './hop_scope.ts';
import {
	assertValidLang,
	assertValidTipo,
	assertValidTipoOrColumn,
	resolveSqlDataTipo,
	type SqlTipo,
} from './identifier_gate.ts';
import { requireRelationIndex, searchStoreCovers } from './search_store.ts';

/** Default data language of the installation (PHP DEDALO_DATA_LANG). */
const _DEFAULT_DATA_LANG = readString('DATA_LANG');

/**
 * NON-relation fragment builders, keyed by the descriptor's `searchBuilder`
 * family (S2-26 — the per-model membership lives on each descriptor, this map
 * only binds family name → builder function). The RELATION family dispatches
 * through the relations registry (getRelationSearchFragmentBuilder — the
 * search face of relations/registry.ts): the shared containment builder for
 * the whole family, explicit uncovered throws for the dedicated unported
 * pipelines (children/index/external).
 */
const FAMILY_BUILDERS: Record<
	NonNullable<ReturnType<typeof getSearchBuilderFamily>>,
	(
		q: unknown,
		qOperator: string | null,
		qSplit: boolean,
		context: BuilderContext,
		opts?: BuilderOpts,
	) => BuilderResult
> = {
	string: buildStringFragment,
	number: (q, qOperator, _qSplit, context) => buildNumberFragment(q, qOperator, context),
	date: (q, qOperator, _qSplit, context) => buildDateFragment(q, qOperator, context),
	iri: (q, qOperator, _qSplit, context, opts) => buildIriFragment(q, qOperator, context, opts),
	json: (q, qOperator, _qSplit, context, opts) => buildJsonFragment(q, qOperator, context, opts),
	section_id: (q, qOperator, _qSplit, context) => buildSectionIdFragment(q, qOperator, context),
};

/**
 * The deep-search classifiers of the same families — each builder file's own
 * classify<Family>(), the ONE parse of its operator grammar, so the shallow
 * SQL and the deep polarity can never read an operator differently.
 */
const FAMILY_CLASSIFIERS: Record<
	NonNullable<ReturnType<typeof getSearchBuilderFamily>>,
	(q: unknown, qOperator: string | null) => LeafPolarity
> = {
	string: (q, qOperator) => classifyString(q, qOperator),
	number: classifyNumber,
	date: classifyDate,
	iri: (q, qOperator) => classifyIri(q, qOperator),
	json: (q, qOperator) => classifyJson(q, qOperator),
	section_id: classifySectionId,
};

/** One LEFT JOIN chain fragment a multi-hop leaf requires (keyed for dedup). */
export interface JoinFragment {
	alias: string;
	sql: string;
}

export type ConformedFilter =
	| { kind: 'group'; op: string; items: ConformedFilter[] }
	/** `fragment` is the leaf's BuilderResult — the SQL it contributes, `false` when it contributes nothing. */
	| { kind: 'leaf'; fragment: BuilderResult }
	/**
	 * A filter leaf whose path crosses relation hops (path.length > 1), as
	 * conform classified it. Never rendered as is: deep_path.ts planDeepFilters
	 * turns it into `semijoin` nodes (WC-2026-09-29-search-deep-leaf-mixed-rule).
	 */
	| DeepLeafNode
	/**
	 * A deep-path semi-join (deep_path.ts): `open` + the inner leaf
	 * predicate(s) + `close`. Contributes no joins. `open`/`close` carry only
	 * gated identifiers and the frontier ACL predicates, whose values ride as
	 * NAMED tokens (`tokens`, NamedTokenCollector) bound only when rendered.
	 */
	| {
			kind: 'semijoin';
			open: string;
			inner: BuilderResult;
			close: string;
			tokens: Record<string, unknown>;
	  };

/**
 * One clause of a DEEP leaf. Every `result` is POSITIVE, built over the last
 * hop alias; negation lives only in `neg` (NOT EXISTS over the related
 * records). `reverse` is the same predicate for the reversed (leaf-driven)
 * shape — with the search-store prefilter where the family has one.
 */
export interface DeepClause {
	neg: boolean;
	result: BuilderResult;
	reverse: BuilderResult;
}

/** A classified deep leaf: its chain, the field it reads, its clauses. */
export interface DeepLeafNode {
	kind: 'deep';
	plan: DeepChainPlan;
	/** The leaf component tipo — the "same field" key of the mixed rule. */
	field: string;
	/** Every clause is positive: the leaf may share one related record with siblings. */
	positive: boolean;
	clauses: DeepClause[];
	/**
	 * SEC-1 row-section key (conform rowKeyedLeaf): when only SOME main sections
	 * grant the path's root component, the leaf holds only on rows of those
	 * sections. ANDed by deep_path.ts outside the unit's semi-join(s).
	 */
	rowKey?: BuilderResult;
}

/** One hop of a multi-hop chain, as buildJoinChain resolved it. */
export interface JoinHop {
	/** Storage key of the hop component on the SOURCE record (alias-resolved). */
	hopDataTipo: string;
	/** Alias of the TARGET record this hop joins. */
	alias: string;
	/** Matrix table of the target step's declared section. */
	table: string;
	/** The caller's record ACL on the target alias ('' when none). */
	acl: string;
	/**
	 * The hop as a FROM item of a correlated semi-join (purpose 'filter'):
	 * `jsonb_array_elements(<previous>.relation->'<key>') AS rel_<alias> JOIN
	 * <table> AS <alias> ON <locator identity> [AND (<acl>)]` — the same ON
	 * conjuncts as the LEFT JOIN, so the two cannot drift.
	 */
	join: string;
}

/** The hop chain of one multi-hop leaf, as deep_path.ts renders it. */
export interface DeepChainPlan {
	mainAlias: string;
	hops: JoinHop[];
}

/**
 * THE PER-REQUEST ACL A MULTI-HOP PATH MUST OBEY (SEC-02, 2026-08-28).
 *
 * A hop is a READ of another section's records: `LEFT JOIN LATERAL` unnests a
 * stored locator and joins the target row, and the leaf predicate is then built
 * against THAT alias. Before this scope existed neither `conformLeaf` nor
 * {@link buildJoinChain} received a principal, and `buildSearchSql` emitted its
 * ACL clauses (projects containment + the dd478 record filter) against the MAIN
 * alias ONLY — so the WHERE clause of a listing the caller IS allowed to run
 * could name a component of a record the caller is NOT allowed to see, and the
 * row's presence answered a question about it. With begins-with, ends-with,
 * contains and `==` all available, that is a PREFIX ORACLE: the hidden value
 * comes out character by character.
 *
 * THE SCOPE OBJECT ITSELF LIVES IN `core/security/frontier_scope.ts` — one
 * shape for the search, the export and the diffusion frontier, with the refusal
 * law for all three written down beside it. This module only re-exports the
 * name it threads, so a reader of the search path finds the type without a
 * second definition existing anywhere.
 */
export type { SqlFrontierScope } from '../security/frontier_scope.ts';

/**
 * Build the PHP build_sql_join chain for a multi-hop path: per hop, a
 * LATERAL unnest of the previous alias's relation key + a LEFT JOIN of the
 * target matrix table on the unnested locator identity. Aliases derive
 * deterministically from the path chain (identical paths dedup to the same
 * joined rows — the PHP rule). Used by filter leaves AND order paths.
 *
 * ACL (SEC-02): when a {@link SqlFrontierScope} is threaded in, every hop
 * carries BOTH frontier keys (frontier_scope.ts property 2):
 *
 *   1. the RECORD key — the caller's projects/dd478 predicate, emitted in the
 *      join's ON clause (never the WHERE: see SqlFrontierScope's docblock).
 *   2. the COMPONENT key — `frontierComponentAllowed`, i.e. `ddoIsAuthorized`
 *      on this step's own (section, component), under the frontier exemptions.
 *      That is the SAME predicate that decides whether the client could
 *      legitimately BUILD this path at all: a multi-hop filter path is minted
 *      by the client from `search.ddo_map` / `show.ddo_map` (common.js
 *      build_rqo_search → get_ar_inverted_paths, one path per leaf ddo), and
 *      `section/read.ts` buildStructureContextEntries DROPS any ddo that fails
 *      `ddoIsAuthorized(principal, ddoSectionTipo, ddo.tipo)`.
 *
 * A refused step is reported through `authorized:false` — never thrown, never
 * silent: the caller applies the SEARCH refusal law (identical hit and miss)
 * and `noteFrontierRefusal` has already written the operator log line and the
 * request's notice.
 *
 * The step's DECLARED section is authoritative for both keys, exactly as it
 * already is for the table, the component model and the data column: a stored
 * locator naming another section in the same table is being interpreted with
 * this section's ontology either way.
 */
export async function buildJoinChain(
	path: { section_tipo?: string; component_tipo?: string }[],
	mainAlias: string,
	scope?: SqlFrontierScope,
	/**
	 * WHAT THE CHAIN IS FOR — the ONE thing the two twins may legitimately
	 * differ on, declared here so they cannot drift anywhere else (PERF-08).
	 *
	 * A relation component holds an ARRAY of locators, and `jsonb_array_elements`
	 * fans one record into one row per locator.
	 *
	 * - 'filter' (default) KEEPS the fan-out: a filter must match ANY locator,
	 *   so every locator has to be visible as its own row.
	 * - 'order' COLLAPSES it to exactly ONE row — `WITH ORDINALITY … ORDER BY
	 *   ord LIMIT 1` inside the LATERAL. THE RULE: **a multi-locator component
	 *   sorts by its FIRST STORED locator**, which is the record's own stored
	 *   order and the same order the client renders the portal in. Without the
	 *   collapse the sort key of a two-locator record is whichever fan-out row
	 *   the DISTINCT ON happened to keep (arbitrary, and not stable between two
	 *   identical paints), and the whole related section has to materialise
	 *   before the LIMIT can apply.
	 *
	 * The LEFT semantics are identical either way: an empty/absent relation key
	 * yields no lateral row and the LEFT JOIN still emits the outer row.
	 */
	purpose: 'filter' | 'order' = 'filter',
): Promise<{
	joins: JoinFragment[];
	lastAlias: string;
	lastTable: string;
	/** False when the principal holds no read grant on some step's component. */
	authorized: boolean;
	hops: JoinHop[];
}> {
	const { getMatrixTableFromTipo } = await import('../ontology/resolver.ts');
	const joins: JoinFragment[] = [];
	const hops: JoinHop[] = [];
	let previousAlias = mainAlias;
	let lastTable = '';
	let authorized = true;
	const aliasChain: string[] = [];
	// The sections the previous hop may have reached (hop_scope.ts); undefined
	// before the first hop, which starts from the search's own sections.
	let admitted: string[] | undefined;
	for (let index = 1; index < path.length; index++) {
		const step = path[index] as { section_tipo?: string; component_tipo?: string };
		const hopComponent = (path[index - 1] as { component_tipo?: string }).component_tipo;
		const stepSection = step.section_tipo;
		if (stepSection === undefined || hopComponent === undefined) {
			throw new DedaloError('search.invalid_sqo', {
				message: 'search conform: a multi-hop path step needs section_tipo + component_tipo',
				publicMessage: 'Every step of a multi-hop search path needs a section and a component',
			});
		}
		assertValidTipo(stepSection, 'join path');
		// A HOP component is unnested as `relation-><tipo>`, so it must be a real
		// ontology tipo — never one of the bare data columns the §7.6 gate also
		// admits for a LEAF (`assertValidTipoOrColumn`, e.g. ordering by
		// 'section_id'). This is the ORDER twin's long-standing strictness; the
		// FILTER twin inherited it when conformLeaf stopped copy-pasting this loop
		// (2026-08-28). It narrows nothing a producer sends — measured, no shipped
		// caller names a column at an INTERMEDIATE step (the client builds every
		// path step from a ddo's own tipo, and the suite ontology holds zero
		// multi-hop fixed_filter paths) — and what it used to do instead was
		// unnest a key no relation column has and match nothing, silently.
		assertValidTipo(hopComponent, 'join path');
		// component_alias (WC-020): stored locators live under the TARGET's key —
		// a value the ontology swaps in, so it passes the gate again (SURF-1).
		const hopDataTipo: SqlTipo = await resolveSqlDataTipo(hopComponent, 'join path');
		const stepTable = await getMatrixTableFromTipo(stepSection);
		if (stepTable === null) {
			throw new DedaloError('search.invalid_sqo', {
				message: `search conform: no matrix table for join step '${stepSection}'`,
				publicMessage: 'A section named in the search path holds no records',
				coordinates: { step_section_tipo: stepSection },
			});
		}
		aliasChain.push(`${hopDataTipo}_${stepSection}`);
		// The two purposes emit DIFFERENT joins over the same path (fanned vs
		// collapsed), so they must never dedup into each other in the assembler's
		// alias-keyed join sink — one namespace each.
		const joinAlias = `${purpose === 'order' ? 'o' : 'j'}_${aliasChain.join('_')}`;
		const relationAlias = `rel_${joinAlias}`;
		// The jsonb locator itself: the lateral's own row in the 'filter' shape, a
		// single projected column in the collapsed 'order' one.
		const locatorRef = purpose === 'order' ? `${relationAlias}.value` : relationAlias;
		// ON-clause conjuncts: the locator identity, then the caller's record ACL.
		const onParts = [
			`${joinAlias}.section_id = NULLIF((${locatorRef}->>'section_id'), '')::bigint`,
			`${joinAlias}.section_tipo = (${locatorRef}->>'section_tipo')::text`,
		];
		let acl = '';
		if (scope !== undefined) {
			// This step's OWN component: the leaf component on the last step, the
			// next hop's relation component on an intermediate one — both are read
			// through this alias, so both need the grant.
			const frontierStep = {
				sectionTipo: stepSection,
				...(step.component_tipo === undefined ? {} : { componentTipo: step.component_tipo }),
				table: stepTable,
			};
			if (!(await frontierComponentAllowed(scope, frontierStep))) {
				authorized = false;
				noteFrontierRefusal(scope, {
					surface: scope.surface,
					door: scope.door,
					sectionTipo: stepSection,
					...(step.component_tipo === undefined ? {} : { componentTipo: step.component_tipo }),
					key: 'component',
				});
			}
			// The RECORD key, per joined SECTION (hop_scope.ts): the hop component's
			// configured targets the caller may read, each under its own record
			// predicate — never "whatever section a locator names".
			const hopScope = await hopScopeClause(scope, {
				hopComponent,
				sourceSections: admitted ?? firstHopSources(scope, path),
				stepSection,
				stepComponent: step.component_tipo,
				stepTable,
				alias: joinAlias,
			});
			admitted = hopScope.admitted;
			const predicate = hopScope.clause;
			if (predicate !== '') {
				onParts.push(`(${predicate})`);
				acl = predicate;
			}
		}
		hops.push({
			hopDataTipo,
			alias: joinAlias,
			table: stepTable,
			acl,
			join:
				`jsonb_array_elements(${previousAlias}.relation->'${hopDataTipo}') AS ${relationAlias}\n  ` +
				`JOIN ${stepTable} AS ${joinAlias} ON ${onParts.join(' AND ')}`,
		});
		joins.push({
			alias: joinAlias,
			sql:
				(purpose === 'order'
					? `LEFT JOIN LATERAL (SELECT locator.value FROM jsonb_array_elements(${previousAlias}.relation->'${hopDataTipo}') WITH ORDINALITY AS locator(value, ord) ORDER BY locator.ord LIMIT 1) AS ${relationAlias}(value) ON true\n`
					: `LEFT JOIN LATERAL jsonb_array_elements(${previousAlias}.relation->'${hopDataTipo}') AS ${relationAlias} ON true\n`) +
				`LEFT JOIN ${stepTable} AS ${joinAlias} ON ${onParts.join(' AND ')}`,
		});
		previousAlias = joinAlias;
		lastTable = stepTable;
	}
	return { joins, lastAlias: previousAlias, lastTable, authorized, hops };
}

const BOOLEAN_OPERATORS: ReadonlySet<string> = new Set(['$and', '$or', '$not', '$nand', '$nor']);

/** Tables with no `relation_search` ancestor index (scalar TM relation data). */
const TIME_MACHINE_TABLES: ReadonlySet<string> = new Set([
	'matrix_time_machine',
	'matrix_activity',
]);

/**
 * One relation-leaf locator resolved to matrix_relation_index columns:
 * ordered [column, cast, value] triples ready for tuple-IN emission.
 */
export type RelationLeafLocator = [string, 'text' | 'int', string][];

/** format:'relation' q fields → index columns (the locator vocabulary). */
const RELATION_LEAF_FIELDS: Record<string, [string, 'text' | 'int']> = {
	section_tipo: ['target_section_tipo', 'text'],
	section_id: ['target_section_id', 'int'],
	from_component_tipo: ['from_component_tipo', 'text'],
	type: ['type', 'text'],
};

/**
 * Parse one format:'relation' locator object — strict: unknown fields,
 * invalid tipos, a non-integer section_id or a missing section_tipo throw.
 */
function parseRelationLeafLocator(raw: unknown): RelationLeafLocator {
	if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
		throw new DedaloError('search.invalid_sqo', {
			message: "search conform: format 'relation' q must be a locator object or an array of them",
			publicMessage: "A 'relation' filter value must be a locator or an array of locators",
		});
	}
	const record = raw as Record<string, unknown>;
	if (typeof record.section_tipo !== 'string' || record.section_tipo === '') {
		throw new DedaloError('search.invalid_sqo', {
			message: "search conform: format 'relation' locator needs a section_tipo",
			publicMessage: "A 'relation' filter locator needs a section_tipo",
		});
	}
	const resolved: RelationLeafLocator = [];
	for (const [field, value] of Object.entries(record)) {
		const mapped = RELATION_LEAF_FIELDS[field];
		if (mapped === undefined) {
			throw new DedaloError('search.invalid_sqo', {
				message:
					`search conform: format 'relation' unknown locator field '${field}' ` +
					`(allowed: ${Object.keys(RELATION_LEAF_FIELDS).join(', ')})`,
				publicMessage: `A 'relation' filter locator accepts only: ${Object.keys(RELATION_LEAF_FIELDS).join(', ')}`,
				coordinates: { field },
			});
		}
		const [column, cast] = mapped;
		if (cast === 'int') {
			const id = String(value);
			if (!/^-?[0-9]+$/.test(id)) {
				throw new DedaloError('search.invalid_sqo', {
					message: `search conform: format 'relation' section_id '${String(value)}' is not an integer`,
					publicMessage: "A 'relation' filter section_id must be an integer",
				});
			}
			resolved.push([column, cast, id]);
		} else {
			resolved.push([column, cast, assertValidTipo(String(value), `relation leaf ${field}`)]);
		}
	}
	return resolved;
}

/** format:'relation' q: one locator object, or an array (OR within the leaf). */
function parseRelationLeafQ(rawQ: unknown): RelationLeafLocator[] {
	const items = Array.isArray(rawQ) ? rawQ : [rawQ];
	if (items.length === 0) {
		throw new DedaloError('search.invalid_sqo', {
			message: "search conform: format 'relation' q array is empty",
			publicMessage: "A 'relation' filter needs at least one locator",
		});
	}
	return items.map(parseRelationLeafLocator);
}

/**
 * DEPRECATED format:'function' reader (WC-012): resolve the allowlisted
 * variant name + flattened key into the same locator triples. Unknown names
 * throw (allowlist-only, never interpolated); a malformed key returns null
 * (contributes nothing — the legacy contract).
 */
const LEGACY_FLAT_VARIANTS: Record<string, [string, 'text' | 'int'][]> = {
	relations_flat_st_si: [
		['target_section_tipo', 'text'],
		['target_section_id', 'int'],
	],
	relations_flat_fct_st_si: [
		['from_component_tipo', 'text'],
		['target_section_tipo', 'text'],
		['target_section_id', 'int'],
	],
	relations_flat_ty_st_si: [
		['type', 'text'],
		['target_section_tipo', 'text'],
		['target_section_id', 'int'],
	],
	relations_flat_ty_st: [
		['type', 'text'],
		['target_section_tipo', 'text'],
	],
};

function parseLegacyFunctionLeaf(leaf: {
	use_function?: unknown;
	q?: unknown;
}): RelationLeafLocator | null {
	// accept both the v6 client spelling and the data_-prefixed form
	const name = String(leaf.use_function ?? '').replace(/^data_/, '');
	const columns = LEGACY_FLAT_VARIANTS[name];
	if (columns === undefined) {
		throw new DedaloError('search.invalid_sqo', {
			message: `search conform: format 'function' with unknown use_function '${String(leaf.use_function)}' (allowlist-only, never interpolated)`,
			publicMessage: "A 'function' filter names an unknown use_function",
			coordinates: { use_function: String(leaf.use_function) },
		});
	}
	let flatKey = typeof leaf.q === 'string' ? leaf.q : '';
	try {
		const parsed = JSON.parse(flatKey);
		if (typeof parsed === 'string') flatKey = parsed; // unquote '"a_b_1"'
	} catch {
		// not JSON-quoted — use as-is
	}
	if (flatKey === '' || !/^[A-Za-z0-9_-]+$/.test(flatKey)) {
		return null;
	}
	const keyParts = flatKey.split('_'); // tipos never contain underscores
	if (keyParts.length !== columns.length) {
		return null; // wrong arity for the named variant
	}
	return columns.map(([column, cast], index) => [column, cast, keyParts[index] as string]);
}

/** Where a leaf sits: its alias/table and, on a deep path, the hop chain. */
interface LeafPlacement {
	leafAlias: string;
	leafTable: string;
	/** The leaf component tipo (the mixed rule's "field"). */
	field: string;
	/** null on a shallow leaf. */
	plan: DeepChainPlan | null;
	/** The SEC-1 frontier scope (undefined = internal search, no key). */
	scope?: SqlFrontierScope;
	/** The sections the relation leaf's from_component_tipo key is asked of (relationKeySections). */
	keyedSections?: readonly string[];
}

/** The locators of a relation/function leaf; null = malformed legacy key (contributes nothing). */
function relationLeafLocators(
	leaf: SqoFilterLeaf,
	leafFormat: 'relation' | 'function',
): RelationLeafLocator[] | null {
	if (leafFormat === 'relation') return parseRelationLeafQ(leaf.q);
	const legacy = parseLegacyFunctionLeaf(leaf as { use_function?: unknown; q?: unknown });
	return legacy === null ? null : [legacy];
}

/**
 * RELATION LEAVES — filter records whose `relation` column holds a locator
 * matching the given fields (see the format notes at the call site). Both wire
 * shapes resolve to the SAME exact tuple-IN over matrix_relation_index. On a
 * deep path it is one POSITIVE clause over the last hop's records.
 */
async function conformRelationLeaf(
	leaf: SqoFilterLeaf,
	leafFormat: 'relation' | 'function',
	at: LeafPlacement,
): Promise<ConformedFilter> {
	const locators = relationLeafLocators(leaf, leafFormat);
	if (locators === null) return { kind: 'leaf', fragment: false };
	await requireRelationIndex([at.leafTable]);
	const tokenValues: Record<string, unknown> = {};
	const conditions = await relationLeafConditions(
		locators,
		tokenValues,
		at.scope,
		at.keyedSections,
		at.leafTable,
	);
	const result = fragmentResult(
		`(${at.leafAlias}.section_tipo, ${at.leafAlias}.section_id) IN ` +
			`(SELECT r.section_tipo, r.section_id FROM matrix_relation_index r WHERE ${conditions.join(' OR ')})`,
		tokenValues,
	);
	if (at.plan === null) return { kind: 'leaf', fragment: result };
	return deepNode(at.plan, at.field, true, [{ neg: false, result, reverse: result }]);
}

/**
 * THE ROOT STEP'S VERDICT (closure Step 3, SEC-1; WC-2026-09-30-search-root-step-acl).
 *
 * `buildJoinChain` keys every HOP (index >= 1), never `path[0]` — the MAIN
 * section's own component. So a non-admin holding 0 on `test3.test162` still
 * filtered, and sorted, her OWN records by test162's hidden values: contains,
 * `==`, begins-with and `$not` are the SEC-02 prefix oracle again, one hop
 * shorter. The root step is now keyed by the SAME component key as a hop
 * (`frontierComponentAllowed` — identity path tipos and globally visible tables
 * exempt), OR the search surface's standing grants (`searchSurfaceGrants`: the
 * section-info metadata components, the thesaurus template), OR the subdatum
 * read floor.
 *
 * BOUND TO THE ROW'S OWN SECTION, NEVER TO A DECLARATION: the verdict is asked
 * of each MAIN section — the SQO's own `section_tipo` list, which the assembler
 * passes as `scope.mainSectionTipos` and which the main WHERE binds every row
 * to. The client-declared `path[0].section_tipo` is NEVER an authorization
 * input: declaring the globally visible projects section (or a granted sibling
 * virtual) over test3 rows used to key the hidden component on the wrong
 * section and hand the predicate back. All granted → the predicate is
 * unchanged; none → the leaf is `1=0` (the refusal law: identical hit and miss,
 * constant under AND / OR / NOT); some → the predicate holds ONLY on rows of a
 * granted section. Because the key is a property of the row, never of the
 * probe, its answer cannot be flipped by negation.
 *
 * The mains are a REQUIRED member of the search scope (frontier_scope.ts): a
 * scope that cannot name the sections its rows are bound to does not compile.
 */
type RootVerdict = { kind: 'all' } | { kind: 'none' } | { kind: 'some'; sections: string[] };

type PathStep = { section_tipo?: string; component_tipo?: string };

const ROOT_ALL: RootVerdict = { kind: 'all' };

/**
 * The row-bound sections the SEC-1 keys are asked of — undefined = no key
 * (internal search: no principal). A principal-bearing scope WITHOUT its mains
 * is an engine invariant breach, refused LOUDLY: the type makes the member
 * required, and this refuses the scope a cast or a JS caller builds without
 * it — conforming it unkeyed would silently re-open the root-step oracle.
 */
function keyedMains(scope: SqlFrontierScope | undefined): readonly string[] | undefined {
	if (scope?.principal === undefined) return undefined;
	const mains = (scope as { mainSectionTipos?: unknown }).mainSectionTipos;
	if (!Array.isArray(mains)) {
		throw new DedaloError('internal.invariant', {
			message: `${scope.door}: a principal-bearing search scope names no main sections — the SEC-1 root key cannot be asked of its rows`,
			coordinates: { door: scope.door, surface: scope.surface },
		});
	}
	return mains as readonly string[];
}

async function rootStepKey(
	scope: SqlFrontierScope,
	mains: readonly string[],
	path: readonly PathStep[],
	table: string,
): Promise<RootVerdict> {
	const root: PathStep = path[0] ?? {};
	const componentTipo = root.component_tipo;
	if (componentTipo === undefined) return ROOT_ALL; // no component read at the root
	const granted = await grantedSections(scope, mains, componentTipo, table);
	return rootVerdict(scope, root.section_tipo, componentTipo, mains, granted);
}

/**
 * THE ONE COMPONENT READING of the SEC-1 keys, per (section, component): the
 * subdatum read floor, the search surface's standing grants, or the frontier's
 * component key (identity tipos + globally visible tables exempt).
 */
async function componentReadable(
	scope: SqlFrontierScope,
	sectionTipo: string,
	componentTipo: string,
	table: string,
): Promise<boolean> {
	if (scope.readFloor?.has(`${sectionTipo}_${componentTipo}`) === true) return true;
	if (searchSurfaceGrants(sectionTipo, componentTipo)) return true;
	return frontierComponentAllowed(scope, { sectionTipo, componentTipo, table });
}

/** The sections among `sections` on which the component is readable. */
async function grantedSections(
	scope: SqlFrontierScope,
	sections: readonly string[],
	componentTipo: string,
	table: string,
): Promise<string[]> {
	const granted: string[] = [];
	for (const sectionTipo of sections) {
		if (await componentReadable(scope, sectionTipo, componentTipo, table))
			granted.push(sectionTipo);
	}
	return granted;
}

/** All / none / some — and LOUD when not all (the operator log line + the ONE notice). */
function rootVerdict(
	scope: SqlFrontierScope,
	declared: string | undefined,
	componentTipo: string,
	mains: readonly string[],
	granted: string[],
): RootVerdict {
	if (mains.length > 0 && granted.length === mains.length) return ROOT_ALL;
	noteFrontierRefusal(scope, {
		surface: scope.surface,
		door: scope.door,
		sectionTipo: declared ?? '',
		componentTipo,
		key: 'component',
	});
	return granted.length === 0 ? { kind: 'none' } : { kind: 'some', sections: granted };
}

/**
 * The ROOT key for an ORDER path (SEC-1): true only when EVERY main section
 * grants the root component (or the read floor covers it). An order entry
 * cannot be applied to "some" rows — the relative order of the granted rows
 * against the refused ones would itself compare hidden values — so anything
 * short of all is a refusal: the assembler drops the entry (the rows and the
 * count are unchanged; the ORDER BY falls back to the section_id default).
 * Loud through `noteFrontierRefusal`, like every refusal of this scope.
 */
export async function rootOrderStepAllowed(
	scope: SqlFrontierScope,
	path: readonly { section_tipo?: string; component_tipo?: string }[],
	table: string,
): Promise<boolean> {
	const mains = keyedMains(scope);
	if (mains === undefined) return true;
	return (await rootStepKey(scope, mains, path, table)).kind === 'all';
}

/** A SQL fragment restricting the ROW to the granted sections (validated tipos, bound). */
function rowSectionIn(alias: string, sections: readonly string[]): BuilderResult {
	const tokens: Record<string, unknown> = {};
	const names = sections.map((sectionTipo, index) => {
		const name = `_Qroot${index + 1}_`;
		tokens[name] = assertValidTipo(sectionTipo, 'filter root section');
		return name;
	});
	return fragmentResult(`${alias}.section_tipo IN (${names.join(', ')})`, tokens);
}

/**
 * Every RELATION-column component a row of the section may carry a locator
 * under (virtual sections through their real section, plus the section-info
 * metadata relations — created/modified by — which live outside every
 * section's subtree), cached per section: what "any component" means for a
 * relation leaf with no `from_component_tipo`.
 */
const relationComponentsCache = createOntologyCache<string, readonly string[]>();

async function relationComponentsOf(sectionTipo: string): Promise<readonly string[]> {
	const cached = relationComponentsCache.get(sectionTipo);
	if (cached !== undefined) return cached;
	const { getSectionRealTipo } = await import('../ontology/resolver.ts');
	const realTipo = await getSectionRealTipo(sectionTipo);
	const roots = realTipo === sectionTipo ? [sectionTipo] : [realTipo, sectionTipo];
	const tipos = new Set<string>();
	for (const root of roots) {
		for (const tipo of await relationComponentTiposUnder(root)) tipos.add(tipo);
	}
	for (const tipo of await metadataRelationTipos()) tipos.add(tipo);
	const list = Object.freeze([...tipos]);
	relationComponentsCache.set(sectionTipo, list);
	return list;
}

/** The relation-column component tipos of one section subtree (its own nodes). */
async function relationComponentTiposUnder(root: string): Promise<string[]> {
	const { getOrderedSubtree } = await import('../ontology/resolver.ts');
	return (await getOrderedSubtree(root))
		.filter((node) => isRelationComponentModel(node.model))
		.map((node) => node.tipo);
}

/** The metadata components stored in the relation column (created / modified by). */
async function metadataRelationTipos(): Promise<string[]> {
	const relationTipos: string[] = [];
	for (const tipo of metadataComponentTipos()) {
		if (isRelationComponentModel(await getModelByTipo(tipo))) relationTipos.push(tipo);
	}
	return relationTipos;
}

function isRelationComponentModel(model: unknown): boolean {
	return (
		typeof model === 'string' &&
		model.startsWith('component_') &&
		getColumnNameByModel(model) === 'relation'
	);
}

/** The per-locator emission state of one relation leaf (bound tokens + a counter). */
export interface RelationLeafSink {
	readonly tokenValues: Record<string, unknown>;
	readonly nextToken: () => string;
}

/**
 * THE RELATION LEAF'S from_component_tipo, keyed (SEC-1). A relation leaf reads
 * `matrix_relation_index`, whose `from_component_tipo` column IS a component of
 * the OWNING ROW — so the key is asked of the section that row is bound to,
 * never of the client's `path[…].section_tipo` declaration:
 *
 *  - SINGLE-STEP path: the leaf alias IS the main row, bound to the SQO's own
 *    sections (`keyedSections` = the mains). Several mains that disagree are
 *    told apart ON THE ROW: `(r.section_tipo = <S> AND <S's condition>)` per
 *    section, OR-ed.
 *  - MULTI-HOP path: the leaf alias is the last join's row, and the key is asked
 *    of the last step's section — the SAME declaration the hop's own component
 *    key and record predicate read (buildJoinChain). That the hop join binds
 *    the step's TABLE and not its section is the hop class's property (PHP
 *    build_sql_join parity: the target_section_tipo binding is commented out
 *    there), ledgered in the WC entry as the open half — a relation leaf alone
 *    cannot close it while a string leaf on the same alias stays open.
 *
 * Per section: an EXPLICIT hidden from_component_tipo refuses; an ABSENT one
 * keeps its meaning ("any component") minus the hidden ones —
 * `r.from_component_tipo IN (granted)` when, and only when, some relation
 * component is hidden. Returns the extra SQL condition per locator
 * ('' = unrestricted, null = refused).
 */
async function relationLeafComponentKey(
	scope: SqlFrontierScope,
	keyedSections: readonly string[],
	table: string,
	locator: RelationLeafLocator,
	sink: RelationLeafSink,
): Promise<string | null> {
	const perSection: [string, string | null][] = [];
	for (const sectionTipo of keyedSections) {
		perSection.push([
			sectionTipo,
			await sectionFromComponentCondition(scope, sectionTipo, table, locator, sink),
		]);
	}
	return combineSectionConditions(perSection, sink);
}

/**
 * One section's condition on the locator's from_component_tipo ('' / null / an IN list).
 *
 * `allowlistAlways` (the referenced_by owner side, builder_referenced_by.ts):
 * keep the IN list even when nothing is hidden. Those callers expand EVERY key
 * of the stored `relation` column, so "nothing hidden → unrestricted" would let
 * a key outside the section's ontology (a removed/moved component, an import's
 * key) through — and only while no unrelated component happens to be hidden.
 * read_raw's harvest asks each key its own grant, so such a key is never read
 * by a non-admin; the allowlist gives the same answer. The global-admin and
 * globally-visible exemptions are the caller's / unchanged.
 */
export async function sectionFromComponentCondition(
	scope: SqlFrontierScope,
	sectionTipo: string,
	table: string,
	locator: RelationLeafLocator,
	sink: RelationLeafSink,
	allowlistAlways = false,
): Promise<string | null> {
	const explicit = locator.find(([column]) => column === 'from_component_tipo');
	if (explicit !== undefined) return explicitFromKey(scope, sectionTipo, table, explicit[2]);
	if (frontierSectionIsGloballyVisible(sectionTipo, table)) return '';
	const all = await relationComponentsOf(sectionTipo);
	const granted = await grantedComponents(scope, sectionTipo, all, table);
	if (granted.length === all.length) {
		// Nothing hidden: "any" is unchanged — or, keyed, exactly the declared ones.
		if (!allowlistAlways) return '';
		return grantedComponentCondition(granted, sink);
	}
	noteFrontierRefusal(scope, {
		surface: scope.surface,
		door: scope.door,
		sectionTipo,
		key: 'component',
	});
	return grantedComponentCondition(granted, sink);
}

/** The granted components as an IN list — or null (matches nothing) when none is granted. */
function grantedComponentCondition(
	granted: readonly string[],
	sink: RelationLeafSink,
): string | null {
	return granted.length === 0 ? null : componentInList(granted, sink);
}

/**
 * The per-section conditions → ONE locator condition. A single keyed section
 * needs no row binding (the row is already bound to it); several are told apart
 * on `r.section_tipo` — the owning row's own section — unless all agree on
 * "unrestricted".
 */
export function combineSectionConditions(
	perSection: readonly [string, string | null][],
	sink: RelationLeafSink,
): string | null {
	const served = perSection.filter(([, condition]) => condition !== null) as [string, string][];
	if (served.length === 0) return null;
	if (perSection.length === 1) return (served[0] as [string, string])[1];
	if (served.length === perSection.length && served.every(([, condition]) => condition === '')) {
		return '';
	}
	const branches = served.map(([sectionTipo, condition]) => {
		const name = sink.nextToken();
		sink.tokenValues[name] = sectionTipo;
		const bound = `r.section_tipo = ${name}::text`;
		return condition === '' ? `(${bound})` : `(${bound} AND ${condition})`;
	});
	return `(${branches.join(' OR ')})`;
}

/** An EXPLICIT from_component_tipo: '' when readable, null (loudly) when hidden. */
async function explicitFromKey(
	scope: SqlFrontierScope,
	sectionTipo: string,
	table: string,
	componentTipo: string,
): Promise<string | null> {
	if (await componentReadable(scope, sectionTipo, componentTipo, table)) return '';
	noteFrontierRefusal(scope, {
		surface: scope.surface,
		door: scope.door,
		sectionTipo,
		componentTipo,
		key: 'component',
	});
	return null;
}

/** The components among `components` readable on the section. */
async function grantedComponents(
	scope: SqlFrontierScope,
	sectionTipo: string,
	components: readonly string[],
	table: string,
): Promise<string[]> {
	const granted: string[] = [];
	for (const componentTipo of components) {
		if (await componentReadable(scope, sectionTipo, componentTipo, table)) {
			granted.push(componentTipo);
		}
	}
	return granted;
}

/** `r.from_component_tipo IN (…)` over bound tokens. */
function componentInList(components: readonly string[], sink: RelationLeafSink): string {
	const names = components.map((componentTipo) => {
		const name = sink.nextToken();
		sink.tokenValues[name] = componentTipo;
		return `${name}::text`;
	});
	return `r.from_component_tipo IN (${names.join(', ')})`;
}

/**
 * The sections a relation leaf's from_component_tipo key is asked of (see
 * {@link relationLeafComponentKey}): the mains for a single-step path, the last
 * step's section for a multi-hop one; undefined = no key (internal search).
 */
function relationKeySections(
	scope: SqlFrontierScope | undefined,
	path: readonly PathStep[],
): readonly string[] | undefined {
	const mains = keyedMains(scope);
	if (mains === undefined) return undefined;
	if (path.length === 1) return mains;
	return [path[path.length - 1]?.section_tipo ?? ''];
}

/**
 * The relation leaf's per-locator conditions over `matrix_relation_index`, each
 * a bound tuple of the locator's fields — plus, when the key applies, the SEC-1
 * component key of its `from_component_tipo` (a refused locator is `(1=0)`: it
 * contributes nothing to the OR).
 */
async function relationLeafConditions(
	locators: readonly RelationLeafLocator[],
	tokenValues: Record<string, unknown>,
	scope: SqlFrontierScope | undefined,
	keyedSections: readonly string[] | undefined,
	table: string,
): Promise<string[]> {
	let tokenIndex = 0;
	const sink: RelationLeafSink = {
		tokenValues,
		nextToken: () => {
			tokenIndex += 1;
			return `_Qf${tokenIndex}_`;
		},
	};
	const conditions: string[] = [];
	for (const locator of locators) {
		const componentKey =
			scope === undefined || keyedSections === undefined
				? ''
				: await relationLeafComponentKey(scope, keyedSections, table, locator, sink);
		conditions.push(locatorCondition(locator, componentKey, sink));
	}
	return conditions;
}

/** One locator's bound tuple (+ its component key), or `(1=0)` when refused. */
function locatorCondition(
	locator: RelationLeafLocator,
	componentKey: string | null,
	sink: RelationLeafSink,
): string {
	if (componentKey === null) return '(1=0)';
	const parts: string[] = [];
	for (const [column, cast, value] of locator) {
		const name = sink.nextToken();
		parts.push(`r.${column} = ${name}::${cast}`);
		sink.tokenValues[name] = value;
	}
	if (componentKey !== '') parts.push(componentKey);
	return `(${parts.join(' AND ')})`;
}

/**
 * Conform one leaf: gates → the ROOT key → ontology → builder. The root key
 * (SEC-1, {@link rootStepKey}) runs right after the §7.6 identifier gate,
 * whenever a principal is in scope, and before any ontology read of the leaf.
 */
async function conformLeaf(
	leaf: SqoFilterLeaf,
	alias: string,
	table: string,
	scope?: SqlFrontierScope,
): Promise<ConformedFilter> {
	const path = leaf.path ?? [];
	if (path.length === 0) return { kind: 'leaf', fragment: false };
	assertPathIdentifiers(path); // §7.6 first — every identifier the key and the builder see
	const keyed = keyedScope(scope);
	if (keyed === null) return conformLeafBody(leaf, alias, table, scope);
	return conformKeyedLeaf(leaf, path, alias, table, keyed);
}

/** The scope with its row-bound mains, or null when no SEC-1 key applies. */
function keyedScope(
	scope: SqlFrontierScope | undefined,
): { scope: SqlFrontierScope; mains: readonly string[] } | null {
	const mains = keyedMains(scope);
	return scope === undefined || mains === undefined ? null : { scope, mains };
}

/** A leaf under the ROOT key: refused (`1=0`), row-keyed (some), or unchanged (all). */
async function conformKeyedLeaf(
	leaf: SqoFilterLeaf,
	path: readonly PathStep[],
	alias: string,
	table: string,
	{ scope, mains }: { scope: SqlFrontierScope; mains: readonly string[] },
): Promise<ConformedFilter> {
	const verdict = await rootStepKey(scope, mains, path, table);
	if (verdict.kind === 'none') return refusedRootLeaf();
	const conformed = await conformLeafBody(leaf, alias, table, scope);
	return verdict.kind === 'some' ? rowKeyedLeaf(conformed, alias, verdict.sections) : conformed;
}

/** The §7.6 chokepoint over one leaf path: every identifier that will be interpolated. */
function assertPathIdentifiers(path: readonly PathStep[]): void {
	for (const step of path) {
		if (step.section_tipo !== undefined) assertValidTipo(step.section_tipo, 'filter path');
		if (step.component_tipo !== undefined) {
			assertValidTipoOrColumn(step.component_tipo, 'filter path');
		}
	}
}

/**
 * A leaf whose ROOT component no main section grants: `1=0` — whatever the path
 * length. A filter leaf never joins its chain into the main FROM (deep paths are
 * semi-joins, deep_path.ts), so a refused leaf carries no chain at all: nothing
 * that could tell one hidden value from another.
 */
function refusedRootLeaf(): ConformedFilter {
	return { kind: 'leaf', fragment: fragmentResult('1=0') };
}

/**
 * SOME mains granted: the predicate holds only on rows of a granted section.
 * A shallow leaf ANDs the row-section key into its fragment; a DEEP leaf
 * carries it as `rowKey`, which deep_path.ts ANDs outside the unit's
 * semi-join(s) — once per shared-record unit (every leaf of one chain shares
 * the root component, hence the same key), so the mixed rule still sees the
 * siblings it would have merged.
 */
function rowKeyedLeaf(
	conformed: ConformedFilter,
	alias: string,
	sections: readonly string[],
): ConformedFilter {
	if (conformed.kind === 'deep') return { ...conformed, rowKey: rowSectionIn(alias, sections) };
	if (conformed.kind !== 'leaf' || conformed.fragment === false) return conformed;
	return {
		kind: 'leaf',
		fragment: compound('$and', [rowSectionIn(alias, sections), conformed.fragment]),
	};
}

/**
 * date_mode (PHP get_date_search_context: `$properties->date_mode ?? 'date'`)
 * selects the per-mode date SQL handler. Read ONLY for date leaves — every other
 * family ignores it, and the effective-properties read is one more (cached)
 * ontology hop per leaf. undefined = the default mode.
 */
async function leafDateMode(model: string, componentTipo: string): Promise<string | undefined> {
	if (model !== 'component_date') return undefined;
	const { getEffectivePropertiesByTipo } = await import('../ontology/alias.ts');
	const properties = (await getEffectivePropertiesByTipo(componentTipo)) as {
		date_mode?: unknown;
	} | null;
	return typeof properties?.date_mode === 'string' && properties.date_mode !== ''
		? properties.date_mode
		: undefined;
}

/** The leaf body: (hop chain) → relation / function leaves → model builders / deep clauses. */
async function conformLeafBody(
	leaf: SqoFilterLeaf,
	alias: string,
	table: string,
	scope?: SqlFrontierScope,
): Promise<ConformedFilter> {
	const path = leaf.path ?? [];
	const lastStep = path[path.length - 1];
	if (lastStep === undefined) {
		return { kind: 'leaf', fragment: false };
	}

	if (leaf.lang !== undefined) assertValidLang(leaf.lang, 'filter leaf');

	// MULTI-HOP path: each intermediate step is a relation component pointing
	// at the next step's section. buildJoinChain resolves the hops (aliases,
	// tables, the SEC-02 hop ACL) — ONE home shared with the ORDER twin, so the
	// hop ACL cannot land on one of them only. The filter leaf never joins the
	// chain into the main FROM: deep_path.ts renders it as a semi-join over the
	// related records (WC-2026-09-29-search-deep-leaf-mixed-rule).
	let leafAlias = alias;
	let leafTable = table;
	let plan: DeepChainPlan | null = null;
	if (path.length > 1) {
		const chain = await buildJoinChain(
			path as { section_tipo?: string; component_tipo?: string }[],
			alias,
			scope,
		);
		if (!chain.authorized) {
			// SEC-02. A step names a component this principal holds 0 on. The leaf
			// answers FALSE for EVERY row — never a throw, and never a silent drop:
			//
			//  - FALSE makes HIT and MISS identical, which is precisely what closes
			//    the prefix oracle. The caller learns nothing about the hidden
			//    value, not even that a probe was refused (a refusal is itself a
			//    signal, and an error would also break the ONE unauthorized leaf of
			//    an autocomplete's `$or` filter_free for every user);
			//  - DROPPING the leaf ({fragment:false}) would be sound under `$or`
			//    and FAIL-OPEN under `$and`/`$not`, where removing a conjunct
			//    WIDENS the result set. `1=0` is safe under every operator: it
			//    contributes nothing to an OR, empties an AND, and negates to the
			//    same answer for every record.
			//
			// LOUD, THOUGH: buildJoinChain has already written the named
			// `[frontier] REFUSED …` operator log line and recorded the request's
			// `perm.out_of_scope` notice. The CALLER's answer is identical for hit
			// and miss — the oracle stays closed — while the OPERATOR can see that
			// the result set was narrowed and why. A narrowing nobody can observe
			// is what AGENTS.md forbids; a narrowing the attacker cannot observe is
			// what the refusal law requires. Both hold here.
			return { kind: 'leaf', fragment: fragmentResult('1=0') };
		}
		plan = { mainAlias: alias, hops: chain.hops };
		leafAlias = chain.lastAlias;
		leafTable = chain.lastTable;
	}

	const componentTipo = lastStep.component_tipo;
	if (componentTipo === undefined) {
		return { kind: 'leaf', fragment: false };
	}

	// RELATION LEAVES — filter records whose `relation` column holds a locator
	// matching the given fields (the autocomplete filter_by_list pre-filter,
	// the picker's per-catalogue checkboxes). Both wire shapes resolve to the
	// SAME exact tuple-IN over matrix_relation_index — uncorrelated (hashed
	// semi-join, no join-order inversion) and carrying the owner's
	// section_tipo, so it is equivalence, not a superset. The index is the
	// ONLY engine — an uncovered table fails loudly (requireRelationIndex).
	//
	// format:'relation' (CANONICAL, 2026-07-21): q is one partial-locator
	//   object or an array of them (array = OR within the leaf, the
	//   filter_by_locators semantics). Fields = the locator vocabulary:
	//   section_tipo (required), section_id, from_component_tipo, type.
	//   Strictly validated — unknown fields, invalid tipos or a non-integer
	//   section_id throw (a new contract owes loud errors, not bug-compat).
	//
	// format:'function' (DEPRECATED reader, WC-012): the v6-era variant names
	//   (relations_flat_* / data_relations_flat_*) plus a flattened
	//   '<a>_<b>_<c>' key. The stored functions were REMOVED 2026-07-20 — the
	//   allowlisted name only selects the field layout the key parses into
	//   (tipos never contain underscores; the flat key travels as bound
	//   parameters). Kept so beta-era saved searches keep working; nothing in
	//   this tree emits it anymore.
	const leafFormat = (leaf as { format?: unknown }).format;
	if (leafFormat === 'relation' || leafFormat === 'function') {
		return conformRelationLeaf(leaf, leafFormat, {
			leafAlias,
			leafTable,
			field: componentTipo,
			plan,
			scope,
			keyedSections: relationKeySections(scope, path),
		});
	}

	// Ontology resolution. PHP ontology_utils::check_active_tld:271 allowlists
	// the PSEUDO tipo 'section_id' for SQO paths (the record id addressed as a
	// component — the rsc80 state-vocabulary fixed_filter is the live user);
	// there is no ontology node behind it, so resolve its model directly.
	const model =
		componentTipo === 'section_id' ? 'component_section_id' : await getModelByTipo(componentTipo);
	if (model === null) {
		throw new DedaloError('request.invalid_tipo', {
			message: `search conform: unknown component tipo '${componentTipo}'`,
			coordinates: { tipo: componentTipo },
		});
	}
	const column = getColumnNameByModel(model);
	if (column === null) {
		throw new DedaloError('request.invalid_model', {
			message: `search conform: no matrix column for model '${model}'`,
			coordinates: { tipo: componentTipo, model },
		});
	}
	const translatable = await getTranslatableByTipo(componentTipo);
	// No clause lang ⇒ search ALL langs — PHP component_common::get_search_query
	// (class.component_common.php:3683-86) sets lang='all' unconditionally when
	// the clause carries none. The autocomplete picker relies on it: its free
	// clauses are lang-less and must match any translation (probed 2026-07-09:
	// 'roma' matches a mint whose only 'roma' value is lg-eng). Plain
	// non-translatable data is all lg-nolan, where the nolan scope is
	// observably identical — but NOT a TRANSLITERABLE component's
	// (with_lang_versions / component_iri: an lg-nolan base beside per-language
	// versions), whose lg-ell version must match too, as PHP's 'all' did.
	const lang =
		leaf.lang ??
		(translatable || (await savesInRequestLang(componentTipo, model)) ? 'all' : 'lg-nolan');

	const dateMode = await leafDateMode(model, componentTipo); // date leaves only
	const context: BuilderContext = {
		alias: leafAlias,
		column,
		// component_alias (WC-020): the SQL fragment keys the TARGET's data slot —
		// re-gated as an identifier of its own (SURF-1; `section_id` stays admitted).
		tipo: await resolveSqlDataTipo(componentTipo, 'filter'),
		sectionTipo: lastStep.section_tipo ?? '',
		table: leafTable,
		lang,
		translatable,
		model,
		...(dateMode === undefined ? {} : { dateMode }),
		// string leaves: let builder_string prepend its search-store pre-filter
		// when the table's sync trigger exists (cached catalog check). ONLY on a
		// SHALLOW leaf: inside a correlated deep semi-join the hop already bounds
		// the per-row work, and the prefilter's tiny-cardinality estimate makes
		// the planner flip the join order (measured on the old forward join:
		// multi-hop count 150ms → 660ms). The REVERSED shape (deep_path.ts), where
		// the leaf is the driving set, gets its own prefiltered twin below.
		searchStoreCovered:
			column === 'string' && plan === null ? await searchStoreCovers(leafTable) : false,
	};

	// Builder dispatch by descriptor facet (S2-26): relation-column models go
	// through the relations registry; everything else through its declared
	// searchBuilder family; no facet = unsearchable, throw loudly (§9).
	const builderFamily = getSearchBuilderFamily(model);
	const isRelation = column === 'relation';
	if (!isRelation && builderFamily === undefined) {
		throw new DedaloError('engine.uncovered_scope', {
			message: `search conform: model '${model}' declares no searchBuilder family and is not a relation model — unsearchable through conform (ledgered, never silently narrowed)`,
			coordinates: { model },
		});
	}
	// ANCESTOR INDEX (PHP resolve_query_object_sql step 4 + add_relation_search):
	// the LEGACY component_autocomplete_hi model ALSO searches the
	// `relation_search` column, so a broader term matches the records filed
	// under its narrower ones ("search Spain, match Madrid" — the index
	// save_component.ts maintains on every save of one of these components).
	// Ledger: WC-2026-08-09-autocomplete-hi-ancestor-search.
	//
	// The decision belongs HERE and not in the relations registry: the
	// registry dispatches on the RUNTIME model, and component_autocomplete_hi
	// has already been replaced by component_portal by the time it gets
	// there. This is the last place holding the tipo — PHP resolves the same
	// question the same way, via ontology_node::get_legacy_model_by_tipo.
	//
	// The test must match the WRITER exactly (relations/save.ts
	// relationSearchLaw reads the node's OWN stored model for the save law the
	// write chokepoint applies, section_record/record_write.ts):
	// wrapping a leaf whose index is never maintained would widen nothing and
	// would cost a second GIN probe per row. TM tables carry no such index
	// (their relation datum is the scalar user_id column) and are excluded.
	const usesAncestorIndex =
		isRelation &&
		!TIME_MACHINE_TABLES.has(leafTable) &&
		(await getNode(componentTipo))?.model === 'component_autocomplete_hi';
	const run: LeafRunner = async (q, qOperator, qSplit, opts, how = {}) => {
		const ancestor = how.ancestor ?? usesAncestorIndex;
		const builderContext =
			how.prefilter === true ? { ...context, searchStoreCovered: true } : context;
		if (isRelation) {
			if (ancestor) {
				const { buildRelationSearchAncestorFragment } = await import(
					'./builders/builder_relation.ts'
				);
				return buildRelationSearchAncestorFragment(q, qOperator, builderContext);
			}
			const { getRelationSearchFragmentBuilder } = await import('../relations/registry.ts');
			const buildFragment = await getRelationSearchFragmentBuilder(model);
			return buildFragment(q, qOperator, builderContext);
		}
		const family = builderFamily as NonNullable<typeof builderFamily>;
		return FAMILY_BUILDERS[family](q, qOperator, qSplit, builderContext, opts);
	};

	if (plan === null) {
		return {
			kind: 'leaf',
			fragment: await run(leaf.q, leaf.q_operator ?? null, leaf.q_split === true),
		};
	}
	// The reversed shape makes the leaf the DRIVING set, so the search-store
	// prefilter the correlated shape must not carry is exactly what it wants.
	const prefilter =
		builderFamily === 'string' && column === 'string' && (await searchStoreCovers(leafTable));
	const classify = await classifierFor(model, isRelation, builderFamily);
	// '!!' (duplicated) over a deep path: the aggregate reads the LAST step
	// table restricted by that hop's record ACL, so a record the caller may not
	// see never makes a visible one a "duplicate" (R = the visible records).
	const aggAcl =
		scope !== undefined && (builderFamily === 'string' || builderFamily === 'json')
			? await scope.recordPredicate({
					sectionTipo: lastStep.section_tipo ?? '',
					table: leafTable,
					alias: DUPLICATE_AGGREGATE_ALIAS,
				})
			: '';
	const posOpts: BuilderOpts | undefined =
		aggAcl === '' ? undefined : { aggTable: leafTable, aggAcl: () => aggAcl };
	return deepLeaf(leaf, plan, componentTipo, builderFamily, classify, run, prefilter, posOpts);
}

/** The duplicate aggregate's own alias (types.ts aggAclClause). */
const DUPLICATE_AGGREGATE_ALIAS = 'm2';

/** A leaf's builder runner (conformLeaf's `run`). */
type LeafRunner = (
	q: unknown,
	qOperator: string | null,
	qSplit: boolean,
	opts?: BuilderOpts,
	how?: { ancestor?: boolean; prefilter?: boolean },
) => Promise<BuilderResult>;

/** A leaf's classifier: the builder file's own classify<Family>() (one parse home). */
type LeafClassifier = (q: unknown, qOperator: string | null) => LeafPolarity;

async function classifierFor(
	model: string,
	isRelation: boolean,
	family: ReturnType<typeof getSearchBuilderFamily>,
): Promise<LeafClassifier> {
	if (isRelation) {
		if (model === 'component_relation_children') {
			const { classifyRelationChildren } = await import('./builders/builder_relation_children.ts');
			return classifyRelationChildren;
		}
		if (model === 'component_relation_index') {
			const { classifyRelationIndex } = await import('./builders/builder_relation_index.ts');
			return classifyRelationIndex;
		}
		const { classifyRelation } = await import('./builders/builder_relation.ts');
		return classifyRelation;
	}
	return FAMILY_CLASSIFIERS[family as NonNullable<typeof family>];
}

/**
 * DEEP leaf → its clauses (types.ts LeafPolarity), over R = the related
 * records the chain reaches:
 *
 *   pos  EXISTS r in R: P(r)
 *   neg  NOT EXISTS r in R: twin(r)
 *   neq  EXISTS r in R: has(r)  AND  NOT EXISTS r in R: twin(r)
 *
 * q_split (string family only, as on a shallow leaf): each token is classified
 * on its own; POSITIVE tokens stay in ONE clause (one related record must match
 * them all), each NEGATIVE token is its own NOT EXISTS ('-a b' = no related
 * record contains a AND none contains b), and neq tokens share ONE has-half.
 */
async function deepLeaf(
	leaf: SqoFilterLeaf,
	plan: DeepChainPlan,
	field: string,
	builderFamily: ReturnType<typeof getSearchBuilderFamily>,
	classify: LeafClassifier,
	run: LeafRunner,
	prefilter: boolean,
	posOpts: BuilderOpts | undefined,
): Promise<ConformedFilter> {
	const acc: DeepAccumulator = {
		positives: [],
		positivesReverse: [],
		clauses: [],
		hasEmitted: false,
	};
	let allPositive = true;
	for (const unit of deepUnits(leaf, builderFamily)) {
		const polarity = classify(unit.q, unit.qOperator);
		if (polarity.kind === 'pos') {
			acc.positives.push(await run(unit.q, unit.qOperator, false, posOpts));
			acc.positivesReverse.push(
				prefilter ? await run(unit.q, unit.qOperator, false, posOpts, { prefilter }) : false,
			);
			continue;
		}
		allPositive = false;
		await pushNegatedClauses(polarity, run, acc);
	}
	const positive = allOf(acc.positives);
	if (positive !== false) {
		const reverse = prefilter ? allOf(acc.positivesReverse) : positive;
		acc.clauses.unshift({ neg: false, result: positive, reverse });
	}
	return deepNode(plan, field, allPositive, acc.clauses);
}

/** What deepLeaf gathers across a leaf's units. */
interface DeepAccumulator {
	positives: BuilderResult[];
	positivesReverse: BuilderResult[];
	clauses: DeepClause[];
	/** A neq unit already contributed the (shared) has-half. */
	hasEmitted: boolean;
}

/** q_split tokens (string family) as classification units; otherwise the leaf's own q. */
function deepUnits(
	leaf: SqoFilterLeaf,
	builderFamily: ReturnType<typeof getSearchBuilderFamily>,
): { q: unknown; qOperator: string | null }[] {
	const qOperator = leaf.q_operator ?? null;
	const tokens =
		builderFamily === 'string' && leaf.q_split === true
			? splitSearchTerms(extractNormalizedQ(leaf.q) ?? '')
			: [];
	return tokens.length > 1 ? tokens.map((q) => ({ q, qOperator })) : [{ q: leaf.q, qOperator }];
}

/** A neg / neq unit: its NOT EXISTS twin, plus the has-half once per leaf for neq. */
async function pushNegatedClauses(
	polarity: Exclude<LeafPolarity, { kind: 'pos' }>,
	run: LeafRunner,
	acc: DeepAccumulator,
): Promise<void> {
	if (polarity.kind === 'neq' && !acc.hasEmitted) {
		acc.hasEmitted = true;
		// The has-half reads the DIRECT column (the shallow '!=' guard), never
		// the ancestor index.
		const has = polarity.has;
		const result = await run(has.q, has.qOperator, false, has.opts, { ancestor: false });
		acc.clauses.push({ neg: false, result, reverse: result });
	}
	const twin = polarity.twin;
	const result = await run(twin.q, twin.qOperator, false, twin.opts);
	acc.clauses.push({ neg: true, result, reverse: result });
}

/** One clause from several positive results (all must hold on one related record). */
function allOf(results: BuilderResult[]): BuilderResult {
	const kept = results.filter((result) => result !== false);
	if (kept.length === 0) return false;
	return kept.length === 1 ? (kept[0] as BuilderResult) : compound('$and', kept);
}

/** The deep node, dropping clauses that contribute nothing (all dropped → an inert leaf). */
function deepNode(
	plan: DeepChainPlan,
	field: string,
	positive: boolean,
	clauses: DeepClause[],
): ConformedFilter {
	const kept = clauses.filter((clause) => clause.result !== false);
	if (kept.length === 0) return { kind: 'leaf', fragment: false };
	return { kind: 'deep', plan, field, positive, clauses: kept };
}

/** One boolean-operator node: its items conformed in order, empty items skipped. */
async function conformGroup(
	opKey: string,
	rawItems: unknown,
	alias: string,
	table: string,
	scope: SqlFrontierScope | undefined,
	depth: number,
): Promise<ConformedFilter> {
	const items: ConformedFilter[] = [];
	for (const item of Array.isArray(rawItems) ? rawItems : []) {
		if (item === false || item === null || item === undefined) continue;
		items.push(await conformFilter(item as Record<string, unknown>, alias, table, scope, depth));
	}
	return { kind: 'group', op: opKey, items };
}

/**
 * Recursively conform a filter node ($and/$or trees with leaves).
 *
 * `depth` = how many `referenced_by` leaves enclose this filter (0 for a main
 * search; the scoped row set of a leaf conforms its source filter at depth+1),
 * so a nested leaf is bounded by MAX_REFERENCED_BY_DEPTH.
 */
export async function conformFilter(
	filter: SqoFilterNode | SqoFilterLeaf | Record<string, unknown>,
	alias: string,
	table: string,
	scope?: SqlFrontierScope,
	depth = 0,
): Promise<ConformedFilter> {
	// A node has exactly one boolean-operator key.
	const keys = Object.keys(filter);
	const opKey = keys.find((key) => BOOLEAN_OPERATORS.has(key));
	if (opKey !== undefined) {
		const rawItems = (filter as Record<string, unknown>)[opKey];
		return conformGroup(opKey, rawItems, alias, table, scope, depth);
	}
	// A `referenced_by` leaf carries NO path: it must be routed BEFORE the path
	// check, whose pathless-leaf drop ({fragment:false}) would WIDEN the search
	// to the whole section (WC-2026-10-30-search-referenced-by-leaf). Lazy
	// (CONVENTIONS §2 rationale 1, cycle-breaking): the builder compiles its
	// source through sql_assembler.ts, which imports this module statically.
	if (isReferencedByLeaf(filter)) {
		const { conformReferencedBy } = await import('./builders/builder_referenced_by.ts');
		return conformReferencedBy(filter, alias, scope, depth);
	}
	// Leaf (has a path).
	return conformLeaf(filter as SqoFilterLeaf, alias, table, scope);
}
