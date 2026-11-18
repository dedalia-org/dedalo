/**
 * CSV import PLANNER (PHP tool_import_dedalo_csv::import_dedalo_csv_file, the
 * read half). Parses a CSV and, against a resolved column map, produces a
 * per-record PLAN of conformed component values.
 *
 * The plan is DB-free apart from the conform facets' own ontology lookups, so
 * the row→column→conform mapping is testable without a write, and the executor
 * (import_csv_execute.ts) is a pure "apply the plan" step.
 */

import { INT4_MAX } from '../concepts/section_id.ts';
import { DedaloError } from '../errors/index.ts';
import { type ConformResult, conformImportData, unwrapDedaloData } from './import_data.ts';

/**
 * PHP's `trim()` charlist — " \t\n\r\0\x0B" — NOT JavaScript's String.trim().
 *
 * WHY THE DIFFERENCE MATTERS (DATA-04 class): JS trims every Unicode space, so a
 * heritage value stored as U+00A0 followed by "Alfonso" (NBSP, what a paste out of Word
 * produces) or one carrying a stray U+FEFF loses that character silently. The
 * frozen reader trimmed exactly these six ASCII characters and nothing else.
 *
 * SECOND IMPLEMENTATION OF ONE LAW, ON PURPOSE — and it cannot be shared today.
 * `src/diffusion/parsers/php_string.ts` exports the same function with the same
 * charlist, but importing it here would be a NEW non-facade core -> diffusion
 * edge, which `test/unit/boundary_seam_tripwire.test.ts` refuses (the direction
 * is diffusion -> core, and only the `src/diffusion/api/` facade may grow). The
 * durable fix is the `src/core/db/sql_identifier.ts` precedent: MOVE the leaf
 * module into core and let diffusion import it downhill — a change to four files
 * outside this one. Until then the two copies are pinned EQUAL by a differential
 * over the whole charlist plus a random corpus, in
 * `test/unit/csv_parser_conformance_native.test.ts` ("one law, two
 * implementations"), so they cannot drift unnoticed.
 */
export function phpTrim(value: string): string {
	const trimmable = (ch: string | undefined): boolean =>
		ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\0' || ch === '\v';
	let start = 0;
	let end = value.length;
	while (start < end && trimmable(value[start])) start++;
	while (end > start && trimmable(value[end - 1])) end--;
	return value.slice(start, end);
}

/** parseCsvDetailed's answer: the rows plus the ONE structural defect a reader can see. */
export interface CsvParseResult {
	rows: string[][];
	/**
	 * 1-based row number (the header is row 1) of a field that OPENED an enclosure
	 * and never closed it, so everything to EOF was absorbed into that one cell.
	 * The frozen fgetcsv absorbs it too — this records it so the ingest door can
	 * refuse instead of importing the file tail as a record value.
	 */
	unterminatedEnclosureRow: number | null;
}

/**
 * Parse CSV text into rows of cells — a byte-faithful port of the frozen
 * `tool_common::read_csv_file_as_array` (fgetcsv($f, 0, ';', '"', '"') + the BOM
 * strip on row 1 + trim() on every cell), whose behaviour at the positions
 * RFC-4180 leaves undefined was MEASURED on PHP 8.5.4 and is pinned by
 * `test/unit/csv_parser_conformance_native.test.ts`.
 *
 * DATA-04 (2026-08-26 audit), the defect this replaces: the previous reader
 * entered enclosure mode on a `"` found ANYWHERE in a field. `12" disc` swallowed
 * the delimiter, the row terminator and the whole remainder of the file into one
 * cell; `Alfonso X "el Sabio"` parsed with the right row and column count and
 * simply DELETED the quote characters from the stored value. fgetcsv does
 * neither: an enclosure is only an enclosure at the START of a field.
 *
 * The rules, each one measured against fgetcsv and not inferred:
 *  - a field is ENCLOSED only when its first non-blank character is `"` (leading
 *    spaces/tabs before it are consumed, PHP's php_fgetcsv skips them);
 *  - inside an enclosure `""` is a literal `"`, and the delimiter, LF and CR are
 *    data — CR is kept verbatim, never folded into LF;
 *  - the first `"` that is not doubled CLOSES the enclosure, and whatever follows
 *    up to the delimiter/terminator is appended literally (`"q"tail` → `qtail`);
 *  - a `"` anywhere else is ordinary data (`12" disc`, `Alfonso X "el Sabio"`);
 *  - the row terminator is LF; a lone CR is DATA (the frozen reader read lines by
 *    LF, so an old-Mac file is one giant row — which the door then refuses);
 *  - an enclosure open at EOF absorbs the rest of the file (recorded, see above);
 *  - every cell is phpTrim'd, and a leading BOM is stripped from row 1's cells.
 */
