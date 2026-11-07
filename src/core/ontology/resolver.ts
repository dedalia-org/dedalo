/**
 * Ontology resolver — READ-ONLY registry over the dd_ontology table (spec §3.1).
 *
 * Every runtime structure in Dédalo derives from ontology nodes. This module
 * answers the questions the engines need:
 *   - tipo → model            (which behavior resolves this node)
 *   - tipo → translatable     (does its data carry language variants)
 *   - model → matrix column   (which jsonb column stores its data)
 *   - section tipo → matrix table
 *
 * Data source: the SAME dd_ontology table the PHP server installs/maintains
 * (columns: tipo, parent, term, model, relations, properties, is_translatable…).
 * Ontology import/update stays PHP-owned (plan risk A5.3) — this resolver
 * never writes.
 *
 * CACHING: module-level Maps, keyed by tipo only. Ontology content carries no
 * request identity (no user/lang/session), so a process-wide cache is one of
 * the few legitimate module-level states (spec §4 discipline). PHP bounds its
 * caches for worker safety (COMP-05); we mirror that with a simple size cap.
 *
 * PHP references: ontology_node::get_model_by_tipo (:1109),
 * common::get_matrix_table_from_tipo (:828), section_record_data::$column_map.
 */

import { isValidTipo } from '../concepts/ontology.ts';
import { isInTransaction, sql } from '../db/postgres.ts';
import { DedaloError } from '../errors/dedalo_error.ts';
import { createOntologyCache } from './cache_factory.ts';
import { currentOntologyGeneration, registerOntologyCacheClearer } from './cache_invalidation.ts';
import { refuseLabelNode } from './label_node_guard.ts';
import { nameOrLabelOf, resolveLabel } from './labels.ts';
import { retiredKeysOf } from './property_census.ts';
import { announceRetiredProperties } from './retired_property_notice.ts';
import { getSectionIdFromTipo } from './tld.ts';

/**
 * Non-component models that still resolve to a matrix column. Component models'
 * columns live in the component registry (descriptor.column); only the `section`
 * pseudo-model — which is not a component — remains here.
 * (PHP section_record_data::$column_map covered both; we split by concern.)
 */
const NON_COMPONENT_COLUMN_MAP: Readonly<Record<string, string>> = {
	section: 'data',
};

/**
 * S2-20 inversion seam: the ontology layer must not import components/registry
 * (that static edge closed the 33-file import SCC through descriptors →
 * relation models → back into this resolver). Instead the component registry
 * REGISTERS its model lookup here at its own module load — the
 * cache_invalidation.ts pattern: the registration target lives in the lower
 * module; the registrant calls it as a load side effect.
 *
 * Ordering: every real entrypoint (server.ts, diffusion/runner.ts,
 * ai/rag/cli/rag_drain.ts, the bun test preload) loads components/registry.ts
 * before resolving models. A caller that needs a component-model answer before
 * the registry is loaded is a boot-order bug — we throw loudly (never silently
 * misresolve an alias or column) with the one-line fix in the message.
 */

/** The two descriptor fields this resolver consumes (alias map + column map). */
type ComponentModelFieldsLookup = (
	model: string,
) => { readonly alias?: string; readonly column?: string } | undefined;

let componentModelFieldsLookup: ComponentModelFieldsLookup | null = null;

/** Called by components/registry.ts at module load (see the seam note above). */
export function registerComponentModelFieldsLookup(lookup: ComponentModelFieldsLookup): void {
	componentModelFieldsLookup = lookup;
}

function componentModelFields(
	model: string,
): { readonly alias?: string; readonly column?: string } | undefined {
	if (componentModelFieldsLookup === null) {
		throw new Error(
			'ontology/resolver: component-model lookup not registered — import ' +
				"'core/components/registry.ts' before resolving component models " +
				'(the server/runner/test-preload entrypoints do; a standalone script or test must too)',
		);
	}
	return componentModelFieldsLookup(model);
}

/** One resolved ontology node (the fields the engines consume). */
export interface ResolvedNode {
	tipo: string;
	model: string | null;
	parent: string | null;
	translatable: boolean;
	/** Raw properties JSON (request_config etc. live here). */
	properties: unknown;
	/** Raw relations JSON (links to matrix_table nodes etc.). */
	relations: unknown;
}

/** Bounded module cache (mirrors PHP COMP-05 worker-safety cap). */
const MAX_CACHE_ENTRIES = 10000;
const nodeCache = createOntologyCache<string, ResolvedNode | null>();

/**
 * S1-14 in-tx-read guard: never SEED a shared cache from inside an open
 * transaction. An in-tx read can observe rows the transaction itself has just
 * written (hierarchy provisioning reads nodes mid-provision); memoizing that
 * answer would leak uncommitted — or, after ROLLBACK, never-committed — state
 * process-wide. The read itself stays correct (it runs on the tx connection);
 * only the memoization is skipped. Cache HITS from before the tx are still
 * served: the hub's deferred clear (post-COMMIT replay) is what invalidates
 * those. The `<tld>0` matrix-table short-circuit is tipo-derived and
 * cache-independent, so mid-provisioning table resolution never lands here.
 */
function cacheWrite<K, V>(cache: Map<K, V>, key: K, value: V): void {
	if (isInTransaction()) return;
	cache.set(key, value);
}

/**
 * Clear ALL resolver caches (ontology fixtures in tests, ontology writes).
 *
 * Must drop the matrix-table and component-filter caches too, not just the node
 * cache: after a dd_ontology write those derived answers can be stale (e.g. a
 * freshly-provisioned `<tld>0` section resolves its matrix table from the new
 * node). Registered with the invalidation hub so any dd_ontology mutation fans
 * out to it.
 */
export function clearOntologyCaches(): void {
	nodeCache.clear();
	matrixTableCache.clear();
	componentFilterTipoCache.clear();
	descendantByModelCache.clear();
	relatedTipoByModelCache.clear();
	relatedTipoByExactModelCache.clear();
	sectionRealTipoCache.clear();
	ancestorSectionCache.clear();
}
registerOntologyCacheClearer(clearOntologyCaches);

function cacheSet(tipo: string, node: ResolvedNode | null): void {
	if (isInTransaction()) return; // S1-14 guard — see cacheWrite
	if (nodeCache.size >= MAX_CACHE_ENTRIES) {
		// Drop the oldest entries (Map preserves insertion order).
		const dropCount = Math.floor(MAX_CACHE_ENTRIES / 10);
		let dropped = 0;
		for (const key of nodeCache.keys()) {
			nodeCache.delete(key);
			if (++dropped >= dropCount) break;
		}
	}
	nodeCache.set(tipo, node);
}

