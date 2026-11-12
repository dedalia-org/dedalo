# component_av

## Overview

```json
{
    "could_be_translatable" : false,
    "is_literal"            : true,
    "is_related"            : false,
    "is_media"              : true,
    "modes"                 : ["edit","list","tm","search"],
    "default_tools" : [
        "tool_media_versions",
        "tool_posterframe",
        "tool_time_machine",
        "tool_transcription",
        "tool_upload"
    ],
    "render_views" :[
        {
            "view" : "default | line | print",
            "mode" : "edit"
        },
        {
            "view" : "player | viewer",
            "mode" : "edit"
        },
        {
            "view" : "default | text | mini",
            "mode" : "list | tm"
        }
    ],
    "data"        : "array",
    "sample_data" : [
        {
            "id": 3,
            "files_info": [
                {
                    "quality": "original",
                    "extension": "mp4",
                    "file_name": "test94_test3_1.mp4",
                    "file_path": "/av/original/0/test94_test3_1.mp4",
                    "file_size": 14906377,
                    "file_time": { "timestamp": "2025-12-28 20:12:36" },
                    "file_exist": true
                },
                {
                    "quality": "404",
                    "extension": "mp4",
                    "file_name": "test94_test3_1.mp4",
                    "file_path": "/av/404/0/test94_test3_1.mp4",
                    "file_exist": true
                },
                {
                    "quality": "thumb",
                    "extension": "jpg",
                    "file_name": "test94_test3_1.jpg",
                    "file_path": "/av/thumb/0/test94_test3_1.jpg",
                    "file_exist": true
                }
            ],
            "original_file_name": "memoria_oral.mov",
            "original_upload_date": { "timestamp": "2025-12-28 20:12:37" },
            "original_normalized_name": "test94_test3_1.mp4"
        }
    ],
    "value"        : "string (url)",
    "sample_value" : "/av/404/0/test94_test3_1.mp4"
}
```

!!! note "Typology"
    `component_av` is a **media** component. In the TS server it is a lightweight declarative descriptor (`src/core/components/component_av/descriptor.ts` — `{ model: 'component_av', column: 'media' }`) read by the shared horizontal engines; there is no per-model code tree. Like the other media components ([component_image](component_image.md), [component_3d](component_3d.md), [component_pdf](component_pdf.md), [component_svg](component_svg.md)) it does **not** store binary data in the matrix: the `media` column holds a thin JSON pointer (`original_normalized_name` / `modified_normalized_name`), and the live audio/video files live on disk under the configured media root (`config.media.rootPath`). Type-specific behavior (qualities, extensions, folder, FFmpeg-driven conversion/posterframe/subtitle logic) lives in the shared horizontal engine — `src/core/concepts/media.ts` (type catalog), `src/core/media/engine/ffmpeg.ts` + `ffmpeg_profiles.ts` (transcode/posterframe/probe), `src/core/media/processing.ts`, `src/core/media/ingest/process_uploaded_file.ts` (`submitAvTranscode`) — not a per-type class.

!!! info "About `default_tools`"
    The set above is verified from an instance `context.tools` sample. AV instances ship a richer toolbar than the still-media components: `tool_upload` (binds files), `tool_media_versions` (rebuild qualities, `conform_headers`), `tool_posterframe` (set the preview frame), `tool_transcription` (open the timecoded transcription editor) and `tool_time_machine`. The toolbar is assembled from the model + ontology, not hardcoded; server-side each tool is a registered module (`tools/tool_upload/server/`, `tools/tool_media_versions/server/`, `tools/tool_posterframe/server/`, `tools/tool_transcription/server/`, `tools/tool_time_machine/server/`).

!!! warning "Translatability"
    The media file itself is **not** translatable (`translatable: false`, language `lg-nolan`). The *subtitle* track, however, is per-language: subtitles are stored as one VTT file per language (`{id}_{lang}.vtt`) and the edit datum carries a `subtitles` block for the current `DEDALO_DATA_LANG`.

## Definition

`component_av` manages audio and video media in Dédalo: upload, on-disk storage, quality/version generation, poster-frame previews, subtitle tracks and timecode (TC) processing. It is the media component for any catalogue field that holds a recording rather than a still image.

