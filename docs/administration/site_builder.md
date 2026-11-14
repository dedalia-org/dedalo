# Site builder

The **site builder** lets your users build their own public websites over the published
data — maps, charts, interactive analysis, anything — by talking to a coding agent, and
publish them to production when they are happy. It is an optional add-on: until you
configure it, it does not appear anywhere in Dédalo.

> For the day-to-day workflow and a library of example prompts, see the
> [site builder cookbook](site_builder_cookbook.md). This page is the operator's manual:
> installing, adding a museum, adopting an existing install, decommissioning one, and
> backups.

## How it fits together

There are two pieces:

- **The site builder daemon** — a standalone service (`publication/site_builder`) that
  runs next to the publication API and its database, possibly on a different host. It owns
  the site workspaces, runs the coding agent, builds each site to static files, serves the
  pre-production preview, and promotes an approved build to production. It reads data only
  from the read-only publication API, so a generated site can never reach your work-system
  data.
- **The site builder tool inside Dédalo** — a workspace where a logged-in user picks or
  creates a site, chats with the agent, watches a live preview, and (if permitted)
  publishes. It talks to the daemon on the user's behalf over an authenticated channel; the
  browser never contacts the daemon directly.

A user builds a site, previews it on a pre-production address, and — once it looks right — a
developer or administrator publishes it to the public address. Publishing copies the exact
bytes that were previewed, so what goes live is always what was approved.

## One museum is one instance

The pairing is **1:1 and fixed**. One museum means one Dédalo engine (its own database, its
own `../private/.env`) paired with exactly one site-builder **instance**: one Linux user,
one group, one systemd unit, one daemon process, one socket, one state tree, one audit log,
and the webspaces that museum's sites are served from.

```
museum-a:  engine A  ──bearer over a private socket──►  instance A  ──►  webspaces A
museum-b:  engine B  ──bearer over a private socket──►  instance B  ──►  webspaces B
```

Four museums on one host is four engines, four instances, four unix users. **The isolation
between them is a uid**, not a path: an agent turn runs arbitrary generated code as the
service user, and what stops that code reading another museum's drafts is that nothing of
another museum's is readable by that uid.

There is no tenant list anywhere. The engine holds one address; the daemon serves one
instance. Before the first byte of any call the engine proves the pairing against the
daemon's `/health` fingerprint and refuses on any difference, so a `../private/.env` copied
from one museum's server to another's cannot silently point one engine at the other's
daemon.

## Everything on the host is generated from one declaration

You do not install an instance by copying files. You **declare** it, once, in

```
/etc/dedalo_sites/instances/<instance>/instance.json
```

and the provisioner generates everything else from that file: the Linux user and group, the
state roots and their modes, the systemd unit, one virtual host per site per surface, the
daemon's environment file, the per-instance preview password file, the site table the
daemon reads, and the pairing fragment the engine needs. Every generated file carries a
body-hash stamp naming its instance, so a hand edit is reported as drift on the next run.

Two consequences worth stating plainly, because both used to be manual steps:

- **You never write a virtual host.** A site's public address is `sites[].domain`; an extra
  hostname for the same site is an entry in `serving.aliases`. Both are declared fields.
- **You never write the daemon's environment file.** It is rendered, and an edit to it is
  lost on the next run.

### The commands

All of them run from the daemon's package directory, as root:

```bash
cd /opt/dedalo/master_dedalo/publication/site_builder
sudo bun run provision <verb> --instance <instance> [options]
```

| Verb | What it does |
|---|---|
| `check` | Plans and prints everything that would change. **Writes nothing.** |
| `apply` | Converges the host onto the declaration — writes only what has drifted. |
| `render` | Prints the artifacts the declaration renders to. Writes nothing. |
| `list` | Lists the declared instances, their identities and their sites. |
| `adopt` | Brings a hand-built install under the provisioner. |
| `remove` | Decommissions an instance. Refuses while a site is published. |

`--all` acts on every declared instance instead of `--instance`; `--config-dir` moves the
directory the declarations are read from (default `/etc/dedalo_sites/instances`).
`bun run provision --help` prints the full option list.

Exit codes, so a monitoring job can branch on them:

