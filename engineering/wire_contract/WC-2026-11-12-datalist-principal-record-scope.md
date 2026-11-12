# WC-2026-11-12-datalist-principal-record-scope — the select-family option list is the caller's search, built for a record

- **Date:** 2026-11-12.
- **Decision:** RC-closure T1-9 + T1-13 + T1-37 (audit O05 / O07 / S01; owner
  authorised Tier 1 implementation 2026-11-12). DEC-12 gates:
  `test/unit/datalist_projects_scope_native.test.ts`,
  `test/unit/datalist_record_filter_native.test.ts`.
- Code: `src/core/relations/datalist.ts` (`DatalistOwner`,
  `resolveDatalistSources`, `buildTargetStatement`, `datalistCacheKey`),
  `src/core/search/sql_assembler.ts` (`SearchOptions.includeRootUser`),
  `src/core/search/search_statement.ts` (`searchStatementFingerprint`),
  `src/core/relations/request_config/filters.ts` (`expandFilterByList`).
- Cross-references (unchanged): `WC-2026-09-29-select-family-mode-datalist`,
  `WC-2026-10-02-select-lang-missing-entry`.

## Shape before (TS)

The `datalist` of every select-family door (edit read, both save echoes, the
`list` value labels, `filter_by_list`, the state widget, identify) was built
by enumerating the target section with a raw `SELECT section_id` — the filtered
branch ran the assembler WITHOUT a principal — and was cached under
`component_owner-section_lang_labels|hides`:

1. no projects filter and no dd478 allow-list: a non-admin was offered, and
   shown the labels of, records outside their projects; the first caller's
   list was served to every other user;
2. no owner record: a `fixed_filter` of source `component_data` (install
   seed's Biographical milestone select; mdcat entry selects) read nothing,
   emitted no group, and every record was offered;
3. `properties.filtered_by_search` (mdcat check boxes) was not read;
4. `filter_by_list[].context.permissions` was a hard-coded `3`.

## Shape after (TS) = PHP get_list_of_values (class.component_common.php :2740-2877)

1. The enumeration is the real search with the request principal: projects
   filter (non-admins) and dd478 allow-list (admins too), exactly as PHP's
   `search::get_instance` (COMP-01). No principal (internal/system) stays
   unscoped. The root user record (-1) stays in the Users list for an unscoped
   or admin caller (PHP select edit `include_negative=true`); a non-admin gets
   the users-section rule, which excludes it.
2. A `component_data` fixed_filter reads its value from the RECORD the door
   serves (edit read, save echo: the saved record). No record (`section_id:
   null` — search panel, state widget, identify, a temporal record) narrows
   nothing, and neither does a record without a reference value (PHP parity).
3. With no fixed_filter group, `properties.filtered_by_search` is the option
   search's filter verbatim (PHP `elseif`).
4. `filter_by_list[].context.permissions` is the caller's real level on the
   field (PHP builds the context through the component instance).

Same keys, same item shape; only WHICH options appear changes.

## Divergences from PHP, stated

1. **The cache key is what the search selects, not the user.** PHP keyed by
   `logged_user_id()` + a hash of `sqo->filter ?? filtered_by_search…` — the
   resolved `fixed_filter` was NOT in its key (a cross-record collision PHP
   escaped only through its per-request cache clear, COMP-03). TS keys on the
   fingerprint of each target section's built option search (filter + ACL
   predicates, hop ACL included): records with the same reference value, and
   users with the same scope, share one list; nothing else does.
2. **The filter's own paths ride the read floor.** A reader with no grant on
   the filter component gets the narrowed list (the filter is server-authored
   ontology), where an unfloored search would refuse the leaf (an empty list).
3. **A stored value outside the caller's scope has no label** (the list value
   drops it, the edit datalist lacks it) — PHP's behaviour. A stricter edit UX
   (an opaque "restricted" entry) is an open owner decision, not implemented.

## Not covered

`properties.filtered_by_search_dynamic` (PHP `parse_search_dynamic`) is NOT
read — owner decision pending (port it, or declare it superseded by
`fixed_filter source:'component_data'`, its v7 translation on the shipped
nodes). No vendored v7 node carries it.
