/**
 * request_config BUILD ENTRY (RELATIONS_SPEC.md §4) — the single place that
 * decides HOW an element's request_config resolves:
 *
 * 1. LIST/TM cells substitute the element's own properties with its
 *    section_list ontology child's (PHP resolve_source_properties): the
 *    child's explicit config when it has one, else the implicit graph walk
 *    over the child's relation nodes.
 * 2. Otherwise the branch is DATA-DRIVEN, never per-model (PHP
 *    common::get_ar_request_config, class.common.php:3502, mirrored by the
 *    pure concepts/request_config.ts selectRequestConfigStrategy): explicit
 *    iff properties.source.request_config exists, else the implicit fallback —
 *    component relation nodes for components, the full edit form tree for
 *    sections in edit mode.
 *
 * Explicit parsing lives in ./explicit.ts, the legacy graph walk in
 * ./implicit.ts. PHP oracle nomenclature: explicit ≡ v6, implicit ≡ v5.
 */

import { config as dedaloConfig } from '../../../config/config.ts';
import { selectRequestConfigStrategy } from '../../concepts/request_config.ts';
import { isInTransaction, sql } from '../../db/postgres.ts';
import { createOntologyCache } from '../../ontology/cache_factory.ts';
import { RETIRED_PROPERTY_KEYS } from '../../ontology/property_census.ts';
import { getModelByTipo, getNode } from '../../ontology/resolver.ts';
import { getSectionRealTipo } from '../../resolve/security_access_datalist.ts';
import {
	buildExplicitRequestConfig,
	extractSqoSectionTipos,
	type ParsedRequestConfigItem,
	type RequestConfigContext,
} from './explicit.ts';
import { buildImplicitComponentListConfig, buildImplicitSectionEditConfig } from './implicit.ts';
import { resolveTargetSourceFor } from './target_sources.ts';

/**
 * Find an element's list-definition child tipo (dd_ontology, PLAIN direct
 * children — the Site-B trait's lookup is get_ar_children_of_this, never
 * resolve_virtual; class.ontology_node.php:1586-88). FIRST by order_number —
 * PHP takes $ar_terms[0] of a children list ordered `order_number asc`
 * (class.ontology_node.php:1250-1253), and multi-child parents exist
 * (tch546×4, oh123×2, tch20×2), so the ordering is load-bearing.
 */
const sectionListChildCache = createOntologyCache<string, string | null>();

/**
 * CACHED, because this runs once PER LIST ELEMENT: a single list read asked it
 * 24 times (audit PERF-12), each time a raw dd_ontology SELECT for an answer
 * that is pure ontology — no principal, no language, no record. The cache comes
 * from `createOntologyCache`, so ANY dd_ontology write clears it through the
 * invalidation hub; nothing here has to remember to invalidate.
 */
export async function findSectionListChild(
	ownerTipo: string,
	model = 'section_list',
): Promise<string | null> {
	const cacheKey = `${ownerTipo}|${model}`;
	const cached = sectionListChildCache.get(cacheKey);
	if (cached !== undefined) return cached;
	const rows = (await sql`
		SELECT tipo FROM dd_ontology WHERE parent = ${ownerTipo} AND model = ${model}
		ORDER BY order_number ASC LIMIT 1
	`) as { tipo: string }[];
	const found = rows[0]?.tipo ?? null;
	// Not written from inside a transaction: an uncommitted ontology write must
	// not be able to publish its answer process-wide (the resolver's own
	// cacheWrite rule).
	if (!isInTransaction()) sectionListChildCache.set(cacheKey, found);
	return found;
}

/**
 * Resolve an element's request_config with the PHP source-property rules:
 * in LIST/TM/LIST_THESAURUS mode the section_list(_thesaurus) child's
 * properties replace the element's own (PHP resolve_source_properties
 * :264-309) — UNLESS the owner is a SECTION with a direct
 * source.request_config (:274, keeps its own). When the child's properties
 * are absent, the implicit fallback derives the map from its relation_nodes.
 *
 * STAGE-2 user PRESET override (PHP build_request_config → resolve_preset_properties,
 * class.common.php:2986/3156): SECTION owners first look for an active dd1244
 * layout preset for this (tipo, section_tipo, mode) + user. When one matches,
 * its request_config is injected into a CLONE of the element's properties (the
 * cached ontology properties are never mutated) so the section_list swap and
 * strategy selection below run over the preset exactly as PHP's
 * resolve_source_properties runs over resolve_preset_properties' override.
 *
 * STAGE-3 MODEL-DEFAULT TARGET (2026-08-14): after either strategy built the
 * config, a component model's declared `targetSource` fills an sqo that
 * resolved NO target section — see THE MODEL-DEFAULT TARGET SEAM comment in
 * the body. Declared targets always win; the default only fills silence.
 */
