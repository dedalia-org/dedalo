# Close v6 / Prepare installation for v7

An **isolated, self-contained migration package** that rewrites a **Dédalo v6** PostgreSQL
database into the **v7 data model** — delivered as a v6 maintenance widget labelled
*"Prepare installation for v7"*. After it runs, the pure‑TypeScript v7 engine boots on the
same database with the schema and derived stores already in place.

## Why it is built this way

The migration logic (data reformat, schema restructure, dataframe/relation/string‑search
provisioning) is **v7‑aware**: it needs classes like the columnar `matrix_db_manager`, the
`dd_ontology`‑aware `ontology_node`, v7 component models, and `DEDALO_VALUE_TYPE_*` constants.
A live **v6** install ships its **own** classes with the **same names**, and two classes of
one name cannot coexist in a single PHP process.

**Isolation strategy:** the v6 widget does *not* load any of this code in‑process. It writes
the bundled engine's DB credentials and **spawns a separate PHP process** that boots the
**engine bundled in this package** (its own autoload root + `config/bootstrap.php`), pointed at
the **v6 database**. Separate process ⇒ zero class‑name collision, and the *tested* migration
code runs verbatim instead of being re‑derived.

**Self‑contained by rule:** everything the migration needs ships here — `engine/`, `run/`,
`widget/` are all tracked. There is no build step, nothing to regenerate, and no reference to any
other repository or install: the package runs from a plain v6 checkout. `verify_package.sh`
enforces exactly that.

## Package layout

```
close_v6_prepare_v7/
├── engine/     the bundled PHP engine that performs the migration (isolated runtime)
├── run/        CLI runner
│   ├── run_prepare_v7.php          orchestrator (sequences the phases as child processes)
│   ├── phase1_backup_pre_update.php backup + pre_update (or --dry-run preflight)
│   ├── phase2_update.php            full update_version(all steps) incl. store backfills
│   ├── phase3_diffusion.php         diffusion ontology migration (isolated, LAST step)
│   └── lib/{engine_boot,blocking_backup,version_gate}.php
├── widget/prepare_v7/  v6-facing launcher (class.prepare_v7.php + js/)
├── private/    .env auto-migrated from the v6 config on first boot — runtime, never committed
├── var/        logs (prepare_v7.log) + backups — runtime, never committed
├── cache/ sessions/ backups/   runtime, never committed
├── verify_package.sh   proves the package is complete and self-contained
└── README.md
```

There is exactly ONE copy of every file: the package is what runs.

## Prerequisites

- The v6 install must be at data version **6.9.1 or later, and below 7.0.0** — `update_from` in
  the migration descriptor is a *minimum*, so an install kept current (6.9.2, 6.9.3, …) migrates
  without touching the descriptor. The runner's preflight enforces the range and refuses outside it.
  The engine itself still selects the descriptor by an **exact** `update_from` match, so when the DB
  is past the minimum the runner exports `PREPARE_V7_UPDATE_FROM=<db version>` and the descriptor
  aligns to it (`engine/core/base/update/updates.php`). The override can only *raise* `update_from`:
  a DB below 6.9.1 can never be forced through.
- The v6 **ontology update** must have been run, so `jer_dd` holds the machine-name nodes
  `ontology43` (machine name) and `ontology44` (use machine name). They arrive by ontology update,
  not data update, so the data version cannot prove them: the runner checks the outcome, in phase 1
  (panel and CLI, every mode) and again in phase 2, before any write, and refuses with **exit 10**
  ("run the ontology update first"). No flag skips it.
  (The plan raises the data-version floor to 6.9.8 together with those definitions; it stays 6.9.1
  until a v6 6.9.7→6.9.8 data rung exists — today no install can reach 6.9.8, so the floor
  would refuse everyone.)
- PostgreSQL client tools (`pg_dump`) reachable at the engine's `DB_BIN_PATH` (mandatory backup).
- Superuser (`DEDALO_SUPERUSER`) + **maintenance mode** enabled (guards mirror the current
  update widget).
