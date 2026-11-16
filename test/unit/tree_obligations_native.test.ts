/**
 * CLOSURE_PLAN Step 5 — THE TREE-MOVE OBLIGATION: a tree door's write carries
 * what every other record write carries.
 *
 * THE DIVERGENCE CLOSED. PHP's dd_ts_api saved the parent link, the sibling
 * order and add_child's defaults through component->save(): the record's
 * modified stamps (dd197 user / dd201 date) moved, the Time Machine kept a row
 * per changed key, and the post-write chain (index, observers, save event) ran.
 * The TS tree engine wrote those keys RAW past the record-write chokepoint, so a
 * moved node kept naming its previous editor and its history said nothing of
 * the move — a curator could not see, let alone undo, a drag in the tree.
 *
 * Now every tree mutation writes through relations/parent.ts persistTreeKeys →
 * the chokepoint (persistRecordKeys) + the Time Machine (recordKeyChangeRows).
 * These cases measure the OUTCOME on the rows, never the call spelling:
 *
 *   O1  update_parent_data: the moved node has ONE parent-key history row (the
 *       move, never an intermediate parentless state), an order row, and its
 *       stamps name the actor; the renumbered old sibling is historied and
 *       stamped too
 *   O2  add_child: the new node's parent link and order are historied + stamped
 *   O3  save_order: every CHANGED sibling gets an order row + stamps, an
 *       unchanged one gets nothing
 *   O4  a move refused INSIDE its transaction (tree.cycle from the locked walk,
 *       after the old link's order was already rewritten) leaves no history
 *       row and no stamp on any node; the door's fast pre-check refusal too
 *   O5  the writer cuts the history from the key's STORED before-image: a
 *       one-language change of a lang-sliced key records that language only
 *
 * The census twin is write_obligations_tripwire (the tree files carry no raw
 * writer). SITUATION: scratch TLD `zztob` (test/helpers/tree_lock_situation.ts),
 * records created at runtime, swept with the TLD (rows + TM), asserted 0.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { AUDIT_TIPOS } from '../../src/core/concepts/section.ts';
import { sql, withTransaction } from '../../src/core/db/postgres.ts';
import { isDedaloError } from '../../src/core/errors/index.ts';
import { moveParent, persistTreeKeys } from '../../src/core/relations/parent.ts';
import type { Principal } from '../../src/core/security/permissions.ts';
import { assertTestDatabase } from '../../src/core/test_data/test_database_marker.ts';
import { withTreeTransaction } from '../../src/core/ts_object/tree_locks.ts';
import { addChild, saveOrder, updateParentData } from '../../src/core/ts_object/ts_api.ts';
import { settle } from '../helpers/lock_wait.ts';
import {
	dropTreeSituation,
	ensureTreeSituation,
	newNodes,
	orderUnder,
	ROOT_USER_ID,
	seedLinks,
	storedLinks,
	type TreeSection,
	treeSituation,
} from '../helpers/tree_lock_situation.ts';

const TREE = treeSituation('zztob');
const ORDERED = TREE.ordered;
const SUPERUSER: Principal = { userId: ROOT_USER_ID, isGlobalAdmin: true, isDeveloper: true };
const ORDER_TIPO = ORDERED.order as string;

beforeAll(async () => {
	await ensureTreeSituation(TREE);
}, 60_000);

afterAll(async () => {
	expect(await dropTreeSituation(TREE)).toBe(0);
}, 60_000);

/** The newest Time Machine id (the watermark a door's rows are counted above). */
async function tmWatermark(): Promise<number> {
	const rows = (await sql.unsafe(
		'SELECT COALESCE(MAX(id), 0)::int AS id FROM matrix_time_machine',
	)) as { id: number }[];
	return Number(rows[0]?.id ?? 0);
}

/** The history rows of one key of one node written above `since`, oldest first. */
async function historyRows(
	s: TreeSection,
	id: number,
	tipo: string,
	since: number,
): Promise<{ data: unknown; user_id: string; lang: string }[]> {
	return (await sql.unsafe(
		`SELECT data, user_id, lang FROM matrix_time_machine
		  WHERE section_tipo = $1 AND section_id = $2 AND tipo = $3 AND id > $4
		  ORDER BY id`,
		[s.section, id, tipo, since],
	)) as { data: unknown; user_id: string; lang: string }[];
}

