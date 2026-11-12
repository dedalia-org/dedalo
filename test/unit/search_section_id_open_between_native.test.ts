/**
 * component_section_id OPEN-ENDED between ('5...' / '...5') — T1-35 / OX5.
 *
 * THE BUG THIS PINS: `buildSectionIdFragment` returned `false` ("contributes
 * nothing") when either side of '...' was empty. A dropped leaf WIDENS the
 * result: a lone 'id 5...' filter returned every record of the section, and
 * inside an `$and` (or a deep path) the constraint silently vanished.
 *
 * What is asserted is the part every reading of an open range agrees on: the
 * bound the user TYPED is always enforced. What the ABSENT bound adds (PHP:
 * empty low → 0, empty high → low, so '5...' = exactly 5; or an open
 * half-range with no second predicate) is owner decision D1 of the T1-35 plan,
 * NOT ruled — so the row assertions below are containment/exclusion only,
 * never an exact row list, and '...' with no digits on either side is not
 * asserted at all.
 *
 * The rows are Postgres's answer (the SQL is executed against an inline
 * VALUES table), not the spelling. Read-only; nothing is written.
 */

import { describe, expect, test } from 'bun:test';
import '../../src/core/components/registry.ts';
import { sql } from '../../src/core/db/postgres.ts';
import {
	buildSectionIdFragment,
	classifySectionId,
} from '../../src/core/search/builders/builder_section_id.ts';
import type { BuilderContext, BuilderResult } from '../../src/core/search/builders/types.ts';
import { asSqlTipo } from '../../src/core/search/identifier_gate.ts';
import { ParamsCollector } from '../../src/core/search/params.ts';
import { buildSearchSql } from '../helpers/search_sql.ts';

const ctx: BuilderContext = {
	alias: 'te3',
	column: 'section_id',
	tipo: asSqlTipo('test102', 'test context'),
	sectionTipo: 'test3',
	table: 'matrix_test',
	lang: 'lg-nolan',
	translatable: false,
	model: 'component_section_id',
};

/** Flatten a builder result to one WHERE expression (an $and compound joins with AND). */
function render(result: BuilderResult, collector: ParamsCollector): string {
	if (result === false) throw new Error('builder dropped the clause (returned false)');
	if (result.kind === 'fragment') return collector.substitute(result.sentence, result.tokenValues);
	if (result.kind === 'compound' && result.op === '$and') {
		return result.items.map((child) => `(${render(child, collector)})`).join(' AND ');
	}
	throw new Error(`unexpected builder result ${JSON.stringify(result)}`);
}

const ROW_IDS = [0, 3, 5, 7, 12];

/** EXECUTE the leaf against an inline id table: Postgres decides which ids match. */
async function matchingIds(q: unknown, qOperator: string | null = null): Promise<number[]> {
	const collector = new ParamsCollector();
	const where = render(buildSectionIdFragment(q, qOperator, ctx), collector);
	const values = ROW_IDS.map((id) => `(${id})`).join(', ');
	const rows = (await sql.unsafe(
		`SELECT section_id AS k FROM (VALUES ${values}) AS te3(section_id) WHERE ${where} ORDER BY k`,
		collector.toArray() as (string | number | null)[],
	)) as { k: number }[];
	return rows.map((row) => row.k);
}

describe('an open-ended section_id between keeps the bound that was typed (T1-35)', () => {
	test("'...5' is not dropped and binds '<= 5' with its integer cast", () => {
		const collector = new ParamsCollector();
		const where = render(buildSectionIdFragment('...5', null, ctx), collector);
		expect(where).toContain('te3.section_id::integer <= $');
		expect(where).toMatch(/<= \$\d+::integer/);
		expect(collector.toArray()).toContain('5');
	});

	test("'5...' is not dropped and binds '>= 5' with its integer cast", () => {
		const collector = new ParamsCollector();
		const where = render(buildSectionIdFragment('5...', null, ctx), collector);
		expect(where).toMatch(/te3\.section_id::integer >= \$\d+::integer/);
		expect(collector.toArray()).toContain('5');
	});

	test("the q operator '...' prefix form ('...' + '5') is the same open range", () => {
		const collector = new ParamsCollector();
		const where = render(buildSectionIdFragment('5', '...', ctx), collector);
		expect(where).toMatch(/te3\.section_id::integer <= \$\d+::integer/);
		expect(collector.toArray()).toContain('5');
	});

	test("'...5' on real rows: 0, 3, 5 match; 7 and 12 do not", async () => {
		const ids = await matchingIds('...5');
		expect(ids).toEqual(expect.arrayContaining([0, 3, 5]));
		expect(ids).not.toContain(7);
		expect(ids).not.toContain(12);
	});

	test("'5...' on real rows: 5 matches; 0 and 3 do not", async () => {
		const ids = await matchingIds('5...');
		expect(ids).toContain(5);
		expect(ids).not.toContain(0);
		expect(ids).not.toContain(3);
	});

	test("the closed range '1...9' is unchanged: exactly 3, 5, 7", async () => {
		expect(await matchingIds('1...9')).toEqual([3, 5, 7]);
	});

	test("'!=1...9' still classifies between, bounded by the digits of '!=1'", async () => {
		expect(classifySectionId('!=1...9', null).op).toBe('between');
		expect(await matchingIds('!=1...9')).toEqual([3, 5, 7]);
	});

	test('the full pipeline keeps the predicate and executes (test3 / test102)', async () => {
		const built = await buildSearchSql({
			section_tipo: ['test3'],
			limit: 20,
			filter: {
				$and: [{ q: '5...', path: [{ section_tipo: 'test3', component_tipo: 'test102' }] }],
			},
		} as never);
		expect(built.sql).toMatch(/section_id::integer >= \$\d+::integer/);
		const rows = (await sql.unsafe(
			built.sql.replace(/;$/, ''),
			built.params as (string | number | null)[],
		)) as unknown[];
		expect(rows.length).toBeGreaterThanOrEqual(0); // the cast holds: it executes
	});
});