/** Load one ontology node (cached). Returns null when the tipo does not exist. */
export async function getNode(tipo: string): Promise<ResolvedNode | null> {
	const cached = nodeCache.get(tipo);
	if (cached !== undefined) {
		return cached;
	}
	const generation = currentOntologyGeneration();
	const rows = (await sql`
		SELECT tipo, model, parent, is_translatable, properties, relations
		FROM dd_ontology
		WHERE tipo = ${tipo}
		LIMIT 1
	`) as {
		tipo: string;
		model: string | null;
		parent: string | null;
		is_translatable: boolean | null;
		properties: unknown;
		relations: unknown;
	}[];
	const row = rows[0];
	const node: ResolvedNode | null =
		row === undefined
			? null
			: {
					tipo: row.tipo,
					model: row.model,
					parent: row.parent,
					translatable: row.is_translatable === true,
					properties: row.properties,
					relations: row.relations,
				};
	if (node !== null && !isInTransaction()) reportRetiredProperties(node);
	// an ontology write cleared the caches while this SELECT was in flight:
	// the row may be pre-write — serve it, never memoize it
	if (generation === currentOntologyGeneration()) cacheSet(tipo, node);
	return node;
}

/**
 * RETIRED-PROPERTY TRIPLINE (DEAD-08 / P2-27). `properties` is a free-form bag:
 * a key the engine stopped reading looks exactly like one it honours, so an
 * author's configuration silently does nothing. Every node in the process
 * passes through this cache miss exactly once, which makes it THE chokepoint —
 * one loud, greppable line per retired KEY per process (the first node that
 * carries it; the rest counted — ./retired_property_notice.ts, C3-72), then
 * resolve by the ordinary rule (CONVENTIONS §1: degraded, reported, defined).
 *
 * A read inside a transaction is not memoized, so it is not reported either —
 * the same node is reported on its first uncached read outside one. Keys marked `reportedAtUse`
 * are skipped: their consumer already reports them with context this site
 * cannot have (the concrete replacement sqo, the named v6 fn).
 *
 * The registry, the reasons and the wording live in one place —
 * ./property_census.ts.
 */
function reportRetiredProperties(node: ResolvedNode): void {
	// ONCE PER KEY per process (C3-72): ./retired_property_notice.ts.
	// Diverted out of the operator's terminal while an install runs (C3-72).
	announceRetiredProperties(node.tipo, retiredKeysOf(node.properties, { skipReportedAtUse: true }));
}

/**
 * Forced models for specific tipos (PHP ontology_node::get_model :420-450 —
 * v6/v7 transition overrides + temporal Time Machine column models).
 */
const FORCED_MODELS: Readonly<Record<string, string>> = {
	dd244: 'component_radio_button', // DEDALO_SECURITY_ADMINISTRATOR_TIPO
	dd1725: 'component_select', // DEDALO_USER_PROFILE_TIPO
	dd546: 'component_input_text', // activity where
	dd545: 'component_select', // activity what
	dd544: 'component_input_text', // activity ip
	dd551: 'component_json', // activity data
	hierarchy48: 'component_number', // hierarchy order
	dd1067: 'component_check_box', // tools component_security_tools
	hierarchy45: 'component_portal', // hierarchy main: General term
	hierarchy59: 'component_portal', // hierarchy main: General term model
	// temporal TM column models (until the ontology is updated)
	dd1573: 'component_number',
	dd1212: 'component_number',
	dd1772: 'component_input_text',
	dd577: 'component_input_text',
	dd559: 'component_date',
	dd578: 'component_portal',
	dd1371: 'component_number',
	dd1574: 'component_json',
};

/**
 * Legacy STRUCTURAL model replacements (PHP ontology_node::get_model :493-507).
 * Component-model aliases (component_input_text_large → component_text_area,
 * component_autocomplete(_hi) → component_portal, …) now live in the component
 * registry as descriptor.alias; only these non-component structural aliases
 * (section groups/tabs and the "box elements" containers) remain here.
 */
const STRUCTURAL_MODEL_REPLACEMENT_MAP: Readonly<Record<string, string>> = {
	section_group_div: 'section_group',
	tab: 'section_tab',
	component_relation_struct: 'box elements',
	dataframe: 'box elements',
};

/**
 * tipo → RUNTIME model name (PHP ontology_node::get_model_by_tipo): forced
 * tipo overrides win, then the stored model passes through the legacy
 * replacement map (component aliases via the component registry, structural
 * aliases via the residual map). Null when unknown.
 */
export async function getModelByTipo(tipo: string): Promise<string | null> {
	const forced = FORCED_MODELS[tipo];
	if (forced !== undefined) return forced;
	return runtimeModelOfStored(tipo, (await getNode(tipo))?.model ?? null);
}

/**
 * THE runtime-model law over an ALREADY-READ stored `model` column — the body
 * of getModelByTipo, exported so a bulk reader that fetched the rows itself
 * (the security-access datalist's one-query ontology snapshot) applies the SAME
 * law without a getNode per node. Forced overrides win; null stays null; a
 * component_alias hops to its target (resolver-read, aliases only); then the
 * component-registry alias and the structural replacement map.
 */
export async function runtimeModelOfStored(
	tipo: string,
	storedModel: string | null,
): Promise<string | null> {
	const forced = FORCED_MODELS[tipo];
	if (forced !== undefined) return forced;
	if (storedModel === null) return null;
	// component_alias hop (WC-020, ontology/alias.ts owns the contract): the
	// alias behaves as its TARGET everywhere the runtime model is consumed —
	// the client instantiates the target's JS class, the engines dispatch the
	// target's behavior. Single hop through THE alias reader (aliasTargetTipoOf
	// below — alias.ts delegates to it; this module must not import alias.ts:
	// alias.ts imports getNode).
	if (storedModel === 'component_alias') {
		return getModelByTipo(await aliasTargetTipoOf(tipo));
	}
	return (
		componentModelFields(storedModel)?.alias ??
		STRUCTURAL_MODEL_REPLACEMENT_MAP[storedModel] ??
		storedModel
	);
}

