# WC-2026-11-10-hierarchy-rebuild-ownership — a TLD teardown runs only for the hierarchy that owns it

- **Date:** 2026-11-10 (HIER-REBUILD, found by the T0-2 adversarial review; owner decisions
  of 2026-11-10: D1 a derived ownership, D3 a refuse duplicates, D4 one code + `reason`,
  D5 a, D6 `lg` is core, D7 a ensure folds case 2 in, D9 no engine cleanup, D10 force =
  from scratch). Sites: `src/core/ontology/hierarchy_state.ts` (`classifyHierarchyRebuild`,
  `rebuildHierarchy`, `ensureHierarchy`), `src/core/ontology/ontology_delete.ts`,
  `src/core/ontology/teardown_scope.ts`, `src/core/api/handlers/dd_core_api.ts` (delete
  cascade), `tools/tool_hierarchy/server/tool_hierarchy.ts`.
- **Decision:** DEC-12. INHERITED flaw, not a TS divergence: PHP `tool_hierarchy::
  generate_virtual_section` → `hierarchy::delete_main` → `delete_ontology($tld)` read the
  TLD from the same editable `hierarchy6` with no core / ownership check.

## Shape before

Two doors erased a TLD's whole ontology (every `dd_ontology` node of the tld, its
`ontology35` row, every `<tld>0` record) on the strength of a registry row's EDITABLE
`hierarchy6` literal:

- **Door A** — `tool_request tool_hierarchy.generate_virtual_section {force_to_create:true}`
  (level 2 on `hierarchy1/<id>`): teardown, THEN `ensureHierarchy`, in separate
  transactions. A row repointed at another TLD (`dd`, `rsc`, an installed package) tore it
  down; a package-shaped TLD (`lg`, `numisdata`, `tch`) was truncated to `<tld>0/1/2`; a
  row whose `hierarchy109` names no section (110 master rows store `hiearachy20`) was torn
  down and never re-provisioned.
- **Door B** — `dd_core_api delete` (`delete_record`) of a `hierarchy1`/`ontology35` record
  (global admin): uninstalled the declared TLD even when it was core, or when another
  registry record still declared it.
- `ensureHierarchy` (no force) provisioned `<tld>0/1/2` for a row rooted at a foreign
  defined section (hierarchy53 → `numisdata3`), and steered the operator to Rebuild.
- `inspect_hierarchy` answered `{state}`.

## Shape after (TS)

A refused teardown answers BEFORE any write, one code, the why in the top-level `reason`
extension key (and in `details`):

```
{ok:false, error:{code:'ontology.teardown_refused', status:409,
  label_key:'error_ontology_teardown_refused', details:{tld, reason}},
 reason:'core'|'not_sole_declarer'|'root_only'|'ontology_package'|'invalid_source',
 state:{…}}                         // door A only: the checklist, as before
```

- **Door A** force rebuild runs only for an OWNED case 1 hierarchy: the tld is not core and
  not `test`; the row is the SOLE `hierarchy1` record declaring it; `hierarchy53` is unset or
  the row's own `<tld>1`/`<tld>2`; `<tld>1`/`<tld>2` in STORED `dd_ontology` are absent or
  each a `section` virtual of exactly one real section outside the tld; the tld's
  projection is CONSISTENT (record `<tld>0`/N ↔ node `<tld>N`, both ways); every node but
  `<tld>0/1/2` descends from `<tld>1`/`<tld>2` (legacy extras of any model — no model
  allowlist; a node hung anywhere else is package structure); an ABSENT shape holds no
  `<tld>0` record and no `ontology35` row (live: `mdcat` — 12 records, one node, an
  `ontology35` row, no registry row — was wipeable through "absent"); every provisioning
  precondition holds. Then FROM SCRATCH (D10): all
  tld nodes, all `<tld>0` records (extras included), the `ontology35` row are deleted and
  `<tld>0/1/2` + a fresh `ontology35` row provisioned — in ONE transaction, ONE lock order:
  the `hierarchy1` row `FOR UPDATE` (read once: the tld classified is the tld torn down),
  every `<tld>0` record and the `ontology35` row `FOR UPDATE`, then the tld's projection
  lock (the ordinary record delete takes row → projection; the reverse order deadlocked).
  ANY failure after admission — a provisioning that does not end usable, a Postgres error
  in the teardown or the provisioning — rolls everything back (`tool.action_failed` with
  `state` re-inspected after the rollback, nothing changed). Provisioning joined to the
  rebuild's transaction runs under a SAVEPOINT (and its non-fatal permission grant under
  its own), so a SQL error there no longer aborts the caller's transaction (it surfaced as
  `internal.unexpected` 25P02). The `<tld>1` terms are never touched.
