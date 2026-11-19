# tool_error_report

Administrators-only tool that collects the current page context and the captured JavaScript errors, stamps trusted identity server-side, stores the report on this installation and — when an address is configured — emails it to the Dédalo maintainers.

## What it does / why & when to use it

`tool_error_report` lets a global administrator report a problem the moment it happens, from any page. Its client auto-collects the page path (navigation params only), the section locator from the caller or URL, and the page-wide JavaScript error buffer (`window.dedalo_js_errors`); the admin adds a free-text description and submits. The tool's single server action validates the browser-supplied context, **stamps identity itself** (user id, entity, engine version, languages, timestamp) so the browser can never spoof who reported or from where, stores the report on this installation, and emails it when `DEDALO_ERROR_REPORT_EMAIL` is set.

Use it to file a bug straight from the UI with the JS-error context already attached. For the operator-facing view of the whole feature — configuring the recipient, browsing stored reports — see [Error reports](../../../administration/error_reports.md); this page documents the **tool**.

!!! info "This is an administrator tool"
    The report form is shown to global administrators only, and the server refuses `send_report` from anyone else regardless of the UI. Non-admins never see the launcher.

## How it works (server + client)

**Server** (`tools/tool_error_report/server/index.ts`). One action, `send_report`, whose handler (`buildSendReportHandler`, built with injectable `sendMail` / local-store / throttle / recipient seams for tests):

1. **Gates imperatively** — `permission: null` in the map; the handler's first line refuses unless `context.principal.isGlobalAdmin` (defense in depth over the registry non-grant that already hides the tool).
2. **Validates** the browser submission against the shared strict schema (`src/core/error_report/schema.ts`, `reportSubmissionSchema`); a parse failure refuses with `request.invalid_options`.
3. **Throttles** per installation (10 sends per throttle window; `rate.limited`), before anything is mailed or stored.
4. **Server-stamps identity** onto a `ReportWire`: `user_id` from the principal, `entity` / `entity_label` / `dedalo_version` from config, `langs` from `currentApplicationLang()` / `currentDataLang()`, `sent_at` = now, `report_version: 1`. None of these come from the browser.
5. **Fits the size cap** by dropping the oldest captured JS errors first (the description always survives); still too large → `request.invalid_options`.
6. **Mails, then stores.** When `DEDALO_ERROR_REPORT_EMAIL` is set it calls the one mailer (`src/core/mailer/mailer.ts` `sendMail`) with a **plain-text** body (never `bodyHtml` — report text is untrusted), the full report as `report.json` and the screenshot as `screenshot.<ext>` (engine-constant filenames). Then it stores the report via `insertErrorReport`, recording the mail outcome in `context.mail` (`{status, code?, ref}`); the store is append-only, which is why the outcome is known before the insert. A mail failure is **not** a submit failure (`mailed: false`); a store failure is `tool.action_failed`.

**Client** (`tools/tool_error_report/js/`):

- `tool_error_report.js` is the instance. It is **caller-optional**: launched globally from the top menu bar, it reads its context from the page URL and the JS-error buffer, so `init()` clears the spurious `Empty caller !` error, and `build()` overrides the ddo_map loader with a no-op (the tool renders no components). `collect_report_data()` builds the submission as an **allowlist** — page path with navigation params only, `section_tipo` only if it satisfies the `^[a-z]+[0-9]+$` identifier chokepoint, the last 50 buffered JS errors copied field-by-field, and a small informational `client_globals` snapshot. It never spreads `page_globals` (no CSRF token, username, db name or engine versions leave the browser). `send_report()` posts through `self.tool_request({ action: 'send_report', options })`.
- `render_tool_error_report.js` builds the form: an intro/disclosure line, a context summary, the captured errors inside an expandable `<details>`, the description `<textarea>` (required, `maxlength` 8000), and the send button. **Every dynamic string renders through `text_content` / `textContent`, never `inner_html`** (DS-1), so a hostile captured error message can never become markup.

## Actions & options

