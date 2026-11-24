# Endpoint reference

The authoritative, one-section-per-endpoint reference for the Dédalo Publication API **v2** (OpenAPI 3.1, spec version `2.1.0`): method, path, parameters, response shape and a working `curl` example for every route.

The API is read-only and multi-database. Every data route is scoped by a `{db}` path segment that must appear in the server's `DB_NAMES` allowlist (otherwise the request is rejected with `404`). Records are identified by `section_id`; multilingual values are stored one row per language in a `lang` column (`lg-xxx` format).

!!! info "Base path"
    All paths below are relative to the configurable `BASE_PATH` (default `/publication/server_api/v2`). The examples use `http://localhost:3100/publication/server_api/v2`. Static routes are registered before `/:db/...`, so a database name can never shadow them.

Cross-cutting concerns are documented in sibling pages and only summarised here:

- Filter DSL, sorting, field selection, pagination, `lang` and relation resolution → [querying.md](querying.md).
- Error format (RFC 9457), caching/`ETag`, `Link` pagination and response timing → [http_semantics.md](http_semantics.md).
- Rate limiting, API-key authentication, CORS and DoS bounds → [security.md](security.md).

## Path parameters

These appear across the data routes:

| Parameter | Type | Validation |
| --- | --- | --- |
| `db` | string | Must be a configured public database (`assertKnownDb`). |
| `table` | string | `^[A-Za-z_][A-Za-z0-9_]*$` |
| `id` | integer | Positive integer, coerced via `recordIdSchema` (`z.coerce.number().int().positive()`). |

---

## GET /

API index. Entry point with `BASE_PATH`-prefixed links to the main resources.

**Response**

```json
{
  "name": "Dédalo Publication API",
  "version": "2.1.0",
  "links": {
    "databases": "/publication/server_api/v2/databases",
    "docs": "/publication/server_api/v2/docs",
    "openapi": "/publication/server_api/v2/openapi.yaml",
    "health": "/publication/server_api/v2/health"
  }
}
```

**Example**

```bash
curl http://localhost:3100/publication/server_api/v2/
```

---

## GET /databases

Lists the public databases exposed by this server. Use the returned `name` as the `{db}` path segment.

**Response**

```json
{
  "data": [
    {
      "name": "dedalo_web",
      "links": { "tables": "/publication/server_api/v2/dedalo_web/tables" }
    }
  ]
}
```

**Example**

```bash
curl http://localhost:3100/publication/server_api/v2/databases
```

---

## GET /{db}/tables

Lists the tables of a database with row and column counts.

**Path params:** `db`.

!!! note "Caching"
    Table schema introspection is cached for about 30 seconds, so repeated calls are cheap.

**Response**

```json
{
  "data": [
    { "name": "interview", "row_count": 142, "column_count": 12 },
    { "name": "audiovisual", "row_count": 142, "column_count": 8 }
  ]
}
```

!!! note "`row_count` here is an estimate"
    In the table **list**, `row_count` is InnoDB's own estimate (read from `INFORMATION_SCHEMA`), not
    an exact count — counting every row of every table on each listing would be a needless full scan
    per request. The single-table endpoint below returns an exact `COUNT(*)`.

**Example**

```bash
curl http://localhost:3100/publication/server_api/v2/dedalo_web/tables
```

---

## GET /{db}/tables/{table}

Returns the schema of one table: its columns (name and SQL type) and row count.

**Path params:** `db`, `table`.

**Response**

```json
{
  "data": {
    "name": "interview",
    "row_count": 142,
    "columns": [
      { "name": "section_id", "type": "int" },
      { "name": "lang", "type": "varchar" },
      { "name": "code", "type": "varchar" },
      { "name": "title", "type": "varchar" },
      { "name": "transcription", "type": "longtext" }
    ]
  }
}
```

**Example**

```bash
curl http://localhost:3100/publication/server_api/v2/dedalo_web/tables/interview
```

---

## GET /{db}/tables/{table}/records

Lists records with filtering, sorting, pagination, field selection and relation resolution. This is the main query model.

**Path params:** `db`, `table`.

**Query params** (validated by `listRecordsQuerySchema` + `parseFilterParams`/`parseSort`):

