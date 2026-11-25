# Dédalo publication host agent

A small Bun daemon that runs on an institution's **publication host**: the machine (or,
on a single server, the separate public hostname) that serves the website, the
Publication APIs v1 and v2, and the published media. The work system's engine is its only
client. It executes a closed set of commands (status, media probe, web-server rule
apply, API release install and rollback) and nothing else.

The definition is `engineering/PUBLICATION_HOST_SPEC.md`: §2 is the trust law, §3 the
release layout and bundle grammar, and §6 the command → route table. This README does not
restate them; it says how the package is built, provisioned and paired. The operator's
manual page is `docs/install/publication_host.md`.

It follows `publication/site_builder`'s shape: a strict three-layer config, the bearer
checked before routing, an RFC 9457 problem envelope, an append-only audit, and a
provisioner that renders every host artifact from one declaration. **Nothing is imported
from either.** The agent is a separate deployable. Where code was reused it was copied,
and the copy's header names its source file.

## Trust model, in one paragraph

Direction is work → publication only: the agent holds no work-host address or credential.
A compromised work host IS a compromised publication host (`release.install` runs pushed
code). The agent validates the SHAPE of what it is sent (sha256 stamp, bundle grammar,
path confinement), never the intent of its paired engine, and it records every
`current` swap `from → to`. See spec §2.6.

## Transport

| Topology | Listener | Who can connect |
|---|---|---|
| two machines | TLS on `TLS_HOST:TLS_PORT`, `requestCert` + `rejectUnauthorized` (constants) | only a client certificate issued by this host's private CA (the engine's) |
| one machine (spec §1.1) | unix socket `SOCKET_PATH`, mode 0660, group = the engine's | only the engine's group |

There is no third kind: `LISTEN_KIND` is `unix` or `tls`, and **plain TCP does not
exist**, not even for tests. The hermetic suite listens on a unix socket (`.env.test`),
and the mTLS gates (`tests/boot_mtls.test.ts`) bind TLS on `127.0.0.1` with a CA they
generate in the scratch tree.

A TLS listener whose certificate, key or `TLS_CLIENT_CA_FILE` is missing, unreadable or
not PEM refuses to boot. Firewall the TLS port to the work host's address. WireGuard
underneath is recommended, never a substitute.

On every listener, `Authorization: Bearer <SERVICE_TOKEN>` is required on every route
except `GET /health`, and it is checked before routing. `/health` publishes
`instance_fingerprint` (`src/security/pairing.ts`), never the instance name.

## Privileges

The daemon never runs as root. It has two grants, both rendered and hash-stamped by the
provisioner:

| Grant | Allows | Why it cannot be narrower |
|---|---|---|
| sudoers | `<configtest> -t`, exactly that argv: `apache2ctl` (Debian/Ubuntu) or `apachectl` (RHEL), or `nginx`; the provisioner picks the real file present from a closed list | a configtest must read root-only TLS keys |
| polkit | `reload` of `WEB_UNIT`, `restart` of `V2_UNIT`, `start`/`stop` of the `<V2_UNIT>-scratch@<port>` template; on nginx with a provisioned map (`NGINX_MAP_MODE=conf_d`), `start` of `dedalo-pubhost-map.service`; on a fapolicyd host (`TRUST_UNIT`), `start` of `dedalo-pubhost-trust-<instance>.service`, root's trust oneshot (no argument: it derives the trust set from the declaration, `src/provision/fapolicyd_trust.ts`) | the same unit-scoped rule the site builder uses |

Every child process goes through `src/exec.ts`, a closed set of named commands
(`webConfigtest`, `webReload`, `v2Restart`, `phpLint`, `v2ScratchBoot`, `startHostMap`; the
provisioner, which root runs, has its own closed sets, `provisionExec()` and `initExec()`). A package test
fails if any other `src/` module spawns. `process.env` is read only in `src/config.ts`,
and that is gated too.

Neither grant opens a path to root:

- `rules.apply` checks the media include against a closed directive allowlist
  (`src/rules/directives.ts`) before root parses it at configtest. It refuses module loads,
  includes, log or piped directives, and any path outside `MEDIA_ROOT`.
