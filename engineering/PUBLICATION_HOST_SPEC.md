# PUBLICATION HOST — a separate publication machine, controlled from the work system

> **Status 2026-10-08: BUILT — phases 1 to 6 (§8); phase 7, the guided install
> (`provision init`, §9), in integration.** This file is the definition the code implements;
> each phase's BUILT line in §8 names its modules and the command that proves it.
> Media-access details extend `engineering/MEDIA_PROTECTION.md`.

## 1. Topology and scope

Two machines, one institution:

- **Work host** (internal): the engine, the maintenance panel, the matrix Postgres,
  the media master tree. The ONLY writer of everything.
- **Publication host** (public): the website(s), the Publication APIs v1 (PHP) and v2
  (Bun), the published MariaDB, and the published media — either a copy (§5.2) or a
  read-only view of shared storage (§5.1).

The single-host install (work + publication on one machine) is unchanged and stays
first-class. A publication host is an ADDITION the panel learns about, never a mode the
single host must take.

### 1.1 Single machine, two hostnames (small institutions)

The same architecture on one server: two vhosts, one media tree, no network channel.

```
dedalo.museum.org (work)   → engine; media mode `private` (Rule A only, engine .htaccess)
www.museum.org   (public)  → website + API v1 + API v2; media = the §5.1 profile
                             rendered with --root <the real media path>
```

- **Why a separate hostname even here:** origin isolation. With the back-office under the
  website's origin, any XSS or compromised website plugin acts with a logged-in curator's
  session against `/dedalo/core/api/` (same origin → CORS does not apply). Separate
  hostnames also keep work cookies off the public site and let the back-office be
  firewalled alone. Moving to two machines later only moves the `www` vhost.
- **Media path into the public vhost:** the generated include's `Alias` points straight at
  the real media root. No symlink (it needs `FollowSymLinks` and isolates nothing) and no
  mount (same filesystem, same Apache). OPTIONAL hardening: read-only BIND mounts of only
  the public quality folders + `.publication/pub` into a separate root, rendered with that
  root, so a rule mistake cannot expose what is not mounted (cost: one fstab line per
  public quality; root-only ops, not panel-drivable).
- **Isolation by users, not network:** engine (`dedalo`, owns `../private` 0700, media RW,
  Postgres via unix socket + peer auth); web server reads media read-only (group);
  PHP-FPM pool user with `open_basedir` excluding media and `../private`; API v2 its own
  user; APIs use a read-only MariaDB user; systemd `ProtectSystem=strict`,
  `ReadWritePaths=` minimal, `NoNewPrivileges=yes` on the Bun services.
- **Control:** the SAME agent (§2, §6) listening on a local unix socket (the
  `publication/site_builder` precedent). One code path for one or two machines: the
  registry (phase 3) treats "local" as an ordinary publication host whose address is a
  socket.
- Backups must leave the machine (one disk carries work and public data).

## 2. The control channel (trust law)

The panel controls the publication host through a **publication agent**: a small Bun
daemon on the publication host (`publication/host_agent/`, its own package, its own
`.env`, its own tests — the `publication/site_builder` precedent).

1. **Direction is work → publication, only.** The publication host never opens a
   connection to the work host. The firewall states it; the agent holds no work-host
   credential and no work-host address.
2. **The channel is private and mutually authenticated (decided in phase 2).** Over a
   network: **mTLS** on a non-public port, firewalled to the work host's address, never
   routed through the public vhost. The provisioner runs a private CA on the publication
   host and issues a server certificate (SAN = the declared listen address: a canonical
   private IPv4 literal, never a hostname or wildcard — `LISTEN_HOST_PATTERN`) plus ONE
   engine client certificate and key. The agent pins exactly that client CA (`Bun.serve`
   `requestCert` + `rejectUnauthorized`, constants in `src/boot.ts`, never configuration).
   A TLS listener whose certificate, key or client CA is missing, unreadable or not PEM
   refuses to BOOT. It never serves unverified. The engine's half leaves the host as one
   root-only `0600` file (`engine_bundle.pem`: client certificate, client key, CA) that the
   operator carries to the work host. WireGuard stays a RECOMMENDED network layer
   underneath, not a substitute: the agent cannot verify a tunnel, but it can verify a
   certificate. On a single machine (§1.1): a unix socket, mode 0660, group = the
   engine's. **Plain TCP does not exist**: the listener is `unix` or `tls` and nothing
   else. The agent's suite listens on a unix socket, and its mTLS gates bind TLS on
   `127.0.0.1` with their own scratch CA.
   The agent trusts any client certificate its OWN instance CA signed, so reissuing the
   engine bundle revokes nothing. Revoking a leaked bundle = rotating the CA (remove
   `tls/ca.pem` + `tls/ca.key`, `provision apply`): new CA and leaves, and the running
   agent is restarted (it loads TLS once, at boot).
3. **Pairing is proved, not assumed.** Every request except `GET /health` carries
   `Authorization: Bearer <token>` (≥ 32 chars, constant-time compare). The bearer is
   checked BEFORE route matching, so unauthenticated 401/404/405 answers are
   indistinguishable. `/health` publishes `instance_fingerprint =
   sha256('dedalo-publication-host:' + instance + '\n' + token)` (lowercase hex) and never
   the instance name. The engine recomputes it (`src/core/publication_host/pairing.ts`);
   `test/unit/publication_host_pairing_tripwire.test.ts` twins that with
   `publication/host_agent/src/security/pairing.ts`. The prefix is this protocol's own,
   not the site builder's `dedalo-site-instance:`: a proof for one protocol is never valid
   for the other. A wrong instance and a wrong token produce the same mismatch. Rotating
   the token (remove `credentials/SERVICE_TOKEN`, `provision apply`) mints a new one and
   restarts a running agent, which reads it once, at start (`LoadCredential=`). The three
   layers do three jobs. The certificate proves the caller is the paired engine's
   machine. The bearer proves it holds this host's secret. The fingerprint proves both
   sides mean the SAME host, so a mis-pasted env file names the mismatch instead of
   silently driving another institution's host.
4. **Closed command set.** The agent executes ONLY the commands in §6. There is no
   "run script", no shell, and no route that takes a filesystem path outside the agent's own
   roots: the copy-mode media commands (§6) take a path RELATIVE to `MEDIA_ROOT`, refused
   unless it stays there (no absolute, `.`/`..` or empty segment; a put also no hidden
   segment; nothing under the agent's own top-level `.publication/` or instance marker; no
   symlinked directory leading out — the real path is checked before anything is created
   or removed). Every child process
   goes through `publication/host_agent/src/exec.ts`, whose public API is a closed set of
   named commands with no free argv. A package test fails if any other module spawns.
5. **Least privilege, no root at runtime.** The agent runs as its own user and writes
   only under its state root (`publication_api/`, `rules/`, `audit/`). It holds exactly
   two grants, both rendered and hash-stamped by the provisioner: a **sudoers** rule for
   the web server's configtest argv only (`<bin> -t`, because a configtest must read
   root-only TLS keys; `<bin>` is the first real file in the closed per-server list
   `WEB_CONFIGTEST_CANDIDATES` — apache: `/usr/sbin/apache2ctl` (Debian/Ubuntu, where
   `apachectl` is a symlink), `/usr/sbin/apachectl` (RHEL); nginx: `/usr/sbin/nginx` —
   rendered into both the sudoers rule and the agent env `WEB_CONFIGTEST_BIN`), and a **polkit** rule allowing `reload` of the
   observed web unit, `restart` of the v2 unit, and `start`/`stop` of the v2 scratch
   template unit `<v2 unit>-scratch@<port>` (port 1024–65535; the `publication/site_builder`
   precedent) — and, on an nginx host whose http{} map is provisioned (§9.7), `start` of
   `dedalo-pubhost-map.service`, a root oneshot that takes no argument — and, on a host where
   fapolicyd is installed (§9.11), `start` of `dedalo-pubhost-trust-<instance>.service`, the
   instance's root trust oneshot, which takes no argument from the agent and derives what it
   trusts from the declaration. There is no shell and no free argv. The media include the agent installs
   is checked against a closed directive allowlist
   (`publication/host_agent/src/rules/directives.ts`) before root parses it: no module
   load, no include, no log or piped directive, no path outside MEDIA_ROOT. What remains
   runs at request time as the web-server user, the trust §2.6 already gives the paired
   engine.
   **Pushed release code never runs as the agent user.** The agent uid owns `rules/`
   (which root parses at configtest), holds the sudo configtest grant, the TLS server key
   and the bearer. Release code running as that uid could reach root, for example by
   writing a `LoadModule` into the include and running the configtest itself. So
   `exec.ts` `v2ScratchBoot` repoints `v2/scratch` at the committed `releases/<id>` and
   `systemctl start`s `<v2 unit>-scratch@<port>`: the release under test runs as the v2
   user in v2's sandbox, with `v2.env` read by systemd. No named command runs `BUN_BIN`
   (pinned in `publication/host_agent/tests/exec.test.ts`).
6. **Trust model (stated, not hoped).** A compromised work host means a compromised
   publication host, because `release.install` runs code the work host pushed. The reverse
   does not hold: the publication host has no work-host credential and no work-host
   address (1.). The agent therefore validates SHAPE (the sha256 stamp, the bundle grammar
   of §3, path confinement) and the PRIVILEGE BOUNDARY (the media include's directive
   allowlist of item 5, and release code that never runs as the agent user), and never the
   INTENT of the paired engine. A check on which release the only writer chose would protect
   nothing, so there is no downgrade refusal. A check that keeps the engine's trust from
   becoming ROOT is not one of those: the engine is trusted with what the web-server and
   v2 users can do, never with root.
   Every `current` swap is recorded `from → to` in the agent's append-only audit log.
7. **The provisioner's inputs are root's alone.** Root renders the sudoers and polkit rules
   and the units from the declaration and runs the code it names, so each input must be
   changeable by root only (uid 0; the user table is never consulted). The code paths
   (`agent_dir`, its entry point, `php_bin`, `bun_bin`, the configtest binary) are judged in
   `publication/host_agent/src/provision/plan.ts` (`trustProblem`, `ancestorsBelow`). The
   declaration is judged in `src/provision/cli.ts` `declarationTrustProblems` on `check` and
   `apply`, BEFORE it is read: a regular file by lstat (a symlink is refused, never
   followed), uid 0, `mode & 022 == 0`, and every ancestor up to and including `/` a real
   directory with the same owner and mode. The sibling declarations the multi-instance
   isolation check reads are judged the same way before each is read (a sibling a non-root
   user can edit steers that check), and so are the config base and its ancestors even
   when it holds no sibling or `--declaration` points elsewhere (whoever can write there can
   remove a sibling and hide a clash). A failure is a plan refusal (exit 3); `render` is
   exempt (no root, writes nothing). Residual: the read after the check is a plain read,
   not an fstat of an `O_NOFOLLOW` descriptor; it is closed only because the checked chain
   is root-only.
   **Bun per site.** `bun_bin` is each instance's own Bun, at the work host's `.bun-version`,
   in `/home/<site>/.bun/` and root-owned (it runs the agent and its grants), so sites
   upgrade independently; the panel's `bun_version` check (§2.1) reds on any drift. The
   binary is installed from the release archive checked against the committed hash table
   `.bun-sha256`, generated only from Bun's signed `SHASUMS256.txt.asc` (§9.10), never a
   download piped into a root shell: the panel check compares a SELF-REPORTED version, so it
   proves drift, not integrity.
   **The instance lock.** `provision apply` takes `provision init`'s instance lock exclusive
   and `provision check` shared, BEFORE reading the declaration (§9.6): a hand-run apply can
   never interleave with init, and a check during either answers exit 5 (busy), not drift.
   **Development dependencies.** `plan` refuses an `agent_dir` whose `node_modules/` holds
   any of the agent package's devDependencies (`plan.ts AGENT_DEV_DEPENDENCIES`, held equal
   to `package.json`), like `.test-tmp/`: the deployment install is `bun run
   hostagent:install` (frozen, production-only).
   **Access.** Root-only is necessary, not sufficient: the services run as non-root
   accounts and must still READ what they run. `plan` judges each runner with the
   credentials its rendered unit gives it (`access.ts` `unitCredentials`; the agent's and
   v2's `Group=`/`SupplementaryGroups=` are ONE value, `agentUnitGroups`/`v2UnitGroups`, that
   the renderer emits its lines from and `plan` judges with — `provision_access.test.ts`
   parses the rendered units back against it; v1
   its database groups via the pinned `id -g`/`id -G` command), on the single mode class the
   kernel consults: x above `agent_dir` and r (dirs r+x) over its whole lstat-walked tree
   (symlinks never followed; over `AGENT_TREE_WALK_CAP` or an unlistable dir refuses, never
   skips); r+x on `bun_bin` (agent, v2) and `php_bin` (agent); x above the state root (all
   three). Mode bits only, so an ACL grant is refused: the check errs toward refusal, never
   toward a unit that dies with `EACCES`. On a unix listener `engineGroupRefusal` refuses an
   `engine_group` that is a primary group of `agent_user`/`v1.user`/`v2.user` or is
   `v2.group` (by name). Membership of the work system's account is unknown to the
   declaration and NOT checked: the operator's socket request as that account is the proof.

