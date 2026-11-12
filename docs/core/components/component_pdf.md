# component_pdf

## Overview

```json
{
    "could_be_translatable" : true,
    "is_literal"            : true,
    "is_related"            : false,
    "is_media"              : true,
    "modes"                 : ["edit","list","tm","search"],
    "default_tools" : [
        "tool_media_versions",
        "tool_pdf_extractor",
        "tool_time_machine",
        "tool_transcription",
        "tool_upload"
    ],
    "render_views" :[
        {
            "view" : "default | line | mini",
            "mode" : "edit | list"
        },
        {
            "view" : "viewer | player | print",
            "mode" : "edit"
        },
        {
            "view" : "text",
            "mode" : "list"
        }
    ],
    "data"        : "array",
    "sample_data" : [
        {
            "id": 3,
            "files_info": [
                {
                    "quality"    : "original",
                    "extension"  : "pdf",
                    "file_name"  : "test85_test3_1.pdf",
                    "file_path"  : "/pdf/original/0/test85_test3_1.pdf",
                    "file_size"  : 1866528,
                    "file_time"  : { "timestamp": "2026-01-04 12:54:38" },
                    "file_exist" : true
                },
                {
                    "quality"    : "web",
                    "extension"  : "pdf",
                    "file_name"  : "test85_test3_1.pdf",
                    "file_path"  : "/pdf/web/0/test85_test3_1.pdf",
                    "file_size"  : 1866528,
                    "file_time"  : { "timestamp": "2026-01-04 12:54:39" },
                    "file_exist" : true
                }
            ],
            "original_file_name"      : "Cecas _ Moneda Ibérica.pdf",
            "original_upload_date"    : { "timestamp": "2026-01-04 12:54:39" },
            "original_normalized_name": "test85_test3_1.pdf"
        }
    ],
    "value"        : "string (url)",
    "sample_value" : "/pdf/web/0/test85_test3_1.pdf"
}
```

!!! note "Typology"
    `component_pdf` is a **media** component. It is literal (`is_literal: true`) — its data is owned by its own section and is never a [locator](../locator.md) to another section — but it is also `is_media: true`, so it never stores the binary in the matrix; the `media` column only holds a thin JSON pointer to files on disk. In the TS server it is a lightweight descriptor (`src/core/components/component_pdf/descriptor.ts` — `{ model: 'component_pdf', column: 'media' }`); there is no per-model class hierarchy — the shared behavior (path grammar, `files_info` scanning, upload binding, versioning) lives in `src/core/media/*` alongside `component_3d`, `component_av`, `component_image` and `component_svg`.

!!! info "About `default_tools`"
    The list above is what a PDF instance receives in `context.tools` (verified from the model sample `src/core/components/component_pdf/samples/context.json`): `tool_media_versions`, `tool_pdf_extractor`, `tool_time_machine`, `tool_transcription` and `tool_upload`. The toolbar is assembled from the model + ontology; nothing hardcodes it. When the instance is translatable, `tool_lang` tooling is added like any other component; tools are read-only context. Server-side each tool is a registered module under `tools/<name>/server/`.

## Definition

`component_pdf` manages document files attached to a record — primarily PDFs, but also office documents (`doc`, `docx`/`odt`, `ods`, `rtf`, `ppt`, `pages`) which it stores as-is. It handles upload, on-disk storage, quality/version management, raster thumbnail generation, and — for true PDF files — automatic text extraction (transcription) and optional OCR. The displayable PDF is served through the bundled pdf.js viewer.

**Why it exists.** A cultural-heritage catalogue routinely needs to bind a full document to a record: a conservation report, an excavation memoir, a scanned archival folio, a publication offprint, a numismatic study, a catalogue raisonné chapter. `component_pdf` is the building block for all of them. Because it is a media component, the catalogue stores only a deterministic on-disk pointer and lets Dédalo manage the original, the web-served copy and the thumbnail. Because it can run `pdftotext` and `ocrmypdf`, it can populate a paired transcription [component_text_area](component_text_area.md) so the document body becomes searchable full text and can carry page tags that drive the viewer.

