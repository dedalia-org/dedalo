# WC-2026-11-12-section-id-open-between — an open-ended Id range (`5...` / `...5`) keeps the bound that was typed; the absent bound is OPEN pending owner decision D1

- **Date:** 2026-11-12 (RC closure T1-35 / audit OX5).
- **Decision:** none yet for the absent bound — owner decision D1 of the T1-35
  plan is NOT ruled. This entry records the interim state so the divergence is
  ledgered, not silent; the ruling lands as an addendum.
- **Shape before (PHP):** `resolve_section_id_between_sql`
  (`trait.search_component_section_id.php`; v6 `class.component_section_id.php`
  identical): empty low → `0`, empty high → low. `...5` = `>= 0 AND <= 5`;
  `5...` = `>= 5 AND <= 5` (exactly 5); `...` = `>= 0 AND <= 0`.
- **Shape before (TS, the defect):** `buildSectionIdFragment` returned `false`
  for either open side — the leaf contributed NOTHING, so a lone `5...` filter
  returned every record of the section and, inside `$and` or a deep path, the
  constraint vanished.
- **Shape after (TS, interim):** `src/core/search/builders/builder_section_id.ts`
  `buildBetween` emits the typed bound only: `5...` → `section_id::integer >=
  5`; `...5` → `section_id::integer <= 5` (one fragment, integer-cast bind). A
  closed `a...b` is byte-identical (the `$and` of both). `...` with no digits on
  either side stays dropped (unchanged). So `5...` returns ids ≥ 5 where PHP
  returned only 5 — a PHP-era preset `5...` returns more rows than in v6.
- **Open (D1):** (a) PHP parity — add `>= 0` for an absent low and `<= low` for
  an absent high (`5...` = exactly 5), `...` matches nothing; or (b) open
  half-range — keep the interim shape, and classify `...` as `none` (no clause)
  like an empty input. Either way the typed bound stays enforced.
- **Gate reconciliation:** no frozen-fixture gate carries an open-ended Id
  range; no fixture edit, no re-harvest. Gate:
  `test/unit/search_section_id_open_between_native.test.ts` (built SQL +
  executed rows asserting only what both D1 options share; full pipeline on
  `test3`/`test102`). `test/unit/builder_shallow_snapshot.test.ts` unchanged
  (no open-ended case in its key set).

## Addendum 2026-11-13 — D1 RULED (b): open half-range

- Owner C41 (`T1_owner_decisions.md`, 2026-11-13): **(b) open half-range** —
  "what a user means". The interim shape above is the final one for the typed
  bound (`5...` = id ≥ 5, `...5` = id ≤ 5, negative ids included; the absent
  side adds NO predicate), and `'...'` with no digits on either side (also
  `abc...`, or the `...` q_operator with an empty q) now classifies `none` in
  `classifySectionId` — an EMPTY INPUT, no clause — so the builder's between
  branch never sees it. PHP's `>= 0 AND <= 0` (matches nothing) is not
  reproduced. A PHP-era preset `5...` returns ids ≥ 5 where v6 returned only 5
  — stated in the changelog.
- Gate: `test/unit/search_section_id_open_between_native.test.ts` — the row
  assertions are EXACT lists over `(-1, 0, 3, 5, 7, 12)`: `...5` → `[-1, 0, 3,
  5]`, `5...` → `[5, 7, 12]`, `...` → classifier `none` + builder `false`.
- Neighbour NOT ruled here: `builder_number.ts` open between still coerces an
  empty bound to `'0'` (`5...` → `>= 5 AND <= 0`, matches nothing) — the T1-35
  plan §8 asks for one ruling covering both; owner question kept open.
