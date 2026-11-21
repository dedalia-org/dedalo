/**
 * TOOL_EXPORT CSV / TSV / HTML WRITERS — behavioural gate for the server-built
 * delimited and HTML downloads (tools/tool_export/server/writers/{delimited,html}.ts),
 * the ONE formula rule they share with the diffusion csv writer
 * (src/core/files/spreadsheet_formula.ts neutralizeSpreadsheetFormula) and the shared server
 * HTML escaper (src/core/security/html_escape.ts).
 *
 * Every case BUILDS its situation: a scratch export root this file declares
 * (the `.dedalo_test_export_artifacts` marker), a job, a spool written through
 * the store's own writer, the file built through `buildArtifactFile` — then
 * swept. No database, no install TLD. Assertions are on OUTCOMES: file bytes.
 *
 *  A. byte identity vs the FROZEN client file grammar. The browser no longer
 *     builds files (flat_table.js `to_delimited` was deleted when every format
 *     moved server-side), so its grammar is kept HERE, verbatim, as the byte
 *     contract (`frozenClientDelimited`: BOM + header + '\n' rows, its own
 *     inline formula regex — deliberately NOT the server's function, so a drift
 *     on either side is red). The TEXT it formats still comes from the LIVE
 *     client: flat_table.js get_column_label / cell_to_text are imported and
 *     run. CSV and TSV, both label modes, plus a pinned literal;
 *  B. the BOM bytes, formula neutralization (= + - @ TAB CR), TSV collapse,
 *     a mid-stream column landing at its END position with empty earlier cells;
 *  C. HTML: a full standalone document, `<script>` escaped everywhere, unsafe
 *     URL schemes demoted to text, the column order + sparse cells, sub rows;
 *  D. one formula rule: csvField (diffusion) unchanged, and it and the export
 *     cells agree on what is neutralized;
 *  E. scale: N rows written for a large synthetic spool, output streamed in
 *     bounded chunks, and the live heap does NOT SCALE with the spool: each
 *     writer runs in its own child (test/helpers/export_writer_heap_child.ts —
 *     the heap holds that writer and nothing else) over a spool of N and of
 *     4N records, and 4x the spool may add only a small fraction of the extra
 *     file bytes to the sampled peak (a writer that keeps what it wrote adds
 *     about all of them). Measured in-process, against the gate's own
 *     allocations, the same leg flaked (GATE-1 run 3);
 *  F. cancel: an abort mid-write → export.cancelled, no file, no temp; and the
 *     WRITER stops within one row of the abort even over a spool that ignores
 *     the signal (Stop does not depend on the reader's own check).
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isDedaloError } from '../../src/core/errors/dedalo_error.ts';
import { neutralizeSpreadsheetFormula } from '../../src/core/files/spreadsheet_formula.ts';
import { escapeHtml } from '../../src/core/security/html_escape.ts';
import { csvField } from '../../src/diffusion/writers/csv.ts';
import {
	type ArtifactJobRef,
	type ArtifactStore,
	openArtifactStore,
} from '../../tools/tool_export/server/artifact_store.ts';
import { openSpoolReader } from '../../tools/tool_export/server/spool_reader.ts';
import {
	csvCell,
	csvWriter,
	tsvCell,
	tsvWriter,
} from '../../tools/tool_export/server/writers/delimited.ts';
import {
	documentCsp,
	htmlWriter,
	isSafeDocumentUrl,
} from '../../tools/tool_export/server/writers/html.ts';
import { buildArtifactFile } from '../../tools/tool_export/server/writers/index.ts';
import type { FileSink } from '../../tools/tool_export/server/writers/types.ts';
import type { ExportWriterHeapReport } from '../helpers/export_writer_heap_child.ts';
import { markExportArtifactsRoot } from '../helpers/media_scratch_root.ts';

const ORIGIN = 'https://dedalo.writers.example.test';
/** U+FEFF, spelled as a code point (a formatter turns a '\\uFEFF' escape into an invisible literal). */
const BOM = String.fromCharCode(0xfeff);

const scratchDirs: string[] = [];
const globals = globalThis as Record<string, unknown>;
const saved = { window: globals.window, document: globals.document };

