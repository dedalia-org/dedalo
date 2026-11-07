/**
 * The GUARDS of the geolocation sources/legend contract that no single validator
 * can carry (WC-2026-11-06-geolocation-map-sources-legend): the places where a
 * stored value LEAVES the server, and the claims the source headers make.
 *
 *  1. SERVING. The save gate validates what is written, but bytes reach the `geo`
 *     column without it (a Time Machine restore, a bulk revert, an archive
 *     restore, and the gate's own "trust what is unchanged"). So the legend is
 *     re-validated where it leaves the server (`servedMapLegend`), a source's
 *     attribution — the one field that reaches an HTML sink — is re-judged with it
 *     (`servedMapSources`), both reached by the geolocation emit hook, and a `list`
 *     row carries no map definition at all. Driven here on the pure functions AND
 *     through the real read and the real save echo on a scratch record whose
 *     column was written straight, the way a restore writes it.
 *  2. THE CLIENT SINK. The XSS posture of a legend (an icon only as `<img src>`,
 *     text only as text) is a rule about client code. The gate is a STRUCTURAL scan
 *     of the geolocation client files (test/helpers/geo_client_sink_scan.ts: parsed
 *     statements and a small taint pass, not a spelling on one line) for a
 *     legend/source value reaching an HTML sink — with a positive control per shape
 *     it exists to catch, so a scan that stopped matching would fail here rather
 *     than pass quietly. It is a heuristic and says so; the server layers do not
 *     lean on it.
 *  3. THE HEADERS. A header that names a gate must name a file that exists.
 *
 * Scratch surface: test3 records created at runtime, swept in afterAll.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from '@babel/parser';
import { type ApiRequestContext, dispatchRqo } from '../../src/core/api/dispatch.ts';
import type { Rqo } from '../../src/core/concepts/rqo.ts';
import { sql } from '../../src/core/db/postgres.ts';
import { servedGeoEntry } from '../../src/core/geo/entry_siblings.ts';
import { LEGEND_LIMITS, servedMapLegend } from '../../src/core/geo/map_legend.ts';
import { servedMapSources } from '../../src/core/geo/map_source.ts';
import { createSectionRecord } from '../../src/core/section/record/create_record.ts';
import type { Principal } from '../../src/core/security/permissions.ts';
import { assertTestDatabase } from '../../src/core/test_data/test_database_marker.ts';
import {
	htmlSinksOnMapDefinition,
	taintedNamesIn,
	trustedEscapersIn,
} from '../helpers/geo_client_sink_scan.ts';
import { jpegUri, pngUri } from '../helpers/geo_icon_fixture.ts';
import { cleanScratchRecord } from '../helpers/test_data.ts';

const ROOT_DIR = join(import.meta.dir, '..', '..');
const SECTION = 'test3';
const TABLE = 'matrix_test';
const GEO = 'test100';
const USER_ID = -1;
const ROOT: Principal = { userId: USER_ID, isGlobalAdmin: true, isDeveloper: true };

/** A real 1x1 PNG. */
const PNG_URI =
	'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
/** Well-formed base64 of an <svg> document: what a restore or a legacy write could leave behind. */
const SVG_URI = `data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>').toString('base64')}`;
/** A `data:image/png` whose payload is markup, not a PNG. */
const FAKE_PNG_URI = `data:image/png;base64,${Buffer.from('<script>alert(1)</script>').toString('base64')}`;

const legend = (symbols: unknown[], title = 'T') => ({
	title,
	groups: [{ name: 'g', symbols }],
});

