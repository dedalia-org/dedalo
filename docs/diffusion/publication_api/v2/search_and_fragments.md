# Search & fragments

Find records by relevance and pull highlighted excerpts — fulltext search, paginated text fragments with page references, and audiovisual fragments with video timecodes and media URLs.

The API exposes four read-only extraction endpoints, all under the `Search` tag in the OpenAPI spec:

| Endpoint | Purpose |
|----------|---------|
| `GET /{db}/tables/{table}/search?q=` | MariaDB FULLTEXT search with a `relevance` score and highlighted `fragments` |
| `GET /{db}/tables/{table}/records/{id}/fragments` | Highlighted text excerpts from a large text column, with page references |
| `GET /{db}/tables/{table}/records/{id}/av-fragments` | Transcription excerpts with `[tc-in-out]` timecodes and media URLs |
| `GET /{db}/av-indexation-fragment` | Resolve a thesaurus indexation locator to an audiovisual fragment |

All examples below assume the default `BASE_PATH` (`/publication/server_api/v2`) and a database named `dedalo_web`. Every value is bound as a query parameter; identifiers (table, column) are validated against `^[A-Za-z_][A-Za-z0-9_]*$` before use.

!!! info "Bounded by design"
    Fragment extraction is capped to defend against DoS: at most **10 terms** per request, **64 characters** per term, and the first **1 MB** of text is scanned (`MAX_FRAGMENT_TERMS`, `MAX_TERM_LENGTH`, `MAX_SCAN_LENGTH`). Extra terms beyond the tenth are ignored; an oversized term raises a `400`.

---

## Fulltext search

`GET /{db}/tables/{table}/search`

Runs `MATCH(column) AGAINST(? IN BOOLEAN MODE)` over a **FULLTEXT-indexed** column, orders rows by descending relevance, and augments each row with a numeric `relevance` score and a `fragments` array of highlighted excerpts.

### Parameters

Validated by `fulltextQuerySchema`.

| Parameter | Type | Default | Notes |
|-----------|------|---------|-------|
| `q` | string | — | **Required.** 1–512 chars. Boolean mode: `+word` (required), `-word` (excluded), `"phrase"`. |
| `column` | string | `transcription` | Must name a FULLTEXT-indexed text column. |
| `lang` | string | — | `lg-xxx` format. One language variant only — without it a hit comes back once per language row and `pagination.total` counts rows. A `400` on a table without a `lang` column. |
| `limit` | integer | `100` | `0`–`1000`. `0` skips the data query (count-only). |
| `offset` | integer | `0` | `≥ 0`. |
| `count` | boolean | `false` | `true`/`1` add `pagination.total` (extra `COUNT` query). |
| `resolve_relations` | string (JSON) | — | Forward relation resolution; see [Querying](querying.md). |
| `resolve_inverse_relations` | string (JSON or `true`) | — | Resolve the `dd_relations` column. |

