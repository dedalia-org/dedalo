/**
 * RELATION_RELATED ENGINE (RELATIONS_SPEC.md §6.6) — associative links with
 * directionality and the INDIRECT resolution rule: if a=b and b=c then c=a.
 *
 * Directionality (ontology properties.config_relation.relation_type_rel):
 *   dd620 UNIDIRECTIONAL  — stored links only, no inverse lookup;
 *   dd467 BIDIRECTIONAL   — one inverse hop ("who points at me");
 *   dd621 MULTIDIRECTIONAL — full graph traversal: inverse references AND the
 *         stored links of every visited node expand recursively, deduped by a
 *         visited cache that prevents cycles.
 *
 * PHP references: class.component_relation_related.php —
 * get_references_recursive :274 (the traversal; the ROOT call never re-adds
 * the root's own stored data), get_references :387 (same-section inverse
 * containment on {section_tipo, section_id, from_component_tipo}, string
 * section_ids), get_calculated_references :152 (the {value, label} wrap with
 * the show-ddo label build), get_type_rel :231.
 */

import { canonicalizeStoredSectionId } from '../concepts/section_id.ts';
import { DATAFRAME_RELATION_TYPE } from '../concepts/subdatum.ts';
import { memoizedReadMatrixRecord } from '../db/record_memo.ts';
import { DedaloError } from '../errors/dedalo_error.ts';
import { getMatrixTableFromTipo, getNode } from '../ontology/resolver.ts';
import { findInverseReferences } from '../search/search_related.ts';

export const RELATED_UNIDIRECTIONAL = 'dd620';
export const RELATED_BIDIRECTIONAL = 'dd467';
export const RELATED_MULTIDIRECTIONAL = 'dd621';

/** One computed back-reference (PHP get_references output — string section_id). */
export interface RelatedReference {
	section_tipo: string;
	/**
	 * The canonical INT address (WC-2026-08-10-section-id-int-canonical). The
	 * union keeps the READ side honest: entries walked out of not-yet-swept
	 * stored bags still arrive as strings, and this graph must not corrupt one
	 * it cannot convert (an external remote id keeps its own bytes).
	 */
	section_id: number | string;
	from_component_tipo: string;
}

/** The component's directionality (PHP __construct + get_type_rel :231). */
export function getRelationTypeRel(properties: unknown): string {
	const typeRel = (properties as { config_relation?: { relation_type_rel?: unknown } } | null)
		?.config_relation?.relation_type_rel;
	return typeof typeRel === 'string' && typeRel !== '' ? typeRel : RELATED_UNIDIRECTIONAL;
}

/**
 * Records of the SAME section whose stored relation contains a locator
 * pointing at (sectionTipo, sectionId) from this component (PHP
 * get_references :387). from_component_tipo on the results is always the
 * querying component — the recursion instantiates the same component type.
 */
export async function getReferences(
	tipo: string,
	sectionTipo: string,
	sectionId: number | string,
): Promise<RelatedReference[]> {
	const hits = await findInverseReferences(
		[{ section_tipo: sectionTipo, section_id: Number(sectionId), from_component_tipo: tipo }],
		{ limit: false, order: 'section_id', sectionTipos: [sectionTipo] },
	);
	return hits.map((hit) => ({
		section_tipo: hit.section_tipo,
		// Already an int out of the inverse search — emitted verbatim.
		section_id: hit.section_id,
		from_component_tipo: tipo,
	}));
}

/**
 * A stored relation-column entry as the graph walk sees it (loose by design).
 * KEPT UNION: raw stored jsonb — unswept legacy string ids, plus external
 * remote ids ('001338683') that are the value and are never converted.
 */
export interface StoredRelationLink {
	section_tipo?: string;
	section_id?: number | string;
	from_component_tipo?: string;
	type?: string;
}

/**
 * The stored locators of the component at a graph node (its own data).
 *
 * Deliberately the shared full-row reader, not a narrow `relation->$key`
 * projection: with the expansion memo the walk visits each node ONCE, and the
 * measured equivalence components are ≤10 nodes (~0.4ms/visit, single-digit
 * ms per walk — review 2026-08-02), so a bespoke SQL shape in this file is
 * not worth a second confinement home. Revisit only if closure sizes grow.
 */
async function readStoredLinks(
	tipo: string,
	sectionTipo: string,
	sectionId: number | string,
): Promise<StoredRelationLink[]> {
	const table = await getMatrixTableFromTipo(sectionTipo);
	if (table === null) return [];
	const record = await memoizedReadMatrixRecord(table, sectionTipo, Number(sectionId));
	return (
		((record?.columns.relation as Record<string, unknown[]> | null)?.[
			tipo
		] as StoredRelationLink[]) ?? []
	);
}

