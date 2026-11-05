/**
 * Menu tree_datalist resolver — the flat, permission-filtered list of navigation
 * nodes the client renders as the application menu (PHP menu::get_tree_datalist,
 * backed by area::get_areas). It is the last piece of the client cold-boot
 * sequence (start → read(menu) → read(section) → count).
 *
 * WHAT IT PRODUCES
 * A flat array of `{tipo, model, parent, label}` items. It is flat but encodes a
 * tree through `parent` (same pattern as ddo_map): the client rebuilds the tree
 * by matching each item's `parent` to another item's `tipo`.
 *
 * THE WALK (area::get_areas)
 * 1. Root areas: one node per area root model, in a FIXED order (area_root,
 *    area_activity, area_resource, area_tool, area_thesaurus, area_graph,
 *    area_admin, area_maintenance, area_development, area_ontology).
 * 2. Under each root, a depth-first pre-order walk of ontology children ordered
 *    by `order_number`, keeping only nodes whose model is area/section/
 *    section_tool (and never login/tools/section_list/filter). Recursion only
 *    descends into kept nodes.
 * 3. Deny list (config `areas.deny`) removes specific tipos from the result but
 *    keeps their descendants (PHP checks deny only when ADDING a node, never
 *    when recursing).
 *
 * THE MENU FILTER (menu::get_tree_datalist)
 * 4. skip_tipos: grouping wrappers hidden from the menu. A skipped node is
 *    dropped, but its children are RE-PARENTED to the first non-skipped ancestor
 *    (get_my_parent walks up the skip chain).
 * 5. Labels resolve from the ontology `term` map in the application language,
 *    with the PHP fallback (structure lang, then any non-empty term).
 *
 * SCOPE — both viewer paths: admin+developer receives the walk unfiltered;
 * any other viewer gets the PHP permission filter (self-key-authorized areas
 * from their dd774 table; dd88 additionally needs admin-or-developer, dd770
 * developer) applied per node before the menu transforms.
 *
 * REWRITES (PHP menu switch cases, all implemented):
 * - section_tool nodes WITH a `tool_config`: tipo/model rewritten to the
 *   target section and a tool_context (the tool's simple context + the
 *   enriched tool_config, ddo_map 'self' resolution + model/translatable/
 *   label stamps) injected into config. A node whose named tool is not in the
 *   VIEWER's user_tools is dropped like PHP does — but recorded in `skipped`.
 * - the two thesaurus VIRTUAL areas (hierarchy56/hierarchy57): model becomes
 *   area_thesaurus with the swap_tipo (dd100) config; hierarchy57 adds the
 *   model view mode + url_vars.
 */

import { config } from '../../../config/config.ts';
import {
	AREA_CHILD_EXCLUDE_MODELS,
	AREA_CHILD_INCLUDE_MODELS,
	AREA_ONTOLOGY_TIPO,
	areaBehaviorOf,
	isAreaModel,
	MENU_ROOT_MODEL_ORDER,
} from '../../concepts/area.ts';
import { sql } from '../../db/postgres.ts';
import { createOntologyCache } from '../../ontology/cache_factory.ts';
import { registerOntologyCacheClearer } from '../../ontology/cache_invalidation.ts';
import { resolveLabel } from '../../ontology/labels.ts';
import { getModelByTipo } from '../../ontology/resolver.ts';
import { canAccessOntologyArea } from '../../security/permissions.ts';
import { buildSectionToolContext } from '../../tools/section_tool_context.ts';

/** One navigation node (PHP tree_datalist item). */
export interface MenuTreeItem {
	tipo: string;
	model: string;
	/** Visible parent tipo after skip re-parenting (null for a top root). */
	parent: string | null;
	label: string;
	/** Rewrite payload (section_tool tool_context / thesaurus swap_tipo). */
	config?: Record<string, unknown>;
}

