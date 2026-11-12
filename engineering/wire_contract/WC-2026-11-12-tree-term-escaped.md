# WC-2026-11-12-tree-term-escaped — a tree node's `term` value is escaped per piece before the `<mark>` wrap, and names `render_class:'html'`

- **Date:** 2026-11-12 (RC closure T1-18 / audit S14 record-fed sinks).
- **Decision:** owner ruling 2026-11-11 — a term may NOT carry markup; escape
  on the server before the `<mark>` untranslated wrap. Follows the
  render-boundary law of WC-2026-09-04-context-render-class (the server names
  the render class, the client renders through `render_value`).
- **Shape before (PHP + TS):** every tree door that builds nodes
  (`dd_ts_api.get_node_data` / `get_children_data`, tree search — area_thesaurus,
  area_ontology, the indexation and portal tree pickers) emitted
  `ar_elements[type='term'].value` as the RAW record text: the current-lang value
  verbatim, the lang fallback concatenated raw into `<mark>…</mark>`, composite
  pieces joined raw with `' '`. The client parsed it (`inner_html`) in both the
  thesaurus and the ontology branch of `render_ts_line.js`. The term is a
  `component_input_text` (render `text`), whose save does not sanitize, so
  `<img src=x onerror=…>` typed into a term ran for every viewer of the tree.
- **Shape after (TS):** `src/core/ts_object/ts_object.ts` `resolveElementValue`
  escapes EACH piece with the one server escaper (`escapeHtml`,
  `src/core/security/html_escape.ts`, ENT_QUOTES: `& < > " '`) before the
  `<mark>` wrap and before the join; the term element gains
  `render_class: 'html'` (additive — the value is server-built markup: escaped
  text plus the optional `<mark>`). Non-term elements carry no `render_class`.
  Caches above the emit (term resolver, fallback reads) keep raw text; escaping
  happens only at emit. The client renders `render_value(value,
  item.render_class)` (`render_ts_line.js`, both branches) — an absent class
  escapes; after an inline term save `ts_object.js` stores the new value back
  into `ar_elements` in the same wire form (`escape_html` + `render_class:'html'`).
- **Data already stored with markup** (PHP-era imports) now shows literally — the
  intended outcome of the ruling; nothing is rewritten, so no repair step. The
  vendored 7.0 ontology release was checked read-only: its tree `term` ddo_maps
  name `component_input_text` (20), `component_autocomplete_hi` (2) and
  `component_section_id` (1) — no `component_text_area` term whose rich text
  would now show its tags.
- **Gate reconciliation:** the parity gates carrying tree nodes
  (`ts_node_read_differential`, `ts_search_differential`) are already banked red
  in `engineering/parity_baseline.json`; the frozen store's `Serra de l'Espasa` /
  `Font de n'Horta` now emit `&#039;` — the reds stay red under the same names,
  no fixture edit. Gates: `test/unit/ts_object_term_escape_native.test.ts`
  (current-lang, fallback `<mark>`, composite piece, `render_class` presence,
  benign control), `client/dedalo/test/client/js/test_ts_object.js`
  (*Term text render class* — absent class escapes in both branches; `html`
  renders the `<mark>` only), `test/unit/render_escape_tripwire.test.ts`
  (`render_ts_line.js` leaves the remainder ratchet).
- **Same commit, no wire change:** the calculation widget renders its values and
  `label_before` as text (`render_calculation.js`; `CalculationValue` =
  number | date parts | null in `functions.ts`), gate
  `client/dedalo/test/client/js/test_widget_calculation.js`; `render_calculation.js`
  leaves the ratchet.
