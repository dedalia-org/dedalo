# WC-2026-11-09-export-relation-display — a plain relation column exports exactly its display

- **Date:** 2026-11-09 (owner decision D4 of the same day; amends
  WC-2026-11-09-export-frontier-fanout).
- **Decision:** DEC-12 (gated: `test/unit/export_relation_display_native.test.ts`; flipped cases in
  `test/unit/export_frontier_fanout_native.test.ts`).
- **Shape before (TS):** the export walk applied the frontier RECORD key to every record a relation
  column reaches, including the targets the host record's section read DISPLAYS for that column. A
  restricted user whose edit form shows a portal's rows (targets outside their projects, grant 0 on
  the target section — the read embeds them at the subdatum floor) got
  `perm.export_column_out_of_scope` exporting that same plain column.
- **Shape after (TS):**
  - a PLAIN relation column (a one-step declared path on the host section whose component stores
    relations) exports what the host record's section read shows for it: a record the read
    displays under the column is not a crossing for the record key, provided every component the
    walk reads there is one the read displayed AT THAT RECORD (or one that stores nothing there —
    the read emits no item for an empty relation, and reading an empty slot exports nothing;
    "stores nothing" is answered by the SAME reader the cell reads through,
    `component_data.ts readStoredComponentItems` — so a `component_alias` is empty only if its
    TARGET slot is, never by its own unused tipo), and
    every dataframe ENTRY it reads there as the frames' owner is one the read emitted there;
  - the display is the read's OWN answer — `security/host_component_read.ts hostColumnDisplay`:
    the host-component get_data admission (the column node of the host section's EDIT map, STEP 11
    gated) + the one get_data emission (`read.ts readComponentDataEmission`), paged to the end. A
    record is displayed when the read emitted an item AT it; a component when the read emitted it
    AT THAT RECORD (per record, never per section: a record shown in one position is not shown with
    a field the read shows only at its siblings — a self-referencing portal reached the same record
    again under another position); a frame when the read emitted that exact entry (slot, pair key,
    frame target) at its owner (a slot item lists only the frames of the main items the read
    shows). It is asked lazily (only after the record key refused), once per column per
    record; it never widens SEARCH or DIFFUSION;
  - beyond the display the full frontier law stands (record key + component key, THROW, column
    named): a declared path INTO the target (any hop, even to a displayed field), a record the read
    does not expand (e.g. a nested list cell's second target — list cells show their first page,
    and paging a nested cell is a get_data with the TARGET as host: refused by the read for a
    target outside the record scope / an ungranted section — `gateReadSource` perm.denied — so the
    screen never shows more of it and the export does not either),
    a component the read does not show there (a section map that injects a narrower child set than
    the component's own config), the WC-049 parents chain (even an ancestor displayed elsewhere),
    the `dedalo_raw` media walk, `dedalo_raw` itself, the no-children branch and the iri title
    frames (both crossed STRICT — the read expands no target there);
  - a run that CAPTURES media (every tool_export job: `export_job.ts` → `captureMedia: true`) keeps
    the carve-out in `value` / `grid_value`: capture only records the addresses the cell read, and
    the media ZIP re-authorizes every file as the job owner (`writers/media_zip.ts`,
    `principalCanAccessRecord` + component grant), so a displayed record outside the record scope
    contributes its value, never its file. (First cut excluded capture runs → D4 was off for every
    real export; live repro numisdata3 / numisdata30, user 1, `perm.export_column_out_of_scope`.)
  - a column the read does not show (grant 0 on it) has no display: Gate B refuses it, as before.
- **Reason:** an export of a column is a copy of what the user is shown; refusing it refused data
  the screen already discloses, while a narrower export would be a silently short cell.
- **Gate reconciliation:** TS-only. The parity tier runs as the admin (no frontier) — no fixture
  edit, no re-harvest. `export_frontier_fanout_native`'s depth 0/1/2 and frame-target REFUSES cases
  (records the plain column displays) now pin scoped == admin bytes AND that the scoped caller's
  own section read embeds the value under the column (`test/helpers/host_section_read.ts`).
