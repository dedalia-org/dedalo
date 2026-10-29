/**
 * Tools registry reader + user_tools resolver (PHP tool_common::
 * get_all_registered_tools → get_user_tools → create_tool_simple_context,
 * exposed via dd_tools_api::user_tools, and the section/component tool FILTER
 * common::get_tools).
 *
 * WHAT IT IS
 * Dédalo "tools" are ontology-registered mini-applications (export, import,
 * time machine, diffusion, …). Their registry is NOT a bespoke table: each tool
 * is a record in the tools register section (dd1324) stored in matrix_tools with
 * the same typed-JSONB column contract as any other section. A tool is ACTIVE
 * when its dd1354 radio_button relation points at dd64/1.
 *
 * WHAT THIS RESOLVES
 * - The SUPERUSER user_tools list: every active tool as a "simple context" DDO.
 * - The AUTHORIZED user_tools of a specific (non-admin) user, via their profile.
 * - The section/component tool FILTER (common::get_tools): the actor's
 *   user_tools membership (PHP iterates get_user_tools($user_id), so a tool the
 *   profile denies can never reach a toolbar), then affected_models /
 *   affected_tipos / all_components / in_properties matching plus per-tool
 *   is_available(). The actor comes from the request scope
 *   (security/request_context.ts), PHP's logged_user_id() — see
 *   currentActorToolNames.
 *
 * The per-tool `is_available()` for tools that HAVE a server module is answered
 * by that module's hook (see loader/dispatch, Phase 3+). Until each of the two
 * legacy endpoints moves, the availability of tool_time_machine / tool_diffusion
 * is answered here as a core fallback so parity tests stay pinned.
 *
 * LEDGERED (not implemented here):
 * - tool_config ddo_map `self` resolution (used when a tool is opened against a
 *   specific record) — that is the get_element_context tool branch (Phase 6).
 */

import { isConsultationOnlySection } from '../concepts/section.ts';
import { sql } from '../db/postgres.ts';
import { createDataCache } from '../ontology/cache_factory.ts';
import { resolveLangItems } from '../resolve/lang_fallback.ts';
import { currentApplicationLang } from '../resolve/request_lang.ts';
import { composeContains, locatorJsonVariants } from '../search/containment.ts';
import { SUPERUSER_ID } from '../security/permissions.ts';
import {
	AFFECTED_MODELS_SECTION_TIPO,
	MODEL_NAME_COMPONENT,
	PROFILE_SECTION_TIPO,
	PROFILE_TOOLS_COMPONENT,
	TIPO,
	TOOLS_REGISTER_SECTION_TIPO,
} from './ontology_map.ts';
import { getToolUrl } from './paths.ts';
import type { ElementToolsResult, ElementToolsTarget, ToolSimpleContext } from './types.ts';

export type { ElementToolsResult, ElementToolsTarget, ToolSimpleContext } from './types.ts';
/** Re-exported for callers that still reference the register section by name. */
export const TOOLS_SECTION_TIPO = TOOLS_REGISTER_SECTION_TIPO;

/**
 * The users section — NOT a tool-registry tipo (ontology_map.ts's hard rule
 * covers those), so it is file-local here as everywhere else that names it
 * (security/auth.ts, resolve/read_tm.ts, …). A dd128 write changes a user's
 * PROFILE ASSIGNMENT, which is one of the two inputs to the grants cache below.
 */
const USERS_SECTION_TIPO = 'dd128';

/**
 * Tools whose availability the section-tools filter cannot yet decide because
 * their PHP `is_available()` depends on a not-yet-ported subsystem. They are
 * omitted from the filtered result and reported separately (never silently
 * included/excluded).
 */
const AVAILABILITY_LEDGERED_TOOLS: ReadonlySet<string> = new Set<string>([]);

/**
 * Component models that override get_tools() to return [] (PHP
 * component_section_id / component_info): they never show a toolbar, whatever
 * the registry would otherwise match.
 */
const NO_TOOLS_MODELS: ReadonlySet<string> = new Set(['component_section_id', 'component_info']);

/** Shape of the typed columns we read from a matrix_tools record. */
interface ToolRow {
	string: Record<string, { lang?: string; value?: string }[] | undefined> | null;
	misc: Record<string, { value?: unknown }[] | undefined> | null;
	// KEPT UNION: the raw jsonb relation column of matrix_tools — tool records
	// imported from register.json (and every pre-sweep install) still carry the
	// string form, which radioIsYes compares as text.
	relation: Record<string, { section_id?: string | number }[] | undefined> | null;
}

