# tool_propagate_component_data

Batch replace / add / delete of a single component's data across every record matched by a search query object (SQO), tracked as one bulk process for audit and time-machine reversion.

## What it does / why & when to use it

`tool_propagate_component_data` takes the value the user has just composed in one component and **propagates it to the same component across many records at once** — the whole filtered selection of the current section. It is the bulk-edit counterpart to editing a single record by hand: instead of opening 800 coins one by one, you set the value once and apply it to all 800.

Three propagation modes are supported:

- **Replace** — overwrite the component's existing value in the chosen language with the new value.
- **Add** — append the new value(s) to a multi-value component, skipping items already present (not allowed for mono-value components).
- **Delete** — remove the given value(s) from a multi-value component (locator-aware for relation components).

Concrete heritage scenario: a numismatics cataloguer has filtered the *Coins* section down to the 800 issues of one mint, all of which were wrongly catalogued with an empty *Conservation* field. They open the tool on the *Conservation* component, set the correct term once, press **Replace**, and the value lands on all 800 records in one background pass. Later the institution decides to retire a deprecated keyword: with the same tool in **Delete** mode they strip that one relation from every record that still carries it, leaving the rest of each record's keywords untouched. Because the whole run is recorded as a single bulk process, the change is reversible from the Time Machine.

Use it when: the same component value must be set, appended, or removed across a record set defined by a section filter. Do not use it for one-off edits (edit the record directly) or for cross-component transforms (it writes one component_tipo to itself).

## How it works (server + client)

**Server** (`tools/tool_propagate_component_data/server/{index,propagate}.ts`) — a single action, `propagate_component_data`, runs the whole batch:

1. Validates the required options and the `action` value (`replace` | `delete` | `add`).
2. **Permission gate — the write door:** `apiActions` declares `permission: null` here because the target is a `(section_tipo, component_tipo)` **pair with no single record**, and the request carries the component side of that pair under `component_tipo`, not `tipo` — the field name the declarative `tipo` gate kind reads. The handler therefore asks the shared write door itself: `authorizeSectionTarget` up front (read on the section — the section floor, level 1 — then write, level 2, on the pair), so a caller with no access to the section is refused before any record is searched, even when it holds a grant on the component; then, for every matched row, `authorizeRecordAccess` (write, level 2, section floor 1, the dd128-aware pair, the write scope), whose grant addresses that row's save. A refused row is reported in `errors` (`out of the user scope` / `no write permission …` / `invalid record address (…)`) and never written; the batch goes on.
3. Resolves the component model; refuses a **derived** model outright (`isDerivedModel` — e.g. `component_relation_children`: it stores nothing, so the stored region would be leftover bytes and the write would re-parent every real child missing from them), before the search and the bulk-process record; refuses `add` for mono-value components (the `COMPONENTS_WITH_RELATIONS`/monovalue set defined in `propagate.ts`).
4. **Runs the SQO** with the full result set (via `buildSearchSql`, no limit).
5. **Security total check:** if the server's row count is *greater* than the client-supplied `total`, it aborts — the SQO may have drifted between client and server, so a larger-than-expected match set is refused rather than silently over-writing more records than the user saw.
6. Creates a **bulk process** record (section `dd800`, label component `dd796`) and its label in ONE transaction, **fail-closed**: if the mint fails the run is refused before a record is touched (an unattributable run is one no revert can name). The returned `bulk_process_id` is the audit handle for the whole run, and the run is held in the in-process live-run registry while it writes, so a revert of it is refused until it ends.
7. Iterates the result rows. Each record is ONE transaction: `readMatrixKeyForUpdate` locks the row and reads the stored key; `applyPropagation` (`propagate.ts`, pure and unit-tested) computes the final value per action (replace overwrites; delete unsets matching items — locator-keyed for relation components, then re-indexes; add appends absent items) over the **save path's language region** (`regionOf` with `isLangSlicedModel` — a translatable relation is not lang-sliced, so its region is the whole key); and only when the data changed, `saveComponentData` `set_data` joins the transaction under the run's bulk id. The engine save records the run's undo pair (a hidden BEFORE image + the visible after-row, one language per row — [tm_record](../../../core/system/tm_record.md#the-bulk-undo-log)), stamps the modified metadata and fires the observers post-commit. A record deleted since the search is skipped, never recreated.
8. Returns `{result, msg, errors, action, section_label, total, counter, memory}`; per-row failures are collected in `errors` (and downgrade the message to "done with warnings") without aborting the batch.

