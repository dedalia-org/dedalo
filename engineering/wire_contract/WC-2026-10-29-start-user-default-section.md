# WC-2026-10-29-start-user-default-section — no tipo in the URL lands on the user's default section

- **Date:** 2026-10-29 (TODO-070).
- **Decision:** DEC-12 (gated: `test/unit/start_record_scope_native.test.ts` "no tipo in the URL:
  the user lands on their dd1603 default section — only one they may read").
- **Shape before (TS and PHP):** the users section's "Default section" field (`dd1603`, e.g.
  `numisdata6`) was stored and never read. `start` with no tipo in the URL answered the install-wide
  `MAIN_FALLBACK_SECTION`, or the menu when that is empty.
- **Shape after (TS):** with no tipo in the URL, `start` answers the page of the user's `dd1603`
  tipo when it is a `section` / `area*` the user may read (permission >= 1). A malformed, unknown,
  non-page or ungranted value is ignored and the old order applies — a stale default never blocks a
  login. A tipo in the URL always wins.
- **Client:** none — the client mounts whatever page `start` returns.
- **Gate reconciliation:** TS-only (the frozen PHP store holds no user with `dd1603` set).
