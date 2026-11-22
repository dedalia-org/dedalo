/**
 * component_security_access::get_datalist — the ontology ACL tree.
 *
 * Faithful TS port of PHP core/component_security_access/
 * class.component_security_access.php get_datalist / get_element_datalist /
 * get_children_recursive_security_access, for the GLOBAL-ADMIN (unfiltered)
 * case. Produces the flat datalist the permissions widget renders: every area,
 * section and section-element (component/grouper/tab/button/relation_list/…)
 * reachable from the installed ontology, each carrying its full rolling
 * ancestor chain (`ar_parent`).
 *
 * The datalist carries NO permission values — it is the same structural tree
 * for every profile; the client overlays per-profile integers on top.
 *
 * PORT NOTES / PHP ORACLE MAPPING
 * - area::get_areas() → getAreas(): root area models in the FIXED menu order
 *   (PHP get_ar_root_area_tipos), each root's descendants via the
 *   include/exclude model walk (get_ar_children_areas_recursive), then THE
 *   AREAS DENY LAW (concepts/area.ts applyAreasDeny, the menu's own filter). `model` = get_model_by_tipo (the
 *   resolved model), `label` = get_term(DEDALO_APPLICATION_LANG, fallback).
 * - get_datalist(): the area loop with ar_check dedup by `tipo_parent`, the
 *   rolling `ar_parent` chain (array_search / array_splice), the datalist_item
 *   shape, and the `model==='section'` → get_element_datalist recursion with
 *   the `[...ar_parent, ...child.ar_parent]` prefix merge.
 * - get_element_datalist(): exclude_elements resolution, the recursive
 *   children walk, the explicit `source.request_config.ddo_map` path, and the second
 *   rolling ar_parent chain over the section's own elements.
 * - get_children_recursive_security_access(): the section vs. area/grouper
 *   branch, the section's virtual-aware child fetch (resolve_virtual + the
 *   without-virtual concat for virtual-specific buttons), the ar_exclude_model
 *   hard list, DEDALO_AR_EXCLUDE_COMPONENTS (empty on this install), and the
 *   per-child recursion.
 *
 * NON-ADMIN FILTERING (2026-08-09, oh1 beta audit §7). PHP narrows the area
 * list for a non-global-admin to the areas already present in the caller's OWN
 * component_security_access data (get_datalist:214-236) — otherwise the widget
 * hands every authenticated user the whole ontology structure. The port now
 * does the same: the caller's dd774 grant tipos come from
 * security/permissions.ts getGrantedTipos (PRESENCE by TIPO, any level — PHP's
 * `array_find($user_data, fn($el) => $el->tipo === $current_area->tipo)`), and
 * a global admin still receives the unfiltered tree.
 *
 * The principal is passed explicitly where the caller has one and falls back to
 * the request scope (security/request_context.ts currentPrincipal) otherwise —
 * the emit hook is a leaf with no principal parameter, the same case that scope
 * accessor exists for. NO principal at all (unit harnesses, background warmups)
 * means NO filter, the posture ddoIsAuthorized already takes.
 *
 * LEDGER — config_areas deny: PHP area::get_areas() always subtracts the
 * installation's config_areas `areas_deny` (entity-specific; for monedaiberica
 * that is dd137,rsc1,hierarchy20,dd222,dd356,dd354,numisdata240,numisdata243,
 * numisdata137,rsc179,numisdata163,numisdata283,mupreva492,qdp188). This module
 * sources the deny from getEffectiveAreasDeny(config.menu.areasDeny) — the same
 * canonical TS deny source the menu uses — so it tracks whatever AREAS_DENY the
 * install is configured with. The TS default omits the entity-specific denies,
 * so exact PHP parity requires AREAS_DENY to be set to the mib list in the
 * environment (a pre-existing menu-config gap, NOT a datalist-algorithm gap).
 *
 * CACHING (2026-10-02; PHP served a per-user/lang cache file, cleared by
 * delete_cache_files on ontology changes). The cold build read ~3 sequential
 * queries per node over a ~13k-node tree (6–7 s on a real install). Now:
 * - the build reads the ontology in ONE query (loadOntologySnapshot) and walks
 *   it with the resolver's own model / virtual→real laws (runtimeModelOfStored,
 *   sectionRealTipoFromRelations) — no per-node getNode, and no dependence on
 *   the resolver's node-cache cap (10000, below a 13k walk);
 * - LEVEL 1 caches the unfiltered structure per (application lang, deny list);
 * - LEVEL 2 caches the finished, FROZEN datalist per (lang, deny, the viewer's
 *   granted-area set) — cleared on every dd_ontology write (cache factory) and
 *   on every users/profiles record write (save-event listener).
 * Gate: test/unit/security_access_datalist_cache_native.test.ts (bounded cold
 * query count, warm == cold, isolation per user and per lang, invalidation).
 */

