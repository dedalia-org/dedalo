/**
 * Client environment payload (PHP dd_core_api::get_environment) — the
 * {page_globals, plain_vars, get_label} object the copied client injects at
 * boot via set_environment() (see rewrite/client_seam.md):
 * - plain_vars   → window[key] = value (JS globals: urls, flags, DD_TIPOS);
 * - page_globals → Object.assign(page_globals, value) (auth state, langs,
 *   media defaults, feature flags);
 * - get_label    → the localized UI label dictionary.
 *
 * Labels are repo-catalog-derived (src/core/labels/catalog.ts, WC-033) — the
 * dictionary wire shape is unchanged. The scalar values mirror the install configuration;
 * anything marked [install] is configuration the PHP side reads from its
 * config files — mirrored here (env-overridable where it varies per deploy)
 * and kept honest by the differential gate.
 */

import { config } from '../../config/config.ts';
import { readBool, readString } from '../../config/readers.ts';
import { sql } from '../db/postgres.ts';
import { getLabels } from '../labels/catalog.ts';
import { resolveMediaAccessMode } from '../media/protection.ts';
import { createDataCache } from '../ontology/cache_factory.ts';
import type { Principal } from '../security/permissions.ts';
import { SESSION_IDLE_TTL_SECONDS, type Session } from '../security/session_store.ts';
import { getAdditionalToolsUrlMap } from '../tools/paths.ts';
import { DEDALO_BUILD, DEDALO_ENGINE_VERSION, RELEASE_IDENTITY } from '../update/build_stamp.ts';
import { DEDALO_DATA_VERSION, formatVersion } from '../update/version.ts';
import { getAlpha2FromCode, getLangNameFromCode } from './lang_names.ts';
import { currentApplicationLang, currentDataLang } from './request_lang.ts';
import { getServerState } from './server_state.ts';

/**
 * Dev-mode signal (L5): the SERVER posture. It drives DEVELOPMENT_SERVER (and,
 * elsewhere, the no-cache boot path, the readable client libs and the browser
 * test harness). Defaults FALSE (production posture).
 *
 * It deliberately does NOT drive the debug/developer SURFACES: those follow the
 * LOGGED USER, exactly as PHP defined them in boot
 * (core/base/boot/class.boot_web_phases.php: `SHOW_DEBUG = superuser`,
 * `SHOW_DEVELOPER = logged_user_is_developer()`) and as the frozen oracle fixture
 * records (test/parity/fixtures/oracle_harvest/environment_differential.json: a
 * NON-developer on a dev server gets both false, DEVELOPMENT_SERVER true).
 */
const DEV_MODE = readString('DEDALO_DEV_MODE') === 'true';

// Engine version strings come from the ONE source (core/update/version.ts) so
// page_globals/plain_vars and other consumers (the error-report relay stamps
// DEDALO_ENGINE_VERSION, WC-017) cannot drift apart.

/**
 * The DD_TIPOS constant map exposed to the client (PHP get_js_plain_vars —
 * ontology constants client modules resolve by name).
 */
const DD_TIPOS: Readonly<Record<string, string>> = {
	DEDALO_RELATION_TYPE_INDEX_TIPO: 'dd96',
	DEDALO_SECTION_INFO_INVERSE_RELATIONS: 'dd1596',
	DEDALO_RELATION_TYPE_LINK: 'dd151',
	DEDALO_SECTION_RESOURCES_IMAGE_TIPO: 'rsc170',
	DEDALO_COMPONENT_RESOURCES_IMAGE_TIPO: 'rsc29',
};

/** Debug/developer surfaces of the LOGGED user (see SHOW_DEBUG below). */
function userSurfaces(
	session: Session | null,
	principal: Principal | null,
): { showDebug: boolean; showDeveloper: boolean } {
	if (session === null) return { showDebug: false, showDeveloper: false };
	return { showDebug: session.userId === -1, showDeveloper: principal?.isDeveloper === true };
}

/** A non-empty notification string, else null. */
function notificationText(notification: unknown): string | null {
	return typeof notification === 'string' && notification !== '' ? notification : null;
}

/**
 * JS plain globals (PHP get_js_plain_vars). URL layout matches the PHP deploy.
 *
 * The debug/developer flags are PER-USER (PHP boot): an unauthenticated caller
 * (the login form) gets both false, so it never learns whether the person who
 * might log in would see developer surfaces. DEVELOPMENT_SERVER is the server's
 * own posture (DEDALO_DEV_MODE) and is emitted pre-auth on purpose — see below.
 */
