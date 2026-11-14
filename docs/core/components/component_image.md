# component_image

## Overview

```json
{
    "could_be_translatable" : false,
    "is_literal"            : false,
    "is_related"            : false,
    "is_media"              : true,
    "modes"                 : ["edit","list","tm","search"],
    "default_tools" : [
        "tool_image_rotation",
        "tool_media_versions",
        "tool_time_machine",
        "tool_transcription",
        "tool_upload"
    ],
    "render_views" :[
        {
            "view" : "default | line | mini | viewer",
            "mode" : "edit"
        },
        {
            "view" : "default | mini | text | mosaic | viewer",
            "mode" : "list"
        }
    ],
    "data"        : "array (single item)",
    "sample_data" : [
        {
            "id": 3,
            "files_info": [
                {
                    "quality"   : "1.5MB",
                    "extension" : "jpg",
                    "file_name" : "test99_test3_1.jpg",
                    "file_path" : "/image/1.5MB/0/test99_test3_1.jpg",
                    "file_size" : 177293,
                    "file_time" : { "timestamp": "2025-12-30 10:13:53" },
                    "file_exist": true
                },
                {
                    "quality"   : "thumb",
                    "extension" : "jpg",
                    "file_name" : "test99_test3_1.jpg",
                    "file_path" : "/image/thumb/0/test99_test3_1.jpg",
                    "file_size" : 11165,
                    "file_exist": true
                }
            ],
            "original_file_name"       : "my photo 16.jpg",
            "original_normalized_name" : "test99_test3_1.jpg",
            "original_upload_date"     : "2025-12-29 21:47:30"
        }
    ],
    "value"        : "string (url) | null",
    "sample_value" : "/image/1.5MB/0/test99_test3_1.jpg"
}
```

!!! note "Typology"
    `component_image` is a **media** component. In the TS server the model is a lightweight declarative descriptor (`src/core/components/component_image/descriptor.ts` — `{ model: 'component_image', column: 'media' }`) and nothing more: all behaviour comes from shared horizontal engines. It is *literal* in the broad sense that it owns its own data and never resolves a [locator](../locator.md) to another section, but it is **not** a literal-direct component: it stores a thin JSON pointer in its matrix `media` column and keeps the renderable bytes as files on disk. Image-specific behaviour (qualities, extensions, folder, conversion/manipulation logic — rotate, crop, alternative formats, SVG overlay) lives in those shared engines: `src/core/concepts/media.ts` (type catalog), `src/core/media/engine/imagemagick.ts` (convert/rotate/crop/thumb), `src/core/media/processing.ts` (`regenerateImage`), `src/core/media/svg_overlay.ts` (the vector-editor overlay), `src/core/media/tools/rotation.ts`. The structural machinery — paths, upload binding, `files_info` reconstruction, URL building, delete/version handling — is shared by all five media models (`src/core/media/path.ts`, `files_info.ts`, `file_ops.ts`, `ingest/*`). It is **non-translatable** (its language slot is `lg-nolan`).

!!! info "About `default_tools`"
    The list above is what a typical image instance receives in `context.tools` (verified from the model sample). The toolbar is assembled from the model + ontology, not hardcoded; concrete instances may carry a different subset. `tool_upload` provides the upload UI, `tool_media_versions` regenerates per-quality versions, `tool_image_rotation` drives rotation, `tool_transcription` opens the transcription window and `tool_time_machine` browses deleted/older files — each a registered server module under `tools/<name>/server/`.

## Definition

`component_image` manages a raster image bound to a record: upload, on-disk storage, quality versioning, alternative-format generation (e.g. AVIF/WebP), in-place manipulation (rotate, crop) and an SVG overlay used by the vector editor for drawing regions over the picture. It does not keep binary data in the database — the matrix `data` column holds only a small JSON pointer; the actual JPGs/TIFFs live under the media tree and are reconstructed on demand by scanning disk per quality and extension.

**Why it exists.** A cultural-heritage catalogue is image-heavy: a museum object photographed from several angles, the obverse/reverse of a coin, a scanned manuscript page, an excavation context photo, a portrait of a person. These assets must be uploaded once at full resolution, automatically derived into web-friendly qualities and thumbnails, protected behind the media access layer, and displayed inline in the record. `component_image` is the building block for exactly that. Because it is media-typed, it shares its data shape and the whole storage/upload/protection machinery with the other media components ([component_av](component_av.md), [component_pdf](component_pdf.md), [component_3d](component_3d.md), [component_svg](component_svg.md)).

