/**
 * Typed configuration catalog for the Dédalo TS server.
 *
 * This module plays the role the PHP config catalog (DEDALO_* constants) plays,
 * re-expressed as a frozen typed object built once at boot (spec §5).
 *
 * ENFORCED config rule (audit S2-21 — the honest version of the old "ONLY
 * module" claim, which the census falsified):
 *   - Raw `process.env` reads are BANNED outside src/config/ (tripwire:
 *     test/unit/config_env_tripwire.test.ts). The only exemptions are
 *     subprocess env passthrough (spawning children with the whole env) and
 *     the per-file deferred sites named in that tripwire's allowlist.
 *   - Every other module reads env through src/config/env.ts (`readEnv` /
 *     `requireEnv` / `envSnapshot`), which is what restores the documented
 *     precedence chain: real process env > ../private/.env.
 *   - This module is the PREFERRED typed home for boot-stable settings; a
 *     number of subsystems still read their keys via readEnv at call time
 *     (sessions/login, diffusion, RAG). Those shadow keys are being absorbed
 *     incrementally.
 *   - The KEY CENSUS is `src/config/catalog/` — one declaration per key (type,
 *     default, scope, operator prose), which GENERATES install/sample.env and
 *     docs/config/config.md and is gated byte-for-byte by config_docs_tripwire.
 *     (This header used to say the census "lives in ../private/sample.env,
 *     regenerated from source". Both halves were false: nothing regenerated it,
 *     and the file did not exist — the renderer was PHP machinery that was never
 *     ported at the cutover.)
 *
 * Multi-tenancy note: the PHP version routes one deployment to many databases
 * by entity (DEDALO_ENTITY → config_db routing). We start with a single-entity
 * config and keep `entity` in the shape so per-entity routing can be added in
 * the DB layer without changing call sites.
 */

import { legacyAwareDefaultDir } from './catalog/media.ts';
import { declaredDataLangs, resolveCurrentDataLang } from './data_langs.ts';
import { RETIRED_ENV_KEYS, readEnv } from './env.ts';
import { UNCONFIGURED } from './install_state.ts';
import { isDiffusionLangCode } from './lang_code.ts';
import {
	readBool,
	readJsonArray,
	readList,
	readMediaAccessMode,
	readNameList,
	readNumber,
	readOntologyServerList,
	readOptionalList,
	readOptionalString,
	readPublicationApiUsers,
	readServerList,
	readString,
	readToolRoots,
	requireList,
	requireMap,
	requireString,
	secureServerList,
} from './readers.ts';

/** PostgreSQL connection settings (system of record — same DB the PHP server uses). */
export interface DatabaseConfig {
	/** Database name, e.g. 'dedalo_mib_v7'. */
	readonly database: string;
	/**
	 * Host: either a TCP hostname ('localhost') or a unix-socket DIRECTORY
	 * (starts with '/', e.g. '/tmp' — Postgres appends .s.PGSQL.<port> itself).
	 * Ignored for transport when `socket` is set.
	 */
	readonly host: string;
	readonly port: number;
	/**
	 * DB_SOCKET: the unix-socket directory; '' = none. When set it WINS over
	 * `host`. Never read the pair by hand — resolvePgTransport(config.db)
	 * (src/config/pg_transport.ts) is the one decision every connection takes.
	 */
	readonly socket: string;
	readonly user: string;
	/** Empty string means trust/peer auth (typical local dev over the socket). */
	readonly password: string;
	/**
	 * PostgreSQL `sslmode`, passed to Bun.sql EXPLICITLY on every connection.
	 * Explicit because Bun 1.4 started reading ambient PGSSLMODE/PG_SSLMODE — a
	 * value the catalog cannot audit. Default 'disable' = the pre-1.4 behaviour.
	 */
	readonly sslMode: string;
}

export interface ServerConfig {
	/**
	 * Unix socket path Bun.serve listens on; the reverse proxy (Apache/Nginx)
	 * forwards API traffic here (spec §4). TCP is intentionally not offered —
	 * matching the production diffusion-engine pattern.
	 */
	readonly unixSocketPath: string;
}

/** Parity-harness settings: where the live PHP reference API answers. */
export interface PhpReferenceConfig {
	/** Base URL of the PHP JSON API, e.g. 'http://localhost/dedalo/lib/dedalo/core/api/v1/json/'. */
	readonly apiBaseUrl: string | undefined;
	/** Dev credentials used ONLY by the parity harness to log into the PHP server. */
	readonly username: string | undefined;
	readonly password: string | undefined;
}

/** Navigation-menu settings (PHP: area/menu constants, installation-specific). */
export interface MenuConfig {
	/** Label language for area/section titles (PHP DEDALO_APPLICATION_LANG). */
	readonly applicationLang: string;
	/** Default DATA language for component values (PHP DEDALO_DATA_LANG). */
	readonly dataLang: string;
	/**
	 * Couple the interface and data languages (PHP DEDALO_DATA_LANG_SYNC): when
	 * true, changing either language from the menu drives the other. Off by
	 * default (matches page_globals.dedalo_data_lang_sync=false on this install).
	 */
	readonly dataLangSync: boolean;
	/**
	 * Grouping tipos hidden from the menu but whose children are still shown,
	 * re-parented to the first non-skipped ancestor (PHP
	 * DEDALO_ENTITY_MENU_SKIP_TIPOS).
	 */
	readonly skipTipos: readonly string[];
	/** Area tipos removed from the menu entirely (PHP config `areas.deny`). */
	readonly areasDeny: readonly string[];
	/**
	 * Project languages (PHP DEDALO_PROJECTS_DEFAULT_LANGS) — the option set for
	 * component_select_lang and the diffusion langs. `lg-<code>` strings, order
	 * preserved from config (the datalist re-sorts by label).
	 */
	readonly projectsDefaultLangs: readonly string[];
}

/** One extra tools root: a filesystem path plus the same-origin URL it is served at. */
export interface ToolRootConfig {
	/** Absolute filesystem directory holding tool packages. */
	readonly path: string;
	/** Root-relative URL the tools under `path` are served at (e.g. '/custom_tools'). */
	readonly url: string;
}

/** Tools subsystem settings (PHP tool_paths + tools_register config). */
export interface ToolsConfig {
	/**
	 * Extra tool roots for third-party tools (PHP DEDALO_ADDITIONAL_TOOLS). The
	 * in-repo `tools/` root is always index 0 and wins name collisions.
	 */
	readonly additionalRoots: readonly ToolRootConfig[];
	// enableRegistryImport (TOOLS_ENABLE_REGISTRY_IMPORT) retired 2026-10-30
	// (update audit U-39): every writer passes dryRun:false; nothing read it.
}

/**
 * The engine's link to the standalone Site Builder daemon (publication/site_builder).
 *
 * The pairing is 1:1 and fixed: ONE museum, ONE engine, ONE daemon instance. Four of the
 * five fields are the whole of that address — where to dial (`socket` for a same-host
 * daemon, else `url`), WHO is on the other end (`instance`) and the shared bearer that
 * both proves the engine and, with the instance name, proves the pairing itself
 * (src/core/site_builder/pairing.ts).
 *
 * Every one of the four is `undefined` on an install where the feature was never
 * configured, which is the state tool_sitebuilder reads to hide itself and refuse. A
 * PARTIAL configuration (a transport without an instance, or without a token) is treated
 * as unconfigured too, and loudly: an engine that cannot prove which daemon it is talking
 * to must not talk to one.
 */
export interface SiteBuilderConfig {
	readonly url: string | undefined;
	/** Absolute path of the daemon's per-instance unix socket; the transport when set. */
	readonly socket: string | undefined;
	/** The daemon instance (museum tenancy) this engine is paired with. */
	readonly instance: string | undefined;
	readonly token: string | undefined;
	readonly timeoutMs: number;
}

/**
 * The outbound side: components whose ontology names a record service other than Dédalo's
 * own (a bibliographic catalogue, an authority file).
 *
 * Two of these fields are FAIL-CLOSED and must be read as such: `allowedHosts` empty means
 * NO host may be contacted (the address is assembled from editable ontology data, so the
 * operator — not the ontology — states where the server may go), and a service named in
 * `disabledServices` is never contacted even while everything else works. The remaining
 * fields are the bounds on one lookup: how long it may take, how much it may read, how many
 * may run at once, how stale a cached row may get before a background refresh, how hard a
 * failure is retried, how long a failing service is left alone, and how much one component
 * may emit from a remote answer.
 */
export interface ExternalServicesConfig {
	readonly enabled: boolean;
	/** Service identifiers (ontology `api_engine` values), lowercased. */
	readonly disabledServices: readonly string[];
	/** Host names, lowercased. EMPTY = every outbound request is refused. */
	readonly allowedHosts: readonly string[];
	readonly timeoutMs: number;
	readonly maxBytes: number;
	readonly maxConcurrency: number;
	readonly softTtlMs: number;
	readonly retryAttempts: number;
	readonly breakerCooldownMs: number;
	readonly maxEntryChars: number;
	readonly maxEntries: number;
	/** Undefined = the Zenon request carries no authorization header (its public API needs none). */
}

/** One configured code master (PHP CODE_SERVERS entry). */
export interface CodeServerEntry {
	readonly name: string;
	readonly url: string;
	readonly code: string;
}