import { createHash } from 'node:crypto';
import { config } from '../../config/config.ts';
import {
	AREA_CHILD_EXCLUDE_MODELS,
	AREA_CHILD_INCLUDE_MODELS,
	applyAreasDeny,
	MENU_ROOT_MODEL_ORDER,
} from '../concepts/area.ts';
import { DD_ONTOLOGY_SIBLING_ORDER_SQL } from '../db/dd_ontology.ts';
import { isInTransaction, sql } from '../db/postgres.ts';
import { createOntologyCache } from '../ontology/cache_factory.ts';
import { registerOntologyCacheClearer } from '../ontology/cache_invalidation.ts';
import { resolveLabel } from '../ontology/labels.ts';
import {
	getModelByTipo,
	isOutsideSectionContainment,
	runtimeModelOfStored,
	sectionRealTipoFromRelations,
} from '../ontology/resolver.ts';
import { registerSectionDataListener } from '../section_record/save_event.ts';
import { getGrantedTipos, PROFILES_SECTION, type Principal } from '../security/permissions.ts';
import { currentPrincipal } from '../security/request_context.ts';
import { currentApplicationLang } from './request_lang.ts';
import { getEffectiveAreasDeny } from './server_state.ts';

/** One flat datalist item (PHP datalist_item shape — order of keys is not significant). */
export interface SecurityAccessDatalistItem {
	tipo: string;
	section_tipo: string;
	// null (not '') for foreign/unresolvable tipos — get_model_by_tipo /
	// get_term_by_tipo return null there and PHP emits it verbatim.
	model: string | null;
	label: string | null;
	parent: string;
	ar_parent: string[];
}

/** An element item before the ar_parent chain is stamped (PHP get_children_recursive result shape). */
interface ChildItem {
	tipo: string;
	section_tipo: string;
	model: string | null;
	label: string | null;
	parent: string;
}

/** An area/section node from area::get_areas(). */
interface AreaObj {
	tipo: string;
	model: string | null;
	parent: string;
	label: string | null;
}

/**
 * The per-node ontology reads the walks below consume. TWO sources, ONE walk:
 * the datalist build reads a one-query snapshot (loadOntologySnapshot), the
 * permission-grant expansion reads the per-node cached accessors
 * (LIVE_READER). Same laws either way — the model and virtual→real laws come
 * from ontology/resolver.ts (runtimeModelOfStored / sectionRealTipoFromRelations).
 */
interface OntologyReader {
	childrenOf(tipo: string): Promise<string[]>;
	modelOf(tipo: string): Promise<string | null>;
}

/** The snapshot reader: everything the datalist build needs, from one query. */
interface SnapshotReader extends OntologyReader {
	relationTipos(tipo: string): string[];
	properties(tipo: string): Record<string, unknown> | null;
	labelOf(tipo: string): string | null;
	parentOf(tipo: string): string | null;
	realSectionTipo(tipo: string): Promise<string>;
	/** The first node of a STORED model in THE sibling order (the area-root pick), or null. */
	firstOfModel(model: string): { tipo: string; parent: string | null } | null;
}

// -----------------------------------------------------------------------------
// low-level ontology helpers
// -----------------------------------------------------------------------------

/**
 * ontology_node::get_ar_children_of_this — direct children tipos in THE sibling
 * order (DD_ONTOLOGY_SIBLING_ORDER_SQL: order_number, NULL last, tipo — PHP
 * emitted `ORDER BY order_number ASC` and left a tie to the heap; T2-SC-5).
 * Per-node, cached — the grant expansion's source (a section at a time, not
 * the tree).
 */
const childrenOfCache = createOntologyCache<string, string[]>();
async function getChildrenOfThis(tipo: string): Promise<string[]> {
	const cached = childrenOfCache.get(tipo);
	if (cached !== undefined) return cached;
	const rows = (await sql.unsafe(
		`SELECT tipo FROM dd_ontology WHERE parent = $1 ORDER BY ${DD_ONTOLOGY_SIBLING_ORDER_SQL}`,
		[tipo],
	)) as { tipo: string }[];
	const result = rows.map((row) => row.tipo);
	if (!isInTransaction()) childrenOfCache.set(tipo, result);
	return result;
}

