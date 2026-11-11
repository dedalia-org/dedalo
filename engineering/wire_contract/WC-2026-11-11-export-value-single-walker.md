# WC-2026-11-11-export-value-single-walker — the `value` format is a join over the grid_value atoms

- **Date:** 2026-11-11 (RC-closure item T0-9, audit OX1).
- **Decision:** owner decisions T0-9 D1, D2, D3, D5, D7 (2026-11-11); DEC-12 (gates in the same change).

## Shape before (PHP)

The PHP value format is not a resolver of its own: `export_value::join` folds the SAME atoms the
grid_value format emits (`get_export_value` → atoms → `join_atoms`). Its rules, which this entry
adopts:

- the caller's `ddo_map` is followed at every relation level (`get_export_ddo_descendants`);
- separators by precedence: caller ddo `fields_separator` / `records_separator` → the component's
  own `request_config` `show` → its `properties` → the defaults (`' | '` records at depth 0,
  `', '` fields);
- record dimension by segment `item_index`, field dimension by segment identity; the first indexed
  level joins its records with `records_separator`, every deeper one with the parent's
  `fields_separator`;
- leaf join per model: `component_input_text`, `component_date`, `component_iri` join their items
  with `records_separator ?? ' | '` (`component_input_text.php:58-74`,
  `component_date.php:266-282`, `component_iri.php:350-370`); every other leaf
  (`component_number`, `component_text_area`, `component_section_id`, …) with
  ddo → properties → `', '`;
- PHP `empty()` skips a leaf or field string that is `''` or `'0'`; a RECORD whose fields join to
  `''` keeps its slot (`export_value.php:356-358`), so a cell may read `x |  | y`;
- a config-less relation whose target has no component `relations` resolves no atoms (edit-mode
  `resolve_ar_related_edit`, `tool_export.php:751`);
- grid_value (`join_cell`, `export_tabulator.php:940-956`): several atoms in one cell join with the
  same `export_value::join` (the leaf separator), and an iri's value + title glue is
  ddo → properties → `', '`.

## Shape before (TS)

TWO walkers. grid_value walked `collectGridAtoms` (`fanOutRelation`, caller map threaded); the
value format and the WC-008 compact cell walked `resolve/relation_list.ts resolveCellValue` →
`resolveRelationTargetValues`, which:

- read every nested relation with its OWN `request_config`, never the caller's map
  (`numisdata9` → `numisdata164` exported seven fields of its own map instead of the one the
  caller declared);
- read `fields_separator` from the child's own `rc.show` only, never the caller ddo or
  `properties`; had no `records_separator` (level 0 hard `' | '`);
- dropped empty record buckets;
- had no flat family for eight relation models — `component_publication`, `component_filter`,
  `component_filter_master`, `component_select_lang`, `component_relation_parent`,
  `component_relation_children`, `component_relation_related`, `component_relation_index` — so
  their cells were `null` and the model went to `unresolved` (export value, relation_list panel,
  Referencias, related labels);
- found no children for `component_filter` (the edit form's `dd156` was unknown to the
  list/export derivation) nor for a config-less `component_relation_index`;
- read the stored slice of `component_relation_children` / `component_relation_index`, which store
  nothing (derived) → `[]`, in the value cell AND the grid_value leaf;
- stopped a fan-out at a fixed depth 12.

grid_value joined several atoms in one cell with a fixed `' | '`, and the iri glue was fixed.

## Shape after (TS)

ONE walker. The value cell and the WC-008 compact cell are folds of the grid_value atoms
(`src/diffusion/export/join_atoms.ts joinExportAtoms`, a byte port of `join_atoms`):

- **D1 — value = join(atoms).** `atoms.ts` emits the events → atoms; the value format joins
  them. Segments carry `fields_separator` / `records_separator` resolved caller ddo → own
  `rc.show` → `properties` (off the wire: `wireSegment` strips them from the protocol path). The
  caller's `ddo_map` is followed at every level. The media walk (value capture and the
  `dedalo_raw` media-only walk) is the same walk, so the same ddo reads the same files in every
  format (the old `walkMediaReads` mirror is retired).
