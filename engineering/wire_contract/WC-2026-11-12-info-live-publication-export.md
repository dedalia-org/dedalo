# WC-2026-11-12-info-live-publication-export — `component_info` publishes and exports its LIVE widget compute (one export column per declared output)

- **Date:** 2026-11-12 (RC-closure T1-2 / audit O09 O13 OX6).
- **Decision:** DEC-12 (gates in the same change); WC-2026-09-03 extended to the diffusion and
  export doors (addendum there). Owner decisions T1-2 D1 (duplicate output ids), D2 (async
  widgets), D3 (`derived` facet) and D4 (mdcat1181 master-ontology mapping) are OPEN — the
  defaults below are the PHP / current-registry behaviour, not a ruling.

## Shape before (PHP)

- Diffusion: `component_info::get_diffusion_data` (`class.component_info.php:880-896`) = one
  diffusion item per `get_data()` item (the LIVE widget compute, async widgets skipped), value =
  the whole `{widget, id|widget_id, value}` object, lang NOLAN. Overrides the common door, so a
  ddo `fn` on an info component never ran.
- Export: `get_export_value` (`:778-823`) = `get_data_parsed()`; one atom per declared
  `widgets[].ipo[].output[]`, path = own segment + sub-segment `{section_tipo, tipo, sub_id:
  <output id>}`, value = the FIRST item (any widget) whose `id` equals the output id, objects /
  arrays JSON-encoded, `null` when absent. Items carrying `widget_id` only (live weights / state)
  never matched → `null`. `dedalo_raw` wrapped `get_data()` (live).

## Shape before (TS)

- Diffusion: the component step read the STORED `misc` slice and unwrapped each entry to its bare
  scalar, so `parser_info::widget` matched nothing — every such column (numisdata786/787/968/969,
  numisdata1097, mdcat1181) published NULL on every record, whatever misc held.
- Export: no `flatValue` → every value / grid_value cell a ledgered `null` (`unresolved:
  ["component_info"]`); relation_list panel blank; `dedalo_raw` exported the STORED `misc` slot
  (contradicting WC-2026-09-03).

## Shape after (TS)

- **Diffusion** (`src/diffusion/resolve/info_value.ts`, routed by the resolver BEFORE the fn
  door): one json atom per LIVE item (`computeInfoWidgets`, WC-026 dual keys), value = the whole
  item, lang `null` (NOLAN). Compute in the plan's main lang (else `DEDALO_DATA_LANG_DEFAULT`),
  mode `diffusion`, as the run principal (DIFF-01; system run → widget superuser fallback). One
  compute per (record, component) per run (run-scoped bounded memo; counter
  `diffusion_info_widget_compute`). `defaultPublicationValue` REFUSES the model
  (`internal.invariant`) — the stored slice can never be published. A ddo `fn` on an info
  component is dropped at compile with the warning `info-fn-ignored:<fn>@<field>` (PHP parity,
  never silent). Async widgets are skipped (D2 default) → numisdata1097 (`user_activity`) stays
  NULL until D2 is ruled. mdcat1181 stays NULL: its node maps `parser_info::widget` with `{}`
  options (D4, master ontology).
- **Export** (flatValue family `info`): atoms per declared output in declaration order, path =
  own segment + `{section_tipo: host, component_tipo: info, model: null, item_index: null,
  section_id: null, sub_id: <output id>}`; values = the LIVE parsed compute
  (`widgetComputeDataParsed` = `computeDataParsed ?? computeData`), mode `edit` (PHP tool_export),
  run frontier principal else the ALS one. DELIBERATE DIVERGENCES: (1) an output matches only its
  own widget's items, on `id` OR `widget_id`, and on `key` when the item carries one — so
  widget_id-only widgets export values where PHP exported `null`; (2) EVERY matching item is kept
  (one atom each; PHP kept the first); (3) an output with no value keeps ONE `''` slot atom (PHP's
  `null` atom); (4) numbers / booleans as their JS string (`'true'`, `'false'`).
  - value: ONE column (the info term); cell = every output's values joined.
  - grid_value: one column per output, key `<host>_<info>.<host>_<info>#<output id>`, label
    `<info term> | <output id>`.
  - dedalo_raw: `{"dedalo_data": <the live normalized items>}` (PHP `get_data` parity) — never
    the stored slot.
  - relation_list panel / flat readers (`resolveCellItems`): every output's values, mode `list`,
    ALS principal.
  - An output id spelling a reserved sub-column (`parents`, `references`) is an info column, never
    the WC-049 parents mirror / D4 references column (the predicates exempt an info leaf's own
    output sub-segment).
  - D4 display carve-out: an info component's empty `misc` slot never counts as "holds no data".
  - Duplicate output ids inside one component (oh87 `media_icons` + `descriptors` both declare
    `indexation`): both outputs share one sub_id → one column (PHP shape; D1 open).

## Reason

The published weight / diameter columns were empty and the export column blank — narrower than
the screen with no notice. The value of a component_info is what its widgets compute now
(WC-2026-09-03); every door must say the same.

## Gate reconciliation

- `test/unit/diffusion_info_live_native.test.ts` (test3 / test212 — live value, stale misc never
  published, record-context placeholder, one compute per record, the refusal).
- `test/unit/tool_export_info_native.test.ts` (`zzxw` situation — value, grid_value keys + label,
  dedalo_raw live, panel, reserved `parents` AND `references` outputs, D4 refusal + the D4
  `#references` walk, the parsed face through the export door (`sum_dates` over a built date
  pair: humanized text, never the JSON interval), and a pure fold gate for the `#references`
  strip (an info output named `references` keeps its sub-segment, so the references fold equals
  the main fold). Mutation-verified RED when reverted (T1-2 review, 2026-11-12): the
  `parents` guard, the `references` guard in `isReferencesAtom` and in `stripReferencesSegment`,
  `widgetComputeDataParsed` → `widgetComputeData` in the export, the D4 `holdsNoData` guard,
  and info emission for the D4 record (the non-vacuity half pins the info OUTPUT cells, not a
  string `W_LABEL` also answers). As first committed only the `parents` and D4 guards were.)
- `test/unit/diffusion_compile_degrade_native.test.ts` — `info-fn-ignored`: a ddo fn on
  component_info / component_state / component_calculation is off the step AND warned (RED on
  either the dropped warning or the pre-change copy onto `step.fn`); control: the same fn on a
  non-info model is kept.
- `descriptor_completeness_tripwire`: `component_info` left `NO_FLAT_VALUE_LEAF_EXEMPT`; its
  `NOT_DERIVED_BY_FACET` reason corrected (D3 open).
- Fixtures: no frozen parity fixture covers a component_info diffusion or export column — no
  fixture edit, no re-harvest.
- Perf (suite DB, test_info widget): 200 records × 2 fields published in 25 ms (one compute per
  record). Real-widget cost (numisdata `get_archive_weights`) not measured on the suite DB (no
  numisdata corpus).