export async function buildRequestConfigForElement(
	ownProperties: unknown,
	context: RequestConfigContext,
): Promise<ParsedRequestConfigItem[]> {
	// Retired-grammar checkpoint: the OWNER node's own properties are in hand
	// here (before the preset clone and the section_list swap), so this is the
	// one place a node still carrying properties.target_mode gets its loud line.
	reportRetiredTargetMode(ownProperties, context.ownerTipo);

	// ================== THE MODEL-DEFAULT TARGET SEAM ==================
	// The owner COMPONENT's model may declare a default target source (the
	// descriptor facet `targetSource`, ./target_sources.ts —
	// component_relation_model declares 'section_model': the caller section's
	// terms→model twin via ontology/model_section.ts). It is resolved ONCE here,
	// BEFORE either strategy runs, and threaded in as context.modelDefaultTargets
	// so each builder can apply it at the moment it computes its targets.
	//
	// WHY HERE and not inside buildExplicitRequestConfig:
	// component_relation_model is absent from EXPLICIT_CONFIG_REQUIRED_MODELS
	// (concepts/request_config.ts:73-77), so a node with NO source.request_config
	// takes the IMPLICIT branch (buildImplicitComponentListConfig), which walks
	// node.relations and picks the first section-model entry — for hierarchy27's
	// relation graph that is hierarchy20, the raw 69,148-row thesaurus template:
	// plausible, silent and wrong. Only this function sees BOTH branches.
	//
	// WHY THREADED rather than stamped onto the finished config: `targetTipos` is
	// also what `section_tipo: 'self'` resolves to in the show/search/choose/hide
	// ddo maps. Stamping the sqo afterwards would leave hierarchy27 in es1
	// emitting "read hierarchy25 on es1" while its options came from es2.
	//
	// PRECEDENCE (a deliberate divergence from PHP, which bypassed the sqo
	// entirely for this model — v6 class.component_relation_model.php:115-177 —
	// and kept the answer in a private field re-derived per consumer): a DECLARED
	// sqo target wins; the default fills silence. The implicit walk's pick is not
	// a declaration (see implicit.ts), so the default beats it.
	//
	// This is the ONE seam every consumer reads: datalist.ts:236
	// (resolveDatalistSources → edit options + list labels),
	// structure_context.ts:1009+1302 (target_sections),
	// getElementTargetSectionTipos below (:158) — and through it
	// import_conform.ts:821, section_elements_context.ts:258 and
	// relation_index.ts:84 — and ai/mcp/tools/discovery.ts:245.
	//
	// When the source itself resolves nothing, the resolver has already reported
	// its own degradation (CONVENTIONS §1 — model_section.ts warns naming every
	// rejected candidate): NO second warn here, the build keeps the pre-existing
	// empty-target behaviour rather than guessing.
	// An EMPTY result is still an answer and is threaded in as such: a model that
	// OWNS its target and cannot resolve one here must end with NO target, not
	// fall through to a rule it was introduced to replace (see the null-vs-[]
	// contract on resolveTargetSourceFor).
	const buildContext = await withModelDefaultTargets(context);
	const config = await buildStrategyRequestConfig(ownProperties, buildContext);
	// Default page size (PHP calculate_default_limit, component+edit): the client
	// paginator reads sqo.limit ?? show.sqo_config.limit; with neither it pages by
	// 0 → one page → no paginator. Fills silence only; a declared limit wins.
	if (context.mode === 'edit' && !context.ownerIsSection) {
		for (const item of config) {
			const declared =
				item.sqo.limit ??
				(item.show as { sqo_config?: { limit?: unknown } } | null)?.sqo_config?.limit;
			if (typeof declared !== 'number') item.sqo.limit = dedaloConfig.features.maxRowsPerPage;
		}
	}
	return config;
}

/**
 * Attach the owner MODEL's default target sections to the build context, when
 * its descriptor declares a `targetSource` facet (./target_sources.ts).
 * Returns the context unchanged for every model that declares none — the vast
 * majority — so nothing else in the pipeline changes shape.
 *
 * Sections are skipped: `targetSource` is a COMPONENT-model facet, and a
 * section IS its own target.
 */
