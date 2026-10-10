# WC-2026-10-10-ontology-dependencies-hierarchy60 — ontology dependencies are objects stored in the master's hierarchy60

- **Date:** 2026-10-10. The spec was approved by the owner the same day.
- **Decision:** this entry SUPERSEDES
  `WC-2026-10-09-ontology-manifest-dependencies`. That entry's engine-owned
  component `ddengine11` was invented without the owner's approval. The master
  ontology now defines the dependency field itself: `hierarchy60`, a
  `component_json` "Dependencies" inside group `hierarchy103` (Relations) of
  `hierarchy1`. `ontology35` is a virtual section of `hierarchy1`, so it gets
  the field too. A dependency is an OBJECT that names WHAT must be present
  (the TLD's ontology or its thesaurus) and whether it is mandatory. It is no
  longer a bare TLD. The same entry also fixes the registry-row law, because
  the import is the door that carries the declaration.

## Shape before (TS, 2026-10-09)

- **Stored:** `relation.ddengine11` on the `ontology35` registry row. It held
  one link locator for each declared TLD.
- **`ontology.json` → `active_ontologies[i].dependencies?: string[]`**: TLDs
  resolved from those locators. The `census.errors` line
  `dependency ontology35/<x> has no tld — skipped` reported a locator that
  resolved to no TLD.
- **Manifest** (`ontology_manifest.ts`): `dependencies: string[] | null`,
  normalized by `normalizeDeclaredDependencies` (self-reference dropped).
- **`dd_utils_api.update_ontology` → `options.files[i].dependencies?`**:
  `string[]`. The import wrote `ddengine11` afterwards
  (`recordDeclaredDependencies`). A declared TLD with no registry row here
  produced a NOTE in `msg`.
- **Installer:** the dependencies of the vendored `oh` were hard-coded as the
  core TLDs (`VENDORED_DOMAIN_ONTOLOGIES`). The closure followed only
  ontologies. Every dependency was installed and could never be unticked.
- **Registry row:** `addMainSection` rewrote EVERY key with constants on
  create, on import, on rebuild and on provisioning. That re-activated a TLD
  the operator had switched off, reset its project filter and pinned
  `hierarchy8` to the hard-coded `lg-spa` id `17344`.

## Shape after (TS)

- **Stored:** `misc.hierarchy60 = [{"id":1,"value":[…]}]` on the `ontology35`
  registry row. `hierarchy60` is a `component_json`, so it lives in `misc`.
  The engine reads and writes the raw key (`HIERARCHY_DEPENDENCIES`) and never
  depends on its `dd_ontology` definition. The vendored 7.0 release still
  defines `hierarchy60` as a section_group; the vendor refresh comes later.
- **The item (`OntologyDependency`,
  `src/core/ontology/ontology_dependencies.ts`):**
  `{"tld": "<tld>", "main": "ontology35" | "hierarchy1", "mandatory": <boolean>}`.
  - `main: ontology35` means the TLD's ONTOLOGY must be installed.
  - `main: hierarchy1` means its THESAURUS (the hierarchy registry plus its
    terms) must be installed and active.
  - A TLD may appear under both mains. The dedupe key is `(tld, main)`: the
    first occurrence wins and each later one is warned.
  - A self-reference under `hierarchy1` is valid, because an ontology may
    declare its own thesaurus. A self-reference under `ontology35` is dropped
    with a warning.
  - An item that is not an object, has an invalid TLD, has an unknown `main`,
    or has a `mandatory` that is not a strict boolean is dropped with a
    warning. A value that is not a list is treated as NOT DECLARED and warned.
  - ONE normalizer, `normalizeOntologyDependencies`, is shared by the export,
    the manifest parser, the stager, the registry writer and the installer.
- **`ontology.json` → `active_ontologies[i].dependencies?: OntologyDependency[]`**
  (census `getActiveOntologies` → `activeOntologiesInfo`).
  - The key is ABSENT when the row holds no `hierarchy60`, which means not
    declared. A stored `[]` is exported as `[]`.
  - Each invalid stored item is dropped and becomes one `census.errors` line,
    `ontology35/<id>: <warning>`. It is never fatal.
  - The `hierarchy4` (`activeOnly`) filter is unchanged.
- **Manifest** (`data.info.active_ontologies[i].dependencies`, parsed by
  `ontology_manifest.ts`): `OntologyDependency[] | null`. `null` means not
  declared.
- **`dd_utils_api.update_ontology` → `options.files[i].dependencies?`**: the
  object list. The panel still forwards it verbatim, only when the master
  declares it. The stager normalizes it, and its warnings go to `msg`.
- **Registry-row law** (`src/core/ontology/ontology_write.ts`):
  - `createMainSection` runs only when no row exists. It sets `hierarchy4` yes
    and `hierarchy125` (yes only for `dd`). It sets `hierarchy8` to the `lg1`
    record of `STRUCTURE_LANG`, resolved from the installation's langs;
    unresolvable is refused with `ontology.invalid_node`. It also writes
    `hierarchy54` `dd153/1`, the name, the TLD, the target section, the
    typology and `hierarchy60` (when declared).
  - `syncMainSectionFromDefinition` is the import door: package install,
    ontology update, seed build, and engine and test TLD materialization. On an
    EXISTING row it writes only the following:
    - `hierarchy5`, `hierarchy9` and `hierarchy60`, replaced from the
      definition. `hierarchy60` is written only when the definition DECLARES
      dependencies: an absent key leaves the local value, and a declared `[]`
      is written.
    - `hierarchy4` yes, only for a core TLD (`isCoreOntologyTld`).
    - `hierarchy125` by the dd-only rule, and `hierarchy8` by the
      `STRUCTURE_LANG` rule.

    The seed build passes each release entry's `dependencies` through that
    door (normalized; a malformed declaration refuses the compile), so a
    seed's core registry rows carry the release's `hierarchy60` — the same
    declaration the CLI plan reads from the vendored `ontology.json`.

    It never touches `hierarchy54` or any other key.
  - The rebuild (`ensureMainNode`), virtual provisioning
    (`provisionVirtualSections`) and the parent grouper create the row only
    when it is missing. Otherwise they never write it.
  - The import no longer writes dependencies in a separate pass, and the
    `msg` note about TLDs without a registry row is gone.
- **The update reports missing dependencies; it never installs them**
  (`src/core/ontology/dependency_report.ts`, run by `updateOntology` after the
  import, never in the layer it shares with the installer).
  - When is a declared dependency missing?
    - `main: ontology35`: the TLD has no registry row (`not_installed`), or it
      is not in the effective `ACTIVE_ONTOLOGY_TLDS` (`not_active`). Core TLDs
      always count as present.
    - `main: hierarchy1`: no `hierarchy1` row for the TLD in
      `matrix_hierarchy_main` has `hierarchy4` set to `dd64/1`
      (`no_active_hierarchy`).
  - A MANDATORY missing dependency adds one line to the response `errors`. The
    panel already shows `errors` as "Import warnings". The update stays
    successful, and its `msg` reads "Warning!".
  - An OPTIONAL missing dependency adds one note to `msg`.
  - Each line names the dependant and the dependency, and says how to provide
    it (add the TLD to `ACTIVE_ONTOLOGY_TLDS` and run again, or Maintenance →
    Install hierarchies).
  - NEW extension key `missing_dependencies` on the `update_ontology` widget
    response: `[{dependant, tld, main, mandatory, reason}]`, where `reason` is
    one of `not_installed`, `not_active` or `no_active_hierarchy`. It is `[]`
    when nothing is missing.
- **Installer** (`src/core/install/**`, `scripts/install.ts`, the wizard):
  - `VENDORED_DOMAIN_ONTOLOGIES` is deleted. The vendored `oh`'s dependencies
    are READ from the vendored `install/import/ontology/<release>/ontology.json`
    entry. When they are absent (the 7.0 release, until the refresh), the
    installer warns that the built-in file declares none and installs `oh`
    alone. This is not an error.
  - The closure follows `main: ontology35` dependencies depth-first, with
    dependencies installed first. Core and engine TLDs are skipped.
    `main: hierarchy1` dependencies form the thesaurus set for
    `install_hierarchies`. Core `lg` is activation only, as before.
  - `mandatory: true` is always installed and cannot be unticked.
    `mandatory: false` is offered PRE-TICKED, and the operator may decline it.
  - NEW answer `declined_dependencies`: a TLD, or `<tld>:ontology35|hierarchy1`.
    The CLI flag is `--decline-dependencies`. A malformed token is refused.
  - NEW `--plan` keys `hierarchy_dependencies` and `declined_dependencies`.
  - NEW `persist_config` extension key `hierarchy_dependencies`:
    `[{tld, mandatory, dependants}]`, the installable thesauri.
  - NEW catalog view field `hierarchy_dependencies` in `get_ontology_catalog`
    and `--list-ontologies`.
  - The wizard's `install_hierarchies` step re-derives the declared thesauri
    on the server, from the installed registry rows. It unions in the
    mandatory ones, so unticking cannot decline one.
  - A dependency on a core or engine-owned TLD is never declinable (the seed
    always installs it): no "declined" note is emitted for it, and the wizard
    shows it ticked and locked.
  - A mandatory thesaurus with no vendored `<tld>1.copy.gz` is refused
    loudly, before any write. A missing optional one is warned and skipped. An
    optional ontology the source does not offer is warned and skipped. A
    mandatory one is an error.
  - When `ACTIVE_ONTOLOGY_TLDS` lacks a mandatory dependency, the refusal now
    says "… declared as mandatory dependencies". A missing optional dependency
    there counts as declined.
- **`ddengine11` is retired, not merely deleted.** `engine_ontology.json`
  lists it under `retired`. On every install, the next run of the engine
  ontology door (boot, install, the suite setup) prunes it from all three
  places:
  - its `ddengine0/11` source record, deleted through the per-record delete
    pipeline, which writes a TM snapshot;
  - its `dd_ontology` row, dropped by the rebuild;
  - any `ddengine11` key on `ontology35` registry rows.

  No migration is involved: the migration law forbids `DELETE` on shared
  tables, and the node is the engine door's to remove. On a 2026-10-09 install
  the stored `ddengine11` declarations are dropped, not converted. They had
  existed for one day, the master had not declared anything with them, and
  the master re-declares them in `hierarchy60`.

## Reason

A bare TLD cannot say whether the thesaurus or the ontology is needed, nor
whether the operator may go without it. The master ontology owns the field, so
it travels with the ontology like every other registry component, and no
engine-owned node grafted onto another TLD's form is needed. The registry-row
law makes an import or a rebuild stop undoing an operator's local decisions:
switching a domain TLD off, its project filter. The language comes from the
installation, never from a constant. Any Dédalo server can be the master of
others, so there is one behaviour and no master/client split.

## Gate reconciliation

- `test/unit/ontology_dependencies_normalizer.test.ts` (hermetic): the
  normalizer rules.
- `test/unit/ontology_dependencies_native.test.ts` (suite DB, scratch `zzk*`):
  - the stored shape;
  - census objects, with a TLD declared twice, `hierarchy1` kept on self,
    `[]` present, an undeclared row giving no key, and invalid items giving
    census error lines;
  - the `ontology.json` → manifest round trip;
  - `reportMissingDependencies` reasons and lines, with no write.
- `test/unit/ontology_registry_row_native.test.ts` (suite DB, `zzrra`/`zzrrb`):
  the registry-row law, door by door, including the core branch on the suite's
  `lg` row (snapshotted and restored).
- `test/unit/ontology_update_shell_native.test.ts` case 7: a real
  `updateOntology` stores `hierarchy60`, reports a missing mandatory
  dependency in `errors` and in `missing_dependencies`, and an optional one in
  `msg`. Nothing is installed.
- `test/unit/ontology_manifest_native.test.ts` and
  `test/unit/ontology_update_target_native.test.ts`: the object shape on the
  client side and on the stager.
- `test/unit/install_ontology_door_native.test.ts`: the census round trip
  carries objects end to end.
- `test/unit/install_ontology_choice.test.ts`,
  `test/unit/install_plan_parity_tripwire.test.ts`,
  `test/unit/vendored_ontology_closure_tripwire.test.ts`,
  `test/unit/install_persist_config.test.ts` and
  `test/unit/install_hierarchy_dependencies_native.test.ts`: the install
  closure, mandatory vs optional, declining, the thesaurus set, the refusal for
  an unvendored thesaurus, and the server-side union driven through the real
  `install_hierarchies` step (`runInstallStep`).
- `test/unit/install_seed_drift_tripwire.test.ts`: each core registry row of
  the committed seed carries exactly the release entry's declaration (absent ⇔
  not declared).