!!! note "Highlighting on search rows is not configurable"
    The per-row `fragments` are extracted with a fixed window of **320 characters** and up to **3 occurrences** per term. Use the [text fragments](#text-fragments) endpoint when you need to tune `max_characters` / `max_occurrences`.

### Example

```bash
curl "http://localhost:3100/publication/server_api/v2/dedalo_web/tables/interview/search?q=%2Bguerra+civil&limit=20&count=true"
```

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
  "pagination": { "limit": 20, "offset": 0, "total": 142 },
  "meta": { "response_time_ms": 6.13 }
}
```

The envelope is the shared `RecordList` shape: `data` rows plus `pagination`. `pagination.total` is present only with `count=true`, and an RFC 8288 `Link` header carries `rel="next"` / `rel="prev"` when more pages exist (see [HTTP semantics](http_semantics.md)).

!!! warning "Column must have a FULLTEXT index"
    Searching a column with no FULLTEXT index returns a `400` Validation Error (`Column "…" has no FULLTEXT index; fulltext search is not available on it`), translated from MariaDB error 1191. A column that does not exist on the table also yields a `400`.

---

## Text fragments

`GET /{db}/tables/{table}/records/{id}/fragments`

Extracts highlighted excerpts around each occurrence of the search `terms` in a single text column of one record — ideal for long publication texts (books, theses, transcriptions). When the text carries `[page-n-X]` markers, each fragment reports the page it falls on.

### Parameters

Validated by `fragmentsQuerySchema`.

| Parameter | Type | Default | Notes |
|-----------|------|---------|-------|
| `terms` | string | — | **Required.** 1–512 chars. Whitespace-separated, matched **literally** and **case-insensitively** (not boolean operators). |
| `column` | string | `transcription` | Column holding the text. |
| `lang` | string | — | `lg-xxx` format. Selects one language variant; ignored if the table has no `lang` column. |
| `max_characters` | integer | `320` | `10`–`5000`. Context window per fragment. |
| `max_occurrences` | integer | `1` | `1`–`10`. Maximum fragments per term. |

### Example

```bash
curl "http://localhost:3100/publication/server_api/v2/dedalo_web/tables/publications/records/123/fragments?terms=economia&max_occurrences=3&max_characters=400"
```

```json
{
  "data": [
    { "text": "...the <mark>war</mark> started when...", "page": 27, "position": 5340 }
  ],
  "meta": { "section_id": 123, "terms": "economia" }
}
```

Each item is `{ text, page?, position }`: `text` wraps matched terms in `<mark>…</mark>` and prefixes/suffixes `...` when truncated; `position` is the character offset of the match in the source text; `page` is the number from the last `[page-n-X]` marker before that position, and is omitted when no marker precedes it. `meta.terms` echoes the request.

---

## Audiovisual fragments

`GET /{db}/tables/{table}/records/{id}/av-fragments`

Like text fragments, but tuned for audiovisual interviews: it `LEFT JOIN`s the `audiovisual` table for media assets, reads the transcription (falling back to the `rsc36` column when `transcription` is empty), and resolves each excerpt's `[tc-in-out]` timecode range into playable media URLs.

### Parameters

Validated by `avFragmentsQuerySchema`. **There is no `column` parameter** — the transcription column is fixed.

| Parameter | Type | Default | Notes |
|-----------|------|---------|-------|
| `terms` | string | — | **Required.** 1–512 chars. Whitespace-separated, literal, case-insensitive. |
| `lang` | string | — | `lg-xxx` format; selects one language variant when the table has a `lang` column. |
| `max_characters` | integer | `320` | `10`–`5000`. |
| `max_occurrences` | integer | `1` | `1`–`10`. |

### Example

```bash
curl "http://localhost:3100/publication/server_api/v2/dedalo_web/tables/interview/records/46/av-fragments?terms=guerra&max_characters=500"
```

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
  "meta": { "section_id": 46, "terms": "guerra" }
}
```

Each item is `{ transcription, media, speakers }`:

- `transcription` — the highlighted excerpt (`<mark>` around terms).
- `media.tc_in` / `media.tc_out` — the timecodes (seconds) of the `[tc-in-out]` marker covering the match; both are `0` when no marker precedes it.
- `media.video_url` — `MEDIA_BASE_URL/{video}?vbegin={tc_in}&vend={tc_out}`, so the URL itself addresses the clip window. Empty string when the record has no video.
- `media.image_url` — `MEDIA_BASE_URL/{image}`, or empty string when absent.
- `speakers` — always an empty array on this endpoint; use [`/av-indexation-fragment`](#av-indexation-fragment) for speaker data.

!!! note "Media base URL"
    The `MEDIA_BASE_URL` prefix is server-configured. Relative paths like `/dedalo/media/...` above reflect a typical deployment; your URLs depend on `.env`.

---

## AV indexation fragment

`GET /{db}/av-indexation-fragment`

Resolves a **thesaurus indexation locator** — a pointer left by an indexer on a moment of an interview — into the corresponding audiovisual fragment: a transcription slice bounded by the timecodes, media URLs, the informant as a speaker, and the thesaurus terms attached to that tag.

This route is **not** scoped by `tables/{table}`; it always reads the `interview` table (joining `audiovisual` and `informant`). It lives directly under `/{db}`.

### Parameters

Validated by `avIndexationParamsSchema`. All are query parameters.

| Parameter | Type | Default | Notes |
|-----------|------|---------|-------|
| `section_id` | integer | — | **Required.** Positive. The interview record. |
| `section_tipo` | string | — | Optional. Echoed back in `data.locator`. |
| `component_tipo` | string | — | Optional. Required (together with `tag_id`) to resolve `terms`. |
| `tag_id` | integer | — | Optional. Required (together with `component_tipo`) to resolve `terms`. |
| `tc_in` | number | `0` | Optional, `≥ 0`. Start timecode (seconds). |
| `tc_out` | number | `0` | Optional, `≥ 0`. End timecode (seconds). |

### Example

```bash
curl "http://localhost:3100/publication/server_api/v2/dedalo_web/av-indexation-fragment?section_id=1&component_tipo=rsc36&tag_id=3&tc_in=120&tc_out=180"
```

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
    "speakers": [
      { "name": "María García", "role": "informant" }
    ],
    "terms": [
      { "term_id": "ts1_23", "term": "Exile" }
    ]
  }
}
```

Notes on the response:

- The envelope is a single object under `data` (not an array): `{ locator, transcription, media, speakers, terms }`.
- `transcription` is the slice of the interview transcription between the `[tc-…]` markers spanning `tc_in`/`tc_out`, with all `[tc-…]` and `[page-n-…]` markers stripped and whitespace collapsed.
- `media.image_url` uses the **`posterframe/`** path prefix (`MEDIA_BASE_URL/posterframe/{image}`) — distinct from the `av-fragments` endpoint, which serves the image directly.
- `speakers` carries the joined informant as `{ name, role: "informant" }`; the array is empty when no informant name is present.
- `terms` lists the thesaurus terms (`{ term_id, term }`, up to 10) attached to the locator. It is **only populated when both `component_tipo` and `tag_id` are supplied**; otherwise it is an empty array. Terms are looked up across `ts_themes`, `ts_onomastic` and `ts_chronological`, and any lookup error degrades gracefully to `[]`.

!!! warning "404 when the section is missing"
    A `section_id` with no matching `interview` row returns `404` `Record not found for section_id: …` as an `application/problem+json` body.

---

## Errors, caching & limits

These endpoints follow the same conventions as the rest of the API (see [HTTP semantics](http_semantics.md)):

- **Validation** (`400`) — missing/oversized `q` or `terms`, unknown `column`, a column without a FULLTEXT index, malformed `lang`, out-of-range `max_characters` / `max_occurrences`, or AV fragments / AV indexation on a database whose AV tables are missing or lack the `AV_*` columns (a non-AV publication). The body is RFC 9457 Problem Details, with an `errors:[{ pointer, message }]` array.
- **Not found** (`404`) — unknown db/table, or a record/section that does not exist.
- **Caching** — successful responses carry `Cache-Control: public, max-age=N` and a weak `ETag`; `If-None-Match` yields `304`. `meta.response_time_ms` (mirrored as the `X-Response-Time` header) is excluded from the ETag.
- **Pagination** — only the `search` endpoint paginates (`limit`/`offset`/`count` + `Link` header); the per-record fragment endpoints return all extracted fragments inline.

---

## Related

- [Endpoints overview](endpoints.md) — the full route map.
- [Querying records](querying.md) — filters, sort, field selection, pagination and relation resolution shared with `search`.
- [HTTP semantics](http_semantics.md) — error format, caching/ETag, `Link` headers, rate limiting and timeouts.
- [Publication API v2](../index.md) — version landing page.
