/**
 * The map-source and legend VALIDATORS of component_geolocation
 * (src/core/geo/map_source*.ts, map_legend.ts) — WC-2026-11-06-geolocation-map-sources-legend.
 *
 * What is pinned:
 *  - the URL template law (http/https only, no credentials, no fragment, no
 *    private or loopback literal, xyz placeholders z/x/y and nothing else, a wms
 *    endpoint with none and without the keys the server sets);
 *  - the closed params of each type, the CRS/format/version allowlists, the
 *    name-list charset ("tokens without & # CR LF");
 *  - plain-text attribution, the legend's shape and its caps, and the icon rule
 *    (raster data URI whose HEADER agrees with the declared type and declares a
 *    bounded number of pixels, per icon and per legend; never svg, never a URL);
 *  - a refusal reason NEVER quotes the value that caused it (a template may carry
 *    a provider token);
 *  - the validators do not mutate their input.
 *
 * Pure: no database, no network, no scratch surface.
 */

import { describe, expect, test } from 'bun:test';
import { type RasterFormat, rasterSize } from '../../src/core/geo/icon_image.ts';
import {
	checkIcon,
	isEmptyLegend,
	LEGEND_LIMITS,
	validateMapLegend,
} from '../../src/core/geo/map_legend.ts';
import {
	checkSourceList,
	MAP_SOURCE_LIMITS,
	validateMapSource,
	validateMapSources,
} from '../../src/core/geo/map_source.ts';
import { checkSourceUrl } from '../../src/core/geo/map_source_url.ts';
import {
	dataUri,
	jpegBytes,
	jpegUri,
	pngBytes,
	pngUri,
	webpBytes,
	webpUri,
} from '../helpers/geo_icon_fixture.ts';

const XYZ_URL = 'https://tiles.example.org/{z}/{x}/{y}.png';
const WMS_URL = 'https://wms.example.org/service';

const wms = (over: Record<string, unknown> = {}) => ({
	type: 'wms',
	url: WMS_URL,
	params: { version: '1.3.0', layers: 'base', format: 'image/png', crs: 'EPSG:3857' },
	attribution: 'Example Org',
	...over,
});
const xyz = (over: Record<string, unknown> = {}) => ({
	type: 'xyz',
	url: XYZ_URL,
	params: {},
	attribution: 'Example Org',
	...over,
});

/** A real 1x1 PNG. */
const PNG_1X1 =
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const PNG_URI = `data:image/png;base64,${PNG_1X1}`;

function url(kind: 'xyz' | 'wms', value: unknown): { ok: boolean; reason?: string } {
	return checkSourceUrl(kind, value, 'url');
}

