/**
 * delete_data ON A VIRTUAL SECTION LEAVES WHAT THE SECTION HIDES (T1-23 / OX3).
 *
 * A virtual section shows its REAL section's components MINUS the subtrees
 * its FIRST `exclude_elements` child names (PHP section_record::delete_data →
 * get_ar_children_tipo_by_model_name_in_section, resolve_virtual=true,
 * class.section.php:900-987). The wipe walked the full section census
 * (declaredSectionComponents) and so emptied fields the curator never sees in
 * the form — TM pairs written for them, media moved, an excluded main's frames
 * stripped. The wipe now walks the WIPE SCOPE (declared_components.ts
 * wipeScopeComponents): the census minus the excluded subtrees — stricter than
 * PHP, which expanded only excluded GROUPERS and so tore an excluded main from
 * its frames.
 *
 * Situation (scratch TLD zzvex, generic `test` root, swept after):
 *   zzvex1   REAL section
 *     zzvex2   input_text          KEEP
 *     zzvex3   input_text          EX_DIRECT (excluded)
 *     zzvex4   section_group       EX_GROUP (excluded)
 *       zzvex5   input_text          GROUPED (inside the excluded grouper)
 *     zzvex6   component_portal    EX_MAIN (excluded)
 *       zzvex7   component_dataframe   its frames
 *     zzvex8   component_portal    KEEP_MAIN
 *       zzvex9   component_dataframe   SHARED_SLOT (also declared by zzvex10's request_config)
 *     zzvex10  component_portal    EX_MAIN2 (excluded) — declares zzvex9 by its own ddo_map
 *     zzvex11  input_text          KEEP2 (named only by the SECOND exclude_elements)
 *   zzvex20  VIRTUAL of zzvex1
 *     zzvex21  exclude_elements (order 1) → [zzvex3, zzvex4, zzvex6, zzvex10]
 *     zzvex22  exclude_elements (order 2) → [zzvex11]  (PHP reads [0] only)
 *   zzvex30  target section of the portals and the frames
 *
 * Gate: RED on HEAD c6a6a79e4a (every excluded value was emptied).
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { sql } from '../../src/core/db/postgres.ts';
import { editScopeComponents } from '../../src/core/ontology/virtual_scope.ts';
import {
	declaredSectionComponents,
	wipeScopeComponents,
} from '../../src/core/section/record/declared_components.ts';
import { deleteSectionData } from '../../src/core/section/record/delete_record.ts';
import {
	dropSituation,
	ensureSituation,
	residueOf,
	situation,
} from '../../src/core/test_data/situations/situation.ts';
import { DB_READY } from '../helpers/db_ready.ts';

const REAL = 'zzvex1';
const VIRTUAL = 'zzvex20';
const TARGET = 'zzvex30';
const TABLE = 'matrix_test';
const USER_ID = -1;

/** The full record and the record holding data ONLY in excluded components. */
const FULL_ID = 1;
const EXCLUDED_ONLY_ID = 2;

const term = (text: string) => ({ 'lg-spa': text, 'lg-eng': text });
const text = (value: string) => [{ id: 1, lang: 'lg-nolan', value }];
const link = (from: string, id: number) => [
	{ id: 1, type: 'dd151', section_tipo: TARGET, section_id: id, from_component_tipo: from },
];
const frame = (slot: string, main: string, target: number) => ({
	id: target,
	type: 'dd490',
	id_key: 1,
	section_tipo: TARGET,
	section_id: target,
	from_component_tipo: slot,
	main_component_tipo: main,
});

const FULL_STRING = {
	zzvex2: text('KEEP'),
	zzvex3: text('EX_DIRECT'),
	zzvex5: text('GROUPED'),
	zzvex11: text('KEEP2'),
};
const FULL_RELATION = {
	zzvex6: link('zzvex6', 1),
	zzvex7: [frame('zzvex7', 'zzvex6', 1)],
	zzvex8: link('zzvex8', 2),
	zzvex9: [frame('zzvex9', 'zzvex8', 2), frame('zzvex9', 'zzvex10', 3)],
	zzvex10: link('zzvex10', 3),
};

