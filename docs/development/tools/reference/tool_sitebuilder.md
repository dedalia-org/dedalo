# tool_sitebuilder

The engine-side proxy to the standalone Site Builder daemon: every action forwards to the daemon over an authenticated channel, injecting the acting user's identity, so a logged-in user can build, preview and publish public websites over the published data without the browser ever touching the daemon.

## What it does / why & when to use it

`tool_sitebuilder` is a thin, authorizing proxy. The real work — owning site workspaces, running a coding agent, building each site to static files, serving the pre-production preview, promoting an approved build to production — lives in a **separate daemon** (`publication/site_builder`), which reads data only from the read-only publication API. The tool is where **authorization** happens: the engine forwards each request to the daemon with the shared bearer token and a stamped `actor`, and the daemon trusts those decisions and records who did what.

Use the tool from inside Dédalo to drive that daemon; a user builds a site and previews it, and a developer or administrator publishes it live. For the operator/end-user narrative — declaring and provisioning the instance, the workflow, example prompts — see [Site builder](../../../administration/site_builder.md) and the [site builder cookbook](../../../administration/site_builder_cookbook.md); this page documents the **tool** (its actions, gates and wire).

!!! info "Optional, hidden until configured"
    The tool exists only when this engine is PAIRED with a site-builder instance. `isConfigured()` is the transport resolver (`src/core/site_builder/pairing.ts`): a transport — `DEDALO_SITE_BUILDER_SOCKET`, or `DEDALO_SITE_BUILDER_URL` for a daemon reached over the network — plus `DEDALO_SITE_BUILDER_INSTANCE` and `DEDALO_SITE_BUILDER_TOKEN`. A HALF configuration resolves to no transport at all. `isAvailable` returns false otherwise, and every action fails closed with `site_builder.unconfigured` if somehow reached anyway.

## How it works (server + client)

**Server** (`tools/tool_sitebuilder/server/`), three files:

- `index.ts` — the `ToolServerModule` with fourteen actions, all `permission: null`. The tool grant (dd1324 active + profile-granted, enforced by dispatch **before** these run) is the gate for building; `publish` and `get_audit` additionally require a developer or global admin, checked imperatively via `assertPublisher`. Each handler validates its untrusted inputs before they become a daemon URL segment — `requireSlug` (`^[a-z][a-z0-9-]{1,39}$`), `requireId` (bounded, path-safe), a 32 KiB cap on prompts/messages — then forwards through `proxy()`, which turns a `SiteBuilderError` into a `{ result: false, msg, errors: [code] }` envelope.
- `daemon_client.ts` — the **only** place the engine talks HTTP to the daemon. `daemonJson` does the control calls (JSON, timeout via `AbortSignal.timeout`); `daemonStream` does the SSE leg (no overall timeout — a turn streams for minutes; cancellation wired to an `AbortSignal`). Both attach `Authorization: Bearer <token>`, `X-Dedalo-User-Id` and `X-Dedalo-Username` headers, and map every transport failure and daemon `problem+json` onto a stable `SiteBuilderError` code, never leaking the token or daemon URL into a browser-facing message.
- `wire.ts` — the wire vocabulary: the daemon problem shape, the map from every daemon `reason` to its registered `site_builder.*` code (control door and stream door), the engine's own refusal codes, and the stream relay (`relaySessionFrames`).

The one streaming action, `session_stream`, returns a `ReadableStream` (`stream` in the `ToolResponse`, `streamContentType: 'text/event-stream; charset=utf-8'`) that relays the daemon's SSE records through the tool-dispatch stream seam — every record byte-for-byte except an error record, which becomes the error body of its registered code (see *Failure codes* below) — with `streamHeaders: { 'X-Accel-Buffering': 'no' }` so nginx does not buffer the event stream. Its `cancel()` aborts the upstream fetch when the browser closes.

**Client** (`tools/tool_sitebuilder/js/`): `tool_sitebuilder.js` (instance), `sitebuilder_controller.js` (workspace logic), `builder_stream.js` (consumes the SSE stream), `render_tool_sitebuilder.js` (the workspace UI: site list, chat, live preview iframe, publish), and `markdown.js`. The tool opens in its own window.

## Actions & options

All actions are `permission: null`; the **tool grant** is the base gate (dispatch), and `proxy()` fails every action closed with `site_builder_unconfigured` when the daemon is not configured.

| Action | Daemon call | Extra gate | Key options |
| --- | --- | --- | --- |
| `get_status` | `GET /health` | none (answers even when down/unconfigured) | — |
| `list_sites` | `GET /v1/sites` | none | — |
| `create_site` | `POST /v1/sites` | none | `slug`, `name`, optional `template`, `driver` (`claude_code`/`opencode`/`pi`) |
| `delete_site` | `DELETE /v1/sites/:slug` | none | `slug`, optional `purge_prod` (only when strictly `true`) |
| `session_start` | `POST /v1/sites/:slug/sessions` | none | `slug`, `prompt` (req., ≤ 32 KiB), optional `driver` |
| `session_message` | `POST /v1/sessions/:id/messages` | none | `session_id`, `message` (req., ≤ 32 KiB) |
| `session_stop` | `POST /v1/sessions/:id/stop` | none | `session_id` |
| `session_history` | `GET /v1/sites/:slug/sessions` | none | `slug` |
| `session_stream` | `GET /v1/sessions/:id/events?after=N` | none | `session_id`, optional `after` (event cursor) |
| `build` | `POST /v1/sites/:slug/build` | none | `slug` |
| `get_build` | `GET /v1/sites/:slug/builds/:id` | none | `slug`, `build_id` |
| `preview` | `GET /v1/sites/:slug/preview` | none | `slug` |
| `publish` | `POST /v1/sites/:slug/publish` | **developer or global admin** + `confirm === true` | `slug`, `confirm` (req. true), optional `note` |
| `get_audit` | `GET /v1/audit` | **developer or global admin** | optional `slug` (filters to one site) |