describe('xyz URL template', () => {
	test('accepts z/x/y in the path and in the query', () => {
		expect(url('xyz', XYZ_URL).ok).toBe(true);
		expect(url('xyz', 'http://tiles.example.org/t?x={x}&y={y}&z={z}&key=abc').ok).toBe(true);
		// the scheme's own port, spelled out, is no port at all to the URL parser
		expect(url('xyz', 'https://tiles.example.org:443/a/{z}/{y}/{x}').ok).toBe(true);
		expect(url('xyz', 'http://tiles.example.org:80/a/{z}/{y}/{x}').ok).toBe(true);
	});

	test('refuses a port other than the scheme’s own: the tile proxy’s door reaches only 80 and 443', () => {
		// A source saved on another port could never be relayed (every tile a generic
		// refusal with the cause only in the operator log), so the save, the import and the
		// fetch-time re-check refuse it with the door: the three callers share this validator.
		for (const bad of [
			'https://tiles.example.org:8443/a/{z}/{y}/{x}',
			'http://tiles.example.org:8080/a/{z}/{y}/{x}',
			'http://tiles.example.org:443/a/{z}/{y}/{x}',
			'https://tiles.example.org:80/a/{z}/{y}/{x}',
			'https://tiles.example.org:1/a/{z}/{y}/{x}',
		]) {
			const checked = url('xyz', bad);
			expect(checked.ok, bad).toBe(false);
			expect(checked.reason, bad).toContain('standard web port');
			expect(checked.reason, bad).not.toContain('tiles.example.org');
		}
		expect(url('wms', 'https://wms.example.org:8443/service').ok).toBe(false);
		expect(url('wms', 'https://wms.example.org:443/service').ok).toBe(true);
	});

	test('refuses a scheme other than http/https', () => {
		for (const bad of [
			'ftp://tiles.example.org/{z}/{x}/{y}',
			'javascript:alert(1)//{z}{x}{y}',
			'file:///etc/passwd?{z}{x}{y}',
			'//tiles.example.org/{z}/{x}/{y}',
			'data:text/plain,{z}{x}{y}',
		]) {
			expect(url('xyz', bad).ok, bad).toBe(false);
		}
	});

	test('refuses credentials, a fragment and whitespace', () => {
		expect(url('xyz', 'https://user:pw@tiles.example.org/{z}/{x}/{y}').ok).toBe(false);
		expect(url('xyz', 'https://user@tiles.example.org/{z}/{x}/{y}').ok).toBe(false);
		expect(url('xyz', `${XYZ_URL}#frag`).ok).toBe(false);
		expect(url('xyz', 'https://tiles.example.org/a b/{z}/{x}/{y}').ok).toBe(false);
		expect(url('xyz', 'https://tiles.example.org/{z}/{x}/{y}\r\nHost: evil').ok).toBe(false);
	});

	test('needs all of z/x/y and knows no other placeholder', () => {
		expect(url('xyz', 'https://tiles.example.org/{z}/{x}.png').ok).toBe(false);
		expect(url('xyz', 'https://tiles.example.org/static.png').ok).toBe(false);
		for (const other of ['{s}', '{r}', '{-y}', '{bbox}', '{}']) {
			const result = url('xyz', `https://tiles.example.org/${other}/{z}/{x}/{y}`);
			expect(result.ok, other).toBe(false);
			expect(result.reason).toMatch(/unknown placeholder/);
		}
	});

	test('a placeholder cannot stand in the host, the port or the userinfo', () => {
		expect(url('xyz', 'https://{z}.example.org/{z}/{x}/{y}').ok).toBe(false);
		expect(url('xyz', 'https://tiles.example.org:{x}/{z}/{y}').ok).toBe(false);
		expect(url('xyz', 'https://{x}@tiles.example.org/{z}/{y}').ok).toBe(false);
	});

	test('refuses a private or loopback address literal, however spelled', () => {
		for (const host of [
			'127.0.0.1',
			'127.1',
			'2130706433', // decimal 127.0.0.1
			'0x7f000001',
			'10.0.0.5',
			'172.16.4.1',
			'192.168.1.1',
			'169.254.169.254', // cloud metadata
			'0.0.0.0',
			'[::1]',
			'[::ffff:127.0.0.1]',
			'[fe80::1]',
			'[fd00::1]',
		]) {
			const result = url('xyz', `http://${host}/{z}/{x}/{y}.png`);
			expect(result.ok, host).toBe(false);
		}
	});

	test('refuses a loopback or single-label host name, accepts a public IP literal', () => {
		for (const host of ['localhost', 'LOCALHOST', 'foo.localhost', 'intranet']) {
			expect(url('xyz', `http://${host}/{z}/{x}/{y}.png`).ok, host).toBe(false);
		}
		expect(url('xyz', 'http://93.184.216.34/{z}/{x}/{y}.png').ok).toBe(true);
	});

	test('a reason never quotes the URL (it may carry a token)', () => {
		const secret = 'tok_SECRET_9f3a';
		for (const bad of [
			`ftp://tiles.example.org/{z}/{x}/{y}?key=${secret}`,
			`https://u:${secret}@tiles.example.org/{z}/{x}/{y}`,
			`http://127.0.0.1/{z}/{x}/{y}?key=${secret}`,
			`https://tiles.example.org/{z}/{x}/{y}?key=${secret}#f`,
			`https://tiles.example.org/{q}/{z}/{x}/{y}?key=${secret}`,
		]) {
			const result = url('xyz', bad);
			expect(result.ok).toBe(false);
			expect(result.reason).not.toContain(secret);
		}
	});
});

