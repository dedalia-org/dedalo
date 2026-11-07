# Error system cookbook

> See also: [errors](../core/system/errors.md) · [Dédalo API v1](../api/dedalo_api_v1.md) · [data_manager](../core/client/data_manager.md) · [Tool server contract](tools/server_contract.md) · [Development](index.md)

Task-oriented recipes for the closed error vocabulary. The **concept page** —
what a code is, the eight categories, the disclosure ladder, the envelope shapes — is
[errors](../core/system/errors.md); read it once, then come back here for the *doing*.
Every snippet below is copied or adapted from live code, with its source path underneath.

The one sentence the whole system rests on: **a handler throws to fail and returns
`ok(data, …)` to succeed.** Nothing else builds a body.

---

## Server recipes

### Recipe: refuse a caller fault from an API handler

**Goal.** Reject a request the caller got wrong, with a code the browser can act on.
**When.** Any gate inside an action handler: a missing option, a read-only target, a
record outside scope.

```ts
if (options.tipo === undefined) {
    throw new DedaloError('request.invalid_source', {
        message: 'read_raw: options.tipo is required',
    });
}
if (isConsultationOnlySection(source.section_tipo) && wireId.kind === 'record') {
    throw new DedaloError('perm.denied', {
        message: `Illegal save to read-only section '${source.section_tipo}'`,
        coordinates: { section_tipo: source.section_tipo },
    });
}
```

*Source: `src/core/api/handlers/dd_core_api.ts` (`read_raw`, `save`).*

**What you get.** The dispatcher's one catch converts the throw: HTTP 400 for
`request.invalid_source`, 403 for `perm.denied`, body
`{ok:false, request_id, error:{code, category, message, label_key, retryable}}` plus
`csrf_token`. The browser then resolves the policy — `perm.*` is the full no-access page, a
`validation.*` code renders inline next to the field.

**Pitfalls.** `message:` is the **log** sentence (`Error.message`), never the wire — a
caller-facing sentence needs `publicMessage` **and** a `public`-disclosure code
(`throw new DedaloError('request.invalid_options', { publicMessage: 'options.limit must be ≤ 100' })`);
on an `operator` code the field is ignored by design. `coordinates` (tipo, section_id,
table, job) are log-only, always: anything the caller must read goes in `details`, under a
key the code declares in `details_keys`. And never catch your own throw to re-wrap it — a
`catch` that loses the `DedaloError` turns a clean 400 into `internal.unexpected` 500.

### Recipe: return success

**Goal.** Answer with a payload, plus the fields the handler owns.
**When.** Every non-failing return of an action handler.

```ts
return {
    status: 200,
    body: ok(outcome.result, { requestId: context.requestId, extend: { table: outcome.table } }),
};
```

*Source: `src/core/api/handlers/dd_core_api.ts`.*

**What you get.** `{ok:true, request_id, data, notices?, …extend}`. `extend` is spread
**first**, so an extension key can never overwrite `ok` / `request_id` / `data` /
`notices` / `error` (`ENVELOPE_RESERVED_KEYS`, `src/core/errors/schema.ts`).

**Pitfalls.** **Payload lives in `data` and nowhere else** — extension keys are a closed,
frozen set of handler-owned top-level fields (`total`, `job_id`, `pid`, `environment`,
`saml_redirect`, `action`, the maintenance widgets' `msg` / `errors`, which are legal on
success and are never an error channel). `result` is **forbidden** on both shapes:
`okEnvelopeSchema` / `errEnvelopeSchema` refuse a body carrying it, so the regression
cannot pass a schema-parsing gate. A handler body without `ok` is refused by the
dispatcher's own catch as `internal.unexpected`, so a half-shaped body cannot reach the
wire and appear to work.

### Recipe: add a NEW error code end-to-end

**Goal.** Mint a code, ship its label, throw it, gate it.
**When.** A refusal no existing code names. (Reusing a close-enough code is usually right;
a code needing a different HTTP status is always a *different* code.)

**1 — the registry row** (`src/core/errors/registry.ts`, the only place a code is born):

