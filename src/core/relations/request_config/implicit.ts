/**
 * request_config IMPLICIT — the LEGACY builder (RELATIONS_SPEC.md §4):
 * no explicit config on the ontology node; targets and child ddos derive
 * from the ontology relation graph. Deprecated for new ontologies but
 * load-bearing for classic simple relations (select/radio/check_box target
 * definitions like numisdata967 → dd501, numisdata1562 → numisdata1554, and
 * legacy `source` objects without request_config like numisdata55).
 * PHP oracle nomenclature: implicit ≡ v5, explicit ≡ v6.
 *
 * PHP reference: trait.request_config_v5.php —
 *   build_request_config_v5 :78 (pipeline), resolve_ar_related :186,
 *   resolve_ar_related_edit :232, resolve_ar_related_list_component :441,
 *   clean_and_extract_related :508, build_legacy_ddo_map :618.
 *
 * Faithful rules ported here:
 * - component_relation_parent/children are NOT resolvable implicitly — throw
 *   (PHP :88; their nodes must carry explicit config);
 * - the first 'section'-model relation node becomes the TARGET SECTION and
 *   is stripped from the ddo list (clean_and_extract_related);
 * - 'exclude_elements' marker nodes and the deprecated dd249 security
 *   component are skipped (clean_and_extract_related :531-538);
 * - component_filter always targets the projects section (PHP :261-264);
 * - when a section_list's relation nodes contain NO section, the component's
 *   main 'related' section is used (resolve_ar_related_list_component :454-473)
 *   — exposed as getMainRelatedSectionTipo for the list-cell path too;
 * - non-section callers force ddo mode 'list' (PHP :117);
 * - every ddo's VIEW is the CALLER's own properties.children_view, else the
 *   child's own properties.view, else the model default (resolve_view); null
 *   omits the key (build_request_config_v5 :119-121 + build_legacy_ddo_map
 *   :633-639 — implicitDdoView). "Caller's own" = context.ownerChildrenView:
 *   an rqo properties override counts, the list-mode section_list swap does
 *   NOT. The relation-family LEGACY children_view default (get_children_view
 *   'text') is not applied here — PHP reads properties only (T1-30).
 *
 * The per-user permissions filter (PHP STEP 5 filter_authorized_related)
 * LANDED 2026-07-10 — filterAuthorizedRelated below, applied to all three
 * builder paths (component list, projects/filter, section edit).
 * Ledgered (deny/no-op loudly, never silently): grouper direct-children
 * resolution (groupers build their context through structure_context, not
 * this path).
 */

import { EXPLICIT_CONFIG_REQUIRED_MODELS } from '../../concepts/request_config.ts';
import { sql } from '../../db/postgres.ts';
import { DedaloError } from '../../errors/dedalo_error.ts';
import { LABEL_NODE_MODEL } from '../../ontology/label_node_guard.ts';
import {
	getChildTipoModels,
	getModelByTipo,
	getNode,
	relatedTipoByExactModel,
} from '../../ontology/resolver.ts';
import { resolveVirtualEditScope } from '../../ontology/virtual_scope.ts';
import { contextLabelOf, resolveDefaultView } from '../../resolve/structure_context.ts';
import {
	buildSqoSectionTipoDdos,
	type ParsedRequestConfigItem,
	type ProcessedDdo,
	type RequestConfigContext,
} from './explicit.ts';

/** PHP DEDALO_SECTION_PROJECTS_TIPO — the projects section every component_filter targets. */
const SECTION_PROJECTS_TIPO = 'dd153';
/** PHP DEDALO_PROJECTS_NAME_TIPO (dd_tipos.php:76) — the project name component (input_text). */
const PROJECTS_NAME_TIPO = 'dd156';
/** PHP DEDALO_COMPONENT_SECURITY_AREAS_PROFILES_TIPO — deprecated, always skipped. */
const DEPRECATED_SECURITY_AREAS_TIPO = 'dd249';