/** Update-subsystem settings (rewrite/prompts/UPDATE_PROCESS.md). */
export interface UpdateConfig {
	// (The DEDALO_ENGINE_OWNS_INSTALL standalone-ownership opt-in was deleted
	// at the 2026-07-11 cutover: core/update/ownership.ts collapsed to `true`
	// — PHP engine retired, single-writer. The env key, if still present in
	// the append-only ../private/.env, is simply unread.)
	/** Remote code masters the code-update panel offers (PHP CODE_SERVERS). */
	readonly codeServers: readonly CodeServerEntry[];
	/**
	 * DEDALO_UPDATE_HTTP_SOURCES_DEV (development seam, U-24): plain-http
	 * masters off loopback are admitted. The rule is readers.ts isSecureUpdateSource.
	 */
	readonly httpSourcesDev: boolean;
	/**
	 * This instance serves code releases to other installations (PHP
	 * IS_A_CODE_SERVER): enables the code-manifest API action + the build twin.
	 * Default false (fail-closed).
	 */
	readonly isCodeServer: boolean;
	/** Directory holding built release archives (PHP DEDALO_CODE_FILES_DIR). */
	readonly codeFilesDir: string | undefined;
	/** Git checkout the build twin archives from (PHP DEDALO_CODE_SERVER_GIT_DIR). */
	readonly codeServerGitDir: string | undefined;
	/**
	 * How many code restore points survive retention (DEDALO_CODE_RESTORE_POINTS_KEEP).
	 * Pruning runs only after a CONFIRMED update, and never takes the newest
	 * bootable point — the rollback for the code currently running.
	 */
	readonly restorePointsKeep: number;
	/**
	 * This code master PUBLISHES developer builds (`<v>-dev.zip`) to consumers
	 * that explicitly ask for the dev channel. Default false: a public code
	 * server answers a dev ask exactly as it answers a release one, so branch
	 * builds are never enumerable from outside. v7-native (no PHP twin).
	 */
	readonly devChannelEnabled: boolean;
	/**
	 * This code master PUBLISHES prereleases (`<X.Y.Z-beta.N>.zip`) to consumers
	 * that ask for the prerelease or dev channel (DEDALO_CODE_SERVER_PRERELEASE_CHANNEL).
	 * A SEPARATE switch from {@link devChannelEnabled}: a master may publish
	 * immutable betas without exposing branch builds. Default false.
	 */
	readonly prereleaseChannelEnabled: boolean;
}

/** One configured ontology master (PHP ONTOLOGY_SERVERS entry). */
export interface OntologyServerEntry {
	readonly name: string;
	readonly url: string;
	readonly code: string;
	/** The shared TLDs this install takes from this master (D-8: one source per TLD). */
	readonly tlds?: readonly string[];
}

/** Ontology update/exchange settings (PHP ONTOLOGY_* constants). */
export interface OntologyIoConfig {
	/** Remote masters the update panel offers (PHP ONTOLOGY_SERVERS). */
	readonly servers: readonly OntologyServerEntry[];
	/**
	 * This instance serves ontology snapshots to other installations (PHP
	 * IS_AN_ONTOLOGY_SERVER): enables the manifest API actions + the IO-dir
	 * file route + the 'Local files' panel entry. Default false (fail-closed).
	 */
	readonly isOntologyServer: boolean;
	/** Access code remote clients must present (PHP ONTOLOGY_SERVER_CODE). */
	readonly serverCode: string | undefined;
	/**
	 * Top-level domains of the ontologies active in this installation
	 * (PHP glossary: DEDALO_PREFIX_TIPOS / defaults.prefix_tipos).
	 */
	readonly activeOntologyTlds: readonly string[];
	/**
	 * Was `ACTIVE_ONTOLOGY_TLDS` actually SET, or is `activeOntologyTlds` the
	 * catalog fallback? The update panel says which, because "these are the TLDs
	 * this installation tracks" and "nobody configured this yet, so here is the
	 * built-in set" are different answers for an administrator.
	 */
	readonly activeOntologyTldsConfigured: boolean;
	/** PHP STRUCTURE_FROM_SERVER passthrough for the update panel (null = unset). */
	readonly structureFromServer: boolean | null;
}

/**
 * One media TYPE's catalog (PHP config domains media_image.php / media_av.php /
 * media_docs.php). Every value here is CONFIGURATION under the PHP `DEDALO_*`
 * key names, .env-overridable, PHP default when unset (engineering/MEDIA_SPEC.md §3).
 * `concepts/media.ts` is the typed accessor over this — modules never hardcode
 * a quality/extension/dimension string.
 */
export interface MediaTypeConfig {
	/** First path segment under the media root, WITH leading slash (DEDALO_*_FOLDER, e.g. '/image'). */
	readonly folder: string;
	/** Normalized default extension the type converts to (DEDALO_*_EXTENSION, e.g. 'jpg'). */
	readonly extension: string;
	/** Ordered quality ladder, high→low (DEDALO_*_AR_QUALITY). */
	readonly qualities: readonly string[];
	/** Default web-delivery quality (DEDALO_*_QUALITY_DEFAULT). */
	readonly defaultQuality: string;
	/** Original (source-of-truth) quality (DEDALO_*_QUALITY_ORIGINAL). */
	readonly originalQuality: string;
	/** Upload allowlist (DEDALO_*_EXTENSIONS_SUPPORTED). */
	readonly allowedExtensions: readonly string[];
	/** Extra derivative extensions built alongside the default (DEDALO_*_ALTERNATIVE_EXTENSIONS). */
	readonly alternateExtensions: readonly string[];
}

/** External media binaries (PHP paths.binary_base + the derived *_PATH consts). */
export interface MediaBinariesConfig {
	/** Platform base dir (PHP paths.binary_base; Darwin '/opt/homebrew/bin' else '/usr/bin'). */
	readonly base: string;
	readonly magick: string; // MAGICK_PATH.'magick'|'convert' (resolved in the adapter)
	readonly identify: string;
	readonly ffmpeg: string; // DEDALO_AV_FFMPEG_PATH
	readonly ffprobe: string; // DEDALO_AV_FFPROBE_PATH
	readonly qtFaststart: string; // DEDALO_AV_FASTSTART_PATH
	readonly pdftotext: string; // PDF_AUTOMATIC_TRANSCRIPTION_ENGINE
	readonly pdftohtml: string;
	readonly pdfinfo: string;
	readonly ocrmypdf: string; // PDF_OCR_ENGINE
	/**
	 * Ghostscript's CLI (DEDALO_GS_PATH) — the ONLY PDF rasterizer in the engine.
	 * ImageMagick is not used for this: it can only read a PDF by spawning gs as a
	 * DELEGATE, a process the engine never sees and therefore cannot bound or kill
	 * (engine/ghostscript.ts). The hardened policy denies that delegate.
	 */
	readonly ghostscript: string;
	readonly file: string; // libmagic CLI fallback for ambiguous MIME sniffs
	/**
	 * librsvg's CLI (DEDALO_RSVG_CONVERT_PATH) — the ONLY SVG rasterizer in the
	 * engine. ImageMagick cannot be used for this: the hardened policy disables
	 * the MVG coder its internal SVG renderer emits (see engine/svg.ts).
	 */
	readonly rsvgConvert: string;
}

/** Upload service settings (PHP DEDALO_UPLOAD_SERVICE_* + DEDALO_UPLOAD_TMP_DIR). */
export interface MediaUploadConfig {
	/** Client chunk size in MB (DEDALO_UPLOAD_SERVICE_CHUNK_FILES); 0 = single-shot. */
	readonly chunkFilesMb: number;
	/** Client max concurrent chunk uploads (DEDALO_UPLOAD_SERVICE_MAX_CONCURRENT). */
	readonly maxConcurrent: number;
	/** Staging subdir under the media root (PHP DEDALO_UPLOAD_TMP_DIR = media/upload/service_upload/tmp). */
	readonly tmpSubdir: string;
	/**
	 * Max accepted upload size in bytes, reported by dd_utils_api::get_system_info
	 * so the client can reject oversize files before transfer. PHP derives this
	 * from php.ini (min of post_max_size / upload_max_filesize); the Bun server has
	 * no such ini, so it is an explicit setting (DEDALO_UPLOAD_MAX_SIZE_BYTES).
	 */
	readonly maxSizeBytes: number;
	/** Session cache expiry in minutes, reported verbatim by get_system_info (DEDALO_SESSION_CACHE_EXPIRE). */
	readonly sessionCacheExpire: number;
}

