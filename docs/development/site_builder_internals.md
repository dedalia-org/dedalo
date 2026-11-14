# Site builder internals

## Scope

How the [site builder](../administration/site_builder.md) works under the hood, for developers
extending, debugging, or reviewing it. It covers the two processes, the request and trust
model, and the internals of each subsystem with the file paths and symbols to start from.

For the operator's view (enabling it, who can do what) see the
[overview](../administration/site_builder.md); for configuration and prompt examples see the
[cookbook](../administration/site_builder_cookbook.md).

## Architecture at a glance

The feature is two independent processes joined by one HTTP contract:

```
Browser (Dédalo client)
   │  tool_request RQO  (session cookie + CSRF)
   ▼
Dédalo engine ── tools/tool_sitebuilder/          proxy: authorize, then forward
   │  HTTP + Authorization: Bearer <token> + X-Dedalo-User-Id/Username
   ▼
Site builder daemon ── publication/site_builder/  (may be a different host)
   │  spawns the coding agent, whose MCP points at ▼
   ▼
Publication API v2 ── read-only MariaDB           the published data
```

The **daemon** is a standalone Bun/TS service modelled on `publication/server_api/v2`: its
own `.env`, its own systemd unit, a dedicated OS user, and **no engine code, no engine
Postgres, no `../private/`**. The **engine tool** is a thin proxy plus a vanilla-JS
workspace client. The only coupling between them is the HTTP contract and a shared bearer
token. That is what lets the daemon run co-located or on a separate host with identical
code, and why deleting a workspace can never affect the engine or a live production site.

## Request and trust model

Authorization happens in the engine; the daemon executes and records.

1. **Browser → engine.** Every workspace action is a normal `tool_request` over
   `dd_tools_api` carrying the user's session cookie and CSRF token. The browser never
   contacts the daemon.
2. **Engine authorizes, then proxies.** `dispatchToolRequest`
   (`src/core/tools/dispatch.ts`) runs the standard tool gates first — the tool must be
   active in the registry and granted to the user. Then the tool handler runs;
   `publish`/`get_audit` additionally require a developer or global admin, checked in the
   handler. `daemon_client.ts` forwards the call with the shared token and the acting user's
   identity.
3. **Daemon trusts and records.** It verifies only the bearer token
   (`src/security/auth.ts`, constant-time compare). It does not re-authorize — it trusts the
   engine's decision and records the actor (`src/audit.ts`) in an append-only log. Every
   mutation requires an `actor: {user_id, username}` in the body.
4. **Agent reads only published data.** A turn's agent is handed an MCP config pointing at
   `<PUBLICATION_API_URL>/mcp` — the existing read-only endpoint — so a generated site's only
   data reach is the public data, never the work-system Postgres.

## The daemon

Bun/TS, loopback on port 3200 behind a reverse proxy, mounted at
`BASE_PATH=/publication/site_builder`. No database: durable state is the filesystem.

### Boot and configuration

`src/config.ts` BUILDS its source once — it parses a named environment file, merges a
three-key ambient allowlist (`DEDALO_SITE_INSTANCE`, `NODE_ENV`, `LOG_LEVEL`), then layers
`$CREDENTIALS_DIRECTORY`, where a credential always wins — validates it with a Zod schema,
freezes the result and `process.exit(1)`s on any invalid value or unknown key. It does NOT
read the rest of `process.env`, and nothing downstream reads it at all: every consumer
imports `config`. `DEDALO_SITE_INSTANCE`, `SERVICE_TOKEN` (≥32 chars, delivered as a
credential), `PUBLICATION_API_URL` and the three roots (`SITES_ROOT`, `AUDIT_DIR`,
`WEBSPACE_BASE`) are required. LLM provider keys live only here.

On a provisioned host that environment file is **generated** from the museum's declaration
and delivered by the generated systemd unit; the daemon never reads a hand-written one. See
*The provisioner* below.

`src/index.ts` is the `Bun.serve` boundary. It boots through ONE sequence
(`src/boot.ts`): the roots preflight, then the instance claim (the listen target is not
already served and, under `systemd_scope`, PID 1 names this process as the daemon unit's main
process; otherwise the boot exits before anything is stopped or swept), then
`reconcileAgentUnits()` — every site's live agent
runs read back from PID 1, a leftover quarantining its site until PID 1 reports it dead, and
a still-running pre-per-site-identity transient run of the museum quarantining every site —
then `sweepOnBoot()` (session recovery, below), and only then does it listen. The steps
themselves are built by `daemonBootSteps()` in the same module, so a gate runs the real
reconciliation against a stand-in PID 1. Shutdown (`shutdownSequence()`) first refuses every
new confined run, then drains in-flight work, then marks live turns interrupted. Each agent
unit is `BindsTo=` the daemon, so a connect while the daemon is being stopped would start a
unit and cancel the daemon's own stop. PID 1 stops the live runs BEFORE the daemon receives
SIGTERM, so the daemon's own refusal cannot cover that window alone: every agent socket is
`PartOf=` the daemon unit, which gives it a stop job in the daemon's stop transaction, and a
socket with a stop pending accepts no connection. The daemon unit `Wants=` the sockets back on
start. A turn whose commit was refused during shutdown is marked `recovery_pending`, and the
next boot's sweep commits it as a recovery point.

### HTTP surface and auth

`src/router.ts` is a hand-rolled exact-arity segment matcher. Auth runs before a route is
matched: every route except `GET /health` requires the bearer token, so an unauthenticated
probe learns nothing about which routes exist. Errors are thrown, never constructed inline,
and rendered as RFC 9457 `application/problem+json` by `src/util/response.ts`; the taxonomy
is in `src/errors.ts` (`ValidationError` 400, `UnauthorizedError` 401, `NotFoundError` 404,
`ConflictError` 409, `LimitExceededError` 429, `ServiceError` 500). The `type` URI and the
`reason` extension are the stable machine-readable fields the engine matches on.

Route groups: site CRUD (`routes/sites.ts`), sessions (`routes/sessions.ts`), builds
(`routes/builds.ts`), publish/releases/rollback/audit (`routes/publish.ts`), plus
`routes/health.ts` and `routes/capabilities.ts`.

### Site workspaces

A site is a directory under `SITES_ROOT/<slug>/`:

```
SITES_ROOT/<slug>/
├── site.json      # daemon-owned manifest (zod-validated, atomic tmp+rename writes)
├── AGENTS.md, CLAUDE.md → AGENTS.md   # the agent's brief
├── .builder/      # gitignored daemon state: sessions/*.jsonl+meta, builds/*.log+json, mcp.json
├── .git/          # first commit = the scaffolded template; one commit per agent turn
├── package.json, index.html, src/…    # agent-owned site source
└── dist/          # build output (gitignored)
```

