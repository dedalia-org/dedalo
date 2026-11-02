# WC-2026-09-04-client-limit-bound — the client ceiling is published, and the tree children door clamps like an SQO

- **Date:** 2026-09-04, adopted with the change that closes audit row
  P2-31-residue (CLI-29, CLI-30: "the browser must not build without bound").
- **Decision:** DEC-07 (the client limit ceiling stays a server control) and
  DEC-12 (the invariant lands with its gates:
  `test/unit/client_limit_zero_tripwire.test.ts` — no client call site sends
  an unbounded limit, TOTAL census over `client/` + `tools/**/js`, plus the pure
  clamp legs; `test/unit/client_render_budget_native.test.ts` — the row-window
  bound, its adopters and the browser suite's registration;
  `test/unit/ts_api_children_data_native.test.ts` — the children door's clamp
  and paging, on the suite DB; the browser half is `test_render_budget` in
  `bun run test:client`).

## Shape before (PHP)

Three things, all silent:

1. `page_globals` (dd_core_api::get_page_globals) carried NO statement of the
   server's client limit ceiling. The client sent `limit: 0` wherever it meant
   "everything" (portal "show all", the open-relations 'found' scope, emails,
   related records, recursive children, the tool_qr sheet, tool passthroughs)
   and `search_query_object::sanitize_client_sqo` clamped it to
   `DEDALO_SEARCH_CLIENT_MAX_LIMIT` (1000) without telling anyone — a request
   that pretended to be complete, answered with a page.
2. `dd_ts_api::get_children_data` took `options.pagination` VERBATIM into
   `ts_object::get_children_data`, which paged only when
   `limit > 0 && total > limit` — `total` being whatever the client sent. So a
   client `limit: 0` was an UNPAGED read of the whole branch (the two
   post-duplicate refresh paths sent exactly that, exactly when the parent was
   known to be paginated), and a client-supplied total at or below its own
   limit switched paging off too (three children through a request that asked
   for two — measured, pinned by the old leg of ts_api_children_data_native).
3. A client-supplied `pagination.offset` was not coerced at that door.

## Shape after (TS)

ADDITIVE on page_globals, BEHAVIOURAL on the children door:

- `page_globals.dedalo_search_client_max_limit` (integer ≥ 1): the SERVER's
  `config.features.searchClientMaxLimit` (`DEDALO_SEARCH_CLIENT_MAX_LIMIT`),
  served to every caller (not session-gated: it is a shape of the API, not a
  secret). The client reads it through ONE module,
  `client/dedalo/core/common/js/sqo_limit.js` (`max_page_limit`,
  `bound_sqo_limit`, `request_complete`), and never carries a constant of its
  own; an absent key falls back to the engine default LOUDLY (console.error) —
  a stated exception, not silence.
- `dd_ts_api.get_children_data`: `options.pagination.limit`, when present, goes
  through the SAME `clampClientLimit` as an SQO limit (`src/core/concepts/sqo.ts`,
  extracted from sanitizeClientSqo): 0, negative, non-numeric or above the
  ceiling → `CLIENT_MAX_LIMIT`, echoed in the response `pagination.limit`; an
  ABSENT limit keeps the door's own default (300). `offset` is coerced to an
  integer ≥ 0. `total` is still the client's cached count, trusted for the
  ECHO only.
- `ts_object.getChildrenData` pages whenever `limit > 0` — a client total never
  switches paging off. The answer to `{limit: 2, offset: 0, total: 2}` over a
  3-child parent is now TWO children (was three).
