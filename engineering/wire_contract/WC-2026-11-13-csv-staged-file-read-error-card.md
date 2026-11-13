# WC-2026-11-13-csv-staged-file-read-error-card — `get_csv_files` lists a staged CSV it could not read as a `read_error` entry in `files`; the panel renders a delete-only card

- **Date:** 2026-11-13.
- **Decision:** owner ruling C51 (`T1_owner_decisions.md`, 2026-11-13; item
  T1-S18 §7.2): "delete card: yes". Amends
  WC-2026-11-13-csv-ingest-size-ceiling ("the file is absent from `files`").
  DEC-12 gates: `test/unit/csv_ingest_ceiling_native.test.ts` case A (the
  oversized file is in `errors` AND in `files` as `{dir, name, read_error}`,
  no column analysis), client suite
  `TOOL_IMPORT_DEDALO_CSV READ ERRORS (real server answer)` (the entry on the
  controller's list; the card: name, sentence as TEXT, delete button, no
  checkbox / mapper / preview / section input; a readable entry still renders
  the full card).
- Code: `tools/tool_import_dedalo_csv/server/index.ts` `getCsvFiles`;
  `tools/tool_import_dedalo_csv/js/render_tool_import_dedalo_csv.js`
  `render_file_info` → `render_unreadable_file_card`.

## Shape before

- **PHP (frozen v7 and v6):** `get_csv_files` pushed per-file `errors`; the
  client never read them, and an unreadable file was simply absent from the
  panel.
- **TS since WC-2026-11-13-csv-ingest-size-ceiling:** the file was absent from
  `files` and its sentence in `errors`, which the panel painted as a red line.
  A red line has no card and no delete button: the operator could read WHY the
  file was refused but could not remove it from the panel — `delete_csv_file`
  accepts the name, but nothing offered it.

## Shape after (TS)

`get_csv_files` answers `{files, errors, notices}` as before, and a file the
server could not read (over `CSV_INGEST_MAX_BYTES`, not text, damaged, or not
parseable as CSV) is ALSO in `files`, as

```json
{ "dir": "<import dir>", "name": "<file>.csv", "read_error": "<sentence>" }
```

- `read_error` is the refusal sentence: a `DedaloError`'s vetted
  `publicMessage` where the read door threw one (the size / encoding
  refusals), else the raw message, or `error reading file: <name>` for a file
  that read but did not parse. The `errors` line is kept (`Error on read file
  <name>: <sentence>`), so the panel's error block is unchanged.
- The entry carries NONE of the analysis keys (`n_records`, `n_columns`,
  `file_info`, `ar_columns_map`, `sample_data`, `sample_data_errors`): a
  consumer keyed on `ar_columns_map` must test `read_error` first.
- The client renders such an entry as a `.file_item.unreadable` card — the
  file name, the sentence as a text node (`.read_error`) and the delete
  button — with no checkbox (it can never be selected for import), no
  section_tipo input, no mapper and no preview.

## Divergences from PHP (deliberate)

- An unreadable staged file is VISIBLE and REMOVABLE from the panel. PHP showed
  nothing; the operator deleted it on the server.
- `files` may hold entries without a column analysis. The only consumer is the
  tool's own client; the AI/MCP tool surface does not expose `get_csv_files`.

## Gate reconciliation

No frozen fixture replays `get_csv_files` with an unreadable file — no fixture
edit, no re-harvest. Case A of `csv_ingest_ceiling_native` was tightened from
"absent from `files`" to "listed as a `read_error` entry".
