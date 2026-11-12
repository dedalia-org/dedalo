# WC-2026-11-12-export-json-geolocation-cells — `component_json` / `component_geolocation` export and flat cells are the JSON of each item

- **Date:** 2026-11-12 (RC-closure item T1-39, audit OX1).
- **Decision:** DEC-12 (gates in the same change). No owner decision needed: PHP parity on the
  value; the two byte-level details below are deliberate.

## Shape before (PHP)

Neither model overrides `component_common::get_export_value`
(`core/component_common/class.component_common.php:1901-1932`): one atom per stored data item,
an array/object item written as `json_encode($item)`; the leaf separator is
`build_export_path_segment`'s ddo → properties → `', '`. v6 `get_grid_value` behaved the same.
The interactive flat value (`get_value` → `to_flat_string`) is the same JSON.

## Shape before (TS)

Neither model declared a `flatValue` family: every `value` / `grid_value` cell (including the
WC-008 compact sub-cell) was BLANK and the model was reported in `meta.unresolved`; the
relation_list panel / Referencias / related labels showed nothing for such a column.

## Shape after (TS)

- **flatValue family `json`** (both descriptors). `resolveCellItems` reads the items through the
  value door (alias-aware; both models are non-translatable) and answers one string per item:
  `JSON.stringify(item)`. The export walk treats `json` as a literal family (one atom per item,
  `atoms.ts LITERAL_ITEM_FAMILIES`), so a multi-item cell joins with the leaf's fields separator
  (`', '` by default). Nothing is reported unresolved.
- **component_json:** the stored item verbatim (`{"id":1,"value":{…}}`).
- **component_geolocation:** the entry AS A LIST ROW SERVES IT (`geo/entry_siblings.ts
  servedGeoEntry(entry, 'list')`): view + `lib_data`, never the TS-only `sources` / `legend`
  (WC-2026-11-06-geolocation-map-sources-legend — the map definition has no consumer in a flat
  cell, and a legend may hold a quarter-megabyte of icons per row). `dedalo_raw` is unchanged and
  stays the lossless form (the keys ride there).
- **Bytes (DELIBERATE DIVERGENCE):** `JSON.stringify`, not PHP `json_encode` — no `\/` and no
  `\uXXXX` escaping. Same JSON data, different bytes for a `/` or non-ASCII character. Key order
  is the stored jsonb order on both engines. Precedent: `dedalo_raw` already encodes with
  `JSON.stringify`.
- **Term resolver:** a `json` term part is record-local (`term_resolver.ts
  RECORD_LOCAL_FAMILIES`): it reads the host record only, so the term stays cacheable.
- **dedalo_raw / the text cleanup:** the JSON cell is a value cell, so the tabulator cleanup
  (WC-2026-11-12-export-text-cell-clean) applies to it as in PHP (only `&` entities inside a JSON
  string value would change).

## Reason

A blank column with an `unresolved` note was the engine admitting it could not export a value PHP
always exported. Institutions export preset blobs, structured JSON fields and coordinates.

## Gate reconciliation

`test/unit/tool_export_coverage_native.test.ts` C1 (json), C2 (geolocation, `dedalo_raw` control),
C3 (interactive reader). `relation_list_cell_families_native`'s "uncovered model is LEDGERED" probe
moved from `test18` (json) to `test152` (component_password, a permanent non-export).
`descriptor_completeness_tripwire` NO_FLAT_VALUE_LEAF_EXEMPT lost both entries (shrink-only).
No frozen fixture changes: `tool_export_differential` / `tool_export_breakdown_differential` hold
no json/geolocation column (their banked reds are unchanged, measured before/after).
