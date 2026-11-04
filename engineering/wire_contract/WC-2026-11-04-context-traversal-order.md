# WC-2026-11-04-context-traversal-order — every context door ships its entries in element-tree order, also on multi-row reads

- **Date:** 2026-11-04 (nested-ddo_map plan W3; `src/core/section/node_contexts.ts`
  `NodeContextSet.orderByTraversal`).
- **Decision:** DEC-12.

## Shape before (PHP)

`get_subdatum` appends an element's context, then its subcontexts, first-wins, while it walks
the ROWS: on a single-row read that is element-tree order (a column's subcontexts follow it,
before the next column); on a multi-row read it is ROW-MAJOR — a subcontext first met on row
3 lands after columns met on row 1.

## Shape after (TS)

Every door (section read, get_data, resolve_data, save echo, TM, relation_index) reorders its
entries into ELEMENT-TREE order: each column, then its subcontexts (recursively), then the
next column — the PHP single-row order, applied to every read. Membership and dedup are
unchanged; only the position of entries in `context[]` on a multi-row read can differ from
PHP's row-major order.

## Reason

The context is the client's column definition (`common.js` reads columns from it in order);
an order that depends on which row first holds a value made the column layout data-dependent.

## Gate reconciliation

`test/unit/nested_ddo_data_native.test.ts` — *section door ORDER (PHP traversal)*, *get_data
ORDER*, *TM column ORDER*, *order-independence*; `test/unit/node_context_set.test.ts`
*orderByTraversal*. Parity: the frozen multi-row reads compare contexts as KEYED sets
(order-insensitive gates) or are single-row — no drift, nothing re-banked.
**Re-harvest: none.**