- **Door B** refuses `core` (a core or `test` TLD) and `not_sole_declarer` (another record
  of the same registry declares the TLD — D3 a: no cascade, no record delete). Every target
  of a multi-delete is admitted before the first cascade runs. The `deleteOntologyByTld`
  primitive itself refuses a core/`test` TLD.
- `ensureHierarchy` never provisions `<tld>0/1/2` for a ROOT-ONLY (case 2) row — `hierarchy53`
  outside `<tld>1`/`<tld>2`, or a stored `<tld>1`/`<tld>2` that is not the provisioned
  shape. Its `ontology` check becomes "the declared sections are sections"; a default
  target is written only when that section exists; the "INCOMPLETE — use Rebuild" hint
  names the refusal instead when Rebuild would be refused. A root-only row with
  `hierarchy58` UNSET has NO model root (no `hierarchy59` mint, `targets`/`root_model`
  pass with "none"); a SET `hierarchy58` naming a non-section is still an error
  (owner decision 2026-11-10).
- `inspect_hierarchy` answers `{state, rebuild:{allowed, reason}}`; the panel disables
  "Force to create" with the reason's tool label (`rebuild_refused_<reason>`), and the
  force confirmation says the definitions are deleted and recreated from scratch.

D5 (a): no new code — a package truncated by an earlier force rebuild is restored by the
ontology update, which re-imports it; the refusal message points there.

## Reason

The teardown trusted an editable literal, and its scope (the whole tld) exceeded what
provisioning can recreate (`<tld>0/1/2`). Ownership is DERIVED (D1 a: uniqueness + stored
shape, never `hierarchy109`/`hierarchy53` alone); residual: a provisioned-shape TLD with no
registry row can be claimed by the first row declaring it (bounded: 3 nodes, terms survive).
Residual (not changed here — a general `delete_record` change): the per-record delete
pipeline's media move to `deleted/` and unpublish-intent settle run after its own
(joined) transaction and are not undone by the rebuild's rollback; ontology node records
carry neither today.

## Gate reconciliation

`test/unit/hierarchy_rebuild_scope_native.test.ts` (G1 hijack via the real save door, G2
package, G2a D10 pin, G2b case 2 ×2, G2c ensure, G3 duplicate, G4 control, G7 invalid
source, G7b rollback through the injected deleteRecord, G8a–d half-projected / inactive
package / inconsistent projection, G9 stray node, G10 SQL error mid-teardown, G11 SQL
error inside provisioning (an in-transaction trigger), G12 SQL error in the non-fatal
grant, G13 `inspect_hierarchy` `rebuild`, G6 door B duplicate, G6b multi-delete, G5/G6 core
for `rsc`/`lg`/`test` in an always-rolled-back transaction, each asking the pure predicate
before any door). Client: `test_tool_hierarchy.js` `paint_rebuild_policy`. `ontology_single_writer_tripwire`
rule 4: `deleteOntologyByTld` named only by `ontology_delete.ts` and `src/core/test_data/`.
Re-pinned: `add_new_element_create_gate_native` F2 (a row steered at a foreign section is
root-only — no own `<tld>0/1/2`, no model root; the control ends `ok` with `errors []`), `tool_lossless_writeback_tripwire` force_to_create
verdict text, `error_taxonomy_tripwire` B1/B2 entries for `hierarchy_state.ts` lowered.
No parity fixture records `generate_virtual_section`, `inspect_hierarchy` or a registry
delete: no re-harvest.
