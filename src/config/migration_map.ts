/**
 * v6 → v7 CONFIG MIGRATION MAP — the single source of truth for both
 * `scripts/migrate_v6_config.ts` and the change-reference table in
 * `docs/config/whats_changed_v7.md`.
 *
 * A v6 install declares ~200 `define()` constants in `<dedalo>/config/`. The TS
 * engine reads env keys from `../private/.env`. Every legacy constant lands in
 * exactly one class:
 *
 *   SAME     the TS engine reads this exact name — copy the value across
 *   ALIAS    TS has its own name and honors the PHP one as a fallback
 *            (`PHP_KEY_ALIASES`); we emit the TS-native name, the canonical one
 *   RENAMED  the name changed and the old spelling is RETIRED — emitting it
 *            would refuse the boot (`RETIRED_ENV_KEYS`)
 *   RESHAPED name and/or VALUE SHAPE differ; a transform runs
 *   DROPPED  no TS consumer — always with a reason, printed in the report
 *
 * ALIAS and RENAMED are DERIVED from the tables in `env.ts` rather than
 * restated, so a future rename cannot fall out of step with the migration.
 * `test/unit/config_census_tripwire.test.ts` proves the rest: every legacy
 * constant is classified, and every non-DROPPED target is a key the engine
 * actually reads.
 *
 * NOTE this module imports `env.ts` but NEVER `config.ts` — building the frozen
 * config throws on a partially-configured box, which is precisely the box a
 * migration runs on.
 */

import { PHP_KEY_ALIASES, RETIRED_ENV_KEYS } from './env.ts';

export type MigrationClass = 'SAME' | 'ALIAS' | 'RENAMED' | 'RESHAPED' | 'DROPPED';

export interface MigrationRule {
	readonly cls: MigrationClass;
	/** The v7 env key to write. Absent for DROPPED. */
	readonly target?: string;
	/** Value rewrite (v6 shape → v7 shape). Identity when absent. */
	readonly transform?: (value: unknown) => unknown;
	/** DROPPED only — why, shown verbatim in the migration report. */
	readonly reason?: string;
}

// ---------------------------------------------------------------------------
// SAME — the v6 constant name IS the v7 env key (92).
// ---------------------------------------------------------------------------

const SAME_KEYS: readonly string[] = [
	// identity / locale
	'DEDALO_ENTITY_ID',
	'DEDALO_ENTITY_LABEL',
	'DEDALO_LOCALE',
	'DEDALO_TIMEZONE',
	'DEDALO_DATE_ORDER',
	'DEDALO_HOST',
	'DEDALO_PROTOCOL',
	// languages
	'DEDALO_APPLICATION_LANGS',
	'DEDALO_APPLICATION_LANGS_DEFAULT',
	'DEDALO_DATA_LANG_DEFAULT',
	'DEDALO_DATA_LANG_SELECTOR',
	'DEDALO_STRUCTURE_LANG',
	// app defaults / features
	'DEDALO_MAX_ROWS_PER_PAGE',
	'DEDALO_DEFAULT_PROJECT',
	'DEDALO_FILTER_SECTION_TIPO_DEFAULT',
	'DEDALO_LOCK_COMPONENTS',
	'DEDALO_NOTIFICATIONS',
	'DEDALO_AR_EXCLUDE_COMPONENTS',
	'DEDALO_GEO_PROVIDER',
	// media — image
	'DEDALO_IMAGE_FOLDER',
	'DEDALO_IMAGE_EXTENSION',
	'DEDALO_IMAGE_EXTENSIONS_SUPPORTED',
	'DEDALO_IMAGE_ALTERNATIVE_EXTENSIONS',
	'DEDALO_IMAGE_AR_QUALITY',
	'DEDALO_IMAGE_QUALITY_DEFAULT',
	'DEDALO_IMAGE_QUALITY_ORIGINAL',
	'DEDALO_IMAGE_QUALITY_RETOUCHED',
	'DEDALO_IMAGE_PRINT_DPI',
	'DEDALO_IMAGE_THUMB_WIDTH',
	'DEDALO_IMAGE_THUMB_HEIGHT',
	// media — av
	'DEDALO_AV_FOLDER',
	'DEDALO_AV_EXTENSION',
	'DEDALO_AV_EXTENSIONS_SUPPORTED',
	'DEDALO_AV_AR_QUALITY',
	'DEDALO_AV_QUALITY_DEFAULT',
	'DEDALO_AV_QUALITY_ORIGINAL',
	'DEDALO_AV_POSTERFRAME_EXTENSION',
	'DEDALO_AV_SUBTITLES_EXTENSION',
	'DEDALO_SUBTITLES_FOLDER',
	'DEDALO_AV_FFMPEG_PATH',
	'DEDALO_AV_FFPROBE_PATH',
	'DEDALO_AV_FASTSTART_PATH',
	// media — pdf / svg / 3d / thumb
	'DEDALO_PDF_FOLDER',
	'DEDALO_PDF_EXTENSION',
	'DEDALO_PDF_EXTENSIONS_SUPPORTED',
	'DEDALO_PDF_ALTERNATIVE_EXTENSIONS',
	'DEDALO_PDF_AR_QUALITY',
	'DEDALO_PDF_QUALITY_DEFAULT',
	'DEDALO_PDF_QUALITY_ORIGINAL',
	'PDF_AUTOMATIC_TRANSCRIPTION_ENGINE',
	'PDF_OCR_ENGINE',
	'DEDALO_SVG_FOLDER',
	'DEDALO_SVG_EXTENSION',
	'DEDALO_SVG_EXTENSIONS_SUPPORTED',
	'DEDALO_SVG_AR_QUALITY',
	'DEDALO_SVG_QUALITY_DEFAULT',
	'DEDALO_SVG_QUALITY_ORIGINAL',
	'DEDALO_3D_FOLDER',
	'DEDALO_3D_EXTENSION',
	'DEDALO_3D_EXTENSIONS_SUPPORTED',
	'DEDALO_3D_AR_QUALITY',
	'DEDALO_3D_QUALITY_DEFAULT',
	'DEDALO_3D_QUALITY_ORIGINAL',
	'DEDALO_QUALITY_THUMB',
	'DEDALO_THUMB_EXTENSION',
	// The three media-tree folder names v6 kept configurable. They were DROPPED
	// while the TS media tree hardcoded them (2026-08-09), which made the tree of
	// a migrated install silently differ from the one its files are actually in —
	// and, for the export path, removed a capability outright (v6 allowed an
	// ABSOLUTE path on another volume; a hardcoded '<media>/export/files' cannot
	// express one). The tree reads all three from the catalog now, so they carry
	// across unchanged.
	'DEDALO_IMAGE_WEB_FOLDER',
	'DEDALO_HTML_FILES_FOLDER',
	'DEDALO_TOOL_EXPORT_FOLDER_PATH',
	// media — access + upload
	'DEDALO_PROTECT_MEDIA_FILES',
	// Rule-B public quality folders + the raw .htaccess addon lines. Same names as the
	// PHP install's (core/media_protection); read by core/media/protection.ts.
	'DEDALO_MEDIA_PUBLIC_QUALITIES',
	'MEDIA_HTACCESS_ADDONS',
	'DEDALO_UPLOAD_SERVICE_CHUNK_FILES',
	'DEDALO_UPLOAD_SERVICE_MAX_CONCURRENT',
	// ops / backup
	'DEDALO_BACKUP_PATH',
	'DEDALO_BACKUP_TIME_RANGE',
	'UPDATE_LOG_FILE',
	// ontology io + code update
	'ONTOLOGY_SERVERS',
	'ONTOLOGY_SERVER_CODE',
	'IS_AN_ONTOLOGY_SERVER',
	'ONTOLOGY_DATA_IO_DIR',
	'STRUCTURE_FROM_SERVER',
	'CODE_SERVERS',
	'IS_A_CODE_SERVER',
	'DEDALO_CODE_FILES_DIR',
	'DEDALO_CODE_SERVER_GIT_DIR',
	'DEDALO_CODE_SERVER_DEV_CHANNEL',
	'DEDALO_CODE_SERVER_PRERELEASE_CHANNEL',
	'DEDALO_SOURCE_VERSION_LOCAL_DIR',
	// How many code restore points survive retention. NEW_IN_V7 by construction:
	// v6's updater overwrote the tree in place and kept nothing to roll back to,
	// so there is no v6 constant to classify — the whole notion of a restore point
	// arrives with the TS updater (src/core/update/restore_points.ts).
	'DEDALO_CODE_RESTORE_POINTS_KEEP',
	// diffusion
	'DEDALO_DIFFUSION_DOMAIN',
	// Same name, same shape — but v7 DERIVES it from the project languages when it
	// is unset (`config.diffusion`), and a stock v6 config defines it as literally
	// `DEDALO_PROJECTS_DEFAULT_LANGS`. Classified here so the census stays complete;
	// `scripts/migrate_v6_config.ts` then OMITS it when the v6 value equals the
	// project languages, because writing it would freeze the derivation into a
	// migration-day snapshot. A genuinely different set (or order) is migrated.
	'DEDALO_DIFFUSION_LANGS',
	'DEDALO_DIFFUSION_RESOLVE_LEVELS',
	// The publication server API v1 (PHP, `publication/server_api/v1`) still ships
	// for existing websites; the maintenance panel needs its db_name/code pairs to
	// open the v1 Swagger docu.
	'API_WEB_USER_CODE_MULTIPLE',
];