**When to use it.**

- A document attached to a record: report, memoir, scanned dossier, publication, transcription source.
- Cases where the document text should become searchable / editable transcription in a sibling [component_text_area](component_text_area.md), with clickable page tags that scroll the viewer (observer wiring, see *Notes*).
- Mixed document repositories where users upload `doc`/`odt`/`pages` etc. alongside PDFs (non-PDF uploads are stored verbatim, without transcription/OCR).

**When not to use it.**

- A raster image (photograph, scan to be displayed as a picture) -> use [component_image](component_image.md).
- Audio / video -> use `component_av`. 3D models -> use `component_3d`. Vector graphics -> use [component_svg](component_svg.md).
- A short literal string, code or note -> use [component_input_text](component_input_text.md). A link to another record -> use a related component such as [component_portal](component_portal.md).

## Data model

**Data:** `array`. A single-element array describing the stored file (its original/normalized names and the live per-quality `files_info`). Although the structure is an array, a PDF instance manages one document.

**Value:** `string` (a URL), or `null` — the data reduced to the displayable URL of the default quality.

**Storage shape.** A component never touches the database; it reads and writes through its section (`src/core/section/read.ts`, `src/core/section/record/save_component.ts`), which keeps the component's data in the matrix `media` column. The stored item is the thin JSON pointer — original/normalized file names — while `files_info` is reconstructed live by `scanFilesInfo()` (`src/core/media/files_info.ts`), scanning disk per quality and extension. Each `files_info` entry is `{quality, extension, file_name, file_path, file_size, file_time, file_exist}` (plus upload metadata at the item level).

Non-translatable variant (the common case — language slot `lg-nolan` is implicit, the on-disk name carries no `_lang` suffix):

```json
[
    {
        "id": 3,
        "files_info": [
            {
                "quality"    : "original",
                "extension"  : "pdf",
                "file_name"  : "test85_test3_1.pdf",
                "file_path"  : "/pdf/original/0/test85_test3_1.pdf",
                "file_size"  : 1866528,
                "file_time"  : { "timestamp": "2026-01-04 12:54:38" },
                "file_exist" : true
            },
            {
                "quality"    : "web",
                "extension"  : "pdf",
                "file_name"  : "test85_test3_1.pdf",
                "file_path"  : "/pdf/web/0/test85_test3_1.pdf",
                "file_exist" : true
            }
        ],
        "original_file_name"      : "Cecas _ Moneda Ibérica.pdf",
        "original_upload_date"    : { "timestamp": "2026-01-04 12:54:39" },
        "original_normalized_name": "test85_test3_1.pdf"
    }
]
```

Translatable variant. `component_pdf` *can* be instantiated as translatable; when it is, the deterministic file name gains the data-language suffix (`_lg-eng`, `_lg-spa`, …), so each language version keeps its own file (e.g. `test85_test3_1_lg-eng.pdf` vs `test85_test3_1_lg-spa.pdf`). The component still resolves only the language it was instantiated with.

!!! note "Datum vs. API `entries`"
    The transmitted unit is a `{context, data}` datum (the JSON-API contract). In the API payload the data items are surfaced under `data.entries` (see `src/core/components/component_pdf/samples/api_data.json`), accompanied by `parent_tipo`, `parent_section_id` and the `from_component_tipo`. `context` carries the description (`tipo`, `model`, `mode`, `lang`, `label`, `properties`, `permissions`, `tools`, `view`) plus a media-specific `features` block (`allowed_extensions`, `default_target_quality`, `ar_quality`, `default_quality`, `quality`, `key_dir`, `alternative_extensions`, `extension`) built by `buildMediaFeatures()` (`src/core/section/media_features.ts`) and never the binary. See the *dedalo-context-data-layers* skill for the full layering rules.

### Qualities and the original model

