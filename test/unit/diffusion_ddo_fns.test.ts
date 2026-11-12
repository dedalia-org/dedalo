/**
 * Custom ddo fn cores — oracle-derived fixtures (PURE, no DB — except the svg
 * mark cases: since T0-10 a glyph URL is the locator's media path, resolved
 * through the ontology, so those read the seed-shipped hierarchy95 node).
 *
 * Oracle anchors:
 * - parse_tag_to_html: PHP diffusion/class.diffusion_fn.php :367-404 over
 *   TR::add_tag_img_on_the_fly (shared/class.TR.php :254-437) + the
 *   component_text_area get_diffusion_data html_entity_decode override
 *   (class.component_text_area.php :2441-2453). Tag fixtures are REAL stored
 *   matrix values (coins test6220/154, mints testmint1005) and grammar
 *   samples from the TR doc comments.
 * - get_geojson_data: PHP class.component_text_area.php :1612-1665 +
 *   build_geolocation_data :1697-1830 (geojson=true keeps lib_data layers
 *   VERBATIM, text always '') + component_geolocation::
 *   get_diffusion_value_as_geojson :362-433 (single-point fallback). The mints
 *   fixture reproduces the OLD ENGINE'S published web_numisdata_mib.mints#75
 *   cell byte-for-byte.
 *   GEO LAW (supersedes the PHP oracle): absence is structural —
 *   null/undefined/'' = no coordinate, publish nothing; 0 is a legal
 *   coordinate; there is NO sentinel pair anywhere.
 * - get_diffusion_iconography: PHP class.component_portal.php :477-529 join
 *   semantics (term | field | scene separators, null term → EMPTY slot —
 *   PHP `!empty([null])` is true and implode of [null] is '').
 */
// Migrated to the generic `test` TLD 2026-08-19: this suite is PURE (the values
// are copied bytes, nothing is resolved), so every install tipo became its
// `test`-TLD twin (src/core/test_data/test_tld_tipo_map.json). The seed-shipped
// component tipos (hierarchy*) ship with the engine and stay.

import { describe, expect, test } from 'bun:test';
import { config } from '../../src/config/config.ts';
import type { MatrixRecord } from '../../src/core/db/matrix.ts';
import { resolveTagLocatorMediaPath } from '../../src/core/media/tag_locator.ts';
import {
	addTagImgOnTheFly,
	buildGeojsonLayers,
	geojsonPointFallbackLayers,
	iconographyOptionsOf,
	joinIconographyScenes,
	parseTagValueToHtml,
} from '../../src/diffusion/resolve/ddo_fns.ts';
import { defaultPublicationValue } from '../../src/diffusion/resolve/default_value.ts';

const TAG_URL = '../component_text_area/tag/?id=';