- **Manifest** (`src/sites/manifest.ts`): `SiteManifest` is validated on every read (a
  corrupt manifest fails loudly) and written atomically. `owner_user_id` is informational —
  the model is collaborative, so it drives display and audit, not authorization.
- **Slug grammar** (`src/util/slug.ts`): `^[a-z][a-z0-9-]{1,39}$`. Every filesystem
  operation additionally goes through `src/util/paths.ts` (`confinedPath` /
  `confinedRealPath`), which refuses a path that escapes its root lexically or via a symlink.
- **Templates** (`src/sites/template.ts`): shipped under `templates/`. Scaffolding copies the
  tree and substitutes placeholders (currently `__PUBLICATION_API_URL__`). Adding a template
  is dropping a directory with a `template.json` — no code change.
- **Git** (`src/sites/git.ts`): every turn is committed with a constructed environment (no
  ambient git config, a fixed service identity). `changedFiles()` derives a turn's edits from
  `git status --porcelain` — the driver-agnostic file-change backstop.
- **AGENTS.md** (`src/context/agents_md.ts`): generated per site with the brief, the API URL,
  the MCP tool list, a best-effort schema summary fetched from the API, and the rules (static
  output only, no secrets, don't touch `site.json`/`.builder/`).

### Agent sessions

`src/sessions/manager.ts` is the orchestrator. A **session** is a chain of **turns**; each
turn is one agent CLI invocation, linked to the next by the driver's native resume token.

- **Concurrency**: at most one active turn per site (an in-memory lock plus a
  `.builder/session.lock` pid file), and at most `MAX_CONCURRENT_SESSIONS` turns across all
  sites (a global counting semaphore). A second start on a busy site is a 409; over the cap
  is a 429; a workspace over `SITE_DISK_QUOTA_MB` is refused.
- **Deleting a site holds it too**: a delete is refused with a 409 that names what is running
  (`session_running`, `build_running`, …) while a turn, a build or a repository operation
  holds the site, and removes nothing. While a delete runs, every other request on the site
  is refused `site_deleting`. A turn or build that was admitted while a delete finished
  answers 404 and re-creates nothing.
- **The turn runner** (`runTurn`): spawns the driver **before** the first `await` (so
  `stopSession` can never race in and find no process), persists a `turn_start` marker,
  consumes the driver's normalized events, derives the file-change list from git, commits the
  workspace, then writes `turn_end` and the updated meta — always releasing the slot and
  clearing state in `finally`.
- **The event log** (`src/sessions/events.ts`, `store.ts`): every event is appended to a
  per-session JSONL file with a monotonic `seq` **before** it is fanned to live subscribers,
  so the log is authoritative. `SessionEventBody` is the driver `AgentEvent` union plus two
  daemon markers (`turn_start`, `turn_end`).
- **The SSE endpoint** (`src/sessions/sse.ts`): replays the durable log from the client's
  cursor (`?after=N`), then live-tails. To avoid a gap at the replay/tail seam it subscribes
  **first** (buffering), replays the file, then flushes buffered live events deduped by
  `seq`. It closes on `turn_end`, and sets `X-Accel-Buffering: no` for the proxy.
- **Boot recovery** (`sweepOnBoot`): any session left `running` by a dead process is marked
  `interrupted`, its uncommitted work is committed as a recovery point, and the
  session→slug index is rebuilt.

### Drivers (the pluggable agent)

`src/drivers/types.ts` defines the `AgentDriver` seam — the thing that makes the agent
pluggable. Every driver is a CLI subprocess and presents three things: `detect()` (is the
binary present and its version tested), `capabilities`, and `startTurn()` returning an
`AgentProcess` whose `events` are the normalized `AgentEvent` stream. The manager talks only
to this interface, so adding an agent is a file under `drivers/` plus one registry line.

- `src/drivers/process.ts` is the shared supervision: `spawnAgentProcess` takes a driver's
  argv and its per-line parser, hands them to the confinement, line-buffers the run's
  stdout, pushes parsed events onto an async `EventQueue`, synthesizes a terminal
  result/error, and implements `interrupt()` (an interrupt that lands while the run is being
  opened starts nothing). Every error event it emits is a reason (`src/drivers/turn_errors.ts`),
  never the thrown sentence, which goes to the daemon's log. It spawns NOTHING itself. The run's environment is
  `SessionStartOptions.env` — a tight allowlist the manager builds, with no `HOME` (the unit
  fixes it) — with the driver's own statement (`TurnPlan.env`, opencode's restriction) merged
  over it, so the daemon's value always wins. **Spreading `process.env` would hand a coding
  agent the daemon's token and provider keys**; the allowlist is the secrets boundary.
