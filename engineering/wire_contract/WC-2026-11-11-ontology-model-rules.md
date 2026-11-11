# WC-2026-11-11-ontology-model-rules — OntologyState gains the model-rule warning channel (component_iri is never translatable)

- **Date:** 2026-11-11 (owner decision of the same day: `component_iri` is ALWAYS
  non-translatable; a node saying otherwise is an ONTOLOGY bug fixed in the master ontology,
  never worked around by the engine). Landed in `src/core/ontology/model_rules.ts`,
  `src/core/ontology/ontology_state.ts`, `src/core/components/component_iri/descriptor.ts`
  (facet `ontologyTranslatable: false`), `src/core/ontology/resolver.ts`
  (`getComponentModelNodeRules`), `tools/tool_ontology_parser/js/render_tool_ontology_parser.js`.
- **Decision:** DEC-12 — the invariant is tripwired twice: at runtime by
  `test/unit/ontology_model_rules_native.test.ts`, before release by
  `test/unit/ontology_model_rules_shipped_tripwire.test.ts`.

## Shape before (TS)

- `OntologyState` (the `inspect_ontologies` state of `tool_ontology_parser`, and the `state`
  of every `rebuildOntology` result) carried no model-rule information. A `component_iri`
  node with `is_translatable = true` — ontology8 = yes, or ontology8 unset, which the parser
  reads as true — projected silently; the CSV import then saved plain IRI cells in the
  importer's language.
- PHP had no such report (the fossil is the absence).

## Shape after (TS)

- `OntologyState` gains two keys, a WARNING channel modelled on `tldlessRecords` /
  `machineNameDefects`, never a drift kind (`inSync` keeps its meaning — the projection DOES
  match its source; the source is wrong):
  - `modelRuleViolationNodes: number` — own nodes breaking at least one model rule;
  - `modelRuleViolations: {source, tipo, model, rule, translatableStated, message}[]` —
    `source` = `<section_tipo>/<section_id>`, `rule` = `'translatable_forbidden'` (the only
    kind today), `translatableStated: false` = ontology8 unset (default-true rule),
    `message` = the operator sentence (what, where, "set ontology8 to no in the master
    ontology; the engine does not override the flag").
  - The null-tld state carries `0` / `[]`.
- A successful rebuild's `msg` appends a capped note naming the violations — the per-tld
  line `ontology_update.ts deriveReport` reports after an ontology update.
- `dd_ontology.is_translatable` is UNCHANGED: projected exactly as the source declares.
- The tool's status panel renders the count + named tipos as a warning (`check warn` when
  in sync), label `model_rule_violations` (register.json, every seeded language), the full
  messages in the row's tooltip.

## Reason

An IRI has no language; per-language IRIs are language VERSIONS (always-on
`with_lang_versions`, base lg-nolan). A translatable iri node is a defect the operator can
only see if the health check says so, and only the master ontology can fix it.

## Gate reconciliation

No parity gate reads `OntologyState` (the `inspect_ontologies` / `regenerate` differentials
replay dd_ontology columns and tool envelopes that predate these keys and do not diff the
state object), so no fixture changes and no re-harvest. Pinned by
`test/unit/ontology_model_rules_native.test.ts` (the channel, the message, inSync
unaffected, the stored flag unchanged) and `test/unit/tool_ontology_parser.test.ts` (the
key the client reads).