/**
 * A radio_button flag is "yes" when its first locator targets dd64/1 (PHP
 * create_simple_tool_object: `$data[0]->section_id == '1'`).
 */
function radioIsYes(relation: ToolRow['relation'], componentTipo: string): boolean {
	const first = relation?.[componentTipo]?.[0];
	return first !== undefined && String(first.section_id) === '1';
}

/**
 * Resolve the tool label in the application language, falling back down the
 * deterministic chain (resolve/lang_fallback.ts — alias, install default,
 * source lang, then any) and finally to the tool NAME. PHP took items[0], i.e.
 * whichever lang sorted first in storage: WC-2026-08-02-tool-string-lang-fallback.
 */
function resolveToolLabel(
	labelItems: { lang?: string; value?: string }[] | undefined,
	name: string,
): string {
	const label = resolveLangItems(labelItems, currentApplicationLang());
	return label ?? name;
}

/**
 * The SUPERUSER user_tools list: every ACTIVE tool as a simple-context DDO,
 * ordered by section_id (the registry's stable order).
 */
export async function getSuperuserUserTools(): Promise<ToolSimpleContext[]> {
	const rows = await fetchActiveToolRows();
	const tools: ToolSimpleContext[] = [];
	for (const row of rows) {
		const tool = buildToolSimpleContext(row);
		if (tool !== null) tools.push(tool);
	}
	return tools;
}

/**
 * The AUTHORIZED tools of one user (PHP tool_common::get_user_tools).
 *
 * THE UNFILTERED LIST BELONGS TO THE SUPERUSER ID ALONE. PHP's only unfiltered
 * branch is `if ($user_id == DEDALO_SUPERUSER)` (tools/tool_common/
 * class.tool_common.php:1403) — there is no admin FLAG in that decision. Every
 * other user, global admin included, receives the tools their PROFILE record
 * grants (dd234's dd1067 locators → tool registry section_ids) plus the tools
 * flagged always_active; a user without a profile gets only the always_active
 * set (fail-closed).
 *
 * 2026-08-09 (audit OH1 finding 5): this function used to open with
 * `if (isGlobalAdmin) return getSuperuserUserTools()`, so every non-superuser
 * global admin was over-granted EVERY tool at six of the seven call sites — the
 * menu door alone had been corrected, in isolation, by passing the rule
 * (`userId === SUPERUSER_ID`) instead of the caller's flag. The rule now lives
 * HERE, once, so every door inherits it.
 *
 * @param deprecatedIsGlobalAdmin IGNORED — kept only so the call sites that
 * still pass `principal.isGlobalAdmin` compile until they are cleaned up
 * (handoff). Passing `true` cannot widen the result, and omitting it changes
 * nothing: both are pinned in test/unit/user_tools_admin_flag_native.test.ts.
 */
export async function getUserTools(
	userId: number,
	deprecatedIsGlobalAdmin?: boolean,
): Promise<ToolSimpleContext[]> {
	void deprecatedIsGlobalAdmin;
	// AI tools hidden without a model or until redesigned (src/ai/capabilities.ts).
	// Applied HERE, once, so no door can offer or grant a hidden tool. Dynamic
	// import keeps ai/ out of the tools registry's static import graph.
	const { aiCapabilities, toolOfferedByCapabilities } = await import('../../ai/capabilities.ts');
	const capabilities = aiCapabilities();
	const offered = (tools: ToolSimpleContext[]) =>
		tools.filter((tool) => toolOfferedByCapabilities(tool.name, capabilities));

	if (userId === SUPERUSER_ID) return offered(await getSuperuserUserTools());

	const allowedIds = await getProfileGrantedToolIds(userId);
	const rows = await fetchActiveToolRows();
	const tools: ToolSimpleContext[] = [];
	for (const row of rows) {
		const alwaysActive = radioIsYes(row.relation, TIPO.ALWAYS_ACTIVE);
		if (!alwaysActive && !allowedIds.has(row.section_id)) continue;
		const tool = buildToolSimpleContext(row);
		if (tool !== null) tools.push(tool);
	}
	return offered(tools);
}