/** The per-node reader (grant expansion): cached children + the resolver's model law. */
const LIVE_READER: OntologyReader = {
	childrenOf: getChildrenOfThis,
	modelOf: getModelByTipo,
};

/** One dd_ontology row as the snapshot holds it. */
interface SnapshotRow {
	parent: string | null;
	model: string | null;
	relations: unknown;
	properties: unknown;
	term: unknown;
}

/**
 * ONE query for the whole ontology the ACL tree walks (the cold-build cost was
 * ~3 sequential queries per node over a ~13k-node tree). Rows come in THE
 * sibling order (DD_ONTOLOGY_SIBLING_ORDER_SQL, the per-parent query's order),
 * so grouping them by parent in scan order yields each node's children in the
 * order getChildrenOfThis returns, and the first row of a model in scan order
 * is the ordered area-root pick (T2-SC-5b — the menu picks the same row).
 * Labels resolve in `lang` through THE label law (resolveLabel — what
 * labelByTipo applies to the same `term` column).
 */
async function loadOntologySnapshot(lang: string): Promise<SnapshotReader> {
	const rows = (await sql.unsafe(
		`SELECT tipo, parent, model, relations, properties, term
		 FROM dd_ontology
		 ORDER BY ${DD_ONTOLOGY_SIBLING_ORDER_SQL}`,
	)) as (SnapshotRow & { tipo: string })[];
	const byTipo = new Map<string, SnapshotRow>();
	const children = new Map<string, string[]>();
	const firstByModel = new Map<string, { tipo: string; parent: string | null }>();
	for (const row of rows) {
		if (!byTipo.has(row.tipo)) byTipo.set(row.tipo, row);
		if (row.model !== null && !firstByModel.has(row.model)) {
			firstByModel.set(row.model, { tipo: row.tipo, parent: row.parent });
		}
		if (row.parent === null) continue;
		const list = children.get(row.parent);
		if (list === undefined) children.set(row.parent, [row.tipo]);
		else list.push(row.tipo);
	}
	// Per-build memos (local to this build — never module state).
	const models = new Map<string, Promise<string | null>>();
	const realTipos = new Map<string, Promise<string>>();
	const modelOf = (tipo: string): Promise<string | null> => {
		let model = models.get(tipo);
		if (model === undefined) {
			model = runtimeModelOfStored(tipo, byTipo.get(tipo)?.model ?? null);
			models.set(tipo, model);
		}
		return model;
	};
	return {
		childrenOf: async (tipo) => children.get(tipo) ?? [],
		modelOf,
		relationTipos: (tipo) => {
			const relations = byTipo.get(tipo)?.relations;
			if (!Array.isArray(relations)) return [];
			const out: string[] = [];
			for (const relation of relations as { tipo?: unknown }[]) {
				if (typeof relation?.tipo === 'string' && relation.tipo) out.push(relation.tipo);
			}
			return out;
		},
		properties: (tipo) =>
			(byTipo.get(tipo)?.properties as Record<string, unknown> | null | undefined) ?? null,
		labelOf: (tipo) => resolveLabel(byTipo.get(tipo)?.term ?? null, lang),
		parentOf: (tipo) => byTipo.get(tipo)?.parent ?? null,
		firstOfModel: (model) => firstByModel.get(model) ?? null,
		realSectionTipo: (tipo) => {
			let real = realTipos.get(tipo);
			if (real === undefined) {
				real = sectionRealTipoFromRelations(tipo, byTipo.get(tipo)?.relations, modelOf);
				realTipos.set(tipo, real);
			}
			return real;
		},
	};
}

/**
 * section::get_section_real_tipo_static — THE virtual→real law lives in
 * ontology/resolver.ts (DATA-33: one home, every consumer). Re-exported here
 * because this module was its first TS home and its importers link to it;
 * a link, never a second copy.
 */
export { getSectionRealTipo } from '../ontology/resolver.ts';

/**
 * ontology_node::get_ar_tipo_by_model_and_relation(tipo, 'exclude_elements',
 * 'children', true) — direct children whose resolved model === 'exclude_elements'.
 */
async function getExcludeElementsChildren(
	reader: OntologyReader,
	sectionTipo: string,
): Promise<string[]> {
	const out: string[] = [];
	for (const childTipo of await reader.childrenOf(sectionTipo)) {
		if ((await reader.modelOf(childTipo)) === 'exclude_elements') out.push(childTipo);
	}
	return out;
}