- `rules.map` (nginx, spec §9.7) never writes the file root's nginx loads. The agent
  validates the pushed http{} map against the closed map grammar (`parseNginxMap`, same
  module), writes only its own one-envelope contribution into the host's sticky
  `contrib/` store, and starts the root oneshot `dedalo-pubhost-map.service`
  (`src/rules/host_map_main.ts`, a root-owned copy of the zero-dependency renderer installed by
  `provision apply`), which re-validates every contribution against the declared agent uids,
  merges them and is the only writer of the live map.
- `v2ScratchBoot` never runs pushed release code as the agent user, which owns `rules/`
  and holds the sudo grant, the TLS key and the bearer. It repoints `v2/scratch` at the
  committed `releases/<id>` and starts `<V2_UNIT>-scratch@<port>`, so the release under
  test runs as the v2 user in v2's sandbox (spec §2.5).

## On the host

```
<STATE_ROOT>/
  publication_api/v1/{releases/<id>/, shared/, current -> releases/<id>, staging/}
  publication_api/v2/{releases/<id>/, shared/v2.env, current -> releases/<id>, staging/}
  rules/dedalo_media_publication.<apache|nginx>.conf    the include rules.apply writes
  audit/audit.jsonl                                     append-only NDJSON (chattr +a in production)

/var/lib/dedalo_publication_host/_host/                 host-wide, shared by every instance
  locks/{provision.lock,web.lock}                       flock(2): apply's host items; every configtest+reload
  nginx_map/{dedalo_media_map.nginx.conf,result.json,bindings.json,contrib/<instance>.json}
  map_renderer/                                         the root map renderer's code copy + its Bun
```

