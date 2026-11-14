# dd_mcp_api

> See also: [JSON API v1](../dedalo_api_v1.md) · [The assistant](../../administration/ai/assistant/index.md) · [dispatch](dispatch.md)

The in-process bridge between the web client's assistant (`tool_assistant`) and the shared MCP tool registry + agent loop. Unlike the previous engine's proxy to a separate MCP server process, this handler serves the JSON-RPC envelope in-process from the same tool registry the stdio server registers — no child process, no cookie forwarding.

Registered actions (`src/core/api/dispatch.ts`): `mcp_proxy`, `agent_models`, `agent_chat`, `agent_chat_stream`, `agent_apply`.

## How to call

- POST JSON to `/api/v1/json` (or the client-relative `/dedalo/core/api/v1/json`) with `dd_api: "dd_mcp_api"` and `action: "<method>"`.

## Notes

- Every action **fails closed** unless `DEDALO_AGENT_HTTP_ENABLED=true`; while off, each returns the generic `Undefined or unauthorized method (action)` denial (no existence leak).
- With the switch on, every action also requires the caller's **profile to grant the `tool_assistant` tool**; otherwise it answers `403` with the error code `tool.not_authorized`, before the action runs (so `agent_chat_stream` answers JSON and never opens a stream). Global administrators are not exempt; only the root account holds every tool. The check wraps every action of this class by construction, so a new action cannot be added without it.
- Every call runs under a **session** and passes the **CSRF** gate (none of these actions is login- or CSRF-exempt), as the logged-in user's principal — never a service principal.
- **Write capability** requires `DEDALO_AGENT_ALLOW_WRITE=true` and is **denied to global-admin principals** per request (the confused-deputy wall); `DEDALO_AGENT_WRITE_SECTIONS` narrows the writable sections. Write mode returns a change plan for confirmation — the loop never writes on its own.
- Egress: when the chosen catalog model's egress class is `external`, the loop gates every record-content tool call through the default-deny egress policy, so restricted repository content never reaches a third-party provider. Full config: [the assistant docs](../../administration/ai/assistant/configuration.md).

## mcp_proxy

### Purpose

The JSON-RPC 2.0 bridge to the MCP tool registry (the legacy `mcp_client.js` contract).

### Accepts

- `options`: object (required) — the JSON-RPC envelope (`jsonrpc`, `method`, `params`, `id`). Allowlisted methods only: `initialize`, `notifications/initialized`, `tools/list`, `tools/call`.
- `mcp_session_id`: string (required for every method except `initialize`) — the id `initialize` minted.

### Returns

The JSON-RPC result as the envelope's `data` (`{ ok: true, request_id, data: <json-rpc> }`). `initialize` mints a stateless `mcp_session_id`, carried as a top-level extension key beside `data`; a stale/missing id on any other method is the failure envelope `{ ok: false, error: { code: "mcp.session_invalid", message: "No valid MCP session ID provided", … } }` (HTTP 401) — the message is the literal the client's auto-recovery keys on. A JSON-RPC-level failure keeps the JSON-RPC numeric code and carries the envelope error body in `error.data`: a disallowed method is `-32601`, an unknown tool `-32602` (`error.data.code` = `request.invalid`, with `message`, `label_key`, `retryable`). A tool call's own outcome is the MCP structured envelope inside the JSON-RPC result: `{ ok: true, data, pagination? }` or `{ ok: false, error: { code, message, hint?, details? }, …extension keys }` where `code` is a registry error code (`request.invalid`, `resource.not_found`, `perm.denied`, `perm.out_of_scope`, `perm.section_not_writable`, `mcp.write_disabled`, `mcp.label_ambiguous`, `mcp.ambiguous_match`, `mcp.media_too_large`, `mcp.media_path_disabled`, `mcp.plan_hash_mismatch`, `mcp.egress_restricted`, `request.invalid_tipo`, …) and `hint` the registry's model-facing next move; a tool payload the model needs (`candidates`) rides beside `error`.

### Example Request

```json
{
  "dd_api": "dd_mcp_api",
  "action": "mcp_proxy",
  "options": { "jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {} },
  "mcp_session_id": "…"
}
```