// ---------------------------------------------------------------------------
// RESHAPED — name and/or value shape change.
// ---------------------------------------------------------------------------

/** v6 ships binary DIRECTORIES with a trailing slash; v7 wants the executable's full path. */
const asBinary =
	(exe: string) =>
	(value: unknown): unknown => {
		const raw = String(value ?? '').trim();
		if (raw === '') return raw;
		return raw.endsWith('/') ? `${raw}${exe}` : raw;
	};

/** v6 ships a directory with a trailing slash; v7 wants it bare. */
const asDir = (value: unknown): unknown => String(value ?? '').replace(/\/+$/, '');

/**
 * A stock v6 config.php ships API_WEB_USER_CODE_MULTIPLE as ONE placeholder entry
 * (`db_name`/`code` = '', `api_ui` = null). Copied verbatim, v7's reader
 * (`readPublicationApiUsers`) drops it and logs "1 of 1 entries were DROPPED" on
 * every boot. So placeholder entries (no non-empty string `db_name`) are not
 * migrated, and when none remain the key is SKIPPED (null) — unset = no v1 users,
 * the same thing the reader would conclude. Real entries pass through unchanged.
 */
const asPublicationApiUsers = (value: unknown): unknown => {
	if (!Array.isArray(value)) return value;
	const real = value.filter((entry) => {
		const dbName = (entry as { db_name?: unknown } | null)?.db_name;
		return typeof dbName === 'string' && dbName.trim() !== '';
	});
	return real.length === 0 ? null : real;
};

/**
 * NOT a rename of SERVER_PROXY → TRUSTED_PROXY_HOPS. They point in opposite
 * directions: v6's SERVER_PROXY was an OUTBOUND egress proxy (host:port) handed to
 * curl when Dédalo FETCHES from an ontology/code master; v7's TRUSTED_PROXY_HOPS is
 * INBOUND — how many reverse-proxy hops sit in front of us, so the right
 * X-Forwarded-For entry is taken as the client IP. Converting one to the other would
 * be a security bug, not a migration.
 */
const RESHAPED: Readonly<Record<string, MigrationRule>> = {
	// The MariaDB (diffusion) connection moved to its own DEDALO_DIFFUSION_DB_* family:
	// in v7 the Bun engine — not PHP — owns MariaDB.
	MYSQL_DEDALO_HOSTNAME_CONN: { cls: 'RESHAPED', target: 'DEDALO_DIFFUSION_DB_HOST' },
	MYSQL_DEDALO_DB_PORT_CONN: { cls: 'RESHAPED', target: 'DEDALO_DIFFUSION_DB_PORT' },
	MYSQL_DEDALO_SOCKET_CONN: { cls: 'RESHAPED', target: 'DEDALO_DIFFUSION_DB_SOCKET' },
	MYSQL_DEDALO_USERNAME_CONN: { cls: 'RESHAPED', target: 'DEDALO_DIFFUSION_DB_USER' },
	MYSQL_DEDALO_PASSWORD_CONN: { cls: 'RESHAPED', target: 'DEDALO_DIFFUSION_DB_PASSWORD' },

	// Binary paths: v6 = a directory ('/usr/bin/'), v7 = the executable itself.
	MAGICK_PATH: { cls: 'RESHAPED', target: 'DEDALO_MAGICK_PATH', transform: asBinary('magick') },
	DB_BIN_PATH: { cls: 'RESHAPED', target: 'DEDALO_PG_BIN_PATH', transform: asDir },
};

// ---------------------------------------------------------------------------
// DROPPED — no TS consumer. Every entry carries the reason the report prints.
// ---------------------------------------------------------------------------

const DERIVED_PATH = 'derived: the v7 engine computes this path/URL itself';
const PHP_ONLY = 'PHP-only: the TS engine has no such subsystem';
const TS_STATE = 'runtime state: lives in ../private/ts_state.json, not .env';
const NO_CONSUMER = 'no TS consumer (see the "NOT HONORED" block of sample.env)';

const dropped = (names: readonly string[], reason: string): Record<string, MigrationRule> =>
	Object.fromEntries(names.map((n) => [n, { cls: 'DROPPED' as const, reason }]));

