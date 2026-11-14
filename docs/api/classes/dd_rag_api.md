# dd_rag_api

> See also: [JSON API v1](../dedalo_api_v1.md) · [Semantic search / RAG](../../administration/ai/rag.md) · [dispatch](dispatch.md)

Semantic retrieval over the repository: meaning-based record search, passage retrieval for an LLM, "records like this seed", grounded cited answers, the section's embed-group facets, and — behind a second switch — the image-similarity layer.

Registered actions (`src/ai/rag/api.ts`): `semantic_search`, `embed_groups`, `retrieve`, `get_agent_context`, `similar_to`, `ask`, `similar_objects`, `search_by_text_image`, `characterize_object`.

## How to call

- POST JSON to `/api/v1/json` (or the client-relative `/dedalo/core/api/v1/json`) with `dd_api: "dd_rag_api"` and `action: "<method>"`.
- All parameters ride in `rqo.options`.

## Notes

- Every action requires a **session** (none is in `NO_LOGIN_ACTIONS`) and is **CSRF-gated** by the dispatcher.
- The whole class fails closed on the `DEDALO_RAG_ENABLED` kill-switch: while off, every action declines with the coded error `rag.disabled` (503, *"RAG is disabled"*). The ONE exception is `embed_groups`: it is a capability probe the client fires on every section list render with no user act behind it, so while off it ANSWERS `{groups: []}` — an install that deliberately never implemented RAG must be silent to its users (it is logged once at boot instead).
- The three image actions (`similar_objects`, `search_by_text_image`, `characterize_object`) are gated by a **second** switch, `DEDALO_RAG_MEDIA_ENABLED`; with media off they decline with `rag.media_disabled` (503, *"RAG media is disabled"*).
- Envelope: **v2**. A success is `{ ok: true, request_id, msg, data }` — the payload lives in `data` and nowhere else, and `msg` is a RAG outcome token riding as an extension key. A failure is `{ ok: false, request_id, error: { code, category, message, label_key, retryable } }`. The v1 `{ result, msg, errors }` shape is GONE (compat removed 2026-08-16); the response bodies below name `data`.
- **Results are ACL-gated inside `src/ai/rag/retrieval.ts`** (schema ACL + per-record projects filter) — the retrieval chokepoint, not the handler. A caller never sees a record they could not read directly.
- The retrieval actions accept an optional `group` — an embed-group facet id validated against a slug grammar and applied as a bound filter (never raw SQL). `limit` is clamped to `[1, 50]` (default 10).

## semantic_search

### Purpose

Meaning-based record search — the single best record per semantic hit.

### Accepts

- `options`: object (required)
  - `query`: string (required)
  - `section_tipo`: string | array (optional) — scope
  - `limit`: int (optional, `[1, 50]`, default 10)
  - `group`: string (optional) — embed-group facet id

### Returns

`{ ok: true, msg: "ok", data: [ <hit> ] }`. A missing `query` declines with `request.invalid_options` (*"Missing query"*). When the embedding service does not answer the query with a usable vector, the action declines with `rag.embedding_unavailable` (503, *"The embedding service did not return a query vector"*, retryable) rather than running the dense leg blind and ranking arbitrary records.

### Example Request

```json
{
  "dd_api": "dd_rag_api",
  "action": "semantic_search",
  "options": { "query": "silver coins from the 3rd century", "section_tipo": "oh1", "limit": 10 }
}
```

## embed_groups

### Purpose

Return the section's embed-group ids — the client's facet selector and its "is this section semantic-searchable?" gate.

### Accepts

- `options`: object (required)
  - `section_tipo`: string (required)

### Returns

`{ ok: true, msg: "ok", data: { groups: [ <id> ] } }`.

### Usage

After the kill-switch, a malformed tipo, a section the caller cannot read, and a section without a `rag.embed` descriptor all return the **same** `{ groups: [] }` — byte-identical on purpose, so the endpoint is never a section-existence oracle.

### Example Request

```json
{
  "dd_api": "dd_rag_api",
  "action": "embed_groups",
  "options": { "section_tipo": "oh1" }
}
```

## retrieve

### Purpose

Retrieve passages (chunks) that best match a query.

### Accepts

- `options`: object (required)
  - `query`: string (required)
  - `section_tipo`: string | array (optional) — scope
  - `limit`: int (optional, `[1, 50]`, default 10)
  - `group`: string (optional)

### Returns

`{ ok: true, msg: "ok", data: [ <passage> ] }`. A missing `query` declines with `request.invalid_options`; when the embedding service does not answer the query with a usable vector, the action declines with `rag.embedding_unavailable` (503, *"The embedding service did not return a query vector"*, retryable) rather than running the dense leg blind and ranking arbitrary records.