Rejected alternatives, for the record: manual operation (drift, no panel visibility,
unpublish depends on a human); SSH scripts from the engine (a shell credential for a
public host in the engine's hands); a hosting panel's API (far wider than the job);
publication-host pull (reverses the firewall direction).

Rejected for the transport (phase 2): bearer over WireGuard alone. A leaked bearer would
then be enough to drive the host. With mTLS it is useless without the engine's client key.

### 2.1 The engine side (phase 3)

- **Registry.** `<private>/publication_hosts.json` (0600), `{"version":1,"hosts":[…]}`,
  one record per host keyed by `name` (`^[a-z][a-z0-9_]{1,31}$`). A record holds the
  agent's instance, the expected pairing fingerprint, the address (`tls` host + port, or
  `unix` socket), and the three panel-editable fields: `public_url`, `qualities`
  (null = the engine's public qualities) and the `probe` paths (phase 6). It holds no
  secret. It is written tmp → fsync → rename under a lock
  (`src/core/publication_host/registry.ts`). An absent file means no host. A file that is
  unreadable, malformed or carries a duplicate name makes the panel show `registry_invalid`;
  it is never treated as empty and never as a partial list. The registry decides where the
  engine dials, so it is read only as a regular file (opened `O_NOFOLLOW|O_NONBLOCK`: no
  symlink, no FIFO) of mode exactly 0600 owned by the engine user; anything else is
  `unreadable`. The lock file is opened `O_NOFOLLOW` too. It is not `ts_state.json`,
  whose writer is not atomic and resets to defaults when the file is corrupt.
- **Secrets.** Each host has `<private>/publication_hosts/<name>/` (0700) holding `token`,
  plus `engine_bundle.pem` for a TLS host only (a unix pairing stores none:
  `writeHostSecrets(name, token, null)` removes a stale one), each 0600 and owned by the
  engine user (`src/core/publication_host/secrets.ts`). Every read `lstat`s the root and the host dir
  first (a symlink, a non-directory or a mode other than 0700 is refused, never read as
  absence) and opens the file `O_NOFOLLOW|O_NONBLOCK`. They never appear in the registry,
  `ts_state.json`, a panel payload, a log, the activity audit or an error detail. The panel
  reports only their presence. They are not in `.env` because that file is append-only and
  frozen at boot (a rotated token would need a restart), and its fixed key names cannot
  express N hosts.
- **Adding a host is an operator ceremony on the work host, never a typed address.**
  `scripts/publication_host_pair.ts` runs as the user that runs Dédalo, the owner of
  `<private>` (`sudo -u <engine user> …`). It refuses any other uid, root included,
  because root-owned 0600 secrets would be unreadable by the engine. It reads the agent's
  `engine.env.fragment` and `engine_bundle.pem`. The token comes from the pasted fragment
  line, a 0600 `--token-file` or `--token-stdin`, and never from argv. The CLI refuses
  placeholders, contradictions and credential files readable by others, and proves the
  pairing live (the `/health` fingerprint, no bearer). The proof reads its TLS material from
  the secrets store (the one door reads it nowhere else), so it uses a temporary 0600 copy
  under the reserved name `pairing_<hex>` in `<private>/publication_hosts/`, removed whatever
  the outcome; a killed run leaves it until a later run sweeps it, after an hour. Only after
  the proof does it write the secrets under the host's name and the registry record, under
  one registry lock. `--dry-run` keeps nothing and sweeps nothing. An address typed into a web form would be an SSRF and
  credential-exfiltration surface. The panel edits only `public_url`, `qualities` and the
  probe paths, and it can remove a host. ONE exception, still without a typed address: the
  panel's `pair_package` (§9.14) pairs a two-machine host from the sealed package, whose
  address must equal the listener of a draft the panel itself created and is proved live. The
  pairing itself is ONE implementation, `src/core/publication_host/pair_flow.ts` `pairWith`
  (fragment grammar, address policy, token, bundle rule, fingerprint, slot, live proof, the
  locked commit), which the CLI and the panel both call.
- **One door.** `src/core/publication_host/transport.ts` is the only engine code that
  dials an agent. It is the fourth outbound door (`engineering/OUTBOUND_SPEC.md` §2.1):
  exact address, mTLS or unix, bounded, redirects refused.
- **Pairing before the bearer** (`src/core/publication_host/agent_client.ts`, the
  `tools/tool_sitebuilder/server/daemon_client.ts` order): an unauthenticated `GET /health`,
  the fingerprint compared, and only then the bearer request. A mismatch (for example, the
  agent re-provisioned with a new token) is `publication_host.pairing_mismatch`. The
  bearer is never sent and nothing is applied. The fingerprint is public (the agent
  publishes it on `/health`), so this check detects drift and misrouting, not an impostor:
  impostor resistance comes from the mTLS CA pin (a TLS host) and the socket filesystem
  check (a unix host, `socket_perms`, `engineering/OUTBOUND_SPEC.md` §2.1). Read-path
  residual: a read (`status`, `media.probe`) reuses a cached proof keyed on the registry's
  fingerprint and address; every mutation proves live.
- **Errors** are the `publication_host.*` family: `unconfigured`, `registry_invalid`,
  `unreachable`, `pairing_mismatch`, `auth`, `rejected` (an agent 4xx refusal), `failed`
  (an agent 5xx), `busy` (an agent 409, OR the work host's own registry lock held past its
  wait by the pairing command or another panel write — `wire.ts` `registryError`, logged as
  `registry_reason: locked`) and `timeout`. The agent's problem `reason` maps to a public
  sentence (`src/core/publication_host/wire.ts`). The agent's prose is logged, never shown.
- **The panel** is the `publication_hosts` maintenance widget (category `publication`,
  `src/core/area_maintenance/widgets/publication_hosts.ts`, wire entry
  `engineering/wire_contract/WC-2026-10-03-publication-hosts-widget.md`). For each host it
  shows the checks `registry`, `secrets`, `reachable`, `pairing`, `agent_version`,
  `bun_version`, `media_mode`, `media_mount`, `media_read_only`, `rules_hash`, `api_v1` and
  `api_v2`, the expected vs reported rule hash (§5.1), the expected vs reported Bun version
  (row field `bun: {expected, reported}`), and each API's current/previous release.
  `bun_version` (`src/core/publication_host/host_status.ts`) compares the agent's `status`
  `bun_version` with the work host's pin (repo-root `.bun-version`, read by the update
  panel's `bunPinOf`): exact equality is `ok`; any difference (patch, minor, a prerelease or
  build tail) is `blocked`, as is a value not shaped like a Bun version (`malformed`); an
  unreachable or unproved agent (`status_unavailable`), an empty value (`not_reported`) and
  an unpinned work host (`unpinned`) are `unknown`. `reported` is null unless the status is
  trusted and shaped, so agent text never reaches the row. Exact equality because the
  engine and the agent share Bun-coupled behaviour (`Bun.sql`, `Bun.serve`). A
  failure minted before anything was dialled (the local token-vs-registry pairing check,
  the registry lock's `busy`; coordinate `stage: 'local'`) never reads `ok` on `reachable`
  or `pairing`. The actions `apply_rules`, `probe`, `rollback_api`, `set_host_fields` and `remove_host` are
  ROOT-ONLY: the Dédalo root user, as in the `media_control` precedent. A global admin
  who is not root gets `perm.denied`, and no agent call is made; it reads the checks
  without the host's network address. `media_control` carries one read-only line
  linking to the panel.

## 3. Publication API deployment

> **Addendum 2026-10-09 — the Publication API v1 is OPTIONAL** (§3.1). Read it first: the
> v1 tree below exists only on an instance that declares v1.

Each API is its own deployable on the publication host, code from the engine's verified
release, state outside the code:

```
<pub root>/publication_api/
  v1/shared/server_config_api.php     v1/releases/<release>/   v1/current -> releases/<release>
  v2/shared/v2.env                    v2/releases/<release>/   v2/current -> releases/<release>
```

- Apache `Alias` (v1) and the systemd unit (`WorkingDirectory`, `EnvironmentFile=` v2.env)
  point at `current`. v2 reads only `process.env`, so `EnvironmentFile` needs no code change.
- **Release id** = `<version>_<digest7>`, validated `^\d+(\.\d+){1,3}_[0-9a-f]{7}$`
  (e.g. `7.0.3_a1b2c3d`). Developer-channel installs keep the version, so only the digest
  tells two releases apart. Re-installing an existing id only re-points `current`.
- **Bundle = gzip'd ustar, parsed in-process** (`publication/host_agent/src/releases/ustar.ts`).
  There is no system `tar`, so there are no GNU-vs-BSD differences, and validation and
  extraction are one code path. Only entry types `0` (file) and `5` (dir) are allowed,
  plus PAX `x` records that carry only `path`. Total bytes (`MAX_BUNDLE_BYTES`), entry
  count (`MAX_BUNDLE_ENTRIES`) and path length (1024) are capped. No absolute, `..` or
  duplicate path is allowed. An offending entry is refused BEFORE it is written, and
  staging is removed. The stream's sha256 must equal the declared one. Phase 4 writes the
  engine-side writer and its round-trip twin test.
- **No registry egress.** A v2 bundle carries its production `node_modules`, built on the
  work host with the pinned Bun (phase 4). The agent never runs `bun install`.
  `bun build --compile` is not an option: v2 reads `swagger-ui-dist` assets from
  `node_modules` at runtime (`src/routes/docs.ts`). Its dependencies are pure JS, so the
  tree is platform-neutral.
- **v1 config stays outside the release.** v1 resolves its config at the fixed path
  `dirname(__FILE__,2)/config_api/`. After extraction the agent links
  `releases/<r>/config_api/server_config_api.php` (and `server_config_headers.php` when
  `shared/` has one) → `shared/`. A v1 bundle that carries either file is refused
  (`reserved_path`).
- **v1 config is private to its owner.** `server_config_api.php` holds the site's database
  credentials and every site's PHP-FPM pool may share the web server's group, so the
  declaration names v1's OWN pool user (`v1.user`; never `www-data`, `apache`, `nginx`, `www`,
  `nobody` — `FORBIDDEN_V1_USERS`; with `site` the provisioner renders that dedicated pool,
  §9.4), the file is `<v1.user>` mode 0400/0600, and an
  install with the file readable by group or others, or root-owned (the pool is never root), is
  refused (`shared_config_exposed`; `isPrivateV1Config`).
  `v1/shared/` is `root:root 0711`: the agent only stats and links there, joins no v1 group,
  never reads the file. Agent, v1 and v2 are three distinct non-root users (derive).
- **Install** = stream into staging with the stamp verified → commit into `releases/<id>` →
  (fapolicyd) the trust oneshot → (v1) `php -l` lint of the COMMITTED tree (on staging, fapolicyd
  with `allow_filesystem_mark = 1` denied php the untrusted files: measured, RHEL 10.2, 2026-10-09) →
  (v2) boot the release on a scratch port and probe its health → atomic `current` swap
  (temporary symlink + `rename`) → (v2) restart the unit, then health. A failure before
  the swap leaves the old release serving. A failed post-restart health swaps `current`
  back and restarts the unit on the previous release. **Rollback** = swap back to the
  newest non-current release. Keep `RELEASES_RETAINED` releases (default 3, minimum 2).
  Pruning never removes the current or the previous release.
- **Why `shared/`:** the engine's code updater keeps only `.git` across a tree swap
  (`PRESERVE_ROOT_ENTRIES`, `src/core/update/code_update.ts`), so any state stored inside
  a code tree dies on update.
- **Lockstep (built, phase 4).** The API release equals the engine release that published
  the data, in both directions: a restore confirms through the same boot sentinel, so it
  pushes the older release too.
  - **Release id** = `<DEDALO_VERSION>_<INSTALLED_DIGEST[0:7]>` (the digest is
    `src/core/update/install_stamp.ts`'s). An install with no digest (a development
    checkout, or a tree installed before this feature) has no verified release, so the
    push is REFUSED, never guessed.
  - **What ships is what was verified.** The verified zip is deleted after the swap, so
    `updateCode` writes a per-file sha256 manifest of `publication/server_api/**` at
    extract time, beside the install stamp
    (`<installed tree>/src/core/update/publication_manifest.json`, written and checked by
    `src/core/update/publication_manifest.ts`). Before packing, every file is re-hashed
    against it. A missing manifest, a manifest digest that is not the installed one, or
    any drift (a file edited, added or removed) REFUSES the push. The refusal names the
    files, and nothing is sent.
  - **v2 `node_modules` are built on the work host** with the pinned Bun
    (`process.execPath install --frozen-lockfile --production …`) in
    `<backup root>/.pubapi_build/<release>/v2/`, cached per release id, then packed. This
    is the no-egress law above.
  - **One deterministic writer** (`src/core/publication_host/bundle_writer.ts`): ustar +
    gzip, entries sorted, mtime/uid/gid 0, modes 0644/0755, types `0`/`5` only, and a PAX
    `path` record only when a path exceeds 100 bytes. The same tree always gives the same
    sha256. A round-trip twin gate feeds the writer's output into the agent's own reader,
    so the two deployables cannot disagree on the format. The bundle builder is
    `src/core/publication_host/api_bundles.ts`.
  - **One reconciler, three triggers** (`reconcilePublicationApis`,
    `src/core/publication_host/api_reconcile.ts`):
    (1) detached and best-effort once `confirmBootedCodeUpdate` has flipped the sentinel
    (wired in `src/server.ts`); a smoke boot pushes nothing (a box that is not installed never boots: PRODUCTION §7.1);
    (2) the root-only panel action `push_apis`;
    (3) a scheduled DRY-RUN reconcile that reports drift; its apply is refused, so a
    timer never pushes code.
  - **Per host: v2, then v1, independently.** Each API's outcome is recorded per host in
    `<private>/publication_hosts_runtime.json` (`apis.<api> = {state, release, error, at}`,
    `src/core/publication_host/runtime.ts`) and shown red on failure. A partial success is
    visible, never hidden. The panel shows the engine release beside each host's two API
    releases and flags a mismatch.

### 3.1 v1 optional, v2-only sites (2026-10-09)

