# WC-2026-11-19-error-report-email-transport — error reports travel by email; the pre-auth intake is retired

- **Date:** 2026-11-19 (security review of the error_reports panel: the intake was the last
  pre-auth WRITE door; with the default OPEN posture an attacker rotating addresses could fill
  ~25 GiB of a master's database — 100 000 rows × ~256 KiB with screenshots).
- **Retires:** WC-017 (`dd_error_report_api:receive_report`). **Amends:** WC-018 (widget),
  WC-019 (tool response shape).
- **Shape before (TS):** `tool_error_report:send_report` relayed the report by HTTPS POST to
  `DEDALO_ERROR_REPORT_MASTER_URL` → the master's pre-auth `dd_error_report_api:receive_report`
  (Gate 1c: `DEDALO_ERROR_REPORT_RECEIVER`, optional IP allowlist + shared token) stored it.
  Response `{delivered:true, via:'master'|'local', report_id?}`; failures
  `tool.dependency_unavailable` (relay_*).
- **Shape after (TS):**
  - `dd_error_report_api` is UNREGISTERED — any action on it answers `request.unknown_action`
    (400), byte-identical to a class that never existed. Gone with it: Gate 1c, the
    `NO_LOGIN_ACTIONS`/`CSRF_EXEMPT_ACTIONS`/read-door/idempotency rows, the
    `X-Dedalo-Report-Token` header (also dropped from the CORS preflight's
    `Access-Control-Allow-Headers`), `src/core/error_report/gate.ts`, and the
    address-allowlist grammar `src/core/security/ip_allowlist.ts` with the
    allowlist-only helpers of `ip_address.ts` (`peerBytes`, `sameAddress`,
    `ipInCidr`, `peerBlock`) — its only consumer was the intake gate.
  - `send_report` ALWAYS stores the report on the sending installation, and mails it to
    `DEDALO_ERROR_REPORT_EMAIL` when set (the one mailer, `src/core/mailer/mailer.ts`): PLAIN
    TEXT body only (never `bodyHtml`), the full report as `report.json`, the screenshot as
    `screenshot.<png|jpg|webp>` — engine-constant filenames. The mail outcome is stored in the
    row's `context.mail` (`{status: sent|failed|not_configured, code?, ref}`; no DDL).
  - Response `{delivered:true, report_id, ref, mailed}`. A mail failure is NOT a submit
    failure (`mailed:false`); a store failure is `tool.action_failed` — unless the mail already
    went out, then `{delivered:true, report_id:null, mailed:true}` (a failure would make the
    admin resend and duplicate the email). Sends are throttled per
    installation (`rate.limited`, 10 per throttle window); a send that delivered nothing
    (no mail, store failed) gives its slot back.
  - The `error_reports` widget is listed on EVERY installation (each browses its own reports);
    `target` names the recipient or "stored on this installation only".
  - Config: `DEDALO_ERROR_REPORT_EMAIL` new; `MASTER_URL` / `RECEIVER` retired (boot warning
    when still set, never honoured); `TOKEN` / `ALLOWED_IPS` / `TIMEOUT_MS` removed.
- **Client effect:** the tool says "Report sent." when mailed, otherwise "saved on this
  installation, not emailed". Installations still pointing `MASTER_URL` at a master no longer
  relay (hard removal, no overlap release — v7 is beta).
- **Gate reconciliation:** no parity fixture covers the class. TS ground truth:
  `tool_error_report.test.ts` (store-always, mail text-only + constant attachments, mail
  failure ≠ submit failure, throttle, retired-key warning), `no_install_surface_tripwire` (frozen pre-auth list shrank),
  `error_reports_widget.test.ts` (always listed). `error_report_receiver` and
  `error_report_ip_gate` deleted with the door.
