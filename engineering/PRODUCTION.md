# PRODUCTION.md — operating the Dédalo TS server

Status: 2026-07 · the deployment reference required by the ops baseline
(audit DEC-17; items S2-32/33/35/36/37/38/39, S2-17, S3-48). One page per
concern; the reference systemd units live in `deploy/`.

## 1. Runtime (S2-36)

The Bun runtime is **pinned**: `.bun-version` + `package.json` `engines.bun`
(currently `1.4.4`). The code is coupled to version-specific Bun behavior —
`Bun.sql` jsonb parameter inference (a drift here is the realized S1-07/S1-08
corruption class), the Bun.sql MariaDB adapter (diffusion), `Bun.serve`
defaults. The server echoes its runtime at boot and **warns loudly** when it
differs from the pin. Never run `bun upgrade` on a production box; upgrade =
change the pin, run the full suite, deploy. `ExecStart` should point at the
pinned binary path, not a floating `bun` on `$PATH`.

**Upgrading the pin — what an operator must do (2026-08-25, 1.3.9 -> 1.4.0).**
The code updater REFUSES a release whose `.bun-version` differs from the running
runtime (`src/core/update/code_update.ts`), so an installation still on the old
Bun will decline the next release rather than half-install it. That is the gate
working. The order is therefore: **install the new Bun on the box first, restart
onto it, then apply the update.** The panel's readiness list shows this as the
"Bun version pin" line and cannot pre-decide it — the release's pin is only known
once the archive is downloaded.

**Ambient input added by Bun 1.4:** `Bun.sql` now honours `PGSSLMODE` /
`PG_SSLMODE` from the environment. That is a Postgres connection input the typed
config catalog does NOT see, so it cannot be audited through `readEnv`. Leave
both unset unless you mean them.

**Verified on 1.4.0 (2026-08-25), the version-coupled behaviours above:** the
`Bun.sql` jsonb double-encode trap is UNCHANGED, so the `$n::text::jsonb` idiom
remains load-bearing; the MariaDB adapter now decodes `DATETIME`/`TIMESTAMP` as
UTC (1.3.9 shifted them to local) and `JSON` columns as objects; `Bun.serve`
unix-socket options are unchanged. Full evidence: the bump's findings log.

**Re-verified on 1.4.2 (2026-09-23, 1.4.0 -> 1.4.2):** same probes, same
answers — a JS string bound as `$1::jsonb` still lands as a jsonb *string*
(`$1::text::jsonb` → object), MariaDB `DATETIME` still decodes as UTC and `JSON`
as objects, and bunfig's `[test] timeout` is still ignored (an 8 s test under a
30000 key died at 5001 ms), so `TEST_TIMEOUT_FLAG` stays load-bearing. Operator
order is unchanged: install 1.4.2, restart onto it, then apply the update.

