---
name: dedalo-errors-ts
description: Dédalo v7 TS/Bun ERROR SYSTEM — closed DedaloError code registry, the ONE converter building every wire body, envelope v2 (ok/request_id/data/notices/error + extension keys), the disclosure ladder, and the vanilla-JS client contract (ApiError, error_policy, error_dispatch, render_api_error). Use when adding/renaming/removing an error code, asking "why does my error render as internal.unexpected", "why do I get a no_access page instead of a toast", any envelope v2 shape question (ok:false, request_id, notices[], extension keys, the forbidden `result` key); when error_taxonomy_tripwire / error_registry_native / client_error_contract_tripwire / error_throw_ratchet / dispatch_error_native fails; when a ZERO_TIER directory rejects an untyped throw; when wiring a code's master.json label; deciding notice vs failure; typing a stream frame or an MCP/assistant structured error + hint; or reading a failure under DEDALO_DEBUG_API_ERRORS. Authoritative: engineering/ERRORS_SPEC.md. Manual: docs/core/system/errors.md.
---

# Dédalo v7 error system (TypeScript/Bun)

Every failure the engine reports carries **exactly one registered code**, and exactly one
function turns a thrown value into a wire body. Before this system the engine had five
disjoint failure vocabularies and a dispatch catch-all that turned every throw into HTTP 200
plus a constant string — a client cannot act on prose, an operator cannot count it, a
translator cannot translate it.

This skill POINTS. The normative content is `engineering/ERRORS_SPEC.md` (§1-2 taxonomy and
registry, §3 envelope, §4 converter law + chokepoints, §5 non-envelope surfaces, §7 gates,
§9 add-a-code) and the module headers under `src/core/errors/`. Read those; this teaches the
model, the workflows and the traps.

## The map

| Path | Role |
|---|---|
| `src/core/errors/registry.ts` | `ERROR_REGISTRY` — the ONLY place a code may be born. A pure data table: category, status, `label_key`, `message`, `severity`, `disclosure`, `retryable`, `details_keys?`, `hint?`, `reason?`. Also `CATEGORY_STATUS`, `STATUS_EXEMPTIONS` (empty), `LEGACY_TOKEN_MAP`, `MCP_HINT_CODES`. |
| `src/core/errors/dedalo_error.ts` | `DedaloError` — the ONE typed throw. Per-throw fields only: `details` (wire), `coordinates` (log-only), `publicMessage`, `retryAfterMs`, `extend`, `cause`. Plus `isDedaloError`, `isErrorInDomain`. |
| `src/core/errors/convert.ts` | THE converter: `toDedaloError` (classification + the poison latch), `toErrorBody`, `toErrorEnvelope`, `ok`, `toStructuredErr`, `toStreamFrame`, `toFailureRecord`. The literal `debug` lives here alone. |
| `src/core/errors/schema.ts` | `apiEnvelopeSchema` (discriminated union on `ok`), `noticeSchema`, `errorBodySchema`, `ENVELOPE_RESERVED_KEYS`, `ENVELOPE_FORBIDDEN_KEYS` (`result`). |
| `src/core/api/dispatch.ts` | THE catch for the JSON API: gates + handler in one `try`, `toErrorEnvelope` + `logError` in the `catch`, `csrf_token` appended after. |
| `src/server.ts` | The HTTP layer's one failure door (`jsonFailureResponse`): malformed body, RQO schema miss, route miss, the `Bun.serve` catch-all. |
| `src/core/tools/dispatch.ts` | Tool gates; `ToolResponse` IS the envelope. |
| `src/ai/mcp/envelope.ts`, `registry.ts` | The structured-error surface; `runTool` is its one catch. |
| `client/dedalo/core/common/js/api_error.js` | `ApiError`, `CLIENT_ERROR` (`client.*`), `normalize_api_error` / `_transport_error` / `_stream_error`, `request_failed`, `response_data`, `response_extension`. Pure module — imported by the page, the cache Worker and the Service Worker. |
| `client/dedalo/core/common/js/error_policy.js` | `CORE_POLICY` (code → action), `resolve_error_policy` (exact → `<domain>.*` → `*`), `register_error_policy` (additive; core keys cannot be overridden). |
| `client/dedalo/core/common/js/error_dispatch.js` | `handle_api_error(api_error, ctx) → {recovered}`, the ONE relogin-then-retry recovery, and the NOTICE half (`handle_api_notice(s)`). |
| `client/dedalo/core/common/js/render_api_error.js` | `error_text` (label → message → code) and the four surfaces. NEVER an HTML-parsing sink. |
| `src/core/tools/reason_keys.ts` | The server half of a tool's `details.reason_key`: `guardReasonKeys` (wired by the loader's `admitToolModule`) wraps every handler / `admit` / route of a loaded tool and turns an undeclared key, a non-opted code or a sentence other than the DECLARED one into `internal.invariant` (thrown, or in a failure envelope the handler returns), and supplies the declared sentence to a valid refusal. `unguarded(fn)` returns the raw function behind a wrapper (a gate that reads a served handler needs it); `toolErrorBody` builds an EMBEDDED refusal body with the same check and LOGS the refusal it replaces. |
| `src/core/labels/master.json` | Every code's `label_key` ships here, in the same commit. |
| `engineering/error_throw_baseline.json` | The shrink-only untyped-throw census (never hand-edit). |
| `docs/core/system/errors.md` | The developer manual page. |

