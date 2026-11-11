# WC-2026-11-10-tm-restore-unchanged-notice — a TM restore that changes nothing writes nothing and says so

- **Date:** 2026-11-10.
- **Before:** `tool_time_machine.apply_value` (component restore) always wrote: the
  value, the record's modified stamps, a forced TM row of the door lane
  (`recordMainHistory` default `forceDoorLane`, the PHP "every save leaves a row"
  carry-over) and a `RECOVER COMPONENT` activity row — even when the restored
  version equalled the live value. PHP did the same (restore = `component->save()`).
- **Now:** when `mainStateChanged(before, after)` (`src/core/relations/dataframe_slots.ts`,
  the history writer's own unforced change law) is false, the whole restore rolls back
  (no value write, no stamp, no TM row, no activity) and the answer is
  `ok:true, data:true` plus ONE notice `{code:'tool.restore_unchanged',
  label_key:'error_tool_restore_unchanged', retryable:false}`. A restore that changes
  something answers exactly as before (no notice). A frame-ORDER-only difference is no
  change (`dataframe_restore.ts plannedSlotWrites`; order is not frame state). That
  helper also feeds the bulk revert (`bulk_revert_legacy.ts framePlanIsNoop`) and the
  bulk undo (`bulk_revert_undo.ts` → `applyDataframeRestore`): there too a slot that
  differs from its target only in frame order counts as already at target and is not
  rewritten.
- **`dry_run` option (new):** `options.dry_run === true` runs the SAME component
  restore and ALWAYS rolls it back, answering `ok:true, data:{changed: boolean}` (+ the
  same notice when `changed` is false). Refusals (scope, malformed snapshot, unplaceable
  frame) throw exactly as a real restore would. A section restore refuses `dry_run`
  (`request.invalid_options`) so a probe can never write.
- **Client effect:** the Apply button's `apply_value` calls request with `notices:'caller'`
  (other callers keep the page default).
  "Apply and save" first sends the dry run: unchanged → the notice is shown
  (`handle_api_notice`; the tool registers `tool.restore_unchanged` as an INFO toast, and
  `error_dispatch.js deduped_toast` now maps a policy severity through `severity_type` — an
  `info` row used to paint as an error) and NO overwrite confirm is asked; changed → the
  DATA-03 confirm, then the real restore. A notice on the real restore (the record
  changed in between) is shown too and keeps the window open instead of closing it.
- **Section restore** (`model === 'section'`) unchanged by this entry, except that it refuses `dry_run`.
- **Gates:** `test/unit/tm_lang_slice_restore_native.test.ts` ("a restore that changes
  nothing leaves NO trace" — delta + notice per case, positive control),
  `test/unit/tm_dataframe_restore_native.test.ts` (frame reorder no-op),
  `test/unit/tm_two_lanes_native.test.ts` (written-lanes expectation), the section
  `dry_run` refusal in `tm_lang_slice_restore_native`, and the client
  `test_error_policy.js` (info severity → information toast).