/** Why an alias node's `alias_of` was refused (the `reason` coordinate, SURF-1). */
export type AliasRefusalReason = 'missing' | 'grammar' | 'absent' | 'chained';

/**
 * THE alias reader (WC-020 + SURF-1) — the target tipo of a KNOWN
 * component_alias node. ONE copy: the resolver's model hop and its data-node
 * hop (`dataNodeOf` — the translatable and lang-versions rules) call it, and ontology/alias.ts `resolveAliasTargetTipo`
 * (behind the cache and the retired-key check) delegates to it — so every
 * consumer of an alias target, the search engine's data-tipo re-key included,
 * gets the same answer or the same refusal.
 *
 * The target is an IDENTIFIER: the search engine interpolates it into JSONB
 * paths and SQL, the save path keys the matrix slot by it. So it obeys the
 * §7.6 tipo grammar (`isValidTipo`), checked BEFORE the row lookup — a hostile
 * value is refused whether or not a row exists under it. Order, each refusal
 * `ontology.invalid_node` with `{tipo, alias_of, reason}`:
 *   missing (not a non-empty string) → grammar → absent (no node) → chained
 *   (the target is itself an alias; single hop only).
 * `alias_of` in the coordinates and the message is the JSON-escaped value cut
 * to 64 characters — a planted value never reaches a log line raw.
 */
export async function aliasTargetTipoOf(tipo: string): Promise<string> {
	const aliasOf = ((await getNode(tipo))?.properties as { alias_of?: unknown } | null)?.alias_of;
	const verdict = await aliasTargetVerdict(aliasOf);
	if ('target' in verdict) return verdict.target;
	const shown = JSON.stringify(aliasOf ?? null).slice(0, 64);
	throw new DedaloError('ontology.invalid_node', {
		message: `component_alias '${tipo}': ${ALIAS_REFUSAL_MESSAGE[verdict.reason](tipo, shown)}`,
		coordinates: { tipo, alias_of: shown, reason: verdict.reason },
	});
}

/**
 * The ordered checks of an `alias_of` value (see aliasTargetTipoOf): the first
 * broken one's reason, or the target. The grammar is checked BEFORE the node
 * lookup, so a hostile value never reaches the reader as a key.
 */
async function aliasTargetVerdict(
	aliasOf: unknown,
): Promise<{ target: string } | { reason: AliasRefusalReason }> {
	if (typeof aliasOf !== 'string' || aliasOf === '') return { reason: 'missing' };
	if (!isValidTipo(aliasOf)) return { reason: 'grammar' };
	const target = await getNode(aliasOf);
	if (target === null) return { reason: 'absent' };
	return target.model === 'component_alias' ? { reason: 'chained' } : { target: aliasOf };
}

/** The operator sentence of each alias refusal (`shown` = the JSON-escaped value, cut to 64). */
const ALIAS_REFUSAL_MESSAGE: Record<AliasRefusalReason, (tipo: string, shown: string) => string> = {
	missing: () =>
		'properties.alias_of is required (WC-020) — a standalone definition must use its real component model',
	grammar: (_tipo, shown) =>
		`alias_of ${shown} is not a tipo (letters+digits, §7.6) — an alias target is an identifier (SURF-1)`,
	absent: (_tipo, shown) => `alias_of target ${shown} does not exist`,
	chained: (tipo, shown) =>
		`alias-of-alias refused ('${tipo}' → ${shown} → …) — single hop only (WC-020)`,
};

/** tipo → translatable flag (PHP ontology_node::get_translatable). */
export async function getTranslatableByTipo(tipo: string): Promise<boolean> {
	return (await dataNodeOf(tipo))?.translatable ?? false;
}

/**
 * The node that holds `tipo`'s DATA definition: for a component_alias its
 * TARGET's node (through THE reader, `aliasTargetTipoOf` — one hop, the target
 * is never itself an alias), else `tipo`'s own. The translatable and
 * lang-versions rules read this, so an alias answers for its target and no
 * consumer carries a second alias hop of its own.
 */
async function dataNodeOf(tipo: string): Promise<ResolvedNode | null> {
	const node = await getNode(tipo);
	if (node?.model !== 'component_alias') return node;
	return getNode(await aliasTargetTipoOf(tipo));
}

/**
 * THE LANG A SAVE OF `tipo` WRITES (PHP component_common::__construct
 * :666-678): the request lang for a translatable component, for a
 * `with_lang_versions` one (a TRANSLITERABLE component, e.g. rsc85 in rsc197:
 * an lg-nolan base beside per-language versions — Augustus lg-nolan,
 * Αύγουστος lg-ell) and for component_iri (which slices by the request lang
 * either way); `lg-nolan` otherwise. The ONE rule of every door that saves a
 * lang slice, echoes it or cuts the slice it will save back — never a local
 * copy. That covers every SPEAKING door; a DOORLESS history door (lg-nolan
 * request) files by dataframe_slots.ts slicedRowLang (gate:
 * test/unit/history_door_lane_agreement_native.test.ts). (A READ asks a
 * different question — which lang the INSTANCE runs in — answered by
 * elementLang below: a transliterable keeps only an EXPLICITLY requested lang
 * there, never the ambient one, because a save's lang is always explicit and a
 * display read's usually is not.)
 */
export async function effectiveSaveLang(
	tipo: string,
	model: string,
	lang: string,
): Promise<string> {
	return (await savesInRequestLang(tipo, model)) ? lang : 'lg-nolan';
}

/** Whether a save of `tipo` keeps the request lang (effectiveSaveLang); false = every save is `lg-nolan`. */
export async function savesInRequestLang(tipo: string, model: string): Promise<boolean> {
	// ONE alias hop for both rules (an alias answers for its target).
	if ((await dataNodeOf(tipo))?.translatable === true) return true;
	return hasLangVersions(tipo, model);
}

/**
 * Whether `tipo` is TRANSLITERABLE: a non-translatable component whose value
 * lives in an lg-nolan BASE but may also hold per-language VERSIONS beside it
 * (PHP `with_lang_versions`, class.component_common.php:666-678 — v6
 * semantics; the frozen v7 PHP never read the property, see its typed
 * `bool $with_lang_versions = false` + `isset`). True for every component_iri
 * (PHP class.component_iri.php:64 hard-sets it, the ontology flag is not
 * needed) and for any component whose ontology `properties.with_lang_versions`
 * is `true`. Read on the DATA node (an alias answers for its target — an alias
 * onto an iri is an iri), from the ontology only: an rqo properties override
 * never makes a component transliterable (PHP read it in the constructor,
 * before set_properties).
 */
