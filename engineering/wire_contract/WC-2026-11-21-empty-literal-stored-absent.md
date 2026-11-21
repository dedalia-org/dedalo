# WC-2026-11-21-empty-literal-stored-absent — a translatable-class literal whose every language is empty is stored as absent

- **Date:** 2026-11-21 (T2-SL-4).
- **Decision:** T2 triage row SL-4 (needs_code; PHP parity restored); DEC-12 (gated:
  `test/unit/lang_fallback_empty_slice_native.test.ts` → "T2-SL-4: an all-empty literal value is
  stored as absent").
- Code: `src/core/section/record/save_component.ts` (`collapseEmptyLiteral`,
  `releasedByCollapse`), judged by `src/core/resolve/data_item_emptiness.ts` (the read's rule).
- **Shape before (TS):** a save that left a lang-sliced literal (`component_input_text`,
  `component_text_area`, `component_email`, `component_iri`, `component_password`) with no value
  in ANY language kept the key: `[{id, lang, value: ''}]` after clearing the only translation,
  `[]` after removing the last item or a `set_data` of `[]`. The save echoed those items; the
  Time Machine row of the emptied language held `[]`.
- **Shape before (PHP):** `set_data_lang` — `is_empty_data(merged) ? null : merged`: the key
  removed.
- **Shape after (TS):** the key is REMOVED from the record (`string ? <tipo>` is false). The save
  echo is `data: []`. The Time Machine row of each lane the save emptied holds `null` (the row
  of an emptied component, as PHP wrote it). Every action reaches the same seam (`update`,
  `insert`, `remove`, `clear`, `set_data`). A value empty in ONE language beside a language that
  holds a value is unchanged: the cleared item stays (`{id, lang, value: ''}`), so its id stays
  paired with the editor and its frames.
- **Frames (TS-only, stronger than PHP):** the item ids the collapse releases run the same
  server-authoritative frame cascade as a `remove` of each — the frames paired with them
  (`id_key`) are stripped from every dataframe slot of the main, each slot applying its own
  delete policy. PHP left them as orphans. (This includes `clear` on a lang-sliced literal;
  `clear` on any other model still cascades nothing.)
- **Not migrated:** records written before this hold their husks until their next save; every
  reader already judges them empty (WC-2026-11-12-lang-fallback-judges-emptiness).
- **Gate reconciliation:** TS-native only; no frozen fixture replays a write. Three native gates
  pinned the old storage and were re-pinned in the same change: `tm_two_lanes_native` (2 cases:
  an emptied literal is absent, its rows `null`), `tm_lang_slice_restore_native` (the emptied
  row is `null`; restoring it is still a no-op), `import_create_door_native` (its fixture linked
  through a text_area, which kept a bare locator in the string key — not text, so now absent).

## Addendum 2026-11-21 — a value held in NO field is refused, not collapsed (B3 review M2)

- **Decision:** owner ruling 2026-11-21 (B3 Q3): refuse loudly. Gated:
  `lang_fallback_empty_slice_native` → "T2-SL-4 review M2"; `import_create_door_native` → "LINK
  into a TEXT field".
- **Shape before (TS, since T2-SL-4):** a change whose item carried something but none of the
  model's value fields — a locator sent to an input_text / text_area, `{value}` sent to a
  component_iri — was judged empty by the collapse: `ok:true`, `data: []`, nothing stored. An
  importer reported the record written. (Before T2-SL-4 the stray object itself was stored.)
- **Shape after (TS):** the save door refuses it BEFORE the transaction: `request.invalid_data`
  (`saveComponentData: no value field for <model> '<tipo>' — changed_data[i] (<action>) item j:
  …`), nothing written, no counter raised, no Time Machine row. Judged per item of `insert` /
  `update` / `set_data` (`fieldlessValueRefusal`, rule `isFieldlessValueItem` in
  `data_item_emptiness.ts`: value fields `value`, or `iri` / `title` for the iri rule; `id` /
  `lang` are identity). A genuinely empty item — a value field null / `''`, or only `id` / `lang`
  — still collapses to absent. Importers report the record (mapped) / row (CSV) failed.
- **Gate reconciliation:** `import_create_door_native` links through test3's portal `test80`
  again (the "created AND linked" control restored; `authz_door_fixture` grants it at 2 to CONTROL
  and TEXT_ONLY), and pins the text_area link as a reported failure.
