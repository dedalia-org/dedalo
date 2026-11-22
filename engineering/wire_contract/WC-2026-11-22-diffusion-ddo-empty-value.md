# WC-2026-11-22-diffusion-ddo-empty-value — a relation hop's ddo `empty_value` publishes one placeholder per parent locator that resolved nothing; a ddo key the engine cannot honour refuses the compile

- **Date:** 2026-11-22 (T2 batch B8: DIF-2).
- **Decision:** T2-DIF-2 (port the ddo-level key). Owner side question M5 (restore
  `empty_value` on the migrated numisdata980/981 nodes) is the owner's follow-up on the master
  ontology. Code: `src/diffusion/plan/compile.ts` (`ddoEmptyValue`),
  `src/diffusion/resolve/resolver.ts` (`resolveHop`, `emptyValuePlaceholder`),
  `src/diffusion/plan/types.ts` (relation-hop `emptyValue`).
- **Shape before (PHP):** v6 `diffusion_sql::resolve_value` honoured `empty_value` in
  `process_dato_arguments`: an empty value for a source locator was replaced by the declared
  value and always stored, so every source kept its slot (a coin with no hoard published `"0"`).
  Frozen v7 moved it onto the ddo (`dd_object::$empty_value`, a list): in
  `diffusion_chain_processor::process_relation_component` a parent locator whose child ddos
  resolved nothing — or whose section no child ddo names — became a clone of that locator with
  `section_id` = the list's first element and `from_component_tipo` = the hop. TS before this
  entry never read the ddo key: the locator was dropped (its slot vanished).
- **Shape after (TS):** a relation-hop ddo's `empty_value` compiles onto the hop (`emptyValue`,
  the first element as a string). At run time, per parent locator: the child ddos applied and
  resolved nothing (an absent target record included), OR no child ddo names the locator's
  section → ONE placeholder chain atom `{section_tipo: <locator's>, section_id: <emptyValue>,
  from_component_tipo: <hop>}`, grouped with that locator. A locator dropped by the publication
  gate is still dropped (no placeholder) — as frozen v7. The field-level
  `process.empty_value` (whole-field fallback) is unchanged.
  Refused at compile, naming field + ddo: `empty_value` on a terminal (non-relation) component
  ddo — it has no locator to stand in for; a value that is not a non-empty list whose first
  element is a string or a number.
- **Reason:** per-item alignment is the contract of a multi-locator column — a consumer
  reading the n-th hoard id of the n-th coin needs every coin to keep its slot. Silently
  ignoring a declared ontology key looks green and publishes a misaligned list.
- **Gate reconciliation:** no parity gate covers the key (no harvested element carries it);
  no fixture edit, no re-harvest. New gate: `test/unit/diffusion_ddo_hop_native.test.ts`
  (zzdhp: three parent locators, one empty + one foreign → `"1","0","3","0"`; control without
  the key → `"1","3"`; refusals named).
