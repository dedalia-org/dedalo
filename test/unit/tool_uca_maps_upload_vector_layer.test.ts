/**
 * tool_uca_maps — `upload_vector_layer`: a staged zip/GeoJSON/KML to WGS84
 * GeoJSON. The refusals and the checks on ogr2ogr's output run without GDAL;
 * the conversions themselves, and the EPSG/zone/band checked against PROJ,
 * run where GDAL is installed.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, rmSync, truncateSync, utimesSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DedaloError } from '../../src/core/errors/index.ts';
import { openZipStream } from '../../src/core/files/zip.ts';
import type { ToolResponse } from '../../src/core/tools/module.ts';
import { VECTOR_UPLOAD_KEY_DIR } from '../../tools/tool_uca_maps/js/upload_formats.js';
import {
	resolveGdalBinary,
	runToolBinary,
	withScratchDir,
} from '../../tools/tool_uca_maps/server/gdal.ts';
import { ORPHAN_UPLOAD_AGE_MS } from '../../tools/tool_uca_maps/server/staged_upload.ts';
import {
	assertProjectionMatches,
	classifyProjectionLookupError,
	declaresOwnCrs,
	explodeToSingleParts,
	findPositionOutsideLonLat,
	type GeoJsonFeatureCollection,
	outsideLonLatRefusal,
	parseManualProjection,
	readConvertedLayer,
} from '../../tools/tool_uca_maps/server/vector_upload.ts';
import { mustGet } from '../helpers/assert.ts';
import {
	contextOf,
	dataOf,
	expectCode,
	failureOf,
	haveGdal,
	loadAction,
	stageFile,
	stagingOf,
	thrownBy,
} from './fixtures/tool_uca_maps/helpers.ts';

const HAVE_GDAL = haveGdal('ogr2ogr', 'ogrinfo', 'gdalsrsinfo');

async function callUpload(userId: number, options: Record<string, unknown>): Promise<ToolResponse> {
	return (await loadAction('upload_vector_layer')).handler(contextOf(options, userId));
}

/** What each scratch uploader staged: the action deletes the file it converts,
 * so the client uploads it again for every attempt, and so does each call here. */
const STAGED = new Map<string, string | Uint8Array>();
// a call replays only what its own test staged
afterEach(() => STAGED.clear());

/** `bytes` staged as `name` for `userId`, where the client's upload leaves it. */
function stageUpload(userId: number, name: string, bytes: string | Uint8Array): void {
	STAGED.set(`${userId}/${name}`, bytes);
	stageFile(userId, name, bytes, VECTOR_UPLOAD_KEY_DIR);
}

/** The path `stageUpload` writes `name` to. */
function uploadPath(userId: number, name: string): string {
	return resolve(stagingOf(userId), VECTOR_UPLOAD_KEY_DIR, name);
}

/** The upload of what `userId` staged as `tmpName`, the extension read off the name. */
async function uploadStaged(
	userId: number,
	tmpName: string,
	fields: Record<string, string> = {},
): Promise<ToolResponse> {
	const bytes = STAGED.get(`${userId}/${tmpName}`);
	if (bytes !== undefined) stageFile(userId, tmpName, bytes, VECTOR_UPLOAD_KEY_DIR);
	return callUpload(userId, {
		file_data: {
			key_dir: VECTOR_UPLOAD_KEY_DIR,
			tmp_name: tmpName,
			extension: tmpName.split('.').pop(),
		},
		...fields,
	});
}

describe('tool_uca_maps upload_vector_layer — caller-fault validation (no GDAL/file needed)', () => {
	test('a missing tmp_name is refused', async () => {
		await expect(
			callUpload(-1, { file_data: { key_dir: VECTOR_UPLOAD_KEY_DIR, extension: 'geojson' } }),
		).rejects.toThrow(/Missing staged file/);
	});
});

