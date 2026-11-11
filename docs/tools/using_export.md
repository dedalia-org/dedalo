# Export (`tool_export`)

> See also: [Tools user guide](index.md) · [Developer reference](../development/tools/reference/tool_export.md)

Export turns the records you are currently looking at in a section into a spreadsheet-style flat table. You choose which components become columns, in what order, and how relations and hierarchies are flattened, then download the result as CSV, TSV, ODS, XLSX, HTML or NDJSON — or as a machine-readable raw CSV for the [CSV import tool](using_import_dedalo_csv.md). The export runs on the server, so it can hold hundreds of thousands of records without slowing your browser down. It is a table, not a backup: for a complete, verified copy of a section set see [The archive door](../core/exporting_data.md#the-archive-door).

## What it's for

Dédalo stores richly structured data: multi-language values, relations to lists and thesauri, hierarchies and dataframes. That structure is what makes cataloguing precise, but a colleague, a printer or a spreadsheet expects a flat grid. Export is the bridge: it flattens the current selection into rows and columns that you shape for the job at hand, so nothing is a blind dump.

Concrete scenario: a numismatics cataloguer has filtered the *Coins* section down to the issues of a single mint and needs a report for a colleague. They open Export on that filtered list, drag *Inventory number*, *Weight*, *Diameter* and the related *Mint → name* into the active columns, pick a breakdown so each linked value lands cleanly, run the export, check the first pages of the preview and download an XLSX that holds every issue. The same column arrangement is saved as a named preset for the next batch.

## When to use it

- You need section data as a spreadsheet or report (CSV / TSV / ODS / XLSX / HTML), however many records the selection holds.
- You want to bulk-edit a section's values in a spreadsheet and load the edited cells back. Use the **Dédalo (Raw)** format, which wraps each cell so the [CSV import tool](using_import_dedalo_csv.md) can unwrap it and conform it like typed input.
- You want the media files referenced by a set of records.

When *not* to use it:

- To edit records — Export is read-only. Edit in the section itself.
- To produce a positioned, paginated document (a catalogue card, a study sheet) — use [Print](using_print.md) instead.
- To publish records to a live public site — use [Diffusion](using_diffusion.md).

## Where to find it

Export is a **section toolbar** button. It appears on a section when you view it in **list** mode. It is not an inspector or inline-component button, and it opens in **its own window** so you can keep the section list visible behind it.

The export always covers the **whole current selection** — every record matching your active filter, not just the page you can see. To export a subset, narrow the section filter first.

## Using it, step by step

The window has three panes: available components on the left, your active columns in the centre, and configuration plus the preview on the right.

1. Filter the section list down to exactly the records you want to export.
2. Open **Export** from the section toolbar.
3. From the left pane, drag the components you want into the centre **active columns** pane. The top-to-bottom order there is the left-to-right column order in the output.
4. For a relation or hierarchy column, drill into it to reach the related field you want (for example *Mint → name*). Columns of a portal or autocomplete whose target section is hierarchical (it has a parent component) additionally show a per-column **parents** checkbox: turn it on to also emit the ancestor chain of each linked term (nearest parent first, ` > ` separated) as a sibling *parents* column. Parents columns are produced by the **standard** (`value`) and **breakdown** (`grid_value`) formats. In the standard format the *parents* column sits right after its column, laid out exactly like its column: the same separators in the same places, with one chain for each term, in the same order (a term without parents leaves an empty slot). If one linked record shows several ` | `-separated values, its chain is repeated once for each value, so the two columns always split into the same number of pieces. The **Dédalo (Raw)** format exports stored data only, so the checkbox is disabled there, with a *(not in Raw)* note; your choice is kept and comes back when you switch format. A *related terms* column has a per-column **references** checkbox instead: turn it on to add a sibling *references* column with the related terms that are **calculated** (the terms that point at this one, in a field that works in both directions), never repeating the related terms stored on the record, which stay in the column itself. It works in the standard and breakdown formats and is disabled in **Dédalo (Raw)** in the same way. A relation column exports the sub-fields configured for it, joined with its configured separators; an indexation column shows a pointing record from a section you cannot read as its section name and id only.
5. On the right, choose the **data format** and, for a breakdown format, the **breakdown** mode (see [Options](#options)).
6. Press **Export**. The export runs on the server as a background job, and a status line counts the records written so far (*Exporting 12,000 / 48,213*). The first page of the **preview** appears as soon as it is ready and fills in while the job runs. Press **Stop** to cancel; nothing is kept from a stopped export.
7. Page through the preview with the pager (first, previous, next, last) and choose how many records a page shows (25, 50, 100 or 200). The preview is a sample to check the columns: it shows one page at a time, never the whole export. A very wide export (for example a breakdown into columns) shows 100 columns at a time; the *Columns 1–100 of …* bar above the table moves to the next ones. Every download holds every column.
   If the status line of a finished export ends with a note that some records are outside your scope, your own access narrowed the selection (for example, the filter goes through a field you are not allowed to read): the files hold fewer records than the filter asked for.
   If a column reads an **external source** (for example bibliographic data from Zenon) and that source could not answer while the export ran (it was down, too slow, or switched off), the status line says so: *Incomplete: 24 values from external sources (zenon) could not be read, in 12 records.* The export still finishes and its files stay downloadable, but a note under the download buttons says they are incomplete: those cells are empty in the files. When the source only needs time to come back, the note ends with *Run the export again once the source is available* and a **Run the export again** button repeats the very same export (same selection, columns and format, even if you changed the form since). When the source is switched off or wrongly configured, running it again will not help: ask your administrator. A reference the external source reports as *not found* is not counted: it is an answer, like an empty field. If some values were too long and were cut to the export's size limits, the status line says so separately: those values are in the files, only shortened, and neither running the export again nor your administrator changes that. If some values could only be taken from a recently saved copy of the external record, the status line says they may be out of date; they are in the files and are not counted as missing.
8. When the export has finished, the download buttons are enabled. Each one asks the server to build that file from the **whole** export — every record, not only the page on screen — and your browser saves it when it is ready (see [Downloads](#downloads)).
9. Optionally save the current column arrangement as a **named preset** so you can reuse it on the next batch. Presets are per user.

## Downloads

| Button | What you get |
| --- | --- |
| CSV | `;`-separated, every field quoted, UTF-8 with a byte-order mark so spreadsheet programs detect the encoding. |
| TSV | Tab-separated, unquoted. Tabs and line breaks inside a value become spaces. |
| ODS / XLSX | A spreadsheet where every cell is text, so `007` stays `007` and a date-like `03/04` is not reinterpreted. A sheet holds at most 1,048,575 data rows under its header; a longer export continues on `Sheet2`, `Sheet3`… with the header repeated, so nothing is truncated. XLSX refuses a cell longer than 32,767 characters (Excel's own limit) instead of cutting it; both formats refuse more than 16,384 columns. |
| HTML | The whole export as one standalone HTML table, with thumbnails and links. |
| NDJSON | The lossless export: every line of the export protocol exactly as the server produced it, for programs rather than people. When an external source left the export incomplete, its last line (`end`) carries an `external_degraded` summary, so a program can tell. |
| Media | A ZIP of the media files the export reached, including those reached through a related record: a portal column that shows the images of the records it points to offers them too, in every data format. A dialog asks for the **quality** of each media type in the export (for example the image and the PDF quality separately). A file goes into the ZIP only if you can read that component on that very record. The ZIP includes an `info.txt` that lists what was archived and what was left out, and why. An export made before this was possible lists its related-media columns as `rerun_required`: run the export again to include them. |
| Print | Prints the **current preview page only**, and the window says so. To print the whole export, download the HTML and print that. |

In CSV and TSV, a value that begins with `=`, `+`, `-`, `@`, a tab or a carriage return gets a leading `'`, so a spreadsheet program shows it as text instead of running it as a formula. A negative number such as `-5` is therefore written as `'-5`.

A file is built once and kept on the server; pressing the same button again with the same options reuses it. The media ZIP is the exception: it is built again every time you press its button, because it reads the media files as they are now (a derivative that has since been generated, or a file replaced, is picked up). Export files are **temporary**: they are deleted a set time after the export finished (24 hours unless your administrator changed it); building another file from it does not extend that time. An export also closes if your projects change after it ran (you were added to or removed from a project), or if the list of individual records you may see is changed: run it again to see the records you can read now. Each user also has a storage quota for export files, and may keep a limited number of exports at once (100 unless your administrator changed it); if a new export or file would take you over either, Dédalo stops it with a message that says so. The server also keeps some free space for everyone: when it runs short, new exports and files are refused until space is freed. Press **Delete export** to remove the export on screen with all its files and free its space at once, or try again when older exports have expired. Delete asks for confirmation and cannot be undone; it is offered only when the export is not running (press **Stop** first), and it is refused while one of its files is still being built.

Only you can download the files of your exports. If your access to the section or to one of the exported columns is removed after the export was built, its files can no longer be downloaded.

## Options

| Option | What it does |
| --- | --- |
| Active columns (drag order) | The components to export, in output order. Drag them from the available pane; reorder by dragging within the active pane. |
| Data format | `value` — one flat cell per column (the everyday choice). `grid_value` — a breakdown that explodes multi-valued relations. `dedalo_raw` — the wrapped form the CSV import tool unwraps (an edit-and-reload format, not a backup). |
| Breakdown | For the `grid_value` format only: `default`, `rows` (one row per related item) or `columns`. |
| Fill the gaps | Repeats record-level values on each exploded row so no cell is left blank. On by default. |
| Parents (per column) | On eligible relation columns (portal / autocomplete pointing at a hierarchical section), adds a sibling column with the target's ancestor chain. Off by default; set on each column in the active list — there is no global switch. Standard (`value`) and breakdown (`grid_value`) formats; disabled in Dédalo (Raw). |
| References (per column) | On *related terms* columns that work in both directions (the only ones that offer it), adds a sibling column with the calculated related terms (those that point at the record), never the stored ones. Off by default, per column. Standard and breakdown formats; disabled in Dédalo (Raw). |

## Tips and gotchas

!!! tip
    Save a preset once you have a column arrangement you like. Next time you export the same section you can load it instead of dragging every column again.

!!! warning "Raw CSV is not a backup and not a move"
    The **Dédalo (Raw)** format keeps a cell's structure through a spreadsheet edit, but the import re-conforms every cell as typed input: `component_text_area` markup is rewritten, `component_geolocation` item ids are dropped, empty cells clear values, media cells carry no files, and a relation's `section_id` is checked for shape only — on another installation it may name a different record. To back up a section set, carry it to another installation or keep a preservation copy, use [The archive door](../core/exporting_data.md#the-archive-door), which is verified to reconstruct every stored column byte for byte.

!!! warning
    Export always serializes the **entire filtered selection**, not the visible page. If you only want some records, tighten the section filter before you export; there is no page limit inside the tool. The preview's pager only changes what you *see*; every download holds every record.

!!! note "You can close the window"
    The export keeps running on the server when you close the tool. Open **Export** again on the same section and it reconnects to your latest export: its progress, its preview and its downloads. An export that is still waiting for its turn is shown as the current one too, and you can stop it. Each user can have a limited number of export jobs waiting or running at once (two by default, counting exports and files being built) and, by default, one download file being built at a time (so a long media ZIP never blocks other users' downloads). If you press a second download button while a file is being prepared, it waits and starts by itself when the first is ready; an export still running never blocks downloading one that has finished. A new export over the limit is refused with a message, and you can start it again when one finishes.

## Related

- **[Import from Dédalo CSV](using_import_dedalo_csv.md)** — consumes the `dedalo_raw` export to load edited cells back into the section.
- **[Print](using_print.md)** — for a positioned, paginated, record-driven document rather than a flat table.
- **[Diffusion](using_diffusion.md)** — the other way data leaves Dédalo: publishing to a live target instead of downloading a file.
- **[Exporting data](../core/exporting_data.md)** — the deeper guide to formats, breakdown modes, presets and the export contract.
- **[Developer reference](../development/tools/reference/tool_export.md)** — the API actions, options and internals.