describe('servedMapLegend: the legend as it may leave the server', () => {
	test('a conforming legend is served as validated (normalized, the same content)', () => {
		const stored = legend([{ label: 'Paved', icon: PNG_URI }, { label: 'Track' }]);
		expect(servedMapLegend(stored) as unknown).toEqual(stored);
	});

	test('a stored non-raster icon is NOT served: the icon goes, the symbol and the text stay', () => {
		const stored = legend([
			{ label: 'svg', icon: SVG_URI },
			{ label: 'url', icon: 'https://example.org/i.png' },
			{ label: 'fake png', icon: FAKE_PNG_URI },
			{ label: 'js', icon: 'javascript:alert(1)' },
			{ label: 'ok', icon: PNG_URI },
			{ label: 'none' },
		]);
		const served = servedMapLegend(stored);
		expect(served).not.toBeNull();
		const symbols = served?.groups[0]?.symbols ?? [];
		expect(symbols.map((symbol) => symbol.label)).toEqual([
			'svg',
			'url',
			'fake png',
			'js',
			'ok',
			'none',
		]);
		expect(symbols.map((symbol) => symbol.icon)).toEqual([
			undefined,
			undefined,
			undefined,
			undefined,
			PNG_URI,
			undefined,
		]);
		expect(JSON.stringify(served)).not.toContain('svg+xml');
		expect(JSON.stringify(served)).not.toContain('<script');
	});

	test('serving never mutates the stored value', () => {
		const stored = legend([{ label: 'svg', icon: SVG_URI }]);
		const before = JSON.stringify(stored);
		servedMapLegend(stored);
		expect(JSON.stringify(stored)).toBe(before);
	});

	test('icons that together outgrew the cap are all dropped, the text survives', () => {
		// each icon is valid on its own (a real PNG header, then padding, well under the per-icon
		// cap); five of them are over the legend total
		const big = pngUri(16, 16, 40_000);
		expect(big.length).toBeLessThanOrEqual(LEGEND_LIMITS.maxIconChars);
		expect(big.length * 5).toBeGreaterThan(LEGEND_LIMITS.maxIconCharsTotal);
		const symbols = Array.from({ length: 5 }, (_, index) => ({ label: `s${index}`, icon: big }));
		const served = servedMapLegend(legend(symbols));
		expect(served?.groups[0]?.symbols.map((symbol) => symbol.label)).toEqual([
			's0',
			's1',
			's2',
			's3',
			's4',
		]);
		for (const symbol of served?.groups[0]?.symbols ?? []) expect(symbol.icon).toBeUndefined();
		// and one icon of that size alone IS served (the control: it is the total that broke it)
		expect(
			servedMapLegend(legend([{ label: 'one', icon: big }]))?.groups[0]?.symbols[0]?.icon,
		).toBe(big);
	});

	test('a stored pixel bomb is NOT served: the icon goes, the symbol stays', () => {
		// a restore or a legacy write can leave a header that declares a gigabyte of bitmap in 60 bytes
		const stored = legend([
			{ label: 'bomb', icon: pngUri(16_000, 16_000) },
			{ label: 'jpeg bomb', icon: jpegUri(65_535, 65_535) },
			{ label: 'ok', icon: pngUri(24, 24) },
		]);
		const symbols = servedMapLegend(stored)?.groups[0]?.symbols ?? [];
		expect(symbols.map((symbol) => symbol.label)).toEqual(['bomb', 'jpeg bomb', 'ok']);
		expect(symbols.map((symbol) => symbol.icon)).toEqual([undefined, undefined, pngUri(24, 24)]);
	});

	test('icons that together outgrew the PIXEL budget are all dropped, the text survives', () => {
		// each is the largest allowed icon and tiny in characters: only the pixel total can refuse them
		const icon = pngUri(LEGEND_LIMITS.maxIconSide, LEGEND_LIMITS.maxIconSide);
		const each = LEGEND_LIMITS.maxIconSide ** 2;
		const count = Math.floor(LEGEND_LIMITS.maxIconPixelsTotal / each) + 1;
		const symbols = Array.from({ length: count }, (_, index) => ({ label: `s${index}`, icon }));
		const served = servedMapLegend(legend(symbols));
		expect(served?.groups[0]?.symbols).toHaveLength(count);
		for (const symbol of served?.groups[0]?.symbols ?? []) expect(symbol.icon).toBeUndefined();
		// one fewer fits, and is served whole
		const fits = servedMapLegend(legend(symbols.slice(1)));
		expect(fits?.groups[0]?.symbols.every((symbol) => symbol.icon === icon)).toBe(true);
	});

	test('text that opens a tag is not repaired: nothing is served', () => {
		expect(servedMapLegend(legend([{ label: '<img src=x onerror=alert(1)>' }]))).toBeNull();
		expect(servedMapLegend(legend([{ label: 'ok' }], '<script>x</script>'))).toBeNull();
	});

	test('nothing to say, or not a legend: null', () => {
		for (const raw of [
			null,
			undefined,
			'x',
			5,
			[],
			{},
			{ title: '', groups: [] },
			{ groups: 'no' },
		]) {
			expect(servedMapLegend(raw), JSON.stringify(raw)).toBeNull();
		}
	});
});

