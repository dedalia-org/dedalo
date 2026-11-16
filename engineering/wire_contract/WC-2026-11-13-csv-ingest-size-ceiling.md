# WC-2026-11-13-csv-ingest-size-ceiling — the CSV size ceiling holds at every CSV door, in bytes, before the read; get_csv_files read errors reach the panel

- **Date:** 2026-11-13.
- **Decision:** RC-closure T1-S18 (audit S18; DOS-04 class). DEC-12 gates:
  `test/unit/csv_ingest_ceiling_native.test.ts` (A get_csv_files, B validate_import,
  C import_files, D process_uploaded_file, E the bounded door itself — a sparse
  all-NUL oversized fixture, so the size sentence without `NUL` proves the refusal
  happened before the read), `test/unit/ingest_encoding_tripwire.test.ts` §3c
  (the controller keeps `csv_files_errors`, no `console.error`; the painter's
  error block is error-shaped, its notice block is not), client suite
  `TOOL_IMPORT_DEDALO_CSV READ ERRORS (real server answer)`.
- Code: `src/core/tools/import_csv.ts` (`CSV_INGEST_MAX_BYTES`),
  `src/core/tools/ingest_encoding.ts` (`readIngestTextFile(path, label, maxBytes)`,
  `oversizedIngestSentence`), `tools/tool_import_dedalo_csv/server/index.ts`
  (`assertStagedCsvSize`, the two read doors),
  `tools/tool_import_dedalo_csv/js/tool_import_dedalo_csv.js`
  (`csv_files_errors`, `render_csv_files_messages`).

## Shape before

- **PHP (frozen v7 and v6):** no size bound at any door
  (`tool_common::read_csv_file_as_array` builds the full array). `get_csv_files`
  pushed per-file `errors`, and the client never read them.
- **TS until now:** one 64 MB check, inside `analyzeCsv` (the get_csv_files preview
  worker only), comparing DECODED code units against "bytes", run after the whole
  file had been buffered and decoded on the serving loop. `validate_import` and
  `import_files` read, parsed and cloned any size (measured: 64 MB → ~2.2 GB RSS in
  the worker + the full row set cloned into the main thread);
  `process_uploaded_file` staged any size. The worker posted `error.message`, so
  the check's code was lost. The client sent get_csv_files `errors` to
  `console.error`: an unreadable staged file vanished from the panel.

## Shape after (TS)

- ONE bound, `CSV_INGEST_MAX_BYTES` (64 MB, the DOS-04 value), counted in BYTES on
  disk, enforced at every CSV door before a byte is buffered:
  - `process_uploaded_file` THROWS `media.too_large` (public sentence naming the
    file, its byte size and the limit); the file stays staged;
  - `get_csv_files`: the file is absent from `files` (unchanged) and its `errors`
    line is the size sentence (`Error on read file <name>: <sentence>`);
  - `validate_import` / `import_files`: the file's report is `ok:false` with the
    size sentence in `errors`; `import_files` refuses before the dd800 run record
    exists (gate C COUNTS the user's dd800 rows before/after, with a mint positive
    control). `import_files`' per-file failure report carries the run's
    `bulk_process_id` when the dd800 was already minted (was: always `null`), so
    a failure after the mint names the run record it left.
- `readIngestTextFile` takes a REQUIRED `maxBytes`. A file that grows between the
  fstat and the read is refused (`media.too_large` if it crossed the bound, else
  `request.invalid_data` "changed while it was being read").
- The `analyzeCsv` worker check is deleted (the text it sees is bounded upstream).
- `tool_import_zotero` reads through the same door, bounded at the advertised
  upload cap (`DEDALO_UPLOAD_MAX_SIZE_BYTES`) — no change for an uploaded export,
  an out-of-band file can no longer be read unbounded. Its own value is open (WS-10).
- Client: get_csv_files `errors` are kept as `csv_files_errors` and painted at the
  top of the tool body in the error channel's shape
  (`.dedalo_last_error_container.csv_files_errors > .error_pre`), below the
  notices. The `errors` field shape is unchanged.

## Open owner decisions (T1-S18 plan §7, unruled)

1. The ceiling's value at the import door: keep 64 MB (implemented — the existing
   DOS-04 value), a lower constant, or a catalog key.
2. A delete affordance for an unreadable staged file (listed with a `read_error`
   field and a delete-only card) — not implemented; re-uploading the same name
   overwrites it.

## Reason

DOS-04 left two of four doors unbounded for the one Bun process serving every
user; a refusal the operator cannot see is a silent loss of their upload.

## Addendum 2026-11-13 — the Zotero door holds the SAME ceiling (owner C51)

Open decision 3 of the T1-S18 plan (a Zotero-specific limit) is ruled: a
CSL-JSON export is bounded at `CSV_INGEST_MAX_BYTES` (64 MB), not at the upload
cap. `tools/tool_import_zotero/server/index.ts` `readExport` pre-checks the
staged file's size on disk and lists an oversized one in the report's `errors`
(`oversizedIngestSentence` — the file, its size, the limit) WITHOUT opening it,
leaves it staged (not consumed), and reads the rest through
`readIngestTextFile(staged, name, CSV_INGEST_MAX_BYTES)`. The file-level error
shape is unchanged. Gate: `tool_import_zotero_native.test.ts` "C51: an export
over the 64 MB ingest ceiling is refused at the door" (a sparse file one byte
over). Decision 1 (keep 64 MB) and 2 (the delete card) were ruled the same day
(`WC-2026-11-13-csv-staged-file-read-error-card`); the streaming CSV parse
stays a follow-up. Fragment `zotero-call-number-identifier-and-size-limit`.

