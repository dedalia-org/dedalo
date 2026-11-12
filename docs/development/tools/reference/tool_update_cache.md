# tool_update_cache

Bulk regeneration of the stored per-record data of one or more of a section's components across every matched record, run as a chunked background job with live progress.

!!! warning "Administrator tool"
    `tool_update_cache` re-saves records in bulk. It is meant for administrators doing maintenance (rebuilding derived data after an ontology or schema change), not for everyday cataloguing.

## What it does / why & when to use it

Some of a component's stored data is **derived** at save time — the relation-search ancestor index an autocomplete component keeps for fast lookup, counter reconciliation, denormalised text. When that derivation logic changes, or a batch of records was written by a path that skipped it, the stored value drifts from what a fresh save would produce. `tool_update_cache` fixes that in bulk: it walks every record a section filter matches and **re-saves** the selected components, so the save path re-runs its derivation for each one.

Concrete heritage scenario: a numismatics collection reworks its mint thesaurus so that the ancestor chain used by an autocomplete component changes. The stored index on thousands of *Coins* records is now stale. An administrator opens the tool on the *Coins* section, ticks the affected component, and runs it — every matched record is re-saved and its derived data is rebuilt, without opening a single record by hand.

Use it when: a component's *stored* value must be regenerated across many records (post-migration, post-ontology-change, or to repair drift). Do not use it to *change* data — it re-writes each component's current value back to itself; the value the user sees is unchanged, only its derivation is refreshed. To change a value across records, use [`tool_propagate_component_data`](tool_propagate_component_data.md).

## How it works (server + client)

**Server** (`tools/tool_update_cache/server/index.ts`) exposes two actions.

`get_component_list` enumerates the caller section's components through the shared `buildSectionElementsContext` (the "simple" element context, `src/core/resolve/section_elements_context.ts`), keeps only the `component` entries, and annotates each with its `regenerate_options` — the v6 descriptor array (`[{name:'delete_normalized_files', type:'boolean', default:false}]`) for media models, `null` for everything else. The result feeds the client's checkbox list.

`update_cache` does the regeneration:

1. Requires `section_tipo` and a non-empty `components_selection`; otherwise it fails closed with `invalid_request`.
2. **Requires** the client SQO (WC-043 — there is deliberately NO whole-section fallback: an absent sqo once silently swept a 438k-record section the client displayed as "Records: 1"; missing/malformed sqo fails closed with `invalid_request`). Sanitises it (`sanitizeClientSqo`) and forces `limit = null` / `offset = 0`, so the **whole matched set** — not just the visible page — is processed. The client sends a deep clone of the caller list's live sqo, so scope == what the list shows; an unfiltered list explicitly matches the whole section.
3. Assembles and runs the search (`buildSearchSql`) to get the matched `(section_tipo, section_id)` rows.
4. Iterates the rows. For each selected component tipo it resolves the model and branches:
   - **external portal** — a component whose data tipo (an alias resolves to its target) declares `properties.source.mode: "external"` is **recomputed by its law, never re-saved** — a mirror is derived, so regenerating it means recomputing it (WC-2026-11-12-update-cache-external-mirror-refresh). The tool hands the row's write grant to the shared refresh runner `runExternalRefresh` (`src/core/section/record/external_refresh.ts` — the same runner the portal's update button uses; it checks the law and the host section, then calls `refreshExternalMirror`), with the per-record lock bound. Once per row per data tipo. A run counts `external_refreshed` (also in `regenerated`); a refused law, a non-host record, a frozen or degraded value counts `external_withheld` with an `errors` line naming the reason; a held row is `locked`, a deleted one `vanished`. The external tipos are resolved once before the run: an alias that breaks its contract refuses the whole run before anything is written. The refresh write carries no bulk id (the mirror is a calculation — see the exemption below).
   - **non-media** — reads the component's current items (`readComponentItems`) and re-saves them with a single `set_data` change through `saveComponentData` (`src/core/section/record/save_component.ts`), which re-runs the save path's derivation. Each such write increments `regenerated`.
   - **media** — **repairs the media** via the shared kernel `refreshMediaItems` (`src/core/media/repair.ts`, called with `regenerate: true`), with **v6 `regenerate_component` semantics** (component_media_common :2614): builds only the derivatives that are **MISSING** — an existing file is never re-encoded; the image thumb is re-created **always**, FROM the default-quality file (v6 create_thumb — no original needed); the image SVG envelope is created when absent and its embedded raster path is FIXED when it drifted; `delete_normalized_files` (the per-component regenerate option — honored since WC-043) first moves the default quality's normalized files to `deleted/<bulk id>/`, guarded on a locally present original. A missing `original_file_name` is restored from the section's `properties.target_filename` component (v6 :2670). The derivative work runs OUTSIDE any lock, on this run's snapshot. Then the write goes through the ONE media-key writer, the locked transform `transformStoredMediaItems` (`src/core/media/tools/files_info_persist.ts`, `lockWait: 'per-record'`): it re-reads the component's stored items UNDER the row lock, re-scans the disk for THOSE items and writes the result in one short transaction — so an upload a curator committed to the same record while the run was rebuilding (a new item, its `original_file_name`) is refreshed, never reverted to the snapshot. **No Time Machine entry** (files_info is a filesystem-derived cache), and the rescan preserves the sibling keys (`original_*`, `lib_data`). A record deleted during the run is counted in `vanished`, a row another session kept locked past the per-record bound (a few seconds) in `locked` — each also a line in `errors`, neither counted in `regenerated`, and the run goes on with the next record. `component_av` derivative rebuild is an async transcode and is *not* enqueued here (that is tool_media_versions' job) — its `files_info` refresh still applies. A record whose original is absent on the box gets the honest result: derivatives no-op. **Shrinks are HELD** (`holdShrink: true`, counted in `media_held`): when the rescan finds FEWER existing files than the stored index claims — the signature of a partial local media copy, not of a stale index — the stored `files_info` is kept, never wiped; shrinking an index requires the ops script's explicit `--allow-shrink` adjudication. Derivative-build failures are collected into `media_errors`; the files_info refresh still lands.
   - **media, `component_pdf` only — the transcription** — after the file pass, and outside the media row lock, `transcribeStoredPdf` (`src/core/media/ingest/pdf_transcription.ts`) fills the `component_text_area` the PDF names in its ontology `relations` (core `rsc37` → `rsc38`, `rsc209` → `rsc210`, `rsc165` → `rsc166`) with the PDF's `pdftotext` text, one page tag per page, in the caller's data language — **only when that language slice is empty**. A slice with visible text is kept and counted, never overwritten; the emptiness is read under the text area's row lock in the transaction that writes, so a curator's text committed meanwhile is never taken for empty. No OCR runs from a sweep. The save carries the run's bulk id, so it joins the undo log and a revert of the run empties the slice again. A PDF without a text layer is counted (`transcriptions_no_text`), not reported as an error, so a sweep over scanned PDFs does not drown the run's real failures; a failed extraction or save is a line in `errors` and writes nothing. This is also the operator's **backfill** for PDFs uploaded before the transcription existed: a sweep over the section fills exactly the empty transcriptions. Nothing runs it automatically. See [component_pdf › Transcription and OCR](../../../core/components/component_pdf.md#transcription-and-ocr).
5. Returns `{ result, msg, errors, regenerated, records, processed, stopped, bulk_process_id, media_errors, media_held, vanished, locked, external_refreshed, external_withheld, transcriptions_filled, transcriptions_kept, transcriptions_no_text, transcription_errors }` (see the response section below).

`update_cache` is listed in `backgroundRunnable`, and the client always calls it with `background_running: true`. `scheduleBackground` (`src/core/tools/background.ts`) submits the handler into the process-job registry and returns immediately with `{ result, background_job_id, job_id, pid, pfile }`; the handler streams progress through the same registry `dd_utils_api::get_process_status` reads from, so the client's progress panel renders live.

!!! note "Regenerate options, bulk process, and Time Machine (v6 parity)"
    `get_component_list` annotates media components with the v6 option-descriptor array (`[{name:'delete_normalized_files', type:'boolean', default:false}]` — the client ITERATES this shape to build the options panel; any other shape renders it empty). `update_cache` honors the per-component `regenerate_options.delete_normalized_files`. Each run mints one **dd800 bulk-process record** (`Update cache | <section> | <components>`; id returned as `bulk_process_id`) — deleted normalized files land under `deleted/<id>/`. The generic re-saves carry the run's bulk id, so they are under the undo-log pair law (WC-2026-09-27-bulk-revert-undo-log, [tm_record](../../../core/system/tm_record.md#the-bulk-undo-log)): `saveTm` is not honoured under a bulk id, a re-save whose region comes out byte-equal writes **nothing** (so the v6 reason for disabling Time Machine — per-row versions of an unchanged value would be pure bloat — still holds), a record whose key holds nothing (absent or empty) is **skipped** (re-saving an absent key as `[]` would be a real change: two history rows per empty record of a sparse component), and one that does change the stored form writes its hidden BEFORE image and its visible after-row, so the run is revertible exactly. The dd800 mint (record + label) is one transaction and fail-closed, and the run is held in the live-run registry while it writes. **Named exemption:** the media repair's `files_info` write-back (`updateMatrixKeyData`) and the files moved to `deleted/<id>/` stay outside the undo log — `files_info` is derived from the filesystem and a revert cannot move files back. So does an external portal's recompute (an observer mirror write, outside the log by the same rule): a revert leaves the recomputed mirror.

**Client** (`tools/tool_update_cache/js/`):

- `tool_update_cache.js` is the instance. On `build()` it fetches the section's component tree via `get_component_list` into `self.components_list`. `update_cache()` composes `components_selection` from the ticked tipos and sends one background request (`use_worker:true`, `retries:1`, `timeout:3600000`).
- `render_tool_update_cache.js` renders the section info, a checkbox list of the components (media models and any admin-configured `hilite_tipos` are highlighted), an **Update records** button showing the affected record count, and a live progress area. On submit it confirms, fires the background request, then opens an SSE stream (`data_manager.request_stream` → `read_stream`) against `dd_utils_api::get_process_status` using the returned `pid`/`pfile`, showing a running counter and a final summary. A persisted `pid`/`pfile` in IndexedDB (`process_update_cache`) lets the progress panel re-attach to a still-running job when the panel is reopened.

## Actions & options

```ts
apiActions: {
	get_component_list: { permission: 'section_list', minLevel: 1, sectionTipos: componentListSectionTipos, handler: getComponentList },
	update_cache:       { permission: 'targets', minLevel: 2, targets: updateCacheTargets, handler: updateCache },
},
backgroundRunnable: ['update_cache'],
```

| Action | Permission gate | Background | Reads from `options` |
| --- | --- | --- | --- |
| `get_component_list` | declarative: `section` @ level 1 (read) | no | `ar_section_tipo`, `use_real_sections`, `ar_components_exclude` |
| `update_cache` | declarative: `section` @ level 2 (write) | yes (`backgroundRunnable`; client sends `background_running:true`) | `section_tipo`, `components_selection`, `sqo`, `lang` |

Key options read by `update_cache`:

| Option | Type | Meaning |
| --- | --- | --- |
| `section_tipo` | string (req.) | Target section. Required; missing it fails with `invalid_request`. |
| `components_selection` | array (req.) | The components to regenerate, `[{ tipo, regenerate_options }, …]`. Non-empty required. Only `tipo` is read. |
| `sqo` | object (req.) | The selection to act on — REQUIRED (WC-043, no whole-section default; absent ⇒ `invalid_request`). Server forces the full result set (`limit=null`, `offset=0`). The client sends the caller list's live sqo (cloned). |
| `lang` | string | Application language; used for the translatable-component write language (non-translatable components write `lg-nolan`). |
| `background_running` | bool | Set `true` by the client to run detached (`scheduleBackground`). |

Response: `{ result, msg, errors, regenerated, records, processed, stopped, bulk_process_id, media_errors, media_held, vanished, locked, external_refreshed, external_withheld, transcriptions_filled, transcriptions_kept, transcriptions_no_text, transcription_errors }` — `regenerated` is the number of component writes (media and non-media), `records` the number of matched records, `processed` how many were fully processed (`< records` only after a stop), `stopped` whether the run ended by cooperative cancellation, `media_errors` the count of media derivative rebuilds that failed (each detailed in `errors`; the files_info refresh still landed for them), `media_held` the count of stored media indexes kept because the rescan found fewer files than stored (shrink guard, judged on the items read under the lock), `vanished` the records deleted while the run was working on them (nothing written), `locked` the records whose row stayed locked past the per-record lock bound (nothing written; re-run to pick them up), `external_refreshed` the external portals recomputed by their law (wrote, or already right), `external_withheld` the ones the law/host preconditions or a freeze/degraded value held back (each detailed in `errors`, nothing written). The four `transcription*` counters cover `component_pdf` only: `transcriptions_filled` empty transcriptions written, `transcriptions_kept` non-empty ones left as they were, `transcriptions_no_text` PDFs without a text layer (nothing written), `transcription_errors` failures (each detailed in `errors`, nothing written). Any non-zero one adds a sentence to `msg`, for example `3 empty transcription(s) filled from the PDF text; 1 transcription(s) kept (not empty — never overwritten).`

**Progress & stop (WC-043):** the handler publishes throttled per-record frames through `ctx.publishProgress` — `{msg, is_running, counter, total, current:{section_id}, n_components}`, exactly the fields the client's stream renderer formats — and checks `ctx.signal?.aborted` at each record boundary. The generic Stop button posts `dd_utils_api::stop_process {pid, pfile}` (registered since WC-043; `src/core/api/process_status.ts stopUtilsProcess` — owner-gated, aborts the job's controller), so a run stops cooperatively after the current record and returns the partial summary.

