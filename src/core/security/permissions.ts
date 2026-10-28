/**
 * AUTHORIZATION — the permissions matrix (spec §7.4; PHP
 * security::get_security_permissions + common::get_permissions).
 *
 * Levels: 0 none, 1 read, 2 read/write, 3 admin. A user's per-(section,
 * component) grants come from the component_security_access (dd774) datum in
 * their PROFILE record (section dd234), resolved via the user's profile-select
 * (dd1725). Only the superuser (user_id -1) bypasses the matrix (always level
 * 3); global-admin-flagged users resolve through their profile matrix like
 * everyone else (PHP get_security_permissions has no admin bypass).
 *
 * PHP references: class.security.php get_security_permissions (:199),
 * get_permissions_table (:326), get_user_profile (:471); common
 * get_permissions (:619).
 *
 * PER-REQUEST SAFETY (spec §4): a Principal object carries the request's
 * identity; every function takes it explicitly. The per-user permissions
 * table is cached in a module Map keyed BY user_id — safe against cross-request
 * bleed (distinct users → distinct keys) but must be cleared when a profile's
 * dd774 data or a user's profile assignment changes (clearPermissionsCache).
 */

import { readString } from '../../config/readers.ts';
import { AREA_ONTOLOGY_TIPO } from '../concepts/area.ts';
import {
	AUDIT_TIPOS,
	isConsultationOnlySection,
	TIME_MACHINE_SECTION_TIPO,
} from '../concepts/section.ts';
import { classifyWireSectionId } from '../concepts/section_id.ts';
import { sql } from '../db/postgres.ts';
import { isErrorInDomain } from '../errors/dedalo_error.ts';
import { createDataCache } from '../ontology/cache_factory.ts';
import { THESAURUS_SECTION } from '../ontology/ontology_tipos.ts';
import { getMatrixTableFromTipo, getModelByTipo } from '../ontology/resolver.ts';
import { scheduleAccountTransitionRevocation } from './revocation.ts';

/**
 * Bounded-staleness backstop for the per-user caches below. Explicit
 * invalidation (invalidatePermissionsForWrite / clear*) is the PRIMARY control;
 * the TTL only caps how long a MISSED invalidation (e.g. a grant changed on
 * another worker process, whose Map this process cannot reach) can linger.
 * PERMISSIONS_CACHE_TTL_SECONDS=0 disables the TTL (invalidation-only).
 */
const CACHE_TTL_MS = Math.max(0, Number(readString('PERMISSIONS_CACHE_TTL_SECONDS'))) * 1000;

interface CacheEntry<V> {
	value: V;
	expiresAt: number;
}

/** Read a still-live cache entry (pruning it on expiry), or undefined. */
function readFresh<K, V>(cache: Map<K, CacheEntry<V>>, key: K): V | undefined {
	const entry = cache.get(key);
	if (entry === undefined) return undefined;
	if (CACHE_TTL_MS > 0 && Date.now() >= entry.expiresAt) {
		cache.delete(key);
		return undefined;
	}
	return entry.value;
}

/** Store a value with the TTL stamp. */
function storeEntry<K, V>(cache: Map<K, CacheEntry<V>>, key: K, value: V): void {
	cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
}

// --- ontology constants (resolved from core/base/dd_tipos.php) --------------
/** DEDALO_SUPERUSER — the root user id (fail-closed gates key on this). */
export const SUPERUSER_ID = -1;
const USERS_SECTION = 'dd128';
/** dd234 — the profiles section; a profile record HOLDS the dd774 grant matrix. */
export const PROFILES_SECTION = 'dd234';
/** dd774 — the component_security_access datum (misc column) on a profile record. */
export const SECURITY_ACCESS_COMPONENT = 'dd774';
const PROFILE_SELECT_COMPONENT = 'dd1725';
const GLOBAL_ADMIN_COMPONENT = 'dd244';
const DEVELOPER_COMPONENT = 'dd515';
const AREA_MAINTENANCE = 'dd88';
const TOOLS_REGISTER_SECTION = 'dd1324';
/**
 * dd655 — the per-user EDITING preset section (one transient "current search"
 * record per user and section, client search_user_presets.js). Every principal
 * resolves level 2 on it (getPermissions below): that is the RULE that lets any
 * profile keep its own editing preset without an install-wide dd655 grant. It
 * is NOT authority over other users' rows: the rule is bounded by the OWNER
 * predicate the search assembler applies to this section
 * (sql_assembler.ts buildPresetOwnerFilter — `dd654` owner locator or
 * `created_by_user_id`), which the list, the count, the UNION branches,
 * `isRecordInScope` and therefore the save/delete doors all inherit. Exported
 * so the assembler binds the predicate to the same tipo this rule names.
 * Audit CARRY-07 (TOOLS-03): before the predicate, 80 preset rows owned by
 * three users were each readable and writable by any of them by id.
 * Gate: test/unit/preset_ownership_native.test.ts.
 */
export const TEMP_PRESET_SECTION = 'dd655';
/** dd654 — the owner locator (→ dd128) on a dd655/dd623 preset record. */
export const PRESET_OWNER_COMPONENT = 'dd654';
const INVERSE_RELATIONS_COMPONENT = 'dd1596';
/**
 * Sections whose list values are publicly readable when the matrix says 0.
 * Exported READ-ONLY for the permissions gate (test/parity/
 * permissions_differential.test.ts) so the zero-grant assertion can pin
 * "exactly 0 unless THIS fallback applies" instead of the vacuous >= 0.
 */
export const PUBLIC_LIST_TABLES: ReadonlySet<string> = new Set([
	'matrix_list',
	'matrix_dd',
	'matrix_notes',
]);

/** The request's authenticated identity. */
export interface Principal {
	userId: number;
	isGlobalAdmin: boolean;
	isDeveloper: boolean;
}

