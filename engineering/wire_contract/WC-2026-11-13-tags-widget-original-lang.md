# WC-2026-11-13-tags-widget-original-lang — the `tags` info widget counts the record's text slice, not item [0] of every lang

- **Date:** 2026-11-13.
- **Decision:** RC-closure T1-44 / audit OX6. DEC-12 gate:
  `test/unit/tags_widget_original_lang_native.test.ts` (scratch `zztagol`
  situation: translatable text_area related to a select_lang, a
  non-translatable text_area, one tags component_info over each; widget
  compute A–F + the section list emission G).
- Code: `src/core/components/component_info/widgets/oh/tags.ts`
  (`readTranscriptionSlice`), `src/core/components/component_text_area/original_lang.ts`
  (`resolveRecordTextLang` — the one resolution, shared with the text_area
  list value in `emit.ts` `resolveEmitLang`), `widget_common.ts`
  (`readWidgetRecord`).

## Shape before (frozen PHP v7, copied by TS)

Statistics computed over `get_data()[0]` — item 0 of the FULL multi-lang item
array, i.e. whichever lang slice was stored first. The widget's raw-items
prefix (the PHP `$data` reuse quirk) carried every lang's items. Frozen
`class.tags.php` kept the v6 `set_lang(get_original_lang())` call, but
`get_data()` never filters by lang, contradicting its own comment ("must be
computed on the source (original) language text").

## Shape after (TS) = v6 class.tags.php

- Translatable source: the slice of the record's text lang — the original
  language (related `component_select_lang`), equivalence-aware (an empty
  original slice yields to the first declared same-language sibling with text,
  `DEDALO_LANG_EQUIVALENCES`), else the request data lang. No further fallback
  (v6 `get_dato` is lang-scoped, `lang_fallback=false`): an empty slice counts
  zeros and the raw prefix is empty.
- Non-translatable source (stored `lg-nolan`): the full array, unchanged.
- The raw-items prefix is the same slice (v6 `$dato`).

Every door serving the compute follows: section list/edit emission,
`get_widget_data`, observer recompute, diffusion `parser_info::widget`.

## Open owner decision (T1-44 §7, unruled)

No original language and an empty request-lang slice: v6 zeros (implemented)
vs extending with the read fallback chain (equivalents → install default
lang). Gate case D pins v6 and names the decision.

## Reason

v6 behaviour; the frozen-v7 change was a regression, not a decision.
Statistics from a translation's text are a silent lie about the interview.

## Gate reconciliation

The frozen store's tags-widget values
(`section_context_extras_differential.json`, rsc244) hold a single `lg-spa`
slice read at `lg-spa` — identical under both shapes. No fixture changes, no
re-harvest. `info_widget_native` tags golden (single slice = request lang)
unchanged.
