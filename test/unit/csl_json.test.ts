/**
 * Pure gate: the CSL-JSON reader and the Zotero field mapper (T1-7) —
 * src/core/tools/csl_json.ts + zotero_map.ts. No database: target kinds are
 * passed in, as the tool door resolves them.
 *
 * Pins the PHP divergences of WC-2026-11-12-zotero-csl-json-import: names
 * trimmed, a text date REFUSED (PHP saved an empty date = a clear), a season
 * only as a time of day, a range end only into a range component, variables
 * dispatched by CSL kind (editor → names, original-date → date), ISBN + ISSN
 * accumulating (no last-wins), the type as LOCATORS (v6), the D1 notice.
 */

import { describe, expect, test } from 'bun:test';
import {
	cslDate,
	cslDoiIri,
	cslNames,
	cslZoteroKey,
	parseCslJson,
} from '../../src/core/tools/csl_json.ts';
import {
	assertConfigSection,
	mapCslItem,
	RECORD_NUMBER_LIMIT,
	readZoteroConfig,
	recordNumberAboveLimit,
	recordNumberOf,
	type TargetKind,
} from '../../src/core/tools/zotero_map.ts';
import { refusalOfSync } from '../helpers/refusal.ts';

describe('parseCslJson', () => {
	test('an array of item objects is an export', () => {
		const parsed = parseCslJson('[{"id":"a","type":"book"}]');
		expect(parsed.error).toBeNull();
		expect(parsed.items).toEqual([{ id: 'a', type: 'book' }]);
	});

	test('a top-level object, a non-object item and invalid JSON are refused per file', () => {
		expect(parseCslJson('{"id":"a"}').error).toContain('top level must be a list');
		expect(parseCslJson('[{"id":"a"}, 3]').error).toContain('item #2 is not an object');
		expect(parseCslJson('[{').error).toContain('not valid JSON');
	});
});

describe('cslNames', () => {
	test('literal, given+family, one part only — trimmed', () => {
		expect(
			cslNames([
				{ literal: 'Museo Nacional' },
				{ given: 'Jane', family: 'Smith' },
				{ family: 'Solo' },
				{ given: 'Only' },
			]),
		).toEqual(['Museo Nacional', 'Jane Smith', 'Solo', 'Only']);
	});

	test('a name with no part, and a non-list, are refused', () => {
		expect(cslNames([{}])).toHaveProperty('refusal');
		expect(cslNames('Smith')).toHaveProperty('refusal');
	});
});

describe('cslDate', () => {
	test('date-parts → start y/m/d; a bare number / digit string is a year', () => {
		expect(cslDate({ 'date-parts': [[2014, 12, 30]] }, false)).toEqual({
			item: { start: { year: 2014, month: 12, day: 30 } },
			notices: [],
		});
		expect(cslDate({ 'date-parts': [['1998', '3']] }, false)).toEqual({
			item: { start: { year: 1998, month: 3 } },
			notices: [],
		});
		expect(cslDate(1900, false)).toEqual({ item: { start: { year: 1900 } }, notices: [] });
		expect(cslDate('1900', false)).toEqual({ item: { start: { year: 1900 } }, notices: [] });
	});

	test('a text date (raw / literal / no date-parts) is REFUSED — never an empty date', () => {
		const refused = cslDate({ raw: 'circa 1900' }, true);
		expect(refused).toHaveProperty('refusal');
		expect((refused as { refusal: string }).refusal).toContain('circa 1900');
		expect(cslDate({ 'date-parts': [[]] }, true)).toHaveProperty('refusal');
		expect(cslDate({ 'date-parts': [['c.1900']] }, true)).toHaveProperty('refusal');
	});

	test('a range end is kept for a range component, dropped with a notice otherwise', () => {
		const range = { 'date-parts': [[2010], [2012, 6]] };
		expect(cslDate(range, true)).toEqual({
			item: { start: { year: 2010 }, end: { year: 2012, month: 6 } },
			notices: [],
		});
		const single = cslDate(range, false) as { item: unknown; notices: string[] };
		expect(single.item).toEqual({ start: { year: 2010 } });
		expect(single.notices).toHaveLength(1);
	});

	test('season: a clock time is the time; a CSL season is NOT (PHP read "1" as hour 1)', () => {
		expect(cslDate({ 'date-parts': [[2014, 12, 30]], season: '12:57:26' }, false)).toEqual({
			item: { start: { year: 2014, month: 12, day: 30, hour: 12, minute: 57, second: 26 } },
			notices: [],
		});
		const spring = cslDate({ 'date-parts': [[2014]], season: 1 }, false) as unknown as {
			item: { start: Record<string, number> };
			notices: string[];
		};
		expect(spring.item.start.hour).toBeUndefined();
		expect(spring.notices).toHaveLength(1);
	});
});