/**
 * Per-user cache of the tool-registry section_ids the user's PROFILE grants
 * (dd234's dd1067 locators). Cached because the toolbar stamp needs it once per
 * ELEMENT — a 40-component edit read would otherwise pay ~40 profile queries.
 *
 * Lifecycle (mirrors permissions.ts permissionsTableCache, the same derivation):
 * the value derives from BOTH the user record (dd1725 profile assignment) and
 * the profile record (dd1067 grants), so a write/delete of either section drops
 * it via the save-event channel — coarse clear, since the reverse
 * profile→users mapping is not known here. Registered BY CONSTRUCTION through
 * createDataCache (WS-B/DEC-13 rule 1), so it can never be forgotten.
 */
const profileToolGrantsCache = createDataCache<number, Set<number>>((cache, sectionTipo) => {
	if (sectionTipo === USERS_SECTION_TIPO || sectionTipo === PROFILE_SECTION_TIPO) cache.clear();
});

/**
 * The tool-registry section_ids one user's profile authorizes (PHP
 * tool_common::get_user_tools' dd1067 read). A user with no profile gets an
 * empty set — fail-closed; only always_active tools then survive the filter.
 */
export async function getProfileGrantedToolIds(userId: number): Promise<Set<number>> {
	const cached = profileToolGrantsCache.get(userId);
	if (cached !== undefined) return cached;
	const allowedIds = new Set<number>();
	// KEPT UNION on grants[].section_id: the profile's dd1067 locators are raw
	// stored jsonb — a pre-sweep install holds the string form; each is
	// Number()-ed into the allowed-id set below.
	const profileRows = (await sql.unsafe(
		`SELECT p.relation->'${PROFILE_TOOLS_COMPONENT}' AS grants
		 FROM matrix_profiles p
		 WHERE p.section_tipo = '${PROFILE_SECTION_TIPO}' AND p.section_id = (
			SELECT (u.relation->'dd1725'->0->>'section_id')::int
			FROM matrix_users u WHERE u.section_id = $1
		 )`,
		[userId],
	)) as { grants: { section_id?: string | number; section_tipo?: string }[] | null }[];
	for (const locator of profileRows[0]?.grants ?? []) {
		if (locator?.section_tipo === TOOLS_REGISTER_SECTION_TIPO && locator.section_id !== undefined) {
			allowedIds.add(Number(locator.section_id));
		}
	}
	profileToolGrantsCache.set(userId, allowedIds);
	return allowedIds;
}

/**
 * The tool NAMES the CURRENT request's actor may see, or null for "no filter"
 * (the SUPERUSER — every active tool — or no request scope at all: internal
 * resolutions, background warmups and test harnesses, the same posture
 * ddoIsAuthorized takes for an undefined principal).
 *
 * THE SAME RULE AS getUserTools (closure Step 3 req 8, 2026-10-01): the
 * unfiltered set belongs to the superuser ID alone. This stamp used to open
 * with `principal.isGlobalAdmin → null`, the admin-flag over-grant
 * getUserTools shed on 2026-08-09 — so a non-superuser global admin's toolbar
 * offered every tool and the dispatcher (gate 4) then refused the click.
 *
 * WHY THE ALS BACKSTOP: PHP's common::get_tools reads `logged_user_id()`
 * directly, and getElementTools is a leaf with no principal parameter to reach
 * for — precisely the case core/security/request_context.ts blesses the scope
 * accessor for. dispatchRqo opens the scope once per RQO, so every real request
 * is filtered.
 */
async function currentActorToolNames(): Promise<ReadonlySet<string> | null> {
	const { currentPrincipal } = await import('../security/request_context.ts');
	const principal = currentPrincipal();
	if (principal === undefined || principal.userId === SUPERUSER_ID) return null;
	const [granted, registered] = await Promise.all([
		getProfileGrantedToolIds(principal.userId),
		getRegisteredTools(),
	]);
	const names = new Set<string>();
	for (const tool of registered) {
		if (tool.alwaysActive || granted.has(tool.sectionId)) names.add(tool.name);
	}
	return names;
}

/**
 * Active registry rows (dd1354 dd64/1), in stable section_id order — cached in
 * activeToolRowsCache (see its header: this is a constant query that used to be
 * re-issued once per rendered list row).
 */
