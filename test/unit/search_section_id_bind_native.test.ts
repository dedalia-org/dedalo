/**
 * Typed search binds never share a placeholder with a text bind — EXECUTED.
 *
 * THE STORY, in two bugs:
 *
 * 1. (2026-08-06) `builder_section_id` emitted `<alias>.section_id::integer = $N`
 *    with the digit string bound UNCAST. Alone that is harmless — Postgres
 *    infers an untyped parameter from context — so every SQL-BUILDING test
 *    passed. It detonated when a TEXT leaf searched the same literal:
 *    `ParamsCollector.getPlaceholder` then DEDUPED equal values across
 *    fragments, both predicates shared one `$N`, text came first, and the query
 *    died with "operator does not exist: integer = text" ("Catalogue + Id
 *    fails" on a numismatic catalogue). The fix cast the id bind (`$N::integer`)
 *    — which only covered TEXT-FIRST order.
 *
 * 2. (2026-11) The mirror: an autocomplete whose ddo_map searches a
 *    component_section_id FIRST and text components after, same numeric q. The
 *    shared `$N` is now typed integer by its first use (`$N::integer`), and the
 *    text leaf's `f_unaccent($N)` dies: "function f_unaccent(integer) does not
 *    exist". The same hazard stood between every typed family (::numeric,
 *    ::jsonpath, ::date, ::integer[]) and text, in either order.
 *
 * THE FIX IS THE LAW, not another cast: a placeholder is never shared between
 * fragments (src/core/search/params.ts header). Each fragment binds its own
 * copy of the literal and types it independently.
 *
 * So this gate pins, for every typed family test3 carries (section_id — every
 * operator branch —, number, date, iri), a typed leaf sharing its literal with
 * a text leaf IN BOTH ORDERS, plus the autocomplete shape; and where the typed
 * fragment binds the literal, that the literal is bound ONCE PER FRAGMENT
 * (twice in params) — the outcome the law produces, not a spelling of it.
 *
 * date: on an ordinary matrix table the date builder inlines its times into a
 * jsonpath literal (no bind), so its cases only prove execution; its `::date`
 * binds exist only on the time-machine/activity tables.
 *
 * These tests EXECUTE the SQL. Building it is not enough: a build-only
 * assertion cannot see a type error only Postgres raises.
 */

import { beforeAll, describe, expect, test } from 'bun:test';
import '../../src/core/components/registry.ts';
import { sql } from '../../src/core/db/postgres.ts';
import { buildSearchSql } from '../helpers/search_sql.ts';

/** test3 playground: one text component and one component per typed family. */
const SECTION = 'test3';
const TEXT_COMPONENT = 'test52'; // component_input_text
const SECTION_ID_COMPONENT = 'test102'; // component_section_id
const NUMBER_COMPONENT = 'test211'; // component_number
const DATE_COMPONENT = 'test145'; // component_date
const IRI_COMPONENT = 'test140'; // component_iri

const FIXTURE_TIPOS = [
	SECTION,
	TEXT_COMPONENT,
	SECTION_ID_COMPONENT,
	NUMBER_COMPONENT,
	DATE_COMPONENT,
	IRI_COMPONENT,
];

const leaf = (componentTipo: string, q: string) => ({
	q,
	path: [{ section_tipo: SECTION, component_tipo: componentTipo }],
});

const sqoOf = (filter: unknown) => ({
	section_tipo: [SECTION],
	limit: 20,
	filter,
});

/** Build and RUN — the execution is the assertion. */
async function run(filter: unknown): Promise<{ rows: number; params: unknown[] }> {
	const built = await buildSearchSql(sqoOf(filter) as never);
	const rows = (await sql.unsafe(
		built.sql.replace(/;$/, ''),
		built.params as (string | number | null)[],
	)) as unknown[];
	return { rows: rows.length, params: built.params as unknown[] };
}

const countOf = (params: unknown[], value: unknown) =>
	params.filter((param) => param === value).length;

/**
 * [family, component, typed q, the literal the TEXT leaf searches, the minimum
 * copies of that literal in params]. `shared` is exactly what the typed
 * builder binds, so the two fragments really did meet on one value: 2 = one
 * copy per fragment; 1 = the typed fragment binds nothing (date, inlined
 * jsonpath); 0 = neither binds the raw q (both '*' leaves bind their own
 * jsonpath path) — execution-only cases.
 */