| Code | Meaning |
|---|---|
| `0` | The run did what it was asked, or there was nothing to do. |
| `1` | `check` only: the host has drifted from its declaration. Nothing was written. |
| `2` | The command line was not understood. |
| `3` | An instance was refused — malformed, unknown, overlapping, still publishing, or waiting on a credential file only you can place. |
| `4` | The work was attempted and failed. |

## Adding a museum

The worked example below adds a fourth museum, `museum-d`, to a host that already runs
three. Nothing about it is special to being the fourth: the same six steps add the first.

!!! warning "What the host must have first"
    Each site's agent runs as its own Linux user, in a systemd unit that PID 1 starts for it.
    The host therefore needs:

    - **systemd 248 or newer.** Ubuntu 24.04 ships 255. Debian 12 and RHEL 9 ship 252.
      On 257 or newer each run also gets its own process namespace. Below 254, a crash of
      the daemon does not stop the runs bound to it, so the restarted daemon stops them
      before it accepts work.
    - **polkit 0.106 or newer.** The grant that lets the daemon stop its own runs is a
      JavaScript rules file. polkit 0.105 (Ubuntu 22.04) ignores it, so `provision apply`
      refuses that host. Server and minimal installs often have no polkit at all, and then
      `provision apply` refuses because it cannot read polkit's version. Install it first:
      `apt install polkitd` on Debian and Ubuntu, `dnf install polkit` on RHEL.
    - **A Claude Code binary the daemon can execute**, at an absolute path outside `/home`,
      `/root`, `/tmp` and `/run`. The daemon's own unit hides those directories, so the
      native installer's `~/.local/bin/claude` is unreachable. Install it under `/usr/local`
      or `/opt`. Its `--help` must list `--setting-sources`, `--settings` and
      `--strict-mcp-config`. If it does not, every turn is refused with
      `confinement.agent_cli_unsupported` until Claude Code is upgraded.

### 1. Write the declaration

`/etc/dedalo_sites/instances/museum-d/instance.json`, owned `root:root`, mode `0644`:

```json
{
  "instance": "museum-d",
  "description": "Museum D — public websites over the published collection.",

  "engine": {
    "private_dir": "/srv/dedalo/museum-d/private",
    "group": "dedalo-museum-d",
    "checkout_dir": "/srv/dedalo/museum-d/master_dedalo",
    "bun_bin": "/srv/dedalo/museum-d/.bun/bin/bun"
  },
  "web": { "server": "nginx", "group": "www-data" },

  "publication_api": {
    "url": "http://127.0.0.1:3104/publication/server_api/v2",
    "key_path": "/etc/dedalo_sites/instances/museum-d/secrets/PUBLICATION_API_KEY"
  },

  "sites": [
    { "slug": "coleccion", "domain": "www.museum-d.example" }
  ],

  "serving": {
    "preprod": {
      "enabled": true,
      "auth": {
        "mode": "htpasswd",
        "realm": "Museum D preview",
        "users": [
          { "name": "preview",
            "password_file": "/etc/dedalo_sites/instances/museum-d/secrets/PREPROD_PASSWORD" }
        ]
      }
    },
    "prod": { "tls": { "mode": "letsencrypt", "account_email": "ops@museum-d.example" } },
    "aliases": { "museum-d.example": "coleccion" }
  },

  "agent": {
    "driver": "claude_code",
    "bins": { "claude_code": "/usr/local/bin/claude" }
  },

  "secrets": {
    "ANTHROPIC_API_KEY": "/etc/dedalo_sites/instances/museum-d/secrets/ANTHROPIC_API_KEY"
  },

  "limits": { "max_sites": 8, "releases_retained": 10 },
  "resources": { "memory_max": "4G", "cpu_quota": "150%" }
}
```

What is worth knowing about the fields:

- **`instance`** becomes the Linux user and group `dedalo-site-<instance>`, so it is
  lowercase, starts with a letter, and is short enough that the prefix plus the name fits a
  Linux user name. The provisioner refuses a name that does not.
- **`engine.private_dir` and `engine.group`** are the paired engine's private directory and
  OS group. They are required and never guessed: the group is what owns the daemon's socket
  at mode `0660`, and a wrong one is an engine that cannot open it — discovered at the first
  request instead of here.
