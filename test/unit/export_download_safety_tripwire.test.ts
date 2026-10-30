/**
 * TRIPWIRE — an export download does not truncate silently, and does not
 * execute (P2-4 / CLI-25, CLI-31). MEASURED ON THE BYTES OF EVERY WRITER.
 *
 * CLI-25. The HTML export built its data: URL as
 * `'data:text/text;charset=utf-8,' + html.outerHTML` — RAW. A `#` ANYWHERE in the
 * markup begins the URL fragment, so the browser stopped reading there and the
 * file still arrived with the expected name, NO error and NO truncation marker.
 * `#` is ordinary in heritage text (`Inv. #1234`). The same block appended
 * `<body>` INSIDE `<head>` and used the invented MIME `text/text`.
 *
 * CLI-31. DIFF-E was fixed on the ENGINE's CSV writer (src/diffusion/writers/
 * csv.ts) and never mirrored onto tool_export's CLIENT writer. A cell beginning
 * =, +, -, @, TAB or CR is EXECUTED AS A FORMULA by Excel, Sheets and
 * LibreOffice, and quoting does not stop it. So a curator's export of a
 * contributor-authored catalogue was a spreadsheet that could execute on open.
 *
 * SINCE 2026-09 (tool_export at scale) every download is a file the SERVER
 * builds from the ended spool (tools/tool_export/server/writers/), through one
 * door (`buildArtifactFile`). This gate therefore asserts OUTCOMES on the bytes
 * that door writes — never a spelling of any writer's source:
 *
 *  1. CENSUS = THE REGISTRY. `EXPORT_WRITERS` is the set of producers; every
 *     format in it carries a declared SAFETY CLASS here, and the map's key set
 *     equals the registry's (a new writer is red until it says how it is safe, a removed one
 *     leaves a stale row that is red too).
 *  2. Per class, the hazard payloads (every formula lead, `<script>`, a `#`, an
 *     unsafe IRI) are built through the real door and the file is read back by
 *     an INDEPENDENT reader:
 *       delimited   — first bytes EF BB BF; no cell starts a formula; a formula
 *                     payload reads back as `'` + payload (the engine's rule);
 *       spreadsheet — no formula construct anywhere in any sheet (XLSX `<f>`,
 *                     ODS `table:formula`), every cell a STRING cell, the payload
 *                     reads back as literal text, no raw `<script` in any part;
 *       markup      — a complete standalone document (head closes before body,
 *                     ends in </html>, a `#` value intact), `<script>` escaped,
 *                     an unsafe IRI demoted to text, its own no-script CSP;
 *       lossless    — every line is JSON and the payload round-trips exactly
 *                     (not a spreadsheet, not markup: fidelity IS its contract);
 *       archive     — no cell text is written as a cell; the format needs the
 *                     database and is driven by its own DB-tier gate, named here
 *                     and required to exist.
 *  3. ONE RULE, BOTH SIDES. The divergence CLI-31 was (one writer fixed, one
 *     not) is measured, not trusted: for EVERY ASCII lead character (plus
 *     look-alikes) the CSV and TSV files neutralize exactly when the diffusion
 *     engine's `csvField` does.
 *  4. NO BROWSER-BUILT EXPORT. The converse of 1: no client/tool/engine source
 *     builds a download itself (a data:text|application URI or a Blob of an
 *     export MIME). EMPTY outside a shrink-only, reasoned exemption map.
 *
 * WHERE THE OLD (source-spelling) PROPERTIES LIVE NOW — the rewrite drops none:
 *  - "the HTML export encodes its payload / a '#' cannot truncate" → there is no
 *    data: URL any more; leg 2 markup asserts a `#` value arrives and the
 *    document is complete. The client never builds a download itself: leg 4
 *    here is the census (any data:text|application URI, any Blob typed as an
 *    export MIME — CLI-25's `data:text/text` + outerHTML spelling is its
 *    positive control) and it must stay EMPTY outside named exemptions;
 *    ingest_encoding_tripwire's narrower CSV/TSV census stays for DATA-09.
 *  - "a real MIME type and a real document (<body> not inside <head>)" → leg 2
 *    markup (document shape); the served Content-Type per format is
 *    FORMAT_SPECS, asserted here to be the real type for every class, and the
 *    route's headers by test/unit/export_artifact_download_native.test.ts.
 *  - "the CSV/TSV writer neutralizes formulas, in BOTH formats" → leg 2
 *    delimited, both formats built.
 *  - "the client class IS the engine class, character for character" → leg 3,
 *    on output bytes over the whole ASCII lead range.
 *  - "anti-vacuity: the engine rule still exists" → leg 3's positive control
 *    (`csvField('=1')` neutralizes) + the census floor.
 *
 * TIER: HERMETIC (no database): the scratch store is a marked temp dir.
 */

