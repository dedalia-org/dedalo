# WC-2026-10-09-ontology-manifest-dependencies — the ontology manifest declares each ontology's dependencies

- **Date:** 2026-10-09 (installer unification, item A5, server side).
- **Decision:** installer unification plan A5. An ontology's dependencies are
  DECLARED on the ontology master as Dédalo state. They are never computed by
  an installer. The master's export emits them per ontology in `ontology.json`,
  and the update manifest serves that file verbatim.

## Shape before (TS, and PHP)

- **`ontology.json` → `active_ontologies[i]`** (the export, `updateOntologyInfo`
  → component `ontology18` of `dd0/1` → `exportOntologyInfo`):
  `{tld, name, name_data, typology_id, typology_name}`. No dependency
  information anywhere.
- **`dd_utils_api.get_ontology_update_info` → `data`**:
  `{info: <ontology.json verbatim>, files: [{tld, section_tipo, url}]}`. It is
  unchanged by this entry. `info` is still verbatim, so the new field reaches the
  client as `data.info.active_ontologies[i].dependencies`.
- **The Ontologies-main edit form (`ontology35`, virtual of `hierarchy1`)**: the
  "Relations" group (`hierarchy60`) held four components, order 1..4.
- **`tool_ontology_parser.get_ontologies`**: `census.errors` extension lines
  only for registry records without a target section or TLD.

## Shape after (TS)

- **NEW engine-owned component `ddengine11` "Required ontologies"**
  (`ONTOLOGY_DEPENDENCIES`, `src/core/ontology/engine_ontology.json`):
  - model `component_portal` (`dd592`), relations
    `[ontology35, hierarchy6, hierarchy5]` (target = the ontology registry,
    showing TLD + name);
  - parent `hierarchy60`, order 5. It is the fifth component of the "Relations"
    group, in the `ontology35` edit form and, because the real section is
    shared, in the thesaurus registry (`hierarchy1`) form too. Nothing reads it
    there.
  - `properties: null`. No properties block is needed: the implicit request
    config of a relations-only portal resolves the target section and the shown
    columns, and it renders and saves on an `ontology35` record through
    `saveComponentData`. The gate drives exactly that path.
  - Why it is engine-owned: an ontology update replaces a TLD wholesale, so a
    component the engine reads for a wire contract cannot live in the master's
    `dd`/`hierarchy` TLDs, and a tipo cannot be pre-allocated on the master.
    `ddengine` ships with the code and is materialized on every install,
    including the master, whose editors fill it in the normal edit form.
- **Census** (`getActiveOntologies`, `src/core/ontology/data_io.ts`):
  `OntologyCensusEntry.dependencies?: string[]`. These are the TLDs of the
  `ontology35` records the component points at, resolved against ALL registry
  rows, active or not. They come in declared order, deduplicated, with the
  entry's own TLD dropped. **The key is present only when at least one locator
  resolves.** A locator that resolves to no TLD is skipped and reported as one
  `census.errors` line,
  `ontology35/<id>: dependency ontology35/<x> has no tld — skipped`. That line
  also reaches `get_ontologies`' existing `errors` extension key, with the same
  meaning as before (a per-ontology note on a successful read).
  `get_ontologies`' `data` is unchanged: it picks its five fields explicitly.
- **`ontology.json` → `active_ontologies[i].dependencies?: string[]`**
  (`activeOntologiesInfo`, the pure census → info mapping `updateOntologyInfo`
  persists). It is copied only when the entry declares it.
- **Manifest semantics** (`data.info.active_ontologies[i].dependencies`):
  - present: the declared TLDs. They **may include core TLDs**: a complete
    declaration names them too, since every domain TLD needs at least `dd`,
    where its models live.
  - **absent: NOT DECLARED.** Either the component is empty or the server
    predates it. It never means "needs nothing". The client parser
    (`src/core/ontology/ontology_manifest.ts`) reports it as
    `dependencies: null`, never `[]`. The installer then warns loudly and
    installs only what was chosen.

