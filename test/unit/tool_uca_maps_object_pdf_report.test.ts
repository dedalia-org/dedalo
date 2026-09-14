/**
 * tool_uca_maps — `object_pdf_report` (fila #3, "Exportar como PDF") and the
 * dependency-free PDF writer underneath it.
 *
 * THE GATE THAT MATTERS. The request names images to embed. This pins that
 * the per-image gate the handler applies is LITERALLY the spec `get_image_file`
 * declares — not a second, hand-written check that could quietly weaken.
 *
 * THE WRITER IS VERIFIED BY AN OUTSIDE READER, not by asserting on the bytes
 * this repo produced. `pdftotext` (Poppler, already a media-engine dependency
 * — src/core/media/engine/pdf.ts) opens the file and reads its text back: if
 * the cross-reference offsets, the stream lengths or the WinAnsi encoding were
 * wrong, the text would not come back — or would come back as mojibake. That
 * is the whole point of a hand-written writer having a round-trip gate.
 *
 * Accents are the specific trap: the content stream is BYTES, and encoding it
 * as UTF-8 (the obvious mistake) both corrupts every accented character and
 * desynchronises every `/Length`. A Spanish record title is therefore an
 * assertion here, not decoration.
 */

import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getLoadedTool } from '../../src/core/tools/loader.ts';
import type { GatedToolActionSpec, ToolActionContext } from '../../src/core/tools/module.ts';
import {
	IMAGE_READ_GATE,
	objectPdfReport,
	printableProperties,
	readRequestedImages,
	reprojectCoordinates,
	toMercator,
} from '../../tools/tool_uca_maps/server/pdf_report.ts';
import {
	encodeWinAnsi,
	PdfDocument,
	readJpegInfo,
	wrapText,
} from '../../tools/tool_uca_maps/server/pdf_writer.ts';
import { mustGet } from '../helpers/assert.ts';