/**
 * Read the first locator's target section_id from a user's relation component.
 *
 * KEPT UNION (WC-2026-08-10-section-id-int-canonical): the user record's
 * relation bag is read straight off jsonb, and an unswept install still holds
 * the legacy string form ('1' for the yes-flag target). Read tolerance here is
 * what keeps a pre-sweep install's admins admins; the returned address is the
 * canonical int.
 */
async function readUserRelationTargetId(
	userId: number,
	componentTipo: string,
): Promise<number | null> {
	const rows = (await sql.unsafe(
		'SELECT relation->$2 AS items FROM matrix_users WHERE section_tipo = $1 AND section_id = $3 LIMIT 1',
		[USERS_SECTION, componentTipo, userId],
	)) as { items: { section_id?: string | number }[] | null }[];
	const first = rows[0]?.items?.[0];
	if (first === undefined || first.section_id === undefined) return null;
	return Number(first.section_id);
}

/**
 * Module cache of resolved principals, keyed by user_id (boot backlog #4:
 * resolvePrincipal ran 2 uncached PG queries on EVERY authenticated request
 * while its siblings in this file were TTL-cached). Data-derived from the
 * USER record (the dd244/dd515 flag locators) — a users-section write/
 * delete/restore drops it via the event channel, same contract as
 * userProjectsCache; the shared TTL is the missed-invalidation backstop.
 */
const principalCache = createDataCache<number, CacheEntry<Principal>>((cache, sectionTipo) => {
	if (sectionTipo === USERS_SECTION) cache.clear();
});

export function clearPrincipalCache(userId?: number): void {
	if (userId === undefined) principalCache.clear();
	else principalCache.delete(userId);
}

/**
 * Resolve a user's global-admin / developer flags (PHP is_global_admin /
 * is_developer): the flag component's first locator target section_id === 1
 * means "yes". Superuser is always global admin. Cached per user_id (the
 * returned object is FROZEN — principals are shared across requests).
 */
export async function resolvePrincipal(userId: number): Promise<Principal> {
	if (userId === SUPERUSER_ID) {
		return { userId, isGlobalAdmin: true, isDeveloper: true };
	}
	const cached = readFresh(principalCache, userId);
	if (cached !== undefined) return cached;
	const [adminTarget, developerTarget] = await Promise.all([
		readUserRelationTargetId(userId, GLOBAL_ADMIN_COMPONENT),
		readUserRelationTargetId(userId, DEVELOPER_COMPONENT),
	]);
	const principal: Principal = Object.freeze({
		userId,
		isGlobalAdmin: adminTarget === 1,
		isDeveloper: developerTarget === 1,
	});
	storeEntry(principalCache, userId, principal);
	return principal;
}

/**
 * user (dd128) → profile-select (dd1725) → profile record id in dd234 (PHP
 * security::get_user_profile). Exported for the grant writer
 * (security/section_permissions.ts), which must write to the SAME profile
 * record this resolves — the superuser (-1) included: it has a real dd128 row
 * carrying a dd1725 profile locator, and PHP has no superuser short-circuit
 * here, so a grant for -1 lands on that profile like any other user's.
 */
export async function resolveProfileId(userId: number): Promise<number | null> {
	return readUserRelationTargetId(userId, PROFILE_SELECT_COMPONENT);
}

/**
 * The projects component in the users section (PHP DEDALO_FILTER_MASTER_TIPO).
 * EXPORTED so the dd128 branch of the search assembler's projects filter names
 * the same constant instead of re-declaring it: the users ACL is stated once.
 */
export const FILTER_MASTER_COMPONENT = 'dd170';

/**
 * A user's authorized project section_ids (PHP
 * component_filter_master::get_user_projects) — the dd170 relation locators in
 * their user record, each pointing at a project (dd153). Empty array = no
 * projects (⇒ sees no project-gated records). Cached per user_id.
 */
// Data-derived (dd170 relation on the user record). The event-channel clear
// covers every chokepoint write — INCLUDING Time Machine restores through
// persistRecordColumns, which bypass the per-component
// invalidatePermissionsForWrite (S3-18); the TTL below remains only the
// missed-invalidation backstop.
const userProjectsCache = createDataCache<number, CacheEntry<number[]>>((cache, sectionTipo) => {
	if (sectionTipo === USERS_SECTION) cache.clear();
});

export function clearUserProjectsCache(userId?: number): void {
	if (userId === undefined) userProjectsCache.clear();
	else userProjectsCache.delete(userId);
}

// KEPT UNION on the row cast below, same law as readUserRelationTargetId: the
// dd170 bag is unswept jsonb, so a legacy string project address must still
// resolve (WC-2026-08-10-section-id-int-canonical); the returned ids are ints.
export async function getUserProjects(userId: number): Promise<number[]> {
	const cached = readFresh(userProjectsCache, userId);
	if (cached !== undefined) return cached;
	const rows = (await sql.unsafe(
		'SELECT relation->$2 AS items FROM matrix_users WHERE section_tipo = $1 AND section_id = $3 LIMIT 1',
		[USERS_SECTION, FILTER_MASTER_COMPONENT, userId],
	)) as { items: { section_id?: string | number }[] | null }[];
	const projects = (rows[0]?.items ?? [])
		.map((locator) => Number(locator.section_id))
		.filter((id) => Number.isFinite(id));
	storeEntry(userProjectsCache, userId, projects);
	return projects;
}

/** One dd774 grant. */
interface SecurityAccessEntry {
	tipo: string;
	section_tipo: string;
	value: number;
}

/**
 * Module cache of the flat permissions map, keyed by user_id. Data-derived
 * from BOTH the user record (dd1725 profile assignment) and the profile
 * record (dd774 grants) — a write/delete/restore of either section drops it
 * via the event channel (S3-18; coarse clear, the reverse profile→users
 * mapping is not known here).
 */
const permissionsTableCache = createDataCache<number, CacheEntry<Map<string, number>>>(
	(cache, sectionTipo) => {
		if (sectionTipo === USERS_SECTION || sectionTipo === PROFILES_SECTION) cache.clear();
	},
);