- **`engine.checkout_dir` and `engine.bun_bin`** are where this museum's daemon actually
  lives: the engine checkout it runs out of, and the pinned `bun` that executes it. They
  become the unit's `WorkingDirectory=` (`<checkout>/publication/site_builder`) and its
  `ExecStart=`. Both are required and neither is inferred — a unit pointed at a directory
  nobody created starts nothing, and the failure surfaces at `systemctl start` rather than
  here. Give the *pinned* binary's absolute path, never a bare `bun`: the shell's search
  path is shared between instances and a stray `bun upgrade` must not be able to change a
  museum's production runtime.
- **`web.group`** is the web server's runtime group (`www-data` on Debian, `nginx` or
  `apache` elsewhere). It is required for the same reason: it is what makes the preview
  password file readable by the web server and no one else.
- **`sites[]`** may be empty. A museum can be provisioned before it has its first site.
- **Every path is absolute**, and paths that would nest inside each other are refused.
- **Anything left out is derived.** The roots, the webspace base, the preview host prefix,
  the vhost directory, the *enabled*-vhost directory and the unit directory all have
  defaults; state one only to override it. On a host whose web server reads its vhost
  directory directly instead of Debian's `sites-available`/`sites-enabled` pair (RHEL's
  `/etc/nginx/conf.d`), state `paths.vhost_dir` and `paths.vhost_enabled_dir` as the SAME
  directory: the provisioner then writes the file and plans no enabling link, because on
  that host writing the file is what enables it. Declared limits are rendered into the daemon's environment and an omitted one means
  "the daemon's own default", never a frozen copy of today's value.

### 2. Put the credentials where the declaration says

**`instance.json` never holds a credential.** Any property whose name contains `KEY`,
`TOKEN`, `SECRET` or `PASSWORD` must carry the *path* of a root-owned `0600` file, and a
pasted value is refused by name — the file is world-readable configuration that ends up in
tickets and backups.

```bash
sudo install -d -m 0700 -o root -g root /etc/dedalo_sites/instances/museum-d/secrets
umask 077
sudo tee /etc/dedalo_sites/instances/museum-d/secrets/ANTHROPIC_API_KEY >/dev/null
sudo tee /etc/dedalo_sites/instances/museum-d/secrets/PREPROD_PASSWORD  >/dev/null
sudo tee /etc/dedalo_sites/instances/museum-d/secrets/PUBLICATION_API_KEY >/dev/null
sudo chmod 0600 /etc/dedalo_sites/instances/museum-d/secrets/*
```

Those files reach the daemon through systemd's `LoadCredential=`, read by systemd as root
and exposed to that one process. They are never written into the daemon's environment file,
so they are not in a core dump of a build child, not in `systemctl show`, and not in
anything an agent turn can read.

**The one credential you do not create is `SERVICE_TOKEN`** — the bearer the engine
authenticates with. `apply` mints 32 random bytes into
`secrets/SERVICE_TOKEN` and prints nothing. It is never rewritten once it exists, so
re-running the provisioner cannot break a working pairing.

`apply` also creates the `secrets/` directory itself, so on a fresh instance you may run it
first and place the files afterwards; it will name exactly what it is waiting for and exit
`3`.

### 3. Dry-run it

```bash
cd /opt/dedalo/master_dedalo/publication/site_builder
sudo bun run provision check --instance museum-d
```

`check` writes nothing. It prints one line per pending action with the reason for it, and
the commands it would run:

```
museum-d: 34 action(s) pending: 11 dir, 5 exec, 14 file, 1 group, 2 symlink, 1 user
  group   create dedalo-site-museum-d (system) — the unit's Group= names 'dedalo-site-museum-d', and systemd fails a unit whose group does not exist before the daemon is ever executed
  user    create dedalo-site-museum-d (system, primary group dedalo-site-museum-d, …)
  dir     create /var/lib/dedalo_sites/museum-d/workspaces dedalo-site-museum-d:dedalo-site-museum-d 0750 — the workspaces root must be …
  file    create /var/lib/dedalo_sites/museum-d/workspaces/.dedalo_site_instance root:root 0644 — '…/workspaces' must declare itself instance 'museum-d' before the daemon boots
  file    create /etc/dedalo_sites/instances/museum-d/secrets/SERVICE_TOKEN root:root 0600 [32 random bytes, base64url, never printed]
  file    create /etc/nginx/sites-available/dedalo-site-museum-d-coleccion.conf root:root 0644
  symlink /etc/nginx/sites-enabled/dedalo-site-museum-d-coleccion.conf -> ../sites-available/… — site 'coleccion's prod vhost is written but not enabled
  exec    nginx -t — a vhost changed, and one bad file takes down every site on this host
  …
```

Read it before you apply it. This is also the command a monitoring job runs: exit `1` means
the host no longer matches its declaration.

### 4. Apply

```bash
sudo bun run provision apply --instance museum-d
```

It writes only what drifted, creates the group before the user, stamps each root's marker
before anything is put in it, **links each rendered vhost into the directory the web server
actually reads** (`sites-enabled/`, unless this host says the two are one), and never
reloads the web server without a passing configuration test first. Run it twice: the second
run prints `museum-d: converged — nothing to do.` and touches nothing.

There is no `a2ensite` step and no `ln -s` to type. A vhost sitting in `sites-available/`
with nothing in `sites-enabled/` is a museum whose domain answers the default host, and the
provisioner treats that as drift like any other: `check` reports the missing link, `apply`
makes it, and `remove` takes it away again.

### 5. Pair the engine

The provisioner renders the lines the engine needs into
`/etc/dedalo_sites/instances/museum-d/engine.env.fragment`. Appending them is deliberately
your move — it is the step that crosses the isolation boundary, and the daemon must not be
able to read, let alone write, the engine's private directory.

From the **engine's** checkout:

```bash
bun run scripts/site_builder_pair.ts \
  /etc/dedalo_sites/instances/museum-d/engine.env.fragment \
  --token-file /etc/dedalo_sites/instances/museum-d/secrets/SERVICE_TOKEN
```

The script appends `DEDALO_SITE_BUILDER_INSTANCE`, `DEDALO_SITE_BUILDER_SOCKET` and
`DEDALO_SITE_BUILDER_TOKEN` to that install's `../private/.env`. It checks every key
against the configuration catalog first (the file is append-only and takes documented keys
only), skips a key already present with the same value, **refuses** a key already present
with a different value rather than silently re-pointing the install, refuses to write the
token placeholder, and never prints a secret. Add `--dry-run` to see what it would append.