export async function hasLangVersions(tipo: string, model: string): Promise<boolean> {
	if (model === 'component_iri') return true;
	const node = await dataNodeOf(tipo);
	if (node?.model === 'component_iri') return true;
	return (node?.properties as { with_lang_versions?: unknown } | null)?.with_lang_versions === true;
}

/**
 * THE LANG AN ELEMENT INSTANCE OF `tipo` RUNS IN (PHP component_common
 * __construct :666-678 + common::get_element_lang :3684) — the ONE rule of
 * every door that stamps a component's context `lang` or picks the slice a
 * read shows:
 *
 * - translatable → the lang the caller asked for, else the AMBIENT lang (the
 *   request data lang / the read's own lang — the caller supplies it);
 * - transliterable (hasLangVersions: `with_lang_versions`, component_iri) →
 *   the lang the caller EXPLICITLY asked for (the tool_lang target building
 *   in lg-spa), else the lg-nolan BASE;
 * - anything else → `lg-nolan`, whatever was asked.
 *
 * "Requested" means EXPLICIT — a component read's own `source.lang`, a ddo's
 * declared `lang`, an agent's `input.lang` — and NEVER the ambient page data
 * lang a section/list/portal read carries for its children: were the ambient
 * lang to count, the normal edit form would build (and save) a transliterable
 * in lg-spa instead of its base. The save door is a different question
 * (effectiveSaveLang: a save's lang is always explicit).
 */
export async function elementLang(
	tipo: string,
	model: string,
	langs: { requested?: string | null; ambient: string },
): Promise<string> {
	const requested = langs.requested || null;
	if ((await dataNodeOf(tipo))?.translatable === true) return requested ?? langs.ambient;
	if (requested !== null && (await hasLangVersions(tipo, model))) return requested;
	return 'lg-nolan';
}

/** model → matrix jsonb column (PHP section_record_data::get_column_name). */
export function getColumnNameByModel(model: string): string | null {
	return componentModelFields(model)?.column ?? NON_COMPONENT_COLUMN_MAP[model] ?? null;
}

/**
 * All descendant component tipos of a section, walking the ontology subtree by
 * `parent` without crossing into nested sections/areas (same containment rule
 * as getComponentFilterTipo). Used by the RAG config to enumerate a section's
 * embeddable text components. Not cached — callers cache the filtered result.
 */
export async function getRecursiveChildrenTipos(sectionTipo: string): Promise<string[]> {
	const rows = (await sql`
		WITH RECURSIVE subtree AS (
			SELECT tipo, model FROM dd_ontology WHERE parent = ${sectionTipo}
			UNION ALL
			SELECT child.tipo, child.model
			FROM dd_ontology child
			JOIN subtree ON child.parent = subtree.tipo
			WHERE subtree.model NOT IN ('section')
			  AND subtree.model NOT LIKE 'area%'
		)
		SELECT tipo FROM subtree
	`) as { tipo: string }[];
	return rows.map((row) => row.tipo);
}

/**
 * tipo → term (label) in a given lang, or null. Reads the dd_ontology `term`
 * translations map; used for the RAG chunker's contextual document title.
 * The ONE label chain (labels.ts resolveLabel: lang → equivalent → label
 * fallback lang → any non-empty → machine name). A model='label' node is
 * refused (refuseLabelNode, ./label_node_guard.ts): dev/test throw; production
 * logs once and answers null (this resolver's existing "no term" value).
 * Uncached, so nothing to keep a refusal in.
 */
export async function getTermByTipo(tipo: string, lang: string): Promise<string | null> {
	const rows =
		(await sql`SELECT term, model, machine_name FROM dd_ontology WHERE tipo = ${tipo} LIMIT 1`) as {
			term: Record<string, string> | null;
			model: string | null;
			machine_name: string | null;
		}[];
	if (refuseLabelNode(tipo, rows[0]?.model)) return null;
	return resolveLabel(rows[0]?.term ?? null, lang, rows[0]?.machine_name ?? null);
}

// ---------------------------------------------------------------------------
// T3 CANONICAL SUBTREE ACCESSORS (audit S2-19 / DEC-09 tier T3).
//
// dd_ontology tree reads consolidate HERE: this module is the one place that
// decides the walk semantics every caller used to re-decide independently —
// the section containment rule, the virtual-section fallback, and the sibling
// ORDER/TIEBREAK policy. New code must use these instead of hand-rolling a
// `WITH RECURSIVE` over dd_ontology; the existing direct walks are being
// burned down behind the count-ratchet in
// test/unit/sql_confinement_tripwire.test.ts.
// ---------------------------------------------------------------------------

/** One node of an ordered ontology subtree walk. */
export interface OntologySubtreeNode {
	tipo: string;
	parent: string | null;
	model: string | null;
	term: Record<string, string> | null;
	/** The node's language-free name (NULL unless use_machine_name; labels.ts nameOrLabelOf). */
	machine_name: string | null;
	/** true → machine_name names the node; NULL on a row not derived yet. */
	use_machine_name: boolean | null;
	properties: unknown;
	relations: unknown;
	/** Numeric order_number; Infinity when the column is NULL (sorts last). */
	orderNumber: number;
}

/**
 * THE canonical sibling order policy (single source of truth): order_number
 * ASC with NULLs last, lexicographic tipo tiebreak. PHP walks children ORDER
 * BY order_number ASC (dd_ontology_db_manager::search) and leaves equal
 * order_numbers UNORDERED; the tipo tiebreak pins the observed live order
 * deterministically (same rule the diffusion walks documented at
 * diffusion_bridge/diffusion_map.ts:306-328 / diffusion/plan/virtual_tree.ts:191-195).
 */
export function compareSiblingOrder(
	a: Pick<OntologySubtreeNode, 'orderNumber' | 'tipo'>,
	b: Pick<OntologySubtreeNode, 'orderNumber' | 'tipo'>,
): number {
	if (a.orderNumber !== b.orderNumber) return a.orderNumber < b.orderNumber ? -1 : 1;
	return a.tipo < b.tipo ? -1 : a.tipo > b.tipo ? 1 : 0;
}

