/**
 * tool_uca_maps — GDAL never reaches the network nor a file it was not given.
 *
 * GDAL fetches on its own through libcurl (a GeoJSON `crs` of type link/URL,
 * a VRT's `/vsicurl/`), out of sight of the engine's SSRF guard, and picks its
 * driver by CONTENT: a `.kml`, `.png` or `.tif` that is really a VRT reads any
 * path or URL it names. Three layers, each gated here on its own:
 *  - every spawn runs with `OFFLINE_ENV` (proven against a loopback listener
 *    that counts TCP connections, with the input deliberately NOT inspected);
 *  - every GDAL file read names its driver (`-if`), or `runToolBinary`
 *    refuses it before spawning;
 *  - an uploaded GeoJSON is strict JSON, reserialized, with no linked `crs`
 *    anywhere GDAL reads one; the client's GeoJSON in `vector_download` is held
 *    to the same rule. Those refusals come before any binary, so they run
 *    where GDAL is not installed.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import type { TCPSocketListener } from 'bun';
import { config } from '../../src/config/config.ts';
import { DedaloError } from '../../src/core/errors/index.ts';
import { getLoadedTool } from '../../src/core/tools/loader.ts';
import type { GatedToolActionSpec, ToolActionContext } from '../../src/core/tools/module.ts';
import {
	assertOfflineGeoJsonCrs,
	inputDrivers,
	OFFLINE_ENV,
	rasterDriverOf,
	resolveGdalBinary,
	runToolBinary,
	SCRATCH_ORPHAN_TTL_MS,
	scratchRoot,
	withScratchDir,
} from '../../tools/tool_uca_maps/server/gdal.ts';
import { renderImageDownload } from '../../tools/tool_uca_maps/server/image_download.ts';
import { readGeoreference } from '../../tools/tool_uca_maps/server/image_overlay.ts';
import { parseStrictGeoJson } from '../../tools/tool_uca_maps/server/vector_upload.ts';
import { mustGet } from '../helpers/assert.ts';
import { scratchMediaRoot } from '../helpers/media_scratch_root.ts';

const HAVE_GDAL = [
	'ogr2ogr',
	'ogrinfo',
	'gdalinfo',
	'gdal_translate',
	'gdalwarp',
	'gdal_create',
].every((binary) => Bun.which(binary) !== null);

async function loadAction(name: string): Promise<GatedToolActionSpec> {
	const loaded = await getLoadedTool('tool_uca_maps');
	const tool = mustGet(loaded, 'tool_uca_maps');
	return mustGet(tool.module.apiActions[name], name) as GatedToolActionSpec;
}

function contextOf(userId: number, options: Record<string, unknown>): ToolActionContext {
	return {
		principal: { userId, isGlobalAdmin: true, isDeveloper: true },
		userId,
		options: { section_tipo: 'test2', tipo: 'test52', section_id: 905101, ...options },
		background: false,
	};
}

/** The thrown value of a promise expected to reject. */
async function rejection(promise: Promise<unknown>): Promise<unknown> {
	return promise.then(
		() => {
			throw new Error('expected a rejection');
		},
		(error: unknown) => error,
	);
}

function expectCode(error: unknown, code: DedaloError['code']): void {
	expect(error).toBeInstanceOf(DedaloError);
	expect((error as DedaloError).code).toBe(code);
}

const POINT_FEATURES =
	'"features":[{"type":"Feature","properties":{},"geometry":{"type":"Point","coordinates":[-0.375,39.47]}}]';

const LINK = { type: 'link', properties: { href: 'http://127.0.0.1:9/crs' } };

/** Every place GDAL's GeoJSON reader takes a `crs` from, each holding a link. */
const LINKED_CRS_SHAPES: Readonly<Record<string, unknown>> = {
	root: { type: 'FeatureCollection', crs: LINK, features: [] },
	root_upper_case: { type: 'FeatureCollection', CRS: LINK, features: [] },
	geometry: {
		type: 'FeatureCollection',
		features: [
			{
				type: 'Feature',
				properties: {},
				geometry: { type: 'Point', crs: LINK, coordinates: [0, 0] },
			},
		],
	},
	collection_member: {
		type: 'Feature',
		properties: {},
		geometry: {
			type: 'GeometryCollection',
			geometries: [{ type: 'Point', Crs: LINK, coordinates: [0, 0] }],
		},
	},
	two_type_spellings: {
		type: 'FeatureCollection',
		crs: {
			type: 'name',
			TYPE: 'link',
			properties: { name: 'EPSG:4326', href: LINK.properties.href },
		},
		features: [],
	},
};