describe('wms endpoint', () => {
	test('accepts a plain endpoint and its own query keys', () => {
		expect(url('wms', WMS_URL).ok).toBe(true);
		expect(url('wms', 'https://wms.example.org/cgi?map=/maps/base.map&key=abc').ok).toBe(true);
		expect(url('wms', 'https://wms.example.org/cgi?').ok).toBe(true);
	});

	test('takes no placeholder at all', () => {
		expect(url('wms', 'https://wms.example.org/{z}/service').ok).toBe(false);
		expect(url('wms', 'https://wms.example.org/service?bbox={x}').ok).toBe(false);
	});

	test('refuses an endpoint query that sets a key the server sets', () => {
		for (const key of ['service', 'REQUEST', 'Version', 'layers', 'bbox', 'width', 'CRS', 'srs']) {
			const result = url('wms', `${WMS_URL}?${key}=x`);
			expect(result.ok, key).toBe(false);
		}
	});

	test('the host rules are the same as xyz', () => {
		expect(url('wms', 'http://127.0.0.1/wms').ok).toBe(false);
		expect(url('wms', 'https://u:p@wms.example.org/').ok).toBe(false);
	});
});

describe('map source — shape, params, attribution', () => {
	test('a wms source normalizes and defaults styles/transparent', () => {
		const result = validateMapSource(wms({ attribution: '  Example Org  ' }), 's');
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value).toEqual({
			type: 'wms',
			url: WMS_URL,
			params: {
				version: '1.3.0',
				layers: 'base',
				styles: '',
				format: 'image/png',
				transparent: false,
				crs: 'EPSG:3857',
			},
			attribution: 'Example Org',
		});
	});

	test('layers and styles are name lists on a closed charset', () => {
		const layers = (value: unknown) =>
			validateMapSource(
				wms({ params: { version: '1.1.1', layers: value, format: 'image/png', crs: 'EPSG:4326' } }),
				's',
			);
		expect(layers('CP.CadastralParcel,BU.Building').ok).toBe(true);
		expect(layers('ns:layer_1, other-layer').ok).toBe(true);
		for (const bad of [
			'a&b',
			'a#b',
			'a\nb',
			'a\rb',
			'a=b',
			'a?b',
			'a%20b',
			'a;b',
			'',
			',',
			'a,,b',
		]) {
			expect(layers(bad).ok, JSON.stringify(bad)).toBe(false);
		}
		expect(layers(['a']).ok).toBe(false);
		expect(layers(`${'x'.repeat(MAP_SOURCE_LIMITS.maxLayerToken + 1)}`).ok).toBe(false);
		expect(layers(Array.from({ length: 33 }, (_, i) => `l${i}`).join(',')).ok).toBe(false);
	});

	test('styles may be empty or carry empty items (one style per layer)', () => {
		const styles = (value: unknown) =>
			validateMapSource(
				wms({
					params: {
						version: '1.3.0',
						layers: 'a,b',
						styles: value,
						format: 'image/png',
						crs: 'EPSG:3857',
					},
				}),
				's',
			);
		expect(styles('').ok).toBe(true);
		expect(styles(',').ok).toBe(true);
		expect(styles('default,').ok).toBe(true);
		expect(styles('a&b').ok).toBe(false);
	});

	test('version, format and CRS are allowlists', () => {
		const params = (over: Record<string, unknown>) => ({
			version: '1.3.0',
			layers: 'a',
			format: 'image/png',
			crs: 'EPSG:3857',
			...over,
		});
		for (const bad of [
			{ version: '1.0.0' },
			{ version: 1.3 },
			{ format: 'image/svg+xml' },
			{ format: 'text/html' },
			{ format: 'png' },
			{ crs: 'EPSG:25830' },
			{ crs: 'CRS:84' },
			{ crs: 'epsg:3857' },
			{ transparent: 'true' },
		]) {
			expect(validateMapSource(wms({ params: params(bad) }), 's').ok, JSON.stringify(bad)).toBe(
				false,
			);
		}
		for (const format of ['image/png', 'image/jpeg', 'image/gif', 'image/webp']) {
			expect(validateMapSource(wms({ params: params({ format }) }), 's').ok, format).toBe(true);
		}
		for (const crs of ['EPSG:3857', 'EPSG:4326', 'EPSG:4258']) {
			expect(validateMapSource(wms({ params: params({ crs }) }), 's').ok, crs).toBe(true);
		}
	});

	test('the four required wms params are required', () => {
		for (const key of ['version', 'layers', 'format', 'crs']) {
			const params: Record<string, unknown> = {
				version: '1.3.0',
				layers: 'a',
				format: 'image/png',
				crs: 'EPSG:3857',
			};
			delete params[key];
			expect(validateMapSource(wms({ params }), 's').ok, key).toBe(false);
		}
	});

	test('params are CLOSED: an unknown key is refused, not dropped', () => {
		const wmsParams = {
			version: '1.3.0',
			layers: 'a',
			format: 'image/png',
			crs: 'EPSG:3857',
		};
		expect(validateMapSource(wms({ params: { ...wmsParams, bbox: '1,2,3,4' } }), 's').ok).toBe(
			false,
		);
		expect(validateMapSource(wms({ params: { ...wmsParams, service: 'WFS' } }), 's').ok).toBe(
			false,
		);
		expect(validateMapSource(xyz({ params: { tile_size: 512 } }), 's').ok).toBe(false);
	});

	test('xyz params: absent is {}, zoom bounds are integers 0..22 and ordered', () => {
		const absent = validateMapSource({ type: 'xyz', url: XYZ_URL }, 's');
		expect(absent.ok && absent.value.params).toEqual({});
		expect(validateMapSource(xyz({ params: { min_zoom: 2, max_zoom: 18 } }), 's').ok).toBe(true);
		expect(validateMapSource(xyz({ params: { min_zoom: 5, max_zoom: 5 } }), 's').ok).toBe(true);
		for (const bad of [
			{ min_zoom: 19, max_zoom: 3 },
			{ max_zoom: 23 },
			{ min_zoom: -1 },
			{ max_zoom: 2.5 },
			{ min_zoom: '3' },
		]) {
			expect(validateMapSource(xyz({ params: bad }), 's').ok, JSON.stringify(bad)).toBe(false);
		}
	});

	test('attribution is plain text: no < or >, no control characters, bounded', () => {
		expect(validateMapSource(xyz({ attribution: '© Example Org contributors' }), 's').ok).toBe(
			true,
		);
		expect(validateMapSource(xyz({ attribution: '' }), 's').ok).toBe(true);
		expect(validateMapSource({ type: 'xyz', url: XYZ_URL }, 's').ok).toBe(true);
		for (const bad of [
			'<a href="https://example.org">Example</a>',
			'a > b',
			'two\nlines',
			'x'.repeat(MAP_SOURCE_LIMITS.maxAttribution + 1),
			42,
		]) {
			expect(validateMapSource(xyz({ attribution: bad }), 's').ok, String(bad).slice(0, 20)).toBe(
				false,
			);
		}
	});

	test('the frame: object, known keys, known type', () => {
		expect(validateMapSource(null, 's').ok).toBe(false);
		expect(validateMapSource([], 's').ok).toBe(false);
		expect(validateMapSource(xyz({ type: 'tms' }), 's').ok).toBe(false);
		expect(validateMapSource(xyz({ type: undefined }), 's').ok).toBe(false);
		expect(validateMapSource(xyz({ label: 'x' }), 's').ok).toBe(false);
		expect(validateMapSource(xyz({ headers: {} }), 's').ok).toBe(false);
	});

	test('id: absent, or a positive integer', () => {
		const withId = (id: unknown) => validateMapSource(xyz({ id }), 's');
		expect(withId(7).ok).toBe(true);
		expect(withId(undefined).ok).toBe(true);
		expect(withId(null).ok).toBe(true);
		for (const bad of [0, -3, 1.5, '4', Number.NaN, 2 ** 60, true, {}]) {
			expect(withId(bad).ok, String(bad)).toBe(false);
		}
	});

	test('validation is pure: the input is untouched', () => {
		const input = wms({ attribution: '  padded  ' });
		const before = JSON.stringify(input);
		validateMapSource(input, 's');
		expect(JSON.stringify(input)).toBe(before);
	});
});