function toSubtreeNode(row: {
	tipo: string;
	parent: string | null;
	model: string | null;
	term: Record<string, string> | null;
	machine_name: string | null;
	use_machine_name: boolean | null;
	properties: unknown;
	relations: unknown;
	order_number: number | string | null;
}): OntologySubtreeNode {
	return {
		tipo: row.tipo,
		parent: row.parent,
		model: row.model,
		term: row.term,
		machine_name: row.machine_name ?? null,
		use_machine_name: row.use_machine_name ?? null,
		properties: row.properties,
		relations: row.relations,
		orderNumber:
			row.order_number === null || row.order_number === undefined
				? Number.POSITIVE_INFINITY
				: Number(row.order_number),
	};
}

/**
 * ORDERED SUBTREE WALK: every descendant of `rootTipo` in depth-first
 * pre-order, siblings ordered by the canonical policy (compareSiblingOrder).
 *
 * Containment: by default the walk does NOT descend through nested section /
 * area nodes (the standard section-subtree rule shared with
 * getComponentFilterTipo; the pruned node itself IS returned). Pass
 * `crossSections: true` for a full structural walk (the diffusion-map shape).
 *
 * NOT cached — the full-tree consumers cache their derived structures; the
 * per-lookup consumers use the cached findFirstDescendantTipoByModel below.
 */
export async function getOrderedSubtree(
	rootTipo: string,
	options: { includeRoot?: boolean; crossSections?: boolean } = {},
): Promise<OntologySubtreeNode[]> {
	const guard = options.crossSections
		? ''
		: `WHERE subtree.model IS DISTINCT FROM 'section' AND (subtree.model IS NULL OR subtree.model NOT LIKE 'area%')`;
	const rows = (await sql.unsafe(
		`WITH RECURSIVE subtree AS (
			SELECT tipo, parent, model, term, machine_name, use_machine_name, properties, relations, order_number
			FROM dd_ontology WHERE parent = $1
			UNION ALL
			SELECT child.tipo, child.parent, child.model, child.term, child.machine_name, child.use_machine_name, child.properties, child.relations, child.order_number
			FROM dd_ontology child
			JOIN subtree ON child.parent = subtree.tipo
			${guard}
		)
		SELECT tipo, parent, model, term, machine_name, use_machine_name, properties, relations, order_number FROM subtree`,
		[rootTipo],
	)) as Parameters<typeof toSubtreeNode>[0][];
	const nodes = rows.map(toSubtreeNode);
	const byParent = new Map<string, OntologySubtreeNode[]>();
	for (const node of nodes) {
		if (node.parent === null) continue;
		const siblings = byParent.get(node.parent) ?? [];
		siblings.push(node);
		byParent.set(node.parent, siblings);
	}
	for (const siblings of byParent.values()) siblings.sort(compareSiblingOrder);
	// Depth-first pre-order from the root using the sorted sibling lists.
	const ordered: OntologySubtreeNode[] = [];
	const walk = (parentTipo: string): void => {
		for (const child of byParent.get(parentTipo) ?? []) {
			ordered.push(child);
			walk(child.tipo);
		}
	};
	walk(rootTipo);
	if (options.includeRoot) {
		const rootRows = (await sql.unsafe(
			`SELECT tipo, parent, model, term, machine_name, use_machine_name, properties, relations, order_number
			 FROM dd_ontology WHERE tipo = $1 LIMIT 1`,
			[rootTipo],
		)) as Parameters<typeof toSubtreeNode>[0][];
		const rootRow = rootRows[0];
		if (rootRow !== undefined) ordered.unshift(toSubtreeNode(rootRow));
	}
	return ordered;
}

/**
 * CHILDREN-OF: the DIRECT children of one node, in canonical sibling order.
 */
export async function getChildrenNodes(parentTipo: string): Promise<OntologySubtreeNode[]> {
	const rows = (await sql`
		SELECT tipo, parent, model, term, machine_name, use_machine_name, properties, relations, order_number
		FROM dd_ontology WHERE parent = ${parentTipo}
	`) as Parameters<typeof toSubtreeNode>[0][];
	return rows.map(toSubtreeNode).sort(compareSiblingOrder);
}

/**
 * PROPERTIES-OF: one node's raw properties JSON (request_config, diffusion
 * config, tool config … all live here), through the cached node loader — so
 * a properties read after an ontology write is hub-coherent instead of racing
 * a stale nodeCache against a fresh ad-hoc SELECT. Null for unknown tipos and
 * for nodes without properties.
 */
export async function getPropertiesByTipo(tipo: string): Promise<unknown> {
	return (await getNode(tipo))?.properties ?? null;
}

/** One node returned by getNodesWithProperty: its tipo + raw properties object. */
export interface NodeWithProperties {
	tipo: string;
	properties: Record<string, unknown>;
}

/**
 * Every dd_ontology node whose `properties` JSONB carries a top-level
 * `propertyKey` (PHP's `properties ? 'key'` scan) — a by-PROPERTY scan the
 * per-tipo cache cannot serve, so it lives here in the exempt canonical home
 * (the T3 ratchet only shrinks — a caller must never grow its own direct
 * `FROM dd_ontology`).
 *
 * TWO callers, split caching (Act 2, 2026-08-02):
 *   - the observer SUBSCRIPTION REGISTRY
 *     (`section/record/observer_subscriptions.ts`) scans 'observers' ∪
 *     'observe' and caches the BUILT index through createOntologyCache (hub-
 *     cleared after every dd_ontology write) — the caching lives THERE, on the
 *     derived structure, never here on the raw rows;
 *   - the observer-mirror reconciler's sweep
 *     (`section/record/observer_reconcile.ts`) reaches the registry too, but
 *     out-of-band scripts remain free to call this scan directly.
 * The scan itself stays UNCACHED: it must always see the live property set,
 * and each caller decides what derived shape (if any) is worth memoizing.
 */
export async function getNodesWithProperty(propertyKey: string): Promise<NodeWithProperties[]> {
	return (await sql.unsafe('SELECT tipo, properties FROM dd_ontology WHERE properties ? $1', [
		propertyKey,
	])) as NodeWithProperties[];
}

/**
 * EVERY node whose `properties` is a JSON object, with those properties — the
 * whole-table scan the ontology property census needs
 * (`scripts/ontology_property_report.ts`, DEAD-08). Lives here because
 * src/core/ontology/ is the exempt canonical home for `FROM dd_ontology`
 * (sql_confinement T3): a script must never grow its own direct read.
 *
 * UNCACHED and unbounded by design: it is a maintenance report over the live
 * table, not a runtime read path.
 */
