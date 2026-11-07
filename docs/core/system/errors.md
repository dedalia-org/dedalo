# errors

> See also: [Error system cookbook](../../development/errors_cookbook.md) · [api](api.md) · [Dédalo API v1](../../api/dedalo_api_v1.md) · [data_manager](../client/data_manager.md) · [RQO](../rqo.md) · [Tool server contract](../../development/tools/server_contract.md)

The error subsystem is Dédalo's **closed vocabulary of failure**. Every refusal the engine
reports — over the JSON API, a tool response, a stream frame or the assistant bridge —
carries exactly one **registered code**, and exactly one function turns a thrown value into
a wire body. This page is the developer reference for that system: what to throw, what
reaches the caller, what the browser does with it, and how to add a code.

The normative specification is `engineering/ERRORS_SPEC.md`; this page teaches the model
and the day-to-day workflow.

## What a failure IS

A failure is a **throw of a `DedaloError` carrying a registered code**. It is never a
returned body:

```ts
// success — the payload goes in `data`; owned top-level fields ride as `extend`
return { status: 200, body: ok({ context, data: rows }, { requestId: context.requestId }) };

// failure — throw. The dispatcher converts it; the status comes from the registry
throw new DedaloError('perm.denied', { coordinates: { section_tipo, section_id } });
```

Three rules follow, and all three are mechanically enforced:

- **Handlers throw to fail and return `ok(...)` to succeed.** No handler, helper or route
  may build a body carrying `ok`, `error` or the retired `result` / `msg` / `errors` failure
  keys. A helper may exist only if it *throws* (returning `never`).
- **One code, never prose.** A caller cannot act on a sentence, an operator cannot count
  one, and a translator cannot translate one. Branch on `error.code`; never on
  `error.message`.
- **A body without `ok` is a bug, not a compatibility case.** The dispatcher's own catch
  refuses it as `internal.unexpected`, so a half-shaped body can never reach the wire and
  appear to work.

The code lives in the registry — `src/core/errors/registry.ts` — which is the ONLY place a
code may be born. The typed throw is `src/core/errors/dedalo_error.ts`; the converter is
`src/core/errors/convert.ts`; the envelope schema is `src/core/errors/schema.ts`.

## The registry

`ERROR_REGISTRY` is a data table: code → specification. Every field is authored
explicitly, none is derived at runtime.