describe('tool_uca_maps GeoJSON crs — only what GDAL resolves offline (pure)', () => {
	test('no crs, a null one, and the name / EPSG / OGC types pass, any case', () => {
		for (const crs of [
			undefined,
			null,
			{ type: 'name', properties: { name: 'urn:ogc:def:crs:EPSG::25830' } },
			{ type: 'Name', properties: { name: 'EPSG:4326' } },
			{ type: 'EPSG', properties: { code: 25830 } },
			{ type: 'OGC', properties: { urn: 'urn:ogc:def:crs:OGC:1.3:CRS84' } },
		]) {
			expect(() => assertOfflineGeoJsonCrs({ type: 'FeatureCollection', crs })).not.toThrow();
		}
	});

	test('link, URL in any case, an unknown type and a typeless crs are refused as the caller fault', () => {
		for (const crs of [
			{ type: 'link', properties: { href: 'http://169.254.169.254/latest' } },
			{ type: 'LINK', properties: { href: 'http://127.0.0.1/' } },
			{ type: 'URL', properties: { url: 'https://127.0.0.1/' } },
			{ type: 'url', properties: { url: 'http://127.0.0.1/' } },
			{ type: 'whatever' },
			{ properties: {} },
			'EPSG:4326',
		]) {
			let error: unknown = null;
			try {
				assertOfflineGeoJsonCrs({ type: 'FeatureCollection', crs });
			} catch (caught) {
				error = caught;
			}
			expectCode(error, 'request.invalid_options');
			expect((error as DedaloError).publicMessage).toMatch(
				/crs is a link, which is never followed/,
			);
		}
	});

	test('every crs GDAL reads is checked: on a geometry, in a collection, in any case; attribute values are not', () => {
		for (const [shape, geojson] of Object.entries(LINKED_CRS_SHAPES)) {
			let error: unknown = null;
			try {
				assertOfflineGeoJsonCrs(geojson);
			} catch (caught) {
				error = caught;
			}
			expect([shape, error instanceof DedaloError]).toEqual([shape, true]);
			expectCode(error, 'request.invalid_options');
		}
		// a feature attribute named crs is the user's data: GDAL never resolves it
		expect(() =>
			assertOfflineGeoJsonCrs({
				type: 'Feature',
				properties: { crs: LINK },
				geometry: { type: 'Point', coordinates: [0, 0] },
			}),
		).not.toThrow();
	});

	test('an upload is parsed strictly: lenient JSON and a linked crs are refused, a UTF-8 BOM is not', () => {
		expect(parseStrictGeoJson(`﻿{"type":"FeatureCollection",${POINT_FEATURES}}`)).toEqual(
			JSON.parse(`{"type":"FeatureCollection",${POINT_FEATURES}}`),
		);
		for (const [text, pattern] of [
			[`{"type":"FeatureCollection",${POINT_FEATURES},}`, /not strict JSON/],
			[
				`{"type":"FeatureCollection","crs":{"type":"link","properties":{"href":"http://127.0.0.1/"}},${POINT_FEATURES}}`,
				/crs is a link/,
			],
		] as const) {
			let error: unknown = null;
			try {
				parseStrictGeoJson(text);
			} catch (caught) {
				error = caught;
			}
			expectCode(error, 'request.invalid_options');
			expect((error as DedaloError).message).toMatch(pattern);
		}
	});
});