export async function listNodesWithProperties(): Promise<NodeWithProperties[]> {
	return (await sql`
		SELECT tipo, properties
		FROM dd_ontology
		WHERE properties IS NOT NULL AND jsonb_typeof(properties) = 'object'
		ORDER BY tipo
	`) as NodeWithProperties[];
}

/**
 * FIRST DESCENDANT BY MODEL: the classic
 * `get_ar_children_tipo_by_model_name_in_section(...) → first hit` shape that
 * children.ts / ts_object.ts / area/tree.ts / section_id_component.ts each
 * hand-rolled (audit S2-19). Recursive parent-link walk from `rootTipo`, NOT
 * descending through nested section/area nodes; the first match by
 * lexicographic tipo (the deterministic tiebreak the diffusion resolver
 * pinned — these are singleton-by-design components, so the tiebreak only
 * matters for pathological duplicate declarations).
 *
 * `virtualFallback` (default true): when the walk finds nothing, resolve a
 * VIRTUAL section through its real section (getSectionRealTipo) and walk that
 * — the shared fallback every migrated caller implemented separately. Pass
 * false to preserve strict own-subtree semantics (component_section_id).
 * component_filter MUST use the fallback: a virtual section's records are
 * gated by the real section's filter (see getComponentFilterTipo).
 *
 * Cached per (root, model, fallback); registered with the invalidation hub.
 */
const descendantByModelCache = createOntologyCache<string, string | null>();

export async function findFirstDescendantTipoByModel(
	rootTipo: string,
	model: string,
	options: { virtualFallback?: boolean } = {},
): Promise<string | null> {
	const virtualFallback = options.virtualFallback !== false;
	const cacheKey = `${rootTipo}|${model}|${virtualFallback ? 'v' : 's'}`;
	const cached = descendantByModelCache.get(cacheKey);
	if (cached !== undefined) return cached;

	const walk = async (root: string): Promise<string | null> => {
		const rows = (await sql`
			WITH RECURSIVE subtree AS (
				SELECT tipo, model FROM dd_ontology WHERE parent = ${root}
				UNION ALL
				SELECT child.tipo, child.model
				FROM dd_ontology child
				JOIN subtree ON child.parent = subtree.tipo
				WHERE subtree.model NOT IN ('section')
				  AND subtree.model NOT LIKE 'area%'
			)
			SELECT tipo FROM subtree WHERE model = ${model} ORDER BY tipo LIMIT 1
		`) as { tipo: string }[];
		return rows[0]?.tipo ?? null;
	};

	let found = await walk(rootTipo);
	if (found === null && virtualFallback) {
		// Virtual section: its relations point at the REAL section — walk that.
		const realTipo = await getSectionRealTipo(rootTipo);
		if (realTipo !== rootTipo) {
			found = await walk(realTipo);
		}
	}
	cacheWrite(descendantByModelCache, cacheKey, found);
	return found;
}

/**
 * The component_filter child tipo of a section (PHP
 * section::get_ar_children_tipo_by_model_name_in_section(...,['component_filter'],
 * …, resolve_virtual=TRUE — trait.where.php build_sql_projects_filter)), or
 * null when the section is NOT project-gated.
 *
 * VIRTUAL SECTIONS MUST FALL THROUGH to their real section: records of a
 * virtual section (e.g. rsc170 images) are stored under the VIRTUAL tipo but
 * gated by the REAL section's component_filter (rsc2 → rsc28). The previous
 * strict own-subtree lookup returned null for them, which silently DISABLED
 * the projects ACL — every non-admin saw all 438k images (fail-open,
 * 2026-07-19). PHP resolves virtual→real before walking; the shared helper's
 * own-subtree-then-real fallback is equivalent because virtual sections carry
 * only list/config children, never components.
 */
const componentFilterTipoCache = createOntologyCache<string, string | null>();

export async function getComponentFilterTipo(sectionTipo: string): Promise<string | null> {
	const cached = componentFilterTipoCache.get(sectionTipo);
	if (cached !== undefined) return cached;
	const filterTipo = await findFirstDescendantTipoByModel(sectionTipo, 'component_filter', {
		virtualFallback: true,
	});
	cacheWrite(componentFilterTipoCache, sectionTipo, filterTipo);
	return filterTipo;
}

/**
 * THE virtual→real section law (PHP section::get_section_real_tipo_static —
 * common::get_ar_related_by_model('section', tipo)[0]): the FIRST node named in
 * the section's `relations` whose MODEL is exactly 'section'; the input tipo
 * itself when there is none (a real section, or a non-section node). A
 * `matrix_table` relation does NOT make a section virtual, and index 0 is not
 * privileged: `rsc170 → rsc2` resolves the same whether the section link is
 * first or last in the array.
 *
 * ONE home (DATA-33). Every consumer that borrows a real section's children
 * (list definitions, section_map, buttons, thesaurus ddo_map, relation_index,
 * the subtree walks, the identify profile, the diffusion resolver, the MCP
 * discovery, the record wipe) resolves through this function — the
 * `relations[0].tipo` copies each of them carried answered differently from
 * this law for every real section whose first relation is its matrix_table
 * (40+ on the reference install), and value_law_agreement_tripwire refuses a
 * new copy. resolve/security_access_datalist.ts re-exports it for its eleven
 * importers.
 *
 * Cached per tipo (pure ontology; hub-cleared like the sibling caches; the
 * in-transaction write skip applies — see cacheWrite).
 */
const sectionRealTipoCache = createOntologyCache<string, string>();

export async function getSectionRealTipo(sectionTipo: string): Promise<string> {
	const cached = sectionRealTipoCache.get(sectionTipo);
	if (cached !== undefined) return cached;
	const real = await sectionRealTipoFromRelations(
		sectionTipo,
		(await getNode(sectionTipo))?.relations,
		getModelByTipo,
	);
	cacheWrite(sectionRealTipoCache, sectionTipo, real);
	return real;
}

/**
 * THE virtual→real walk over an ALREADY-READ `relations` value: the first
 * related tipo whose runtime model is `section`, else the tipo itself. The
 * body of getSectionRealTipo, exported (like runtimeModelOfStored) for a bulk
 * reader that holds the rows and a model accessor of its own — one law, two
 * row sources, never a second copy of the walk.
 */
