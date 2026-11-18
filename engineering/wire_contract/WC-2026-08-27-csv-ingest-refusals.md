# WC-2026-08-27-csv-ingest-refusals — the CSV/MARC ingest doors refuse what the frozen oracle imported

- **Date:** 2026-08-27, with the P0-5 remediation of DATA-04 (S1), DATA-09, DATA-21 and DATA-22
  (audit `audits/2026-08-26_deep/`).
- **Decision:** DEC-12 (an invariant is tripwired or deleted) and the project premise — silent
  corruption or loss of a heritage record outranks compatibility with a behaviour that produced it.

## What is NOT a divergence

The CSV READER itself is a **restoration**, not a divergence. `parseCsv` had been entering
enclosure mode on a `"` found anywhere in a field; the replacement is a byte-faithful port of the
frozen `tool_common::read_csv_file_as_array` (`fgetcsv($f, 0, ';', '"', '"')` + the BOM strip on
row 1 + `trim()` on every cell). It was verified by differential execution against PHP 8.5.4: the
28-position fixture table of `test/unit/csv_parser_conformance_native.test.ts` (0 divergences)
plus a further 9,029-input corpus — 29 hand-picked positions and 9,000 pseudo-random strings over a
CSV-metacharacter alphabet including multi-byte characters and NBSP — also **0 divergences**. Where the TS engine had diverged from the
oracle (mid-field quotes swallowing the file tail, even quote pairs being deleted from the value,
CRLF inside an enclosure folded to LF, `String.trim()` eating an NBSP the value owned), it now
matches it.

## Shape before (PHP)

1. **Ragged rows** — `fgetcsv` returned a row with fewer or more cells than the header and the
   importer mapped by index, so every value after the mismatch was written into the WRONG
   component. Reported as a successful import.
2. **Unterminated enclosure** — a field that opens `"` and never closes absorbs the delimiter, the
   row terminator and the whole remainder of the file into one cell. PHP imported that cell as the
   record's value; every record after it was simply never imported. Reported as a successful import.
3. **Row identity** — `(int)$cell`: `'12abc'` resolved to record **12**, and the row was written
   into a record the operator never named.
4. **MARC21** — the bundled PEAR `File_MARC` decoded the record's bytes without consulting leader
   position 09 (character coding scheme), so a MARC-8 record's diacritics were mangled silently.
   And `applyMarcMap` read `field_to_section_id` with `Number.parseInt`, i.e. row identity (3)
   again at the door beside it: a `907$a` of '12abc' resolved to record **12**.
5. **CSV/TSV download** — no UTF-8 BOM, so Excel opened it in the system ANSI code page and saved
   it back as CP1252 — which is exactly the input the import door then had to guess at (DATA-09).

## Shape after (TS)

1. A row whose width disagrees with the header **REFUSES the file**, naming the row and both
   widths. Nothing is imported. A wholly empty row is a blank line, not a violation.
2. An unterminated enclosure **REFUSES the file**, naming the row. (The parser still absorbs the
   tail exactly as `fgetcsv` does — the refusal is the DOOR's, so the reader stays a faithful port
   and the pinned fixture table stays measurable against PHP.)
3. A `section_id` cell that is present but is not a record id **SKIPS that row** with a per-row
   line in the report naming the cell, and the PREFLIGHT reports the same row before anything is
   written. An EMPTY key is unchanged — it was always "no record to match".

   **The grammar, not a parser** (the residual, closed 2026-08-27 after review): the first fix
   read the cell with strict `Number()`, which does refuse `'12abc'` but is a numeric-LITERAL
   reader — measured on this tree: `'0x10'` → 16, `'0b101'` → 5, `'0o17'` → 15, `'1e3'` → 1000,
   `'+12'` → 12, `'12.'` → 12. Each is a positive safe integer, so each silently resolved to A
   RECORD THE OPERATOR NEVER NAMED — the same defect one guess further out. A record id in a CSV
   cell is now defined as A RUN OF DECIMAL DIGITS (`/^[0-9]+$/`, still bounded by
   `Number.isSafeInteger`); everything else is refused by name. `'007'` still resolves to 7.
