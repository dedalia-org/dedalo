# WC-2026-11-22-start-component-lang — a COMPONENT page from `start` runs in its own element lang; section / area / menu pages keep the data lang

- **Date:** 2026-11-22 (T2 batch B9: T2-O15-4).
- **Decision:** T2-O15-4 (plan B9). Code: `src/core/api/handlers/dd_core_api.ts`
  (`pageElementLangs`, the `start` page context build).
- **Shape before (PHP):** `start` instantiated every page element with `DEDALO_DATA_LANG` and no
  nolan forcing; a component page element then resolved its own lang in the component class
  (non-translatable → lg-nolan).
- **Shape before (TS):** every page context was built with `lang` AND `langOverride` = the request
  data lang. A component deep link (`?tipo=<component>&section_tipo=…&id=…`) was therefore stamped
  with the data lang even when not translatable (a number rendered and saved under `lg-spa`), and
  the URL's `lang` was ignored.
- **Shape after (TS):** section / area / menu page elements unchanged (`lang` = `langOverride` =
  the request data lang — the client threads it into every child read/save). A COMPONENT page
  element gets no override: the validated URL `lang` (the locator's `lang` first, else `search_obj.lang`) rides as
  `requestedLang`, and the element's own lang law decides — translatable → the URL lang, else the
  data lang; non-translatable → `lg-nolan`; transliterable (`with_lang_versions`) → the URL lang,
  else its `lg-nolan` base. A URL lang that is not a language code (`isDiffusionLangCode`) is
  refused with `request.invalid_source`, never guessed; on a section page it is ignored, as before.
- **Client:** none — the client mounts the context `start` returns.
- **Gate reconciliation:** TS-only. `test/unit/start_deep_link_native.test.ts`: translatable
  (test52), non-translatable (test22), transliterable (test166) component links with and without a
  URL lang, the section page keeping the data lang, the malformed-lang refusal.