**Why it exists.** Cultural-heritage archives routinely catalogue moving image and sound: an oral-history interview, a recorded performance, an ethnographic field recording, a conservation video, a digitised reel. These assets need a normalised playable format, lighter derivative qualities for streaming, a poster frame for list previews, and — crucially for oral archives — the ability to anchor a transcription to exact timecodes. `component_av` provides all of that on top of the shared media engine, driving FFmpeg (`src/core/media/engine/ffmpeg.ts`) to transcode uploads into Dédalo's standard MP4 format while preserving the original file untouched.

**When to use it.**

- Oral-history / interview recordings, with a synchronised [component_text_area](component_text_area.md) transcription that jumps the player to a clicked timecode.
- Video documentation of objects, sites, performances or conservation processes.
- Audio recordings (music, speech, field recordings) — audio uploads always also generate a dedicated `audio` quality.
- Any asset that needs a downloadable clip/fragment (`download_fragment`) cut between two timecodes, optionally watermarked.

**When not to use it.**

- Still images, scans or photographs -> use [component_image](component_image.md).
- Vector drawings / line art -> use [component_svg](component_svg.md).
- Documents (catalogues, reports) -> use [component_pdf](component_pdf.md).
- 3D models -> use [component_3d](component_3d.md).
- A plain URL pointing at an external video that Dédalo should not ingest -> use [component_iri](component_iri.md) (or wire it as the `external_source` of a media component).

## Data model

**Data:** `array` (normally a single element, key `0`). The element describes the source files plus the reconstructed `files_info`.

**Value:** the displayable URL `string` (default quality in `edit`, poster-frame URL in `list`/`tm`), or `null` when no file exists.

**Storage shape.** A component never touches the database; it reads and writes through its section, which stores the component data in its matrix `media` column (`src/core/section/read.ts`, `src/core/section/record/save_component.ts`). For `component_av` the **persisted** element is intentionally thin — it records only what cannot be reconstructed from disk:

```json
[
    {
        "original_file_name"       : "memoria_oral.mov",
        "original_normalized_name" : "test94_test3_1.mp4",
        "original_upload_date"     : { "timestamp": "2025-12-28 20:12:37" }
    }
]
```

`original_normalized_name` (and, when an edited master exists, `modified_normalized_name`) is the deterministic filename of the source file kept under its own quality folder; derived qualities are generated from it. `original_file_name` keeps the human filename the user uploaded.

At read time `scanFilesInfo()` (`src/core/media/files_info.ts`) rebuilds the live picture by scanning disk: for every configured quality and every allowed/alternative extension it calls `getQualityFileInfo()` and keeps the entries whose file exists. Each `files_info` object looks like:

```json
{
    "quality"   : "404",
    "extension" : "mp4",
    "file_name" : "test94_test3_1.mp4",
    "file_path" : "/av/404/0/test94_test3_1.mp4",
    "file_size" : 722370,
    "file_time" : { "timestamp": "2025-12-28 19:58:33" },
    "file_exist": true
}
```

When the media lives **outside** Dédalo (the `external_source` property points at a [component_iri](component_iri.md) holding the URL), `getQualityFileInfo()`/`scanFilesInfo()` return an entry flagged `"external": true` whose `file_path` is the external URL, and disk scanning is bypassed — the scanner already accepts an `externalSource` override for any media type. What the TS read path does **not yet** do is surface the resolved `external_source` value on the AV datum itself: `src/core/section/read.ts` only calls `resolveExternalSource()` for `component_image` today, so an AV component configured with `external_source` will scan correctly at the engine level but the API datum won't carry the `external_source` field the client's edit view expects. Ledgered gap.