The Publication API v1 is legacy (websites built for v6) and will be removed. It is
OPTIONAL now so that its removal later is a DELETION, never a redesign: every v1 branch is
already guarded by one fact, and deleting v1 deletes those branches.

- **The declaration rule.** v1 is the `v1` block. A declaration WITHOUT it is a v2-only
  instance with no PHP anywhere: no PHP-FPM pool, no PHP runtime, no v1 account, no v1
  tree under the state root, no v1 web handler, no v1 log rotation. The v1-only keys —
  `php_bin`, `site.fpm`, `site.api_paths.v1`, `paths.fpm_pool_dir`, `paths.v1_var_base` —
  are refused by name without it; with it, `php_bin` is required (and `site.fpm` with a
  site). A v2-only site declares `site.os_family` (`debian` | `el`, which places the site's
  web logs and their log group); beside `site.fpm` it is optional and must agree with the
  flavour (`remi` is `el`). `derive()` carries `layout.v1 = null`, `site.v1 = null` and
  `servedApis = ['v2']`; every consumer (renderers, plan, apply, SELinux table, access law,
  siblings, init) branches on those nulls.
- **The agent.** `PHP_BIN` is rendered only for a v1 instance; its absence IS "v2-only"
  (`src/config.ts` `servedApis`). The agent then refuses a v1 install or rollback before
  reading the body: 422 release-refused, closed reason `api_not_served`.
- **The wire** (`engineering/wire_contract/WC-2026-10-09-publication-host-v2-only-site.md`):
  `GET /v1/status` carries a required `served_apis` (`["v1","v2"]` or `["v2"]`); `apis`
  keeps both keys, an unserved one `{current: null, previous: null}`.
- **The engine.** The reconciler builds and pushes no v1 bundle to a host whose status does
  not serve v1 (`result: 'not_served'`, never drift, never a failed push); the panel's v1
  row on such a host is *Not served*, a neutral state.
- **`provision init`.** The draft-only key `apis` (`v2_only` | `v1_and_v2`) chooses; absent,
  the draft's own `v1` block decides exactly as in a declaration (no block = v2-only).
  `v2_only` beside a v1 key is refused by name. A v2-only run discovers no PHP (no FPM
  install, no PHP binary run, no `php.conf` read) and emits no PHP item (`host.php_mode`,
  `host.fpm_install`, `host.fpm_cli`, `host.remi_label`, `declaration.fpm`,
  `declaration.v1_user`, `account.v1_user`, `api_config.v1_db_transport`,
  `selinux.db_connect`, `api_config.v1_config`); `declaration.apis` states the choice, and
  `web.modules` does not require `proxy_fcgi`. v2-only is the recommended shape for a new
  site; the committed example is
  `publication/host_agent/deploy/examples/instance.site_v2_only.example.json`.

## 4. Media URL

Published records and the APIs (`MEDIA_BASE_URL`, default `/dedalo/media`) already carry
`/dedalo/<mediaDir>/…` URLs. The publication host serves media at **the same URL path**.
No rewriting of published data, and the MEDIA-03 envelope pattern
(`imageEnvelopePcre`, URL-derived) holds unchanged on both hosts.

## 5. Media modes (per publication host, declared on the host, shown in the panel)

| mode | who holds the bytes | gate on the publication host |
|---|---|---|
| `copy` | the agent: a copy of the published public-quality files only | the SAME §5.1 profile, rendered for the copy root; the agent mirrors the `pub/` markers (§5.2) |
| `shared` | shared storage: work host RW, publication host RO | Rule B only, rendered for the host's mount root |
| `none` | nobody — the host serves no published media | — |

The mode is declared on the publication host (the agent's `MEDIA_MODE`, written by its
provisioner) and reported by `status`. The panel shows it and never sets it: changing
what a public machine mounts is a root operation on that machine.

The work host's own mode (`MEDIA_PROTECTION.md` §6) is independent. With a separate
publication host, `private` (Rule A only) is the recommended work-host mode: the work
media is then never anonymously reachable.

### 5.1 `shared` — the `publication_host` rule profile

The work host's generated rules embed the WORK host's media root and include Rule A, so
they are wrong on the publication host twice: the root path differs (every request
fails closed → 404), and the `auth/` markers (live work-session credentials) must never
be honoured publicly. The publication host gets its own profile, rendered by the engine
from the same templates:

- **Contents:** the always-on hardening block, rule 0 (marker store never served), Rule B
  against `<host root>/.publication/pub/`, default deny as 404. **No Rule A.**
- **Apache:** a vhost include (`Alias /dedalo/<mediaDir>` + `<Directory "<root>">` with
  `AllowOverride None`), so the work host's `.htaccess` on the shared tree is never read.
  `RewriteEngine` is NOT wrapped in `<IfModule>`: a host without mod_rewrite refuses to
  start rather than serving ungated.
- **nginx:** a server{} include holding ONE outer `location ^~ /dedalo/<mediaDir>/` with
  the hardening (`nginxHardeningLocations`, shared with the work conf) and the Rule B
  location (`alias`ing into the root) NESTED inside, and `return 404` as its default. The
  `^~` is load-bearing: a plain-prefix catch-all loses to any server-level regex location
  (an operator's `location ~* \.(jpg|mp4)$`), which then serves masters and unpublished
  files from `root`. The existing http{} map file is reused unchanged (the SVG header maps).
- **Mount placement:** the mount must NOT sit under any server/vhost document root (second
  layer behind the `^~`; on Apache the `<Directory>` gate is filesystem-scoped anyway).
- **Inputs:** `root` (absolute, `^/[A-Za-z0-9._/-]+$`, no `..`) and the public qualities
  (through `filterPublicQualities` — never a master tier). An empty quality list is
  refused: a host that may serve nothing is a misconfiguration, not a mode.
- **Hash:** its own `# config-hash:` over `{TEMPLATE_VERSION, profile, server, root,
  qualities, mediaDir}` (`getPublicationHostConfigHash` — call it, never re-derive it) —
  what the agent reports and the panel compares. `server` is in it: the Apache and nginx
  includes of the same inputs carry different hashes. The panel's EXPECTED hash calls it
  with `server` and `root` taken from the agent's `status`, and `qualities` taken from the
  host's registry record (null = the engine's `getPublicQualities()`). `apply_rules` renders
  the include from the same inputs with `buildPublicationHostApacheConf` /
  `buildPublicationHostNginxConf` and sends `rules.apply`
  (`src/core/publication_host/rules.ts`).

**Exports.** Export to the publication host, read-only with `root_squash`, ONLY the public
quality folders and `.publication/pub/`, mounted under one root with the same relative
layout. Never originals, unpublished qualities, `.publication/auth/` or `dbs/`. A
compromised publication host reads everything it can mount.

**Attribute caching.** NFS/SMB cache attributes (≈60 s by default): an unpublish stays
visible, a publish stays hidden, until it expires. Mount `.publication/pub` separately
with `lookupcache=none,noac` (NFS) or `actimeo=0` (SMB). Media folders keep normal caching.

### 5.2 `copy` — the media copy target (built, phase 5)

The engine keeps a copy host equal to the published set by recomputing it from ground
truth, the `media_index` law.

- **Desired set** (`desiredPublicFiles`, `src/diffusion/targets/mediastore/media_copy.ts`):
  every file under a `getPublicQualities()` folder (recursive) that meets three
  conditions:
  - its basename matches `MEDIA_FILENAME_GRAMMAR`;
  - it is not a `MEDIA_WORKING_FILE_EXTENSIONS` file;
  - its key `$1_$2` has a `pub/<key>` marker.

  This is Rule B's own decision, so `copy` and `shared` serve the same set by
  construction. Originals never leave the work host.
- **The gate is the same.** The agent mirrors the `pub/` markers beside the copy
  (`media.mark`), and the copy root is served with the §5.1 profile. Both modes share one
  gate code path. A copy host never relies on "everything present is public".
- **Transfer:**
  - `media.put`: stream → temp file → sha256 and size verified → atomic rename. The path
    is confined under the agent's media root, and the agent checks its shape too (§6:
    grammar-valid name, no working file, never a master tier).
  - `media.delete`.
  - `media.manifest`: path, size and sha256. The agent computes each sha256 at put time
    and persists it.

  The engine caches its own hashes by `(relpath, size, mtimeMs)` in
  `<private>/media_copy/sha_cache.ndjson`, so multi-GB AV is not rehashed every round.
- **Correctness = reconcile, latency = hook.**
  - A scheduled reconcile (`MEDIA_COPY_RECONCILE` in `src/diffusion/api/reconcile.ts`;
    auto-apply, because it is a pure derivation of `pub/` ∩ public files; an operator's
    apply is root-only) diffs the desired set against the agent's manifest and markers.
  - A best-effort hook on every `pub/` transition
    (`src/diffusion/targets/mediastore/pub_transitions.ts`, emitted by the marker store in
    `src/diffusion/targets/mediastore/media_index.ts` whenever the gate's decision flips)
    wakes a per-host serialized worker
    (`src/diffusion/targets/mediastore/media_copy_worker.ts`).
  - The worker runs in-process, not as a diffusion runner, so long AV transfers never hold
    the runner slots that publishing uses.
  - The hook reaches only sinks of its OWN process, and a diffusion job runs in a spawned
    runner (`src/diffusion/runner.ts`). So the runner starts a relay
    (`MediaCopyRelay`, `startRunnerMediaCopyRelay` in `src/diffusion/api/media_copy.ts`):
    an unpublish it flips is sent as `mark false` to every copy host at once (no lane, no
    round, no transfer in the runner), drained before exit (bounded,
    `MEDIA_COPY_RELAY_DRAIN_MS`). Whatever a relay misses (killed, out of time, an
    out-of-machine runner) the reconcile's apply withdraws FIRST, outside the lane
    (`withdrawStrayMarkers`: every agent marker with no local `pub/`, one manifest page),
    so it never waits behind a running first-copy or AV round.
  - Cross-process ordering uses the advisory target lock (`mediaCopyTargetLockKey(host)`,
    `src/core/diffusion_bridge/target_lock.ts`).
  - `pub/<key>` is re-checked immediately before each put, so a put never lands after its
    record was unpublished.
- **Unpublish is a verified deletion**, in this order
  (`src/diffusion/targets/mediastore/media_copy_apply.ts`):
  1. `media.mark false`. The gate answers 404 on the next request, so withdrawn consent
     takes effect at the first command.
  2. The files are deleted.
  3. Their absence is confirmed against the manifest.

  Until it is confirmed, the deletion is pending in
  `<private>/publication_hosts_runtime.json` (`media_copy.pending_deletions[]`,
  `last_verified_at`). One older than a reconcile period is `blocked` (red) in the panel
  (`src/core/publication_host/media_copy_status.ts`). A failed delete never re-exposes the
  record, because its marker is already gone, and it is never reported as done. A path
  the agent answers it could not delete (`media.delete` `failed: {path, error}[]`) is
  data, not a stop: it stays pending, every later batch, grant and put still runs, and the
  round settles `failed` / `delete_failed` (the per-path errno in the log).
- No DB table: the copy state is the agent's manifest plus the runtime file.
- **Database pool cost** (built, phase 5): the cross-process `media:<host>` target lock
  is one main-pool transaction per unit, and a unit spans only agent CONTROL calls — a
  put's unit is the `pub/<key>` re-check plus at most two `media.mark` calls (60 s agent
  timeout each); the hash, the re-stat and the transfer run outside it, whatever the file
  size. A grant, withdraw or pre-empt unit spans at most `MEDIA_COPY_UNIT_KEYS` (50) keys
  — at most two live-proved `media.mark` calls each — and a delete unit one
  `media.delete` batch (`MEDIA_DELETE_BATCH` paths, one request); the lock is released
  between units and the round pre-empts between grant units, so a first sync or a mass
  unpublish never holds a connection for the whole plan. A host's units are serialized in one in-process lane, so copy costs at most one
  main-pool connection per copy host, never for a transfer's duration; a busy lock is
  waited for holding no connection. A withdrawal (`mark false`) is sent at once, outside
  every lane and lock — the agent's per-key lock and the grant's post-`mark` re-check make
  that order-safe (`media_copy_apply.ts` header). The reverse wait holds: a host's lane
  starts no unit while an immediate withdrawal begun before it is in flight, so the round
  that verifies a withdrawn marker always runs after its pending record
  (`media_copy_worker.ts`, gate `media_copy_worker_native`).
- **Never through a link** (built, phase 5): a file is opened only when no link lies
  between the media root's realpath and it. A public quality folder reached through a link
  (itself or a directory above it, e.g. `av/` on another volume) stays desired — its keys
  stay marked, the agent's copies are kept — but nothing in it is hashed or put; the round
  settles `failed` / `linked_quality` until it is mounted in place (a bind mount is not a
  link). Narrower than a FollowSymLinks shared host, the safe direction (`media_copy.ts`
  header).

## 6. Agent command set (closed)

Every route is under `BASE_PATH` `/publication/host_agent`. Only `/health` is public.
Every route is a literal path: no path carries a parameter, so the per-API release routes
are spelled out one per API (the copy-mode media path travels in the query of
`media.put`, never as a path segment). The route column is gated against
`publication/host_agent/src/router.ts` in both directions
(`publication/host_agent/tests/spec_routes.test.ts`).