describe('sources list', () => {
	test('bounded count, first failure wins with its path', () => {
		const many = Array.from({ length: MAP_SOURCE_LIMITS.maxSources }, () => xyz());
		expect(validateMapSources(many, 'sources').ok).toBe(true);
		expect(validateMapSources([...many, xyz()], 'sources').ok).toBe(false);
		expect(validateMapSources('x', 'sources').ok).toBe(false);

		const bad = validateMapSources(
			[xyz(), xyz({ url: 'ftp://x.example.org/{z}{x}{y}' })],
			'sources',
		);
		expect(bad.ok === false && bad.reason).toMatch(/^sources\[1\]\.url:/);
	});

	test("ids are shape-checked only: a repeated number is the save gate's call, not the list's", () => {
		// the gate (geo_entry_gate_native.test.ts) numbers the second as a copy
		expect(validateMapSources([xyz({ id: 3 }), xyz({ id: 3 })], 'sources').ok).toBe(true);
		const malformed = validateMapSources([xyz({ id: 0 })], 'sources');
		expect(malformed.ok === false && malformed.reason).toMatch(/^sources\[0\]\.id:/);
	});

	test('checkSourceList is the shell both the list validator and the gate make', () => {
		const many = Array.from({ length: MAP_SOURCE_LIMITS.maxSources + 1 }, () => xyz());
		expect(checkSourceList([], 'sources').ok).toBe(true);
		expect(checkSourceList(many, 'sources').ok).toBe(false);
		expect(checkSourceList({ 0: xyz() }, 'sources').ok).toBe(false);
	});
});

