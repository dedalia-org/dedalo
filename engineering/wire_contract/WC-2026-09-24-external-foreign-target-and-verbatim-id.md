# WC-2026-09-24-external-foreign-target-and-verbatim-id — flat/export external cells: remote id verbatim, foreign targets do not apply, grid_value external leaves emit

- **Date:** 2026-09-24 (`src/core/resolve/relation_list.ts`,
  `src/core/components/component_external/value.ts`,
  `src/diffusion/export/atoms.ts`, `src/diffusion/resolve/resolver.ts`).
- **Decision:** — (amends WC-2026-08-05-external-source-status for the flat and
  export surfaces; spec: `engineering/EXTERNAL_SPEC.md` §3 addendum 2026-09-24;
  gate: `test/unit/external_section_id_verbatim_native.test.ts`).

### Shape before (TS, 2026-08-05 → 2026-09-24)

Measured on the install DB (rsc332.rsc368, 12,557 zenon1 locators stored as
zero-padded strings such as `"000065686"`, mixed with local rsc205 locators):

- relation_list / export `value` cells: the flat resolver `Number()`-ed the
  target id, so the external column asked the service for `id=65686` → 400 →
  an EMPTY cell and `component_external` in `unresolved`.
- The same cells applied the zenon column to every LOCAL rsc205 target too;
  rsc205's stale `api_config` bound it, and the local id (`12281`) was sent to
  the service → 400 → empty cell + `unresolved`. (Padding it would have fetched
  a different, unrelated remote publication.)
- The export walk's relation hop `Number()`-ed the next owner id the same way
  (a declared `portal → zenon*` path).
- `grid_value` exports of ANY component_external leaf were empty: the model's
  inert `relation` column made the walk treat it as a locator bag to fan out.
- Three such 400s opened the breaker for every Zenon lookup (see
  WC-2026-09-24-external-record-4xx-is-not-found for the breaker half).

### Shape after (TS)

- The external family receives the stored id VERBATIM on every flat/export
  path; a stored-family column never reads a non-address (`"000012281"` is not
  record 12281 — `canonicalizeStoredSectionId` + `isSectionId`, the
  WC-2026-08-10-section-id-int-canonical rule).
- A component_external resolves only for records of its OWNING section (first
  `section` on its ontology parent chain, or a virtual section whose real
  section is that owner). Any other target — a local record sharing the portal
  — yields no value, NO remote call, NO `source_status`, and nothing in
  `unresolved`: the column does not apply to it, exactly as a stored column
  yields nothing on a record that does not hold it. On the edit/list emission
  surface a foreign target's item is `entries: []` with no `source_status`
  (unreachable today: the portal expansion already filters child ddos by their
  declared `section_tipo`).
- `grid_value` exports emit the external leaf's values (compact and fan-out
  paths alike).

### Reason

The id is the remote record's identity; converting it asks for a different
record. A local record is not a remote record, and no id transformation can
make a remote column apply to it — the fix is ownership, decided from the
ontology, never from the TARGET's `api_config` (which rsc205 carries as residue).

### Gate reconciliation

No parity gate covers external values (TS-native; the frozen fixture store holds
no external emission), so no re-harvest. Behaviour gate:
`external_section_id_verbatim_native` (mutation-verified: each reverted site —
the relation_list target id, the ownership check, the atoms plain-child id, the
walk hop id, the stored-relation predicate, the address guard — reddens it).

## Addendum 2026-09-24 (b) — the read-path prepass obeys ownership; no target id is Number()-ed; the frontier's external-reference rule

### Shape before (TS, the entry above)

- `relation_core.ts` (the edit/list portal expansion): a component_external ddo
  declaring NO `section_tipo` matched every target, so a LOCAL target sharing
  the portal (rsc205, api_config residue) counted as "derived" and its local id
  was prefetched from the service. A remote target whose child map also held a
  stored-model ddo read the matrix row `Number('000012281')` = 12281 — a local
  record rendered as the remote one. Dataframe frame targets were
  `Number()`-ed the same way.
- `frontierRecordAllowed` (export / diffusion / identify crossings) scoped an
  external reference as LOCAL record `Number(id)` — an unrelated row's answer —
  and a padded id on a local section (`'-000001'`) as record -1.

### Shape after (TS)

- The prepass asks `externalComponentAppliesTo`: a foreign component_external
  makes no target derived and contributes no field. No LOCAL id reaches the
  service; the emitted items for local targets are unchanged.
- A stored row is read only for a matrix ADDRESS (`isSectionId`); a remote id
  gets the identity-only placeholder (only derived children render there).
- Frontier record key: an external reference (non-address on an
  external-service section) PASSES — it has no local record; the component key
  governs the crossing. Any other non-address fails closed.

### Reason

Same as the entry: a remote id is the remote record's identity, a local record
is not a remote record, and ownership is decided from the ontology.

### Gate reconciliation

No parity fixture holds an external emission; no re-harvest. Behaviour:
`external_record_field_set_native` ("the relation prepass + the portal
expansion", "frontierRecordAllowed"), mutation-verified.

## Addendum 2026-09-24 (c) — externality at the frontier is record absence + a derived model, never api_config alone; diffusion reads addresses only

### Shape before (TS, addendum (b))

- The frontier record key classified a non-address id as an EXTERNAL REFERENCE
  whenever the section carried an `api_config` (`isExternalSectionTipo`).
  rsc205-style sections (stale api_config, only local rows, no
  component_external) therefore passed `'abc'` / `'010'` without a record check.
- Diffusion then `Number()`-ed what the frontier passed: `readMatrixRecords`
  read `'010'` as LOCAL record 10 (out of the principal's scope), the byId
  lookup missed, and `'010'` was pushed to `unpublishIds` → `removeRecords` —
  an unpublish reachable by a caller who cannot read the record. `'abc'` threw
  `non-integer section_id` and aborted the run.

### Shape after (TS)

- `frontierRecordAllowed`: 'external' only when the section binds a service AND
  owns a component_external (own or real section's subtree —
  `external/record_fields.ts isExternalReferenceSection`), the read path's law
  (relation_core: record absence + a derived model; a non-address id has no
  matrix row by construction). Any other non-address fails closed.
- Diffusion `processBatch` drops every non-address id BEFORE the frontier and
  any read, with a `[diffusion] … is not a record address — dropped` ledger
  line: never read, never unpublished, never fatal. `readMatrixRecords` refuses
  a non-address (loud) instead of `Number()`-ing it; the run's record loader
  (`loadRecords`) resolves it to no record.
- Published rows are unchanged for every record address; an unpublish of a
  non-address id no longer happens.

### Reason

`properties.api_config` is not externality (relation_core's own law; test3 and
rsc205 carry one over local rows). And a publication run publishes LOCAL rows —
a remote reference has none, so it is not the run's to read or to remove.

### Gate reconciliation

No parity fixture holds an external emission or a diffusion unpublish of a
non-address id; no re-harvest. Behaviour: `external_record_field_set_native`
("api_config RESIDUE is not externality"), `diffusion_frontier_scope_native`
(LAW 3), mutation-verified.

## Addendum 2026-11-12 (d) — the publication chain

The diffusion resolver now applies the same law: ownership (a foreign target asks nothing), the
remote id verbatim (the host row's `section_id`), component_external a TERMINAL (the ONE
predicate `registry.ts storesRelationLocators`, hoisted from `atoms.ts isStoredRelationModel`),
and a remote-only target walked on the identity-only placeholder. Ledger:
`WC-2026-11-12-diffusion-external-chain`. Gate: `test/unit/diffusion_external_chain_native.test.ts`.
