# WC-2026-10-10-hierarchy-json-manifest — the vendored thesauri are described by ONE exported manifest, hierarchy.json

- **Date:** 2026-10-10. The spec was approved by the owner the same day.
- **Decision:** the three hand-written files of the vendored hierarchy
  directory (`install/import/hierarchy/hierarchies.json`,
  `hierarchies_typologies.json`, `hierarchies_to_install.json`) are replaced
  by ONE file, `install/import/hierarchy/hierarchy.json`, EXPORTED from the
  `hierarchy1` registry of a master and shaped like the ontology side's
  `ontology.json`. The `lg` thesaurus keeps its current way entirely: its
  terms live in `matrix_langs` and ship in the seed, so they are never
  exported to or imported from a data file. This entry is written in stages;
  each stage appends what it changes on the wire.

## Shape before (TS)

- **Vendored metadata:** `hierarchies.json` — a hand-written list of
  `{tld, label, typology, active_in_thesaurus, install_checked_default}`;
  `hierarchies_typologies.json` — `[{typology, label}]`;
  `hierarchies_to_install.json` — the bare TLDs whose registry rows the seed
  carried (`install/db/seed/matrix_hierarchy_main.copy.gz`).
- **Readers:** `src/core/install/hierarchy_meta.ts` `readHierarchyJson`
  (failed SOFT to a fallback on a missing or unparseable file).
- **Installer:** the offer was `hierarchies.json` ∩ the vendored
  `<tld>1.copy.gz` files; `install_checked_default` was the shared default
  (wizard pre-ticks, CLI `--hierarchies` omitted / `default`, install.sh); a
  declared MANDATORY `hierarchy1` dependency with no vendored `<tld>1.copy.gz`
  refused the plan. Import read `<tld>1.copy.gz` (required) and
  `<tld>2.copy.gz` (when present) with no integrity check. Activation found
  the seed's registry row, or created one with only `hierarchy6`, an
  `lg-eng` `hierarchy5` and `hierarchy9`.
- **Export panel** (`export_hierarchy` widget, action `export_hierarchy`,
  option `section_tipo`): three scopes — `'*'` (every active hierarchy's
  `hierarchy53` target, one file each), `'all'` (every `matrix_hierarchy`
  row into ONE `all_<Y-m-d_His>.copy.gz`), or a comma-separated tipo list
  checked only for the `^[a-z]{2,}[0-9]+$` grammar (any tipo, active or not;
  `lg1`/`lg2` were dumped from `matrix_langs`). The download route
  `GET /dedalo/install/import/hierarchy/<file>` allowlisted
  `<tipo>.copy.gz` and `all_….copy.gz`.

## Shape after (TS)

### The file (stage A)

`install/import/hierarchy/hierarchy.json` — format, types and the strict
reader: `src/core/ontology/hierarchy_manifest_format.ts` (a pure leaf: zod, the
error leaf and the dependency normalizer only).

```
{
  "version", "date", "entity_id", "entity", "entity_label", "host",
  "typologies": [{ "typology_id": <int>, "name": <string|null>, "name_data": [<item>] }],
  "active_hierarchies": [{
    "tld":                 <string>  — hierarchy6, lowercased
    "name":                <string|null> — hierarchy5, application-lang pick
    "name_data":           [<item>]  — hierarchy5, every stored item
    "typology_id":         <int>     — hierarchy9 → hierarchy13/<id>; must be listed in typologies
    "typology_name":       <string|null>
    "lang":                { "section_id": <int>, "label": <string|null> }
                                     — hierarchy8 → lg1/<section_id>; label = that record's
                                       hierarchy25 term, for humans only
    "real_section_tipo":   <string|null> — hierarchy109; null = the row names none
    "active_in_thesaurus": <boolean> — hierarchy125
    "scope_note_data":     [<item>]  — hierarchy61; [] when the row holds none (never absent)
    "dependencies"?:       [{ "tld", "main": "ontology35"|"hierarchy1", "mandatory" }]
                                     — misc.hierarchy60 via THE shared normalizer
                                       (WC-2026-10-10-ontology-dependencies-hierarchy60);
                                       ABSENT = not declared, [] = declared, needs nothing
    "data_files":          [{ "file": "<tld>1.copy.gz"|"<tld>2.copy.gz", "sha256": <64 lowercase hex> }]
                                     — the dumps present in the export dir when it was written;
                                       [] = an empty thesaurus by design
  }]
}
```