describe('keys and DOIs', () => {
	test('the Zotero key is the id URI last segment', () => {
		expect(cslZoteroKey('http://zotero.org/users/1/items/ABCD1234')).toBe('ABCD1234');
		expect(cslZoteroKey('ABCD1234')).toBe('ABCD1234');
	});

	test('a DOI gets the resolver prefix once', () => {
		expect(cslDoiIri('10.1000/xyz')).toBe('https://www.doi.org/10.1000/xyz');
		expect(cslDoiIri('https://doi.org/10.1000/xyz')).toBe('https://doi.org/10.1000/xyz');
	});
});

/** A config over the generic test3 tipos (kinds supplied, no DB). */
const RAW_CONFIG = {
	map: [
		{ name: 'id', ddo_map: [{ tipo: 'test162', section_tipo: 'test3' }] },
		{ name: 'title', ddo_map: [{ tipo: 'test52', section_tipo: 'test3' }] },
		{ name: 'editor', ddo_map: [{ tipo: 'test166', section_tipo: 'test3' }] },
		{ name: 'original-date', ddo_map: [{ tipo: 'test172', section_tipo: 'test3' }] },
		{ name: 'type', ddo_map: [{ tipo: 'test91', section_tipo: 'test3' }] },
		{ name: 'ISBN', ddo_map: [{ tipo: 'test17', section_tipo: 'test3' }] },
		{ name: 'ISSN', ddo_map: [{ tipo: 'test17', section_tipo: 'test3' }] },
		{ name: 'DOI', ddo_map: [{ tipo: 'test140', section_tipo: 'test3' }] },
		{ name: 'archive', ddo_map: [{ tipo: 'test85', section_tipo: 'test3' }] },
		{
			name: 'container-title',
			ddo_map: [
				{ tipo: 'test80', section_tipo: 'test3' },
				{ tipo: 'test52', section_tipo: 'test3', parent: 'test80' },
			],
		},
	],
	main: [
		{ name: 'section', tipo: 'test3' },
		{ name: 'field_standard_number', tipo: 'test88' },
		{ name: 'field_to_section_id', value: 'call-number' },
	],
	typology: [{ name: 'book', value: [{ section_id: 1, section_tipo: 'dd64' }] }],
	standard_type: [
		{ name: 'ISBN', value: [{ section_id: 1, section_tipo: 'dd64' }] },
		{ name: 'ISSN', value: [{ section_id: 2, section_tipo: 'dd64' }] },
	],
};

const KINDS = new Map<string, TargetKind>([
	['test162', 'text'],
	['test52', 'text'],
	['test166', 'text'],
	['test172', 'date_range'],
	['test91', 'relation'],
	['test17', 'html'],
	['test140', 'iri'],
	['test88', 'relation'],
	['test80', 'relation'],
]);

/** The values written into one component (each value decoded). */
function valuesOf(record: ReturnType<typeof mapCslItem>, tipo: string): unknown[] {
	return record.fields
		.filter((field) => field.component_tipo === tipo && field.refusal === undefined)
		.flatMap((field) => field.values.map((value) => JSON.parse(value) as unknown));
}

