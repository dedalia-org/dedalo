# tool_export

Atoms-based export of a section's records to a flat table. The export runs on the server as a background job that writes the export_tabulator NDJSON protocol into a spool. The browser previews it one page at a time, and every download (CSV / TSV / ODS / XLSX / HTML / NDJSON / media ZIP) is a file the server builds from the whole spool.

## What it does / why & when to use it

`tool_export` turns the **whole current selection** of a section into a spreadsheet-style flat table — the user picks which components become columns, in what order, and how relations and hierarchies are flattened. Because Dédalo stores highly structured data (multi-language values, relations to lists and thesauri, hierarchies, dataframes), exporting is never a plain dump: the tool lets a person shape the output for the job at hand.

Concrete heritage scenario: a numismatics cataloguer has filtered the *Coins* section down to the issues of one mint and wants a report for a colleague. They open the tool on that filtered list, drag the *Inventory number*, *Weight*, *Diameter* and the related *Mint → name* into the active columns, choose **Breakdown / rows** so each linked type lands on its own row, tick **parents** on the type column to also get the term's ancestor chain, run the export, page through the preview and download an XLSX of every record. The same configuration can be saved as a named preset for the next batch.

A second, machine-facing use: the **Dédalo (Raw)** format produces cells wrapped as `{"dedalo_data":…}` that the [CSV import tool](tool_import_dedalo_csv.md) unwraps and conforms like typed input — an edit-and-reload format, NOT a backup and not a way to move data between installations: `component_text_area` markup is rewritten, `component_geolocation` item ids are dropped, empty cells clear values, no media bytes travel, and a locator's `section_id` is checked for shape only. The complete, verified copy of a section set is the [archive door](../../../core/exporting_data.md#the-archive-door).

Use it when: someone needs section data as a spreadsheet/report, a raw CSV to bulk-edit and load back, or the media files referenced by a record set. Do not use it for single-record edits or for tabular *editing* — it is read-only export.

## How it works (server + client)

The export pipeline resolves each cell through the **list-mode leaf-value contract**. The one producer is `openExportGrid` (`src/diffusion/export/grid.ts`), whose column resolution (`src/diffusion/export/atoms.ts`) calls `resolveCellValue` (`src/core/resolve/relation_list.ts`), the same accessor the relation-list panel uses, rather than a dedicated per-component export method. It covers the `value`/`grid_value`/`dedalo_raw` data formats, all three breakdown modes, multi-hop export paths and media cells; the coverage is byte-parity gated. Two doors consume that producer:

- **`get_export_grid`** streams it straight back to the caller (NDJSON, or a whole grid). This is the API/MCP door. The bundled client no longer calls it.
- **`build_export_artifact`** writes it into a **spool** on the server. This is the door the tool's UI uses. The spool is byte-identical to the `get_export_grid` stream for the same options (gate: `tool_export_job_native`).

**Server** (`tools/tool_export/server/`):