/**
 * ontology_node::get_ar_recursive_children — depth-first descendants of `tipo`
 * (excluding the starting node) under THE SECTION CONTAINMENT LAW
 * (ontology/resolver.ts — T2-SL-3b): a box-elements / semantic-node / area
 * node is not part of the section, neither it nor its subtree
 * (isOutsideSectionContainment, the law's one predicate); a nested section is
 * returned but not entered. Used by the grant expansion and to expand grouper
 * excludes during resolve_virtual. Gate: security_access_containment_native
 * (equal to the resolver's own section walk, getRecursiveChildrenTipos).
 */
async function getArRecursiveChildren(
	reader: OntologyReader,
	tipo: string,
	collector: string[],
): Promise<string[]> {
	for (const childTipo of await reader.childrenOf(tipo)) {
		const model = await reader.modelOf(childTipo);
		if (isOutsideSectionContainment(model)) continue;
		collector.push(childTipo);
		if (model === 'section') continue; // rule 2: a nested section's children are its own
		await getArRecursiveChildren(reader, childTipo, collector);
	}
	return collector;
}

// -----------------------------------------------------------------------------
// section child resolution (PHP get_ar_children_tipo_by_model_name_in_section)
// -----------------------------------------------------------------------------

/**
 * The model-name substrings the security walk keeps for a section's direct
 * children (PHP ar_modelo_name_required). Matched with str_contains (not exact).
 */
const SECTION_CHILD_MODEL_REQUIRED: readonly string[] = [
	'section_group',
	'section_tab',
	'tab',
	'button_',
	'relation_list',
	'time_machine_list',
	'component_',
];

/**
 * filter_children_by_models (search_exact=false): keep children whose resolved
 * model CONTAINS any required substring (deduped, order-preserving). The
 * required list is a parameter because the two callers pass different ones —
 * the ACL-tree walk uses SECTION_CHILD_MODEL_REQUIRED, the permission grant
 * uses GRANT_CHILD_MODEL_REQUIRED (PHP passes ar_model_name_required per call).
 */
async function filterChildrenByModels(
	reader: OntologyReader,
	children: readonly string[],
	required: readonly string[] = SECTION_CHILD_MODEL_REQUIRED,
): Promise<string[]> {
	const result: string[] = [];
	const seen = new Set<string>();
	for (const childTipo of children) {
		if (seen.has(childTipo)) continue;
		const model = (await reader.modelOf(childTipo)) ?? '';
		if (required.some((requiredModel) => model.includes(requiredModel))) {
			result.push(childTipo);
			seen.add(childTipo);
		}
	}
	return result;
}

/**
 * The model-name substrings component_security_access::set_section_permissions
 * grants over (PHP ar_model_name_required at class.component_security_access
 * .php:869). Deliberately NOT the same list as SECTION_CHILD_MODEL_REQUIRED
 * above — 'button' here vs 'button_' there, and no 'tab'/'section_tab' — so the
 * two walks stay independent ports of their own PHP call sites.
 */
const GRANT_CHILD_MODEL_REQUIRED: readonly string[] = [
	'component',
	'button',
	'section_group',
	'relation_list',
	'time_machine_list',
];

/**
 * The element tipos a section grant expands to — PHP
 * get_ar_children_tipo_by_model_name_in_section(real_section,
 * GRANT_CHILD_MODEL_REQUIRED, from_cache=true, resolve_virtual=FALSE,
 * recursive=TRUE, search_exact=false) as called by set_section_permissions.
 *
 * count(required) > 1 && recursive ⇒ the source is get_ar_recursive_children
 * (the DEEP walk through section_group/tab groupers, under THE SECTION
 * CONTAINMENT LAW), then the model filter. The caller
 * resolves the real section first (PHP does), so resolve_virtual is false here
 * and NO exclude_elements subtraction runs — matching the oracle.
 */
export async function getGrantChildrenTipos(realSectionTipo: string): Promise<string[]> {
	const recursiveChildren = await getArRecursiveChildren(LIVE_READER, realSectionTipo, []);
	return filterChildrenByModels(LIVE_READER, recursiveChildren, GRANT_CHILD_MODEL_REQUIRED);
}