/** The whole media catalog (engineering/MEDIA_SPEC.md §3). */
export interface MediaConfig {
	/**
	 * Absolute filesystem media root (PHP DEDALO_MEDIA_PATH; env MEDIA_PATH).
	 * DERIVED — `<privateDir>/media` since 2026-08-23 (runtime-path census: an
	 * in-tree default is carried away by a code-update tree swap), with a
	 * keep-the-legacy fallback: an unset MEDIA_PATH plus a `<projectRoot>/media`
	 * that holds files keeps the legacy root, warned once. PHP derived
	 * DEDALO_ROOT_PATH + '/media'; sample.env documents both behaviours.
	 * Null is therefore unreachable from env; the type keeps it only so a test can
	 * construct an unconfigured catalog and prove requireMediaRoot still throws.
	 */
	readonly rootPath: string | null;
	/**
	 * THE TEST-MEDIA SEAM (env DEDALO_TEST_MEDIA_ROOT), null on every real
	 * installation. Set, it does TWO things at once, and that is the point:
	 *   1. it BECOMES `rootPath` (it outranks MEDIA_PATH), so the process serving
	 *      the tests resolves every media path inside the test root;
	 *   2. it ARMS the guard in `core/media/test_media_root.ts`, which makes every
	 *      media-root door refuse a root without a `.dedalo_test_media` marker.
	 * Neither half is settable without the other, so a run cannot be armed at the
	 * install's root, nor repointed with the guard asleep.
	 */
	readonly testRoot: string | null;
	/**
	 * Absolute-URL prefix for the media cells of export/relation lists — content
	 * that LEAVES the application (env DEDALO_MEDIA_EXPORT_BASE). Same value shape
	 * as `webBase` (origin + `/dedalo/<mediaDir>`; both are prefixed to the same
	 * media-root relative file_path), but stays undefined-meaning-unresolved when
	 * unset: a travelling cell may not carry a relative URL.
	 */
	readonly exportBase: string | undefined;
	/**
	 * The WEB base every media URL served to the client is built on
	 * (env DEDALO_MEDIA_WEB_BASE). Default — key unset or empty — is the
	 * same-origin relative base `/dedalo/<mediaDir>` (today's wire shape); set it
	 * to an absolute URL when media is served from a DIFFERENT origin than the
	 * app (e.g. dev: app on the Bun port, media on the web server). Distinct
	 * from `exportBase`, which only resolves export/relation cells that leave the
	 * application.
	 */
	readonly webBase: string;
	readonly image: MediaTypeConfig;
	readonly av: MediaTypeConfig;
	readonly pdf: MediaTypeConfig;
	readonly svg: MediaTypeConfig;
	readonly threeD: MediaTypeConfig; // 'component_3d' — property name can't start with a digit
	/** Shared thumbnail settings (DEDALO_QUALITY_THUMB / DEDALO_THUMB_EXTENSION / DEDALO_IMAGE_THUMB_*). */
	readonly thumb: {
		readonly quality: string;
		readonly extension: string;
		readonly width: number;
		readonly height: number;
	};
	/** AV posterframe + subtitles (DEDALO_AV_POSTERFRAME_EXTENSION / DEDALO_SUBTITLES_FOLDER / DEDALO_AV_SUBTITLES_EXTENSION). */
	readonly avExtras: {
		readonly posterframeExtension: string;
		readonly subtitlesFolder: string;
		readonly subtitlesExtension: string;
	};
	/** Image print DPI (DEDALO_IMAGE_PRINT_DPI). */
	readonly imagePrintDpi: number;
	/** Rasterization resolution for the SVG thumb (DEDALO_SVG_THUMB_DPI). */
	readonly svgThumbDpi: number;
	/**
	 * The resource bound every ImageMagick process runs under (DEDALO_MAGICK_LIMIT_*,
	 * audit MEDIA-01). Spliced as `-limit` argv by `magickResourceLimitArgs()`
	 * (core/media/engine/binaries.ts); the shipped `imagemagick-policy/policy.xml`
	 * carries the hard ceiling these values may not exceed. memory/map/area/disk
	 * degrade to a slower cache; width/height/time REFUSE, which is what stops a
	 * decode bomb on the upload request path.
	 */
	readonly magickLimits: {
		readonly memory: string;
		readonly map: string;
		readonly area: string;
		readonly disk: string;
		readonly width: number;
		readonly height: number;
		readonly time: number;
		/**
		 * How many IMAGES one source may contain (`-limit list-length`). The only one
		 * of these that bounds a `-ping` HEADER read: `-ping` skips the pixels but
		 * still enumerates every scene, so a 200000-frame GIF cost a header read
		 * 8.73 GB RSS with every pixel-cache limit armed (measured 2026-09-05).
		 */
		readonly listLength: number;
	};
	/**
	 * CONVERTER ADMISSION (audit MEDIA-01, the plural half): how many heavy
	 * conversions run at once, and how long one may wait for a lane before it is
	 * refused with `rate.limited`. `magickLimits` bounds ONE conversion; this
	 * bounds K of them, which is what an upload request path multiplies.
	 */
	readonly convert: {
		readonly concurrency: number;
		readonly queueSeconds: number;
	};
	/**
	 * AV ADMISSION (audit MEDIA-01, the ffmpeg half): how many ffmpeg PRODUCER
	 * processes this engine runs at once, and how long one may wait for a lane.
	 * A separate pool from `convert` on purpose — an image conversion holds a
	 * permit for seconds, an AV producer for minutes, and a shared pool would let
	 * an upload preview starve a transcode (and a job lane deadlock behind an
	 * image). The doors are `engine/ffmpeg.ts:runProducer` and
	 * `tools/fragment.ts:runFfmpeg`, which is what makes the two AV API actions
	 * (`create_posterframe`, `download_fragment`) bounded even though they are
	 * awaited INLINE on the request and belong to no job lane.
	 */
	readonly convertAv: {
		readonly concurrency: number;
		readonly queueSeconds: number;
	};
	/** Retouched-image twin quality (PHP DEDALO_IMAGE_QUALITY_RETOUCHED, default 'modified'). */
	readonly imageQualityRetouched: string;
	/**
	 * Rule-B public quality folders (PHP DEDALO_MEDIA_PUBLIC_QUALITIES): the folders an
	 * ANONYMOUS user may read when the record is published. `null` = derive them from
	 * this install's quality catalog (core/media/protection.ts getDefaultPublicQualities).
	 * Whatever is configured, master/work qualities are refused — see getPublicQualities().
	 */
	readonly publicQualities: readonly string[] | null;
	/**
	 * Raw Apache rewrite directives appended to the generated media/.htaccess just before
	 * the final deny (PHP MEDIA_HTACCESS_ADDONS, a JSON array of strings). The operator
	 * owns their syntax; the generator only places them.
	 */
	readonly htaccessAddons: readonly string[];
	readonly binaries: MediaBinariesConfig;
	readonly upload: MediaUploadConfig;
}

/** Install identity facts surfaced to the client (PHP identity.php domain). */
export interface IdentityConfig {
	/**
	 * Human-facing entity label (PHP DEDALO_ENTITY_LABEL — a DERIVED key that
	 * defaults to the entity name). Shown on the login form and About panels.
	 */
	readonly entityLabel: string;
	/** Entity id from the Dédalo registry (PHP DEDALO_ENTITY_ID, default 0). */
	readonly entityId: number;
	/** UI locale, e.g. 'es-ES' (PHP DEDALO_LOCALE). */
	readonly locale: string;
	/** Date component order: dmy|mdy|ymd (PHP DEDALO_DATE_ORDER). */
	readonly dateOrder: string;
}

/** Language catalog settings beyond the per-request langs (PHP lang.php domain). */
export interface LangConfig {
	/**
	 * Ontology structure lang (PHP DEDALO_STRUCTURE_LANG). Only lg-spa is
	 * accepted by upstream ontology exports; used as the label-term fallback.
	 */
	readonly structureLang: string;
	/**
	 * Available application langs, code → label map (PHP DEDALO_APPLICATION_LANGS).
	 * Order is preserved into the client language selector.
	 */
	readonly applicationLangs: Readonly<Record<string, string>>;
	/** Install default application lang (PHP DEDALO_APPLICATION_LANGS_DEFAULT). */
	readonly applicationLangsDefault: string;
	/** Default data lang used as untranslated-term fallback (PHP DEDALO_DATA_LANG_DEFAULT). */
	readonly dataLangDefault: string;
	/** Show/hide the data-lang selector menu (PHP DEDALO_DATA_LANG_SELECTOR). */
	readonly dataLangSelector: boolean;
	/**
	 * Language EQUIVALENCE classes (DEDALO_LANG_EQUIVALENCES): groups of lg-*
	 * codes that are the same language under different names — shipped default
	 * [['lg-cat','lg-vlca']] (Català === Valencià). The FIRST member of each
	 * class is the canonical TRANSLATION source (ontology terms and UI labels
	 * are authored there; the others read it — PHP lang::get_label_lang), while
	 * DATA fallback treats all members as mutual preferred fallbacks. Consumed
	 * through resolve/lang_alias.ts, never read raw.
	 */
	readonly equivalences: readonly (readonly string[])[];
}

/** Feature switches mirrored from the PHP features.php domain. */
export interface FeaturesConfig {
	/** Enable component locking while users edit fields (PHP DEDALO_LOCK_COMPONENTS). */
	readonly lockComponents: boolean;
	/** Send browser notifications, e.g. current locks (PHP DEDALO_NOTIFICATIONS). */
	readonly notifications: boolean;
	/**
	 * One active session per user (DEDALO_SINGLE_SESSION, default false). When
	 * true, login evicts the user's OTHER sessions (AUTHZ-04) — a new login
	 * invalidates a token stolen earlier; false keeps concurrent multi-device
	 * sessions. Password reset revokes all sessions regardless of this flag.
	 */
	readonly singleSession: boolean;
	/** Ceiling applied to client-supplied SQO limits (PHP DEDALO_SEARCH_CLIENT_MAX_LIMIT). */
	readonly searchClientMaxLimit: number;
	/** Component tipos excluded from the security-access datalist (PHP DEDALO_AR_EXCLUDE_COMPONENTS). */
	readonly arExcludeComponents: readonly string[];
	/**
	 * Media file access control (PHP DEDALO_MEDIA_ACCESS_MODE resolved through
	 * media_protection::get_mode()): false | 'private' | 'publication'. The
	 * legacy DEDALO_PROTECT_MEDIA_FILES=true is honored as 'private'.
	 */
	readonly mediaAccessMode: 'private' | 'publication' | false;
	/** Default records per page when a read carries no limit (PHP DEDALO_MAX_ROWS_PER_PAGE). */
	readonly maxRowsPerPage: number;
	/** Default project section_id for the projects filter (PHP DEDALO_DEFAULT_PROJECT). */
	readonly defaultProject: number;
	/** Projects filter section tipo (PHP DEDALO_FILTER_SECTION_TIPO_DEFAULT; dd153 = Projects). */
	readonly filterSectionTipo: string;
}

