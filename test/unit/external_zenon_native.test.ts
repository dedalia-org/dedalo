/**
 * ZENON ADAPTER — the request bytes and the value bytes.
 *
 * Two contracts, both pinned against the shipped samples in
 * src/core/components/component_external/samples/:
 *
 *  1. THE REQUEST. `zenon_request.json` is the frozen v7 PHP's URL for a record
 *     with the full field set. It is asserted byte-identically, because the
 *     literal `field[]=` (unencoded brackets) and the parameter ORDER are the
 *     contract — a URLSearchParams rewrite would look right and be a different
 *     request. Plus the two edge cases the frozen adapter states explicitly: no
 *     fields ⇒ NO dangling `&`, and an unmapped lang ⇒ `lgn=en` (v6 emitted an
 *     empty `&lgn=&`).
 *
 *  2. THE VALUES. `zenon_data.json` (a real Zenon answer) run through
 *     unwrapRows → pickRow → the fields_map, reproducing the shape `data.json`
 *     pins — a single-element array of STRINGS — for the plain mapping, and the
 *     two formats byte-for-byte against the v6 source
 *     (class.component_external.php:213-232: role keys joined ' - ', roles
 *     joined ' | ', PHP-`empty()` roles skipped).
 *
 * NO NETWORK, ever: the request build and the value mapping are pure, and the
 * one end-to-end case injects its fetch.
 */
// Migrated to the generic `test` TLD 2026-08-19. The `zenon` CONNECTOR stays — it is an
// engine module (src/external/services/zenon.ts), not an install's ontology — but the
// ontology COORDINATES it is exercised with are now the generic clones of the external
// section (test7342) and its component_external children (test7344-test7347), per
// src/core/test_data/test_tld_tipo_map.json. Still NO network: every case here is pure
// or injects its fetch.

import { afterEach, describe, expect, test } from 'bun:test';
import zenonData from '../../src/core/components/component_external/samples/zenon_data.json';
import zenonRequest from '../../src/core/components/component_external/samples/zenon_request.json';
import type { ExternalRowView } from '../../src/external/api/types.ts';
import {
	defaultPickRow,
	defaultUnwrapRows,
	mapRowToEntries,
	parseFieldsMap,
	remoteFieldsOf,
} from '../../src/external/fields_map.ts';
import { zenon } from '../../src/external/services/zenon.ts';
import { overrideExternalSettingsForTests } from '../../src/external/settings.ts';

const API_URL = 'https://zenon.dainst.org/api/v1/record';
/** The field set `zenon_request.json` was built from (the external section's component_external children + id). */
const FULL_FIELDS = [
	'id',
	'title',
	'authors',
	'publicationDates',
	'recordPage',
	'containerTitle',
	'physicalDescriptions',
];
const RESPONSE_MAP = [
	{ local: 'ar_records', remote: 'records' },
	{ local: 'msg', remote: 'status' },
];
/** The record id inside zenon_data.json (zero-padded — never a number). */
const SAMPLE_ID = '000848571';

afterEach(() => {
	overrideExternalSettingsForTests(null);
});

function rowView(row: Record<string, unknown> | null): ExternalRowView {
	return {
		sectionTipo: 'test7342',
		remoteId: SAMPLE_ID,
		service: 'zenon',
		row,
		status: row === null ? 'not_found' : 'ok',
		fetchedAt: 1,
	};
}