describe('readZoteroConfig', () => {
	test('reads map, main, typology and standard_type', () => {
		const cfg = readZoteroConfig(RAW_CONFIG);
		expect(cfg.idTarget).toEqual({ sectionTipo: 'test3', componentTipo: 'test162' });
		expect(cfg.standardNumberTipo).toBe('test88');
		// The address variable names a Zotero FIELD: the map binds no component to it.
		expect(cfg.fieldToSectionId).toBe('call-number');
		expect(cfg.entries.some((e) => e.name === 'call-number')).toBe(false);
		expect(cfg.entries.find((e) => e.name === 'container-title')?.link).toEqual({
			sectionTipo: 'test3',
			componentTipo: 'test52',
		});
	});

	test('no map, a malformed entry and no `id` entry are refused by name', () => {
		expect(refusalOfSync(() => readZoteroConfig({})).message).toContain("'map'");
		expect(
			refusalOfSync(() => readZoteroConfig({ map: [{ name: 'title', ddo_map: [{ tipo: 'x' }] }] }))
				.message,
		).toContain("'tipo' and 'section_tipo'");
		expect(
			refusalOfSync(() =>
				readZoteroConfig({
					map: [{ name: 'title', ddo_map: [{ tipo: 'test52', section_tipo: 'test3' }] }],
				}),
			).message,
		).toContain("no 'id' entry");
	});

	test("field_to_section_id names a Zotero field (no map entry needed); 'id' is refused, blank is none", () => {
		const withValue = (value: string) => ({
			...RAW_CONFIG,
			main: RAW_CONFIG.main.map((entry) =>
				entry.name === 'field_to_section_id' ? { ...entry, value } : entry,
			),
		});
		// Any CSL field may carry the address — it needs no component.
		expect(readZoteroConfig(withValue('archive_location')).fieldToSectionId).toBe(
			'archive_location',
		);
		expect(readZoteroConfig(withValue('  ')).fieldToSectionId).toBeUndefined();
		// The Zotero key is LOOKED UP (DATA-08): never a record number.
		const refusal = refusalOfSync(() => readZoteroConfig(withValue('id')));
		expect(refusal.code).toBe('request.invalid_options');
		expect(refusal.publicMessage).toContain('field_to_section_id');
		expect(refusal.publicMessage).toContain("'id'");
	});

	test('an entry or main.section of another section is refused before any read', () => {
		const cfg = readZoteroConfig(RAW_CONFIG);
		expect(() => assertConfigSection(cfg, 'test3')).not.toThrow();
		expect(refusalOfSync(() => assertConfigSection(cfg, 'test65')).code).toBe(
			'request.invalid_options',
		);
	});
});