/**
 * DEAD legacy component models (PHP common::$ar_temp_exclude_models,
 * class.common.php:438-448): removed in v6 but still present in v5-era
 * ontologies (e.g. dd249 component_security_areas under the profiles section).
 * They have NO implementation on either side — emitting a ddo for one makes the
 * client try to import client/dedalo/core/<model>/js/<model>.js and 404.
 * PHP's list also names the models TS keeps ALIVE as registry aliases
 * (component_input_text_large / component_security_tools / component_state /
 * component_relation_struct — getModelByTipo already resolves those to their
 * live target), so only the genuinely dead names are listed here.
 */
const DEAD_LEGACY_MODELS: ReadonlySet<string> = new Set([
	'component_security_areas',
	'component_autocomplete_ts',
	'component_html_file',
	'component_ip',
	'component_layout',
	'component_score',
]);

/**
 * PHP filter_authorized_related (trait.request_config_v5.php:574-86, applied
 * as build_request_config_v5 STEP 5 :123-27): only components the actor holds
 * level ≥ 1 on — checked against the resolved TARGET section — survive the
 * implicit map. The principal is read from the request-context ALS at CALL
 * TIME (never module-hoisted); absent principal (internal resolutions,
 * harnesses) = no filter. Admin-flagged users go through the matrix like PHP
 * (no bypass); the superuser passes via getPermissions' own short-circuit.
 *
 * THE ONE PREDICATE (T0-1 / S03, 2026-11-09): the decision is
 * frontier_scope.ts `frontierAllowedComponents` — the same key the export walk
 * asks of the same child set, with the frontier's SECTION-TIPO exemption arm
 * only (no `table` is passed, so the shared-table arm — matrix_list,
 * matrix_hierarchy… — does not widen it; doing so is a lead decision, like
 * Gate B's). Effect: a non-admin's component_filter now shows the project
 * name, dd153.dd156 (WC-2026-11-09-implicit-children-frontier-predicate). Before, this asked bare
 * `ddoIsAuthorized` and the export asked nothing at all.
 */
export async function filterAuthorizedRelated(
	componentTipos: string[],
	targetSectionTipo: string,
): Promise<Set<string>> {
	const { currentPrincipal } = await import('../../security/request_context.ts');
	const principal = currentPrincipal();
	if (principal === undefined) return new Set(componentTipos);
	const { frontierAllowedComponents } = await import('../../security/frontier_scope.ts');
	// A RENDER decision: the map is narrowed, nothing is noted — the widget shows
	// the user what they may read, as PHP did (the `surface` names only the log
	// channel, which this caller never writes to).
	return frontierAllowedComponents(
		{ principal, surface: 'door', door: 'request_config.implicit' },
		targetSectionTipo,
		componentTipos,
	);
}

/**
 * A properties object's string `children_view`, else null (a non-string value
 * counts as absent — the same rule structure_context applies to the
 * context-level children_view).
 */
export function childrenViewOf(properties: unknown): string | null {
	const value = (properties as { children_view?: unknown } | null | undefined)?.children_view;
	return typeof value === 'string' ? value : null;
}

/**
 * The view of ONE implicit ddo (PHP build_legacy_ddo_map :633-639): the
 * caller's children_view, else the child's own string properties.view, else
 * the model default (resolve_view — the stored legacy model decides:
 * autocomplete→line, portal→default …). Null = the key is omitted.
 */
async function implicitDdoView(
	tipo: string,
	model: string,
	childrenView: string | null,
): Promise<string | null> {
	if (childrenView !== null) return childrenView;
	const node = await getNode(tipo);
	const ownView = (node?.properties as { view?: unknown } | null | undefined)?.view;
	if (typeof ownView === 'string') return ownView;
	const legacyModel = node !== null && node.model !== model ? node.model : null;
	return resolveDefaultView(model, legacyModel);
}

/** Stamp the implicit view on `ddo` when one resolves (PHP null → no key). */
async function withImplicitView(
	ddo: ProcessedDdo,
	context: RequestConfigContext,
): Promise<ProcessedDdo> {
	const view = await implicitDdoView(ddo.tipo, ddo.model, context.ownerChildrenView ?? null);
	if (view !== null) ddo.view = view;
	return ddo;
}