/** Clear the cache (call after a profile's dd774 data or assignment changes). */
export function clearPermissionsCache(userId?: number): void {
	if (userId === undefined) permissionsTableCache.clear();
	else permissionsTableCache.delete(userId);
}

/**
 * Invalidate the security caches after a component WRITE, so a grant/assignment/
 * projects change takes effect on the next request instead of persisting for the
 * process lifetime. Called from the save chokepoint (saveComponentData) with the
 * written (section, component, record). Scope-precise where cheap, coarse where
 * the reverse mapping (profile → assigned users) is not known here.
 *
 * - dd774 on a PROFILE (dd234): a profile's grants changed ⇒ EVERY user on that
 *   profile has a stale table. We don't know which users map to it here, so clear
 *   the whole permissions cache (rare event; a cache rebuild, not a correctness risk).
 * - dd1725 on a USER (dd128): that user's profile assignment changed ⇒ their table.
 * - dd170 on a USER (dd128): that user's authorized projects changed.
 */
export function invalidatePermissionsForWrite(
	sectionTipo: string,
	componentTipo: string,
	sectionId: number,
): void {
	clearSecurityCachesForWrite(sectionTipo, componentTipo, sectionId);
	// THE REVOCATION SEAM — the SECOND reach, for a door that writes a dd128
	// relation key without going through the record-write chokepoint.
	//
	// The PRIMARY reach is `section_record/record_write.ts` (afterRecordWrite, the
	// post-write hook of persistRecordKeys / persistRecordColumns →
	// revocation.reactToRecordComponentWrite): that is where every save door, both
	// importers, the MCP tools, the agent change-plan, tool_propagate_component_data,
	// both time-machine restore doors AND — since P1-8 (2026-09-03) — the portal
	// unlink door `relations/save.ts deletePortalLocator` land (it used to remove the
	// locator with a direct `updateMatrixKeyData` and call THIS function post-commit).
	// No engine door reaches the seam through this function today; it stays because
	// its contract (clear + revoke, commit-only) is the right shape for the next door
	// that legitimately cannot use the chokepoint, and because the census gate
	// (test/unit/dd128_write_census_tripwire.test.ts) names it as a seam symbol.
	//
	// COMMIT-ONLY LANE. Called post-commit, there is no ambient transaction,
	// `registerCommitAction` returns false and the revocation runs inline — the same
	// answer, reached honestly.
	//
	// (!) A CALLER ON THE DEFERRED LANE MUST NOT USE THIS FUNCTION. `deferPostTransaction`
	// replays on ROLLBACK, and a replay happens after the commit queue has closed, so
	// the schedule below would degrade to an inline revocation for a write that never
	// landed. Those callers take `clearSecurityCachesForWrite` instead — the cache half
	// alone, which is exactly what that lane is for.
	scheduleAccountTransitionRevocation(
		sectionTipo,
		sectionId,
		[componentTipo],
		'invalidatePermissionsForWrite',
	);
}

/**
 * The CACHE half of {@link invalidatePermissionsForWrite}, with no revocation.
 *
 * The lane decides which of the two a caller wants: cache clears are idempotent and
 * MUST replay on rollback (`deferPostTransaction`), a revocation is destructive and must
 * not (`registerCommitAction`). A caller that queues work on the deferred lane therefore
 * calls THIS one — save_component.ts's post-write clear, and the cache lane inside
 * revocation.reactToRecordComponentWrite.
 */
export function clearSecurityCachesForWrite(
	sectionTipo: string,
	componentTipo: string,
	sectionId: number,
): void {
	if (sectionTipo === PROFILES_SECTION && componentTipo === SECURITY_ACCESS_COMPONENT) {
		clearPermissionsCache();
		return;
	}
	if (sectionTipo === USERS_SECTION) clearUsersSectionCaches(componentTipo, sectionId);
}

/** The dd128 half of {@link clearSecurityCachesForWrite}: which cache a user-record
 *  component write invalidates. */
function clearUsersSectionCaches(componentTipo: string, sectionId: number): void {
	if (componentTipo === PROFILE_SELECT_COMPONENT) clearPermissionsCache(sectionId);
	if (componentTipo === FILTER_MASTER_COMPONENT) clearUserProjectsCache(sectionId);
	// A flag flip (global-admin dd244 / developer dd515) re-resolves the
	// principal on the next request (boot backlog #4 cache).
	if (componentTipo === GLOBAL_ADMIN_COMPONENT || componentTipo === DEVELOPER_COMPONENT) {
		clearPrincipalCache(sectionId);
	}
}

/**
 * Invalidate the security caches after a whole USER or PROFILE record is
 * created/deleted (which can add or remove grants/assignments in ways not
 * captured by a per-component save). Coarse (clear-all) because the reverse
 * mapping is not known here; a no-op for any other section.
 */
export function invalidateSecurityCachesForSection(sectionTipo: string): void {
	if (sectionTipo === USERS_SECTION || sectionTipo === PROFILES_SECTION) {
		clearPermissionsCache();
		clearUserProjectsCache();
		clearPrincipalCache();
	}
}

/**
 * Build the flat "section_tipo_tipo" → level map for a user from their
 * profile's dd774 datum (PHP get_permissions_table). Empty map when the user
 * has no profile.
 */
async function getPermissionsTable(userId: number): Promise<Map<string, number>> {
	const cached = readFresh(permissionsTableCache, userId);
	if (cached !== undefined) return cached;

	const table = new Map<string, number>();
	const profileId = await resolveProfileId(userId);
	if (profileId !== null) {
		const profileTable = (await getMatrixTableFromTipo(PROFILES_SECTION)) ?? 'matrix_profiles';
		const rows = (await sql.unsafe(
			`SELECT misc->$2 AS grants FROM "${profileTable}" WHERE section_tipo = $1 AND section_id = $3 LIMIT 1`,
			[PROFILES_SECTION, SECURITY_ACCESS_COMPONENT, profileId],
		)) as { grants: SecurityAccessEntry[] | null }[];
		for (const entry of rows[0]?.grants ?? []) {
			table.set(`${entry.section_tipo}_${entry.tipo}`, entry.value);
		}
	}
	storeEntry(permissionsTableCache, userId, table);
	return table;
}