describe('servedMapSources: the sources as they may leave the server', () => {
	const source = (over: Record<string, unknown> = {}) => ({
		id: 2,
		type: 'xyz',
		url: 'https://t.example.org/{z}/{x}/{y}',
		params: {},
		attribution: 'Example Org',
		...over,
	});

	test('a conforming source is served as stored (the same object: nothing to repair)', () => {
		const stored = [
			source(),
			source({ id: 3, attribution: '' }),
			source({ id: 4, attribution: undefined }),
		];
		const served = servedMapSources(stored);
		expect(served).toEqual(stored);
		expect(served?.[0]).toBe(stored[0]);
	});

	test('an attribution that opens a tag is served BLANK; the source itself is kept', () => {
		for (const hostile of [
			'<img src=x onerror=alert(1)>',
			'ok <b>bold</b>',
			'a > b',
			'x'.repeat(301),
			'tab\there',
			'nul\u0000l',
		]) {
			const served = servedMapSources([source({ attribution: hostile })]);
			expect(served?.[0]).toEqual(source({ attribution: '' }));
			expect(JSON.stringify(served)).not.toContain('onerror');
		}
		// a non-string attribution is not text either
		expect(servedMapSources([source({ attribution: { html: '<i>' } })])?.[0]?.attribution).toBe('');
	});

	test('only the attribution is re-judged: a legacy template the gate trusts is still served', () => {
		// dropping it would let the next save (REPLACE semantics) delete a source nobody asked to delete;
		// the browser never fetches `url`, and the proxy re-validates it at fetch time
		const legacy = source({ url: 'http://127.0.0.1/{z}/{x}/{y}.png', params: { surprise: 1 } });
		expect(servedMapSources([legacy])).toEqual([legacy]);
	});

	test('elements that are not objects cannot be drawn and are dropped; nothing left is null', () => {
		expect(servedMapSources([source(), 'junk', null, 5, [1]])).toEqual([source()]);
		for (const raw of [undefined, null, 'x', 5, {}, { 0: source() }, [], [null, 'junk']]) {
			expect(servedMapSources(raw), JSON.stringify(raw)).toBeNull();
		}
	});

	test('serving never mutates the stored value', () => {
		const stored = [source({ attribution: '<b>x</b>' })];
		const before = JSON.stringify(stored);
		servedMapSources(stored);
		expect(JSON.stringify(stored)).toBe(before);
	});
});

describe('servedGeoEntry: a list row carries no map definition, every other mode a clean one', () => {
	const entry = {
		id: 1,
		lat: 1,
		lon: 2,
		zoom: 3,
		alt: 0,
		lib_data: [],
		sources: [
			{ id: 2, type: 'xyz', url: 'https://t.example.org/{z}/{x}/{y}', params: {}, attribution: '' },
			{
				id: 3,
				type: 'xyz',
				url: 'https://u.example.org/{z}/{x}/{y}',
				params: {},
				attribution: '<img src=x onerror=alert(1)>',
			},
		],
		legend: legend([{ label: 'svg', icon: SVG_URI }]),
	};

	test('list: view and features only', () => {
		const served = servedGeoEntry(entry, 'list') as Record<string, unknown>;
		expect(Object.keys(served).sort()).toEqual(['alt', 'id', 'lat', 'lib_data', 'lon', 'zoom']);
	});

	test('edit (and tm, search, any other): sources re-judged, legend re-validated', () => {
		for (const mode of ['edit', 'tm', 'search', 'portal']) {
			const served = servedGeoEntry(entry, mode) as Record<string, unknown>;
			const sources = served.sources as { id: number; attribution: string }[];
			// the sources are the stored ones, the hostile attribution blank
			expect(
				sources.map((candidate) => candidate.id),
				mode,
			).toEqual([2, 3]);
			expect(
				sources.map((candidate) => candidate.attribution),
				mode,
			).toEqual(['', '']);
			expect(JSON.stringify(served), mode).not.toContain('onerror');
			expect(JSON.stringify(served.legend), mode).not.toContain('svg+xml');
			expect(
				(served.legend as { groups: { symbols: { label: string }[] }[] }).groups[0]?.symbols[0]
					?.label,
			).toBe('svg');
		}
	});

	test('a legend with nothing safe left is dropped as a key, not served empty', () => {
		const served = servedGeoEntry({ ...entry, legend: legend([{ label: '<b>x' }]) }, 'edit');
		expect(served).not.toHaveProperty('legend');
	});

	test('sources with nothing to draw are dropped as a key, not served empty', () => {
		const served = servedGeoEntry({ ...entry, sources: ['junk'] }, 'edit');
		expect(served).not.toHaveProperty('sources');
	});

	test('an entry with neither key is returned as the SAME object; the argument is never mutated', () => {
		const plain = { id: 1, lat: 1, lon: 2 };
		expect(servedGeoEntry(plain, 'edit')).toBe(plain);
		expect(servedGeoEntry('junk', 'edit')).toBe('junk');
		const before = JSON.stringify(entry);
		servedGeoEntry(entry, 'list');
		servedGeoEntry(entry, 'edit');
		expect(JSON.stringify(entry)).toBe(before);
	});
});

