# WC-018 — `error_reports` maintenance widget (TS-only; conditional catalog entry + TS-owned client files)

- **Date:** 2026-07-10.
- **Shape:** the maintenance dashboard catalog gains an `error_reports`
  widget (browse the WC-017 intake) ONLY where
  `DEDALO_ERROR_REPORT_RECEIVER=true` — on every other installation the
  catalog stays byte-identical to PHP. Its client JS lives at
  `client/dedalo/core/area_maintenance/widgets/error_reports/` as a TS-OWNED
  divergence (the diffusion_server_control WC-005 pattern), excluded from
  `scripts/sync_client.sh`. Rendering rule: report fields are untrusted
  remote content — textContent only, never inner_html.
- **CSS:** the widget look lives in
  `widgets/error_reports/css/error_reports.less` (system_info visual language,
  theme-aware `--fg_*`/`--bg_*`) and is `@import`ed into `area_maintenance.less`.
  The client `main.less` cannot compile standalone (it imports `tool_common`,
  which is served from `src/` and is not a physical client file), and `main.css`
  is built in the PHP tree + synced — which cannot include this TS-only widget.
  So `error_reports.less` is compiled standalone (`lessc`) and its output
  APPENDED to `client/dedalo/core/page/css/main.css` under a marker comment.
  A full `sync_client.sh` re-sync reverts the append (main.css re-synced from
  PHP) — the script RE-APPENDS it automatically (idempotent marker check;
  fails loudly without `lessc`, 2026-07-10 follow-through), so a re-sync never
  silently ships the widget unstyled. Verified readable in light + dark via a
  headless puppeteer screenshot.
- **Gate reconciliation:** `widgets_differential` filters `id ===
  'error_reports'` from the TS catalog before the byte-compare;
  `dedalo_files_differential` filters the widget's client files via
  `isTsOnlyEntry`. TS ground truth pinned in
  `test/unit/error_reports_widget.test.ts`. `client_serving.test.ts` asserts
  main.css as PHP-bytes-exact-PREFIX + exactly this ONE marker-tagged tail
  (strict byte-identity minus the ledgered append; reconciled 2026-07-10 —
  the append had landed without updating this gate, turning verify red).

## Addendum 2026-11-19 — email transport

The widget is listed on every installation (each stores the reports its admins send); `target` names the mail recipient. See WC-2026-11-19-error-report-email-transport.