describe('zenon buildRecordRequest — the frozen v7 URL form', () => {
	test('reproduces samples/zenon_request.json byte-identically', () => {
		const request = zenon.buildRecordRequest({
			apiUrl: API_URL,
			remoteId: '000848571',
			dataLang: 'lg-eng',
			remoteFields: FULL_FIELDS,
		});
		expect(request.url).toBe(zenonRequest.url);
		expect(request.method).toBe('GET');
	});

	test('no fields ⇒ the field segment is omitted entirely (no dangling &)', () => {
		const request = zenon.buildRecordRequest({
			apiUrl: API_URL,
			remoteId: '001338683',
			dataLang: 'lg-spa',
			remoteFields: [],
		});
		expect(request.url).toBe(`${API_URL}?id=001338683&lgn=es`);
		expect(request.url.endsWith('&')).toBe(false);
	});

	test('an unmapped lang falls back to en (v6 emitted an empty &lgn=&)', () => {
		const request = zenon.buildRecordRequest({
			apiUrl: API_URL,
			remoteId: '001338683',
			dataLang: 'lg-nolan',
			remoteFields: ['title'],
		});
		expect(request.url).toBe(`${API_URL}?id=001338683&lgn=en&field[]=title`);
	});

	test('zero padding survives — the id is never parsed as a number', () => {
		const request = zenon.buildRecordRequest({
			apiUrl: API_URL,
			remoteId: '000000042',
			dataLang: 'lg-eng',
			remoteFields: [],
		});
		expect(request.url).toContain('id=000000042');
	});

	test('a non-numeric id and a non-identifier field name are REFUSED, not spliced', () => {
		expect(() =>
			zenon.buildRecordRequest({
				apiUrl: API_URL,
				remoteId: '1&field[]=secret',
				dataLang: 'lg-eng',
				remoteFields: [],
			}),
		).toThrow(/numeric_string/);
		expect(() =>
			zenon.buildRecordRequest({
				apiUrl: API_URL,
				remoteId: '1',
				dataLang: 'lg-eng',
				remoteFields: ['title&id=9'],
			}),
		).toThrow(/bare identifier/);
	});
});

