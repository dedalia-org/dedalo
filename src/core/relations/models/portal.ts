/**
 * PORTAL family resolver (RELATIONS_SPEC.md §6.1) — component_portal plus the
 * legacy autocomplete/autocomplete_hi aliases, and (until their dedicated
 * phases land) every relation model without its own particularity:
 * relation_parent/children, filter, filter_master, external, dataframe.
 *
 * Emits the portal's paginated locator item and expands each paged locator's
 * target record through the child ddos (relation_core.expandPortal). The
 * children come from the CLIENT map's descendants when present, else from the
 * component's EFFECTIVE config (PHP resolve_source_properties): for list/tm
 * cells the section_list-substituted config (explicit raw ddos or implicit legacy
 * relations map); for edit cells the component's own config through the explicit
 * builder.
 *
 * A component may declare SEVERAL config items (a main + a secondary scope, or a
 * dedalo item + a non-dedalo one — rsc368, numisdata162, rsc1285, tchi29,
 * test204). ALL of them contribute children, flattened and deduped by
 * ../config_ddo_map.ts; which of those children a given locator sees is decided
 * by the LOCATOR's own section_tipo in relation_core, never by an api_engine
 * branch.
 *
 * PHP references: component_portal_json.php, class.common.php:2603-2681
 * (injected request_config precedence), trait.request_config_v5.php:618
 * (build_legacy_ddo_map).
 */

import type { Ddo } from '../../concepts/ddo.ts';
import { configOwnerOf, type EmitRow } from '../../concepts/emit_row.ts';
import {
	type ConfigDdo,
	type ConfigDdoMapSource,
	configChildRenderFields,
	flattenConfigDdoMaps,
} from '../config_ddo_map.ts';
import type { RelationEmitContext, RelationModelResolver } from '../registry.ts';
import { expandPortal } from '../relation_core.ts';

/**
 * component_filter/filter_master resolver. PHP component_filter_json switches on
 * mode like the select family — NOT the portal path:
 * - list/tm → the authorized-project LABELS that appear in the stored data
 *   (get_list_value);
 * - edit → the stored locators as entries + the authorized-projects DATALIST
 *   (get_datalist, the {type:'project',…} option set);
 * - other modes → the generic portal machinery (no own-config child expansion —
 *   the projects panel never runs subdatum over the targets).
 */
export const filterResolver: RelationModelResolver = {
	model: 'component_filter',

	async emitDdoItems(context: RelationEmitContext): Promise<void> {
		const { ddo, record, row, ddoMode, callerTipo, emission } = context;
		// list/edit/search emit the authorized-projects datalist; SEARCH renders it
		// as filter checkboxes (client render_search reads data.datalist), reusing
		// the edit branch below. Other modes take the portal path.
		if (ddoMode !== 'list' && ddoMode !== 'edit' && ddoMode !== 'search') {
			await portalResolver.emitDdoItems({ ...context, allowOwnConfigChildren: false });
			return;
		}
		const { buildDataItem } = await import('../../resolve/component_data.ts');
		const { getFilterDatalist, getFilterListValue } = await import('../filter_projects.ts');
		const storedLocators =
			((record.columns.relation as Record<string, unknown[]> | null)?.[context.dataTipo] as {
				section_tipo?: unknown;
				section_id?: unknown;
			}[]) ?? [];

		if (ddoMode === 'list') {
			const labels = await getFilterListValue(storedLocators);
			const item = buildDataItem(
				ddo.tipo,
				row.section_tipo,
				row.section_id,
				ddoMode,
				'lg-nolan',
				labels.length > 0 ? labels : null,
			);
			item.row_section_id = row.section_id;
			item.parent_tipo = callerTipo;
			emission.items.push(item);
			return;
		}
		// edit: stored locators as entries + the authorized-projects datalist.
		// Empty → [] (not null) so data.entries is always an array (life-cycle
		// suite test_component_filter asserts Array.isArray(entries); the shared
		// record's value gets cleared by a prior test in the suite).
		const item = buildDataItem(
			ddo.tipo,
			row.section_tipo,
			row.section_id,
			ddoMode,
			'lg-nolan',
			storedLocators.length > 0 ? storedLocators : [],
		);
		item.datalist = await getFilterDatalist();
		item.row_section_id = row.section_id;
		item.parent_tipo = callerTipo;
		emission.items.push(item);
	},
};

/**
 * The section a portal cell's OWN config resolves against. A host row (dd15)
 * names the component's own record first: the ddo's section_tipo there is the
 * HOST's (it binds the cell), not the owner. Otherwise the ddo's declared
 * section, else the row's.
 */
function ownConfigSectionTipo(ddo: Ddo, row: EmitRow): string {
	if (row.config_owner !== undefined) return row.config_owner.section_tipo;
	return (
		(Array.isArray(ddo.section_tipo) ? ddo.section_tipo[0] : ddo.section_tipo) ?? row.section_tipo
	);
}

