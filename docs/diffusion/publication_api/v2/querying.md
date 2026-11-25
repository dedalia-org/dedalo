# Querying records (v2)

How to filter, sort, paginate, narrow by language and resolve relations on the v2 record-listing and search endpoints.

The record-listing endpoint `GET /{db}/tables/{table}/records` is the main query model of the API. It accepts a small set of query-string parameters that map directly to a parameterised, read-only SQL query. The same filtering, pagination and resolution parameters are reused (with some restrictions) by the fulltext search endpoint and the single-record endpoint.

!!! info "Read-only and parameter-bound"
    Every value you send is bound as a `?` placeholder; identifiers (field names, sort fields, table and column names) are re-validated against `^[A-Za-z_][A-Za-z0-9_]*$` and back-tick quoted before they touch SQL. There is no write path. See [HTTP semantics](http_semantics.md) for the security and caching contract.

## Parameter overview

| Parameter | Type | Default | Applies to | Notes |
| --- | --- | --- | --- | --- |
| `filter[field][op]` | string | — | list, (`filter` not on search) | Bracketed filter; `op` defaults to `eq`. Repeat to `AND`. |
| `sort` | string | — | list | Comma-separated; leading `-` = descending. |
| `fields` | string | all columns | list, single | Comma-separated column allowlist. |
| `limit` | integer | `100` | list, search | `0`–`1000`. `0` = count-only. |
| `offset` | integer | `0` | list, search | Rows to skip. |
| `count` | boolean | `false` | list, search | Adds `pagination.total` via an extra `COUNT(*)`. |
| `lang` | string | — | list, single, search, fragments | `lg-xxx` format. Rejected on tables without a `lang` column. |
| `resolve_relations` | JSON string | — | list, single, search | Forward relation resolution. |
| `resolve_inverse_relations` | `true` \| JSON string | — | list, single, search | Resolves the `dd_relations` column. |

The single-record endpoint (`GET /{db}/tables/{table}/records/{id}`) accepts only `fields`, `lang`, `resolve_relations` and `resolve_inverse_relations` — no `filter`, `sort`, `limit`, `offset` or `count`. The fulltext search endpoint (`GET /{db}/tables/{table}/search`) accepts `q`, `column`, `lang`, `limit`, `offset`, `count`, `resolve_relations` and `resolve_inverse_relations` (it has no `filter`/`sort`). For the full endpoint catalogue see [endpoints](endpoints.md).

!!! note "URL-encode the brackets"
    Filter parameter names contain `[` and `]`. In a real request these must be percent-encoded: `[` → `%5B`, `]` → `%5D`. The examples below show both the readable form (in prose) and the encoded form (in the `curl` lines).

## Filters

Filters use bracketed query parameters:

```text
filter[field][operator]=value
```

The operator is optional; when omitted it defaults to `eq`:

```text
filter[field]=value            # same as filter[field][eq]=value
```

Filter keys are matched against `^filter\[([^\]]+)\](?:\[([^\]]+)\])?$`; a key that does not match (for example `filter[a][b][c]` or `filter[]`) raises a `400` validation error. The field name is validated against the identifier regex. **Repeated filter parameters are combined with `AND`** — there is no `OR`.

### Operator table

`VALID_OPERATORS` (source: `src/utils/query-params.ts`):

| Operator | SQL | Value |
| --- | --- | --- |
| `eq` | `field = ?` | single |
| `ne` | `field != ?` | single |
| `gt` | `field > ?` | single |
| `gte` | `field >= ?` | single |
| `lt` | `field < ?` | single |
| `lte` | `field <= ?` | single |
| `like` | `field LIKE ?` | single (you supply the `%` wildcards) |
| `in` | `field IN (?, …)` | pipe-separated (`a\|b\|c`) |
| `not_in` | `field NOT IN (?, …)` | pipe-separated (`a\|b\|c`) |
| `is_null` | `field IS NULL` | none |
| `is_not_null` | `field IS NOT NULL` | none |

Rules:

- `is_null` / `is_not_null` take **no** value (`filter[parent][is_null]=` — the empty value is ignored).
- `in` / `not_in` take **pipe-separated** values; each is trimmed and empties are dropped, and at least one non-empty value is required (`filter[section_id][in]=1|2|3`).
- An unknown operator (e.g. `lke`) returns a `400` listing the valid operators.
- `gt` / `gte` / `lt` / `lte` compare a **plain number** (`-150`, `2.5`) as a number, even on a text column — publication columns often hold numbers as text, and as text `'-150' >= '-100'` would be true. Any other value (an ISO date such as `1936-05-01`, a code) compares as text. `eq`, `ne`, `in` and `not_in` always compare as text.

