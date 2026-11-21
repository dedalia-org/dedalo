# WC-2026-11-21-text-area-edit-fallback-is-text — a text_area's EDIT `fallback_value` is placeholder text: marks deleted, tags stripped, cut at 700 characters

- **Date:** 2026-11-21 (T2-SL-5).
- **Decision:** T2 triage row SL-5 (needs_code; PHP parity restored, one stated divergence);
  DEC-12 (gated: `test/unit/lang_fallback_empty_slice_native.test.ts` → "R10 …" and "T2-SL-5
  text_area EDIT fallback: marks removed, tags stripped, cut at 700 on a word").
- Code: `src/core/components/component_text_area/emit.ts` (`shapeEditFallback`,
  `truncatePlainText`), `src/core/resolve/tr_marks.ts` (`deleteMarks`).
- **Shape before (TS):** in EDIT mode `fallback_value` carried the other language's stored items
  verbatim — the full rich text, with its markup and its Dédalo bracket marks
  (`[TC_…_TC]`, `[index-…]`…) as literals, of any length.
- **Shape before (PHP):** `get_fallback_edit_value(max_chars: 700)` — per item: `TR::deleteMarks`,
  `strip_tags`, `truncate_text(700)`; an item with no text carries `value: null`.
- **Shape after (TS):** the same. Each fallback item keeps its `id` and `lang`; its `value` is the
  text with every bracket mark deleted and every tag stripped, cut at the last space within the
  first 700 characters and suffixed `...` when cut; `null` when the item holds no text. The LIST
  face is unchanged (tags rendered, HTML-truncated at 130).
- **Divergence from PHP (deliberate):** the "longer than 700?" test counts characters. PHP
  counted BYTES there and then cut by characters, so a multibyte text under 700 characters but
  over 700 bytes lost its last word and gained `...`.
- **Reason:** the fallback is the placeholder of an empty editor; a transcript's raw marks and
  markup, at full length, are not a placeholder.
- **Gate reconciliation:** TS-native only (the gate's R10 expectation moved from the raw
  `<p>Main text</p>` to `Main text`). No frozen fixture holds a text_area EDIT read whose
  requested language is empty beside a filled one; no re-harvest, no fixture edit.
