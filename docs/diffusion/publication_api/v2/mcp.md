# MCP Server

A Model Context Protocol (MCP) endpoint that exposes the read-only Publication API v2 to AI agents as a set of typed tools.

## Overview

The Publication API v2 ships an embedded [Model Context Protocol](https://modelcontextprotocol.io/) server. It lets an MCP-capable agent (Claude Desktop, a custom MCP client, an IDE assistant, etc.) discover and query the published Dédalo databases through structured tool calls instead of hand-built URLs.

The server wraps the same services that back the REST routes, so the data, the security model and the DoS bounds described in [endpoints.md](endpoints.md) and [http_semantics.md](http_semantics.md) all still apply — and since the 2026-08-26 audit that is enforced rather than assumed: the tools parse the **same** bound schemas the REST routes do, on every call, before a query is built. It is **read-only**: there is no tool that writes, updates or deletes.

!!! info "Tool results are JSON text"
    Every tool returns a single MCP `text` content block whose body is a pretty-printed JSON string. The payload is the *service envelope* (`{ data, ... }`), not the full REST envelope — there is no `pagination` block and no `meta.response_time_ms` inside a tool result. On error the block is the plain string `Error: <message>` rather than an RFC 9457 Problem Details body.

    Source: `src/mcp/tools.ts` (`textContent` / `errorContent`).

## Enabling and reaching the endpoint

| Env var | Default | Meaning |
|---------|---------|---------|
| `MCP_ENABLED` | `true` | Master switch. When `false`, the path falls through to the normal router and `404`s. |
| `MCP_PATH` | `/mcp` | Path (relative to `BASE_PATH`) where the MCP transport is mounted. |

The endpoint is `POST {BASE_PATH}{MCP_PATH}` — with the defaults, `POST /publication/server_api/v2/mcp`. The router dispatches it *before* the static and `/:db/...` routes, so it can never be shadowed by a database named `mcp`.

!!! note "Caching and timeouts are bypassed"
    The MCP path is excluded from the HTTP cache layer and is exempt from the request-level timeout middleware (`REQUEST_TIMEOUT_MS`). Per-query database timeouts still apply inside each tool.

    Sources: `src/router.ts`, `src/config.ts`, `src/middleware/http-cache.ts`, `src/middleware/timeout.ts`.

The transport is an HTTP streamable transport, served **statelessly**: every request gets its own
server instance and no session id is issued. All tools are independent reads against the published
database, so there is no session state to keep — concurrent clients never share a transport. Point
your MCP client's HTTP transport at the URL above.

## Conventions shared by all tools

- **`db` is optional everywhere.** When omitted it defaults to the **first** entry of `DB_NAMES` (`dbNames[0]`). Any value passed is checked against the `DB_NAMES` allowlist (`assertKnownDb`); an unknown database raises an error. Use [`list_databases`](#list_databases) to discover valid names.
- **Filters are structured, not strings.** Unlike the REST `filter[field][op]=value` query syntax, the MCP tools take `filters` as an **array of objects** `[{ field, op?, value? }]`:
    - `field` — column name (required).
    - `op` — operator (optional, defaults to `eq`). Valid: `eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `like`, `in`, `not_in`, `is_null`, `is_not_null`.
    - `value` — comparison value (optional). For `in` / `not_in` pass **pipe-separated** values, e.g. `"1|2|3"`. Omit `value` entirely for `is_null` / `is_not_null`. Any other operator requires a value or the call errors.
    - Conditions are combined with **AND**.
- **`fields`, `sort`, `resolve_relations`, `resolve_inverse_relations`** keep the same string forms as the REST query model: comma-separated field lists, `-`-prefixed descending sort keys, and JSON-string relation maps (or `"auto"` / `"true"`). See [querying.md](querying.md) for the full semantics.
- **`limit` / `offset`** are numbers (limit defaults to `100`, max `1000`; offset defaults to `0`). **Over the cap is an error result, not a clamp** — the tool answers `Error: Invalid arguments for <tool> — limit: …` and nothing is queried. The bounds are the same objects the REST routes parse (`src/validators.ts`), so the two doors cannot drift; the advertised JSON Schema carries the maxima, and the same holds for `section_id` (positive integer), `max_characters` (10–5000), `max_occurrences` (1–10) and the 512-character cap on `q`/`terms`.
- **A tool call is bounded as a whole, too.** Relation resolution is capped at 10 resolve-map keys, depth 3 and 50 related rows per cell, and one request may issue at most 500 database statements (`MAX_QUERIES_PER_REQUEST`) — past that the call fails rather than saturating the published database's connection pool.
- **`lang`** uses the `lg-xxx` form (e.g. `lg-eng`, `lg-spa`).

Source: `src/mcp/tools.ts` (`dbParam`, `filtersParam`, `resolveDb`, `toConditions`).

## Tools

There are nine tools.

### `list_databases`

List the public databases exposed by this API.

| Argument | Type | Required | Notes |
|----------|------|----------|-------|
| *(none)* | | | Takes no arguments. |

Returns `{ databases: [...] }` (the configured `DB_NAMES`).

### `get_schema`

Introspect a database schema: tables, their columns and types, and row counts. Use it before querying to learn the data structure.

| Argument | Type | Required | Notes |
|----------|------|----------|-------|
| `db` | string | no | Defaults to the first configured database. |
| `table` | string | no | Inspect one table. Omit to list all tables. |

With `table` it returns that table's schema (`{ name, row_count, columns:[{ name, type }] }`); without it, the table list (`[{ name, row_count, column_count }]`).

### `search_records`

Search and query records from any published table — the workhorse tool. Supports structured filters, pagination, sorting, field selection and relation resolution.

| Argument | Type | Required | Notes |
|----------|------|----------|-------|
| `db` | string | no | Defaults to the first configured database. |
| `table` | string | **yes** | Target table (e.g. `interview`, `ts_themes`, `publications`). |
| `fields` | string | no | Comma-separated columns to return. |
| `filters` | array | no | `[{ field, op?, value? }]`, combined with AND. |
| `sort` | string | no | Comma-separated; prefix `-` for descending (`"title,-section_id"`). |
| `limit` | number | no | Default `100`, max `1000` (a larger value is refused, not clamped). |
| `offset` | number | no | Default `0`. |
| `lang` | string | no | `lg-xxx`; rejected on tables without a `lang` column. |
| `count` | boolean | no | When `true`, also return the total match count. |
| `resolve_relations` | string | no | JSON map of column → target table (`{"image":"image"}`); dot notation for deep resolution; `"auto"` for link columns. |
| `resolve_inverse_relations` | string | no | `"true"` to auto-load the `dd_relations` mapping from `publication_schema`, or a JSON object like `{"rsc170":"interview"}`. |

Returns `{ data: [...], total? }` (`total` only when `count: true`).

### `get_record`

Get a single record by `section_id`. Records may have one row per language; without `lang` all language variants are returned.

| Argument | Type | Required | Notes |
|----------|------|----------|-------|
| `db` | string | no | Defaults to the first configured database. |
| `table` | string | **yes** | Target table. |
| `section_id` | number | **yes** | The record id. |
| `lang` | string | no | Return a single language variant (e.g. `lg-eng`). |
| `fields` | string | no | Comma-separated columns to return. |
| `resolve_relations` | string | no | Forward relation map (same form as above). |
| `resolve_inverse_relations` | string | no | `"true"` or a JSON mapping. |

Returns `{ data: [variants…], languages? }`. `languages` (the available variants) is present only when the table has a `lang` column.

### `count_records`

Count matching records without fetching them. Counts by structured filters, or by fulltext when `q` is given.

| Argument | Type | Required | Notes |
|----------|------|----------|-------|
| `db` | string | no | Defaults to the first configured database. |
| `table` | string | **yes** | Target table. |
| `filters` | array | no | `[{ field, op?, value? }]`. Ignored when `q` is set. |
| `lang` | string | no | Language filter. |
| `q` | string | no | Fulltext query; counts fulltext matches instead of filters. |
| `column` | string | no | Column for the fulltext count (default `transcription`). |

Returns `{ total }`.

### `fulltext_search`

MariaDB `FULLTEXT` search (`MATCH … AGAINST` in boolean mode). Returns rows with a `relevance` score and highlighted `fragments`.

| Argument | Type | Required | Notes |
|----------|------|----------|-------|
| `db` | string | no | Defaults to the first configured database. |
| `table` | string | **yes** | Target table. |
| `q` | string | **yes** | Query; supports boolean operators (`+word`, `-word`, `"phrase"`). |
| `column` | string | no | Column to search (default `transcription`). |
| `lang` | string | no | One language variant; without it a hit is returned once per language. |
| `limit` | number | no | Default `100`, max `1000` (a larger value is refused, not clamped). |
| `offset` | number | no | Default `0`. |
| `count` | boolean | no | When `true`, also return the total match count. |
| `resolve_relations` | string | no | Forward relation map. |
| `resolve_inverse_relations` | string | no | `"true"` or a JSON mapping. |

Returns `{ data: [...], total? }`; each row carries a numeric `relevance` and a `fragments` array of `{ text, position }` excerpts (matches wrapped in `<mark>…</mark>`).

### `get_text_fragment`

Extract highlighted excerpts from a large publication text column (books, theses, etc.) with page references.

| Argument | Type | Required | Notes |
|----------|------|----------|-------|
| `db` | string | no | Defaults to the first configured database. |
| `table` | string | **yes** | Table holding the text (e.g. `publications`). |
| `section_id` | number | **yes** | Record id. |
| `terms` | string | **yes** | Whitespace-separated literal terms to find. |
| `column` | string | no | Text column (default `transcription`). |
| `lang` | string | no | Language variant to read. |
| `max_characters` | number | no | Characters per fragment (default `320`). |
| `max_occurrences` | number | no | Fragments per term (default `1`). |

Returns `{ data: [{ text, page?, position }] }`. `page` is derived from `[page-n-X]` markers when present.

### `get_av_fragment`

Extract audiovisual interview excerpts with video timecodes, media URLs and speaker placeholders.

| Argument | Type | Required | Notes |
|----------|------|----------|-------|
| `db` | string | no | Defaults to the first configured database. |
| `table` | string | no | Default `interview`. |
| `section_id` | number | **yes** | The interview's record id. |
| `terms` | string | **yes** | Whitespace-separated terms within the transcription. |
| `lang` | string | no | Language variant to read. |
| `max_characters` | number | no | Characters per fragment (default `320`). |
| `max_occurrences` | number | no | Fragments per term (default `1`). |

Returns `{ data: [{ transcription, media:{ video_url, image_url, tc_in, tc_out }, speakers:[] }] }`. The media URLs encode the timecode window, e.g. `…/video.mp4?vbegin=120&vend=180`. This tool takes **no** `column` argument.

### `get_av_indexation_fragment`

Resolve a thesaurus indexation locator to a single audiovisual fragment: a video clip with timecodes, its transcription and the associated thesaurus terms.

| Argument | Type | Required | Notes |
|----------|------|----------|-------|
| `db` | string | no | Defaults to the first configured database. |
| `section_id` | number | **yes** | Record id. |
| `section_tipo` | string | no | Section type identifier. |
| `component_tipo` | string | no | Component type identifier. |
| `tag_id` | number | no | Tag id from the indexation. |
| `tc_in` | number | no | Timecode in (seconds). |
| `tc_out` | number | no | Timecode out (seconds). |

Returns `{ data: { locator:{ section_id, section_tipo, component_tipo, tag_id, tc_in, tc_out }, transcription, media:{ video_url, image_url, tc_in, tc_out }, speakers:[{ name, role }], terms:[{ term_id, term }] } }`.

## Client usage example

The MCP endpoint speaks the streamable-HTTP transport. With the official TypeScript SDK:

```typescript
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const transport = new StreamableHTTPClientTransport(
  new URL('http://localhost:3100/publication/server_api/v2/mcp')
);
const client = new Client({ name: 'my-agent', version: '1.0.0' });
await client.connect(transport);

// Discover what is available
const dbs = await client.listTools();           // → the nine tools
await client.callTool({ name: 'list_databases', arguments: {} });

// Structured filters: an ARRAY of {field, op, value}, never a string
const result = await client.callTool({
  name: 'search_records',
  arguments: {
    db: 'dedalo_web',                            // optional; omit to use the first DB
    table: 'interview',
    filters: [
      { field: 'code', op: 'like', value: 'OH-%' },
      { field: 'date', op: 'gte', value: '1936' },
    ],
    sort: '-section_id',
    fields: 'section_id,code,title',
    limit: 10,
    count: true,
  },
});

// Tool output is a JSON string inside a text content block
const payload = JSON.parse(result.content[0].text);
console.log(payload.total, payload.data.length);
```

The arguments object passed to `callTool` is exactly the JSON-RPC `tools/call` payload, so any MCP client can issue the same request. A raw `tools/call` body for `search_records` looks like:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "search_records",
    "arguments": {
      "table": "interview",
      "filters": [
        { "field": "code", "op": "like", "value": "OH-%" }
      ],
      "limit": 5
    }
  }
}
```

!!! warning "REST string filters do not work here"
    The MCP `filters` argument is a structured array. The bracketed REST form `filter[code][like]=OH-%` is **not** accepted by the tools. Saved prompts that used a string-based filter DSL must be rewritten as `[{ field: "code", op: "like", value: "OH-%" }]`.

## Related

- [Publication API v2 — overview](../index.md)
- [Endpoints reference](endpoints.md) — the REST routes the tools wrap
- [Query model](querying.md) — filters, sort, fields, pagination, relation resolution
- [HTTP semantics](http_semantics.md) — errors, caching, rate limiting, auth