import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { csvField } from '../../src/diffusion/writers/csv.ts';
import {
	EXPORT_FORMATS,
	type ExportFormat,
	FORMAT_SPECS,
} from '../../tools/tool_export/server/artifact_store.ts';
import { EXPORT_WRITERS } from '../../tools/tool_export/server/writers/index.ts';
import {
	buildExportBytes,
	type ExportProtocolLine,
	endedExportJob,
	parseExportCsv,
	parseExportTsv,
	scratchExportStore,
	singleColumnExport,
} from '../helpers/export_writer_fixture.ts';
import { shippedTextFiles } from '../helpers/shipped_text_corpus.ts';
import { stripComments } from '../helpers/strip_comments.ts';
import {
	descendants,
	parseXml,
	readZip,
	type XmlElement,
	zipText,
} from '../helpers/zip_xml_reader.ts';

const REPO_ROOT = join(import.meta.dir, '..', '..');

/** This gate's scratch tree (a marked export root per build under it). */
const SCRATCH = mkdtempSync(join(tmpdir(), 'dedalo_export_safety_'));
let storeSeq = 0;
const newStore = () => scratchExportStore(SCRATCH, `artifacts_${++storeSeq}`);

afterAll(() => {
	rmSync(SCRATCH, { recursive: true, force: true });
});

type SafetyClass =
	| { kind: 'delimited' }
	| { kind: 'spreadsheet'; container: 'xlsx' | 'ods' }
	| { kind: 'markup' }
	| { kind: 'lossless' }
	| { kind: 'archive'; drivenBy: string; reason: string };

/**
 * How each registered writer is safe. EXACT over EXPORT_WRITERS (equal key sets) —
 * adding a writer means saying here which outcome proves it safe.
 */
const WRITER_SAFETY: Readonly<Record<string, SafetyClass>> = {
	csv: { kind: 'delimited' },
	tsv: { kind: 'delimited' },
	xlsx: { kind: 'spreadsheet', container: 'xlsx' },
	ods: { kind: 'spreadsheet', container: 'ods' },
	html: { kind: 'markup' },
	ndjson: { kind: 'lossless' },
	media_zip: {
		kind: 'archive',
		drivenBy: 'test/unit/tool_export_media_zip_native.test.ts',
		reason:
			'entries are media FILES resolved per record from the database (never cell text); the one text member, info.txt, is a plain-text listing inside a zip. Building it needs Postgres, so its gate is DB-tier.',
	},
};

/** The served Content-Type every class must carry (a real type, never text/text). */
const CONTENT_TYPE_OF_CLASS: Readonly<Record<SafetyClass['kind'], RegExp>> = {
	delimited: /^text\/(csv|tab-separated-values); charset=utf-8$/,
	spreadsheet:
		/^application\/vnd\.(openxmlformats-officedocument\.spreadsheetml\.sheet|oasis\.opendocument\.spreadsheet)$/,
	markup: /^text\/html; charset=utf-8$/,
	lossless: /^application\/x-ndjson; charset=utf-8$/,
	archive: /^application\/zip$/,
};

/** The characters a spreadsheet reads as the start of a formula (DIFF-E). */
const FORMULA_LEAD = /^[=+\-@\t\r]/;

const FORMULA_PAYLOADS = [
	'=HYPERLINK("http://evil.example.test","click")',
	'+1+1',
	'-2+3',
	'@SUM(1,2)',
	'\tTAB-led',
	'\rCR-led',
] as const;
const SCRIPT_PAYLOAD = '<script>alert(1)</script>';
const HASH_PAYLOAD = 'Inv. #1234 & <b>bold</b> "quoted"';
const UNSAFE_IRI = 'javascript:alert(1)';
const TAIL_MARKER = 'TAIL-MARKER-after-the-hash';

