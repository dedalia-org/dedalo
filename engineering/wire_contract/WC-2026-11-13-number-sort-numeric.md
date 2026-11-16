# WC-2026-11-13-number-sort-numeric — ORDER BY a `component_number` sorts NUMERICALLY (PHP / v6: text collation)

- **Date:** 2026-11-13.
- **Decision:** owner ruling C38 (`T1_owner_decisions.md`, 2026-11-13; item
  T1-33 §7.1): numeric. DEC-12 gate:
  `test/unit/search_order_lang_less_native.test.ts` (collation case 9, 10, 2
  ASC → 2, 9, 10; the guarded-cast SQL shape).
- Code: `src/core/search/sql_assembler.ts` `orderSelectExpression`.

## Shape before (PHP)

`trait.search_component_common.php build_order_select` extracted the sort key
of a `component_number` as TEXT — `jsonb_path_query_first(…, '$[*].value') #>>
'{}'` (v6: `datos #>> '{path}'`) — so a list sorted by a number column collated
lexically: `10` < `2` < `9`; `100` before `20`. A heritage measurement
(diameter, weight, year) sorted that way is wrong results, silently.

## Shape after (TS)

For `model === 'component_number'` the sort select is

    (CASE WHEN jsonb_typeof(jsonb_path_query_first(<src>, '$[*].value')) = 'number'
          THEN (jsonb_path_query_first(<src>, '$[*].value') #>> '{}')::numeric END) AS <tipo>_order

— `2 < 9 < 10`, `NULLS LAST` + the section_id tiebreaker as before. The
`jsonb_typeof` guard keeps a legacy string item (PHP-era data stored as `"12"`)
from failing the cast: it sorts as NULL (last), never a 500 on the list page.
Every other lang-less model keeps the text key (`component_json`, …); the
lang-sliced models keep the lang-filtered key (T1-33, unchanged).

## Reason

Sorting IS a reading of the value; a number column that orders `10` before `2`
tells the curator something false. The engine stores numbers as JSON numbers
(`save_component` coerces on save — WC-2026-11-12-number-type-precision-on-save),
so the numeric cast is the stored type, not a guess.

## Gate reconciliation

No frozen fixture orders by a number component (`multihop_order_differential`
and `list_column_sortable_differential` sort an input_text) — no fixture edit,
no re-harvest. The collation pin in `search_order_lang_less_native` flips from
the text order to the numeric one in the same change.