/**
 * The AREA tipos a user's profile authorizes (PHP
 * security::get_ar_authorized_areas_for_user): the SELF-KEYED entries of the
 * permissions table (`X_X`, tipo === section_tipo). PHP filters the menu by
 * PRESENCE of the entry, not its level — matched here.
 */
export async function getAuthorizedAreaTipos(userId: number): Promise<Set<string>> {
	const table = await getPermissionsTable(userId);
	const areas = new Set<string>();
	for (const key of table.keys()) {
		const separator = key.indexOf('_');
		if (separator === -1) continue;
		const sectionTipo = key.slice(0, separator);
		if (key.slice(separator + 1) === sectionTipo) areas.add(sectionTipo);
	}
	return areas;
}

/**
 * Who may open area_ontology (dd5) — read AND menu, ONE rule (engineering/AREA_SPEC.md §9,
 * WC-2026-10-07-ontology-area-admin-grant): the superuser, or a GLOBAL ADMIN
 * whose profile grants dd5 (level >= 1). Global-admin status alone is not
 * enough and a grant alone is not enough. Inside the area every ontology
 * section and field answers the ordinary ACL — no admin bypass.
 */
export async function canAccessOntologyArea(principal: Principal): Promise<boolean> {
	if (principal.userId === SUPERUSER_ID) return true;
	if (!principal.isGlobalAdmin) return false;
	return (await getPermissions(principal, AREA_ONTOLOGY_TIPO, AREA_ONTOLOGY_TIPO)) >= 1;
}

/**
 * The self-keyed area permissions WITH their level (PHP
 * security::get_ar_authorized_areas_for_user): every `X_X` entry as
 * {tipo, value}. Callers that need the level (e.g. component_filter_records
 * get_datalist, which keeps only value >= 2 sections) use this; the
 * presence-only menu filter uses getAuthorizedAreaTipos above.
 */
export async function getAuthorizedAreasForUser(
	userId: number,
): Promise<{ tipo: string; value: number }[]> {
	const table = await getPermissionsTable(userId);
	const areas: { tipo: string; value: number }[] = [];
	for (const [key, value] of table.entries()) {
		const separator = key.indexOf('_');
		if (separator === -1) continue;
		const sectionTipo = key.slice(0, separator);
		if (key.slice(separator + 1) === sectionTipo) areas.push({ tipo: sectionTipo, value });
	}
	return areas;
}

/**
 * Every `tipo` PRESENT in a user's dd774 grant table, regardless of which
 * section keys it and regardless of its level — PHP
 * component_security_access::get_datalist's non-admin narrowing
 * (class.component_security_access.php:219-234), which matches an area with
 * `array_find($user_data, fn($el) => $el->tipo === $current_area->tipo)`: by
 * TIPO ALONE, and by PRESENCE, not by value.
 *
 * Deliberately NOT getAuthorizedAreaTipos: that one keeps only SELF-KEYED
 * entries (`X_X`) because PHP's MENU filter reads
 * security::get_ar_authorized_areas_for_user. The ACL-datalist filter reads the
 * raw dd774 rows instead, so a tipo granted under another section's key still
 * matches there. Two PHP call sites, two rules — never collapse them.
 */
export async function getGrantedTipos(userId: number): Promise<Set<string>> {
	const table = await getPermissionsTable(userId);
	const tipos = new Set<string>();
	for (const key of table.keys()) {
		// Keys are `${section_tipo}_${tipo}`; an ontology tipo never contains '_'.
		const separator = key.indexOf('_');
		if (separator === -1) continue;
		tipos.add(key.slice(separator + 1));
	}
	return tipos;
}

/**
 * The dd15 READ FLOOR (WC-2026-08-14-tm-permission-floor).
 *
 * Time Machine columns are consultation-only, and the level derives from the
 * §7.4 `time_machine_list` grant on the CALLER SECTION — not from global-admin
 * status. The old wrapper rule (`isGlobalAdmin ? 1 : 0`) contradicted
 * canAccessTimeMachineList, which exists precisely to grant per-section history
 * to non-admins; the contradiction was invisible only because the TM read never
 * ran dd15 columns through the per-ddo authz loop (buildTmContext hardcoded
 * permissions:1). It does now.
 *
 * The scoped section arrives through the request-scoped TM scope rather than a
 * parameter — see tm_scope_context.ts. Its ABSENCE is meaningful: the unscoped
 * browse shows every section's history at once, so no per-section grant can
 * authorize it and it stays global-admin only.
 *
 * THE PAIR (WC-2026-10-22-tm-scope-whole-request, review r2). The §7.4 grant
 * admits the HISTORY of the section — dd15's own columns (who/when/what, the
 * note): the grant is all they need. A dd15 column that REPLAYS one of the
 * caller section's components (the component surface's value column, the
 * snapshot list's section_list columns, a client-sent ddo) is that component's
 * past value, so it also needs the pair the live record read needs —
 * (caller section, component) ≥ 1. Without it the section-wide grant read
 * every past value of a field the profile holds 0 on.
 *
 * Never above 1: reverts go through tool_time_machine, never inline edit.
 */
async function timeMachineReadFloor(principal: Principal, tipo: string): Promise<number> {
	if (principal.isGlobalAdmin) return 1;
	const { currentTimeMachineScopeSection } = await import(
		'../section/list_definitions/tm_scope_context.ts'
	);
	const scopedSection = currentTimeMachineScopeSection();
	if (scopedSection === undefined || scopedSection === TIME_MACHINE_SECTION_TIPO) return 0;
	// Dynamic import breaks the cycle: time_machine_list.ts imports THIS module.
	// No recursion — every call resolves against the caller section, not dd15.
	const { canReadTimeMachineColumn } = await import(
		'../section/list_definitions/time_machine_list.ts'
	);
	return (await canReadTimeMachineColumn(principal, scopedSection, tipo)) ? 1 : 0;
}

