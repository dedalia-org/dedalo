/**
 * THE ONE BASE OWN-CONFIG RESOLVER — an element's OWN request_config, before
 * any caller injection (PHP `build_request_config` → `get_ar_request_config`
 * over `resolve_source_properties`).
 *
 * Until 2026-11-03 the engine built this three different ways, and they
 * disagreed:
 *   - relations/models/portal.ts (the section-read data path): the RAW node
 *     properties in mode 'edit' for edit cells, and a raw section_list map
 *     (section/list_definitions/section_list.ts) for list cells;
 *   - section/read.ts readComponentData (get_data): the alias-merged
 *     properties in mode 'edit';
 *   - resolve/structure_context.ts (the context): alias-aware, the REAL mode,
 *     the section Site-B swap.
 * The context's build was the most correct one (alias merge, real mode, the
 * list section_list swap, the rqo properties override), so it is THE build;
 * the other two now call this function (through relations/element_node.ts
 * resolveElement) and data and context resolve the same config.
 *
 * THE CHAIN, in order:
 *   1. override  — an rqo `source.properties` REPLACES the ontology properties
 *                  (PHP dd_core_api read :2305-2308 `set_properties` runs before
 *                  the build; tool component instances read this way);
 *   2. alias     — otherwise the alias-merged effective properties
 *                  (ontology/alias.ts getEffectivePropertiesByTipo; a plain
 *                  node's own properties for every non-alias);
 *   3. section_list swap — in list / list_thesaurus mode the section_list(_thesaurus)
 *                  child's properties stand in (PHP resolve_source_properties
 *                  "Site B": here for SECTION owners — a section with its own
 *                  source.request_config keeps it — and inside
 *                  buildRequestConfigForElement for component owners);
 *   4. real mode — built in the mode the element actually renders in (a
 *                  Time Machine cell is mode 'list', WC-2026-08-14).
 *
 * PURE OF REQUEST STATE except what the builders already read through ALS (the
 * section preset's user, a section owner's step-11 grant) — no module state.
 */

import type { ApiNotice } from '../../errors/schema.ts';
import { getModelByTipo, getNode } from '../../ontology/resolver.ts';
import { buildRequestConfigForElement, findSectionListChild } from './build.ts';
import type { ParsedRequestConfigItem } from './explicit.ts';

/** What the one resolver needs to know about the element. */
export interface OwnConfigRequest {
	readonly tipo: string;
	/** The section the element's config resolves against ('self' targets, fixed_filter owner). */
	readonly sectionTipo: string;
	/** The REAL render mode (list / edit / search / list_thesaurus …). */
	readonly mode: string;
	/** The element's model when the caller already resolved it (saves a lookup). */
	readonly model?: string | null;
	/** Request data lang (filter_by_list expansions). */
	readonly lang?: string;
	/** The owning record (a fixed_filter `component_data` needs it); absent = record-independent. */
	readonly sectionId?: number | string | null;
	/** An rqo `source.properties` override — REPLACES the ontology properties (step 1). */
	readonly propertiesOverride?: unknown;
	/**
	 * Where a refused level >= 2 'self' ddo reports its notice (self_depth.ts —
	 * the builder skips the ddo either way). Absent = one log line per map.
	 */
	readonly notices?: ApiNotice[];
}

/**
 * PHP resolve_source_properties (trait.request_config_utils.php:264-309 —
 * "Site B"): the properties the element's request_config/columns_map build
 * feeds from. For a SECTION in list / list_thesaurus mode, swap to the
 * section_list(_thesaurus) child's properties — UNLESS the section declares its
 * own source.request_config (then it keeps its own). All other cases use the
 * element's own properties. NOT the emitted properties/css — that is Site A
 * (structure_context.ts resolveEmittedPropertiesAndCss), which PHP resolves
 * independently.
 */
export async function resolveSourceProperties(
	tipo: string,
	mode: string,
	model: string,
	ownProperties: unknown,
): Promise<unknown> {
	if (!swapsToSectionList(mode, model, ownProperties)) return ownProperties;
	const listModel = mode === 'list_thesaurus' ? 'section_list_thesaurus' : 'section_list';
	// PLAIN direct-children lookup: the trait resolves via get_ar_children_of_this
	// (class.ontology_node.php:1586-88) — never resolve_virtual. The
	// virtual-aware findSectionChildByModel belongs to the LIST-DEFINITIONS
	// machinery (class.section.php:868 resolve_virtual=true), a different site.
	const childTipo = await findSectionListChild(tipo, listModel);
	const child = childTipo === null ? null : await getNode(childTipo);
	// Use the child's properties when found; else the section's own (PHP fallthrough).
	return child?.properties ?? ownProperties;
}

