---
title: Error reports are stored on your installation and sent by email; the anonymous report intake is removed.
type: security
audience: admin
date: 2026-11-19
breaking: true
wc: WC-2026-11-19-error-report-email-transport
---
Before, an administrator's error report was relayed over HTTP to a "master" installation, which
accepted reports from anyone on the network without logging in. That door could be used to fill
the master's database. It is gone.

Now every report is **stored on the installation where it was written** (the *Error reports*
panel of the maintenance dashboard lists them) and, when `DEDALO_ERROR_REPORT_EMAIL` is set,
**emailed** there through the configured mailer: a plain-text summary, the full report as
`report.json` and the screenshot as an image. Unset, reports stay on your installation.

**Action needed:** remove `DEDALO_ERROR_REPORT_MASTER_URL`, `DEDALO_ERROR_REPORT_RECEIVER`,
`DEDALO_ERROR_REPORT_TOKEN`, `DEDALO_ERROR_REPORT_ALLOWED_IPS` and
`DEDALO_ERROR_REPORT_TIMEOUT_MS` from `../private/.env` (the server logs a warning at boot while
the first two are set), and set `DEDALO_ERROR_REPORT_EMAIL` if you want reports sent to the
maintainers. See [Error reports](./administration/error_reports.md).