// biome-ignore lint/suspicious/noExplicitAny: the client module is untyped JS
let FlatTable: any;

beforeAll(async () => {
	globals.window = { location: { origin: ORIGIN } };
	globals.document = {
		createElement: () => {
			throw new Error('get_column_label / cell_to_text must not touch the DOM');
		},
	};
	const module = (await import('../../tools/tool_export/js/flat_table.js')) as {
		flat_table: unknown;
	};
	FlatTable = module.flat_table;
});

afterAll(() => {
	globals.window = saved.window;
	globals.document = saved.document;
	for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
});

function markedStore(): ArtifactStore {
	const dir = mkdtempSync(join(tmpdir(), 'dedalo_export_writers_'));
	scratchDirs.push(dir);
	return openArtifactStore({
		root: markExportArtifactsRoot(join(dir, 'artifacts')),
		quotaBytes: 0,
		ttlHours: 24,
	});
}

const INIT = {
	userId: 11,
	sectionTipo: 'test3',
	sections: ['test3'],
	options: { data_format: 'standard', breakdown: 'rows' },
	recordScope: 'writer-gate',
	frameColumns: [],
	applicationLang: 'lg-eng',
};

type Line = Record<string, unknown>;

/** An ended job whose spool holds `lines`. */
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
	format: 'csv' | 'tsv' | 'html',
	showTipoInLabel = false,
	signal: AbortSignal = new AbortController().signal,
): Promise<Buffer> {
	const file = await buildArtifactFile({
		store,
		job,
		format,
		options: { origin: ORIGIN, showTipoInLabel },
		signal,
	});
	return readFileSync(join(job.dir, file.basename));
}

/**
 * The file the browser used to build for the same lines — the RETIRED
 * flat_table.js `to_delimited` grammar (HEAD before the server-built files),
 * kept verbatim as the frozen byte contract, prefixed with the BOM its buttons
 * added. Column order = the 'end' line's columns (what finalize() applied);
 * header/cell TEXT = the LIVE client's get_column_label / cell_to_text.
 */
function frozenClientDelimited(
	lines: Line[],
	separator: string,
	quote: boolean,
	showTipo: boolean,
): string {
	const table = new FlatTable({ show_tipo_in_label: showTipo });
	const cols = new Map<number, Line>();
	for (const line of lines) if (line.t === 'col') cols.set(line.i as number, line);
	const end = lines.find((line) => line.t === 'end') as { columns: number[] };
	const rows = lines.filter((line) => line.t === 'row') as { c: Record<string, unknown> }[];
	// verbatim from the retired client (P2-4 / CLI-31, DIFF-E)
	const neutralize = (v: string) => (/^[=+\-@\t\r]/.test(v) ? `'${v}` : v);
	const format = quote
		? (v: unknown) => `"${neutralize(String(v)).replace(/"/g, '""')}"`
		: (v: unknown) => neutralize(String(v)).replace(/[\t\n\r]+/g, ' ');
	const out: string[] = [
		end.columns.map((ordinal) => format(table.get_column_label(cols.get(ordinal)))).join(separator),
	];
	for (const row of rows) {
		out.push(
			end.columns
				.map((ordinal) => format(table.cell_to_text(cols.get(ordinal), row.c[ordinal])))
				.join(separator),
		);
	}
	return BOM + out.join('\n');
}

/** Values covering every quoting / neutralizing / media / non-scalar branch. */
const HOSTILE = [
	'=HYPERLINK("http://evil.test","x")',
	'+1+1',
	'-2',
	'@SUM(A1)',
	'\tstarts with tab',
	'\rstarts with CR',
	'say "hi"; bye',
	'line1\nline2\r\nline3',
	'tab\tinside\t\tcell',
	'<script>alert(1)</script>',
	'Números «ñ» & <b>',
	'',
	'  spaced  ',
	'1;2;3',
];

/**
 * A protocol stream: meta, three cols up front, a col that appears MID-STREAM
 * (record 3, after ordinal 0 — so its end position is 1 with records 1-2
 * empty there), media + iri columns, breakdown sub-rows, sparse cells, a
 * numeric and a non-scalar cell.
 */