/**
 * The component's MAIN related section (PHP get_ar_tipo_by_model_and_relation
 * (tipo, 'section', 'related')): the first relation node whose model is
 * 'section'. Used when a section_list's relation nodes omit the target
 * section (PHP resolve_ar_related_list_component :454-473).
 */
export async function getMainRelatedSectionTipo(componentTipo: string): Promise<string | null> {
	// Answered from the resolver's cached node + its own (tipo|model) cache
	// instead of a raw dd_ontology SELECT per list element — measured 8 times in
	// ONE read (audit PERF-12). EXACT-model, never relatedTipoByModel: that one
	// substring-matches, so 'section' would also answer 'section_list'.
	return await relatedTipoByExactModel(componentTipo, 'section');
}

/**
 * MODEL DEFAULT BEATS THE WALK'S PICK (2026-08-14).
 *
 * The section node the relations walk finds is the component's *belongs-to*
 * ontology link, not a statement about where its options come from — for a
 * component_relation_model like hierarchy27 (relations [hierarchy20,
 * hierarchy25]) it resolves to hierarchy20, the raw 69,148-row thesaurus
 * TEMPLATE: plausible, silent and wrong. A model whose descriptor declares a
 * `targetSource` therefore overrides it (context.modelDefaultTargets, resolved
 * once in ./build.ts). This is NOT the "declared sqo wins" case — an implicit
 * config is precisely the node that declared nothing.
 *
 * An EMPTY default is still the model's answer: the walk's pick is DISCARDED,
 * never kept as a fallback. Keeping it would resurrect the exact hole this
 * closes — a config-less relation_model in a section with no resolvable twin
 * (`ich145`: no registry row, and the tld fallback `ich2` is a section_group)
 * would silently enumerate hierarchy20. The resolver has already warned;
 * carrying no target is the honest end state.
 *
 * Section owners are excluded: a section is its own target and carries no
 * component-model facet.
 */
function applyModelDefaultTarget(
	walkPick: string | null,
	context: RequestConfigContext,
): string | null {
	if (context.ownerIsSection || context.modelDefaultTargets === undefined) return walkPick;
	return context.modelDefaultTargets[0] ?? null;
}

/** Section_list relations that never become a column (marker + inert label nodes). */
const NEVER_A_COLUMN_MODELS: ReadonlySet<string | null> = new Set([
	'exclude_elements',
	LABEL_NODE_MODEL,
]);

/** One map entry of an implicit relation walk (principal-free). */
export interface ImplicitRelationLink {
	tipo: string;
	model: string;
	/** The target section found BEFORE this node (null until one appears). */
	sectionTipo: string | null;
}

/**
 * THE implicit relation walk (PHP clean_and_extract_related + build_legacy_ddo_map),
 * principal-free and ontology-only: the first 'section'-model relation node of
 * `sourceTipo` is the TARGET SECTION (stripped); marker nodes, inert label
 * nodes and the deprecated dd249 are skipped; everything else survives in
 * ontology order (PHP keeps non-component nodes in the map). Shared by the
 * edit/list builder below (which then applies the per-user STEP 5 filter) and
 * the export/flat children seam (relations/config_children.ts, whose consumers
 * filter per call — the export through its frontier, the interactive flat
 * reader through filterAuthorizedRelated itself; one predicate).
 */
export async function implicitRelationWalk(
	sourceTipo: string,
): Promise<{ targetSectionTipo: string | null; links: ImplicitRelationLink[] }> {
	let targetSectionTipo: string | null = null;
	const links: ImplicitRelationLink[] = [];
	for (const node of await ontologyRelationNodes(sourceTipo)) {
		const link = await modelledLink(node);
		if (link === null) continue;
		if (link.model === 'section' && targetSectionTipo === null) {
			targetSectionTipo = link.tipo; // PHP clean_and_extract_related :508
			continue;
		}
		if (isNeverAColumn(link)) continue;
		links.push({ tipo: link.tipo, model: link.model, sectionTipo: targetSectionTipo });
	}
	return { targetSectionTipo, links };
}

