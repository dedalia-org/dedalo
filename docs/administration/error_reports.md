# Error reports

Lets an administrator report a problem straight from the browser, the moment it
happens, and delivers that report — with the page context and any JavaScript
errors captured since the page loaded — to a central **master** installation
where the Dédalo maintainers can review it.

The feature has three parts: a **page-wide JS error buffer**, an admin-only
**report tool**, and — on the master installation — an **intake endpoint** plus
a dashboard **widget** to browse what comes in.

## For the administrator: how to report

A small circular button sits at the bottom-right of every page (it is shown to
global administrators only). Click it from wherever the problem occurred — a
record edit, a list, the thesaurus tree, an area dashboard, even a menu-less
pop-up window. A dialog opens showing:

- the current **section / page** and **user**,
- the count of **JavaScript errors** captured since the page loaded (expandable),
- a **description** field for you to explain what went wrong.

Nothing is sent until you press *Send report* — the captured errors accumulate
locally in the browser and only leave the machine on that explicit click. The
report is relayed by your own server to the configured master installation.

## Configuration

All keys are `DEDALO_ERROR_REPORT_*` in `../private/.env` (read once at boot —
restart to apply). See the [settings reference](configuration/config.md#error_report).

### Sender side (any installation that reports)

| Key | Meaning |
|---|---|
| `DEDALO_ERROR_REPORT_MASTER_URL` | The master installation's JSON API endpoint, e.g. `https://master.example/dedalo/core/api/v1/json/`. **Setting it enables reporting.** `https` required (plain `http` only for a loopback dev target). |
| `DEDALO_ERROR_REPORT_TOKEN` | Optional shared secret; sent as the `X-Dedalo-Report-Token` header. A spam filter, not authentication (see below). |
| `DEDALO_ERROR_REPORT_TIMEOUT_MS` | Outbound relay timeout (default 10000, min 1000). |

The server stamps the trusted identity itself (user id, entity, engine version,
languages, timestamp) — the browser cannot spoof who reported or from where.
If no master URL is set but this installation is itself the receiver, the report
is stored locally instead of relayed.

### Receiver side (only the designated master installation)

| Key | Meaning |
|---|---|
| `DEDALO_ERROR_REPORT_RECEIVER` | `true` exposes the pre-auth intake action on this server. **Default `false`** — when off, the endpoint is indistinguishable from an unregistered action. |
| `DEDALO_ERROR_REPORT_TOKEN` | If set, incoming reports must carry the matching header. |
| `DEDALO_ERROR_REPORT_ALLOWED_IPS` | Optional comma-separated IP allowlist (`loopback` shorthand accepted). Unset = open (still throttled + size-capped). |
| `DEDALO_ERROR_REPORT_RETENTION_DAYS` | Reports older than this are pruned (default 90; `0` = keep forever). |

Received reports are stored append-only in the `dedalo_ts_error_reports` table
(provisioned by migration `0002_error_reports.sql`).

## Browsing received reports

On the master installation, the maintenance dashboard (Development → Maintenance)
gains an **Error reports** widget (admin-only). It shows the total, where reports
from this installation are sent, and — on demand — the reports themselves: each
row expands to the full description, page URL, source IP, and the captured
JavaScript errors and context. All report content is rendered as plain text.

The widget also appears on a *sender-only* installation (one with a master URL
but not the receiver flag), where it simply shows the configured relay target.

## Security & privacy

The intake is an anonymous, rate-limited, append-only endpoint; the design and
its trade-offs are recorded in
`audits/2026-07_foundation/security/SECURITY_DECISIONS.md` (DECISION 7). In
short:

- The report payload is an **allowlist** — the CSRF token, username, database
  name, and engine versions are never sent.
- Free-text descriptions and JavaScript error messages **may contain record
  data** (cultural-heritage, possibly personal). This is minimized (size caps)
  and retention-bound, not scrubbed — the explicit *Send* click is the consent
  moment. Administrators should be aware the report crosses to the master
  operator.
- The shared token is a **spam filter, never trust**: every field is treated as
  untrusted on the receiver regardless. The receiver stamps `source_ip` and
  `received_at` itself — the only fields it trusts.

## Notes

- The report tool and the browse widget are a TypeScript-native feature. See
  `engineering/wire_contract/` WC-017/018/019.
- Client assets (the error buffer, the global launcher, the widget) are TS-owned
  and served by the TS server.