describe('the real read and the real save echo serve a restored legend clean', () => {
	const created: number[] = [];
	const wireContext: ApiRequestContext = {
		requestId: 'test',
		clientIp: '127.0.0.1',
		session: {
			userId: USER_ID,
			username: 'root',
			isGlobalAdmin: true,
			csrfToken: 'tok',
			applicationLang: null,
			dataLang: null,
		},
		csrfCandidate: 'tok',
		principal: ROOT,
	};
	let host = 0;

	beforeAll(async () => {
		await assertTestDatabase('geo_contract_guards_native');
		host = await createSectionRecord(SECTION, USER_ID);
		created.push(host);
		// Written STRAIGHT into the column — the way a restore / revert / archive restore writes it,
		// past the save gate: a legend with an svg icon and a pixel bomb, a source, and a source whose
		// attribution is markup (the field Leaflet's attribution control would render as HTML).
		const dirty = [
			{
				id: 1,
				lat: 41.38,
				lon: 2.17,
				zoom: 12,
				alt: 16,
				sources: [
					{
						id: 2,
						type: 'xyz',
						url: 'https://tiles.example.org/{z}/{x}/{y}.png',
						params: {},
						attribution: 'Example Org',
					},
					{
						id: 3,
						type: 'xyz',
						url: 'https://other.example.org/{z}/{x}/{y}.png',
						params: {},
						attribution: '<img src=x onerror=alert(1)>',
					},
				],
				legend: legend([
					{ label: 'danger', icon: SVG_URI },
					{ label: 'fine', icon: PNG_URI },
					{ label: 'bomb', icon: pngUri(16_000, 16_000) },
				]),
			},
		];
		await sql.unsafe(
			`UPDATE ${TABLE}
			 SET geo = jsonb_build_object($3::text, $4::text::jsonb),
			     meta = COALESCE(meta, '{}'::jsonb) || jsonb_build_object($3::text, '[{"count": 3}]'::jsonb)
			 WHERE section_tipo = $1 AND section_id = $2`,
			[SECTION, host, GEO, JSON.stringify(dirty)],
		);
	}, 30000);

	afterAll(async () => {
		for (const id of created) await cleanScratchRecord(SECTION, id, TABLE);
	});

	async function readEntries(mode: 'list' | 'edit'): Promise<Record<string, unknown>[]> {
		const response = await dispatchRqo(
			{
				action: 'read',
				dd_api: 'dd_core_api',
				prevent_lock: true,
				options: {},
				source: {
					typo: 'source',
					model: 'section',
					tipo: SECTION,
					section_tipo: SECTION,
					action: 'search',
					mode,
					lang: 'lg-spa',
				},
				sqo: {
					section_tipo: [SECTION],
					limit: 1,
					offset: 0,
					filter_by_locators: [{ section_tipo: SECTION, section_id: String(host) }],
				},
				show: { ddo_map: [{ tipo: GEO, section_tipo: SECTION, parent: SECTION, mode }] },
			} as unknown as Rqo,
			wireContext,
		);
		expect(response.status, mode).toBe(200);
		const data = (response.body as { data?: { data?: unknown[] } }).data?.data ?? [];
		const item = data.find(
			(candidate) =>
				(candidate as { tipo?: string }).tipo === GEO &&
				String((candidate as { section_id?: unknown }).section_id) === String(host),
		) as { entries?: Record<string, unknown>[] } | undefined;
		expect(item, `${mode}: the geolocation item was not emitted`).toBeDefined();
		return item?.entries ?? [];
	}

	test('edit: the svg icon and the pixel bomb are not on the wire, the symbols and the png are', async () => {
		const [entry] = await readEntries('edit');
		expect(entry).toBeDefined();
		const text = JSON.stringify(entry);
		expect(text).not.toContain('svg+xml');
		expect(text).not.toContain('alert(1)');
		const symbols = (entry?.legend as { groups: { symbols: { label: string; icon?: string }[] }[] })
			.groups[0]?.symbols;
		expect(symbols?.map((symbol) => symbol.label)).toEqual(['danger', 'fine', 'bomb']);
		expect(symbols?.map((symbol) => symbol.icon)).toEqual([undefined, PNG_URI, undefined]);
		// the view is untouched
		expect(entry).toMatchObject({ lat: 41.38, lon: 2.17, zoom: 12, alt: 16 });
	}, 30000);

	test('edit: both stored sources are served, the markup attribution blank', async () => {
		const [entry] = await readEntries('edit');
		const sources = entry?.sources as { id: number; url: string; attribution: string }[];
		expect(sources.map((source) => source.id)).toEqual([2, 3]);
		expect(sources.map((source) => source.attribution)).toEqual(['Example Org', '']);
		// nothing but the attribution is touched
		expect(sources[1]?.url).toBe('https://other.example.org/{z}/{x}/{y}.png');
		expect(JSON.stringify(entry)).not.toContain('onerror');
	}, 30000);

	test('list: the row carries the view and the features, no map definition', async () => {
		const [entry] = await readEntries('list');
		expect(entry).toMatchObject({ lat: 41.38, lon: 2.17 });
		expect(entry).not.toHaveProperty('sources');
		expect(entry).not.toHaveProperty('legend');
	}, 30000);

	const saveEntry = (value: unknown) =>
		dispatchRqo(
			{
				action: 'save',
				dd_api: 'dd_core_api',
				source: {
					type: 'component',
					tipo: GEO,
					section_tipo: SECTION,
					section_id: host,
					lang: 'lg-nolan',
				},
				data: { changed_data: [{ action: 'update', key: 0, id: 1, value }] },
			} as unknown as Rqo,
			wireContext,
		);

	const storedGeo = async (): Promise<Record<string, unknown>[]> => {
		const rows = (await sql.unsafe(
			`SELECT geo->$3 AS value FROM ${TABLE} WHERE section_tipo = $1 AND section_id = $2`,
			[SECTION, host, GEO],
		)) as { value: Record<string, unknown>[] }[];
		return rows[0]?.value ?? [];
	};

	test('the save echo of the stored bytes (the gate TRUSTS an unchanged legend) is served clean too', async () => {
		// a non-client writer re-sends the stored bytes, svg icon and all: the gate lets an
		// unchanged legend through, so the sink-side door is what keeps the icon off the wire
		const [bytes] = await storedGeo();
		expect(JSON.stringify(bytes)).toContain('svg+xml');
		expect(JSON.stringify(bytes)).toContain('onerror');
		const response = await saveEntry(bytes);
		expect(response.status).toBe(200);
		expect(JSON.stringify(response.body)).not.toContain('svg+xml');
		expect(JSON.stringify(response.body)).not.toContain('onerror');
	}, 30000);

	test("the client's write-back of the clean legend and sources HEALS the stored ones (REPLACE semantics)", async () => {
		const [clean] = await readEntries('edit');
		expect((await saveEntry(clean)).status).toBe(200);
		const healed = JSON.stringify(await storedGeo());
		expect(healed).not.toContain('svg+xml');
		expect(healed).not.toContain('onerror');
		// the source survived the heal under the same ids, only its attribution is gone
		const [entry] = await storedGeo();
		expect((entry?.sources as { id: number }[]).map((source) => source.id)).toEqual([2, 3]);
	}, 30000);
});

