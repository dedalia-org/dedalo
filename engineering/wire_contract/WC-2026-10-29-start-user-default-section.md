# WC-2026-10-29-start-user-default-section — no tipo in the URL lands on the user's default section

- **Date:** 2026-10-29 (TODO-070).
- **Decision:** DEC-12 (gated: `test/unit/start_record_scope_native.test.ts` "no tipo in the URL:
  the user lands on their dd1603 default section — only one they may read" and "the SUPERUSER
  lands on Maintenance"; the dd88 landing per persona in
  `test/unit/maintenance_access_agreement_native.test.ts`).
- **Shape before (PHP):** the login read `dd1603` (`login::get_default_section`) and the client
  navigated to it; for the superuser it answered the maintenance area (dd88) before reading
  anything. *(Corrected 2026-11-22, T2-P03-b: this entry first said PHP never read `dd1603`.)*
- **Shape before (TS):** the users section's "Default section" field (`dd1603`, e.g.
  `numisdata6`) was stored and never read. `start` with no tipo in the URL answered the install-wide
  `MAIN_FALLBACK_SECTION`, or the menu when that is empty.
- **Shape after (TS):** with no tipo in the URL, `start` answers Maintenance (dd88) for the
  superuser, before any `dd1603` read (T2-P03-a, 2026-11-22). For anyone else it answers the page
  of the user's `dd1603` tipo when it is a `section` / `area*` the user may read (permission >= 1)
  and whose own door opens (dd88: WC-2026-11-22-maintenance-access-predicate). A malformed, unknown,
  non-page or ungranted value is ignored and the old order applies — a stale default never blocks a
  login. A tipo in the URL always wins.
- **Client:** the client mounts whatever page `start` returns. The login's PHP-era navigation
  branches (`result_options.redirect`, `default_section` — keys the TS login never sends) are
  removed from `login.js` (T2-P03-a): after a login the client reloads, and `start` decides.
- **Gate reconciliation:** TS-only (the frozen PHP store holds no user with `dd1603` set).