/**
 * Local IP→country resolution (section Activity dd542). Replaces the former
 * per-visitor browser fetch to a third-party service: the server resolves
 * country codes offline from an openly-licensed database (DB-IP IP-to-Country
 * Lite, CC-BY-4.0) via src/core/geoip/. Free, open, and reliable — no runtime
 * third-party dependency. Every field degrades soft (disabled/absent DB → no
 * country flag, never an error).
 */
export interface GeoipConfig {
	/** Master switch (DEDALO_GEOIP_ENABLED, default true). */
	readonly enabled: boolean;
	/** Cache dir for the .mmdb file (DEDALO_GEOIP_DIR, default <privateDir>/geoip). */
	readonly dir: string;
	/** Download + monthly refresh the DB (DEDALO_GEOIP_AUTO_UPDATE, default true). */
	readonly autoUpdate: boolean;
	/** Optional download URL override (DEDALO_GEOIP_DB_URL); undefined = DB-IP monthly URL. */
	readonly dbUrl: string | undefined;
}

/**
 * Operations posture (audit WS-E: S2-32/33/35/37, S2-17). Every key here is a
 * DEPLOYMENT knob with a safe default — see engineering/PRODUCTION.md for guidance.
 */
export interface OpsConfig {
	/** Emit one structured JSON access-log line per API request (DEDALO_ACCESS_LOG). */
	readonly accessLog: boolean;
	/** Requests slower than this log a warn line, 0 = off (DEDALO_SLOW_REQUEST_MS). */
	readonly slowRequestMs: number;
	/** DB statements slower than this log a warn line, 0 = off (DEDALO_SLOW_QUERY_MS,
	 * default 0). Applied by core/db/query_tap.ts on every lane. */
	readonly slowQueryMs: number;
	/** Postgres pool max per process (DB_POOL_MAX; cross-process budget in PRODUCTION.md). */
	readonly dbPoolMax: number;
	/** Max ms a query may QUEUE for a connection (either pool) before failing with
	 * the typed 503 `db.pool_exhausted`, 0 = wait forever (DB_POOL_ACQUIRE_TIMEOUT_MS,
	 * default 0; PRODUCTION.md recommends 30000). */
	readonly dbAcquireTimeoutMs: number;
	/** The request pool's statement_timeout ms (startup GUC), 0 = off
	 * (DB_STATEMENT_TIMEOUT_MS, default 0; PRODUCTION.md recommends 60000 — the
	 * on-by-default flip waits for every legitimately long statement to be in the
	 * unbounded scope, PRODUCTION.md §4 census). A fired ceiling is the typed 503
	 * `db.statement_timeout`. Maintenance is NOT sized around it: it runs inside
	 * `withUnboundedStatements` (core/db/postgres.ts), on the maintenance pool. */
	readonly dbStatementTimeoutMs: number;
	/** Connections of the separate MAINTENANCE pool, whose startup statement_timeout
	 * is 0 (DB_MAINTENANCE_POOL_MAX, default 2, min 1). Built lazily, on the first
	 * statement issued inside `withUnboundedStatements`; counts in the cross-process
	 * connection budget (PRODUCTION.md). */
	readonly dbMaintenancePoolMax: number;
	/** List offset from which default-ordered searches use the late-row-lookup
	 * rewrite, -1 = never (SEARCH_LATE_ROW_LOOKUP_OFFSET). */
	readonly searchLateRowLookupOffset: number;
	/** Bare time-machine COUNT(*) cache TTL backstop ms, 0 = no cache/exact
	 * (TM_COUNT_CACHE_TTL_MS). */
	readonly tmCountCacheTtlMs: number;
	/** Bun.serve idleTimeout SECONDS for both listeners (SERVER_IDLE_TIMEOUT_S).
	 * Bun's default 10 s killed any slow request on the TCP listener (S2-33);
	 * 255 is Bun's maximum. */
	readonly idleTimeoutSeconds: number;
	/** Graceful-shutdown drain budget in ms (SERVER_SHUTDOWN_GRACE_MS). */
	readonly shutdownGraceMs: number;
	/** Backup directory override (DEDALO_BACKUP_DIR); default derives from privateDir. */
	readonly backupDir: string | undefined;
	/** Directory holding pg_dump (DEDALO_PG_BIN_PATH); default probes Homebrew + PATH. */
	readonly pgBinPath: string | undefined;
	/** Min hours between backups — the make_backup throttle window (PHP DEDALO_BACKUP_TIME_RANGE). */
	readonly backupTimeRangeHours: number;
	/** Seconds per started GiB a full `pg_restore` read of a backup may take before it is an
	 * unproven (NOT usable) backup (DEDALO_BACKUP_VERIFY_SECONDS_PER_GB, default 60, min 1). */
	readonly backupVerifySecondsPerGb: number;
	/**
	 * Base directory of the ontology data IO exchange (PHP ONTOLOGY_DATA_IO_DIR
	 * = DEDALO_INSTALL_PATH.'/import/ontology'). A DERIVED key: defaults to the
	 * TS server's OWN install tree (<repo>/install/import/ontology — the TS
	 * port is self-contained, never the PHP install's dir). The versioned
	 * `<major>.<minor>` subdir is appended at write time by
	 * core/ontology/data_io.ts setOntologyIoPath().
	 */
	readonly ontologyDataIoDir: string;
	/**
	 * TS-owned home for the move_* transform definition JSON files
	 * (UPDATE_PROCESS Phase 5; PHP core/base/transform_definition_files).
	 * Defaults to <privateDir>/transform_definition_files (legacy-aware: an
	 * in-tree dir holding files keeps being used — catalog/tools.ts). undefined
	 * only if explicitly blanked.
	 */
	readonly transformDefinitionsDir: string | undefined;
	/**
	 * tool_export's server-built files (DEDALO_EXPORT_ARTIFACTS_DIR, default
	 * <privateDir>/export_artifacts). Consumed ONLY through
	 * tools/tool_export/server/artifact_store.ts, which also applies the test
	 * seam's marker refusal — never join a path onto this directly.
	 */
	readonly exportArtifactsDir: string;
	/** Hours a finished export's files are kept before the sweep (DEDALO_EXPORT_ARTIFACTS_TTL_HOURS, >= 1). */
	readonly exportArtifactsTtlHours: number;
	/** Bytes of export files one user may hold, 0 = no quota (DEDALO_EXPORT_ARTIFACTS_QUOTA_BYTES). */
	readonly exportArtifactsQuotaBytes: number;
	/** Exports one user may keep at once, 0 = no limit (DEDALO_EXPORT_ARTIFACTS_MAX_EXPORTS). */
	readonly exportArtifactsMaxExports: number;
	/** Bytes that must stay free on the export volume, 0 = no floor (DEDALO_EXPORT_ARTIFACTS_MIN_FREE_BYTES). */
	readonly exportArtifactsMinFreeBytes: number;
	/** Default records per export-preview page, 1..200 (DEDALO_EXPORT_PREVIEW_PAGE_SIZE). */
	readonly exportPreviewPageSize: number;
	/** Export jobs one user may have queued or running at once, >= 1 (DEDALO_EXPORT_JOBS_PER_USER). */
	readonly exportJobsPerUser: number;
}

/**
 * Error-report relay + intake (tool_error_report → the master installation;
 * WC-017/018/019). Sender side: masterApiUrl/token/relayTimeoutMs drive the
 * outbound relay. Receiver side (only the designated master): receiverEnabled/
 * allowedIps/token/retentionDays gate + bound the pre-auth intake action
 * (dd_error_report_api:receive_report — see src/core/error_report/).
 */
export interface ErrorReportConfig {
	/**
	 * Master installation JSON API endpoint the relay POSTs reports to
	 * (DEDALO_ERROR_REPORT_MASTER_URL, e.g. https://master.example/dedalo/core/api/v1/json/).
	 * Set ⇒ the sender relay is enabled (no separate flag). https-only; plain
	 * http is accepted for loopback dev targets.
	 */
	readonly masterApiUrl: string | undefined;
	/** Expose the pre-auth intake action on THIS server (DEDALO_ERROR_REPORT_RECEIVER).
	 * Default false — only the designated master flips it on. */
	readonly receiverEnabled: boolean;
	/**
	 * Optional shared per-master-deployment secret (DEDALO_ERROR_REPORT_TOKEN):
	 * the sender relays it as the X-Dedalo-Report-Token header; the receiver
	 * requires it when set. A spam filter, NEVER an authentication factor —
	 * every payload field stays untrusted regardless (SECURITY_DECISIONS).
	 */
	readonly token: string | undefined;
	/** Optional comma-separated intake IP allowlist (DEDALO_ERROR_REPORT_ALLOWED_IPS),
	 * install-gate style with a 'loopback' shorthand; unset = open (the intake is
	 * still throttled + size-capped). */
	readonly allowedIps: string | undefined;
	/** Outbound relay abort timeout in ms (DEDALO_ERROR_REPORT_TIMEOUT_MS, min 1000). */
	readonly relayTimeoutMs: number;
	/** Days received reports are retained before the opportunistic prune deletes
	 * older rows (DEDALO_ERROR_REPORT_RETENTION_DAYS, 0 = keep forever). */
	readonly retentionDays: number;
	/**
	 * Highest number of reports the store may hold (DEDALO_ERROR_REPORT_MAX_ROWS,
	 * 0 = no ceiling). The AGE window cannot bound a burst — a flood arriving today
	 * is inside the window for the whole of it, and a report may carry an inline
	 * screenshot — so the store also needs a row ceiling (audit SEC-20). Over the
	 * ceiling the OLDEST rows are evicted, never the incoming one refused: refusing
	 * would let a flood silence the genuine reports the intake exists for.
	 */
	readonly maxRows: number;
}