/** A three-column export: text (hazards), iri, text tail — one record per hazard. */
function hazardExport(): ExportProtocolLine[] {
	const texts = [...FORMULA_PAYLOADS, SCRIPT_PAYLOAD, HASH_PAYLOAD];
	const lines: ExportProtocolLine[] = [
		{ t: 'meta', v: 1, data_format: 'standard', breakdown: 'rows', section_tipo: 'test3' },
		{ t: 'col', i: 0, key: 'value', label: '=HEADER()', cell_type: 'text', after: null },
		{ t: 'col', i: 1, key: 'iri', label: 'Link', cell_type: 'iri', after: 0 },
		{ t: 'col', i: 2, key: 'tail', label: 'Tail', cell_type: 'text', after: 1 },
	];
	texts.forEach((text, index) => {
		lines.push({
			t: 'row',
			rec: index + 1,
			sub: 0,
			c: { '0': text, '1': UNSAFE_IRI, '2': TAIL_MARKER },
		});
	});
	lines.push({ t: 'end', columns: [0, 1, 2], rows: texts.length, records: texts.length });
	return lines;
}

const BOM_BYTES = [0xef, 0xbb, 0xbf];

async function buildHazard(format: ExportFormat): Promise<Buffer> {
	const store = newStore();
	return buildExportBytes(store, await endedExportJob(store, hazardExport()), format);
}

function textOf(element: XmlElement): string {
	return element.children
		.map((child) => (typeof child === 'string' ? child : textOf(child)))
		.join('');
}

function anyAttr(element: XmlElement, predicate: (name: string) => boolean): boolean {
	if (Object.keys(element.attrs).some(predicate)) return true;
	return element.children.some((child) => typeof child !== 'string' && anyAttr(child, predicate));
}

// ---------------------------------------------------------------------------
// 1. CENSUS = THE REGISTRY
// ---------------------------------------------------------------------------

describe('census: every registered writer declares how it is safe', () => {
	test('the safety map is EXACT over EXPORT_WRITERS (and EXPORT_FORMATS)', () => {
		const registered = Object.keys(EXPORT_WRITERS).sort();
		// the floor: a registry that shrank to nothing proves nothing
		expect(registered.length).toBeGreaterThanOrEqual(6);
		expect(registered).toEqual([...EXPORT_FORMATS].sort());
		expect(Object.keys(WRITER_SAFETY).sort()).toEqual(registered);
	});

	test('every format is served with the real Content-Type of its class', () => {
		for (const format of EXPORT_FORMATS) {
			const safety = WRITER_SAFETY[format] as SafetyClass;
			expect(FORMAT_SPECS[format].contentType, `${format}`).toMatch(
				CONTENT_TYPE_OF_CLASS[safety.kind],
			);
		}
	});

	test('an archive class names a gate that exists and drives it', () => {
		for (const [format, safety] of Object.entries(WRITER_SAFETY)) {
			if (safety.kind !== 'archive') continue;
			expect(safety.reason.length, format).toBeGreaterThan(40);
			expect(existsSync(join(REPO_ROOT, safety.drivenBy)), safety.drivenBy).toBe(true);
			// the named gate really builds this format (it imports the writer the registry holds)
			const gate = readFileSync(join(REPO_ROOT, safety.drivenBy), 'utf8');
			expect(gate, `${safety.drivenBy} does not drive ${format}`).toContain(
				'server/writers/media_zip.ts',
			);
		}
	});
});

// ---------------------------------------------------------------------------
// 2. OUTCOMES, per class, on the bytes the door writes
// ---------------------------------------------------------------------------

const formatsOf = (kind: SafetyClass['kind']): ExportFormat[] =>
	EXPORT_FORMATS.filter((format) => WRITER_SAFETY[format]?.kind === kind);

