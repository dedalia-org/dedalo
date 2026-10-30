/**
 * component_section_id search binds — the placeholder must carry its own cast.
 *
 * THE BUG THIS PINS (found live 2026-08-06, present since the initial TS
 * rewrite): `builder_section_id` emitted `<alias>.section_id::integer = $N`
 * and bound the digit string UNCAST. On its own that is harmless — Postgres
 * infers an untyped parameter as integer from context — which is exactly why
 * every SQL-BUILDING test passed and the defect shipped.
 *
 * It detonates when the SAME literal is also used by a TEXT predicate:
 * `ParamsCollector.getPlaceholder` dedupes by strict value (params.ts), so
 * searching a text component for '5555' AND the record id for '5555' collapses
 * both onto ONE placeholder. That placeholder is then `text` for one predicate
 * and `integer` for the other, and the whole query dies with
 *   operator does not exist: integer = text
 * — a 500, not an empty result. Reported as "the combination of Catalogue and
 * Id fails" on numisdata161 while each field worked alone.
 *
 * These tests therefore EXECUTE the SQL. Building it is not enough: a
 * build-only assertion cannot see a type error that only Postgres raises.
 */

import { beforeAll, describe, expect, test } from 'bun:test';
import '../../src/core/components/registry.ts';
import { sql } from '../../src/core/db/postgres.ts';
import { buildSearchSql } from '../helpers/search_sql.ts';

/** test3 playground: a literal and a section_id component in the same section. */
const SECTION = 'test3';
const TEXT_COMPONENT = 'test52';
const SECTION_ID_COMPONENT = 'test102';

const leaf = (componentTipo: string, q: string) => ({
	q,
	path: [{ section_tipo: SECTION, component_tipo: componentTipo }],
});

const sqoOf = (filters: unknown[]) => ({
	section_tipo: [SECTION],
	limit: 20,
	filter: { $or: filters },
});

/** Build and RUN — the execution is the assertion. */
async function run(filters: unknown[]): Promise<{ rows: number; params: unknown[] }> {
	const built = await buildSearchSql(sqoOf(filters) as never);
	const rows = (await sql.unsafe(
		built.sql.replace(/;$/, ''),
		built.params as (string | number | null)[],
	)) as unknown[];
	return { rows: rows.length, params: built.params as unknown[] };
}

describe('component_section_id search binds are cast, not inferred', () => {
	beforeAll(async () => {
		// The fixture only needs the section to exist; row COUNT is never asserted.
		const rows = (await sql.unsafe(
			`SELECT count(*)::int AS n FROM dd_ontology WHERE tipo IN ($1, $2, $3)`,
			[SECTION, TEXT_COMPONENT, SECTION_ID_COMPONENT],
		)) as { n: number }[];
		expect(rows[0]?.n).toBe(3);
	});

	test('a text filter and an id filter SHARING one literal execute (the reported bug)', async () => {
		// Same '27' twice: ParamsCollector collapses them onto one placeholder,
		// which is what pins it to text and broke the id comparison.
		const { rows, params } = await run([
			leaf(TEXT_COMPONENT, '27'),
			leaf(SECTION_ID_COMPONENT, '27'),
		]);
		expect(rows).toBeGreaterThanOrEqual(0); // executing at all is the point
		// Pin the DEDUPE that makes this case special — if getPlaceholder ever
		// stopped collapsing equal values, this test would still pass but would
		// no longer be testing the reported bug.
		expect(params.filter((value) => value === '27')).toHaveLength(1);
	});

	test('the same pair with DIFFERENT literals also executes', async () => {
		const { rows } = await run([leaf(TEXT_COMPONENT, '11'), leaf(SECTION_ID_COMPONENT, '27')]);
		expect(rows).toBeGreaterThanOrEqual(0);
	});

	// Every operator branch of the builder binds a digit string against the
	// integer column, so every branch needs its own cast — the '=' fix alone
	// would have left five live 500s.
	test.each([
		['equals', '27'],
		['between', '1...99'],
		['sequence', '1,27'],
		['greater or equal', '>=1'],
		['less or equal', '<=99'],
		['greater', '>1'],
		['less', '<99'],
		['not equal', '!=27'],
	])('the %s branch executes when its literal is shared with a text filter', async (_name, q) => {
		const shared = q.replace(/[^0-9]/g, '').slice(0, 2) || '27';
		const { rows } = await run([leaf(TEXT_COMPONENT, shared), leaf(SECTION_ID_COMPONENT, q)]);
		expect(rows).toBeGreaterThanOrEqual(0);
	});
});