/**
 * PUBLICATION (diffusion) settings resolved ONCE, at boot.
 *
 * The lang set used to be re-derived at every plan compile from a RAW
 * `readEnv('DEDALO_DIFFUSION_LANGS')` plus a hand `.split(',')` — in four
 * different places. That is exactly how the phantom-lang defect happened: the
 * key is authored as a JSON array, a comma split turned `["lg-spa","lg-cat"]`
 * into the four garbage codes `["lg-spa`, `"lg-cat"]`, and the publication
 * shipped them without a word. One resolution, one shape, one place to gate.
 */
export interface DiffusionConfig {
	/** Languages to publish, ORDER PRESERVED — langs[0] is the main one. NEVER empty. */
	readonly langs: readonly string[];
	/** false => nothing was configured and `langs` was DERIVED from the project langs. */
	readonly langsConfigured: boolean;
	/** Configured entries that are not project languages — refused at plan compile. */
	readonly langsOutsideProject: readonly string[];
	/** Configured entries that are not `lg-xxx` codes at all — refused at plan compile. */
	readonly langsMalformed: readonly string[];
	/** Element tipos the native engine may publish. [] = permissive; ['all'] = every one. */
	readonly nativeElements: readonly string[];
	/** Publication server API v1 users (API_WEB_USER_CODE_MULTIPLE): the docu launchers. */
	readonly publicationApiUsers: readonly {
		readonly db_name: string;
		readonly code: string;
		readonly api_ui: string | null;
	}[];
}

export interface DedaloConfig {
	/** Instance identifier (PHP: DEDALO_ENTITY), e.g. 'myentity'. */
	readonly entity: string;
	/** Default section the client lands on after login (PHP MAIN_FALLBACK_SECTION). */
	readonly mainSection: string;
	/**
	 * Media directory/URL folder name (PHP DEDALO_MEDIA_DIR, default 'media').
	 * DEDALO_MEDIA_URL derives from it: '/dedalo/<mediaDir>'. Legacy installs
	 * override it (e.g. 'media_mib') so diffused media URLs stay byte-identical.
	 */
	readonly mediaDir: string;
	/**
	 * Ontology tipo of the users section (PHP DEDALO_SECTION_USERS_TIPO, default
	 * 'dd128'). Holds user records incl. password hashes — the raw-view endpoint
	 * denies raw reads of it. Config-driven so a reconfigured install stays covered.
	 */
	readonly usersSectionTipo: string;
	/**
	 * Map tile backend for component_geolocation (PHP DEDALO_GEO_PROVIDER, default
	 * 'VARIOUS'). Emitted in the geolocation edit context as features.geo_provider;
	 * the client map widget selects its Leaflet tile layer from it. An instance
	 * properties.geo_provider overrides it per component.
	 */
	readonly geoProvider: string;
	/**
	 * Opening CAMERA of the geolocation map when the record has no coordinate
	 * (DEDALO_GEO_DEFAULT_LAT/LON/ZOOM, default world view 20/0/2). Emitted in the
	 * geolocation edit context as features.default_view; an instance
	 * properties.default_view ({lat,lon,zoom}) overrides it per component. It is a
	 * VIEW, never data: absence of a coordinate is structural (null/''), never a
	 * magic coordinate, and nothing here is ever stored or published.
	 */
	readonly geoDefaultView: { readonly lat: number; readonly lon: number; readonly zoom: number };
	/**
	 * IANA timezone all DB timestamps are stamped in (PHP DEDALO_TIMEZONE,
	 * identity.timezone catalog default 'Europe/Madrid'). PHP sets it via
	 * date_default_timezone_set at bootstrap; the TS twin is db/db_timestamp.ts
	 * — matrix_time_machine.timestamp text-sorts, so both engines MUST stamp
	 * the same wall clock.
	 */
	readonly timezone: string;
	readonly db: DatabaseConfig;
	readonly server: ServerConfig;
	readonly phpReference: PhpReferenceConfig;
	readonly menu: MenuConfig;
	readonly identity: IdentityConfig;
	readonly lang: LangConfig;
	readonly features: FeaturesConfig;
	readonly diffusion: DiffusionConfig;
	readonly geoip: GeoipConfig;
	readonly tools: ToolsConfig;
	readonly siteBuilder: SiteBuilderConfig;
	readonly external: ExternalServicesConfig;
	readonly update: UpdateConfig;
	readonly ontologyIo: OntologyIoConfig;
	readonly media: MediaConfig;
	readonly ops: OpsConfig;
	readonly errorReport: ErrorReportConfig;
}

/**
 * The media catalog, built once from env with the PHP defaults (config domains
 * media_image.php / media_av.php / media_docs.php). engineering/MEDIA_SPEC.md §3.
 */
