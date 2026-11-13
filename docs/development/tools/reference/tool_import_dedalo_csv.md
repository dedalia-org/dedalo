# tool_import_dedalo_csv

Imports CSV files into Dédalo sections — notably `tool_export` `dedalo_raw` exports loaded back after a spreadsheet edit — conforming each cell per-component (typed input, not a verbatim restore; the lossless copy is the [archive door](../../../core/exporting_data.md#the-archive-door)), with multi-language support and time-machine tracking.

## What it does / why & when to use it

`tool_import_dedalo_csv` ingests a CSV file where the first row is a header of component ontology tipos (plus a mandatory `section_id` column) and every following row is a record. For each cell it asks the target component to *conform* the raw text into stored v7 data, then creates or updates the matching record.

It is the import counterpart of [`tool_export`](tool_export.md): a section exported in the `dedalo_raw` format (cells wrapped as `{"dedalo_data": <stored value>}`) re-imports unchanged, so the tool is the backbone of export → edit → re-import workflows. It also accepts hand-authored CSVs using canonical v7 dato, legacy v6 arrays, lang-keyed objects, or simple flat strings — see [Importing data](../../../core/importing_data.md) for the full per-component format catalogue.

Concrete heritage scenario: a numismatics team exports the *Types* section (`numisdata3`) to CSV with `tool_export` in `dedalo_raw` format, cleans the legend transcriptions and date ranges in a spreadsheet, then re-imports the file here. Because each row carries its `section_id`, existing Type records are updated in place (not duplicated); empty cells clear the corresponding component for that record (replace mode, the default); and the whole batch is reversible, exactly, from the bulk-process record it creates.

Key behaviours to know before importing:

- The first column must resolve to `section_id` — it is the record key. A row with an empty/invalid `section_id` is skipped and reported.
- Every column has a **mode** (`ar_columns_map[i].import_mode`): `replace` (the default) or `append` — see [Append mode](#append-mode-import_mode).
- In replace mode an **empty cell clears** the existing component data for that record (and that data language, when translatable). Omit a column entirely, or set it to append, to leave a component untouched.
- A **multi-language cell** (lang-keyed object or flat items carrying `lang` — both v6 and v7 raw exports) imports **every language it carries**; each language is saved as its own slice, and languages not present in the cell are preserved. See [Multiple languages](../../../core/importing_data.md#multiple-languages).
- A CSV header must match its mapped column name **exactly** (including suffixes like `tch56_dmy` or `tch191_rsc723`); mismatched columns are silently skipped.
- Three report channels: **`failed`** (the cell was rejected and NOT written — the record keeps its previous value), **`warnings`** (the cell WAS written but needs attention, e.g. a `select_lang` code that resolves but is not one of the project languages) and **`notices`** (what the engine DID to the file in order to read it — today, an encoding conversion). A notice is not a defect in the file and is never rendered as one: the panel paints `errors` red, and a successful conversion is not a failure.
- A file that cannot be trusted is refused whole, before anything is written: a row whose width disagrees with the header (every value after the mismatch would land in the wrong component), a quoted value that is never closed, and an upload that cannot be honestly converted to text. Nothing is imported, and the refusal names the file — and the row, when a row is what is wrong. See [Importing data](../../../core/importing_data.md#format).
- A component with no flat-value form (media, for instance) **refuses** a flat cell rather than writing it: a refused cell leaves the existing value intact, where a "conform to nothing and save" would silently clear it.
- The report's `created` / `updated` are **arrays of `section_id`s**, not counts — the panel lists them and offers "copy as column" so you can paste them straight into a search.

## How it works

### Server

The tool module (`tools/tool_import_dedalo_csv/server/index.ts`) is the **API surface**; the import engine lives in core and is shared:

| Module | Owns |
| --- | --- |
| `src/core/tools/import_csv.ts` | parse the CSV + PLAN the import (per-cell conform) |
| `src/core/tools/import_conform.ts` | the **per-model parsers** — what turns a human-authored cell into stored data |
| `src/core/tools/import_csv_execute.ts` | APPLY the plan (one transaction per row) |
| `src/core/tools/import_wire.ts` | the typed report + progress contract the client renders |

The six declared actions:

1. **Staging.** Uploaded files land in a per-user directory that the module creates and confines; client-supplied paths are never trusted for listing/deletion (path-confined the same way `paths.ts`/`loader.ts` confine tool asset paths — see [Security](../security.md)).
2. **Listing & validation.** `get_csv_files` (`permission: null`) parses every staged CSV (`parseCsv`, `src/core/tools/import_csv.ts`), builds the column map (resolving each header tipo to its ontology label + model), and returns per-file `n_records`/`n_columns`/`sample_data`/`sample_data_errors`. The exact response shape below was fixed after driving the real client end to end: the client crashes on anything narrower.
   **The size ceiling.** `CSV_INGEST_MAX_BYTES` (`src/core/tools/import_csv.ts`, 64 MB) is ONE bound for every CSV door, counted in bytes on disk. `get_csv_files`, `validate_import` and `import_files` read through `readIngestTextFile(path, label, maxBytes)` (`src/core/tools/ingest_encoding.ts`), which refuses a larger file with `media.too_large` BEFORE buffering it; `maxBytes` is a required argument, so no door reads unbounded by omission. The refusal is the file's per-file sentence (`get_csv_files` `errors`, the validate/import report `errors`), so a file that previews will import, and one refused at import is refused at preview. (WC-2026-11-13-csv-ingest-size-ceiling.)
3. **Preflight.** `validate_import` (`permission: 'section_list', minLevel: 1`) checks the column map against the target section AND dry-runs the conform over a sample of rows — so a wrong date order or decimal separator is caught in milliseconds, before anything is written, instead of after a 10 000-row failed run.
4. **Import.** `import_files` (`permission: 'section_list', minLevel: 2`, `backgroundRunnable`) is the entry point. It plans the import (`planCsvImport`) and applies it (`executeCsvImport`) through the standard write path (`createSectionRecord` + `saveComponentData` — the same one other import tools use, not a bespoke one). Each ROW is one transaction, so a row is all-or-nothing; the whole file's existing records are resolved with a single query rather than one per row.
5. **Per-cell conforming.** Two paths, and the difference is the whole design. A cell that **is JSON** is the stored data coming back (a `dedalo_raw` export), and re-importing must reproduce it exactly — that path is model-agnostic, so it works for every component model. A cell that is **not JSON** is human input (`21-05-1998`, `1.234,56`, `41.38, 2.17`, `273,418`), and parsing it is model-specific: each model declares an `importConform` facet on its descriptor, resolved to a parser in `import_conform.ts`. A model with no facet has no flat form, and such a cell is refused rather than written.
6. `process_uploaded_file` (`permission: null` — both the staged source and the destination are rebuilt from the caller's own id) moves a staged upload into the import directory, refusing one over `CSV_INGEST_MAX_BYTES` with `media.too_large` (the file stays staged); `delete_csv_file` (`permission: null`) soft-deletes a staged file; `get_section_components_list` (`permission: 'section', minLevel: 1`) lists the target section's components for the column mapper (virtual sections resolve through their real one).

### Client

`tools/tool_import_dedalo_csv/js/tool_import_dedalo_csv.js` wires the standard tool lifecycle (`init` / `build`, render delegated to `render_tool_import_dedalo_csv.js`) and opens in a **window** (per the `dd1335` property `open_as: "window"`). On build it loads the staged file list (`load_csv_files_list` → `get_csv_files`) and spins up a `service_upload` instance limited to the `csv` extension under the `csv` key_dir. Each request goes through `data_manager.request` with a `dd_tools_api` / `tool_request` RQO built by `create_source(self, '<action>')`. `load_csv_files_list` keeps both per-file channels of the answer: `csv_files_notices` (what was done to a file to read it) and `csv_files_errors` (the files that could not be read — they are absent from `files`). `render` paints both at the top of the tool body through the exported `render_csv_files_messages`: notices as `.notice_msg`, read errors in the error channel's `.dedalo_last_error_container` > `.error_pre`.

The render layer lets the user, per file: confirm/override the auto-detected target `section_tipo` (parsed from the filename `…-<section_tipo>.csv`, falling back to `self.caller.tipo`), edit each column's mapping (`map_to`, `checked`, decimal separator), edit the bulk-process label, and preview sample rows. The import button submits the selected files (there is no time-machine switch — every save of a run records its undo pair, WC-2026-09-27-bulk-revert-undo-log); `import_files` is sent with `background_running: true` and returns a **`job_id`**. Deleting a file (`remove_file` → `delete_csv_file`) moves it to a `deleted/` subfolder rather than hard-deleting it.

**Progress and report.** The client subscribes to the job with `dd_utils_api::get_job_events`, which **pushes** a frame the instant the job changes state — no polling timer. Each frame carries a typed `ImportProgressFrame` (phase, file, row/`rows_total`, current record and component, live created/updated/failed/warning counts), which is what drives a real progress **bar**. The stream ends on the terminal frame, and that frame's payload is the full report.

**The client keeps no state.** After a page reload it re-attaches by *asking the server* — `get_background_jobs('import_files')`, then subscribing to whichever job is still running. It stores no `job_id` anywhere: the job runs inside the server, whose registry already records its tool, action and owner. See [Server contract](../server_contract.md).

### Append mode (`import_mode`)

A column in `append` mode ADDS its cell to the stored data instead of replacing it. The contract is `WC-2026-09-27-csv-import-append-mode` (in `engineering/wire_contract/`); the pieces:

- **The descriptor facet `importAppend`** (`src/core/components/types.ts` `ImportAppendPolicy`, read through `getImportAppendPolicy` in `src/core/components/registry.ts`). Every canonical model declares one — a model without it makes the accessor throw, never guess — and alias models inherit it through their canonical model (`component_autocomplete` / `component_autocomplete_hi` → portal, `component_input_text_large` / `component_html_text` → text_area, `component_security_tools` → check_box, `component_calculation` / `component_state` → info). Gate: `test/unit/descriptor_completeness_tripwire.test.ts`.

| Policy | Models | Merge |
| --- | --- | --- |
| `'items'` | `component_input_text`, `component_email`, `component_number`, `component_date`, `component_iri`, `component_portal`, `component_check_box`, `component_filter`, `component_filter_master`, `component_relation_related`, `component_relation_parent`, `component_dataframe` | stored items + the new ones; a duplicate is skipped |
| `'geo_layer'` | `component_geolocation` | a new `lib_data` layer per imported layer or flat point |
| `'text_paragraphs'` | `component_text_area` | a new `<p>` paragraph per language |
| `{ refuse: reason }` | media (`component_3d`, `component_av`, `component_image`, `component_pdf`, `component_svg`); single-choice (`component_select`, `component_radio_button`, `component_select_lang`, `component_publication`, `component_relation_model`); opaque (`component_json`, `component_password`, `component_security_access`, `component_filter_records`); identity (`component_section_id`); derived (`component_info`, `component_inverse`, `component_external`, `component_relation_children`, `component_relation_index`) | refused, with the reason in the message |

- **The tool server refuses first.** Append on a refuse-policy model, on the `section_id` key column, or on an audit tipo (`dd197`, `dd199`, `dd200`, `dd201`, refused by tipo, also through a `component_alias` of one) is refused per column in `validate_import` and in `import_files` **before** the `dd800` bulk-process record is created — nothing is written. The model is the one the server resolves (an alias's target model), never the client's `model`. A `component_alias` column carries its target as `CsvColumn.dataTipo` (`resolveDataTipo`), and the executor keys every stored-data read, item-id allocation and frame pairing by it — stored data never holds an alias tipo.
- **The engine flag `SaveRequest.appendImport`** (`src/core/section/record/save_component.ts`): `true`, or `{preallocatedIds}` when a row's translations must share one item id. It is **not a wire field** — no rqo, MCP schema or `dd_core_api` door can set it; only the CSV executor does. The change stays a single `set_data`; the merge runs inside `saveComponentData` after the locked `FOR UPDATE` read and the value gates, so it cannot race a concurrent save, and the engine re-checks the policy and throws on `refuse` (the backstop for any other caller). An append that adds nothing is a no-op: no time-machine row, no `dd201` bump.
- **The merge** is the pure module `src/core/section/record/append_merge.ts`:
    - stored items are kept **byte-for-byte** — never re-normalized, a stored duplicate never collapsed, a lang-less item never dropped;
    - relations: incoming `id` / `paginated_key` stripped, each item validated by the relation insert law with `existingItems = stored + accepted` (key `section_id|section_tipo|type|tag_id[|lang]`), over the whole array, never a language slice; going over `properties.data_limit` throws and the row rolls back;
    - literals: dedup inside the current language slice only — equality on `value`; `component_iri` on `iri` + `label_id`; `component_date` on the whole item (`start`, `end`, `period`, …) minus `id` / `lang` and the computed `time` (at the top level of a flat time-mode item as inside a part);
    - item ids of a new translation: the executor's pre-allocated id when the cell carries several languages, else the id the stored sibling languages give that slice position (`getIdFromKey`, the first-translation rule) — never an id the slice already holds;
    - geolocation: layers join the first stored item's `lib_data` under `layer_id = max(every numeric layer_id and feature properties.layer_id) + 1`, features re-stamped, `user_layer_name: 'layer_<id>'`; the centre is untouched; a layer whose geometry equals a stored one, or a stored item's centre as a Point, is skipped (a flat point stored as a bare centre re-imports as a no-op); nothing stored: the model is single-value, so the first incoming item is the host, stored as is, and the layers of every later item fold into its `lib_data` the same way;
    - text_area: `stored + <p>text</p>` per language; a fragment already present is skipped; a value carrying any Dédalo tag is refused (`request.invalid_data`) and the whole row rolls back — tags pair with `component_relation_index` `tag_id`, which an append cannot re-key.
- **Outputs** (internal, never on the wire): `SaveResult.appendedIdMap` — incoming file item id (as a string) → final stored id, the existing id for a skipped duplicate — and `SaveResult.appendSkipped`, a count. The executor re-pairs dataframe frames through `appendedIdMap` (`id_key` remapped; a frame with no match fails the row), dedups them with `dataframeEntriesEqual` and honours `data_limit`; MIXED MODES fail the row: a replace-mode dataframe column whose frames name an append-mode main of the row (checked from the file), or whose slot already stores frames of one (checked under the row lock — a replace write replaces the whole slot, an empty cell clears it); and a replace-mode column whose legacy `{data, dataframe}` envelope frames name an append-mode main (the replace frame writer never re-pairs through `appendedIdMap`). Skipped duplicates surface as one warning per column (`N already present, not added`).
- **The executor** treats an empty cell, or an empty language group (`{"lg-spa":[]}`), as a no-op; rows repeating a `section_id` accumulate. For a cell carrying several languages of a translatable literal it resolves ONE id per item BEFORE the per-language saves, under the row lock and after absorbing the stored ids into the counter: a language that duplicates a stored item names that item's id and the new translations take it; no language matching allocates one fresh id (a fully duplicate item allocates nothing, so a re-import writes nothing); languages that disagree with the stored item refuse the row rather than split it across two ids. A `component_text_area` cell never refuses: each language that already has a text gets a paragraph appended to it, and the languages without one share one id (a stored text id free in their slices, else one fresh id); blank texts join no id. A frame whose main component has an append column in the row must re-pair through that column's saves — also when the cell was empty or failed conform (the row fails); only a main with no append column keeps the file's `id_key` as a stored item id. Append-mode frames, legacy `{data, dataframe}` envelopes included, are saved as a slot column's are. Every save of a run — replace or append, a main column, a slot column or a legacy `{data, dataframe}` envelope's frames — records the run's undo pair under its bulk id: a hidden BEFORE image of the region it replaced and the ordinary visible after-row (one per saved language), and nothing when it changes nothing ([tm_record](../../../core/system/tm_record.md#the-bulk-undo-log)). A frame save (slot column, envelope or append-mode frames) writes no pair of its own: it writes the `lg-nolan` pair of the main its frames belong to (the frames' `main_component_tipo`; the main's `lg-nolan` value plus every slot's frames — the [two lanes](../../../core/system/tm_record.md#dataframe-mains-two-lanes)) — also when the main item was a duplicate and the main save wrote none. A record the run really inserts gets a birth marker; the conflict-tolerant no-op insert gets none. The `dd800` bulk revert therefore restores each key's exact pre-run region, append columns included, and skips a key edited after the run (WC-2026-09-27-bulk-revert-undo-log). The MARC21, Zotero and RDF import doors stay replace-only.

## Actions & options

`apiActions` (declarative form for the gated actions; `backgroundRunnable = ['import_files']`):

| Action | Permission gate | Key options it reads | Returns |
| --- | --- | --- | --- |
| `get_csv_files` | `permission: null` — always scoped to the caller's own per-user dir | *(none — client `files_path` is ignored)* | `{files, errors, notices}` — `files`: array of `{dir, name, n_records, n_columns, file_info, ar_columns_map, sample_data, sample_data_errors}`; `errors`: the per-file read problems (one unreadable CSV must not hide the files that did parse); `notices`: what was done to a file that WAS read (an encoding conversion — the sample values below it are the converted text) |
| `delete_csv_file` | `permission: null` — path-confined to per-user dir | `file_name` (basename-confined; client `files_path` ignored) | `result`: bool — moves the file to `deleted/<name>_deleted_<date>.csv` |
| `validate_import` | declarative `permission: 'section_list', minLevel: 1` on every file's `section_tipo` | `files` (same shape as `import_files`) | `{ready, files}` — `ready`: every file validated clean; per file `{ok, file, section_tipo, rows_total, rows_sampled, errors, notices, failed, warnings, columns}` — `columns`: one `{index, column, tipo, model, mode, refused}` per imported column — the `section_id` key column included; a deselected column, or one ignored for a stale map / unknown target (named in `errors`), has none (`mode`: `'replace'` \| `'append'`; `refused`: the append refusal as a string, or `null`), an empty array when the file itself was refused. Every per-column append refusal is also named in `errors` (the same refusal the run raises). **Preflight only, writes nothing.** `ok` is computed from `errors` + `failed` ONLY, so a converted file validates (`ok: true`) and says what was done to it |
| `import_files` | declarative `permission: 'section_list', minLevel: 2` on **every** file's `section_tipo` (the targets ride inside `options.files[]`, one section per file) | `files` (array of `{file, section_tipo, ar_columns_map, bulk_process_label}`) | `job_id` (the handle); the job's terminal frame carries `result`: per-file array of `ImportFileReport` |
| `process_uploaded_file` | `permission: null` — user-scoped by construction (staged source and destination are both rebuilt from the caller's id) | `file_data` (`{name, tmp_name, key_dir, …}`) | `result`: bool, `file_name` — moves the temp upload into the user's import dir |
| `get_section_components_list` | declarative `permission: 'section', minLevel: 1` | `section_tipo` | `{components, label}` — `components`: array of `{label, value, model, import_append}` for the section's components + section-info components, `import_append` being the model's append policy (`'items'` / `'geo_layer'` / `'text_paragraphs'`) or `null` when append is refused; `label`: section label |

Notes:

- There is no time-machine option: `time_machine_save` (the retired checkbox) is no longer read, and a caller still sending it is not refused. Every run is revertible from its bulk-process record.
- `ar_columns_map` items use `tipo` (the CSV header), `map_to` (the target component tipo), `checked` (whether to import the column), `model`, optional `decimal` (for `component_number` — the "Decimal" selector in the mapper, `,` or `.`) and optional `import_mode` (`'replace'`, the default, or `'append'`; any other value refuses the whole file with `request.invalid_options` before anything is written). Unchecked columns, columns without `map_to`, and the `section_id` column are skipped. The **model is re-resolved from the ontology**, never trusted from the client.
- Every `backgroundRunnable` tool also answers two reserved framework actions, served by the dispatcher itself: `get_background_job_status` (one job by id) and `get_background_jobs` (**the caller's jobs for this tool** — how a reloading client finds the run whose id it no longer has). Both are scoped to the caller's own jobs unless they are a global admin.
- Internal helpers (CSV parsing, column-map validation, staging-path resolution) are plain functions in `import_csv.ts`/`import_data.ts`, not exposed as actions.

## How it is registered & surfaced

`tools/tool_import_dedalo_csv/register.json` is a **column-keyed dump** (`string`/`relation`/`misc`/… keyed by component tipo — a seeded matrix-row snapshot, not a hand-authored file); `importTools()` passes it through as-is (see [register.json reference](../register_json.md)). Essentials decoded from its ontology tipos:

- `dd1326` name → `tool_import_dedalo_csv`; `dd1327` version → `2.0.4`; `dd1328` `dedalo_version_min` → `6.2.5`.
- `dd1335` properties → `{ "open_as": "window" }` — the tool opens in its own window, not a modal.
- `dd1330` affected_models → empty (`{}`); the tool is attached to sections via the `dd1331` (show_in_inspector) / `dd1332` (show_in_component) relations pointing at the generic section model (`dd64`).
- `dd1354` active → on; `dd1372` labels carry the UI strings (`import`, `select_a_file`, `preview`, `records`, `columns`, `bulk_process_title`, …).

Surfacing is element-driven in `getElementTools` (`src/core/tools/registry.ts`): it appears on **sections** (its target is always a section, since import writes whole records keyed by `section_id`), rendered from the inspector / section tools area. The client takes the section context from `self.caller` (the active section's `tipo`) and from the filename to pick the import target.

New tools should use the v7 `register.json` format instead; see [Creating tools](../creating_tools.md).

## Examples

### Client tool_request (as the JS issues it)

The import action, built by `create_source(self, 'import_files')` and sent through `data_manager.request`:

```js
const rqo = {
    dd_api  : 'dd_tools_api',
    action  : 'tool_request',
    source  : create_source(self, 'import_files'), // { model:'tool_import_dedalo_csv', action:'import_files', ... }
    options : {
        background_running : true,
        files : [{
            file               : 'types_clean-numisdata3.csv',
            section_tipo       : 'numisdata3',
            bulk_process_label : 'Import | numisdata3 | Types',
            ar_columns_map     : [
                { tipo:'section_id',  model:'section_id',     checked:false, map_to:'' },
                { tipo:'numisdata81', model:'component_input_text', checked:true, map_to:'numisdata81' },
                { tipo:'numisdata27', model:'component_input_text', checked:true, map_to:'numisdata27', import_mode:'append' }
            ]
        }]
    }
}
```

### The CSV being imported

A `dedalo_raw` export wraps each cell with `dedalo_data` (one column per component, [dataframes](../../../core/importing_data.md#dataframe-columns) included); the `section_id` column stays a plain int (the record key) and empty cells clear data:

```text
section_id;numisdata81;numisdata27
1;"{""dedalo_data"":[{""value"":""key1""}]}";"{""dedalo_data"":[{""value"":""062""}]}"
2;"{""dedalo_data"":[{""value"":""key2""}]}";"{""dedalo_data"":[{""value"":""685a""}]}"
```

Hand-authored CSVs can skip the wrapper and use flat strings instead (`062`, a date as `2023/10/26`, a relation id list `1,4,6`, …) — see [Importing data](../../../core/importing_data.md).

### The report

`import_files` answers immediately with a `job_id`. The report arrives on the job's **terminal** event frame (`dd_utils_api::get_job_events`), one `ImportFileReport` per file:

```json
{
  "result": [{
    "ok": true,
    "file": "types_clean-numisdata3.csv",
    "section_tipo": "numisdata3",
    "bulk_process_id": 412,
    "created": [],
    "updated": [1, 2],
    "failed": [],
    "warnings": [],
    "errors": [],
    "notices": [],
    "rows_total": 2,
    "ms": 34
  }],
  "msg": "Import done. Created 0, updated 2, failed 0.",
  "errors": []
}
```

`created` and `updated` are the `section_id`s themselves, so the panel can list them and copy them to the clipboard. `failed` and `warnings` hold `{section_id, component_tipo, msg, data, row}` — `row` being the 1-based CSV line, so a rejected cell points at the spreadsheet row that produced it.

`errors` and `notices` are both file-level lists of sentences, and the difference between them is what the panel does with each. `errors` is what went wrong (rendered red); `notices` is what was DONE (rendered as ordinary report text) — an import that converted a windows-1252 file reports `"ok": true` with the conversion in `notices`, e.g.:

```json
"notices": ["types_clean-numisdata3.csv: the file is not UTF-8 — it was read as windows-1252 and converted. Check the imported values; saving the file as UTF-8 before importing removes the guess."]
```

While the job runs, each frame instead carries an `ImportProgressFrame`:

```json
{
  "phase": "importing",
  "file": "types_clean-numisdata3.csv",
  "file_index": 1, "files_total": 1,
  "row": 1, "rows_total": 2,
  "section_id": 1, "component_label": "Legend",
  "created": 0, "updated": 1, "failed": 0, "warnings": 0
}
```

## Related

- [tool_export](tool_export.md) — the export counterpart; its `dedalo_raw` format produces the `dedalo_data`-wrapped CSV this tool round-trips.
- [tool_import_files](tool_import_files.md) — ingest media files (not CSV record data).
- [tool_import_marc21](tool_import_marc21.md), [tool_import_rdf](tool_import_rdf.md), [tool_import_zotero](tool_import_zotero.md) — format-specific importers.
- [tool_propagate_component_data](tool_propagate_component_data.md) — SQO-driven bulk component edits with the same bulk-process / time-machine reversion model.
- [Importing data](../../../core/importing_data.md) — the per-component CSV format catalogue, the `dedalo_data` wrapper, dataframe columns, empty-cell semantics.
- [Exporting data](../../../core/exporting_data.md) — the export side of the round-trip.
- [Creating tools](../creating_tools.md), [Server contract](../server_contract.md) — the tool model and the `ToolServerModule` contract.
- Source: `tools/tool_import_dedalo_csv/server/index.ts`; import engine: `src/core/tools/{import_csv,import_conform,import_data,import_csv_execute,import_wire}.ts`; the write path: `src/core/section/record/{create_record,save_component}.ts`.