| command | route | effect |
|---|---|---|
| (pairing) | `GET /health` | liveness + `instance_fingerprint` (§2.3); unauthenticated |
| `status` | `GET /v1/status` | agent + Bun version, platform, fingerprint, per-API `current`/`previous` release, applied rule hash, media probe, state-root free bytes |
| `media.probe` | `GET /v1/media/probe` | mount present, read-only, `pub/` readable, marker count |
| `rules.apply {server, text, hash}` | `POST /v1/rules/apply` | write the include, `configtest`, reload; on a failed configtest restore the previous file, re-run configtest, never reload |
| `rules.map {text, hash}` | `POST /v1/rules/map` | nginx only (§9.7). Validate the pushed http{} map against the closed map grammar, write THIS instance's contribution (one envelope) into the host-wide sticky `contrib/` store, start the root map renderer (`dedalo-pubhost-map.service`) and answer from its `result.json`: `{hash, host_hash, contributions, reloaded}`. The agent never writes the live map. `map_unmanaged` (409) when the host's `web.nginx_map` is `none`; `server_mismatch` on apache |
| `release.install {api: v1, release, sha256, bundle}` | `POST /v1/releases/v1` | §3 install of a v1 release; the bundle is the request body; a release the host already holds is promoted with NO body (D9: recorded sha = `X-Bundle-Sha256`, body unread) — an absent body (`Content-Length: 0`, `req.body === null`) is refused `body_invalid` only when the release must be staged |
| `release.install {api: v2, release, sha256, bundle}` | `POST /v1/releases/v2` | §3 install of a v2 release, auto-rollback on failed health; the bundle is the request body; a release the host already holds is promoted with NO body (D9: recorded sha = `X-Bundle-Sha256`, body unread) — an absent body (`Content-Length: 0`, `req.body === null`) is refused `body_invalid` only when the release must be staged |
| `release.rollback {api: v1}` | `POST /v1/releases/v1/rollback` | swap v1 `current` back to the previous release |
| `release.rollback {api: v2}` | `POST /v1/releases/v2/rollback` | swap v2 `current` back to the previous release, restart, health |
| `media.put {path, sha256, size}` | `PUT /v1/media/file` | `copy` mode only. `?path=` relative to `MEDIA_ROOT`; headers `X-Sha256`, `X-Size`, `X-Dedalo-Actor`; the raw file is the body. Shape-checked (≥ type/quality/file, no hidden segment, grammar-valid name, no working file, never under `original`/`modified`, confined); streamed to `.publication/copy/incoming/`, size + sha256 verified, then an atomic rename that happens ONLY while `pub/<key>` exists (re-checked under the key lock `media.mark` takes). The same bytes already present answer `unchanged`, body unread |
| `media.delete {paths}` | `POST /v1/media/delete` | `copy` mode only. 1–1000 relative paths, shape only: a stray, a master, a hidden entry or a symlink that landed must stay removable (a link is unlinked as itself, its target never touched); only the agent's top-level `.publication/` and instance marker are refused, and one refused path refuses the request. Answers `deleted` / `absent` / `failed` per path; verification is the next `media.manifest` |
| `media.mark {key, published}` | `POST /v1/media/mark` | `copy` mode only. Writes / removes `MEDIA_ROOT/.publication/pub/<key>` (`^[a-z0-9]+_[0-9]+$`), the marker the gate stats. Once `published:false` has answered, no put for that key can land |
| `media.manifest {cursor, limit}` | `GET /v1/media/manifest` | `copy` mode only. One path-ordered walk of `MEDIA_ROOT` minus the agent's top-level `.publication/` and instance marker: regular files with no hidden segment as `entries` `{path, size, sha256}`; EVERY other non-directory entry (symlinks, never followed; fifos, sockets, devices; hidden files; files under hidden directories) as `irregular` paths, on the page where they fall. `limit` 1–5000 (default 1000) counts both; opaque `next`; `markers` (every `pub/` key) on the first page only. The disk is the truth: a sha comes from the agent's index (`.publication/copy/sha_index.ndjson`) only while size and mtime match, else it is re-hashed. An unreadable directory fails the call, never hides files |

Errors are `application/problem+json` (RFC 9457, type base
`https://dedalo.dev/publication-host/problems/`, `Cache-Control: no-store`). Every
mutating call names its actor in the `X-Dedalo-Actor` header and is audited.

**Copy mode, agent side (phase 5).** A host whose `MEDIA_MODE` is not `copy` answers every
media route 409 `media_mode`. On a copy host a file lands only while its record's marker
exists, and the marker check and the rename share the per-key lock of `media.mark`, so an
unpublish that has answered can never be overtaken by a put that was still streaming. The
engine therefore publishes as `mark(true)` → puts and unpublishes as `mark(false)` →
`delete` → `manifest` (verified absence, §5.2). Nothing under the copy root is invisible
to that verification except the agent's own top-level entries: anything that is not a
plain regular file is reported as `irregular`, and the engine deletes it as drift. A link
or dotfile planted at a public path can therefore never outlive an unpublish unseen. The
copy root is served by the §5.1 `publication_host` profile rendered over it: Rule B gates
on the same markers, and rule 0 keeps `.publication/` (markers, incoming files, the sha
index) unserved. A copy host's request-body cap is the larger of `MAX_BUNDLE_BYTES` and the
64 GiB media-file cap.

## 7. Verification — the public-URL probe (built, phase 6)

A rule hash proves rules are INSTALLED, not that they GATE. The engine fetches, through the
publication host's **public URL**, a published file (must answer 200) and an unpublished
one (must answer 404): `src/core/publication_host/probe.ts` (`validateProbePaths`,
`probePublicGate`).

- **The public URL is a bare origin** (`http(s)://host[:port]`, no path, query, fragment or
  credentials). The probe requests `<origin>/dedalo/<mediaDir>/<path>`.
- **The operator chooses the two files.** They are the registry's `probe.published` and
  `probe.unpublished`: paths relative to `/dedalo/<mediaDir>/`, edited in the panel. There
  are no scratch records. A production database holds no test records, and a probe file
  the engine invented would prove the engine, not the site.
- **Before every probe, the engine proves the two files mean what they claim:**
  - the published path's key has `pub/<key>`;
  - the unpublished path's key has none;
  - both are regular files of the work media tree, in a public quality
    (`filterPublicQualities`, never a master tier), not working files;
  - both match `MEDIA_FILENAME_GRAMMAR`.

  A failed validation is `unknown` with its reason, and no request is sent. So a
  "published" file whose record was later unpublished makes the probe `unknown`, never
  `ok`.
- **Through the PUBLIC door** (`fetchGuardedText`, `engineering/OUTBOUND_SPEC.md` §2):
  vetted and pinned, redirects refused, a one-byte `Range` request under a tiny byte cap. A
  `public_url` that resolves to a non-public address is `unknown` (*not a public host … a
  private address*), never a pass. The guard is not relaxed for the institution's own
  site: a probe that reached an internal address would prove what an insider sees, not
  what the public sees.
- **Copy hosts: a 404 must be the gate's, not absence's.** On a `copy`-mode host the
  unpublished file is never copied (§5.2 desired set; the agent refuses an unmarked put),
  so its URL answers 404 with or without Rule B. After a 404 the engine asks the agent
  (`probe.ts` `agentCopyHolding`): not a copy host (`status.media.mode`, or, unreachable, a
  stamped `n/a` runtime row) → the 404 stands; a copy host whose `media.manifest` lists the
  file (a pending deletion — the exposure this probe exists to see) → the 404 proves the
  gate; a copy host that does not hold it, or an agent that cannot tell → `unknown`
  (*the copy host does not hold the unpublished probe file …*), never `ok`. A 2xx is
  `failed` whatever the agent holds. Not built: a synthetic unmarked canary the agent
  holds so a copy host proves its gate on every run (needs synthetic bytes and a planner
  exemption; never an unpublished record's real bytes on the public machine).
- **Verdict** (`probe.ts` `verdict()`, in this order): a definite bad answer on either side
  (published not 2xx, unpublished not 404) is `failed` (red), with both statuses recorded,
  even when the other side is `unknown`; otherwise any transport or validation failure is
  `unknown`, never `ok`; otherwise (published 2xx AND unpublished 404) `ok`.
- **When it runs:** after every successful `apply_rules`, after every copy-mode
  publish/unpublish batch, on demand (the root-only `probe_public` action), and on a
  schedule (`PUBLICATION_PROBE_RECONCILE`, report-only: it records the observation and
  changes nothing on the host). Results go to `<private>/publication_hosts_runtime.json`
  as `probe = {state, at, published_status, unpublished_status, detail}`; a proof older
  than two periods reads `warn` in the panel.
- **Drill:** `bun run test:pubhost:probe` (`scripts/publication_host_probe_drill.ts`) drives
  `probePublicGate` against a REAL Apache and a REAL nginx serving the §5.1 include. It
  checks a gated host, an open gate, a stopped server, invalid probe files and a public
  name that resolves to a private address.

## 8. Phases

| # | deliverable | depends on |
|---|---|---|
| 1 | `publication_host` rule profile (Apache + nginx), a CLI rendering it, the lockstep tripwire extended, a real-engine drill. Usable by hand before any agent exists. **Built:** `src/core/media/publication_host_rules.ts`, `bun run media:publication-host-rules`, `bun run test:media:pubhost`. | — |
| 2 | The agent: pairing, `status`, `rules.apply`, `media.probe`, `release.install/rollback`. **Built:** `publication/host_agent/` (daemon + root-run provisioner: mTLS material, units, sudoers, polkit, engine bundle), `src/core/publication_host/pairing.ts` + its twin tripwire, `bun run hostagent:test`, `bun run test:pubhost:agent`. Operator page: `docs/install/publication_host.md`. | 1 |
| 3 | Engine side: publication-host registry, the paired agent channel (the fourth outbound door), client, and the `publication_hosts` maintenance panel (`media_control` links to it; the media mode is declared on the host, §5). **Built:** `src/core/publication_host/` (registry, secrets, door, agent client, host status, expected rules), `scripts/publication_host_pair.ts`, `src/core/area_maintenance/widgets/publication_hosts.ts` + `client/dedalo/core/area_maintenance/widgets/publication_hosts/`, `test/unit/publication_host_door_tripwire.test.ts`, `engineering/wire_contract/WC-2026-10-03-publication-hosts-widget.md`. Operator page: `docs/install/publication_host.md` (*Pair it with the work system*, *The Publication hosts panel*). | 2 |
| 4 | Updater pushes the API bundles after an engine update. **Built:** `src/core/update/publication_manifest.ts` (extract-time manifest), `src/core/publication_host/bundle_writer.ts`, `src/core/publication_host/api_bundles.ts`, `src/core/publication_host/api_reconcile.ts` (confirm hook, `push_apis`, scheduled dry run), `src/core/publication_host/runtime.ts`, `bun run test:pubhost:engine` (`[lockstep]` rows). §3 *Lockstep*. | 2, 3 |
| 5 | `copy` mode: the media copy target + reconcile. **Built:** agent `media.put` / `media.delete` / `media.mark` / `media.manifest` (§6), `src/diffusion/targets/mediastore/media_copy.ts` (desired set, planner), `src/diffusion/targets/mediastore/media_copy_apply.ts`, `src/diffusion/targets/mediastore/media_copy_worker.ts`, `mediaCopyTargetLockKey` in `src/core/diffusion_bridge/target_lock.ts`, the `pub/` transition seam `src/diffusion/targets/mediastore/pub_transitions.ts`, `bun run test:pubhost:agent` (`[copy]` rows). §5.2. | 2, 3 |
| 6 | Public-URL probe, on change and scheduled. **Built:** `src/core/publication_host/probe.ts`, `bun run test:pubhost:probe` (`scripts/publication_host_probe_drill.ts`). §7. | 3 |
| 7 | The guided install, `provision init` (§9): discovery, comparison, confirmed action, the dedicated v1 pool, the web include, SELinux labels, the systemd profile, the locks, B4/B5; and the host-wide nginx map (§9.7). **In integration:** `publication/host_agent/deploy/install.sh`, `publication/host_agent/src/provision/init/` (B4 `verify.ts`, B5 `pair.ts`), `publication/host_agent/src/provision/selinux.ts`, the root map renderer `publication/host_agent/src/rules/host_map_main.ts`; drills `bun run test:pubhost:init` (Debian, local-only) and `bun run test:pubhost:init:el` (EL VMs, local-only, §9.11); the panel's New publication host (§9.14: `src/core/publication_host/drafts.ts`, `src/core/publication_host/kit_build.ts`, `src/core/publication_host/pair_flow.ts`). | 2, 3 |

Decided per phase, in its own plan: host registry storage (phase 3:
`<private>/publication_hosts.json` + per-host secret dirs, §2.1), transport (phase 2: mTLS +
bearer + pairing fingerprint, §2), bundle source and triggers (phase 4: the installed tree
under its extract-time manifest; the confirm hook, the panel, a dry-run schedule, §3), copy
worker placement (phase 5: in-process, not a diffusion runner, §5.2), probe file
provisioning (phase 6: operator-chosen, engine-validated, §7).

## 9. `provision init` — the guided install (phase 7)

The root-run guided install that does the operator page's steps 0–9
(`docs/install/publication_host.md`, *Guided install*): it discovers the host, compares it with
what the declaration needs, prints three lists (*already right*, *will change*, *needs your
decision*), and acts only on what the operator confirmed. `provision apply` stays the one
writer of every provisioned file; init orders it, and adds what apply may not do: create
accounts, make the site home root's, edit the operator's vhost, set SELinux booleans, write the
two API configuration files, prove the agent (B4) and pair it (B5).

### 9.1 Decisions (final)

- **Accounts.** init creates the missing accounts after confirmation and never modifies an
  existing one. `provision apply` never creates accounts. **Web server config.** init edits the
  operator's vhost only on a typed answer, with backup, configtest and rollback. **Bun** is
  downloaded on the publication host and verified (§9.10). **Pairing** through the work
  system's own CLI always exists: on one machine (unix listener, exactly one running
  `dedalo-ts`/`dedalo-ts@<site>` unit) B5 runs it as the engine user, token on stdin only; on
  two machines (tls) B5 writes the sealed pairing package (§9.12) that the work system's CLI
  opens; with `--no-pair`, without a terminal, or without a work unit on a socket listener it
  prints the operator page's step 6/8 commands — the loose-file pairing always stays available.
  **Database passwords** are typed only on the publication host.
