/**
 * ORDER-clause assembly (sql_assembler::buildSearchSql) for the two shapes a
 * SECTION-list default sort can take (PHP build_sql_query_order parity):
 *
 *  1. `component_tipo: 'id'` — the matrix PK. It is NOT among
 *     DEFAULT_SELECT_COLUMNS, so `ORDER BY id` can only resolve when the
 *     SELECT surfaces it. The assembler adds `<alias>.id AS id` exactly ONCE
 *     (no duplicated select sentence, even if id appears twice in the order).
 *     Single-section no-join ordered queries FLATTEN (no main_select window,
 *     no DISTINCT ON) so LIMIT applies without materializing every row.
 *  2. A single `{path,direction}` OBJECT (how an ontology default sort is often
 *     authored, e.g. dd542 Activity's dd549) must produce the SAME SQL as the
 *     one-element array form — PHP tolerates both.
 *
 * dd542 (Activity → matrix_activity) is the live carrier of this config, but it
 * is NOT the carrier here: WC-054 re-expresses a dd542 structural-key sort as
 * `"timestamp" <dir>, id <dir>` (the only shape a When date filter can be
 * served with — activity_time_order.test.ts owns that contract). Asserting the
 * generic convention on dd542 would measure the rewrite instead of the
 * convention, so an ordinary section carries these cases and one dd542 case
 * below pins the boundary between the two.
 */
// Migrated to the generic `test` TLD 2026-08-19 (AGENTS.md hard rules): every
// install tipo was rewritten through src/core/test_data/test_tld_tipo_map.json;
// seed-shipped ontology (dd/rsc/hierarchy/lg) stays and is spelled through `seed()`,
// which keeps it out of the install-TLD census's `<tld><digits>` token grammar.

import { describe, expect, test } from 'bun:test';
import { trimTipo } from '../../src/core/search/sql_assembler.ts';
import { buildSearchSql } from '../helpers/search_sql.ts';

const ID_ORDER = { direction: 'DESC', path: [{ component_tipo: 'id' }] };
/** An ordinary section (no timestamp-order rewrite) — the convention carrier. */
const CARRIER = 'test6813';
/**
 * The single-section alias the assembler mints for the carrier — `trimTipo` is
 * the two-letter TLD prefix + the number, so it is NOT the tipo itself and the
 * pattern below must ask for it rather than assume it.
 */
const CARRIER_ALIAS = trimTipo(CARRIER) as string;

describe('search ORDER BY id (matrix PK) assembly', () => {
	test("order by 'id' surfaces the PK into the SELECT exactly once and orders by it", async () => {
		const { sql } = await buildSearchSql(
			{ section_tipo: [CARRIER], limit: 25, offset: 0, order: [ID_ORDER] } as never,
			{},
		);
		// The SELECT surfaces the PK — exactly one `AS id` sentence.
		const idSelects = sql.match(/\bAS id\b/g) ?? [];
		expect(idSelects.length).toBe(1);
		expect(sql).toContain('.id AS id');
		// Single-section + no joins → FLATTENED shape: no window, no DISTINCT ON
		// (section_id is unique under the single-tipo predicate), ORDER BY + LIMIT
		// inline so Postgres can stop at the LIMIT instead of materializing all rows.
		expect(sql).not.toContain('main_select');
		expect(sql).not.toContain('DISTINCT ON');
		expect(sql).toMatch(/ORDER BY\s+id DESC/);
		// No `column "id" does not exist`: the ordered column is the surfaced alias,
		// present in the same SELECT's projection.
	});

	test("order by 'id' does NOT duplicate the select sentence when id appears twice", async () => {
		// Degenerate but legal: two id clauses. The select must still carry `AS id`
		// once (the `!selectExtra.includes` dedup guard), while both order sentences
		// are emitted.
		const { sql } = await buildSearchSql(
			{
				section_tipo: [CARRIER],
				limit: 25,
				offset: 0,
				order: [ID_ORDER, { direction: 'ASC', path: [{ component_tipo: 'id' }] }],
			} as never,
			{},
		);
		expect((sql.match(/\bAS id\b/g) ?? []).length).toBe(1);
	});

	test('a single order OBJECT normalizes to the same SQL as the one-element array', async () => {
		const base = { section_tipo: [CARRIER], limit: 25, offset: 0 };
		const asArray = await buildSearchSql({ ...base, order: [ID_ORDER] } as never, {});
		const asObject = await buildSearchSql({ ...base, order: ID_ORDER } as never, {});
		expect(asObject.sql).toBe(asArray.sql);
		expect(asObject.params).toEqual(asArray.params);
	});

	test('no order → the global section_id ASC default (unchanged baseline)', async () => {
		const { sql } = await buildSearchSql(
			{ section_tipo: [CARRIER], limit: 25, offset: 0 } as never,
			{},
		);
		// No custom order → no window, no `AS id`, inner default ASC only.
		expect(sql).not.toContain('AS id');
		expect(sql).not.toContain('main_select');
		expect(sql).toMatch(new RegExp(`ORDER BY\\s+${CARRIER_ALIAS}\\.section_id ASC`));
	});

	test('the same id order on dd542 is re-expressed by WC-054 (boundary case)', async () => {
		// Same sqo, append-only log: the PK is still surfaced (the projection is
		// unchanged) but the ORDER BY moves onto the ("timestamp", id) index.
		const { sql } = await buildSearchSql(
			{ section_tipo: ['dd542'], limit: 25, offset: 0, order: [ID_ORDER] } as never,
			{},
		);
		expect((sql.match(/\bAS id\b/g) ?? []).length).toBe(1);
		expect(sql).toMatch(/ORDER BY\s+"timestamp" DESC, id DESC/);
	});
});

