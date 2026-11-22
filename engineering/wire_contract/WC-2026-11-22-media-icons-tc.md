# WC-2026-11-22-media-icons-tc — the media_icons tc is the stored duration, else the measured one, else EMPTY; a read never writes, nothing writes a fabricated zero

- **Date:** 2026-11-22 (T2 batch B4: WID-3).
- **Decision:** owner FYI-5 (an AV record with no stored duration shows the measured
  duration, or nothing when there is no file — never `00:00:00.000`), C52 (never fabricate).
  Code: `src/core/components/component_info/widgets/oh/media_icons.ts` (`resolveTc`),
  `src/core/media/ingest/companion_writes.ts` (`measureStoredMediaDuration`,
  `locateDefaultQualityFile`, `rewriteDurationCompanion`, `writeDuration`),
  `tools/tool_update_cache/server/index.ts` (media branch, component_av).
- **Shape before (PHP):** the tc cell read the hardcoded `rsc54`; when empty, the read probed
  the AV file and WROTE the result into `rsc54` — `00:00:00.000` for a missing or unreadable
  file. The upload's duration companion likewise stored `00:00:00.000` when ffprobe yielded
  nothing. TS before this entry emitted `00:00:00.000` without writing, and its ingest
  companion still stored the zero (with a message — WC-2026-08-09-ingest-companions-and-human-filename §2).
- **Shape after (TS):** the duration component is the AV component's declared
  `target_duration` (the path's last hop; `rsc54` only when none is declared). A stored value
  is emitted as stored. None stored: the default-quality file (files_info entry first, the
  grammar location second) is MEASURED, read-only, and its time code emitted. No file, or an
  unreadable one: the cell carries NO `value` key (the client renders `data_tc.value || ''`
  as empty). The ingest companion writes NOTHING for an unmeasurable file (its message says
  so). `tool_update_cache`'s regenerate of a component_av re-runs the duration companion — the
  repair door that STORES the measurement (through the write door as the caller, under the
  run's bulk id; an unreadable file is an error line, an absent one is silent).
- **Reason:** a zero duration is a fabricated measurement every later reader (the widget, the
  publication, the curator) takes for real; a read that writes is a write on a read path.
- **Gate reconciliation:** the captured PHP golden `tc_slow_list_entries`
  (`test/unit/fixtures/info_widget_native/entries.golden.json`) is NOT edited: the gate
  (`test/unit/info_widget_native.test.ts`, tc SLOW PATH) asserts the golden still holds PHP's
  `00:00:00.000`, removes that one `tc.value` and compares the rest; no re-harvest. New gate:
  `test/unit/media_icons_tc_native.test.ts` (no file → no value, nothing written; stored wins;
  file → measured, nothing written; regenerate → stored under the run; unreadable → no value,
  nothing written).
