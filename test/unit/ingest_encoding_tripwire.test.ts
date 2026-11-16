/**
 * INGEST ENCODING TRIPWIRE (DATA-09, audit 2026-08-26).
 *
 * Every door that reads an uploaded file used to decode it with
 * `await Bun.file(path).text()` — a UTF-8 decode with `fatal:false`. Any byte
 * that is not valid UTF-8 becomes U+FFFD, irreversibly, with no error, no
 * warning and no notice, and the replacement characters are written into the
 * records with a green file report. The frozen PHP did the opposite
 * deliberately (`mb_check_encoding` + `mb_convert_encoding`), and our own export
 * half manufactured the input that breaks it: a BOM-less CSV download, which
 * Excel opens in the system ANSI code page and saves back as CP1252.
 *
 * THE INVARIANT, in two halves:
 *
 *   READ  — no ingest door decodes bytes implicitly. It either routes through
 *           `src/core/tools/ingest_encoding.ts` (convert, with a notice the
 *           operator reads, or refuse) or it reads BYTES and the parser it hands
 *           them to makes the encoding decision explicitly (MARC21's leader
 *           position 09). Never U+FFFD.
 *   WRITE — every export writer that produces a delimited file a curator opens
 *           in a spreadsheet emits a UTF-8 BOM, so the round trip that starts at
 *           our download does not come back as CP1252.
 *   TELL  — a conversion REACHES THE OPERATOR, and never as a failure. It rides
 *           `notices`, which is a field of the wire report itself (not a side
 *           type), and the panel renders it as report text at both the places an
 *           operator meets the file: the mapper preview (whose sample values ARE
 *           the converted text) and the final report. Both halves are pinned by
 *           source, because the defect they answer to was a composition one —
 *           the notice was pushed into `errors`, which the panel paints red.
 *
 * CENSUS: TOTAL, and DERIVED, not from a hand list. The door list is every
 * `Bun.file(...).text()` under `tools/` and `src/core/tools/`. The WRITER list is
 * the export writer REGISTRY (tools/tool_export/server/writers/index.ts
 * EXPORT_WRITERS): every registered format whose served type is delimited text
 * is BUILT through the real door (`buildArtifactFile`) and its first bytes are
 * read (since 2026-09 the server builds every download; the browser builds
 * none). A new door or a new writer joins the census by existing. The client
 * half is the converse: no hand-written client/tool JS builds a delimited
 * download itself (a data: URI or Blob of text/csv|tsv) — that census must stay
 * EMPTY, because such a file would bypass the registry's BOM and formula rule.
 * The two EXEMPTION maps are shrink-only and each entry carries the finding it
 * answers to; an exemption for a file that no longer needs one FAILS, so they
 * cannot rot.
 *
 * TIER: needs the suite DB (the CSV doors are driven for real, end to end).
 */

import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { Glob } from 'bun';
import { config } from '../../src/config/config.ts';
import { sql } from '../../src/core/db/postgres.ts';
import { resolvePrincipal } from '../../src/core/security/permissions.ts';
import type { ImportFileReport } from '../../src/core/tools/import_wire.ts';
import { decodeIngestBytes } from '../../src/core/tools/ingest_encoding.ts';
import { getLoadedTool } from '../../src/core/tools/loader.ts';
import { parseMarc } from '../../src/core/tools/marc21.ts';
import { type ExportFormat, FORMAT_SPECS } from '../../tools/tool_export/server/artifact_store.ts';
import { EXPORT_WRITERS } from '../../tools/tool_export/server/writers/index.ts';
import { mustGet } from '../helpers/assert.ts';
import {
	buildExportBytes,
	endedExportJob,
	scratchExportStore,
	singleColumnExport,
} from '../helpers/export_writer_fixture.ts';
import { stripComments } from '../helpers/strip_comments.ts';

const REPO_ROOT = join(import.meta.dir, '..', '..');

function read(file: string): string {
	return readFileSync(join(REPO_ROOT, file), 'utf-8');
}

