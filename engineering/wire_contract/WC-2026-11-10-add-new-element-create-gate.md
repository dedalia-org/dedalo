# WC-2026-11-10-add-new-element-create-gate — add_new_element authorizes its target section; two create rules, each door names its own

- **Date:** 2026-11-10 (T0-2, audit O03 / O05; owner decisions D1 (b), D2 yes, D3 gated,
  D4 yes, D5 (a) of 2026-11-10 — D4 and D3 REVISED the same day after a regression hunt).
  The two rules are `authorizeRecordCreate` and `authorizeSectionCreate`
  (`src/core/security/write_door.ts`); the add_new_element gate site is `applyAddNewElement`
  (`src/core/relations/save.ts`).
- **Decision:** DEC-12. Restores the PHP refusal on `add_new_element` and goes beyond it in
  three named places (below).

## Shape before (PHP, and TS until this entry)

A save on a relation component (`component_portal`, `component_select`, any relation model;
also the temporal save and the `component_relation_children` write-through):

```
{action:'save', source:{tipo:P, section_tipo:HOST, section_id:1, …},
 data:{changed_data:[{action:'add_new_element', id:null, value:T}]}}
```

- **PHP** (`component_common::update_data_value` `add_new_element` →
  `security::get_section_new_permissions(T) < 2`: the FIRST `button_new` of `T`,
  virtual/exclude-aware; no `button_new` → `null < 2`) answered `result:false` + a message —
  but did NOT check that `T` is one of P's target sections, and did not ask the section
  level of `T`.
- **TS until this entry** authorized only the HOST (P ≥ 2 + the host record scope) and
  created the record in whatever `T` the caller named: any section with a matrix table,
  users (`dd128`) and profiles (`dd234`) included, with a NEW activity row under the caller.
- Core `create` / `duplicate`, the tree's `add_child` and the MCP `create_record` /
  `duplicate_record` / `find_or_create` asked the section level (≥ 2) only — PHP
  `dd_core_api::create` parity.

## Shape after (TS)

There is NO single create rule engine-wide, by design. Two rules; every create door asks
exactly one, and `create_door_census_tripwire` records which.

1. **The New-button predicate** (`authorizeRecordCreate`) — "may press New in S": the
   consultation-capped section level (`getSectionPermissions`) ≥ 2 AND the first `button_new`
   of S (`section/buttons.ts` `sectionButtonRows` — the real section's buttons then the
   virtual's own, minus the first `exclude_elements`) at ≥ 2. A section with no `button_new`
   admits no such create, the superuser included. Asked by:
   - **add_new_element through a user door**: the portal / select save, the temporal save,
     the children write-through "+" — the predicate on `T` FIRST, then the door's membership:
     - portal/select save and temporal save: `T` must be one of P's target sections
       (`request_config/build.ts` `getElementTargetSectionTipos`, the resolver the client's
       target list comes from) → else **`request.invalid_source` 400**. **Stricter than PHP.**
     - children write-through: its existing structural check (`assertChildSection`) is the
       membership; nothing added. The create refusal now happens BEFORE the insert.
     - the temporal door keeps its earlier `request.invalid_source` 400 for an empty or
       consultation-only `T` (dd542 / dd15).
   - **`dd_ts_api` `add_child`**, **core `duplicate`** (after the source record's scope),
     **MCP `create_record`, `duplicate_record`, `find_or_create`** (its create branch), and the
     **agent change plan's dry-run** of those ops (`src/ai/agent/change_plan.ts` — the same
     predicate the executors ask, so a confirmed plan cannot half-apply). **Stricter than PHP**
     for duplicate / add_child / the MCP (PHP read the section level there).
   - Section level also required (D1 (b)): PHP asked only the button. **Stricter than PHP.**
2. **The section-level create** (`authorizeSectionCreate`) — the consultation-capped section
   level ≥ 2, nothing else. **PHP `dd_core_api::create` parity.** Asked by:
   - **core `create`** — it serves feature-owned sections that ship NO `button_new`: text-area
     notes (`rsc326`), Time Machine notes (`rsc832`), index notes (`rsc377`), references
     (`rsc425`), dataframe Annotation frames (`rsc1379`, the client's `component_dataframe`
     `create_new_section`), presets (`dd623` for profiles without `dd631`). Asking the New
     button there refused them for everyone, root included (the regression this revision
     undoes). Residual, as in PHP: a crafted `create` skips the New button.
     Residual (owner-sanctioned D3): `tool_import_files`' tool access applies to ANY
     `component_option` portal of a caller section the user can write — its
     `tool_config.ddo_map` is client-supplied — so it creates in that portal's
     `target_sections` at section level, no New button.
   - **a TOOL-driven add_new_element** (`tool_import_files`, `tool_posterframe`,
     `tool_numisdata_acquisition`) — then P's target sections membership (400 as above), no
     New-button half. The tool passes `SaveRequest.toolCreateAccess`, minted only by
     `toolAddNewElementAccess` (`relations/save.ts`): it is not a wire field (the save door
     builds its request field by field) and it carries a module-private symbol brand no JSON
     payload can produce — an unbranded `tool` access is refused (`internal.invariant`). The
     census pins its minters to tool server code.
   - The tool import create doors (`import_execute`, `import_csv_execute`, `tool_import_rdf`,
     the acquisition tools' `targets` kind) and the duplicate's dataframe frame-target
     re-mint ask the same section level through their own section-target checks.

Every refusal: **`perm.denied` 403** (envelope v2), nothing created, no activity row, the host
untouched.

- The portal "+" affordance (`request_config/explicit.ts` `findSectionButtonTipo` →
  `buildSqoSectionTipoDdos` `buttons[]`) reads the same `sectionButtonRows`, so "+" is offered
  iff the user-door gate admits it.
- **The hierarchy invariant's root term** (`ontology/hierarchy_state.ts`): minted in `system`
  mode ONLY in the hierarchy's OWN provisioned section, which `isOwnProvisionedSection` checks
  as exactly: the tipo is `<tld>1`/`<tld>2` of the row's TLD (hierarchy6); its dd_ontology node
  is a `section`; `getSectionRealTipo(target)` differs from the target (a VIRTUAL — a real
  section named `<tld>1`/`<tld>2` fails) and equals the row's declared source (hierarchy109,
  unset = hierarchy20); and no OTHER hierarchy1 record declares the same hierarchy6 (trim +
  lower-case) — a uniqueness scan, because provisioning records no ownership fact the editor
  cannot also write (the hierarchy53/58 write-back is on the same editable row). Residual: a
  TLD with no hierarchy1 row at all (ontology-only) is "owned" by the first row declaring it. An
  operator-declared foreign target (hierarchy53/58 are editable literals, so steerable) is
  minted under the ACTING principal's New-button predicate (installer = superuser, the
  hierarchy tool = its caller); a refusal is reported as the hierarchy's error, nothing
  created.

