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
 *  - caller-fault validation (unsupported extension, a partial or malformed
 *    EPSG/zone/band set, missing tmp_name) THROWS `request.invalid_options`,
 *    unconditionally — no GDAL
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
 *    embedded CRS and no projection fails with the friendly
 *    "no embedded coordinate system" message, and succeeds once v6's three
 *    fields are given — verified live against GDAL 3.13.2 in the dev
 *    container before this file was written (`docs/hitos/hito_12.md`);
 *  - zone and band are checked against the EPSG's own PROJ string, so a set
 *    of three that contradicts itself never reaches ogr2ogr.
 */

import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from '../../src/config/config.ts';
import { DedaloError } from '../../src/core/errors/index.ts';
import { getLoadedTool } from '../../src/core/tools/loader.ts';
import type {
	GatedToolActionSpec,
	ToolActionContext,
	ToolResponse,
} from '../../src/core/tools/module.ts';
import { withScratchDir } from '../../tools/tool_uca_maps/server/gdal.ts';
import {
	assertProjectionMatches,
	classifyProjectionLookupError,
	declaresOwnCrs,
	parseManualProjection,
} from '../../tools/tool_uca_maps/server/vector_upload.ts';
import { mustGet } from '../helpers/assert.ts';

// all three or none: a partial install would fail some tests instead of skipping them
const HAVE_GDAL = ['ogr2ogr', 'ogrinfo', 'gdalsrsinfo'].every(
	(binary) => Bun.which(binary) !== null,
);

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

	test('a malformed EPSG code is refused', async () => {
		const action = await loadAction();
		await expect(
			action.handler(
				contextOf(-1, {
					file_data: { key_dir: '', tmp_name: 'x', extension: 'geojson' },
					epsg: 'EPSG:4326',
					zone: '30',
					band: 'N',
				}),
			),
		).rejects.toThrow(/Invalid EPSG code/);
	});

	test('a zone and band without their EPSG are refused, not silently dropped as in v6', async () => {
		const action = await loadAction();
		await expect(
			action.handler(
				contextOf(-1, {
					file_data: { key_dir: '', tmp_name: 'x', extension: 'geojson' },
					zone: '30',
					band: 'N',
				}),
			),
		).rejects.toThrow(/fill in the EPSG too/);
	});
});

