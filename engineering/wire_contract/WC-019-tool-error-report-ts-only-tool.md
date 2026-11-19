# WC-019 — `tool_error_report`, a TS-only tool (dd1324 row TS-written; PHP must not re-import)

- **Date:** 2026-07-10.
- **Shape:** a new tool package in the TS-owned `tools/` tree (admin-only:
  active, NOT always_active, granted to no profile) whose server half relays
  admin error reports to the master installation (WC-017). The shared dd1324
  registry row is written by the TS *Register tools* widget
  (TOOLS_ENABLE_REGISTRY_IMPORT; registered on this install 2026-07-10).
- **Global launch surface (2026-07-10, upstreamed — NOT a TS divergence):**
  the tool is toolbar-less (`affected_models: []`, `show_in_inspector: false`)
  and launched from a SINGLE global surface: a small fixed floating button
  (`core/common/js/error_report_launcher.js`, admin-gated, injected once from
  `core/page/js/index.js` after render) present on EVERY page — including
  menu-less `?menu=false` windows (thesaurus term, print). A short-lived
  top-menu-bar variant was tried and dropped as redundant (the floating button
  already covers menu'd pages), which keeps `view_default_edit_menu.js`
  unedited. It opens the tool BY NAME with a SYNTHETIC caller
  (`{model,type:'tool',tipo,lang,id_base,label}`) — `view_modal` hard-requires a
  caller; the tool defines `on_close_actions()` so the close flow skips the
  component re-activate that would fail on a synthetic caller. Resolves on the
  TS engine only; on a PHP-served client the button appears but open_tool finds
  no context (PHP has no such tool on disk) and does nothing — the same
  coexistence wrinkle as the dd1324 row (COEXISTENCE).
- **Coexistence (MEASURED 2026-07-10):** PHP-served admins do NOT see the
  tool at all — PHP's `get_all_registered_tools` drops any dd1324 row whose
  on-disk client config is missing ("Ignored bad config" `continue`,
  `tools/tool_common/class.tool_common.php:788-796`), so the TS-only row
  never enters PHP's tool lists (only a debug_log ERROR line). Cleaner than
  the tool_assistant listed-but-broken shape; the standing rule stays: PHP
  must never re-import tools (COEXISTENCE row).
- **Gate reconciliation:** `tools_register_differential` carves the tool out
  of the in-registry no-op requirement via `TS_ONLY_TOOLS` (still validated;
  still diff-free once registered, with a staleness self-test);
  `user_tools_differential` + `section_tools_differential` filter the tool
  from the TS side (PHP lists never carry it, per the measured drop above);
  `dedalo_files_differential` filters `/dedalo/tools/tool_error_report/` via
  `isTsOnlyEntry`. All four verified GREEN against the live oracle
  post-registration. TS ground truth pinned in
  `test/unit/tool_error_report.test.ts`.
- **Screenshot field (2026-07-17):** the submission/wire payload gains ONE
  optional field `screenshot` — an INLINE `data:image/(png|jpeg|webp);base64,…`
  data URL, never a fetchable URL (no SSRF surface; the `.regex()` in
  `src/core/error_report/schema.ts` rejects any other shape). It is
  `.optional()` on top of `.nullable()` so a report from an older client that
  omits the key still validates at the master (cross-version wire). The admin
  attaches it in the tool UI (file-pick / drag / clipboard-paste); the browser
  re-encodes it to a compact `image/jpeg` under a ~150 KiB budget before it is
  ever sent, and the existing 256 KiB whole-payload cap
  (`REPORT_MAX_SERIALIZED_BYTES`) still bounds the total. Stored inside the
  report's `context` jsonb (`screenshot`), NOT a new column — no migration. The
  `error_reports` widget renders it as an `<img src="data:…">` (inert as
  markup; still never `inner_html`) and elides the base64 blob from the raw
  Context dump. Purely additive; PHP has no twin and never reads this endpoint.

## Addendum 2026-11-19 — email transport

Response is now `{delivered, report_id, ref, mailed}`; the HTTP relay is gone (store always, mail when `DEDALO_ERROR_REPORT_EMAIL` is set). See WC-2026-11-19-error-report-email-transport.
