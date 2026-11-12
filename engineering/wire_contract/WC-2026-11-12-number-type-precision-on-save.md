# WC-2026-11-12-number-type-precision-on-save — the server stores a `component_number` value formatted as its node declares

- **Date:** 2026-11-12 (RC-closure item T1-40, audits O06 / OX2).
- **Decision:** DEC-12 (gates in the same change). Write + import halves only: PHP
  `set_data` parity. The read half (PHP `get_data` cast) and the untyped-node default are
  OWNER DECISIONS still open — this entry does not presuppose either answer (see *Open*).

## Shape before (PHP)

`component_number::set_data` (frozen v7 `class.component_number.php:171-213`, v6 `:192-235`)
dropped a non-numeric item and passed every value through `set_format_form_type`
(`:258-307`): no `properties.type` → `(float)$v`, unrounded; `'int'` → `(int)` (truncation);
any other type → `round($v, $properties->precision ?? 2)` (half away from zero). `get_data`
applied the same cast on every read. A non-integer `precision` was a TypeError under
`strict_types`. Frozen v7 also nulled `"0"` / `0.0` through `empty()` — a regression vs v6,
whose `is_empty` kept them.

## Shape before (TS)

Only the client edit view formatted (`component_number.js get_format_number`). The save door
checked the value SHAPE (`value_shape.ts`: a finite number) and stored it as sent; MCP
`set_field`, the agent change-plan, CSV/RDF import, propagate and any API caller stored
`3.14159` on a `float/2` node and `3.7` on an `int` node. The import conform never cast a JSON
cell and never rounded a string cell. The tree's order read carried a second copy of the cast
(`node_repository.ts formatNumberValue`) that rounded with `toFixed` (1.005 → 1.00) and nulled
`'0'`.

## Shape after (TS)

- **One law**, `src/core/components/component_number/number_format.ts` (`numberFormatOf`,
  `formatNumber`, `formatNumberItems`): untyped (PHP `empty(type)`) → unchanged; `'int'` →
  `Math.trunc`; any other type (incl. the legacy object `{"float":2}`, whose inner number PHP
  never read) → DECIMAL round half away from zero to `precision ?? 2` (negative precision rounds
  the integer part; a value already within precision is returned bit for bit, so precision 16 is
  exact). No `-0`. `0` stays `0` (v6 semantics).
- **Save door:** `write_value_gates.ts applyWriteValueGates` formats every number item of every
  change (insert / update / set_data / import append), read off the DATA tipo (an alias writes
  with its target's format). The save echo (`result.data`) carries the stored value — the client
  shows what was stored.
- **Bad precision:** a typed node whose `precision` is not an integer refuses the save,
  `ontology.invalid_node`, naming the tipo; nothing is written. The import reports the cell as
  failed (`IGNORED: component_number '<tipo>': properties.precision must be an integer …`).
- **Import conform:** a string cell is parsed with the column's decimal separator and formatted;
  a JSON cell's items are cast and formatted — the preview is the stored value.
- **Tree order read:** `formatNumberValue` delegates to the same law: `'0'` → `0` (was null),
  `1.005` on float/2 → `1.01` (was 1).
- **Read side unchanged:** values already stored are served as stored (no `get_data` cast).
  The repair door for TS-era writes and for a changed `precision` is `tool_update_cache`
  regenerate, which re-saves through the door (gate D).

- **Refusal is lazy (addendum 2026-11-13, T1-40 review):** the format is resolved only when a
  finite number is about to be formatted (`NumberFormatSource` thunk). A clear (`{value:null}`
  slot, `set_data` null) on a bad-precision node saves (PHP `set_data` skipped the cast for
  empty data); an import JSON cell with no number conforms. **Read-path exception to "read
  side unchanged":** the tree order read (`node_repository.fetchNodeInfo` — behind ts_object
  node/children, tree search and `list_thesaurus` `is_indexable` portal reads) refuses
  `ontology.invalid_node` when a row of the group carries an order value to format on a
  bad-precision order node (PHP failed per formatted value; pre-d3458c26c9 TS coerced
  `Math.trunc('2')`); a group with no order value answers. Gate E
  (`component_number_format_native`).

## Reason

The ontology declares what a number field IS; storing whatever a non-client door sent made the
stored value depend on the door (an import and the edit view stored different numbers for the
same input), and search / diffusion / export all read the stored bytes.

## Gate reconciliation

`test/unit/component_number_format_native.test.ts` (A law, B save door, C import conform, D
update_cache repair, E lazy refusal: clear + tree order read) — red on HEAD 5756cb7aa3 for B/C/D; `test/unit/ts_tree_semantics.test.ts`
(tree order: `'0'` and `1.005`). No parity fixture is touched (no harvested gate saves a number
on a typed node); no re-harvest.

## Open (owner decisions, not presupposed here)

- **D1 read-side cast** — PHP `get_data` parity on every read door vs stored-canonical (this
  entry's current behaviour) vs `resolveComponentValue` only.
- **D2 untyped default** — stored as given (PHP code, current) vs the docs' old "float/2".
- **D3 repair** — operator `tool_update_cache` regenerate on typed-number sections vs a
  one-shot migration.
- **D4 read-side failure mode of a malformed number node** (tree order read) — refuse the group
  (current, PHP per-value parity) vs serve the value unformatted with a logged warning vs
  coerce a numeric-string precision.
