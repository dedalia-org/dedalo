/**
 * dd542 Activity list — structural order served by the `timestamp` index (WC-054).
 *
 * WHY. The dd542 list orders by a structural key: `id DESC` (the dd549 default,
 * insertion order) or `section_id <dir>` (the When header — WC-044 maps When to
 * section_id). Both are unique monotonic keys on an append-only log, so both
 * ARE the requested order. But neither is reachable from the `timestamp` column
 * a When SEARCH filters on, and that combination is the trap: with a wide date
 * predicate (a year-only or year+month value expands to the whole period —
 * builder_date periodBounds) the planner drops the ("timestamp", id) index and
 * walks the id PK / (section_tipo, section_id DESC) index BACKWARDS, filtering
 * on timestamp, betting that 30 matches turn up within ~30/selectivity rows.
 * On an append-only log the qualifying rows are one contiguous id block, so any
 * range that does not touch "now" makes that scan walk every newer row first.
 * Measured on the 32.9M-row mdcat matrix_activity, `When = 2023-06`:
 *   ORDER BY id DESC              → >300 s (statement timeout, never completed)
 *   ORDER BY "timestamp" DESC, id DESC →   1.1 ms (backward index-ONLY scan)
 * A whole YEAR is 0.7 ms on the same shape: the cost is O(LIMIT), independent
 * of the range width, because the sort key and the filtered column are now the
 * same column and the existing ("timestamp", id) INCLUDE index delivers the
 * order outright — no sort node at all.
 *
 * THE CONTRACT. On matrix_activity a single structural-key order (`id` /
 * `section_id`) is emitted as `"timestamp" <dir>, id <dir>`. The `id`
 * tiebreaker keeps the order a UNIQUE total order (pagination stability), and
 * both columns must carry the SAME direction — a btree reads forwards or
 * backwards only, so `(timestamp ASC, id ASC)` serves `DESC, DESC` reversed but
 * never a mixed pair (the DIRECTION note in matrix_index_policy.ts).
 *
 * NOT byte-identical to `id DESC` — equivalent, and ledgered as such (WC-054):
 * measured on the real log, ~7 rows per million are stamped microseconds out of
 * id order (busiest bulk day 2023-06-28: 10 inversions in 1,412,451 rows, worst
 * 224 µs), so two sub-millisecond neighbours can swap. Scoped to
 * matrix_activity: every other section keeps its structural order untouched.
 *
 * The deep-page rewrites must survive the composite key — that is the other
 * half of this gate (the page is still acquired by the unique `id`, so the
 * join-back stays 1:1); their ROW-level equivalence is proven against a live DB
 * by activity_deep_offset_flip.test.ts.
 */
// Migrated to the generic `test` TLD 2026-08-19: the control section/component are
// test-TLD nodes (no install corpus is read — this gate only builds SQL).

import { describe, expect, test } from 'bun:test';
import type { Sqo } from '../../src/core/concepts/sqo.ts';
import { buildSearchSql } from '../helpers/search_sql.ts';

const ACTIVITY_TIPO = 'dd542';
/** An ordinary section (its own matrix table) — the control. */
const CONTROL_TIPO = 'test3';

/** The composite order the assembler must emit for a dd542 structural sort. */
const TIME_ORDER = (dir: 'ASC' | 'DESC'): RegExp =>
	new RegExp(`ORDER BY\\s+(?:[a-z0-9_]+\\.)?"timestamp" ${dir}, (?:[a-z0-9_]+\\.)?id ${dir}`);

function sqoFor(sectionTipo: string, order: unknown, extra: Record<string, unknown> = {}): Sqo {
	return {
		section_tipo: [sectionTipo],
		limit: 30,
		offset: 0,
		order,
		...extra,
	} as unknown as Sqo;
}

/** The When (dd547) search filter the client sends for a year+month value. */
const WHEN_FILTER = {
	$and: [
		{
			q: '2023-06',
			path: [{ section_tipo: ACTIVITY_TIPO, component_tipo: 'dd547', model: 'component_date' }],
		},
	],
};