function buildMediaConfig(): MediaConfig {
	// MEDIA_PATH is a COMPUTED default in PHP, not an installer-written key: the
	// DEDALO_MEDIA_PATH constant is defined as DEDALO_ROOT_PATH + '/media', and
	// private/sample.env marks it "auto-derived; uncomment only to override" —
	// which is why no installer step writes it. The port dropped that derivation
	// and left rootPath null, so on EVERY fresh install the first read of a section
	// holding a media component threw "MEDIA_PATH is not configured" — and the media
	// test tier skips itself when the key is unset, so no gate ever saw it. The
	// literal 'media' matches PHP: the folder NAME config (DEDALO_MEDIA_DIR) drives
	// the URL, not this filesystem path.
	const mediaPath = readEnv('MEDIA_PATH');
	// The test seam outranks MEDIA_PATH — see MediaConfig.testRoot. It is read
	// here, in the ONE place the root is decided, so no door can resolve a root
	// the guard did not see.
	const testRootRaw = readEnv('DEDALO_TEST_MEDIA_ROOT');
	const testRoot = testRootRaw !== undefined && testRootRaw !== '' ? testRootRaw : null;
	// Unset MEDIA_PATH: the legacy-aware default (catalog/media.ts). Since the
	// runtime-path census (2026-08-23) the derived default is <privateDir>/media
	// — a code update renames the whole projectRoot away, so an in-tree default
	// silently moved the media library into the backup dir. A legacy
	// <projectRoot>/media that holds files keeps being used (nothing moves)
	// with a one-line warning naming MEDIA_PATH as the fix; only this call
	// warns, so the warning prints once per process (config builds once).
	const mediaRoot =
		testRoot !== null
			? testRoot
			: mediaPath !== undefined && mediaPath !== ''
				? mediaPath
				: legacyAwareDefaultDir('MEDIA_PATH', ['media'], ['media'], { warn: true, record: true });
	// The `bin(key, name)` helper is gone: each binary key now declares its own computed
	// default (`<DEDALO_BINARY_BASE>/<name>`) in src/config/catalog/media.ts, so the census
	// can print it and readString resolves it.
	// Client/wire media URL base: DEDALO_MEDIA_WEB_BASE ('' = unset), else the
	// same-origin relative default. Trailing slash stripped so every builder can
	// append its '/...'-rooted relative path.
	const webBaseRaw = readEnv('DEDALO_MEDIA_WEB_BASE');
	const webBase =
		webBaseRaw !== undefined && webBaseRaw !== ''
			? webBaseRaw.replace(/\/+$/, '')
			: `/dedalo/${readString('DEDALO_MEDIA_DIR')}`;
	// Export media base: same normalization (it is appended to the same
	// '/...'-rooted relative path — a trailing slash would emit '…/media//image/…'),
	// but NO default: unset stays undefined so the export reports the cell
	// unresolved instead of guessing a host.
	const exportBaseRaw = readEnv('DEDALO_MEDIA_EXPORT_BASE');
	const exportBase =
		exportBaseRaw !== undefined && exportBaseRaw !== ''
			? exportBaseRaw.replace(/\/+$/, '')
			: undefined;
	return Object.freeze({
		rootPath: mediaRoot,
		testRoot,
		exportBase,
		webBase,
		image: Object.freeze({
			folder: readString('DEDALO_IMAGE_FOLDER'),
			extension: readString('DEDALO_IMAGE_EXTENSION'),
			qualities: readList('DEDALO_IMAGE_AR_QUALITY'),
			defaultQuality: readString('DEDALO_IMAGE_QUALITY_DEFAULT'),
			originalQuality: readString('DEDALO_IMAGE_QUALITY_ORIGINAL'),
			allowedExtensions: readList('DEDALO_IMAGE_EXTENSIONS_SUPPORTED'),
			alternateExtensions: readList('DEDALO_IMAGE_ALTERNATIVE_EXTENSIONS'),
		}),
		av: Object.freeze({
			folder: readString('DEDALO_AV_FOLDER'),
			extension: readString('DEDALO_AV_EXTENSION'),
			qualities: readList('DEDALO_AV_AR_QUALITY'),
			defaultQuality: readString('DEDALO_AV_QUALITY_DEFAULT'),
			originalQuality: readString('DEDALO_AV_QUALITY_ORIGINAL'),
			allowedExtensions: readList('DEDALO_AV_EXTENSIONS_SUPPORTED'),
			alternateExtensions: readList('DEDALO_AV_ALTERNATIVE_EXTENSIONS'),
		}),
		pdf: Object.freeze({
			folder: readString('DEDALO_PDF_FOLDER'),
			extension: readString('DEDALO_PDF_EXTENSION'),
			qualities: readList('DEDALO_PDF_AR_QUALITY'),
			defaultQuality: readString('DEDALO_PDF_QUALITY_DEFAULT'),
			originalQuality: readString('DEDALO_PDF_QUALITY_ORIGINAL'),
			allowedExtensions: readList('DEDALO_PDF_EXTENSIONS_SUPPORTED'),
			alternateExtensions: readList('DEDALO_PDF_ALTERNATIVE_EXTENSIONS'),
		}),
		svg: Object.freeze({
			folder: readString('DEDALO_SVG_FOLDER'),
			extension: readString('DEDALO_SVG_EXTENSION'),
			qualities: readList('DEDALO_SVG_AR_QUALITY'),
			defaultQuality: readString('DEDALO_SVG_QUALITY_DEFAULT'),
			originalQuality: readString('DEDALO_SVG_QUALITY_ORIGINAL'),
			allowedExtensions: readList('DEDALO_SVG_EXTENSIONS_SUPPORTED'),
			alternateExtensions: readList('DEDALO_SVG_ALTERNATIVE_EXTENSIONS'),
		}),
		threeD: Object.freeze({
			folder: readString('DEDALO_3D_FOLDER'),
			extension: readString('DEDALO_3D_EXTENSION'),
			qualities: readList('DEDALO_3D_AR_QUALITY'),
			defaultQuality: readString('DEDALO_3D_QUALITY_DEFAULT'),
			originalQuality: readString('DEDALO_3D_QUALITY_ORIGINAL'),
			allowedExtensions: readList('DEDALO_3D_EXTENSIONS_SUPPORTED'),
			alternateExtensions: readList('DEDALO_3D_ALTERNATIVE_EXTENSIONS'),
		}),
		thumb: Object.freeze({
			quality: readString('DEDALO_QUALITY_THUMB'),
			extension: readString('DEDALO_THUMB_EXTENSION'),
			width: readNumber('DEDALO_IMAGE_THUMB_WIDTH'),
			height: readNumber('DEDALO_IMAGE_THUMB_HEIGHT'),
		}),
		avExtras: Object.freeze({
			posterframeExtension: readString('DEDALO_AV_POSTERFRAME_EXTENSION'),
			subtitlesFolder: readString('DEDALO_SUBTITLES_FOLDER'),
			subtitlesExtension: readString('DEDALO_AV_SUBTITLES_EXTENSION'),
		}),
		imagePrintDpi: readNumber('DEDALO_IMAGE_PRINT_DPI'),
		svgThumbDpi: readNumber('DEDALO_SVG_THUMB_DPI'),
		magickLimits: Object.freeze({
			memory: readString('DEDALO_MAGICK_LIMIT_MEMORY'),
			map: readString('DEDALO_MAGICK_LIMIT_MAP'),
			area: readString('DEDALO_MAGICK_LIMIT_AREA'),
			disk: readString('DEDALO_MAGICK_LIMIT_DISK'),
			width: readNumber('DEDALO_MAGICK_LIMIT_WIDTH'),
			height: readNumber('DEDALO_MAGICK_LIMIT_HEIGHT'),
			time: readNumber('DEDALO_MAGICK_LIMIT_TIME'),
			listLength: readNumber('DEDALO_MAGICK_LIMIT_LIST_LENGTH'),
		}),
		convert: Object.freeze({
			concurrency: readNumber('DEDALO_MEDIA_CONVERT_CONCURRENCY'),
			queueSeconds: readNumber('DEDALO_MEDIA_CONVERT_QUEUE_SECONDS'),
		}),
		convertAv: Object.freeze({
			concurrency: readNumber('DEDALO_MEDIA_AV_CONCURRENCY'),
			queueSeconds: readNumber('DEDALO_MEDIA_AV_QUEUE_SECONDS'),
		}),
		imageQualityRetouched: readString('DEDALO_IMAGE_QUALITY_RETOUCHED'),
		// null (unset) is MEANINGFUL: it means "derive the defaults from this install's
		// quality catalog", which is not the same as an explicitly EMPTY list (= no folder
		// is public, so rule B allows nothing).
		publicQualities: readOptionalList('DEDALO_MEDIA_PUBLIC_QUALITIES'),
		// JSON-ONLY (never readListEnv): these are raw Apache directives, and a directive
		// legitimately contains commas — `RewriteRule ^ - [R=404,L]`. readListEnv falls back
		// to comma-splitting whenever JSON.parse throws, which it does on the natural
		// single-escaped regex (`^10\.0\.`), so a typo would shred one directive into two
		// garbage lines and write them verbatim into a LIVE .htaccess — 500-ing the whole
		// media directory. readJsonArrayEnv refuses and logs instead.
		htaccessAddons: readJsonArray('MEDIA_HTACCESS_ADDONS'),
		binaries: Object.freeze({
			base: readString('DEDALO_BINARY_BASE'),
			magick: readString('DEDALO_MAGICK_PATH'),
			identify: readString('DEDALO_IDENTIFY_PATH'),
			ffmpeg: readString('DEDALO_AV_FFMPEG_PATH'),
			ffprobe: readString('DEDALO_AV_FFPROBE_PATH'),
			qtFaststart: readString('DEDALO_AV_FASTSTART_PATH'),
			pdftotext: readString('PDF_AUTOMATIC_TRANSCRIPTION_ENGINE'),
			pdftohtml: readString('DEDALO_PDFTOHTML_PATH'),
			pdfinfo: readString('DEDALO_PDFINFO_PATH'),
			ocrmypdf: readString('PDF_OCR_ENGINE'),
			ghostscript: readString('DEDALO_GS_PATH'),
			file: readString('DEDALO_FILE_BIN_PATH'),
			rsvgConvert: readString('DEDALO_RSVG_CONVERT_PATH'),
		}),
		upload: Object.freeze({
			chunkFilesMb: readNumber('DEDALO_UPLOAD_SERVICE_CHUNK_FILES'),
			maxConcurrent: readNumber('DEDALO_UPLOAD_SERVICE_MAX_CONCURRENT'),
			tmpSubdir: readString('DEDALO_UPLOAD_TMP_SUBDIR'),
			maxSizeBytes: readNumber('DEDALO_UPLOAD_MAX_SIZE_BYTES'),
			sessionCacheExpire: readNumber('DEDALO_SESSION_CACHE_EXPIRE'),
		}),
	});
}

// A retired spelling configures NOTHING (see RETIRED_ENV_KEYS in env.ts): left in
// place it would silently fall back to the new key's default — e.g. an empty
// ACTIVE_ONTOLOGY_TLDS shrinks the update panel's manifest to ontology/
// ontologytype alone. Refuse to boot instead, naming the one line to edit.
for (const [retired, replacement] of Object.entries(RETIRED_ENV_KEYS)) {
	if (readEnv(replacement) === undefined && readEnv(retired) !== undefined) {
		throw new Error(
			`Config key '${retired}' is RETIRED: rename that line to '${replacement}' in ../private/.env. See private/sample.env.`,
		);
	}
}

/**
 * Build the config once at import time and freeze it. A boot failure here is a
 * feature: a misconfigured server must refuse to start, not limp along. On an
 * UNCONFIGURED box (src/config/install_state.ts) the required keys carry
 * sentinels so `config` stays importable — and the server refuses to start there
 * anyway, with its own exit code.
 */
/**
 * Parse DEDALO_LANG_EQUIVALENCES: a JSON array of arrays of lg-* codes, e.g.
 * [["lg-cat","lg-vlca"]]. Groups keep their declared order (first member = the
 * canonical translation source); singleton or malformed groups are dropped, and
 * an unparseable value logs and yields no equivalences at all.
 */
function parseLangEquivalences(configured: string | undefined): readonly (readonly string[])[] {
	if (configured === undefined || configured.trim() === '') return Object.freeze([]);
	try {
		const parsed: unknown = JSON.parse(configured.trim());
		if (Array.isArray(parsed)) {
			return Object.freeze(
				parsed
					.filter((group): group is unknown[] => Array.isArray(group))
					.map((group) =>
						Object.freeze(
							group.filter(
								(code): code is string => typeof code === 'string' && code.startsWith('lg-'),
							),
						),
					)
					.filter((group) => group.length > 1),
			);
		}
	} catch {
		/* fall through to the loud refusal */
	}
	console.error(
		'[config] DEDALO_LANG_EQUIVALENCES must be a JSON array of arrays of lg-* codes — ignoring the value.',
	);
	return Object.freeze([]);
}

/**
 * Resolve the PUBLICATION language set — the ONE derivation, kept pure so the
 * gate and the unit tests can call it without booting a config.
 *
 * WHY IT DERIVES AT ALL (the rationale this rewrite inherited from the plan
 * compiler, where it used to live): an explicit DEDALO_DIFFUSION_LANGS wins.
 * When it is unset the languages MIRROR the project languages — the key has
 * always been a DERIVED one whose default is DEDALO_PROJECTS_DEFAULT_LANGS, so
 * in practice it is effectively always defined and the publication builder
 * never reaches its own single-language fallback. Collapsing to the one data
 * language instead (an earlier behavior here) published a single language out
 * of an installation that edits in four. The single-language path survives ONLY
 * as a last resort, for an installation with no project languages configured at
 * all — otherwise there would be nothing to publish.
 *
 * ORDER IS A CONTRACT: mainLang is `langs[0]`, so the configured order is kept
 * verbatim and never sorted or de-duplicated here.
 *
 * The two problem sets are REPORTED, not filtered: a malformed or non-project
 * entry means the operator's intent cannot be honored, and silently dropping it
 * would publish a set nobody asked for. The refusal happens at plan compile,
 * which is the only place that knows a publication is actually being built.
 */
