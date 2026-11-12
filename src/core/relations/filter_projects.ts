/**
 * component_filter / component_filter_master authorized-projects datalist +
 * list value — the per-section PROJECTS gate whose options are the projects the
 * logged user may see.
 *
 * PHP: component_filter_master::get_user_authorized_projects (the option set),
 * component_filter::get_datalist (the {type:'project',…} edit datalist, sorted
 * strcasecmp) and get_list_value (the labels of authorized options that appear
 * in the stored data, in authorized order).
 *
 * Each authorized project resolves: label = dd156 name (DEDALO_DATA_LANG, with
 * fallback), order = dd1631 number, parent = the nearest recursive ancestor that
 * is itself authorized (so the client can draw a limited tree).
 *
 * SCOPE: the authorized set is the CALLER's — a global admin gets every dd153
 * project, a non-admin exactly its dd170 projects (getUserProjects, the same set
 * the per-record projects ACL filters by; AUTHZ-06), an unanchored call none.
 * The cache is keyed by that SET (projectsScopeKey), never by the user, so a
 * dd170 change is followed on the next read without an eviction (READ-1; gate:
 * test/unit/filter_projects_membership_native.test.ts).
 *
 * PHP constants: DEDALO_SECTION_PROJECTS_TIPO 'dd153', DEDALO_PROJECTS_NAME_TIPO
 * 'dd156', order component 'dd1631'.
 */

import { compareLocators, type Locator } from '../concepts/locator.ts';
import { canonicalizeStoredSectionId } from '../concepts/section_id.ts';
import { sql } from '../db/postgres.ts';
import { memoizedReadMatrixRecord } from '../db/record_memo.ts';
import { createOntologyCache } from '../ontology/cache_factory.ts';
import { registerOntologyCacheClearer } from '../ontology/cache_invalidation.ts';
import { getMatrixTableFromTipo, getModelByTipo } from '../ontology/resolver.ts';
import { resolveComponentValue, shownItems } from '../resolve/component_data.ts';
import { currentDataLang } from '../resolve/request_lang.ts';
import { registerSectionDataListener } from '../section_record/save_event.ts';
import { getUserProjects, type Principal } from '../security/permissions.ts';
import { currentPrincipal } from '../security/request_context.ts';
import { getParentsRecursive } from './parent.ts';

const PROJECTS_SECTION_TIPO = 'dd153';
const PROJECTS_NAME_TIPO = 'dd156'; // DEDALO_PROJECTS_NAME_TIPO (component_input_text)
const PROJECTS_ORDER_TIPO = 'dd1631'; // component_number 'Order'

/** One authorized project (PHP get_user_authorized_projects element). */
export interface AuthorizedProject {
	label: string;
	/**
	 * Canonical record addresses — INT since
	 * WC-2026-08-10-section-id-int-canonical. These locators reach the wire
	 * (the filter datalist) AND the save path (the host project filter), so a
	 * string here would mint string-form bytes on every new selection.
	 */
	locator: { section_tipo: string; section_id: number };
	parent: { section_tipo: string; section_id: unknown } | null;
	order: number;
}

/** One filter datalist option (PHP component_filter get_datalist item). */
export interface FilterDatalistItem {
	type: 'project';
	label: string;
	section_id: number;
	section_tipo: string;
	value: { section_tipo: string; section_id: number };
	parent: { section_tipo: string; section_id: unknown } | null;
	order: number;
}

/** Cache of the authorized projects, keyed by projects-scope + data lang. */
const authorizedProjectsCache = createOntologyCache<string, readonly AuthorizedProject[]>();

/**
 * The caller's projects SCOPE — what the picker value is a function of (READ-1).
 *
 * `all` = a global admin (every dd153 project, no filter); `set` = a non-admin's
 * dd170 membership. The ids are safe integers, de-duplicated and sorted, and the
 * object is frozen: the cache key AND the value filter both read this ONE
 * normalised array, so they cannot disagree (a key coercing `Number(id)` while
 * the value filtered the raw set would drop a string id from the value only).
 */
export type ProjectsScope =
	| { readonly kind: 'all' }
	| { readonly kind: 'set'; readonly ids: readonly number[] };

const ALL_PROJECTS_SCOPE: ProjectsScope = Object.freeze({ kind: 'all' });

/**
 * Normalise a scope's ids (safe-integer coerced, de-duplicated, sorted) into a
 * frozen scope. Idempotent; tolerates numeric-string ids from a raw caller.
 */
