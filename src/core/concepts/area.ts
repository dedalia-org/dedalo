/**
 * AREA — the non-data grouping definition (spec engineering/AREA_SPEC.md §1-2).
 *
 * An area is an ontology `model` that groups sections (the main data
 * definitions) or other areas; together the areas describe the shape of the
 * cultural-heritage organization (tangible, intangible, activities, …). An area
 * has a `tipo` but NO `section_id` and NO matrix row: `get_section_id()` is a
 * null shim, `get_matrix_table_from_tipo()` is null for area models. All areas
 * extend the PHP `area_common` base.
 *
 * PHP reference: core/area/class.area.php, core/area_common/class.area_common.php,
 * area tipo constants in core/base/dd_tipos.php.
 *
 * Contract highlights the rewrite MUST preserve:
 * - The area family partitions by BEHAVIOR, not by whether the class body is
 *   empty. `area` (the plain grouper, 71 live nodes) and the seven "no special
 *   behavior" stubs (root/admin/activity/resource/tool/publication/development)
 *   all render the DASHBOARD (statistics of the sections inside — §4). The two
 *   tree areas (thesaurus, ontology) render the ts_object hierarchy (§5).
 *   area_maintenance is its own widget dashboard (done; boundary only).
 * - The walk that finds "the sections inside" (PHP area::get_areas /
 *   area_common::get_dashboard_child_sections) INCLUDES area/section/section_tool
 *   and NEVER descends login/tools/section_list/filter (the deliberate `modelo`
 *   typo in the PHP property name is not significant here).
 * - The menu root order is a FIXED model order (PHP get_ar_root_area_tipos) and
 *   still carries `area_graph` even though the rewrite drops area_graph as a
 *   behavior (dead — user decision): the walk (and the config_areas catalog)
 *   keeps PHP's root order, but the menu tree_datalist does NOT emit a
 *   behaviorless area (WC-2026-11-01-menu-dead-area). That is why
 *   MENU_ROOT_MODEL_ORDER (walk ordering) and AREA_MODELS (behavior-carrying
 *   set) are DIFFERENT lists.
 *
 * WHERE THE ENGINE LIVES: this module is the PURE contract (model taxonomy,
 * walk-filter sets, tipo constants, predicates). The I/O-bearing resolvers live
 * in src/core/area/ (tree.ts, read.ts, and — Phase B — dashboard.ts), dispatched
 * through src/core/area/registry.ts. Kill every `startsWith('area')` sniff in
 * favor of isAreaModel() / areaBehaviorOf() so the taxonomy has ONE home.
 */

import { canonicalizeStoredSectionId, isSectionId } from './section_id.ts';

/** How an area model resolves its `read` payload. */
export type AreaBehavior = 'dashboard' | 'tree' | 'maintenance';

/**
 * The canonical set of area MODELS the rewrite covers, by behavior. This is the
 * single source of truth for "what is an area model" (spec §12 gate 6):
 * area_publication is present; area_graph is deliberately ABSENT (dead — it has
 * no behavior resolver and a read of it is ledgered/refused, not dashboarded).
 * area_maintenance is present but its behavior is owned by the widget subsystem.
 */
const AREA_BEHAVIOR: ReadonlyMap<string, AreaBehavior> = new Map<string, AreaBehavior>([
	// plain grouper + the seven no-special-behavior stubs → the dashboard
	['area', 'dashboard'],
	['area_root', 'dashboard'],
	['area_admin', 'dashboard'],
	['area_activity', 'dashboard'],
	['area_resource', 'dashboard'],
	['area_tool', 'dashboard'],
	['area_publication', 'dashboard'],
	['area_development', 'dashboard'],
	// tree areas (ts_object hierarchy)
	['area_thesaurus', 'tree'],
	['area_ontology', 'tree'],
	// widget dashboard (separate subsystem)
	['area_maintenance', 'maintenance'],
]);