export function buildPlainVars(
	session: Session | null,
	principal: Principal | null,
): Record<string, unknown> {
	const surfaces = userSurfaces(session, principal);
	// DIFFUSION CUTOVER LEVER (DIFFUSION_PLAN P5, spec §2.3): the copied
	// tool_diffusion client calls DEDALO_DIFFUSION_API_URL when defined and
	// falls back to the MAIN API otherwise. Emitting the key points the client
	// at the OLD external engine; omitting it flips the byte-identical client
	// onto the native dd_diffusion_api actions with zero client edits (WC-003).
	// DEFAULTS TO NATIVE (catalog default true, 2026-07-29): the external
	// service is decommissioned and this server serves no
	// /dedalo/diffusion/api/v1/ route, so emitting the key can only 404.
	// readBool (NOT readEnv === 'true') so the catalog default actually applies
	// — readEnv returns undefined when unset and ignores the catalog.
	const nativeDiffusion = readBool('DEDALO_DIFFUSION_NATIVE');
	const serverState = getServerState();
	return {
		DEDALO_ENVIRONMENT: true,
		DEDALO_API_URL: '/dedalo/core/api/v1/json/',
		...(nativeDiffusion ? {} : { DEDALO_DIFFUSION_API_URL: '/dedalo/diffusion/api/v1/' }),
		DEDALO_CORE_URL: '/dedalo/core',
		DEDALO_ROOT_WEB: '/dedalo',
		// PHP: DEDALO_ROOT_WEB . '/' . DEDALO_MEDIA_DIR — configurable-origin in PHP
		// too (the root was a config constant). webBase = DEDALO_MEDIA_WEB_BASE or
		// the same-origin relative default; every client media fetch builds on this.
		DEDALO_MEDIA_URL: config.media.webBase,
		DEDALO_TOOLS_URL: '/dedalo/tools',
		// Additional-root tools only (name → base URL); primary-root tools are
		// absent and fall back to /dedalo/tools/<name> in the client (instances.js).
		DEDALO_TOOLS_URLS: getAdditionalToolsUrlMap(),
		// Debug/developer SURFACES follow the LOGGED USER, not the server posture
		// (PHP boot class.boot_web_phases.php): SHOW_DEBUG = superuser,
		// SHOW_DEVELOPER = the user's is_developer flag. In v7 root resolves
		// isDeveloper=true, so the developer bar is shown to root through
		// SHOW_DEVELOPER as well. Both stay authenticated-only: an anonymous
		// caller must never learn the posture (PHP get_js_plain_vars gated them
		// on the logged user too). DEVELOPMENT_SERVER, by contrast, must be
		// exposed pre-auth like PHP (it is emitted unconditionally): the login
		// form reads it BEFORE authentication to pick the no-service-worker cache
		// path on dev servers — gating it on isLogged stalls every dev login
		// (S1-19 register; the flag only reveals dev-vs-prod posture, not debug data).
		SHOW_DEBUG: surfaces.showDebug,
		SHOW_DEVELOPER: surfaces.showDeveloper,
		DEVELOPMENT_SERVER: DEV_MODE,
		DEDALO_UPLOAD_SERVICE_CHUNK_FILES: config.media.upload.chunkFilesMb,
		DEDALO_UPLOAD_SERVICE_MAX_CONCURRENT: config.media.upload.maxConcurrent,
		DEDALO_LOCK_COMPONENTS: config.features.lockComponents,
		DEDALO_MAINTENANCE_MODE: serverState.maintenance_mode,
		DEDALO_NOTIFICATION: notificationText(serverState.notification),
		DEDALO_RR_WORKER: false,
		DD_TIPOS,
	};
}

/**
 * Application langs for the client selector (PHP DEDALO_APPLICATION_LANGS map
 * → [{label, value}] in map order, dd_core_api::get_page_globals shape).
 */
const APPLICATION_LANGS: { label: string; value: string }[] = Object.entries(
	config.lang.applicationLangs,
).map(([value, label]) => ({ label, value }));

/**
 * Can this principal USE tool_error_report: global admin (its sendReport handler
 * refuses anyone else) AND granted by the ONE grant door (isToolGranted). Dynamic
 * import: tools/ must not join environment's static import graph (SCC rule).
 */