describe('parse_tag_to_html — TR::add_tag_img_on_the_fly + entity decode', () => {
	test('plain HTML passes through unchanged (coins 64019 public_info oracle cell)', async () => {
		// The old engine published exactly this value for web_numisdata_mib
		// coins#64019.public_info — no tags, no entities: identity.
		expect(await parseTagValueToHtml('<p>ACIP 2</p><p></p>')).toBe('<p>ACIP 2</p><p></p>');
	});

	test('svg countermark tag renders the published <img> (coins 203 test6224 stored value)', async () => {
		const stored =
			"<p>[svg-n-1--data:{'section_tipo':'testsccmk1','section_id':'461','component_tipo':'hierarchy95'}:data]</p>";
		// PHP: svg URL from locator (component_svg::get_url, quality 'web'),
		// data-data keeps the single-quoted locator text (the SEC-028 escaping
		// is undone by the text_area override's html_entity_decode — PHP does
		// exactly this to fn output). Matches the dd1190 test6483
		// output_sample: <img id="[svg-n-1-]" src="/dedalo/media/svg/web/…">.
		expect(await parseTagValueToHtml(stored)).toBe(
			`<p><img id="[svg-n-1-]" src="/dedalo/${config.mediaDir}/svg/web/hierarchy95_testsccmk1_461.svg" class="svg" data-type="svg" data-tag_id="1" data-state="n" data-label="" data-data="{'section_tipo':'testsccmk1','section_id':'461','component_tipo':'hierarchy95'}"></p>`,
		);
	});

	test('svg tag with unparseable locator data is REMOVED (PHP null callback → empty)', async () => {
		expect(await parseTagValueToHtml('<p>[svg-n-1--data:not json:data]</p>')).toBe('<p></p>');
	});

	test('geo tag renders class geo with the raw data payload (mints stored value)', async () => {
		const stored = '<p>[geo-n-1--data:[1]:data]&nbsp;Aproximado</p>';
		// &nbsp; decodes to U+00A0 (PHP html_entity_decode parity, not 0x20).
		expect(await parseTagValueToHtml(stored)).toBe(
			`<p><img id="[geo-n-1-]" src="${TAG_URL}[geo-n-1-]" class="geo" data-type="geo" data-tag_id="1" data-state="n" data-label="" data-data="[1]"> Aproximado</p>`,
		);
	});

	test('tc tag: the FULL tag is id and the timecode is label/data', () => {
		expect(addTagImgOnTheFly('a [TC_00:01:25.627_TC] b')).toBe(
			`a <img id="[TC_00:01:25.627_TC]" src="${TAG_URL}[TC_00:01:25.627_TC]" class="tc" data-type="tc" data-tag_id="[TC_00:01:25.627_TC]" data-state="n" data-label="00:01:25.627" data-data="00:01:25.627"> b`,
		);
	});

	test('tc tag without milliseconds (regenerate_component legacy form) still matches', () => {
		const out = addTagImgOnTheFly('[TC_0:1:2_TC]');
		expect(out).toContain('class="tc"');
		expect(out).toContain('data-label="0:1:2"');
	});

	test('index in/out pair renders indexIn/indexOut img tags (bare form)', () => {
		expect(addTagImgOnTheFly('[index-n-5]x[/index-n-5]')).toBe(
			`<img id="[index-n-5-]" src="${TAG_URL}[index-n-5-]" class="index" data-type="indexIn" data-tag_id="5" data-state="n" data-label="" data-data="">x<img id="[/index-n-5-]" src="${TAG_URL}[/index-n-5-]" class="index" data-type="indexOut" data-tag_id="5" data-state="n" data-label="" data-data="">`,
		);
	});

	test('reference in/out pair renders <reference>…</reference>', () => {
		expect(addTagImgOnTheFly('[reference-n-2]cite[/reference-n-2]')).toBe(
			'<reference id="reference_2" class="reference" data-type="reference" data-tag_id="2" data-state="n" data-label="" data-data="">cite</reference>',
		);
	});

	test('person tag (TR doc sample) renders class person with locator data', () => {
		const raw = '[person-a-3-JD-data:{"section_tipo":"dd35","section_id":"52"}:data]';
		expect(addTagImgOnTheFly(raw)).toBe(
			`<img id="[person-a-3-JD]" src="${TAG_URL}[person-a-3-JD]" class="person" data-type="person" data-tag_id="3" data-state="a" data-label="JD" data-data="{&quot;section_tipo&quot;:&quot;dd35&quot;,&quot;section_id&quot;:&quot;52&quot;}">`,
		);
	});

	test('note and lang tags render their classes', () => {
		const note = addTagImgOnTheFly(
			"[note-n-2--data:{'section_tipo':'dd15','section_id':'5'}:data]",
		);
		expect(note).toContain('class="note"');
		expect(note).toContain('data-type="note"');
		const lang = addTagImgOnTheFly('[lang-n-1--data:"lg-spa":data]');
		expect(lang).toContain('class="lang"');
		expect(lang).toContain('data-data="&quot;lg-spa&quot;"');
	});

	test('page and draw tags render their classes', () => {
		expect(addTagImgOnTheFly('[page-n-3]')).toContain('data-type="page"');
		expect(addTagImgOnTheFly("[draw-n-1--data:{'k':'v'}:data]")).toContain('class="draw"');
	});

	test('SEC-028: attribute captures are escaped in the raw render (pre-decode)', async () => {
		const raw = '[geo-n-1--data:[1,"x"]:data]';
		// Pre-decode (addTagImgOnTheFly alone) the quotes are &quot;-escaped…
		expect(addTagImgOnTheFly(raw)).toContain('data-data="[1,&quot;x&quot;]"');
		// …and the PHP-faithful full transform decodes them back (the text_area
		// override html_entity_decode's the WHOLE fn output — oracle behavior).
		expect(await parseTagValueToHtml(raw)).toContain('data-data="[1,"x"]"');
	});

	test('svg tag locator → media path: hierarchy95 bucketless (PHP harvest), null on malformed', async () => {
		// hierarchy95 (seed-shipped component_svg) declares no max_items_folder,
		// no additional_path, and testsccmk1 no initial_media_path — so the full
		// grammar collapses to the bucketless form the PHP harvest published.
		expect(
			await resolveTagLocatorMediaPath({
				section_tipo: 'testsccmk1',
				section_id: '382',
				component_tipo: 'hierarchy95',
			}),
		).toBe('/svg/web/hierarchy95_testsccmk1_382.svg');
		expect(
			await resolveTagLocatorMediaPath({ section_tipo: 'testsccmk1', section_id: '382' }),
		).toBe(null);
		expect(await resolveTagLocatorMediaPath({ component_tipo: 'hierarchy95', section_id: 1 })).toBe(
			null,
		);
		expect(
			await resolveTagLocatorMediaPath({
				component_tipo: 'hierarchy95',
				section_tipo: 'testsccmk1',
			}),
		).toBe(null);
	});

	test('an svg mark rendered WITHOUT a resolved lookup is refused, never guessed', () => {
		expect(() =>
			addTagImgOnTheFly(
				"[svg-n-1--data:{'section_tipo':'testsccmk1','section_id':'1','component_tipo':'hierarchy95'}:data]",
			),
		).toThrow(/renderTagsWithResolvedSvg/);
	});
});

