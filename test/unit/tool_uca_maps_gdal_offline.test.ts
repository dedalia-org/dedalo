/**
 * tool_uca_maps — GDAL never reaches the network nor a file it was not given. GDAL
 * fetches through libcurl (a GeoJSON link `crs`, a VRT's `/vsicurl/`) outside the
 * engine's SSRF guard, and picks its driver by CONTENT: a `.kml`/`.png`/`.tif` that is
 * really a VRT reads any path it names. Gated here: the `OFFLINE_ENV` spawn, the named
 * driver (`-if`), strict reserialized GeoJSON (those refusals run without GDAL).
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DedaloError } from '../../src/core/errors/index.ts';
import { runBinary } from '../../src/core/media/engine/spawn.ts';
import {
	MAP_IMAGE_KEY_DIR,
	OBJECT_GEOJSON_KEY_DIR,
	VECTOR_UPLOAD_KEY_DIR,
} from '../../tools/tool_uca_maps/js/upload_formats.js';
import { meetsGdalMinVersion } from '../../tools/tool_uca_maps/server/capabilities.ts';
import {
	assertOfflineGeoJsonCrs,
	GDAL_READ_ENV,
	inputDrivers,
	isMissingGdalBinary,
	OFFLINE_ENV,
	rasterDriverOf,
	resolveGdalBinary,
	runToolBinary,
	scratchRoot,
	withScratchDir,
} from '../../tools/tool_uca_maps/server/gdal.ts';
import { renderImageDownload } from '../../tools/tool_uca_maps/server/image_download.ts';
import { OVERLAY_EXTENSIONS } from '../../tools/tool_uca_maps/server/image_media.ts';
import {
	GEOREFERENCED_EXTENSIONS,
	readGeoreference,
} from '../../tools/tool_uca_maps/server/image_overlay.ts';
import { parseStrictGeoJson } from '../../tools/tool_uca_maps/server/vector_upload.ts';
import { mustGet } from '../helpers/assert.ts';
import {
	contextOf,
	expectCode,
	failureOf,
	haveGdal,
	loadAction,
	stagedJson,
	stageFile,
	stagingOf,
	thrownBy,
} from './fixtures/tool_uca_maps/helpers.ts';

const HAVE_GDAL = haveGdal(
	'ogr2ogr',
	'ogrinfo',
	'gdalinfo',
	'gdal_translate',
	'gdalwarp',
	'gdal_create',
);

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
			const error = thrownBy(() => assertOfflineGeoJsonCrs({ type: 'FeatureCollection', crs }));
			expectCode(error, 'request.invalid_options');
			expect((error as DedaloError).details).toEqual({ reason_key: 'geojson_crs_link' });
		}
	});

	test('every crs GDAL reads is checked: on a geometry, in a collection, in any case; attribute values are not', () => {
		for (const [shape, geojson] of Object.entries(LINKED_CRS_SHAPES)) {
			const error = thrownBy(() => assertOfflineGeoJsonCrs(geojson));
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
		expect(parseStrictGeoJson(`\uFEFF{"type":"FeatureCollection",${POINT_FEATURES}}`)).toEqual(
			JSON.parse(`{"type":"FeatureCollection",${POINT_FEATURES}}`),
		);
		for (const [text, pattern] of [
			[`{"type":"FeatureCollection",${POINT_FEATURES},}`, /not strict JSON/],
			[
				`{"type":"FeatureCollection","crs":{"type":"link","properties":{"href":"http://127.0.0.1/"}},${POINT_FEATURES}}`,
				/crs is a link/,
			],
		] as const) {
			const error = thrownBy(() => parseStrictGeoJson(text));
			expectCode(error, 'request.invalid_options');
			expect((error as DedaloError).message).toMatch(pattern);
		}
	});
});

describe('tool_uca_maps runToolBinary — the spawn discipline (no GDAL needed)', () => {
	test('a GDAL file reader without -if is refused before any spawn', async () => {
		for (const name of ['ogr2ogr', 'ogrinfo', 'gdalinfo', 'gdal_translate', 'gdalwarp']) {
			// a path that does not exist: a spawn would fail ENOENT, not with this code
			const error = await failureOf(
				runToolBinary([`/nonexistent/${name}`, '-json', 'in.tif'], `probe ${name}`, {
					scratchDir: '/nonexistent/scratch',
				}),
			);
			expectCode(error, 'internal.invariant');
			expect((error as DedaloError).message).toMatch(/driver named \(-if\)/);
		}
	});

	test('every spawn runs offline, reads JPEG as RGB, with its scratch as temp dir, which a caller env cannot override', async () => {
		const env = mustGet(Bun.which('env'), 'env binary');
		const result = await runToolBinary([env], 'probe env', {
			scratchDir: '/scratch/probe',
			env: {
				GDAL_HTTP_PROXY: 'http://127.0.0.1:1',
				NO_PROXY: '*',
				PROJ_NETWORK: 'ON',
				GDAL_JPEG_TO_RGB: 'NO',
				CPL_TMPDIR: '/tmp',
				TMPDIR: '/tmp',
			},
		});
		const lines = new Set(result.stdout.split('\n'));
		const expected = {
			...OFFLINE_ENV,
			...GDAL_READ_ENV,
			CPL_TMPDIR: '/scratch/probe',
			TMPDIR: '/scratch/probe',
		};
		for (const [key, value] of Object.entries(expected)) {
			expect([key, lines.has(`${key}=${value}`)]).toEqual([key, true]);
		}
	});

	test('"GDAL is missing" is the not-installed refusal for that binary, never only its code', async () => {
		const missing = 'uca_maps_no_such_binary' as Parameters<typeof resolveGdalBinary>[0];
		const notInstalled = await failureOf(resolveGdalBinary(missing));
		expect(isMissingGdalBinary(notInstalled, missing)).toBe(true);
		expect(isMissingGdalBinary(notInstalled, 'gdalinfo')).toBe(false);

		const noMediaRoot = thrownBy(() => scratchRoot(null));
		expectCode(noMediaRoot, 'tool.dependency_unavailable');
		expect(isMissingGdalBinary(noMediaRoot, 'gdalinfo')).toBe(false);

		const otherCode = new DedaloError('tool.action_failed', {
			coordinates: { binary: 'gdalinfo' },
		});
		expect(isMissingGdalBinary(otherCode, 'gdalinfo')).toBe(false);
	});

	test.each([
		['GDAL 3.2.0, released 2020/11/02', true],
		['GDAL 3.13.2 "Iowa City", released 2026/07/20', true],
		['GDAL 4.0.0, released 2030/01/01', true],
		['GDAL 3.1.4, released 2020/10/20', false],
		['GDAL 2.10.0, released 2019/01/01', false],
		['gdalinfo: unknown option', false],
		['', false],
		[null, false],
	])('the GDAL version floor (-if exists from 3.2): %p meets it: %p', (banner, meets) => {
		expect(meetsGdalMinVersion(banner)).toBe(meets);
	});

	// a fake binary that answers `--version` as GDAL 3.1 would: it runs, but -if
	// fails. Named by its absolute path: Bun.which never sees a PATH set at runtime
	test('a GDAL below the floor is the not-installed refusal for that binary, never a spawn that fails', async () => {
		const bin = mkdtempSync(join(tmpdir(), 'uca_maps_old_gdal_'));
		const name = join(bin, 'gdalinfo') as Parameters<typeof resolveGdalBinary>[0];
		try {
			writeFileSync(name, "#!/bin/sh\necho 'GDAL 3.1.4, released 2020/10/20'\n");
			chmodSync(name, 0o755);
			const error = await failureOf(resolveGdalBinary(name));
			expectCode(error, 'tool.dependency_unavailable');
			expect(isMissingGdalBinary(error, name)).toBe(true);
			expect((error as DedaloError).message).toMatch(/GDAL 3\.2 or later is required/);
		} finally {
			rmSync(bin, { recursive: true, force: true });
		}
	});

	test('a raster driver comes from the extension; an unknown one, VRT included, is refused', () => {
		expect(rasterDriverOf('/x/a.TIF')).toBe('GTiff');
		expect(rasterDriverOf('/x/a.jpeg')).toBe('JPEG');
		expect(rasterDriverOf('/x/a.png')).toBe('PNG');
		expect(() => rasterDriverOf('/x/a.xml')).toThrow(/no raster driver/);
		expect(() => rasterDriverOf('/x/a.vrt')).toThrow(/no raster driver/);
	});

	// an extension the image actions accept but GDAL has no driver for is a 500
	test('every extension an overlay is drawn or georeferenced from has its raster driver', () => {
		const extensions = [...OVERLAY_EXTENSIONS, ...GEOREFERENCED_EXTENSIONS];
		expect(extensions.length).toBeGreaterThan(0);
		const driverless = extensions.filter((extension) => {
			try {
				rasterDriverOf(`/x/a.${extension}`);
				return false;
			} catch {
				return true;
			}
		});
		expect(driverless).toEqual([]);
	});
});

// refused before any binary runs, so these hold where GDAL is not installed (CI)
describe('tool_uca_maps handlers refuse a linked crs and lenient JSON before GDAL (no GDAL needed)', () => {
	const UPLOADER = 987685;
	const staging = stagingOf(UPLOADER);
	afterEach(() => rmSync(staging, { recursive: true, force: true }));

	test("vector_download refuses the client's linked crs, wherever it sits", async () => {
		const action = await loadAction('vector_download');
		for (const geojson of Object.values(LINKED_CRS_SHAPES)) {
			const file_data = stagedJson(OBJECT_GEOJSON_KEY_DIR, geojson, UPLOADER);
			const error = await failureOf(
				action.handler(contextOf({ format: 'kml', file_data }, UPLOADER)),
			);
			expectCode(error, 'request.invalid_options');
		}
	});

	test('upload_vector_layer refuses a linked crs, lenient JSON and a VRT posing as GeoJSON', async () => {
		const action = await loadAction('upload_vector_layer');
		const staged: Record<string, string> = {
			'lenient.geojson': `{"type":"FeatureCollection",${POINT_FEATURES},}`,
			'vrt.geojson':
				'<OGRVRTDataSource><OGRVRTLayer name="x"><SrcDataSource>CSV:/etc/passwd</SrcDataSource></OGRVRTLayer></OGRVRTDataSource>',
		};
		for (const [shape, geojson] of Object.entries(LINKED_CRS_SHAPES)) {
			staged[`${shape}.geojson`] = JSON.stringify(geojson);
		}
		for (const [name, text] of Object.entries(staged)) {
			stageFile(UPLOADER, name, text, VECTOR_UPLOAD_KEY_DIR);
			const error = await failureOf(
				action.handler(
					contextOf(
						{ file_data: { key_dir: VECTOR_UPLOAD_KEY_DIR, tmp_name: name, extension: 'geojson' } },
						UPLOADER,
					),
				),
			);
			expectCode(error, 'request.invalid_options');
		}
	});
});

const vectorVrt = (source: string) =>
	`<OGRVRTDataSource><OGRVRTLayer name="canary"><SrcDataSource>${source}</SrcDataSource></OGRVRTLayer></OGRVRTDataSource>`;

/** A loopback listener that counts the connections made to it, closing each. */
function countingListener(): { base: string; count(): number; reset(): void; stop(): void } {
	let connections = 0;
	const listener = Bun.listen({
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
	return {
		base: `127.0.0.1:${listener.port}`,
		count: () => connections,
		reset: () => {
			connections = 0;
		},
		stop: () => listener.stop(true),
	};
}

/** The connections ogr2ogr makes, run by `run`, on a linked crs (http and https)
 * and a `/vsicurl/` source pointing at a listener that counts them. Whatever
 * GDAL then does is not inspected: only whether it reached the network. */
async function linkConnections(
	run: (argv: string[], dir: string) => Promise<unknown>,
): Promise<number> {
	const listener = countingListener();
	const base = listener.base;
	const linkCrs = (scheme: string, type: string, key: string) =>
		`{"type":"FeatureCollection","crs":{"type":"${type}","properties":{"${key}":"${scheme}://${base}/crs"}},${POINT_FEATURES}}`;
	try {
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
				const out = resolve(dir, `${name}.out`);
				await run([ogr2ogr, ...inputDrivers(driver), '-f', 'GeoJSON', out, input], dir).catch(
					() => null,
				);
			}
		});
	} finally {
		listener.stop();
	}
	return listener.count();
}

