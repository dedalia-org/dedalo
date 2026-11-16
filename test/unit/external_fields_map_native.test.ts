/**
 * PAYLOAD SHAPING — the path extractor, the ceilings, and the sanitiser.
 *
 * The generality claim of this subsystem rests on this file: if the DEFAULT
 * extractor cannot reach `labels.en.value` or `items[0].body.value`, then a
 * second service is not addable without an engine edit, and the design is
 * wrong. So the nested/opaque shape (Wikidata's) is exercised here beside
 * Zenon's flat one.
 *
 * The two ceilings encode the shipped operator documentation exactly: an
 * over-long value is REFUSED (a silently shortened title is a wrong title that
 * looks real), an over-count list is CUT, and both are reported rather than
 * hidden.
 *
 * The sanitiser makes a client comment true. view_default_edit_component_external.js
 * says "the server is responsible for sanitising" and nothing did.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import type { ExternalRowView } from '../../src/external/api/types.ts';
import type { ExternalServiceModel } from '../../src/external/descriptor_types.ts';
import {
	decodeRemoteIdWith,
	defaultPickRow,
	defaultUnwrapRows,
	encodeRemoteIdWith,
	mapRowToEntries,
	normalizeEntries,
	parseFieldsMap,
	resolveRemotePath,
	sanitizeMarkup,
} from '../../src/external/fields_map.ts';
import { overrideExternalSettingsForTests } from '../../src/external/settings.ts';

afterEach(() => {
	overrideExternalSettingsForTests(null);
});

/**
 * The WORKED SECOND CASE: a nested-payload, opaque-id service. It declares
 * nothing but the mandatory fields — every shaping behaviour below comes from
 * the defaults, which is exactly the claim being tested.
 */
const wikidataLike: ExternalServiceModel = {
	service: 'wikidata_like',
	egress: 'record_identifiers',
	remoteIdShape: 'opaque_token',
	capabilities: { ordering: false, pagination: false, listColumns: true, search: false },
	buildRecordRequest: ({ apiUrl, remoteId }) => ({ url: `${apiUrl}/${remoteId}`, method: 'GET' }),
	formats: { rich: (raw) => ({ text: String(raw), kind: 'markup' }) },
};

function viewOf(row: Record<string, unknown> | null, service = 'wikidata_like'): ExternalRowView {
	return {
		sectionTipo: 'test3',
		remoteId: 'Q42',
		service,
		row,
		status: row === null ? 'unavailable' : 'ok',
		fetchedAt: 1,
	};
}

describe('the default path extractor', () => {
	const row = {
		title: 'flat',
		labels: { en: { value: 'Douglas Adams' } },
		items: [{ body: { value: 'first' } }, { body: { value: 'second' } }],
		empty: null,
	};

	test('a flat key is the degenerate case of a path', () => {
		expect(resolveRemotePath(row, 'title')).toBe('flat');
	});

	test('dotted paths traverse nested objects', () => {
		expect(resolveRemotePath(row, 'labels.en.value')).toBe('Douglas Adams');
	});

	test('indexed paths traverse arrays, in both spellings', () => {
		expect(resolveRemotePath(row, 'items[0].body.value')).toBe('first');
		expect(resolveRemotePath(row, 'items.1.body.value')).toBe('second');
	});

	test('a missing or non-traversable step is undefined, never a throw', () => {
		expect(resolveRemotePath(row, 'labels.de.value')).toBeUndefined();
		expect(resolveRemotePath(row, 'title.nope')).toBeUndefined();
		expect(resolveRemotePath(row, 'empty.value')).toBeUndefined();
		expect(resolveRemotePath(row, 'items[9].body')).toBeUndefined();
		expect(resolveRemotePath(row, '')).toBeUndefined();
	});

	test('a nested payload maps end to end with NO adapter code', () => {
		const payload = {
			results: [{ id: 'Q42', labels: { en: { value: 'Douglas Adams' } } }],
		};
		const rows = defaultUnwrapRows(payload, [{ local: 'ar_records', remote: 'results' }]);
		const picked = defaultPickRow(wikidataLike, rows, 'Q42');
		expect(picked).not.toBeNull();
		const fieldsMap = parseFieldsMap([{ local: 'dato', remote: 'labels.en.value' }], {
			tipo: 'test215',
		});
		expect(
			mapRowToEntries(wikidataLike, viewOf(picked as Record<string, unknown>), fieldsMap).entries,
		).toEqual(['Douglas Adams']);
	});
});

