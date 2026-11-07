# WC-2026-11-06-tool-reason-key — a tool refusal carries `details.reason_key`, a closed per-tool enum the browser translates from the tool's own labels

- **Date:** 2026-11-06 (maintainer decision for the `tool_uca_maps` port: a tool refuses with an
  existing code and a key, not a new code and not free text). Additive; no existing client reads
  the new key, no existing response gains it.
- **Decision:** DEC-12 (gated: `test/unit/tool_reason_keys_tripwire.test.ts`,
  `error_registry_native`, `error_converter_native`, `error_taxonomy_tripwire` A7, and the
  browser suite `test_render_api_error` / `test_api_error`). Spec: `ERRORS_SPEC.md` §9.1.
- **Shape before (TS):** a tool refused with a registered code whose `message` (the registry
  English, or a public code's `publicMessage`) and the code's generic `label_key` label were the
  only text. A tool could not give the cataloguer a reason in the tool's own words, in the user's
  language: either the generic core label hid the reason, or the English `publicMessage` was
  shown untranslated. `error.details` could carry only the keys the code declared (`site`,
  `limit`, …), all of them parameters of the CORE label.
- **Shape after (TS):**
  - **Wire.** `error.details.reason_key` (string) on five existing codes, all
    `disclosure: 'public'`: `request.invalid_options`, `resource.not_found`,
    `tool.unsupported_target`, `tool.source_unavailable`, `media.too_large` (the registry's
    `REASON_KEY_CODES`, pinned by `error_registry_native`). The value must match
    `^[a-z][a-z0-9_]{0,47}$` or the converter drops it. `error.message` is the sentence
    the tool declared for the key. Every surface that serialises a DedaloError (HTTP envelope, tool response,
    MCP structured error, stream frame, persisted job failure) carries it through the one
    converter. No new code, no envelope key, no change to status or category.
  - **Server contract.** `ToolServerModule.reasonKeys?: Readonly<Record<string, string>>`
    declares the closed map: each key with the English fallback sentence it rides with. The
    loader refuses a tool whose declaration is not an object, whose key is off the grammar, or
    whose sentence is empty, longer than 200 characters or holds a control, line-separator or
    invisible-formatting character (a bidi override, a zero-width space — Unicode categories
    `Cc`, `Cf`, `Zl`, `Zp`). It admits a tool only through `admitToolModule`, which wraps every
    action handler (foreground and background), `admit` hook and HTTP route. **The sentence
    belongs to the declaration, never to the throw:** a refusal throws the key with no
    `publicMessage`, the wrapper puts the declared sentence on it (same code, details,
    coordinates, cause, retry hint, `extend` and stack), and a refusal that carries any
    other sentence is not printed. A `reason_key` outside the map, on a code that does not
    carry it, or beside a sentence other than the declared one is re-thrown as
    `internal.invariant` (the original is the log-only cause) — whether it is THROWN out of
    the entry or is a failure envelope the handler RETURNS (its `message` must be the
    declared sentence). A refusal a tool EMBEDS in a payload instead of throwing it (a batch's
    per-item error body) is built with `toolErrorBody(tool, action, error)`, which applies the
    same check and logs a refusal it replaces (no wrapper or dispatcher catch sees one); a tool
    that declares `reasonKeys` names none of the converter's body builders (`toErrorBody`,
    `toErrorEnvelope`, `toStructuredErr`, `toFailureRecord`, `toStreamFrame`; gated, the list
    pinned complete against `errors/convert.ts`). An offending key echoed into the log-only
    message and coordinates is reduced to `[A-Za-z0-9_.-]` and 80 characters. Each wrapper
    keeps the raw function (`unguarded`), so gates that read a served handler's source judge
    the handler. Not covered, and stated: a `Response` a route returns, and an error body a
    tool hand-assembles and nests in a payload with no builder (`error_taxonomy_tripwire` B1
    blocks the `ok: false` literal that would usually carry one).
  - **Labels.** The sentence is the tool's `register.json` label `{lang, name: 'reason_<key>',
    value}`; `${param}` fills from `error.details` (the code's declared keys). The tripwire
    requires one per declared key in every language the tool carries (and `lg-eng`) and no dead
    `reason_*` label.
  - **Client.** `ApiError` gains `tool` (string or null; part of `toJSON`, never read from the
    server): `data_manager` sets it from `source.model` of a `dd_tools_api` / `tool_request` body
    before it publishes `api_error`. `tool_common.build` registers the tool's `reason_*` labels
    (`register_tool_error_labels`). `error_text` for an error with `details.reason_key` and a
    known tool resolves: tool label `reason_<key>` → wire `message` (the declared sentence) →
    core `label_key` label → code. Errors without `reason_key` resolve exactly as before. A stream or job frame does not
    say whose it is, so the site that renders a tool's job names it:
    `normalize_stream_error(frame, {tool})` (and `render_stream({tool})`, which calls it) stamps
    `ApiError.tool` from the caller's argument through the constructor; a `tool` key inside a frame
    is never read.
  - **Label placeholders.** The core label's `${param}` set equals `details_keys` MINUS
    `reason_key` (`error_registry_native`); `reason_key` selects a tool label, it never fills the
    core one. A tool's `reason_*` label may use only the `${param}` an opted-in code declares
    (today `${site}`) and never `%s` (gated); a label the browser cannot fill completely is not
    shown — the wire `message` stands in.
- **Reason:** the browser dispatches on `code` and renders text from labels. A tool's refusals
  are a closed, tool-specific set the core registry cannot (and should not) enumerate, so the
  map is the tool's own, validated server-side, and its sentences live where the tool's other
  translations live. A fallback sentence is mandatory so an untranslated language still reads
  one coherent notice, and it is declared once with the key — not written at each throw —
  because it is the one string the client prints verbatim: a sentence a throw could carry is
  a sentence an upstream's text, a driver message or a URL could ride, and no static reading
  of the throw site can tell them apart.
- **Operational pitfall:** `tool.source_unavailable` is the one opted-in code that is
  `retryable`. The browser transport resends a retryable error; a `tool_request` is `mutating`
  unless the action declares `readOnly`, and a mutating handler that throws keeps its
  idempotency reservation `ambiguous`, so the resend is answered `idempotency.outcome_unknown`
  and the user never sees the reason. A tool refuses with it from a `readOnly` action called
  with the literal `retries: 1`, or picks a non-retryable code.
- **Not covered:** the page's job tray (`job_tray.js`) lists background jobs of every kind and
  the activity row names no tool, so a tray row shows the core code's label, not the tool's
  sentence (a tool's own panel, rendered with `render_stream({tool})`, does). A parameterised
  label beyond the code's declared details (a limit inside the sentence) is out of scope: fixed
  ceilings go into the label text.
- **Gate reconciliation:** none of the frozen parity fixtures carries the key; the registry rows
  only gain a `details_keys` entry, so no recorded body changes.
