# dd_core_api

> See also: [JSON API v1](../dedalo_api_v1.md) · [RQO field mapping](../RQO_FIELD_MAPPING.md) · [dispatch](dispatch.md)

Core Dédalo API for the section/record lifecycle and page context. It is the API that front-end page builders and components use most.

## How to call

- POST JSON to `/api/v1/json` (or the client-relative `/dedalo/core/api/v1/json`) with `dd_api: "dd_core_api"` and `action: "<method>"`.
- The request uses the Request Query Object (RQO) shape: `dd_api`, `action`, `source`, `sqo`, `show`, `options`, `data`.
- Every action is registered in `ACTION_REGISTRY` in `src/core/api/dispatch.ts` and gated (auth, CSRF, per-action permissions) before it runs.

## Notes

- `source` and `sqo` are central: when one is missing, the server builds a sensible default from the `source` metadata.
- For file uploads, use `multipart/form-data`; the media ingest branch of the API path (`src/server.ts`) handles them, not the JSON dispatcher.
- **Envelope v2.** Success is `{ ok: true, request_id, data, … }` — the payload lives in `data` and nowhere else; keys a client reads by their own name (`environment`, `table`, …) ride at the top level as **extension keys**. A refusal is `{ ok: false, request_id, error: { code, category, message, label_key, retryable } }` and carries the registry's HTTP status. The v1 `{ result, msg, errors }` shape was removed on 2026-08-16 and `result` is a **forbidden** top-level key.
- **`section_id` is an int.** A matrix record address is a safe integer, negatives included (`-1` is the root/superuser record). A numeric string still coerces at the boundary but is deprecated and counted; a value that addresses no record refuses as `section_id.not_an_address`.

## start

### Purpose

Initialize the application, retrieve environment and session state.

### Accepts

- `options`: object (optional)
  - `search_obj`: object (optional) — URL parameters
  - `menu`: boolean (optional) — whether to load menu state
  - `recovery`: string (optional) — recovery key for maintenance mode

### Returns

`{ ok: true, request_id, data: { context: [ … ], data: [] }, environment: { page_globals, plain_vars } }`. `environment` is a top-level extension key, not part of `data`.

### Usage

Typically called on page load. `data.context` describes the element the client is to mount; `data.data` is always empty here.

### Example Request

```json
{
  "dd_api": "dd_core_api",
  "action": "start",
  "options": {
    "search_obj": {},
    "menu": false
  }
}
```

### Example Response

```json
{
  "ok": true,
  "request_id": "c0ffea00",
  "data": { "context": [ /* section/menu element contexts */ ], "data": [] },
  "environment": { "page_globals": {}, "plain_vars": {} }
}
```