- PHP CLI available to the web/maintenance user.

## The bundled engine

The engine lives at **`close_v6_prepare_v7/engine/`** (~47 MB) and is part of this repository.
**There is no build step**: copy the folder and it runs.

The bundled `engine/` is slimmed to what the migration actually runs. Stripped top-level dirs
(none on the migration execution path):
`media*`, `backups`, `node_modules`, `docs`, `mcp`, `mockup`, `security-audit`, `test`,
`tools`, `downloads`, `download`, `analysis`, `lib` (front-end/JS assets + wkhtmltopdf/xlsx),
`vendor` (composer: mailer/SAML/RDF/phpunit), `code`, `worker`, `dev`, `local`, `publication`,
all top-level hidden entries (`.git`, `.github`, …), and every per-install secret/config
(`.env*`, `config/config*.php`, `config/config_areas.php`). **Security:** quarantine backups
(`*.bak`, `*.pre-cutover*`, `*.cutover*`) and the dev boot-diff dir `config/bootstrap/`
(its `dev/snapshots/*.json` capture live config incl. real DB passwords) are excluded — they must
never ship. All unused **top-level files** are stripped too (docs, `composer.*`,
`phpstan*`, `mkdocs.yml`, `cliff.toml`, `config.codekit3`, `quick-lint-js`, `favicon.ico`,
`v7_dump.json`, `stub.php`, and the web front controller `index.php` — anchored, so
`core/**/index.php` stay). The engine top level is therefore ONLY the load-bearing dirs:
**`config`, `core`, `shared`, `install`, `diffusion`** (no top-level files).

**Why this package carries its own `.gitignore`:** the repo-root `.gitignore` has a blanket
`config/*` rule (a v6 install keeps its secrets in `config/`), which would swallow this package's
`engine/config/` and `engine/core/base/config/` — both of which are *source*, not per-install
state. Historically their files only reached the branch through `git add -f`, so any new file went
missing without a word. The package `.gitignore` re-includes them (`!**/config/`, `!**/config/**`)
and then re-ignores the generated, secret-bearing ones (`config.php`, `config_*.php`, `.env*`,
`config/bootstrap/`). **Order matters**: every runtime/secret pattern must stay *below* the
negation lines, or it stops applying inside `config/`. `verify_package.sh` still asserts that a
runtime `config_db.php`/`.env*`, if present, is git-ignored.

Two more root rules swallowed package source the same way and are re-included alongside it:
`acc` (root line 25) hid `engine/core/db/acc/` — the legacy v6 record classes `build_package.sh`
ships (`RecordObj_dd`, `JSON_RecordObj_matrix`, `RecordDataBoundObject`, `RecordObj_time_machine`,
`search_v6`) — and `backups` (root line 101) hid
`engine/diffusion/migration/helpers/backups/`, the hand-written parity-baseline restore SQL
(`helpers/.gitignore` ignores only `out/` and `baseline/`, so `backups/` was always meant to be
source). The package-root `/backups/` quarantine stays ignored — different path, and it holds the
imported v6 config, i.e. the DB password.

**Adding anything to the package?** Check `git check-ignore -v <path>` before assuming it is in
the branch. The root `.gitignore` is written for a v6 *install*, not for a vendored engine, and it
also carries `des`, `temp`, `write`, `tpl`, `test`, `*.data` and `str_data*` — any of which can
silently eat a future file here.

Per-module client assets `core/*/css` and `core/*/js` are stripped too (no PHP reads them; the
CLI migration serves no UI), as are the UI modules `core/area*` and `core/button*` (not on the
migration path — reformat routes by model string and never instantiates them; the boot-loaded
`dd_area_maintenance_api` lives in `core/api/`, not here), and `core/rag` (the RAG vector
subsystem — a v7 feature dormant unless `DEDALO_RAG_ENABLED`; its `dd_rag_api` is in `core/api/`).

