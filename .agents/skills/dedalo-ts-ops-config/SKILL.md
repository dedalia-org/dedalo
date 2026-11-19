---
name: dedalo-ts-ops-config
description: >-
  Configuration discipline and running the Dédalo v7 TS/Bun server in production. Use when reading or adding a DEDALO_* config key, touching process.env / src/config/env.ts (readEnv) / src/config/config.ts / src/config/catalog/ / ../private/.env, a flag like DEDALO_DIFFUSION_NATIVE, DEDALO_DEV_MODE or a test_seam key (DEDALO_SESSION_DB_PATH, DEDALO_TEST_MEDIA_ROOT), or doing anything ops: deploy/systemd, the unix socket + reverse proxy (SERVER_UNIX_SOCKET), graceful shutdown (SIGTERM drain), boot migrations, backups, /health, /api/v1/counters observability, or pool sizing (DB_POOL_MAX). Also for "config key isn't taking effect", "diffusion tool 404s", config_env_tripwire / config_docs_tripwire / config_census_tripwire / config_declaration_tripwire failures, and "how do we run this in production". Authoritative ops doc: engineering/PRODUCTION.md; validation checklist: engineering/STAGING_VALIDATION.md; key census: src/config/catalog/ (renders install/sample.env).
---

# Dédalo v7 TS — ops & config discipline

Two jobs: (1) read/add configuration the ONE correct way, (2) run and supervise the
Bun server in production. This skill is orientation + the load-bearing rules. The
operational detail lives in **engineering/PRODUCTION.md** (§1–15: runtime, supervision,
sockets/proxy, pool, observability, backups, migrations, diffusion placement, residue,
publication API, RAG, code updates, container secrets, account revocation, export
artifacts) — POINT there, do not re-derive it.

## The one config law

**`readEnv` (`src/config/env.ts`) is the ONLY environment reader. NEVER touch
`process.env` outside `src/config/`.**

Why: `readEnv` implements the precedence chain — real process env > `../private/.env`,
with the catalog default applied when neither sets the key. There is no per-host overlay.
A raw `process.env.KEY` drops the private-file half of that chain, so a value set in
`../private/.env` silently does nothing — exactly the "config key isn't taking effect" bug.

- Typed catalog: **`src/config/config.ts`** — every subsystem's keys resolved once at
  boot into a frozen object. Pool/observability/timeout/backup keys live under
  **`config.ops`**; the socket path is `config.server.unixSocketPath` (`SERVER_UNIX_SOCKET`).
- Key census: **`src/config/catalog/`** is the single source of truth (type, default, scope,
  prose — one entry per key). It GENERATES `install/sample.env` (the copy-paste template the
  installer drops at `../private/sample.env`) and the generated regions of
  `docs/administration/configuration/{config,config_db}.md`. `config_docs_tripwire` re-renders and demands byte
  identity, so hand-editing any of the three is a red gate — change the catalog and run
  `bun run config:gen` (`bun run config:check` verifies).
- `../private/.env` is **append-only, documented keys only** (AGENTS.md).

**Tripwire: `test/unit/config_env_tripwire.test.ts`** — statically bans `process.env` /
`Bun.env` / `import.meta.env` in `src/` and `tools/` outside `src/config/`. It carries a small
**subprocess-passthrough allowlist** (pg_dump / media binaries / runner child get the whole
env, each with a reason). Lowering the count is free; raising it needs a justified entry.

A new key is: (1) declare it in **`src/config/catalog/<domain>.ts`** — type, default, scope
and the operator prose, all in one entry; (2) read it (a `config.*` field if it is
boot-stable); (3) classify it in `src/config/migration_map.ts`; (4) `bun run config:gen`.
`config_docs_tripwire` fails on (1) and (4), `config_census_tripwire` on (3), and
`config_declaration_tripwire` if the printed type, the documented example and the parse
disagree (a collection-typed key may not be read through a bare `readEnv`). The catalog
prose must be **PHP-free** — it renders into `docs/administration/configuration/config.md`, where
`docs_current_engine_tripwire` bans the substring.

## Flags that are easy to get wrong

- **`DEDALO_DIFFUSION_NATIVE`** (catalog `src/config/catalog/diffusion.ts`, default **`true`**) —
  this server IS the diffusion engine. Read in `buildPlainVars` (`src/core/resolve/environment.ts`):
  only an explicit `false` advertises the dead external `DEDALO_DIFFUSION_API_URL` route, and every
  publication call from the tool then 404s. Set `false` only on a deployment that still runs the
  external service behind its own proxy route. `DEDALO_DIFFUSION_NATIVE_ELEMENTS` is a staged-
  migration allowlist of elements (unset = permissive); refusals come from `src/diffusion/api/actions.ts`.