**When to use it.**

- The main or secondary photograph of a museum object, artwork, coin or specimen.
- Scanned document pages or plates that are consumed as raster images (where a true vector workflow is not needed).
- Any picture that needs automatic thumbnails, multiple web qualities, rotation/crop tooling, or drawn region overlays (vector editor) on top of the image.

**When not to use it.**

- Vector graphics you want to embed/manipulate as XML (icons, line drawings) -> use [component_svg](component_svg.md), which preserves and can inline the SVG source.
- Audio or video -> [component_av](component_av.md). PDFs / multi-page documents -> [component_pdf](component_pdf.md). 3D models -> [component_3d](component_3d.md).
- A picture that is *not* hosted in Dédalo but referenced by URL: keep using `component_image` and point it at an external URL through the `external_source` property (it then serves the external link instead of a local file).

## Data model

**Data:** `array` with a **single item** (`data[0]`). The item is the persisted pointer plus a cached files snapshot, not the binary.

**Value:** `string` (the displayable URL of the default/thumb quality), or `null`. It is built from the resolved media path; for an external image it is the configured external URL.

**Storage shape.** A component never touches the database; it reads and writes through its section, which stores the component data in its matrix `media` column (`src/core/section/read.ts`, `src/core/section/record/save_component.ts`). For `component_image` the persisted item carries:

- `original_normalized_name` — deterministic Dédalo filename of the original file, keeping its source extension (e.g. `test99_test3_1.jpg` / `..._1.tif`). The original (full-resolution) file is preserved under the `original` quality folder; all derived qualities are generated from it.
- `original_file_name` / `original_upload_date` — the user's upload filename and the upload timestamp.
- `modified_normalized_name` / `modified_file_name` / `modified_upload_date` — present only when a retouched/edited source exists (the `modified` quality), preserved under its own folder.
- `files_info` — a cached array describing the files that exist on disk per quality/extension. Each entry is `{quality, extension, file_name, file_path, file_size, file_time, file_exist}`. This is rebuilt by `scanFilesInfo()` (`src/core/media/files_info.ts`, which scans every quality × allowed/alternative extension) and is also persisted (`persistUploadedMedia()` / `persistScannedFilesInfo()`, `src/core/media/tools/files_info_persist.ts`) so reads do not have to stat the filesystem on every call.

Non-translatable, single item (the normal case — language slot `lg-nolan`):

```json
[
    {
        "id": 3,
        "files_info": [
            {"quality": "original", "extension": "jpg", "file_name": "rsc29_rsc170_16.jpg", "file_path": "/image/original/0/rsc29_rsc170_16.jpg", "file_size": 510249, "file_exist": true},
            {"quality": "original", "extension": "avif", "file_name": "rsc29_rsc170_16.avif", "file_path": "/image/original/0/rsc29_rsc170_16.avif", "file_size": 1098365, "file_exist": true},
            {"quality": "1.5MB", "extension": "jpg", "file_name": "rsc29_rsc170_16.jpg", "file_path": "/image/1.5MB/0/rsc29_rsc170_16.jpg", "file_size": 177293, "file_exist": true},
            {"quality": "thumb", "extension": "jpg", "file_name": "rsc29_rsc170_16.jpg", "file_path": "/image/thumb/0/rsc29_rsc170_16.jpg", "file_size": 11165, "file_exist": true}
        ],
        "original_file_name": "my photo 16.jpg",
        "original_upload_date": "2025-12-29 21:47:30",
        "original_normalized_name": "rsc29_rsc170_16.jpg"
    }
]
```

With a retouched/edited source (the `modified` quality keeps its own extension, e.g. a layered PNG/PSD):

```json
[
    {
        "id": 3,
        "files_info": [ "..." ],
        "original_file_name"       : "my photo 16.jpg",
        "original_normalized_name" : "rsc29_rsc170_16.jpg",
        "modified_file_name"       : "my photo 16 edited.png",
        "modified_normalized_name" : "rsc29_rsc170_16.png"
    }
]
```

External image (no local files; the picture is served from a URL resolved through the `external_source` property, see below):

```json
[
    { "external_source": "https://example.org/iiif/object_16/full/full/0/default.jpg" }
]
```

