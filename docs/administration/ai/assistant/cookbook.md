# Cookbook

> Part of the [AI Assistant](index.md) section · Previous: [Use cases](use_cases.md)

Concrete, copy-pasteable recipes. **Part A** is for the people who use the assistant — prompt patterns that get good results. **Part B** is for developers who want to drive the assistant from their own code, with the full wire protocol and working HTTP/SSE examples.

---

## Part A — for end users

The assistant is most reliable when your request gives it something to *resolve* rather than *guess*. A few habits go a long way.

### Recipe: find records about an idea

> **"Find every interview that talks about people having to leave their homes when the reservoir was built."**

Describe the *concept*, not a keyword. The assistant runs a semantic search and returns cited records. Then narrow conversationally:

> **"Only the ones from the upper valley."**
> **"Which of these also mention the church?"**

It keeps the context, so each follow-up refines the previous result set.

### Recipe: ask about the record in front of you

From a record's assistant panel (which sends the current record as context):

> **"Summarise this record."**
> **"What is in the *mint* field, and what else do we hold from that mint?"**
> **"Explain how this interview is linked to people."**

You don't need to name sections or fields — "this record", "this field", "this mint" resolve from the open record.

### Recipe: propose an edit (write mode)

> **"Create a person record for Anna Pujol, born 1931 in Súria, and link her as the informant of this interview."**

The assistant will **propose a change plan**, not perform it. Read the confirm card — each row shows the tool and the *actual arguments* — then click **Apply** or **Cancel**. If a row is wrong, click Cancel and refine your request. It dedupes people/places automatically (it checks for an existing Anna Pujol before creating one).

### Recipe: work on protected material privately

Before starting, open the model picker and choose the model badged **local / private**. Everything in that conversation stays on your institution's infrastructure. If you're on an external model and the assistant says a record is *restricted from external providers*, switch to the local model and ask again.

### Recipe: read an image

