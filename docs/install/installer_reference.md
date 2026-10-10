# Installer reference

> See also: [Production install](production.md) · [Dev quickstart](dev_quickstart.md) · [Troubleshooting](troubleshooting.md) · [Install internals](../development/ts_install_internals.md)

The reference for the installer itself: every flag, every step, what the seed
contains, how the domain ontologies are chosen and installed, and — the part that
surprises people — exactly which keys the installer writes into `../private/.env`
and which it does not.

Two front ends drive one engine (`src/core/install/`), and the guided container
script `install.sh` drives the headless CLI:

| Front end | Command | Use it when |
| --- | --- | --- |
| **Headless CLI** | `bun run scripts/install.ts <flags>` | servers, containers, CI. No restart, no pre-auth window. |
| **Browser wizard** | start the server with no `.env`, open `/dedalo/core/page/` | a workstation, or when you want the diagnostics panel |

!!! info "One install plan, whichever front end you use"
    The CLI, the wizard and `install.sh` all build the **same install plan**
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

The pre-flight step (`src/core/install/init_test.ts`) is a hard gate — in the
wizard it is what unlocks the *Next* button. It checks exactly four things:

| Check | Failure message |
| --- | --- |
| The Bun runtime is at least 1.3 | `Bun x.y.z is older than the required 1.3.0` |
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
bun run scripts/install.ts \
  --db-name dedalo_main --db-user dedalo_user --entity myentity \
  [--db-password '…'] [--db-host localhost] [--db-port 5432] [--db-socket /var/run/postgresql] \
  [--entity-label 'My Institution'] [--locale es-ES] [--timezone Europe/Madrid] \
  [--langs lg-eng,lg-spa] [--app-lang lg-eng] [--data-lang lg-eng] \
  [--hierarchies default|none|es,fr] \
  [--ontologies default|oh,tch] [--ontology-source <dir|archive>] \
  [--decline-dependencies tchi,ts:hierarchy1] \
  [--media-path /srv/dedalo/media] [--socket /run/dedalo/dedalo_ts.sock] [--media-access-mode publication] \
  [--diffusion --mysql-name web_dedalo --mysql-user d --mysql-password '…'] \
  [--mailer --smtp-host smtp.example.org --smtp-user dedalo@example.org --smtp-password '…'] \
  [--no-update-servers] [--skip-tools] [--plan | --list-ontologies]