/** php_fgetcsv skips isspace() before a possible enclosure — LF excepted: it reads by line. */
function isEnclosureBlank(ch: string | undefined): boolean {
	return ch === ' ' || ch === '\t' || ch === '\r' || ch === '\v' || ch === '\f';
}

/** An ENCLOSED field's body, read from `start` (the index AFTER the opening quote). */
interface EnclosedField {
	value: string;
	/** Index just past the closing quote, or the end of the text when none closed it. */
	next: number;
	/** False = the enclosure ran to EOF, absorbing the rest of the file (fgetcsv does too). */
	closed: boolean;
}

/** Read an enclosed field: `""` is a literal quote, the first single `"` closes. */
function readEnclosedField(text: string, start: number): EnclosedField {
	let value = '';
	let i = start;
	while (i < text.length) {
		if (text[i] !== '"') {
			value += text[i];
			i += 1;
			continue;
		}
		if (text[i + 1] === '"') {
			value += '"';
			i += 2;
			continue;
		}
		return { value, next: i + 1, closed: true };
	}
	return { value, next: i, closed: false };
}

/**
 * The frozen reader's per-cell normalisation, in PHP's order: strip a leading BOM
 * from the cells of the FIRST row only (preg_replace("/^$bom/") when $i===0), then
 * trim every cell with PHP's charlist.
 */
function normalizeCsvCells(rows: string[][]): void {
	const first = rows[0];
	for (let c = 0; c < (first?.length ?? 0); c++) {
		const cell = (first as string[])[c] as string;
		if (cell.startsWith('\uFEFF')) (first as string[])[c] = cell.slice(1);
	}
	for (const row of rows) {
		for (let c = 0; c < row.length; c++) row[c] = phpTrim(row[c] as string);
	}
}

export function parseCsvDetailed(text: string, delimiter = ';'): CsvParseResult {
	const rows: string[][] = [];
	let row: string[] = [];
	let field = '';
	let i = 0;
	let unterminatedEnclosureRow: number | null = null;
	// A field was started and not yet terminated. `"` alone is a whole file to
	// fgetcsv (one row, one empty cell), which "did we accumulate anything?"
	// cannot see — measured by the PHP differential, 2026-08-27.
	let pendingField = false;
	const pushField = (): void => {
		row.push(field);
		field = '';
	};
	const pushRow = (): void => {
		pushField();
		rows.push(row);
		row = [];
		pendingField = false;
	};
	while (i < text.length) {
		// --- one field ---------------------------------------------------------
		// Enclosure detection happens ONLY here, at the field's start (after the
		// blanks fgetcsv skips) — that single rule is the whole DATA-04 fix.
		pendingField = true;
		let lookahead = i;
		while (isEnclosureBlank(text[lookahead])) lookahead++;
		if (text[lookahead] === '"') {
			const enclosed = readEnclosedField(text, lookahead + 1);
			field += enclosed.value;
			i = enclosed.next;
			if (!enclosed.closed) unterminatedEnclosureRow ??= rows.length + 1;
		}
		// The unenclosed body — also the tail after a closing quote.
		while (i < text.length && text[i] !== delimiter && text[i] !== '\n') {
			field += text[i];
			i += 1;
		}
		if (text[i] === undefined) break; // EOF inside the last field
		if (text[i] === delimiter) pushField();
		else pushRow();
		i += 1;
	}
	// Flush the field the file ended inside (never after a bare row terminator).
	if (pendingField) pushRow();
	normalizeCsvCells(rows);
	return { rows, unterminatedEnclosureRow };
}