describe('delimited: BOM first, and no cell can start a formula', () => {
	test('the class is not empty (CSV and TSV are both in it)', () => {
		expect(formatsOf('delimited')).toEqual(['csv', 'tsv']);
	});

	for (const format of formatsOf('delimited')) {
		test(`${format}: first bytes EF BB BF, every formula lead neutralized, <script> is inert data`, async () => {
			const bytes = await buildHazard(format);
			expect([...bytes.subarray(0, 3)]).toEqual(BOM_BYTES);
			const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(3));
			const records = format === 'csv' ? parseExportCsv(text) : parseExportTsv(text);
			// header + one record per hazard, three fields each: the reader is really reading
			expect(records.length).toBe(1 + FORMULA_PAYLOADS.length + 2);
			for (const record of records) expect(record.length).toBe(3);

			// NO cell (header included) starts a formula
			const leaders = records.flat().filter((cell) => FORMULA_LEAD.test(cell));
			expect(leaders, `${format}: a cell a spreadsheet would execute`).toEqual([]);

			// …and the formula payloads are KEPT, prefixed with the engine's apostrophe
			const collapse = (value: string): string =>
				format === 'tsv' ? value.replace(/[\t\n\r]+/g, ' ') : value;
			expect(records[0]?.[0]).toBe(collapse("'=HEADER()"));
			FORMULA_PAYLOADS.forEach((payload, index) => {
				expect(records[index + 1]?.[0]).toBe(collapse(`'${payload}`));
			});
			// data, not markup — a spreadsheet does not run HTML; the file is served as text/csv|tsv
			expect(records[FORMULA_PAYLOADS.length + 1]?.[0]).toBe(SCRIPT_PAYLOAD);
			expect(records[FORMULA_PAYLOADS.length + 2]?.[0]).toBe(HASH_PAYLOAD);
			expect(records.at(-1)?.[2]).toBe(TAIL_MARKER);
		});
	}
});

describe('spreadsheet: no formula construct exists, every cell is a string cell', () => {
	test('the class is not empty (XLSX and ODS are both in it)', () => {
		expect(formatsOf('spreadsheet')).toEqual(['xlsx', 'ods']);
	});

	for (const format of formatsOf('spreadsheet')) {
		test(`${format}: formulas stay literal text, <script> never raw`, async () => {
			const zip = readZip(await buildHazard(format));
			const xmlParts = zip.entries.filter((entry) => entry.name.endsWith('.xml'));
			expect(xmlParts.length).toBeGreaterThan(0);
			for (const part of xmlParts) {
				const raw = zipText(zip, part.name);
				expect(raw.toLowerCase(), `${part.name}: raw <script`).not.toContain('<script');
				parseXml(raw); // well-formed, or the reader throws
			}

			const sheets =
				format === 'xlsx'
					? zip.entries
							.filter((entry) => /^xl\/worksheets\/[^/]+\.xml$/.test(entry.name))
							.map((entry) => parseXml(zipText(zip, entry.name)))
					: [parseXml(zipText(zip, 'content.xml'))];
			expect(sheets.length).toBeGreaterThan(0);

			const cellTexts: string[] = [];
			for (const sheet of sheets) {
				if (format === 'xlsx') {
					// no formula element, and every cell is an inline STRING
					expect(descendants(sheet, 'f'), 'xlsx <f> formula element').toEqual([]);
					const cells = descendants(sheet, 'c');
					expect(cells.length).toBeGreaterThan(0);
					for (const cell of cells) {
						expect(cell.attrs.t, `xlsx cell ${cell.attrs.r} type`).toBe('inlineStr');
						cellTexts.push(descendants(cell, 't').map(textOf).join(''));
					}
				} else {
					// no formula attribute anywhere, and every filled cell is a STRING cell
					expect(
						anyAttr(sheet, (name) => name === 'table:formula'),
						'ods table:formula attribute',
					).toBe(false);
					const cells = descendants(sheet, 'table:table-cell').filter(
						(cell) => descendants(cell, 'text:p').length > 0,
					);
					expect(cells.length).toBeGreaterThan(0);
					for (const cell of cells) {
						expect(cell.attrs['office:value-type'], 'ods cell value-type').toBe('string');
						cellTexts.push(descendants(cell, 'text:p').map(textOf).join(''));
					}
				}
			}
			// a string cell IS the neutralization: the payload reads back literally
			expect(cellTexts).toContain('=HEADER()');
			expect(cellTexts).toContain(FORMULA_PAYLOADS[0]);
			expect(cellTexts).toContain('@SUM(1,2)');
			expect(cellTexts).toContain(SCRIPT_PAYLOAD);
			expect(cellTexts).toContain(HASH_PAYLOAD);
		});
	}
});