### Examples

```bash
# Equality (operator omitted): WHERE `code` = 'OH-001'
curl "http://localhost:3100/publication/server_api/v2/dedalo_web/tables/interview/records?filter%5Bcode%5D=OH-001"

# LIKE with wildcards: WHERE `code` LIKE 'OH-%'
curl "http://localhost:3100/publication/server_api/v2/dedalo_web/tables/interview/records?filter%5Bcode%5D%5Blike%5D=OH-%25"

# IN list: WHERE `section_id` IN (1,2,3)
curl "http://localhost:3100/publication/server_api/v2/dedalo_web/tables/interview/records?filter%5Bsection_id%5D%5Bin%5D=1%7C2%7C3"

# Range (two filters ANDed): WHERE `date` >= 1936 AND `date` <= 1939
curl "http://localhost:3100/publication/server_api/v2/dedalo_web/tables/interview/records?filter%5Bdate%5D%5Bgte%5D=1936&filter%5Bdate%5D%5Blte%5D=1939"

# NULL test (no value): WHERE `parent` IS NULL
curl "http://localhost:3100/publication/server_api/v2/dedalo_web/tables/interview/records?filter%5Bparent%5D%5Bis_null%5D="
```

The readable (unencoded) forms of the above are
`filter[code]=OH-001`, `filter[code][like]=OH-%`, `filter[section_id][in]=1|2|3`,
`filter[date][gte]=1936&filter[date][lte]=1939` and `filter[parent][is_null]=`.

## Sorting

`sort` is a comma-separated list of fields. A leading `-` means descending; otherwise ascending. Each field is re-validated against the identifier regex.

```text
sort=title,-section_id   →   ORDER BY `title` ASC, `section_id` DESC
```

```bash
# Newest section_id first
curl "http://localhost:3100/publication/server_api/v2/dedalo_web/tables/interview/records?sort=-section_id"

# Title ascending, then section_id descending
curl "http://localhost:3100/publication/server_api/v2/dedalo_web/tables/interview/records?sort=title,-section_id"
```

## Field selection

`fields` is a comma-separated allowlist of columns to return (each is trimmed and identifier-validated, then back-tick quoted). When omitted, all columns are returned.

```bash
curl "http://localhost:3100/publication/server_api/v2/dedalo_web/tables/interview/records?fields=section_id,code,title"
```

!!! tip "`lang` stays in the projection"
    On a multilingual table the `lang` column is always included in the result even if you do not list it in `fields`, so callers can tell the language variants apart.

## Pagination

- `limit` — page size, `z.coerce.number().int().min(0).max(1000)`, default `100`. The maximum page size is **1000**.
- `offset` — rows to skip, `min(0)`, default `0`.

```bash
# Second page of 50
curl "http://localhost:3100/publication/server_api/v2/dedalo_web/tables/interview/records?limit=50&offset=50"
```

When more pages exist, an RFC 8288 `Link` header carries `rel="next"` / `rel="prev"`:

```text
Link: </publication/server_api/v2/dedalo_web/tables/interview/records?offset=100&limit=100>; rel="next"
```

The response envelope always reports the applied window:

```json
{
  "data": [
    { "section_id": 142, "lang": "lg-eng", "code": "OH-142", "title": "…" }
  ],
  "pagination": { "limit": 50, "offset": 50 }
}
```

## Counting

`count=true` adds `pagination.total` by running an extra `COUNT(*)` with the same `WHERE` clause. The flag accepts `true` / `1` (truthy); `false`, `0` and an empty value are false.

```bash
# Records plus the matching total
curl "http://localhost:3100/publication/server_api/v2/dedalo_web/tables/interview/records?filter%5Bdate%5D%5Bgte%5D=1936&count=true"
```

```json
{
  "data": [ … ],
  "pagination": { "limit": 100, "offset": 0, "total": 142 }
}
```

For a **count-only** request, combine `limit=0` with `count=true`: the data query is skipped entirely and only the count runs.

```bash
curl "http://localhost:3100/publication/server_api/v2/dedalo_web/tables/interview/records?limit=0&count=true"
```

```json
{
  "data": [],
  "pagination": { "limit": 0, "offset": 0, "total": 142 }
}
```

!!! warning
    `pagination.total` is present **only** when `count=true`. Without it the field is absent — never assume `total` exists.

## Language narrowing

`lang` is validated against `^lg-[a-z]{2,5}$` (e.g. `lg-eng`, `lg-spa`). On the listing endpoint it adds an equality filter (`WHERE \`lang\` = ?`) so you get one variant per record. Tables that have no `lang` column (for example thesaurus tables) **reject** the parameter with a `400`.

