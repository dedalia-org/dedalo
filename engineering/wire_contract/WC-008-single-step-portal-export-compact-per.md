# WC-008 — single-step portal export = COMPACT per-reference cells (PHP fans out deep)

- **Date:** 2026-07-08 (user-requested: "the three resolutions are correct").
- **Shape before (PHP):** `tool_export.get_export_grid` with `data_format:
  'grid_value'` and a SINGLE-step `ar_ddo_to_export` path whose component is a
  portal (stored ontology model `component_portal`) recurses the portal's
  request_config and emits one column PER LEAF FIELD
  (`numisdata6_numisdata163.rsc332_rsc368.rsc205_rsc140`, …).
- **Shape after (TS):** the same request emits ONE base column
  (`numisdata6_numisdata163`); each referenced record's FULL flat info (the
  per-target string of `resolveRelationTargetValues` — the same fields the
  value format joins) lands in ONE cell; the breakdown explodes references by
  ROW (`default`/`rows`) or by `'|n'` COLUMN (`columns`, labels
  `'Bibliografía 2'`…). Scope: STORED model `component_portal` only — the
  runtime `component_portal` alias of autocompletes keeps PHP deep parity.
- **Why:** product decision (owner, 2026-07-08) — all THREE portal resolutions
  must be selectable from the existing tool UI with no client change: drag the
  portal UNEXPANDED → compact per-reference (this shape); drag EXPANDED child
  components → deep field columns (multi-step paths, PHP-parity, byte-gated);
  format `Estándar` → everything in one cell (PHP-parity). PHP offers no
  compact option, so matching it would lose two of the three.
- **Gate reconciliation:** asymmetric pin in
  `test/parity/tool_export_breakdown_differential.test.ts` ("WC-008 single-step
  portal COMPACT …", both engines asserted); the multi-step deep corpus in the
  same file stays byte-equal to PHP. Implementation:
  `src/diffusion/export/atoms.ts` (compact branch) +
  `src/core/resolve/relation_list.ts::resolveRelationTargetValues` (extracted
  per-target half of the byte-gated datalist branch).
- **2026-07-10 extension:** compact cells now also fold in a reference's
  PAIRED DATAFRAME frames (`resolveDataframeFlatValue` — the "full ref info in
  one cell" promise extended to frame fields); no live portal carries paired
  frames on this corpus, so the existing WC-008 pins are unaffected.

## Addendum 2026-11-09 — the compact cell crosses the export frontier

Every target a compact cell resolves, at every datalist depth, and every paired frame target take
the export frontier's record key; an ungranted IMPLICIT child is dropped from the cell. A scoped
caller's export of a hidden deep record now throws `perm.export_column_out_of_scope` naming the
compact column. See `WC-2026-11-09-export-frontier-fanout`.