/**
 * Graph-access seam for the related traversal. The DEFAULT is the live DB
 * (inverse hops via matrix_relation_index, stored links via the matrix row);
 * tests inject an in-memory graph so the TRAVERSAL LAW itself (typeRel gates,
 * cycle cache, root-stored exclusion) is gated hermetically — the D3
 * observer-seed gates depend on the dd621 recursive half being irremovable
 * without a RED test, which only an injectable graph can assert without DB
 * fixtures (observer_seed_native.test.ts).
 */
export interface RelatedGraphIO {
	getInverse(
		tipo: string,
		sectionTipo: string,
		sectionId: number | string,
	): Promise<RelatedReference[]>;
	readStored(
		tipo: string,
		sectionTipo: string,
		sectionId: number | string,
	): Promise<StoredRelationLink[]>;
}

// Immutable function-pair default (never mutated — module_state rule satisfied).
const DB_GRAPH_IO: RelatedGraphIO = { getInverse: getReferences, readStored: readStoredLinks };

/**
 * CLOSURE BOUNDS (audit PERF-04). The walk is linear in QUERIES, but nothing
 * bounded its SIZE: a degenerate equivalence class — a hub every record points
 * at — expands until it has walked the section, on the request thread, inside
 * the caller's FOR UPDATE lock. The audit measured a 70,000-node closure at
 * 17.8 s (the `visited` list was scanned with `.includes`, O((V+E)^2); it is a
 * Set now, and the same walk is ~55 ms) — but 70,000 nodes of a "related"
 * graph is not a slow answer, it is a broken ontology, and answering it at all
 * is the defect.
 *
 * A breach THROWS (`engine.uncovered_scope`) and names the numbers. It never
 * truncates: a silently narrowed closure is a WRONG answer — the observer
 * equivalence-class seed would mirror a partial class and the Referencias grid
 * would drop real references, with nothing red anywhere. (The observers.ts
 * EQUIVALENCE_CLASS_WIDE counter warns and proceeds at 500 because it is a
 * SIGNAL about a class that still resolved; these are the walls behind it.)
 *
 * TWO numbers, not three, and deliberately: DEPTH is the async recursion frame
 * count and NODES is the class size. A separate cap on the RESULT length would
 * be dead code — every reference pushed is first checked against the visited
 * cache, so the result can never be longer than the node count that already has
 * a wall.
 */
const RELATED_CLOSURE_MAX_DEPTH = 2_000;
const RELATED_CLOSURE_MAX_NODES = 50_000;

/**
 * The published closure gauge — the biggest class this process has walked and
 * how many walks were refused. Registered on GET /api/v1/counters from
 * server.ts (the registerOpsGauge inversion: core/relations must not import
 * core/api). Process-wide by nature: it is a HIGH-WATER MARK, carries no user,
 * language, section or record, and a stale value only ages a number on an ops
 * page.
 */
let closureStats: { readonly maxClosureNodes: number; readonly refusals: number } = {
	maxClosureNodes: 0,
	refusals: 0,
};

/** The closure BOUNDS, published so a gate asserts against the real numbers. */
export const RELATED_CLOSURE_BOUNDS = {
	maxDepth: RELATED_CLOSURE_MAX_DEPTH,
	maxNodes: RELATED_CLOSURE_MAX_NODES,
} as const;

/** The closure gauge (ops/introspection): high-water class size + refusals. */
export function relatedClosureStats(): { max_closure_nodes: number; refusals: number } {
	return { max_closure_nodes: closureStats.maxClosureNodes, refusals: closureStats.refusals };
}

/** Reset the gauge (gates only — a high-water mark is otherwise never lowered). */
export function resetRelatedClosureStats(): void {
	closureStats = { maxClosureNodes: 0, refusals: 0 };
}

/**
 * The two walls, in ONE place: the walk body stays about the traversal, and the
 * bounds stay about the bounds (they are also the only two branches in this
 * function, which is where the complexity ratchet wants them).
 */