const NO_PROXY_ENV = Object.fromEntries(
	['GDAL_HTTP_PROXY', 'GDAL_HTTPS_PROXY', 'http_proxy', 'https_proxy', 'HTTP_PROXY', 'HTTPS_PROXY']
		.concat(['ALL_PROXY', 'all_proxy'])
		.map((key) => [key, '']),
);

// the control: the same inputs without the offline env must reach the listener,
// or "zero connections" below would measure a GDAL that never follows a link
const GDAL_FOLLOWS_LINKS =
	HAVE_GDAL &&
	(await linkConnections((argv, dir) =>
		runBinary(argv, {
			timeoutMs: 60_000,
			nice: false,
			env: { ...NO_PROXY_ENV, CPL_TMPDIR: dir, TMPDIR: dir },
		}),
	)) > 0;

test.skipIf(!GDAL_FOLLOWS_LINKS)(
	'the offline env alone stops a linked crs and a /vsicurl/ source, http and https (needs a GDAL that follows links)',
	async () => {
		const connections = await linkConnections((argv, dir) =>
			runToolBinary(argv, 'probe offline', { scratchDir: dir }),
		);
		expect(connections).toBe(0);
	},
);

describe.skipIf(!HAVE_GDAL)(
	'tool_uca_maps GDAL — zero connections, real binaries (needs GDAL)',
	() => {
		let listener: ReturnType<typeof countingListener>;
		let base = '';

		beforeAll(() => {
			listener = countingListener();
			base = listener.base;
		});

		afterAll(() => {
			listener.stop();
		});

		beforeEach(() => {
			listener.reset();
		});

		const UPLOADER = 987686;
		const staging = stagingOf(UPLOADER);
		afterEach(() => rmSync(staging, { recursive: true, force: true }));

		// georeferenced, so a VRT GDAL opened would visibly succeed: a download
		// with content, an overlay with corners — the refusal is the driver's
		const rasterVrt = (source: string) =>
			`<VRTDataset rasterXSize="2" rasterYSize="2"><SRS>EPSG:4326</SRS><GeoTransform>-1,0.5,0,40,0,-0.5</GeoTransform><VRTRasterBand dataType="Byte" band="1"><SimpleSource><SourceFilename relativeToVRT="0">${source}</SourceFilename><SourceBand>1</SourceBand></SimpleSource></VRTRasterBand></VRTDataset>`;

		test('upload_vector_layer never opens a VRT posing as KML, local or remote', async () => {
			const action = await loadAction('upload_vector_layer');
			await withScratchDir(async (dir) => {
				// two lines: GDAL's CSV driver would hand the second back as a feature
				const canary = resolve(dir, 'canary.csv');
				writeFileSync(canary, 'secret\nUCA_MAPS_CANARY\n');
				const staged: [string, string][] = [
					['local.kml', vectorVrt(`CSV:${canary}`)],
					['remote.kml', vectorVrt(`/vsicurl/http://${base}/v.csv`)],
				];
				for (const [name, text] of staged) {
					stageFile(UPLOADER, name, text, VECTOR_UPLOAD_KEY_DIR);
					const error = await failureOf(
						action.handler(
							contextOf(
								{
									file_data: {
										key_dir: VECTOR_UPLOAD_KEY_DIR,
										tmp_name: name,
										extension: name.split('.').pop(),
									},
								},
								UPLOADER,
							),
						),
					);
					expectCode(error, 'tool.action_failed');
					expect(String((error as Error).message)).not.toContain('UCA_MAPS_CANARY');
				}
			});
			expect(listener.count()).toBe(0);
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
					stageFile(UPLOADER, 'capture.png', vrt, MAP_IMAGE_KEY_DIR);
					expectCode(
						await failureOf(
							rasterDownload.handler(
								contextOf(
									{
										format: 'geotiff',
										file_data: { key_dir: MAP_IMAGE_KEY_DIR, tmp_name: 'capture.png' },
										bounds: { west: -1, south: 39, east: 0, north: 40 },
									},
									UPLOADER,
								),
							),
						),
						'tool.action_failed',
					);

					const tif = resolve(dir, 'overlay.tif');
					writeFileSync(tif, vrt);
					expectCode(await failureOf(readGeoreference(tif)), 'tool.action_failed');

					const png = resolve(dir, 'drawn.png');
					writeFileSync(png, vrt);
					expectCode(
						await failureOf(renderImageDownload(dir, png, corners, 'png', 1)),
						'tool.action_failed',
					);
				}
			});
			expect(listener.count()).toBe(0);
		});
	},
);
