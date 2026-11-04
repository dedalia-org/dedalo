# ERRORS_SPEC — the closed error taxonomy and envelope v2

Status: **P0 landed** (foundation) — **P1 chokepoints landed 2026-08-15**
(§4: dispatch / response.ts / server.ts / tools dispatch / rqo schema on
envelope v2; the call-site sweep and the client half land in the same series).
§5 landed with P2 (MCP / streams / external fold-in, 2026-08-15); §7
(enforcement) and §9 (add-a-code) landed at P1 exit (2026-08-15 — adapter and
shells DELETED); §6 and §8 are headed stubs filled by P3/P4. Gates: `test/unit/error_registry_native.test.ts`,
`error_envelope_native.test.ts`, `error_converter_native.test.ts`,
`dispatch_error_native.test.ts`, `authorization_denial_native.test.ts`,
`session_not_logged_contract.test.ts`, `csrf_handshake.test.ts`,
`tools_dispatch.test.ts`.

## 1. Taxonomy — and why it is closed

Before this spec the engine had five disjoint failure vocabularies (HTTP
`errors[]` tokens, MCP `error.code` + a regex table over engine prose, tool
`failed()`, `ExternalErrorKind`, identify `decline()`), one dispatch catch-all
that turned every throw into HTTP 200 + a constant string, and ~400 untyped
`throw new Error(` whose text sometimes reached the wire. A client cannot act
on prose, an operator cannot count it, and a translator cannot translate it.

The taxonomy is **closed**: every failure the engine reports carries exactly
one registered code, and the registry (`src/core/errors/registry.ts`,
`ERROR_REGISTRY`) is the ONLY place a code may be born. Closed means:

- **eight categories**, each bound to one HTTP status
  (`caller` 400 · `auth` 401 · `permission` 403 · `not_found` 404 ·
  `conflict` 409 · `limit` 429 · `unavailable` 503 · `internal` 500).
  A code needing another status is another code, or a named row in
  `STATUS_EXEMPTIONS` (empty today) with its reason next to it.
- **one code per failure** — never a token array, never prose in the machine
  channel. `errors:[…]` on an envelope is a HANDLER extension key only (§3.0),
  never converter-made (the compat mirror was removed 2026-08-16, §3.1).
- **totality is mechanical**: `error.code` on the wire is `z.enum(ERROR_CODES)`;
  every code has a `master.json` label; label placeholders ≡ `details_keys`;
  the `external.<kind>` family is total over `ExternalErrorKind` and agrees
  with the component_external state map; every former MCP HINT is mapped.
- **the old tokens are ledgered once**: `LEGACY_TOKEN_MAP` (old token → code)
  is the single translation source for the P1 call-site sweepers and the
  parity reconciler; `MCP_HINT_CODES` the same for the MCP hint table.

Category is a **wire fact** (what the caller may do next), not a blame label:
`internal` means "the engine could not honour a well-formed request" and is the
only category whose message never varies per throw.

## 2. Registry semantics

`ErrorSpec` fields (all authored explicitly per code, none derived at runtime):

| field | meaning |
|---|---|
| `category` | one of the eight; drives `status` and client policy |
| `status` | HTTP status; must equal `CATEGORY_STATUS[category]` unless exempted |
| `label_key` | the `master.json` key the browser renders (§2.3) |
| `message` | registry-owned English (logs, MCP, curl). NEVER interpolates caller data |
| `severity` | `info` / `warn` → console.info/warn, `error` / `fatal` → console.error (`logError`) |
| `disclosure` | `public`: a vetted `publicMessage` may replace `message` on the wire; `operator`: never |
| `retryable` | may a later attempt plausibly succeed (client retry policy; `Retry-After` for limit/unavailable) |
| `details_keys?` | the ONLY `details` keys the converter puts on the wire — scalars only |
| `hint?` | model-facing next move (MCP structured errors) |
| `reason?` | named exemption: why the code exists although no engine path throws it |

### 2.1 Code grammar

`<domain>.<condition>` — `^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$`. The domain is
the subsystem or concept that owns the refusal (`auth`, `perm`, `request`,
`section_id`, `tool`, `mcp`, `external`, `identify`, `site_builder`, `mailer`,
`password_reset`, `diffusion`, `install`, `maintenance`, `internal`, …); the
condition names the fact, not the sentence. `isErrorInDomain(e, 'section_id')`
replaces `instanceof TypeError` at the section_id catch sites.

