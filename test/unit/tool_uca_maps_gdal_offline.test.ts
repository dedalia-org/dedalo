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

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { Glob, type TCPSocketListener } from 'bun';
import { config } from '../../src/config/config.ts';
import { DedaloError } from '../../src/core/errors/index.ts';
import { runBinary } from '../../src/core/media/engine/spawn.ts';
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
	SCRATCH_ORPHAN_TTL_MS,
	scratchRoot,
	startScratchSweep,
	withScratchDir,
} from '../../tools/tool_uca_maps/server/gdal.ts';
import { renderImageDownload } from '../../tools/tool_uca_maps/server/image_download.ts';
import { OVERLAY_EXTENSIONS } from '../../tools/tool_uca_maps/server/image_media.ts';
import {
	GEOREFERENCED_EXTENSIONS,
	readGeoreference,
} from '../../tools/tool_uca_maps/server/image_overlay.ts';
import { tool } from '../../tools/tool_uca_maps/server/index.ts';
import { parseStrictGeoJson } from '../../tools/tool_uca_maps/server/vector_upload.ts';
import { mustGet } from '../helpers/assert.ts';
import { scratchMediaRoot } from '../helpers/media_scratch_root.ts';
import {
	contextOf,
	expectCode,
	failureOf,
	haveGdal,
	loadAction,
} from './fixtures/tool_uca_maps/helpers.ts';

const HAVE_GDAL = haveGdal(
	'ogr2ogr',
	'ogrinfo',
	'gdalinfo',
	'gdal_translate',
	'gdalwarp',
	'gdal_create',
);

/** The staging dir of a scratch uploader: the user ids are this file's own. */
const stagingOf = (userId: number) =>
	resolve(config.media.rootPath ?? '', config.media.upload.tmpSubdir, String(userId));

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

		let noMediaRoot: unknown = null;
		try {
			scratchRoot(null);
		} catch (caught) {
			noMediaRoot = caught;
		}
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

/** Server files that may spawn outside `runToolBinary`, each with its reason. */
const SPAWN_EXEMPT: Readonly<Record<string, string>> = {
	'capabilities.ts': '--version only, no input file: probeOnPath bounds it itself',
};

