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

## Correction, 2026-11-22 — scope-less callers DO see a change (T2 B10 review M3)

The sentence that closed the addendum above ("outside a request scope every
accessor answers the install default, so scope-less callers see no change") was
false, and is withdrawn. Outside a scope `currentApplicationLang()` answers
`config.menu.applicationLang` (the value the label sites read before — no
change there), but `currentDataLang()` answers **`DEDALO_DATA_LANG_DEFAULT`**
(`config.lang.dataLangDefault`, DATA-01), NOT the menu's `DATA_LANG` and not
whatever literal a site held. Where the two install values differ, every
data-lang default this batch moved changed for a scope-less caller too:

- **The stdio MCP server** (`src/ai/mcp/server.ts`) opens no request-lang scope:
  `list_sections` / `describe_section` labels, `read_record`, `search_section`
  and the link-target lang (`resolve_path`, `buildLlmMap`) default to
  `DATA_LANG_DEFAULT`; they were literal `lg-eng` (the labels briefly the
  interface lang between 364ec95baf and 413894b9c3) and, for `buildLlmMap`, the
  install `DATA_LANG`. A client that relied on English by omission sends `lang`.
  **Superseded 2026-11-22 (owner ruling R1):** the stdio server now opens a
  request-lang scope per tool call, seeded from its SERVICE ACCOUNT's langs
  through the ONE seed dispatch uses (`seedRequestLangs`,
  `core/resolve/request_lang.ts`; `serviceAccountLangs`, `ai/mcp/server.ts`).
  A web login stores no per-account preference (session lang columns start
  NULL), so the account is served the install MENU langs (`APPLICATION_LANG` /
  `DATA_LANG`) — what its fresh web session gets — not `DATA_LANG_DEFAULT`.
  Gate `mcp_stdio_request_lang_native` (isolated, `DATA_LANG` pinned apart
  from `DATA_LANG_DEFAULT`; describe_section over a real McpServer + client).
- **request_config `filter_by_list`** without a context `lang`, built outside a
  scope: literal `lg-spa` → `DATA_LANG_DEFAULT`.
- **Lang-less ORDER BY** a translatable column outside a scope: the install
  `DATA_LANG` → `DATA_LANG_DEFAULT`. The scope value is now also validated
  before it reaches the SQL text (`assertValidLang`, `order lang (request
  scope)` — review M5).
- **THES-06 (69a3d01dfc) — term_resolver hierarchy1 main lang and the
  indexation-grid fallback's first candidate**: `config.menu.dataLang` →
  `config.lang.dataLangDefault` for EVERY caller, in or out of a scope. These
  two are deliberately STATIC (owner ruling: install `DATA_LANG_DEFAULT`, v6
  `get_main_lang` / `$main_lang`); the hierarchy1 pick is cached per section
  tipo, so it must never follow a request lang. Gate
  `request_lang_static_default_native` (isolated, `DATA_LANG` pinned apart from
  `DATA_LANG_DEFAULT`): two request data langs, both apart from either install
  value, get the same `DATA_LANG_DEFAULT` pick, in both cache-fill orders.
- **Object identification** (review M2): `find_matches`, the clusterer's
  criteria leg and the proposer's structural leg resolved criterion values with
  no lang — path_read's `DATA_LANG_DEFAULT` — under every request; they now
  thread the request data lang (`tool_identify` cluster: the client's `lang`,
  else `currentDataLang()`). Scope-less callers keep `DATA_LANG_DEFAULT`.

`config.lang.dataLangDefault` is itself now a rule-1 read of
`request_lang_law_tripwire`: every remaining site names why it wants the static
value with a `lang-law-exempt` marker.