!!! note "Datum vs. API `entries`"
    The transmitted unit is a `{context, data}` datum (the JSON-API contract). In the API payload the item array is surfaced under `data.entries`; the controller also adds top-level `external_source` and (in edit mode) `base_svg_url`, and stamps `context.features` with the live capability set — `allowed_extensions`, `ar_quality`, `default_quality`, `default_target_quality`, current `quality`, `extension`, `alternative_extensions` and a `key_dir` (`image_<tipo>_<section_tipo>`). In `list`/`tm` mode `data.entries` carries a reduced item (only the default and thumb qualities in the component extension); in `edit` mode it carries the full `files_info`. `context` never carries the file bytes. See the *dedalo-context-data-layers* skill for the full layering rules.

## Ontology instantiation

A `component_image` is created as an ontology node whose `model` is `component_image`. Its `parent` is the section (or grouper) it belongs to, and its `section_tipo` wires it into that section. The node declares its label through the standard `lg-*` terms; being a media component it is normally **non-translatable** (`translatable: false`, language `lg-nolan`).

Node definition (shape):

```json
{
    "tipo"         : "rsc29",
    "model"        : "component_image",
    "parent"       : "rsc170",
    "section_tipo" : "rsc170",
    "lg-eng"       : "Image",
    "lg-spa"       : "Imagen",
    "translatable" : false,
    "properties"   : { }
}
```

Realistic `properties` block for the main photograph of an object, with files bucketed into folders of 1000 and a drawn-region overlay observing a related text component:

```json
{
    "max_items_folder" : 1000,
    "observe" : [
        {
            "client" : {
                "event"   : "click_tag_draw",
                "perform" : { "function": "load_tag_into_vector_editor" }
            },
            "component_tipo" : "rsc31"
        }
    ],
    "css" : {
        ".wrapper_component": { "grid-column": "span 7" }
    }
}
```

`section_tipo` / `parent` tell the section which column owns this component's data; on save the section is the single writer to the database (`src/core/section/record/save_component.ts`), and the SVG overlay file is materialised on disk by `createDefaultSvgFile()` (`src/core/media/svg_overlay.ts`) when the image has a default-quality file. The on-disk location is deterministic: filename is `id . '.' . extension` where `id = {component_tipo}_{section_tipo}_{section_id}`, computed by `buildMediaIdentifier()`, and the path is `DEDALO_MEDIA_PATH + folder + initial_media_path + '/' + quality + additional_path`, computed by `buildMediaLocation()` (both `src/core/media/path.ts`). `folder` is `DEDALO_IMAGE_FOLDER` (`config.media.image.folder`); `initial_media_path` and `additional_path` come from the properties below, resolved by `resolveMediaPathOptions()` (`src/core/media/ontology_path.ts`). Every resulting path is confined by `assertInsideMediaRoot()`, and the quality string is validated by `assertValidQuality()` (`src/core/concepts/media.ts`, SEC-065 strengthened — charset **and** ladder membership).

## Properties & options

All properties are optional and live in the ontology node `properties` JSON. Verified names consumed by this component (and its media base):

### external_source

- **Values:** a component `tipo` (string) pointing at a [component_iri](component_iri.md) in the same section (e.g. `"rsc496"`).
- **Effect:** turns the component into a reference to an image **hosted outside Dédalo**. `resolveExternalSource()` (`src/core/section/read.ts`) instantiates the referenced IRI component and, when its stored value carries a non-empty `dataframe`/`iri`, resolves that URL as the source, surfacing it as `item.external_source` on the datum. `scanFilesInfo()` (`src/core/media/files_info.ts`) accepts the resolved URL as an `externalSource` override and emits the `external:true` entry instead of scanning disk. Of the five media types, **only `component_image` currently gets this end-to-end** on read — see the equivalent property note on `component_av`/`component_pdf`/`component_svg`/`component_3d` for the read-path gap on the other four.

### image_id

