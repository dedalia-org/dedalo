# WC-2026-11-21-implicit-section-node-never-a-column — an implicit request_config never emits a section node as a column; the last one named is the target

- **Date:** 2026-11-21 (T2-RC-4).
- **Decision:** owner ruling T2-RC-4 / M3; DEC-12 (gated:
  `test/unit/request_config_implicit.test.ts` → "RC-4 — a section node is never a column; the
  LAST one is the target").
- **Shape before (TS):** the implicit walk (`request_config/implicit.ts implicitRelationWalk`)
  took the FIRST `section`-model relation node as the target and emitted every later one as a
  ddo of `show.ddo_map` (`model: 'section'`) — a column no client module renders.
- **Shape before (PHP):** every section node stripped; the LAST one is the target
  (`clean_and_extract_related`).
- **Shape after (TS):** every `section`-model relation node is stripped from the map and the LAST
  one is the target: `sqo.section_tipo` and every ddo's `section_tipo` name it. Component owners
  and section owners alike. For a SECTION owner (its `section_list` naming section nodes) this is
  the inherited rule, shipped until owner ruling M3b decides whether a section's own list may
  retarget at all.
- **Reason:** a section is where the columns live, not one of them; and a relation list that
  names two sections must resolve to the one every earlier engine resolved it to.
- **Gate reconciliation:** TS-native only. No frozen fixture holds a walk with two section nodes
  whose result changed (`request_config_differential` unchanged); no re-harvest, no fixture edit.