`component_pdf` declares two qualities plus a thumb, mirrored on the TS side by `mediaTypeOf('component_pdf')` (`src/core/concepts/media.ts`, backed by `config.media.pdf`):

- `original` (`DEDALO_PDF_QUALITY_ORIGINAL`) — the exact uploaded file, preserved under its own quality folder keeping its source extension via `original_normalized_name`. Originals are never overwritten on re-upload without a backup (`renameOldFiles()`, `src/core/media/file_ops.ts`, short-circuits — no-ops — when nothing already exists at the target).
- `web` (`DEDALO_PDF_QUALITY_DEFAULT`, the default quality) — a copy generated from the original by `regeneratePdf()` -> `copyToQuality()` (`src/core/media/processing.ts`); this is the file the viewer serves, the one text is extracted from, and the one OCR writes its text layer into. OCR never touches `original`.
- `thumb` (`DEDALO_QUALITY_THUMB`, raster `jpg`) — a preview rendered from the **first page only** (`<pdf>[0]`) by `buildThumbVersion()` (`src/core/media/processing.ts`). The page is rasterized by **Ghostscript, spawned by the engine itself** (`src/core/media/engine/ghostscript.ts`, `DEDALO_GS_PATH`), never by ImageMagick: ImageMagick can only read a PDF by forking Ghostscript as a *delegate* — a process the engine never sees and therefore cannot bound or kill — and the shipped policy denies that delegate. A page whose pixel size at the render density is above this installation's ceiling (`DEDALO_MAGICK_LIMIT_WIDTH`/`_HEIGHT`) is refused before anything is drawn. The resulting PNG then goes through the ordinary thumb recipe fit to the thumb box. The page selector is load-bearing: without it ImageMagick rasterizes *every* page of a multi-page PDF to `<stem>-0.jpg`/`<stem>-1.jpg`/… (no scene selector → per-page split) and never the single expected file, so the atomic-rename staging would `ENOENT`. Used in list / mini views.

`qualities` -> `DEDALO_PDF_AR_QUALITY` (`["original","web"]`). Alternative versions (`DEDALO_PDF_ALTERNATIVE_EXTENSIONS`, default `["jpg"]`) are rendered per quality by `buildPdfCovers()` (`src/core/media/processing.ts`): the first page is rasterized ONCE by `engine/ghostscript.ts` and that raster is encoded into every declared extension.

## Ontology instantiation

A `component_pdf` is created as an ontology node whose `model` is `component_pdf`. Its `parent` is the section (or grouper) it belongs to, and its `section_tipo` wires it into that section. The node declares its label and (optional) translatability through the standard `lg-*` term + `translatable` ontology flags.

Node definition (shape):

```json
{
    "tipo"         : "test85",
    "model"        : "component_pdf",
    "parent"       : "test3",
    "section_tipo" : "test3",
    "lg-eng"       : "Document",
    "lg-spa"       : "Documento",
    "translatable" : false,
    "properties"   : { }
}
```

Realistic `properties` block for a PDF whose original filename is captured into a sibling input, that paginates its on-disk folders, and whose page tags drive a transcription text area:

```json
{
    "target_filename" : "test84",
    "max_items_folder": 1000,
    "observe": [
        {
            "client": {
                "event": "click_tag_pdf",
                "perform": { "function": "go_to_page" }
            },
            "component_tipo": "test97"
        },
        {
            "client": {
                "event": "key_up_f2",
                "perform": { "function": "get_data_tag" }
            },
            "component_tipo": "test97"
        }
    ]
}
```

`section_tipo` / `parent` tell the section which `media` column owns this component's data; the section is the single writer to the database (`src/core/section/record/save_component.ts`). The on-disk path is resolved from section + component properties: `DEDALO_MEDIA_PATH + folder ('/pdf') + initial_media_path + '/' + quality + additional_path`, computed by `buildMediaLocation()` (`src/core/media/path.ts`). `initial_media_path` comes from the *section* `properties.initial_media_path`, keyed by the component `tipo`, and is read by `resolveMediaPathOptions()` (`src/core/media/ontology_path.ts`); `additional_path` today is only the `max_items_folder` fallback bucketing — reading a sibling component's value into `additional_path` is **not yet wired** (see *Properties & options*). Every resulting path is confined by `assertInsideMediaRoot()`, and the quality string is validated by `assertValidQuality()` (`src/core/concepts/media.ts`, SEC-065 strengthened) to keep client values out of the filesystem path.