// ---------------------------------------------------------------------------
// 2. THE CLIENT SINK
// ---------------------------------------------------------------------------

/**
 * The escapers as the client declares them: the canonical import and a delegating
 * wrapper (the scan trusts an escaper by what it IS, so a snippet without them has none).
 */
const ESCAPER_PRELUDE =
	"import { escape_html } from '../../common/js/utils/render_escape.js'\n" +
	"const escape_markup = function(text) { return escape_html(String(text ?? '')) }\n";

/** `code` as the body of a function, so a statement list parses, after the client's escapers. */
const inFunction = (code: string): string => `${ESCAPER_PRELUDE}function f(){\n${code}\n}`;

/** The top-level `const <name> = <function>` of `source`, as source text (parsed, not grepped). */
function topLevelFunctionSource(source: string, name: string): string {
	const program = parse(source, { sourceType: 'module' }).program;
	for (const statement of program.body) {
		const declaration =
			statement.type === 'ExportNamedDeclaration' ? statement.declaration : statement;
		if (declaration?.type !== 'VariableDeclaration') continue;
		for (const declarator of declaration.declarations) {
			if (declarator.id.type === 'Identifier' && declarator.id.name === name && declarator.init) {
				return source.slice(declarator.init.start ?? 0, declarator.init.end ?? 0);
			}
		}
	}
	throw new Error(`no top-level const ${name}`);
}