// A binding census (after agent_confinement_tripwire's), one hop deep: what a
// file reaches of `bun`, child_process or core's media engine, however bound.
// Every engine export counts as a spawn unless ENGINE_INERT names it, so a core
// wrapper that spawns (`runIdentify`) is red by default. The spelling census
// stays as a backstop: a re-export or a `globalThis.Bun` still spells it.
const PROCESS_MODULES = new Set(['bun', 'node:child_process', 'child_process']);
const ENGINE_DIR = resolve(import.meta.dir, '../../src/core/media/engine');
/** Engine exports that start no process, by module. Closed: a new import is a spawn until listed. */
const ENGINE_INERT: Readonly<Record<string, readonly string[]>> = {
	'admission.ts': ['withConverterSlot'],
	'binaries.ts': [
		'identifyAvailable',
		'magickPolicyEnv',
		'magickResourceLimitArgs',
		'resolveIdentify',
		'resolveMagick',
	],
	'spawn.ts': ['assertSpawnOk'],
};
const SERVER = resolve(import.meta.dir, '../../tools/tool_uca_maps/server');
/** `Bun.<member>` reads (or named imports from 'bun') that cannot start a process. Closed. */
const BUN_INERT = new Set(['file', 'write', 'which', 'Glob']);
const PROCESS_REF = '__UCA_PROCESS_REF__';
const BUN_GLOBAL = '__UCA_BUN_GLOBAL__';
const IMPORT_LINE = /^import\s+([^;"'`]+?)\s+from\s*["']([^"']+)["'];?[ \t]*$/gm;
const EXPORT_FROM_LINE = /^export\s+([^;"'`]+?)\s+from\s*["']([^"']+)["'];?[ \t]*$/gm;
const SPELLED_SPAWN =
	/\brunBinary\b|\bBun\.spawn(Sync)?\b|\bBun\.\$|['"](node:)?child_process['"]|import\s*\{[^}]*(\bspawn(Sync)?\b|\$)[^}]*\}\s*from\s*['"]bun['"]/;
const TS = new Bun.Transpiler({ loader: 'ts' });

/** The locals an import clause binds, with what each imports (`*`, `default` or a name). */
function importBindings(clause: string): { imported: string; local: string }[] {
	const out: { imported: string; local: string }[] = [];
	const namespace = clause.match(/\*\s*as\s+([\w$]+)/);
	if (namespace?.[1]) out.push({ imported: '*', local: namespace[1] });
	for (const part of (clause.match(/\{([^}]*)\}/)?.[1] ?? '').split(',')) {
		const [imported, local] = part.trim().split(/\s+as\s+/);
		if (imported) out.push({ imported, local: local ?? imported });
	}
	const fallback = clause
		.replace(/\{[^}]*\}/, '')
		.replace(/\*\s*as\s+[\w$]+/, '')
		.replace(/,/g, ' ')
		.trim();
	if (fallback) out.push({ imported: 'default', local: fallback });
	return out;
}

/** The engine module `specifier` resolves to from a server file (relative to ENGINE_DIR), or null. */
function engineModule(specifier: string): string | null {
	try {
		const resolved = Bun.resolveSync(specifier, SERVER);
		return resolved.startsWith(ENGINE_DIR + sep) ? resolved.slice(ENGINE_DIR.length + 1) : null;
	} catch {
		return null;
	}
}
const isDoor = (specifier: string) => engineModule(specifier) !== null;

/** Process-capable references in one server source, or the dynamic loads no scan resolves. */
function processRefs(code: string): { refs: number; unresolvable: string[]; spelled: boolean } {
	const transpiled = TS.transformSync(code);
	const unresolvable = TS.scanImports(transpiled)
		.filter((entry) => entry.kind !== 'import-statement')
		.filter((entry) => PROCESS_MODULES.has(entry.path) || isDoor(entry.path))
		.map((entry) => `${entry.kind} ${entry.path}`);
	for (const [, , from] of transpiled.matchAll(EXPORT_FROM_LINE)) {
		if (from !== undefined && (PROCESS_MODULES.has(from) || isDoor(from))) {
			unresolvable.push(`re-export ${from}`);
		}
	}
	const bindings: string[] = [];
	const js = transpiled.replace(IMPORT_LINE, (line, clause: string, from: string) => {
		const engine = engineModule(from);
		if (engine === null && !PROCESS_MODULES.has(from)) return line;
		for (const { imported, local } of importBindings(clause)) {
			const counted =
				engine !== null
					? !(ENGINE_INERT[engine] ?? []).includes(imported)
					: !(from === 'bun' && BUN_INERT.has(imported));
			if (counted) bindings.push(local);
		}
		return '';
	});
	const define: Record<string, string> = { Bun: BUN_GLOBAL };
	for (const name of bindings) define[name] = PROCESS_REF;
	const out = new Bun.Transpiler({ loader: 'js', define }).transformSync(js);
	let refs = out.split(PROCESS_REF).length - 1;
	for (const match of out.matchAll(
		new RegExp(`${BUN_GLOBAL}(\\s*\\.\\s*([A-Za-z_$][\\w$]*))?`, 'g'),
	)) {
		if (!(match[2] && BUN_INERT.has(match[2]))) refs++;
	}
	return { refs, unresolvable, spelled: SPELLED_SPAWN.test(transpiled) };
}

const reaches = (reach: ReturnType<typeof processRefs>) =>
	reach.refs > 0 || reach.unresolvable.length > 0 || reach.spelled;

describe('tool_uca_maps spawn census — every binary runs through runToolBinary', () => {
	const DOOR = "import { runBinary } from '../../../src/core/media/engine/spawn.ts';\n";

	test.each([
		['the door', `${DOOR}export const go = () => runBinary(['/bin/true'], {});`],
		[
			'the door aliased',
			`${DOOR.replace('runBinary', 'runBinary as run')}export const go = () => run([]);`,
		],
		[
			'the door as a namespace',
			"import * as door from '../../../src/core/media/engine/spawn.ts';\nexport const go = () => door.runBinary([]);",
		],
		[
			'the door without its extension',
			"import { runBinary } from '../../../src/core/media/engine/spawn';\nexport const go = () => runBinary([]);",
		],
		['Bun.spawn', "export const go = () => Bun.spawn(['gdalinfo']);"],
		['Bun.$', 'export const go = () => Bun.$`gdalinfo`;'],
		['an alias of Bun', "const B = Bun;\nexport const go = () => B.spawn(['gdalinfo']);"],
		[
			'a destructure of Bun',
			"const { spawnSync } = Bun;\nexport const go = () => spawnSync(['x']);",
		],
		[
			'a named import from bun',
			"import { spawn as s } from 'bun';\nexport const go = () => s(['x']);",
		],
		[
			'a namespace import of bun',
			"import * as B from 'bun';\nexport const go = () => B.spawn(['x']);",
		],
		[
			'node child_process',
			"import { execFile } from 'node:child_process';\nexport const go = () => execFile('x');",
		],
		[
			'a re-export of the door',
			"export { runBinary as go } from '../../../src/core/media/engine/spawn.ts';",
		],
		['a re-export of child_process', "export * from 'node:child_process';"],
		[
			'an engine wrapper that spawns',
			"import { runIdentify } from '../../../src/core/media/engine/binaries.ts';\nexport const go = () => runIdentify([]);",
		],
		[
			'an engine module as a namespace',
			"import * as bin from '../../../src/core/media/engine/binaries.ts';\nexport const go = () => bin.resolveMagick();",
		],
		[
			'an unlisted engine export',
			"import { producerSpawnOptions } from '../../../src/core/media/engine/ffmpeg.ts';\nexport const go = () => producerSpawnOptions();",
		],
		['Bun through globalThis', "export const go = () => globalThis.Bun.spawn(['x']);"],
		[
			'child_process through import.meta',
			"export const go = () => import.meta.require('child_process').spawn('x');",
		],
	])('the census sees %s', (_, code) => {
		expect(reaches(processRefs(code))).toBe(true);
	});

	test('a dynamic import or require of a process module is unresolvable, never counted as none', () => {
		for (const code of [
			"export const go = async () => (await import('node:child_process')).spawn('x');",
			"export const go = () => require('child_process').spawn('x');",
			"export const go = async () => (await import('../../../src/core/media/engine/spawn')).runBinary([]);",
		]) {
			expect(processRefs(code).unresolvable.length).toBeGreaterThan(0);
		}
	});

	test.each([
		['a comment', '// Bun.spawn would bypass the offline env\nexport const n = 0;'],
		['an inert Bun read', "export const f = () => Bun.file('/x');"],
		['an inert import from bun', "import { Glob } from 'bun';\nexport const g = new Glob('*');"],
		[
			'a type-only door import',
			"import type { SpawnResult } from '../../../src/core/media/engine/spawn.ts';\nexport let r: SpawnResult;",
		],
		[
			'another door export',
			"import { assertSpawnOk } from '../../../src/core/media/engine/spawn.ts';\nexport const f = assertSpawnOk;",
		],
		[
			'the inert engine exports',
			"import { identifyAvailable, resolveMagick } from '../../../src/core/media/engine/binaries.ts';\nimport { withConverterSlot } from '../../../src/core/media/engine/admission.ts';\nexport const f = () => withConverterSlot('x', async () => identifyAvailable() && resolveMagick());",
		],
	])('the census ignores %s', (_, code) => {
		expect(reaches(processRefs(code))).toBe(false);
	});

	test('every inert engine name is still a function its module exports', async () => {
		for (const [file, names] of Object.entries(ENGINE_INERT)) {
			const module = (await import(join(ENGINE_DIR, file))) as Record<string, unknown>;
			for (const name of names) {
				expect([file, name, typeof module[name]]).toEqual([file, name, 'function']);
			}
		}
	});

	test('only gdal.ts spawns, once, inside runToolBinary; the exemptions still spawn', () => {
		const files = [...new Glob('**/*.ts').scanSync({ cwd: SERVER })];
		expect(files.length).toBeGreaterThanOrEqual(15);
		const census = Object.fromEntries(
			files
				.map((file) => [file, processRefs(readFileSync(join(SERVER, file), 'utf-8'))] as const)
				.filter(([, reach]) => reaches(reach)),
		);
		const expected = Object.fromEntries(
			['gdal.ts', ...Object.keys(SPAWN_EXEMPT)].map((file) => [
				file,
				{ refs: 1, unresolvable: [], spelled: true },
			]),
		);
		expect(census).toEqual(expected);
		// and gdal.ts's one reference is runToolBinary's own call
		const gdal = readFileSync(join(SERVER, 'gdal.ts'), 'utf-8');
		const from = gdal.slice(gdal.indexOf('export async function runToolBinary('));
		expect(from.slice(0, from.indexOf('\n}\n'))).toContain('await runBinary(argv,');
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

	// an orphan exists only once a process died mid-action: the boot after it
	// collects it, and no action's request path walks the scratch tree
	test('the boot hook sweeps an orphan a killed process left; a live one, a foreign entry and every action leave them', async () => {
		const root = scratchRoot();
		const old = join(root, 'scratch_orphan_gate');
		const live = join(root, 'scratch_live_gate');
		const foreign = join(root, 'not_scratch_gate');
		const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
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
			expect(existsSync(old)).toBe(true);

			// stopped before it fires (a shutdown during boot): nothing is swept
			mustGet(tool.onBoot, 'tool.onBoot')()?.stop();
			await settle();
			expect(existsSync(old)).toBe(true);

			const handle = mustGet(tool.onBoot, 'tool.onBoot')();
			await settle();
			handle?.stop();
			expect(existsSync(old)).toBe(false);
			expect(existsSync(live)).toBe(true);
			expect(existsSync(foreign)).toBe(true);
		} finally {
			for (const dir of [old, live, foreign]) rmSync(dir, { recursive: true, force: true });
		}
	});

	// a crash shortly before the boot leaves an orphan younger than the TTL: the
	// boot pass spares it, a later pass collects it
	test('the sweep repeats after boot, so an orphan younger than the TTL at boot is collected later; stop ends it', async () => {
		const root = scratchRoot();
		const late = join(root, 'scratch_late_gate');
		const after_stop = join(root, 'scratch_after_stop_gate');
		const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
		const age = (dir: string) => {
			mkdirSync(dir, { recursive: true });
			const stale = (Date.now() - SCRATCH_ORPHAN_TTL_MS - 60_000) / 1000;
			utimesSync(dir, stale, stale);
		};
		const handle = startScratchSweep(undefined, 40);
		try {
			await settle(10);
			age(late); // becomes an orphan after the boot pass
			await settle(120);
			expect(existsSync(late)).toBe(false);

			handle.stop();
			age(after_stop);
			await settle(120);
			expect(existsSync(after_stop)).toBe(true);
		} finally {
			handle.stop();
			for (const dir of [late, after_stop]) rmSync(dir, { recursive: true, force: true });
		}
	});

	// the sweep runs in a timer, past the loader's guard: a bad media root must
	// only warn, never throw where nothing catches it
	test('a sweep that cannot reach the media root warns and writes nothing', async () => {
		const unmarked = mkdtempSync(join(tmpdir(), 'uca_maps_unmarked_sweep_'));
		const warned: unknown[] = [];
		const warn = console.warn;
		console.warn = (...args: unknown[]) => warned.push(args[0]);
		try {
			for (const configured of [null, unmarked]) {
				const handle = startScratchSweep(configured, 60_000);
				await new Promise((resolve) => setTimeout(resolve, 20));
				handle.stop();
			}
			expect(warned).toEqual([
				'[tool_uca_maps] scratch sweep skipped:',
				'[tool_uca_maps] scratch sweep skipped:',
			]);
			expect(readdirSync(unmarked)).toEqual([]);
		} finally {
			console.warn = warn;
			rmSync(unmarked, { recursive: true, force: true });
		}
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
			const error = await failureOf(action.handler(contextOf({ format: 'kml', geojson })));
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
		mkdirSync(staging, { recursive: true });
		for (const [name, text] of Object.entries(staged)) {
			writeFileSync(resolve(staging, name), text);
			const error = await failureOf(
				action.handler(
					contextOf({ file_data: { key_dir: '', tmp_name: name, extension: 'geojson' } }, UPLOADER),
				),
			);
			expectCode(error, 'request.invalid_options');
		}
	});
});

const vectorVrt = (source: string) =>
	`<OGRVRTDataSource><OGRVRTLayer name="canary"><SrcDataSource>${source}</SrcDataSource></OGRVRTLayer></OGRVRTDataSource>`;

/** The connections ogr2ogr makes, run by `run`, on a linked crs (http and https)
 * and a `/vsicurl/` source pointing at a listener that counts them. Whatever
 * GDAL then does is not inspected: only whether it reached the network. */
async function linkConnections(
	run: (argv: string[], dir: string) => Promise<unknown>,
): Promise<number> {
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
	const base = `127.0.0.1:${listener.port}`;
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
		listener.stop(true);
	}
	return connections;
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
				mkdirSync(staging, { recursive: true });
				for (const [name, text] of staged) {
					writeFileSync(resolve(staging, name), text);
					const error = await failureOf(
						action.handler(
							contextOf(
								{ file_data: { key_dir: '', tmp_name: name, extension: name.split('.').pop() } },
								UPLOADER,
							),
						),
					);
					expectCode(error, 'tool.action_failed');
					expect(String((error as Error).message)).not.toContain('UCA_MAPS_CANARY');
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
						await failureOf(
							rasterDownload.handler(
								contextOf({
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
					expectCode(await failureOf(readGeoreference(tif)), 'tool.action_failed');

					const png = resolve(dir, 'drawn.png');
					writeFileSync(png, vrt);
					expectCode(
						await failureOf(renderImageDownload(dir, png, corners, 'png', 1)),
						'tool.action_failed',
					);
				}
			});
			expect(connections).toBe(0);
		});
	},
);