`<item>` is a stored multilingual component item, `{"id"?, "lang": "lg-…", "value"}`
(extra keys kept).

- **The envelope** (`version` … `host`) is built by the SAME function as
  `ontology.json`'s: `src/core/ontology/data_io.ts` `manifestEnvelope`
  (extracted from `updateOntologyInfo`; `ontology.json` bytes unchanged).
- **The reader is strict and loud** (`parseHierarchyManifest` /
  `parseHierarchyManifestText`): a wrong type, a missing required field, a
  duplicate `tld` or `typology_id`, an entry naming an unlisted typology, a
  data file that is not the entry's own `<tld>1|2.copy.gz` or is listed twice,
  a digest that is not lowercase hex SHA-256, a non-int `lang.section_id`, or
  a dependency the shared normalizer would drop refuses the WHOLE file with
  the new code **`install.manifest_invalid`** (category `unavailable`, 503,
  public disclosure: the sentence names the JSON path and the broken rule).
  Nothing is silently skipped. Unknown keys are ignored.
- **The census** (`src/core/ontology/hierarchy_census.ts`
  `buildHierarchyManifest({dataDir})`): ACTIVE `hierarchy1` rows only
  (`hierarchy4` = dd64/1), sorted by `tld`; typologies = every `hierarchy13`
  record; the CORE `lg` entry always carries `data_files: []`. A row without a
  valid tld, a typology that is a `hierarchy13` record, or an int `lg1`
  section_id — and a second row claiming a seen tld — is skipped into
  `errors` (one line each), never exported with an invented value. An `lg1`
  id with no record exports `label: null` plus an error line. The census runs
  its own output through the reader before returning it.

### The export panel (stage B)

`src/core/area_maintenance/widgets/export_hierarchy.ts`, client
`client/dedalo/core/area_maintenance/widgets/export_hierarchy/js/`.