```ts
'relation.insert_refused': {
    category: 'caller',
    status: 400,
    label_key: 'error_relation_insert_refused',
    message: 'The linked record was refused by the relation constraint',
    severity: 'warn',
    disclosure: 'public',
    retryable: false,
    details_keys: ['constraint', 'section_tipo'],
},
```

**2 — the label**, sorted, in `src/core/labels/master.json`, in the **same commit** (its
`${param}` placeholders must equal `details_keys`, both ways (with the `$`: a bare `{param}` is shown to the user verbatim, and `error_registry_native` refuses it); a per-language translation is
optional and goes under the same key in `src/core/labels/catalog/lg-spa.json`):

```json
"error_relation_insert_refused": "The link into '{section_tipo}' was refused ({constraint})"
```

**3 — the throw site:**

```ts
return new DedaloError('relation.insert_refused', {
    message,
    coordinates,
    details: { constraint: String(outcome.code), section_tipo: targetSectionTipo },
});
```

*Source: `src/core/relations/save.ts` (`refusalToError`).*

**4 — the native test** — assert the *code*, never a body (the pattern; substitute your own
call and code):

```ts
const refusal = await refusalOf(
    readRaw({ sectionTipo: SECTION, tipo: TEXT_TIPO, type: 'not_a_type', sqo: scratchSqo() }, admin),
);
expect(refusal.code).toBe('request.invalid_options');
expect(refusal.message).toMatch(/type 'not_a_type' not implemented/);
```

*Source: `test/unit/read_raw_native.test.ts`, helper `test/helpers/refusal.ts`.*

**5 — the gates:**

```shell
bun test test/unit/error_registry_native.test.ts \
         test/unit/error_taxonomy_tripwire.test.ts \
         test/unit/labels_tripwire.test.ts
```

**What you get.** An orphan code, a missing label, a mismatched placeholder or an
unresolved client string is red — and nothing in the dispatcher or the HTTP layer changes.
That is the point of the registry.

**Pitfalls.** A code that no engine path throws fails the totality check unless it
carries a `reason` — and a `reason` is a named exemption, not a parking space. If the
browser needs a non-default UI action, add the code (or its `<domain>.*`) to `CORE_POLICY`
in `client/dedalo/core/common/js/error_policy.js`. **If the wire changed** — a new code on
an existing response, a status change, a notice where a failure used to be — write the
`engineering/wire_contract/` entry the same day, named `WC-<yyyy>-<mm>-<dd>-<slug>.md`: a
red parity gate with no entry is a regression, not a divergence.

### Recipe: convert an untyped `throw new Error(`

**Goal.** Retire a bare throw without changing what the code means.
**When.** You touched a file that still has one, or you are burning a ratchet entry down.

Classify **first**:

| the throw says | becomes |
| --- | --- |
| the caller sent something wrong | a `caller` / `not_found` / `conflict` code — `request.invalid_data`, `resource.not_found`, `resource.conflict`, `section_id.not_an_address` |
| the actor may not do this | `perm.denied` — the same code the API door throws first |
| "this cannot happen" (integrity, contract) | `internal.invariant`, former sentence as the log-only `message`, identifiers as `coordinates` |
| a genuinely local control-flow signal, never surfaced | leave it |

```ts
throw new DedaloError('internal.invariant', {
    message: `updateMatrixKeysData: key '${write.key}' fails the tipo grammar (spec §7.6)`,
    coordinates: { table: tableName, key: write.key },
});
```

*Source: `src/core/db/matrix_write.ts`; the propagation is asserted by
`test/unit/matrix_write_failure_native.test.ts`.*

Then regenerate the census and commit the JSON with the change:

```shell
bun run scripts/error_throw_baseline.ts
bun test test/unit/error_throw_ratchet.test.ts
```

**What you get.** The per-file count shrinks. Seven prefixes are held at **zero** and no
baseline entry can excuse a throw there: `src/core/api/`, `src/core/security/`,
`src/core/tools/`, `tools/`, `src/core/section/record/`, `src/core/db/`,
`src/core/concepts/section_id.ts`.

