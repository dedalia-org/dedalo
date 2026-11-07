/**
 * `sources` and `legend` at the IMPORT door and in the CSV APPEND merge
 * (WC-2026-11-06-geolocation-map-sources-legend).
 *
 * IMPORT. The conform (tools/import_conform.ts) rebuilds an item from named
 * fields, so a key it does not name is silently dropped — which is how a raw
 * export would lose the siblings on the way back. It names them now and judges
 * them with the SAME validators the save gate runs, so:
 *  - a `dedalo_raw` round trip keeps `sources` (ids included) and `legend`;
 *  - a map definition needs no coordinate — an item with only siblings is a value
 *    (like a geometry-only item); `sources: []` / an empty legend say nothing;
 *  - a bad source is a REPORTED import failure with its path, the cell left
 *    alone, and the URL never in the message;
 *  - lib_data stays pure GeoJSON and the flat / FeatureCollection forms carry no
 *    siblings.
 *
 * APPEND is layers-only (append_merge.ts header): the siblings are never merged.
 *
 * Pure: no database.
 */

import { describe, expect, test } from 'bun:test';
import { mergeGeoLayers } from '../../src/core/section/record/append_merge.ts';
import { conformImportData } from '../../src/core/tools/import_data.ts';

const SOURCES = [
	{
		id: 4,
		type: 'xyz',
		url: 'https://tiles.example.org/{z}/{x}/{y}.png',
		params: { max_zoom: 18 },
		attribution: 'Example Org',
	},
	{
		id: 9,
		type: 'wms',
		url: 'https://wms.example.org/service',
		params: {
			version: '1.3.0',
			layers: 'base',
			styles: '',
			format: 'image/png',
			transparent: false,
			crs: 'EPSG:3857',
		},
		attribution: '',
	},
];
const LEGEND = {
	title: 'Roman roads',
	groups: [{ name: 'Surface', symbols: [{ label: 'Paved' }] }],
};
const LAYER = {
	layer_id: 1,
	layer_data: {
		type: 'FeatureCollection',
		features: [
			{
				type: 'Feature',
				properties: { layer_id: 1 },
				geometry: { type: 'Point', coordinates: [2.17, 41.38] },
			},
		],
	},
};

function conform(cell: unknown) {
	return conformImportData({
		model: 'component_geolocation',
		importValue: typeof cell === 'string' ? cell : JSON.stringify(cell),
		columnName: 't1',
		sectionTipo: 'test3',
		sectionId: 7,
		componentTipo: 'test100',
		lang: 'lg-nolan',
		wrapped: false,
	});
}

