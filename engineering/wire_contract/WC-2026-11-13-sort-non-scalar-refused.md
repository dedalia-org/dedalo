# WC-2026-11-13-sort-non-scalar-refused — an ORDER BY a model with no scalar sort key, or a secret, is REFUSED (`search.invalid_sqo`); PHP sorted it by NULL

- **Date:** 2026-11-13.
- **Decision:** owner ruling C39 (`T1_owner_decisions.md`, 2026-11-13; item
  T1-33 §7.2): "refuse loudly (closes the password oracle)". DEC-12 gates:
  `test/unit/search_order_lang_less_native.test.ts` (order by a
  component_password → `search.invalid_sqo`; by a component_iri →
  `search.invalid_sqo`; number / json / input_text unchanged),
  `test/unit/descriptor_completeness_tripwire.test.ts` (the `sortable: false`
  set = PHP's get_sortable oracle + this entry's three models).
- Code: `src/core/search/sql_assembler.ts` `assertSortableModel`;
  descriptors `component_password`, `component_iri`, `component_filter_records`
  (`sortable: false`).

## Shape before (PHP)

`trait.search_component_common.php build_order_select` ran for EVERY model: a
family whose items hold no `.value` scalar — component_iri (`{iri, title}`
frames), component_geolocation, the media models (`files_info`),
component_info (widget outputs), component_security_access /
component_filter_records (the ACL document) — produced a NULL sort key on
every row, so the ORDER BY silently collapsed to the section_id tiebreaker.
component_password (lang-sliced, a `.value` HASH) sorted by its stored value:
the relative order of rows was a comparison oracle over the hashes, reachable
through any API sqo naming the tipo. PHP's `get_sortable()` hid the affordance
for media / info / geolocation / security_access / relation_children / index
only; component_iri's list column WAS offered sortable (and sorted by NULL).

## Shape after (TS)

1. An order path whose last step names a component whose descriptor says
   `sortable: false` is REFUSED before any SQL is built:
   `DedaloError('search.invalid_sqo')`, message naming the tipo and model,
   public message "This field cannot be used to sort the results". Never a
   silent NULL sort, never a dropped entry.
2. The `sortable: false` set is PHP's (3d, av, image, pdf, svg, geolocation,
   info, security_access, relation_children, relation_index) PLUS
   component_password, component_iri and component_filter_records. The list
   header therefore offers no sort on those columns either (structure-context
   `sortable`) — the affordance and the refusal are one answer.
3. Every sortable model is untouched (number: WC-2026-11-13-number-sort-numeric;
   json, the string family, date, section_id).

## Divergences from PHP (deliberate)

- **component_iri list columns lose the sort arrow.** PHP offered it and the
  click did nothing (NULL key). Nothing a user could sort by is gone.
- **An API / MCP sqo ordering by one of these tipos fails** where PHP answered
  the unsorted page. The password case is the point: the ordering oracle is
  closed.

## Gate reconciliation

No frozen fixture orders by any of these models, and the
`list_column_sortable_differential` fixture holds no iri / password /
filter_records column — no fixture edit, no re-harvest.
