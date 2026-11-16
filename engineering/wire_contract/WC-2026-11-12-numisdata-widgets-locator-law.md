# WC-2026-11-12-numisdata-widgets-locator-law — the numisdata widgets match locators by value

- **Date:** 2026-11-12.
- **Decision:** RC-closure T1-11 / audit OX6 (owner authorised Tier 1 implementation
  2026-11-12). Follows the ruled law WC-2026-08-10-section-id-int-canonical (stored locators
  and emitted record addresses are INT; legacy numeric strings survive, so comparison is
  value-based through `compareLocators`). DEC-12 gates:
  `test/unit/coins_by_period_widget_native.test.ts` (pure seams),
  `test/unit/info_widget_native.test.ts` (`archive_live`, `coins_direct`, `coins_rollup`, and
  the array-stored `hierarchy27` roll-up case — numisdata seeds are INT-canonical locators),
  `test/unit/ws_a_tripwires.test.ts` (both widget files retired from
  `INLINE_SECTION_ID_MATCH_RATCHET`).
- Code: `src/core/components/component_info/widgets/widget_common.ts` (`isFlagSet`,
  `FLAG_SET_SECTION_ID`), `.../numisdata/get_archive_weights.ts`,
  `.../numisdata/get_coins_by_period.ts` (`resolveModelSectionId`, `sameAddress`).
- Applies to every value of a `component_info` carrying `get_archive_weights` or
  `get_coins_by_period`: the section read (list + edit), `get_widget_data`, and the
  publication / export values derived from the live compute
  (WC-2026-11-12-info-live-publication-export).

## Shape before (PHP)

- `get_archive_weights`: a coin is skipped when its `used` flag is absent or its first locator
  has `section_id === '2'`, and when its `duplicated` first locator has `section_id === '2'`
  (frozen v7 and v6 identical). Correct only while locators were string-canonical.
- `get_coins_by_period`: thesaurus rows read as strings by the pg driver, every term / tree /
  parent match strict `===`; the duplicated flag loose `== '2'`. The `use_parent` model:
  v6 took the FIRST `hierarchy27` locator; frozen PHP v7 checked `is_object()` on the
  relation value — always an ARRAY in v7 — so no term ever had a model and every coin under
  `use_parent` fell to `'?'` (a v7 regression, not a contract).

## Shape before (TS)

- `get_archive_weights` kept the strict `=== '2'`: against INT stored flags (every migrated or
  TS-written locator) unused and duplicated coins were COUNTED into the weight / diameter
  mean, max, min and count.
- `get_coins_by_period` read the rows as `section_id::text` and matched strictly: an INT
  `hierarchy45` / `hierarchy49` child never found its row, the ordered tree was empty, and
  EVERY coin went to `'?'`, direct and roll-up alike. `period[].section_id` was emitted as a
  string. The frozen v7 `is_object()` model check was copied.

## Shape after (TS)

- The flag convention is one helper, `isFlagSet(items)`: the first locator's `section_id`
  equals 2 by the locator law (int `2`, `"2"`, `"02"`; `"20"` / `20` do not). `section_tipo`
  is not compared (PHP never did; the vocabulary is install-defined). Both widgets use it.
- Every term / tree-child / parent match in `get_coins_by_period` is `compareLocators` on
  `['section_tipo', 'section_id']` — `section_tipo` strict, `section_id` loose — so INT and
  legacy string locators both match.
- `period[].section_id` is emitted INT (the WC-2026-08-10 emission law; this widget was a
  straggler). The `coins_direct` golden is compared after `normalizeSectionIdTypes` on the
  GOLDEN side only, so an engine that re-emits `"187"` goes red.
- `model_section_id` = the first `hierarchy27` locator's `section_id` (v6), a legacy
  non-array object is still read; no model → `target + 1` (never matches). Deliberate
  divergence from frozen PHP v7. The `coins_rollup` golden (all `'?'`, no model seeded) stays
  as the oracle record of that regression; the array-model case is a separate assertion.
- Stats on int data change (correctness); no key or shape change except the int
  `section_id`. Nothing is stored (values are computed live,
  WC-2026-09-03-info-stored-value-never-served), so there is no data to repair. Published
  values: info columns published NULL before WC-2026-11-12-info-live-publication-export (same
  release), whose republish note covers these columns too.
