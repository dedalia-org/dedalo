/**
 * ONT-5 — EVERY tree door absorbs a deadlock victim: add_child and save_order
 * retry a 40P01 exactly as update_parent_data does.
 *
 * WHY A DOOR CAN LOSE A DEADLOCK. The lock law (relations/parent.ts) takes the
 * child row, then the ancestors FOR SHARE, then the sibling batch in one sorted
 * order — but two DOORS do not share one order: a move locks its child X, then
 * the sibling batch under X's old parent; a save_order under another parent of a
 * multi-parent sibling Z locks [Z, X] sorted. Each can hold what the other waits
 * on, and Postgres aborts one with SQLSTATE 40P01. The victim rolled back whole,
 * so the tree transaction (ts_object/tree_locks.ts withTreeTransaction) re-runs
 * it; the WC says no tree door answers `tree.node_write_failed` for a deadlock.
 *
 * tree_cycle_race_native C5 proves withTreeTransaction in isolation and C1 the
 * move's wiring (a real two-move deadlock). These cases prove the OTHER two
 * doors are wired to it: the door's work raises 40P01 on its FIRST attempt
 * (after it really wrote), and the door must answer from attempt 2 with
 * attempt 1's writes — values AND history — rolled back.
 *
 *   R1  save_order: attempt 1 rewrites the orders then dies 40P01 → the door
 *       answers attempt 2's changes; exactly one history row per changed sibling
 *   R2  add_child: attempt 1 creates + links a node then dies 40P01 → the door
 *       answers ONE new child; attempt 1's record is gone
 *   R3  the budget is BOUNDED at the door: a permanent 40P01 runs 1 + 3
 *       attempts (the default delays) and then answers `tree.node_write_failed`
 *       with the deadlock as its cause; nothing is written
 *
 * The fault is injected by wrapping the REAL parent.ts export (mock.module,
 * process-global: the real module is put back after every case).
 * SITUATION: scratch TLD `zztrt`, swept with the TLD, asserted 0.
 */

import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test';
import { sql, sqlStateOf } from '../../src/core/db/postgres.ts';
import { isDedaloError } from '../../src/core/errors/index.ts';
import * as parentModule from '../../src/core/relations/parent.ts';
import type { Principal } from '../../src/core/security/permissions.ts';
import { addChild, saveOrder } from '../../src/core/ts_object/ts_api.ts';
import { boundedRun } from '../helpers/lock_wait.ts';
import {
	dropTreeSituation,
	ensureTreeSituation,
	newNodes,
	orderUnder,
	ROOT_USER_ID,
	seedLinks,
	type TreeSection,
	treeSituation,
} from '../helpers/tree_lock_situation.ts';

const TREE = treeSituation('zztrt');
const ORDERED = TREE.ordered;
const SUPERUSER: Principal = { userId: ROOT_USER_ID, isGlobalAdmin: true, isDeveloper: true };
const PARENT_MODULE = '../../src/core/relations/parent.ts';

/** The real parent.ts exports, snapshotted BEFORE any mock.module install. */
const REAL = { ...parentModule };

beforeAll(async () => {
	await ensureTreeSituation(TREE);
}, 60_000);

afterEach(() => {
	// mock.module is process-GLOBAL and mock.restore() does NOT revert it.
	mock.module(PARENT_MODULE, () => REAL);
});

afterAll(async () => {
	mock.module(PARENT_MODULE, () => REAL);
	expect(await dropTreeSituation(TREE)).toBe(0);
}, 60_000);

/** Abort the ambient transaction as a deadlock victim. */
async function raiseDeadlock(): Promise<never> {
	await sql.unsafe(
		`DO $$ BEGIN RAISE EXCEPTION 'synthetic deadlock victim' USING ERRCODE = '40P01'; END $$`,
	);
	throw new Error('raiseDeadlock did not raise');
}

/**
 * `real`, made to lose a deadlock on its FIRST call: it runs (and writes) for
 * real, then the transaction dies 40P01. Every later call is the real one.
 */
function failingFirst<A extends unknown[], R>(
	real: (...args: A) => Promise<R>,
): { wrapped: (...args: A) => Promise<R>; calls: () => number } {
	let calls = 0;
	return {
		wrapped: async (...args: A): Promise<R> => {
			calls++;
			const result = await real(...args);
			if (calls === 1) await raiseDeadlock();
			return result;
		},
		calls: () => calls,
	};
}

async function tmWatermark(): Promise<number> {
	const rows = (await sql.unsafe(
		'SELECT COALESCE(MAX(id), 0)::int AS id FROM matrix_time_machine',
	)) as { id: number }[];
	return Number(rows[0]?.id ?? 0);
}

async function historyCount(s: TreeSection, id: number, tipo: string, since: number) {
	const rows = (await sql.unsafe(
		`SELECT count(*)::int AS n FROM matrix_time_machine
		  WHERE section_tipo = $1 AND section_id = $2 AND tipo = $3 AND id > $4`,
		[s.section, id, tipo, since],
	)) as { n: number }[];
	return Number(rows[0]?.n ?? 0);
}

/** The records of the section that link to `parent` (any link). */
async function childrenOf(s: TreeSection, parent: number): Promise<number[]> {
	const rows = (await sql.unsafe(
		`SELECT section_id FROM "${s.table}"
		  WHERE section_tipo = $1
		    AND relation->$2 @> jsonb_build_array(jsonb_build_object('section_id', $3::int))
		  ORDER BY section_id`,
		[s.section, s.parent, parent],
	)) as { section_id: number }[];
	return rows.map((row) => Number(row.section_id));
}

