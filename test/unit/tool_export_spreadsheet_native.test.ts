/**
 * TOOL_EXPORT XLSX + ODS — behavioural gate for the server-built spreadsheets
 * (tools/tool_export/server/writers/{xlsx,ods,spreadsheet}.ts), through the
 * ONE door a file comes into existence by (writers/index.ts
 * `buildArtifactFile`: ended spool → writer → temp → rename → manifest).
 *
 * Every case BUILDS its spool in a DECLARED scratch export root (the
 * `.dedalo_test_export_artifacts` marker) and sweeps it; no database, no
 * install TLD. The produced file is unzipped and parsed by an INDEPENDENT
 * strict reader (test/helpers/zip_xml_reader.ts) and what a spreadsheet
 * application would show is compared with what the protocol said:
 *
 *  A. XLSX: N rows, header, end-line column order, TEXT cells (leading zeros),
 *     escapes, stripped XML-invalid controls, `_xHHHH_` literals, media origin;
 *  B. XLSX split: a small injected cap → sheets with the header repeated,
 *     exact multiples, the empty export;
 *  C. XLSX limits: 16,384 columns built (XFD), 16,385 refused
 *     (export.format_limit), an over-long cell refused — no file, no temp;
 *  D. ODS: mimetype first + STORED + no extra, manifest, the same rows and
 *     the same sheet geometry, white space kept (text:s / tab / line-break);
 *  E. ZIP64 in a spreadsheet (injected limits) still reads back identically;
 *  E2. ZIP64 never DECLARED from a size guess (Excel's repair prompt): a part
 *     under the limit is plain, one past it takes only the overflow form;
 *  F. cancel before and mid-write → export.cancelled, nothing left; mid-rows
 *     the WRITER itself stops (its spool ignores the signal), not the door.
 */

import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isDedaloError } from '../../src/core/errors/index.ts';
import {
	type ArtifactJobRef,
	type ArtifactStore,
	type FileSink,
	openArtifactStore,
} from '../../tools/tool_export/server/artifact_store.ts';
import type { SpoolReader } from '../../tools/tool_export/server/spool_reader.ts';
import { buildArtifactFile } from '../../tools/tool_export/server/writers/index.ts';
import { odsWriter } from '../../tools/tool_export/server/writers/ods.ts';
import type { ExportWriter } from '../../tools/tool_export/server/writers/types.ts';
import { xlsxWriter } from '../../tools/tool_export/server/writers/xlsx.ts';
import { markExportArtifactsRoot } from '../helpers/media_scratch_root.ts';
import {
	childElements,
	descendants,
	parseXml,
	readZip,
	type XmlElement,
	type ZipReadResult,
	zipText,
} from '../helpers/zip_xml_reader.ts';

const scratchDirs: string[] = [];
afterAll(() => {
	for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
});

function markedStore(): ArtifactStore {
	const dir = mkdtempSync(join(tmpdir(), 'dedalo_export_sheet_'));
	scratchDirs.push(dir);
	return openArtifactStore({
		root: markExportArtifactsRoot(join(dir, 'artifacts')),
		quotaBytes: 0,
		ttlHours: 24,
	});
}

const INIT = {
	userId: 7,
	sectionTipo: 'test3',
	sections: ['test3'],
	options: { data_format: 'standard', breakdown: 'rows' },
	recordScope: 'writer-gate',
	frameColumns: [],
	applicationLang: 'lg-eng',
};
const ORIGIN = 'https://example.test';

type Line = Record<string, unknown>;

/** Values a spreadsheet mangles unless every cell is text, plus the XML hazards. */
function hazard(rec: number, sub: number): string {
	const values = [
		`00${rec}`, // leading zeros
		`título ${rec}.${sub} "q" <b>&amp;</b>`, // escapes
		'1e3',
		'  two  spaces\tand tab\nline two  ',
		`ctl\u0001\u0008\u000b\u000c\u001f\uFFFF${rec}`, // XML-invalid: stripped
		'_x0041_ literal _x0041_x0042_ __x0043_', // OOXML escape lookalikes, incl. overlapping ones
		'=SUM(A1)',
	];
	return values[(rec + sub) % values.length] as string;
}