```

An **unknown flag is refused** (`unknown flag --x`) and so is a value flag with no
value after it (`--x needs a value`) — a typo never silently falls back to a
default. (`--yes` is gone: the CLI never asked anything, so it never had a
meaning.)

| Flag | Required | Default | Notes |
| --- | --- | --- | --- |
| `--db-name` | **yes** | — | the **empty** database you created |
| `--db-user` | **yes** | — | the role that owns it |
| `--entity` | **yes** | — | this instance's identifier, e.g. `myentity` |
| root password | **yes** | — | `DEDALO_INSTALL_ROOT_PASSWORD` in the environment, or `--root-password` |
| `--db-password` | no | *(empty)* | empty means peer/trust auth over a local socket |
| `--db-host` | no | `localhost` | a hostname, **or a unix-socket directory** when it starts with `/` (the default used to be `/tmp`; Debian/Ubuntu and RHEL do not put the PostgreSQL socket there) |
| `--db-port` | no | `5432` | |
| `--db-socket` | no | — | a PostgreSQL unix-socket directory, e.g. `/var/run/postgresql`; written as `DB_SOCKET`. When given it **wins** over `--db-host`: the connection test, the server and the backups all connect through it. Must be an absolute path |
| `--entity-label` | no | the entity name | shown on the login form |
| `--locale` | no | `es-ES` | |
| `--timezone` | no | `Europe/Madrid` | every database timestamp is stamped in it |
| `--langs` | no | `lg-eng,lg-spa` (the other catalogue languages are optional) | the installation's languages — interface **and** data — comma list, e.g. `lg-eng,lg-spa` |
| `--app-lang` | no | first of `--langs` | the default interface language |
| `--data-lang` | no | first of `--langs` | the default data language |
| `--hierarchies` | no | `default` | the **optional** thesauri: `default` (the shared default set — today `es`), `none`, or a comma list of vendored codes, e.g. `es,fr`. Languages (`lg`) is a **core** thesaurus, activated with the database on every install: naming it here is dropped with a note. An unknown (not vendored) code is refused. The thesauri the chosen ontologies **declare** are added to this list: mandatory ones always (even with `none`), optional ones unless `--decline-dependencies` names them — see [Dependencies are declared, never guessed](#dependencies-are-declared-never-guessed) |
| `--ontologies` | no | `default` (= `oh`) | the **domain** ontologies, a comma list of TLDs — at least one. `default` is Oral history (`oh`), built into the release. Any other TLD comes from the ontology source, together with the ontologies it **declares** as dependencies. A core TLD is dropped with a note; `none` and an unknown TLD are refused. See [Domain ontologies](#domain-ontologies) |
| `--decline-dependencies` | no | *(none)* | the **optional** declared dependencies you do not want, a comma list. Each item is a TLD (declines it as an ontology and as a thesaurus) or `<tld>:ontology35` / `<tld>:hierarchy1` (declines only one of the two). A mandatory dependency cannot be declined: naming one has no effect, and it is installed. A malformed item is refused |
| `--ontology-source` | no | *(unset)* | a local directory, or a `.tar` / `.tar.gz` / `.tgz` archive of one, in the ontology server's export layout. The non-built-in ontologies come from it instead of the update server — a fully [offline install](#offline-installs-ontology-source) |
| `--media-path` | no | *(unset)* | the media root; write-probed during install **and persisted** to `.env` as `MEDIA_PATH` (replaces the old `MEDIA_PATH=…` env prefix) |
| `--socket` | no | `/tmp/dedalo_ts.sock` | persisted as `SERVER_UNIX_SOCKET`; set `/run/dedalo/dedalo_ts.sock` for a systemd + reverse-proxy deploy (the default does not match that layout) |
| `--media-access-mode` | no | *(unset = `publication`, fail-closed)* | persisted as `DEDALO_MEDIA_ACCESS_MODE` — `private`, `publication`, or `false` to deliberately serve an open media tree |
| `--diffusion` | no | off | writes the MariaDB keys; pair with `--mysql-host/-port/-socket/-name/-user/-password`. The MariaDB connection is probed; a failure warns but does not stop the install |
| `--mailer` | no | off | writes the outbound-email (SMTP) keys, enabling [password recovery](../management/password_recovery.md); requires `--smtp-host`, pair with `--smtp-port` (587), `--smtp-secure` (`tls`\|`ssl`\|`none`), `--smtp-user`, `--smtp-password`, `--smtp-from`, `--smtp-from-name`. The relay is probed (connection + auth, no email sent); a failure warns but does not stop the install |
| `--no-update-servers` | no | off | air-gapped install: writes `ONTOLOGY_SERVERS=[]` and `CODE_SERVERS=[]`, so no ontology or code update is ever offered. Without it, both name the official Dédalo master (see below) |
| `--skip-tools` | no | off | skips tool registration (register them later from the Development Area) |
| `--plan` | no | off | dry run: prints ONE JSON line — `env_keys`, `steps`, `hierarchies`, `hierarchy_dependencies`, `ontologies`, `declined_dependencies`, `ontology_source`, `ontology_install`, `active_ontology_tlds`, `notes`, `warnings`, `errors` — and exits `0` (valid) or `1`. It touches no database and no file and needs no root password. A choice beyond `oh` reads the source's catalog (one request to the update server, or the `--ontology-source` files) |
| `--list-ontologies` | no | off | prints ONE JSON line — the ontology catalog of the selected source, exactly what the wizard's *Ontologies* step shows — and exits. It needs no other answer. See [Listing the catalog](#listing-the-catalog) |
| `--information`, `--info-key` | no | `ts-install`, `ts` | free-text install provenance, recorded in the state file |

!!! danger "The root password never belongs on the command line"
    `--root-password` works, but an argv is visible in `ps` and lands in your
    shell history. Use the environment variable.

!!! tip "Check the plan before you run it"
    `--plan` validates the answers exactly as the install would, without needing
    the database:

    ```shell
    bun run scripts/install.ts --plan --db-name dedalo_main --db-user dedalo_user --entity myentity --hierarchies none
    ```

!!! warning "Languages are mandatory, and the defaults must be members of the set"
    The server refuses to boot without its language configuration. The CLI
    derives it up front and **refuses the install** if `--app-lang` or
    `--data-lang` is not one of `--langs` — better a clear refusal than an `.env`
    that crash-loops the server on the very next boot.

## What the installer does, in order

The CLI prints each plan step as `→ [<step id>] …`; the ids are the same action
names the wizard calls, which is how one plan drives both. The pre-flight before
the first step and the root-login check after the last are the CLI's own
affordances (the wizard has its *Verify* screen and in-wizard login instead).

1. **Pre-flight checks** — the four gates above.
2. **`test_db_connection`** — the database must already exist, and be empty. If it
   does not exist, the installer stops: it never creates a database.
3. **`test_diffusion_connection`** *(only with `--diffusion`)* and
   **`test_mailer_connection`** *(only with `--mailer`)* — probes that **warn** on
   failure and let the install continue.
4. **`persist_config`** — writes `../private/.env`; see the next section. Any
   previous `.env` is renamed to `.env.bak.<timestamp>`.
5. **`check_directories`** — creates and write-probes the private directory, the
   session store, the backups directory, and the media root: `--media-path` when
   given, otherwise the default `<private dir>/media` (a legacy in-tree
   `<repo>/media` that already holds files is kept instead). It then provisions
   the media tree under that root. Writability is proven by writing and deleting a probe file, not by
   reading permission bits — a network mount can lie about the bits.
6. **`stage_ontologies`** — fetches (update server) or copies (built-in `oh`,
   `--ontology-source`) every chosen domain ontology file, dependencies first,
   into the staging directory, and verifies each one (decompression and row
   format) **before the database is touched**. This is the install's only
   network phase: an unreachable server or a damaged file stops the install
   here, with the database still empty.
7. **`install_db_from_default_file`** — restores the database from the core-only
   seed (refused unless the database is empty), **then** builds the derived search
   indexes, writes the engine's own ontology nodes and **activates the core
   Languages thesaurus (`lg`)**. Its terms already ship in the seed, so activation
   is all it needs — there is no separate step for it, and nothing about it to
   choose.
8. **`install_ontologies`** — imports the staged domain ontologies through the
   same import routine the ontology update panel uses, then checks their
   references (see [Domain ontologies](#domain-ontologies)). An import failure
   **fails the install**.
9. **`set_root_pw`** — the root password, hashed with Argon2id.
10. **`install_hierarchies`** — imports and activates the **optional** thesauri (the
   shared default set unless `--hierarchies` says otherwise; `none` makes it a
   no-op), plus the thesauri the installed ontologies declare: the mandatory
   ones always, the optional ones unless declined. Each selected TLD has its vendored term data copied in, **and is then
   activated**: the hierarchy is flagged active, its virtual ontology sections
   (`<tld>0`/`<tld>1`/`<tld>2`) are provisioned, and its thesaurus tree is rooted —
   so the hierarchies you selected are browseable at the first login. Importing
   without activating leaves the terms in the database but unreachable (the section
   does not exist for the engine until its ontology does), so a TLD whose activation
   fails is a **failed** hierarchy — and a failed hierarchy **fails the install**:
   nothing is sealed (the wizard cannot get past a failed step either).
11. **`register_tools`** (unless `--skip-tools`).
12. **`install_finish`** — seals the install, refused unless a root user with a
    password actually exists. A forged *finish* can never seal a half-built
    instance.
13. **Verify the root login** — an actual login against the freshly installed
    database. This is the end-to-end proof, and it is why the CLI prints
    `✔ install complete — root login verified`.

!!! note "One default thesaurus set"
    Which optional thesauri are pre-selected is data, not code: the vendored
    descriptors in `install/import/hierarchy/hierarchies.json` flagged
    `install_checked_default`. Today that is **Spain (`es`)** alone. The CLI's
    default, `install.sh`'s `default` answer and the wizard's pre-ticked boxes all
    read that one list.

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

| Answer | CLI | Wizard | `install.sh` |
| --- | --- | --- | --- |
| which domain ontologies | `--ontologies oh,tch` (default `oh`) | the *Ontologies* step, `oh` pre-ticked | *Domain ontologies to install* (`default` = `oh`) |
| where the others come from | the update server, or `--ontology-source` | the update server | the update server |

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
  general inventory model for objects and collections; it is described in the
  wizard but not pre-ticked. When one TLD is offered by several places, a
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
- A **mandatory** dependency is always installed. It cannot be unticked in the
  wizard, and `--decline-dependencies` has no effect on it.
- An **optional** dependency is offered already ticked. Untick it in the wizard,
  or name it in `--decline-dependencies`, to leave it out:
  `the ontology 'x' (an optional dependency of 'y') is declined — not installed`.
- A mandatory ontology the source does not offer is refused before anything is
  written: `'x', declared as a dependency of 'y', is not offered by the ontology server '…'`.
  An optional one is skipped with a warning.
- A thesaurus is installed from the release's own files
  (`install/import/hierarchy/<tld>1.copy.gz`). A **mandatory** thesaurus the
  release does not ship refuses the install before anything is written:
  `the thesaurus 'x', a mandatory dependency of 'y', is not vendored (no x1.copy.gz) — it cannot be installed`.
  An optional one is skipped with a warning.
- **An older ontology server publishes no dependencies.** The installer then
  warns, names the ontology, and installs exactly what you chose — it never works
  out dependencies on its own:
  `the ontology source declares no dependencies for 'tch' (an older ontology server) — 'tch' is installed alone; anything it references in other ontologies stays unresolved`.
  Name the missing ontologies yourself (`--ontologies tch,crm,…`), or install
  them later from the update panel. The built-in `oh` of this release declares
  none yet either, so a default install warns
  `the built-in ontology.json declares no dependencies for 'oh' (a release that predates them) — …`
  and installs `oh` alone.

**After the import, the installer checks the references.** For every node of
the installed ontologies it follows the parent, the model and the related nodes.
A reference to an ontology the installation does not have is reported as a
warning — the install still completes — that names the ontology to add. For
example, `tch` installed alone from a server that declares nothing (its 15 model
references into `crm`, measured on the vendored `tch` package):

```text
⚠ 'tch' references 15 node(s) of 'crm' that is not installed (model: e.g. tch457→crm222) — install 'crm' too (--ontologies tch,crm) or ask the ontology server to declare it
```

Two kinds of reference are never reported, because a missing target is harmless
by design: a node placed *under* a node of another ontology (it simply does not
show there), and the field mappings of a publication (diffusion) definition into
another ontology. A reference into a **core** ontology that this release's seed
does not have yet means the master's core is newer than the seed; the warning
then says to run *Maintenance › Update ontology* after the install.

### Listing the catalog

`--list-ontologies` prints what the selected source offers, as the wizard
shows it — air-gapped here, so only the built-in `oh`:

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
declared thesauri and `hierarchies` every thesaurus the install will add.

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
restores each ontology's tables from its snapshot, but **nothing is sealed**, and
the remedy is the one for every step after the restore — drop and recreate the
database, then run the installer again.

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
| Serving / media *(only with `--media-path` / `--socket` / `--media-access-mode`)* | `MEDIA_PATH`, `SERVER_UNIX_SOCKET`, `DEDALO_MEDIA_ACCESS_MODE` |
| Diffusion *(only with `--diffusion`)* | `DEDALO_DIFFUSION_NATIVE`, `DEDALO_DIFFUSION_DB_*` |
| Outbound email *(only with `--mailer`, or the wizard's optional step)* | `DEDALO_SMTP_HOST`, `DEDALO_SMTP_PORT`, `DEDALO_SMTP_SECURE`, `DEDALO_SMTP_USER`, `DEDALO_SMTP_PASS`, `DEDALO_SMTP_FROM`, `DEDALO_SMTP_FROM_NAME` |

### The update servers

By default both keys name the official Dédalo master:

```dotenv
ONTOLOGY_SERVERS=[{"name":"Official Dédalo Ontology server","url":"https://v7.master.dedalo.dev/dedalo/core/api/v1/json/","code":"x3a0B4Y020Eg9w"}]
CODE_SERVERS=[{"name":"Official Dédalo code server","url":"https://v7.master.dedalo.dev/dedalo/core/api/v1/json/","code":"x3a0B4Y020Eg9w"}]
```

`ONTOLOGY_SERVERS` is where ontology updates come from; `CODE_SERVERS` is where
the [code update panel](../management/updates/updating_code.md) looks for releases.
`--no-update-servers` (answering *no* to the update-server question in the
wizard or in `install.sh`) writes both as `[]` — an air-gapped install that is never
offered an update. To change your mind later, replace the `[]` values of
`ONTOLOGY_SERVERS` and `CODE_SERVERS` in `.env` (or re-run the installer answering
*yes*), then restart the server: the list, and the browser's `connect-src` that lets
the update panels reach a master, are built at boot.

A **re-run** that keeps the official default does not overwrite a key whose
value in `.env` is a non-empty list — mirrors you added survive. A key holding
`[]` (an earlier air-gapped answer) is replaced by the official server, so
answering *yes* on a re-run switches an air-gapped install back on. Choosing the
air-gapped option always writes `[]`.

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
    `DEDALO_ENTITY`, …) count as the same key: a re-run drops them and writes the
    value once, under the current name — `DEDALO_SOCKET_CONN` included, which is now
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

## The browser wizard

Start the server on a machine with **no `../private/.env`**. It logs
`INSTALL MODE`, skips every database-dependent boot step, and serves only the
wizard at `/dedalo/core/page/`.

Steps: **Diagnostics → Database → Entity → Ontologies → *(optional)* Diffusion →
*(optional)* Outbound email → Save config** … *(restart)* … **Verify →
Directories → Install database → Root password → log in → Hierarchies → Tools →
Finish**.

The **Entity** step also collects the languages (a checkbox list with
English and Spanish pre-checked; the others are optional) plus the default
interface and data language. Before *Save config*
the wizard also asks whether to use the official update server (yes by default;
no is the air-gapped install described above).

The **Ontologies** step lists the core ontologies as fixed rows and the domain
ontologies on offer, with `oh` pre-ticked. The built-in list shows at once. When
the update server is in use, the step also reads the server's catalog and adds
its ontologies, grouped by typology; without it (or when the server cannot be
reached) only the built-in `oh` is offered. A short note describes `oh` and
`tch`. Under each ticked ontology the step lists its declared dependencies, each
with a checkbox: mandatory ones are ticked and locked, optional ones are ticked
and can be unticked. A dependency on a core ontology or thesaurus is always
installed, so it is shown ticked and locked as well. When the source declares nothing for it, the step warns
instead. At least one must be ticked.
The choice is saved with the configuration (`ACTIVE_ONTOLOGY_TLDS`), and after
the restart the **Install database** step runs three actions in a row:
`stage_ontologies`, `install_db_from_default_file` and `install_ontologies`, each
with its own status line. It stops at the first failure; reference warnings
are shown but do not block.

The **Hierarchies** step lists the optional thesauri with the shared default
pre-ticked. The thesauri the installed ontologies declare are ticked too: a
mandatory one is locked and names the ontologies that require it. The server
adds the mandatory ones even if the page does not send them. Languages is not
among them — it was activated with the database — and submitting the step with
nothing ticked is valid.

The **Outbound email** step asks whether this installation will send email —
which is what enables the login screen's
[password recovery](../management/password_recovery.md). Enable it, enter the
SMTP relay settings (host, port, encryption, credentials, From address) and the
wizard verifies the connection and authentication against the relay (no email
is sent) before letting you continue. Skipping it is safe: the keys can be
appended to `../private/.env` at any later time.

!!! warning "The wizard restarts the server after *Save config*"
    Configuration is read **once**, at boot. So *Save config* writes `.env` and
    then **exits the process** — a supervisor must bring it back up with the real
    configuration:

    - in production, that is `Restart=always` in the systemd unit;
    - in a container, `restart: unless-stopped`;
    - on a laptop with neither, start it with `bun run start:supervised` (or
      `bun run dev` while developing), or (better) just use the CLI, which needs
      no restart at all:

      ```shell
      bun run start:supervised
      ```

      Both declare `DEDALO_SUPERVISED=true` and restart the server only when it
      exits with code `75`, the planned restart; a crash still stops it, so you
      see it. Plain `bun run start` restarts nothing and is unsupervised, so the
      [code update panel](../management/updates/updating_code.md) refuses under it.

    The wizard survives the restart: the page stays open, the **Verify** button
    retries, and even a full reload resumes the wizard rather than dropping to
    the login form — until **Finish** seals the instance.

!!! danger "The install surface is pre-auth until it is sealed"
    A fresh instance has no users, so the install actions are reachable **without
    a login**. Unset, `DEDALO_INSTALL_ALLOWED_IPS` therefore admits **the local
    machine only** — installing from anywhere else means naming the address
    first:

    ```dotenv
    # comma list. Entries: `loopback` (the local host), a literal address,
    # a CIDR range, or `any` (every address — the only way to open it).
    DEDALO_INSTALL_ALLOWED_IPS=loopback,203.0.113.10,10.0.0.0/24
    ```

    The address is resolved from the trusted `X-Forwarded-For` hop, so **behind a
    proxy, `loopback` will not match** — name the real client address. A request
    that carries no such hop is treated as local, so an unsealed instance on a
    bare TCP port with no proxy in front must be closed at the firewall as well:
    the allowlist alone cannot see who is calling. The engine prints the list in
    force in its start-up log.

    Once **sealed**, the whole install surface answers `404` for good.

## The state file

`<private>/ts_state.json` records the install status: `configured` while the
wizard is mid-flight, then `sealed`. It is what makes a reload resume the wizard
instead of showing a login form, and what makes the sealed instance stay sealed
across restarts. It belongs in your backups (it is part of `../private/`).

## Further reading

The developer-facing view of the same machinery — the engine modules, the
install-mode boot, the restart mechanism, the gates — is
[the TS-native install engine](../development/ts_install_internals.md).