/**
 * WHERE a level comes from — the AUTHORITY behind it, not only its size.
 *
 *   'superuser' — the -1 account, level 3 everywhere.
 *   'profile'   — the caller's own dd774 matrix (directly, or through an alias
 *                 hop to the target's matrix pair): a grant an administrator
 *                 GAVE this profile on this pair.
 *   'rule'      — a level every principal (of a class) gets WITHOUT the
 *                 profile saying so: the dd15 Time Machine floor, the dd1324
 *                 tools register, the dd655 editing-preset grant, the
 *                 inverse-relations / 'all' wildcard, the public list-value
 *                 fallback, the maintenance block, a degenerate empty tipo.
 *
 * Most callers need the level only ({@link getPermissions}). A caller that
 * EXTENDS a grant — the subdatum read floor (security/read_floor.ts) turns a
 * grant on a source component into read on the components its request_config
 * names — must refuse a 'rule' basis: each rule is bounded where it was
 * written (dd655 by the assembler's owner predicate, the public fallback to
 * list values, the wildcard to the inverse-relations read), and none of those
 * bounds travels with the extension. Gate: search_path_acl_native ("FORGED
 * SOURCE").
 */
export type GrantBasis = 'superuser' | 'profile' | 'rule';

/** One resolved permission: the 0-3 level and the authority that answered it. */
export interface PermissionGrant {
	readonly level: number;
	readonly basis: GrantBasis;
}

const RULE_DENIED: PermissionGrant = Object.freeze({ level: 0, basis: 'rule' });
const RULE_READ: PermissionGrant = Object.freeze({ level: 1, basis: 'rule' });
const RULE_EDIT: PermissionGrant = Object.freeze({ level: 2, basis: 'rule' });
const SUPERUSER_GRANT: PermissionGrant = Object.freeze({ level: 3, basis: 'superuser' });

/**
 * get_permissions(parentTipo, tipo) → 0-3 for a principal. Reproduces the PHP
 * decision order exactly (wrapper common::get_permissions + core
 * security::get_security_permissions), first match wins. The level of
 * {@link getPermissionGrant} — ONE decision order, two views of its answer.
 */
export async function getPermissions(
	principal: Principal,
	parentTipo: string,
	tipo: string,
): Promise<number> {
	return (await getPermissionGrant(principal, parentTipo, tipo)).level;
}

/**
 * The HEAD of the decision order: every case answered before the alias hop
 * and the matrix — the superuser and the RULE grants (see {@link GrantBasis}).
 * Null = fall through to the profile.
 */
async function ruleOrderGrant(
	principal: Principal,
	parentTipo: string,
	tipo: string,
): Promise<PermissionGrant | null> {
	// Time machine (dd15) has its own floor — see timeMachineReadFloor.
	if (parentTipo === TIME_MACHINE_SECTION_TIPO) {
		return (await timeMachineReadFloor(principal, tipo)) >= 1 ? RULE_READ : RULE_DENIED;
	}
	if (parentTipo === '' || tipo === '') return RULE_DENIED;

	// Core resolver order.
	if (principal.userId === SUPERUSER_ID) return SUPERUSER_GRANT;
	if (parentTipo === TOOLS_REGISTER_SECTION) return RULE_READ;
	// The blanket editing-preset grant — bounded to the caller's OWN rows by the
	// assembler's owner predicate (see TEMP_PRESET_SECTION).
	if (parentTipo === TEMP_PRESET_SECTION) return RULE_EDIT;
	// Inverse-relations / 'all' read wildcard (the related "who-calls-me" path).
	// AUTHZ-05 guard: the wildcard grant requires a CONCRETE parent section tipo,
	// so getPermissions(_, 'all', 'all') can NEVER inherit a blanket level-1 grant
	// (a future read path that expanded 'all' into a cross-section scan would
	// otherwise be universally readable; the identifier gate also rejects 'all'
	// downstream — this is defense in depth). Real sections (^[a-z]+[0-9]+$) are
	// unaffected, so the legitimate related/inverse grant is byte-identical.
	if (
		(tipo === INVERSE_RELATIONS_COMPONENT || tipo === 'all') &&
		/^[a-z]+[0-9]+$/.test(parentTipo)
	) {
		return RULE_READ;
	}

	// Maintenance-area gate: BLOCKS non-admin/non-dev (does not grant; admins
	// fall through to the matrix).
	if (tipo === AREA_MAINTENANCE && !principal.isGlobalAdmin && !principal.isDeveloper) {
		return RULE_DENIED;
	}
	return null;
}

/** {@link getPermissions} with the authority that answered (see {@link GrantBasis}). */
export async function getPermissionGrant(
	principal: Principal,
	parentTipo: string,
	tipo: string,
): Promise<PermissionGrant> {
	const ruled = await ruleOrderGrant(principal, parentTipo, tipo);
	if (ruled !== null) return ruled;

	// component_alias (WC-020): ACL grants live on REAL components — an alias
	// is a view of its target with the target's exact rights (no privilege
	// change in either direction; without the hop a non-admin could never be
	// granted a config node and every alias would vanish from their reads).
	{
		const { resolveAliasTargetTipo } = await import('../ontology/alias.ts');
		const aliasTarget = await resolveAliasTargetTipo(tipo).catch(() => null);
		if (aliasTarget !== null) {
			return getPermissionGrant(principal, parentTipo, aliasTarget);
		}
	}

	// Matrix lookup.
	const table = await getPermissionsTable(principal.userId);
	const level = table.get(`${parentTipo}_${tipo}`) ?? 0;

	// List/dd/notes fallback: publicly readable list values.
	if (level === 0 && (await isPublicListSection(parentTipo))) return RULE_READ;
	return { level, basis: 'profile' };
}