/** parseCsvDetailed's rows (the shape every caller but the ingest door wants). */
export function parseCsv(text: string, delimiter = ';'): string[][] {
	return parseCsvDetailed(text, delimiter).rows;
}

/** The door's refusal: the file name is the caller's own upload and the sentence is
 * the operator's repair instruction — nothing else of the file is disclosed. */
function refuseCsv(sentence: string): never {
	throw new DedaloError('request.invalid_data', {
		message: sentence,
		publicMessage: sentence,
	});
}

/**
 * REFUSE a structurally broken CSV at the ingest door — the deliberate divergence
 * from the frozen reader (WC-2026-08-27-csv-ingest-refusals).
 *
 * fgetcsv imported both of these silently: an unterminated enclosure collapsed
 * the file tail into one cell (and every record after it was simply never
 * imported), and a ragged row shifted every value one column to the left, so the
 * importer wrote each cell into the WRONG component. Both are indistinguishable
 * from a correct import in the report. A file whose shape we cannot trust is not
 * imported at all: the operator fixes the file, which is the only outcome that
 * cannot corrupt a record.
 *
 * A row that is entirely empty is a BLANK LINE, not a width violation: PHP
 * returned it as a one-empty-cell row and the executor skips it (no section_id)
 * with a per-row line in the report. Refusing a file for a trailing blank line
 * would refuse most real files.
 */
/** The first data row whose width disagrees with the header, or null. */
function findWidthMismatch(rows: readonly string[][]): { row: number; width: number } | null {
	const headerWidth = rows[0]?.length ?? 0;
	for (let r = 1; r < rows.length; r++) {
		const current = rows[r] as string[];
		// A wholly empty row is a BLANK LINE, not a width violation.
		if (current.length !== headerWidth && !current.every(isEmptyCell)) {
			return { row: r + 1, width: current.length };
		}
	}
	return null;
}

function isEmptyCell(cell: string): boolean {
	return cell === '';
}

export function assertCsvStructure(result: CsvParseResult, fileName: string): void {
	if (result.unterminatedEnclosureRow !== null) {
		refuseCsv(
			`${fileName}: row ${result.unterminatedEnclosureRow} opens a quoted field that is never closed, so the rest of the file was read as ONE value. Nothing was imported — fix the quoting and upload it again.`,
		);
	}
	const mismatch = findWidthMismatch(result.rows);
	if (mismatch !== null) {
		refuseCsv(
			`${fileName}: row ${mismatch.row} has ${mismatch.width} columns but the header has ${result.rows[0]?.length ?? 0}. Every value after the mismatch would be imported into the wrong component, so nothing was imported.`,
		);
	}
}

/** Un-escape a literal ';' stored as U+003B (the CSV field-escape, PHP parity). */
export function unescapeCell(value: string): string {
	return value.replaceAll('U+003B', ';');
}

/** The per-file column analysis get_csv_files renders (minus the ontology column map). */
export interface CsvAnalysis {
	header: string[];
	n_records: number;
	n_columns: number;
	sample_data: string[][];
	sample_data_errors: string[][];
}

/**
 * The CSV ingest ceiling, in BYTES on disk (T1-S18; value from DOS-04, 2026-07-28).
 * ONE law for every CSV door — process_uploaded_file refuses a staged file over
 * it, and get_csv_files / validate_import / import_files read through
 * `readIngestTextFile(path, label, CSV_INGEST_MAX_BYTES)`, which refuses before
 * buffering — so a file that previews will import and one refused at import is
 * refused at preview. Measured on Bun 1.4 (parseCsvDetailed): ~35.5× the source
 * bytes in RSS (64 MB → +2.27 GB, 1.1 s), plus ~650 ms to structured-clone the
 * full row set back to the main thread at the import door. The durable answer to
 * that profile is a streaming parse, not this number.
 */