- **Values:** a component `tipo` (string) naming a sibling component of the same section, e.g. `{"image_id": "rsc34"}` (the core Images component `rsc29` names its files by `rsc34` "Filename").
- **Effect:** the trimmed, non-empty value of the referenced component on the record becomes the **file name** of every file of this component — the quality files, the thumb and the SVG envelope: `photo_2.jpg` instead of `rsc29_rsc170_7.jpg`. An empty value falls back to the standard `{component_tipo}_{section_tipo}_{section_id}` name. The name carries no language suffix, so every language of a translatable image shares it. Resolved per record by `resolveMediaPathOptions()` (`src/core/media/ontology_path.ts`, field `fileIdOverride`) and applied by `buildMediaLocation()` (`src/core/media/path.ts`), so upload, regeneration, the media tools, rescans, the edit view, record delete/restore and the indexation grid all use the same name. Only `component_image` reads the property; on any other model it has no effect.
- **Refused values:** a value that is not a plain file name (empty after trimming is the fallback, but `.`/`..`, `/`, `\\`, `"`, `<`, `>` or a control character are refused), and a value that names **another record's** files under the media-protection file-name grammar (for example `rsc29_rsc170_5` on record 7). A refused value stops the upload or the tool before anything is written, with the error `media.invalid_identifier`.
- **Shared names:** two records with the same value address the same files. Duplicating such a record copies nothing for this component and reports it as incomplete (the copy would overwrite the source). Changing the value after files exist does not rename them.
- **Publication:** files named this way do not follow the media-protection file-name grammar, so anonymous visitors never see them, published or not (see [media protection](../system/media_protection.md)).

### target_filename

- **Values:** a component `tipo` (string), e.g. `"rsc398"`.
- **Effect:** on upload the user's original file name is written into the named [component_input_text](component_input_text.md) of the same record. Done by the ingest itself for every upload door (`src/core/media/ingest/companion_writes.ts`, called from `processUploadedFile()`).

### initial_media_path

- **Values:** an object keyed by component `tipo` -> path segment, e.g. `{"initial_media_path": {"rsc29": "my_custom_name"}}`, declared on the **section** node.
- **Effect:** inserts an extra path segment between the media `folder` and the quality folder for this specific component, so its files live in a dedicated subtree. A leading slash is added if missing. Read by `resolveMediaPathOptions()` (`src/core/media/ontology_path.ts`) and applied by `buildMediaLocation()` (`src/core/media/path.ts`). Default: none.

### additional_path

- **Values:** a component `tipo` (string), e.g. `"rsc33"`.
- **Effect:** appends a path segment **after** the quality folder, read from the value of the referenced component on the record (trimmed, leading slash added, trailing slash removed), taking precedence over the `max_items_folder` bucket. An empty value falls back to that bucket. Resolved per record by `resolveMediaPathOptions()` (`src/core/media/ontology_path.ts`, field `additionalPathOverride`). A value with a `.`/`..` segment, a NUL or one of `"`, `<`, `>` is refused.

### max_items_folder

- **Values:** integer (typically `1000`).
- **Effect:** when no `additional_path` component is configured, buckets files into numbered subfolders so a single directory never holds too many files: `additional_path = '/' . max_items_folder * floor(section_id / max_items_folder)` (e.g. section 16 -> `/0`, section 1500 -> `/1000`). Ported as `additionalPath()` (`src/core/media/path.ts`), fed by `resolveMediaPathOptions()` reading `properties.max_items_folder`. Default behaviour when unset is no bucketing.

### observe / observers

- **Values:** arrays of observer/observable configuration objects (see the index page *Observers and observables* section).
- **Effect:** client-side wiring used by the image's vector editor (unchanged — the client is copied as-is). A typical `observe` entry subscribes to `click_tag_draw` (or `key_up_f2`) published by a related text component and runs the image method `load_tag_into_vector_editor` / `get_data_tag`, loading the clicked tag's drawn region into the overlay editor. Configured in the ontology, not hardcoded.

!!! note "Standard context properties"
    Like every component, `component_image` also honours the generic ontology context blocks carried into the datum `context`: `css` (style stamped on `.wrapper_component`), `request_config` (RQO) and `view` (the render view to use). These are not component-specific options. Any other custom key seen in production should be verified in the ontology.

