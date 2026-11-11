# WC-2026-11-10-portal-get-data-children-lang — a portal's get_data resolves translatable columns in the data lang

- **Date:** 2026-11-10.
- **Before (PHP, and TS until now):** a direct `get_data` of a relation component
  (the client's portal paging and refresh read) is sent with the component's own
  lang, `lg-nolan`. The engine expanded the portal's columns in that lang, so every
  TRANSLATABLE column item came back `lang:'lg-nolan'`, `entries: []`, with all its
  values in `fallback_value`. The section read of the same portal resolves those
  columns in the request data lang, so the two reads disagreed. Visible effect: after a
  portal refresh (row edited in its own window, a page change), the client rendered
  every value as a fallback (`<mark>`), and multi-value cells lost their `, ` separators
  until a page reload.
- **Now:** `readComponentData`'s portal expansion passes `childrenLang` to
  `expandPortal`: the active data lang (`currentDataLang()`) when the read's lang is
  `lg-nolan`, else the read's own lang (an explicit translatable ask is kept). This is
  the rule the section read (`models/portal.ts`) and the `component_relation_index`
  get_data branch already applied. Non-translatable columns stay `lg-nolan` (the
  instance-lang rule), and the portal's own item is unchanged.
- **Client:** none. It already renders `entries` in the current lang.
- **Gates:** `test/unit/portal_list_cell_pagination_native.test.ts` ("portal get_data
  (the refresh read) — children lang", reverting the fix reds it);
  `test/unit/portal_edit_subdatum_native.test.ts` contracts b/d re-pinned (session
  data lang `lg-eng`: translatable children in `lg-eng` with their values; was
  `lg-nolan` + empty, the retired PHP differential's shape). Parity tier: same red set
  before and after (no frozen fixture pins this shape).