function protocol(records: number): Line[] {
	const lines: Line[] = [
		{
			t: 'meta',
			v: 1,
			data_format: 'standard',
			breakdown: 'rows',
			section_tipo: 'test3',
			total: records,
		},
		{
			t: 'col',
			i: 0,
			key: 'section_id',
			label: 'Id',
			cell_type: 'section_id',
			path: [{ component_tipo: 'test102' }],
			after: null,
		},
		{
			t: 'col',
			i: 1,
			key: 'test52',
			label: '=Title "x"',
			cell_type: 'text',
			path: [{ section_tipo: 'test3', component_tipo: 'test52' }],
			after: 0,
		},
		{ t: 'col', i: 3, key: 'img', label: 'Image', cell_type: 'img', after: 1 },
		{ t: 'col', i: 4, key: 'iri', label: '', cell_type: 'iri', after: 3 },
	];
	let rows = 0;
	for (let rec = 1; rec <= records; rec++) {
		if (rec === 3) {
			lines.push({
				t: 'col',
				i: 2,
				key: 'test71',
				label: 'Parent <i>',
				cell_type: 'text',
				path: [{ component_tipo: 'test71' }],
				after: 0,
			});
		}
		const subs = rec % 2 === 0 ? 2 : 1;
		for (let sub = 0; sub < subs; sub++) {
			const c: Record<string, unknown> = {
				'0': rec,
				'1': HOSTILE[(rec + sub) % HOSTILE.length],
			};
			if (rec >= 3) c['2'] = rec === 4 ? { raw: true } : `p${rec}\t${sub}`;
			if (rec % 3 === 0)
				c['3'] = `/dedalo/media/image/1.5MB/0/test3_${rec}.jpg | https://cdn.test/x.jpg`;
			if (rec % 4 === 1)
				c['4'] =
					rec === 5
						? 'javascript:alert(1), http://x.test'
						: `http://iri.test/${rec}, http://b.test`;
			lines.push({ t: 'row', rec, sub, c });
			rows++;
		}
	}
	lines.push({ t: 'end', columns: [0, 2, 1, 3, 4], rows, records });
	return lines;
}

// ---------------------------------------------------------------------------

describe('A. byte identity with the frozen client file grammar', () => {
	for (const showTipo of [false, true]) {
		test(`CSV == the client's ';'-quoted file (show_tipo_in_label=${showTipo})`, async () => {
			const store = markedStore();
			const lines = protocol(14);
			const job = await endedJob(store, lines);
			const built = await build(store, job, 'csv', showTipo);
			expect(built.toString('utf8')).toBe(frozenClientDelimited(lines, ';', true, showTipo));
		});

		test(`TSV == the client's tab file (show_tipo_in_label=${showTipo})`, async () => {
			const store = markedStore();
			const lines = protocol(14);
			const job = await endedJob(store, lines);
			const built = await build(store, job, 'tsv', showTipo);
			expect(built.toString('utf8')).toBe(frozenClientDelimited(lines, '\t', false, showTipo));
		});
	}

	test('anti-vacuity: the text really comes from the live client, and a pinned literal holds', async () => {
		// the live client's label rule is what the oracle ran (tipo suffix)
		expect(
			frozenClientDelimited(protocol(3), ';', true, true).startsWith(`${BOM}"Id [test102]";`),
		).toBe(true);
		// one record, pinned byte for byte (both sides must agree with THIS)
		const lines: Line[] = [
			{ t: 'col', i: 0, key: 'section_id', label: 'Id', cell_type: 'section_id' },
			{ t: 'col', i: 1, key: 'img', label: 'Image', cell_type: 'img' },
			{ t: 'row', rec: 1, sub: 0, c: { '0': 1, '1': '/m/a.jpg |  | http://x.test/b.jpg' } },
			{ t: 'row', rec: 2, sub: 0, c: { '0': '=2' } },
			{ t: 'end', columns: [1, 0], rows: 2, records: 2 },
		];
		const pinned = `${BOM}"Image";"Id"\n"${ORIGIN}/m/a.jpg | http://x.test/b.jpg";"1"\n"";"'=2"`;
		expect(frozenClientDelimited(lines, ';', true, false)).toBe(pinned);
		const store = markedStore();
		const job = await endedJob(store, lines);
		expect((await build(store, job, 'csv')).toString('utf8')).toBe(pinned);
	});
});

