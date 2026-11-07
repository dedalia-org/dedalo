/**
 * DIFFUSION never publishes a geolocation entry's `sources` or `legend`
 * (WC-2026-11-06-geolocation-map-sources-legend).
 *
 * A source is an upstream URL — its template can carry a provider token — and a
 * legend is up to 256 KiB of embedded icons. Neither is a fact about the heritage
 * the publication describes, so the publication contract is a DECISION PER KEY
 * (src/core/geo/geo_entry_keys.ts GEO_SIBLING_PUBLICATION), applied at the one
 * door that copies the stored entry whole (default_value.ts). The other three
 * publication paths read lat/lon/lib_data by name; this gate proves all four
 * ignore the siblings, byte for byte, and that the wire cell carries neither the
 * keys nor the URL.
 *
 * Pure: no database; the record is a fixture object.
 */

import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MatrixRecord } from '../../src/core/db/matrix.ts';
import {
	GEO_SIBLING_KEYS,
	GEO_SIBLING_PUBLICATION,
	withoutUnpublishedGeoKeys,
} from '../../src/core/geo/geo_entry_keys.ts';
import { geoGeojson } from '../../src/diffusion/parsers/parser_misc.ts';
import {
	buildGeojsonLayers,
	geojsonPointFallbackLayers,
} from '../../src/diffusion/resolve/ddo_fns.ts';
import { defaultPublicationValue } from '../../src/diffusion/resolve/default_value.ts';
import { valueIrToString } from '../../src/diffusion/resolve/record_ir.ts';

const TIPO = 'testmint1015';
const TOKEN = 'tok_SECRET_diffusion';
const SIBLINGS = {
	sources: [
		{
			id: 4,
			type: 'xyz',
			url: `https://tiles.example.org/{z}/{x}/{y}.png?key=${TOKEN}`,
			params: {},
			attribution: 'Example Org',
		},
	],
	legend: { title: 'Roman roads', groups: [{ name: 'Surface', symbols: [{ label: 'Paved' }] }] },
};
const FEATURES = [
	{
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
	},
];

function geoRecord(items: unknown[]): MatrixRecord {
	return {
		id: 1,
		section_id: 75,
		section_tipo: 'testmint1',
		columns: { geo: { [TIPO]: items } },
		rawText: {},
	};
}

function atoms(items: unknown[]) {
	return defaultPublicationValue(geoRecord(items), TIPO, 'component_geolocation', { tipo: TIPO });
}

const published = (items: unknown[]): string =>
	atoms(items)
		.map((atom) => valueIrToString(atom as never))
		.join('|');

describe('the publication decision is data, one entry per sibling key', () => {
	test('every sibling key has a decision, and today every decision is "withheld"', () => {
		expect(Object.keys(GEO_SIBLING_PUBLICATION).sort()).toEqual([...GEO_SIBLING_KEYS].sort());
		for (const key of GEO_SIBLING_KEYS) expect(GEO_SIBLING_PUBLICATION[key]).toBe('withheld');
	});

	test('withoutUnpublishedGeoKeys drops exactly the withheld keys and copies', () => {
		const entry = { lat: 1, lon: 2, lib_data: [], future: 1, ...SIBLINGS };
		const before = structuredClone(entry);
		const out = withoutUnpublishedGeoKeys(entry);
		expect(Object.keys(out).sort()).toEqual(['future', 'lat', 'lib_data', 'lon']);
		expect(entry).toEqual(before);
		expect(out).not.toBe(entry);
	});

	test('the TABLE decides, not a hard-coded list: a key marked "published" survives, a withheld one does not', () => {
		// the real table is all-withheld, so only a widened fixture can tell the two apart
		const entry = { lat: 1, lon: 2, ...SIBLINGS };
		const opted = { sources: 'withheld', legend: 'published' } as const;
		expect(Object.keys(withoutUnpublishedGeoKeys(entry, opted)).sort()).toEqual([
			'lat',
			'legend',
			'lon',
		]);
		const both = { sources: 'published', legend: 'published' } as const;
		expect(Object.keys(withoutUnpublishedGeoKeys(entry, both)).sort()).toEqual([
			'lat',
			'legend',
			'lon',
			'sources',
		]);
		// the default is the real table
		expect(withoutUnpublishedGeoKeys(entry)).toEqual(
			withoutUnpublishedGeoKeys(entry, GEO_SIBLING_PUBLICATION),
		);
	});
});