The action is also listed in `backgroundRunnable`; the client always invokes it with `background_running: true`. `scheduleBackground` (`src/core/tools/background.ts`) runs the handler as a fire-and-forget promise and returns `{result:true, background_job_id}` immediately — see [Server contract](../server_contract.md). ⬜ **Gap:** the client polls `dd_utils_api.get_process_status` for live per-row progress (see *Client* below). That action exists and is registered (`src/core/api/handlers/dd_utils_api.ts`), but it reads from a different job registry — the pfile-keyed store in `src/core/media/jobs.ts` used for AV transcode and backup jobs — than the one `scheduleBackground` writes to (the UUID-keyed job table in `src/core/tools/background.ts`, exposed via `getBackgroundJob(id)`). A background propagate run therefore starts and completes correctly, but polling it through `get_process_status` with the `{pid, pfile}` shape the client sends will not find a matching record; the client would need to poll `getBackgroundJob(id)` (keyed by the returned `background_job_id`) instead to observe progress.

**Client** (`tools/tool_propagate_component_data/js/`):

- `tool_propagate_component_data.js` is the instance. On `build()` it locates the `main_element` ddo (the component being propagated) and calls `get_component_to_propagate()`, which spins up a **temporary, standalone instance** of that same component (fake `section_id`, `is_temporal`, `id_variant: 'propagate_…'`) seeded with the caller's current value — the editable widget the user composes the propagation value in. `propagate_component_data(action)` reads the live SQO from the section (`self.caller.caller?.caller.rqo.sqo`, cleaned to `offset=0`/`limit=0`), builds the `dd_tools_api` / `tool_request` RQO with `background_running:true`, and fires it through `data_manager.request` with a long timeout (one retry, 3600 s).
- `render_tool_propagate_component_data.js` builds the UI: the temporary component widget, a **Replace / Add / Delete** button row (the Add button is hidden when the model is mono-value, read from the `components_monovalue` client config), and an info line stating the field and the affected record count. It refuses to render if the caller is not a section in `edit` mode. On click it confirms with the user (a second, stronger confirmation when **no filter** is applied — the action would touch *all* records), then streams live progress through `dd_utils_api.get_process_status` (`render_stream` / `read_stream`), locking the UI until the process reports done — on this engine that polling loop does not observe progress for a propagate run, because the background job it started is not recorded in the store `get_process_status` reads from (see the gap noted above).

## Actions & options

`apiActions = { propagate_component_data: { permission: null, handler: propagateComponentData } }` and `backgroundRunnable = ['propagate_component_data']`. `permission: null` here means the framework runs no declarative gate — the handler asks the write door itself (`authorizeSectionTarget` on the `(section_tipo, component_tipo)` pair up front, `authorizeRecordAccess` per row; this is also the defense-in-depth gate for the background path, since `scheduleBackground` does not re-run the declarative gate — there being none to re-run here).

| Action | Permission gate | Background | Reads from `options` |
| --- | --- | --- | --- |
| `propagate_component_data` | `permission: null` + the write door inside the handler (`authorizeSectionTarget` level 2 on the pair, section floor 1; `authorizeRecordAccess` per row) | yes (`backgroundRunnable`; client sends `background_running:true`) | see below |

Key options read by `propagate_component_data`:

| Option | Type | Meaning |
| --- | --- | --- |
| `section_tipo` | string (req.) | Target section. Used for the write gate and component resolution. |
| `component_tipo` | string (req.) | The component to write. Model resolved via the ontology resolver. |
| `action` | string (req.) | `replace` \| `delete` \| `add`. Any other value is refused. |
| `lang` | string (req.) | Language the data is read/written in. |
| `propagate_data_value` | mixed | The value to propagate. For replace: the full new value. For add/delete: the item(s) to append/remove (cast to array; delete on relations matches by `section_tipo`+`section_id` locator). Optional for delete-nothing/replace-with-empty. |
| `sqo` | object (req.) | The selection to act on. Server forces the full result set (no limit/offset). |
| `total` | int (req.) | Record count the client saw. Server aborts if its match count **exceeds** this (anti-drift security check). |
| `bulk_process_label` | string (opt.) | Human-readable name stored on the bulk process record (`dd800`/`dd796`); defaults to `"Propagate <action> to <component_label>"`. |
| `background_running` | bool | Set `true` by the client to run the action detached (`scheduleBackground`). |

Response: `{ result, msg, errors, action, section_label, total, counter, memory }` — `counter` is the number of rows actually processed; `errors` holds any per-row warnings.

## How it is registered & surfaced

