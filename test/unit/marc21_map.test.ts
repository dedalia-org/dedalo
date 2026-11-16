/**
 * R2 drive gate: MARC21 map application + import, scratch-twin against the real
 * DB. extractMarcValue/transformMarcValue/applyMarcMap are pure-tested; then a synthetic MARC record
 * + a synthetic marc21_map is imported into a DISPOSABLE record (deleted after),
 * closing the "marc21_map→section import drive".
 */
// MIGRATED TO THE GENERIC `test` TLD, 2026-08-19: every install tipo this gate
// spelled is now its generic twin (sections on the `test` TLD, storing in
// matrix_test). A pure rename — the tipo is an identifier in a path, a filename
// or a locator here, so no corpus and no DB round-trip were added.
// The census entry that remains for this file is a FALSE POSITIVE: the token is
// the module path `src/core/tools/marc21.ts` (the MARC21 cataloguing standard),
// not a tipo. `marc` is not an install TLD and should leave INSTALL_TLDS.

import { afterAll, describe, expect, test } from 'bun:test';
import { readMatrixRecord } from '../../src/core/db/matrix.ts';
import { getMatrixTableFromTipo } from '../../src/core/ontology/resolver.ts';
import { readComponentItems } from '../../src/core/resolve/component_data.ts';
import { deleteSectionRecord } from '../../src/core/section/record/delete_record.ts';
import { importMappedRecords } from '../../src/core/tools/import_execute.ts';
import {
	applyMarcMap,
	extractMarcValue,
	type MarcMapEntry,
	parseMarcRecord,
	transformMarcValue,
} from '../../src/core/tools/marc21.ts';

const SECTION = 'test2966';
const INPUT_TEXT = 'test2968';
const USER = -1;
/** The importing PRINCIPAL (req 10: the executor asks the write door as it) — the superuser, so the door is not this gate's subject. */
const IMPORTER = { userId: -1, isGlobalAdmin: true, isDeveloper: true } as const;
const FT = '\x1e';
const SD = '\x1f';
const RT = '\x1d';

function buildMarc(
	fields: {
		tag: string;
		value?: string;
		ind1?: string;
		ind2?: string;
		subs?: [string, string][];
	}[],
): Uint8Array {
	const bodies = fields.map((f) =>
		f.value !== undefined
			? `${f.value}${FT}`
			: `${f.ind1 ?? ' '}${f.ind2 ?? ' '}${(f.subs ?? []).map(([c, v]) => `${SD}${c}${v}`).join('')}${FT}`,
	);
	let directory = '';
	let start = 0;
	fields.forEach((f, i) => {
		const len = new TextEncoder().encode(bodies[i]!).length;
		directory += f.tag + String(len).padStart(4, '0') + String(start).padStart(5, '0');
		start += len;
	});
	directory += FT;
	const baseAddress = 24 + directory.length;
	const data = bodies.join('') + RT;
	const recordLength = baseAddress + new TextEncoder().encode(data).length;
	const leader = `${String(recordLength).padStart(5, '0')}nam a22${String(baseAddress).padStart(5, '0')}n a4500`;
	return new TextEncoder().encode(leader + directory + data);
}

// Probe DB availability NARROWLY (ontology lookup only, import_drive.test.ts
// pattern) at module load so test.if can consume it: a DB-less machine REPORTS
// the drive as skipped, while a thrown regression inside the drive body FAILS
// instead of silently returning.
const dbAvailable = await getMatrixTableFromTipo(SECTION)
	.then((table) => table !== null)
	.catch(() => false);

const createdIds: number[] = [];
afterAll(async () => {
	for (const id of createdIds) {
		try {
			await deleteSectionRecord(SECTION, id, USER);
		} catch {
			/* best-effort */
		}
	}
});

