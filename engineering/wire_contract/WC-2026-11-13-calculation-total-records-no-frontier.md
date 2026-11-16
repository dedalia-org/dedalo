# WC-2026-11-13-calculation-total-records-no-frontier — a calculation totals EVERY record its inputs reach; no per-target frontier check

- **Date:** 2026-11-13.
- **Decision:** owner ruling C7 (`T1_owner_decisions.md`, 2026-11-13; item T1-1
  OD-3): "NO per-target permission check — a calculation is over the TOTAL
  records regardless of the reader's grants (e.g. mean diameter of a type = all
  coins). Keep shipped; document as deliberate." A frontier-law EXEMPTION, named
  in code at `src/core/components/calculation_data.ts` `calculationReader`.
  DEC-12 gate: `test/unit/calculation_widget_native.test.ts` C7 (positive pin +
  the control that the same principal's section read does NOT see the targets).

## Shape (PHP = TS, unchanged)

`component_calculation` (a `component_info` alias) walks its relation inputs'
`ddo_map` from the host record to the target records and reads the leaf values
AS STORED (PHP `get_calculation_data` → `component_common::get_instance(…)->get_dato()`;
TS `readStoredComponentData` / `memoizedReadMatrixRecord`), then runs the
`process.fn`. No target is filtered by the reader's projects or component
grants. The result is ONE number per record, the same for every reader who may
see the component_info that displays it.

## What IS gated

The reader's access is decided ONCE, at the component that displays the result:
the section read's component grants and record scope, and the widget-data read
door (`WC-2026-11-10-widget-data-read-door`: section read + the info component
read + the record in the user's scope). A reader who may not see the info
component sees no total. A reader who may sees THE total.

## Why this is deliberate and not a leak

A total filtered by the reader's grants is a different number per reader, each
called "the total": the mean diameter of a coin type computed over the coins
one editor may edit is not the type's mean diameter. The calculation states a
fact about the whole set the ontology declares; the only honest alternatives
are the whole set or nothing, and nothing is already what a reader without the
component grant gets. What the walk discloses is the aggregate, never a target
record's values or identity.

## Gate reconciliation

Positive pin, no divergence: a project-scoped principal (the export-frontier
identity's scoped user, MY project) totals two targets in the OTHER project
(2 + 5 = 7) exactly as the admin does, while its own section read of a target
carries no value. No frozen fixture involved.
