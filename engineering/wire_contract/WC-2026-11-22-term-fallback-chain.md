# WC-2026-11-22-term-fallback-chain — one term fallback chain (lang → main → lg-nolan → project langs), every item of the lang, an `untranslated` flag for screens; tree group labels in the application lang

- **Date:** 2026-11-22 (T2 batch B6: THES-01, THES-02, THES-03, THES-06).
- **Decision:** T2 owner decisions §6 (THES-01/02/03/06); ruling T1-18 (a term
  carries no markup) for THES-02 / FYI-3. Code:
  `src/core/ts_object/term_resolver.ts` (`stringTermFragment`,
  `getTermTextByLocator`, `getTermByLocator`, `getDdoValueByLocator`),
  `src/core/ts_object/ts_object.ts` (term element, `getCountDataGroupBy`).
- **Shape before (PHP):** `component_string_common::get_value_with_fallback_from_data`
  read the requested lang, then the main lang, then lg-nolan, then every project
  lang (`common::get_ar_all_langs`), and wrapped a fallback in an inline
  `<mark>` when asked to decorate; `get_value` joined every item of the lang.
  Indexation group labels resolved in the request lang.
- **Shape before (TS):** two different chains for one question. The section_map
  term door (`getTermByLocator`) read lang → hierarchy main lang and STOPPED; the
  ddo door (`getDdoValueByLocator`, the model badge) read lang → main → lg-nolan →
  ANY non-empty lang. Both read only the FIRST item of the lang. The tree's term
  element used its own third chain (request lang → `DEDALO_DATA_LANG_DEFAULT` →
  lg-nolan → any non-empty, first item, `<mark>` on the fallback). Indexation group labels resolved in the
  install's structure lang (`ONTOLOGY_LABEL_FALLBACK_LANG`) whatever the request.
- **Shape after (TS):**
  - ONE law for a literal (string-family) term part, every door (section_map term,
    ddo label, tree term element, portal thesaurus label in `datalist.ts`): the
    part is EVERY non-empty item of its lang slice (the model's emptiness rule)
    joined with `' | '`. A TRANSLATABLE part with an empty slice falls back, first
    non-empty wins: requested lang → hierarchy main lang → lg-nolan → the project
    langs (`config.menu.projectsDefaultLangs`) in config order, and STOPS there — a
    value held only in a lang no project declares is not shown (the TS ddo door's
    "any non-empty" tail is gone). A NON-translatable part reads lg-nolan only
    (unchanged on both doors).
  - `getTermTextByLocator` returns `{text, untranslated}`; `untranslated` is true
    when any part came from the fallback. `getTermByLocator` (export, diffusion,
    RAG, datalist, every non-screen consumer) returns the TEXT only — never markup.
  - The tree term element (`dd_ts_api` node reads, tree search) wraps a flagged
    part in `<mark>` AFTER escaping (WC-2026-11-12-tree-term-escaped unchanged);
    the tree's fallback is now the chain above (the hierarchy's main lang, not
    `DEDALO_DATA_LANG_DEFAULT`; no any-non-empty tail).
    Wire shape of the element unchanged (`value` + `render_class:'html'`).
  - Indexation group labels (`count_result.totals_group[].label`) resolve in the
    request APPLICATION lang (`labelByTipo(key)`).
- **Reason:** one question ("what is this term called in lang X?") had three
  answers depending on the door, a second value in the lang was silently lost,
  and a screen could not tell a fallback from a translation without markup
  inside the text. The flag lets a screen decorate after escaping while every
  data consumer stays markup-free.
- **Consumer-visible changes:** a term with no value in the request lang, the main
  lang or lg-nolan now shows its first project-lang value (before: empty on the
  section_map door — including the tool_export thesaurus portal label of
  2026-10-29, which said "never translated"; toponymy still shows its main lang
  first). A value only in a non-project lang now shows nothing on the ddo door
  (before: shown). Two values in one lang show both, `A | B`.
- **Gate reconciliation:** native gates —
  `test/unit/term_resolver_model_flat_native.test.ts` (*the term string-fragment
  law*, `zztfl` situation: third-lang resolve + flag, `One | Two`, nolan, main
  wins, ddo door, tree `<mark>`, no markup through `getTermByLocator` /
  `resolveCellValue`), `test/unit/relation_index_config_native.test.ts` (group
  labels per application lang). Re-pinned to the new law (same day):
  `ts_term_resolver_native` (one chain; the non-project stop on a `lg-tlh` scratch
  row), `thesaurus_portal_label_lang_native` (project-lang rung + non-project
  stop), `ts_object_term_escape_native` (fallback record in a configured project
  lang). Parity: the tree gates (`ts_node_read_differential`,
  `ts_search_differential`) are already banked red in
  `engineering/parity_baseline.json`; no fixture edit, no re-harvest (the frozen
  store is read-only; the gates compare the emitted shape, which is unchanged).
