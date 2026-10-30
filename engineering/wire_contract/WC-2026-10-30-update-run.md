# WC-2026-10-30-update-run — the code update is a journaled run: the manifest carries the walk's plans, /health carries the run

- **Date:** 2026-10-30 (update audit 2026-10-29, design §3, Phase 2; U-01, U-03, U-33).
- **Decision:** DEC-12 (gated: `test/unit/update_run_start_native.test.ts`,
  `test/unit/health_boot_facts_native.test.ts`, `test/unit/update_run_resume_native.test.ts`,
  `test/unit/update_cli_native.test.ts`, `test/unit/client_update_code_render.test.ts`).
- **Shape before (PHP, and TS until now):** `get_code_update_info` answered `{info, files}`. The
  `update_code` widget job ran the code swap alone; the new tree's boot applied every migration
  unconditionally and confirmed the sentinel on a database ping. `/health` carried no update state;
  the panel declared success once `/health` answered the expected version.
- **Shape after (TS):**
  1. `get_code_update_info` gains ONE top-level key, `plans`: an array, ascending, of every
     catalog release above the asker's release triple —
     `{version, compat: 'compatible'|'incompatible'|null, data: 'X.Y.Z', steps: [{kind, min?}]}`
     (`src/core/update/release_plans_wire.ts`). `info` and `files` are unchanged. An older
     consumer ignores it.
  2. The `update_code` job starts an UPDATE RUN (`src/core/update/run/`): the server re-reads
     the master's manifest itself, plans from its `plans` (refusing an item the master does not
     offer), journals the run under `<private>/update/runs/`, and runs the swap as one phase.
     The job's answer is `{run_id, state, note}`; a run that ends short of a confirm fails the
     job (`update.failed` / `update.refused`, the journal's note as the public sentence).
  3. A boot that belongs to a run (its code phase started) skips the boot migration runner and
     the direct sentinel confirm: the run's own phases apply ontology → schema → data →
     ancillary, verify, then confirm.
  4. `/health` gains `update_run: {state}` while a run is recorded (the anonymous wire view; the
     route computes the verdict from the full facts `{run_id, state, target, owns_boot,
     on_target}`, which stay server-side — review #17). It is red (503) when the run ordered a code rollback (`ROLLED_BACK_CODE`) and
     this process still runs the target tree — the supervisor's watchdog then rolls back.
  5. The panel's post-restart poll keeps watching while `update_run.state` is non-terminal, and
     ends on CONFIRMED (success), NEEDS_DB_RESTORE (a backup restore is needed), a rollback (the
     old version answers), or any other terminal state (`update_code_run_failed`).
  6. The `update_code` job's terminal data stays the swap's own envelope —
     `{ok:true, data:{version, release, run_id, state}}` (`run/start.ts codeRunAnswer`), so the
     panel's `resolve_final_frame` hands over to the `/health` poll as before.
  7. **`update_ontology.update_ontology` is an ONTOLOGY-ONLY update run** (`startOntologyUpdateRun`):
     - the superuser only — refused AT THE DOOR (`perm.superuser_required`, `coordinates.door`) by
       the door class `update_run` (`WC-2026-10-30-maintenance-door-classes`), before any fetch,
       lock or journal;
     - the run's own preconditions follow: maintenance is switched ON by the run itself (and back
       to the operator's setting when it ends), a fresh verified backup is required unless the
       new option `waive_backup: true` (journaled), and no other run may be in flight — these
       refusals answer `update.refused` (409) with the run's note;
     - the server's TLD set is the active shared TLDs from its one source; the request's
       `files[].tld` only NARROW it (`matrix_dd` always rides); the request's `server` selection
       is ignored (the server holds its sources, `WC-2026-10-30-update-sources-server-held`);
     - success answers `{data:true, msg, errors?, run_id, root_info, census?}` — `msg`/`errors`
       are the import door's own lines per source, `census` the import census
       (`WC-2026-10-30-ontology-import-census-restore`); a failed import answers `update.failed`
       (503) with the run's note, no longer `maintenance.action_failed`.
- **Reason:** one versioned, journaled, resumable process per update (U-03/U-10): the ontology
  precedes the schema (D-1), a failed migration is a failed phase and never a confirm (U-01), and
  an automatic rollback happens only within one data model (D-2).
- **Gate reconciliation:** TS-only and additive; the frozen store holds no code-manifest or
  `/health` interaction. No re-harvest.

## Addendum 2026-10-30 (Phase 2 review + the full drill, `test:update:full`)

- **Each schema phase applies its own release's migrations** (drill B2): `runMigrations({throughRelease})`
  stops at the first file the ledger dates to a later release. A walk 7.0.1 → 7.1.0 applies 7.0.2's
  files in `7.0.2 schema` and 7.1.0's in `7.1.0 schema` (after the 7.1.0 ontology step), so the
  rollback predicate judges every file by its own release's compat. The boot (no run) still applies
  every pending file. Gate: the drill's RUN 2 + `update_run_resume_native`.
- **NEEDS_DB_RESTORE blocks new runs until a human closes it** (drill B3/B4, D-2): a start is refused
  `update.refused` rule `restore_pending`. `bun run update abort <note>` with no run in flight closes
  it (journal gains `restore_closed: {at, note}`); the restore report's last action says so (it said
  "Mark the run as MANUAL", which `transition()` refuses — the state is terminal). Gates:
  `update_run_resume_native` (B4), `update_cli_native`, the drill's RUN 3.
- **A release's default ontology step is skipped without a source**: inside a code run, a release
  that declared no steps has its `ontology` phase end `ok` with evidence `{skipped: 'no ontology
  source is configured'}` when no source is configured. A declared step, and the panel's
  ontology-only run, still fail. Gate: `update_run_ontology_phase_native`.
- **`update_code.restore_code` carries `waive_backup`** (the destructive door's waiver, WC
  2026-10-30 maintenance-door-classes): the restore modal offers it on the update modal's
  predicate (`backup_waiver_check`) and always sends the boolean. Gate: `test_update_code.js`.
- `/health` `update_run` is `{state}` on the wire (review #17; see item 4).

## Addendum 2026-10-30 (final review)

- **A walk with no post-swap schema phase ends with one** (review #3): `plan.ts withTargetSchema`
  appends `{release: <target>, step: {kind: 'schema'}}` when no `schema` phase follows the code
  phase (a dev build over the same triple, a prerelease to its release), so the target's own
  migrations are applied inside the run and judged by the rollback predicate. Gates:
  `update_run_resume_native`, `update_run_state_machine_native`.
- **A data phase runs only its own rung** (#2): `run/data_rung.ts rungVerdict` — at the rung's
  target the phase is ok with evidence `{already_applied: true, data_version}` (a resume after the
  rung committed); at its source it runs; anywhere else it fails `{summary}` and runs nothing.
  Gate: `update_run_data_rung_native`.
- **The run checks it still holds the lock** (#8): `UpdateRunLock.held()` (pg_locks on the reserved
  session). A lost lock stops the run before the next phase, that phase left `running` — resumable,
  never a failure exit. The boot resume retries a held lock every 30 s for two hours (#10).
  Gate: `update_run_resume_native` (review 2026-10-30 (3)).
- **A destructive job re-checks the journal under the lock** (#9): `holdUpdateRunLock` refuses
  `run_in_flight` (a run's restart window, where the lock is free). Gates:
  `update_door_precondition_class_tripwire`, `repair_script_preconditions_native`.
- **The tools registry write must land** (#11): an item with `writeFailed` fails the ancillary
  phase; an invalid register.json stays reported only. Gate: `update_run_ancillary_native`.
- **The run's ontology phase requires file digests** (#14): a source whose manifest publishes no
  sha256 for a selected file fails with "publishes no file digest for …" before the door. Gate:
  `update_run_ontology_phase_native`.
- A resumed run acts as SUPERUSER, which is the starter: only SUPERUSER_ID may start one (#4, no change).
- **Second final-review pass (wf_04648a58-35f):**
  - the boot resume re-reads the journal once it holds the lock, and resumes nothing when the run
    ended (or changed) while it waited;
  - the needs-restore flip is read back (`assertSentinelStatus`); when it did not land, the
    model-crossing phase does NOT run: it is journaled `skipped` `{not_run: true, summary}` and the
    run fails on its own terms (ROLLED_BACK_CODE — the model was not crossed);
  - `UpdateRunLock.release()` on a dead session resolves (the lock went with the session);
  - `update_catalog.json`: a schema/data/ancillary step declared before `code` is refused
    (`step_placement`) — the planner runs those after the swap only.
  Gates: `update_run_resume_native`, `update_run_data_rung_native` (dataPhase wiring,
  isDefaultOntologyStep, assertSentinelStatus), `update_run_state_machine_native` (dead session),
  `update_catalog_json_tripwire`.
- **Third pass (wf_4bd66a8c-43e):** the lock's reserved session sets `idle_session_timeout = 0` and
  `idle_in_transaction_session_timeout = 0` (the idle holder is never reaped) and exposes its `pid`; a
  phase re-checks the lock AFTER it ran too (lost while running → left running, not settled ok); a
  start re-checks the journal under the lock (`run_in_flight`); the image updater's pin marker is
  owned from its mv (a signal during its sync settles it). Gates: `update_run_resume_native`,
  `update_run_data_rung_native` (the real productionRunEffects: data runner, sentinel read-backs,
  backup refusal/waiver), `image_update_script_native`.
