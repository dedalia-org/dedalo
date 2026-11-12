# WC-049 — Export parents chain ACTIVATED: per-ddo `value_with_parents` → sibling `#parents` column (grid_value only) (2026-07-24)

The PHP export feature (`component_relation_common::get_export_value` parents
block + `get_locator_value show_parents`) that the TS rewrite carried as an
INERT flag is now implemented — with three deliberate divergences from PHP:

1. **Per-ddo ONLY.** The flag lives on the export column
   (`ar_ddo_to_export[].value_with_parents`, the per-column checkbox). The PHP
   request-global `options.value_with_parents` (the old global "Export parents"
   checkbox) is REMOVED from the client and IGNORED by the server
   (`compileExportPlan` reads only the ddo).
2. **grid_value format ONLY.** PHP also folded parents atoms into the flat
   `value` cells via `join_atoms`; TS `value`/`dedalo_raw` outputs are
   unchanged (`resolveValueCell` never reads the flag; the value-format label
   derivation calls `collectGridAtoms` with parents OFF).
3. **ONE pre-joined atom per locator.** PHP emitted one atom per ancestor and
   joined at tabulate time with the segment's `fields_separator (' > ')`; the
   TS tabulator's cell join is fixed `' | '`, so `atoms.ts
   resolveParentsChain` pre-joins the chain (`' > '`, nearest parent first,
   self excluded, empty terms dropped) into one atom. Same cell bytes.

Emission (atoms.ts): per relation locator, `getParentsRecursive` ×
`getTermByLocator(fromCache)` → an extra atom whose segment path appends
`{sub_id:'parents', section_tipo: target, component_tipo: relation tipo,
item_index: locator position}` — column key ends `#parents`, label leaf is the
verbatim `parents`, rows align with the locator's child atoms in every
breakdown. Both relation paths emit: the WC-008 compact portal cell (parents
segment unindexed, first segment carries the locator position) and the
request-config fan-out, where the flag inherits down EVERY relation level
(PHP `export_context::descend` parity). Targets without hierarchy (no
`component_relation_parent`, no parents) emit NOTHING — never an empty column.
Parents apply to the ddo's LEAF relation targets (+ nested fan-out levels),
not to intermediate DECLARED hops — a per-column flag names its own column.

Client gate (tools/tool_export): the per-column checkbox renders only for
models `component_portal | component_autocomplete | component_autocomplete_hi`
(the old broader relation-model set is retired) AND when the NEW
`tool_export.components_with_parent` action (`{components:[{tipo,
section_tipo}]} → {[tipo]: boolean}`, section read gate) confirms a
hierarchical target — targets resolve through the datalist's
request-config builder (explicit configs, hierarchy_types, 'self', implicit
ontology relations). Legacy presets carrying the global flag apply cleanly
(the key is ignored; per-ddo flags ride the preset's ddo list). The
`value_with_parents` tool label is now in register.json (was a hardcoded
English fallback).

**Fixture impact: NONE.** No tool_export oracle fixture carries
`value_with_parents` (the section-read `ddinfo` fixtures that do are a
different feature, untouched). The output only changes when the per-ddo flag
is sent — additive.

### Gate

`test/unit/tool_export_parents_native.test.ts` (test3 playground: scratch
27→2→1 chain + stamped lg-spa terms — compact + fan-out emission with key/
label/chain-order/cell bytes, per-ddo-only, grid_value-only, parent-less
emits nothing, `components_with_parent` truth table + invalid_request) ·
`diffusion_export_unified.test.ts` (protocol invariants with the flag on, both
formats).

## Addendum 2026-09-25 — the `value` format grows the parents column too; `dedalo_raw` disables the checkbox

Point 2 ("grid_value format ONLY") is REVISED. Users ticked the per-column
checkbox in the default `value` format and got the term alone: the flag
travelled intact (`compile_columns.ts` → `exportColumn.valueWithParents`) and
`value` silently ignored it. The PHP export did fold parents into `value`.

Now:

- **`value`** — when the ddo's flag is set AND its declared leaf is a stored
  relation (`atoms.ts fieldHasValueParents`: the same `isStoredRelationModel`
  test grid_value applies; a declared dataframe step never), grid.ts mints ONE
  sibling column right after the term column (sortKey `[ddo, 0]`) on every
  record: key `<top>#parents` (the `sub_id:'parents'` identity), path/label =
  the declared chain + the `parents` segment on the leaf → header
  `<column> | parents`, `cell_type` `text`, model `null` (as grid_value). The
  term cell is unchanged (no chain folded in — a deliberate divergence from
  PHP's flat join). The cell MIRRORS the term cell: it is built in the term
  cell's own fold (`atoms.ts resolveValueCellInScope` withParents →
  `ValueCells.parents`), with the SAME separators at the SAME levels (level 0
  `' | '`, deeper levels and the leaf's items the component's
  `fields_separator` — so a multi-hop path `portal → portal` gives term
  `Leaf C, Parent A | Leaf C` and parents `chain27, chain2 | chain27`). Each
  chain is the SAME `resolveParentsChain` grid_value uses, no second walk. At
  the leaf, each target contributes its chain ONCE PER PIECE its term text
  splits into on the leaf's item separator (a request_config
  `fields_separator` `' | '` over several show children — `A | 1 | B | 2` —
  gives `chainA | chainA | chainB | chainB`); a target whose term is EMPTY
  drops from both cells; a target without hierarchy leaves an EMPTY slot.
  Split both cells the same way and parents piece n is the chain of the record
  term piece n came from. Not representable: a separator INSIDE a chain term
  (same limit as the term cell). The cell is absent only when no piece has a
  chain (the column still exists). Unlike
  grid_value's fan-out, parents of nested request-config relations are not
  included (the flag names its own column's leaf). The column's `ar_labels`
  section label is the leaf's owner section (one column serves every target
  section — grid_value keys one column per target section).