describe('tool_uca_maps runToolBinary — the spawn discipline (no GDAL needed)', () => {
	test('a GDAL file reader without -if is refused before any spawn', async () => {
		for (const name of ['ogr2ogr', 'ogrinfo', 'gdalinfo', 'gdal_translate', 'gdalwarp']) {
			// a path that does not exist: a spawn would fail ENOENT, not with this code
			const error = await rejection(
				runToolBinary([`/nonexistent/${name}`, '-json', 'in.tif'], `probe ${name}`, {
					scratchDir: '/nonexistent/scratch',
				}),
			);
			expectCode(error, 'internal.invariant');
			expect((error as DedaloError).message).toMatch(/driver named \(-if\)/);
		}
	});

	test('every spawn runs with the offline env, which a caller env cannot override', async () => {
		const env = mustGet(Bun.which('env'), 'env binary');
		const result = await runToolBinary([env], 'probe env', {
			scratchDir: '/scratch/probe',
			env: { GDAL_HTTP_PROXY: 'http://127.0.0.1:1', NO_PROXY: '*', PROJ_NETWORK: 'ON' },
		});
		const lines = new Set(result.stdout.split('\n'));
		for (const [key, value] of Object.entries(OFFLINE_ENV)) {
			expect(lines.has(`${key}=${value}`)).toBe(true);
		}
	});

	test("every spawn's temp dir is its scratch, which a caller env cannot override", async () => {
		const env = mustGet(Bun.which('env'), 'env binary');
		const result = await runToolBinary([env], 'probe env', {
			scratchDir: '/scratch/probe',
			env: { CPL_TMPDIR: '/tmp', TMPDIR: '/tmp' },
		});
		const lines = new Set(result.stdout.split('\n'));
		expect(lines.has('CPL_TMPDIR=/scratch/probe')).toBe(true);
		expect(lines.has('TMPDIR=/scratch/probe')).toBe(true);
	});

	test('a raster driver comes from the extension; an unknown one, VRT included, is refused', () => {
		expect(rasterDriverOf('/x/a.TIF')).toBe('GTiff');
		expect(rasterDriverOf('/x/a.jpeg')).toBe('JPEG');
		expect(rasterDriverOf('/x/a.png')).toBe('PNG');
		expect(() => rasterDriverOf('/x/a.xml')).toThrow(/no raster driver/);
		expect(() => rasterDriverOf('/x/a.vrt')).toThrow(/no raster driver/);
	});
});

describe('tool_uca_maps scratch — inside the media root, never the OS temp dir (no GDAL needed)', () => {
	// ImageMagick spills its pixel cache into the scratch dir, and the OS temp
	// dir is the database's volume on the shipped compose stacks
	const within = (dir: string, root: string) => resolve(dir).startsWith(resolve(root) + sep);

	test('each call gets a private dir under the media root, swept afterwards', async () => {
		const mediaRoot = resolve(mustGet(config.media.rootPath, 'config.media.rootPath'));
		const toolRoot = join(mediaRoot, config.media.upload.tmpSubdir, 'tool_uca_maps');
		const seen: string[] = [];
		for (let i = 0; i < 2; i++) {
			await withScratchDir(async (dir) => {
				seen.push(dir);
				expect(existsSync(dir)).toBe(true);
				expect(within(dir, toolRoot)).toBe(true);
			});
		}
		expect(seen.length).toBe(2);
		expect(seen[0]).not.toBe(seen[1]);
		for (const dir of seen) expect(existsSync(dir)).toBe(false);
	});

	test('no media root, or an empty one, refuses as the missing dependency it is', () => {
		for (const root of [null, '']) {
			let error: unknown = null;
			try {
				scratchRoot(root);
			} catch (caught) {
				error = caught;
			}
			expectCode(error, 'tool.dependency_unavailable');
		}
	});

	test('a root without the test-media marker is refused and nothing is created in it', () => {
		const unmarked = mkdtempSync(join(tmpdir(), 'uca_maps_unmarked_'));
		try {
			let error: unknown = null;
			try {
				scratchRoot(unmarked);
			} catch (caught) {
				error = caught;
			}
			expectCode(error, 'media.invalid_path');
			expect(existsSync(join(unmarked, config.media.upload.tmpSubdir))).toBe(false);
		} finally {
			rmSync(unmarked, { recursive: true, force: true });
		}
	});

	test('a marked root gets the scratch under its staging tree, closed to other users', () => {
		const marked = scratchMediaRoot('uca_maps_marked_');
		try {
			const scratch = scratchRoot(marked);
			expect(scratch).toBe(join(marked, config.media.upload.tmpSubdir, 'tool_uca_maps'));
			expect(statSync(scratch).isDirectory()).toBe(true);
			expect(statSync(scratch).mode & 0o007).toBe(0);
		} finally {
			rmSync(marked, { recursive: true, force: true });
		}
	});

	test('an orphan a killed process left is swept; a live one and a foreign entry are kept', async () => {
		const root = scratchRoot();
		const old = join(root, 'scratch_orphan_gate');
		const live = join(root, 'scratch_live_gate');
		const foreign = join(root, 'not_scratch_gate');
		try {
			for (const dir of [old, live, foreign]) {
				mkdirSync(dir, { recursive: true });
				writeFileSync(join(dir, 'magick-spill'), 'x');
			}
			const stale = (Date.now() - SCRATCH_ORPHAN_TTL_MS - 60_000) / 1000;
			for (const dir of [old, foreign]) {
				utimesSync(join(dir, 'magick-spill'), stale, stale);
				utimesSync(dir, stale, stale);
			}

			await withScratchDir(async () => {});

			expect(existsSync(old)).toBe(false);
			expect(existsSync(live)).toBe(true);
			expect(existsSync(foreign)).toBe(true);
		} finally {
			for (const dir of [old, live, foreign]) rmSync(dir, { recursive: true, force: true });
		}
	});
});

