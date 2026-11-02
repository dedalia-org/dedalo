/**
 * Flattened deep-page order-flip equivalence (sql_assembler.ts, WC-044 path).
 *
 * The dd542 Activity list is the flattened single-section shape ordered by the
 * unique `section_id` (When → section_id; every other column sortable:false).
 * "Navigate to the last records" sends a plain OFFSET ≈ row-count, which on a
 * 33 M-row matrix_activity makes Postgres Index-Scan + heap-fetch every skipped
 * row's wide jsonb (measured >25 s). buildSearchSql rewrites a far-half page
 * into the SAME rows fetched from the opposite end with a small offset, plus a
 * late-row-lookup so the skipped rows' data columns are never read.
 *
 * THIS is the contract the rewrite must never break: for every offset — shallow
 * (plain path), deep near-half (late-lookup, no flip), far-half + last page
 * (flip) — the acquired page must equal the ground-truth
 * `ORDER BY section_id DESC LIMIT L OFFSET O` byte-for-byte in section_id and
 * order. The matrix_time_machine twin (its `id` PK) is gated by
 * tm_deep_offset_flip.test.ts.
 *
 * Scratch hygiene: seeds > threshold disposable dd542 rows on a reserved
 * section_id range so the flip regime is reached on a small test DB (the perf
 * DB is proven separately via EXPLAIN); all seeded rows deleted in afterAll,
 * and the bare-count cache invalidated (a raw INSERT/DELETE fires no save
 * event). Ground truth and acquisition both count EVERY dd542 row, so they see
 * the same total.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { config } from '../../src/config/config.ts';
import type { Sqo } from '../../src/core/concepts/sqo.ts';
import { sql } from '../../src/core/db/postgres.ts';
import { fireSaveEvent } from '../../src/core/section_record/save_event.ts';
import { buildSearchSql } from '../helpers/search_sql.ts';

const LIMIT = 5;
const threshold = config.ops.searchLateRowLookupOffset;
const ACTIVITY_TIPO = 'dd542';
// Reserved high section_id range — clear of the DB's real dd542 rows.
const SCRATCH_BASE = 900_000_000;
// Enough that offset === threshold sits in the far half (flips).
const SEED = Math.max(threshold, 0) + 100;

/** The dd542 list sqo, ordered by section_id (the sole sortable Activity key). */
function activitySqo(offset: number, direction: 'ASC' | 'DESC' = 'DESC'): Sqo {
	return {
		section_tipo: [ACTIVITY_TIPO],
		order: [{ direction, path: [{ component_tipo: 'section_id' }] }],
		limit: LIMIT,
		offset,
	} as unknown as Sqo;
}

/** Ground truth: the plain page the acquisition must reproduce. */
async function plainPageIds(offset: number, direction: 'ASC' | 'DESC' = 'DESC'): Promise<number[]> {
	const rows = (await sql.unsafe(
		`SELECT section_id FROM matrix_activity WHERE section_tipo = $1 ORDER BY section_id ${direction} LIMIT $2 OFFSET $3`,
		[ACTIVITY_TIPO, LIMIT, offset],
	)) as { section_id: number }[];
	return rows.map((row) => Number(row.section_id));
}

/** Acquisition: execute exactly the SQL buildSearchSql emits for the sqo. */
async function acquiredPageIds(
	offset: number,
	direction: 'ASC' | 'DESC' = 'DESC',
): Promise<number[]> {
	const { sql: builtSql, params } = await buildSearchSql(activitySqo(offset, direction), {});
	const rows = (await sql.unsafe(builtSql, params as (string | number | null)[])) as {
		section_id: number;
	}[];
	return rows.map((row) => Number(row.section_id));
}

async function totalRows(): Promise<number> {
	const rows = (await sql.unsafe(
		'SELECT count(*)::int AS c FROM matrix_activity WHERE section_tipo = $1',
		[ACTIVITY_TIPO],
	)) as { c: number }[];
	return Number(rows[0]?.c ?? 0);
}

beforeAll(async () => {
	if (threshold < 0) return; // rewrite disabled — nothing to seed/exercise
	await sql.unsafe(
		`INSERT INTO matrix_activity (section_id, section_tipo, timestamp)
		 SELECT $1 + g, $2, NOW() FROM generate_series(1, $3) AS g`,
		[SCRATCH_BASE, ACTIVITY_TIPO, SEED],
	);
	// The bare-browse count is cached (save-event wired); a raw INSERT fires no
	// event, so invalidate it — the flip must see the seeded total.
	await fireSaveEvent('test3');
});

afterAll(async () => {
	await sql.unsafe('DELETE FROM matrix_activity WHERE section_id > $1 AND section_tipo = $2', [
		SCRATCH_BASE,
		ACTIVITY_TIPO,
	]);
	// The seed cached a total including the now-deleted rows; a raw DELETE fires
	// no save event, so clear it so no stale total leaks into the next test file.
	await fireSaveEvent('test3');
});