Further unused `core/` submodules are removed: `dd_mailer` (email; needs the stripped `vendor/`),
`extras` (project-specific ontology extras), `services` (UI services), `themes` (UI themes),
`dd_grid` and `widgets`. The last two are **boot-eager-included**, so `build_package.sh` also
neutralizes their now-dead `include` lines in the **copied** `core/base/class.loader.php`
(a post-copy `sed` — the frozen source loader is never modified). None are on the migration path.

`diffusion/` is reduced to **`diffusion/migration/`** (the v6→v7 diffusion-ontology update
scripts) **plus the top-level `diffusion/*.php` classes** — the latter can't be dropped because
the loader eager-includes ~10 of them and autoloads `diffusion_*` from there (boot dies without
them). The `api/`, `parser/`, `service/`, `acc/` subdirs are removed (`api/`'s weight was
`node_modules`, already excluded).

`install/` is reduced to **`install/db/*.sql` + `install/*.php`**. The store DDL twins
`matrix_string_search.sql`, `matrix_relation_index.sql` and `matrix_activity_diffusion.sql` are
read at runtime (`file_get_contents(DEDALO_ROOT_PATH.'/install/db/…')`) by the three
`v6_to_v7::create_*` steps; the `install/*.php` **config-migration classes** (`config_auto_migrate`
+ deps, ~120K) are kept so the engine can import the v6 config (see "Configuration" below). The
355 MB of `.gz` dumps + `import/` under `install/` is dropped. Other notes: `tools/`'s only caller `update::components_update()` is unused by the
single 6.9.1→7.0.0 descriptor; `vendor/autoload` is never required at boot; the AV
`core/media_engine/lib` (ffmpeg/color profiles) is under `core/`, not the stripped top-level
`lib/`, so it stays. **Verified:** the slimmed engine boots standalone and loads every
migration class.

The engine was slimmed once, by hand, and is now maintained IN PLACE — edit it here like any
other code in this repo. Nothing regenerates it, so nothing can silently replace it with a copy
from elsewhere. To confirm the package is still complete and self-contained:

```bash
close_v6_prepare_v7/verify_package.sh
```

It checks that the load-bearing files exist, that every eager `include` in the bundled loader
resolves inside the package, that no file references another repository, and that the runtime
config (which carries the DB password) is not committed.

## Deploy into a v6 install

1. Copy the `close_v6_prepare_v7/` folder into the v6 server (anywhere readable/writable
   by the maintenance user — **preferably outside the web root**; if it must live inside, deny
   HTTP access to it, as the shipped `.htaccess` does in this repo).
2. Copy `close_v6_prepare_v7/widget/prepare_v7/` (class + `js/`) into v6's
   `core/area_maintenance/widgets/prepare_v7/`. The class resolves the package from its own
   location; if the package lives elsewhere, set `PREPARE_V7_PACKAGE_ROOT` (or install a shim
   like this repo's `core/area_maintenance/widgets/prepare_v7/class.prepare_v7.php`, which sets
   it and requires the package class).
3. Register the widget in v6's `area_maintenance::get_ar_widgets()` with `id = 'prepare_v7'`
   (that id is what makes v6 load both `class.prepare_v7.php` and `js/prepare_v7.js`).

No JS wiring is needed: the widget talks to v6's own maintenance API
(`dd_area_maintenance_api` → `get_widget_value` / `widget_request`).

## Run

### From the widget
Maintenance area → **"Prepare installation for v7"**. The panel shows the readiness snapshot
(database, data version in DB, code version, package/engine paths, PHP CLI binary, superuser +
maintenance-mode checks). **All actions are hidden unless Dédalo is in maintenance mode**; when it
is, four buttons appear:
- **Run preflight (safe, no writes):** spawns `--dry-run` — version gate, DB connectivity,
  pg_dump usability, and a data‑review pass. See the limits below.
- **Deep preflight (backup + ontology, then data review):** spawns `--deep-preflight`.
- **Prepare installation for v7 (migrate):** confirms, then spawns the real run.
- **Refresh log:** re-reads the log tail on demand.

### Deep preflight — the review that can actually see your data

