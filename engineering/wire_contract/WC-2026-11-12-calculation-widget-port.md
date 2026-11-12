# WC-2026-11-12-calculation-widget-port — the calculation widget computes its declared formulas

- **Date:** 2026-11-12.
- **Decision:** RC-closure T1-1 / audit U02 + U09 + O13 + OX6 (owner
  authorised Tier 1 implementation 2026-11-12; owner ruling 2026-11-11: the
  scalar component_number sum is implemented beyond PHP, and the summarize
  contract may change). DEC-12 gates:
  `test/unit/calculation_widget_native.test.ts`,
  `test/unit/calculation_fn_registry_tripwire.test.ts`,
  `test/unit/info_widget_native.test.ts` (calculation legs),
  `test/unit/fixed_filter_expansion_native.test.ts` (C8 no-mutation leg).
- Code: `src/core/components/calculation_data.ts` (descriptor facet
  `calculationData`, PHP per-model `get_calculation_data`),
  `src/core/components/component_info/widgets/calculation/{calculation,functions}.ts`,
  `src/core/relations/component_data_walk.ts` (the ONE ddo_map walker, shared
  with request_config `fixed_filter`), `src/core/concepts/dd_date_time.ts`
  (`ddDateToUnixSeconds` / `ddDateFromUnixSeconds`).
- Applies to every value of a `component_info` / `component_calculation`
  carrying a `calculation` widget: the section read (list + edit), the
  observer Time Machine rows, and the grid / export / diffusion values derived
  from them.

## Shape before (TS)

Every input was flattened to a joined STRING (`'40.5, 2.25'`), the input's
`options` were ignored, and only 3 of the 9 formulas the shipped ontology
declares existed. `summarize` and `to_euros` emitted nothing for any non-empty
input (the effective outcome of PHP's `array_sum(string)` crash),
`calculate_period` emitted nothing ever, the date branch was absent, and an
unknown fn answered a silent `[]`. Relation inputs (portal + `ddo_map`) and
info inputs read nothing usable. Net: every mdcat grant amount / period /
total, every dmm / mdcat date sum and the numisdata metal total rendered blank.

## Shape after (TS)

Each input feeds its model's calculation data (`calculationData` facet), the
nine formulas run, and each declared output id emits one
`{widget:'calculation', key, id, value}` item (WC-026 adds `widget_id`).

1. **summarize int / float SUMS the non-empty inputs** (owner ruling
   2026-11-11). PHP crashed on every non-empty input. This also applies to
   number inputs of every other formula (e.g. `calculate_period` over a
   component_number now emits its year / month / day buckets where PHP served
   nothing).
2. **summarize date is ported** (start + period → a date in the merged shape
   of the inputs; a period without an anchor date → `value: null`). Instants
   are computed at **UTC midnight**: PHP kept the server's current time of day
   in the server time zone, so its seconds were not reproducible.
3. **An info input feeds the LIVE compute's `select` values** (default
   `value`) — the v6 semantics. Frozen PHP v7 also prepended the whole widget
   items; not ported (its own `final_total` could not read that shape).
4. **A relation input's plain leaf feeds its item values** (v6 `dato`
   parity); frozen PHP v7 summed the item objects to 0. A
   `get_calculation_data` ddo feeds that component's own calculation data.
5. **`days_correction_manually` serves a number** (PHP served the number
   component's string).
6. **Refusals, never a blank value** (`ontology.invalid_node`): an fn not in
   the registry, a block without `process.fn` (PHP silently reused the
   previous block's result), an input without tipo / var_name, a relation
   input without a `self`-anchored `ddo_map`, an unknown ddo fn, a calculation
   cycle or a chain deeper than 16. `engine.uncovered_scope`: the
   `'all'` / `'search_session'` scopes, `filter: true`, an input model without
   the facet. The tripwire proves the shipped release reaches none of them.
7. **Open owner decisions refuse until ruled** (`engine.uncovered_scope`):
   - **OD-1** `final_total`'s major-grant branch: PHP hard-codes the install
     section `mdcat2605`. That caller (or a node declaring
     `options.major_section_tipos`) refuses when the major amount would
     decide; every other caller takes the minor branch, which all options
     agree on.
   - **OD-2** `calculate_import_major` / `_minor` over **zero** days: PHP
     returned a scalar where a list was expected and crashed the read; TS
     refuses with a named error until the owner chooses no output, `total 0`
     or the formula minimum.
8. **An absent `input.section_id` is read as `'current'`** (a standing TS
   reading, written down here); a literal id resolves no components (PHP's
   default branch).
9. **Diffusion `parser_date::unix_timestamp`**: years 0–99 are real years
   (the one `ddDateToUnixSeconds`); the old `Date.UTC` mapping turned year 50
   into 1950.

## Not changed

- Nothing is computed at save time (DEC-06); an info value is never stored
  (WC-2026-09-03-info-stored-value-never-served) — no stored data was wrong,
  so there is no repair step. Observer TM rows written before this change
  carry the old empty shapes; they are history and are not served.
- Cross-record reads of a relation input follow the existing widget posture
  (no per-target permission check — PHP parity, as `sum_dates` /
  `get_archive_states`); the walker's injected reader is the one place to
  change it.
- request_config `fixed_filter` keeps refusing an `fn` ddo with the same
  message; its walk no longer writes `last` onto the cached ontology ddo_map.