describe('the standalone component_geolocation atom', () => {
	test('a point with siblings publishes the point and neither sibling key', () => {
		const out = atoms([{ id: 1, lat: '41.5', lon: '2.1', zoom: 15, alt: 281, ...SIBLINGS }]);
		expect(out).toHaveLength(1);
		const value = (out[0] as { value: Record<string, unknown> }).value;
		expect(value).toEqual({ lat: '41.5', lon: '2.1', zoom: 15, alt: 281 });
	});

	test('the cell that reaches the wire carries no sibling key and no URL or token', () => {
		const cell = published([
			{ id: 1, lat: 41.5, lon: 2.1, zoom: 15, alt: 0, lib_data: FEATURES, ...SIBLINGS },
		]);
		expect(cell).toContain('"lib_data"');
		for (const forbidden of ['"sources"', '"legend"', 'tiles.example.org', TOKEN, 'Roman roads']) {
			expect(cell, forbidden).not.toContain(forbidden);
		}
	});

	test('features publish with the siblings withheld, also when the view is the studio default', () => {
		const out = atoms([
			{ id: 1, lat: '39.462571', lon: '-0.376295', zoom: 8, lib_data: FEATURES, ...SIBLINGS },
		]);
		expect(out).toHaveLength(1);
		const value = (out[0] as { value: Record<string, unknown> }).value;
		expect(Object.keys(value).sort()).toEqual(['lib_data', 'zoom']);
	});

	test('an entry whose only content is the siblings publishes NOTHING', () => {
		expect(atoms([{ id: 1, ...SIBLINGS }])).toEqual([]);
		expect(atoms([{ id: 1, lat: '', lon: '', sources: SIBLINGS.sources }])).toEqual([]);
		expect(atoms([{ id: 1, legend: SIBLINGS.legend }])).toEqual([]);
	});

	test('the published bytes are identical with and without the siblings', () => {
		const bare = { id: 1, lat: 41.5, lon: 2.1, zoom: 15, alt: 3, lib_data: FEATURES };
		expect(published([{ ...bare, ...SIBLINGS }])).toBe(published([bare]));
	});
});

describe('the other publication paths never read the siblings', () => {
	const bare = { lat: '41.5', lon: '2,1', zoom: 15, alt: 3, lib_data: FEATURES };
	const withSiblings = { ...bare, ...SIBLINGS };

	test('parser_geo::geojson', () => {
		const run = (value: unknown) =>
			geoGeojson(
				[
					{
						id: null,
						value,
						tipo: TIPO,
						lang: 'lg-nolan',
						section_id: 1,
						section_tipo: 'testmint1',
					} as never,
				],
				{},
				{} as never,
			);
		expect(JSON.stringify(run([withSiblings]))).toBe(JSON.stringify(run([bare])));
		expect(JSON.stringify(run([{ lat: '41.5', lon: '2,1', ...SIBLINGS }]))).not.toContain(TOKEN);
	});

	test('buildGeojsonLayers and the point fallback', () => {
		expect(JSON.stringify(buildGeojsonLayers([withSiblings]))).toBe(
			JSON.stringify(buildGeojsonLayers([bare])),
		);
		const point = { lat: '41.5', lon: '2.1' };
		expect(JSON.stringify(geojsonPointFallbackLayers({ ...point, ...SIBLINGS } as never))).toBe(
			JSON.stringify(geojsonPointFallbackLayers(point as never)),
		);
		expect(JSON.stringify(buildGeojsonLayers([{ ...point, ...SIBLINGS }]))).not.toContain(TOKEN);
	});
});

describe('the geo module layering that the decision above depends on', () => {
	const GEO_DIR = join(import.meta.dir, '..', '..', 'src', 'core', 'geo');
	const files = readdirSync(GEO_DIR).filter((name) => name.endsWith('.ts'));
	const importsOf = (name: string): string[] =>
		[...readFileSync(join(GEO_DIR, name), 'utf8').matchAll(/^import[^;]*?from\s+'([^']+)'/gms)].map(
			(match) => match[1] as string,
		);

	test('the corpus is real (a scan of nothing proves nothing)', () => {
		expect(files.length).toBeGreaterThanOrEqual(9);
		expect(importsOf('map_source.ts').length).toBeGreaterThan(0);
	});

	test('geo_entry_keys.ts is a LEAF: diffusion reaches it without pulling the validators', () => {
		expect(importsOf('geo_entry_keys.ts')).toEqual([]);
		expect(readFileSync(join(GEO_DIR, 'geo_entry_keys.ts'), 'utf8')).toContain('GEO_SIBLING_KEYS');
	});

	test('nothing in src/core/geo reaches diffusion, tools or the save path', () => {
		for (const name of files) {
			for (const specifier of importsOf(name)) {
				expect(specifier, `${name} imports ${specifier}`).not.toMatch(
					/diffusion|\/tools\/|section\/record|section_record|api\//,
				);
			}
		}
	});

	test('the item gate is keyed on the descriptor facet, never on the model string', () => {
		const source = readFileSync(
			join(import.meta.dir, '..', '..', 'src', 'core', 'section', 'record', 'item_gates.ts'),
			'utf8',
		);
		expect(source).toContain('getItemGate(model)');
		expect(source).not.toContain("'component_geolocation'");
	});
});
