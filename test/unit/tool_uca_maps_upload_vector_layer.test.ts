/**
 * tool_uca_maps — `upload_vector_layer` (fila #11, "Upload file to map",
 * VECTOR half — hito 12).
 *
 * What this pins:
 *  - the DECLARED gate: 'record_tipo' at read level (1), same criterion as
 *    every other read-shaped action in this tool (get_wms_layers,
 *    get_catastro_parcel, vector_download…) — nothing is written to section
 *    data here either, the resulting objects only persist through the
 *    geolocation component's own normal save;
 *  - caller-fault validation (unsupported extension, malformed EPSG, missing
 *    tmp_name) THROWS `request.invalid_options`, unconditionally — no GDAL
 *    and no staged file involved, so this runs even without `ogr2ogr`
 *    installed (same split as `tool_uca_maps_vector_download.test.ts`);
 *  - staged-path confinement (SEC parity w/ `tool_import_dedalo_csv`'s
 *    `processUploadedFile`): a traversal in `tmp_name`/`key_dir`, or
 *    `key_dir='../<other_uid>'` claiming another user's staged upload, is
 *    refused fail-closed — same canary technique;
 *  - the size cap (v6 parity, `process_uploaded_vector`'s own 10 MB check);
 *  - the real `ogr2ogr` conversion, GATED on `Bun.which('ogr2ogr')` (same
 *    idiom as `tool_uca_maps_vector_download.test.ts`'s HAVE_GDAL): a
 *    .geojson, a .kml, and a shapefile-in-zip (built for the fixture with
 *    `ogr2ogr` itself, same technique `vector_download.ts` uses to WRITE a
 *    `.shp.zip`) all round-trip to WGS84 GeoJSON; a UTM source with NO
 *    embedded CRS and no EPSG override fails with the friendly
 *    "no embedded coordinate system" message, and succeeds once one is
 *    given — verified live against GDAL 3.13.2 in the dev container before
 *    this file was written (`docs/hitos/hito_12.md`).
 */

import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from '../../src/config/config.ts';
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
	const action = mustGet(loaded?.module.apiActions.upload_vector_layer, 'upload_vector_layer');
	return action as GatedToolActionSpec;
}

function contextOf(userId: number, options: Record<string, unknown>): ToolActionContext {
	return {
		principal: { userId, isGlobalAdmin: true, isDeveloper: true },
		userId,
		options: { section_tipo: 'test2', tipo: 'test52', section_id: 905101, ...options },
		background: false,
	};
}

describe('tool_uca_maps upload_vector_layer — declared gate', () => {
	test("is record_tipo at read level (1), same criterion as the tool's other read actions", async () => {
		const action = await loadAction();
		expect(action.permission).toBe('record_tipo');
		expect(action.minLevel).toBe(1);
	});
});

describe('tool_uca_maps upload_vector_layer — caller-fault validation (no GDAL/file needed)', () => {
	test('an unsupported extension is refused', async () => {
		const action = await loadAction();
		await expect(
			action.handler(
				contextOf(-1, { file_data: { key_dir: '', tmp_name: 'x', extension: 'dxf' } }),
			),
		).rejects.toThrow(/Unsupported vector file extension/);
	});

	test('a missing tmp_name is refused before touching the filesystem', async () => {
		const action = await loadAction();
		await expect(
			action.handler(contextOf(-1, { file_data: { extension: 'geojson' } })),
		).rejects.toThrow(/Missing staged file/);
	});

	test('a malformed EPSG override is refused', async () => {
		const action = await loadAction();
		await expect(
			action.handler(
				contextOf(-1, {
					file_data: { key_dir: '', tmp_name: 'x', extension: 'geojson' },
					epsg: 'EPSG:4326',
				}),
			),
		).rejects.toThrow(/Invalid EPSG code/);
	});
});