`tools/tool_propagate_component_data/register.json` is a **column-keyed dump** (`string`/`relation`/`misc`/… keyed by component tipo — a seeded matrix-row snapshot, not a hand-authored file); `importTools()` passes it through as-is (see [register.json reference](../register_json.md)). The essentials it carries:

- `dd1326` name = `tool_propagate_component_data`; `dd1327` version (`2.0.4`); `dd1328` minimum Dédalo version (`6.2.5`); `dd1644` developer (`Dédalo team`); `dd799` label / `dd612` description (multi-language).
- `dd1330` affected_models — a long list of **component models** (resolved against the models section dd1342). The tool therefore attaches to the components it can edit, not to whole sections.
- `dd1331` show_in_inspector = `true` and `dd1332` show_in_component = `true` (the relation targets resolve to dd64 section_id `1` = yes), so the button can render both in the inspector panel and inline on the component. `dd1333` require_translatable = `false` (dd64 section_id `2` = no); `dd1354` active = `true`.
- `dd1633` default_config carries `components_monovalue` (flagged `"client": true`) — the list of mono-value component models the client uses to hide the **Add** button and the server uses to refuse the `add` action.
- `dd1372` labels supply the localized UI strings (`do_replace`, `tool_do_add`, `tool_do_delete`, `content_will_be_added_removed`, `will_replaced_all_records`, `bulk_process_label`, …).

Surfacing (in `getElementTools`, `src/core/tools/registry.ts`): because `affected_models` lists component models, the **Propagate** button appears on those components while a section is in **edit** mode — the client explicitly refuses to render unless its caller chain resolves to a `section` in `edit` mode.

## Examples

Client-side `tool_request` (built by `tool_propagate_component_data.js::propagate_component_data`, sent through `dd_tools_api`):

```js
const source = create_source(self, 'propagate_component_data') // → tool_propagate_component_data::propagate_component_data

const sqo = clone(section.rqo.sqo)
sqo.offset = 0
sqo.limit  = 0

const rqo = {
    dd_api : 'dd_tools_api',
    action : 'tool_request',
    source : source,
    options : {
        background_running   : true,                 // run detached (scheduleBackground)
        section_tipo         : 'rsc167',             // Coins section
        section_id           : self.main_element.section_id,
        component_tipo       : 'rsc167-conservation',// the component being propagated
        action               : 'replace',            // replace | add | delete
        lang                 : 'lg-eng',
        propagate_data_value : self.component_to_propagate.data.entries, // the composed value
        bulk_process_label   : 'Data propagation | Replace',
        sqo                  : sqo,                   // the current filtered selection
        total                : self.total            // anti-drift count the user saw
    }
}

const api_response = await data_manager.request({ use_worker:true, body:rqo, retries:1, timeout:3600*1000 })
// api_response → { pid, pfile, ... }; progress is then streamed via dd_utils_api::get_process_status
```

A successful (non-background) response object:

```json
{
    "result": true,
    "msg": "OK. replace data of 'Conservation' in section 'Coins' successfully.",
    "errors": [],
    "action": "replace",
    "section_label": "Coins",
    "total": 800,
    "counter": 800,
    "memory": "42.5 MB"
}
```

To undo the whole run, find the matching bulk process in the Time Machine and revert it — every write in the batch was stamped with the same `bulk_process_id` and recorded the value it replaced, so the revert restores each record exactly and skips (and reports) any record edited after the run.

## Related

- [tool_export](tool_export.md) — the read-side bulk operation over a section selection; see [Exporting data](../../../using/exporting_data.md). `tool_propagate_component_data` is the write-side bulk counterpart over the same SQO model.
- `tool_update_cache` — another background, SQO-driven bulk operation over a component's records (cache regeneration; `update_cache` is in `backgroundRunnable` too), sharing the same background-execution shape.
- [tool_time_machine](tool_time_machine.md) — where a bulk run is reverted as a unit (every write in the batch shares one `bulk_process_id`); source `core/services/service_time_machine/`, `core/tm_record/`.
- Search subsystem (SQO): the selection contract this tool consumes — `src/core/search/` (`dedalo-search` skill).
- [Creating new tools](../creating_tools.md) · [Server contract](../server_contract.md) — the tool model, `apiActions`, gates, background execution and lifecycle this page builds on.
- Source: `tools/tool_propagate_component_data/server/{index,propagate}.ts`, `tools/tool_propagate_component_data/js/{tool_propagate_component_data,render_tool_propagate_component_data}.js`, `tools/tool_propagate_component_data/register.json`.