export interface MenuTreeResult {
	tree_datalist: MenuTreeItem[];
	/** Tipos deliberately not emitted (need the tools/virtual-area subsystems). */
	skipped: { tipo: string; reason: string }[];
}

/**
 * Area root models (menu order) + the child walk-filter sets now live in the
 * area contract (concepts/area.ts) so the taxonomy has one home. Aliased locally
 * to keep this walk readable. MENU_ROOT_MODEL_ORDER still carries area_graph
 * (the PHP walk order, the config_areas catalog), but the tree_datalist does NOT
 * emit it: a behaviorless area model is a doorway the read refuses
 * (WC-2026-11-01-menu-dead-area).
 */
const ROOT_AREA_MODELS = MENU_ROOT_MODEL_ORDER;

/**
 * A doorway the read refuses: an area model with no behavior resolver
 * (area_graph — dead, engineering/AREA_SPEC.md) answers every read with
 * request.invalid_model, so a menu entry for it is a dead link for every viewer.
 * The WALK keeps it (root order, config_areas catalog, permissions); only the
 * menu drops it (WC-2026-11-01-menu-dead-area).
 */
function isDeadAreaDoorway(model: string): boolean {
	return isAreaModel(model) && areaBehaviorOf(model) === null;
}

/**
 * The areas the menu may render: every dead doorway that is not a skipped
 * grouping wrapper (those render nothing anyway) is dropped and RECORDED in
 * `skipped`. Order is preserved.
 */
function withoutDeadAreaDoorways(
	areas: AreaNode[],
	skipTipos: ReadonlySet<string>,
	skipped: { tipo: string; reason: string }[],
): AreaNode[] {
	return areas.filter((area) => {
		if (skipTipos.has(area.tipo) || !isDeadAreaDoorway(area.model)) return true;
		skipped.push({ tipo: area.tipo, reason: `area model '${area.model}' has no behavior` });
		return false;
	});
}
const CHILDREN_INCLUDE_MODELS = AREA_CHILD_INCLUDE_MODELS;
const CHILDREN_EXCLUDE_MODELS = AREA_CHILD_EXCLUDE_MODELS;

/** Thesaurus virtual areas (PHP dd_tipos constants) + the real thesaurus tipo. */
const THESAURUS_VIRTUALS_AREA_TIPO = 'hierarchy56';
const THESAURUS_VIRTUALS_MODELS_AREA_TIPO = 'hierarchy57';
const THESAURUS_TIPO = 'dd100';
/** Areas with fixed role gates in the menu filter (PHP dd_tipos constants). */
const MAINTENANCE_AREA_TIPO_MENU = 'dd88';
const DEVELOPMENT_AREA_TIPO = 'dd770';

/** One raw ontology row used by the walk. */
interface OntologyAreaRow {
	tipo: string;
	model: string;
	parent: string | null;
	order_number: number | null;
	id: number;
	term: Record<string, string> | null;
	properties: { tool_config?: unknown } | null;
}

/** An area node collected by the ontology walk (PHP area object). */
interface AreaNode {
	tipo: string;
	model: string;
	parent: string | null;
	label: string;
	/** Raw ontology properties (tool_config/config for section_tool rewrites). */
	properties: { tool_config?: unknown; config?: unknown } | null;
}

/**
 * Cached ordered area walk (singleton key). The rows carry RAW `term` lang-maps
 * — label resolution (resolveLabel, per-request application lang) happens
 * downstream on every call, so the key needs NO lang dimension. Consumers must
 * treat the rows as READ-ONLY (the section_tool enrichment deep-clones
 * tool_config before enriching). The section_tool term-row cache moved to
 * ontology/labels.ts (getOntologyTermLabel, cleared with clearLabelCache) —
 * via term_label.ts 2026-07-10, folded into labels.ts 2026-11-04.
 */
const areaWalkCache = createOntologyCache<'walk', OntologyAreaRow[]>();

export function clearAreaWalkCache(): void {
	areaWalkCache.clear();
}
registerOntologyCacheClearer(clearAreaWalkCache);