describe('the remote-id codec', () => {
	test('an opaque token round-trips and stays locator-safe', () => {
		for (const id of ['Q42', 'sh85-001', 'a.b:c']) {
			expect(decodeRemoteIdWith(wikidataLike, encodeRemoteIdWith(wikidataLike, id))).toBe(id);
			expect(id).not.toContain('|'); // the cache/locator separator
		}
	});

	test('an id that violates the declared shape is REFUSED', () => {
		expect(() => encodeRemoteIdWith(wikidataLike, 'a|b')).toThrow(/opaque_token/);
		expect(() => encodeRemoteIdWith(wikidataLike, 'has space')).toThrow(/opaque_token/);
	});
});

describe('normalizeEntries — the two emission ceilings', () => {
	test('everything is coerced to a STRING (v6 leaked raw arrays and objects)', () => {
		const fieldsMap = parseFieldsMap(
			[
				{ local: 'dato', remote: 'n' },
				{ local: 'dato', remote: 'b' },
				{ local: 'dato', remote: 'list' },
			],
			{ tipo: 'x' },
		);
		const result = mapRowToEntries(
			wikidataLike,
			viewOf({ n: 7, b: true, list: ['a', 'b'] }),
			fieldsMap,
		);
		expect(result.entries).toEqual(['7', 'true', 'a', 'b']);
		expect(result.entries.every((entry) => typeof entry === 'string')).toBe(true);
	});

	test('an object with no declared format is REFUSED and reported, not "[object Object]"', () => {
		const fieldsMap = parseFieldsMap([{ local: 'dato', remote: 'obj' }], { tipo: 'x' });
		const result = mapRowToEntries(wikidataLike, viewOf({ obj: { a: 1 } }), fieldsMap);
		expect(result.entries).toEqual([]);
		expect(result.source_status?.dropped_unrenderable).toBe(1);
	});

	test('an over-long value is refused (not trimmed) and reported', () => {
		overrideExternalSettingsForTests({ maxEntryChars: 10, maxEntries: 50 });
		const result = normalizeEntries([
			{ text: 'short', kind: 'text' },
			{ text: 'x'.repeat(11), kind: 'text' },
		]);
		expect(result.entries).toEqual(['short']);
		expect(result.droppedOverLength).toBe(1);
	});

	test('an over-long list is cut to the count ceiling and reported', () => {
		overrideExternalSettingsForTests({ maxEntryChars: 8192, maxEntries: 3 });
		const result = normalizeEntries(
			Array.from({ length: 10 }, (_v, index) => ({ text: String(index), kind: 'text' as const })),
		);
		expect(result.entries).toEqual(['0', '1', '2']);
		expect(result.droppedOverCount).toBe(7);
	});

	test('the ceilings reach the emitted source_status', () => {
		overrideExternalSettingsForTests({ maxEntryChars: 8192, maxEntries: 2 });
		const fieldsMap = parseFieldsMap([{ local: 'dato', remote: 'list' }], { tipo: 'x' });
		const result = mapRowToEntries(wikidataLike, viewOf({ list: ['a', 'b', 'c', 'd'] }), fieldsMap);
		expect(result.entries).toEqual(['a', 'b']);
		expect(result.source_status?.dropped_over_count).toBe(2);
	});
});