!!! info "Qualities and the original model"
    Qualities are **not** an ontology property — they come from Dédalo config, mirrored on the TS side by `mediaTypeOf('component_image')` (`src/core/concepts/media.ts`, backed by `config.media.image`, `src/config/config.ts`). `qualities` -> `DEDALO_IMAGE_AR_QUALITY` (e.g. `original, modified, 100MB, 25MB, 6MB, 1.5MB, thumb`); `defaultQuality` -> `DEDALO_IMAGE_QUALITY_DEFAULT` (e.g. `1.5MB`), `originalQuality` -> `DEDALO_IMAGE_QUALITY_ORIGINAL`, the `modified` quality is the retouched tier, and a `thumb` quality is generated as a JPG (`buildThumbVersion()`, `src/core/media/processing.ts`). Allowed upload extensions come from `DEDALO_IMAGE_EXTENSIONS_SUPPORTED` (jpg, jpeg, png, tif, tiff, bmp, psd, raw, webp, heic, avif); `DEDALO_IMAGE_ALTERNATIVE_EXTENSIONS` (e.g. `avif`) drives the alternative-format versions. The `context.features` block the client edit view reads is built by `buildMediaFeatures()` (`src/core/section/media_features.ts`).

## Render views & modes

Views are selected from `context.view` (default `default`) and dispatched by the per-mode render files. Verified from the source (JS render/view files + CSS):

| View | edit | list / tm | search | Notes |
| --- | :---: | :---: | :---: | --- |
| `default` | yes | yes | — | Full wrapper: label, buttons, `content_data` with the image container (`.image_container > .img`), upload UI and quality selector in edit; thumbnail in list. |
| `line` | yes | — | — | Compact inline image cell (small fixed box). Falls through to the default edit view with line styling. |
| `mini` | yes | yes | — | Minimal `<img>` (`component_image_mini`), used in compact/service contexts. |
| `viewer` | yes | yes | — | Full-screen overlay viewer (`view_viewer`) with a download button; opens the image fit-to-screen. |
| `text` | — | yes | — | Textual list cell. |
| `mosaic` | — | yes | — | Grid/mosaic list layout for visual browsing. |
| `print` | yes | — | — | Reuses the `default` edit view but forces read-only rendering (`permissions = 1`) and tags the wrapper for print. |

Modes:

- **edit** — read/write a real record; surfaces the full default quality, the upload tooling, the per-quality selector, rotate/crop and the SVG vector-editor overlay (`base_svg_url`). The `image_quality_change_<id>` event swaps the displayed source between available qualities.
- **list / tm** — read-only listing using the reduced item (default quality + thumb in the component extension). `tm` (Time Machine) reuses the list render; in `tm` mode the URL resolves to the last deleted file under the quality's `/deleted` folder, so previously removed images can still be viewed.
- **search** — renders a plain text input filter (one per entry) that builds the SQO; saves are not performed in search mode.

DOM (edit / default): `wrapper_component component_image <tipo> <mode>` -> `label`, `buttons_container`, `content_data` -> `content_value` -> `.image_container` -> `img.img`.

## Import / export model

**Import.** A JSON value is decoded and stored as the item array (the pointer shape above: `original_normalized_name`, `files_info`, etc.); a value that fails JSON decoding is rejected rather than stored. Note that importing the pointer JSON does **not** by itself create the binary files on disk — the files must exist (or be re-derived) in the media tree for the qualities listed in `files_info`. The normal way to populate an image is the upload flow, not CSV import. See [importing data](../../using/importing_data.md).

Typical import structure (advanced — the persisted item):

```json
[{
    "original_normalized_name": "rsc29_rsc170_16.jpg",
    "original_file_name": "my photo 16.jpg",
    "original_upload_date": "2025-12-29 21:47:30",
    "files_info": [
        {"quality": "1.5MB", "extension": "jpg", "file_name": "rsc29_rsc170_16.jpg", "file_path": "/image/1.5MB/0/rsc29_rsc170_16.jpg", "file_exist": true}
    ]
}]
```

**Export.** The export atoms path (`src/diffusion/export/atoms.ts`) emits **one export atom** carrying the media URL with `cell_type: img`. The exported quality is the default quality in `edit` context and the thumb quality otherwise; URL absoluteness is taken from the `export_context` (relative vs absolute). For an external image the atom resolves to the `external_source` URL. See [exporting data](../../using/exporting_data.md).

## Notes