async function isErrorReportGranted(principal: Principal | null): Promise<boolean> {
	if (!principal?.isGlobalAdmin) return false;
	const { isToolGranted } = await import('../tools/security.ts');
	return isToolGranted(principal.userId, 'tool_error_report');
}

/**
 * The page_globals object (PHP get_page_globals): auth state from the session,
 * entity/lang/media configuration from the install.
 */
export async function buildPageGlobals(
	session: Session | null,
	principal: Principal | null,
): Promise<Record<string, unknown>> {
	const isLogged = session !== null;
	// Projects default langs: the configured languages resolved through the lang
	// catalog (lg1 records) in this request's data lang — see below.
	const projectsDefaultLangs = await getProjectsDefaultLangs();
	const serverState = getServerState();

	return {
		dedalo_last_error: null,
		is_logged: isLogged,
		is_global_admin: principal?.isGlobalAdmin ?? false,
		is_developer: principal?.isDeveloper ?? false,
		// WC-2026-10-21-error-report-granted: TS-ONLY key. The error-report launcher
		// tab shows only when the ONE grant door says yes (profile dd1067 /
		// always_active / superuser) — is_global_admin alone over-showed it after
		// the 2026-08-09 tool-ACL change. Both reads behind it are cached, so this
		// replaces a per-page user_tools round-trip at no query cost.
		tool_error_report_granted: await isErrorReportGranted(principal),
		// TS-ONLY key: which AI entry points this deployment can offer (assistant
		// needs the HTTP switch AND a model; semantic needs a real embedding sidecar;
		// identify is hidden). The client hides an entry point unless its flag is
		// true, so a missing key is treated as hidden. Dynamic import keeps ai/ out
		// of environment's static import graph (SCC rule, as for tools/ above).
		ai_capabilities: (await import('../../ai/capabilities.ts')).aiCapabilities(),
		is_root: (session?.userId ?? null) === -1,
		user_id: session?.userId ?? null,
		username: session?.username ?? null,
		full_username: isLogged ? '' : null, // root has no full name on this install
		dedalo_entity: config.entity, // DEDALO_ENTITY
		dedalo_entity_id: config.identity.entityId, // DEDALO_ENTITY_ID
		// WC-031: TS-ONLY page_globals key (PHP get_page_globals has no twin). Lets the
		// client skin the whole app when this install is an ontology MASTER server so
		// admins juggling many installations recognize it at a glance. Emitted
		// UNCONDITIONALLY (like maintenance_mode / DEVELOPMENT_SERVER) so the login form
		// is marked too; it is not reconnaissance-sensitive (no DB name / version leak).
		is_ontology_server: config.ontologyIo.isOntologyServer,
		// WC-051: TS-ONLY page_globals keys (PHP get_page_globals has no twin) — the
		// session-expiry warning contract. NULL for anonymous callers: the login form
		// has no session to warn about, and the policy is not advertised pre-auth.
		//
		// Only the ABSOLUTE deadline is shipped, because only it is underivable
		// client-side: the idle window restarts on every authenticated request, so the
		// client re-arms a local timer from `dedalo_session_ttl_seconds` on each
		// response — equivalent to a per-response countdown, at zero wire cost.
		dedalo_session_ttl_seconds: isLogged ? SESSION_IDLE_TTL_SECONDS : null,
		dedalo_session_absolute_expires_in: session?.absoluteExpiresIn ?? null,
		dedalo_session_warning_seconds: isLogged ? Number(readString('SESSION_WARNING_SECONDS')) : null,
		...versionFacts(isLogged),
		mode: 'list',
		// dedalo_application_langs_default is the INSTALL default (PHP
		// DEDALO_APPLICATION_LANGS_DEFAULT); the two live langs reflect the
		// caller's session choice (PHP change_lang → $_SESSION), resolved through
		// the request-scoped language context.
		dedalo_application_langs_default: config.lang.applicationLangsDefault,
		dedalo_application_lang: currentApplicationLang(),
		dedalo_data_lang: currentDataLang(),
		dedalo_data_lang_selector: config.lang.dataLangSelector,
		dedalo_data_lang_sync: config.menu.dataLangSync,
		dedalo_data_nolan: readString('DATA_NOLAN'),
		dedalo_application_langs: APPLICATION_LANGS,
		dedalo_projects_default_langs: projectsDefaultLangs,
		dedalo_image_quality_default: config.media.image.defaultQuality,
		dedalo_av_quality_default: config.media.av.defaultQuality,
		dedalo_quality_thumb: config.media.thumb.quality,
		// WC-2026-09-04-client-limit-bound: TS-ONLY key (PHP get_page_globals has no
		// twin). The SERVER's client ceiling (DEDALO_SEARCH_CLIENT_MAX_LIMIT, the
		// DEC-07 clamp), published so the client bounds every limit it sends to
		// the bound the server will apply — it never sends 0 ("unbounded") and
		// never carries a constant of its own (client/dedalo/core/common/js/
		// sqo_limit.js). Not session-gated: it is a shape of the API, not a secret.
		dedalo_search_client_max_limit: config.features.searchClientMaxLimit,
		tag_id: null,
		// PHP: media_protection::get_mode()!==false ? 1 : 0. Resolved through the media
		// protection module, NOT read straight off the frozen catalog: the root user can
		// change the mode at runtime from the media_control widget (ts_state.json), and
		// this Bun process lives for weeks — the catalog value would stay stale until a
		// restart and the client would advertise the wrong posture.
		dedalo_protect_media_files: resolveMediaAccessMode() !== false ? 1 : 0,
		DEDALO_NOTIFICATIONS: config.features.notifications ? 1 : 0,
		// WC-038: `ip_api` REMOVED from page_globals — IP→country resolution moved
		// server-side/offline (src/core/geoip); the client no longer reads it. The
		// frozen PHP oracle still carries it, so environment_differential strips it
		// PHP-side before the key-set compare.
		fallback_image: '/dedalo/core/themes/default/default.svg',
		locale: config.identity.locale, // DEDALO_LOCALE
		dedalo_date_order: config.identity.dateOrder, // DEDALO_DATE_ORDER
		component_active: null,
		stream_readers: [],
		maintenance_mode: serverState.maintenance_mode,
		dedalo_notification:
			typeof serverState.notification === 'string' && serverState.notification !== ''
				? serverState.notification
				: false,
		recovery_mode: serverState.recovery_mode,
		data_version: DEDALO_DATA_VERSION,
		...(await engineFacts(isLogged)),
		dedalo_root_path: null,
	};
}