// GeoJSON and KML say whether they declare a projection without any binary,
// and every refusal here comes before the EPSG lookup and ogr2ogr
describe('tool_uca_maps upload_vector_layer — the fields are judged after the file (no GDAL needed)', () => {
	const SCRATCH_USER = 987681;
	const userStaging = stagingOf(SCRATCH_USER);
	afterEach(() => rmSync(userStaging, { recursive: true, force: true }));
	const UNDECLARED = '{"type":"FeatureCollection","features":[]}';
	const DECLARED =
		'{"type":"FeatureCollection","crs":{"type":"name","properties":{"name":"urn:ogc:def:crs:EPSG::25830"}},"features":[]}';

	async function upload(
		tmpName: string,
		bytes: string,
		fields: Record<string, string>,
	): Promise<ToolResponse> {
		stageUpload(SCRATCH_USER, tmpName, bytes);
		return uploadStaged(SCRATCH_USER, tmpName, fields);
	}

	// v6 drops a partial set without a word
	test.each([
		['a malformed EPSG code', { epsg: 'EPSG:4326', zone: '30', band: 'N' }, /Invalid EPSG code/],
		['zone and band without their EPSG', { zone: '30', band: 'N' }, /fill in the EPSG too/],
	] as const)('on a file without its own projection, %s is refused', async (_, fields, pattern) => {
		const error = await failureOf(upload('undeclared.geojson', UNDECLARED, fields));
		expectCode(error, 'request.invalid_options');
		expect(error.message).toMatch(pattern);
	});

	test('a declaring file (a crs member, or any KML) refuses the fields, well-formed or not', async () => {
		const fieldSets: Record<string, string>[] = [
			{ zone: '30' },
			{ epsg: 'EPSG:4326' },
			{ epsg: '25830', band: 'N' },
			{ epsg: '4326' },
			{ epsg: '25830', zone: '30', band: 'N' },
		];
		for (const fields of fieldSets) {
			await expect(upload('declared.geojson', DECLARED, fields)).rejects.toThrow(
				/already declares its own projection/,
			);
			await expect(upload('plain.kml', '<?xml version="1.0"?><kml/>', fields)).rejects.toThrow(
				/already declares its own projection/,
			);
		}
	});

	test('a GeoJSON that is not strict JSON refuses the fields: a crs behind its leniency could not be checked', async () => {
		// GDAL reads the trailing comma; the crs before it must not be overridden
		const lenient =
			'{"type":"FeatureCollection","crs":{"type":"name","properties":{"name":"urn:ogc:def:crs:EPSG::25830"}},"features":[],}';
		const fieldSets: Record<string, string>[] = [
			{ zone: '30' },
			{ epsg: '25831', zone: '31', band: 'N' },
		];
		for (const fields of fieldSets) {
			const error = await failureOf(upload('lenient.geojson', lenient, fields));
			expectCode(error, 'request.invalid_options');
			expect(error.message).toMatch(/not strict JSON/);
		}
	});
});

describe('tool_uca_maps findPositionOutsideLonLat (pure)', () => {
	const collection = (...geometries: unknown[]): GeoJsonFeatureCollection => ({
		type: 'FeatureCollection',
		features: geometries.map((geometry) => ({ type: 'Feature', properties: {}, geometry })),
	});

	test('longitude/latitude everywhere, edges included, is null; so is a feature without geometry or an empty one', () => {
		expect(
			findPositionOutsideLonLat(
				collection(
					{ type: 'Point', coordinates: [-0.375, 39.47, 12] },
					{
						type: 'LineString',
						coordinates: [
							[-180, -90],
							[180, 90],
						],
					},
					null,
					{ type: 'MultiPolygon', coordinates: [] },
					{ type: 'Polygon', coordinates: [[]] },
				),
			),
		).toBeNull();
		expect(findPositionOutsideLonLat(collection())).toBeNull();
	});

	test('UTM metres are found at any depth, GeometryCollection included', () => {
		const utm = [725695.71, 4372210.14];
		expect(findPositionOutsideLonLat(collection({ type: 'Point', coordinates: utm }))).toEqual([
			725695.71, 4372210.14,
		]);
		expect(
			findPositionOutsideLonLat(
				collection(
					{ type: 'Point', coordinates: [-0.375, 39.47] },
					{
						type: 'MultiPolygon',
						coordinates: [[[[-0.4, 39.4], [-0.3, 39.4], utm, [-0.4, 39.4]]]],
					},
				),
			),
		).toEqual([725695.71, 4372210.14]);
		expect(
			findPositionOutsideLonLat(
				collection({
					type: 'GeometryCollection',
					geometries: [
						{ type: 'Point', coordinates: [-0.375, 39.47] },
						{ type: 'Point', coordinates: utm },
					],
				}),
			),
		).toEqual([725695.71, 4372210.14]);
	});

	test('a longitude beyond 180 or a latitude beyond 90 alone is enough; a position missing a coordinate is never inside', () => {
		expect(
			findPositionOutsideLonLat(collection({ type: 'Point', coordinates: [10, 90.5] })),
		).toEqual([10, 90.5]);
		expect(
			findPositionOutsideLonLat(collection({ type: 'Point', coordinates: [200, 10] })),
		).toEqual([200, 10]);
		expect(
			findPositionOutsideLonLat(collection({ type: 'Point', coordinates: [10] })),
		).not.toBeNull();
	});

	test('a position whose coordinates are not numbers is never inside, at any depth', () => {
		expect(
			findPositionOutsideLonLat(collection({ type: 'Point', coordinates: ['10', '20'] })),
		).toEqual([Number.NaN, Number.NaN]);
		expect(
			findPositionOutsideLonLat(
				collection({
					type: 'Polygon',
					coordinates: [
						[
							[-0.4, 39.4],
							[-0.3, null],
							[-0.4, 39.4],
						],
					],
				}),
			),
		).toEqual([-0.3, Number.NaN]);
	});
});

