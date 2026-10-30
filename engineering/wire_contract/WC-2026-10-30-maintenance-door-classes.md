# WC-2026-10-30-maintenance-door-classes — destructive maintenance doors need the superuser, maintenance mode, a backup and the update lock

- **Date:** 2026-10-30 (update audit 2026-10-29, design §3.4, Phase 2.8; U-15, U-42, U-25).
- **Decision:** DEC-12 (gated: `test/unit/update_door_precondition_class_tripwire.test.ts`).
- **Shape before:** every `widget_request` action ran for any global admin (gate 1 of the
  dispatcher). A move_* execute, a hierarchy reset or a dd_ontology recovery restore needed no
  maintenance mode, no backup, and could run beside a code update.
- **Shape after (TS):** each action declares a class (`src/core/update/door_class.ts`). A
  `destructive_shared` request (move_* executes — a move_* request is a dry run unless
  `dry_run: false` —, `add_hierarchy.reset_hierarchies`, `update_data_version`,
  `update_code.restore_code`, `build_database_version.restore_dd_ontology_recovery_from_file`)
  is refused before its handler with:
  - `perm.superuser_required` for any user but the superuser;
  - `maintenance.mode_required` outside maintenance mode;
  - `update.refused` when an update run is in flight, when no fresh verified backup exists (the
    option `waive_backup: true` proceeds and is logged with the user), or when the update lock is
    held (another destructive door or an update). A second move_* execute while one runs is now
    refused by the lock (`update.refused`) rather than by the transform claim
    (`resource.conflict`).
  The door holds the update lock while it runs; a door that answers with a job leaves the lock to
  the job.
  A `release_build` request (`serve_code.build_version_from_git_master`, on a code master: the
  archive is served to every consumer as integrity-verified) is refused with
  `perm.superuser_required` for any user but the superuser; maintenance mode is not required.
- **Client impact:** the panels already render a typed refusal. No panel sends `waive_backup` for
  these doors yet: an operator makes a backup first.