/**
 * get_ar_children_tipo_by_model_name_in_section(section, required, from_cache,
 * resolve_virtual=true, recursive=false, search_exact=false) — as invoked by the
 * security section branch. count(required)>1 && recursive=false ⇒ the children
 * source is get_ar_children_of_this on the REAL section (resolve_virtual maps the
 * virtual tipo to its real section and subtracts the virtual's exclude_elements,
 * expanding grouper excludes recursively); then filter by the required models.
 */
async function getSectionChildrenResolveVirtual(
	reader: SnapshotReader,
	sectionTipo: string,
): Promise<string[]> {
	const realTipo = await reader.realSectionTipo(sectionTipo);

	// exclude_elements are read from the ORIGINAL (possibly virtual) tipo.
	const excludeSet = new Set<string>();
	const excludeElementsChildren = await getExcludeElementsChildren(reader, sectionTipo);
	const excludeElementsTipo = excludeElementsChildren[0];
	if (excludeElementsTipo !== undefined) {
		for (const excludedTipo of reader.relationTipos(excludeElementsTipo)) {
			excludeSet.add(excludedTipo);
			const model = await reader.modelOf(excludedTipo);
			if (model === 'section_group' || model === 'section_tab' || model === 'tab') {
				for (const grouperChild of await getArRecursiveChildren(reader, excludedTipo, [])) {
					excludeSet.add(grouperChild);
				}
			}
		}
	}

	const directChildren = await reader.childrenOf(realTipo);
	const kept = directChildren.filter((childTipo) => !excludeSet.has(childTipo));
	return filterChildrenByModels(reader, kept);
}

/**
 * get_ar_children_tipo_by_model_name_in_section(section, required, …,
 * resolve_virtual=false, recursive=false, …) — the virtual-section second fetch:
 * the virtual node's OWN direct children (virtual-specific buttons), filtered by
 * the required models, with no exclude subtraction.
 */
async function getSectionChildrenNoVirtual(
	reader: SnapshotReader,
	sectionTipo: string,
): Promise<string[]> {
	return filterChildrenByModels(reader, await reader.childrenOf(sectionTipo));
}

// -----------------------------------------------------------------------------
// get_children_recursive_security_access
// -----------------------------------------------------------------------------

/**
 * Hard-coded model names never included in the permission tree (PHP
 * ar_exclude_model). Its `component_semantic_node` / `box_elements` entries
 * (the latter a misspelling: the runtime model is `box elements`, so a box
 * under a grouper was walked and its components granted) are THE SECTION
 * CONTAINMENT LAW now, applied with the law's own predicate below (T2-SL-3b).
 */
const AR_EXCLUDE_MODEL: ReadonlySet<string> = new Set([
	'component_security_administrator',
	'section_list',
	'search_list',
	'exclude_elements',
	'edit_view',
]);

/** DEDALO_AR_EXCLUDE_COMPONENTS — installation opt-out (config-driven, default empty). */
const AR_EXCLUDE_COMPONENTS: ReadonlySet<string> = new Set<string>(
	config.features.arExcludeComponents,
);

/**
 * get_children_recursive_security_access — recursively walk the ontology under
 * `tipo`, collecting eligible elements. `parent`/`section_tipo` of each element
 * are set to `tipo` (matches PHP, and differs from the child's own ontology
 * parent for virtual sections).
 */
async function getChildrenRecursiveSecurityAccess(
	reader: SnapshotReader,
	tipo: string,
	excludeTipos: ReadonlySet<string> | null,
): Promise<ChildItem[]> {
	const elements: ChildItem[] = [];

	const sourceModel = await reader.modelOf(tipo);
	let childTipos: string[];
	if (sourceModel === 'section') {
		childTipos = await getSectionChildrenResolveVirtual(reader, tipo);
		const realTipo = await reader.realSectionTipo(tipo);
		if (tipo !== realTipo) {
			// Virtual section: also fetch the virtual node's own children (buttons).
			childTipos = [...childTipos, ...(await getSectionChildrenNoVirtual(reader, tipo))];
		}
	} else {
		// Areas / section_groups / …
		childTipos = await reader.childrenOf(tipo);
	}

	for (const elementTipo of childTipos) {
		if (excludeTipos?.has(elementTipo)) continue;
		const model = await reader.modelOf(elementTipo);
		// THE SECTION CONTAINMENT LAW (resolver.ts): outside the section, subtree too.
		if (isOutsideSectionContainment(model)) continue;
		if (model !== null && AR_EXCLUDE_MODEL.has(model)) continue;
		if (AR_EXCLUDE_COMPONENTS.has(elementTipo)) continue;

		elements.push({
			tipo: elementTipo,
			section_tipo: tipo,
			model,
			label: reader.labelOf(elementTipo),
			parent: tipo,
		});

		// the law's rule 2: a nested section is listed, never entered
		if (model === 'section') continue;
		const sub = await getChildrenRecursiveSecurityAccess(reader, elementTipo, excludeTipos);
		for (const item of sub) elements.push(item);
	}

	return elements;
}

