# RAG setup and cookbook

> **The operational companion to [Retrieval-Augmented Generation & Semantic Search](rag.md).**
> That document explains *what* the RAG subsystem is and *why* (Parts I–IV, for
> researchers) and *how it works internally* (Parts V–VI, the architecture). **This
> document is the hands-on guide**: provision it, connect it, configure every knob,
> and copy-paste recipes for the common tasks.
>
> See also: [Configuration](../configuration/config.md) · [Dédalo API v1](../../api/dedalo_api_v1.md) · [RQO](../../api/rqo.md) · [SQO](../../api/sqo.md) · [Ontology](../../core/ontology/index.md)

The subsystem lives in `src/ai/rag/` (retrieval + generation + object images),
`src/ai/agent/` (the tool-use loop) and `src/ai/mcp/` (the MCP server). It is a
**greenfield TypeScript/Bun build**, registered in the API as the `dd_rag_api`
action class, and is **strictly opt-in** — everything below starts from "off".

---

## Contents

1. [The 60-second mental model](#the-60-second-mental-model)
2. [Install](#install) — provision the vector store & queue
3. [Connect](#connect) — databases, sidecars, LLM, agent
4. [Configure](#configure) — the complete env reference
5. [Enable — the two checklists](#enable--the-two-checklists) (dev / production)
6. [Use cases](#use-cases)
7. [Cookbook](#cookbook) — copy-paste recipes
8. [Troubleshooting](#troubleshooting)

---

## The 60-second mental model

RAG uses **two PostgreSQL databases that are never joined**:

| Database | What lives there | Who owns it |
|---|---|---|
| **Matrix** (`config.db`, e.g. `dedalo7_mib`) | Your real records **and** the `rag_index_queue` dirty-marker table. The ACL source of truth. | Auto-provisioned (queue table self-creates). |
| **Vector** (`dedalo7_rag` by default) | Only embeddings (`rag_embeddings`, partitioned by model). Fully **rebuildable**. | **You provision it** (see [Install](#install)). |

The lifecycle:

```
save a record ──▶ hook enqueues a marker  (matrix DB, best-effort, never blocks the save)
                        │
   cron: rag_drain.ts ──┘─▶ resolve embed groups (ddo_maps) ─▶ chunk ─▶ embed changed ─▶ upsert vectors (vector DB)
                                                                                   │
   dd_rag_api action ──▶ dense + lexical search ─▶ RRF fuse ─▶ ACL gate ─▶ results / grounded answer
```

Two rules that never bend:

- **Opt-in everywhere.** `DEDALO_RAG_ENABLED=true` (master), then per-section
  **embed groups** in the section_map `rag` scope (R1). Image actions also need
  `DEDALO_RAG_MEDIA_ENABLED=true`.
- **ACL is enforced on every hit** (schema permission + per-record projects
  filter), so an AI query returns *exactly* what the same user could read by hand
  — never more.

---

## Install

### Prerequisites

- **Bun** (the server runtime) and a working Dédalo TS install (matrix DB reachable via `config.db`).
- **PostgreSQL ≥ 18** with two extensions available: **`pgvector`** (`vector`) and **`unaccent`**.
  - `pgvector` ≥ 0.7 recommended (HNSW + `halfvec` for >2000-dim models).

### Step 1 — Create the vector database

It may live on the same server as the matrix DB (default) or a separate one.

```bash
createdb dedalo7_rag              # or: CREATE DATABASE dedalo7_rag;
```

### Step 2 — Provision the schema

> **One file, applied once.** The matrix-side queue table self-creates
> (`ensureRagQueueTable()`); the vector schema does not, so it is applied by hand
> from the DDL vendored in the repo at `install/db/rag_embeddings.sql` — the parent
> table, its lookup and lexical indexes, and the
> `rag_create_model_partition(model, dimension)` provisioner the store calls before
> its first write. It is idempotent, so re-applying it after an upgrade is a no-op.

```bash
psql -d dedalo7_rag -f install/db/rag_embeddings.sql
```

That file is the **only** copy of this schema: `bun run test:db:setup` applies the
same one when it builds the suite's own vector database, so what a test exercises
and what an installation runs cannot drift apart.

You do **not** create per-model partitions by hand — the indexer calls
`rag_create_model_partition()` the first time it writes vectors for a model.

### Step 3 — The queue table (matrix DB) — automatic

The dirty-marker queue lives in the **matrix** database and self-provisions:
`initRagHooks()` (called from `startServer()`) runs `ensureRagQueueTable()` at boot
when RAG is enabled. For reference, its DDL is:

```sql
-- created automatically in the MATRIX db; shown for transparency
CREATE TABLE IF NOT EXISTS rag_index_queue (
    section_tipo    varchar(64) NOT NULL,
    section_id      integer     NOT NULL,
    op              varchar(8)  NOT NULL DEFAULT 'index',   -- index | delete
    attempts        integer     NOT NULL DEFAULT 0,
    last_error      text,
    next_attempt_at timestamptz NOT NULL DEFAULT now(),     -- backoff gate
    enqueued_at     timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (section_tipo, section_id)
);
CREATE INDEX IF NOT EXISTS rag_index_queue_ready_idx
    ON rag_index_queue (next_attempt_at, enqueued_at);
```

### Step 4 — Verify

```bash
# Extensions + objects exist?
psql -d dedalo7_rag -c "\dx"                      # expect: vector, unaccent
psql -d dedalo7_rag -c "\d rag_embeddings"        # expect: partitioned table
psql -d dedalo7_rag -c "\df rag_create_model_partition"
```

---

## Connect

### The vector database connection

By default the server connects to the vector DB **on the same host/user/password
as the matrix DB** (`config.db`), only changing the database *name* to
`dedalo7_rag`. Resolution order (`buildRagSqlOptions()`, `vector_store.ts`):

| Fact | Env override | Falls back to |
|---|---|---|
| Database name | `DEDALO_RAG_DB_NAME` (legacy `RAG_DB_NAME`) | `dedalo7_rag` |
| Unix socket | `DEDALO_RAG_DB_SOCKET_CONN` | — (if set, wins) |
| Host | `DEDALO_RAG_DB_HOSTNAME_CONN` | matrix host (`config.db.host`) |
| Port | `DEDALO_RAG_DB_PORT_CONN` | matrix port |
| User | `DEDALO_RAG_DB_USERNAME_CONN` | matrix user |
| Password | `DEDALO_RAG_DB_PASSWORD_CONN` | matrix password |

**Same server (typical):** set nothing but (optionally) `DEDALO_RAG_DB_NAME`.

**Separate pgvector server:** set the `DEDALO_RAG_DB_*_CONN` keys in `../private/.env`.

```dotenv
# ../private/.env — vector DB on a dedicated host
DEDALO_RAG_DB_NAME=dedalo7_rag
DEDALO_RAG_DB_HOSTNAME_CONN=10.0.0.42
DEDALO_RAG_DB_PORT_CONN=5432
DEDALO_RAG_DB_USERNAME_CONN=dedalo
DEDALO_RAG_DB_PASSWORD_CONN=•••••
```

### The service endpoints (all optional; deterministic fallbacks otherwise)

| Service | HTTP contract | Env |
|---|---|---|
| **Embedding sidecar** (text) | `POST {endpoint}/embed {model, input:[…]}` → `{embeddings:[[…],…]}` | `DEDALO_RAG_EMBEDDING_PROVIDER=sidecar` + `DEDALO_RAG_EMBEDDING_ENDPOINT` |
| **Multimodal sidecar** (images) | `POST /image {model, images:[b64,…]}` and `POST /text {model, input:[…]}` → `{embeddings:[…]}` (also tolerates OpenAI `{data:[{embedding}]}`) | `DEDALO_RAG_MULTIMODAL_ENDPOINT` |
| **Generation LLM** (`ask`) | OpenAI-compatible `POST {endpoint}` chat-completions | `DEDALO_RAG_LLM_ENDPOINT` (+ `_MODEL`, `_API_KEY`) |
| **Agent** (`src/ai/agent`) | Official Anthropic SDK (developer `runAgent`/`AnthropicProvider`); the in-app agent resolves through the model catalog (`DEDALO_AGENT_MODELS`), which also supports `openai_compatible` (local) models | `ANTHROPIC_API_KEY` (+ `AGENT_MODEL`), or `DEDALO_AGENT_MODELS` |
| **MCP** (`src/ai/mcp`) | stdio; identity fixed at startup | `DEDALO_MCP_USER_ID` (+ `DEDALO_MCP_ALLOW_WRITE`) |

Without any of these, the pipeline still runs end-to-end on deterministic,
offline providers — perfect for CI and first-run smoke tests, **not** for real
semantic quality.

---

## Configure

Every key is read at the point of use via `readEnv()` (real process env, then
`../private/.env`). Defaults are the effective code defaults. A commented
template ships in `install/sample.env`; see the [settings reference](../configuration/config.md#ai).

### Master switches

| Key | Default | Effect |
|---|---|---|
| `DEDALO_RAG_ENABLED` | `false` | Master gate. Off ⇒ every `dd_rag_api` action declines with `rag.disabled` and the save hook is not registered. `embed_groups` is the exception: the capability probe answers `{groups: []}`, so a RAG-less install shows its users no semantic UI and no alert. |
| `DEDALO_RAG_MEDIA_ENABLED` | `false` | Gate for the three image actions (`similar_objects`, `search_by_text_image`, `characterize_object`); off ⇒ `rag.media_disabled`. |

### Vector database

| Key | Default | Notes |
|---|---|---|
| `DEDALO_RAG_DB_NAME` / `RAG_DB_NAME` | `dedalo7_rag` | Vector DB name. |
| `DEDALO_RAG_DB_HOSTNAME_CONN` | matrix host | Set only for a separate server. |
| `DEDALO_RAG_DB_PORT_CONN` | matrix port | |
| `DEDALO_RAG_DB_USERNAME_CONN` | matrix user | |
| `DEDALO_RAG_DB_PASSWORD_CONN` | matrix password | |
| `DEDALO_RAG_DB_SOCKET_CONN` | — | Unix socket path (wins over host/port). |

### Text embedding

| Key | Default | Notes |
|---|---|---|
| `DEDALO_RAG_EMBEDDING_PROVIDER` | `` (deterministic) | `sidecar` to use a real service. |
| `DEDALO_RAG_EMBEDDING_ENDPOINT` | — | Required when provider = `sidecar`. |
| `DEDALO_RAG_EMBEDDING_MODEL` | `bge-m3` | Sent to the sidecar; also the partition key. |
| `DEDALO_RAG_BATCH_SIZE` | `32` | Texts per sidecar request. |
| `DEDALO_RAG_PROVIDER_TIMEOUT` | `30` | Seconds (converted to ms internally). |
| ~~`DEDALO_RAG_EMBEDDABLE_MODELS`~~ | — | **Retired 2026-07-22** — selection is the authored `rag.embed` ddo_map (R1), not a model scan. |

### Chunking (install defaults; per-GROUP `chunk`/`mode` in `rag.embed` overrides — R1)

| Key | Default | Notes |
|---|---|---|
| `DEDALO_RAG_CHUNK_STRATEGY` | `structural_semantic` | or `structural`. |
| `DEDALO_RAG_CHUNK_TOKENS` | `450` | Target max tokens per chunk. |
| `DEDALO_RAG_CHUNK_MIN_TOKENS` | `120` | Orphan-absorption floor. |
| `DEDALO_RAG_SEMANTIC_BREAKPOINT_THRESHOLD` | `0.92` | Percentile for a semantic split. |

### Retrieval fusion

| Key | Default | Notes |
|---|---|---|
| `DEDALO_RAG_RRF_K` | `60` | Reciprocal Rank Fusion constant. |

### Grounded Q&A (`ask`)

| Key | Default | Notes |
|---|---|---|
| `DEDALO_RAG_LLM_ENDPOINT` | `` (stub) | OpenAI-compatible chat endpoint; unset ⇒ deterministic stub. |
| `DEDALO_RAG_LLM_API_KEY` | — | Bearer token. |
| `DEDALO_RAG_LLM_MODEL` | `local-model` | |
| `DEDALO_RAG_LLM_MAX_OUTPUT_TOKENS` | `1024` | |
| `DEDALO_RAG_LLM_TIMEOUT` | `60` | Seconds. |
| `DEDALO_RAG_LLM_TEMPERATURE` | `0` | |
| `DEDALO_RAG_LLM_SYSTEM_PROMPT` | built-in safe default | Per-section section_map `rag.system_prompt` wins (node `properties.rag.system_prompt` as legacy fallback). |
| `DEDALO_RAG_CONTEXT_TOKEN_BUDGET` | `12000` | Passage budget handed to the model. |

### Privacy / egress

| Key | Default | Notes |
|---|---|---|
| `DEDALO_RAG_ALLOW_EXTERNAL_PROVIDER_DEFAULT` | `false` | Off ⇒ **every** record is `restricted` (external generation forbidden). |
| `DEDALO_RAG_EXTERNAL_PROVIDER_FORBIDDEN_SECTIONS` | — | CSV of section tipos that must **never** egress externally. |

### Multimodal image layer

| Key | Default | Notes |
|---|---|---|
| `DEDALO_RAG_MULTIMODAL_PROVIDER` | `local` | Non-`local` ⇒ `isExternal()` true (future egress gate). |
| `DEDALO_RAG_MULTIMODAL_MODEL` | `clip-ViT-B-32` | |
| `DEDALO_RAG_MULTIMODAL_ENDPOINT` | `` | Unset ⇒ deterministic multimodal provider. |
| `DEDALO_RAG_MULTIMODAL_API_KEY` | — | |
| `DEDALO_RAG_IMAGE_MAX_PX` | `512` | Downsize cap (ingest side, when built). |
| `DEDALO_RAG_IMAGE_HYBRID` | `true` | Add a lexical-over-context leg to object similarity. |
| `DEDALO_RAG_NEAR_DUPLICATE_SIMILARITY` | `0.93` | Floor for `near_duplicate: true`. |
| `DEDALO_RAG_CHARACTERIZE_TOP_K` | `20` | Neighbours aggregated in `characterize_object`. |

### Agent / MCP (see [`rag.md` Part V](rag.md#part-v--for-developers))

| Key | Default | Notes |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | Required for the agent loop; it **fails closed** without it. |
| `AGENT_MODEL` | `claude-opus-4-8` | Agent model override. |
| `DEDALO_AGENT_MODELS` | — | JSON model catalog the in-app agent resolves through (`model_catalog.ts`, `resolveProvider`); also supports `openai_compatible` (local) models. |
| `DEDALO_MCP_USER_ID` | — | The `dd128` user id the MCP server acts as (`-1` = superuser, dev only). Missing/invalid ⇒ hard startup error. |
| `DEDALO_MCP_ALLOW_WRITE` | `false` | Enables the MCP write tools (still permission-checked per call). |
| `DEDALO_MCP_WRITE_SECTIONS`, `DEDALO_MCP_MEDIA_IMPORT_DIR`, `DEDALO_MCP_MEDIA_MAX_BYTES` | — | MCP write/media-import scoping. |

### Shared (not RAG-specific, but consumed by ingestion)

| Key | Notes |
|---|---|
| `APPLICATION_LANGS` | Data langs a translatable component is indexed in. |
| `DEDALO_DATA_NOLAN` | The no-lang code for non-translatable components (`lg-nolan`). |

---

## Enable — the two checklists

### A. Dev / smoke (zero external services)

1. Provision the vector DB ([Install](#install)).
2. `../private/.env`: `DEDALO_RAG_ENABLED=true`.
3. Opt a section + a text component in via the ontology (Recipe 1).
4. Index a record (Recipe 2) and query it (Recipe 4). The deterministic embedder
   makes this work with no keys — but it is **lexical-ish, not semantic**; use it
   only to prove the wiring.

### B. Production (real semantic quality)

1. Everything in A, plus a real **embedding sidecar**:
   ```dotenv
   DEDALO_RAG_EMBEDDING_PROVIDER=sidecar
   DEDALO_RAG_EMBEDDING_ENDPOINT=http://127.0.0.1:8088
   DEDALO_RAG_EMBEDDING_MODEL=bge-m3
   ```
2. Wire the **drain to cron** (Recipe 3) — without it, markers never index.
3. (Optional) a **generation LLM** for `ask` (Recipe 5) and the **egress policy**
   (Recipe 7).
4. (Optional) the **image layer** (`DEDALO_RAG_MEDIA_ENABLED=true` + a multimodal
   sidecar — Recipe 8).

> **Changed the embedding model?** It is a new partition key. Old vectors under the
> previous model still exist but are never queried; re-index everything under the
> new model (Recipe 11).

---

## Use cases

| I want to… | Action / capability | Recipe |
|---|---|---|
| Find records **about an idea**, not a string | `semantic_search` | [R4](#r4--call-semantic_search-from-the-api) |
| Feed relevant passages to a chat/agent | `retrieve` / `get_agent_context` | [R9](#r9--drive-it-as-an-agent-mcp) |
| Ask a question, get a **cited, grounded answer** | `ask` | [R5](#r5--grounded-ask-with-a-local-llm) |
| "More like this record" | `similar_to` | [R4](#r4--call-semantic_search-from-the-api) |
| "Objects visually like this one" / **near-dup detection** | `similar_objects` | [R8](#r8--object-image-similarity--characterization) |
| Describe query → matching object photos | `search_by_text_image` | [R8](#r8--object-image-similarity--characterization) |
| **Propose an object's typology/period** from its relatives (no LLM) | `characterize_object` | [R8](#r8--object-image-similarity--characterization) |
| Keep a sensitive collection **local-only** | egress policy | [R7](#r7--keep-a-sensitive-section-local-only) |
| Backfill an existing collection | indexer / queue | [R2](#r2--backfill-existing-records) |

---

## Cookbook

> Recipes use `../private/.env` for config and the section tipo `oh1` (oral
> history) / component `oh23` (a transcription `component_text_area`) as running
> examples. Substitute your own tipos.

### R1 — Opt a section in: the `section_map` `rag.embed` groups (2026-07-22)

Opt-in is **data, in the ontology** — no code. It lives in the section's
**`section_map`** node (the same node that declares the section's Term/parent
roles), under a `rag` key in its `properties`. The old per-node booleans
(`properties.rag.enabled` / `embed: true` on components) are **retired** — they
could not differentiate two virtual sections sharing components, and indexed
nothing at all for virtual sections.

`rag.embed` is an **array of named groups**. Each group is one **vector document
per record and data language**, built from a `ddo_map` in the exact
request_config `show.ddo_map` shape:

```json
// SECTION_MAP node of the (virtual) section — properties
{
  "rag": {
    "embed": [
      { "id": "card",
        "ddo_map": [
          { "tipo": "oh27", "section_tipo": "self" },
          { "tipo": "oh32", "section_tipo": "self" }
        ] },
      { "id": "transcription",
        "ddo_map": [ { "tipo": "oh23", "section_tipo": "self" } ],
        "mode": "transcription",
        "chunk": { "max_tokens": 450, "min_tokens": 120 } }
    ],
    "strategy": "structural_semantic",
    "system_prompt": "Answer as an oral-history archivist, citing timecodes."
  }
}
```

Rules and powers:

- **One canonical shape.** `embed` is always an array; every group is always
  `{ id, ddo_map, chunk?, mode?, strategy? }`. `id` is a slug (≤ 40 chars),
  unique per section — `default` by convention when one group is enough. Chunks
  are stored under `component_tipo = 'rag:<id>'`.
- **Omit the ddo `mode` unless you mean it.** A ddo's `mode` selects the model's
  RENDER transform, and `"list"` applies the literal list-preview —
  `component_text_area` truncates to 130 chars, silent data loss in a vector.
  Absent `mode` gets the embedding defaults: **literal → `edit`** (full value,
  deep children included), **relation → `list`** (compact target-term
  resolution). An explicitly authored `mode` is honored verbatim.
- **Groups are facets.** A person section can declare separate `profession` and
  `filiation` groups: independent vectors, so a profession query is never
  diluted by filiation text — and every search action accepts a `group` option
  to scope to one facet (`"group": "transcription"`).
- **Deep resolution, request_config semantics.** A relation entry resolves to
  its target's term text; declare child ddos (`"parent": "<relationTipo>",
  "section_tipo": "<targetTipo>"`) to resolve specific components in the target,
  to arbitrary depth — e.g. embed the *mint's name* into a coin's card:

  ```json
  { "id": "card", "ddo_map": [
      { "tipo": "numisdata16", "section_tipo": "self" },
      { "tipo": "numisdata57", "section_tipo": "self" },
      { "tipo": "numisdata73", "section_tipo": "numisdata3", "parent": "numisdata57" }
  ] }
  ```
- **Virtual sections just work** — and can differ. The section_map read is
  virtual-aware: a virtual section's OWN section_map node wins; without one it
  falls back to the real section's (via the node's `relations[0].tipo`). So
  `rsc167` and `rsc170` (same real section) can carry different `rag.embed`
  maps. Records are always keyed by the tipo they are stored under (the virtual
  tipo).
- **Coherence guarantee.** Each group always embeds its FULL definition with
  system scope, whoever's save triggered the re-index — the vector never encodes
  the editor's permissions or language. Retrieval gates `rag:` chunks at the
  RECORD level (section read permission + per-record projects ACL).

### R2 — Backfill existing records

There is no dedicated backfill CLI yet; drive the indexer directly, or enqueue and
let the drain do it.

```ts
// scripts/rag_backfill_oh1.ts  —  bun run scripts/rag_backfill_oh1.ts
import { buildRagIndexer } from '../src/ai/rag/indexer.ts';
import { sql } from '../src/core/db/postgres.ts';

const indexer = buildRagIndexer();
const rows = (await sql.unsafe(
  `SELECT section_id FROM matrix WHERE section_tipo = $1 ORDER BY section_id`, ['oh1'],
)) as { section_id: number }[];

for (const { section_id } of rows) {
  const ok = await indexer.indexRecordText({ sectionTipo: 'oh1', sectionId: section_id });
  console.log(`oh1/${section_id}: ${ok ? 'indexed' : 'retry-later'}`);
}
```

Or enqueue everything and let cron drain it:

```ts
import { buildRagQueue } from '../src/ai/rag/queue.ts';
const queue = buildRagQueue();
for (const { section_id } of rows) {
  await queue.enqueue({ sectionTipo: 'oh1', sectionId: section_id }, 'index');
}
```

From then on, **ordinary saves keep the index fresh** automatically (the save hook
enqueues a marker; the drain processes it).

### R3 — Wire the drain to cron (required in production)

The drain claims ready markers, embeds and upserts. It is single-flighted by a
Postgres advisory lock (safe to overlap / run on every worker) and no-ops when RAG
is off.

```cron
* * * * * cd /srv/dedalo-ts && bun run src/ai/rag/cli/rag_drain.ts >> /var/log/dedalo/rag_drain.log 2>&1
```

```bash
# Manual run (optional batch-size arg; default 100):
bun run src/ai/rag/cli/rag_drain.ts 200
```

A record that fails backs off exponentially (`2^attempts` min, capped at 30) and
is dropped after 5 attempts.

### R4 — Call `semantic_search` from the API

`dd_rag_api` is a normal API class: it goes through the same login + CSRF +
session gate as every other call (see [Dédalo API v1](../../api/dedalo_api_v1.md) for
the auth handshake). The request is an **RQO** posted to `/api/v1/json`:

```json
{
  "dd_api": "dd_rag_api",
  "action": "semantic_search",
  "options": {
    "query": "displacement caused by the building of the reservoir",
    "section_tipo": ["oh1"],
    "limit": 8
  }
}
```

```jsonc
// response.body.data — record-level, ACL-filtered, best-first
[
  { "section_tipo": "oh1", "section_id": 412, "component_tipo": "oh23",
    "lang": "lg-spa", "snippet": "…cuando llegó el agua tuvimos que marcharnos…",
    "score": 0.031 }
]
```

`options` fields: `query` (required), `section_tipo` (string or string[] — a
**relevance** narrowing, applied *after* the ACL gate), `limit` (clamped to
`[1, 50]`, default `10`), and `group` (optional — an embed-group id from R1;
scopes the search to that facet's vectors, e.g. `"group": "transcription"`).
`retrieve` / `get_agent_context` take the same options but return **passages**
(each hit + `chunk_index` + `contributors`). `similar_to` takes
`{ section_tipo, section_id, limit, group? }` and returns nearest records (seed
excluded); with `group` it compares by that facet only ("similar by
profession"). `embed_groups` takes `{ section_tipo }` and returns
`{groups: [ids]}` — empty for a malformed tipo, a section the caller cannot
read, or a section without a descriptor (byte-identical by design; never an
existence oracle).

**Quick programmatic test** (bypasses the HTTP/CSRF layer — for a dev box):

```ts
// bun run scripts/rag_try.ts
import { ragApiActions } from '../src/ai/rag/api.ts';
process.env.DEDALO_RAG_ENABLED = 'true';
const superuser = { userId: -1, isGlobalAdmin: true, isDeveloper: true };
const res = await ragApiActions.semantic_search(
  { options: { query: 'reservoir displacement', section_tipo: ['oh1'], limit: 5 } } as never,
  { principal: superuser } as never,
);
console.log(res.body.msg, res.body.data);
```

### R4b — Semantic search in the CLIENT (list quick-input + search panel)

Since 2026-07-22 semantic search is part of the normal section-search UI — no
API calls needed:

- **Quick input** ("Search by meaning…") in the section list toolbar, and a
  **semantic block** at the top of the search panel, where the query COMPOSES
  (AND) with the structured filter tree. Both appear only when the searched
  section declares embed groups (the client asks `embed_groups` once per
  section; empty ⇒ hidden).
- **Facet selector**: sections with several embed groups get a dropdown
  (`card` / `fulltext` / …) next to the panel input; single-group sections
  hide it.
- **How it works** (resolve-once-then-pin): the client calls `semantic_search`
  once, pins the ranked ids via `sqo.filter_by_locators`, and adds the
  `{mode:"locator_position"}` order entry so the list, its pagination, counts
  and exports all keep the relevance order. A **pinned chip** in the list
  header shows the active pin state ("N results pinned" / "no matches" /
  "semantic unavailable") with a ✕ that clears it — the chip is derived from
  the SQO, so a pin restored from the server session after a reload is always
  visible and clearable.
- **Presets**: saving a search preset stores the LIVE natural-language query
  (`{"semantic":{q,group}}` inside the filter value) — loading it restores the
  query and Apply re-runs it against the CURRENT index under the loading
  user's permissions. The resolved id list is never frozen into a preset.

### R5 — Grounded `ask` with a local LLM

Point `ask` at any OpenAI-compatible endpoint (llama.cpp `--api`, vLLM, TEI, LM
Studio, Ollama's OpenAI shim, …):

```dotenv
DEDALO_RAG_LLM_ENDPOINT=http://127.0.0.1:8080/v1/chat/completions
DEDALO_RAG_LLM_MODEL=qwen2.5-7b-instruct
DEDALO_RAG_LLM_TEMPERATURE=0
```

```json
{ "dd_api": "dd_rag_api", "action": "ask",
  "options": { "query": "What do informants say about losing farmland to the dam?",
               "section_tipo": ["oh1"] } }
```

```jsonc
// response.body.data
{
  "answer": "Several informants describe being forced to leave when the reservoir flooded their fields…",
  "citations": [ { "locator": "oh1-412", "sectionTipo": "oh1", "sectionId": 412, "citedText": "…" } ],
  "provenance": [ { "section_tipo": "oh1", "section_id": 412, "chunk_index": 3, "text": "…", "score": 0.031 } ],
  "grounded": true, "used_provider": "http", "model": "qwen2.5-7b-instruct"
}
```

**Guarantees:** no permitted context ⇒ `grounded:false`, empty citations, **no
model call**, and `msg: "no_grounded_context"`. A transport/protocol failure ⇒
`generation_failed` (never a fabricated answer). With no `DEDALO_RAG_LLM_ENDPOINT`,
a deterministic self-citing stub answers so `ask` is testable offline.

### R6 — Use a real embedding sidecar

Stand up any HTTP service honoring the contract, then set the three env keys
(Checklist B). Minimal reference sidecar (`bge-m3` via `sentence-transformers`):

```python
# embed_server.py  —  uvicorn embed_server:app --port 8088
from fastapi import FastAPI
from sentence_transformers import SentenceTransformer
app = FastAPI(); model = SentenceTransformer("BAAI/bge-m3")

@app.post("/embed")
def embed(body: dict):
    return {"embeddings": model.encode(body["input"], normalize_embeddings=True).tolist()}
```

```dotenv
DEDALO_RAG_EMBEDDING_PROVIDER=sidecar
DEDALO_RAG_EMBEDDING_ENDPOINT=http://127.0.0.1:8088
DEDALO_RAG_EMBEDDING_MODEL=bge-m3
```

The dimension is **discovered from the response** (never hard-coded); the first
write auto-creates the `bge-m3` partition with a matching typed column + HNSW
index. A non-OK/malformed response returns `[]` — treated as a *retryable* miss,
never a garbage vector.

### R7 — Keep a sensitive section local-only

Egress is **fail-closed by default**: with `DEDALO_RAG_ALLOW_EXTERNAL_PROVIDER_DEFAULT`
off, every record is `restricted`. To allow external generation generally but pin
specific collections to local-only:

```dotenv
DEDALO_RAG_ALLOW_EXTERNAL_PROVIDER_DEFAULT=true
DEDALO_RAG_EXTERNAL_PROVIDER_FORBIDDEN_SECTIONS=oh1,rsc55
```

Combined with ACL (which already restricts *who* can retrieve), this restricts
*where the text may go* for generation.

### R8 — Object image similarity & characterization

**1. Opt the section in** via `properties.rag.context` — declare, in the ontology,
which images carry the visual signal (and their `view`) and which components are
the typology / period / material:

```json
{ "rag": { "context": {
    "images":   [ { "tipo": "numd5", "view": "obverse" }, { "tipo": "numd6", "view": "reverse" } ],
    "metadata": { "typology": "numd10", "period": "numd20", "material": "numd30" },
    "compare_scope": ["numisdata4"]
  } } }
```

**2. Enable media** + a multimodal provider:

```dotenv
DEDALO_RAG_MEDIA_ENABLED=true
DEDALO_RAG_MULTIMODAL_ENDPOINT=http://127.0.0.1:8089   # CLIP/SigLIP sidecar; unset ⇒ deterministic
DEDALO_RAG_MULTIMODAL_MODEL=clip-ViT-B-32
```

**3. Call the actions:**

```json
{ "dd_api": "dd_rag_api", "action": "similar_objects",
  "options": { "section_tipo": "numisdata4", "section_id": 88,
               "similarity_mode": "hybrid", "near_duplicate": false, "limit": 8 } }
```
```json
{ "dd_api": "dd_rag_api", "action": "characterize_object",
  "options": { "section_tipo": "numisdata4", "section_id": 88 } }
```

`characterize_object` returns **no LLM guess** — a similarity-weighted vote over
real cataloged neighbours, per role, with confidence and cited evidence
(thumbnails included).

> **⚠ Ingest gap.** Only the *retrieval* side of the image layer is built today.
> There is no automated pipeline that reads a record's images off disk and writes
> `modality:'image'` vectors on save (unlike text). Until that lands, image vectors
> must be inserted by an out-of-band job that calls the multimodal provider's
> `embedImage()` and `upsertEmbeddingRows()` (see `test/unit/rag_multimodal.test.ts`
> for the exact row shape). `similar_objects` / `search_by_text_image` /
> `characterize_object` are real and ACL-gated, but return empty until vectors exist.

### R9 — Drive it as an agent (MCP)

Expose the same ACL-gated tools to any MCP client (Claude Desktop, etc.). The MCP
server acts as **one fixed user** resolved at startup:

```bash
DEDALO_MCP_USER_ID=42 bun run src/ai/mcp/server.ts          # read-only
DEDALO_MCP_USER_ID=42 DEDALO_MCP_ALLOW_WRITE=true bun run src/ai/mcp/server.ts
```

```jsonc
// Claude Desktop mcp config
{ "mcpServers": {
    "dedalo": { "command": "bun",
      "args": ["run", "/srv/dedalo-ts/src/ai/mcp/server.ts"],
      "env": { "DEDALO_MCP_USER_ID": "42", "DEDALO_RAG_ENABLED": "true" } } } }
```

Read tools (`dedalo_search_section`, `dedalo_read_record`, `dedalo_describe_node`)
are always on; write tools appear only with `DEDALO_MCP_ALLOW_WRITE=true` and are
still permission-checked per call. The **agent loop** (`src/ai/agent/loop.ts`,
Anthropic-backed) adds `dedalo_semantic_search`; it fails closed without
`ANTHROPIC_API_KEY`.

### R10 — Monitor & reconcile

```ts
import { RagQueue, defaultMatrixQueryer } from '../src/ai/rag/queue.ts';
const queue = new RagQueue(defaultMatrixQueryer());
console.log(await queue.stats()); // { pending, ready, blocked, failed, oldestAgeSec }
```

Fix presence drift (records added/removed while the drain was off):

```ts
import { buildRagIndexer } from '../src/ai/rag/indexer.ts';
import { buildRagQueue } from '../src/ai/rag/queue.ts';
import { sql } from '../src/core/db/postgres.ts';

const indexer = buildRagIndexer();
const queue = buildRagQueue();
await indexer.reconcileSection(
  'oh1',
  async () => ((await sql.unsafe('SELECT section_id FROM matrix WHERE section_tipo=$1', ['oh1'])) as { section_id: number }[]).map(r => r.section_id),
  (loc, op) => queue.enqueue(loc, op),
); // enqueues index/delete corrections for the drift
```

### R11 — Re-index after a model or chunker change

- **New embedding model** (`DEDALO_RAG_EMBEDDING_MODEL`): a new partition. Re-index
  the affected sections (R2). Optionally drop the stale partition:
  `DROP TABLE rag_embeddings_<old_model_slug>;`
- **Chunker algorithm change**: bump `CHUNKER_VERSION` in `chunker.ts` — every
  chunk's `source_hash` changes, so the next drain re-embeds everything (the
  hash-diff no longer matches). Then re-drain / re-index.

### R12 — End-to-end smoke test (offline)

```bash
# All deterministic; no keys, no network (needs the two DBs).
bun test test/unit/rag_pipeline.test.ts       # index → hybrid retrieve → ACL DoD
bun test test/unit/rag_store.test.ts test/unit/rag_queue_integration.test.ts
# Pure-logic (no DB):
bun test test/unit/rag_chunker.test.ts test/unit/rag_fusion.test.ts \
         test/unit/rag_config.test.ts test/unit/rag_ask.test.ts \
         test/unit/rag_api.test.ts test/unit/rag_multimodal.test.ts
```

The DoD assertion (`rag_pipeline.test.ts`): a denied principal gets **nothing**
from the same query a superuser gets real hits from.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Action declines with `rag.disabled` | Master switch off | `DEDALO_RAG_ENABLED=true`, restart. (`embed_groups` never does: off, it answers `{groups: []}`.) |
| Image action declines with `rag.media_disabled` | Media switch off | `DEDALO_RAG_MEDIA_ENABLED=true`. |
| Action declines with `auth.not_logged` | No session/principal on the call | Authenticate (real API) or pass a `Principal` (script). |
| `semantic_search` returns `[]` for everyone | Nothing indexed | No `rag.embed` groups in the section_map (R1) — or malformed (check server log: `rag: … dropped`); or drain never ran (R3); or backfill not done (R2). |
| Returns `[]` for one user but not another | **Working as designed** — ACL. That user can't read those records. | — |
| `relation "rag_embeddings" does not exist` / errors on first write | Vector schema not provisioned | Run `rag_schema.sql` (Install Step 2). |
| Connection refused / wrong DB | Vector DB creds | Check `DEDALO_RAG_DB_*_CONN` vs the actual server; default is the matrix host with DB name `dedalo7_rag`. |
| Lexical leg never matches | Index expression drift | The GIN index must be `to_tsvector('simple', f_unaccent(coalesce(source_text,'')))` — recreate it exactly. |
| `ask` returns `generation_failed` | LLM endpoint down/incompatible | Verify `DEDALO_RAG_LLM_ENDPOINT` speaks OpenAI chat-completions; check `_API_KEY`/`_TIMEOUT`. |
| Markers pile up in `rag_index_queue` | Drain not running | Wire cron (R3); inspect `RagQueue.stats()` and rows' `last_error`. |
| Real (non-deterministic) results wanted | Deterministic fallback still active | Set the embedding sidecar (R6); re-index. |

---

*Conceptual & internals reference: [RAG & Semantic Search](rag.md). Config system:
[Configuration](../configuration/config.md). API envelope & auth: [Dédalo API v1](../../api/dedalo_api_v1.md).
Subsystem code: `src/ai/rag/`, `src/ai/agent/`, `src/ai/mcp/`.*
