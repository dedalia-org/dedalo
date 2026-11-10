/**
 * Counter-gate primitives of the matrix write path (src/core/db/matrix_write.ts)
 * — the corruption-class scenarios a green round-trip suite never touches:
 *
 *  1. insertMatrixRecordWithExplicitId × insertMatrixRecordWithCounter
 *     interplay: an explicit insert ABOVE the per-tipo counter must raise it
 *     (GREATEST) so a later counter-driven allocation can NEVER collide with
 *     the explicitly-placed row; an explicit insert BELOW the counter leaves
 *     it untouched. Silent failure mode without the raise: provisioning seeds
 *     id N, the next auto-create allocates N again and the unique key wedges
 *     every create for that tipo.
 *  2. onConflict semantics of the explicit insert: 'throw' (default) rejects a
 *     duplicate id; 'ignore' returns without error and without duplicating —
 *     and it must do so INSIDE withTransaction, because the ON-CONFLICT-not-
 *     exception design exists precisely so an ambient transaction survives
 *     an explicit-id import's create race (a raised 23505 would abort the
 *     whole tx; the save path no longer creates — WC-2026-11-10-save-never-creates).
 *  3. absorbComponentItemIds: explicit item ids (numeric AND numeric-string —
 *     imports/migrations carry both) raise the component item-id counter so
 *     allocateComponentItemId never re-mints them; absorb never LOWERS the
 *     counter; id-less items are a no-op (no meta key materialized).
 *  4. Two CONCURRENT counter-driven inserts on one tipo allocate distinct ids
 *     and both rows land (the single-statement counter CTE serializes on the
 *     counter row).
 *  5. A null column on the counter-driven insert is SQL NULL, never the jsonb
 *     scalar `null` — the scalar made every later key removal on that column
 *     throw "cannot delete path in scalar" (a duplicated tch1 record could not
 *     have its component_autocomplete_hi cleared by tool_propagate_component_data).
 *
 * SKIPPED sub-case — the '_dd' counter branch (tableName.endsWith('_dd') →
 * matrix_counter_dd): the only allowlisted _dd tables are matrix_dd and
 * matrix_layout_dd, both LIVE shared ontology surfaces (and matrix_counter_dd
 * is the live master-managed counter store) — there is no scratch _dd surface,
 * and writing a live ontology table from a test violates the scratch-only rule,
 * so the branch stays covered by code review only.
 *
 * Scratch surfaces only: matrix_test rows under reserved zzcg* tipos + their
 * matrix_counter rows. Cleanup runs before AND after — a crashed previous run
 * must not poison the next one.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
	absorbComponentItemIds,
	allocateComponentItemId,
	insertMatrixRecordWithCounter,
	insertMatrixRecordWithExplicitId,
	updateMatrixKeysData,
	updateMatrixRecord,
} from '../../src/core/db/matrix_write.ts';
import { sql, withTransaction } from '../../src/core/db/postgres.ts';
import { cleanScratchTipo } from '../helpers/test_data.ts';

const TEST_TABLE = 'matrix_test';
/** Reserved scratch tipos (tipo grammar, collide with nothing — see zz* census). */
const EXPLICIT_TIPO = 'zzcg1';
const ABSORB_TIPO = 'zzcg2';
const RACE_TIPO = 'zzcg3';
const NULL_COLUMN_TIPO = 'zzcg4';
const SCRATCH_TIPOS = [EXPLICIT_TIPO, ABSORB_TIPO, RACE_TIPO, NULL_COLUMN_TIPO];

async function cleanScratch(): Promise<void> {
	for (const tipo of SCRATCH_TIPOS) {
		await cleanScratchTipo(tipo);
	}
}

async function counterValue(tipo: string): Promise<number | null> {
	const rows = (await sql.unsafe('SELECT value FROM matrix_counter WHERE tipo = $1', [tipo])) as {
		value: number | string;
	}[];
	return rows.length === 0 ? null : Number(rows[0]?.value);
}

async function rowCountForId(tipo: string, sectionId: number): Promise<number> {
	const rows = (await sql.unsafe(
		`SELECT 1 FROM ${TEST_TABLE} WHERE section_tipo = $1 AND section_id = $2`,
		[tipo, sectionId],
	)) as unknown[];
	return rows.length;
}

beforeAll(cleanScratch);
afterAll(cleanScratch);

// ---------------------------------------------------------------------------
// 1+2. insertMatrixRecordWithExplicitId — counter raise + onConflict semantics.
// ---------------------------------------------------------------------------

