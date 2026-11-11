# What changed in v7

> See also: [How configuration works](administration.md) · [Migrating a v6 install to v7](../install/migrating_from_v6.md) · [Settings reference](config.md)

v7 replaced the PHP engine with a TypeScript/Bun one, and configuration changed
with it. This page is the reference for **what moved, what was renamed, and what
is simply gone** — so that when a v6 setting seems to have vanished, you can find
out what happened to it.

If you are upgrading an existing install, read [Migrating a v6 install to
v7](../install/migrating_from_v6.md) instead: it is the one manual for the whole
migration, and its Phase C tells you how to run the config conversion. This page
is the "why" behind it.

---

## The short version

| | v6 | v7 |
|---|---|---|
| **Where config lives** | four PHP files in `config/` (`config.php`, `config_db.php`, `config_areas.php`, `config_core.php`) | **one** file, `../private/.env`, outside the web root |
| **How you write a setting** | `define('DEDALO_TIMEZONE', 'Europe/Madrid');` | `DEDALO_TIMEZONE=Europe/Madrid` |
| **Lists and maps** | PHP array literals | JSON |
| **Paths** | you declared them (`DEDALO_CORE_PATH`, `DEDALO_MEDIA_URL`, …) | the engine derives them |
| **Runtime state** | `config_core.php`, written by the app | `../private/ts_state.json` |
| **Editing config** | edit a `.php` file inside the web root | the installer writes `.env` at install time; afterwards, edit `.env` and restart |

There is **no `config.php` in v7, and no PHP at all**. Nothing you put in a
`.php` file is read.

!!! warning "The `.env` is append-only"
    Add and change lines; do not delete or reorder other people's. A setting you
    remove falls back to the engine's built-in default, which is rarely what you
    meant. Retired keys are left in place, not deleted — see below.

---

## Why one file instead of four

The v6 config was PHP *code*, not data: `config.php` computed paths with
`dirname()`, read `$_SERVER`, called `setlocale()`, and ended by including the
application loader. That made it powerful and impossible to reason about — the
value of a constant depended on how the process had been started, and a config
file could (and did) run application code.

v7's `.env` is data. A key has one value, the engine derives everything that can
be derived, and nothing in the config file executes.

---

## How a value is resolved in v7

```
process environment   →   ../private/.env   →   the engine's built-in default
```

The real environment wins (so a systemd unit or a one-off
`DEDALO_DEV_MODE=true bun run dev` can override a file), then `../private/.env`,
then the default compiled into the engine. There is no per-host file, no
`config.local.php`, and no scope/catalog machinery — if you knew the v6/PHP-v7
config *catalog*, that concept is gone.

For the keys listed under "still works as a fallback" below, the engine also
accepts the old PHP spelling, so a migrated `.env` keeps working unchanged.

---

## Key changes

### Renamed — and the old name no longer works

The old spelling is **retired**: the engine refuses to boot if it finds it,
rather than silently ignoring it and falling back to a default.

| v6 constant | v7 key |
|---|---|
| `DEDALO_PREFIX_TIPOS` | **`ACTIVE_ONTOLOGY_TLDS`** |