- **`grid_value`** — unchanged.
- **`dedalo_raw`** — unchanged: stored data only, parents are derived, the
  server ignores the flag. The client now DISABLES the checkbox in that format
  with a visible *(not in Raw)* note (labels `parents_not_in_raw[_short]`),
  re-evaluated on every format change and after a preset restores its format;
  the ddo keeps its flag.

**Fixture impact: NONE.** No `get_export_grid` fixture carries the per-ddo
flag; with the flag off (or on a literal leaf) the output is byte-identical.
*Corrected 2026-09-26:* the two new labels DO touch a fixture — the frozen
`get_element_context` for `tool_export` — and are ledgered as an additive label
growth in `WC-2026-08-23-tool-export-register-labels` (addendum 2026-09-26),
absorbed by its `ADDED` set in `tool_element_context_differential`.

### Gate

`test/unit/tool_export_parents_native.test.ts` — the old "`value` never grows
parents" pin is REPLACED by: key/label/placement/cell per relation path
(compact portal + autocomplete fan-out), multi-item alignment with an empty
slot, the three alignment cases (multi-hop mirror at two and three steps, empty-term target dropped
from both cells, one chain per `' | '` piece of a target's text), two ddos each with their own column, all-parent-less → column present and
cell empty, flag-on vs flag-off identical modulo the parents columns, literal
leaf and flag-off byte identity. The `dedalo_raw` pin stays. Client:
`test_tool_export.js` 'TOOL_EXPORT PARENTS CHECKBOX (per data format)'.

## Addendum 2026-11-09 — every ancestor crosses the export frontier

`resolveParentsChain` takes the frontier's record key on each ancestor before resolving its term
(thesaurus tables stay exempt as globally visible). A hidden ancestor throws
`perm.export_column_out_of_scope` naming the column. Gate:
`test/unit/export_frontier_fanout_native.test.ts` (the PARENTS chain block). See
`WC-2026-11-09-export-frontier-fanout`.

## Addendum 2026-11-11 — the value-format mirror folds from the same atoms

The `value` format's `#parents` mirror is no longer built inside a second walker
(`resolveValueCellInScope` over `resolveRelationTargetValues`). It is folded from the same
`sub_id:'parents'` atoms the fan-out emits for grid_value (`join_atoms.ts
joinExportAtomsMirrored`): the term text is byte-identical to `joinExportAtoms` of the term atoms,
and at the declared leaf's fan-out level every record contributes its chain once per piece its
term text splits into on that level's record glue. No byte change is intended: the 2026-09-25
alignment rules (one chain per piece, empty-term target dropped from both cells, parent-less
target leaves an empty slot) hold. What the term cell itself contains now follows
`WC-2026-11-11-export-value-single-walker` (caller map, separators, PHP empty-slot rule), and the
mirror follows it. Gate: `test/unit/tool_export_parents_native.test.ts` unchanged and green.