export async function sectionRealTipoFromRelations(
	sectionTipo: string,
	relations: unknown,
	modelOf: (tipo: string) => Promise<string | null>,
): Promise<string> {
	if (!Array.isArray(relations)) return sectionTipo;
	for (const relation of relations) {
		const relatedTipo = (relation as { tipo?: unknown } | null)?.tipo;
		if (typeof relatedTipo !== 'string' || relatedTipo === '') continue;
		if ((await modelOf(relatedTipo)) === 'section') return relatedTipo;
	}
	return sectionTipo;
}

/**
 * THE WALK, STATED ONCE: the first tipo in a node's `relations` JSON whose
 * MODEL satisfies `matches`. Both related-tipo accessors below are this walk
 * plus their own cache and their own predicate — a second copy of the walk
 * would be a second answer to "which relation comes first", the one thing they
 * must agree on.
 */
async function firstRelatedTipoMatching(
	tipo: string,
	matches: (relatedModel: string | null) => boolean,
): Promise<string | null> {
	const relations = (await getNode(tipo))?.relations;
	if (!Array.isArray(relations)) return null;
	for (const relation of relations) {
		const relatedTipo = (relation as { tipo?: unknown } | null)?.tipo;
		if (typeof relatedTipo !== 'string' || relatedTipo === '') continue;
		if (matches(await getModelByTipo(relatedTipo))) return relatedTipo;
	}
	return null;
}

/**
 * The first tipo in a node's `relations` JSON whose model CONTAINS `model`
 * (PHP ontology_node::get_ar_tipo_by_model_and_relation(tipo, model, 'related')
 * first hit — substring match, search_exact=false, so 'component_av' also
 * matches hypothetical variants; PHP str_contains). Null when the node has no
 * matching relation. Used by e.g. component_text_area::
 * get_related_component_av_tipo (the transcription text ↔ AV player pairing
 * tool_transcription's build_subtitles_file resolves through).
 *
 * Cached per (tipo, model) — the value is pure ontology (no lang/principal
 * dimension), so the hub-registered ontology cache is the right lifecycle.
 */
const relatedTipoByModelCache = createOntologyCache<string, string | null>();

export async function relatedTipoByModel(tipo: string, model: string): Promise<string | null> {
	const cacheKey = `${tipo}|${model}`;
	const cached = relatedTipoByModelCache.get(cacheKey);
	if (cached !== undefined) return cached;

	const resolved = await firstRelatedTipoMatching(
		tipo,
		(relatedModel) => relatedModel?.includes(model) === true,
	);
	cacheWrite(relatedTipoByModelCache, cacheKey, resolved);
	return resolved;
}

/**
 * The first tipo in a node's `relations` JSON whose model is EXACTLY `model`
 * (PHP get_ar_tipo_by_model_and_relation with search_exact — the law
 * getSectionRealTipo applies to a section, applied to any node). Null when
 * nothing matches.
 *
 * SEPARATE FROM relatedTipoByModel BY NECESSITY, not by taste: that one matches
 * with `relatedModel.includes(model)`, so asking it for 'section' also answers
 * 'section_list' and 'section_group' — silently the wrong node. A caller that
 * means "the related SECTION" must ask this one.
 *
 * Cached per (tipo, model): pure ontology, no lang/principal dimension, cleared
 * by the hub on any dd_ontology write.
 */
const relatedTipoByExactModelCache = createOntologyCache<string, string | null>();

export async function relatedTipoByExactModel(tipo: string, model: string): Promise<string | null> {
	const cacheKey = `${tipo}|${model}`;
	const cached = relatedTipoByExactModelCache.get(cacheKey);
	if (cached !== undefined) return cached;

	const resolved = await firstRelatedTipoMatching(tipo, (relatedModel) => relatedModel === model);
	cacheWrite(relatedTipoByExactModelCache, cacheKey, resolved);
	return resolved;
}

/**
 * section tipo → matrix table (PHP common::get_matrix_table_from_tipo).
 * Resolution: hardcoded users/projects cases, then the section's ontology
 * relations pointing at a node of model 'matrix_table' whose term holds the
 * table name; default 'matrix'.
 */
const matrixTableCache = createOntologyCache<string, string | null>();

export async function getMatrixTableFromTipo(sectionTipo: string): Promise<string | null> {
	const cached = matrixTableCache.get(sectionTipo);
	if (cached !== undefined) {
		return cached;
	}
	let table: string | null;
	if (sectionTipo === 'all') {
		table = null;
	} else if (getSectionIdFromTipo(sectionTipo) === '0') {
		// ONTOLOGY SECTIONS exception (PHP common::get_matrix_table_from_tipo
		// :861-870): any tipo whose section_id part is '0' is an ontology main
		// section and lives in matrix_ontology — resolved BEFORE the node lookup
		// so a not-yet-installed local `<tld>0` (whose dd_ontology node may be
		// absent mid-provisioning) still routes to the right table.
		table = 'matrix_ontology';
	} else {
		// PHP contract: unknown tipos and non-section models resolve to NULL —
		// only a real section falls back to the default 'matrix' table when it
		// carries no explicit matrix_table relation.
		const node = await getNode(sectionTipo);
		if (node === null || node.model !== 'section') {
			table = null;
		} else if (sectionTipo === 'dd153') {
			table = 'matrix_projects'; // PHP fixed case (DEDALO_SECTION_PROJECTS_TIPO)
		} else if (sectionTipo === 'dd128') {
			table = 'matrix_users'; // PHP fixed case (DEDALO_SECTION_USERS_TIPO)
		} else {
			table = await relatedMatrixTable(sectionTipo);
			if (table === null) {
				// VIRTUAL SECTION fallback (PHP get_section_real_tipo_static): a
				// virtual section's relations point at its REAL section — resolve
				// the real tipo (the ONE law, getSectionRealTipo) and read ITS
				// matrix_table relation instead.
				const realTipo = await getSectionRealTipo(sectionTipo);
				if (realTipo !== sectionTipo) {
					table = await relatedMatrixTable(realTipo);
				}
			}
			table = table ?? 'matrix'; // PHP default-table fallback
		}
	}
	// INJ-02 central identifier guard: the resolved table name is interpolated
	// verbatim into `"${table}"` at ~20 write/resolve SQL sites that (unlike the
	// read path) do not re-assert it. A poisoned ontology term (dd627 label) is
	// only reachable with ontology-write compromise, but this makes it structurally
	// impossible for such a value to break out of the identifier quoting. Every
	// real matrix table (incl. matrix_time_machine, matrix_structurations — which
	// are outside MATRIX_TABLE_ALLOWLIST) matches this safe SQL-identifier shape.
	if (table !== null && !/^[a-z_][a-z0-9_]*$/.test(table)) {
		throw new Error(
			`ontology: refusing unsafe matrix table name '${table}' for '${sectionTipo}' (INJ-02 identifier guard)`,
		);
	}
	cacheWrite(matrixTableCache, sectionTipo, table);
	return table;
}

