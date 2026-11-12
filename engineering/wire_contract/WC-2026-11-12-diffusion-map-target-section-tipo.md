# WC-2026-11-12-diffusion-map-target-section-tipo — `map_target_section_tipo` publishes the element's table name for the stored section

- **Date:** 2026-11-12 (RC-closure T1-5 / audit O09).
- **Decision:** DEC-12 (gates in the same change). No owner ruling needed for the
  departures below: each is the only reading that publishes a correct value on
  today's ontology.
- **Gates:** `test/unit/diffusion_target_section_tables.test.ts` (the map law, pure),
  `test/unit/diffusion_compile_degrade_native.test.ts` (fn dispatch + compile carries the
  map only when used), `test/unit/diffusion_plan_compile.test.ts` (zzdif: alias label in
  place, element scoping).

## Shape before

- **TS (2026-07-11 → this entry):** no branch — every published record of a table holding
  the fn (`hierarchy83` → `hierarchy53` in the default `oh` element `oh63`, table
  `hierarchy`) raised `diffusion.unported_fn`; the run reported "Partial success" and the
  column stayed empty.
- **Frozen PHP v7** (`diffusion_fn::map_target_section_tipo` :75-150): value = the
  component's value (a section tipo, e.g. `on1`); candidates = the element's REAL recursive
  ontology children whose first `section` relation equals it; name =
  `get_term_by_tipo(node)`; `*_alias` models first, else walk order. On today's ontology the
  oh table nodes carry no term (only `machine_name`), so the name was `null` → `''`.
- **v6** (`diffusion_sql::map_target_section_tipo` :3166-3245): table/table_alias children of
  the element's first database; tie-break `strcmp(table_name)`; name = the termino (which
  WAS the table name in v6).

## Shape after

- The map section tipo → table name is COMPILED into the plan
  (`PublicationPlan.targetSectionTables`, `virtual_tree.ts getTargetSectionTableNames`),
  present only when a field step uses the fn — every other plan is byte-equal. The resolver
  reads the first non-empty stored value and looks it up (own keys only); it never walks
  dd_ontology.
- The value is one lang-neutral scalar; no value / no table = no atom (empty column,
  PHP's null value).

### Deliberate departures from frozen PHP v7

1. **Name = the virtual-tree table LABEL** (the machine name every table plan publishes
   under), not `get_term`. Frozen v7 publishes `''` on every current ontology; v6 and the
   node's own `output_sample` (`ts_onomastic`) agree with the machine name.
2. **Candidates = the element's VIRTUAL tree**: a real table suppressed by an in-element
   alias is never named (it is not a table this element publishes), and an alias without its
   own section relation inherits the real node's — exactly the node set the publish path
   uses. Ownership = the nearest element in the parents path.
3. **Tie-break = walk order** among non-aliases (frozen v7), not v6's `strcmp`.

Note: a value naming a section the element publishes no table for (e.g. `es1` in the default
`oh`) is legitimately empty, not an error.