function assertClosureWithinBounds(
	tipo: string,
	// The node's ADDRESS as already-formatted text, not the locator: this helper
	// only names the offender in a refusal, and taking the locator would add a
	// `number | string` section_id declaration to a file the section_id int
	// tripwire (WC-2026-08-10-section-id-int-canonical) holds to a ceiling.
	address: string,
	depth: number,
	nodes: number,
): void {
	if (depth > RELATED_CLOSURE_MAX_DEPTH) {
		refuseClosure(
			`relation graph too DEEP at ${address}: depth ${depth} exceeds ${RELATED_CLOSURE_MAX_DEPTH} (component ${tipo})`,
		);
	}
	if (nodes > RELATED_CLOSURE_MAX_NODES) {
		refuseClosure(
			`relation graph too WIDE from ${address}: more than ${RELATED_CLOSURE_MAX_NODES} nodes in one closure (component ${tipo})`,
		);
	}
}

/**
 * Raise the high-water mark — from the ROOT frame only, whose `expanded` set is
 * the whole closure. A helper rather than two inline conditions so the walk body
 * keeps its decisions about the traversal (and its complexity budget with them).
 */
function publishClosureSize(recursion: boolean, nodes: number): void {
	if (recursion || nodes <= closureStats.maxClosureNodes) return;
	closureStats = { maxClosureNodes: nodes, refusals: closureStats.refusals };
}

function refuseClosure(message: string): never {
	closureStats = {
		maxClosureNodes: closureStats.maxClosureNodes,
		refusals: closureStats.refusals + 1,
	};
	throw new DedaloError('engine.uncovered_scope', {
		message,
		publicMessage: 'This record is related to too many others to resolve the relation graph',
	});
}

/**
 * The relation-graph traversal (PHP get_references_recursive :274, ported
 * exactly including the quirks):
 * - the visited cache keys are "section_tipo_section_id_lang";
 * - every call first collects the node's INVERSE references;
 * - MULTIDIRECTIONAL also walks the node's STORED links — added to the
 *   result only on RECURSIVE calls (the root's own data is already the
 *   caller's stored data) — and recurses into both sets;
 * - stored-link elements are reduced to {section_tipo, section_id,
 *   from_component_tipo} (PHP builds a fresh 3-field element).
 *
 * EXPANSION MEMO (divergence from PHP, RESULT-IDENTICAL — review 2026-08-02):
 * PHP re-recurses into every accumulated reference (its own c=a loop AND every
 * ancestor frame's), firing 2 queries per re-entry that the cycle cache then
 * filters to NOTHING — after a node's FIRST expansion all of its inverse and
 * stored neighbours are in `cache`, so a re-entry deterministically returns
 * []. That makes chain-shaped graphs QUADRATIC in queries (hermetic io-seam
 * measurement: chain n=100 → 10,098 queries ≈ 3-5s inside the caller's FOR
 * UPDATE lock; n=200 → 40,198). The `expanded` set short-circuits re-entries
 * BEFORE any query: each node is expanded exactly once, at the same walk
 * position as PHP's first expansion, so the RESULT (content and order) is
 * byte-identical while chains become linear (~2 queries/node —
 * observer_seed_native.test.ts pins the linear bound).
 */
