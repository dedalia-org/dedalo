# tool_diffusion

Publishing UI for a section: inspects the section's diffusion configuration and drives the publish/unpublish of its records to the configured diffusion targets (SQL / RDF / XML / Markdown / CSV / JSON) through the [diffusion engine](../../../diffusion/native_engine.md). UI-only, available only on sections that have a diffusion definition.

## What it does / why & when to use it

`tool_diffusion` is the operator-facing front end of the **diffusion** subsystem — the machinery that copies *work* data out of Dédalo into one or more *published* targets (a MariaDB database read by a public website, an RDF graph, XML or Markdown files…). The tool does not itself transform or write data; it reads the section's diffusion definition from the ontology, shows the subsystem's health and the publishing controls, and then asks the **diffusion engine** to run the publish for the records the user has selected.

It is deliberately a thin, read-and-launch panel: every actual data operation is owned by the diffusion engine and `dd_diffusion_api`, never by this tool (which has **no server module — and no remotely callable methods — at all**).

Concrete heritage scenario: an oral-history archive keeps its master interviews, informants and indexation in Dédalo, and serves them on a public site backed by a published MariaDB database. A cataloguer finishes correcting a batch of *Interviews*, filters that list, opens the diffusion tool on it, sets **depth levels** to 2 (so each interview is published together with the informant and place records it links to through portals), and presses *Publish the N selected records*. The tool streams progress as the engine resolves and writes each record group, then shows a per-table result (rows affected, time, success / partial / fail). If a record had previously been deleted while a target was offline, the panel also surfaces the count of **pending deletions** with a *Retry* button so the operator can re-attempt that delete propagation.

Use it when: someone needs to publish (or re-publish) a section's records to the live diffusion target(s), check whether the diffusion engine is reachable, tune how many relation *levels* get published with each record, or clear pending delete-propagations. It does **not** appear on sections that have no diffusion definition, and never on individual components.

## How it works (server + client)

**Server.** `tools/tool_diffusion/` ships **no `server/` package** — confirmed client-only (the loader finds no `server/index.ts` to load, so `dd_tools_api.tool_request` would refuse any action named against this tool with `tool has no server module`, dispatch gate 5). One lifecycle hook is still honored, though: because there is no loaded module to delegate to, `getElementTools` (`src/core/tools/registry.ts`) resolves this tool's availability with the **one core fallback rule left** in the registry (every other tool's availability is answered by its own module's `isAvailable` hook — e.g. `tool_time_machine`'s):

```ts
// src/core/tools/registry.ts::toolIsAvailable
if (name === 'tool_diffusion') {
	if (context.isComponent) return false; // components are never in the diffusion map
	const { haveSectionDiffusion } = await import('../resolve/diffusion_map.ts');
	return haveSectionDiffusion(context.tipo);
}
```

`haveSectionDiffusion()` is called for every candidate element by the section/component tool filter. It hides the tool on components, and on sections it looks up an entity-level *section→diffusion* map precomputed from the flat virtual diffusion tree. The result is cached per user/tipo/section, same as every other tool's availability answer.

Because the tool has no server module, none of the publish work goes through `dd_tools_api` / `tool_request` on the TS side either — `register.json` (a column-keyed dump) exists only to (a) surface the button on the right sections and (b) carry the registry record (version, label, localized UI labels).

**Client (JS).** `tools/tool_diffusion/js/` holds the real behavior:

- `tool_diffusion.js` is the instance. It extends the standard `tool_common` lifecycle (`init` / `build` / `render` / `edit`). On `build()` it fetches three things in parallel — the section's diffusion info, the subsystem's health advisory and the active processes — and resolves the default *resolve_levels* and *skip_publication_state_check* from the returned config.
- `render_tool_diffusion.js` builds the DOM: the engine status banner, the depth-levels input (persisted in `localStorage` as `diffusion_levels`, with an info modal explaining the exponential cost of more levels), the *skip publication-state check* toggle, the publish button, a streamed per-table result panel, and the pending-deletions row with its *Retry* button. The tool opens **as a modal** (`on_close_actions('modal')` destroys the instance; it deliberately never refreshes the caller, which is a `component_json`).