- **`DEDALO_DEV_MODE`** (`src/core/resolve/environment.ts`, `buildPlainVars`) — the SERVER
  posture only: `DEVELOPMENT_SERVER`, the dev-only client libraries (mocha/chai), the no-cache
  manifest. **`DEVELOPMENT_SERVER` is exposed pre-auth** (the login path on dev servers
  needs it; gating it on `isLogged` stalled every dev login — the S1-19 fix).
  **`SHOW_DEBUG` / `SHOW_DEVELOPER` follow the logged user, NOT this key**: `SHOW_DEBUG` = root,
  `SHOW_DEVELOPER` = `principal.isDeveloper` (root included); both false for anonymous callers.
- **`test_seam` keys** (e.g. `DEDALO_SESSION_DB_PATH`, `DEDALO_TEST_MEDIA_ROOT`) exist for test
  isolation, set by the `bun test` preloads and the suite scripts — never in a production `.env`.
  `DEDALO_SESSION_DB_PATH` is read once at module load by `src/core/security/session_store.ts`;
  `DEDALO_TEST_MEDIA_ROOT` both repoints the media root and arms the marker refusal
  (`dedalo-ts-testing`).

**`coex_tag_tripwire`** (post-cutover form): NO `COEX` tag may exist in `src/` or `tools/`.
The PHP engine is retired, so a cross-engine coexistence hedge is impossible by definition —
a deployment variant is an ordinary catalog key, not a coexistence flag.

## Running in production

**Unix socket in production.** Bun.serve listens on `SERVER_UNIX_SOCKET`
(default `/tmp/dedalo_ts.sock`); a reverse proxy owns TCP/TLS, statics and media. The TCP
listener (`SERVER_TCP_PORT`) is a dev convenience and is unset in production. Full
runtime/supervision/proxy config: **engineering/PRODUCTION.md §1–3**.

Verified behaviors in `src/server.ts` — do not regress these:

- **Graceful shutdown** (`shutdownGracefully`, wired to SIGTERM/SIGINT): stop accepting →
  drain in-flight requests within `config.ops.shutdownGraceMs` (`SERVER_SHUTDOWN_GRACE_MS`) →
  mark undrained media jobs `interrupted` in their pfiles and journal dying background tool
  jobs → close the DB pool → unlink the
  socket → exit. An idempotency latch keeps a repeated SIGTERM from re-draining. Diffusion
  RUNNERS survive by design (engineering/PRODUCTION.md §8).
- **Double-start socket guard** (boot, before `Bun.serve`): an existing socket file is PROBED;
  if another instance answers, boot refuses loudly instead of stealing it; only a stale socket
  is unlinked. Two servers on one socket = corrupted routing.
- **Boot migrations** (`runBootMigrations`, `install/db/migrate.ts`): run once, idempotent; a
  failure aborts boot so no request sees a half-migrated schema. Authoritative:
  engineering/PRODUCTION.md §7. Separately, the `server.ts` boot sequence reconciles stale
  `running` media pfiles from the previous process life to `interrupted` (`reconcileProcessFiles`).
- **`/health`** (`src/core/api/process_health.ts`) is DB-checked AND poison-latched: once a
  boot-order/TDZ ReferenceError poisons the process, `/health` turns 503 so the watchdog
  (engineering/PRODUCTION.md §2) recycles it.
- **`/api/v1/counters`** (`src/core/api/counters.ts`, audit S2-37): session-gated AND
  global-admin-only; 404s for everyone else (no existence leak). Access log is one structured
  JSON line per request behind `DEDALO_ACCESS_LOG`.
- **Pool posture** (`config.ops`): `DB_POOL_MAX` (per-process; cross-process budget in
  engineering/PRODUCTION.md §4), `DB_POOL_ACQUIRE_TIMEOUT_MS`, `DB_STATEMENT_TIMEOUT_MS`.
- **Backups** (`src/core/area_maintenance/backup.ts`, S2-35): `pg_dump -F c` of the application
  database into `../private/backups/db`. The full backup set + restore-test cadence + the other
  stores: **engineering/PRODUCTION.md §6** — point there, do not enumerate here.

## Validation

Ops is code-verified; failover must be proven on a real restart. Before trusting a deploy, run
the checklist in **engineering/STAGING_VALIDATION.md** — shutdown/restart/failover/health/pool
behavior that no unit test exercises.

## Bun coupling

- Version is **pinned**: `.bun-version` and `package.json` `engines.bun` agree (a security pin
  with an updater, not staleness). Ops surfaces (Bun.serve unix socket, `Bun.spawn` for
  media/pg_dump, Bun.sql for postgres+mariadb) are version-sensitive — bump deliberately.
- The **Bun.sql jsonb/array param trap**: a plain object / native array bound into a jsonb
  param is mis-encoded; the write path routes through `encodeForJsonb`
  (`src/core/db/json_codec.ts`, which REJECTS lossy shapes). Full contract: `dedalo-ts-write-path`.

## The meta-rule

Every invariant enforced only by docs/memory was violated in practice; every **tripwired**
boundary held. If you add an ops/config invariant, add its tripwire and its row in the
tripwire index, **`engineering/TRIPWIRES.md`**. Measured state lives in rewrite/LEDGER.md
(gitignored, local-only).