- **Literal leaf separators** as PHP: input_text / date / iri → `records_separator ?? ' | '`;
  others → ddo → properties → `', '`.
- **D3 — PHP `empty()`**, `'0'` included, is skipped at the leaf and as a field string; an empty
  record keeps its slot (a value cell may now read `x |  | y`).
- **D2/D5 — eight models resolve** (descriptor `flatValue: 'datalist'` on all eight; a new
  `descriptor_completeness_tripwire` rule: every `column:'relation'` model except the external
  family and `component_dataframe` declares a flat family). Their children come from ONE seam,
  `src/core/relations/config_children.ts exportConfigChildren`, the edit form's own derivation:
  explicit `request_config` → per-locator (config-less `component_relation_index`: the pointing
  section's `component_section_id` + its related_list columns) → implicit
  (`request_config/implicit.ts`: `component_filter` → `dd156`; `component_filter_master` → its own
  ontology `relations`, D2 — the edit form's filter_master `dd156` override is dropped, so its edit
  columns follow too). Their locators come from ONE source,
  `src/core/relations/locator_source.ts`: stored slice, or COMPUTED for
  `component_relation_children` (inverse parent question) and `component_relation_index` (inverse
  index, unpaginated). `component_relation_related` reads its STORED slice (D4; the calculated
  relations are an opt-in sibling column, `WC-2026-11-11-export-related-references-column`).
  The interactive reader (`relation_list.ts`: panel, Referencias, related labels) consumes the same
  two seams, without a caller map (it has none).
- **No children → no atoms.** A config-less relation whose target has no component relations
  exports nothing (PHP edit-mode evidence), as before.
- **Cycle guard replaces depth 12.** The fan-out walks any depth and stops only when the same
  record × component is already on the current path, noted `relation_cycle:<tipo>` in
  `unresolved`.
- **D7 — grid_value cell join = PHP.** Several atoms in one grid_value cell join with
  `joinExportAtoms` (the leaf separator: `component_number` `', '`, `component_input_text`
  `' | '`, …) instead of a fixed `' | '`; an iri's value + title glue is ddo → properties → `', '`.
  grid_value bytes change for multi-item cells.

Unchanged: the frontier law (T0-1) applies to every new crossing (addendum to
`WC-2026-11-09-export-frontier-fanout`); `dedalo_raw` cells (stored value only).

## Reason

Owner decisions D1–D7: one walker, so the value and grid_value formats cannot disagree — the
two-walker design is how the caller map got lost. A column the user configured must export what
the configuration says, with its separators; a Projects / Publishable / Language / Parent /
Children / Related / Index column must not ship blank.

## Gate reconciliation

- `test/unit/tool_export_value_relation_native.test.ts` (new, suite DB, `test` TLD, records built
  at runtime): G1/G2 caller map + ddo/properties separators (G2b the D3 empty slot); G3 every
  model non-empty with `unresolved` free of it; G4 grid_value atoms for filter / relation_index /
  derived leaves; G5 value == join(grid atoms) per case (the one-walker invariant); the bare
  relation leg (no children → no atoms); D5 the interactive flat reader resolves the eight models;
  D7 grid_value cell join (number `', '`, input_text `' | '`) and the iri glue rungs (properties,
  default, caller ddo wins) in both formats and in the interactive reader; G6 a record reached only
  through the caller map crosses the frontier.
- `test/unit/descriptor_completeness_tripwire.test.ts`: G7, every relation-column model declares
  `flatValue`.
- `test/unit/relation_list_cell_families_native.test.ts`: `component_filter` (`test101`) now takes
  the children branch (`dd156`) and resolves `General project` instead of ledgering
  `component_filter`.
- `test/unit/tool_export_media_zip_native.test.ts`: the chain past the old depth-12 cap is walked
  whole (16 hops).
- Parity: the frozen `data_format:'value'` legs of `test/parity/tool_export_differential.test.ts`
  are already banked red in `engineering/parity_baseline.json` (corpus-bound) — no fixture edit, no
  re-harvest.

## Addendum 2026-11-11 — review round B: deliberate divergences named, PHP slots and cell join completed

- **D10 — config-less `component_relation_index`: a DELIBERATE divergence, not parity.** PHP
  `component_relation_index::resolve_export_ddo_children` (`:915-960`) builds
  `[section_id ddo, ...relation_list ddo_map]` but keeps as direct children only the ddos parented
  to the index — the `component_section_id` ddo — so PHP exported the pointing record's id ALONE.
  TS exports the id + the pointing section's relation_list columns: what the edit form shows (owner
  D10). The "per-locator … PHP" wording above describes the derivation's shape, not PHP's output.
