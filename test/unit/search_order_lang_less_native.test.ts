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
 * the defect. The value cases use numbers whose text and numeric collation
 * agree; the COLLATION case (c9/c10/c2) pins the ruling: component_number
 * sorts NUMERICALLY (owner C38 2026-11-13, WC-2026-11-13-number-sort-numeric —
 * PHP / v6 extracted the key as text, 10 < 2 < 9), so 9, 10, 2 ASC → 2, 9, 10.
 *
 * UNSORTABLE MODELS are REFUSED (owner C39 2026-11-13,
 * WC-2026-11-13-sort-non-scalar-refused): a descriptor `sortable: false` —
 * component_password (a secret: the row order would be a comparison oracle over
 * the hashes), component_iri (no `.value` scalar; PHP sorted it by NULL) — in
 * an order path answers `search.invalid_sqo`, never a silent NULL sort.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { sql } from '../../src/core/db/postgres.ts';
import { clearOntologyDerivedCaches } from '../../src/core/ontology/cache_invalidation.ts';
import { runWithRequestLangs } from '../../src/core/resolve/request_lang.ts';
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
import { inSplitLane, laneLabel, SPLIT_LANES } from '../helpers/split_request_langs.ts';

const TLD = 'zzolo';
const SECTION = `${TLD}1`;
const NUMBER = `${TLD}2`; // component_number — lang-less
const JSON_TIPO = `${TLD}3`; // component_json — lang-less
const TEXT = `${TLD}4`; // component_input_text, translatable — lang-sliced
const PORTAL = `${TLD}5`; // component_portal → SECTION (multi-hop path)
const PASSWORD = `${TLD}6`; // component_password — a SECRET, never a sort key (C39)
const IRI = `${TLD}7`; // component_iri — {iri, title} frames, no .value scalar (C39)
const LANG = 'lg-eng';
/** The second data lang of the T2-SL-2 case: its values sort the OTHER way round. */
const OTHER_LANG = 'lg-spa';