/**
 * The version keys of page_globals — API-03: version strings only for
 * authenticated callers. Spread in place by buildPageGlobals, so the wire key
 * order is unchanged.
 *  - `dedalo_version` is the RELEASE IDENTITY (`7.0.0`, `7.0.0-beta.6`,
 *    `7.0.0-dev`) — for display. Anything the client COMPARES or SENDS to
 *    another server reads `dedalo_data_version` beside it: the bare data triple
 *    this code belongs to, so no client ever parses one out of the identity
 *    (WC-2026-10-15-release-identity-from-tag).
 *  - `release_kind`: which of the three the identity is (`stable` |
 *    `prerelease` | `dev`, RELEASE_IDENTITY.kind — the /health vocabulary), so
 *    the client marks a pre-stable build without sniffing the identity's
 *    shape (the menu's version badge; owner Q11). Gated like the identity.
 *  - `dedalo_build`: build provenance (build_stamp.ts), the release commit
 *    date, null on a dev checkout. Key always present.
 */
function versionFacts(isLogged: boolean): Record<string, string | null> {
	if (!isLogged) {
		return {
			dedalo_version: null,
			dedalo_data_version: null,
			release_kind: null,
			dedalo_build: null,
		};
	}
	return {
		dedalo_version: DEDALO_ENGINE_VERSION,
		dedalo_data_version: formatVersion(DEDALO_DATA_VERSION),
		release_kind: RELEASE_IDENTITY.kind,
		dedalo_build: DEDALO_BUILD,
	};
}

/**
 * Reconnaissance-sensitive engine facts (DB name, exact PG/runtime version,
 * process memory) — AUTHENTICATED callers only. An unauthenticated get_environment
 * must not hand out the database name and precise version strings for targeted
 * CVE selection. Null for the login form (parity with dedalo_version above).
 * Spread in place by buildPageGlobals, so the wire key order is unchanged.
 */
