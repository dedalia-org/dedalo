# WC-2026-11-10-save-never-creates — a component save addresses an existing record; it never creates one

- **Date:** 2026-11-10 (SAVE-UPSERT, the T0-2 neighbour; owner decisions of 2026-11-10:
  D1 refuse, D2 `resource.not_found`, D3 descriptive message, D4 the CSV row is refused).
  Site: `applySaveComponentData` (`src/core/section/record/save_component.ts`).
- **Decision:** DEC-12. RESTORES the PHP (v6 and v7) behaviour; the TS divergence it ends
  was never deliberate.

## Shape before

A save whose `(section_tipo, section_id)` has no matrix row:

```
{action:'save', source:{tipo:C, section_tipo:S, section_id:N, …},
 data:{changed_data:[…]}}
```

- **PHP v7** (`section_record::save_key_data` → `matrix_db_manager::update_by_key`): a plain
  `UPDATE … WHERE section_id AND section_tipo RETURNING id`; its own docblock: "does NOT
  perform an upsert fallback". Zero rows → `false`, nothing saved.
- **PHP v6** (`JSON_RecordDataBoundObject::Save`): the UPDATE path, zero rows → error log
  ("Maybe you are trying to update a non existing or deleted record"), nothing saved. v6's
  only implicit create was an EMPTY id (a new record, counter-allocated) — never a
  caller-chosen one.
- **TS until this entry** (since the initial commit, under a comment wrongly claiming PHP
  upserts): `createSectionRecord(S, user, now, N, {conflictTolerant})` — a record BORN at
  the caller-chosen id `N`, authorized only by the component write grant (no create rule),
  the section counter raised to `N` (a far id parks it near the int4 ceiling), and a
  deleted record's address silently reborn. Reach: global admins and principal-less internal
  callers only — every other principal is refused `perm.out_of_scope` by the record scope
  before the engine runs (a missing row is never in scope).

## Shape after (TS)

The save refuses inside its transaction, before any write — no row, no counter raise, no
generation epoch, no Time Machine row, no activity row, no bulk birth marker:

```
{ok:false, error:{code:'resource.not_found', status:404,
  message:'save: record S/N does not exist — create records with New'}}
{ok:false, error:{code:'resource.not_found', status:404,
  message:'save: record S/N was deleted — restore it from Time Machine'}}
```

The second sentence answers when `matrix_time_machine` holds rows at the address (one
indexed probe, on the refusal path only). Non-admin principals are unchanged:
`perm.out_of_scope` 403, decided before the engine. Every door that funnels into
`saveComponentData` (the human save, MCP `save_component` / `set_field`, tools, imports,
`children_write`, transcription, internal callers) gets the same refusal.

A CSV import row whose record was deleted after the run read its existence snapshot is
refused (reported in the run's per-row failures) instead of reborn. An RDF import whose
caller record was deleted while the tool was open fails that IRI (`resource.not_found` is
a fault there, not an op refusal) instead of re-creating the caller — addendum on
WC-2026-10-01-rdf-ontology-import.

The refusal is a JS throw after a `SELECT … FOR UPDATE` that found nothing: no SQL error,
so an ambient caller transaction is not left aborted — a caller that catches it may
continue (pinned by `save_refusal_no_trace_native`).

## Reason

Creating a record is a create, with its own rule (`authorizeRecordCreate` /
`authorizeSectionCreate`, WC-2026-11-10-add-new-element-create-gate) and its own
id law (the counter is a high-water mark, WC-2026-08-30-section-id-counter-is-a-high-water-mark).
A save that creates bypasses both. A deleted record comes back through the Time Machine
restore door (WC-2026-10-21-tm-section-restore-write-door), never as a side effect of a save.

## Gate reconciliation

`test/unit/save_missing_record_refused_native.test.ts` (engine, deleted address, the
concurrent pair, the human save door as global admin, a non-admin control, MCP `set_field`,
a positive control). Replaces `save_missing_record.test.ts` (which pinned the upsert).
`create_door_census_tripwire`: the `applySaveComponentData` pending row is gone with the
create call (PENDING 3 → 2). Re-pinned to the new rule: `save_component_failure_native`
case B, `bulk_undo_capture_native` (no birth marker for a refused save),
`save_refusal_no_trace_native` (now on an existing record + the not-found-in-ambient-tx
case), `rdf_import_execute_native` (missing caller), `render_class_native` and
`media_versions_client_contract` (they saved into records they never created). No parity
fixture records a save to an absent record.
