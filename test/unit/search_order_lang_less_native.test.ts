/**
 * ORDER BY A LANG-LESS COMPONENT SORTS BY ITS VALUE (T1-33 / O07).
 *
 * Only the lang-SLICED models (registry.ts `isLangSlicedModel` — PHP
 * component_string_common subclasses + iri) store items keyed by `lang`. Every
 * other literal model (component_number, component_json, …) is stored
 * lang-LESS: save_component stamps `lang` only on sliced/translatable data. The
 * order select used to apply the lang filter `$[*] ? (@.lang == $lang).value`
 * to EVERY model, so a number/json sort key was NULL on every row and the
 * ORDER BY silently collapsed to the `section_id ASC` tiebreaker. PHP common
 * (`trait.search_component_common.php` build_order_select) reads
 * `'$[*].value'` with no lang predicate; only string_common filters by lang.
 *
 * SITUATION: a scratch `zzolo` section with a number, a json, a translatable
 * input_text and a self-targeting portal. Records are written through the
 * ENGINE writer (createSectionRecord + saveComponentData), so the stored shape
 * is the real lang-less one — a raw INSERT with `lang:'lg-nolan'` would hide
 * the defect. Values are chosen so text and numeric collation agree (the
 * number collation is a separate owner decision).
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { sql } from '../../src/core/db/postgres.ts';
import { clearOntologyDerivedCaches } from '../../src/core/ontology/cache_invalidation.ts';
import { runSearch } from '../../src/core/search/search_statement.ts';
import { buildSearchSql as buildSearchStatement } from '../../src/core/search/sql_assembler.ts';
import { createSectionRecord } from '../../src/core/section/record/create_record.ts';
import { saveComponentData } from '../../src/core/section/record/save_component.ts';
import {
	dropSituation,
	ensureSituation,
	situation,
} from '../../src/core/test_data/situations/situation.ts';
import { assertTestDatabase } from '../../src/core/test_data/test_database_marker.ts';
import { buildSearchSql } from '../helpers/search_sql.ts';

const TLD = 'zzolo';
const SECTION = `${TLD}1`;
const NUMBER = `${TLD}2`; // component_number — lang-less
const JSON_TIPO = `${TLD}3`; // component_json — lang-less
const TEXT = `${TLD}4`; // component_input_text, translatable — lang-sliced
const PORTAL = `${TLD}5`; // component_portal → SECTION (multi-hop path)
const LANG = 'lg-eng';

const SITUATION = situation({
	tld: TLD,
	name: 'search_order_lang_less',
	nodes: [
		{ tipo: SECTION, parent: 'test1', model: 'section', term: { 'lg-eng': 'Order host' } },
		{ tipo: NUMBER, parent: SECTION, model: 'component_number', term: { 'lg-eng': 'Number' } },
		{ tipo: JSON_TIPO, parent: SECTION, model: 'component_json', term: { 'lg-eng': 'Json' } },
		{
			tipo: TEXT,
			parent: SECTION,
			model: 'component_input_text',
			is_translatable: true,
			term: { 'lg-eng': 'Text' },
		},
		{
			tipo: PORTAL,
			parent: SECTION,
			model: 'component_portal',
			term: { 'lg-eng': 'Portal' },
			properties: {
				source: {
					request_config: [
						{
							sqo: { section_tipo: [{ value: [SECTION], source: 'section' }] },
							show: { ddo_map: [{ tipo: NUMBER, parent: 'self', section_tipo: 'self' }] },
						},
					],
				},
			},
		},
	],
});

/** Record ids by role, filled in beforeAll (created in this order). */
const ids = { r0: 0, r1: 0, r2: 0, r3: 0, m1: 0, m2: 0 };

async function save(
	tipo: string,
	sectionId: number,
	lang: string,
	value: unknown[],
): Promise<void> {
	const outcome = await saveComponentData({
		componentTipo: tipo,
		sectionTipo: SECTION,
		sectionId,
		lang,
		changedData: [{ action: 'set_data', id: null, value }],
		userId: -1,
	});
	expect(outcome.ok).toBe(true);
}

/** Ordered section_ids of the owned records named by `owned`, sorted by `order`. */
async function ordered(owned: number[], order: unknown[]): Promise<number[]> {
	const sqo = {
		section_tipo: [SECTION],
		filter_by_locators: owned.map((id) => ({ section_tipo: SECTION, section_id: id })),
		order,
		limit: 100,
		offset: 0,
	};
	const rows = await runSearch<{ section_id: number }>(await buildSearchStatement(sqo as never));
	return rows.map((row) => Number(row.section_id));
}

const step = (tipo: string) => ({ section_tipo: SECTION, component_tipo: tipo });