With a vision-capable model selected, use the **attach** button (or attach the current record's image) and ask:

> **"Transcribe the legend visible on this coin."**
> **"Describe the iconography on the reverse."**

Treat the result as a first draft to verify, not a final transcription.

### Habits that help

- **Name the goal, let it resolve the tipos.** "the People section" beats "dd123".
- **One question at a time**, then refine — the assistant threads the conversation.
- **If a name is ambiguous**, it will show candidates and ask; pick one.
- **If it found nothing, it will say so.** It answers from tool results and won't invent records.

---

## Part B — for integrators

Everything the browser panel does is available to your own code, through four actions on the `dd_mcp_api` class of the work JSON API. All of them require the assistant to be [enabled](install.md) and run under a **normal authenticated session** (login cookie + CSRF token); none is login- or CSRF-exempt.

**The four actions:**

| Action | Shape | Response |
|---|---|---|
| `agent_models` | `{}` | the secret-free model catalog + `write_allowed` |
| `agent_chat` | `{question, model?, history?, context?, images?, mode?}` | one JSON answer (non-streaming) |
| `agent_chat_stream` | same options | a Server-Sent Events stream |
| `agent_apply` | `{plan, plan_hash}` | the apply report |

The endpoint is the work JSON API (`/dedalo/core/api/v1/json/`); every request is `POST` with a body of `{action, dd_api:"dd_mcp_api", options:{…}}`.

### Step 1 — authenticate

```bash
API=http://localhost:3500/dedalo/core/api/v1/json/     # dev TCP port; production goes through the proxy/socket
COOKIE=$(mktemp)

CSRF=$(curl -s -c "$COOKIE" -X POST "$API" \
  -H 'Content-Type: application/json' \
  -d '{"action":"login","dd_api":"dd_utils_api","options":{"username":"USER","auth":"PASS"}}' \
  | python3 -c 'import sys,json; print(json.load(sys.stdin)["csrf_token"])')
```

Every subsequent call sends the cookie and `-H "X-Dedalo-Csrf-Token: $CSRF"`.

### Step 2 — list the models

```bash
curl -s -b "$COOKIE" -X POST "$API" \
  -H 'Content-Type: application/json' -H "X-Dedalo-Csrf-Token: $CSRF" \
  -d '{"action":"agent_models","dd_api":"dd_mcp_api","options":{}}'
```

```json
{
  "result": true,
  "data": {
    "models": [
      { "id": "local", "label": "Llama 3.1 (local)", "egress": "local", "vision": false, "default": true },
      { "id": "claude", "label": "Claude Opus 4.8", "egress": "external", "vision": true, "default": false }
    ],
    "write_allowed": false
  }
}
```

Use `write_allowed` to decide whether to offer `mode:"write"`; use `egress` to badge the model in your UI.

### Step 3 — ask a question (streaming)

`agent_chat_stream` returns a Server-Sent Events stream. Request it with `Accept: text/event-stream`:

```bash
curl -s -N -b "$COOKIE" -X POST "$API" \
  -H 'Content-Type: application/json' -H 'Accept: text/event-stream' \
  -H "X-Dedalo-Csrf-Token: $CSRF" \
  -d '{
        "action": "agent_chat_stream",
        "dd_api": "dd_mcp_api",
        "options": {
          "question": "what sections can I search?",
          "model": "local",
          "context": { "section_tipo": "oh1", "section_id": 1, "mode": "edit" }
        }
      }'
```

The stream is a sequence of named events. The response headers are `Content-Type: text/event-stream`, `X-Accel-Buffering: no`, `Cache-Control: no-cache`.

#### The SSE event protocol

| Event | Payload | Meaning |
|---|---|---|
| `start` | `{model, mode, egress}` | first frame — which model, read/write, privacy class |
| `thinking` | `{state:"start"\|"stop"}` | the model began/finished a thinking block (indicator only; no reasoning text) |
| `text` | `{delta}` | a chunk of the visible answer — concatenate to build the answer |
| `tool_use` | `{id, name, summary}` | the loop is running a tool (e.g. `dedalo_search_records`), with a human summary |
| `tool_result` | `{id, name, ok, code}` | that tool finished; `ok:false` carries the registry error `code` (e.g. `mcp.egress_restricted`) |
| `iteration` | `{n, max}` | a new model turn began (progress) |
| `final` | see below | the terminal success frame |
| `error` | `{code, category, message, label_key, retryable, details?, hint?}` | terminal failure — the envelope error body itself (`ai.provider_failed` for a provider/transport fault, a catalog code, …); `hint` is the registry's next move |

Comment lines beginning `:` (e.g. `: ping`) are heartbeats — ignore them.

The **`final`** frame carries everything you need to render the turn and continue the conversation:

```json
{
  "answer": "You can search these sections: …",
  "stop": "end_turn",
  "change_plan": null,
  "history": [
    { "role": "user", "text": "what sections can I search?" },
    { "role": "assistant", "text": "You can search these sections: …" }
  ],
  "transcript_summary": [ /* bounded per-turn audit view */ ],
  "usage": { "input_tokens": 812, "output_tokens": 96 },
  "turns": 3,
  "model": "local"
}
```

!!! important "Multi-turn is stateless — you hold the history"
    The server keeps **no** conversation state. To continue a conversation, resend `final.history` verbatim as the next request's `options.history`, and append your new question. The history is **text-only** (`{role, text}`) — prior tool traffic is never replayed (a client could otherwise fabricate tool results). The model re-runs tools when it needs data.

#### Validation refuses *before* the stream opens

If the request is invalid (missing question, unknown model, images on a non-vision model, master switch off), the server answers with a **plain JSON** failure envelope `{"ok":false,"request_id":…,"error":{"code":"ai.model_unknown","message":"Unknown model \"x\" — pick one from agent_models",…}}` and the code's HTTP status (400 for `request.invalid` / `ai.model_unknown` / `ai.model_no_vision`, 503 for `ai.models_unconfigured` / `ai.model_catalog_invalid`) — *not* an SSE stream. Branch on the response `Content-Type`: `text/event-stream` ⇒ consume events; anything else ⇒ parse the JSON error. The browser client does exactly this, which also lets it fall back to the non-streaming `agent_chat` transparently.

### A browser / Node SSE consumer

`EventSource` can't POST, so consume the stream from `fetch`:

```js
async function askAssistant({ question, model, history = [], context, csrf, signal, onDelta, onTool, onFinal, onError }) {
  const res = await fetch('/dedalo/core/api/v1/json/', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', 'Accept': 'text/event-stream', 'X-Dedalo-Csrf-Token': csrf },
    signal, // an AbortController signal — call abort() to stop
    body: JSON.stringify({ action: 'agent_chat_stream', dd_api: 'dd_mcp_api',
      options: { question, model, history, context } }),
  });

  // content-negotiate: a JSON body means the server refused before streaming
  if (!(res.headers.get('Content-Type') || '').includes('text/event-stream')) {
    const env = await res.json();
    return onError({ code: 'denied', message: env.msg });
  }

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const records = buf.split('\n\n');
    buf = records.pop();                                   // keep the unfinished tail
    for (const rec of records) {
      let event = 'message'; const data = [];
      for (const line of rec.split('\n')) {
        if (line.startsWith(':') || !line) continue;       // heartbeat / blank
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
      }
      if (!data.length) continue;
      const payload = JSON.parse(data.join('\n'));
      if (event === 'text')  onDelta(payload.delta);
      if (event === 'tool_use') onTool(payload);
      if (event === 'final') onFinal(payload);             // includes .history and .change_plan
      if (event === 'error') onError(payload);
    }
  }
}
```

To continue the conversation, pass the previous `final.history` back in as `history`. To stop generation, `abort()` the signal (note: aborting stops *delivery*; the server-side loop runs to completion).

### Step 4 — apply a proposed change (write mode)

Send `mode:"write"` (only when `write_allowed` is true). Instead of answering, a write turn returns a **change plan** on the `final` frame:

```json
{
  "answer": "I'll create Anna Pujol and link her to this interview.",
  "stop": "change_plan",
  "change_plan": {
    "plan_version": 1,
    "summary": "Create person Anna Pujol and link as informant",
    "ops": [
      { "op_id": "p1", "tool": "dedalo_find_or_create",
        "args": { "section_tipo": "rsc197", "match": { "…": "…" }, "set": { "…": "…" } },
        "summary": "Find or create person Anna Pujol" },
      { "op_id": "l1", "tool": "dedalo_portal_link",
        "args": { "section_tipo": "oh1", "section_id": 1, "field": "oh24", "target": { "ref": "p1" } },
        "summary": "Link the person as informant of this interview" }
    ],
    "plan_hash": "…sha256…"
  }
}
```

Nothing has been written. Show the plan to a human (each op's `tool` + real `args`), and on confirmation POST it back **unchanged, with its hash**:

```bash
curl -s -b "$COOKIE" -X POST "$API" \
  -H 'Content-Type: application/json' -H "X-Dedalo-Csrf-Token: $CSRF" \
  -d '{"action":"agent_apply","dd_api":"dd_mcp_api","options":{"plan": <the change_plan>, "plan_hash":"…sha256…"}}'
```

The server recomputes the hash (so what runs is byte-for-byte what was confirmed), re-validates every permission and scope gate, then executes the ops sequentially. The response:

```json
{
  "ok": true,
  "request_id": "…",
  "data": {
    "ok": true,
    "data": {
      "applied": [ { "op_id": "p1", "result": "…" }, { "op_id": "l1", "result": "…" } ],
      "skipped": [],
      "created": { "p1": 4213 }
    }
  }
}
```

`created` maps a create-op's `op_id` to the new record's `section_id`. On a partial failure `data.data.failed` carries `{op_id, error:{ok:false, error:{code,message,hint?}}}`; a plan refused as a whole (hash mismatch, write opt-in off, a permission wall) is a failure envelope `{"ok":false,"error":{"code":"mcp.plan_hash_mismatch",…}}` with the code's HTTP status (re-propose, never edit a confirmed plan in place). Ops execute stop-on-first-error; `find_or_create` match keys make retries idempotent.

### Non-streaming variant

For a bridge that can't consume SSE, `agent_chat` takes the same `options` and returns one JSON envelope with `data:{answer, stop, change_plan, turns, model, usage, history}`. It has no heartbeats, so prefer `agent_chat_stream` for anything user-facing behind a proxy (a long non-streaming turn can hit proxy read timeouts).

---

## The tools the agent can call

For reference, the agent's tool surface (the same registry the [stand-alone MCP server](configuration.md#the-stand-alone-mcp-server-dedalo_mcp_) exposes), all ACL-gated and — on external models — egress-gated:

- **Discovery** (never guess a tipo, called first): `dedalo_list_sections`, `dedalo_describe_section`, `dedalo_resolve`, `dedalo_resolve_path`, `dedalo_describe_node`.
- **Read:** `dedalo_read_record`, `dedalo_search_records`, `dedalo_count_records`, `dedalo_search_section`, `dedalo_get_media_info`, plus the loop-local `dedalo_semantic_search`.
- **Write** (write mode only, via the change plan): `dedalo_create_record`, `dedalo_duplicate_record`, `dedalo_delete_record`, `dedalo_set_field`, `dedalo_save_component`, `dedalo_portal_link`, `dedalo_portal_unlink`, `dedalo_find_or_create`, `dedalo_upload_media`.

You do not call these directly through the assistant API — the agent chooses them. They are listed so you can recognise them in `tool_use` events and understand what a change plan's ops will do.