export const CSV_INGEST_MAX_BYTES = 64 * 1024 * 1024;

/**
 * Compute the get_csv_files summary from CSV text — pure and CPU-bound, so it runs
 * OFF the serving event loop in csv_worker.ts (audit S3-42). Returns only the header
 * + counts + a bounded preview + the malformed-JSON-cell rows, NOT the full row set,
 * so the worker→main structured clone stays tiny. Returns null for an
 * empty/headerless file (caller ledgers the read error). The text is already
 * bounded: the read door refused anything over CSV_INGEST_MAX_BYTES before a byte
 * was buffered (decoded code units never exceed the bytes they came from).
 *
 * `sample_data` and `sample_data_errors` cover DATA rows only — never the header
 * (row 0, which travels as `header`). The mapper's "Sample data" cell shows the
 * first non-empty value per column from `sample_data`, so a preview that began
 * with the header showed every column's own name as its sample (PHP skipped
 * row 0 too). A header cell is a column name, not a value: it is never
 * JSON-checked either.
 */
export function analyzeCsv(text: string, delimiter?: string): CsvAnalysis | null {
	const rows = parseCsv(text, delimiter);
	const header = rows[0];
	if (header === undefined || header.length === 0) return null;
	// Up to 10 DATA rows (row 0 is the header — see the docblock).
	const dataRows = rows.slice(1);
	const sample_data = dataRows.slice(0, 10).map((row) => row.map(unescapeCell));
	// The preview of malformed-JSON rows is a SAMPLE, not the full set — cap it
	// (the docblock promised "bounded" but it collected EVERY bad row, so a file
	// of all-malformed rows returned the whole file to the client, DOS-04).
	const SAMPLE_ERROR_CAP = 100;
	const sample_data_errors: string[][] = [];
	for (const line of dataRows) {
		if (sample_data_errors.length >= SAMPLE_ERROR_CAP) break;
		let bad = false;
		for (const raw of line) {
			const value = unescapeCell(raw);
			if (value === '' || (!value.startsWith('[') && !value.startsWith('{'))) continue;
			try {
				JSON.parse(value);
			} catch {
				bad = true;
				break;
			}
		}
		if (bad) sample_data_errors.push(line);
	}
	return {
		header,
		n_records: Math.max(0, rows.length - 1),
		n_columns: header.length,
		sample_data,
		sample_data_errors,
	};
}

/**
 * A column's CSV-import write mode (wire `ar_columns_map[i].import_mode`):
 * 'replace' (the default — the cell REPLACES the component's data, an empty
 * cell clears it) or 'append' (the cell's items are ADDED to the stored ones
 * per the model's registry `importAppend` policy; an empty cell is a no-op).
 * The tool server refuses append for refuse-policy models, the section_id key
 * and the audit tipos BEFORE any write; this layer only carries the choice.
 */
export type ImportMode = 'replace' | 'append';

/** A resolved CSV column → its target component (null = header not matched, skip). */
export interface CsvColumn {
	tipo: string;
	model: string;
	/**
	 * The tipo whose slot holds the DATA, when it differs from `tipo`: the
	 * alias TARGET of a component_alias (ontology/alias.ts resolveDataTipo).
	 * Absent = `tipo`. `tipo` stays the alias (conform + save read its merged
	 * properties; the save hops itself), but stored items, the item-id
	 * counter and frame `main_component_tipo` all name the data tipo.
	 */
	dataTipo?: string;
	/** The raw header string (may carry a suffix like tipo_dmy / tipo_sectiontipo). */
	columnName: string;
	/** The component's save lang, resolved from the ontology `translatable` flag. */
	lang: string;
	/** The column map's decimal separator (component_number). */
	decimal?: string;
	/** The column's write mode; absent = 'replace'. */
	mode?: ImportMode;
}