- **D3 — the empty slot now fires where PHP's does.** A component the walk REACHES is an atom even
  when empty: a media leaf is ALWAYS one atom, `''` without a URL (`component_media_common.php:340-372`
  `from_scalar($path, '')`); a literal (`input_text`, `date`, …) one atom per stored item, an empty
  value included (`component_common.php:1919-1929`, `component_input_text.php:96-107`). A component
  with no stored item stays atom-less (PHP: no atom). Before, TS dropped `''` before an atom
  existed, so the records join lost the slot (`url1 | url3` for PHP's `url1 |  | url3`). Scope: the
  export leaf only (`CellValueResolveOptions.keepEmptyItems`, set by `atoms.ts` on its literal /
  media leaf); the interactive reader still drops empties. **grid_value bytes change:** the empty
  atom is placed (PHP `place_atom` registers its column and its item gives a row) — a target whose
  only shown component is empty now has its ROW (with no cell) in `rows` / `default` breakdowns,
  where it had none.
- **D7 completed — every grid_value cell joins.** The single-atom bypass is PHP's only:
  `join_cell` (`export_tabulator.php:940-956`) returns a lone `section_id` atom as is and sends
  everything else through `export_value::join` — so a lone `'0'` (or `''`) atom is an EMPTY cell
  (its column still minted). Before, any single atom was copied verbatim (`'0'`).
- **D11 — a ddo_map entry without `parent` is NOT a child** (PHP `$ddo->parent === $tipo`), one
  predicate for the export walk and the flat reader (`config_children.ts isDirectConfigChild`;
  `atoms.ts directChildrenOf` delegates to it). No byte change (the export already read it so).
- **D12 — a config-less `component_relation_parent` / `component_relation_children` keeps throwing
  `ontology.invalid_node`** naming the node (PHP: the v5 fallback refuses) — pinned, not softened.
- **Interactive reader (round A, the panel / Referencias / related labels):** implicit children
  (incl. a config-less index's per-locator relation_list columns) answer the edit form's STEP 5
  filter (`implicit.ts filterAuthorizedRelated`) for the ALS principal; and the flat reader got the
  export's cycle law — the same record × component again on the current path resolves to nothing,
  noted `relation_cycle:<tipo>` (records pointing at each other through relation_list index columns
  recursed without end).
- **Gates:** `tool_export_value_relation_native` D7 block — image-less target keeps its media slot
  (`url1 |  | url3`), empty input_text item keeps its slot (interactive still drops it), the grid
  row of the empty slot, lone `'0'` → empty cell / lone section_id kept, parent-less ddo not
  exported (value, grid, interactive), a real A→B→A cycle ends at `relation_cycle:<tipo>` with
  the partial value (value + grid_value); `relation_list_panel_scope_native` A1 (STEP 5), A2
  (cycle), A4 (D11), A5 (D12); `relation_list_cell_families_native` keeps the no-children datalist
  branch covered (`test70`); `tool_export_media_zip_native` R11 asserts hop 16 is reached (the
  chain's only media sits there).
