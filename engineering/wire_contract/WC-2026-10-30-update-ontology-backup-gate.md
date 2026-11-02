# WC-2026-10-30-update-ontology-backup-gate — the update_ontology panel states the run's backup gate before the click

- **Date:** 2026-10-30.
- **Shape before (PHP):** the `update_ontology` panel value carried no backup
  fact (PHP's import ran without a backup precondition). In TS the import runs as
  an ontology-only UPDATE RUN (`core/update/run/start.ts`) that REFUSES without a
  fresh, proven-restorable database backup unless `waive_backup:true` — the panel
  offered the waiver checkbox blind, and the operator learnt of the gate only from
  the refusal, after the confirm dialog and the master's manifest fetch.
- **Shape after (TS):** the panel value gains `backup`: the SAME `backup_fresh`
  `StatusCheck` (`{ id, state, detail?, scope? }`) the update_code panel reads in
  `consumer.checks`, produced by the one function (`backupFreshnessCheck`,
  `src/core/update/status.ts`, now exported) — so the two panels and the run's
  refusal judge one verdict. Superuser-only reads, bounded wait (`verifying`),
  unchanged. The client (`render_update_ontology.js` `build_backup_gate`) renders
  `ok` as a quiet line with the age and offers NO waiver; any other state renders
  the reason, the waiver, its consequence, and keeps the submit disabled until
  the waiver is ticked. A value without `backup` (older engine) keeps the old
  blind waiver, server-decided.
- **Reason:** the backup gate is the safety surface of an irreversible action;
  an unexplained checkbox under a destructive button is not a decision an
  operator can take knowingly.
- **Gate reconciliation:** additive key on a TS-native panel payload; no fixture
  store carries `update_ontology`'s value (the widgets differential does not
  replay it), so NO re-harvest. `test/unit/active_ontology_tlds.test.ts` and
  `test/unit/serve_ontology_widget.test.ts` assert named keys, not the key set's
  exact size.