async function fetchActiveToolRows(): Promise<(ToolRow & { section_id: number })[]> {
	if (activeToolRowsCache !== null) {
		return activeToolRowsCache;
	}
	// The dd64/1 active flag is probed in BOTH typed section_id forms
	// (WC-2026-08-10-section-id-int-canonical): registry locators are stored
	// string-form until the int sweep and int-form after, and jsonb `@>` is
	// type-strict — one form alone makes every tool look inactive on the other
	// side of the migration. TIPO.ACTIVE is a code constant (no injection
	// surface), so it stays interpolated as the jsonb key.
	const queryParams: string[] = [TOOLS_REGISTER_SECTION_TIPO];
	const activeClause = composeContains(
		`relation->'${TIPO.ACTIVE}'`,
		[locatorJsonVariants({ section_id: 1, section_tipo: 'dd64' }).map((json) => `[${json}]`)],
		(payload) => {
			queryParams.push(payload);
			return `$${queryParams.length}`;
		},
	);
	const rows = (await sql.unsafe(
		`SELECT section_id, string, misc, relation
		 FROM matrix_tools
		 WHERE section_tipo = $1
		   AND ${activeClause}
		 ORDER BY section_id`,
		queryParams,
	)) as (ToolRow & { section_id: number })[];
	activeToolRowsCache = rows;
	return rows;
}

/** Per-tool metadata the `view_tools` datalist hydration needs. */
export interface ToolDatalistMeta {
	/** Internal tool name (e.g. 'tool_lang') — the icon-URL and label segment. */
	name: string;
	/** Whether the tool cannot be deactivated for a profile (dd1601 radio). */
	always_active: boolean;
	/** Tool description (dd612) in the requested lang (fallback chain), raw stored HTML; null when none. */
	description: string | null;
}

/**
 * section_id → {name, always_active, description} over the ACTIVE tools registry, for the
 * dd1067 security-tools datalist hydration (PHP tool_common::hydrate_tools_info,
 * which builds its map from get_all_registered_tools → get_active_tools). A
 * malformed row (no name) is skipped; the caller falls back to 'Unknown'/false,
 * matching the PHP `$tools_map[$section_id] ?? null` branch.
 */
export async function getActiveToolMetaBySectionId(
	lang: string = currentApplicationLang(),
): Promise<Map<number, ToolDatalistMeta>> {
	const rows = await fetchActiveToolRows();
	const map = new Map<number, ToolDatalistMeta>();
	for (const row of rows) {
		const name = row.string?.[TIPO.NAME]?.[0]?.value;
		if (name === undefined || name === '') continue;
		map.set(row.section_id, {
			name,
			always_active: radioIsYes(row.relation, TIPO.ALWAYS_ACTIVE),
			description: resolveLangItems(row.string?.[TIPO.DESCRIPTION], lang),
		});
	}
	return map;
}

/** One registry row → the simple-context DDO (null for a malformed record). */
function buildToolSimpleContext(row: ToolRow): ToolSimpleContext | null {
	const name = row.string?.[TIPO.NAME]?.[0]?.value;
	if (name === undefined || name === '') return null;

	const baseUrl = getToolUrl(name);
	const properties = row.misc?.[TIPO.PROPERTIES]?.[0]?.value ?? null;
	// PHP dd_object drops a null `properties` key entirely and keeps it in
	// declaration position (between model and label) when present — the
	// conditional spread reproduces both, so the DDO is byte-identical.
	return {
		typo: 'ddo',
		type: 'tool',
		section_tipo: TOOLS_REGISTER_SECTION_TIPO,
		mode: 'edit',
		model: name,
		...(properties !== null ? { properties } : {}),
		label: resolveToolLabel(row.string?.[TIPO.LABEL], name),
		css: { url: `${baseUrl}/css/${name}.css` },
		name,
		icon: `${baseUrl}/img/icon.svg`,
		show_in_inspector: radioIsYes(row.relation, TIPO.SHOW_IN_INSPECTOR),
		show_in_component: radioIsYes(row.relation, TIPO.SHOW_IN_COMPONENT),
	};
}

/**
 * A registered tool's lang-INDEPENDENT row data plus the fields the
 * section-context filter needs. The simple-context DDO is NOT stored here: its
 * label depends on the per-request application lang, so getElementTools builds
 * it fresh per call (PHP-shaped — PHP's tool file cache stores the label as a
 * lang-wrapped array resolved per request).
 */