export interface PlannedColumn {
	tipo: string;
	/** CsvColumn.dataTipo, carried (absent = `tipo`). */
	dataTipo?: string;
	model: string;
	/** The component's save lang ('lg-nolan' when not translatable). */
	lang: string;
	conform: ConformResult;
	/** Frames from a LEGACY {data, dataframe} envelope — written after the component data.
	 * Current exports give each dataframe slot its own column, so this is null there. */
	dataframe: unknown[] | null;
	/** False when the envelope carried ONLY frames: do not touch the component's data. */
	hasData: boolean;
	/** The column's write mode (CsvColumn.mode, defaulted to 'replace'). */
	mode: ImportMode;
}

export interface PlannedRecord {
	/** section_id from the section_id column (match/update), or null (skip the row). */
	sectionId: number | null;
	/**
	 * Why this row's key is unusable, when it was present but not a record id
	 * (DATA-22). Null for a clean id AND for an empty cell — an empty key is the
	 * documented "no record to match" case, not a malformed one.
	 */
	keyError: string | null;
	/** 1-based CSV row number (the header is row 1) — for "go look at line N". */
	row: number;
	columns: PlannedColumn[];
}

/**
 * Build the import plan from data rows + a column map aligned to the columns.
 * The section_id column is the record KEY: it is used for matching and never
 * conformed or written (PHP keeps it a plain int).
 */
/** A row's record key: the id to match, or why the cell could not name one. */
interface ResolvedRowKey {
	sectionId: number | null;
	keyError: string | null;
}

function keyColumnIndex(columns: readonly (CsvColumn | null)[]): number {
	for (let c = 0; c < columns.length; c++) {
		if (columns[c]?.model === 'component_section_id') return c;
	}
	return -1;
}

/**
 * THE RECORD-ID GRAMMAR every import door reads a key with.
 *
 * DATA-22: this read `Number.parseInt`, which STOPS at the first non-digit — so
 * '12abc' resolved to record 12 and the row was written into a record the
 * operator never named (PHP's `(int)` cast guessed the same way). A key we
 * cannot read is REFUSED, per row, in the report. An EMPTY cell is not an
 * error — it has always meant "no record to match", and the executor skips the
 * row.
 *
 * THE RESIDUAL (measured 2026-08-27): the first fix read the cell with strict
 * `Number()`, which refuses '12abc' but is a NUMERIC-LITERAL reader, not an id
 * reader — `Number('0x10')` is 16, `'0b101'` is 5, `'0o17'` is 15, `'1e3'` is
 * 1000, `'+12'` is 12 and `'12.'` is 12. Every one of those is a safe integer
 * greater than zero, so every one silently resolved to A RECORD THE OPERATOR
 * NEVER NAMED — the exact defect DATA-22 is about, one guess further out.
 *
 * A record id in a CSV cell is A RUN OF DECIMAL DIGITS. Accept that grammar and
 * refuse everything else: the id is then the cell, never an interpretation of
 * it. (Leading zeros still resolve — '007' is 7, which the digits grammar reads
 * unambiguously and the frozen `(int)` cast read the same way.)
 */
const RECORD_ID_CELL = /^[0-9]+$/;

/**
 * The record id an imported cell names, or null when it names none.
 *
 * ONE LAW, TWO DOORS. `src/core/tools/marc21.ts` resolves `field_to_section_id`
 * with the same grammar — it had the identical `Number.parseInt` defect ('12abc'
 * → record 12) — and carries its own four-line copy rather than an import: that
 * module is a leaf parser whose only dependency is the error registry, and this
 * one pulls the conform facets, the ontology resolver and the config layer
 * behind them. The copies are held equal by EXECUTION (see the differential in
 * `test/unit/csv_parser_conformance_native.test.ts`), and the durable fix is one
 * leaf module both doors import — the same standing debt `phpTrim` above has.
 *
 * The cell must arrive TRIMMED: whitespace is the caller's own format (the CSV
 * door trims with PHP's charlist, the MARC door with the subfield's), never part
 * of the id.
 */