/** The expected TEXT of a hazard value after the writer (controls stripped). */
function shown(text: string): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: the fixture's own controls, removed to predict the output
	return text.replace(/[\u0001\u0008\u000b\u000c\u001f\uFFFF]/g, '');
}

/**
 * A protocol: col 0 id, col 1 text, col 2 img (media URLs made absolute with
 * the origin), col 3 appears mid-stream; end.columns reorders them; some
 * records carry breakdown sub-rows; some cells are missing.
 */
function protocol(records: number): { lines: Line[]; expected: string[][]; header: string[] } {
	const lines: Line[] = [
		{
			t: 'meta',
			v: 1,
			data_format: 'standard',
			breakdown: 'rows',
			section_tipo: 'test3',
			total: records,
		},
		{ t: 'col', i: 0, key: 'id', label: 'Id', cell_type: 'section_id', after: null },
		{ t: 'col', i: 1, key: 'test52', label: 'Título <&>', cell_type: 'text', after: 0 },
		{ t: 'col', i: 2, key: 'test99', label: 'Image', cell_type: 'img', after: 1 },
	];
	const rows: Record<string, string>[] = [];
	let colAdded = false;
	for (let rec = 1; rec <= records; rec++) {
		if (rec === 2 && !colAdded) {
			lines.push({ t: 'col', i: 3, key: 'test71', label: 'Parent', cell_type: 'text', after: 0 });
			colAdded = true;
		}
		const subs = rec % 3 === 0 ? 2 : 1;
		for (let sub = 0; sub < subs; sub++) {
			const c: Record<string, string> = { '0': String(rec), '1': hazard(rec, sub) };
			if (rec % 2 === 1) c['2'] = `/dedalo/media/image/${rec}.jpg | http://cdn.test/${rec}.jpg`;
			if (colAdded && rec % 4 !== 0) c['3'] = `0${rec}0`;
			lines.push({ t: 'row', rec, sub, c });
			rows.push(c);
		}
	}
	const columns = colAdded ? [0, 3, 1, 2] : [0, 1, 2];
	lines.push({ t: 'end', columns, rows: rows.length, records });
	const labels: Record<number, string> = { 0: 'Id', 1: 'Título <&>', 2: 'Image', 3: 'Parent' };
	const expected = rows.map((c) =>
		columns.map((i) => {
			const value = c[String(i)];
			if (value === undefined) return '';
			if (i === 2) {
				return value
					.split(' | ')
					.map((url) => (url.startsWith('http') ? url : ORIGIN + url))
					.join(' | ');
			}
			return shown(value);
		}),
	);
	return { lines, expected, header: columns.map((i) => labels[i] as string) };
}

async function endedJob(store: ArtifactStore, lines: Line[]): Promise<ArtifactJobRef> {
	const { job } = await store.createJob(INIT);
	const writer = await store.openSpoolWriter(job, { indexEvery: 4 });
	for (const line of lines) await writer.write(line);
	await writer.close();
	await store.updateManifest(job, { status: 'ended', ended_at: new Date().toISOString() });
	return job;
}