async function engineFacts(isLogged: boolean): Promise<Record<string, string | null>> {
	if (!isLogged) {
		return { dedalo_db_name: null, pg_version: null, php_version: null, php_memory: null };
	}
	return {
		dedalo_db_name: config.db.database,
		pg_version: await getPgVersion(),
		php_version: `Bun ${Bun.version}`,
		php_memory: `${Math.round(process.memoryUsage().rss / (1024 * 1024))}M rss`,
	};
}

/**
 * Installation diagnostics for the menu About/info panel (PHP
 * menu::get_info_data) — the header info bar prefers these over page_globals.
 * TS-runtime values under the client's field names.
 */
export async function buildInfoData(): Promise<Record<string, unknown>> {
	return {
		dedalo_version: DEDALO_ENGINE_VERSION,
		// The data triple beside the identity (same split as page_globals).
		dedalo_data_version: formatVersion(DEDALO_DATA_VERSION),
		dedalo_build: DEDALO_BUILD, // release commit date; null on a dev checkout
		dedalo_db_name: config.db.database,
		pg_version: await getPgVersion(),
		php_version: `Bun ${Bun.version}`,
		memory: `${Math.round(process.memoryUsage().rss / (1024 * 1024))}M rss`,
		php_sapi_name: 'bun',
		entity: config.identity.entityLabel, // DEDALO_ENTITY_LABEL (defaults to the entity name)
		php_user: null,
		php_session_handler: 'sqlite',
		pg_db: await getPgVersion(),
		server_software: `Bun.serve ${Bun.version}`,
		ip_server: null,
	};
}

/** PostgreSQL server version (cached — it cannot change under a live pool). */
let pgVersionCache: string | null = null;
async function getPgVersion(): Promise<string> {
	if (pgVersionCache !== null) return pgVersionCache;
	const rows = (await sql`SHOW server_version`) as { server_version: string }[];
	pgVersionCache = rows[0]?.server_version ?? 'unknown';
	return pgVersionCache;
}

/**
 * `dedalo_projects_default_langs` — the install's DATA languages as the client
 * needs them: `{label, value, tld2}`, one entry per configured language.
 *
 * REAL RESOLUTION (was a hardcoded 12-entry list "mirrored for the mib install"):
 * the label comes from the langs section (lg1) records through
 * getLangNameFromCode, the tld2 from the ISO 639-1 map through
 * getAlpha2FromCode — exactly what the old engine did
 * (dd_core_api::get_page_globals → lang::resolve_multiple + fallback_lang_value
 * + get_alpha2_from_code). A static mirror is a FOURTH encoding of the project
 * language set and is wrong on every install that is not mib.
 *
 * ORDER = the CONFIGURED order (config.menu.projectsDefaultLangs), and that is a
 * DELIBERATE divergence from the frozen fixture — see the note on
 * resolveProjectsDefaultLangs below.
 *
 * Labels are NOT uniformly one language: fallback_lang_value asks each record for
 * the requested lang, then the request data lang, then any — so a record with no
 * term in the caller's language serves whatever term it has ("Nepali" in English
 * next to "Castellano" in Spanish). That is the old behaviour, kept.
 */
interface ProjectLangEntry {
	label: string;
	value: string;
	tld2: string | null;
}

/**
 * DEDALO_LANGS_SECTION_TIPO — the langs section. Declared locally, as every other
 * consumer of it does (lang_names.ts, relations/select_lang.ts, tools/import_conform.ts):
 * it is a mirror of a fixed ontology constant, not a definition owned here.
 */
const LANGS_SECTION_TIPO = 'lg1';

/**
 * REQUEST-ISOLATION: the label depends on the request DATA LANG (the fallback
 * chain consults it), so the old single-slot module cache would BLEED — the
 * first caller's language would be served to every later one (S3-21/S3-59).
 *
 * THE KEY COVERS EVERY DEPENDENCY, enumerated: an entry is
 * {label, value, tld2}; `value` is the configured code and `tld2` is the static
 * ISO 639-1 map, both request-INDEPENDENT; `label` is
 * getLangNameFromCode(code, dataLang), whose only two inputs are the code and
 * the data lang (it re-reads currentDataLang() for the same fallback, so the
 * caller's dataLang IS both of its lang dimensions). The APPLICATION lang, the
 * principal and the session never reach this value. So the data lang is the
 * whole key.
 *
 * The cache is a DATA cache, so a write to the langs section (lg1) re-resolves
 * the labels instead of serving a stale name until restart. It is a `const`
 * from the factory — invalidation-wired by construction, and therefore not an
 * entry in module_state_tripwire's allowlist.
 */
