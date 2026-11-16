/**
 * tool_uca_maps — the core's map-source and legend rules the panels check before saving
 * (`tools/tool_uca_maps/js/core_limits.js`) equal the core's own. A value the server refuses
 * blocks the whole geolocation save, drawings included, so a drifted mirror is a silent
 * data-loss path, not a cosmetic one.
 */

import { describe, expect, test } from 'bun:test';
import { hasControlChars } from '../../src/core/geo/checked.ts';
import { checkIcon, LEGEND_LIMITS, validateMapLegend } from '../../src/core/geo/map_legend.ts';
import {
	MAP_SOURCE_LIMITS,
	WMS_CRS,
	WMS_FORMATS,
	WMS_VERSIONS,
} from '../../src/core/geo/map_source.ts';
import { XYZ_PLACEHOLDERS } from '../../src/core/geo/map_source_url.ts';
import { GEO_ORIGINS } from '../../src/core/geo_services/table.ts';

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

	test('text rules: control characters, over every code point', () => {
		for (let code = 0; code <= 0x10ffff; code++) {
			if (mirror.is_control_code(code) !== hasControlChars(String.fromCodePoint(code))) {
				throw new Error(`control character rule differs at U+${code.toString(16)}`);
			}
		}
	});

	// asked of core's validator, not read from its source: a title the mirror
	// lets through must be one core keeps, and the other way round
	test('text rules: what opens a tag is what core refuses in a legend text', () => {
		const titles: string[] = [];
		for (let code = 0x20; code <= 0x7e; code++) {
			const char = String.fromCharCode(code);
			titles.push(`<${char}`, `a <${char}b`, `${char}<`);
		}
		titles.push('<é', '<ß', '< a', 'a<', '<<', '');
		for (const title of titles) {
			const kept = validateMapLegend({ title, groups: [] }, 'legend').ok;
			expect([title, mirror.LEGEND_TAG_START.test(title)]).toEqual([title, !kept]);
		}
	});

	test('legend icon formats: the ones core reads an icon URI as', () => {
		const uri = (format: string) => `data:image/${format};base64,AAAA`;
		// an image type core never reads fails at the URI's shape; one it reads,
		// with these bytes, fails further on, at the bytes
		const unread = checkIcon(uri('x-unread'), 'icon');
		expect(unread.ok).toBe(false);
		const reads = (format: string) => {
			const checked = checkIcon(uri(format), 'icon');
			return checked.ok || checked.reason !== (unread as { reason: string }).reason;
		};
		const candidates = ['png', 'jpeg', 'jpg', 'webp', 'gif', 'svg+xml', 'bmp', 'avif', 'tiff'];
		expect(sorted(mirror.ICON_RASTER_FORMATS)).toEqual(sorted(candidates.filter(reads)));
	});

	test("Catastro's credit, when its entry gives none, is core's own", () => {
		expect(mirror.CATASTRO_CREDIT).toBe(GEO_ORIGINS.catastro.attribution);
	});
});