describe('tool_uca_maps explodeToSingleParts (pure)', () => {
	const feature = (name: string, geometry: unknown) => ({
		type: 'Feature',
		properties: { name },
		geometry,
	});
	const explode = (...features: unknown[]) =>
		explodeToSingleParts({ type: 'FeatureCollection', features }).features as {
			properties: { name: string };
			geometry: unknown;
		}[];
	const ring = (x: number) => [
		[x, 39.4],
		[x + 0.01, 39.4],
		[x, 39.41],
		[x, 39.4],
	];

	test('each part of a Multi* is its own feature, carrying the whole feature properties', () => {
		const features = explode(
			feature('pts', {
				type: 'MultiPoint',
				coordinates: [
					[-0.4, 39.4],
					[-0.41, 39.41],
				],
			}),
			feature('lines', { type: 'MultiLineString', coordinates: [ring(-0.4), ring(-0.5)] }),
			feature('polys', { type: 'MultiPolygon', coordinates: [[ring(-0.4)], [ring(-0.5)]] }),
		);
		expect(features.map((f) => [f.properties.name, f.geometry])).toEqual([
			['pts', { type: 'Point', coordinates: [-0.4, 39.4] }],
			['pts', { type: 'Point', coordinates: [-0.41, 39.41] }],
			['lines', { type: 'LineString', coordinates: ring(-0.4) }],
			['lines', { type: 'LineString', coordinates: ring(-0.5) }],
			['polys', { type: 'Polygon', coordinates: [ring(-0.4)] }],
			['polys', { type: 'Polygon', coordinates: [ring(-0.5)] }],
		]);
	});

	test("a GeometryCollection (KML's MultiGeometry) splits at any depth, its Multi* parts too", () => {
		const features = explode(
			feature('nested', {
				type: 'GeometryCollection',
				geometries: [
					{
						type: 'MultiPoint',
						coordinates: [
							[-0.4, 39.4],
							[-0.43, 39.43],
						],
					},
					{
						type: 'GeometryCollection',
						geometries: [{ type: 'Polygon', coordinates: [ring(-0.5)] }],
					},
					{ type: 'LineString', coordinates: ring(-0.6) },
				],
			}),
		);
		expect(features.map((f) => [f.properties.name, f.geometry])).toEqual([
			['nested', { type: 'Point', coordinates: [-0.4, 39.4] }],
			['nested', { type: 'Point', coordinates: [-0.43, 39.43] }],
			['nested', { type: 'Polygon', coordinates: [ring(-0.5)] }],
			['nested', { type: 'LineString', coordinates: ring(-0.6) }],
		]);
	});

	test('a single-part or geometry-less feature comes back as the very same object', () => {
		const point = feature('p', { type: 'Point', coordinates: [-0.375, 39.47] });
		const bare = feature('none', null);
		const features = explode(point, bare);
		expect(features).toHaveLength(2);
		expect(features[0]).toBe(point);
		expect(features[1]).toBe(bare);
	});
});

describe('tool_uca_maps upload_vector_layer — v6 manual projection (pure)', () => {
	test('an EPSG that is not 4 to 6 digits is refused', () => {
		for (const epsg of ['EPSG:4326', '432', '1234567', '43 26']) {
			const error = thrownBy(() => parseManualProjection({ epsg }));
			expectCode(error, 'request.invalid_options');
			expect((error as DedaloError).message).toMatch(/Invalid EPSG code/);
		}
	});

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
		const refusal = thrownBy(() => assertProjectionMatches({ epsg: '32719', utm: null }, UTM_19S));
		const message = (refusal as Error | undefined)?.message ?? '';
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
		expectCode(unknown, 'request.invalid_options');

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
			return declaresOwnCrs(dir, file, name.split('.').pop() ?? '');
		});
	}

	test('a KML always declares its projection (WGS84 by definition)', async () => {
		expect(await probe('plan.kml', '<kml/>')).toBe(true);
	});

	test('a GeoJSON with a crs member, in any case, declares it; one without, or with a null one, does not', async () => {
		const crs = '{"type":"name","properties":{"name":"urn:ogc:def:crs:EPSG::25830"}}';
		expect(
			await probe('with.geojson', `{"type":"FeatureCollection","crs":${crs},"features":[]}`),
		).toBe(true);
		expect(
			await probe('upper.geojson', `{"type":"FeatureCollection","CRS":${crs},"features":[]}`),
		).toBe(true);
		expect(await probe('without.geojson', '{"type":"FeatureCollection","features":[]}')).toBe(
			false,
		);
		expect(
			await probe('null.geojson', '{"type":"FeatureCollection","crs":null,"features":[]}'),
		).toBe(false);
	});

	test('a GeoJSON that is not strict JSON is refused, never read as undeclared', async () => {
		const error = await probe('loose.geojson', '{"type":"FeatureCollection","features":[],}').catch(
			(caught: unknown) => caught,
		);
		expectCode(error, 'request.invalid_options');
		expect((error as DedaloError).message).toMatch(/not strict JSON/);
	});
});

