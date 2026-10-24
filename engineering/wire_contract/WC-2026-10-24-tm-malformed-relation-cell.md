# WC-2026-10-24-tm-malformed-relation-cell — a Time Machine relation snapshot holding a non-locator value is flagged on read and refused on restore, never a 500 nor a live write

- **Date:** 2026-10-24 (owner report: Inspector → Component History on a user record, component
  `dd1725` (profile `component_select`) → `dd_core_api::read` answered `internal.unexpected`,
  `TypeError: recordA is not an Object` in `compareLocators`). Extends the named exemption of
  `WC-2026-08-14-tm-cells-obey-list-emit-policy` (`unresolved_component_tipo`).
- **Decision:** DEC-12 (gated, mutation-verified: `test/unit/tm_malformed_relation_value_native.test.ts`
  — the dd15 history list; `test/unit/tm_malformed_relation_restore_native.test.ts` — the tool's
  preview pane and both restore doors). Owner decision: the v7 reader does NOT convert pre-v6 shapes — converting them
  is the v6→v7 upgrade's job.
- **Shape before (TS):** the dd15 builder (`tm_record.ts`) coerced any non-array per-component
  datum to `[datum]` and injected it into the relation column. A TM row of a relation-column model
  whose stored value is not a locator array — a pre-v6 bare section_id (`2`), label strings
  (`["Hispania"]`), another model's object under a reused tipo, a locator without an address —
  reached the relation readers; for the select family `compareLocators` threw on the primitive and
  the WHOLE history read answered `500 internal.unexpected` (every row of the page lost).
- **Shape after (TS):** the row's OWN component cell is emitted in place as an explicit flagged item
  (same shape as `unresolved_component_tipo`): `{section_id: <tm row id>, section_tipo: 'dd15',
  tipo, mode: 'list', lang: 'lg-nolan', parent_tipo: 'dd15', row_section_id, entries: [],
  fallback_value: null, error: 'malformed_relation_value', reason: '<human-readable, names the
  offending value>'}`. Every other row and column of the read renders as before (`200`). Accepted
  shapes are unchanged: null, an array of addressed locators (`section_tipo` + `section_id`), a
  single addressed locator object (coerced to `[locator]`). A MIXED array is flagged whole (no
  partial value). The raw `dd1574` cell still carries the stored bytes verbatim. `compareLocators`
  answers `false` when either side is not an object (was: TypeError); between two objects the
  locator law is unchanged.
- **Shape before → after, the tool's PREVIEW pane** (`dd_core_api::read` get_data with
  `source.data_source:'tm'` + `matrix_id`, section/read.ts): before, a malformed row of the previewed
  relation component was grafted verbatim into the record (a bare `1` → the select item's `entries:
  1`, a non-locator to the client; other readers threw). After: it previews as the EMPTY value and
  the component's item carries `error: 'malformed_relation_value'` + `reason` (the list cell's
  text); `datalist` and every other key unchanged. A single addressed locator object previews as
  `[locator]`.
- **Shape before → after, RESTORE** (`tool_time_machine.apply_value`): before, a malformed component
  row was WRITTEN into the live relation column (`relation.<tipo> = 1`), and a whole-record row
  wrote its relation column verbatim. After: refused before anything is locked or written —
  `409`, new registry code `tool.snapshot_unrestorable` (`conflict`, public, not retryable, label
  `error_tool_snapshot_unrestorable`; the offending value rides `coordinates.reason`, log-only). A
  whole-record row is checked key by key on its `relation` column and refused WHOLE on one
  malformed key (also covers the bulk revert's undelete, which shares that door). A single
  addressed locator object is written as `[locator]`. A well-formed row restores exactly as before.
- **Reason:** a decade-scale audit log carries shapes no live table holds (measured 2026-10-24: zero
  non-locator relation values in every live matrix table and in every whole-record snapshot's
  relation column; ~290k per-component TM rows across relation models do). One such row must not
  take down the history browse, and dropping it silently would hide history; the cell announces
  itself instead.
- **Gate reconciliation:** TS-only (no oracle interaction covers a malformed TM relation row; no
  re-harvest). `tm_emit_row_context_native` (select cell labels on both TM surfaces) unchanged and
  green.
