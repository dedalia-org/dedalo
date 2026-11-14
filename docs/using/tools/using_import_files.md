# Media file import (`tool_import_files`)

> See also: [Tools user guide](index.md) · [Developer reference](../../development/tools/reference/tool_import_files.md)

Ingest a batch of uploaded media files — images, audio, video, PDFs — into media records, extracting the capture date, keeping the original filename, and applying values you type once to every file.

## What it's for

Digitising a collection produces folders of files that each need to become a Dédalo media record. Doing that one upload at a time is slow and error-prone. This tool takes the whole batch: it creates (or matches) the record for each file, stores the file as the media component's content, reads the capture date out of the file's metadata, and copies any shared title or credit you typed once into every new record.

Concrete scenario: an oral-history archive has just scanned a box of photographs. Each scan is named with the interview's id and a target slot, for example `73-portrait-A.tiff`. The archivist opens an interview record, opens the import tool on its images portal, drops the whole folder, and the tool creates one Image record per file, stores each file, reads the EXIF *DateTimeOriginal* into the record's date component, saves the original filename into a text component, and propagates a typed-once title to every record. A later pass of post-processed masters can be re-attached to the *same* records by filename, using a **match** mode, without creating duplicates.

## When to use it

- You have a folder of media files that must become media records under a section.
- You want the capture date and original filename filled in automatically from the files.
- You need to re-attach reprocessed files to records you already created (match modes).

When NOT to use it:

- To import record *data* from a spreadsheet, use [CSV import](using_import_dedalo_csv.md).
- To rebuild or rotate the qualities of media already in Dédalo, use [Media versions](using_media_versions.md) or the image-rotation tool.

## Where to find it

Unlike most tools, this one appears **only where an administrator has configured it** — on a component (typically a `component_portal`) whose ontology carries a valid `ddo_map` under `tool_config.tool_import_files`. That map tells the tool which media component to fill, which text component gets the filename, which date component gets the metadata date, and which form fields to render. Where it is configured, it renders inline on that component or in the inspector, and opens in **its own window**.

If you do not see the tool on a section you expect to bulk-load, it has not been configured there yet — that is an ontology/administrator step, not something you set in the UI.

## Using it, step by step

1. **Open the tool** on the configured component and read the options panel at the top.
2. **Choose the target field** (the portal/slot the files go into) and the **quality** to store (defaults to `original`).
3. **Drop your files** onto the drop zone. Each file appears as a preview row.
4. **Fill the Values form** once. Any fields the administrator marked as inputs (a title, a credit, a language) render here, and their values are propagated to every imported record.
5. **Pick a naming strategy** if the tool offers the checkboxes (only in section-creating configurations):
   - *Prefix indicates id* / *Name indicates id* — the leading digits in the filename become the record id.
   - *Same name same record* — files sharing a base name land in one record.
   - *Suffix indicates field* — the trailing `-A`/`-B` letter picks the target slot per file.
   - *Matching ID* / *Matching name* — re-attach files to existing media records instead of creating new ones.
6. **Click IMPORT.** Progress streams live, with a running imported-of-total count and an estimate of the time remaining. When it finishes, the drop zone resets.

## Options

| Option | What it does |
| --- | --- |
| Target field | The portal/slot the uploaded files are stored in. |
| Quality | The media quality tier the file is ingested as (defaults to `original`); other tiers appear when the component declares them. |
| Processor (per file) | An optional named transformation applied to a file before import. See the gotcha below. |
| Suffix indicates field | Parse the `-A`/`-B` suffix to auto-assign each file's target slot. |
| Prefix / Name indicates id | Take the numeric prefix of the filename as the record id. |
| Same name same record | Group files sharing a base name into one record. |
| Matching ID | Re-attach files to existing records found by the id in the filename (creates no new records). |
| Matching name | Re-attach files to existing records whose stored filename matches the upload. |

The match modes are mutually exclusive with record creation and with each other; turning one on clears the others.

## Tips and gotchas

!!! tip "Let the filename do the work"
    Naming your files consistently — `73-portrait-A.tiff`, `73-A.tiff`, `73.jpg` — lets the tool route each file to the right record and slot without per-file clicking. The leading digits are the source id and the trailing letter is the target field.

!!! note "Existing data is never overwritten"
    The filename and metadata date are written **only when the target component is empty**. Re-running the tool over records that already have a date or filename leaves those values alone.

!!! note "Date extraction depends on the file type"
    Images read the date from EXIF, audio/video from the media stream, PDFs from their creation date. A file type the tool does not recognise simply yields no date — it is logged, not treated as an error.

!!! warning "Processors are disabled by default"
    The per-file processor selector lists any processors the configuration declares, but no processor is registered in the running engine, so selecting one **fails closed** — the file is refused rather than transformed. Leave the processor as *none* unless your installation has registered one.

!!! warning "Large batches run in the background and can be slow"
    Building the standard qualities for many large files takes time; the import runs detached and streams progress. Keep the window open to watch it, or reopen the tool to re-attach to a run still in progress.

## Related

- **[CSV import](using_import_dedalo_csv.md)** — import record data from a spreadsheet, not media files.
- **[Media versions](using_media_versions.md)** — build, rotate, delete and conform the qualities this tool creates.
- **[Posterframe](using_posterframe.md)** and the image-rotation tool — derive a posterframe from audiovisual, or rotate/crop image files.
- **[File upload](using_upload.md)** — the generic post-upload mover this tool builds on for storing files.
- **[MARC21 import](using_import_marc21.md)**, **[RDF import](using_import_rdf.md)**, **[Zotero import](using_import_zotero.md)** — the other importers (`tool_import_zotero` can also upload associated files).
- **[Importing data](../importing_data.md)** — the record-data import contract (this page covers *files*; that one covers *data*).
- **[Developer reference](../../development/tools/reference/tool_import_files.md)** — the `ddo_map` roles, match modes and API actions.