describe('path traversal is REFUSED (fail-closed, canary-verified)', () => {
	const SCRATCH_USER = 987656;
	const root = config.media.rootPath ?? '';
	const stagingRoot = resolve(root, config.media.upload.tmpSubdir);

	async function callAction(
		userId: number,
		options: Record<string, unknown>,
	): Promise<ToolResponse> {
		const action = await loadAction();
		return action.handler(contextOf(userId, options));
	}

	test('a tmp_name/key_dir escaping the upload root is refused', async () => {
		for (const file_data of [
			{ key_dir: '', tmp_name: '../../../../../etc/passwd', extension: 'geojson' },
			{ key_dir: '', tmp_name: '/etc/passwd', extension: 'geojson' },
			{ key_dir: '../../../../../etc', tmp_name: 'passwd', extension: 'geojson' },
		]) {
			await expect(callAction(SCRATCH_USER, { file_data })).rejects.toThrow();
		}
		expect(existsSync('/etc/passwd')).toBe(true);
	});

	test("key_dir='../<other_uid>' claiming another user's staged upload is refused (SEC parity w/ sanitize_key_dir)", async () => {
		const VICTIM = 987657;
		const victimStaging = resolve(stagingRoot, String(VICTIM));
		mkdirSync(victimStaging, { recursive: true });
		const victimFile = resolve(victimStaging, 'victim.geojson');
		writeFileSync(victimFile, '{"type":"FeatureCollection","features":[]}');
		try {
			await expect(
				callAction(SCRATCH_USER, {
					file_data: { key_dir: `../${VICTIM}`, tmp_name: 'victim.geojson', extension: 'geojson' },
				}),
			).rejects.toThrow();
			expect(existsSync(victimFile)).toBe(true); // untouched — never read as SCRATCH_USER's own
		} finally {
			rmSync(victimStaging, { recursive: true, force: true });
		}
	});

	test('a staged file over the 10 MB cap is refused before any conversion runs', async () => {
		const userStaging = resolve(stagingRoot, String(SCRATCH_USER));
		mkdirSync(userStaging, { recursive: true });
		const staged = resolve(userStaging, 'big.geojson');
		writeFileSync(staged, Buffer.alloc(10_000_001));
		try {
			await expect(
				callAction(SCRATCH_USER, {
					file_data: { key_dir: '', tmp_name: 'big.geojson', extension: 'geojson' },
				}),
			).rejects.toThrow(/exceeds the .* limit/);
		} finally {
			rmSync(userStaging, { recursive: true, force: true });
		}
	});
});