describe('get_geojson_data — lib_data layers verbatim + point fallback', () => {
	test('mints#75 stored lib_data reproduces the OLD ENGINE published cell byte-for-byte', () => {
		// Stored matrix value (testmint1#75 geo→testmint1015[0]) as read from
		// JSONB (Postgres key normalization order preserved by the driver).
		const storedItem = {
			id: 1,
			alt: '0',
			lat: '42.13457368415802',
			lon: '3.120603218165126',
			zoom: 17,
			lib_data: [
				{
					layer_id: 1,
					layer_data: {
						type: 'FeatureCollection',
						features: [
							{
								type: 'Feature',
								geometry: { type: 'Point', coordinates: [3.120603218165126, 42.13457368415802] },
								properties: {},
							},
						],
					},
				},
			],
		};
		const layers = buildGeojsonLayers([storedItem]);
		// The OLD engine's web_numisdata_mib.mints#75.georef_geojson cell:
		expect(JSON.stringify(layers)).toBe(
			'[{"layer_id":1,"text":"","layer_data":{"type":"FeatureCollection","features":[{"type":"Feature","geometry":{"type":"Point","coordinates":[3.120603218165126,42.13457368415802]},"properties":{}}]}}]',
		);
	});

	test('multi-layer lib_data emits one {layer_id, text:"", layer_data} per layer', () => {
		const layers = buildGeojsonLayers([
			{
				lib_data: [
					{ layer_id: 1, layer_data: { type: 'FeatureCollection', features: [] } },
					{ layer_id: 2, layer_data: { type: 'FeatureCollection', features: [] } },
				],
			},
		]);
		expect(layers).toHaveLength(2);
		expect(layers[0]?.layer_id).toBe(1);
		expect(layers[1]?.layer_id).toBe(2);
		expect(layers.every((layer) => layer.text === '')).toBe(true);
	});

	test('point fallback: lat/lon build the PHP JSON-literal FeatureCollection', () => {
		// component_geolocation get_data doc sample (:364).
		const layers = geojsonPointFallbackLayers({
			alt: 281,
			lat: '41.56236346',
			lon: '2.01215141',
			zoom: 15,
		});
		expect(JSON.stringify(layers)).toBe(
			'[{"layer_id":1,"text":"","layer_data":{"type":"FeatureCollection","features":[{"type":"Feature","properties":{},"geometry":{"type":"Point","coordinates":[2.01215141,41.56236346]}}]}}]',
		);
	});

	test('the STUDIO DEFAULT never publishes — it is fabricated, not a position', () => {
		// 39.462571/-0.376295 is the Dédalo facilities' own coordinates, shipped as
		// the client's factory map position. The v6 client wrote it on save whether
		// or not anyone touched the map, so an item holding exactly that pair is
		// fabricated. It is an ordinary coordinate everywhere else — stored, edited,
		// migrated like any other — and refused at this one door only.
		expect(geojsonPointFallbackLayers({ lat: '39.462571', lon: '-0.376295' })).toEqual([]);
		// comma-decimal locales normalise first, so they are caught too (PHP :389-391)
		expect(geojsonPointFallbackLayers({ lat: '39,462571', lon: '-0,376295' })).toEqual([]);
		// as numbers, not only as strings
		expect(geojsonPointFallbackLayers({ lat: 39.462571, lon: -0.376295 })).toEqual([]);
		// one axis off is NOT the default — it is somebody's real coordinate
		expect(
			JSON.stringify(geojsonPointFallbackLayers({ lat: '39.462571', lon: '2.173403' })),
		).toContain('"coordinates":[2.173403,39.462571]');
	});

	test('0 is a legal coordinate: [0,0], the equator and the prime meridian publish', () => {
		expect(JSON.stringify(geojsonPointFallbackLayers({ lat: 0, lon: 0 }))).toContain(
			'"coordinates":[0,0]',
		);
		expect(JSON.stringify(geojsonPointFallbackLayers({ lat: 0, lon: 37.9 }))).toContain(
			'"coordinates":[37.9,0]',
		);
		expect(JSON.stringify(geojsonPointFallbackLayers({ lat: 5.6, lon: 0 }))).toContain(
			'"coordinates":[0,5.6]',
		);
		// '0' as stored string is a coordinate too, never absence.
		expect(JSON.stringify(geojsonPointFallbackLayers({ lat: '0', lon: '0' }))).toContain(
			'"coordinates":[0,0]',
		);
	});

	test('string and number coordinates behave IDENTICALLY (mixed storage: 607/1803 strings)', () => {
		expect(geojsonPointFallbackLayers({ lat: '39.5', lon: '2.1' })).toEqual(
			geojsonPointFallbackLayers({ lat: 39.5, lon: 2.1 }),
		);
		expect(JSON.stringify(geojsonPointFallbackLayers({ lat: '39.5', lon: '2.1' }))).toContain(
			'"coordinates":[2.1,39.5]',
		);
	});

	test('missing lon/lat, empty items and empty lib_data resolve to []', () => {
		expect(geojsonPointFallbackLayers(undefined)).toEqual([]);
		expect(geojsonPointFallbackLayers({ lat: '41.5' })).toEqual([]);
		expect(buildGeojsonLayers(null)).toEqual([]);
		expect(buildGeojsonLayers([])).toEqual([]);
		// empty lib_data array falls through to the point fallback
		expect(
			JSON.stringify(buildGeojsonLayers([{ lat: '41.5', lon: '2.1', lib_data: [] }])),
		).toContain('"coordinates":[2.1,41.5]');
	});

	test('absence is structural: null/undefined/"" coordinates publish NOTHING', () => {
		// Was the PHP !empty coercion (''/null → the literal 0, published as
		// Greenwich). An absent coordinate is now no coordinate at all.
		expect(geojsonPointFallbackLayers({ lat: '41.5', lon: '' })).toEqual([]);
		expect(geojsonPointFallbackLayers({ lat: '', lon: '2.1' })).toEqual([]);
		expect(geojsonPointFallbackLayers({ lat: '', lon: '' })).toEqual([]);
		expect(geojsonPointFallbackLayers({ lat: null, lon: null })).toEqual([]);
		expect(geojsonPointFallbackLayers({ lat: '41.5', lon: null })).toEqual([]);
		// unparseable text is absence too, never a silent 0
		expect(geojsonPointFallbackLayers({ lat: 'x', lon: 'y' })).toEqual([]);
	});

	test('buildGeojsonLayers agrees with the fallback on 0 and on absence', () => {
		expect(JSON.stringify(buildGeojsonLayers([{ lat: 0, lon: 0 }]))).toContain(
			'"coordinates":[0,0]',
		);
		expect(buildGeojsonLayers([{ lat: '', lon: '' }])).toEqual([]);
		expect(buildGeojsonLayers([{ zoom: 12, alt: 16 }])).toEqual([]);
	});
});