| Action | Permission gate | Background | Reads from `options` |
| --- | --- | --- | --- |
| `send_report` | `permission: null` + imperative `isGlobalAdmin` check (first line of the handler) | no | the validated report submission (see below) |

There is no `backgroundRunnable`; the mail and the store run synchronously. Options are the browser-supplied, schema-validated submission — the server discards and re-stamps every identity field:

| Option (client-observable) | Meaning |
| --- | --- |
| `description` | The admin's free-text problem description (capped at 8000 chars). |
| `page_url` | Page path + navigation params only (fragment and raw query dropped). |
| `section_tipo` / `section_id` | Section locator from the caller or URL; `section_tipo` must match `^[a-z]+[0-9]+$` or is dropped. |
| `js_errors` | Up to 50 captured errors, each field length-clamped (`type`, `msg`, `source`, `line`, `col`, `stack`, `time`, `count`). |
| `user_agent` | The browser UA string (clamped). |
| `client_globals` | Informational snapshot (`user_id`, `dedalo_version`, `application_lang`, `data_lang`) — the server re-asserts identity. |

Success payload (envelope v2 `data`): `{ delivered: true, report_id, ref, mailed }`. Refusals carry a registered code: `perm.denied`, `request.invalid_options`, `rate.limited`, `tool.action_failed`.

## How it is registered & surfaced

`tools/tool_error_report/register.json` is in the hand-authorable **authoring format** (see [register.json reference](../register_json.md)):

```json
{
    "name": "tool_error_report",
    "version": "1.1.0",
    "label": { "lg-eng": "Error report", "lg-spa": "Informe de errores" },
    "developer": "Dédalo team",
    "affected_models": [],
    "show_in_inspector": false,
    "show_in_component": false,
    "active": true,
    "properties": { "open_as": "modal" }
}
```

- `affected_models` is empty and both `show_in_*` flags are false: it is **not** element-attached. It is launched globally from the top menu bar (a small circular launcher shown to global administrators on every page), opening as a `modal`.
- Configuration is not per-tool ontology config but boot config: `DEDALO_ERROR_REPORT_EMAIL` (and retention keys) in `../private/.env`, read once at boot into `config.errorReport`.

## Examples

The client submission built by `collect_report_data()` + `send_report()`, dispatched through `tool_request`:

```js
const response = await self.tool_request({
    action  : 'send_report',
    options : {
        description   : 'Saving the Description throws after I add a second image.',
        page_url      : '/dedalo/?tipo=oh1&section_id=42&mode=edit',
        section_tipo  : 'oh1',
        section_id    : '42',
        js_errors     : [ { type: 'error', msg: 'x is not defined', source: '…', line: 12, count: 1 } ],
        user_agent    : 'Mozilla/5.0 …',
        client_globals: { user_id: 7, dedalo_version: '7.x', application_lang: 'lg-eng', data_lang: 'lg-eng' }
    }
})
// response data → { delivered: true, report_id: 31, ref: '3f9a1c2e', mailed: true }
```

`section_id` is a **string** here, and deliberately so: an error report is a
self-reported free-text diagnostic, its wire schema declares the field as a
capped string and the report table stores it as text. It is not a record
address the engine resolves — everywhere the engine does address a record it
uses an integer.

The mailed `report.json` is the **server-stamped** report (identity fields never come from the browser).

## Related

- [Error reports](../../../administration/error_reports.md) — the operator/administrator guide: the recipient, what the email contains, and the dashboard widget that browses stored reports.
- [Creating new tools](../creating_tools.md) · [Server contract](../server_contract.md) — the tool model, `apiActions`, the `permission: null` + imperative-gate pattern, and config resolution this page builds on.
- [Security](../security.md) — the framework gates and the defense-in-depth an admin-only tool adds.
- Source: `tools/tool_error_report/server/index.ts`, `tools/tool_error_report/js/{tool_error_report,render_tool_error_report}.js`, the shared `src/core/error_report/{schema,store}.ts`, `tools/tool_error_report/register.json`. Wire contract: `engineering/wire_contract/` WC-018/019 and WC-2026-11-19-error-report-email-transport.