## How it is registered & surfaced

`tools/tool_update_cache/register.json` is a **column-keyed dump** (`string`/`relation`/`misc`/… keyed by component tipo — a seeded matrix-row snapshot, not a hand-authored file); `importTools()` passes it through as-is (see [register.json reference](../register_json.md)). The essentials it carries:

- `dd1326` name = `tool_update_cache`; `dd1327` version (`2.0.6`); `dd1328` minimum Dédalo version (`6.0.0`); `dd1644` developer (`Dédalo team`).
- `dd799` label = "Update cache" (localised); `dd612` description = "Manages Dédalo components cache clean actions".
- `dd1331` show_in_inspector and `dd1332` show_in_component both resolve to **no** (dd64 section_id `2`), and `dd1354` active = **yes** (dd64 section_id `1`). The tool is a **section-level** tool: the client reads `self.caller.section_tipo` / `self.caller.total`, listing and regenerating that section's components.
- `dd999` / `dd1633` carry `hilite_tipos` (flagged `"client": true`) — the admin-configured list of component tipos the client highlights in the checkbox list for easy location.
- `dd1372` labels supply the localised UI strings: `updated`, `components`, `delete_normalized_files`, `regenerate_options`, `info`.

## Examples

Client-side background request (built by `tool_update_cache.js::update_cache`, sent through `dd_tools_api`):