**Pitfalls.** **Nothing is absorbed**: never wrap a throw into an `ok:false` result
inside a transaction — every failure between "persist X" and COMMIT must propagate out of
`withTransaction` and roll back. Never hand-edit `engineering/error_throw_baseline.json`
and never raise a number to get green. The ratchet is a **token** count
(`throw new Error(` exactly), so it cannot see a site *moved* between files: one entry
goes stale, the other trips.

### Recipe: emit a NON-fatal fact (a notice)

**Goal.** Answer successfully and still say something coded about the answer.
**When.** A partial delete, a degraded external source, a truncated value — the caller
keeps a usable payload.

```ts
const notices = skippedIds.length === 0 ? undefined : [{
    code: 'record.delete_children_refused' as const,
    label_key: specOf('record.delete_children_refused').label_key,
    retryable: specOf('record.delete_children_refused').retryable,
    details: { not_deleted: skippedIds.join(',') },
}];
return { status: 200, body: ok(deleted, { requestId: context.requestId, notices }) };
```

*Source: `src/core/api/handlers/dd_core_api.ts` (`delete`).*

`searchDegraded` in `src/core/api/handlers/dd_external_api.ts` builds the same shape for a
source that is down — `ok:true`, an empty result set, one `external.<kind>` notice carrying
`{service, reason?}` — because the source is degraded, the request was not wrong.

**What you get.** `data_manager.request` publishes the envelope's `notices[]` once as the
`'api_notices'` event; `handle_api_notice` resolves each through the **same** policy table
a failure goes through, at severity `warning`, with page-level actions
(`relogin` / `no_access_page` / `page_panel`) suppressed — the request succeeded, so
nothing may take the page away from the user. A caller that renders the notice next to its
own widget opts out with `notices:'caller'` and reads `api_response.notices` itself.

**Pitfalls.** **A notice that hides a failed operation is worse than a 500** — no answer
at all means throw. A notice code is a registry code like any other: registry row, label,
gates.

### Recipe: refuse (and succeed) from a tool handler

**Goal.** The same envelope from a `tools/*/server` module.
**When.** Any tool API action.

```ts
if (sectionTipo === '' || (await getPermissions(context.principal, sectionTipo, sectionTipo)) < 1) {
    throw new DedaloError('perm.denied', {
        coordinates: { tool: 'tool_export', sqo_section_tipo: sectionTipo },
    });
}
…
if (components.length === 0) {
    throw new DedaloError('request.invalid_options', {
        publicMessage: 'options.components must be a non-empty list of {tipo, section_tipo}',
    });
}
return ok(result, { requestId: toolRequestId(context) });
```

*Source: `tools/tool_export/server/tool_export.ts`.*

**What you get.** `ToolResponse` **is** the envelope — same two shapes, same status
mapping, same `csrf_token`. The tool dispatcher's own gates throw registered codes too
(`tool.invalid_name`, `tool.not_authorized`, `tool.no_server_module`,
`tool.method_not_allowed`).

**Pitfalls.** Read the request id through **`toolRequestId(context)`**, never
`context.requestId` directly: a background job outlives the request that started it, so
under the background executor the helper answers the job's OWN id (`job:<id>`, from the
job-owned context the job manager pins at submit), and `''` only for a direct call outside
any scope — never a crash, never the dead request's id. `tools/` is a zero-tier
directory — an untyped throw there fails the ratchet outright.

### Recipe: refuse with a translated reason from a tool

**Goal.** A tool refusal the cataloguer reads in their own language, in the tool's words.
**When.** The refusal is specific to the tool (a bad bounding box, a source that is down)
and the generic core label would hide the reason.

```ts
// tools/<tool>/server/index.ts
export const tool: ToolServerModule = {
	name: 'tool_example_maps',
	reasonKeys: {
		// the closed map — not an action: each key with its English fallback sentence
		bad_bbox: 'The bounding box is not numeric.',
		source_down: 'The map server is not answering.',
	},
	apiActions: { /* … */ },
};

// the handler — the key only; the guard puts the declared sentence on the refusal
throw new DedaloError('request.invalid_options', {
	details: { reason_key: 'bad_bbox' },
});
```