- `src/drivers/confinement.ts` decides what a run RUNS AS — a turn, a build step and a git
  command alike (`confineTurn` / `runConfined`) — and under
  `AGENT_CONFINEMENT=systemd_scope` (what a provisioned host renders) **the daemon starts
  nothing** (LEAD-1b). Every declared site has its OWN unix identity, `dedalo-a-<instance>_<k>`
  (primary group the instance's, plus a private group holding exactly that identity and the
  service user), and root renders, per site and per door (turn / build / git), a socket, a
  target and a service template (`src/provision/render/agent_units.ts`): `User=` the site's
  identity, the hardening set, the caps (`MemoryMax`, `CPUQuota`, `TasksMax`, and a
  `RuntimeMaxSec` PID 1 enforces even if the daemon dies), `ReadWritePaths=` the site's own
  workspace, a masked agent state root with only that door's own HOME bound back, and the
  network design. The socket is `Accept=yes`, `MaxConnections=1`, `0600` to the service user;
  the three doors of a site are mutually exclusive (`Conflicts=` on their targets), so a site
  never has two runs at once. A run is: the site's reservation held; PID 1 asked that the site
  is idle (a live leftover is stopped, and one that will not die QUARANTINES the site until
  PID 1 reports it dead); what PID 1 LOADED checked against what the daemon expects
  (`systemctl show` — a unit file silently ignores a key its systemd does not know, so a
  mismatch refuses naming the property); the site's egress gate opened; ONE `connect()` to
  the site's socket — never retried — whereupon PID 1 starts an instance as the site's
  identity; a hello frame from the shim, the run's spec (argv, env, the daemon's namespace
  identity) as ONE frame over the connection, and its output relayed back as frames ending in
  an exit record (`src/drivers/unit_frames.ts`; a connection that ends without one is a
  FAILURE, never exit 0). The site is freed only once PID 1 reports the instance dead. No
  file is written for PID 1 to read, and no unit property carries a secret. The polkit rule
  grants the service user `stop` and `kill` on this museum's DECLARED sites' run instances,
  enumerated — never `start` (polkit is shown no run-as uid, so a start grant was root, F2).
  The network design is `src/drivers/network_profile.ts`, the one producer of every network
  property a unit gets: every run is in a private network namespace with `/run` masked, so
  host loopback, the LAN, the metadata service, the DNS stub, abstract unix sockets, every
  site's control sockets and every service socket under `/run` do not exist inside it; the
  database directories a distro keeps a socket in outside `/run` (RHEL's MariaDB default is
  `/var/lib/mysql/mysql.sock`) are made inaccessible by name, and each unit gets its own
  `/dev/shm` and IPC namespace, so two runs share no world-writable directory and no SysV IPC
  key. A turn or a build gets exactly one way out — its SITE's socket directory
  (`/run/dedalo-sites-agents/<instance>/egress/s<k>`, root's — created from a rendered
  tmpfiles.d file, root:<the site's private group> `0770` — with sockets `0660`), bound
  read-only at `/run/dedalo-egress` and served by the daemon's egress gate (`src/egress/gate.ts`),
  which refuses a directory that is not exactly that: a
  CONNECT proxy that tunnels only to the HOSTNAMES on the run's plan, port 443, after refusing
  any name that resolves to a non-public address, plus (turns only) the Publication API's MCP
  endpoint with the API key added on the daemon's side, so the key never enters the unit. A
  git command gets no way out at all. No run can reach another site's gate: only its own is
  bound in, and another site's run is another uid — not visible in `/proc`
  (`ProtectProc=invisible`), and unable to open the other site's sockets by DAC alone; on
  systemd 257 and newer each run also gets its own PID namespace (`PrivatePIDs=`), an extra
  layer the floor does not require. The gate holds at most 128 connections per run at once
  (the daemon's file descriptors, which the unit's own limits do not bound); one more is a 503
  with a line in the run's log. The gate dials each vetted address of the ONE lookup in turn
  until one connects, so a dead first address does not fail the run. It opens only on a plan
  of hostnames, and once a tunnel is up it forwards nothing until the client's first flight
  is a TLS ClientHello whose SNI is the CONNECT host (Encrypted Client Hello refused): a plan
  host on a shared CDN would otherwise be a way to any site behind that CDN. The Host inside
  the encrypted session is beyond it: a stated residual of the instance specification, as is
  HTTP/2 reuse of a connection for another name the same certificate covers. The unit's
  ExecStart is `src/drivers/egress_shim.ts`, which refuses to run anything (exit 78) unless it
  can PROVE the namespace is in effect — its namespace identity differs from the daemon's
  (carried in the spec; a missing identity is a refusal, not a skipped check) and it sees no
  interface but its own `lo` — refuses a spec that sets any key the unit fixes (`HOME`,
  `DEDALO_*`, the transpiler cache, git's configuration, and on the turn door
  `XDG_CONFIG_HOME`, `CLAUDE_CONFIG_DIR`, `XDG_DATA_HOME`, `XDG_STATE_HOME`,
  `XDG_CACHE_HOME`), and then runs the argv in the
  workspace and forwards the unit's loopback to the gate's sockets. The host is refused up
  front (503, naming what is missing) when any of this cannot hold: PID 1 is older than the
  floor, 248 (`PrivateIPC=`), or its release cannot be read; a declared site has no identity,
  or an identity is not what `provision apply` created (its uid shared or root's, its primary
  group not the instance's, its private group holding anyone else — as a listed member or as
  another account's PRIMARY group, which no group line lists — or the daemon not yet in
  it); the daemon's runtime directory (`dirname(LISTEN_SOCKET)`) does not resolve under
  `/run`, the one mask that hides its socket and every site's `egress/` from a unit; the
  daemon cannot read its own namespace identity; or the shim, one of the modules it imports,
  or the runtime is owned or writable by ANY site identity (the file or a directory above
  it; a directory an identity owns counts as writable whatever its mode says, sticky or not),
  unreadable or unexecutable by one, or under a prefix the unit masks. Root, the daemon and a
  third uid — the engine's, which owns the checkout and its bun — are all acceptable owners.
  The same questions are asked before a turn, a build or a site CREATE reserves anything (a
  create's first `git` is a confined run too, so a site the daemon has no identity for yet is
  refused before its workspace is written), and again when the run opens; every NSS lookup
  among them is asynchronous, so a slow directory service delays that run and never the event
  loop the other sites' streams share. A session's resume token is stamped with the identity epoch (`AGENT_IDENTITY_EPOCH`); one
  minted under another identity — or with no epoch at all, a session from before per-site
  identities — is dropped, with a `resume_unavailable` event in the session log, rather than
  replayed. `provision apply` moves the epoch exactly when a site's identity changed, which it
  reads off the host (the env's binding against the ledger), so an apply that died half-way
  still moves it on the next run. `AGENT_CONFINEMENT=none` is the declared laptop/container mode,
  is refused under `NODE_ENV=production`, and makes every turn announce itself into its own
  durable session log (a build step announces into the build log). The tree the uids share
  states its modes explicitly (`src/util/shared_tree.ts`: directories 2770 setgid, files
  0660, the daemon's own `.builder/` 0710 — traverse-only, so the site's identity can open the
  per-turn `.builder/mcp.json` it is handed and list or write nothing — with everything inside
  it 0700/0600) because the daemon's `UMask=0027` would otherwise
  hand a site's identity a workspace it can read and never write — and that same module is
  the only way the daemon writes into the tree, creating each directory level and opening
  each file `O_NOFOLLOW` with the mode set on the descriptor, so a symlink a run planted where
  the daemon writes is a refusal rather than a redirect — every writer, not only the
  workspace-building ones: the git exclusion rewritten on every commit, both drivers' MCP
  configs and the session store go through it too, and the gate's census is total over
  `src/` and asks about the DESTINATION rather than the directory a module happens to live
  in. A HARD link is refused as well (the link count is read off the handle before anything
  is truncated), and a directory that already exists is proved, never re-moded, so a build's
  `.builder/builds` cannot widen the daemon's own `.builder/`. The READS are the same door and
  the same census: `getBuild`, `getBuildLog`, `latestBuild`, `readManifest`, `replayEvents`,
  `readMeta` and `listSessions` go through `readFileShared`/`readFilePrivate`/`readdirShared`,
  because a `readFile` on a lexical path follows a planted link too — measured, a link at
  `.builder/builds/<id>.log` was served through `GET /sites/<slug>/builds/<id>` with the
  daemon's `SERVICE_TOKEN` in it. An absent file answers `null`, a planted one throws, and the
  daemon's own state also refuses an inode it does not own (an agent-authored build record is
  not the daemon's word about a build). The build record and the session meta are written
  tmp+rename through that same door, so a poller never reads a half-written one.
- `claude_code.ts` runs `claude -p … --output-format stream-json --mcp-config …` and parses
  the stream-json frames; `opencode.ts` runs `opencode run --pure --format json [--session
  <id>] -- <prompt>`; `pi.ts` is a `detect()`-able stub that refuses a turn rather than
  inheriting a default. Claude Code reads its MCP config from `.builder/mcp.json` — `0640`,
  and DELETED when the turn ends, because it carries the museum's Publication API key into a
  directory an agent writes to. OpenCode's whole configuration (the publication `/mcp`
  server, a `permission` block, and the brief as its one instruction file) rides
  `OPENCODE_CONFIG_CONTENT` in the child's own environment; the one file the daemon writes for
  it is that brief — `AGENTS.md` read by the same bounded, link-refusing reader as Claude
  Code's (`src/drivers/brief.ts`), written to `.builder/opencode-brief.md` (`0640`, fd-based)
  and deleted when the turn ends. Each STATES its tool set rather than inheriting one: Claude Code
  gets an explicit `--allowedTools` with `Bash`, `WebFetch` and `WebSearch` in
  `--disallowedTools`; OpenCode's permission block denies `bash`, `webfetch`, `websearch`,
  `codesearch`, `skill`, `task` and `external_directory`, and allows `edit`.
- **PLANT for OpenCode** (LEAD-1c, `src/drivers/opencode_argv.ts` is the one spelling): what a
  turn loads is the daemon's statement, never the workspace's or HOME's. The restriction
  (`OPENCODE_DISABLE_PROJECT_CONFIG`, `OPENCODE_PURE` plus `--pure`,
  `OPENCODE_DISABLE_CLAUDE_CODE`, `OPENCODE_DISABLE_EXTERNAL_SKILLS`,
  `OPENCODE_CONFIG_CONTENT`, and `OPENCODE_PERMISSION` — the one key opencode lets override a
  configuration's permissions, measured on 1.18.32) turns off the workspace `opencode.json`,
  `.opencode/` agents, tools, plugins, commands and skills, and the `.claude` / `.agents` skill
  trees; HOME comes from the HOME law below. `OPENCODE_ENV` is an ALLOWLIST of provider
  credentials (`OPENCODE_API_KEY`, `OPENCODE_AUTH_CONTENT`, or a provider's key named
  `…_API_KEY`, `…_AUTH_TOKEN`, `…_ACCESS_KEY_ID`, `…_SECRET_ACCESS_KEY` or `…_SESSION_TOKEN`): any other key
  stops the daemon at parse, naming it. The CREDENTIAL STORE is a configuration source too (a
  `wellknown` entry makes opencode fetch and merge `<url>/.well-known/opencode` on every turn —
  an extra local MCP server, an agent prompt; measured on 1.18.32), so every turn states
  `OPENCODE_AUTH_CONTENT` — the operator's, holding `api`/`oauth` entries only (refused at parse
  otherwise), else `{}` — and opencode never reads the `auth.json` a turn could write into its
  state. The same statement switches opencode's own off-plan traffic off (auto-update, the
  models catalogue, LSP downloads, share) in every mode, and NAMES its database (`OPENCODE_DB`).
  A CONSOLE ACCOUNT is a configuration source no key closes (an active org makes every start
  fetch `<account url>/api/config` and merge it after the daemon's configuration — a local MCP
  server reached a fully restricted turn, measured on 1.18.32), so every admission reads the
  turn's database and refuses while it holds any console account
  (`confinement.agent_cli_unsupported`, naming the `opencode console logout` to run); a database
  that cannot be read cannot be proved clean and is refused too. Before any turn of a binary runs, the driver PROBES it
  (cached per binary inode and operator environment, and only when every question answered):
  it plants one canary per SOURCE, each with its own random token, in a daemon-private scratch
  tree under `AGENT_STATE_ROOT/probe/`, and asks `opencode debug config`, `debug agent build`
  and `debug skill` twice, with npm offline — a CONTROL without the four switches, where every canary
  must surface (a probe that cannot see a source proves nothing about it), and exactly the
  turn child's environment (the one function `declaredUnconfined` spawns with: its persistent
  `unconfined/turn/state` as data/state/cache, where opencode keeps its database, and the
  turn's own network — no proxy, as under `none` there is none), where none
  may and the resolved configuration must be EXACTLY the daemon's (its MCP server and no other,
  every permission, exactly its instruction file, no agent or command definition). It also asks
  `opencode db path` and refuses a binary that does not open the database the daemon states (the
  file admission reads for an account). The answer is
  cached, so state a later turn writes is seen at the next probe, not the next turn — under
  `none` there is no uid boundary to hold it anyway. Any failure refuses the driver
  (`confinement.agent_cli_unsupported`, at `detect`, admission and setup), naming the source;
  so does a `run --help` (read from stdout and stderr: yargs writes it to stderr) lacking a flag
  the argv passes. A probe that could not ASK — any question past its 10 s bound (`--version`,
  `run --help` and the `debug` questions alike), a spawn or a scratch tree the host
  refused for want of resources — and proved nothing against the binary is refused retryable
  instead (`confinement.agent_cli_unproved` → `site_builder.busy`) and asked again next attempt.
  One probe per binary and operator environment runs at a time; every door joins it. `detect`
  (the unauthenticated `/health`) waits for it at most 3 s (then "unavailable" while it runs
  on) and serves an unproved answer for 60 s before starting another, so a caller of `/health`
  cannot make the daemon spawn a probe per request (constants in `src/drivers/opencode.ts`). The live leg is `deploy/probes/opencode_plant_probe.ts`. Under
  `systemd_scope` the driver stays refused, DERIVED from what phase B needs: a root-owned
  per-run mount for opencode's configuration directory and a decided home for its provider-SDK
  cache.
