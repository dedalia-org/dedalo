# WC-2026-11-22-regenerate-facet — update_cache normalises stored legacy shapes per record, under the row lock; an invalid value is that record's refusal

- **Date:** 2026-11-22 (T2 batch B4: LIF-1, LIF-2).
- **Decision:** T2 triage rows LIF-1/LIF-2; DEC-12 (gated). Code: `src/core/components/types.ts`
  (`RegenerateId`, the descriptor facet `regenerate`), `src/core/components/registry.ts`
  (`regenerateStoredItems`, `REGENERATE_IMPLEMENTATIONS`, alias-following),
  `tools/tool_update_cache/server/index.ts` (`resaveUnderRowLock`).
- **Shape before (PHP v6/v7):** `component_text_area::regenerate_component` rewrote legacy
  `[TC_hh:mm:ss_TC]` marks to `[TC_hh:mm:ss.000_TC]`; `component_json::regenerate_component`
  decoded a value stored as a JSON STRING into the parsed value. A value that could not be
  decoded aborted the whole component's regenerate. TS before this entry re-saved the stored
  value unchanged (neither normalisation existed).
- **Shape after (TS):** the descriptor declares `regenerate: 'text_area_legacy_tc'`
  (component_text_area) / `'json_string_decode'` (component_json); `resaveUnderRowLock`
  applies it to the items read UNDER the row lock, in the transaction that writes, under the
  run's bulk id (a bulk revert restores the BEFORE value). An undecodable JSON string is a
  PER-RECORD refusal (`ResaveRefused` — reported, nothing written, the sweep goes on), not a
  whole-component abort. An already-canonical value writes nothing. A READ never decodes or
  rewrites (the normalisation is the regenerate's, never a read's).
- **Also (OX7-1a):** the run's labels (and the propagate run's section label) are in the
  request's application language (`currentApplicationLang()`); the `lang` option the
  update_cache client used to send is no longer read — a caller still sending it is
  ignored, not refused.
- **Reason:** one bad record must not stop the repair of every other; a read that rewrites
  stored data would be a write on a read path.
- **Gate reconciliation:** no parity fixture covers update_cache (write path); no re-harvest.
  Gates: `test/unit/descriptor_completeness_tripwire.test.ts` (the v6-pinned regenerate set,
  each id implemented, positive control), `test/unit/update_cache_locked_resave_native.test.ts`
  (text_area normalised, json decoded, invalid refused untouched with no TM row, unchanged
  writes nothing).