The state root carries a `.dedalo_host_agent_instance` marker naming the instance, and
the daemon refuses to boot against an unmarked root. A release id is `<version>_<digest7>`.
The v1 config files live in `v1/shared/` (`root:root 0711`) and are linked into each release
after extraction (spec §3). `server_config_api.php` must be owned by the declared `v1.user` (the
user of v1's OWN PHP-FPM pool, never the website's pool or the web server's user) and private to it, or the install is refused (`shared_config_exposed`). The agent never runs `bun install`: a v2 bundle carries its
production `node_modules`.

## Configuration

There is one resolution path, the same on a laptop and on a host. `src/config.ts` parses a
named env file (`.env.test` under `NODE_ENV=test`), merges a small ambient allowlist, and
layers `$CREDENTIALS_DIRECTORY` on top; the credential always wins. Every key and its
grammar are the zod schema in `src/config.ts`. `.env.test` is a complete, committed
example. An unknown key is a named refusal. `SERVICE_TOKEN` is a credential: on a host it
arrives through systemd `LoadCredential=`, never in a rendered file.

## Development

```bash
bun install
bun test              # hermetic: unix socket + loopback mTLS only, no sudo/systemctl
                      # (exec seam injected), scratch roots under .test-tmp/ (marker-guarded)
bunx tsc --noEmit
```

From the repo root: `bun run hostagent:install:dev` (`bun install --frozen-lockfile`,
with the dev dependencies `hostagent:test` needs), then `bun run hostagent:test` and
`bun run hostagent:start`. `bun run hostagent:install` is the deployment install
(`--frozen-lockfile --production`: the committed `bun.lock` exactly, runtime dependencies
only); a tree prepared with it cannot run `hostagent:test`, by design. The live end-to-end drill is `bun run test:pubhost:agent`. It
runs real mTLS, a user-mode Apache and nginx, and real v2 releases over the suite MariaDB,
on the CI instance tier.

## Provisioning

One declaration states the deployment, and the provisioner derives every artifact from it:
the agent's systemd unit, the v2 unit, the environment file, the sudoers rule, the polkit
rule, the mTLS material (private CA, server certificate) and the engine bundle; with the
optional `site` block also v1's own PHP-FPM pool (`render/fpm_pool.ts`) and the site's web
include (`render/web_include.ts`); on nginx with `web.nginx_map: conf_d` the host-wide map
include and the root map renderer's unit; on an SELinux host the file contexts and the v2
port label (`src/provision/selinux.ts`).

**The guided install** (spec §9) is `provision init`, started only through
`deploy/install.sh` (it stages the source root-only, verifies Bun against `.bun-sha256`, then
starts Bun with an empty environment). It discovers the host, compares it with the draft,
prints *already right* / *will change* / *needs your decision* (and, on a terminal, *needs your
action*: how each decision is asked is `src/provision/init/decision_class.ts`, spec §9.16), and
acts after confirmation:
it creates the missing accounts, makes the site home root's, edits the operator's vhost (with
backup, configtest and rollback), sets SELinux booleans only on a typed answer, writes the API
configuration files, runs `provision apply` in-process, proves the agent (B4,
`src/provision/init/verify.ts`) and pairs it on one machine (B5, `src/provision/init/pair.ts`).
It runs on the `OS_SUPPORT` rows (`src/provision/init/parse/os.ts`): Debian 12/13, Ubuntu
24.04/26.04, RHEL/Rocky/Alma 9 and 10; EL 8 and a kernel below Bun's floor are refused by
`deploy/install.sh` before Bun is fetched; anything else (Ubuntu 22.04, CentOS Stream, Oracle
Linux) is a blocking `host.os` that names the manual install. Two-machine pairing is printed,
not run. The operator page's *Guided install* is its manual.

The declaration is `/etc/dedalo_publication_host/<instance>.json`. `--declaration <file>`
names another path. `check` and `apply` judge it before reading it
(`declarationTrustProblems`, `src/provision/cli.ts`): a regular file (lstat, never
followed), uid 0, mode `& 022 == 0`, and every ancestor up to and including `/` a real
directory with the same owner and mode, or the plan is refused (exit 3). Root grants from
it, so whoever could edit or replace it would choose whom the next `apply` grants
root-reachable permissions. The sibling declarations the isolation check reads, the config
base and its ancestors are judged the same way, even when `--declaration` points
elsewhere. `render` is exempt (no root, writes nothing). Its shape is `HostDeclaration` (`src/provision/layout.ts`), validated
strictly by `src/provision/schema.ts`. The complete, gated examples are
`deploy/examples/instance.example.json` (two machines, TLS, nginx),
`deploy/examples/instance.single_machine.example.json` (one machine, unix socket, Apache) and
the four `site` variants `instance.single_machine_site` (Debian Apache, home layout),
`instance.site_nginx` (`nginx_map: conf_d`, copy media), `instance.site_el9_selinux` (httpd,
Remi) and `instance.site_el10` (httpd, AppStream).
`provision apply` never creates accounts (`provision init` does, after confirmation): if the
agent user, the v1 or v2 user, a declared group or the host group `dedalo_pubhost` is
missing, `check` refuses and prints the `useradd` / `groupadd` line to run.

`plan` also refuses what would make a unit fail with `EACCES` later
(`accessRefusals`, `src/provision/access.ts`): each runner is judged with the credentials
systemd gives its unit (the agent: `Group=` engine_group on unix, its primary group on tls,
plus `SupplementaryGroups=`; v2: `v2.group` — `agentUnitGroups`/`v2UnitGroups`, the value the
unit renderers emit those lines from; v1: its `id -G` groups), on the one mode class
the kernel consults. The agent needs x above `agent_dir` and r (dirs r+x) over its whole
tree (lstat walk, symlinks never followed, capped at `AGENT_TREE_WALK_CAP` entries, `plan.ts`: over the cap or an
unlistable dir refuses); agent and v2 need r+x on `bun_bin`, the agent on `php_bin`; all
three need x above the state root. Each line prints the narrowest `chmod`. Mode bits only:
an ACL grant is still refused. On unix, `engineGroupRefusal` refuses an `engine_group` that
is the primary group of `agent_user`, `v1.user` or `v2.user`, or is `v2.group`; that the
work system's account is IN the group stays unprovable here (the operator page's step-7
socket request proves it).

```bash
bun run provision render <instance>    # print every artifact; writes nothing, no root needed
bun run provision check  <instance>    # as root: plan only; exit 0 (1 on drift with --exit-code), 3 when refused
bun run provision apply  <instance>    # as root: converge; writes only what drifted
```

The arguments are positional. The same command runs from the repo root as
`bun run hostagent:provision <verb> <instance>`. Exit codes: 0 ok (`check` also when it lists changes), 1 drift (`check --exit-code`),
2 usage, 3 refused, 4 failed, 5 busy (`check` only: init or apply holds the instance lock;
nothing was checked). `apply` takes the instance lock exclusive and `check` shared, before
reading the declaration (`src/provision/lock.ts`). On a host, root has no `bun`: run them with the declared `bun_bin`
from `agent_dir` (the operator page, step 4).