describe('mapCslItem', () => {
	const cfg = readZoteroConfig(RAW_CONFIG);
	const map = (item: Record<string, unknown>) => mapCslItem(item, cfg, { kindOf: KINDS });

	test('id → key (code) + the URI as the alternative spelling', () => {
		const record = map({ id: 'http://zotero.org/users/1/items/K1' });
		expect(record.code).toBe('K1');
		expect(record.url).toBe('http://zotero.org/users/1/items/K1');
		expect(valuesOf(record, 'test162')).toEqual([[{ value: 'K1' }]]);
	});

	test('dispatch by CSL kind: editor → names, original-date → a range date', () => {
		const record = map({
			id: 'K2',
			editor: [{ given: 'Ana', family: 'Ruiz' }, { literal: 'Archivo' }],
			'original-date': { 'date-parts': [[1990], [1992]] },
		});
		expect(valuesOf(record, 'test166')).toEqual([[{ value: 'Ana Ruiz' }, { value: 'Archivo' }]]);
		expect(valuesOf(record, 'test172')).toEqual([[{ start: { year: 1990 }, end: { year: 1992 } }]]);
	});

	test('type → the typology LOCATORS; an unknown type is a refusal', () => {
		expect(valuesOf(map({ id: 'K3', type: 'book' }), 'test91')).toEqual([
			[{ section_id: 1, section_tipo: 'dd64' }],
		]);
		const unknown = map({ id: 'K3', type: 'manuscript' });
		expect(unknown.fields.find((f) => f.component_tipo === 'test91')?.refusal).toContain(
			'manuscript',
		);
	});

	test('ISBN + ISSN both ACCUMULATE: two numbers, two kinds (no last-wins)', () => {
		const record = map({ id: 'K4', ISBN: '978-1', ISSN: '1234-5678' });
		expect(valuesOf(record, 'test17')).toEqual([
			[{ value: '<p>978-1</p>' }],
			[{ value: '<p>1234-5678</p>' }],
		]);
		expect(valuesOf(record, 'test88')).toEqual([
			[{ section_id: 1, section_tipo: 'dd64' }],
			[{ section_id: 2, section_tipo: 'dd64' }],
		]);
	});

	test('DOI → its IRI; container-title → a link; archive → the attachment', () => {
		const record = map({
			id: 'K5',
			DOI: '10.1/x',
			'container-title': ' Revista ',
			archive: 'k5.pdf',
		});
		expect(valuesOf(record, 'test140')).toEqual([[{ iri: 'https://www.doi.org/10.1/x' }]]);
		expect(record.links).toEqual([
			{
				component_tipo: 'test80',
				target: { sectionTipo: 'test3', componentTipo: 'test52' },
				text: 'Revista',
			},
		]);
		expect(record.archive).toBe('k5.pdf');
		expect(record.fields.some((f) => f.component_tipo === 'test85')).toBe(false);
	});

	test('call-number is carried as the ADDRESS text the file holds — never a field, never unmapped, never yet a number', () => {
		const record = map({ id: 'K6', 'call-number': ' 42 ' });
		expect(record.code).toBe('K6');
		expect(record.address).toBe('42');
		// No component holds it: the only field written is the key.
		expect(valuesOf(record, 'test162')).toEqual([[{ value: 'K6' }]]);
		expect(record.unmapped).toEqual([]);
		expect('sectionId' in record).toBe(false);
		expect(record.notices).toEqual([]);
		// A JSON number is its digits; blank and null are NO address.
		expect(map({ id: 'K6', 'call-number': 42 }).address).toBe('42');
		expect(map({ id: 'K6', 'call-number': '  ' }).address).toBeNull();
		expect(map({ id: 'K6', 'call-number': null }).address).toBeNull();
		expect(map({ id: 'K6' }).address).toBeNull();
		// Anything else is carried AS IT IS, so the door's refusal can name it.
		expect(map({ id: 'K6', 'call-number': '12abc' }).address).toBe('12abc');
		expect(map({ id: 'K6', 'call-number': { shelf: 1 } }).address).toBe('{"shelf":1}');
		expect(map({ id: 'K6', 'call-number': true }).address).toBe('true');
	});

	test('recordNumberOf: only a canonical positive int4 is a record number (rule 1)', () => {
		const numbers: [string, number][] = [
			['1', 1],
			['42', 42],
			['900323', 900323],
			['2147483647', 2147483647],
		];
		for (const [text, sectionId] of numbers) expect(recordNumberOf(text), text).toBe(sectionId);
		const notNumbers = [
			'',
			'0',
			'007',
			'-5',
			'+5',
			'1.0',
			'1e3',
			'12abc',
			'abc12',
			' 12',
			'12 ',
			'1 2',
			'0x10',
			'٣',
			'2147483648',
			'99999999999999999999999999',
			'{"shelf":1}',
			'true',
		];
		for (const text of notNumbers) expect(recordNumberOf(text), text).toBeNull();
	});

	test('recordNumberAboveLimit: a whole number past the section_id limit is told apart from "not a number" (owner ruling 2026-11-18)', () => {
		// The limit IS int4: the last address, and the first value past it.
		expect(RECORD_NUMBER_LIMIT).toBe(2147483647);
		expect(recordNumberOf(String(RECORD_NUMBER_LIMIT))).toBe(RECORD_NUMBER_LIMIT);
		expect(recordNumberAboveLimit(String(RECORD_NUMBER_LIMIT))).toBe(false);
		const above = [
			'2147483648',
			'9999999999',
			'99999999999999999999999999',
			// Past the float range too: Number() is Infinity, still above.
			'9'.repeat(400),
		];
		for (const text of above) {
			expect(recordNumberAboveLimit(text), text).toBe(true);
			expect(recordNumberOf(text), text).toBeNull();
		}
		// Only the ADDRESS spelling counts: these are not record numbers at all.
		const notNumbers = ['', '0', '1', '42', '02147483648', '-2147483648', '2147483648.0', '3e9'];
		for (const text of notNumbers) expect(recordNumberAboveLimit(text), text).toBe(false);
	});

	test('unmapped variables are listed; a non-scalar in a scalar slot is refused', () => {
		const record = map({ id: 'K7', publisher: 'X', title: { nested: true } });
		expect(record.unmapped).toEqual(['publisher']);
		expect(record.fields.find((f) => f.component_tipo === 'test52')?.refusal).toContain(
			'not a text',
		);
	});
});
