# Exporting data

> See also: [Importing data](importing_data.md) · [Component dataframe](components/component_dataframe.md) · [Glossary](glossary.md)

Take a section's records and turn them into a flat downloadable table (CSV, TSV, ODS, XLSX, HTML or NDJSON), or a machine-readable raw CSV for the import tool. This page covers the export tool's UI and, for developers, the export pipeline and component contract. For a complete, verified copy of a section set — the backup, the move between installations, the preservation copy — see [The archive door](#the-archive-door): the export tool is not that.

## Introduction

Exporting is the counterpart of [importing](importing_data.md): it takes the data
of a section and turns it into a flat table (rows and columns) that you can
download as CSV, TSV, ODS (LibreOffice), XLSX (Excel), HTML or NDJSON. You can
also download the media files (images, audiovisuals, PDFs, 3D, SVG) referenced by
the exported records.

The export runs **on the server**, as a background job. The browser shows one page
of it at a time and receives each download as a finished file, so an export of
hundreds of thousands of records works the same way as an export of ten.

Because Dédalo stores **highly structured** data — values in several languages,
relations to lists and thesauri, hierarchies, dataframes — exporting is not a
simple dump. The export tool lets you decide **which components become columns**,
**in which order**, and **how relations and hierarchies are flattened** into a
spreadsheet, so the result is meaningful for the use you have in mind (a report, a
migration, a backup, an analysis in a spreadsheet, etc.).

A special **raw** format produces machine-shaped cells (`{"dedalo_data": …}`) the
[CSV import tool](importing_data.md) recognizes. It is **not** a backup and **not**
a way to move data between installations — see
[Raw export and the import tool](#raw-export-and-the-import-tool) for what it
does and does not preserve, and [The archive door](#the-archive-door) for the
door that is.

!!! info "What gets exported"

    The export always covers the **whole current selection** of the section — the
    set of records produced by your current search/filter — not just the page you
    are looking at. Configure the search first, then export.

## Opening the export tool

1. Open a section in **list** mode and configure the search/filter so the list
   shows the records you want to export.
2. Click the **Export** button in the section toolbar.

The export tool opens in its own window with three areas:

- **Left** — the list of the section's components (the available columns). Relation
  components can be expanded to reach the components of the related section.
- **Center** — *Active elements*: the columns you have chosen, in order.
- **Right** — the configuration panel: presets, format and options, the **Export**
  and **Stop** buttons, the download buttons, and the paged preview.

## Choosing the columns

**Drag a component** from the left list and **drop it** into the *Active elements*
list in the center. Each dropped component becomes one column of the export.

- **Order matters.** The export columns follow the exact order of the *Active
  elements* list. **Drag the items up and down** to reorder them; the output
  columns (and every download) follow that order.
- **Where it lands.** While you drag (a new component or an item being
  reordered), a line shows exactly where it will be placed: before the row under
  the pointer when you are over its upper half, after it over the lower half, and
  at the end when you are below the list. A component that is already in the list
  is highlighted instead, and cannot be added twice.
- **Remove** a column with the **×** on its item.
- **Activate all columns / Deactivate all columns** add or clear the whole set at
  once.
- **Relations and hierarchies**: expand a relation component (▶) on the left to
  reach the components of the related section and export them as columns too (for
  example, export the *name* of a related "Mint" instead of just the link).

!!! tip "The order you drop and drag is the order you get"

    The list of *Active elements* is the single source of truth for the column
    order. If you reorder the items, the next export — and the CSV/Excel/… you
    download — reflects the new order exactly.

### Per-component "parents" (ancestor chain)

Hierarchical components (thesaurus terms) have a chain of ancestors. When you add
a portal or autocomplete column whose target section is hierarchical, you get a small
**parents** checkbox on its item: enable it to add a sibling column with the term's
ancestor chain (nearest parent first, joined with ` > `). The option is per column
only; there is no global switch. It applies to the **Standard** and **Breakdown**
formats (disabled in **Dédalo (Raw)**) and is off by default.

### Per-component "references" (calculated relations)

A *related terms* column (`component_relation_related`) exports the relations
**stored** on the record. When the field works in both directions (bidirectional or
multidirectional), it also has **calculated** relations: the terms that point at it.
Those are not part of the column. Its item has a small **references** checkbox:
enable it to add a sibling column, headed with the column name followed by
*references*, holding the calculated relations only (never repeating the stored
ones). Like *parents*, the option is per column, off by default, and applies to the
**Standard** and **Breakdown** formats; it is disabled in **Dédalo (Raw)**, which
exports stored data only. A unidirectional related field has no calculated relations,
so it shows no checkbox — and an export request that sets the option on a column
without calculated relations is refused (`request.invalid_options`) rather than
silently exporting less than was asked.

### What a relation column contains

A relation column exports the sub-fields configured for it (the fields you expanded
or, for an unexpanded relation, those its configuration lists), at every level of
nesting, joined with the separators configured for that column. Every relation field
exports its values, including *Projects*, *Publishable*, *Language*, *Parent*,
*Children*, *Related* and *Index* (indexations). In an indexation column, a pointing
record from a section you may not read exports as its section name followed by its
id, and nothing else.

### What a backlinks column contains

A *backlinks* field — for example **Relations** (`dd1596`, a `component_inverse` in the
*Section info* group every section carries) — stores nothing: it lists the records
that point at the current one. In the **Standard** format it is one column holding
the ids of every calling record (the callers of each calling field together, in
ascending order, joined with `, `; the groups joined with the column's configured
separator, `, ` by default). In the **Breakdown** format it grows **one column per
calling field** (a People record pointed at by interviews through their *Informants*
field gets a *Relations | Informants* column), and each caller is its own related
item: in the **Default** and **Rows** modes each calling field's column lists its
callers one per row (the record takes as many rows as its busiest calling field), one `|n` column per
caller in **Columns**. Callers
from records you may not read are left out, exactly as in the record's edit view
(a global administrator sees them all).

## Export options

All options are in the right-hand configuration panel.

### Format

| Format | Value | What it produces |
| --- | --- | --- |
| **Standard** | `value` | One flat value per cell. Multiple values of a relation are joined in the same cell with the column's configured separators; an empty related record keeps its place between them. The most readable format. |
| **Breakdown** | `grid_value` | Relation items are *exploded* into extra rows and/or extra `\|n` columns, so each related item gets its own cell. See [Breakdown mode](#breakdown-mode). |
| **Dédalo (Raw)** | `dedalo_raw` | Each cell is the stored Dédalo value wrapped as `{"dedalo_data": …}`. Not meant to be read by humans; it is the format the **import tool** unwraps (see [Raw export and the import tool](#raw-export-and-the-import-tool)) — not a verbatim copy of the stored row. |

### Breakdown mode

Only applies to the **Breakdown** format. It controls how a component with several
related items (for example a record linked to three "types") is laid out:

| Mode | Value | Layout |
| --- | --- | --- |
| **Default** | `default` | The first relation level becomes extra **rows**; deeper levels become extra **`\|n` columns**. Keeps the legacy behavior. |
| **Rows** | `rows` | Every related item becomes an extra **row**. Sibling columns are aligned; spanning (parent) values can be repeated down the rows (see [Fill the gaps](#fill-the-gaps)). |
| **Columns** | `columns` | Every related item becomes extra **columns** with a `\|n` suffix. One row per record. |

!!! example "Rows vs Columns"

    A record *R1* linked to mints *A* and *B*:

    **Columns** (one row per record):

    | id | Mint\|1 | Mint\|2 |
    | -- | ------- | ------- |
    | R1 | A       | B       |

    **Rows** (one row per related item):

    | id | Mint |
    | -- | ---- |
    | R1 | A    |
    | R1 | B    |

### Fill the gaps

(Default **on**.) In the **Rows** breakdown, when a record explodes into several
rows, the values that belong to the record itself (not to the exploded relation)
are **repeated** on every row instead of being left blank. Turn it off to leave the
spanning cells empty except on the first row.

### Show ontology tipo

Adds the component **ontology tipo** to the column headers (useful to identify
exactly which component a column maps to), in the preview and in the downloaded
files built while it is on.

## Running an export

Press **Export**. The export is submitted to the server as a **background job** and
the tool follows it: a status line counts the records written so far against the
total (*Exporting 12,000 / 48,213*), then says when the export has finished.
**Stop** cancels it; a stopped export keeps nothing.

The job does not depend on the window. Close the tool and the export keeps running;
open **Export** again on the same section and the tool reconnects to your latest
export there, with its progress, its preview and its downloads.

Exports wait in one queue shared by every user of the installation, and the
server runs a limited number at a time (one by default), so yours may wait for
another user's to finish before it starts. Building a download file from a
finished export has a queue of its own (two at a time by default), so a download
never waits behind someone else's export. Each user may have only a few export jobs waiting or running
at once (two by default: exports being built plus files being built from them); a
request over that limit is refused with a message and nothing is queued.

## The preview

The preview shows **one page** of the export at a time. Use the pager (first,
previous, next, last) to move through it, and the page-size selector to show 25, 50,
100 or 200 records per page. A page is counted in **records**: in the **Rows**
breakdown, all the rows of one record stay on the same page. While the export is
still running the pages fill as records are written, and the columns appear in the
order they are discovered; once it has finished they take their final order.

The preview is a **sample** to check that the columns, formats and breakdown are
what you want. It is never the export itself: a download always contains every
record of the selection, whichever page is on screen. A very long cell (a full
transcription, for example) is cut in the preview and ends in `…`; the downloads
always carry the whole value.

The preview has a sticky header, a frozen first (id) column, zebra rows, image and
audiovisual thumbnails, and clickable links — so even wide exports stay readable.

## Downloading the data

The download buttons are enabled when the export has finished. Each one asks the
server to build that file from the **whole** export; the tool shows *Preparing file*
while it is built and then your browser saves it directly. A file already built for
the same options is reused.

| Button | File | Notes |
| --- | --- | --- |
| **CSV** | `.csv` | `;`-separated, every field double-quoted, UTF-8 with a byte-order mark. Re-importable (see below). |
| **TSV** | `.tsv` | Tab-separated, unquoted; tabs and line breaks inside a value become spaces. |
| **ODS** | `.ods` | LibreOffice Calc. Every cell is a text cell. |
| **XLSX** | `.xlsx` | Microsoft Excel. Every cell is a text cell. |
| **HTML** | `.html` | The whole export as one standalone HTML table, with thumbnails and links. |
| **NDJSON** | `.ndjson` | The lossless export: every line of the [flat-table protocol](#the-flat-table-ndjson-protocol), exactly as the server produced it. For programs, not people. |
| **Media** | `.zip` | The media files (image, audiovisual, PDF, 3D, SVG) referenced by the exported records. A dialog asks for the **quality** of each media type present in the export. |
| **Print** | — | Prints the **current preview page only**, and the window says so. To print the whole export, download the HTML and print that. |

!!! note "Encoding"

    Text downloads are UTF-8. CSV uses `;` as the field separator and escapes inner
    quotes by doubling them, matching the [import](importing_data.md#format) format.

!!! warning "Values that look like formulas"

    In CSV and TSV, a value beginning with `=`, `+`, `-`, `@`, a tab or a carriage
    return is written with a leading `'`, so a spreadsheet program shows it as text
    instead of evaluating it. A negative number such as `-5` therefore appears as
    `'-5`. ODS and XLSX are not affected: their cells are typed as text.

### Large spreadsheets

A sheet of ODS or XLSX holds 1,048,576 rows: one header row and 1,048,575 data rows.
A longer export **continues on further sheets** (`Sheet2`, `Sheet3`…), each starting
with the header again, so nothing is truncated. Two limits cannot be split around,
and the file is refused with a message instead of being cut: more than **16,384
columns** (both formats), and, in XLSX only, a cell longer than **32,767 characters**
(Excel's own cell limit). CSV, TSV and NDJSON have neither limit.

### The media ZIP

The dialog shows one quality selector per media type found in the export (for
example one for images and one for PDFs): images offer their quality ladder,
audiovisuals their default quality or `original`, and PDF, 3D and SVG `web` or
`original`. The ZIP stores the files uncompressed (media is already compressed) and
uses ZIP64 when a size needs it, so an archive of many gigabytes is valid. A file goes into the archive only if you can read that media
component on that very record; everything else is left out. An `info.txt` inside
the ZIP lists what was archived and what was not, and why. Each quality choice is
built as its own ZIP.

### How long the files are kept

Export files are **temporary copies** of your records, kept on the server only so
you can download them:

- An export and all its files are deleted a set time after the export **finished**.
  Building or downloading a file from it does not extend that time: a file built shortly
  before the limit goes with the export. The default is 24 hours; your administrator
  sets it.
- Each user has a **storage quota** for export files (10 GiB by default). An export
  or a file that would go over it stops with a message that says so. The space comes
  back when you delete an export (**Delete export** in the tool removes the export on
  screen with all its files) or as your older exports expire. An export cannot be
  deleted while it runs (stop it first) or while a file is being built from it.
- An export that was running when the server restarted is marked **interrupted** and
  its partial files are removed. Run it again; there is no resume.
- Each export keeps a few built files per format (four); building a fifth with other
  options replaces the oldest of that format. The media ZIP is built again every time
  it is requested, so it always reflects the media files as they are now.

!!! info "Who can download"

    Only the user who ran an export can see it or download its files, and the server
    checks your access again on every download. If your access to the section or to
    one of the exported columns is removed after the export was built, its files can
    no longer be downloaded.

## Saving export configurations (presets)

Building a useful export (the right columns, in the right order, with the right
options) takes effort, so you can **save it as a preset** and reuse it later. Presets
are stored **per user** in the database.

In the **presets** block at the top of the configuration panel:

- **＋ (New)** — saves the current configuration (selected columns + format +
  breakdown + all options) as a new preset and opens a small editor to give it a
  **name** (one per preset), and optionally mark it **Public** (shared with all
  users) or **Default**. The editor's fields show no tool buttons.
- **Click a preset row** to apply it: it rebuilds the selected columns in order and
  restores the format and options. The applied preset is marked with a filled
  circle.
- **Save changes** — shown while a preset is applied; updates it with the current
  configuration.
- **Edit / Delete** — rename/flag or remove a preset. The two buttons appear at the
  end of a row when the pointer is over it (on a touch screen they are always
  visible). Delete asks for confirmation, naming the preset.

Presets are **scoped to the section** you are exporting (a preset created on one
section does not appear on another). Public presets are visible to every user; your
own presets are private unless you mark them public.

!!! note "Presets vs the auto-remembered state"

    Independently of presets, the tool remembers your **last** column selection (per
    section) and your last format/breakdown choice in the browser, so reopening the
    tool restores where you left off. Presets are the named, shareable, cross-device
    version stored in the database.

## Raw export and the import tool

The **Dédalo (Raw)** format (`dedalo_raw`) exports each cell as the stored value,
wrapped with the `dedalo_data` property:

```json
{"dedalo_data":[{"value":"Hello","lang":"lg-eng","id":1}]}
```

A CSV produced with this format can be fed to the [CSV import tool](importing_data.md),
which detects and unwraps the `dedalo_data` wrapper. What it does **not** do is
reproduce the stored row verbatim, and the manual used to say it did:

- The import runs the same **human-input conform** over a wrapped cell as over a
  typed one. Measured over every component model: `component_text_area` rewrites
  `<br>` and newlines into paragraph markup, and `component_geolocation` writes the
  item without its stored `id` (so the save stamps a fresh one — the identity every
  remove, Time Machine restore and dataframe pairing addresses). The other models
  measured lossless.
- A **calculated** field — the backlinks of a `component_inverse`, the children of a
  `component_relation_children`, the pointing records of a `component_relation_index`
  — exports its calculated value wrapped the same way, for reading only: it has no
  stored data, so the import skips it.
- A component with **no stored data** exports as an empty cell and imports as an
  **explicit clear** — a full-section re-import re-saves every component of every
  record and stamps a Time Machine row for each.
- Relation cells carry **locators** — `{section_tipo, section_id}` — and
  `section_id` is a **per-installation counter value**. The import checks a
  locator's shape only, so in another installation each link resolves to whatever
  record holds that id there.
- Media cells carry `files_info` (a manifest of files) and **no bytes**; the media
  zip is a separate download with nothing tying the two together.

So use raw export for what it is: a machine-shaped CSV for the **same installation**,
edited or filtered outside Dédalo and brought back through the import tool. For a
backup, a move between installations or a preservation copy use
[The archive door](#the-archive-door).

See [The dedalo_data wrapper](importing_data.md#the-dedalo_data-wrapper) and
[Dataframe columns](importing_data.md#dataframe-columns) for the details of
the wire shape (including how [dataframe](components/component_dataframe.md) rows
travel in their own column).

!!! warning "Raw is not for reading"

    The raw format is meant for machines, not for analysis. Use
    **Standard** or **Breakdown** when a person or a spreadsheet will read the result.

## The archive door

The **archive** is the one complete, self-describing, verified extraction of a
section set, and its reconstruction. It is a command-line door on the server
(`bun scripts/archive.ts`), not a button in the export tool:

```
bun scripts/archive.ts extract --sections <tipo,tipo,…> --out <directory>
bun scripts/archive.ts verify  --archive <directory>
bun scripts/archive.ts restore --archive <directory> --user-id <n> [--allow-external] …
```

`extract` writes a **directory** (tar it for transport) holding, for every record
of every named section, **all eleven stored columns exactly as the database holds
them** — nothing conformed, no item renumbered, every locator and every
`files_info` as stored — plus the ontology subtree that gives them meaning, byte
copies of every media file the records own, and a `manifest.json` with the engine
version, the section list with record counts, a digest of the ontology, a digest
of every file, and a census of every locator that points **outside** the set
(with whether the source held its target). Time Machine history, soft-deleted
media versions, subtitles files and the per-installation counters are deliberately
not archived, and the manifest says so.

`restore` rebuilds the set in a database that need never have held it, and
**refuses before writing anything** on a digest mismatch, on an ontology node that
exists with a different definition, on a record that already exists, on a media
file that exists with different bytes, and — the cross-installation case — on a
locator that resolves neither to an archived record nor to a record the
destination holds. Each refusal has an explicit override flag; the dangling
locators written under `--allow-external` are reported, never silently re-pointed.
Every restored record receives one whole-record Time Machine row, so the restore
is visible in its history. Archive the sections that link to each other
**together** and no locator is external.

The format is defined in the repository file `engineering/ARCHIVE_FORMAT.md` and
verified by a reconstruction test that builds a section set with every component
model, extracts it, drops it, restores it from the artifact alone and asserts
byte equality on every column.

---

## For developers

> `tools/tool_export/server/tool_export.ts` (`toolExportGetExportGrid()`) is
> a pure facade over the unified diffusion export engine
> (`src/diffusion/export/`): record RESOLUTION rides the shared diffusion
> engine (`compileExportPlan` turns `ar_ddo_to_export` into a
> `PublicationPlan`; the diffusion resolver's atom entry point walks
> relation hops and stored locators), and the tool handler delegates to it
> in a single call. The same producer (`openExportGrid`,
> `src/diffusion/export/grid.ts`) also feeds the background job that the tool's
> UI runs (`build_export_artifact`), which writes the protocol into a spool on
> disk; the preview and every download are read from that spool. The client
> (`render_tool_export.js`, `flat_table.js` and friends) is vanilla JavaScript
> with an exact wire contract, recorded in
> `WC-2026-09-24-tool-export-server-built-artifacts`.
>
> The stream/buffered duality and the protocol shape (`meta` first, every
> row cell referencing an already-emitted column ordinal, `end` last, its
> columns array a permutation of the emitted ordinals) are pinned by
> `test/unit/diffusion_export_unified.test.ts`; correctness of the resolved
> values is pinned by the parity fixture replay
> (`test/parity/tool_export_differential.test.ts` and
> `test/parity/tool_export_breakdown_differential.test.ts`).

### The export pipeline

```text
ar_ddo_to_export (chosen columns, user order)
        │  POST dd_api:'dd_tools_api', action:'tool_request'
        ▼
src/core/tools/dispatch.ts   dispatchToolRequest() — permission-gated per-tool registry
        ▼
src/diffusion/export/grid.ts   openExportGrid() — THE producer
        │   resolves the SQO (search/sql_assembler.ts) then, per data_format,
        │   walks each export ddo's path to atoms and mints columns/rows —
        │   ONE walk for every format: a `value` cell is the join of the
        │   same atoms grid_value emits (export/join_atoms.ts)
        │
        ├─ get_export_grid ──────────▶ NDJSON stream or whole grid, to the caller (API / MCP)
        │
        └─ build_export_artifact ───▶ spool on disk (export_job.ts, artifact_store.ts)
             (background, lane 'export')     │
                                             ├─ get_export_preview ─▶ ONE page (preview.ts)
                                             └─ build_export_file ──▶ writers/ → export.<ext> | media*.zip
                                                  (background, 'export_file')  │
                                                                               ▼
                                            GET /dedalo/export/artifact/<jobId>/<basename>
                                            (download.ts — owner only, 404 otherwise)
```

The server forces the SQO to the full filtered selection (`sqo.limit = null`
→ ALL, `offset = 0`) after the read-permission gate, so the export always
covers the whole search result rather than the client's clamped page limit.
That selection is read in pages from ONE snapshot taken when the export opens
(a server-side cursor), never loaded whole, so a large export costs the server
the same memory as a small one; `meta.total` is the snapshot's exact count, and
a record saved while the export runs is not part of it. Computing that snapshot
runs under the same statement ceiling as any request (`DB_STATEMENT_TIMEOUT_MS`):
a selection that takes longer is refused with `db.statement_timeout` before the
first line. Each server process runs
at most a quarter of `DB_POOL_MAX` exports at once (at least one); beyond that
a `get_export_grid` request is refused with `export.busy` — try again shortly —
while a background export (`build_export_artifact`) waits for the next free
slot instead of failing (its Stop ends the wait). Both kinds share the same
slots — none is reserved for either — so while background exports occupy them
all, a direct export answers `export.busy` until one of them ends. A server with
`DB_POOL_MAX=1` cannot run exports. A streamed export whose reader stops
pulling lines for 15 minutes is closed with `export.consumer_idle`, which frees
its database connection; the time the server spends building the export never
counts, so a slow export that keeps being read is never cut.

`get_export_grid` without `ndjson_stream` returns the whole grid in one answer,
so it is refused with `export.format_limit` when the selection holds more than
`DEDALO_SEARCH_CLIENT_MAX_LIMIT` records; the NDJSON stream and the background
export serve the same selection.

### API

The tool's actions, all dispatched through `dd_tools_api::tool_request` and gated
`permission: 'section', minLevel: 1` on `section_tipo`:

| Action | Background | Purpose |
| --- | --- | --- |
| `get_export_grid` | no | The whole export inline (NDJSON or buffered). For API and MCP callers; unchanged. |
| `build_export_artifact` | yes, lane `export` | Run the export into a spool. Same options as `get_export_grid`. |
| `build_export_file` | yes, lane `export_file` | Build one file (`csv`, `tsv`, `html`, `xlsx`, `ods`, `ndjson`, `media_zip`) from an ended spool; answers its download URL. |
| `get_export_preview` | no | One page of a spool, counted in records, at most 200. |
| `list_export_jobs` | no | The caller's exports of the section, newest first. |
| `delete_export_job` | no | Delete one of the caller's exports with all its files, freeing its quota. |
| `components_with_parent` | no | Which relation columns can offer the parents checkbox (WC-049). |
| `components_with_references` | no | Which columns can offer the references checkbox: a related field with calculated relations (`dd467` / `dd621`) — the same rule the export refuses the option with elsewhere. |

`build_export_file`, `get_export_preview`, `list_export_jobs` and `delete_export_job` only ever open the
**caller's own** exports. The first three also ask the build's read gates again over the recorded
options on every call; `delete_export_job` does not, so an owner can always delete an export of their
own. Anything else is `export.artifact_not_found`. The request and answer shapes, the error codes and the
download route's 404 policy are in the
[developer reference](../development/tools/reference/tool_export.md).

`tool_export.get_export_grid(options)` — dispatched through
`dd_tools_api::tool_request` (the RQO wire shape is unchanged). The TS module
(`tools/tool_export/server/index.ts`) declares the action's own permission
spec inline (`{ permission: 'section', minLevel: 1, handler: ... }`), enforced
by the generic per-tool dispatcher `dispatchToolRequest()`
(`src/core/tools/dispatch.ts`) — one explicit, typed dispatch table, shared
by every tool, that resolves the tool name, checks it is active and
authorized for the calling user, loads its server module, looks up the
action in that module's allowlist, and enforces the action's declarative
permission gate before running it. Request fields:

| Field | Meaning |
| --- | --- |
| `section_tipo` | Target section (read-permission gated). |
| `model` | `'section'`. |
| `data_format` | `'value'` \| `'grid_value'` \| `'dedalo_raw'`. |
| `breakdown` | `'default'` \| `'rows'` \| `'columns'` (used with `grid_value`). |
| `fill_the_gaps` | bool — repeat spanning values on exploded rows. |
| `value_with_parents` | bool, **per entry of `ar_ddo_to_export`** — add that column's ancestor-chain sibling column (`value` and `grid_value`; ignored in `dedalo_raw`, which exports stored data only; a request-level value is ignored, WC-049). In `value`, the sibling column is `<column> \| parents` (key `<top>#parents`), placed right after the term column, whose cell mirrors the term cell: the same separators in the same places and one chain per term piece, so splitting both cells the same way pairs each term with its chain. An item without parents keeps an empty slot; an item with no term has no slot. |
| `value_with_references` | bool, **per entry of `ar_ddo_to_export`** — for a `component_relation_related` leaf whose directionality calculates relations (`dd467` bidirectional, `dd621` multidirectional), add a sibling column `<column> \| references` (key `<top>#references`, after the term and parents columns) with the CALCULATED relations only: the references minus the stored locators. `value` and `grid_value`; ignored in `dedalo_raw`. On any other leaf (a `dd620` related, a portal, …) the request is REFUSED with `request.invalid_options` in every format (`WC-2026-11-11-export-related-references-column`). |
| `ar_ddo_to_export` | the columns, **in output order**. |
| `sqo` | the search query object (the selection to export). |
| `ndjson_stream` | bool — stream the flat-table protocol vs return it whole (`get_export_grid` only; the background job always writes the protocol to its spool). |

### The flat-table NDJSON protocol

The server emits newline-delimited JSON; each line is discriminated by `t`:

| Line | Shape | Purpose |
| --- | --- | --- |
| `meta` | `{t:'meta', v, data_format, breakdown, fill_the_gaps, section_tipo, total}` | Stream header. |
| `col` | `{t:'col', i, key, group, path, label, ar_labels, cell_type, model, after}` | A column, emitted on first use. `i` is the stable ordinal cells reference; `label` is server-resolved; `after` hints live insertion. |
| `row` | `{t:'row', rec, sub, c:{ordinal:value, …}}` | A (sub)row; `c` is sparse (ordinal→value); `sub` is the explosion index. |
| `end` | `{t:'end', columns:[ordinal,…], rows, records}` | Authoritative display column order + counts. |

The **column order in the output equals the order of `ar_ddo_to_export`**, which in
the tool equals the order of the *Active elements* DOM list — i.e. the order the
user defined by dragging. `cell_type` (`text` \| `img` \| `av` \| `iri` \|
`section_id` \| `json`) drives how `flat_table.js` renders each cell.

### The component contract

Every component's export cell is resolved by ONE shared walk rather than a
per-model override method: `src/diffusion/export/atoms.ts` walks each export
ddo's `path` into **atoms** (one value + its segment path), following the
caller's `ddo_map` at every relation level. `grid_value` tabulates the atoms;
`value` (and the compact cell of an unexpanded portal) is the JOIN of the same
atoms (`src/diffusion/export/join_atoms.ts joinExportAtoms`): records by segment
`item_index`, fields by segment identity, separators by precedence caller ddo →
the component's own `request_config` `show` → its `properties` → defaults
(`' | '` records, `', '` fields). `component_input_text`, `component_date` and
`component_iri` join their own items with `records_separator ?? ' | '`; other
leaves with the fields separator. An empty value (`''` or `'0'`) is skipped, but
an empty related record keeps its slot. The fan-out stops only on a cycle (the
same record and component already on the path, noted `relation_cycle:<tipo>`),
never at a fixed depth (`WC-2026-11-11-export-value-single-walker`).

Per-model behavior is expressed declaratively: each component model's
descriptor carries a `flatValue` facet (every relation-column model declares one,
gated by `descriptor_completeness_tripwire`); a relation's children per target
come from ONE seam, `src/core/relations/config_children.ts` (explicit
`request_config`, else — for a config-less `component_relation_index` — per
pointing record its id plus its section's related_list columns, the columns the
edit form shows, else the edit form's implicit config —
`component_filter` → `dd156`); its locators from ONE source,
`src/core/relations/locator_source.ts` (the stored slice, or the computed set of
`component_relation_children` / `component_relation_index`). The interactive
readers (relation_list panel, references) use the same two seams. Coverage is
`value`, `grid_value` with all three breakdown modes, `dedalo_raw`, multi-hop
paths, NDJSON streaming, and media/image cells — pinned by
`test/unit/tool_export_value_relation_native.test.ts`,
`test/parity/tool_export_breakdown_differential.test.ts` and
`test/unit/tool_export_relation_dataframe_fanout_native.test.ts`. A genuinely new
component shape that the shared walk cannot express needs its own case added to
the walk rather than an override method.

- The flat-join (`value` format) reference is `joinExportAtoms()`.
- `dedalo_raw` cells are the exact stored value JSON-encoded with the
  `dedalo_data` wrapper: `{dedalo_data: <stored value>}`. The one exception is a
  `derived` model (`component_inverse`, `component_relation_children`,
  `component_relation_index`), which owns no stored value: its cell wraps the
  computed value, and the import skips derived models.
- `component_json` and `component_geolocation` are the `json` flatValue family:
  one atom per stored item, its JSON — `JSON.stringify` with every `/` written
  `\/` and every `&` written `\u0026`, so the text cleanup below never rewrites
  it and the cell always parses back to the stored item. A geolocation entry is
  encoded as a list row serves it — the view and `lib_data`, without the map
  `sources` / `legend`, which only `dedalo_raw` carries
  (`WC-2026-11-12-export-json-geolocation-cells`).
- Every `value` and `grid_value` cell is cleaned to plain text after the join
  (`src/diffusion/export/clean_text.ts cleanTextValue`): `</p><p>` becomes a line
  break, the outer `<p>`…`</p>` is stripped, and 11 HTML entities (`&amp;`,
  `&lt;`, `&gt;`, `&quot;`, `&apos;`, `&nbsp;` and their numeric forms `&#38;`,
  `&#60;`, `&#62;`, `&#39;`, `&#34;`) are decoded in one pass. `dedalo_raw` cells
  are never cleaned (`WC-2026-11-12-export-text-cell-clean`).
- `component_inverse` is the `inverse` flatValue family: one atom per caller,
  value the caller `section_id`, path = the host segment plus a caller-pair
  sub-segment `{section_tipo: from_section_tipo, component_tipo:
  from_component_tipo, model: null, item_index, section_id: null}`. In the
  grid_value walk `item_index` is the caller's position among that pair's callers
  (section_id ascending), so each pair keys its own column and the breakdown
  spreads callers like any relation's items; the value fold leaves it `null`, so
  the one `value` cell joins every caller with `', '`. Callers
  are filtered by the requester's read access (section grant + projects), as in
  the edit view (`WC-2026-11-11-export-inverse-callers`).
  A component with dataframe slots grows one EXTRA column per slot, headed by
  the dataframe component's tipo and carrying that component's own stored
  frames — see
  [The dedalo_data wrapper](importing_data.md#the-dedalo_data-wrapper) and
  [Dataframe columns](importing_data.md#dataframe-columns) for the shared shape
  with the import side.

### Files

- `tools/tool_export/server/tool_export.ts` — the `get_export_grid` facade and the shared SQO section gate (`assertExportSqoSections`).
- `src/diffusion/export/{compile_columns,atoms,join_atoms,clean_text,grid,index}.ts` — the unified build: column-set plan compile, shared-walk atoms, the value join, the text-cell cleanup, the producer `openExportGrid` and the NDJSON emission (`exportGridUnified`).
- `src/core/relations/{config_children,locator_source}.ts` — a relation's children per target and its locators, shared by the export walk and the interactive readers.
- `tools/tool_export/server/index.ts` — the tool's `ToolServerModule` registration (actions, background lanes, admission).
- `tools/tool_export/server/export_job.ts` — `build_export_artifact`, `build_export_file`, `list_export_jobs`, per-user admission, the owned-job door.
- `tools/tool_export/server/{preview,spool_reader}.ts` — the paged preview over the spool.
- `tools/tool_export/server/artifact_store.ts` — the on-disk store: layout, confinement, quota, TTL sweep.
- `tools/tool_export/server/{access,download}.ts` — the read re-check and the owner-only download route.
- `tools/tool_export/server/writers/` — one streaming writer per format, plus the text semantics (`cells.ts`) and the spreadsheet plumbing (`spreadsheet.ts`).
- `src/core/resolve/relation_list.ts` — the interactive flat reader (`resolveCellValue`) of the relation_list panel and the references panel; the export walk reuses its leaf-level readers (`resolveCellItems`, `resolveCellValue` for a single literal or media leaf) but never its relation recursion.
- `tools/tool_export/js/flat_table.js` — draws one preview page (no accumulator, no file building).
- `tools/tool_export/js/{tool_export,render_tool_export,drag_tool_export}.js` — the wire, the UI and export runtime (job follow, pager, downloads, reconnect), the drag-and-drop column model.
- `tools/tool_export/js/export_user_presets.js`, `client/dedalo/core/section/js/view_export_user_presets.js` — per-user presets (section `dd1781`; ordinary ontology data, no dedicated TS engine needed).