The order is: schema → layout → pure stamped renderers → plan → dumb apply. Each rendered
file carries a hash of its body, so a hand edit shows up as a refusal on the next `check`
and is never overwritten. `deploy/examples/rendered/<variant>/` (`tls-nginx`, `unix-apache`,
`site-apache-home`, `site-nginx-home`, `site-el9-selinux`, `site-el10`) is the full output for
each example in a tree that mirrors the host, and
`deploy/examples/rendered.index` lists each file's mode and owner. Both are generated and
gated (`tests/provision_examples.test.ts`). Re-render them with
`UPDATE_EXAMPLES=1 bun test tests/provision_examples.test.ts`, never by hand.

Besides the host artifacts, `apply` writes `/etc/dedalo_publication_host/<instance>/engine.env.fragment`
(secret-free): the keys the work host's pairing command reads (see *Pairing*), with the
expected pairing fingerprint rendered in. It is never appended to the engine's `.env`.

**Install the code without registry egress:** run `bun run hostagent:install` on the
work host (frozen, production-only), then copy `publication/host_agent/` (with its
`node_modules/`) to the publication host. Never copy from a tree where
`hostagent:install:dev` or `hostagent:test` ran: it carries the dev dependencies and
`.test-tmp/`.

**Bun, one per site:** `bun_bin` is the site's own Bun at the work system's
`.bun-version`, installed as root into `/home/<site>/.bun/` (root-owned, since it runs the
agent and its grants) from the release archive checked against the committed
`.bun-sha256` (generated from Bun's signed `SHASUMS256.txt.asc`, spec §9.10) — never a download
piped into a root shell. The panel's `bun_version` check reds on any
difference from the pin (drift, not integrity). The operator page has the commands.

## Pairing

1. `provision apply` on the publication host issues the mTLS material. It writes the
   engine's half as ONE file, `/etc/dedalo_publication_host/<instance>/engine_bundle/engine_bundle.pem`
   (root-owned, `0600`, in a `0700` directory). The file holds three PEM blocks, in this
   order: the client certificate, the client private key, the CA certificate. The client
   key exists nowhere else. When `apply` reissues the client certificate it prints
   `THE ENGINE BUNDLE CHANGED`, and the bundle must be carried again.
2. The operator carries the bundle to the work host. This is the one manual step, and it
   is deliberate: it crosses the isolation boundary.
3. Verify from the work host. First split the bundle for `curl`:

   ```bash
   umask 077
   sed -n '1,/-----END PRIVATE KEY-----/p' engine_bundle.pem > client.pem   # certificate + key
   sed '1,/-----END PRIVATE KEY-----/d'    engine_bundle.pem > ca.pem       # the CA
   curl --cacert ca.pem --cert client.pem \
     https://<TLS_HOST>:<TLS_PORT>/publication/host_agent/health
   ```

   Then compare `instance_fingerprint` with this value, computed on the publication host
   (as root):
   `printf 'dedalo-publication-host:%s\n%s' <instance> "$(cat <credential file>)" | sha256sum`.
   `<credential file>` is the path in the agent unit's `LoadCredential=` line
   (`provision render` shows it). The two must be equal; the same value is rendered as
   `DEDALO_PUBLICATION_HOST_FINGERPRINT` in `engine.env.fragment`. A wrong instance and a
   wrong token give the same mismatch.

On the work host, `scripts/publication_host_pair.ts`, run as the user that runs Dédalo
(`cd /opt/dedalo/master_dedalo && sudo -u dedalo /opt/dedalo/.bun/bin/bun run
dedalo:pair-publication-host …` in the production layout: from the checkout, with the pinned
Bun named in full, because `sudo` resets `PATH`), adds the host from the
fragment and this bundle after proving the pairing live. The token comes from the pasted
fragment line, `--token-file` or `--token-stdin`. The engine's channel, client and panel
are `src/core/publication_host/` and the `publication_hosts` maintenance widget (spec
§2.1). The engine-side recipe `src/core/publication_host/pairing.ts` is held equal to
`src/security/pairing.ts` by `test/unit/publication_host_pairing_tripwire.test.ts`.