/** The node's modified stamps: the dd197 user id (null when absent) and whether dd201 is set. */
async function stamps(s: TreeSection, id: number): Promise<{ user: number | null; date: boolean }> {
	const rows = (await sql.unsafe(
		`SELECT relation->$3 AS user, date->$4 AS date FROM "${s.table}"
		  WHERE section_tipo = $1 AND section_id = $2`,
		[s.section, id, AUDIT_TIPOS.modifiedByUser, AUDIT_TIPOS.modifiedDate],
	)) as { user: unknown; date: unknown }[];
	const user = Array.isArray(rows[0]?.user)
		? (rows[0]?.user[0] as { section_id?: unknown } | undefined)
		: undefined;
	return {
		user: user === undefined ? null : Number(user.section_id),
		date: Array.isArray(rows[0]?.date) && rows[0].date.length > 0,
	};
}

/** The order items stored on a node (`[]` when the key is absent). */
async function storedOrder(s: TreeSection, id: number): Promise<unknown[]> {
	const rows = (await sql.unsafe(
		`SELECT number->$3 AS items FROM "${s.table}" WHERE section_tipo = $1 AND section_id = $2`,
		[s.section, id, ORDER_TIPO],
	)) as { items: unknown }[];
	return Array.isArray(rows[0]?.items) ? (rows[0]?.items as unknown[]) : [];
}

function moveRqo(s: TreeSection, child: number, from: number, to: number) {
	return {
		source: {
			section_tipo: s.section,
			section_id: child,
			old_parent_section_tipo: s.section,
			old_parent_section_id: from,
			new_parent_section_tipo: s.section,
			new_parent_section_id: to,
		},
	} as never;
}

