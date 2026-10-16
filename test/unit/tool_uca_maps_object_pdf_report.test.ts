/**
 * tool_uca_maps — `object_pdf_report` and the dependency-free PDF writer under
 * it. The writer is verified by an outside reader (Poppler's `pdftotext` and
 * `pdfimages`), never by asserting on the bytes it wrote: wrong xref offsets,
 * stream lengths or WinAnsi encoding only show when a real reader opens the file.
 */

import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { config } from '../../src/config/config.ts';
import { scanContextFromItem, scanFilesInfo } from '../../src/core/media/files_info.ts';
import { buildMediaLocation } from '../../src/core/media/path.ts';
import { requireTestMediaRoot } from '../../src/core/media/test_media_root.ts';
import { resolveMediaToolContext } from '../../src/core/media/tool_support.ts';
import type { GatedToolActionSpec } from '../../src/core/tools/module.ts';
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
	textWidth,
	wrapText,
} from '../../tools/tool_uca_maps/server/pdf_writer.ts';
import { contextOf, expectCode, loadAction } from './fixtures/tool_uca_maps/helpers.ts';

const scratch = mkdtempSync(join(tmpdir(), 'uca_pdf_'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

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

describe('tool_uca_maps object_pdf_report — the per-image gate', () => {
	test('the per-image gate IS the get_image_file spec, not a second hand-written check', async () => {
		const declared = (await loadAction('get_image_file')) as GatedToolActionSpec;
		expect(String(IMAGE_READ_GATE.permission)).toBe(String(declared.permission));
		expect(Number(IMAGE_READ_GATE.minLevel)).toBe(Number(declared.minLevel));
		expect(IMAGE_READ_GATE.handler).toBe(declared.handler);
	});
});

describe('toMercator / reprojectCoordinates', () => {
	test('a known point lands where EPSG:3857 puts it', () => {
		// Sagunto, roughly — checked against the standard spherical formula
		const [x, y] = toMercator(-0.2726, 39.6766);
		expect(x).toBeCloseTo(-30345.69, 1);
		expect(y).toBeCloseTo(4819057.36, 1);
	});

	test('the pole is clamped to the projection limit, never Infinity in the document', () => {
		expect(toMercator(0, 90)[1]).toBe(toMercator(0, 85.05112878)[1]);
		expect(toMercator(0, -90)[1]).toBe(toMercator(0, -85.05112878)[1]);
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
		let refusal: unknown;
		try {
			readRequestedImages('rsc170');
		} catch (error) {
			refusal = error;
		}
		expectCode(refusal, 'request.invalid_options');
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

	test("a geometry's coordinates wrap between pairs, in one pass, without losing a char", () => {
		const ring: number[][] = [];
		for (let i = 0; i <= 3000; i++) ring.push([-0.4123456789 + i * 1e-5, 39.4123456789 + i * 1e-5]);
		const json = JSON.stringify([ring]);
		// 3000 vertices: enough for a quadratic cut to take seconds, and the wrap
		// is synchronous, so it would hold the whole server that long
		const started = performance.now();
		const lines = wrapText(json, 9, false, 480);
		expect(performance.now() - started).toBeLessThan(1000);
		expect(lines.length).toBeGreaterThan(10);
		expect(lines.join('')).toBe(json);
		for (const line of lines.slice(0, -1)) expect(line.endsWith('],')).toBe(true);
		for (const line of lines) expect(textWidth(line, 9, false)).toBeLessThanOrEqual(480);
	});

	test('accented, unencodable and bold text wraps within the line, every char kept', () => {
		const word = 'áéíóú文ñ'.repeat(60);
		const lines = wrapText(word, 10, true, 200);
		expect(lines.length).toBeGreaterThan(1);
		expect(lines.join('')).toBe(word);
		for (const line of lines) expect(textWidth(line, 10, true)).toBeLessThanOrEqual(200);
	});

	test('readJpegInfo refuses what it cannot embed', () => {
		expect(readJpegInfo(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBeNull(); // a PNG
		expect(readJpegInfo(new Uint8Array([]))).toBeNull();
	});

	test('readJpegInfo reads a gray or RGB frame and refuses a CMYK one', () => {
		// SOI, then an SOF0 segment: precision, height 261, width 519, the component count
		const frame = (components: number) =>
			new Uint8Array([
				0xff,
				0xd8,
				0xff,
				0xc0,
				0x00,
				8 + components * 3,
				0x08,
				0x01,
				0x05,
				0x02,
				0x07,
				components,
				...Array.from({ length: components }, (_value, index) => [index + 1, 0x11, 0x00]).flat(),
			]);
		expect(readJpegInfo(frame(1))).toEqual({ width: 519, height: 261, components: 1 });
		expect(readJpegInfo(frame(3))).toEqual({ width: 519, height: 261, components: 3 });
		expect(readJpegInfo(frame(4))).toBeNull();
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
		// 13.5 pt leading on a 730 pt column is 54 lines a page; Poppler ends
		// every page with a form feed
		expect(text.split('\f').length - 1).toBe(5);
	});
});

/** ImageMagick 7, or 6's `convert`: what builds a real JPEG for these gates. */
const MAGICK = Bun.which('magick') ?? Bun.which('convert');
const HAVE_MAGICK = MAGICK !== null;

/** A real encoder's 2x2 JPEG, built at test time rather than checked in as a blob. */
async function tinyJpeg(): Promise<Uint8Array> {
	const target = join(scratch, 'tiny.jpg');
	const proc = Bun.spawn([MAGICK ?? 'magick', '-size', '2x2', 'xc:red', target], {
		stdout: 'pipe',
		stderr: 'pipe',
	});
	expect(await proc.exited).toBe(0);
	return new Uint8Array(await Bun.file(target).arrayBuffer());
}

/** Poppler's image listing of `bytes`: one row per image it found. */
async function pdfImages(
	bytes: Uint8Array,
	name: string,
): Promise<{ rows: string[]; errors: string }> {
	const pdfPath = join(scratch, `${name}.pdf`);
	writeFileSync(pdfPath, bytes);
	const proc = Bun.spawn(['pdfimages', '-list', pdfPath], { stdout: 'pipe', stderr: 'pipe' });
	const [listing, errors] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	expect(await proc.exited).toBe(0);
	// a two-line header, then the images
	return { rows: listing.trim().split('\n').slice(2), errors };
}

describe('pdf_writer — an embedded image is really IN the file', () => {
	// the text round trip stays green with a broken `/XObject` key (pdf.image()
	// still answers true, so no "could not be embedded" note): only an image
	// reader shows that the pictures are gone
	test.skipIf(!HAVE_MAGICK)(
		'Poppler finds the image, and reports no syntax error doing it (needs ImageMagick)',
		async () => {
			const pdf = new PdfDocument();
			pdf.text('con imagen', { size: 12 });
			expect(pdf.image(await tinyJpeg())).toBe(true);

			const { rows, errors } = await pdfImages(pdf.build(), 'embedded');
			expect(errors).not.toMatch(/Syntax Error/);
			expect(rows).toHaveLength(1);
			expect(rows[0]).toMatch(/jpeg/i);
		},
	);
});

describe('objectPdfReport — the whole document', () => {
	test('refuses a request with no geometry at all, or one that is not an object', async () => {
		await expect(objectPdfReport(contextOf({}))).rejects.toMatchObject({
			code: 'request.invalid_options',
		});
		await expect(objectPdfReport(contextOf({ geojson: 'texto' }))).rejects.toMatchObject({
			code: 'request.invalid_options',
		});
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

	// test99 is the generic TLD's component_image: a real JPEG is planted at
	// this id in the suite's MARKED media root, so only the gate can keep it out
	const IMAGE = { section_tipo: 'test3', tipo: 'test99', section_id: 905104 };

	/** The slot's files and stored items: anything here is a residue. */
	async function slotResidue(): Promise<string[]> {
		const { spec, identity, pathOpts, items } = await resolveMediaToolContext(IMAGE);
		const files = scanFilesInfo(spec, identity, pathOpts, scanContextFromItem(items[0]))
			.filter((entry) => entry.file_exist)
			.map((entry) => String(entry.file_path));
		return items.length === 0 ? files : [...files, `${items.length} stored media item(s)`];
	}

	/** Runs `body` with a JPEG at the slot's default quality, then removes it and its dirs. */
	async function withPlantedJpeg<T>(body: () => Promise<T>): Promise<T> {
		requireTestMediaRoot(config.media.rootPath ?? '', 'tool_uca_maps_object_pdf_report.test');
		expect(await slotResidue(), 'residue in test3/test99/905104 before planting').toHaveLength(0);
		const { spec, identity, pathOpts } = await resolveMediaToolContext(IMAGE);
		const location = buildMediaLocation(spec, identity, spec.defaultQuality, 'jpg', pathOpts);
		const created = mkdirSync(dirname(location.absolutePath), { recursive: true });
		try {
			writeFileSync(location.absolutePath, await tinyJpeg());
			return await body();
		} finally {
			rmSync(location.absolutePath, { force: true });
			for (let dir = dirname(location.absolutePath); created !== undefined; dir = dirname(dir)) {
				rmdirSync(dir);
				if (dir === created) break;
			}
			expect(await slotResidue(), 'residue in test3/test99/905104 after the test').toHaveLength(0);
		}
	}

	async function reportFor(userId: number, isGlobalAdmin: boolean): Promise<Uint8Array> {
		const response = await objectPdfReport({
			principal: { userId, isGlobalAdmin, isDeveloper: false },
			userId,
			options: {
				section_tipo: 'test2',
				tipo: 'test52',
				section_id: 905101,
				geojson: {
					type: 'Feature',
					properties: {},
					geometry: { type: 'Point', coordinates: [0, 0] },
				},
				images: [{ ...IMAGE, name: 'secreta.jpg' }],
			},
			background: false,
		});
		return new Uint8Array(
			Buffer.from((response.data as { content_base64: string }).content_base64, 'base64'),
		);
	}

	test('an image the caller may not read is NAMED in the document as refused', async () => {
		const text = await pdfText(await reportFor(7, false), 'forbidden');
		expect(text).toContain('secreta.jpg');
		expect(text).toContain('you may not read this record');
		expect(text).not.toContain('could not be embedded');
	});

	test.skipIf(!HAVE_MAGICK)(
		'a refused image is left out although it embeds for a caller who may read it (needs ImageMagick)',
		async () => {
			await withPlantedJpeg(async () => {
				const refused = await reportFor(7, false);
				expect(await pdfText(refused, 'forbidden_planted')).toContain(
					'you may not read this record',
				);
				expect((await pdfImages(refused, 'forbidden_planted')).rows).toHaveLength(0);

				// control: the same record, for a caller who may read it, is embedded
				const allowed = await reportFor(-1, true);
				expect(await pdfText(allowed, 'allowed')).not.toContain('Not included');
				expect((await pdfImages(allowed, 'allowed')).rows).toHaveLength(1);
			});
		},
	);
});