All three keys are in the [settings reference](configuration/config.md#sitebuilder). With none
of them set the feature stays completely hidden.

### 6. Turn it on in Dédalo

1. **Restart the engine.**
2. **Register the tool** with the *Register tools* maintenance widget, so `tool_sitebuilder`
   becomes an active tool.
3. **Grant the tool** to the users who should build sites, through their profile — the same
   way you grant any tool. Administrators have it automatically.

The launcher then appears in **Area maintenance**, under the **Publication** subsystem, as
the **Site builder** panel. Because Area maintenance is gated to administrators and
developers, that is who reaches the launcher; the tool grant and the publish gate still
apply on top.

## Giving a site its own domain

A site's public address **is** its declaration. There is no vhost to write and no document
root to point anywhere.

```json
"sites": [
  { "slug": "coleccion", "domain": "www.museum-d.example" },
  { "slug": "archivo",   "domain": "archive.museum-d.example" }
],
"serving": {
  "aliases": { "museum-d.example": "coleccion" }
}
```

- **`sites[].domain`** is the canonical hostname of that site. It must be unique across the
  whole declaration, and the provisioner renders a production vhost and a pre-production
  vhost for it.
- **`serving.aliases`** maps an *extra* hostname onto a declared slug. It is a map rather
  than a list precisely so an alias with no target cannot exist: the slug must be one you
  declared, and the alias must not already be some site's canonical domain.
- **`sites[].webspace`** overrides where that site's directory lives, for a museum whose
  site is already served from somewhere the host's convention does not cover. Leave it out
  and it is `<webspace base>/<domain>`.

**Removing a site from `sites[]` un-declares it and nothing else.** Its two vhosts stay on
this host, the links that enable them stay, and its webspace still holds every release — so
the site goes on answering on its domain with nothing in the declaration saying it exists.
The provisioner will not take them away (removing a museum's published bytes is not
something a re-applied declaration may do), so instead it NAMES them: `check` lists every
such file, says which are enabled, and exits `1`; `apply` lists them and exits `3`. Retiring
a single site is a manual, deliberate act — remove its enabled link, `nginx -t && systemctl
reload nginx`, then move its webspace aside — and the run tells you exactly which paths.

Then `sudo bun run provision apply --instance museum-d`, and add the DNS record. TLS follows
`serving.prod.tls.mode`: `letsencrypt` (with `account_email`), `files` (with `certificate`
and `key` paths), or `none` for a museum behind an upstream terminator. There is no default
— a public heritage site is not a place to guess which of the three was meant.

### Obtaining the certificate, under `letsencrypt`

**The provisioner never runs an ACME client, and will not.** Obtaining a certificate needs
the DNS for that name to already point at this host, and that is not something a declaration
can assert — a run that tried would fail on a name whose record had not propagated yet, or
worse, succeed against a host that was not this one. What the provisioner does instead is
render a vhost that makes the challenge answerable *before anything is published*: the
port-80 server serves `/.well-known/acme-challenge/` out of the webspace itself, not out of
the served link, because that link does not exist until the first publish.

So, once the DNS record exists and `provision apply` has run:

```bash
sudo certbot certonly --webroot \
  -w /home/www/www.museum-d.example \
  -d www.museum-d.example \
  --email ops@museum-d.example
sudo nginx -t && sudo systemctl reload nginx
```

The `--email` is the `serving.prod.tls.account_email` you declared — the address that
receives expiry warnings — and the generated vhost carries it in its header comment, so the
file itself tells you which address this site was declared with. certbot writes its own
companion configuration beside the generated vhost; that file is unstamped and this
provisioner never touches it. Renewal is certbot's own timer, and it keeps working because
the challenge location is part of the rendered vhost rather than something a person added.

The pre-production address is the same hostname with a prefix (`pre.` by default,
`serving.preprod.host_prefix` to change it), behind HTTP basic auth against the instance's
own password file when `serving.preprod.auth.mode` is `htpasswd`.

## Checking for drift

```bash
cd /opt/dedalo/master_dedalo/publication/site_builder
sudo bun run provision check --all       # exit 1 if anything has drifted
sudo bun run provision list --all        # what is declared here, and what each serves
sudo bun run provision render --instance museum-d           # every artifact, to stdout
sudo bun run provision render --instance museum-d --engine  # the pairing fragment alone
```

`check` compares the body-hash stamp of every generated file against a fresh render, and the
owner, group and mode of every directory and root against the matrix the declaration
derives. A hand-edited vhost, a widened mode, a missing marker, a stopped unit and a
disabled service are all drift, and `apply` is how you fix them — never an editor.

Because it writes nothing and needs no arguments beyond `--all`, `check` is the right thing
to run from a nightly job. A malformed declaration never aborts the fleet: it is named,
skipped, and the run continues with the rest.

## Adopting an existing single install

A museum that has run a site builder since before instances existed has a daemon, a `.env`
full of plaintext credentials, a unit installed under a fixed name, and — the part that
matters — **live sites**. `adopt` turns that host into instance number one of the same
mechanism, moving as little as the new layout allows and telling you exactly what that is.

```bash
cd /opt/dedalo/master_dedalo/publication/site_builder
sudo bun run provision adopt --instance museum-a \
  --from /opt/dedalo/master_dedalo/publication/site_builder \
  --declare /root/museum-a-extra.json
```

- `--from` is the directory holding the pre-instance `.env`. It is required.
- `--unit` is the installed unit, defaulting to
  `/etc/systemd/system/dedalo-site-builder.service`.
- `--declare` is one JSON fragment merged over everything inferred. It is needed because a
  pre-instance install records **nothing** about the engine it is paired with, the web
  server's group, or how the public vhost terminates TLS: those lived in an operator's head
  and in a hand-copied vhost. Rather than guess them — a guessed group is a password file
  the web server cannot read and a socket the engine cannot open — adoption refuses and
  names this flag. The fragment goes through the same validator a hand-written declaration
  does, so a typo in it is refused by name instead of ignored:

```json
{
  "engine": { "private_dir": "/srv/dedalo/museum-a/private", "group": "dedalo-museum-a" },
  "web": { "group": "www-data" },
  "serving": { "prod": { "tls": { "mode": "files",
    "certificate": "/etc/ssl/certs/museum-a.pem",
    "key": "/etc/ssl/private/museum-a.key" } } }
}
```

The fragment does **not** need `engine.checkout_dir` or `engine.bun_bin`: adoption reads
them off the installed unit's own `WorkingDirectory=` and `ExecStart=`, which is where this
host says where its daemon lives. State them here only if you are moving the checkout in the
same operation.

### What moves, and what does not

| The pre-instance install had | After adoption | Moved? |
|---|---|---|
| `SITES_ROOT` — every site's source and its whole git history | `roots.workspaces`, the same path | **No.** Kept verbatim. |
| the service user and group, from the unit's `User=`/`Group=` | `identity.user` / `identity.group` | **No.** Every byte on this host is owned by that uid; renaming it would orphan all of them. |
| `PREPROD_ROOT` / `PROD_ROOT` — one pair of roots shared by every site, `<root>/.releases/<slug>` served through `<root>/<slug>` | each site's own webspace, `<webspace_base>/<domain>/{.releases,pre,web}` | **Yes.** One `mv` per surface, keeping every release. A vhost carries one document root, so a per-site domain needs a per-site tree; the old shape cannot be declared. |
| `<SITES_ROOT>/.audit/audit.jsonl` — the audit trail, inside a root the service user owns | `roots.audit`, outside the daemon's writable set | **Yes.** One `mv`. An agent turn could unlink the old one; that is what the new placement fixes. |
| the agent's home directory (whatever `useradd --create-home` made) | `roots.home`, `0700` under the state root | **No, and not carried over.** It holds the vendor CLI's session cache, never a museum's material; the new one starts empty. |
| the plaintext `.env` | `.env.pre-instance`, `root:root 0600` | Renamed and **revoked** — kept as the record of how the daemon was configured, no longer readable by the service user. |

Two consequences worth planning for:

- **A short window with no document root.** The old vhost points at the old link. Between
  the `mv` and the reload of the newly rendered vhost, that path resolves to nothing. No
  byte is copied and none is deleted; run the adoption when a few seconds of 404 is
  acceptable.
- **A move that would cross a filesystem is refused, loudly, having moved nothing** — if
  `PROD_ROOT` and the webspace base are on different volumes, copy the tree yourself with
  `cp -a` (ownership, modes and symlinks preserved), remove the original, and run `adopt`
  again. This command does not copy a museum's published bytes.

What the run does, in order:

1. **Reads the install** — the `.env`, the installed unit, the roots, and each site's own
   `site.json` — and captures what every site is currently serving.
2. **Proves it can be proved.** If a production symlink already disagrees with its own
   manifest, the run refuses and writes nothing: afterwards there would be no way to tell a
   pre-existing disagreement from one the migration caused.
3. **Checks the fleet.** The declaration it inferred is held against every museum already
   declared on this host, before the first byte is written. A collision — a shared domain, a
   shared root, a shared identity — refuses by name, because provisioning it would write
   into the other museum's tree.
4. **Infers the declaration** and writes it to
   `/etc/dedalo_sites/instances/<instance>/instance.json`. The identity comes out of the
   unit's `User=`/`Group=` and the workspaces root out of the `.env`, both verbatim; see the
   table above for what the new layout keeps elsewhere.
5. **Moves the published surfaces and the audit trail** into the places the table names —
   one rename each, never a copy, and never onto anything that already exists.
6. **Moves the credentials.** `SERVICE_TOKEN`, `ANTHROPIC_API_KEY`, `OPENCODE_ENV`,
   `PI_ENV` and `PUBLICATION_API_KEY` become root-owned `0600` files under `secrets/`, and
   the old file is **renamed** to `.env.pre-instance` and made `root:root 0600` — never
   deleted, and no longer readable by the service user, which is the point of moving the
   values out of it at all. The bearer is preserved rather than re-minted, because the
   engine is already paired with it.
7. **Claims the roots** by stamping `.dedalo_site_instance` in each. A root already carrying
   another instance's marker stops the migration dead; there is no flag for that.
8. **Converges** through the ordinary `apply`: the missing group (an install whose unit
   carried no `Group=` is exactly the latent failure this closes), the unit, the vhosts and
   the links that enable them, the rendered env, the site table, the pairing fragment, the
   new service enabled and the old one disabled.
9. **Proves it again**, against the claims captured in step 1 — same site, same surface,
   same release, read at the address the migration moved each surface to. For every site and
   both surfaces: the served link resolves, its target holds bytes, and production serves the
   release the site claims to have published. A failure here is a failure of the whole run
   whatever else succeeded — a museum whose live site cannot be proved to still serve has
   not been migrated.

Adoption is resumable: every step is a no-op when it has already happened, and a second run
re-reads the same facts and converges. It refuses only if the declaration on disk *differs*
from what it infers.

Afterwards, read `.env.pre-instance` and keep it until you are satisfied; then pair the
engine from the rendered fragment exactly as in step 5 of *Adding a museum*, except that the
engine already has a token — the pairing script will tell you if the value on the two sides
disagrees rather than quietly re-pointing the install.

## Decommissioning a museum

```bash
sudo bun run provision remove --instance museum-a
```

It takes the whole tenancy off this host: it stops and disables the daemon, **removes the
links that enable this museum's vhosts** and then the vhosts themselves, tests and reloads
the web server, and archives every tree.

It **refuses by default while any site is still published** — that is, while a served link
points at a real release. Taking a museum's public website off the internet is an explicit
act, never a side effect of retiring a daemon. `--purge-published` is how you say you meant
it.

What it then does:

- stops and disables the unit, and reloads systemd;
- deletes only the generated artifacts whose stamp proves **this** instance wrote them. A
  file at one of those paths with no readable stamp, or one stamped for another museum, is
  left exactly where it is and reported by name;
- runs the web server's configuration test before reloading it, and only if a vhost was
  actually removed — and **a failed test stops the run**. It is not downgraded to "skipped"
  the way an already-stopped `systemctl stop` is: reloading a configuration that does not
  parse takes down every other museum on this host too, so the run halts and exits `4`
  rather than carrying on to archive trees and lock an account;
- **names every credential it is leaving behind.** `secrets/` sits inside the declaration's
  own directory, which this command does not remove, so this museum's `SERVICE_TOKEN` and
  every provider key are still on the host afterwards. That is the right default — they are
  not this command's to destroy, and the engine on the other side of the pairing still holds
  the same token — but the run prints each one by path so you can revoke it at the provider
  and delete it deliberately;
- **archives, never deletes.** Every tree holding the museum's bytes — each site's webspace
  with both release stores, the workspaces root, the agent's home, the audit trail — is
  renamed beside itself as `<path>.retired-<utc>`, with one timestamp for the whole run.
  Ownership and modes are preserved, so an undo is a `mv` by a human;
- **locks the account and never frees the uid.** `usermod --lock`, and neither the user nor
  the group is deleted: every archived byte is owned by a *number*, and returning that
  number to the pool would give the next museum on this host the last one's files by
  accident. The instance name stays retired for the same reason.

It does **not** delete `instance.json` — the run says so in its closing lines and leaves the
decision to you — and it does not touch the paired engine. Remove the
`DEDALO_SITE_BUILDER_*` lines from that install's `../private/.env` yourself.

## Backups

A site-builder instance is the **fifth store** of the Dédalo backup set, alongside the
matrix database, the RAG database, the media originals and `../private/`. Per instance,
what is backed up is:

- the declaration and its `secrets/` — everything else on the host is derived from it;
- the workspaces root: every site's source and its full git history;
- each site's whole webspace: **both** release stores and the two served symlinks (which
  release is live is a fact that lives in a symlink and nowhere else);
