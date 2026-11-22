# tool_media_versions

Manages the on-disk media files behind a media component: inspect per-quality versions, delete a quality or a specific version, (re)build versions from the original, conform AV headers, rotate images, and re-sync the component's stored file metadata with what actually exists on disk.

## What it does / why & when to use it

A Dédalo media component (`component_image`, `component_av`, `component_pdf`, `component_3d`, `component_svg`) does not store a single file — it stores a *set of qualities* (e.g. `original`, `default`, `404`, `audio`, `thumb`, ...) derived from the uploaded master, each as a file on disk, plus a `files_info` block in the record that records which qualities exist. `tool_media_versions` is the panel a cataloguer or media administrator opens to manage that file set directly, without leaving the record.

It surfaces three things in one modal:

1. a **live preview** of the media component itself (read-only),
2. a **sync/regenerate** area that compares the qualities recorded in the database (`files_info_db`) against the qualities actually present on disk (`files_info_disk`) and flags a mismatch, and
3. a **versions grid**: one row per quality, showing the real file (name, size, existence) with per-quality buttons to open, (re)build, rotate, delete, or — for AV — conform headers.

Concrete heritage scenario: an archivist uploads a high-resolution TIFF master for a museum object. The streaming/web qualities (`default`, `404`, `thumb`) are generated automatically on upload, but the archivist notices the web preview is sideways. They open **Media versions** on the image component, **rotate** the affected quality, and the derived files are regenerated rotated. Later, a colleague manually deleted a couple of derived files on the server; the record now shows "Files info data is unsync". The archivist opens the tool, sees the disk/DB mismatch in the **Show data** panel, optionally ticks **Delete normalized files**, and presses **Regenerate** to rebuild the missing qualities and write a correct `files_info` back to the record. For an AV file that won't seek properly in the browser, they use **Conform headers** to rewrite the moov atom / headers of a quality.

Use it when: derived media qualities are missing, broken, rotated, un-seekable, or out of sync with the record. Do not use it to *upload* a new master (that is the upload flow / `tool_upload` / `tool_import_files`) — this tool operates on the files of an already-existing media component.

## How it works (server + client)

**Server** (`tools/tool_media_versions/server/{index,media_versions}.ts`). Every action is declaratively gated `permission: 'record', minLevel: 1` (read, `get_files_info` only) or `minLevel: 2` (write, everything else) — the `'record'` gate kind asserts both the section/component permission level **and** the per-record project-scope check in one declarative spec. Each handler reads `tipo` / `section_tipo` / `section_id` (plus action-specific params) from `options`, validates they are present, resolves the target media component's model, and delegates to the real processing engines the Media rebuild shipped:

| Action | Delegates to |
| --- | --- |
| `get_files_info` | the `files_info` scanner (probes each quality on disk) |
| `delete_quality` | file-ops soft-delete for the quality |
| `build_version` | the processing engine (`buildImageVersion`/`buildPdfCover`/…, pixel-budget resize, never-upscale, CMYK→sRGB). For `component_av` it is the av encoder (`src/core/media/av_versions.ts`): the REQUESTED quality tier is transcoded in a background job (returns `job_id`), and the thumb tier is derived from the posterframe, never from ffmpeg |
| `get_job_status` | the media job manager — the poll wire for the `job_id` an av `build_version` returns |
| `conform_headers` | AV header/moov-atom rewrite (`component_av`-only, per `register.json`'s `specific_actions`) |
| `rotate` | the rotation engine (`component_image`-only) for the matching quality entry |
| `sync_files` | re-reads data then re-derives the component's stored `files_info` |
| `delete_version` | the thumb-specific delete path for the thumb quality, else the general file-ops delete |

All eight actions return the standard `{ result, msg, errors }` envelope; the write actions merge the engine response into that envelope. `sync_files` re-reads current data **before** regenerating, so the regeneration runs against current data. `rotate` reads the component's `files_info`, matches the requested `quality`, and runs the rotation for each matching entry — gated against real ImageMagick/ffmpeg output on scratch media.

**Client** (`tools/tool_media_versions/js/`). `tool_media_versions.js` is the instance; it extends the standard tool lifecycle (`init` / `build` / `render` / `edit` from `tool_common`). In `build()` it resolves its `main_element` from `tool_config.ddo_map` (the ddo flagged with `role: 'main_element'`), finds that component instance in `ar_instances`, and pre-computes the file sets it needs: `files_info_db` (from the record's `entries[0].files_info`), `files_info_disk` (fetched live via `get_files_info`), and filtered views (`files_info_safe`, `files_info_alternative`, `files_info_original`). `render_tool_media_versions.js` builds the DOM: the read-only main-element preview, the sync/regenerate row, and the versions grid. Each client method (`delete_quality`, `build_version`, `conform_headers`, `rotate`, `sync_files`, `delete_version`, `get_job_status`) builds an RQO with `dd_api: 'dd_tools_api'`, `action: 'tool_request'`, `source: create_source(self, '<action>')`, and the options above, then calls `data_manager.request()`. The destructive/long actions confirm first (`confirm(get_label.sure)`) and use a long client timeout (`3600 * 1000` ms) with a single retry, because rebuilds can take minutes.

**Following a transcode.** An av `build_version` returns a `job_id`, and the panel follows it over the push stream (`core/common/js/job_follow.js`) rather than polling — both for a build it started and for one it merely DISCOVERED running (an upload's, or another operator's, reported by `get_record_jobs`). Those streams are owned by the instance: `self.job_followers` is a follower group that `destroy()` cancels and that each render pass cancels at its head, re-following whatever is still live against the nodes it is about to build.

!!! warning "Releasing them is not tidiness"
    A followed job holds one HTTP connection for as long as it runs, and a browser grants six per origin. Before the group existed, closing and reopening this panel over one long transcode left a live stream behind each time; at the sixth, every request on the page queued indefinitely — `/health` first, the probe that tells a busy server from a dead one — and the panel froze on *Loading…* with 6 s timeouts against a healthy server. Any new surface that follows a job must own its followers the same way; see [data_manager](../../../core/client/data_manager.md).

**Specific actions.** The rotate and conform-headers buttons are not shown on every media model. The tool's `properties.specific_actions` (from `register.json`) maps each action to the component models it applies to — `rotate` → `component_image`, `conform_headers` → `component_av` — and `render_tool_media_versions.js` only renders a specific action when `self.main_element.model` is in that action's model list.

## Actions & options

`apiActions` declares each media action with `permission: 'record_tipo'` — `minLevel: 1` for the one read action, `minLevel: 2` for the six write actions — so the framework asserts the level on the (section_tipo, component) PAIR **and** the per-record project-scope check before any handler runs. `get_job_status` is the exception: it mounts the shared `MEDIA_JOB_STATUS_ACTION` spec with `permission: null`, because dispatch gates 1–4 already require a caller authorized for this tool and the handler applies the job-record ownership rule itself. `build_version` is the one `backgroundRunnable` action.

All actions read the same three required options — `tipo` (the component tipo), `section_tipo`, `section_id` — and refuse with an error envelope if any are missing.

| Action | Gate | Extra required / read options | Purpose |
| --- | --- | --- | --- |
| `get_files_info` | `record_tipo`, level 1 | — | Probe disk for every quality; returns the `files_info` array (existence, name, path, url, size, time per quality) as `result`, plus `files_info_db` — what the RECORD stores for the same lang, read in the same breath. The panel compares the two to raise the "files info data is unsync" warning, so both sides must come from one answer: taking the DB side from the component's cached data made every delete raise a false alarm that a page reload cleared. |
| `delete_quality` | `record_tipo`, level 2 | `quality` (req.) | Delete the file of one quality. |
| `build_version` | `record_tipo`, level 2 | `quality` (req.), `extension` (optional), `async` (default `true`) | (Re)build the requested quality from the original (falling back to the default-quality file when the box has no original). For av it returns `job_id` and encodes in the background; refusals that are knowable up front — no source, no encode profile for the tier, no audio stream for an audio tier, the original as target — come back as `result:false` **before** a job exists. One av build per component: while the component holds an upload claim, the ingest transcode or a build of any tier (its own included), the build is refused with `media.build_running` (409) before the source is looked for, and again by the exclusive submit if a race slips past (wire contract `WC-2026-11-22-av-upload-build-running`). |
| `get_job_status` | dispatch gates 1–4 (+ job ownership) | `job_id` (req.) | Poll one media job: top-level `JobStatusFrame` fields (`pid`, `pfile`, `is_running`, `data`, `errors`, `total_time`); `{result:false, errors:['job_not_found']}` on an unknown id. |
| `conform_headers` | `record_tipo`, level 2 | `quality` (req.) | Rebuild a quality rewriting file headers (AV seek/compatibility fix). |
| `rotate` | `record_tipo`, level 2 | `quality` (req.), `degrees` (req., e.g. `-90` / `90`) | Rotate the matching quality entries. |
| `sync_files` | `record_tipo`, level 2 | `regenerate_options` (object, e.g. `{ delete_normalized_files: bool }`) | Re-read data and regenerate the component so `files_info` matches disk. Rebuilds only what is missing — including the browser-viewable `<id>.<defaultExtension>` copy of an image master tier whose raw upload is a `.tif`/`.psd` (see `buildMasterNormalizedCopy`); a second pass changes nothing. A lost `original_file_name` is restored from the component's `properties.target_filename` field the same way `tool_update_cache` restores it (`src/core/media/provenance_repair.ts`: the item of the caller's data language, `original_normalized_name` = file id + lowercase extension, only keys that are absent), before the re-scan. Files are read from the record's own folder, `properties.additional_path` included. For a `component_pdf` it then runs `transcribeStoredPdf` (`src/core/media/ingest/pdf_transcription.ts`) in **fill-only-if-empty** mode, as its own locked transaction after the re-index: the related `component_text_area` slice in the caller's data language is filled from the PDF text when empty, kept when it holds text, and no OCR runs. The response adds `transcription` (`written`, `kept`, `no_text`, `not_pdf`, `no_target`, `failed`, or `null` for other models) and a clause in `summary`; a failure joins `errors` beside the success. See [component_pdf › Transcription and OCR](../../../core/components/component_pdf.md#transcription-and-ocr). |
| `delete_version` | `record_tipo`, level 2 | `quality` (req.), `extension` (optional) | Delete one specific version: the thumb-specific path for the thumb quality, else the general file-ops delete. |

**One av operation per component.** On a `component_av`, every action above that writes tier files synchronously — `conform_headers`, `delete_quality`, `delete_version`, `sync_files` and `build_version` of the thumb tier — holds the same component claim the builds hold (`withAvComponentClaim`, `src/core/media/av_component_claim.ts`) for the write and its `files_info` write-back, and answers `media.build_running` (409) while an upload, the ingest transcode, a build or another such operation holds the component. The av builds of the other tiers are jobs that hold the component themselves. Other models run unheld. Wire contract `WC-2026-11-22-av-upload-build-running` (ruling 4 addendum); gate `test/unit/av_component_operations_native.test.ts`.

**The panel agrees with the component rule.** `get_record_jobs` rows carry `scope` (`'component'` for the av build family). The building tier (and its `also_qualities`) renders the progress readout (`live_job_for_quality`); every OTHER tier's build gear renders greyed — class `component_busy`, `aria-disabled`, inert click, title from the tool label `component_busy` plus the building tier — while `live_component_job` finds a live component-scoped job of the panel's component. A finished job re-renders the grid; a FAILED one keeps its reason in its cell and gives the greyed gears back (`release_component_busy_gears`). Holders that are not jobs (an upload before its transcode, the synchronous operations above) are not in `get_record_jobs`: the server refusal covers them. Rows also carry `record.lang` (null when untranslatable), and both matchers compare it with the panel's lang (the data lang when the component is translatable, else null — the server's media-context rule), so a per-lang build greys only its own lang's gears. A build THIS browser starts greys the other tiers as soon as the server accepts it (`grey_component_gears`) and releases them if it fails. Every gear is `role="button"` + `tabindex="0"` (Enter/Space activate it); a greyed gear stays focusable and names its reason through `aria-describedby` (visually-hidden `.component_busy_reason`). Client gate: `client/dedalo/test/client/js/test_tool_media_versions.js`.

Response shape for every action: `{ result, msg, errors }`. For `get_files_info`, `result` is the files-info array (or `false` on failure) and `files_info_db` carries the stored array beside it; for the write actions `result` is the boolean / merged result of the delegated engine call.

`delete_quality` vs `delete_version`: `delete_quality` removes a quality regardless of extension; `delete_version` targets one concrete file, handling the thumb specially and accepting an `extension` to disambiguate when a quality has more than one file (e.g. a `.pdf` main file alongside derivatives).

## How it is registered & surfaced

`tools/tool_media_versions/register.json` is a **column-keyed dump** (`string`/`relation`/`misc`/… keyed by component tipo — a seeded matrix-row snapshot, not a hand-authored file); `importTools()` passes it through as-is (see [register.json reference](../register_json.md)). Essentials it carries:

- `dd1326` name = `tool_media_versions`; `dd1327` version = `2.0.4`; `dd1328` minimum Dédalo version = `6.2.6`; `dd1644` developer = "Dédalo team".
- `dd1330` affected_models → the media component models (`component_image`, `component_av`, `component_pdf`, `component_3d`, `component_svg`). The tool therefore attaches to **components**, not to sections or areas.
- `dd1335` properties = `{ "specific_actions": { "rotate": ["component_image"], "conform_headers": ["component_av"] } }`. There is **no** `open_as` property, so the tool opens in the default **modal**.
- `dd1372` labels supply the localized UI strings (`show_data`, `sync_data`, `files_info_is_unsync`, `delete_normalized_files`, `regenerate`) across all project languages.
- `dd1331` show_in_inspector and `dd1332` show_in_component select where the button renders for the matched component.

Surfacing (in `getElementTools`, `src/core/tools/registry.ts`): because `affected_models` lists the media component models, the **Media versions** button appears on those components when they are rendered (subject to the inspector/inline flags). The presence of the tool in a component's context is visible in the component sample fixtures, e.g. `src/core/components/component_image/samples/context.json`, `src/core/components/component_av/samples/context.json` — each lists `{ "model": "tool_media_versions", "name": "tool_media_versions", ... }` in its tools array.

## Examples

Client-side `tool_request` (built by `tool_media_versions.js`, sent through `dd_tools_api`). Probe the real files of an image component:

```js
const rqo = {
    dd_api : 'dd_tools_api',
    action : 'tool_request',
    source : create_source(self, 'get_files_info'), // → tool_media_versions::get_files_info
    options : {
        tipo         : self.main_element.tipo,         // e.g. 'rsc176' (the image component tipo)
        section_tipo : self.main_element.section_tipo,  // e.g. 'rsc167'
        section_id   : self.main_element.section_id      // e.g. 25
    }
}
const response = await data_manager.request({ body: rqo, use_worker: true })
// response.result → [{ quality:'original', file_exist:true, file_name:'rsc167_rsc176_25.tif', file_size: 1234567, ... }, ...]
```

Rotate the `default` quality 90° (write action, long timeout, confirm-gated client-side):

```js
const rqo = {
    dd_api : 'dd_tools_api',
    action : 'tool_request',
    source : create_source(self, 'rotate'), // → tool_media_versions::rotate
    options : {
        tipo         : self.main_element.tipo,
        section_tipo : self.main_element.section_tipo,
        section_id   : self.main_element.section_id,
        quality      : 'default',
        degrees      : 90
    }
}
const response = await data_manager.request({ body: rqo, retries: 1, timeout: 3600 * 1000 })
// response → { result:true, msg:'Success. Request done.', errors:[] }
```

Re-sync after files were removed on disk (rebuild + write correct `files_info`):

```js
const rqo = {
    dd_api : 'dd_tools_api',
    action : 'tool_request',
    source : create_source(self, 'sync_files'), // → tool_media_versions::sync_files
    options : {
        tipo               : self.main_element.tipo,
        section_tipo       : self.main_element.section_tipo,
        section_id         : self.main_element.section_id,
        regenerate_options : { delete_normalized_files: false }
    }
}
const response = await data_manager.request({ body: rqo, retries: 1, timeout: 3600 * 1000 })
// response → { result:true, msg:'Success. Request done' }
```

## Related

- [tool_image_rotation](tool_image_rotation.md) — applies rotation + proportional crop to image-component files across all qualities (the standalone rotation tool); `tool_media_versions` exposes rotation inline as a per-quality `specific_action`.
- [tool_posterframe](tool_posterframe.md) — extracts a posterframe/thumbnail from an AV file; complements the AV quality/header management here.
- [tool_upload](tool_upload.md) · [tool_import_files](tool_import_files.md) — get the master file *into* a media component; `tool_media_versions` then manages the derived qualities of that master.
- [Creating new tools](../creating_tools.md) · [Server contract](../server_contract.md) — the tool model, `apiActions`, permission gates and lifecycle this page builds on.
- Source: `tools/tool_media_versions/server/{index,media_versions}.ts`, `tools/tool_media_versions/register.json`, `tools/tool_media_versions/js/{tool_media_versions,render_tool_media_versions}.js`, `tools/tool_media_versions/css/tool_media_versions.less`. The underlying media engines live under `src/core/media/` (see the `dedalo-media-protection` skill).