describe('markup: a complete document that runs nothing', () => {
	test('the class is exactly the HTML writer', () => {
		expect(formatsOf('markup')).toEqual(['html']);
	});

	for (const format of formatsOf('markup')) {
		test(`${format}: complete (a '#' does not truncate), <script> escaped, unsafe IRI inert`, async () => {
			const html = new TextDecoder('utf-8', { fatal: true }).decode(await buildHazard(format));
			const lower = html.toLowerCase();
			// a real, complete standalone document: <body> is a SIBLING of <head>
			expect(lower.startsWith('<!doctype html>')).toBe(true);
			const headClose = lower.indexOf('</head>');
			const bodyOpen = lower.indexOf('<body');
			expect(headClose).toBeGreaterThan(-1);
			expect(bodyOpen, '<body> opens inside <head>').toBeGreaterThan(headClose);
			expect(html.trimEnd().endsWith('</html>')).toBe(true);
			// the '#' value arrives whole, and so does everything after it
			expect(html).toContain('Inv. #1234 &amp; &lt;b&gt;bold&lt;/b&gt; &quot;quoted&quot;');
			expect(html.split(TAIL_MARKER).length - 1).toBe(FORMULA_PAYLOADS.length + 2);
			// nothing executes: no script element, the payload is text
			expect(lower).not.toContain('<script');
			expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
			expect(lower).not.toMatch(/\son[a-z]+\s*=/);
			// the javascript: IRI is visible text, never an href/src
			expect(lower).not.toMatch(/(href|src)\s*=\s*"\s*javascript:/);
			expect(html.split(UNSAFE_IRI).length - 1).toBe(FORMULA_PAYLOADS.length + 2);
			// its own policy forbids script even when opened from disk
			const csp = /<meta http-equiv="Content-Security-Policy" content="([^"]+)"/
				.exec(html)?.[1]
				?.replace(/&#0?39;|&apos;/g, "'");
			expect(csp).toContain("default-src 'none'");
			expect(csp).not.toContain('script-src');
		});

		test(`${format}: ATTRIBUTE context — a safe-scheme IRI / media URL carrying quotes and brackets cannot break out of href= / src=`, async () => {
			const store = newStore();
			const html = new TextDecoder('utf-8', { fatal: true }).decode(
				await buildExportBytes(store, await endedExportJob(store, attributeHazardExport()), format),
			);
			// every start tag in the document, parsed attribute by attribute: a
			// tag must be EXACTLY `<name` + ` attr="value"`* (+ ` attr`) + `>`, no
			// attribute named on*, and no raw '<' inside a value
			const tags = [...html.matchAll(/<([a-zA-Z][a-zA-Z0-9]*)([^>]*)>/g)];
			const hrefs: string[] = [];
			const srcs: string[] = [];
			for (const [whole, , rest = ''] of tags) {
				const attrs = [...rest.matchAll(/\s+([a-zA-Z-]+)(?:="([^"<]*)")?/g)];
				expect(attrs.map((a) => a[0]).join(''), `stray token in ${whole}`).toBe(
					rest.replace(/\s*\/?$/, ''),
				);
				for (const [, name = '', value = ''] of attrs) {
					expect(name.toLowerCase().startsWith('on'), `${name} in ${whole}`).toBe(false);
					if (name === 'href') hrefs.push(decodeHtmlAttr(value));
					if (name === 'src') srcs.push(decodeHtmlAttr(value));
				}
			}
			// the attribute contexts were REALLY exercised: the hostile values ARE
			// the href / src (escaped), not demoted to text
			expect(hrefs).toContain(BREAKOUT_IRI);
			expect(srcs).toContain(`${EXPORT_ORIGIN}${BREAKOUT_MEDIA}`);
			expect(html.toLowerCase()).not.toContain('<script');
		});
	}
});

/** The origin buildExportBytes makes media URLs absolute with (its default). */
const EXPORT_ORIGIN = 'https://dedalo.fixture.example.test';
/** A safe-scheme IRI / relative media URL that close their attribute if unescaped. */
const BREAKOUT_IRI = 'https://iri.example.test/a" onmouseover="alert(1)" x="<script>';
const BREAKOUT_MEDIA = `/dedalo/media/a.jpg' onerror='alert(2)' "><script>alert(3)</script>`;

function attributeHazardExport(): ExportProtocolLine[] {
	return [
		{ t: 'meta', v: 1, data_format: 'standard', breakdown: 'rows', section_tipo: 'test3' },
		{ t: 'col', i: 0, key: 'iri', label: 'Link', cell_type: 'iri', after: null },
		{ t: 'col', i: 1, key: 'img', label: 'Image', cell_type: 'img', after: 0 },
		{ t: 'row', rec: 1, sub: 0, c: { '0': BREAKOUT_IRI, '1': BREAKOUT_MEDIA } },
		{ t: 'end', columns: [0, 1], rows: 1, records: 1 },
	];
}

/** The inverse of the server escaper, for reading an attribute value back. */
function decodeHtmlAttr(value: string): string {
	return value
		.replace(/&quot;/g, '"')
		.replace(/&#0?39;|&apos;/g, "'")
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&amp;/g, '&');
}

describe('lossless: every line is JSON and the payload round-trips exactly', () => {
	test('the class is exactly the NDJSON writer', () => {
		expect(formatsOf('lossless')).toEqual(['ndjson']);
	});

	for (const format of formatsOf('lossless')) {
		test(`${format}: the spool, byte-faithful`, async () => {
			const text = new TextDecoder('utf-8', { fatal: true }).decode(await buildHazard(format));
			const lines = text.split('\n').filter((line) => line !== '');
			const parsed = lines.map((line) => JSON.parse(line) as ExportProtocolLine);
			expect(parsed).toEqual(hazardExport());
		});
	}
});

// ---------------------------------------------------------------------------
// 3. ONE RULE, BOTH SIDES — measured over the whole ASCII lead range
// ---------------------------------------------------------------------------

describe('one formula rule: the export files neutralize exactly when the engine does', () => {
	/** Every ASCII lead character, plus look-alikes a spreadsheet does NOT treat as formulas. */
	const LEADS = [
		...Array.from({ length: 128 }, (_, code) => String.fromCharCode(code)),
		'＝', // FULLWIDTH EQUALS SIGN
		'−', // MINUS SIGN
		'＋', // FULLWIDTH PLUS SIGN
		'＠', // FULLWIDTH COMMERCIAL AT
	];
	const VALUES = LEADS.map((lead) => `${lead}x`);

	/** Does the diffusion engine's csvField prefix the apostrophe? */
	const engineNeutralizes = (value: string): boolean => {
		const field = csvField(value);
		const unquoted = field.startsWith('"') ? field.slice(1, -1).replace(/""/g, '"') : field;
		return unquoted === `'${value}`;
	};

	test('positive control: the engine rule exists and bites', () => {
		expect(engineNeutralizes('=1')).toBe(true);
		expect(engineNeutralizes('1')).toBe(false);
		// the rule neutralizes exactly the documented DIFF-E class — no more, no less
		expect(VALUES.filter(engineNeutralizes).map((value) => value[0])).toEqual([
			'\t',
			'\r',
			'+',
			'-',
			'=',
			'@',
		]);
	});

	for (const format of ['csv', 'tsv'] as const) {
		test(`${format}: agreement on all ${VALUES.length} lead characters`, async () => {
			const store = newStore();
			const bytes = await buildExportBytes(
				store,
				await endedExportJob(store, singleColumnExport(VALUES)),
				format,
			);
			const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(3));
			// TSV collapses [\t\n\r] runs — so a record may not be split on a '\n' inside a
			// value; the CSV reader keeps quoted newlines.
			const records = format === 'csv' ? parseExportCsv(text) : parseExportTsv(text);
			expect(records.length).toBe(1 + VALUES.length);
			const collapse = (value: string): string =>
				format === 'tsv' ? value.replace(/[\t\n\r]+/g, ' ') : value;
			const divergent: string[] = [];
			VALUES.forEach((value, index) => {
				const cell = records[index + 1]?.[0] ?? '';
				const writerNeutralizes = cell === collapse(`'${value}`);
				const writerLiteral = cell === collapse(value);
				expect(writerNeutralizes || writerLiteral, `U+${value.charCodeAt(0).toString(16)}`).toBe(
					true,
				);
				if (writerNeutralizes !== engineNeutralizes(value)) {
					divergent.push(`U+${value.charCodeAt(0).toString(16).padStart(4, '0')}`);
				}
			});
			expect(divergent, `${format} and the engine disagree on these lead characters`).toEqual([]);
		});
	}
});