/** A SECTION stored in a {@link PUBLIC_LIST_TABLES} table (its list values are public). */
async function isPublicListSection(parentTipo: string): Promise<boolean> {
	if ((await getModelByTipo(parentTipo)) !== 'section') return false;
	const matrixTable = await getMatrixTableFromTipo(parentTipo);
	return matrixTable !== null && PUBLIC_LIST_TABLES.has(matrixTable);
}

/**
 * Per-component READ gate shared by the request_config builders and the read
 * emission path (PHP check_ddo_permissions, trait.request_config_ddo.php:381-92
 * + filter_authorized_related, trait.request_config_v5.php:574-86): a ddo
 * survives only when the actor's level on (sectionTipo, componentTipo) is ≥ 1.
 *
 * An UNDEFINED principal (no request scope: unit harnesses, background
 * warmups, internal datalist/order-path/save-config resolution) applies NO
 * filter — production requests always carry a seeded principal, and PHP's
 * not-logged-in→0 posture would empty those internal resolutions. The array
 * section form checks the FIRST target (PHP reset(), check_ddo_permissions:384).
 * An unresolvable SECTION (absent, empty, non-string, empty array) with a
 * DEFINED principal is DENIED, not allowed — see the fail-closed note at the
 * branch.
 *
 * NO global-admin bypass (PHP parity, 2026-07-18): admin-flagged users resolve
 * through their profile matrix like everyone — only the superuser (-1) passes
 * unconditionally, via getPermissions' own short-circuit.
 */
export async function ddoIsAuthorized(
	principal: Principal | undefined,
	sectionTipo: string | string[] | undefined,
	componentTipo: string,
): Promise<boolean> {
	if (principal === undefined) return true;
	const checkSection = Array.isArray(sectionTipo) ? sectionTipo[0] : sectionTipo;
	// An UNRESOLVABLE section fails CLOSED for a defined principal (SEC-01).
	// It used to return true — "no section to check" was read as "allowed" —
	// which handed the caller's own degenerate input the answer of an authorized
	// one.
	//
	// WHAT THE CALLERS ACTUALLY DO (corrected 2026-08-28; the first wording of
	// this note claimed every caller supplies a fallback, which is not true).
	// The fallbacks are all `??`, and `??` does NOT catch the empty string, so
	// three live paths can reach here with `''`:
	//   - section/read.ts:277        `ddo.section_tipo` sent as '' by the client
	//   - section/read_facade.ts:363 `source.section_tipo` guarded only by typeof
	//   - relations/request_config/explicit.ts:575  `sectionTipo ?? owner`
	// For all three the fail-closed answer is the RIGHT one and changes nothing
	// a caller could observe: an empty section resolves through getPermissions
	// to level 0 anyway (`parentTipo === '' → 0`), so the entry was already
	// emitted with permissions 0 / an empty shell. It is now dropped one step
	// earlier, by the gate rather than by the level.
	//
	// Measured 2026-08-28: ZERO unresolvable calls across the 51 read-path unit
	// gates (463 tests) and the whole 132-suite browser client run — while the
	// same instrumentation fires on a constructed '' / undefined / [] call. The
	// undefined-PRINCIPAL posture above is untouched: internal resolutions still
	// apply no filter.
	if (typeof checkSection !== 'string' || checkSection === '') return false;
	return (await getPermissions(principal, checkSection, componentTipo)) >= 1;
}

/**
 * SECTION-level permission for a principal — the analogue of PHP
 * section::get_section_permissions (class.section.php:1918). Equals
 * getPermissions(sectionTipo, sectionTipo) EXCEPT a consultation-only section
 * is capped at read (1, PHP :1929), so create/duplicate/delete are refused and
 * the client renders the section read-only. Even admins/superusers are capped
 * here (PHP caps after common::get_permissions, unconditionally).
 *
 * WHY A SEPARATE FUNCTION (not a cap inside getPermissions): getPermissions is a
 * faithful mirror of PHP common::get_permissions, which does NOT cap Activity —
 * the cap lives one layer up. Component-level gates and the differential parity
 * contract (permissions_differential.test.ts) depend on that fidelity, so the
 * consultation-only cap belongs ONLY on the section-level computation.
 */
export async function getSectionPermissions(
	principal: Principal,
	sectionTipo: string,
): Promise<number> {
	const level = await getPermissions(principal, sectionTipo, sectionTipo);
	if (level > 1 && isConsultationOnlySection(sectionTipo)) return 1;
	return level;
}

/**
 * Subdatum permission inheritance (PHP get_subdatum component-caller branch,
 * class.common.php:2567-2575): a child element reached THROUGH a component the
 * actor is authorized on (portal/autocomplete target components) is floored to
 * read (1) even when the actor holds 0 on the target — the actor must see the
 * portal's resolved values and pick with the autocomplete. A read-only caller
 * (level 1) caps its children at read so a stray target write grant can't leak
 * an editable child into a read-only portal. Applies ONLY to derived/expanded
 * children — top-level ddo_map entries at level 0 are DROPPED, never floored.
 */
export function inheritSubdatumPermission(childLevel: number, callerLevel: number): number {
	if (childLevel < 1) return 1;
	if (callerLevel === 1 && childLevel > 1) return 1;
	return childLevel;
}

/** The metadata/section-info component tipos (PHP get_metadata_definition_tipos). */
const METADATA_TIPOS: ReadonlySet<string> = new Set(Object.values(AUDIT_TIPOS));

/**
 * THE SEARCH SURFACE'S STANDING GRANTS — the (section, component) pairs every
 * searcher may FILTER on whatever the dd774 matrix says (PHP
 * component_common::get_component_permissions, search branch): the section-info
 * metadata components (created/modified date and user, dd196 group — no profile
 * grants them per section, and the search panel offers them to everyone) and
 * every component of the thesaurus template section. ONE rule, read by the
 * search-mode context stamp ({@link resolveComponentContextPermission}) AND by
 * the search path's root/relation-leaf key (search/conform.ts, SEC-1), so the
 * panel can never offer a field the filter then refuses.
 */