/** The ontology `relations` array of `sourceTipo` ([] when absent / not an array). */
async function ontologyRelationNodes(sourceTipo: string): Promise<{ tipo?: string }[]> {
	const rows = (await sql`
		SELECT relations FROM dd_ontology WHERE tipo = ${sourceTipo}
		  AND jsonb_typeof(relations) = 'array'
		LIMIT 1
	`) as { relations: { tipo?: string }[] | null }[];
	return rows[0]?.relations ?? [];
}

/** A relation node with its model resolved; null when the tipo is not a string or has no model. */
async function modelledLink(node: {
	tipo?: string;
}): Promise<{ tipo: string; model: string } | null> {
	if (typeof node.tipo !== 'string') return null;
	const model = await getModelByTipo(node.tipo);
	return model === null ? null : { tipo: node.tipo, model };
}

/**
 * Is this (non-target) relation node skipped from the map? PHP
 * clean_and_extract_related :531-538: marker nodes + deprecated skip. A
 * model='label' node too: labels are inert program strings (owner decision
 * 2026-10-12, label_node_guard.ts), no client module renders one, and
 * resolving its column label crashed the dd1500/dd1560 lists.
 */
function isNeverAColumn(link: { tipo: string; model: string }): boolean {
	return NEVER_A_COLUMN_MODELS.has(link.model) || link.tipo === DEPRECATED_SECURITY_AREAS_TIPO;
}

/**
 * The COMPONENT children an implicit (config-less) relation component
 * resolves per target, principal-free, in map order — the export / flat
 * reader's half of buildImplicitComponentListConfig (same rules, principal-
 * free: its consumers apply STEP 5 per call — the export's frontier, or
 * filterAuthorizedRelated itself in resolve/relation_list.ts readableChildren):
 *   component_filter → [dd156] (the project name at dd153, PHP :261-264);
 *   every other model (component_filter_master included, D2) → the component
 *   models of its own relation walk.
 */
export async function implicitComponentChildren(
	ownerTipo: string,
): Promise<{ tipo: string; model: string }[]> {
	if ((await getModelByTipo(ownerTipo)) === 'component_filter') {
		return [
			{
				tipo: PROJECTS_NAME_TIPO,
				model: (await getModelByTipo(PROJECTS_NAME_TIPO)) ?? 'component_input_text',
			},
		];
	}
	const { links } = await implicitRelationWalk(ownerTipo);
	return links
		.filter((link) => link.model.startsWith('component_'))
		.map((link) => ({ tipo: link.tipo, model: link.model }));
}

/**
 * Implicit config from a node's ontology relation nodes (PHP resolve_ar_related_*
 * + clean_and_extract_related + build_legacy_ddo_map): the first
 * section-model node is the TARGET SECTION (stripped from the map), the rest
 * become ddos with mode forced 'list'. `sourceTipo` is the section_list
 * child (list mode) or the COMPONENT ITSELF (edit mode / no section_list).
 */
