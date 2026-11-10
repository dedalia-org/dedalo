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