/** The behavior-carrying area models (area_graph excluded — see module doc). */
export const AREA_MODELS: ReadonlySet<string> = new Set(AREA_BEHAVIOR.keys());

/**
 * Whether a model is an area model. Matches every real area model ('area' and
 * 'area_*') — behavior-identical to the former `startsWith('area')` sniffs on
 * real ontology data, without matching hypothetical non-area 'area…' strings.
 */
export function isAreaModel(model: string): boolean {
	return model === 'area' || model.startsWith('area_');
}

/**
 * The behavior resolver key for an area model, or null for area models the
 * rewrite does not cover as areas (e.g. area_graph — dead). Callers that need a
 * behavior for an UNKNOWN area model should treat null as "uncovered scope"
 * (fail loud / ledger), never silently dashboard it.
 */
export function areaBehaviorOf(model: string): AreaBehavior | null {
	return AREA_BEHAVIOR.get(model) ?? null;
}

/**
 * Area root models in the exact MENU order (PHP get_ar_root_area_tipos). Carries
 * area_graph for the walk order even though the rewrite drops it as a behavior
 * and the menu tree_datalist does not emit it (see module doc).
 */
export const MENU_ROOT_MODEL_ORDER: readonly string[] = [
	'area_root',
	'area_activity',
	'area_resource',
	'area_tool',
	'area_thesaurus',
	'area_graph',
	'area_admin',
	'area_maintenance',
	'area_development',
	'area_ontology',
];

/** Models a menu/dashboard descendant may have (PHP area::$ar_children_include_model_name). */
export const AREA_CHILD_INCLUDE_MODELS: ReadonlySet<string> = new Set([
	'area',
	'section',
	'section_tool',
]);

/** Models never walked into as area children (PHP area::$ar_children_exclude_modelo_name). */
export const AREA_CHILD_EXCLUDE_MODELS: ReadonlySet<string> = new Set([
	'login',
	'tools',
	'section_list',
	'filter',
]);

// --- THE AREAS DENY LAW (T2-O15-1, owner ruling Q4 (b), 2026-11-19) ---------

/**
 * Area models no deny can hide (ANTI-LOCKOUT): denying the root, the admin
 * area or the maintenance area would remove the very dashboard that undoes
 * the denial. ONE list for both deny sources — the config_areas save strips
 * them (`removed_guarded`), and {@link applyAreasDeny} ignores them in the
 * STATIC `AREAS_DENY` too, which no save ever validated.
 */
export const AREAS_DENY_GUARDED_MODELS: ReadonlySet<string> = new Set([
	'area_root',
	'area_maintenance',
	'area_admin',
]);

/** One walked area row as the deny law reads it (the menu walk and the permissions tree). */
export interface AreaDenyRow {
	tipo: string;
	model: string | null;
	/** The walk parent ('' / null / a non-walked tipo end the chain). */
	parent: string | null;
}

/**
 * THE AREAS DENY LAW — the ONE filter the menu (api/handlers/menu.ts) and the
 * permissions tree (resolve/security_access_datalist.ts) apply to their area
 * walk, so the two answer identically (gate: menu_tree_datalist_native).
 *
 * A denied area hides ITSELF AND ITS WHOLE SUBTREE, at every depth (owner
 * ruling Q4 (b); PHP dropped a denied ROOT's descendants but kept a denied
 * child's, and the TS walk used to keep both — WC-2026-11-22-areas-deny-subtree).
 * A row whose model is guarded ({@link AREAS_DENY_GUARDED_MODELS}) is never
 * hidden — not by its own deny, not by an ancestor's — and what it hides below
 * it is decided from it again (the guard breaks the inherited chain).
 *
 * `rows` is a walk in any order: the chain is followed through `parent` over
 * the rows themselves (a parent that is not a row ends it), with a cycle guard.
 * Order is preserved.
 */