function normaliseProjectsScope(
	scope: { kind: 'all' } | { kind: 'set'; ids: readonly (number | string)[] },
): ProjectsScope {
	if (scope.kind === 'all') return ALL_PROJECTS_SCOPE;
	const ids = [
		...new Set(scope.ids.map((id) => Number(id)).filter((id) => Number.isSafeInteger(id))),
	].sort((a, b) => a - b);
	return Object.freeze({ kind: 'set', ids: Object.freeze(ids) });
}

/**
 * The ONE scope constructor: a global admin → `all`; anyone else → their dd170
 * set (getUserProjects — the SAME set the per-record projects ACL filters by, so
 * the picker stays consistent with what records the caller can reach; AUTHZ-06).
 * getUserProjects is cached per user and evicted on every dd128 write.
 */
export async function resolveProjectsScope(principal: Principal): Promise<ProjectsScope> {
	if (principal.isGlobalAdmin) return ALL_PROJECTS_SCOPE;
	return normaliseProjectsScope({ kind: 'set', ids: await getUserProjects(principal.userId) });
}

/**
 * The projects cache key — the authorized SET plus the data lang (READ-1). Reads
 * ONLY the scope: `all_<lang>` for the admin scope, `p<ids>_<lang>` for a set
 * (the empty set keys `p_<lang>`, distinct from `all_`). Two callers with the
 * same membership share an entry and a membership change lands on a fresh one
 * by construction — the value is a pure function of (scope, lang) and the key IS
 * that pair. Keying by the user (the pre-READ-1 `u<userId>`) served a revoked
 * project until an unrelated eviction.
 */
export function projectsScopeKey(
	scope: { kind: 'all' } | { kind: 'set'; ids: readonly (number | string)[] },
	dataLang: string,
): string {
	const normalised = normaliseProjectsScope(scope);
	if (normalised.kind === 'all') return `all_${dataLang}`;
	return `p${normalised.ids.join(',')}_${dataLang}`;
}

/** PHP strcasecmp — case-insensitive byte comparison. */
function strcasecmp(a: string, b: string): number {
	return Buffer.compare(Buffer.from(a.toLowerCase(), 'utf8'), Buffer.from(b.toLowerCase(), 'utf8'));
}

/** Freeze a value and every nested object (cached entries are shared by callers). */
function deepFreeze<T>(value: T): T {
	if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
		for (const child of Object.values(value)) deepFreeze(child);
		Object.freeze(value);
	}
	return value;
}

/**
 * The authorized projects for a SCOPE in a data lang — PURE: it reads no request
 * context (no principal), so the same (scope, lang) yields the same deep-frozen
 * answer for every caller, which is what makes the set-keyed cache sound. Every
 * dd153 record in section_id order, narrowed to the scope's ids, each with its
 * resolved label / order / nearest-authorized parent.
 */
export async function buildAuthorizedProjects(
	scopeInput: { kind: 'all' } | { kind: 'set'; ids: readonly (number | string)[] },
	dataLang: string,
): Promise<readonly AuthorizedProject[]> {
	const scope = normaliseProjectsScope(scopeInput);
	const table = await getMatrixTableFromTipo(PROJECTS_SECTION_TIPO);
	if (table === null) return deepFreeze([]);
	const rows = (await sql.unsafe(
		`SELECT section_id FROM "${table}" WHERE section_tipo = $1 ORDER BY section_id`,
		[PROJECTS_SECTION_TIPO],
	)) as { section_id: number }[];
	const allowed = scope.kind === 'all' ? null : new Set(scope.ids);
	const ids = rows
		.map((row) => Number(row.section_id))
		.filter((id) => allowed === null || allowed.has(id));
	const idSet = new Set(ids);
	const nameModel = (await getModelByTipo(PROJECTS_NAME_TIPO)) ?? 'component_input_text';
	const orderModel = (await getModelByTipo(PROJECTS_ORDER_TIPO)) ?? 'component_number';

	const projects: AuthorizedProject[] = [];
	for (const id of ids) {
		const record = await memoizedReadMatrixRecord(table, PROJECTS_SECTION_TIPO, id);
		if (record === null) continue;
		// label — dd156 name in the data lang (fallback chain via resolveComponentValue)
		const name = await resolveComponentValue(record, PROJECTS_NAME_TIPO, nameModel, dataLang);
		const labelRaw = (shownItems(name)?.[0] as { value?: unknown } | undefined)?.value;
		// order — dd1631 number (0 when unset)
		const orderRes = await resolveComponentValue(
			record,
			PROJECTS_ORDER_TIPO,
			orderModel,
			'lg-nolan',
		);
		const order = Number(
			(shownItems(orderRes)?.[0] as { value?: unknown } | undefined)?.value ?? 0,
		);
		// parent — nearest recursive ancestor that is itself authorized
		let parent: { section_tipo: string; section_id: unknown } | null = null;
		const { ancestors } = await getParentsRecursive(id, PROJECTS_SECTION_TIPO);
		for (const ancestor of ancestors) {
			if (
				String(ancestor.section_tipo) === PROJECTS_SECTION_TIPO &&
				idSet.has(Number(ancestor.section_id))
			) {
				// Canonical emission: the ancestor's stored id may still be the
				// legacy string form, so canonicalize rather than re-stringify
				// (WC-2026-08-10-section-id-int-canonical).
				parent = {
					section_tipo: PROJECTS_SECTION_TIPO,
					section_id: canonicalizeStoredSectionId(ancestor.section_id),
				};
				break;
			}
		}
		projects.push({
			label: typeof labelRaw === 'string' ? labelRaw : '',
			// `id` is already the int address (idSet is numeric) — emit it as-is.
			locator: { section_tipo: PROJECTS_SECTION_TIPO, section_id: id },
			parent,
			order: Number.isFinite(order) ? order : 0,
		});
	}
	return deepFreeze(projects);
}