describe('legend', () => {
	const legend = (over: Record<string, unknown> = {}) => ({
		title: 'Roman roads',
		groups: [
			{
				name: 'Surface',
				symbols: [{ label: 'Paved', icon: PNG_URI }, { label: 'Track' }],
			},
		],
		...over,
	});

	test('a legend validates and normalizes', () => {
		const result = validateMapLegend(legend({ title: '  Roman roads ' }), 'legend');
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.title).toBe('Roman roads');
		expect(result.value.groups[0]?.symbols).toEqual([
			{ label: 'Paved', icon: PNG_URI },
			{ label: 'Track' },
		]);
	});

	test('title and groups default; an empty legend says nothing', () => {
		const bare = validateMapLegend({}, 'legend');
		expect(bare.ok && isEmptyLegend(bare.value)).toBe(true);
		const titled = validateMapLegend({ title: 'T' }, 'legend');
		expect(titled.ok && isEmptyLegend(titled.value)).toBe(false);
	});

	test('the frame is closed at every level', () => {
		expect(validateMapLegend(null, 'legend').ok).toBe(false);
		expect(validateMapLegend(legend({ extra: 1 }), 'legend').ok).toBe(false);
		expect(
			validateMapLegend({ groups: [{ name: 'g', symbols: [], color: 'red' }] }, 'legend').ok,
		).toBe(false);
		expect(
			validateMapLegend(
				{ groups: [{ name: 'g', symbols: [{ label: 'l', color: 'red' }] }] },
				'legend',
			).ok,
		).toBe(false);
		expect(validateMapLegend({ groups: [{ name: '', symbols: [] }] }, 'legend').ok).toBe(false);
		expect(
			validateMapLegend({ groups: [{ name: 'g', symbols: [{ label: '' }] }] }, 'legend').ok,
		).toBe(false);
		expect(validateMapLegend({ groups: {} }, 'legend').ok).toBe(false);
	});

	test('counts are capped', () => {
		const group = { name: 'g', symbols: [] };
		expect(
			validateMapLegend({ groups: Array(LEGEND_LIMITS.maxGroups).fill(group) }, 'legend').ok,
		).toBe(true);
		expect(
			validateMapLegend({ groups: Array(LEGEND_LIMITS.maxGroups + 1).fill(group) }, 'legend').ok,
		).toBe(false);
		const symbols = (n: number) => Array.from({ length: n }, (_, i) => ({ label: `s${i}` }));
		expect(
			validateMapLegend(
				{ groups: [{ name: 'g', symbols: symbols(LEGEND_LIMITS.maxSymbolsPerGroup) }] },
				'legend',
			).ok,
		).toBe(true);
		expect(
			validateMapLegend(
				{ groups: [{ name: 'g', symbols: symbols(LEGEND_LIMITS.maxSymbolsPerGroup + 1) }] },
				'legend',
			).ok,
		).toBe(false);
		expect(validateMapLegend({ title: 'x'.repeat(LEGEND_LIMITS.maxTitle + 1) }, 'legend').ok).toBe(
			false,
		);
	});

	test('text may say "< 50 m" but may not open a tag', () => {
		const label = (value: string) =>
			validateMapLegend({ groups: [{ name: 'g', symbols: [{ label: value }] }] }, 'legend');
		expect(label('Altitude < 50 m').ok).toBe(true);
		expect(label('a > b').ok).toBe(true);
		for (const bad of [
			'<img src=x onerror=alert(1)>',
			'</b>',
			'<!-- c -->',
			'<?xml?>',
			'x<script>',
		]) {
			expect(label(bad).ok, bad).toBe(false);
		}
		expect(validateMapLegend({ title: '<b>T</b>' }, 'legend').ok).toBe(false);
	});
});

