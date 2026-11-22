# tool_upload

Ingests a staged browser upload into a media component: moves the temporary file into the `original` tier, generates the type-specific derivatives, and writes the fresh `files_info` back to the record — then exposes a poll wire for the asynchronous AV transcode.

## What it does / why & when to use it

Uploading a media file to Dédalo happens in two phases. First the browser streams the file to a server temporary directory through the `service_upload` service (chunked transfer, validation, progress bar). That leaves a validated file in a scratch location but nothing in the record. `tool_upload` is the **second phase**: `process_uploaded_file` takes the staged file, moves it into the component's `original` quality slot, builds every derived quality the model needs (image/pdf/svg/3d synchronously; AV transcode handed to the media job manager), and persists the updated `files_info` plus the original-file bookkeeping so the client renders the new media rather than the stale placeholder.

Concrete heritage scenario: a cataloguer drops a 180 MB TIFF onto an object's image component. `service_upload` streams it up and fires its completion event; `tool_upload` moves the TIFF into `original`, runs ImageMagick to produce the `default`, `404` and `thumb` web qualities (never upscaling, CMYK→sRGB), and stores the `files_info` so the record's image preview updates in place. For an AV component the video derivatives are transcoded in the background; the client polls `get_job_status` until the job finishes, then re-scans through `tool_media_versions`' `sync_files`.

Use it as: the ingest step behind the media component's upload button and behind other tools that upload a generated file (e.g. `tool_image_rotation`'s background-removal PNG). It is not something an operator invokes directly by name — it is the server action the upload UI calls once a file has been staged.

## How it works (server + client)

**Server** (`tools/tool_upload/server/index.ts`). Two API actions:

- **`process_uploaded_file`** — declaratively gated `permission: 'record', minLevel: 2` (write). It resolves the media tool context (`resolveMediaToolContext`, `src/core/media/tool_support.ts`), reads the staged file descriptor from `options.file_data` (`key_dir`, `tmp_name`, `extension`), and calls the ingest orchestrator `processUploadedFile` (`src/core/media/ingest/process_uploaded_file.ts`). The orchestrator runs `addFile` to move the staged file into the `original` tier (re-validating the extension), then dispatches per model: `regenerateImage` / `regeneratePdf` / `regenerateSvg` / `regenerate3d` inline (awaited — the file copies and encodes are asynchronous, so a large derivative never blocks the event loop), or `submitAvTranscode` for `component_av` (which returns a job id). It re-scans `files_info` and returns it. For a PDF uploaded to `original` it then writes the PDF's text into the related `component_text_area` (overwriting text in the user's data language, reported as an `ingest_notices` line), or, with OCR asked for, returns a deferred OCR job instead — see [component_pdf › Transcription and OCR](../../../core/components/component_pdf.md#transcription-and-ocr). The handler then calls `persistUploadedMedia` (`src/core/media/tools/files_info_persist.ts`) to write the fresh `files_info` and the `original_*` name keys back to the record — without this the disk would hold the new file but the stored media data would still point at the old one. Only after that write commits does it start the AV transcode or the PDF OCR job, because both write `files_info` back to the record themselves.

  **One build per AV component.** Before the move, an AV upload *claims* the ingest transcode's target in the media job manager (`mediaJobs.claimTarget`, `src/core/media/jobs.ts`). The target is component-scoped (`JobTarget.scope = 'component'`, as are the ingest transcode and every per-quality build): it occupies the whole component (section/id/component/lang), as v6's per-component lock file did. When the component already has a live holder (a running or queued transcode, a per-quality build of any tier from `tool_media_versions`, or another upload between its claim and its transcode), the upload is refused with `media.build_running` (409, wire contract `WC-2026-11-22-av-upload-build-running`). The staged file is deleted (`deleteStagedFile`) and nothing in the media tree or the record is touched. The claim is synchronous, so of two concurrent uploads exactly one passes. The transcode job adopts the claim when it starts (`submitAvTranscode` is an *exclusive* submit and refuses the same way when called over a live tier). Every upload route (this tool, `tool_import_files`, `tool_import_zotero`, the acquisition tools, the MCP `upload_media` tool) reaches `processUploadedFile` only through the ingest door `ingestAndPersist` (`src/core/media/ingest/ingest_and_persist.ts`): ingest, persist, then the transcode, with the claim released in a `finally` — a persist that throws would otherwise leave the component refusing every upload and build until the process restarts. `ingest_door_tripwire` holds that no other file imports `processUploadedFile`.

  `process_options` is validated **before** anything is moved. Absent or `null` means no options. The only accepted keys are `ocr` (boolean) and `ocr_lang` (a Dédalo language code, `lg-xxx`, read only when `ocr` is `true`; absent, the request's data language is used). An unknown key, a non-boolean `ocr`, or an OCR language with no Tesseract model is refused with `request.invalid_options`, leaving the staged file untouched: a ticked box either works or is refused, never ignored. The options apply only to a PDF uploaded to `original`; every other upload ignores `ocr`.

- **`get_job_status`** — mounted as `MEDIA_JOB_STATUS_ACTION` (`src/core/tools/job_status.ts`), `permission: null`. It serves the client-shaped `JobStatusFrame` for one media `job_id` (the `job_id` returned by `process_uploaded_file` for an AV transcode or a PDF OCR run). `permission: null` is deliberate: dispatch gates 1–4 already require an authenticated user authorized for the tool, and the job id is an unguessable capability minted by an action that passed the `record` write gate. It is mounted on `tool_upload` because that is the tool that mints the media job ids.

**Client** (`tools/tool_upload/js/`). `tool_upload.js` is the instance; on `init` it subscribes to `upload_file_done_<id>` (published by `service_upload` when a file is fully staged), and on `build` it instantiates the `service_upload` child that renders the drag-and-drop file picker (restricting file types from `caller.context.features.allowed_extensions`). When the upload completes, `upload_done` (`render_tool_upload.js`) shows a spinner and calls `process_uploaded_file_controller`, which assembles the options and dispatches the exported free function `process_uploaded_file` — a `dd_tools_api` / `tool_request` call with `retries: 1` and a `3600 * 1000` ms timeout (large files / slow transcodes). When the response carries a `job_id`, it is handed to the activity tray. `ingest_notices` lines are shown as plain notes beside the success, never through the error renderer: a replaced transcription is not a failure. On success, when the caller is a **component**, it builds a fresh instance of that component and renders a live preview so the operator sees the result without reloading; server error messages are shown with `textContent` (not `innerHTML`) to avoid HTML injection from file paths. `process_uploaded_file` is **exported** so other tools can trigger headless ingest without a full `tool_upload` instance (it guards that its `caller.model === 'tool_upload'`).

## Actions & options

| Action | Gate | Background | Options it reads | Returns |
| --- | --- | --- | --- | --- |
| `process_uploaded_file` | `record`, level 2 | — (AV work runs in the media job manager, not a background fork) | `tipo`, `section_tipo`, `section_id`; `file_data` (`{ key_dir, tmp_name, extension, name, size, type, error }`); `key_dir`; `process_options`; `caller_type`; `quality`; `target_dir` | `{ original_file_name, extension, files_info, derivative_errors, ingest_notices }`, plus the top-level `job_id` — the AV transcode or PDF OCR job id, else `null` |
| `get_job_status` | `null` (dispatch gates 1–4 only) | — | `job_id` | Top-level `JobStatusFrame` fields (`pid`, `pfile`, `is_running`, `data`, `errors`, `total_time`) plus the tool envelope; `{ result:false, errors:['job_not_found'] }` on an unknown id |

`file_data` is the descriptor `service_upload` writes for the staged file; `process_options` carries the upload panel's OCR choice (`{ ocr, ocr_lang }`, see above); `caller_type` (`'tool'` or `'component'`, from the client's `caller.context.type`) lets the client branch its post-processing (component callers render a preview; tool callers do not). `quality` and `target_dir` are optional placement overrides used by callers that redirect where the file lands (e.g. `'modified'` for the background-removal output).

## How it is registered & surfaced

`tools/tool_upload/register.json` is a **column-keyed dump** (a seeded matrix-row snapshot, not a hand-authored file); `importTools()` passes it through as-is (see [register.json reference](../register_json.md)). Essentials it carries:

- `dd1326` name = `tool_upload`; `dd799` label = "Upload" (per project language); `dd612` description = "Upload selected file to the server".
- `dd1327` version = `2.0.3`; `dd1328` minimum Dédalo version = `6.0.0`; `dd1644` developer = "Dédalo team".
- `dd1330` affected_models → the media component models. The tool surfaces on `component_image`, `component_av`, `component_pdf`, `component_3d`, `component_svg` and `component_json` (each lists `tool_upload` in its `samples/context.json` tools array).
- `dd1335` properties = `{ "open_as": "window", "windowFeatures": { "top": 0, "left": "return screen.width -760", "width": 760, "height": 708 } }` → the tool opens in its **own window**.
- `dd1372` labels are empty (`{}`); the UI strings come from the shared `service_upload` service and the framework labels.
- `dd1331` show_in_inspector and `dd1332` show_in_component carry the surfacing flags for the matched component.

Surfacing is element-driven in `getElementTools` (`src/core/tools/registry.ts`): because `affected_models` names the media models, the upload button attaches to those components. In practice it is the ingest engine behind the component's own upload flow, and it is also invoked programmatically by other tools through the exported `process_uploaded_file` free function.

## Examples

Headless ingest from another tool (the shape `tool_image_rotation` sends after background removal), via the exported `process_uploaded_file`:

```js
const api_response = await process_uploaded_file({
    file_data     : file_data,          // descriptor returned by service_upload
    process_options : null,
    caller        : { type: 'tool', model: 'tool_upload' },
    tipo          : self_caller.tipo,        // e.g. 'rsc29' (image component)
    section_tipo  : self_caller.section_tipo, // e.g. 'rsc170'
    section_id    : self_caller.section_id,   // e.g. 1
    caller_type   : self_caller.context.type, // 'tool' or 'component'
    quality       : 'modified',
    target_dir    : null
})
// api_response → { ok:true, data:{ original_file_name, extension, files_info, derivative_errors, ingest_notices }, job_id }
```

A PDF upload with OCR, as `service_upload` sends it when the box is ticked (`rsc37` is the *Document* PDF of the core `rsc2` media section):

```js
process_options : { ocr: true, ocr_lang: 'lg-spa' },
tipo            : 'rsc37',
section_tipo    : 'rsc2',
// api_response.job_id → the 'pdf_ocr' media job; poll it with get_job_status
```

A PDF upload without OCR that replaced an existing transcription answers with a notice such as `scan.pdf: transcription 'rsc38': replaced 1532 chars of existing transcription (lg-spa) — Time Machine keeps the previous version` in `ingest_notices`.

Poll an AV transcode job started by `process_uploaded_file`:

```js
const rqo = {
    dd_api  : 'dd_tools_api',
    action  : 'tool_request',
    source  : create_source(self, 'get_job_status'), // → tool_upload::get_job_status
    options : { job_id: 'av_transcode_1234_5' }
}
const response = await data_manager.request({ body: rqo })
// response → { result:true, msg:'ok', is_running:false, data:{...}, errors:[], total_time: 12.4, ... }
```

The `file_data` descriptor `service_upload` stages (shape read by `process_uploaded_file`):

```json
{
  "error": 0,
  "extension": "tiff",
  "name": "proclamacio.tiff",
  "size": 184922784,
  "tmp_name": "/hd/media/upload/service_upload/tmp/image/upl_a1b2c3",
  "type": "image/tiff"
}
```

## Related

- [tool_media_versions](tool_media_versions.md) — manages the qualities `process_uploaded_file` builds (build, delete, conform headers, `sync_files` to re-scan after an AV transcode finishes).
- [tool_image_rotation](tool_image_rotation.md) — rotates/crops the derived tiers, and calls this tool's `process_uploaded_file` to re-derive after background removal.
- [tool_import_files](tool_import_files.md) — bulk media ingest (many files + their wrapper records) rather than a single component upload.
- [Media pipeline](../../media_pipeline.md) — the end-to-end lifecycle (upload → master → derivatives → protection → diffusion) this action sits at the head of; the `service_upload` service handles phase one.
- [Creating new tools](../creating_tools.md) · [Server contract](../server_contract.md) · [Security](../security.md) — the tool model, `apiActions`, the `MEDIA_JOB_STATUS_ACTION` wire, and the permission rules this tool follows.
- Source: `tools/tool_upload/server/index.ts`, `tools/tool_upload/register.json`, `tools/tool_upload/js/{tool_upload,render_tool_upload}.js`, `tools/tool_upload/css/tool_upload.less`. Ingest core: `src/core/media/ingest/process_uploaded_file.ts`; job wire: `src/core/tools/job_status.ts`.
