# WC-2026-11-09-export-frontier-fanout — the export frontier covers every crossing the walk makes, and refuses by the column

- **Date:** 2026-11-09 (T0-1 / S02; owner decisions D1–D3 of the same day).
- **Decision:** DEC-12 (gated: `test/unit/export_frontier_fanout_native.test.ts`,
  `test/unit/export_leaf_label_grant_native.test.ts`, `test/unit/frontier_class_native.test.ts`).
- **Shape before (TS):** the EXPORT law of `src/core/security/frontier_scope.ts` (THROW) guarded
  two crossings only — a declared ddo-path hop and a relation leaf's OWN targets
  (`resolver.ts assertExportCrossing`). Everything the walk reached beyond them was read with no
  principal: the `fanOutRelation` children at depth ≥ 1, the same chains in the VALUE format and
  the WC-008 compact cell (`relation_list.ts resolveCellValue` datalist recursion), dataframe
  FRAME targets, the WC-049 parents-chain ancestors, and the `dedalo_raw` media walk (files in the
  archive). A record outside the caller's projects two links away exported its value; the same
  record reached by a declared path refused. A refusal surfaced as a bare `perm.denied`.
- **Shape after (TS):**
  - every record the walk lands on — at any depth, in every format, frame targets, parents-chain
    ancestors, media-walk targets — takes the RECORD key (`exportCrossRecord` →
    `assertExportCrossing`); a refusal THROWS (D2);
  - a walk-time refusal surfaces as `perm.export_column_out_of_scope` (403, `details.column` = the
    declared column's labels, `' > '`-joined; `grid.ts columnNamedRefusal`). It names the column,
    never the hidden record or its section;
  - the COMPONENT key on children: an IMPLICIT child (no `request_config`; the label fields the
    ontology `relations` list) the caller holds no grant on is DROPPED from that cell and noted as a
    frontier refusal (D1: `exportImplicitChildren`; allowed pairs join `frontier_grants`). An
    EXPLICIT (curator-configured) child is read at the subdatum floor, as the edit form shows it
    (D3) — dataframes in an explicit map included; only their frame target RECORDS are keyed;
  - the external-record prefetch skips an implicit child the run would drop, so it fetches nothing
    the walk will not read;
  - global admins carry no frontier: byte-identical output.
- **Reason:** the export is the surface that leaves the system; it must disclose no more than the
  caller could open. A column-named refusal tells the user what to remove from the export without
  naming what is hidden.
- **Gate reconciliation:** TS-only. The parity breakdown differential runs as the admin
  (no frontier) — no fixture edit, no re-harvest. `frontier_class_native`'s EXPORT probe now pins
  the new code instead of `perm.denied`.

## Addendum 2026-11-09 — the display carve-out (owner decision D4)

A record a PLAIN relation column DISPLAYS (the host record's section read embeds it, for this
principal) is no longer a record-key crossing; every component read there must be one the read
shows. Everything beyond the display keeps this entry's law. See
WC-2026-11-09-export-relation-display.

## Addendum 2026-11-11 — new crossings of the single walker; the existence-only address (T0-9 D8)

`WC-2026-11-11-export-value-single-walker` adds crossings the walk did not make before. Each takes
this entry's law (`exportCrossRecord` per locator in `fanOutRelation`; implicit children keep
answering `frontierAllowedComponents`), in every format:

- `component_filter` → its projects (`dd153`, child `dd156`) and `component_filter_master` → its
  own `relations` children (implicit, tagged);
- a `component_relation_index`'s per-locator children (the pointing section's
  `component_section_id` + related_list columns, the columns tagged implicit);
- the COMPUTED locators of `component_relation_children` / `component_relation_index`
  (`locator_source.ts`), as hops and as leaves;
- the calculated relations of the `#references` column
  (`WC-2026-11-11-export-related-references-column`).

**D8 — the address of an unreadable pointer is displayed.** A `component_relation_index` pointer
whose pointing section the requester may not read (`pointingSectionReadable`, the edit form's
predicate) exports its ADDRESS only — `<section name> <section_id>` in the pointing section's
`component_section_id` segment (`atoms.ts emitExistenceAtom`), columns blank — in `value` and
`grid_value`. Its crossing is a narrow reach, `ExportCrossingReach.existenceOf = <index tipo>`
(`resolver.ts`): a record the record key refuses (other project) passes iff the host record's read
lists that pointer among the index's own entries (`host_component_read.ts
HostColumnDisplay.hasEntry`) — the edit form shows every pointer (D6). It admits no read: `reads`
and `frames` must be empty, or nothing is admitted. So such a pointer no longer refuses the column
(`perm.export_column_out_of_scope` is NOT thrown for it). The same-project case changed too: a
pointer the record key admits but whose section the requester cannot read used to export its bare
`section_id`; it now exports `<section name> <id>` like the other-project case. The media-only and
strict walks read nothing there and cross nothing (an address carries no file).

Gate: `test/unit/tool_export_value_relation_native.test.ts` — *D6 — … every pointer reaches every
reader; an unreadable section shows name + id* (the seam gives the address only; export `value` /
`grid_value` name + id, content blank, no refusal; the value cell bytes, admin full vs scoped
name + id); *G6* (a hidden target reached only through the caller map still crosses the frontier,
the strict media walk under the caller map refuses by the column, a hidden calculated target under
`#references` refuses by the column).