export async function buildImplicitComponentListConfig(
	sourceTipo: string,
	context: RequestConfigContext,
): Promise<ParsedRequestConfigItem[]> {
	// PHP :88 — parent/children are not resolvable via the implicit graph walk.
	const ownerModel = await getModelByTipo(context.ownerTipo);
	if (ownerModel !== null && EXPLICIT_CONFIG_REQUIRED_MODELS.includes(ownerModel)) {
		throw new DedaloError('ontology.invalid_node', {
			message:
				`Invalid component [${ownerModel}] configuration. v5 resolution fallback is ` +
				`no longer supported. Configure an RQO for the node ${context.ownerTipo}`,
			coordinates: { tipo: context.ownerTipo, model: ownerModel },
		});
	}

	// component_filter always targets the projects section (PHP :261-264).
	// component_filter_master does NOT (owner decision D2, T0-9 2026-11-11): its
	// OWN ontology `relations` decide its target and columns (the walk below) —
	// one derivation for the edit form and the export (implicitComponentChildren).
	if (ownerModel === 'component_filter') {
		// PHP STEP 5 filter_authorized_related applies to this branch too.
		const projectsDdoMap = (
			await filterAuthorizedRelated([PROJECTS_NAME_TIPO], SECTION_PROJECTS_TIPO)
		).has(PROJECTS_NAME_TIPO)
			? [
					await withImplicitView(
						{
							tipo: PROJECTS_NAME_TIPO,
							model: (await getModelByTipo(PROJECTS_NAME_TIPO)) ?? 'component_input_text',
							section_tipo: SECTION_PROJECTS_TIPO,
							parent: context.ownerTipo,
							mode: 'list',
							label: await contextLabelOf(PROJECTS_NAME_TIPO),
						},
						context,
					),
				]
			: [];
		return [
			{
				api_engine: 'dedalo',
				type: 'main',
				sqo: { section_tipo: await buildSqoSectionTipoDdos([SECTION_PROJECTS_TIPO]) },
				show: {
					ddo_map: projectsDdoMap,
				},
				search: null,
				choose: null,
				hide: null,
				// Implicit configs are always the dedalo engine; PHP emits the key
				// as null on every item (the client reads it unconditionally).
				api_config: null,
			},
		];
	}

	const walk = await implicitRelationWalk(sourceTipo);
	let targetSectionTipo = walk.targetSectionTipo;
	const ddoMap: ProcessedDdo[] = [];
	for (const link of walk.links) {
		ddoMap.push(
			await withImplicitView(
				{
					tipo: link.tipo,
					model: link.model,
					// Implicit legacy ddos carry a SCALAR section_tipo (build_legacy_ddo_map),
					// unlike the explicit array form.
					section_tipo: link.sectionTipo ?? context.ownerSectionTipo,
					parent: context.ownerTipo,
					mode: 'list', // PHP trait.request_config_v5.php:117 — non-section callers force list
					label: await contextLabelOf(link.tipo),
				},
				context,
			),
		);
	}
	// section_list nodes may omit the target section — fall back to the
	// COMPONENT's main related section (PHP resolve_ar_related_list_component
	// :454-473). SECTION owners are excluded: PHP branches on the caller model
	// (resolve_ar_related_list :354) and resolve_ar_related_list_section returns
	// the section_list relation nodes VERBATIM — it never prepends a main
	// related section. A section's columns belong to the section itself, so the
	// target stays context.ownerSectionTipo (PHP clean_and_extract_related's
	// $section_tipo default). Stamping the section's *related* section here
	// keyed every dd774 permission lookup to the wrong section, so every column
	// was dropped for non-superusers (root passes via getPermissions' -1
	// short-circuit, which is why this only showed up for real users).
	if (targetSectionTipo === null && !context.ownerIsSection && sourceTipo !== context.ownerTipo) {
		targetSectionTipo = await getMainRelatedSectionTipo(context.ownerTipo);
	}
	// PHP clean_and_extract_related :508 is handed the CALLER's section_tipo as
	// the default target and only overwrites it when a section node is found —
	// so a section whose section_list carries no section node targets ITSELF.
	// This is what puts the section back on the sqo (and on every ddo below);
	// component owners keep the null → empty-sqo behaviour they had.
	if (targetSectionTipo === null && context.ownerIsSection) {
		targetSectionTipo = context.ownerSectionTipo;
	}
	// MODEL DEFAULT BEATS THE WALK'S PICK (2026-08-14). The section node found
	// above is the component's *belongs-to* ontology link, not a statement about
	// where its options come from — for a component_relation_model like
	// hierarchy27 (relations [hierarchy20, hierarchy25]) it resolves to
	// hierarchy20, the raw 69,148-row thesaurus TEMPLATE, which is plausible,
	// silent and wrong. A model that declares a `targetSource` therefore
	// overrides it here (context.modelDefaultTargets, resolved in ./build.ts).
	// This is NOT the "declared sqo wins" case: an implicit config is precisely
	// the node that declared nothing. Section owners are excluded — a section is
	// its own target and carries no component-model facet.
	targetSectionTipo = applyModelDefaultTarget(targetSectionTipo, context);
	// Fix section_tipo for ddos read before the section node appeared.
	if (targetSectionTipo !== null) {
		for (const ddo of ddoMap) {
			ddo.section_tipo = targetSectionTipo;
		}
	}
	// A node with NO relation graph at all yields NO config — EXCEPT a
	// config-less component_relation_index (hierarchy40's source
	// {mode:'external'} case, suite twins test25 / test149): its data resolves at
	// runtime through the inverse engine, and the pointing sections' related_list
	// columns are merged into its OWN dedalo item at emission
	// (relations/models/relation_index.ts mergeRelatedListIntoNode). PHP's merge
	// needs that base item to exist (component_relation_index_json "update
	// parents" + get_section_datum_from_locator append to the final dedalo
	// request_config); without it the client's get_columns_map finds no
	// show.ddo_map and renders no column (T0-8).
	if (targetSectionTipo === null && ddoMap.length === 0) {
		return configlessFallback(ownerModel, context.mode);
	}
	// PHP STEP 5 (filter_authorized_related :123-27): per-user drop against the
	// resolved target section.
	const authorizedTipos = await filterAuthorizedRelated(
		ddoMap.map((ddo) => ddo.tipo),
		targetSectionTipo ?? context.ownerSectionTipo,
	);
	const authorizedDdoMap = ddoMap.filter((ddo) => authorizedTipos.has(ddo.tipo));
	return [
		{
			api_engine: 'dedalo',
			type: 'main',
			sqo: {
				section_tipo:
					targetSectionTipo !== null ? await buildSqoSectionTipoDdos([targetSectionTipo]) : [],
			},
			show: { ddo_map: authorizedDdoMap },
			search: null,
			choose: null,
			hide: null,
			api_config: null, // dedalo engine (PHP emits the key on every item)
		},
	];
}

