# WC-2026-11-12-diffusion-external-chain — publication columns that reach a `component_external` publish its remote values

- **Date:** 2026-11-12 (RC-closure T1-42 / audit O09; `src/diffusion/plan/compile.ts`,
  `src/diffusion/resolve/resolver.ts`, `src/diffusion/resolve/external_value.ts`,
  `src/core/components/registry.ts storesRelationLocators`,
  `src/core/components/component_external/value.ts` `DeriveExternalOptions.dataLang`).
- **Decision:** — (extends WC-2026-09-24-external-foreign-target-and-verbatim-id to the
  publication chain, addendum (d) there; specs: `engineering/EXTERNAL_SPEC.md` §3 addendum
  2026-11-12, `engineering/DIFFUSION_SPEC.md` §4). Owner decision T1-42 OD-1 (a degraded remote at
  publication time) is OPEN — the shape below is the engine's existing per-field-failure law, not
  a ruling.

## Shape before (PHP)

- `diffusion_chain_processor::resolve_ddo_value` instantiates the component WITHOUT checking the
  record exists and routes by `component_relation_common::get_components_with_relations()` —
  which does not list `component_external` — so a Zenon ddo is a TERMINAL:
  `component_common::get_diffusion_data` → `component_external::get_data()` →
  `load_data_from_remote()` in the session's `DEDALO_DATA_LANG`; one lang-null item per entry.
  v6 (`get_dato` / `get_valor` → `diffusion_sql::resolve_value`) published them too.
- A failed remote read published an empty value silently.
- `component_external extends component_common`: a field whose FIRST ddo is one falls back to
  `$diffusion_output_format` `string`, not the relation family's `json`.

## Shape before (TS)

- Compile routed every relation-column model as a `relation-hop`, `component_external`
  included (its `relation` column is inert, column-map parity only): the resolver read a stored
  locator bag no record holds → nothing.
- A locator to a remote-only record (a zenon1 id: no matrix row by construction) hit
  `target === null ? []`; its child ddos never ran.
- Net: every SQL/file column whose ddo_map reaches a component_external (shipped: rsc1194,
  rsc1195, rsc1196, rsc1201 — rsc368 → zenon4/5/9/6) published EMPTY, no error line.

## Shape after (TS)

- **Routing.** `storesRelationLocators(model)` (registry; relation column MINUS the `external`
  flat family) is the ONE predicate of both the export fan-out and the publication compile: a
  component_external ddo compiles to a `component` step; the output-format fallback follows the
  same predicate (`string`).
- **Terminal** (`external_value.ts externalPublicationAtoms`, before the fn door): derived through
  `deriveExternalValue` (ownership — a FOREIGN target yields nothing and asks nothing; fields_map;
  the facade; never throws) with the host row's `section_id` VERBATIM as remote id; one scalar
  atom per entry, lang `null`. Values + a status (`stale`, truncated `ok`) publish the values.
- **Placeholder walk.** A hop locator whose target has no matrix row is walked on the
  identity-only placeholder (`relation_core.ts externalTargetRecord`, the read path's record) when
  an applicable child is a component_external NOT foreign to that section (the read path's law:
  record absence + an owned derived child). Otherwise unchanged: a gone record contributes nothing.
- **Fetch lang.** ONE per run: the plan's main lang, else `DEDALO_DATA_LANG_DEFAULT` (the
  component_info law). DIVERGENCE: PHP used the triggering session's `DEDALO_DATA_LANG` — a run's
  output no longer depends on who triggered it nor on a detached job's ambient lang.
- **Batching.** Each hop fetches its owned external targets in ONE `fetchExternalRows` call
  (bounded concurrency, row cache, coalescing) parked on the run's emission (replaced per hop);
  any failure falls back per cell, never throws.
- **Degraded = loud.** DIVERGENCE: an EMPTY derivation in a missing-value state
  (`unavailable`, `timeout`, `circuit_open`, `disabled`, `misconfigured` — the export's
  MISSING_STATES; `not_found` is an answer) adds a run error line on the PUBLISHED record:
  `external_source:<state> <component tipo> <remote section>/<remote id>` (fieldId/columnName =
  the field). The row is still written; the field keeps every other locator's values (OD-1 open:
  withhold the row / fail the run are the alternatives).

## Reason

Published bibliography columns were empty on every install publishing rsc — the remote values
both PHP engines published. Nothing in the matrix is wrong: republishing the affected sections
restores the public tables (changelog `diffusion-zenon-values-published`).

## Gate reconciliation

- `test/unit/diffusion_external_chain_native.test.ts` (`zzdxt` situation + suite `test3` /
  `test215` / `test52`, rows primed through the facade, allowlist then emptied — no network):
  compile kind, remote-only locator, local row of the external section (stored + remote), foreign
  target (no value, no call, no line), merge field exact bytes in locator order, degraded id (other
  values kept + exact error line). RED on HEAD aba571cab9: 5 of 7 (compile `relation-hop`, empty
  columns, no line); the foreign / no-socket guards green on both.
- Review hardening (2026-11-13, T1-42 review): the no-socket guard counted only the PRIME's
  injected fetch (vacuous). The run's allowlist is now a METER (refuses every host, records each
  consultation — transport step 3, every door): live on the first run (the unprimed id), EMPTY on a
  second all-primed run. Both runs execute inside a request scope whose data lang is NOT the run's,
  and the terminal's per-cell fallback is driven directly from that scope: dropping the run fetch
  lang (prefetch, `externalPublicationAtoms`, or `fetchOwnRow`'s `dataLang`) goes RED. A field whose
  FIRST ddo is the component_external (no `output_format`) pins the `string` fallback (control:
  the first-ddo portal stays `json`) — reverting the compile predicate goes RED.
- No frozen parity fixture holds a diffusion Zenon column — no fixture edit, no re-harvest.