describe('the markup sanitiser', () => {
	test('script elements disappear WITH their content', () => {
		expect(sanitizeMarkup('a<script>alert(1)</script>b')).toBe('ab');
		expect(sanitizeMarkup('<STYLE>body{}</STYLE>ok')).toBe('ok');
		expect(sanitizeMarkup('<!-- <script>x</script> -->ok')).toBe('ok');
	});

	test('event handlers and every other attribute are dropped', () => {
		expect(sanitizeMarkup('<b onclick="steal()">hi</b>')).toBe('<b>hi</b>');
		expect(sanitizeMarkup('<b class="x" style="y">hi</b>')).toBe('<b>hi</b>');
	});

	test('unlisted tags disappear but their TEXT survives', () => {
		expect(sanitizeMarkup('<img src=x onerror=alert(1)>caption')).toBe('caption');
		expect(sanitizeMarkup('<a href="javascript:alert(1)">link</a>')).toBe('link');
	});

	test('allowed tags survive, bare', () => {
		expect(sanitizeMarkup('<em>t</em><sup>2</sup><br>')).toBe('<em>t</em><sup>2</sup><br>');
	});

	test('stray angle brackets are escaped, never re-interpreted', () => {
		expect(sanitizeMarkup('5 < 6 & 7 > 3')).toBe('5 &lt; 6 &amp; 7 &gt; 3');
		expect(sanitizeMarkup('<b onclick="x"')).toBe('&lt;b onclick=&quot;x&quot;');
	});

	test('a markup-kind format goes through it on the way to the wire', () => {
		const fieldsMap = parseFieldsMap([{ local: 'dato', remote: 'note', format: 'rich' }], {
			tipo: 'x',
		});
		const result = mapRowToEntries(
			wikidataLike,
			viewOf({ note: '<b onclick="x">bold</b><script>bad()</script>' }),
			fieldsMap,
		);
		expect(result.entries).toEqual(['<b>bold</b>']);
	});
});

/**
 * The kind must SURVIVE to the wire (WC-2026-08-06-external-client-render).
 * The sanitiser above is only half the story: the client renders every entry
 * with textContent, so a sanitised value that arrives unmarked shows its own
 * tags as characters — and, far worse, a value the client is told is markup
 * that never met the sanitiser is the XSS surface this whole design closes.
 */
describe('entries_kind — the render permission, parallel to entries', () => {
	test('normalizeEntries keeps the kind aligned with the surviving entries', () => {
		// The over-long value is REFUSED, so its kind must go with it: an index
		// shift here would hand one entry's permission to a different entry.
		overrideExternalSettingsForTests({ maxEntryChars: 10, maxEntries: 50 });
		const result = normalizeEntries([
			{ text: '<b>ok</b>', kind: 'markup' },
			{ text: 'x'.repeat(11), kind: 'text' },
			{ text: 'plain', kind: 'text' },
		]);
		expect(result.entries).toEqual(['<b>ok</b>', 'plain']);
		expect(result.kinds).toEqual(['markup', 'text']);
	});

	test('the count ceiling cuts entries and kinds together', () => {
		overrideExternalSettingsForTests({ maxEntryChars: 8192, maxEntries: 2 });
		const result = normalizeEntries([
			{ text: 'a', kind: 'text' },
			{ text: 'b', kind: 'markup' },
			{ text: 'c', kind: 'markup' },
		]);
		expect(result.entries).toEqual(['a', 'b']);
		expect(result.kinds).toEqual(['text', 'markup']);
	});

	test('the field reaches the wire ONLY when some entry is markup', () => {
		const markupMap = parseFieldsMap([{ local: 'dato', remote: 'note', format: 'rich' }], {
			tipo: 'x',
		});
		const withMarkup = mapRowToEntries(wikidataLike, viewOf({ note: '<em>t</em>' }), markupMap);
		expect(withMarkup.entries_kind).toEqual(['markup']);

		// An all-text row emits NOTHING: absent means text, so the ordinary
		// emission stays byte-identical to what it was before the key existed.
		const textMap = parseFieldsMap([{ local: 'dato', remote: 'n' }], { tipo: 'x' });
		const allText = mapRowToEntries(wikidataLike, viewOf({ n: 'plain' }), textMap);
		expect(allText.entries_kind).toBeUndefined();
		expect(Object.keys(allText)).toEqual(['entries']);
	});
});

