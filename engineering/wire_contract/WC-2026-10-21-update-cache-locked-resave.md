# WC-2026-10-21-update-cache-locked-resave — `tool_update_cache.update_cache` re-saves the value stored under the row lock; a vanished or held record is counted, never written

- **Date:** 2026-10-21 (W4 cross-authz_read:r1, review-diff finding "tool_update_cache
  re-saves non-media components from an unlocked, run-wide stale snapshot").
- **Decision:** DEC-12 (gated: `test/unit/update_cache_locked_resave_native.test.ts`).
  Sibling of WC-2026-09-30-media-key-locked-transform (the media branch).
- **Shape before (TS):** the NON-media regenerate re-saved (`set_data`, one save per lang
  group, each its own transaction) the items of a per-row snapshot read ONCE, unlocked,
  before the row's components were processed — possibly minutes earlier, when a media
  component of the same row was rebuilt first. A cataloguer's edit committed in between
  was replaced by the pre-edit bytes (visible only as the run's TM pair), a record
  deleted in between was RECREATED by the save, and a save the door refused (`ok:false`)
  was counted `regenerated`.
- **Shape after (TS):** per row × component ONE transaction: the row lock (its wait
  bounded per record — the media branch's `perRecordLockWaitMs`), the record re-read
  under it, every lang group saved in it; a refused group rolls the whole component back.
  Response keys unchanged; meanings widened:
  - `vanished` / `locked` now count NON-media components too (record deleted during the
    run / row held past the bound — nothing written), each with an `errors[]` line
    (`<tipo>#<id>: record deleted during the run — nothing written`,
    `<tipo>#<id>: the record stayed locked past the lock timeout — nothing written`);
  - a save-door refusal is an `errors[]` line
    (`<tipo>#<id>: the re-save was refused — nothing written (<reason>)`), no longer
    counted in `regenerated`, and the summary gains
    `<n> re-save(s) refused by the save door (nothing written to them).`;
  - `media_errors` still counts media lines only.
- **Reason:** a regenerate must never be the write that loses a curator's work; the value
  it re-derives from is the one it locks.
- **Gate reconciliation:** `update_cache_locked_resave_native` (L1 a concurrent committed
  edit survives, no undo pair; L2 a record deleted while the sweep waited is not
  recreated, `vanished`; L3 a row held past the bound is `locked`, nothing written — each
  with a REAL concurrent transaction, no seam); `bulk_undo_capture_native` (the sweep's
  undo-log pairs, unchanged). TS-only tool response: no oracle fixture replays it; no
  re-harvest.

## Addendum 2026-10-21 — a THROWN save-door refusal is that record's refusal too (W4 cross-authz_read:r2)

- **Shape before (TS):** only an `ok:false` answer of the save door was the per-record
  `refused` outcome. The door also refuses by THROWING a typed error before it writes —
  the value-shape law (`request.invalid_data`: a PHP-era stored item no re-save cast
  reads, `value_shape.ts`), an undeclared write lang (`record.lang_not_installed`). That
  throw left the per-record classification, ended the WHOLE run at the first such record
  (the handler failed; every record after it unprocessed) and reported nothing per record.
- **Shape after (TS):** a thrown `DedaloError` whose registry category is `caller` or
  `permission` is the save door's verdict on THAT record: carried out of the row ×
  component transaction like an `ok:false` (the whole component rolls back — every lang
  group already re-saved in it), counted in the summary's
  `<n> re-save(s) refused by the save door (nothing written to them).`, listed as
  `<tipo>#<id>: the re-save was refused — nothing written (<reason>)`, and the sweep goes
  on with the next record. Any other failure (database, internal) is no verdict on the
  record and still fails the run. Response keys unchanged.
- **Gate reconciliation:** `update_cache_refused_resave_native` (R1 a record whose first
  lang group re-saves to new bytes and whose second is refused: stored bytes unchanged in
  every lang, no undo-log row, the `errors[]` line; R2 the next record of the same run is
  re-saved, `regenerated` counts it alone, the summary names the one refusal). The `ok:false`
  half shares the same throw out of the transaction; no `ok:false` refusal can be produced
  per lang group (each of them refuses the whole component alike), so R1 drives the thrown
  half. TS-only tool response: no oracle fixture replays it; no re-harvest.

## Addendum 2026-11-12 — external portals leave the re-save branch (T1-38)

- A component whose data tipo declares `source.mode === 'external'` is no longer re-saved:
  it is recomputed by its law — WC-2026-11-12-update-cache-external-mirror-refresh.