**Moved to 1.4.3 (2026-10-14, 1.4.2 -> 1.4.3) for a runtime defect, not for
features:** on 1.4.2 a GC finalizer that ran inside `Bun.spawnSync` released its
poll on spawnSync's own, process-lifetime event loop, whose count then drifted
down until a later call never polled and spun at 100% CPU on an exited child
(oven-sh/bun#34069, fixed by #44581) — measured as the pre-push gate's
intermittent 60 s hangs in the CI image. Gate: `test/unit/ops_runtime_pin.test.ts`
(upstream's reproducer through the runtime under test: red on 1.4.2, green on
1.4.3). Re-probed on 1.4.3, same answers as 1.4.2: a JS string bound as
`$1::jsonb` lands as a jsonb *string* (`$1::text::jsonb` → object); MariaDB
`DATETIME` and `TIMESTAMP` decode as UTC (under `TZ=Europe/Madrid`) and `JSON` as
objects; bunfig's `[test] timeout` is still ignored (5003 ms kill). Operator order
is unchanged: install 1.4.3, restart onto it, then apply the update.
**One behaviour that DID change (bun #35119):** a transaction whose COMMIT Postgres
answers with ROLLBACK (it was already aborted — an error caught inside the body and
swallowed, without a savepoint) now REJECTS with `ERR_POSTGRES_COMMIT_ROLLED_BACK`;
1.4.2 resolved it, so the caller believed rolled-back work had committed. Found by
the db tier (`statement_ceiling_scope_native`, whose leg caught a 57014 inside
`withTransaction`; it now lets the error leave the transaction, as production does).
The rule this enforces was always true: inside `withTransaction`, a caught SQL error
needs a savepoint, or the error must leave the body.

**Moved to 1.4.4 (2026-11-02, 1.4.3 -> 1.4.4) — latest stable, no defect
driving it.** Re-probed on 1.4.4, same answers as 1.4.3: a JS string bound as
`$1::jsonb` lands as a jsonb *string* (`$1::text::jsonb` → object); MariaDB
`DATETIME` and `TIMESTAMP` decode as UTC (under `TZ=Europe/Madrid`) and `JSON` as
objects; bunfig's `[test] timeout` is still ignored (5001 ms kill). Operator order
is unchanged: install 1.4.4, restart onto it, then apply the update.

## 2. Process supervision (S2-38, S2-17)

Reference units in `deploy/`:

- `dedalo-ts.service` — `Restart=always`, `Environment=DEDALO_SUPERVISED=true`,
  journald log capture, SIGTERM stop.
- `dedalo-ts-watchdog.service` + `.timer` — every 30 s:
  `curl --fail --unix-socket /tmp/dedalo_ts.sock http://localhost/health`;
  on failure restarts the main unit. (systemd `WatchdogSec` needs `sd_notify`,
  which Bun does not speak — the curl timer is the equivalent.) The main unit
  `Wants=` it and `[Install] Also=` it, so `systemctl enable dedalo-ts` enables
  the health consumer with the server instead of leaving it to a second typed
  command (P2-33 / OPS-09).
- `dedalo-backup.service` + `.timer` — the nightly backup set (§6); it pulls in
  `dedalo-backup-site-builder.service`, store 5 as root in a unit of its own.
- `dedalo-ts-rollback.service` — restores the previous code tree after a
  failed code update (§12; fired by `OnFailure=` on the main unit and by the
  watchdog when a pending update never confirms). Publishing a release:
  `engineering/RELEASE.md`.

**Supervision is DECLARED, never inferred (2026-10-08).** A code update exits the
process after the swap and needs something to start it again, so it refuses
unless the process says a supervisor exists: `DEDALO_SUPERVISED=true`, read from
the **process environment only** (`src/core/update/supervision.ts`
`isSupervised`). Every shipped runtime definition declares it — the systemd units
(`deploy/dedalo-ts.service`, the multi-instance template in
`docs/install/multi_instance.md`) as `Environment=`, both compose stacks (and the
QNAP dev stack) in the `dedalo` service's `environment:`, and the `dev` /
`dev:server` / `start:supervised` package scripts on their own command line
(`scripts/dev.ts` and `scripts/dev_instance.sh` inherit it by delegation).
`bun run start` declares nothing: it is unsupervised by design. Two inputs are
deliberately ignored:

- **`../private/.env`.** That file is read by every launch method, including the
  plain `start`, so a value there would claim a supervisor for a process that
  has none. The refusal names the ignored line
  (`supervisorRefusalMessage`).
- **systemd's `INVOCATION_ID` / `JOURNAL_STREAM`** (the former auto-detect,
  removed). They are inherited by every descendant of a unit, including shells
  in terminal emulators that desktop sessions run as systemd user units, so an
  unsupervised `bun run start` typed there read as supervised — the update
  swapped, exited, and the server stayed down. The false positive is the
  dangerous direction, and with every shipped definition declaring the key,
  inference bought nothing.

The installer never writes the key (`install_plan.ts` cannot emit it). Gate:
`test/unit/supervision_declaration_tripwire.test.ts` — it executes the package
scripts with a recording stub, parses every shipped unit and compose stack, and
probes `isSupervised` in child processes.

`/health` answers `200 {result:'ok', db:'ok'}` only when **Postgres answers**
(S3-48); DB down / pool wedged → `503 {db:'down'}` → watchdog restart + a
red monitoring check.

**On a docker host the watchdog IS the healthcheck** (P2-33 / OPS-09).
`scripts/ops/container_watchdog.sh` is the `test:` of the `dedalo` service in
both shipped stacks: it runs the same probe, still exits non-zero so
`docker compose ps` reads *unhealthy*, and on the 3rd consecutive red — the same
number as the compose `retries`, held equal by
`test/unit/stack_ops_policy_tripwire.test.ts` — sends `SIGTERM` to PID 1, the
engine itself, so the drain runs and `restart: unless-stopped` recycles the
container (≈90 s, not systemd's 30 s). Without it nothing consumed the 503
there: a Compose healthcheck only feeds start ordering and `docker ps`, Docker
Engine never restarts an unhealthy container, and the restart policy fires on
process EXIT — which a poisoned or wedged process never does. It escalates only
after a first GREEN probe, which leaves a container that never came up green
untouched (a container that is not installed never even listens: it exits 78, §7.1). Behaviour gate:
`test/unit/container_watchdog_native.test.ts`.

**Graceful shutdown (S2-17).** On SIGTERM/SIGINT the server: stops the
diffusion and reconcile scheduler cadences → stops accepting connections → drains in-flight
requests up to `SERVER_SHUTDOWN_GRACE_MS` (default 10000) → waits, within the same
deadline, for a scheduled reconcile run in flight (§6.5) → marks still-live
media transcode jobs `interrupted` in their pfiles → journals dying background
tool jobs → closes the Postgres pool → unlinks the socket → exits 0.

A **planned restart** takes the same path and exits `RESTART_EXIT_CODE` (75)
instead of 0. `scheduleServerRestart` (`src/core/update/restart.ts`) hands off
to the graceful sequence through a handler `startServer` registers at boot, so
a code update or a code restore drains exactly like a supervisor's SIGTERM;
with no listening server registered (CLI, test runner) it falls back to an
immediate exit. It returns a `RestartOutcome` — `draining` / `immediate` — so a
caller can never report a restart it did not perform.

Diffusion RUNNERS are separate processes and survive restarts by design; the
sweeper heals anything that does not. **That survival is the unit file's job**:
`deploy/dedalo-ts.service` sets `KillMode=process` so systemd signals only the
server. Under the default (`control-group`) every runner is killed alongside it
and long publications are truncated mid-flight.

**Double-start guard.** At boot, a pre-existing socket file is **probed with a
connect()**: if something answers, the server refuses to start (exit 1)
instead of silently stealing the live instance's socket.

**Boot warm-up + poison latch (first-load TDZ class).** Before listening, the
server serially evaluates the whole `src/core` module graph
(`warmCoreModuleGraph`), so a concurrent first-request burst can never race
module evaluation into a TDZ-poisoned module (Bun caches a failed evaluation
for the whole process life — observed once as 1114 identical read failures
with a green DB-only health check). A warm-up failure aborts the boot (exit 1
— a visible crash loop beats a silently degraded server). Defense in depth:
if a TDZ-shaped `ReferenceError` ever reaches the dispatch catch anyway, the
process flips a poison latch (`core/api/process_health.ts`) — `/health`
answers `503 {process:'poisoned'}` from then on and the watchdog recycles the
process — within its 30 s cadence under systemd, within ~90 s on a docker stack
(§2). Gate: `test/unit/process_health.test.ts`.

### 2.1 The installer's instance units (terminal installer, phase 4)

A production install made by the terminal installer (`--route production
--instance <i>`, src/core/install/host/) does not copy the single-instance units
above. It writes the TEMPLATE units of `deploy/systemd/*@*` (shared by every
instance on the host — written when absent or byte-equal, refused when a
different file holds the name, removed only when no instance in the host
registry `/var/lib/dedalo-install/instances/` still uses them) and ONE drop-in
per unit and instance (`/etc/systemd/system/<unit>@<i>.<kind>.d/10-dedalo-install.conf`,
stamped `# dedalo-install <i> <answers digest>`):

- `dedalo-ts@<i>.service`: the drop-in replaces `ExecStart` with the root-owned
  runtime `/opt/dedalo/bun/<pin>/bun run src/server.ts` and sets
  `DEDALO_CLIENT_PUBLISH_DIR=/srv/dedalo/<i>/client`. The template does NOT
  `Wants=`/`Also=` the watchdog: the installer ARMS `dedalo-ts-watchdog@<i>.timer`
  only after the first boot recorded every migration (a watchdog armed with the
  service killed a first boot mid-migration — campaign 2 L7). The watchdog
  script also skips while the unit is activating or younger than its grace, and
  while the engine's boot marker names a live pid; its timer waits
  `OnActiveSec=60` before the first check.
- `dedalo-backup@<i>.service`: the drop-in lists the store lines and declares
  `DEDALO_BACKUP_EXPECTED_STORES` DERIVED from them, every `Environment=` value
  quoted (an unquoted list was truncated to its first word — L8); the nightly
  timer is enabled only after a first backup verified every store.
- EVERY script a root-started unit runs (rollback — its file work as the
  instance user, only the restart as root —, watchdog, alert, the site-builder
  store) runs from `/opt/dedalo/instances/<i>/bin/` (root:root 0755), never from
  the instance's tree: a root-run unit must not execute a file the instance user
  can replace. A code update (it runs as the instance) does not refresh those
  copies, and the installer refuses to run over a sealed instance — a release
  that changes `deploy/*.sh` says what to do in its release notes; a Bun pin
  change likewise (the runtime is root's).
- nginx: the media map's variables are global, so ONE instance's generated map is
  included host-wide (`/etc/nginx/conf.d/dedalo-00-media-map.conf`) and a second
  instance whose map differs is refused — same-host instances run the same
  release.

### 2.2 The host layout is defined by ROLE, not by a path (2026-10-12)

Real hosts look like `/home/my_domain.org/dedalo`, several instances per server,
so no fixed path is THE layout. Two roles are, and every unit, script and
installer render places things by them:

1. **The INSTANCE DIR** — any path (`/home/ded_<i>` by default from the
   installer, or the operator's `--install-dir` such as
   `/home/my_domain.org/dedalo`; `/opt/dedalo/app` by hand), **owned by the
   service user** (`--service-user`: a new account, or an existing one the
   installer uses as it is and never creates or deletes). It holds the code tree (`<instance dir>/master_dedalo`; the
   installer's is `dedalo/`), `private/` (the engine's `../private`) and
   `backups/` — including the code-update backup root `backups/code`, where the
   update stages, parks the outgoing tree and the rollback parks a failed one.
   **Every rename a code update, an in-app restore or the supervisor-side
   rollback makes is an entry of the instance dir or of that backup root**
   (`code_update.ts` `renameSwap`/`carryPreservedEntries`/`restoreAfterFailedSwap`,
   `code_restore.ts` through the same `sentinelGuardedSwap`,
   `deploy/dedalo-code-rollback.sh`'s two `mv`s), so the instance dir's
   PARENT may be root-owned. The engine refuses an update or restore BEFORE the
   download when it cannot write the instance dir or the backup root
   (`assertSwapPreconditions` → `unwritableSwapDirs`); a `DEDALO_BACKUP_PATH`
   outside the instance dir must still be the service user's and on the same
   filesystem.
2. **ROOT-RUN THINGS** — the pinned Bun runtime and every script a root-started
   unit executes (watchdog, rollback, backup steps, store 5, alert, media
   rules) — live in a **root-owned directory OUTSIDE the instance dir**, per
   instance or shared (`/opt/dedalo/instances/<i>/bin/` from the installer;
   `/opt/dedalo/bin/`, `/usr/local/lib/dedalo/<name>/bin/` by hand). Root never
   writes into the instance dir except through steps that run as the service
   user (the rollback's file work, the backup stores, the installer's engine
   steps).
3. **Units name both by placeholder or derivation, never by a host path.** The
   installer's templates derive only `%i` NAMES (`/opt/dedalo/instances/%i/bin`,
   `dedalo-%i`) and carry no user, group, working directory, `.env` or instance
   path: the per-instance drop-ins (`host/systemd/render.ts`, from
   `host/layout.ts` `pathsFor` — the service group resolved from the host's
   facts) carry `User=`, `Group=`, `WorkingDirectory=`, `HOME`, the
   `EnvironmentFile=` and the rollback/watchdog `--app-dir`/`--backup-root`/
   `--socket`. A template WITHOUT its drop-in runs `ExecStart=/bin/false`
   (the rollback's `ExecCondition` too) — fail-closed, never as root. The
   hand-installed units
   under `deploy/*.service` carry `INSTANCE_DIR`, `ROOT_BIN_DIR` and
   `DEDALO_USER`, rendered per host by `docs/install/manual_host.md`.

Gates: `test/unit/code_update.test.ts` (*the instance-dir rule* — the full
update chain, the restore and the rollback script EXECUTED against a scratch
instance dir whose parent is `0555`; a layout that needs the parent refuses
before the download); `test/unit/operator_commands_tripwire.test.ts` (E2 —
every shipped unit rendered for three layouts: root executes nothing inside the
instance dir, and no active line spells a host path);
`test/unit/install_host_render_tripwire.test.ts` (c) and (f) for the installer's
render (the default and a custom layout; templates user- and path-agnostic and
fail-closed); `test/unit/install_host_identity_native.test.ts` (root names no
path strictly inside the install folder; one user, group and folder per
instance; an existing account never created or deleted).

## 3. Sockets, reverse proxy, timeouts (S2-33)

Production serving is **unix-socket-only**: `SERVER_UNIX_SOCKET` (default
`/tmp/dedalo_ts.sock`). The reverse proxy owns TCP/TLS, serves the client
statics + media, and forwards `/api` + dynamic routes to the socket. The TCP
listener (`SERVER_TCP_PORT`) is a dev convenience — do not expose it.

**Media access control**: the ENGINE generates the web-server rules; the PROXY
enforces them (one `stat()` per request — media files reach 16–32 GB, so nothing
may sit in the byte path). See §3.1 and `engineering/MEDIA_PROTECTION.md`.

Both listeners set an explicit `idleTimeout` (`SERVER_IDLE_TIMEOUT_S`,
default 255 — Bun's maximum; the silent Bun default of 10 s killed slow
exports/searches mid-handler). **Match the proxy**: a proxy read-timeout below
the slowest legitimate request (large exports, tool actions) re-introduces the
same failure one hop earlier. nginx sketch:

The `http2 on;` line is not decoration: the client boots as a static ES module
graph of 35 modules, 5 import levels deep, 39 requests before the first API
call (measured and pinned by `test/unit/page_load_budget_native.test.ts`). h2
multiplexes them onto one connection. A PLAIN-HTTP front end cannot have it —
browsers negotiate HTTP/2 through the TLS handshake, never in cleartext — which
is why `deploy/nginx.simple.conf` (installer TLS mode 4 only) carries a
`TRANSPORT` block recording that choice and its cost instead of the directive.

```nginx
upstream dedalo_ts { server unix:/tmp/dedalo_ts.sock; }
server {
    listen 443 ssl;
    http2 on;                      # multiplexes the 35-module ES boot graph
    # ... TLS certs ...

    # Media — protected. The rule files are GENERATED by the engine
    # (src/core/media/protection.ts) into the media root and enforced HERE.
    # See §3.1 below; the map include goes in http{}, not here.
    include /path/to/media/dedalo_media_protection.nginx.conf;
    open_file_cache off;           # a stat() cache delays unpublish taking effect

    # API + dynamic routes → the Bun socket. MUST keep precedence over the
    # static /dedalo/ prefix below (regex locations win over prefix ones).
    location ~ ^/(api/v1/|dedalo/core/api/) {
        proxy_pass http://dedalo_ts;
        proxy_http_version 1.1;
        proxy_read_timeout 300s;   # ≥ the slowest legitimate request
        proxy_send_timeout 300s;
        proxy_buffering off;       # SSE + NDJSON streaming (diffusion, export)
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }

    # Client statics — nginx serves the copied client tree directly. Mirrors
    # the Bun dev/fallback semantics (src/core/api/static_asset.ts): the tree
    # is re-synced IN PLACE (not content-hashed), so text assets revalidate
    # (etag → 304, the client's service worker replays If-None-Match) and are
    # NEVER `immutable`. The 2026-07-09 boot probe measured 25 files / 1.4 MB
    # uncompressed on a cold boot — gzip + 304s are the whole win here.
    location /dedalo/ {
        alias /path/to/master_dedalo/client/dedalo/;   # scripts/sync_client.sh target
        etag on;
        add_header Cache-Control "no-cache";           # revalidate; 304s are cheap
        add_header X-Content-Type-Options "nosniff";
        add_header X-Frame-Options "SAMEORIGIN";
        add_header Referrer-Policy "strict-origin-when-cross-origin";
        gzip on;
        gzip_types text/css application/javascript application/json image/svg+xml;
        gzip_min_length 1024;
        location ~* \.(png|jpe?g|gif|webp|ico|woff2?|ttf|otf)$ {
            add_header Cache-Control "public, max-age=3600";
        }
        # Tool assets (/dedalo/tools/) live in the repo tools/ tree, NOT under
        # client/ — proxy them to the socket (the Bun handler enforces the
        # server/-subtree and extension fail-closed rules). tools_common needs
        # no rule of its own: since 2026-08-16 it is client source under
        # client/dedalo/core/ and the client location already covers it.
        location /dedalo/tools/ { proxy_pass http://dedalo_ts; }
    }
}
```

`TRUSTED_PROXY_HOPS` (default 1) must equal the number of proxies appending
X-Forwarded-For, or the login throttle keys on the wrong address.

**Where the client tree comes from.** On bare metal the `alias` above points at
the checkout's `client/dedalo/` — the tree the engine itself runs from, so client
and engine are one version by construction. The container stacks cannot do that:
the engine's tree lives inside its IMAGE, and a host bind of `./client` served the
CHECKOUT's client in front of a pulled engine of another version (a checkout at
A behind an image of B — and the client/engine wire is exact, so that is broken
pages, not a cosmetic skew). So in both shipped stacks the ENGINE PUBLISHES ITS
OWN CLIENT: with `DEDALO_CLIENT_PUBLISH_DIR` set (process env only; the stacks set
`/srv/dedalo/client`), every start mirrors the image's `client/` into
`<dir>/releases/<content id>/dedalo` (regular files and dirs only — a symlink is
never published, nginx would follow it; dirs 0750, files 0640, read by nginx
through gid 1000 like media), switches the relative symlink `<dir>/dedalo`
atomically, and prunes older releases; an unchanged id copies nothing
(`src/core/install/client_publish.ts`, gate `client_publish_native`). nginx mounts
the `client` volume read-only at the alias root, so `deploy/nginx*.conf` are the
same files bare metal uses. Every new engine container republishes BEFORE it
serves, so an image update or rollback moves the client with it. The volume is
derived — never back it up. The QNAP dev overlay deliberately re-mounts the live
`./client` instead: a development box serves live edits.

### 3.1 Media access control (the proxy enforces what the engine generates)

Full definition: **`engineering/MEDIA_PROTECTION.md`**. The operator-facing contract:

- The engine writes three files into the media root (at boot and at login,
  config-hash guarded): `.htaccess` (Apache), `dedalo_media_protection.nginx.conf`
  (nginx `server{}`), `dedalo_media_protection_map.nginx.conf` (nginx `http{}` —
  a `map` cannot live in `server{}`; **omit it and nginx refuses to start**, which
  is deliberate: a half-wired gate must never boot half-open).
- **nginx needs a reload on a mode change** (`nginx -t && nginx -s reload`); Apache's
  `.htaccess` applies immediately. The daily cookie rotation needs no reload — that
  is why the cookie NAME is fixed and only its value rotates.
- **Never proxy media through Bun.** The gate is one `stat()` in the web server so
  multi-GB files keep `sendfile`/Range and the `mp4` `?start=` clipping handler. A
  `Range` request must answer `206`; a `200` with a full body means something has been
  put in the byte path.
- `open_file_cache` off (or `_valid ≤ 2s`) on the media locations, or an unpublish
  will not take effect on the next request.
- **Apache**: the media vhost needs `AllowOverride All` (or at least `FileInfo Options`)
  and `mod_rewrite`, or the generated `.htaccess` is ignored — silently, and open.
- `MEDIA_DEV_ROUTE_ENABLED` must stay `false`: that route serves media from Bun with
  no per-record ACL and bypasses these rules entirely (MEDIA-04).

**Assistant streaming (`dd_mcp_api:agent_chat_stream`, WC-013):** the chat is
an SSE response that can run for minutes on hard questions (adaptive-thinking
turns). It sends `: ping` heartbeats every 15 s and `X-Accel-Buffering: no`,
so the nginx sketch above (proxy_buffering off + generous read timeout)
already covers it — a proxy that buffers or times out under ~30 s will stall
or kill the chat. The non-streaming `agent_chat` twin has no heartbeat; the
client prefers the stream action for exactly this reason.

## 4. Database pool + statement timeouts (S2-32, PERF-11)

Config keys (all in `../private/.env`; catalog `src/config/catalog/db.ts`,
read into `config.ops` in `src/config/config.ts`). `0` disables each bound:

| Key | Default | Recommended | Guidance |
|---|---|---|---|
| `DB_POOL_MAX` | 10 | 10 | Request-pool connections per PROCESS. |
| `DB_MAINTENANCE_POOL_MAX` | 2 | 2 | The separate MAINTENANCE pool per process (startup `statement_timeout` 0, `application_name` `dedalo_maintenance:<pid>:<boot nonce>`, built on first use, idle connections close after 30 s). |
| `DB_POOL_ACQUIRE_TIMEOUT_MS` | 0 | 30000 | How long a caller may QUEUE for a connection of either pool. Exhaustion answers the typed 503 `db.pool_exhausted` (retryable) instead of an indefinite hang. |
| `DB_STATEMENT_TIMEOUT_MS` | 0 | 60000 | The request pool's startup `statement_timeout` (WC-055). It is the ONLY bound on a search that cannot abort early — a deliberately-unindexed match (dd551 Data, `f_unaccent(…) ~* …`) reads the whole table, ~175 s on a 33 M-row activity log, and a client disconnecting does **not** cancel it. A fired ceiling answers the typed 503 `db.statement_timeout`. Maintenance does not run under it (below). |
| `DEDALO_SLOW_QUERY_MS` | 0 | 5000 | Warn-log statements slower than this — on EVERY lane: pooled, inside a transaction (the write path) and on a reserved connection. The line names the lane (OPS-13). |

**The on-by-default flip is pending** (PERF-11 C4): the three bounds ship at
`0` until every row of the census below marked PENDING enters the unbounded
scope — a ceiling that ships on while a boot store build or the retention
prune still runs under it would fail those every day on a large install. The
flip, its config-census leg and those wraps land in ONE commit.

**Connection budget.** Count PHYSICAL backends, not gate slots: the acquire
gates bound connections IN USE, and a Bun pool keeps an idle connection open
until its idle timeout. Each process may hold `DB_POOL_MAX +
2 × DB_MAINTENANCE_POOL_MAX + 2` connections to the matrix database
(`src/core/db/connection_budget.ts`, measured against `pg_stat_activity` by
`statement_ceiling_scope_native`): the request pool; BOTH maintenance pools —
the transactional one and its non-transactional twin
(`runWithoutStatementTimeout`, which the shutdown cancel must tell apart), which
share one slot gate but each keep up to `DB_MAINTENANCE_POOL_MAX` idle
connections for 30 s after an optimize run; and at most 2 short-lived dedicated
connections (a cancel, a transaction-status verdict), which take no pool slot.
Every engine process counts: the server, each diffusion runner (up to
`DEDALO_DIFFUSION_MAX_RUNNERS`), the RAG drain. All together must stay under
Postgres `max_connections` (typically 100). Defaults: 10 + 2 × 2 + 2 = 16 per
process; server + 2 runners = 48 → fine; server + 8 runners = 144 → NOT. The
vector store's own pool (a separate database on the same cluster, when it is
one) comes on top. `sql.reserve()` takes a gate slot until its `release()` —
nothing can exhaust a pool behind the gate.

All keys are live in `src/core/db/postgres.ts`: an acquire gate fronts EACH
pool so saturation is observable (`db_pool_waits` counter, `getPoolStats()` —
request pool plus `maintenance`) and bounded; `DEDALO_SLOW_QUERY_MS` is
evaluated in `src/core/db/query_tap.ts`, called from all three executor lanes.

**Maintenance runs unbounded, on its own pool** (`withUnboundedStatements`,
PERF-11). Before PERF-11 the ceiling could not be on by default: it is a
pool-wide GUC, and the only opt-out cleared it with a session `SET`/`RESET` on
a connection that went back to the pool — the WC-055 leak class. Now work that
is legitimately long DECLARES it with `withUnboundedStatements(work)`, and every
statement it issues — pooled, in a transaction it opens, on a connection it
reserves — runs on the maintenance pool, whose connections are BORN with
`statement_timeout = 0` (sent in the startup packet: it overrides `ALTER ROLE`
/ `ALTER DATABASE` defaults). No pooled connection's GUC is ever mutated, and a
session `SET`/`RESET`/`DISCARD` in ANY statement of a pooled or transaction-lane
text (`SELECT 1; SET statement_timeout = 0` included — the text is split by the
shared lexer `src/core/db/sql_lexer.ts`) — inside a `DO` body too (read raw,
`EXECUTE 'SET …'` included) — or a `set_config` that is not provably
transaction-local (only a literal `true` third argument is: `false`, an
expression, a bound `$3` are refused), is REFUSED (`internal.invariant`) before
it is sent. So is TRANSACTION CONTROL (`BEGIN`, `START TRANSACTION`, `COMMIT`,
`END`, `ROLLBACK` — never `ROLLBACK TO` —, `ABORT`, `PREPARE TRANSACTION`): a
`COMMIT` would end a caller's unit mid-way, a `BEGIN` would hand the next caller
a pooled connection inside someone else's transaction. Residual blind spot:
dynamic SQL a FUNCTION (not a `DO` body) EXECUTEs. Every Bun `sql` member that takes a connection outside
these doors (`begin`, `transaction`, `savepoint`, `file`, `listen`, `close`, …)
is refused too: `withTransaction`, `sql.reserve()` and `closeDatabasePool` are
the doors. The scope expires when it returns (a leaked timer falls back to the
bounded pool), a detached job never inherits it, and entering it inside a
request-pool transaction is refused (enter it before BEGIN) — keyed on the
transaction's pool, not on `DB_STATEMENT_TIMEOUT_MS`, so it is refused under a
configured 0 too (only an explicit `SET LOCAL statement_timeout = 0` in force
makes such a transaction joinable).

**Shutdown** (`closeDatabasePool`) closes the maintenance pool FIRST and
BOUNDED: it cancels this process's running maintenance statements (by its
per-boot `application_name` AND this database AND this role — pg_stat_activity
is cluster-wide and every container engine or one-off CLI is PID 1, so a pid
alone would reach another install's migration on a shared cluster — on a
short-lived DEDICATED connection — neither pool, which may both be saturated —
≤ 2 s), closes the maintenance pool with a 5 s timeout,
then the request pool. A stopped data update's cancel takes the same dedicated
connection (so does its verdict read, `pg_xact_status`: a released maintenance
slot goes straight to the next queued maintenance waiter), and a run still
waiting for its maintenance slot leaves the queue at once.
An unbounded statement therefore can neither hang the shutdown nor survive it
holding its locks (a cancelled data update rolls back; the rerun is the resume).
The one exception is deliberate: `runWithoutStatementTimeout`'s WEAK-LOCK
statements (REINDEX / CREATE / DROP INDEX CONCURRENTLY, plain VACUUM / ANALYZE —
`nonTransactionalLockClass`) run on a NON-TRANSACTIONAL
twin of the maintenance pool — same gate, its own `application_name`
(`dedalo_maintenance:nontx:<pid>:<nonce>`) — which the shutdown never cancels:
a cancelled CONCURRENTLY build is not rolled back, it leaves an INVALID
`<index>_ccnew` that every write keeps maintaining and a later `REINDEX TABLE
CONCURRENTLY` skips. The bounded close drops the client and the server finishes
the statement (its locks never block reads or writes). An interruption the
engine cannot prevent (an operator's cancel, a crash, `client_connection_check_interval`)
is cleaned by `database_info.optimize_tables`, which first drops the optimized
tables' invalid `_ccnew`/`_ccold` leftovers (never under a build in progress).

The maintenance pool is small by design (2), so the widget door routes only
the actions a widget DECLARES maintenance (`unboundedActions`) there; every
other admin action — a read, a setting, a budgeted scan — stays on the request
pool and never queues behind a long one. Two long actions at once (a
background data update and a REINDEX) make a THIRD long action queue — for
`DB_POOL_ACQUIRE_TIMEOUT_MS`, then `db.pool_exhausted`. Raise
`DB_MAINTENANCE_POOL_MAX` on an install whose operators run maintenance in
parallel (and count it in the budget).

**The ceiling is lifted; the lock-wait bound is not.** The transactional
maintenance pool is born with `lock_timeout = 5s` (startup packet,
`MAINTENANCE_LOCK_TIMEOUT` in `src/core/db/postgres.ts` — also the data-update
unit's default `SET LOCAL lock_timeout`). PostgreSQL grants locks in queue
order, so a declared action waiting for ACCESS EXCLUSIVE (a store rebuild's
TRUNCATE, an ALTER, a `LOCK TABLE`) behind a long reader would otherwise hold
EVERY later reader of that table queued behind it for as long as the long
reader runs. Bounded, the waiter gives up after 5 s (SQLSTATE 55P03, its
transaction rolls back — nothing of THAT transaction persists; units the action
committed before it stand) and the readers proceed. Only
the WAIT is bounded: a granted lock is held for the work's whole span (a
backfill still blocks its store while it rebuilds it). A widget action does not
retry — it is not guaranteed to be one re-runnable unit: a 55P03 that escapes
the action is the typed, retryable 503 `db.lock_timeout` ("try again in a
moment"); one the action catches itself (the backfill's per-store line) is
reported in its `errors`. The data-update engine retries its whole unit
(1s/2s/4s/8s), and so does each executed `move_*` definition file: a file is ONE
`withMaintenanceTransaction` unit (`src/core/update/transform/engine.ts`
runDefinitionFile), so a lock wait — or any failure — rolls that file back whole
instead of committing its first tables under the new tipo (a section split
between two tipos, a half-applied locator move); a file that still fails is
named in `errors` with what its OWN transaction did — `pg_xact_status` of its xid
(`postgres.ts outcomeOfFailedUnit`, the data-update engine's classifier), since a
failure during COMMIT may have committed it: rolled back, COMMITTED (its deltas
counted), or "outcome UNKNOWN" (the run stops; a locator move is not idempotent,
so a re-run on a guessed rollback would move it twice); a transaction that ended
mid-unit is PARTIALLY applied and stops the run too. Only committed files'
deltas are counted.
Because a file holds the row locks it rewrote until its COMMIT, an EXECUTE is
never inline: it is a maintenance-lane job with NO deadline (`deadlineMs: 0`,
the data update's reason) whose signal — the operator's stop, a shutdown —
cancels the running statement and rolls that file back; later files are reported
"not run". It is SINGLE-FLIGHT: a second execute is refused (`resource.conflict`)
before a job exists, and each file's unit takes the advisory try-lock
`TRANSFORM_RUN_LOCK_KEY` (7_020_926_003), so a run from another process is
refused at once instead of queueing behind the first run's row locks. Gate:
`test/unit/transform_run_native.test.ts`. The NON-TRANSACTIONAL lane keeps no bound,
and only the weak-lock class runs on it (CONCURRENTLY, plain VACUUM / ANALYZE —
SHARE UPDATE EXCLUSIVE, which no reader or writer conflicts with, queued or
granted; an aborted concurrent build would leave an invalid index). Every OTHER
statement `runWithoutStatementTimeout` is handed — the db-assets recreate's
`ar_maintenance` `REINDEX TABLE matrix_dd` (SHARE: blocks writers) and `VACUUM
FULL … matrix_dd` (ACCESS EXCLUSIVE: blocks everything) — is STRONG: it runs on
the transactional maintenance pool as an autocommit statement, under the same
bound, retried after 1s/2s/4s/8s (no lock is queued during a delay), and escapes
as `db.lock_timeout`; the classifier is an allowlist of the weak forms, so an
unrecognised statement is bounded. Gates: `test/unit/maintenance_door_unbounded_native.test.ts`
(a later reader gets through while the long reader still holds; the escaping
wait is `db.lock_timeout`) and `test/unit/maintenance_nontx_lock_bound_native.test.ts`
(VACUUM FULL behind a long reader, REINDEX TABLE behind a writer, the weak forms
still unbounded, the routing by `application_name`).

Census of the legitimately long statements (who is unbounded, and how):

| Lane | Handling |
|---|---|
| Maintenance-area ACTIONS a widget declares maintenance (`unboundedActions`: every database_info action — VACUUM/ANALYZE, REINDEX, the store rebuilds and backfill, the relation-index report, consolidate, user stats —, every `move_*` transform — the inline dry run; an execute is a stoppable, single-flight maintenance job, one atomic, lock-retried unit per definition file —, update_ontology, the dd_ontology recovery build/restore, add_hierarchy install/reset — one psql unit per thesaurus that sets its own lock bound (see the psql row) —, export_hierarchy, reconcile_status run) | The widget door wraps THOSE handlers in the scope; every other action and every panel load stays bounded. `dataframe_control` is not maintenance: each batch runs under `SET LOCAL statement_timeout` = what is left of its per-table/total budgets (WC-071/072), never above the pool ceiling. |
| `runWithoutStatementTimeout` (REINDEX/VACUUM/DROP INDEX CONCURRENTLY) | By lock class: the WEAK forms (CONCURRENTLY, plain VACUUM / ANALYZE) on the non-transactional maintenance lane (same gate, no lock bound, never cancelled by shutdown — see above); every other statement (`REINDEX TABLE`, `VACUUM FULL`) on the maintenance pool under `MAINTENANCE_LOCK_TIMEOUT`, retried, typed `db.lock_timeout` on escape. Refused inside a transaction. |
| Data-update engine (`src/core/update/engine.ts`) | Its own atomic unit: `withMaintenanceTransaction` (one transaction, `SET LOCAL lock_timeout` + `SET LOCAL statement_timeout = 0`, whole-unit retry on 55P03 — each discarded attempt logged to update.log — abort cancels the running statement). The background job has NO deadline (`deadlineMs: 0`, overriding the maintenance lane's 6 h): a clock that fired mid-run would roll the whole unit back, every time. The verdict of record is the `matrix_updates` version row (it commits with the steps); update.log is advisory: a `BEGIN atomic run … [xact <xid>]` line per attempt that won the single-flight claim (a refused one writes only `REFUSED [xact <xid>] (…)`) and an fsynced `COMMITTED <version> [xact <xid>]` line after the COMMIT succeeded, but a failed log write (full or read-only private dir) only reaches the server log and never changes the verdict — and a crash between COMMIT and that line leaves a committed run without it, so read `matrix_updates` when in doubt. A statement cancelled from outside (a shutdown, an operator) is reported as an interruption, never as the step's SQL failing. A failure the engine did not raise itself (a connection lost during COMMIT) is classified by `pg_xact_status` of the run's own transaction (read on a dedicated connection, ≤ 2 s per read) — committed, rolled back, or "outcome unknown" — never by re-reading the version. Once a run is aborted, no further statement of it is sent. No step can end the unit: transaction control is refused before it is sent; should the between-steps checkpoint ever see the transaction id change anyway, the run is reported `PARTIAL` (what ran before persisted, the version is not stamped) — never "rolled back". Known limit: `lock_timeout` bounds EVERY lock wait, row locks too — a long migration that meets a row lock held > 5 s is retried whole (maintenance mode excludes ordinary editors; a background import or runner started before it does not). |
| Boot migrations (`install/db/migrate.ts`) | Already `SET LOCAL statement_timeout = 0` per file (the recorder sees it); the ONLINE lane uses a reserved connection with a session 0 it RESETs. |
| `db_assets` store builds at boot (`ensureSearchStores` → one whole-table `INSERT … SELECT` backfill per matrix table; `rebuildIndexes` & co.) / `test:db:setup` / `migrate_section_id_locators`; `observer_reconcile` CLI | To enter the scope at the source (the `db_assets` builders, `reconcileObserverMirrors`). PENDING — until then they run under the ceiling, so the default flip ships together with those wraps. |
| Retention scheduler (`src/core/retention/scheduler.ts`, after boot then daily, from a bare timer): `pruneMatrixEventRowsByAge` on `matrix_activity` (an unbatched `count(*)` + one `DELETE … RETURNING`) and the dd1758 ledger prune | PENDING — enter the scope at the retention pass entry, or batch the prune (`DELETE … WHERE id IN (SELECT … LIMIT n)`, each batch well under the ceiling). Under a ceiling an all-or-nothing DELETE over a 33 M-row log rolls back every day and never makes progress. |
| Diffusion runners | Stay bounded (their containers already run at 60 s); measured separately. |
| `psql` / `pg_restore` / `pg_dump` children | Never receive the startup GUC. The hierarchy import/reset unit (`src/core/install/hierarchy_import.ts`) bounds itself: after `BEGIN`, `SET LOCAL lock_timeout` = `HIERARCHY_UNIT_LOCK_TIMEOUT` (pinned equal to `MAINTENANCE_LOCK_TIMEOUT` by `hierarchy_import_lock_bound_native`) + `SET LOCAL statement_timeout = 0`; a 55P03 rolls the unit back and it is retried WHOLE (1/2/4/8 s, abortable); an `installHierarchies` `signal` kills it at once and its outcome is READ by `pg_xact_status` (committed / rolled back / unknown), never assumed. No caller passes a signal yet (add_hierarchy is not a stoppable job). |
| Request traffic, and requests waiting behind a maintenance lock | Bounded — a typed 503 by design. Two request paths carry their OWN budget under the pool ceiling, so they stay bounded even at its default 0: the `relation_targets` census (one 30 s whole-census deadline) and every search statement a `referenced_by` leaf rendered into (30 s per statement, wherever it runs — all search statements go through the ONE executor `src/core/search/search_statement.ts`, inside a caller's transaction too; the export selection cursor arms it as its `transaction_timeout`) — see WC-2026-10-30-search-referenced-by-leaf. |

**The typed failures.** A 57014 is mapped to `db.statement_timeout` only when
it IS the ceiling: the lane's ceiling is known and positive and the statement
ran at least that long. A transaction's ceiling starts at its pool's and
follows a recorded `SET LOCAL statement_timeout` (an unparseable change makes
it unknown — never mapped); a `ROLLBACK TO SAVEPOINT` restores the ceiling the
savepoint was taken under, as Postgres restores the setting. An operator's `pg_cancel_backend`, the update
engine's abort cancel, a cancel that lands before the ceiling, and anything on
a reserved connection stay raw (`install/db/migrate.ts` reads the raw errno).

Raise `DB_STATEMENT_TIMEOUT_MS` if a legitimate REQUEST-path operation on your
install (a large export) exceeds it; measure first with `DEDALO_SLOW_QUERY_MS`.

## 5. Observability (S2-37)

- **Access log**: `DEDALO_ACCESS_LOG=true` → one JSON line per API request on
  stdout: `{ts, type:'access', request_id, user_id, api:'class::action',
  status, ms}`. journald captures it (`journalctl -u dedalo-ts -o cat | jq`).
- **Slow requests**: `DEDALO_SLOW_REQUEST_MS` (default 5000) warn-logs slower
  handlers regardless of the access-log flag.
- **Counters endpoint**: `GET /api/v1/counters` — session-gated,
  **global-admin only** (404 otherwise). Aggregates request totals/latency,
  slow-request and pool-wait counters, diffusion queue depths + scheduler
  state, media job headroom, background tool job stats, RSS, uptime.
- **`observers_big_result_refused`** — the PHP-parity >2000-reference freeze
  (set_dato_external computes but refuses the persist above 2000 referencers).
  EXPECTED to tick steadily, not an incident signal: targets permanently above
  the threshold (this install: `cult1/5` 4,547 refs; `numisdata224/13787`
  3,078; `numisdata224/13108` 2,874) re-compute and re-refuse on EVERY save
  touching them once drifted — PHP behaved identically, and neither the
  cascade nor `observer_reconcile --apply` can converge them by design. A
  climbing counter on OTHER targets is worth a look;
  `scripts/observer_reconcile.ts` (dry run) names the frozen records. Note
  the COST shape: the freeze withholds only the persist — a frozen target
  still pays the full uncapped closure walk + inverse search under its row
  lock on EVERY save touching it, forever (it can never converge). Beyond
  this counter, the only signal for that cost is
  `observers_recompute_lock_slow`; if it ticks steadily alongside a frozen
  hot term, that term is your contention source.
- **Observer cascade — ALWAYS ON** (D1 relay + D2 bounded dispatch,
  `WC-2026-08-02-observer-cascade-bounded-flag`). A saved component's
  declared observer edges fire transitively (relay hops AND
  recompute-triggered re-propagation), bounded by a shared visited set and a
  depth budget of 8 hops. There is no config switch: the mirrors are STORED
  relation data declared by the ontology, so gating them would make two
  identical installs store different values (the `DEDALO_OBSERVER_CASCADE`
  rollout flag was retired 2026-08-02 once the benchmark cleared the cascade
  — typical external hop p50 1.3 ms / p90 3.1 ms, worst real case 22 ms,
  measured graph depth ≤ 2 with zero cycles). Watch the cascade counters:
  `observers_cascade_cycle_refused` / `observers_cascade_depth_exceeded` /
  `observers_cascade_hop_failed` / `observers_cascade_hop_dropped` should
  STAY at zero — any tick names its chain in the log and means a TRUE cyclic
  observe graph (the node repeats on its own chain), an over-deep graph, a
  failing hop, or (hop_dropped) a leaked continuation that lost its commit
  lane — not normal operation. `observers_cascade_converged_skipped` is the
  BENIGN sibling: the same observer reached through two branches of one
  cascade (a converged diamond) is dispatched once and the second arrival
  skipped — expected on diamond-shaped ontologies, NOT a cycle; only the
  cycle counter indicates one. `observers_recompute_lock_slow` ticks when a
  recompute held its target row lock >2s (the D3 closure + uncapped search
  run under the lock) — steady ticks mean editor-visible contention on hot
  terms. `observers_propagation_failed` counts every propagation or
  covered-slot recompute that failed — propagation NEVER runs inside a
  transaction any more (CLOSURE_PLAN Step 2: every record write enqueues its
  observed change on the obligation ledger, which drains AFTER COMMIT —
  `WC-2026-09-30-record-write-obligation-ledger`), so it covers the
  interactive save, the restore / undelete / bulk-revert doors, a CSV-import
  row (drained after that row commits; the failure no longer undoes the row)
  and the ledger drain itself. A failure there is swallowed by design (a
  post-commit side effect must never fail the write), so this counter is
  the only ops-visible signal that a STORED, searchable mirror was left
  stale; the log line names the observed tipo and record, and
  `scripts/observer_reconcile.ts` repairs the drift. It should stay at zero;
  the residual deadlock window documented in `observers.ts` lands here. (The
  former `observers_propagation_failed_in_tx` sibling is retired with the
  in-transaction rethrow lane.) `observers_resave_failed` counts a relay /
  order-derived edge's re-save through the save rules (a declared-order host
  re-sorted after a linked record's ordering value changed) that THREW for one
  target — isolated per target, so the hop, the other targets and the save's
  later subscriptions still run; the log line names the observer and the
  record, and the order left stale is drift the `portal_declared_order`
  reconcile lists. It should stay at zero. `observers_index_repaired` ticks when the
  observer RECONCILE finds an `_hi` mirror whose value is already right but
  whose ancestor index (`relation_search`) disagreed, and rewrites it
  unstamped — legacy rows written before the recompute indexed its mirror;
  it should fall to zero after one reconcile pass.
  `duplicate_media_incomplete` ticks when a duplicated record's media copy
  did not complete (no media root, a walk or copy failure, a failed rescan,
  fewer files copied than the source's index claimed): the duplicate is still
  created, its file index names only the files it really has, and a
  `media.operation_failed` log line carries the coordinates and the stage.
  Cascade hops always run
  post-COMMIT (a rolled-back import fires nothing) and the relay writes
  nothing (`WC-2026-08-02-observer-relay-writes-nothing`).
  **Discovery is observer-declared** (subscription registry,
  `WC-2026-08-02-observer-subscription-registry-activation`): an edge
  dispatches iff the OBSERVER's `properties.observe` entry carries a
  `server` block — a reverse-only declaration alone is enough (the
  subscriber registers itself). The forward `properties.observers` array is
  legacy, consulted only to scope `'all'` wildcards and to target
  reused-component hosts. The registry is built once per ontology state
  (warmed at boot, hub-invalidated on any dd_ontology write); the boot
  probe loud-logs contract violations (dead forward specs, dead wildcards,
  unresolved SQO hosts, cycles) and the `observers_registry` gauge +
  `observers_registry_contract_violations` counter expose them on
  /api/v1/counters. `observers_host_section_unresolved` counts SQO
  recomputes refused because no host section resolved (observe-entry scope
  → forward spec → the observer's own section, virtual↔real-aware) —
  should stay 0; a tick names the edge whose observe entry needs a
  `section_tipo`.
  **Incident playbook — a runaway or buggy EDGE**: there is no global
  switch, and that is deliberate; the kill switch is PER-EDGE and lives in
  the source of truth. Disable the offending edge in `dd_ontology` — blank
  the observer node's `properties.observe` entry's `server` key — and the
  edge stops firing engine-wide once the ontology cache invalidates.
  (Removing the observed node's `properties.observers` declaration is NOT a
  kill switch any more: the reverse declaration alone dispatches; it only
  stops wildcard-matched edges.) That is an ontology EDIT, not a config
  override: the engine keeps doing exactly what the ontology declares. Heal any
  drift afterwards with `scripts/observer_reconcile.ts` — run it as a CENSUS
  first (`--json` for per-record causes, `--budget` to adjudicate the drop
  volume against `engineering/observer_shrink_budget.json` with a non-zero
  exit), then `--apply`. Since 2026-08-06 the recompute writes the FULL law
  including drops (`WC-2026-08-06-observer-grow-only-failsafe-retired`), so
  the budget gate is the standing protection against a value-law change that
  would mass-delete. Every live observer write is preceded by a
  `matrix_time_machine` row, so per-record restore exists for a hop that
  wrote wrong values. Blast radius is structurally capped meanwhile: hops
  cannot hang (visited set + depth budget), cannot fire on ROLLBACK, the
  relay writes nothing, and a recompute whose own seed could not be built
  withholds its drops (`observers_shrink_refused_degraded_seed` — the log
  names the ontology node to fix).
  **Bulk-import throughput**: the commit lane drains synchronously in the
  importing request after COMMIT, so imports pay the cascade per row —
  ~2.7 s of observer work per 1,000 saved rows at the measured p50 (data-
  dependent). Bulk doors that skip propagation entirely (tool_propagate,
  delete_data wipe, portalize) rely on the reconciler afterwards. A
  mid-import kill leaves mirrors partially recomputed, not corrupt: each
  recompute is a single locked, TM-audited write of a value derived from
  committed truth, and the reconciler converges whatever the kill missed.
- **`diffusion_queue_streams_opened` / `_closed` (WC-067)** — the leak alarm for
  the maintenance widget's live queue feed. Each open `follow_queue` SSE stream
  runs a 1 s poll loop for as long as an admin has the panel open, so the two
  must CONVERGE shortly after the last panel is closed. A persistent and growing
  gap means poll loops are outliving their clients, and is the signal to look
  (a browser tab that never sent a FIN, a proxy holding the connection). It is
  a real gauge rather than a test because nothing in-process can assert that a
  dropped socket fires `cancel()`; the stream's unconditional 15 s heartbeat and
  its 15-minute hard lifetime exist to bound the damage either way, so a gap
  should also self-heal within ~15 min.
- **Table-statistics health (WC-073)** — the Database-info panel computes a
  `statistics` verdict and shows a warning when it reads `degraded`. Two
  signals: tables ≥64 MB with `last_analyze` AND `last_autoanalyze` NULL, and
  the RESET signature `reltuples >= 1000 AND n_live_tup*100 < reltuples` (the
  planner believing in a big table while the cumulative counters believe it is
  empty). **Why it is worth a gauge:** a stats-collector reset — a crash
  restart, or a restore into a fresh cluster — wipes the cumulative counters
  while `pg_statistic` survives, and `autovacuum`/`autoanalyze` trigger on
  `n_mod_since_analyze` / `n_dead_tup`, which then restart from zero. So
  autovacuum reads `on` and every query still answers while a large table stops
  being maintained. Note the mechanism precisely: autovacuum's arithmetic is
  INTACT — autoanalyze fires at `n_mod_since_analyze >= 50 + 0.1 * reltuples`
  and `reltuples` survived, so the threshold stays correctly sized while the
  counter restarts at 0. Recovery is therefore churn-proportional: small hot
  tables self-heal within hours, a 51 M-row table needs ~5.1 M modifications
  first, which in practice means never. It is not "never" by mechanism.
  Found by accident on 2026-07-29 (38 of 43 tables on the scale DB,
  `matrix_time_machine` reporting 91 live rows against a real 50,993,786; on
  2026-07-30 all 11 v7 databases on the local cluster proved affected, i.e. the
  cause is cluster-wide, not per-database).
- **Repairing it.** Press **"Repair table statistics"** in the Database-info
  panel (`analyze_statistics`, WC-074) — plain `ANALYZE` scoped to the tables the
  verdict named. **Not** "Analyze database" (`analyze_db`), which runs
  whole-database `VACUUM ANALYZE`: reclaiming space is a different job and its
  cost is page-proportional. Plain `ANALYZE` samples a bounded page count, so it
  is near-flat in table size — measured 2026-07-30 on this cluster: ~60 s for a
  141 GB database, 20 s for ~5 GB, 8 s for 912 MB, 4 s for 68 MB. Treat that as
  an order of magnitude, not a budget (at least one local install carries manual
  `SET STATISTICS` tuning that inflates it). Cluster-wide, `ANALYZE;` per
  database from psql is the equivalent — the engine's pool is bound to ONE
  database, so the widget can only ever repair the active one.
- **Check it after any restore, crash recovery, PITR, clone or cluster move** —
  those are the events that produce it, and a `pg_dump`/restore-test (§6) is
  routine here. There is deliberately no scheduler: once the counters are
  correct, autoanalyze maintains statistics by itself, so a periodic engine-side
  ANALYZE would duplicate a correctly-configured mechanism with a worse trigger.
- **Error correlation**: every handler exception logs server-side with its
  `request_id`; the client receives the id, never the exception text.

## 6. Backups (S2-35)

The **backup set is five stores** — the matrix DB alone is not a backup:

1. **Matrix Postgres DB** — the make_backup widget (or `pg_dump -F c -b`).
   The TS server threads `PGPASSWORD` from `DB_PASSWORD` and surfaces the
   pg_dump log tail on failure. pg_dump writes `<name>.custom.backup.part`
   (claimed atomically; a second claimant of the same name skips), so a running
   dump is never listed or counted (OPS-2). Two doors give a part the
   `*.backup` name, never over an existing file, and they prove different
   things:
   - **the dump's own promotion** — pg_dump **exited 0**, then a full
     `pg_restore -f /dev/null` read: proven → `<name>.verified` sidecar →
     rename → directory fsync. When the read could not LOOK or could not
     FINISH for a reason that is not the bytes' (no pg_restore on the host, it
     outran its budget, it was killed from outside, an I/O error, a pg_restore
     older than the archive) the dump is still named, **without a sidecar**:
     "completed, not verified" — exit 0 proves completion, not readability,
     and every later freshness ask reads it again. Only a DISPROOF (empty, not
     an archive, truncated) retires an exit-0 dump;
   - **orphan adoption** — a `.part` older than 24 h (the orphan of a server
     that restarted mid-dump, whose exit status nobody saw) is **adopted, never
     deleted**: the next dump (and the nightly script) reads it end to end and
     names it only when that read PROVES it (with its sidecar); a read that
     DISPROVES it (or a proven one whose name is taken) keeps it aside as
     `<name>.orphaned`; a read that failed for a host reason leaves it in
     place for the next pass. An EMPTY orphan is left in place (a dump queued
     behind a table lock writes nothing yet).

   So a `*.backup` of ours is either proven (sidecar present) or a dump that
   exited 0 and has not been read back yet — never one known to have failed.
   The dump runs as a `maintenance`-lane job (kind `backup`, no deadline): its
   status record is live until the verdict is written, a user stop kills the
   dump, a server shutdown does not. Every failure is kept as `<name>.failed`
   (then `.failed.1`, … — an earlier failure is never overwritten; an empty
   one is deleted). A `*.custom.backup` without the archive header is not a
   backup (only other names degrade to "foreign format, counted unproven").
   **A backup counts only when that full read proves it** (OPS-1), and only
   the archive's own bytes can DISPROVE it: a read killed from outside, an I/O
   error on the backup storage or a pg_restore older than the archive is
   `unverifiable_read_failed` — not counted, never cached, read again next
   time. A `.verified` sidecar is trusted only when this classifier wrote it
   (`classifier: 2`): a disproof an older engine cached for a host failure is
   read again once, never trusted forever. The code-update precondition and the update panel ask the same deep
   verdict (async, single-flight, one read at a time, cached per artifact,
   at most 3 candidates; the panel says `verifying` rather than wait, and
   starts no read for a non-superuser — who cannot update anyway). A read
   that outruns its budget — `max(60 s, DEDALO_BACKUP_VERIFY_SECONDS_PER_GB`
   (default 60) `× started GiB)` — proves nothing, so the update REFUSES and
   names that key: raise it on slow backup storage (the budget is capped at
   2^31-1 ms, what a timer can hold). Default dir:
   `<private>/backups/db` (`DEDALO_BACKUP_DIR` overrides).
2. **RAG pgvector DB** (`DEDALO_RAG_*`) — separate database, separate dump.
3. **Media originals** (`MEDIA_PATH`) — the `original` quality is the source
   of truth every derivative rebuilds from; derivatives need no backup.
4. **`../private/`** — `.env` secrets, session store, `ts_state.json`.
5. **Every site-builder INSTANCE on this host** — per instance: its
   declaration and `secrets/`, its workspaces root (`SITES_ROOT`: every site's
   source and full git history), each site's whole webspace (**both** release
   stores, `.releases/pre` and `.releases/web`, **and** the two served
   symlinks), and its audit trail (`AUDIT_DIR`). Nothing GENERATED is copied:
   the unit, the vhosts, the rendered env and `sites.json` are functions of the
   declaration and `provision apply` rewrites them all. See
   `engineering/SITE_BUILDER_INSTANCES.md`. A host that declares no instance
   has an empty store 5 and that is not a failure.

`deploy/dedalo-backup.service` + `.timer` is the reference nightly job; it
pulls in `deploy/dedalo-backup-site-builder.service` (store 5) and is ordered
before it. Each store above names the token that copies it in one of the two
reference units, and `test/unit/operator_commands_tripwire.test.ts` asserts the
two agree — a store documented here and copied by nothing is the failure this
table exists to make impossible:

| # | Store | What copies it in the two reference units |
|---|---|---|
| 1 | Matrix Postgres DB | `pg_dump` |
| 2 | RAG pgvector DB | `DEDALO_RAG_DB_NAME` |
| 3 | Media originals | `MEDIA_PATH` |
| 4 | `../private/` | `INSTANCE_DIR/private/` |
| 5 | Site-builder instances | `dedalo-site-builder-backup.sh` |

Store 5 runs as **root** while the other four stay unprivileged. It has to: an instance's
credentials are `0600 root:root` inside a `0700` directory and its state roots are `0750`
owned by that museum's own service user, and the backup user is in none of those groups —
that separation is the isolation itself. So it is **its own unit**,
`dedalo-backup-site-builder.service`, never a `+` line in the set (2026-10-12): systemd
applies a unit's `EnvironmentFile=` to `+` lines too, and the set reads
`INSTANCE_DIR/private/.env`, which `DEDALO_USER` writes — its `LD_PRELOAD` or `PATH` would
run as root. The root unit has no `EnvironmentFile=`, runs both scripts from the root-owned
`ROOT_BIN_DIR` (outside the instance dir — §2.2), and keeps its verdict (`/var/lib/dedalo/backup-site-builder`) and its
destination (`/var/backups/dedalo-site-builder`, created `0700 root:root` under the unit's
`UMask=0077`) outside every tree `DEDALO_USER` owns. The destination holds credentials:
treat the whole backup tree as secret material, which store 4 already made true. The
failure alarm (`dedalo-backup-alert@.service`) runs as `DEDALO_USER` (journal access through
`systemd-journal`), also from `ROOT_BIN_DIR`. Leg E2 of
`test/unit/operator_commands_tripwire.test.ts` holds every shipped unit, RENDERED for three
layouts, to this: no root line beside an `EnvironmentFile=`, nothing run as root from outside
`ROOT_BIN_DIR` (or a system binary), nothing root executes inside the instance dir, no root write into a tree `DEDALO_USER` owns, no root line naming such a tree
except the read-only watchdog, and no root-run rollback or watchdog without a pinned
`--backup-root`. The rollback unit (`dedalo-ts-rollback.service`) therefore does its file work
as `DEDALO_USER` and only its fixed `systemctl` restart as root (`ExecStartPost=+`), like the
installer's `dedalo-ts-rollback@.service`.

MariaDB **diffusion targets are derived data** — rebuildable by re-publishing;
no dump surface exists (DIFFUSION_SPEC §8.6). Restore-test quarterly.

**Each unit declares which stores it promises.** `dedalo-backup.service` (and the
root unit, for its one store) carries
`Environment=DEDALO_BACKUP_EXPECTED_STORES=` naming every ACTIVE step, and
`dedalo-backup-step.sh`'s aggregate fails the run when an expected store recorded
no status. Without it the aggregate can only see the stores that DID record, so a
step whose `ExecStart` never ran at all — a typo, a missing script, a store
commented out by mistake — is invisible and a run that copied three stores of
five reports "every store succeeded". **Uncommenting store 2 means adding
`rag_db` to that list in the same edit**; the tripwire holds the declaration and
the active steps equal, so a drift between them is a red gate rather than a
backup nobody knows is short.

### 6.1 Restore order

Restore in dependency order — each step needs the one before it, and step 5
cannot even be attempted before step 1:

1. **`../private/`** (store 4). It carries the `.env` every other step reads —
   the DB credentials, `MEDIA_PATH`, and the `DEDALO_SITE_BUILDER_*` pairing
   lines. Restoring it last means restoring everything else blind.
2. **Matrix Postgres DB** (store 1) — **the engine's restore door**
   (`src/core/area_maintenance/restore_door.ts`, CLI `bun scripts/restore.ts`;
   gate `test/unit/restore_door_native.test.ts`). Stop the engine, run the
   door, read its report:

   ```bash
   # 1. Nothing may write while you restore. Stop the engine AND the watchdog
   #    timer, which would otherwise restart it under you (§2). The door
   #    REFUSES while any client backend holds the database — it cannot stop a
   #    service it does not see, so this step is yours.
   systemctl stop dedalo-ts.service dedalo-ts-watchdog.timer

   # 2. The door. Exit 0 = restored and nothing held; 2 = restored, reconcile
   #    verdicts HELD for your decision (read them); 1 = refused or failed, and
   #    the database is exactly as it was.
   cd /opt/dedalo/app/master_dedalo     # <instance dir>/master_dedalo (§2.2)
   bun scripts/restore.ts /opt/dedalo/app/private/backups/db/2026-08-29_033000.dedalo.custom.backup
   ```

   What the door does, in order — each phase gates the next, and the shell
   recipe below is what it runs, kept here so the procedure is readable
   without the code:

   1. **Proves the artifact with a FULL READ.** NOT `--list`: the table of
      contents sits at the FRONT of a custom archive, so a dump cut in half
      lists perfectly and exits 0. Measured 2026-08-30 on a real 7.6 MB dump
      truncated to 60%: `pg_restore --list` → exit 0; `pg_restore -f /dev/null`
      → exit 1 ("could not read from input file: end of file"). Anything short
      of `verified_deep` is `recovery.artifact_unusable`, before any statement
      reaches Postgres. ~7.4 s/GB.
   2. **Requires ZERO client backends** on the target (`pg_stat_activity`), else
      `recovery.writers_active` naming pid and application. Then stamps
      `maintenance_mode: true` in `ts_state.json`, so an engine started before
      you have read the report boots refusing non-superusers.
   3. **Restores into a SIDECAR** `<db>_restoring_<stamp>`, created empty from
      `template0`, with `--single-transaction --exit-on-error --no-owner
      --no-privileges`, and ACTS on the exit status. `pg_restore` continues
      past errors by default: a run that reports nothing but leaves a table
      whose `COPY` failed keeps that table's OLD rows beside restored
      neighbours, and the result looks exactly like a successful restore from
      every angle an operator has. A non-zero exit DROPS the sidecar
      (`recovery.restore_failed`); the target was never touched.
   4. **Swaps by rename**: target → `<db>_pre_restore_<stamp>` (KEPT — a full
      second copy on the same volume, yours to drop once the restore is
      accepted, or `--drop-previous` at the door), sidecar → target. Two
      `ALTER DATABASE … RENAME`, both needing the zero connections phase 2
      guaranteed. This is why the door does not `dropdb` first: an emptied
      target plus a failed restore leaves NOTHING, a sidecar leaves everything.
   5. **Runs the post-restore reconcile plan** (§6.5, `POST_RESTORE_PLAN`) and
      writes the journal `<DEDALO_BACKUP_DIR>/restores/<stamp>.json`.

   ```bash
   # The equivalent by hand (what the door runs), for a host without bun:
   pg_restore -f /dev/null "$ARTIFACT" || { echo "NOT A USABLE DUMP"; exit 1; }
   createdb -T template0 -O "$DB_USER" "${DB_NAME}_restoring"
   pg_restore --dbname "${DB_NAME}_restoring" --no-owner --no-privileges \
              --single-transaction --exit-on-error "$ARTIFACT" \
     || { dropdb "${DB_NAME}_restoring"; echo "RESTORE FAILED - $DB_NAME untouched"; exit 1; }
   psql -d postgres -c "ALTER DATABASE \"$DB_NAME\" RENAME TO \"${DB_NAME}_pre_restore\"" \
                    -c "ALTER DATABASE \"${DB_NAME}_restoring\" RENAME TO \"$DB_NAME\""
   ```

   `--single-transaction` makes the restore atomic — it lands completely or
   the sidecar stays empty — and already implies `--exit-on-error`; both are
   written so the intent survives somebody dropping one. The price is that it
   cannot be combined with a parallel restore (`-j`); the sidecar design is
   what makes that price cheap: nothing can reach the sidecar while it fills.
   The role needs `CREATEDB` (`ALTER ROLE dedalo CREATEDB`): `CREATE DATABASE`
   and both renames require it. `--maintenance-db` covers a cluster without
   the `postgres` maintenance database. `--database <other>` is a REHEARSAL,
   not a restore of the installation: the door has TWO MODES decided by one
   comparison, the target against the configured database (`DB_NAME`). Only
   the configured target gets phase 2's maintenance stamp and phase 5's plan —
   the plan runs through the engine's pool, which is bound to the configured
   database for the life of the process, and the stamp is what the engine
   SERVING that database reads. A rehearsal into another name therefore
   verifies, restores and swaps (phases 1, 3, 4; the zero-backends check still
   guards the rename) and reports `mode: "rehearsal"`, `reconcile: null`; it
   never writes to the live database or its `ts_state.json`, so it is safe
   while the engine serves. Start `dedalo-ts.service` again after
   the whole order below has run — not between steps — and **lift maintenance
   mode** from the maintenance area once the journal's `held` list is decided.
3. **RAG pgvector DB** (store 2) if enabled; it is derived from the matrix DB
   and can also be re-embedded rather than restored.
4. **Media originals** (store 3), from a DATED GENERATION of the tree backup
   (`deploy/dedalo-tree-backup.sh` writes `<dest>/<YYYY-MM-DD_HHMMSS>/` with a
   `latest` link; pick the generation OLDER than the mistake, not `latest`):
   `rsync -a "<instance dir>/backups/media/<generation>/" "$MEDIA_PATH/"`. Then
   rebuild derivatives with `tool_update_cache` — do not restore derivatives.
   The restore door does NOT copy media; this step is yours.
5. **RECONCILE THE ID COUNTERS AGAINST THE MEDIA TREE** — the door's
   `POST_RESTORE_PLAN` already APPLIED `counters_media` (raise-only) against
   the media tree as it stood at restore time; if step 4 changed the tree
   AFTER the door ran, run it again: maintenance area → *Dédalo counters
   status* → **reconcile media counters** (or `bun scripts/reconcile.ts run
   counters_media --apply`). Run it DRY first and read the list.

   A restore rolls `matrix_counter` back WITH the data. The media filesystem was
   not rolled back: it still holds the files of every record created between the
   backup and the disaster. Media identity is exactly
   `{component_tipo}_{section_tipo}_{section_id}`, so if the allocator re-mints
   those ids each new record keys straight into a dead record's files —
   `component_av` re-derives `files_info` from disk and plays the dead object's
   derivatives, and `tool_update_cache` (step 4, which you just ran) PERSISTS the
   wrong attachment. Nothing else notices: no collision fires, because the rows
   are gone.

   The allocator's own floor cannot see this either — it reads the live rows and
   the time machine, and a restore rolls both back together. **Only the disk
   remembers.** The action is raise-only and idempotent; a surprising number
   usually means the media root is not the one this database belongs to, which is
   why it is dry by default.
6. **Each site-builder instance** (store 5), in this order and no other:
   1. `config/` back to `/etc/dedalo_sites/instances/<instance>/` — the
      declaration and its `secrets/`, root-owned, modes preserved. Everything
      else about the instance is derived from this directory.
   2. The BYTES: the workspaces root, each site's webspace, the audit
      directory, back to the paths the declaration names — **including hidden
      entries**. The backup mirrors each webspace at its own SOURCE PATH under
      `<instance>/webspaces/` (minus the leading slash), so the tree under that
      directory reads as the host's own and there is nothing to work out: two
      sites whose webspaces share a basename cannot collide, which they did
      when the destination was the basename alone. The `.dedalo_site_instance` markers and the `.releases` stores
      are dot-prefixed, and a root that comes back non-empty and unmarked is
      refused by the provisioner (SITE_BUILDER_INSTANCES.md §5). A restore that
      skips dotfiles produces a host that will not converge.
   3. `bun run provision apply --instance <instance>` in
      `publication/site_builder/`, as root. This recreates the user and group,
      re-asserts every ownership and mode on the restored trees, and rewrites
      every generated artifact — the unit, the vhosts, the env, `sites.json`,
      the pairing fragment — from the declaration, **and links each vhost into
      the directory the web server reads** (`sites-enabled/`), which is what
      makes the restored museum answer on its domain rather than merely exist. It creates a served symlink
      only when one is ABSENT and never re-points an existing one, which is why
      the bytes go back first.
   4. `bun run provision check --instance <instance>` must exit 0.
   5. If the engine's `DEDALO_SITE_BUILDER_TOKEN` was lost with its `.env`,
      re-pair from the restored credential:
      `bun run scripts/site_builder_pair.ts <config dir>/engine.env.fragment --token-file <config dir>/secrets/SERVICE_TOKEN`.

### 6.2 The reconciliation rule

`provision check` proves the host matches its declaration. It does NOT prove a
museum's site still serves, and after a restore that is the only question worth
answering. So, **after restoring store 5, for every site: the served symlink
must resolve, its target must be a non-empty directory, and for production the
release it names must equal that site's own `published.release`.** A link that
resolves to a directory that is not there, or to a release the site does not
claim, is a museum serving a blank page or last month's page — and both look
exactly like a successful restore from every other angle.

Per site, with `<webspace>` from the instance's `sites.json` and `<slug>` from
its workspaces root:

```bash
readlink   "<webspace>/web"                       # → .releases/web/<release>
ls -A      "<webspace>/web/" | head              # must not be empty
grep -o '"release": *"[^"]*"' "<SITES_ROOT>/<slug>/site.json"   # must name the same <release>
```

That comparison is the same one `publication/site_builder/src/provision/verify.ts`
runs before and after an adoption. It is not yet reachable as a standalone verb;
until it is, a restore is reconciled by the three reads above.

### 6.3 Retention

One copy is not a retention policy, and the failure a backup set most often
has to survive is not a dead disk but a **mistake that was faithfully copied**:
a mass delete, a bad import, a ransomware pass. Those are only recoverable if a
generation older than the mistake still exists when it is noticed, which is
usually days later.

The rule for an installation:

- **Database dumps: keep generations, not a file.** At minimum seven dailies
  plus one monthly kept for a year. The nightly unit's dump name carries
  `date +%F_%H%M%S`, so generations accumulate by construction — and so does
  the disk usage. Something must prune them, and pruning is where a policy
  becomes real.
- **A `--delete` mirror is ONE generation, and the shipped jobs no longer
  ship one.** Stores 3 and 4 are copied by `deploy/dedalo-tree-backup.sh`:
  dated `rsync --link-dest` generations (one hardlink per unchanged file),
  built under an `.incomplete_` name and promoted only on rsync exit 0, pruned
  to `--keep N` (14 in the systemd unit, `DEDALO_BACKUP_KEEP` in the compose
  stacks). A deletion in the media originals reaches the NEWEST generation at
  the next run and no other. `test/unit/deploy_env_contract_tripwire.test.ts`
  leg G holds this over `deploy/**` and the compose stacks: every rsync that
  deletes must build a `--link-dest` generation under a stated retention, and
  every tree-backup invocation must carry `--keep` — the one mirror still
  exempt (store 5, the site-builder instances) is enumerated there with its
  reason. Filesystem snapshots (ZFS/Btrfs/LVM) on the destination remain a
  good second layer.
- **At least one generation must be OFF this host** and, for the ransomware
  case, not writable from it.
- **Restore-test quarterly** (§6, already stated): a backup that has never been
  restored is a hypothesis.

**What is mechanical and what is not.** The SHAPE of the shipped jobs is
gated (generations, `--keep`, no bare mirror — leg G above), and the tree
backup script's behaviour is run by `operator_commands_tripwire` (a source
deletion does not reach the previous generation; retention removes only whole
generations beyond `--keep`). What no gate can see is a museum's HOST: whether
the timer is enabled, how old the oldest generation there really is, whether a
copy exists off the host. The engine's only runtime opinion about backups is
the USABILITY and freshness of the newest dump (`newestUsableBackup`,
`DEDALO_BACKUP_TIME_RANGE`, read by `src/core/update/preconditions.ts`), which
gates a code update and says nothing about how far back you can go. The
off-host copy and the quarterly restore test are still yours.

### 6.4 What the engine restores, and what stays an operator's

Since S-7 (2026-09-03) the engine owns the DATA restore: `bun scripts/restore.ts
<artifact>` is the door described in §6.1 step 2 — verify by full read, refuse
writers, one-transaction restore into a sidecar, rename swap, reconcile plan,
journal. Its contract is gated on a real Postgres with real archive bytes
(`test/unit/restore_door_native.test.ts`: a truncated artifact is refused
before any write; a held backend is refused; a mid-restore failure leaves the
target fingerprint-equal with no sidecar behind; a clean artifact restores,
keeps the previous copy, reconciles after the swap through the real plan,
journals; a swap failure drops the sidecar; a rehearsal into another database
runs no plan and stamps nothing). The other
restore the engine owns, `update_code.restore_code`
(`src/core/area_maintenance/widgets/update_code.ts`), puts back a previous CODE
TREE (§12).

What stays an operator procedure, and why:

- **Media originals** (store 3): a copy from a dated generation (§6.1 step 4).
  The door does not move media — a media tree is tens of GB to TB, the copy is
  a plain rsync, and which generation to restore is a judgement (the one older
  than the mistake), not a computation.
- **`../private/`** (store 4) and the **RAG database** (store 2): steps 1 and 3
  of §6.1. The `.env` is what the door itself reads to find the database.
- **Site-builder instances** (store 5): §6.1 step 6 — `provision apply` is the
  restore.
- **Stopping the engine.** The door refuses while any client backend holds the
  database; it does not (cannot) stop a service it does not see. CLI-only, by
  design: a maintenance-area button would have to swap the database its own
  pool is holding. A read-only "last restore journal" row in the maintenance
  area is the follow-up.
- **Pruning `<db>_pre_restore_<stamp>`** and **lifting maintenance mode**: both
  after the journal has been read.

**The quarterly restore test is still the only thing that proves a museum's
backup.** The gate proves the DOOR; it cannot see a museum's artifact. Run the
door against a scratch database name (`--database dedalo_restore_test`) with
the newest nightly dump — WITHOUT stopping the engine: that is a rehearsal
(§6.1 step 2), which runs no plan and stamps nothing — and check the record
count in `dedalo_restore_test` yourself. The door's `mode: "rehearsal"`,
`previous: null` (no target existed) and exit 0 are the pass; the row counts
are the verdict. Drop the rehearsal database afterwards.

### 6.5 Cross-store reconciles: ONE registry, three doors

Every pair of stores the engine keeps next to the matrix can drift — a restore
(§6.1), a write that bypassed a cascade, a crash between two commits. Each
pair's reconcile is a REGISTERED definition (`src/core/reconcile/registry.ts`;
the assembly is `catalog.ts`): the two stores it compares, a schedule, and one
`run({apply})` that REPORTS drift without writing (the default everywhere) or
REPAIRS it. The logic stays with its owner module; the registry only gives it
a shape, so an operator learns three doors, not one per subsystem:

| door | what |
| --- | --- |
| maintenance area → **Reconcile** (`reconcile_status` widget) | lists every reconcile with its last verdict; **Check** (dry) / **Apply** per row |
| `bun scripts/reconcile.ts list` / `run <name> [--apply] [--scope a,b] [--json]` | the same from a terminal; exit 2 = drift reported and not repaired |
| `GET /api/v1/counters` → `gauges.reconcile` | per name: `schedule`, `auto_apply`, `last_run_at`, `last_apply`, `last_drift`, `last_applied`, `last_deferred` (why the last apply could not happen, else null), `last_refused` (why the last apply was refused by its own precondition — not owed, not re-armed — else null), `last_error` (a code, never text) |

The registered set (grow/shrink only through `REGISTERED_NAMES` + the catalog;
`reconcile_registry_tripwire` derives every reconcile-shaped module in the tree
and demands it be here):

| name | stores | schedule | apply |
| --- | --- | --- | --- |
| `counters_media` | `matrix_counter` ↔ media file names | operator | raise-only (§6.1 step 5) |
| `files_info` | media column `files_info` ↔ media tree | operator | judged PER ITEM: GROW/DIFF and FOREIGN (another record's files — the clone signature) rewritten, SHRINK held (`scripts/media_repair_files_info.ts --allow-shrink`); each change re-judged under the row lock through the one locked media-key writer (`missing` / `locked` / `heldOnApply` in `detail`) |
| `observer_mirrors` | `matrix_relation_index` ↔ observer mirror slots | operator | full-law recompute (`scripts/observer_reconcile.ts` keeps `--budget`) |
| `media_index` | `.publication/dbs` ↔ `.publication/pub` | **boot + every 10 min, auto-apply** | pub/ is a pure derivation: recomputed after every listen and on the period (a diffusion runner is a separate process; one that dies between a pair's `dbs/` and `pub/` writes leaves drift while the server lives); an apply held off past its fence budget is DEFERRED and re-armed. The fence is EXCLUSIVE on every publication target, and a record delete on the request path does not wait for it (the unpublish stays pending in dd1758): so a run in sync takes no fence at all (an unfenced diff decides), and an apply that held it then drains the pending-unpublish queue — a record deleted during the hold leaves the public tier with that run, not at the next publish run (`detail.pending_unpublish`) |
| `rag_index` | matrix records ↔ `rag_embeddings` | operator | enqueues index/delete for the drain (§11) |
| `ontology` | `<tld>0` source records ↔ `dd_ontology` | operator | destructive re-projection per drifted TLD |
| `ontology_identifiers` | `dd_ontology` identifier columns ↔ the identifier grammar (six CHECKs) | boot (dry) | re-derive each violator's tld from source, delete the unaddressable rest (returned whole), VALIDATE the clean CHECKs |
| `ontology_machine_names` | `matrix_ontology` source records (ontology5 / ontology43 / ontology44) ↔ the machine-name shape (name in ontology43, flag stated, lg-spa out of ontology5) | **boot, auto-apply** (class L only) | the LOSSLESS conversion (`src/core/ontology/machine_name_convert.ts`, WC-2026-11-04-ontology-machine-names): a record whose machine name, flag, model and per-lang labels the parser derives identically before and after moves its name into ontology43, states ontology44 and drops the lg-spa duplicate, through `saveComponentData` (TM row each, actor `-1`), then every touched tld is rebuilt; armed only on an ontology that defines ontology43/44 (else `detail.apply_refused`, nothing written); on an ontology server an apply without an explicit TLD scope is refused (master is converted by a human); classes S/C are listed (`detail.refused`), never written. Package imports convert the same class at the import door (after COPY, before the re-derive, no TM row) |
| `ontology_machine_names_strays` | `matrix_ontology` name-node records carrying differing translations ↔ the machine-name shape | operator | class S: the same move, the strays kept as the node's labels (never purged), listed value by value; root-only (`applyRootOnly`) — it changes which label a UI language resolves to |
| `hierarchy` | `hierarchy1` active rows ↔ their provisioning | operator | `ensure` per broken hierarchy |
| `public_tier` | matrix (record existence + publication flag) ↔ public tier (MariaDB rows, `.publication/dbs` markers, per-record rdf/xml/markdown files) | operator | unpublishes GHOSTS only (records the matrix no longer holds or no longer flags publishable, still served); a missing publication is reported, never published — that is a job (`src/diffusion/targets/mariadb/public_tier_reconcile.ts`) |
| `publication_apis` | installed tree's verified Publication API release (`publication/server_api` + its extract-time manifest) ↔ each publication host's current v1/v2 | every 1 h (dry; hashes nothing when no publication host is paired) | **refused here** (`perm.denied`): root pushes from the `publication_hosts` widget (**Push API releases**), and a confirmed code update/restore boot pushes by itself (`src/core/publication_host/api_reconcile.ts`) |
| `media_copy` | work `.publication/pub` ∩ public-quality files ↔ each copy-mode publication host's agent manifest + mirrored markers | every 10 min, **auto-apply** | through the copy worker's per-host lane: copies missing published files (sha-verified), unmarks then deletes unpublished ones, verifies deletions against the manifest; an unverified deletion is red in the `publication_hosts` panel, and a host withdrawn from copy mode while still holding bytes stays `failed` (`copy_mode_withdrawn`); root runs it for one host from the panel (**Reconcile media copy**); an operator APPLY through the Reconcile widget is root-only too (`applyRootOnly`), a dry run admin-level |
| `publication_probe` | registry probe paths + work `.publication/pub` ↔ each publication host's PUBLIC URL answers | every 15 min, **auto-apply** (records only) | an observation, never a repair: the dry run sends two public GETs per configured host (published → 2xx, unpublished → 404) through the public door and writes nothing; apply records each verdict in `runtime.probe` (`applied` always 0); the repair is root's **Apply rules** (`src/core/publication_host/probe.ts`) |
| `rich_text_images` | matrix text_area `<img src>` values ↔ the image web folder's file names | operator (a LIKE scan of every record table's `string` column) | TODO-069: each `src` that is not the stored form of a file keyed to ITS record (a pre-TODO-066 `pic.jpg`, a v6 prefix) — the file is COPIED to a record-keyed name (one copy per embedding record, the original kept for Time Machine history) and the `src` rewritten through `saveComponentData` (TM row, actor root `-1`, no modified stamp; the html write gate sanitizes the whole text); a referenced file absent from the folder is reported (`detail.missing`) and its text untouched; a slice a save would corrupt — stored under a lang the save does not write (`effectiveSaveLang`), or a component holding lang-less items — is HELD (`detail.held`), never saved; an operator APPLY is root-only (`applyRootOnly`) (`src/core/media/rich_text_image_reconcile.ts`) |
| `web_image_exposure` | image web folder file names ↔ `.publication/pub` + the keyed record's own text | boot (dry) | web-folder files whose name parses to a PUBLISHED record that does not embed them (rule B serves them for no reason): renamed out of the grammar (`<stem>.legacy[N].<ext>` — a `_lg-xxx` suffix included) and every embedding text repointed (TM row), found by the `_<tipo>_<id>` needle so %-encoded and entity-encoded references are caught; the old name is unlinked only once a re-scan of every string finds nothing resolving to it (otherwise both names stay, `detail.failed`); a store without hardlinks gets an exclusive copy; files younger than 24 h are held (`detail.recent`, the text may not be saved yet); an operator APPLY is root-only (`applyRootOnly`), a dry run admin-level (`src/diffusion/api/reconcile.ts` → the core module) |
| `portal_declared_order` | each record's stored portal locator array ↔ the portal's DECLARED column order (`show.ddo_map[].order`) | operator (also queued post-COMMIT, through the registry so the gauge shows its outcome, when an ontology rebuild or a local node projection adds or changes an `order`) | re-saves each drifted array re-ranked (the same locators) through the save door — TM row, observer + diffusion obligations as any save; a record whose save is refused or THROWS is isolated (its own transaction rolls back) and the sweep goes on: counted exactly in `detail.failed` / per portal `failedCount`, listed (up to 50) in `failed`; holders are read in keyset pages. STOPPABLE: the SIGTERM drain (`stopReconcileScheduler` → `abortInFlightReconciles`) and, when the ontology write runs inside a background job, that job's stop / deadline end the sweep at the next record — typed `update.failed`, shown as the run's `last_error` on the `reconcile` gauge; records already rewritten stay rewritten. Queued per committing ontology write, and run where the write runs: ONE sweep after a whole ontology update (every tld and the model pass — never between two tlds); awaited in the commit lane inside any other background job; HANDED to a background job (lane `maintenance`, kind `reconcile_portal_declared_order`, visible in the process list, stoppable, the lane deadline) when the write is an HTTP request's (tool_ontology, a TM undelete), so the request never waits on it. A scope entry the ontology refuses to resolve is skipped and named (`detail.skipped`), never fatal to the run. Not durable across a process death: a sweep stopped or cut by SIGTERM or a crash after the ontology commit is NOT re-queued (the declaration is already committed) — run this reconcile dry after any interrupted ontology update; the drift it lists is what is owed. A component_alias is never scanned (no record holds an alias key): one whose own `source` declares an order its target does not is listed in `detail.skipped` — that order is ignored, a declared order is keyed on the data tipo (`src/core/relations/declared_order_reconcile.ts`) |
| `ddo_self_depth` | installed request_config `ddo_map`s (`dd_ontology` `properties.source.request_config`) ↔ the ddo `section_tipo` depth rule (`'self'` only at the first level of the config owner — owner decision (c), `src/core/relations/request_config/self_depth.ts`) | operator (dry) | **refused here** (`request.invalid`): the correction is a definition edit on the MASTER ontology, delivered by an ontology update — the engine never rewrites a request_config. The dry list (`detail.findings`, at most 500 listed, the rest counted in `detail.more`; `drift` is the full count) names each node, its config owner, every owner that reads it (`readers` — identical findings from several readers fold into one), the item, slot, ddo, parent and depth. The owner is the node itself, except for a `section_list` / `section_list_thesaurus` node — and only the FIRST one of its model under its parent by `order_number`, the one a read swaps in (a later sibling is read by nobody and never listed): a component's list node is owned by the component; a section's list node by the section unless that section keeps a direct `request_config` (then its own list read never swaps the node in), plus each config-less VIRTUAL section that falls back to it, as its own owner. A read skips each one with an `ontology.ddo_self_refused` notice (`src/core/relations/request_config/self_depth_check.ts`) |

**After a data restore** the door runs the registry through
`POST_RESTORE_PLAN` (`src/core/reconcile/post_restore.ts`): EVERY registered
name, in registry order, with an explicit verdict and reason per entry — the
gate holds the plan and `REGISTERED_NAMES` equal, so a new reconcile has to
decide what a restore does with it. Three APPLY: `counters_media` (raise-only,
idempotent — only the disk remembers the ids minted after the backup) and
`media_index` (a pure derivation) and `media_copy` (the copy-mode publication
hosts follow the restored `pub/`: a record unpublished in the restored data
loses its public bytes). The rest run DRY and their drift is
reported as `held` in the journal and the CLI's exit 2: `files_info`,
`observer_mirrors`, `rag_index`, `ontology`, `ontology_identifiers`, `ontology_machine_names`, `ontology_machine_names_strays`, `hierarchy`,
`public_tier`, `publication_apis`, `publication_probe`, `rich_text_images`, `web_image_exposure`, `portal_declared_order`, `ddo_self_depth` — each a decision (a shrink, a budgeted recompute, a re-embed, a code push to a public host, a
destructive re-projection or row delete, an unpublish from a museum site; the probe is an observation whose dry verdict says whether media unpublished since the backup instant is still public; the two rich-text entries copy/rename files and rewrite texts across records; the portal-order entry re-saves drifted arrays with a Time Machine row each) the operator takes with the dry
list in view, through the three doors above. A step that throws is recorded by
its error code and the plan continues.

Scheduling is the registry's, not each owner's (`src/core/reconcile/scheduler.ts`):
`boot`-class definitions run after the server listens, `{everyMs}` ones on their
period (`atBoot: true` also after the listen), both fire-and-forget and non-fatal
(`last_error` in the gauge). A run whose apply was DEFERRED — another writer held
the store past the run's bound, nothing applied, `last_deferred` says why — is
re-armed after 60 s (or its period, if shorter) until one completes; a thrown run
is not retried sooner than its period. A run whose apply was REFUSED by the definition's own
precondition (`last_refused` says why; e.g. machine names on an ontology server without a
TLD scope) wrote nothing and is NOT owed: it is not re-armed, and the widget and CLI show
the reason instead of a bare `applied 0`. One run per name is in flight at a time
(the next is armed only once the previous settled), each run executes in the
scheduler's own scope (no principal, request id `reconcile:<name>`), and SIGTERM
clears every pending run — one already in flight never re-arms, and the shutdown
waits for it within `SERVER_SHUTDOWN_GRACE_MS`, before the pool closes; one still
running at that deadline is logged (`[shutdown] reconcile run(s) still in flight
at deadline, abandoned`) and dies with the process (its fence unit commits
nothing; the next boot's run re-checks).
`DEDALO_RECONCILE_SCHEDULER_ENABLED=false` (same posture as the diffusion
scheduler, §8) keeps a smoke/maintenance copy from healing a shared store from
the wrong root; the widget, the CLI and the gauge keep working. A scheduled run
applies only when its definition says `autoApply` WITH a reason — today
`media_index`, `ontology_machine_names` (the lossless machine-name conversion —
refused unscoped on an ontology server), `media_copy` (its walk covers the public qualities only, its
hashing rides the sha cache) and `publication_probe` (apply only records the
observation in `runtime.probe`; the set is pinned by `reconcile_registry_tripwire`); a walk of the whole media tree or a destructive re-projection
is an operator's decision, with the dry report in view.

## 7. Schema: migrations + provisioning (S2-39, DEC-17/DEC-19)

- **TS-owned tables** (`dedalo_ts_*`): ordered migrations in
  `install/db/migrations/NNNN_name.sql`, applied at boot by
  `install/db/migrate.ts` into the `dedalo_ts_schema_migrations` version
  table (one transaction per file; idempotent; never edit an applied file).
  Each file is FROZEN in `install/db/migrations.lock.json` (sha256, class
  `compatible`/`incompatible`, release — `install/db/migration_ledger.ts`): the
  version table records the sha256 each file ran with, and the runner REFUSES
  (boot schema verdict `failed`, names the file) when an applied file's bytes
  changed or a file disagrees with the ledger; rows recorded before the hash
  column are backfilled once. A `compatible` class must be lexer-proven additive;
  an `incompatible` migration ships only in an `incompatible` (minor) release
  (`migration_content_hash_tripwire`). A boot file never builds an index on a
  shared table — that is the ONLINE lane (`migration_shared_row_tripwire`).
  Subsystem lazy `CREATE TABLE IF NOT EXISTS` bootstraps remain as fallback.
  Every file's lock WAIT is bounded (`SET LOCAL lock_timeout`, default 5s) and
  a lock timeout (SQLSTATE 55P03) is retried with backoff before the run gives
  up, so a boot migration never queues forever behind a long reader of a big
  table. The shared schema is touched only in the three shapes
  `install/db/migrate.ts` names and `migration_shared_row_tripwire` enforces:
  a tagged, `@>`-pinned seed-defect UPDATE; a tagged, lock-bounded
  SHARED-SCHEMA ADDITIVE COLUMN (nullable, no default — metadata-only on any
  table size; `0010_tm_role.sql`, the time machine's undo-log role); or an
  ONLINE index build
  (below).
- **Online migrations** (`-- ONLINE MIGRATION:` tag, grammar in
  `install/db/online_migration.ts`: only `CREATE INDEX CONCURRENTLY IF NOT
  EXISTS` + `ANALYZE`). Today `0011_tm_role_hidden_index.sql` and
  `0012_tm_history_visible_index.sql`, both on `matrix_time_machine`. The boot
  runner defers them; `startOnlineMigrations` runs them in the BACKGROUND after
  the listener binds (never in a smoke boot). What an operator must expect:
  - **Load right after an upgrade.** Each is a full-heap index build + ANALYZE
    of the time machine (29M+ rows on a large install): I/O and CPU for
    minutes, while the server already serves.
  - **No bounds.** One reserved connection, `statement_timeout = 0`,
    `lock_timeout = 0`, under the advisory lock `7020926001`
    (`pg_try_advisory_lock` — a second process skips its run, it never waits).
    A `CONCURRENTLY` build waits for every transaction older than it,
    **a running backup included**: it finishes after them.
  - **Failure / retry.** A file is recorded in `dedalo_ts_schema_migrations`
    only once every index it names is `VALID`. A failed or interrupted build
    (a restart mid-build) is logged; the INVALID leftover is dropped
    (`DROP INDEX CONCURRENTLY`) and rebuilt on the NEXT boot — no retry within
    the same process.
  - **A stop mid-build cancels it.** SIGTERM / a planned restart / an update
    swap during a build does NOT wait for it: the graceful shutdown calls
    `stopOnlineMigrations` before closing the pool (`pg_cancel_backend` on the
    reserved backend, waits ≤ 5 s), logs `online run stopped by shutdown`, and
    the file stays unrecorded — so every restart before the build completes
    pays its cost again from the start. Leave the server up until
    `[migrations] applied … (online)` appears.
  - **Performance depends on them.** Until they land, the `dd15` time-machine
    history count and its deep pages are correct but slow (no partial index to
    walk). Check `[migrations] applied … (online)` in the log.
- **Shared matrix/dd_ontology schema**: provisioned by the **TS-native
  installer** (`src/core/install/`, DEC-19 — the former cutover blocker is
  RESOLVED). A fresh, empty PostgreSQL database is provisioned by restoring the
  vendored seed dump `install/db/dedalo_install.pgsql.gz` (full schema +
  extensions + populated core `dd_ontology` + root user + default
  project/profiles), then setting the Argon2id root password. The seed is
  COMPILED from repo sources only (`bun run seed:build`,
  `src/core/install/seed_build.ts`; never from an installation's database),
  verified by a fresh install before it is written, and committed with its
  manifest (`install_seed_manifest_tripwire`). ONE installer drives it, in the
  terminal: `./install.sh` (the bootstrap) or `bun run scripts/install.ts` (npm
  `dedalo:install`) — full-screen, plain line mode or flags/answers file over one
  plan. See **`docs/install/ts_native_install.md`** for the operator guide. PHP is no longer required to
  install a TS instance.

### 7.1 A server that is not installed refuses to start

There is no install mode and no install surface (2026-10-12,
`engineering/wire_contract/WC-2026-10-12-install-surface-removed.md`). Before any
listener, database connection or file write, the server asks
`src/config/install_state.ts` whether this box is installed. When it is not, it
writes ONE line to stderr (one journal line) and exits **78**
(`NOT_INSTALLED_EXIT_CODE`, `EX_CONFIG`):

| State | The line says |
|---|---|
| `ENTITY`, `DB_NAME`, `DB_HOST`, `DB_USER` all unset, no `.env`, not sealed | `not installed: … Run the installer: sh install.sh (sudo sh install.sh for production), or bun run dedalo:install in a checkout` |
| none of the four, but `.env` has content | `configuration incomplete: … do not reinstall over an existing configuration` |
| none of the four, but `install_status` is `sealed` | `configuration missing: … Restore .env from backup — do not reinstall over it` |
| `install_status` is anything but `sealed` (the installer writes `terminal_installing` while it runs) | `install not finished … finish it with the installer's --resume (production: sudo sh install.sh --route production --instance <i> --resume; …)` |

A PARTIAL configuration (one to three of the four keys) is misconfigured, not
unconfigured: the config import throws the precise missing-key error and the
process exits 1, bounded by the unit's start limit.

Every systemd unit and dev supervisor this repo ships STOPS on 78 — restarting a
box that is not installed only re-reads the same missing configuration; containers
cannot (Docker has no per-exit-code policy) and restart with backoff:

| Where | Reaction to exit 78 |
|---|---|
| Production | `deploy/dedalo-ts.service` and `deploy/systemd/dedalo-ts@.service` carry `RestartPreventExitStatus=78`: the unit goes to `failed` and stays there. `OnFailure` fires the rollback unit (a single exit 78 reaches `failed`, not only an exhausted start limit): a no-op without a pending code-update sentinel; with one, the new tree that refuses to boot is rolled back after that one exit. `deploy/dedalo-ts-watchdog.sh` reads `Result` and `ExecMainStatus` and does NOT start the restart unit for it (otherwise it would override the unit every 30 s). Run the installer (or restore `.env`), then `systemctl start`. |
| Containers | Docker has no per-exit-code restart policy: a config-less container restarts under `restart: unless-stopped` with Docker's capped backoff (about once a minute), printing the same one line each time. The installer's docker and trial routes never reach this — the engine install runs (`compose run --rm`) before the stack is started. |
| Dev | `bun run dev`, `bun run dev:server` and `bun run start:supervised` respawn on exit 75 ONLY, so 78 ends them with that code. |

**Template units are byte-pinned.** The installer renders
`deploy/systemd/dedalo-ts@.service` byte-exactly (`src/core/install/host/production/units.ts`)
and refuses a template whose bytes differ; a host installed before this change (the
phase-4 drills) keeps a template without `RestartPreventExitStatus` — remove it before a
re-run. The code-update channel never re-renders units, so an updated host keeps its
template until the operator replaces it.

**An aborted re-run takes the instance down at its next restart.** A re-run of the
installer on a live instance writes `terminal_installing`; if it dies without its undo,
the next restart exits 78 and stays down until `--resume` finishes it. That is
fail-closed and intended: a half-reconfigured instance must not serve.

Gates: `test/unit/no_install_surface_tripwire.test.ts` (the real server spawned
config-less: exit 78, no listener, no database connection, no write),
`test/unit/install_state_boot.test.ts` (the predicate),
`test/unit/install_restart_supervisor_tripwire.test.ts` (the supervisors).

### 7.2 Planned restart (code update)

A code update or a code restore swaps the tree and exits `RESTART_EXIT_CODE` (75);
the supervisor brings the new code up:

| Where | What restarts it |
|---|---|
| Production | `deploy/dedalo-ts.service` — `Restart=always` (+ `SuccessExitStatus=75`, so the planned exit is not booked as a crash); declares `Environment=DEDALO_SUPERVISED=true`. |
| Containers | `docker-compose.yml` / `docker-compose.simple.yml` — `restart: unless-stopped`; the `dedalo` service declares `DEDALO_SUPERVISED: "true"`. |
| Dev | `bun run dev`, `bun run dev:server` or `bun run start:supervised` — loop on exit 75 ONLY, each declaring `DEDALO_SUPERVISED=true` on its command line. |

The declaration (§2) is the code-update contract. A `DEDALO_SUPERVISED` line in
`../private/.env` is ignored, and nothing infers supervision from systemd's own
variables.

Exit 75 is a *distinct* code on purpose: a graceful ^C also exits 0, so a
supervisor keying on 0 could never be stopped, and one keying on "any exit"
would hot-loop a crash. `bun run start` is deliberately NOT supervised — systemd
is its supervisor. The contract is gated by
`test/unit/install_restart_supervisor_tripwire.test.ts` (it exists because this
mechanism once named a `start:supervised` script that was never written, which
left every dev on `bun run dev` with a dead server).

## 8. Diffusion scheduler placement

`DEDALO_DIFFUSION_SCHEDULER_ENABLED=false` starts the server without the
claim/sweep cadences (run them in a dedicated instance/host instead). The
delete-propagation executor registers regardless. `DEDALO_DIFFUSION_MAX_RUNNERS`
(default 2) is enforced atomically inside the claim statement.

## 9. Residue lifecycle (S3-46/62/63/64)

Automatic: media pfiles reconciled at boot + pruned after 30 days (terminal);
in-memory job registries evict terminal records after 1 h (pfile mirror
remains); `login_attempts` rows GC'd past the throttle window; terminal
diffusion job rows purged after 7 days (daily, sweeper cadence).

**Every append-only store now states its rule in one place** —
`src/core/retention/registry.ts` + `prune.ts`, listed by store with either a
configured window and an executable prune, or an explicit reasoned "kept
forever" (the records themselves, the Time Machine). The scheduler
(`DEDALO_RETENTION_SCHEDULER_ENABLED`, on by default) applies the windows once
shortly after boot and daily thereafter; with every window at its default it has
nothing to do.

| store | rule |
|---|---|
| `matrix` and the other record tables | kept forever — removal is a curator's delete, never a clock |
| `matrix_time_machine` | kept forever — it is the only store an undelete restores from |
| `matrix_activity` | `DEDALO_ACTIVITY_RETENTION_DAYS` (default `0` = keep) |
| dd1758 publication ledger | `DEDALO_DIFFUSION_LEDGER_RETENTION_DAYS` (default `0` = keep); rows still OWING an unpublish are never pruned |
| error reports (master only) | `DEDALO_ERROR_REPORT_RETENTION_DAYS` **and** `DEDALO_ERROR_REPORT_MAX_ROWS` — an age window alone cannot bound a burst |
| diffusion jobs | terminal rows at 7 days (the diffusion sweeper) |
| session store | sessions/attempts/resets GC'd past their own windows |

Why the two matrix windows default to keeping everything: the activity log is
the record of who changed what and the ledger is the record of what was
published, so a heritage installation's correct default is permanence. What was
missing was not a deletion policy but a STATED one with a door the engine can
open (audit 2026-08-26 P2-9 / SEC-21 / PUB-14).

**Rate ceiling at the proxy.** The shipped nginx configs declare
`limit_req_zone $binary_remote_addr zone=dedalo_api:10m rate=20r/s` and apply it
with `burst=40 nodelay` on the API location. It is the cheapest of the three
walls in front of the audit trail — the other two being the request-scalar
bounds at the parse door and the source-global login bucket.

## 10. Publication API (the isolated public surface)

The Publication API is **not part of this server** and is not started by it. It is a
separate, read-only front for the diffusion-published MariaDB, deployable on the web
server's host (or any host that can reach the published DB) — it never touches the
matrix Postgres, imports no engine code, and holds no engine credentials. Both versions
can run side by side against the same published databases.

| | Path | Runtime | How it runs |
|---|---|---|---|
| **v1** (legacy) | `publication/server_api/v1` | PHP 8 + Apache | Copy the folder to the vhost. Its PHP deps travel with it (`v1/shared/`), so it is self-contained. Create `config_api/server_config_api.php` from `sample.server_config_api.php` (DB creds + the shared `code`); the file is gitignored and denied by `config_api/.htaccess`. Kept **as-is** for existing v4/v5/v6 websites — no new features. |
| **v2** (current) | `publication/server_api/v2` | Bun + TypeScript | `bun run publication:install` once, then `bun run start:publication` (or a systemd unit modeled on `deploy/dedalo-ts.service`, pointing `WorkingDirectory` at the v2 folder). Config is v2's **own `.env`** — never `../private/.env`. |

Both take a **read-only MariaDB user**. That is the real security boundary: the API's
`DB_NAMES` allowlist scopes which published databases are reachable, and nothing in
either version issues a write. v2 additionally offers `API_KEYS`, per-IP rate limiting
and request timeouts (`engineering`-adjacent detail lives in `docs/diffusion/publication_api/`).

Gates: `bun run test:publication` (v2's own suite + typecheck) and
`test/integration/publication_api_v2_smoke.test.ts` (boots v2 as a subprocess against a
real published DB; skips loudly without `DEDALO_DIFFUSION_DB_*`).

## 11. RAG: drain cron + embedding sidecar

RAG (`src/ai/rag/` — opt-in, `DEDALO_RAG_ENABLED`) adds exactly TWO ops
surfaces to a deployment; everything else rides the normal engine deploy.
Hands-on guide: `docs/core/ai/rag_cookbook.md` (Install / Enable / R3).

**1. The drain cron (REQUIRED — without it, nothing ever indexes).** Saves
only enqueue a dirty marker (`rag_index_queue`, matrix DB, best-effort — a
down vector store never fails a save); ALL embedding work happens in the
out-of-band drain:

```cron
* * * * * cd /srv/dedalo-ts && bun run src/ai/rag/cli/rag_drain.ts >> /var/log/dedalo/rag_drain.log 2>&1
```

Deliberately an EXTERNAL short-lived process, not an in-server timer:
- **request-path isolation** — embedding is heavy (network to the sidecar,
  thousands of chunks for a large transcript); a runaway index job can never
  degrade the serving engine, and memory returns to the OS each pass;
- **cache freshness** — the process exits per pass, so module-level caches
  (ontology, section_map, terms) die with it. Do NOT daemonize the drain
  without adding cache-invalidation hooks first — a long-lived drain embeds
  STALE terms;
- **multi-host safe** — a Postgres advisory lock single-flights the drain, so
  the same cron line on every app host is redundancy, not contention.

Idle cost ≈ zero (empty queue → one SELECT; RAG disabled → no-op). Failures
back off exponentially (`2^attempts` min, 5-attempt cap, `last_error` kept);
watch `RagQueue.stats()` — `{pending, ready, blocked, failed, oldestAgeSec}` —
in monitoring (cookbook R10). Pool budget: the drain is one more Postgres
client — already counted in the §4 `DB_POOL_MAX` example.

**2. The embedding sidecar (for real semantic quality).** Any HTTP service
speaking `POST {endpoint}/embed {model, input:[…]} → {embeddings:[[…]]}` —
Ollama's native `/api/embed` matches this contract byte-for-byte
(`DEDALO_RAG_EMBEDDING_ENDPOINT=http://127.0.0.1:11434/api`, model `bge-m3`).
Run it under its own supervision (systemd unit / launchd); the engine treats a
sidecar failure as a RETRYABLE miss (never a garbage vector), so a sidecar
restart just delays indexing. The embedding model name is the vector-store
PARTITION KEY: changing model (or quantization) = a new partition = re-index
(cookbook R11) — never mix precisions under one name.

Backups: the vector DB (`dedalo7_rag`) is derived state — §6 already covers it
as a separate dump; losing it costs a re-index, never data.

## 12. Code updates: swap pipeline, channels, rollback

Publishing side (the master's runbook): `engineering/RELEASE.md`. This section
is the CONSUMER side — what an install does with a release, and what catches
it when the release is bad. Engine: `src/core/update/code_update.ts`.

**The swap is ONE PHASE of an update run (update audit 2026-10-29, design §3;
`src/core/update/run/`, WC-2026-10-30-update-run).** The panel's Update code
starts a journaled run (`<private>/update/runs/<run_id>.json`): preflight
(superuser) → maintenance ON (held to the end; restored to the operator's
prior value on CONFIRMED / FAILED_PRE_SWAP / ROLLED_BACK_CODE, left ON on
NEEDS_DB_RESTORE) → the run's
backup (newest PROVEN dump inside `DEDALO_BACKUP_TIME_RANGE`, or a journaled
waiver) → the release's `steps` from `install/update/catalog.json` (default
`code → ontology → schema → ancillary`; ontology preconditions before the
swap) → post-verify (`schema_clean`, `data_version`, `data_model`) →
VERIFIED → confirm → CONFIRMED. After the swap the new tree's boot RESUMES the
run (`run/boot.ts`): a run whose code phase started owns the boot, so the boot
runner does not apply migrations — the run's `schema` phase does. Failure
exits (`run/rollback.ts`, the ONE predicate `canAutoRollback`): before the swap
FAILED_PRE_SWAP; after it ROLLED_BACK_CODE only while no database phase
(`ontology`/`schema`/`data`) of a release whose `compat` is not `compatible`
started, else NEEDS_DB_RESTORE (sentinel `needs_restore`, a human restores the
run's backup with the previous code — D-2). CLI: `bun run update
status|check|plan <release>|abort [note]` (`scripts/update.ts`). Door
precondition classes: `src/core/update/door_class.ts` (WC-2026-10-30-maintenance-door-classes).
Operator manual: `docs/management/updates/index.md`, held to the code by
`test/unit/update_docs_claims_tripwire.test.ts`.

**Release channels (what an install is offered; 2026-10-18).** The update ask
(`get_code_update_info` `options.channel`) is one rung of a LADDER,
`master ⊂ prerelease ⊂ dev`: published releases `<X.Y.Z>.zip`; also the
prereleases `<X.Y.Z-(alpha|beta|rc).N>.zip`; also the developer builds
`<X.Y.Z>-dev.zip`. Each rung needs BOTH the consumer's choice (the panel's
3-way switch; the default and the only production choice is *Published
releases*) and the master's own switch (`DEDALO_CODE_SERVER_PRERELEASE_CHANNEL`,
`DEDALO_CODE_SERVER_DEV_CHANNEL` — separate). A prerelease is fixed bytes with a
sha256 like a release; the install stamp records `channel: 'prerelease'`, and
posture stays `release`. Every door that moves the install judges the move by
ONE rule from what the engine CALLS ITSELF (`version_walk.ts`
`identityWalkRefusal`): within a data triple only a newer identity
(`beta.6 → beta.7 → rc.1 → X.Y.Z`, skips allowed, no migration rungs); across
triples the linear data walk, to the rung's newest identity on the asker's
channel. A tree that runs a developer build its own stamp says the dev channel
installed (`.dev` identity + `channel: 'dev'`) is judged on the dev channel
whatever item it installs (`code_update.ts` `walkChannelOf`) — which buys it
ONE thing: the same `-dev` identity reinstalled over itself. It never moves
backwards: `X.Y.Z-dev` sorts above every prerelease of `X.Y.Z`, so from it only
the stable `X.Y.Z` or a later identity is newer (`version_walk.ts`
`sameTripleRefusal`; `code_manifest.ts` `sameTripleItemsFor` offers nothing
else — the beta.6 bootstrap reaches `7.0.0`, not `7.0.0-beta.7`). Wire:
`WC-2026-10-15-release-identity-from-tag`.

**The swap pipeline.** Download (TLS-on, origin-pinned, capped) → sha256
verified against the manifest sidecar → zip entries pre-validated (no
absolute/`..`/symlink entries) → extracted into a QUARANTINE dir, never over
the live tree → **dependencies installed in quarantine** (`bun install
--frozen-lockfile --production` against the release's own lockfile) →
**pre-flight smoke boot** of the quarantined tree (a throwaway process must
evaluate the server entrypoint cleanly; a release that cannot even load is
refused with the live tree untouched) → the SENTINEL is written
`status:"pending"` (naming the backup dir the swap INTENDS to create) → the
live tree is renamed into the backup dir (same-device asserted, so both
renames are atomic) → the new tree moves in → planned restart (exit 75).

**DISK SPACE is a pre-download gate (2026-08-25).** A remote install died mid
`bun install` with a wall of bun `NoSpaceLeft`/`FileNotFound` extraction errors
— a full filesystem, discovered only after download, verify and extract had
spent minutes and disk. `src/core/update/disk_space.ts` now measures first:
required = the live tree MINUS `PRESERVE_ROOT_ENTRIES` (`.git` is renamed into
the new tree, never staged — counting it over-states the need by the whole
repository history) times a 1.15 margin; available = `statfs` where staging
lives (one probe covers both sides, since `renameSwap` asserts backup and tree
are same-device). A measured shortfall REFUSES before the first byte is
fetched; an unmeasurable side never refuses and logs that the gate is
disarmed. The panel cannot pre-decide it (`du` over ~10^5 inodes is not a
panel-path walk), so `status.ts` reports the free bytes as an INPUT line and
stays `unknown` — a second, cheaper rule there would disagree with this one.

**The sentinel** (`<backup root>/last_code_update.json`, backup root =
`<install>/../backups/code`, `DEDALO_BACKUP_PATH` overrides) is the rollback
contract: written `status:"pending"` BEFORE the swap's first rename, so a
crash at ANY point of the swap leaves a sentinel the supervisor can read; the
NEW tree flips it to `"confirmed"` once it listens, reaches the database AND
its boot migration run succeeded (update audit 2026-10-29, U-01) — or, when an
update run owns the boot, only when the run reaches VERIFIED (the run flips it
to `"needs_restore"` BEFORE the first database phase of a release that is not
`compatible`). A boot whose
migrations FAILED is never confirmed, and `/health` answers 503 with
`boot_schema: "failed"`: when nothing was applied (the schema is where the old
tree left it) the sentinel stays `pending` and the watchdog rolls back as
below; when some migration already COMMITTED (the schema moved) the new tree
flips it to `"needs_restore"` — the old code cannot be trusted on that schema,
so the watchdog does NOT roll back or restart, logs "needs a human", and the
operator restores the pre-update database backup together with the tree
(automatic rollback stays within one data model, owner decision D-2).
`/health` also reports `data_version` (`ok|pending|ahead|unknown` against the
code's declared data version): `pending` is reported, not red (run "Update
data"); `ahead` — old code over a newer database — is red.
A pending, unconfirmed sentinel is the machine-readable fact "the last update
never proved itself". Because it is written pre-swap, the `backupDir` it names
may not exist yet — the rollback script handles that state explicitly (below).
Its `version` / `previousVersion` are RELEASE IDENTITIES (`7.0.0-beta.7`), and so
is the version in a restore point's directory name and in `restore_points[].version`
(update audit 2026-10-29, U-07 — they were the data triple, which every beta of
one triple shares, so a restore of beta.5 over beta.7 asked for no confirmation).
The tree is confirmed by `installDigest`; only when the sentinel carries none
(an unstamped restore point) does `boot_confirm.ts` compare `version` with the
running DEDALO_ENGINE_VERSION. The rollback script only logs the two fields.

**The supervisor scripts live OUT OF TREE — and out of the instance dir.**
The swap renames the whole app tree; in the crash window between its two
renames there is NO tree at `<instance dir>/master_dedalo` — an in-tree
rollback script would vanish exactly when `OnFailure=` needs it. The units
therefore execute the INSTALLED copies in the root-owned `ROOT_BIN_DIR`
(§2.2: outside the instance dir, next to the pinned runtime `ROOT_BIN_DIR/bun`),
never the shipped copies inside `deploy/`. One-time install (worked example:
`ROOT_BIN_DIR=/opt/dedalo/bin`):

```sh
sudo install -d -o root -g root -m 0755 /opt/dedalo/bin
sudo install -m 0755 deploy/dedalo-code-rollback.sh /opt/dedalo/bin/
sudo install -m 0755 deploy/dedalo-ts-watchdog.sh   /opt/dedalo/bin/
# What the backup units run (the set as DEDALO_USER, store 5 as root, the alarm — §6):
sudo install -m 0755 deploy/dedalo-backup-step.sh deploy/dedalo-db-backup.sh \
    deploy/dedalo-tree-backup.sh deploy/dedalo-site-builder-backup.sh \
    deploy/dedalo-backup-alert.sh /opt/dedalo/bin/
```

`ROOT_BIN_DIR` and every directory above it stay **root-owned**: a user who
owns a parent can rename `bin/` and put their own scripts where root runs
them. The INSTANCE DIR is the opposite — the service user's — because the
swap renames the tree inside it; its parent may be root's (§2.2).

An out-of-tree copy is a real staleness risk: it does NOT update with the
tree. Re-run the `install` lines after any code update that touched
`deploy/*.sh` (the release notes say when), and after editing them locally.
The scripts are deliberately self-contained and change rarely, but a drifted
copy fails the contract silently — refresh it, don't trust it.

**Backup-root resolution (scripts = engine).** The units do not source
`../private/.env` (on purpose — systemd's env parser mangles raw-JSON
values), yet the ENGINE writes the sentinel to `DEDALO_BACKUP_PATH` resolved
through `readEnv` (process env, then `<private>/.env`). The scripts therefore
resolve the backup root with the SAME precedence: `--backup-root` flag →
`DEDALO_BACKUP_PATH` in the process environment → `DEDALO_BACKUP_PATH` in
`<private>/.env` (private dir = `$DEDALO_PRIVATE_DIR`, default the checkout's
sibling `private/`) → the documented default `<install>/../backups/code`. A
wrong or unreadable `.env` degrades to the default and logs a WARN — never
silently. An install that relocated backups needs no unit edit; pinning
`--backup-root` in the unit is still the most explicit option.

**Automatic rollback** is the systemd units' job, on two triggers:

- the new tree NEVER boots — `dedalo-ts.service` exhausts its start limit and
  enters `failed`; its `OnFailure=dedalo-ts-rollback.service` fires;
- the new tree boots but is DEAD — the watchdog probe
  (`deploy/dedalo-ts-watchdog.sh`) sees a red `/health` with a pending
  unconfirmed sentinel and starts the rollback unit instead of a restart.

`dedalo-code-rollback.sh` (the `ROOT_BIN_DIR` copy) distinguishes FOUR
states of the sentinel and logs which one it saw:

1. **pending, backupDir exists, no usable tree at APP_DIR** — the crash landed
   BETWEEN the two renames (window W1): restore `backupDir` → APP_DIR.
2. **pending, backupDir missing, APP_DIR present** — the crash landed BEFORE
   the first rename: nothing was swapped, nothing to restore; mark the
   sentinel attempted and exit 0.
3. **pending, both present** — the normal post-swap rollback: park the failed
   tree, restore the backup.
4. **confirmed / needs_restore / absent / already attempted** — exit 0, touch
   nothing. A sentinel with no `status` at all is torn or foreign: RED, exit 1.

The script rewrites ONLY `status` and `rollback_attempted`, in place, and keeps
every other key (`installDigest`, `backup_waived`, …) byte-for-byte; the write
is temp + fsync + rename + directory fsync, read back before it counts.

For a restore (states 1 and 3) it: flips `rollback_attempted` FIRST (a
rollback that itself fails must never loop), parks any failed tree at
`<backup root>/failed_<stamp>`, moves the backup tree back (it keeps its own
`node_modules` — the pipeline does not strip it from the backup, which is
exactly what makes the restore bootable offline), carries `.git` back if the
backup lacks it, marks the sentinel `rolled_back`, restarts, health-waits, and
says GREEN or "manual intervention required". The four states are drilled
against a real filesystem fixture by
`test/unit/install_restart_supervisor_tripwire.test.ts`.

**Honest limit:** automatic rollback REQUIRES the systemd units. A plain
`bun run start:supervised` loop respawns on exit 75 but has no failure hook —
the update response names the backup dir, and the manual procedure is the
script's own body: move the failed tree aside, move the backup back, start.

**Deployment channels.** The pipeline serves exactly one of two layouts:

| Channel | Layout | Update | Rollback |
|---|---|---|---|
| `tree_swap` | the repo is a checkout on a host (systemd or supervised loop) — or ANY tree without the product-image marker (the CI toolchain container), or a checkout bind-mounted into the product image | quarantine → rename swap (above) | sentinel + `dedalo-code-rollback.sh` |
| `image` | the code tree is BAKED into the product image (`Dockerfile` copies the build-context allowlist, §13, and writes the positive marker `/etc/dedalo/image_tree`), and the tree is not on a mount; only `/private`/media/socket/client are volumes | the swap is REFUSED — a tree swap would land in the container's writable layer and be discarded on the next recreation. The host replaces the image: `deploy/dedalo-image-update.sh --version <tag>` (pull or build, per `.dedalo.env`), by hand or through the opt-in host updater — §12.1. The panel shows that command per release (`consumer.image`, WC-2026-10-09-update-code-image-channel) instead of a dead-end refusal | automatic: the script re-tags the anchored `rollback-<stamp>` image as the old version, re-pins `DEDALO_VERSION` + `up -d` — atomic and complete, dependencies included |

Detection (`src/core/update/channel.ts`, gate `test/unit/update_channel_native.test.ts`)
asks WHERE THE TREE CAME FROM, never "am I in a container": the product
`Dockerfile` writes `/etc/dedalo/image_tree` (outside the tree, so no export,
bind mount or swap carries it); marker present AND the root on the container's
root overlay ⇒ `image`. An unreadable mountinfo inside a marked image fails
safe to `image`.

**Offline-dependency caveat.** A release whose `bun.lock` changed needs
registry access at install time (the quarantine `bun install`). On an
air-gapped host that install FAILS IN QUARANTINE and the live tree is never
touched — the loud, safe outcome. Pre-warm the offline cache or use the image
channel there.

**Keep runtime data OUT of the code tree.** The swap renames the whole tree;
anything living inside it would ride along (the pipeline refuses the swap when
it finds runtime data in the tree, naming the key to set). Per-key recipe:

- `MEDIA_PATH` — move the `media/` tree out (e.g. `/srv/dedalo/media`), set
  the key, restart, verify a thumbnail loads. The refusal names this key when
  a `media/` dir sits inside the code tree.
- `DEDALO_ONTOLOGY_RECOVERY_PATH` — point the ontology-update recovery dumps
  at a directory outside the tree.
- `DEDALO_BACKUP_DIR` (database dumps) and `DEDALO_BACKUP_PATH` (code
  backups) — both default outside the tree already; never point them into it.
- `DEDALO_PRIVATE_DIR` — the private tree is a SIBLING by default; only ever
  relocate it further out (containers use `/private`), never inward.

### 12.1 Image updates on a Docker host

Operator manual: `docs/install/docker.md` (*Choose where the image comes from*,
*Upgrading*, *The host updater*). Publishing side: the release workflow
`.github/workflows/image-release.yml` pushes ONE signed multi-arch digest per
release or prerelease tag — under that tag only, never a floating one — to every PROVISIONED registry of `engineering/image_registries.json`
(`engineering/CI.md`).

**The `.dedalo.env` contract** (host side only — compose substitution and the host
tools; never the engine's `/private/.env`). Besides the database credentials and
the TLS keys `install.sh` writes:

| Key | Value |
|---|---|
| `DEDALO_COMPOSE_FILE` | `docker-compose.simple.yml` or `docker-compose.yml` |
| `DEDALO_IMAGE` | the repository, no tag (`localhost/dedalo` for a local build) |
| `DEDALO_VERSION` | the PINNED tag: `X.Y.Z`, or `X.Y.Z-alpha.N` / `-beta.N` / `-rc.N` for a prerelease image. There is no developer image: every host tool refuses a `-dev` tag (`dedalo_is_dev_tag`) |
| `DEDALO_IMAGE_MODE` | `pull` \| `build` |
| `DEDALO_IMAGE_VERIFY` | `cosign` \| `none` |

Writer: `install.sh` (the full stack: the `docs/install/docker.md` recipe).
Readers: compose (`image: ${DEDALO_IMAGE:-localhost/dedalo}:${DEDALO_VERSION:-local}`
on `dedalo` AND `backup`; the default resolves to registry host `localhost`, so a
compose run without the env file can never pull a public name — it fails loudly)
and `deploy/dedalo-image-lib.sh`, which PARSES the file (never sources it: the
host updater runs it as root-equivalent). Re-pinner: `deploy/dedalo-image-update.sh`,
`DEDALO_VERSION` only, by an atomic rewrite that keeps every other line
byte-identical. No root stack has `build:`. The installer's build and the
updater's build mode are ONE builder: `dedalo_image_build` (`deploy/dedalo-image-lib.sh`;
entry point `deploy/dedalo-image-build.sh`) — `git archive HEAD` into
`.dedalo-install/image-context`, `docker build` of it, the snapshot removed (green
or red); no `.git` → refused (status 3). Committed files only, `build_info.txt`
expanded, so the image never reports `.dev` under a release tag (C3-46). The
override `-f deploy/compose.build.yml` remains for development only (it builds
the working tree). Gates: `install_sh_image_source`, `image_update_script_native`. The engine sees its source as
`DEDALO_CONTAINER_IMAGE` / `DEDALO_CONTAINER_IMAGE_MODE` (process env, declared by
the stacks from the same keys) — the panel labels it official primary, official
mirror or custom.

**The updater** (`deploy/dedalo-image-update.sh --version <tag>`, from the stack
dir; gate `image_update_script_native`), each step refusing before the next
changes anything: mkdir lock → `.dedalo.env` complete (else the exact lines to
add are printed — the adoption path of a pre-pin install) → grammar, and a `-dev`
target REFUSED in every mode (`version_refused`: Docker has no nightly images —
VERSIONING_SPEC S3) → release-order downgrade floor (`dedalo_version_cmp`: a
prerelease before its release) → the RUNNING engine's walk verdict
(`scripts/ops/image_update_channel.ts check-target`: exit 0 ok, 3 refused + reason
id, anything else = unavailable, refused unless `--skip-version-check`) → a
verified `pg_dump` through the `backup` service (`--label pre-image-update`;
`--no-backup` is the operator's typed waiver) → the running image anchored as
`<DEDALO_IMAGE>:rollback-<UTC stamp>` → pull (+ when `DEDALO_IMAGE_VERIFY=cosign`:
`cosign verify` of the RepoDigest against the generated signing identity AND the
signed image's `org.opencontainers.image.version` label equal to the tag pulled —
`dedalo_verify_release`; a signature alone proves only that SOME official run built
the bytes, so a mirror re-pointing `:<newer>` at an older signed release would
otherwise walk the install backwards past the version floor)
or build (not a git checkout → refused; checkout `v<tag>` — `v7.0.0-beta.7` for a prerelease —, or
`--ref` for a prerelease built under another name, build mode only; the checked-out commit's RELEASE
IDENTITY (`dedalo_release_identity`) must build the target — a release or prerelease only from its exact
annotated tag; then `dedalo_image_build` of that HEAD — the installer's builder, sourced before
the checkout, which itself refuses a `-dev` tag, status 3) → re-pin → `up -d
dedalo backup` (never postgres or nginx) → the compose healthcheck: green on the
first `healthy`; `starting` AND `unhealthy` wait up to `--health-timeout`, default
900 s (boot migrations run BEFORE the socket binds, so `/health` is red through
them and Docker reports `unhealthy` ≈2 min in — start_period 30 s + 3 × 30 s —
a state it leaves on the first green probe); red is the deadline (detail
`unhealthy` when the last probe answered red, `health_timeout` when it never
answered) or a RESTART of the engine process (`RestartCount` > 0: it exited — a
crash, never a slow boot; detail `unhealthy`) → green prunes all but the newest
rollback tag; red re-tags the anchor as the old version, re-pins it, restores the
previous checkout in build mode, `up -d --no-build` and waits again. Exit 0 only
on green. `--outcome-file` receives ONE JSON object:

```json
{"schema":1,"request_id":"<uuid>|null","from":"X.Y.Z","to":"X.Y.Z","mode":"pull|build",
 "image":"<repository>","status":"green|rolled_back|rollback_failed|refused|failed",
 "detail":"healthy|health_timeout|unhealthy|pull_failed|verify_failed|build_failed|backup_failed|version_refused|downgrade_refused|same_version|not_running|env_incomplete|locked|interrupted|malformed_request",
 "backup":"/backups/db/…|null","digest":"sha256:…|null","started_at":"<ISO>","finished_at":"<ISO>"}
```

`refused` changed nothing; `failed` tried and left the running stack as it was.

**The request channel** (`<private dir>/image_update/`, `/private/image_update` in
the stacks; the engine owns it — dir 0750, files 0640, user bun;
`src/core/update/image_update_channel.ts`): `host_updater.json` (the host's
heartbeat, `seen_at` stamped by the engine), `request.json` (written by the
panel's `request_image_update`, EXCLUSIVELY — tmp + link), `inflight.json` (the
claimed request + `claimed_at`; the claim is a rename, so claim and cancel cannot
both win), `last_outcome.json` (the outcome above + `recorded_at`). Every file is
untrusted on read: closed-shape validators, and a malformed file reads as absent.
The host updater is `alive` while `now − seen_at ≤ max(3 × interval, 180 s)`. The
host never reads these files; it talks to the engine's CLI,
`scripts/ops/image_update_channel.ts <verb> [--dir D]` (verbs `check-target`,
`heartbeat`, `claim`, `orphan`, `outcome`, `status`; leaf imports only — never
`config.ts`, so it answers even when the engine refuses to start), through `docker compose exec`
(or `run --rm --no-deps` to record an outcome whatever state the engine is in),
and accepts back only a UUID and a tag grammar. Gate: `image_update_channel_native`.

**Why a file and not a section.** Sections hold cataloguing data. This is a
one-shot instruction between two processes of ONE deployment — the same kind of
thing as the tree-swap sentinel and `ts_state.json`. A section would force the
host to hold database credentials and know ontology tipos (or the engine to proxy
for it anyway), and a database restore would RESURRECT a stale request, which
could then install an image nobody asked for today.

**The host unit** (`deploy/dedalo-image-updater.sh`; OPT-IN, off unless installed;
gate `image_updater_host_native`). `sudo ./deploy/dedalo-image-updater.sh
install-units` writes `/etc/systemd/system/dedalo-image-updater.{service,timer}`
with the stack path substituted (a path with whitespace, quotes or other
specials is refused) — oneshot, `User=` the checkout's owner (must reach docker;
git run as root refuses a checkout another account owns, and would leave
root-owned files in it), `TimeoutStartSec=2h`, `NoNewPrivileges`, `PrivateTmp`;
timer `OnBootSec=2min`, `OnUnitInactiveSec=60s` — and enables the timer.
`uninstall-units` reverses it; `print-units` renders without installing; hosts
without systemd run the same pass from cron. No unit file ships in `deploy/`: a
generated unit carries the right path with nothing to hand-edit. One pass: lock →
`.dedalo.env` complete → engine running → heartbeat (an image without the CLI is
a logged no-op) → an orphaned `inflight.json` recorded as `failed/interrupted` →
claim → the HOST's own floors (UUID, tag grammar, NO `-dev` tag at all —
`version_refused`, whatever `DEDALO_VERSION` pins; the engine's
`request_image_update` refuses a `-dev` tag the same way — and no downgrade or
same version against the pinned `DEDALO_VERSION`, `downgrade_refused`) → `./deploy/dedalo-image-update.sh
--version <tag> --request-id <id> --outcome-file <tmp>` — never `--no-backup`,
`--skip-version-check` or `--ref` → the outcome recorded through `run`, then
`exec`, then the journal. A pass that reached a decision exits 0.

**Threat model.** A compromised engine or superuser CAN ask for a newer release or
prerelease tag of the repository the OPERATOR configured. It can never move an
installation onto unreleased code: no host tool installs, pulls or builds a `-dev`
tag, so the host updater never runs host scripts from an unreleased tree with
docker access. That request still
walks the engine's linear rule, the host's floors, a mandatory backup and an
automatic rollback; with `DEDALO_IMAGE_VERIFY=cosign` only a Dédalo-signed image
installs. It CANNOT choose the repository, the mode, a flag, a ref, or anything
else that is executed. The engine never gets `docker.sock`.

## 13. The container build context: secrets, and rotating a key that already shipped

**The invariant: secret material never travels with the code, by any lane.**
The code updater has enforced it on the tree-swap lane for a while — it REFUSES
a swap rather than let `deploy/certs/key.pem` ride along with the tree
(`refuseUntrackedSecrets`). Until 2026-08-28 the IMAGE lane had no such rule:
the `Dockerfile` was `COPY . .` and `.dockerignore` was a hand-maintained
denylist naming neither `deploy/certs/` nor `.dedalo.env` — both of which
`.gitignore` already treats as secrets, and both of which `install.sh` WRITES
before it runs `compose build` (audit 2026-08-26, OPS-01).

### 13.1 What the build context is now

Three mechanisms, in the order Docker applies them:

1. **`.dockerignore` denies the ROOT and re-includes the tracked top-level
   entries the image needs** — deny-all **at depth 1**, and that is the precise
   claim. A `.dockerignore` pattern is matched SEGMENT-WISE and `*` never
   crosses a `/`, so the leading `*` denies exactly the top-level entries;
   inheritance then carries each re-inclusion down its subtree. An operator's
   ROOT drop-in — `deploy/` (never re-included), `.dedalo.env`, `media/`,
   `backup.pem` — cannot enter a context that starts from nothing. A drop-in
   NESTED inside an allowlisted tree is a different case, and it is what
   mechanisms 2 and 4 cover.

   Eight tracked top-level entries are deliberately kept out
   (`IMAGE_EXCLUSIONS`): `deploy`, `test`, `.github`, `.gitlab`,
   `.gitlab-ci.yml`, `.vscode`, `.claude`, `CLAUDE.md`. `test` and `.github`
   were already excluded before this policy, so **six** are newly kept out —
   `deploy` being the one that matters.
2. **The census is DERIVED from EVERY tracked `.gitignore`.** Not just the root
   one: `publication/server_api/v2/.gitignore` (`coverage/`, `dist/`) and
   `publication/site_builder/.gitignore` (`.test-tmp/`) are translated too, each
   RELATIVE TO ITS OWN DIRECTORY, and re-applied AFTER the allowlist (last match
   wins). So a gitignored path INSIDE an allowlisted tree —
   `.agents/settings.local.json`, `src/core/update/install_stamp.json`, the
   nested `node_modules` trees, `publication/server_api/v2/dist/` — is denied
   too. Add a secret to any `.gitignore` and it leaves the image in the same
   change; add a NEW `.gitignore` anywhere and the artifact changes with it, so
   there is no scope statement to go stale.

   The per-directory scoping is load-bearing. Translated globally, the v2 API's
   `dist/` would also drop `client/…/service_ckeditor/css/dist/`, which the image
   needs — a context narrowed past what the engine needs breaks an install, which
   is a defect, not caution.
3. **The COPY is narrow.** The Dockerfile names each allowlisted entry instead
   of `COPY . .`, and `deploy/` is not among them: the directory `install.sh`
   writes private keys into cannot be reached by any COPY, whatever the ignore
   rules say. Nothing in a container reads `deploy/` — the compose stacks
   bind-mount the proxy config and the certificates from the HOST checkout.
4. **Secret-SHAPED names are denied at EVERY depth**, which is the residual of
   mechanism 1: a `certs` directory, a `.env*` name, a
   `.pem/.key/.crt/.cer/.p12/.pfx` extension, anywhere in the tree. It is the
   same shape the code updater already refuses on the tree-swap lane
   (`isSecretShapedName`). The tracked files of that shape — two placeholder
   samples — are re-included by exact path, derived from the tracked tree, so a
   third one reddens the gate instead of riding along.

**What is left, stated plainly:** a NON-secret-shaped untracked file nested
inside an allowlisted tree (`client/scratch.js`, `src/notes.txt`) still enters
the build context. Closing that would mean allowlisting every tracked file
individually, and the first file someone forgot to regenerate would break an
install. The gate asserts this residual explicitly, at its exact size, so it
cannot quietly grow.

Both artifacts are GENERATED: `bun run context:gen` (`bun run context:check`
renders without writing and exits 1 on drift; the policy, the reasons and the
translation rules live in `deploy/build_context.ts`). The gate is
`test/unit/build_context_secret_tripwire.test.ts`, which re-implements Docker's
own pattern matcher, asserts the two artifacts equal the derivation, that every
rule of every tracked `.gitignore` is excluded, that no `COPY`/`ADD` in the
Dockerfile names the whole context or reaches `deploy/` in any spelling, and —
the other direction — that no tracked file the engine needs was narrowed away.

**Adding a top-level entry to the repo means regenerating both artifacts.** The
gate is red until you do, and it prints what it expected.

### 13.2 Rotating and renewing TLS material

`deploy/dedalo-tls-rotate.sh` is the ONE generator of local-CA material, for
both install routes — the docker route's `stack_tls` step calls it for the
first issue, and the native (production) route's TLS step and renewal timer
call it too, so an install, a rotation and a renewal produce the same shape of
certificate (no second generator: `build_context_secret_tripwire` H). A
rotation archives the previous material into `<cert dir>/rotated-<UTC stamp>/`
(700, never overwritten, outside the build context and outside every release
archive) before it installs anything new, and the new material is made and
VERIFIED in a private staging directory first, so a failed issue leaves the
install as it was.

```shell
# a new local certificate authority + site certificate (repeat --host for every
# address staff type: the server name, a LAN name, an IPv4 address)
deploy/dedalo-tls-rotate.sh --mode local-ca --host dedalo.local --host 192.168.1.20

# a new site certificate from the SAME authority (workstations change nothing)
deploy/dedalo-tls-rotate.sh --mode renew [--force] [--renew-days 30]

# a certificate your institution issues
deploy/dedalo-tls-rotate.sh --mode existing --cert /path/fullchain.pem --key /path/privkey.pem
```

**The authority is name-constrained (2026-10-16), and its root key does not
survive the issue.** Before, the CA was a single unconstrained self-signed root
whose key sat next to the site certificate: every workstation trusts it, so a
leaked key could mint a browser-trusted certificate for ANY site (the OPS-01
class, §13.3). Now:

- the authority workstations trust (`dedalo-local-ca.pem`) and the issuing
  authority under it (`dedalo-issuing-ca.pem`) both carry
  `nameConstraints = critical, permitted;DNS:<name>…, permitted;IP:<ip>/32…,
  excluded;DNS:.<name>…`
  — exactly the requested names plus `localhost`/`127.0.0.1` (which every
  leaf names; it also keeps both name types constrained — a type with no
  permitted entry would be unconstrained, RFC 5280 §4.2.1.10, and an IPv4
  `/32` refuses every IPv6 address);
- both authorities also carry `extendedKeyUsage = serverAuth`. The name
  constraint covers only the name TYPES it lists (DNS, IP): e-mail addresses
  and the subject DN stay open under RFC 5280, so without a usage limit a
  leaked issuing key could still mint an S/MIME certificate for any mailbox or
  a code-signing certificate with any publisher name — and Windows trusts an
  imported root for every purpose. An EKU on a CA restricts the whole chain
  (Windows CryptoAPI, NSS, Chrome; OpenSSL for S/MIME — `openssl verify
  -purpose smimesign` refuses, measured by the gate; OpenSSL's `codesign`
  purpose checks the leaf only, so the gate asserts the authorities' EKU is
  exactly serverAuth). Authorities issued before this line have no EKU; the
  next rotation adds it;
- the ROOT key is generated in the staging directory, signs the issuing CA
  once and is deleted; only the issuing CA's key (`dedalo-issuing-ca.key`,
  0600) stays on the server, to sign renewals.

Two tiers because constraints on a TRUST ANCHOR are optional in RFC 5280 and
client support is uneven: OpenSSL, Firefox/NSS and Chromium/Chrome/Edge ≥ 112
enforce them on the anchor, Apple's system verifier has been reported not to
(Safari, Secure-Transport curl); constraints on an INTERMEDIATE are mandatory
path processing that every verifier applies. The sources are in the script
header. A DNS constraint alone permits the name AND its subdomains, so an
authority for `museo.lan` would certify `mail.museo.lan`, and every one for
`x.localhost`; each DNS name is therefore also EXCLUDED with a leading dot
(`excluded;DNS:.<name>`), which matches only names below it, and an exclusion
overrides a permission — the authority certifies exactly its list. The
leading-dot rule was read in OpenSSL/LibreSSL (measured by the gate), NSS
(`pkixnames.cpp`), Chromium (BoringSSL `pki/name_constraints.cc`), Apple
trustd (`nameconstraints.c`) and Wine's crypt32 for CryptoAPI (sources in the
script header); a verifier without it falls back to the subtree behaviour,
never to refusing the install's own name. Hence no listed name may lie under
another (the script and the installer's validator refuse it). The price:
adding a name needs a NEW authority (a rotation, then re-trust), since only
the deleted root could certify a wider issuing CA — and the installed site
file names the addresses too, so a rotation alone does not add one. `test/unit/tls_local_ca_native.test.ts`
proves it with a real `openssl verify` (OpenSSL and, on macOS, LibreSSL): a
leaf signed with the issuing key for another domain, a look-alike suffix,
another IPv4 or an IPv6 address, a name below one of the install's names or
below `localhost` is REFUSED; the install's own names are accepted; a leaf for signed mail under a foreign mailbox is REFUSED too.

**Existing unconstrained authorities keep working.** A pre-2026-10-16 install
still has `dedalo-local-ca.key` and `--mode renew --host <name>` re-issues its
leaf from it (it has no `dedalo-local-ca.names`). The next `--mode local-ca`
rotation produces a constrained authority; workstations then trust the new one
and delete the old entry, as for any rotation.

**An installer run over an existing authority** (`src/core/install/host/tls_authority.ts`,
both routes): the issue is skipped when the authority and the certificate are
already in the directory, so the installer first compares that authority with
the answers. Made for OTHER addresses (`dedalo-local-ca.names` differs from
`server_name` + `tls_extra_names`) → refused at the System check and again in
the TLS step, with the rotate command — it cannot certify the new list, and a
skipped issue would leave a certificate the browsers reject. With NO names
list (a pre-2026-10-16, unconstrained authority): the native route refuses it
(never adopted silently — it is unconstrained, and its renewal timer would
fail daily for want of names); the docker route keeps it working as before,
but only while its site certificate names every answered address (read from
the certificate itself), else it is refused the same way. Gates:
`install_host_steps_native` (g), `install_stack_local_ca_native`.

**IPv4 extra addresses: both routes (native since 2026-10-16).** A browser
sends no SNI for an IP-literal URL (RFC 6066 §3), so the web server picks the
handshake's certificate by the listening address alone. In the docker stack
the instance's site is the container's only HTTPS server, so an IP works
there as it is. On a native host the default for an address is the host-wide
catch-all, and claiming the address in a site (`listen <ip>:443` /
`<VirtualHost <ip>:443>`) is not a fix — both servers then route EVERY name
arriving on that address to the claimant (nginx request_processing.html;
Apache vhosts/details.html: an exact address match hides every `*` vhost).
So a native instance CLAIMS the address in the installer-owned catch-all
(`src/core/install/host/web/catch_all.ts`, re-rendered from every instance's
`addresses` in the host registry): nginx picks the certificate per handshake
(`ssl_certificate $dedalo_catch_all_certificate`, a map on
`"$server_addr|$ssl_server_name"` — only a NAMELESS handshake to a CLAIMED
address gets one; every other handshake the catch-all sees finds a file that
never exists and is refused, logged in `dedalo-catch-all.error.log`). A
certificate named by a variable is loaded by a nginx WORKER, so the claiming
instance's site key is `root:<web group> 0640` — the generator's
`--key-group`, in host_tls's key-access run and the renewal drop-in, applied
even by a no-op renewal. Apache has no per-address certificate: while ONE
instance claims addresses its catch-all is the first `*:443` vhost with that
instance's certificate (SSL settings equal to the instance vhost's — mod_ssl
answers 421 to a request whose vhost's SSL setup differs from the
handshake's), 421 for any undeclared Host; a second claimant is refused. The
System check (`production/address_claims.ts`) refuses an address that is not
this host's (`/proc/net/fib_trie`), one another instance claims, non-standard
ports, a foreign catch-all, an operator site BOUND to the claimed address
(`listen <ip>:80|443` / `<VirtualHost <ip>:80|443>`, or a listen on a host
name — the address is kept by the `nginx -T` / `-S` parsers in
`web/clash.ts`: such a bind takes every connection to the address from the
wildcard sites, catch-all included), nginx's operator `default_server` on 443
or an operator 443 server loaded BEFORE the catch-all (the first server is the
port's default; load order from the dump's `include` order —
`nginxIncludes`/`nginxLoadOrder`, unknown refused), and on Apache another claimant or an operator `*:443` vhost loaded before the
catch-all. host_web_site re-checks the claim against the LIVE registry and
renders from it (`liveClaimCheck`): a claim landed since this run's Review
refuses the run (`install.state_conflict`) — never last-writer-wins; the
render keeps one map key per address (nginx refuses a duplicate). Its verify
reads the catch-all (`catchAllServes`), so a resume never adopts a step
stopped before the catch-all write; the registry's `catch_all` use is recorded
before the work. The generator REMEMBERS `--key-group` in
`<dir>/dedalo-key-group`, so a hand rotation without the flag keeps the
key's 0640. `--abort` re-renders the catch-all without the instance's
addresses (nginx) or removes it with the last user. IPv6 stays refused at
validation (the generator constrains IPv4 only). Gate:
`install_host_ip_claims_native` (real nginx and Apache in `dedalo-ci:local`
when Docker is present).

**Lifetimes and renewal.** The leaf lives 397 days, the authorities ten years.
`--mode renew` re-issues the leaf (new key, new serial) from the SAME
authority when it expires within `--renew-days` (default 30; a no-op otherwise,
byte-exact), for the names in `dedalo-local-ca.names`; `--host` may name a
subset. A name outside the authority's list fails `openssl verify` in staging
and nothing is replaced. An authority that would not outlive a full-length
leaf refuses to renew and says to rotate. The NATIVE route renews from a
systemd timer: `host_tls` (`src/core/install/host/production/tls.ts`) issues
into `/opt/dedalo/instances/<i>/tls/` (root 0755, keys 0600 — the site key
0640 to the web group with a claimed IP on nginx — `cert_t` on EL)
with the ROOT-OWNED copy of the script in `/opt/dedalo/instances/<i>/bin/`
(a ROOT_RUN_SCRIPT — never the instance's tree, F2), every address
(`server_name` + `tls_extra_names`) a `--host`, `--no-reload` (the site is
written next); then the `dedalo-tls-renew@<i>.service` drop-in pins
`--mode renew --dir <that dir> --reload systemd --unit <the row's web unit>`
and `dedalo-tls-renew@<i>.timer` (daily, Persistent) runs it. `--abort`
disables the timer, removes the drop-in and deletes the directory only when
that install created it. Gates: `install_host_local_ca_native` (the plan's
commands EXECUTED: constraint refusal, renewal keeps the authority, the
reload of nginx/apache2/httpd), `install_host_steps_native` (g). The DOCKER
route has no timer: the operator renews (the
operator-facing procedure, `docs/install/docker.md` "Renewing the local-CA
certificate", suggests a calendar reminder or a monthly cron line — the run
is a no-op until the last 30 days).

**Reloading.** `--reload docker` (the default) runs `nginx -s reload` inside
the stack — `--compose-file` names it (default `docker-compose.simple.yml`;
pass `docker-compose.yml` on the full one); only the SIMPLE stack's proxy also
reloads itself every six hours, so on the full stack a missed reload keeps
serving the OLD certificate. `--reload systemd --unit nginx|apache2|httpd`
reloads the HOST web server (native route; never docker; `--dir` is required
there): a server that is not running reads the certificate when it starts; a
running one that refuses the reload exits 3 with the certificate in place, so
a renewal timer shows the failure. A failed `--reload docker` exits 3 too (a
cron renewal where `docker` is not on PATH must not read as success). The
obligation is REMEMBERED in `.dedalo-reload-pending` in the certificate
directory, written before the served files are replaced and removed only when
the reload worked (or the host server was not running): without it, the next
run — a no-op, since the leaf on disk is fresh — would exit 0, the failed timer
would turn green, and the web server would serve the old leaf from memory until
it expired. Every run retries the pending reload and stays exit 3 until it
works. `--no-reload` skips the reload and leaves no obligation: the caller owns
it (the docker installer, which then starts the stack).

**Killed runs.** Every run first removes `.dedalo-tls.*` staging directories
older than ten minutes in the certificate directory: an issue killed by SIGKILL,
the OOM killer or a power loss between creating the root key and deleting it
would otherwise leave that key — able to sign a new, unconstrained
intermediate — next to the certificates. Younger ones are left alone (a
concurrent run's live staging). Gate: `tls_local_ca_native` C/D.

The OPERATOR-facing version of this procedure is `docs/install/docker.md`
("Rotating TLS material"), linked from the simple install's after-install steps
and its troubleshooting table — a rotation only an engineer can find is not
delivered. This section is the same procedure with the reasoning. A rotation
prints the new CA file with its SHA-256 fingerprint. Each CA carries its issue
stamp in the subject (`CN=Dedalo local CA <stamp>`) — two authorities both
called "Dedalo local CA" are indistinguishable in a Windows or macOS trust
store, and an operator rotating away from a compromised key must be able to
tell which entry to delete.

**Let's Encrypt needs none of this**: its key lives in the `letsencrypt` named
volume (docker) or certbot's own directory (native), never in the build
context, and it renews itself.

### 13.3 If you have already distributed an image — read this

An image built on a host that ran `./install.sh` with the local-CA option
CONTAINS `deploy/certs/dedalo-local-ca.key`. That is the private key of an
authority you were told to install into the Trusted Root store of every
computer that uses Dédalo: whoever holds it can mint a browser-trusted
certificate for ANY hostname, for every one of those workstations. It travels
wherever the image travels — a registry an installation pulls from (§12.1),
a `docker save` tarball, a copy handed to a supplier, or one more member of the
host's `docker` group than you expected. Assume it is compromised; it cannot be
un-distributed.

In this order:

1. **Rotate the CA and the site certificate** — §13.2. Do this first: the
   replacement must exist before you invalidate the old one.
2. **Install the NEW CA on every workstation, then DELETE the old entry.**
   Until the old one is removed, a certificate signed with the leaked key is
   still trusted by that machine, which is the whole point of rotating. The old
   CA certificate is in the `rotated-…` archive if you need its fingerprint.
3. **Rotate the database password.** `.dedalo.env` (`POSTGRES_PASSWORD`) was in
   the context too. The port is never published, so the exposure is bounded by
   who can reach the container network — but rotate it anyway:

   ```shell
   docker compose -f docker-compose.simple.yml --env-file .dedalo.env \
       exec -T postgres psql -U dedalo -d dedalo -c "ALTER ROLE dedalo WITH PASSWORD 'new-password'"
   ```

   then set the new value in `.dedalo.env` and append `DB_PASSWORD="new-password"`
   to the engine's own `/private/.env` (the private volume). The loader takes the
   LAST occurrence of a key, which is what makes an append-only file rotatable
   (`src/config/env.ts`). Restart the stack.
4. **Rebuild and re-distribute the image**, on a tree with the current
   `.dockerignore` + `Dockerfile`. Verify before pushing:

   ```shell
   docker run --rm --user 0 <image> ls /opt/dedalo/master_dedalo/deploy 2>&1
   # expected: "No such file or directory" — deploy/ is not in the image at all
   ```

5. **Delete the old images and tarballs** you can still reach: registry tags,
   `docker save` files, the `<image>:rollback-<stamp>` tag `dedalo-image-update.sh`
   keeps (the newest one survives a green update),
   and any build cache on machines that built it (`docker builder prune -af`).
   You cannot delete the copies you already handed out — which is why step 2 is
   the one that actually ends the exposure.

## 14. Revoking an account (and what a compromised one needs)

An account's access has TWO independent halves, and the engine ends both — but only
for the doors it can reach. Know which is which before you assume an account is out.

**What a write to the record does automatically** (`src/core/security/revocation.ts`,
fired from the record-write chokepoint): deactivating (dd131 = No), renaming (dd132),
changing the password (dd133), removing the profile (dd1725), flipping global-admin
(dd244) or deleting the record ENDS that user's sessions, unlinks their per-session
media markers, and drops pending password-recovery codes. There is nothing to run by
hand and no cache to clear. Media is the half people forget: the web server authorizes
by `stat()`ing a marker file, so a session that ends without its marker going with it
leaves a cookie that still reads the whole archive — that is why the two are one
operation and not two.

**The one surface a revocation cannot reach by ending sessions** is a long-lived
process that holds no session: the MCP stdio server (`DEDALO_MCP_USER_ID`). It re-asks
the account's standing on every tool call, so a deactivation or a deletion takes effect
on the next call without a restart — but a process is not a session and will not
disappear. If the service account itself is the compromised one, stop the process.

### The two steps for a COMPROMISED account

Order matters. Doing only the first is the common mistake, because the account stops
being able to log in and it looks finished.

1. **Cut the credentials.** Change the password (dd133) — do NOT merely deactivate.
   Deactivation refuses the LOGIN door; it is a policy state, and a policy state is the
   thing an operator un-flips by accident. A changed password invalidates what the
   attacker holds. Both end every live session and every media marker.
2. **Deal with what the account left behind.** Sessions and markers are gone; these
   are not: any MCP/agent process configured as that user (stop it, then repoint
   `DEDALO_MCP_USER_ID`), any API integration holding a token minted for it, and the
   record changes it made — the Time Machine holds them by user, which is where a
   review starts.

Root (dd128/-1) is EXEMPT from the dd131 refusal, by design and in parity with the
frozen PHP: it is the installation's recovery identity, and a mis-clicked radio must
not lock an installation out of itself. Root's credentials are cut in step 1 like
anyone else's — root may edit its own password, which is the only in-engine way to
rotate it.

## 15. Export artifacts (tool_export at scale)

The export tool builds its exports **on the server**. `build_export_artifact`
runs as a background job that writes the whole export into a spool on disk.
Every download (CSV, TSV, HTML, XLSX, ODS, NDJSON, media ZIP) is a file built
from that spool by a second background job (`build_export_file`), and it leaves
the server only through the owner-checked route
`GET /dedalo/export/artifact/<jobId>/<basename>`. The wire is recorded in
`engineering/wire_contract/WC-2026-09-24-tool-export-server-built-artifacts.md`.
This section covers what the operator owns: the directory, its lifetime, its
size, and the job lane.

**Directory.** `DEDALO_EXPORT_ARTIFACTS_DIR` (default
`<private dir>/export_artifacts`). Layout: `<dir>/<userId>/<jobId>/`, which holds
`request.json` (the recorded options, written once), `manifest.json` (the small
mutable state every checkpoint rewrites), the spool (`grid.ndjson`,
`cols.ndjson`, `grid.idx`, and `media.ndjson` — the media addresses the walk
read, present only when a record read media) and the built files (`export.<ext>`,
`media[_<variant>].zip`).

- The directory must be writable by the engine's user.
- It must **never** sit inside a tree served without an owner check — the media
  root, the client tree, or a tool root (the engine serves `/dedalo/tools/`
  without a session, `.json`/`.html` included): every export is
  a copy of records, and the engine is the only reader that checks the owner,
  their current grants and that their record scope (projects, the dd478
  record allow-list, global admin) is still the one the export was taken under.
- Built files are written to a temp name and renamed, so a partial file is never
  visible.
- A root that cannot be used refuses with `export.store_unavailable` (503) and
  writes nothing.
- **Ownership.** The store claims its root with a `.dedalo_export_artifacts`
  marker, planted only in an empty (or just-created) directory; a non-empty
  root without it is refused by every door, the hourly TTL sweep first, and
  nothing in it is written or deleted — the root's name is no proof (a shared
  mount's `<year>/<batch>` dirs match the `<userId>/<jobId>` shape). A
  manifest-less job dir is removed only when every entry is a name the store
  creates. Gate: `tool_export_artifact_store_native` E (OWNERSHIP).
- **One install per root.** The marker names the install that claimed it (a
  fingerprint of its database). A root another install's marker names is
  refused by EVERY door — reads, downloads and the sweep included — so two
  instances that set the same directory never serve one archive's exports to
  the other's users, nor sweep each other's jobs. Gate:
  `tool_export_artifact_store_native` E (INSTALL IDENTITY).
- On a volume other than the private dir's, point the key at it — one
  directory per instance (`/srv/dedalo_exports/<site>`).

**Not part of the backup set.** Export files are temporary, owner-only copies
of records that the owner can rebuild. The default location is INSIDE
`../private/`, which §6 store 4 copies nightly with `--keep 14`, so every
shipped private-tree backup excludes it (`--exclude /export_artifacts`): the
systemd unit `deploy/dedalo-backup.service` and the `backup` service of both
compose stacks (`docker-compose.yml`, `docker-compose.simple.yml`, where the
private dir is `/private` and the root is `/private/export_artifacts`).
Otherwise every user's exports (up to the quota each) would sit in the private
backup 14 days past their TTL, outside the owner, read-access and record-scope re-check. Gate:
`test/unit/export_artifacts_backup_exclusion_native.test.ts` finds EVERY
`--label private` tree-backup invocation in `deploy/` and `docker-compose*.yml`
and runs each one's own arguments over a scratch private tree. A root moved elsewhere with
`DEDALO_EXPORT_ARTIFACTS_DIR` must not be put inside any backed-up tree either.

**Lifetime (TTL sweep).** `DEDALO_EXPORT_ARTIFACTS_TTL_HOURS` (default 24, at
least 1). The sweep runs once at boot and then hourly: tool_export's `onBoot` hook
(`startExportArtifactSweeper`), started by the server's tool boot hooks. It is
never fatal: a failed sweep logs `[export_artifacts] sweep failed` (a hook that
cannot even start logs `[tools] tool_export.onBoot failed`), and the server
keeps serving. What the
sweep does:

- It deletes a job directory TTL hours after the export's **end** (ended,
  failed, cancelled or interrupted). This is a hard ceiling: a file built from
  the export later never extends it, so no copy outlives end + TTL however
  often its files are rebuilt. Past the ceiling every door already answers
  not-found, before the sweep runs (`artifact_store.ts exportExpired`).
- It never deletes a directory while a file build holds its lease.
- It never touches a **running** export while the process that owns it is
  alive.
- It marks a running export whose owner is certainly gone as `interrupted` and
  deletes its partial spool. "Certainly gone" means another boot of the server
  wrote it and either its pid is dead, or its pid is this process's own (pid
  reuse, e.g. PID 1 in a container), or it has sent no heartbeat for 1 h
  (`DEAD_WRITER_SILENCE_MS` — a live walk heartbeats at every checkpoint, so
  the bound follows the writer's cadence, never the TTL; a pid that answers
  "alive" proves nothing on its own: a reused pid of another user does too).
  There is no resume: the user runs the export again.
- It removes stale temp files.
- Each pass that removed something logs
  `[export_artifacts] sweep: N expired, N interrupted, N temp file(s) removed`.

**Quota.** `DEDALO_EXPORT_ARTIFACTS_QUOTA_BYTES` (default 10 GiB per user,
`0` = off) bounds the bytes one user holds under `<dir>/<userId>/`: spools,
built files and media ZIPs together, including several jobs of that user at
once.

- It is checked when a job is created and **enforced while bytes are written**.
  Each writer measures the user's directory again at least every quota/64 bytes
  (between 4 KiB and 16 MiB — each measure walks the user's whole export tree,
  so the step follows the quota instead of re-walking every MiB).
- The worst case is therefore quota plus one step per live writer of that user
  (a few percent of the quota), never N × quota.
- A hard-linked file counts once: the NDJSON download is the ended spool
  itself, linked into place, and costs no second copy.
- Each export keeps at most 4 built files per format
  (`MAX_FILES_PER_FORMAT`); a fifth evicts that format's oldest, whose link
  then answers 404 (asking again rebuilds it). The media ZIP is rebuilt on
  every request (it reads the live media state), replacing the previous one.
- An export that would overflow stops with `export.artifact_quota` (429), and
  its partial spool is deleted.
- Space comes back through the TTL sweep, or at once when the owner deletes an
  export (`tool_export.delete_export_job`, the tool's **Delete export**). The
  delete uses the sweep's lock and liveness rules: a running export of a live
  process, or one a file build holds a lease on, is refused with
  `export.artifact_busy` (409) and nothing is removed. The delete asks only for
  ownership and the section, never the read gates: an export its owner may no
  longer read is still theirs to delete.
- Two more bounds sit beside the byte quota. `DEDALO_EXPORT_ARTIFACTS_MAX_EXPORTS`
  (default 100 per user, `0` = off) caps how many exports one user keeps: a
  tiny export costs almost no bytes, yet every listing reads each one; the
  next export is refused with `export.artifact_count` (429).
  `DEDALO_EXPORT_ARTIFACTS_MIN_FREE_BYTES` (default 1 GiB, `0` = off) is an
  installation-wide floor on the export volume's free space, measured with
  `statfs`: the quota is per user, so N users can hold N quotas, and the
  default directory shares `../private` with the session store and `.env`.
  A door at the floor refuses and a writer crossing it stops, with
  `export.storage_low` (503). Keep it only as a safety net: size the volume,
  or put `DEDALO_EXPORT_ARTIFACTS_DIR` on a volume of its own.
- An export its owner may no longer read (a revoked grant, changed projects,
  past end + TTL) is reclaimed at once when that owner next needs space: a new
  export or a file build deletes it before writing, instead of refusing with
  `export.artifact_quota` over bytes the owner cannot even list.

**Disk sizing.** A spool is about the size of the `get_export_grid` NDJSON
stream for the same options: every cell of every row, as JSON, plus about 17
bytes of index per 100 records. Each built file then adds its own size:

- CSV, TSV and HTML are of the same order as the spool;
- XLSX and ODS are DEFLATE-compressed and usually much smaller;
- the media ZIP is the sum of the archived media files at the chosen quality,
  stored uncompressed, and is by far the largest.

Size the volume as **quota × the number of users who hold exports within one TTL
window**, plus headroom. The quota is the per-user cap. To size from real data,
run one representative export: its spool size is `spool_bytes` in its
`manifest.json`, and each built file's size is in `files`. A media ZIP of
`original` masters can reach the quota on its own.

**Job lanes and admission.** Two lanes of the job manager
(`src/core/media/jobs.ts`), separate from `media`, `maintenance`, `rag` and
`transcription`, so exports never spend their budget: `export` runs the record
walks (`build_export_artifact`), `export_file` the file builds
(`build_export_file`), so a file build never queues behind a walk — including
another user's multi-hour export. CSV/TSV/HTML/XLSX/ODS/NDJSON read only the
finished spool, never the database, and are short next to a walk. The media ZIP
is NOT: per record it re-reads the database (`principalCanAccessRecord` — a
principal-scoped search — plus the record's stored media item and a permission
read) and streams every master file, so a large selection runs for hours and
holds DB load on the `export_file` lane the whole time. Size
`DB_POOL_MAX` and this lane's budget with that in mind.

- `DEDALO_JOB_LANE_EXPORT_CONCURRENCY` (default 1, at least 1) is the walk
  lane's budget. Raise it on a machine with the cores and disk to spare.
- `DEDALO_JOB_LANE_EXPORT_FILE_CONCURRENCY` (default 2, at least 1) is the file
  lane's: two, so one large media ZIP does not make the next user's CSV wait.
- `DEDALO_JOB_DEADLINE_EXPORT_FILE_S` (default `0` = no deadline): a media ZIP
  of a large selection is legitimately long, and the user can stop it.
- `DEDALO_JOB_DEADLINE_EXPORT_S` (default `0` = no deadline): a full export of a
  large collection is legitimately long, and the user can stop it. Set a
  deadline only if the installation knows its own ceiling. A deadline ends the
  export `failed` with `export.deadline_exceeded` (the user reads the limit in
  seconds, never "stopped") and deletes its spool. A graceful shutdown or
  restart ends a running export `interrupted`; only the user's Stop is
  `cancelled`.
- `DEDALO_EXPORT_JOBS_PER_USER` (default 2, at least 1) is per-user admission,
  counted over both actions (both lanes). A submit over the cap is refused
  synchronously with `export.too_many_jobs` (429) and nothing is queued. Without
  this cap one user could fill a FIFO lane and everyone else would wait behind
  them. The `export_file` lane has a second, per-lane rule: one user may hold
  every slot of it but one (`max(1, budget − 1)`: one file at a time with the
  default budget 2), because its jobs have no deadline and a media ZIP can
  stream for hours — with the per-user total alone, one user's two ZIPs filled
  the lane.
- The count is the in-process job registry, so it resets with the process, as do
  the jobs themselves.
- `DEDALO_EXPORT_PREVIEW_PAGE_SIZE` (default 100, clamped 1..200) is the
  preview's default page. The server clamps any requested size to 200, the rows
  of a page to 1,000 and its columns to one window of 100 (a wide export is
  paged sideways), so a page's cells are bounded however wide the export.
- The record walk runs in the server process and yields at every hydrate batch.
  Its memory is the selection's ID LIST (`{section_id, section_tipo}` per
  record, read once when the walk opens and kept until it ends: O(records),
  roughly a hundred bytes each, so ~1 GB for ten million records) plus one
  hydrate batch and one row per writer. The id list is read in ONE statement on
  purpose: it is the export's snapshot (the `meta` line's `total`, and every
  record the walk visits, come from the same instant), and a cursor held open
  for a multi-hour walk would pin a Postgres snapshot for as long. Size the
  process for the largest selection you let users export.
- A media ZIP holds O(files ARCHIVED) in memory (the ZIP central directory and
  the archived-name list, written last by the format). Refused candidates never
  stay in memory: they go to an unlinked scratch file in the job directory that
  is metered against the user's quota and the free-space floor like the ZIP
  itself.
- Observability: `GET /api/v1/counters` → `media_jobs.lanes.export` and
  `media_jobs.lanes.export_file` `{active, queued, max}` show a backed-up lane.

**Proxy: stream the download route unbuffered.** Downloads can be many GB.

- nginx: give `/dedalo/export/artifact/` its own location with
  `proxy_buffering off`, as all the shipped nginx configs do. With buffering
  on, nginx writes up to `proxy_max_temp_file_size` (1 GB by default) of every
  download into its own temp directory. That is disk I/O the stream does not
  need, and one more on-disk copy of the records, outside the engine's TTL and
  owner checks.
- Apache: needs the `ProxyPass /dedalo/export/artifact/` line of
  `deploy/apache.conf`.
- The engine sends `Content-Length`, `Content-Disposition: attachment`,
  `Cache-Control: no-store` and `Content-Security-Policy: default-src 'none'; sandbox`.
- Every refusal is a 404 `resource.not_found`, never a 403 (see the WC entry).

```nginx
location /dedalo/export/artifact/ {
    proxy_pass http://dedalo_ts;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_buffering off;
}
```