/**
 * Whether resolveSourceProperties swaps to the section_list child: a SECTION in
 * list / list_thesaurus mode WITHOUT its own source.request_config (PHP :274,
 * isset semantics: any non-null value keeps its own).
 */
function swapsToSectionList(mode: string, model: string, ownProperties: unknown): boolean {
	if (mode !== 'list' && mode !== 'list_thesaurus') return false;
	if (model !== 'section') return false;
	const ownConfig = (ownProperties as { source?: { request_config?: unknown } } | null)?.source
		?.request_config;
	return ownConfig === undefined || ownConfig === null;
}

/** Steps 1 + 2: the override, else the alias-merged effective properties. */
async function basePropertiesOf(request: OwnConfigRequest): Promise<unknown> {
	if (request.propertiesOverride !== undefined) return request.propertiesOverride;
	const { getEffectivePropertiesByTipo } = await import('../../ontology/alias.ts');
	return (await getEffectivePropertiesByTipo(request.tipo)) ?? null;
}

/**
 * The element's OWN request_config (module header: override → alias →
 * section_list swap → real mode). `[]` when the element declares and derives
 * none (a node with no config and no relation graph — PHP omits it too).
 */
export async function resolveOwnRequestConfig(
	request: OwnConfigRequest,
): Promise<ParsedRequestConfigItem[]> {
	const model = request.model ?? (await getModelByTipo(request.tipo)) ?? '';
	const sourceProperties = await resolveSourceProperties(
		request.tipo,
		request.mode,
		model,
		await basePropertiesOf(request),
	);
	return buildRequestConfigForElement(sourceProperties, {
		ownerTipo: request.tipo,
		ownerSectionTipo: request.sectionTipo,
		mode: request.mode,
		ownerIsSection: model === 'section',
		...(request.sectionId !== undefined ? { ownerSectionId: request.sectionId } : {}),
		...(request.lang !== undefined ? { lang: request.lang } : {}),
		...(request.notices !== undefined ? { notices: request.notices } : {}),
	});
}

/** Whether any request_config item of `properties` carries an sqo `fixed_filter`. */
function declaresFixedFilter(properties: unknown): boolean {
	const items = (properties as { source?: { request_config?: unknown } } | null)?.source
		?.request_config;
	if (!Array.isArray(items)) return false;
	return items.some(
		(item) =>
			item !== null &&
			typeof item === 'object' &&
			(item as { sqo?: { fixed_filter?: unknown } }).sqo?.fixed_filter !== undefined,
	);
}

/**
 * Whether the element's own config can differ PER RECORD — today exactly when
 * a config it resolves through declares an sqo `fixed_filter` (its
 * `component_data` entries read the owning record: explicit.ts
 * expandFixedFilter with ownerSectionId). Every other config is a pure
 * function of (tipo, section, mode), so ONE node serves every row of a read;
 * a record-dependent one gets a node per owning record (element_node.ts key).
 * Both the element's own properties and, in a list-like mode, its
 * section_list child's are consulted — either may be the one that builds.
 */
export async function ownConfigDependsOnRecord(request: OwnConfigRequest): Promise<boolean> {
	if (declaresFixedFilter(await basePropertiesOf(request))) return true;
	return declaresFixedFilter(await sectionListPropertiesOf(request));
}

/** The element's section_list(_thesaurus) child's properties in a list-like mode, else null. */
async function sectionListPropertiesOf(request: OwnConfigRequest): Promise<unknown> {
	if (request.mode !== 'list' && request.mode !== 'list_thesaurus') return null;
	const listModel = request.mode === 'list_thesaurus' ? 'section_list_thesaurus' : 'section_list';
	const childTipo = await findSectionListChild(request.tipo, listModel);
	if (childTipo === null) return null;
	return (await getNode(childTipo))?.properties ?? null;
}