// ---------------------------------------------------------------------------
// 4. No client code builds an export-shaped download itself (CLI-25's home)
// ---------------------------------------------------------------------------

/**
 * A download the BROWSER builds: a `data:text/…` or `data:application/…` URI
 * (a MIME followed by its `;`/`,` parameter separator — a bare MIME string, as
 * in a sanitizer's `startsWith('data:text/html')`, is not a download), or a Blob
 * typed as an export MIME (delimited text, markup, the old `text/text`, an
 * office-document `application/vnd.*`). CLI-25 was exactly this: an HTML export
 * built as `'data:text/text;charset=utf-8,' + html.outerHTML`, cut short at the
 * first `#` in a record value. The server builds every export now, so the census
 * of these must be EMPTY outside CLIENT_DOWNLOAD_EXEMPT.
 */
const CLIENT_DOWNLOAD_SHAPE =
	/data:(?:text|application)\/[\w.+-]+\s*[;,]|new\s+Blob\s*\([^)]*type\s*:\s*['"`](?:text\/(?:csv|tsv|tab-separated-values|html|text)|application\/(?:vnd\.|xhtml|octet-stream))/;

/**
 * SHRINK-ONLY: a browser-built download that is NOT an export, with the reason.
 * A stale entry (the file no longer builds one) is red.
 */
const CLIENT_DOWNLOAD_EXEMPT: Readonly<Record<string, string>> = {};

/**
 * The shipped code files, from the registered shared lister
 * (test/helpers/shipped_text_corpus.ts — census_derivation_tripwire refuses a
 * gate that picks its own walk root). Narrowed to code by FILE, never by root.
 */
function clientDownloadCorpus(): string[] {
	return shippedTextFiles().filter(
		(file) =>
			/\.(?:ts|js|mjs)$/.test(file) &&
			!file.endsWith('.test.ts') &&
			// Vendored/minified third-party bundles are not our code; the browser
			// suite builds fixtures, not downloads.
			!file.includes('/lib/') &&
			!file.includes('.min.') &&
			!file.includes('/test/client/'),
	);
}

function clientDownloadSites(file: string): string[] {
	return stripComments(readFileSync(join(REPO_ROOT, file), 'utf-8'))
		.split('\n')
		.filter((line) => CLIENT_DOWNLOAD_SHAPE.test(line))
		.map((line) => `${file}: ${line.trim()}`);
}

describe('no client code builds an export download itself', () => {
	test('positive control: every shape the old client used is recognized; non-downloads are not', () => {
		for (const hit of [
			"'data:text/text;charset=utf-8,' + html.outerHTML", // CLI-25, verbatim shape
			"'data:text/html;charset=utf-8,' + html.outerHTML",
			"'data:text/html,' + encodeURIComponent(html)",
			"'data:text/csv;charset=utf-8,' + x",
			"'data:application/vnd.ms-excel;base64,' + b64",
			"new Blob([html], {type: 'text/html'})",
			"new Blob([csv], {type: 'text/csv'})",
			"new Blob([x], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })",
		]) {
			expect(CLIENT_DOWNLOAD_SHAPE.test(hit), hit).toBe(true);
		}
		for (const miss of [
			"s.startsWith('data:text/html')", // a sanitizer's scheme check
			"s.startsWith('data:application/')",
			"new Blob([payload], {type:'text/plain'})", // a sendBeacon body
			"new Blob([json], {type: 'octet/stream'})",
		]) {
			expect(CLIENT_DOWNLOAD_SHAPE.test(miss), miss).toBe(false);
		}
	});

	test('the census is EMPTY outside the named exemptions (the corpus is not)', () => {
		const corpus = clientDownloadCorpus();
		expect(corpus.length).toBeGreaterThan(1000);
		const sites = corpus
			.filter((file) => !(file in CLIENT_DOWNLOAD_EXEMPT))
			.flatMap(clientDownloadSites);
		expect(sites).toEqual([]);
	});

	test('every exemption is reasoned and still a download (a stale one is red)', () => {
		for (const [file, reason] of Object.entries(CLIENT_DOWNLOAD_EXEMPT)) {
			expect(reason.length).toBeGreaterThan(40);
			expect(clientDownloadSites(file).length).toBeGreaterThan(0);
		}
	});
});