async function withModelDefaultTargets(
	context: RequestConfigContext,
): Promise<RequestConfigContext> {
	if (context.ownerIsSection) return context;
	const ownerModel = await getModelByTipo(context.ownerTipo);
	if (ownerModel === null) return context;
	const defaultTargets = await resolveTargetSourceFor(ownerModel, context.ownerSectionTipo);
	if (defaultTargets === null) return context;
	return { ...context, modelDefaultTargets: defaultTargets };
}

/**
 * RETIRED GRAMMAR TRIPLINE — properties.target_mode / properties.target_values
 * (PHP component_relation_model 'free' mode, v6
 * class.component_relation_model.php:115-177) are NOT ported: they were a
 * second grammar for a fact the sqo already states —
 * `{"source":"section","value":[...]}` says "options come from section X" in
 * the vocabulary every other component uses. A node still carrying the old
 * keys gets ONE loud line per build naming the node and the exact replacement
 * sqo (CONVENTIONS §1: degraded, reported, defined), then resolves by the
 * ordinary rule — an install that missed the ontology migration sees a
 * greppable error, never silently different options.
 *
 * ONE LAW, ONE HOME (DEAD-08 / P2-27): the fact that this key is retired, and
 * WHAT replaces it, are read from `ontology/property_census.ts` — the same
 * registry the resolver tripline and the install report use. This site adds
 * what that registry cannot know: the node's OWN target_values, spelled as the
 * sqo entry the author should paste. Its `reportedAtUse` mark is what keeps
 * the generic tripline quiet here.
 */
function reportRetiredTargetMode(ownProperties: unknown, ownerTipo: string): void {
	const properties = ownProperties as
		| { target_mode?: unknown; target_values?: unknown }
		| null
		| undefined;
	const targetMode = properties?.target_mode;
	if (targetMode === undefined || targetMode === null) return;
	const targetValues = Array.isArray(properties?.target_values) ? properties.target_values : [];
	const retired = RETIRED_PROPERTY_KEYS.target_mode;
	console.error(
		`[request_config/build] node '${ownerTipo}' carries RETIRED properties.target_mode ` +
			`('${String(targetMode)}') — read by nothing. ${retired?.reason ?? ''} ` +
			`Replace it with ${retired?.replacement ?? 'an explicit sqo section_tipo entry'}, here ` +
			`{"source":"section","value":${JSON.stringify(targetValues)}}. ` +
			'Resolving by the ordinary rule.',
	);
}

/**
 * The strategy core of {@link buildRequestConfigForElement} — the PHP
 * source-property pipeline exactly as documented on the wrapper above, WITHOUT
 * the model-default target seam (which must see this function's result).
 */
