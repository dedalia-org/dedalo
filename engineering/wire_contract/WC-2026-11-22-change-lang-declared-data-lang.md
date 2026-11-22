# WC-2026-11-22-change-lang-declared-data-lang — `change_lang` refuses a data language the installation does not declare; sync copies only a data language

- **Date:** 2026-11-22 (T2 rulings review MED-3, following owner ruling R2: tool_identify
  `cluster` validates its lang against the installation's languages).
- **Decision:** review MED-3 — fix at the root. Gates: `test/unit/change_lang.test.ts` (undeclared
  data lang refused, session and cookie unchanged, declared control stored),
  `test/unit/change_lang_sync_native.test.ts` (isolated, `DATA_LANG_SYNC=true`),
  `test/unit/tool_identify_cluster_lang.test.ts` (omitted lang held to the same rule).
  Code: `src/core/section/record/save_component.ts` `assertInstalledDataLang` (THE membership rule
  for a caller-named data language), `src/core/api/handlers/dd_utils_api.ts` `change_lang` +
  `syncChangedLangs`, `tools/tool_identify/server/index.ts` `clusterLang`.
- **Shape before (PHP):** `dd_utils_api::change_lang` stored any language the menu posted into
  `$_SESSION['dedalo']['config']`; with `DEDALO_DATA_LANG_SYNC` a change of either language
  copied it into the other.
- **Shape before (TS):** the same, behind the lang GRAMMAR only (`isValidLang`): a grammar-valid
  code outside the installation's data languages was stored as the session data language, and
  under `DATA_LANG_SYNC` any interface language (an install may offer an interface in a language
  it does not catalogue in) became the session data language. Every later request then read and
  wrote in a slice no read resolves, and tool_identify `cluster` — which the client always sends
  `lang: self.lang`, the page data language — refused a language the session legitimately held.
- **Shape after (TS):**
  - `change_lang` with a `dedalo_data_lang` that is not a declared data language
    (`isInstalledDataLang`: `DEDALO_PROJECTS_DEFAULT_LANGS`, `DEDALO_DATA_LANG_DEFAULT`, their
    equivalence classes, `lg-nolan` — the write chokepoint's set, `src/config/data_langs.ts`) is
    refused `request.invalid_options` (public message `dedalo_data_lang '<code>' is not a data
    language of this installation`) before anything is stored: no session column, no
    `dedalo_lang` cookie — a mixed request stores neither half.
  - Under `DATA_LANG_SYNC`: an interface-language change drives the data language ONLY when that
    language is a declared data language; otherwise the data language is left unchanged (as
    requested, or untouched when none was). A data-language change drives the interface language
    ONLY when that language is one of `DEDALO_APPLICATION_LANGS` (re-review LOW-5 — symmetric);
    otherwise the interface language is left unchanged.
  - `change_lang` with a grammar-valid `dedalo_application_lang` that is not one of
    `DEDALO_APPLICATION_LANGS` is refused `request.invalid_options` (public message
    `dedalo_application_lang '<code>' is not an interface language of this installation`), nothing
    stored, no cookie (re-review LOW-5 — the same membership as the `dedalo_lang` cookie door,
    `isApplicationLang` in `src/core/resolve/request_lang.ts`; before: grammar only).
  - tool_identify `cluster`: the omitted-`lang` branch (the request's data language) is held to
    the same membership rule as a sent one — one rule, `assertInstalledDataLang`.
  - Grammar-invalid values keep their old treatment (ignored per field; none valid →
    `request.invalid_options` 'No valid language supplied').
- **Reason:** the session data language is every later request's read/write language; a code no
  read resolves must be refused where it is stored, not discovered later by each consumer.
- **Gate reconciliation:** no parity fixture covers `change_lang` with an undeclared data language
  or with sync on (the frozen store never exercised them); no fixture change, no re-harvest.
- **Changed since (re-review MED-1, 2026-11-22) — was "Not changed (owner question)":** a session
  that ALREADY stores an undeclared data language (stored before this change, or by any door that
  drifts from it) IS now neutralised on read: `seedRequestLangs` (`src/core/resolve/request_lang.ts`,
  the ONE request-lang seed) serves a stored session data language only when it is a declared data
  language (`INSTALLED_DATA_LANGS`, built by `declaredDataLangs` — the single source); otherwise the
  request runs on the menu data language (`config.menu.dataLang`, itself resolved inside the declared
  set). The stored column is left as is (not rewritten). And `login`'s adoption of the pre-auth
  `dedalo_lang` cookie under `DATA_LANG_SYNC` goes through the SAME `syncChangedLangs` rule — before,
  it copied any allowlisted interface language into the session data language. Gates:
  `test/unit/change_lang.test.ts` (stored undeclared → `page_globals.dedalo_data_lang` = menu data
  lang; declared control served as stored), `test/unit/change_lang_sync_native.test.ts` (login with
  an interface-only cookie → data lang untouched; data-language cookie → drives it; the child pins
  `DEDALO_APPLICATION_LANGS` with an interface-only `lg-zzzq`).