> Unauthenticated `start` returns the **login** element context (this is what renders the login form). There is no installer context: a machine that is not installed does not serve at all — the server refuses to start ([installer reference](../../install/installer_reference.md#a-server-that-is-not-installed-refuses-to-start)). The environment block is built by `src/core/resolve/environment.ts`.

## read

### Purpose

Retrieve record/component data with optional filtering.

### Accepts

- `source`: object (required)
  - `section_tipo`: string (required) — section type identifier
  - `section_id`: int (optional) — specific record to read
  - `action`: string (optional) — "get_value" or default (build_json_rows)
  - `tipo`: string (optional) — component type
  - `model`: string (optional) — component model
  - `mode`: string (optional) — "edit" or "list"
  - `lang`: string (optional) — language code
- `sqo`: object (optional)
  - `limit`: int (optional) — max records to return
  - `offset`: int (optional) — pagination offset
  - `section_tipo`: array (optional) — filter by section types

### Returns

`{ ok: true, request_id, data: { context: [ … ], data: [ … ] } }` — the section (or component) structure contexts plus the resolved records. Note the nesting: the read's own `{context, data}` pair **is** the envelope's `data`.

### Usage

Core method for reading record data. Can fetch full section data or a single component (`source.action: "get_data"`), search filter chips (`resolve_data`), or the References panel (`get_relation_list`). Read requires permission level ≥ 1 on the section.

A related search (`sqo.mode: "related"` — the References panel, its graph, the tools' `related_search`) is gated on the **host** records named in `sqo.filter_by_locators`: the caller needs level ≥ 1 on each host's section, and the literal `sqo.section_tipo: ["all"]` (every owning section) is not checked as a section of its own. The referencing records are then restricted to the ones the caller may see — read grant on their section and inside the caller's projects — before the page is cut, so a page is full while more of the caller's records exist, and `count` returns exactly the number of records the pages hold.

### Example Request

```json
{
  "dd_api": "dd_core_api",
  "action": "read",
  "source": {
    "section_tipo": "rsc167",
    "section_id": 528,
    "action": null
  },
  "sqo": {
    "limit": 10,
    "offset": 0
  }
}
```

### Example Response

```json
{
  "ok": true,
  "request_id": "c0ffea01",
  "data": {
    "context": [ /* structure contexts */ ],
    "data": [
      { "section_id": 528, "section_tipo": "rsc167", "tipo": "rsc36", "value": ["Sample transcription"] }
    ]
  }
}
```

## read_raw

### Purpose

Retrieve full raw data from database for section or component.

### Accepts

Note: `read_raw` reads its identifiers from **`options`** (not `source`), matching `src/core/api/dispatch.ts`.

- `options`: object (required)
  - `section_tipo`: string (required) — section type
  - `tipo`: string (required) — component/section type
  - `model`: string (optional) — component model
  - `type`: string (optional)
- `sqo`: object (optional) — target sections default to `[options.section_tipo]` when absent.

### Returns

`{ ok: true, request_id, data: [ … ], table: "<matrix table>" }` — `data` is the raw stored value(s) for the SQO's matched records; `table` is a top-level extension key the raw view reads by name.

### Usage

Read requires level ≥ 1 on every SQO target section. A missing `options.section_tipo` or `options.tipo` refuses with `request.invalid_source`; an insufficient grant with `perm.denied`.

### Example Request

```json
{
  "dd_api": "dd_core_api",
  "action": "read_raw",
  "options": {
    "section_tipo": "rsc167",
    "tipo": "rsc167"
  },
  "sqo": {
    "section_tipo": ["rsc167"],
    "limit": 1
  }
}
```

### Example Response

```json
{
  "ok": true,
  "request_id": "c0ffea02",
  "data": [ /* raw stored values per matched record */ ],
  "table": "matrix"
}
```

## relation_targets

### Purpose

The census behind "Open relationships": which sections the records of a source set point at, and how many records of each.

### Accepts

Like `read_raw`, the input rides in **`options`**; there is no `sqo`, so no page limit applies.

- `options`: object (required), holding exactly:
  - `source`: object (required) — a [`referenced_by` source set](../../core/sqo.md#relationship-filter-leaves-referenced_by):
    - `section_tipo`: string[] (required) — the source sections
    - `filter`: object (optional) — the source search filter (may nest a `referenced_by` leaf, depth ≤ 4)
    - `filter_by_locators`: object[] (optional) — explicit source records
    - `filter_by_locators_op`: `"OR"` (optional) — the only accepted value
    - `from_component_tipo`: string (optional) — count only the locators of this component

### Returns

`{ ok: true, request_id, data: [{ tipo, label, total }, …] }` — one entry per target section, ordered by `tipo`, `label` in the request language. Each `total` is exact (the count the opened window would show, with the target's access rules applied). Unreadable targets and targets with total 0 are omitted; `[]` means nothing to open. A `perm.out_of_scope` notice is added when the user's component permissions hide relation components of a source section.

### Usage

Read requires level ≥ 1 on every source section (`perm.denied`). A malformed source, an unknown `options` key or a `sqo` key refuses with `request.invalid_options`; an invalid tipo or a source section with no record table with `request.invalid_tipo`. The locators are read from the source records' stored `relation` column (the `read_raw` `target_section` reading, not the relation index), so log sections are valid sources. The census (a grouped pass, then one statement for every exact total) has one 30-second deadline across its statements, capped by `DB_STATEMENT_TIMEOUT_MS`; past it the request fails with `db.statement_timeout` (503). The client's own timeout for this call (35 s) is longer, so that refusal arrives first.

### Example Request

```json
{
  "dd_api": "dd_core_api",
  "action": "relation_targets",
  "options": {
    "source": {
      "section_tipo": ["oh1"],
      "filter_by_locators": [{ "section_tipo": "oh1", "section_id": 3 }],
      "from_component_tipo": "oh24"
    }
  }
}
```

### Example Response

```json
{
  "ok": true,
  "request_id": "c0ffea03",
  "data": [ { "tipo": "rsc197", "label": "People", "total": 2 } ]
}
```

## create

### Purpose

Create a new record in a section.

### Accepts

- `source`: object (required)
  - `section_tipo`: string (required) — target section type

### Returns

`{ ok: true, request_id, data: <new section_id> }` — an int.

### Usage

Creates a new blank record. Requires permission level ≥ 2 on the section (`perm.denied` otherwise); a missing `source.section_tipo` refuses with `request.invalid_source`.

### Example Request

```json
{
  "dd_api": "dd_core_api",
  "action": "create",
  "source": {
    "section_tipo": "rsc167"
  }
}
```

### Example Response

```json
{
  "ok": true,
  "request_id": "c0ffea03",
  "data": 125
}
```

## duplicate

### Purpose

Duplicate an existing record with all its data.

### Accepts

- `source`: object (required)
  - `section_id`: int (required) — source record to duplicate
  - `section_tipo`: string (required) — section type

### Returns

`{ ok: true, request_id, data: <new section_id> }` — an int.

### Usage

Creates a complete copy of the source record, including all component data. Requires level ≥ 2 (`perm.denied`); a non-admin must also have the source record inside their projects scope (`perm.out_of_scope`). A `section_id` that is not a record address refuses with `section_id.not_an_address`.

### Example Request

```json
{
  "dd_api": "dd_core_api",
  "action": "duplicate",
  "source": {
    "section_id": 1,
    "section_tipo": "rsc167"
  }
}
```

### Example Response

```json
{
  "ok": true,
  "request_id": "c0ffea04",
  "data": 126
}
```

## delete

### Purpose

Delete a record or section data.

### Accepts

- `source`: object (required)
  - `section_tipo`: string (required; `tipo` is accepted as a fallback)
  - `section_id`: int (required unless `sqo` is present)
  - `delete_mode`: string (optional, default `"delete_data"`) — `"delete_data"` empties every component and keeps the row; `"delete_record"` removes the row (a Time Machine snapshot is taken first).
- `sqo`: object (optional) — bulk delete by search. **Global-admin only**, and constrained to the gated section.

### Returns

`{ ok: true, request_id, data: [ <deleted section_id>, … ] }` — an array of **ints**, the records actually deleted.

Parents whose children refused to go are **not** a failure: what was deleted really was deleted and stays the payload, and the refusal travels as one coded notice in `notices[]`:

```json
"notices": [
  {
    "code": "record.delete_children_refused",
    "label_key": "error_record_delete_children_refused",
    "retryable": false,
    "details": { "not_deleted": "12,17" }
  }
]
```

### Usage

Requires level ≥ 2 on the section (`perm.denied`), and a non-admin must have the record in their projects scope (`perm.out_of_scope`). Ontology-main sections cascade (uninstall the TLD) under `delete_record`, global-admin only. Deleting a user or profile record also drops the affected security caches, so access reflects the deletion on the next request.

### Example Request

```json
{
  "dd_api": "dd_core_api",
  "action": "delete",
  "source": {
    "section_tipo": "rsc167",
    "section_id": 528,
    "delete_mode": "delete_record"
  }
}
```

### Example Response

```json
{
  "ok": true,
  "request_id": "c0ffea05",
  "data": [1]
}
```

## save

### Purpose

Save component data to a record.

### Accepts

The TS handler reads these from `source` (`src/core/api/dispatch.ts` → `saveComponentData`):

- `source`: object (required)
  - `tipo`: string (required) — component type
  - `section_tipo`: string (required) — parent section type
  - `section_id`: int (required) — parent section id
  - `lang`: string (optional, default `"lg-nolan"`) — language code
  - `caller_dataframe`: object (optional) — dataframe pairing context (`main_component_tipo`, `id_key`)
- `data`: object (required)
  - `changed_data`: array (required) — change objects, each `{ action, key, value }` where `action` ∈ `update` / `insert` / `remove` / `set_data` / `sort_data` / `sort_by_column` / `add_new_element`.

### Returns

`{ ok: true, request_id, data: { context: [ … ], data: [ <saved DataItem> ] } }`.

### Usage

Saves component changes. Requires level ≥ 2 on `(section_tipo, tipo)`. On success the server echoes the saved component in the canonical DataItem envelope (relation and select-family saves also carry `datalist` / `pagination` / `context`), triggers server-side observers, and writes an activity-log entry.

The echo is the **twin of the edit read**: for a translatable literal (the `component_input_text` / `component_text_area` family, `component_iri`) the record stores every language in one flat array, and the echoed `entries` carry only the **`source.lang` slice** — exactly what a `get_data` read of the same component returns. Non-translatable and relation components echo their full item array, since they are not language-sliced.

!!! warning
    A client that assigns the echoed item to its in-memory component data (the standard post-save refresh) therefore keeps one language. Echoing every language instead is what made an ontology-tree inline term edit repaint the node with all its translations concatenated. Gate: `test/unit/save_echo_lang_slice_native.test.ts`.

### Example Request

```json
{
  "dd_api": "dd_core_api",
  "action": "save",
  "source": {
    "tipo": "oh16",
    "section_tipo": "oh1",
    "section_id": 124,
    "lang": "lg-eng"
  },
  "data": {
    "changed_data": [
      { "action": "update", "id": 1, "value": { "id": 1, "lang": "lg-eng", "value": "Updated Title" } }
    ]
  }
}
```

`oh16` is a translatable `component_input_text`, so its items carry `id` + `lang`; the `id` pairs the language versions of the same value.

### Example Response

```json
{
  "ok": true,
  "request_id": "c0ffea06",
  "data": {
    "context": [],
    "data": [
      {
        "tipo": "oh16",
        "section_tipo": "oh1",
        "section_id": 124,
        "mode": "edit",
        "lang": "lg-eng",
        "from_component_tipo": "oh16",
        "entries": [ { "id": 1, "lang": "lg-eng", "value": "Updated Title" } ]
      }
    ]
  }
}
```

The record's other languages are untouched on disk and simply absent from this `lg-eng` echo.

## count

### Purpose

Count records matching SQO criteria.

### Accepts

- `sqo`: object (required)
  - `section_tipo`: array (required) — section types to count
  - `limit`: int (optional) — max results
  - `offset`: int (optional) — pagination offset
  - Other filter criteria (filters, search terms, etc.)

### Returns

`{ ok: true, request_id, data: { total: <int> } }`.

### Usage

Returns the total count of records matching the SQO. The read strategy owns counting (the default matrix source runs the SQO full-count; `sqo.mode: "related"` counts inverse references; `sqo.mode: "tm"` counts `matrix_time_machine`). Requires level ≥ 1 on every SQO target section — for `sqo.mode: "related"`, on the section of every host in `sqo.filter_by_locators` instead (`["all"]` is not a section). A related count counts only the referencing records the caller may see, so it equals the number of records the caller's References pages hold.

### Example Request

```json
{
  "dd_api": "dd_core_api",
  "action": "count",
  "sqo": {
    "section_tipo": ["rsc167"]
  }
}
```

### Example Response

```json
{
  "ok": true,
  "request_id": "c0ffea07",
  "data": { "total": 42 }
}
```

## get_element_context

### Purpose

Retrieve context information for a specific component/element.

### Accepts

- `source`: object (required)
  - `tipo`: string (required for section/component; a tool sends `model: "tool_x"` with no `tipo`)
  - `section_tipo`: string (optional, defaults to `tipo`)
  - `mode`: string (optional, default `"list"`)
  - `lang`: string (optional)
  - `model`: string (optional)

Covered models: `section`, `component_*`, and the area models. Tool contexts require the tool to be authorized for the caller.

### Returns

`{ ok: true, request_id, data: [ <one context entry> ] }` — an array of one (empty when nothing resolves), because the client build looks its own element up inside it.

### Usage

Returns the structure context (no data) for one element. Requires level ≥ 1 on `(section_tipo, tipo)` (`perm.denied`). A `tipo` that resolves to no node refuses with `request.invalid_source`; a model this action does not cover with `request.invalid_model`; an unauthorized tool with `tool.not_authorized`.

### Example Request

```json
{
  "dd_api": "dd_core_api",
  "action": "get_element_context",
  "source": {
    "section_tipo": "oh1",
    "tipo": "oh16",
    "mode": "edit"
  }
}
```

!!! note
    `oh16` is the `component_input_text` "Title" of the **Oral History** section `oh1` on the `monedaiberica` install — `section_tipo` must be the section the component actually lives in.

### Example Response

```json
{
  "ok": true,
  "request_id": "c0ffea08",
  "data": [
    { "tipo": "oh16", "model": "component_input_text", "label": "Title", "permissions": 3 }
  ]
}
```

## get_section_elements_context

### Purpose

Retrieve context for all components in a section.

### Accepts

- `options`: object — forwarded to `buildSectionElementsContext` (`src/core/resolve/section_elements_context.ts`). Permissions are **always** enforced server-side (the client's `skip_permissions` flag is ignored).

### Returns

`{ ok: true, request_id, data: [ { context_for_each_element }, … ] }`.

### Usage

Returns the "simple" structure-context set for a section — the edit-mode search-filter panel's element list.

### Example Request

```json
{
  "dd_api": "dd_core_api",
  "action": "get_section_elements_context",
  "options": {
    "section_tipo": "oh1"
  }
}
```

### Example Response

```json
{
  "ok": true,
  "request_id": "c0ffea09",
  "data": [
    {
      "tipo": "oh16",
      "label": "Title",
      "model": "component_input_text"
    },
    {
      "tipo": "oh25",
      "label": "Audiovisual",
      "model": "component_portal"
    }
  ]
}
```

## get_section_terms

### Purpose

Batch-resolve the `section_map` display term for a set of records in one call — the graph view labels all of its nodes with a single request instead of one datum read per node.

### Accepts

The locators, scope and lang ride at the **top level** of the RQO (not under `source`/`options`), matching the client's `build_graph_data.js`:

- `locators`: array (required) — `{ section_tipo, section_id }` entries. Hard-capped at 1000; a longer batch is truncated.
- `scope`: string (optional) — a `section_map` scope; `null` uses the main → thesaurus → relation_list chain.
- `lang`: string (optional) — defaults to the request data language.

### Returns

`{ ok: true, request_id, data: { "<section_tipo>_<section_id>": "<term>|null", … } }` — keyed per resolved record, deduped by composite key. An empty or invalid `locators` array refuses with `section.bad_locators` (HTTP 400).

### Usage

Read permission (level ≥ 1) is required per section; unreadable, invalid, or non-`section_map` sections are skipped silently (never leaked, never clobbering the client's provisional node label).

### Example Request

```json
{
  "dd_api": "dd_core_api",
  "action": "get_section_terms",
  "locators": [
    { "section_tipo": "oh1", "section_id": 368 },
    { "section_tipo": "es1", "section_id": 13919 }
  ]
}
```

### Example Response

```json
{
  "ok": true,
  "request_id": "c0ffea10",
  "data": { "oh1_368": "Interview with…", "es1_13919": "Valle" }
}
```

## get_indexation_grid

### Purpose

Build the thesaurus "show indexations" grid for a term component in a record.

### Accepts

- `source`: object (required)
    - `section_tipo`: string (required) — the term's section.
    - `section_id`: int (required) — the term record.
    - `tipo`: string (required) — the element the grid was opened from. The door requires it; the grid content itself is driven by the SQO below.
- `sqo`: object (required in practice)
    - `section_tipo`: string or array (required) — the sections to search for records indexing the term. `"all"` searches every section. **Absent or empty answers an empty grid.**
    - `filter_by_locators`: array (required) — the term locators to find inverse references to. **An empty list answers an empty grid.**
    - `limit` (default 500) / `offset`.

### Returns

`{ ok: true, request_id, data: [ <grid cell>, … ] }` — the nested grid-cell tree the thesaurus indexation view renders, grouped by the top record each indexation belongs to. Records outside the caller's scope are dropped from the groups; a section with no indexation-list configuration is skipped and logged, never guessed at.

### Usage

Read permission (level ≥ 1) on the term's section is required (`perm.denied`, HTTP 403). A missing `section_tipo` / `section_id` / `tipo` — or a `section_id` that is not a record address — refuses with `request.invalid_source` (HTTP 400).

### Example Request

```json
{
  "dd_api": "dd_core_api",
  "action": "get_indexation_grid",
  "source": {
    "section_tipo": "es1",
    "section_id": 13919,
    "tipo": "hierarchy25"
  },
  "sqo": {
    "section_tipo": ["oh1"],
    "filter_by_locators": [ { "section_tipo": "es1", "section_id": 13919 } ],
    "limit": 100
  }
}
```

!!! note
    `es1` is a thesaurus section (a virtual section of the core **Thesaurus** section `hierarchy20`) on the `monedaiberica` install, and `hierarchy25` is its `component_input_text` term component — the one `es1`'s `section_map` names as `thesaurus.term`.

### Example Response

```json
{
  "ok": true,
  "request_id": "c0ffea11",
  "data": [ { "type": "column", "label": "Oral History", "value": [ /* … */ ] } ]
}
```

## get_activity_metric

### Purpose

Fetch an on-demand activity-metric dataset for the area dashboard's timeline range switch (3m / 6m / 1y). The dashboard read serves only the recent range inline; wider ranges are fetched here so the initial payload stays small.

### Accepts

- `options`: object (required)
  - `area_tipo`: string (required) — must resolve to an area model
  - `range_days`: int (required) — one of the supported ranges (`ACTIVITY_RANGE_DAYS`, `src/core/area/dashboard.ts`)

### Returns

`{ ok: true, request_id, data: <activity dataset> }`.

### Usage

Gated identically to the dashboard read — read permission (level ≥ 1) on the area (`perm.denied`). An unresolvable `area_tipo` refuses with `request.invalid_tipo`, a tipo that is not an area model with `request.invalid_model`, and an unsupported `range_days` with `request.invalid_options` — all HTTP 400.

### Example Request

```json
{
  "dd_api": "dd_core_api",
  "action": "get_activity_metric",
  "options": {
    "area_tipo": "dd542",
    "range_days": 90
  }
}
```

### Example Response

```json
{
  "ok": true,
  "request_id": "c0ffea12",
  "data": { /* timeline buckets for the requested range */ }
}
```

## get_ip_country

### Purpose

Resolve an IP address to a country for the Activity (`dd542`) IP-list view. Resolution is **local and offline** against the openly-licensed DB-IP Country Lite database (`src/core/geoip`) — no third-party request.

### Accepts

- `options`: object (required)
  - `ip`: string (required) — the address to resolve (1–64 chars)

### Returns

`{ ok: true, request_id, data: { country_code: <ISO code|null> } }`. `country_code` is `null` for private/reserved/unresolved addresses and when the database is not loaded, so the client simply shows no flag.

### Usage

Authenticated (the dispatch session + CSRF gates already ran). A missing or malformed `ip` refuses with `request.invalid_options` (HTTP 400).

### Example Request

```json
{
  "dd_api": "dd_core_api",
  "action": "get_ip_country",
  "options": {
    "ip": "8.8.8.8"
  }
}
```

### Example Response

```json
{
  "ok": true,
  "request_id": "c0ffea13",
  "data": { "country_code": "US" }
}
```

## get_environment

### Purpose

Return the full client environment payload — `page_globals` + `plain_vars` (the same block `start` embeds). The client injects it via `set_environment()` at boot. The UI-label dictionary is not in it: the client fetches it from `GET /api/v1/labels?lang=<page_globals.dedalo_application_lang>&v=<page_globals.labels_version>` (public; immutable-cached while `v` is current, `no-cache` + `ETag` otherwise).

### Accepts

No arguments. The block is built for the current session (or the anonymous environment when unauthenticated).

### Returns

`{ ok: true, request_id, data: { page_globals, plain_vars } }`, built by `src/core/resolve/environment.ts`. It is the same block `start` ships as its `environment` extension key.

### Usage

`get_environment` is a `NO_LOGIN` action — it serves the anonymous environment before a session exists and the authenticated one after login. The page-globals / plain-vars / label payloads are not separate actions; they are all served through this one block.

### Example Request

```json
{
  "dd_api": "dd_core_api",
  "action": "get_environment"
}
```

### Example Response

```json
{
  "ok": true,
  "request_id": "c0ffea14",
  "data": {
    "page_globals": { /* … */ },
    "plain_vars": { /* … */ }
  }
}
```

> The ontology locator of a `tipo` is not exposed as an API action: it is resolved internally through the ontology resolver (`src/core/ontology/resolver.ts`).