export function parseRecordIdCell(cell: string): number | null {
	// Grammar FIRST, arithmetic second: isSafeInteger still guards a digit run
	// too long to be an exact JS integer.
	const parsed = Number(cell);
	if (RECORD_ID_CELL.test(cell) && Number.isSafeInteger(parsed) && parsed > 0) return parsed;
	return null;
}

/** Resolve the section_id column of one row (the grammar above, PHP-trimmed). */
function resolveRowKey(
	row: readonly string[],
	columns: readonly (CsvColumn | null)[],
): ResolvedRowKey {
	const column = keyColumnIndex(columns);
	const raw = column === -1 ? '' : phpTrim(row[column] ?? '');
	if (raw === '') return { sectionId: null, keyError: null };
	const sectionId = parseRecordIdCell(raw);
	if (sectionId !== null && sectionId <= INT4_MAX) return { sectionId, keyError: null };
	return { sectionId: null, keyError: unusableKeySentence(raw, sectionId) };
}

/**
 * Why a present `section_id` cell names no record — the row's own sentence.
 *
 * THE HIGHEST RECORD NUMBER (owner ruling 2026-11-18). A digit run that IS an
 * exact integer (`parsed` not null) but lies above the `section_id` columns'
 * range names no record the database can hold. It used to reach the
 * existing-id read as written and fail the WHOLE FILE with the database's own
 * range message; it is this row's refusal, with its own sentence (the value and
 * the limit), and the rest of the file imports. The bound lives on the CSV
 * column's key (resolveRowKey), not in `parseRecordIdCell`: the grammar stays
 * the grammar, and the Zotero door keeps its own limit rule and code
 * (zotero_map.ts).
 */
function unusableKeySentence(raw: string, parsed: number | null): string {
	return parsed === null
		? `the section_id cell is '${raw}', which is not a record id`
		: `the section_id cell is '${raw}', which is above the highest record number (${INT4_MAX})`;
}

export async function planCsvImport(
	dataRows: readonly string[][],
	columns: readonly (CsvColumn | null)[],
	/** The section being imported INTO (relation columns resolve their targets against it). */
	sectionTipo: string,
	/** The CSV row number of dataRows[0] (the header is 1, so data starts at 2). */
	firstRowNumber = 2,
): Promise<PlannedRecord[]> {
	const plan: PlannedRecord[] = [];
	for (const [rowIndex, row] of dataRows.entries()) {
		// The key first: every conform reports its issues against this section_id,
		// so it must be known before any cell of the row is conformed.
		const { sectionId, keyError } = resolveRowKey(row, columns);
		const plannedColumns: PlannedColumn[] = [];

		for (let c = 0; c < columns.length; c++) {
			const column = columns[c];
			if (column == null || column.model === 'component_section_id') continue;
			// The cell: PHP trims and un-escapes the ';' placeholder before anything else.
			// phpTrim, not String.trim: the reader already trimmed exactly what PHP
			// trimmed, and JS's would go on to eat an NBSP the value legitimately holds.
			const cell = unescapeCell(phpTrim(row[c] ?? ''));
			const unwrapped = unwrapDedaloData(cell);
			const conform = await conformImportData({
				model: column.model,
				importValue: unwrapped.value,
				columnName: column.columnName,
				sectionTipo,
				sectionId: sectionId ?? 0,
				componentTipo: column.tipo,
				lang: column.lang,
				wrapped: unwrapped.wrapped,
				decimal: column.decimal,
			});
			plannedColumns.push({
				tipo: column.tipo,
				...(column.dataTipo !== undefined ? { dataTipo: column.dataTipo } : {}),
				model: column.model,
				lang: column.lang,
				conform,
				dataframe: unwrapped.dataframe,
				hasData: unwrapped.hasData,
				mode: column.mode ?? 'replace',
			});
		}
		plan.push({ sectionId, keyError, row: firstRowNumber + rowIndex, columns: plannedColumns });
	}
	return plan;
}
