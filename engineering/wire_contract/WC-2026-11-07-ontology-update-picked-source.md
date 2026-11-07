# WC-2026-11-07-ontology-update-picked-source — the panel's update takes the ticked TLDs from the PICKED master

- **Date:** 2026-11-07. TS-native (`src/core/area_maintenance/widgets/update_ontology.ts`,
  `src/core/update/run/ontology_phase.ts`); PHP has no twin. Owner decision 2026-11-07:
  several ontology masters usable side by side, no TLD restriction on an operator's pick.
- **`update_ontology` action:** `options.server` is no longer ignored. With a server and a
  non-empty `files` list, the run records `ontology_source` (the server `url`, or `localhost`
  for `code: 'localhost'`) beside `ontology_scope` (the files' TLDs — **`matrix_dd` included
  only when sent**; it used to be dropped from the scope and always imported). The phase then
  updates from that ONE master, exactly the scope's TLDs its manifest lists. A named server
  with an EMPTY file list is still a pick, with an empty scope (nothing updated) — it never
  falls through to the unattended set. Without a server the run is unattended as before,
  narrowed by the files' TLDs when any.
- **An operator pick is not bounded by `ACTIVE_ONTOLOGY_TLDS`** (`assertUpdateTldScope(…,
  picked=true)`): any TLD the picked manifest lists, never `localontology`, never the suite's
  fixture TLD. The D-8 one-source-per-TLD map does not apply to a pick.
- **Unattended (a code update's ontology phase):** sources are the entries declaring `tlds`
  (each for its list, D-8 refusals unchanged), else the FIRST `ONTOLOGY_SERVERS` entry alone.
  Was: every entry, refused (`source_unassigned`) as soon as one of several lacked `tlds`.
- **Master identity is the exact url** (`resolveUpdateTarget` → `configuredUrl`), was the
  origin: two masters on one host under different paths are distinct. The download pin stays
  the origin.
- **Panel value gains `installed_tlds`** (sorted TLDs holding dd_ontology rows) — the client
  marks each offered TLD new / installed / installed-but-not-tracked.
- **Client** (`render_update_ontology.js`): `build_tld_catalog` replaces the chip rows (the
  picked master's manifest, fetched on pick, grouped by typology, named in the app language);
  `build_import_files` sends `matrix_dd` only when selected; the remembered selection moves to
  `dedalo.update_ontology.selection` (the older key is moved once with `matrix_dd` appended, then dropped); a submit whose
  ticks the picked master offers none of is refused in the panel.
- **Confirmation moved into a modal** (`open_confirm_modal`, the code update's version-modal
  shape): the panel's inline backup block + waiver checkbox, the form's native `confirm()` and
  the untracked-TLD `confirm()` are gone. After the manifest is read the modal names what will
  be replaced and from where, warns about untracked picks, and mounts the waiver row ONLY when
  `value.backup` is not `ok` (re-read on click) — the SAME row as the code modal
  (`render_update_status.js build_waive_backup_row`). Its `ui.confirm` restates the TLDs, host
  and a waiver. `waive_backup` on the wire is unchanged (always a boolean). `confirm_text` keeps
  its key but loses the `!!! WARNING !!!` banner + title lines (it is now the `ui.confirm`
  body; the modal header carries the title) — server fallback + 17 catalogs;
  `update_ontology_untracked_confirm` is removed. `build_form` gains `confirm_text:false`
  (no native confirm).
- **`update_ontology` action is a BACKGROUND JOB** (`mediaJobs`, lane `maintenance`, like
  `update_code`): the immediate answer is `{data:true, msg, extend:{pid, pfile}}`, polled through
  `dd_utils_api:get_process_status`. Was: one synchronous request (client timeout 1 h) answering
  `{data:true, msg, errors?, extend:{run_id, root_info, census?}}`. While running, the job's
  `data` is the import's progress frame `{msg, progress:{stage, done, total, tld?}}`
  (`src/core/ontology/update_progress.ts`, an ALS-scoped sink — `stage` ∈
  download/import/derive/finish, `done` = items finished before `tld`); the FINAL frame's `data`
  is the old answer flattened: `{msg, errors?, run_id, root_info, census?}`. A refused / failed
  run is the job's coded `error`; a STOPPED job (operator stop, lane deadline) ends `is_running:false`
  with its `errors[]` lines and no answer, and a dropped stream ends on a progress frame — the client
  accepts success ONLY on a finished frame whose `data.run_id` is set (else: failed, or "lost
  contact, may still be running"). The manifest never offers `matrix` (the export's data dump) as an
  ontology, so a pick cannot import it. Client: `track_update_job` (kit `.dd_bar`, stage shares in
  `update_progress_share`), result rendered from the final frame.
- **Gates:** `test/unit/update_run_ontology_phase_native.test.ts` (pick, gone pick, first-entry
  unattended), `test/unit/ontology_source_map_native.test.ts`,
  `test/unit/ontology_update_tld_scope_native.test.ts`,
  `test/unit/ontology_update_target_native.test.ts`,
  `test/unit/update_ontology_widget_native.test.ts` (job handle, result, progress frames, the ALS sink),
  `test/unit/client_update_ontology_tlds_input.test.ts`,
  `client/dedalo/test/client/js/test_update_code.js` (tld_catalog_rows, rendered catalog,
  waive-backup control through the modal, progress bar, update_progress_share).
