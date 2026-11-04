# WC-2026-08-14-thesaurus-picker-caller-declared — the picker request declares its CALLER; the server derives the mode, the narrowing and the cap

- **Date:** 2026-08-14 (the relation `view: "tree"` → thesaurus picker landing; shipped with
  `src/core/area/read.ts`, `src/core/area/tree.ts`, `src/core/concepts/area.ts`,
  `src/core/relations/picker_constraint.ts`, and the client
  `core/area_thesaurus/js/thesaurus_picker{,_host}.js`).
- **Decision:** — (DEC-12 gates shipped with it, listed under *Gate reconciliation*.
  Canon: `engineering/AREA_SPEC.md` §5.7, which is the ONE definition of this contract.)

## The seam

A relation component whose ontology declares `properties.view: "tree"` opens the target
thesaurus as a PICKER: the tree renders a link affordance per term instead of navigating.
Whether a given area read is such a picker — and, if it is, WHICH hierarchies it may show
and HOW MANY terms may be linked — is a question about the CALLER component, and the area
read is a request about the AREA. Something has to carry the caller across that seam.

## Shape before (PHP)

The client declared its own conclusions. The page-context entry point folded four URL
variables — `thesaurus_mode`, `hierarchy_types`, `hierarchy_sections`, `hierarchy_terms` —
onto the PER-REQUEST page context object's properties, and the thesaurus controller
filtered its hierarchy list on the last two. The portal built those variables itself when
it opened the tree window, deciding client-side both that this was a picker and which
sections it was a picker over. The tree's response then carried the mode back:

```json
{ "typo": "context", "tipo": "dd100", "section_tipo": "dd100",
  "thesaurus_mode": "default", … }
```

A read that was not a picker (the only kind the frozen store contains) emitted
`"thesaurus_mode": "default"` and no other picker field. There was no per-term
selectability on the wire, no target narrowing derived from a caller, and no cap: the
`data_limit` refusal existed only in the renderer, as a `window.alert` fired AFTER the user
had committed to an add.

## Shape after (TS)

**The request names its caller, and nothing else.**

```json
"source": { "typo":"source", "model":"area_thesaurus", "tipo":"dd100",
            "section_tipo":"dd100", "action":"get_data", "mode":"list",
            "caller": { "section_tipo": "oh1", "section_id": 368, "tipo": "oh115" } }
```

`section_id` may arrive as the URL-shaped string; the server canonicalizes it. A present
but malformed `caller` is refused `400 read: source.caller is malformed`; a caller naming
an element the ontology does not define, or a section that holds no records, get their own
named 400s (`src/core/concepts/area.ts` owns all four strings, so gate and engine cannot
disagree about them). An ABSENT `caller` is an ordinary browse read, byte-unchanged.

**The server derives everything else.** Relation mode is granted only when the caller's
resolved `context.view === 'tree'`, its model stores in the relation column, and the
principal holds edit (`>= 2`) on it. Otherwise the read proceeds in `'default'` mode — the
picker intent is simply not granted, and no client string ever selects a code path.

The response gains two fields, both emitted ONLY in relation mode:

```json
"context": [ { …, "thesaurus_mode": "relation",
               "picker": { "selection_limit": 2, "remaining": 1, "targets": ["ds1"] } } ],
"data":    [ { "tipo":"dd100", "value": [ { …hierarchy…,
               "root_terms_selectable": [ {"section_tipo":"ds1","section_id":8,"selectable":true} ] } ] } ]
```

- `picker` is the `PickerConstraint` verbatim (`src/core/relations/picker_constraint.ts`),
  the SAME object the write chokepoint re-resolves before it persists. `selection_limit` is
  the caller's `properties.data_limit` — `null` = absent = uncapped, a literal `0` honoured
  as "none may be linked". `remaining` is `selection_limit − (locators already held)`, and
  it — never the raw limit — is what a picker session may add; it is deliberately NOT
  clamped at 0, because "over capacity by 2" is information. `targets` are the caller's
  resolved sqo sections, kept as DECLARED (see the matching note in `AREA_SPEC.md` §5.7).
- `root_terms_selectable` is the TERM's own answer (`isIndexable`), addressed by locator
  rather than by position. A non-selectable term still renders — visible and navigable,
  without a link affordance — because those are the structural levels one passes through to
  reach a leaf.

The hierarchy list is NARROWED to `targets` inside the projection loop, and the two empty
cases stop looking alike:

- every candidate dropped by a permission check → a thrown `perm.denied` (403) with the
  GENERIC registry message, naming no section (operator disclosure — a refusal cannot
  describe what the caller may not reach);
- dropped by the data-driven skips (no active hierarchy, none of them a target) →
  `409 read: no active hierarchy is configured for this component target`.

The two causes are counted separately at each drop site, never inferred from an empty
result.