describe('tool_uca_maps upload_vector_layer — the staged path is confined to the caller', () => {
	const SCRATCH_USER = 987682;
	const VICTIM = 987683;
	afterEach(() => {
		for (const userId of [SCRATCH_USER, VICTIM]) {
			rmSync(stagingOf(userId), { recursive: true, force: true });
		}
	});

	// the key_dir is pinned; a tmp_name is refused as unsafe before any path is joined
	test('a tmp_name/key_dir escaping the upload root is refused', async () => {
		for (const tmp_name of ['../../../../../etc/passwd', '/etc/passwd']) {
			const file_data = { key_dir: VECTOR_UPLOAD_KEY_DIR, tmp_name, extension: 'geojson' };
			expectCode(await failureOf(callUpload(SCRATCH_USER, { file_data })), 'media.invalid_path');
		}
		const file_data = { key_dir: '../../../../../etc', tmp_name: 'passwd', extension: 'geojson' };
		expectCode(await failureOf(callUpload(SCRATCH_USER, { file_data })), 'request.invalid_options');
	});

	// the victim's file exists: a refusal for any other reason would hide a read
	// (or, since the action deletes what it reads, a delete)
	test("another user's staged upload is refused, through key_dir or tmp_name", async () => {
		stageFile(
			VICTIM,
			'victim.geojson',
			'{"type":"FeatureCollection","features":[]}',
			VECTOR_UPLOAD_KEY_DIR,
		);
		const traversal = `../../${VICTIM}/${VECTOR_UPLOAD_KEY_DIR}/victim.geojson`;
		expectCode(
			await failureOf(
				callUpload(SCRATCH_USER, {
					file_data: { key_dir: VECTOR_UPLOAD_KEY_DIR, tmp_name: traversal, extension: 'geojson' },
				}),
			),
			'media.invalid_path',
		);
		expectCode(
			await failureOf(
				callUpload(SCRATCH_USER, {
					file_data: {
						key_dir: `../${VICTIM}/${VECTOR_UPLOAD_KEY_DIR}`,
						tmp_name: 'victim.geojson',
						extension: 'geojson',
					},
				}),
			),
			'request.invalid_options',
		);
		expect(existsSync(uploadPath(VICTIM, 'victim.geojson'))).toBe(true);
	});

	test('a staged file over the 10 MB cap is refused before any conversion runs', async () => {
		stageUpload(SCRATCH_USER, 'big.geojson', Buffer.alloc(10_000_001));
		await expect(uploadStaged(SCRATCH_USER, 'big.geojson')).rejects.toThrow(/exceeds the .* limit/);
	});

	test('a zip under the 10 MB cap that inflates past 200 MB is refused before GDAL opens it', async () => {
		const chunks: Uint8Array[] = [];
		const writer = openZipStream({ write: async (chunk) => void chunks.push(chunk.slice()) });
		const block = new Uint8Array(1_000_000);
		await writer.addStream(
			'bomb.dbf',
			(function* () {
				for (let i = 0; i < 201; i++) yield block;
			})(),
		);
		await writer.finish();
		stageUpload(SCRATCH_USER, 'bomb.zip', Buffer.concat(chunks));
		const error = await failureOf(
			uploadStaged(SCRATCH_USER, 'bomb.zip', { epsg: '25830', zone: '30', band: 'N' }),
		);
		expectCode(error, 'media.too_large');
		expect(error.message).toMatch(/inflates to more than 200000000 bytes/);
	});
});

// core collects abandoned transfers, never a completed file: each conversion
// deletes what it read, and only what was staged for it
describe('tool_uca_maps upload_vector_layer — the staged file is consumed', () => {
	const SCRATCH_USER = 987687;
	afterEach(() => rmSync(stagingOf(SCRATCH_USER), { recursive: true, force: true }));

	test('a refused upload still deletes its staged file', async () => {
		stageUpload(SCRATCH_USER, 'layer.exe', 'MZ');
		const error = await failureOf(uploadStaged(SCRATCH_USER, 'layer.exe'));
		expectCode(error, 'request.invalid_options');
		expect(error.message).toMatch(/Unsupported vector file extension 'exe'/);
		expect(existsSync(uploadPath(SCRATCH_USER, 'layer.exe'))).toBe(false);

		stageUpload(SCRATCH_USER, 'big.geojson', Buffer.alloc(10_000_001));
		await expect(uploadStaged(SCRATCH_USER, 'big.geojson')).rejects.toThrow(/exceeds/);
		expect(existsSync(uploadPath(SCRATCH_USER, 'big.geojson'))).toBe(false);
	});

	// the image ingest reads its file back from `image`: this action must not take it
	test('a file staged under another key_dir is refused and kept', async () => {
		stageFile(SCRATCH_USER, 'photo.geojson', '{}', 'image');
		const error = await failureOf(
			callUpload(SCRATCH_USER, {
				file_data: { key_dir: 'image', tmp_name: 'photo.geojson', extension: 'geojson' },
			}),
		);
		expectCode(error, 'request.invalid_options');
		expect(existsSync(resolve(stagingOf(SCRATCH_USER), 'image', 'photo.geojson'))).toBe(true);
	});

	// a request lost after its upload never reaches the handler that deletes the file
	test("the next upload sweeps the caller's uploads over an hour old, and nothing else", async () => {
		const past = (Date.now() - ORPHAN_UPLOAD_AGE_MS - 60_000) / 1000;
		stageUpload(SCRATCH_USER, 'stale.geojson', '{}');
		utimesSync(uploadPath(SCRATCH_USER, 'stale.geojson'), past, past);
		stageUpload(SCRATCH_USER, 'recent.geojson', '{}');
		stageFile(SCRATCH_USER, 'old_photo.png', 'x', 'image');
		const photo = resolve(stagingOf(SCRATCH_USER), 'image', 'old_photo.png');
		utimesSync(photo, past, past);
		stageUpload(SCRATCH_USER, 'layer.exe', 'MZ');
		await expect(uploadStaged(SCRATCH_USER, 'layer.exe')).rejects.toThrow(/Unsupported/);
		expect(existsSync(uploadPath(SCRATCH_USER, 'stale.geojson'))).toBe(false);
		expect(existsSync(uploadPath(SCRATCH_USER, 'recent.geojson'))).toBe(true);
		expect(existsSync(photo)).toBe(true);
	});
});