- **Upload flow.** The multipart branch of the API dispatch (`src/server.ts`) hands off to `handleMediaUpload()` (`src/core/media/ingest/upload_endpoint.ts`, session + CSRF required, chunked join + re-sniff, magic-byte MIME sniffing); `tool_upload.process_uploaded_file` (`tools/tool_upload/server/index.ts`) gates write permission ≥ 2, then `addFile()` (`src/core/media/ingest/add_file.ts`) confines and moves the staged file into the `original` tier, and `processUploadedFile()` -> `regenerateImage()` (`src/core/media/processing.ts`) (re)builds the default quality, the thumb, and the SVG overlay, then persists the fresh `files_info` (`persistUploadedMedia()`, `src/core/media/tools/files_info_persist.ts`). An upload into a master tier (`original` / `modified`) whose extension is not the type's default also gets the browser-viewable `<id>.<defaultExtension>` copy beside it (`buildMasterNormalizedCopy()`), which is what the quality selector and every tier-preview reader resolve; the copy is display-only — derivatives are built from the raw upload. `buildImageVersion()` builds a single quality from the best available source via `resolveMasterSource()` (modified > original), using `src/core/media/engine/imagemagick.ts` (argv-only `Bun.spawn`, no shell) for convert/resize and `buildThumbVersion()` for the thumbnail. **Not yet ported**: writing the upload filename back to a `target_filename` sibling component (see *Properties & options*).
- **SVG overlay.** Beyond the raster files, the component maintains a per-image `.svg` file under the `/svg` subfolder, generated by `createDefaultSvgFile()` / `buildDefaultSvgString()` (`src/core/media/svg_overlay.ts`) referencing the default-quality image. It backs the vector editor (drawn regions / masks over the picture); `baseSvgUrl()` resolves the client-facing URL. Deleting files never removes it tier by tier: it is moved to the envelope folder's `deleted/` (restorable, like any quality file) only when the record holds **no file in any quality** — masters, web sizes, thumb and alternative formats all count (`retireOverlayIfNoMediaFiles()`, applied by the media-versions delete and by regenerate). **The drawing goes with it**: the same delete clears the stored layers (`lib_data` → null, `svg_file_data` dropped) in the locked media write-back, so a later upload opens a fresh vector editor instead of showing the deleted picture's vectors over the new image. The cleared value is written to the Time Machine in the same transaction, so the previous drawing remains restorable. **Undo/redo**: Cmd+Z / Ctrl+Z undoes the last canvas action and Shift+Cmd+Z / Ctrl+Shift+Z (Ctrl+Y on Windows) redoes it. The history covers drawing, moving/resizing, deleting and colouring shapes, moving the raster image, resetting the raster, and adding/deleting layers. Layer visibility, layer names, the layer colour swatch and zoom are editor settings, not canvas history.
- **Image manipulation.** `applyRotationCore()` (`src/core/media/tools/rotation.ts`, wrapping `rotateImage()`/`cropImage()` in `engine/imagemagick.ts`) operates on a chosen quality/extension — the `original` tier is asserted never mutated (rotate/crop refuses `quality === 'original'` targets). `DEDALO_IMAGE_PRINT_DPI` is carried as config (`config.imagePrintDpi`), but the print-size calculation itself (pixels → centimetres at that DPI) is not yet ported (`tool_print`'s image sizing is a separate concern; see the *dedalo-tool-print* skill).
- **Access control.** In production, media access is enforced by the web server (Apache/nginx) reading a marker store maintained by `src/core/media/protection.ts` (modes via `DEDALO_MEDIA_ACCESS_MODE`: `false` / `private` / `publication`): a daily-rotated `dedalo_media_auth` cookie grants logged-in users access, and `.publication/pub/{section_tipo}_{section_id}` markers grant anonymous publication access — every check runs fail-closed in the web server itself (never this process, so multi-GB files keep native sendfile/Range streaming). In development, `src/server.ts` can instead serve media through a session-gated route (any authenticated TS session, traversal-guarded, fail-closed 404) that is off by default; production is socket-only and relies on the reverse proxy plus the marker store (see the *dedalo-media-protection* skill).
- **Observers / observables.** This component's client overlay subscribes to events published by related components (e.g. `click_tag_draw`, `key_up_f2`) through the ontology `observe` block; the client is copied as-is, so this wiring is unchanged.
- **Permissions.** Resolved via `getPermissions()` (`src/core/security/permissions.ts`; 0 none / 1 read / 2 read+write / 3 admin). Upload and saves require level >= 2, enforced per-action by the tool registry's `minLevel` gate.
- **Related components:** [component_av](component_av.md), [component_pdf](component_pdf.md), [component_3d](component_3d.md), [component_svg](component_svg.md), [component_iri](component_iri.md), [component_input_text](component_input_text.md), [component_portal](component_portal.md).
