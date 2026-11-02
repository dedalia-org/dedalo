# WC-2026-10-31-update-rung-above-code — the data-update door refuses a rung above the code's own data version

- **Date:** 2026-10-31.
- **Decision:** DEC-12 (gated: `test/unit/update_engine.test.ts` — "no rung above the code's own
  data version": the pure predicate, the refusal with nothing run or written, the ORDER (a rung
  above the code that also fails the validator and leaves a required box unchecked answers
  `rung_above_code`, and the run's log file is never created), the equal-version control, the
  `DEDALO_DATA_VERSION` default and its equal-version control — both built FROM the constant, so
  they hold across every data-version bump — and "no shipped door lifts the rung-above-code
  ceiling": every production caller of `updateVersion` — the `update_data_version` widget inline
  and as a background job, and the update run's data phase (`run/production.ts`
  `DATA_PHASE_DEPS.runRung`) — is driven with a catalog rung one medium above
  `DEDALO_DATA_VERSION` and must answer `rung_above_code` with no script run and no log opened,
  each against a control rung at the code version that passes the ceiling; an importer census
  (Bun's transpiler, not a text match; each specifier resolved with `Bun.resolveSync` as the
  runtime resolves it, so an extension-less / `.js` / absolute spelling still counts) pins those
  doors as the only importers of `engine.ts` under `src/`, `tools/`, `scripts/` and `install/`,
  save named non-door exemptions with a reason (`scripts/update_full_drill.ts`: opt-in drill on
  the marked suite DB, drives scratch rungs on purpose) — a stale exemption is red too; the
  same census function is run on a planted tree carrying every spelling, so a spelling it misses
  goes red).
- **Shape before (TS):** `update/engine.ts` `updateVersion` ran whatever rung the INSTALLED data
  version matched in the catalog (`getMatchedDescriptor`), whatever the running code's own data
  version. A build whose `DEDALO_DATA_VERSION` had not moved yet (an untagged nightly / dev build
  of the next release, whose catalog already lists that release) could run the next release's
  rung: the installed data moved ABOVE the code serving it (`ahead`, `/health` red) and a data
  version was stamped that no build of that version ever ran.
- **Shape after (TS):** after matching the rung and BEFORE the preflight, the transaction or any
  statement and before the run's log file is opened, `updateVersion` throws `update.refused` (envelope v2, status per the registry; log
  coordinates `rule: 'rung_above_code'`, `target`, `code`) when the rung's target is above the
  code's own data version (`catalog.ts` `rungAboveCodeData`; the code version is
  `DEDALO_DATA_VERSION`, injectable only through the `UpdateEngineSeams.codeDataVersion` seam the
  gates and `scripts/update_full_drill.ts` use to drive scratch rungs; no shipped door may lift
  it, however a seams object reached the engine — gated by the door legs above, an outcome, not
  a census of how the key is spelled). Nothing runs, nothing is
  written. The `update_data_version` action answers that refusal where it would have run the
  rung. The panel's listing is unchanged.
- **Reason:** an installed data version ≥ X must mean that a build whose data version is ≥ X ran
  X's rung; the matcher alone cannot promise it, because the catalog travels with the code ahead
  of the version bump.
- **Gate reconciliation:** TS-only. The shipped catalog holds no data rung today (`7.0.1` has no
  data step), so no live response changes; the frozen store holds no update-engine interaction.
