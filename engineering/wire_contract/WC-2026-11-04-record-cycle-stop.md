# WC-2026-11-04-record-cycle-stop — a record cycle stops on its path with a typed notice; a long chain stops at MAX_DDO_DEPTH softly (owner decision (e))

- **Date:** 2026-11-04 (owner decision (e) of 2026-11-03; landed W2 —
  `src/core/relations/element_node.ts` `occurrenceKey` / `recordCycleNotice` /
  `depthBoundNotice`, `models/portal.ts`).
- **Decision:** DEC-12. New notice codes `relation.record_cycle_stopped`,
  `relation.depth_bound_stopped` (`src/core/errors/registry.ts`).

## Shape before (PHP)

`get_subdatum` has no cycle guard: record A's portal → B, B's portal → A recurses until
memory runs out. (TS before: a whole-read 400 `request.invalid_rqo` at the depth bound, for
ordinary data.)

## Shape after (TS)

- A per-path occurrence guard on `(section_tipo, section_id, tipo)`: the repeated occurrence
  renders its own item WITHOUT its nested children, the rest of the read completes `ok`, and
  the response carries

  ```json
  {"code":"relation.record_cycle_stopped","details":{"tipo":"…","section_tipo":"…","section_id":"…","depth":2,"more":0}}
  ```
  A diamond (one record through two different paths) is not a cycle.
- `MAX_DDO_DEPTH` (12) stays the hard bound. An ONTOLOGY-driven chain (own configs, derived
  maps) stops softly at it with `relation.depth_bound_stopped` naming the element; a
  CLIENT-sent map past it is still refused loudly (`request.invalid_rqo`).

## Reason

Heritage data does contain reference cycles (a person and their spouse); a read must
terminate and say why a cell is cut.

## Gate reconciliation

`test/unit/nested_ddo_data_native.test.ts` *(d)*, *(e)*, *(i)*, *(m) diamond*, *(q)*;
`test/unit/element_node_registry.test.ts` (*notices*, *depth-bound notice*). Parity: no
frozen fixture holds a cycle — no drift. **Re-harvest: none.**