// a byte that is not UTF-8 is converted (core's ingest decoder) or refused,
// never turned into U+FFFD: these refusals come before any GDAL call
describe('tool_uca_maps upload_vector_layer — the uploaded text is never substituted', () => {
	const SCRATCH_USER = 987688;
	afterEach(() => rmSync(stagingOf(SCRATCH_USER), { recursive: true, force: true }));

	test.each([
		['a binary file (NUL bytes)', new Uint8Array([0x7b, 0x00, 0x7d])],
		['a file already carrying U+FFFD', new TextEncoder().encode('{"name":"Ripoll\uFFFDs"}')],
	] as const)('%s is refused with a key the user reads', async (_, bytes) => {
		stageUpload(SCRATCH_USER, 'damaged.geojson', bytes);
		const error = await failureOf(uploadStaged(SCRATCH_USER, 'damaged.geojson'));
		expectCode(error, 'request.invalid_options');
		expect((error as DedaloError).details).toEqual({ reason_key: 'upload_text_unreadable' });
		expect(existsSync(uploadPath(SCRATCH_USER, 'damaged.geojson'))).toBe(false);
	});
});

// what ogr2ogr wrote, checked without GDAL: the GeoJSON and KML inputs say
// whether they declare a projection without any binary
describe("tool_uca_maps upload_vector_layer — ogr2ogr's output, checked before it is answered", () => {
	const UTM = [725695.71, 4372210.14];
	const pointsAt = (coordinates: number[]) =>
		JSON.stringify({
			type: 'FeatureCollection',
			features: [{ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates } }],
		});
	const DECLARED_INPUT =
		'{"type":"FeatureCollection","crs":{"type":"name","properties":{"name":"EPSG:4326"}},"features":[]}';

	async function refusalFor(
		input: [string, string],
		projection: { epsg: string; utm: null } | null,
	): Promise<unknown> {
		return withScratchDir(async (dir) => {
			const inputFile = resolve(dir, input[0]);
			writeFileSync(inputFile, input[1]);
			const extension = input[0].split('.').pop() ?? '';
			return outsideLonLatRefusal(
				dir,
				[UTM[0], UTM[1]] as [number, number],
				projection,
				inputFile,
				extension,
			);
		});
	}

	test.each([
		[
			'typed fields',
			['in.geojson', pointsAt(UTM)],
			{ epsg: '4326', utm: null },
			/^With EPSG:4326 the coordinates are not longitude\/latitude \(725695\.71, 4372210\.14\): it is not this file's projection$/,
		],
		[
			'a GeoJSON declaring its crs',
			['in.geojson', DECLARED_INPUT],
			null,
			/^The coordinates do not fit the projection this file declares \(725695\.71, 4372210\.14 is not longitude\/latitude\): correct the file's projection$/,
		],
		['a KML', ['in.kml', '<kml/>'], null, /do not fit the projection this file declares/],
		[
			'a GeoJSON declaring nothing',
			['in.geojson', pointsAt(UTM)],
			null,
			/^This file does not declare its projection and its coordinates are not longitude\/latitude \(725695\.71, 4372210\.14\): provide its EPSG code/,
		],
	] as const)(
		'with %s, the refusal names the one correction that applies',
		async (label, input, projection, pattern) => {
			const refusal = await refusalFor([input[0], input[1]], projection);
			expectCode(refusal, 'request.invalid_options');
			// the specifics stay in the log; the user reads the key's sentence
			expect((refusal as DedaloError).message).toMatch(pattern);
			expect((refusal as DedaloError).details).toEqual({
				reason_key: {
					'typed fields': 'projection_not_this_file',
					'a GeoJSON declaring its crs': 'projection_declared_wrong',
					'a KML': 'projection_declared_wrong',
					'a GeoJSON declaring nothing': 'projection_required',
				}[label],
			});
		},
	);

	async function converted(output: string, input = pointsAt([-0.375, 39.47])) {
		return withScratchDir(async (dir) => {
			const outputFile = resolve(dir, 'out.geojson');
			const inputFile = resolve(dir, 'in.geojson');
			writeFileSync(outputFile, output);
			writeFileSync(inputFile, input);
			return readConvertedLayer(dir, outputFile, inputFile, 'geojson', null);
		});
	}

	test('an output that is no FeatureCollection fails the conversion, never answers an empty layer', async () => {
		for (const output of [
			'',
			'not json',
			'{"type":"Feature","features":[]}',
			'{"type":"FeatureCollection"}',
		]) {
			expectCode(await failureOf(converted(output)), 'tool.action_failed');
		}
	});

	test('an output over 200 MB is refused before it is read', async () => {
		const refusal = await failureOf(
			withScratchDir(async (dir) => {
				const outputFile = resolve(dir, 'out.geojson');
				const inputFile = resolve(dir, 'in.geojson');
				writeFileSync(outputFile, '');
				truncateSync(outputFile, 200_000_001);
				writeFileSync(inputFile, pointsAt([-0.375, 39.47]));
				return readConvertedLayer(dir, outputFile, inputFile, 'geojson', null);
			}),
		);
		expectCode(refusal, 'media.too_large');
		expect(refusal.message).toMatch(/converted layer \(200000001 bytes\) exceeds/);
	});

	test('a position that is not longitude/latitude is refused, not answered', async () => {
		const refusal = await failureOf(converted(pointsAt(UTM), pointsAt(UTM)));
		expectCode(refusal, 'request.invalid_options');
		expect(refusal.message).toMatch(/does not declare its projection/);
	});

	test('the answer has one feature per part, and an empty Multi* or GeometryCollection is dropped', async () => {
		const feature = (geometry: unknown) => ({
			type: 'Feature',
			properties: { name: 'x' },
			geometry,
		});
		const layer = await converted(
			JSON.stringify({
				type: 'FeatureCollection',
				features: [
					feature({
						type: 'MultiPoint',
						coordinates: [
							[-0.4, 39.4],
							[-0.41, 39.41],
						],
					}),
					feature({ type: 'MultiPolygon', coordinates: [] }),
					feature({ type: 'GeometryCollection', geometries: [] }),
				],
			}),
		);
		expect(layer.features.map((f) => (f as { geometry: unknown }).geometry)).toEqual([
			{ type: 'Point', coordinates: [-0.4, 39.4] },
			{ type: 'Point', coordinates: [-0.41, 39.41] },
		]);
	});
});