- Every action is declaratively gated `permission: 'section', minLevel: 1` on `section_tipo`. The export walk additionally asserts level ≥ 1 on every `sqo.section_tipo` entry (`assertExportSqoSections`, `tool_export.ts`) and runs the engine's declaration gate (`assertExportDeclarationReadable`: Gate A, Gate B and the `dedalo_raw` frames). Records come from the standard search assembler with the caller's principal, so non-admins get the same project-scoped ACL as every other search-backed read.
- Options are normalized against fixed allowlists (`data_format` → `value|grid_value|dedalo_raw`, falling back to `value`; `breakdown` → `default|rows|columns`). The SQO is **forced to the whole filtered selection** (`limit` ALL, `offset: 0`): subsetting is done with the SQO filter, never a page limit. The selection is never loaded whole: it is materialized once, in one snapshot, as a server-side cursor and read in pages of 10,000 ids (`src/diffusion/export/selection_cursor.ts`); `meta.total` is that snapshot's exact count. The snapshot is computed when the cursor's transaction commits — where PostgreSQL disarms `statement_timeout` — so the cursor's transaction carries a transaction-local `transaction_timeout` equal to the connection's own `statement_timeout` (`DB_STATEMENT_TIMEOUT_MS` on the request pool): a selection past it is refused with `db.statement_timeout` (503). A Stop of a `build_export_artifact` job, its lane deadline or a server shutdown while the selection is still being computed cancels that computation in the database: the export ends as `export.cancelled` and its connection is released at once. A `get_export_grid` request carries no stop signal, so a client that disconnects mid-selection is bounded only by `DB_STATEMENT_TIMEOUT_MS`. Each process holds at most `max(1, floor(DB_POOL_MAX / 4))` such cursors at once; beyond that a `get_export_grid` request is refused at once with `export.busy` (503, retryable), while a `build_export_artifact` job — already admitted by its lane — waits FIFO for the next slot (a freed slot is handed to the first waiter; the job's signal ends the wait as `export.cancelled`), so the effective background concurrency is `min(DEDALO_JOB_LANE_EXPORT_CONCURRENCY, slots)`. No slot is reserved for either path (owner decision, 2026-10-21): background jobs holding every slot make `get_export_grid` answer `export.busy` until one ends. A server with `DB_POOL_MAX=1` refuses every export (the cursor would hold the connection its own hydration needs). See `WC-2026-10-11-export-buffered-cap-and-admission`.
- **The artifact store** (`artifact_store.ts`) keeps one directory per export under `<DEDALO_EXPORT_ARTIFACTS_DIR>/<userId>/<jobId>/`:
    - `request.json`: the recorded options and read set, written ONCE when the job is created;
    - `manifest.json`: owner, status, counts, built files — the small mutable state a checkpoint rewrites (never the options);
    - `grid.ndjson`: every protocol line;
    - `cols.ndjson`: the `col` lines only;
    - `grid.idx`: fixed-width byte offsets of every 100th record, so a page seek never scans the grid;
    - `media.ndjson`: the media addresses the walk read, one line per record that read any (`{rec, a: [[column, section_tipo, section_id, component_tipo], …]}`; `column` is `null` when the media was read for a cell that shows nothing, such as a record that holds only the original file). It is created only when the first address arrives, is never served, and is the media ZIP's input for media reached through relations (see the `media_zip` row below);
    - the built files: `export[_<variant>].<ext>`, `media[_<variant>].zip` — at most `MAX_FILES_PER_FORMAT` (4) per format; a newer one evicts the oldest.

    Files are written to a temp path and renamed, so a partial file is never visible; `export.ndjson` is the ended `grid.ndjson` itself, hard-linked into place (no second copy, counted once by the quota). The media ZIP is rebuilt on every request (it reads the live media state); every other format is built once per option set. The store also enforces the per-user quota while writing, and sweeps expired jobs at boot and hourly. The root's marker names the install that claimed it; another install's root is refused by every door.
- **The job** (`export_job.ts`) runs the walk with media capture on (`captureMedia`, `src/diffusion/export/row_media.ts`): each record's first row line carries the (section, id, component) of every media component its cells read, at any path depth and in every data format, under a symbol key. No serialization carries a symbol key, so the stream, the spool's `grid.ndjson` and the NDJSON download are unchanged; the spool writer copies the addresses to `media.ndjson`, and the manifest records the distinct media models read (`media_models`). The job also captures the principal (re-resolved when the handler starts — a queued job may have waited hours; `currentExportPrincipal`), the options and the interface language, and hands them to `openExportGrid` explicitly. A Stop is honoured at the next record boundary. At every checkpoint (500 records or 250 ms) it flushes the spool up to the last complete record, rewrites the manifest (which also serves as the heartbeat) and publishes a progress frame.
- **The preview** (`preview.ts`, `spool_reader.ts`) reads one page, counted in records, from the spool, even while the job is still writing. A page is bounded in records, rows, columns (one window, applied while reading) and bytes (each cell cut to `PREVIEW_CELL_MAX_CHARS` with `…`, sub-rows past `PREVIEW_PAGE_CHAR_BUDGET` elided); the downloads carry every full value.
- **The writers** (`writers/`) each turn an ended spool into one file in a single streaming pass, with memory bounded by one row. Header and cell text come from `writers/cells.ts`, a port of the preview's own rendering, gated against the client file itself (`tool_export_cells_native` runs `flat_table.js`' `get_column_label`, `cell_to_text` and `_build_cell`); the CSV/TSV grammar the browser used to write is frozen as the byte oracle in `tool_export_delimited_html_writers_native`.
- **The download route** `GET /dedalo/export/artifact/<jobId>/<basename>` (`download.ts`) serves a built file to its owner only.