**`hierarchy_types` needs no channel**: it is already the production expansion path for an
`{"source":"hierarchy_types"}` sqo, so the caller's own request config answers it.
**`hierarchy_terms` is deliberately NOT folded from the request**: the area node's own
`properties.hierarchy_terms` is a `HierarchyTerm[]`, while the client's URL variable of that
name is a fixed-filter shape — folding a variable nothing can read is banned, and per-caller
pinned terms, if ever wanted, are derived server-side from the caller's own fixed filter.

## Reason

Not "PHP mutated a cached ontology node" — it did not: PHP stamped a per-request context
object, and TS `structure_context` deep-clones its sources out of the resolver cache, so a
PHP-shaped stamp would be request-safe here too.

The reason is AUTHORITY. A client-declared `thesaurus_mode` + `hierarchy_sections` lets ANY
request open relation mode over ANY thesaurus with no caller that ever declared
`view: "tree"` — and it is a second derivation of the target that can disagree with
`WC-2026-08-14-relation-model-target-in-sqo`, whose whole point is that the resolved target
has one home. `src/core/area/read.ts` already makes exactly this objection about
`source.model` ("an unvalidated client model string must not choose server code paths").
Naming the caller instead is strictly less that the client can assert: it is an address the
server re-resolves, not a conclusion the server adopts.

The same argument decides where the CAP lives. The read path resolves
`selection_limit`/`remaining` for the picker's AFFORDANCES; the write path re-resolves them
for PERSISTENCE (`WC-2026-08-14-relation-insert-target-validation`). One resolver, two call
sites — so a stale or forged client cap changes nothing.

## What a consumer must expect

1. A read with no `source.caller` is unchanged in every byte, including
   `"thesaurus_mode": "default"`.
2. `context[0].picker` and `value[].root_terms_selectable` exist ONLY when the server
   granted relation mode. Absent is not "unknown": in default mode there is no picker.
3. A picker read can answer 403 (generic) or 409 (named) where the retired engine returned
   200 with an empty tree. The 409 is the whole point of the `dd560` correction: a
   `view:"tree"` node pointed at a non-thesaurus section is now LOUD instead of silent.
4. The client must not re-read `properties.data_limit`. `remaining` bounds what it offers;
   re-deriving the cap in the browser is a second authority that can disagree with the save.

## Gate reconciliation

- `test/unit/area_picker_mode_native.test.ts` — the derivation: the three conditions of the
  mode grant, the narrowing, the 403/409 split with both counters exercised, the emitted
  field names, the four named 400s, and a caller-LESS read of an empty tree still answering
  200.
- `test/unit/thesaurus_picker_tripwire.test.ts` — the mode has ONE derivation site and one
  client writer, and no client module mints a mode literal.
- `test/unit/area_hierarchy_pruning.test.ts`, `test/unit/authorization_denial_native.test.ts`
  — the pruning and the generic-message refusal contract this read reuses.
- `test/parity/area_hierarchy_differential.test.ts`,
  `test/parity/areas_differential.test.ts`,
  `test/parity/area_security_differential.test.ts`,
  `test/parity/ts_search_differential.test.ts` — the DEFAULT-mode shape, byte-unchanged.

**Re-harvest: NONE, and impossible by definition** (`engineering/ORACLE_HARVEST.md`). Two
facts make this precise, and both were measured on the frozen store:

- The four differentials above replay it CREDLESSLY by default (`oracleMode()` defaults to
  `'fixtures'` and `hasPhpCredentials()` then answers `fixturesAvailable()`), and their
  bodies pin `"thesaurus_mode": "default"` in six places. They WILL redden if the
  default-mode shape changes — which is exactly the assurance wanted here, and the reason
  every new field is emitted only in relation mode.
- `hashRequest` keys an interaction on the canonical, redacted rqo. Adding ANY `source`
  field to an already-replayed request is therefore a permanent fixture MISS that can never
  be re-harvested: the picker read has no oracle twin and never will, and its native gates
  are its only baseline. Measured: zero fixture requests carry `caller`, `thesaurus_mode` or
  `hierarchy_sections` (the `hierarchy_sections` occurrences in four relation fixtures are
  ontology properties inside response bodies).

## Addendum 2026-11-04 — the picker read follows the writer-chain scope

Superseded in part by `WC-2026-11-04-tree-picker-read-gate-retired` (owner decision (i)): a
hierarchy whose target section the principal holds no grant on is no longer pruned from a
picker read when the caller names its verified chain (`callers`) and holds WRITE on a
component whose effective config targets that thesaurus exactly; the tree is then served
read-only, every node gated by its own section. Without that scope the prune and the generic
`perm.denied` stand as described above. The mode grant, the narrowing, `picker` and
`root_terms_selectable` are unchanged.