- `src/drivers/registry.ts` maps `DriverId → AgentDriver`, exposes `detectDrivers()` (backs
  `/health` and `/capabilities`), and a test-only `__setTestDriver` seam.

### Build and publish

- **Build** (`src/build/builder.ts`): `startBuild` writes a `running` record and returns a
  `build_id` (the route answers 202); the work runs detached. `executeBuild` runs the
  manifest's install then build commands (no-shell argv via `src/util/spawn.ts`, output to a
  log), verifies the output directory exists, and promotes it. It never throws out — every
  path funnels to one terminal record so the per-slug lock always clears. A build is refused
  while a session runs (they would race on the tree).
- **Promote** (`src/build/promote.ts`): copies the built output into
  `<webspace>/.releases/pre/<release>/`, then flips the served symlink `<webspace>/pre` by
  writing a temp link and `rename`-ing it over the target — atomic on the same filesystem, so
  the web server never sees a half-updated site. The symlink target is relative (the tree
  stays relocatable). A symlink in the build output is REFUSED rather than copied into a
  served tree. Old releases beyond `RELEASES_RETAINED` are pruned, never the current one.
  The webspace is READ, never derived: the provisioner publishes every site's placement into
  `<config dir>/sites.json` (a generated, stamped artifact) and the daemon looks the site up
  there by slug (`src/sites/site_table.ts`). A site with no row, or whose webspace is missing
  or belongs to another instance, is refused by name. The daemon computed
  `<WEBSPACE_BASE>/<domain>` for itself until 2026-08-29, which disagreed with the vhosts for
  any site using the declaration's `sites[].webspace` override.
  The build output itself is proved before it is copied — the directory must not be a symlink
  and its realpath must lie inside the workspace — because an agent turn owns that directory
  and a lexical path check is a question about a string.
