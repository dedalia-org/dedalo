# The install engine (developer reference)

> See also: [Installing Dédalo (operator guide)](../install/index.md) · [Installer reference](../install/installer_reference.md) · [Development](index.md) · [Extending Dédalo](extending/index.md)

This page documents how the install engine works internally (DEC-19). For the
step-by-step **operator** instructions, see the
[install guide](../install/index.md) and the
[installer reference](../install/installer_reference.md); this page is for developers
working on `src/core/install/` and the install boot path.

## The engine

One engine under `src/core/install/`, driven by ONE installer in the terminal:
`scripts/install.ts` (npm `dedalo:install`; `install.sh` is only its bootstrap),
whose front ends — the full-screen UI, the plain line mode, flags and an answers
file — all build the same plan. The executor (`executor.ts`, its loop in
`step_loop.ts`) runs the plan's steps through the ONE step table (`steps.ts`
`INSTALL_STEPS`, each `run` being the `step_runs.ts` `STEP_RUNS` entry) with
accept / verify / undo and a checkpoint per step, which is what makes `--resume`
and `--abort` possible. There is no install API: the browser front end and its
step router were removed on 2026-10-12
(`engineering/wire_contract/WC-2026-10-12-install-surface-removed.md`), and a
server on a box that is not installed refuses to start
([Fail-closed boot](#fail-closed-boot)).

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

- **The CLI** maps argv to the SAME raw record the screens and an answers file
  produce (`answersFromCliArgs`, table `INSTALL_CLI_FLAGS` — the parser carries no
  defaults, and an unknown flag or a value flag without a value is an error),
  seeds the process environment from `cliBootEnv(plan)` through
  `seedProcessEnv` (`src/config/env.ts` — the installer is the one writer of
  `process.env` outside the loader), then runs `plan.steps` with an exhaustive
  switch. `--plan` prints the plan as one JSON line and touches nothing;
  `--list-ontologies` prints `describeOntologyCatalog` of the selected source
  and exits. The prior `.env` is read once through `prior_env.ts readPriorEnv()`
  (the same reader `config_persist.ts` uses), so a printed plan honours a
  preserved custom server list.
- **`persist_config`** (`config_persist.ts`) builds the plan from the answers
  (with the prior `.env` values) and renders `plan.env`, refusing
  `install.invalid_input` on `plan.errors` before any write; it marks the server
  state `terminal_installing`, which keeps a server from starting until
  `install_finish` seals it.
- **The steps** (`INSTALL_STEP_IDS`) are the keys of the one step table:
  `test_db_connection`, `test_diffusion_connection` (diffusion only),
  `test_mailer_connection` (mailer only), `install_dev_dependencies` (developer
  route only — never a host route nor its engine child), `dev_tls_certificate` and
  `dev_trust_ca` (developer route, only when the listener presents the local CA's
  pair in `<private>/tls`), `persist_config`, `check_directories`,
  `stage_ontologies`, `install_db_from_default_file`, `install_ontologies`,
  `set_root_pw`, `install_hierarchies` (always — possibly with an empty list),
  `register_tools` (unless skipped), `install_finish`, `verify_dev_server`
  (developer route only — after the seal, since the server boots only then). The pre-flight and the
  closing login check are the installer's own affordances, not plan steps.
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
through CLI argv, as a record and as an answers file yield the same plan, a spawned
`--plan` equals the in-process plan, and two persisted `.env` files differ only in
the generated secret. For the ontologies it also builds a local fixture source and
checks that the spawned `--list-ontologies` prints exactly
`describeOntologyCatalog` of it, and that the `ACTIVE_ONTOLOGY_TLDS` written
maps back (`ontologyRequestFromActive`) to the very request the plan stages.

| Step | Module | Notes |
|---|---|---|
| pre-flight | `init_test.ts`, `server_info.ts` | `init_test.result` gates the run; `server_info` feeds the probes' host facts (`probes.ts`) |
| `test_db_connection` | `db_probe.ts` | psql `SELECT 1` on POSTED creds; falls back to the `postgres` DB to tell "missing DB" from "auth wrong" |
| `test_diffusion_connection` | `db_probe.ts` → `diffusion/api/` facade | one-shot MariaDB probe (facade-only, boundary rule) |
| `install_dev_dependencies` | `dev_dependencies.ts` | developer route only: `bun install --frozen-lockfile --ignore-scripts` over the bootstrap's `--production` tree, as the tree's owner (root in another user's tree refuses); spawns nothing when every devDependency is at its `bun.lock` version (also its `verify`); the package manager gets no install secret |
| `dev_tls_certificate` | `dev_tls.ts` (names: `dev_certificate.ts`) | developer + local CA: `deploy/dedalo-tls-rotate.sh --mode local-ca --reload none` (or `--mode renew` over an authority already there for the same names) into `<private>/tls`, as the tree's owner; the generator gets no install secret; an authority for other names is refused in the preflight (`dev_listener_check.ts`). `verify` = the chain on disk (signatures, names, expiry, key pair, 0600 keys); `undo` = the directory, only when this install created it (`created.dev_tls_dir`); while `dedalo-trust.json` still lists entries (the trust undo, which runs first, was refused) it keeps that record and the authority, so `bun run tls:untrust` can still remove them |
| `dev_trust_ca` | `dev_trust.ts` | macOS login keychain (`security add-trusted-cert`, no root), Linux anchors + update through ONE `sudo` (none as root), Firefox NSS via `certutil`; measures trust before asking (no second prompt); a refusal is a done step with a "not trusted yet" warning, never a failure. Every entry it adds is recorded in `<private>/tls/dedalo-trust.json`: `undo` removes this install's, `bun run tls:untrust` (`scripts/dev_tls.ts`) all of them. `add-trusted-cert` imports before it asks, so a cancelled macOS dialog deletes the import again (recorded instead when the keychain refuses the delete). Under `DEDALO_TEST_TRUST_STORE_OFF` the doors change no store, or drive the scratch store a gate sets with `useScratchTrustEnvironment`. No `verify` |
| `persist_config` | `config_persist.ts` | atomic `.env` write (0600, backup-on-overwrite, preserve-or-generate secrets) + state |
| `check_directories` | `directories.ts` | private/sessions/cache/media/backups, write+unlink probe |
| (catalog, before the plan) | `ontology_catalog.ts` | `resolveOntologyCatalog` — the caller resolves the catalog of the selected source (the official/configured server, a local `--ontology-source`, or the offline view) and hands it to the plan |
| `stage_ontologies` | `ontology_install.ts` | copy/download + gunzip + COPY-sanity of every chosen file into the staging dir, `staged.json` with sha256s; the DB is never touched. The request is the plan's `ontologyRequest` |
| `install_db_from_default_file` | `db_restore.ts` | empty-DB gate → gunzip → `psql -f` the core-only seed (already migrated) → `ensureSearchStores()` → `activateCoreHierarchies()` (activates `lg`, see below) |
| `install_ontologies` | `ontology_install.ts` | sha re-check → `stageOntologyFiles` → `importStagedOntologyFiles` (the update panel's shared lower layer) → one re-derive pass → reference verification (warnings) → staging dir removed |
| `set_root_pw` | `root_pw.ts` | Argon2id, direct UPDATE `matrix_users` section_id `-1` dd133 |
| `install_hierarchies` | `hierarchy_import.ts` | optional thesauri only: `\copy` into `matrix_hierarchy` + counter consolidate + activation; a core TLD is activation-only, an empty list is a no-op |
| `register_tools` | `register_tools.ts` | reuses `core/tools/register.ts importTools({dryRun:false})` |
| `install_finish` | `finish.ts` | seal guard (root + password exist) → `install_status='sealed'` |
| `verify_dev_server` | `dev_serve.ts` | developer route only: `bun run dev` once from the checkout (its environment minus every key the written `.env` names, `DEDALO_PRIVATE_DIR` = the install's), the port probed free first; `curl --cacert <local CA>` → `/health`, a root login + `/api/v1/counters` with the same cookie jar (the password through stdin); stopped with SIGTERM and the port waited free. A boot that throws is named after 5 s with nothing listening (`bun --watch` keeps the entry alive, waiting for a file change). Red names the cause and fails the step (sealed: `--resume` re-runs it). curl, not `fetch`: Bun's TLS client refuses the name-constrained authority. The child is tracked in the run's child scope (`trackInstallChild`), so an interrupt stops it. No `verify`, no `undo`. The final screen reads the written `.env` again (`devServedView`) |

## Domain ontologies

The seed carries only the core (`src/core/ontology/core_tlds.ts`
`CORE_ONTOLOGY_TLDS` — `dd`, `rsc`, `ontology`, `ontologytype`, `hierarchy`, `lg`,
the ONE home of that list). Every install adds ≥ 1 domain ontology. The modules,
leaf first:

| Module | Role |
|---|---|
| `src/core/install/ontology_choice.ts` | PURE, config-free. The answer (`normalizeOntologyChoice`: default `DEFAULT_DOMAIN_ONTOLOGIES` = `oh`, core dropped with a note, `none` refused), the built-in catalog (`vendoredOntologyCatalog`: `oh` only — `VENDORED_DOMAIN_TLDS` — its dependencies READ from the vendored `ontology.json` entry, absent = not declared), the merge (precedence local > vendored > server), the closure (`closeOntologyChoice`: `main: ontology35` dependencies depth-first, `main: hierarchy1` ones into the thesaurus set; a mandatory ontology always, an optional one and EVERY thesaurus unless `declined_dependencies` — a declined mandatory thesaurus is a warning, `recommendedThesaurusWarning`), the request, `activeOntologyTldsOf`, the round trip from a written list (`ontologyRequestFromActive`) and the ONE view (`describeOntologyCatalog`) both front ends show |
| `src/core/install/ontology_catalog.ts` | `resolveOntologyCatalog(source, {allowedServers})` — the one place a source is read: `none` → built-in only; `local` → a directory or an extracted archive, its `ontology.json` version must equal this engine's `major.minor`; `server` → `fetchOntologyManifest`. Refuses `install.invalid_input` (operator path) or `install.step_failed` (server) |
| `src/core/install/ontology_archive.ts` | `extractOntologyArchive` — a pure tar walk (no `tar` binary): regular files named `ontology.json` / `<tld>.copy.gz` at the root or under one top directory, through `confinedPath`; links, devices, absolute or `..` paths, > 256 entries or > 512 MiB refused |
| `src/core/install/hierarchy_dependencies.ts` | `withThesaurusDependencies()` — closes a thesaurus choice over the thesauri the manifest entries declare (Maintenance › Install hierarchies), with the plan's own collector |
| `src/core/install/ontology_install.ts` | the two steps: `stageOntologies(request, {stagingDir})` and `installOntologies({stagingDir, userId})`, plus `verifyInstalledOntologyReferences` |
| `src/core/install/prior_env.ts` | `readPriorEnv()` — the prior `.env` (`{}` when absent), for the CLI and `config_persist.ts` alike |
| `src/core/ontology/ontology_manifest.ts` | the manifest CLIENT: `parseOntologyManifest`, `readLocalOntologyManifest`, `fetchOntologyManifest` |
| `src/core/ontology/ontology_references.ts` | the pure reference classifier (below) |
| `src/core/db/copy_text.ts` | the src-side COPY text codec (decode/encode a field, split a row, find a dump's COPY blocks) |

**The closure.** `closeOntologyChoice(chosen, catalog, policy)` walks the DECLARED
`main: ontology35` dependencies of the chosen TLDs, transitively, in deps-first
post-order: mandatory ones always, optional ones unless the policy declines them
(`declinePolicy(answers.declined_dependencies)`, each declined one noted). Core
TLDs are never followed (a declaration names core
too — every domain ontology takes its models from `dd` — but the seed already
has it). A cycle is tolerated (first finish wins; the re-derive pass in
`installOntologies` settles a node whose model arrived later). An entry with
`dependencies: null` (an older server) is installed alone under a loud warning
naming it — the installer never computes dependencies. A declared MANDATORY
dependency the source does not offer, and an unknown TLD, are errors before any
write; an unoffered OPTIONAL one is a warning and skipped. A dependency on a core
TLD is never put to the decline policy: the seed always installs
it, so it can be neither declined nor reported as declined (the *Ontologies*
screen shows it ticked and locked).

**The thesaurus set.** `main: hierarchy1` dependencies are collected by ONE
function, `collectHierarchyDependencies` (merged per TLD, mandatory wins, core
`lg` never listed), into `{tld, mandatory, dependants}` items. The plan collects
them over the vendored core declarations plus the install order's entries. The
seed compiler passes each release entry's declaration through the import door
(`releaseDependencies` in `seed_build.ts`; a malformed one refuses the compile),
so the seed's core registry rows hold the same `hierarchy60` the plan reads —
`install_seed_drift_tripwire` checks the committed seed against the release.
The result goes into `InstallPlan.hierarchyDependencies`,
and adds them to `plan.hierarchies` (even with `--hierarchies none`) unless
declined. **A thesaurus dependency never blocks an install** (owner decision
2026-10-10, `WC-2026-10-10-ontology-dependencies-hierarchy60` addendum):
`mandatory: true` on a `main: hierarchy1` item is a STRONG RECOMMENDATION —
pre-ticked like an optional one and declinable; declining it is a WARNING from
ONE function, `recommendedThesaurusWarning` (dependency, dependants, and
`THESAURUS_INSTALL_LATER` = *Maintenance › Install hierarchies*).
`hierarchyDependencyPlan` checks each against the thesaurus manifest
(`offeredHierarchyTlds()` — every non-core entry of `hierarchy.json`, with or
without data files) and answers `{install, warnings}`: a thesaurus with no
entry is a warning and skipped, mandatory or not. An entry without data files
is installable — it is created empty. The `install_hierarchies` step imports
exactly `plan.hierarchies`: the warnings are the plan's, decided before anything
is written, and the step adds nothing. Mandatory ONTOLOGY dependencies keep their
rule (always installed; unoffered → error).

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

**The answers** (`engineering/wire_contract/WC-2026-10-09-install-domain-ontologies.md`,
whose browser half is superseded by `WC-2026-10-12-install-surface-removed`):
`ontologies` and, since
`engineering/wire_contract/WC-2026-10-10-ontology-dependencies-hierarchy60.md`,
`declined_dependencies` (CLI `--decline-dependencies`); each catalog view entry
carries `hierarchy_dependencies`, and `--plan` prints `hierarchy_dependencies`
and `declined_dependencies`.

## The suite database is built through these doors

`bun run test:db:setup` (`scripts/test_db_setup.ts`) builds the suite database
as an installation first: `installDbFromSeed()` (the restore door, so the core
seed, the search stores and `lg`), then the default domain
ontology through `stageOntologies(defaultOfflineOntologyRequest())` +
`installOntologies()`, and only then the suite's own fixtures — the marker, the
`test` TLD (`materializeTestTldOntology`, which refuses on a database without the
marker; there is no bypass), the canonical test3 records, hierarchies and tools.
No installation receives a test fixture.

## Fail-closed boot

`config.ts` builds and **freezes** `config` at import and `requireEnv`-throws on a
missing required key. There is no install mode (removed 2026-10-12 —
`engineering/wire_contract/WC-2026-10-12-install-surface-removed.md`); a box that
is not installed REFUSES TO START.

`src/config/install_state.ts` (depends on `env.ts` only) answers the question:

- `REQUIRED_CONFIG_KEYS` — `ENTITY`, `DB_NAME`, `DB_HOST`, `DB_USER` (frozen at
  four by `config_docs_tripwire`).
- `UNCONFIGURED` — true when all four are unset or empty (environment plus
  `.env`). The catalog readers then hand out the `installSentinel` values, so
  `config` still imports on a fresh box (for `config:gen`, the install probe
  child, and the server's own refusal). The seal is NOT consulted: a sealed box
  whose `.env` was lost must reach the refusal, not throw at import.
- `notInstalledRefusal()` — reads `install_status` raw from `ts_state.json`
  (`DEDALO_TS_STATE_PATH` overrides) and answers one sentence, or `null`: not
  installed (no `.env`) → run the installer; a `.env` naming none of the four →
  complete it, do not reinstall; sealed → restore `.env`; any status other than
  `sealed` → `--resume`. A garbled state file reads as no status.
- `NOT_INSTALLED_EXIT_CODE = 78` (`EX_CONFIG`) — distinct from 75 (the planned
  restart), 1 (a crash) and 0.

`src/boot_refusal.ts` is the FIRST import of `server.ts`: ES modules evaluate in
import order, so when `server.ts` is the process entry (`Bun.main`) the refusal
prints `[boot] REFUSED — <sentence> (exit 78; supervisors must not restart)` and
exits before any sibling import runs — before the session store opens its SQLite
file, before the config build records anything in `ts_state.json`, before any
listener. `startServer()` repeats the check for a programmatic caller; a gate that
imports `server.ts` for `handleRequest` is not refused. A PARTIAL configuration
(one to three keys) is misconfigured, not unconfigured: the config import throws
the precise missing-key error (exit 1).

The supervisors stop on 78: the systemd units carry
`RestartPreventExitStatus=78`, `deploy/dedalo-ts-watchdog.sh` does not start the
restart unit for a unit that failed with 78, and the dev/supervised loops respawn
on 75 only. The planned restart itself (`src/core/update/restart.ts`
`scheduleServerRestart`, exit 75) is requested only by a code update or restore.

The installer seals every route before the first server boot (production: the
engine steps run before `host_first_boot`; docker/trial: the engine runs in
`compose run --rm` before `stack_up`; developer: the operator starts the server
after the install). `persist_config` writes `terminal_installing`, so a server
started by hand over a half-built install refuses with `--resume` instead of
serving a login in front of an unfinished database.

Gates: `no_install_surface_tripwire` (the action table driven session-less; the
real server spawned config-less — exit 78, no listener, no database connection,
no write), `install_state_boot` (the predicate),
`install_restart_supervisor_tripwire` (the supervisors).

## Languages (mandatory)

`config.ts` requires four language keys whenever the server is configured
(not `UNCONFIGURED`): `DEDALO_APPLICATION_LANGS` (code→label map),
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
- The interactive installer asks for them on its languages screen, pre-ticking
  `INSTALL_DEFAULT_LANG_CODES`; ≥1 is enforced by the plan (`deriveLangConfig`).

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
(the table `lg1`/`lg2` resolve to), so it is never imported: `hierarchy.json`
lists it for reference with `data_files: []`, no `lg1.copy.gz` is ever vendored,
and its registry row is the only one the seed ships. It only needs
activating — flag active, active in thesaurus, link the root — which
`activateCoreHierarchies()` (`hierarchy_activate.ts`) does inside
`install_db_from_default_file`, so every surface that restores the seed (the
installer, `test:db:setup`) gets it with no separate step. `installHierarchies` answers
a core TLD with activation only (`replace` is refused: its terms cannot be
re-imported), and a front end that lists `lg` gets it dropped with a note.

## The thesaurus manifest (`hierarchy.json`)

The thesauri a release offers are ONE exported file,
`install/import/hierarchy/hierarchy.json`, written on the master by the
*Export hierarchy* widget (`export_hierarchy_json`, census
`src/core/ontology/hierarchy_census.ts`) and read back through ONE strict reader
(`src/core/ontology/hierarchy_manifest_format.ts`, a pure leaf both sides
import; `readHierarchyManifest()` in `hierarchy_meta.ts` is the installer's
door). Shape: the ontology.json envelope (`version`, `date`, `entity_id`,
`entity`, `entity_label`, `host` — `manifestEnvelope()` in
`src/core/ontology/data_io.ts`, shared), `typologies` `[{typology_id, name,
name_data}]` (the `hierarchy13` records), and `active_hierarchies`, one entry per
ACTIVE `hierarchy1` row: `tld` (`hierarchy6`), `name`/`name_data`
(`hierarchy5`), `typology_id`/`typology_name` (`hierarchy9`), `lang:
{section_id, label}` (`hierarchy8` → an `lg1` record; the import uses the int
`section_id`), `real_section_tipo` (`hierarchy109`, null = the provisioning
default), `active_in_thesaurus` (`hierarchy125`), `scope_note_data`
(`hierarchy61`, `[]` when empty), `dependencies` (`misc.hierarchy60` through the
shared normalizer; absent = not declared) and `data_files` `[{file, sha256}]`
(the `<tld>1|2.copy.gz` files beside it at export time; `[]` = an empty
thesaurus; always `[]` for a core hierarchy). A malformed file refuses
(`install.manifest_invalid`) — it is never read as an empty offer. The census
writes record by record: each entry is checked alone (`validateHierarchyEntry`,
plus a set `real_section_tipo` must be a `section`), and a row that fails is one
`Skipped hierarchy1/<id>` error line, never a failed export. The data export
admits only an active row's own `<tld>1`/`<tld>2`. Contract:
`engineering/wire_contract/WC-2026-10-10-hierarchy-json-manifest.md`.

- **Offer** — `offeredHierarchies()`: every non-core entry, data or not; the
  installer's *Thesauri* screen and the add_hierarchy widget get the same view from
  `hierarchyChoiceView(lang)` (`{tld, label, typology, has_data,
  dependencies}` — `dependencies` = the entry's declared non-core thesauri
  `{tld, mandatory}`, pre-ticked by the client when the entry is ticked; labels
  picked from `name_data` in the requesting user's language through
  `ontology/manifest_lang_pick.ts`).
- **Pre-selection** — ONLY the declared dependencies: the CLI default and the
  *Thesauri* screen's ticked boxes are the plan's
  `hierarchyDependencies` (all ticked, a mandatory one marked strongly
  recommended — never locked). No toponymy is
  ever a default; a plan with no toponymy thesaurus (typology
  `TOPONYMY_TYPOLOGY_ID`) carries `suggestions` = `TOPONYMY_SUGGESTION`
  (`install_plan.ts`), which the installer prints.
- **The chosen thesauri's own declarations** (`installHierarchies` →
  `hierarchy_dependencies.ts` `withThesaurusDependencies` →
  `ontology_choice.ts` `closeThesaurusChoice`) — before anything is written,
  the batch is checked transitively against the chosen entries'
  `dependencies`: NOTHING is added (the front ends pre-tick declared thesauri);
  a mandatory thesaurus left out, or one with no entry, is a warning in `msg`;
  only a mandatory `ontology35` not installed refuses the whole batch. The CLI
  plan runs the same closure with the decline policy — a declared thesaurus is
  added pre-ticked unless declined (`--plan` shows it). A reset is not closed.
- **Preflight** (`activationBlocker`, `hierarchy_activate.ts`) — for a TLD with
  no registry row yet, before its terms are copied: the `lg1/<lang.section_id>`
  and `hierarchy13/<typology_id>` records exist, and `provisionBlocker` accepts
  the entry (a set `real_section_tipo` names a `section`). A refusal writes
  nothing.
- **Import** (`hierarchy_import.ts`) — for each listed data file: exists AND
  sha256 matches, verified before any write; a failure refuses that TLD with
  nothing written. No data files = activation only. Without reset, the sections
  the entry LISTS are counted (`classifyListedSections`): data present → no copy,
  but activation still runs (an interrupted run converges); a section holding
  only the root an empty activation minted while its file carries more → refused
  naming Reset.
- **Activation of a new row** (`activateHierarchy`, `hierarchy_activate.ts`) — the
  registry row is written from the entry in one transaction: `hierarchy6`,
  `hierarchy5`, `hierarchy9`, `hierarchy8` = `lg1/<lang.section_id>`,
  `hierarchy109`, `hierarchy61`, `misc.hierarchy60`; then `ensureHierarchy`
  provisions. An existing row is never re-described.

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
`.copy.gz` files + the manifest `hierarchy.json`, above).

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
| Hierarchy registry (`matrix_hierarchy_main`): the CORE rows only (`lg`), shipped inactive — the restore activates them; every other thesaurus's row is written at activation from its `hierarchy.json` entry | `install/db/seed/matrix_hierarchy_main.copy.gz` |
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
Languages activation — the boot migrations run over it, and the
core ontology, Languages and root password are checked. It checks what the seed
promises (the core), never a domain ontology. A registry record the activation
would refuse, an active hierarchy, a registry row of a non-core hierarchy, an ontology row of another TLD or an undeclared
extension refuses the compile. The database user needs `CREATEDB`.

The seed is committed with `install/db/dedalo_install.manifest.json`: the seed's
digest, its row counts, and a digest of every source file. Changing what an install
is born with is a change to a source, then `bun run seed:build`, then commit the seed
and the manifest together — a source changed without a recompile is reported STALE.
To ship a newer ontology, export the release packages from the ontology master first.

## Front ends (the interactive installer)

The terminal installer has ONE walker and two renderings. `install_session.ts`
(`runInteractiveInstall`) walks the screen model (`screen_model.ts`): the
order, the gating, what a changed answer re-asks, the probes, the kept
secrets, the Review's commands, the unfinished-install offer (resume / abort /
quit). It talks to an `InstallPrompter` (`prompter_contract.ts`), which holds
the shared answer rules — what Enter takes (`suggested`), when `-` empties a
field, the secret entry flow (`secretEntryStep`: refused, policy, twice, three
mismatches = refused), a confirm's default — and the structured views a front
end draws (`ScreenView` before every ask; Welcome, Resume, Probe, Review). The
multi-select model (ticks, declared closure, declines, locks) is
`multi_select.ts`; the text hygiene every front end applies to untrusted
strings is `display_text.ts` (`sanitizeLine`).

- **Plain** (`ui_plain/prompter.ts`): one question per line.
- **Full screen** (`ui/`, OpenTUI): the same asks as widgets, answered with the
  plain mode's values. It holds no install knowledge — no default, no rule, no
  step table (`scripts/install.ts` hands it the step list through
  `RunReporter.begin`). `ui/lifecycle.ts` owns every exit path (signals, an
  uncaught error, `fail`, Done) and restores the terminal; the process is
  injected (`ProcessPort`) so the gates drive the UI on OpenTUI's test renderer
  without a handler that exits the runner. `console_capture.ts` routes every
  console method into the log ring while the UI is up (the executor's
  redaction wraps it).

The run is told through `run_events.ts`: the executor emits a `StepEvent` per
step phase (`start`, `skipped`, `adopted`, `done`, `failed`, `interrupted`,
`undo` — every text redacted) and reports its own signal handlers armed or
disarmed (`RunIo.signals`), so the full screen delegates SIGINT/SIGTERM to the
executor only while it holds them. The headless CLI has no listener and its
transcript is unchanged.

**Confinement.** `@opentui/*` is imported only under `src/core/install/ui/`,
and only `tui_loader.ts` loads it — by a dynamic import, inside one `try`
around the import AND the renderer's creation (a missing native build throws
only there). Any failure answers `{kind: 'plain', reason}` and the CLI goes on
in plain mode. Neither the server's import closure nor the headless installer
reaches it. OpenTUI's own environment switches (`OTUI_*`, `SHOW_CONSOLE` — one
appends every raw stdin byte to a file) are cleared by `scripts/install.ts`
before the UI loads.

**The pin.** `@opentui/core` is pinned EXACTLY in `package.json`
`dependencies` (the latest stable at the time, 0.6.1): the package is pre-1.0,
so a minor release may change the API. Dependabot proposes bumps; a bump is
taken with the TUI gates green. The lock carries the native build of every
target (darwin arm64/x64, linux arm64/x64, glibc and musl).

## The step loop (one loop, two executors)

`step_loop.ts` is the resumable loop both executors drive: the ENGINE executor
(`executor.ts` — the engine steps and its database claim) and the HOST executor
(`host/host_executor.ts` — the production and docker/trial host steps). One
implementation of the rules, so a host step resumes exactly as an engine step
does:

- recorded `done`: a step with a `verify` must still verify, or the run is refused
  as drift (`step <id> was recorded done but its outcome is missing …`); a step
  without one is skipped;
- recorded `running` or `failed`: a `verify` that passes means the work landed
  before the checkpoint — the step is **adopted** (marked done, skipped) unless it
  is `neverAdopt` (the seed restore); otherwise it runs again;
- pending: intent → run → created → verify → done, checkpointed around it.

The loop knows nothing of what a step does; the driver's `perform` runs it. Also
here, shared by both executors: the fault seam (`DEDALO_INSTALL_FAULT`), the
event emitter, the console redaction and the stopping of children on a signal.
It is config-free — the root process of the production route loads it.

## The host executor

`host/host_executor.ts` runs a host route's plan through the same loop, with the
same state schema, in its **own** run directory, so two processes never share a
state file and root never writes into a directory the instance user owns:
`/var/lib/dedalo-install/<instance>/` on production (`0700`, root),
`<checkout>/.dedalo-install/` on docker and trial. Modes: **fresh** (refuses an
existing record; production refuses without root, naming the `sudo sh install.sh`
form), **resume** (the saved plan and the frozen facts; a step whose commands no
longer equal the ones the run showed is refused) and **abort** (reverse order,
only what `created` lists — and once the engine child completed, only the host
steps after it: a live install is never taken apart).

| Module | What it owns |
| --- | --- |
| `host/contract.ts` | what a host step is: a PURE `commands(ctx)` (plan + frozen facts → the exact commands), `run`, `verify`, `undo`, `intent`, `created`. **Review equals run**: the Review lists `commands()`, the run executes exactly them; an `unless` probe makes a re-run after a kill converge. Nothing secret is in a command — a secret reaches a child only as `stdin: {secrets}` |
| `host/execute.ts` | the one place a command becomes an effect and the one place it becomes a Review line; `as: instance\|postgres` becomes a `runuser -u <user> --` prefix |
| `host/runner.ts` | the one spawner: absolute binaries only (from the OS row's closed table, never a `PATH` lookup), a fixed environment (no `DEDALO_INSTALL_*` reaches a child), secrets on stdin, bounded output and time, every child registered so a signal stops apt, dnf and certbot too. Its recording twin answers argv from a response table and logs every request |
| `host/fs.ts` | every file a host step touches: atomic writes, mode and owner set by descriptor before the rename, no symlink followed, owners by name from the root's own `passwd`/`group` |
| `host/facts.ts`, `host/os_support.ts` | the read-only measurement of the machine (OS row, privilege, web server, PostgreSQL, what already exists under this instance's names, SELinux, the firewall) and the supported OS rows — exact `ID` and major version, newest releases only |
| `host/layout.ts` | every path and name of one production instance, from the instance name |
| `host/review.ts` | the Review's host commands: the facts measured now, then every step's `commands()` for them |
| `host/host_table.ts` | the exhaustive step-id → definition table (production rows in `host/production/`, stack rows in `host/stack/`) and the digest `host_preflight` freezes |
| `host/registry.ts` | `/var/lib/dedalo-install/instances/<i>.json`: the refcounts of the shared resources (template units, a Bun pin, the SELinux module, the nginx media map) |
| `host/systemd/render.ts` | the template units (`deploy/systemd/*@*`, only OS-row values substituted) and the per-instance drop-ins; every `Environment=` value quoted; no root line beside the instance's `.env` |
| `host/web/{nginx,apache,site,clash}.ts` | the one site file per instance, the validated media-rule copies and the host-wide map include, and the clash scan (only `(file, names, ports)` tuples kept from `nginx -T` / `-S`) |
| `host/stack/*` | the docker/trial steps, the compose invocation (`-f <stack> -f compose.override.yaml --env-file .dedalo.env`, the same argv `deploy/dedalo-image-lib.sh` emits) and the image verification |

### Engine delegation

The host process never runs an engine step itself. `host_engine` (production)
starts ONE child as the instance user in the instance's own tree —
`runuser -u ded_<i> -- <bun> run scripts/install.ts --request-stdin --execute --events-jsonl [--resume]` —
and `stack_engine` runs the same command in a throw-away container
(`docker compose … run --rm -T dedalo …`). The request (the engine answers — the
host answers minus `HOST_ONLY_ANSWER_KEYS`, plus `engine_only` and, on production,
the OS row's `pg_bin_path` — and the secrets) is ONE JSON object on the child's
standard input. Its log lines and step events come back as JSON lines and are
relayed, redacted; the one-time salt arrives as a `show_once` frame the front end
shows once and never stores. `verify` asks the child (`--status --json`); `undo`
is the child's own `--abort`, which refuses a sealed install.

### Seams

All read from the **process** environment only, never from `../private/.env`:

- `DEDALO_INSTALL_FAULT=<step>:before|after` — the resume drills' SIGKILL point, in the loop.
- `DEDALO_INSTALL_HOST_ROOT` — the HostFs root becomes this directory **and** the
  runner becomes the recording runner, in the same move; a root without the
  `.dedalo_install_scratch` marker is refused. In-process gates inject the runner
  and the fs directly.
- `DEDALO_INSTALL_PROBE_CA_FILE` — the public probe's trust anchor, accepted only
  inside a directory marked `.dedalo_install_drill`.
- `DEDALO_INSTALL_RELEASE_IDENTITY` — the installer's release identity
  (`7.0.0`, `7.0.0-beta.7`, `7.0.1-dev`), pinned so a check tests each kind on any
  commit: the image tag, the official-image decision and the preselected source
  follow from it (`src/core/install/installer_identity.ts`). Honoured only in a test
  process and only for an identity of the installer's own data version; anywhere
  else the installer refuses to start.

### Drills

- `bun run drill:install-host` (`scripts/install_host_drill.ts`, opt-in, never part
  of `bun test`): a privileged systemd container of the newest supported release
  (`--os debian|ubuntu|alma`, `--web nginx|apache`), decoys planted, the bootstrap
  run as root and killed after every host step in turn, resumed each time, then
  checked from outside (units, timers, `nginx -t`, `/health` over HTTPS through
  the drill CA, the decoys byte-equal) and aborted on the live instance.
- `test/unit/install_host_resume_drill.test.ts` and `install_resume_drill.test.ts`:
  the same kill-and-resume over a marked scratch host and over the engine steps.

## Gates

`test/unit/install_*.test.ts` and `seed_build_native`: the seed compiler and its
content contract (`install_seed_contract_native` holds the committed seed to it, and
`install_seed_manifest_tripwire` to its manifest and sources; `install_seed_drift_tripwire`
holds the compiler's TLDs = `CORE_ONTOLOGY_TLDS` = the catalog default of
`ACTIVE_ONTOLOGY_TLDS` and the core's dangling dependency references to
`engineering/install_seed_contract.json`), the fail-closed boot (`install_state_boot`,
subprocess imports; `no_install_surface_tripwire`, the real server spawned), the `.env` write
contract, the seed restore + Argon2id root pw + login (real scratch DB), the
hierarchy import, the seed drift tripwire, and the full CLI **e2e ending in a
verified root login** (asserting `lg` active with zero `lg` rows in
`matrix_hierarchy`, and one data-carrying manifest entry installed with its
registry row written from the entry). The thesaurus manifest:
`hierarchy_manifest_format` (the strict reader, hermetic), `hierarchy_census_native`
(the export census, on the suite database), `install_seed_drift_tripwire` (the
vendored `hierarchy.json` parses, every listed file matches its sha256, every
vendored file is listed, no `lg` data file, the retired files absent, the seed
registry = the core rows), `install_hierarchy_activate_native` and
`hierarchy_import_atomic_native` (a row written from the entry, a bad language
id, a checksum mismatch, an empty thesaurus — each refused or applied with
nothing partial). `install_plan_parity_tripwire` holds flags, the answers record and the answers file to one plan;
`install_core_hierarchy_native` proves the core activation needs no import;
`install_sh_portability` holds the stack disk probe to its POSIX `df -Pk` form and
`install.sh` to POSIX sh; `install_bootstrap_sh` holds the bootstrap's refusals
(kernel, musl, CPU, the release sha256, the Bun hash table) and its exec of the
installer; `install_sh_image_source` holds the image-source decisions of the shared
host library (`deploy/dedalo-image-lib.sh`). The ontology half: `install_ontology_choice` (the closure,
hermetic), `install_hierarchy_dependencies_native` (the `install_hierarchies` step never
forces a declared thesaurus, over a real registry row, on the suite database),
`ontology_references_native` (the classifier and codec, hermetic),
`ontology_manifest_native` (the manifest client against a loopback stand-in
master, hermetic), `ontology_dependencies_native` (`hierarchy60` → census →
manifest, on the suite database), `vendored_ontology_closure_tripwire` (the built-in `oh` is
installable alone over the core seed, and every declared thesaurus dependency
names a `hierarchy.json` entry, hermetic) and
`install_ontology_door_native` (both steps driven for real on the suite database
against a loopback master: closure order, undeclared warning, local
directory/archive, preflight refusals with the database untouched, tampered
staging, `matrix_dd`). Tests never name a real domain ontology's structure: they
build zz TLD packages (`src/core/test_data/ontology_package_fixture.ts`).

The interactive front ends: `install_screen_model_tripwire` (the model), the
plain mode's `install_plain_parity_tripwire` / `install_plain_secrets_tripwire`,
and the full screen's `install_tui_parity_tripwire` (driven by key presses over
the same matrix: the same plan, the same asks), `install_tui_secrets_tripwire`
(no secret on any frame or renderable; the salt only on Done),
`install_tui_restore_tripwire` (every exit path on a real pseudo-terminal: the
code, every terminal mode undone, `stty` sane), `opentui_confinement_tripwire`,
`install_tui_frames` (the mockup's layout at 104×30, 96×27 and 80×24) and
`install_executor_events_native` (the step events).

The host routes: `install_host_steps_native` (every production step over a
scratch host and the recording runner), `install_host_render_tripwire` (the
rendered units and site, the templates on disk equal to the rendered set, no root
line beside an `EnvironmentFile`), `install_host_selinux_native` (what the
`dedalo_engine` module grants, against the old broad rule as a control),
`install_host_privilege_tripwire` (what the root process may import and write),
`install_host_resume_drill`, `install_stack_steps_native` (the docker and trial
steps). `install_step_table_native` holds the engine's one step table.
