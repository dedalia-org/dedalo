# Configuration reference

> Part of the [AI Assistant](index.md) section · Previous: [Connecting models](connecting_models.md) · Next: [Privacy & security](privacy_and_security.md) · See also: [Config system](../../configuration/config.md)

Every assistant setting lives in `../private/.env` and is read once at boot. All settings are **fail-closed**: unset means the safest behaviour (disabled, read-only, no external egress). This page is the complete reference — one row per key, plus the request limits that are fixed in code.

!!! info "How config is read"
    Settings are read through the typed config layer (`readEnv`), never `process.env` directly (a [tripwire](../../../development/index.md) enforces this). `../private/.env` is **append-only, documented keys only**. The full census with inline comments is `install/sample.env` (the installer drops a copy at `../private/sample.env`); see the [settings reference](../../configuration/config.md#ai). This page is the narrative version.

---

## The settings

### Master switch

| Key | Default | Effect |
|---|---|---|
| `DEDALO_AGENT_HTTP_ENABLED` | `false` | Enables the assistant's server actions (`agent_models`, `agent_chat`, `agent_chat_stream`, `agent_apply`). With it off, every one refuses like an unknown action and the chat panel shows a disabled message. **The one switch that turns the feature on** — and each user's profile must also grant the `tool_assistant` tool, or every request answers `tool.not_authorized` (global administrators included). |

### Models

| Key | Default | Effect |
|---|---|---|
| `DEDALO_AGENT_MODELS` | *(unset)* | The [model catalog](connecting_models.md) — a JSON array of selectable models, each with an egress class. Unset ⇒ an implicit single Anthropic model *iff* `ANTHROPIC_API_KEY` is set, else the assistant is disabled. Malformed ⇒ disabled (fail-closed). |
| `ANTHROPIC_API_KEY` | *(unset)* | The Anthropic key used by `anthropic` catalog entries (and by the implicit catalog). A model whose `api_key_env` names a different var uses that instead. |
| `AGENT_MODEL` | `claude-opus-4-8` | The model id for the **implicit** catalog only (when `DEDALO_AGENT_MODELS` is unset). Ignored when an explicit catalog is present. |
| `DEDALO_AGENT_MAX_TOKENS` | `16000` | Per-turn output-token cap, unless a catalog entry overrides it with its own `max_tokens`. |

### Write mode

| Key | Default | Effect |
|---|---|---|
| `DEDALO_AGENT_ALLOW_WRITE` | `false` | Exposes the write tools + the change-plan flow. Even on, the loop never writes — it proposes a plan a human confirms. **Refused to global-admin sessions** regardless (confused-deputy wall). |
| `DEDALO_AGENT_WRITE_SECTIONS` | *(unset = none extra)* | Comma-separated allowlist of section `tipo`s the assistant may propose writes to. |

### Privacy / egress

| Key | Default | Effect |
|---|---|---|
| `DEDALO_AGENT_ALLOW_EXTERNAL_PROVIDER_DEFAULT` | `false` | Whether **external**-egress conversations may receive record content at all. `false` (default) = external models get discovery/structure tools and can converse, but every record-content tool call is refused with `mcp.egress_restricted`. See [the egress gate](privacy_and_security.md#the-egress-gate). |
| `DEDALO_RAG_EXTERNAL_PROVIDER_FORBIDDEN_SECTIONS` | *(unset = none)* | Comma-separated section `tipo`s that may **never** reach an external provider, even when the default above is `true`. **Shared with the [RAG subsystem](../rag.md)** — one data classification, both surfaces. |

### Prompt

| Key | Default | Effect |
|---|---|---|
| `DEDALO_AGENT_SYSTEM_PROMPT_APPEND` | *(unset)* | Deployment-specific text appended to the built-in system prompt (after the invariants; it can extend, never reorder them). Use it to add institution context — *"This is the archive of the Museum of X; prefer Catalan labels; the main collection is oral history."* Boot-stable, so it stays inside the cached prompt prefix. |

### AI spend limits

Every conversation turn is one **run** against the user's daily AI limits, checked before the model is called. A run reserves the most output it can produce (the model's per-turn output limit times the twelve turns a run may take) and is then charged the tokens the model reports; a model that reports no usage keeps the whole reservation charged. A user whose limit is used up gets `ai.budget_exhausted` (429) with the time it resets (midnight UTC) — as a normal error, never an opened stream. Nobody is exempt, administrators and root included. The searches the assistant makes inside a conversation belong to that run.

The limits are **not** `.env` settings: they are data, edited in the *AI usage* group of each profile and of each user (Administration).

| Limit | Profile (*Profiles* `dd234`, group `dd649`) | User (*Users* `dd128`, group `dd647`) | Counts |
|---|---|---|---|
| Model runs | `dd696` | `dd692` | Conversation turns (and generated answers) per UTC day. |
| Model tokens | `dd697` | `dd693` | Model tokens per UTC day. |
| Query embeddings | `dd698` | `dd694` | Semantic-search query embeddings per UTC day ([the RAG API](../rag.md#the-api-dd_rag_api)). |
| Vision calls | `dd699` | `dd695` | Vision calls of the identification tool per UTC day. |

Each limit is resolved **on its own**, at every request: the user's value when it is filled in, otherwise the value of the user's profile, otherwise **0**. A limit of 0 refuses every request of that kind — an explicit 0 on the user too, even when the profile allows more — and there is no "unlimited" value. A fresh installation starts with every limit empty, so every AI request is refused until an administrator sets limits on the profiles (or users) that may spend. A change takes effect at the next request. A filled-in value that is not a number, or is negative, counts as 0 — it never falls back to the profile.

A user cannot raise their own limit. On their **own** user record the four user limits are read-only for anyone who is not a global administrator, whatever their profile grants on the *Users* section; the same grant still lets a user manager set **other** users' limits. A refusal with limit 0 means no limit is set (or 0 was set): waiting for the reset does not help, an administrator has to set one.

The day's usage of every user is the **AI usage** section under Administration (`dd660`): one record per user and UTC day, with the four counters. An administrator reads it and may correct it like any section.

---

## A worked `.env` for a real institution

A museum that wants a capable cloud model for public collections **and** a private local model for protected oral history, with confirmed edits enabled for cataloguers:

```bash
# --- AI Assistant ---------------------------------------------------------
DEDALO_AGENT_HTTP_ENABLED=true

# capable cloud model + private local model; user picks per conversation
ANTHROPIC_API_KEY=sk-ant-...
DEDALO_AGENT_MODELS=[{"id":"local","label":"Llama 3.1 (local, private)","provider":"openai_compatible","model":"llama3.1:70b","endpoint":"http://127.0.0.1:11434/v1/chat/completions","egress":"local"},{"id":"claude","label":"Claude Opus 4.8 (external)","provider":"anthropic","model":"claude-opus-4-8","egress":"external","vision":true}]

# proposed edits (confirmed by a human), limited to two sections
DEDALO_AGENT_ALLOW_WRITE=true
DEDALO_AGENT_WRITE_SECTIONS=oh1,rsc197

# external models may see PUBLIC record content, but never the oral-history section
DEDALO_AGENT_ALLOW_EXTERNAL_PROVIDER_DEFAULT=true
DEDALO_RAG_EXTERNAL_PROVIDER_FORBIDDEN_SECTIONS=oh1

# institution context for the prompt
DEDALO_AGENT_SYSTEM_PROMPT_APPEND=This is the archive of the Museum of X. Prefer Catalan (lg-cat) labels when they exist. The oral-history collection (section oh1) is sensitive.
```

Read the privacy lines together: external conversations *may* touch public records (`ALLOW_EXTERNAL_PROVIDER_DEFAULT=true`) but the oral-history section is on the never-egress list (`FORBIDDEN_SECTIONS=oh1`), so a Claude conversation can help catalogue coins yet is refused every oral-history record — while the local model is never restricted. The [Privacy & security](privacy_and_security.md) page explains exactly how those two settings interact.

---

## Request limits (fixed in code)

These bound each request to keep one chat turn from becoming a denial-of-service or a runaway cost. They are not env-tunable:

| Limit | Value | What it bounds |
|---|---|---|
| Question length | 32,768 chars | one user message |
| History entries | 64 | prior turns the client resends |
| History size | 256 KB | total resent history text |
| Images per turn | 8 | attachments on one message |
| Image size | ~5 MiB each (7,000,000 base64 chars) | one attachment |
| Images total | ~15 MiB per turn (21,000,000 base64 chars) | all attachments together |
| Context summary | 2,000 chars | the current-record context blurb |
| Loop iterations | 12 | model turns per question (a runaway-loop backstop) |

Accepted image types: JPEG, PNG, WebP, GIF.

---

## Precedence and the stand-alone MCP server (`DEDALO_MCP_*`) {#the-stand-alone-mcp-server-dedalo_mcp_}

**Precedence.** The real process environment wins over `../private/.env`. Administrators upgrading an existing installation can keep existing `DEDALO_*` lines; where a TS-native name differs, the legacy spelling is honoured as a fallback (the sample.env marks the aliased pairs).

**Not to be confused:** the `DEDALO_MCP_*` keys (`DEDALO_MCP_USER_ID`, `DEDALO_MCP_ALLOW_WRITE`, `DEDALO_MCP_WRITE_SECTIONS`, `DEDALO_MCP_MEDIA_IMPORT_DIR`, `DEDALO_MCP_MEDIA_MAX_BYTES`) configure the **stand-alone MCP server** — a separate process (`bun run src/ai/mcp/server.ts`) that exposes the same tool registry to *external* MCP clients (Claude Desktop, Claude Code) over stdio, as one fixed service user. They have **nothing** to do with the in-app assistant, which always runs as the logged-in browser user via the `DEDALO_AGENT_*` keys above. Configuring one does not affect the other.
