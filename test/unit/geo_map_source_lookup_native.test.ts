/**
 * The two READ paths the tile proxy stands on, and the ontology defaults
 * (WC-2026-11-06-geolocation-map-sources-legend):
 *
 *  - `lookupStoredMapSource` — find a stored source by id in a component value
 *    and RE-VALIDATE it at fetch time (a stored template can predate a rule that
 *    has since tightened). Three outcomes: found / absent / invalid.
 *  - `properties.map_sources` — the ontology default list a node may carry,
 *    parsed with the same validator; a broken entry is REJECTED with its index and
 *    reason (never dropped quietly), ids are short names in a namespace of their
 *    own, and the picker is told what it needs to DRAW a layer — names, labels,
 *    types, the attribution, an xyz source's zoom bounds and a wms source's CRS —
 *    never a URL, a layer list or a token.
 *
 *  - the STRUCTURE CONTEXT — the emitted `properties` of a node reach every
 *    browser, read-only users included, so the ontology defaults leave it as the
 *    picker list and nothing else: no `url`, no `params` object, no token.
 *
 * The parse is pure. The one accessor that touches the ontology
 * (`readMapSourceDefaults`) is driven against a real node that carries no
 * `map_sources` key — this gate creates no ontology node.
 */

import { describe, expect, test } from 'bun:test';
import {
	findMapSourceDefault,
	MAP_SOURCE_DEFAULT_LIMITS,
	mapSourcePickerEntries,
	parseMapSourceDefaults,
	readMapSourceDefaults,
} from '../../src/core/geo/map_source_defaults.ts';
import { lookupStoredMapSource } from '../../src/core/geo/stored_source.ts';
import {
	resolveEmittedPropertiesAndCss,
	sanitizeEmittedProperties,
} from '../../src/core/resolve/structure_context.ts';

const XYZ = {
	type: 'xyz',
	url: 'https://tiles.example.org/{z}/{x}/{y}.png?key=tok_SECRET_lookup',
	params: { max_zoom: 18 },
	attribution: 'Example Org',
};

describe('lookupStoredMapSource', () => {
	const items = [
		{
			id: 1,
			lat: 1,
			lon: 2,
			sources: [
				{ id: 4, ...XYZ },
				{ id: 9, ...XYZ, attribution: 'second' },
			],
		},
	];

	test('found: the source, valid now, with its id', () => {
		const found = lookupStoredMapSource(items, 9);
		expect(found.status).toBe('found');
		if (found.status !== 'found') return;
		expect(found.source.id).toBe(9);
		expect(found.source.type).toBe('xyz');
		expect(found.source.attribution).toBe('second');
	});

	test('absent: unknown id, a non-id, no sources, no entries, not an array', () => {
		for (const id of [5, 0, -1, 1.5, '4', null, undefined, Number.NaN]) {
			expect(lookupStoredMapSource(items, id).status, String(id)).toBe('absent');
		}
		expect(lookupStoredMapSource([{ id: 1 }], 4).status).toBe('absent');
		expect(lookupStoredMapSource([], 4).status).toBe('absent');
		expect(lookupStoredMapSource(null, 4).status).toBe('absent');
		expect(lookupStoredMapSource({ sources: [{ id: 4, ...XYZ }] }, 4).status).toBe('absent');
	});

	test("invalid: a stored source that fails TODAY's rules is not served, and the reason is secret-free", () => {
		const legacy = [
			{
				id: 1,
				sources: [{ id: 4, ...XYZ, url: 'http://127.0.0.1/{z}/{x}/{y}?key=tok_SECRET_lookup' }],
			},
		];
		const result = lookupStoredMapSource(legacy, 4);
		expect(result.status).toBe('invalid');
		if (result.status !== 'invalid') return;
		expect(result.reason).toMatch(/private or loopback/);
		expect(result.reason).not.toContain('tok_SECRET_lookup');
	});

	test('it searches every entry of the value, and the id must match exactly', () => {
		const two = [
			{ id: 1, sources: [{ id: 4, ...XYZ }] },
			{ id: 2, sources: [{ id: 7, ...XYZ }] },
		];
		expect(lookupStoredMapSource(two, 7).status).toBe('found');
		expect(lookupStoredMapSource(two, 8).status).toBe('absent');
	});
});

