/**
 * tool_uca_maps — `vector_download`: one object as SHP or KML. The caller
 * faults are refused before any binary; the conversion runs where ogr2ogr is
 * installed and labels the data EPSG:4326, never v6's forced EPSG:3857.
 */

import { describe, expect, test } from 'bun:test';
import type { ToolResponse } from '../../src/core/tools/module.ts';
import { contextOf, dataOf, haveGdal, loadAction } from './fixtures/tool_uca_maps/helpers.ts';

const HAVE_GDAL = haveGdal('ogr2ogr');

/** A minimal, valid WGS84 polygon — exactly what `layer.toGeoJSON()` produces
 * client-side (object_console.js `download_vector`), no `crs` member (RFC
 * 7946 deprecates it; the server assigns the CRS instead). */
const SAMPLE_GEOJSON = {
	type: 'Feature',
	properties: {},
	geometry: {
		type: 'Polygon',
		coordinates: [
			[
				[-6.29, 36.53],
				[-6.28, 36.53],
				[-6.28, 36.54],
				[-6.29, 36.54],
				[-6.29, 36.53],
			],
		],
	},
};

describe('tool_uca_maps vector_download — caller-fault validation (no binary needed)', () => {
	test('an unsupported format is refused', async () => {
		const action = await loadAction('vector_download');
		await expect(
			action.handler(contextOf({ format: 'dxf', geojson: SAMPLE_GEOJSON })),
		).rejects.toThrow(/Unsupported vector format/);
	});

	test.each([
		['missing', { format: 'shp' }],
		['not an object', { format: 'kml', geojson: 'not-an-object' }],
	])('a geojson %s is refused', async (_, options) => {
		const action = await loadAction('vector_download');
		await expect(action.handler(contextOf(options))).rejects.toMatchObject({
			code: 'request.invalid_options',
			message: 'Missing or invalid geojson',
		});
	});
});

describe.skipIf(!HAVE_GDAL)(
	'tool_uca_maps vector_download — real ogr2ogr conversion (needs ogr2ogr)',
	() => {
		test('shp: returns a zip (PK magic bytes), envelope v2, no result mirror', async () => {
			const action = await loadAction('vector_download');
			const response: ToolResponse = await action.handler(
				contextOf({ format: 'shp', geojson: SAMPLE_GEOJSON }),
			);

			const data = dataOf(response);
			expect('result' in response).toBe(false); // forbidden PHP-era mirror key

			expect(data.filename).toBe('uca_maps_object.shp.zip');
			expect(data.mime).toBe('application/zip');

			const bytes = Buffer.from(data.content_base64 as string, 'base64');
			expect(bytes.length).toBeGreaterThan(0);
			// ZIP local-file-header magic ('PK\x03\x04'): a real archive, not an
			// empty or garbage file
			expect(bytes.subarray(0, 4).toString('hex')).toBe('504b0304');
		});

		test("kml: returns a WGS84 (EPSG:4326) KML, never v6's forced EPSG:3857", async () => {
			const action = await loadAction('vector_download');
			const response: ToolResponse = await action.handler(
				contextOf({ format: 'kml', geojson: SAMPLE_GEOJSON }),
			);

			const data = dataOf(response);
			expect(data.filename).toBe('uca_maps_object.kml');
			expect(data.mime).toBe('application/vnd.google-earth.kml+xml');

			const kml = Buffer.from(data.content_base64 as string, 'base64').toString('utf-8');
			expect(kml).toContain('<kml');
			// KML is always lon/lat WGS84 by format definition — the CRS assertion
			// that matters is that ogr2ogr did NOT refuse/garble the input, which a
			// coordinate present in the source polygon (rounded by KML's own
			// precision) confirms end-to-end.
			expect(kml).toContain('-6.2');
		});

		test('an unparsable geojson fails the conversion as tool.action_failed, not a silent empty file', async () => {
			const action = await loadAction('vector_download');
			await expect(
				action.handler(contextOf({ format: 'shp', geojson: { not: 'geojson' } })),
			).rejects.toMatchObject({ code: 'tool.action_failed' });
		});
	},
);