And in the tool's `register.json`, one label per key and language the tool carries
(always `lg-eng`):

```json
{ "lang": "lg-eng", "name": "reason_bad_bbox", "value": "The bounding box is not numeric." }
```

*Source: `src/core/tools/reason_keys.ts`; the scratch fixture tool in
`test/unit/tool_reason_keys_tripwire.test.ts`.*

**What you get.** One notice: the tool's label `reason_bad_bbox` in the user's language,
else the sentence declared for the key, else the core code's label. `${site}` in a label fills from the
code's own declared detail (`tool.source_unavailable` carries `site`); nothing else is
available, so put fixed limits in the text. Choose the code from the five that carry the key
(`request.invalid_options`, `resource.not_found`, `tool.unsupported_target`,
`tool.source_unavailable`, `media.too_large`).

**Pitfalls.**

- The loader turns a `reason_key` outside `reasonKeys` (thrown, or in a failure envelope the
  handler returns), on any other code, or beside a sentence other than the declared one,
  into `internal.invariant`; the tripwire fails a declared key without a label in every
  language, a dead `reason_*` label and a literal that is not declared.
- The English fallback is declared once, beside the key, and is not a `publicMessage` you
  write at the throw: leave `publicMessage` off a keyed refusal. The loader refuses a
  declaration whose sentence is empty, over 200 characters, or holds a control, line-separator
  or invisible formatting character (a bidi override, a zero-width space), and a throw that
  brings a sentence of its own is `internal.invariant` — so an upstream's text, a driver
  message or a URL can never ride the one field the browser prints as it arrives. Put the
  variable part in the label's `${site}`. Because the declaration owns the sentence, you
  may build the error in a helper of your own.
