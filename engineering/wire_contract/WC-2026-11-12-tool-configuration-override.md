# WC-2026-11-12-tool-configuration-override — the tool configuration override reaches every element tool stamp

- **Date:** 2026-11-12.
- **Decision:** RC-closure T1-43 / audit O11 (owner ruling 2026-11-11: PORT the
  `tool_configuration` override, precedence configuration → register →
  ontology). DEC-12 gates: `test/unit/tool_configuration_override_native.test.ts`,
  `test/unit/indexation_grid_av_native.test.ts` (T1-43 leg).
- Code: `src/core/tools/config.ts` (`getToolConfigurationOverride`, the
  per-generation override index), `src/core/tools/section_tool_context.ts`
  (`resolveElementToolConfig` / `stampElementToolConfigs` — the ONE element
  stamp), consumed by `src/core/resolve/structure_context.ts`,
  `src/core/section/context.ts`, `src/core/section/buttons.ts`,
  `src/core/section/indexation_grid.ts`.
- Applies to the structure context of every component / area (non-list
  modes), every section (toolbar), every section `button_trigger` /
  `button_import`, and the indexation grid's tool cells.

## Shape before (TS)

`tools[n].tool_config` carried only the element's ontology
`properties.tool_config.<tool>` (enriched). A `properties.tool_config` array in a
Tools configuration record (dd996 / dd999) or a register default (dd1324 /
dd1633) was read by nothing — on installs that carry one (v6-migrated
configuration records) it had been inert since the move to v7. Section toolbar
tools carried no `tool_config` at all, not even the ontology's.

## Shape after (TS)

1. For an element (tipo, section_tipo) matched by a config entry
   `{tipo, section_tipo, ddo_map}`, `tools[n].tool_config.ddo_map` is that
   entry's `ddo_map` ('self' resolved, entries enriched with
   model/translatable/label). Only `ddo_map` is replaced; every other ontology
   key of the tool's config stays.
2. The enriched config is written back into the element's emitted
   `properties.tool_config.<tool>` ONLY when the ontology defined it (PHP mutates
   the shared properties object only then; an override-only config is a fresh
   object).
3. The override never makes a tool apply to a component / area / section. On a
   section button, a matching entry alone puts the tool in `tools` (PHP-exact).
   Button match key: (button tipo, section as called); 'self' resolves to the
   section.
4. Section toolbar tools now carry `tool_config` (ontology and/or override) —
   PHP `build_structure_context` ran the same stamp for sections. The PHP
   section-toolbar `properties.mode` filter is NOT part of this entry (still
   absent; ledgered separately).

## Divergences from PHP

- **Granularity (OWNER CONFIRMATION PENDING — T1-43 D1).** Implemented PER
  ENTRY: install match → register match → ontology, following
  `config.ts`'s per-key law. PHP `tool_common::get_config` picked the layer
  WHOLESALE: any dd996 record for the tool masked the register default, even
  one with no matching entry (or no config). The two differ only when a tool
  has both a dd996 record and a dd1324 override entry.
- Malformed entries (non-array `tool_config`, non-string tipo/section_tipo,
  non-array `ddo_map`) are skipped with a `console.error` naming tool, layer
  and position. PHP would have used a match without `ddo_map` as "no
  override" silently and crashed on a non-array.

## Not covered (stated, not silent)

- **Picker write gate (OWNER DECISION PENDING — T1-43 D2).**
  `src/core/relations/picker_constraint.ts` `toolDeclaredTargetIndex` (the
  write-door mirror of tool ddo_maps, WC-2026-08-14) still reads the ontology
  only. An override that points a picker tool (tool_indexation /
  tool_cataloging) at a section the ontology does not declare is offered in the
  UI and refused loudly `off_target` at the write door until the owner rules
  whether overrides widen that index.
- The menu and `start` section_tool flows do not consult the override (PHP did
  not either).
