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

## Addendum 2026-10-29 — `tool_identify` withdrawn from the TS tool lists (PROVISIONAL)

- **Status:** provisional. The withdrawal holds only until `tool_identify` is redesigned; the tool is
  to be redesigned, not removed. When its redesign lands, this addendum, the gate assertions that
  encode absence and the skipped granted twins (below) are reversed in the same change.
- **Shape:** `tool_identify` is no longer offered on the TS side by any door: `getUserTools`,
  `getElementTools` and the section toolbar (`getSectionTools`) filter it through
  `toolOfferedByCapabilities` (`src/ai/capabilities.ts`, identify always `false`). The
  `tools/tool_identify/register.json` registration is kept; it is hidden, not deleted.
- **Server side, not only the UI:** `getUserTools` is also the grant check behind
  `requireToolGrant` (`assertToolGranted`), so the vision-spend doors (`get_proposals` with
  `source` `vision`/`all`, `identify_by_image` with an EXTERNAL encoder) refuse EVERY caller with
  `tool.not_authorized`, root and a profile granting `tool_identify` included. Vote-only proposals
  and a LOCAL encoder ask no grant and are unaffected.
- **Oracle:** PHP never had the tool, so the frozen side is unchanged and carries no `tool_identify`.
  The divergence is the TS side only, deliberate and documented here.
- **Gates:** `test/parity/section_tools_differential.test.ts` asserts `tool_identify` absent on both
  sides (was: present on TS as a one-sided declaration). `test/parity/get_element_context_differential.test.ts`
  drops it from `TS_ONLY_TOOLS` and asserts it absent on both sides in every case. No re-harvest
  (the gates transform the TS side before diffing).
- **TOOLS-4 unit gates:** the refusal halves stay live (`test/unit/identify_vision_grant_native.test.ts`:
  ungranted → `tool.not_authorized` with zero profile loads, model calls and embeds), plus a live
  leg asserting no identity is offered `tool_identify`. Only the legs that need a GRANTED caller
  to reach the spend are `test.skip` with the reason in the name: 5 granted twins there, and the 2
  vision-budget legs of `test/unit/ai_spend_budget_native.test.ts`.
- **Recording:** parity has no `tier_pass` drop (both gates pass with the absence assertions). The
  cost is in the unit per-file floor: the 7 new skips are recorded with
  `--allow-regression --reason` in the CI image.