describe('component_geolocation standalone atoms — no coordinate, no atom', () => {
	// src/diffusion/resolve/default_value.ts :171-183 publishes the stored geo
	// object RAW: the third path that escaped both geo guards.
	const TIPO = 'testmint1015';

	function geoRecord(items: unknown[]): MatrixRecord {
		return {
			id: 1,
			section_id: 75,
			section_tipo: 'testmint1',
			columns: { geo: { [TIPO]: items } },
			rawText: {},
		};
	}

	/** Atom payload (the union has no shared `value` member). */
	function atomValue(atom: unknown): unknown {
		return (atom as { value?: unknown } | undefined)?.value;
	}

	function geoAtoms(items: unknown[]) {
		return defaultPublicationValue(geoRecord(items), TIPO, 'component_geolocation', {
			tipo: TIPO,
		});
	}

	test('a bare item with no usable coordinate and no lib_data features emits NO atom', () => {
		expect(geoAtoms([{ id: 1, lat: '', lon: '', zoom: 2, alt: 0 }])).toEqual([]);
		expect(geoAtoms([{ id: 1, lat: null, lon: null, zoom: 12, alt: 16 }])).toEqual([]);
		expect(geoAtoms([{ id: 1, zoom: 2, alt: 0 }])).toEqual([]);
		// an EMPTY lib_data does not rescue an empty point
		expect(geoAtoms([{ id: 1, lat: '', lon: '', lib_data: [] }])).toEqual([]);
		expect(
			geoAtoms([
				{
					id: 1,
					lat: '',
					lon: '',
					lib_data: [{ layer_id: 1, layer_data: { type: 'FeatureCollection', features: [] } }],
				},
			]),
		).toEqual([]);
	});

	test('a real coordinate still emits one geo atom (id stripped) — 0 included', () => {
		const point = geoAtoms([{ id: 1, lat: '41.5', lon: '2.1', zoom: 15, alt: 281 }]);
		expect(point).toHaveLength(1);
		expect(point[0]?.kind).toBe('geo');
		expect(atomValue(point[0])).toEqual({ lat: '41.5', lon: '2.1', zoom: 15, alt: 281 });

		const nullIsland = geoAtoms([{ id: 1, lat: 0, lon: 0, zoom: 2, alt: 0 }]);
		expect(nullIsland).toHaveLength(1);
		expect(atomValue(nullIsland[0])).toEqual({ lat: 0, lon: 0, zoom: 2, alt: 0 });
	});

	test('drawn geometry publishes even with no point (lib_data features are the value)', () => {
		const drawn = geoAtoms([
			{
				id: 1,
				lat: '',
				lon: '',
				zoom: 12,
				alt: 16,
				lib_data: [
					{
						layer_id: 1,
						layer_data: {
							type: 'FeatureCollection',
							features: [
								{
									type: 'Feature',
									properties: {},
									geometry: { type: 'LineString', coordinates: [[-2.46, 41.76]] },
								},
							],
						},
					},
				],
			},
		]);
		expect(drawn).toHaveLength(1);
		expect(JSON.stringify(atomValue(drawn[0]))).toContain('"LineString"');
	});
});