- `tool.source_unavailable` is retryable. The browser transport resends a retryable error,
  and a mutating action's first attempt leaves an ambiguous reservation under its
  idempotency key, so the resend is answered `idempotency.outcome_unknown` and the user
  never sees your reason. Refuse an unreachable source from a [read-only
  action](tools/server_contract.md#read-only-actions-readonly-true) called with the literal
  `retries: 1` (the `source_down` key above is that case), or pass `retries: 1` on the
  `tool_request(` call; from an action that cannot be read-only, choose a code that is not
  retryable.
- A label may use only the `${param}` the code declares (`${site}`), never `%s`; the
  tripwire refuses the rest, and the browser would show the declared sentence instead of a
  label it cannot fill.
- A refusal you put inside an answer rather than throw (a batch's per-item `error`) is built
  with `toolErrorBody(tool, 'action', error)` from `src/core/tools/reason_keys.ts`; the same
  check then applies and a refusal it replaces is logged. A tool that declares `reasonKeys`
  names none of the converter's body builders (`toErrorBody`, `toErrorEnvelope`,
  `toStructuredErr`, `toFailureRecord`, `toStreamFrame`) anywhere in its server tree — not
  as a call, not in an import, aliased or not.
- A refusal that reaches the browser through a job frame is not stamped with the tool by the
  frame itself. Name the tool where you render the job: `render_stream({container, id, tool:
  self.model, …})`, or `normalize_stream_error(frame, {tool: self.model})`. The job tray does
  not know the tool and shows the core label.
- Adding a sixth code to the set is a registry edit, a pinned list and a wire-contract entry,
  not a tool change.

### Recipe: refuse an MCP tool with a model-facing hint

**Goal.** Steer the agent loop instead of dead-ending it.
**When.** A tool under `src/ai/mcp/tools/` cannot answer.

```ts
throw new DedaloError('mcp.label_ambiguous', {
    publicMessage: `Several sections match '${reference}'.`,
    extend: { candidates: candidates.slice(0, 10) },
});
```

*Source: `src/ai/mcp/tools/discovery.ts`.*

**What you get.** `runTool` catches once and `toStructuredErr` produces
`{ok:false, error:{code, message, hint?, details?}, …extend}`. The `hint` comes from the
registry row — for this code, *"More than one field matches that label. Pick one of the
returned candidates by its tipo and retry with the tipo."* The non-scalar `candidates`
payload rides at top level beside `error` (spread first, so `ok` / `error` are safe).

The JSON-RPC bridge keeps **its own** numeric codes and carries the error body in
`error.data`:

```ts
function rpcCodeFor(error: DedaloError): number {
    return error.spec.category === 'caller' ? -32602 : -32603;
}
```

*Source: `src/core/api/handlers/dd_mcp_api.ts` (`-32601` for a method that is not allowed).*

**Pitfalls.** Assistant-facing `mcp.*` codes are deliberately **public disclosure** — the
tool writes the sentence *for the model*; `perm.*` stays `operator` (registry message plus
hint). `extend` is the only escape hatch for a non-scalar payload: do not widen
`details_keys` to smuggle an object through the ladder.

### Recipe: fail a stream or a background job

**Goal.** End a stream, or persist a job failure, with the same coded body.
**When.** Diffusion runs, SSE runs, anything past the response headers (there is no
dispatcher catch left).

```ts
const typed = isDedaloError(error)
    ? error
    : new DedaloError('diffusion.run_failed', { cause: error, coordinates: { job: jobId } });
logError(typed, { subsystem: 'diffusion runner' });
await finishJob(jobId, 'failed',
    failedJobResult(typed, `Error. Diffusion run failed: ${toErrorBody(typed).message}`));
```

*Source: `src/diffusion/runner.ts`; `failedJobResult` = `toFailureRecord(error, extend) + msg`
in `src/diffusion/jobs/queue.ts`.*

**What you get.** `toStreamFrame(error)` produces `{is_running:false, error:{…}}` — a
**frame, not an envelope** (no `ok`, no `request_id`: the event name already says
terminal). A diffusion job's persisted `result` *is* the follow stream's terminal frame, so
the report the user reads and the frame the stream emitted are the same object. Both
browser readers go through one normaliser: `job_follow.js` turns a terminal frame into an
`ApiError` with `normalize_stream_error` and dispatches it through `handle_api_error` (so a
session that expires under a two-hour transcode still raises the relogin overlay), and
`job_tray.js` shows `error_text(api_error)` as the row's title.

**Pitfalls.** A typed failure keeps its code; only what the run did **not** type becomes
`diffusion.run_failed` (operator disclosure — the cause is log-only). Log at the stream
with `logError`: there is no chokepoint downstream to do it for you.

---

## Client recipes

### Recipe: consume an API response correctly

**Goal.** Read one `data_manager.request` result without inventing a second contract.
**When.** Every client call.

```js
import {request_failed, response_data, response_extension} from '../../common/js/api_error.js'
import {handle_api_error} from '../../common/js/error_dispatch.js'
import {error_text} from '../../common/js/render_api_error.js'

const api_response = await data_manager.request({body: rqo})

if (request_failed(api_response)) {
    const {recovered} = await handle_api_error(api_response.error, {wrapper: self.node})
    if (recovered) {
        return retry()          // the user re-logged in; the call may be repeated
    }
    return null                 // it was shown/handled; stop here
}
const data  = response_data(api_response)
const total = response_extension(api_response, 'total')
```

*Composed from `client/dedalo/core/common/js/{api_error,error_dispatch,render_api_error}.js`;
the same import set as `tools/tool_sitebuilder/js/sitebuilder_controller.js`.*

**What you get.** `request_failed` is **the** test (the transport attaches an `ApiError`
under `error` on every failure and nothing under it on success), `response_data` the one
payload accessor, `handle_api_error` the policy executor resolving `{recovered, action}`,
and `error_text` the sentence — label in the user's language first, then the registry
`message`, then the code.

**Pitfalls.** Dispatch on `api_error.code` **only** — never string-match `message`, which
is registry English for logs and curl. `response_extension` returns `undefined` on a
failure on purpose, so a `msg` / `errors` extension can never be mistaken for the error
text. Pass `{wrapper}` when the caller owns a node: without it an `inline` policy degrades
to a toast.

### Recipe: register a tool-local error policy

**Goal.** Route your own domain to the surface your UI actually has.
**When.** A tool or area owns a pane, a panel, or a field the message belongs in.

```js
import { register_error_policy } from '../../../core/common/js/error_policy.js'

register_error_policy({
    'site_builder.*'    : {action:'inline'},
    'replay_failed'     : {action:'inline'}
})
```

*Source: `tools/tool_sitebuilder/js/sitebuilder_controller.js`.*

**What you get.** Registration is **additive** and resolution is exact code →
`<domain>.*` → `'*'`, so your rows win for your domain while the core rows stay untouched
(a mid-run `auth.not_logged` still raises the relogin overlay). Actions are the closed set
`relogin`, `no_access_page`, `page_panel`, `csrf_retry`, `toast`, `modal`, `inline`,
`silent`.

**Pitfalls.** **A core key cannot be overridden**: the attempt throws under `SHOW_DEBUG`
(so it is found in development) and warns otherwise, and the core entry stays — softening
`auth.not_logged` is a bug, not a preference. Getting a full no-access page where you
wanted a toast means your code is in the `perm.*` domain: pick a `validation.*` /
`request.*` code instead, do not soften the policy.

---

## Operating recipes

### Recipe: debug a failure

**Goal.** Find out what actually threw.
**When.** A refusal reads as `internal.unexpected`, or a `publicMessage` / `details` value
is missing from the wire.

```shell
# development only — puts stack traces and record coordinates on the wire
DEDALO_DEBUG_API_ERRORS=true bun run dev
```

The failure body then carries `error.debug = {exception, stack, coordinates, cause_chain}`.
The literal `debug` exists in exactly one source file, the converter, and one schema.

Without the flag, the **join key is `request_id`** — top level on both envelope shapes and
on the structured access log line, which carries the error identity only on a failure:

```json
{"ts":"…","request_id":"5f2a…","user_id":1,"api":"dd_core_api::save","status":403,"ms":12.4,
 "error_code":"perm.denied","error_category":"permission"}
```

`logError` prints one line per failure — `[<subsystem>] <code> k=v … [req <id>]`, the
`k=v` pairs being the throw's `coordinates`. `details` are **never** logged (they may echo
caller input), and severity `info` prints the line only: an expired session is traffic, not
a fault. Every failure also bumps `errors_total` and `error_<code with . → _>` in the admin
counters endpoint (see [metrics](metrics.md)).