describe('zenon payload → rows → values', () => {
	test('unwrapRows follows response_map ar_records → records', () => {
		const rows = defaultUnwrapRows(zenonData, RESPONSE_MAP);
		expect(rows.length).toBe(1);
		expect(rows[0]?.id).toBe(SAMPLE_ID);
	});

	test('pickRow matches on the id — a non-matching answer is not a hit', () => {
		const rows = defaultUnwrapRows(zenonData, RESPONSE_MAP);
		expect(defaultPickRow(zenon, rows, SAMPLE_ID)).toBe(rows[0] as never);
		expect(defaultPickRow(zenon, rows, '999999999')).toBeNull();
		// Two rows, neither of them ours: never "whatever came first" (the v6 defect).
		expect(defaultPickRow(zenon, [{ id: '111' }, { id: '222' }], '333')).toBeNull();
	});

	test('a plain mapping yields the single-element STRING array data.json pins', () => {
		const rows = defaultUnwrapRows(zenonData, RESPONSE_MAP);
		const fieldsMap = parseFieldsMap([{ local: 'dato', remote: 'title' }], { tipo: 'test7345' });
		const result = mapRowToEntries(zenon, rowView(rows[0] as Record<string, unknown>), fieldsMap);
		expect(result.entries).toEqual(['Las acuñaciones provinciales romanas de Hispania ']);
		expect(result.entries.every((entry) => typeof entry === 'string')).toBe(true);
		expect(result.source_status).toBeUndefined();
	});

	test('zenon_authors reproduces the PHP: "<role>: " + keys joined " - ", roles joined " | "', () => {
		const rows = defaultUnwrapRows(zenonData, RESPONSE_MAP);
		const fieldsMap = parseFieldsMap(
			[{ local: 'dato', remote: 'authors', format: 'zenon_authors' }],
			{ tipo: 'test7346' },
		);
		const result = mapRowToEntries(zenon, rowView(rows[0] as Record<string, unknown>), fieldsMap);
		// secondary:[] and corporate:[] are PHP-empty() and contribute nothing.
		expect(result.entries).toEqual(['primary: Ripollès Alegre, P. P. (Pere Pau)']);
	});

	test('zenon_authors joins several names with " - " and several roles with " | "', () => {
		const format = zenon.formats?.zenon_authors;
		expect(format).toBeDefined();
		const value = (format as NonNullable<typeof format>)({
			primary: { 'Doe, J.': [], 'Roe, R.': [] },
			secondary: [],
			corporate: { DAI: [] },
		});
		expect(value).toEqual({ text: 'primary: Doe, J. - Roe, R. | corporate: DAI', kind: 'text' });
	});

	test('array_values is implode(" | ")', () => {
		const rows = defaultUnwrapRows(zenonData, RESPONSE_MAP);
		const fieldsMap = parseFieldsMap(
			[{ local: 'dato', remote: 'publicationDates', format: 'array_values' }],
			{ tipo: 'test7347' },
		);
		expect(
			mapRowToEntries(zenon, rowView(rows[0] as Record<string, unknown>), fieldsMap).entries,
		).toEqual(['2010']);
		const format = zenon.formats?.array_values as NonNullable<typeof zenon.formats>['array_values'];
		expect(format(['a', 'b', 'c'])).toEqual({ text: 'a | b | c', kind: 'text' });
	});

	test('array_values REFUSES an object item — no "[object Object]" in a record', () => {
		// The one-word cataloguing error: `format:'array_values'` on a field that
		// turns out to hold objects. The unformatted path already refuses objects
		// and counts the drop; a FORMAT must not be the hole in that rule, because
		// String({}) writes a wrong value that looks like a real one and carries
		// degraded:false — nothing on the page says the data is not the record's.
		const format = zenon.formats?.array_values as NonNullable<typeof zenon.formats>['array_values'];
		expect(format(['a', { name: 'Doe' }, 'b'])).toEqual({
			text: 'a | b',
			kind: 'text',
			refused: 1,
		});
		expect(format({ name: 'Doe' })).toEqual({ text: '', kind: 'text', refused: 1 });

		// …and the refusal reaches the WIRE as dropped_unrenderable, the same
		// counter the unformatted path uses, with no entry invented for it.
		const fieldsMap = parseFieldsMap(
			[{ local: 'dato', remote: 'authors', format: 'array_values' }],
			{ tipo: 'test7347' },
		);
		const result = mapRowToEntries(
			zenon,
			rowView({ id: '000848571', authors: { primary: { 'Doe, J.': [] } } }),
			fieldsMap,
		);
		expect(result.entries).toEqual([]);
		expect(result.source_status?.dropped_unrenderable).toBe(1);
	});

	test('array_values DROPS empty elements — the documented divergence from implode', () => {
		// PHP implode(' | ', ['213 p.', '']) keeps the empty element and emits
		// "213 p. | ". Ledgered in WC-2026-08-05-external-entry-normalisation: a
		// trailing separator is a rendering artifact, not data, and no value is
		// lost by dropping it. Pinned so the divergence stays deliberate.
		const format = zenon.formats?.array_values as NonNullable<typeof zenon.formats>['array_values'];
		expect(format(['213 p.', '', null, 'ill.'])).toEqual({ text: '213 p. | ill.', kind: 'text' });
	});

	test('an all-empty authors object or an empty date list is NO entry (T1-P06)', () => {
		// v6 PHP implode()d an all-empty authors object into "" and pushed it: a
		// blank entry the list view framed as "| |". Empty is MISSING, not degraded.
		const fieldsMap = parseFieldsMap(
			[
				{ local: 'dato', remote: 'authors', format: 'zenon_authors' },
				{ local: 'dato', remote: 'publicationDates', format: 'array_values' },
			],
			{ tipo: 'test7346' },
		);
		// Positive control: the same map emits both values when they are there.
		expect(
			mapRowToEntries(
				zenon,
				rowView({
					id: SAMPLE_ID,
					authors: { primary: { 'Doe, J.': [] } },
					publicationDates: ['2010'],
				}),
				fieldsMap,
			).entries,
		).toHaveLength(2);
		for (const dates of [[], ['', null]]) {
			const result = mapRowToEntries(
				zenon,
				rowView({
					id: SAMPLE_ID,
					authors: { primary: [], secondary: [], corporate: [] },
					publicationDates: dates,
				}),
				fieldsMap,
			);
			expect(result.entries).toEqual([]);
			expect(result.source_status).toBeUndefined();
		}
	});

	test('zenon_authors REFUSES a non-object value — a lost value is reported, never blank (T1-P06)', () => {
		const format = zenon.formats?.zenon_authors as NonNullable<
			typeof zenon.formats
		>['zenon_authors'];
		for (const raw of ['Doe', 7, true, ['Doe']]) {
			expect(format(raw)).toEqual({ text: '', kind: 'text', refused: 1 });
		}
		const fieldsMap = parseFieldsMap(
			[{ local: 'dato', remote: 'authors', format: 'zenon_authors' }],
			{ tipo: 'test7346' },
		);
		const result = mapRowToEntries(zenon, rowView({ id: SAMPLE_ID, authors: 'Doe' }), fieldsMap);
		expect(result.entries).toEqual([]);
		expect(result.source_status?.dropped_unrenderable).toBe(1);
	});

	test('zenon_authors: an EMPTY authors value is missing, never refused (T1-P06 review)', () => {
		// VuFind (PHP) json_encode writes an empty assoc array as `[]`: a record
		// with no authors arrives as `authors: []`. Empty = missing, not lost.
		const format = zenon.formats?.zenon_authors as NonNullable<
			typeof zenon.formats
		>['zenon_authors'];
		const fieldsMap = parseFieldsMap(
			[{ local: 'dato', remote: 'authors', format: 'zenon_authors' }],
			{ tipo: 'test7346' },
		);
		for (const raw of [[], '', false, 0, {}]) {
			expect(format(raw)).toEqual({ text: '', kind: 'text' });
			const result = mapRowToEntries(zenon, rowView({ id: SAMPLE_ID, authors: raw }), fieldsMap);
			expect(result.entries).toEqual([]);
			expect(result.source_status).toBeUndefined();
		}
	});

	test('zenon_authors REFUSES a scalar role, the other roles still render (T1-P06)', () => {
		// HEAD rendered Object.keys('Doe') → "primary: 0 - 1 - 2": a wrong value
		// wearing a correct value's clothes.
		const format = zenon.formats?.zenon_authors as NonNullable<
			typeof zenon.formats
		>['zenon_authors'];
		expect(format({ primary: 'Doe', corporate: { DAI: [] } })).toEqual({
			text: 'corporate: DAI',
			kind: 'text',
			refused: 1,
		});
	});

	test('a fields_map naming an unimplemented format THROWS (v6 shipped the raw value)', () => {
		const rows = defaultUnwrapRows(zenonData, RESPONSE_MAP);
		const fieldsMap = parseFieldsMap([{ local: 'dato', remote: 'title', format: 'nope' }], {
			tipo: 'testX',
		});
		expect(() =>
			mapRowToEntries(zenon, rowView(rows[0] as Record<string, unknown>), fieldsMap),
		).toThrow(/does not implement/);
	});

	test('a null row emits nothing and says why', () => {
		const fieldsMap = parseFieldsMap([{ local: 'dato', remote: 'title' }], { tipo: 'test7345' });
		const result = mapRowToEntries(zenon, rowView(null), fieldsMap);
		expect(result.entries).toEqual([]);
		expect(result.source_status?.status).toBe('not_found');
	});

	test('remoteFieldsOf collects only the dato rows, deduped, in order', () => {
		const fieldsMap = parseFieldsMap(
			[
				{ local: 'dato', remote: 'title' },
				{ local: 'label', remote: 'ignored' },
				{ local: 'dato', remote: 'authors' },
				{ local: 'dato', remote: 'title' },
			],
			{ tipo: 'testX' },
		);
		expect(remoteFieldsOf(fieldsMap)).toEqual(['title', 'authors']);
	});
});