| Parameter | Type | Default | Notes |
| --- | --- | --- | --- |
| `filter[field][op]` | string | — | Bracketed filters; operator defaults to `eq`. Repeat for `AND`. See [querying.md](querying.md). |
| `sort` | string | — | Comma-separated; leading `-` = descending (`sort=title,-section_id`). |
| `fields` | string | all columns | Comma-separated column allowlist. |
| `limit` | integer | `100` | `min(0)`, `max(1000)`. `0` is allowed for count-only requests. |
| `offset` | integer | `0` | `min(0)`. |
| `lang` | string | — | `^lg-[a-z]{2,5}$`. Rejected on tables without a `lang` column. |
| `count` | boolean | `false` | When true, adds `pagination.total` (extra COUNT query). Accepts `true`/`1`. |
| `resolve_relations` | string (JSON) | — | Forward relation resolution, e.g. `{"image":"image"}` or `"auto"`. See [querying.md](querying.md). |
| `resolve_inverse_relations` | string | — | Resolves the `dd_relations` column; `true` or a JSON map. See [querying.md](querying.md). |

**Response** (`RecordList` envelope). `pagination.total` is present only when `count=true`. An RFC 8288 `Link` header carries `rel="next"`/`rel="prev"` when more pages exist.

```json
{
  "data": [
    { "section_id": 1, "lang": "lg-eng", "code": "OH-001", "title": "Interview with María" }
  ],
  "pagination": { "limit": 100, "offset": 0, "total": 142 }
}
```

**Examples**

```bash
# Filter + sort + field selection + page size
curl "http://localhost:3100/publication/server_api/v2/dedalo_web/tables/interview/records?filter%5Bcode%5D%5Blike%5D=OH-%25&sort=-section_id&fields=section_id,code,title&limit=10"

# Range query with total count
curl "http://localhost:3100/publication/server_api/v2/dedalo_web/tables/interview/records?filter%5Bdate%5D%5Bgte%5D=1936&filter%5Bdate%5D%5Blte%5D=1939&count=true"

# Count only (no rows)
curl "http://localhost:3100/publication/server_api/v2/dedalo_web/tables/interview/records?limit=0&count=true"
```

---

## GET /{db}/tables/{table}/records/{id}

Returns a single record by `section_id`. The response `data` is **always an array**: one row per language variant (ordered by `lang`), or a single row when `lang` is given.

**Path params:** `db`, `table`, `id`.

**Query params** (validated by `getRecordQuerySchema` — note: no `limit`/`offset`/`sort`/`count`):

| Parameter | Type | Notes |
| --- | --- | --- |
| `fields` | string | Comma-separated column allowlist. |
| `lang` | string | `^lg-[a-z]{2,5}$`. Narrows to one variant; echoes a `Content-Language` response header. |
| `resolve_relations` | string (JSON) | See [querying.md](querying.md). |
| `resolve_inverse_relations` | string | See [querying.md](querying.md). |

**Response.** `meta.languages` (the available variants) appears only when the table has a `lang` column.

```json
{
  "data": [
    { "section_id": 1, "lang": "lg-eng", "code": "OH-001", "title": "Interview with María" },
    { "section_id": 1, "lang": "lg-spa", "code": "OH-001", "title": "Entrevista con María" }
  ],
  "meta": { "section_id": 1, "languages": ["lg-eng", "lg-spa"] }
}
```

A missing record returns `404` with an `application/problem+json` body.

**Examples**

```bash
# All language variants
curl "http://localhost:3100/publication/server_api/v2/dedalo_web/tables/interview/records/1"

# Single variant (sets Content-Language: lg-eng)
curl "http://localhost:3100/publication/server_api/v2/dedalo_web/tables/interview/records/1?lang=lg-eng"
```

---

## GET /{db}/tables/{table}/search

MariaDB FULLTEXT search (`MATCH … AGAINST` in boolean mode) over an indexed text column. Each result row is augmented with a numeric `relevance` score and a `fragments` array of highlighted excerpts.

**Path params:** `db`, `table`.

**Query params** (validated by `fulltextQuerySchema`):

| Parameter | Type | Default | Notes |
| --- | --- | --- | --- |
| `q` | string | — | **Required.** 1–512 chars. Supports `+word`, `-word`, `"phrase"`. |
| `column` | string | `transcription` | FULLTEXT-indexed column to search. |
| `lang` | string | — | `lg-xxx` format. One language variant only — without it a hit comes back once per language row and `pagination.total` counts rows. A `400` on a table without a `lang` column. |
| `limit` | integer | `100` | `min(0)`, `max(1000)`. |
| `offset` | integer | `0` | `min(0)`. |
| `count` | boolean | `false` | Adds `pagination.total`. |
| `resolve_relations` | string (JSON) | — | See [querying.md](querying.md). |
| `resolve_inverse_relations` | string | — | See [querying.md](querying.md). |

**Response** (`RecordList` envelope; each row carries `relevance` and `fragments`).