describe('properties.map_sources', () => {
	const entry = (over: Record<string, unknown> = {}) => ({
		id: 'osm_standard',
		label: 'Standard base map',
		...XYZ,
		...over,
	});

	test('no key = no defaults and no rejection', () => {
		for (const properties of [null, undefined, {}, { geo_provider: 'OSM' }, 'x', []]) {
			expect(parseMapSourceDefaults(properties)).toEqual({ defaults: [], rejected: [] });
		}
	});

	test('valid entries parse; the label defaults to the id; the source carries no numeric id', () => {
		const parsed = parseMapSourceDefaults({
			map_sources: [entry(), entry({ id: 'plain', label: undefined })],
		});
		expect(parsed.rejected).toEqual([]);
		expect(parsed.defaults.map((d) => [d.id, d.label])).toEqual([
			['osm_standard', 'Standard base map'],
			['plain', 'plain'],
		]);
		expect(parsed.defaults[0]?.source.type).toBe('xyz');
		expect(parsed.defaults[0]?.source).not.toHaveProperty('id');
		expect(findMapSourceDefault(parsed, 'plain')?.id).toBe('plain');
		expect(findMapSourceDefault(parsed, 'nope')).toBeNull();
		expect(findMapSourceDefault(parsed, 4)).toBeNull();
	});

	test('a broken entry is REJECTED with index, id and reason; the others still parse', () => {
		const parsed = parseMapSourceDefaults({
			map_sources: [
				entry(),
				entry({ id: 'local', url: 'http://localhost/{z}/{x}/{y}.png' }),
				entry({ id: 'Bad Id' }),
				entry({ id: 'osm_standard' }),
				entry({ id: 'numeric_one', type: 'tms' }),
				'junk',
			],
		});
		expect(parsed.defaults.map((d) => d.id)).toEqual(['osm_standard']);
		expect(parsed.rejected.map((r) => r.index)).toEqual([1, 2, 3, 4, 5]);
		expect(parsed.rejected[0]).toMatchObject({ index: 1, id: 'local' });
		expect(parsed.rejected[0]?.reason).toMatch(/map_sources\[1\]\.url/);
		expect(parsed.rejected[1]?.reason).toMatch(/\.id: must be a name/);
		expect(parsed.rejected[2]?.reason).toMatch(/appears twice/);
		expect(JSON.stringify(parsed.rejected)).not.toContain('tok_SECRET_lookup');
	});

	test('the label is PLAIN TEXT like the attribution: markup is rejected, so it never reaches the picker', () => {
		// Leaflet's layer control writes the label as HTML. A hostile ontology update must not be
		// able to put a tag in it: the read-time check refuses it (the page escapes it once more).
		for (const bad of [
			'<img src=x onerror=alert(1)>',
			'Base <b>map</b>',
			'a > b',
			'two\nlines',
			'x'.repeat(MAP_SOURCE_DEFAULT_LIMITS.maxLabel + 1),
			42,
		]) {
			const parsed = parseMapSourceDefaults({ map_sources: [entry({ label: bad })] });
			expect(parsed.defaults, String(bad).slice(0, 24)).toEqual([]);
			expect(parsed.rejected[0]?.reason, String(bad).slice(0, 24)).toMatch(
				/map_sources\[0\]\.label/,
			);
		}
		// …and none of it can be offered: the picker is built from the validated entries alone
		const parsed = parseMapSourceDefaults({
			map_sources: [entry({ id: 'hostile', label: '<img src=x onerror=alert(1)>' }), entry()],
		});
		expect(JSON.stringify(mapSourcePickerEntries(parsed.defaults))).not.toContain('<img');
		// a plain label with an ampersand, an accent or a quote is fine
		const fine = parseMapSourceDefaults({
			map_sources: [entry({ label: 'Mapas & «vistas» "IGN"' })],
		});
		expect(fine.defaults[0]?.label).toBe('Mapas & «vistas» "IGN"');
	});

	test('a name is a short lowercase word: it cannot be a stored (numeric) source id', () => {
		for (const bad of [7, '7', 'Upper', '1abc', '', 'a'.repeat(49), 'has-dash', 'has space']) {
			const parsed = parseMapSourceDefaults({ map_sources: [entry({ id: bad })] });
			expect(parsed.defaults, String(bad)).toEqual([]);
		}
	});

	test('not an array, or too many entries: rejected, loudly', () => {
		expect(parseMapSourceDefaults({ map_sources: 'x' }).rejected).toHaveLength(1);
		const many = Array.from({ length: MAP_SOURCE_DEFAULT_LIMITS.maxDefaults + 3 }, (_, i) =>
			entry({ id: `s${i}` }),
		);
		const parsed = parseMapSourceDefaults({ map_sources: many });
		expect(parsed.defaults).toHaveLength(MAP_SOURCE_DEFAULT_LIMITS.maxDefaults);
		expect(parsed.rejected.at(-1)?.reason).toMatch(/more than/);
	});

	test('the picker is told what it needs to draw the layer — never a URL, a layer list or a token', () => {
		const parsed = parseMapSourceDefaults({
			map_sources: [
				entry(),
				entry({
					id: 'bounded',
					params: { min_zoom: 4, max_zoom: 12 },
					attribution: 'Bounded Org',
				}),
				{
					id: 'ign_wms',
					label: 'WMS',
					type: 'wms',
					url: 'https://wms.example.org/service?access=tok_SECRET_lookup',
					params: {
						version: '1.3.0',
						layers: 'private_layer_name',
						styles: '',
						format: 'image/png',
						transparent: true,
						crs: 'EPSG:4258',
					},
					attribution: 'WMS Org',
				},
			],
		});
		const listed = mapSourcePickerEntries(parsed.defaults);
		expect(listed).toEqual([
			{
				id: 'osm_standard',
				label: 'Standard base map',
				type: 'xyz',
				attribution: 'Example Org',
				max_zoom: 18,
			},
			{
				id: 'bounded',
				label: 'Standard base map',
				type: 'xyz',
				attribution: 'Bounded Org',
				min_zoom: 4,
				max_zoom: 12,
			},
			{ id: 'ign_wms', label: 'WMS', type: 'wms', attribution: 'WMS Org', crs: 'EPSG:4258' },
		]);
		const wire = JSON.stringify(listed);
		for (const secret of [
			'tiles.example.org',
			'wms.example.org',
			'tok_SECRET_lookup',
			'private_layer_name',
		]) {
			expect(wire, secret).not.toContain(secret);
		}
		expect(wire).not.toContain('"url"');
		expect(wire).not.toContain('"params"');
	});

	test('readMapSourceDefaults reads the ontology: a real node without the key has none', async () => {
		expect(await readMapSourceDefaults('test100')).toEqual({ defaults: [], rejected: [] });
		expect(await readMapSourceDefaults('test99999999')).toEqual({ defaults: [], rejected: [] });
	});
});