export function resolveDiffusionLangs(
	configured: readonly string[],
	projectLangs: readonly string[],
	dataLang: string,
): {
	langs: readonly string[];
	configured: boolean;
	outsideProject: readonly string[];
	malformed: readonly string[];
} {
	if (configured.length === 0) {
		// Derived: the project langs, or — with none configured — the one data
		// language, so `langs` is never empty for a caller that must iterate it.
		const derived = projectLangs.length > 0 ? [...projectLangs] : [dataLang];
		return {
			langs: Object.freeze(derived),
			configured: false,
			// Nothing is "outside the project languages" when the project languages ARE
			// the source — but they still have to BE language codes. The derived set was
			// previously waved through unvalidated, so a typo in
			// DEDALO_PROJECTS_DEFAULT_LANGS (`"spa"` for `"lg-spa"`) reached the
			// publication plan unchecked and published a rendition under a code that
			// names no language: the exact silent-garbage class this key was fixed to
			// close, arriving through the other door.
			outsideProject: Object.freeze([]),
			malformed: Object.freeze(derived.filter((lang) => !isDiffusionLangCode(lang))),
		};
	}
	const projectSet = new Set(projectLangs);
	return {
		langs: Object.freeze([...configured]),
		configured: true,
		outsideProject: Object.freeze(configured.filter((lang) => !projectSet.has(lang))),
		malformed: Object.freeze(configured.filter((lang) => !isDiffusionLangCode(lang))),
	};
}

// Project languages are INSTALL configuration (owner rule 2026-07-09) and are read
// EXACTLY ONCE: `menu.projectsDefaultLangs` publishes them and `diffusion.langs`
// derives from them, so a second requireList call here would be a second source of
// truth for the same install fact.
const projectsDefaultLangs = requireList('PROJECTS_DEFAULT_LANGS');

// The other two language facts the DECLARED DATA-LANGUAGE SET is built from, read
// once each for the same reason (a second read is a second source of truth), and
// published below as `lang.dataLangDefault` / `lang.equivalences`.
const dataLangDefault = requireString('DEDALO_DATA_LANG_DEFAULT');
// Parsed here (not readJsonArray, whose String() element coercion would flatten
// the nested groups); a malformed value refuses loudly inside the parser and
// falls back to no equivalences rather than silently ungrouping languages.
const langEquivalences = parseLangEquivalences(readString('DEDALO_LANG_EQUIVALENCES'));

/**
 * THE LANGUAGES THIS INSTALLATION DECLARES FOR RECORD DATA — the set the write
 * chokepoint admits and the read fallback chain can reach (DATA-01/DATA-25).
 * Built here because every key it derives from is read here, and because
 * `menu.dataLang` two lines down is resolved AGAINST it. Definition, rules and
 * the omission of DEDALO_DATA_LANG: `src/config/data_langs.ts`.
 */
export const INSTALLED_DATA_LANGS: ReadonlySet<string> = declaredDataLangs({
	dataLangDefault,
	projectLangs: projectsDefaultLangs,
	equivalences: langEquivalences,
});

// The install's CURRENT data language, kept inside the declared set: a
// DEDALO_DATA_LANG naming a language the install does not declare is overruled by
// DEDALO_DATA_LANG_DEFAULT rather than becoming a write language no read reaches
// (see resolveCurrentDataLang for why this reports instead of throwing).
const configuredDataLang = readString('DATA_LANG');
const currentDataLang = resolveCurrentDataLang(
	configuredDataLang,
	INSTALLED_DATA_LANGS,
	dataLangDefault,
);
if (currentDataLang.replaced && !UNCONFIGURED) {
	// AN UNCONFIGURED BOX IS EXEMPT FROM THE REPORT, not from the substitution: it
	// reads sentinels whose PROJECTS_DEFAULT_LANGS is ['lg-eng'] while DATA_LANG
	// holds its catalog default 'lg-spa', so the mismatch there is the sentinel
	// state (the server refuses to start on it anyway), not an operator's mistake.
	console.error(
		`[config] DEDALO_DATA_LANG = '${configuredDataLang}' is not among the data languages ` +
			`this installation declares (${[...INSTALLED_DATA_LANGS].join(', ')}); using ` +
			`DEDALO_DATA_LANG_DEFAULT ('${dataLangDefault}') instead. Data already stored under ` +
			'the overruled code is reachable again by adding it to DEDALO_PROJECTS_DEFAULT_LANGS.',
	);
}

const diffusionLangs = resolveDiffusionLangs(
	readList('DEDALO_DIFFUSION_LANGS'),
	projectsDefaultLangs,
	// The RESOLVED language, not the raw key: this is the last-resort single
	// publication language for an install with no project languages at all, and
	// publishing a rendition in a language the install does not declare is the
	// same stranded-slice mistake one layer out.
	currentDataLang.lang,
);

// Report at boot, but DO NOT THROW: this module is imported at module scope by
// most of the engine (and by every gate), and a publication-only setting must
// never stop a server whose editors are working fine. The loud refusal belongs
// to the plan compiler, which runs only when someone actually publishes.
if (diffusionLangs.malformed.length > 0) {
	console.error(
		`[config] DEDALO_DIFFUSION_LANGS contains entries that are not 'lg-xxx' language codes: ${diffusionLangs.malformed.join(', ')} — publication will refuse to compile a plan.`,
	);
}
if (diffusionLangs.outsideProject.length > 0) {
	console.error(
		`[config] DEDALO_DIFFUSION_LANGS names languages outside DEDALO_PROJECTS_DEFAULT_LANGS: ${diffusionLangs.outsideProject.join(', ')} — publication will refuse to compile a plan.`,
	);
}