const DROPPED: Readonly<Record<string, MigrationRule>> = {
	// Paths and URLs the engine derives from its own location / the request.
	...dropped(
		[
			'DEDALO_ROOT_PATH',
			'DEDALO_ROOT_WEB',
			'DEDALO_CONFIG',
			'DEDALO_CONFIG_PATH',
			'DEDALO_CORE',
			'DEDALO_CORE_PATH',
			'DEDALO_CORE_URL',
			'DEDALO_SHARED',
			'DEDALO_SHARED_PATH',
			'DEDALO_SHARED_URL',
			'DEDALO_TOOLS',
			'DEDALO_TOOLS_PATH',
			'DEDALO_TOOLS_URL',
			'DEDALO_LIB',
			'DEDALO_LIB_PATH',
			'DEDALO_LIB_URL',
			'DEDALO_WIDGETS_PATH',
			'DEDALO_WIDGETS_URL',
			'DEDALO_EXTRAS_PATH',
			'DEDALO_EXTRAS_URL',
			'DEDALO_INSTALL_PATH',
			'DEDALO_INSTALL_URL',
			'DEDALO_API_URL',
			'DEDALO_MEDIA_URL',
			'DEDALO_IMAGE_FILE_URL',
			'DEDALO_CODE_FILES_URL',
			'DEDALO_TOOL_EXPORT_FOLDER_URL',
			'DEDALO_TOOL_IMPORT_DEDALO_CSV_FOLDER_PATH',
			'DEDALO_UPLOAD_TMP_DIR',
			'DEDALO_UPLOAD_TMP_URL',
			'ONTOLOGY_DATA_IO_URL',
			'ONTOLOGY_DOWNLOAD_DIR',
			// The hierarchy export destination is no longer an operator choice: the
			// only useful target is the directory the IMPORT half already reads, so
			// the widget derives it from the repo root (HIERARCHY_IMPORT_DIR) —
			// src/core/area_maintenance/widgets/export_hierarchy.ts.
			'EXPORT_HIERARCHY_PATH',
			'DEDALO_BACKUP_PATH_DB',
			'DEDALO_BACKUP_PATH_ONTOLOGY',
			'DEDALO_BACKUP_PATH_TEMP',
			'DEDALO_BACKUP_PATH_STRUCTURE',
			'DEDALO_BACKUP_PATH_USERS',
			'COLOR_PROFILES_PATH',
			'DEDALO_SOURCE_VERSION_URL',
			'STRUCTURE_DOWNLOAD_JSON_FILE',
			'CONFIG_DEFAULT_FILE_PATH',
			// present in real installs (not in the shipped sample)
			'DEDALO_DIFFUSION_PATH',
			'DEDALO_DIFFUSION_URL',
			'DEDALO_DIFFUSION_API_URL',
		],
		DERIVED_PATH,
	),

	// Subsystems that simply do not exist in the TS engine.
	...dropped(
		[
			'DEDALO_SESSION_HANDLER',
			'DEDALO_SESSIONS_PATH',
			'DEDALO_SESSION_SAVE_PATH',
			'DEDALO_CACHE_MANAGER',
			'LOGGER_LEVEL',
			'ENCRYPTION_MODE',
			'PHP_BIN_PATH',
			'MYSQL_DB_BIN_PATH',
			'DEDALO_DB_TYPE',
			'DEDALO_DB_MANAGEMENT',
			'DEDALO_NODEJS',
			'DEDALO_NODEJS_PM2',
			'DEDALO_TRANSLATOR_URL',
			'DEDALO_PERMISSIONS_ROOT',
			'DEDALO_STRUCTURE_CSS',
			'DEDALO_ADITIONAL_CSS',
			'DEDALO_MCP_PROXY_URL',
			'DEDALO_API_URL_UNIT_TEST',
			'GEONAMES_ACCOUNT_USERNAME',
			'DEDALO_RECOVERY_KEY',
			'DEDALO_BACKUP_ON_LOGIN',
			'DEDALO_PROFILE_DEFAULT',
			'USE_CDN',
			'JQUERY_LIB_URL_JS',
			'JQUERY_UI_URL_JS',
			'JQUERY_UI_URL_CSS',
			'JQUERY_TABLESORTER_JS',
			'TEXT_EDITOR_URL_JS',
			'PAPER_JS_URL',
			'LEAFLET_JS_URL',
			'D3_URL_JS',
			'NVD3_URL_JS',
			'NVD3_URL_CSS',
			'BOOTSTRAP_CSS_URL',
			'BOOTSTRAP_JS_URL',
			'TEXT_SUBTITLES_ENGINE',
			'DEDALO_IMAGE_LIB',
			'MAGICK_CONFIG',
			'DEDALO_PDF_RENDERER',
			'DEDALO_AV_FFMPEG_SETTINGS',
			'DEDALO_AV_RECOMPRESS_ALL',
			'DEDALO_AV_WATERMARK_FILE',
			'DEDALO_AV_STREAMER',
			'DEDALO_3D_GLTFPACK_PATH',
			'DEDALO_3D_FBX2GLTF_PATH',
			'DEDALO_3D_COLLADA2GLTF_PATH',
			'DEDALO_HTML_FILES_EXTENSION',
			'DEDALO_IMAGE_BEST_EXTENSIONS',
			'DEDALO_AV_BEST_EXTENSIONS',
		],
		PHP_ONLY,
	),

	// Media type/mime constants: v7 derives the MIME from the extension.
	...dropped(
		[
			'DEDALO_IMAGE_MIME_TYPE',
			'DEDALO_IMAGE_TYPE',
			'DEDALO_AV_MIME_TYPE',
			'DEDALO_AV_TYPE',
			'DEDALO_PDF_MIME_TYPE',
			'DEDALO_PDF_TYPE',
			'DEDALO_SVG_MIME_TYPE',
			'DEDALO_3D_MIME_TYPE',
		],
		'derived: v7 resolves the media type from the file extension',
	),

	// Superseded by the native offline GeoIP subsystem (src/core/geoip): IP→country
	// for section Activity dd542 now resolves server-side against the DB-IP Country
	// Lite database (DEDALO_GEOIP_*), not a per-visitor third-party API descriptor.
	...dropped(
		['IP_API'],
		'superseded: IP→country resolves server-side via the native GeoIP subsystem (src/core/geoip), not a client-side API descriptor',
	),

	// Machine-written runtime state — never config.
	...dropped(
		[
			'DEDALO_INSTALL_STATUS',
			'DEDALO_MAINTENANCE_MODE',
			'DEDALO_NOTIFICATION',
			'DEDALO_TEST_INSTALL',
			// The KEY is gone, the FEATURE is live: recovery mode is a
			// ServerState field (core/resolve/server_state.ts), flipped by the
			// check_config widget's set_recovery_mode and emitted to the client
			// by resolve/environment.ts. Never read "dropped" as "unported".
			'DEDALO_RECOVERY_MODE',
			// the *_CUSTOM twins a real install's config_core.php carries
			'DEDALO_MAINTENANCE_MODE_CUSTOM',
			'DEDALO_NOTIFICATION_CUSTOM',
		],
		TS_STATE,
	),

	// Never really CONFIG in v6: derived per REQUEST from the logged user —
	// SHOW_DEBUG = "is the superuser", SHOW_DEVELOPER = the user's is_developer flag
	// in the database. v7 derives them the SAME way (src/core/resolve/environment.ts,
	// buildPlainVars), so there is nothing to carry across; the client flags of the
	// same name still exist and are read in ~470 client files. Do NOT call these
	// "PHP-only": the capability is live. DEDALO_DEV_MODE does NOT drive them — it
	// is the SERVER posture (DEVELOPMENT_SERVER, no-cache path, readable libs).
	SHOW_DEBUG: {
		cls: 'DROPPED',
		reason:
			'per-user in v6 (superuser only); in v7 the client SHOW_DEBUG flag is derived the same way (superuser), NOT from config',
	},
	SHOW_DEVELOPER: {
		cls: 'DROPPED',
		reason:
			'per-user in v6 (the is_developer DB flag); in v7 the client SHOW_DEVELOPER flag is derived the same way (is_developer), NOT from config',
	},
	DEVELOPMENT_SERVER: {
		cls: 'DROPPED',
		reason: 'in v7 the client DEVELOPMENT_SERVER flag is derived from DEDALO_DEV_MODE',
	},

	// v6 did not HASH passwords — it reversibly AES-encrypted them, keyed by
	// md5(md5(DEDALO_INFORMATION)) with the IV seeded from DEDALO_INFO_KEY
	// (component_password::encrypt_password → dedalo_encrypt_openssl). v7 stores
	// Argon2id hashes (Bun.password), whose per-password salt is embedded in the hash
	// string, so neither key has any meaning here. Carrying them over would only
	// preserve the ability to DECRYPT old passwords — exactly what we do not want.
	// The lockout consequence is warned about by the CLI (LEGACY PASSWORD HASHES).
	DEDALO_INFORMATION: {
		cls: 'DROPPED',
		reason:
			'v6 password-encryption key: v7 stores Argon2id hashes (per-password salt embedded) and never decrypts — see the legacy-password warning',
	},
	DEDALO_INFO_KEY: {
		cls: 'DROPPED',
		reason:
			'v6 password-encryption IV seed: not used by Argon2id — see the legacy-password warning',
	},
	// v6 used the salt ONLY to seed a session token (login::Login salt_secure), never
	// for passwords. v7 has its own session store.
	DEDALO_SALT_STRING: {
		cls: 'DROPPED',
		reason: 'v6 session-token seed (never a password salt); v7 manages its own session secrets',
	},

	// The OUTBOUND egress proxy v6 handed to curl for its ontology/code-master fetches.
	// v7 still makes those fetches — it just has no Dédalo-level key for the proxy,
	// because Bun's fetch honors the STANDARD proxy env vars. (NOT the same thing as
	// TRUSTED_PROXY_HOPS, which is about proxies in front of us — see RESHAPED above.)
	SERVER_PROXY: {
		cls: 'DROPPED',
		reason:
			'no Dédalo key in v7: set the standard HTTPS_PROXY / HTTP_PROXY in the server environment instead (Bun fetch honors them)',
	},

	// v7 takes the diffusion TARGET database per publication (the SectionPlan carries
	// it, and a database-less session is a loud error — diffusion/targets/mariadb/db.ts),
	// so there is no single configured database name. NOTE: config_persist.ts:126 still
	// WRITES DEDALO_DIFFUSION_DB_NAME, but nothing reads it — a dead key, not a target.
	MYSQL_DEDALO_DATABASE_CONN: {
		cls: 'DROPPED',
		reason: 'v7 resolves the diffusion target database per publication, not from config',
	},

	// The v6 on/off switch of component_filter_records' row-level ACL. v7 has no
	// switch: the SAVED allow-list is the intent, and the search assembler honors
	// it whenever the datum names the searched section (a datum-less user gets a
	// byte-identical query) — WC-2026-08-12-filter-records-enforced. So the KEY is
	// gone while the FEATURE is live, which is the opposite of the plain
	// no-consumer case below.
	DEDALO_FILTER_USER_RECORDS_BY_ID: {
		cls: 'DROPPED',
		reason:
			'no v7 key: the row-level record ACL (component_filter_records) is enforced whenever a user has an allow-list, not behind a flag',
	},

	// The per-family thumb-quality names, superseded INSIDE v6 by the single
	// generic DEDALO_QUALITY_THUMB — core/base/update/unsoported_updates.php:693
	// announces it ("DEDALO_IMAGE_THUMB_DEFAULT is changed by generic
	// DEDALO_QUALITY_THUMB"). No v6 PHP file reads any of the three; the image and
	// pdf spellings were also removed from v6's shipped sample.config.php, which is
	// why they are absent from the vendored fixture and only reach the migration
	// from an older, hand-maintained config.php. Nothing is lost:
	// DEDALO_QUALITY_THUMB is SAME, and both engines fall back to 'thumb' unset.
	// (The 3d spelling sat in the mime/type group above until 2026-08-22 — it never
	// named a media type, so the reason printed for it was simply wrong.)
	...dropped(
		['DEDALO_IMAGE_THUMB_DEFAULT', 'DEDALO_PDF_THUMB_DEFAULT', 'DEDALO_3D_THUMB_DEFAULT'],
		'superseded inside v6 by the generic DEDALO_QUALITY_THUMB (a SAME key); no v6 or v7 code reads the per-family name',
	),

	// Read by nothing in the TS engine today.
	...dropped(
		[
			'DEDALO_SECTION_ID_TEMP',
			'NUMERICAL_MATRIX_VALUE_YES',
			'NUMERICAL_MATRIX_VALUE_NO',
			'DEDALO_ENTITY_MEDIA_AREA_TIPO',
			'DEDALO_PUBLICATION_CLEAN_URL',
			'DEDALO_PUBLICATION_ALERT',
			'DIFFUSION_CUSTOM',
			'EXCLUDE_DIFFUSION_ELEMENTS',
			'DEDALO_DIFFUSION_SERVICE_CMD',
			'DEDALO_DIFFUSION_SOCKET_PATH',
			'DEDALO_DIFFUSION_INTERNAL_TOKEN',
			'STRUCTURE_SERVER_URL',
			'STRUCTURE_SERVER_CODE',
			// The extra accepted secrets of the same PHP endpoint (core/extras/
			// str_manager accepted STRUCTURE_SERVER_CODE plus this optional array,
			// for multi-tenant / migration setups). No endpoint, no secrets.
			'STRUCTURE_SERVER_CODE_OTHERS',
		],
		NO_CONSUMER,
	),

	// The v6 "this install is the structure master" flag. It never configured a
	// subsystem: PHP read it in ONE place, to show an export button on the
	// ontology dd_list. v7's ontology-master ROLE is a real key — see
	// IS_AN_ONTOLOGY_SERVER — so the capability is not lost, only renamed and
	// given actual behaviour.
	STRUCTURE_IS_MASTER: {
		cls: 'DROPPED',
		reason:
			'v6 flag that only toggled an export button in the PHP ontology list; the v7 ontology-master role is IS_AN_ONTOLOGY_SERVER',
	},

	// PREVIOUS-MAJOR code-server pointers. A v6 code master could serve BOTH its
	// own major and the one before it, so the config carried two parallel sets:
	// DEDALO_CODE_* (this major) and DEDALO_6_CODE_* (the previous one). These are
	// SEPARATE constants, NOT old spellings of the live DEDALO_CODE_FILES_DIR /
	// DEDALO_CODE_SERVER_GIT_DIR — do not move them into RETIRED_ENV_KEYS, which
	// would refuse the boot of an install that legitimately still sets both. v7
	// serves one major, so the second set has nothing to point at.
	...dropped(
		[
			'DEDALO_6_CODE_SERVER_GIT_DIR',
			'DEDALO_6_CODE_FILES_DIR',
			// Named in the retirement list; no PHP tree ever defined them. Declared
			// anyway so the question is answered here instead of re-researched.
			'DEDALO_6_SOURCE_VERSION_URL',
			'DEDALO_6_SOURCE_VERSION_LOCAL_DIR',
		],
		'previous-major code-server pointer: v7 serves ONE major (the live keys are DEDALO_CODE_FILES_DIR / DEDALO_CODE_SERVER_GIT_DIR; DEDALO_SOURCE_VERSION_LOCAL_DIR is declared but not honoured)',
	),

	// PHP's pg_pconnect switch. v7 never opens a connection per request: Bun.sql
	// holds ONE pool for the process, so "persistent" is not a mode to choose —
	// it is the only mode there is. The tunable that replaced it is the pool size.
	PERSISTENT_CONNECTION: {
		cls: 'DROPPED',
		reason:
			'PHP pg_pconnect switch: the TS engine always holds a pooled Bun.sql connection set — size it with DB_POOL_MAX / DB_POOL_ACQUIRE_TIMEOUT_MS',
	},
};

