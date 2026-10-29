# WC-2026-10-27-start-deep-link-record-scope — `start` refuses a section deep link to a record the caller cannot open

- **Date:** 2026-10-27 (feature crawl: `editor:test3:oracle:other_project_record` — a project-scoped
  editor opening an out-of-project record by URL got no refusal page, and the inspector sent a
  `relation_list` read with `section_id: null`, toasting `request.invalid_rqo`). Amends
  `WC-2026-08-12-authorization-denial-token` (the page-door refusal now also covers the record).
- **Decision:** DEC-12 (gated: `test/unit/start_record_scope_native.test.ts`, client
  `test_inspector_relation_list_access`). Human decision #1 (2026-10-27).
- **Shape before (TS):** `start` with a SECTION deep link carrying a record id (`?tipo=S&id=N`)
  checked only the section grant `getPermissions(principal, S, S)`. A non-admin got `200` with an
  edit context for a record their projects exclude, or that does not exist; the edit read then
  answered zero rows (`.no_records`) and the inspector mounted record-bound blocks with no record.
- **Shape after (TS):** for a section deep link with `section_id >= 1`, `start` also asks
  `principalCanAccessRecord(S, N, principal)` (`security/record_scope.ts`). False → `403
  perm.denied`, `publicMessage` "Insufficient permissions to read", the environment riding the
  refusal (`extend.environment`), NO coordinates — the client renders `no_access_page`. A missing
  id and an out-of-scope id get the same status, code, `publicMessage` and body shape (only
  `request_id` and the per-session environment differ): no existence oracle. Unchanged: global
  admins (unscoped), ids `< 1`, component / area deep links, and `get_data`'s `emptyShell` for an
  out-of-scope record (AUTHZ-01, `record_scope_gates`).
- **Client:** `render_inspector.js` mounts the Relations block only with a record
  (`caller.section_id` set); `relation_list.build()` and `build_graph_data.fetch_inverse_relations`
  never send a null pin (a record-less admin edit view sends nothing).
- **Reason:** the page door must refuse what the record door hides; a 200 empty edit shell is not a
  refusal the user can read, and it booted panels that query a null record.
- **Gate reconciliation:** TS-only. `start_differential` / `section_tool_start_differential` run as
  the superuser (admin bypass): no fixture edit, no re-harvest.