describe('B. delimited outcomes', () => {
	test('the file starts with the UTF-8 BOM bytes EF BB BF (CSV and TSV)', async () => {
		const store = markedStore();
		const job = await endedJob(store, protocol(2));
		for (const format of ['csv', 'tsv'] as const) {
			const built = await build(store, job, format);
			expect([...built.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
			// exactly one BOM
			expect(built[3]).not.toBe(0xef);
		}
	});

	test('formula-leading values are neutralized in CSV and TSV; TSV has no raw tab/newline in a cell', async () => {
		const store = markedStore();
		const job = await endedJob(store, protocol(14));
		const csv = (await build(store, job, 'csv')).toString('utf8');
		// header label '=Title "x"' is neutralized too
		expect(csv).toContain(`"'=Title ""x"""`);
		expect(csv).toContain(`"'=HYPERLINK(""http://evil.test"",""x"")"`);
		expect(csv).toContain(`"'+1+1"`);
		expect(csv).toContain(`"'-2"`);
		expect(csv).toContain(`"'@SUM(A1)"`);
		expect(csv).toContain(`"'\tstarts with tab"`);
		expect(csv).toContain(`"'\rstarts with CR"`);
		// no field starts with a formula character
		const fieldStarts = [...csv.matchAll(/(?:^|;|\n)"([^"]?)/g)].map((m) => m[1]);
		for (const start of fieldStarts) expect(['=', '+', '-', '@', '\t', '\r']).not.toContain(start);

		const tsv = (await build(store, job, 'tsv')).toString('utf8').slice(1);
		const tsvLines = tsv.split('\n');
		const width = tsvLines[0]?.split('\t').length;
		expect(width).toBe(5);
		for (const line of tsvLines) {
			expect(line.split('\t')).toHaveLength(5); // no cell smuggled a tab or newline
			for (const cell of line.split('\t')) {
				expect(['=', '+', '-', '@']).not.toContain(cell[0]);
			}
		}
		expect(tsv).toContain(`'=HYPERLINK("http://evil.test","x")`);
		expect(tsv).toContain("' starts with tab");
		expect(tsv).toContain('tab inside cell');
	});

	test('a column that appears mid-stream lands at its END position; earlier records carry an empty cell there', async () => {
		const store = markedStore();
		const job = await endedJob(store, protocol(4));
		const lines = (await build(store, job, 'csv')).toString('utf8').slice(1).split('\n');
		expect(lines[0]).toBe(`"Id";"Parent <i>";"'=Title ""x""";"Image";"iri"`);
		const cells = lines.map((line) => line.split(';'));
		// rec 1 and rec 2 (two sub rows): column 'Parent' (position 1) empty
		expect(cells[1]?.[0]).toBe('"1"');
		expect(cells[1]?.[1]).toBe('""');
		expect(cells[2]?.[1]).toBe('""');
		expect(cells[3]?.[1]).toBe('""');
		// rec 3: filled
		expect(cells[4]?.[0]).toBe('"3"');
		expect(cells[4]?.[1]).toBe('"p3\t0"');
		// media made absolute with the captured origin
		expect(lines[4]).toContain(
			`"${ORIGIN}/dedalo/media/image/1.5MB/0/test3_3.jpg | https://cdn.test/x.jpg"`,
		);
	});

	test('the delimited cell functions ARE the client format functions', () => {
		for (const value of HOSTILE) {
			expect(csvCell(value)).toBe(`"${neutralizeSpreadsheetFormula(value).replace(/"/g, '""')}"`);
			expect(tsvCell(value)).toBe(neutralizeSpreadsheetFormula(value).replace(/[\t\n\r]+/g, ' '));
		}
	});
});