describe('dd542 structural order → timestamp composite order (WC-054)', () => {
	test('the dd549 list default (id DESC) is emitted as the timestamp order', async () => {
		const { sql } = await buildSearchSql(
			sqoFor(ACTIVITY_TIPO, [{ direction: 'DESC', path: [{ column: 'id' }] }]),
			{},
		);
		expect(sql).toMatch(TIME_ORDER('DESC'));
		// The bare id order must be gone — that is the plan that times out.
		expect(sql).not.toMatch(/ORDER BY\s+id DESC/);
	});

	test('the When header sort (WC-044 → section_id) maps to the same order', async () => {
		for (const dir of ['ASC', 'DESC'] as const) {
			const { sql } = await buildSearchSql(
				sqoFor(ACTIVITY_TIPO, [{ direction: dir, path: [{ component_tipo: 'section_id' }] }]),
				{},
			);
			expect(sql).toMatch(TIME_ORDER(dir));
			expect(sql).not.toMatch(new RegExp(`ORDER BY\\s+section_id ${dir}`));
		}
	});

	test('both columns carry the SAME direction (a btree cannot serve a mixed pair)', async () => {
		const { sql } = await buildSearchSql(
			sqoFor(ACTIVITY_TIPO, [{ direction: 'ASC', path: [{ column: 'id' }] }]),
			{},
		);
		expect(sql).toMatch(TIME_ORDER('ASC'));
		expect(sql).not.toMatch(/"timestamp" ASC, (?:[a-z0-9_]+\.)?id DESC/);
	});

	test('a When date FILTER keeps the timestamp order (the reported slow request)', async () => {
		const { sql } = await buildSearchSql(
			sqoFor(ACTIVITY_TIPO, [{ direction: 'DESC', path: [{ column: 'id' }] }], {
				filter: WHEN_FILTER,
			}),
			{},
		);
		// The SARGable range predicate AND the index-aligned order in one query.
		expect(sql).toMatch(/"timestamp" >= \$\d+::date/);
		expect(sql).toMatch(TIME_ORDER('DESC'));
	});

	test('a component sort is NOT rewritten (only the structural keys are)', async () => {
		// dd547 as a jsonb component sort still carries its sort alias — the
		// rewrite must not swallow an arbitrary order path.
		const { sql } = await buildSearchSql(
			sqoFor(ACTIVITY_TIPO, [
				{ direction: 'DESC', path: [{ section_tipo: ACTIVITY_TIPO, component_tipo: 'dd547' }] },
			]),
			{},
		);
		expect(sql).toContain('dd547_order');
		expect(sql).not.toMatch(TIME_ORDER('DESC'));
	});

	test('scoped to matrix_activity: another section keeps its structural order', async () => {
		const { sql } = await buildSearchSql(
			sqoFor(CONTROL_TIPO, [{ direction: 'DESC', path: [{ component_tipo: 'section_id' }] }]),
			{},
		);
		expect(sql).toMatch(/ORDER BY\s+section_id DESC/);
		expect(sql).not.toContain('"timestamp"');
	});
});

describe('dd542 deep-page rewrites survive the composite order (WC-054)', () => {
	/** Deep enough to cross searchLateRowLookupOffset in any sane config. */
	const DEEP = 10_000_000;

	test('the late row lookup pages the unique id and joins back 1:1', async () => {
		const { sql } = await buildSearchSql(
			sqoFor(ACTIVITY_TIPO, [{ direction: 'DESC', path: [{ column: 'id' }] }], {
				offset: DEEP,
				filter: WHEN_FILTER, // filtered → late lookup, no flip
			}),
			{},
		);
		// The narrow page scan…
		expect(sql).toContain('JOIN (');
		expect(sql).toMatch(/page ON page\.id = [a-z0-9_]+\.id/);
		// …ordered by the composite key on BOTH the inner page and the outer join,
		// alias-qualified (a bare `id` is ambiguous across the join).
		expect((sql.match(TIME_ORDER('DESC')) ?? []).length).toBeGreaterThan(0);
		expect(sql).toMatch(/[a-z0-9_]+\."timestamp" DESC, [a-z0-9_]+\.id DESC/);
	});

	test('the unfiltered deep page keeps the composite order on both sides', async () => {
		// Direction-agnostic: whether this offset lands in the near half (late
		// lookup, requested direction) or the far half (flip, mirrored direction)
		// depends on the install's row count — the ROW-level equivalence of both
		// regimes is proven against a live DB by activity_deep_offset_flip.test.ts.
		// What is asserted here is that neither regime falls back to a bare key
		// order, which is what silently reintroduces the plain deep OFFSET.
		const { sql } = await buildSearchSql(
			sqoFor(ACTIVITY_TIPO, [{ direction: 'DESC', path: [{ column: 'id' }] }], {
				offset: DEEP,
			}),
			{},
		);
		expect(sql).toContain('JOIN (');
		expect(sql).toMatch(/page ON page\.id = [a-z0-9_]+\.id/);
		// Inner page + outer restore, both on the composite key, both consistent.
		const composite = sql.match(/[a-z0-9_]+\."timestamp" (ASC|DESC), [a-z0-9_]+\.id \1/g) ?? [];
		expect(composite.length).toBe(2);
		// The outer ORDER BY always restores the REQUESTED direction.
		expect(sql).toMatch(/ORDER BY [a-z0-9_]+\."timestamp" DESC, [a-z0-9_]+\.id DESC;/);
		expect(sql).not.toMatch(/ORDER BY [a-z0-9_]+\.id (?:ASC|DESC)\n/);
	});
});