interface RegisteredTool {
	name: string;
	/** dd1324 record id — what a profile's dd1067 grant locators point at. */
	sectionId: number;
	/** dd1601: the tool cannot be withheld from a profile (PHP always_active). */
	alwaysActive: boolean;
	/** Raw dd799 lang-wrapped label items; resolved per call via resolveToolLabel. */
	labelItems: { lang?: string; value?: string }[] | undefined;
	/** Parsed dd1348 properties value, or null (dd_object drops a null key). */
	properties: unknown;
	showInInspector: boolean;
	showInComponent: boolean;
	/** Resolved model names the tool affects (dd1330 → dd1342 names). */
	affectedModels: string[];
	/** Tipos/patterns the tool restricts to (dd1350 misc value), or []. */
	affectedTipos: string[];
	requirementTranslatable: boolean;
}

/**
 * tipo membership test (PHP tipo_in_array): a value matches when it is a
 * wildcard sharing the tipo's TLD (`numisdata*`), a `/…/` regex the tipo
 * matches, or an exact string. Empty list → no restriction (caller checks).
 */
function tipoInArray(tipo: string, values: string[]): boolean {
	const tld = (candidate: string): string => candidate.replace(/[0-9].*$/, '');
	for (const value of values) {
		if (typeof value !== 'string') continue;
		if (value.includes('*')) {
			if (tld(tipo) === tld(value)) return true;
		}
		if (value.includes('/')) {
			// PHP-style `/pattern/flags` delimited regex → JS RegExp.
			const match = value.match(/^\/(.*)\/([a-z]*)$/);
			if (match) {
				try {
					if (new RegExp(match[1] as string, match[2]).test(tipo)) return true;
				} catch {
					// malformed pattern — ignore, mirrors PHP's failed preg_match
				}
			}
		}
	}
	return values.includes(tipo);
}

/**
 * Availability check (PHP is_available). A tool that ships a server module owns
 * this decision via the module's isAvailable hook; tools without a module yet
 * fall back to the core rules below. Returns null when the decision is ledgered
 * (caller omits + reports the tool).
 */
export async function toolIsAvailable(
	name: string,
	context: { calledClass: string; tipo: string; isComponent: boolean; hasToolConfig: boolean },
): Promise<boolean | null> {
	if (AVAILABILITY_LEDGERED_TOOLS.has(name)) return null;

	// Prefer the tool's own server-module hook (PHP is_available).
	const { getLoadedTool, toolModuleFailedToLoad } = await import('./loader.ts');
	// A tool whose server module exists but failed to load has an unreachable
	// isAvailable hook: fail CLOSED, never fall through to "always available"
	// (a missing dependency used to surface a section-scoped tool everywhere).
	if (await toolModuleFailedToLoad(name)) return false;
	const loaded = await getLoadedTool(name);
	if (loaded?.module.isAvailable !== undefined) {
		return loaded.module.isAvailable({
			callerModel: context.calledClass,
			tipo: context.tipo,
			sectionTipo: context.tipo,
			isComponent: context.isComponent,
			mode: '',
			hasToolConfig: context.hasToolConfig,
		});
	}

	// Core fallbacks for tools that have not yet moved to a server module.
	if (name === 'tool_diffusion') {
		// PHP tool_diffusion::is_available — sections only, and the section
		// must appear in the diffusion section-map (virtual-tree walk).
		if (context.isComponent) return false;
		const { haveSectionDiffusion } = await import('../diffusion_bridge/diffusion_map.ts');
		return haveSectionDiffusion(context.tipo);
	}
	return true; // tools without an is_available() are always available
}

/** Batch-resolve dd1342 record ids → their model-name strings. */
async function getAffectedModelNameMap(): Promise<Map<string, string>> {
	const table = 'matrix_dd';
	const rows = (await sql.unsafe(
		`SELECT section_id, string->'${MODEL_NAME_COMPONENT}'->0->>'value' AS model_name
		 FROM ${table} WHERE section_tipo = $1`,
		[AFFECTED_MODELS_SECTION_TIPO],
	)) as { section_id: number; model_name: string | null }[];
	const map = new Map<string, string>();
	for (const row of rows) {
		if (row.model_name !== null) map.set(String(row.section_id), row.model_name);
	}
	return map;
}

