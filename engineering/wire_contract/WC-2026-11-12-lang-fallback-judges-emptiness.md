# WC-2026-11-12-lang-fallback-judges-emptiness — the language fallback judges a lang slice by emptiness, not item count

- **Date:** 2026-11-12 (RC-closure T1-34 / audit O14).
- **Decision:** none (PHP parity restored on the edit wire; the deliberate
  divergences are listed below). One open owner decision (D1, text_area LIST).
- Code: `src/core/resolve/data_item_emptiness.ts` (the one home of PHP
  `is_empty` / `is_empty_data`; per-model rule = descriptor
  `dataItemEmptiness`), `src/core/resolve/component_data.ts`
  (`resolveStoredComponentValue` trigger, `findFallbackSlice` chain,
  `shownItems`), `src/core/components/component_text_area/emit.ts`
  (`sliceHasText`, `listFallbackByCount`), the display doors switched to
  `shownItems` (datalist labels, project names, user names, relation_list /
  export cells, identify path reads, RAG text); the client merge
  (`client/dedalo/core/common/js/utils/render_escape.js` `is_empty_entry` /
  `render_fallback_value`, `common.js get_fallback_value`) judges the entry's
  VALUE, not the item, so the list / mini / text views show the sent fallback
  (T1-34 review).
- Gates: `test/unit/lang_fallback_empty_slice_native.test.ts`,
  `test/unit/original_lang.test.ts` (ghost-markup forcing case),
  `test/unit/descriptor_completeness_tripwire.test.ts` (every
  classSupportsTranslation model declares `dataItemEmptiness`),
  `client/dedalo/test/client/js/test_lang_fallback_entries.js` (the client
  renders the sent fallback for a cleared entry — the wire gates alone do not
  prove the cell is not blank).

## Shape before (TS)

A translatable literal's requested lang slice counted as PRESENT when it held
any item. A cleared translation is persisted as `{id, lang, value: ''}` (or
`null`, whitespace, a text_area's `<p></p>`), so:

- `fallback_value` was never computed for it — the edit placeholder and every
  display showed a blank;
- a cleared main-lang / lg-nolan rung STOPPED the chain and was served as the
  (empty) `fallback_value`, hiding a filled later language.

## Shape after (TS) = PHP get_component_data_fallback

- **Trigger:** `fallback_value` is computed when the requested slice is EMPTY
  by the model's item rule (PHP `is_empty_data`): input_text/email trim
  (`string`), text_area also treats `<p></p>`, `<p> </p>`,
  `<br data-mce-bogus="1">` as empty (`rich_text`), password does not trim
  (`common`); `'0'`/`0` are values. component_iri keeps its no-fallback shape.
- **Value:** a cleared slice that holds items is still emitted in `entries`
  (ids kept — the editor edits them in place, dataframes stay paired), beside
  its `fallback_value` — as PHP sends it.
- **Client:** a position shows the marked `fallback_value[i]` when its entry
  is missing OR empty (value null / '' / whitespace / `[]` / rich-text ghost;
  `'0'` is a value) and the server sent a filled fallback there; a filled
  entry always wins; no fallback sent → the entry's own blank (never invented).
- **Chain:** every rung (declared equivalents → install default → lg-nolan →
  project langs → lg-nolan) is judged by the same rule; the first NON-EMPTY
  slice wins; none → `fallback_value` absent (text_area: `null`).
- Invariant: `fallback_value` non-null ⇒ the value is empty by rule.

## Divergences from PHP (deliberate)

1. **Display doors show the fallback for a cleared slice.** Datalist /
   select labels, project names (dd156), user names, relation_list and export
   cells, identify path reads and RAG text read `shownItems()` (fallback when
   one resolved, else the value). They used `value ?? fallbackValue`, which
   now would show the cleared blank. These doors have no single PHP twin;
   the TS rule is the edit wire's.
2. **WC-052 ddinfo** (`read_source.ts emittedItemHasValue`) now sees the
   fallback face of a cleared slice: when its fallback resolves, the
   `value_with_parents` ddinfo item is EMITTED, exactly as for an absent slice
   whose fallback resolved (before: no fallback was computed, the cleared
   slice read as no value, and ddinfo was suppressed). A cleared slice with no
   resolvable fallback still suppresses it.
3. **text_area original-language forcing** (TS-only equivalence logic): an
   original-lang slice of ghost markup is "no text", so a declared equivalent
   sibling holding the transcript is forced instead.

## Open owner decision D1 — text_area LIST trigger (status quo kept)

PHP `component_text_area_json` LIST triggers by `empty(get_list_value)`: a
cleared item maps to `''`, so a slice holding items never falls back in a
list (edit and the chain judge emptiness). TS keeps that COUNT trigger on the
text_area list face only (`listFallbackByCount`), pending the ruling. Options:
(a) uniform emptiness — a cleared transcript shows its fallback in lists too
(consistent with edit, the chain and v6); (b) keep the PHP list quirk — a
cleared transcript stays blank in lists. Flipping to (a) = delete
`listFallbackByCount`'s count branch + the D1 assertion in the gate.

## Gate reconciliation / fixture interaction

No re-harvest. The edit/list wire moves only for records holding a cleared
translation; the frozen fixture store's cases were harvested from filled
slices, so no parity case moves (the parity run is compared against
`engineering/parity_baseline.json` in the same change).

## Addendum 2026-11-13 — D1 RULED (owner C40): the text_area LIST judges emptiness too

- Ruled (a): uniform emptiness. `listFallbackByCount` is deleted from
  `src/core/components/component_text_area/emit.ts`; the list face carries the
  resolver's `fallback_value` exactly as edit does, rendered like a list value
  (tags → `<img>`, then truncated). A cleared transcript (`<p></p>`, whitespace,
  `''`) shows its other-language text in lists; PHP's count trigger kept it
  blank there. The "Open owner decision D1" section above is history.
- Gate: `test/unit/lang_fallback_empty_slice_native.test.ts` — the former
  "OPEN owner decision D1" pin is now the C40 case: the list cell of a
  `<p></p>` slice carries the default-lang fallback (RED before: `null`).