- The client no longer sends `limit: 0` anywhere: display consumers send the
  ceiling (portal show-all, open-relations 'found', tool_qr — which now reads
  the server's FILTERED total and renders a loud `qr_truncated` notice when the
  selection exceeds the page, instead of a partial sheet presented as whole);
  completeness consumers (component_email, relation_list.get_related_records,
  ts_object.get_children_recursive) walk the offsets at the ceiling
  (`request_complete`) and concatenate the pages; the tree's post-add /
  post-duplicate refresh re-sends the parent's OWN page size from offset 0;
  tool_export / tool_identify / tool_propagate_component_data drop their client
  override because their servers force their own bound (grid.ts `limit = null`
  after sanitize; record_pool `cap + 1`; propagate `limit = null`). `ddo_map`
  `limit: 0` in tool_print is NOT a search limit (the DDO pagination field of
  one record's stored relation, bounded by the record) and stays.

## Reason

The client is the only place that can stop ASKING for the unbounded, and it
can only ask for the right bound if the server says what the bound is. A
client constant would drift from the install's `DEDALO_SEARCH_CLIENT_MAX_LIMIT`
the first time an operator changed it; a client that keeps sending 0 keeps
every completeness consumer wrong above 1000 records in silence. The children
door had no clamp at all, so the "the server treats 0 as the ceiling" premise
of the audit's fix direction was false there: it treated 0 as everything.

And the render half: what the client builds from the page it is allowed is
bounded by the row window (`client/dedalo/core/common/js/row_window.js`,
`ROW_WINDOW_MAX_ROWS` = 200, shrink-only), adopted by the section list views
(default / base / thesaurus_list), the portal list view, EVERY portal edit view
(default / content / line / tree / indexation / mosaic — the paginator, hence
"show all", exists only in portal edit mode, so these are the door CLI-29
reproduced through; the mosaic view windows its three records per row through
a custom materialize) and the thesaurus tree's `render_children`. Not a wire
change; recorded here because the limit contract above is what makes its
"page ≤ ceiling" premise true.

## Gate reconciliation

- `test/parity/environment_differential.test.ts`: `dedalo_search_client_max_limit`
  is asserted present and numeric on the TS side, absent on the PHP side, then
  stripped before the exact page_globals key-set compare (the WC-031 / WC-051
  pattern). No re-harvest (impossible by definition, and not needed: the gate
  transforms before diffing).
- `test/unit/ts_api_children_data_native.test.ts`: the leg that pinned
  "a supplied total EQUAL to the limit takes the UNPAGED read — and can return
  more rows than the limit" is REWRITTEN to pin the paged answer, and a new leg
  pins `limit: 0` → `CLIENT_MAX_LIMIT` echoed and paged, `> ceiling` and a
  negative offset coerced.
- `test/parity/dedalo_files_differential.test.ts`: `sqo_limit.js` and
  `row_window.js` are two more `POST_HARVEST_CLIENT_ADDITIONS`.
- The two browser suites that asserted / sent 0 (`test_open_related_data`,
  `test_component_portal_pagination`) assert / send `max_page_limit()`.
- No frozen read-path fixture carries a `limit: 0` request from the client
  side of a differential (the harvested RQOs are the gates' own), so nothing in
  the fixture store changes.

## Addendum 2026-10-31 — sections and portals render through record_window; row_window is the ts_object tree only

The render half above named `row_window.js` as the module that bounds what the
client builds from the page, adopted by the section lists, the portal views and
the thesaurus tree. Since the row-box change
(`WC-2026-10-30-section-record-row-box.md`) that is no longer so:

- **Sections and portals** — the section lists (default / base /
  thesaurus_list), the Time Machine views (tool / mini / history), every portal
  view (edit default / content / line / tree / indexation / mosaic, list
  default / line) and both tool mosaics — render their rows through ONE door,
  `client/dedalo/core/section_record/js/record_window.js`
  (`create_record_window`, reached through the owner's `record_windows[slot]`).
  It keeps the SAME bound: `min(N, ROW_WINDOW_MAX_ROWS)` built rows, imported
  from `row_window.js` (still 200, still shrink-only); above it the rest of the
  page are childless placeholder rows, not a spacer, so `content_data.children`
  is exactly one row per entry.
- **`row_window.js`** keeps its constants (the one source of the bound) and its
  window, used ONLY by the thesaurus tree (`ts_object` `render_children`).

The limit contract is unchanged: the window still bounds what is BUILT from a
page the server already bounds by the ceiling (N ≤ `max_page_limit()`), so the
"page ≤ ceiling" premise and every gate above stand. Not a wire change. Gates:
`test/unit/client_render_budget_native.test.ts` (the bound and its adopters,
rewritten for the record window), `test/unit/client_row_dom_tripwire.test.ts`
(the row invariant per adopted view), and the browser suites `test_render_budget`
and `test_row_invariant`.