const TYPED_CASES: [string, string, string, string, number][] = [
	['section_id equals', SECTION_ID_COMPONENT, '27', '27', 2],
	['section_id between', SECTION_ID_COMPONENT, '1...99', '99', 2],
	['section_id sequence', SECTION_ID_COMPONENT, '1,27', '{1,27}', 2],
	['section_id greater or equal', SECTION_ID_COMPONENT, '>=1', '1', 2],
	['section_id less or equal', SECTION_ID_COMPONENT, '<=99', '99', 2],
	['section_id greater', SECTION_ID_COMPONENT, '>1', '1', 2],
	['section_id less', SECTION_ID_COMPONENT, '<99', '99', 2],
	['section_id not equal', SECTION_ID_COMPONENT, '!=27', '27', 2],
	['number equals', NUMBER_COMPONENT, '27', '27', 2],
	['number between', NUMBER_COMPONENT, '1...99', '99', 2],
	['number compare', NUMBER_COMPONENT, '>=1', '1', 2],
	['number not equal', NUMBER_COMPONENT, '!=27', '27', 2],
	['date year', DATE_COMPONENT, '2020', '2020', 1],
	['iri text', IRI_COMPONENT, '27', '27', 2],
	['iri not empty', IRI_COMPONENT, '*', '*', 0],
];

describe('a typed bind never shares its placeholder with a text bind', () => {
	beforeAll(async () => {
		// The fixture only needs the nodes to exist; row COUNT is never asserted.
		const rows = (await sql.unsafe(
			`SELECT count(*)::int AS n FROM dd_ontology WHERE tipo = ANY($1::text[])`,
			[`{${FIXTURE_TIPOS.join(',')}}`],
		)) as { n: number }[];
		expect(rows[0]?.n).toBe(FIXTURE_TIPOS.length);
	});

	test('the reported bug: text FIRST, id second, one literal', async () => {
		const { rows, params } = await run({
			$or: [leaf(TEXT_COMPONENT, '27'), leaf(SECTION_ID_COMPONENT, '27')],
		});
		expect(rows).toBeGreaterThanOrEqual(0); // executing at all is the point
		// One bound value PER FRAGMENT: the two leaves never meet on one `$N`.
		expect(countOf(params, '27')).toBe(2);
	});

	test('the autocomplete shape: $or of section_id FIRST + two text leaves, same q', async () => {
		// numisdata675's ddo_map: section_id, then two input_text components.
		// Under the old cross-fragment dedup this died with
		// "function f_unaccent(integer) does not exist".
		const { rows, params } = await run({
			$or: [
				leaf(SECTION_ID_COMPONENT, '123'),
				leaf(TEXT_COMPONENT, '123'),
				leaf(TEXT_COMPONENT, '123'),
			],
		});
		expect(rows).toBeGreaterThanOrEqual(0);
		// The id leaf binds '123' once; each text leaf binds its own copy.
		expect(countOf(params, '123')).toBeGreaterThanOrEqual(3);
	});

	test('the same pair with DIFFERENT literals also executes', async () => {
		const { rows } = await run({
			$or: [leaf(TEXT_COMPONENT, '11'), leaf(SECTION_ID_COMPONENT, '27')],
		});
		expect(rows).toBeGreaterThanOrEqual(0);
	});

	for (const order of ['typed first', 'text first'] as const) {
		test.each(TYPED_CASES)(
			`%s executes sharing its literal with a text leaf (${order})`,
			async (_name, component, q, shared, minimumCopies) => {
				const typed = leaf(component, q);
				const text = leaf(TEXT_COMPONENT, shared);
				const { rows, params } = await run({
					$or: order === 'typed first' ? [typed, text] : [text, typed],
				});
				expect(rows).toBeGreaterThanOrEqual(0);
				// The text leaf always binds `shared`; when the typed fragment binds
				// it too, the two copies stay separate placeholders.
				expect(countOf(params, shared)).toBeGreaterThanOrEqual(minimumCopies);
			},
		);
	}
});
