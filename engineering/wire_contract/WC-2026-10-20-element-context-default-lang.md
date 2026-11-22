# WC-2026-10-20-element-context-default-lang — get_element_context's omitted lang is the request data lang

- **Date:** 2026-10-20 (tool_hierarchy "Name" read in Spanish under an English session).
- **Decision:** none (PHP parity restored; closes the coverage-plan §4.4 D9 known-open).
- **Shape before (PHP):** `dd_core_api::get_element_context` — `$lang = $source->lang ?? DEDALO_DATA_LANG`,
  the session's data lang.
- **Shape before (TS, until now):** `source.lang ?? 'lg-spa'` — an install literal. A request
  without `source.lang` got a context whose `lang` was `lg-spa` for every translatable element,
  whatever the user's data lang.
- **Shape after (TS):** `source.lang ?? currentDataLang()` — the request data lang
  (session override, else `config.menu.dataLang`). An explicit `source.lang` still wins.
  Response shape unchanged; only the `lang` value of a defaulted entry moves.
- **Reason:** the client's `get_instance` (`client/dedalo/core/common/js/instances.js`) builds a
  model-less component by calling this action WITHOUT `lang` and then adopts `context.lang` as the
  instance lang. With the literal, every translatable component instantiated by tipo alone
  (e.g. the `tool_hierarchy` form fields: `hierarchy5` Name) read and wrote the `lg-spa` slice.
- **Gate reconciliation:** `test/unit/get_element_context_native.test.ts` ("source.lang defaults to
  the request data lang…") pins all three lanes: install default, session override, explicit lang.
  No parity gate replays a lang-less `get_element_context` from the fixture store; no re-harvest.

## Addendum, 2026-11-22 — every remaining language default (T2 B10: O15-3, SL-2, OX7-1)

The same rule now holds at every door that defaulted a language, and it is one
tripwired law (`test/unit/request_lang_law_tripwire.test.ts`): request identity is
read from the request scope; a language is configuration, never a literal.

- **Area reads** (`area/read.ts`, maintenance / dashboard / tree; B9 O15-3a,
  038938d086): a missing `source.lang` = `currentDataLang()`, was literal `lg-spa`.
  Gate `area_read_default_lang_native`.
- **request_config `filter_by_list`** (`relations/request_config/explicit.ts`, O15-3b):
  a context without `lang` expands the search-panel field in `currentDataLang()`,
  was literal `lg-spa` — the field context's `lang` value moves. Gate
  `request_lang_law_native`.
- **Search ORDER BY** a translatable column without `lang` (SL-2): the request data
  lang, was the install `DATA_LANG` (a module constant) — the row order moves. Gate
  `search_order_lang_less_native`.
- **Labels** (OX7-1): tool_import_dedalo_csv, tool_posterframe, the ontology and
  thesaurus census picks, a new record's `data.label` and the login ddo `lang` speak
  `currentApplicationLang()`, were the install default; MCP tool defaults are the
  request langs, were literal `lg-eng`.

Response shapes unchanged; only the `lang` / label values of defaulted entries move.
Outside a request scope every accessor answers the install default, so scope-less
callers see no change.
