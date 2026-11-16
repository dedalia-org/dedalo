# WC-2026-11-12-select-dataframe-subdatum — a component_select with a dataframe slot emits its frames

- **Date:** 2026-11-12.
- **Decision:** RC-closure T1-8 / audit O02 (owner authorised Tier 1
  implementation 2026-11-12). DEC-12 gate:
  `test/unit/select_dataframe_subdatum_native.test.ts`.
- Code: `src/core/relations/models/select_family.ts` (`emitStoredItemFrames`),
  `src/core/relations/relation_core.ts` (`mainItemPairId`, the one pairing-key
  rule for every relation main).
- Addendum to `WC-2026-09-29-select-family-mode-datalist`: its "never the
  portal shape" stays true — frame items are not portal shape (no pagination
  of the select, no expansion of its option targets).

## Shape before (TS)

`selectFamilyResolver` pushed ONE item (stored locators + datalist) in every
non-list mode, and nothing else. A `component_select` whose request_config
declares a `component_dataframe` ddo in `show.ddo_map` (vendored carrier:
`numisdata291` → `numisdata872`, the only select-family node in every vendored
TLD that declares one) shipped the slot ddo on its context, but no frame item
and no frame context. The client's `get_dataframe`
(`component_common/js/dataframe.js`) found no context entry for the slot and
returned null: the frame widget never rendered, so frames could be neither
seen nor created from the select. Stored frames are untouched (they are
written by the dataframe door, not by this read) — no repair step.

## Shape after (TS) = PHP component_select_json

PHP `component_select_json` (frozen v7 :196-234, v6 :90-108), arm
`case 'edit': default:`, guarded by `!empty($value)`: `get_subdatum` over the
dataframe ddo of the config's show map, its context + data appended AFTER the
select's own item. TS now does the same on every door that routes through the
resolver — `get_data`, the section read, the relation save echo:

- the select's own item first, unchanged (entries + datalist; its context
  entry unchanged — the item is not bound to the node);
- then, for each stored item × each `component_dataframe` child of the
  select's element NODE (its effective config, the caller's injected slots
  included), one frame item through the one frame emitter
  (`emitDataframeItem`): `tipo` = slot, `section_tipo` = the slot ddo's
  declared section (the host), `section_id` = the host record,
  `id_key` = the stored item's `id` (legacy: its `section_id`) as INT,
  `main_component_tipo` = `from_component_tipo` = the select, `entries` = the
  paired frames (`[]` when none — the blank widget), `pagination`;
- the frame's children at each paired target, and the context entries of the
  slot and of those children.

Not emitted: `list` (labels), `search` (PHP's value is empty there), an empty
value, a select whose node has no dataframe child, and the other
select-family models (PHP: only `component_select_json` calls
`get_subdatum`).

## Divergences from PHP, stated

1. **The option-target label subdatum is not emitted.** PHP's `get_subdatum`
   over the select's value also resolved the non-dataframe show ddos (e.g.
   `numisdata243`) at each option record, with their contexts. No client code
   reads them; TS emits frames only. Owner decision pending (T1-8 D2) —
   additive in `emitStoredItemFrames` if adopted.
2. **Contexts are deduped by the node registry** (PHP appended them
   unmerged per call). Same rule as every other TS subdatum.

## Gate reconciliation

- Frozen store: no fixture edited. The corpus record of `numisdata291` is not in
  the suite DB; `grouper_context_differential` /
  `component_datalist_lifecycle_differential` are corpus-bound (banked reds
  unchanged).
- `select_dataframe_subdatum_native` (new) builds a `zzsdf` situation (a select
  declaring a slot, a select without one) and pins: the paired frame item and
  its child on `get_data`, their contexts, the client `get_dataframe`
  predicate on a section edit read, the blank slot for a frameless item, one
  frame per item on a multi-item value, the save echo of a first pick, and the
  guards (list / search / empty / no slot). RED on 3353d4607f: 5 of 9 (every
  frame assertion); the four guards green before and after.

## Addendum 2026-11-13 — the slot ddo is not a label part (owner C2)

`WC-2026-11-13-datalist-labels-restricted-and-dynamic-filter` §1: the
`component_dataframe` ddo this entry makes the select emit frames for is
EXCLUDED from the select's option-label and hide ddo sets
(`resolveDatalistSources`). PHP imploded its empty value too, so every label
of such a select ended in `' | '`; TS labels are the non-frame show ddos only.
The frame emission above is unchanged. Gate: the "no trailing separator" case
of `select_dataframe_subdatum_native`.