4. A MARC21 record whose leader position 09 does not declare Unicode **and** which carries
   non-ASCII bytes is **REFUSED, per record**, into the run's error list; its ASCII-only siblings
   import as before. A record that declares Unicode but is not valid UTF-8 is refused too (the
   decode is `fatal:true`).

   **And the id (closed 2026-08-27, the residual named in the first round).** `applyMarcMap` reads
   `field_to_section_id` with the SAME grammar as (3) — a run of decimal digits — and REFUSES THE
   RUN, naming the field, the subfield and the cell, when the value is one the old reader would
   have turned into a record ('12abc' → 12, '1e3' → 1, '12.5' → 12, '0x10' → 0, '-5' → -5;
   `Number.parseInt` returns a number for each). The throw is the refusal channel because this
   mapper has none of its own: `MarcMappedRecord.sectionId = null` MEANS "create", so answering
   null for an unreadable id would silently create a duplicate instead of updating the record the
   operator named. The caller maps every record of every staged file BEFORE the executor writes
   anything, so the refusal costs nothing half-written.

   **UNCHANGED, deliberately:** a value that names no record at all ('REC-1', 'ocm12345678', a
   Millennium '.b12345678') still resolves to `null` → create. The frozen tool never used this
   value as a section_id at all — `resolve_target_section` SEARCHED it as a code
   (`get_section_id_from_code`) and created a record when the search found none (read in the
   frozen tree, not inferred) — and that lookup is one of this tool's ledgered unported pieces, so
   "not a record id" has always meant "create" here. Only the population the old reader INVENTED a
   record from is refused; `test/unit/marc21_map.test.ts` pins the unchanged half and stayed green
   untouched. Worth naming while it is in view: the digits path is itself that unported shortcut —
   the frozen tool would have searched even '900743' as a code — so the whole
   `field_to_section_id` resolution remains a divergence recorded in the tool's module header, of
   which this fix closes only the corruption arm.

   TWO COPIES OF THE GRAMMAR, on purpose: `marc21.ts` is a leaf parser whose only dependency is
   the error registry, and importing `import_csv.ts` puts the conform facets, the ontology
   resolver and the config layer behind `parseMarc` — measured while writing this fix, when an
   unrelated config module that failed to parse made the MARC parser unloadable. The durable fix
   is one leaf module both doors import (the `src/core/db/sql_identifier.ts` precedent, the same
   standing debt `phpTrim` has below); until then they are held equal by EXECUTION, in the same
   gate, over the same corpus.
5. The CSV and TSV downloads emit a UTF-8 BOM. Uploads that are not UTF-8 are converted
   (windows-1252, or UTF-16 by BOM) with a NOTICE in the file's report, or refused when no honest
   conversion exists (NUL bytes); no door produces U+FFFD any more.
6. **A NOTICE IS NOT AN ERROR — the report grew a second channel** (added 2026-08-27, a defect
   this fix itself introduced). The conversion notice was pushed into the report's `errors` array,
   and `render_tool_import_dedalo_csv.js` paints every string in `errors` into
   `.dedalo_last_error_container` as `error_pre`: a SUCCESSFUL, INTENDED CP1252 conversion showed
   the operator a red error. Every CSV door now carries it in its own `notices` array —
   `get_csv_files` (`{files, errors, notices}`), `validate_import` (per file) and `import_files`
   (per file) — and the panel renders it as ordinary report text. `validate_import`'s verdict is
   computed from `errors` + `failed` ONLY, so a converted file VALIDATES (`ok:true`) and says what
   was done to it.

   **`notices` IS A FIELD OF `ImportFileReport`** (`src/core/tools/import_wire.ts`, folded in
   2026-08-27). It was first declared as an `ImportFileReportWithNotices` extension in
   `import_csv_execute.ts` — a wire shape carried in a parallel type, which is the drift this
   ledger exists to prevent. A type move only: the client already read `report.notices`, and no
   byte on the wire changed. RESIDUAL, named because it is not invisible: the now-redundant
   `ImportFileReportWithNotices` extension still exists in `import_csv_execute.ts` and is still
   the annotation in `tools/tool_import_dedalo_csv/server/index.ts` — both files outside the edit
   set that folded the field in. It can no longer DIVERGE (an incompatible redeclaration in an
   extending interface is a `tsc` error — verified by making one), so what remains is a name to
   delete, not a second contract.

7. **THE MAPPER PREVIEW SAYS WHAT WAS DONE TO THE FILE IT PREVIEWS** (2026-08-27). `get_csv_files`
   answered `{files, errors, notices}` and the tool's controller read `errors` only — into
   `console.error`, which is not an operator surface — and dropped `notices` entirely. The column
   map and the sample values the operator maps their columns FROM are read out of the converted
   text, so the one place the conversion mattered most was the one place it was not said; the
   operator first heard of it in the report, after the records were written.
   `tool_import_dedalo_csv.js` now keeps the notices and its own `render` (the shared one,
   wrapped) inserts them at the top of the panel as ordinary report text. IN FLOW, not through
   `ui.show_message`: `.wrapper_tool` is `contain: content`, which makes it the containing block
   for absolutely positioned children AND clips them, and `.component_message` is
   `position:absolute; top:-3em` — a banner there is a surface that renders nowhere.
8. **The preflight sees every refusal the import makes.** `validate_import` is the only preflight
   an operator has, and "validated clean, then imported nothing" moves the discovery of a broken
   file from before the run to after it. It now reports the unreadable `section_id` cells of the
   sampled rows in `failed` (with the CSV row number), alongside the structural refusals it takes
   at the same door as the import (both raised by `assertCsvStructure`).