describe('tool_uca_maps upload_vector_layer — v6 manual projection (pure)', () => {
	test('none filled is no projection; blanks count as empty', () => {
		expect(parseManualProjection({})).toBeNull();
		expect(parseManualProjection({ epsg: ' ', zone: '', band: '' })).toBeNull();
	});

	test('an EPSG alone is a projection with no UTM part (v6 lists 4326 with no zone or band)', () => {
		expect(parseManualProjection({ epsg: '4326' })).toEqual({ epsg: '4326', utm: null });
	});

	test('zone or band without the EPSG, or one without the other, is refused', () => {
		for (const options of [{ zone: '30' }, { band: 'N' }, { zone: '30', band: 'N' }]) {
			expect(() => parseManualProjection(options)).toThrow(/fill in the EPSG too/);
		}
		for (const options of [
			{ epsg: '25830', zone: '30' },
			{ epsg: '25830', band: 'N' },
		]) {
			expect(() => parseManualProjection(options)).toThrow(/fill in both, or neither/);
		}
	});

	test('band follows Leaflet.UTM: before N is south, N onwards north, any case', () => {
		expect(parseManualProjection({ epsg: '32719', zone: '19', band: 'c' })).toEqual({
			epsg: '32719',
			utm: { zone: 19, south: true },
		});
		expect(parseManualProjection({ epsg: '25830', zone: '30', band: 'N' })?.utm?.south).toBe(false);
		expect(parseManualProjection({ epsg: '25830', zone: '30', band: 'S' })?.utm?.south).toBe(false);
	});

	test('a zone outside 1..60 or a letter that is no MGRS band is refused', () => {
		for (const zone of ['0', '61', '3a', '-1']) {
			expect(() => parseManualProjection({ epsg: '25830', zone, band: 'N' })).toThrow(
				/Invalid UTM zone/,
			);
		}
		for (const band of ['I', 'O', 'A', 'Y', 'NN']) {
			expect(() => parseManualProjection({ epsg: '25830', zone: '30', band })).toThrow(
				/Invalid UTM band/,
			);
		}
	});

	// PROJ strings as `gdalsrsinfo -o proj4` prints them (GDAL 3.13.2)
	const UTM_30N = '+proj=utm +zone=30 +ellps=GRS80 +units=m +no_defs';
	const UTM_19S = '+proj=utm +zone=19 +south +datum=WGS84 +units=m +no_defs';
	const LONLAT = '+proj=longlat +datum=WGS84 +no_defs';
	const utm = (zone: number, south: boolean) => ({ zone, south });

	test('a UTM code with the zone and band that describe it passes; a non-UTM code alone passes', () => {
		expect(() =>
			assertProjectionMatches({ epsg: '25830', utm: utm(30, false) }, UTM_30N),
		).not.toThrow();
		expect(() =>
			assertProjectionMatches({ epsg: '32719', utm: utm(19, true) }, UTM_19S),
		).not.toThrow();
		expect(() => assertProjectionMatches({ epsg: '4326', utm: null }, LONLAT)).not.toThrow();
	});

	test('a zone or hemisphere the EPSG contradicts is refused', () => {
		expect(() => assertProjectionMatches({ epsg: '25830', utm: utm(19, false) }, UTM_30N)).toThrow(
			/UTM zone 30, northern hemisphere \(band N to X\), not the zone and band given \(zone 19, northern/,
		);
		expect(() => assertProjectionMatches({ epsg: '32719', utm: utm(19, false) }, UTM_19S)).toThrow(
			/UTM zone 19, southern hemisphere \(band C to M\), not the zone and band given \(zone 19, northern/,
		);
	});

	test('a southern refusal names bands that are then accepted, never the MGRS S (northern)', () => {
		let message = '';
		try {
			assertProjectionMatches({ epsg: '32719', utm: null }, UTM_19S);
		} catch (error) {
			message = (error as Error).message;
		}
		expect(message).toContain('band C to M');
		expect(message).not.toMatch(/19S/);
		const followed = parseManualProjection({ epsg: '32719', zone: '19', band: 'C' });
		expect(() => assertProjectionMatches(mustGet(followed, 'followed'), UTM_19S)).not.toThrow();
	});

	test("only PROJ's 'crs not found' is the caller's; any other lookup failure is rethrown as is", () => {
		const unknown = classifyProjectionLookupError(
			new DedaloError('tool.action_failed', {
				message:
					'vector_upload (projection lookup): exit 1: ERROR 1: PROJ: proj_create_from_database: crs not found: EPSG:99999',
			}),
			'99999',
		);
		expect(unknown).toBeInstanceOf(DedaloError);
		expect((unknown as DedaloError).code).toBe('request.invalid_options');

		for (const message of [
			'vector_upload (projection lookup): TIMED OUT — the wall-clock budget was spent (killed with SIGKILL)',
			'vector_upload (projection lookup): exit 1: ERROR 1: PROJ: proj_create_from_database: Cannot find proj.db',
		]) {
			const fault = new DedaloError('tool.action_failed', { message });
			expect(classifyProjectionLookupError(fault, '25830')).toBe(fault);
		}
	});

	test('a UTM code needs its zone and band; a non-UTM one refuses them', () => {
		expect(() => assertProjectionMatches({ epsg: '25830', utm: null }, UTM_30N)).toThrow(
			/UTM zone 30, northern hemisphere \(band N to X\): fill in its zone and band too/,
		);
		expect(() => assertProjectionMatches({ epsg: '4326', utm: utm(30, false) }, LONLAT)).toThrow(
			/is not a UTM projection: leave zone and band empty/,
		);
	});
});

// The KML and GeoJSON branches read no binary, so they are gated where CI has
// no GDAL; only the shapefile's ogrinfo probe stays behind HAVE_GDAL.
describe('tool_uca_maps declaresOwnCrs — no GDAL needed', () => {
	async function probe(name: string, text: string): Promise<boolean> {
		return withScratchDir(async (dir) => {
			const file = resolve(dir, name);
			writeFileSync(file, text);
			return declaresOwnCrs(file, name.split('.').pop() ?? '');
		});
	}

	test('a KML always declares its projection (WGS84 by definition)', async () => {
		expect(await probe('plan.kml', '<kml/>')).toBe(true);
	});

	test('a GeoJSON with a crs member declares it; one without does not', async () => {
		const crs = '{"type":"name","properties":{"name":"urn:ogc:def:crs:EPSG::25830"}}';
		expect(
			await probe('with.geojson', `{"type":"FeatureCollection","crs":${crs},"features":[]}`),
		).toBe(true);
		expect(await probe('without.geojson', '{"type":"FeatureCollection","features":[]}')).toBe(
			false,
		);
	});

	test('a GeoJSON that is not strict JSON is refused, never read as undeclared', async () => {
		let caught: unknown = null;
		try {
			await probe('loose.geojson', '{"type":"FeatureCollection","features":[],}');
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(DedaloError);
		expect((caught as DedaloError).code).toBe('request.invalid_options');
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
		projection: Record<string, string> = {},
	): Promise<ToolResponse> {
		const action = await loadAction();
		return action.handler(
			contextOf(SCRATCH_USER, {
				file_data: { key_dir: '', ...fileData },
				...projection,
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

			// the file's own .prj wins, as in v6: even fields that agree with it are
			// refused rather than handed to -s_srs, which would override it silently
			await expect(
				callUpload(
					{ tmp_name: 'plain.zip', extension: 'zip' },
					{ epsg: '25830', zone: '30', band: 'N' },
				),
			).rejects.toThrow(/already declares its own projection/);

			// checked BEFORE the EPSG lookup: a UTM code without zone/band, or a
			// wrong zone, must not first send the user to fill in more fields
			const partialOrWrong: Record<string, string>[] = [
				{ epsg: '32630' },
				{ epsg: '25830', zone: '19', band: 'N' },
			];
			for (const fields of partialOrWrong) {
				await expect(
					callUpload({ tmp_name: 'plain.zip', extension: 'zip' }, fields),
				).rejects.toThrow(/already declares its own projection/);
			}
		} finally {
			rmSync(userStaging, { recursive: true, force: true });
		}
	});

	test('a shapefile-in-zip with NO embedded CRS fails with the friendly message, and succeeds once EPSG, zone and band are given', async () => {
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

			// PROJ, not a regex, says what 25830 is: a zone it contradicts and a
			// code it does not know are both refused before ogr2ogr runs
			await expect(
				callUpload(
					{ tmp_name: 'noprj.zip', extension: 'zip' },
					{ epsg: '25830', zone: '19', band: 'N' },
				),
			).rejects.toThrow(
				/UTM zone 30, northern hemisphere \(band N to X\), not the zone and band given \(zone 19, northern/,
			);
			await expect(
				callUpload(
					{ tmp_name: 'noprj.zip', extension: 'zip' },
					{ epsg: '99999', zone: '30', band: 'N' },
				),
			).rejects.toThrow(/Unknown EPSG code/);

			// S is an MGRS band of the north (Spain lies in S and T)
			const response = await callUpload(
				{ tmp_name: 'noprj.zip', extension: 'zip' },
				{ epsg: '25830', zone: '30', band: 'S' },
			);
			expect(response.ok).toBe(true);
			const [lon, lat] = mustGet(dataOf(response).geojson.features[0], 'features[0]').geometry
				.coordinates;
			expect(lon).toBeCloseTo(-0.375, 3);
			expect(lat).toBeCloseTo(39.47, 3);
		} finally {
			rmSync(userStaging, { recursive: true, force: true });
		}
	});

	test('a CRS-less shapefile in longitude/latitude takes the EPSG alone (v6 lists 4326 with no zone or band)', async () => {
		const { withScratchDir, resolveGdalBinary, runToolBinary } = await import(
			'../../tools/tool_uca_maps/server/gdal.ts'
		);
		const zipBytes = await withScratchDir(async (dir) => {
			const src = resolve(dir, 'src.geojson');
			writeFileSync(src, SOURCE_GEOJSON);
			const shp = resolve(dir, 'lonlat.shp');
			const ogr2ogr = await resolveGdalBinary('ogr2ogr');
			await runToolBinary(
				[ogr2ogr, '-f', 'ESRI Shapefile', shp, src],
				'test fixture (lonlat shp)',
				{
					expectedOutput: shp,
				},
			);
			rmSync(resolve(dir, 'lonlat.prj'));
			const out = resolve(dir, 'lonlat.shp.zip');
			await runToolBinary(
				[ogr2ogr, '-f', 'ESRI Shapefile', out, shp],
				'test fixture (lonlat noprj shp.zip)',
				{ expectedOutput: out },
			);
			return Bun.file(out).arrayBuffer();
		});
		await stage('lonlat.zip', new Uint8Array(zipBytes));
		try {
			const response = await callUpload(
				{ tmp_name: 'lonlat.zip', extension: 'zip' },
				{ epsg: '4326' },
			);
			expect(response.ok).toBe(true);
			const [lon, lat] = mustGet(dataOf(response).geojson.features[0], 'features[0]').geometry
				.coordinates;
			expect(lon).toBeCloseTo(-0.375, 6);
			expect(lat).toBeCloseTo(39.47, 6);
		} finally {
			rmSync(userStaging, { recursive: true, force: true });
		}
	});

	test('a legacy UTM .geojson with no crs member takes the fields; one that declares crs refuses them', async () => {
		const { withScratchDir, resolveGdalBinary, runToolBinary } = await import(
			'../../tools/tool_uca_maps/server/gdal.ts'
		);
		const declared = await withScratchDir(async (dir) => {
			const src = resolve(dir, 'src.geojson');
			writeFileSync(src, SOURCE_GEOJSON);
			const out = resolve(dir, 'utm.geojson');
			const ogr2ogr = await resolveGdalBinary('ogr2ogr');
			await runToolBinary(
				[ogr2ogr, '-f', 'GeoJSON', '-lco', 'RFC7946=NO', '-t_srs', 'EPSG:25830', out, src],
				'test fixture (utm geojson)',
				{ expectedOutput: out },
			);
			return (await Bun.file(out).json()) as Record<string, unknown>;
		});
		expect(declared.crs).toBeDefined();
		const { crs: _crs, ...legacy } = declared;
		await stage('declared.geojson', JSON.stringify(declared));
		await stage('legacy.geojson', JSON.stringify(legacy));
		try {
			const fields = { epsg: '25830', zone: '30', band: 'N' };
			await expect(
				callUpload({ tmp_name: 'declared.geojson', extension: 'geojson' }, fields),
			).rejects.toThrow(/already declares its own projection/);

			const response = await callUpload(
				{ tmp_name: 'legacy.geojson', extension: 'geojson' },
				fields,
			);
			const [lon, lat] = mustGet(dataOf(response).geojson.features[0], 'features[0]').geometry
				.coordinates;
			expect(lon).toBeCloseTo(-0.375, 3);
			expect(lat).toBeCloseTo(39.47, 3);
		} finally {
			rmSync(userStaging, { recursive: true, force: true });
		}
	});

	test('a .geojson strict JSON refuses cannot take the fields: its own crs could not be checked', async () => {
		// GDAL reads the trailing comma; a crs hidden behind it must not be overridden
		await stage(
			'lenient.geojson',
			'{"type":"FeatureCollection","crs":{"type":"name","properties":{"name":"urn:ogc:def:crs:EPSG::25830"}},"features":[],}',
		);
		try {
			await expect(
				callUpload(
					{ tmp_name: 'lenient.geojson', extension: 'geojson' },
					{ epsg: '25831', zone: '31', band: 'N' },
				),
			).rejects.toThrow(/not strict JSON/);
		} finally {
			rmSync(userStaging, { recursive: true, force: true });
		}
	});

	test('a .kml refuses the fields: it is WGS84 by definition', async () => {
		await stage('plain.kml', '<?xml version="1.0"?><kml xmlns="http://www.opengis.net/kml/2.2"/>');
		try {
			await expect(
				callUpload({ tmp_name: 'plain.kml', extension: 'kml' }, { epsg: '4326' }),
			).rejects.toThrow(/already declares its own projection/);
		} finally {
			rmSync(userStaging, { recursive: true, force: true });
		}
	});
});