- **The declaration survives an import** (so a LAN ontology master that obtains
  its ontologies from another master re-serves them — it is not lost after one
  hop): the shared import layer (`importStagedOntologyFiles`, both the update
  panel and the installer's ontology door) writes `ddengine11` on each imported
  TLD's `ontology35` registry record, after every registry record of the batch
  exists — one link locator per declared TLD that has a registry record HERE, in
  declared order, REPLACING the record's previous value. NOT declared (`null`)
  writes NOTHING (a local declaration stands). A declared TLD with no registry
  record here is not written and is reported as an operator NOTE in the
  response `msg` (`<tld>: declared dependencies without a registry record here
  were not recorded: <tlds>`), never an error.
- **`dd_utils_api.update_ontology` → `options.files[i].dependencies?`** (NEW,
  optional): the manifest's `info.active_ontologies[i].dependencies` for that
  TLD, forwarded by the panel (`render_update_ontology.js`) ONLY when the master
  declares them. The stager normalizes it with the manifest client's own rule
  (`normalizeDeclaredDependencies`: trimmed, lowercased, valid TLDs, deduplicated,
  own TLD dropped; a bad item is a note in `msg`, never a refusal). Absent = not
  declared. Before this entry the schema silently stripped the key.
- **The installer's `staged.json`** already carried `dependencies` per item; it now
  reaches the import (`updateFilesOf`). The vendored `oh` declares the core TLDs
  (ontology_choice.ts `VENDORED_DOMAIN_ONTOLOGIES`), so an install records them.

## Reason

The installer (CLI, wizard, `install.sh`) lets the operator choose domain
ontologies (`oh` by default, `tch`, any TLD a server offers) and must install
what they need. A TLD's needs can be COMPUTED from its nodes' references, but a
computation cannot tell a real need from a graft or a publication alias, and it
would silently decide for the operator. A declaration made where the ontology is
authored is Dédalo state, reviewable in the edit form. It travels in the file
the installer already reads.

## Gate reconciliation

- `test/unit/ontology_dependencies_native.test.ts` (DB, suite database, scratch
  `zz` TLDs): the component is materialized as its JSON node, sits in the
  `ontology35` implicit edit config, and is a portal onto `ontology35`.
  Locators saved through `saveComponentData` reach the census in declared
  order, deduplicated, with self dropped and core kept. A self-only or empty
  component yields NO key. A dangling locator yields the census error line.
  `activeOntologiesInfo` copies the field only when it is defined, and
  `buildOntologyUpdateInfo` carries it verbatim to the client parser.
- `test/unit/ontology_manifest_native.test.ts` (hermetic): the client side,
  covering normalization and absent = `null`.
- `test/unit/install_ontology_door_native.test.ts` (DB, scratch `zzj` TLDs) — the
  ROUND TRIP: a stand-in master declares `zzja: [dd, zzjb]`, `zzjb: [dd]` and
  nothing for `zzjc`; after the import THIS server's census
  (`getActiveOntologies`, what its export serves) answers exactly those, and
  `zzjc` stays undeclared. Mutation-checked: without the import's write the
  census answers no key.
- `test/unit/ontology_update_target_native.test.ts` — the panel's `files[i].dependencies`
  survives `updateOntologyOptionsSchema` and is staged normalized; absent → `null`.
- `test/unit/ai_spend_budget_native.test.ts`: its engine-ontology legs (JSON ≡
  `dd_ontology` node for node, a second run writes nothing) now cover
  `ddengine11` too.
- **Fixtures:** no parity gate replays `ontology.json`, the manifest or the
  census, so no re-harvest is needed and no fixture changes. A gate that
  replays the `ontology35` / `hierarchy1` edit structure context would see one
  more ddo. The frozen fixtures are compared against TS output only through
  their own transforms, so none was affected when this entry was written (the
  parity tier was re-run against `engineering/parity_baseline.json` with no new
  red).

## Addendum 2026-10-10 — superseded by WC-2026-10-10-ontology-dependencies-hierarchy60

This entry is SUPERSEDED in full by
`engineering/wire_contract/WC-2026-10-10-ontology-dependencies-hierarchy60.md`.
It stays as history. The owner had not approved the engine-owned component
`ddengine11`. The master ontology now defines the field as `hierarchy60`, a
`component_json` "Dependencies" on `hierarchy1`/`ontology35`. A dependency is
now an object, `{tld, main: ontology35|hierarchy1, mandatory}`. It is no
longer a TLD string.

Everything this entry describes is gone:

- `ONTOLOGY_DEPENDENCIES` and `writeDeclaredDependencies` /
  `recordDeclaredDependencies`;
- the locator resolution in the census;
- `normalizeDeclaredDependencies`;
- `VENDORED_DOMAIN_ONTOLOGIES`.

`ddengine11` is listed as `retired` in `engine_ontology.json`, so the engine
ontology door prunes it from installs that materialized it. Its gate legs
moved to the gates named in the new entry.
