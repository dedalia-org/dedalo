# WC-2026-10-28-own-user-record-read-floor — own guarded dd128 fields readable by a global admin; own read-only select names only its stored option; datalist cache keyed by label set

- **Date:** 2026-10-28 (owner report TODO-071: "user admin tool do not display the user profile
  (dd1725). It should be display it as read only"; the feature crawl's non-root admin got
  `perm.denied` reading its own dd330/dd132/dd1725). Successor addendum to
  `WC-2026-08-28-root-self-service-write` (the own-record table).
- **Decision:** DEC-12 (gated: `test/unit/user_self_record_permissions.test.ts`). Human decisions
  (2026-10-28): fix the datalist cache bleed in this change; a user always sees the NAME of their
  own profile, read-only.
- **Shape before (TS):**
  1. `getRecordComponentPermission` on the actor's own dd128 record: guarded components
     (dd1725/dd515/dd132/dd330/dd692-695) forced to 1 for a non-global-admin; a global admin fell
     through to the matrix (PHP parity) — most profiles grant 0 on dd128 → `read` `403
     perm.denied` for a non-root admin opening `tool_user_admin`.
  2. A select's edit `datalist` = every option of the target section, labels from the show ddos the
     actor holds ≥ 1 on (request_config `filterAuthorizedRelated`). A user without a grant on
     dd234/dd237 got every profile, every label `''`.
  3. The datalist cache was keyed `component_owner_lang` while its labels depend on the principal:
     the FIRST builder's list was served to every caller (blank labels for root after an editor;
     labels a reader may not see after root).
- **Shape after (TS):**
  1. Own record, guarded component, matrix < 1 → level 1 (a floor, never a cap: a matrix 2 stays 2;
     another user's record unchanged). `resolveComponentContextPermission` (non-search) and the
     section read's element stamp route through `getRecordComponentPermission`, so all three agree.
  2. Own record, select-family component at level ≤ 1 (read-only): `datalist` = ONLY the stored
     option(s), labelled without the per-user ddo filter. The user learns their own profile's name,
     never the list of profiles. Editable fields and other records are unchanged.
  3. Cache key = `component_owner_lang_<label ddo tipos>|<hide ddo tipos>` (built and probed alike):
     callers with the same readable label set share one list; no caller is served another's.
- **Client:** none — the tool already rendered dd1725 read-only from `datalist`; it now has a name
  to show.
- **Reason:** the self-service tool must show the user their own account read-only; a cache must
  never carry one user's view to another (`engineering/REQUEST_ISOLATION.md`).
- **Gate reconciliation:** TS-only. Parity fixtures read as the superuser (no filter, full label
  set), and no fixture reads its own dd128 record as a non-root admin — no fixture edit.