There is no `backgroundRunnable`; long agent turns are handled by the SSE stream, not a background job. `get_status` deliberately bypasses `proxy()` so the client can render the workspace-vs-empty state honestly even when the daemon is down (`{ configured, reachable, can_publish }`). `publish` is double-gated: the publisher check **and** an explicit `confirm` flag, so neither an under-privileged user nor an unconfirmed call can take a site live.

`isAvailable: () => typeof config.siteBuilder.url === 'string' && typeof config.siteBuilder.token === 'string'` — a fast, pure, cacheable check that hides the whole tool when the daemon is not configured.

Failure codes are registered `DedaloError` codes, one per refusal — the browser renders the code's label, and no `site_builder.*` error carries free text (the daemon's sentence is log-only):

- transport and pairing: `site_builder.unconfigured`, `site_builder.unreachable`, `site_builder.auth` (the daemon rejected this server's token), `site_builder.instance_mismatch` (raised before a single byte is sent when the daemon's `/health` fingerprint is not this engine's pairing), `site_builder.failed`, `site_builder.stream_lost`;
- the daemon's `reason`s (`server/wire.ts` `DAEMON_REASON_CODES`): `site_builder.busy` (another task holds the site, or the daemon is restarting — retryable), `site_builder.slug_exists`, `site_builder.workspace_exists`, `site_builder.domain_taken`, `site_builder.webspace_unavailable`, `site_builder.no_build`, `site_builder.not_running`, `site_builder.site_limit`, `site_builder.disk_quota`, `site_builder.capacity` (too many turns at once — retryable), `site_builder.confinement_unavailable`;
- the engine's own refusals, before the daemon is asked: `site_builder.invalid_slug`, `site_builder.invalid_id`, `site_builder.name_required`, `site_builder.domain_required`, `site_builder.text_required`, `site_builder.confirmation_required`, `site_builder.not_permitted`, `site_builder.not_session_owner`;
- a turn's error on the event stream (`TURN_EVENT_REASON_CODES`): the codes above, plus `site_builder.turn_timeout`, `site_builder.turn_interrupted`, `site_builder.turn_setup_failed`, `site_builder.agent_failed` and `site_builder.replay_failed`;
- `site_builder.rejected` is only the fallback for a daemon 4xx that carries no reason.

## How it is registered & surfaced

`tools/tool_sitebuilder/register.json` is in the hand-authorable **authoring format** (see [register.json reference](../register_json.md)):

```json
{
    "name": "tool_sitebuilder",
    "version": "1.0.0",
    "label": { "lg-eng": "Site builder", "lg-spa": "Constructor de sitios" },
    "developer": "Dédalo team",
    "affected_models": [],
    "show_in_component": false,
    "active": true,
    "properties": { "open_as": "window", "windowFeatures": null },
    "labels": [ { "lang": "lg-eng", "name": "sitebuilder_title", "value": "Site builder" } ]
}
```

- `affected_models` is empty and `show_in_component` is false: it is **not** element-attached. Its launcher appears in **Area maintenance**, under the **Publication** subsystem, and it opens in its own `window`.
- It must be **registered** (the *Register tools* maintenance widget) so `tool_sitebuilder` becomes active, and **granted** to the users who should build sites (administrators have it automatically). The daemon URL/token being unset keeps the tool hidden regardless.

## Examples

A client control call (dispatched through `dd_tools_api` / the tool-request envelope) to open a session with a first prompt:

```js
const response = await self.tool_request({
    action  : 'session_start',
    options : {
        slug   : 'reservoir-memories',
        prompt : 'Build a landing page with a map of every interview location.'
    }
})
// response.result → the daemon's session descriptor (session_id, …)
```

Publishing is double-gated — a developer/admin call that must carry `confirm`:

```js
const response = await self.tool_request({
    action  : 'publish',
    options : { slug: 'reservoir-memories', confirm: true, note: 'v1 approved' }
})
// under-privileged → error.code 'site_builder.not_permitted'; unconfirmed → 'site_builder.confirmation_required'
```

The event stream (`session_stream`) is consumed as an SSE response relayed from `GET /v1/sessions/:id/events?after=N`; the client resumes from the last `after` cursor after a reconnect. Each `data:` record is a stored event `{seq, ts, body}`; an error record's body is `{type: 'error', error: {code, category, message, label_key, retryable}, agent_output?}` (`agent_output` is the agent's own stderr tail when it exited with an error), and an `event: error` frame's data is that same error body.

## Related

- [Site builder](../../../administration/site_builder.md) · [site builder cookbook](../../../administration/site_builder_cookbook.md) — declaring and provisioning a museum's instance, the day-to-day workflow, and example prompts.
- [Creating new tools](../creating_tools.md) · [Server contract](../server_contract.md) — the tool model, `apiActions`, the `permission: null` + imperative-gate pattern, and the streaming `ToolResponse` fields this page builds on.
- [Security](../security.md) — the framework gates and the identity-injection trust model an engine-side proxy relies on.
- Source: `tools/tool_sitebuilder/server/{index,daemon_client,wire}.ts`, `tools/tool_sitebuilder/js/{tool_sitebuilder,sitebuilder_controller,builder_stream,render_tool_sitebuilder}.js`, `tools/tool_sitebuilder/register.json`.