Critically, every server call the client makes targets the **diffusion API class**, not the tools API: `data_manager.request(...)` (or `request_stream(...)` for the publish) with `dd_api: 'dd_diffusion_api'`. Those actions are served by the main work API dispatcher (`src/core/api/dispatch.ts`), where the [diffusion engine](../../../diffusion/native_engine.md#client-compatibility) registers the full action set.

## Actions & options

`tool_diffusion` itself exposes **no** API actions:

| `apiActions` | Form | Notes |
| --- | --- | --- |
| *(no server module)* | — | UI-only tool, no server package. No method is dispatchable through `dd_tools_api`; a `tool_request` naming this tool is refused at dispatch gate 5 (`tool has no server module`). There is **no** `backgroundRunnable`. |

Availability rule (resolved by `registry.ts`'s one core fallback, since there is no module `isAvailable` hook to delegate to — see *How it works* above):

| Rule | Reads | Effect |
| --- | --- | --- |
| `tool_diffusion` core fallback | `context.isComponent`, `context.tipo` | Returns `false` for components; on sections returns `haveSectionDiffusion(tipo)`. Decides whether the tool button renders on the element. |

All operational work is performed by **`dd_diffusion_api`**, registered in `src/core/api/dispatch.ts` with the full native action set — `diffuse`, `get_process_status`, `list_processes`, `cancel_process`, `get_diffusion_info`, `get_engine_advisory`, `retry_pending_deletions`, `validate`, `rebuild_media_index` (see [The diffusion engine → Client compatibility](../../../diffusion/native_engine.md#client-compatibility); it is a separate subsystem from the tools machinery covered here). The client methods of `tool_diffusion.js` and the diffusion-API actions they call:

| Client method | `dd_diffusion_api` action | Transport | Key request fields | Purpose |
| --- | --- | --- | --- | --- |
| `get_diffusion_info()` | `get_diffusion_info` | `request` | `options.section_tipo` | Per-section diffusion config used to build the UI (default `resolve_levels`, `skip_publication_state_check`, available diffusion elements/types). |
| *(status banner)* | `get_engine_advisory` | `request` | — | Diffusion subsystem health (there is no separate engine process to be "down" — the advisory reports the native subsystem's readiness per format). |
| `get_active_processes()` | `list_processes` | `request` | — | Currently running diffusion processes (from the durable job queue, 24 h window; supports reconnect-by-label). |
| `export(options)` | `diffuse` | `request_stream` (SSE) | `sqo` (selection); `options.levels`, `skip_publication_state_check`, `additions_options`, `total`, `process_id`, `diffusion_element_tipo`, `diffusion_tipo`, `type` | Enqueues the publish job for the selected records and streams progress/results. In `edit` mode the SQO targets the single record; in list mode it reuses the caller's `rqo.sqo`. |
| `retry_pending_deletions(options)` | `retry_pending_deletions` | `request` | `options.count_only` (badge count vs. retry), `options.limit` | Re-attempts delete propagation for records whose deletion never reached a target (dd1758 `unpublish_pending` rows). |

> The `diffuse` request is built around a **SQO** (the search query object describing which records to publish). In `edit` mode it is a single-record SQO (`limit: 1`, `filter_by_locators`); in list mode it reuses `self.caller.rqo.sqo`, i.e. the user's current section selection/filter.

### Excluding diffusion elements (`EXCLUDE_DIFFUSION_ELEMENTS`)

An installation can withdraw diffusion elements from publication with one key of the tool's configuration: `EXCLUDE_DIFFUSION_ELEMENTS`, a list of diffusion element tipos, set in the **Tools configuration** record (dd996) of `tool_diffusion` (`{"EXCLUDE_DIFFUSION_ELEMENTS": ["<element tipo>"]}`, or the `{"value": [...]}` option form). It is read per request through `getToolConfigValue` (`src/diffusion/api/excluded_elements.ts`), and every door that starts a publication run checks it:

| Action | Effect of a listed element |
| --- | --- |
| `get_diffusion_info` | Its panels are omitted from `section_diffusion_nodes`. |
| `diffuse` | Refused before anything is queued, with `diffusion.element_excluded` (HTTP 403). A hidden panel is not the guard: a request naming the tipo by hand is refused too. |
| `requeue_job` (diffusion server control, maintenance) | Refused with `diffusion.element_excluded` before the job row is touched. |
| Stale-run sweeper (a run whose runner was lost) | Not re-queued: the job is marked failed with `diffusion.element_excluded` (logged), instead of starting again. |

An element matches when its own tipo is listed or, for a `diffusion_element_alias`, when the real element it resolves to is listed — so listing a real element also withdraws its aliases. A value that is not a list of non-empty strings makes every one of these refuse with `tool.config_invalid` (HTTP 503 — a fault of the installation's configuration, not of the request) until it is fixed — the sweeper fails every lost run with that code meanwhile; it is never read as "nothing excluded". A job that was already queued before the element was listed is not re-checked: the runner runs it as queued. Delete propagation and `retry_pending_deletions` are not affected: records already published can always be unpublished. A v6 installation's `EXCLUDE_DIFFUSION_ELEMENTS` define is moved into this key by the configuration migration ([Migrating from v6](../../../install/migrating_from_v6.md)).

## How it is registered & surfaced

`tools/tool_diffusion/register.json` is a **column-keyed dump** (`string`/`relation`/`misc`/… keyed by component tipo — a seeded matrix-row snapshot, not a hand-authored file); `importTools()` passes it through as-is (see [register.json reference](../register_json.md)). The essentials it carries:

- `dd1326` name = `tool_diffusion`; `dd1327` version (`2.0.5`); `dd1328` minimum Dédalo version (`6.0.0`); `dd1644` developer (`Dédalo team`); `dd612` description.
- `dd799` label = *Diffusion* (localized across all project languages).
- `dd1372` labels supply the localized UI strings the client reads via `get_tool_label(...)`: `depth_levels`, `levels_note`, `publish_selected_records`, `skip_publication_state_check`, `combine_xml_files`, `diffusion_result`, `table_name`, `records_affected`, `total_time`, `success`, `partial_success`, `fail`, `rows_total`, `pending_deletions`, `retry`.

**Where it appears.** Unlike most tools, surfacing is **not** driven by `affected_models` here — this register.json does not carry `affected_models` / `show_in_inspector` / `show_in_component` / `properties`. The button is gated entirely by the availability rule above: it renders on a **section** if and only if that section has a diffusion definition in the ontology (and never on components). The tool opens **as a modal**. Profile authorization applies as for any tool (superusers see it; otherwise it must be granted on the profile's Tools).

## Examples

The tool is UI-only, so there is no `tool_request` to `tool_diffusion`. The load-bearing calls are the diffusion-API requests the client issues. Building the per-section config request (as in `get_diffusion_info()`):

```js
// Resolve the section's diffusion configuration to build the panel
const rqo = {
    dd_api  : 'dd_diffusion_api',
    action  : 'get_diffusion_info',
    source  : create_source(self, 'get_diffusion_info'),
    options : { section_tipo : self.caller.section_tipo }
}
const response = await data_manager.request({ body: rqo }) // → the main work API
// response.result → { resolve_levels, skip_publication_state_check, … }
```

Launching a publish for the current selection and streaming progress (as in `export()`):

```js
const rqo = {
    dd_api  : 'dd_diffusion_api',
    action  : 'diffuse',
    source  : create_source(self, 'diffuse'),
    sqo     : self.caller.rqo.sqo,        // records to publish (the list selection)
    options : {
        levels                       : self.resolve_levels,            // depth: 1 = this section only
        skip_publication_state_check : self.skip_publication_state_check,
        diffusion_element_tipo       : item.element_tipo,
        diffusion_tipo               : item.diffusion_tipo,
        type                         : item.type                       // 'sql' | 'rdf' | 'xml' | 'markdown' | …
    }
}
const stream = await data_manager.request_stream({ body: rqo })
// render_stream(stream) → live per-table results: rows affected, time, success/partial/fail
```

Reading just the pending-deletion badge count:

```js
await self.retry_pending_deletions({ count_only: true })  // → { result, count }
```

## Related

- [Creating new tools](../creating_tools.md) — the end-to-end tool tutorial.
- [Server contract](../server_contract.md) — the `ToolServerModule` contract; note the lifecycle-hook rule (`isAvailable` is never listed in `apiActions`).
- [Tools catalog](index.md) — index of all per-tool reference pages.
- [`tool_export`](tool_export.md) — the *other* way data leaves Dédalo: a user-shaped flat-table export (CSV/spreadsheet/raw round-trip) rather than publishing to a live target. See also the core guide [Exporting data](../../../using/exporting_data.md).
- Diffusion subsystem core docs: [Diffusion (system overview)](../../../core/system/diffusion.md), [The diffusion engine](../../../diffusion/native_engine.md), [Diffusion data flow](../../../diffusion/diffusion_data_flow.md), [Markdown diffusion](../../../diffusion/diffusion_markdown.md).