describe('Step 5: a tree door writes what every record write writes', () => {
	test('O1 update_parent_data: ONE history row for the move, the order historied, stamps name the actor', async () => {
		const [r, pA, pB, x, s] = await newNodes(ORDERED, 5);
		await seedLinks(ORDERED, pA, [{ parent: r, itemId: 1, order: 1 }]);
		await seedLinks(ORDERED, pB, [{ parent: r, itemId: 1, order: 2 }]);
		await seedLinks(ORDERED, x, [{ parent: pA, itemId: 1, order: 1 }]);
		await seedLinks(ORDERED, s, [{ parent: pA, itemId: 1, order: 2 }]);
		expect((await stamps(ORDERED, x)).user).toBeNull();
		const since = await tmWatermark();

		const response = await updateParentData(moveRqo(ORDERED, x, pA, pB), SUPERUSER);
		expect(response.data).toBe(true);

		// The parent key: exactly one row, holding the links as stored (the move as
		// ONE change — a parentless intermediate row would restore an orphan).
		// Re-pinned 2026-11-12 (T1-21): the links were seeded RAW (no history), so
		// the writer first records them as they stood (the save-before: under pA —
		// a parented state, never an orphan), then the move's ONE row.
		const linkRows = await historyRows(ORDERED, x, ORDERED.parent, since);
		expect(linkRows.length, 'the move must leave exactly one parent-key history row').toBe(2);
		expect(JSON.stringify(linkRows[0]?.data)).toContain(`"section_id":${pA}`);
		expect(linkRows[1]?.data).toEqual(await storedLinks(ORDERED, x));
		expect(Number(linkRows[1]?.user_id)).toBe(ROOT_USER_ID);
		// The order key: historied, ending on the stored state.
		const orderRows = await historyRows(ORDERED, x, ORDER_TIPO, since);
		expect(orderRows.length).toBeGreaterThan(0);
		expect(orderRows.at(-1)?.data).toEqual(await storedOrder(ORDERED, x));
		expect(await orderUnder(ORDERED, x, pB)).toBe(1);
		// The stamps moved with the write.
		expect(await stamps(ORDERED, x)).toEqual({ user: ROOT_USER_ID, date: true });

		// The old sibling renumbered 2 → 1: historied and stamped.
		expect(await orderUnder(ORDERED, s, pA)).toBe(1);
		// + the save-before row of its RAW-seeded order (re-pinned 2026-11-12, T1-21).
		const siblingRows = await historyRows(ORDERED, s, ORDER_TIPO, since);
		expect(siblingRows.length).toBe(2);
		expect(siblingRows[1]?.data).toEqual(await storedOrder(ORDERED, s));
		expect(await stamps(ORDERED, s)).toEqual({ user: ROOT_USER_ID, date: true });
	}, 60_000);

	test('O2 add_child: the new node’s link and order are historied, its stamps name the actor', async () => {
		const [r, p] = await newNodes(ORDERED, 2);
		await seedLinks(ORDERED, p, [{ parent: r, itemId: 1, order: 1 }]);
		const since = await tmWatermark();

		const response = await addChild(
			{ source: { section_tipo: ORDERED.section, section_id: p } } as never,
			SUPERUSER,
		);
		const child = Number(response.data);
		expect(Number.isSafeInteger(child) && child > 0).toBe(true);

		const linkRows = await historyRows(ORDERED, child, ORDERED.parent, since);
		expect(linkRows.length).toBe(1);
		expect(linkRows[0]?.data).toEqual(await storedLinks(ORDERED, child));
		expect((await storedLinks(ORDERED, child)).map((link) => Number(link.section_id))).toEqual([p]);
		const orderRows = await historyRows(ORDERED, child, ORDER_TIPO, since);
		expect(orderRows.length).toBe(1);
		expect(orderRows[0]?.data).toEqual(await storedOrder(ORDERED, child));
		expect(await stamps(ORDERED, child)).toEqual({ user: ROOT_USER_ID, date: true });
	}, 60_000);

	test('O3 save_order: each CHANGED sibling is historied and stamped, an unchanged one is not', async () => {
		const [p, a, b, c] = await newNodes(ORDERED, 4);
		await seedLinks(ORDERED, a, [{ parent: p, itemId: 1, order: 1 }]);
		await seedLinks(ORDERED, b, [{ parent: p, itemId: 1, order: 2 }]);
		await seedLinks(ORDERED, c, [{ parent: p, itemId: 1, order: 3 }]);
		const since = await tmWatermark();

		// [b, a, c]: a and b swap, c stays 3.
		const response = await saveOrder(
			{
				source: {
					section_tipo: ORDERED.section,
					ar_locators: [b, a, c].map((id) => ({ section_tipo: ORDERED.section, section_id: id })),
					parent_section_tipo: ORDERED.section,
					parent_section_id: p,
				},
			} as never,
			SUPERUSER,
		);
		expect((response.data as unknown[]).length).toBe(2);

		for (const [id, order] of [
			[b, 1],
			[a, 2],
		] as const) {
			expect(await orderUnder(ORDERED, id, p)).toBe(order);
			// + the save-before row of the RAW-seeded order (re-pinned 2026-11-12, T1-21).
			const rows = await historyRows(ORDERED, id, ORDER_TIPO, since);
			expect(rows.length, `sibling ${id} has no order history row`).toBe(2);
			expect(rows[1]?.data).toEqual(await storedOrder(ORDERED, id));
			expect(await stamps(ORDERED, id)).toEqual({ user: ROOT_USER_ID, date: true });
		}
		expect(await historyRows(ORDERED, c, ORDER_TIPO, since)).toEqual([]);
		expect((await stamps(ORDERED, c)).user).toBeNull();
	}, 60_000);

	test('O4 a move refused INSIDE its transaction, after it rewrote the old order, leaves no history row and no stamp', async () => {
		// R → A → D. Moving A under D: moveParent first REMOVES A's order under R
		// (a real write — its value and TM row land in the transaction), then the
		// locked walk finds D below A and throws tree.cycle. Driven past the
		// door's unlocked fast pre-check on purpose: that check would refuse
		// before anything is written, which proves nothing about the rollback.
		const [r, a, d] = await newNodes(ORDERED, 3);
		await seedLinks(ORDERED, a, [{ parent: r, itemId: 1, order: 1 }]);
		await seedLinks(ORDERED, d, [{ parent: a, itemId: 1, order: 1 }]);
		expect(
			await orderUnder(ORDERED, a, r),
			'the old order must exist (else no write precedes the refusal)',
		).toBe(1);
		const linksBefore = await storedLinks(ORDERED, a);
		const orderBefore = await storedOrder(ORDERED, a);
		const since = await tmWatermark();

		const link = (parent: number) => ({
			section_tipo: ORDERED.section,
			section_id: parent,
			from_component_tipo: ORDERED.parent,
			type: 'dd47',
		});
		const outcome = await settle(
			withTreeTransaction(() =>
				moveParent(ORDERED.section, a, ORDERED.parent, link(r), link(d), ROOT_USER_ID),
			),
		);
		const reason = outcome.status === 'rejected' ? outcome.reason : null;
		expect(isDedaloError(reason) ? reason.code : String(reason)).toBe('tree.cycle');
		for (const id of [a, d, r]) {
			for (const tipo of [ORDERED.parent, ORDER_TIPO]) {
				expect(await historyRows(ORDERED, id, tipo, since), `history of ${id}/${tipo}`).toEqual([]);
			}
			expect((await stamps(ORDERED, id)).user, `stamp of ${id}`).toBeNull();
		}
		expect(await storedLinks(ORDERED, a)).toEqual(linksBefore);
		expect(await storedOrder(ORDERED, a)).toEqual(orderBefore);
	}, 60_000);

	test('O4b the door’s FAST pre-check refusal (before its transaction) writes nothing either', async () => {
		const [r, a, d] = await newNodes(ORDERED, 3);
		await seedLinks(ORDERED, a, [{ parent: r, itemId: 1, order: 1 }]);
		await seedLinks(ORDERED, d, [{ parent: a, itemId: 1, order: 1 }]);
		const since = await tmWatermark();

		const outcome = await settle(updateParentData(moveRqo(ORDERED, a, r, d), SUPERUSER));
		expect(outcome.status).toBe('rejected');
		for (const id of [a, d, r]) {
			for (const tipo of [ORDERED.parent, ORDER_TIPO]) {
				expect(await historyRows(ORDERED, id, tipo, since)).toEqual([]);
			}
			expect((await stamps(ORDERED, id)).user).toBeNull();
		}
	}, 60_000);
});

