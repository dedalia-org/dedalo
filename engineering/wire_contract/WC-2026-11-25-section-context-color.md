# WC-2026-11-25-section-context-color — the section context carries its own `color`

- **Date:** 2026-11-25.
- **Decision:** none (UI feature: section colour in list mode, user-approved mockup).
- **Shape before (PHP v6/v7):** the section's `properties.color` (ontology_node::get_color)
  reached the client only on the `component_section_id` context (`color`, with the
  `#b9b9b9` fallback — the edit Id band). The SECTION context carried it only by accident
  inside `properties`, and in list mode not at all: the emitted section properties are the
  `section_list` child's (SECTION_SPEC §7.1 swap).
- **Shape after (TS):** every section context entry (all modes, simple included) carries
  `color` = the section node's OWN explicit `properties.color` (trimmed, non-empty string),
  read from the node, never from the swapped properties. No fallback: a section without a
  colour emits no `color` key. Code: `src/core/section/context.ts` (`stampSectionContext`).
  The component_section_id `color` is unchanged.
- **Reason:** the list renders its Id column through `render_column_id`, not
  component_section_id, so the list had no way to know the section's identifying colour.
  `view_default_list_section.js` sets `.has_section_color` + `--section_color` on the
  list body; `page/css/layout/list.less` paints a 4px stripe on the Id column (desktop/print)
  or down each phone card's left edge.
- **Gate reconciliation:** additive key; the section-context parity gates compare field
  subsets (`context_differential`, `section_context_extras_differential`), so no gate
  changes and no fixture edit or re-harvest. Gate: `test/unit/section_context_color_native.test.ts`
  (list mode past the section_list swap, edit mode, no-colour → no key);
  client half: `client/dedalo/test/client/js/test_section_color_stripe.js` (`apply_section_color`
  + the real main.css on desktop and phone fixture frames).
