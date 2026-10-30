/**
 * `{mode:'locator_position'}` SQO order — semantic-search rank preservation
 * (2026-07-22). Pins arrive best-first in filter_by_locators; this order mode
 * must keep that rank through the assembler, including the two paths the
 * adversarial review proved dangerous:
 *  - devil #2: the COUNT path reuses the sqo (incl. order) but emits no ORDER
 *    BY — an order-time bind would bind-mismatch and 500 every paginator
 *    count. Ids are therefore inlined (Number.isSafeInteger-validated).
 *  - devil #3: the WINDOWED wrapper strips only a LEADING alias prefix, so the
 *    rank expression must ride selectExtra as an ALIAS, never a raw
 *    `array_position(..., alias.section_id)` order clause.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { CLIENT_MAX_LOCATOR_PINS, sanitizeClientSqo } from '../../src/core/concepts/sqo.ts';
import { sql } from '../../src/core/db/postgres.ts';
import { createSectionRecord } from '../../src/core/section/record/create_record.ts';
import { buildSearchSql } from '../helpers/search_sql.ts';
import { cleanScratchRecord } from '../helpers/test_data.ts';

const SECTION = 'test2';
const createdIds: number[] = [];

beforeAll(async () => {
	for (let i = 0; i < 3; i++) {
		createdIds.push(await createSectionRecord(SECTION, -1));
	}
});

afterAll(async () => {
	for (const id of createdIds) {
		await cleanScratchRecord(SECTION, id);
	}
});

function pinnedSqo(ids: number[], extra: Record<string, unknown> = {}) {
	return sanitizeClientSqo({
		section_tipo: [SECTION],
		filter_by_locators: ids.map((id) => ({ section_tipo: SECTION, section_id: id })),
		order: [{ mode: 'locator_position' }],
		limit: 10,
		...extra,
	});
}

describe('locator_position order mode', () => {
	test('emits the selectExtra ALIAS shape, never a raw aliased order expression', async () => {
		const query = await buildSearchSql(pinnedSqo([...createdIds]));
		expect(query.sql).toContain('AS locator_position_order');
		expect(query.sql).toMatch(/ORDER BY[\s\S]*locator_position_order/i);
		// the rank expression must NOT appear inside the ORDER BY clause itself
		const orderBy = query.sql.slice(query.sql.lastIndexOf('ORDER BY'));
		expect(orderBy).not.toContain('array_position(');
	});

	test('rank is preserved end-to-end: shuffled pin order == row order', async () => {
		const shuffled = [createdIds[1], createdIds[2], createdIds[0]] as number[];
		const query = await buildSearchSql(pinnedSqo(shuffled));
		const rows = (await sql.unsafe(query.sql, query.params as (string | number | null)[])) as {
			section_id: number;
		}[];
		expect(rows.map((r) => Number(r.section_id))).toEqual(shuffled);
	});

	test('devil #2: full_count over a pinned+ordered sqo runs clean (no bind mismatch)', async () => {
		const counted = { ...pinnedSqo([...createdIds]), full_count: true };
		const query = await buildSearchSql(counted as Parameters<typeof buildSearchSql>[0]);
		const rows = (await sql.unsafe(query.sql, query.params as (string | number | null)[])) as {
			full_count: number | string;
		}[];
		expect(Number(rows[0]?.full_count)).toBe(createdIds.length);
	});

	test('devil #3: pinned + JOINed structured filter (windowed path) is valid SQL', async () => {
		// A multi-hop order path forces the non-flattened (windowed) shape; the
		// locator_position alias must survive the outer ORDER BY re-reference.
		const sqo = pinnedSqo([...createdIds], {
			filter: {
				$and: [
					{
						q: '1',
						q_operator: null,
						path: [{ section_tipo: SECTION, component_tipo: 'section_id' }],
						type: 'jsonb',
					},
				],
			},
		});
		const query = await buildSearchSql(sqo);
		// must execute without "missing FROM-clause entry"
		const rows = (await sql.unsafe(query.sql, query.params as (string | number | null)[])) as {
			section_id: number;
		}[];
		expect(Array.isArray(rows)).toBe(true);
	});

	test('no-op without pins (session-merged leftover order must not throw)', async () => {
		const sqo = sanitizeClientSqo({
			section_tipo: [SECTION],
			order: [{ mode: 'locator_position' }],
			limit: 5,
		});
		const query = await buildSearchSql(sqo);
		expect(query.sql).not.toContain('locator_position_order');
	});

	test('multi-tipo pin list refuses loudly', async () => {
		const sqo = sanitizeClientSqo({
			section_tipo: [SECTION],
			filter_by_locators: [
				{ section_tipo: SECTION, section_id: 1 },
				{ section_tipo: 'test3', section_id: 1 },
			],
			order: [{ mode: 'locator_position' }],
			limit: 5,
		});
		expect(buildSearchSql(sqo)).rejects.toThrow(/single-tipo/);
	});

	test('unsafe pin id refuses loudly (never interpolated)', async () => {
		// bypass sanitize (server-internal shape) to hit the assembler guard directly
		const sqo = {
			section_tipo: [SECTION],
			filter_by_locators: [{ section_tipo: SECTION, section_id: 'DROP TABLE x' }],
			order: [{ mode: 'locator_position' }],
			limit: 5,
		};
		expect(buildSearchSql(sqo as Parameters<typeof buildSearchSql>[0])).rejects.toThrow(
			/non-integer pin/,
		);
	});

	test('sanitize clamps oversized pin lists loudly (hardening)', () => {
		const pins = Array.from({ length: CLIENT_MAX_LOCATOR_PINS + 5 }, (_, i) => ({
			section_tipo: SECTION,
			section_id: i + 1,
		}));
		const sqo = sanitizeClientSqo({ section_tipo: [SECTION], filter_by_locators: pins, limit: 5 });
		expect(sqo.filter_by_locators?.length).toBe(CLIENT_MAX_LOCATOR_PINS);
	});
});
