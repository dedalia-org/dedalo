# WC-2026-10-29-ai-capabilities-page-globals — `ai_capabilities` page_globals key (TS-only) hides AI entry points

- **Date:** 2026-10-29.
- **Shape:** `buildPageGlobals` (`src/core/resolve/environment.ts`) emits a new
  object `ai_capabilities` = `{ assistant, semantic, identify }` from
  `aiCapabilities()` (`src/ai/capabilities.ts`). Config-only, no network, no DB.
  - `assistant`: `DEDALO_AGENT_HTTP_ENABLED === 'true'` AND the model catalog has at
    least one entry. An invalid catalog (`ModelCatalogError`) is `false`, never a throw.
  - `semantic`: RAG enabled AND `DEDALO_RAG_EMBEDDING_PROVIDER === 'sidecar'` AND a
    non-empty `DEDALO_RAG_EMBEDDING_ENDPOINT`. Without that the embedding provider
    silently falls back to the deterministic hash provider, which is not a real model.
  - `identify`: always `false` (hidden until it is redesigned).
  PHP `get_page_globals` has NO twin.
- **Companion server rule:** `user_tools` (`src/core/api/handlers/dd_tools_api.ts`)
  omits `tool_assistant` when `assistant` is `false`, and always omits `tool_identify`.
- **Why:** the client showed AI entry points on deployments with no working model,
  so every click failed. The flags let the client hide them. A deployment without a
  model shows no dead buttons.
- **Client effect:** the client shows an AI entry point only when
  `page_globals.ai_capabilities?.<flag>` is `true`. A missing key means hidden.
- **Gate:** `test/unit/ai_capabilities_native.test.ts` (stubbed env, per flag, plus
  the fail-closed catalog and missing-model cases).
- **Parity note:** `test/parity/environment_differential.test.ts` (page_globals
  key-set compare) must strip this TS-only key before the exact compare, the WC-031 /
  WC-2026-10-21-error-report-granted pattern. That test file is outside this change.