const s = situation({
	tld: 'zzvex',
	name: 'delete_data virtual exclude',
	nodes: [
		{
			tipo: TARGET,
			parent: 'test1',
			model: 'section',
			term: term('Destino'),
			relations: [{ tipo: 'test24' }],
		},
		{
			tipo: REAL,
			parent: 'test1',
			model: 'section',
			term: term('Real'),
			relations: [{ tipo: 'test24' }],
		},
		{
			tipo: 'zzvex2',
			parent: REAL,
			model: 'component_input_text',
			order_number: 1,
			term: term('Keep'),
		},
		{
			tipo: 'zzvex3',
			parent: REAL,
			model: 'component_input_text',
			order_number: 2,
			term: term('Ex'),
		},
		{ tipo: 'zzvex4', parent: REAL, model: 'section_group', order_number: 3, term: term('Grupo') },
		{
			tipo: 'zzvex5',
			parent: 'zzvex4',
			model: 'component_input_text',
			order_number: 1,
			term: term('Agrupado'),
		},
		{
			tipo: 'zzvex6',
			parent: REAL,
			model: 'component_portal',
			order_number: 4,
			term: term('Portal excluido'),
			relations: [{ tipo: TARGET }],
		},
		{
			tipo: 'zzvex7',
			parent: 'zzvex6',
			model: 'component_dataframe',
			order_number: 1,
			term: term('Marco excluido'),
			relations: [{ tipo: TARGET }],
		},
		{
			tipo: 'zzvex8',
			parent: REAL,
			model: 'component_portal',
			order_number: 5,
			term: term('Portal'),
			relations: [{ tipo: TARGET }],
		},
		{
			tipo: 'zzvex9',
			parent: 'zzvex8',
			model: 'component_dataframe',
			order_number: 1,
			term: term('Marco compartido'),
			relations: [{ tipo: TARGET }],
		},
		{
			tipo: 'zzvex10',
			parent: REAL,
			model: 'component_portal',
			order_number: 6,
			term: term('Portal excluido 2'),
			relations: [{ tipo: TARGET }],
			properties: {
				source: { request_config: [{ show: { ddo_map: [{ tipo: 'zzvex9' }] } }] },
			},
		},
		{
			tipo: 'zzvex11',
			parent: REAL,
			model: 'component_input_text',
			order_number: 7,
			term: term('Keep2'),
		},
		{
			tipo: VIRTUAL,
			parent: 'test1',
			model: 'section',
			term: term('Virtual'),
			relations: [{ tipo: REAL }],
		},
		{
			tipo: 'zzvex21',
			parent: VIRTUAL,
			model: 'exclude_elements',
			order_number: 1,
			term: term('excluir'),
			relations: [{ tipo: 'zzvex3' }, { tipo: 'zzvex4' }, { tipo: 'zzvex6' }, { tipo: 'zzvex10' }],
		},
		{
			tipo: 'zzvex22',
			parent: VIRTUAL,
			model: 'exclude_elements',
			order_number: 2,
			term: term('excluir 2'),
			relations: [{ tipo: 'zzvex11' }],
		},
	],
	records: [
		{ section_tipo: TARGET, section_id: 1, columns: { data: {} } },
		{ section_tipo: TARGET, section_id: 2, columns: { data: {} } },
		{ section_tipo: TARGET, section_id: 3, columns: { data: {} } },
		{
			section_tipo: VIRTUAL,
			section_id: FULL_ID,
			columns: { string: FULL_STRING, relation: FULL_RELATION },
		},
		{
			section_tipo: VIRTUAL,
			section_id: EXCLUDED_ONLY_ID,
			columns: {
				string: { zzvex3: text('ONLY_EX') },
				relation: { zzvex6: link('zzvex6', 1), zzvex7: [frame('zzvex7', 'zzvex6', 1)] },
			},
		},
		{
			section_tipo: REAL,
			section_id: FULL_ID,
			columns: { string: FULL_STRING, relation: FULL_RELATION },
		},
	],
});

interface Row {
	string: Record<string, unknown> | null;
	relation: Record<string, unknown> | null;
}

async function rowOf(sectionTipo: string, sectionId: number): Promise<Row> {
	const rows = (await sql.unsafe(
		`SELECT string, relation FROM ${TABLE} WHERE section_tipo = $1 AND section_id = $2`,
		[sectionTipo, sectionId],
	)) as Row[];
	return rows[0] ?? { string: null, relation: null };
}

/** The tipos with a Time Machine row for one record. */
async function tmTipos(sectionTipo: string, sectionId: number): Promise<string[]> {
	const rows = (await sql`
		SELECT DISTINCT tipo FROM matrix_time_machine
		WHERE section_tipo = ${sectionTipo} AND section_id = ${sectionId}
	`) as { tipo: string }[];
	return rows.map((row) => row.tipo).sort();
}

const mainsOf = (value: unknown): string[] =>
	(Array.isArray(value) ? (value as { main_component_tipo?: string }[]) : [])
		.map((entry) => String(entry.main_component_tipo))
		.sort();

