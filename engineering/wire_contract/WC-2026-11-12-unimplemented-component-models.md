# WC-2026-11-12-unimplemented-component-models — a component model with no descriptor is never emitted: search-panel fields and implicit edit form, subtree included

- **Date:** 2026-11-12 (T1-27 / O07, RC-closure plan).
- **Decision:** DEC-12 (one predicate, gated in the same change).

## Shape before (PHP)

`common::$ar_temp_exclude_models` (`class.common.php:439-450`), a hand list of v5 models removed in
v6, was skipped by `get_section_elements_context` (:3897-3907; plus a `dd249` tipo skip, :3856);
`section::get_ar_recursive_children` additionally dropped the `component_semantic_node` SUBTREE by
default (`class.section.php:1073-1095`).

TS before: `get_section_elements_context` (`src/core/resolve/section_elements_context.ts`) emitted
ANY `component_*` model — `dd249` (`component_security_areas`) under `dd234`, `component_score`,
`component_ip`, … reached the search panel / tool_export / tool_update_cache field lists. The
implicit edit form (`buildImplicitSectionEditConfig`) skipped a 6-name hand copy
(`DEAD_LEGACY_MODELS`) that had drifted: it missed `component_semantic_node` and
`component_stats`, models the ontology carries and the engine never implemented.

## Shape after (TS)

ONE predicate, `isUnimplementedComponentModel(model)` (`src/core/ontology/resolver.ts`): a
`component_*` RUNTIME model (aliases already resolved by `getModelByTipo`) with no registered
descriptor. The component registry is the live model set (client modules ≡ descriptors), so the
rule cannot drift from the implementation. Both element walkers apply it and do NOT recurse into
the dropped node (the semantic_node subtree goes with it — PHP's recursive-children default):

- `get_section_elements_context` — not emitted, own elements AND the dd196 section-info tail;
  whatever `ar_components_exclude` says (also `[]`, the tool_update_cache shape).
- `buildImplicitSectionEditConfig` — no ddo.

The `dd249` result needs no tipo skip here: its model is the dead `component_security_areas`.
The relation-map `isNeverAColumn` dd249 rule is a different law and is unchanged. Stricter than
PHP only by the two never-ported models (no PHP install could render them either).

## Reason

The client dynamic-imports `client/dedalo/core/<model>/js/<model>.js` for every emitted entry; an
unimplemented model 404s and aborts the render (the edit form) or offers a field that cannot be
searched, exported or regenerated (the pickers).

## Gate reconciliation

No parity gate replays `get_section_elements_context` (its differential is retired) — no fixture
edit, no re-harvest. Gates: `test/unit/section_elements_context_native.test.ts` "unimplemented
component models" (situation `zzsec33`: security_areas, score, semantic_node + child, stats absent
from the panel — default and `[]` exclude — and from the implicit edit form; `dd234` without
`dd249`; outcome law: every emitted component model has a descriptor);
`test/unit/request_config_implicit.test.ts` (dd234 edit form).
