# WC-2026-11-10-translation-empty-result — an empty translation is refused (`translation.empty_result`), never written

- **Date:** 2026-11-10.
- **Before:** `tool_lang` / `tool_lang_multi` `automatic_translation` (server engines, e.g.
  Babel): a provider answering HTTP 200 with NO text — what Babel/Apertium does for a language
  pair it does not support (e.g. `sp-eu`) — was accepted as the translation: the target
  language's items were replaced by an empty value (a curator's translation lost to the Time
  Machine) and the answer was `ok:true, data:true, msg:'ok'`, so the client said "Translation
  completed" over a blank slot.
- **Now:** `translateItems` (`src/core/tools/translation.ts`) refuses a result with no visible
  text for a source item that has some (`isEmptyTranslation`; markup is not text). Nothing is
  written, and the answer is the new code `translation.empty_result` — category `unavailable`
  (503), `disclosure: 'public'`, `retryable: false`, no details, label
  `error_translation_empty_result` ("The translation service returned no text: it probably does
  not support this language"). A blank source item is still passed through as before.
- **Client effect:** both tools show `error_text` of the failure in the target slot (unchanged
  path). `tool_lang_multi` "translate all" now counts such a refusal as a failed language (it
  resolved without throwing, so it used to count as done) and names the failed languages in its
  summary, which then stays until dismissed.
- **Gates:** `test/unit/tool_lang.test.ts` (refusal + blank-source pass-through),
  `test/unit/tool_lossless_writeback_tethers_native.test.ts` (empty body refused and target kept;
  counterfactual: a real body is written), `test/unit/tool_lossless_writeback_tripwire.test.ts`
  (both `automatic_translation` cells `refuses`, PENDING 3 → 1), `error_registry_native`,
  `labels_tripwire`.

## Addendum 2026-11-12 (T1-14) — judged on the STORED value

The visible-text test is applied twice: to the provider result (`translateItems`, as above)
and again to the value AS IT WILL BE STORED, after the write value gates
(`WC-2026-11-12-translation-write-value-gates`). A result such as `<script>alert(1)</script>`
has visible text before sanitizing and none after; it is refused with the same code
(`translation.empty_result`, message suffix `after sanitizing`), never written blank. Gate:
`test/unit/translation_write_gates_native.test.ts` (A3).
