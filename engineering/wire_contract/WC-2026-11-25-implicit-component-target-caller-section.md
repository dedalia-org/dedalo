# WC-2026-11-25-implicit-component-target-caller-section — an implicit component config whose relations name no section targets the caller's section

- **Date:** 2026-11-25 (T2-RC-3; held for master-ontology fix M2, which landed in the vendored
  7.0 release at fbbd8e9bd8).
- **Decision:** T2 owner table row T2-RC-3 (port the PHP default as the LAST rung; no
  descriptor default for `component_filter_master`, M2 option a); DEC-12 (gated below). The
  real precedence: model `targetSource` (beats the walk since 2026-08-14, 169f6f2148 —
  hierarchy27) > the walk's `section` node / the list-mode main related section > the caller's
  section.
- **Shape before (TS):** `request_config/implicit.ts buildImplicitComponentListConfig` — a
  COMPONENT owner whose relation walk found no `section` node (and whose list-mode
  `section_list` fallback and model `targetSource` gave none either) kept a NULL target: the
  item carried `sqo.section_tipo: []` and ddos whose `section_tipo` was the caller's section only
  by the per-ddo fallback — a config with columns and nothing to read them from.
- **Shape before (PHP / v6):** `clean_and_extract_related` (frozen trait.request_config_v5.php
  :508-520; v6 :3844) starts from the CALLER's `section_tipo` and only a section node overwrites
  it, so the target is the caller's section.
- **Shape after (TS):** the PHP default, as the LAST rung. Every earlier rung is unchanged — the
  model's `targetSource` (which already overrides the walk's pick, 2026-08-14), a `section`
  relation node of the walk, the list-mode main related section — and all of them rank above
  the caller's own section (`context.ownerSectionTipo`), written to `sqo.section_tipo` and
  stamped on every ddo. Two scopes are deliberate:
  - a model that DECLARES a `targetSource` (today only `component_relation_model`) owns the
    answer even when it resolves none — it stays degraded-empty, never the caller's own
    thesaurus as its model list;
  - a node with NO relation graph (the walk produced no column) keeps the configless answer —
    no config, or the `component_relation_index` base item. PHP emitted a config there too; that
    remains a TS divergence, not widened here;
  - a `component_relation_index` never takes the caller rung: its `sqo.section_tipo` is the
    POINTING sections only, merged per read, never its own section
    (WC-2026-11-11-relation-index-related-list-context D2).
- **A `matrix_table` relation node is never a column** (same change): it is a storage pointer
  (which table holds the records), not a target — it does not even make a section virtual.
  Before, it was emitted as a junk ddo no client module renders, which also made a
  relation_index related only to a matrix_table node (e.g. `dd22`) look as if it had columns.
  No consumer read such a ddo: the principal-free walk's consumers (`implicitComponentChildren`
  → export / flat children) already kept only `component_*` links. **Shape change for a node
  whose ONLY non-section relation is a matrix_table node, any model:** it used to get one
  config whose `show.ddo_map` held that junk ddo and whose `sqo.section_tipo` was `[]`; it now
  has an empty ddo_map and no target, so it takes the configless answer — NO config for a
  non-index component (e.g. a `component_select` or `component_portal`), the base item (sqo
  `[]`, ddo_map `[]`) for a `component_relation_index`. A SECTION whose `section_list` names
  only a matrix_table node keeps itself as target (the section rung) with an empty ddo_map.
  A relation_index that declares a `section` relation node still targets that section — the
  exclusion covers only the caller rung.
- **Other doors that now see the caller's section** — every consumer of the same config
  (`getElementTargetSectionTipos` / `buildRequestConfigForElement`): the import conform target
  check (`tools/import_conform.ts`), the picker constraint (`relations/picker_constraint.ts
  resolveCallerTargets`), the datalist option and label configs (`relations/datalist.ts`), the
  `add_new_element` declared-target check (`relations/save.ts`) and the element context's
  `target_section_tipo` (`resolve/section_elements_context.ts`). For a sibling-only
  autocomplete / autocomplete_hi / portal node they resolve the caller's section where they
  resolved none — as in PHP.
- **Precondition (the former hold):** `dd170` (`component_filter_master`) related only `dd156`;
  under this rule it would have retargeted to the users section. The release relates it to
  `dd153` + `dd156`, so the walk's section node (dd153) wins. Mechanical:
  `test/unit/release_ontology_preconditions.test.ts` reads the vendored release off disk.
- **Reason:** a column map with no target section is unreadable; the caller's section is where
  every earlier engine read those columns.
- **Callers whose config changes** (measured 2026-11-25 on the development install, every
  component without `source.request_config` across its full ontology): 44 nodes, all with
  relations naming sibling components and no section — mostly literal/media pairs
  (`component_text_area` ↔ image/av/pdf/geolocation), plus a few relation models
  (`component_autocomplete` / `component_autocomplete_hi`, one `component_portal`). Each now
  targets its caller's section, as in PHP. (The one `component_relation_index` the first
  measure counted — related only to the matrix-table node `dd22` — is not among them: see the
  two exclusions above.)
- **Gate reconciliation:** TS-native: `test/unit/request_config_implicit.test.ts` → "RC-3 — a
  component whose relations name no section targets the caller's section" (red before; the
  targetSource, no-graph, relation_index, matrix_table, matrix_table-only and
  declared-section relation_index scopes each mutation-checked). No frozen fixture changed
  (`request_config_differential` unchanged); no re-harvest.