/**
 * The raw ordered area walk shared by the menu (deny-filters it) and the
 * config_areas/menu_skip_tipos widget catalogs (which must see EVERYTHING):
 * roots in the fixed model order, then a depth-first pre-order walk of the
 * include/exclude-filtered ontology children. No deny filter here.
 *
 * Exported for the hub-completion identity probe
 * (test/unit/ontology_cache_hub_completion.test.ts) — production callers are
 * getOntologyAreas/getAllAreas in this module.
 */
export async function collectAreaRows(): Promise<OntologyAreaRow[]> {
	const cached = areaWalkCache.get('walk');
	if (cached !== undefined) return cached;

	// One bulk read of every node that can appear in (or be a root of) the menu,
	// then walk it in memory — far cheaper than a query per node.
	const wantedModels = [...ROOT_AREA_MODELS, ...CHILDREN_INCLUDE_MODELS];
	const placeholders = wantedModels.map((_, index) => `$${index + 1}`).join(', ');
	const rows = (await sql.unsafe(
		`SELECT tipo, model, parent, order_number, id, term, properties
		 FROM dd_ontology
		 WHERE model IN (${placeholders})`,
		wantedModels,
	)) as OntologyAreaRow[];

	const childrenByParent = new Map<string, OntologyAreaRow[]>();
	for (const row of rows) {
		if (row.parent === null) continue;
		const siblings = childrenByParent.get(row.parent);
		if (siblings === undefined) childrenByParent.set(row.parent, [row]);
		else siblings.push(row);
	}
	// Sibling order: order_number, then id as a stable tie-breaker (PHP walks the
	// ontology children in stored tree order, which order_number encodes).
	for (const siblings of childrenByParent.values()) {
		siblings.sort((a, b) => (a.order_number ?? 0) - (b.order_number ?? 0) || a.id - b.id);
	}

	const collected: OntologyAreaRow[] = [];

	// Depth-first pre-order over the kept children (recursion descends only into
	// nodes whose model passes the include/exclude filter).
	const walkChildren = async (parentTipo: string): Promise<void> => {
		const children = childrenByParent.get(parentTipo) ?? [];
		for (const child of children) {
			const runtimeModel = (await getModelByTipo(child.tipo)) ?? child.model;
			if (!CHILDREN_INCLUDE_MODELS.has(runtimeModel) || CHILDREN_EXCLUDE_MODELS.has(runtimeModel)) {
				continue;
			}
			collected.push(child);
			await walkChildren(child.tipo);
		}
	};

	// Roots in the fixed model order; each root is a singleton in the ontology.
	for (const rootModel of ROOT_AREA_MODELS) {
		const rootRow = rows.find((row) => row.model === rootModel);
		if (rootRow === undefined) continue; // model not defined on this install
		collected.push(rootRow);
		await walkChildren(rootRow.tipo);
	}

	areaWalkCache.set('walk', collected);
	return collected;
}

/**
 * Walk the ontology into the ordered, model-filtered, deny-filtered flat list of
 * area nodes (PHP area::get_areas), unfiltered by per-area permissions
 * (superuser path).
 */
async function getOntologyAreas(): Promise<AreaNode[]> {
	const collected = await collectAreaRows();

	const { getEffectiveAreasDeny } = await import('../../resolve/server_state.ts');
	const denySet = new Set(getEffectiveAreasDeny(config.menu.areasDeny));

	// Deny removes the specific node but not its already-collected descendants.
	return collected
		.filter((row) => !denySet.has(row.tipo))
		.map((row) => ({
			tipo: row.tipo,
			model: row.model,
			parent: row.parent,
			label: resolveLabel(row.term) ?? '',
			properties: row.properties as AreaNode['properties'],
		}));
}

/** One node of the UNfiltered area catalog (PHP area::build_area_state_node). */
export interface AreaStateNode {
	tipo: string;
	model: string;
	parent: string | null;
	label: string;
	denied: boolean;
	allowed: boolean;
}

