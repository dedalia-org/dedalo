# component_3d

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
        "tool_upload"
    ],
    "render_views" :[
        {
            "view" : "default | line",
            "mode" : "edit"
        },
        {
            "view" : "default | column | mini | text",
            "mode" : "list | tm"
        },
        {
            "view" : "default",
            "mode" : "search"
        }
    ],
    "data"        : "array (single item)",
    "sample_data" : [
        {
            "id": 4,
            "files_info": [
                {
                    "quality": "original",
                    "extension": "glb",
                    "file_name": "test26_test3_1.glb",
                    "file_path": "/3d/original/0/test26_test3_1.glb",
                    "file_size": 4780672,
                    "file_time": { "timestamp": "2025-12-25 22:53:39" },
                    "file_exist": true
                },
                {
                    "quality": "web",
                    "extension": "glb",
                    "file_name": "test26_test3_1.glb",
                    "file_path": "/3d/web/0/test26_test3_1.glb",
                    "file_exist": true
                },
                {
                    "quality": "thumb",
                    "extension": "jpg",
                    "file_name": "test26_test3_1.jpg",
                    "file_path": "/3d/thumb/0/test26_test3_1.jpg",
                    "file_exist": true
                }
            ],
            "original_file_name": "venus_statue.glb",
            "original_upload_date": { "timestamp": "2025-12-25 22:53:39" },
            "original_normalized_name": "test26_test3_1.glb"
        }
    ],
    "value"        : "string (url) | null",
    "sample_value" : "/3d/web/0/test26_test3_1.glb"
}
```

!!! note "Typology"
    `component_3d` is a **literal-media** component. A model is a lightweight declarative descriptor — here `src/core/components/component_3d/descriptor.ts`, `{ model: 'component_3d', column: 'media' }` — read by the shared horizontal engines; there is no per-model code tree. It does **not** store binary data in the section matrix; the matrix `media` column holds a thin JSON pointer to the 3D files on disk. The type-specific behavior — the `DEDALO_3D_*` quality catalog, the posterframe handling, the conversion hook — lives in `src/core/concepts/media.ts` (the type catalog), `src/core/media/path.ts` / `files_info.ts` (path grammar + disk scan), `src/core/media/processing.ts` (`regenerate3d`) and `src/core/media/tools/posterframe.ts`; the structural machinery (path building, `files_info` scanning, upload binding, versioning) is shared by all five media models, not duplicated per type.

!!! info "About `default_tools`"
    The list above is what a 3D instance receives in `context.tools` (verified from the model sample `src/core/components/component_3d/samples/context.json`): `tool_media_versions`, `tool_posterframe`, `tool_time_machine` and `tool_upload`. The toolbar is assembled from the model + ontology; nothing hardcodes it. Server-side each of these is a registered module under `tools/tool_media_versions/server/`, `tools/tool_posterframe/server/`, `tools/tool_time_machine/server/`, `tools/tool_upload/server/` (see the *dedalo-tools* skill).

## Definition

`component_3d` manages **3D model files** as a media field of a section. It handles upload, on-disk storage, quality/versioning, a still **posterframe** image (and a raster thumbnail derived from it for list views), and serves the displayable file URL for an interactive WebGL viewer. The client renders the model in `edit` mode with a three.js-based viewer (`client/dedalo/core/component_3d/js/viewer/viewer.js`, loaded via the `three` import map); `list`/`tm`/`search` show the lightweight poster/thumb image instead of loading the heavy model.

**Why it exists.** Cultural-heritage collections increasingly include 3D captures of objects — photogrammetry or laser-scan models of sculptures, ceramics, coins, architectural fragments, archaeological finds. These need first-class management (versioned originals, a web-optimised delivery copy, a preview still) exactly like images or audiovisual files, but with a vector/mesh payload and an interactive viewer rather than a flat raster. `component_3d` is the field type for that payload.

**When to use it.**

- A record needs an interactive 3D model the cataloguer uploads and the public can rotate/zoom: *3D model of a statue*, *Scan of a vessel*, *Photogrammetry of a relief*.
- The source comes from a scanning/modelling pipeline as `.glb`, `.gltf`, `.obj`, `.fbx`, `.dae` (or a `.zip` bundle), and you want Dédalo to keep the original plus a `web` delivery copy and a still preview.

**When not to use it.**

- A flat raster photograph of the object → use `component_image`.
- Audio or video documentation → use `component_av`.
- A vector drawing / line art for inline embedding → use [component_svg](component_svg.md).
- A document (catalogue sheet, report) → use `component_pdf`.

## Data model

**Data:** `array` with a **single item** (`data[0]`). The item is an object carrying the source-file descriptors (`original_file_name`, `original_normalized_name`, `original_upload_date`) plus the live `files_info` array, which the read path reconstructs from disk on every read.

**Value:** `string` (the default-quality file URL) or `null`. As with every component the stored unit is an array; the displayable value is derived from it.

**Storage shape.** A component never touches the database directly; it reads and writes through its section, which stores the component data in the section matrix `media` column (`src/core/section/read.ts`, `src/core/section/record/save_component.ts`). For `component_3d` the persisted item describes the **source filenames**, not the renderable files — the renderable picture (`files_info`) is reconstructed at read time by `scanFilesInfo()` (`src/core/media/files_info.ts`), which scans disk per quality and extension. Because 3D is non-translatable, the single item lives in the `lg-nolan` slot.

Stored item (on disk, before files_info is recomputed — see `src/core/components/component_3d/samples/data.json`):

```json
[
    {
        "id": 4,
        "original_file_name": "venus_statue.glb",
        "original_normalized_name": "test26_test3_1.glb",
        "original_upload_date": { "timestamp": "2025-12-25 22:53:39" },
        "files_info": [
            { "quality": "original", "extension": "glb", "file_name": "test26_test3_1.glb", "file_path": "/3d/original/0/test26_test3_1.glb", "file_exist": true },
            { "quality": "web",      "extension": "glb", "file_name": "test26_test3_1.glb", "file_path": "/3d/web/0/test26_test3_1.glb",      "file_exist": true },
            { "quality": "thumb",    "extension": "jpg", "file_name": "test26_test3_1.jpg", "file_path": "/3d/thumb/0/test26_test3_1.jpg",    "file_exist": true }
        ]
    }
]
```

API datum (surfaced under `data.entries` — see `src/core/components/component_3d/samples/api_data.json`): the same item plus a top-level `posterframe_url` and, in `edit` mode, a `media_info` field (the media-streams header, currently `false` for 3D).

!!! note "Naming & storage path"
    The on-disk filename is deterministic: `id . '.' . extension`, where `id = {component_tipo}_{section_tipo}_{order_id}` (e.g. `test26_test3_1.glb`). The full path is `DEDALO_MEDIA_PATH + folder + initial_media_path + '/' + quality + additional_path + '/' + file_name`. `folder` is `DEDALO_3D_FOLDER` (`/3d`, `config.media.threeD.folder`); `initial_media_path` / `additional_path` come from section/component properties (see *Properties & options*). In the TS server this whole grammar is computed by `buildMediaIdentifier()` / `buildMediaLocation()` (`src/core/media/path.ts`), and every resulting absolute path is confined inside the media root by the single `assertInsideMediaRoot()` chokepoint; the quality string itself is validated by `assertValidQuality()` (`src/core/concepts/media.ts`, SEC-065 strengthened — charset **and** ladder membership, not just charset). The posterframe lives in a sibling `posterframe` quality folder: `DEDALO_3D_FOLDER + '/posterframe' + additional_path + '/' + id . '.jpg'` (`src/core/media/tools/posterframe.ts`).

## Ontology instantiation

A `component_3d` is created as an ontology node whose `model` is `component_3d`. Its `parent` is the section (or grouper) it belongs to, and its `section_tipo` wires it into that section. The node declares its label through the standard `lg-*` terms; it is non-translatable, so `translatable` is `false` (and may be omitted, since media is non-translatable by default).

Node definition (shape):

```json
{
    "tipo"         : "test26",
    "model"        : "component_3d",
    "parent"       : "test3",
    "section_tipo" : "test3",
    "lg-eng"       : "3D model",
    "lg-spa"       : "Modelo 3D",
    "translatable" : false,
    "properties"   : { }
}
```

Realistic `properties` block — split the on-disk storage into folders of at most 1000 records and give the field a wide grid span:

```json
{
    "max_items_folder" : 1000,
    "css" : {
        ".wrapper_component": { "grid-column": "span 12" }
    }
}
```

`section_tipo` / `parent` tell the section which column owns this component's data; on save the data flows through the section's record save path, which is the single writer to the database. The 3D **files** themselves are written to disk by the upload pipeline and the conversion hooks, not by the section save.

## Properties & options

All properties are optional and live in the ontology node `properties` JSON. Verified names consumed by `component_3d` and the shared media engine:

### max_items_folder

- **Values:** integer (commonly `1000`).
- **Effect:** controls the on-disk fan-out. When no explicit `additional_path` is configured, the bucket is derived as `'/' . max_items_folder * floor(section_id / max_items_folder)` (e.g. record 1 → `/0`, record 1500 → `/1000`). Keeps directories from accumulating an unbounded number of files. Ported as `additionalPath()` in `src/core/media/path.ts`, fed from ontology by `resolveMediaPathOptions()` (`src/core/media/ontology_path.ts`, reading `properties.max_items_folder`). If unset and no `additional_path` is given, no extra subfolder is added.

### additional_path

- **Values:** a component `tipo` (e.g. an `component_input_text` column in the same section).
- **Effect:** when present, this property is meant to source the subfolder from that sibling component's current value for the record (normalised to a leading slash, no trailing slash), taking precedence over `max_items_folder`. `buildMediaLocation()` (`src/core/media/path.ts`) already accepts a pre-resolved `additionalPathOverride`, but `resolveMediaPathOptions()` (`src/core/media/ontology_path.ts`) does **not yet** read a sibling component's value into it — today the path builder only honours the `max_items_folder` numeric bucket for `component_3d`. A component configured with `additional_path` instead of (or ahead of) `max_items_folder` will resolve to the wrong bucket until this ontology lookup is wired. Ledgered gap.

### initial_media_path

- **Values:** string (verify in ontology), declared on the **section** node, keyed by component `tipo`.
- **Effect:** an extra path segment inserted between `folder` and the quality folder. Read by `resolveMediaPathOptions()` (`src/core/media/ontology_path.ts`) from the section's `properties.initial_media_path[component_tipo]` and applied by `buildMediaLocation()` (`src/core/media/path.ts`).

### external_source

- **Values:** a component `tipo` (typically a `component_iri`) in the same section.
- **Effect:** marks the media as living **outside** Dédalo. `scanFilesInfo()` (`src/core/media/files_info.ts`) already accepts an `externalSource` override and emits an `external:true` entry, and `resolveMediaToolContext()` reads it for tool calls — but the emit hook only **surfaces** the resolved `external_source` value on the API datum for `component_image` today (`src/core/media/component_emit.ts`, `resolveExternalSource()`, called only when `model === 'component_image'`); `component_3d` items do not yet carry it in list/edit reads. Ledgered gap.

### target_filename

- **Values:** a component `tipo` (e.g. a `component_input_text` "Original file name").
- **Effect:** when the stored item has no `original_file_name`, this property is meant to name a sibling component whose value populates `original_file_name` / `original_normalized_name` / `original_upload_date`. The ingest orchestrator (`processUploadedFile()`, `src/core/media/ingest/process_uploaded_file.ts`) records the upload's own filename/date but does **not yet** read or write a `target_filename` sibling component on upload; `target_filename` is honoured today only by the bulk `tool_import_files` matcher (`src/core/tools/import_files_match.ts`). Ledgered gap for the interactive-upload path.

!!! note "Standard context properties"
    Like every component, `component_3d` also honours the generic ontology context blocks carried into the datum `context`: `css` (style stamped on `.wrapper_component`), `request_config` (RQO) and `view` (the render view to use). These are not component-specific options. Any other custom key seen in production should be verified in the ontology.

!!! info "Qualities are config, not properties"
    The quality model is fixed in config, not in node `properties`: `DEDALO_3D_AR_QUALITY = ['original','web']`, `DEDALO_3D_QUALITY_ORIGINAL = 'original'`, `DEDALO_3D_QUALITY_DEFAULT = 'web'`, plus a `thumb` quality. Supported upload extensions are `DEDALO_3D_EXTENSIONS_SUPPORTED = ['glb','gltf','obj','fbx','dae','zip']`; the canonical/best delivery extension is `glb` (`DEDALO_3D_EXTENSION`). These are read through `mediaTypeOf('component_3d')` (`src/core/concepts/media.ts`), itself built from the env-based config catalog (`config.media.threeD`, `src/config/config.ts`) under the same `DEDALO_*` key names/defaults — never hardcoded in a module body. The `context.features` block the client edit view reads is built separately by `buildMediaFeatures()` (`src/core/section/media_features.ts`).

## Render views & modes

Views are selected from `context.view` (default `default`) and dispatched by the per-mode render files. Verified from `client/dedalo/core/component_3d/js/`:

| View | edit | list / tm | search | Notes |
| --- | :---: | :---: | :---: | --- |
| `default` | yes | yes | yes | edit: full interactive three.js viewer (`view_default_edit_3d`) with quality selector, control buttons and posterframe fallback; list: poster/thumb `<img>` (`view_default_list_3d`); search: a text `input` filter (`render_search_component_3d`). |
| `line` | yes | — | — | Compact edit variant; the label node is suppressed, otherwise renders the default edit view. |
| `column` | — | yes | — | Falls through to the `default` list view. |
| `mini` | — | yes | — | Minimal `<img>` thumbnail (`view_mini_list_3d`), `component_3d_mini`. |
| `text` | — | yes | — | Small inline `<img>` (`view_text_list_3d`). |
| `print` | yes | — | — | Reuses the edit render but forces read-only (`permissions = 1`). |

Modes:

- **edit** — read/write. Loads the three.js viewer to display the `web`-quality model interactively; a quality selector lists the existing `glb` files; the posterframe image is the fallback/preview. `tool_upload` binds a new model; `tool_posterframe` **and the media-versions panel's thumb gear** both capture a still the same way (the client renders the current view to a JPG, uploads it and calls the `dd_component_3d_api` action `move_file_to_dir`, which also builds the thumb and persists `files_info`). Both wait for the viewer to finish mounting — `component_3d.ensure_viewer()` — because the scene loads lazily. A new model upload retires the previous posterframe and thumb: nothing here can re-render a mesh, so the record shows its placeholder until the browser captures the new scene.
- **list / tm** — read-only. `tm` (Time Machine) reuses the list render. Both show the still image (thumb, falling back to posterframe), never the heavy model.
- **search** — builds a simple text filter input; one `input` per filter, publishing `change_search_element`.

DOM (edit / default): `wrapper_component component_3d <tipo> edit media_wrapper` → `label`, `buttons`, `content_data.media_content_data` → `content_value` (canvas viewer + `posterframe` + control buttons).

## The WebGL viewer

The interactive viewer (`client/dedalo/core/component_3d/js/viewer/viewer.js`) is the only part of `component_3d` that depends on a third-party browser library. It is **lazily loaded**: the edit view shows the posterframe still immediately and imports the viewer only when the component scrolls into the viewport, so a record with a 3D field costs nothing until it is looked at.

`three` and `three/addons/` are bare specifiers resolved by the import map in `client/dedalo/core/page/index.html`, which points at the package served through the client-lib registry (`src/core/client_libs/registry.ts`). The library is package-manager tracked, and this engine takes the **latest stable** version by policy — so an upstream API rename is a routine event, not an exceptional one.

!!! warning "A removed export takes the whole viewer down, silently"
    The viewer's `three` imports are **named** imports. If upstream removes or renames one of them, the module fails to load *in its entirety* — there is no partial degradation and no thrown error the component can catch. What the cataloguer sees is an edit view that renders only the static posterframe image, with no canvas and no controls; and because posterframe capture needs a live viewer, **uploading a 3D file then silently produces no posterframe**.

    This happened: three r152 renamed the colour-space constants (`sRGBEncoding` → `SRGBColorSpace`, `renderer.outputEncoding` → `renderer.outputColorSpace`) and the viewer kept the old names. The library still served a valid file, so nothing failed until a browser tried to execute it.

    It is now gated. `test/unit/client_libs_tripwire.test.ts` checks that every named import the client takes from an import-map specifier — the exact `three` mapping *and* the `three/addons/` prefix — is actually exported by the module that specifier resolves to. A rename upstream is a red gate, not a blank widget.

**Capture preconditions.** The posterframe is rendered by the browser from the live scene, so it requires a model that has finished loading successfully. When the viewer holds no model — a load that failed, a file that 404s, or a capture requested before the download completed — the capture is **refused** and reported in the console; the previous posterframe is left in place rather than being overwritten with an empty frame. The output is a JPEG at the requested pixel size (720 × 404) on every display, independent of the device pixel ratio.

**Lighting environments** are local-only: `None` (no environment map) and `Neutral` (three's built-in `RoomEnvironment`, generated in-process). Neither performs a network request, which is what a disconnected archive needs. To offer another one, vendor the `.exr` inside the install and add an entry with a same-origin `path` to `client/dedalo/core/component_3d/js/viewer/environments.js`; a preset that fails to load reports which one it was instead of failing silently.

The DRACO geometry and KTX2 texture decoders are fetched from the same registry (`lib/three/examples/jsm/libs/draco/`, `.../basis/`) when a compressed glTF needs them.

## Import / export model

**Import.** Media import binds files into the component rather than transmitting binary in the row. A 3D item is described with the same structure as the stored data — `files_info` plus the source-file fields — and the system normalises and generates the qualities on processing:

```json
[{
    "original_file_name": "venus_statue.glb",
    "original_upload_date": "2025-12-25 22:53:39",
    "files_info": [
        { "quality": "original", "extension": "glb", "file_name": "test26_test3_1.glb", "file_path": "/3d/original/0/test26_test3_1.glb" }
    ]
}]
```

See [importing data](../../using/importing_data.md).

**Export.** The export path (`src/diffusion/export/atoms.ts`) emits a **single export atom** carrying the 3D model URL with `cell_type` `img`. In `edit` mode it is the default-quality (`web`) model URL; otherwise it is the **posterframe** URL. URL absoluteness comes from the `export_context` (`absolute_urls`). When the media is external (`external_source`), diffusion/export surface the external URI instead. See [exporting data](../../using/exporting_data.md).

## Notes

- **Conversion pipeline (current state).** 3D formats are not transcoded: `regenerate3d()` (`src/core/media/processing.ts`) copies the original file to the `web` quality via `copyToQuality()` — a no-op conversion. Config still defines converter paths for a future implementation — `DEDALO_3D_GLTFPACK_PATH` (`.obj`/`.gltf` → `.glb`/`.gltf`), `DEDALO_3D_FBX2GLTF_PATH` (`.fbx`), `DEDALO_3D_COLLADA2GLTF_PATH` (`.dae`) — that are never invoked. Non-`.glb` uploads are stored as-is. The posterframe is generated client-side from the three.js viewer and bound server-side (see below); no server-side 3D screenshot/metadata extraction exists. Because the capture happens in the browser, it depends on the viewer having loaded the model — see *The WebGL viewer* above for what that means when it does not.
- **Posterframe & thumb.** The posterframe is a JPG still kept in a `posterframe` quality folder. `buildThumb()` (`src/core/media/engine/imagemagick.ts`) rasterises it via ImageMagick into the `thumb` quality used by list/mini/text views. Deleting a whole record soft-moves its media (posterframe included) into `deleted/` (`src/core/section/record/delete_record.ts`); a component-level restore for 3D specifically is covered by the shared `file_ops.ts` primitives (`moveToDeleted`, `listDeletedVersions`) but is not yet wired into the Time Machine restore path for a single component.
- **API actions.** The server registers two `dd_component_3d_api` actions (`src/core/api/dispatch.ts`): `move_file_to_dir` (binds a client-rendered posterframe snapshot staged upload to the component, write permission ≥ 2 required, then rebuilds derivatives via `moveUploadedToMediaDir()`, `src/core/media/tools/posterframe.ts`) and `delete_posterframe` (`deletePosterframe()`, a true unlink). The model upload itself goes through the shared multipart upload endpoint (`src/core/media/ingest/upload_endpoint.ts`) → `tool_upload.process_uploaded_file` (`tools/tool_upload/server/index.ts`) → `processUploadedFile()` (`src/core/media/ingest/process_uploaded_file.ts`).
- **Access control.** Media file access is enforced natively: `src/core/media/protection.ts` maintains a daily-rotated `dedalo_media_auth` auth-marker store for logged-in users (a cookie whose value must exist as a marker file under `<media>/.publication/auth/`) and consumes `.publication/pub/{section_tipo}_{section_id}` markers — written by the diffusion media index (`src/diffusion/targets/mediastore/media_index.ts`) — for anonymous publication reads. Both rules are enforced by the web server itself via generated Apache/nginx rule files (one `stat()` per request), never by the Bun process, and fail closed as 404. Separately, an optional dev-only session-gated fallback route exists for local development (`src/server.ts`, gated behind `MEDIA_DEV_ROUTE_ENABLED`); it applies no per-record ACL and must never be enabled in a shared or production environment.
- **Default tools.** A 3D instance exposes `tool_media_versions`, `tool_posterframe`, `tool_time_machine` and `tool_upload` in `context.tools`. Tools are read-only context.
- **Permissions.** Resolved via `getPermissions()` (`src/core/security/permissions.ts`; 0 none / 1 read / 2 read+write / 3 admin). Read users (level 1) get a read-only render; uploads, posterframe writes, deletes and saves require level ≥ 2 — enforced per-action by the tool registry's `minLevel` gate.
- **Related components:** [component_svg](component_svg.md), `component_image`, `component_av`, `component_pdf` (the other media components — all driven by the same shared media engine under `src/core/media/`); [component_iri](component_iri.md) (used as `external_source` / `target_filename`), [component_input_text](component_input_text.md).