// refused before any binary runs, so these hold where GDAL is not installed (CI)
describe('tool_uca_maps handlers refuse a linked crs and lenient JSON before GDAL (no GDAL needed)', () => {
	test("vector_download refuses the client's linked crs, wherever it sits", async () => {
		const action = await loadAction('vector_download');
		for (const geojson of Object.values(LINKED_CRS_SHAPES)) {
			const error = await rejection(action.handler(contextOf(-1, { format: 'kml', geojson })));
			expectCode(error, 'request.invalid_options');
		}
	});

	test('upload_vector_layer refuses a linked crs, lenient JSON and a VRT posing as GeoJSON', async () => {
		const userId = 987656;
		const staging = resolve(
			config.media.rootPath ?? '',
			config.media.upload.tmpSubdir,
			String(userId),
		);
		const action = await loadAction('upload_vector_layer');
		const staged: Record<string, string> = {
			'lenient.geojson': `{"type":"FeatureCollection",${POINT_FEATURES},}`,
			'vrt.geojson':
				'<OGRVRTDataSource><OGRVRTLayer name="x"><SrcDataSource>CSV:/etc/passwd</SrcDataSource></OGRVRTLayer></OGRVRTDataSource>',
		};
		for (const [shape, geojson] of Object.entries(LINKED_CRS_SHAPES)) {
			staged[`${shape}.geojson`] = JSON.stringify(geojson);
		}
		mkdirSync(staging, { recursive: true });
		try {
			for (const [name, text] of Object.entries(staged)) {
				writeFileSync(resolve(staging, name), text);
				const error = await rejection(
					action.handler(
						contextOf(userId, {
							file_data: { key_dir: '', tmp_name: name, extension: 'geojson' },
						}),
					),
				);
				expectCode(error, 'request.invalid_options');
			}
		} finally {
			rmSync(staging, { recursive: true, force: true });
		}
	});
});