describe('the geolocation client never feeds a legend or a source to an HTML sink', () => {
	const CLIENT_DIR = join(ROOT_DIR, 'client', 'dedalo', 'core', 'component_geolocation', 'js');
	const files = readdirSync(CLIENT_DIR).filter((name) => name.endsWith('.js'));

	test('the corpus is real (a scan of nothing proves nothing)', () => {
		expect(files.length).toBeGreaterThanOrEqual(7);
		expect(files).toContain('component_geolocation.js');
		// the file that holds the map definition is scanned and parsed, not skipped
		const source = readFileSync(join(CLIENT_DIR, 'component_geolocation.js'), 'utf8');
		expect(htmlSinksOnMapDefinition(source)).toEqual([]);
		expect(taintedNamesIn(source).length).toBeGreaterThan(0);
	});

	// Each shape the scan exists to catch. The first four are the shapes the previous
	// one-line spelling check caught; the rest are the ones it MISSED.
	const MUST_FLAG: Record<string, string> = {
		'innerHTML = a legend value': 'node.innerHTML = symbol.label',
		'insertAdjacentHTML with an icon in markup':
			'legend_node.insertAdjacentHTML(\'beforeend\', `<img src="${symbol.icon}">`)',
		'outerHTML = an attribution': 'popup.outerHTML = source.attribution',
		'document.write': 'document.write(legend.title)',
		"the project's own sink, create_dom_element inner_html":
			"ui.create_dom_element({ element_type: 'div', inner_html: legend.title })",
		'inner_html across lines':
			"ui.create_dom_element({\n\telement_type: 'div',\n\tclass_name: 'row',\n\tinner_html: symbol.label\n})",
		'a markup string built first, a sink second (two lines)':
			'const html = `<img src="${symbol.icon}">`;\nrow.innerHTML = html',
		'a plain value hopped through a variable': 'const text = symbol.label;\nrow.innerHTML = text',
		'a value hopped through two variables':
			'const first = legend.title;\nconst second = first;\nrow.insertAdjacentHTML("beforeend", second)',
		'string concatenation into markup': 'const html = "<b>" + legend.title + "</b>"',
		'a Leaflet popup': 'marker.bindPopup(`<b>${symbol.label}</b>`)',
		'a Leaflet popup fed the bare value': 'marker.bindPopup(symbol.label)',
		'a Leaflet divIcon': 'L.divIcon({ html: `<img src="${symbol.icon}">` })',
		"jQuery's html()": '$(node).html(legend.title)',
		'a callback parameter of a legend call':
			'legend.groups.forEach((group) => { row.innerHTML = group.name })',
		'an arrow with an expression body':
			'const rows = legend.groups.map((group) => `<li>${group.name}</li>`)',
		'a for...of variable over symbols':
			'for (const item of group.symbols) { li.insertAdjacentHTML("beforeend", item.label) }',
		'a destructured value': 'const { label } = symbol;\nrow.innerHTML = label',
		createContextualFragment: 'frag = range.createContextualFragment(legend.title)',
		srcdoc: 'frame.srcdoc = legend.title',
		parseFromString: 'const doc = new DOMParser().parseFromString(legend.title, "text/html")',
		'setContent on a popup': 'popup.setContent(symbol.label)',
		// Leaflet's ARGUMENT sinks: the layer control's name, the attribution control's text
		'an unescaped data-fed addOverlay name':
			'const entries = self.get_source_entries(key);\nfor (const entry of entries) { control.addOverlay(layer, entry.name) }',
		'addBaseLayer fed a source value': 'control.addBaseLayer(layer, source.attribution)',
		'addAttribution fed a source value':
			'map.attributionControl.addAttribution(source.attribution)',
		'setPrefix fed a legend value': 'map.attributionControl.setPrefix(legend.title)',
		'a layers-control name key from a source': 'L.control.layers({ [source.name]: layer })',
		'a layers-control overlays map built from sources':
			'const overlays = build(sources);\nL.control.layers({}, overlays)',
		'an escaper around only PART of the name':
			'control.addOverlay(layer, escape_markup(source.kind) + source.name)',
		// escaping is for the ARGUMENT sinks only: an escaped legend is still markup in a general sink
		'innerHTML = an ESCAPED legend value': 'node.innerHTML = escape_markup(legend.title)',
		// optional chaining is the same member, the same call
		'optional member on a general sink': "node?.insertAdjacentHTML('beforeend', legend.title)",
		'optional member on a Leaflet popup': 'marker?.bindPopup(symbol.label)',
		'optional member on an argument sink': 'control?.addOverlay(layer, legend.title)',
		'optional call of an argument sink': 'control.addOverlay?.(layer, legend.title)',
		'optional computed member': "node?.['insertAdjacentHTML']('beforeend', legend.title)",
		// a computed key that is a literal is the same member
		'a computed string-literal key': "control['addOverlay'](layer, legend.title)",
		'a computed template key': 'control[`addBaseLayer`](layer, source.name)',
		'a computed literal on a general sink': "node['innerHTML'] = symbol.label",
		// spreads at or before the written position
		'a spread of an array literal': 'control.addOverlay(...[layer, legend.title])',
		'a spread of a tainted list before the written position':
			'const parts = [layer, legend.title];\ncontrol.addOverlay(...parts)',
		'a spread AT the written position': 'control.addOverlay(layer, ...legend.names)',
		// Function.prototype forms: positions shifted by the this-argument
		'.call on an argument sink': 'control.addOverlay.call(control, layer, legend.title)',
		'.apply on an argument sink': 'control.addOverlay.apply(control, [layer, legend.title])',
		'.apply with a tainted list':
			'const args = [layer, source.name];\ncontrol.addOverlay.apply(control, args)',
		'.bind with the written argument bound':
			'control.addOverlay.bind(control, layer, legend.title)',
		'a .bind alias': 'const add = control.addOverlay.bind(control);\nadd(layer, legend.title)',
		'a .bind alias that bound the layer':
			'const add = control.addOverlay.bind(control, layer);\nadd(legend.title)',
		'a plain alias of an argument sink':
			'const add = control.addOverlay;\nadd(layer, legend.title)',
		'a destructured alias': 'const { addOverlay: add } = control;\nadd(layer, symbol.label)',
		'an alias of an alias':
			'const a = control.addOverlay.bind(control);\nconst b = a;\nb(layer, legend.title)',
		'a .bind alias of a general sink':
			'const pop = marker.bindPopup.bind(marker);\npop(symbol.label)',
		'.call on a general sink': 'marker.bindPopup.call(marker, symbol.label)',
		// the layers control however it is constructed
		'new L.Control.Layers with a source key': 'new L.Control.Layers({ [source.name]: layer })',
		'new L.Control.Layers overlays from sources':
			'const overlays = build(sources);\nnew L.Control.Layers({}, overlays)',
		'L.control?.layers with a source key': 'L.control?.layers({}, { [legend.title]: layer })',
		// taint through destructuring assignment and stored properties
		'a destructuring assignment': 'let t;\n({ title: t } = legend);\ncontrol.addOverlay(layer, t)',
		'an array destructuring assignment': 'let a, b;\n[a, b] = legend.names;\nrow.innerHTML = b',
		'a value stored on this first':
			'this.label = legend.title;\ncontrol.addOverlay(layer, this.label)',
		'a value stored on self (= this) in another prototype method':
			'const self = this;\nself.label = legend.title;\n}\nfunction g(){\nconst self = this;\ncontrol.addOverlay(layer, self.label)',
		'a value stored on an object property first':
			'const o = {};\no.label = legend.title;\ncontrol.addOverlay(layer, o.label)',
		'a value stored on a nested property first':
			'const o = { a: {} };\no.a.label = symbol.label;\nrow.innerHTML = o.a.label',
		'a class field':
			'class A { label = legend.title; m() { control.addOverlay(layer, this.label) } }',
		'a private class field':
			'class A { #label = legend.title; m() { node.innerHTML = this.#label } }',
		// an escaper is trusted by what it is, never by its name
		'a local escaper that escapes nothing (shadows the trusted one)':
			'const escape_markup = (v) => v;\ncontrol.addOverlay(layer, escape_markup(legend.title))',
		'an escaper parameter (shadows the trusted one)':
			'const h = (escape_html) => control.addOverlay(layer, escape_html(legend.title))',
		'an escaper reassigned':
			'escape_markup = (v) => v;\ncontrol.addOverlay(layer, escape_markup(legend.title))',
		'an escaped value un-escaped by a member call':
			"control.addOverlay(layer, escape_markup(legend.title).replaceAll('&lt;', '<'))",
		'an escaped value passed through another call':
			'control.addOverlay(layer, unescape(escape_markup(legend.title)))',
	};

	test('POSITIVE CONTROL: the scan flags every shape it exists to catch', () => {
		for (const [name, code] of Object.entries(MUST_FLAG)) {
			expect(htmlSinksOnMapDefinition(inFunction(code)).length, name).toBeGreaterThan(0);
		}
	});

	// What it must NOT flag: the sanctioned destinations, comments, and unrelated values.
	const MUST_PASS: Record<string, string> = {
		'a line comment': '// node.innerHTML = legend.title',
		'a block comment': '/* node.innerHTML = legend.title */',
		'a sink fed a coordinate': 'node.innerHTML = coordinates.join(", ")',
		'an icon as the src of an img': 'img.src = symbol.icon',
		'a label as text': 'span.textContent = symbol.label',
		'a label as a text node': 'span.appendChild(document.createTextNode(symbol.label))',
		'create_dom_element text_content':
			"ui.create_dom_element({ element_type: 'span', text_content: legend.title })",
		'create_dom_element inner_html from a label that is not a map value':
			"ui.create_dom_element({ element_type: 'label', inner_html: get_label.latitude })",
		'the sanctioned attribution sink (plain text by the server: save and serve)':
			'L.tileLayer(url, { attribution: source.attribution })',
		'a bare less-than in a string': 'const note = "a < b"; x.textContent = note + symbol.label',
		'a sink in a function that never sees the map definition':
			'function other(node, value) { node.innerHTML = value }\nlegend.title = "x"',
		'an escaped addOverlay name (the client’s shape), a data-fed layer beside it':
			'const layer = self.get_source_layer(entry);\ncontrol.addOverlay(layer, escape_markup(entry.name))',
		'an escape_html addBaseLayer name': 'control.addBaseLayer(layer, escape_html(source.label))',
		'a layers control of constant names': 'L.control.layers({ osm: osm_layer, arcgis: layer })',
		'an addOverlay named by a drawing layer id':
			'control.addOverlay(self.FeatureGroup[layer_id], layer_id)',
		'a name tainted in ANOTHER function is not tainted here':
			'function a() { const value = legend.title; }\nfunction b(value) { node.innerHTML = value }',
		'an optional addOverlay with an escaped name':
			'control?.addOverlay?.(layer, escape_markup(legend.title))',
		'a .call whose WRITTEN argument is constant':
			"control.addOverlay.call(control, legend_layer, 'Drawing')",
		'a .bind alias fed an escaped name':
			'const add = control.addOverlay.bind(control);\nadd(source_layer, escape_markup(source.name))',
		'a wholly escaped concatenation and template':
			"control.addOverlay(layer, escape_markup(a.kind) + ': ' + escape_markup(source.name));\ncontrol.addBaseLayer(layer, `${escape_html(source.label)} (map)`)",
		'a conditional of escaped names':
			"control.addOverlay(layer, on ? escape_markup(source.name) : '')",
		'a this property never fed a map value':
			"this.label = 'Drawing';\ncontrol.addOverlay(layer, this.label)",
	};

	test('NEGATIVE CONTROL: the sanctioned shapes, comments and unrelated values are not flagged', () => {
		for (const [name, code] of Object.entries(MUST_PASS)) {
			expect(htmlSinksOnMapDefinition(inFunction(code)), name).toEqual([]);
		}
	});

	test('an escaper is trusted by WHAT IT IS: imported from render_escape.js, or delegating to one', () => {
		const sink = '\nfunction f(){ control.addOverlay(layer, escape_html(legend.title)) }';
		expect(
			htmlSinksOnMapDefinition(
				`import { escape_html } from '../../common/js/utils/render_escape.js'${sink}`,
			),
		).toEqual([]);
		// the same name from another module, or with no import at all, is no escaper
		expect(
			htmlSinksOnMapDefinition(`import { escape_html } from './my_escape.js'${sink}`).length,
		).toBeGreaterThan(0);
		expect(htmlSinksOnMapDefinition(sink).length).toBeGreaterThan(0);
		// a wrapper that returns MORE than the escaper of its parameter is no escaper
		const wrapper =
			"import { escape_html } from '../../common/js/utils/render_escape.js'\n" +
			"const escape_markup = (v) => escape_html(v).replaceAll('&lt;', '<')\n" +
			'function f(){ control.addOverlay(layer, escape_markup(legend.title)) }';
		expect(trustedEscapersIn(wrapper)).toEqual(['escape_html']);
		expect(htmlSinksOnMapDefinition(wrapper).length).toBeGreaterThan(0);
	});

	test("the client's escape_markup DELEGATES to render_escape.js's escape_html (evaluated, not grepped)", () => {
		const client = readFileSync(join(CLIENT_DIR, 'component_geolocation.js'), 'utf8');
		const escaperModule = readFileSync(
			join(ROOT_DIR, 'client', 'dedalo', 'core', 'common', 'js', 'utils', 'render_escape.js'),
			'utf8',
		);
		// the scan's verdict: the canonical import and the wrapper are both trusted in the real file
		expect(trustedEscapersIn(client)).toEqual(['escape_html', 'escape_markup']);
		// the bytes themselves, run: the real escape_html, the real escape_markup bound to it
		type Escaper = (value: unknown) => string;
		const escapeHtml = new Function(
			`return (${topLevelFunctionSource(escaperModule, 'escape_html')})`,
		)() as Escaper;
		const markupSource = topLevelFunctionSource(client, 'escape_markup');
		const bind = (impl: Escaper): Escaper =>
			new Function('escape_html', `return (${markupSource})`)(impl) as Escaper;
		const escapeMarkup = bind(escapeHtml);
		expect(escapeMarkup(`<img src=x onerror="a('b')">&`)).toBe(
			'&lt;img src=x onerror=&quot;a(&#39;b&#39;)&quot;&gt;&amp;',
		);
		expect(escapeMarkup(null)).toBe('');
		expect(escapeMarkup(undefined)).toBe('');
		// delegation: what it returns IS escape_html's answer for the stringified value
		const seen: unknown[] = [];
		const spied = bind((value) => {
			seen.push(value);
			return 'ESCAPED';
		});
		expect(spied(42)).toBe('ESCAPED');
		expect(seen).toEqual(['42']);
	});

	test('a source that does not parse THROWS (a file the scan cannot read is a file outside the gate)', () => {
		expect(() => htmlSinksOnMapDefinition('function (')).toThrow();
	});

	test('no geolocation client file hands a legend, source, symbol, icon or attribution to a sink', () => {
		for (const name of files) {
			const offending = htmlSinksOnMapDefinition(readFileSync(join(CLIENT_DIR, name), 'utf8'));
			expect(offending, name).toEqual([]);
		}
	});
});

