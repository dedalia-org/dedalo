# WC-2026-11-13-external-empty-entry-dropped — an external value with no visible text is no entry

- **Date:** 2026-11-13.
- **Decision:** RC-closure T1-P06 (TODO-039 part 2). DEC-12 gates:
  `test/unit/external_fields_map_native.test.ts` (`an empty value is no entry
  (T1-P06)`), `test/unit/external_zenon_native.test.ts` (all-empty authors /
  empty dates; `zenon_authors` refusals), `test/unit/external_search_native.test.ts`
  (search cells), `test/unit/external_emit_native.test.ts` (record emission).
- Code: `src/external/fields_map.ts` (`normalizeEntries` → `hasVisibleText`;
  the format-refused special case in `mapRowToEntries` folded into it),
  `src/external/services/zenon.ts` (`formatZenonAuthors`).

## Shape before

- **v6 PHP** (`class.component_external.php` `get_dato`): an all-empty
  `authors` object `implode`d to `''` → `[""]`; a `null` result wrapped as `[null]`.
- **frozen PHP v7**: `json_decode` without assoc made `authors` a `stdClass`, so
  the `is_array` guard failed and `zenon_authors` ALWAYS emitted `['']`.
- **v6 browser search** (`service_autocomplete.js` `format_data`): no entry for
  an empty plain/array field, `['']` for an all-empty authors object.
- **TS until now**: every path through `mapRowToEntries` (record read, list
  columns, autocomplete search, export/relation_list cells, diffusion) emitted
  `entries: [""]` for an empty string, a whitespace-only string, `[]`/`['']`
  under `array_values` and an all-empty `authors` object; a markup value whose
  sanitised form showed nothing (`<br>`, `<script>…</script>`) emitted it too.
  The client drew a blank span framed by separators (`| |`); an export cell
  read `""`. `zenon_authors` on a non-object (`'Doe'`) emitted `[""]` with no
  `source_status` (a real value lost silently), and a scalar role rendered
  `primary: 0 - 1 - 2`.

## Shape after (TS)

- **An entry whose VISIBLE text is empty is not an entry.** `text`: dropped when
  `trim()` is empty (non-empty text is never trimmed). `markup`: dropped when the
  sanitised string minus its bare allowlisted tags trims to empty. The parallel
  `entries_kind` slot leaves with it (absent if no markup survives).
- **Missing, not degraded**: no `source_status`, no counter — an empty remote
  value is the same statement as an absent remote field. Empties never consume a
  `maxEntries` slot (dropped before the count cut).
- **`zenon_authors` refuses** a non-object `authors` (string, number, boolean,
  array) whole, and a role holding a scalar (other roles still render); both
  reach the wire as `dropped_unrenderable`. All roles empty → no entry.
- Export: an empty remote value is a `null` cell (as an absent field already was),
  not `""`. Published MariaDB rows holding `""` become NULL on the next republish.

## Not changed

WC-2026-08-06-external-search-request item 4 (search cells use the ONE emission
function, so authors keep their role prefixes in the dropdown) stands — reversing
it is an open owner decision (T1-P06 §7).

## Reason

One law at the one chokepoint (WC-2026-08-05-external-entry-normalisation: "an
empty string would read as 'the service holds an empty value', a different and
false statement"), generalised from the format-refused case to every empty.

## Gate reconciliation

No frozen oracle-harvest fixture holds a data item for a `component_external`
tipo (re-checked 2026-11-13 over every fixture naming the model). No fixture
change. **Re-harvest: NO — impossible by definition.**
