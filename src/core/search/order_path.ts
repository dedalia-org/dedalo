/**
 * ORDER PATH builder — the per-column sort descriptor the client turns into an
 * `sqo.order` on a list-header click (SECTION_SPEC list-column sortability).
 *
 * PHP references (read-only oracle) — `get_order_path` is per-model:
 *   - component_common::get_order_path (class.component_common.php:4747) — the
 *     BASE: search::get_query_path (self + the first related component of a
 *     relation-capable model, ONE hop) + the portal-parent prepend.
 *   - component_portal::get_order_path (class.component_portal.php:365) — portal
 *     & component_dataframe (extends portal) & autocomplete/_hi (alias→portal):
 *     self + the RESOLVED request_config's first show.ddo_map item (the portal's
 *     main list column), not the raw ontology relations.
 *   - component_relation_related::get_order_path (:489) — self + hierarchy25 in
 *     the SAME section.
 *   - component_filter/_master::get_order_path (:896) — self + dd156@dd153.
 *   - component_select_lang::get_order_path (:231) — self + hierarchy25@lg1.
 *   - component_section_id::get_order_path (:239) — base + path[0].column.
 *   - the from_section_tipo prepend (portal :378 / base :4768) is applied
 *     uniformly here.
 *
 * Step shape mirrors PHP's stdClass steps {name, model, section_tipo,
 * component_tipo, column?}. The SEARCH engine (sql_assembler buildOrderClauses)
 * reads only `component_tipo` (→ model → jsonb column) and, for multi-hop paths,
 * `section_tipo` per step (buildJoinChain); `name` is client-cosmetic. TM-only
 * `column` overrides (date/number/portal user_id) are out of scope — the TM
 * list is served by read_tm.ts, not this generic path.
 */

import { ACTIVITY_SECTION_TIPO, ACTIVITY_WHEN_TIPO } from '../concepts/section.ts';
import { termByTipo } from '../ontology/labels.ts';
import { getModelByTipo, getNode } from '../ontology/resolver.ts';
// strip_tags (PHP get_query_path names the step with a tag-stripped term).
import { stripTags } from '../resolve/html_text.ts';
import { currentDataLang } from '../resolve/request_lang.ts';

/**
 * The caller-resolved request_config shape the portal sort-leaf reads (the
 * structural subset of ParsedRequestConfigItem this module consumes).
 */
export type OrderPathResolvedConfig = {
	api_engine?: string;
	show?: { ddo_map?: unknown[] } | null;
}[];

/** One ORDER-BY path step (PHP get_query_path stdClass). */
export interface OrderPathStep {
	name: string;
	model: string | null;
	section_tipo: string;
	component_tipo: string;
	/** Literal matrix column override (PHP $path[0]->column — section_id case). */
	column?: string;
}

/** PHP DEDALO_SECTION_PROJECTS_TIPO / DEDALO_PROJECTS_NAME_TIPO (dd_tipos.php:75-76). */
const SECTION_PROJECTS_TIPO = 'dd153';
const PROJECTS_NAME_TIPO = 'dd156';
/** PHP DEDALO_THESAURUS_TERM_TIPO / DEDALO_LANGS_SECTION_TIPO (dd_tipos.php:158,249). */
const THESAURUS_TERM_TIPO = 'hierarchy25';
const LANGS_SECTION_TIPO = 'lg1';

/**
 * Models whose get_order_path is the PORTAL override (request_config first ddo):
 * component_portal + component_dataframe (extends portal). autocomplete/_hi
 * resolve to component_portal via getModelByTipo (descriptor alias), so they
 * arrive here as 'component_portal'.
 */
const PORTAL_ORDER_MODELS: ReadonlySet<string> = new Set([
	'component_portal',
	'component_dataframe',
]);

/**
 * PHP component_relation_common::get_components_with_relations() — the models
 * whose ontology relation graph the BASE get_query_path recurses into. Pinned to
 * the oracle list (descriptor_completeness_tripwire's PHP_COMPONENTS_WITH_RELATIONS).
 * Only used by the base path (non-portal relation models: select/check_box/
 * radio_button/publication/relation_parent/model/children/index/inverse).
 */