export const config: DedaloConfig = Object.freeze({
	entity: requireString('ENTITY'),
	mainSection: readString('MAIN_SECTION'),
	mediaDir: readString('DEDALO_MEDIA_DIR'),
	geoProvider: readString('DEDALO_GEO_PROVIDER'),
	geoDefaultView: Object.freeze({
		lat: readNumber('DEDALO_GEO_DEFAULT_LAT'),
		lon: readNumber('DEDALO_GEO_DEFAULT_LON'),
		zoom: readNumber('DEDALO_GEO_DEFAULT_ZOOM'),
	}),
	timezone: readString('DEDALO_TIMEZONE'),
	usersSectionTipo: readString('DEDALO_SECTION_USERS_TIPO'),
	db: Object.freeze({
		database: requireString('DB_NAME'),
		host: requireString('DB_HOST'),
		port: Number(readString('DB_PORT')),
		socket: readString('DB_SOCKET').trim(),
		user: requireString('DB_USER'),
		password: readString('DB_PASSWORD'),
		sslMode: readString('DB_SSLMODE'),
	}),
	server: Object.freeze({
		unixSocketPath: readString('SERVER_UNIX_SOCKET'),
	}),
	phpReference: Object.freeze({
		apiBaseUrl: readEnv('PHP_API_BASE_URL'),
		username: readEnv('PHP_API_USERNAME'),
		password: readEnv('PHP_API_PASSWORD'),
	}),
	menu: Object.freeze({
		applicationLang: readString('APPLICATION_LANG'),
		// Resolved against the declared data languages above, never the raw key.
		dataLang: currentDataLang.lang,
		dataLangSync: readString('DATA_LANG_SYNC') === 'true',
		skipTipos: Object.freeze(readJsonArray('MENU_SKIP_TIPOS')),
		areasDeny: Object.freeze(readJsonArray('AREAS_DENY')),
		// Project languages are INSTALL configuration (owner rule 2026-07-09):
		// required from ../private/.env DEDALO_PROJECTS_DEFAULT_LANGS, never a
		// hardcoded list — the string-family lang-fallback chain and the diffusion
		// lang set both derive from it. Resolved once, above.
		projectsDefaultLangs,
	}),
	identity: Object.freeze({
		// PHP derives the label from the entity name when unset — same here.
		entityLabel: readString('DEDALO_ENTITY_LABEL'),
		entityId: readNumber('DEDALO_ENTITY_ID'),
		locale: readString('DEDALO_LOCALE'),
		dateOrder: readString('DEDALO_DATE_ORDER'),
	}),
	lang: Object.freeze({
		structureLang: readString('DEDALO_STRUCTURE_LANG'),
		// LANGUAGE definitions are INSTALL configuration (owner rule 2026-07-09):
		// required from ../private/.env (PHP key names), never hardcoded lists.
		// The single-lang sentinels exist ONLY so `config` is importable on an
		// unconfigured box (install_state.ts); the installer writes the real values.
		applicationLangs: requireMap('DEDALO_APPLICATION_LANGS'),
		applicationLangsDefault: requireString('DEDALO_APPLICATION_LANGS_DEFAULT'),
		// Both read once, above: they build INSTALLED_DATA_LANGS as well.
		dataLangDefault,
		dataLangSelector: readString('DEDALO_DATA_LANG_SELECTOR') === 'true',
		equivalences: langEquivalences,
	}),
	features: Object.freeze({
		lockComponents: readString('DEDALO_LOCK_COMPONENTS') === 'true',
		notifications: readString('DEDALO_NOTIFICATIONS') === 'true',
		singleSession: readString('DEDALO_SINGLE_SESSION') === 'true',
		searchClientMaxLimit: Math.max(1, readNumber('DEDALO_SEARCH_CLIENT_MAX_LIMIT')),
		arExcludeComponents: readList('DEDALO_AR_EXCLUDE_COMPONENTS'),
		mediaAccessMode: readMediaAccessMode(),
		maxRowsPerPage: Math.max(1, readNumber('DEDALO_MAX_ROWS_PER_PAGE')),
		defaultProject: readNumber('DEDALO_DEFAULT_PROJECT'),
		filterSectionTipo: readString('DEDALO_FILTER_SECTION_TIPO_DEFAULT'),
	}),
	diffusion: Object.freeze({
		langs: diffusionLangs.langs,
		langsConfigured: diffusionLangs.configured,
		langsOutsideProject: diffusionLangs.outsideProject,
		langsMalformed: diffusionLangs.malformed,
		// [] is PERMISSIVE (every element publishes) — the staged-migration lever is
		// opt-in; ['all'] is the explicit "every element" spelling of the same thing.
		nativeElements: readList('DEDALO_DIFFUSION_NATIVE_ELEMENTS'),
		publicationApiUsers: readPublicationApiUsers('API_WEB_USER_CODE_MULTIPLE'),
	}),
	geoip: Object.freeze({
		enabled: readBool('DEDALO_GEOIP_ENABLED'),
		dir: readString('DEDALO_GEOIP_DIR'),
		autoUpdate: readBool('DEDALO_GEOIP_AUTO_UPDATE'),
		dbUrl: readOptionalString('DEDALO_GEOIP_DB_URL'),
	}),
	tools: Object.freeze({
		additionalRoots: Object.freeze(readToolRoots('DEDALO_ADDITIONAL_TOOLS')),
	}),
	siteBuilder: Object.freeze({
		url: readOptionalString('DEDALO_SITE_BUILDER_URL'),
		// The unix socket a same-host daemon answers on. When set it IS the transport
		// (src/core/site_builder/pairing.ts resolves the two into one), and the URL, if
		// present at all, contributes only a path prefix and a host name.
		socket: readOptionalString('DEDALO_SITE_BUILDER_SOCKET'),
		// The tenancy this engine is paired with. Not routing — the daemon serves exactly
		// one instance — but the identity half of the pairing fingerprint, so a transport
		// without it is treated as UNCONFIGURED rather than trusted (see pairing.ts).
		instance: readOptionalString('DEDALO_SITE_BUILDER_INSTANCE'),
		token: readOptionalString('DEDALO_SITE_BUILDER_TOKEN'),
		timeoutMs: readNumber('DEDALO_SITE_BUILDER_TIMEOUT_MS'),
	}),
	// The numeric bounds are declared in the catalog (`clamp`), not restated here, so the
	// generated census can print the same limits the reader enforces.
	external: Object.freeze({
		enabled: readBool('DEDALO_EXTERNAL_ENABLED'),
		disabledServices: readNameList('DEDALO_EXTERNAL_DISABLED_SERVICES'),
		allowedHosts: readNameList('DEDALO_EXTERNAL_ALLOWED_HOSTS'),
		timeoutMs: readNumber('DEDALO_EXTERNAL_TIMEOUT_MS'),
		maxBytes: readNumber('DEDALO_EXTERNAL_MAX_BYTES'),
		maxConcurrency: readNumber('DEDALO_EXTERNAL_MAX_CONCURRENCY'),
		softTtlMs: readNumber('DEDALO_EXTERNAL_SOFT_TTL_MS'),
		retryAttempts: readNumber('DEDALO_EXTERNAL_RETRY_ATTEMPTS'),
		breakerCooldownMs: readNumber('DEDALO_EXTERNAL_BREAKER_COOLDOWN_MS'),
		maxEntryChars: readNumber('DEDALO_EXTERNAL_MAX_ENTRY_CHARS'),
		maxEntries: readNumber('DEDALO_EXTERNAL_MAX_ENTRIES'),
	}),
	update: Object.freeze({
		codeServers: secureServerList(
			'CODE_SERVERS',
			readServerList('CODE_SERVERS'),
			readBool('DEDALO_UPDATE_HTTP_SOURCES_DEV'),
		),
		httpSourcesDev: readBool('DEDALO_UPDATE_HTTP_SOURCES_DEV'),
		isCodeServer: readString('IS_A_CODE_SERVER') === 'true',
		codeFilesDir: readEnv('DEDALO_CODE_FILES_DIR'),
		codeServerGitDir: readEnv('DEDALO_CODE_SERVER_GIT_DIR'),
		devChannelEnabled: readString('DEDALO_CODE_SERVER_DEV_CHANNEL') === 'true',
		prereleaseChannelEnabled: readString('DEDALO_CODE_SERVER_PRERELEASE_CHANNEL') === 'true',
		restorePointsKeep: readNumber('DEDALO_CODE_RESTORE_POINTS_KEEP'),
	}),
	ontologyIo: Object.freeze({
		servers: secureServerList(
			'ONTOLOGY_SERVERS',
			readOntologyServerList('ONTOLOGY_SERVERS'),
			readBool('DEDALO_UPDATE_HTTP_SOURCES_DEV'),
		),
		isOntologyServer: readString('IS_AN_ONTOLOGY_SERVER') === 'true',
		serverCode: readEnv('ONTOLOGY_SERVER_CODE'),
		activeOntologyTlds: readList('ACTIVE_ONTOLOGY_TLDS'),
		activeOntologyTldsConfigured: readOptionalList('ACTIVE_ONTOLOGY_TLDS') !== null,
		structureFromServer: (() => {
			const raw = readEnv('STRUCTURE_FROM_SERVER');
			return raw === undefined ? null : raw === 'true';
		})(),
	}),
	media: buildMediaConfig(),
	ops: Object.freeze({
		accessLog: readString('DEDALO_ACCESS_LOG') === 'true',
		slowRequestMs: readNumber('DEDALO_SLOW_REQUEST_MS'),
		slowQueryMs: readNumber('DEDALO_SLOW_QUERY_MS'),
		dbPoolMax: Math.max(1, readNumber('DB_POOL_MAX')),
		dbAcquireTimeoutMs: Math.max(0, readNumber('DB_POOL_ACQUIRE_TIMEOUT_MS')),
		dbStatementTimeoutMs: Math.max(0, readNumber('DB_STATEMENT_TIMEOUT_MS')),
		dbMaintenancePoolMax: Math.max(1, readNumber('DB_MAINTENANCE_POOL_MAX')),
		searchLateRowLookupOffset: Math.max(-1, readNumber('SEARCH_LATE_ROW_LOOKUP_OFFSET')),
		tmCountCacheTtlMs: Math.max(0, readNumber('TM_COUNT_CACHE_TTL_MS')),
		idleTimeoutSeconds: Math.min(255, Math.max(1, readNumber('SERVER_IDLE_TIMEOUT_S'))),
		shutdownGraceMs: Math.max(0, readNumber('SERVER_SHUTDOWN_GRACE_MS')),
		backupDir: readEnv('DEDALO_BACKUP_DIR'),
		pgBinPath: readEnv('DEDALO_PG_BIN_PATH'),
		backupTimeRangeHours: Math.max(0, readNumber('DEDALO_BACKUP_TIME_RANGE')),
		backupVerifySecondsPerGb: Math.max(1, readNumber('DEDALO_BACKUP_VERIFY_SECONDS_PER_GB')),
		// The legacy-aware default comes from the catalog (empty = unset, its
		// emptyIsUnset). The decision is RECORDED at server boot instead
		// (catalog/maintenance.ts recordOntologyDataIoDefault): config is imported
		// inside a refused install, which must write nothing.
		ontologyDataIoDir: readString('ONTOLOGY_DATA_IO_DIR'),
		transformDefinitionsDir: readString('DEDALO_TRANSFORM_DEFINITIONS_DIR'),
		exportArtifactsDir: readString('DEDALO_EXPORT_ARTIFACTS_DIR'),
		exportArtifactsTtlHours: readNumber('DEDALO_EXPORT_ARTIFACTS_TTL_HOURS'),
		exportArtifactsQuotaBytes: readNumber('DEDALO_EXPORT_ARTIFACTS_QUOTA_BYTES'),
		exportArtifactsMaxExports: readNumber('DEDALO_EXPORT_ARTIFACTS_MAX_EXPORTS'),
		exportArtifactsMinFreeBytes: readNumber('DEDALO_EXPORT_ARTIFACTS_MIN_FREE_BYTES'),
		exportPreviewPageSize: readNumber('DEDALO_EXPORT_PREVIEW_PAGE_SIZE'),
		exportJobsPerUser: readNumber('DEDALO_EXPORT_JOBS_PER_USER'),
	}),
	errorReport: Object.freeze({
		masterApiUrl: readEnv('DEDALO_ERROR_REPORT_MASTER_URL'),
		receiverEnabled: readString('DEDALO_ERROR_REPORT_RECEIVER') === 'true',
		token: readEnv('DEDALO_ERROR_REPORT_TOKEN'),
		allowedIps: readEnv('DEDALO_ERROR_REPORT_ALLOWED_IPS'),
		relayTimeoutMs: Math.max(1000, readNumber('DEDALO_ERROR_REPORT_TIMEOUT_MS')),
		retentionDays: Math.max(0, readNumber('DEDALO_ERROR_REPORT_RETENTION_DAYS')),
		maxRows: Math.max(0, readNumber('DEDALO_ERROR_REPORT_MAX_ROWS')),
	}),
});