/**
 * The CALLER's authorized projects (PHP component_filter_master::
 * get_user_authorized_projects: is_global_admin ? all : get_user_projects).
 * AUTHZ-06: the value is narrowed to the caller's scope (before that fix every
 * caller got the full dd153 catalog + tree). The result is deep-frozen and may be
 * shared with other callers of the same scope — never mutate it.
 */
export async function getUserAuthorizedProjects(): Promise<readonly AuthorizedProject[]> {
	const principal = currentPrincipal();
	// Fail CLOSED on an unanchored call: no authority ⇒ no projects (value-level
	// deny, ISO-01 polarity — nothing is cached for it). The real callers
	// (portal.ts get_data/list) are all on the authenticated dispatch path.
	if (principal === undefined) return [];
	const scope = await resolveProjectsScope(principal);
	const dataLang = currentDataLang();
	const cacheKey = projectsScopeKey(scope, dataLang);
	const cached = authorizedProjectsCache.get(cacheKey);
	if (cached !== undefined) return cached;
	const projects = await buildAuthorizedProjects(scope, dataLang);
	authorizedProjectsCache.set(cacheKey, projects);
	return projects;
}

/** The edit-mode datalist (PHP get_datalist): filter options sorted by label. */
export async function getFilterDatalist(): Promise<FilterDatalistItem[]> {
	const projects = await getUserAuthorizedProjects();
	const items: FilterDatalistItem[] = projects.map((project) => ({
		type: 'project',
		label: project.label,
		section_tipo: project.locator.section_tipo,
		section_id: project.locator.section_id,
		value: project.locator,
		parent: project.parent,
		order: project.order,
	}));
	items.sort((a, b) => strcasecmp(a.label, b.label));
	return items;
}

/**
 * The list-mode value (PHP get_list_value): labels of the authorized options
 * whose locator is in the stored data, in authorized (section_id) order.
 */
export async function getFilterListValue(
	storedLocators: { section_tipo?: unknown; section_id?: unknown }[],
): Promise<string[]> {
	if (storedLocators.length === 0) return [];
	const projects = await getUserAuthorizedProjects();
	const labels: string[] = [];
	for (const project of projects) {
		// Locator law (DEC-21): value-based section_tipo+section_id match via
		// compareLocators (loose section_id — the projects list now carries the
		// canonical int, and a not-yet-swept stored '5' must still match it;
		// WC-2026-08-10-section-id-int-canonical).
		const matched = storedLocators.some((locator) =>
			compareLocators(locator as Locator, project.locator, ['section_tipo', 'section_id']),
		);
		if (matched) labels.push(project.label);
	}
	return labels;
}

/** Drop the authorized-projects cache (hub/event invalidation + tests). */
export function clearFilterProjectsCache(): void {
	authorizedProjectsCache.clear();
}
// Ontology-derived too (component/model resolution) — hub-cleared (S1-11 stopgap).
registerOntologyCacheClearer(clearFilterProjectsCache);
// Data-derived: any write/delete of a dd153 project record rebuilds the list
// (the durable S1-11 channel). A membership (dd170) change needs NO eviction here:
// the key IS the membership set, so the next read lands on a fresh entry
// (getUserProjects is evicted on dd128 writes; READ-1, tripwire-or-delete — gate
// filter_projects_membership_native covers both the save door and an unheard
// write).
registerSectionDataListener((sectionTipo) => {
	if (sectionTipo === PROJECTS_SECTION_TIPO) clearFilterProjectsCache();
});