export async function getReferencesRecursive(
	tipo: string,
	// KEPT UNION: the walk cursor re-enters itself with nodes built from the
	// STORED bag (canonicalize passes a non-convertible external id verbatim),
	// so a non-int address legitimately reaches this parameter.
	locator: { section_tipo: string; section_id: number | string; from_component_tipo: string },
	typeRel: string = RELATED_MULTIDIRECTIONAL,
	recursion = false,
	// Only a dedup-key dimension; every caller passes its own lang. The default is
	// the no-language key, never a language literal (request-language law, T2 B10).
	lang = 'lg-nolan',
	// A SET, not a list (audit PERF-04): this is membership-only state, and the
	// `.includes` scan it replaces made the walk quadratic in the CPU on the
	// request thread while every query stayed linear.
	visited: Set<string> = new Set(),
	io: RelatedGraphIO = DB_GRAPH_IO,
	expanded: Set<string> = new Set(),
	depth = 0,
): Promise<RelatedReference[]> {
	const address = `${locator.section_tipo}/${locator.section_id}`;
	assertClosureWithinBounds(tipo, address, depth, 0);
	const cache = recursion ? visited : new Set<string>();
	const selfKey = `${locator.section_tipo}_${locator.section_id}_${lang}`;
	// Re-entry of an already-expanded node contributes nothing (see the memo
	// note above) — return before firing its inverse/stored queries. Safe to
	// skip the cache push too: a node is only re-entered through a path that
	// already put its key in `cache`.
	if (expanded.has(selfKey)) return [];
	expanded.add(selfKey);
	assertClosureWithinBounds(tipo, address, depth, expanded.size);
	cache.add(selfKey);
	const references: RelatedReference[] = [];

	// References to me (inverse hop).
	const inverse = await io.getInverse(
		locator.from_component_tipo,
		locator.section_tipo,
		locator.section_id,
	);
	for (const result of inverse) {
		const key = `${result.section_tipo}_${result.section_id}_${lang}`;
		if (cache.has(key)) continue;
		references.push(result);
		cache.add(key);
	}

	if (typeRel === RELATED_MULTIDIRECTIONAL) {
		// The node's stored links (a=b: what I point TO joins the graph).
		const stored = await io.readStored(
			locator.from_component_tipo,
			locator.section_tipo,
			locator.section_id,
		);
		for (const dataLocator of stored) {
			if (typeof dataLocator?.section_tipo !== 'string' || dataLocator.section_id === undefined) {
				continue;
			}
			// dd490 DATAFRAME entries share the main component's bag in v7 storage
			// but are PAIRING records, not relation data — PHP get_dato never
			// returned them (frames are stripped from a main's data everywhere:
			// cf. the TM-restore literal split). Walking one would treat a frame
			// TARGET (e.g. a vocabulary term) as a graph node — review 2026-08-02.
			if (dataLocator.type === DATAFRAME_RELATION_TYPE) continue;
			const key = `${dataLocator.section_tipo}_${dataLocator.section_id}_${lang}`;
			if (cache.has(key)) continue;
			const element: RelatedReference = {
				section_tipo: dataLocator.section_tipo,
				// Canonicalize what the stored bag holds ('7' → 7) instead of
				// re-stringifying it; a non-convertible id passes verbatim.
				section_id: canonicalizeStoredSectionId(dataLocator.section_id) as number | string,
				from_component_tipo: dataLocator.from_component_tipo ?? locator.from_component_tipo,
			};
			// Only recursive calls add stored links (the root's own data is the
			// caller's stored data — never duplicated, PHP :333-336).
			if (recursion) references.push(element);
			cache.add(key);
			// recurse into the stored link
			references.push(
				...(await getReferencesRecursive(
					tipo,
					{ ...element, from_component_tipo: element.from_component_tipo },
					typeRel,
					true,
					lang,
					cache,
					io,
					expanded,
					depth + 1,
				)),
			);
		}
		// References to references (c=a closure).
		for (const current of [...references]) {
			references.push(
				...(await getReferencesRecursive(
					tipo,
					current,
					typeRel,
					true,
					lang,
					cache,
					io,
					expanded,
					depth + 1,
				)),
			);
		}
	}

	// The ROOT frame owns the gauge: `expanded` is the whole closure it walked.
	publishClosureSize(recursion, expanded.size);
	return references;
}

/**
 * PHP get_dato_with_references (v6 class.component_relation_related.php:149):
 * the component's STORED bag merged with its calculated references — stored
 * first, references appended (array_merge order). The references half follows
 * the get_calculated_references switch exactly: dd620 UNIDIRECTIONAL
 * contributes NOTHING, dd467 BIDIRECTIONAL one inverse hop, dd621
 * MULTIDIRECTIONAL the full recursive closure. This is the peer-expansion
 * primitive of the observer external-value law (D3): set_dato_external seeds
 * its related-mode search with every locator reachable through
 * properties.source.data_from_field, and MEASURED on 19,908 numisdata3
 * records the closure is the difference between correct (19,885 exact / 13
 * locators lost) and a one-hop stored-bag read (247,933 locators lost) —
 * do NOT weaken this to the stored bag.
 *
 * MODEL DISPATCH (review 2026-08-02): PHP's get_dato_with_references is
 * POLYMORPHIC — only component_relation_related OVERRIDES it with the
 * typeRel-switched closure; every other relation model inherits the base,
 * which returns get_dato() alone regardless of any config_relation
 * .relation_type_rel it may carry (v6 class.component_relation_common.php
 * :696-702). `peerModel` reproduces that dispatch: a non-related peer gets
 * the stored bag ONLY, even with dd467/dd621 in its config. All shipped
 * data_from_field peers ARE component_relation_related (app-DB census
 * 2026-08-02: numisdata36/tch40/test200) — the reverse-enumeration census in
 * observer_seed_native.test.ts fails loudly if a new peer ships otherwise.
 *
 * `peerProperties` is the peer NODE's ontology properties (typeRel source —
 * passed in, not re-read, so the law is hermetically testable); `io` injects
 * the graph for tests, defaulting to the live DB.
 */