**Wire-contract entries** (`engineering/wire_contract/`): `WC-2026-08-15-error-envelope-v2`,
`-error-status-is-a-channel`, `-http-layer-error-envelope`, `-tool-response-envelope-v2`,
`-stream-error-frames`, `-mcp-error-code-alignment`, `-external-degradation-is-a-notice`,
`WC-2026-08-16-error-envelope-compat-removal`, `WC-2026-08-12-authorization-denial-token`,
`WC-2026-11-06-tool-reason-key`.

## The laws

**1. One producer.** A wire failure body is produced by `toErrorEnvelope` and nothing else; a
wire success body by `ok` and nothing else. Handlers **throw to fail, return `ok(data, …)`
to succeed**. A helper may exist only if it throws (`: never`) — no helper builds a body.
A handler body without `ok` is refused by the dispatcher's own catch as
`internal.unexpected`, so a half-shaped body cannot reach the wire and "work".

**2. Category → status, and status is an error channel.** Eight categories, each bound to
one HTTP status (`caller` 400 · `auth` 401 · `permission` 403 · `not_found` 404 · `conflict`
409 · `limit` 429 · `unavailable` 503 · `internal` 500). `ok:false ⇒ status ∉ 2xx`. A code
needing a different status is a **different code**, not an exemption (`STATUS_EXEMPTIONS` is
empty and each entry would need its reason beside it).

**3. The disclosure ladder.** `message` = the registry English, replaced by the throw's
`publicMessage` ONLY for a `public`-disclosure code; `details` = the throw's `details`
filtered to `details_keys`, scalars only (a non-scalar under a declared key is dropped, not
stringified); `coordinates` and `cause` are log-only and never serialized; `debug` exists
only under `DEDALO_DEBUG_API_ERRORS=true`. `internal.*` never echoes the wrapped exception
outside `debug`.

**4. Zero-tier.** `error_throw_ratchet` enforces **0** untyped `throw new Error(` under
`src/core/api/`, `src/core/security/`, `src/core/tools/`, `tools/`,
`src/core/section/record/`, `src/core/db/`, `src/core/concepts/section_id.ts`
(`ZERO_TIER_ENFORCED = true` since the P3 exit). No baseline entry can excuse one there.
Everywhere else the per-file count is shrink-only.

**5. Labels ride the code.** Every `label_key` must exist in `src/core/labels/master.json`,
and the label's `${param}` placeholders must equal the code's `details_keys` (minus `reason_key`, which names no placeholder), both ways. Always with the `$`: the client fills `${param}` only, so a bare `{param}` reaches the user verbatim (gated). The
code and its label land in ONE commit (`labels_tripwire` + `error_registry_native`). Deeper:
the **`dedalo-labels-ts`** skill.