function sourceFiles(dirs: readonly string[], extension: string): string[] {
	const files: string[] = [];
	for (const dir of dirs) {
		for (const match of new Glob(`**/*.${extension}`).scanSync({ cwd: join(REPO_ROOT, dir) })) {
			if (match.endsWith('.test.ts') || match.includes('node_modules')) continue;
			files.push(relative(REPO_ROOT, join(REPO_ROOT, dir, match)));
		}
	}
	return files.sort();
}

// ---------------------------------------------------------------------------
// 1. The decoder itself: convert or refuse, never substitute.
// ---------------------------------------------------------------------------

describe('decodeIngestBytes — convert or refuse, never U+FFFD', () => {
	const cp1252 = new Uint8Array([
		0x52, 0x69, 0x70, 0x6f, 0x6c, 0x6c, 0xe8, 0x73, 0x3b, 0x4d, 0x6f, 0x6e, 0x65, 0x64, 0x61, 0x20,
		0x69, 0x62, 0xe9, 0x72, 0x69, 0x63, 0x61,
	]);

	test('CP1252 bytes are CONVERTED and the operator is told', () => {
		const decoded = decodeIngestBytes(cp1252, 'legacy.csv');
		expect(decoded.text).toBe('Ripollès;Moneda ibérica');
		expect(decoded.encoding).toBe('windows-1252');
		expect(decoded.converted).toBe(true);
		expect(decoded.notice).toContain('windows-1252');
		expect(decoded.text).not.toContain('�');
	});

	test('UTF-8 stays UTF-8, with no notice and its BOM removed', () => {
		const utf8 = new TextEncoder().encode('Ripollès;Moneda ibérica');
		const plain = decodeIngestBytes(utf8, 'good.csv');
		expect(plain.text).toBe('Ripollès;Moneda ibérica');
		expect(plain.converted).toBe(false);
		expect(plain.notice).toBeNull();
		const withBom = decodeIngestBytes(
			new Uint8Array([0xef, 0xbb, 0xbf, ...utf8]),
			'excel_saved.csv',
		);
		expect(withBom.text).toBe('Ripollès;Moneda ibérica');
		expect(withBom.encoding).toBe('utf-8');
	});

	test('UTF-16 with a BOM is converted', () => {
		const utf16le = new Uint8Array([0xff, 0xfe, 0x61, 0x00, 0x3b, 0x00, 0x62, 0x00]);
		const decoded = decodeIngestBytes(utf16le, 'utf16.csv');
		expect(decoded.text).toBe('a;b');
		expect(decoded.encoding).toBe('utf-16le');
		expect(decoded.converted).toBe(true);
	});

	test('a file we cannot honestly convert is REFUSED, loudly, by name', () => {
		// UTF-16 without a BOM: valid UTF-8 as far as the decoder is concerned,
		// and pure garbage as data. It must never reach a record.
		const utf16NoBom = new Uint8Array([0x61, 0x00, 0x3b, 0x00, 0x62, 0x00]);
		expect(() => decodeIngestBytes(utf16NoBom, 'silent.csv')).toThrow(/silent\.csv/);
		expect(() => decodeIngestBytes(utf16NoBom, 'silent.csv')).toThrow(/NUL/);
	});

	test('a file that ALREADY carries U+FFFD is refused, and the sentence says so', () => {
		// Valid UTF-8 — so this is not "we could not convert it": the damage arrived
		// with the upload, and re-importing it would write that damage into records.
		const damaged = new TextEncoder().encode('Ripoll\uFFFDs;Moneda ib\uFFFDrica');
		expect(() => decodeIngestBytes(damaged, 'already_damaged.csv')).toThrow(
			/already contains replacement characters/,
		);
	});

	test('the whole single-byte range converts without inventing a character', () => {
		const everyByte = new Uint8Array(256).map((_, index) => index).filter((b) => b !== 0);
		const decoded = decodeIngestBytes(everyByte, 'all_bytes.csv');
		expect(decoded.text).not.toContain('�');
		expect(decoded.text.length).toBe(255);
	});
});

// ---------------------------------------------------------------------------
// 2. THE DOOR CENSUS — derived from the tree.
// ---------------------------------------------------------------------------