/**
 * The `column` order convention (WC-009): a path end-step names an exact DB
 * column directly, as the clear alternative to overloading `component_tipo`.
 * `component_tipo` WINS when both are present.
 */
describe('search ORDER BY exact `column` convention', () => {
	async function outerOrder(order: unknown): Promise<string> {
		const { sql } = await buildSearchSql(
			{ section_tipo: [CARRIER], limit: 25, offset: 0, order } as never,
			{},
		);
		const m = sql.match(/main_select\s+ORDER BY\s+([^;]+)/) ?? sql.match(/ORDER BY\s+([^;]+)/);
		return (m?.[1] ?? '').replace(/\s+/g, ' ').trim();
	}

	test('`column: "section_id"` (no component_tipo) orders by that column', async () => {
		expect(await outerOrder([{ direction: 'DESC', path: [{ column: 'section_id' }] }])).toMatch(
			/^section_id DESC/,
		);
	});

	test('`column: "id"` surfaces the PK into the SELECT once', async () => {
		const { sql } = await buildSearchSql(
			{
				section_tipo: [CARRIER],
				limit: 25,
				offset: 0,
				order: [{ direction: 'DESC', path: [{ column: 'id' }] }],
			} as never,
			{},
		);
		expect((sql.match(/\bAS id\b/g) ?? []).length).toBe(1);
		expect(sql).toMatch(/ORDER BY\s+id DESC/);
		expect(sql).not.toContain('main_select');
	});

	test('`component_tipo` WINS when both component_tipo and column are set', async () => {
		// component_tipo:'id' (→ id) beats column:'section_tipo'.
		const order = [{ direction: 'DESC', path: [{ component_tipo: 'id', column: 'section_tipo' }] }];
		const outer = await outerOrder(order);
		expect(outer).toMatch(/^id DESC/);
		expect(outer).not.toContain('section_tipo');
	});

	test('a single {path,direction} OBJECT with `column` normalizes like the array form', async () => {
		const base = { section_tipo: [CARRIER], limit: 25, offset: 0 };
		const arr = await buildSearchSql(
			{ ...base, order: [{ direction: 'DESC', path: [{ column: 'section_id' }] }] } as never,
			{},
		);
		const obj = await buildSearchSql(
			{ ...base, order: { direction: 'DESC', path: [{ column: 'section_id' }] } } as never,
			{},
		);
		expect(obj.sql).toBe(arr.sql);
	});

	test('an invalid `column` is rejected by the identifier gate', async () => {
		await expect(
			buildSearchSql(
				{
					section_tipo: [CARRIER],
					limit: 25,
					offset: 0,
					order: [{ direction: 'DESC', path: [{ column: 'DROP TABLE' }] }],
				} as never,
				{},
			),
		).rejects.toThrow(/invalid data column/);
	});
});