## Properties & options

All properties are optional and live in the ontology node `properties` JSON. Verified names consumed by this component (and by the shared media engine):

### target_filename

- **Values:** an ontology `tipo` of a sibling `component_input_text` in the same section (e.g. `"test84"`). Default unset.
- **Effect:** intended to write the uploaded document's `original_file_name` into that input component on upload. **Not yet wired for interactive upload**: `processUploadedFile()` (`src/core/media/ingest/process_uploaded_file.ts`) stores the original filename on the media item itself but does not write it back to the sibling component; `target_filename` is honoured today only by the bulk `tool_import_files` matcher (`src/core/tools/import_files_match.ts`).

### max_items_folder

- **Values:** integer (commonly `1000`). Default unset.
- **Effect:** folder bucketing fallback when `additional_path` is not set. The on-disk `additional_path` becomes `/<max_items_folder × floor(section_id / max_items_folder)>`, so files are spread across numbered subfolders. Ported as `additionalPath()` (`src/core/media/path.ts`), fed by `resolveMediaPathOptions()` (`src/core/media/ontology_path.ts`).

### additional_path

- **Values:** an ontology `tipo` of a component whose value supplies an extra path segment. Default unset.
- **Effect:** intended to append the resolved component value (slash-normalised) to the media path, overriding the `max_items_folder` bucketing. `buildMediaLocation()` (`src/core/media/path.ts`) already accepts a pre-resolved `additionalPathOverride`, but `resolveMediaPathOptions()` does **not yet** read a sibling component's value into it — today only `max_items_folder` is honoured for PDF.

### initial_media_path *(section property)*

- **Values:** object keyed by component `tipo` -> path string, declared on the **section** `properties`, not the component. Default unset.
- **Effect:** inserts a fixed path segment after the media `folder`. Read by `resolveMediaPathOptions()` (`src/core/media/ontology_path.ts`) and applied by `buildMediaLocation()` (`src/core/media/path.ts`).

### external_source

- **Values:** an ontology `tipo` of a sibling [component_iri](component_iri.md). Default unset.
- **Effect:** lets the media live outside Dédalo. `scanFilesInfo()` (`src/core/media/files_info.ts`) already accepts an `externalSource` override and emits the `external:true` entry. **Gap:** the read path only resolves and surfaces `external_source` on the API datum for `component_image` today (`resolveExternalSource()`, `src/core/section/read.ts`); PDF items don't yet carry it on read.

### observe / observers

- **Values:** arrays of observer/observable descriptors (see the index page *Observers and observables*).
- **Effect:** wire the PDF viewer to a transcription [component_text_area](component_text_area.md); this is client-side wiring (unchanged — the client is copied as-is). The sample model subscribes the PDF to `click_tag_pdf` (-> `go_to_page`, scrolls the viewer to the tagged page) and `key_up_f2` (-> `get_data_tag`, hands the current page/offset back so the text area can insert a `page` tag).

!!! note "OCR / transcription configuration"
    OCR and text extraction are **not** ontology properties — they are global config + per-upload options: `PDF_AUTOMATIC_TRANSCRIPTION_ENGINE` (`pdftotext`), `PDF_OCR_ENGINE` (`ocrmypdf`) and `DEDALO_TESSERACT_PATH` (`tesseract`, asked only which language models are installed). The one ontology fact they read is the node's `relations`, which names the transcription text area — see [Transcription and OCR](#transcription-and-ocr). Supported upload extensions come from `DEDALO_PDF_EXTENSIONS_SUPPORTED` (`config.media.pdf.allowedExtensions`).