const scratch = mkdtempSync(join(tmpdir(), 'uca_pdf_'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function contextOf(options: Record<string, unknown>): ToolActionContext {
	return {
		principal: { userId: -1, isGlobalAdmin: true, isDeveloper: true },
		userId: -1,
		options: { section_tipo: 'test2', tipo: 'test52', section_id: 905101, ...options },
		background: false,
	};
}

/** Run the produced PDF through Poppler and give back its text. */
async function pdfText(bytes: Uint8Array, name: string): Promise<string> {
	const pdfPath = join(scratch, `${name}.pdf`);
	const txtPath = join(scratch, `${name}.txt`);
	writeFileSync(pdfPath, bytes);
	const proc = Bun.spawn(['pdftotext', '-enc', 'UTF-8', pdfPath, txtPath], {
		stdout: 'pipe',
		stderr: 'pipe',
	});
	const code = await proc.exited;
	expect(code).toBe(0);
	return await Bun.file(txtPath).text();
}

describe('tool_uca_maps object_pdf_report — declared gate', () => {
	test('is record_tipo at read level (1)', async () => {
		const loaded = await getLoadedTool('tool_uca_maps');
		const action = mustGet(
			loaded?.module.apiActions.object_pdf_report,
			'object_pdf_report',
		) as GatedToolActionSpec;
		expect(action.permission).toBe('record_tipo');
		expect(action.minLevel).toBe(1);
	});

	test('the per-image gate IS the get_image_file spec, not a second hand-written check', async () => {
		const loaded = await getLoadedTool('tool_uca_maps');
		const declared = mustGet(
			loaded?.module.apiActions.get_image_file,
			'get_image_file',
		) as GatedToolActionSpec;
		expect(String(IMAGE_READ_GATE.permission)).toBe(String(declared.permission));
		expect(Number(IMAGE_READ_GATE.minLevel)).toBe(Number(declared.minLevel));
		expect(IMAGE_READ_GATE.handler).toBe(declared.handler);
	});
});

describe('toMercator / reprojectCoordinates', () => {
	test('the origin stays the origin', () => {
		const [x, y] = toMercator(0, 0);
		expect(x).toBeCloseTo(0, 6);
		expect(y).toBeCloseTo(0, 6);
	});

	test('a known point lands where EPSG:3857 puts it', () => {
		// Sagunto, roughly — checked against the standard spherical formula
		const [x, y] = toMercator(-0.2726, 39.6766);
		expect(x).toBeCloseTo(-30345.69, 1);
		expect(y).toBeCloseTo(4819057.36, 1);
	});

	test('the pole is clamped, never Infinity in the document', () => {
		expect(Number.isFinite(toMercator(0, 90)[1])).toBe(true);
		expect(Number.isFinite(toMercator(0, -90)[1])).toBe(true);
	});

	test('a nested polygon ring is reprojected at every depth', () => {
		const ring = [
			[
				[0, 0],
				[1, 1],
			],
		];
		const out = reprojectCoordinates(ring) as number[][][];
		expect(out[0]?.[0]).toEqual([0, 0]);
		expect(out[0]?.[1]?.[0]).toBeCloseTo(111319.49, 1);
	});
});

describe('printableProperties — v6 filter, verbatim', () => {
	test('keeps scalars and drops nulls, the two internal keys and every object', () => {
		expect(
			printableProperties({
				name: 'Muralla',
				area: 412,
				color: '#ff0000',
				layer_id: 3,
				missing: null,
				uca_maps: { images: [1, 2] },
			}),
		).toEqual([
			['name', 'Muralla'],
			['area', '412'],
		]);
	});

	test('a non-object is simply empty, never a throw', () => {
		expect(printableProperties(null)).toEqual([]);
		expect(printableProperties('nope')).toEqual([]);
	});
});

describe('readRequestedImages — what may be asked for', () => {
	test('reads a well-formed entry', () => {
		expect(
			readRequestedImages([
				{ section_tipo: 'rsc170', section_id: 12, tipo: 'rsc29', name: 'a.jpg' },
			]),
		).toEqual([{ section_tipo: 'rsc170', section_id: 12, tipo: 'rsc29', name: 'a.jpg' }]);
	});

	test('a file path is NOT a way to name an image — only record identity is read', () => {
		const [first] = readRequestedImages([
			{
				section_tipo: 'rsc170',
				section_id: 12,
				tipo: 'rsc29',
				file_path: '/etc/passwd',
				absolutePath: '/etc/passwd',
			},
		]);
		expect(first).toBeDefined();
		expect(Object.keys(first as object).sort()).toEqual([
			'name',
			'section_id',
			'section_tipo',
			'tipo',
		]);
	});

	test('malformed entries are skipped and the list is capped at 30', () => {
		const many = Array.from({ length: 40 }, (_value, index) => ({
			section_tipo: 'rsc170',
			section_id: index,
			tipo: 'rsc29',
		}));
		expect(readRequestedImages(many)).toHaveLength(30);
		expect(readRequestedImages([{ section_tipo: 'rsc170' }, null, 7])).toEqual([]);
	});

	test('nothing asked for is not an error', () => {
		expect(readRequestedImages(undefined)).toEqual([]);
	});

	test('a non-list is refused as request.invalid_options', () => {
		expect(() => readRequestedImages('rsc170')).toThrow();
	});
});

describe('pdf_writer — encoding and wrapping', () => {
	test('WinAnsi keeps Western-European accents as one byte each', () => {
		expect(Array.from(encodeWinAnsi('áéíóúñüç'))).toEqual([
			0xe1, 0xe9, 0xed, 0xf3, 0xfa, 0xf1, 0xfc, 0xe7,
		]);
	});

	test('a codepoint the encoding cannot express is visibly a question mark, never dropped', () => {
		expect(Array.from(encodeWinAnsi('文'))).toEqual([0x3f]);
		expect(encodeWinAnsi('a文b')).toHaveLength(3);
	});

	test('a word longer than the line is broken rather than run off the page', () => {
		const lines = wrapText('x'.repeat(500), 10, false, 200);
		expect(lines.length).toBeGreaterThan(1);
		expect(lines.join('')).toBe('x'.repeat(500));
	});

	test('readJpegInfo refuses what it cannot embed', () => {
		expect(readJpegInfo(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBeNull(); // a PNG
		expect(readJpegInfo(new Uint8Array([]))).toBeNull();
	});
});

describe('pdf_writer — the file a real reader sees', () => {
	test('Poppler opens the document and reads its text back, accents included', async () => {
		const pdf = new PdfDocument();
		pdf.text('Propiedades del objeto', { size: 18, bold: true });
		pdf.rule();
		pdf.text('Muralla de la Almoina — año 1238', { size: 10 });
		pdf.text('Coordenadas: -0,2726 / 39,6766', { size: 10 });

		const text = await pdfText(pdf.build(), 'accents');

		expect(text).toContain('Propiedades del objeto');
		expect(text).toContain('Muralla de la Almoina');
		expect(text).toContain('año 1238');
	});

	test('content longer than one page really becomes more than one page', async () => {
		const pdf = new PdfDocument();
		for (let index = 0; index < 220; index++) {
			pdf.text(`line number ${index}`, { size: 10 });
		}
		const text = await pdfText(pdf.build(), 'paged');

		expect(text).toContain('line number 0');
		expect(text).toContain('line number 219');
		// Poppler separates pages with a form feed
		expect(text).toContain('\f');
	});
});

/**
 * The smallest real JPEG this suite can assert on: a 2x2 solid block, encoded
 * once and embedded verbatim. Built with ImageMagick at test time rather than
 * checked in as a base64 blob, so the bytes are a real encoder's output.
 */
async function tinyJpeg(): Promise<Uint8Array | null> {
	const target = join(scratch, 'tiny.jpg');
	for (const binary of ['magick', 'convert']) {
		const proc = Bun.spawn([binary, '-size', '2x2', 'xc:red', target], {
			stdout: 'pipe',
			stderr: 'pipe',
		});
		if ((await proc.exited) === 0) {
			return new Uint8Array(await Bun.file(target).arrayBuffer());
		}
	}
	return null;
}

describe('pdf_writer — an embedded image is really IN the file', () => {
	/**
	 * THE REGRESSION THIS EXISTS FOR. The `/XObject` resource key was written
	 * without its leading slash, so every reader rejected the dictionary and
	 * dropped the image — while the text round trip above stayed perfectly
	 * green and `pdf.image()` still answered `true`, so the report printed no
	 * "could not be embedded" note either. A document with captions and no
	 * pictures, silently. Text is not evidence that an image embedded; only
	 * an image reader is.
	 */
	test('Poppler finds the image, and reports no syntax error doing it', async () => {
		const jpeg = await tinyJpeg();
		if (jpeg === null) {
			// no ImageMagick here: skipping is honest, inventing JPEG bytes is not
			return;
		}

		const pdf = new PdfDocument();
		pdf.text('con imagen', { size: 12 });
		expect(pdf.image(jpeg)).toBe(true);

		const pdfPath = join(scratch, 'embedded.pdf');
		writeFileSync(pdfPath, pdf.build());

		const proc = Bun.spawn(['pdfimages', '-list', pdfPath], {
			stdout: 'pipe',
			stderr: 'pipe',
		});
		const [listing, errors] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
		]);
		await proc.exited;

		expect(errors).not.toMatch(/Syntax Error/);
		// the listing has a header row plus one row per image found
		expect(listing.trim().split('\n').length).toBeGreaterThan(2);
		expect(listing).toMatch(/jpeg/i);
	});
});

describe('objectPdfReport — the whole document', () => {
	test('refuses a request with no geometry at all', async () => {
		expect(objectPdfReport(contextOf({}))).rejects.toThrow();
	});

	test('builds a readable report from an object with properties and a geometry', async () => {
		const response = await objectPdfReport(
			contextOf({
				elevation: 412,
				geojson: {
					type: 'Feature',
					properties: { name: 'Muralla', área: '1.240 m²' },
					geometry: { type: 'Point', coordinates: [-0.2726, 39.6766] },
				},
			}),
		);

		const data = response.data as { content_base64: string; filename: string; mime: string };
		expect(data.mime).toBe('application/pdf');
		expect(data.filename).toBe('uca_maps_object.pdf');

		const text = await pdfText(
			new Uint8Array(Buffer.from(data.content_base64, 'base64')),
			'report',
		);

		expect(text).toContain('Object properties');
		expect(text).toContain('Muralla');
		expect(text).toContain('1.240 m²');
		expect(text).toContain('Elevation: 412 m');
		expect(text).toContain('EPSG:4326');
		expect(text).toContain('EPSG:3857');
		// the reprojected coordinate really is the Mercator one, not a copy
		expect(text).toContain('-30345');
	});

	test('an image the caller may not read is NAMED in the document, never silently dropped', async () => {
		const response = await objectPdfReport({
			principal: { userId: 7, isGlobalAdmin: false, isDeveloper: false },
			userId: 7,
			options: {
				section_tipo: 'test2',
				tipo: 'test52',
				section_id: 905101,
				geojson: {
					type: 'Feature',
					properties: {},
					geometry: { type: 'Point', coordinates: [0, 0] },
				},
				images: [
					{ section_tipo: 'rsc170', section_id: 999999, tipo: 'rsc29', name: 'secreta.jpg' },
				],
			},
			background: false,
		});

		const data = response.data as { content_base64: string };
		const text = await pdfText(
			new Uint8Array(Buffer.from(data.content_base64, 'base64')),
			'forbidden',
		);

		expect(text).toContain('secreta.jpg');
		expect(text).toMatch(/Not included/);
	});
});