/**
 * The child ddos of a portal whose CALLER declared none — built from the
 * component's own effective config, and returned as the FULL descendant map
 * (every level, keyed by `parent`), not just this portal's own children.
 *
 * Extracted from `portalResolver.emitDdoItems`, which is the branchiest
 * function in the file: this is a self-contained decision (which of the three
 * config shapes describes this portal's children — an implicit legacy map, an
 * explicit list map, or the edit-mode own config) and it reads better with a
 * name than as a 120-line arm of an `if`.
 *
 * Called ONLY when the caller declared no children for this portal; when it
 * did, its map is used as-is and `ownConfig` stays false.
 */
async function buildOwnConfigDescendants(args: {
	ddo: Ddo;
	row: EmitRow;
	defaultLang: string;
	isListCell: boolean;
}): Promise<Ddo[]> {
	const { ddo, row, defaultLang, isListCell } = args;
	const {
		getNode,
		getTranslatableByTipo,
		getModelByTipo: modelOf,
	} = await import('../../ontology/resolver.ts');
	const { buildRequestConfigForElement } = await import('../request_config/build.ts');
	const fullMap: Ddo[] = [];

	// The instance-lang rule (PHP get_element_lang): request lang when
	// translatable, lg-nolan otherwise.
	const stampLang = async (tipo: string, declared?: string): Promise<string> =>
		declared ?? ((await getTranslatableByTipo(tipo)) ? defaultLang : 'lg-nolan');

	let implicitRelations: string[] | null = null;
	let rawListDdos: import('../../section/list_definitions/section_list.ts').RawConfigDdo[] | null =
		null;
	if (isListCell) {
		const { resolveListCellMap } = await import('../../section/list_definitions/section_list.ts');
		const cell = await resolveListCellMap(ddo.tipo);
		implicitRelations = cell.implicitRelations;
		rawListDdos = cell.rawDdos;
	}

	if (implicitRelations !== null) {
		// implicit LEGACY map: the section_list node's relations — first
		// 'section' model is the target section, components become
		// list-mode ddos (PHP build_legacy_ddo_map, current_mode='list').
		let targetSection: string | undefined;
		const componentTipos: string[] = [];
		for (const relTipo of implicitRelations) {
			const relModel = await modelOf(relTipo);
			if (relModel === 'section') {
				targetSection = targetSection ?? relTipo;
				continue;
			}
			if (relModel === null || !relModel.startsWith('component_')) continue;
			componentTipos.push(relTipo);
		}
		// section_list relations without a section node fall back to the
		// component's main related section (PHP
		// resolve_ar_related_list_component :454-473).
		if (targetSection === undefined) {
			const { getMainRelatedSectionTipo } = await import('../request_config/implicit.ts');
			targetSection = (await getMainRelatedSectionTipo(ddo.tipo)) ?? undefined;
		}
		for (const relTipo of componentTipos) {
			fullMap.push({
				tipo: relTipo,
				section_tipo: targetSection,
				parent: ddo.tipo,
				mode: 'list',
				lang: await stampLang(relTipo),
			} as Ddo);
		}
	} else if (rawListDdos !== null && rawListDdos.length > 0) {
		// explicit LIST map: the RAW ddo entries of the effective (possibly
		// section_list-substituted) config. section_tipo stays AS DECLARED
		// ('self' = the portal's own targets, match-all) so the per-locator
		// section grouping can skip incompatible children (numisdata97
		// declares numisdata33 → never renders at an object1 target). Ddo
		// modes pass through AS DECLARED (edit ddos render in edit —
		// dd560's rsc1246 case); component_dataframe ddos stay in the map
		// and route to the frame emitter inside expandPortal.
		for (const child of rawListDdos) {
			if (typeof child?.tipo !== 'string') continue;
			fullMap.push({
				tipo: child.tipo,
				parent: child.parent === 'self' || child.parent === undefined ? ddo.tipo : child.parent,
				lang: await stampLang(child.tipo, child.lang),
				// section_tipo / mode / limit / value_with_parents: the ONE mapper
				// shared with the get_data twin (section/read.ts)
				...configChildRenderFields(child as unknown as ConfigDdo),
			} as Ddo);
		}
	} else {
		// EDIT cells: the component's own config through the explicit builder.
		const node = await getNode(ddo.tipo);
		const ownConfig = await buildRequestConfigForElement(node?.properties ?? null, {
			ownerTipo: ddo.tipo,
			ownerSectionTipo: ownConfigSectionTipo(ddo, row),
			mode: 'edit',
			ownerIsSection: false,
			ownerSectionId: configOwnerOf(row).section_id,
			lang: defaultLang,
		});
		// PHP get_subdatum builds ONE full_ddo_map out of EVERY config
		// item's show + hide maps (class.common.php:2312-2341) — not just
		// the first item's. Taking `ownConfig[0]` dropped a second engine's
		// children entirely, which is where rsc368's zenon source died; it
		// also dropped a `secondary` dedalo item's children (numisdata573's
		// hierarchy95). The shared flattener owns the rule, including the
		// dedup and the empty-show-map skip.
		const configChildren = flattenConfigDdoMaps(ownConfig as unknown as ConfigDdoMapSource[], {
			ownerTipo: ddo.tipo,
			logEmptyShowMap: true,
		});
		for (const child of configChildren) {
			const childTipo = child.tipo;
			if (typeof childTipo !== 'string' || childTipo === '') continue;
			fullMap.push({
				tipo: childTipo,
				parent: child.parent === 'self' ? ddo.tipo : (child.parent as string),
				lang: await stampLang(childTipo, child.lang as string | undefined),
				// section_tipo / mode / limit / value_with_parents: the ONE mapper
				// shared with the get_data twin (section/read.ts). It keeps the
				// DECLARED section list intact — a multi-target hi component's
				// 'self' children resolve to EVERY target (numisdata20's
				// hierarchy25 spans 26 hierarchy sections); flattening to [0] made
				// the per-locator grouping skip all but the first target (the
				// numisdata6 §2 client bug). It is ALSO what keeps a multi-engine
				// map safe: the zenon ddos declare zenon1, so only a zenon1
				// locator ever sees them.
				...configChildRenderFields(child),
			} as Ddo);
		}
	}
	return fullMap;
}