const RELATION_MODELS: ReadonlySet<string> = new Set([
	'component_autocomplete',
	'component_autocomplete_hi',
	'component_check_box',
	'component_dataframe',
	'component_filter',
	'component_filter_master',
	'component_inverse',
	'component_portal',
	'component_publication',
	'component_radio_button',
	'component_relation_children',
	'component_relation_index',
	'component_relation_model',
	'component_relation_parent',
	'component_relation_related',
	'component_relation_struct',
	'component_select',
	'component_select_lang',
]);

async function stepFor(componentTipo: string, sectionTipo: string): Promise<OrderPathStep> {
	return {
		name: stripTags(await termByTipo(componentTipo, currentDataLang())),
		model: await getModelByTipo(componentTipo),
		section_tipo: sectionTipo,
		component_tipo: componentTipo,
	};
}

/**
 * PHP search::get_query_path (trait.utils.php:304): self + (for a relation-capable
 * model) the FIRST related component of the FIRST related SECTION, as a LEAF
 * (resolveRelated=false — verified vs the oracle: a portal-of-a-portal stops at
 * the middle portal, [77,164] not [77,164,rsc29]).
 */
async function buildQueryPath(
	componentTipo: string,
	sectionTipo: string,
	resolveRelated = true,
): Promise<OrderPathStep[]> {
	const model = await getModelByTipo(componentTipo);
	const path: OrderPathStep[] = [await stepFor(componentTipo, sectionTipo)];
	if (!resolveRelated || model === null || !RELATION_MODELS.has(model)) return path;

	// The node's relation graph carries the target section (first 'section'-model
	// link — common::get_ar_related_by_model) + the target components (the rest).
	// component_alias (WC-020): alias nodes carry no relations — walk the TARGET's.
	const { resolveDataTipo } = await import('../ontology/alias.ts');
	const node = await getNode(await resolveDataTipo(componentTipo));
	const relations = (Array.isArray(node?.relations) ? node.relations : []) as { tipo?: unknown }[];
	let relatedSection: string | null = null;
	const relatedTipos: string[] = [];
	for (const link of relations) {
		if (typeof link.tipo !== 'string') continue;
		if ((await getModelByTipo(link.tipo)) === 'section') {
			if (relatedSection === null) relatedSection = link.tipo;
			continue;
		}
		relatedTipos.push(link.tipo);
	}
	if (relatedSection === null) return path;

	for (const currentTipo of relatedTipos) {
		const currentModel = await getModelByTipo(currentTipo);
		if (currentModel === null || !currentModel.startsWith('component')) continue;
		path.push(...(await buildQueryPath(currentTipo, relatedSection, false)));
		break; // "Avoid multiple components in path !" (PHP :351)
	}
	return path;
}

/**
 * PHP component_portal::get_order_path (:365): self + the RESOLVED request_config's
 * first show.ddo_map item (the portal's main list column). Verified vs the oracle:
 * oh17→rsc29, oh24→rsc85, numisdata30→numisdata16, numisdata1448 (dataframe)→rsc1246.
 *
 * `resolvedConfig` is the element's STAMPED request_config when the caller (the
 * structure-context stamp) already built it — the get_subdatum-injected instance
 * config PHP consumes (:404), which carries the caller-children NARROWING (a
 * section_list may re-declare a portal's subcolumns: oh1's oh7 narrows oh25 to
 * [rsc62, rsc63, rsc35], so the sort leaf is rsc62, not the portal's own
 * ontology ddo_map[0] rsc20). The self-build fallback serves config-less callers.
 */
