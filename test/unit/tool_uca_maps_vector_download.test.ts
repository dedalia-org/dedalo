/**
 * tool_uca_maps — `vector_download`: one object as SHP or KML. The object
 * arrives staged under its own key_dir and is deleted whatever the outcome. The
 * caller faults are refused before any binary; the conversion runs where ogr2ogr
 * is installed and labels the data EPSG:4326, never v6's forced EPSG:3857.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, rmSync, truncateSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ToolResponse } from '../../src/core/tools/module.ts';
import { OBJECT_GEOJSON_KEY_DIR } from '../../tools/tool_uca_maps/js/upload_formats.js';
import { MAX_STAGED_JSON_BYTES } from '../../tools/tool_uca_maps/server/staged_upload.ts';
import {
	contextOf,
	dataOf,
	expectCode,
	failureOf,
	haveGdal,
	loadAction,
	stagedJson,
	stageFile,
	stagingOf,
} from './fixtures/tool_uca_maps/helpers.ts';

/** contextOf's caller; only the object key_dir is swept, never the rest of its staging. */
const OBJECTS = resolve(stagingOf(-1), OBJECT_GEOJSON_KEY_DIR);
afterEach(() => rmSync(OBJECTS, { recursive: true, force: true }));

const staged = (value: unknown) => stagedJson(OBJECT_GEOJSON_KEY_DIR, value);

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
	// a key every object inherits is no format: the format table is read by own keys only
	test.each(['xlsx', 'toString', 'constructor', '__proto__'])(
		"an unsupported format ('%s') is refused, and the staged object deleted",
		async (format) => {
			const action = await loadAction('vector_download');
			const file_data = staged(SAMPLE_GEOJSON);
			await expect(action.handler(contextOf({ format, file_data }))).rejects.toMatchObject({
				code: 'request.invalid_options',
				message: expect.stringMatching(/^Unsupported vector format/),
			});
			expect(existsSync(resolve(OBJECTS, file_data.tmp_name))).toBe(false);
		},
	);

	// read whole into the one server process: core's own upload ceiling is no bound
	test('a staged object over the size limit is refused before it is read, and deleted', async () => {
		const action = await loadAction('vector_download');
		stageFile(-1, 'huge.json', '{}', OBJECT_GEOJSON_KEY_DIR);
		truncateSync(resolve(OBJECTS, 'huge.json'), MAX_STAGED_JSON_BYTES + 1);
		const file_data = { key_dir: OBJECT_GEOJSON_KEY_DIR, tmp_name: 'huge.json' };
		await expect(action.handler(contextOf({ format: 'kml', file_data }))).rejects.toThrow(
			/exceeds the .*-byte limit/,
		);
		expect(existsSync(resolve(OBJECTS, 'huge.json'))).toBe(false);
	});

	test('an object not staged under its own key_dir is refused', async () => {
		const action = await loadAction('vector_download');
		await expect(action.handler(contextOf({ format: 'shp' }))).rejects.toThrow(
			/must be staged under 'uca_maps_object'/,
		);
	});

	test('a staged geojson that is not an object is refused, and deleted', async () => {
		const action = await loadAction('vector_download');
		const file_data = staged('not-an-object');
		await expect(action.handler(contextOf({ format: 'kml', file_data }))).rejects.toMatchObject({
			code: 'request.invalid_options',
			message: 'Missing or invalid geojson',
		});
		expect(existsSync(resolve(OBJECTS, file_data.tmp_name))).toBe(false);
	});

	test('a staged payload that is not JSON is refused, and deleted', async () => {
		const action = await loadAction('vector_download');
		stageFile(-1, 'broken.geojson', '{"type":', OBJECT_GEOJSON_KEY_DIR);
		const file_data = { key_dir: OBJECT_GEOJSON_KEY_DIR, tmp_name: 'broken.geojson' };
		expectCode(
			await failureOf(action.handler(contextOf({ format: 'kml', file_data }))),
			'request.invalid_options',
		);
		expect(existsSync(resolve(OBJECTS, 'broken.geojson'))).toBe(false);
	});

	// the console stages JSON.stringify's UTF-8: anything else was damaged, never decoded loosely
	test('a staged payload that is not UTF-8 is refused, and deleted', async () => {
		const action = await loadAction('vector_download');
		stageFile(
			-1,
			'latin1.geojson',
			Buffer.from('{"name":"Ripollès"}', 'latin1'),
			OBJECT_GEOJSON_KEY_DIR,
		);
		const file_data = { key_dir: OBJECT_GEOJSON_KEY_DIR, tmp_name: 'latin1.geojson' };
		const error = await failureOf(action.handler(contextOf({ format: 'kml', file_data })));
		expectCode(error, 'request.invalid_options');
		expect(error.message).toMatch(/not UTF-8/);
		expect(existsSync(resolve(OBJECTS, 'latin1.geojson'))).toBe(false);
	});
});

describe.skipIf(!HAVE_GDAL)(
	'tool_uca_maps vector_download — real ogr2ogr conversion (needs ogr2ogr)',
	() => {
		test('shp: returns a zip (PK magic bytes), envelope v2, no result mirror', async () => {
			const action = await loadAction('vector_download');
			const file_data = staged(SAMPLE_GEOJSON);
			const response: ToolResponse = await action.handler(contextOf({ format: 'shp', file_data }));

			const data = dataOf(response);
			expect('result' in response).toBe(false); // forbidden PHP-era mirror key
			// one object per download: core keeps a completed staged file forever
			expect(existsSync(resolve(OBJECTS, file_data.tmp_name))).toBe(false);

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
				contextOf({ format: 'kml', file_data: staged(SAMPLE_GEOJSON) }),
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
				action.handler(contextOf({ format: 'shp', file_data: staged({ not: 'geojson' }) })),
			).rejects.toMatchObject({ code: 'tool.action_failed' });
		});
	},
);