### Example Request

```json
{
  "dd_api": "dd_rag_api",
  "action": "retrieve",
  "options": { "query": "conservation treatment", "limit": 8 }
}
```

## get_agent_context

### Purpose

Retrieve passages shaped as LLM context (same passage retrieval as `retrieve`, different response `msg`).

### Accepts

- Same as `retrieve` (`query`, optional `section_tipo`, `limit`, `group`).

### Returns

`{ ok: true, msg: "agent_context", data: [ <passage> ] }`. Same decline modes as `retrieve`, `rag.embedding_unavailable` included — it is the same passage retrieval.

## similar_to

### Purpose

Records similar to a seed record.

### Accepts

- `options`: object (required)
  - `section_tipo`: string (required) — the seed's section
  - `section_id`: int (required) — the seed record
  - `limit`: int (optional, `[1, 50]`, default 10)
  - `group`: string (optional)

### Returns

`{ ok: true, msg: "ok", data: [ <hit> ] }`. A missing/invalid seed declines with `request.invalid_options`.

### Example Request

```json
{
  "dd_api": "dd_rag_api",
  "action": "similar_to",
  "options": { "section_tipo": "oh1", "section_id": 3, "limit": 10 }
}
```

## ask

### Purpose

Grounded question answering with citations — or a refusal when no context is found.

### Accepts

- `options`: object (required)
  - `query`: string (required)
  - `section_tipo`: string | array (optional) — scope
  - `limit`: int (optional, `[1, 50]`, default 10)

### Returns

`{ ok: true, msg, data: <answer object> }`. `msg` is `"ok"` for a grounded answer; a grounding miss and an egress-restricted record are both **normal** (ok:true) envelopes (no external model was called) with a distinct `msg`; an LLM transport failure declines with `rag.generation_failed` (503, *"The grounded answer could not be generated"*) — never a fabricated answer. The retrieval step in front of the model can decline first: with no usable query vector the action raises `rag.embedding_unavailable` (503, retryable), because an ungrounded retrieval would feed the model arbitrary passages.

### Example Request

```json
{
  "dd_api": "dd_rag_api",
  "action": "ask",
  "options": { "query": "When was the site excavated?", "section_tipo": "oh1" }
}
```

## similar_objects

### Purpose

Visual object similarity from a seed record's stored image vectors.

### Accepts

- `options`: object (required)
  - `section_tipo`: string (required) — the seed's section
  - `section_id`: int (required) — the seed record
  - `similarity_mode`: string (optional) — `visual` or `hybrid` (default)
  - `view`: string (optional)
  - `near_duplicate`: boolean (optional) — apply the near-duplicate similarity floor
  - `limit`: int (optional, `[1, 50]`, default 10)
  - `section_tipo` scope (optional) — defaults to the seed section's configured compare scope

### Returns

`{ ok: true, msg: "ok", data: [ <object> ] }` — each object carries `section_tipo`, `section_id`, `similarity`, `score`, `view`, `thumb_url`, `context`.

### Usage

Additionally requires `DEDALO_RAG_MEDIA_ENABLED`.

### Example Request

```json
{
  "dd_api": "dd_rag_api",
  "action": "similar_objects",
  "options": { "section_tipo": "rsc167", "section_id": 2, "similarity_mode": "hybrid" }
}
```

## search_by_text_image

### Purpose

A text query into the image space (joint text/image tower).

### Accepts

- `options`: object (required)
  - `query`: string (required)
  - `section_tipo`: string | array (optional) — scope
  - `limit`: int (optional, `[1, 50]`, default 10)

### Returns

`{ ok: true, msg: "ok", data: [ <object> ] }` (same object shape as `similar_objects`).

### Usage

Additionally requires `DEDALO_RAG_MEDIA_ENABLED`.

### Example Request

```json
{
  "dd_api": "dd_rag_api",
  "action": "search_by_text_image",
  "options": { "query": "red-figure amphora", "limit": 12 }
}
```

## characterize_object

### Purpose

Neighbour-aggregated typology/period proposals for a seed object (no LLM — proposals are aggregated from visually similar neighbours).

### Accepts

- `options`: object (required)
  - `section_tipo`: string (required) — the seed's section
  - `section_id`: int (required) — the seed record

### Returns

`{ ok: true, msg: "ok", data: <characterization> }`. A missing/invalid seed declines with `request.invalid_options`.

### Usage

Additionally requires `DEDALO_RAG_MEDIA_ENABLED`.

### Example Request

```json
{
  "dd_api": "dd_rag_api",
  "action": "characterize_object",
  "options": { "section_tipo": "rsc167", "section_id": 2 }
}
```