- the audit trail.

Nothing generated is copied: the unit, the vhosts, the rendered environment and the site
table are all functions of the declaration, and `apply` rewrites them.

`deploy/dedalo-site-builder-backup.sh`, wired into the nightly `dedalo-backup.service`, does
this for every instance declared on the host. It reads each instance's roots out of the
artifacts the provisioner generated rather than from a list of its own, so a museum cannot
be quietly left out of the backup.

That one step runs as **root** — an instance's credentials are `0600 root:root` and its state
roots belong to that museum's own service user, and the backup account is deliberately in
neither group. So the backup destination holds credentials: create it `0700 root:root` and
treat the whole backup tree as secret material.

**Restoring**, per instance and in this order:

1. Put `secrets/` and `instance.json` back under `/etc/dedalo_sites/instances/<instance>/`.
2. Restore the bytes — the workspaces root, each webspace, the audit directory —
   **including hidden entries**. The `.dedalo_site_instance` markers and the `.releases`
   stores are dot-prefixed, and a root that comes back non-empty and unmarked is refused.
3. `sudo bun run provision apply --instance <instance>` — this recreates the user and group,
   re-asserts every ownership and mode, and rewrites every generated artifact. It creates a
   served symlink only when one is missing and never re-points an existing one, which is why
   the bytes go back first.