beforeAll(async () => {
	await assertTestDatabase('search_order_lang_less_native');
	await ensureSituation(SITUATION);
	await clearOntologyDerivedCaches();
	for (const key of Object.keys(ids) as (keyof typeof ids)[]) {
		ids[key] = await createSectionRecord(SECTION, -1);
	}
	const values: [number, number, string, string][] = [
		[ids.r1, 30, 'c', 'gamma'],
		[ids.r2, 10, 'a', 'alpha'],
		[ids.r3, 20, 'b', 'beta'],
	];
	for (const [id, number, key, text] of values) {
		await save(NUMBER, id, 'lg-nolan', [{ value: number }]);
		await save(JSON_TIPO, id, 'lg-nolan', [{ value: { k: key } }]);
		await save(TEXT, id, LANG, [{ value: text, lang: LANG }]);
	}
	const link = (target: number) => [
		{
			type: 'dd151',
			section_tipo: SECTION,
			section_id: String(target),
			from_component_tipo: PORTAL,
		},
	];
	await save(PORTAL, ids.m1, 'lg-nolan', link(ids.r1));
	await save(PORTAL, ids.m2, 'lg-nolan', link(ids.r2));
}, 60_000);

afterAll(async () => {
	await sql.unsafe(
		`DELETE FROM matrix_activity
		  WHERE section_tipo = 'dd542'
		    AND misc->'dd551'->0->'value'->>'section_tipo' LIKE $1`,
		[`${TLD}%`],
	);
	expect(await dropSituation(SITUATION)).toBe(0);
	await clearOntologyDerivedCaches();
});

describe('ORDER BY a lang-less component sorts by its value', () => {
	test('premise: the engine stores number and json items WITHOUT a lang key', async () => {
		const rows = (await sql.unsafe(
			`SELECT number->$2 AS n, misc->$3 AS j FROM matrix_test
			  WHERE section_tipo = $1 AND section_id = $4`,
			[SECTION, NUMBER, JSON_TIPO, ids.r1],
		)) as { n: unknown; j: unknown }[];
		const parse = (raw: unknown) => (typeof raw === 'string' ? JSON.parse(raw) : raw);
		const numberItems = parse(rows[0]?.n) as Record<string, unknown>[];
		const jsonItems = parse(rows[0]?.j) as Record<string, unknown>[];
		// FLOOR: the value really is stored — else the sort cases are vacuous.
		expect(numberItems?.[0]?.value).toBe(30);
		expect(jsonItems?.[0]?.value).toEqual({ k: 'c' });
		expect('lang' in (numberItems[0] as object)).toBe(false);
		expect('lang' in (jsonItems[0] as object)).toBe(false);
	});

	const all = () => [ids.r0, ids.r1, ids.r2, ids.r3];

	test('number ASC → by value, the value-less record last', async () => {
		expect(await ordered(all(), [{ direction: 'ASC', path: [step(NUMBER)] }])).toEqual([
			ids.r2,
			ids.r3,
			ids.r1,
			ids.r0,
		]);
	});

	test('number DESC → by value, NULLS LAST', async () => {
		expect(await ordered(all(), [{ direction: 'DESC', path: [step(NUMBER)] }])).toEqual([
			ids.r1,
			ids.r3,
			ids.r2,
			ids.r0,
		]);
	});

	test('json ASC → by value', async () => {
		expect(await ordered(all(), [{ direction: 'ASC', path: [step(JSON_TIPO)] }])).toEqual([
			ids.r2,
			ids.r3,
			ids.r1,
			ids.r0,
		]);
	});

	test('multi-hop [portal, number] ASC → by the related record value', async () => {
		// m1 → r1 (30), m2 → r2 (10): section_id order would be m1, m2.
		expect(
			await ordered([ids.m1, ids.m2], [{ direction: 'ASC', path: [step(PORTAL), step(NUMBER)] }]),
		).toEqual([ids.m2, ids.m1]);
	});

	test('sibling: a translatable input_text still sorts by its value in the asked lang', async () => {
		expect(await ordered(all(), [{ direction: 'DESC', path: [step(TEXT)], lang: LANG }])).toEqual([
			ids.r1,
			ids.r3,
			ids.r2,
			ids.r0,
		]);
	});

	test('SQL shape: lang predicate only on the lang-sliced model', async () => {
		const shown = async (tipo: string, lang?: string) =>
			(
				await buildSearchSql({
					section_tipo: [SECTION],
					order: [{ direction: 'ASC', path: [step(tipo)], ...(lang ? { lang } : {}) }],
					limit: 10,
				} as never)
			).sql;
		const numberSql = await shown(NUMBER);
		expect(numberSql).toContain(`'$[*].value'`);
		expect(numberSql).not.toContain('@.lang');
		const jsonSql = await shown(JSON_TIPO);
		expect(jsonSql).not.toContain('@.lang');
		expect(await shown(TEXT, LANG)).toContain('@.lang == $lang');
	});
});
