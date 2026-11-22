# Error reports

Lets an administrator report a problem straight from the browser, the moment it
happens. The report — with the page context, any JavaScript errors captured since
the page loaded and an optional screenshot — is **stored on this installation**
and, when an address is configured, **emailed** to the Dédalo maintainers.

The feature has three parts: a **page-wide JS error buffer**, an admin-only
**report tool**, and a dashboard **widget** to browse the reports this
installation has sent.

## For the administrator: how to report

A small circular button sits at the bottom-right of every page (it is shown to
global administrators only). Click it from wherever the problem occurred — a
record edit, a list, the thesaurus tree, an area dashboard, even a menu-less
pop-up window. A dialog opens showing:

- the current **section / page** and **user**,
- the count of **JavaScript errors** captured since the page loaded (expandable),
- a **description** field for you to explain what went wrong.

Nothing is sent until you press *Send report* — the captured errors accumulate
locally in the browser and only leave the machine on that explicit click. Your own
server stores the report and, if `DEDALO_ERROR_REPORT_EMAIL` is set, emails it.
The dialog tells you whether the email went out; when it did not (no address, or
the mail server refused), the report is still stored here.

## Configuration

All keys are in `../private/.env` (read once at boot — restart to apply). See the
[settings reference](configuration/config.md#error_report).

| Key | Meaning |
|---|---|
| `DEDALO_ERROR_REPORT_EMAIL` | Where reports are emailed. **Unset = stored on this installation only.** Needs the mailer configured (`DEDALO_SMTP_*`). |
| `DEDALO_ERROR_REPORT_RETENTION_DAYS` | Stored reports older than this are pruned (default 90; `0` = keep forever). |
| `DEDALO_ERROR_REPORT_MAX_ROWS` | Highest number of stored reports; the oldest are dropped first (default 100000; `0` = no ceiling). |

`DEDALO_ERROR_REPORT_MASTER_URL` and `DEDALO_ERROR_REPORT_RECEIVER` are **retired**
(reports are no longer relayed over HTTP to a master installation): the server logs
a warning at boot while either is still set. Remove them, and set
`DEDALO_ERROR_REPORT_EMAIL` instead.

The server stamps the trusted identity itself (user id, entity, engine version,
languages, timestamp) — the browser cannot spoof who reported or from where.
Reports are stored append-only in the `dedalo_ts_error_reports` table
(provisioned by migration `0002_error_reports.sql`).

### What the email contains

- a **plain-text** summary (installation, version, user id, section, page,
  description, the last few JavaScript errors) — never HTML;
- `report.json`: the full report;
- `screenshot.png` / `.jpg` / `.webp` when one was attached.

The subject carries a short reference that also appears in the stored report, so
a mailed report can be matched to its stored copy.

## Browsing reports

The maintenance dashboard (Development → Maintenance) has an **Error reports**
widget (admin-only) on every installation. It shows the total, where reports are
sent, and — on demand — the reports themselves: each row expands to the full
description, page URL, email outcome, the captured JavaScript errors and context.
All report content is rendered as plain text.

## Security & privacy

- No installation accepts reports from another over the network: there is no
  anonymous endpoint. Only a global administrator can send a report, and sends are
  rate-limited per installation.
- The report payload is an **allowlist** — the CSRF token, username and database
  name are never sent.
- Free-text descriptions, JavaScript error messages and screenshots **may contain
  record data** (cultural-heritage, possibly personal). The explicit *Send* click
  is the consent moment. An email may pass through third-party mail servers, which
  is why `DEDALO_ERROR_REPORT_EMAIL` is off by default — set it only if your
  institution agrees to send reports off-site.

## Notes

- The report tool and the browse widget are a TypeScript-native feature. See
  `engineering/wire_contract/` WC-018/019 and
  WC-2026-11-19-error-report-email-transport.
- Client assets (the error buffer, the global launcher, the widget) are TS-owned
  and served by the TS server.
