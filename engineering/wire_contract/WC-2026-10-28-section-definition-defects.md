# WC-2026-10-28-section-definition-defects — label nodes never list columns; a non-record section table is `ontology.invalid_node`

- **Date:** 2026-10-28 (feature crawl #3 and #4: the dd1500 / dd1560 lists and the rsc370 list
  failed to open on the suite DB).
- **Decision:** DEC-12 (gated: `test/unit/section_definition_defects_native.test.ts`).
- **Shape before (TS):**
  1. A `section_list` relation naming a model=`label` node (dd1559 → dd1478; dd1561 → dd1478,
     dd1543) became an implicit list ddo (`model:'label'`), and resolving its column label hit the
     label-node guard (owner decision 2026-10-12: label nodes are inert): `read` answered
     `internal.invariant` on a dev/test server; production logged once and emitted a blank
     `label`-model column no client module renders.
  2. A section whose `matrix_table` relation names a table outside the v7 record set (rsc370 →
     dd489 `matrix_structurations`, a v6 table the upgrade never migrated and no v7 database
     holds): the search assembler's identifier gate threw `internal.invariant` (500).
- **Shape after (TS):**
  1. Label nodes are skipped by the implicit column builder like `exclude_elements` markers — no
     ddo, no context, no column. Every other non-component node keeps PHP's behaviour.
  2. The assembler (plain search + scoped-existence disjunct) throws `ontology.invalid_node` (503,
     "An ontology node definition is unusable") naming the section and the table; the client shows
     its error panel. `assertMatrixTable` stays behind it as the identifier gate.
- **Client:** none.
- **Reason:** an engine-bug code for a definition defect sends the operator looking in the wrong
  place; a label is a program string, never a column.
- **Ontology follow-up (master ontology, human):** rsc370 — DONE 2026-10-28 by the owner on the
  local and master ontologies (dd489 relation removed, node renamed `[DEPRECATED]`); the suite DB
  keeps the old relation until the vendored release (`install/import/ontology/`) is refreshed.
  Open: drop the label relations from dd1559 / dd1561 (now ignored by the engine).
- **Gate reconciliation:** TS-only. No parity fixture lists dd1500 / dd1560 / rsc370.