/**
 * The UNfiltered counterpart of the menu walk (PHP area::get_all_areas): the
 * same roots + recursive children but skipping NOTHING — no deny filter, no
 * skip_tipos, no section_tool/thesaurus rewrites — with each node's current
 * denied/allowed state stamped so the config_areas/menu_skip_tipos widgets can
 * show (and re-enable) currently hidden areas.
 */
export async function getAllAreas(): Promise<AreaStateNode[]> {
	const collected = await collectAreaRows();
	const { getEffectiveAreasDeny, getEffectiveAreasAllow } = await import(
		'../../resolve/server_state.ts'
	);
	const denySet = new Set(getEffectiveAreasDeny(config.menu.areasDeny));
	const allowSet = new Set(getEffectiveAreasAllow());
	return collected.map((row) => ({
		tipo: row.tipo,
		model: row.model,
		parent: row.parent,
		label: resolveLabel(row.term) ?? '',
		denied: denySet.has(row.tipo),
		allowed: allowSet.has(row.tipo),
	}));
}

/**
 * Resolve the visible parent tipo, walking up through any skipped ancestors
 * (PHP menu::get_my_parent). Iterative to avoid deep recursion on long chains.
 */
function getVisibleParent(node: AreaNode, skipByTipo: Map<string, AreaNode>): string | null {
	let parentTipo = node.parent;
	while (parentTipo !== null && skipByTipo.has(parentTipo)) {
		const skipped = skipByTipo.get(parentTipo);
		if (skipped === undefined) break;
		parentTipo = skipped.parent;
	}
	return parentTipo;
}

/**
 * Build the menu tree_datalist for the superuser path (see module doc for the
 * scope and ledger).
 */