describe('MARC21 map application (pure)', () => {
	const record = parseMarcRecord(
		buildMarc([
			{ tag: '001', value: 'REC-1' },
			{
				tag: '245',
				ind1: '1',
				ind2: '0',
				subs: [
					['a', 'The Title'],
					['c', 'An Author'],
				],
			},
		]),
	);

	test('extractMarcValue by subfield / joined / control field', () => {
		expect(extractMarcValue(record, { field: '245', subfield: 'a' })).toBe('The Title');
		expect(extractMarcValue(record, { field: '245' })).toBe('The Title An Author');
		// A control field is readable (PHP read '' there — kept extension, WC).
		expect(extractMarcValue(record, { field: '001' })).toBe('REC-1');
		expect(extractMarcValue(record, { field: '999' })).toBe('');
	});

	// T1-6: the PHP get_value / get_field / extract_marc21_value semantics.
	const repeated = parseMarcRecord(
		buildMarc([
			{ tag: '700', subs: [['a', 'First, A.']] },
			{
				tag: '700',
				subs: [
					['a', 'Second, B.'],
					['e', 'ed.'],
				],
			},
			{ tag: '710', subs: [['a', 'An Entity']] },
			{
				tag: '945',
				subs: [
					['a', 'Shelf X'],
					['j', '100'],
				],
			},
			{
				tag: '945',
				subs: [
					['a', 'Shelf Y'],
					['j', '193'],
				],
			},
		]),
	);

	test('without field_multiple only the FIRST occurrence is read', () => {
		expect(extractMarcValue(repeated, { field: '700', subfield: 'a' })).toBe('First, A.');
	});

	test('field_multiple joins every occurrence of every listed tag (PHP default ". ")', () => {
		expect(
			extractMarcValue(repeated, { field: ['700', '710'], field_multiple: true, subfield: 'a' }),
		).toBe('First, A.. Second, B.. An Entity');
		expect(
			extractMarcValue(repeated, {
				field: '700',
				field_multiple: true,
				row_separator: ' | ',
				subfield_separator: ' - ',
			}),
		).toBe('First, A. | Second, B. - ed.');
	});

	test('conditional: the guarded occurrence, else NO value (owner C16 — never another copy)', () => {
		const guard = (value: string) => ({
			field: '945',
			subfield: 'a',
			marc21_conditional: { subfield: 'j', value },
		});
		expect(extractMarcValue(repeated, guard('193'))).toBe('Shelf Y');
		// PHP fell back to the first occurrence — another library's copy data.
		expect(extractMarcValue(repeated, guard('555'))).toBe('');
	});

	test("occurrences:'all' joins every occurrence of the ONE tag without field_multiple (owner C17)", () => {
		expect(extractMarcValue(repeated, { field: '700', subfield: 'a', occurrences: 'all' })).toBe(
			'First, A.. Second, B.',
		);
		expect(
			extractMarcValue(repeated, { field: '700', occurrences: 'all', row_separator: ' | ' }),
		).toBe('First, A. | Second, B. ed.');
		// A tag with one occurrence, and one with none, read as before.
		expect(extractMarcValue(repeated, { field: '710', subfield: 'a', occurrences: 'all' })).toBe(
			'An Entity',
		);
		expect(extractMarcValue(repeated, { field: '999', occurrences: 'all' })).toBe('');
	});

	test('transformMarcValue: punctuation, partial_left_content, year, dd_data_map, id', () => {
		const entry = (over: Partial<MarcMapEntry> = {}): MarcMapEntry => ({
			component_tipo: INPUT_TEXT,
			field: '260',
			...over,
		});
		expect(transformMarcValue('Barcelona :', entry())).toEqual({
			kind: 'literal',
			text: 'Barcelona',
		});
		expect(transformMarcValue('[1987]', entry())).toEqual({ kind: 'literal', text: '[1987]' });
		expect(transformMarcValue('c1987.', entry({ partial_left_content: 4 }))).toEqual({
			kind: 'literal',
			text: '1987',
		});
		expect(
			transformMarcValue('c1987.', entry({ partial_left_content: 4, date_format: 'year' })),
		).toEqual({ kind: 'structured', json: '[{"start":{"year":1987}}]' });
		expect(transformMarcValue('s.d.', entry({ date_format: 'year' })).kind).toBe('refused');
		const languages = { spa: [{ section_tipo: 'lg1', section_id: '1' }], und: [] };
		expect(transformMarcValue('spa', entry({ dd_data_map: languages }))).toEqual({
			kind: 'structured',
			json: '[{"section_tipo":"lg1","section_id":"1"}]',
		});
		expect(transformMarcValue('yyy', entry({ dd_data_map: languages }))).toEqual({
			kind: 'refused',
			reason: "no dd_data_map entry for 'yyy'",
		});
		// The id is the code lookup's value: trimmed, never stripped.
		expect(transformMarcValue(' B123. ', entry({ is_id: true }))).toEqual({
			kind: 'literal',
			text: 'B123.',
		});
	});

	test('applyMarcMap: dd_action follows a value, never a clear; "0" is a value', () => {
		const zero = parseMarcRecord(
			buildMarc([
				{ tag: '020', subs: [['a', '0']] },
				{ tag: '041', subs: [['a', 'und']] },
			]),
		);
		const action = { test87: [{ section_tipo: 'dd64', section_id: '1' }] };
		const mapped = applyMarcMap(zero, [
			{ component_tipo: INPUT_TEXT, field: '020', subfield: 'a', dd_action: action },
			{
				component_tipo: 'test91',
				field: '041',
				subfield: 'a',
				dd_data_map: { und: [] },
				dd_action: action,
			},
		]);
		expect(mapped.fields).toEqual([
			{ component_tipo: INPUT_TEXT, values: ['0'], literal: true },
			{ component_tipo: 'test87', values: ['[{"section_tipo":"dd64","section_id":"1"}]'] },
			{ component_tipo: 'test91', values: ['[]'] },
		]);
	});

	test('applyMarcMap resolves fields + carries the identifier verbatim', () => {
		const map: MarcMapEntry[] = [{ component_tipo: INPUT_TEXT, field: '245', subfield: 'a' }];
		const mapped = applyMarcMap(record, map, { field: '001' });
		// `literal`: the value is TEXT, never parsed as a JSON cell (T1-6).
		expect(mapped.fields).toEqual([
			{ component_tipo: INPUT_TEXT, values: ['The Title'], literal: true },
		]);
		// DATA-08 (2026-08-30): the control field's value is an IDENTIFIER, carried
		// as-is for the door's code lookup. It was previously read as a section_id,
		// so this record addressed record 1 whenever the ILS number happened to
		// start with a digit; 'REC-1' merely happened to escape that cast.
		expect(mapped.code).toBe('REC-1');
	});
});