!!! note "Datum vs. API `entries`"
    The transmitted unit is a `{context, data}` datum. In the API payload the data element is surfaced under `data.entries[0]`, and the controller appends `posterframe_url` and (in `edit`) a `subtitles` block (`subtitles_url`, `lang`, `lang_name`) — emitted by the media emit hook (`src/core/media/component_emit.ts`). `context` additionally carries a `features` block describing the instance media capabilities: `allowed_extensions`, `default_target_quality` (`original`), `ar_quality`, `default_quality` (`404`), the current `quality`, `key_dir` (`av`), `alternative_extensions` and `extension` (`mp4`) — built by `buildMediaFeatures()` (`src/core/section/media_features.ts`) and wired into the structure context by `structure_context.ts`. The VTT subtitle file the `subtitles_url` points at is built and written to disk by the `tool_transcription` action `build_subtitles_file` (`tools/tool_transcription/server/index.ts`), which calls the pure WEBVTT builder `buildSubtitlesText()` (`src/core/media/tools/subtitles.ts`) and writes the result through the shared subtitles path grammar (`subtitlesPath()`/`subtitlesUrl()`, `src/core/media/path.ts`).

### Qualities and the original model

`component_av` declares its quality model from config, mirrored on the TS side by `mediaTypeOf('component_av')` (`src/core/concepts/media.ts`, backed by `config.media.av`):

- `qualities` -> `DEDALO_AV_AR_QUALITY` = `["original","1080","720","576","404","240","audio"]`.
- `defaultQuality` -> `DEDALO_AV_QUALITY_DEFAULT` = `"404"` (the served streaming quality).
- `originalQuality` -> `DEDALO_AV_QUALITY_ORIGINAL` = `"original"`.
- the `audio` quality is generated on original upload, when the source carries an audio stream (`submitAvTranscode()`, `src/core/media/ingest/process_uploaded_file.ts`).
- `thumbQuality()` -> `"thumb"` (a JPG), generated from the poster frame.
- `defaultExtension` -> `DEDALO_AV_EXTENSION` = `"mp4"`; `allowedExtensions` -> `DEDALO_AV_EXTENSIONS_SUPPORTED` (mp4, mov, avi, mpeg, wav, mp3, vob, zip, …).

The uploaded file is preserved under the `original` quality folder keeping its source extension (e.g. `.mov`); the playable `404` quality is transcoded from it by a **real two-pass libx264 ffmpeg pipeline** (`transcodeTwoPass()`, `src/core/media/engine/ffmpeg.ts`, argv-only — no shell — driven by the 39-profile table in `ffmpeg_profiles.ts`), run through the supervised job manager (`src/core/media/jobs.ts`) since AV transcodes are backgrounded. AV adds two media artefacts beyond the still-media components:

- **Poster frame** — a JPG (`DEDALO_AV_POSTERFRAME_EXTENSION`) stored under `{folder}/posterframe{additional_path}/`. Created by `createAvPosterframe()` (`src/core/media/tools/posterframe.ts`, via `createPosterframe()` in `engine/ffmpeg.ts`, at the requested timecode) and written atomically; `buildThumbVersion()` then rasterises it into the `thumb` quality. **It is also MINTED automatically** whenever a thumbnail is needed and none exists — on upload of a new master, from the media-versions thumb gear, and from the repair sweep — at `min(10s, duration/2)` — half-way into anything shorter than ten seconds, so a brief clip is never sampled past its end (`mintPosterframe()`). An audio-only file has no frame to take, and the refusal says so. A new master retires the previous posterframe and thumb before the new pair is built: a still of a video the record no longer holds is worse than none.
- **Subtitles** — one VTT (`DEDALO_AV_SUBTITLES_EXTENSION`) per language under `{folder}{DEDALO_SUBTITLES_FOLDER}/`, named `{id}_{lang}.vtt`. Built from a TC-tagged transcript by `buildSubtitlesText()` (`src/core/media/tools/subtitles.ts`) and written to disk by the `tool_transcription` `build_subtitles_file` action (see *Datum vs. API `entries`* above); the target subtitles directory must already exist — the action does not create it.

### Naming and storage paths

Filenames are deterministic: `id . '.' . extension`, where `id = {component_tipo}_{section_tipo}_{section_id}` (AV is non-translatable, so no `_lang` suffix on the media file), built by `buildMediaIdentifier()` (`src/core/media/path.ts`). The quality path is