/**
 * The matrix_table related to one section node, or null when the node carries
 * no explicit matrix_table relation. dd_ontology.relations is an array of
 * {tipo} links — join against nodes of model 'matrix_table' and read the
 * table name: the node's MACHINE NAME (matrix_table is a name model,
 * machine_name.ts NAME_MODELS), never a label — some matrix_table nodes carry
 * stray translations (e.g. dd1200), which the old lg-spa → first-non-empty
 * reading could pick. A matrix_table node whose name the parser could not
 * derive (`missing` / `collision`) THROWS `ontology.invalid_node` naming both
 * tipos: falling to the virtual / default rules would read and write the
 * section's records in ANOTHER table, silently. Guard: only unnest
 * when relations is a JSON array — some nodes carry a non-array (or null)
 * relations column, which would make jsonb_array_elements raise 22023.
 */
async function relatedMatrixTable(sectionTipo: string): Promise<string | null> {
	const rows = (await sql`
		SELECT t.tipo, t.term, t.machine_name, t.use_machine_name
		FROM dd_ontology s,
		     jsonb_array_elements(s.relations) AS rel(link)
		JOIN dd_ontology t ON t.tipo = rel.link->>'tipo' AND t.model = 'matrix_table'
		WHERE s.tipo = ${sectionTipo}
		  AND jsonb_typeof(s.relations) = 'array'
		LIMIT 1
	`) as {
		tipo: string;
		term: Record<string, string> | null;
		machine_name: string | null;
		use_machine_name: boolean | null;
	}[];
	const row = rows[0];
	if (row === undefined) return null;
	const table = nameOrLabelOf(row);
	if (table !== null) return table;
	throw new DedaloError('ontology.invalid_node', {
		message: `section '${sectionTipo}': its matrix_table node '${row.tipo}' has no machine name (missing or collision — see the ontology inspect defects); refusing to fall back to another table`,
		coordinates: { tipo: sectionTipo, matrix_table: row.tipo, reason: 'machine_name_unresolved' },
	});
}

/**
 * A component's OWN SECTION: the first ancestor of model 'section' on the
 * dd_ontology parent chain (the node's ontology position — e.g. oh28 → oh1,
 * numisdata1478 → numisdata276). Null when the chain never reaches a section
 * (orphan/partial ontology). NOTE this is the REAL ontology position; a
 * VIRTUAL section is never on a parent chain (virtual sections point at their
 * real section through relations[0].tipo — see getSectionRealTipo in
 * resolve/security_access_datalist.ts for that half). Cached; hub-cleared on
 * any dd_ontology write. Consumer: observer host-section resolution
 * (section/record/observer_subscriptions.ts step 3).
 */
const ancestorSectionCache = createOntologyCache<string, string | null>();

export async function getAncestorSectionTipo(tipo: string): Promise<string | null> {
	const cached = ancestorSectionCache.get(tipo);
	if (cached !== undefined) return cached;
	const rows = (await sql`
		WITH RECURSIVE up AS (
			SELECT tipo, parent, model, 0 AS depth FROM dd_ontology WHERE tipo = ${tipo}
			UNION ALL
			SELECT d.tipo, d.parent, d.model, up.depth + 1
			FROM dd_ontology d JOIN up ON d.tipo = up.parent
			WHERE up.model IS DISTINCT FROM 'section' AND up.depth < 24
		)
		SELECT tipo FROM up WHERE model = 'section' LIMIT 1
	`) as { tipo: string }[];
	const section = rows[0]?.tipo ?? null;
	cacheWrite(ancestorSectionCache, tipo, section);
	return section;
}

/**
 * Is `tipo` a node of SECTION `sectionTipo` — the honesty check on a client's
 * (section_tipo, tipo) pair, two independent strings the ontology must tie
 * together. Answered by the ontology's own ancestry walk
 * ({@link getAncestorSectionTipo}), virtual-aware: a virtual section borrows
 * its real section's children (a caller on `rsc170` legitimately names a
 * component defined under `rsc2`), and a virtual section is never on a parent
 * chain, so the DECLARED side is the one resolved ({@link getSectionRealTipo}).
 * A tipo whose chain reaches no section belongs to none. Consumers: the area
 * caller declaration (area/read.ts) and the subdatum read floor
 * (security/read_floor.ts).
 */
export async function tipoBelongsToSection(tipo: string, sectionTipo: string): Promise<boolean> {
	const ownSection = await getAncestorSectionTipo(tipo);
	if (ownSection === null) return false;
	if (ownSection === sectionTipo) return true;
	return (await getSectionRealTipo(sectionTipo)) === ownSection;
}

/** One entry of the section census (listSectionNodes). */
export interface SectionNodeEntry {
	tipo: string;
	/** Multilingual term object (raw dd_ontology.term). */
	term: Record<string, string> | null;
}

/**
 * SECTION CENSUS: every dd_ontology node of model 'section', with its raw
 * multilingual term. This is the discovery backbone (MCP dedalo_list_sections,
 * name→tipo resolution): callers filter it further (matrix-table resolution,
 * per-principal ACL) — the census itself is ontology-only and carries no
 * permission semantics. Cached; hub-cleared on any dd_ontology write.
 */
const sectionCensusCache = createOntologyCache<string, SectionNodeEntry[]>();

export async function listSectionNodes(): Promise<SectionNodeEntry[]> {
	const cached = sectionCensusCache.get('census');
	if (cached !== undefined) return cached;
	const rows = (await sql`
		SELECT tipo, term FROM dd_ontology WHERE model = 'section' ORDER BY tipo
	`) as { tipo: string; term: Record<string, string> | null }[];
	const census = rows.map((row) => ({ tipo: row.tipo, term: row.term }));
	cacheWrite(sectionCensusCache, 'census', census);
	return census;
}
