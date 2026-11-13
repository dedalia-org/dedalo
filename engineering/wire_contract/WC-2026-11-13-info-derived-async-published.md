# WC-2026-11-13-info-derived-async-published — `component_info` is DERIVED, its async widgets are published and exported, the publication door reads the PARSED face (items stamped with their widget)

- **Date:** 2026-11-13.
- **Decision:** owner rulings C9, C10 and D1 (`T1_owner_decisions.md`, 2026-11-13;
  items T1-2 D2 / D3 / D4), closing the three decisions
  `WC-2026-11-12-info-live-publication-export` left OPEN (addendum there). C8
  (T1-2 D1, two outputs with one id) is ruled AS PHP — no divergence, pinned by
  `tool_export_info_native` G2.7. DEC-12 gates: `test/unit/tool_export_info_native.test.ts`
  (C9 value / grid_value / dedalo_raw + the read-path control, G2.7, the D1
  registry face), `test/unit/descriptor_completeness_tripwire.test.ts` (C10 facet),
  the diffusion door's gate lands with the diffusion batch (`diffusion_info_live_native`).
- Code: `src/core/components/component_info/widgets/widget_common.ts`
  (`WidgetContext.includeAsync`), `widgets/registry.ts` (`computesWidget`,
  `computeInfoWidgetsParsed`, `stampWidgetItem`), `component_info/descriptor.ts`
  (`derived: true`), `src/diffusion/export/atoms.ts` emitInfoAtoms and
  `grid.ts` liveInfoRawItems (`includeAsync: true`).

## 1. C9 — async widgets (`user_activity`) ARE computed by publication and export

**Before (PHP v7 = TS until today).** `component_info::get_data` skipped every
widget whose `is_async()` was true, on EVERY door: the section read (the client
fetches it through `get_widget_data`), but also `get_diffusion_data` and
`get_export_value`. So the `numisdata1097` publication column and any export of
a `user_activity` info component carried NULL / an empty cell. v6 published it.

**After (TS).** `WidgetContext.includeAsync?: true`. The read/edit path, the
observers, the calculation inputs and the request-path flat readers
(relation_list panel, `resolveCellItems`) never set it: there an async widget is
still skipped and the client still fetches it on demand — no wire change on the
section read. The EXPORT sets it (value, grid_value: `computeInfoOutputs`;
dedalo_raw: `computeInfoWidgets`), so the `totals` output exports the computed
totals object as JSON and the raw cell carries the live item
`{widget:'user_activity', key, widget_id:'totals', id:'totals', value}`. The
publication door sets it with the diffusion batch (same flag, `liveInfoItems`).

Divergence from PHP v7, stated: v6 parity. Cost: one activity aggregation per
(record, info component) per export / publication run — the widget's own
bounded pipeline (saved dd1521 history + the raw tail; the no-history fallback
is the last-year window), nothing unbounded.

## 2. C10 — `component_info` carries the `derived` facet

**Before.** No facet: `NOT_DERIVED_BY_FACET` carved it out of the
descriptor tripwire ("owner decision open"); the consumers that must not trust
its `misc` slot keyed on its `info` flatValue family.

**After.** `derived: true` (aliases `component_calculation` / `component_state`
through the canonical hop). Consequences, both the facet's standing law:

- `tool_update_cache` SKIPS a component_info in a regenerate selection
  (`derived_skipped`, summary note) — there is nothing stored to regenerate;
  before, a "regenerate" re-saved whatever bytes sat under its tipo.
- the CSV import REFUSES a column mapped to it in every mode
  (`request.invalid_data`, "derived — computed, nothing stored to import");
  before, a mapped info column wrote the stored slot nobody serves.

The `info`-family consumers (export dedalo_raw's live items, the D4
`holdsNoData` probe, diffusion) keep keying on the family: it names WHAT is
computed (the widget aggregate), not merely that something is.

## 3. D1 — the publication door publishes the PARSED face, items stamped

**Before (PHP).** `get_diffusion_data` published `get_data()` — the RAW face
(sum_dates: DateInterval objects). v6 published the humanized text (its
`parser_info::widget` read the parsed items).

**Before (TS until today).** `liveInfoItems` → `computeInfoWidgets` (raw), so
mdcat1181 could publish nothing but the interval JSON, whatever its mapping;
and sum_dates' parsed items carry only `widget_id`, so a `parser_info::widget`
match on `widget` + `id|widget_id` found nothing.

**After (TS).** `computeInfoWidgetsParsed(componentTipo, context)`: per widget
`widgetComputeDataParsed` (`computeDataParsed`, else `computeData`), every item
STAMPED when missing — `widget` = the widget_name always; `key` = `0` only when
the widget declares ONE ipo block (a parsed face computed over several blocks
that names no block is not attributed to one: stamping a guess would be
fabrication). The raw face is never stamped. The diffusion door moves to this
face in the diffusion batch (`WC-2026-11-13-info-parsed-face-published` there);
the export already read the parsed face (`WC-2026-11-12-info-live-publication-export`).
Widgets without a parsed face publish unchanged.

## 4. C8 — two widgets declaring ONE output id: as PHP

`oh87` declares `media_icons` + `descriptors`, both outputting `indexation`.
Both outputs keep `sub_id = <id>`: ONE grid_value column `<host>_<info>.<host>_<info>#<id>`,
the two widgets' values joined; the value cell joins them too. No
`<widget>:<id>` twin columns. Pinned, not a divergence.

## Reason

A heritage record's published information field must carry what the record
shows (v6 did): an async delivery mechanism of the browser is not a property of
the data. A derived model must be declared so the doors that must not trust its
stored slot (update_cache, import) refuse mechanically rather than by a comment.

## Gate reconciliation

No frozen fixture replays these doors (the harvest never exported an async or
parsed-face info column); `tool_export_info_native` cases were RED before (the
async cell empty, `computeInfoWidgetsParsed` absent), the descriptor tripwire's
`derived` case flipped. No re-harvest (impossible; none needed).