- **Publish** (`src/build/publish.ts`): copies the **current preprod release** (the exact
  bytes previewed) into the same site's `web` release store and flips the `web` symlink — it
  does not rebuild. Two stores, never one shared: sharing them would let preprod's pruning
  delete the bytes production is serving.
  Production is an independent copy, so a workspace delete never takes down a live site.
  `rollbackSite` re-activates any retained prod release.

### Serving

Reverse-proxy configuration is **generated, not shipped**: `src/provision/render/nginx.ts`
and `render/apache.ts` render one vhost per site per surface from the host's declaration, so
a site's document root, its server name and its TLS block are derived rather than typed.
Create/build/publish/rollback need **zero web-server reloads and no root at runtime** — the
daemon only ever swaps a symlink under the served root. The pre-production vhost carries
basic auth against a per-instance password file when the declaration asks for it. The
complete rendered output of a reference declaration is committed, for both web servers,
under `publication/site_builder/deploy/examples/`, so what lands on a host can be read
without running anything.

## The provisioner

`src/provision/` is the ops half of the subsystem: an **instance** — one museum's tenancy —
is declared once, and every host artifact is a pure function of that declaration. The
division of labour is the design, and it is what makes the whole thing testable without a
host to provision:

| Module | Responsibility |
|---|---|
| `schema.ts` | Validates `instance.json`. Strict objects, no unknown keys, no relative paths, and a walk over the RAW document that refuses an inlined credential anywhere in it. |
| `layout.ts` | **Derives** everything: the grammars, the default paths, the identity prefix and its arithmetic, the mode matrix, the containment predicate, the per-surface path pair. It owns every constant; `schema.ts` imports them rather than restating them. |
| `fleet.ts` | What is declared under the config directory, and a named refusal for a bad declaration. |
| `render/*` | One pure renderer per artifact — `unit`, `env`, `sites`, `nginx`, `apache`, `engine_fragment` — behind `renderAll()`. Each output carries a body-hash stamp naming its instance (`hash.ts`). |
| `plan.ts` | **Pure**: `(layout, manifest, hostState) => Action[]`. Ordering, drift detection and idempotency are properties of that array, so a gate asserts on the plan instead of on a live host. |
| `apply.ts` | **Dumb**: executes an already-decided plan. Writes only on drift, reloads systemd only when a unit changed, never reloads a web server after a failed config test. `check()` is the same report with no io at all. |
| `verify.ts` | The serving proof: for every slug and surface, does the served link resolve, does its target hold bytes, and is it still the release the site claims to publish. |
| `adopt.ts` | Infers a declaration from a live pre-instance install, moves its credentials into root-owned files, retires the old ones — then calls the ordinary `plan()`/`apply()`. |
| `remove.ts` | Decommissioning, also as a pure plan. Archives (renames) rather than deletes, unlinks only artifacts whose stamp proves this instance wrote them, and never frees a uid. |
| `cli.ts` | `bun run provision <verb>`: arguments, targets, output, exit codes — and no rule about what a host should end up holding. |

Two properties are worth carrying in your head when editing here.

**Nothing is derived twice.** The recurring defect of this subsystem has been two
independent derivations of one fact, each invisible to a green suite — the schema and the
layout owning different bounds, the daemon computing a webspace the provisioner did not use,
a hand-kept artifact census beside `renderAll()`. `test/unit/site_builder_single_source_tripwire.test.ts`
in the engine repo is the ratchet: per fact, the files entitled to derive it are frozen in a
baseline, and a new second derivation is red by default.

**A credential value never enters a plan.** A plan is printed, so `FileContent` has no
source that carries a literal secret. `apply` can mint a random token and can hash a
password file, but the one place a credential value exists in the adoption path is
`PreInstance.credentials`, kept in its own field so that "does this record carry a secret" is
answerable by reading a type, and leaving it exactly once — into a `0600` file.

Operator-facing procedure (declaring, provisioning, adopting, decommissioning, backups) is in
the [site builder management page](../administration/site_builder.md).

## The engine tool

`tools/tool_sitebuilder/` — a standard tool package (server module + vanilla-JS client).

### The proxy layer

`server/daemon_client.ts` is the only place the engine talks to the daemon. It attaches
`Authorization: Bearer <token>` (from `config.siteBuilder.token`) and the acting user's
identity, applies a timeout to control calls (not to the stream), and maps every transport
failure and daemon problem onto a registered `site_builder.*` code (`server/wire.ts`). The
token and the daemon's address never appear in a response the engine relays to the browser.

**The code is the message.** The browser renders a refusal from its code's label, so every
refusal has a code of its own and no `site_builder.*` throw carries prose to the wire:

- Transport and pairing: `unconfigured`, `unreachable`, `auth`, `instance_mismatch`,
  `stream_lost`, `failed`.
- Each machine `reason` the daemon sends (the reason lists in the daemon's `src/errors.ts`)
  maps through the reason map in `server/wire.ts`, which is typed exhaustive over that union
  and gated equal to the runtime list:
    - the six busy reasons (`session_running`, `build_running`, `site_initializing`,
      `site_recovering`, `git_running`, `site_deleting`) → `busy` (503, retryable);
    - `slug_exists`, `workspace_exists`, `domain_taken`, `webspace_unavailable`, `no_build`,
      `not_running` → the code of the same name (409);
    - `max_sites` → `site_limit`, `disk_quota` → `disk_quota` (429), and
      `max_concurrent_sessions` → `capacity` (429, retryable);
    - `confinement_unavailable` and `confinement.*` → `confinement_unavailable`, or `busy`
      for the conditions that clear by themselves (`site_busy`, `identity_quarantined`,
      `daemon_stopping`, `agent_cli_unproved`).
- The engine's own refusals, decided before the daemon is asked: `invalid_slug`,
  `invalid_id`, `name_required`, `domain_required`, `text_required`,
  `confirmation_required`, and the two permission refusals `not_permitted` and
  `not_session_owner` (403, not `perm.*`, which would replace the tool panel with the
  no-access page).
- `rejected` remains only as the fallback for a daemon 4xx that carries no reason. A reason
  the engine does not know (a daemon newer than the engine) also falls back by status, with
  one log line naming the reason.

The daemon's `detail` prose is log-only in every case — on BOTH doors:

- **The control door** (a problem+json answer to a request) carries the machine `reason`
  above; `src/util/response.ts` emits it only when it is one of the daemon's listed reasons
  (a reason a cast smuggled past the type is dropped and logged).
- **The stream door** (`session_stream`, a running turn's events) carries one too. An error
  event is `{type:'error', reason, retriable}` (`src/drivers/turn_errors.ts`): the refusal's
  own reason, or the supervisor's fault for the step that failed (`turn_timeout`,
  `turn_interrupted`, `turn_setup_failed`, `turn_unit_lost`, `turn_agent_killed`,
  `turn_agent_exited`, `turn_failed`). A terminal fault is ONE error: a deadline or a
  requested stop is the turn's error (`turn_timeout`, `turn_interrupted` — before the agent
  started or while it ran), never also the exit it caused. An agent that exited non-zero adds its stderr tail as
  `agent_output` — the agent's own words, labelled and bounded, never the error's text. The
  daemon's replay failure is the frame `event: error` `{reason:'replay_failed'}`. The engine's
  relay (`server/wire.ts` `relaySessionFrames`) turns each error record into the converter's
  body for the code its reason maps to (`turn_agent_exited` → `agent_failed`,
  `turn_setup_failed`, `turn_timeout`, `turn_interrupted` and `replay_failed` → codes of the
  same name, the rest of the faults → `failed`), passes every other record byte-for-byte, and
  never flushes a record raw. A record with no reason or an unknown one is `failed`.