- **v1 runs in its own dedicated, stamped PHP-FPM pool** per instance (`fpm_pool`, §9.4), as
  `v1.user`, with its own socket, `open_basedir` and temporary directory
  (`/var/lib/dedalo_publication_host/<instance>/v1/`); the website's PHP is never edited.
- **Layout.** The default is the per-site home `/home/<domain>/{dedalo, host_agent, .bun}`;
  the site's web server logs are OUTSIDE it, in the distribution's log directory per site
  (`/var/log/{apache2,httpd,nginx}/<domain>/`, `root:root 0755`, created by `apply` and rotated
  by the stamped `/etc/logrotate.d/dedalo_<instance>_web`: a sandboxed web unit — Ubuntu 26.04's
  `apache2.service`, `ProtectHome=read-only` — cannot open a log under `/home`), with the home made `root:root` `HOME_ROOT_MODE` (0755) by init as a *will change*
  item with the exact command; `/srv/dedalo_publication_host/<instance>` +
  `/opt/dedalo_publication_host/{host_agent,bun}` is the alternative and the automatic fallback
  when the home cannot be given to root (symlink, non-root ancestry, network or `noexec`
  filesystem, a web/FPM unit sandbox hiding `/home`).
- **Supported:** Debian 12/13, Ubuntu 24.04/26.04, RHEL/Rocky/Alma 9 and 10, SELinux enforcing,
  permissive or disabled (`OS_SUPPORT`, `publication/host_agent/src/provision/init/parse/os.ts`). Not: Ubuntu 22.04
  (polkit 0.105), RHEL/Rocky/Alma 8 (systemd 239 < the units' 247, kernel 4.18 < Bun's 5.1),
  CentOS Stream, Oracle Linux, musl — each a blocking `host.os` naming the manual guide. EL 8
  never reaches it: `deploy/install.sh` `family_of` refuses an EL major below 9 and
  `refuse_kernel` a kernel below `BUN_KERNEL_FLOOR` before any Bun is fetched (Bun is not
  run on a kernel it does not support; `tests/init_install_sh.test.ts`). EL 9
  ships PHP and nginx as `dnf module` streams, EL 10 has none (`OsSupport.dnfModules`: the
  printed install commands differ): its `php-fpm` is `OsSupport.appStreamPhp` (8.3), and another
  AppStream PHP is an alternative package `php<v>-fpm` with the same paths (flavour `el`; measured
  RHEL 10.2: `php8.4-fpm`, conflicting with `php-fpm < 8.4`, so over an installed el PHP
  `host.fpm_install` prints `--allowerasing` and says it replaces it); neither ships `mod_php` (only Remi's `php<NN>-php`).
- **One host-wide nginx map** (§9.7). **Locks** shared with apply and check (§9.6). **The Bun
  table's signature** is verified when the pin moves (§9.10).

### 9.2 Entry

`publication/host_agent/deploy/install.sh` is the ONLY entry point (first run with `--source`
or `--kit` (§9.13), re-runs through `<INIT_BASE>/<instance>/rerun.env`). Root never runs code or config a non-root
account can write: before Bun starts it stages the closed source manifest
(`publication/host_agent/src/provision/init/constants.ts` `SOURCE_MANIFEST`) into root-owned
0700 directories, refusing special files and escaping symlinks, shows the source digest for
consent (whoever can write the source can become root through init — stated to the operator),
verifies Bun against `.bun-sha256` before `--version`, and starts Bun with `cd <stage>`,
`env -i`, `--no-env-file`, `--no-install` and an empty bunfig. Those are the real controls; the
in-process checks of the init orchestrator are footgun guards against hand starts. The stage is
one path per instance, so it is cleared only under install.sh's own flock
(`<INIT_BASE>/<instance>/install.lock`, `INSTALL_LOCK_NAME`), taken non-blocking before the
clear and held across the exec until init exits: a second install.sh for the instance refuses
instead of wiping a stage a running init reads (a file of its own, never init's `init.lock`).

### 9.3 Command sets

Every spawn stays in `publication/host_agent/src/exec.ts`. `provisionExec()` is the closed set
of **29** commands the provisioner may run (read-only probes, the web/FPM configtests, the
SELinux label commands of apply, `rm -rf --one-file-system` of a RETIRED tree — only a
root-owned 0700 directory named `*.dedalo-provision.retired`, §9.15 — and the four commands of
the provisioner's own SELinux policy module, §9.8: `semodule --list-modules=full`, `semodule -X
400 -E dedalo_publication_host` in a fresh root 0700 directory, `semodule -X 400 -i` of its one
root-owned source file, `semodule -X 400 -r dedalo_publication_host`); none creates an account.
Every command of both sets spawns with a finite timeout (SIGKILL, exit 124): `COMMAND_TIMEOUT_MS`,
`UNIT_JOB_TIMEOUT_MS` for the systemd jobs, `RELABEL_TIMEOUT_MS` for `semanage import` /
`restorecon` / `semodule -E|-i|-r` / the tree removal — init runs several of
them while it holds the host web lock (`tests/provision_exec.test.ts`). `initExec()` is a separate closed
set of **22** commands for init alone (discovery, the account creators, `a2enmod`/`a2dismod`
on Debian, `setsebool`, the Bun unpack, and the pairing child `setsid --wait runuser -u <engine
user> -- <bun> --no-install <checkout>/scripts/publication_host_pair.ts …`, whose token reaches
stdin only). The two sets are disjoint (`publication/host_agent/tests/init_exec.test.ts`); the
counts here are held to the code (`publication/host_agent/tests/spec_privileges.test.ts`). The
fapolicyd trust oneshot (§9.11) has its own closed set, `trustExec()`: `systemctl is-active --quiet
fapolicyd.service`, `fapolicyd-cli --update` and `fapolicyd-cli --dump-db`, fixed argv, root PATH,
`TRUST_COMMAND_TIMEOUT_MS` (`publication/host_agent/tests/exec.test.ts`); `provision apply`'s
`fapolicyd-update` op uses the same set.

### 9.4 Artifacts and validators

Seven artifact kinds join the provisioner's census
(`publication/host_agent/src/provision/render/types.ts` `ARTIFACT_KINDS`):

| kind | path | validator, effect |
| --- | --- | --- |
| `web_include` | `<configBase>/<instance>/web.<server>.conf`, referenced once from the operator's vhost by a stamped `IncludeOptional` (nginx: a zero-match glob `include`) | `web` (post-rename configtest under the host web lock, restore on failure), `reload_web` |
| `fpm_pool` | the FPM flavour's pool directory, `dedalo_<instance>_v1.conf` | `fpm` (`php-fpm -t`), `reload_fpm` |
| `nginx_map_include` | `/etc/nginx/conf.d/dedalo_media_map.conf`, host-wide, stamped `_host` | `web`, `reload_web` |
| `host_map_unit` | `dedalo-pubhost-map.service`, host-wide, stamped `_host` | — |
| `logrotate` | `/etc/logrotate.d/dedalo_<instance>_web`, home layout only: rotates the site's web log directory `/var/log/<apache2\|httpd\|nginx>/<domain>/` (`plan.ts` creates it `root:root 0755`), which the distributions' own logrotate globs (one level) never reach | — |
| `trust_unit` | `<unit_dir>/dedalo-pubhost-trust-<instance>.service`, only where fapolicyd is installed (`layout.trust`): the root oneshot of §9.11 | `daemon_reload` |
| `logrotate_v1` | `/etc/logrotate.d/dedalo_<instance>_v1`, every site in either layout: rotates the v1 pool's own error log `<v1_var_base>/<instance>/v1/log/*.log` as the v1 user (`su <v1> root`: the directory is that account's, `v1VarWork`), the new file `0600 <v1>:root`; no reopen (PHP opens its `error_log` for every message) | — |

`web_include` and `fpm_pool` apply only with the optional declaration block `site`; the two
host-wide kinds only on nginx with `web.nginx_map: conf_d`. The Apache v1 handler sits inside
`<If "-f %{REQUEST_FILENAME}">` with the pattern `\.ph(?:ar|p|tml)$` — every name a captured
distribution handler claims, a stemless `.php` included (EL's `\.(php|phar)$` and Ubuntu 26.04's
`\.ph(?:ar|p|tml)$` match it) — so it beats EL's
server-wide `conf.d/php.conf` handler (a `<FilesMatch>`, which merges after `<Directory>`;
`<If>` merges last) inside the vhost; `mod_php`
is switched off in the v1 tree. A web or FPM master that dies on the reload after a passing
configtest (an SELinux denial the configtest cannot see) gets its backup restored, a configtest
and a restart (`rolled_back{reload}`).

### 9.5 Modes

The new rows of `MODES` (`publication/host_agent/src/provision/layout.ts`; owner:group mode):

| row | owner | group | mode |
| --- | --- | --- | --- |
| `v2Env` | root | v2Group | 0640 |
| `v1Config` | v1 | root | 0400 |
| `webInclude` | root | root | 0644 |
| `fpmPool` | root | root | 0644 |
| `webLogs` | root | root | 0755 |
| `logrotate` (both logrotate kinds) | root | root | 0644 |
| `nginxMapInclude` | root | root | 0644 |
| `v1Var` | root | root | 0711 |
| `v1VarWork` | v1 | root | 0700 |
| `hostBase` | root | root | 0755 |
| `hostLocks` | root | pubhost | 0750 |
| `hostProvisionLock` | root | root | 0600 |
| `hostWebLock` | root | pubhost | 0640 |
| `hostNginxMap` | root | root | 0755 |
| `hostNginxContrib` | root | pubhost | 3770 |
| `hostMapRenderer` | root | root | 0755 |
| `initState` | root | root | 0700 |
| `journal` | root | root | 0600 |
| `initLock` | root | root | 0600 |

`pubhost` is the group `dedalo_pubhost`: created by init only (or by hand with `groupadd
--system dedalo_pubhost`; a hand-run `provision apply` without it is refused with that line),
given to every agent unit through `SupplementaryGroups=`, so no account is ever modified.

**Root writes only through trusted ancestors, and one pinned parent.** Every provisioner and
init write re-checks its ancestry at the moment of the write (`apply.ts` `hostIo`, `init/host_io.ts`):
every directory between the trust root and the target is a real directory and all but the
immediate parent are root's and closed to group/other writes. ONE exception, for an untrusted
GRANDPARENT under a root parent — the site log directory under Ubuntu's rsyslog `/var/log`
(`root:syslog 0775`), init's API files in the agent's `publication_api/<api>/shared/`: the parent
is PINNED (`pinnedParentOf` / `withPinnedDir`: opened `O_DIRECTORY|O_NOFOLLOW`, the working
directory moved into that inode, the entry used by name), and it must be the parent the caller
EXPECTS (`PinExpectation`): the exact owner, group and mode of its `MODES` row (`v1Shared`
`root:root 0711`, `v2Shared` `root:<v2 group> 0750`), or the facts `observeHost` saw — owner,
group, mode, device and inode, carried in the plan's action — for `/var/log/<server>`; and on the
same device as its own parent, so a filesystem mounted over the name is refused. A directory
substituted after the pin receives nothing (the write lands in the pinned inode). The plan judges
the polkit rules file's immediate parent like every other ancestor but for ONE owner: EL's polkit
package ships `/etc/polkit-1/rules.d` as `polkitd:root 0700` (measured, RHEL 9.8), and the daemon
that evaluates the file already decides every grant, so that directory — for that file only — may
be `POLKIT_DAEMON_USER`'s, never group- or world-writable (`plan.ts` `polkitDirTrusted`). Gates:
`tests/provision_host_io.test.ts`, `tests/init_host_io.test.ts`, `tests/provision_plan.test.ts`.

### 9.6 Locks and the journal

Every lock is `flock(2)` on a root-created file opened `O_NOFOLLOW`
(`publication/host_agent/src/provision/flock.ts`; the policy is
`publication/host_agent/src/provision/lock.ts`): the kernel drops a dead holder's lock, so
there is no stale-lock logic. Order: (1) the instance lock
`/var/lib/dedalo_publication_host_init/<instance>/init.lock` — init and apply exclusive, check
shared; apply waits 5 s then refuses naming the holder, check ends exit **5 (busy)**; (2) the
host provision lock (apply, around the host-wide items); (3) the host web lock, around every
configtest+reload of the web server or PHP-FPM, by root and by every agent. The journal
(`journal.jsonl`, root 0600 beside the lock) records `begin` and a terminal phase per item and
never holds a secret; `--resume` continues an unfinished run, but correctness never depends on
it: every run re-discovers and re-compares.

### 9.7 The host-wide nginx media map

nginx's media include uses three variables only an http{} `map` can define, once per host, and
the map depends on the engine version and its `mediaDir`/image folder. On a host whose
declaration says `web.nginx_map: conf_d` the engine pushes `buildNginxMap()` as `rules.map`
(`POST /v1/rules/map`, §6) BEFORE the media include. The agent validates it against the closed
map grammar (`parseNginxMap`, `publication/host_agent/src/rules/directives.ts`) and writes only
its OWN contribution (one envelope) into the sticky store
`/var/lib/dedalo_publication_host/_host/nginx_map/contrib/`; the ROOT oneshot
`dedalo-pubhost-map.service` (`publication/host_agent/src/rules/host_map_main.ts`, one
root-owned code copy per host installed by apply, never downgraded) re-validates every
contribution against the declared agent uids, merges them (`renderHostMap`), and is the only
writer of the live map nginx loads through the provisioned include. A contribution of a grammar
the installed renderer does not know refuses the whole render (`map_contribution_newer`). The
renderer's spawns are a closed set (`src/exec.ts` `rendererExec`: `nginx -t`, `systemctl reload
nginx.service`, `systemctl is-active nginx.service`, `systemctl restart nginx.service`). After a
reload that returned 0 the unit is watched for the provisioner's window (`txn.ts`
`RELOAD_ACTIVE_POLL`, 20 × 250 ms); found down (an AVC or a bad module kills the master at the
reload, after a configtest that passed as unconfined root), the map is ROLLED BACK: the last
loaded file restored (or a first one removed), configtest, `restart`, confirmed active, outcome
`reload_failed` with the PREVIOUS contributions recorded as loaded; the rendered bindings and the
seed's sweep are not committed. The panel row carries the map as `nginx_map` AND as the check
`nginx_map` (`host_status.ts` `nginxMapCheck`: red for `agent_outdated`, a recorded refusal,
`none`, `drift`; ok for this instance's hash loaded or `unmanaged`).
Residual (stated): the map is keyed on `$uri` across every server block, so a paired engine of
one instance can weaken another site's SVG treatment for URIs under its own bound envelope
prefix. With `web.nginx_map: none` (the default) the agent reports `{managed: false}` and the
engine skips the map step; the operator places the map by hand.

### 9.8 SELinux

On EL with SELinux enforcing or permissive, `provision apply` registers the instance's file
contexts and the v2 port label (`http_port_t`) in ONE `semanage import` transaction, relabels
with `restorecon`, and requires a following `restorecon -n` to report nothing pending — all
before any configtest or unit restart. The table is
`publication/host_agent/src/provision/selinux.ts` `selinuxRules`: label only what `httpd_t`
must reach, as narrowly as the access needs (search-only `-f d` rules on the directories httpd
traverses, `httpd_sys_content_t` on the v1 tree, `httpd_config_t` on the rules and the host
map, `httpd_log_t`/`httpd_sys_rw_content_t` for the v1 pool's log and temporary files (the
site's web logs under `/var/log/{httpd,nginx}/<domain>` are `httpd_log_t` by the policy's own rules),
`usr_t`/`bin_t` for the agent code and Bun; and on the v2 tree, under EVERY layout,
`dedalo_publication_v2_t` (below; owner decision 2026-10-09: one v2 type on every EL layout) —
systemd (`init_t`) may read neither the units' `EnvironmentFile=` `v2.env` nor the agent's
`current`/`scratch` links under the home's `user_home_t` (measured, RHEL 9.8: AVC `init_t` read on
`user_home_t` `lnk_file`/`file`, found by the EL drill's first v2 push) nor under /srv's `var_t`
(sesearch, RHEL 9.8), so no v2 unit could start; what the agent creates there inherits the type).
The home layout's tree was first typed `data_home_t` — the one policy type, before the module,
that `init_t` reads (as a `gnome_home_type`, with write) and `httpd_t` reads only under
`httpd_read_user_content` (a `user_home_type`). The module's type keeps every constraint that
drove it and narrows both: `init_t` read-only, `httpd_t` nothing under any boolean, `fapolicyd_t`
reads it like any `file_type`, the v2 service and the agent are unconfined. Under /home the local
rule beats the policy's generic home-directory entries (a longer stem; matchpathcon, restorecon
and `semodule -B` keep it — measured RHEL 9.8), the home itself and its ancestors keep their
types (`home_root_t` by row H, `user_home_t` below it, both searchable by `init_t` through
`file_type:dir`), and the site user's login is untouched (the EL drill's `home-login-and-logs`).
An install `data_home_t` still types is re-typed IN PLACE by the next apply: a local rule on one of
our specs whose type is the one this instance's own `selinux.state` recorded there is ours, so the
import carries `-d` of the old type then `-a` of the new (one transaction, measured RHEL 9.8) and
the relabel follows; any other rule of another type on our spec stays the operator's, refused.
`data_home_t` is RETIRED (`selinux.ts` `RETIRED_SELINUX_TYPES`): admitted in a `-d` line only,
never registered again. The only rules on paths the provisioner did not
create are the exact `-f d` rule on the site home (one inode) and the consented shared media root
(below). No rule ever gives
`S/publication_api/v2` or `S/audit` an httpd-readable type. Booleans (`SELINUX_BOOLEANS`) are
init decisions only, host-wide, never `--yes`, the narrowest first; `httpd_graceful_shutdown`
is read, never written. A SHARED media root (a directory the provisioner did not create) is
labelled `httpd_sys_content_t` only on the declaration's consent field `media.selinux_label: true`
(shared mode only; init writes it on a `selinux.media_access=act` answer; removing it
unregisters the rule on the next apply), and only on a local or seclabel filesystem — a network
mount gets the fstab `context=` option or a `httpd_use_*` boolean instead. Never `setenforce`.

**The provisioner's policy module** (owner decisions 2026-10-09). No policy type fits a v2 tree
(systemd must read it, httpd must not), so the provisioner ships ONE module,
`dedalo_publication_host` (`publication/host_agent/src/provision/selinux_module.ts`), as CIL —
no compiler: libsemanage builds CIL on EL 9 and 10 (measured `semodule -i` of a `.cil`, RHEL 9.8
and 10.2). It defines ONE file type, `dedalo_publication_v2_t` (the reference policy's
`files_type()` attributes: `file_type`, `non_security_file_type`, `non_auth_file_type`), and
grants `init_t` read-only access to it (`dir` getattr open read search, `file` getattr open
read, `lnk_file` getattr read: `EnvironmentFile=`, `WorkingDirectory=`, `AssertPathIsDirectory=`).
Nothing else: no rule for `httpd_t` (it reaches v2 over the port; the policy's own `httpd_t
file_type:dir { getattr open search }` lets it traverse, never read a file — the EL drill's
control), no domain (the v2 service and the agent run `unconfined_service_t`: `init_t` executing
`bin_t` transitions there, and it is a `files_unconfined_type`), no boolean. It is needed exactly
when the layout's S9 table names its type (`selinux.ts` `moduleNeeded`: every layout) and is
host-wide: one source, `<host_base>/dedalo_publication_host.cil` (root `0644`,
stamped `; dedalo-provision: _host selinux_module <sha>`), shared by every instance that needs it.
`provision apply` writes the source when it differs and runs `semodule -X 400 -i` when the
installed module is absent or an older one of ours — BEFORE the `semanage import` that names the
type (libsemanage refuses an fcontext of an undefined type, measured), the relabel and every unit
start — then extracts it again (`semodule -X 400 -E`, which gives a CIL module back byte for
byte, measured) and holds it equal to the rendered source. A module of that name that is not
ours — at another priority, in another language, disabled, or whose extracted text is not one of
our stamped, unedited sources — is refused, never replaced; so is a source file that is not ours.
When neither this layout nor any sibling declaration needs it (siblings observed), ours is
removed with `semodule -X 400 -r` AFTER the import whose `-d` lines unregistered our last rule
naming the type (semodule refuses a removal while one does, measured), and its source with it;
unobserved siblings decide nothing (`provision check` says so). Since every layout needs it, a plan
for a declared instance never retires it: the retirement half (`plan.ts` `selinuxModulePlan`,
`needed` false) is the law for a host with no declaration needing it, which no door reaches yet
(no instance-removal command exists). init states it as
`selinux.v2_policy` (a *will change* item without an action of its own: `provision.apply` does
it; right once ours is installed and current, blocked by a foreign one).

### 9.9 systemd profile

ONE profile: `SYSTEMD_FLOOR` = 247 (`layout.ts`; `LoadCredential=` delivers the token,
`ProtectProc=` hides other processes). Every supported OS ships more (Debian 12 and EL 9 252,
Ubuntu 24.04 255, Debian 13 and EL 10 257, Ubuntu 26.04 259). There is no declaration field: below the floor
`host.systemd` blocks init and `plan` refuses. Every rendered directive form is dated in
`publication/host_agent/src/provision/render/systemd_floors.ts`; `checkDirectives` throws on an
undated form or one newer than the floor, so a renderer can never emit hardening a supported
host's systemd would silently skip. `ProtectHome=` is a host-wide fact: `read-only` on every agent unit
when any declaration on the host is home-bound, so the agent's sudo configtest sees the same
includes the root master loads.

### 9.10 The Bun hash table and its signature

`.bun-sha256` (repo root): `# bun-v<pin>`, `# signed-by: <release-key primary fingerprint>`, one
`<sha256>  <asset>.zip` line per `BUN_ASSETS` entry. `scripts/ci/bun_pin_hashes.ts` (run by
whoever bumps `.bun-version`) takes the hashes ONLY from the payload of Bun's clearsigned
`SHASUMS256.txt.asc`, verified with `gpgv` against the pinned fingerprint
(`BUN_RELEASE_KEY_FINGERPRINT`); the signed file is committed under `ci/bun/` and CI re-verifies
it (the CI image carries `gpgv`). install.sh and init check the archive against the table
before running it. Residual: the signed payload names no version; the download URL and the
post-verify `bun --version` bind it to the pin.

### 9.11 Verification

Package gates (`publication/host_agent/tests/init_*.test.ts`, `provision_*.test.ts`), the root
gates (`test/unit/publication_host_init_pair_native.test.ts` — B5 against the real pairing
command; `test/unit/publication_host_operator_doc.test.ts` — the operator page held to the
code; `test/unit/publication_host_init_v2_env_native.test.ts` — a rendered `v2.env` boots v2's
own config), and two drills, both local-only (no hosted runner can give either: CI jobs run
inside the CI image's container, with no privileged sibling and no SELinux kernel):

- **Debian** (`bun run test:pubhost:init`, `scripts/publication_host_init_drill.ts`): a
  disposable privileged container with systemd as PID 1, built on the CI image's Debian with
  apache2, nginx, php-fpm and polkitd; `install.sh` and the CLI as children only. Legs: fresh
  converge through a local https mirror, an all-right re-run, an injected configtest failure
  rolled back, `kill -9` mid-item then `--resume`, the second-variant pre-created API files, the
  nginx host map through a mock engine, the hand-map migration, a mixed-version map leg, and
  `agent-root-grant` (both families): the agent's ONE root grant through the host's own sudo —
  `visudo -c` over the policy with the rendered grants, each agent user's `sudo -n
  <WEB_CONFIGTEST_BIN> -t` runs and any other argv is refused, and a `rules.apply` over the
  running nginx instance's socket runs that configtest FROM THE AGENT'S UNIT (its sandbox) plus
  the polkit reload, proved by the auth log's line for the agent's working directory. Before it
  no leg reached `src/exec.ts webConfigtest`: the host map is rendered by root, not by an agent.
  `--in-place` runs the same legs AS ROOT ON a disposable Debian or Ubuntu VM instead (same
  `/etc/dedalo_init_drill_host` refusal as EL): systemd PID 1 from boot, a real `/`, and a
  kernel that ENFORCES AppArmor, which the container never does; its in-place-only leg
  `no-apparmor-denial` finds no `apparmor="DENIED"` line in the journal (or audit log) since the
  start and records which of the layout's processes are confined. `--capture` keeps that host's
  discovery outputs too. Green on Ubuntu 24.04.5 (aarch64, kernel 6.8, systemd 255, polkit 124),
  2026-10-09, 11/11 legs. Measured there: no profile confines apache2, nginx, php-fpm, polkitd,
  sudo or Bun (24.04 ships none; only rsyslogd of what runs is enforced), so the layout needs no
  `/etc/apparmor.d/local/` override; `kernel.apparmor_restrict_unprivileged_userns=1` touches
  nothing (systemd, as PID 1, builds every unit's namespaces); a stopped, disabled `apache2` stays
  listed `loaded inactive` beside a running nginx — observe proposes and reads the server that
  RUNS, and a `host.web` answer for the other one is observed again (`run.ts observedDraft`);
  `fs.protected_regular=2` (Ubuntu's default) refuses even root an `O_CREAT` open of an agent's
  existing contribution in the sticky `contrib/` — the agent's own write is a temp file renamed
  over it (`rules/map.ts`), and root only reads and unlinks there. Green on Ubuntu 26.04.1
  (aarch64, kernel 7.0, systemd 259, polkit 127, PHP 8.5), 2026-10-09, 12/12 legs, first run
  of the 11 with no fix. Measured there: `/usr/bin/sudo` and `/usr/sbin/visudo` are sudo-rs
  0.2.13 (`/usr/lib/cargo/bin/`; no `/etc/sudoers-rs`); sudo-rs's `visudo -cf` and `visudo -c`
  accept the rendered `Cmnd_Alias` + `NOPASSWD:` rule, check every `@includedir` file, and refuse a
  broken or duplicate one; the grant admits exactly `<bin> -t` from the agent's unit
  (`NoNewPrivileges=no`). `apache2.service` is sandboxed (`ProtectHome=read-only`,
  `ProtectSystem=full`, `InaccessiblePaths=/boot /root -/etc/sudoers -/etc/sudoers.d …`,
  `PrivateTmp=yes`, `Type=notify`, `ReadWritePaths=/var/log/apache2 …`): the sites' logs in
  `/var/log/apache2/<domain>` and the read-only home serve, reload and configtest cleanly — the
  same sandbox the container capture holds. Installing apache2, nginx and php8.5-fpm adds no
  AppArmor profile; of what runs only chronyd and rsyslogd are enforced, none of the layout's
  processes is confined, no `DENIED` line. The TWO-MACHINE path (no drill script: a docs-built
  work system made its own dev-channel code server, a release-built panel kit, `install.sh --kit`,
  CLI and panel pairing, token-rotation teardown, first use on v2-only and v1+v2) is green there
  too, 2026-10-09, with no fix: ufw's docs rule, sudo-rs on both sides, the agent's configtest
  grant from its unit during concurrent `rules.apply` on two instances under request load (no
  failed request across the reload), v1 on PHP 8.5 (clean under `error_reporting=-1` on the
  exercised paths), no fapolicyd item rendered. With `mariadb-server` installed, `mariadbd` IS
  enforced (Ubuntu ships its profile), and v1/v2 over its unix socket raise no `DENIED` line.
- **EL** (`bun run test:pubhost:init:el`, same script, `--family el --in-place`) on a
  disposable RHEL/Rocky/Alma 9 or 10 VM with SELinux enforcing, refusing any host without
  `/etc/dedalo_init_drill_host`. It proves the `<If>` handler (a `.php` and a `.phtml` probe
  answer as `v1.user` under `fpm-fcgi`) under the EL 9 and EL 10 `php.conf` and under Remi's
  mod_php, the relabelled home's sshd login, the site's logs outside the home, the home layout's v2
  tree `dedalo_publication_v2_t` (recorded as `home_v2_type`), the migration of a home-layout
  install typed `data_home_t` (`home-v2-migration`: re-typed by init's re-run, tree relabelled, a
  second re-run changes nothing, v2 restarts and answers, no AVC), a network media mount with the
  `context=` option, fapolicyd, a SYSTEM-layout v2-only site (`system-layout-v2`: the policy module of
  §9.8 installed and extracted equal to its source, the v2 tree `dedalo_publication_v2_t`, a pushed
  release started by systemd and answering, sesearch granting `init_t` and not `httpd_t`, and the
  control — one world-readable file served as `httpd_sys_content_t`, denied to httpd once it carries
  `dedalo_publication_v2_t`; it also records `system_default_readable`, whether `init_t` may read
  the default type under /srv), an empty AVC search (that control's one denial aside), and
  `systemd-analyze verify` with no warning naming a rendered unit. Its `--record` writes the EL
  drill record (`el_drill_record.json` under `engineering/`: ONE inputs digest, one entry per EL
  major, each its own run — commit, time, legs, measured types and floors — so recording one
  major never rewrites another's measurements); the root ratchet `test/unit/publication_host_el_drill_record.test.ts`
  then turns any change to an EL-relevant input (`EL_DRILL_INPUTS`, `src/provision/selinux.ts`)
  red until the drill runs again, and names each supported major not yet recorded
  (`PENDING_EL_HOSTS`, shrink-only). `--capture <dir>` keeps the raw discovery outputs (the argv
  init's exec door runs) for the typed EL fixtures. Recorded: RHEL 9.8 and RHEL 10.2 (aarch64, enforcing), 2026-10-09.
  **fapolicyd** (default rules, measured RHEL 9.8): root may execute an untrusted Bun, but that
  Bun may not read the TypeScript it runs (libmagic types it `text/x-java`, a language type), and
  an unprivileged account may not run it at all. `install.sh` probes the read before the
  hand-over (`fapolicyd_gate`) and refuses with the line that trusts its Bun — root must read the
  installer's code before any unit exists. From there the trust is AUTOMATIC (owner decision
  2026-10-09). Where fapolicyd is INSTALLED (`FAPOLICYD_CLI` a real file — `derive()`'s
  `DeriveHost.fapolicyd`, passed by `cli.ts` and init's draft; running or not) the layout carries
  `trust`: the root oneshot `dedalo-pubhost-trust-<instance>.service` (`render/trust_unit.ts`:
  `Type=oneshot`, `User=root`, empty environment, ExecStart naming the instance and its
  declaration, `ProtectSystem=full` with the trust directory and the instance's config directory
  writable), the one polkit pair that lets the agent start it, the env keys `TRUST_UNIT` and
  `TRUST_RESULT_FILE`, and ONE trust file `/etc/fapolicyd/trust.d/dedalo_<instance>`.
  **The set is derived, never named** (`src/provision/fapolicyd_trust.ts` `deriveTrust`): every
  regular file of `bun_bin`, `agent_dir`, the nginx `conf_d` renderer's Bun, the instance's polkit
  rule BY ITS RENDERED BYTES (polkitd reads it as JavaScript; with `allow_filesystem_mark = 1`
  fapolicyd checks the sandboxed `polkit.service`, and an untrusted rule failed to load: every
  reload the agent asked for answered "Interactive authentication required" — measured, RHEL 10.2,
  2026-10-09), and, for each SERVED
  API, the release `current` names and the store's `previous` (the newest other release by mtime,
  `releases/store.ts`) — right after a commit that is the release under test. Walked by name,
  lstat only: a link is never followed and never trusted (v1's D8 links are counted, skipped).
  What cannot be verified is never trusted, at two scopes: the CODE (`bun_bin`, `agent_dir`, the
  renderer's Bun, the state root — a link in place of a root, an unreadable or unlistable entry, a
  path a trust line cannot carry, a FIFO, more than `TRUST_ENTRY_CAP` files) refuses the WHOLE set
  (fail closed, the previous file kept); ONE RELEASE (a `current` that is not `releases/<id>`, a
  release that is not a real directory, a hard-linked file, any of the above inside it) is left
  OUT and named (`refused`; `provision check` reports it as drift, the record carries it) — the
  code and the other releases stay trusted (measured: the drill's v1 handler probe plants a
  `current` naming a non-release, and a whole-set refusal there stopped `provision apply` for
  the whole instance). The file is our stamp (kind
  `fapolicyd_trust`), comments, and fapolicyd's `<path> <size> <sha256>` lines in path order; a
  file without our valid stamp for THIS instance is never rewritten or removed. **Two writers,
  one rendering** (`renderTrustFile`): `provision apply` — `observeHost` derives, the plan writes
  on drift (`write`, label `fapolicyd_trust`, root 0644) and, with the daemon running, the tail op
  `fapolicyd-update` BEFORE every start and restart, then `restart polkit` (it has no reload, and it
  loaded the rules file the moment the fs phase wrote it, before the update listed it: a failed load
  heals on every trust update that lists the rule); init runs `provision apply` after every
  `code.install` or `bun.install` on such a host even when the plan computed before them is empty
  (the new code is drift only after it lands: measured, an upgrade restarted into "EPERM reading
  …/src/index.ts"); and the oneshot
  (`src/provision/fapolicyd_trust_main.ts`) under the host provision lock, which writes
  atomically and records its run in `<config_base>/<instance>/fapolicyd_trust.json`.
  `fapolicyd-cli --update` returns before the daemon reloaded (measured: ~0.3 s), so both wait
  until `--dump-db` lists the last line the new file added (`commitTrust`). **The agent passes
  nothing** (`src/releases/trust.ts`): it starts the oneshot after a release's commit and BEFORE
  its scratch boot (the release is then `previous`), before re-promoting a reused release (stamped
  newest first, `store.ts markNewest`), before a rollback's swap (the target is `previous`), and
  once more after each swap (recorded in the audit, never fatal); a failed start, a record that
  is not `applied`/`unchanged`/`inactive`, or one that does not list THAT release among the trusted
  refuses `trust_failed` with the previous release serving.
  `GET /v1/status` carries `trust: {unit, record}` (null without fapolicyd). fapolicyd uninstalled,
  the unit and the trust file are RETIRED (`retire.ts`, both kinds in `RETIRABLE_KINDS`, the trust
  file recorded beside its unit); a declaration removed by hand makes the oneshot remove its own
  file (`retired`). init's `host.fapolicyd` is right with the automatic trust, a blocking
  host-wide decision when fapolicyd's `trust` lacks `file` (trust.d unread) or its config is
  unreadable; `host.fapolicyd_integrity` is an optional host-wide decision when `integrity` is
  `none` or `size` (a file changed after it was trusted would still run), printing the commands
  that set `integrity = sha256`; `host.fapolicyd_mounts` the same when `allow_filesystem_mark` is
  `0` (fapolicyd's default: it marks MOUNTS, so it never sees what a process in its own mount
  namespace opens — every unit here has one (ProtectSystem=, ProtectHome=, PrivateTmp=), and
  measured on RHEL 9.8 an untrusted agent and a changed release both started; `1` marks the
  filesystems). The EL drill's fapolicyd leg proves it with fapolicyd enforcing,
  `integrity = sha256` and `allow_filesystem_mark = 1` — with the trust file moved aside the
  restarted agent stays down — two minimal v2 releases pushed through the agent start and answer
  `/health`, a rollback answers, and a release file changed in place after it was trusted is
  denied (measured on RHEL 9.8: the same inode, one byte changed — fapolicyd refuses it, and
  accepts it again once the byte is back). fapolicyd gates programs and `%languages` files only:
  a file libmagic types `text/plain` is never gated, trusted or not (measured), so the drill's
  release entry is written to type `text/x-java` and the leg asserts it. A start fapolicyd denies
  makes Bun fall back to `bun run`, whose `/tmp/bun-node-<build>` links systemd may not unlink
  from the unit's PrivateTmp (one AVC per denied start, measured); the v2 units run
  `bun src/index.ts` (a plain `bun run <file>` made those links at EVERY start, so every v2 stop
  cost an AVC), and the leg proves the changed entry's denial with v2 stopped, in a namespaced
  transient unit (its journal's `EPERM`) and directly.

### 9.12 The sealed pairing package (two machines)

At the end of a two-machine install (a `tls` listener, not `--no-pair`) B5 is the item
`pair.package`: init reads the engine fragment, the agent's `SERVICE_TOKEN` and the engine TLS
bundle as root and seals them into ONE file, `<INIT_BASE>/<instance>/<pair name>.pairing`
(root 0600), under a one-time passphrase. The passphrase is shown ONCE on the terminal through
the prompter (`Prompter.showOnce`) — never through the report output, the journal (which
records the item's name, path and outcome only), argv or a log; without an interactive terminal
the item stays open (optional) and the loose-file instructions are printed instead. A later
run reports the package as written (the journal); `--decide pair.package=again` writes a new
one with a new passphrase. One machine (unix listener) pairs directly and writes no package.

On the work host, as the engine user: `dedalo:pair-publication-host add <name> --package
<file>` (the file 0600, owned by the engine user; the passphrase asked on the terminal with no
echo, or one line on `--passphrase-stdin`). The package is opened in memory and its three parts
take EXACTLY the loose-file path — fragment grammar, address policy, token resolution, the
bundle rule (none on a socket, required on mTLS, never a second one named by the fragment),
the fingerprint check, the registry slot, the live proof, the locked commit
(`src/core/publication_host/pair_flow.ts` `pairWith`, which the panel's upload calls too,
§9.14). `--package` excludes `--fragment`, `--bundle`,
`--token-file` and `--token-stdin`. The decrypted secrets reach disk only through the existing
staging and commit.

**Format v1** — ONE implementation, `publication/host_agent/src/provision/pairing_package.ts`
(node:crypto only; written by init, imported by the pairing CLI and — `openPairingPackageAsync`,
the KDF off the event loop, the same checks — by the panel's upload):

| offset | bytes | field |
| --- | --- | --- |
| 0 | 8 | magic `DDPHPAIR` |
| 8 | 1 | version `1` |
| 9 | 1 | KDF `1` = scrypt |
| 10 | 1 | log2 N = `17` |
| 11 | 1 | r = `8` |
| 12 | 1 | p = `1` |
| 13 | 16 | salt |
| 29 | 12 | AES-256-GCM nonce |
| 41 | … | ciphertext |
| end − 16 | 16 | GCM tag |

The key is scrypt(passphrase, salt, 32 bytes, N = 2^17, r = 8, p = 1). The 41-byte header is
the GCM additional data, so no header byte can change unnoticed. Before the KDF runs the reader
refuses another magic, another version, any KDF or parameter other than exactly those (a file
never chooses its own work factor), a file shorter than header + tag or larger than 1 MiB, and a
passphrase outside its shape. A wrong passphrase and an altered file are ONE refusal (`auth`):
GCM cannot tell them apart. The plaintext is JSON with exactly the keys `format`
(`dedalo-publication-host-pairing`), `version` (`1`), `fragment`, `token`, `bundle` (non-empty
strings under per-part caps); any other key set is refused (`parts`). The passphrase is 24
characters of Crockford's base 32 (120 bits from `randomBytes`), shown as six groups of four;
input drops spaces and dashes, is upper-cased and reads O as 0 and I/L as 1. Gates:
`publication/host_agent/tests/pairing_package.test.ts` (format), `tests/init_run.test.ts` (the
passphrase on the terminal only, the file 0600, the re-run), and
`test/unit/publication_host_pair_cli_native.test.ts` (`--package` end to end against a mock
agent: a wrong passphrase, an altered byte, a non-matching token, a socket fragment and a 0644
package refused before any connection).

**After the pairing.** The package is a sealed copy of the agent's token and the engine TLS key:
it is not kept once used. Init reads the agent's audit trail as root: an entry after the
journal's `done` of `pair.package` (any action but the automatic `release.auto_rollback`) is a
command the work host sent with those credentials (the agent audits only authenticated
requests; the pairing's live proof is read-only and unaudited, the first rules apply after it
is not), so every later run and `--dry-run` turns `pair.package` into the decision **stale →
remove** (`remove` by default, `keep` skips; `--yes` never answers it, `--decide
pair.package=remove` does, and asks for it before any proof too). The action
`pair_package_remove` removes only init's own file — a regular root 0600 file whose header is
the format's (`packageHeaderProblem`); anything else is refused by name and left — renamed to
init's temp name, then removed (journaled; `--resume` finishes the temp). A package gone is
reported right. Gates: `publication/host_agent/tests/init_pair.test.ts`
(`engineContactSince`, `writtenPackageItem`), `tests/init_run.test.ts` (stale, decided,
removed, refused for another mode or format).

### 9.13 The kit (two machines)

`bun run hostagent:pack -- --draft <draft.json> [--out <file>]` (`scripts/publication_host_pack.ts`,
on the WORK host) builds ONE deterministic archive — the release bundle's writer
(`src/core/publication_host/bundle_writer.ts`: gzip with a fixed header around ustar, mtime 0,
uid/gid 0, normalized modes, tree order), so the same checkout and draft give the same bytes and
the same sha256, which it prints. Layout:

| path | content |
| --- | --- |
| `MANIFEST` | `# dedalo publication-host kit 1`, then `<sha256>  <path>` for every other file, byte order of the path |
| `draft.json` | the draft, byte for byte, after the agent's OWN `parseDraft` accepted it (a child Bun in the scratch copy: the kit's code and its own zod judge it) |
| `install.sh` | `publication/host_agent/deploy/install.sh` |
| `source/…` | the `SOURCE_MANIFEST` layout: `.bun-version`, `.bun-sha256`, `publication/host_agent/**` (the checkout's files git tracks or would add — never what `.gitignore` names — minus `tests/`, `.env.test`, `deploy/examples/`), the v2 `.env.example`, and the v1 sample ONLY when the draft serves v1 (`SOURCE_MANIFEST` marks it `optional`; a v1 instance whose source lacks it is the blocking `api_config.v1_config`) |

`node_modules` comes from a scratch copy of those files and `bun install --frozen-lockfile
--production --linker hoisted --ignore-scripts` there (the release bundles' argv) — never the
developer's tree; the only network access, and on the work host. Refused (exit 3): a draft
`parseDraft` refuses; a node_modules symlink, special file or development dependency; a path
outside the kit grammar (`KIT_PATH_PATTERN`, no `.`/`..` segment); a credential-shaped name
(`.env*` but `.env.example`, `*.pem`, `*.key`, `id_*`, `SERVICE_TOKEN`, `credentials`) or a PEM
private-key block — a kit carries no secret (D6).

`install.sh <instance> --kit <file> [--kit-sha256 <sha256>]` (exclusive with `--source`, `--draft`
and `--source-digest`) copies the kit into the root 0700 stage and hashes THAT copy before any
tar reads it: it must equal `--kit-sha256`, or the operator confirms it on a terminal (no
terminal and no `--kit-sha256`: refused). The kit sha256 is the trust anchor — it replaces the
source-digest consent — so the system tar (needed only here; release bundles never use one) reads
an archive the work host built. Defence in depth before extraction: `kit_names_ok` (every
`tar -tzf` name in the grammar, at most `KIT_MAX_ENTRIES`) and `kit_types_ok` (every
`tar -tvzf` member a file or a directory); extraction with `--no-same-owner
--no-same-permissions`; then `verify_kit`: regular files and directories only, the file set
EXACTLY the MANIFEST's (an extra, a missing file, a repeated line refused), every sha256 equal,
the draft, `install.sh` and `source/` present. Only then is `source/` the staged source and
`draft.json` the staged draft, and the run continues as a source run. The KIT_* constants live
in `init/constants.ts`; the sh twins are held equal by `publication/host_agent/tests/
init_install_kit.test.ts`, which also drives the three functions on altered trees; the packer
READS them from install.sh. Gates: that file; `test/unit/publication_host_kit_pack.test.ts`
(determinism, the closed content, the refusals, and the real checkout's kit extracted by the
system tar and accepted by install.sh's own functions, one altered byte refused); the init
drill's `kit-install` leg (the real packer, a real production install, an altered kit refused
by its sha256, the install from the kit, no tests or dev dependencies installed, the kit
offered for removal and removed, the files beside it untouched).

**The kit after the install.** `install.sh` hands init the kit it was given, absolute, with the
sha256 it verified (`--kit-file`, `--kit-digest-confirmed`: hand-over flags, refused after `--`).
Once the run converged (exit 0, nothing required open) init offers to remove it: confirmed on a
terminal (default no), removed under `--yes` without one, otherwise named. `InitIo.removeOperatorFile`
removes only a regular file (never a link) that still hashes to that sha256, unlinked by name
after the descriptor read proved it the same inode; no parent-trust rule (the kit may sit in
`/tmp`): an unlink removes a name, never a link's target or another name's data. Journaled
(`kit.remove`); a refusal never fails the converged run. Gates: `tests/init_run.test.ts`,
`tests/init_host_io.test.ts` (the real door), `tests/init_args.test.ts`,
`tests/init_install_sh.test.ts` (the hand-over).

### 9.14 The panel: "New publication host" (steps 4–5)

Root's Maintenance → Publication hosts carries a **New publication host** section
(`src/core/area_maintenance/widgets/publication_host_setup.ts`, the actions of the
`publication_hosts` widget; client `client/dedalo/core/area_maintenance/widgets/publication_hosts/js/render_new_host.js`;
wire entry `engineering/wire_contract/WC-2026-10-09-publication-host-panel-setup.md`). Every
action is ROOT-ONLY and refuses anyone else before any module loads. The CLI paths (`bun run
hostagent:pack`, `dedalo:pair-publication-host`) stay (D5).

**The draft** (`src/core/publication_host/drafts.ts`). The form makes a `provision init` draft
restricted to what the panel asks: `instance`, `layout` (`home` = `/home/<domain>`, the default;
`system` = `/opt` + `/srv`), `apis` (`v2_only`, the default, or `v1_and_v2` with `v1.user`),
`listen` (one machine = `unix` + `engine_group`; two machines = `tls` at a private IPv4 and a
port), `agent_user`, `web.server`, `site.domain`, `media` (mode + root) and `v2` (unit, user,
port). Everything discovery fills (the web unit, the PHP-FPM install, the OS family, the vhost,
nginx's map mode) is left to init. `propose_draft` starts the form from the domain: the
instance by the convention (`.` and `-` → `_`), init's own account and unit proposals
(`init/draft.ts` `DEFAULTS`), the next free v2 port among the drafts on that machine (from
3100), the next free TLS port on that address (from 8471) among the drafts and paired hosts
there, the work system's own group (one machine) and its media root (one machine, shared).

**One rule set (D1).** `save_draft` reads the draft field by field (every shape issue at once),
then judges it with the agent's OWN zero-dependency modules, in-process: `layout.ts` `derive()`
on a stand-in declaration (the draft, init's proposals, and neutral values for what only
discovery knows — a v1-floor PHP-FPM, a Debian-family web unit; never written into the draft)
and `siblings.ts` `siblingRefusals()` against the drafts on the same machine (both sockets =
the work system's; both TLS at one IPv4). The registry's hosts on that machine are judged on
what the registry knows of them: their instance and their listener. A refusal is
`publication_host_setup.draft_invalid` with `details.fields` (the form's fields, declaration
paths) and one sentence per field (derive's `LayoutError.reason`). The registry name (`name`)
must be free in the registry and among the drafts. Honest limit: a value discovery fills is
judged by init on the publication host, not here; init may also change a proposed field (the
draft is a proposal). The agent modules the engine imports are admitted by
`tool_lossless_writeback_tripwire`'s `host-agent-package` class only while their import
closure stays inside the agent package (zod-free by closure).

**The store.** `<private>/publication_host_drafts.json` (0600, the atomic JSON kernel the
registry uses: bounded reads, temp → fsync → rename, flock) — NOT the registry: a draft dials
nothing and holds no credential. A corrupt or widened file is `drafts_state:
'drafts_invalid'` on the panel and `publication_host_setup.drafts_invalid` on every action,
never "no drafts". A draft's state is DERIVED: `paired` while the registry holds a host with
its instance (on TLS, at its address), `awaiting` otherwise. `remove_draft` drops a draft and
its cached kit; a paired host stays paired.

**The kit** (`src/core/publication_host/kit_build.ts`; the format is
`src/core/publication_host/kit.ts`, shared with the CLI packer). `build_kit` builds the §9.13
kit for a saved draft from the INSTALLED release: its source is the publication manifest's
kit census (`src/core/update/publication_manifest.ts` writes `publication/host_agent/**`,
`.bun-version` and `.bun-sha256` beside the API files at extract time), re-proved before the
build (`verifyKitSourceTree`) and re-hashed file by file as it is read. A dev checkout (no
verified release), a manifest an older updater wrote (no kit census) or a drifted file is
`publication_host_setup.kit_refused` with its `reason`, naming `bun run hostagent:pack`. The
agent's production dependencies are installed exactly as the API bundles' v2 dependencies are
(`installV2DepsReal`: the pinned Bun, frozen, production, hoisted, no scripts, the minimal
environment, the shared install cache under the code-backup build root) — the same egress,
no new door (`engineering/OUTBOUND_SPEC.md` §5). The draft is then judged by the agent's own
zod `parseDraft` in a child Bun inside the kit's copy, as the CLI packer does. Cache:
`<backup>/.pubapi_build/<release>/kits/<name>.tar.gz` + sidecar (written last; a hit needs
the release, the digest and the draft bytes AND a re-hash); builds of one name share one
promise. The answer is bounded like `push_apis`: a first build still running answers
`running`. `download_kit` returns the cached kit's bytes (base64, re-hashed at read, at most
64 MiB) with its sha256, which the panel shows for the operator to compare on the publication
host (`--kit-sha256`).

**The sealed-package pairing (two machines).** `pair_package {name, package_base64,
passphrase}`: the draft must exist, be awaiting, and listen on TLS (a one-machine draft pairs
itself during init); the package (at most 1 MiB) is opened IN MEMORY
(`openPairingPackageAsync`), its bytes zeroed afterwards; then `pairWith` as `add <name>` with
the panel's binding check — the fragment's instance must be the draft's (`draft_mismatch`) and
the agent address INSIDE the package must equal the draft's listener (`address_mismatch`),
both before the token is read and before anything is dialled — then the token ⇒ fingerprint
check, the registry slot, the live `/health` proof over mTLS (no bearer;
`publication_host.pairing_mismatch` when the agent publishes another fingerprint), and the
commit under the registry lock. Refusals are `publication_host_setup.pairing_refused` with a
closed `details.reason`. Audited: one activity row (WHAT `NEW` on the maintenance area: the
host, the instance, the address — never a secret). The passphrase and the package are never
logged, echoed or stored; JS strings cannot be zeroed, so the passphrase and the decrypted
token and bundle strings are dropped with the request (honest limit). Gates:
`test/unit/publication_host_setup_native.test.ts` (drafts, multi-instance, the store, the kit
build and its refusals, the upload's refusals and the secret scan),
`test/unit/publication_host_widget_native.test.ts` (the action set, root only),
`client/dedalo/test/client/js/test_publication_host_setup.js` (the view).

### 9.15 Retired artifacts (a declaration that drops something)

A plan cannot learn from a NEW declaration where the OLD one put things (a v2-only declaration
has no `site.fpm`, so it cannot name the old pool file). `provision apply` keeps a record of what
it provisioned that may later be retired, `<config_base>/<instance>/provisioned.json` (root:root
0644, `MODES.provisionRecord`), written by the tail's LAST action (`provision-record`) whenever it
moves — a run that fails earlier keeps the previous record, so the next one retires again; an
absent record equals an empty one (an instance with nothing retirable never gets the file).
`publication/host_agent/src/provision/retire.ts` owns the closed tables: the retirable kinds
(`fpm_pool` with its FPM install's unit and binary, `logrotate`, `logrotate_v1`) and trees
(`v1_api` = `<state_root>/publication_api/v1`, `v1_var` = `<v1_var_base>/<instance>`). Retired =
recorded − rendered: files by PATH (a pool that moves to another PHP version's directory is
retired, or two pools of one name would meet), trees by KIND (a relocated tree is the operator's
move, not a retirement). A kind joins the table with its removal rule, never by default: a web
include is `Include`d by the operator's vhost, so removing it would break the server.

**The guard.** A retired file is removed only when it still carries our stamp for THIS instance
and THAT kind with an unedited body; a retired tree only at the place this instance's layout puts
its kind, as a real directory with exactly the `MODES` owner, group and mode `apply` gave it,
under a trusted parent. Anything else refuses the whole plan, naming the path (init shows it as
the "edited by hand" decision). A record that is not this grammar refuses too, never guessed.

**The removal.** A file: renamed to the provisioner temp name and removed (`remove`, shown by
`check` as `would: remove … (retired: …)`). An FPM pool: under the host web lock, renamed to
`<pool>.dedalo-provision.bak`, then the FPM configtest — a master whose only pool was ours
refuses to start, so a failing test puts the pool back, tests again, and stops apply — then
`fpm-configtest` + `fpm-reload` of ITS install while it runs (a `retire` restore entry: put back
when the master dies at the reload, dropped after a good one; an install not running has nothing
to reload and the backup goes at once). Each retired install gets its own pair; a reload ranks
with its configtest in the tail sort, so pairs stay pairs. A tree: in the tail AFTER the units
restarted (the agent no longer serves v1), renamed to `<path>.dedalo-provision.retired` in its
trusted parent, made root:root 0700 through the entry doors (no other account reaches anything in
it by path any more), then `rm -rf --one-file-system` — the 25th provisioner command (§9.3),
admitted only for a root 0700 directory of that name; GNU rm walks descriptor-relative and never
follows a link. A leftover `.retired` (or a pool backup awaiting its reload) is finished by the
next run. SELinux rows need nothing new: the v1 specs leave `selinux.state`'s desired set and are
deleted by the registration lifecycle (§9.8) in the same import. Accounts are never removed.
Gates: `publication/host_agent/tests/provision_retire.test.ts` (FakeHost: the plan, the
convergence and the empty second plan, the FPM failure and restore, the resume, a moved pool, the
guards one by one, SELinux), `tests/provision_host_io.test.ts` (a real tree: the v1 tree removed,
a planted link not followed), `tests/provision_exec.test.ts` (the door's argv and refusals).
