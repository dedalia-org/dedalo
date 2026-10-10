# The install engine (developer reference)

> See also: [Installing Dédalo (operator guide)](../install/production.md) · [Development](index.md) · [Extending Dédalo](extending/index.md)

This page documents how the install engine works internally (DEC-19). For the
step-by-step **operator** instructions, see the
[install guide](../install/production.md); this page is for developers
working on `src/core/install/` and the install boot path.

## The engine

One engine under `src/core/install/`, driven by two frontends that share it:
the browser wizard (the byte-identical client at `client/dedalo/core/installer/`,
served in install mode) and the headless CLI `scripts/install.ts` (npm
`dedalo:install`; the container script `install.sh` drives it). The router
`engine.ts runInstallStep(rqo, context)` maps each wizard step (`options.action`)
through its `STEP_HANDLERS` table to a pure engine function and returns the
**top-level** envelope the client reads (`{result, msg, …extras}`).
`INSTALL_ROUTER_ACTIONS` is that table's key list.

## The install plan (one module, every front end)

`install_plan.ts` is the ONE place that turns raw answers into an install:
`buildInstallPlan(raw, {salt, priorEnv, ontologyCatalog})` normalizes them
(`normalizeInstallAnswers` — every default lives here and nowhere else), and
returns the `.env` sections in file order, the keys the plan owns, the ordered
step ids, the optional thesauri, the domain-ontology choice (`ontologies`, its
`ontologySource`, the deps-first `ontologyRequest` and the
`activeOntologyTlds` it writes), notes, warnings and errors. It is PURE: it
imports only `lang_catalog.ts`, `hierarchy_meta.ts` and `ontology_choice.ts`,
never `config.ts`, the database or the network, because the CLI imports it
before any configuration exists. A catalog beyond the built-in `oh` is resolved
by the CALLER (`ontology_catalog.ts`, which may fetch) and handed in; when the
choice needs one and none was given, the plan reports a programming error rather
than fetching.

- **The CLI** maps argv to the SAME raw record the wizard posts
  (`answersFromCliArgs`, table `INSTALL_CLI_FLAGS` — the parser carries no
  defaults, and an unknown flag or a value flag without a value is an error),
  seeds the process environment from `cliBootEnv(plan)` through
  `seedProcessEnv` (`src/config/env.ts` — the installer is the one writer of
  `process.env` outside the loader), then runs `plan.steps` with an exhaustive
  switch. `--plan` prints the plan as one JSON line and touches nothing;
  `--list-ontologies` prints `describeOntologyCatalog` of the selected source
  and exits. The prior `.env` is read once through `prior_env.ts readPriorEnv()`
  (the same reader `config_persist.ts` uses), so a printed plan honours a
  preserved custom server list.
- **The wizard** posts the same keys to `persist_config`; `config_persist.ts`
  builds the plan from them (with the prior `.env` values) and renders
  `plan.env`, refusing `install.invalid_input` on `plan.errors` before any write.
- **The steps** (`INSTALL_STEP_IDS`) are the router's action names:
  `test_db_connection`, `test_diffusion_connection` (diffusion only),
  `test_mailer_connection` (mailer only), `persist_config`, `check_directories`,
  `stage_ontologies`, `install_db_from_default_file`, `install_ontologies`,
  `set_root_pw`, `install_hierarchies` (always — possibly with an empty list),
  `register_tools` (unless skipped), `install_finish`. The CLI's pre-flight and closing login check, and the
  wizard's `verify_active_config` and in-wizard login, are front-end affordances,
  not plan steps.
- **Update servers.** The plan writes `ONTOLOGY_SERVERS` and `CODE_SERVERS`
  (raw JSON) — `OFFICIAL_ONTOLOGY_SERVER` / `OFFICIAL_CODE_SERVER` by default,
  `[]` for `update_servers: 'none'`. With the official choice, a key whose prior
  `.env` value is a non-empty list is left out of the plan, so the persist step
  carries the operator's line (mirrors included) verbatim; a prior `[]` (an
  earlier air-gapped answer) or an unparseable value is replaced by the official
  entry.