| field | meaning |
| --- | --- |
| `category` | one of eight, and it *is* the HTTP status: `caller` 400 · `auth` 401 · `permission` 403 · `not_found` 404 · `conflict` 409 · `limit` 429 · `unavailable` 503 · `internal` 500. A code needing another status is another code. |
| `status` | the HTTP status; must equal the category's, unless the code is a named exemption with its reason beside it. |
| `label_key` | the UI label key the browser renders — by convention `error_<code with the dot as an underscore>`, or a pre-existing key that already says the same thing (`perm.denied` reuses `no_access_page`). |
| `message` | registry-owned English, for logs and command-line use. It **never** interpolates caller data. |
| `severity` | `info` / `warn` log through `console.info` / `console.warn`; `error` / `fatal` through `console.error`. An expected refusal (an expired session) is `info` — traffic, not a fault. |
| `disclosure` | `public` means a vetted `publicMessage` from the throw site may replace `message` on the wire; `operator` means it never can. |
| `retryable` | whether a later attempt could plausibly succeed. The client's retry policy and the `Retry-After` header for `limit` / `unavailable` read it. |
| `details_keys` | the ONLY `details` keys the converter lets onto the wire, scalars only. The label's `${param}` placeholders equal this list, both ways — written with the `$`: the client fills `${param}` only, so a bare `{param}` would reach the user verbatim (`error_registry_native`). The one exception is `reason_key`, which names no placeholder (see [A tool's refusal reason](#a-tools-refusal-reason)). |
| `hint` | the model-facing next move, used by the assistant bridge's structured errors. |
| `reason` | a named exemption: why the code exists although no engine path throws it (a client-minted or reserved code). |

Codes follow the grammar `<domain>.<condition>` (`^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$`). The
domain is the subsystem that owns the refusal — `auth`, `perm`, `request`, `record`,
`section_id`, `tool`, `mcp`, `external`, `diffusion`, `internal`, and so on — and it is
queryable: `isErrorInDomain(error, 'section_id')` is how a catch site recognises a family
without reaching for a built-in error class.

!!! note "Category is a wire fact, not blame"
    `internal` means "the engine could not honour a well-formed request". It is the only
    category whose message never varies per throw, and it never echoes the wrapped
    exception.

## Envelope v2

Every JSON body is one of exactly two shapes, discriminated by `ok`. A success:

```json
{
  "ok": true,
  "request_id": "5f2a…",
  "data": { "context": [], "data": [] },
  "notices": [
    { "code": "record.delete_children_refused",
      "label_key": "error_record_delete_children_refused",
      "retryable": false,
      "details": { "not_deleted": "12,17" } }
  ],
  "csrf_token": "…"
}
```

A failure:

```json
{
  "ok": false,
  "request_id": "5f2a…",
  "error": {
    "code": "perm.denied",
    "category": "permission",
    "message": "Insufficient permissions",
    "label_key": "no_access_page",
    "retryable": false
  },
  "csrf_token": "…"
}
```

- `request_id` is top level on **both** shapes — the one join key to the access log line,
  which also carries `error_code` and `error_category` on a failure.
- **The HTTP status is an error channel**: `ok:false` always means a non-2xx status, and the
  status is the category's. `auth.not_logged` is a 401 with `label_key`
  `error_auth_not_logged`; `perm.denied` is a 403. `limit` and `unavailable` failures may
  carry `Retry-After`.
- `data` is the whole payload. A handler never puts payload anywhere else.
- The schema (`apiEnvelopeSchema`) is a discriminated union on `ok` with
  `error.code` typed as the enum of registered codes, so registry totality reaches every
  consumer that parses a body. [RQO](../rqo.md) re-exports it as the live response schema.

The full wire-level description of the two shapes, including the status table, is in the
[API reference](../../api/dedalo_api_v1.md#response-envelope).

### Notices — the non-fatal channel

A **notice** is a coded fact about a *successful* answer: `{code, label_key, retryable,
details?}`, carried in `notices[]` beside `data`. Degradation is a notice, never an error —
an external source that timed out, a partial delete, a truncated value. The request was not
wrong, so the response is `ok:true` and the payload stays.

The record-delete path is the canonical producer: children that refused to go are reported
as `record.delete_children_refused` with the refused ids in its one declared detail, while
the records that *were* deleted remain the payload.

!!! tip "Choosing between a notice and a failure"
    Ask what the caller keeps. If there is a usable answer and something about it is worth
    saying, it is a notice. If there is no answer at all, throw.

### Extension keys

A handler may put fields it **owns** at top level beside the envelope keys — `total`,
`job_id`, `pid`, `environment`, `saml_redirect`, `action`, and the maintenance widgets'
`msg` / `errors` reports. They are passed as `extend` and spread *first*, so a reserved
envelope key (`ok`, `request_id`, `data`, `notices`, `error`) can never be overridden by
one. Payload data belongs in `data`; the extension set is closed and frozen by a gate.

One name is **forbidden** on both shapes: `result`. It was the retired mirror of `data`, and
a body carrying it fails the schema at parse time — which is what makes a converter
regression impossible to land quietly. An extension key on a *failure* is exceptional and
named: the `start` refusal carries `environment` (the labels the refused client needs for
its no-access page), and the CSRF gate carries `action` with a fresh token.

`csrf_token` is appended by the dispatcher to every response of a session, success and
failure alike, and beside it `session_user_id` — the user the token belongs to. A handler
never sets them (login excepted: it mints the session). The client adopts a token only for
its own page user, so a session replaced by another user's login never carries a page over.

## The disclosure ladder

What reaches the wire is decided in one place, `toErrorBody`, and only these four rungs:

1. **`message`** is the registry English — replaced by the throw's `publicMessage` **only**
   when the code's disclosure is `public`. A public code is one whose sentence is written
   *for* the caller: `request.invalid_options` naming the offending option, the assistant
   tool refusals echoing the model's own input back at it.
2. **`details`** is the throw's `details` filtered to the code's `details_keys`, scalars
   only. A non-scalar under a declared key is dropped, never stringified. `reason_key`
   must also look like a key (`^[a-z][a-z0-9_]{0,47}$`), or it is dropped too.
3. **`coordinates`** (tipo, section_id, job id) and `cause` are **log-only** and never
   serialized. An `internal.*` failure never echoes the exception it wrapped.
4. **`debug`** — `{exception, stack, coordinates, cause_chain}` — appears only when the
   installation runs with `DEDALO_DEBUG_API_ERRORS=true`. The literal `debug` exists in
   exactly one source file, the converter, and one schema.

!!! warning "`DEDALO_DEBUG_API_ERRORS` is a development switch"
    It puts stack traces and record coordinates on the wire. Leave it off in production;
    the `request_id` plus the access log is the supported way to trace a failure.

Classification happens in `toDedaloError`: a `DedaloError` passes through untouched; a
temporal-dead-zone `ReferenceError` — raw, or anywhere in the `cause` chain — flips the
process poison latch and becomes `internal.module_poisoned`; anything else becomes
`internal.unexpected` carrying the original as a log-only `cause`. Because the latch lives
in the converter and not in the dispatcher's catch, tool, stream and assistant paths latch
too.

## The client side

The browser half is a small family of pure modules under `client/dedalo/core/common/js/`,
described in full on the [data_manager](../client/data_manager.md) page.

- **`ApiError` (`api_error.js`)** is the ONE client-side error model. Every failure — an
  `ok:false` envelope, a transport rejection, an unparseable stream frame — becomes one, and
  the client dispatches on `api_error.code` only. Failures the client itself produces (no
  answer reached it) use the `client.*` domain: `client.network`, `client.timeout`,
  `client.aborted`, `client.bad_response`, `client.http_status`, `client.worker`,
  `client.offline` — and `client.render_failed`, minted by `ui.load_item_with_spinner`
  when a render callback throws: the error panel takes the place the node would
  have had, so a failed build is never an empty container.
- **`request_failed(api_response)`** is THE test for a failure, and
  **`response_data(api_response)`** is the one payload accessor. A handler-owned top-level
  field is read through `response_extension(api_response, key)`, never as the error channel.
- **`error_text(api_error)` (`render_api_error.js`)** resolves the sentence to show: the
  `label_key` in the user's language first, then the registry `message`, then the code.
  Because the label carries the translation, a failure is localized like everything else.
  A tool's refusal (`details.reason_key` on a request that named a tool) goes first
  through the tool's own `reason_<key>` label and then the wire `message`; see
  [A tool's refusal reason](#a-tools-refusal-reason). The renderer never uses an
  HTML-parsing sink — a message can contain user-typed text.
- **`handle_api_error(api_error, ctx)` (`error_dispatch.js`)** executes the policy and
  resolves `{recovered}`; a caller that can retry just awaits it. The policy table
  (`error_policy.js`) maps a code to one action, resolved exact code → `<domain>.*` → `*`:
  `relogin`, `no_access_page`, `page_panel`, `csrf_retry`, `toast`, `modal`, `inline`,
  `silent`. `auth.not_logged` relogs in and retries; `perm.*` shows the no-access page;
  `record.in_use` is a modal; `validation.*` renders inline next to the field.
- **The page panel belongs to the page.** `no_access_page` and `page_panel` take the whole
  page (`page_globals.page_error`) only when the refused request was the page's own — the
  page build, or the element the page opened (`ctx.page_scope: true`). A refusal inside an
  embedded element — an inspector block, a portal, a tool panel — stays in that element: its
  wrapper gets the panel, or the element renders its own short failure line, and every other
  element on the page keeps working. It is never silent: an element whose build was refused
  draws that refusal wherever it is rendered, even when the code that opened it does not check
  the failed build. Navigating to another element clears the page panel.
- **Notices** go through the same table via `handle_api_notice`, at severity `warning` and
  with page-level actions suppressed — the request succeeded, so nothing may take the page
  away from the user. A caller that wants to render a notice itself claims ownership when it
  makes the request.

A tool or area registers its own domains additively with `register_error_policy`; a core
entry can never be overridden, and an attempt throws in development so it is found.

## Streams

A stream frame is a **frame, not an envelope**: `toStreamFrame(error)` produces
`{is_running:false, error:{…}}`, where `error` is the same error body the envelope carries.
The assistant's SSE run ends with an `event: error` whose data is that body plus the
registry `hint` — the event name already says "terminal", so the frame needs no `ok`. A
provider or transport failure mid-run is `ai.provider_failed` (503, retryable) with the raw
error kept as a log-only cause. Diffusion persists the failed job's result *as* the
follow-stream's terminal frame, so the report the user reads and the frame the stream
emitted are the same object; a plan that failed to compile is public-disclosure, so the
compiler's cause list survives to the report, while anything the run did not type is an
operator-disclosure `diffusion.run_failed`.

## The assistant bridge

The assistant's structured failure is `toStructuredErr(error)`:
`{ok:false, error:{code, message, hint?, details?}, …extend}` — the same registry code, plus
the code's `hint` as the model-facing next move. Assistant-facing codes are deliberately
**public disclosure**: the tool authors the sentence for the model as `publicMessage` and it
is the wire message, because a caller's own input echoed back is the whole value of a 400 or
a 404. A payload the model needs that is not a scalar — the candidate list behind an
ambiguous label — rides in `extend` at top level beside `error`. The JSON-RPC layer keeps
its own numeric codes and carries the error body in `error.data`. Tool responses over the
HTTP API *are* the envelope: see the [tool server contract](../../development/tools/server_contract.md).

## Adding a code

1. **Register the row** in `ERROR_REGISTRY` (`src/core/errors/registry.ts`): category (which
   fixes the status), `label_key`, registry English `message`, `severity`, `disclosure`,
   `retryable`, `details_keys` if and only if the label has `{params}`, a `hint` for a
   model-facing code, and a `reason` only when no engine path throws it.
2. **Add the label** to `src/core/labels/master.json`, sorted, in the **same commit** — the
   code and its label ship together.
3. **Throw it** at the site: `throw new DedaloError('<code>', {…})`, with `coordinates` for
   log-only identifiers, `publicMessage` only for a public-disclosure code, and `extend` only
   for a named extension key.
4. **Add or extend a test** that proves the site refuses the way you claim it does. If the
   browser needs a non-default action, add the code (or its `<domain>.*`) to the client
   policy table as well.
5. **Write the wire-contract entry** if the wire changed — a new code on an existing
   response, a status change, a notice where a failure used to be. The contract ledger is
   the wire law, and the entry lands the same day.

Nothing in the dispatcher or the HTTP layer changes when you add a code. That is the point
of the registry.

## A tool's refusal reason

A tool that must say *why* it refused, in the user's language and in its own words, does
not mint a code. It throws an **existing public code** with `details.reason_key`, one key
of a **closed list the tool declares**. Five codes carry the key — `request.invalid_options`
(a bad parameter), `resource.not_found` (an unknown or forbidden id, one identical
refusal), `tool.unsupported_target`, `tool.source_unavailable` and `media.too_large` — and
all five are public, so the English sentence the tool declared for the key rides the wire as
`message`.

```ts
// server/index.ts — the closed map: each key with its English fallback sentence (not an action)
export const tool: ToolServerModule = {
	name: 'tool_example_maps',
	reasonKeys: {
		bad_bbox: 'The bounding box is not numeric.',
		source_down: 'The map server is not answering.',
	},
	apiActions: { /* … */ },
};

// the throw site — the key only; the sentence is the declaration's
throw new DedaloError('request.invalid_options', {
	details: { reason_key: 'bad_bbox' },
});
```

The translated sentence lives in the tool's `register.json` labels as `{lang, name:
'reason_bad_bbox', value}` — one per language the tool carries, always `lg-eng`. The
English fallback is declared once, beside the key, and the loader vets it when it admits
the tool: a non-empty string of 200 characters at most, with no control character, line or
paragraph separator, or invisible formatting character (a bidi override, a zero-width
space). The throw carries no `publicMessage`: the guard puts the declared sentence on it,
so nothing a request or an upstream produced can reach the one field the browser prints
as it arrives. A throw that brings a *different* sentence is refused, not printed.

The loader wraps every handler, `admit` hook and route of the tool. A key outside the
list, a code that does not carry the key, or a sentence other than the declared one
becomes `internal.invariant`, so a mistake is loud instead of a detail silently dropped.
This holds for a refusal the handler throws and for a failure envelope it returns. A
refusal the tool *embeds* in its answer instead (the per-item errors of a batch) goes
through `toolErrorBody(tool, action, error)`, which makes the same check and logs the
refusal it replaces — a tool that declares reasons names none of the converter's body
builders (`toErrorBody`, `toErrorEnvelope`, `toStructuredErr`, `toFailureRecord`,
`toStreamFrame`) at all.

!!! warning "`tool.source_unavailable` is retryable"
    The browser transport resends a retryable error, and a mutating action's first
    attempt leaves an *ambiguous* reservation under its idempotency key, so the resend is
    answered `idempotency.outcome_unknown` and the user never sees your reason. Refuse
    with `tool.source_unavailable` from a [read-only action](../../development/tools/server_contract.md#read-only-actions-readonly-true)
    called with the literal `retries: 1`; from any other action pick a code that is not
    retryable (`tool.unsupported_target`, `request.invalid_options`), or pass `retries: 1`
    on that `tool_request(` call.

In the browser, `data_manager` stamps `ApiError.tool` from the `tool_request` it sent, the
tool registers its `reason_*` labels when it builds, and `error_text` resolves **tool label
→ wire `message` → the core label → the code**. The user reads one notice, translated when
the tool is. The language of `context.labels` is the application language; a tool with no
labels in it serves an empty list, and the fallback is the declared sentence. A label may use
only the `${param}` the code declares (`${site}` on `tool.source_unavailable`) and never
`%s`; the browser does not show a label it cannot fill completely.

A refusal that arrives as a stream or job frame (a background action that throws) does not
say which tool it belongs to, so the tool's own panel names it:
`render_stream({container, id, tool: self.model})`, or
`normalize_stream_error(frame, {tool: self.model})` where the tool reads a frame itself. The
page's job tray lists jobs of every kind and names no tool, so it shows the core label.

`tool_reason_keys_tripwire` holds the rest: every literal key is declared, every declared
key has its label in every language of the tool, no label is dead or unfillable, the
declaration is valid, no body builder is named by a tool that declares reasons, and the
registry serves a guard around every handler, hook and route a tool exports; `error_taxonomy_tripwire` keeps the key from being written outside a
tool's server tree. The full checklist is in the specification
(`engineering/ERRORS_SPEC.md` §9.1) and a worked recipe in the
[cookbook](../../development/errors_cookbook.md#recipe-refuse-with-a-translated-reason-from-a-tool).

## The gates

Every rule on this page is mechanically enforced; a rule without a gate is treated as
already rotting. The tests that hold this subsystem:

| gate | holds |
| --- | --- |
| `error_registry_native` | the registry is coherent — grammar, a label for every code, label placeholders equal to `details_keys`, status matching category, family totality. |
| `error_envelope_native`, `error_converter_native` | the two envelope shapes and the disclosure ladder. |
| `dispatch_error_native` | the chokepoint — registry status, `ok:false` implying non-2xx, `Retry-After`, `csrf_token` on both outcomes, a non-envelope handler body refused. |
| `error_taxonomy_tripwire` | the whole tree only speaks through the registry: no hand-built failure bodies, no orphan codes, every client-spoken code resolving. |
| `error_throw_ratchet` | untyped throws may only shrink, and the zero-tier directories stay at zero. |
| `client_error_contract_tripwire` | the client half — one transport, no second fetch wrapper, no reader of the retired keys. |
| `labels_tripwire` | every `label_key` ships in the label catalog. |
| `tool_reason_keys_tripwire` | a tool's refusal reasons are a closed, labelled, loudly validated set: declared literals, a label per language, no dead or unfillable label, a valid declared sentence, the embedder for payload errors, and the guard the real registry serves around every handler, hook and route. |
| `authorization_denial_native`, `session_not_logged_contract`, `csrf_handshake` | the named refusals and their exact shapes. |

Run the first, the taxonomy tripwire and the labels tripwire together after any registry
edit; they are fast and they catch an orphan code, a missing label and a mismatched
placeholder in one pass.
