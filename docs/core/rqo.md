# Request Query Object (RQO)

`src/core/concepts/rqo.ts` defines the shape (`Rqo` zod schema); `src/core/api/dispatch.ts`
dispatches it (`dispatchRqo()` + the explicit `ACTION_REGISTRY`).

## Overview

The Request Query Object (RQO) is the single, normalized message format used by every client→server call to the Dédalo work API. One RQO answers four questions:

| Question | RQO property |
|----------|--------------|
| **Who** is calling? | `source` (the element instance: tipo, section_tipo, section_id, mode, lang...) |
| **What** should be done? | `dd_api` (API class) + `action` (API method) + `source->action` (per-element modifier) |
| **Over which records?** | `sqo` (Search Query Object: filter, limit, offset, order) |
| **What should come back / be displayed?** | `show` / `search` / `choose` (ddo_map layouts) |

Everything else (`data`, `options`, `prevent_lock`, `pretty_print`, `id`) is payload and transport tuning.

In one sentence:

- **Why** — one wire format for *every* component type and every operation, so the client transport, the security gate, and the dispatcher are written once instead of per-component.
- **What** — a plain JSON object, validated against the `Rqo` zod schema (`src/core/concepts/rqo.ts`). It carries a caller identity (`source`), an action (`dd_api`+`action`), an optional query (`sqo`) and optional layout maps (`show`/`search`/`choose`).
- **How** — the client builds it from the `request_config` the server injected into the element context, and POSTs it. The request is schema-validated (`rqoSchema.safeParse`), then `dispatchRqo()` (`src/core/api/dispatch.ts`) runs it through the `ACTION_REGISTRY` and returns the standard envelope.

For the server-side config the client builds this from, see [request_config.md](request_config.md); for copy-paste ontology JSON and end-to-end RQO flows, see the cookbook [request_config_examples.md](request_config_examples.md). The [SQO](sqo.md) carried inside the RQO and the [DDO](dd_object.md) field set are documented separately.

## Why RQO exists

- **Before v6** every component type had its own `trigger` endpoint with its own interface. A `component_autocomplete` spoke a different dialect than `component_autocomplete_hi` or `component_portal`; any shared behavior had to be re-implemented per trigger.
- **v5 introduced the SQO** — an SQL abstraction that unified *queries* (its `filter` maps to `WHERE`, its `select` to `SELECT`), designed around Dédalo relations and data paths.
- **v6 unified the API** and first tried to use the SQO as the whole call format. It was quickly insufficient: a call also has to say *who* is calling, *what action* to perform, and *how to lay out* the result — none of which `SQO->select` was designed for.

The RQO wraps the SQO and adds the caller identity, the action dispatch and the layout maps. **SQO = the query; RQO = the request.**

## The contract at a glance

A section list view requesting its first page of records:

```json
{
	"id"     : "section_oh1_list",
	"action" : "read",
	"dd_api" : "dd_core_api",
	"prevent_lock" : true,
	"source" : {
		"typo"         : "source",
		"type"         : "section",
		"action"       : "search",
		"model"        : "section",
		"tipo"         : "oh1",
		"section_tipo" : "oh1",
		"section_id"   : null,
		"mode"         : "list",
		"lang"         : "lg-eng"
	},
	"sqo" : {
		"section_tipo" : ["oh1"],
		"filter"       : null,
		"limit"        : 10,
		"offset"       : 0,
		"order"        : [{"direction":"ASC","path":[{"component_tipo":"section_id"}]}]
	}
}
```

And the standard response envelope:

```json
{
	"ok"         : true,
	"request_id" : "…",
	"data"       : { "...action specific..." : "context/data, records, count, etc." },
	"notices"    : [],
	"csrf_token" : "…"
}
```

- `ok` — the boolean discriminator: `true` with `data`, `false` with `error`.
- `data` — the action's payload. Shape depends on the action: `read` returns `{context, data}`, `count` returns `{total}`, etc.
- `error` — on failure only: `{code, category, message, label_key, retryable, details?}`; `code` is a registry code (`src/core/errors/registry.ts`) and the HTTP status is its category's (`engineering/ERRORS_SPEC.md` §3). There is no `result` / `msg` / `errors` mirror (removed 2026-08-16).
- `notices` — optional non-fatal coded facts on a success (`{code, label_key, retryable, details?}`).
- `request_id` — top level on both outcomes; the join key to the access-log line.

!!! note "One RQO per HTTP call"
	The API endpoint decodes **a single RQO object** per request (`src/server.ts` → `dispatchRqo(rqo)`, `src/core/api/dispatch.ts`). Batching several operations is done with several `fetch` calls (the client `data_manager` runs them concurrently), not by sending an array of RQOs.

## Request lifecycle

The client (`create_source()`, `build_rqo_show()`/`build_rqo_search()`, `data_manager.js`) POSTs the same JSON to the same conceptual gate sequence for every operation. The server dispatches through an explicit action registry (`src/core/api/dispatch.ts`) with no dynamic method lookup — an unregistered `(dd_api, action)` pair simply does not exist.

```mermaid
graph TD
	A["Client element instance<br/>(section, component, service...)"] -- "create_source() + build_rqo_show()/build_rqo_search()" --> B["data_manager.request({body: rqo})<br/>POST JSON + X-Dedalo-Csrf-Token"]
	B --> C["HTTP layer<br/>decode + build ApiRequestContext"]
	C -- "sanitizeClientSqo(rqo.sqo)" --> D["dispatchRqo()<br/>(src/core/api/dispatch.ts)"]
	D -- "ACTION_REGISTRY lookup + auth + CSRF" --> E["ACTION_REGISTRY[dd_api][action](rqo, context)"]
	E -- SQO --> F["buildSearchSql() / search engine<br/>(src/core/search/)"]
	F -- SQL --> G[("matrix tables (PostgreSQL)")]
	G --> E
	E -- "response {result, msg, errors}" --> A
```

Step by step:

1. **Build** — the element instance builds its RQO from its `request_config` (injected in its context by the server; see [request_config.md](request_config.md)), picks the active config object (`api_engine === 'dedalo' && type === 'main'`), deep-clones it, and fills the live state. Helpers: `create_source()`, `common.build_rqo_show()`, `common.build_rqo_search()` in `core/common/js/common.js`.
2. **Send** — `data_manager.request({body: rqo})` POSTs it as JSON with the `X-Dedalo-Csrf-Token` header, retry/timeout handling and optional local-DB caching. On a `csrf_failed` rejection it refreshes the cached token and retries exactly once.
3. **Gate** (`src/server.ts`) — the whole decoded JSON body is validated in one pass by `rqoSchema.safeParse()` (`src/core/concepts/rqo.ts`) — malformed JSON or a body that fails the schema is rejected with HTTP 400 *before* any dispatch gate runs. Because `rqoSchema`'s `show`/`search`/`choose` blocks are typed through `ddoMapSchema` (`src/core/concepts/ddo.ts`), a **strict whitelist** (zod's default `.strip()` drops any key not listed), the ddo-whitelist scrub happens as a side effect of schema validation rather than as a separate function call. `rqo.sqo` is additionally run through `sanitizeClientSqo()` (`src/core/concepts/sqo.ts`) once the handler needs it, stripping server-only SQO fields, forcing `parsed=false`, and clamping `limit` to `CLIENT_MAX_LIMIT`. The file-upload endpoint is a separate route (`handleMediaUpload`).
4. **Dispatch** (`dispatchRqo()`, `src/core/api/dispatch.ts`) — runs its gates in order: (1) `ACTION_REGISTRY[dd_api]?.[action]` lookup — undefined action **or** unregistered `(dd_api, action)` pair is rejected identically; (1c) an error-report-intake action additionally requires the receiver to be enabled and the caller's IP allowed; (2) auth — session required unless `action` is in `NO_LOGIN_ACTIONS`; (3) CSRF — required for authenticated actions not in `CSRF_EXEMPT_ACTIONS` (constant-time `verifyCsrf`), returning the fresh token so the client's one-shot retry can succeed; (4) the handler runs inside `runWithRequestLangs()`, seeding the request-scoped application/data language from the session (`src/core/resolve/request_lang.ts`, `AsyncLocalStorage`-scoped). There is no separate maintenance-area permission pre-gate step — `dd_area_maintenance_api` handlers check it themselves.
5. **Execute** — the registered handler runs the action directly: for data actions it resolves permissions for `source`, then calls the section/relations/search engines directly, resolving `show`/`search`/`choose` ddo_maps into context+data via `src/core/resolve/structure_context.ts` and `src/core/section/read.ts`.
6. **Respond** — the standard envelope goes back as JSON; every response from an authenticated session gets a fresh `csrf_token` appended. An unhandled handler exception is caught at the very top of `dispatchRqo()` and converted (`src/core/errors/convert.ts`) into `{ok:false, request_id, error:{code:'internal.unexpected', …}}` at HTTP 500 — the body, not the status, is what the client reads (`api_response.error.code`), and the underlying exception text never reaches the wire.