async function buildPortalOrderPath(
	componentTipo: string,
	sectionTipo: string,
	resolvedConfig?: OrderPathResolvedConfig,
): Promise<OrderPathStep[]> {
	const path: OrderPathStep[] = [await stepFor(componentTipo, sectionTipo)];
	let config = resolvedConfig;
	if (config === undefined) {
		// component_alias (WC-020): the merged effective config drives the path.
		const { getEffectivePropertiesByTipo } = await import('../ontology/alias.ts');
		const { buildRequestConfigForElement } = await import('../relations/request_config/build.ts');
		config = await buildRequestConfigForElement(
			(await getEffectivePropertiesByTipo(componentTipo)) ?? null,
			{
				ownerTipo: componentTipo,
				ownerSectionTipo: sectionTipo,
				mode: 'list',
				ownerIsSection: false,
			},
		);
	}
	// PHP array_find api_engine==='dedalo' (:405-418). The narrowing now goes
	// through the shared selector: an ORDER path over an external-only component
	// requires an adapter that can order at all — silently returning a one-step
	// path (what the old bare-first-item fallback did) sorts by the wrong column
	// and looks like it worked.
	const { selectConfigItemForConcern } = await import(
		'../relations/request_config/engine_select.ts'
	);
	const item = await selectConfigItemForConcern(config, 'ordering', 'search/order_path.pathFor');
	const firstDdo = (item?.show?.ddo_map ?? [])[0] as
		| { tipo?: string; section_tipo?: unknown }
		| undefined;
	if (typeof firstDdo?.tipo === 'string') {
		const rawSection = firstDdo.section_tipo;
		const ddoSection = Array.isArray(rawSection)
			? (rawSection[0] as string | undefined)
			: (rawSection as string | undefined);
		path.push(await stepFor(firstDdo.tipo, ddoSection ?? sectionTipo));
	}
	return path;
}

/**
 * PHP component_common::get_order_path (and the per-model overrides). `from` (PHP
 * from_component_tipo/from_section_tipo) is set for a SUBDATUM ddo (a component
 * surfaced inside a portal cell): its parent-portal step is prepended so the sort
 * join chain starts at the section being listed.
 */
export async function buildOrderPath(
	componentTipo: string,
	sectionTipo: string,
	from?: { componentTipo: string; sectionTipo: string },
	resolvedConfig?: OrderPathResolvedConfig,
): Promise<OrderPathStep[]> {
	// Activity "When" (WC-044): matrix_activity is append-only, so When-order
	// ≡ section_id order. Emit the direct-column shortcut instead of the
	// component step — the assembler orders by an indexed structural column,
	// never the dd547 date jsonpath (a full-table sort at production scale).
	// (WC-054: the assembler then re-expresses that structural order on the
	// ("timestamp", id) index, the only shape a When date FILTER can be served
	// with. The PATH stays section_id — it is the client-facing answer.)
	// name/model stay cosmetic (the client renders them in the header only).
	if (sectionTipo === ACTIVITY_SECTION_TIPO && componentTipo === ACTIVITY_WHEN_TIPO) {
		const step = await stepFor(componentTipo, sectionTipo);
		return [{ ...step, component_tipo: 'section_id' }];
	}
	const model = await getModelByTipo(componentTipo);

	let path: OrderPathStep[];
	if (model === 'component_filter' || model === 'component_filter_master') {
		// PHP component_filter::get_order_path (:896) — fixed [self, projects-name].
		path = [
			await stepFor(componentTipo, sectionTipo),
			await stepFor(PROJECTS_NAME_TIPO, SECTION_PROJECTS_TIPO),
		];
	} else if (model === 'component_select_lang') {
		// PHP component_select_lang::get_order_path (:231) — fixed [self, term@lg1].
		path = [
			await stepFor(componentTipo, sectionTipo),
			await stepFor(THESAURUS_TERM_TIPO, LANGS_SECTION_TIPO),
		];
	} else if (model === 'component_relation_related') {
		// PHP component_relation_related::get_order_path (:489) — [self, term@self-section].
		path = [
			await stepFor(componentTipo, sectionTipo),
			await stepFor(THESAURUS_TERM_TIPO, sectionTipo),
		];
	} else if (model !== null && PORTAL_ORDER_MODELS.has(model)) {
		path = await buildPortalOrderPath(componentTipo, sectionTipo, resolvedConfig);
	} else {
		path = await buildQueryPath(componentTipo, sectionTipo);
		// PHP component_section_id::get_order_path (:239) — the record's own id.
		if (model === 'component_section_id' && path[0] !== undefined) {
			path[0].column = 'section_id';
		}
	}

	// Portal-parent prepend (PHP get_order_path :4768 / portal :378): a subdatum
	// column's sort join must start from the LISTED section.
	if (from !== undefined && from.sectionTipo !== sectionTipo) {
		path.unshift(await stepFor(from.componentTipo, from.sectionTipo));
	}
	return path;
}
