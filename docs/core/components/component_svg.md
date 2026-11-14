# component_svg

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
        "tool_time_machine",
        "tool_upload"
    ],
    "render_views" :[
        {
            "view" : "default | line | print",
            "mode" : "edit"
        },
        {
            "view" : "default | mini | text | tag",
            "mode" : "list | tm"
        },
        {
            "view" : "viewer",
            "mode" : "edit"
        }
    ],
    "data"        : "array (single-element file descriptor)",
    "sample_data" : [
        {
            "id"                      : 1,
            "files_info"              : [],
            "original_file_name"      : "my_drawing.svg",
            "original_upload_date"    : { "timestamp": "2025-11-29 10:26:59" },
            "original_normalized_name": "rsc855_rsc302_1.svg"
        }
    ],
    "value"        : "string (default-quality URL) | string (external_source) | null",
    "sample_value" : "/svg/web/0/rsc855_rsc302_1.svg"
}
```

!!! note "Typology"
    `component_svg` is a **media** component. In the TS server it is a lightweight descriptor (`src/core/components/component_svg/descriptor.ts` — `{ model: 'component_svg', column: 'media' }`); there is no per-model class hierarchy. Like the other media components ([component_image](component_image.md), `component_av`, `component_3d`, `component_pdf`) it does **not** store binary data in the section matrix: the `media` data column holds only a thin JSON pointer to the files that live on disk under the configured media root. SVG-specific behavior (folder, extension, qualities, thumbnail rasterization) lives in the shared horizontal engine (`src/core/concepts/media.ts`, `src/core/media/engine/svg.ts` for the vector render, `src/core/media/engine/imagemagick.ts` for the thumbnail recipe); the structural machinery (path/URL building, `files_info` scanning, upload binding, versioning, search) is shared by all five media models (`src/core/media/path.ts`, `files_info.ts`, `file_ops.ts`, `ingest/*`), not duplicated per type.

!!! info "About `default_tools`"
    The list above is what an `edit`-mode instance receives in `context.tools` (verified from the component sample context): `tool_media_versions` (manage the quality variants), `tool_time_machine` and `tool_upload` (the file picker that drives the upload flow). The toolbar is assembled from the model + ontology; nothing hardcodes it, so an instance can be configured with a narrower or wider set. Server-side each tool is a registered module under `tools/<name>/server/`.

!!! note "Annotation overlays"
    Besides standing on its own, `component_svg` is also used as an **annotation overlay** layer on top of other media (for example a vector layer drawn over a [component_image](component_image.md) or video frame). The data model is identical; only the meaning of the drawing changes.

## Definition

`component_svg` manages **Scalable Vector Graphics** files: upload, normalized storage, quality variants and a raster thumbnail for previews. It is the media component to reach for whenever the asset is a *vector* drawing rather than a raster photograph.

**Why it exists.** A vector image is a resolution-independent XML document, not a pixel grid. Storing it as a [component_image](component_image.md) would either rasterize it (losing scalability) or treat the `.svg` as an opaque blob with no preview. `component_svg` keeps the original `.svg` byte-for-byte, exposes its URL for `<img src>` embedding, can return the **raw XML content** for inline DOM embedding (so paths can be styled/animated by the page CSS/JS), and still generates a raster `thumb` (JPG, rendered by librsvg) for list grids and contexts where rendering the full vector is undesirable.

**When to use it.**

- Line drawings, plans, diagrams, maps, technical illustrations, coats of arms, monograms, logos and seals — anything authored as a vector.
- Numismatic / epigraphic *tracings* and reconstruction drawings that must scale crisply at any zoom.
- Vector **annotation layers** drawn over another media asset.

**When not to use it.**

- A photograph or scanned raster image -> use [component_image](component_image.md).
- Audio or video -> use `component_av`. A 3D model -> use `component_3d`. A document -> use `component_pdf`.
- A value that points at another record (a person, a place, a thesaurus term) -> use a related component such as [component_portal](component_portal.md) or [component_select](component_select.md).

## Data model

**Data type:** `array`. A media component stores a single-element array; the only meaningful entry is `data[0]`, a file *descriptor* object.

**Value type:** `string` (the default-quality URL, or the `external_source` URL when the media lives outside Dédalo), or `null`.

**Storage shape.** A component never touches the database directly; it reads and writes through its section (`src/core/section/read.ts`, `src/core/section/record/save_component.ts`), which persists the component data in its matrix `media` column. The stored descriptor describes the **source** filenames, not the renderable files. Its real keys (verified from `processUploadedFile()` and `scanFilesInfo()`, `src/core/media/ingest/process_uploaded_file.ts` / `src/core/media/files_info.ts`):

```json
[
    {
        "id"                      : 1,
        "original_file_name"      : "my_drawing.svg",
        "original_normalized_name": "rsc855_rsc302_1.svg",
        "original_upload_date"    : { "timestamp": "2025-11-29 10:26:59" }
    }
]
```

- `original_file_name` — the human filename as uploaded by the cataloguer.
- `original_normalized_name` — the deterministic on-disk name of the original-quality file (keeps the source extension).
- `original_upload_date` — a Dédalo date object (`dd_date`) recording when the original was bound.

`component_svg` is **non-translatable** (`translatable:false`); every instance resolves to `lang = lg-nolan`. (Among the media components only `component_pdf` can be translatable.)

!!! note "files_info is reconstructed, not stored"
    The live picture of the renderable files is **not** kept in the descriptor — it is rebuilt on demand by `scanFilesInfo()` (`src/core/media/files_info.ts`), which scans the disk per quality and per allowed extension. Each resolved file is a `files_info` object:

    ```json
    {
        "quality"   : "web",
        "extension" : "svg",
        "file_name" : "rsc855_rsc302_1.svg",
        "file_path" : "/svg/web/0/rsc855_rsc302_1.svg",
        "file_size" : 38481,
        "file_time" : { "timestamp": "2025-11-29 10:26:59" },
        "file_exist": true
    }
    ```

    For an external link (`external_source`, see below) `scanFilesInfo()` returns a synthetic item with `external:true` and `file_path` set to the remote URL — the scanner already accepts an `externalSource` override for any media type. The `files_info` list is what travels to the client inside `data.entries[0].files_info`; the client picks the entry whose `quality` matches the instance quality.

**Naming and storage (deterministic).** The on-disk filename is `<id>.<extension>`, where the id is the component identifier `{component_tipo}_{section_tipo}_{section_id}` (no `_lang` suffix because SVG is non-translatable) and the extension is `svg` (`DEDALO_SVG_EXTENSION`), built by `buildMediaIdentifier()` (`src/core/media/path.ts`). The directory is

```text
DEDALO_MEDIA_PATH + folder + initial_media_path + '/' + quality + additional_path
```

computed by `buildMediaLocation()` (same module). `folder` is `DEDALO_SVG_FOLDER` (`/svg`, `config.media.svg.folder`); `initial_media_path` comes from the section's `initial_media_path` property (`resolveMediaPathOptions()`, `src/core/media/ontology_path.ts`) and `additional_path` from the component's `max_items_folder` property (the sibling-component-value form of `additional_path` is not yet wired, see *Properties & options*). Every resulting path is confined by `assertInsideMediaRoot()`, and the quality string is validated by `assertValidQuality()` (`src/core/concepts/media.ts`, SEC-065 strengthened — charset **and** ladder membership) so a client-supplied quality can never escape into the filesystem path.

## Ontology instantiation

A `component_svg` is created as an ontology node whose `model` is `component_svg`. Its `parent` is the section (or grouper) it belongs to, and its `section_tipo` wires it into that section. Because it is non-translatable, the node sets `translatable: false`; the label and flags are read from the ontology node and the working lang is forced to `lg-nolan`.

Node definition (shape, taken from a real instance — `rsc855` *Vectorial* in section `rsc302`):

```json
{
    "tipo"         : "rsc855",
    "model"        : "component_svg",
    "parent"       : "rsc302",
    "section_tipo" : "rsc302",
    "lg-eng"       : "Vector drawing",
    "lg-spa"       : "Vectorial",
    "translatable" : false,
    "properties"   : { }
}
```

Realistic `properties` block (the one shipped with the sample instance), folding new files into 1000-item subfolders and pinning the grid width:

```json
{
    "additional_path"  : "rsc33",
    "max_items_folder" : 1000,
    "css" : {
        ".wrapper_component": { "grid-column": "span 1" }
    }
}
```

`section_tipo` / `parent` tell the section which `media` column owns this component's data. The component is **not** the database writer: the file bytes are placed on disk by the upload flow, and the descriptor is persisted through `saveComponentData()` (`src/core/section/record/save_component.ts`) when the section saves.

## Properties & options

All properties are optional and live in the ontology node `properties` JSON (the storage-path ones can also live in the parent **section** `properties`). Verified names consumed by `component_svg` and the shared media engine:

### additional_path

- **Values:** a component `tipo` (string) whose resolved value is appended to the media path, e.g. `"rsc33"`.
- **Effect:** the intended behavior instantiates the referenced sibling component, trims and slash-normalizes its value, and appends the result after `quality` in both the filesystem path and the URL. `buildMediaLocation()` (`src/core/media/path.ts`) already accepts a pre-resolved `additionalPathOverride`, and `svgOverlayLocation()` (`src/core/media/svg_overlay.ts`) shows the intended call shape — but `resolveMediaPathOptions()` (`src/core/media/ontology_path.ts`) does **not yet** read a sibling component's value into it. Today the path builder for SVG only honours `max_items_folder`. Ledgered gap.

### max_items_folder

- **Values:** integer (commonly `1000`).
- **Effect:** the fallback used **when `additional_path` is not set**. Files are bucketed into numbered subfolders of at most `max_items_folder` items: the appended path is `/` followed by `max_items_folder * floor(section_id / max_items_folder)` (e.g. section 1 -> `/0`, section 1500 -> `/1000`). Built by `additionalPath()` (`src/core/media/path.ts`), fed by `resolveMediaPathOptions()`.

### initial_media_path *(section property)*

- **Values:** string path fragment, keyed by component `tipo`, declared in the **section** `properties` under `initial_media_path`.
- **Effect:** read by `resolveMediaPathOptions()` (`src/core/media/ontology_path.ts`); inserted between `folder` and `quality` (a leading `/` is forced) by `buildMediaLocation()` (`src/core/media/path.ts`). Used to relocate a component's media tree to a custom base directory.

### external_source

- **Values:** a component `tipo` (string) pointing at a sibling [component_iri](component_iri.md) that holds an external URL.
- **Effect:** when set and the record has an id, the SVG is treated as a **link to a file outside Dédalo media**. `scanFilesInfo()` (`src/core/media/files_info.ts`) already resolves to a synthetic `external:true` item when given an `externalSource` override, and no local files are scanned. **Gap:** the read path only resolves and surfaces `external_source` on the API datum for `component_image` today (`resolveExternalSource()`, `src/core/section/read.ts`); SVG items don't yet carry it on read.

!!! note "Standard context properties"
    Like every component, `component_svg` honours the generic ontology context blocks carried into the datum `context`: `css` (style stamped on `.wrapper_component`), `request_config` (RQO) and `view` (the render view to use). The `context.features` block with the resolved media facts (`allowed_extensions`, `default_target_quality` = original, `ar_quality`, `default_quality`, current `quality`, `key_dir` (`"svg"`), `alternative_extensions`, `extension`) is built by `buildMediaFeatures()` (`src/core/section/media_features.ts`). These are read-only descriptors the client uses to pick the right file; they are not configurable options. Any other custom key seen in production should be verified in the ontology.

## Render views & modes

Views are selected from `context.view` (default `default`) and dispatched by the per-mode render files (`render_edit_component_svg.js`, `render_list_component_svg.js`, `render_search_component_svg.js`). Verified from the source and CSS:

| View | edit | list / tm | search | Notes |
| --- | :---: | :---: | :---: | --- |
| `default` | yes | yes | — | Edit: `image_container` + `<img class="image svg_element">` lazy-loaded via `IntersectionObserver` with a fade-in; an empty value shows the fallback image, clickable to fire `tool_upload`. List: a single `<img>` (thumb preferred, then default quality, then fallback) that opens the full-screen `viewer` window on click, or `tool_upload` when no file exists. |
| `line` | yes | — | — | Edit only. Reuses the default `content_data` but drops the label and adds an *exit edit* button (compact inline). |
| `print` | yes | — | — | Edit only. Reuses the `default` edit render but forces `permissions = 1` so the value is rendered read-only (no upload chrome) for print/PDF contexts. |
| `mini` | — | yes | — | Minimal `<img>` inside a `component_svg_mini` wrapper, image height clamped to one text row; used in compact listings / autocomplete. |
| `text` | — | yes | — | Renders the file as an `<img>` whose `src` is the resolved URL, inside a bare `<span>`, with an `error` handler that falls back to `page_globals.fallback_image`. |
| `tag` | — | yes | — | Used by `service_autocomplete` grid *choose*: an `<img class="svg">` carrying a `data-data` dataset (`section_tipo`/`section_id`/`component_tipo`). Prefers the default quality (`web`), falls back to thumb. |
| `viewer` | yes | — | — | Full-viewport presentation (`height: calc(100vh - 3rem)`), opened in a dedicated window from the list `default` view click handler. |
| (search) | — | — | yes | `render_search_component_svg.js` renders a plain text `<input class="input_value">` per filter; on change it builds an `update` `changed_data` item and publishes `change_search_element`. Saves are not performed in search mode. |

Modes:

- **edit** — read/write a real record; shows the current default-quality SVG and the upload UI; an empty value renders the upload-trigger fallback image.
- **list / tm** — read-only listing; `list` and `tm` share the same render. The list value is a reduced descriptor keeping only the default and thumb qualities; in `tm` (Time Machine) the URL resolves the last deleted file under the `/deleted` directory.
- **search** — emits an SQO filter input (plain text); no media is uploaded or rendered.

DOM (edit / default): `wrapper_component component_svg <tipo> <mode> view_default media_wrapper` -> `label`, `buttons_container` (tools + optional full-screen button), `content_data media_content_data` -> `content_value media_content_value` -> `image_container` -> `img.image.svg_element`.

## Import / export model

**Import.** `component_svg` has no bespoke import handling; a plain CSV string is *not* auto-wrapped into a value item — pass the descriptor as JSON (or a lang-keyed object, though SVG only has `lg-nolan`). The practical import payload is the file descriptor array:

```json
[{
    "original_file_name"      : "icon.svg",
    "original_normalized_name": "rsc855_rsc302_1.svg",
    "original_upload_date"    : { "timestamp": "2025-01-01 12:00:00" }
}]
```

Importing the descriptor records the metadata; the actual `.svg` bytes must already exist on disk under the deterministic path (importing the descriptor does not move bytes). For interactive ingestion the normal path is the **upload flow** (see Notes), which both stores the bytes and writes the descriptor. See [importing data](../../using/importing_data.md).

**Export.** A single export atom with `cell_type: "img"` whose scalar value is the resolved URL: the **default quality** URL in `edit` mode, the **thumb** quality URL in list/export contexts, or the `external_source` URL when the SVG links outside Dédalo. See [exporting data](../../using/exporting_data.md).

## Notes

- **Qualities / versions.** `mediaTypeOf('component_svg')` (`src/core/concepts/media.ts`, backed by `config.media.svg`) returns `qualities: ["original","web"]`, `defaultQuality: "web"`, `originalQuality: "original"`. A raster `thumb` is built beside them — it is not part of the configured ladder (`hasThumb` is a separate flag, and `files_info` appends the tier), exactly as for the other four models. **The renderer is librsvg, not ImageMagick** (`src/core/media/engine/svg.ts`): Dédalo runs ImageMagick under a hardened policy that disables the `MVG` coder its internal SVG renderer emits, so `rsvg-convert` renders the vector to an intermediate PNG at `DEDALO_SVG_THUMB_DPI` (150) and the shared thumbnail recipe reduces that to the thumb box. Where `rsvg-convert` is not installed the thumb is the only thing lost: the record, its files and its display are unaffected, and the failure is reported rather than silent. The original `.svg` is preserved byte-for-byte under the `original` folder; the `web` quality is normally the same SVG (`copyToQuality()`).
- **Inline content.** Inline embedding (returning the raw SVG XML for DOM manipulation rather than an `<img>` reference), and resolving a URL straight from a locator, have no named equivalents in this checkout; `baseSvgUrl()` (`src/core/media/svg_overlay.ts`) resolves the client-facing overlay URL for the related `component_image` use case. The plain-SVG inline-content read path should be verified against `src/core/section/read.ts` before relying on it.
- **Upload flow.** The multipart branch of the API dispatch (`src/server.ts`) hands off to `handleMediaUpload()` (`src/core/media/ingest/upload_endpoint.ts`, session + CSRF, chunked join + re-sniff) -> `tool_upload.process_uploaded_file` (`tools/tool_upload/server/index.ts`, write permission ≥ 2) -> `addFile()` (`src/core/media/ingest/add_file.ts`, confines + validates + moves into the `original` tier) -> `processUploadedFile()` -> `regenerateSvg()` (`src/core/media/processing.ts`, builds the `web` copy and then the raster thumb; a thumb that cannot be rendered is reported as a non-fatal error and never fails the upload).
- **Access control.** Media files are guarded by marker-based access control enforced by the web server itself (`src/core/media/protection.ts`): a daily-rotated `dedalo_media_auth` cookie grants a logged-in user unrestricted access via a zero-byte marker file, and an anonymous user may read only the published-quality files of published records via `.publication/pub/{section_tipo}_{section_id}` markers (written by the diffusion engine, `src/diffusion/targets/mediastore/media_index.ts`). Every failure path denies as a 404, never a 403, so the existence of unpublished media is never disclosed. A separate route in `src/server.ts` applies session-only gating with no per-record ACL — it exists purely as an opt-in development convenience (`MEDIA_DEV_ROUTE_ENABLED`, off by default) and must never be enabled in production. See the *dedalo-media-protection* skill.
- **Observers / observables.** No client `events_subscription.js` ships for this component; observer/observable wiring, when needed, is configured in the ontology `properties` like any other component (see the index page *Observers and observables* section) — client-side, unchanged.
- **Security.** `assertValidQuality()` (`src/core/concepts/media.ts`, SEC-065 strengthened — charset **and** ladder membership) confines the client-supplied quality before it reaches any filesystem path or URL, applied through the single `assertInsideMediaRoot()` chokepoint (`src/core/media/path.ts`).
- **Related components:** [component_image](component_image.md), component_av, component_3d, component_pdf, [component_iri](component_iri.md) (external_source source), [component_portal](component_portal.md), [component_select](component_select.md).
