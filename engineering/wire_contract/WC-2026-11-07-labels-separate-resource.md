# WC-2026-11-07-labels-separate-resource — UI labels leave the environment; versioned `/api/v1/labels` resource

- **Date:** 2026-11-07.
- **Decision:** the css_version pattern (WC-2026-11-06-css-version) applied to labels.
- **Shape before (PHP):** `get_environment` / `start`'s `environment` extension
  key carried `result.get_label` — the full localized UI-label dictionary
  (~hundreds of KB uncompressed) — on EVERY page load, uncacheable (it rides a
  POST API response).
- **Shape after (TS):**
  - `environment.result` = `{page_globals, plain_vars}` — NO `get_label` key.
  - `page_globals.labels_version` (TS-ONLY): 16 lowercase hex, sha256 over
    `JSON.stringify(getLabels(dedalo_application_lang))` — the MERGED dictionary,
    so install-config inputs (default lang, `DEDALO_LANG_EQUIVALENCES`) are
    covered (`getLabelsVersion`, `src/core/labels/catalog.ts`, ontology-hub
    cached). Emitted for anonymous callers too.
  - New PUBLIC route `GET|HEAD /api/v1/labels?lang=<lg-code>&v=<version>` and
    its client-relative twin `/dedalo/core/api/v1/labels`
    (`src/core/api/labels_resource.ts`). `lang` must be well-formed
    (`isValidLang`, not the `all` sentinel), else (or missing) 404
    converter-made envelope, no file read. A well-formed lang outside
    `DEDALO_APPLICATION_LANGS` is served the dictionary `labelsServingLang`
    picks (the install default) — the SAME mapping `labels_version` is computed
    with, so every lang page_globals can emit (a session lang set by
    change_lang / DATA_LANG_SYNC / APPLICATION_LANG outside the list) answers
    200 and the page boots, as it did when `get_label` rode the environment. Body: the plain dictionary JSON, NOT an envelope;
    `Content-Type: application/json; charset=utf-8`; gzip-negotiated
    (`Vary: Accept-Encoding`). `v` equal to the current version →
    `Cache-Control: public, max-age=31536000, immutable`; `v` absent or stale →
    `no-cache`. Always `ETag: "<version>"`; a matching `If-None-Match` → 304.
- **Client:** `core/common/js/labels.js` `load_labels(lang, version)` fetches the
  resource and assigns the global `get_label`; `page.js` calls it after
  `set_environment` on both the success and the `perm.denied` path (the refusal
  still carries the environment — WC-2026-08-12-authorization-denial-token — now
  for `labels_version`); `set_environment` no longer handles a `get_label` key.
- **Reason:** the dictionary is repo data that changes only on a code deploy;
  shipping it in every `start` wasted bandwidth and parse time on every page.
  A content-versioned URL lets the browser keep it immutably and fetch it once
  per change, whatever cache headers the institution's web server sends.
- **Gate reconciliation:** `test/parity/environment_differential.test.ts` — the
  get_label containment law keeps its meaning but compares the frozen oracle
  keys against `getLabels(<oracle app lang>)` directly (the bytes the route
  serves) and asserts the TS environment has NO `get_label`; the page_globals
  key-set test asserts `labels_version` present TS-side / absent PHP-side, then
  strips it (the WC-031 pattern). No fixture edit, no re-harvest. Behaviour:
  `test/unit/labels_resource_native.test.ts` (headers, ETag/304, lang allowlist,
  both twins, HEAD, gzip, version derivation, environment shape).