describe('parseFieldsMap refuses malformed cataloguing loudly', () => {
	test('a non-array, a non-object row, and missing keys all throw', () => {
		expect(() => parseFieldsMap({ local: 'dato' }, { tipo: 'x' })).toThrow(/not an array/);
		expect(() => parseFieldsMap(['nope'], { tipo: 'x' })).toThrow(/not an object/);
		expect(() => parseFieldsMap([{ local: 'dato' }], { tipo: 'x' })).toThrow(/non-empty remote/);
		expect(() =>
			parseFieldsMap([{ local: 'dato', remote: 'a', format: 7 }], { tipo: 'x' }),
		).toThrow(/non-string format/);
	});

	test('absent fields_map is an empty map, not an error', () => {
		expect(parseFieldsMap(undefined, { tipo: 'x' })).toEqual([]);
		expect(parseFieldsMap(null, { tipo: 'x' })).toEqual([]);
	});
});

/**
 * T1-P06 — AN EMPTY VALUE IS NO ENTRY (WC-2026-11-13-external-empty-entry-dropped).
 * A remote field that is present but holds nothing visible is a MISSING value,
 * exactly like an absent field: no entry, no degradation. An entry `""` reached
 * the wire as a blank span the list view framed with separators (`| |`) and an
 * export cell `""` claiming "the service holds an empty value".
 */
describe('an empty value is no entry (T1-P06)', () => {
	const plain = parseFieldsMap([{ local: 'dato', remote: 'v' }], { tipo: 'x' });
	const rich = parseFieldsMap([{ local: 'dato', remote: 'v', format: 'rich' }], { tipo: 'x' });

	test('an empty plain string emits nothing and degrades nothing', () => {
		// Positive control: the same mapping DOES emit a non-empty value, so the
		// empty verdicts below cannot pass on a mapping that emits nothing at all.
		expect(mapRowToEntries(wikidataLike, viewOf({ v: 'x' }), plain).entries).toHaveLength(1);
		expect(mapRowToEntries(wikidataLike, viewOf({ v: '<em>x</em>' }), rich).entries).toHaveLength(
			1,
		);
		const result = mapRowToEntries(wikidataLike, viewOf({ v: '' }), plain);
		expect(result.entries).toEqual([]);
		expect(result.source_status).toBeUndefined();
	});

	test('a whitespace-only plain string emits nothing', () => {
		const result = mapRowToEntries(wikidataLike, viewOf({ v: '  \t' }), plain);
		expect(result.entries).toEqual([]);
		expect(result.source_status).toBeUndefined();
	});

	test('empty items of a plain array are dropped, the real one kept', () => {
		const result = mapRowToEntries(wikidataLike, viewOf({ v: ['', 'x', '  '] }), plain);
		expect(result.entries).toEqual(['x']);
		expect(result.source_status).toBeUndefined();
	});

	test('markup with no visible text after sanitising emits nothing, and no entries_kind', () => {
		for (const raw of ['<script>x</script>', '<br>', '<em> </em>']) {
			const result = mapRowToEntries(wikidataLike, viewOf({ v: raw }), rich);
			expect(result.entries).toEqual([]);
			expect(result.entries_kind).toBeUndefined();
			expect(result.source_status).toBeUndefined();
		}
	});

	test('empties never consume a count slot and their kind leaves with them', () => {
		overrideExternalSettingsForTests({ maxEntryChars: 8192, maxEntries: 2 });
		const result = normalizeEntries([
			{ text: '', kind: 'text' },
			{ text: 'a', kind: 'markup' },
			{ text: ' ', kind: 'text' },
			{ text: 'b', kind: 'text' },
		]);
		expect(result.entries).toEqual(['a', 'b']);
		expect(result.kinds).toEqual(['markup', 'text']);
		expect(result.droppedOverCount).toBe(0);
	});

	test('non-empty text is NOT trimmed', () => {
		const result = mapRowToEntries(wikidataLike, viewOf({ v: ' x ' }), plain);
		expect(result.entries).toEqual([' x ']);
	});
});
