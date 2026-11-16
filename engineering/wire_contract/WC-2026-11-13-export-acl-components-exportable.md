# WC-2026-11-13-export-acl-components-exportable — `component_security_access` and `component_filter_records` export like any component (JSON cells, the ordinary gate)

- **Date:** 2026-11-13.
- **Decision:** owner ruling C44 (`T1_owner_decisions.md`, 2026-11-13; item
  T1-39 D2): "EXPORTABLE — security_access / filter_records export like any
  component (profile transfer between servers), subject to normal export
  permission." REVERSES the shipped exemption of T1-39 (3fa87f0b5e), which kept
  both models out of the export with the reason "an ACL matrix blob: no flat
  text value; ledgered unresolved". DEC-12 gate:
  `test/unit/tool_export_coverage_native.test.ts` C6 (own `zzsax` situation);
  `test/unit/descriptor_completeness_tripwire.test.ts` (the two exemption rows
  left `NO_FLAT_VALUE_LEAF_EXEMPT`, `flatValue` asserted `json`).
- Code: `src/core/components/component_security_access/descriptor.ts`,
  `component_filter_records/descriptor.ts` — `flatValue: 'json'`.

## Shape before (PHP)

Neither class overrides `get_export_value`: `component_common::get_export_value`
base (`:1913-1928`) — one atom per stored item, `json_encode($item)`. A profile's
permission matrix (`dd774`) and a user's record filter (`dd478`) exported as
JSON cells. Base `cell_type` `text`.

## Shape before (TS, 3fa87f0b5e → today)

No `flatValue` family: every value / grid_value cell of either column a
ledgered `null` (`unresolved: ["component_security_access"]` /
`["component_filter_records"]`), the relation_list panel blank; `dedalo_raw`
unchanged (the stored slot). Permission: the column was refused nothing — it
simply resolved to nothing.

## Shape after (TS)

Both models are the `json` flat-value family (as `component_json`,
`component_geolocation` — `WC-2026-11-12-export-json-geolocation-cells`):

- value AND grid_value: one atom per stored item, the item as JSON in jsonb's
  key order (`JSON.stringify` with `/` → `\/` and `&` → `&`, the inert
  encoding the text cleanup cannot rewrite; the cell parses back to the stored
  item). `cell_type` `text`. No `unresolved` note.
- relation_list panel / flat readers: the same strings.
- dedalo_raw: unchanged.
- PERMISSION: the ordinary export gate and nothing more — the tool's per-column
  component ACL (`perm.denied` without a grant on the component), the section
  grant, the record scope (`perm.export_column_out_of_scope`). Nothing names
  these two models.

## Reason

A profile's permission map and a user's record filter are configuration an
institution moves between its servers (a staging copy, a second installation):
the export is how. Who may read the column already decides who may export it;
withholding the two models by model was a second, model-specific gate the owner
ruled out.

## Gate reconciliation

`tool_export_coverage_native` C6 was RED before (both cells `null`); the
descriptor tripwire's leaf census would be RED with the rows kept (an entry
that gained a family is stale). No frozen fixture replays these columns.