// -----------------------------------------------------------------------------
// get_element_datalist
// -----------------------------------------------------------------------------

/**
 * get_element_datalist — the flat datalist of all elements inside one section,
 * WITH their own rolling ar_parent chain (the caller prepends the area-level
 * chain). Handles the explicit `source.request_config.ddo_map` path.
 */
async function getElementDatalist(
	reader: SnapshotReader,
	sectionTipo: string,
): Promise<SecurityAccessDatalistItem[]> {
	// exclude_elements defined in the ontology → tipos removed from the walk.
	let excludeTipos: ReadonlySet<string> | null = null;
	const excludeElementsChildren = await getExcludeElementsChildren(reader, sectionTipo);
	const excludeElementsTipo = excludeElementsChildren[0];
	if (excludeElementsTipo !== undefined) {
		excludeTipos = new Set(reader.relationTipos(excludeElementsTipo));
	}

	const childrenRecursive = await getChildrenRecursiveSecurityAccess(
		reader,
		sectionTipo,
		excludeTipos,
	);

	// explicit request_config.ddo_map path.
	let childrenList: ChildItem[];
	const properties = reader.properties(sectionTipo);
	const source = properties?.source as { request_config?: unknown } | undefined;
	if (source !== undefined && source !== null && Array.isArray(source.request_config)) {
		const explicitChildren: { tipo?: unknown; parent?: unknown; parent_grouper?: unknown }[] = [];
		for (const requestConfigItem of source.request_config as {
			show?: { ddo_map?: unknown };
		}[]) {
			const ddoMap = requestConfigItem?.show?.ddo_map;
			if (Array.isArray(ddoMap)) {
				for (const ddo of ddoMap as { parent?: unknown }[]) {
					// Only DDOs whose parent is 'self' or the section itself.
					if (ddo?.parent === 'self' || ddo?.parent === sectionTipo) {
						explicitChildren.push(
							ddo as { tipo?: unknown; parent?: unknown; parent_grouper?: unknown },
						);
					}
				}
			}
		}

		childrenList = [];
		for (const ddo of explicitChildren) {
			if (typeof ddo !== 'object' || ddo === null || typeof ddo.tipo !== 'string') continue;
			const parentGrouper =
				typeof ddo.parent_grouper === 'string' ? ddo.parent_grouper : sectionTipo;
			childrenList.push({
				tipo: ddo.tipo,
				section_tipo: sectionTipo,
				model: await reader.modelOf(ddo.tipo),
				label: reader.labelOf(ddo.tipo),
				parent: parentGrouper,
			});
		}
		// Append 'default' calculated items excluding components and section_groups.
		for (const item of childrenRecursive) {
			if (item.model?.startsWith('component_') || item.model === 'section_group') {
				continue;
			}
			childrenList.push(item);
		}
	} else {
		childrenList = childrenRecursive;
	}

	// Rolling ar_parent chain over the section's own elements.
	const datalist: SecurityAccessDatalistItem[] = [];
	const arParent: string[] = [];
	for (const child of childrenList) {
		const position = arParent.indexOf(child.parent);
		if (position === -1) arParent.push(child.parent);
		else arParent.splice(position + 1);

		datalist.push({
			tipo: child.tipo,
			section_tipo: sectionTipo,
			model: child.model,
			label: child.label,
			parent: child.parent,
			ar_parent: [...arParent],
		});
	}

	return datalist;
}

// -----------------------------------------------------------------------------
// area::get_areas
// -----------------------------------------------------------------------------

/**
 * area::get_areas() — the ordered area/section list. Root area models in the
 * fixed menu order, each root's descendants via the include/exclude model walk,
 * then THE AREAS DENY LAW (concepts/area.ts applyAreasDeny — the menu's own
 * filter: a denied area hides itself and its whole subtree; guarded root
 * models never hidden).
 *
 * The root of each model is the FIRST node of that model in THE sibling order
 * (the snapshot's scan order — T2-SC-5b; PHP's `LIMIT 1` answered by heap
 * order), the row the menu picks too.
 */
