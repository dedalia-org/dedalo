# WC-2026-11-12-translation-write-value-gates — automatic translation stores its result gated like a save

- **Date:** 2026-11-12 (T1-14 / OX7).
- **Before:** `tool_lang` / `tool_lang_multi` `automatic_translation` (server engines, e.g.
  Babel) stored the target-language items as the provider returned them, through the
  model-agnostic record chokepoint (`persistRecordKeys`), past the write engine's value gates.
  Babel's own post-processing is PHP `strip_tags` with a tag allowlist: it KEEPS attributes
  (`<p onmouseover=…>`), and its entity decode turns text a curator typed literally
  (`&lt;strong onmouseover=…&gt;`, stored harmless) into LIVE markup. A `component_text_area`
  is rendered unescaped by the client, so the translated slot was a stored-XSS vector; on a
  split-origin install an absolute `webBase` media `src` was stored too (a WC-042 violation).
- **Now:** the target items pass `gateComponentItems`
  (`src/core/section/record/write_value_gates.ts` — the ONE home of the value gates, shared
  with the save door): an `html` render class is sanitized (WC-2026-10-11 sanitizer) and its
  media `src` relativized (WC-042), byte-for-byte the form a save of the same value stores; a
  `component_password` is hashed; any other model is untouched. PHP parity:
  `component_text_area::save` (`clean_text`), which tool_lang called. The Time Machine row of
  the target lane holds the gated value. A result whose visible text is EMPTY after the gate
  (e.g. only `<script>`) is refused as `translation.empty_result` (nothing written, no TM
  row) — see the addendum on WC-2026-11-10-translation-empty-result. OTHER languages of the
  component are never rewritten (their own TM lanes, WC-2026-09-27 "two lanes"); values
  stored by earlier translations are not repaired (owner decision pending).
- **Client effect:** none for a clean translation. A hostile or attribute-carrying result is
  stored cleaned; a result that is nothing but stripped markup answers 503
  `translation.empty_result` instead of blanking the language.
- **Gates:** `test/unit/translation_write_gates_native.test.ts` (cross-door byte parity with
  the save door, the real Babel round trip, empty-after-gate refusal, TM value, benign and
  other-lane controls, non-html model untouched),
  `test/unit/text_area_media_src_split_origin.test.ts` (the translation door stores the same
  relative `src` as the save door, split and same origin),
  `test/unit/component_value_gate_census_tripwire.test.ts` (every chokepoint writer
  classified; gated writers reach the gate).
