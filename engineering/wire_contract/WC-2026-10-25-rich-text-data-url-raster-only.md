# WC-2026-10-25-rich-text-data-url-raster-only — the rich-text sanitizer keeps only raster-image `data:` URLs in attributes

- **Date:** 2026-10-25 (CodeQL #9673 `js/incomplete-url-scheme-check`, triaged HARDENING).
- **Decision:** DEC-12 (gated, mutation-verified: `test/unit/server_codeql_hardening_native.test.ts`
  `#9673` describe).
- **Shape before (TS):** `sanitizeRichText` rule 3 rewrote to `#` an attribute value whose decoded
  form started with `javascript:`, `vbscript:`, `data:text/html` or `data:application/`. Every other
  `data:` URL survived — `data:image/svg+xml` (scriptable), `data:text/xml`, `data:,…`, and
  `data: text/html,…` (the data-URL parser strips the space, the prefix check did not).
- **Shape after (TS):** for `data:` the check is an ALLOWLIST: only `data:image/(png|jpeg|jpg|gif|
  webp|avif|bmp)` followed by `;`, `,` or the end survives; any other `data:` value becomes `#`.
  Exception, so curator prose is not rewritten: in `alt`, `title`, `class`, `id`, `lang`, `dir`,
  `aria-*` and `data-*` (attributes a browser never resolves as a URL) only the old
  `data:text/html` / `data:application/` denylist applies. `javascript:` / `vbscript:` stay refused
  in EVERY attribute; the non-`data:` schemes stay a denylist (urn:/doi:/ftp: survive).
- **Reason:** CKEditor never produces a non-raster data: URL; a denylist of media types is the
  shape that keeps missing one. The value is sanitized on save, so the stored text and the save
  echo change only for content that carried such a URL.
- **Gate reconciliation:** `test/unit/html_sanitize.test.ts` unchanged and green (its data: cases are
  all still refused); no parity fixture holds a non-raster data: URL (no re-harvest needed).