describe.skipIf(!HAVE_GDAL)(
	'tool_uca_maps upload_vector_layer — real ogr2ogr conversion (needs ogr2ogr, ogrinfo, gdalsrsinfo)',
	() => {
		const SCRATCH_USER = 987684;
		const userStaging = stagingOf(SCRATCH_USER);
		afterEach(() => rmSync(userStaging, { recursive: true, force: true }));

		// one point is enough: the round-trip proves the conversion path, not GDAL's geometry coverage
		const SOURCE_GEOJSON =
			'{"type":"FeatureCollection","features":[{"type":"Feature","properties":{"name":"a"},"geometry":{"type":"Point","coordinates":[-0.375,39.47]}}]}';

		/** `src.geojson` (SOURCE_GEOJSON) converted by ogr2ogr with `args` to `outName` in `dir`. */
		async function ogrFixture(dir: string, outName: string, args: string[]): Promise<string> {
			const src = resolve(dir, 'src.geojson');
			writeFileSync(src, SOURCE_GEOJSON);
			const out = resolve(dir, outName);
			const ogr2ogr = await resolveGdalBinary('ogr2ogr');
			await runToolBinary(
				[ogr2ogr, '-if', 'GeoJSON', ...args, out, src],
				`test fixture (${outName})`,
				{ scratchDir: dir, expectedOutput: out },
			);
			return out;
		}

		/** The conversion's answer, as these gates read it. */
		interface UploadedLayer {
			geojson: {
				type: string;
				features: {
					properties: Record<string, unknown>;
					geometry: { type: string; coordinates: [number, number] };
				}[];
			};
			feature_count: number;
			read_as?: string;
		}

		test('a plain WGS84 .geojson round-trips unchanged', async () => {
			stageUpload(SCRATCH_USER, 'plain.geojson', SOURCE_GEOJSON);
			const response = await uploadStaged(SCRATCH_USER, 'plain.geojson');
			expect(existsSync(uploadPath(SCRATCH_USER, 'plain.geojson'))).toBe(false);
			expect(response.ok).toBe(true);
			const data = dataOf<UploadedLayer>(response);
			expect(data.feature_count).toBe(1);
			expect(data.geojson.type).toBe('FeatureCollection');
			const feature = mustGet(data.geojson.features[0], 'features[0]');
			expect(feature.geometry.coordinates).toEqual([-0.375, 39.47]);
			expect(data.read_as).toBeUndefined();
		});

		// what older software writes: every byte maps, so it converts, and the user is told
		test('a windows-1252 .geojson converts and says it was read as such', async () => {
			const text = SOURCE_GEOJSON.replace('"name":"a"', '"name":"Ripollès"');
			expect(text).toContain('Ripollès');
			stageUpload(SCRATCH_USER, 'legacy.geojson', Buffer.from(text, 'latin1'));
			const data = dataOf<UploadedLayer>(await uploadStaged(SCRATCH_USER, 'legacy.geojson'));
			expect(data.read_as).toBe('windows-1252');
			expect(mustGet(data.geojson.features[0], 'features[0]').properties.name).toBe('Ripollès');
		});

		test('a .kml round-trips to WGS84 GeoJSON', async () => {
			const kmlBytes = await withScratchDir(async (dir) =>
				Bun.file(await ogrFixture(dir, 'src.kml', ['-f', 'KML'])).text(),
			);
			stageUpload(SCRATCH_USER, 'plain.kml', kmlBytes);
			const response = await uploadStaged(SCRATCH_USER, 'plain.kml');
			expect(response.ok).toBe(true);
			expect(dataOf<UploadedLayer>(response).feature_count).toBe(1);
		});

		test('a .kml MultiGeometry arrives as one single-part feature per member', async () => {
			const point = (lon: number) => `<Point><coordinates>${lon},39.4</coordinates></Point>`;
			const kml =
				'<?xml version="1.0" encoding="UTF-8"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document>' +
				`<Placemark><name>pts</name><MultiGeometry>${point(-0.4)}${point(-0.41)}</MultiGeometry></Placemark>` +
				'<Placemark><name>mix</name><MultiGeometry>' +
				`${point(-0.4)}<LineString><coordinates>-0.4,39.4 -0.42,39.42</coordinates></LineString>` +
				'</MultiGeometry></Placemark></Document></kml>';
			stageUpload(SCRATCH_USER, 'multi.kml', kml);
			const response = await uploadStaged(SCRATCH_USER, 'multi.kml');
			expect(response.ok).toBe(true);
			const data = dataOf<UploadedLayer>(response);
			expect(data.feature_count).toBe(4);
			expect(data.geojson.features.map((f) => f.geometry.type)).toEqual([
				'Point',
				'Point',
				'Point',
				'LineString',
			]);
		});

		test('a zipped shapefile with a UTM .prj reprojects on its own and refuses the fields', async () => {
			const zipBytes = await withScratchDir(async (dir) => {
				// GDAL opens a zipped shapefile only by the literal '.shp.zip', the
				// way vector_download.ts writes one
				const out = await ogrFixture(dir, 'utm.shp.zip', [
					'-f',
					'ESRI Shapefile',
					'-t_srs',
					'EPSG:25830',
				]);
				return Bun.file(out).arrayBuffer();
			});
			// staged upload's real name never carries a meaningful extension (an
			// opaque tmp_name) — the client-declared 'zip' extension is what routes
			// this through the '.shp.zip' scratch-name branch.
			stageUpload(SCRATCH_USER, 'plain.zip', new Uint8Array(zipBytes));
			const response = await uploadStaged(SCRATCH_USER, 'plain.zip');
			expect(response.ok).toBe(true);
			const data = dataOf<UploadedLayer>(response);
			expect(data.feature_count).toBe(1);
			const [lon, lat] = mustGet(data.geojson.features[0], 'features[0]').geometry.coordinates;
			expect(lon).toBeCloseTo(-0.375, 3);
			expect(lat).toBeCloseTo(39.47, 3);

			// the file's own .prj wins, as in v6: even fields that agree with it are
			// refused rather than handed to -s_srs, which would override it silently
			await expect(
				uploadStaged(SCRATCH_USER, 'plain.zip', { epsg: '25830', zone: '30', band: 'N' }),
			).rejects.toThrow(/already declares its own projection/);

			// checked BEFORE the EPSG lookup: a UTM code without zone/band, or a
			// wrong zone, must not first send the user to fill in more fields
			const partialOrWrong: Record<string, string>[] = [
				{ epsg: '32630' },
				{ epsg: '25830', zone: '19', band: 'N' },
			];
			for (const fields of partialOrWrong) {
				await expect(uploadStaged(SCRATCH_USER, 'plain.zip', fields)).rejects.toThrow(
					/already declares its own projection/,
				);
			}
		});

		test('a zipped shapefile without a .prj is refused until EPSG, zone and band are given', async () => {
			const zipBytes = await withScratchDir(async (dir) => {
				await ogrFixture(dir, 'utm.shp', ['-f', 'ESRI Shapefile', '-t_srs', 'EPSG:25830']);
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
				const ogr2ogr = await resolveGdalBinary('ogr2ogr');
				await runToolBinary(
					[
						ogr2ogr,
						'-if',
						'ESRI Shapefile',
						'-f',
						'ESRI Shapefile',
						out,
						resolve(noPrjDir, 'noprj.shp'),
					],
					'test fixture (noprj shp.zip)',
					{ scratchDir: dir, expectedOutput: out },
				);
				return Bun.file(out).arrayBuffer();
			});
			stageUpload(SCRATCH_USER, 'noprj.zip', new Uint8Array(zipBytes));
			await expect(uploadStaged(SCRATCH_USER, 'noprj.zip')).rejects.toThrow(
				/no embedded coordinate system/,
			);

			// PROJ, not a regex, says what 25830 is: a zone it contradicts and a
			// code it does not know are both refused before ogr2ogr runs
			await expect(
				uploadStaged(SCRATCH_USER, 'noprj.zip', { epsg: '25830', zone: '19', band: 'N' }),
			).rejects.toThrow(
				/UTM zone 30, northern hemisphere \(band N to X\), not the zone and band given \(zone 19, northern/,
			);
			await expect(
				uploadStaged(SCRATCH_USER, 'noprj.zip', { epsg: '99999', zone: '30', band: 'N' }),
			).rejects.toThrow(/Unknown EPSG code/);

			// S is an MGRS band of the north (Spain lies in S and T)
			const response = await uploadStaged(SCRATCH_USER, 'noprj.zip', {
				epsg: '25830',
				zone: '30',
				band: 'S',
			});
			expect(response.ok).toBe(true);
			const [lon, lat] = mustGet(dataOf<UploadedLayer>(response).geojson.features[0], 'features[0]')
				.geometry.coordinates;
			expect(lon).toBeCloseTo(-0.375, 3);
			expect(lat).toBeCloseTo(39.47, 3);
		});

		test('a CRS-less shapefile in longitude/latitude takes the EPSG alone (v6 lists 4326 with no zone or band)', async () => {
			const zipBytes = await withScratchDir(async (dir) => {
				const shp = await ogrFixture(dir, 'lonlat.shp', ['-f', 'ESRI Shapefile']);
				rmSync(resolve(dir, 'lonlat.prj'));
				const out = resolve(dir, 'lonlat.shp.zip');
				const ogr2ogr = await resolveGdalBinary('ogr2ogr');
				await runToolBinary(
					[ogr2ogr, '-if', 'ESRI Shapefile', '-f', 'ESRI Shapefile', out, shp],
					'test fixture (lonlat noprj shp.zip)',
					{ scratchDir: dir, expectedOutput: out },
				);
				return Bun.file(out).arrayBuffer();
			});
			stageUpload(SCRATCH_USER, 'lonlat.zip', new Uint8Array(zipBytes));
			const response = await uploadStaged(SCRATCH_USER, 'lonlat.zip', { epsg: '4326' });
			expect(response.ok).toBe(true);
			const [lon, lat] = mustGet(dataOf<UploadedLayer>(response).geojson.features[0], 'features[0]')
				.geometry.coordinates;
			expect(lon).toBeCloseTo(-0.375, 6);
			expect(lat).toBeCloseTo(39.47, 6);
		});

		test('a legacy UTM .geojson without crs takes the fields; one declaring crs refuses them', async () => {
			const declared = await withScratchDir(async (dir) => {
				const out = await ogrFixture(dir, 'utm.geojson', [
					'-f',
					'GeoJSON',
					'-lco',
					'RFC7946=NO',
					'-t_srs',
					'EPSG:25830',
				]);
				return (await Bun.file(out).json()) as Record<string, unknown>;
			});
			expect(declared.crs).toBeDefined();
			const { crs: _crs, ...legacy } = declared;
			stageUpload(SCRATCH_USER, 'declared.geojson', JSON.stringify(declared));
			stageUpload(SCRATCH_USER, 'legacy.geojson', JSON.stringify(legacy));
			const fields = { epsg: '25830', zone: '30', band: 'N' };
			await expect(uploadStaged(SCRATCH_USER, 'declared.geojson', fields)).rejects.toThrow(
				/already declares its own projection/,
			);

			const response = await uploadStaged(SCRATCH_USER, 'legacy.geojson', fields);
			const [lon, lat] = mustGet(dataOf<UploadedLayer>(response).geojson.features[0], 'features[0]')
				.geometry.coordinates;
			expect(lon).toBeCloseTo(-0.375, 3);
			expect(lat).toBeCloseTo(39.47, 3);
		});

		test('coordinates ogr2ogr leaves as no longitude/latitude are refused, the right fields fix them', async () => {
			const features =
				'"features":[{"type":"Feature","properties":{"name":"a"},"geometry":{"type":"Point","coordinates":[725695.71,4372210.14]}}]';
			stageUpload(SCRATCH_USER, 'undeclared.geojson', `{"type":"FeatureCollection",${features}}`);
			stageUpload(
				SCRATCH_USER,
				'declared.geojson',
				`{"type":"FeatureCollection","crs":{"type":"name","properties":{"name":"urn:ogc:def:crs:EPSG::4326"}},${features}}`,
			);
			// GDAL reads a CRS-less GeoJSON as WGS84 and writes its metres through unchanged
			await expect(uploadStaged(SCRATCH_USER, 'undeclared.geojson')).rejects.toThrow(
				/does not declare its projection and its coordinates are not longitude\/latitude \(725695\.71, 4372210\.14\): provide its EPSG code/,
			);
			await expect(
				uploadStaged(SCRATCH_USER, 'undeclared.geojson', { epsg: '4326' }),
			).rejects.toThrow(
				/With EPSG:4326 the coordinates are not longitude\/latitude .*not this file's projection/,
			);
			// the fields would be refused on this file: only the file itself can be corrected
			await expect(uploadStaged(SCRATCH_USER, 'declared.geojson')).rejects.toThrow(
				/do not fit the projection this file declares/,
			);

			// the same metres with their projection land in Valencia
			const response = await uploadStaged(SCRATCH_USER, 'undeclared.geojson', {
				epsg: '25830',
				zone: '30',
				band: 'S',
			});
			const [lon, lat] = mustGet(dataOf<UploadedLayer>(response).geojson.features[0], 'features[0]')
				.geometry.coordinates;
			expect(lon).toBeCloseTo(-0.375, 1);
			expect(lat).toBeCloseTo(39.47, 1);
		});
	},
);
