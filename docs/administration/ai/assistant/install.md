# Installing & enabling the AI Assistant

> Part of the [AI Assistant](index.md) section · Next: [Connecting models](connecting_models.md) · See also: [Configuration reference](configuration.md) · [Installation](../../../install/production.md)

The assistant ships with every Dédalo v7 installation — there is nothing to install. It is **off by default** and becomes available once you (1) turn on the server-side switch and (2) make at least one model reachable. This page walks the full first run.

!!! info "Prerequisites"
    - A running Dédalo v7 (TypeScript/Bun) server — see [Installation](../../../install/production.md).
    - Write access to `../private/.env` (the private config directory, outside the web root).
    - **One** of: an Anthropic API key, **or** a local model endpoint that speaks the OpenAI chat-completions API with tool calling (Ollama, vLLM, LM Studio…). Connecting models is the next page; this page assumes you have picked one.

---

## Step 1 — turn on the master switch

Add one line to `../private/.env` and restart the server (config is read once at boot):

```bash
DEDALO_AGENT_HTTP_ENABLED=true
```

This is the install-wide fail-closed gate for the whole feature. With it unset or `false`, every assistant request (`agent_models`, `agent_chat`, `agent_chat_stream`, `agent_apply`) is refused exactly like an unregistered action, and the chat panel renders a disabled message. Nothing about the assistant is reachable until this is `true`.

## Step 1b — grant the tool to the profiles that should use it

With the switch on, a user can use the assistant only when **their profile grants the `tool_assistant` tool** (the profile editor's tool list). Every request from a user whose profile does not grant it is refused with `tool.not_authorized` — global administrators included; only the root account holds every tool. Grant it to each profile whose users should have the assistant.

## Step 2 — make a model reachable

The assistant needs a model to talk to. The simplest path — a single cloud model — is just a key:

```bash
DEDALO_AGENT_HTTP_ENABLED=true
ANTHROPIC_API_KEY=sk-ant-...
```

With no explicit catalog, this creates an **implicit single-model catalog**: one Anthropic model (the value of `AGENT_MODEL`, defaulting to `claude-opus-4-8`), classed `external`. That is enough to start.

For a **local, fully private** model, or for offering the user a **choice** of models, you define an explicit catalog with `DEDALO_AGENT_MODELS`. That is the whole subject of [Connecting models](connecting_models.md); a minimal local example:

```bash
DEDALO_AGENT_HTTP_ENABLED=true
DEDALO_AGENT_MODELS=[{"id":"local","label":"Llama 3.1 (local)","provider":"openai_compatible","model":"llama3.1:70b","endpoint":"http://127.0.0.1:11434/v1/chat/completions","egress":"local"}]
```

!!! warning "Restart to apply"
    `../private/.env` is read at boot. After any change here, restart the Dédalo server. If a value seems not to take effect, that restart is almost always the reason.

## Step 3 — (optional) allow edits

By default the assistant is **read-only**: it can search, read and explain, but the write tools are not even offered to the model. To let it *propose* edits (which a human still confirms), opt in:

```bash
DEDALO_AGENT_ALLOW_WRITE=true
DEDALO_AGENT_WRITE_SECTIONS=oh1,rsc197        # optional allowlist of writable sections
```

Two things stay true regardless: the loop that talks to the model **never writes** (it only produces a change plan you confirm), and write capability is **refused to global-administrator sessions** as a confused-deputy safeguard — use a scoped, least-privilege account for write work. See [Privacy & security](privacy_and_security.md#write-mode-propose--confirm--apply).

---

## Where the assistant appears

Once enabled, the assistant surfaces in the work client in **two places**:

1. **A modal**, opened from the tool button on a section toolbar (`register.json` sets `open_as: "modal"`).
2. **A side panel in the edit menu**, opened from the assistant button next to a record — this is the inline "ask about what I'm looking at" panel. It sends the current record as context with each turn.

Both drive the same server agent; they differ only in framing. The panel is the one most catalogers use day to day.

## Verify it works

**From the UI:** open a record, click the assistant button, and confirm the model picker in the settings shows your configured model(s), each with a **local / private** or **external service** badge. Send *"what sections exist?"* — you should see the answer stream in, with a brief "searching…" tool indicator.

**From the command line** (checks the whole server path — session, CSRF, catalog — without a browser). Log in, then list the models:

```bash
API=http://localhost:3500/dedalo/core/api/v1/json/
COOKIE=$(mktemp)

# 1. log in (use your dev credentials) and capture the CSRF token
CSRF=$(curl -s -c "$COOKIE" -X POST "$API" \
  -H 'Content-Type: application/json' \
  -d '{"action":"login","dd_api":"dd_utils_api","options":{"username":"USER","auth":"PASS"}}' \
  | python3 -c 'import sys,json; print(json.load(sys.stdin)["csrf_token"])')

# 2. ask the server which models the assistant offers this user
curl -s -b "$COOKIE" -X POST "$API" \
  -H 'Content-Type: application/json' -H "X-Dedalo-Csrf-Token: $CSRF" \
  -d '{"action":"agent_models","dd_api":"dd_mcp_api","options":{}}'
```

A healthy response looks like:

```json
{
  "result": true,
  "data": {
    "models": [
      { "id": "local", "label": "Llama 3.1 (local)", "egress": "local", "vision": false, "default": true }
    ],
    "write_allowed": false
  }
}
```

Notice what is **not** there: no endpoint URL, no key name, no provider-native model id. The catalog the client sees is deliberately secret-free (see [Privacy & security](privacy_and_security.md#the-model-catalog-never-leaks-secrets)).

---

## Troubleshooting

**`agent_models` returns `{"result":false,"msg":"Undefined or unauthorized method (action)"}`.**
The master switch is off for the process serving that request. Confirm `DEDALO_AGENT_HTTP_ENABLED=true` is in the `.env` the running server actually loaded, and that you restarted *that* process. A common trap is a second server instance (a `--watch` dev server) still holding the socket with the old environment.

**The chat panel says the assistant is disabled.**
Same cause as above, seen from the browser: `agent_models` refused, so the client fell into its disabled state. Fix the switch and reload the page.

**Every assistant request answers `tool.not_authorized` (403).**
The switch is on, but the user's profile does not grant the `tool_assistant` tool. Grant it in the profile editor (global administrators need it too; only the root account holds every tool), then reload the page.

**The picker is empty / "No assistant models configured".**
Neither `DEDALO_AGENT_MODELS` nor `ANTHROPIC_API_KEY` is set (or the catalog JSON is malformed — a malformed catalog disables the assistant fail-closed). Validate the JSON and check the server log for a `DEDALO_AGENT_MODELS[...]` parse message. See [Connecting models](connecting_models.md#validation-and-fail-closed-rules).

**`GET .../tool_assistant/js/ai_assistant.js 404` / "Failed to fetch dynamically imported module".**
This is a static-asset serving problem, not a config one. The edit-menu panel imports `ai_assistant.js` (a small compatibility module) by name; if it 404s, the tool's client files are not being served. Confirm the server serves `/dedalo/tools/tool_assistant/js/` and that you are on a build that includes it.

**Answers stall or die after ~30 seconds behind a reverse proxy.**
The chat is a long-lived Server-Sent Events stream. Your proxy must not buffer it and must allow a generous read timeout. The assistant already sends heartbeats and `X-Accel-Buffering: no`; on nginx, add `proxy_buffering off;` and a generous `proxy_read_timeout` (e.g. `300s`) to the proxied location.