describe('insertMatrixRecordWithExplicitId — counter interplay (sequential state)', () => {
	test('explicit insert ABOVE the counter raises it: the next counter insert cannot collide', async () => {
		// Counter-driven create initializes the counter at 1.
		expect(await insertMatrixRecordWithCounter(TEST_TABLE, EXPLICIT_TIPO, {})).toBe(1);
		expect(await counterValue(EXPLICIT_TIPO)).toBe(1);

		// Explicit insert far above the counter (the provisioning shape).
		expect(await insertMatrixRecordWithExplicitId(TEST_TABLE, EXPLICIT_TIPO, 10, {})).toBe(10);
		// GREATEST(1, 10) — the counter absorbed the explicit id.
		expect(await counterValue(EXPLICIT_TIPO)).toBe(10);

		// The next counter-driven insert allocates PAST the explicit row.
		expect(await insertMatrixRecordWithCounter(TEST_TABLE, EXPLICIT_TIPO, {})).toBe(11);
	}, 30000);

	test('explicit insert BELOW the counter leaves the counter unchanged', async () => {
		expect(await insertMatrixRecordWithExplicitId(TEST_TABLE, EXPLICIT_TIPO, 5, {})).toBe(5);
		// GREATEST(11, 5) = 11 — no lowering.
		expect(await counterValue(EXPLICIT_TIPO)).toBe(11);
		// Allocation continues cleanly from the untouched counter.
		expect(await insertMatrixRecordWithCounter(TEST_TABLE, EXPLICIT_TIPO, {})).toBe(12);
	}, 30000);

	test("onConflict 'throw' (default) rejects a duplicate id; 'ignore' tolerates without duplicating", async () => {
		// Default: the unique (section_id, section_tipo) key raises.
		await expect(
			insertMatrixRecordWithExplicitId(TEST_TABLE, EXPLICIT_TIPO, 10, {}),
		).rejects.toThrow();
		expect(await rowCountForId(EXPLICIT_TIPO, 10)).toBe(1); // nothing duplicated

		// 'ignore': same duplicate insert returns the requested id, no throw.
		const tolerated = await insertMatrixRecordWithExplicitId(
			TEST_TABLE,
			EXPLICIT_TIPO,
			10,
			{},
			{ onConflict: 'ignore' },
		);
		expect(tolerated).toBe(10);
		expect(await rowCountForId(EXPLICIT_TIPO, 10)).toBe(1); // still exactly one row
	}, 30000);

	test("onConflict 'ignore' works INSIDE withTransaction — the ambient tx is not aborted", async () => {
		// The design intent: ON CONFLICT DO NOTHING instead of a caught 23505,
		// because an exception would put the ambient tx in the aborted state and
		// every later statement (here: a second insert) would fail.
		await withTransaction(async () => {
			const duplicate = await insertMatrixRecordWithExplicitId(
				TEST_TABLE,
				EXPLICIT_TIPO,
				10,
				{},
				{ onConflict: 'ignore' },
			);
			expect(duplicate).toBe(10);
			// The tx is still LIVE: a follow-up write on the same connection lands.
			expect(await insertMatrixRecordWithExplicitId(TEST_TABLE, EXPLICIT_TIPO, 20, {})).toBe(20);
		});
		// COMMIT happened: the follow-up row is visible outside the tx.
		expect(await rowCountForId(EXPLICIT_TIPO, 20)).toBe(1);
		expect(await rowCountForId(EXPLICIT_TIPO, 10)).toBe(1);
	}, 30000);
});

// ---------------------------------------------------------------------------
// 3. absorbComponentItemIds — the item-id counter never re-mints explicit ids.
// ---------------------------------------------------------------------------

