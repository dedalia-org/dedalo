# WC-2026-11-21-ontology-alias-target-defects — OntologyState gains the alias-target warning channel

- **Date:** 2026-11-21 (T2-U04-b, commit 1f99a6bc77; entry written in the B3 review, M4). Landed
  in `src/core/ontology/ontology_state.ts` (`aliasTargetFindings`, `aliasTargetNote`), judged by
  `src/core/ontology/alias.ts` `isAliasWiredTargetModel` — the ONE alias-wiring law the read guard
  (`src/core/section/read.ts`) refuses by.
- **Decision:** DEC-12 — gated by `test/unit/alias_target_grammar_native.test.ts` → "T2-U04-b"
  (the law table, the vendored ontology census, and the health report on a scratch `zzatw` tld).

## Shape before (TS)

- `OntologyState` (the `inspect_ontologies` state of `tool_ontology_parser` —
  `{states: OntologyState[]}` — and the `state` of every `rebuildOntology` result) said nothing
  about a `component_alias` whose `alias_of` target has a model the alias engine cannot serve
  (e.g. a `component_select`): the node projected silently and every read of it was refused
  (`engine.uncovered_scope`) only when a user opened the form.
- PHP had no such report (the fossil is the absence).

## Shape after (TS)

- `OntologyState` gains two keys, a WARNING channel modelled on `modelRuleViolations`
  (WC-2026-11-11-ontology-model-rules), never a drift kind (`inSync` keeps its meaning — the
  projection matches its source; the source is wrong):
  - `aliasTargetDefectNodes: number` — own `component_alias` nodes whose target model is not
    alias-wired;
  - `aliasTargetDefects: {source, tipo, alias_of, targetModel}[]` — `source` =
    `<section_tipo>/<section_id>` (the alias record to fix), `targetModel` = the target's RUNTIME
    model (the one the engine would dispatch the alias as).
  - Silent about what the alias reader refuses itself: no `alias_of`, an unresolvable target, a
    target that is itself an alias (a non-grammar reference is an `invalidReferences` item).
  - The null-tld state carries `0` / `[]`.
- A successful rebuild's `msg` appends a capped note (same cap as the other notes):
  `— N component_alias node(s) point at a component whose model cannot be aliased; every read of
  them is refused (an ontology bug: fix alias_of in the master ontology): <source> <tipo> →
  <alias_of> (<targetModel>), …` — the per-tld line an ontology update reports.
- `dd_ontology` is UNCHANGED: projected exactly as the source declares.
- The tool's status panel does NOT render the channel yet (the keys ride the payload; the
  rebuild message carries the names) — a client rendering, like the model-rule one, is open.

## Reason

An alias whose target cannot be aliased is an ontology defect only the master ontology can fix;
the operator must learn it at the ontology update, not from a refused form.

## Gate reconciliation

No parity gate reads `OntologyState` (the `inspect_ontologies` / `regenerate` differentials
replay dd_ontology columns and tool envelopes that do not diff the state object), so no fixture
change and no re-harvest. Pinned by `alias_target_grammar_native` (the channel by source record,
only the defective alias named, `inSync` unaffected, the rebuild message naming the record and
"master ontology").