// ---------------------------------------------------------------------------
// 3. THE HEADERS
// ---------------------------------------------------------------------------

describe('a header that names a gate names a file that exists', () => {
	const GEO_DIR = join(ROOT_DIR, 'src', 'core', 'geo');
	const headered = [
		...readdirSync(GEO_DIR).map((name) => join(GEO_DIR, name)),
		join(ROOT_DIR, 'src', 'core', 'section', 'record', 'append_merge.ts'),
		join(ROOT_DIR, 'src', 'core', 'section', 'record', 'item_gates.ts'),
		join(ROOT_DIR, 'src', 'core', 'components', 'component_geolocation', 'emit.ts'),
	].filter((path) => path.endsWith('.ts'));

	/** Every `test/unit/<name>.test.ts` a source mentions. */
	const cited = (path: string): string[] =>
		[...readFileSync(path, 'utf8').matchAll(/test\/unit\/[A-Za-z0-9_]+\.test\.ts/g)].map(
			(match) => match[0],
		);

	test('the corpus is real and cites something', () => {
		expect(headered.length).toBeGreaterThanOrEqual(10);
		expect(headered.flatMap(cited).length).toBeGreaterThan(5);
	});

	test('every cited test file exists', () => {
		for (const path of headered) {
			for (const gate of cited(path)) {
				expect(existsSync(join(ROOT_DIR, gate)), `${path} cites ${gate}`).toBe(true);
			}
		}
	});
});
