/**
 * tool_uca_maps — the core's map-source and legend rules the panels check before saving
 * (`tools/tool_uca_maps/js/core_limits.js`) equal the core's own. A value the server refuses
 * blocks the whole geolocation save, drawings included, so a drifted mirror is a silent
 * data-loss path, not a cosmetic one.
 */

import { describe, expect, test } from 'bun:test';
import { LEGEND_LIMITS } from '../../src/core/geo/map_legend.ts';
import {
	MAP_SOURCE_LIMITS,
	WMS_CRS,
	WMS_FORMATS,
	WMS_VERSIONS,
} from '../../src/core/geo/map_source.ts';
import { XYZ_PLACEHOLDERS } from '../../src/core/geo/map_source_url.ts';

/** The browser module, loaded as data: it imports nothing and touches no DOM. */
const MIRROR_PATH = new URL('../../tools/tool_uca_maps/js/core_limits.js', import.meta.url).href;
// biome-ignore lint/suspicious/noExplicitAny: a plain browser module without declarations
const mirror: Record<string, any> = await import(MIRROR_PATH);

const sorted = (list: readonly string[]): string[] => [...list].sort();

describe('tool_uca_maps core limits mirror', () => {
	test('map source rules', () => {
		expect(mirror.WMS_VERSIONS).toEqual([...WMS_VERSIONS]);
		expect(sorted(mirror.WMS_CRS)).toEqual(sorted(WMS_CRS));
		expect(WMS_FORMATS as readonly string[]).toContain(mirror.WMS_SAVED_FORMAT);
		expect(mirror.XYZ_PLACEHOLDERS).toEqual([...XYZ_PLACEHOLDERS]);
		expect(mirror.MAX_ATTRIBUTION_LENGTH).toBe(MAP_SOURCE_LIMITS.maxAttribution);
		expect(mirror.MAX_SOURCE_ZOOM).toBe(MAP_SOURCE_LIMITS.maxZoom);
	});

	test('legend rules', () => {
		expect(mirror.LEGEND_LIMITS).toEqual({ ...LEGEND_LIMITS });
	});

	test('legend icon formats: the ones the core reads an icon URI as', async () => {
		const source = await Bun.file(
			new URL('../../src/core/geo/map_legend.ts', import.meta.url),
		).text();
		const match = /const ICON_URI = \/\^data:image\\\/\(([a-z|]+)\);base64,/.exec(source);
		expect(match).not.toBeNull();
		expect(sorted(mirror.ICON_RASTER_FORMATS)).toEqual(sorted((match?.[1] ?? '').split('|')));
	});
});