- **Ontologies.** The plan writes `ACTIVE_ONTOLOGY_TLDS` (raw JSON, OWNED —
  rewritten on every run) = `CORE_ONTOLOGY_TLDS` followed by the install order of
  the chosen domain ontologies and the ontologies they declare (`main:
  ontology35`; declined optional ones left out). See
  [Domain ontologies](#domain-ontologies) below.
- **Never in the plan:** `DEDALO_SUPERVISED`. Supervision is declared by the
  process manager (unit `Environment=`, compose `environment:`, the supervised
  `bun run` scripts); the engine reads it from the process environment only
  (`src/core/update/supervision.ts`).

`install_plan_parity_tripwire` holds the front ends to this: the same answers
through CLI argv and through the wizard record yield the same plan, a spawned
`--plan` equals the in-process plan, and two persisted `.env` files differ only in
the generated secret. For the ontologies it also builds a local fixture source and
checks that the spawned `--list-ontologies` prints exactly
`describeOntologyCatalog` of it, and that the `ACTIVE_ONTOLOGY_TLDS` the wizard
path writes maps back (`ontologyRequestFromActive`) to the very request the CLI
plan stages.

| Step | Module | Notes |
|---|---|---|
| diagnostics | `init_test.ts`, `server_info.ts` | `init_test.result` is the client progression gate; `server_info` is cosmetic (TS-meaningful facts only — WC-2026-07-09-installer-diagnostics-grid) |
| `test_db_connection` | `db_probe.ts` | psql `SELECT 1` on POSTED creds; falls back to the `postgres` DB to tell "missing DB" from "auth wrong" |
| `test_diffusion_connection` | `db_probe.ts` → `diffusion/api/` facade | one-shot MariaDB probe (facade-only, boundary rule) |
| `persist_config` | `config_persist.ts` | atomic `.env` write (0600, backup-on-overwrite, preserve-or-generate secrets) + state |
| `verify_active_config` | `config_persist.ts` | confirms the RESTARTED process is on the new config |
| `check_directories` | `directories.ts` | private/sessions/cache/media/backups, write+unlink probe |
| `get_ontology_catalog` | `ontology_catalog.ts` | wizard PROBE (pre-login): the catalog view of the official/configured server, or the offline view (`update_servers: false`, or the server failed — `data: false`) |
| `stage_ontologies` | `ontology_install.ts` | copy/download + gunzip + COPY-sanity of every chosen file into the staging dir, `staged.json` with sha256s; the DB is never touched. The wizard's request comes from the WRITTEN config (`ontologyRequestFromConfig`), never from the client |
| `install_db_from_default_file` | `db_restore.ts` | empty-DB gate → gunzip → `psql -f` the core-only seed (already migrated) → `ensureSearchStores()` → engine ontology → `activateCoreHierarchies()` (activates `lg`, see below) |
| `install_ontologies` | `ontology_install.ts` | sha re-check → `stageOntologyFiles` → `importStagedOntologyFiles` (the update panel's shared lower layer) → one re-derive pass → reference verification (warnings) → staging dir removed |
| `set_root_pw` | `root_pw.ts` | Argon2id, direct UPDATE `matrix_users` section_id `-1` dd133 |
| `install_hierarchies` | `hierarchy_import.ts` | optional thesauri only: `\copy` into `matrix_hierarchy` + counter consolidate + activation (login-gated); a core TLD is activation-only, an empty list is a no-op |
| `register_tools` | `register_tools.ts` | reuses `core/tools/register.ts importTools({dryRun:false})` |
| `install_finish` | `finish.ts` | seal guard (root + password exist) → `install_status='sealed'` |

## Domain ontologies

The seed carries only the core (`src/core/ontology/core_tlds.ts`
`CORE_ONTOLOGY_TLDS` — `dd`, `rsc`, `ontology`, `ontologytype`, `hierarchy`, `lg`,
the ONE home of that list). Every install adds ≥ 1 domain ontology. The modules,
leaf first:

| Module | Role |
|---|---|
| `src/core/install/ontology_choice.ts` | PURE, config-free. The answer (`normalizeOntologyChoice`: default `DEFAULT_DOMAIN_ONTOLOGIES` = `oh`, core dropped with a note, `none` refused), the built-in catalog (`vendoredOntologyCatalog`: `oh` only — `VENDORED_DOMAIN_TLDS` — its dependencies READ from the vendored `ontology.json` entry, absent = not declared), the merge (precedence local > vendored > server), the closure (`closeOntologyChoice`: `main: ontology35` dependencies depth-first, `main: hierarchy1` ones into the thesaurus set; mandatory always, optional unless `declined_dependencies`), the request, `activeOntologyTldsOf`, the round trip from a written list (`ontologyRequestFromActive`) and the ONE view (`describeOntologyCatalog`) both front ends show |
| `src/core/install/ontology_catalog.ts` | `resolveOntologyCatalog(source, {allowedServers})` — the one place a source is read: `none` → built-in only; `local` → a directory or an extracted archive, its `ontology.json` version must equal this engine's `major.minor`; `server` → `fetchOntologyManifest`. Refuses `install.invalid_input` (operator path) or `install.step_failed` (server) |
| `src/core/install/ontology_archive.ts` | `extractOntologyArchive` — a pure tar walk (no `tar` binary): regular files named `ontology.json` / `<tld>.copy.gz` at the root or under one top directory, through `confinedPath`; links, devices, absolute or `..` paths, > 256 entries or > 512 MiB refused |
| `src/core/install/hierarchy_dependencies.ts` | `installedHierarchyDependencies()` — the wizard's `install_hierarchies` step reads the thesauri the registry rows of `ACTIVE_ONTOLOGY_TLDS` declare (`misc.hierarchy60`, read-only), with the plan's own collector |
| `src/core/install/ontology_install.ts` | the two steps: `stageOntologies(request, {stagingDir})` and `installOntologies({stagingDir, userId})`, plus `verifyInstalledOntologyReferences` and the wizard's `ontologyRequestFromConfig` |
| `src/core/install/prior_env.ts` | `readPriorEnv()` — the prior `.env` (`{}` when absent), for the CLI and `config_persist.ts` alike |
| `src/core/ontology/ontology_manifest.ts` | the manifest CLIENT: `parseOntologyManifest`, `readLocalOntologyManifest`, `fetchOntologyManifest` |
| `src/core/ontology/ontology_references.ts` | the pure reference classifier (below) |
| `src/core/db/copy_text.ts` | the src-side COPY text codec (decode/encode a field, split a row, find a dump's COPY blocks) |

**The closure.** `closeOntologyChoice(chosen, catalog, policy)` walks the DECLARED
`main: ontology35` dependencies of the chosen TLDs, transitively, in deps-first
post-order: mandatory ones always, optional ones unless the policy declines them
(`declinePolicy(answers.declined_dependencies)`, each declined one noted). Core
TLDs and the engine-owned `ddengine` are never followed (a declaration names core
too — every domain ontology takes its models from `dd` — but the seed already
has it). A cycle is tolerated (first finish wins; the re-derive pass in
`installOntologies` settles a node whose model arrived later). An entry with
`dependencies: null` (an older server) is installed alone under a loud warning
naming it — the installer never computes dependencies. A declared MANDATORY
dependency the source does not offer, and an unknown TLD, are errors before any
write; an unoffered OPTIONAL one is a warning and skipped. A dependency on a core
or engine-owned TLD is never put to the decline policy: the seed always installs
it, so it can be neither declined nor reported as declined (the wizard shows it
ticked and locked).

**The thesaurus set.** `main: hierarchy1` dependencies are collected by ONE
function, `collectHierarchyDependencies` (merged per TLD, mandatory wins, core
`lg` never listed), into `{tld, mandatory, dependants}` items. The plan collects
them over the vendored core declarations plus the install order's entries. The
seed compiler passes each release entry's declaration through the import door
(`releaseDependencies` in `seed_build.ts`; a malformed one refuses the compile),
so the seed's core registry rows hold the same `hierarchy60` the plan reads —
`install_seed_drift_tripwire` checks the committed seed against the release.
The result goes into `InstallPlan.hierarchyDependencies`,
and adds them to `plan.hierarchies`: mandatory ones always (even with
`--hierarchies none`), optional ones unless declined. `hierarchyDependencyPlan`
checks each against the vendored thesauri (`offeredHierarchyTlds()` — `hierarchies.json` ∩ the `<tld>1.copy.gz` files): a mandatory
thesaurus with no `<tld>1.copy.gz` is a plan error before any write, an optional
one a warning. The wizard's `install_hierarchies` step runs in the restarted
process with no plan, so it re-derives the set from the installed registry rows
(`installedHierarchyDependencies`) and unions the mandatory ones into the posted
list (`withMandatoryHierarchies`); a mandatory one that is not vendored is
refused `install.invalid_input` before any write. The posted list is never
trusted to carry them.

**The source.** `ontologySourceFor(answers, priorEnv)` (in the plan): a local
`ontology_source` wins; else the first entry of `ontologyServersFor` (a prior
CUSTOM `ONTOLOGY_SERVERS` list — the same preserve rule as the update-servers
section — or `OFFICIAL_ONTOLOGY_SERVER`); else `none` (air-gapped). The manifest
fetch is a server-side `fetchBoundedText` call behind the named address policy
`assertConfiguredMasterUrl(url, allowed)`: the URL must be EXACTLY one of the
configured masters — operator configuration, never client text. LAN masters are
legitimate, so the public-address guard does not apply. File downloads reuse the
update panel's pinned `downloadRemoteOntologyFile`; there is no new fetch site.

**The two steps.** `stage_ontologies` is the install's only network phase and
runs BEFORE the restore: every file (deps first, plus the source's
`matrix_dd.copy.gz` when it ships one and ≥ 1 item comes from it) is copied or
downloaded into `installOntologyStagingDir()`
(`<private>/install/ontology_staging/<major.minor>/`), gunzipped under the shared
caps and COPY-sanity checked; `staged.json` records each file's sha256 and the
source (never the access code). `install_ontologies` runs right after the restore:
it refuses `install.state_conflict` when `staged.json` is missing or a file's
sha256 changed, unpacks through the update panel's own Phase-A stager
(`stageOntologyFiles`, local mode), claims the update's single-flight latch
(`claimOntologyImportLatch`), and imports through the SHARED LOWER LAYER of
`src/core/ontology/ontology_update.ts`, `importStagedOntologyFiles` — recovery
snapshots, the per-file import with auto-restore, the `dd_ontology` derive and
the cache clears. `updateOntology` keeps its own shell (TLS, ownership, target,
latch, download, Phase A, schema capture before and after, root info); the
installer calls the layer directly, without flipping `IS_AN_ONTOLOGY_SERVER`.

**The failure contract** is install-level all-or-nothing: any import error
refuses `install.step_failed`; the layer's snapshot restore runs (its known
limits are the update panel's), nothing is sealed, and the operator recreates the
database. The staging directory is removed on success only.

**Reference measurement.** `ontology_references.ts` reads the structural fields
only — parent (`ontology15`), model (`ontology6`), related nodes (`ontology10`) —
from `dd_ontology` rows (`referencesOfRows`) or raw package lines
(`referencesOfCopyRows`), and classifies each reference: a PARENT in a TLD the
measured set does not own is a `graft` (a node hung under another ontology's
node — inert when absent); a relation FROM a node whose model descends from the
diffusion model grouper (`DIFFUSION_MODEL_ROOT` = `dd1226`) is `diffusion`;
everything else is a `dependency` and must resolve. Tipos embedded in
`properties` are not measured — a stated limit. The same classifier drives the
post-install warnings (`verifyInstalledOntologyReferences`), the vendored-closure
gate and the seed contract.

**The declaration (server side).** Dependencies are Dédalo state on the ontology
master: the master ontology's component_json `hierarchy60` *Dependencies*
(group *Relations* of `hierarchy1`, so the *Ontologies main* `ontology35` form
has it too), stored as `misc.hierarchy60[0].value` on the registry row. Each
item is `{tld, main: ontology35|hierarchy1, mandatory}`, checked by ONE
normalizer (`normalizeOntologyDependencies`,
`src/core/ontology/ontology_dependencies.ts`; the dedupe key is `(tld, main)`).
`getActiveOntologies` (`src/core/ontology/data_io.ts`) exports it as
`dependencies` ONLY when the row holds the key. Invalid items become census
error lines. `activeOntologiesInfo` copies it into `ontology.json`, and the
update manifest serves that file verbatim. An absent key means NOT DECLARED;
`[]` is a declaration
(`engineering/wire_contract/WC-2026-10-10-ontology-dependencies-hierarchy60.md`).
The import writes it back through `syncMainSectionFromDefinition`, the
registry-row law's import door, which on an existing row replaces only the
definition's keys.

**The wizard wire** (`engineering/wire_contract/WC-2026-10-09-install-domain-ontologies.md`):
`get_install_context` gains `properties.ontologies = {default, core, offline}`
(synchronous, no network); three pre-auth router actions —
`get_ontology_catalog`, `stage_ontologies`, `install_ontologies`; and
`persist_config` takes `ontologies`. Since
`engineering/wire_contract/WC-2026-10-10-ontology-dependencies-hierarchy60.md`
it also takes `declined_dependencies` (CLI `--decline-dependencies`) and answers
the extension key `hierarchy_dependencies`; each catalog view entry carries
`hierarchy_dependencies`, and `--plan` prints `hierarchy_dependencies` and
`declined_dependencies`.

## The suite database is built through these doors

`bun run test:db:setup` (`scripts/test_db_setup.ts`) builds the suite database
as an installation first: `installDbFromSeed()` (the restore door, so the core
seed, the search stores, the engine ontology and `lg`), then the default domain
ontology through `stageOntologies(defaultOfflineOntologyRequest())` +
`installOntologies()`, and only then the suite's own fixtures — the marker, the
`test` TLD (`materializeTestTldOntology`, which refuses on a database without the
marker; there is no bypass), the canonical test3 records, hierarchies and tools.
No installation receives a test fixture.

## Install-mode boot (the config-freeze problem)

`config.ts` builds and **freezes** `config` at import and `requireEnv`-throws on
missing `ENTITY`/`DB_NAME`/`DB_HOST`/`DB_USER`, so a machine with no `.env`
cannot boot. `resolveInstallMode()` sets `config.installMode` true when **all
four** required keys are unset AND the install is not sealed; the four keys then
carry sentinels so the server boots to serve the wizard. A **partial** config
still throws (operator error), and a **sealed** install whose `.env` vanished
also throws (never silently re-enter the wizard on live data). In install mode
`server.ts` skips migrations / RAG / diffusion, and `/health` reports `db:down`.

## Restart-after-configure

The server reads config once at import, so `persist_config` writes `.env` and
then `process.exit(0)` (`restart.ts scheduleServerRestart`); the supervisor
(`deploy/dedalo-ts.service` `Restart=always`) restarts it into configured mode.
Exit-then-restart avoids racing the socket double-start guard that a self-respawn
would hit. The wizard's separate manual **Verify** click (+ the client's request
retries) bridges the gap. `scheduleServerRestart` is a no-op under
`DEDALO_INSTALL_NO_RESTART=true` (tests and the CLI). The **CLI** sets the DB/
entity env before importing config, so it resolves the real config in one
process and needs no restart.

`start` mounts the wizard while `config.installMode || installInProgress()`
(`gate.ts`): after `persist_config` the server has restarted OUT of install mode
but is not yet sealed (`install_status='configured'`), so a mid-install **reload**
must resume the wizard rather than drop to the login form. `installInProgress()`
deliberately does NOT fire for `undefined`/`unconfigured` status, so a deployment
provisioned by some other route (one that never ran the installer) always gets the
login form, never the wizard.

## Pre-auth window

`dispatch.ts` Gate 1b: the install surface (`dd_utils_api:install` +
`get_install_context`) is pre-auth WHILE UNSEALED and IP-gated by
`installIpAllowed` (`gate.ts`). The gate is **fail-closed since 2026-08-24**
(`engineering/wire_contract/WC-2026-08-24-install-ip-gate-fail-closed.md`): an
unset or empty `DEDALO_INSTALL_ALLOWED_IPS` means the local machine only
(`DEFAULT_INSTALL_ALLOW_ENTRIES = ['loopback']`), and `any` is the single
spelling that admits every address. An entry is `loopback`, a literal address, or
a CIDR block matched bitwise by the pure `ipInCidr` (malformed ⇒ no match, never
a throw). The refusal is `install.ip_denied` (403); its only detail is the caller's own
resolved address (`client_address`, so the operator knows what to add —
`engineering/wire_contract/WC-2026-10-08-install-ip-denied-names-address.md`).
The policy source is never echoed back; the operator reads the effective policy
off the boot log (`describeInstallAllowPolicy`). Honest limit: `clientIp` is the
trusted-hop `X-Forwarded-For` value, and a request without that header resolves
to the sentinel `'local'`, so on a bare TCP listener with no proxy the gate
cannot see the real peer. Once sealed the surface returns **404**. CSRF is
unchanged (Gate 3 only runs for sessions), and the record-writing steps re-check
the session in the handler.

## Languages (mandatory)

`config.ts` requires four language keys whenever the server is configured
(`INSTALL_MODE=false`): `DEDALO_APPLICATION_LANGS` (code→label map),
`PROJECTS_DEFAULT_LANGS` (code array), `DEDALO_APPLICATION_LANGS_DEFAULT`,
`DEDALO_DATA_LANG_DEFAULT` (owner rule: a missing/malformed value must refuse
boot). The installer therefore MUST write them, or the post-`persist_config`
restart crash-loops.

- `lang_catalog.ts` is the single source of truth: `INSTALL_LANG_CATALOG` (the
  curated ~10 code→label set) + `deriveLangConfig({langs, appLangDefault,
  dataLangDefault})` — PURE (no `config.ts` import). The picked set drives BOTH
  the map and the array, so they can never disagree. Absent `langs` →
  `INSTALL_DEFAULT_LANG_CODES` (`lg-eng`, `lg-spa`; the rest of the catalog is
  optional); an explicit empty set or a default ∉ set → `errors` (refused).
- `install_plan.ts` calls `deriveLangConfig` (its errors become plan errors, so
  `config_persist.ts` refuses on them), and the plan carries
  the map/array as **RAW compact `JSON.stringify`** (NOT `envQuote`):
  `parseEnvFile` strips surrounding quotes but does not unescape inner `\"`, so
  an `envQuote`'d JSON value would not round-trip through `JSON.parse`. Scalars
  (`*_DEFAULT`, `APPLICATION_LANG`, `DATA_LANG`,
  `DEDALO_STRUCTURE_LANG`) use `envQuote`.
- The **CLI** (`scripts/install.ts`) presets the lang env vars from the plan's
  `deriveLangConfig` result (`cliBootEnv`) BEFORE importing config (with ENTITY/DB
  set, config would otherwise throw at import) — `deriveLangConfig` is pure
  precisely so it can run first. Flags: `--langs`, `--app-lang`, `--data-lang`.
- The wizard collects them on the Entity step (`render_installer.js`), seeded
  from `context.ts` `available_langs`/`install_checked_langs` (pre-ticked =
  `INSTALL_DEFAULT_LANG_CODES`); ≥1 enforced both
  client-side and in `deriveLangConfig`.

## Config / paths

- **Key spellings.** `env.ts` reads each config key by its canonical name and
  accepts a documented legacy `DEDALO_*` spelling as a fallback, so an
  administrator can carry an existing `.env` over unchanged; the canonical name
  always wins when both are set. The install plan writes only canonical names,
  and `config_persist.ts` drops a prior `.env`'s legacy line for every key the
  plan writes, so a re-run never leaves one value under two names.
  `DEDALO_SALT_STRING` is generated (or preserved)
  on write for continuity, but nothing in the server reads it — it is not a
  password salt and never was (see `src/core/security/password_hash.ts`).
- `DEDALO_PRIVATE_DIR` relocates the whole private tree — both `env.ts` (read)
  and the installer (write) honor it. `installPrivateDir()` (`paths.ts`) adds a
  write-only test override `DEDALO_INSTALL_PRIVATE_DIR`.
- pg client binaries resolve via `pg_bin.ts` (config `DEDALO_PG_BIN_PATH`, then
  Homebrew `postgresql@NN` newest-first, then PATH — a client older than the
  server refuses to connect); `pg_exec.ts` runs psql against an explicit
  connection descriptor (posted creds for the browser probe; the CLI path).

## Core hierarchies (Languages)

`hierarchy_meta.ts` `CORE_HIERARCHIES` names the thesauri every install has —
today only `lg` (Languages). Its terms ship **in the seed**, in `matrix_langs`
(the table `lg1`/`lg2` resolve to), so it is never imported: there is no
`lg1.copy.gz` and no `lg` descriptor in `hierarchies.json`. It only needs
activating — flag active, active in thesaurus, link the root — which
`activateCoreHierarchies()` (`hierarchy_activate.ts`) does inside
`install_db_from_default_file`, so every surface that restores the seed (CLI,
wizard, `install.sh`) gets it with no separate step. `installHierarchies` answers
a core TLD with activation only (`replace` is refused: its terms cannot be
re-imported), and a front end that lists `lg` gets it dropped with a note.

The optional thesauri pre-selected by default are data, not code:
`defaultOptionalHierarchies()` reads the descriptors flagged
`install_checked_default` in `hierarchies.json` (today `es`). The CLI default,
`install.sh`'s `default` answer and the wizard's `install_checked_default`
context property all come from it.

## The install seed

`install/db/dedalo_install.pgsql.gz`: full matrix/`dd_ontology` schema, extensions
(`btree_gin`/`pg_trgm`/`unaccent`), functions/indexes, the CORE ontologies only
(`CORE_ONTOLOGY_TLDS`, ~3,470 `dd_ontology` rows), the root user (empty password),
the default project and Admin/User profiles, and the Languages terms in
`matrix_langs`. No domain ontology, no `test` TLD, no `matrix_test` row. The
derived search stores (`matrix_string_search`, `matrix_relation_index`) are
created but ship EMPTY: the relation-index reader refuses an empty store while
relation data exists, so `completeFreshInstall` (`db_restore.ts`) runs
`ensureSearchStores()` FIRST, before any engine read or write. Optional hierarchy
import files are vendored under `install/import/hierarchy/` (`<tld>1`/`<tld>2`
`.copy.gz` files + three metadata JSONs).

The seed is **compiled, never hand-edited and never built from a database**:
`bun run seed:build` (the same compiler as Maintenance → *Build database version* →
`build_install_version`, `src/core/install/seed_build.ts`) builds it from files in
this repository only, so the same checkout produces the same seed on any machine.
Its sources:

| Part of the seed | Source |
|---|---|
| Schema (tables, functions, triggers, indexes, extensions) | `install/db/seed/schema.sql` plus every file in `install/db/migrations/` |
| Core ontology (`CORE_ONTOLOGY_TLDS`: `dd`, `rsc`, `ontology`, `ontologytype`, `hierarchy`, `lg` — `seed_sources.ts` reads that one list) and private lists | the ontology release `install/import/ontology/<major.minor>/` — the packages every ontology update downloads — applied through the update's own per-package door |
| Languages terms (`matrix_langs`) | `install/db/seed/matrix_langs.copy.gz` |
| Hierarchy registry (`matrix_hierarchy_main`, every hierarchy inactive) | `install/db/seed/matrix_hierarchy_main.copy.gz` |
| Root user (no password), General project, Admin/User profiles | `SEED_RECORDS` in `src/core/install/seed_sources.ts` |
| Data version | generated: the engine's version |

Everything else ships empty. No domain ontology is compiled in: `oh` is the
installer's default *answer*, installed after the restore from the vendored
`install/import/ontology/<major.minor>/oh.copy.gz` (see *Domain ontologies*). The
`test` TLD and the test3 playground are the suite's: `bun run test:db:setup`
materializes them (registry row included) after restoring this seed. `install/db/seed/dd_ontology_scaffold.copy.gz` is the parser's scaffold:
deriving `dd_ontology` reads the ontology's own definitions, so the compiler starts
from it, derives to a fixpoint and requires every TLD to come out in sync — none of
the scaffold reaches the seed.

The compile runs in scratch databases it creates and marks (`dedalo_seed_build_<pid>`,
`dedalo_seed_verify_<pid>`, dropped afterwards), one compile per cluster (an advisory
lock). Before the file is replaced, the result **installs itself**: it is restored into
the second scratch database through the installer's own restore — search stores,
engine ontology, Languages activation — the boot migrations run over it, and the
core ontology, Languages and root password are checked. It checks what the seed
promises (the core), never a domain ontology. A registry record the activation
would refuse, an active hierarchy, an ontology row of another TLD or an undeclared
extension refuses the compile. The database user needs `CREATEDB`.

The seed is committed with `install/db/dedalo_install.manifest.json`: the seed's
digest, its row counts, and a digest of every source file. Changing what an install
is born with is a change to a source, then `bun run seed:build`, then commit the seed
and the manifest together — a source changed without a recompile is reported STALE.
To ship a newer ontology, export the release packages from the ontology master first.

## Gates

`test/unit/install_*.test.ts` and `seed_build_native`: the seed compiler and its
content contract (`install_seed_contract_native` holds the committed seed to it, and
`install_seed_manifest_tripwire` to its manifest and sources; `install_seed_drift_tripwire`
holds the compiler's TLDs = `CORE_ONTOLOGY_TLDS` = the catalog default of
`ACTIVE_ONTOLOGY_TLDS` and the core's dangling dependency references to
`engineering/install_seed_contract.json`), install-mode boot (subprocess config import), the
pre-auth gate + reload-resume + verify-await regressions, the `.env` write
contract, the seed restore + Argon2id root pw + login (real scratch DB), the
hierarchy import, the seed drift tripwire, and the full CLI **e2e ending in a
verified root login** (and asserting `lg` active with zero `matrix_hierarchy`
rows). `install_plan_parity_tripwire` holds CLI and wizard to one plan;
`install_core_hierarchy_native` proves the core activation needs no import;
`install_sh_portability` runs `install.sh`'s answer-to-flag block through the
plan's own parser. The ontology half: `install_ontology_choice` (the closure,
hermetic), `install_hierarchy_dependencies_native` (the step's reader and its
mandatory union over real registry rows, on the suite database),
`ontology_references_native` (the classifier and codec, hermetic),
`ontology_manifest_native` (the manifest client against a loopback stand-in
master, hermetic), `ontology_dependencies_native` (`hierarchy60` → census →
manifest, on the suite database), `vendored_ontology_closure_tripwire` (the built-in `oh` is
installable alone over the core seed, hermetic) and
`install_ontology_door_native` (both steps driven for real on the suite database
against a loopback master: closure order, undeclared warning, local
directory/archive, preflight refusals with the database untouched, tampered
staging, `matrix_dd`). Tests never name a real domain ontology's structure: they
build zz TLD packages (`src/core/test_data/ontology_package_fixture.ts`).