export async function getStoredWithReferences(
	tipo: string,
	sectionTipo: string,
	sectionId: number | string,
	peerProperties: unknown,
	peerModel: string | null,
	lang = 'lg-nolan',
	io: RelatedGraphIO = DB_GRAPH_IO,
	// KEPT UNION (both decls): the stored half passes the bag's ids through
	// canonicalizeStoredSectionId, which leaves a non-convertible external
	// remote id verbatim — the observer seed must search on those bytes.
): Promise<{ section_tipo: string; section_id: number | string }[]> {
	const typeRel = getRelationTypeRel(peerProperties);
	const merged: { section_tipo: string; section_id: number | string }[] = [];
	// Stored half (PHP get_dato()) — malformed entries carry nothing a locator
	// seed could search on; they are dropped exactly like the traversal drops
	// them (getReferencesRecursive's stored-link guard). dd490 frames are
	// PAIRING records, never relation data (PHP get_dato excludes them — same
	// rule as the traversal's stored walk above).
	const stored = await io.readStored(tipo, sectionTipo, sectionId);
	for (const entry of stored) {
		if (typeof entry?.section_tipo !== 'string' || entry.section_id === undefined) continue;
		if (entry.type === DATAFRAME_RELATION_TYPE) continue;
		merged.push({
			section_tipo: entry.section_tipo,
			section_id: canonicalizeStoredSectionId(entry.section_id) as number | string,
		});
	}
	// References half (PHP get_calculated_references(true) — the typeRel
	// switch), reached ONLY through the component_relation_related override
	// (see MODEL DISPATCH above).
	if (
		peerModel === 'component_relation_related' &&
		(typeRel === RELATED_BIDIRECTIONAL || typeRel === RELATED_MULTIDIRECTIONAL)
	) {
		const references = await getReferencesRecursive(
			tipo,
			{ section_tipo: sectionTipo, section_id: sectionId, from_component_tipo: tipo },
			typeRel,
			false,
			lang,
			new Set(),
			io,
		);
		for (const reference of references) {
			merged.push({ section_tipo: reference.section_tipo, section_id: reference.section_id });
		}
	}
	return merged;
}

/**
 * A reference's display label (PHP get_locator_value :1412 over the show-ddo
 * component tipos): each component's flat list VALUE (PHP get_value — the
 * same resolution the Referencias grid uses), EMPTY parts skipped (:1440),
 * survivors joined with the config fields_separator.
 */
async function labelOfReference(
	reference: RelatedReference,
	showDdoTipos: string[],
	fieldsSeparator: string,
	lang: string,
): Promise<string | null> {
	const { resolveCellValue } = await import('../resolve/relation_list.ts');
	const { getModelByTipo } = await import('../ontology/resolver.ts');
	const unresolved: string[] = [];
	const parts: string[] = [];
	for (const ddoTipo of showDdoTipos) {
		// component_section_id's get_value IS the record id (PHP renders it as
		// a plain string — the '6' in "6 | Colección Privada").
		if ((await getModelByTipo(ddoTipo)) === 'component_section_id') {
			parts.push(String(reference.section_id));
			continue;
		}
		const value = await resolveCellValue(
			reference.section_tipo,
			Number(reference.section_id),
			ddoTipo,
			lang,
			unresolved,
		);
		if (value !== null && value.trim() !== '') parts.push(value);
	}
	return parts.length > 0 ? parts.join(fieldsSeparator) : null;
}

/**
 * The computed back-references of one component instance, label-wrapped for
 * the client (PHP get_calculated_references :152): [] for UNIDIRECTIONAL;
 * the graph walk for BI/MULTI; each locator wrapped as {value, label} unless
 * onlyData (the get_data_with_references merge path).
 */
export async function getCalculatedReferences(
	tipo: string,
	sectionTipo: string,
	sectionId: number | string,
	lang: string,
	options: {
		onlyData?: boolean;
		showDdoTipos?: string[];
		fieldsSeparator?: string;
	} = {},
): Promise<unknown[]> {
	const node = await getNode(tipo);
	const typeRel = getRelationTypeRel(node?.properties ?? null);
	if (typeRel !== RELATED_BIDIRECTIONAL && typeRel !== RELATED_MULTIDIRECTIONAL) {
		return [];
	}
	const references = await getReferencesRecursive(
		tipo,
		{ section_tipo: sectionTipo, section_id: sectionId, from_component_tipo: tipo },
		typeRel,
		false,
		lang,
	);
	if (options.onlyData === true) return references;

	const separator = options.fieldsSeparator ?? ' | ';
	const wrapped: unknown[] = [];
	for (const reference of references) {
		wrapped.push({
			value: reference,
			label: await labelOfReference(reference, options.showDdoTipos ?? [], separator, lang),
		});
	}
	return wrapped;
}