describe('zenon descriptor declarations', () => {
	test('the id codec round-trips and preserves zero padding', () => {
		const encode = zenon.encodeRemoteId ?? ((id: string) => id);
		const decode = zenon.decodeRemoteId ?? ((id: string) => id);
		for (const id of ['000848571', '001338683', '42']) {
			expect(decode(encode(id))).toBe(id);
		}
	});

	test('uiRecordUrl builds the human page without doubling the slash', () => {
		expect(zenon.uiRecordUrl?.('https://zenon.dainst.org/Record/', '000848571')).toBe(
			'https://zenon.dainst.org/Record/000848571',
		);
	});

	test('search is declared AND implemented, as a matched pair', () => {
		// Until 2026-08-06 both functions were absent on purpose (the capability
		// said the SERVICE could, the missing function said the ENGINE could not).
		// They landed together: `unwrapSearch` without `buildSearchRequest` — or
		// either without `capabilities.search` — is an adapter that half-answers.
		// The behaviour is gated by external_search_native.test.ts.
		expect(zenon.capabilities.search).toBe(true);
		expect(typeof zenon.buildSearchRequest).toBe('function');
		expect(typeof zenon.unwrapSearch).toBe('function');
		// A search sends TERMS, which is strictly heavier than the record path's
		// ids — so it carries its own egress class and never borrows that one.
		expect(zenon.searchEgress).toBe('query_terms');
		expect(zenon.egress).toBe('record_identifiers');
	});

	test('the credential is a KEY NAME, never a value', () => {
		expect(zenon.credentialCatalogKey).toBe('DEDALO_EXTERNAL_ZENON_API_KEY');
		expect(JSON.stringify(zenon)).not.toContain('Bearer ');
	});
});