describe('C. HTML', () => {
	test('a standalone document: header + every row in end order, everything escaped', async () => {
		const store = markedStore();
		const lines = protocol(12);
		const job = await endedJob(store, lines);
		const html = (await build(store, job, 'html')).toString('utf8');
		expect(html.startsWith('<!doctype html>\n<html><head><meta charset="utf-8">')).toBe(true);
		expect(html.trimEnd().endsWith('</table>\n</body></html>')).toBe(true);
		expect(html).toContain('Content-Security-Policy');
		// no live script anywhere; the hostile value survives as text
		expect(html).not.toMatch(/<script/i);
		expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
		expect(html).toContain('Números «ñ» &amp; &lt;b&gt;');
		// header: order 0,2,1,3,4 with title = key; label escaped
		const header = /<tr class="row_header">(.*?)<\/tr>/.exec(html)?.[1] ?? '';
		expect(header).toBe(
			'<th title="section_id">Id</th><th title="test71">Parent &lt;i&gt;</th>' +
				'<th title="test52">=Title &quot;x&quot;</th><th title="img">Image</th><th title="iri">iri</th>',
		);
		const bodyRows = [...html.matchAll(/<tr(?: class="sub_row")?>([\s\S]*?)<\/tr>/g)];
		const rowCount = lines.filter((line) => line.t === 'row').length;
		expect(bodyRows).toHaveLength(rowCount);
		expect(html.match(/<tr class="sub_row">/g)?.length).toBe(
			lines.filter((line) => line.t === 'row' && (line.sub as number) > 0).length,
		);
		for (const row of bodyRows) expect(row[1]?.match(/<td>/g)).toHaveLength(5);
		// rec 1: the mid-stream column is an empty cell at position 1
		expect(bodyRows[0]?.[1]?.startsWith('<td>1</td><td></td>')).toBe(true);
		// media thumbnails with the absolute URL
		expect(html).toContain(
			`<img class="export_media_thumb" loading="lazy" src="${ORIGIN}/dedalo/media/image/1.5MB/0/test3_3.jpg" alt="">`,
		);
		// a safe IRI is a link to its first value; javascript: is text, never an href
		expect(html).toContain(
			'<a href="http://iri.test/1" target="_blank" rel="noopener noreferrer">',
		);
		expect(html).toContain('<td>javascript:alert(1), http://x.test</td>');
		expect(html).not.toMatch(/href="\s*javascript/i);
	});

	test('the URL rule: relative and http(s)/ftp/mailto only, obfuscated schemes refused', () => {
		for (const ok of [
			'/dedalo/media/a.jpg',
			'https://x.test/a',
			'HTTP://x',
			'mailto:a@b.test',
			'a/b:c',
			'?q=1',
		]) {
			expect(isSafeDocumentUrl(ok), ok).toBe(true);
		}
		for (const bad of [
			'javascript:alert(1)',
			' java\tscript:x',
			'JaVaScRiPt:x',
			'data:text/html,x',
			'vbscript:x',
			'',
			// protocol-relative: opened from disk, file://host/x (a UNC fetch on Windows)
			'//evil.test/x.jpg',
			' //evil.test/x.jpg',
			'\\\\evil.test\\share\\x.jpg',
			'/\\evil.test/x.jpg',
			'\\/evil.test/x.jpg',
		]) {
			expect(isSafeDocumentUrl(bad), bad).toBe(false);
		}
	});

	test('the file CSP loads images from the captured origin only — never *', () => {
		expect(documentCsp('https://archive.example.test')).toContain(
			'img-src https://archive.example.test data:;',
		);
		expect(documentCsp('')).toContain('img-src data:;');
		for (const origin of ['', 'https://archive.example.test']) {
			const csp = documentCsp(origin);
			expect(csp).not.toMatch(/img-src[^;]*\*/);
			expect(csp).toContain("default-src 'none'");
		}
	});

	test('escapeHtml: ENT_QUOTES, & first', () => {
		expect(escapeHtml(`<a href="x" onclick='y'>&lt;</a>`)).toBe(
			'&lt;a href=&quot;x&quot; onclick=&#039;y&#039;&gt;&amp;lt;&lt;/a&gt;',
		);
		expect(escapeHtml(undefined)).toBe('');
		expect(escapeHtml(null)).toBe('');
	});
});

describe('D. one formula rule', () => {
	test('csvField (diffusion) is unchanged and runs the same neutralizer', () => {
		expect(csvField('=1+1')).toBe(`'=1+1`);
		expect(csvField('-2,3')).toBe(`"'-2,3"`);
		expect(csvField('@x"y')).toBe(`"'@x""y"`);
		expect(csvField('\tx')).toBe(`'\tx`);
		expect(csvField('\rx')).toBe(`"'\rx"`);
		expect(csvField('plain')).toBe('plain');
		expect(csvField('a,b')).toBe('"a,b"');
		for (const lead of ['=', '+', '-', '@', '\t', '\r']) {
			expect(neutralizeSpreadsheetFormula(`${lead}v`)).toBe(`'${lead}v`);
		}
		for (const lead of ['a', ' ', "'", '#', '1']) {
			expect(neutralizeSpreadsheetFormula(`${lead}v`)).toBe(`${lead}v`);
		}
	});
});

const WRITERS = [
	['csv', csvWriter],
	['tsv', tsvWriter],
	['html', htmlWriter],
] as const;

/** The measured process of leg E (test/helpers/export_writer_heap_child.ts). */
const HEAP_CHILD = join(import.meta.dir, '..', 'helpers', 'export_writer_heap_child.ts');
/** Leg E spool sizes: the large spool is SCALE × the small one. */
const SCALE_SMALL_RECORDS = 15_000;
const SCALE = 4;
/** Rows between two live-heap samples in the child. */
const SCALE_SAMPLE_EVERY = 500;
const SCALE_FILLER = 'x'.repeat(180);

/** An ended job of `records` one-row records (id + a ~190-char title). */
async function scaleJob(store: ArtifactStore, records: number): Promise<ArtifactJobRef> {
	const { job } = await store.createJob(INIT);
	const writer = await store.openSpoolWriter(job, { indexEvery: 100 });
	await writer.write({ t: 'meta', v: 1, section_tipo: 'test3', total: records });
	await writer.write({
		t: 'col',
		i: 0,
		key: 'id',
		label: 'Id',
		cell_type: 'section_id',
		after: null,
	});
	await writer.write({
		t: 'col',
		i: 1,
		key: 'test52',
		label: 'Title',
		cell_type: 'text',
		after: 0,
	});
	for (let rec = 1; rec <= records; rec++) {
		await writer.write({ t: 'row', rec, sub: 0, c: { '0': rec, '1': `${rec} ${SCALE_FILLER}` } });
	}
	await writer.write({ t: 'end', columns: [0, 1], rows: records, records });
	await writer.close();
	await store.updateManifest(job, { status: 'ended' });
	return job;
}

/** Run `format`'s writer over `job` in a fresh child; its report. */
async function measureWriterHeap(
	format: string,
	job: ArtifactJobRef,
): Promise<ExportWriterHeapReport> {
	const child = Bun.spawn(
		[process.execPath, 'run', HEAP_CHILD, format, job.dir, String(SCALE_SAMPLE_EVERY)],
		// the preload-repointed env: the child's module graph opens the SUITE pool, never the app DB
		{ env: { ...process.env }, stdout: 'pipe', stderr: 'pipe' },
	);
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	if (exitCode !== 0) {
		throw new Error(`heap child (${format}) exited ${exitCode}: ${stderr.slice(-2000)}`);
	}
	return JSON.parse(stdout.trim().split('\n').at(-1) ?? '') as ExportWriterHeapReport;
}

describe('E. scale: bounded memory', () => {
	test('N rows written for a large spool, streamed in bounded chunks; live heap does not scale with the spool', async () => {
		const store = markedStore();
		const small = SCALE_SMALL_RECORDS;
		const large = SCALE * SCALE_SMALL_RECORDS;
		const smallJob = await scaleJob(store, small);
		const largeJob = await scaleJob(store, large);

		for (const [name] of WRITERS) {
			// each size in its own process: the heap holds the writer and nothing else
			const atSmall = await measureWriterHeap(name, smallJob);
			const atLarge = await measureWriterHeap(name, largeJob);
			for (const [report, records] of [
				[atSmall, small],
				[atLarge, large],
			] as const) {
				expect(report.rows, name).toBe(records);
				expect(report.bytes, name).toBeGreaterThan(records * 180);
				// streamed: none larger than one buffer + a line
				expect(report.largestChunk, name).toBeLessThan(256 * 1024);
				// anti-vacuity: the probe sampled the whole walk, not a corner of it
				expect(report.samples, name).toBe(Math.floor(records / SCALE_SAMPLE_EVERY));
			}
			// streamed: many writes over the large file
			expect(atLarge.writes, name).toBeGreaterThan(100);
			// bounded: SCALE× the spool adds ~(SCALE-1)× the file to a writer that
			// keeps what it wrote (a growing buffer, every line, every chunk); a
			// streaming writer's live heap is one buffer whatever the size
			const fileGrowth = atLarge.bytes - atSmall.bytes;
			const heapGrowth = atLarge.peakGrowth - atSmall.peakGrowth;
			expect(
				heapGrowth,
				`${name}: ${SCALE}× the spool grew the peak live heap by ${heapGrowth} (peaks ${atSmall.peakGrowth} → ${atLarge.peakGrowth}) for ${fileGrowth} more file bytes`,
			).toBeLessThan(fileGrowth / 8);
		}
	}, 120_000);
});

// ---------------------------------------------------------------------------

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
	let caught: unknown = null;
	try {
		await promise;
	} catch (error) {
		caught = error;
	}
	expect(isDedaloError(caught), `expected ${code}, got ${String(caught)}`).toBe(true);
	expect((caught as { code: string }).code).toBe(code);
}