4. `sudo bun run provision check --instance <instance>` must exit `0`.

Then **reconcile**, because a converged host is not a serving host: for each site, the
served symlink must resolve, its target must be a non-empty directory, and the release it
names must equal that site's own `published.release` in `site.json`. A link pointing at a
release that is not there is a museum serving a blank page, and it looks exactly like a
successful restore from every other angle.

## Who can do what

- **Build sites** — any user granted the tool. Sites are shared: everyone with the tool
  sees and can work on every site, and each turn the agent runs is committed to the site's
  history for accountability.
- **Publish to production** — developers and global administrators only. Publishing is a
  deployment act, so it is deliberately narrower than building, and it always asks for a
  confirmation naming the public address.

Within one museum the boundary stops there: a turn for one of that museum's sites runs as
the same unix user as a turn for another, so it can read that other workspace. The boundary
this design defends is the one *between* museums, where trust genuinely stops.

## Pre-production access

Draft sites are served on a pre-production address behind HTTP basic auth, so unfinished
work is never publicly indexable. The password file is per instance, generated from the
`serving.preprod.auth.users[]` you declared and the password files you placed; the reviewer
credential is shared by every draft site of that museum. Production sites are public by
intent.

## Operating it

The *Site builder* panel in **Area maintenance** shows whether the daemon is configured and
reachable, which coding agents it has available, and the most recent publishes — a quick
health check without leaving Dédalo.