/**
 * `Bun.file(<anything>).text()` — the implicit fatal:false decode DATA-09 is
 * about. One level of nested parentheses is enough for every real call shape
 * (`Bun.file(resolve(dir, name)).text()`), and the same-line fallback below
 * catches anything the pattern misses.
 */
const IMPLICIT_TEXT_READ = /Bun\.file\((?:[^()]|\([^()]*\))*\)\s*\.text\(\)/;

function implicitTextReadFiles(): string[] {
	const hits: string[] = [];
	for (const file of sourceFiles(['tools', 'src/core/tools'], 'ts')) {
		const source = stripComments(read(file));
		if (IMPLICIT_TEXT_READ.test(source)) hits.push(file);
	}
	return hits;
}

/**
 * SHRINK-ONLY. A door still decoding its upload implicitly, with the finding it
 * answers to. Every entry here is a KNOWN silent-corruption path, not a waiver:
 * removing the last one is the point.
 */
const IMPLICIT_DECODE_EXEMPT: Readonly<Record<string, string>> = {};

describe('door census: no ingest door decodes its upload implicitly', () => {
	test('every implicit-decode door is either fixed or a declared, reasoned exemption', () => {
		const hits = implicitTextReadFiles();
		const unexplained = hits.filter((file) => IMPLICIT_DECODE_EXEMPT[file] === undefined);
		expect(unexplained).toEqual([]);
	});

	test('the exemption list is SHRINK-ONLY: no entry for a door that is already fixed', () => {
		const hits = new Set(implicitTextReadFiles());
		const stale = Object.keys(IMPLICIT_DECODE_EXEMPT).filter((file) => !hits.has(file));
		expect(stale).toEqual([]);
	});

	test('every exemption states the finding it answers to', () => {
		for (const reason of Object.values(IMPLICIT_DECODE_EXEMPT)) {
			expect(reason).toMatch(/DATA-\d\d/);
		}
	});

	test('the CSV door imports the sanctioned decoder (it is the door DATA-09 measured)', () => {
		const door = read('tools/tool_import_dedalo_csv/server/index.ts');
		expect(door).toContain('ingest_encoding.ts');
		expect(IMPLICIT_TEXT_READ.test(stripComments(door))).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// 3. Per-door BEHAVIOUR: non-UTF-8 bytes at each door we own.
// ---------------------------------------------------------------------------

const SECTION = 'test3';
const TEXT = 'test52';
const USER = 987675;
const RECORD_ID = 900743;
const CSV = 'encoding_gate.csv';
const dir = resolve(config.media.rootPath ?? '', 'import/files', String(USER));
const bulkProcessIds: number[] = [];
/** `Ripollès;Moneda ibérica` — the audit's own repro bytes, as CP1252. */
const CP1252_VALUE = new Uint8Array([0x52, 0x69, 0x70, 0x6f, 0x6c, 0x6c, 0xe8, 0x73]);

afterAll(async () => {
	rmSync(dir, { recursive: true, force: true });
	await sql.unsafe('DELETE FROM matrix_test WHERE section_tipo = $1 AND section_id = $2', [
		SECTION,
		RECORD_ID,
	]);
	await sql.unsafe('DELETE FROM matrix_time_machine WHERE section_tipo = $1 AND section_id = $2', [
		SECTION,
		RECORD_ID,
	]);
	for (const id of bulkProcessIds) {
		await sql.unsafe(`DELETE FROM matrix_notes WHERE section_tipo = 'dd800' AND section_id = $1`, [
			id,
		]);
		await sql.unsafe(
			`DELETE FROM matrix_time_machine WHERE section_tipo = 'dd800' AND section_id = $1`,
			[id],
		);
	}
});

/** Stage a CP1252 CSV: `section_id;test52` + one row whose value carries 0xE8. */
function stageCp1252Csv(): void {
	mkdirSync(dir, { recursive: true });
	const header = new TextEncoder().encode(`section_id;${TEXT}\n${RECORD_ID};`);
	const tail = new TextEncoder().encode('\n');
	writeFileSync(resolve(dir, CSV), new Uint8Array([...header, ...CP1252_VALUE, ...tail]));
}

/** The column map every CSV door here is driven with (header: section_id;test52). */
const COLUMNS_MAP = [
	{ tipo: 'section_id', model: 'section_id' },
	{ tipo: TEXT, model: 'component_input_text', checked: true, map_to: TEXT },
];

async function runTool(
	action: 'get_csv_files' | 'import_files' | 'validate_import',
	options: Record<string, unknown>,
): Promise<unknown> {
	const loaded = await getLoadedTool('tool_import_dedalo_csv');
	const res = await mustGet(loaded!.module.apiActions[action], action).handler({
		principal: await resolvePrincipal(-1),
		userId: USER,
		background: false,
		options,
	});
	return res.data;
}

describe('CSV doors: a CP1252 upload converts, is reported, and stores the real value', () => {
	test('get_csv_files (the mapper preview) shows the accented value and says it converted', async () => {
		stageCp1252Csv();
		const data = (await runTool('get_csv_files', {})) as {
			files: { name: string; sample_data: string[][] }[];
			errors: string[];
			notices: string[];
		};
		const file = data.files.find((current) => current.name === CSV);
		expect(file).toBeDefined();
		expect(JSON.stringify(file?.sample_data)).toContain('Ripollès');
		expect(JSON.stringify(file?.sample_data)).not.toContain('�');
		// A CONVERSION IS A NOTICE, NEVER AN ERROR: the panel paints `errors` red,
		// and an intended, successful conversion is not a failed read.
		expect(data.notices.join(' ')).toContain('windows-1252');
		// `errors` here is the whole DIRECTORY's read-problem list, so the assertion
		// is the invariant, not an empty list: no conversion is filed as an error.
		expect(data.errors.join(' ')).not.toContain('windows-1252');
	});

	test('import_files stores `Ripollès`, not `Ripoll<FFFD>s`', async () => {
		stageCp1252Csv();
		const data = (await runTool('import_files', {
			time_machine_save: false,
			files: [
				{
					file: CSV,
					section_tipo: SECTION,
					bulk_process_label: 'encoding gate',
					ar_columns_map: COLUMNS_MAP,
				},
			],
		})) as { files: ImportFileReport[] };
		const report = data.files[0] as ImportFileReport;
		if (report.bulk_process_id !== null) bulkProcessIds.push(report.bulk_process_id);
		expect(report.failed).toEqual([]);
		// The conversion is REPORTED — a converted file is never a silent one — in
		// the NOTICE channel, so the panel does not paint a good import red.
		expect(report.notices.join(' ')).toContain('windows-1252');
		expect(report.errors).toEqual([]);

		const rows = (await sql.unsafe(
			`SELECT string -> '${TEXT}' AS value FROM matrix_test WHERE section_tipo = $1 AND section_id = $2`,
			[SECTION, RECORD_ID],
		)) as { value: { value?: string }[] | null }[];
		expect(rows[0]?.value?.[0]?.value).toBe('Ripollès');
	});

	/**
	 * THE PREFLIGHT VERDICT — the gate that pins "converted, not blocked".
	 *
	 * validate_import computes `ok` from its `errors` list, and the encoding notice
	 * used to be pushed INTO that list. It happens to have been placed after the
	 * verdict was computed, so it did not block — which means one refactor (or one
	 * `errors` merge, exactly what the report half was doing) turns every converted
	 * file into a failed validation, telling the operator to repair a file that is
	 * already importable. Nothing else in the tree would have noticed: the
	 * conversion tests above assert the VALUE, never the verdict.
	 */
	test('validate_import ACCEPTS a converted file and reports the conversion', async () => {
		stageCp1252Csv();
		const data = (await runTool('validate_import', {
			files: [{ file: CSV, section_tipo: SECTION, ar_columns_map: COLUMNS_MAP }],
		})) as {
			ready: boolean;
			files: { ok: boolean; errors: string[]; notices: string[]; failed: unknown[] }[];
		};
		const file = data.files[0] as {
			ok: boolean;
			errors: string[];
			notices: string[];
			failed: unknown[];
		};
		expect(file.notices.join(' ')).toContain('windows-1252');
		expect(file.errors).toEqual([]);
		expect(file.failed).toEqual([]);
		expect(file.ok).toBe(true);
		expect(data.ready).toBe(true);
	});
});

describe('MARC21 door: the leader decides the encoding, or the record is refused', () => {
	/** Build one ISO 2709 record with a single 245$a field; `scheme` is leader/09. */
	function marcRecord(scheme: string, value: Uint8Array): Uint8Array {
		const body = new Uint8Array([0x20, 0x20, 0x1f, 0x61, ...value, 0x1e]);
		const directory = new TextEncoder().encode(`245${String(body.length).padStart(4, '0')}00000`);
		const baseAddress = 24 + directory.length + 1;
		const length = baseAddress + body.length + 1;
		const leader = new TextEncoder().encode(
			`${String(length).padStart(5, '0')}nam ${scheme}22${String(baseAddress).padStart(5, '0')}n a4500`.slice(
				0,
				24,
			),
		);
		return new Uint8Array([...leader, ...directory, 0x1e, ...body, 0x1d]);
	}

	test('leader/09 = a (Unicode): a UTF-8 record parses', () => {
		const bytes = marcRecord('a', new TextEncoder().encode('Ripollès'));
		const { records, errors } = parseMarc(bytes);
		expect(errors).toEqual([]);
		expect(records[0]?.fields[0]?.subfields?.[0]?.value).toBe('Ripollès');
	});

	test('leader/09 = blank (MARC-8) + non-ASCII bytes: REFUSED, not silently mangled', () => {
		const bytes = marcRecord(' ', CP1252_VALUE);
		const { records, errors } = parseMarc(bytes);
		expect(records).toEqual([]);
		expect(errors.join(' ')).toContain('non-Unicode');
	});

	test('leader/09 = blank + pure ASCII: unchanged, still imports', () => {
		const bytes = marcRecord(' ', new TextEncoder().encode('Barcelona'));
		const { records, errors } = parseMarc(bytes);
		expect(errors).toEqual([]);
		expect(records[0]?.fields[0]?.subfields?.[0]?.value).toBe('Barcelona');
	});

	test('leader/09 = a but the bytes are not UTF-8: REFUSED', () => {
		const bytes = marcRecord('a', CP1252_VALUE);
		const { records, errors } = parseMarc(bytes);
		expect(records).toEqual([]);
		expect(errors.join(' ')).toContain('not valid UTF-8');
	});
});

// ---------------------------------------------------------------------------
// 3b. The CLIENT half of the report contract: a notice is not painted as an error.
// ---------------------------------------------------------------------------

/**
 * The panel is where the DATA-09 fix's own composition defect landed: the
 * encoding notice was carried in the report's `errors` array, and
 * render_final_report paints every string in `errors` into
 * `.dedalo_last_error_container` as `error_pre` — a red, warning-icon block. So a
 * SUCCESSFUL, INTENDED CP1252 conversion told the operator their import had
 * failed. The server half is asserted above (`notices` is its own channel); this
 * pins the client half by SOURCE, so re-merging the two channels in the renderer
 * is a red gate and not a silent regression.
 *
 * Honest limit: it proves the WIRING (which channel feeds which container), not
 * the rendered pixels — that is `bun run test:client`'s tier.
 */
describe('the panel renders a notice as a notice, not as an error', () => {
	const PANEL = 'tools/tool_import_dedalo_csv/js/render_tool_import_dedalo_csv.js';

	test('report.notices renders outside the error container', () => {
		const source = stripComments(read(PANEL));
		// Positive control: BOTH channels are read. A rename must redden this gate
		// rather than blind it.
		expect(source).toContain('report.notices');
		expect(source).toContain('report.errors');

		const noticeAt = source.indexOf('const file_notices');
		const errorAt = source.indexOf('const file_errors');
		expect(noticeAt).toBeGreaterThan(-1);
		expect(errorAt).toBeGreaterThan(noticeAt);

		// The notice block builds ordinary report text and nothing error-shaped.
		const noticeBlock = source.slice(noticeAt, errorAt);
		expect(noticeBlock).toContain('user_msg_container');
		expect(noticeBlock).not.toContain('error');
		expect(noticeBlock).not.toContain('danger');

		// And the red container is fed the ERROR channel only.
		const errorBlock = source.slice(errorAt);
		expect(errorBlock).toContain('dedalo_last_error_container');
		expect(errorBlock.slice(0, errorBlock.indexOf('result_info_container'))).not.toContain(
			'notice',
		);
	});
});

// ---------------------------------------------------------------------------
// 3c. THE NOTICE CHANNEL IS ON THE WIRE TYPE, and the mapper preview shows it.
// ---------------------------------------------------------------------------

/**
 * `notices` is a WIRE FIELD, so it lives on the wire type. It was first declared
 * as an `ImportFileReportWithNotices` side-type in `import_csv_execute.ts` — a
 * shape the client reads, carried in a parallel interface, which is the drift
 * the wire contract exists to prevent. This pins the field on the report itself
 * (a type move only: the panel already read `report.notices`).
 */
describe('the report contract carries the notice channel', () => {
	test('ImportFileReport declares `notices`, next to `errors`', () => {
		const source = stripComments(read('src/core/tools/import_wire.ts'));
		const start = source.indexOf('interface ImportFileReport {');
		expect(start).toBeGreaterThan(-1);
		const body = source.slice(start, source.indexOf('}', start));
		// Positive control: the slice really is the report body.
		expect(body).toContain('errors: string[];');
		expect(body).toContain('notices: string[];');
	});
});

/**
 * THE MAPPER PREVIEW'S OPERATOR SURFACE.
 *
 * `get_csv_files` answers `{files, errors, notices}`, and the column map and the
 * sample values the operator maps their columns from are read out of the
 * CONVERTED text. The controller used to read `errors` only (into console.error)
 * and drop `notices` entirely: the conversion had no operator surface at all
 * before the import ran, so the first the operator heard of it was the report,
 * after the records were written.
 *
 * Honest limit: this pins the WIRING by source — that the notices are read, kept
 * and put into the panel's DOM outside the error container. The pixels are
 * `bun run test:client`'s tier.
 */
describe('the mapper preview shows what was done to the file it previews', () => {
	const CONTROLLER = 'tools/tool_import_dedalo_csv/js/tool_import_dedalo_csv.js';

	test('the controller keeps BOTH channels get_csv_files answers with, and logs neither', () => {
		const source = stripComments(read(CONTROLLER));
		// Positive control: BOTH channels are read, so a rename reddens this gate
		// rather than blinding it.
		expect(source).toContain('files_data?.errors');
		expect(source).toContain('files_data?.notices');
		expect(source).toContain('self.csv_files_notices');
		// T1-S18: the read errors are KEPT for the panel. A console line was their
		// only trace, and the unreadable file vanished from the list unexplained.
		expect(source).toContain('self.csv_files_errors');
		const start = source.indexOf('tool_import_dedalo_csv.prototype.load_csv_files_list');
		expect(start).toBeGreaterThan(-1);
		const end = source.indexOf('tool_import_dedalo_csv.prototype.', start + 1);
		const body = source.slice(start, end);
		expect(body).toContain('self.csv_files_errors');
		expect(body).not.toContain('console.error');
	});

	test('render() paints both channels — notices as notices, read errors as errors', () => {
		const source = stripComments(read(CONTROLLER));
		// render delegates to the exported painter (testable in the client tier).
		const renderAt = source.indexOf('tool_import_dedalo_csv.prototype.render');
		expect(renderAt).toBeGreaterThan(-1);
		const renderEnd = source.indexOf('tool_import_dedalo_csv.prototype.', renderAt + 1);
		expect(source.slice(renderAt, renderEnd)).toContain('render_csv_files_messages(self');

		// The painter: ONE function, from its export to the next top-level form.
		const start = source.indexOf('export const render_csv_files_messages');
		expect(start).toBeGreaterThan(-1);
		const end = source.indexOf('tool_import_dedalo_csv.prototype.', start + 1);
		expect(end).toBeGreaterThan(start);
		const body = source.slice(start, end);
		// It reaches the DOM.
		expect(body).toContain('create_dom_element');
		expect(body).toContain('insertBefore');

		const errorAt = body.indexOf('const errors = self.csv_files_errors');
		const noticeAt = body.indexOf('const notices = self.csv_files_notices');
		expect(errorAt).toBeGreaterThan(-1);
		expect(noticeAt).toBeGreaterThan(errorAt);
		// The read errors: the error channel's own shape (the report panel's).
		const errorBlock = body.slice(errorAt, noticeAt);
		expect(errorBlock).toContain('dedalo_last_error_container');
		expect(errorBlock).toContain('error_pre');
		expect(errorBlock).not.toContain('notice');
		// The notices: ordinary report text, and nothing error-shaped — a
		// conversion is not an error (mirrors §3b).
		const noticeBlock = body.slice(noticeAt);
		expect(noticeBlock).toContain('notice_msg');
		expect(noticeBlock).not.toContain('error');
		expect(noticeBlock).not.toContain('danger');
		expect(body).not.toContain('console.error');
	});
});

// ---------------------------------------------------------------------------
// 4. THE WRITE HALF — the census of delimited writers IS the writer registry.
// ---------------------------------------------------------------------------

/** A served type a curator opens in a spreadsheet and saves back as delimited text. */
const DELIMITED_TYPE = /^text\/(csv|tab-separated-values)\b/;

/** Registered formats whose served Content-Type is delimited text — derived, not listed. */
function delimitedRegistryFormats(): ExportFormat[] {
	return (Object.keys(EXPORT_WRITERS) as ExportFormat[])
		.filter((format) => DELIMITED_TYPE.test(FORMAT_SPECS[format].contentType))
		.sort();
}

/** `Ripollès;Moneda ibérica` — the audit's own repro value, exported and re-read. */
const ROUND_TRIP_VALUE = 'Ripollès;Moneda ibérica';

describe('export writers: every delimited writer in the registry emits the UTF-8 BOM', () => {
	const scratch = mkdtempSync(join(tmpdir(), 'dedalo_ingest_bom_'));
	afterAll(() => {
		rmSync(scratch, { recursive: true, force: true });
	});

	test('the census is derived from the registry, non-empty, and is exactly CSV + TSV', () => {
		const formats = delimitedRegistryFormats();
		// If this is empty the derivation stopped matching, not the registry stopped
		// having writers — a census that finds nothing proves nothing.
		expect(formats.length).toBeGreaterThan(0);
		// A NEW delimited format is not an error, but it must be seen: widen this
		// list in the same change, with the file it builds proven below.
		expect(formats).toEqual(['csv', 'tsv']);
	});

	test('every delimited writer: first bytes EF BB BF, and the file re-imports as UTF-8 unchanged', async () => {
		const store = scratchExportStore(scratch);
		const job = await endedExportJob(store, singleColumnExport([ROUND_TRIP_VALUE], 'Nombre'));
		for (const format of delimitedRegistryFormats()) {
			const bytes = await buildExportBytes(store, job, format);
			expect([...bytes.subarray(0, 3)], `${format}: no UTF-8 BOM`).toEqual([0xef, 0xbb, 0xbf]);
			// THE ROUND TRIP DATA-09 IS ABOUT: our download, fed back to our import
			// door's decoder, is UTF-8 — no conversion, no notice, the BOM consumed,
			// the accented value intact.
			const decoded = decodeIngestBytes(new Uint8Array(bytes), `export.${format}`);
			expect(decoded.encoding).toBe('utf-8');
			expect(decoded.converted).toBe(false);
			expect(decoded.notice).toBeNull();
			expect(decoded.text.charCodeAt(0), `${format}: BOM left in the text`).not.toBe(0xfeff);
			expect(decoded.text).toContain('Ripollès');
			expect(decoded.text).not.toContain('\uFFFD');
		}
	});

	test('positive control: the SAME checks, run on the writer output minus its BOM and on a legacy-encoded twin, fail', async () => {
		// Both halves of the assertion above must be able to fail on a real file:
		// (1) the writer's own bytes with the BOM cut off no longer start EF BB BF;
		// (2) the same file re-encoded as Windows-1252 (what a BOM-less file
		//     round-tripped through Excel becomes) is NOT read as unconverted
		//     UTF-8 by the import decoder.
		const store = scratchExportStore(scratch);
		const job = await endedExportJob(store, singleColumnExport([ROUND_TRIP_VALUE], 'Nombre'));
		for (const format of delimitedRegistryFormats()) {
			const bytes = await buildExportBytes(store, job, format);
			const stripped = bytes.subarray(3);
			expect([...stripped.subarray(0, 3)]).not.toEqual([0xef, 0xbb, 0xbf]);
			const text = new TextDecoder('utf-8').decode(stripped);
			expect(text).toContain('Ripollès'); // the cut really was the BOM, nothing else
			const legacy = Uint8Array.from([...text].map((char) => char.charCodeAt(0) & 0xff));
			const decoded = decodeIngestBytes(legacy, `export.${format}`);
			expect(decoded.encoding === 'utf-8' && decoded.converted === false).toBe(false);
		}
	});
});

/**
 * A delimited download built OUTSIDE the export registry: a data: URI or a Blob
 * typed as CSV/TSV, in the hand-written client/tool JS or anywhere in the TS
 * tree. Every such file bypasses the registry (its BOM, its formula rule), so
 * the census of them must be EMPTY — the server builds every download now.
 */
const DELIMITED_DOWNLOAD_URI =
	/data:text\/(csv|tsv|tab-separated-values)|new\s+Blob\s*\([^)]*type\s*:\s*['"`]text\/(csv|tsv|tab-separated-values)/;

/** The scanned corpus: every js + ts file under client/, tools/, src/ (tests excluded). */
function delimitedUriCorpus(): string[] {
	return sourceFiles(['client', 'tools', 'src'], 'js')
		.concat(sourceFiles(['client', 'tools', 'src'], 'ts'))
		.filter(
			// Vendored/minified third-party bundles are not our writers; the browser
			// suite builds fixtures, not downloads.
			(file) =>
				!file.includes('/lib/') && !file.includes('.min.') && !file.includes('/test/client/'),
		);
}

function delimitedDownloadSites(): string[] {
	const sites: string[] = [];
	for (const file of delimitedUriCorpus()) {
		for (const line of stripComments(read(file)).split('\n')) {
			if (DELIMITED_DOWNLOAD_URI.test(line)) sites.push(`${file}: ${line.trim()}`);
		}
	}
	return sites;
}

describe('no code outside the registry builds a delimited download', () => {
	test('positive control: the classifier recognizes both shapes the old client used', () => {
		expect(DELIMITED_DOWNLOAD_URI.test("'data:text/csv;charset=utf-8,' + x")).toBe(true);
		expect(DELIMITED_DOWNLOAD_URI.test("new Blob([csv], {type: 'text/csv'})")).toBe(true);
		expect(DELIMITED_DOWNLOAD_URI.test("new Blob([json], {type: 'octet/stream'})")).toBe(false);
	});

	test('the census is EMPTY (the corpus is not: it scanned the client, tool and engine trees)', () => {
		const corpus = delimitedUriCorpus();
		expect(corpus.length).toBeGreaterThan(1000);
		expect(delimitedDownloadSites()).toEqual([]);
	});
});

/**
 * SHRINK-ONLY, same contract as the door exemptions: a delimited writer OUTSIDE
 * the export registry that deliberately emits NO BOM, with the reason.
 */
const BOM_EXEMPT: Readonly<Record<string, string>> = {
	'src/diffusion/writers/csv.ts':
		'DATA-09 names the DOWNLOAD half (the Excel round trip back into the import door). This is a PUBLISHED artifact whose byte contract is pinned by test/unit/diffusion_file_writers.test.ts ("no BOM"), consumed by harvesters rather than by a curator saving over it. OPEN: whether a published csv should carry a BOM is a diffusion-contract decision, not this fix.',
};

describe('BOM exemptions', () => {
	test('every BOM exemption is real, reasoned, and still exempt', () => {
		for (const [file, reason] of Object.entries(BOM_EXEMPT)) {
			expect(reason).toMatch(/DATA-\d\d/);
			// Still a delimited writer, and still without a BOM: a stale exemption fails.
			const source = stripComments(read(file));
			expect(source).toMatch(/csv|delimit/i);
			expect(source).not.toContain('\\uFEFF');
			expect(source).not.toContain('0xfeff');
		}
	});
});