```text
DEDALO_MEDIA_PATH + folder + initial_media_path + '/' + quality + additional_path
```

computed by `buildMediaLocation()` (same module) and confined inside the media root by `assertInsideMediaRoot()`. `folder` is `DEDALO_AV_FOLDER` (`/av`, `config.media.av.folder`); `initial_media_path` comes from the section's ontology properties (`resolveMediaPathOptions()`, `src/core/media/ontology_path.ts`) and `additional_path` is bucketed by `max_items_folder` (e.g. `/0`, `/1000`, `/2000`). Client-supplied quality strings are validated by `assertValidQuality()` (`src/core/concepts/media.ts`, SEC-065 strengthened: charset **and** ladder membership) so they can never escape the media tree.

## Ontology instantiation

A `component_av` is created as an ontology node whose `model` is `component_av`. Its `parent` is the section (or grouper) it belongs to, and its `section_tipo` wires it into that section. Being a media component it is normally declared non-translatable.

Node definition (shape):

```json
{
    "tipo"         : "rsc167",
    "model"        : "component_av",
    "parent"       : "rsc197",
    "section_tipo" : "rsc197",
    "lg-eng"       : "Audiovisual",
    "lg-spa"       : "Audiovisual",
    "translatable" : false,
    "properties"   : { }
}
```

Realistic `properties` block for an oral-history recording wired to a timecoded transcription, that also names a sibling text field for the uploaded filename and buckets files by 1000:

```json
{
    "max_items_folder" : 1000,
    "target_filename"  : "rsc53",
    "observe": [
        {
            "client": { "event": "click_tag_tc", "perform": { "function": "go_to_time" } },
            "component_tipo": "rsc171"
        },
        {
            "client": { "event": "key_up_esc", "perform": { "function": "play_pause" } },
            "component_tipo": "rsc171"
        },
        {
            "client": { "event": "key_up_f2", "perform": { "function": "get_data_tag" } },
            "component_tipo": "rsc171"
        }
    ]
}
```

`section_tipo` / `parent` tell the section which column owns this component's data; on save the data flows through the section's record save path, the single writer to the database. The media files themselves are written to disk by the upload flow (below); the save itself only refreshes the thin pointer element and triggers the list-value recomputation.

## Properties & options

All properties are optional and live in the ontology node `properties` JSON. Verified names consumed by this component (and its media base):

### target_filename

- **Values:** a component tipo (string) — normally a [component_input_text](component_input_text.md) in the same section.
- **Effect:** on upload of the `original` quality, this property is meant to name a sibling component that receives the human upload filename (e.g. `memoria_oral.mov`). **Not yet wired in the ingest path**: `processUploadedFile()` (`src/core/media/ingest/process_uploaded_file.ts`) records the upload's original filename on the media item itself but does not write it back to a `target_filename` sibling component; that role is honoured today only by the bulk `tool_import_files` matcher (`src/core/tools/import_files_match.ts`). Ledgered gap for the interactive-upload path.

### external_source

- **Values:** a component tipo (string) pointing at a [component_iri](component_iri.md) in the same section.
- **Effect:** when set, the playable source is read from that IRI instead of Dédalo's media tree. `scanFilesInfo()` (`src/core/media/files_info.ts`) already returns an `"external": true` entry when given an `externalSource` override. **Gap:** the media emit hook only resolves and surfaces `external_source` on the API datum for `component_image` today (`resolveExternalSource()` in `src/core/media/component_emit.ts`, called only when `model === 'component_image'`); AV items don't yet carry it on read, and the diffusion external-URL branch is not yet ported for AV.

### initial_media_path

- **Values:** object keyed by component tipo -> path string (e.g. `{"rsc167": "/my_custom_name"}`), declared on the **section** node.
- **Effect:** inserts a fixed path segment between `folder` and `quality`, letting an instance store its files in a custom sub-tree. Read by `resolveMediaPathOptions()` (`src/core/media/ontology_path.ts`) and applied by `buildMediaLocation()` (`src/core/media/path.ts`) — one implementation shared by all five media models.

### max_items_folder