The layout maps resolved along the way are `show`, `search` and `choose`. `hide` is **not** an RQO wire field (see the [`hide` note](#hide-is-a-request_config-only-block) below).

## Properties

The `Rqo` shape (`src/core/concepts/rqo.ts`) carries: `id`, `api_engine`, `dd_api`, `action`, `source`, `sqo`, `show`, `search`, `choose`, `data`, `prevent_lock`, `options`, `pretty_print`.

**Documented as mandatory:** `dd_api`, `action`, `source` — **documented as optional:** everything else. If only a `source` is sent, the server derives the SQO and layout from the user preset or the ontology `request_config` (see *RQO and request_config* below).

!!! note "What is actually enforced"
	`rqoSchema` (`src/core/concepts/rqo.ts`) enforces its declared shape via `safeParse()` at the HTTP boundary (`src/server.ts`) — a body that fails validation is rejected outright with HTTP 400, `errors` carrying the zod issue list. Only `action` is a required (non-optional) field in the schema; everything else, including `dd_api`, is `.optional()`, with `dd_api` defaulting to `dd_core_api` inside `dispatchRqo()` when absent. `read` separately requires a non-empty `source.section_tipo`. The schema is `.passthrough()`, so an unrecognized top-level key is kept, not rejected.

### id : `string` *Optional*

Client-side identifier of the request, echoed for correlation/debugging. Conventionally built from the caller context (e.g. `section_oh1_list`).

### api_engine : `string` *Optional, default `'dedalo'`*

Backend engine for data retrieval: `dedalo` (internal) or an external engine name such as `zenon`. External engines resolve their connection details from the target section's `api_config` properties.

### dd_api : `string` *Mandatory, default `'dd_core_api'`*

The API class that will handle the call. Only classes that are top-level KEYS of `ACTION_REGISTRY` (`src/core/api/dispatch.ts`) are reachable — there is no separate whitelist array to keep in sync, the registry object's keys ARE the whitelist.

| Class | Purpose | Actions |
|-------|---------|-----------|
| `dd_core_api` | Core data lifecycle: read/save/create/delete/count, element contexts | see the action table below |
| `dd_tools_api` | Tool execution (export, import, time machine, diffusion launchers...) | `user_tools`, `tool_request` (the latter sub-dispatches into `src/core/tools/dispatch.ts`, its own per-tool explicit registry) |
| `dd_ts_api` | Thesaurus tree operations (expand, move, indexation...) | `get_node_data`, `get_children_data`, `add_child`, `update_parent_data`, `save_order` |
| `dd_utils_api` | Utilities: login/logout, uploads, locks, environment, system info | see `src/core/api/handlers/dd_utils_api.ts` for the exact action set |
| `dd_diffusion_api` | Publishing and diffusion-process control | `diffuse`, `get_process_status`, `list_processes`, `cancel_process`, `get_diffusion_info`, `get_engine_advisory`, `retry_pending_deletions`, `validate`, `rebuild_media_index` |
| `dd_area_maintenance_api` | Admin maintenance widgets | `widget_request`, `get_widget_value`, `lock_components_actions` |
| `dd_component_portal_api` | Portal-specific endpoints | `delete_locator` |
| `dd_component_text_area_api` | Transcription tag resolution/deletion (WC-077) | `get_tags_info`, `delete_tag` |
| `dd_component_av_api`, `dd_component_3d_api` | Media posterframe / stream endpoints | posterframe generation (+ media streams for AV) |
| `dd_component_info` | Info-widget data | `get_widget_data` |
| `dd_rag_api` | Semantic search / RAG retrieval | see `src/ai/rag/api.ts` |
| `dd_mcp_api` | The in-process MCP/agent bridge for `tool_assistant` | `mcp_proxy` (fails closed unless the agent HTTP surface is enabled) |
| `dd_error_report_api` | Anonymous machine-to-machine error-report intake | `receive_report` (reachable only while the receiver is enabled, gated separately from the auth pipeline) |

There is no `dd_ontology_api`/`dd_agent_api` key in the registry — those classes are not reachable through this RQO mechanism.

The default when `dd_api` is unset is `dd_core_api`.

`dispatchRqo()`'s single lookup (`ACTION_REGISTRY[dd_api]?.[action]`) is the whole allowlist check — an unregistered action is unreachable unconditionally, for every class.

### action : `string` *Mandatory*

The API class method to execute. The core action set (`ACTION_REGISTRY['dd_core_api']`, `src/core/api/dispatch.ts`):

| Action | Purpose | `result` shape |
|--------|---------|----------------|
| `start` | First-load bootstrap. Resolves the URL element (section / section_tool / area_* / tool_* / component_*) to its structure context plus environment. Handles recovery mode and not-logged (login context). | `{context: array, data: []}`; always also `response.environment` |
| `read` | Fetch context+data for a source element. Sub-dispatches on `source->action` (see below). | `{context: array, data: array}` |
| `read_raw` | Unrendered JSONB straight from the matrix table, by `options->type` (`section` / `component` / `target_section`). Used by `tool_export`. | `result: array` of raw rows; plus `response.table` |
| `relation_targets` | Which sections the records of a source set point at, and how many records of each — the census behind "Open relationships". Input in `options.source` (a [`referenced_by` source set](sqo.md#relationship-filter-leaves-referenced_by)). Read-only. | `data: [{tipo, label, total}]` |
| `create` | Insert an empty record into a section's matrix table (counter service). Requires write (≥ 2). | `result: int` new `section_id`, or `false` |
| `duplicate` | Deep-copy a record. Two gates: section write (≥ 2) **and** the caller's project/tenant scope over the source record. | `result: int` new `section_id`, or `false` |
| `delete` | Remove records. Target = `sqo` (preferred, multi-record) or `source->section_id`. Section model only, write (≥ 2). | forwarded result |
| `save` | Persist component changes. Only `source->type:'component'` is implemented. | `result: {context, data}` (refreshed element) or `false` |
| `count` | `COUNT(*)` for the SQO. Forces `full_count=true`, merges the session filter, returns `0` on permission denial (no leak). | `result: {total: int}` (or `0`) |
| `get_element_context` | Structure context for one element, **no data**. `simple:true` → lightweight context. | `result: object` (context) |
| `get_section_elements_context` | Component contexts for one/more sections (filter panel, export columns). | `result: array` of component contexts |
| `get_indexation_grid` | Thesaurus indexation grid for a component in a record. | `result: object` (grid) |
| `get_environment` | Bootstrap payload (`page_globals`, `plain_vars`). No-arg; also called inside `start`. Labels: `GET /api/v1/labels?lang=&v=<page_globals.labels_version>`. | `result: {page_globals, plain_vars}` |
| `get_section_terms` | Batch-resolves authoritative section_map term labels for locators (graph node labels). Silent skip on unreadable. | `result: object` keyed `"{section_tipo}_{section_id}" => term` |

`get_matrix_ontology_locator` and `test` are not registered.

Other `dd_*_api` classes declare their own action sets — see the `dd_api` table above.

### source : `object` *Mandatory*

Identity of the calling element — built client-side by `create_source()` (`core/common/js/common.js`):

| Field | Type | Notes |
|-------|------|-------|
| `typo` | `string` | Always `'source'` |
| `type` | `string` | Element type: `component`, `section`, `area`, ... (drives e.g. `save` dispatch) |
| `action` | `string` | **Modifier of the main action** for this element. E.g. `read` + `source->action: 'get_value'` returns the plain component value instead of context+data |
| `model` | `string` | Element model (`section`, `component_portal`, ...). Recalculated server-side from `tipo` when omitted |
| `tipo` | `string` | Ontology tipo of the element |
| `section_tipo` | `string` | Target section tipo (mandatory in `read`) |
| `section_id` | `int\|null` | Record id — always an integer (negatives valid; `-1` is the root record). `null` (or absent) for lists/new records. A numeric string still coerces at the boundary, deprecated and counted; external-service remote ids (`001338683`, `Q42`) and synthetic tokens (`search_1`) are not addresses and travel verbatim. Law: `engineering/wire_contract/WC-2026-08-10-section-id-int-canonical.md` |
| `mode` | `string` | `edit` \| `list` \| `search` \| `tm` \| ... |
| `lang` | `string` | Data language (`lg-eng`, `lg-nolan`, ...) |
| `view` | `string` | View variant (`default`, `line`, `mosaic`, ...) |
| `matrix_id`, `data_source` | optional | Time machine: address a specific matrix row / `'tm'` data source |
| `is_temporal` | `bool` optional | Marks a tool's throwaway editable clone (`tool_propagate_component_data`, `service_tmp_section`, the `component_text_area` pickers). Such an instance **addresses no record**: the `section_id` it carries is a client sentinel, not an address. `save` resolves and echoes the applied value **without persisting**; `read` resolves context/datalist with an empty value; `create`/`duplicate`/`delete` refuse it. See WC-059 |
| `caller_dataframe` | `object` optional | Dataframe pairing info (see component_dataframe docs) |
| `callers` | `array` optional | The element's **caller chain** when it is read directly while nested (page 2 of a portal inside a portal cell, the autocomplete or tree picker inside that cell): `[{tipo, section_tipo, mode}, …]`, from the **outermost** component down to the element's direct parent; `mode` (`edit` \| `list`) is on the first link. The first link may be the **section** itself (`{tipo: S, section_tipo: S, mode}`) when the outermost component is a column of a section's list map. A top-level element sends no `callers` key. The server **verifies, never trusts** it (`src/core/relations/caller_chain.ts`): the root must be readable, and every further link and the element must be a declared child of the link above in its effective config. A verified chain resolves the element under its caller (the columns the caller declared — see [Nesting](request_config.md#nesting-a-ddo_map-is-a-flat-list-made-a-tree-by-parent)) and opens the writer's scoped search; a chain that does not verify is **ignored** and the read proceeds as a top-level one. Law: `engineering/wire_contract/WC-2026-11-04-rqo-source-callers.md` |
| `value` | `array` optional | Values to resolve (portal in search mode) |

Component instances can extend the source via `self.source_add`, an object that `create_source()` spreads onto the source so a model can inject extra read-API keys without touching the builder. (The `component_relation_model` `ar_target_section_tipo` case is the documented example, though no shipping caller currently populates `source_add` — the consumer is live, the producer is currently dormant.)

#### `source->action` modifiers

The **top-level `action` selects the API method**. `source->action` is a **secondary dispatch** consumed *inside* the method. Same top-level `read`, different per-element behavior:

| `source->action` | Behavior | Status |
|------------------|----------|-----------|
| `get_value` | Plain rendered component value — no context, no data (components only) | not dispatched in the `read` handler |
| `search` *(default)* | Section list/edit and `service_autocomplete`; persists the resolved SQO to the session for section edit/list/list_thesaurus | `readSection()` — session persistence via `setSessionSqo()`, see [request_config.md → Session override](request_config.md#session-override) |
| `related_search` | Inverse relations (sections pointing **to** the source) | not dispatched in the `read` handler under this label; the conceptually-equivalent inverse-reference engine (`search_related.ts`) is wired for `count`'s `mode:'related'` and the relation-list panel instead |
| `get_data` | Data-only for a single component/area; honors `matrix_id` / `data_source:'tm'` (time machine), pagination, `ar_target_section_tipo` | `readComponentData()` |
| `resolve_data` | Injects a `source->value` locator array into a component and resolves it (portals in search mode) | `resolveSearchData()` |
| `get_relation_list` | Legacy relation_list path | `buildRelationList()` (edit mode only) |

`save` ignores `source->action` and instead switches on **`source->type`**. Only `type:'component'` is implemented: the `save` handler + `saveComponentData()` check write permission (≥ 2) and apply `data->changed_data`. Any other type returns `result:false` — there is **no** `section` save case. Within a component save, the per-item operation comes from each `changed_data[].action`: `insert`, `update`, `remove`, `set_data`, `sort_data`, `sort_by_column`, `add_new_element`. In `search` mode the whole value replaces the datum.

The two **inserting** actions (`insert`, `add_new_element`) recompute the pagination of the echoed relation datum so the new item is revealed: the echo answers the **last page** — `offset = limit * (ceil(total/limit) - 1)`, or 0 when the list fits on one page — and the page size comes from the client's own `data->pagination->limit` when it sends one (that is how *show all* survives a save). Without this the echo is page one, and a client that reads "the last entry" as the new item picks the first record on a paginated portal (WC-081).

`add_new_element` additionally reports **`result->created_section_id`** — the `section_id` of the record it created in the target section. The key is present only when a record was really created; every other save omits it. Prefer it over inferring the new record from the echoed entries.

### sqo : `object` *Optional*

The Search Query Object — filter (`WHERE`-equivalent), `section_tipo` targets, `limit`, `offset`, `order`, `full_count`. Full definition in [sqo.md](sqo.md).

Security: the HTTP API is the only untrusted SQO source. `sanitize_client_sqo()` strips server-only fields (`sentence`, `params`, SQL column aliases...), forces `parsed=false` and clamps `limit` before the SQO reaches the search pipeline.

### show : `object` *Optional*

What to display and how — the layout of section lists and portal columns.

- **ddo_map** : `array` — chains of ddo objects (`{tipo, section_tipo, parent, mode, ...}`) linked by `parent` to form resolution paths. The server resolves each chain into context and data. A **portal's columns are sibling ddos** carrying `parent: <portal_tipo>` (+ `column_id`); a portal regenerates its *own* request_config server-side, so a nested `request_config`/`sqo` on a portal ddo is **not** honored — see the chain resolution in [dd_object.md](dd_object.md#how-a-ddo_map-resolves-the-chain). A per-ddo **`limit`** sets that component's *output pagination slice* (a portal loads all references then slices; `limit: 0` = all rows, the read equivalent of "show all").
- **get_ddo_map** : `object` *Optional* — compute the ddo_map dynamically from the ontology instead of listing it: `{model: 'section_map', columns: [...]}`. Lets different sections share common search/columns (mint, type, etc.).
- **fields_separator** / **records_separator** : `string` — used when values are flattened to strings (e.g. `" | "`, `"<br>"`).
- **sqo_config** : `object` — display-specific SQO tuning (`operator`, `limit`, `offset`, `full_count`).
- **interface** : `object` — UI element switches. <a id="show-interface"></a>This table is the **canonical home** for the `show.interface` controls; other docs link here rather than copying it.

| Key | Default | Controls |
|-----|---------|----------|
| `read_only` | `false` | Edit ability of the component |
| `save_animation` | `true` | Green save feedback line |
| `value_buttons` | `true` | Per-value buttons (edit, remove...) |
| `button_add` | `true` | Add-new-record button |
| `button_delete` | `true` | Delete button on portal rows |
| `button_delete_link` | `true` | "Unlink" option in the delete modal |
| `button_delete_link_and_record` | `true` | "Unlink and delete" option in the delete modal |
| `button_link` | `true` | Link-existing-record button |
| `button_edit` | `false` | Edit button in portals/sections |
| `button_edit_options` | — | `{action_mousedown: 'navigate'\|'open_window', action_contextmenu: 'navigate'\|'open_window'}` |
| `button_list` | `true` | Go-to-target-section button (e.g. component_radio_button) |
| `tools` | `true` | Component tools entry |
| `button_external` | `false` | Refresh button for external portal data |
| `button_fullscreen` | `true` | Fullscreen toggle |
| `button_save` | `true` | Save button |
| `button_tree` | `false` | Tree button |
| `show_autocomplete` | `true` | Record search autocomplete |
| `show_section_id` | `true` | section_id shown in edit buttons |

### search : `object` *Optional*

Fields available to the search process (used by `service_autocomplete` and the search panel). Same sub-shape as `show` (`ddo_map`, `get_ddo_map`, `sqo_config`, separators). Fallback chain: when `search` is defined it replaces `show` for searching; when `choose` is absent, `search` also drives the result list.

### choose : `object` *Optional*

Fields shown when picking a result in `service_autocomplete`. Same sub-shape. When defined, its `ddo_map` overrides `search`/`show` for the picker list. The server resolves `choose.sqo_config.limit` with the fallback chain *choose → search/show sqo_config → 25*.

### `hide` is a request_config-only block { #hide-is-a-request_config-only-block }

`hide` is **not** an RQO wire field: `rqoSchema` (`src/core/concepts/rqo.ts`) declares only `show`, `search` and `choose` blocks — there is no `hide` key to send, and one would be dropped. `hide` lives on the **request_config** side instead (`requestConfigItemSchema`): it is a `ddo_map` of elements whose context and data must be **resolved but not rendered** — internal values the caller component needs (e.g. `Location` [actv19](https://dedalo.dev/ontology/actv19)) — resolved server-side while building the element context, never carried on the RQO. See [request_config.md](request_config.md).

### data : `object` *Optional*

Request payload for write actions. For `save`, carries `changed_data` (the modified values); also used as pre-calculated container (datalist, pagination) to avoid recomputation.

### options : `object` *Optional*

Heterogeneous extra parameters for components and tools — e.g. upload descriptors:

```json
{
	"options": {
		"file_data": { "name": "test26_test3_1.jpg", "tmp_dir": "DEDALO_UPLOAD_TMP_DIR", "key_dir": "3d", "tmp_name": "tmp_test26_test3_1.jpg" },
		"target_dir": "posterframe"
	}
}
```

Files POSTed as `multipart/form-data` (e.g. image upload) never reach the RQO path at all: `src/server.ts` routes that content type to a separate handler (`handleMediaUpload()`, `src/core/media/ingest/upload_endpoint.ts`) before any JSON parsing runs. That handler reads the session from the request cookie and the CSRF token from the `X-Dedalo-Csrf-Token` header (with a form-field fallback).

### prevent_lock : `bool` *Optional*

Accepted on the wire but **deliberately INERT** (`src/core/concepts/rqo.ts`) — sessions are an in-memory/SQLite store, not file-locked per request, so there is nothing for this flag to prevent. The client and the MCP write tools still set it; the server neither needs nor honors it. Unrelated to the component EDIT locks (`src/core/section/locks.ts`, the soft-lock focus/blur mechanism) despite the similar name.

### pretty_print : `bool` *Optional*

Pretty-printed JSON response (debugging).

## Use cases and examples

### Read one record in edit mode

```json
{
	"action" : "read",
	"dd_api" : "dd_core_api",
	"source" : { "typo":"source", "type":"section", "action":"search", "model":"section",
		"tipo":"oh1", "section_tipo":"oh1", "section_id":3, "mode":"edit", "lang":"lg-eng" },
	"sqo"    : { "section_tipo":["oh1"], "limit":1, "offset":0,
		"filter_by_locators":[{"section_tipo":"oh1","section_id":3}] }
}
```

### Save a component value

```json
{
	"action" : "save",
	"dd_api" : "dd_core_api",
	"source" : { "typo":"source", "type":"component", "action":null, "model":"component_input_text",
		"tipo":"oh16", "section_tipo":"oh1", "section_id":124, "mode":"edit", "lang":"lg-eng" },
	"data"   : { "changed_data": [ {"action":"update","id":1,"key":0,"value":{"id":1,"lang":"lg-eng","value":"Interview about..."}} ] }
}
```

`save` dispatches on `source->type` (only `component` is implemented), instantiates the element and applies `data->changed_data`. `oh16` here is a `component_input_text`. The per-value operation is `changed_data[].action` (`update` shown; also `insert`, `remove`, `set_data`, `sort_data`, `sort_by_column`, `add_new_element`). The `value` of an `update`/`insert` is ONE value item (an object — never a bare string), and a `set_data` value is an array of them; any other shape is refused with `request.invalid_data` and nothing is written (see [value items](./data_model/value_item.md)).

### Autocomplete search (service_autocomplete)

```json
{
	"action" : "read",
	"dd_api" : "dd_core_api",
	"source" : { "typo":"source", "type":"component", "action":"search", "model":"component_portal",
		"tipo":"rsc17", "section_tipo":"oh1", "section_id":3, "mode":"edit", "lang":"lg-eng" },
	"sqo"    : { "section_tipo":["rsc197"], "filter":{"$or":[{ "q":"smith", "path":[{ "section_tipo":"rsc197","component_tipo":"rsc85" }] }]},
		"limit":25, "offset":0 },
	"search" : { "ddo_map":[ {"tipo":"rsc85","section_tipo":"rsc197","parent":"rsc197","mode":"list"} ] },
	"choose" : { "ddo_map":[ {"tipo":"rsc85","section_tipo":"rsc197","parent":"rsc197","mode":"list"} ], "fields_separator":" | " }
}
```

Note the dispatch split: the top-level `action` is `read` (it must be in `dd_core_api::API_ACTIONS`); the *search* behavior comes from `source->action: 'search'`. Built client-side by `build_rqo_search()` from the component's `request_config` (operator default `$or`, choose limit fallback 25).

### Count without blocking the session

```json
{
	"action" : "count",
	"dd_api" : "dd_core_api",
	"prevent_lock" : true,
	"source" : { "typo":"source", "type":"section", "model":"section", "tipo":"oh1", "section_tipo":"oh1", "mode":"list" },
	"sqo"    : { "section_tipo":["oh1"], "filter": null }
}
```

### Component value only (source->action modifier)

```json
{
	"action" : "read",
	"dd_api" : "dd_core_api",
	"source" : { "typo":"source", "type":"component", "action":"get_value", "model":"component_select",
		"tipo":"oh37", "section_tipo":"oh1", "section_id":3, "mode":"list", "lang":"lg-eng" }
}
```

Same top-level `action` (`read`), different per-element behavior: `source->action:'get_value'` short-circuits to the plain value.

### Tool execution

```json
{
	"action" : "tool_request",
	"dd_api" : "dd_tools_api",
	"prevent_lock" : true,
	"source" : { "typo":"source", "type":"tool", "action":"get_export_grid", "model":"tool_export",
		"tipo":"oh1", "section_tipo":"oh1", "mode":"list" },
	"options": { "section_tipo":"oh1", "data_format":"csv", "breakdown":"default", "ar_ddo_to_export":[ "..." ] }
}
```

The generic `tool_request` action routes to `{source->model}::{source->action}(options)` — here `tool_export::get_export_grid()`. Tool methods are additionally gated by each tool's `API_ACTIONS` registration (see tools docs).

### Create a new record

```json
{
	"action" : "create",
	"dd_api" : "dd_core_api",
	"source" : { "typo":"source", "type":"section", "model":"section", "tipo":"oh1", "section_tipo":"oh1", "mode":"list" }
}
```

Inserts an empty row and returns the new id: `{"result":"128", ...}`. Requires section write (≥ 2). The canonical "new record" flow is then a `read` in edit mode filtered by that id:

```json
{
	"action" : "read",
	"dd_api" : "dd_core_api",
	"source" : { "typo":"source", "type":"section", "action":"search", "model":"section",
		"tipo":"oh1", "section_tipo":"oh1", "section_id":128, "mode":"edit", "lang":"lg-eng" },
	"sqo"    : { "section_tipo":["oh1"], "limit":1, "offset":0,
		"filter_by_locators":[{"section_tipo":"oh1","section_id":128}] }
}
```

### Duplicate a record

```json
{
	"action" : "duplicate",
	"dd_api" : "dd_core_api",
	"source" : { "typo":"source", "type":"section", "model":"section", "tipo":"oh1", "section_tipo":"oh1", "section_id":2, "mode":"list" }
}
```

Deep-copies record `2` and returns the new `section_id`. Two gates apply: section write (≥ 2) **and** `assert_record_in_user_scope()` (a write user outside the source record's project scope cannot clone it).

### Delete records (mode and flags)

```json
{
	"action" : "delete",
	"dd_api" : "dd_core_api",
	"source" : { "typo":"source", "action":"delete", "model":"section", "tipo":"oh1",
		"section_tipo":"oh1", "section_id":null, "mode":"list", "lang":"lg-eng",
		"delete_mode":"delete_record" },
	"options": { "delete_diffusion_records":true, "delete_with_children":false },
	"sqo"    : { "section_tipo":["oh1"], "filter_by_locators":[{"section_tipo":"oh1","section_id":127}], "limit":1 }
}
```

Target rows come from `sqo` (preferred, multi-record) or `source->section_id`. Note the placement: `delete_mode` (`delete_data` keeps the row skeleton / `delete_record` removes the whole row) lives on **`source`**, while `delete_diffusion_records` and `delete_with_children` live on **`options`**. Section model only, write (≥ 2).

### Element context without data (lazy load)

```json
{
	"action" : "get_element_context",
	"dd_api" : "dd_core_api",
	"source" : { "typo":"source", "type":"component", "model":"component_input_text",
		"tipo":"oh16", "section_tipo":"oh1", "section_id":3, "mode":"edit", "lang":"lg-eng" },
	"simple" : true
}
```

Returns only the structure context (no data) for one element — used to lazily fetch a component's context after a list renders. `simple:true` selects the lightweight context builder. Pairs with `get_section_elements_context` for the search panel's field list.

### Time-machine read (data_source: tm)

```json
{
	"action" : "read",
	"dd_api" : "dd_core_api",
	"prevent_lock" : true,
	"source" : { "typo":"source", "type":"component", "action":"get_data", "model":"component_input_text",
		"tipo":"oh16", "section_tipo":"oh1", "section_id":3, "mode":"tm", "lang":"lg-eng",
		"data_source":"tm", "matrix_id":"45012" }
}
```

`source->action:'get_data'` + `data_source:'tm'` addresses a specific historical matrix row (`matrix_id`) through the time-machine service (section `dd15`, `DEDALO_TIME_MACHINE_SECTION_TIPO`). Service models are exempt from the normal section permission gate.

### Paginated next page (session SQO continuity)

```json
{
	"action" : "read",
	"dd_api" : "dd_core_api",
	"prevent_lock" : true,
	"source" : { "typo":"source", "type":"section", "action":"search", "model":"section",
		"tipo":"oh1", "section_tipo":"oh1", "mode":"list", "lang":"lg-eng" },
	"sqo"    : { "section_tipo":["oh1"], "limit":10, "offset":10,
		"order":[{"direction":"ASC","path":[{"component_tipo":"section_id"}]}] }
}
```

Advancing `offset` requests the second page. The server persists the resolved SQO into the session after every list/edit read (`setSessionSqo()`) and exposes the previous value back as `sqo_session` on the section context — but the client is still responsible for resending its filter/window on each call; there is no automatic server-side replay if it omits one (see [request_config.md → Session override](request_config.md#session-override)).

### Multi-clause search-panel filter

```json
{
	"action" : "read",
	"dd_api" : "dd_core_api",
	"source" : { "typo":"source", "type":"section", "action":"search", "model":"section",
		"tipo":"oh1", "section_tipo":"oh1", "mode":"list", "lang":"lg-eng" },
	"sqo"    : { "section_tipo":["oh1"], "limit":10, "offset":0,
		"filter":{ "$and":[
			{ "q":"interview", "path":[{"section_tipo":"oh1","component_tipo":"oh16"}] },
			{ "$or":[
				{ "q":"1975", "path":[{"section_tipo":"oh1","component_tipo":"oh25"}] },
				{ "q":"1976", "path":[{"section_tipo":"oh1","component_tipo":"oh25"}] }
			] }
		] } }
}
```

A search-panel filter with several clauses across component paths combined with `$and`/`$or`. The `filter` grammar is the SQO's — see [sqo.md](sqo.md#filter).

### Raw matrix rows for export (read_raw)

```json
{
	"action" : "read_raw",
	"dd_api" : "dd_core_api",
	"prevent_lock" : true,
	"source" : { "typo":"source", "type":"section", "model":"section", "tipo":"oh1", "section_tipo":"oh1", "mode":"list" },
	"options": { "type":"section" }
}
```

Returns unrendered JSONB straight from the matrix table — `options->type` selects `section` (full rows), `component` (one component's datum per row) or `target_section` (relation locators matching `options->tipo`). Used by `tool_export`.

### Relation targets of a search (relation_targets)

```json
{
	"action" : "relation_targets",
	"dd_api" : "dd_core_api",
	"options": {
		"source": {
			"section_tipo"        : ["oh1"],
			"filter_by_locators"  : [{"section_tipo":"oh1","section_id":3}],
			"from_component_tipo" : "oh24"
		}
	}
}
```

`options.source` is exactly the source set of a [`referenced_by` filter leaf](sqo.md#relationship-filter-leaves-referenced_by) — same keys, same refusals, same nesting limit. The client builds it once and reuses it verbatim as `{"referenced_by": source}` in the filter of each window it opens, so the counts and the windows cannot disagree. The example asks for the records the `Informants` portal ([oh24](https://dedalo.dev/ontology/oh24)) of `Oral History` record 3 ([oh1](https://dedalo.dev/ontology/oh1)) points at; without `from_component_tipo` every component of the source counts.

The response lists one entry per target section, ordered by tipo, with the section label in the request language:

```json
[ { "tipo": "rsc197", "label": "People", "total": 2 } ]
```

The locators are read from the source records' own stored `relation` column, as the `referenced_by` leaf reads them (not from the relation index), so any section with a record table can be a source, log sections included. The census reads the source records' locators once, whatever the number of targets: a grouped pass over them finds the candidate target sections (keeping only those that have a record table and that the user can read), then one statement computes every candidate's exact total. Each `total` is exact: it is the count the opened window would show, with the access rules of the target section already applied. Targets with no record left after those rules are omitted; an empty array means there is nothing to open.

Refusals: `perm.denied` without read access on a source section (the source is authorized as a read); `request.invalid_options` for a malformed source; `request.invalid_tipo` for an invalid tipo or a source section with no record table; `db.statement_timeout` (503) when the census runs past its budget. The budget is one deadline for the whole census, 30 seconds (lower if the server's `DB_STATEMENT_TIMEOUT_MS` is lower): before each statement the server allows only the time left, so the statements together never exceed it. The client waits 35 seconds before giving up, longer than the budget plus a response margin, so the typed refusal reaches the dialog first. When the user's component permissions hide some relation components of the source, the response carries a `perm.out_of_scope` notice and those locators are not counted.

### Batch term labels for a graph (get_section_terms)

```json
{
	"action" : "get_section_terms",
	"dd_api" : "dd_core_api",
	"prevent_lock" : true,
	"source" : { "typo":"source", "type":"section", "model":"section", "tipo":"oh1", "section_tipo":"oh1", "mode":"list" },
	"locators": [
		{"section_tipo":"oh1","section_id":3},
		{"section_tipo":"rsc197","section_id":12}
	]
}
```

Resolves authoritative section_map term labels for up to 1000 locators in one call (graph node labels); the result is keyed `"{section_tipo}_{section_id}" => term`. Unreadable/invalid locators are skipped silently.

## Response shapes by action

The envelope is always `{ok, request_id, data | error, notices?, csrf_token}`; only the **shape of `data`** varies. Quick reference (full detail in the action table above):

| Action | `data` on success |
|--------|---------------------|
| `read` (`search`/`get_data`/...) | `{context: [...], data: [...]}` |
| `read` (`get_value`) | the plain rendered component value |
| `read_raw` | `array` of raw JSONB rows (+ `response.table`) |
| `relation_targets` | `[{tipo, label, total}]` (empty array = no targets) |
| `count` | `{total: <int>}` (or `0` on permission denial) |
| `create` / `duplicate` | `<new section_id>` (int) or `false` |
| `delete` | object forwarded from `sections::delete()` |
| `save` | `{context, data}` of the refreshed element, or `false` |
| `get_element_context` | a single context `object` |
| `get_section_elements_context` | `array` of component contexts |
| `get_environment` | `{page_globals, plain_vars}` |
| `get_section_terms` | `{ "<tipo>_<id>": "<term>", ... }` |

On failure the body is the envelope v2 failure shape (`engineering/ERRORS_SPEC.md`
§3): `ok:false`, `request_id`, and `error: {code, category, message, label_key,
retryable, details?}` — the HTTP status is the code's registry status (never
2xx). Nothing else is on the body: the previous `result:false` / `msg` /
`errors` mirror was removed on 2026-08-16.

!!! warning "`error.code` is the machine channel; `message` is the prose"
    Two codes are load-bearing, and for the same reason:

    - **`auth.not_logged`** answers HTTP **401** whenever the session is absent
      or expired (`auth.maintenance` for a non-root caller under maintenance
      mode); the client's `CORE_POLICY` raises the in-place re-login modal.
    - **`perm.denied`** answers HTTP **403** on every authorization refusal
      (a thrown `DedaloError('perm.denied')` — no handler builds a failure body,
      which `test/unit/error_taxonomy_tripwire.test.ts` enforces); the client
      renders the localized "no permission" page from it.

    The human sentence lives in `error.message` (registry English, or a vetted
    `publicMessage` for public-disclosure codes) — never in the code. A client
    consuming 401 or 403 must read the envelope rather than treating the status
    as a transport failure: both are ANSWERS, and retrying either is
    meaningless. See [login](system/login.md) and
    [security](system/security.md).

## RQO and request_config

The RQO and the [request_config](request_config.md) are the two halves of the same contract:

- **request_config = configuration** (server → client). Defined in ontology `properties->source->request_config` (or user layout presets), resolved per element and injected into the element's context. It declares *what an element can request*: target sections, ddo_maps for show/search/choose/hide, sqo defaults, interface switches.
- **RQO = request** (client → server). The client builds it *from* the request_config: `build_rqo_show()`/`build_rqo_search()` copy the sqo/sqo_config/ddo_maps into a concrete call, adding the live state (current filter, page, query string).

Because the ontology cannot know installation-specific values, the request_config uses placeholders that are resolved server-side before reaching the client — `section_tipo: "self"`, `parent: "self"`, dynamic `sqo.section_tipo` sources (`section`, `hierarchy_types`, `ontology_sections`, `field_value`, `self`). By the time the client builds an RQO, those are concrete tipos. The full `section_tipo` source vocabulary and the self-resolution contract are defined in [request_config.md](request_config.md).

The reverse path also exists: when a client sends `rqo->show` (e.g. time machine, `tool_qr`, graph view, search presets), the server rebuilds part of the element's request_config **from the RQO**. The targeted element builds its config from the request (`relations/request_config/from_rqo.ts`, validated against the client grammar); elements below it take the children the request's map declares for them, per slot and per engine (`relations/request_config/caller_injection.ts`). Data and context are both projections of that one resolved element node — see [request_config.md → RQO-derived narrowing](request_config.md#rqo-derived-narrowing-the-reverse-path-partial).

## Security model summary

`rqoSchema.safeParse()` (schema validation, `src/server.ts`) runs first, followed by `dispatchRqo()`'s ordered gates (`src/core/api/dispatch.ts`):

| Order | Gate | Mechanism | Protects |
|-------|------|-----|----------|
| 1 | CORS origin check | not implemented as a named gate — confirm the reverse-proxy layer's posture before exposing the server directly to a browser origin different from its own | `Access-Control-Allow-Origin` echoed only for an allowed origin |
| 2 | Body validation | `rqoSchema.safeParse()` (`src/core/concepts/rqo.ts`) rejects the WHOLE malformed body up front; `ddoMapSchema`'s strict `.strip()` whitelists `show`/`search`/`choose` ddos as a side effect of that same parse; `sanitizeClientSqo()` (`src/core/concepts/sqo.ts`) additionally scrubs `rqo.sqo` | Server-only SQO fields, unbounded limits, pre-parsed SQL, injected ddo fields beyond the display whitelist |
| 3 | `dd_api` + `action` allowlist | `dispatchRqo()` gate 1: `ACTION_REGISTRY[dd_api]?.[action]` — ONE explicit lookup; a missing/non-string `action` fails the same lookup; there is no reflection fallback, so an unregistered pair is unreachable by construction | Only known (class, action) pairs are callable |
| 4 | Error-report intake window | gate 1c: an error-report action requires the receiver enabled + an allowed caller IP | The pre-auth intake stays closed outside its intended window |
| 5 | Login + no-login allowlist | `dispatchRqo()` gate 2: `NO_LOGIN_ACTIONS` (`src/core/api/dispatch.ts`), keyed on the `dd_api:action` pair | Session required except the no-login actions |
| 6 | CSRF token | `dispatchRqo()` gate 3: `CSRF_EXEMPT_ACTIONS` (`src/core/api/dispatch.ts`) — `verifyCsrf()` constant-time compare; on failure the response carries `errors:['csrf_failed']` plus the session's current token so the client's one-shot retry can succeed | Cross-site request forgery |
| 7 | Maintenance permission | not a separate dispatch-level gate — each `dd_area_maintenance_api` handler (`widget_request`, `get_widget_value`, `lock_components_actions`) resolves the principal and checks permission itself, inside the handler | `dd_area_maintenance_api` requires maintenance-area perm ≥ 2 |
| 8 | Permission checks | per handler in `ACTION_REGISTRY` (`getPermissions()`, `src/core/security/permissions.ts`); handlers return a `denied()` `ApiResult` directly | Section/element access levels |

`NO_LOGIN_ACTIONS` and `CSRF_EXEMPT_ACTIONS` are keyed on the exact `${dd_api}:${action}` pair (so a same-named action on a different class does not inherit an exemption) and are **not identical**: every no-login action is also CSRF-exempt (the first call has no token yet), but `dd_utils_api:get_dedalo_files` is CSRF-exempt while still requiring a session — a service-worker call that is read-only but authenticated. Check the two `Set`s in `src/core/api/dispatch.ts` directly before relying on either.

!!! note "Known asymmetry"
	`choose.ddo_map` is validated through the same strict `ddoMapSchema` as `show`/`search` — all three blocks share one schema (`rqoDdoBlockSchema`), so there is no separate treatment for `choose`.

## Best practices

1. **Build RQOs from the request_config** the server injected — don't hand-craft sqo/ddo_maps in client code when the config already defines them (`build_rqo_show`/`build_rqo_search`).
2. **Always send `source` complete** (`tipo`, `section_tipo`, `mode`, `lang`): the server resolves defaults from it and `read` rejects an empty `section_tipo`.
3. **Use `prevent_lock: true`** for read-only calls that may run long (counts, exports preflight) so they don't serialize the user's session.
4. **Let the server own limits**: send `limit: null` to get the mode/model default; client limits are clamped server-side anyway.
5. **Use `source->action` modifiers** instead of new top-level actions when the behavior is a variant of read/save for one element type.
6. **New API methods must be registered in `ACTION_REGISTRY`** (`src/core/api/dispatch.ts`) — they are unreachable otherwise; there is no reflection fallback.
7. **Never put credentials or server-only state in an RQO**: the object is logged in debug environments and echoed in error contexts.

## Troubleshooting

- **`Invalid RQO`** (HTTP 400) — the body failed `rqoSchema.safeParse()`; the response `errors` array carries the zod issue list — check the exact field/path it names.
- **`Undefined or unauthorized method (action)`** — the `(dd_api, action)` pair is not registered in `ACTION_REGISTRY` (`src/core/api/dispatch.ts`) — check for a typo, or that the action is actually in the registry (see the `dd_api`/`action` tables above).
- **`Empty source 'section_tipo'`** — `read` requires it; verify `create_source()` received a fully initialized instance.
- **Empty result with no error** — likely a dropped/failed ddo resolution (invalid tipo, inactive TLD, no permissions) inside `processSingleDdo()` (`src/core/relations/request_config/explicit.ts`). There is no warnings field to inspect — step through the builder/read path directly.
- **Stale list after editing** — the server persists the resolved SQO into the session (`setSessionSqo()`) but does not replay it automatically; verify the client is actually resending the filter/limit it should on the follow-up call, and check the client local-DB cache (`cache_handler`).
- **CSRF errors on first call** — the token is minted on `start`/`login` and appended to every authenticated response's `csrf_token` field (`dispatchRqo()`); ensure the bootstrap call ran. The client retries a `csrf_failed` rejection once automatically — the CSRF-failure response carries the session's CURRENT token specifically so that retry can succeed.
- **`Authentication required` on an action you expected to be public** — check `NO_LOGIN_ACTIONS` in `src/core/api/dispatch.ts` directly for the exact `dd_api:action` pair. The response is a 401 carrying `error.code: 'auth.not_logged'`; if you get it on an action that *should* need a session, the session simply expired — see [login](system/login.md) for the two clocks.
- **`save` silently did nothing** — only `source->type:'component'` is implemented. Check `source->type` and that each `changed_data[].action` is a recognized operation.
- **Picker columns (`choose.ddo_map`)** — `choose` validates through the same strict `ddoMapSchema` as `show`/`search` at the `rqoSchema.safeParse()` boundary — a `choose` ddo with a non-whitelisted field is silently stripped of that field, not rejected outright.

## Related documentation

- [request_config.md](request_config.md) — the server-side config build (explicit/implicit, self-resolution, the `section_tipo` source vocabulary, caching, presets) that produces what the client turns into RQOs
- [request_config_examples.md](request_config_examples.md) — the ontology `request_config` JSON cookbook (section list/edit, portals, autocomplete, fixed filters, dynamic ddo_map...)
- [sqo.md](sqo.md) — the Search Query Object (filter/limit/order) carried inside the RQO
- [dd_object.md](dd_object.md) — the DDO (one ddo_map entry / column) field set
- `src/core/concepts/rqo.ts` — the `Rqo`/`RqoSource` zod schemas + `ApiResponse` envelope shape
- `src/core/api/dispatch.ts` — `dispatchRqo()`, the `ACTION_REGISTRY`, `NO_LOGIN_ACTIONS`/`CSRF_EXEMPT_ACTIONS`
- `core/common/js/common.js` — client builders (`create_source`, `build_rqo_show`, `build_rqo_search`)
- `core/common/js/data_manager.js` — client transport (retries, timeout, CSRF, local cache) — copied as-is