async function getAreas(reader: SnapshotReader, denySet: ReadonlySet<string>): Promise<AreaObj[]> {
	const areas: AreaObj[] = [];

	const toAreaObj = async (tipo: string, parent: string | null): Promise<AreaObj> => ({
		tipo,
		model: await reader.modelOf(tipo),
		parent: parent ?? '',
		label: reader.labelOf(tipo),
	});

	// get_ar_children_areas_recursive: pre-order DFS, keeping nodes whose resolved
	// model is in include AND not in exclude; recursion descends only into kept nodes.
	const walkChildren = async (parentTipo: string): Promise<void> => {
		for (const childTipo of await reader.childrenOf(parentTipo)) {
			const model = (await reader.modelOf(childTipo)) ?? '';
			if (!AREA_CHILD_INCLUDE_MODELS.has(model) || AREA_CHILD_EXCLUDE_MODELS.has(model)) continue;
			areas.push(await toAreaObj(childTipo, reader.parentOf(childTipo) ?? parentTipo));
			await walkChildren(childTipo);
		}
	};

	for (const rootModel of MENU_ROOT_MODEL_ORDER) {
		const rootRow = reader.firstOfModel(rootModel);
		if (rootRow === null) continue; // model not defined on this install
		areas.push(await toAreaObj(rootRow.tipo, rootRow.parent));
		await walkChildren(rootRow.tipo);
	}

	return applyAreasDeny(areas, denySet);
}

// -----------------------------------------------------------------------------
// the caches
// -----------------------------------------------------------------------------

/**
 * The full (unfiltered) structure for one (application lang, effective deny):
 * the ordered area list plus each section area's element datalist (with its
 * section-local ar_parent chain). Every viewer's datalist is assembled from it.
 */
interface AreaTree {
	areas: readonly AreaObj[];
	elements: ReadonlyMap<string, readonly SecurityAccessDatalistItem[]>;
}

/**
 * LEVEL 1 — (lang, deny) → AreaTree. Pure ontology (+ the deny list, which is
 * IN the key because the runtime server-state override can change it without
 * an ontology write): hub-cleared on every dd_ontology write. Holds the
 * in-flight PROMISE, so concurrent cold reads share one build, and a clear
 * during a build evicts it (the late result is never stored).
 */
const areaTreeCache = createOntologyCache<string, Promise<AreaTree>>();

/**
 * LEVEL 2 — (lang, deny, viewer scope) → the finished, frozen datalist. The
 * scope is '*' for the unfiltered tree, else a sha256 of the viewer's granted
 * tipo set (getGrantedTipos — the exact input the filter reads), so two users
 * with the same grants share one entry and a grant change moves the viewer to
 * another key. Cleared on dd_ontology writes (the
 * factory) AND on every users/profiles record write (the listener below):
 * redundant for correctness, it keeps stale per-grant entries from piling up.
 * Bounded (oldest dropped first).
 */
const datalistCache = createOntologyCache<string, Promise<readonly SecurityAccessDatalistItem[]>>();
const MAX_DATALIST_ENTRIES = 32;

/** The users section — a write there can re-assign a profile (mirrors permissions.ts). */
const USERS_SECTION_TIPO = 'dd128';
registerSectionDataListener((sectionTipo) => {
	if (sectionTipo === USERS_SECTION_TIPO || sectionTipo === PROFILES_SECTION) {
		datalistCache.clear();
	}
});

/** Drop every ontology-derived cache of this module (hub-registered). */
export function clearSecurityAccessCaches(): void {
	childrenOfCache.clear();
	areaTreeCache.clear();
	datalistCache.clear();
}
registerOntologyCacheClearer(clearSecurityAccessCaches);

/**
 * Memoize a promise in a factory cache: stored synchronously (concurrent
 * callers share the build), dropped again if it rejects, and NEVER stored
 * inside a transaction (S1-14 — the build may read uncommitted ontology rows).
 */
function memoPromise<V>(
	cache: Map<string, Promise<V>>,
	key: string,
	build: () => Promise<V>,
	maxEntries = Number.POSITIVE_INFINITY,
): Promise<V> {
	if (isInTransaction()) return build();
	const cached = cache.get(key);
	if (cached !== undefined) return cached;
	if (cache.size >= maxEntries) {
		const oldest = cache.keys().next().value;
		if (oldest !== undefined) cache.delete(oldest);
	}
	const promise = build();
	cache.set(key, promise);
	promise.catch(() => {
		if (cache.get(key) === promise) cache.delete(key);
	});
	return promise;
}