**Client** (`tools/tool_export/js/`):

- `tool_export.js` is the instance and the wire (`start_export_job`, `get_export_preview`, `list_export_jobs`, `delete_export_job`, `start_export_file`, `stop_export_process`). Reads are sent with `retries: 2`; background submissions and the delete with `retries: 0`.
- `render_tool_export.js` builds the three-pane UI and runs the export. Export submits the job and follows it through `job_follow.js`. The preview is one page with a pager and a page-size select (25/50/100/200). Download buttons are enabled once the export ends. Opening the tool reconnects to the caller's latest export of the section.
- `flat_table.js` only draws one page; it holds no accumulator and builds no files.
- `drag_tool_export.js` is the drag-and-drop column model. `phone_tool_export.js` is its touch twin (a finger cannot drag): a tap-to-add `+` on each available field and up/down buttons on each selected column, both routed through the same drop model (`render_phone_reorder`, `tools_common/js/phone_reorder.js`).
- `export_user_presets.js` manages the per-user presets (section **dd1781**).

The DOM never holds more than one page (at most 200 records), whatever the size of the export. The tool opens in its own window (`properties.open_as = "window"`).

## Actions & options

| Action | Gate | Background | What it does |
| --- | --- | --- | --- |
| `get_export_grid` | section read on `section_tipo` + `assertExportSqoSections` | no | The synchronous export: NDJSON stream (`ndjson_stream: true`) or the whole grid. Unchanged by the server-built export. |
| `components_with_parent` | section read on `section_tipo` | no | `components: [{tipo, section_tipo}]` → `{ [tipo]: boolean }`: whether each relation component points at a section with a `component_relation_parent`. Powers the per-column parents checkbox (WC-049). Ontology-only. |
| `components_with_references` | section read on `section_tipo` | no | `components: [{tipo, section_tipo}]` → `{ [tipo]: boolean }`: whether each component derives calculated relations (a `component_relation_related` with `dd467` / `dd621`). Powers the per-column references checkbox; the same predicate `compileExportPlan` refuses a forged `value_with_references` with (`WC-2026-11-11-export-related-references-column`). Ontology-only. |
| `build_export_artifact` | section read + `assertExportSqoSections` + the declaration gate; admitted per user | yes, lane `export` | Runs the export into a new spool. Same options as `get_export_grid` minus `ndjson_stream`. With `rerun_of` (an artifact id) it runs the RECORDED options of that export instead, opened through the owner's read door (`resolveOwnedJob`; else `export.artifact_not_found`) and then gated like any new build: the tool's *Run the export again* button sends only `{section_tipo, rerun_of}`. Only the keys the export reads are recorded in the manifest (`section_tipo`, `sqo`, `ar_ddo_to_export`, `data_format`, `breakdown`, `lang`, `fill_the_gaps`); others are dropped. Recorded options over 1 MiB (serialized) are refused with `request.invalid_options`, and the manifest's own bytes count toward the user's quota. |
| `build_export_file` | section read + owner-only (below); admitted per user | yes, lane `export_file` | Builds one file from an **ended** spool: `{job_id, format, origin, show_tipo_in_label, media_quality?, media_qualities?}`. A file already built with the same options is answered as built, not rebuilt. |
| `get_export_preview` | section read + owner-only | no | One page: `{job_id, page, page_size?}`. |
| `list_export_jobs` | section read + owner-only | no | The caller's exports of `section_tipo`, newest first (how a reopened tool reconnects). |
| `delete_export_job` | section read + owner-only | no | `{job_id}`: deletes the export with all its files (spool and every built download) and frees its bytes of the quota. It asks only for ownership and the section, not the read gates: an export its owner may no longer read is still theirs to delete. Refused with `export.artifact_busy` (409) while the export runs or a file build holds a lease on it; it never stops a job itself. |