const projectsLangsCache = createDataCache<string, ProjectLangEntry[]>((cache, sectionTipo) => {
	if (sectionTipo === LANGS_SECTION_TIPO) cache.clear();
});

/**
 * Resolve the configured project languages to client entries, IN CONFIG ORDER.
 *
 * WHY NOT THE FIXTURE'S ORDER — the frozen oracle capture
 * (test/parity/fixtures/rqo_get_environment.response.json) lists these twelve
 * languages in an order that is neither the configured one nor alphabetical nor
 * matrix_langs RECORD order. It is the PHYSICAL ROW ORDER of ONE install's
 * matrix_langs table at one instant: PHP's lang::resolve_multiple issued a
 * single `WHERE string @? $1` over the hierarchy41 GIN index with NO ORDER BY,
 * so a bitmap heap scan handed back whatever the pages held — and PHP then
 * froze that answer in its page_globals FILE CACHE, so the fixture is one heap
 * on one day.
 *
 * MEASURED 2026-08-23 — the same twelve codes, the same query, three orders:
 *   fixture               nep eng deu fra vlca ara cat ell eus ita por spa
 *   this installation     ara ell vlca eng eus fra ita por spa cat deu nep
 *   its own suite clone   ell por cat eng ara deu eus fra ita nep spa vlca
 * and `ORDER BY section_id` (record order) gives a fourth. The fixture order is
 * therefore unreachable by construction: it is not a property of the payload
 * builder, it is a property of one database's heap, and it changes under
 * VACUUM FULL or a plan flip on the very same install. Reproducing it would
 * mean asserting a machine, not an engine.
 *
 * So the order served is the one the INSTALL declares —
 * DEDALO_PROJECTS_DEFAULT_LANGS verbatim. It is deterministic, operator-owned,
 * identical on every deployment, and it is already the order the rest of the
 * engine treats as authoritative (entry 0 is the main data language). The
 * `dedalo_projects_default_langs` ORDER therefore diverges from the frozen
 * fixture — and only the order: ledgered in
 * engineering/wire_contract/WC-2026-08-23-projects-default-langs-derived.md,
 * reconciled by test/parity/environment_differential.test.ts, which compares the
 * twelve entries exactly but order-insensitively.
 *
 * A configured code with no lg1 record keeps its place with the bare code as its
 * label (PHP's `$name ?? $item->code`) and is reported loudly — never silently
 * dropped from the list the language selector is built from.
 */
async function resolveProjectsDefaultLangs(dataLang: string): Promise<ProjectLangEntry[]> {
	const unresolved: string[] = [];
	const entries: ProjectLangEntry[] = [];
	for (const langCode of config.menu.projectsDefaultLangs) {
		const name = await getLangNameFromCode(langCode, dataLang);
		if (name === null) unresolved.push(langCode);
		entries.push({
			// Bare alpha-3 fallback, as PHP: an unnamed language still has to be
			// pickable in the selector, and 'nep' is a usable stand-in for a
			// missing term while a blank entry is not.
			label: name ?? langCode.replace('lg-', ''),
			value: langCode,
			tld2: getAlpha2FromCode(langCode),
		});
	}
	if (unresolved.length > 0) {
		console.error(
			`[environment] DEDALO_PROJECTS_DEFAULT_LANGS names languages with no ${LANGS_SECTION_TIPO} record: ${unresolved.join(', ')} — serving the bare code as their label.`,
		);
	}
	return entries;
}

/** The client's project-language list for THIS request's data lang (cached per lang). */
async function getProjectsDefaultLangs(): Promise<ProjectLangEntry[]> {
	const dataLang = currentDataLang();
	const cached = projectsLangsCache.get(dataLang);
	if (cached !== undefined) return cached;
	const entries = await resolveProjectsDefaultLangs(dataLang);
	projectsLangsCache.set(dataLang, entries);
	return entries;
}

/** The full environment response block (PHP get_environment → {result,msg,errors}). */
export async function buildEnvironment(
	session: Session | null,
	principal: Principal | null,
): Promise<Record<string, unknown>> {
	return {
		result: {
			page_globals: await buildPageGlobals(session, principal),
			plain_vars: buildPlainVars(session, principal),
			get_label: await getLabels(currentApplicationLang()),
		},
		msg: 'OK. Request done successfully',
		errors: [],
	};
}