async function build(
	store: ArtifactStore,
	job: ArtifactJobRef,
	format: 'xlsx' | 'ods',
	extra: Record<string, unknown> = {},
	signal: AbortSignal = new AbortController().signal,
) {
	const file = await buildArtifactFile({
		store,
		job,
		format,
		options: { origin: ORIGIN, showTipoInLabel: false, ...extra },
		signal,
	});
	const bytes = new Uint8Array(readFileSync(join(job.dir, file.basename)));
	return { file, bytes, zip: readZip(bytes) };
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<unknown> {
	let caught: unknown = null;
	try {
		await promise;
	} catch (error) {
		caught = error;
	}
	expect(isDedaloError(caught), `expected ${code}, got ${String(caught)}`).toBe(true);
	expect((caught as { code: string }).code).toBe(code);
	return caught;
}

/** A job dir holds only the spool + manifest (no built file, no temp). */
function expectNoArtifact(job: ArtifactJobRef): void {
	const names = readdirSync(job.dir).sort();
	expect(names).toEqual([
		'cols.ndjson',
		'grid.idx',
		'grid.ndjson',
		'manifest.json',
		'request.json',
	]);
}

// ------------------------------------------------------------ XLSX reading

function textOf(element: XmlElement): string {
	return element.children
		.map((child) => (typeof child === 'string' ? child : textOf(child)))
		.join('');
}

/** OOXML ST_Xstring decoding (what Excel shows for `_xHHHH_`). */
function decodeXstring(text: string): string {
	return text.replace(/_x([0-9A-Fa-f]{4})_/g, (_, hex: string) =>
		String.fromCharCode(Number.parseInt(hex, 16)),
	);
}

function columnIndex(ref: string): number {
	const letters = /^[A-Z]+/.exec(ref)?.[0] ?? '';
	let n = 0;
	for (const letter of letters) n = n * 26 + (letter.charCodeAt(0) - 64);
	return n - 1;
}

interface XlsxSheet {
	name: string;
	rows: string[][];
	styles: string[][];
}

/** Read a workbook the way a consumer does: content types → workbook → rels → sheets. */
function readXlsx(zip: ZipReadResult): XlsxSheet[] {
	const types = parseXml(zipText(zip, '[Content_Types].xml'));
	const overrides = childElements(types, 'Override').map((o) => o.attrs.PartName);
	expect(overrides).toContain('/xl/workbook.xml');
	const rootRels = parseXml(zipText(zip, '_rels/.rels'));
	expect(childElements(rootRels, 'Relationship')[0]?.attrs.Target).toBe('xl/workbook.xml');
	parseXml(zipText(zip, 'xl/styles.xml'));
	const workbook = parseXml(zipText(zip, 'xl/workbook.xml'));
	const rels = parseXml(zipText(zip, 'xl/_rels/workbook.xml.rels'));
	const targets = new Map(
		childElements(rels, 'Relationship').map((r) => [r.attrs.Id, r.attrs.Target as string]),
	);
	return descendants(workbook, 'sheet').map((sheet) => {
		const target = `xl/${targets.get(sheet.attrs['r:id'])}`;
		expect(overrides).toContain(`/${target}`);
		const doc = parseXml(zipText(zip, target));
		const rows: string[][] = [];
		const styles: string[][] = [];
		descendants(doc, 'row').forEach((row, k) => {
			expect(row.attrs.r).toBe(String(k + 1));
			const cells: string[] = [];
			const cellStyles: string[] = [];
			for (const c of childElements(row, 'c')) {
				expect(c.attrs.t).toBe('inlineStr'); // every cell is TEXT
				expect(c.attrs.r).toBe(`${/^[A-Z]+/.exec(c.attrs.r as string)?.[0]}${k + 1}`);
				const at = columnIndex(c.attrs.r as string);
				while (cells.length < at) {
					cells.push('');
					cellStyles.push('');
				}
				cells.push(decodeXstring(textOf(c)));
				cellStyles.push(c.attrs.s as string);
			}
			rows.push(cells);
			styles.push(cellStyles);
		});
		return { name: sheet.attrs.name as string, rows, styles };
	});
}

/** Right-pad each row to the header width (a consumer shows missing trailing cells as empty). */
function pad(rows: string[][], width: number): string[][] {
	return rows.map((row) => [...row, ...Array(Math.max(0, width - row.length)).fill('')]);
}

// ------------------------------------------------------------- ODS reading

/**
 * What an ODF consumer shows for a cell (ODF 1.3 §6.1.2 white-space
 * processing): in character data, a run of spaces collapses to one and white
 * space at the start or end of the paragraph is dropped; text:s / text:tab /
 * text:line-break are the only way to keep them.
 */
function odsCellText(cell: XmlElement): string {
	return childElements(cell, 'text:p')
		.map((p) => {
			const last = p.children.length - 1;
			return p.children
				.map((child, k) => {
					if (typeof child === 'string') {
						let text = child.replace(/[ \t\n\r]+/g, ' ');
						if (k === 0) text = text.replace(/^ /, '');
						if (k === last) text = text.replace(/ $/, '');
						return text;
					}
					if (child.name === 'text:s') return ' '.repeat(Number(child.attrs['text:c'] ?? 1));
					if (child.name === 'text:tab') return '\t';
					if (child.name === 'text:line-break') return '\n';
					throw new Error(`unexpected <${child.name}> in text:p`);
				})
				.join('');
		})
		.join('\n');
}

interface OdsSheet {
	name: string;
	header: string[];
	rows: string[][];
}

function odsRow(row: XmlElement): string[] {
	const cells: string[] = [];
	for (const cell of childElements(row, 'table:table-cell')) {
		const repeat = Number(cell.attrs['table:number-columns-repeated'] ?? 1);
		const text = odsCellText(cell);
		if (text !== '') expect(cell.attrs['office:value-type']).toBe('string');
		for (let n = 0; n < repeat; n++) cells.push(text);
	}
	return cells;
}

function readOds(zip: ZipReadResult): OdsSheet[] {
	const manifest = parseXml(zipText(zip, 'META-INF/manifest.xml'));
	const paths = childElements(manifest, 'manifest:file-entry').map(
		(e) => e.attrs['manifest:full-path'],
	);
	expect(paths).toEqual(['/', 'styles.xml', 'content.xml']);
	parseXml(zipText(zip, 'styles.xml'));
	const content = parseXml(zipText(zip, 'content.xml'));
	return descendants(content, 'table:table').map((table) => {
		const headerRows = childElements(table, 'table:table-header-rows');
		expect(headerRows.length).toBe(1);
		const header = odsRow(
			childElements(headerRows[0] as XmlElement, 'table:table-row')[0] as XmlElement,
		);
		const rows = childElements(table, 'table:table-row').map(odsRow);
		return { name: table.attrs['table:name'] as string, header, rows };
	});
}

// ---------------------------------------------------------------------------

describe('A. XLSX: rows, text cells, escapes', () => {
	test('N rows (with breakdown sub-rows) read back exactly, header first, every cell text', async () => {
		const store = markedStore();
		const { lines, expected, header } = protocol(11);
		const job = await endedJob(store, lines);
		const { file, zip } = await build(store, job, 'xlsx');
		// named by the options that change its bytes (writers/index.ts artifactFileVariant)
		expect(file.basename).toMatch(/^export_[0-9a-f]{12}\.xlsx$/);
		expect(file.rows).toBe(expected.length);
		expect((await store.readManifest(job)).files[file.basename]?.rows).toBe(expected.length);

		const sheets = readXlsx(zip);
		expect(sheets.map((s) => s.name)).toEqual(['Sheet1']);
		const sheet = sheets[0] as XlsxSheet;
		expect(sheet.rows[0]).toEqual(header);
		expect(pad(sheet.rows.slice(1), header.length)).toEqual(expected);
		// leading zeros kept as text; the header is the bold text style, data the text style
		expect(sheet.rows[1]?.[0]).toBe('1');
		expect(sheet.rows.slice(1).some((row) => row.includes('007'))).toBe(true);
		expect(new Set(sheet.styles[0])).toEqual(new Set(['2']));
		expect(new Set(sheet.styles.slice(1).flat().filter(Boolean))).toEqual(new Set(['1']));
		// the Text number format really is what style 1/2 carry
		const styles = parseXml(zipText(zip, 'xl/styles.xml'));
		const xfs = childElements(descendants(styles, 'cellXfs')[0] as XmlElement, 'xf');
		expect(xfs[1]?.attrs.numFmtId).toBe('49');
		expect(xfs[2]?.attrs.numFmtId).toBe('49');
	});

	test('showTipoInLabel reaches the header', async () => {
		const store = markedStore();
		const lines = protocol(2).lines.map((line) =>
			line.t === 'col' ? { ...line, path: [{ component_tipo: `${line.key}` }] } : line,
		);
		const job = await endedJob(store, lines);
		const { zip } = await build(store, job, 'xlsx', { showTipoInLabel: true });
		expect(readXlsx(zip)[0]?.rows[0]).toEqual([
			'Id [id]',
			'Parent [test71]',
			'Título <&> [test52]',
			'Image [test99]',
		]);
	});
});

describe('B. XLSX split', () => {
	test('a small cap splits into sheets, header repeated on each', async () => {
		const store = markedStore();
		const { lines, expected, header } = protocol(11); // 14 rows
		const job = await endedJob(store, lines);
		const { zip, file } = await build(store, job, 'xlsx', { sheetRowCap: 4 });
		expect(file.rows).toBe(14);
		const sheets = readXlsx(zip);
		expect(sheets.map((s) => s.name)).toEqual(['Sheet1', 'Sheet2', 'Sheet3', 'Sheet4']);
		expect(sheets.map((s) => s.rows.length - 1)).toEqual([4, 4, 4, 2]);
		for (const sheet of sheets) expect(sheet.rows[0]).toEqual(header);
		expect(
			pad(
				sheets.flatMap((s) => s.rows.slice(1)),
				header.length,
			),
		).toEqual(expected);
	});

	test('an exact multiple makes no empty trailing sheet; an empty export is one header-only sheet', async () => {
		const store = markedStore();
		const { lines } = protocol(4); // 5 rows
		const job = await endedJob(store, lines);
		const sheets = readXlsx((await build(store, job, 'xlsx', { sheetRowCap: 5 })).zip);
		expect(sheets.map((s) => s.rows.length - 1)).toEqual([5]);

		const empty = await endedJob(store, [
			{ t: 'meta', v: 1 },
			{ t: 'col', i: 0, key: 'id', label: 'Id', after: null },
			{ t: 'end', columns: [0], rows: 0, records: 0 },
		]);
		const built = await build(store, empty, 'xlsx');
		expect(built.file.rows).toBe(0);
		expect(readXlsx(built.zip).map((s) => s.rows)).toEqual([[['Id']]]);
	});
});

function wideProtocol(columns: number): Line[] {
	const lines: Line[] = [{ t: 'meta', v: 1 }];
	const c: Record<string, string> = {};
	for (let i = 0; i < columns; i++) {
		lines.push({ t: 'col', i, key: `k${i}`, label: `L${i}`, after: i === 0 ? null : i - 1 });
		c[String(i)] = `0${i}`;
	}
	lines.push({ t: 'row', rec: 1, sub: 0, c });
	lines.push({
		t: 'end',
		columns: Array.from({ length: columns }, (_, i) => i),
		rows: 1,
		records: 1,
	});
	return lines;
}

describe('C. XLSX limits', () => {
	test('16,384 columns build (last is XFD); 16,385 are refused with export.format_limit, nothing left', async () => {
		const store = markedStore();
		const fits = await endedJob(store, wideProtocol(16_384));
		const { zip } = await build(store, fits, 'xlsx');
		const sheet = parseXml(zipText(zip, 'xl/worksheets/sheet1.xml'));
		const lastRow = descendants(sheet, 'row').at(-1) as XmlElement;
		const lastCell = childElements(lastRow, 'c').at(-1) as XmlElement;
		expect(lastCell.attrs.r).toBe('XFD2');
		expect(textOf(lastCell)).toBe('016383');

		for (const format of ['xlsx', 'ods'] as const) {
			const over = await endedJob(store, wideProtocol(16_385));
			const error = await expectCode(build(store, over, format), 'export.format_limit');
			expect((error as { details?: unknown }).details).toEqual({ format, limit: 16_384 });
			expectNoArtifact(over);
		}
	});

	test('a cell over 32,767 characters is refused for XLSX (never truncated); ODS carries it', async () => {
		const store = markedStore();
		const long = 'x'.repeat(32_768);
		const lines: Line[] = [
			{ t: 'meta', v: 1 },
			{ t: 'col', i: 0, key: 'k', label: 'K', after: null },
			{ t: 'row', rec: 1, sub: 0, c: { '0': 'x'.repeat(32_767) } },
			{ t: 'row', rec: 2, sub: 0, c: { '0': long } },
			{ t: 'end', columns: [0], rows: 2, records: 2 },
		];
		const job = await endedJob(store, lines);
		const error = await expectCode(build(store, job, 'xlsx'), 'export.format_limit');
		expect((error as { details?: unknown }).details).toEqual({ format: 'xlsx', limit: 32_767 });
		expectNoArtifact(job);
		const ods = readOds((await build(store, job, 'ods')).zip);
		expect(ods[0]?.rows[1]?.[0]).toBe(long);
	});
});

describe('D. ODS', () => {
	test('mimetype first, STORED, no extra, no descriptor', async () => {
		const store = markedStore();
		const job = await endedJob(store, protocol(3).lines);
		const { zip, bytes, file } = await build(store, job, 'ods');
		expect(file.basename).toMatch(/^export_[0-9a-f]{12}\.ods$/);
		const first = zip.entries[0];
		expect(first?.name).toBe('mimetype');
		expect(first?.method).toBe(0);
		expect(first?.flags).toBe(0);
		expect(first?.localExtraLength).toBe(0);
		expect(first?.offset).toBe(0);
		// the byte-sniffable signature: "mimetype" then the type at offset 38
		expect(new TextDecoder().decode(bytes.subarray(30, 38))).toBe('mimetype');
		expect(new TextDecoder().decode(bytes.subarray(38, 38 + 46))).toBe(
			'application/vnd.oasis.opendocument.spreadsheet',
		);
	});

	test('N rows, text cells, white space kept, same sheet geometry as XLSX', async () => {
		const store = markedStore();
		const { lines, expected, header } = protocol(11);
		const job = await endedJob(store, lines);
		const { file, zip } = await build(store, job, 'ods', { sheetRowCap: 4 });
		expect(file.rows).toBe(14);
		const sheets = readOds(zip);
		expect(sheets.map((s) => s.name)).toEqual(['Sheet1', 'Sheet2', 'Sheet3', 'Sheet4']);
		expect(sheets.map((s) => s.rows.length)).toEqual([4, 4, 4, 2]);
		for (const sheet of sheets) expect(sheet.header).toEqual(header);
		expect(
			pad(
				sheets.flatMap((s) => s.rows),
				header.length,
			),
		).toEqual(expected);
		const all = sheets.flatMap((s) => s.rows).flat();
		expect(all).toContain('  two  spaces\tand tab\nline two  ');
		expect(all).toContain('007');
		expect(all).toContain('020');
	});
});

describe('E. ZIP64 inside a spreadsheet', () => {
	test('injected small limits: every part carries ZIP64 records and the workbook reads back identically', async () => {
		const store = markedStore();
		const { lines, expected, header } = protocol(9);
		const job = await endedJob(store, lines);
		const plain = readXlsx((await build(store, job, 'xlsx', { sheetRowCap: 5 })).zip);
		const wide = await build(store, job, 'xlsx', {
			sheetRowCap: 5,
			zip64Limits: { size: 200, count: 4 },
		});
		expect(wide.zip.zip64End).toBe(true);
		expect(wide.zip.entries.some((e) => e.localZip64)).toBe(true);
		expect(wide.zip.entries.filter((e) => e.centralZip64).length).toBeGreaterThan(3);
		const sheets = readXlsx(wide.zip);
		expect(sheets).toEqual(plain);
		expect(
			pad(
				sheets.flatMap((s) => s.rows.slice(1)),
				header.length,
			),
		).toEqual(expected);
	});
});

/**
 * ZIP64 is DECLARED only when certain, never from a size guess. Excel shows a
 * "repair" prompt for an xlsx whose parts carry a ZIP64 local extra, so a
 * heuristic declaration (the old `gridBytes × 12` sizeHint) would flag every
 * large, perfectly ordinary download. The limit is set just above the part's
 * REAL size and well below `gridBytes × 12`: the part must stay plain (no local
 * ZIP64 extra, 4-byte descriptor). Just below its real size, the undeclared
 * overflow path must still give a readable archive (central ZIP64 + 8-byte
 * descriptor, still no local extra).
 */
describe('E2. ZIP64 is never declared from a size guess', () => {
	const cases = [
		{ format: 'xlsx', part: 'xl/worksheets/sheet1.xml' },
		{ format: 'ods', part: 'content.xml' },
	] as const;
	for (const { format, part } of cases) {
		test(`${format}: ${part} below the limit carries no ZIP64; past it, only the overflow form`, async () => {
			const store = markedStore();
			const { lines } = protocol(9);
			const job = await endedJob(store, lines);
			const gridBytes = Bun.file(join(job.dir, 'grid.ndjson')).size;
			const plainZip = (await build(store, job, format)).zip;
			const plain = plainZip.entries.find((e) => e.name === part);
			expect(plain).toBeDefined();
			const real = Math.max(plain?.uncompressedSize ?? 0, plain?.compressedSize ?? 0);
			const limit = real + 1;
			// non-vacuous: the old heuristic WOULD have declared ZIP64 at this limit
			expect(gridBytes * 12).toBeGreaterThanOrEqual(limit);

			const under = (await build(store, job, format, { zip64Limits: { size: limit } })).zip;
			const fits = under.entries.find((e) => e.name === part);
			expect(fits?.localZip64).toBe(false);
			expect(fits?.localExtraLength).toBe(0);
			expect(fits?.wideDescriptor).toBe(false);
			expect(fits?.data).toEqual(plain?.data as Uint8Array);

			const over = (await build(store, job, format, { zip64Limits: { size: real - 1 } })).zip;
			const overflows = over.entries.find((e) => e.name === part);
			expect(overflows?.localZip64).toBe(false);
			expect(overflows?.wideDescriptor).toBe(true);
			expect(overflows?.centralZip64).toBe(true);
			expect(overflows?.data).toEqual(plain?.data as Uint8Array);
		});
	}
});

describe('F. cancel', () => {
	test('an aborted signal before the write → export.cancelled, no file, no temp', async () => {
		const store = markedStore();
		const job = await endedJob(store, protocol(600).lines);
		for (const format of ['xlsx', 'ods'] as const) {
			const controller = new AbortController();
			const spoolPromise = build(store, job, format, {}, controller.signal);
			queueMicrotask(() => controller.abort());
			await expectCode(spoolPromise, 'export.cancelled');
			expectNoArtifact(job);
		}
	});

	/*
	 * The abort lands INSIDE the writer's row loop, and the spool handed to the
	 * writer IGNORES the signal (a plain row source) — so the only thing that
	 * can stop the walk is the writer's own cancellation check. A writer that
	 * ignored the signal would drain every row and only then meet the door's
	 * post-write check; this measures that it stops early instead.
	 */
	test('an abort mid-rows stops the writer itself early → export.cancelled, no file, no temp', async () => {
		const store = markedStore();
		const { lines, expected } = protocol(600);
		const total = expected.length;
		const job = await endedJob(store, lines);
		const ABORT_AFTER = 5;
		const WRITER_CHECK_EVERY = 256; // spreadsheet.ts sheetRows cadence (an upper bound here)
		for (const [format, realWriter] of [
			['xlsx', xlsxWriter],
			['ods', odsWriter],
		] as const) {
			const controller = new AbortController();
			let pulled = 0;
			let pulledAfterAbort = 0;
			let sinkWritesAfterAbort = 0;
			const writer: ExportWriter = (input, sink, signal) => {
				const spool = input.spool;
				const blindSpool: SpoolReader = {
					...spool, // the reader's methods close over it, never `this`
					async *rows() {
						for await (const row of spool.rows()) {
							pulled++;
							if (controller.signal.aborted) pulledAfterAbort++;
							if (pulled === ABORT_AFTER) controller.abort();
							yield row;
						}
					},
				};
				const countingSink: FileSink = {
					admitScratch: (bytes) => sink.admitScratch(bytes),
					write: (chunk) => {
						if (controller.signal.aborted) sinkWritesAfterAbort++;
						return sink.write(chunk);
					},
					get bytes() {
						return sink.bytes;
					},
				};
				return realWriter({ ...input, spool: blindSpool }, countingSink, signal);
			};
			const promise = buildArtifactFile({
				store,
				job,
				format,
				options: { origin: ORIGIN, showTipoInLabel: false },
				signal: controller.signal,
				writer,
			});
			await expectCode(promise, 'export.cancelled');
			expect(total).toBeGreaterThan(WRITER_CHECK_EVERY + ABORT_AFTER);
			expect(pulled).toBeGreaterThanOrEqual(ABORT_AFTER);
			expect(pulled).toBeLessThanOrEqual(WRITER_CHECK_EVERY + 1);
			expect(pulled).toBeLessThan(total);
			expect(pulledAfterAbort).toBeLessThan(WRITER_CHECK_EVERY);
			expect(sinkWritesAfterAbort).toBeLessThan(WRITER_CHECK_EVERY);
			expectNoArtifact(job);
		}
	});
});
