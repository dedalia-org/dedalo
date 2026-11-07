# WC-2026-11-07-area-css-list-mode — area models keep `context.css` in list mode (TS-only)

- **Date:** 2026-11-07 (TODO-080, ontology css review).
- **Shape before (PHP + TS):** `resolveEmittedPropertiesAndCss`
  (resolve/structure_context.ts) nulled the css of every model other than
  section/component_portal in list mode (PHP `remove_edit_css`,
  class.common.php:1823-1830). The menu opens areas in mode `list`
  (render_menu_tree.js), so an area's css never reached the client; and the
  client scoped it `.<section_tipo>_<tipo>.edit` while the wrapper carries
  `.list` — dead on both ends.
- **Shape after (TS):** `area` / `area_*` models are exempt from the list
  strip: their own css is emitted in every mode. The client
  (`ui.area.build_wrapper_edit`) scopes it by the wrapper's real mode
  (`.<section_tipo>_<tipo>.<mode>`) and applies it once (the duplicate
  `render_area.edit` block is gone).
- **Why:** an area has ONE render — `render_area.list` is an alias of `edit` —
  so "edit css must not leak into list" has nothing to protect for it.
- **Gate reconciliation:** no differential reds — the frozen fixture store holds
  no area context with a non-null css in list mode (area css was dead there
  too). TS ground truth: `test/unit/structure_context_css.test.ts` ("areas
  keep their css in list mode").