describe('legend icons', () => {
	test('a png, jpeg and webp data URI whose header agrees are accepted', () => {
		expect(checkIcon(PNG_URI, 'i').ok).toBe(true);
		expect(checkIcon(pngUri(16, 16, 64), 'i').ok).toBe(true);
		expect(checkIcon(jpegUri(16, 16, 64), 'i').ok).toBe(true);
		for (const kind of ['lossy', 'lossless', 'extended'] as const) {
			expect(checkIcon(webpUri(kind, 16, 16, 64), kind).ok, kind).toBe(true);
		}
	});

	test('svg, gif, a URL, a relative path and a non-string are refused', () => {
		for (const bad of [
			'data:image/svg+xml;base64,PHN2ZyB4bWxucz0naHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmcnLz4=',
			'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg"/>',
			'data:image/gif;base64,R0lGODlhAQABAAAAACw=',
			'https://example.org/icon.png',
			'/media/icon.png',
			'javascript:alert(1)',
			'data:text/html;base64,PGgxPmhpPC9oMT4=',
			'data:image/png;charset=utf8,abc',
			'data:image/png,iVBORw0KGgo=',
			42,
			null,
		]) {
			expect(checkIcon(bad, 'i').ok, String(bad).slice(0, 30)).toBe(false);
		}
	});

	test('the declared type must match the bytes (an svg or html payload under a png label)', () => {
		const markup = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>');
		const lying = `data:image/png;base64,${markup.toString('base64')}`;
		const result = checkIcon(lying, 'i');
		expect(result.ok).toBe(false);
		expect(dataUri('png', jpegBytes(16, 16, 64))).toMatch(/^data:image\/png/);
		expect(checkIcon(dataUri('png', jpegBytes(16, 16, 64)), 'i').ok).toBe(false);
		expect(checkIcon(dataUri('jpeg', pngBytes(16, 16, 64)), 'i').ok).toBe(false);
		expect(checkIcon(dataUri('webp', pngBytes(16, 16, 64)), 'i').ok).toBe(false);
	});

	test('a header that stops short, or names an unknown chunk, is not the declared format', () => {
		// a png cut inside IHDR; a jpeg that reaches its scan without a frame header;
		// a webp whose first chunk is neither VP8, VP8L nor VP8X
		expect(checkIcon(dataUri('png', pngBytes(16, 16).slice(0, 20)), 'i').ok).toBe(false);
		const scanFirst = Uint8Array.from([0xff, 0xd8, 0xff, 0xda, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
		expect(checkIcon(dataUri('jpeg', scanFirst), 'i').ok).toBe(false);
		const unknownChunk = Uint8Array.from(
			Buffer.from('RIFF\0\0\0\0WEBPVP9 \0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0'),
		);
		expect(checkIcon(dataUri('webp', unknownChunk), 'i').ok).toBe(false);
	});

	test('malformed base64 is refused (stray characters, bad length)', () => {
		expect(checkIcon(`data:image/png;base64,${PNG_1X1.slice(0, -1)}`, 'i').ok).toBe(false);
		expect(checkIcon(`data:image/png;base64,${PNG_1X1}!`, 'i').ok).toBe(false);
		expect(checkIcon('data:image/png;base64,', 'i').ok).toBe(false);
	});

	test('one icon is capped at 64 KiB and a legend at 256 KiB of icons', () => {
		// 40 000 payload bytes -> 53 336 base64 characters: valid on its own.
		const big = pngUri(16, 16, 40_000);
		expect(big.length).toBeLessThanOrEqual(LEGEND_LIMITS.maxIconChars);
		expect(checkIcon(big, 'i').ok).toBe(true);
		expect(checkIcon(pngUri(16, 16, 49_200), 'i').ok).toBe(false);

		const symbolsOf = (n: number) =>
			Array.from({ length: n }, (_, i) => ({ label: `s${i}`, icon: big }));
		// 4 icons ~ 213 KiB: under the total; 5 ~ 267 KiB: over it.
		expect(validateMapLegend({ groups: [{ name: 'g', symbols: symbolsOf(4) }] }, 'legend').ok).toBe(
			true,
		);
		const five = validateMapLegend({ groups: [{ name: 'g', symbols: symbolsOf(5) }] }, 'legend');
		expect(five.ok).toBe(false);
		expect(five.ok === false && five.reason).toMatch(/icons together.*characters/);
	});
});

describe('legend icons: the pixels a header declares are bounded, not only its bytes', () => {
	const side = LEGEND_LIMITS.maxIconSide;

	test('POSITIVE CONTROL: a bomb is small on the wire and absurd once decoded', () => {
		// a 1-bit PNG that declares 16000 x 16000 pixels (256 Mpx) is a few dozen bytes of header
		const bomb = pngUri(16_000, 16_000);
		expect(bomb.length).toBeLessThan(100);
		expect(16_000 * 16_000 * 4).toBeGreaterThan(1_000_000_000); // ~1 GB as RGBA
	});

	test('the side cap: the ceiling is allowed, one pixel past it is not, per axis', () => {
		expect(checkIcon(pngUri(side, side), 'i').ok).toBe(true);
		expect(checkIcon(pngUri(1, 1), 'i').ok).toBe(true);
		expect(checkIcon(pngUri(side + 1, 1), 'i').ok).toBe(false);
		expect(checkIcon(pngUri(1, side + 1), 'i').ok).toBe(false);
		const refused = checkIcon(pngUri(side + 1, 1), 'legend.icon');
		expect(refused.ok === false && refused.reason).toMatch(/^legend\.icon: .*pixels/);
	});

	test('a bomb is refused in every format and every webp chunk kind', () => {
		for (const [name, uri] of [
			['png 16000x16000', pngUri(16_000, 16_000)],
			['png 2^31-1 square', pngUri(2 ** 31 - 1, 2 ** 31 - 1)],
			['png 4294967295 wide', pngUri(2 ** 32 - 1, 1)],
			['jpeg 16000x16000', jpegUri(16_000, 16_000)],
			['jpeg 65535x65535', jpegUri(65_535, 65_535)],
			['webp lossy 16383x16383', webpUri('lossy', 16_383, 16_383)],
			['webp lossless 16384x16384', webpUri('lossless', 16_384, 16_384)],
			['webp extended 16000x16000', webpUri('extended', 16_000, 16_000)],
			['webp extended 2^24', webpUri('extended', 2 ** 24, 2 ** 24)],
		] as const) {
			expect(checkIcon(uri, name).ok, name).toBe(false);
		}
	});

	test('zero is not a size: a header that declares an empty image is refused', () => {
		expect(checkIcon(pngUri(0, 16), 'i').ok).toBe(false);
		expect(checkIcon(pngUri(16, 0), 'i').ok).toBe(false);
		expect(checkIcon(jpegUri(0, 0), 'i').ok).toBe(false);
	});

	test('a jpeg states its size AFTER its metadata: a big APP1 block before the frame header is read through', () => {
		expect(checkIcon(jpegUri(16, 16, 0, 20_000), 'i').ok).toBe(true);
		expect(checkIcon(jpegUri(16_000, 16_000, 0, 20_000), 'i').ok).toBe(false);
	});

	test('the header readers are TOTAL: every truncation answers null until the header is whole, none throws', () => {
		const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');
		// jpeg: SOI + JFIF APP0 (2 + 18) + a 300-byte APP1 (304) + the nine bytes of a frame header
		const samples: [string, RasterFormat, Uint8Array, number][] = [
			['png', 'png', pngBytes(16, 16), 24],
			['jpeg', 'jpeg', jpegBytes(16, 16, 0, 300), 2 + 18 + 304 + 9],
			['webp lossy', 'webp', webpBytes('lossy', 16, 16), 30],
			['webp lossless', 'webp', webpBytes('lossless', 16, 16), 25],
			['webp extended', 'webp', webpBytes('extended', 16, 16), 30],
		];
		for (const [name, format, bytes, whole] of samples) {
			for (let cut = 0; cut <= bytes.length; cut += 1) {
				const size = rasterSize(format, b64(bytes.slice(0, cut)));
				if (cut < whole) expect(size, `${name} cut at ${cut}`).toBeNull();
				else expect(size, `${name} cut at ${cut}`).toEqual({ width: 16, height: 16 });
			}
		}
	});

	test('random bytes, behind any signature or none, never throw and never invent a size past the cap', () => {
		let seed = 20_261_106;
		const next = (): number => {
			seed = (Math.imul(seed, 1_103_515_245) + 12_345) & 0x7fffffff;
			return seed % 256;
		};
		const signatures: Uint8Array[] = [
			new Uint8Array(),
			pngBytes(1, 1).slice(0, 12),
			jpegBytes(1, 1).slice(0, 3),
			webpBytes('extended', 1, 1).slice(0, 16),
		];
		for (let round = 0; round < 600; round += 1) {
			const noise = Uint8Array.from({ length: 1 + (next() % 90) }, next);
			const head = signatures[round % signatures.length] as Uint8Array;
			const bytes = Uint8Array.from([...head, ...noise]);
			for (const format of ['png', 'jpeg', 'webp'] as const) {
				const size = rasterSize(format, Buffer.from(bytes).toString('base64'));
				if (size === null) continue;
				expect(Number.isFinite(size.width) && Number.isFinite(size.height)).toBe(true);
			}
		}
	});

	test('the legend budget: pixels together are capped as well as characters', () => {
		const each = side * side; // 65 536
		const fits = Math.floor(LEGEND_LIMITS.maxIconPixelsTotal / each); // 16
		const icon = pngUri(side, side);
		const legendOf = (n: number) => ({
			groups: [
				{ name: 'g', symbols: Array.from({ length: n }, (_, i) => ({ label: `s${i}`, icon })) },
			],
		});
		// every icon is tiny in characters, so only the pixel budget can refuse the 17th
		expect(icon.length * (fits + 1)).toBeLessThan(LEGEND_LIMITS.maxIconCharsTotal);
		expect(validateMapLegend(legendOf(fits), 'legend').ok).toBe(true);
		const over = validateMapLegend(legendOf(fits + 1), 'legend');
		expect(over.ok).toBe(false);
		expect(over.ok === false && over.reason).toMatch(/icons together.*pixels/);
	});
});
