# WC-2026-11-09-start-deep-link-found-set-position — a section record deep link reopens inside its navigation

- **Date:** 2026-11-09 (reported: editing a record and reloading the page lost the paginator total —
  filtered or not — and prev/next no longer moved between the found records; reproduced on the dev
  install, `numisdata4`, `?tipo=numisdata4&mode=edit&id=6`: page 6 of 184.247 before the reload,
  1 of 1 after it). Builds on `WC-2026-10-27-start-deep-link-record-scope` (that scope gate is
  unchanged and still runs first) and the client rule of `2147ca7672` (the URL names the open record).
- **Decision:** DEC-12 (gated: `test/unit/start_deep_link_navigation_native.test.ts`,
  `test/unit/start_deep_link_native.test.ts`, `test/unit/start_record_scope_native.test.ts`, client
  `test_pinned_record_view`).
- **Shape before (TS):** `start` answered a SECTION deep link carrying a record id with the
  section context + `section_id: N`. The client instance inherited `section_id`, `build_rqo_show`
  pinned it (`filter_by_locators: [N]`), and the pinned record view forced `limit 1 / offset 0 /
  total 1`, skipping the stored `sqo_session`. The pinned edit read then PERSISTED the pin as the
  session SQO, overwriting the user's found set for good.
- **Shape after (TS):**
  - `start`, for the page's own plain section deep link (no `view`, no section_tool `config`,
    `session_save` not opted out — read like the client, `JSON.parse` falsy), resolves the record's position (`src/core/search/record_position.ts`):
    in the stored session SQO when it is a page view of this section that holds the record (a one-row
    probe at the stored offset first, else one `row_number()` scan of the ordered found set), else in
    the whole section (default order). It answers with the list→edit navigation shape:
    `request_config: [{api_engine:'dedalo', type:'main', sqo}]` where `sqo` is the page view with
    `limit 1`, `offset <position>`, and `filter` / `order` / `filter_by_locators` stated explicitly
    (an absent key is filled from the session by `mergeSessionSqo`), plus `section_id_selected: N` —
    and NO `section_id`.
  - Bounded, because `start` is the page boot: only an integer id >= 1 that a one-row pin probe finds
    readable for the principal gets a position (a deleted id, an out-of-scope id, a non-numeric id
    costs no scan); the numbering scan runs under a 3 s statement budget
    (`DEEP_LINK_POSITION_BUDGET_MS`), past which the record opens pinned alone; a stored SQO that no
    longer builds (a filter on a tipo an ontology update removed) is reported and skipped — the whole
    section answers instead, never a failed boot. The navigation SQO states `children_recursive: false`
    so a stored descendant expansion cannot merge back in.
  - Otherwise (viewer, section_tool, component deep link, opted-out window, no readable record, scan
    past budget) the old shape: `section_id: N`, no `request_config` — the record is pinned alone.
  - `readSectionRows` no longer persists a SINGLE-RECORD PIN (one locator, not `mode 'tm'`) as the
    session SQO: a pin is a record view's identity, not navigation. A page view (no pin, or two or
    more pins — a result set) is persisted as before.
- **Client:** none required — `page.instantiate_page_element` already forwards `request_config`
  (the shape `page.navigate` builds from a list→edit navigation), so the reload takes the same path
  as the navigation that produced the URL; `sync_url_record` keeps `?id=` following prev/next.
- **Known consequences / limits:**
  - Tools that act on the edit view's current `rqo.sqo` (tool_propagate_component_data,
    tool_update_cache, tool_identify, tool_ontology) now see the found set after a reload — or the
    whole section after a pasted link — exactly as after a list→edit navigation, instead of the single
    pinned record. Their own guards stand (propagate shows `All - <total>`, asks for confirmation and
    re-scopes server-side).
  - The position is computed in `start` and read by the next request; a concurrent change of a
    MUTABLE order (another user's insert into Activity's newest-first list, an edited sort value) can
    shift it, and the edit view then opens a neighbour (`sync_url_record` follows it into `?id=`).
    The far-half page flip of a deep offset (`sql_assembler.ts` late-row lookup over the cached browse
    total) carries its own pre-existing ±k drift.
  - A one-locator RESULT SET (a semantic search with exactly one hit, or its zero-hit `section_id:-1`
    sentinel) is shaped like a record pin and is not stored as session navigation either; the client's
    `is_pinned_record_view` already treats it the same way.
- **Reason:** the address bar names the record so a reload can find it, but the edit view is a page
  over the user's found set: a reload that drops the found set and its position is a lost workspace,
  and storing the pin destroyed it for the next list read too.
- **Gate reconciliation:** TS-only. `start_differential` / `section_tool_start_differential` do not
  replay a section record deep link with an id; no fixture edit, no re-harvest.
