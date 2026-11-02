# WC-2026-11-01-update-plan-declared — the manifest's plans say whether a release declared its steps; a backup refusal is `update.refused` again

- **Date:** 2026-11-01 (found by the code-updater drills, `scripts/update_drill.ts`, red in the
  pre-push instance tier).
- **Decision:** DEC-12 (gated: `test/unit/update_run_start_native.test.ts` "DECLARED travels",
  `test/unit/update_run_resume_native.test.ts` backup REFUSED / FAILED_PRE_SWAP legs,
  `test/unit/update_run_state_machine_native.test.ts` side exits, and both drills end to end).
- **Shape before (TS, since `WC-2026-10-30-update-run`):**
  1. `get_code_update_info` `plans[]` entries were `{version, compat, data, steps}`. The consumer
     (`release_plans_wire.ts readWirePlans`) stamped every one `declared: true`. A release that
     declares no steps (the D-1 default order, e.g. `"7.0.1": {}`) therefore reached the consumer's
     run as DECLARED: its default ontology step stopped being optional
     (`run/production.ts isDefaultOntologyStep`), so an install with no ontology source
     (`ONTOLOGY_SERVERS=[]`, the documented air-gapped setup) failed it AFTER the swap and past the
     data-model flip — `NEEDS_DB_RESTORE` for a code-only patch.
  2. The run's backup step threw its own generic sentence ("No fresh, proven restorable database
     backup — take one, or waive it (journaled)") and the run ended `FAILED_PRE_SWAP`, so the
     `update_code` job failed `update.failed` (retryable) without naming the dump that did not
     verify or why.
- **Shape after (TS):**
  1. Each `plans[]` entry carries `declared: boolean` — the master's `ReleasePlan.declared`. It is
     REQUIRED on read: an entry without it (a master from 2026-10-30 .. 2026-11-01, TS beta only)
     fails the whole read, and the run refuses to plan from it, as for any malformed plan.
  2. The backup step builds its refusal with the one builder (`preconditions.ts
     freshBackupRefusal`, shared with `requireFreshBackup`): the sentence names the dump and the
     reason (e.g. `truncated`) and the slow-storage remedy. A typed `update.refused` from that step
     ends the run `REFUSED` (new side exit `PREFLIGHT_OK → REFUSED`; nothing ran), so the job fails
     `update.refused`. Any other throw from the step stays `FAILED_PRE_SWAP`.
  3. A PRE-SWAP phase that throws a typed `update.refused` (the code phase's verify: "Release
     checksum mismatch") journals the code beside its sentence (`evidence.code`), the run's note
     carries the sentence (it was a bare `<release> code failed`), and the job fails
     `update.refused` instead of `update.failed` (`run/start.ts refusedRun`; refuse.ts: never
     launder a refusal). After the swap the job stays `update.failed` whatever threw.
- **Reason:** what a step means on the consumer depends on whether it was declared; and an
  operator refused for a backup must be told which dump and why, with a non-retryable refusal.
- **Gate reconciliation:** TS-only; no parity fixture records `get_code_update_info` `plans` or the
  update job. No re-harvest.