async function buildStrategyRequestConfig(
	ownProperties: unknown,
	context: RequestConfigContext,
): Promise<ParsedRequestConfigItem[]> {
	// STAGE 2 preset: section owners only (PHP resolve_preset_properties gates on
	// get_called_class()==='section'). tipo === section_tipo for a section, so
	// both feed the match. The current user is read live inside the resolver.
	// `sourceProperties` is the element's own properties UNLESS an active preset
	// injects its request_config onto a clone (never the shared/cached original).
	let sourceProperties = ownProperties;
	if (context.ownerIsSection) {
		const { resolvePresetRequestConfig } = await import('./presets.ts');
		const preset = await resolvePresetRequestConfig(
			context.ownerTipo,
			context.ownerSectionTipo,
			context.mode,
		);
		if (preset !== null) {
			// Inject the override onto a fresh clone — never touch the shared/cached
			// ontology properties (PHP builds the override on a json round-trip clone).
			const base = (ownProperties ?? {}) as Record<string, unknown>;
			const clonedSource = { ...((base.source as Record<string, unknown>) ?? {}) };
			clonedSource.request_config = preset;
			sourceProperties = { ...base, source: clonedSource };
		}
	}

	const listLikeMode = context.mode === 'list' || context.mode === 'list_thesaurus';
	// PHP :274 — a SECTION with a DIRECT source.request_config skips the
	// section_list swap (isset semantics: any non-null value).
	const ownConfig = (sourceProperties as { source?: { request_config?: unknown } } | null)?.source
		?.request_config;
	const sectionKeepsOwn = context.ownerIsSection && ownConfig !== undefined && ownConfig !== null;
	if (listLikeMode && !sectionKeepsOwn) {
		const listModel = context.mode === 'list_thesaurus' ? 'section_list_thesaurus' : 'section_list';
		let sectionListTipo = await findSectionListChild(context.ownerTipo, listModel);
		// VIRTUAL SECTION fallback (PHP resolve_ar_related_list_section step 2,
		// trait.request_config_v5.php): a virtual section with NO section_list
		// child of its own inherits its REAL section's — resolve the real tipo
		// (section::get_section_real_tipo_static) and retry there. Load-bearing
		// for hierarchy/thesaurus-instance sections (es1 → hierarchy20 →
		// section_list hierarchy37 → 11 columns), which have zero ontology
		// children; without it their list view emits an empty ddo_map (only the
		// built-in Id column renders). Section-only: components resolve virtual
		// through their own relation graph, not this alias hop.
		if (sectionListTipo === null && context.ownerIsSection) {
			const realTipo = await getSectionRealTipo(context.ownerTipo);
			if (realTipo !== context.ownerTipo) {
				sectionListTipo = await findSectionListChild(realTipo, listModel);
			}
		}
		if (sectionListTipo !== null) {
			const childNode = await getNode(sectionListTipo);
			const childProperties = childNode?.properties ?? null;
			if (selectRequestConfigStrategy(childProperties) === 'explicit') {
				return buildExplicitRequestConfig(childProperties, context);
			}
			// NULL / config-less child properties → implicit from its relation_nodes.
			return buildImplicitComponentListConfig(sectionListTipo, context);
		}
	}
	if (selectRequestConfigStrategy(sourceProperties) === 'explicit') {
		return buildExplicitRequestConfig(sourceProperties, context);
	}
	// No explicit config anywhere: implicit from the COMPONENT's own
	// relation_nodes (the classic select/radio/check_box target definition —
	// e.g. [dd501, dd503]).
	if (!context.ownerIsSection) {
		return buildImplicitComponentListConfig(context.ownerTipo, context);
	}
	// SECTION in EDIT mode without explicit config: the FULL form tree (PHP
	// resolve_ar_related_edit 'section' case) — every component/grouper child.
	if (context.mode === 'edit') {
		return buildImplicitSectionEditConfig(context);
	}
	return [];
}

/**
 * The element's target section tipos (PHP get_ar_target_section_tipo): the
 * section_tipo targets of the resolved request_config sqo — deduped WITHIN each
 * config (extractSqoSectionTipos, PHP array_unique) but CONCATENATED across
 * configs (PHP get_ar_target_section_ddo spreads per-config lists without
 * dedup, class.component_common.php:3070-77 — a multi-config element repeats
 * its shared targets). Defaults to SEARCH mode: PHP get_section_elements_context
 * instantiates each element in mode 'search' (class.common.php:3915-22), NOT
 * 'list' — list mode applies the section_list source substitution and resolves
 * a DIFFERENT config (oh27: list→rsc205 vs search→rsc332 = PHP). Empty when
 * the element declares no sqo target.
 */
export async function getElementTargetSectionTipos(
	tipo: string,
	sectionTipo: string,
	mode = 'search',
): Promise<string[]> {
	const node = await getNode(tipo);
	const requestConfig = await buildRequestConfigForElement(node?.properties ?? null, {
		ownerTipo: tipo,
		ownerSectionTipo: sectionTipo,
		mode,
		ownerIsSection: false,
	});
	const targetTipos: string[] = [];
	for (const item of requestConfig) {
		targetTipos.push(...extractSqoSectionTipos(item));
	}
	return targetTipos;
}

/**
 * The element's base columns_map (PHP common::get_columns_map): in LIST/TM
 * mode the section_list child's properties.source.columns_map (falling back to
 * the element's own when no section_list exists); otherwise the element's own.
 * Null when no columns_map is declared anywhere — the client then derives the
 * grid columns from the request_config show ddo_map in JS.
 */
export async function getElementColumnsMap(
	ownerTipo: string,
	ownProperties: unknown,
	mode: string,
): Promise<unknown[] | null> {
	let properties = ownProperties as { source?: { columns_map?: unknown[] } } | null;
	if (mode === 'list') {
		const sectionListTipo = await findSectionListChild(ownerTipo);
		if (sectionListTipo !== null) {
			const node = await getNode(sectionListTipo);
			properties = node?.properties as typeof properties;
		}
	}
	return properties?.source?.columns_map ?? null;
}
