# WC-2026-11-06-css-version — `css_version` page_globals key (TS-only); stylesheet URLs built from it

- **Date:** 2026-11-06.
- **Shape:** `buildPageGlobals` (`src/core/resolve/environment.ts`) emits
  `css_version`: 16 lowercase hex, the sha256 over each client stylesheet's URL
  and bytes — `main.css`, tools_common css, and `<tool>/css/**` in every tools
  root (`clientCssVersion`, `src/core/api/dedalo_files.ts`). Frozen at boot,
  recomputed per call in dev mode. Emitted for anonymous callers too (the login
  page needs it; it hashes public files). PHP `get_page_globals` has NO twin.
- **Client:** `core/page/index.html` no longer carries a static main.css
  `<link>` (PHP stamped a constant `?ckcachebust=` there). The synchronous head
  script — RENAMED `theme-init.js` → `head-init.js` so no browser can hold a stale
  copy of it (service-worker cache, heuristic HTTP caching) — writes
  `main.css?v=<last css_version>` (localStorage `dedalo_css_version`), or
  `?v=init` when none is stored, parser-inserted for first paint; it ALWAYS
  writes one. After `start`, `core/page/js/index.js` `sync_main_css` swaps to the
  server's version before the page renders (an id-less static main.css link from
  a stale older index.html is replaced in place, not left to win the cascade).
  Tool stylesheets use `tool_css_url(model)` (`core/common/js/utils/util.js`):
  `?v=<css_version>` replaces `?v=<dedalo_version>`, which is `null` before login
  and constant between releases; `section.js` loaded tool css unversioned.
- **Manifest:** `get_dedalo_files` serves `head-init.js` where the frozen oracle
  has `theme-init.js`; `test/parity/dedalo_files_differential.test.ts` filters the
  pair from both sides and asserts TS serves only the new name.
- **Why:** the client tree is served by the institution's web server, whose cache
  headers the engine does not control. Without `Cache-Control: no-cache` browsers
  cache main.css (and index.html) heuristically and keep old styles for days after
  a code update (master7.dedalo.dev, 2026-11-06). The `start` response is the one
  channel fresh on every install, so a URL derived from it changes exactly when
  the bytes do.
- **Gate reconciliation:** `test/parity/environment_differential.test.ts`
  (page_globals key-set test) asserts the key present TS-side / absent PHP-side,
  then strips it — the WC-031 pattern. Behaviour: `test/unit/css_version_native.test.ts`
  (head-init.js and sync_main_css EXECUTED against fakes, plus the engine hash).
