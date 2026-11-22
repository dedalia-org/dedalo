# WC-2026-11-22-tm-recover-consumes-deleted-listing — a recovered record leaves the deleted-records list; the snapshot stays history; the section's session SQO is dropped

- **Date:** 2026-11-22 (T2-O16-02, O16-03, O16-04).
- **Decision:** T2 triage rows O16-02/03/04; owner ruling 2026-11-19 **FYI-4**: nothing is
  deleted from the Time Machine — the recovered snapshot stays history, only its listing
  changes. DEC-12 (gated: `test/unit/tm_recover_lifecycle_native.test.ts`).
- Code: `src/core/resolve/read_tm.ts` — `deletedListPredicate` (the `tipo` column surface of
  `buildTmWhere`); `src/core/security/session_store.ts` — `dropSessionSqo`;
  `tools/tool_time_machine/server/tool_time_machine.ts` — `toolTimeMachineApplyValue`
  (section branch).
- Wire: `dd_core_api.read` / `count` with `source.tipo = dd15`, `sqo.filter` = one
  `{q: <section_tipo>, column_name: 'tipo'}` clause (tool_time_machine on a section caller,
  the inspector's snapshot list) — the set of rows served and the count. The session's
  `sqo_session` stamp in the section context after a section recover. No envelope shape change.

## Shape before (PHP v6)

The recover marked the restored snapshot row `recovered`; the list of deleted records skipped
marked rows. The session's stored SQO for the section was unset.

## Shape before (frozen v7)

The recover DELETED the restored snapshot row from `matrix_time_machine` (the history of the
delete was lost); the session SQO was unset.

## Shape before (TS)

The `tipo` surface was `WHERE tipo = <section_tipo>`: every whole-record row of the section —
the snapshots of recovered (live) records, superseded deletes, and the recover's and archive
restore's own rows — was listed, so a recovered record stayed offered for recovery and a record
deleted twice was listed twice. The session SQO was kept (ledgered).

## Shape after (TS)

- The `tipo` surface lists, of each record (`section_tipo`, `section_id`), ONLY its newest
  visible whole-record row (history-narrowed: epoch + `tm_role IS NULL`), and only while the
  record has no live row in the section's matrix table. A recovered record leaves the list (its
  recover row supersedes the delete, and it lives); deleted again, it is listed once, by its
  newest snapshot. A live record's whole-record rows (an archive restore, a recover) are never
  listed. Read and count apply the same predicate (count equals rows).
- NOTHING is deleted: every snapshot row stays readable by id (`readTimeMachineRow`, the
  preview) and in the record's own history (`filter_by_locators`, which still serves whole-record
  rows under the same per-cell frame law, WC-2026-09-29-tm-preview-frame-children-as-of).
- After a section recover COMMITS, `apply_value` drops the section's entry from the caller's
  session `sqo_session` (stored row and in-memory map; other sections' entries stay), so the
  next list read of the section starts with no stored filter / offset. A request without a
  session (CLI, harness) drops nothing. The drop runs after the RECOVER SECTION activity row
  and is best-effort: a session-store failure (e.g. SQLite busy) is logged, the restore still
  answers `ok` and keeps its audit row (gate: `tm_recover_lifecycle_native`, locked-store case).

## Reason

The list is the operator's undelete queue: offering a record that already lives invites a
second recover over newer edits, and a twice-deleted record listed twice offers a stale
snapshot. The v6 outcome is restored without a state column and without destroying history.

## Gate reconciliation

No parity fixture covers the `tipo` surface after a recover (the TM read differentials replay
component history). Native gates re-pinned to the deleted-records rule:
`tm_inspector_access_native` (the snapshot list holds the deleted records, in project or not),
`tm_emit_row_context_native` (the snapshotted record is deleted), `nested_ddo_data_native` (the
whole-record row of an address with no live record), `tm_preview_frame_as_of_native` (the
recovered delete and the living record's row read through the record's history). Tripwire pins
`tm_epoch_tripwire` / `tm_history_visibility_tripwire` raised by the one narrowed subquery. No
fixture change, no re-harvest.
