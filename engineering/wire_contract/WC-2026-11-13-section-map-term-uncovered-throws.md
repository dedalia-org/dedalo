# WC-2026-11-13-section-map-term-uncovered-throws — a section_map `term` part whose model has no flatValue facet, or that the flat reader cannot resolve, THROWS `engine.uncovered_scope` (before: a silent `''`)

- **Date:** 2026-11-13.
- **Decision:** owner ruling C37 (`T1_owner_decisions.md`, 2026-11-13; item
  T1-32 O1 ruled (a): throw — AGENTS.md "uncovered paths throw loudly").
  DEC-12 gate: `test/unit/term_resolver_model_flat_native.test.ts` T11
  (`getTermByLocator` / `getDdoValueByLocator` over a component_password term
  part → `engine.uncovered_scope` naming section / tipo / model; the covered
  literal part of the same record still resolves).
- Code: `src/core/ts_object/term_resolver.ts` `modelFlatFamily`,
  `modelFlatFragment`.

## Shape before (PHP)

`class.ts_term_resolver.php get_term_by_locator` called every term
component's `get_value()`; a model with no usable flat value rendered `''`
and the label silently lost that part. No PHP engine ever named the gap.

## Shape before (TS, T1-32 interim)

A term tipo whose model declares NO `flatValue` facet kept the pre-T1-32
literal read (string items only — usually `''`), and the flat reader's
`unresolved` notes (a nested model with no family, a cell it could not
resolve) were dropped. A misconfigured section_map produced blank or truncated
labels everywhere a locator pointing at that section is rendered (tree,
autocomplete chips, `get_section_terms`, export parents chains, diffusion
iconography), with nothing in any log.

## Shape after (TS)

- `getTermByLocator` / `getDdoValueByLocator`: a term (or caller ddo) tipo
  whose model has no `flatValue` facet → `DedaloError('engine.uncovered_scope')`,
  message `term resolver: section_map term <section>/<tipo> (<model>) has no
  flatValue facet …`, coordinates `{section_tipo, tipo}`. Thrown before any
  record is read (the cacheability check walks the term tipos first).
- A non-literal part whose flat read reports `unresolved` notes → the same
  code, message naming the notes (`… could not be resolved — unresolved: <note,
  …>`). A relation term whose targets resolve cleanly is unaffected; the term
  resolver's own cycle guard cuts A → B → A before the flat reader notes a
  cycle (T10 unchanged).
- The error reaches the wire through the ONE converter (ERRORS_SPEC): a tree
  / label / graph read of the misconfigured section fails loudly until the
  model gains a facet or the section_map stops naming it. No shipped ontology
  (7.0) names such a term — local configurations only.

## Reason

A blank label is indistinguishable from an empty record; a thrown
`engine.uncovered_scope` names the node to fix. "Never silently narrow scope"
is a hard rule of the engine, and a term resolver that returned `''` for a
model it cannot read was exactly that.

## Gate reconciliation

No frozen fixture names a facet-less term model — no fixture edit, no
re-harvest. `ts_term_resolver_native`, `section_terms_native`, `tags_info`
unchanged.