describe('import conform carries the siblings', () => {
	test('a raw round trip keeps sources (ids too) and legend; only the item id goes, as before', async () => {
		const stored = {
			id: 3,
			lat: 41.38,
			lon: 2.17,
			zoom: 12,
			alt: 16,
			lib_data: [LAYER],
			sources: SOURCES,
			legend: LEGEND,
		};
		const out = await conform([stored]);
		expect(out.errors).toHaveLength(0);
		const [item] = out.result as Record<string, unknown>[];
		expect(item).toEqual({
			lat: 41.38,
			lon: 2.17,
			zoom: 12,
			alt: 16,
			lib_data: [LAYER],
			sources: SOURCES,
			legend: LEGEND,
		});
	});

	test('siblings are normalized on the way in (trim, defaults), never mutated in the cell', async () => {
		const cell = [
			{
				lat: 1,
				lon: 2,
				sources: [{ type: 'xyz', url: SOURCES[0]?.url, attribution: '  padded  ' }],
			},
		];
		const snapshot = JSON.stringify(cell);
		const out = await conform(cell);
		const [item] = out.result as { sources: Record<string, unknown>[] }[];
		expect(item?.sources[0]).toEqual({
			type: 'xyz',
			url: SOURCES[0]?.url,
			params: {},
			attribution: 'padded',
		});
		expect(JSON.stringify(cell)).toBe(snapshot);
	});

	test('an item with NO coordinate and only siblings is a value', async () => {
		const out = await conform([{ sources: SOURCES, legend: LEGEND }]);
		expect(out.errors).toHaveLength(0);
		expect(out.result).toEqual([{ sources: SOURCES, legend: LEGEND }]);

		const blank = await conform([{ lat: '', lon: '', sources: SOURCES }]);
		expect(blank.result).toEqual([{ sources: SOURCES }]);

		const legendOnly = await conform({ legend: LEGEND });
		expect(legendOnly.result).toEqual([{ legend: LEGEND }]);
	});

	test('geometry and siblings together, no coordinate: both survive, framing only when stated', async () => {
		const out = await conform([{ lib_data: [LAYER], sources: SOURCES, zoom: 7 }]);
		expect(out.result).toEqual([{ lib_data: [LAYER], sources: SOURCES, zoom: 7 }]);
	});

	test('empty siblings say nothing: they store no key, and alone they are not a value', async () => {
		const withCoordinate = await conform([{ lat: 1, lon: 2, sources: [], legend: { groups: [] } }]);
		expect(withCoordinate.result).toEqual([{ lat: 1, lon: 2, zoom: 16, alt: 0 }]);

		// no coordinate, no geometry, nothing to say: refused (a typo'd header must not clear)
		const empty = await conform([{ sources: [], legend: null }]);
		expect(empty.result).toBeNull();
		expect(empty.errors).toHaveLength(1);
	});

	test('a bad source is a reported failure with its path; the reason never quotes the URL', async () => {
		const secret = 'tok_SECRET_import';
		const out = await conform([
			{
				lat: 1,
				lon: 2,
				sources: [
					{ type: 'xyz', url: `http://127.0.0.1/{z}/{x}/{y}.png?key=${secret}`, params: {} },
				],
			},
		]);
		expect(out.result).toBeNull();
		expect(out.errors).toHaveLength(1);
		expect(out.errors[0]?.msg).toContain('sources[0].url');
		// the failure's `data` field is the operator's own cell, echoed to them as for every model;
		// the REASON is ours, and it never quotes the template
		expect(out.errors[0]?.msg).not.toContain(secret);
	});

	test('a bad legend (svg icon) and an unknown sibling shape are refused', async () => {
		const svg = 'data:image/svg+xml;base64,PHN2Zy8+';
		const bad = await conform([
			{
				lat: 1,
				lon: 2,
				legend: { title: 'T', groups: [{ name: 'g', symbols: [{ label: 'l', icon: svg }] }] },
			},
		]);
		expect(bad.result).toBeNull();
		expect(bad.errors[0]?.msg).toContain('legend.groups[0].symbols[0].icon');

		const closed = await conform([{ lat: 1, lon: 2, sources: [{ ...SOURCES[0], headers: {} }] }]);
		expect(closed.result).toBeNull();
	});

	test('one bad item refuses the cell, siblings included (the stored value stays)', async () => {
		const out = await conform([
			{ lat: 1, lon: 2, sources: SOURCES },
			{ lat: 3, lon: 4, sources: [{ type: 'ftp', url: 'x' }] },
		]);
		expect(out.result).toBeNull();
		expect(out.errors).toHaveLength(1);
	});

	test('the flat form and a bare FeatureCollection carry no siblings', async () => {
		const flat = await conform('41.3874, 2.1686');
		expect(flat.result).toEqual([{ lat: 41.3874, lon: 2.1686, zoom: 16, alt: 0 }]);
		const fc = await conform({
			type: 'FeatureCollection',
			features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [2.1, 41.3] } }],
		});
		const [item] = fc.result as Record<string, unknown>[];
		expect(item).not.toHaveProperty('sources');
		expect(item).not.toHaveProperty('legend');
	});

	test('lib_data stays pure GeoJSON: a sibling key inside a layer is not hoisted or judged', async () => {
		const layer = { ...LAYER, sources: 'not-a-source-list' };
		const out = await conform([{ lat: 1, lon: 2, lib_data: [layer] }]);
		expect(out.errors).toHaveLength(0);
		const [item] = out.result as { lib_data: unknown[] }[];
		expect(item).not.toHaveProperty('sources');
		expect(item?.lib_data).toEqual([layer]);
	});
});

describe('CSV append is layers-only', () => {
	const stored = () => [
		{
			id: 1,
			lat: 41.38,
			lon: 2.17,
			zoom: 12,
			alt: 16,
			lib_data: [LAYER],
			sources: [SOURCES[0]],
			legend: LEGEND,
		},
	];
	const incoming = {
		lat: 40.4168,
		lon: -3.7038,
		sources: [SOURCES[1]],
		legend: { title: 'incoming', groups: [] },
	};

	test('onto a stored host the stored siblings stay BY REFERENCE and the incoming ones are dropped', () => {
		const host = stored();
		const out = mergeGeoLayers(host, [incoming]);
		const [merged] = out.items as Record<string, unknown>[];
		expect((merged?.lib_data as unknown[]).length).toBe(2);
		expect(merged?.sources).toBe(host[0]?.sources);
		expect(merged?.legend).toBe(host[0]?.legend);
		expect(JSON.stringify(merged)).not.toContain('incoming');
		expect(JSON.stringify(merged)).not.toContain('wms.example.org');
	});

	test('an incoming item with only siblings has no layer to add: a reported empty skip, nothing changes', () => {
		const host = stored();
		const out = mergeGeoLayers(host, [{ sources: [SOURCES[1]], legend: LEGEND }]);
		expect(out.skipped).toEqual([{ index: 0, reason: 'empty' }]);
		expect(out.items[0]).toBe(host[0]);
	});

	test('onto nothing the FIRST incoming item is the host as it is; later siblings are dropped', () => {
		const first = { lat: 1, lon: 2, sources: [SOURCES[0]], legend: LEGEND };
		const second = {
			lat: 3,
			lon: 4,
			sources: [SOURCES[1]],
			legend: { title: 'second', groups: [] },
		};
		const out = mergeGeoLayers([], [first, second]);
		expect(out.items).toHaveLength(1);
		const [host] = out.items as Record<string, unknown>[];
		expect(host?.sources).toEqual([SOURCES[0]]);
		expect(host?.legend).toEqual(LEGEND);
		// the second item's POINT still folds in as a layer
		expect((host?.lib_data as unknown[]).length).toBe(1);
		expect(JSON.stringify(host)).not.toContain('second');
	});
});