### The transport, and the pairing it proves

One museum is one Dédalo install paired with exactly ONE site-builder instance, so the engine
holds one address and there is no tenant map on either side. `src/core/site_builder/pairing.ts`
resolves that address once, for both readers (the tool and the maintenance panel):

| key | meaning |
|---|---|
| `DEDALO_SITE_BUILDER_SOCKET` | the daemon's per-instance unix socket. When set it IS the transport, and its `0660 <daemon user>:<engine group>` ownership is the whole access decision — no port, no firewall rule, no other account on the host able to connect. |
| `DEDALO_SITE_BUILDER_URL` | a daemon reached over the network instead. With a socket also set, it contributes only the path prefix and the host name. |
| `DEDALO_SITE_BUILDER_INSTANCE` | the tenancy the engine is paired with. Required as soon as either transport is set. |

A HALF configuration — a transport with no instance, or no token — resolves to no transport
at all: the tool hides itself and every action refuses.

Before the first byte of any call (the event stream included) the engine PROVES the pairing.
The daemon publishes, on its one unauthenticated route, `GET /health` →
`instance_fingerprint = sha256("dedalo-site-instance:" + instance + "\n" + SERVICE_TOKEN)`;
the engine recomputes it from its own instance name and token and refuses on any difference
with `site_builder.instance_mismatch`, having sent nothing — not the token, not the actor,
not the request. Equal hex proves both the identity and the shared credential while
disclosing neither, and a wrong instance, an unknown instance and a wrong token are
indistinguishable to the caller, so the refusal is not an enumeration oracle. The reason it
exists: a private environment file copied from one museum's server to another's used to point
one engine at the other's daemon undetectably, which means one museum's staff driving an
agent inside another's website, on that museum's budget and public domain.

The pairing lines are not typed by hand. The daemon's provisioner renders them as
`<config dir>/engine.env.fragment`, and `bun run scripts/site_builder_pair.ts <fragment>`
appends them to this install's private environment file: documented keys only, idempotent, a
refusal (not a duplicate line) when a key is already present with a different value, and a
refusal to append the token placeholder — pass the daemon's root-owned credential file with
`--token-file` instead. It never prints a token.

### apiActions and permissions

`server/index.ts` exports the `ToolServerModule`. Every action first checks `isConfigured()`
and fails closed. All actions sit behind the tool grant (`permission: null` = the grant is
the gate); `publish` and `get_audit` add an imperative `isDeveloper || isGlobalAdmin` check.

| action | daemon call | gate |
|---|---|---|
| `get_status` | `GET /health` (+ computes `can_publish`) | tool grant |
| `list_sites` / `create_site` / `delete_site` | sites CRUD | tool grant |
| `session_start` / `session_message` / `session_stop` / `session_history` | session lifecycle | tool grant |
| `session_stream` | `GET /sessions/:id/events` (SSE) | tool grant |
| `build` / `get_build` / `preview` | build + preview | tool grant |
| `publish` / `get_audit` | publish / audit | tool grant **+ developer or admin** |

`isAvailable` returns false when `config.siteBuilder.url`/`token` are unset, so the tool
disappears from `user_tools` and every surface when the feature is not configured.

### SSE pass-through

The chat stream reuses the existing tool-dispatch stream seam rather than a new API handler.
`session_stream` returns a `ReadableStream` that forwards the daemon's SSE bytes verbatim;
its `cancel()` aborts the upstream fetch (browser closed → daemon leg torn down). The one
core edit for this feature is in `src/core/api/handlers/dd_tools_api.ts`: the `tool_request`
stream branch now merges an optional `body.streamHeaders` from the tool response (so the tool
can set `X-Accel-Buffering: no`), keeping the tool's `streamContentType`. That merge is
guarded by `test/unit/dd_tools_api_stream_headers.test.ts`.

### The client workspace

Vanilla JS under `tools/tool_sitebuilder/js/`, opened as a full-page window
(`register.json` `open_as: 'window'`). `render_tool_sitebuilder.js` builds a three-pane
layout (sites | chat | preview) and hands the pane nodes to a `sitebuilder_controller` cached
on the tool instance (so a re-render keeps the selected site and live session). The
controller is the single place that calls the server — through the tool's `tool_request`,
except the chat stream, which is an SSE `fetch` in `builder_stream.js` (a fork of the
assistant's stream client: spec-compliant SSE record parsing, JSON-vs-SSE content-type
branch, `turn_end` terminal handling). The controller holds no durable state — sites and
sessions live on the daemon; on boot it calls `get_status` then `list_sites`.

### The maintenance widget and launcher

The launcher is not in the top menu — it is an occasional, admin/developer action, so it
lives in **Area maintenance → Publication → Site builder**. `site_builder_status`
(`src/core/area_maintenance/widgets/site_builder_status.ts`) is a display-only widget whose
`eagerValue` probes the daemon (`/health` + the audit tail) fail-soft and discloses only the
host, not the full URL. Its client render
(`client/dedalo/core/area_maintenance/widgets/site_builder_status/js/`) shows the status and
an **Open site builder** button that launches the workspace via `open_tool`. The widget is
placed in the `publication` category (list view) and the `pub` node (System Map view) in
`client/dedalo/core/area_maintenance/js/render_area_maintenance.js`.

## Configuration keys