`DEDALO_PREFIX_TIPOS` never described what it held. The value is the set of
ontology **top-level domains** active in this installation (`dd`, `rsc`, `oh`, …)
— which is the word the rest of Dédalo already used. See [Defining active
ontology TLDs](config.md#defining-active-ontology-tlds) for what each TLD means.

!!! danger "Why the boot refuses instead of ignoring it"
    An empty TLD list is not harmless: it shrinks the ontology-update panel's
    file list to nothing. Silently defaulting would have looked like it worked.

### Renamed — but the v6 spelling still works

These have a shorter, engine-native name in v7. The v6 name is honored as a
fallback, so a migrated `.env` needs no edit; the v7 name wins when both are set.

| v6 constant | v7 key |
|---|---|
| `DEDALO_ENTITY` | `ENTITY` |
| `MAIN_FALLBACK_SECTION` | `MAIN_SECTION` |
| `DEDALO_DATABASE_CONN` | `DB_NAME` |
| `DEDALO_HOSTNAME_CONN` | `DB_HOST` |
| `DEDALO_DB_PORT_CONN` | `DB_PORT` |
| `DEDALO_USERNAME_CONN` | `DB_USER` |
| `DEDALO_PASSWORD_CONN` | `DB_PASSWORD` |
| `DEDALO_SOCKET_CONN` | `DB_SOCKET` |
| `DEDALO_MEDIA_PATH` | `MEDIA_PATH` |
| `DEDALO_APPLICATION_LANG` | `APPLICATION_LANG` |
| `DEDALO_DATA_LANG` | `DATA_LANG` |
| `DEDALO_DATA_LANG_SYNC` | `DATA_LANG_SYNC` |
| `DEDALO_DATA_NOLAN` | `DATA_NOLAN` |
| `DEDALO_PROJECTS_DEFAULT_LANGS` | `PROJECTS_DEFAULT_LANGS` |
| `DEDALO_ENTITY_MENU_SKIP_TIPOS` | `MENU_SKIP_TIPOS` |
| `SLOW_QUERY_MS` | `DEDALO_SLOW_QUERY_MS` |

### Changed name **and** shape

| v6 constant | v7 key | what changed |
|---|---|---|
| `MYSQL_DEDALO_HOSTNAME_CONN` | `DEDALO_DIFFUSION_DB_HOST` | in v7 the Bun engine — not PHP — owns the MariaDB (diffusion) connection, so it has its own key family |
| `MYSQL_DEDALO_DB_PORT_CONN` | `DEDALO_DIFFUSION_DB_PORT` | ” |
| `MYSQL_DEDALO_SOCKET_CONN` | `DEDALO_DIFFUSION_DB_SOCKET` | ” |
| `MYSQL_DEDALO_USERNAME_CONN` | `DEDALO_DIFFUSION_DB_USER` | ” |
| `MYSQL_DEDALO_PASSWORD_CONN` | `DEDALO_DIFFUSION_DB_PASSWORD` | ” |
| `MAGICK_PATH` | `DEDALO_MAGICK_PATH` | v6 held a **directory** (`/usr/bin/`); v7 holds the **executable** (`/usr/bin/magick`) |
| `DB_BIN_PATH` | `DEDALO_PG_BIN_PATH` | same idea: a bare directory, no trailing slash |

`MYSQL_DEDALO_DATABASE_CONN` has no v7 equivalent: a diffusion publication now
carries its own target database, so there is no single configured name.

### Lists and maps are JSON now

```bash
# v6
define('DEDALO_IMAGE_EXTENSIONS_SUPPORTED', ['jpg','png','tif']);
define('DEDALO_APPLICATION_LANGS', ['lg-eng'=>'English','lg-spa'=>'Castellano']);

# v7
DEDALO_IMAGE_EXTENSIONS_SUPPORTED=["jpg","png","tif"]
DEDALO_APPLICATION_LANGS={"lg-eng":"English","lg-spa":"Castellano"}
```

Simple lists also accept a comma list (`dd,rsc,oh`), which is easier to read. Maps
and lists-of-objects (`ONTOLOGY_SERVERS`, `MENU_SKIP_TIPOS`) must be JSON.

`API_WEB_USER_CODE_MULTIPLE` (the publication server API v1 databases and codes
behind the maintenance panel's "Open Swagger UI" buttons) keeps its name and is
written as a JSON list of objects:

```bash
# v6
define('API_WEB_USER_CODE_MULTIPLE', [['db_name'=>'web_my_entity','code'=>'my_api_code','api_ui'=>null]]);

# v7
API_WEB_USER_CODE_MULTIPLE=[{"db_name":"web_my_entity","code":"my_api_code","api_ui":null}]
```

The empty entry a stock v6 `config.php` ships (`db_name` and `code` blank) is not
migrated; when it is the only entry, the key is not written at all and the panel
shows no buttons until you add one.

---

## Settings that are gone

Nothing here needs replacing — each was removed because v7 does not work that
way. The migration reports every one of these, with the reason, rather than
dropping them silently.

**The engine derives it now** — paths and URLs

`DEDALO_ROOT_PATH`, `DEDALO_ROOT_WEB`, `DEDALO_CORE_PATH`, `DEDALO_CORE_URL`,
`DEDALO_CONFIG_PATH`, `DEDALO_SHARED_PATH`, `DEDALO_SHARED_URL`,
`DEDALO_TOOLS_PATH`, `DEDALO_TOOLS_URL`, `DEDALO_LIB_PATH`, `DEDALO_LIB_URL`,
`DEDALO_WIDGETS_PATH`, `DEDALO_WIDGETS_URL`, `DEDALO_EXTRAS_PATH`,
`DEDALO_EXTRAS_URL`, `DEDALO_INSTALL_PATH`, `DEDALO_INSTALL_URL`,
`DEDALO_API_URL`, `DEDALO_MEDIA_URL`, `DEDALO_IMAGE_FILE_URL`,
`DEDALO_UPLOAD_TMP_DIR`, `DEDALO_UPLOAD_TMP_URL`,
`DEDALO_BACKUP_PATH_DB`, `DEDALO_BACKUP_PATH_TEMP`, `DEDALO_BACKUP_PATH_ONTOLOGY`,
`COLOR_PROFILES_PATH`, `ONTOLOGY_DATA_IO_URL`, and the rest of the `*_PATH` /
`*_URL` family.

**The media type comes from the file extension now**

`DEDALO_IMAGE_MIME_TYPE`, `DEDALO_IMAGE_TYPE`, `DEDALO_AV_MIME_TYPE`,
`DEDALO_AV_TYPE`, `DEDALO_PDF_MIME_TYPE`, `DEDALO_PDF_TYPE`,
`DEDALO_SVG_MIME_TYPE`, `DEDALO_3D_MIME_TYPE`, `DEDALO_3D_THUMB_DEFAULT`.

**The subsystem does not exist in v7**

PHP sessions and the cache manager (`DEDALO_SESSION_HANDLER`,
`DEDALO_SESSIONS_PATH`, `DEDALO_CACHE_MANAGER`) — v7 has its own session store.
The PHP logger (`LOGGER_LEVEL`). The debug flags `SHOW_DEBUG` and `SHOW_DEVELOPER`
are no longer configuration: v7 derives them per logged user, as v6 did (root →
`SHOW_DEBUG`; a user flagged as developer, root included → `SHOW_DEVELOPER`).
The front-end CDN/library URLs (`USE_CDN`, `JQUERY_*`, `BOOTSTRAP_*`, `D3_URL_JS`,
`LEAFLET_JS_URL`, …) — v7 serves its own client. PHP binaries and DB management
(`PHP_BIN_PATH`, `DEDALO_DB_TYPE`, `DEDALO_DB_MANAGEMENT`). Plus
`ENCRYPTION_MODE`, `MAGICK_CONFIG`, `DEDALO_AV_FFMPEG_SETTINGS`,
`DEDALO_PROFILE_DEFAULT` and the glTF converters.

**Superseded by a native subsystem**

`IP_API` — section Activity (dd542) still resolves a source country from the
visitor IP, but v7 does it server-side and offline against the openly-licensed
DB-IP Country Lite database (`src/core/geoip`) instead of pointing each browser
at a third-party API. Configure it with the `DEDALO_GEOIP_*` keys
(`DEDALO_GEOIP_ENABLED`, `DEDALO_GEOIP_DIR`, `DEDALO_GEOIP_AUTO_UPDATE`,
`DEDALO_GEOIP_DB_URL`).

**It is runtime state, not config** — it lives in `../private/ts_state.json`,
written by the maintenance area, never by you

`DEDALO_INSTALL_STATUS`, `DEDALO_MAINTENANCE_MODE`, `DEDALO_NOTIFICATION`,
`DEDALO_TEST_INSTALL`.

**It moved out of Dédalo and into the environment**

`SERVER_PROXY` — v6 passed this outbound proxy (`host:port`) to curl when Dédalo
fetched code or an ontology from a remote master. v7 still makes those fetches, but
has no Dédalo key for it: set the **standard `HTTPS_PROXY` / `HTTP_PROXY`
environment variables** on the server process instead, which the engine's HTTP
client honors.

!!! warning "`TRUSTED_PROXY_HOPS` is not its replacement"
    They point in opposite directions. `SERVER_PROXY` was about **reaching out**
    through a proxy. [`TRUSTED_PROXY_HOPS`](config.md) is about proxies **in front
    of** the server: how many reverse-proxy hops to trust when reading
    `X-Forwarded-For` to identify the client. Setting one where you meant the other
    is a security bug, not a migration.

**Retired after the cutover**

`DEDALO_ENGINE_OWNS_INSTALL` — the TS engine is the only engine now, so ownership
is unconditional. The key is read by nothing.

---

## Settings that are new in v7

Whole families have no v6 ancestor, because the subsystems are new: the HTTP
server and Postgres pool (`SERVER_UNIX_SOCKET`, `DB_POOL_MAX`, …), the native
session/login stack (`SESSION_TTL_SECONDS`, `LOGIN_MAX_ATTEMPTS`, …), media access
control (`DEDALO_MEDIA_ACCESS_MODE`), the native diffusion engine
(`DEDALO_DIFFUSION_*`), error reporting (`DEDALO_ERROR_REPORT_*`), and the
RAG/AI/MCP subsystems (`DEDALO_RAG_*`, `DEDALO_AGENT_*`, `DEDALO_MCP_*`).

They are all optional and documented in the [settings reference](config.md).

---

!!! info "Where this table comes from"
    Every classification on this page is held in `src/config/migration_map.ts`,
    which the migration tool reads and a tripwire test checks against the keys the
    engine actually reads. It cannot drift from the code without failing the build.
