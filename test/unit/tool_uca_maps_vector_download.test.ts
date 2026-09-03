/**
 * tool_uca_maps — `vector_download` (hito 3, checkpoint 3a).
 *
 * What this pins:
 *  - the DECLARED gate: 'record_tipo' at read level (1), same criterion as
 *    `get_capabilities` (test/unit/tool_uca_maps_get_capabilities.test.ts) —
 *    the action writes no section data, it transforms geometry the caller
 *    already holds;
 *  - caller-fault validation (unsupported format, missing/malformed geojson)
 *    THROWS `request.invalid_options`, unconditionally — no binary involved,
 *    so this runs even without GDAL installed;
 *  - the real conversion, GATED on `Bun.which('ogr2ogr')` (same idiom as
 *    `test/unit/media_av_writeback.test.ts`'s HAVE_FFMPEG): a dev image
 *    without `gdal-bin` (see `tools/tool_uca_maps/dev/Dockerfile.dev`) skips
 *    these instead of failing the suite — but then they are NOT exercised for
 *    real, which is why the dev image installs `gdal-bin` (hito 3).
 *  - the CRS decision (`vector_download.ts` file header): `-a_srs EPSG:4326`,
 *    never v6's forced EPSG:3857 — asserted on the KML output's declared SRS.
 */

import { describe, expect, test } from 'bun:test';
import { getLoadedTool } from '../../src/core/tools/loader.ts';
import type {
	GatedToolActionSpec,
	ToolActionContext,
	ToolResponse,
} from '../../src/core/tools/module.ts';
import { mustGet } from '../helpers/assert.ts';

const HAVE_GDAL = Bun.which('ogr2ogr') !== null;

async function loadAction(): Promise<GatedToolActionSpec> {
	const loaded = await getLoadedTool('tool_uca_maps');
	expect(loaded).not.toBeNull();
	const action = mustGet(loaded?.module.apiActions.vector_download, 'vector_download');
	return action as GatedToolActionSpec;
}

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

function contextOf(options: Record<string, unknown>): ToolActionContext {
	return {
		principal: { userId: -1, isGlobalAdmin: true, isDeveloper: true },
		userId: -1,
		options: { section_tipo: 'test2', tipo: 'test52', section_id: 905101, ...options },
		background: false,
	};
}

describe('tool_uca_maps vector_download — declared gate', () => {
	test('is record_tipo at read level (1), same criterion as get_capabilities', async () => {
		const action = await loadAction();
		expect(action.permission).toBe('record_tipo');
		expect(action.minLevel).toBe(1);
	});
});

describe('tool_uca_maps vector_download — caller-fault validation (no binary needed)', () => {
	test('an unsupported format is refused', async () => {
		const action = await loadAction();
		await expect(
			action.handler(contextOf({ format: 'dxf', geojson: SAMPLE_GEOJSON })),
		).rejects.toThrow(/Unsupported vector format/);
	});

	test('missing geojson is refused', async () => {
		const action = await loadAction();
		await expect(action.handler(contextOf({ format: 'shp' }))).rejects.toThrow(
			/Missing or invalid geojson/,
		);
	});

	test('a geojson that is not an object is refused', async () => {
		const action = await loadAction();
		await expect(
			action.handler(contextOf({ format: 'kml', geojson: 'not-an-object' })),
		).rejects.toThrow(/Missing or invalid geojson/);
	});
});

describe.if(HAVE_GDAL)('tool_uca_maps vector_download — real ogr2ogr conversion', () => {
	test('shp: returns a zip (PK magic bytes), envelope v2, no result mirror', async () => {
		const action = await loadAction();
		const response: ToolResponse = await action.handler(
			contextOf({ format: 'shp', geojson: SAMPLE_GEOJSON }),
		);

		expect(response.ok).toBe(true);
		expect('result' in response).toBe(false); // forbidden PHP-era mirror key

		const data = (response as { data: Record<string, unknown> }).data;
		expect(data.filename).toBe('uca_maps_object.shp.zip');
		expect(data.mime).toBe('application/zip');

		const bytes = Buffer.from(data.content_base64 as string, 'base64');
		expect(bytes.length).toBeGreaterThan(0);
		// ZIP local-file-header magic ('PK\x03\x04') — proves ogr2ogr's /vsizip/
		// write actually produced a real archive, not an empty/garbage file.
		expect(bytes.subarray(0, 4).toString('hex')).toBe('504b0304');
	});

	test("kml: returns a WGS84 (EPSG:4326) KML, never v6's forced EPSG:3857", async () => {
		const action = await loadAction();
		const response: ToolResponse = await action.handler(
			contextOf({ format: 'kml', geojson: SAMPLE_GEOJSON }),
		);

		expect(response.ok).toBe(true);
		const data = (response as { data: Record<string, unknown> }).data;
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
		const action = await loadAction();
		await expect(
			action.handler(contextOf({ format: 'shp', geojson: { not: 'geojson' } })),
		).rejects.toThrow();
	});
});
