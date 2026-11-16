# WC-2026-09-30-media-key-locked-transform — one locked media-key writer; the duplicate's media verdict

- **Date:** 2026-09-30 (audit 2026-09-26, CLOSURE_PLAN Step 2: TOOLS-5 + widening, CORE-5).
- **Decision:** CLOSURE_PLAN §Owner decisions (2026-09-30, all leanings accepted).
- **Doors:** `tool_update_cache.update_cache` (the media branch), the `files_info`
  reconcile sweep (`scripts/media_repair_files_info.ts`, the reconcile registry's
  `files_info` entry), `dd_core_api.duplicate` / MCP `duplicateRecord` (the clone's
  media), and every media write-back that already locked (tool uploads, the AV job,
  `sync_files`) — now through the same entry.
- **Shape before:**
  - `update_cache` and the sweep read the record UNLOCKED, did seconds of file work
    (derivative rebuilds, a disk rescan), then wrote the whole `media[tipo]` array back
    with a raw `updateMatrixKeyData`: anything a curator committed in between (an upload's
    `original_file_name`, a second item) was silently reverted. A record deleted mid-run
    was counted "regenerated"; a shrink only the committed value showed was never held.
  - `duplicateSectionRecord` inserted the clone with the SOURCE's `files_info`
    (source-id `file_path`s), copied the files and refreshed the index inside a
    `try { … } catch {}`: a failed copy left the clone indexing ANOTHER record's files,
    and nothing said so. Media paths were resolved section-scoped, so an
    `additional_path` component copied to and from the numeric bucket.
