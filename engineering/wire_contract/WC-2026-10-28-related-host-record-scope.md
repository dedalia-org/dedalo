# WC-2026-10-28-related-host-record-scope — a related search's HOST record is scope-gated

- **Date:** 2026-10-28 (crawl follow-up: "the Relations read checks the section, not the record").
- **Decision:** DEC-12 (gated: `test/unit/relation_list_inspector_access_native.test.ts` "the HOST
  record is scoped too", `test/unit/count_native.test.ts` "a host RECORD outside the caller's
  projects is 403").
- **Shape before (TS):** `read` / `count` with `sqo.mode: 'related'` gated each
  `filter_by_locators` host by its SECTION grant only (WC-2026-10-22-related-search-one-scope); the
  owning rows were scoped, the host record was not. A non-admin holding the section could ask "who
  points at record N" for a record outside their projects (or one that does not exist) and get
  the in-scope referrers back — the relations of a record they cannot open.
- **Shape after (TS):** every host locator carrying a `section_id` must also pass
  `principalCanAccessRecord` (non-positive id refused, global admin unscoped, otherwise the
  projects filter). A miss is `perm.denied` (403) — the SAME answer for an out-of-scope and a
  missing record, so the door is no existence oracle (as start's deep link,
  WC-2026-10-27-start-deep-link-record-scope). A host locator without an id is unchanged
  (section gate only). Read and count share the gate.
- **Client:** none. The inspector panel, the delete dialog and the graph all ask about the record
  the user has open, which is already in scope; a 403 can only reach a forged or stale request.
- **Not covered here:** `get_indexation_grid` (thesaurus "show indexations") gates the term's
  section, not the term record — same class, separate door, follow-up.
- **Gate reconciliation:** TS-only; no parity fixture asks a related search as a non-admin.