const SITUATION = situation({
	tld: TLD,
	name: 'search_order_lang_less',
	nodes: [
		{ tipo: SECTION, parent: 'test1', model: 'section', term: { 'lg-eng': 'Order host' } },
		{ tipo: NUMBER, parent: SECTION, model: 'component_number', term: { 'lg-eng': 'Number' } },
		{ tipo: JSON_TIPO, parent: SECTION, model: 'component_json', term: { 'lg-eng': 'Json' } },
		{ tipo: PASSWORD, parent: SECTION, model: 'component_password', term: { 'lg-eng': 'Pw' } },
		{ tipo: IRI, parent: SECTION, model: 'component_iri', term: { 'lg-eng': 'Iri' } },
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
const ids = { r0: 0, r1: 0, r2: 0, r3: 0, m1: 0, m2: 0, c9: 0, c10: 0, c2: 0 };

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
	// The lg-spa text sorts the reverse way of the lg-eng one (r1 < r3 < r2),
	// so an order resolved in the wrong data lang is visible (T2-SL-2).
	const values: [number, number, string, string, string][] = [
		[ids.r1, 30, 'c', 'gamma', 'a-uno'],
		[ids.r2, 10, 'a', 'alpha', 'c-dos'],
		[ids.r3, 20, 'b', 'beta', 'b-tres'],
	];
	for (const [id, number, key, text, otherText] of values) {
		await save(NUMBER, id, 'lg-nolan', [{ value: number }]);
		await save(JSON_TIPO, id, 'lg-nolan', [{ value: { k: key } }]);
		await save(TEXT, id, LANG, [{ value: text, lang: LANG }]);
		await save(TEXT, id, OTHER_LANG, [{ value: otherText, lang: OTHER_LANG }]);
	}
	const link = (target: number) => [
		{
			type: 'dd151',
			section_tipo: SECTION,
			section_id: String(target),
			from_component_tipo: PORTAL,
		},
	];
	for (const [id, number] of [
		[ids.c9, 9],
		[ids.c10, 10],
		[ids.c2, 2],
	] as const) {
		await save(NUMBER, id, 'lg-nolan', [{ value: number }]);
	}
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

	test('collation: component_number sorts NUMERICALLY — 9, 10, 2 ASC → 2, 9, 10 (C38)', async () => {
		// Text collation (PHP / v6, and TS before C38) gave [c10, c2, c9]; the
		// section_id tiebreaker alone would give [c9, c10, c2].
		expect(
			await ordered([ids.c9, ids.c10, ids.c2], [{ direction: 'ASC', path: [step(NUMBER)] }]),
		).toEqual([ids.c2, ids.c9, ids.c10]);
		expect(
			await ordered([ids.c9, ids.c10, ids.c2], [{ direction: 'DESC', path: [step(NUMBER)] }]),
		).toEqual([ids.c10, ids.c9, ids.c2]);
	});

	test('SQL shape: the number sort key is a guarded numeric cast (a legacy string item sorts NULL, never 500s)', async () => {
		const built = await buildSearchSql({
			section_tipo: [SECTION],
			order: [{ direction: 'ASC', path: [step(NUMBER)] }],
			limit: 10,
		} as never);
		expect(built.sql).toContain(`jsonb_typeof(jsonb_path_query_first(`);
		expect(built.sql).toMatch(
			/= 'number' THEN \(jsonb_path_query_first\([^)]*\) #>> '\{\}'\)::numeric END\)/,
		);
	});

	describe('C39 — an order by an unsortable model is REFUSED (search.invalid_sqo)', () => {
		const refusal = async (tipo: string) => {
			try {
				await buildSearchStatement({
					section_tipo: [SECTION],
					order: [{ direction: 'ASC', path: [step(tipo)] }],
					limit: 10,
					offset: 0,
				} as never);
			} catch (error) {
				return error as { code?: string; message?: string };
			}
			throw new Error(`order by ${tipo} was accepted`);
		};

		test('component_password: the ordering oracle over stored hashes is closed', async () => {
			const error = await refusal(PASSWORD);
			expect(error.code).toBe('search.invalid_sqo');
			expect(error.message).toContain(PASSWORD);
			expect(error.message).toContain('component_password');
		});

		test('component_iri: no .value scalar — refused, not a silent NULL sort', async () => {
			const error = await refusal(IRI);
			expect(error.code).toBe('search.invalid_sqo');
			expect(error.message).toContain('component_iri');
		});

		test('control: the sortable models are untouched (number, json, input_text build)', async () => {
			for (const tipo of [NUMBER, JSON_TIPO, TEXT]) {
				const built = await buildSearchSql({
					section_tipo: [SECTION],
					order: [{ direction: 'ASC', path: [step(tipo)] }],
					limit: 10,
				} as never);
				expect(built.sql).toContain(`${tipo}_order ASC`);
			}
		});
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

	test('T2-SL-2: an order WITHOUT lang sorts in the REQUEST data lang, not the install DATA_LANG', async () => {
		// Two request data langs, one translatable column, no `lang` on the order
		// entry: each request must get the order of ITS slice. The install
		// default (a module constant before T2-SL-2) answered the same order to
		// both, so one of the two lanes was always wrong.
		// The two request langs are SPLIT (data ≠ application, swapped in the
		// second lane — review M1), so an order resolved in the interface lang
		// gets the OTHER slice's order and is red in both lanes.
		const order = [{ direction: 'ASC', path: [step(TEXT)] }];
		const expected: Readonly<Record<string, number[]>> = {
			[LANG]: [ids.r2, ids.r3, ids.r1, ids.r0],
			[OTHER_LANG]: [ids.r1, ids.r3, ids.r2, ids.r0],
		};
		for (const lane of SPLIT_LANES) {
			expect(await inSplitLane(lane, () => ordered(all(), order)), laneLabel(lane)).toEqual(
				expected[lane.dataLang] as number[],
			);
			// An explicit order `lang` still wins over the request data lang.
			const explicit = [{ direction: 'ASC', path: [step(TEXT)], lang: lane.applicationLang }];
			expect(await inSplitLane(lane, () => ordered(all(), explicit)), laneLabel(lane)).toEqual(
				expected[lane.applicationLang] as number[],
			);
		}
	});

	test('review M5: a malformed request-scope lang is REFUSED, never interpolated into SQL', async () => {
		// The order lang is spliced into the SQL text; the entry's own `lang` is
		// gated at the caller, the request-scope fallback was not.
		const order = [{ direction: 'ASC', path: [step(TEXT)] }];
		for (const bad of [`lg-eng"}') OR 1=1 --`, 'all; DROP TABLE x', '']) {
			let thrown: unknown;
			try {
				await runWithRequestLangs({ applicationLang: LANG, dataLang: bad }, () =>
					buildSearchSql({ section_tipo: [SECTION], order, limit: 10 } as never),
				);
			} catch (error) {
				thrown = error;
			}
			expect((thrown as { code?: string } | undefined)?.code, bad).toBe('request.invalid');
			expect(String((thrown as Error | undefined)?.message), bad).toContain(
				'order lang (request scope)',
			);
		}
		// Control: a well-formed scope lang builds.
		const built = await runWithRequestLangs({ applicationLang: LANG, dataLang: OTHER_LANG }, () =>
			buildSearchSql({ section_tipo: [SECTION], order, limit: 10 } as never),
		);
		expect(built.sql).toContain('@.lang == $lang');
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