describe.if(HAVE_GDAL)('tool_uca_maps upload_vector_layer — real ogr2ogr conversion', () => {
	const SCRATCH_USER = 987658;
	const root = config.media.rootPath ?? '';
	const userStaging = resolve(root, config.media.upload.tmpSubdir, String(SCRATCH_USER));

	// A minimal WGS84 point — the SAME shape as vector_download.test.ts's own
	// SAMPLE_GEOJSON, one geometry type is enough: the round-trip proves the
	// CONVERSION path, not GDAL's own geometry coverage (already proven by
	// vector_download's tests in the other direction).
	const SOURCE_GEOJSON =
		'{"type":"FeatureCollection","features":[{"type":"Feature","properties":{"name":"a"},"geometry":{"type":"Point","coordinates":[-0.375,39.47]}}]}';

	async function stage(tmpName: string, bytes: string | Uint8Array): Promise<void> {
		mkdirSync(userStaging, { recursive: true });
		writeFileSync(resolve(userStaging, tmpName), bytes);
	}

	async function callUpload(
		fileData: Record<string, unknown>,
		epsg?: string,
	): Promise<ToolResponse> {
		const action = await loadAction();
		return action.handler(
			contextOf(SCRATCH_USER, {
				file_data: { key_dir: '', ...fileData },
				...(epsg !== undefined ? { epsg } : {}),
			}),
		);
	}

	interface GeoJsonFeature {
		geometry: { type: string; coordinates: [number, number] };
	}
	interface GeoJsonFeatureCollection {
		type: string;
		features: GeoJsonFeature[];
	}
	function dataOf(response: ToolResponse): {
		geojson: GeoJsonFeatureCollection;
		feature_count: number;
	} {
		return (response as { data: { geojson: GeoJsonFeatureCollection; feature_count: number } })
			.data;
	}

	test('a plain WGS84 .geojson round-trips unchanged', async () => {
		await stage('plain.geojson', SOURCE_GEOJSON);
		try {
			const response = await callUpload({ tmp_name: 'plain.geojson', extension: 'geojson' });
			expect(response.ok).toBe(true);
			const data = dataOf(response);
			expect(data.feature_count).toBe(1);
			expect(data.geojson.type).toBe('FeatureCollection');
			const feature = mustGet(data.geojson.features[0], 'features[0]');
			expect(feature.geometry.coordinates).toEqual([-0.375, 39.47]);
		} finally {
			rmSync(userStaging, { recursive: true, force: true });
		}
	});

	test('a .kml round-trips to WGS84 GeoJSON', async () => {
		const { withScratchDir, resolveGdalBinary, runToolBinary } = await import(
			'../../tools/tool_uca_maps/server/gdal.ts'
		);
		const kmlBytes = await withScratchDir(async (dir) => {
			const src = resolve(dir, 'src.geojson');
			writeFileSync(src, SOURCE_GEOJSON);
			const out = resolve(dir, 'src.kml');
			const ogr2ogr = await resolveGdalBinary('ogr2ogr');
			await runToolBinary([ogr2ogr, '-f', 'KML', out, src], 'test fixture (kml)', {
				expectedOutput: out,
			});
			return Bun.file(out).text();
		});
		await stage('plain.kml', kmlBytes);
		try {
			const response = await callUpload({ tmp_name: 'plain.kml', extension: 'kml' });
			expect(response.ok).toBe(true);
			expect(dataOf(response).feature_count).toBe(1);
		} finally {
			rmSync(userStaging, { recursive: true, force: true });
		}
	});

	test('a shapefile-in-zip with an embedded UTM .prj reprojects automatically (no EPSG override needed)', async () => {
		const { withScratchDir, resolveGdalBinary, runToolBinary } = await import(
			'../../tools/tool_uca_maps/server/gdal.ts'
		);
		const zipBytes = await withScratchDir(async (dir) => {
			const src = resolve(dir, 'src.geojson');
			writeFileSync(src, SOURCE_GEOJSON);
			// GDAL's shapefile-in-zip driver keys off the LITERAL '.shp.zip'
			// extension (verified live, see module doc comment / hito 12 dossier)
			// — the fixture is built the same way vector_download.ts writes one.
			const out = resolve(dir, 'utm.shp.zip');
			const ogr2ogr = await resolveGdalBinary('ogr2ogr');
			await runToolBinary(
				[ogr2ogr, '-f', 'ESRI Shapefile', '-t_srs', 'EPSG:25830', out, src],
				'test fixture (utm shp.zip)',
				{ expectedOutput: out },
			);
			return Bun.file(out).arrayBuffer();
		});
		// staged upload's real name never carries a meaningful extension (an
		// opaque tmp_name) — the client-declared 'zip' extension is what routes
		// this through the '.shp.zip' scratch-name branch.
		await stage('plain.zip', new Uint8Array(zipBytes));
		try {
			const response = await callUpload({ tmp_name: 'plain.zip', extension: 'zip' });
			expect(response.ok).toBe(true);
			const data = dataOf(response);
			expect(data.feature_count).toBe(1);
			const [lon, lat] = mustGet(data.geojson.features[0], 'features[0]').geometry.coordinates;
			expect(lon).toBeCloseTo(-0.375, 3);
			expect(lat).toBeCloseTo(39.47, 3);
		} finally {
			rmSync(userStaging, { recursive: true, force: true });
		}
	});

	test('a shapefile-in-zip with NO embedded CRS fails with the friendly message, and succeeds once an EPSG override is given', async () => {
		const { withScratchDir, resolveGdalBinary, runToolBinary } = await import(
			'../../tools/tool_uca_maps/server/gdal.ts'
		);
		const zipBytes = await withScratchDir(async (dir) => {
			const src = resolve(dir, 'src.geojson');
			writeFileSync(src, SOURCE_GEOJSON);
			const utm = resolve(dir, 'utm.shp');
			const ogr2ogr = await resolveGdalBinary('ogr2ogr');
			await runToolBinary(
				[ogr2ogr, '-f', 'ESRI Shapefile', '-t_srs', 'EPSG:25830', utm, src],
				'test fixture (utm shp, unzipped)',
				{ expectedOutput: utm },
			);
			// re-zip WITHOUT the .prj sidecar — a source with genuinely no CRS
			const noPrjDir = resolve(dir, 'noprj');
			mkdirSync(noPrjDir, { recursive: true });
			for (const ext of ['.shp', '.shx', '.dbf']) {
				writeFileSync(
					resolve(noPrjDir, `noprj${ext}`),
					new Uint8Array(await Bun.file(resolve(dir, `utm${ext}`)).arrayBuffer()),
				);
			}
			const out = resolve(dir, 'noprj.shp.zip');
			await runToolBinary(
				[ogr2ogr, '-f', 'ESRI Shapefile', out, resolve(noPrjDir, 'noprj.shp')],
				'test fixture (noprj shp.zip)',
				{ expectedOutput: out },
			);
			return Bun.file(out).arrayBuffer();
		});
		await stage('noprj.zip', new Uint8Array(zipBytes));
		try {
			await expect(callUpload({ tmp_name: 'noprj.zip', extension: 'zip' })).rejects.toThrow(
				/no embedded coordinate system/,
			);

			const response = await callUpload({ tmp_name: 'noprj.zip', extension: 'zip' }, '25830');
			expect(response.ok).toBe(true);
			const [lon, lat] = mustGet(dataOf(response).geojson.features[0], 'features[0]').geometry
				.coordinates;
			expect(lon).toBeCloseTo(-0.375, 3);
			expect(lat).toBeCloseTo(39.47, 3);
		} finally {
			rmSync(userStaging, { recursive: true, force: true });
		}
	});
});