export function searchSurfaceGrants(sectionTipo: string, componentTipo: string): boolean {
	return sectionTipo === THESAURUS_SECTION || METADATA_TIPOS.has(componentTipo);
}

/** The metadata component tipos (read-only view — the search key lists the relation ones). */
export function metadataComponentTipos(): readonly string[] {
	return [...METADATA_TIPOS];
}

/**
 * dd128 own-record components PHP forces to READ for a non-global-admin, so a
 * user cannot hand themselves a profile, the developer flag, a new username or
 * a different section_id through the ordinary save API (DEDALO_USER_PROFILE_TIPO,
 * DEDALO_USER_DEVELOPER_TIPO, DEDALO_USER_NAME_TIPO, 'dd330').
 *
 * PLUS the per-user AI spend limits dd692-695 (2026-10-12, beyond PHP —
 * WC-2026-10-12-ddengine-removed): the user's own value WINS over its profile's
 * (security/ai_spend.ts), so a user-manager writing it on their OWN record would
 * lift their own spend cap. Same self-elevation class, same downgrade.
 */
const SELF_ELEVATION_GUARDED: ReadonlySet<string> = new Set([
	PROFILE_SELECT_COMPONENT,
	DEVELOPER_COMPONENT,
	'dd132',
	'dd330',
	'dd692',
	'dd693',
	'dd694',
	'dd695',
]);
/**
 * dd128 own-record components PHP forces to WRITE regardless of the matrix —
 * the self-service profile editor (tool_user_admin) exists to change exactly
 * these (DEDALO_FULL_USER_NAME/USER_EMAIL/USER_PASSWORD/USER_IMAGE_TIPO).
 */
const SELF_EDITABLE_COMPONENTS: ReadonlySet<string> = new Set(['dd452', 'dd134', 'dd133', 'dd522']);

/**
 * The dd128 OWN-USER-RECORD rules (PHP component_common::
 * resolve_component_read_permission, class.component_common.php:3547-3577).
 * Returns the FORCED level, or null when the branch does not apply and the
 * caller must fall through to the matrix.
 *
 * This is a WRITE gate as much as a display stamp: PHP reaches it from both the
 * read stamp and `component_common::save`'s `get_component_permissions() < 2`
 * check, so every door onto a dd128 component must consult it. Missing the
 * DOWNGRADE half is a privilege-escalation hole (self-assign a profile or the
 * developer flag); missing the UPGRADE half breaks the profile editor for every
 * ordinary user, because dd128 is not a project-assigned section and most
 * profiles therefore grant 0 on it.
 *
 * PHP guards the whole branch with `!empty($user_id)`, so user id 0 — the
 * "no logged user" sentinel — is deliberately skipped here too.
 */
export function isActorsOwnUserRecord(
	principal: Principal,
	sectionTipo: string,
	sectionId: number | string | null | undefined,
): boolean {
	if (sectionTipo !== USERS_SECTION) return false;
	if (sectionId === null || sectionId === undefined) return false;
	// PHP: !empty($user_id) — 0 is "not logged in", never an own-record match.
	if (principal.userId === 0) return false;
	const recordId = Number(sectionId);
	return Number.isInteger(recordId) && recordId === principal.userId;
}

export function resolveOwnUserRecordPermission(
	principal: Principal,
	sectionTipo: string,
	tipo: string,
	sectionId: number | string | null | undefined,
): number | null {
	if (!isActorsOwnUserRecord(principal, sectionTipo, sectionId)) return null;

	// Order matters: the security-administrator downgrade is UNCONDITIONAL in
	// PHP — a global admin may not raise their own global-admin flag either.
	if (tipo === GLOBAL_ADMIN_COMPONENT) return 1;
	if (SELF_ELEVATION_GUARDED.has(tipo) && principal.isGlobalAdmin === false) return 1;
	if (SELF_EDITABLE_COMPONENTS.has(tipo)) return 2;
	return null;
}

/**
 * IS THIS WRITE AN ACCOUNT'S OWN SELF-SERVICE EDIT? (2026-08-28, reviewer must-fix 5.)
 *
 * True only when ALL of: the target is the USERS section, the record IS the actor's own
 * account, and the component is one of the four SELF-EDITABLE ones — full name (dd452),
 * email (dd134), password (dd133), user image (dd522). Nothing else, ever: dd244, dd132,
 * dd1725, dd515 and dd330 are deliberately excluded, so this predicate can never widen
 * into an escalation.
 *
 * WHY IT EXISTS — ROOT WAS LOCKED OUT OF ITS OWN RECORD. `assertRecordWriteTarget`
 * refuses `section_id < 1` for EVERY caller (SEC-05: root's password must not be
 * rewritable by any global admin holding a level-2 grant on `(dd128, dd133)`), and the
 * users section is the one place a legitimate record carries a non-positive id: root is
 * dd128/-1. So the refusal also blocked root from saving its OWN password and its OWN
 * email — and root is excluded from the emailed recovery flow by the same `id > 0` rule
 * (password_reset.ts), which left an installation with NO in-engine way to rotate its
 * most privileged credential. That was a side effect nobody chose.
 *
 * The carve-out is a NARROW exception to the ID rule, not to the LEVEL rule: the level
 * still comes from `getRecordComponentPermission`, which forces dd244 to 1 for everyone
 * including root and keeps the four self-editable components at 2. And it is bound to
 * the ACTOR'S OWN id, so it grants a global admin nothing on root's record: their
 * `principal.userId` is not -1, the predicate is false, and the non-positive-id refusal
 * runs exactly as before.
 *
 * Divergence from the frozen PHP, recorded as
 * `engineering/wire_contract/WC-2026-08-28-root-self-service-write.md`.
 */