describe.if(DB_READY)('delete_data on a virtual section (T1-23)', () => {
	let virtualRow: Row;
	let excludedOnlyRow: Row;
	let realRow: Row;
	let virtualTm: string[];
	let excludedOnlyTm: string[];

	beforeAll(async () => {
		await dropSituation(s);
		await ensureSituation(s);
		await deleteSectionData(VIRTUAL, FULL_ID, USER_ID);
		await deleteSectionData(VIRTUAL, EXCLUDED_ONLY_ID, USER_ID);
		await deleteSectionData(REAL, FULL_ID, USER_ID);
		virtualRow = await rowOf(VIRTUAL, FULL_ID);
		excludedOnlyRow = await rowOf(VIRTUAL, EXCLUDED_ONLY_ID);
		realRow = await rowOf(REAL, FULL_ID);
		virtualTm = await tmTipos(VIRTUAL, FULL_ID);
		excludedOnlyTm = await tmTipos(VIRTUAL, EXCLUDED_ONLY_ID);
	}, 60000);

	afterAll(async () => {
		expect(await dropSituation(s)).toBe(0);
		expect(await residueOf(s)).toBe(0);
	});

	test('a directly excluded component keeps its value and gets no TM row', () => {
		expect(virtualRow.string?.zzvex3).toEqual(text('EX_DIRECT'));
		expect(virtualTm).not.toContain('zzvex3');
	});

	test('a component inside an excluded grouper keeps its value', () => {
		expect(virtualRow.string?.zzvex5).toEqual(text('GROUPED'));
		expect(virtualTm).not.toContain('zzvex5');
	});

	test('an excluded main keeps its value AND its frames (never torn)', () => {
		expect(virtualRow.relation?.zzvex6).toEqual(FULL_RELATION.zzvex6);
		expect(virtualRow.relation?.zzvex7).toEqual(FULL_RELATION.zzvex7);
		expect(virtualRow.relation?.zzvex10).toEqual(FULL_RELATION.zzvex10);
		for (const tipo of ['zzvex6', 'zzvex7', 'zzvex10']) expect(virtualTm).not.toContain(tipo);
	});

	test('a shared slot loses only the wiped main frames; the excluded main keeps its own', () => {
		expect(virtualRow.relation?.zzvex8).toBeUndefined();
		expect(mainsOf(virtualRow.relation?.zzvex9)).toEqual(['zzvex10']);
		// The slot's history rides the wiped main's composed row only.
		expect(virtualTm).toContain('zzvex8');
		expect(virtualTm).not.toContain('zzvex10');
	});

	test('a record holding only excluded data keeps it all; no component TM row, stamps refreshed', () => {
		expect(excludedOnlyRow.string?.zzvex3).toEqual(text('ONLY_EX'));
		expect(excludedOnlyRow.relation?.zzvex6).toEqual(link('zzvex6', 1));
		expect(excludedOnlyRow.relation?.zzvex7).toEqual([frame('zzvex7', 'zzvex6', 1)]);
		for (const tipo of ['zzvex3', 'zzvex6', 'zzvex7']) expect(excludedOnlyTm).not.toContain(tipo);
		// PHP refreshes the modified stamps on every wipe.
		expect(excludedOnlyRow.relation?.dd197).toBeDefined();
	});

	test('control: kept components are emptied — only the FIRST exclude_elements counts', () => {
		expect(virtualRow.string?.zzvex2).toBeUndefined();
		expect(virtualRow.string?.zzvex11).toBeUndefined();
		expect(virtualTm).toEqual(expect.arrayContaining(['zzvex2', 'zzvex11']));
	});

	test('control: the REAL section has no exclusion — its record is emptied entirely', () => {
		for (const tipo of Object.keys(FULL_STRING)) expect(realRow.string?.[tipo]).toBeUndefined();
		for (const tipo of Object.keys(FULL_RELATION)) expect(realRow.relation?.[tipo]).toBeUndefined();
	});

	test('alignment: wipe scope ⊆ the census the covered-slot restore recomputes; = edit scope', async () => {
		const scope = await wipeScopeComponents(VIRTUAL);
		const census = new Set((await declaredSectionComponents(VIRTUAL)).map((c) => c.tipo));
		const wipeTipos = scope.components.map((c) => c.tipo);
		for (const tipo of wipeTipos) expect(census.has(tipo)).toBe(true);
		expect(wipeTipos).toEqual(['zzvex2', 'zzvex8', 'zzvex9', 'zzvex11']);
		expect([...scope.excluded].sort()).toEqual(
			['zzvex10', 'zzvex3', 'zzvex4', 'zzvex5', 'zzvex6', 'zzvex7'].sort(),
		);
		expect((await editScopeComponents(VIRTUAL)).map((node) => node.tipo)).toEqual(wipeTipos);
		// A real section's wipe scope IS its census.
		const real = await wipeScopeComponents(REAL);
		expect(real.components.map((c) => c.tipo)).toEqual(
			(await declaredSectionComponents(REAL)).map((c) => c.tipo),
		);
		expect(real.excluded.size).toBe(0);
	});
});