describe('flattened deep-page order-flip equivalence (real DB)', () => {
	test('rewrite is enabled (threshold >= 0) — else this gate is vacuous', () => {
		expect(threshold).toBeGreaterThanOrEqual(0);
	});

	test('shallow page (offset 0, plain path) matches ground truth', async () => {
		expect(await acquiredPageIds(0)).toEqual(await plainPageIds(0));
	}, 30000);

	test('deep + last-page offsets (flip path) match ground truth', async () => {
		const total = await totalRows();
		expect(total).toBeGreaterThan(threshold + LIMIT); // the seed reached the flip regime

		const lastPage = Math.max(0, total - LIMIT); // "navigate to the last records"
		const offsets = [
			threshold, // just into the deep regime → far half here, flips
			Math.floor(total / 2), // the crossover
			Math.max(threshold, total - 20), // deepest full page → flips, near OFFSET 0
			lastPage, // the reported slow case → OFFSET 0 after flip
		];
		for (const offset of offsets) {
			expect(await acquiredPageIds(offset)).toEqual(await plainPageIds(offset));
		}
	}, 60000);

	test('the flip actually engages (last page → tiny inner OFFSET, not plain deep OFFSET)', async () => {
		const total = await totalRows();
		const lastPage = Math.max(0, total - LIMIT);
		const { sql: builtSql } = await buildSearchSql(activitySqo(lastPage), {});
		// Late-lookup/flip shape (a JOIN back for the wide columns)…
		expect(builtSql).toContain('JOIN (');
		// …and the far page is fetched from the OTHER end: the inner OFFSET is the
		// small mirror offset (0 for the exact last page), NOT the deep lastPage.
		const innerOffset = Number(/OFFSET (\d+)/.exec(builtSql)?.[1] ?? -1);
		expect(innerOffset).toBeLessThan(threshold);
		expect(builtSql).not.toContain(`OFFSET ${lastPage}`);
	}, 30000);

	test('last partial page (offset within LIMIT of the end) matches ground truth', async () => {
		const total = await totalRows();
		const offset = total - 2; // only 2 rows remain → the effLimit clamp is exercised
		expect(await acquiredPageIds(offset)).toEqual(await plainPageIds(offset));
	}, 30000);

	test('ASC order also flips exactly (opposite direction)', async () => {
		const total = await totalRows();
		const offset = Math.max(threshold, total - 20);
		expect(await acquiredPageIds(offset, 'ASC')).toEqual(await plainPageIds(offset, 'ASC'));
	}, 30000);

	// The dd542 Activity list DEFAULTS to `id DESC` (deriveSectionListSqoDefaults
	// → {column:'id'}) — the shape the real slow request hit. It must flip too.
	test('id-PK order (the real list default) flips exactly + engages', async () => {
		const total = await totalRows();
		const lastPage = Math.max(0, total - LIMIT);
		const idSqo = (offset: number): Sqo =>
			({
				section_tipo: [ACTIVITY_TIPO],
				order: [{ direction: 'DESC', path: [{ column: 'id' }] }],
				limit: LIMIT,
				offset,
			}) as unknown as Sqo;
		const plainByIds = async (offset: number): Promise<number[]> => {
			const rows = (await sql.unsafe(
				'SELECT id FROM matrix_activity WHERE section_tipo = $1 ORDER BY id DESC LIMIT $2 OFFSET $3',
				[ACTIVITY_TIPO, LIMIT, offset],
			)) as { id: number }[];
			return rows.map((r) => Number(r.id));
		};
		const acquiredByIds = async (offset: number): Promise<number[]> => {
			const { sql: builtSql, params } = await buildSearchSql(idSqo(offset), {});
			const rows = (await sql.unsafe(builtSql, params as (string | number | null)[])) as {
				id: number;
			}[];
			return rows.map((r) => Number(r.id));
		};
		for (const offset of [threshold, lastPage]) {
			expect(await acquiredByIds(offset)).toEqual(await plainByIds(offset));
		}
		// The flip engages on the id key (was plain deep OFFSET → the 5 s regression).
		const { sql: builtSql } = await buildSearchSql(idSqo(lastPage), {});
		expect(builtSql).toContain('page ON page.id');
		expect(builtSql).not.toContain(`OFFSET ${lastPage}`);
		// WC-054: the page is ACQUIRED by the unique id (1:1 join back) but ORDERED
		// on the ("timestamp", id) index — both sides of the join, both columns in
		// the same direction, mirrored together by the flip. singleUniqueKeyOrder
		// rejects that two-column clause by design, so a regression here drops the
		// page back to a plain deep OFFSET (8.1 s at offset 16 M, measured).
		const composite =
			builtSql.match(/[a-z0-9_]+\."timestamp" (ASC|DESC), [a-z0-9_]+\.id \1/g) ?? [];
		expect(composite.length).toBe(2); // inner page + outer restore
		expect(builtSql).toMatch(/ORDER BY [a-z0-9_]+\."timestamp" DESC, [a-z0-9_]+\.id DESC;/);
	}, 60000);

	// The When-header sort (WC-044 maps When → section_id) rides the SAME rewrite,
	// so its deep pages must stay equivalent too — the section_id ground truth is
	// the order the client asked for.
	test('When-header order (section_id) still matches ground truth under the rewrite', async () => {
		const total = await totalRows();
		const lastPage = Math.max(0, total - LIMIT);
		for (const offset of [threshold, lastPage]) {
			expect(await acquiredPageIds(offset)).toEqual(await plainPageIds(offset));
		}
		const { sql: builtSql } = await buildSearchSql(activitySqo(lastPage), {});
		expect(builtSql).toMatch(/[a-z0-9_]+\."timestamp" (?:ASC|DESC), [a-z0-9_]+\.id/);
	}, 60000);
});