!!! note "Standard context properties"
    Like every component, `component_pdf` also honours the generic ontology context blocks carried into the datum `context`: `css` (style stamped on `.wrapper_component`), `request_config` (RQO) and `view` (the render view to use). Any other custom key seen in production should be verified in the ontology.

## Transcription and OCR

A PDF's text is written into the [component_text_area](component_text_area.md) the PDF node names in its ontology `relations`. The core resource sections wire one pair each:

| Section | PDF (`component_pdf`) | Transcription (`component_text_area`) |
| --- | --- | --- |
| `rsc2` *Resources Media* | `rsc37` *Document* | `rsc38` *Transcription* |
| `rsc3` *Publications Media* | `rsc209` *Document* | `rsc210` *Transcript / Description* |
| `rsc4` *Administration Media* | `rsc165` *Document* | `rsc166` *Transcription* |

The suite's `test3` playground wires `test85` → `test97` the same way. A PDF whose `relations` name no `component_text_area` gets no transcription, and nothing is reported.

**What is written.** The text comes from `pdftotext` (`src/core/media/ingest/pdf_transcription.ts`), read from the `web` copy (the `original` when no `web` copy exists yet). Each physical page becomes a page tag paragraph followed by the page's text, one paragraph per line, with the text HTML-escaped so that a reading such as `IMP CAES<A>R` survives as text:

```html
<p>[page-n-1-1-data:[1]:data]</p><p>First line of page 1</p><p>Second line</p>
<p>[page-n-2-2-data:[2]:data]</p><p>First line of page 2</p>
```

The tag is the same one [`tool_pdf_extractor`](../../tools/using_pdf_extractor.md) writes (`pdfPageTag()`, `src/core/media/pdf_page_tag.ts`). Its second number is the logical page: physical page N minus 1, plus the PDF's stored page offset (`lib_data.offset`, 1 when unset). The text is saved through the ordinary save path, so Time Machine records it, as the user who triggered it, in the user's **current data language** (`lg-nolan` when the text area is not translatable).

**When it is written.** Three paths, two rules:

| Trigger | Rule | When the transcription already holds text |
| --- | --- | --- |
| Upload of a new PDF to the `original` quality | overwrite | It is **replaced**. The upload shows a notice naming how many characters were replaced; Time Machine keeps the previous version. |
| The OCR job, after an upload with **OCR** ticked | overwrite | Same as above. |
| [`tool_update_cache`](../../tools/using_update_cache.md), and **Regenerate files** in [`tool_media_versions`](../../tools/using_media_versions.md) | fill only if empty | It is **kept**, never overwritten. Neither runs OCR. |

An upload into any other quality, and a non-PDF document (`doc`, `odt`, …), writes no transcription. A PDF with no text layer (two characters of text or fewer) writes nothing and says so. Transcription failures never fail the upload: they are reported beside it, and the text area is left untouched. The emptiness check and the write happen under the record's row lock, in one transaction, so text a curator saves while `pdftotext` runs is never taken for an empty field.