## Reason

Every one of these is a silent write of the wrong bytes into a heritage record, and four of the
five are invisible in the operator's report. The consumer here is not the client but the archive:
a file whose shape we cannot trust cannot be mapped onto components without a chance of writing
values into the wrong ones, and "refuse and let the operator fix the file" is the only outcome
with no corruption arm. The cost is a file that used to import and now does not — which is the
point: it used to import WRONG.

## `phpTrim` is implemented twice, deliberately, and pinned

`src/diffusion/parsers/php_string.ts` already exports `phpTrim` with the same PHP charlist, and
`src/core/tools/import_csv.ts` declares a second one. The planner CANNOT import the diffusion copy:
that is a new non-facade `core -> diffusion` edge and `test/unit/boundary_seam_tripwire.test.ts`
refuses it (the allowed direction is `diffusion -> core`, growing only through `src/diffusion/api/`).
The durable fix is the `src/core/db/sql_identifier.ts` precedent — MOVE the leaf module into core
and let diffusion import it downhill — which touches `php_string.ts` and its three importers.
Until then the two copies are held equal by EXECUTION, not by hope: `csv_parser_conformance_native`
runs both over every code point up to U+0400 at both edges and in the middle plus a seeded
random corpus (9,126 inputs), asserts 0 divergences, and asserts the corpus actually distinguishes
`phpTrim` from `String.trim()` so the agreement is not an agreement about nothing.

**And so is the record-id grammar, for a different reason.** `parseRecordIdCell` exists twice —
`src/core/tools/import_csv.ts` (the CSV door) and `src/core/tools/marc21.ts` (the MARC door) — not
because a tripwire forbids the import but because the direction that would work is the expensive
one: `marc21.ts` is a leaf ISO 2709 parser whose only dependency is the error registry, and
importing the CSV planner drags the conform facets, the ontology resolver and the config layer
behind `parseMarc` (measured: an unrelated config module that failed to parse made the parser
unloadable). Same durable fix, same interim: `csv_parser_conformance_native` runs both readers over
a seeded id-shaped corpus (3,025 inputs), asserts 0 divergences, and asserts the corpus actually
distinguishes the grammar from the `Number.parseInt` it replaced.

Note also that the two PHP charlists this door depends on are DIFFERENT SETS and neither can be
written in terms of the other: `php_fgetcsv` skips `isspace()` before an enclosure (space, `\t`,
`\n`, `\r`, `\v`, `\f`) while `trim()` strips `" \t\n\r\0\x0B"` — `\f` opens an enclosure and is
NOT trimmed; `\0` is trimmed and does NOT open one. All three fixture rows are measured.

## Gate reconciliation

- `test/unit/csv_parser_conformance_native.test.ts` — the 28-position fixture table (every
  expectation measured against the frozen reader on PHP 8.5.4, including the three added
  2026-08-27: an enclosure opened after tab/CR/`\v`/`\f`, a cell trimmed at NUL/`\v`/tab/CR edges,
  and `\f` opening an enclosure while surviving the trim), the refusal cases, the
  duplicate-`section_id` case, the DATA-22 numeric-literal table, the `phpTrim` differential, the
  preflight's view of every refusal, and the MARC door's half of the record-id grammar (the
  two-reader differential over the 3,025-input id corpus, the refusal population with its
  `Number.parseInt` premise asserted cell by cell, and the foreign-control-number case that must
  NOT change). 54 tests, 0 failures (measured 2026-08-27 against the final tree).
- `test/unit/ingest_encoding_tripwire.test.ts` — the tree-derived door census, the per-door
  behaviour (CP1252 CSV end to end, MARC leader/09), the delimited-download BOM census, the
  NOTICE-channel assertions at all three CSV doors (including `validate_import` answering `ok:true`
  for a converted file — without it the notices-into-`errors` plumbing is one refactor away from
  blocking every converted file), that `notices` is declared on `ImportFileReport` itself, and the
  client half by source at BOTH surfaces (the report panel's notice block never feeds the error
  container; the controller keeps the preview's notices and its `render` puts them in the panel
  outside that container). 24 tests, 0 failures (measured 2026-08-27 against the final tree).
- `test/unit/import_csv.test.ts`, `test/unit/import_csv_execute.test.ts`,
  `test/unit/tool_import_dedalo_csv.test.ts`, `test/unit/tool_import_marc21.test.ts`,
  `test/unit/marc21.test.ts`, `test/unit/marc21_map.test.ts`, `test/unit/import_conform.test.ts`,
  `test/unit/import_data.test.ts`, `test/unit/import_drive.test.ts`,
  `test/unit/import_execute_refusal.test.ts` — the ten pre-existing gates over this door,
  unchanged and green: 123 tests, 0 failures (re-measured 2026-08-27 against the final tree, after
  the MARC id refusal landed — `marc21_map.test.ts` pins the create-on-foreign-id behaviour that
  refusal deliberately leaves alone; the two new gates add 54 + 24).