- **Values:** integer (commonly `1000`).
- **Effect:** buckets files into numbered sub-folders (`additional_path` becomes `/0`, `/1000`, `/2000`, … by `floor(section_id / max_items_folder) * max_items_folder`) so a single directory never holds an unbounded number of files. Ported as `additionalPath()` (`src/core/media/path.ts`), fed from ontology by `resolveMediaPathOptions()`.

### observe / observers

- **Values:** array of observe/observable descriptors (`{client: {event, perform: {function}}, component_tipo}`).
- **Effect:** client-side event wiring. The AV player exposes the functions that transcription components drive: `go_to_time` (jump to a clicked `[TC ...]` tag, event `click_tag_tc`), `play_pause` (event `key_up_esc`) and `get_data_tag` (build a TC tag at the current frame, event `key_up_f2`). The observable side (a [component_text_area](component_text_area.md) transcription) publishes these events; the AV component subscribes. See *Observers and observables* on the [index page](index.md).

!!! note "Standard context properties"
    Like every component, `component_av` honours the generic ontology context blocks carried into the datum `context`: `css` (stamped on `.wrapper_component`), `request_config` (RQO) and `view` (the render view). These are not component-specific options. Any other custom key seen in production should be verified in the ontology.

## Render views & modes

Views are selected from `context.view` (default `default`) and dispatched per mode. Verified from the JS render files and LESS:

| View | edit | list / tm | search | Notes |
| --- | :---: | :---: | :---: | --- |
| `default` | yes | yes | (via search render) | Poster frame + HTML5 video/audio player with upload UI and player controls. |
| `line` | yes | — | — | Compact inline variant of the default edit view (label hidden in list). |
| `print` | yes | — | — | Forces read-only (`permissions = 1`) and reuses the default edit render. |
| `player` | yes | — | — | Full interactive player surface (`view_player_edit_av`): control buttons, SMPTE timecode readout, TC capture; used by the transcription workflow and `open_av_player`. Label hidden. |
| `viewer` | yes | — | — | Full-screen black viewer (`view_viewer_edit_av`) with a download button; opened in a separate window (e.g. fragment review). |
| `text` | — | yes | — | Plain textual representation of the value (`view_text_list_av`). |
| `mini` | — | yes | — | Minimal thumbnail (`component_av_mini`, JPG thumb), e.g. service autocomplete / grids. |

Modes:

- **edit** — read/write a real record: upload, generate/rebuild qualities, set the poster frame, manage subtitles, drive the player. The datum carries `posterframe_url` and a per-language `subtitles` block.
- **list / tm** — read-only listing. The list value keeps only the `default_quality` (`404`) and `thumb` `files_info` entries; the value shown is the poster-frame URL. `tm` (Time Machine) reuses the list render and resolves the last deleted file under the `/deleted` folder.
- **search** — one text input per filter feeding the SQO through the shared search builders (`src/core/search/conform.ts`); saves are blocked.

## Import / export model

**Import.** Media import is unusual: there are no inline binaries in a CSV. The thin pointer element can be supplied as the JSON shape used in storage (the array with `original_normalized_name` etc.), but normally AV is populated through the **upload flow**, not the row importer. Non-JSON plain strings are not value-property data for media and are rejected rather than stored. See [importing data](../../using/importing_data.md). Bulk file import (matching files to existing records by filename) is a separate path, `tool_import_files` (`tools/tool_import_files/server/index.ts`).

Upload flow (the real ingestion path), in order:

1. Multipart/chunked receiver — the API dispatch's multipart branch (`src/server.ts`) hands off to `handleMediaUpload()` (`src/core/media/ingest/upload_endpoint.ts`): session + CSRF required, chunked join with a re-sniff of the assembled file, magic-byte MIME sniffing (`src/core/media/engine/mime.ts`) — never trusts the client-declared MIME type.
2. `tool_upload.process_uploaded_file` (`tools/tool_upload/server/index.ts`) — permission-gated (write level ≥ 2), resolves the media context and calls the ingest orchestrator.
3. `addFile()` (`src/core/media/ingest/add_file.ts`) — confines the staged source, validates the extension, backs up any existing target via `renameOldFiles()`, moves the file into the `original` quality tier.
4. `processUploadedFile()` (`src/core/media/ingest/process_uploaded_file.ts`) — for AV, calls `submitAvTranscode()`: builds the default (`404`) quality via a real two-pass ffmpeg transcode and the `audio` quality (when an audio stream exists) through the job manager (`src/core/media/jobs.ts`), then re-scans `files_info`. **Not yet implemented**: writing the original filename back to a `target_filename` sibling component (see *Properties & options*). The poster frame and thumb ARE part of this flow since 2026-08-08 — the ingest mints them from the file just uploaded, without waiting for the transcode — while `tool_posterframe` remains the way to choose a specific frame.