export function isSelfServiceAccountWrite(
	principal: Principal,
	sectionTipo: string,
	componentTipo: string,
	sectionId: number | string | null | undefined,
): boolean {
	if (!isActorsOwnUserRecord(principal, sectionTipo, sectionId)) return false;
	return SELF_EDITABLE_COMPONENTS.has(componentTipo);
}

/**
 * THE RECORD-ADDRESSED COMPONENT PERMISSION — `getPermissions` with the dd128
 * own-record rule already applied (P1-2, closes SEC-03).
 *
 * `resolveOwnUserRecordPermission` above is a WRITE gate, and it was a helper three
 * doors remembered to call. Every OTHER door read the raw matrix level, so a principal
 * holding level 2 on `(dd128, dd1725)` — the departmental user-manager role the
 * downgrade exists to neutralise — was refused by the human save door and SUCCEEDED
 * through `tool_propagate_component_data` and through the MCP `set_field` door.
 *
 * The rule is now part of the RESOLUTION: any door that holds a record address asks
 * this instead of `getPermissions`, and the answer already carries the downgrade (a
 * user may not raise their own profile / developer flag / username / section_id) and
 * the upgrade (the self-service profile editor keeps working on name / email /
 * password / image, which no ordinary profile grants).
 *
 * `getPermissions` itself is deliberately NOT changed: it is a faithful mirror of PHP
 * `common::get_permissions`, and the differential parity contract depends on that
 * fidelity. What changes is which function a RECORD-ADDRESSED door calls.
 *
 * A door with no record address (section-level gates, batch gates) cannot consult the
 * rule even in principle and keeps calling `getPermissions` — those are the ENUMERATED
 * exemptions in `test/unit/dd128_write_census_tripwire.test.ts`.
 */
export async function getRecordComponentPermission(
	principal: Principal,
	sectionTipo: string,
	componentTipo: string,
	sectionId: number | string | null | undefined,
): Promise<number> {
	const ownRecordLevel = resolveOwnUserRecordPermission(
		principal,
		sectionTipo,
		componentTipo,
		sectionId,
	);
	if (ownRecordLevel !== null) return ownRecordLevel;
	const level = await getPermissions(principal, sectionTipo, componentTipo);
	// A global admin skips the guarded downgrade (PHP), so the matrix decides — and most
	// profiles grant 0 on dd128, which refused tool_user_admin's read-only section id /
	// username / profile rows on the admin's OWN record (TODO-071). Your own guarded
	// fields are always readable: a floor, never a cap (a matrix 2 stays 2).
	if (
		level < 1 &&
		SELF_ELEVATION_GUARDED.has(componentTipo) &&
		isActorsOwnUserRecord(principal, sectionTipo, sectionId)
	)
		return 1;
	return level;
}

/**
 * Context-stamp permission for ONE component element (PHP component_common::
 * resolve_component_read_permission, class.component_common.php:3512-3540).
 * SEARCH mode grants every logged user level 2 on: the thesaurus template
 * section (all users may search the thesaurus), the metadata/section-info
 * components, and any NO-RECORD section_id — a SYNTHETIC token (the search
 * panel's client-minted 'search_<n>' ids — PHP (int)-casts them to 0) or an
 * EXTERNAL remote id, per classifyWireSectionId
 * (WC-2026-08-10-section-id-int-canonical). Everything else — and every
 * non-search mode — resolves through the matrix.
 *
 * NON-SEARCH resolves the actor's own dd128 user record through
 * `resolveOwnUserRecordPermission` first (PHP's forced read on the
 * security-administrator flag, the self-elevation guards on
 * profile/developer/username/section_id, and the forced write on the
 * self-editable name/email/password/image) before falling through to the matrix.
 */
export async function resolveComponentContextPermission(
	principal: Principal,
	sectionTipo: string,
	tipo: string,
	sectionId: number | string | null | undefined,
	mode: string,
): Promise<number> {
	if (mode === 'search') {
		if (searchSurfaceGrants(sectionTipo, tipo)) return 2;
		// PHP (int)$section_id === 0: a no-record id grants 2 — classified now
		// (WC-2026-08-10-section-id-int-canonical) instead of the NaN sniff. A
		// SYNTHETIC token ('search_<n>') and an EXTERNAL remote id both keep the
		// grant the NaN branch gave them: neither addresses a matrix record, so
		// the matrix could only mis-deny the search widget. A literal record id 0
		// keeps its grant ((int)-cast parity); any other record id falls through
		// to the matrix. `absent` falls through too — including '' (the WC-entry
		// divergence: the NaN era's Number('') === 0 granted 2 to an EMPTY id).
		if (sectionId !== null && sectionId !== undefined) {
			// Classifier refusal ('007', unusable type) → fall through to the
			// matrix walk like any real record id: no special grant on garbage,
			// no 500 on a permission probe.
			const wireSectionId = await classifyWireSectionId(
				sectionId,
				sectionTipo,
				'permissions.component_context.search',
			).catch((error: unknown) => {
				if (isErrorInDomain(error, 'section_id')) return { kind: 'absent' } as const;
				throw error;
			});
			if (wireSectionId.kind === 'synthetic' || wireSectionId.kind === 'external-ref') return 2;
			if (wireSectionId.kind === 'record' && wireSectionId.id === 0) return 2;
		}
	} else {
		// PHP evaluates the own-record cases only after the search branch has
		// returned, and they DOWNGRADE as well as upgrade — so they run even when
		// the matrix already grants a level.
		// NOTE: the ONT-TLD read-only cap on `ontology7` is NOT here. This function
		// stamps only the MAIN element of a get_data; a section's component elements
		// come from section/read.ts's subdatum loop, which never calls it. The rule
		// lives at the one point both paths cross — resolve/structure_context.ts,
		// beside the consultation-only cap.
		return getRecordComponentPermission(principal, sectionTipo, tipo, sectionId);
	}
	return getPermissions(principal, sectionTipo, tipo);
}