/**
 * Registry cache (PHP caches this in a static + file). It holds ONLY
 * lang-independent row data (see RegisteredTool) — anything derived from the
 * per-request application lang (the simple-context label) is resolved per call
 * in getElementTools, never cached here. Clear it when the tools ontology
 * changes (import_tools) via invalidateAllToolCaches() in ./cache.ts.
 *
 * Single-writer semantics (2026-07-11 cutover, PHP engine retired): every
 * dd1324 write goes through this engine's write path, which invalidates via
 * the save_event channel — invalidation-only, no staleness window. (The
 * coexistence-era S2-09 TTL that bounded PHP-side-write staleness is deleted;
 * rewrite/COEXISTENCE.md history.)
 */
let registeredToolsCache: RegisteredTool[] | null = null;

/**
 * The RAW active-registry rows behind every reader in this file — same
 * lifecycle, same invalidation, same lang-independence rule as
 * registeredToolsCache above.
 *
 * WHY IT EXISTS. fetchActiveToolRows() takes no arguments: it is the same
 * constant query every time. It was re-issued on EVERY call, and the
 * component_info media_icons widget calls it once per rendered row — so the oh1
 * list page ran this one JSONB-containment query 10 times per read for 43ms of
 * the 110ms it spent in SQL (measured 2026-08-03). Caching the rows makes it
 * once per invalidation.
 *
 * ONLY RAW ROWS ARE CACHED, never a built ToolSimpleContext: the label is
 * resolved from the per-request application lang (resolveToolLabel →
 * currentApplicationLang), so caching a built context would serve one request's
 * language to the next. Callers still build per request from these rows.
 */
let activeToolRowsCache: (ToolRow & { section_id: number })[] | null = null;

/**
 * Reset the registry reader caches. Prefer invalidateAllToolCaches() (./cache.ts).
 *
 * The per-user profile-grants cache is dropped here TOO, even though
 * createDataCache already evicts it on every dd128/dd234 write: the module
 * header of ./cache.ts claims invalidateAllToolCaches() is THE single entry
 * point for the subsystem's caches, and a cache reachable only through a second
 * channel makes that claim false. Both routes are cheap; the redundancy keeps
 * the documented invariant honest.
 */
export function resetRegistryCache(): void {
	registeredToolsCache = null;
	activeToolRowsCache = null;
	profileToolGrantsCache.clear();
}

/** Read every active tool with the extra fields the section filter needs. */
async function getRegisteredTools(): Promise<RegisteredTool[]> {
	if (registeredToolsCache !== null) {
		return registeredToolsCache;
	}
	const modelNames = await getAffectedModelNameMap();
	// Same active-registry rows every other reader uses — this used to be a
	// second, byte-identical copy of that query behind its own cache.
	const rows = await fetchActiveToolRows();

	const registered: RegisteredTool[] = [];
	for (const row of rows) {
		const name = row.string?.[TIPO.NAME]?.[0]?.value;
		if (name === undefined || name === '') continue;

		// affected_models: each dd1330 locator → its dd1342 model name.
		const affectedModels: string[] = [];
		for (const locator of row.relation?.[TIPO.AFFECTED_MODELS] ?? []) {
			const modelName = modelNames.get(String(locator.section_id));
			if (modelName !== undefined) affectedModels.push(modelName);
		}
		// affected_tipos: misc value array (tipos/patterns), or [].
		const affectedTiposRaw = (row.misc?.[TIPO.AFFECTED_TIPOS]?.[0] as { value?: unknown })?.value;
		const affectedTipos = Array.isArray(affectedTiposRaw) ? affectedTiposRaw.map(String) : [];

		registered.push({
			name,
			sectionId: row.section_id,
			alwaysActive: radioIsYes(row.relation, TIPO.ALWAYS_ACTIVE),
			labelItems: row.string?.[TIPO.LABEL],
			properties: row.misc?.[TIPO.PROPERTIES]?.[0]?.value ?? null,
			showInInspector: radioIsYes(row.relation, TIPO.SHOW_IN_INSPECTOR),
			showInComponent: radioIsYes(row.relation, TIPO.SHOW_IN_COMPONENT),
			affectedModels,
			affectedTipos,
			requirementTranslatable: radioIsYes(row.relation, TIPO.REQUIRE_TRANSLATABLE),
		});
	}
	registeredToolsCache = registered;
	return registered;
}

