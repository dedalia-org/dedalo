# WC-2026-10-28-tool-open-defects — tool_transcription only where configured; JSON upload; `count_only` counts

- **Date:** 2026-10-28 (feature crawl #7, #8, #10; #9 is client-only, no wire change).
- **Decision:** DEC-12 (gated: `test/unit/component_tools_stamp.test.ts`,
  `test/unit/tool_upload_json_native.test.ts`, `test/unit/diffusion_retry_queue_native.test.ts`,
  `test/unit/client_component_update_datum.test.ts`).
- **Shape before (TS):**
  1. `context.tools` of every av / image / pdf component carried `tool_transcription`, which reads
     its media / transcription / status roles ONLY from the caller's
     `properties.tool_config.tool_transcription.ddo_map` (no default map). On a component without
     it (a user avatar, a gallery image) the tool opened on null roles and threw `null.model`.
  2. A `component_json` full context had no `features`; `tool_upload` (offered on it by the
     register) read `features.allowed_extensions` and threw on open. The server half was missing
     too: `process_uploaded_file` refused the model as `request.invalid_model`.
  3. `dd_diffusion_api:retry_pending_deletions` ignored `options.count_only`: tool_diffusion's
     badge query, sent on every render, ran the whole pending-unpublish drain.
- **Shape after (TS):**
  1. `tool_transcription` is offered only when the element declares
     `properties.tool_config.tool_transcription` (the tool module's `isAvailable`; the availability
     context gains `hasToolConfig`). The configured callers (rsc29 / rsc35 / rsc37, the oh81 /
     test6877 section tools) are unchanged.
  2. `component_json` full context carries `features: {allowed_extensions: ['json'],
     default_target_quality: null}` (PHP component_json_json.php :90-98). `process_uploaded_file`
     on a component_json parses the staged `.json`, REPLACES the value (`set_data [{id:1, value}]`
     through `saveComponentData`, TM-audited), deletes the staged file and answers
     `{original_file_name, extension, derivative_errors: []}`. Not `.json` or invalid JSON →
     `media.upload_rejected`, nothing written (PHP component_json::add_file +
     process_uploaded_file).
  3. `count_only: true` → `{summary, total: n, retried: 0, remaining: n}` (n = retryable,
     non-terminal pending rows; PHP diffusion_delete::count_pending) and nothing is retried. The
     action's posture stays `mutating` (it is polymorphic), so a read-only crawl audit still blocks
     the badge query.
- **Client:** `component_inverse` wires `update_datum` (borrowed `component_common.build` calls it
  for every non-standalone instance; tool_time_machine's caller rebuild threw).
- **Gate reconciliation:** TS-only. No parity fixture covers these tools.