```json
{
  "data": [
    {
      "section_id": 7,
      "lang": "lg-spa",
      "title": "Entrevista con María",
      "relevance": 11.2,
      "fragments": [
        { "text": "...durante la <mark>guerra</mark> civil...", "position": 1204 }
      ]
    }
  ],
  "pagination": { "limit": 100, "offset": 0 }
}
```

**Example**

```bash
curl "http://localhost:3100/publication/server_api/v2/dedalo_web/tables/interview/search?q=guerra+civil&limit=20"
```

---

## GET /{db}/tables/{table}/records/{id}/fragments

Extracts highlighted text excerpts around each occurrence of the search terms in a large text column (books, theses, transcriptions). Each fragment includes a `page` number derived from `[page-n-X]` markers when present.

**Path params:** `db`, `table`, `id`.

**Query params** (validated by `fragmentsQuerySchema`):

| Parameter | Type | Default | Notes |
| --- | --- | --- | --- |
| `terms` | string | — | **Required.** 1–512 chars. Whitespace-separated, matched literally and case-insensitively. |
| `column` | string | `transcription` | Column containing the text. |
| `lang` | string | — | `^lg-[a-z]{2,5}$`. |
| `max_characters` | integer | `320` | Context size per fragment (`min(10)`, `max(5000)`). |
| `max_occurrences` | integer | `1` | Maximum fragments per term (`min(1)`, `max(10)`). |

**Response**

```json
{
  "data": [
    { "text": "...the <mark>war</mark> started when...", "page": 27, "position": 5340 }
  ],
  "meta": { "section_id": 4, "terms": "war" }
}
```

**Example**

```bash
curl "http://localhost:3100/publication/server_api/v2/dedalo_web/tables/publications/records/123/fragments?terms=economia&max_occurrences=3"
```

---

## GET /{db}/tables/{table}/records/{id}/av-fragments

Extracts transcription excerpts with their `[tc-in-out]` timecode ranges and media URLs, joining the audiovisual assets for video and image. Like text fragments, but with media and speakers and **no** `column` parameter (the transcription source is fixed).

**Path params:** `db`, `table`, `id`.

**Query params** (validated by `avFragmentsQuerySchema`):

| Parameter | Type | Default | Notes |
| --- | --- | --- | --- |
| `terms` | string | — | **Required.** 1–512 chars. Whitespace-separated, literal, case-insensitive. |
| `lang` | string | — | `^lg-[a-z]{2,5}$`. |
| `max_characters` | integer | `320` | Context size per fragment (`min(10)`, `max(5000)`). |
| `max_occurrences` | integer | `1` | Maximum fragments per term (`min(1)`, `max(10)`). |

**Response.** Media URLs encode the timecode window (e.g. `…/video.mp4?vbegin=120&vend=180`).

```json
{
  "data": [
    {
      "transcription": "...we crossed the <mark>border</mark> at night...",
      "media": {
        "video_url": "/dedalo/media/video.mp4?vbegin=120&vend=180",
        "image_url": "/dedalo/media/poster.jpg",
        "tc_in": 120,
        "tc_out": 180
      },
      "speakers": []
    }
  ],
  "meta": { "section_id": 4, "terms": "border" }
}
```

**Example**

```bash
curl "http://localhost:3100/publication/server_api/v2/dedalo_web/tables/interview/records/46/av-fragments?terms=guerra&max_characters=500"
```

---

## GET /{db}/av-indexation-fragment

Resolves a thesaurus indexation locator to an audiovisual fragment: the transcription slice between timecodes, media URLs, speakers and associated thesaurus terms.

**Path params:** `db`.

**Query params** (validated by `avIndexationParamsSchema`):

| Parameter | Type | Notes |
| --- | --- | --- |
| `section_id` | integer | **Required.** Positive integer. |
| `section_tipo` | string | Optional. |
| `component_tipo` | string | Optional. |
| `tag_id` | integer | Optional. |
| `tc_in` | number | Optional, `≥ 0`. |
| `tc_out` | number | Optional, `≥ 0`. |

**Response**

```json
{
  "data": {
    "locator": { "section_id": 1, "tag_id": 3, "tc_in": 120, "tc_out": 180 },
    "transcription": "We crossed the border at night...",
    "media": {
      "video_url": "/dedalo/media/video.mp4?vbegin=120&vend=180",
      "image_url": "/dedalo/media/posterframe/poster.jpg",
      "tc_in": 120,
      "tc_out": 180
    },
    "speakers": [ { "name": "María García", "role": "informant" } ],
    "terms": [ { "term_id": "ts1_23", "term": "Exile" } ]
  }
}
```

**Example**

```bash
curl "http://localhost:3100/publication/server_api/v2/dedalo_web/av-indexation-fragment?section_id=1&tag_id=1&tc_in=120&tc_out=180"
```