**Export.** The export path (`src/diffusion/export/atoms.ts`) emits a single atom (`cell_type: 'img'`) whose value is the default-quality URL in `edit` mode, or the poster-frame URL otherwise; URL absoluteness comes from the `export_context`. In diffusion the value reduces to the default-quality URL (or `{id}.{extension}` when `DEDALO_PUBLICATION_CLEAN_URL` is on), or the `external_source` URL when the media is external. See [exporting data](../../using/exporting_data.md). **Not yet ported:** clip download (`download_fragment` on `dd_component_av_api`) — the argv recipe exists (`buildFragmentArgv()`, `src/core/media/engine/ffmpeg.ts`) but no API action wraps it yet, so the client's fragment-download button has no server-side handler on the TS engine.

## Notes

- **Observers / observables.** AV ships **no** `events_subscription.js`; all event wiring is declared in the ontology `properties.observe` (see above). The transcription editor publishes `click_tag_tc` / `key_up_esc` / `key_up_f2`; the AV player subscribes and runs `go_to_time` / `play_pause` / `get_data_tag`.
- **Default tools.** A typical instance exposes `tool_upload`, `tool_media_versions`, `tool_posterframe`, `tool_transcription` and `tool_time_machine` in `context.tools` (read-only context). `create_posterframe`/`delete_posterframe` for AV are registered as `dd_component_av_api` actions in `src/core/api/dispatch.ts` (not through the tool registry) — the "Create/Delete posterframe" buttons call those directly; `get_media_streams` (ffprobe stream metadata for the player) is registered alongside them.
- **Access control.** Media file access is enforced natively: `src/core/media/protection.ts` maintains a daily-rotated `dedalo_media_auth` auth-marker store for logged-in users (a cookie whose value must exist as a marker file under `<media>/.publication/auth/`) and consumes `.publication/pub/{section_tipo}_{section_id}` markers — written by the diffusion media index (`src/diffusion/targets/mediastore/media_index.ts`) — for anonymous publication reads. Both rules are enforced by the web server itself via generated Apache/nginx rule files (one `stat()` per request), never by the Bun process, and fail closed as 404. Separately, an optional dev-only session-gated fallback route exists for local development (`src/server.ts`, gated behind `MEDIA_DEV_ROUTE_ENABLED`); it applies no per-record ACL and must never be enabled in a shared or production environment.
- **Deletion / restore.** `moveToDeleted()` / `renameOldFiles()` (`src/core/media/file_ops.ts`) rename files into a `/deleted` folder rather than hard-deleting, using two datestamp formats (`Y-m-d_Hi` for per-file moves, `Y-m-d_Gis` for the section-delete path, `src/core/section/record/delete_record.ts`). `listDeletedVersions()` (the natural-sort scan that would recover the newest deleted file for Time Machine) exists as a primitive but is **not yet wired** into the TM restore path or the read path's `tm`-mode URL resolution — a soft-deleted AV file is not automatically re-surfaced by either yet. Ledgered gap.
- **DVD / VOB.** Unpacking zipped `VIDEO_TS`/`AUDIO_TS` disc structures and VOB size summation are not implemented; only the `zip` extension is in the allowed-extensions list.
- **Related components:** [component_image](component_image.md), [component_3d](component_3d.md), [component_pdf](component_pdf.md), [component_svg](component_svg.md), [component_iri](component_iri.md), [component_text_area](component_text_area.md), [component_input_text](component_input_text.md).
