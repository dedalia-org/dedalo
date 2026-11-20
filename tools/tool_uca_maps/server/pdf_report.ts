/**
 * `object_pdf_report`: the selected object's properties, geometry and images as
 * one PDF (v6 `special_tools.js` `create_pdf`, built in the browser from a CDN
 * script that `script-src 'self'` blocks). The request names images by RECORD
 * identity only, never a file path, and each one passes the same `record_tipo`
 * gate as `get_image_file`; a refused image is named in the document.
 */

import type { ToolActionContext, ToolResponse } from '../../../src/core/tools/module.ts';
import { assertActionPermission } from '../../../src/core/tools/security.ts';
import { OBJECT_GEOJSON_KEY_DIR } from '../js/upload_formats.js';
import { downloadAnswer } from './download_answer.ts';
import { type EmbedRefusal, getImageFile, resolveEmbeddableImage } from './image_media.ts';
import { PdfDocument } from './pdf_writer.ts';
import { invalidOptions } from './reasons.ts';
import { takeStagedJson } from './staged_upload.ts';
import { toWebMercator } from './web_mercator.ts';

/** v6's own cap for the same document ("Imágenes asociadas (Max. 30)"). */
const MAX_IMAGES = 30;

/** The gate every embedded image passes: the spec `get_image_file` declares in
 * `index.ts`, pinned equal to it by a unit gate so the two cannot drift. */
export const IMAGE_READ_GATE = {
	permission: 'record_tipo',
	minLevel: 1,
	handler: getImageFile,
} as const;

/** Negative zero is a real IEEE value and a nonsense coordinate. */
function normalizeZero(value: number): number {
	return Object.is(value, -0) ? 0 : value;
}

/** Reproject a GeoJSON coordinate tree of any nesting depth, in place-free
 * fashion (a new tree), leaving anything that is not a coordinate pair alone. */
export function reprojectCoordinates(coordinates: unknown): unknown {
	if (!Array.isArray(coordinates)) {
		return coordinates;
	}
	if (typeof coordinates[0] === 'number' && typeof coordinates[1] === 'number') {
		const [x, y] = toWebMercator([coordinates[1], coordinates[0]]);
		// `(-0).toFixed(2)` is "-0.00", and `Number("-0.00")` is negative zero:
		// the prime meridian would be printed as "-0" in every document
		return [normalizeZero(Number(x.toFixed(2))), normalizeZero(Number(y.toFixed(2)))];
	}
	return coordinates.map((entry) => reprojectCoordinates(entry));
}

/**
 * The properties the document prints. v6's own filter, verbatim: a null
 * value, the two internal keys, and anything that is not a scalar are all
 * skipped — `uca_maps` (this tool's own bucket, which holds the image
 * descriptors printed further down) is an object and falls out here for free.
 */
export function printableProperties(properties: unknown): Array<[string, string]> {
	if (typeof properties !== 'object' || properties === null) {
		return [];
	}
	const rows: Array<[string, string]> = [];
	for (const [key, value] of Object.entries(properties as Record<string, unknown>)) {
		if (value === null || value === undefined) continue;
		if (key === 'color' || key === 'layer_id') continue;
		if (typeof value === 'object') continue;
		rows.push([key, String(value)]);
	}
	return rows;
}

/** One image the caller asked to embed, as it arrives in the request. */
interface RequestedImage {
	section_tipo: string;
	section_id: number;
	tipo: string;
	name: string | null;
}

/** Reads the requested images, refusing a malformed list rather than
 * silently producing a document with nothing in it. */
export function readRequestedImages(raw: unknown): RequestedImage[] {
	if (raw === undefined || raw === null) {
		return [];
	}
	if (!Array.isArray(raw)) {
		throw invalidOptions('tool_uca_maps: images must be a list');
	}
	const images: RequestedImage[] = [];
	for (const entry of raw.slice(0, MAX_IMAGES)) {
		if (typeof entry !== 'object' || entry === null) continue;
		const record = entry as Record<string, unknown>;
		const sectionId = Number(record.section_id);
		if (
			typeof record.section_tipo !== 'string' ||
			typeof record.tipo !== 'string' ||
			!Number.isInteger(sectionId)
		) {
			continue;
		}
		images.push({
			section_tipo: record.section_tipo,
			section_id: sectionId,
			tipo: record.tipo,
			name: typeof record.name === 'string' ? record.name : null,
		});
	}
	return images;
}