export async function getMenuTreeDatalist(viewer?: {
	userId: number;
	isGlobalAdmin: boolean;
	isDeveloper: boolean;
}): Promise<MenuTreeResult> {
	let areas = await getOntologyAreas();
	const allAreasByTipo = new Map(areas.map((area) => [area.tipo, area]));

	// Non-(admin AND developer) viewers get the FILTERED menu (PHP
	// get_tree_datalist): EVERY area must be self-key-authorized in the viewer's
	// permissions table; the maintenance area additionally needs
	// admin-or-developer and the development area developer. The role is a
	// precondition, never a grant (PHP `continue`s past the role check into the
	// same authorized lookup) — offering dd88 on the flag alone showed a non-root
	// admin an entry getPermissions then refused. PHP applies the filter per
	// node (children of a dropped area were collected independently and survive
	// on their own authorization).
	if (viewer !== undefined && !(viewer.isGlobalAdmin && viewer.isDeveloper)) {
		const { getAuthorizedAreaTipos } = await import('../../security/permissions.ts');
		const authorized = await getAuthorizedAreaTipos(viewer.userId);
		areas = areas.filter((area) => {
			if (
				area.tipo === MAINTENANCE_AREA_TIPO_MENU &&
				!viewer.isGlobalAdmin &&
				!viewer.isDeveloper
			) {
				return false;
			}
			if (area.tipo === DEVELOPMENT_AREA_TIPO && !viewer.isDeveloper) {
				return false;
			}
			return authorized.has(area.tipo);
		});
	}

	// area_ontology (dd5): the SAME rule as the area read (engineering/AREA_SPEC.md §9,
	// canAccessOntologyArea) — superuser, or global admin whose profile grants
	// dd5. Runs independently: the admin+developer path above skips the filter.
	// An undefined viewer is the internal/superuser tree.
	if (viewer !== undefined && !(await canAccessOntologyArea(viewer))) {
		areas = areas.filter((area) => area.tipo !== AREA_ONTOLOGY_TIPO);
	}

	const { getEffectiveMenuSkipTipos } = await import('../../resolve/server_state.ts');
	const skipTipos = new Set(getEffectiveMenuSkipTipos(config.menu.skipTipos));

	// Skip parents (for re-parenting) vs the areas actually rendered.
	const skipByTipo = new Map<string, AreaNode>();
	for (const area of areas) {
		if (skipTipos.has(area.tipo)) skipByTipo.set(area.tipo, area);
	}

	const tree_datalist: MenuTreeItem[] = [];
	const skipped: { tipo: string; reason: string }[] = [];
	// A doorway the read refuses is not offered; it is recorded in `skipped`.
	const offered = withoutDeadAreaDoorways(areas, skipTipos, skipped);

	for (const area of offered) {
		if (skipTipos.has(area.tipo)) continue; // a grouping wrapper — not rendered

		const parent = getVisibleParent(area, skipByTipo);

		// section_tool rewrite: an ontological alias for a real section rendered
		// through a specific tool. PHP rewrites tipo/model to the target section
		// and injects a tool_context so the client activates the tool.
		const toolConfigBag = area.properties?.tool_config as Record<string, unknown> | undefined;
		if (area.model === 'section_tool' && toolConfigBag != null) {
			const item = await buildSectionToolItem(area, parent, toolConfigBag, viewer);
			if (item === null) {
				// The named tool is not installed/authorized — PHP silently drops
				// the entry; we drop AND record it.
				skipped.push({ tipo: area.tipo, reason: 'section_tool: tool not in user_tools' });
			} else {
				tree_datalist.push(item);
			}
			continue;
		}

		// Thesaurus virtual areas: no real section — the client renders them via
		// 'area_thesaurus' with swap_tipo (and model view mode on hierarchy57).
		if (area.tipo === THESAURUS_VIRTUALS_AREA_TIPO) {
			tree_datalist.push({
				tipo: area.tipo,
				model: 'area_thesaurus',
				parent,
				label: area.label,
				config: { swap_tipo: THESAURUS_TIPO },
			});
			continue;
		}
		if (area.tipo === THESAURUS_VIRTUALS_MODELS_AREA_TIPO) {
			tree_datalist.push({
				tipo: area.tipo,
				model: 'area_thesaurus',
				parent,
				label: area.label,
				config: {
					thesaurus_view_mode: 'model',
					swap_tipo: THESAURUS_TIPO,
					url_vars: { thesaurus_view_mode: 'model' },
				},
			});
			continue;
		}

		tree_datalist.push({
			tipo: area.tipo,
			model: area.model,
			parent,
			label: area.label,
		});
	}

	return { tree_datalist: reattachOrphans(tree_datalist, allAreasByTipo, skipped), skipped };
}

/** Areas a ROLE gates (not only a grant): what sits under them stays hidden with them. */
const ROLE_GATED_AREA_TIPOS: ReadonlySet<string> = new Set([
	AREA_ONTOLOGY_TIPO,
	DEVELOPMENT_AREA_TIPO,
	MAINTENANCE_AREA_TIPO_MENU,
]);

/**
 * ORPHANS — an entry the viewer holds whose parent area was filtered out. The client builds
 * the tree from the roots down, so left as is the entry is unreachable (a grant with no menu
 * entry). Under a dropped ROLE-gated area it is dropped too (and recorded); otherwise it is
 * re-parented to its nearest visible ancestor, or the top level (WC-2026-10-28-menu-orphans).
 */
export function reattachOrphans(
	items: MenuTreeItem[],
	allAreasByTipo: ReadonlyMap<string, AreaNode>,
	skipped: { tipo: string; reason: string }[],
): MenuTreeItem[] {
	const listed = new Set(items.map((item) => item.tipo));
	// first the drops, at ANY depth: a visible ancestor between the item and the hidden
	// role-gated area does not save it (that ancestor is dropped too)
	const dropped = new Set(
		items
			.filter((item) => underHiddenRoleArea(item.parent, listed, allAreasByTipo))
			.map((i) => i.tipo),
	);
	const visible = new Set([...listed].filter((tipo) => !dropped.has(tipo)));
	const kept: MenuTreeItem[] = [];
	for (const item of items) {
		if (dropped.has(item.tipo)) {
			skipped.push({ tipo: item.tipo, reason: 'under a role-gated area the viewer lacks' });
			continue;
		}
		const anchor = visibleAnchor(item.parent, visible, allAreasByTipo);
		kept.push(anchor === item.parent ? item : { ...item, parent: anchor });
	}
	return kept;
}