**6. `result` is forbidden.** The retired mirror of `data` is refused by the schema on both
shapes. `msg` / `errors` are legal **handler-owned extension keys on success** (and on two
named tool failures), never converter-made — do not reintroduce them as an error channel.

## Workflows

### Add a code

1. Register the row in `ERROR_REGISTRY`: category (fixes the status), `label_key` (default
   `error_<code with . → _>`; reuse a pre-existing key ONLY when it already says the same
   thing — `perm.denied` reuses `no_access_page`), registry English `message` (never
   interpolates caller data), `severity`, `disclosure`, `retryable`, `details_keys` iff the
   label has `${params}`, `hint` for a model-facing code, `reason` ONLY when no engine path
   throws it.
2. Add the label to `src/core/labels/master.json`, **sorted**, same commit.
3. If it replaces an old wire token, add the token to `LEGACY_TOKEN_MAP`.
4. Throw it: `throw new DedaloError('<code>', {coordinates, details?, publicMessage?})`.
5. If the browser needs a non-default action, add the code (or its `<domain>.*`) to
   `CORE_POLICY` in `error_policy.js`.
6. Gate it:
   `bun test test/unit/error_registry_native.test.ts test/unit/error_taxonomy_tripwire.test.ts test/unit/labels_tripwire.test.ts`.
   An orphan code, a missing label, a mismatched placeholder or an unresolved client string
   is red.
7. If the WIRE changed — a new code on an existing response, a status change, a notice where
   a failure used to be — write the `engineering/wire_contract/` entry the **same day**.

Nothing in `dispatch.ts` or `server.ts` changes when you add a code. That is the point.

### Add a tool refusal reason (`details.reason_key`)

A tool that must explain a refusal in the user's language does NOT add a code: it throws one
of the five public codes that carry the key (`REASON_KEY_CODES`: `request.invalid_options`,
`resource.not_found`, `tool.unsupported_target`, `tool.source_unavailable`,
`media.too_large`) with `details: {reason_key}`. The English fallback sentence belongs to the
tool's DECLARATION, not to the throw.

1. Declare the closed map on the tool's server module: `reasonKeys: { bad_bbox: 'The bounding
   box is not numeric.', … }` — key grammar `REASON_KEY_PATTERN`, sentence a non-empty string of
   200 characters at most with no control, line-separator or invisible formatting character (a
   bidi override, a zero-width space); not an action. The loader refuses the tool otherwise.
