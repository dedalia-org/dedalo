/**
 * component_section_id OPEN-ENDED between ('5...' / '...5') — T1-35 / OX5.
 *
 * THE BUG THIS PINS: `buildSectionIdFragment` returned `false` ("contributes
 * nothing") when either side of '...' was empty. A dropped leaf WIDENS the
 * result: a lone 'id 5...' filter returned every record of the section, and
 * inside an `$and` (or a deep path) the constraint silently vanished.
 *
 * THE RULING (owner C41, T1-35 D1 ruled (b) 2026-11-13): an open range is an
 * OPEN HALF-RANGE — the typed bound is enforced and the absent side adds NO
 * predicate: '...5' = id ≤ 5 (negative ids included), '5...' = id ≥ 5, and
 * '...' with no digits on either side is an EMPTY INPUT (classifier 'none',
 * no clause). PHP substituted empty low → 0 and empty high → low ('5...' =
 * exactly 5, '...' = nothing) — WC-2026-11-12-section-id-open-between +
 * addendum. The row assertions are EXACT lists.
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

// -1: a negative id — PHP's `>= 0` substitute for an absent low excluded it;
// the open half-range includes it.
const ROW_IDS = [-1, 0, 3, 5, 7, 12];

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

	test("'...5' on real rows = id ≤ 5, exactly: -1, 0, 3, 5 (PHP's >= 0 would drop -1)", async () => {
		expect(await matchingIds('...5')).toEqual([-1, 0, 3, 5]);
	});

	test("'5...' on real rows = id ≥ 5, exactly: 5, 7, 12 (PHP meant exactly 5)", async () => {
		expect(await matchingIds('5...')).toEqual([5, 7, 12]);
	});

	test("'...' with no digits on either side is an EMPTY input: classifier 'none', no clause", () => {
		expect(classifySectionId('...', null)).toEqual({ kind: 'pos', op: 'none' });
		expect(classifySectionId('abc...', null)).toEqual({ kind: 'pos', op: 'none' });
		expect(classifySectionId('', '...')).toEqual({ kind: 'pos', op: 'none' });
		expect(buildSectionIdFragment('...', null, ctx)).toBe(false);
		// control: one digit on either side is still a (half-)range
		expect(classifySectionId('...5', null).op).toBe('between');
		expect(classifySectionId('5...', null).op).toBe('between');
	});

	test("the closed range '1...9' is unchanged: exactly 3, 5, 7 (-1 and 0 outside)", async () => {
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