/**
 * The BASE dedalo item of a config-less component_relation_index (see the
 * caller): empty targets and columns — the pointing sections and their
 * related_list ddos are appended per read, on the element node, never here
 * (this config is cached and principal-independent) — plus the show.sqo_config
 * the client paginator reads, sized as the data pages: one locator in a list
 * cell (relation_core PORTAL_LIST_LIMIT), the component edit default 10
 * otherwise (relation_index.ts resolveIndexConfig editLimit).
 *
 *   {api_engine:'dedalo', type:'main', sqo:{section_tipo:[]},
 *    show:{ddo_map:[], sqo_config:{full_count:false, limit:1, offset:0, mode:'list', operator:'$or'}}, …}
 */
async function relationIndexBaseConfig(mode: string): Promise<ParsedRequestConfigItem> {
	const { PORTAL_LIST_LIMIT } = await import('../relation_core.ts');
	const limit = mode === 'list' ? PORTAL_LIST_LIMIT : RELATION_INDEX_EDIT_LIMIT;
	return {
		api_engine: 'dedalo',
		type: 'main',
		sqo: { section_tipo: [] },
		show: {
			ddo_map: [],
			sqo_config: { full_count: false, limit, offset: 0, mode, operator: '$or' },
		},
		search: null,
		choose: null,
		hide: null,
		api_config: null, // dedalo engine (PHP emits the key on every item)
	} as unknown as ParsedRequestConfigItem;
}

/** A relation-graph-less node's config: none, except a relation_index's base item (see the caller). */
async function configlessFallback(
	ownerModel: string | null,
	mode: string,
): Promise<ParsedRequestConfigItem[]> {
	if (ownerModel !== 'component_relation_index') return [];
	return [await relationIndexBaseConfig(mode)];
}

/** relation_index's edit page size when its node declares none (models/relation_index.ts resolveIndexConfig). */
const RELATION_INDEX_EDIT_LIMIT = 10;