export async function objectPdfReport(ctx: ToolActionContext): Promise<ToolResponse> {
	const options = ctx.options;
	// staged, not in options: a detailed object outgrows them, and the sheet prints every vertex
	const geojson = (await takeStagedJson(
		ctx,
		OBJECT_GEOJSON_KEY_DIR,
		'tool_uca_maps.objectPdfReport',
	)) as Record<string, unknown> | null;
	if (typeof geojson !== 'object' || geojson === null) {
		throw invalidOptions('tool_uca_maps: object_pdf_report needs the object as GeoJSON');
	}

	const geometry = (geojson.geometry ?? {}) as Record<string, unknown>;
	const labels = (options.labels ?? {}) as Record<string, unknown>;
	const label = (key: string, fallback: string): string =>
		typeof labels[key] === 'string' && labels[key] !== '' ? (labels[key] as string) : fallback;

	const pdf = new PdfDocument();

	pdf.text(label('title', 'Object properties'), { size: 18, bold: true, gap: 4 });
	pdf.text([options.tipo, options.section_tipo, options.section_id].filter(Boolean).join(' - '), {
		size: 9,
	});
	pdf.rule();

	// passed in, not re-fetched: a second third-party call could disagree
	// with the number the console already shows
	if (typeof options.elevation === 'number') {
		pdf.text(`${label('elevation', 'Elevation')}: ${options.elevation} m`, { size: 10 });
	}

	const rows = printableProperties(geojson.properties);
	if (rows.length === 0) {
		pdf.text(label('no_properties', 'This object has no properties.'), { size: 10, gap: 6 });
	} else {
		for (const [key, value] of rows) {
			pdf.text(key, { size: 10, bold: true });
			pdf.text(value, { size: 10, gap: 4 });
		}
	}

	pdf.text(label('geometry', 'Geometry'), { size: 14, bold: true, gap: 2 });
	pdf.rule();
	pdf.text(`${label('type', 'Type')}: ${String(geometry.type ?? '—')}`, { size: 10, gap: 4 });
	pdf.text('EPSG:4326', { size: 10, bold: true });
	pdf.text(JSON.stringify(geometry.coordinates ?? null), { size: 9, gap: 4 });
	pdf.text('EPSG:3857', { size: 10, bold: true });
	pdf.text(JSON.stringify(reprojectCoordinates(geometry.coordinates ?? null)), {
		size: 9,
		gap: 6,
	});

	const requested = readRequestedImages(options.images);
	if (requested.length > 0) {
		pdf.text(`${label('images', 'Associated images')} (${requested.length})`, {
			size: 14,
			bold: true,
			gap: 2,
		});
		pdf.rule();

		for (const image of requested) {
			const caption = image.name ?? `${image.section_tipo} ${image.section_id}`;
			pdf.text(caption, { size: 10, bold: true });

			const imageOptions = {
				section_tipo: image.section_tipo,
				section_id: image.section_id,
				tipo: image.tipo,
			};

			const allowed = await assertActionPermission(IMAGE_READ_GATE, imageOptions, ctx.principal);
			if (!allowed.ok) {
				pdf.text(label('image_forbidden', 'Not included: you may not read this record.'), {
					size: 9,
					gap: 4,
				});
				continue;
			}

			let embedded = false;
			let reason: EmbedRefusal = 'missing';
			try {
				const resolved = await resolveEmbeddableImage(imageOptions);
				if (typeof resolved === 'string') {
					reason = resolved;
				} else {
					const file = Bun.file(resolved.absolutePath);
					if (await file.exists()) {
						embedded = pdf.image(new Uint8Array(await file.arrayBuffer()));
						// the file IS a jpeg by extension but the writer refused
						// it — a CMYK frame, or a truncated upload
						if (!embedded) reason = 'format';
					}
				}
			} catch {
				// a deleted record, a swept file, a tier that vanished: named
				// below, never a failed report
			}

			if (!embedded) {
				pdf.text(
					reason === 'format'
						? label('image_format', 'Not included: this image format cannot be embedded.')
						: label('image_missing', 'Not included: this image could not be embedded.'),
					{ size: 9, gap: 4 },
				);
			}
		}
	}

	const bytes = pdf.build();

	return downloadAnswer(
		ctx,
		Buffer.from(bytes).toString('base64'),
		'uca_maps_object.pdf',
		'application/pdf',
	);
}