export function applyAreasDeny<Row extends AreaDenyRow>(
	rows: readonly Row[],
	deny: ReadonlySet<string>,
): Row[] {
	if (deny.size === 0) return [...rows];
	const byTipo = new Map<string, Row>();
	for (const row of rows) if (!byTipo.has(row.tipo)) byTipo.set(row.tipo, row);
	const memo = new Map<string, boolean>();
	return rows.filter((row) => !isDeniedRow(row, byTipo, deny, memo));
}

/** One row's answer: climb to the first known (or the chain's end), then decide downwards. */
function isDeniedRow<Row extends AreaDenyRow>(
	start: Row,
	byTipo: ReadonlyMap<string, Row>,
	deny: ReadonlySet<string>,
	memo: Map<string, boolean>,
): boolean {
	const { chain, inherited } = climbUndecided(start, byTipo, memo);
	let answer = inherited;
	for (let index = chain.length - 1; index >= 0; index--) {
		const row = chain[index] as Row;
		// a guarded row is never hidden, and breaks the inherited chain below it
		answer = !isAreasDenyGuarded(row.model) && (answer || deny.has(row.tipo));
		memo.set(row.tipo, answer);
	}
	return answer;
}

/** The rows from `start` up to the first one already decided (cycle-safe), and that answer. */
function climbUndecided<Row extends AreaDenyRow>(
	start: Row,
	byTipo: ReadonlyMap<string, Row>,
	memo: ReadonlyMap<string, boolean>,
): { chain: Row[]; inherited: boolean } {
	const chain: Row[] = [];
	const seen = new Set<string>();
	let row: Row | undefined = start;
	while (row !== undefined && !memo.has(row.tipo) && !seen.has(row.tipo)) {
		seen.add(row.tipo);
		chain.push(row);
		row = walkParent(row, byTipo);
	}
	// a cycle (seen, undecided) inherits nothing: nothing above it decides
	return { chain, inherited: memo.get(row?.tipo ?? '') === true };
}

/** The walked parent row, or undefined at the chain's end. */
function walkParent<Row extends AreaDenyRow>(
	row: Row,
	byTipo: ReadonlyMap<string, Row>,
): Row | undefined {
	return row.parent === null ? undefined : byTipo.get(row.parent);
}

/** Whether a row of this model is out of every deny's reach (anti-lockout). */
export function isAreasDenyGuarded(model: string | null): boolean {
	return model !== null && AREAS_DENY_GUARDED_MODELS.has(model);
}

/**
 * The dashboard section walk excludes section_tool on TOP of the menu exclude
 * set (PHP get_dashboard_child_sections exclude list) — the dashboard counts
 * plain data sections, not tool faces. Menu items keep section_tool (they become
 * navigable tool deep links).
 */
export const DASHBOARD_CHILD_EXCLUDE_MODELS: ReadonlySet<string> = new Set([
	...AREA_CHILD_EXCLUDE_MODELS,
	'section_tool',
]);

// --- the relation-mode picker contract (spec engineering/AREA_SPEC.md §5) ----

/**
 * How a tree area serves its terms.
 *
 * `default` browses: a term click navigates into the term. `relation` is the
 * PICKER: the tree is open so that a term can be LINKED back into the
 * component that opened it, and a term click publishes the pick instead of
 * navigating.
 *
 * RELATION MODE IS GRANTED, NEVER DECLARED. The request names its CALLER (see
 * {@link PickerCaller}) and the server derives the mode from that caller's
 * resolved ontology view, model and the principal's edit grant — a client
 * string never selects it. PHP folded a `thesaurus_mode` URL var straight onto
 * the page context, which let any request open relation mode on any thesaurus
 * with no caller that ever declared the picker view.
 */
export type ThesaurusMode = 'default' | 'relation';

/**
 * The ontology `properties.view` value with which a relation component declares
 * that its target opens as a picker (resolved through the ordinary structure
 * context, so a ddo_map-injected view counts exactly the same).
 */
export const PICKER_CALLER_VIEW = 'tree';

/**
 * The grant a caller needs before relation mode is granted: EDIT. A picker
 * exists to write a locator into the caller, so read-level access to it buys a
 * browsable tree and nothing more.
 */