describe('absorbComponentItemIds — explicit item ids are absorbed, never re-minted', () => {
	const RECORD_ID = 1;
	const COMPONENT = 'testcomp1';

	async function itemCounter(componentTipo: string): Promise<number | null> {
		const rows = (await sql.unsafe(
			`SELECT (meta->'${componentTipo}'->0->>'count')::int AS count
			 FROM ${TEST_TABLE} WHERE section_tipo = $1 AND section_id = $2`,
			[ABSORB_TIPO, RECORD_ID],
		)) as { count: number | null }[];
		return rows[0]?.count ?? null;
	}

	test('numeric AND string ids raise the counter; a later allocation never reuses them', async () => {
		// Seed the scratch record (meta starts NULL).
		expect(await updateMatrixRecord(TEST_TABLE, ABSORB_TIPO, RECORD_ID, { misc: null })).toBe(
			'inserted',
		);

		// Imports/migrations carry numbers and numeric strings alike; id-less
		// items ride along and must not disturb the max.
		await absorbComponentItemIds(TEST_TABLE, ABSORB_TIPO, RECORD_ID, COMPONENT, [
			{ id: 3, value: 'numeric id' },
			{ id: '7', value: 'string id' },
			{ value: 'id-less passenger' },
		]);
		expect(await itemCounter(COMPONENT)).toBe(7);

		// The next allocation starts PAST every absorbed id.
		expect(await allocateComponentItemId(TEST_TABLE, ABSORB_TIPO, RECORD_ID, COMPONENT)).toBe(8);
	}, 30000);

	test('absorb never LOWERS the counter', async () => {
		await absorbComponentItemIds(TEST_TABLE, ABSORB_TIPO, RECORD_ID, COMPONENT, [
			{ id: 4, value: 'stale low id' },
		]);
		expect(await itemCounter(COMPONENT)).toBe(8); // untouched
		expect(await allocateComponentItemId(TEST_TABLE, ABSORB_TIPO, RECORD_ID, COMPONENT)).toBe(9);
	}, 30000);

	test('items without ids are a no-op — no meta key is materialized', async () => {
		const FRESH_COMPONENT = 'testcomp2';
		await absorbComponentItemIds(TEST_TABLE, ABSORB_TIPO, RECORD_ID, FRESH_COMPONENT, [
			{ value: 'no id' },
			{},
			null,
		]);
		await absorbComponentItemIds(TEST_TABLE, ABSORB_TIPO, RECORD_ID, FRESH_COMPONENT, []);
		expect(await itemCounter(FRESH_COMPONENT)).toBeNull();
		// And the existing component's counter is untouched by the no-ops.
		expect(await itemCounter(COMPONENT)).toBe(9);
	}, 30000);
});

// ---------------------------------------------------------------------------
// 4. Concurrent counter-driven inserts — distinct ids, no lost row.
// ---------------------------------------------------------------------------

describe('insertMatrixRecordWithCounter — concurrent allocations never collide', () => {
	test('two simultaneous inserts on one tipo get distinct ids and both rows land', async () => {
		const [firstId, secondId] = await Promise.all([
			insertMatrixRecordWithCounter(TEST_TABLE, RACE_TIPO, {}),
			insertMatrixRecordWithCounter(TEST_TABLE, RACE_TIPO, {}),
		]);
		expect(new Set([firstId, secondId]).size).toBe(2);
		expect([firstId, secondId].sort((a, b) => a - b)).toEqual([1, 2]);

		// Both rows are present in the table (no ON CONFLICT swallow).
		const rows = (await sql.unsafe(
			`SELECT section_id FROM ${TEST_TABLE} WHERE section_tipo = $1 ORDER BY section_id`,
			[RACE_TIPO],
		)) as { section_id: number | string }[];
		expect(rows.map((row) => Number(row.section_id))).toEqual([1, 2]);
		expect(await counterValue(RACE_TIPO)).toBe(2);
	}, 30000);
});

// ---------------------------------------------------------------------------
// 5. null column ⇒ SQL NULL (never the jsonb scalar), so key removal still works.
// ---------------------------------------------------------------------------

describe('insertMatrixRecordWithCounter — a null column is SQL NULL', () => {
	test('relation_search: null lands as SQL NULL and a later key removal succeeds', async () => {
		const sectionId = await insertMatrixRecordWithCounter(TEST_TABLE, NULL_COLUMN_TIPO, {
			relation: {},
			relation_search: null,
		});
		const rows = (await sql.unsafe(
			`SELECT relation_search IS NULL AS is_sql_null, jsonb_typeof(relation_search) AS kind
			   FROM ${TEST_TABLE} WHERE section_tipo = $1 AND section_id = $2`,
			[NULL_COLUMN_TIPO, sectionId],
		)) as { is_sql_null: boolean; kind: string | null }[];
		expect(rows[0]).toEqual({ is_sql_null: true, kind: null });

		// The outcome the scalar broke: removing a key from the column (`#-`).
		const updated = await updateMatrixKeysData(TEST_TABLE, NULL_COLUMN_TIPO, sectionId, [
			{ column: 'relation_search', key: 'zzcg4', value: null },
		]);
		expect(updated).toBe(1);
	});
});