The plain preflight runs *before* `dd_ontology` exists, so no component model resolves and every
value reports `Ignored empty model`: it verifies the environment, not the data. The deep preflight
fixes the ordering:

```
backup → pre_update → data review (save=false) → diffusion mapping preview → STOP
```

`pre_update` only **adds** the v7 ontology: new `jer_dd` columns filled from the legacy ones
(`terminoID` → `tipo`, `relaciones` → `relations`), which stay untouched, plus the new
`dd_ontology` table — and one v6-affecting change, `matrix_notifications.datos` renamed to `data`.
**The matrix tables are not rewritten.** It is guarded/idempotent and the v6 source data is intact,
so the ontology can be rebuilt and phase 2 continues from this state whenever you are ready.

What it gives you that `--dry-run` cannot: real data issues (models resolve), and the full
diffusion mapping preview. It writes, so it needs superuser + maintenance mode, and it takes the
same mandatory backup as the real run.

Each launch rotates `var/prepare_v7.log` to `var/prepare_v7.log.previous`, so the panel always
streams the current run; it polls every 5 s until the runner writes a terminal line.

### The three kinds of finding

Most of what a review turns up is not a decision. `core/base/upgrade/class.v6_to_v7_normalize.php`
repairs the mechanical defects **in memory** and sorts every finding into one of three buckets,
which the summary block and the widget's chips report separately:

| Bucket | Meaning | Blocks? |
|---|---|---|
| **AUTO-FIXED** | Repaired automatically. The commonest by far is a component value stored as the bare language map (`{"lg-nolan":[…]}`) instead of `{"dato":{…}}`; it is wrapped. Empty values (`{}`) are skipped. On an upgraded install most of the count is usually the studio default map view — see below. | no |
| **NOTICES** | Cannot be migrated and will be dropped — typically an *orphan tipo*: referenced by matrix data but absent from `jer_dd`, so no model resolves — or kept exactly as it is and only reported (the `MACHINE_NAME_*` notices, see below). Nothing to repair. | no |
| **NEEDS ATTENTION** | The ontology model and the stored shape disagree (the report names both: "the ontology says `button_new` but the value was written as `component_input_text`"). A person has to decide. | **yes** |

Because NEEDS ATTENTION is the bucket somebody has to open, each of its groups also lists **every
record it touches** and a ready-to-paste statement per table:

```
   14 × Bad component data [2]. Expected object. … tipo: 'ich147' … model: button_new
        written as: component_input_text · ontology now says: button_new
        records in matrix_dd · section_tipo ich145 · section_id: 1, 2, 3, 4, 5, 6, 7
        SELECT * FROM matrix_dd WHERE section_tipo = 'ich145' AND section_id IN (1, 2, 3, 4, 5, 6, 7);
```

Ids are de-duplicated (14 findings across 7 records, two languages each) and sorted numerically;
the list is capped at 200 per table + section_tipo, and says so when it truncates. The other two
buckets deliberately collect no ids — they routinely span hundreds of thousands of rows and are
meant to be counted, not visited. `var/data_review.json` carries the same `locations` and `sql`
fields per group.

The repairs are applied by the *same* function the migration runs (`reformat_matrix_data`, with
`save=false` for the review), so the report is not a prediction: it is what phase 2 will do. The
legacy `datos` column is never rewritten — with ONE exception, the ontology machine names below.

Exit code: **0** clean or only auto-fixed/notices · **6** something needs attention.

### Ontology machine names (`migrate_ontology_machine_names`)