On the host, `journalctl -u dedalo-site-builder@<instance>` is the daemon's log and
`systemctl status dedalo-site-builder@<instance>` its state.

**The daemon proves who it is before it writes anything.** Its boot preflight refuses, with
a message naming the file and an exit code systemd reports, if: a root is missing, unmarked
or marked for another instance; the process is running as root, or as a uid that does not
own its roots; a root it must write is read-only (which under `ProtectSystem=strict` is a
`ReadWritePaths=` omission, and would otherwise surface as a failed publish at night); or a
declared agent binary is not an absolute, non-group-writable path. Its environment file is
refused outright if it carries a credential-shaped key, because credentials arrive by
another door entirely.

The site table is proved on every read rather than at boot, so a table that is absent,
hand-edited or stamped for another museum refuses a *publish* — by name — instead of a
start.

## Behind a reverse proxy

The chat with the agent streams events live. If you run Dédalo behind nginx, the streaming
location already needs `proxy_buffering off` (it is the same requirement the in-app
assistant has — see [production notes](configuration/config.md)); the site builder stream rides
the same path and sets the `X-Accel-Buffering: no` response header so the events reach the
browser as they happen.

The daemon itself publishes **no network port** on a provisioned host: it answers on a
per-instance unix socket owned `dedalo-site-<instance>:<engine group>` at mode `0660`. That
ownership is the entire access decision — no port, no firewall rule, and no other account on
the host able to connect.
