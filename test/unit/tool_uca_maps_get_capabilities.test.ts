/**
 * tool_uca_maps — `get_capabilities`: which binaries this install has, in a
 * shape the client reads the same whatever the machine running the suite has
 * installed. No DB write: it probes binaries and reads config only.
 */

import { describe, expect, spyOn, test } from 'bun:test';
import { identifyAvailable } from '../../src/core/media/engine/binaries.ts';
import type { ToolResponse } from '../../src/core/tools/module.ts';
import {
	gdalCapability,
	probeCapabilities,
	probeOnPath,
} from '../../tools/tool_uca_maps/server/capabilities.ts';
import * as externalImage from '../../tools/tool_uca_maps/server/external_image.ts';
import { contextOf, dataOf, loadAction } from './fixtures/tool_uca_maps/helpers.ts';

describe('tool_uca_maps get_capabilities — probeOnPath', () => {
	test('a binary not on $PATH is unavailable, with no path and no version', async () => {
		expect(await probeOnPath('uca_maps_no_such_binary', ['--version'])).toEqual({
			available: false,
			path: null,
			version: null,
		});
	});

	// a stale or broken binary must not read as available
	test('a binary that fails its version call is unavailable, though found', async () => {
		const probe = await probeOnPath('false', []);
		expect(probe.available).toBe(false);
		expect(probe.path).toBe(Bun.which('false'));
		expect(probe.version).toBeNull();
	});

	test("a working binary is available, its version the banner's first line", async () => {
		expect(await probeOnPath('echo', ['GDAL 3.13.2, released\nsecond line'])).toEqual({
			available: true,
			path: Bun.which('echo'),
			version: 'GDAL 3.13.2, released',
		});
		expect((await probeOnPath('true', [])).version).toBeNull();
	});
});

describe('tool_uca_maps get_capabilities — handler contract', () => {
	test('answers envelope v2 with every capability in the declared shape', async () => {
		const action = await loadAction('get_capabilities');
		const response: ToolResponse = await action.handler(contextOf());

		const data = dataOf(response);
		expect('result' in response).toBe(false); // forbidden PHP-era mirror key
		expect(Object.keys(data).sort()).toEqual([
			'externalImages',
			'gazetteers',
			'gdal',
			'gdalTranslate',
			'imagemagick',
			'ogr2ogr',
		]);

		// the default probe is this machine's own $PATH, through the floor
		for (const [key, name] of [
			['gdal', 'gdalinfo'],
			['ogr2ogr', 'ogr2ogr'],
			['gdalTranslate', 'gdal_translate'],
		] as const) {
			expect(data[key]).toEqual(gdalCapability(await probeOnPath(name, ['--version'])));
		}
		for (const key of ['gdal', 'ogr2ogr', 'gdalTranslate'] as const) {
			const binary = data[key] as { available: unknown; path: unknown; version: unknown };
			expect(Object.keys(binary).sort()).toEqual(['available', 'path', 'version']);
			expect(typeof binary.available).toBe('boolean');
			expect(binary.path === null || typeof binary.path === 'string').toBe(true);
			expect(binary.version === null || typeof binary.version === 'string').toBe(true);
		}

		const imagemagick = data.imagemagick as { available: unknown; path: unknown };
		expect(Object.keys(imagemagick).sort()).toEqual(['available', 'path']);
		expect(imagemagick.available).toBe(imagemagick.path !== null);
		// the predicate the conversions gate on (`resolveMagickBinary`)
		expect(imagemagick.available).toBe(identifyAvailable());

		// importing an object's linked images is on unless an install turns it
		// off, and the suite never does
		expect(data.externalImages).toBe(true);

		// the suite configures no gazetteer store, and the answer never names
		// an install's directory, only what it could serve
		expect(data.gazetteers).toEqual({ configured: false, pleiades: false, pelagios: [] });
	});

	test('reports what the injected linked-images reader answers', async () => {
		expect((await probeCapabilities({ externalImagesOn: async () => false })).externalImages).toBe(
			false,
		);
		expect((await probeCapabilities({ externalImagesOn: async () => true })).externalImages).toBe(
			true,
		);
	});

	test('the default linked-images reader is externalImagesEnabled', async () => {
		const reader = spyOn(externalImage, 'externalImagesEnabled').mockImplementation(
			async () => false,
		);
		try {
			expect((await probeCapabilities()).externalImages).toBe(false);
			expect(reader).toHaveBeenCalledTimes(1);
		} finally {
			reader.mockRestore();
		}
	});

	test('a reader that fails reads as off, and says so in the log: the probe never throws', async () => {
		const failing = async (): Promise<boolean> => {
			throw new Error('config read failed');
		};
		const lines: string[] = [];
		const spies = (['error', 'warn', 'info'] as const).map((level) =>
			spyOn(console, level).mockImplementation((line: unknown) => {
				lines.push(String(line));
			}),
		);
		try {
			expect((await probeCapabilities({ externalImagesOn: failing })).externalImages).toBe(false);
		} finally {
			for (const spy of spies) spy.mockRestore();
		}
		expect(lines.filter((line) => line.startsWith('[tool_uca_maps]'))).toHaveLength(1);
	});
});

describe('tool_uca_maps get_capabilities — the GDAL version floor', () => {
	const probe = (version: string | null, available = true) => ({
		available,
		path: '/usr/bin/gdalinfo',
		version,
	});

	test.each([
		['GDAL 3.6.2, released 2023/01/02', true],
		['GDAL 3.2.0, released 2020/11/02', true],
		['GDAL 3.0.4, released 2020/01/28', false],
		[null, false],
	] as const)('%s reads as available: %p', (banner, available) => {
		expect(gdalCapability(probe(banner)).available).toBe(available);
	});

	test('a binary that did not run stays unavailable whatever its banner', () => {
		expect(gdalCapability(probe('GDAL 3.6.2, released 2023/01/02', false)).available).toBe(false);
	});

	// the handler's own wiring: each of the three GDAL binaries goes through
	// the floor, not only the helper
	test.each([
		['GDAL 3.1.4, released 2020/10/20', false],
		['GDAL 3.6.2, released 2023/01/02', true],
	] as const)(
		'probeCapabilities reports %s as available: %p for all three',
		async (banner, available) => {
			const asked: string[] = [];
			const capabilities = await probeCapabilities({
				probe: async (name) => {
					asked.push(name);
					return probe(banner);
				},
				externalImagesOn: async () => true,
			});
			expect(asked.sort()).toEqual(['gdal_translate', 'gdalinfo', 'ogr2ogr']);
			for (const key of ['gdal', 'ogr2ogr', 'gdalTranslate'] as const) {
				expect(capabilities[key].available).toBe(available);
			}
		},
	);
});