**Reading the symptom:**

| symptom | cause |
| --- | --- |
| renders as `internal.unexpected` | the throw was untyped, or a `catch` re-wrapped it and lost the `DedaloError` |
| `publicMessage` not on the wire | the code's `disclosure` is `operator` |
| a `details` value vanished | the key is not in `details_keys`, or the value is not a scalar |
| 500 where you expected 400 | a gate threw *before* your typed site |
| `/health` answers 503 and every request through one module fails identically | the **poison latch**: a temporal-dead-zone `ReferenceError` (raw or anywhere in the `cause` chain) flipped `markProcessPoisoned` inside `toDedaloError`. The module evaluation is cached for the whole process life — the process must be recycled. |

!!! warning "`DEDALO_DEBUG_API_ERRORS` is a development switch"
    Leave it off in production. The `request_id` plus the access log is the supported way
    to trace a failure.

### Recipe: test a refusal, a rollback, a policy

**Goal.** Prove the refusal you claim, not the absence of an exception.
**When.** Any change to a throw site, a write path, or the client policy table.

**A refusal** — assert the code, and the `publicMessage` when the code is public:

```ts
import { refusalOf } from '../helpers/refusal.ts';

const refusal = await refusalOf(extractArchive(zipPath, join(ROOT, 'nomark', 'q')));
expect(refusal.code).toBe('update.refused');
expect(refusal.message).toMatch(/not a Dédalo tree/);
```