---

## POST /batch

Runs up to 20 GET data queries in one request, in parallel. Each query carries its own HTTP status; one failure never breaks the batch.

**Request.** Requires `Content-Type: application/json` (else `400`) and a body validated by `batchRequestSchema`:

| Field | Type | Notes |
| --- | --- | --- |
| `queries` | array | 1–20 items (`MAX_BATCH_QUERIES`). |
| `queries[].id` | string | Non-empty, **unique** within the batch; echoed in the result. |
| `queries[].path` | string | Must start with `/` and name a GET data route **without** query string. |
| `queries[].params` | object | Optional. Values are string/number/boolean or arrays thereof; arrays become repeated keys, enabling bracketed filters. |

!!! warning "Meta routes are not allowed in a batch"
    `path` cannot target `/docs`, `/health`, `/mcp`, `/openapi.yaml` or `/batch` itself — only GET data routes.

**Response.** Each result carries either `data` (the route's envelope) or a `problem` (RFC 9457 body), plus the per-query `status`.

```json
{
  "results": [
    {
      "id": "interviews",
      "status": 200,
      "data": {
        "data": [ { "section_id": 142, "code": "OH-142" } ],
        "pagination": { "limit": 5, "offset": 0 }
      }
    },
    {
      "id": "themes",
      "status": 404,
      "problem": {
        "type": "https://dedalo.dev/api/problems/not-found",
        "title": "Not Found",
        "status": 404,
        "detail": "Unknown table: ts_themes"
      }
    }
  ]
}
```

**Example**

```bash
curl -X POST http://localhost:3100/publication/server_api/v2/batch \
  -H "Content-Type: application/json" \
  -d '{
    "queries": [
      { "id": "interviews", "path": "/dedalo_web/tables/interview/records",
        "params": { "filter[code][like]": "OH-%", "sort": "-section_id", "limit": 5 } },
      { "id": "tables", "path": "/dedalo_web/tables" }
    ]
  }'
```

---

## GET /health

Pings every configured database. Returns `200` when all are connected, `503` if any errors. **Never cached.**

**Response** (`200`)

```json
{
  "status": "ok",
  "databases": { "dedalo_web": "connected" },
  "uptime": 3600.5,
  "timestamp": "2026-06-10T12:00:00.000Z",
  "version": "2.1.0"
}
```

When a database is unreachable, its entry reads `"error"`, `status` becomes `"error"`, and the HTTP status is `503`.

**Example**

```bash
curl -i http://localhost:3100/publication/server_api/v2/health
```

---

## GET /docs

Interactive API documentation, served offline (no CDN dependencies). The landing page links to both renderers:

- `GET /docs/swagger` — Swagger UI.
- `GET /docs/scalar` — Scalar.

Their static assets are served under `/docs/swagger/…` and `/docs/scalar/…`.

**Example**

```bash
# Open in a browser
open http://localhost:3100/publication/server_api/v2/docs
```

---

## GET /openapi.yaml

Returns the OpenAPI 3.1 specification (spec version `2.1.0`) that powers `/docs`.

**Example**

```bash
curl http://localhost:3100/publication/server_api/v2/openapi.yaml
```

---

## POST /mcp

Model Context Protocol endpoint for AI agents, served at `MCP_PATH` (default `/mcp`) when `MCP_ENABLED` is set (enabled by default). It exposes the same data through structured MCP tools (e.g. `search_records`, `get_record`, `fulltext_search`).

!!! note "Streamable HTTP transport"
    The endpoint speaks the MCP Streamable HTTP transport; use an MCP client rather than plain `curl`. See [mcp.md](mcp.md) for the full tool catalogue and connection details.

---

## GET /favicon.ico

Returns `204 No Content`. Present so browsers hitting the API host directly do not produce spurious `404`s.

---

## Related

- [Publication API v2 — version landing](../index.md) — what the v2 API is and how it differs from v1.
- [Querying records](querying.md) — the filter DSL, sorting, field selection, pagination, `lang` and relation resolution in depth.
- [HTTP semantics](http_semantics.md) — envelopes, RFC 9457 errors, caching/`ETag`, `Link` pagination headers and response timing.
- [Search & fragments](search_and_fragments.md) — `search`, text/AV fragments and the indexation locator endpoint, in detail.
- [Batch queries](batch.md) — the `/batch` request/response contract and limits.
- [MCP server](mcp.md) — the `/mcp` endpoint and its tool catalogue.
- [Security](security.md) — read-only model, SQL-injection defense, rate limiting, API key, CORS and DoS bounds.