describe.if(HAVE_GDAL)('tool_uca_maps GDAL — zero connections, real binaries', () => {
	let connections = 0;
	let listener: TCPSocketListener<undefined>;
	let base = '';

	beforeAll(() => {
		listener = Bun.listen({
			hostname: '127.0.0.1',
			port: 0,
			socket: {
				open(socket) {
					connections += 1;
					socket.end();
				},
				data() {},
			},
		});
		base = `127.0.0.1:${listener.port}`;
	});

	afterAll(() => {
		listener.stop(true);
	});

	beforeEach(() => {
		connections = 0;
	});

	const linkCrs = (scheme: string, type: string, key: string) =>
		`{"type":"FeatureCollection","crs":{"type":"${type}","properties":{"${key}":"${scheme}://${base}/crs"}},${POINT_FEATURES}}`;
	const vectorVrt = (source: string) =>
		`<OGRVRTDataSource><OGRVRTLayer name="canary"><SrcDataSource>${source}</SrcDataSource></OGRVRTLayer></OGRVRTDataSource>`;
	// georeferenced, so a VRT GDAL opened would visibly succeed: a download
	// with content, an overlay with corners — the refusal is the driver's
	const rasterVrt = (source: string) =>
		`<VRTDataset rasterXSize="2" rasterYSize="2"><SRS>EPSG:4326</SRS><GeoTransform>-1,0.5,0,40,0,-0.5</GeoTransform><VRTRasterBand dataType="Byte" band="1"><SimpleSource><SourceFilename relativeToVRT="0">${source}</SourceFilename><SourceBand>1</SourceBand></SimpleSource></VRTRasterBand></VRTDataset>`;

	test('the offline env alone stops a linked crs and a /vsicurl/ source, http and https', async () => {
		await withScratchDir(async (dir) => {
			const ogr2ogr = await resolveGdalBinary('ogr2ogr');
			const inputs: [string, string, string][] = [
				['link.geojson', linkCrs('http', 'link', 'href'), 'GeoJSON'],
				['url.geojson', linkCrs('https', 'URL', 'url'), 'GeoJSON'],
				['curl.vrt', vectorVrt(`/vsicurl/http://${base}/v.csv`), 'OGR_VRT'],
			];
			for (const [name, text, driver] of inputs) {
				const input = resolve(dir, name);
				writeFileSync(input, text);
				// not inspected on purpose: whatever GDAL then does, it is offline
				await runToolBinary(
					[ogr2ogr, ...inputDrivers(driver), '-f', 'GeoJSON', resolve(dir, `${name}.out`), input],
					`probe ${name}`,
					{ scratchDir: dir },
				).catch(() => null);
			}
		});
		expect(connections).toBe(0);
	});

	test('upload_vector_layer never opens a VRT posing as KML, local or remote', async () => {
		const userId = 987657;
		const staging = resolve(
			config.media.rootPath ?? '',
			config.media.upload.tmpSubdir,
			String(userId),
		);
		const action = await loadAction('upload_vector_layer');
		await withScratchDir(async (dir) => {
			// two lines: GDAL's CSV driver would hand the second back as a feature
			const canary = resolve(dir, 'canary.csv');
			writeFileSync(canary, 'secret\nUCA_MAPS_CANARY\n');
			const staged: [string, string][] = [
				['local.kml', vectorVrt(`CSV:${canary}`)],
				['remote.kml', vectorVrt(`/vsicurl/http://${base}/v.csv`)],
			];
			mkdirSync(staging, { recursive: true });
			try {
				for (const [name, text] of staged) {
					writeFileSync(resolve(staging, name), text);
					const error = await rejection(
						action.handler(
							contextOf(userId, {
								file_data: { key_dir: '', tmp_name: name, extension: name.split('.').pop() },
							}),
						),
					);
					expectCode(error, 'tool.action_failed');
					expect(String((error as Error).message)).not.toContain('UCA_MAPS_CANARY');
				}
			} finally {
				rmSync(staging, { recursive: true, force: true });
			}
		});
		expect(connections).toBe(0);
	});

	test('a raster VRT posing as the PNG screenshot, the overlay TIFF or the drawn image is never opened', async () => {
		const rasterDownload = await loadAction('raster_download');
		const corners = {
			top_left: [40, -1] as [number, number],
			top_right: [40, 0] as [number, number],
			bottom_left: [39, -1] as [number, number],
		};
		await withScratchDir(async (dir) => {
			// a local raster a VRT could name: opened, it would come back as the download
			const canary = resolve(dir, 'canary.tif');
			const made = Bun.spawnSync(
				[
					...['gdal_create', '-of', 'GTiff', '-outsize', '2', '2', '-bands', '1', '-burn', '77'],
					...['-a_srs', 'EPSG:4326', '-a_ullr', '-1', '40', '0', '39', canary],
				],
				{ stdout: 'ignore', stderr: 'ignore' },
			);
			expect(made.exitCode).toBe(0);

			for (const source of [canary, `/vsicurl/http://${base}/r.tif`]) {
				const vrt = rasterVrt(source);
				expectCode(
					await rejection(
						rasterDownload.handler(
							contextOf(-1, {
								format: 'geotiff',
								image_base64: Buffer.from(vrt).toString('base64'),
								bounds: { west: -1, south: 39, east: 0, north: 40 },
							}),
						),
					),
					'tool.action_failed',
				);

				const tif = resolve(dir, 'overlay.tif');
				writeFileSync(tif, vrt);
				expectCode(await rejection(readGeoreference(tif)), 'tool.action_failed');

				const png = resolve(dir, 'drawn.png');
				writeFileSync(png, vrt);
				expectCode(
					await rejection(renderImageDownload(dir, png, corners, 'png', 1)),
					'tool.action_failed',
				);
			}
		});
		expect(connections).toBe(0);
	});
});