`build_export_artifact` and `build_export_file` refuse a foreground call (`request.invalid_options`). Both declare an `admit` hook (`admitExportJob`), which the framework runs synchronously when it registers the job. A user with `DEDALO_EXPORT_JOBS_PER_USER` (default 2) of these jobs already queued or running is refused with `export.too_many_jobs` (429) and nothing is queued. `build_export_file` uses `admitExportFileJob`, which also limits one user to every slot of the shared `export_file` lane but one (one file at a time with the default budget of 2), so one user's long media ZIPs never fill the lane. Before they write, both actions delete the caller's finished exports that the build's gates no longer let them read (revoked access, changed projects, expired), so those do not hold quota.

**Owner-only** means every read of an existing export goes through `resolveOwnedJob`:

- the job is looked up only under the caller's own user directory, so another user's job, a global admin's included, is simply not there;
- the manifest must name the caller and the requested `section_tipo`;
- the build's own read gates are asked **again**, now, over the recorded options (`access.ts exportStillReadable`);
- every runtime frontier grant the walk read under must still be held: a stored locator can land in a section the declared path never names, so the manifest records each (section, component) pair the walk's frontier allowed (`frontier_grants`) and each is asked again;
- the caller's record scope (the global-admin flag; for anyone else the dd170 projects and the dd478 record allow-list, fingerprinted by `exportRecordScope`) must equal the `record_scope` the manifest recorded when the walk ran;
- the export must be within its lifetime, end + TTL (`exportExpired`).

Every refusal is `export.artifact_not_found` (404). The same answer covers absent, expired, not yours and access revoked, so no answer reveals whether a job exists.

Key options read by `get_export_grid` and `build_export_artifact`:

| Option | Type | Meaning |
| --- | --- | --- |
| `section_tipo` | string (req.) | Target section to export. `get_export_grid` falls back to `tipo` for legacy callers. Read-gated. |
| `model` | string | Element model; defaults to `'section'`. |
| `data_format` | string | `value` (default, one flat cell per column) \| `grid_value` (breakdown) \| `dedalo_raw` (the wrapped edit-and-reload form). Unknown values fall back to `value`. |
| `breakdown` | string | Relation explosion for `grid_value`: `default` \| `rows` \| `columns`. Defaults to `default`. |
| `fill_the_gaps` | bool | Repeat spanning (record-level) values on each exploded row. Default `true`. |
| `value_with_parents` (per ddo) | bool | PER-DDO ONLY (WC-049): set `value_with_parents: true` on an `ar_ddo_to_export` entry to emit that column's locator-target ancestor chains (`getParentsRecursive` × term resolver, `' > '` nearest-first, self excluded) as a sibling `#parents` column. `grid_value`: one atom per locator (targets without hierarchy emit nothing). `value` (WC-049 addendum 2026-09-25): ONE sibling column `<top>#parents` (label `<column> \| parents`) right after the term column whenever the flag is set on a relation leaf; its cell mirrors the term cell's join (same separators at the same levels, multi-hop paths included) with one chain per term piece: a target whose text splits into n pieces on the leaf's item separator carries its chain n times, a target with an empty term has no slot, a target without hierarchy leaves an empty slot (the cell is empty only when every slot is). `dedalo_raw`: ignored (stored data only; the client disables the checkbox). A request-global `options.value_with_parents` is ignored. |
| `value_with_references` (per ddo) | bool | PER-DDO ONLY (`WC-2026-11-11-export-related-references-column`): on a `component_relation_related` leaf whose directionality calculates relations (`dd467` / `dd621`), emit its CALCULATED relations (the references minus the stored locators, by locator identity) as a sibling column `<top>#references` (label `<column> \| references`), placed after the term and `#parents` columns. The main cell stays the stored locators only. Same fan-out as the main cell (config children, separators, export frontier on every target). `value` and `grid_value`; `dedalo_raw` ignores it (the client disables the checkbox there). Eligibility is ONE predicate (`locator_source.ts componentHasCalculatedLocators`): the client shows the checkbox only where `components_with_references` answers true, and `compileExportPlan` REFUSES the flag on any other leaf (a `dd620` related, a portal, …) with `request.invalid_options`, in every format. |
| `ar_ddo_to_export` | array (req.) | The chosen columns, **in output order** (= the order of the *Active elements* list / the user's drag order). Stored internally as `ar_ddo_map`. |
| `sqo` | object (req.) | Search query object = the selection to export. Server forces `limit='ALL'`, `offset=0`. |
| `ndjson_stream` | bool | `get_export_grid` only: `true` streams the NDJSON flat-table protocol; `false`/absent returns the whole grid — refused with `export.format_limit` `{format:'json_envelope', limit}` before any record is read when the selection holds more than `DEDALO_SEARCH_CLIENT_MAX_LIMIT` records (stream it, or build an artifact). |

### Answers and frames

- **Background submit** (both background actions): `{ok: true, data: true, job_id, background_job_id, pid, pfile}`. `job_id` is the **lane** job, which you follow with `dd_utils_api::get_job_events` and stop with `dd_utils_api::stop_process {pfile}`.
- **`build_export_artifact` progress frame** `data`: `{msg, job_id, written, total, is_running}`, where `job_id` is the **artifact** id (`exp_…`). The terminal frame's `data` is the handler envelope, `{ok, data: {job_id, status: 'ended', total, records, rows, spool_bytes, columns, unresolved, narrowed, external_degraded}}`. `narrowed` is true when the user's own access narrowed the walk (for example an SQO filter step through a component they cannot read): the files hold fewer records than asked for. It is a flag only; the refused coordinates stay in the operator log. A job that fails carries `error`, an envelope v2 error body, on its terminal frame. A stopped export ends with `export.cancelled` and its partial spool is deleted.
- **`external_degraded`** (terminal frame, every `list_export_jobs` job, `get_export_preview`; `null` when nothing degraded): the export's external-source summary, `{incomplete, retryable, cells, records, missing_cells, missing_records, counts: [{service, state, cells}], sample: [{section_tipo, section_id, component_tipo, remote_section_tipo, remote_id, service, state}], sample_limit}`. `missing_cells` / `missing_records` count only the cells whose value is not in the files at all (every incomplete state except `truncated`); the status line counts those as "could not be read", names `truncated` cells as cut by the size limits (no advice), and `stale` ones as possibly out of date. A `component_external` cell whose source could not answer (`unavailable`, `timeout`, `circuit_open`), is `disabled` or `misconfigured`, or whose values were cut (`truncated`) makes the export `incomplete`; `stale` (served from the last saved copy) is counted but is not incomplete; `not_found` is an answer and is not counted, unless the whole record endpoint answers 4xx for every id: then the cells read `unavailable` and are counted (engineering/EXTERNAL_SPEC.md §5). `retryable` says a re-run can plausibly complete it. The manifest records it at every checkpoint, so a running export already reports it. The protocol's `end` line carries the same object, only when non-null, so the NDJSON download and the `get_export_grid` stream carry it too; a clean export's bytes are unchanged. The tabular files carry no in-band marker (a note row would be read as a record by a spreadsheet or a re-import); the tool says it on the status line and under the download buttons. Source: `src/diffusion/export/external_prefetch.ts`.
- **External rows are fetched per batch.** Before each hydrate batch the walk collects the batch's external targets (a leaf `component_external`, at the record or through relation hops, and the `component_external` children of a relation leaf) and fetches them in one bounded fan-out (`DEDALO_EXTERNAL_MAX_CONCURRENCY`), one request per distinct remote record; deeper fan-out takes the per-cell fetch.
- **`build_export_file` terminal** `data`: `{ok, data: {job_id, format, basename, url, bytes, rows}}`. `url` is the download route; for `media_zip`, `rows` is the number of files archived.
- **`get_export_preview`**: `{job_id, status, cols, col_page, col_page_size, first_col, total_cols, col_models, media_models, media_rerun_required, final_order, rows, elided, page, page_size, first_record, records, has_more, total_records, written_records, external_degraded}`. The request may add `col_page` (0-based). `cols` is ONE window of at most 100 columns (`PREVIEW_COLUMN_BUDGET`) starting at display index `first_col` of `total_cols`, and each row carries only that window's cells, so a very wide export (`breakdown: 'columns'`) still draws a bounded page. `col_models` lists the models of every column. `media_models` lists the media models the media ZIP can archive: every column's own media model, plus the models the walk read through relations (the manifest's `media_models`). The tool offers the media download, and lists one quality selector per model, from `media_models` — a portal column's own model is `component_portal` even when its targets hold images. `media_rerun_required` is true only for an export made before related media were recorded that has a column which may hold some; the tool then offers the media download anyway, and its `info.txt` lists those columns as `rerun_required`. `page` is 0-based and counted in records. `page_size` is clamped to 1..200 (default `DEDALO_EXPORT_PREVIEW_PAGE_SIZE`). A page also holds at most 1000 rows (`PREVIEW_ROW_BUDGET`): every record keeps its first row, sub-rows fill the rest in record order, and the sub-rows left out are counted per record in `elided: [{rec, rows, after}]`, where `after` is the index in `rows` of the record's last served row (the marker is placed there by position, because `rec` is the bare section_id and repeats when the export covers several sections; the downloads carry every row). `final_order` is false while the job runs, when columns are in the order discovered so far.
- **`delete_export_job`**: `{job_id, deleted: true, freed_bytes}`. The download URLs of the deleted export answer 404 from then on.
- **`list_export_jobs`**: `{jobs: [{job_id, status, section_tipo, created_at, updated_at, ended_at, total, records, rows, data_format, breakdown, files: [{format, basename, bytes, rows, created_at, url}], background_job_id, narrowed, external_degraded, error}], pending: [{background_job_id, submitted_at}]}`. `pending` lists the caller's submitted exports of the section that have no manifest yet, because they are still queued in the lane. A reopened tool follows the newest one as the current export and arms Stop from its lane job. The tool shows `narrowed` on the status line with the `error_perm_out_of_scope` label. `status` ∈ `running | ended | failed | cancelled | interrupted`. `error` is `null` or `{code, label_key, message, retryable, details?}`, rebuilt from the error registry when the list is served.

The whole wire, including the route's refusal policy and the error codes, is recorded in `WC-2026-09-24-tool-export-server-built-artifacts`.

### The files

| `format` | File | Notes |
| --- | --- | --- |
| `csv` | `export_<hash>.csv` | BOM + `;`-separated, every field double-quoted. The spreadsheet-formula rule (`neutralizeSpreadsheetFormula`, shared with diffusion) prefixes `'` to a value starting with `= + - @`, TAB or CR. |
| `tsv` | `export_<hash>.tsv` | TAB-separated, unquoted, `[\t\n\r]` runs collapsed to a space; same formula rule. |
| `html` | `export_<hash>.html` | One standalone document, escaped with the shared server escaper, carrying its own CSP meta. A `javascript:`/`data:` IRI stays text. |
| `xlsx` / `ods` | `export_<hash>.xlsx` / `export_<hash>.ods` | Streamed through the engine's ZIP writer. Every cell is a text cell. 1,048,575 data rows per sheet, then `Sheet2`… with the header repeated. More than 16,384 columns, or an XLSX cell over 32,767 characters, is refused with `export.format_limit` before the file is committed. |
| `ndjson` | `export.ndjson` | The spool itself, byte-identical to the `get_export_grid` stream. |
| `media_zip` | `media.zip` / `media_<variant>.zip` | Store-only ZIP64 of the media the export read, at the quality chosen per model. Two inputs: a **direct** media column (top level, its own model a media model) is read from its cells as before; every other media the walk read — a portal's image child in a value cell, a portal → image path in grid_value, a dedalo_raw portal's targets, at any depth, and the media of a cell that shows nothing — comes from `media.ndjson`, by record address, never by parsing URL text (a URL typed into a text field is never followed). Each address is checked as the **job owner** (read grant on that component of that record, and the record in the owner's projects), then every item the record holds now for that component is archived at the chosen quality. A file is archived only when the record's own `files_info` names it and the named file sits in the quality folder the media path grammar derives for that record (a stored path elsewhere under the media root, a web-server-denied name, or another record's file is refused as `invalid_path`). Refusals are listed in `info.txt` (a sidecar address as `section_tipo/section_id/component_tipo`). An export built before media capture (no `media_models` in its manifest) reads only its media-model columns and lists every column that may hold related media as `rerun_required`. `<variant>` hashes the quality choice, so two choices never share a file. |

`<hash>` is derived from the options that change the file's bytes (`show_tipo_in_label` and the browser origin), so two option sets never share a file and the same options rebuild the same one. The browser saves every one of them as `dedalo_export_<section>_<date>.<ext>`.

### Download route

`GET /dedalo/export/artifact/<jobId>/<basename>` (`serveExportArtifact`). The path is parsed raw, never percent-decoded, and both segments must match their grammar. The route requires:

- a session that maintenance mode does not refuse (while it is on, every session but root's is refused, exactly as the API refuses them);
- `tool_export` active and authorized for the user (the same tool gate every export action has);
- a manifest in the caller's own directory that names the caller and the job;
- status `ended`;
- a basename the builder recorded in `manifest.files`;
- `exportStillReadable` passing now;
- the store's confinement check (a regular file, no symlink).

**Every refusal is the same 404 `resource.not_found`, never a 403.** A served file gets `Content-Disposition: attachment`, `Content-Security-Policy: default-src 'none'; sandbox`, `Content-Length` and `Cache-Control: no-store`. The reverse proxy must stream this location unbuffered (the shipped nginx configs set `proxy_buffering off` on it).

### Retention and quota

A job directory is deleted `DEDALO_EXPORT_ARTIFACTS_TTL_HOURS` (default 24) after the job's end. This is a hard ceiling: a file built from the export later does not extend it, and past it every door already answers not-found. It is never deleted while a file build holds a lease on it. A running export whose server process is gone is marked `interrupted` and its partial spool removed; there is no resume.

The bytes one user holds are capped by `DEDALO_EXPORT_ARTIFACTS_QUOTA_BYTES` (default 10 GiB, `0` = off). The cap is checked when a job is created and enforced while bytes are written, so an overflowing export stops with `export.artifact_quota` instead of filling the disk. Two more bounds sit beside it: `DEDALO_EXPORT_ARTIFACTS_MAX_EXPORTS` (default 100, `0` = off) caps how many exports one user keeps (`export.artifact_count`), and `DEDALO_EXPORT_ARTIFACTS_MIN_FREE_BYTES` (default 1 GiB, `0` = off) keeps that much free on the export volume for everyone (`export.storage_low`, checked at every writing door and while bytes are written).

The owner can free that space before the TTL with `delete_export_job` (the tool's **Delete export** button). The store decides under the same manifest lock and the same liveness rules as the sweep (`deleteIdleJob`): a running export of a live server process, or one a live file build holds a lease on, answers `export.artifact_busy`; an export left `running` by a dead process is deletable. RUNNING-JOB POLICY: the delete refuses rather than stops. Stopping is its own door (`stop_process` on the lane job), and deleting under a live writer would race its quota measure and its final manifest write. Operations detail: the repository file `engineering/PRODUCTION.md`.

## How it is registered & surfaced

`tools/tool_export/register.json` is a **column-keyed dump** (`string`/`relation`/`misc`/… keyed by component tipo — a seeded matrix-row snapshot, not a hand-authored file); `importTools()` passes it through as-is (see [register.json reference](../register_json.md)). The essentials it carries:

- `dd1326` name = `tool_export`; `dd1327` version (`2.0.3`); `dd1328` minimum Dédalo version (`6.0.0`); `dd1644` developer.
- `dd1330` affected_models = `["section"]` → the tool attaches to **sections**.
- `dd1331` show_in_inspector = `false` and `dd1332` show_in_component = `false` (it is a section-toolbar tool, not an inspector/inline-component button).
- `dd1335` properties = `{ "open_as": "window", "windowFeatures": null }` → opens in its own window.
- `dd1372` labels supply the localized UI strings for the `fill_the_gaps`, `show_tipo_in_label` and `value_with_parents` options across project languages, plus `parents_not_in_raw` / `parents_not_in_raw_short` (the tooltip and the *(not in Raw)* note of a parents checkbox disabled in the `dedalo_raw` format), and `value_with_references` / `references_not_in_raw` (the references checkbox and its note in `dedalo_raw`).

Surfacing (in `getElementTools`, `src/core/tools/registry.ts`): because `affected_models` is `["section"]`, the **Export** button appears on sections in **list** mode — EXCEPT the consultation-only sections: `getSectionTools` returns `[]` for Activity (dd542) and Time Machine (dd15), so neither carries any section toolbar (this supersedes the earlier note that no dd15 rule existed; `NO_TOOLS_MODELS` remains only about the `component_section_id`/`component_info` component models). Every other section shows whatever tools its `affected_models`/`affected_tipos` normally match. `WC-2026-10-06-consultation-only-no-section-tools`.

## Examples

The tool's own client starts a background export (`tool_export.js::start_export_job`), then reads it page by page:

```js
// 1. submit the export job (answer: ok + extension keys job_id / pfile of the LANE job)
const submitted = await data_manager.request({ body: {
    dd_api       : 'dd_tools_api',
    action       : 'tool_request',
    prevent_lock : true,
    source       : create_source(self, 'build_export_artifact'),
    options      : {
        section_tipo       : 'rsc167',
        model              : 'section',
        data_format        : 'grid_value',
        breakdown          : 'rows',
        fill_the_gaps      : true,
        ar_ddo_to_export   : [ /* chosen columns, in output order */ ],
        sqo                : clone(self.sqo),
        background_running : true
    }
}})

// 2. progress frames name the ARTIFACT id (frame.data.job_id, 'exp_…');
//    read page 3 (0-based, 100 records per page)
const page = await data_manager.request({ body: {
    dd_api : 'dd_tools_api', action : 'tool_request', prevent_lock : true,
    source : create_source(self, 'get_export_preview'),
    options: { section_tipo : 'rsc167', job_id : artifact_id, page : 2, page_size : 100 }
}})

// 3. once ended: build a file (background); its terminal frame carries
//    {job_id, format, basename, url, bytes, rows} — url is the download route
//    /dedalo/export/artifact/<artifact_id>/export_<hash>.xlsx
```

An API or MCP caller that wants the export inline uses `get_export_grid` (unchanged):

```js
const rqo = {
    dd_api : 'dd_tools_api',
    action : 'tool_request',
    source : create_source(self, 'get_export_grid'),
    prevent_lock : true,
    options : {
        section_tipo       : 'rsc167',      // the section being exported
        model              : 'section',
        data_format        : 'grid_value',  // breakdown
        breakdown          : 'rows',        // one row per related item
        fill_the_gaps      : true,
        // parents chains are PER-COLUMN: value_with_parents rides each
        // ar_ddo_to_export entry (WC-049), not the request options
        ar_ddo_to_export   : [ /* chosen columns, in output order */ ],
        sqo                : self.sqo,       // the current filtered selection
        ndjson_stream      : true           // stream the NDJSON protocol
    }
}
const stream = await data_manager.request_fetch_stream({ body: rqo })
```

The server emits NDJSON, one JSON object per line, discriminated by `t`. The spool of `build_export_artifact` holds exactly these lines, and the `ndjson` download is that spool:

```text
{"t":"meta","section_tipo":"rsc167","total":128,"data_format":"grid_value","breakdown":"rows", ...}
{"t":"col","i":0,"key":"...","label":"Inventory number","cell_type":"text", ...}
{"t":"row","rec":12,"sub":0,"c":{"0":"NM-0001","1":"7.21"}}
{"t":"end","columns":[0,1,2],"rows":340,"records":128}
```

Raw cell shape (`data_format:'dedalo_raw'`), the form the CSV import tool unwraps — always the component's stored value wrapped exactly once:

```json
{"dedalo_data":[{"value":"Hello","lang":"lg-eng","id":1}]}
```

A component with [dataframe](../../../core/components/component_dataframe.md) slots grows one extra column per slot, headed by the dataframe component's tipo and carrying its own frame locators (`WC-2026-08-09-export-raw-dataframe-own-column`).

## Related

- [Export user guide](../../../tools/using_export.md) · [Exporting data](../../../core/exporting_data.md) — the end-user + developer guide for this tool (UI walkthrough, formats, breakdown, presets, NDJSON protocol, downloads, retention).
- [tool_import_dedalo_csv](tool_import_dedalo_csv.md) — consumes the `dedalo_raw` export (loading edited cells back, not a restore); see [Importing data](../../../core/importing_data.md).
- [Creating new tools](../creating_tools.md) · [Server contract](../server_contract.md) — the tool model, `apiActions`, gates and lifecycle this page builds on.
- Source: `tools/tool_export/server/{index,tool_export,export_job,preview,download,access,artifact_store,spool_reader}.ts`, `tools/tool_export/server/writers/`, `tools/tool_export/register.json`, `tools/tool_export/js/{tool_export,render_tool_export,flat_table,drag_tool_export,phone_tool_export,export_user_presets}.js`; the reused resolution core: `src/core/resolve/relation_list.ts`.
