# WC-2026-10-28-own-account-read — an account reads its OWN user record through get_data, root (dd128/-1) included

- **Date:** 2026-10-28 (feature crawl #6).
- **Decision:** DEC-15 (completes WC-2026-08-28-root-self-service-write). DEC-12 (gate:
  `test/unit/root_user_hidden_tripwire.test.ts` "ROOT READS ITS OWN ACCOUNT through get_data").
- **Shape before (TS):** the component `get_data` record gate (`read_facade.ts`) asked
  `principalCanAccessRecord`, which refuses every `section_id < 1` for every caller. Root's account
  is dd128/-1, so each component read root's `tool_user_admin` issues answered the empty shell
  (`context: []`). The client built components without context and the tool rendered its error panel
  ("unreadable response", `client.bad_response`). WC-2026-08-28 had opened the SAVE of root's own
  name/email/password/image so root could rotate its credential in-engine, but its only UI could not
  open.
- **Shape after (TS):** the record gate admits the actor's OWN account record
  (`isActorsOwnUserRecord`: section dd128, id === `principal.userId`, user id not 0) before
  `principalCanAccessRecord`. Gate A and the per-component level gate still apply unchanged
  (`getRecordComponentPermission`: dd244 forced to 1, the four self-editable components at 2).
- **Unchanged:** no other principal gains anything on -1 — a global admin holding (dd128, dd133) = 2
  still gets the empty shell for root's record. Root stays hidden from every list, search,
  autocomplete and `filter_by_locators` pin (`buildSearchSql` `section_id > 0`); duplicate/delete of
  -1 stay refused; `principalCanAccessRecord` itself is untouched.
- **Client:** none.
- **Gate reconciliation:** TS-only.
