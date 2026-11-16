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
- **Bytes (DELIBERATE DIVERGENCE — amended 2026-11-12, T1-39 review):** an EXPORT cell
  (value / grid_value, every depth of the walk) is `relation_list.ts cleanupInertJson`:
  `JSON.stringify`, then every `/` written `\/` (PHP `json_encode`'s own default) and every `&`
  written `\u0026` (PHP would need `JSON_HEX_AMP`). Same JSON data; the bytes differ from PHP only
  for `&` and non-ASCII characters (no `\uXXXX` for those). Key order is the stored jsonb order on
  both engines. The INTERACTIVE readers (relation_list panel, Referencias, related labels, the term
  resolver) never clean, so they keep plain `JSON.stringify` (option absent).
  `dedalo_raw` is unchanged (`JSON.stringify`, the lossless form).
- **Term resolver:** a `json` term part is record-local (`term_resolver.ts
  RECORD_LOCAL_FAMILIES`): it reads the host record only, so the term stays cacheable. Reader-
  visible: a thesaurus / section term or a ddo_map label (`getTermByLocator`,
  `getDdoValueByLocator` — tree nodes, `get_section_terms`) naming a json / geolocation part
  changes from BLANK to that item's JSON (plain `JSON.stringify`; geolocation list-served). PHP
  parity (`get_value` → `to_flat_string`). Gate: `term_resolver_model_flat_native` JSON PARTS
  (the label, the ddo_map label, and the cache law — red when `json` leaves
  RECORD_LOCAL_FAMILIES).
- **The text cleanup (DELIBERATE DIVERGENCE — amended 2026-11-12, T1-39 review).** The JSON
  cell is a value cell and the tabulator cleans every value cell after the join
  (WC-2026-11-12-export-text-cell-clean). The first version of this entry said "only `&` entities
  inside a JSON string value would change" — FALSE for the plain `JSON.stringify` bytes it shipped:
  `</p><p>` inside a stored string became a raw newline and `&quot;` an unescaped `"`, so the cell
  no longer parsed. PHP itself is corrupted the same way by `&quot;` (its `\/` only spared it the
  `</p><p>` rule). The cleanup-inert encoding above makes the cleanup a provable no-op on a JSON
  item (no `</`, no `&`, never a leading `<`): every json/geolocation cell PARSES to the stored item
  (geolocation: the list-served entry). Divergence from PHP: an entity stored inside a JSON string
  (`&amp;`, `&quot;` …) is NOT decoded — PHP decoded it, mutating the data and, for `&quot;`,
  producing invalid JSON. Text atoms joined in the same cell are still cleaned exactly as before.
  Residue: a `#parents` / `#references` cell is a TERM (term_resolver.ts, plain `JSON.stringify`
  for a json term part) and is cleaned as text — a label, not the field's value.

## Reason

A blank column with an `unresolved` note was the engine admitting it could not export a value PHP
always exported. Institutions export preset blobs, structured JSON fields and coordinates.

## Gate reconciliation

`test/unit/tool_export_coverage_native.test.ts` C1 (json), C2 (geolocation, `dedalo_raw` control),
C3 (interactive reader) — since the T1-39 review the stored json / geolocation items hold `</p><p>`,
entities and `/`, and every value / grid_value / preview cell is asserted to PARSE to the stored
item; `test/unit/export_clean_text.test.ts` pins `cleanupInertJson` (cleanup no-op + lossless, the
plain encoding's corruption as the non-vacuity control). `relation_list_cell_families_native`'s "uncovered model is LEDGERED" probe
moved from `test18` (json) to `test152` (component_password, a permanent non-export).
`descriptor_completeness_tripwire` NO_FLAT_VALUE_LEAF_EXEMPT lost both entries (shrink-only).
No frozen fixture changes: `tool_export_differential` / `tool_export_breakdown_differential` hold
no json/geolocation column (their banked reds are unchanged, measured before/after).