- **`export_hierarchy` — an explicit list ONLY.** `'*'` and `'all'` are
  removed (no `all_…` file is produced any more). Each listed tipo must be
  the `hierarchy53` (thesaurus) or `hierarchy58` (model) section of an ACTIVE
  `hierarchy1` row; the CORE `lg` (`lg1`, `lg2`, any `lg<n>`, and any tipo an
  active `lg` row names) is refused. Every refusal is ONE line of `errors`
  (`Ignored '*': …`, `Ignored invalid section tipo: …`,
  `Refused lg1: a CORE hierarchy (lg) …`,
  `Refused <tipo>: not the thesaurus (hierarchy53) or model (hierarchy58)
  section of an active hierarchy`) and writes nothing; the admitted tipos are
  still dumped. A tipo listed twice is dumped once. Every dump is read from
  `matrix_hierarchy` (the table the installer's import forces), so the
  response's `files[].table` is always `matrix_hierarchy` and `import_hint`
  always names it. `msg` on success now reminds the operator to re-export
  `hierarchy.json`.
- **NEW action `export_hierarchy_json`** (no options): writes
  `install/import/hierarchy/hierarchy.json` from `buildHierarchyManifest`
  (data dir = the same directory, so `data_files` are the dumps present at
  that moment), via a temp sibling + rename (atomic). Response:
  `{data: true, msg, errors?, files: [{section_tipo: 'hierarchy1', table:
  'matrix_hierarchy_main', file_name: 'hierarchy.json', bytes, url}],
  active_hierarchies: <n>, data_files: <n>, empty_hierarchies: [<tld>…]}` —
  `errors` are the census lines (rows skipped / degraded; the file is still
  written without them), `empty_hierarchies` the non-core entries with
  `data_files: []`. An unusable directory answers `{data: false, msg,
  errors: [<reason>]}` and writes nothing. Request-bounded (registry-sized),
  owned by the engine (update_ownership ENGINE_NATIVE).
- **Download route:** `<tipo>.copy.gz` and `hierarchy.json` (served as
  `application/json`); `all_…` is no longer served. Same global-admin gate,
  same 404 to everyone else.
- **Client:** a second form "Export hierarchy.json" (labels
  `export_hierarchy_json`, `export_hierarchy_json_info`), the data form's
  placeholder/info now labels (`export_hierarchy_section_tipos`,
  `export_hierarchy_data_info`), and `empty_hierarchies` rendered under the
  result (`export_hierarchy_empty_thesauri`); all five keys in `master.json`
  and every catalog.

### The vendored files and the seed (stage C)

- **Deleted:** `install/import/hierarchy/hierarchies.json`,
  `hierarchies_typologies.json` and `hierarchies_to_install.json`. The
  directory now holds `hierarchy.json` + the `<tld>1.copy.gz` data files
  (149 today; no `<tld>2.copy.gz`; never an `lg` file).
- **The seed registry ships the CORE rows only.**
  `install/db/seed/matrix_hierarchy_main.copy.gz` is cut from 150 rows to the
  single `lg` row (`hierarchy1/244`, bytes unchanged), and the compiler
  refuses any other (`seed_build.ts` `nonCoreRegistryRows`, applied in
  `assertShippable`; the verify install's contract asserts it too).
  `lg` is still activated by the install exactly as before. An optional
  thesaurus's registry row is written at ACTIVATION from its `hierarchy.json`
  entry (the installer stage). The seed was recompiled (`bun run seed:build`,
  verified by a fresh install). `scripts/seed_bootstrap_extract.ts`
  (provenance only) now cuts to `CORE_HIERARCHIES` instead of reading the
  deleted list.
- **The TRANSITIONAL `hierarchy.json` (provenance).** Until the owner
  replaces it with a master's export at the next vendor refresh, the
  vendored file was produced ONCE, by a one-off command that was not
  committed, from repo-owned data only, and validated by
  `parseHierarchyManifest` before it was written:
  - **Entries:** the 149 TLDs with a vendored `<tld>1.copy.gz`, plus `lg`
    (150; every data file had a seed registry row, so nothing was left
    out). They are sorted by tld.
  - **Fields from the seed's registry rows** (the pre-cut
    `matrix_hierarchy_main.copy.gz`):
    - `name` / `name_data` from `hierarchy5`, with `name` the `lg-eng` pick;
    - `typology_id` from `hierarchy9`, and `lang.section_id` from `hierarchy8`
      (string ids converted to int);
    - `real_section_tipo` from `hierarchy109`. It is `null` on the 7 rows that
      name none (`ca`, `co`, `dk`, `gi`, `gt`, `se`, `us`), so the
      provisioning default `hierarchy20` applies, as it did before;
    - `scope_note_data` from `hierarchy61`. No row holds one, so it is `[]`
      everywhere;
    - `dependencies`: no row holds `hierarchy60`, so the key is absent
      everywhere (not declared).
  - **`lang.label`:** the `lg-eng` pick of the `lg1` record's `hierarchy25`
    term in the seed's `matrix_langs.copy.gz`. All 5 ids used (17344, 5101,
    5450, 3032, 14895) exist there.
  - **`active_in_thesaurus`** is the deleted descriptors' value (`true` for all
    150), NOT the seed's `hierarchy125`. The seed's `dd64/2` on every row is
    an artifact of the builder, which forced every shipped row inactive; it
    is not data. The descriptors' value is what the installer applied at
    activation until this change.
  - **`typologies`:** from the deleted `hierarchies_typologies.json`, with
    `name` = its `label` and `name_data` = `[{lang: "lg-eng", value: label}]`.
    Two of these labels differ from the `hierarchy13` records: 9 "Ubications"
    (the DB says Locations) and 10 "Restoration" (the DB says
    Laboratory | Restoration). A master export replaces them.
  - **`typology_name`:** that list's name.
  - **`data_files`:** the real sha256 of each vendored file. `lg` has `[]`.
  - **Envelope:** `version` = the engine version and `date` = 2026-10-10. The
    `entity_id`, `entity`, `entity_label` and `host` fields are `null`,
    because the file is not an export of any installation.

### The installer (stage D)