## Reason

The target of `add_new_element` is caller-named; the host's grant says nothing about it, so
an editor of any portal could create users, profiles or records in any section. What a user
does by pressing "New" / "+" answers to the button the section list renders; what a feature
or a tool creates in a section it owns (notes, frames, presets, imported media) answers to
the section level, as PHP did. Naming the rule per door (and censusing it) is what keeps the
two from drifting into a third.

## Gate reconciliation

`test/unit/add_new_element_create_gate_native.test.ts` (shared authz door fixture, generic
`test` TLD): every New-button door (portal, temporal, children, duplicate, add_child, MCP
create / find_or_create / duplicate, the declared hierarchy root term) refuses with code +
status, nothing created, no activity row, the host byte-identical, and has a granted control
(mutation-verified: disabling the `authorizeRecordCreate` call in `applyAddNewElement` reds 12
of its cases); every section-level door (core create, the tool add_new_element) is refused
below section 2 AND creates with the New button withheld (mutation-verified: the tool branch
asking the New button reds its control). Regression pins: core create in `rsc326`, `rsc832`,
`rsc377`, `rsc425`, `rsc1379` and through the `test6453` dataframe slot, as superuser and as a
non-admin holding the section only — RED under the first cut of this entry, green now.
`change_plan_write_door_native` pins the plan dry-run on the New button. Fixtures whose
intent is "may create" gained the `button_new` grant (`authz_door_fixture.ts` CONTROL and the
identities "= CONTROL", SECTION_ONLY, TEXT_ONLY; `scope_binding_fixture.ts` profiles A/B;
`record_defaults_native`'s scratch profile); scratch `zz*` situations whose gates create gained
a `button_new` node (`tree_lock_situation.ts`, `zzfoc`, `zzna` — whose face portals now also
declare their image-section target —, `zzwob`, `zzsrs`); the agent change-plan gates moved
their write surface from `test183` (no `button_new`) to `test65`. Two pins changed shape:
`ts_api_mutations_native` (add_child's refusal coordinates are the predicate's), and
`sql_confinement_tripwire` retired `explicit.ts` from the direct dd_ontology read ratchet. No frozen fixture carries an `add_new_element`
save or a non-admin create (the harvest ran as an admin) — **Re-harvest: none.**