export const portalResolver: RelationModelResolver = {
	model: 'component_portal',

	async emitDdoItems(context: RelationEmitContext): Promise<void> {
		const {
			ddo,
			ddoMap,
			record,
			row,
			model,
			ddoMode,
			ddoLang,
			defaultLang,
			callerTipo,
			emission,
			allowOwnConfigChildren,
			depth,
			emitDdo,
		} = context;
		const childDdos = ddoMap.filter((child) => child.parent === ddo.tipo);

		// Children: the CLIENT map's descendants when present, else the
		// component's EFFECTIVE config ddos. For list/tm cells the effective
		// config is the SECTION_LIST-substituted one (PHP
		// resolve_source_properties): the section_list child node's
		// request_config, or an implicit legacy map from its relations, or — with no
		// section_list child — the component's own config/relations.
		let portalChildren = childDdos;
		let portalDescendants: Ddo[] | undefined;
		let cellLimit: number | null = null;
		const isListCell = ddoMode === 'list';
		if (isListCell) {
			// The cell page limit follows the effective list config even when
			// the children come from the client map (PHP instance pagination).
			const { resolveListCellMap } = await import('../../section/list_definitions/section_list.ts');
			cellLimit = (await resolveListCellMap(ddo.tipo)).cellLimit;
		}
		if (portalChildren.length === 0 && allowOwnConfigChildren) {
			const fullMap = await buildOwnConfigDescendants({ ddo, row, defaultLang, isListCell });
			portalDescendants = fullMap;
			portalChildren = fullMap.filter((child) => child.parent === ddo.tipo);
		}
		await expandPortal(
			record,
			ddo,
			model,
			portalChildren,
			ddoMode,
			ddoLang,
			row,
			callerTipo,
			emission,
			emitDdo,
			{
				// The DESCENDANT map, never just the direct children: a
				// grandchild declared in the CALLER's map (numisdata3's list
				// map declares rsc29 with parent numisdata164, itself a child
				// of the numisdata77 cell) only resolves if the whole map
				// travels down the parent chain. Passing `undefined` here let
				// expandPortal fall back to `childDdos` (relation_core.ts:501)
				// and dropped every level below the first whenever the children
				// came from the caller map instead of the component's own
				// config — the numisdata3 list showed the image placeholder for
				// every coin.
				//
				// (!) The map must CARRY the levels. `ownConfig` below stays
				// false for caller-map children, so in list mode a nested
				// portal still cannot fall back to its own config: a map that
				// declares numisdata164 but not rsc29 renders the placeholder
				// exactly as before. That is PHP's substituted-config
				// semantics, not a second bug — the caller owns its map.
				//
				// (!) In EDIT mode this also settles a precedence: caller-map
				// grandchildren now win over the nested portal's own config
				// (pre-fix the slice was empty by construction, so own config
				// always won). That is PHP's injected-request_config order,
				// class.common.php:2603-2681.
				descendantsMap: portalDescendants ?? ddoMap,
				childrenLang: defaultLang,
				cellLimit,
				// ownConfig gates the nested-own-config recursion for list/tm
				// cells AND the ddinfo breadcrumb emission (autocomplete_hi) —
				// PHP emits ddinfo in EVERY mode when the children came from the
				// component's own config.
				ownConfig: portalDescendants !== undefined,
				depth,
			},
		);
	},
};