describe("the structure context never publishes an ontology default's address", () => {
	const TOKEN = 'TOKEN_SECRET_ctx';
	const ownProperties = () => ({
		geo_provider: 'OSM',
		map_sources: [
			{
				id: 'ign_base',
				label: 'IGN base',
				...XYZ,
				url: `https://tiles.example.org/{z}/{x}/{y}?key=${TOKEN}`,
			},
			{
				id: 'wms_base',
				type: 'wms',
				url: `https://wms.example.org/service?access=${TOKEN}`,
				params: { version: '1.3.0', layers: 'base', format: 'image/png', crs: 'EPSG:3857' },
				attribution: 'WMS',
			},
			// a rejected default is neither offered nor echoed
			{ id: 'local', ...XYZ, url: `http://localhost/{z}/{x}/{y}.png?key=${TOKEN}` },
		],
	});
	const emit = (mode: string) =>
		resolveEmittedPropertiesAndCss({
			model: 'component_geolocation',
			mode,
			tipo: 'test100',
			ownProperties: ownProperties(),
			sectionListChildProperties: null,
			sectionProperties: null,
		}).properties;

	test('edit, list and search contexts echo id, label and type only', () => {
		for (const mode of ['edit', 'list', 'search', 'tm']) {
			const properties = emit(mode);
			expect(properties.map_sources, mode).toEqual([
				{
					id: 'ign_base',
					label: 'IGN base',
					type: 'xyz',
					attribution: 'Example Org',
					max_zoom: 18,
				},
				{ id: 'wms_base', label: 'wms_base', type: 'wms', attribution: 'WMS', crs: 'EPSG:3857' },
			]);
			const wire = JSON.stringify(properties);
			expect(wire, mode).not.toContain(TOKEN);
			expect(wire, mode).not.toContain('tiles.example.org');
			expect(wire, mode).not.toContain('wms.example.org');
			expect(wire, mode).not.toContain('localhost');
			expect(wire, mode).not.toContain('"url"');
			expect(wire, mode).not.toContain('"params"');
			// the rest of the echo is untouched
			expect(properties.geo_provider, mode).toBe('OSM');
		}
	});

	test('the request_config door (explicit.ts) shares the shaper: same result, caller object owned', () => {
		const owned = ownProperties();
		const shaped = sanitizeEmittedProperties(owned, 'test100');
		expect(JSON.stringify(shaped)).not.toContain(TOKEN);
		expect(shaped.map_sources).toHaveLength(2);
	});

	test('a malformed key is never echoed; a node without the key is left as it is', () => {
		for (const bad of ['x', null, 7, { id: 'a' }, []]) {
			const out = sanitizeEmittedProperties({ map_sources: bad }, 'test100');
			expect(out.map_sources, JSON.stringify(bad)).toEqual([]);
		}
		const plain = { geo_provider: 'OSM' };
		expect(sanitizeEmittedProperties(plain, 'test100')).toBe(plain);
		expect('map_sources' in plain).toBe(false);
	});
});