*Source: `test/unit/code_update.test.ts`. `refusalOf` (`test/helpers/refusal.ts`) re-throws
a non-`DedaloError` and fails loudly when the call **succeeds** — that is the anti-vacuity
guard. For a `public`-disclosure code pin `refusal.publicMessage` too; for a code with
`details_keys`, pin the declared detail.*

**A rollback** — the failure must propagate out of `withTransaction`, and the write that
landed before it must be gone:

```ts
const error = await refusalOf(withTransaction(async () => {
    await updateMatrixRecord(TABLE, TIPO, SECTION_ID, {
        string: { zzwf2: [{ id: 1, lang: 'lg-nolan', value: 'clobbered' }] },
    });
    await updateMatrixRecord(TABLE, TIPO, SECTION_ID, {
        string: { zzwf2: [{ id: 1, value: undefined }] },
    });
}));
expect(error.code).toBe('internal.invariant');
expect(await currentStringText()).toBe(initialText);   // the 'clobbered' write is gone
```

*Source: `test/unit/matrix_write_failure_native.test.ts` — scratch surface only
(`matrix_test`, a synthetic tipo), cleaned before and after.*

**A client policy** — pin the row in the browser suite (`bun run test:client`):

```js
assert.equal(resolve_error_policy('site_builder.publish_failed').action, 'modal')
assert.equal(resolve_error_policy('site_builder.other').matched, 'site_builder.*')
assert.throws(() => register_error_policy({'auth.not_logged': {action: 'silent'}}))  // under SHOW_DEBUG
```

*Source: `client/dedalo/test/client/js/test_error_policy.js`.*

---

## Anti-patterns and the gate that catches each

| anti-pattern | why it is wrong | caught by |
| --- | --- | --- |
| Hand-built `{ok:false, msg, errors}` body | two producers of a failure body ⇒ two contracts | `error_taxonomy_tripwire` A1 (no builder call) + B1 (shrink-only literal ratchet) |
| A top-level `result` key | the retired mirror of `data`; a converter regression | `ENVELOPE_FORBIDDEN_KEYS` in `schema.ts` (refused at parse time) + taxonomy A2 |
| `error.message` / `String(error)` assigned to a wire key | raw exception text leaks SQL, paths, coordinates | `error_taxonomy_tripwire` A5 |
| Branching on the message text | prose is not a machine channel; a translation breaks the branch | code review + `error_registry_native` (every code has a label; text is not the identity) |
| Reading `api_response.result` / `.msg` on the client | the compat mirror is gone on both ends | `client_error_contract_tripwire` (compat-read census asserted at **zero**) |
| Swallowing a throw inside a transaction into an `ok:false` outcome | the write between "persist X" and COMMIT never rolls back | `matrix_write_failure_native`, `save_component_failure_native` |
| `instanceof TypeError` at a catch site | a vocabulary the registry does not own — use `isErrorInDomain(e, 'section_id')` | `error_taxonomy_tripwire` A4 (zero outside `convert.ts` + `process_health.ts`) |
| `throw new Error(` in a zero-tier directory | the refusal has no code, no status, no label | `error_throw_ratchet` (`ZERO_TIER_ENFORCED`) |
| A `debug` key written outside the converter | leaks the debug block past the `DEDALO_DEBUG_API_ERRORS` door | `error_taxonomy_tripwire` A3 |
| A code with no label, or a label whose `{params}` differ from `details_keys` | the browser renders raw English, or an empty placeholder | `error_registry_native` + `labels_tripwire` |
| A tool `reason_key` that is not declared, has no label in a language the tool carries, brings a sentence other than the declared one, or is written outside the tool's server tree | the refusal falls back to English in a translated UI, or free text reaches the one key a client turns into a label name and the one sentence it prints verbatim | the loader's guard (`internal.invariant`) + `tool_reason_keys_tripwire` + `error_taxonomy_tripwire` A7 |

Run the fast trio after any registry edit — they catch an orphan code, a missing label and
a mismatched placeholder in one pass:

```shell
bun test test/unit/error_registry_native.test.ts \
         test/unit/error_taxonomy_tripwire.test.ts \
         test/unit/labels_tripwire.test.ts
```
