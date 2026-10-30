# WC-050 — Observer cascade fires at the WRITE CHOKEPOINT (beyond-oracle broadening) (2026-07-24)

PHP fired `propagate_to_observers` only from the interactive component-save
controller. TS fires the same recompute law (`section/record/observers.ts`,
oracle-pinned byte shape) from `saveComponentData` POST-COMMIT — so EVERY
save door propagates (dispatch, `dedalo_data`/CSV import, MCP write tools,
transcription) — plus two doors that bypass the chokepoint: portal
`delete_locator` (recomputes the REMOVED locators' targets) and record
duplicate (recomputes the copied locators' targets AND the copy's own
observer-mirror slots). Deliberate divergences, all ADDITIVE (mirrors that
PHP left stale converge; no served byte shape changes): the per-write mirror
value equals what a PHP interactive re-save would have produced. Doors still
outside the cascade (`tool_propagate_component_data`, `delete_data` wipe,
`update/transform/portalize.ts`) heal via `scripts/observer_reconcile.ts`
(dry-run default; `--apply`; shrink-guarded inside the row lock).

### Gate

`test/unit/observer_native.test.ts` (dispatch door + both bypass doors,
oracle-captured mirror/relation_search goldens; suite-DB seeding via
`test/helpers/observer_term_seed.ts`) ·
`test/unit/observer_reconcile_native.test.ts` (bypass-drift dry-run/repair/
idempotence/shrink; planted-seed-gated so a live snapshot is never written).

## Addendum 2026-10-30 — phase notes: the copy laws, a derived edge and a read-door refresh

- The recompute law fired from the chokepoint now covers both PHP sub-laws
  (`WC-2026-10-30-observer-external-value-laws`), resolves targets through PHP's
  closed config switch including `use_inverse_relations`
  (`WC-2026-10-30-observer-target-resolvers`), and writes only on records whose section
  declares the observer (`WC-2026-10-30-observer-target-not-host`).
- One edge is now derived from a law rather than declared (`numisdata77 → numisdata679`,
  `WC-2026-10-30-observer-law-derived-edges`).
- One door outside the write chokepoint now recomputes a mirror on request: the
  portal's update-external read (`WC-2026-10-30-portal-get-data-external-refresh`). It
  is not a propagation of a write — it recomputes the one requested mirror from
  committed truth and hops only when it wrote.
- Duplicate now recomputes the copy's copy-law slots by declaration; the reconciler
  sweeps the copy laws at every declaring section.
