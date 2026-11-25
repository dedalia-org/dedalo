# WC-2026-11-25-implicit-component-target-caller-section — an implicit component config whose relations name no section targets the caller's section

- **Date:** 2026-11-25 (T2-RC-3; held for master-ontology fix M2, which landed in the vendored
  7.0 release at fbbd8e9bd8).
- **Decision:** T2 owner table row T2-RC-3 (port; precedence = section node > model
  `targetSource` > caller's section; no descriptor default for `component_filter_master`, M2
  option a); DEC-12 (gated below).
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
    remains a TS divergence, not widened here.
- **Precondition (the former hold):** `dd170` (`component_filter_master`) related only `dd156`;
  under this rule it would have retargeted to the users section. The release relates it to
  `dd153` + `dd156`, so the walk's section node (dd153) wins. Mechanical:
  `test/unit/release_ontology_preconditions.test.ts` reads the vendored release off disk.
- **Reason:** a column map with no target section is unreadable; the caller's section is where
  every earlier engine read those columns.
- **Callers whose config changes** (measured 2026-11-25 on the development install, every
  component without `source.request_config` across its full ontology): ~45 nodes, all with
  relations naming sibling components and no section — mostly literal/media pairs
  (`component_text_area` ↔ image/av/pdf/geolocation), plus a few relation models
  (`component_autocomplete` / `component_autocomplete_hi`, one `component_portal`, one
  `component_relation_index` relating a matrix-table node). Each now targets its caller's
  section, as in PHP.
- **Gate reconciliation:** TS-native: `test/unit/request_config_implicit.test.ts` → "RC-3 — a
  component whose relations name no section targets the caller's section" (red before; the
  targetSource and no-graph scopes each mutation-checked). No frozen fixture changed
  (`request_config_differential` unchanged); no re-harvest.
