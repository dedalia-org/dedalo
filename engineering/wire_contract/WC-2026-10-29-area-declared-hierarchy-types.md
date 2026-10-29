# WC-2026-10-29-area-declared-hierarchy-types — the tree read honours a request-declared typology narrowing

- **Date:** 2026-10-29 (tool_cataloging repair).
- **Decision:** DEC-12 (gated: `test/unit/area_typology_filter_native.test.ts`). Amends
  `WC-2026-08-14-thesaurus-picker-caller-declared`, which made `hierarchy_sections` /
  `hierarchy_terms` / `thesaurus_mode` server-derived: those three stay derived; this entry admits
  ONE request input beside them.
- **Shape before (PHP):** `dd_core_api` copied `rqo.source.properties.hierarchy_types` onto the
  area element; `area_thesaurus::get_hierarchy_sections` skipped every hierarchy whose typology id
  was not in the list (`!empty()` rule: an empty list is no filter). A tool's `tool_config.ddo_map`
  entry `{role:'area_thesaurus', properties:{hierarchy_types:[8]}}` therefore loaded only
  typology-8 thesauri.
- **Shape before (TS, until this entry):** `source.properties.hierarchy_types` was ignored; every
  active hierarchy was loaded, so the cataloguing tool showed every thesaurus.
- **Shape after (TS):** `readTreeArea` (`src/core/area/read.ts`) reads
  `source.properties.hierarchy_types` (a list of typology ids, or one id) for `area_thesaurus`
  only, and `readAreaHierarchyData` (`src/core/area/tree.ts`) drops a hierarchy of another
  typology BEFORE projection: it never reaches the payload, and `typologies` is rebuilt from the
  survivors. A non-empty list matching nothing loads nothing; an empty list is no narrowing (PHP
  rule). `area_ontology` ignores it.
- **Reason:** the value is NARROWING-ONLY — it can drop hierarchies, never add one, grant a mode,
  or bypass the per-hierarchy ACL loop that still runs after it — so it carries none of the
  authority objection §5.5 raises against client-declared `thesaurus_mode` / target lists. The
  client already sends it (`common.js` `create_source` → `source.properties = self.properties`),
  and the rqo is reused by refresh/search reads.
- **Gate reconciliation:** TS-native only. The frozen differentials send no `source.properties`
  (`area_hierarchy_differential` unchanged; its two banked reds are corpus-bound, per
  `engineering/parity_baseline.json`).