describe('MARC21 import drive (scratch-twin, real DB)', () => {
	test.if(dbAvailable)(
		'mapped MARC record → created section record with the mapped value',
		async () => {
			const record = parseMarcRecord(
				buildMarc([{ tag: '245', ind1: '1', ind2: '0', subs: [['a', 'MARC Imported Title']] }]),
			);
			const mapped = applyMarcMap(record, [
				{ component_tipo: INPUT_TEXT, field: '245', subfield: 'a' },
			]);
			// No id field configured ⇒ the record names no identifier ⇒ create. The
			// mapper hands the door `code`, and the door is what turns an identifier
			// into an address (import_code_lookup.ts); the executor only ever sees a
			// resolved sectionId, which here is null.
			expect(mapped.code).toBeNull();
			const created = await importMappedRecords(
				[{ sectionId: null, fields: mapped.fields }],
				SECTION,
				IMPORTER,
			);
			createdIds.push(...created.createdIds);
			expect(created.created).toBe(1);
			const newId = created.createdIds[0]!;
			const table = await getMatrixTableFromTipo(SECTION);
			const stored =
				readComponentItems(
					(await readMatrixRecord(table!, SECTION, newId))!,
					INPUT_TEXT,
					'component_input_text',
				) ?? [];
			expect(stored).toContainEqual(expect.objectContaining({ value: 'MARC Imported Title' }));
		},
	);
});