- **ONE strict reader** (`src/core/install/hierarchy_meta.ts`
  `readHierarchyManifest(dir?)`): a missing manifest refuses
  `install.manifest_invalid` (public sentence, no server path) — never an
  empty offer. `HierarchyMeta` IS the manifest entry. `CORE_HIERARCHIES` keeps
  only `{tld, label, active_in_thesaurus}` (`lg`): activated by the seed
  restore against the seed's own registry row (`activateCoreHierarchy` —
  never created; a missing row is reported), never imported, never offered,
  shown locked. `matrix_langs` untouched.
- **Offer** = every NON-CORE entry, WITH OR WITHOUT data files
  (`offeredHierarchies` / `offeredHierarchyTlds`; `ontology_choice.ts`
  re-exports the latter). Client view (`hierarchyChoiceView`, wizard context
  + `add_hierarchy` get_value): `hierarchies: [{tld, label (= name ?? tld),
  typology (= typology_id), has_data}]`, `hierarchy_typologies: [{typology,
  label}]` — the shape `render_hierarchies_import_block` groups by; an entry
  with `has_data: false` shows an "Empty" badge.
- **Import, verified before written** (`hierarchy_import.ts`): only the
  entry's LISTED `data_files` are imported (terms before models); each file
  must exist and its bytes must hash to its `sha256` BEFORE anything of the
  tld is written — missing / mismatch = that tld's own error line
  (`missing data file <f> (listed in hierarchy.json) — nothing imported`,
  `checksum mismatch for <f>: its sha256 is not the one hierarchy.json lists
  — nothing imported`), no partial import. No `data_files` = an EMPTY
  thesaurus by design: no import, activation only (response
  `empty thesaurus (no data files — nothing imported) and activated`); a
  reset of one is refused (nothing to reset from). A tld the manifest does not
  list: `not listed in hierarchy.json — nothing imported, not activated`.
  `installHierarchies` options gain `importDir` (manifest + files; default
  the release's dir — a gate seam).
- **Activation creates a NEW registry row FROM THE ENTRY**
  (`hierarchy_activate.ts`, ONE transaction): `hierarchy6` (lg-nolan tld),
  `hierarchy5` = `name_data` (every item), `hierarchy9` = hierarchy13/<int>,
  `hierarchy8` = `{id:1,type:dd151,section_id:<lang.section_id int>,
  section_tipo:'lg1',from_component_tipo:'hierarchy8'}` — the lg1 record MUST
  exist in this installation or the activation is refused before anything is
  written (no fallback language) —, `hierarchy109` when the entry names one
  (null → `ensureHierarchy`'s `hierarchy20` default), `hierarchy61` =
  `scope_note_data` when non-empty, `misc.hierarchy60` =
  `dependenciesMiscItems(dependencies)` when declared (absent → nothing
  written). `active_in_thesaurus` feeds `ensureHierarchy`. An EXISTING row is
  never re-described (operator metadata is never clobbered).
- **Pre-selection ONLY from dependencies.** `install_checked_default` and
  `defaultOptionalHierarchies` are REMOVED; the wizard context loses
  `install_checked_default` and gains `toponymy_typology` (= 2). The wizard
  pre-ticks only persist_config's declared thesauri (mandatory locked,
  optional pre-ticked). CLI / install.sh: `--hierarchies` omitted or
  `default` = no optional thesaurus beyond the declared dependencies.
- **Toponymy suggestion, never a default.** The plan gains `suggestions`
  (`TOPONYMY_SUGGESTION` when the planned thesauri hold no Toponymy entry);
  `--plan` prints `suggestions`, an install run prints `  suggestion: …`, the
  wizard's Toponymy group shows the label `install_toponymy_suggestion`, and
  install.sh's prompt carries the tip.
- **NEW CLI flag `--list-hierarchies`**: one JSON line `{core, entries:[{tld,
  name, typology_id, typology_name, has_data}], suggestion, errors}`, exit 0/1.
- **The mandatory-dependency RULE changes:** a declared `hierarchy1`
  dependency is installable when hierarchy.json has an ENTRY for it (a missing
  data file is no longer an error). No entry: mandatory → error `the thesaurus
  '<tld>', a mandatory dependency of …, has no entry in hierarchy.json — it
  cannot be installed`; optional → warning `… has no entry in hierarchy.json —
  skipped`. An unlisted `--hierarchies` tld: `unknown hierarchy '<tld>' (no
  entry in hierarchy.json)`.
- **`add_hierarchy` installed marker**: `<tld>1` term rows, OR an ACTIVE
  registry row of an empty-by-design entry (`mergeInstalledTlds`).

### Release gate, docs and history (stage E)

- **Supersedes** the `install_checked_default` half of
  WC-2026-10-08-install-plan-update-servers-core-lg (its "Shape after" for
  `get_install_context` → `install_checked_default` and the shared
  `defaultOptionalHierarchies()` default): that key and that reader no longer
  exist. Its `core_hierarchies` / core-`lg` half stands. The older entry is
  left unedited as history.
- **No further wire change.** The installer client's local variable naming
  the selected TLDs was renamed (`selected_hierarchies`) so no live code
  spells a retired file name; the posted `hierarchies` option is unchanged.
- **Vendored-release gate**: every `main: 'hierarchy1'` dependency the release
  declares (any vendored `ontology.json` entry, any `hierarchy.json` entry)
  must name a `hierarchy.json` entry or a core hierarchy, and every
  declaration must survive the shared normalizer (see the reconciliation
  below). The manifest's own integrity stays with
  `install_seed_drift_tripwire` (stage C).
- **Changelog:** fragment `changes/unreleased/hierarchy-json-manifest.md`
  (`breaking: true` — an install that listed its own hierarchies in the old
  descriptor file must add their entries to `hierarchy.json`).
- **Docs** (TS prose): `docs/install/installer_reference.md` (the
  `--hierarchies` default, `--list-hierarchies`, `suggestions` in `--plan`,
  a *thesaurus manifest* section, the dependency rule's new text, the wizard's
  Hierarchies step), `docs/development/ts_install_internals.md` (the manifest,
  offer / pre-selection / import / activation, the core-only seed registry,
  the gates), `docs/management/install_new_hierarchies.md` (the offer, the
  verified import, the empty thesaurus, carrying an entry between installs,
  the strict-reader warning).

### Review fixes (stage F)

An adversarial review of stages A–E confirmed nine defects; each is fixed at
the root.

- **Activatable before imported.** `installHierarchies` checks what a NEW
  registry row would reference BEFORE a term is copied
  (`hierarchy_activate.ts` `activationBlocker`): the `lg1/<lang.section_id>`
  record exists, the `hierarchy13/<typology_id>` record exists (it was only
  shape-checked — a dangling typology activated and then dropped out of that
  install's own census), and the provisioning rule (`hierarchy_state.ts`
  `provisionBlocker`, the one statement) accepts the entry — a set
  `real_section_tipo` must be a `section` here. A refusal is the tld's error
  line ending `…activation refused; nothing imported`, with nothing written.
  It used to come AFTER the committed `\copy`: the terms stayed, and every
  later run answered "already installed — skipped", ok, never activating.
- **Already imported converges.** A tld whose listed sections already hold
  its rows is not re-copied but IS activated (idempotent). Its response is
  `{tld, ok, skipped: true, msg: 'already installed — import skipped and
  activated'}`, where it used to be `'already installed — skipped'` with no
  activation.
- **"Already imported" is judged on the LISTED sections.** The probe used to
  look at `<tld>1` only. An entry listing only `<tld>2.copy.gz` therefore
  skipped its own models on a first run, or re-copied them into a primary-key
  violation on a re-run. Now every section the entry lists is counted
  (`hierarchy_import.ts` `classifyListedSections`). If one of them holds ONLY
  the root an empty activation minted, while its file carries more, the tld
  is refused with a line naming "Reset to seed": the data a later release
  ships cannot be copied in additively, and that is said, never silently
  skipped. A one-row file is indistinguishable from its own root, so it
  counts as imported.
- **A thesaurus's own declared dependencies bind.** `hierarchy.json`
  `entry.dependencies` used to be written to the new row's `misc.hierarchy60`
  and nothing more. Now `installHierarchies` closes the selection over the
  chosen entries' declarations, transitively, before anything is written
  (`hierarchy_dependencies.ts` `withThesaurusDependencies` →
  `ontology_choice.ts` `closeThesaurusChoice`). The same law applies as for
  ontology declarers:
  - a mandatory thesaurus joins the batch;
  - an optional one follows the posted list (the CLI plan pre-ticks it unless
    `declined_dependencies` declines it);
  - a mandatory thesaurus with no entry, or a mandatory ONTOLOGY
    (`main: 'ontology35'`) that is not installed, refuses the WHOLE batch:
    `{ok:false, responses: [], errors: [...], msg: 'Nothing installed: a
    selected thesaurus declares a dependency this installation cannot
    satisfy'}`;
  - added thesauri are named in `msg` (`the thesaurus 'x' is a mandatory
    dependency of 'y' — installed`).

  The wizard step, `add_hierarchy` and the CLI all go through this one door.
  `buildInstallPlan` runs the same closure, so `--plan` shows the added
  thesauri and merges their dependencies into `hierarchy_dependencies`. A
  reset (`replace`) installs nothing new and is not closed.
- **The census skips ONE bad row, not the export.** Each built entry is
  checked ALONE against the reader's own rules
  (`hierarchy_manifest_format.ts` `validateHierarchyEntry` /
  `validateHierarchyTypology`, new exports). A real section must also name a
  `section` of the exporting install. A row that fails is its own
  `Skipped hierarchy1/<id> '<tld>': <path>: <rule>` line in the panel's
  `errors`. Examples: a hierarchy109 `'Hierarchy20'`, a name item with lang
  `'lg-ES'`, or the measured master typo `'hiearachy20'`. Before, one such
  row made `export_hierarchy_json` throw `install.manifest_invalid` (503) and
  wrote nothing.
- **Data export: only `<tld>1` / `<tld>2`.** The widget refuses a
  `hierarchy53` / `hierarchy58` tipo that is not its row's own `<tld>1|2`
  (`Refused <tipo>: only a hierarchy's own <tld>1 / <tld>2 sections can be
  vendored (hierarchy.json lists no other data file)`). Such a dump would be a
  file no manifest entry ever lists, which the vendored-release gate rejects.
- **Labels in the reader's language.** The wizard context and the
  `add_hierarchy` widget picked `label` from the export-time `name` (the
  exporter's application language). Now `hierarchy_meta.ts`
  `hierarchyChoiceView(lang)` picks it from `name_data` and the typology's
  `name_data` in the requesting user's application language, through THE
  manifest pick rule, now the pure leaf `ontology/manifest_lang_pick.ts`
  (`data_io.ts` re-exports it). It falls back to `name`, then to the
  tld / id. The response shape is unchanged.
- **`add_hierarchy` "installed" marker.** Its rationale is corrected: an
  empty activation mints the General Term root in `<tld>1`, so the
  active-empty arm covers only a row whose `hierarchy53` names another
  section. No wire change.

## Reason

The hand-written descriptors drifted from the registry they described (an
uncommitted 291-entry edit, labels differing from the `hierarchy13` records,
no lang / real section / scope note / dependencies at all), and the seed had
to carry 149 inactive registry rows only so activation could find them. An
exported manifest makes the master's registry the single source, carries
everything an installer needs to recreate a registry row, and pins each data
file by digest.

## Gate reconciliation

- `test/unit/hierarchy_manifest_format.test.ts` (hermetic): the reader —
  round trip, absent vs declared dependencies, and one positive control per
  refusal rule (each breaks ONE field of a known-good manifest).
- `test/unit/hierarchy_census_native.test.ts` (suite DB, scratch
  `zzcensus*` registry rows, swept before and after): every entry field from
  a fully declared row, a bare row (dependencies absent, nulls, `[]`), an
  inactive / bad-lang / duplicate row never exported, the core `lg` entry
  without data files, the shared envelope, the tld order.
- `test/unit/export_hierarchy_export_native.test.ts` (stage B, suite DB,
  scratch ACTIVE `zzeh` + INACTIVE `zzei` registry rows and `zzeh1` terms,
  dumps into a mkdtemp dir, all swept): the list-only parse, the pure scope
  plan (active 53/58 admitted; `*`/`all`, invalid, lg — even when an active
  row names `lg1` — and not-active refused), a real dump, a mixed request
  whose refused tipos write nothing, and `export_hierarchy_json` → a file the
  format reader accepts whose scratch entry carries the row's fields and the
  sha256 of the dump on disk, no temp sibling left.
  `export_hierarchy_deactivate_native` pins the three action names;
  `update_ownership_tripwire` and `maintenance_door_unbounded_native` register
  the new action.
- `test/unit/install_seed_drift_tripwire.test.ts` (stage C, hermetic): its
  descriptor block is rewritten for the manifest. It checks that:
  - `hierarchy.json` parses through THE reader;
  - the three retired files are absent;
  - every listed data file exists and its bytes match its digest;
  - every vendored data file is listed;
  - each CORE hierarchy has an entry with `data_files: []` and no
    `<tld>1|2.copy.gz`;
  - the seed registry's TLDs equal CORE exactly.

  The `install_checked_default` test is removed with its file. The installer
  stage owns pre-selection. `seed_build_native` adds the pure
  `nonCoreRegistryRows` control, and `test/helpers/seed_contract.ts` asserts
  the restored registry is core-only.
- **Installer (stage D):** `install_hierarchy_activate_native` (suite DB,
  scratch `zz` / `zzhb` / `zzhe` / `zzhm`, swept) pins the row created from
  the entry (hierarchy5/6/8/9/61/109 + misc.hierarchy60, int lg1 address
  RESOLVED from the installation), the bad-lang refusal writing nothing, and —
  through `installHierarchies` over a scratch manifest dir — the empty
  thesaurus activated with no import, its refused reset, the checksum
  mismatch refusing before any write, the unlisted tld.
  `hierarchy_import_atomic_native` adds the digest mismatch, the missing
  listed file, the empty list and listed-only import cases.
  `tier1_install_native` pins the strict reader (missing manifest refused),
  the non-core offer and the client view; `install_plan_parity_tripwire` the
  empty wizard default, `suggestions`, and `--list-hierarchies`;
  `install_ontology_choice` the entry-without-data rule;
  `installed_tld_native` `mergeInstalledTlds`; `install_e2e` installs the
  smallest data-carrying entry (registry row created: hierarchy8 / 109).
  `write_obligations_tripwire`'s exemption row moves from `#activateHierarchy`
  to `#createRegistryRow` (the raw write's new home). Shared builder:
  `src/core/test_data/hierarchy_entry_fixture.ts` (reader-validated entries;
  used by `synthetic_hierarchy_fixture`).
- **Fixtures:** no parity gate replays `hierarchy.json`, the census or the
  installer's hierarchy step, so no re-harvest is needed and no fixture
  changes.
- **Stage E:** `test/unit/vendored_ontology_closure_tripwire.test.ts` gains
  THE THESAURUS HALF (hermetic): the vendored `ontology.json` (every entry)
  and `hierarchy.json` (every entry) are read as declarers through THE shared
  normalizer (nothing dropped) and the installer's own
  `collectHierarchyDependencies` + `hierarchyDependencyPlan` over the
  manifest's TLDs yields no error and no warning. The release declares no
  `hierarchy1` dependency today, so floors count the declarers read and
  planted declarations (with an entry → installs; mandatory / optional
  without → refused / warned; a malformed item → dropped) prove the verdict
  moves. `hierarchy_manifest_format.test.ts`'s declared-empty case gains a
  floor (`gate_vacuity_tripwire` budget held at 108). `engineering/TRIPWIRES.md`
  rows amended (no row added: install_seed_drift, install_hierarchy_dependencies,
  install_plan_parity, vendored_ontology_closure, install_ontology_choice).
- **Stage F (review fixes):** `install_hierarchy_activate_native` adds:
  - `zzhr`: a non-default real section (`test3`), `active_in_thesaurus`
    false, and two-language name / scope-note items, each asserted on the new
    row exactly;
  - `zzhe`: now named with no real section, so it asserts the provisioning
    default;
  - a later release shipping data for the empty-activated `zzhe`: refused
    naming Reset, nothing copied;
  - the three preflight refusals `zzhl` (lang), `zzht` (typology) and `zzhs`
    (`hiearachy20`): each with a VALID data file, run twice, with zero terms
    and no registry row;
  - `zzhc`: terms imported by an interrupted run, activated by the next one,
    twice, never re-copied;
  - the declared-dependency closure: `zzda` pulls in `zzdb`, and `zzdc` with
    an unsatisfiable mandatory refuses the whole batch.

  Elsewhere:
  - `hierarchy_import_atomic_native` adds the models-only entry (imports,
    then skips), the root-only refusal and its Reset, and pure
    `classifyListedSections`;
  - `hierarchy_census_native` adds three malformed rows (`zzcensuse/f/g`),
    each its own line while the export succeeds;
  - `hierarchy_manifest_format.test.ts` adds the per-record validators;
  - `export_hierarchy_export_native` adds the `<tld>1|2`-only refusal and an
    exact, floored `empty_hierarchies` with a second ACTIVE scratch row
    `zzej` and no dump;
  - `install_ontology_choice` adds pure `closeThesaurusChoice` (transitive,
    declined optional, no-entry, ontology35, unlisted) and
    `mergeHierarchyDependencyLists`;
  - `tier1_install_native` adds the reader-language pick;
  - `install_hierarchy_dependencies_native`'s step leg reads the stand-in
    `<tld>1` row as root-only, which is refused before any copy or
    activation.

  Each new assertion was mutation-checked: reverting its fix reddens it.
  `error_taxonomy_tripwire` B1 lowers `hierarchy_import.ts` from 3 to 2, and
  `crap_complexity_baseline.json` is regenerated (a shrink).


## Addendum 2026-10-10 — declared thesauri never block nor are forced (owner decision)

The owner decision recorded in
`WC-2026-10-10-ontology-dependencies-hierarchy60` (Addendum 2026-10-10)
applies to the manifest's declarers too — a `hierarchy.json` entry's
`dependencies` are the same hierarchy60 law:

- **The mandatory-dependency RULE above changes:** a declared `hierarchy1`
  dependency with no entry is a WARNING (skipped), mandatory or not — never an
  error. `hierarchyDependencyPlan` answers `{install, warnings}`.
- **installHierarchies (the one door: wizard step, CLI, add_hierarchy
  widget)** no longer adds a chosen thesaurus's mandatory thesauri: the batch is
  exactly the selection. A mandatory one left out (declined, or no entry) is a
  warning in `msg`; only a declared mandatory ONTOLOGY this installation lacks
  still refuses the whole batch (`ok: false`, empty `responses`, msg
  `Nothing installed: a selected thesaurus declares an ontology this installation does not have`).
- **The CLI plan** still closes the chosen thesauri over their declarations:
  every declared thesaurus is pre-ticked (added) unless
  `--decline-dependencies` names it; a declined mandatory one is a warning.
- **The client view** (`hierarchyChoiceView`, the wizard context + the
  add_hierarchy widget) gains `dependencies: [{tld, mandatory}]` — the entry's
  declared THESAURI only (core `lg` and `ontology35` items excluded). The shared
  `render_hierarchies_import_block` pre-ticks them when the entry is ticked
  (transitively) and marks a mandatory one "strongly recommended by: …" — never
  disabled; unticking a recommended row shows where to install it later.
  `required_hierarchies` rows (the installed ontologies' mandatory thesauri)
  are checked but EDITABLE.
- **Labels:** `installation_hierarchy_required_by` (TS-era, never in the
  oracle) is replaced by `installation_hierarchy_recommended_by`; new
  `installation_dependency_recommended` and
  `installation_dependency_recommended_warning`.

**Gate reconciliation:** `install_hierarchy_activate_native` (the declarer
alone installs only itself + the warning, never `zzdb`; both ticked install
both; `zzdc`'s no-entry mandatory warns and installs; new `zzdo` declaring a
missing mandatory ontology refuses the batch), `tier1_install_native` (the view
keys + a scratch manifest proving `dependencies` carries only non-core
thesauri), `widget_request_native` (the widget's view keys),
`install_ontology_choice` (`closeThesaurusChoice`: declined mandatory → warning,
never forced; no entry → warning). No fixture changes, no re-harvest.
