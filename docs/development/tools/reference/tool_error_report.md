# tool_error_report

Administrators-only tool that collects the current page context and the captured JavaScript errors, stamps trusted identity server-side, and relays the report to a central **master** installation for the Dédalo maintainers.

## What it does / why & when to use it

`tool_error_report` lets a global administrator report a problem the moment it happens, from any page. Its client auto-collects the page path (navigation params only), the section locator from the caller or URL, and the page-wide JavaScript error buffer (`window.dedalo_js_errors`); the admin adds a free-text description and submits. The tool's single server action validates the browser-supplied context, **stamps identity itself** (user id, entity, engine version, languages, timestamp) so the browser can never spoof who reported or from where, and either relays the report to the configured master installation or stores it locally when this server is itself the master.

Use it to file a bug straight from the UI with the JS-error context already attached. For the operator-facing view of the whole feature — enabling it, the receiver side, browsing received reports — see [Error reports](../../../administration/error_reports.md); this page documents the **tool**.

!!! info "This is an administrator tool"
    The report form is shown to global administrators only, and the server refuses `send_report` from anyone else regardless of the UI. Non-admins never see the launcher.

## How it works (server + client)

**Server** (`tools/tool_error_report/server/index.ts`). One action, `send_report`, whose handler (`buildSendReportHandler`, built with injectable `fetch` / local-store / settings seams for tests):

1. **Gates imperatively** — `permission: null` in the map; the handler's first line refuses unless `context.principal.isGlobalAdmin` (defense in depth over the registry non-grant that already hides the tool).
2. **Validates** the browser submission against the shared strict schema (`src/core/error_report/schema.ts`, `reportSubmissionSchema`); a parse failure returns `invalid_submission`.
3. **Server-stamps identity** onto a `ReportWire`: `user_id` from the principal, `entity` / `entity_label` / `dedalo_version` from config, `langs` from `currentApplicationLang()` / `currentDataLang()`, `sent_at` = now, `report_version: 1`. None of these come from the browser.
4. **Fits the size cap** by dropping the oldest captured JS errors first (the description always survives); still-too-large → `too_large`.
5. **Routes**: if `DEDALO_ERROR_REPORT_MASTER_URL` is set, relays outbound (https-only via `masterUrlAllowed`, except loopback http for dev; `AbortController` + configured timeout; optional `X-Dedalo-Report-Token` header) to the master's `dd_error_report_api:receive_report`. Else, if this server is the receiver (`DEDALO_ERROR_REPORT_RECEIVER`), stores directly via `insertErrorReport` (no HTTP loopback). Else returns an honest `relay_not_configured` failure. A failed relay logs a **message-only** warning — never the payload or the token — and returns a failure envelope.

**Client** (`tools/tool_error_report/js/`):

- `tool_error_report.js` is the instance. It is **caller-optional**: launched globally from the top menu bar, it reads its context from the page URL and the JS-error buffer, so `init()` clears the spurious `Empty caller !` error, and `build()` overrides the ddo_map loader with a no-op (the tool renders no components). `collect_report_data()` builds the submission as an **allowlist** — page path with navigation params only, `section_tipo` only if it satisfies the `^[a-z]+[0-9]+$` identifier chokepoint, the last 50 buffered JS errors copied field-by-field, and a small informational `client_globals` snapshot. It never spreads `page_globals` (no CSRF token, username, db name or engine versions leave the browser). `send_report()` posts through `self.tool_request({ action: 'send_report', options })`.
- `render_tool_error_report.js` builds the form: an intro/disclosure line, a context summary, the captured errors inside an expandable `<details>`, the description `<textarea>` (required, `maxlength` 8000), and the send button. **Every dynamic string renders through `text_content` / `textContent`, never `inner_html`** (DS-1), so a hostile captured error message can never become markup.

## Actions & options

| Action | Permission gate | Background | Reads from `options` |
| --- | --- | --- | --- |
| `send_report` | `permission: null` + imperative `isGlobalAdmin` check (first line of the handler) | no | the validated report submission (see below) |

There is no `backgroundRunnable`; the relay runs synchronously with the configured timeout. Options are the browser-supplied, schema-validated submission — the server discards and re-stamps every identity field:

| Option (client-observable) | Meaning |
| --- | --- |
| `description` | The admin's free-text problem description (capped at 8000 chars). |
| `page_url` | Page path + navigation params only (fragment and raw query dropped). |
| `section_tipo` / `section_id` | Section locator from the caller or URL; `section_tipo` must match `^[a-z]+[0-9]+$` or is dropped. |
| `js_errors` | Up to 50 captured errors, each field length-clamped (`type`, `msg`, `source`, `line`, `col`, `stack`, `time`, `count`). |
| `user_agent` | The browser UA string (clamped). |
| `client_globals` | Informational snapshot (`user_id`, `dedalo_version`, `application_lang`, `data_lang`) — the server re-asserts identity. |

Success response: `{ result: { delivered: true, via: 'master' | 'local', report_id? }, msg, errors: [] }`. Failures return `{ result: false, msg, errors }` with a stable code (`unauthorized`, `invalid_submission`, `too_large`, `relay_misconfigured`, `relay_failed`, `store_failed`, `relay_not_configured`).

## How it is registered & surfaced

`tools/tool_error_report/register.json` is in the hand-authorable **authoring format** (see [register.json reference](../register_json.md)):

```json
{
    "name": "tool_error_report",
    "version": "1.0.0",
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
- Configuration is not per-tool ontology config but boot config: the sender/receiver keys are `DEDALO_ERROR_REPORT_*` in `../private/.env`, read once at boot into `config.errorReport`.

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
// response → { result: { delivered: true, via: 'master' }, msg: 'OK. Report sent to the master installation', errors: [] }
```

`section_id` is a **string** here, and deliberately so: an error report is a
self-reported free-text diagnostic, its wire schema declares the field as a
capped string and the report table stores it as text. It is not a record
address the engine resolves — everywhere the engine does address a record it
uses an integer.

The outbound relay the server sends to the master (`dd_error_report_api:receive_report`, WC-017) carries the **server-stamped** report as `options`; the master re-validates everything and trusts no remote installation.

## Related

- [Error reports](../../../administration/error_reports.md) — the operator/administrator guide: enabling the feature, the receiver side, and the master dashboard widget that browses received reports.
- [Creating new tools](../creating_tools.md) · [Server contract](../server_contract.md) — the tool model, `apiActions`, the `permission: null` + imperative-gate pattern, and config resolution this page builds on.
- [Security](../security.md) — the framework gates and the defense-in-depth an admin-only relay tool adds.
- Source: `tools/tool_error_report/server/index.ts`, `tools/tool_error_report/js/{tool_error_report,render_tool_error_report}.js`, the shared `src/core/error_report/{schema,store}.ts`, `tools/tool_error_report/register.json`. Wire contract: `engineering/wire_contract/` WC-017/018/019.