/** A job dir holds only the spool + manifest (no built file, no temp). */
function expectNoArtifact(job: ArtifactJobRef): void {
	expect(readdirSync(job.dir).sort()).toEqual([
		'cols.ndjson',
		'grid.idx',
		'grid.ndjson',
		'manifest.json',
		'request.json',
	]);
}

describe('F. cancel', () => {
	test('an aborted signal mid-write → export.cancelled, no file, no temp (csv, tsv, html)', async () => {
		const store = markedStore();
		const job = await endedJob(store, protocol(600));
		for (const [format] of WRITERS) {
			const controller = new AbortController();
			const pending = build(store, job, format, false, controller.signal);
			queueMicrotask(() => controller.abort());
			await expectCode(pending, 'export.cancelled');
			expectNoArtifact(job);
		}
	});

	test('the WRITER stops within one row of the abort, even over a spool that ignores the signal', async () => {
		const store = markedStore();
		const records = 4_000;
		const filler = 'y'.repeat(120);
		const lines: Line[] = [
			{ t: 'meta', v: 1, section_tipo: 'test3', total: records },
			{ t: 'col', i: 0, key: 'id', label: 'Id', cell_type: 'section_id', after: null },
			{ t: 'col', i: 1, key: 'test52', label: 'Title', cell_type: 'text', after: 0 },
		];
		for (let rec = 1; rec <= records; rec++) {
			lines.push({ t: 'row', rec, sub: 0, c: { '0': rec, '1': `${rec} ${filler}` } });
		}
		lines.push({ t: 'end', columns: [0, 1], rows: records, records });
		const job = await endedJob(store, lines);
		const manifest = await store.readManifest(job);
		const real = openSpoolReader(job.dir, { indexEvery: manifest.index_every });

		for (const [name, write] of WRITERS) {
			let yielded = 0;
			// a spool whose rows() drops the signal: only the writer's own check can stop it
			const deaf = {
				...real,
				async *rows() {
					for await (const row of real.rows()) {
						yielded++;
						yield row;
					}
				},
			};
			const controller = new AbortController();
			let yieldedAtAbort = -1;
			let bytes = 0;
			const sink: FileSink = {
				// a text writer never logs scratch bytes; nothing to meter
				async admitScratch() {},
				async write(chunk) {
					bytes += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.byteLength;
					if (yieldedAtAbort < 0 && yielded > 0) {
						yieldedAtAbort = yielded;
						controller.abort();
					}
				},
				get bytes() {
					return bytes;
				},
			};
			await expectCode(
				write(
					{ spool: deaf, manifest, options: { origin: ORIGIN, showTipoInLabel: false } },
					sink,
					controller.signal,
				),
				'export.cancelled',
			);
			// anti-vacuity: the abort landed mid-stream, far from the end
			expect(yieldedAtAbort, name).toBeGreaterThan(0);
			expect(yieldedAtAbort, name).toBeLessThan(records / 2);
			// prompt: at most the one row already in flight was pulled after the abort
			expect(yielded - yieldedAtAbort, name).toBeLessThanOrEqual(1);
		}
	});
});