### 2.2 The disclosure ladder (what reaches the wire)

1. `error.message` = `spec.message` — or `publicMessage` ONLY when
   `spec.disclosure === 'public'` (`site_builder.rejected`, the identify
   operator-authored refusals, `request.invalid_options`, …).
2. `error.details` = the throw's `details` filtered to `spec.details_keys`,
   scalars only (a non-scalar under a declared key is dropped, not stringified).
3. `coordinates` (tipo / section_id / job) are LOG-ONLY; `cause` is never
   serialized. `internal.*` never echoes the wrapped exception.
4. `DEDALO_DEBUG_API_ERRORS=true` (existing key, no new one) adds
   `error.debug = {exception, stack, coordinates, cause_chain}`. The literal
   `debug` exists in exactly one file: `src/core/errors/convert.ts`.

`toDedaloError` is where classification happens: a `DedaloError` passes
through; a TDZ-shaped `ReferenceError` (raw or anywhere in the `cause`
chain) flips the process poison latch (`markProcessPoisoned`) and becomes
`internal.module_poisoned`; anything else is `internal.unexpected` carrying
the original as `cause`. So the latch fires on tool, MCP and stream paths too,
not only the dispatch catch.

### 2.3 Label convention

`label_key` defaults to `error_<code with . → _>` (`perm.out_of_scope` →
`error_perm_out_of_scope`); an existing key is reused only when it already
says the same thing (`no_access_page`, the `external_source_*` family,
`fail_to_save`, `search_failed`, `external_search_failed`). A shared label key
must be a reused pre-existing key and its codes must agree on category. Label
`${param}` placeholders ≡ `details_keys`, both ways — always with the `$` (the client's `format_label` fills `${param}` only; a bare `{param}` in any error label, master or catalog, is refused by `error_registry_native`). Labels ship in
`src/core/labels/master.json` in the same commit as the code (labels_tripwire).
Client-side transport codes have their own keys (`error_client_network|timeout|
aborted|bad_response|http_status|worker|offline|render_failed`; the slow-server
cue's `server_slow_response` is a state label, not an error).
`client.render_failed` is the one non-transport client code: a render callback
threw inside `ui.load_item_with_spinner`, and the engine's own panel
(`render_error_panel`) takes the place the node would have had — never an
empty container (client_action_outcome_tripwire).

## 3. Envelope v2 (normative)

Every JSON API body is one of:

```json
{ "ok": true,  "request_id": "…", "data": …, "notices": [ {"code","label_key","retryable","details"?} ]?, "csrf_token"?: "…" }
{ "ok": false, "request_id": "…", "error": { "code", "category", "message", "label_key", "retryable", "details"?, "debug"? }, "csrf_token"?: "…" }
```

- `request_id` is top-level on success and failure — the one join key to the
  access log.
- **HTTP status is an error channel**: `ok:false ⇒ status ∉ 2xx`, status =
  `CATEGORY_STATUS[category]`. `limit`/`unavailable` throws may carry
  `retryAfterMs` → `Retry-After` at the chokepoint.
- `notices[]` carries non-fatal coded facts (external `source_status`,
  identify warnings, truncation) — external-service degradation is
  `ok:true + notices`, not an error. The nested-ddo resolution adds three
  (2026-11-04, `engineering/RELATIONS_SPEC.md` §1 *Effective config per
  element*): `ontology.ddo_self_refused` (a level ≥ 2 `'self'` ddo skipped),
  `relation.record_cycle_stopped` and `relation.depth_bound_stopped` (a cell
  rendered without its nested children); each is bounded per response by the
  emission registry (`more` counts the folded remainder).
- Schema: `src/core/errors/schema.ts` (`apiEnvelopeSchema` =
  `z.discriminatedUnion('ok', …)`, `error.code = z.enum(ERROR_CODES)`; both
  shapes `.passthrough()` for the extension keys below).
  `src/core/concepts/rqo.ts` re-exports it as `apiResponseSchema` (live
  responses); `legacyApiResponseSchema` there is ONLY for the frozen PHP-era
  fixture store (`test/parity/replay.test.ts`).
- Builders: `ok(data, {requestId, notices?, extend?})`,
  `toErrorEnvelope(error, {requestId, extend?})` → `{status, body, error,
  retryAfterMs?}`, `toStructuredErr` (MCP `{ok:false, error:{code,message,
  hint?,details?}}`), `toStreamFrame` (`{is_running:false, error:{…}}` — a
  frame, not an envelope).

### 3.0 Extension keys

A handler may put fields it OWNS at top level beside the envelope keys —
`environment`, `in_use`, `total`, `pid`, `pfile`, `job_id`, `saml_redirect`,
`dedalo_notification`, `dedalo_last_error`, `result_options`, `action`, … —
the keys the client already reads by name (PHP parity). Rules:

- passed as `extend` (`ok(data, {…, extend})`; on a failure as the throw's
  `DedaloError.extend` or the chokepoint's `ctx.extend`); the converter spreads
  it FIRST, so a reserved key (`ENVELOPE_RESERVED_KEYS`: `ok`, `request_id`,
  `data`, `notices`, `error`) can never be overridden;
- `msg` and `errors` are HANDLER-OWNED extension keys, never converter-made:
  the maintenance widgets (`msg` / `errors` beside `data:true`), the install
  probes, the lock surface write them on SUCCESS, and two tools carry a named
  `errors` on a FAILURE (`tool_hierarchy` `extend:{state, errors}`,
  `tool_ontology_parser` `extend:{errors, ar_msg}` — the per-check detail
  behind the one sentence). The client core reads them ON SUCCESS ONLY through
  `response_extension(api_response, 'msg'|'errors')`
  (`client/dedalo/core/common/js/api_error.js`); the two failure readers read
  `api_response.errors` by name on the failure branch, deliberately. The
  converter writes neither (§3.1);
- `result` is FORBIDDEN as a top-level name on both shapes
  (`ENVELOPE_FORBIDDEN_KEYS = ['result']`, a `superRefine` on both schemas):
  it was the compat mirror of `data` (§3.1) and a body carrying it is a
  converter regression, refused at parse time by every schema-parsing gate;
- `csrf_token` is appended by the dispatch chokepoint to EVERY response of a
  session (success and failure) — a handler never sets it (login excepted:
  no session yet on the context, and the chokepoint never overwrites it) — and
  beside it ALWAYS `session_user_id`, the user that token belongs to: the client
  adopts a token, and makes its CSRF resend, only for its own page user
  (WC-2026-10-11-session-user-beside-csrf-token);
- an extension key on a FAILURE is exceptional and named: `start`'s
  `environment` (the labels the refused client needs to render its no-access
  page — WC-2026-08-12-authorization-denial-token) and the CSRF gate's
  `action`. Everything else a failure has to say goes in `details`.
- payload data belongs in `data`, never in an extension key: the keys above
  are the closed legacy set, and the P1-exit gate freezes it.

### 3.1 The compat block — REMOVED 2026-08-16

During the compat window (2026-08-15 → 2026-08-16) the converter ALSO emitted,
from ONE named export `ERROR_ENVELOPE_COMPAT` in `convert.ts`: on success
`result` = a mirror of `data`; on failure `result:false`, `msg` =
`error.message`, `errors:[code]`. The schema tolerated the three keys as
optional passthrough. The stated removal condition — the
`client_error_contract_tripwire` census of client reads of `.result` / `.msg` /
`.errors` reaches 0 — was met on 2026-08-16: **0 compat reads across 648
scanned files** (`client/dedalo/**/*.js` minus the browser test harness +
`tools/*/js/**/*.js`; widened on 2026-09-02 to the WHOLE `tools/**/*.js` tree —
the sub-path shape left nine tracked browser files outside the census, GATE-31 —
and the tripwire now proves `git ls-files` under both roots ⊆ the scan; one
counter, `scripts/lib/client_compat_census.ts`,
comments and strings blanked, the named non-envelope shapes excused one
expression at a time in `NON_ENVELOPE_READS` with a reason; the core sweep
`2f8ad44f03`, the tools sweep `505ad279de`). The block, the schema
passthrough and the client compat branches (bare `not_logged` /
`csrf_failed` / `not_authorized` policy rows, the `auth.`/`perm.` renderer
aliases) were deleted the same day — `WC-2026-08-16-error-envelope-compat-removal`.
That first census was one root short: the shared tool client machinery, then at
`src/core/tools/client/js/*.js`, was in neither scanned tree, and its two
surviving `.result` reads left every tool context null — a blank label on every
tool header — until the same day. The corpus is client code by DESTINATION, not
by directory; the machinery now lives at `client/dedalo/core/tools_common/`
(WC-006), inside the primary scan root, and the gate pins it as present in the
census (see the WC entry's addendum).
What remains is the negative: `result` is a forbidden key (§3.0), the converter
writes no `result:` (`error_taxonomy_tripwire` A2), the census is asserted at
ZERO (no baseline file — a ratchet frozen at 0 is a second copy of a
constant), and `test/parity/normalize.ts adoptErrorEnvelopeV2` refuses a
TS-shaped body (`ok` present) so it can only ever project the frozen PHP
fixtures (§6).

## 4. Converter law & chokepoints (P1 — landed 2026-08-15)

**The one-producer law.** A wire failure body is produced by exactly one
function, `toErrorEnvelope` (`src/core/errors/convert.ts`), and a wire success
body by exactly one, `ok`. Nothing else may write `ok:`, `error:`, `result:
false`, `msg:` or `errors:` into a body — not a handler, not a helper, not a
route. Consequences:

- **Handlers THROW to fail and return `ok(data, …)` to succeed.** Gates throw.
  A helper may exist only if it THROWS (`: never`); no helper may build a body.
- **`src/core/api/dispatch.ts` is THE catch** for the JSON API: `executeRqo`
  runs gates + handler inside one `try`; the `catch` calls
  `toErrorEnvelope(error, {requestId})` (registry status; `ok:false ⇒ status ∉
  2xx`; `Retry-After` threaded as `ApiResult.retryAfterMs`), then
  `logError(error, {subsystem: '<class>::<action>', requestId})`; `csrf_token`
  is appended after (session present). Gate codes: `request.unknown_action`
  (Gate 1 AND Gate 1c-disabled — the SAME body minus request_id, so a probe
  cannot learn the intake exists), `auth.not_logged` (401), `auth.maintenance` (401,
  the client relogin policy keys on both), `auth.csrf_failed` (403, extension
  `action` + the fresh `csrf_token` + its `session_user_id`), `perm.denied` (report intake IP).
- **The poison latch lives in `toDedaloError`** (raw error or anywhere in the
  `cause` chain), not in the catch — tool/MCP/stream conversions latch too.
- **`src/server.ts`** has one failure door, `jsonFailureResponse(error,
  requestId)`: malformed JSON → `request.malformed_body`; a body failing
  `rqoSchema` → `request.invalid_rqo` with `details.issue_paths` (comma-joined
  zod paths, ≤ 200 chars — never the raw issues); route misses →
  `resource.not_found`; the Bun.serve `error` catch-all →
  `internal.unexpected`. Every failure Response is `application/json`;
  `Retry-After` is emitted from `retryAfterMs`. Non-API routes (static, media)
  keep their semantics; only their 404 body is converter-made.
- **`src/core/tools/dispatch.ts`** gates throw `request.invalid_options`,
  `tool.invalid_name`, `tool.not_authorized`, `tool.no_server_module`,
  `tool.method_not_allowed` (+`details.method`), and the security.ts
  permission token mapped through `LEGACY_TOKEN_MAP`; `ToolResponse` IS the
  envelope (`ApiEnvelope`, extension keys for `pid`/`job_id`/streams).
- **Access log** (`core/api/access_log.ts`) carries `error_code` /
  `error_category` on an ok:false outcome.
- **`logError` severity `info`** prints the line only (no stack): an expected
  refusal (expired session) is traffic, not a fault.

**The transitional adapter — DELETED (P1 exit, 2026-08-15).**
`src/core/api/legacy_body_adapter.ts` and the three throwing shells in
`response.ts` (`denied` / `notAuthorized` / `notLogged`), `LegacyApiBody` and
`LegacyToolResponse` are gone: `ApiResult.body` IS `ApiEnvelope`,
`ToolResponse = ApiEnvelope`. A handler that returns a body without `ok` is a
BUG, not a compat case — `dispatch.ts` refuses it through its own catch as
`internal.unexpected` (coordinates name `<class>::<action>`), so a half-shaped
body can never reach the wire and "work". Streamed results go through
`streamResult(stream, headers)` (response.ts — the ONE non-failure helper it
exports; its body is `ok(null)` and is never serialized). Guards:
`error_taxonomy_tripwire` A1 (no builder call anywhere), `dispatch_error_native`
(the refusal), `authorization_denial_native` (response.ts's export set).

**Pattern for a handler (the sweep target):**

```ts
// success — data in `data`, owned legacy top-level keys as extension keys
return { status: 200, body: ok({ context, data: rows }, { requestId: context.requestId, extend: { total } }) };
// failure — throw; the dispatch catch converts (status from the registry)
throw new DedaloError('perm.denied', { coordinates: { section_tipo, section_id } });
// caller fault with a vetted sentence (only public-disclosure codes echo it)
throw new DedaloError('request.invalid_options', { publicMessage: 'options.limit must be ≤ 100', details: {…} });
```

**Add-a-code, chokepoint side:** register in `ERROR_REGISTRY` (+ label in
`master.json`, sorted); if it replaces an old token, add the token to
`LEGACY_TOKEN_MAP`; throw it. Nothing in dispatch/server changes.

## 5. Non-envelope surfaces (P2 — MCP / streams / external landed 2026-08-15)

Surfaces whose wire is not the JSON envelope, all fed by the SAME converter
family — the one-producer law of §4 holds here too: nothing but
`toStructuredErr` / `toStreamFrame` / `toErrorBody` writes an `error` object.
Gates: `test/unit/mcp_registry.test.ts`, `mcp_fields_write.test.ts`,
`agent_change_plan.test.ts`, `agent_egress_gate.test.ts`, `dd_mcp_api.test.ts`,
`agent_stream_protocol.test.ts`, `external_search_native.test.ts`,
`external_search_action_native.test.ts`, `error_registry_native.test.ts`
(former-HINT-key totality), `diffusion_queue_stream_tripwire.test.ts`.

### 5.1 MCP structured errors (`src/ai/mcp/envelope.ts`)

- The MCP failure shape is `toStructuredErr(error)`:
  `{ ok:false, error:{ code, message, hint?, details? }, …extend }`.
  `code` is a registry ErrorCode (`error.code = z.enum(ERROR_CODES)` on every
  surface); `hint` is the registry `hint` (the former envelope.ts `HINTS`
  table is DELETED — the registry is the one home; `MCP_HINT_CODES` freezes
  the former keys → codes and `error_registry_native` asserts every mapped code
  carries a hint); `details` the code's declared scalars.
- **Tools THROW `DedaloError`s** (`ToolError` and the `wrapError` regex table
  over engine prose are DELETED). The MCP-native codes are **public
  disclosure**: `mcp.*` (`label_ambiguous`, `ambiguous_match`,
  `media_too_large`, `media_path_disabled`, `plan_hash_mismatch`,
  `egress_restricted`, `write_disabled`), `request.invalid`, `resource.not_found`
  — the tool authors the sentence FOR the model as `publicMessage` ("No section
  matches 'x'", "Filter op 'y' needs a non-empty value") and it IS the wire
  message; the same reasoning as `resource.conflict`: the caller's own input
  echoed back is the whole value of a 400/404. `perm.*` stay operator (registry
  message + hint); which plan op failed rides as `extend.op_id`.
- **A payload the model needs that is not a scalar** (`candidates` of an
  ambiguous label/match) goes in the throw's `extend` and lands at TOP LEVEL
  beside `error` (spread first — `ok`/`error` can never be overridden), the
  same rule as the HTTP failure envelope's extension keys.
- `runTool` (`src/ai/mcp/registry.ts`) is the one catch: input re-validation
  → `request.invalid`, write on a read-only surface → `mcp.write_disabled`,
  off-allowlist section → `perm.section_not_writable`, then the handler; the
  catch is `toStructuredErr`. `identifier_gate.ts` throws
  `request.invalid_tipo` / `request.invalid` (typed at the source — no prose
  matching anywhere).
- The agent loop's is_error tool result content and a change plan's
  `report.failed.error` are the same structured error.

### 5.2 `dd_mcp_api` — the JSON-RPC bridge and the agent surface

- Every action's body is `ok(data)` or a throw (the dispatch chokepoint
  converts). Master switch off ⇒ `request.unknown_action` + `details.action`
  (Gate 1's own shape — a probe cannot learn the assistant exists). Option
  validation ⇒ `request.invalid` (public; the sentence names the field).
- **JSON-RPC layer keeps ITS numeric codes** and carries the envelope error
  body in `error.data`: `-32601` method not allowed, `-32602` for a
  caller-category failure (unknown tool), `-32603` otherwise. The HTTP
  envelope around a JSON-RPC error is `ok:true` (the RPC frame is the payload).
  `mcp_session_id` is the one extension key (`initialize`). The stale-session
  refusal is the typed `mcp.session_invalid` — its registry message is the
  literal an MCP client's recovery matches on.
- **Model catalog:** `ModelCatalogError` is a `DedaloError` subclass with the
  public `ai.*` codes (`ai.model_catalog_invalid` 503, `ai.models_unconfigured`
  503, `ai.model_unknown` 400, `ai.model_no_vision` 400) — the operator's own
  sentence reaches the wire again; nothing special-cases the class.
- **`agent_apply`:** a plan refused as a WHOLE throws (`mcp.write_disabled`,
  `mcp.plan_hash_mismatch`, `request.invalid`, `perm.*`); a plan that ran and
  stopped on an op is a REPORT — `data` = the MCP structured envelope
  `{ok:true, data:{applied, skipped, created, failed?}}` the plan-confirm card
  reads.

### 5.3 Stream frames — a frame, not an envelope

- `toStreamFrame(error)` = `{ is_running:false, error:{…} }` (`error` = the
  envelope error body). Frames are never `result:false/msg/errors`.
- **Agent SSE** (`agent_chat_stream`): the terminal `event: error` DATA is the
  error body itself plus the registry `hint` (`{code, category, message,
  label_key, retryable, details?, hint?}`) — the event name already says
  terminal, and `tools/tool_assistant/js/agent_stream.js` normalises exactly
  that object. A provider/transport failure mid-run is `ai.provider_failed`
  (503, retryable, hint "Retry; …") with the raw error as log-only `cause`;
  a typed failure keeps its code. Logged with `logError` at the stream (there
  is no dispatch catch past the headers).
- **Diffusion** (`diffusion/runner.ts`, `jobs/scheduler.ts`): the persisted job
  `result` of a failed job IS the follow stream's terminal frame
  (`progressDataFromJob` copies it): `{...toStreamFrame(typed), msg}` where
  `msg` keeps the report model's `Error. Diffusion run failed: <wire message>`
  grammar (`tools/tool_diffusion/js/report_model.js` splits it into causes).
  A `PlanCompileError` is `diffusion.plan_compile_failed` (public — the
  compiler's `\n- ` cause list is the message, so the report's cause list
  survives); anything else the run did not type is `diffusion.run_failed`
  (internal; the cause is log-only, `debug.exception` under
  DEDALO_DEBUG_API_ERRORS); a runner that never spawned is
  `diffusion.runner_spawn_failed` (503, never re-queued). `tools/job_status.ts`
  is the remaining stream door (own sweep).

### 5.4 External services — degradation is `ok:true` + notices

- `ExternalServiceError` (`src/external/errors.ts`) is a `DedaloError`
  subclass, code `external.<kind>` (the registry is total over
  `ExternalErrorKind`; `retryable` and `label_key` are tripwired equal to the
  component_external state map). `kind`, `service`, `origin`, `status`,
  `sectionTipo`, `remoteId`, `retryAfterMs`, `detail` stay on the instance;
  `Error.message` keeps the log grammar (`formatExternalError`:
  `[external:<service>] <kind> origin=… status=… section=… id=… <detail>`);
  origin/status/section/id are the LOG-ONLY `coordinates`. The subclasses
  `ExternalServiceNotRegisteredError` (`external.not_registered`) and
  `ExternalSearchUnsupportedError` (`external.bad_config` + `reason`) stay —
  the totality tripwire asserts them as THROWS. `transport.ts` throws
  `external.too_large` at the byte ceiling directly.
- `logExternalError` = `logError(error, {subsystem: 'external:<service>'})`
  (registry severity: `warn` for the expected degradations, `error` for the
  contract/config faults).
- **`dd_external_api::search` degradation** (`searchDegraded`): `ok:true`,
  `data:{context:[], data:[]}`, ONE notice `{code:'external.<kind>', label_key,
  retryable, details:{service, reason?}}` — the source is degraded, the request
  was not wrong (§3: degradation is never an error). The same `source_status`
  object the record path emits ALSO rides as an extension key (the autocomplete
  chip renders from it today) — an open item independent of the envelope
  compat mirror (§3.1): it retires when the widget reads `notices[]`. Supersedes WC-2026-08-06's failure shape by WC
  entry.

## 6. Fixture reconciliation (P1) & the closed compat window (P4)

The frozen PHP store is never re-harvested: `test/parity/normalize.ts
adoptErrorEnvelopeV2` projects a frozen PHP body onto the v2 fields a gate may
compare (TOP-LEVEL only; a TOTAL table `FROZEN_ERROR_BODIES` keyed by the exact
`(msg, errors)` bytes; an unlisted `result:false` body throws; every caller
asserts `matched === true`). Since 2026-08-16 it is FIXTURE-SIDE ONLY: a body
carrying `ok` (a TS body — or a TS body on which the compat mirror came back)
is refused with `kind:'ts_body_refused'`, `matched:false`, so a gate that fed
it the TS side reddens and a converter regression to `result:false` prose can
never be quietly adopted. `test/parity/error_envelope_transform.test.ts` pins
the table against the store AND the refusal. Parity gates read `ts.body.data`
on the TS side and the frozen `.result` on the PHP side. Compat removal: §3.1,
`WC-2026-08-16-error-envelope-compat-removal`.

## 7. Enforcement — the gates (P1 exit, 2026-08-15)

Every rule above is tripwired or it does not exist (CLAUDE.md "invariants are
tripwired or deleted"). Rows in `engineering/TRIPWIRES.md` + `scripts/verify.ts`:

| gate | what it holds |
|---|---|
| `test/unit/error_registry_native.test.ts` | the REGISTRY is coherent: grammar, every code has a `master.json` label, label `{params}` ≡ `details_keys`, status↔category (named exemptions), `external.<kind>` totality + retryable/label agreement with the component state map, every former MCP HINT key mapped and hinted, LEGACY_TOKEN_MAP targets exist |
| `test/unit/error_envelope_native.test.ts`, `error_converter_native.test.ts` | the envelope shapes and the converter's disclosure ladder (publicMessage only for `public`, details filtered to `details_keys`, `debug` only under the flag, poison latch inside `toDedaloError`); a failure body is exactly `{ok, request_id, error}`, `result` refused on both shapes (`ENVELOPE_FORBIDDEN_KEYS`), a `msg`/`errors` extension on success parses, `extend:{result}` cannot smuggle it in |
| `test/unit/dispatch_error_native.test.ts` | the chokepoint: registry status, `ok:false ⇒ non-2xx`, Retry-After, csrf_token on both outcomes, Gate 1 ≡ Gate 1c-disabled, a NON-envelope handler body refused as `internal.unexpected`, server.ts's three doors |
| `test/unit/error_taxonomy_tripwire.test.ts` | the TREE only speaks through the registry: (A) zero builder calls / `result:false` literals ANYWHERE (src/core/errors/ included) and no `result:` key written by convert.ts / stray `debug` keys / builtin `instanceof` outside convert.ts+process_health.ts / raw exception text on a wire key in the 8 former passthrough files; (B) shrink-only ratchets on hand-built `ok:false` failure literals and prose `errors:[…]`; (C) every code referenced or `reason`ed (a `reason` only on a code referenced nowhere, C1c), every client code string resolves; (D) runtime: every registered `(class,action)` converts a throw; (E) anti-vacuity |
| `test/unit/error_throw_ratchet.test.ts` | untyped `throw new Error(` per file may only shrink (`engineering/error_throw_baseline.json`); ZERO_TIER dirs are at 0 (`ZERO_TIER_ENFORCED = true`, P3 exit) |
| `test/unit/client_error_contract_tripwire.test.ts` | the client half: one transport (`api_transport.fetch_api`, no status allowlist), no fourth fetch wrapper, the compat-read census at ZERO (no baseline — `scripts/lib/client_compat_census.ts` + `NON_ENVELOPE_READS` exemptions, each live and reasoned), and the server compat block ABSENT (no `ERROR_ENVELOPE_COMPAT`, no `result:` written by convert.ts, `result` in `ENVELOPE_FORBIDDEN_KEYS`) — P4 landed 2026-08-16 |
| `test/parity/error_envelope_transform.test.ts` | the fixture-side transform: total over the 8 frozen `result:false` bodies, and it REFUSES a TS-shaped body (`ok` present) — fixture-side only |
| `test/unit/authorization_denial_native.test.ts`, `session_not_logged_contract.test.ts`, `csrf_handshake.test.ts`, `security_fail_closed.test.ts`, `no_install_surface_tripwire.test.ts` | the named refusals (`perm.denied` + environment extension on `start`, `auth.not_logged`, `auth.csrf_failed` + fresh token; no session-less action outside the frozen pre-auth list, the removed install actions `request.unknown_action`) — and response.ts's export set (`streamResult` only) |
| `test/unit/labels_tripwire.test.ts` | every `label_key` ships in `master.json` (the code and its label land in one commit) |
| `test/unit/tools_dispatch.test.ts`, `dd_mcp_api.test.ts`, `agent_stream_protocol.test.ts`, `diffusion_queue_stream_tripwire.test.ts`, `external_search_action_native.test.ts` | the non-envelope surfaces (§5) — tool responses ARE the envelope, MCP structured errors, SSE frames, external degradation as notices |

Nothing is left for a later phase: `ZERO_TIER_ENFORCED` flipped at P3 exit
(`00d6ec198d`), the compat block + census flip landed at P4 (2026-08-16, §3.1).
`matrix_write_failure_native` / `save_component_failure_native` landed with §8.

## 8. Write-path propagation (P3 — landed 2026-08-15)

The write path (`src/core/db/**`, `src/core/section/record/**`,
`src/core/section_record/**`, `src/core/relations/save.ts`) holds ZERO untyped
throws. The classification, applied site by site:

- **caller faults → registered codes.** Consultation-only backstops in
  create/duplicate/delete throw `perm.denied` (the same code the API door
  throws first); a non-positive section_id is `section_id.not_an_address`; a
  tipo with no matrix table is `section.no_matrix_table`; a missing source
  record (duplicate, setRecordMetadata) is `resource.not_found`; an unknown
  `changed_data` action or a non-object insert value is `request.invalid_data`;
  a write addressed to a derived (external) component is
  `record.external_write_refused` (`ExternalWriteRefused` is a thin
  `DedaloError` family — `instanceof` still works, the code is the wire
  identity); a save whose UPDATE matched 0 rows (the record was deleted
  concurrently — `assertRecordStillExists`) is `resource.conflict`.
- **integrity / contract violations → `internal.invariant`** with `message` =
  the former sentence (module + input, log-only) and `coordinates`
  (table / tipo / section_id / column / key): the json_codec guards, the
  matrix_write identifier and tipo-grammar gates, the FOR UPDATE / advisory-lock
  outside-a-transaction guards, the expired-handle guard (S2-14), the counter
  "insert returned no section_id" guards, the empty-payload guards, the
  observer cascade in-transaction refusals (B6), the immutable subscription
  index, the unported `dato_default.method`.
- **Nothing is absorbed.** No throw was wrapped into an `ok:false`; every
  failure between "persist X" and COMMIT still propagates out of
  `withTransaction` and rolls the transaction back. `toErrorEnvelope` runs
  only at the chokepoint, never inside a transaction (convert.ts imports
  nothing from `src/core/db/`).

Gates: `test/unit/matrix_write_failure_native.test.ts` (a forced integrity
failure inside `withTransaction` on a scratch record → the DedaloError reaches
the caller, the earlier write in the same tx is rolled back, no row / no
counter row survives a failed create; the converter keeps the sentence
server-side and has no tx dependency) and
`test/unit/save_component_failure_native.test.ts` (the same through
`saveComponentData` on a scratch twin: an allocated item id, a materialised
row and the audit row all roll back; caller faults are typed and write
nothing; an anti-vacuity control proves the same insert with a JSON-safe value
does move them).

## 9. Add-a-code checklist

1. Register the row in `ERROR_REGISTRY` (`src/core/errors/registry.ts`):
   category (→ status), `label_key` (default `error_<code>`; reuse a
   pre-existing key only when it says the same thing), registry English
   `message` (never interpolates caller data), severity, disclosure,
   retryable, `details_keys` iff the label has `{params}`, `hint` for a
   model-facing code, `reason` ONLY when no engine path throws it (a
   client-minted or reserved code).
2. Add the label to `src/core/labels/master.json` (sorted) — same commit.
3. If it replaces an old wire token, add the token to `LEGACY_TOKEN_MAP`.
4. `throw new DedaloError('<code>', {…})` at the site — `coordinates` for
   log-only identifiers, `publicMessage` only for a public-disclosure code,
   `extend` only for a NAMED extension key.
5. If the browser needs a non-default action, add the code (or its
   `<domain>.*`) to `CORE_POLICY` in `client/dedalo/core/common/js/error_policy.js`.
6. Run `bun test test/unit/error_registry_native.test.ts
   test/unit/error_taxonomy_tripwire.test.ts test/unit/labels_tripwire.test.ts`
   — an orphan, a missing label, a mismatched placeholder or an unresolved
   client string is red.