**Engine** (`../private/.env`, read via `config.siteBuilder`, catalog
`src/config/catalog/sitebuilder.ts`): `DEDALO_SITE_BUILDER_INSTANCE`,
`DEDALO_SITE_BUILDER_SOCKET`, `DEDALO_SITE_BUILDER_URL`, `DEDALO_SITE_BUILDER_TOKEN`,
`DEDALO_SITE_BUILDER_TIMEOUT_MS`. See the
[settings reference](../administration/configuration/config.md#sitebuilder). You do not type them: the provisioner
renders them into the instance's pairing fragment and `scripts/site_builder_pair.ts` appends
them.

**Daemon.** On a provisioned host the daemon's environment file is a GENERATED artifact —
`src/provision/render/env.ts` derives every key in it from the declaration, and a hand edit
is reported as drift and lost on the next `apply`. So the keys below are documented as what
the daemon *reads*, not as something anyone writes:

- Identity and transport: `DEDALO_SITE_INSTANCE`, `LISTEN_KIND`, `LISTEN_SOCKET`,
  `DEPLOYMENT_MODE`, `BASE_PATH`, and `PORT`/`HOST` for the standalone development case.
- Roots: `SITES_ROOT`, `AUDIT_DIR`, `WEBSPACE_BASE`, `SITE_TABLE_FILE`.
- Data source: `PUBLICATION_API_URL`, `PUBLICATION_API_KEY_FILE`.
- URL facts: `PREPROD_HOST_PREFIX`, `PROD_URL_SCHEME` — a site's address is otherwise built
  from its own domain.
- Agent: `AGENT_DRIVER` and the driver bins `CLAUDE_CODE_BIN` / `OPENCODE_BIN` / `PI_BIN`
  (absolute paths — a bare name resolved through the shared search path is a
  cross-instance substitution vector).
- Agent confinement: `AGENT_CONFINEMENT` (`systemd_scope` on every provisioned host,
  `none` only where it is declared and never under `NODE_ENV=production`),
  `AGENT_IDENTITIES` (declared slug → its identity's ordinal, from the host's ledger),
  `AGENT_UNIT_PREFIX`, `AGENT_SOCKET_DIR`, `AGENT_STATE_ROOT` and `AGENT_IDENTITY_EPOCH`
  (all derived per instance and rendered), plus the host-shaped `SYSTEMCTL_BIN` (rendered only
  from the declaration's `agent.systemctl_bin`, where `systemctl` is not `/usr/bin/systemctl`;
  never set by hand, because the plan reverts a hand edit to the rendered env), the per-run
  caps `AGENT_TURN_MEMORY_MAX` / `AGENT_TURN_CPU_QUOTA` / `AGENT_TURN_TASKS_MAX` (the same
  numbers root renders into every agent unit) and `GIT_TIMEOUT_MS`. The pre-LEAD-1b keys
  `AGENT_USER`, `AGENT_HOME` and `SYSTEMD_RUN_BIN` are RETIRED: an env that still carries one
  stops the daemon at parse, naming `AGENT_IDENTITIES`.
- Agent egress, by hostname only: `AGENT_PROVIDER_HOSTS` (an opencode/pi turn's model
  provider; Claude Code's `api.anthropic.com` is derived, and an opencode/pi turn with none
  is refused) and `BUILD_REGISTRY_HOSTS` (default `registry.npmjs.org`), rendered from the
  declaration's `agent.provider_hosts` / `agent.registry_hosts` when stated. Never an IP
  literal, `localhost` or a wildcard. Each driver switches its agent's own off-plan traffic
  off in the turn's env, in EVERY confinement mode (the egress keys reach a confined run only):
  Claude Code's auto-updater and non-essential traffic (`DISABLE_AUTOUPDATER`,
  `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` — `src/drivers/claude_code.ts`), and opencode's
  auto-update, models.dev catalogue, LSP downloads and share uploads. The opencode
  provider SDK installed on first use comes from `registry.npmjs.org`, which such a museum
  names in `agent.provider_hosts` too. The retired `AGENT_EGRESS_ALLOW` (systemd IP tokens)
  is refused at boot when it is non-empty.
- Limits: `MAX_SITES`, `MAX_CONCURRENT_SESSIONS`, `SESSION_TURN_TIMEOUT_MS`,
  `INSTALL_TIMEOUT_MS`, `BUILD_TIMEOUT_MS`, `SITE_DISK_QUOTA_MB`, `RELEASES_RETAINED`. A
  limit absent from the rendered file means "the daemon's own default", never a frozen copy
  of today's value.
- Credentials — `SERVICE_TOKEN`, `ANTHROPIC_API_KEY`, `OPENCODE_ENV`, `PI_ENV`,
  `PUBLICATION_API_KEY` — are **never** written into that file. They arrive through systemd
  `LoadCredential=` out of root-owned `0600` files and are layered over the parsed
  environment at boot, where a credential always wins.

## Extending

- **Add an agent driver.** Implement `AgentDriver` in `src/drivers/<name>.ts` (a `detect()`
  version probe, a `startTurn` that calls `spawnAgentProcess` with your argv and a per-line
  parser mapping stdout to `AgentEvent`s), register it in `src/drivers/registry.ts`, add its
  `*_BIN` and any provider keys to `config.ts`, and thread its env allowlist in the manager's
  `buildStartOptions`. The git backstop covers file changes if the CLI's stream does not.
- **Add a starter template.** Drop a directory under `templates/<name>/` with a
  `template.json` (`label`, `description`) and your project files; use `__PUBLICATION_API_URL__`
  where the data base URL is needed. It appears in `/capabilities` automatically.
- **Add a proxied action.** Add a handler to `server/index.ts` `apiActions` that calls
  `daemonJson`/`daemonStream`, and (if it maps to new daemon behaviour) a route on the daemon.

## Security model