/**
 * The tools shown for ONE element (PHP common::get_tools, superuser user_tools).
 * A tool applies when the element model is in affected_models, OR the tipo
 * matches affected_tipos, OR (component) 'all_components' is in affected_models,
 * OR the element declares it in properties.tool_config; then any non-empty
 * affected_tipos must match the tipo, requirement_translatable must agree with
 * the element's effective translatable, and is_available() must pass.
 * Availability-ledgered tools are reported, not guessed.
 */
export async function getElementTools(target: ElementToolsTarget): Promise<ElementToolsResult> {
	// Models that hard-override get_tools() to [] never show a toolbar.
	if (NO_TOOLS_MODELS.has(target.model)) return { tools: [], ledgered: [] };

	const registered = await getRegisteredTools();
	// PHP get_tools iterates get_user_tools($user_id) — the actor's AUTHORIZED
	// list, not the whole registry — so a tool their profile does not grant can
	// never reach a toolbar. null = no filter (global admin / no request scope).
	const actorTools = await currentActorToolNames();
	// AI tools hidden without a model or until redesigned (src/ai/capabilities.ts).
	// Applied for EVERY actor, the global admin included: actorTools is null for
	// the superuser, so without this gate an admin's toolbar would still list them.
	const { aiCapabilities, toolOfferedByCapabilities } = await import('../../ai/capabilities.ts');
	const capabilities = aiCapabilities();
	const inPropertyTools = new Set(target.toolConfigKeys);
	const context = {
		calledClass: target.model,
		tipo: target.tipo,
		isComponent: target.isComponent,
	};
	// PHP effective translatable: a section is never translatable; a component is
	// translatable unless it is both non-translatable AND has no lang versions.
	// (with_lang_versions is a rare component flag, deferred — defaults false.)
	const effectiveTranslatable = target.isComponent ? target.translatable : false;

	const tools: ToolSimpleContext[] = [];
	const ledgered: string[] = [];
	for (const tool of registered) {
		// The user_tools membership gate, BEFORE the applies/availability work.
		if (actorTools !== null && !actorTools.has(tool.name)) continue;
		if (!toolOfferedByCapabilities(tool.name, capabilities)) continue;
		const applies =
			tool.affectedModels.includes(target.model) ||
			tipoInArray(target.tipo, tool.affectedTipos) ||
			(target.isComponent && tool.affectedModels.includes('all_components')) ||
			inPropertyTools.has(tool.name);
		if (!applies) continue;

		// affected_tipos[0] restriction: when set, the tipo must match.
		if (tool.affectedTipos.length > 0 && !tipoInArray(target.tipo, tool.affectedTipos)) {
			continue;
		}
		// requirement_translatable: a tool requiring translatability is shown only
		// when the element is (effectively) translatable (PHP requirement === translatable).
		if (tool.requirementTranslatable && !effectiveTranslatable) continue;

		const available = await toolIsAvailable(tool.name, {
			...context,
			hasToolConfig: inPropertyTools.has(tool.name),
		});
		if (available === null) {
			ledgered.push(tool.name);
			continue;
		}
		if (available === false) continue;

		// FRESH simple-context DDO per call: the label resolves against THIS
		// request's application lang, and no caller ever receives (or can
		// mutate) a cache-owned object.
		const baseUrl = getToolUrl(tool.name);
		const simpleContext: ToolSimpleContext = {
			typo: 'ddo',
			type: 'tool',
			section_tipo: TOOLS_REGISTER_SECTION_TIPO,
			mode: 'edit',
			model: tool.name,
			label: resolveToolLabel(tool.labelItems, tool.name),
			css: { url: `${baseUrl}/css/${tool.name}.css` },
			name: tool.name,
			icon: `${baseUrl}/img/icon.svg`,
			show_in_inspector: tool.showInInspector,
			show_in_component: tool.showInComponent,
		};
		if (tool.properties !== null) simpleContext.properties = structuredClone(tool.properties);
		tools.push(simpleContext);
	}
	return { tools, ledgered };
}

/**
 * The FULL tool element context (PHP dd_core_api::get_element_context tool
 * branch), served when the client's open_tool receives a tool NAME string
 * instead of a full context object (source:{model:'tool_x'}, no tipo). Richer
 * than the toolbar simple context: it also carries tipo/lang/labels(dd1372)/
 * description(dd612)/developer(dd1644). Returns null for an unknown tool.
 */