v7 gives every ontology node a language-free **machine name** (`ontology43`, lg-nolan) and a
**use machine name** flag (`ontology44`, dd64: 1 Yes / 2 No). Model definitions and the nodes whose
term is read by code are names; everything else is a label. Legacy data is converted here, in the
v6 upgrade; v7 converts nothing. The step runs in phase 2 right after `pre_update` and **before**
`reformat_matrix_data`, and writes **v6-shaped** values into `matrix_ontology.datos`, so the
normal conversion types them like any other component. The preflight reviews it with `save=false`
first, then arms `set_machine_name_review()` so the data review converts the ontology records
with the same values applied in memory (the real run's input).

- **Name class**: strict descendants of `dd2`, or a node whose model is one of database,
  database_alias, table, table_alias, matrix_table, the 11 `field_*`, diffusion_domain,
  rdf:predicate / subject / object, owl:ObjectProperty, owl:Class (the list is a copy; the v7
  engine is its source of truth and re-checks every node after the upgrade). A localontology0
  override is classified by the merged model.
- **Values already present are kept**; a disagreement is reported (`MACHINE_NAME_FLAG_MISMATCH`,
  notice). Only gaps are filled, and a name only on a name-class node: a stored Yes on a label
  node without a name keeps `ontology5` untouched → `MACHINE_NAME_MISSING` (needs attention).
- **Name, no value**: `ontology43` = the `ontology5` lg-spa term, which is **removed** from the label
  (other langs stay; differing ones → `MACHINE_NAME_LABEL_KEPT`), flag Yes. No lg-spa but one
  distinct value elsewhere → moved, `MACHINE_NAME_FROM_<LANG>`. Several distinct values (or several
  lg-spa items) → flag Yes, no name, **`MACHINE_NAME_AMBIGUOUS` (needs attention)**: never picked.
  No term at all → `MACHINE_NAME_MISSING` (needs attention).
- **Every other node**: explicit flag No.
- **Overrides** state only what they override: one without its own term or model is left alone,
  only an lg-spa override value moves (`MACHINE_NAME_OVERRIDE_NOT_SPA` otherwise). An override
  that makes a label main node a name without an lg-spa term of its own → `MACHINE_NAME_MISSING`.
- **Time Machine**: the `ontology5` lg-spa rows of every node left with a name and no lg-spa label
  are re-keyed to `ontology43` / lg-nolan (tipo + lang only, the value is untouched), while the TM
  table is still v6-shaped, so history restores into the new component. No TM row is written for
  the move itself. Whole-record snapshot rows (deleted records) still carry the old shape.
- Idempotent; only a database failure fails the step (`stop_on_error`), before anything is converted.

### The studio default map view (why AUTO-FIXED can read 50 000+)

A `component_geolocation` item holds two independent things: a **view** (`lat` / `lon` / `zoom` —
the map framing the operator panned and zoomed to) and the **features** they drew (`lib_data`). The
view is not a feature and a feature does not set the view.

The v6 edit view opened on a fixed factory position — lat `39.462571` / lon `-0.376295`, the Dédalo
facilities' own coordinates — and its save button consulted no dirty signal. So opening a record and
pressing save stored a view nobody chose. That pair is a **factory default, not a place**: nobody
frames a map on the studio to six decimals, and a record merely *named* after the studio's city
carries it for the same fabricated reason as any other.

The v6 update **removes the old default data, and nothing more**:

| Stored item | Migration |
|---|---|
| the default view, **no** features | the whole item is **removed** — nothing in it was operator data. Its `alt` goes with it |
| the default view, **with** features (a `lib_data` layer holding features) | the features are kept untouched and the **view is fitted to them**: the bbox centre of every feature on that item. `zoom`, `alt`, `lib_data` and `id` are preserved byte for byte |
| anything else | untouched. `0 / 0` is a legal view; no other value is special-cased |

Fitting a view to the item's own features is not authoring a location — it is what a view is for.
For a single drawn Point the fitted view IS that point. Features that yield no position leave the
item untouched, never guessed.

Counts are visible in the deep preflight — chips + `var/data_review.json` — **before** phase 2
writes anything, with the removed and the fitted groups counted separately. A *plain* preflight
cannot see them: without the ontology no model resolves, so no geolocation finding is raised.
Neither does the review cover `matrix_time_machine`, which phase 2 converts unreviewed.

`--no-auto-fix` re-runs a preflight with the repairs off, to see the raw picture. It is a
diagnostic switch only — phase 2 always repairs, because the repairs are what carry the affected
values into the v7 columns.

Every review also writes `var/data_review.json` (counts + groups) next to the log; that is what the
widget reads for its chips, so the log stays prose.

### Headless (equivalent)
```bash
php close_v6_prepare_v7/run/run_prepare_v7.php --dry-run          # preflight, no writes
php close_v6_prepare_v7/run/phase3_diffusion.php --dry-run        # diffusion mapping preview (needs dd_ontology)
php close_v6_prepare_v7/run/phase4_passwords.php --dry-run        # credential conversion preview (writes nothing)
php close_v6_prepare_v7/run/run_prepare_v7.php --deep-preflight  # backup + pre_update + REAL data review, stops before the rewrite
php close_v6_prepare_v7/run/run_prepare_v7.php --dry-run --no-auto-fix  # same review, structural repairs OFF (diagnostic)
php close_v6_prepare_v7/run/run_prepare_v7.php --yes              # backup + migrate
php close_v6_prepare_v7/run/run_prepare_v7.php --yes --skip-backup   # only if you already backed up
php close_v6_prepare_v7/run/run_prepare_v7.php --help
```
`--yes` is required to write anything. For headless runs, first make the engine see the v6 config
(see **Configuration** below).

## Configuration — uses the v6 config

The bundled engine runs against the **v6 database using the v6 configuration**. v6 and the v7
engine share the same DB constant names (`DEDALO_HOSTNAME_CONN`, `DEDALO_DATABASE_CONN`, …), and
the engine imports the rest via Dédalo's own legacy‑config auto‑migration:

- **From the widget (automatic):** the widget runs inside a booted v6, so it writes a **literal
  snapshot** of the live v6 constants (DB, identity, lang, runtime, state, defaults, diffusion —
  never `paths`) into `engine/config/config_db.php`. On the next engine boot, `bootstrap.php`
  detects it and runs `config_auto_migrate`, generating a complete `../private/.env` + `state.php`
  (DB creds + langs + entity + install status), then **quarantines** the snapshot out of the engine
  tree into `<package>/backups/config_migration/…`. Path constants are never exported, so v6 paths
  cannot override the bundled engine's own — verified.
  The snapshot is written instead of *copying* the v6 config files because `config_auto_migrate`
  reads its sources statically (a tokenized `define()` scan) and can only migrate **literals**:
  on installs where `config/config_db.php` is a stub that `include`s `../private/config_db.inc`,
  a copy would yield zero constants. The generated file and the quarantined copies carry the DB
  password — they are `0600`, live in the gitignored package dir, and are rewritten on every launch.
- **Headless:** copy your v6 install's `config_core.php` + `config_db.php` into
  `close_v6_prepare_v7/engine/config/`, then run the runner. The first boot auto‑migrates them. (The
  legacy files are read *statically*, a tokenized `define()` scan — never executed.)

`config_auto_migrate` refuses if a secret looks non‑literal (a safety gate); a normal v6
`config_db.php` with a literal password migrates cleanly.

## What the migration does (all reused from the frozen engine)

1. **Phase 1** — blocking full `pg_dump -F c` (**aborts on failure** unless `--skip-backup`),
   then `update::pre_update_version()` → creates `dd_ontology` from `jer_dd`.
2. **Phase 2** (fresh process ⇒ clean ontology cache) — `update::update_version()` with every
   step enabled: schema DDL, the ontology machine names, `reformat_matrix_data`, time‑machine migration, dataframe/relation
   migration, drop legacy `datos`, and finally the derived stores
   `matrix_activity_diffusion`, `matrix_string_search` and `matrix_relation_index`
   (tables + sync triggers + **backfill**). On success the new version is recorded in
   `matrix_updates`.
3. **Phase 4 — credentials → Argon2id.** v6 does not hash passwords: it stores REVERSIBLE
   AES (`component_password::encrypt_password` → `dedalo_encrypt_openssl`). The v7 engines take
   one-way hashes only — the TS server refuses such an account ("still has a legacy (pre-Argon2)
   password hash") and the PHP engine upgrades it lazily on the next login, a path that no longer
   exists after the cutover. This phase converts every account eagerly, reusing the engine's own
   `component_password` methods, so the hashes are exactly what the PHP engine would produce.
   The migration is the last moment the plaintext is recoverable — afterwards the database holds
   only hashes, which also closes a v6 weakness. Idempotent; a row is written only when the
   plaintext was recovered AND the fresh hash verifies against it; no plaintext is ever logged.
   Argon2 is a PHP **build** option (`--with-password-argon2`), not a version feature, so the
   phase checks this install's PHP first and refuses (exit 8) rather than writing hashes the
   engines could not verify. Both preflights preview it.
4. **Phase 3 — diffusion ontology (LAST step, isolated).** Has a **`--dry-run`**: it computes and
   prints the whole v6→v7 mapping (the `V6: … / V7: …` pair per node, plus what would be stored)
   and writes nothing. It needs `dd_ontology`, which the real phase 1 builds, so on an unmigrated
   database it reports "preview unavailable yet" and exits 0 — the preflight runs it and is never
   failed by it. The full per-node output goes to `var/diffusion_migration.dry-run.log`
   (real runs: `var/diffusion_migration.log`), never to the throttled main log. Runs
   `diffusion/migration/migrate_diffusion_properties.php` as its own engine process. This is a
   **separate, still‑evolving** migration axis — NOT part of `update::update_version()` — that
   rewrites `dd_ontology.properties` (+ `matrix_ontology`) from the migrated v6 `propiedades`
   (populated in phase 1). It writes unconditionally, so it runs **only in the real run** (no
   dry‑run). It is **non‑fatal**: phases 1–2 are already version‑stamped, so a diffusion failure
   is reported (exit 7) with a re‑run hint rather than failing the DB migration. The `rdf`/`xml`
   filename migrators under `diffusion/migration/` are separate on‑disk‑file steps and are **not**
   auto‑run (each supports its own `--dry-run`).

Phases 1–2 are **idempotent** (`IF NOT EXISTS` / `OR REPLACE`, backfills are `TRUNCATE + INSERT`),
so a re‑run after a partial failure is safe.

## What the preflight can and cannot tell you

It reviews **exactly the tables the real run reformats**, read from the descriptor itself
(`run_scripts → reformat_matrix_data → script_vars[0]`), not from a discovery query: reviewing
more is not extra safety, it crashes (e.g. `matrix_notifications` has no `section_tipo` column,
and `process_matrix_row_data()` takes it as a non-nullable `string`). Tables that still carry a
legacy `datos` column but are *not* on that list are reported as left-untouched.

It runs **before** `dd_ontology` exists (the real phase 1 creates it), so no component model
resolves and every value produces an orphan-tipo report. Those are discounted and reported as one
count, and the widget marks the verdict *models not checked*: what remains is a purely structural
review (bad locators, malformed `datos`, …).
**Component models can only be validated by a preflight run after a real phase 1** — that is what
the deep preflight is for.
For the same reason PHP's `error_log` would receive one entry per row, so error logging is
suspended for the review pass only (it was writing tens of GB).

Phases **fail loudly**: the engine installs its own exception handler, and PHP exits with code
**0** once such a handler returns — an uncaught throwable used to look like success. Every phase
installs `prepare_v7_fail_loud()`, which chains the engine handler, logs the throwable and exits 9.

The runner distils each phase's per-row stdout into one `progress:` heartbeat every 10 s (plus the
final line); **stderr is never throttled**. Streaming it verbatim produced a 285 MB log for one
dry run.

## Verify

- Preflight exits 0 with no data errors.
- After a real run: a `.backup` file exists in `var/backup/`; `dd_ontology` is populated; the
  legacy `datos` column is gone; `SELECT count(*)` on `matrix_string_search` and
  `matrix_relation_index` is non‑empty and their `*_sync` triggers exist on content tables.
- Boot pure‑TS v7 on the migrated DB → it serves and relation/inverse search works, with the
  two stores already present (no boot‑time self‑heal backfill needed).

## Notes / limits

- **v6 login survives the long tail — for MONITORING, not editing.** The legacy `datos` cleanup
  is SPLIT into two steps. `[1/2]` drops it from the 20 **record** tables at its original
  mid-pipeline position, right after `create_matrix_activity_diffusion_table`. `[2/2]` drops it
  from the three **auth** tables — `matrix_users`, `matrix_profiles`, `matrix_activity` — as the
  very last step of the descriptor, after the dataframe migrations, the section_id intify sweep
  and the search and relation-index backfills.
  - Why: the v7 typed columns (`data`/`relation`/`string`/…) are ADDED next to `datos`, never
    renamed over it, so while `matrix_users` keeps its column v6 can still authenticate. On a
    large install the tail runs for hours, and dropping `datos` before it locked the operator out
    for the whole window — the browser session expires and v6 can no longer read `matrix_users`,
    so the migration could not even be watched.
  - Why the record tables are NOT included: once `reformat_matrix_data` has frozen the typed
    columns, a v6 save writes only `datos`, which the final drop then deletes — the save reports
    success, v7 serves the pre-edit value, and nothing flags it. Dropping the column early makes
    that save fail LOUDLY with a SQL error instead of silently losing the edit. The split is what
    enforces "monitoring-only"; it does not rely on operator discipline.
  - Still true in that window: a live v6 session can trip the intify sweep's affected-rows assert
    by deleting a record mid-batch (`stop_on_error=true`), and an idle-in-transaction v6 backend
    can make the final `DROP COLUMN` (ACCESS EXCLUSIVE) queue and block other v6 queries. Putting
    the install behind maintenance mode for the duration is still the safest operating posture.
  - "Usable" is not the claim: component locking and the process registry read
    `matrix_notifications.datos`, which phase 1 already renamed to `data`, and the
    `delete_v6_db_indexes` → `recreate_db_assets` gap drops user functions and unique indexes.
    Login and the maintenance dashboard work; the rest of v6 is not to be trusted mid-migration.
  - If you add a step, add it BEFORE `[2/2]`.
- **`intify_section_id_locators` throughput.** The section_id→int sweep is normally the longest
  step. It reads each table ONCE (all candidate jsonb columns in the same row, matched inside a
  `LATERAL … OFFSET 0` fence so each column is detoasted once), and writes each batch as a single
  multi-row `UPDATE … FROM (VALUES …)` inside one transaction with `synchronous_commit` off.
  The earlier shape scanned once per column and committed once per row — measured on a 50 000-row
  fixture that is 50 245 transactions vs 213, which is why it used to crawl at a few dozen
  rows/second on a box with slow fsync. The CLI line reports a live rows/s figure. The step is
  idempotent, so if a crash loses the async-commit tail, re-run it.

- Only **6.9.1+ → 7.0.0** is supported, with the v6 ontology update run (exit 10 otherwise) (the single descriptor in `engine/core/base/update/updates.php`,
  read as a minimum — see Prerequisites).
- The runner is spawned with the **PHP CLI** binary from `PHP_BIN_PATH` (the v6 config constant, same
  one `exec_::request_cli` uses), never `PHP_BINARY`: under php-fpm that is the FPM binary, which
  prints its usage instead of running the script. The widget probes it (`php -v` must say `(cli)`)
  before spawning and reports the failure instead of launching into the void.
- In‑place testing against this repo instead of a built package: set `PREPARE_V7_ENGINE_ROOT`
  to an engine root that has its **own** `../private/.env`, so tests never touch a real install.
- The DB password reaches the engine only via the auto‑migrated `private/.env` (generated at
  runtime, gitignored) — never on a command line. The package itself ships **no** secrets:
  `build_package.sh` excludes `.env*`, `config/config*.php`, all `*.bak`/quarantine files, and the
  dev `config/bootstrap/` snapshots (which contained live DB passwords).