2. Throw `new DedaloError('request.invalid_options', {details: {reason_key: 'bad_bbox'}})` —
   NO `publicMessage`: the guard puts the declared sentence on the refusal, so nothing a
   request or an upstream wrote reaches the field the browser prints verbatim. The loader's
   guard turns an undeclared key, a code that does not carry it, or any other sentence into
   `internal.invariant` (the same for a failure envelope the handler returns). A refusal you
   EMBED in an answer (a batch's per-item error) is built with `toolErrorBody(tool, action,
   error)` — it is logged when it is refused — and the tool names none of the converter's body
   builders (`toErrorBody`, `toErrorEnvelope`, `toStructuredErr`, `toFailureRecord`,
   `toStreamFrame`), imported or called. PITFALL: `tool.source_unavailable` is retryable, so
   from a mutating action the transport resends it and the twin is answered
   `idempotency.outcome_unknown`; use it from a `readOnly` action called with `retries: 1`,
   or choose a non-retryable code.
3. Add `{lang, name: 'reason_bad_bbox', value}` to the tool's `register.json` labels — every
   language the tool carries, and `lg-eng`. `${site}` is the only parameter available on
   `tool.source_unavailable`; fixed limits go into the text.
4. Client: nothing per tool for a request. `data_manager` stamps `ApiError.tool`,
   `tool_common.build` registers the `reason_*` labels, `error_text` resolves tool label →
   wire `message` → core label → code (a label it cannot fill completely, `${x}` outside the
   code's details or `%s`, is skipped for the `message`; the gate refuses it). A refusal
   reported through a job frame is named by the tool's own panel:
   `render_stream({container, id, tool: self.model})` or
   `normalize_stream_error(frame, {tool: self.model})`; the job tray names no tool and shows
   the core label.
5. Gate: `bun test test/unit/tool_reason_keys_tripwire.test.ts test/unit/error_registry_native.test.ts
   test/unit/error_taxonomy_tripwire.test.ts`. Adding a sixth code to the set is a registry
   edit (list `reason_key` in `details_keys`, keep it `public`), the pinned list in
   `error_registry_native` and a wire-contract entry. Spec: ERRORS_SPEC §9.1.

### Convert an untyped throw

Classify first, then type:

- **Caller fault** → a registered `caller`/`not_found`/`conflict` code (`request.invalid_data`,
  `resource.not_found`, `resource.conflict`, `section_id.not_an_address`, …).
- **Permission** → `perm.denied` — the same code the API door throws first, so a
  consultation-only backstop deep in the write path reads identically on the wire.
- **Integrity / contract violation** → `internal.invariant`, with the former sentence as the
  log-only `message` and the identifiers as `coordinates` (table, tipo, section_id, column,
  key). This is the right landing zone for a guard that says "this cannot happen".
- **Nothing is absorbed.** Never wrap a throw into an `ok:false` result inside a
  transaction: every failure between "persist X" and COMMIT must propagate out of
  `withTransaction` and roll back. `toErrorEnvelope` runs only at the chokepoint —
  `convert.ts` imports nothing from `src/core/db/`.

Then re-run the baseline generator (`bun run scripts/error_throw_baseline.ts`) and commit the
JSON with the change. Never hand-edit it; never raise a number to get green.

### Debug a wrong wire shape

- **"My error renders as `internal.unexpected`."** The throw was untyped (or a wrapper lost
  the `DedaloError`), so `toDedaloError` classified it. Find the throw site and type it. If
  the message you expected is missing from the wire but present in the log, that is the
  ladder working as designed — `internal.*` never echoes the cause.
- **"My `publicMessage` is not on the wire."** The code's `disclosure` is `operator`. Either
  the sentence belongs in `details` under a declared key, or the code genuinely is public
  and the registry row is wrong.
- **"My `details` value vanished."** It is not in `details_keys`, or it is not a scalar. For
  `reason_key`: the code is not one of `REASON_KEY_CODES`, or the value is outside
  `REASON_KEY_PATTERN` (the loader's guard catches both on a tool throw as `internal.invariant`).
  A keyed refusal's `message` is always the sentence its tool DECLARED for the key.
- **Want everything?** Run with `DEDALO_DEBUG_API_ERRORS=true` and read `error.debug`
  (`exception`, `stack`, `coordinates`, `cause_chain`). Development only — it puts stack
  traces and record coordinates on the wire.
- **The join key is `request_id`**, top level on both shapes and on the access-log line
  (which also carries `error_code` / `error_category`). Trace with it before guessing.
- A `500` where you expected a `400` usually means the gate threw *before* your typed site,
  or a `catch` re-wrapped your `DedaloError` without passing it through.

### Client policy: the wrong UI action

`resolve_error_policy` matches **exact code → `<domain>.*` → `'*'`**. So:

- **"I get a full no-access page instead of a toast."** Your code is in the `perm.*` domain
  and `CORE_POLICY` maps `perm.*` to `no_access_page`. If the refusal is a field-level one,
  it is the wrong domain — pick a `validation.*` / `request.*` code, do not soften the
  policy.
- A tool or area adds its own domains with `register_error_policy({'my_domain.*': {…}})` at
  module load. It is **additive**: a core key cannot be overridden, and an attempt throws
  under `SHOW_DEBUG` so it is found in development. Softening `auth.not_logged` is a bug,
  not a preference.
- The renderer resolves text **label first** (`error_text`: `label_key` in the user's
  language → registry `message` → the code). An error showing raw English usually means the
  label key is missing from the catalog, not that the renderer is wrong.

### Notice or failure?

Ask what the caller keeps.

- **A usable answer plus something worth saying → a notice.** `ok:true`, payload intact, one
  entry in `notices[]` = `{code, label_key, retryable, details?}`. External-source
  degradation is a notice, never an error (the source is degraded; the request was not
  wrong). The delete path emits `record.delete_children_refused` with the refused ids while
  the records that *were* deleted stay the payload.
- **No answer → throw.** A notice that hides a failed operation is worse than a 500.
- Notices go through the SAME client policy table at severity `warning`, and page-level
  actions (`relogin`, `no_access_page`, `page_panel`) can never fire for one — the request
  succeeded, so nothing may take the page away from the user.

### Non-envelope surfaces

Same converter family, same one-producer law — only the wrapper differs:

- **MCP / assistant:** `toStructuredErr` → `{ok:false, error:{code, message, hint?, details?},
  …extend}`. Assistant-facing codes are deliberately **public disclosure** (the tool authors
  the sentence FOR the model as `publicMessage`); `hint` comes from the registry (the old
  local HINTS table is deleted, and `MCP_HINT_CODES` freezes the former keys). A non-scalar
  payload the model needs (candidate lists) goes in `extend`, at top level beside `error`.
- **Streams:** `toStreamFrame` → `{is_running:false, error:{…}}` — a frame, not an envelope.
  The SSE terminal `event: error` data is the error body plus the `hint`. A diffusion job's
  persisted failure result IS the follow stream's terminal frame.

## Honest limits

- **`error_taxonomy_tripwire` B1 is a heuristic, not a zero.** It counts `ok:false` literals
  with a `msg`/`errors`/`error` sibling within three lines, on the token view. An internal
  result object legitimately spelled `{ok:false, error}` counts — which is exactly why it is
  a shrink-only ratchet with a frozen per-file map rather than a hard zero. Do not "fix" a
  red B1 by renaming a field to dodge the window; retype the site or lower the entry.
- **`error_throw_ratchet` is a TOKEN count.** `throw new Error(` exactly. A re-throw
  (`throw err`), a stored `new Error(...)`, and every typed subclass are outside it by
  design; it cannot see a site MOVED between files (one entry goes stale, the other trips);
  and `*.test.ts`, `dist/`, `node_modules/`, `scripts/`, `publication/` and `client/` are
  UNGATED. Outside the zero-tier prefixes untyped throws still exist under the frozen
  baseline — the artifact is the state, do not restate its numbers in a header.
- **`client_error_contract_tripwire` scans client code by DESTINATION, not by directory.**
  Browser JS served from a tree outside `client/dedalo/**` and `tools/*/js/**` is invisible
  to the census — that gap once hid two stale reads that blanked every tool header label. If
  you add a new client root, add it to the census.
- **`toStructuredErr`'s `extend` is the only escape hatch for non-scalar payload.** Do not
  widen `details_keys` to smuggle an object through the ladder.
- **The runtime leg of the taxonomy tripwire is DB-gated.** On a machine whose test database
  has drifted, some `test/unit` gates are pre-existing red — verify a change by diffing the
  failure SET before and after, not by requiring a green suite.
- Adding a code is cheap; **removing one is a wire change.** A code with no throw site fails
  the totality check unless it carries a `reason`, and a `reason` is a named exemption, not a
  parking space.

## Related skills

Foundation and the tripwire law: **`dedalo-ts-foundation`**. Labels for every `label_key`:
**`dedalo-labels-ts`**. Throws inside a transaction and what must roll back:
**`dedalo-ts-write-path`**. Writing the manual page: **`dedalo-docs-authoring`**. Gate
mechanics and the anti-vacuity habit: **`dedalo-ts-testing`**.