export const PICKER_CALLER_MIN_PERMISSIONS = 2;

/**
 * The caller a picker read declares: the component instance the picked term
 * will be linked INTO. It is an ADDRESS, nothing else — every conclusion (mode,
 * target sections, selection cap) is derived from it server-side.
 */
export interface PickerCaller {
	/** The section the caller component lives in. */
	section_tipo: string;
	/** The record the caller component sits on — capacity is a fact of the record. */
	section_id: number;
	/** The caller component's own tipo. */
	tipo: string;
}

/**
 * Shape-validate `rqo.source.caller`. Returns the caller, or null when the
 * value is not one — the read refuses with
 * {@link PICKER_CALLER_MALFORMED_MESSAGE} rather than guessing.
 *
 * `section_id` arrives URL-shaped (a string) from the picker window and int-
 * shaped from the programmatic host, so it is canonicalized with the ONE
 * write-side rule (concepts/section_id.ts) and then required to BE an address:
 * a caller that names no record cannot be asked how many locators it holds, and
 * counting zero for it would hand back a too-generous capacity.
 */
export function parsePickerCaller(raw: unknown): PickerCaller | null {
	if (!isPlainObject(raw)) return null;
	if (!PICKER_CALLER_STRING_FIELDS.every((field) => isNonEmptyString(raw[field]))) return null;
	const sectionId = canonicalizeStoredSectionId(raw.section_id);
	if (!isSectionId(sectionId)) return null;
	return {
		section_tipo: raw.section_tipo as string,
		section_id: sectionId,
		tipo: raw.tipo as string,
	};
}

/** The caller fields that must be non-empty strings — the address's two names. */
const PICKER_CALLER_STRING_FIELDS = ['tipo', 'section_tipo'] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === 'string' && value !== '';
}

/** `rqo.source.caller` is present but is not a caller address. */
export const PICKER_CALLER_MALFORMED_MESSAGE = 'read: source.caller is malformed';

/** The caller addresses an element the ontology does not define. */
export const PICKER_CALLER_UNKNOWN_MESSAGE =
	'read: source.caller names an element the ontology does not define';

/** The caller's section holds no records, so the caller addresses nothing. */
export const PICKER_CALLER_SECTIONLESS_MESSAGE =
	'read: source.caller.section_tipo is not a record-bearing section';

/**
 * The picker opened, every candidate hierarchy survived the ACL, and there was
 * still nothing to show: the target declares no ACTIVE hierarchy (or none of
 * them is one of this caller's targets). NOT an authorization refusal — the
 * two are different facts and the client renders them differently ("this
 * picker has no thesaurus" vs "you may not see it").
 */
export const PICKER_NO_HIERARCHY_MESSAGE =
	'read: no active hierarchy is configured for this component target';

/**
 * One root term's link affordance, emitted per node in relation mode. The
 * answer is the TERM's own (ts_object isIndexable via
 * relations/picker_constraint.ts isTermSelectable) — the client renders it and
 * re-derives nothing, and a `false` node still renders visible and navigable,
 * only without a link control.
 */
export interface PickerTermSelectability {
	section_tipo: string;
	/** Echoed exactly as the root-term locator carries it. */
	section_id: unknown;
	selectable: boolean;
}

// --- area tipo constants (core/base/dd_tipos.php + resolved-by-model) --------
export const AREA_ROOT_TIPO = 'dd242';
export const AREA_ADMIN_TIPO = 'dd207';
export const AREA_ACTIVITY_TIPO = 'dd69';
export const AREA_PUBLICATION_TIPO = 'dd222';
export const AREA_RESOURCE_TIPO = 'dd14';
export const AREA_TOOL_TIPO = 'dd35';
export const AREA_THESAURUS_TIPO = 'dd100';
export const AREA_ONTOLOGY_TIPO = 'dd5';
export const AREA_DEVELOPMENT_TIPO = 'dd770';
export const AREA_MAINTENANCE_TIPO = 'dd88';