- **Shape after:**
  - `media/tools/files_info_persist.ts transformStoredMediaItems` is the ONE media-key
    writer: it reads `media[tipo]` under the row lock and writes what a SYNCHRONOUS
    transform returns from those items, in one short transaction (refused inside a
    caller's). Outcomes: `written`, `noop` (already current), `held` (a shrink the
    transform refuses), `missing` (the record is gone), `locked` (the lock timeout,
    SQLSTATE 55P03) — per record, never an escape that aborts a sweep. The private
    `writeItems` has exactly one caller. Every caller DECLARES its lock wait
    (`lockWait`): `per-record` — `update_cache` and the sweep, which visit many records
    and run on the REQUEST pool, which bounds no lock wait of its own — sets
    `SET LOCAL lock_timeout` to the maintenance bound (5s), or half the request
    statement ceiling when that is shorter, so the wait always ends as the classified
    55P03 and never as a statement timeout that escapes and aborts the run; `request` —
    an upload, a write-back, the duplicate's refresh of its own clone — waits under the
    caller's own bounds.
  - `update_cache` (media): the derivatives are rebuilt OUTSIDE the lock, then the items
    read under the lock are re-scanned (shrinks held) and written. The response gains
    `vanished` (records deleted during the run) and `locked` (rows that stayed locked);
    each is also a line in `errors` (`<tipo>#<id>: record deleted during the run —
    nothing written`), and neither is counted in `regenerated`.
  - The sweep: the dry run adjudicates on its snapshot as before; each applied change is
    RE-SCANNED and RE-JUDGED on the locked items. `repaired` counts only what was
    written; the summary gains `missing`, `locked`, `heldOnApply`, `unchangedOnApply` —
    and so does the reconcile registry's `files_info` report (`detail`, summed over the
    scoped sections), whose description now names FOREIGN (always rewritten) and the
    re-judgement under the lock.
    The verdict is PER ITEM: each changed item is GROW / DIFF / SHRINK on its own
    existing-file count, a SHRINK item keeps its stored index unless `allowShrink`, and a
    component writes every other changed item (a per-component verdict let one growing or
    foreign item carry a sibling's shrink through — the 2026-07-19 index-wipe class). A
    change reports `writtenItems` / `heldItems`; `held` counts changes with a held item
    (a change may be both applied and held).
    New change kind **`FOREIGN`**: a non-external item whose existing entries carry the
    CLONE SIGNATURE — this component's and section's media identifier with ANOTHER
    section_id (`<component>_<section>_<N≠id>…`) — always rewritten (the repair door for
    clones a failed duplicate damaged). Any other name the scan does not build (a
    `properties.image_id` rename, a hand-placed file) is NOT foreign: a rescan that cannot
    see it is a SHRINK, held.
  - The duplicate: the clone is inserted with `files_info: []` on every non-external media
    item (external URL entries kept), so neither the committed row nor its history can name
    the source's files; the files are copied through the RECORD-scoped walk
    (`duplicateSectionMediaFiles` — the source's own `additional_path` bucket); the clone's
    index is ALWAYS re-scanned at its own identity through the locked transform, and the
    written items feed the history rows. An incomplete copy — no media root, a walk or copy
    failure, a failed rescan, the clone's row missing/locked, fewer files copied than the
    source's index claimed — is a VERDICT, never a throw: logged
    `media.operation_failed` (coordinates: section, source and target id, component,
    stage, file counts; a walk or copy failure's report in the message), counted
    `duplicate_media_incomplete`, and returned by the new
    `duplicateSectionRecordWithVerdict`. Each verdict names the CLONE record it belongs
    to (`sectionTipo`, `sectionId`): a duplicate re-mints its dataframe frame targets
    through the same door, and their verdicts ride the one list the caller reads. The
    media root is an explicit input of the verdict door (`mediaRoot`: a path, `null` = no
    root — every claiming component a `no_media_root` verdict, the clone's index empty —
    or absent = the configured root). The wire of `dd_core_api.duplicate` is unchanged
    (the new id); surfacing the verdict as `notices` is a follow-up (integrator request).
  - `media/repair.ts` splits into `regenerateMediaDerivatives` (file work, outside the
    lock) and `rescanMediaItems` (synchronous, per item from its own lang and scan cues);
    `refreshMediaItems` composes them, now record-scoped. `repair.ts` and
    `duplicate_record.ts` leave the section-scoped path-option ledger.
- **Amends:** WC-2026-09-27-bulk-revert-undo-log decision D4 (see its addendum): the
  `update_cache` media write stays exempt from the undo log, and is now a locked transform.
- **Gate reconciliation:** no parity fixture recorded these doors' media write-back or a
  duplicate's media; no fixture edit, no re-harvest. Gates:
  `test/unit/media_files_info_lost_update_native.test.ts` (the two-connection interleave
  for `update_cache` and the sweep, a record deleted mid-run, a shrink visible only under
  the lock, a foreign index, a foreign item beside a legitimate shrinking one (per-item
  verdict), an `image_id`-named entry held (only the clone signature is foreign), the
  transform refused inside a caller's transaction, a real 55P03 under the transform, L8 —
  a REAL lock wait that runs out ON THE REQUEST POOL (the production lane, no test-side
  `withUnboundedStatements`), counted `locked` and named by `update_cache` and by the
  registry's `files_info` report while the next record is still refreshed — and L9, the
  per-record bound below any statement ceiling), `test/unit/duplicate_record_media_verdict_native.test.ts`
  (happy path, refused bucket and planted directory — each the `copy` stage with its
  report logged — claimed-but-absent file — the `count` stage — the record's bucket, the
  verdict door on a scratch root, no media root, a re-minted frame target's verdict naming
  its own record), `test/unit/write_obligations_tripwire.test.ts`
  (leg B4: `writeItems` is reached only through the transform),
  `test/unit/media_ingest_properties_native.test.ts` (the section-scoped ledger shrank).

**Amended 2026-11-12 (T1-22):** "never names the source" now covers `svg_file_data` too
(dropped at the insert, the clone's own envelope written back by the transform), and the
verdict gains the `envelope` stage (`WC-2026-11-12-duplicate-image-svg-envelope`).