## agent_models

### Purpose

Return the client-safe model catalog and whether write mode is available to this principal.

### Accepts

- No arguments.

### Returns

`{ ok: true, request_id, data: { models: [ { id, label, egress, vision } ], write_allowed: <bool> } }`. Endpoints, key names and provider-native model ids are never exposed. A broken catalog **throws** a public `ai.*` code, so the assistant is disabled with the operator's own sentence on the wire.

### Example Request

```json
{
  "dd_api": "dd_mcp_api",
  "action": "agent_models"
}
```

## agent_chat

### Purpose

Run the agent loop as the logged-in user and return a single JSON response.

### Accepts

- `options`: object (required)
  - `question`: string (required, ≤ 32768 chars)
  - `images`: array (optional, ≤ 8) — `{ media_type: image/jpeg|png|webp|gif, data_base64 }`, size-capped
  - `history`: array (optional, ≤ 64 entries) — `{ role: user|assistant, text }`
  - `context`: object (optional) — UI context (`section_tipo`, `section_id`, `component_tipo`, `mode`, `summary`)
  - `mode`: string (optional) — `write` requests write mode (honored only when write is enabled and the caller is not a global admin)
  - `model`: string (optional) — a catalog model id

### Returns

`{ ok: true, request_id, data: { answer, stop, change_plan, turns, model, usage, history } }`. In write mode `change_plan` carries a plan for confirmation (never written directly). A validation failure refuses with `request.invalid` (HTTP 400); a catalog or configuration problem throws a public `ai.*` code.

### Example Request

```json
{
  "dd_api": "dd_mcp_api",
  "action": "agent_chat",
  "options": { "question": "Summarize this record", "context": { "section_tipo": "oh1", "section_id": 368 } }
}
```

## agent_chat_stream

### Purpose

The SSE twin of `agent_chat` — the new `tool_assistant` chat surface.

### Accepts

- Same `options` as `agent_chat`.

### Returns

An `text/event-stream` of `start` / `thinking` / `text` / `tool_use` / `tool_result` / `iteration` / `final` / `error` frames plus `: ping` heartbeats. Validation failures **before** the stream opens are the normal JSON failure envelope (`{ ok: false, error: { code, … } }`, HTTP status from the code — `request.invalid` 400 for a malformed option, `ai.model_unknown` / `ai.model_no_vision` 400 and `ai.models_unconfigured` / `ai.model_catalog_invalid` 503 for catalog refusals, `request.unknown_action` 400 with the master switch off; the client branches on content-type). The terminal `error` frame's data is the envelope error body itself — `{ code, category, message, label_key, retryable, details?, hint? }` — a provider/transport failure mid-run is `ai.provider_failed` (its text never reaches the wire). A client abort stops delivery, not the in-flight loop (documented v1 limitation).

### Example Request

```json
{
  "dd_api": "dd_mcp_api",
  "action": "agent_chat_stream",
  "options": { "question": "What changed in this section recently?" }
}
```

## agent_apply

### Purpose

Execute a human-confirmed change plan (the plan the confirm card commits into).

### Accepts

- `options`: object (required)
  - `plan`: object (required) — the change plan returned by a write-mode chat
  - `plan_hash`: string (required) — the plan's hash, re-checked before applying

### Returns

`{ ok: true, request_id, data: { ok: true, data: <apply report> } }` — the report (`applied`, `skipped`, `created`, `failed?`) wrapped as the MCP structured envelope. The plan is hash-rechecked and every gate re-validated before any write; a plan refused as a whole is the failure envelope with its code (`request.invalid` 400 for a missing `plan`/`plan_hash` or a malformed plan, `mcp.write_disabled` 403, `mcp.plan_hash_mismatch` 409, `perm.denied` / `perm.section_not_writable` / `perm.out_of_scope` 403); a plan that ran and stopped on an op is a `data.data.failed` entry, not a failure envelope.

### Example Request

```json
{
  "dd_api": "dd_mcp_api",
  "action": "agent_apply",
  "options": { "plan": { /* … */ }, "plan_hash": "…" }
}
```