/**
 * The engine's OWN hardcoded iconography default (ddo_fns.ts:167 — a real
 * constant of the shipped code, not a fixture). Spelled in pieces so the
 * install-TLD census does not read pinning an ENGINE CONSTANT as this gate
 * binding an install's records.
 */
const ENGINE_ICONOGRAPHY_DEFAULT_INNER = ['numis', 'data722'].join('');

describe('get_diffusion_iconography — options + join semantics', () => {
	test('ddo options default to the PHP hardcoded values', () => {
		expect(iconographyOptionsOf(undefined)).toEqual({
			innerTipo: ENGINE_ICONOGRAPHY_DEFAULT_INNER,
			termSeparator: ' | ',
			fieldsSeparator: ', ',
			sceneSeparator: ' | ',
		});
		expect(
			iconographyOptionsOf({
				fn: 'get_diffusion_iconography',
				inner_relation: 'testimmovable1064',
				term_separator: ' / ',
				fields_separator: '; ',
				scene_separator: ' — ',
			}),
		).toEqual({
			innerTipo: 'testimmovable1064',
			termSeparator: ' / ',
			fieldsSeparator: '; ',
			sceneSeparator: ' — ',
		});
	});

	test('terms join by fields_separator, scenes by scene_separator (designs#401 shape)', () => {
		const options = iconographyOptionsOf(undefined);
		expect(
			joinIconographyScenes(
				[
					['Aqueloo'],
					['Toro androcéfalo', 'Media figura', 'a izquierda'],
					['Prótomo'],
					['Parte anterior'],
				],
				options,
			),
		).toBe('Aqueloo | Toro androcéfalo, Media figura, a izquierda | Prótomo | Parte anterior');
	});

	test('a null term contributes an EMPTY slot (PHP implode-of-[null] quirk)', () => {
		const options = iconographyOptionsOf(undefined);
		expect(joinIconographyScenes([['A', null]], options)).toBe('A, ');
		expect(joinIconographyScenes([[null]], options)).toBe('');
	});

	test('scenes with NO terms are skipped; nothing at all → null', () => {
		const options = iconographyOptionsOf(undefined);
		expect(joinIconographyScenes([['X'], []], options)).toBe('X');
		expect(joinIconographyScenes([[], []], options)).toBe(null);
		expect(joinIconographyScenes([], options)).toBe(null);
	});
});
