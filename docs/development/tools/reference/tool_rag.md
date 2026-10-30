# tool_rag

The permission to request **generated answers** over the collection: the grounded, cited answer of `dd_rag_api` `ask`. `tool_rag` is the first **grant-only** tool — a registry row with no window, no client code, no stylesheet and no server module. It exists to be granted in the profile editor and asked by the engine.

## What it does / why & when to use it

A generated answer calls a language model. A model call is a resource with a cost (an external provider's bill, or the installation's own GPU), so it has an owner (this grant) and a limit (the caller's daily AI limits, see below).

Grant `tool_rag` to the profiles whose users should be able to ask for generated answers. Semantic search (`semantic_search`, `retrieve`, `get_agent_context`, `search_by_text_image`) does **not** need it: retrieval is core search, available to every user who can read the section, and it is metered against the daily AI limits instead.

## How it works

- **Registration.** `tools/tool_rag/register.json` declares `properties.grant_only: true`, no affected models, `show_in_inspector: false`, `show_in_component: false` and `always_active: false`. *Register tools* puts the row in the tool registry (`dd1324`) like any other tool; the profile editor (`dd1067`) then offers it.
- **The door.** `dd_rag_api` `ask` calls `assertToolGranted(principal, 'tool_rag')` (`src/ai/rag/api.ts`) right after resolving the caller and before reading any option. An ungranted caller gets `403 tool.not_authorized` and nothing is spent. Global administrators are not exempt; the root account holds every tool.
- **The budget.** A granted `ask` then reserves one model run and its token budget (the context budget plus the output cap) against the caller's daily AI limits (the ledger is the *AI usage* section, `dd660`), and charges one query embedding (`src/core/security/ai_spend.ts`). A used-up limit is `429 ai.budget_exhausted`; a grounding miss refunds the run.
- **Why grant-only is safe to exempt from the UI rules.** The tool laws that need a client (the phone ratchet, one stylesheet per tool) exempt a tool by its own `grant_only` declaration; `test/unit/tools_register_validate.test.ts` keeps the declaration true (no `js/`, `css/` or `server/`, shown nowhere, never `always_active`, asked by an engine door).

## Actions & options

None: a grant-only tool has no `apiActions`. The action it guards is `dd_rag_api` `ask` — see [the RAG API](../../../core/ai/rag.md#the-api-dd_rag_api).

## Gotchas

- An installation updated from a release without `tool_rag` has no registry row until a code update's ancillary phase (or *Register tools*) registers it; until then `ask` refuses everyone.
- No profile is granted `tool_rag` by an update: grant it deliberately.

## Related

- [The RAG API and its budget](../../../core/ai/rag.md#the-api-dd_rag_api)
- [The AI spend limits (per profile and per user)](../../../core/ai/assistant/configuration.md#ai-spend-limits)
- Wire contracts `WC-2026-10-01-ai-spend-budget`, `WC-2026-10-12-ddengine-removed`.