describe('Step 5: the tree writer cuts its history from the stored before-image', () => {
	test('O5 a one-language change of a lang-sliced key records that language only', async () => {
		const [x] = await newNodes(ORDERED, 1);
		const english = { id: 1, lang: 'lg-eng', value: 'alpha' };
		await assertTestDatabase('tree_obligations O5 seed');
		await sql.unsafe(
			`UPDATE "${ORDERED.table}"
			    SET string = jsonb_set(COALESCE(string, '{}'::jsonb), ARRAY[$3::text], $4::text::jsonb)
			  WHERE section_tipo = $1 AND section_id = $2`,
			[
				ORDERED.section,
				x,
				ORDERED.term,
				JSON.stringify([english, { id: 1, lang: 'lg-spa', value: 'alfa' }]),
			],
		);
		const since = await tmWatermark();

		await withTransaction(() =>
			persistTreeKeys(
				{ table: ORDERED.table, sectionTipo: ORDERED.section, sectionId: x },
				[
					{
						column: 'string',
						key: ORDERED.term,
						after: [english, { id: 1, lang: 'lg-spa', value: 'beta' }],
					},
				],
				ROOT_USER_ID,
			),
		);

		const rows = await historyRows(ORDERED, x, ORDERED.term, since);
		const langs = rows.map((row) => row.lang);
		// The unchanged English lane has NO row: a writer that forgot the stored
		// value (an empty before-image) would record it as a change.
		expect(langs, JSON.stringify(rows)).not.toContain('lg-eng');
		// The RAW-seeded spa lane is backfilled first ('alfa', the save-before,
		// re-pinned 2026-11-12 — T1-21), then the change ('beta').
		const spanish = rows.filter((row) => row.lang === 'lg-spa');
		expect(spanish.length).toBe(2);
		expect(JSON.stringify(spanish[0]?.data)).toContain('alfa');
		expect(JSON.stringify(spanish[1]?.data)).toContain('beta');
		expect(rows.every((row) => Number(row.user_id) === ROOT_USER_ID)).toBe(true);
	}, 60_000);
});