```js
const rqo = {
    dd_api  : 'dd_tools_api',
    action  : 'tool_request',
    source  : create_source(self, 'update_cache'), // → tool_update_cache::update_cache
    options : {
        background_running   : true,
        section_tipo         : 'rsc167',           // Coins section
        components_selection : [
            { tipo: 'rsc167-mint', regenerate_options: null }
        ],
        lang                 : page_globals.dedalo_application_lang
    }
}

const api_response = await data_manager.request({ use_worker:true, body:rqo, retries:1, timeout:3600*1000 })
// api_response → { result:true, background_job_id, job_id, pid, pfile }
// progress is then streamed via dd_utils_api::get_process_status using pid/pfile
```

A completed (non-background) response object:

```json
{
    "result": true,
    "msg": "OK. update_cache regenerated 800 component(s) across 800 record(s).",
    "errors": [],
    "regenerated": 800,
    "records": 800,
    "media_errors": 0
}
```

## Related

- [tool_propagate_component_data](tool_propagate_component_data.md) — the other background, SQO-driven bulk operation over a section's records; propagate *changes* a component's value, update_cache re-derives it.
- [tool_media_versions](tool_media_versions.md) — per-record, on-demand media version building (higher tiers, deletes, rotation); update_cache's media repair rebuilds only the default quality + thumb (+ image SVG envelope) in bulk, and never enqueues av transcodes.
- `scripts/media_repair_files_info.ts` — the cross-section ops sweep for stale `files_info` (dry-run default, shrink-guarded, no derivative rebuild); update_cache is the in-app per-section equivalent. Both rescan through `src/core/media/repair.ts` (`rescanMediaItems`) and write through the one locked media-key writer (`transformStoredMediaItems`). The sweep judges each media item on its own (GROW / DIFF / SHRINK on that item's file count; a SHRINK item keeps its stored index unless `--allow-shrink`), re-judges it under the lock before writing, and always rewrites a FOREIGN item — one whose stored files are another record's (the clone signature `<component>_<section>_<N>`, what a failed duplicate could leave); a file named some other way (an `image_id` rename) is never taken for foreign.
- [Creating new tools](../creating_tools.md) · [Server contract](../server_contract.md) — the tool model, `apiActions`, gates and background execution this page builds on.
- Search subsystem (SQO): the selection contract this tool consumes — `src/core/search/`.
- User guide: [Update cache](../../../tools/using_update_cache.md).
- Source: `tools/tool_update_cache/server/index.ts`, `tools/tool_update_cache/js/{tool_update_cache,render_tool_update_cache}.js`, `tools/tool_update_cache/register.json`.