export async function buildToolElementContext(
	name: string,
): Promise<Record<string, unknown> | null> {
	const rows = (await sql`
		SELECT string, misc, relation
		FROM matrix_tools
		WHERE section_tipo = ${TOOLS_REGISTER_SECTION_TIPO}
		  AND string->${TIPO.NAME}->0->>'value' = ${name}
		LIMIT 1
	`) as ToolRow[];
	const row = rows[0];
	if (row === undefined) return null;
	// A tool hidden on this deployment has no element context either (open_tool by name).
	const { aiCapabilities, toolOfferedByCapabilities } = await import('../../ai/capabilities.ts');
	if (!toolOfferedByCapabilities(name, aiCapabilities())) return null;

	const appLang = currentApplicationLang();
	const baseUrl = getToolUrl(name);
	const properties = row.misc?.[TIPO.PROPERTIES]?.[0]?.value ?? null;
	// Labels (dd1372) are stored for every lang but PHP exposes only the
	// application-lang entries in the tool context. SINGLE-LANG CONTRACT: the
	// client's get_tool_label (client/dedalo/core/tools_common/js/tool_common.js) treats a name match
	// as already-correct-language BECAUSE of this filter, and relies on its own
	// `|| 'literal'` fallback when the lang has no entry (the array is then empty).
	// Widening this to several langs is a wire change: it needs a WIRE_CONTRACT
	// entry, a re-cut of the frozen tool_element_context fixture, and the client
	// resolver taught to choose. Gated by test/unit/tool_context_labels_lang.test.ts.
	const allLabels = (row.misc?.[TIPO.LABELS]?.[0] as { value?: unknown })?.value;
	const labels = Array.isArray(allLabels)
		? allLabels.filter((item) => (item as { lang?: string }).lang === appLang)
		: null;
	const developer = row.string?.[TIPO.DEVELOPER]?.[0]?.value ?? null;
	const description = resolveLangItems(row.string?.[TIPO.DESCRIPTION], appLang);

	// Field order mirrors PHP create_tool_simple_context (dd_object drops null
	// keys); consumers compare structurally so order is not load-bearing.
	const context: Record<string, unknown> = {
		typo: 'ddo',
		type: 'tool',
		tipo: TOOLS_REGISTER_SECTION_TIPO,
		section_tipo: TOOLS_REGISTER_SECTION_TIPO,
		lang: appLang,
		mode: 'edit',
		model: name,
		...(properties !== null ? { properties } : {}),
		label: resolveToolLabel(row.string?.[TIPO.LABEL], name),
		...(labels !== null ? { labels } : {}),
		css: { url: `${baseUrl}/css/${name}.css` },
		name,
		...(description !== null ? { description } : {}),
		icon: `${baseUrl}/img/icon.svg`,
		...(developer !== null && developer !== '' ? { developer } : {}),
		show_in_inspector: radioIsYes(row.relation, TIPO.SHOW_IN_INSPECTOR),
		show_in_component: radioIsYes(row.relation, TIPO.SHOW_IN_COMPONENT),
	};
	// Client-visible config (dd999/dd1633 client:true props): PHP appends a
	// `config` key when the tool has any, carrying the full prop definitions.
	const { getToolClientConfigRaw } = await import('./config.ts');
	const clientConfig = await getToolClientConfigRaw(name);
	if (Object.keys(clientConfig).length > 0) context.config = clientConfig;
	return context;
}

/** Backwards-compatible section-tools helper (model 'section', non-component). */
export async function getSectionTools(
	sectionTipo: string,
	sectionToolConfigKeys: string[] = [],
): Promise<ElementToolsResult> {
	// Consultation-only sections (Activity dd542, Time Machine dd15, TODO-042) are
	// strictly read-only system logs (WC-010): their toolbar would act on records
	// the user can never modify, so they carry NO section tools. This is a
	// SECTION-level rule only — components INSIDE such a section keep their own
	// element tools (e.g. tool_time_machine on a historical value). Keyed on the
	// single-source `isConsultationOnlySection` predicate, so a future read-only
	// section is tool-less by adding one entry. WC-2026-10-06-consultation-only-no-section-tools.
	if (isConsultationOnlySection(sectionTipo)) return { tools: [], ledgered: [] };
	return getElementTools({
		model: 'section',
		tipo: sectionTipo,
		isComponent: false,
		translatable: false,
		toolConfigKeys: sectionToolConfigKeys,
	});
}
