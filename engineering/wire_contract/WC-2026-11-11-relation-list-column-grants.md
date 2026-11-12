# WC-2026-11-11-relation-list-column-grants — the Referencias panel and related_search drop the relation_list columns the requester may not read

- **Date:** 2026-11-11 (follow-up to T0-9 round A, reviewer note).
- **Decision:** the edit form's STEP 5 rule (`filter_authorized_related`) applied to every reader
  of a pointing section's `relation_list` columns; DEC-12 (gate in the same change).

## What was wrong

The edit form's related_list (`section/related_list.ts sectionRelatedListConfig`, the
`component_relation_index` columns) drops a column the viewer holds no grant on. The two other
readers of the SAME section fact did not: the relation_list panel (`get_relation_list`,
`resolve/relation_list.ts buildRelationList`) and the related_search payload
(`resolve/related_sections.ts buildRelatedSections` — tool_transcription / tool_indexation
parent selects, the text_area persons modal, tool_tr_print) emitted every column of the pointing
section's `relation_list` and resolved its value, whatever the requester's grant on that
component. T0-9 round A had already filtered the CHILDREN under a relation column; the top-level
columns themselves were not.

## Shape before (PHP and TS)

PHP `relation_list::get_relation_list_obj` / `get_ar_data` (class.relation_list.php) built one
context entry and one value cell per relation_list tipo, unfiltered; only the panel as a whole
was gated (`relation_list_json.php`, `permissions > 0` on the host). TS copied that.

## Shape after (TS)

One helper, `resolve/relation_list.ts authorizedRelationListColumns(sectionTipo)`, used by both
readers: the declared columns (`getRelationListColumns`, principal-free) filtered by
`request_config/implicit.ts filterAuthorizedRelated` — the edit form's predicate (frontier
`frontierAllowedComponents` for the ALS principal, per call; no principal = internal resolution =
no filter). An ungranted column has **no context entry and no data cell**; the row (the `id`
cell / the referencing record) and every granted column are unchanged. A global admin / root
sees every column, so their payload is byte-identical to before. Deliberate tightening vs PHP.

## Gates

`test/unit/relation_list_panel_scope_native.test.ts` *A6* (suite DB, scratch TLD `zzpsc`): admin
and root see `[id, label, secret]`; a scoped persona without the secret grant sees
`[id, label]`, no cell, the secret value absent from the whole payload — for `buildRelationList`
and for `buildRelatedSections`.
