# Installer reference

> See also: [Production install](production.md) · [Dev quickstart](dev_quickstart.md) · [Troubleshooting](troubleshooting.md) · [Install internals](../development/ts_install_internals.md)

The reference for the installer itself: every flag, every step, what the seed
contains, how the domain ontologies are chosen and installed, and — the part that
surprises people — exactly which keys the installer writes into `../private/.env`
and which it does not.

One installer, in the terminal, drives one engine (`src/core/install/`). `install.sh` is only the
[bootstrap](#installsh-the-bootstrap): it gets Bun and the release, then starts the
installer with your arguments:

| Front end | Command | Use it when |
| --- | --- | --- |
| **Interactive terminal** | `sh install.sh` (`sudo` for production), or `bun run scripts/install.ts` in a checkout — no answer flag; `--plain` for the line mode | a person at a terminal: it asks, checks each answer as you go, and shows the whole plan before anything runs. See [Interactive mode](#interactive-mode) |
| **Headless CLI** | `sh install.sh -- <flags>`, or `bun run scripts/install.ts <flags>` | provisioning, CI, repeatable installs: flags or an answers file, nothing asked with `--execute` |

There is no browser installer: a server on a box that is not installed refuses to start ([below](#a-server-that-is-not-installed-refuses-to-start)).

!!! info "One install plan, whichever front end you use"
    The CLI, the interactive installer and an answers file all build the **same install plan**
    (`src/core/install/install_plan.ts`): the same defaults, the same list of
    `.env` keys, the same ordered steps. A given set of answers produces the same
    `.env` (apart from the generated secret) through every front end — a gate
    (`install_plan_parity_tripwire`) holds them to it. The defaults below are
    therefore THE defaults, not the CLI's.

!!! note "`dedalo:install`, not `install`"
    The same script is exposed as the npm task **`dedalo:install`**
    (`bun run dedalo:install -- <flags>`). It is not called `install` because
    that name is a reserved package-manager lifecycle hook. Prefer the direct
    `bun run scripts/install.ts` form — it is unambiguous.

## Prerequisites the installer checks for you

The pre-flight step (`src/core/install/init_test.ts`) is a hard gate — nothing
runs until it passes. A headless run checks exactly these four things; the
interactive *System check* screen shows them together with more rows (the
machine's PostgreSQL, ImageMagick, FFmpeg — and on the host routes the host's
own facts):

| Check | Failure message |
| --- | --- |
| The Bun runtime is at least 1.4.0 | `Bun x.y.z is older than the required 1.4.0` |
| The seed dump is present in the repo | `Install seed dump missing at …` |
| The private directory is creatable and writable | `Private config directory is not creatable/writable: …` |
| A `psql` client can be resolved | `PostgreSQL client (psql) not found — install the postgresql client tools` |

It does **not** check the media toolchain, the database contents or the reverse
proxy. Those fail later, and louder.

!!! warning "`psql` must not be older than the server"
    An older client refuses to connect to a newer server. The resolver checks
    `DEDALO_PG_BIN_PATH` first, then a small set of version-suffixed install
    locations, then `$PATH`. On a machine with several major versions, pin it:

    ```dotenv
    DEDALO_PG_BIN_PATH=/usr/lib/postgresql/18/bin
    ```

## Command-line flags

```shell
DEDALO_INSTALL_ROOT_PASSWORD='…' [DEDALO_INSTALL_DB_PASSWORD='…'] \
bun run scripts/install.ts \
  --db-name dedalo_main --db-user dedalo_user --entity myentity \
  [--answers answers.json] [--secrets-stdin] [--execute] \
  [--db-host localhost] [--db-port 5432] [--db-socket /var/run/postgresql] \
  [--entity-label 'My Institution'] [--locale es-ES] [--timezone Europe/Madrid] \
  [--langs lg-eng,lg-spa] [--app-lang lg-eng] [--data-lang lg-eng] \
  [--hierarchies default|none|es,fr] \
  [--ontologies default|oh,tch] [--ontology-source <dir|archive>] \
  [--decline-dependencies tchi,ts:hierarchy1] \
  [--media-path <dir>] [--socket <path>] [--media-access-mode publication] \
  [--diffusion --mysql-name web_dedalo --mysql-user d] \
  [--mailer --smtp-host smtp.example.org --smtp-user dedalo@example.org] \
  [--no-update-servers] [--skip-tools] [--plan | --list-ontologies | --list-hierarchies]

bun run scripts/install.ts --resume                              # finish an interrupted install (developer route)
bun run scripts/install.ts --abort --confirm-database dedalo_main # undo it (developer route)
sh install.sh --route <r> [--instance <i>] --resume              # the same on production / docker / trial
bun run scripts/install.ts                                       # interactive (a terminal), see below
bun run scripts/install.ts --plain                               # interactive, plain line mode
```

An **unknown flag is refused** (`unknown flag --x`) and so is a value flag with no
value after it (`--x needs a value`) — a typo never silently falls back to a
default. (`--yes` is gone: the CLI never asked anything, so it never had a
meaning.)

| Flag | Required | Default | Notes |
| --- | --- | --- | --- |
| `--route` | no | `developer` | how this Dédalo runs: `production` (native services, a named instance), `docker` (the compose stack), `trial` (Docker **without** media protection — evaluation only) or `developer` (a git checkout; the behaviour before routes). The route changes the [defaults below](#route-defaults), never what is installed. An unknown route is refused |
| `--instance` | with `--route production` | — | the instance name on a production host that can carry several: a lowercase letter, then `a-z`, `0-9` or `_`, 28 characters at most (it becomes the default service user `ded_<instance>`, the database `dedalo_<instance>` owned by the service user's peer role, a path segment and a systemd instance — see [Several instances on one host](multi_instance.md) and [Production host steps](#production-host-steps)). Refused on any other route |
| `--db-name` | **yes** (except `production` / `docker` / `trial`, which derive it) | see [Route defaults](#route-defaults) | the **empty** database you created |
| `--db-user` | **yes** (except `production` / `docker` / `trial`) | see [Route defaults](#route-defaults) | the PostgreSQL user (a login role) Dédalo connects as; it owns the database |
| `--entity` | **yes** | — | this instance's identifier, e.g. `myentity` |
| root password | **yes** | — | `DEDALO_INSTALL_ROOT_PASSWORD` in the environment, or `--secrets-stdin`; held to the password policy **before anything is written** (see [Secrets](#secrets)) |
| database password | no | *(empty)* | `DEDALO_INSTALL_DB_PASSWORD`, or `--secrets-stdin`; empty means peer/trust auth over a local socket. `--db-password` still works but warns |
| `--db-host` | no | `localhost` | a hostname, **or a unix-socket directory** when it starts with `/` (the default used to be `/tmp`; Debian/Ubuntu and RHEL do not put the PostgreSQL socket there) |
| `--db-port` | no | `5432` | |
| `--db-socket` | no | — | a PostgreSQL unix-socket directory, e.g. `/var/run/postgresql`; written as `DB_SOCKET`. When given it **wins** over `--db-host`: the connection test, the server and the backups all connect through it. Must be an absolute path |
| `--entity-label` | no | the entity name | shown on the login form |
| `--locale` | no | this machine's (`LC_ALL`, else `LANG`, as a BCP 47 tag), else `en-US` | |
| `--timezone` | no | this machine's (`TZ`, else the system's zone), else `UTC` | every database timestamp is stamped in it |
| `--langs` | no | `lg-eng,lg-spa` (the other catalogue languages are optional) | the installation's languages — interface **and** data — comma list, e.g. `lg-eng,lg-spa` |
| `--app-lang` | no | first of `--langs` | the default interface language |
| `--data-lang` | no | first of `--langs` | the default data language |
| `--hierarchies` | no | `default` | the **optional** thesauri: `default` (nothing beyond the thesauri the chosen ontologies declare), `none`, or a comma list of codes from the release's thesaurus manifest, e.g. `es,fr` (`--list-hierarchies` prints them). No thesaurus — and no country's toponymy — is ever pre-selected; a plan with no toponymy prints a suggestion to import your own country's. Languages (`lg`) is a **core** thesaurus, activated with the database on every install: naming it here is dropped with a note. A code the manifest does not list is refused. The thesauri the chosen ontologies **declare** are added to this list (even with `none`) unless `--decline-dependencies` names them — a mandatory one is strongly recommended, and declining it is a warning, never an error — see [Dependencies are declared, never guessed](#dependencies-are-declared-never-guessed) |
| `--ontologies` | no | `default` (= `oh`) | the **domain** ontologies, a comma list of TLDs — at least one. `default` is Oral history (`oh`), built into the release. Any other TLD comes from the ontology source, together with the ontologies it **declares** as dependencies. A core TLD is dropped with a note; `none` and an unknown TLD are refused. See [Domain ontologies](#domain-ontologies) |
| `--decline-dependencies` | no | *(none)* | the declared dependencies you do not want, a comma list. Each item is a TLD (declines it as an ontology and as a thesaurus) or `<tld>:ontology35` / `<tld>:hierarchy1` (declines only one of the two). Any **thesaurus** can be declined; declining a mandatory one prints a warning (strongly recommended, installable later). A mandatory **ontology** cannot be declined: naming one has no effect, and it is installed. A malformed item is refused |
| `--ontology-source` | no | *(unset)* | a local directory, or a `.tar` / `.tar.gz` / `.tgz` archive of one, in the ontology server's export layout. The non-built-in ontologies come from it instead of the update server — a fully [offline install](#offline-installs-ontology-source) |
| `--media-path` | no | see [Route defaults](#route-defaults) | the media root; write-probed during install **and persisted** to `.env` as `MEDIA_PATH` (replaces the old `MEDIA_PATH=…` env prefix) |
| `--socket` | no | see [Route defaults](#route-defaults) | persisted as `SERVER_UNIX_SOCKET`. On the developer route it is asked on the Development server screen and always written: by default `/tmp/dedalo_ts_<entity>.sock` (the entity in lowercase), so two checkouts on one machine never share a socket. Left out on a re-run, the socket your `.env` already names is kept. When a running server already answers on it, the install is refused before anything is written. A path longer than 103 bytes (the operating system's limit) is refused |
| `--media-access-mode` | no | *(unset = `publication`, fail-closed)* | persisted as `DEDALO_MEDIA_ACCESS_MODE` — `private`, `publication`, or `false` to deliberately serve an open media tree |
| `--diffusion` | no | off | writes the MariaDB keys; pair with `--mysql-host/-port/-socket/-name/-user/-password`. `--mysql-user` is required; `--mysql-name` defaults to `web_dedalo` (`web_<instance>` on production). The MariaDB connection is probed; a failure warns but does not stop the install |
| `--mailer` | no | off | writes the outbound-email (SMTP) keys, enabling [password recovery](../management/password_recovery.md); requires `--smtp-host`, pair with `--smtp-port` (587), `--smtp-secure` (`tls`\|`ssl`\|`none`), `--smtp-user`, `--smtp-password`, `--smtp-from`, `--smtp-from-name`. The relay is probed (connection + auth, no email sent); a failure warns but does not stop the install |
| `--no-update-servers` | no | off | air-gapped install: writes `ONTOLOGY_SERVERS=[]` and `CODE_SERVERS=[]`, so no ontology or code update is ever offered. Without it, both name the official Dédalo master (see below) |
| `--skip-tools` | no | off | skips tool registration (register them later from the Development Area) |
| `--plan` | no | off | dry run: prints ONE JSON line — `env_keys`, `steps`, `hierarchies`, `hierarchy_dependencies`, `suggestions`, `ontologies`, `declined_dependencies`, `ontology_source`, `ontology_install`, `active_ontology_tlds`, `notes`, `warnings`, `errors` — and exits `0` (valid) or `1`. It touches no database and no file and needs no root password. A choice beyond `oh` reads the source's catalog (one request to the update server, or the `--ontology-source` files). On `--route production` it also runs the System check's read-only refusals on this host — the system, the install folder, the service account, the instance's names — each one an `errors` entry; run without root, the root refusal is a `warnings` entry instead |
| `--list-ontologies` | no | off | prints ONE JSON line — the ontology catalog of the selected source, exactly what the interactive installer's *Ontologies* screen shows — and exits. It needs no other answer. See [Listing the catalog](#listing-the-catalog) |
| `--list-hierarchies` | no | off | prints ONE JSON line — the thesaurus offer of the release's manifest (`core`, `entries` of `{tld, name, typology_id, typology_name, has_data, dependencies}` — `dependencies` being the thesauri the entry declares, `{tld, mandatory}` each —, the toponymy `suggestion`, `errors`) — and exits. It needs no other answer. See [The thesaurus manifest](#the-thesaurus-manifest-hierarchyjson) |
| `--list-langs` | no | off | prints ONE JSON line — the languages the installer offers (`langs` of `{code, label}`, in presentation order) and the `default` set — and exits |
| `--information`, `--info-key` | no | `ts-install`, `ts` | the install's **fingerprint**, written once to the server state file (`ts_state.json`) and never changed afterwards. A fresh install hashes passwords with Argon2 and does not use them; they matter only to read passwords migrated from a v6 installation |
| `--answers <file>` | no | — | the answers as a file (the plan's answer names); see [The answers file](#the-answers-file-answers). A key set both there and by a flag is refused |
| `--secrets-stdin` | no | off | read the secrets as ONE JSON object from standard input; see [Secrets](#secrets) |
| `--execute` | no | off | explicitly unattended: the installer never asks anything and refuses a missing answer or secret; the flag is recorded on the run. Without it, a run whose standard input is a terminal **asks** for what is missing: the root password of a fresh install, or the secrets a `--resume` still needs — hidden, typed twice, the root password checked rule by rule. A run without a terminal (a pipe, a CI job) never asks |
| `--plain` | no | off | the interactive installer in [plain line mode](#plain-mode) — no full-screen drawing, no colour, one question per line. Takes no answer flag (`--resume` aside) |
| `--write-answers <file>` | no | — | also write the answers as an [answers file](#the-answers-file-answers) (`0600`, no secret in it): a headless run writes it once the plan is valid, before anything runs (`--plan` included); the interactive installer writes it at every Review whose plan is valid — so quitting there keeps the file — and says `answers not written to <file>: …` when the session ends before one. The Review's `write <path>` writes a file on demand. Refused when the path is inside the private directory, or when it exists and is not an answers file |
| `--server-name` | with `--route production` / `docker` | — | the public address browsers use, a fully qualified name (not `localhost`, not an IP address): the site file's `server_name`, the certificate's name |
| `--web-server` | no | the one installed, else `nginx` | `production`: `nginx` or `apache` — the server the [site file](#the-site-file) is written for |
| `--http-port`, `--https-port` | no | `80`, `443` | the published ports (distinct). Let's Encrypt needs `--http-port 80` (its HTTP-01 challenge) |
| `--tls` | no | `letsencrypt` (`none` on `trial`; `local_ca` on `developer`) | the certificate on `production` and `docker`: `letsencrypt` (certbot + its renewal timer), `local_ca` (a certificate authority made on this machine for a network with no public name — restricted to the install's addresses; on `production` the certificate renews itself) or `files` (the institution's own); `trial` has none. On `developer` it is the development listener's: `local_ca` (HTTPS from a certificate authority kept in `<private>/tls`), `none` (plain HTTP) or `files` (your own pair, e.g. from mkcert, with `--tls-cert` / `--tls-key`). Left out on a re-run, a pair your `.env` already names is kept |
| `--dev-port` | no | `3500` | `developer`: the port `bun run dev` serves the browser on, written as `SERVER_TCP_PORT`. When another program already uses it, the install is refused before anything is written, and the refusal names the next free port: choose it (or another) yourself. Left out on a re-run, the port your `.env` already names is kept — and held to the same rule: a kept value that is not a port is refused, and `--dev-port` replaces it. Refused on any other route |
| `--dev-host` | no | `127.0.0.1` | `developer`: the address the development listener binds, written as `SERVER_TCP_HOST` — `127.0.0.1` (this machine only), `0.0.0.0` (the local network) or one IP address of this machine. A development install shows full error details to the browser: the Review (and a headless run's summary) warns when other machines can reach it. Left out on a re-run, the address your `.env` already names is kept — a kept value that is not an address is refused, and `--dev-host` replaces it. Refused on any other route |
| `--tls-extra-names` | no | — | with `--tls local_ca` only: the other addresses staff type, comma-separated — fully qualified names (`dedalo.lan,archivo.museo.lan`) and IPv4 addresses (`192.168.1.20`). No IPv6, no loopback, no name inside another (the authority certifies each name exactly, never the names below it). On the production route an IPv4 address must be one of this server's, and no other instance may claim it: the host's catch-all then hands that address this instance's certificate ([Reaching an instance by IP address](reverse_proxy.md#reaching-an-instance-by-ip-address)). The certificate names them beside `--server-name`, the site answers to them, and the authority can certify nothing else |
| `--letsencrypt-email` | with `--tls letsencrypt` | — | the address for Let's Encrypt's expiry notices |
| `--letsencrypt-staging` | no | off | flags only: issue from Let's Encrypt's staging CA (a test certificate browsers do not trust). The public probe then does not verify the chain, so the install completes; on production the closing *To do on this host* list prints the `certbot` command that replaces the certificate with a real one |
| `--tls-cert`, `--tls-key` | with `--tls files` | — | absolute paths of the fullchain and its key. Checked before use — the certificate must name `--server-name`, be valid now (a warning under 30 days) and pair with the key — and never copied or changed on `production` |
| `--install-dir` | no | `/home/ded_<i>` | `production`: the install folder — the release tree, `private/` and `backups/` live in it. Any normalized absolute path; created owned by the service user when missing (its parent never changed); an existing one used only when it is the service user's and holds no install, or empty under root-owned parents. Refused on any other route. See [The install folder and the service account](production.md#the-install-folder-and-the-service-account) |
| `--service-user` | no | `ded_<i>` | `production`: the account the instance runs as — a new name is created (a system account, no login shell), an **existing** account is used as it is and never created or deleted. Refused on any other route |
| `--service-group` | no | the service user's own group | `production`: the group the web server joins; a new name is created. Refused on any other route |
| `--db-mode` | no | `create` | `production`: `create` (the installer creates the role named like the service user — peer authentication, no password at rest — and the database it owns; `--db-user` must then equal the service user) or `existing` (yours, probed with the password you give) |
| `--backup-dir` | no | `<install folder>/backups` | `production`: where the nightly backup units write; written as `DEDALO_BACKUP_DIR=<backup dir>/db`, so the server's own backups use the same directory |
| `--backup-site-builder` | no | off | `production`: also back up the site-builder store (as root, from the root-owned script copy) |
| `--image-source` | no | `official`; `build` for a development build | `docker` / `trial`: `official` (a Dédalo registry, cosign-verified — the image of the installer's own release: `:7.0.1`, or `:7.0.0-beta.7` for a prerelease, never the bare `:7.0.0` for a beta; the Review asks the registry and refuses an image it does not publish, or says it could not be checked when the registry is unreachable or does not answer within 15 s; a development build — a commit with no release tag — is refused without asking any registry), `custom` (a registry of your own — `--image-repository`) or `build` (built here from this checkout) |
| `--image-repository` | with `--image-source custom` | — | the registry repository of your own image |
| `--image-version` | no — `custom` or `build` | the installer's own release (`7.0.1`, `7.0.0-beta.7`, `7.0.1-dev` for a development build) | the image's version: with `custom` the tag pulled, with `build` the tag the local build gets. Only the installer's own release or its data version's `-dev` tag is accepted — the engine steps run inside the image with this installer's request format — and any other value is refused where it is typed (the Image screen), never first after `yes` |
| `--engine-only` | no | off | run only the ENGINE steps, here, with no host step and no root: the delegated child of `host_engine` / `stack_engine`, and the engine step of an [install by hand](manual_install.md#manual-host_engine) (run as the service user, with `--route production --instance <i>`) |
| `--request-stdin` | no | off | **internal**: the delegated child's input — ONE JSON object `{schema, answers, secrets}` on standard input, never argv, never a file |
| `--events-jsonl` | no | off | **internal**: the delegated child's output — its log lines and step events as JSON lines (the one-time salt as a `show_once` frame the parent shows once and never stores) |
| `--pg-bin-path` | no | — | written as `DEDALO_PG_BIN_PATH`; the production route derives it from the system's PostgreSQL 18 binaries and hands it to its engine child, and an [install by hand](manual_install.md#manual-host_engine) gives it on its engine step |
| `--status --json` | no | off | prints the install record of this process's private directory (`{exists, outcome, failed_step}`) and exits — how a host step verifies its child, and how you can check one by hand |
| `--resume` | no | off | finish the interrupted install: on the developer route the one recorded in `<private>/install/`; on `production` / `docker` / `trial` repeat `--route` (and `--instance`) so the installer finds the host record. See [Resuming an install](#resuming-an-install-resume) |
| `--abort` | no | off | undo the interrupted install, found as for `--resume` (repeat `--route` and `--instance` on the host routes); needs `--confirm-database`. See [Undoing an install](#undoing-an-install-abort) |
| `--confirm-database <name>` | with `--abort` | — | must equal the install's database name before `--abort` resets it |

The run-control flags exclude each other where they cannot mean anything:
`--resume` with `--abort`, `--plan` or a `--list-*` flag with either,
`--confirm-database` without `--abort`, `--plain` with `--abort` or with any
answer source (`--plain --resume` is allowed: it asks the secrets a resume
needs), and `--write-answers` with `--resume`, `--abort` or a `--list-*` flag
are refused. A value that starts with `--` (or is empty) can be given as
`--flag=value`; the installer prints its own command lines in that form.

### Route defaults

A route changes the **defaults** of a few answers — what an answer you do not
give falls back to. It never changes the steps, and a flag you give always wins.

| Answer | `developer` | `production` (instance `<i>`) | `docker` / `trial` |
| --- | --- | --- | --- |
| database host | `localhost` | `localhost` | `postgres` (the compose service) |
| database name | — (required) | `dedalo_<i>` | `dedalo` |
| install folder (`--install-dir`) | — | `/home/ded_<i>` | — |
| service user / group | — | `ded_<i>` / its own group | — |
| database user | — (required) | the service user — its PEER role (no password at rest; `--db-mode create`) | `dedalo` |
| database socket | — | `/var/run/postgresql` | — |
| media root (`MEDIA_PATH`) | not written | `/srv/dedalo/<i>/dedalo/media` (the web root rule: the site's `root` is `/srv/dedalo/<i>`, so `/dedalo/media/…` is `MEDIA_PATH/…`; a production `MEDIA_PATH` must end in `/dedalo/media`) | `/srv/dedalo/media` |
| backups | — | `<install folder>/backups` | the `backups` volume |
| certificate (`--tls`) | `local_ca` (the development listener's) | `letsencrypt` | `letsencrypt` (`trial`: none) |
| development listener (`--dev-port`, `--dev-host`) | `3500` on `127.0.0.1` | — | — |
| HTTPS port (`--https-port`) | — | `443` | `443` (`trial`: none — the trial publishes plain HTTP only and does not ask it) |
| server socket (`SERVER_UNIX_SOCKET`) | `/tmp/dedalo_ts_<entity>.sock` | `/run/dedalo-<i>/dedalo_ts.sock` | `/run/dedalo/dedalo_ts.sock` |
| publication database (`--mysql-name`) | `web_dedalo` | `web_<i>` | `web_dedalo` |

The backups and the database user follow the install folder and the service
user **you gave**, not the instance name: `--install-dir /home/my_domain.org/dedalo
--service-user my_domain.org` backs up into `/home/my_domain.org/dedalo/backups`
and owns the database as the user `my_domain.org`. An explicit `--backup-dir` wins.

The docker and trial host steps hand these to the engine child inside the
container, so the stack's values live in one place (`src/core/install/install_plan.ts`).

!!! danger "No password belongs on the command line"
    `--root-password`, `--db-password`, `--mysql-password` and `--smtp-password`
    still work, but each prints a warning: an argv is visible to every user in
    `ps` and lands in your shell history. Use the `DEDALO_INSTALL_*`
    environment variables or `--secrets-stdin` (see [Secrets](#secrets)).

!!! tip "Check the plan before you run it"
    `--plan` validates the answers exactly as the install would, without needing
    the database (a root password is checked against the policy when one is
    supplied, but not required). On `--route production` it also measures this
    host read-only, as `host_preflight` will, and reports what it would refuse:

    ```shell
    bun run scripts/install.ts --plan --db-name dedalo_main --db-user dedalo_user --entity myentity --hierarchies none
    ```

!!! warning "Languages are mandatory, and the defaults must be members of the set"
    The server refuses to boot without its language configuration. The CLI
    derives it up front and **refuses the install** if `--app-lang` or
    `--data-lang` is not one of `--langs` — better a clear refusal than an `.env`
    that crash-loops the server on the very next boot.

## What the installer does, in order

The CLI prints each plan step as `→ [<step id>] …`; the ids are the keys of the
one step table the executor runs, whichever front end gathered the answers. The
pre-flight before the first step and the root-login check after the last are the
installer's own affordances.

1. **Validation** — every answer, and the root password, is checked by the plan
   (see [Validation before anything is written](#validation-before-anything-is-written)).
   A refusal here writes nothing.
2. **Pre-flight checks** — the four gates above, then the **target database**:
   it must exist and be **empty** — zero tables, views, sequences, functions,
   types or schemas of its own (members of an extension such as `plpgsql` do not
   count) — and no other install may be running against it (a server-side lock
   on the database decides this, so two installs from two private directories
   cannot both pass). A refusal here writes nothing either.
3. **The plan and state files** are written under `<private>/install/` — only
   now. From here on every step is recorded (see
   [The plan and state files](#the-plan-and-state-files)).
4. **`test_db_connection`** — the database must already exist, and be empty. If it
   does not exist, the installer stops: it never creates a database.
5. **`test_diffusion_connection`** *(only with `--diffusion`)* and
   **`test_mailer_connection`** *(only with `--mailer`)* — probes that **warn** on
   failure and let the install continue.
6. **`install_dev_dependencies`** *(developer route only)* — installs the
   checkout's development dependencies (`bun install --frozen-lockfile
   --ignore-scripts`: the bootstrap's install without `--production`), as the
   checkout's owner. `bun run dev` needs them — its CSS watcher imports `less`.
   Only what is missing is installed; a checkout that already has every
   development dependency at its locked version is left as it is. A failed
   install (this machine must reach the npm registry once) **fails the install**,
   with bun's own words. Production, docker and trial keep the production-only
   tree. Run as root in a checkout another user owns, the step refuses: root
   never writes in a user's tree.
7. **`dev_tls_certificate`** *(developer route, `--tls local_ca` only — the
   default)* — the development listener's certificate, issued by the same
   generator the other routes use (`deploy/dedalo-tls-rotate.sh --mode local-ca
   --reload none`) into `<private>/tls` (directory `0700`, keys `0600`), as the
   checkout's owner. The certificate authority is restricted to exactly
   `localhost` and `127.0.0.1`, plus the address the listener binds when it is
   opened to the network: the one IPv4 address of `--dev-host`, or this
   machine's IPv4 network addresses with `0.0.0.0` / `::`. IPv6 addresses are
   never certified: a loopback listener is opened as `https://localhost:…`,
   which the certificate names whatever the address family; a specific IPv6
   `--dev-host` with `local_ca` is refused (choose an IPv4 address, `none` or
   `files`). On a re-run the authority already there is kept and its
   certificate renewed when it expires within 30 days; an authority made for
   other addresses is refused before anything is written, and the refusal
   names the command that replaces it. `--abort` removes `<private>/tls` only
   when this install created it.
8. **`dev_trust_ca`** *(with `dev_tls_certificate`)* — prints the authority's
   path and SHA-256 fingerprint and makes this machine trust it. On macOS the
   authority goes into your login keychain (`security add-trusted-cert`), and
   macOS asks for your password in a system dialog. On Linux it is copied into
   the system anchors and the store is rebuilt (`update-ca-certificates` or
   `update-ca-trust`), through `sudo` for that one command; as root, no `sudo`.
   Firefox keeps its own store: with `certutil` installed the authority is
   added to every Firefox profile, otherwise the step tells you to set
   `security.enterprise_roots.enabled`. A cancelled dialog, a refused `sudo` or
   another system does **not** fail the install: the step reports *not trusted
   yet* with the manual command, and `bun run dev` serves either way (the
   browser warns until you trust it). Nothing is asked when this machine
   already trusts it. On macOS a cancelled dialog leaves nothing behind: the
   certificate the keychain had already imported is deleted again. `--abort`
   takes back what this install added; if that removal is refused, `--abort`
   keeps `dedalo-trust.json` and the authority in `../private/tls/` so that
   `bun run tls:untrust` can still remove it. `bun run tls:untrust` takes back
   everything the installer added, for a finished install.
9. **`persist_config`** — writes `../private/.env`; see the next section. Any
   previous `.env` is first copied to `.env.bak.<timestamp>`, then the new file
   replaces it in one rename (the `.env` is never missing in between).
10. **`check_directories`** — creates and write-probes the private directory, the
   session store, the backups directory, and the media root: `--media-path` when
   given, otherwise the default `<private dir>/media` (a legacy in-tree
   `<repo>/media` that already holds files is kept instead). It then provisions
   the media tree under that root. Writability is proven by writing and deleting a probe file, not by
   reading permission bits — a network mount can lie about the bits.
11. **`stage_ontologies`** — fetches (update server) or copies (built-in `oh`,
   `--ontology-source`) every chosen domain ontology file, dependencies first,
   into the staging directory, and verifies each one (decompression and row
   format) **before the database is touched**. Apart from the developer
   route's development dependencies, this is the install's only network phase: an unreachable server or a damaged file stops the install
   here, with the database still empty.
12. **`install_db_from_default_file`** — restores the database from the core-only
   seed (refused unless the database is empty) as **one transaction** — a restore
   that fails or is killed part-way leaves the database empty, never half-built —
   **then** builds the derived search
   indexes and **activates the core
   Languages thesaurus (`lg`)**. Its terms already ship in the seed, so activation
   is all it needs — there is no separate step for it, and nothing about it to
   choose.
13. **`install_ontologies`** — imports the staged domain ontologies through the
   same import routine the ontology update panel uses, then checks their
   references (see [Domain ontologies](#domain-ontologies)). An import failure
   **fails the install**.
14. **`set_root_pw`** — the root password, hashed with Argon2id.
15. **`install_hierarchies`** — imports and activates the **optional** thesauri you
   chose (`none`, or nothing chosen, adds none), plus the thesauri the installed
   ontologies declare, unless declined. A declined mandatory thesaurus is a
   warning, never a failure. Each selected TLD has its listed term files verified against their
   checksums and copied in (a thesaurus the manifest lists without files is
   created empty), **and is then activated**: the hierarchy is flagged active, its virtual ontology sections
   (`<tld>0`/`<tld>1`/`<tld>2`) are provisioned, and its thesaurus tree is rooted —
   so the hierarchies you selected are browseable at the first login. Importing
   without activating leaves the terms in the database but unreachable (the section
   does not exist for the engine until its ontology does), so a TLD whose activation
   fails is a **failed** hierarchy — and a failed hierarchy **fails the install**:
   nothing is sealed.
16. **`register_tools`** (unless `--skip-tools`).
17. **`install_finish`** — seals the install, refused unless a root user with a
    password actually exists. A forged *finish* can never seal a half-built
    instance.
18. **`verify_dev_server`** *(developer route only)* — the install is complete
    only once it serves. The step starts `bun run dev` once in the background,
    the way you will (the CSS watcher and the supervised server), with the
    `.env` it wrote: every key that file names is removed from the command's
    environment, so the server reads the file. It then asks the development
    listener for `/health` (over HTTPS with the local certificate authority as
    the only trust anchor: whether this machine already trusts it does not
    matter here), logs in as `root` over the listener, checks that every
    cookie the login sets is `Secure` exactly when the listener is HTTPS
    (`SESSION_COOKIE_SECURE`), checks that the next request carries the
    session cookie, and stops the server again, waiting until the port is
    free. Before it starts anything it checks that no other program holds the
    port: a foreign server would otherwise answer for it. It refuses to run as
    root in a checkout another user owns: the server it starts writes the
    session store, logs and compiled CSS there. A failure **fails the
    install** and names the cause: the port taken, a certificate the server
    refuses (its own boot refusal, key and path named), the database
    unreachable (`/health` answers `db: down`), a development dependency
    missing (the package named), another Dédalo server on the same unix
    socket, the certificate not verifying, a cookie flag that does not match
    the listener, or the login refused. The install is sealed by then, so
    `--abort` refuses and the failure hint does not offer it, and a `--resume`
    with another `--dev-port` or `--socket` is refused as a changed answer:
    fix the cause — stop the other program, or edit the key the message names
    (`SERVER_TCP_PORT`, `SERVER_UNIX_SOCKET`) in the written `.env` — then
    `--resume`, which runs the check again with that file. An install written
    to another private directory (`DEDALO_INSTALL_PRIVATE_DIR`) is started as
    `DEDALO_PRIVATE_DIR=<dir> bun run dev`, by the check and on the final
    screen alike. Without `bun` on your `PATH`
    (an install started through `install.sh`), the check runs with the
    installer's own Bun and warns that `bun run dev` will not start from your
    shell.
19. **Verify the root login** — an actual login against the freshly installed
    database. This is the end-to-end proof, and it is why the CLI prints
    `✔ install complete — root login verified`. The generated secret
    (`DEDALO_SALT_STRING`) is shown here, once, by the run that completes the
    install — a `--resume` included — and never mid-run (see [Secrets](#secrets)).
    On the developer route the closing lines then say what to do next, from
    the keys the install wrote: start the server with `bun run dev`, open the
    client at every address it answers on (`https://127.0.0.1:3500/dedalo/core/page/`
    and `https://localhost:3500/…` with the defaults, plus this machine's
    network addresses when it is opened to the network), log in as `root`, and
    the certificate authority's path, SHA-256 fingerprint and whether this
    machine trusts it now (with the command that trusts it, when it does not).
    The full-screen installer leaves the same lines on the terminal when it
    closes. The [developer quickstart](dev_quickstart.md#5-run-the-installer)
    shows them.

!!! note "Only declared thesauri are pre-selected"
    The CLI's default and the interactive installer's pre-ticked boxes are the
    same set: the thesauri the chosen ontologies
    **declare**, all ticked (a mandatory one marked strongly recommended, but
    still editable). Nothing else is
    pre-selected — in particular **no country's toponymy**. When the install
    adds no toponymy thesaurus, the installer prints a suggestion to import your own country's, e.g. `--hierarchies np` for an
    installation in Nepal.

### The thesaurus manifest (`hierarchy.json`)

The thesauri a release offers are listed in ONE file,
`install/import/hierarchy/hierarchy.json`, exported from the Dédalo master by
*Maintenance › Export hierarchy* (see
[Install new hierarchies](../management/install_new_hierarchies.md)). It has the
same envelope as the ontology catalog (`version`, `date`, `entity_id`, `entity`,
`entity_label`, `host`), a `typologies` list, and one `active_hierarchies` entry
per thesaurus: its `tld`, name, typology, default language, real section, scope
note, declared `dependencies` and `data_files` — each `{file, sha256}` of a
`<tld>1.copy.gz` / `<tld>2.copy.gz` beside it.

- **Every entry is offered**, with or without data files. An entry with no data
  files is installed as an **empty** thesaurus (activated, nothing imported).
- Before anything of a thesaurus is written, each listed file must exist and
  match its `sha256`. A missing or changed file refuses that thesaurus, and the
  install fails.
- The installer refuses a manifest it cannot read or that is malformed
  (`install.manifest_invalid`) rather than offering nothing.
- When a thesaurus is activated for the first time, its registry record is
  written from the entry: code, name, typology, default language (which must
  already exist in the Languages thesaurus — otherwise the activation is
  refused), real section, scope note and dependencies. An existing record is
  never overwritten.
- Languages (`lg`) is listed for reference only: it has no data files, its
  terms ship in the database seed, and it is never offered as a choice.

## What the seed installs

Restoring the vendored seed (`install/db/dedalo_install.pgsql.gz`, about 2 MB
compressed, 50 MB of SQL) turns an empty database into a working Dédalo core:

- the full **matrix / `dd_ontology` schema** — 33 tables, plus the functions,
  triggers and indexes;
- the **extensions** `btree_gin`, `pg_trgm` and `unaccent` (which is why the role
  needs the right to create them);
- the **core ontologies, and nothing else** — `dd`, `rsc`, `ontology`,
  `ontologytype`, `hierarchy` and `lg`, about **3,470 `dd_ontology` rows**;
- the terms of the **Languages** thesaurus (`lg`), which the restore activates;
- the **`root` user** (with no password until `set_root_pw`), the default project,
  and the *Admin* and *User* profiles.

The derived search indexes (`matrix_string_search`, `matrix_relation_index`)
ship **empty**: the restore step rebuilds them from the restored rows, the same
way a booting server repairs them.

!!! info "An installation carries no test data"
    The seed holds no domain ontology (each installation chooses its own — see
    below), no developers' `test` ontology and no *test3* playground records.
    Those belong to the developers' test database, which `bun run test:db:setup`
    builds through these same install steps and then adds its fixtures to (see
    [Testing](../development/testing.md)).

The restore is all-or-nothing: the seed is fed to `psql` with
`ON_ERROR_STOP=1`, and a non-zero exit is a hard failure. There is no partial
success to clean up after.

??? note "How the seed is built"
    The seed is a generated file, compiled from files in the repository only —
    never from an installation's database. `bun run seed:build` (the same
    compiler as Maintenance → *Build database version* → *Build install
    version*) applies the schema and its migrations, the CORE ontology release
    packages, the languages and hierarchy registry files and the default
    accounts into a scratch database, proves the result by installing it into a
    second scratch database, and only then replaces the seed. Next to the seed
    it writes `install/db/dedalo_install.manifest.json`: the seed's checksums,
    the row count of every table and a checksum of every source file. A gate
    (`install_seed_manifest_tripwire`) holds the committed seed to that file, so
    a hand-edited seed, or a source changed without a recompile, fails the
    build. [Install internals](../development/ts_install_internals.md#the-install-seed)
    has the details.

## Domain ontologies

The core ontologies describe Dédalo itself: users, projects, resources such as
people, images and publications, the thesaurus machinery, languages. What an
institution catalogues — interviews, objects, coins, intangible heritage — is
described by **domain ontologies**, and every installation chooses at least one.

| Answer | CLI | Interactive installer |
| --- | --- | --- |
| which domain ontologies | `--ontologies oh,tch` (default `oh`) | the *Ontologies* screen, `oh` pre-ticked |
| where the others come from | the update server, or `--ontology-source` | the update server, or a local source |

- **`oh` (Oral history) is the default, and it is built in.** The installer reads
  one file of the vendored ontology directory,
  `install/import/ontology/<major.minor>/oh.copy.gz` (and that ontology's entry
  in the directory's `ontology.json`), so an installation always
  has a usable domain ontology, even with no network. (The other files in that
  directory are there for an installation that serves the ontology to others;
  the installer does not read them.)
- **Every other ontology comes from the selected source**: the first server in
  `ONTOLOGY_SERVERS` — the official Dédalo master by default, or the first server
  of a list you set yourself on an earlier run — or the `--ontology-source`
  directory or archive. For example, `tch` (Tangible cultural heritage) is the
  general inventory model for objects and collections; it is described on the
  *Ontologies* screen but not pre-ticked. When one TLD is offered by several places, a
  `--ontology-source` file wins over the built-in `oh`, which wins over the
  server.
- **An air-gapped install (`--no-update-servers`) is offered only `oh`**, unless
  `--ontology-source` provides more. Asking for another TLD is refused before
  anything is written: `unknown ontology 'tch' — not offered by the built-in set
  (air-gapped: only oh is available offline)`.
- **The installer writes `ACTIVE_ONTOLOGY_TLDS`**: the core, then the installed
  domain ontologies in install order. It is rewritten on every run. The
  [ontology update panel](../management/updates/updating_ontology.md) refreshes
  exactly these.

### Dependencies are declared, never guessed

A domain ontology usually builds on others: its sections use components defined
in another ontology, or its fields point into another one's thesaurus. The
ontology server **declares** these dependencies for each ontology in its
catalog (an editor fills them in on the master — see
[Declaring what an ontology requires](../management/updates/updating_ontology.md#declaring-what-an-ontology-requires)).

Each declared dependency names a TLD and what is needed from it: its
**ontology** (`main: ontology35`) or its **thesaurus** (`main: hierarchy1`, the
hierarchy with its terms, installed and activated). A TLD may be declared under
both. Each one is **mandatory** or **optional**.

- The installer installs the chosen ontologies **plus the ontologies they
  declare**, transitively, each dependency before the ontology that needs it. It
  says so before it starts: `tch also installs: …`. Core ontologies in a
  declaration are already installed and are skipped.
- The declared **thesauri** are added to the
  [`install_hierarchies`](#what-the-installer-does-in-order) step. The core Languages
  thesaurus (`lg`) is never listed, because every install activates it.
- A **mandatory ontology** is always installed. It cannot be unticked on the
  screen, and `--decline-dependencies` has no effect on it.
- An **optional** dependency is offered already ticked. Untick it on the screen,
  or name it in `--decline-dependencies`, to leave it out:
  `the ontology 'x' (an optional dependency of 'y') is declined — not installed`.
- **A thesaurus dependency never blocks an install.** A **mandatory thesaurus**
  is a strong recommendation, not a requirement: you can work without it,
  keep a thesaurus of your own under another name, or install it any time
  later. It is offered ticked and marked *strongly recommended*; untick it on
  the screen, or name it in `--decline-dependencies`, to leave it out. The
  install continues with a warning:
  `the thesaurus 'x' (declared mandatory by 'y') is declined — not installed; it is strongly recommended and can be installed later from Maintenance › Install hierarchies`.
- A mandatory ontology the source does not offer is refused before anything is
  written: `'x', declared as a dependency of 'y', is not offered by the ontology server '…'`.
  An optional one is skipped with a warning.
- A thesaurus is installed from the release's
  [thesaurus manifest](#the-thesaurus-manifest-hierarchyjson). A thesaurus with
  no entry there is skipped with a warning — mandatory or not, never an error:
  `the thesaurus 'x' (declared mandatory by 'y') has no entry in hierarchy.json — skipped; it is strongly recommended and can be installed later from Maintenance › Install hierarchies`.
  An entry without data files is not an error either: the thesaurus is created
  empty.
- **An older ontology server publishes no dependencies.** The installer then
  warns, names the ontology, and installs exactly what you chose — it never works
  out dependencies on its own:
  `the ontology source declares no dependencies for 'tch' (an older ontology server) — 'tch' is installed alone; anything it references in other ontologies stays unresolved`.
  Name the ontologies it needs yourself (for example `--ontologies tch,tchi`),
  or install them later from the update panel. The built-in `oh` of this release declares
  none yet either, so a default install warns
  `the built-in ontology.json declares no dependencies for 'oh' (a release that predates them) — …`
  and installs `oh` alone.

**After the import, the installer checks the references.** For every node of
the installed ontologies it follows the parent, the model and the related nodes.
A reference to an ontology the installation does not have is reported as a
warning — the install still completes. The warning names the ontology and what
adding it would change. For example, the release's `tch` package has one
autocomplete whose target lives in the `ww` ontology:

```text
⚠ 'tch' references 1 node(s) of 'ww' that is not installed (relations: e.g. tch357→ww22) — the nodes that use them do not work until 'ww' is installed: add it (--ontologies tch,ww) if you use them, or ask the ontology server to declare it
```

Add the named ontology only if you use the nodes that need it. These references
are never reported, because a missing target is harmless by design:

- A node placed *under* a node of another ontology. It simply does not show
  there, and when that ontology is absent nothing below the node is reachable,
  so the references of that whole branch are not checked either.
- The field mappings of a publication (diffusion) definition into another
  ontology.
- An **external-ontology mapping**: the branch under a node of model
  `external_ontology`, which maps the ontology to an outside vocabulary for the
  RDF import (`tch` maps itself to CIDOC CRM, `crm`). The ontology works
  without the vocabulary; only that mapping stays inert. A `tch` install
  therefore never asks for `crm`.
- A reference into a thesaurus that the same install creates in its Thesauri
  step (for example `dc`, which `tch` declares).

A reference into a **core** ontology that this release's seed does not have yet
means the master's core is newer than the seed. The warning then says to run
*Maintenance › Update ontology* after the install.

### Listing the catalog

`--list-ontologies` prints what the selected source offers, as the
*Ontologies* screen shows it — air-gapped here, so only the built-in `oh`:

```shell
bun run scripts/install.ts --list-ontologies --no-update-servers
```

```json
{"source":{"kind":"none"},"default":["oh"],"core":["dd","rsc","ontology","ontologytype","hierarchy","lg"],"entries":[{"tld":"oh","name":"Oral History | oh","typology_id":"8","typology_name":"Catalog","origin":"vendored","is_default":true,"note_key":"installation_ontology_note_oh","dependencies":null,"also_installs":[],"hierarchy_dependencies":[]}],"warnings":[],"errors":[]}
```

Each entry carries its `origin` (`vendored`, `local` or `server`), its declared
`dependencies` (a list of `{tld, main, mandatory}`, or `null` when the source
declares none), `also_installs` — the non-core ontologies a choice of it would
add — and `hierarchy_dependencies` — the thesauri it would add, each
`{tld, mandatory, dependants}`. Core ontologies are never listed:
they are not a choice. The source follows the other flags: `--ontology-source`,
`--no-update-servers`, or the configured server. `--plan` shows the outcome for a
given answer: `ontology_install` is the install order,
`active_ontology_tlds` what will be written, `hierarchy_dependencies` the
declared thesauri, `hierarchies` every thesaurus the install will add and
`suggestions` the toponymy hint when none of them is a toponymy.

`--list-hierarchies` does the same for the thesauri — the release's manifest,
core apart, each entry with `has_data` (false = it installs empty):

```shell
bun run scripts/install.ts --list-hierarchies
```

### Offline installs (`--ontology-source`)

To install more than `oh` without a network, copy an ontology server's export
to the machine and point the installer at it:

```shell
bun run scripts/install.ts … --ontologies oh,tch --ontology-source /srv/media/ontology_7.0.tgz
```

The source is one **version directory** of an ontology server's export (its
`ONTOLOGY_DATA_IO_DIR/<major.minor>/` — see
[the ontology directory](../config/config.md#ontology-inputoutput-exportimport-or-download-directory)),
or an archive of it:

- `ontology.json` — the catalog, with each ontology's metadata and declared
  dependencies. Its version must be this release's `major.minor`;
- one `<tld>.copy.gz` per ontology;
- optionally `matrix_dd.copy.gz`, the master's private value lists. It is
  installed when at least one chosen ontology comes from this source, and it
  **replaces** the installation's private lists.

An archive (`.tar`, `.tar.gz` or `.tgz`) may hold those files at its root or in
one top-level directory. Only regular files with those names are extracted;
anything else (directories, extended headers, a `recovery/` subfolder, other
names) is ignored and does not count against any limit. An archive with absolute
paths, `..` segments or links, more than 4096 ontology files, more than 50 000
entries in all, or more than 512 MB is refused.

### When something fails

The ontology files are fetched and verified by `stage_ontologies`, **before the
seed is restored**: a source that is unreachable, refuses the access code or
serves a damaged file stops the install with the database untouched. The
staged files wait in `../private/install/ontology_staging/` (with a
`staged.json` recording each file's checksum) and are deleted after a successful
import; after a failure they stay there for diagnosis, and the next run starts
from a clean staging directory.

An import failure in `install_ontologies` stops the install: the import routine
restores each ontology's tables from its snapshot, and **nothing is sealed**. As
for any failed step, the progress is saved: fix the cause and run
`bun run scripts/install.ts --resume` ([Resuming an install](#resuming-an-install-resume)),
or take the install back with `--abort --confirm-database <db>`
([Undoing an install](#undoing-an-install-abort)). There is no need to drop and
recreate the database.

## Interactive mode

Run the installer with **no answer flag** at a terminal and it asks:

```shell
sh install.sh                         # the interactive installer (sudo sh install.sh for production)
sh install.sh --plain                 # the same questions, one per line
bun run scripts/install.ts            # the same, in a checkout that already has Bun
```

The route is chosen on the first screen. `--route` and `--instance` are answer
flags like any other: give one and the run is headless, so it asks nothing and
refuses an answer it is missing (`entity is required`, …).

It walks one screen per step, in this order, and the route you pick first
decides which steps follow — until you pick it, the step list shown is
production's. Install and Done follow the Review, and both front ends count them:
plain mode's `Step <n> of <N>` and the full screen's rail number the same steps.

| Route | Steps |
| --- | --- |
| production | Install type → System check → Identity → Database → Web server & TLS → Services → Ontologies → Thesauri → Languages → Publication → Mail → Administrator → Review plan |
| developer | Install type → System check → Database → Identity → Development server → Ontologies → Thesauri → Languages → Publication → Mail → Administrator → Review plan |
| docker | Install type → System check → Image → TLS & address → Containers → Identity → Ontologies → Thesauri → Languages → Publication → Mail → Administrator → Review plan |
| trial | as docker, without TLS & address |

On production, **Identity** comes before the database: it asks the install
folder and the service account first, because a database the installer creates
belongs to the service user. With **Database: Create it** (the default) the
database screen asks only the database name — the role is the service user,
reached by peer login over the local socket, so there is no host, port, socket
or password to ask; **Use an existing one** asks the whole connection.
Identity also asks **Information** and **Info key**, the install's
fingerprint: written once to `ts_state.json` and never changed afterwards, used
only to read passwords migrated from a v6 installation — keep the defaults unless
you are moving one.

What the screens do for you:

- **Every default is the installer's own** — the same one a flag-less headless
  run takes (see the tables above). Accepting a default leaves the answer out,
  so a default that follows another answer keeps following it (the production
  database name follows the instance name). The time zone and locale offered
  are your machine's, when they are valid.
- **Every answer is checked as you give it**, with the same rules and the same
  refusal sentences as a headless run ([Validation](#validation-before-anything-is-written)):
  a refused answer is asked again, the refusal shown under it. An entity name
  that is not a valid code gets a suggested code next to the refusal.
- **Checks run where they help.** The System check must pass. Its rows depend on
  the route: production adds the operating system, `root` and the firewall to the
  Bun, seed and private-directory rows and the diagnostics (platform, memory,
  processor, disk, ImageMagick, FFmpeg, cURL, OpenSSL); developer has the
  PostgreSQL client and the same diagnostics; docker and trial have Bun, the
  private directory, Docker, Compose and the disk — the full list is in
  [Troubleshooting › The System check screen](troubleshooting.md#the-system-check-screen).
  A failure no fix on this machine can change (an unsupported system) offers only
  quit, or back to another route. The database must exist, be
  reachable and be empty: retry, or go back and edit. The media directory
  (production) must be creatable by you. The MariaDB and SMTP connections must
  pass, or you type `yes` to keep them untested — the Review says which. The
  mail check can also send a real test message to an address you give (it is
  not kept).
- **Ontologies and thesauri** are offered from the update server's catalog (or
  your offline package when the install is air-gapped), grouped, with what each
  one declares pre-ticked; unticking a declared dependency declines it, exactly
  as `--decline-dependencies` does. A mandatory ontology dependency cannot be
  unticked; a thesaurus never is forced. The groups are the catalog's typologies,
  named in the installer's language (English); the typology groupers
  (`hierarchytype`, `hierarchymtype`) are not domain ontologies and are not
  offered. When no country toponymy is selected the thesaurus step suggests
  typing your country's code (e.g. `np`); after the install, toponymies are added
  from **Maintenance › Install hierarchies** — the interactive installer never
  points you to a command-line flag for it.
- **Passwords** are never shown and are typed twice; the root password is
  checked rule by rule after the first entry. A password already given through
  `DEDALO_INSTALL_*` or `--secrets-stdin` is kept, not asked (the root password
  is still checked against the policy).
- **The Review** lists what the install will do — the database, the ontologies
  in install order, the thesauri, the languages, publication and mail (tested or
  not), the media root and socket, the steps, the `.env` key names (never a
  value), on the production, docker and trial routes every host command, and the
  equivalent command line (without secrets) — `same as`, in the route's own
  form: `sudo sh install.sh …` on production, `sh install.sh …` on docker and
  trial, `bun run scripts/install.ts …` on developer. Then:
  `install` (typed `yes` to start; offered only when the plan has no error
  and nothing the run's own system check would refuse — on production, docker
  and trial the Review measures that check before `yes` and lists what it
  refuses as errors: an untrusted certificate chain, another web server on the
  ports, an image version other than the installer's, a port already in use;
  refused, `install` checks again — the cause fixed, it goes on to the typed
  `yes` with every answer kept, still refused, it says so),
  `edit <n>` (go back to step `n`; later steps ask only what changed),
  `write <path>` (an [answers file](#the-answers-file-answers), no secret in it;
  the screen then says how to run it — the same entry command with
  `--answers <file>`, the passwords through `DEDALO_INSTALL_*` or
  `--secrets-stdin`), `quit`. Started with `--write-answers <file>`, the
  installer also writes that file at every Review whose plan is valid.

The interactive installer hands its answers to **the same install** a headless
run makes: the plan is built again from your answers, the ontology catalog read
again, and the install refused — `the ontology catalog changed between review
and install — run again` — if it would now decide anything other than what you
reviewed.

**A refusal never loses your answers.** The system check is measured again at
the typed `yes`: when it refuses now (a port taken since the Review was drawn),
the session stays on the Review, says why, and keeps every answer — fix the
cause and `install` again (it checks first), or edit a step. A run that is still refused
after it started, before it changed anything, writes your answers to an
[answers file](#the-answers-file-answers) — the `--write-answers` path when you
gave one, else `dedalo-install-answers.json` in your home directory (root's under
`sudo`) — and prints the command that runs them again (`sh install.sh --answers
<file>`, `sudo` on production).

Every route installs from the Review. On **production**, **docker** and
**trial** the Review also lists every host command, exactly as it will run
([Production host steps](#production-host-steps),
[Docker and trial host steps](#docker-and-trial-host-steps)); `write <path>`
still writes the answers file instead.

If a **developer-route** install was interrupted (its record is in
`<private>/install/`), the interactive installer says so first and
offers **resume**, **abort** or **quit** instead of asking anything. The host
routes keep their record elsewhere and are not offered this: an interrupted
production, docker or trial install is continued with
`sh install.sh --route <r> [--instance <i>] --resume` (`sudo` on production), or
undone with `--abort` the same way, and a fresh interactive run over it is
refused once its screens are answered. Abort asks
you to type the database name back (it resets that database to empty), and
asks the database password only when the reset needs it and neither the
environment nor the install's `.env` supplies it — the same rules as
[`--abort`](#undoing-an-install-abort).

### The full-screen installer

At a capable terminal the screens are drawn full-screen: a header with the
release (its git tag: `7.0.1`, `7.0.0-beta.7 (prerelease)`, or
`7.0.1-dev (development build)` for a commit with no release tag) and the route you picked, a left rail of the route's steps (`✓` done,
`›` current, `·` still to come), the current step in the middle, and the keys
it takes at the bottom. The Welcome and Done screens show the Dédalo logo when
the terminal has at least 30 rows.

It is used when standard input and standard output are both terminals, `TERM`
is set and not `dumb`, the terminal is at least 80×24, and you did not pass
`--plain`. Anything else gets the [plain mode](#plain-mode) — the same
questions, the same answers, the same install. Between 80×24 and roughly
104×30 the layout tightens (a compact rail of numbers, shorter descriptions);
if you shrink the window below 80×24 while it runs, the installer asks you to
enlarge it and keeps your place (no key answers a question you cannot see;
Ctrl-C still stops). `NO_COLOR` keeps the full screen, in your
terminal's own colours.

If the full-screen interface cannot start — the terminal library has no native
build for this machine — the installer prints one line and continues in plain
mode:

```text
full-screen UI unavailable (<reason>) — continuing in plain mode
```

On a musl-based Linux (Alpine) set `OPENTUI_LIBC=musl` before running the
installer so the musl build of the terminal library is chosen; without it the
glibc build is tried, fails, and you get the plain mode. Use `--plain` with a
screen reader.

| Where | Keys |
| --- | --- |
| Anywhere | **Ctrl-C** stops the installer (exit `130`); **Ctrl-Q** asks "Quit?" (exit `0`; an unfinished install is kept for `--resume`); **F1** help (or **?** where you are not typing); **Esc** back to the previous step |
| A text or password field | **Enter** or **Tab** continue; **Shift-Tab** the previous question of this step; ←→, Backspace, Ctrl-U (clear), Ctrl-W (delete a word) edit; **Ctrl-D** stops (exit `130`). A pre-filled default is drawn dim: the first character you type replaces it, Enter keeps it, an editing key (←→, Backspace) edits it |
| A choice | ↑↓, PgUp/PgDn, Home/End move; **Enter** chooses. On the first screen the cursor starts on **Production**, the route recommended for a museum: move it to yours |
| An acknowledgement (the trial's missing media protection, no thesaurus, a connection kept untested) | **Space** ticks *I understand*, or type `yes`; **Enter** continues — unticked, Enter declines |
| A list (ontologies, thesauri, languages) | type to filter; ↑↓ move; **Space** ticks or unticks; **/** starts a new filter; **Esc** clears the filter, then goes back; **Enter** continues |
| A failed check | **r** retry, **e** edit the answers, **y** keep them untested (where allowed), **q** quit; a failure no fix on this machine can change (an unsupported system) offers only **q** — or **Esc**, back to choose another route |
| The Review | **Enter** install (then type `yes`); when install is not offered, **Enter** checks again and, the cause fixed, asks for `yes`; **e** + a step number edit it, **w** + a path write an answers file, **Esc** edit the last step, **Ctrl-Q** quit |
| The install | **l** shows the full log; **Ctrl-C** stops — resume later |
| Done | **Enter** or **q** closes; Ctrl-C closes too, with the install's own exit code |

The screens are the steps listed above, plus:

- **Lists** show what each entry declares (`also installs …`, `needed by
  rsc`), `declined` for a dependency you unticked, and `Empty — you fill it`
  for a thesaurus that ships only its definition. A locked entry says why
  instead of unticking.
- **Passwords** are drawn as `•`, typed twice; the root password's policy rules
  are listed neutral (`·`) until you type, then turn from ✗ to ✓ — the password
  itself is never drawn.
- **Checks** show their result in place; a failed one offers retry / edit /
  keep untested / quit. A check that passes on a screen without questions — the
  System check — moves on by itself; its result stays visible under the next
  screen, headed by the check's name: every row when the check is short (the
  docker and trial check — Docker, Compose, the free disk), else its warnings,
  failures and verdict (the `ok` rows of a long check stay on its own screen). A screen whose check failed is marked `✗` on the
  step rail, never `✓`.
- **Yes/no switches** take `y` or `n` (or ←→, Space) and move on only with
  Enter, so a key pressed after the answer never lands on the next screen.
- **The Review** shows what will happen, any errors, and the equivalent command
  line (no secret in it).
- **Install** lists every step with its state (`◐` running, `✓` done, `↷`
  verified from an earlier run, `✗` failed) and its time. Ctrl-C here stops the
  running step at once and records it failed; `--resume` runs it again later.
- **Done** shows the outcome; on a fresh install, the generated
  `DEDALO_SALT_STRING` **once** — copy it then (the mouse is not captured, so
  your terminal's own selection works; the value is also kept in the private
  `.env`, mode 0600). Whichever run completes the install shows it, a
  `--resume` in line mode included; on production, docker and trial the closing
  *To do on this host* list of every run that completes the install — the one
  that showed it, a later `--resume`, or one that could not show it on a
  terminal — names the command that reads it back
  (production: `sudo grep ^DEDALO_SALT_STRING= <install folder>/private/.env`;
  docker and trial: `docker compose … run --rm --no-deps dedalo grep ^DEDALO_SALT_STRING= /private/.env`). Then what comes next, per route: on production the
  instance is already running under systemd with its watchdog and backup timer
  armed; on docker and trial the stack is up; on developer, start the server
  under a supervisor. Thesauri, toponymies, restores and updates after the
  install are done in the browser (**Maintenance**), not here. On production,
  docker and trial the card then lists **To do on this host** — the firewall
  command, Apache's modules, the outside check, the salt's read command — the
  same list a headless or `--resume` run prints at its end, and left on your
  normal screen when the card closes. The screen stays until you press a key.

Whatever way it ends — quit, Ctrl-C, an error, a signal — the installer gives
the terminal back as it found it and prints the closing message on your normal
screen. Exit codes: `0` installed or quit, `1` refused or failed, `130`
interrupted (Ctrl-C, Ctrl-D, SIGINT), `143` terminated (SIGTERM). On the Done
screen the install is already over: Ctrl-C or a signal only closes it, and the
exit code (and the closing message, with the resume hint of a failed run) is the
install's.

**Standard input must be a terminal.** An interactive run with a piped or
redirected standard input is refused before anything is read or written —
`stdin is not a terminal — give the answers with --answers <file> (and the
secrets via DEDALO_INSTALL_* or --secrets-stdin)`. A run that carries any
answer source — an answer flag, `--answers`, `--plan`, a `--list-*` flag,
`--resume`/`--abort`, `--secrets-stdin`, `--execute` — is headless and never
needs a terminal: CI pipes `--secrets-stdin` that way, and a host route's
engine child takes `--request-stdin`.

## Plain mode

The plain line mode asks the same questions as the interactive installer, one
per line, with no screen drawing, no colour and no escape sequence of any kind —
for a screen reader, a serial console or a log. It is used when you pass
`--plain`, when `TERM` is unset or `dumb`, when standard output is not a
terminal (the questions then go to standard error, or to the terminal device),
or when the terminal is smaller than 80×24. `NO_COLOR` only turns colour off.

- Every question accepts `back` (the previous step) and `quit`; Ctrl-C and
  Ctrl-D quit too. A typed `quit` exits `0` (nothing installed), Ctrl-C /
  Ctrl-D exit `130`, and an answer refused too often (or a password whose two
  entries never matched) exits `1`. An **empty** answer takes the default shown in brackets;
  `-` empties an optional field.
- Yes/no switches show `[y/N]` or `[Y/n]`. An acknowledgement (the trial
  route's missing media protection, no thesaurus at all, a connection kept
  untested, starting the install) needs the word `yes` typed — the full screen
  takes the same typed `yes`, or Space on its *I understand* box.
- The System check prints one line per row, its state said once: `ok  <row>`,
  `warn: <row>`, `error: <row>`.
- The output carries no escape sequence, the bootstrap's included: `install.sh`
  runs its dependency install with `NO_COLOR=1 FORCE_COLOR=0` and
  `--no-progress` (no progress bar, whose cursor moves are escape sequences
  too) whenever the installer will run in plain mode.
- **Lists** (ontologies, thesauri, languages) are numbered in their groups, 20
  lines a page. Type `3`, `3-7` or `3 5 9` to toggle by number, a code (`es`)
  to toggle it, `/word` to filter and `/` to clear, `more` for the next page,
  `list` for all of them, and Enter (or `next`) to finish. A locked entry says
  why instead of toggling. Ticking an entry also ticks what it declares, as the
  flags install it: untick an optional dependency to decline it; a mandatory
  one stays while the entry that needs it is ticked. The order you tick languages in is the order they
  are written.
- **Passwords** are hidden and typed twice (three mismatches stop); after the
  first entry of the root password each policy rule is printed as `ok` or
  `missing` — never the password.
- A check (System check, database, media directory, publication, mail) holds
  only for the answers it tested: when a later answer changes them — an
  instance name that re-derives the database, a different route, the web
  server the Identity check reads — the check runs again right after the step
  that changed it (an edit from the Review: before the Review offers `install`).
  `back` from a failed check and forward again runs it again (`checking: …`),
  its rows printed once.
- After a typed `quit` the installer prints the same closing line as the
  full-screen UI (`nothing was installed`).
- Every mark is a word (`default`, `ships terms`, `definition, you fill it`,
  `needed by tch`), never a symbol.

## The answers file (`--answers`)

The answers can come from a file instead of (or beside) the flags — the shape a
provisioning tool writes. It is the plan's answers inside a versioned
envelope:

```json
{
  "schema": "dedalo.install.answers/1",
  "answers": {
    "db_database": "dedalo_main",
    "db_username": "dedalo_user",
    "entity": "myentity",
    "langs": ["lg-spa", "lg-eng"],
    "app_lang_default": "lg-spa",
    "hierarchies": ["es"],
    "diffusion": false
  }
}
```

```shell
DEDALO_INSTALL_ROOT_PASSWORD='…' bun run scripts/install.ts --answers answers.json
```

The keys it accepts are exactly the plain answers: `route`, `instance`, `db_hostname`, `db_port`,
`db_socket`, `db_database`, `db_username`, `entity`, `entity_label`,
`information`, `info_key`, `timezone`, `locale`, `langs`, `app_lang_default`,
`data_lang_default`, `diffusion`, `mysql_hostname`, `mysql_port`,
`mysql_socket`, `mysql_database`, `mysql_username`, `mailer`, `smtp_host`,
`smtp_port`, `smtp_secure`, `smtp_user`, `smtp_from`, `smtp_from_name`,
`media_path`, `unix_socket`, `media_access_mode`, `update_servers`,
`hierarchies`, `register_tools`, `ontologies`, `declined_dependencies`,
`ontology_source`, and the host answers `web_server`, `server_name`,
`http_port`, `https_port`, `tls_mode`, `tls_extra_names`, `letsencrypt_email`,
`letsencrypt_staging`, `tls_cert_path`, `tls_key_path`, `db_mode`, `backup_dir`,
`install_dir`, `service_user`, `service_group`, `backup_site_builder`, `image_source`, `image_repository`, `image_version` (and
the internal `engine_only` and `pg_bin_path`). Lists may be JSON arrays or comma strings, switches JSON
booleans — the same values the screens produce. The file goes through the same
plan, so the same answers install the same instance whichever way they arrive.

It is refused, before anything is written, when:

- the envelope is wrong — `answers file: schema must be dedalo.install.answers/1`;
- a key is unknown — `answers file: unknown key 'x'` (a typo is never ignored);
- a key is a **secret** (`db_password`, `mysql_password`, `smtp_pass`) —
  `answers file: '<key>' is a secret and is not accepted in a file — use
  DEDALO_INSTALL_* or --secrets-stdin`. Answer files get copied, mailed and
  committed;
- a key is set both in the file and by a flag — `entity is set by both --answers
  and --entity`. Neither wins silently.

The interactive Review's `write <path>` and `--write-answers <path>` produce
this file from the reviewed answers; read back, it installs the same instance.

## Secrets

Four secrets can be supplied: the root password (always required), the
database password, the diffusion (MariaDB) password and the SMTP password.
Highest precedence first:

1. **`--secrets-stdin`** — one JSON object on standard input, with any of the
   keys `db_password`, `mysql_password`, `smtp_pass`, `root_password` (an unknown
   key is refused):

    ```shell
    printf '%s' '{"root_password":"…","db_password":"…"}' \
      | bun run scripts/install.ts --secrets-stdin --db-name dedalo_main --db-user dedalo_user --entity myentity
    ```

2. **The environment** — `DEDALO_INSTALL_ROOT_PASSWORD`,
   `DEDALO_INSTALL_DB_PASSWORD`, `DEDALO_INSTALL_MYSQL_PASSWORD`,
   `DEDALO_INSTALL_SMTP_PASSWORD`. The installer removes them from its own
   environment as soon as it has read them, so no program it starts inherits
   a `DEDALO_INSTALL_*` variable. The database password does reach the `psql`
   programs the installer starts (they need it to connect); the root, SMTP and
   diffusion passwords reach none.
3. **The command line** — `--root-password`, `--db-password`,
   `--mysql-password`, `--smtp-password`. Still accepted, each with the warning
   `⚠ <flag> on the command line is visible to other users (ps); use
   DEDALO_INSTALL_* or --secrets-stdin`.
4. **Typed at the prompt** — on a terminal, without `--execute`: the root
   password of a fresh install, the secrets a `--resume` still needs, and every
   password the [interactive installer](#interactive-mode) asks. Hidden, typed
   twice.

The interactive installer's connection checks run in a separate short-lived
process; the one password a check needs is handed to it on its standard input,
never on its command line or in its environment.

No secret is ever written to the plan or state files, and none is printed: every
line the installer prints and every message it records has the supplied secrets
replaced by `***`. The one secret the installer **generates**,
`DEDALO_SALT_STRING`, is written to `.env` and printed **once**, in the summary
at the end of the run that completes the install
(`generated DEDALO_SALT_STRING = …`) — a fresh run, or the `--resume` that
finishes it. Keep it with your backups. It is shown only on a terminal and never
written into a log: when no run could show it there (its output redirected to a
file), the end of the run prints the command that reads it back instead —
`sudo grep ^DEDALO_SALT_STRING= <install folder>/private/.env` on production,
`docker compose -f <stack file> -f compose.override.yaml --env-file .dedalo.env run --rm --no-deps dedalo grep ^DEDALO_SALT_STRING= /private/.env`
on docker and trial, `<private>/.env` (`0600`) on developer.

## Validation before anything is written

Every refusal an answer can earn is raised by the plan, before the database is
touched and before any file is written — the same refusal whether the answers
come from flags, an answers file or the interactive screens:

| Answer | Rule | Refusal |
| --- | --- | --- |
| `db_database`, `db_username`, `entity` | present (`db_username` not on a production install that creates its database: it is the service user) | `<key> is required` |
| `install_dir`, `service_user`, `service_group` | production only | `<key> is only meaningful on the production route (route is <r>)` |
| `install_dir` | a normalized absolute path of two levels or more, plain segments (letters, digits, `.`, `_`, `-`), not a system location (`/etc`, `/usr`, `/run`, `/tmp`, `/root`… or exactly `/home`, `/srv`, `/opt`, `/var`, `/var/lib`, `/var/www`) | `install_dir must be an absolute path`, `install_dir '<v>' must be a normalized absolute path of at least two levels …`, `install_dir '<v>' may contain only letters, digits, '.', '_' and '-' in each segment`, `install_dir '<v>' is a system location (<p>) — choose a folder of its own, e.g. /home/ded_<i>` |
| `install_dir`, `backup_dir` | outside `/opt/dedalo`, `/var/lib/dedalo-install`, `/var/backups/dedalo-site-builder`, `/srv/dedalo`, `MEDIA_PATH`'s web root and the socket's directory | `<key> '<v>' overlaps <place>, which the installer keeps root-owned or serves to the web — choose a folder outside it` |
| `service_user`, `service_group` | a Linux name: `a-z` or `_` first, then `a-z`, `0-9`, `_`, `-`, `.` (32 at most); never `root` | `service_user '<v>' is not a valid Linux user name (…)`, `service_user root is refused — the service never runs as root` |
| `db_username` (production, `--db-mode create`) | equals the service user (peer authentication) | `with db_mode create the database role is the service user (…): db_username '<v>' must be '<service user>' — omit --db-user` |
| `entity` | a letter, then letters, digits or `_` | `entity '<v>' must start with a letter and contain only letters, digits and _` |
| `db_port`; `mysql_port` (with `--diffusion`); `smtp_port` (with `--mailer`) | an integer 1–65535 | `db_port '<v>' must be an integer 1-65535` |
| database and MariaDB host, name, user | no leading `-`, no control character | `db_database: looks like a command-line option` |
| `db_socket` | an absolute directory | `db_socket: …` |
| `media_path`, `unix_socket`, `mysql_socket` (with `--diffusion`) | absolute, when given | `media_path must be an absolute path` |
| `smtp_host` (with `--mailer`) | present | `mailer requires smtp_host` |
| `smtp_secure` (with `--mailer`) | `tls`, `ssl` or `none` | `smtp_secure must be tls\|ssl\|none` |
| `mysql_username` (with `--diffusion`) | present (the publication database has a default: `web_dedalo`, `web_<instance>` on production) | `diffusion requires mysql_username` |
| `route` | `production`, `docker`, `trial` or `developer` | `route must be production\|docker\|trial\|developer` |
| `instance` | required on `production`, refused elsewhere; a lowercase letter, then `a-z`, `0-9`, `_` (28 at most) | `the production route requires instance (e.g. --instance prado)`, `instance is only meaningful on the production route (route is <r>)`, `instance '<v>' must start with a lowercase letter …` |
| `media_access_mode` | `private`, `publication`, `false` (or empty) | `media_access_mode must be private\|publication\|false (or empty)` |
| `timezone` | a time zone the runtime knows (IANA name) | `timezone '<v>' is not a valid IANA time zone` |
| `locale` | a well-formed language tag | `locale '<v>' is not a valid BCP 47 tag` |
| `langs`, `app_lang_default`, `data_lang_default` | at least one language; the defaults are members of the set | `languages: …` |
| `information`, `info_key` | no line break or NUL | `information contains an illegal control character` |
| `dev_port`, `dev_host` (developer) | a port 1–65535; `127.0.0.1`, `0.0.0.0`, `localhost` or one IP address; refused on any other route | `dev_port '<v>' must be an integer 1-65535`, `dev_host '<v>' must be 127.0.0.1 (this machine), 0.0.0.0 (the local network) or one IP address of this machine`, `dev_port is only meaningful on the developer route (route is <r>)` |
| `tls_mode` (developer) | `local_ca`, `none` or `files` (with `--tls-cert` and `--tls-key`, absolute) | `tls_mode must be local_ca\|none\|files on the developer route` |
| root password | supplied (for an install), and passes the password policy | `root password is required (…)`, `root password does not meet the password policy (<rule>)` |

The thesaurus, ontology and declined-dependency refusals described above are
plan refusals too. Then the database is checked: it must exist
(`database '<db>' must exist first`), be empty
(`database '<db>' is not empty (<n> objects, e.g. …) — the installer only installs into an empty database`)
and be owned by the database user the install connects as
(`the install role does not own database '<db>' — create it with OWNER set to the install user …`):
the seed restore marks the database as this install's (its comment,
`dedalo_install_id:<id>`), which only the owner may write.

## The plan and state files

A run that passed validation and the database check records itself under
`<private>/install/` (a `0700` directory; every file in it `0600`):

| File | Written | What it holds |
| --- | --- | --- |
| `install.plan.json` | once, at the start | schema `dedalo.install.plan/1`: the plain answers, **which** secrets were supplied (true/false — never a value), the steps, the thesauri, the ontology request (each file's checksum, never a temporary path or an access code), the non-secret `.env` entries, the notes and warnings, the engine version, and a `plan_hash` over all of it |
| `install.state.json` | around every step | schema `dedalo.install.state/1`: each step's status (`pending`, `running`, `done`, `failed`), attempts, verification and redacted message; every run (fresh, resume, abort) and how it ended; what the pre-flight saw; and what the install **created** — the only things `--abort` may remove |
| `install.lock` | while a run is active | which process holds the install (released when it ends; a lock whose process is gone is taken over with a warning) |

The host routes keep a record of their own, with the same two files and the same
schemas, in a directory the engine child never writes:

| Route | Host record | Engine record |
| --- | --- | --- |
| production | `/var/lib/dedalo-install/<instance>/` (`0700`, root) | `<install folder>/private/install/` (the service user's) |
| docker, trial | `<checkout>/.dedalo-install/` (yours) | `/private/install/` inside the `private` volume |
| developer | — | `<private>/install/` |

The host record also freezes what `host_preflight` or `stack_preflight`
measured and the digest of every host step's commands: a resume runs exactly the
commands the Review showed. A production host also keeps a registry of its
instances, `/var/lib/dedalo-install/instances/<instance>.json` (`0644`, root),
which counts who uses each shared resource — see
[Several instances on one host](multi_instance.md).

Both files are **kept** after success, as the install's record. A fresh run
that finds them refuses — `an install record exists at … — resume it with
--resume, undo it with --abort --confirm-database <db>, or remove the install
directory if this private directory is being reused deliberately` — so an
install is never started over another one by accident.

## Resuming an install (`--resume`)

Any failure after the plan and state files exist ends with how to continue:

```
✖ install failed at step [install_ontologies]: <message>
  Progress saved: <private>/install/install.state.json (plan: install.plan.json)
  Fix the cause, then resume:  bun run scripts/install.ts --resume
    secrets needed again: root password (DEDALO_INSTALL_ROOT_PASSWORD or --secrets-stdin)
  Or undo this install:        bun run scripts/install.ts --abort --confirm-database <db>
```

`--resume` takes the **saved** plan: it needs no other answer. On the
**host routes** it still needs the route, and on production the instance, to
find the host record — `sudo sh install.sh --route production --instance <i> --resume`,
`sh install.sh --route docker --resume`; a bare `--resume` means the developer
route and reads `<private>/install/`. Repeating the original
command line (or part of it) with `--resume` added works too — only the answers
given are compared, and those that differ from the saved ones are refused (`answers differ from the saved plan: entity — resume
takes the saved answers; drop the flags, or --abort and start again`). A resume
by another engine version, or of a modified plan file, is refused.

For every step, in order:

- a step recorded **done** is verified again — its work must still be there (the
  `.env` written as planned, the staged files, the seed of this engine version,
  every ontology imported, the root password set, the install sealed). A done
  step whose work has gone is refused as drift
  (`step <id> was recorded done but its outcome is missing (<detail>) — something
  changed it outside the installer: put that back, then --resume; or undo the
  install with --abort and start again — that DELETES the database this install
  created …`). A step that only **starts** something — `stack_database`,
  `stack_up`, `host_first_boot` — is restartable instead: found stopped, it is
  started again (`done in an earlier run, but … — started again`). Each line
  says which it was: `done in an earlier run — verified again: <what was
  checked>`, or, for a done step with nothing to verify (a probe, the thesaurus
  import, tool registration), `done in an earlier run — nothing to re-check, not
  run again`. A **probe** after a step that ran again in this run (the stack
  started again after an `--abort`) is never only verified: it runs again in
  full, the same probes as a fresh install — on docker the media gate with its
  probe file included (`done in an earlier run, but a step before it ran again
  in this run — checked again`);
- a step left **running** or **failed** whose work verifiably landed (the
  process died after the work, before recording it) is recorded done without
  running again; otherwise it runs again. The seed restore is the exception: it
  always runs again, and decides from the database itself. The restore is one
  transaction that also marks the database as this install's, so a restore
  that was killed left the database empty and simply runs again, a committed
  one is completed, and a database that is neither empty nor marked by this
  install — a backup restored into it meanwhile, another install — is refused
  (`… is not empty (<n> objects) and was not seeded by this install — refusing to restore into it`).
  A restore whose installer was killed can stay on the database server for a
  while (its client vanished without its connection closing, as when a container
  is removed mid-restore). The restore carries this install's id in its session
  name, and every live installer holds the database's install lock, so a
  `--resume` or `--abort` that holds that lock ends this install's leftover
  restore and says so
  (`⚠ ended the seed restore an interrupted run left on '<db>' (backend pid <n>) — its installer is gone, its transaction rolled back`).
  A Ctrl-C during the restore ends it the same way before the installer exits.

Only the secrets a remaining step still needs are asked again: the database,
diffusion and SMTP passwords only while `persist_config` has not completed (after
that, the install's own `.env` holds them), the root password only while
`set_root_pw` has not. On the host routes the installer asks the engine's own
record which steps remain before it asks anything, so a resume after the engine
completed asks no secret at all. A resume runs in plain line mode (it has no
screens to walk) and asks on the terminal, hidden and typed twice. A resume that no longer has the root password says so
(`root login not re-verified …`) instead of checking the login. Resuming a
complete install checks again every done step that has a check, runs nothing,
and prints
`install already complete — every done step that has a check was verified again`.

Exit codes are unchanged: `0` done, `1` refused or failed, `130` interrupted
(Ctrl-C), `143` terminated.

## Undoing an install (`--abort`)

```shell
bun run scripts/install.ts --abort --confirm-database dedalo_main
```

`--abort` undoes, in reverse order, what the state file says the install
**created**: the database objects (the database goes back to empty — every
table, function, type, schema and extension the install added is dropped; the
extensions it already had stay), the ontology staging directory, the media tree
it created (its empty directories, bottom-up — a directory that holds a file is
kept), the other directories it created (only while still empty, the backup
directory included), the server's runtime files it created (the state file
`ts_state.json` and the session store), the `.env` (the previous one restored
from its backup, or removed when there was none) together with every backup and
`sample.env` the install wrote, and the install status. Then the plan and state
files and `<private>/install/` go.

It never drops the database itself, never touches objects that predate the
install (the install only ever started on an empty database), only resets a
database that carries this install's mark (an empty unmarked one has nothing to
reset), and refuses — before anything is touched:

- without `--confirm-database` naming the install's database, once the seed
  restore has started;
- a **sealed** install — a finished install is a live one. The one exception is
  a host route's engine child whose host attests the instance never served
  (it stopped before `host_first_boot` or `stack_up`) **and** whose database
  still holds exactly the rows the install left when it sealed: that install is
  undone like an unfinished one;
- a database that is neither marked by this install nor empty
  (`database '<db>' is not stamped by this install … — refusing to reset it; nothing was undone`);
- while another install holds the database, or another installer session is
  still working on it (this install's own leftover seed restore excepted: it is
  ended, see [Resuming an install](#resuming-an-install-resume)).

The database reset ends every other session still connected to **that
database** first — a server left running, an open `psql`, a monitoring tool —
because one of them holding a table would deadlock the reset or keep it waiting.
It never touches sessions on other databases, nor the session holding the
install lock (the abort's own). The reset is one transaction; when the server
still picks it as a deadlock victim, or a lock wait passes 30 seconds, it is
rolled back and run again, up to four times, and then refused with the reason
(`Database reset failed (rolled back; SQLSTATE …)` —
[Troubleshooting](troubleshooting.md)). A session the installer's database
role is not allowed to end (another role's, a superuser's) is named in that
line — and, when the reset completes despite it, in the result line
(`left <n> session(s) it may not end: …`).

Backups of `.env` that existed before the install (`.env.bak.*`) are never
removed — only the ones that appeared since the install started.

## Production host steps

On `--route production` the installer runs as **root** (`sudo sh install.sh …`; a
production run without root is refused with that command) and does the whole
host, as named steps with the same plan, state, resume and abort as the engine
steps. Its record lives in `/var/lib/dedalo-install/<instance>/` (`0700`, root's);
the engine steps run in ONE child, **as the instance user**, with their own
record in `<install folder>/private/install/`.

Before anything runs, the **Review lists every command each host step will run**,
exactly as it will run — the same list the run executes (a resume refuses a step
whose commands changed since). Read it: it is the whole change to the host. The same
steps, as commands and the full text of every file they write, are in
[Install by hand](manual_install.md).

| Step | What it does | What `--abort` undoes |
| --- | --- | --- |
| `host_preflight` | measures the host and **refuses**, before any change: an unsupported system (supported: Ubuntu 26.04 LTS, Debian 13, RHEL / Rocky / AlmaLinux 10 — newest releases only), no systemd, no root, nginx older than 1.25.1 (it rejects `http2 on;`), anything already under this instance's names (the database or role, `dedalo-ts@<i>` enabled or with drop-ins, the site file, the socket, the nginx upstream/zone names `dedalo_<i>` and `dedalo_<i>_api` in another file), **any instance directory that already exists** — `/srv/dedalo/<i>`, its web root, media, the backup dir (outside the install folder or inside it), `private/` — the installer never takes over a directory, so a media path under `/var/www` is refused; the install folder itself follows the [install folder rules](production.md#the-install-folder-and-the-service-account) (used as it is when it is the service user's, adopted when it is root's and empty in an operator's place), a web-server configuration it cannot read (`nginx -T`, Apache's `-S`/`-M`), the address served by another site on our ports, any of the instance's ports — 80 and 443 included — held by a program other than the chosen web server (the program is named), the other web server already installed when this run would install the chosen one beside it, another PostgreSQL major on the database port, and the institution's certificate when it does not name the address, has expired, does not pair with its key or ends at a certificate authority this machine does not trust (one expiring within 30 days is a warning). The firewall is **checked and told**, never changed — with the command that opens the instance's ports when they are closed; on Apache, which modules to enable, with the command | — (it changes nothing) |
| `host_packages` | PostgreSQL 18, the media toolchain (ImageMagick, FFmpeg, Poppler, librsvg, OCRmyPDF), the web server when missing, certbot (Let's Encrypt), the SELinux tools (EL); the repositories they need (PGDG on Debian; EPEL, RPM Fusion, PGDG and CodeReady Builder on EL) | nothing: packages and repositories are **shared host state** — told, never removed (removing a repository would leave its packages without security updates) |
| `host_identity` | the service user (created: a system account, no login shell, no skeleton files — or an existing account USED AS IS), the service group (its own, a typed one created with `groupadd`, or an existing one used as is), the install folder (`0750`; made by root only under root-owned parents, else by the service user; an empty root-owned folder under root's parents inside `/home`, `/srv`, `/data`, `/mnt` or `/media` adopted) and every directory of the instance at its mode: `private` (`0700`), backups, `/srv/dedalo/<i>` (media at `0750`, never world-readable) — everything inside the folder made by the service user — and the root-owned `/opt/dedalo/…` (a shared one that exists is used as it is, never re-moded). The System check before it refuses another instance's user, group or folder (and an account in another instance's group), a system account, a package's account, a privileged group and a folder it may not use; an account that appeared since (a package made it) is refused here, never recorded as created | as the service user, what the install left in the folder and the empty media tree it made under `/srv/dedalo/<i>`, then the folder it created (an adopted one gets its owner and mode back); the user and group only when it created them — never an existing account — after removing, as that user, its own entries at the top of `/tmp` and `/var/tmp` (Bun's leftovers), and not while the user runs processes or still owns a file (`user <u> KEPT: it still owns <path> …` — a removed uid could be reused and read them) |
| `host_runtime` | Bun at the release's pin, **root-owned** in `/opt/dedalo/bun/<pin>/` — only from a zip whose sha256 equals the release's committed `.bun-sha256` (the bootstrap's verified cache), and left as it is when the installed copy is byte-identical; the release extracted into `<install folder>/dedalo` by the service user (`git archive` of a checkout runs with `-c safe.directory=<checkout>`: root reads the operator's checkout); its dependencies installed as the instance; the root-run scripts copied root-owned to `/opt/dedalo/instances/<i>/bin` | the release and scripts; Bun when no other instance uses that pin |
| `host_database` | `--db-mode create`: the role named like the service user (LOGIN, **no password** — peer authentication over the local socket) and the database `dedalo_<i>` it owns (UTF8, from `template0`), with `CONNECT` and `TEMPORARY` revoked from `PUBLIC` and granted to that role alone; then checks the instance reaches it by peer and the three extensions are available. `existing`: nothing | only what it created, only with `--confirm-database`, only an empty database |
| `host_engine` | the engine steps (seed, ontologies, thesauri, tools, root password) in one child as the service user: `setpriv --pdeathsig KILL -- runuser -u <user> -g <group> -- setpriv --pdeathsig KILL -- /usr/bin/env HOME=<install folder> <bun> run scripts/install.ts --request-stdin --execute --events-jsonl` (`setpriv` at both ends of `runuser`, which forks: the child dies with the installer, never left running unsupervised; `runuser` resets `HOME` to the account's home, `env` sets it back to the install folder) — answers and secrets as ONE JSON object on its standard input. A resume refuses while an earlier run's child still holds the install | the child's own `--abort`: it refuses a sealed install, unless the instance never served (its unit never ran) and the database is unchanged since the seal |
| `host_units` | the shared template units (`deploy/systemd/*@*`) and this instance's drop-ins; `dedalo-ts@<i>` enabled (not started, the watchdog **not** armed) | the drop-ins; the templates when no other instance uses them |
| `host_selinux` | RHEL family, SELinux enforcing or permissive: the file contexts (the socket directory — in the spelling the host's policy accepts, `/run/dedalo-<i>(/.*)?` on RHEL 10, read from its `file_contexts.subs_dist` equivalences —, `/srv/dedalo/<i>`, the ACME root), the `dedalo_engine` policy module (`deploy/selinux/dedalo_engine.cil.tpl`, priority 400) and `restorecon -F` on the runtime. The module gives the engine its own domain — systemd starts the pinned runtime, labelled `dedalo_engine_exec_t`, into `dedalo_engine_t` — and lets the web server connect to the unix sockets of that domain **only**, never another service's. No boolean is changed | the contexts this install added (a rule defined before it is kept); the module when no other instance uses it |
| `host_first_boot` | starts `dedalo-ts@<i>`, waits for `/health` on its socket and for **every** migration to be recorded; under SELinux, refuses an engine not running in `dedalo_engine_t` | stops it |
| `host_watchdog` | arms `dedalo-ts-watchdog@<i>.timer` — only now, after the first boot completed (a watchdog armed earlier killed a first boot mid-migration) | disarms it |
| `host_web_http` | Let's Encrypt only: the plain-HTTP site (the HTTP-01 challenge root and the redirect) | the site file |
| `host_tls` | Let's Encrypt: `certbot certonly --webroot` and the renewal timer. Local CA: `deploy/dedalo-tls-rotate.sh --mode local-ca` (the root-owned copy in `/opt/dedalo/instances/<i>/bin/`) into `/opt/dedalo/instances/<i>/tls/`, then `dedalo-tls-renew@<i>.timer` (renews from the same authority, reloads the web server). Files: the institution's certificate checked again (never copied, never changed) | a certificate it issued; the local CA's timer, drop-in and directory (when it made it) |
| `host_web_site` | the full site file (HTTPS, the media gate, the client), configuration test, reload — see [The site file](#the-site-file). A failed configuration test puts the files back as they were (the web server is never left with a configuration it would refuse) | the site file, the rule copies, the web user's group membership |
| `host_public_probe` | `/health` through the public address (connecting locally, the chain verified), and the media gate: the marker store and an unpublished file both answer 404 — polled for up to 90 s while the reload settles | — |
| `host_backup_verify` | runs the backup set once and verifies **every** store succeeded and the unit carries the full expected store list (the site-builder store, when asked for, in its own root unit `dedalo-backup-site-builder@<i>` — never beside the instance's `.env`); then enables the nightly timer | the timer (the backups are kept) |

!!! warning "Enabling Apache modules is yours"
    The installer **checks** the modules Apache needs (`ssl headers http2 rewrite
    proxy proxy_http`) and, when one is missing, stops with the exact command
    (`a2enmod … && systemctl restart apache2` on Debian/Ubuntu — a restart, as
    `a2enmod` itself advises: loading a module is a process change); run it, then
    `--resume`. On Debian and Ubuntu the Review says so first, in its *To do
    yourself* block — even when the installer installs Apache itself. It
    never enables a module, edits global configuration or another site — a
    restart applies every pending change of the web server's configuration.

### The site file

ONE file for this instance — `/etc/nginx/conf.d/dedalo-<i>.conf`, or the Apache
vhost (`sites-available/dedalo-<i>.conf` + `a2ensite` on Debian/Ubuntu,
`/etc/httpd/conf.d/dedalo-<i>.conf` on EL). Every name in it is the instance's own
(the nginx upstream, rate-limit zone and log files), so instances never collide.
Its `root` is `/srv/dedalo/<i>` — so `/dedalo/media/…` is `MEDIA_PATH/…` — and the
client is the engine's published copy under `/srv/dedalo/<i>/client`.

nginx never includes a file the instance can write: the media rules the engine
generates in `MEDIA_PATH` are copied — **validated** line by line against the
forms the engine writes, root-owned — to `/etc/nginx/dedalo/<i>/` by
`/opt/dedalo/instances/<i>/bin/dedalo-media-rules.sh`, and the site includes the
copies. After you change the media access mode, refresh them (the installer
prints this command on Done):

```shell
sudo /opt/dedalo/instances/<i>/bin/dedalo-media-rules.sh --source <MEDIA_PATH> \
  --dest /etc/nginx/dedalo/<i> --reload /usr/sbin/nginx nginx
```

A copy that fails the test of the nginx configuration is put back. The media map's
variables are global to nginx, so ONE instance's map copy is included host-wide
(`/etc/nginx/conf.d/dedalo-00-media-map.conf`); an instance whose map differs
(another release) is refused — keep same-host instances at the same release. On
Apache the media `.htaccess` is the gate: the vhost allows only the overrides it
uses (`AuthConfig FileInfo Options=Indexes,ExecCGI`, never `All`) and turns
listing and CGI off again after it.

### What changes after the install

The installer installs; it does not maintain. A fresh run refuses a host whose
instance record exists, the engine refuses a sealed private directory, and
`--abort` never takes a completed install apart. So:

- The root-run scripts in `/opt/dedalo/instances/<i>/bin` are not refreshed by an
  in-app code update, which runs as the instance. There is no installer command
  that refreshes them on a live instance today.
- Bun is root-owned at the release's pin. The code update panel refuses a release
  whose pin differs from the running runtime, and there is no installer command
  that installs a new pin on a live instance today.
- The watchdog and the rollback units use the code-backup root
  `<install folder>/backups/code` (pinned in the units' drop-ins, never read from the
  instance's `.env`); the rollback's file work runs as the instance user.
- On a **live** instance — one that has served: its unit has run (`host_first_boot`
  started it, or `--abort` measures that systemd ran it or the engine answers) —
  `--abort` undoes only the host steps after `host_engine` — the units' start,
  SELinux, the watchdog, the site, the certificate, the backup timer — and keeps
  the instance, its user, database and code; `--resume` puts the undone steps
  back, and a second `--abort` says *nothing was undone*. Before it served, even
  after the engine completed, `--abort` undoes everything this install created,
  its database included. A served instance is removed by hand:
  [Removing an instance](multi_instance.md#removing-an-instance).
- `--abort` asks for `--confirm-database <db>` BEFORE it undoes anything that
  touches the database (the engine's own reset included); without it nothing is
  undone.

## Docker and trial host steps

`--route docker` (the full stack: TLS and the media gate) and `--route trial`
(the simple stack: plain HTTP and **no media protection** — any media file is
served to anyone with its URL; evaluation only) run as **you**, the operator,
from the checkout. Docker Engine and its Compose plugin must be installed — the
installer tells you how when they are not, and never installs them.

| Step | What it does |
| --- | --- |
| `stack_preflight` | refuses: Docker missing, Compose older than 2.24.4 (the installer's `compose.override.yaml` uses its `!override` tag), the daemon unreachable for this user, under 8 GiB free, an existing instance (`dedalo_private` volume), leftover stack files of an earlier install, an image version that is not the installer's own, an official image without cosign, an official image the registry does not publish for this release (asked for the installer's own release tag, `7.0.0-beta.7` for a beta; a registry that cannot be reached is not refused, the Review says it could not be checked) or any official image for a development build (`--image-source build`), the institution's certificate when it does not check out — another address, expired, another key, or a chain this machine does not trust. A resume refuses while an earlier run's engine container (`dedalo-install-engine`) still runs |
| `stack_image` | pulls the image (or builds it here, `--image-source build`, from a clean snapshot of the checkout's last commit through `deploy/dedalo-image-build.sh` — a first build takes about 2 to 6 minutes on 2 CPUs, longer on a slow network or disk; its build steps printed as they start); an official image's **signature** is verified with cosign over the ONE digest it carries, and its version label must equal its tag. The verified digest is pinned: a re-pull between verify and run is refused |
| `stack_tls` | Let's Encrypt (certbot standalone), a local CA (`deploy/dedalo-tls-rotate.sh`, every `--server-name` / `--tls-extra-names` address a `--host`), or the institution's files copied into `deploy/certs` |
| `stack_files` | `.dedalo.env` (`0600`, with a **generated** database password that is never shown), `compose.override.yaml`, and the full stack's site (`deploy/nginx.docker.generated.conf`) |
| `stack_database` | starts PostgreSQL and waits for it |
| `stack_engine` | the engine steps inside the container: `docker compose … run --rm -T dedalo bun run scripts/install.ts --request-stdin --execute --events-jsonl` — answers and secrets on its standard input, never `-e` (an environment value shows in `docker inspect`) |
| `stack_up` | starts the engine, waits for `/health`, then the rest — and waits up to 30 s for nginx to run with a stable restart count and a configuration `nginx -t` accepts (a refused one quotes nginx's `[emerg]` line and is not recorded done) |
| `stack_health` | `/health` on the engine's socket inside its container, then through the published address (nginx); docker: the media gate answers 404 to an anonymous visitor; trial: Done says there is no media protection and that a browser opens `http://<this machine's address>/dedalo/` |

Every compose command carries `-f <stack> -f compose.override.yaml --env-file
.dedalo.env` — the same files `deploy/dedalo-image-lib.sh` hands compose, so the
image updater and your own commands drive the stack the installer built. Its
record is `<checkout>/.dedalo-install/`.
`sh install.sh --route docker --abort --confirm-database dedalo` (`--route trial`
for a trial) stops the stack and removes only the volumes and files this install
created, and says which images it keeps (with the `docker image rm` command).
Once the stack has served — its `dedalo` container started (`stack_up`'s `up -d
dedalo` returned, or `--abort` measures that the container ever started or the
engine answers) — an abort undoes only `stack_up` — it removes the containers it
started (`dedalo`, `nginx`, `backup`, `certbot` with Let's Encrypt) and leaves
PostgreSQL running — and keeps the data; `--resume` starts the stack again. A run
stopped inside `stack_up` before that container ever started has not served:
`--abort` removes everything this install created, its database included.

## `install.sh`, the bootstrap

```shell
sh install.sh [--release <file|https-url> --release-sha256 <sha256>] \
              [--offline-bun <bun zip> [<SHASUMS256.txt>]] [--mirror <https base url>] \
              [--] [installer arguments…]
```

`install.sh` only gets the installer running: a Linux host (glibc, x86_64 or
aarch64) for every route, or a Mac (Apple silicon or Intel) for the docker and
trial routes with Docker Desktop — its Bun checked against the release's
`.bun-sha256-darwin`, the same signed payload's macOS rows; the release — the checkout it sits in, or `--release`, an archive whose
sha256 must equal `--release-sha256` (there is no "confirm on the terminal"
instead); Bun at the release's pin, its zip checked against the release's
committed `.bun-sha256` and Bun's own `SHASUMS256.txt` (both must agree), cached
and re-hashed on every reuse; the installer's dependencies; then
`exec bun scripts/install.ts <your arguments>` — your arguments and your
terminal reach the installer unchanged. Exit `3` is a refusal of the bootstrap
itself: an unsupported kernel or CPU, a musl libc, a release whose sha256 does
not match, or a Bun zip that does not match the release's hash table.

The bootstrap's cache is `/var/lib/dedalo-install` when run as root, otherwise
`${XDG_CACHE_HOME:-~/.cache}/dedalo-install`. Production needs root.

Under `sudo` the bootstrap keeps root out of your files:

- `--route production` on a Linux system the production route does not support
  is refused **first**, before anything is downloaded (the same sentence as the
  System check's).
- In a checkout that is not root's, the installer's dependencies are installed
  **by the checkout's owner** (`runuser`), with a root-owned `0755` copy of the
  verified Bun (`/var/lib/dedalo-install/bun-shared/<pin>/bun`) — root never
  writes in your checkout.
- In root's own tree (a staged `--release`), Bun's package cache goes to
  `/var/lib/dedalo-install/bun-install-cache`, never `/root/.bun`.

When the installer will run in plain mode (`--plain`, `TERM` unset or `dumb`, or
standard output not a terminal), the dependency install runs with
`NO_COLOR=1 FORCE_COLOR=0` and `--no-progress`, so no escape sequence reaches
the output.

### Running the installer without `install.sh`

`bun run scripts/install.ts` needs the checkout's dependencies: run `bun install`
in the checkout first ([developer quickstart](dev_quickstart.md), step 3). Without
`node_modules` the installer refuses with exit `3`, writes nothing, and says so.
It never installs them itself; `sh install.sh` does, before it starts the installer.

## What `../private/.env` does — and does not — get

**The installer rewrites the keys it owns** and keeps every other key already in
the file: those are carried over verbatim, in a section headed *Preserved from the
previous .env*. The previous file is kept as `.env.bak.<timestamp>`. The keys it
owns are these:

| Section | Keys |
| --- | --- |
| Database | `DB_NAME`, `DB_USER`, `DB_PASSWORD`, `DB_HOST`, `DB_PORT`, `DB_SOCKET` |
| Entity / locale | `ENTITY`, `DEDALO_ENTITY_LABEL`, `DEDALO_TIMEZONE`, `DEDALO_LOCALE` |
| Languages | `DEDALO_APPLICATION_LANGS`, `PROJECTS_DEFAULT_LANGS`, `DEDALO_APPLICATION_LANGS_DEFAULT`, `DEDALO_DATA_LANG_DEFAULT`, `APPLICATION_LANG`, `DATA_LANG`, `DEDALO_STRUCTURE_LANG` |
| Secret | one generated secret, printed once |
| Update servers | `ONTOLOGY_SERVERS`, `CODE_SERVERS` — the official master by default, `[]` with `--no-update-servers` |
| Ontologies | `ACTIVE_ONTOLOGY_TLDS` — the core, the chosen domain ontologies and the ontologies they declare (minus declined optional ones), in install order; rewritten on every run |
| Serving / media *(each only when it has a value: on production, docker and trial the [route defaults](#route-defaults) give `MEDIA_PATH` and `SERVER_UNIX_SOCKET` one; on developer only `--media-path` / `--socket` do)* | `MEDIA_PATH`, `SERVER_UNIX_SOCKET`, `DEDALO_MEDIA_ACCESS_MODE`, `DEDALO_PG_BIN_PATH`, `DEDALO_BACKUP_DIR` (production: `<backup dir>/db`, the directory the backup units write) |
| Diffusion *(only with `--diffusion`)* | `DEDALO_DIFFUSION_NATIVE`, `DEDALO_DIFFUSION_DB_*` |
| Outbound email *(only with `--mailer`, or the installer's optional *Mail* screen)* | `DEDALO_SMTP_HOST`, `DEDALO_SMTP_PORT`, `DEDALO_SMTP_SECURE`, `DEDALO_SMTP_USER`, `DEDALO_SMTP_PASS`, `DEDALO_SMTP_FROM`, `DEDALO_SMTP_FROM_NAME` |
| Development only *(the developer route only — no other route writes any of these)* | `SERVER_TCP_PORT`, `SERVER_TCP_HOST`, `SERVER_TCP_TLS_CERT_FILE`, `SERVER_TCP_TLS_KEY_FILE` (none with `--tls none`), `SESSION_COOKIE_SECURE` (`true` over HTTPS, `false` over plain HTTP — always rewritten to match the listener), `DEDALO_DEV_MODE=true`, `DEDALO_DEBUG_API_ERRORS=true`. A re-run that does not answer them keeps the port, address, certificate pair and modes the file already has; `--tls none` over a kept pair writes both certificate keys empty |

### The update servers

By default both keys name the official Dédalo master:

```dotenv
ONTOLOGY_SERVERS=[{"name":"Official Dédalo Ontology server","url":"https://v7.master.dedalo.dev/dedalo/core/api/v1/json/","code":"x3a0B4Y020Eg9w"}]
CODE_SERVERS=[{"name":"Official Dédalo code server","url":"https://v7.master.dedalo.dev/dedalo/core/api/v1/json/","code":"x3a0B4Y020Eg9w"}]
```

`ONTOLOGY_SERVERS` is where ontology updates come from; `CODE_SERVERS` is where
the [code update panel](../management/updates/updating_code.md) looks for releases.
`--no-update-servers` (answering *no* to the interactive installer's
update-server question) writes both as `[]` — an air-gapped install that is never
offered an update. To change your mind later, replace the `[]` values of
`ONTOLOGY_SERVERS` and `CODE_SERVERS` in `.env` with a server list, then restart
the server: the list, and the browser's `connect-src` that lets the update panels
reach a master, are built at boot.

When the installer writes `.env` over an existing one in the same private
directory (an unfinished install, or a fresh install into a reused private
directory), keeping the official default does not overwrite a key whose value is
a non-empty list — mirrors you added survive — and a key holding `[]` is replaced
by the official server. Choosing the air-gapped option always writes `[]`.

!!! note "The installer never writes `DEDALO_SUPERVISED`"
    Whether the server runs under a supervisor is a property of how it is
    **launched**, so it is declared by the systemd unit, the compose stack or the
    `bun run` script — never in `.env`, where the engine ignores it. See
    [Updating the code](../management/updates/updating_code.md).

!!! danger "The operational tuning is yours to append — afterwards"
    The **pool settings, the timeouts and the access log** are not written by the
    installer. Append them once the install has finished,
    then restart the server. (`MEDIA_PATH`, `SERVER_UNIX_SOCKET` and
    `DEDALO_MEDIA_ACCESS_MODE` **are** written — pass `--media-path`, `--socket` and
    `--media-access-mode`.)

    A key you add by hand survives the installer, before or after, as long as the
    installer does not own it: it is carried into the *Preserved* section. Every key
    is written in the configuration reference's own spelling (`DB_NAME`, `ENTITY`,
    …). The older fallback spellings the engine still accepts from a `.env` carried
    over from v6 or from an earlier installer (`DEDALO_DATABASE_CONN`,
    `DEDALO_ENTITY`, …) count as the same key: the installer drops them and writes
    the value once, under the current name — `DEDALO_SOCKET_CONN` included, which is now
    the old spelling of `DB_SOCKET`.

The file is written through a two-phase commit (staged, then renamed into place)
at mode `0600`, inside a `0700` private directory.

??? tip "Relocating the private directory"
    Set **`DEDALO_PRIVATE_DIR`** to an absolute path and the whole private tree
    moves — `.env`, the session store, the state file, the backups. Both the
    configuration **read** side and the installer **write** side honour it, so
    the two never disagree. This is what makes a container image possible: an
    image has no writable parent directory above the repo. See
    [Docker](docker.md).

## A server that is not installed refuses to start

There is no install page. Before it opens a socket, touches a database or writes a
file, the server checks whether this box is installed, and if it is not it prints
one line and exits with code **78**:

| What it found | What it prints (after `[boot] REFUSED — `) |
|---|---|
| none of `ENTITY`, `DB_NAME`, `DB_HOST`, `DB_USER`, and no `.env` | `not installed: … Run the installer: sh install.sh (sudo sh install.sh for production), or bun run dedalo:install in a checkout` |
| none of the four, but a `.env` with other content | `configuration incomplete: … do not reinstall over an existing configuration` |
| none of the four, on a sealed install | `configuration missing: … Restore .env from backup — do not reinstall over it` |
| an install that has not finished (see [the state file](#the-state-file)) | `install not finished … finish it with the installer's --resume (production: sudo sh install.sh --route production --instance <i> --resume; …)` |

The shipped systemd units do not restart a server that exits 78
(`RestartPreventExitStatus=78`), and neither do `bun run dev` or
`bun run start:supervised`. A configuration with only some of the four keys is
a different mistake: the server names the first missing key and exits 1.

!!! warning "An unfinished install keeps the server down"
    From `persist_config` on, the state file says `terminal_installing` until the
    install is sealed. If the install dies part-way, the server will not start —
    finish it with `--resume` (or undo it with `--abort`).

## Exit codes

| Code | Who | Meaning |
| --- | --- | --- |
| `0` | installer | installed, resumed to completion, aborted, quit at a question, or a dry run (`--plan`, `--list-*`) that found no error |
| `1` | installer | refused (an answer, a check, a record) or a step failed — the message says which, and how to resume or undo |
| `3` | `install.sh` | the bootstrap refused before the installer started |
| `130` | installer | interrupted: Ctrl-C, Ctrl-D, SIGINT |
| `143` | installer | terminated: SIGTERM |
| `78` | the server | not installed, configuration missing or incomplete, or install not finished — [above](#a-server-that-is-not-installed-refuses-to-start). The shipped units do not restart it |

A step interrupted by `130` or `143` is recorded as failed; `--resume` runs it again.
An interrupt prints ONE `✖ install interrupted (…) at step […]` block: inside a
host route's engine step (`host_engine`, `stack_engine`) the engine's own stop
is an indented line under that step (`engine stopped (SIGTERM) at step
[set_root_pw]`), never a second `✖` line.

## The state file

`<private>/ts_state.json` records the **server's** install status:
`terminal_installing` while an install runs (from its `persist_config` on), then
`sealed`. Any status other than `sealed` keeps the server from starting (see
[above](#a-server-that-is-not-installed-refuses-to-start)), so no boot work ever
runs over a half-built database; an install that stops part-way is finished from
the terminal (`--resume`). The seal is also what tells a lost `.env` apart from a
fresh box. It belongs in your backups (it is part of `../private/`).

It is not the installer's own record: `<private>/install/install.state.json`
(see [The plan and state files](#the-plan-and-state-files)) tracks the steps of
one install, for `--resume` and `--abort`.

## Further reading

The developer-facing view of the same machinery — the engine modules, the
fail-closed boot, the gates — is
[the TS-native install engine](../development/ts_install_internals.md).
