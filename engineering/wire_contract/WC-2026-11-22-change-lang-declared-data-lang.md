# WC-2026-11-22-change-lang-declared-data-lang — `change_lang` refuses a data language the installation does not declare; sync copies only a data language

- **Date:** 2026-11-22 (T2 rulings review MED-3, following owner ruling R2: tool_identify
  `cluster` validates its lang against the installation's languages).
- **Decision:** review MED-3 — fix at the root. Gates: `test/unit/change_lang.test.ts` (undeclared
  data lang refused, session and cookie unchanged, declared control stored),
  `test/unit/change_lang_sync_native.test.ts` (isolated, `DEDALO_DATA_LANG_SYNC=true`),
  `test/unit/tool_identify_cluster_lang.test.ts` (omitted lang held to the same rule).
  Code: `src/core/section/record/save_component.ts` `assertInstalledDataLang` (THE membership rule
  for a caller-named data language), `src/core/api/handlers/dd_utils_api.ts` `change_lang` +
  `syncChangedLangs`, `tools/tool_identify/server/index.ts` `clusterLang`.
- **Shape before (PHP):** `dd_utils_api::change_lang` stored any language the menu posted into
  `$_SESSION['dedalo']['config']`; with `DEDALO_DATA_LANG_SYNC` a change of either language
  copied it into the other.
- **Shape before (TS):** the same, behind the lang GRAMMAR only (`isValidLang`): a grammar-valid
  code outside the installation's data languages was stored as the session data language, and
  under `DEDALO_DATA_LANG_SYNC` any interface language (an install may offer an interface in a language
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
  - Under `DEDALO_DATA_LANG_SYNC`: an interface-language change drives the data language ONLY when that
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
  `dedalo_lang` cookie under `DEDALO_DATA_LANG_SYNC` goes through the SAME `syncChangedLangs` rule — before,
  it copied any allowlisted interface language into the session data language. Gates:
  `test/unit/change_lang.test.ts` (stored undeclared → `page_globals.dedalo_data_lang` = menu data
  lang; declared control served as stored), `test/unit/change_lang_sync_native.test.ts` (login with
  an interface-only cookie → data lang untouched; data-language cookie → drives it; the child pins
  `DEDALO_APPLICATION_LANGS` with an interface-only `lg-zzzq`).

## Addendum 2026-11-22 — owner rulings 1, 2, 4

- **v6 sync + declared-set law (ruling 4).** `DEDALO_DATA_LANG_SYNC` (default `false`,
  `src/config/catalog/langs.ts`; off → the two languages are independent) keeps v6's DIRECTION
  exactly (v6 `dd_utils_api::change_lang`): an interface language sent drives the data language
  (a data language sent beside it is overruled, as in v6); else a data language sent drives the
  interface language. The declared-set law gates each COPY, never the side's own change: app → data
  only when the interface language is a choosable data language; data → app only when the data
  language is one of `DEDALO_APPLICATION_LANGS`. A skipped copy leaves that side as requested
  (unchanged when none was). `syncChangedLangs` (`dd_utils_api.ts`) is the one rule; `change_lang`
  and login's cookie adoption both use it.
- **`lg-nolan` is not a choosable session data language (ruling 2).** ONE predicate,
  `isChoosableDataLang` (`src/core/resolve/request_lang.ts`): declared AND not `lg-nolan`.
  `change_lang` refuses `dedalo_data_lang = lg-nolan` with the same code (`request.invalid_options`,
  public message `dedalo_data_lang 'lg-nolan' is not a language to work in`), the sync copy never
  copies it, and the seed clamp / login repair treat it as undeclared. `lg-nolan` stays a declared
  data language everywhere it is the non-translatable storage slot (`INSTALLED_DATA_LANGS`, the
  write chokepoint, tool_identify `cluster`'s named lang) — only the session CHOICE excludes it. The
  client's data-language selector never offers it (it lists the served choosable set).
- **Login repair (ruling 1).** `login` runs `repairSessionDataLang` on the session it minted, after
  the cookie adoption: a stored data language that is not choosable is REWRITTEN to the menu data
  language and logged (`console.warn`, `[login] …repaired to…`). A fresh session starts with NULL
  languages and adoption is held to the same rule, so the call is a by-construction backstop; a
  session left open from before the rule is covered per request by the seed clamp.

Gates: `change_lang.test.ts` (lg-nolan refused, stored lg-nolan served as the menu data lang,
`repairSessionDataLang` rewrites undeclared and lg-nolan, leaves choosable/none alone);
`change_lang_sync_native.test.ts` (an interface language `lg-nolan` — pinned in the child's
`DEDALO_APPLICATION_LANGS` — is never copied into the data language).

## Addendum 2026-11-22 — re-review item 2: the data-language selector offers the choosable set

- **New TS-ONLY `page_globals` key `dedalo_data_langs`** (`src/core/resolve/environment.ts`
  `resolveChoosableDataLangs`): `[{label, value}]`, EXACTLY the languages `change_lang` accepts as
  a data language (`isChoosableDataLang`: the declared data languages minus `lg-nolan`) — the
  configured project languages first (config order, the labels `dedalo_projects_default_langs`
  resolves), then any other choosable declared language (`DEDALO_DATA_LANG_DEFAULT` outside the
  project list, equivalence-class members). PHP has no twin; `environment_differential` asserts the
  key TS-only and strips it (the WC-031 handling). `dedalo_projects_default_langs` is unchanged (it
  is the project list — a subset of the declared set, which also feeds the tools' language columns).
- **Client** (`client/dedalo/core/menu/js/view_default_edit_menu.js`): the data-language selector
  is built from `page_globals.dedalo_data_langs` (`data_lang_options`) — before, from
  `dedalo_application_langs`, a different set (on the suite: 8 interface vs 12 data languages, so
  it hid data languages the server accepts and could offer ones it refuses). `change_lang` does NOT
  reload on `ok:false`: the refusal is published as `api_error` and rendered by the error policy, a
  reload wiped it; the `loading` state is cleared. A stored change still reloads.

Gates: `test/unit/change_lang.test.ts` (the served set equals the choosable set, and every entry is
accepted by the door); client suite `test_menu_change_lang` (selector = `dedalo_data_langs`, no
`lg-nolan`, differs from the interface langs on the suite; refused change: no reload, refusal
published, loading cleared; stored change reloads).

## Addendum 2026-11-22 — owner ruling: the switch is `DEDALO_DATA_LANG_SYNC`

The config key was renamed from the TS-era `DATA_LANG_SYNC` to `DEDALO_DATA_LANG_SYNC` (its
siblings' prefix, and the v6 name); this entry uses the new name throughout. Same default
(`false`) and doc. The old spelling is RETIRED through `RETIRED_ENV_KEYS` (`src/config/env.ts`),
the mechanism every renamed key uses: set alone it REFUSES the boot naming the new key; set beside
the new key it configures nothing. Refuse, not honour-with-notice, because that is how the existing
renamed keys behave (`DEDALO_PREFIX_TIPOS`, `DEDALO_MEDIA_BASE_URL`): a retired spelling left in
place would otherwise silently fall back to the default. The v6 migration maps
`DEDALO_DATA_LANG_SYNC` straight across (SAME; it was an alias before). No wire change:
`page_globals.dedalo_data_lang_sync` is unchanged. Gate: `test/unit/data_lang_sync_key.test.ts`.

## Addendum 2026-11-22 — owner ruling: every language key carries its `DEDALO_` (v6) name

The same rename for the four other un-prefixed language keys: `APPLICATION_LANG` →
`DEDALO_APPLICATION_LANG`, `DATA_LANG` → `DEDALO_DATA_LANG`, `DATA_NOLAN` → `DEDALO_DATA_NOLAN`,
`PROJECTS_DEFAULT_LANGS` → `DEDALO_PROJECTS_DEFAULT_LANGS` (all were PHP-catalog aliases of the
TS-era names; the aliases are removed). Every reader moved (config.ts, environment.ts, the RAG
modules, the installer writers, CI env, the isolated-gate pins); the early spellings are RETIRED
through `RETIRED_ENV_KEYS`, same refusal; the v6 migration maps each straight across (SAME). An
installation whose installer-written `.env` still carries an early spelling refuses to boot until
the line is renamed. `request_lang_law_tripwire` rule 1 forbids env reads of BOTH spellings. No
wire change. Gate: `test/unit/lang_keys_renamed.test.ts` (reads measured in a child with an empty
private dir, so "alone" is alone).

## Addendum 2026-11-22 — chain review: one choice predicate, held at boot; client refusal path

The choice rule now lives in config as `isChoosableDataLangOf(lang, declared)`
(`src/config/data_langs.ts`: declared AND not `lg-nolan`); `request_lang.ts`
`isChoosableDataLang` delegates to it over the live set, so change_lang, the sync copy, the seed
clamp and login repair still ask ONE rule. Boot holds the MENU data language to it
(`resolveCurrentDataLang`): `DEDALO_DATA_LANG=lg-nolan` is overruled by
`DEDALO_DATA_LANG_DEFAULT` and reported (the undeclared-value precedent), and
`DEDALO_DATA_LANG_DEFAULT=lg-nolan` refuses the boot — so the fallback every fresh session, MCP
stdio and the repair use is never the storage slot. Client: `menu.prototype.change_lang`
publishes the `change_lang` event (sections drop their caches on it) ONLY when the server stored
the change; on a refusal the selector is reset to the session value (`page_globals[lang_type]`).
No wire shape change. Gates: `test/unit/menu_data_lang_working.test.ts` (boot legs),
`test/unit/write_lang_provenance_native.test.ts` (pure leg), client suite `test_menu_change_lang`.