function underHiddenRoleArea(
	parent: string | null,
	listed: ReadonlySet<string>,
	allAreasByTipo: ReadonlyMap<string, AreaNode>,
): boolean {
	for (let tipo = parent; tipo !== null; tipo = allAreasByTipo.get(tipo)?.parent ?? null) {
		if (ROLE_GATED_AREA_TIPOS.has(tipo) && !listed.has(tipo)) return true;
	}
	return false;
}

/**
 * The nearest visible ancestor (null = top level; a non-area parent is returned as is). Skip
 * wrappers are walked through.
 */
function visibleAnchor(
	parent: string | null,
	visible: ReadonlySet<string>,
	allAreasByTipo: ReadonlyMap<string, AreaNode>,
): string | null {
	let tipo = parent;
	// a parent that is no area at all (the menu's own roots) is kept as it is
	while (tipo !== null && !visible.has(tipo) && allAreasByTipo.has(tipo)) {
		tipo = allAreasByTipo.get(tipo)?.parent ?? null;
	}
	return tipo;
}

/**
 * Build the rewritten datalist item for one section_tool area (PHP menu
 * section_tool case + tool_common::create_tool_simple_context tool_config
 * enrichment, shared via tools/section_tool_context.ts). Returns null when the
 * named tool is not in the VIEWER's tools.
 *
 * PHP resolves the named tool against `tool_common::get_user_tools(
 * logged_user_id())` (class.menu.php:231) — the CALLER's list, not the
 * superuser's — and PHP's unfiltered branch is `$user_id == DEDALO_SUPERUSER`
 * ALONE (tools/tool_common/class.tool_common.php:1403). A global-admin FLAG
 * grants no tool: an admin whose profile does not grant it loses the menu entry
 * exactly like anyone else. `viewer === undefined` is the internal/superuser
 * tree (the catalog callers), which keeps the unfiltered list.
 *
 * That rule now lives in ONE place — `tools/registry.ts` getUserTools, which
 * tests `userId === SUPERUSER_ID` itself (audit OH1 finding 5, landed
 * 2026-08-09). This door therefore just names the viewer; it used to pass the
 * rule as the second argument because getUserTools opened with
 * `if (isGlobalAdmin) return getSuperuserUserTools()` and the fix could only be
 * made locally. Gated from both sides in
 * test/unit/oh1_permissions_native.test.ts (superuser keeps the entry; a
 * non-superuser global admin without the profile grant loses it).
 */
async function buildSectionToolItem(
	area: AreaNode,
	parent: string | null,
	toolConfigBag: Record<string, unknown>,
	viewer?: { userId: number },
): Promise<MenuTreeItem | null> {
	const { getSuperuserUserTools, getUserTools } = await import('../../tools/registry.ts');
	const viewerTools =
		viewer === undefined ? await getSuperuserUserTools() : await getUserTools(viewer.userId);
	const toolContext = await buildSectionToolContext(toolConfigBag, viewerTools);
	if (toolContext === null) return null;

	const areaConfig = (area.properties?.config ?? {}) as Record<string, unknown>;
	const targetSectionTipo =
		typeof areaConfig.target_section_tipo === 'string' ? areaConfig.target_section_tipo : area.tipo;

	return {
		tipo: targetSectionTipo,
		model: 'section',
		parent,
		label: area.label,
		config: {
			...areaConfig,
			tool_context: toolContext,
		},
	};
}
