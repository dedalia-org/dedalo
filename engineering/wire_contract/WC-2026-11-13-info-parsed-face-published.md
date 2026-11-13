# WC-2026-11-13-info-parsed-face-published — the publication door of `component_info` publishes the PARSED widget face (v6), async widgets included

- **Date:** 2026-11-13.
- **Decision:** owner rulings D1 and C9 (`T1_owner_decisions.md`, 2026-11-13; items T1-2 D4 /
  D2), the diffusion half of `WC-2026-11-13-info-derived-async-published` (the registry half:
  `computeInfoWidgetsParsed`, the stamped items, `WidgetContext.includeAsync`). DEC-12 gate:
  `test/unit/diffusion_info_live_native.test.ts` (the `zzifp` situation — a sum_dates info
  component over a portal to a dates section — publishes the humanized text; the test_info
  cases are the control for a widget without a parsed face).
- Code: `src/diffusion/resolve/info_value.ts` `liveInfoItems` (→ `computeInfoWidgetsParsed`,
  `includeAsync: true`); comments at `src/diffusion/plan/compile.ts` (`info-fn-ignored`) and
  `src/diffusion/resolve/resolver.ts` (the info branch).

## Shape before (PHP v7 = TS until today)

`component_info::get_diffusion_data` (class.component_info.php:880-896) published
`$this->get_data()` — the RAW face: for mdcat `sum_dates` one item per output whose value is
the DateInterval object (`{"y":0,"m":2,"d":15,"h":0,"i":0,"s":0,"f":0,"invert":0,"days":74,
"from_string":false}`); async widgets (`user_activity`) skipped (:156-158). The TS door
(`liveInfoItems` → `computeInfoWidgets`) did the same, so mdcat1181 could publish nothing but the
interval JSON — and sum_dates' parsed items carried only `widget_id`, so even the parsed face
could not have matched a `parser_info::widget` mapping (it matches `widget` + `id|widget_id`).

v6 published the PARSED face (`get_data_parsed` — the humanized text, e.g. `2 mesos 15 dies`,
key 0): what the owner investigated on 2026-11-13 (D1).

## Shape after (TS)

- `liveInfoItems` reads `computeInfoWidgetsParsed(componentTipo, context)`: per widget its
  `computeDataParsed` face, else its `computeData`; every item STAMPED `widget` (always) and
  `key = 0` (single-block widgets only — a parsed face computed over several blocks that names no
  block is not attributed to one). Then `normalizeWidgetEntryKeys` (WC-026) as before.
- `includeAsync: true`: an async widget (`user_activity`) IS computed and published (owner C9,
  v6 parity); the section read keeps skipping it (the client fetches it on demand).
- A `parser_info::widget` column over sum_dates therefore publishes the humanized text in the
  PLAN LANG's labels (`runWithRequestLangs` scopes the compute to the plan's main lang): with
  mdcat1181 set to `{widget_name:['sum_dates'], select:['sum_intervals']}` (candidate A, the
  owner's next step on the master ontology) the column reads `2 months 15 days`, never the
  interval JSON. Outputs whose parsed value is `''` or `null` publish that (the item matched; the
  value is the parsed one).
- A widget WITHOUT a parsed face (test_info, state, calculation, media_icons…) publishes exactly
  the items it published before: its raw items already carry `widget` + `key`, the stamp is a
  no-op there.

## Reason

The published information field must carry what the record shows (v6 did): a DateInterval
object is a compute intermediate, not a heritage value; an async delivery mechanism of the
browser is not a property of the data. The master-ontology D1 setting (mdcat1181 `options:{}` →
candidate A) is only meaningful once the engine publishes the parsed face — this entry is that
precondition.

## Gate reconciliation

No frozen fixture replays an info column with a parsed face or an async widget (the harvest's
info columns were test_info-shaped); `diffusion_info_live_native` D1 case RED before (the column
held the interval JSON), the four live cases unchanged (control). No re-harvest (impossible;
none needed).