**Fixture interaction (DEC-14b): NO re-harvest.** The frozen oracle store captures read-path API
responses; no fixture in `test/parity/fixtures/oracle_harvest/` carries a request whose action is
`import_files` or `get_csv_files` (verified by walking every fixture's `action`/`dd_api` keys:
0 hits). The tool NAMES appear there only inside tool-registry payloads, which are untouched.

## Still open (named here so it is not mistaken for covered)

- `tools/tool_import_zotero/server/index.ts` still reads its RDF/XML upload with
  `Bun.file().text()` (DATA-09's second door). It is listed, with this reason, in the shrink-only
  `IMPLICIT_DECODE_EXEMPT` map of `ingest_encoding_tripwire`.
- `src/diffusion/writers/csv.ts` deliberately emits no BOM (its own gate pins that); whether a
  PUBLISHED csv should carry one is a diffusion-contract decision, listed in the same gate's
  shrink-only `BOM_EXEMPT` map. It is a PUBLISHED artifact consumed by harvesters, not a file a
  curator saves over in a spreadsheet, so it is not the DATA-09 round trip.
- The redundant `ImportFileReportWithNotices` extension (`src/core/tools/import_csv_execute.ts`)
  and its one annotation in `tools/tool_import_dedalo_csv/server/index.ts`: a name to delete now
  that the field is on `ImportFileReport`, left because both files were outside the edit set that
  moved it. It cannot drift (`tsc` refuses an incompatible redeclaration in an extending
  interface — verified by making one), so this is tidying, not a second contract.
- One leaf module for `phpTrim` and for `parseRecordIdCell`, so each law has ONE implementation
  instead of two pinned copies (the `src/core/db/sql_identifier.ts` precedent). Both pins are
  execution-held today; neither is silent if it breaks.
- `docs/development/tools/reference/tool_import_marc21.md` describes `field_to_section_id` as
  "used to identify a record for update vs. create" — still true, but it does not yet say that a
  value the old reader would have turned into a record is now REFUSED by name, nor that a foreign
  control number still means "create". Outside this round's edit set.

## Addendum 2026-11-18 — a `section_id` above the highest record number SKIPS ITS ROW (owner ruling)

Point 3 above covered a cell that is not a record id. One population slipped between it and the
database: a digit run that IS an exact integer but lies above int4 (`2147483648` …
`9007199254740991`). `parseRecordIdCell` accepts it (it is a run of digits and a safe integer),
so it reached the file's one existing-id read as written, and Postgres refused the cast.

- **Before:** `files[].ok: false`, `created`/`updated`/`failed` empty, `errors: ['value
  "2147483648" is out of range for type integer']` — the WHOLE FILE failed, also the rows before
  and after the offending one, and the sentence the operator read was the database's own.
- **Now** (owner ruling 2026-11-18): the row is SKIPPED by the same mechanism as point 3, with its
  own sentence naming the row, the value and the limit —
  `Row 3: SKIPPED — the section_id cell is '2147483648', which is above the highest record number (2147483647)`
  — in `files[].errors`; `ok` stays `true`; every other row of the file is imported.
  `validate_import` reports the row in `failed[]` (`the row would be SKIPPED — …`, `ok: false`,
  `ready: false`) before anything is written. `2147483647` itself is a record number.
- **No new key, no error code, no notice.** The line rides the existing `errors: string[]`, as the
  DATA-22 line does; the envelope is unchanged.
- **CSV's own.** The bound sits in the CSV planner's key resolution (`resolveRowKey`,
  `src/core/tools/import_csv.ts`), not in `parseRecordIdCell` or `readExistingSectionIds`. The
  Zotero import keeps its own limit rule, code (`tool.zotero_call_number_above_limit`) and notice
  (WC-2026-11-12-zotero-csl-json-import); no Zotero wording or code appears on the CSV wire.

**Gate:** `test/unit/import_csv_execute.test.ts` — the row skip (rows on both sides written,
nothing written for the over-limit row, no database text in the report), the preflight line, and
the exact bound in the planner. It replaces the test that pinned the previous outcome as a known
defect awaiting this ruling. RED before; mutations red: `>` → `>=`, the bound one higher, the
DATA-22 sentence reused, a file failure instead of the row skip.

**Still open (measured 2026-11-18, not ruled):** an id above int4 INSIDE a cell — a relation
locator's `section_id`, a `component_iri` item's `label_id` — rolls its row back as
`failed[].msg: 'IGNORED: the row was rolled back — value "2147483648" is out of range for type
integer'`. The row outcome is already per-row; the sentence is still the database's.