/** Model-name PREFIXES an edit-form child may have (PHP resolve_ar_related_edit). */
const EDIT_CHILD_MODEL_PREFIXES = [
	'component_',
	'section_group',
	'section_group_div',
	'section_tab',
	'tab',
] as const;

/**
 * The implicit EDIT config for a SECTION (PHP resolve_ar_related_edit 'section' +
 * build_legacy_ddo_map): a FLAT ddo list — every descendant whose model starts
 * with component_/section_group/section_tab/tab (recursive ontology walk,
 * component_dataframe excluded: it renders through its main component), each
 * with parent = the SECTION, mode 'edit', SCALAR section_tipo (implicit legacy
 * shape), view per implicitDdoView (children_view → own view → default). This is what the
 * client renders the edit FORM BODY from.
 */
export async function buildImplicitSectionEditConfig(
	context: RequestConfigContext,
): Promise<ParsedRequestConfigItem[]> {
	// VIRTUAL SECTION resolution (PHP get_ar_children_tipo_by_model_name_in_section
	// with resolve_virtual=true, class.section.php:897-940): a virtual section
	// (getSectionRealTipo names a real section) borrows the REAL
	// section's edit components, MINUS the tipos named by its FIRST
	// exclude_elements child. Without this, a virtual section's edit form is
	// empty (its own children are only exclude_elements/section_list/buttons).
	const { realTipo, excludeSet } = await resolveVirtualEditScope(context.ownerTipo);

	// Recursive DFS pre-order over ontology children (order_number, id tie).
	// An excluded tipo is skipped AND not recursed into — so excluding a grouper
	// drops its whole subtree (matches PHP's flat exclude of the recursive children).
	const collectChildren = async (parentTipo: string, collected: string[]): Promise<void> => {
		for (const row of await getChildTipoModels(parentTipo)) {
			if (excludeSet.has(row.tipo)) continue;
			const model = (await getModelByTipo(row.tipo)) ?? row.model ?? '';
			const matches = EDIT_CHILD_MODEL_PREFIXES.some((prefix) => model.startsWith(prefix));
			if (!matches || model === 'component_dataframe') continue;
			// Dead v5 model still in the ontology: no ddo (the client would 404 on
			// its JS module and abort the whole edit render).
			if (DEAD_LEGACY_MODELS.has(model)) continue;
			collected.push(row.tipo);
			await collectChildren(row.tipo, collected);
		}
	};
	const childTipos: string[] = [];
	await collectChildren(realTipo, childTipos);
	// PHP STEP 5 (filter_authorized_related :123-27): the edit form only carries
	// components the actor can read — checked against the OWNER section.
	const authorizedChildren = await filterAuthorizedRelated(childTipos, context.ownerSectionTipo);
	const visibleChildTipos = childTipos.filter((tipo) => authorizedChildren.has(tipo));

	const ddoMap: ProcessedDdo[] = [];
	for (const tipo of visibleChildTipos) {
		const model = await getModelByTipo(tipo);
		if (model === null) continue;
		// View: the section's children_view, else own properties, else the
		// legacy-model default (implicitDdoView — PHP build_legacy_ddo_map).
		ddoMap.push(
			await withImplicitView(
				{
					tipo,
					model,
					// Implicit legacy shape: SCALAR section_tipo (vs the explicit array form).
					section_tipo: context.ownerSectionTipo,
					parent: context.ownerTipo,
					mode: 'edit',
					label: await contextLabelOf(tipo),
				},
				context,
			),
		);
	}

	return [
		{
			api_engine: 'dedalo',
			type: 'main',
			sqo: {
				section_tipo: await buildSqoSectionTipoDdos([context.ownerSectionTipo]),
				limit: 1,
				offset: 0,
			},
			show: { ddo_map: ddoMap },
			search: null,
			choose: null,
			hide: null,
			api_config: null, // dedalo engine (PHP emits the key on every item)
		} as unknown as ParsedRequestConfigItem,
	];
}