**OCR.** The upload panel offers an **OCR** checkbox and a language selector for PDF uploads, but only when the server can run it: [`get_system_info`](../../api/classes/dd_utils_api.md#get_system_info) reports `pdf_ocr_engine: true` (the `ocrmypdf` binary is present and executable) and at least one application language in `pdf_ocr_langs` (its Tesseract model is installed). The selector lists only those languages, preselecting the current data language when it is one of them. The language reaches the server as `process_options: { ocr: true, ocr_lang: "lg-spa" }` (`tools/tool_upload/server/index.ts`); a language without a Tesseract model, an unknown key or a non-boolean `ocr` is refused with `request.invalid_options` before the file is moved.

With OCR ticked, the upload does not transcribe at once. It starts a background media job (`pdf_ocr`, `src/core/media/pdf_ocr.ts`, shown in the uploader's activity tray) that:

1. runs `ocrmypdf --force-ocr` on the `original` and writes the result to the `web` quality, atomically — the archival original is never modified, and the job refuses to run when `web` resolves to the same file as the original;
2. refreshes the record's `files_info`;
3. writes the transcription from the new `web` copy, with the overwrite rule.

A job whose OCR finished but whose transcription was not written ends as an error in the tray, not as done. The Tesseract model for a Dédalo language is the code without `lg-` (`lg-spa` → `spa`), except Valencian (`lg-vlca` → `cat`) and Chinese (`chi_sim`); the map is `src/core/media/engine/ocr_langs.ts`, and the installer reads the same map to install the language packs ([Production › `host_packages`](../../install/production.md#host_packages-packages-and-repositories)).

**PDFs uploaded before transcription existed.** Records whose transcription is empty can be filled by running [`tool_update_cache`](../../tools/using_update_cache.md) over their section. Running it is an operator's decision; nothing backfills on its own. A revert of that run removes the fills.

## Render views & modes

Views are selected from `context.view` (default `default`) and dispatched by the per-mode render files (`render_edit_component_pdf.js`, `render_list_component_pdf.js`, `render_search_component_pdf.js`). Verified from the source and the `.less`:

| View | edit | list / tm | search | Notes |
| --- | :---: | :---: | :---: | --- |
| `default` | yes | yes | — | Edit: full wrapper with label, buttons, upload UI, default-quality file. List: the thumb/default rendering. |
| `line` | yes | — | — | Compact inline rendering; falls through to the default edit view. |
| `mini` | yes | yes | — | Minimal `component_pdf_mini` (small thumb), used in tight layouts / autocomplete. |
| `viewer` / `player` | yes | — | — | Full pdf.js viewer (`view_viewer_pdf`); `content_data` takes the full height; right-click context menu suppressed. This is the view that the page-tag observers drive. |
| `text` | — | yes | — | Inline `view_text_list_pdf` (thumb image only, no chrome). |
| `print` | yes | — | — | Reuses the `default` edit view but forces read-only rendering (`permissions = 1`) and tags the wrapper `view_print`. |

Modes (the standard component set `["edit","list","tm","search"]`):

- **edit** — read/write a real record; upload (`tool_upload`), version management (`tool_media_versions`), text extraction (`tool_pdf_extractor`), transcription (`tool_transcription`), and the pdf.js viewer.
- **list / tm** — read-only listing; `tm` (Time Machine) reuses the list render and resolves the last deleted file under `/deleted`. The list cell shows the reduced (thumb-quality) data.
- **search** — builds an SQO filter input; one text input per filter (only one input is allowed). Saves are blocked in search mode. **Gap:** the media models declare no `searchBuilder` family, so a search filter against `component_pdf` throws loudly in `src/core/search/conform.ts` instead of resolving to SQL.

DOM (edit / default): `wrapper_component component_pdf <tipo> <mode>` -> `label`, `buttons`, `content_data` -> `content_value`.

## Import / export model

**Import.** Media files are normally bound through the upload flow rather than CSV import. The upload pipeline is permission-gated and ordered:

1. Multipart/chunked receiver — the API dispatch's multipart branch (`src/server.ts`) hands off to `handleMediaUpload()` (`src/core/media/ingest/upload_endpoint.ts`): session + CSRF required, chunked join with a re-sniff of the assembled file, magic-byte MIME sniffing.
2. `tool_upload.process_uploaded_file` (`tools/tool_upload/server/index.ts`) — permission-gated (write level ≥ 2), resolves the media context.
3. `addFile()` (`src/core/media/ingest/add_file.ts`) — confines the staged source, validates the extension, moves the file into the `original` quality tier.
4. `processUploadedFile()` -> `regeneratePdf()` (`src/core/media/processing.ts`) — builds the `web` copy, the jpg cover and the thumb. Non-PDF documents (`doc`, `odt`, `pages`, …) are stored under the `original` tier by the same flow but `regeneratePdf()` skips PDF-specific derivative building for them. **Not yet ported**: writing `target_filename` back to a sibling component (see *Properties & options*).
5. For a PDF uploaded to `original`, the transcription is written into the related `component_text_area`, or, with OCR ticked, the OCR job is started once the record's media data is saved (see [Transcription and OCR](#transcription-and-ocr)).

See [importing data](../importing_data.md#related-data) for the broader import model.

**Export.** A single export atom carrying the media URL, `cell_type` `img`. In `edit` it resolves the default quality, otherwise the thumb quality; URL absoluteness is taken from the `export_context`. See [exporting data](../exporting_data.md).

## Notes

- **Text extraction & OCR.** `extractText()` (`src/core/media/engine/pdf.ts`, wrapping `pdftotext` via argv-only `Bun.spawn` — no shell is involved, so no argument quoting is needed) serves both the read-only `tool_pdf_extractor.get_pdf_data` action (`tools/tool_pdf_extractor/server/index.ts` -> `extractPdfCore()`, `src/core/media/tools/pdf_extract.ts`) and the automatic transcription, through a private temporary file — never a `.txt` beside the PDF in the media tree. The single `ocrmypdf` spawn is the `pdf_ocr` media job (`buildOcrArgv()`, `ocrmypdf --force-ocr`). It does not take a converter permit, because a permit held for minutes would push queued thumbnails into a 429; the media job lane bounds how many run at once, and a run silent for 30 minutes is stopped. See [Transcription and OCR](#transcription-and-ocr).
- **Thumbnails / alternative versions.** `buildThumbVersion()` and `buildPdfCovers()` (`src/core/media/processing.ts`) rasterize the PDF page with **Ghostscript, spawned by the engine itself** (`src/core/media/engine/ghostscript.ts`): the page box is read with poppler first and a page above the configured pixel ceiling is refused before anything renders. ImageMagick is not asked to read the PDF at all — the hardened policy denies the Ghostscript *delegate*, because a delegate is a child the engine never spawns and therefore cannot bound or kill. The resulting PNG is handed to the ordinary image recipe. The retired ImageMagick recipe rendered the **CropBox**; Ghostscript renders the **MediaBox**, so a cover of a PDF whose CropBox is smaller than its MediaBox now includes the trim margins.
- **Observers / observables.** The model wires the pdf.js viewer to a sibling transcription text area: `click_tag_pdf` -> `go_to_page`, `key_up_f2` -> `get_data_tag`. Configured in the ontology `properties` — client-side wiring, unchanged (the client is copied as-is).
- **Default tools.** A PDF instance exposes `tool_media_versions`, `tool_pdf_extractor`, `tool_time_machine`, `tool_transcription` and `tool_upload` in `context.tools`; tools are read-only context. Each is a registered server module under `tools/<name>/server/`.
- **Media access control.** Files are guarded by the native media-protection subsystem (`src/core/media/protection.ts`, `DEDALO_MEDIA_ACCESS_MODE`: `false` / `private` / `publication`): a daily-rotated `dedalo_media_auth` cookie for logged-in users, `.publication/pub/{section_tipo}_{section_id}` markers for anonymous publication access. It is enforced by the **web server** (the reverse proxy) reading the generated rule files (`writeRuleFiles()`), not by the Bun process itself. `src/server.ts` also exposes a dev-only media route gated only on having *any* authenticated session, with no per-record access control — it deliberately bypasses the generated web-server rules and must never be enabled outside local development (see the *dedalo-media-protection* skill).
- **Permissions.** Resolved via `getPermissions()` (`src/core/security/permissions.ts`; 0 none / 1 read / 2 read+write / 3 admin). Read users (level 1) get read-only rendering; upload / save require level >= 2, enforced per-action by the tool registry's `minLevel` gate.
- **Related components:** [component_image](component_image.md), [component_svg](component_svg.md), [component_text_area](component_text_area.md), [component_iri](component_iri.md), [component_input_text](component_input_text.md), [component_portal](component_portal.md).