async function sectionRowCount(s: TreeSection): Promise<number> {
	const rows = (await sql.unsafe(
		`SELECT count(*)::int AS n FROM "${s.table}" WHERE section_tipo = $1`,
		[s.section],
	)) as { n: number }[];
	return Number(rows[0]?.n ?? 0);
}

describe('ONT-5: add_child and save_order retry a deadlock victim', () => {
	test('R1 save_order: a 40P01 on attempt 1 is retried; attempt 1 rolled back, values and history', async () => {
		const [p, a, b, c] = await newNodes(ORDERED, 4);
		await seedLinks(ORDERED, a, [{ parent: p, itemId: 1, order: 1 }]);
		await seedLinks(ORDERED, b, [{ parent: p, itemId: 1, order: 2 }]);
		await seedLinks(ORDERED, c, [{ parent: p, itemId: 1, order: 3 }]);
		const since = await tmWatermark();
		const fault = failingFirst(REAL.sortChildren);
		mock.module(PARENT_MODULE, () => ({ ...REAL, sortChildren: fault.wrapped }));

		const response = await saveOrder(
			{
				source: {
					section_tipo: ORDERED.section,
					ar_locators: [c, b, a].map((id) => ({ section_tipo: ORDERED.section, section_id: id })),
					parent_section_tipo: ORDERED.section,
					parent_section_id: p,
				},
			} as never,
			SUPERUSER,
		);

		expect(fault.calls(), 'save_order did not re-run its work after the deadlock').toBe(2);
		// attempt 2's answer: c and a moved, b stayed 2.
		expect((response.data as { value: number }[]).map((change) => change.value)).toEqual([1, 3]);
		expect(await orderUnder(ORDERED, c, p)).toBe(1);
		expect(await orderUnder(ORDERED, b, p)).toBe(2);
		expect(await orderUnder(ORDERED, a, p)).toBe(3);
		// attempt 1's history rolled back with its values: one row per changed
		// sibling, + its save-before row (the order was seeded RAW — re-pinned
		// 2026-11-12, T1-21); a rolled-back attempt 1 would leave a third.
		const orderTipo = ORDERED.order as string;
		expect(await historyCount(ORDERED, c, orderTipo, since)).toBe(2);
		expect(await historyCount(ORDERED, a, orderTipo, since)).toBe(2);
		expect(await historyCount(ORDERED, b, orderTipo, since)).toBe(0);
	}, 60_000);

	test('R2 add_child: a 40P01 on attempt 1 is retried; ONE child lands, attempt 1’s record is gone', async () => {
		const [r, p] = await newNodes(ORDERED, 2);
		await seedLinks(ORDERED, p, [{ parent: r, itemId: 1, order: 1 }]);
		const rowsBefore = await sectionRowCount(ORDERED);
		const fault = failingFirst(REAL.addParent);
		mock.module(PARENT_MODULE, () => ({ ...REAL, addParent: fault.wrapped }));

		const response = await addChild(
			{ source: { section_tipo: ORDERED.section, section_id: p } } as never,
			SUPERUSER,
		);

		expect(fault.calls(), 'add_child did not re-run its work after the deadlock').toBe(2);
		const child = Number(response.data);
		expect(await childrenOf(ORDERED, p)).toEqual([child]);
		expect(await sectionRowCount(ORDERED)).toBe(rowsBefore + 1);
		expect(await orderUnder(ORDERED, child, p)).toBe(1);
	}, 60_000);

	test('R3 save_order: a PERMANENT 40P01 is retried a bounded number of times, then tree.node_write_failed', async () => {
		const [p, a, b] = await newNodes(ORDERED, 3);
		await seedLinks(ORDERED, a, [{ parent: p, itemId: 1, order: 1 }]);
		await seedLinks(ORDERED, b, [{ parent: p, itemId: 1, order: 2 }]);
		const since = await tmWatermark();
		let calls = 0;
		const alwaysVictim = async (...args: Parameters<typeof REAL.sortChildren>) => {
			calls++;
			// An unbounded loop ends here (and is reported) instead of hanging the suite.
			if (calls > 50) return REAL.sortChildren(...args);
			await REAL.sortChildren(...args);
			return raiseDeadlock();
		};
		mock.module(PARENT_MODULE, () => ({ ...REAL, sortChildren: alwaysVictim }));

		const outcome = await boundedRun(
			saveOrder(
				{
					source: {
						section_tipo: ORDERED.section,
						ar_locators: [b, a].map((id) => ({ section_tipo: ORDERED.section, section_id: id })),
						parent_section_tipo: ORDERED.section,
						parent_section_id: p,
					},
				} as never,
				SUPERUSER,
			),
			20_000,
		);

		expect(calls, 'the door retried past its budget (1 attempt + 3 retries)').toBe(4);
		expect(outcome.status).toBe('rejected');
		const reason = outcome.status === 'rejected' ? outcome.reason : null;
		expect(isDedaloError(reason) ? reason.code : String(reason)).toBe('tree.node_write_failed');
		expect(sqlStateOf((reason as { cause?: unknown } | null)?.cause)).toBe('40P01');
		// Every attempt rolled back: values and history untouched.
		expect(await orderUnder(ORDERED, a, p)).toBe(1);
		expect(await orderUnder(ORDERED, b, p)).toBe(2);
		const orderTipo = ORDERED.order as string;
		expect(await historyCount(ORDERED, a, orderTipo, since)).toBe(0);
		expect(await historyCount(ORDERED, b, orderTipo, since)).toBe(0);
	}, 60_000);
});