```bash
# Only the English variant of each record
curl "http://localhost:3100/publication/server_api/v2/dedalo_web/tables/interview/records?lang=lg-eng"
```

On the single-record endpoint `lang` narrows the returned array to one variant and the response carries a `Content-Language` header echoing the value. Without `lang`, all language variants are returned (one row per language, ordered by `lang`), and `meta.languages` lists the available variants when the table has a `lang` column.

## Forward relation resolution

`resolve_relations` is a **JSON string** mapping a column to the table whose rows it points to. The column holds a JSON array of `section_id`s (or objects carrying `section_id`); resolution replaces that array with the full target rows.

```json
{ "image": "image" }
```

```bash
# resolve_relations={"image":"image"}
curl "http://localhost:3100/publication/server_api/v2/dedalo_web/tables/interview/records?resolve_relations=%7B%22image%22%3A%22image%22%7D"
```

Three forms are supported:

- **Direct** — `{"image":"image"}`: resolve the `image` column against the `image` table on `section_id`.
- **Match a non-`section_id` column** — the *target* value may use `table.column` to match on a different column, e.g. `{"birthplace_id":"location.term_id"}`.
- **Nested (dot in the key)** — `{"eventos.documentos":"image"}`: resolve `eventos`, then resolve the `documentos` column inside each resolved `eventos` row against `image`.
- **Auto** — `{"link":"auto"}`: for "link" columns whose cell value is an object like `{"table":"interview","section_id":1}`, the target table is read from the value itself and resolved dynamically.

!!! note "Resolution bounds"
    Nested resolution is capped at depth `3` (`MAX_RESOLVE_DEPTH`) and each column resolves at most `50` referenced ids (`MAX_RESOLVE_ROWS`). A column that cannot be resolved is left untouched (its original value is returned) rather than failing the request. A malformed `resolve_relations` JSON value, or a value that is not a JSON object of string values, returns a `400`.

## Inverse relation resolution

`resolve_inverse_relations` resolves the `dd_relations` column — the inbound locators pointing **at** the current record. Each locator carries a `section_tipo`, which is mapped to a target table.

- Pass `true` (or `1`) to load the `section_tipo`→table mapping from the database's `publication_schema` (cached ~30 s). Every diffusion run of an `sql` element writes that table: its `dd_relations` maps each section the element publishes to its table, and the element's `properties.diffusion.publication_schema` adds or overrides entries. Elements that share a database merge their entries into the one row. A database without the table (published before this was added, or never republished) answers `400` until its next run; pass an explicit map there.
- Or pass a JSON object that maps `section_tipo` to table directly, e.g. `{"rsc170":"interview"}`.

```bash
# Use the publication_schema mapping
curl "http://localhost:3100/publication/server_api/v2/dedalo_web/tables/interview/records?resolve_inverse_relations=true"

# Explicit section_tipo → table map: {"rsc170":"interview"}
curl "http://localhost:3100/publication/server_api/v2/dedalo_web/tables/interview/records?resolve_inverse_relations=%7B%22rsc170%22%3A%22interview%22%7D"
```

After resolution the `dd_relations` column holds the resolved rows. Locators whose `section_tipo` is not in the mapping, or whose target row cannot be fetched, are skipped silently.

## Putting it together

A realistic listing query — English variants of interviews coded `OH-*`, newest first, three columns, first page of ten, with the total:

```bash
curl "http://localhost:3100/publication/server_api/v2/dedalo_web/tables/interview/records?\
filter%5Bcode%5D%5Blike%5D=OH-%25&\
lang=lg-eng&\
sort=-section_id&\
fields=section_id,code,title&\
limit=10&\
count=true"
```

```json
{
  "data": [
    { "section_id": 142, "code": "OH-142", "title": "Interview with María", "lang": "lg-eng" }
  ],
  "pagination": { "limit": 10, "offset": 0, "total": 142 },
  "meta": { "response_time_ms": 4.21 }
}
```

The same filter/pagination knobs are available in a [batch](endpoints.md#post-batch) request via `params` (array values become repeated keys, so bracketed filters work). Error shapes (`400` validation, `404`, `429`, …) and caching headers are documented in [HTTP semantics](http_semantics.md).

## Related

- [Endpoints](endpoints.md) — the full route catalogue, single-record / search / fragment endpoints and batch.
- [HTTP semantics](http_semantics.md) — envelopes, Problem Details errors, caching, rate limiting and security.
- [Publication API v2](../index.md) — version landing page.
- [Publication API overview](../publication_api.md) — diffusion context and the legacy v1 API.
