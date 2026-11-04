# WC-2026-11-04-ddo-self-first-level-only — `section_tipo: 'self'` below the first level is REFUSED with a typed notice; a ddo `section_tipo` may be a source array (owner decision (c))

- **Date:** 2026-11-04 (owner decision (c) of 2026-11-03; landed W1 —
  `src/core/relations/request_config/self_depth.ts`, `explicit.ts` `skipDeepSelfDdos` /
  `resolveDdoSectionTipo`; the ontology check `self_depth_check.ts`, W6).
- **Decision:** DEC-12. New notice code `ontology.ddo_self_refused`
  (`src/core/errors/registry.ts`). Canon: `engineering/RELATIONS_SPEC.md` §1 addendum.

## Shape before (PHP)

At level ≥ 2, `'self'` resolves to the CONFIG OWNER's targets (tch197 → rsc1389), so
`{tipo: rsc85, parent: rsc1400, section_tipo: 'self'}` matches nothing at rsc1400's target
(rsc197) and the name silently DISAPPEARS. (The TS engine before this change treated it as
a wildcard and showed it — neither was a definition anyone wrote on purpose.)
A ddo `section_tipo` was a tipo string or an array of tipo strings only.

## Shape after (TS)

- A ddo declaring `'self'` — any of its four spellings: `'self'`, `['self', …]`,
  `[{source:'self'}]`, `[{source:'section', value:['self', …]}]` — at depth ≥ 2 below its
  config owner is SKIPPED, and the response gains a notice:

  ```json
  {"code":"ontology.ddo_self_refused","label_key":"…","retryable":false,
   "details":{"owner":"tch197","ddo":"rsc85","parent":"rsc1400","depth":2,"more":0}}
  ```
  One notice per distinct (owner, ddo, parent), at most `SCALAR_BOUNDS.ddoMapWarnings`, the
  remainder counted in the last one's `more`. A first-level `'self'` is unchanged (the
  owner's targets). The owner is whichever element's config holds the map, a SECTION
  included: a section's own `section_list` / edit map (the column map a section read
  derives when the client sends no show — `section/read.ts` `readSectionRowsEmission`
  lifts the build's refusals onto the read's notices) answers the same notice with
  `owner` = the section. Only a door with no response to carry a notice (the Time Machine
  scope derivation, the caller-chain verifier, the area boot map, the context-only own
  config build) falls back to one bounded server log line.
- A ddo `section_tipo` may be the SQO source array (`[{value:[1], source:'hierarchy_types'}]`,
  `[{source:'section', value:[…]}]`, …), resolved by the SAME resolver as `sqo.section_tipo`;
  the processed ddo ships the resolved tipo list. A CLIENT-sent ddo is limited to the client
  grammar (plain strings, `{source:'self'}`, `{source:'section', value}`) — the
  ontology-only sources are dropped at stage 1 (`WC-2026-11-04-stage1-authorized-sqo-scrub`).
- The **ontology check** `ddo_self_depth` (a registered reconcile — maintenance → reconcile
  status, `scripts/reconcile.ts`) lists every installed definition with a level ≥ 2 `'self'`
  (the owner rule below; identical findings fold into one with every owner in `readers`);
  its apply is refused (the fix is a master-ontology edit). It measures depth exactly as the
  read does — parents verbatim (a ddo naming the list node itself as parent is an orphan for
  both), only the FIRST list node of each model under a parent by `order_number` (the one
  build.ts `findSectionListChild` swaps in; a later sibling is read by nobody, never
  listed), a component's list node owned by the component, a section_list whose
  SECTION keeps a direct request_config is scanned only for the config-less VIRTUAL
  sections that fall back to it, and a list node is measured from EVERY section that reads
  it, each as its own owner (a virtual reader V parses the real list node with
  `ownerTipo` = V: a chain rooted on the literal V tipo counts, one rooted on the literal
  real tipo is an orphan) — gated in
  `test/unit/nested_ddo_map_injection_native.test.ts` (*one rule, two consumers*).

## Reason

A refusal is the only honest answer: the definition is ambiguous, PHP's reading hides data
and the wildcard guesses. The notice and the check name it so the master ontology can be
corrected to an explicit section_tipo or a source array.

## Gate reconciliation

- `test/unit/ddo_self_depth.test.ts`, `test/unit/ddo_section_tipo_source_array.test.ts`,
  `test/unit/element_node_registry.test.ts` (*root map deep-self refusal*),
  `test/unit/nested_ddo_map_injection_native.test.ts` (*self (c)*: the read notice — a
  portal's map, a portal's section_list, a REAL section's own section_list and a virtual
  section's fallback list node, all on the response — the ontology check per reader and the
  registered reconcile),
  `test/unit/reconcile_registry_native.test.ts` (`ddo_self_depth` pair).
- Parity: no frozen fixture declares a depth-2 `'self'` that resolved data — no drift,
  nothing re-banked. **Re-harvest: none.**