// ---------------------------------------------------------------------------
// The assembled map
// ---------------------------------------------------------------------------

function build(): Readonly<Record<string, MigrationRule>> {
	const map: Record<string, MigrationRule> = {};

	for (const name of SAME_KEYS) map[name] = { cls: 'SAME', target: name };
	// Same name, same shape — only the stock placeholder entry is filtered out.
	map.API_WEB_USER_CODE_MULTIPLE = {
		cls: 'SAME',
		target: 'API_WEB_USER_CODE_MULTIPLE',
		transform: asPublicationApiUsers,
	};

	// ALIAS — derived from env.ts (TS-native key → PHP spelling). We invert it and
	// emit the TS-native name: both work, but the native one is canonical.
	for (const [tsKey, phpKey] of Object.entries(PHP_KEY_ALIASES)) {
		map[phpKey] = { cls: 'ALIAS', target: tsKey };
	}

	// RENAMED — derived from env.ts. Emitting the old spelling would REFUSE the boot.
	for (const [retired, replacement] of Object.entries(RETIRED_ENV_KEYS)) {
		map[retired] = { cls: 'RENAMED', target: replacement };
	}

	Object.assign(map, RESHAPED, DROPPED);
	return Object.freeze(map);
}

export const V6_MIGRATION: Readonly<Record<string, MigrationRule>> = build();