/** Freeze a datalist item and its chain — a cached value is shared by every viewer. */
function freezeItem(item: SecurityAccessDatalistItem): SecurityAccessDatalistItem {
	Object.freeze(item.ar_parent);
	return Object.freeze(item);
}

async function buildAreaTree(lang: string, denySet: ReadonlySet<string>): Promise<AreaTree> {
	const reader = await loadOntologySnapshot(lang);
	const areas = await getAreas(reader, denySet);
	const elements = new Map<string, readonly SecurityAccessDatalistItem[]>();
	for (const area of areas) {
		if (area.model !== 'section' || elements.has(area.tipo)) continue;
		const list = await getElementDatalist(reader, area.tipo);
		for (const item of list) freezeItem(item);
		elements.set(area.tipo, Object.freeze(list));
	}
	return { areas: Object.freeze(areas.map((area) => Object.freeze(area))), elements };
}

/** get_datalist's area loop over an already-filtered area list. */
function assembleDatalist(
	tree: AreaTree,
	areas: readonly AreaObj[],
): readonly SecurityAccessDatalistItem[] {
	const datalist: SecurityAccessDatalistItem[] = [];
	const arCheck = new Set<string>();
	const arParent: string[] = [];

	for (const area of areas) {
		const sectionTipo = area.tipo; // same as tipo for an area

		// dedup by `tipo_parent`.
		const duplicateKey = `${sectionTipo}_${area.parent}`;
		if (arCheck.has(duplicateKey)) continue;
		arCheck.add(duplicateKey);

		// rolling ancestor chain.
		const position = arParent.indexOf(area.parent);
		if (position === -1) arParent.push(area.parent);
		else arParent.splice(position + 1);

		datalist.push(
			freezeItem({
				tipo: area.tipo,
				section_tipo: sectionTipo,
				model: area.model,
				label: area.label,
				parent: area.parent,
				ar_parent: [...arParent],
			}),
		);

		// section case: add its recursive elements, prefixing the area-level chain.
		if (area.model === 'section') {
			for (const child of tree.elements.get(area.tipo) ?? []) {
				datalist.push(freezeItem({ ...child, ar_parent: [...arParent, ...child.ar_parent] }));
			}
		}
	}

	return Object.freeze(datalist);
}

// -----------------------------------------------------------------------------
// get_datalist
// -----------------------------------------------------------------------------

/**
 * Build the ontology ACL datalist, exactly reproducing PHP
 * component_security_access::get_datalist($user_id): the unfiltered tree for a
 * global admin, and for anyone else only the areas whose tipo appears in their
 * own dd774 data (see the module header). `viewer` defaults to the current
 * request's principal; undefined on both means no filter. `lang` (the label
 * language) defaults to the request's application lang and is a cache-key
 * dimension, passed explicitly below.
 *
 * The result is CACHED and FROZEN (shared by every viewer with the same
 * grants): treat it as read-only.
 */
export async function getSecurityAccessDatalist(
	viewer?: Principal,
	lang: string = currentApplicationLang(),
): Promise<readonly SecurityAccessDatalistItem[]> {
	const deny = getEffectiveAreasDeny(config.menu.areasDeny);
	const treeKey = `${lang}\u0000${[...deny].sort().join(',')}`;

	// PHP get_datalist:203-236 — the non-global-admin narrowing. The grants are
	// read BEFORE the cache lookup so the key is complete up front: the level-1
	// tree is awaited INSIDE the level-2 build, so a hub clear landing during
	// the build evicts that build's promise instead of letting a datalist
	// assembled from a pre-clear tree be stored into the fresh cache.
	const principal = viewer ?? currentPrincipal();
	let granted: ReadonlySet<string> | null = null;
	let scope = '*';
	if (principal !== undefined && !principal.isGlobalAdmin) {
		granted = await getGrantedTipos(principal.userId);
		scope = createHash('sha256')
			.update([...granted].sort().join('\u0000'))
			.digest('hex');
	}
	return memoPromise(
		datalistCache,
		`${treeKey}\u0000${scope}`,
		async () => {
			const tree = await memoPromise(areaTreeCache, treeKey, () =>
				buildAreaTree(lang, new Set(deny)),
			);
			const areas =
				granted === null ? tree.areas : tree.areas.filter((area) => granted.has(area.tipo));
			return assembleDatalist(tree, areas);
		},
		MAX_DATALIST_ENTRIES,
	);
}