The engine authorizes; the daemon executes under a dedicated unix user with systemd
hardening (`ProtectSystem=strict`, `ReadWritePaths` limited to the three roots,
`ProtectProc=invisible`, `RestrictSUIDSGID`, `LockPersonality`). Agent and build children get
a constructed environment (never the daemon's secrets); the toolchain is Bun-only, which does
not run npm lifecycle scripts except `trustedDependencies` — the cheapest real mitigation
against a malicious dependency. Path confinement + slug grammar + no-shell argv spawns bound
what a workspace can reach on disk.

**An agent run is a different principal from the daemon — and from every other site.** It
runs as its SITE's identity, `dedalo-a-<instance>_<k>` (one per declared site, allocated from
the host's `/etc/passwd` ledger: an ordinal is never reused, a removed site's identity is
LOCKED, never deleted), in an instance of a unit root rendered for that site and door. The
daemon starts nothing: it connects to the site's socket and PID 1 starts the run. The
museum's polkit rule grants the service user only `stop` and `kill` on its declared sites'
run instances (`src/provision/render/agent_authorization.ts`). The workspaces root is `2770`
so the service user and the identities can work in it and no other uid on the host can look;
the build HOME is its identity's own (`0700`, under a root-owned state root every unit
masks), and the TURN HOME is ROOT's (S3-HOME, the skeleton in
`src/drivers/agent_identity.ts`): `0755` holding exactly `state/` (the identity's, `0700`),
`.config/` (root's, `0755`, empty) and `.gitconfig` (root's `0644`, the turn's git directives).
The turn unit points `XDG_CONFIG_HOME` at that read-only `.config` and `CLAUDE_CONFIG_DIR` and
the XDG data/state/cache directories under `state/`, so nothing a turn writes at HOME level is
configuration a later turn reads (git's global files, `~/.bunfig.toml`). `state/` itself is
WRITABLE CLI STATE, not inert: what the CLI loads from `state/claude` (settings, hooks,
skills, the MCP servers of its account file) is closed by the PLANT argv
(`--setting-sources ''`, `--strict-mcp-config`, the daemon's `--settings`), not by ownership.
The daemon checks the shape, as a closed world, inside conformance — at admission, at the
run's open and at boot — and refuses a site whose HOME differs (`unit_nonconformant`, naming
the path). `provision apply` rebuilds exactly the HOMEs that check refuses (one predicate,
`turnHomeShapeProblems`, shared by the daemon and the plan): the daemon is stopped, the
identity proved idle, the skeleton staged at `s<k>/turn.next`, the CLI's STATE — an allowlist:
its session transcripts, account file and login — carried into `state/claude` by rename, the
old HOME closed root-only and archived into `<agent state root>/retired/` (masked by every
unit; the rename is proved to stay on one filesystem first), then swapped in — never re-owned
in place, nothing deleted. Under
`AGENT_CONFINEMENT=none` a turn gets a FRESH HOME per run (`unconfined/turn/run.*`, removed
when it exits — a removal that fails is logged and left to the boot sweep, never thrown into the
daemon) and a persistent `unconfined/turn/state`; the boot carries the pre-S3 HOME's CLI state
into it once (the same allowlist, never through a link, never over a target). `AGENT_STATE_ROOT`
is therefore REQUIRED under `none`: without an absolute one every turn is refused
(`confinement_unavailable`) and the boot reports it — one predicate answers both. The credential store, the audit handle and `$CREDENTIALS_DIRECTORY` stay the
daemon's alone. Egress IS policed per run, and not by an address list: systemd's IP filter
is allow-wins, so the `IPAddressAllow=any` this design once relied on granted loopback and
the LAN whatever the deny list said. Each run lives in a private network namespace with
`/run` masked, and reaches the outside only through its site's egress gate — hostnames on
its plan, port 443, public addresses only. Loopback and LAN model providers are therefore
not reachable, and a CLI that ignores the standard proxy environment variables has no
network at all (fail-closed). WHAT IS NOT DRAWN, AND IS ACCEPTED (recorded beside the
derivation in `src/provision/layout.ts`): every identity's PRIMARY group is the instance's,
and the workspaces are group-shared with the service user, so one site's run can READ
another site's workspace of the SAME museum through the group bits — never write it
(`ReadWritePaths=` is its own workspace), never reach its gate, its HOME or its live run. A
SITE BUILD AND A `git add` ARE THE SAME PRINCIPAL AS A TURN: `site.json`, `package.json` and
`.git` all live inside the workspace a turn writes, so an install script, a build command
and a git filter are agent-authored text on a routine publisher-triggered path. All three go
through `runConfined()` — the site's identity, its own unit per door, the same caps and
network design (a build reaches only its package registry; a git command reaches nothing) —
and `src/util/spawn.ts` REFUSES any spawn whose working directory is inside `SITES_ROOT`
without the confinement's token, so a new call site cannot quietly reopen the door.

## Testing

- **Daemon**: `bun run test:sitebuilder` (or `bun test` in the service dir) — site CRUD,
  driver stream parsing, session flow (a fake driver injected via `__setTestDriver` exercises
  the full manager → store → SSE → git path with no real CLI), promote/rollback symlink
  semantics, path-confinement and slug fuzz, auth, and the audit log.
- **The provisioner**: `tests/provision*.test.ts` in the same suite. Because `plan()`,
  `removalPlan()` and the renderers are pure, most of it asserts on a value rather than on a
  host: the composition `derive(parseManifest(…))`, the mode matrix, every refusal by name,
  and byte-equality between the committed rendered examples and a fresh render. The
  behavioural halves — adoption and removal — drive real writes, renames and modes inside a
  temp prefix with `exec` and `chown` stubbed. What they therefore do **not** prove is that
  `systemctl`, `usermod` and a real `chown` behave as expected, or that the uid boundary
  holds in the kernel; that is the operator's `provision check` on the box.
- **Engine**: `test/unit/tool_sitebuilder.test.ts` drives the proxy against an in-test
  mock daemon (config injected via `mock.module`), asserting the bearer + actor headers, the
  error taxonomy, the publish gate, and the SSE relay with the anti-buffering header
  (non-error records byte-identical). `test/unit/tool_sitebuilder_stream_codes.test.ts` drives
  the stream door end to end (the real supervisor, store and SSE responder on the daemon side,
  the real relay on the engine's). `test/unit/dd_tools_api_stream_headers.test.ts` guards the core edit.
  The tool is normalized out of the widget and register parity gates as a TS-only addition.

## File map

| Responsibility | Path |
|---|---|
| Daemon config / boot / routing / auth | `publication/site_builder/src/{config,index,router,errors}.ts`, `src/security/auth.ts` |
| Workspaces (manifest, git, templates, brief) | `publication/site_builder/src/sites/*`, `src/context/agents_md.ts` |
| Sessions (turns, drivers, SSE, event log) | `publication/site_builder/src/sessions/*`, `src/drivers/*` |
| Build / promote / publish | `publication/site_builder/src/build/*` |
| Ops — declaration, derivation, rendered artifacts | `publication/site_builder/src/provision/{schema,layout,hash}.ts`, `src/provision/render/*`, `deploy/examples/*` |
| Ops — the provisioner itself | `publication/site_builder/src/provision/{fleet,plan,apply,verify,adopt,remove,cli}.ts` |
| Ops — the backup of an instance's state | `deploy/dedalo-site-builder-backup.sh`, `deploy/dedalo-backup.service` |
| Engine proxy + client | `tools/tool_sitebuilder/{server,js,css}/*`, `register.json` |
| Engine config + core edit | `src/config/catalog/sitebuilder.ts`, `src/config/config.ts`, `src/core/api/handlers/dd_tools_api.ts` |
| Maintenance widget + launcher | `src/core/area_maintenance/widgets/site_builder_status.ts`, `client/dedalo/core/area_maintenance/widgets/site_builder_status/js/*` |

## Related

- [Site builder](../administration/site_builder.md) — operator overview and enabling steps.
- [Site builder cookbook](../administration/site_builder_cookbook.md) — configuration and prompts.
- [Publication API v2](../diffusion/publication_api/v2/index.md) — the read-only data source,
  including its [MCP endpoint](../diffusion/publication_api/v2/mcp.md).
- [Settings reference — Site builder](../administration/configuration/config.md#sitebuilder) — every config key.