/**
 * Env keys the v7 engine reads that have NO v6 origin — nothing to migrate, but
 * they must be declared so the census is complete: together with the non-DROPPED
 * targets of V6_MIGRATION these are exactly the keys the engine reads, and
 * `config_census_tripwire` proves it against a scan of `src/`. A new key added to
 * the engine without a line here fails that gate — which is the point: it is also
 * the moment to document it.
 */
export const NEW_IN_V7: readonly string[] = [
	// server / runtime
	'SERVER_UNIX_SOCKET',
	'SERVER_TCP_PORT',
	'SERVER_TCP_HOST',
	'SERVER_TCP_TLS_CERT_FILE',
	'SERVER_TCP_TLS_KEY_FILE',
	'SERVER_MAX_BODY_BYTES',
	'SERVER_IDLE_TIMEOUT_S',
	'SERVER_SHUTDOWN_GRACE_MS',
	'TRUSTED_PROXY_HOPS',
	'TRUSTED_PROXY_TRANSPORT',
	'DEDALO_DEV_MODE',
	'DEDALO_DEBUG_API_ERRORS',
	'DEDALO_ACCESS_LOG',
	'DEDALO_SLOW_REQUEST_MS',
	'DEDALO_SUPERVISED',
	// set by the code updater on its own pre-swap smoke-boot child, never by an operator
	'DEDALO_SMOKE_BOOT',
	// declared by the container stacks, never by an operator (installer unification D2)
	'DEDALO_CLIENT_PUBLISH_DIR',
	'DEDALO_CONTAINER_IMAGE',
	'DEDALO_CONTAINER_IMAGE_MODE',
	// postgres pool
	'DB_POOL_MAX',
	'DB_POOL_ACQUIRE_TIMEOUT_MS',
	'DB_STATEMENT_TIMEOUT_MS',
	// the maintenance pool (PERF-11): the separate connections withUnboundedStatements routes to
	'DB_MAINTENANCE_POOL_MAX',
	// Postgres TLS mode. NEW_IN_V7 and, more precisely, new in Bun 1.4: that
	// release taught Bun.sql to fall back to the ambient PGSSLMODE/PG_SSLMODE
	// when no `tls` option is given, so the engine now passes this value
	// EXPLICITLY and the ambient variables can never decide it. v6 had no
	// counterpart — PHP's pg_connect string never carried sslmode here.
	'DB_SSLMODE',
	// query performance
	'SEARCH_LATE_ROW_LOOKUP_OFFSET',
	'TM_COUNT_CACHE_TTL_MS',
	// CORS. NEW_IN_V7 rather than a RESHAPED rule off the v7-PHP `DEDALO_CORS`
	// array: that constant is not in the v6 census this map is keyed on, and the
	// shape is narrower on purpose — only the origin list is an operator's to
	// set (core/security/cors.ts explains why methods/headers are constants).
	'DEDALO_CORS_ALLOWED_ORIGINS',
	// The outbound SSRF guard's declared NAT64 network-specific prefixes (RFC 6052).
	// No v6 counterpart: v6's is_safe_remote_url had no IPv6-translation awareness.
	'DEDALO_NAT64_PREFIXES',
	// sessions / login / permissions (the TS-native auth stack)
	'SESSION_TTL_SECONDS',
	'SESSION_ABSOLUTE_TTL_SECONDS',
	'SESSION_WARNING_SECONDS',
	'SESSION_COOKIE_SECURE',
	'DEDALO_SESSION_DB_PATH',
	'DEDALO_SESSION_CACHE_EXPIRE',
	'DEDALO_SINGLE_SESSION',
	'LOGIN_MAX_ATTEMPTS',
	'LOGIN_ATTEMPT_WINDOW',
	'LOGIN_LOCKOUT_SECONDS',
	'LOGIN_ACCOUNT_MAX_ATTEMPTS',
	'LOGIN_SOURCE_MAX_ATTEMPTS',
	'PERMISSIONS_CACHE_TTL_SECONDS',
	// mailer + password recovery (no v6 mailer existed)
	'DEDALO_SMTP_HOST',
	'DEDALO_SMTP_PORT',
	'DEDALO_SMTP_SECURE',
	'DEDALO_SMTP_USER',
	'DEDALO_SMTP_PASS',
	'DEDALO_SMTP_FROM',
	'DEDALO_SMTP_FROM_NAME',
	'DEDALO_PWRESET_CODE_TTL',
	'DEDALO_PWRESET_MAX_ATTEMPTS',
	// menu / areas / defaults
	'AREAS_DENY',
	// geolocation opening camera. NEW_IN_V7, no v6 rule: v6 had no default view —
	// the client fabricated a hardcoded coordinate (Valencia) that the server then
	// treated as a "no location" sentinel. The camera is now config, view-only.
	'DEDALO_GEO_DEFAULT_LAT',
	'DEDALO_GEO_DEFAULT_LON',
	'DEDALO_GEO_DEFAULT_ZOOM',
	// 'APPLICATION_LANGS' was DELETED here (2026-07-13). It was never a real key: nothing
	// set it, the installer never wrote it, and it appeared in no .env. Three call sites read
	// it and CSV-split it — which, since the actual UI-language key (DEDALO_APPLICATION_LANGS)
	// is a JSON map, always produced garbage and fell through to a hardcoded
	// 'lg-spa,lg-cat,lg-eng' literal. Same defect as the rsc92 picker bug (see
	// core/resolve/component_data.ts). They now read config.menu.projectsDefaultLangs.
	'DEDALO_SECTION_USERS_TIPO',
	'DEDALO_SEARCH_CLIENT_MAX_LIMIT',
	// DEDALO_OBSERVER_CASCADE was DELETED here (2026-08-02, same day it landed):
	// the D1/D2 rollout flag gated whether declared observer edges fire, i.e.
	// what STORED relation data two identical installs end up with — data
	// divergence by deploy setting. The benchmark cleared the cascade and it is
	// now unconditional (WC-2026-08-02-observer-cascade-bounded-flag).
	// media (v7-native knobs)
	'DEDALO_MEDIA_DIR',
	'DEDALO_MEDIA_EXPORT_BASE',
	'DEDALO_MEDIA_WEB_BASE',
	'DEDALO_MEDIA_ACCESS_MODE',
	'DEDALO_BINARY_BASE',
	'DEDALO_IDENTIFY_PATH',
	'DEDALO_PDFTOHTML_PATH',
	'DEDALO_PDFINFO_PATH',
	'DEDALO_FILE_BIN_PATH',
	// The SVG rasterizer. NEW_IN_V7 with no v6 counterpart BY CONSTRUCTION: v6 built
	// its svg thumb with ImageMagick, which v7 cannot do — the hardened policy
	// disables the MVG coder ImageMagick's SVG renderer emits, so the renderer is a
	// separate program (src/core/media/engine/svg.ts) and therefore a new key.
	'DEDALO_RSVG_CONVERT_PATH',
	// The PDF rasterizer. NEW_IN_V7 by construction: v6 rasterized a PDF cover
	// through ImageMagick, which spawned Ghostscript as an unbounded, unkillable
	// DELEGATE. v7 spawns gs itself (src/core/media/engine/ghostscript.ts) and the
	// hardened policy denies the delegate, so there is no v6 constant for this.
	'DEDALO_GS_PATH',
	'DEDALO_SVG_THUMB_DPI',
	// The ImageMagick resource bound (audit MEDIA-01). NEW_IN_V7 by construction:
	// v6 passed no `-limit` and shipped no policy at all, so there is no v6
	// constant these could be a rename of.
	'DEDALO_MAGICK_LIMIT_MEMORY',
	'DEDALO_MAGICK_LIMIT_MAP',
	'DEDALO_MAGICK_LIMIT_AREA',
	'DEDALO_MAGICK_LIMIT_DISK',
	'DEDALO_MAGICK_LIMIT_WIDTH',
	'DEDALO_MAGICK_LIMIT_HEIGHT',
	'DEDALO_MAGICK_LIMIT_TIME',
	'DEDALO_MAGICK_LIMIT_LIST_LENGTH',
	// Converter admission (audit MEDIA-01, the plural half). NEW_IN_V7 by
	// construction: v6 ran every conversion inline with no cap on how many, so
	// there is no v6 constant these could be a rename of.
	'DEDALO_MEDIA_CONVERT_CONCURRENCY',
	'DEDALO_MEDIA_CONVERT_QUEUE_SECONDS',
	'DEDALO_MEDIA_AV_CONCURRENCY',
	'DEDALO_MEDIA_AV_QUEUE_SECONDS',
	'DEDALO_MEDIA_JOB_CONCURRENCY',
	// THE OTHER LANE BUDGETS AND THE LANE DEADLINES (PERF-11). NEW_IN_V7 by
	// construction: v6 had one media-job cap and no notion of a work class or of a
	// per-job deadline at all, so there is no v6 constant any of these could be a
	// rename of. DEDALO_MEDIA_JOB_CONCURRENCY above IS the media lane's budget and
	// is neither renamed nor retired.
	'DEDALO_JOB_LANE_TRANSCRIPTION_CONCURRENCY',
	'DEDALO_JOB_LANE_RAG_CONCURRENCY',
	'DEDALO_JOB_LANE_MAINTENANCE_CONCURRENCY',
	'DEDALO_JOB_DEADLINE_MEDIA_S',
	'DEDALO_JOB_DEADLINE_TRANSCRIPTION_S',
	'DEDALO_JOB_DEADLINE_RAG_S',
	'DEDALO_JOB_DEADLINE_MAINTENANCE_S',
	// THE EXPORT LANE + tool_export's server-built files (2026-09 export-at-scale).
	// NEW_IN_V7 by construction: v6 built every export file in the browser and ran
	// no export job at all, so there is no v6 constant any of these could be a
	// rename of.
	'DEDALO_JOB_LANE_EXPORT_CONCURRENCY',
	'DEDALO_JOB_DEADLINE_EXPORT_S',
	'DEDALO_JOB_LANE_EXPORT_FILE_CONCURRENCY',
	'DEDALO_JOB_DEADLINE_EXPORT_FILE_S',
	'DEDALO_EXPORT_ARTIFACTS_DIR',
	'DEDALO_EXPORT_ARTIFACTS_TTL_HOURS',
	'DEDALO_EXPORT_ARTIFACTS_QUOTA_BYTES',
	'DEDALO_EXPORT_ARTIFACTS_MAX_EXPORTS',
	'DEDALO_EXPORT_ARTIFACTS_MIN_FREE_BYTES',
	'DEDALO_EXPORT_PREVIEW_PAGE_SIZE',
	'DEDALO_EXPORT_JOBS_PER_USER',
	'DEDALO_MEDIA_PROCESSES_DIR',
	// The test-media seam: repoints the media root AND arms the marker guard
	// (src/core/media/test_media_root.ts). NEW_IN_V7 by construction — v6 had no
	// dedicated test tier and no such guard.
	'DEDALO_TEST_MEDIA_ROOT',
	// The test-database seams: the suite database's name (which the preload pins
	// and which ARMS the test-process pool guard, src/config/suite_database.ts)
	// and the explicit run-against-my-own-database opt-out. NEW_IN_V7 by
	// construction — v6 had no dedicated test database and no such guard.
	'DEDALO_TEST_DATABASE',
	'DEDALO_TEST_DB_DISABLE',
	'MEDIA_DEV_ROUTE_ENABLED',
	// The wall-clock budget of the per-BOOT media-tree pass. NEW_IN_V7 by
	// construction: v6 re-ran the equivalent walk on every REQUEST and had no
	// bound at all, so there is no v6 constant this could be a rename of.
	'MEDIA_TREE_BOOT_BUDGET_MS',
	'DEDALO_UPLOAD_TMP_SUBDIR',
	'DEDALO_UPLOAD_MAX_SIZE_BYTES',
	// v6 shipped *_ALTERNATIVE_EXTENSIONS only for image and pdf; v7 has all five.
	'DEDALO_AV_ALTERNATIVE_EXTENSIONS',
	'DEDALO_SVG_ALTERNATIVE_EXTENSIONS',
	'DEDALO_3D_ALTERNATIVE_EXTENSIONS',
	// ops
	'DEDALO_BACKUP_DIR',
	// The full-read budget of backup verification (OPS-1, 2026-09-30). NEW_IN_V7 by
	// construction: v6 never read a dump back, so there is no v6 constant to rename.
	'DEDALO_BACKUP_VERIFY_SECONDS_PER_GB',
	'DEDALO_TRANSFORM_DEFINITIONS_DIR',
	'DEDALO_TS_STATE_PATH',
	// runtime-path census (2026-08-23): the ontology recovery dump moved out of
	// the code tree (a code-update swap carried the in-tree file away)
	'DEDALO_ONTOLOGY_RECOVERY_PATH',
	// geoip (native, offline IP→country for section Activity dd542)
	'DEDALO_GEOIP_ENABLED',
	'DEDALO_GEOIP_DIR',
	'DEDALO_GEOIP_AUTO_UPDATE',
	'DEDALO_GEOIP_DB_URL',
	// tools
	'DEDALO_ADDITIONAL_TOOLS',
	// TOOLS_ENABLE_REGISTRY_IMPORT retired 2026-10-30 (U-39): no v7 consumer.
	'TOOLS_REGISTRY_CACHE_TTL_MS',
	// site builder (the standalone publication/site_builder daemon)
	'DEDALO_SITE_BUILDER_URL',
	// The per-instance unix socket and the tenancy name it is paired with
	// (2026-08-29). NEW_IN_V7 by construction: v6 had no site builder at all, so
	// neither is a rename of any legacy constant.
	'DEDALO_SITE_BUILDER_SOCKET',
	'DEDALO_SITE_BUILDER_INSTANCE',
	'DEDALO_SITE_BUILDER_TOKEN',
	'DEDALO_SITE_BUILDER_TIMEOUT_MS',
	// external record services (the outbound side). NEW_IN_V7 rather than a rule off
	// a v6 constant: v6 had no shared outbound layer at all — each component that
	// talked to a third party carried its own hardcoded url and curl timeout, so
	// there is no legacy constant to classify. The allowlist is the new part: v6
	// could reach any host the ontology named.
	'DEDALO_EXTERNAL_ENABLED',
	'DEDALO_EXTERNAL_DISABLED_SERVICES',
	'DEDALO_EXTERNAL_ALLOWED_HOSTS',
	'DEDALO_EXTERNAL_TIMEOUT_MS',
	'DEDALO_EXTERNAL_MAX_BYTES',
	'DEDALO_EXTERNAL_MAX_CONCURRENCY',
	'DEDALO_EXTERNAL_SOFT_TTL_MS',
	'DEDALO_EXTERNAL_RETRY_ATTEMPTS',
	'DEDALO_EXTERNAL_BREAKER_COOLDOWN_MS',
	'DEDALO_EXTERNAL_MAX_ENTRY_CHARS',
	'DEDALO_EXTERNAL_MAX_ENTRIES',
	'DEDALO_EXTERNAL_ZENON_API_KEY',
	// install
	'DEDALO_INSTALL_PRIVATE_DIR',
	// The terminal installer's crash seam (2026-10-11): v6 had no resumable
	// installer, so there is nothing for it to be a rename of.
	'DEDALO_INSTALL_FAULT',
	// The terminal installer's host-step seams (phase 4, 2026-10-12): a marked
	// scratch root + recording runner, and the drill's probe CA. New in v7.
	'DEDALO_INSTALL_HOST_ROOT',
	'DEDALO_INSTALL_PROBE_CA_FILE',
	// The installer's release-identity pin (2026-10-15, release identity from the tag). New in v7.
	'DEDALO_INSTALL_RELEASE_IDENTITY',
	// The developer route's trust-store seam (2026-10-17): v6 installed no certificate authority. New in v7.
	'DEDALO_TEST_TRUST_STORE_OFF',
	// The update probe's plain-http LAN master seam (2026-10-30, U-24 https-only masters). New in v7.
	'DEDALO_UPDATE_HTTP_SOURCES_DEV',
	// diffusion (the native engine)
	'DEDALO_DIFFUSION_NATIVE',
	'DEDALO_DIFFUSION_NATIVE_ELEMENTS',
	'DEDALO_DIFFUSION_FILES_ROOT',
	'DEDALO_DIFFUSION_MAX_RUNNERS',
	'DEDALO_DIFFUSION_SCHEDULER_ENABLED',
	'DEDALO_DIFFUSION_BATCH_ROWS',
	'DEDALO_DIFFUSION_BATCH_RECORDS',
	// the publication server API v2 docs launcher (2026-10-30): v6 had no v2 API. New in v7.
	'DEDALO_PUBLICATION_API_V2_URL',
	// reconcile registry scheduler (audit 2026-08-26 S-10)
	'DEDALO_RECONCILE_SCHEDULER_ENABLED',
	// retention registry + scheduler (audit 2026-08-26 P2-9)
	'DEDALO_ACTIVITY_RETENTION_DAYS',
	'DEDALO_DIFFUSION_LEDGER_RETENTION_DAYS',
	'DEDALO_RETENTION_SCHEDULER_ENABLED',
	// error report (WC-017/018/019)
	'DEDALO_ERROR_REPORT_MASTER_URL',
	'DEDALO_ERROR_REPORT_RECEIVER',
	'DEDALO_ERROR_REPORT_TOKEN',
	'DEDALO_ERROR_REPORT_ALLOWED_IPS',
	'DEDALO_ERROR_REPORT_TIMEOUT_MS',
	'DEDALO_ERROR_REPORT_RETENTION_DAYS',
	'DEDALO_ERROR_REPORT_MAX_ROWS',
	// RAG / AI / MCP — wholly new subsystems
	'DEDALO_RAG_ENABLED',
	'DEDALO_RAG_DB_HOSTNAME_CONN',
	'DEDALO_RAG_DB_PORT_CONN',
	'DEDALO_RAG_DB_SOCKET_CONN',
	'DEDALO_RAG_DB_USERNAME_CONN',
	'DEDALO_RAG_DB_PASSWORD_CONN',
	'RAG_DB_NAME',
	// The test-vector-database seam: repoints the RAG pool AND arms the marker
	// guard (src/ai/rag/test_rag_db.ts). NEW_IN_V7 by construction — v6 had no
	// vector store, no dedicated test tier and no such guard.
	'DEDALO_TEST_RAG_DB_NAME',
	'DEDALO_RAG_BATCH_SIZE',
	'DEDALO_RAG_PROVIDER_TIMEOUT',
	// DEDALO_RAG_EMBEDDABLE_MODELS retired 2026-07-22: selection moved to the
	// section_map rag.embed ddo_map descriptor (no install-wide model scan).
	'DEDALO_RAG_CHUNK_STRATEGY',
	'DEDALO_RAG_CHUNK_TOKENS',
	'DEDALO_RAG_CHUNK_MIN_TOKENS',
	'DEDALO_RAG_SEMANTIC_BREAKPOINT_THRESHOLD',
	'DEDALO_RAG_RRF_K',
	'DEDALO_RAG_EXTERNAL_PROVIDER_FORBIDDEN_SECTIONS',
	// The image layer (object photographs). DEDALO_RAG_IMAGE_EGRESS_POLICY is the
	// institution's own switch for whether those images may be embedded off-host.
	'DEDALO_RAG_MEDIA_ENABLED',
	'DEDALO_RAG_MULTIMODAL_PROVIDER',
	'DEDALO_RAG_MULTIMODAL_MODEL',
	'DEDALO_RAG_MULTIMODAL_ENDPOINT',
	'DEDALO_RAG_MULTIMODAL_API_KEY',
	'DEDALO_RAG_IMAGE_EGRESS_POLICY',
	'DEDALO_RAG_IMAGE_MAX_PX',
	'DEDALO_RAG_IMAGE_HYBRID',
	'DEDALO_RAG_NEAR_DUPLICATE_SIMILARITY',
	'DEDALO_RAG_CHARACTERIZE_TOP_K',
	// In-browser inference (transcription, translation): where the model weights
	// live, and whether a public hub may be used at all. No v6 equivalent — v6 had
	// no local AI. See engineering/TRANSCRIPTION.md.
	// Language equivalence classes (Català===Valencià etc.) — hardcoded case
	// statements in v6 (lang::get_label_lang), a declared config in v7.
	'DEDALO_LANG_EQUIVALENCES',
	'DEDALO_AI_MODEL_STORE',
	'DEDALO_AI_MODEL_ALLOW_HUB',
	// The named exemption that lets a transcription server live on the LAN.
	'DEDALO_TRANSCRIBER_ALLOW_PRIVATE_HOSTS',
	'ANTHROPIC_API_KEY',
	'AGENT_MODEL',
	'DEDALO_AGENT_MODELS',
	'DEDALO_AGENT_MAX_TOKENS',
	'DEDALO_AGENT_HTTP_ENABLED',
	'DEDALO_AGENT_ALLOW_WRITE',
	'DEDALO_AGENT_WRITE_SECTIONS',
	'DEDALO_AGENT_SYSTEM_PROMPT_APPEND',
	'DEDALO_AGENT_ALLOW_EXTERNAL_PROVIDER_DEFAULT',
	// The per-user daily AI budget keys were removed 2026-10-12: the per-day AI limits are user /
	// profile data (dd692-699), not config — and v6 had no such keys to migrate.
	'DEDALO_MCP_USER_ID',
	'DEDALO_MCP_ALLOW_WRITE',
	'DEDALO_MCP_WRITE_SECTIONS',
	'DEDALO_MCP_MEDIA_IMPORT_DIR',
	'DEDALO_MCP_MEDIA_MAX_BYTES',
	// harness-only (never operator config)
	'PHP_API_BASE_URL',
	'PHP_API_USERNAME',
	'PHP_API_PASSWORD',
	'DIFFUSION_JOBS_TABLE',
	'DIFFUSION_ACTIVITY_TABLE',
	'DIFFUSION_RUNNER_STUB_DELAY_MS',
	// refused at runtime (an anti-pattern guard, not a setting)
	'NODE_TLS_REJECT_UNAUTHORIZED',
];

/** The rule for a legacy constant, or undefined when it is UNKNOWN to the map. */
export function classifyLegacyKey(name: string): MigrationRule | undefined {
	return V6_MIGRATION[name];
}

/**
 * Encode a resolved PHP value for the `.env` line format.
 * Returns null when the key must be SKIPPED (a PHP `null` = "unset", so writing
 * it would pin an empty string over the engine's own default).
 *
 * Arrays and maps go out as JSON: `readListEnv` accepts JSON or a comma list,
 * while `readJsonArray`/`readJsonMap`/`readServerList` accept ONLY JSON — so JSON
 * is the one encoding every v7 reader understands.
 */
export function encodeEnvValue(value: unknown): string | null {
	if (value === null || value === undefined) return null;
	if (typeof value === 'boolean') return value ? 'true' : 'false';
	if (typeof value === 'number') return String(value);
	if (typeof value === 'string') return value;
	if (typeof value === 'object') return JSON.stringify(value);
	return null;
}