- `test/unit/engine_ontology_retired_native.test.ts`: the `ddengine11`
  residue is planted and the door prunes it; the second run is a no-op.
- `test/unit/seed_build_native.test.ts`: the seed was recompiled. The only
  content change is the `ontologytype` registry row's `hierarchy9`, from 3 to
  15 (its definition's value). The parent grouper no longer rewrites it.
- **Fixtures:** no parity gate replays `ontology.json`, the manifest, the
  census or the update/installer responses, so no re-harvest is needed and no
  fixture changes. With `ddengine11` gone, the `ontology35` / `hierarchy1`
  edit structure context is back to its pre-2026-10-09 shape.

## Addendum 2026-10-10 — a THESAURUS dependency never blocks an install (owner decision)

**Decision (owner, 2026-10-10):** a `main: 'hierarchy1'` dependency — declared
on an `ontology35` registry row OR on a `hierarchy1` row / `hierarchy.json`
entry (one component, one law) — must NEVER block an install. `mandatory: true`
on a thesaurus is a STRONG RECOMMENDATION: users can work without it, define a
thesaurus of their own under another name, and install it any time later.
ONTOLOGY dependencies (`main: 'ontology35'`) keep the rule above unchanged
(mandatory = always installed, an unoffered mandatory one is an error).

**Shape before (TS, this entry):** a mandatory thesaurus was always installed
and could not be unticked; the wizard locked its row and `install_hierarchies`
unioned it into the posted list; one with no vendored entry refused the plan /
the step (`install.invalid_input`) / the batch.

**Shape after (TS):**
- Every declared thesaurus, mandatory or optional, is offered PRE-TICKED and is
  DECLINABLE (`declined_dependencies`, `<tld>` or `<tld>:hierarchy1`; the
  wizard's ontology step and its "Install hierarchies" step both leave the row
  editable, marked "strongly recommended").
- Declining a MANDATORY thesaurus is a WARNING (plan `warnings`, the CLI `⚠`
  lines, the step's `msg`), one text from ONE function
  (`ontology_choice.ts recommendedThesaurusWarning`):
  `the thesaurus '<tld>' (declared mandatory by '<dependant>'[, …]) is declined — not installed; it is strongly recommended and can be installed later from Maintenance › Install hierarchies`.
  Declining an optional one is the unchanged note.
- A thesaurus with NO hierarchy.json entry is a warning and is skipped,
  mandatory or not — never an error, never a refusal:
  `the thesaurus '<tld>' (declared mandatory by …) has no entry in hierarchy.json — skipped; it is strongly recommended and can be installed later from Maintenance › Install hierarchies`.
- The wizard's `install_hierarchies` step adds NOTHING to the posted list
  (`withMandatoryHierarchies` is replaced by `unmetHierarchyDependencies`,
  which only warns); `hierarchyDependencyPlan` answers `{install, warnings}`
  (its `errors` key is gone).
- `persist_config`'s `hierarchy_dependencies` keeps its shape: every entry is
  pre-ticked by the client, `mandatory` now only drives the "strongly
  recommended" mark.

**Reason:** the premise — a heritage install must never be blocked by an
optional-in-practice vocabulary; refusing an install because a release lacks a
thesaurus (or because the operator keeps their own) protected nothing.

**Gate reconciliation:** `install_ontology_choice` (declined mandatory → warning
text, TLD and TLD:main, chosen-anyway never warned, no-entry → warning,
`unmetHierarchyDependencies`), `install_plan_parity_tripwire` (i) (CLI ≡
wizard: a declined mandatory thesaurus leaves the plan with the warning; an
unvendored one warns, exit 0), `vendored_ontology_closure_tripwire` (a release
still must not ship a declaration without an entry — now measured as an empty
warning list), `install_hierarchy_dependencies_native` (the real step: a
posted `[]` declines a vendored mandatory thesaurus — ok, nothing imported,
warning in `msg`; no entry → the same, never `install.invalid_input`;
mutation-checked by re-adding the union → red). No fixture changes, no
re-harvest.
