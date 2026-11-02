/**
 * SUB-LAW (b) — SOURCE OVERWRITE, end to end on the suite DB (2026-10-30).
 *
 * The tool_cataloging case: a catalog term's pointer (testcoincatalog1004,
 * the twin of numisdata656) names a coin TYPE; the term's external portals
 * COPY that type's components —
 *   testcoincatalog1013 ← test6157 (the type's coins, itself an inverse mirror)
 *   testcoincatalog1019 ← test6105 (the type's "ordered coins", a plain portal)
 * Before the law registry the kernel REFUSED both nodes (the Phase-0
 * disarm), so a term's coin portals stayed empty forever.
 *
 * WHAT IS PINNED (synthesis §4, critique 1/10/12, owner rulings Q1/Q3/Q5):
 *   1. a save of the pointer fills both copies — source order, observer-owned
 *      ids, from_component_tipo rewritten, index agreeing + one TM row each —
 *      on a term in the REAL section AND one in the VIRTUAL test6409 (the
 *      host predicate is declaredSectionComponents, virtual-aware); the TYPE
 *      the pointer names gets no copy slot (host precondition);
 *   2. the declared INVERSE edge: a save of test6105 on the type updates the
 *      term's 1019, and its target records get no write;
 *   3. ordering is the value: a reorder of test6105 reorders 1019;
 *   4. the DERIVED edge (Q1): linking a new coin to the type grows test6157
 *      by cascade, and the derived test6157 → 1013 edge grows the term's 1013;
 *   5. type switch A → B: B's bag, nothing of A left;
 *   6. pointer: the FIRST QUALIFYING locator (Q5) — a first locator into a
 *      section that does not declare the source (testmint1) is skipped;
 *   7. unlink (empty pointer) → [];
 *   8. a DANGLING source (the pointed record is gone) → [] (Q3, PHP parity);
 *   9. no drift → zero writes (no TM row);
 *  10. the tree badge: get_children_data of the term's parent emits the 1019
 *      "Monedas" icon once the pointer save returned (critique 10 — the drop
 *      flow refreshes the tree right after the save response);
 *  11. a duplicate of a term recomputes its copies from the copied pointer;
 *  12. THE DELETE DOOR (deleteSectionRecord, no explicit refresh): deleting the
 *      pointed TYPE empties the term's 1013/1019 once the call returns (COMMIT
 *      + ledger drain); undeleting the type (tool_time_machine apply_value)
 *      leaves the term converged; deleting the TERM and undeleting it after
 *      its source changed recomputes the copies (never the snapshot's).
 *
 * SITUATION: repo-owned `test`/`testcoincatalog` nodes (the suite ontology);
 * every record is created at runtime and swept in afterAll (records + TM rows).
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { sql } from '../../src/core/db/postgres.ts';
import { getMatrixTableFromTipo } from '../../src/core/ontology/resolver.ts';
import { createSectionRecord } from '../../src/core/section/record/create_record.ts';
import { deleteSectionRecord } from '../../src/core/section/record/delete_record.ts';
import { duplicateSectionRecord } from '../../src/core/section/record/duplicate_record.ts';
import { getObserverSubscriptions } from '../../src/core/section/record/observer_subscriptions.ts';
import { refreshExternalMirror } from '../../src/core/section/record/observers.ts';
import { saveComponentData } from '../../src/core/section/record/save_component.ts';
import { isObservedTipo } from '../../src/core/section_record/obligation_ledger.ts';
import { hiIndexDisagrees } from '../../src/core/section_record/record_write.ts';
import { type Principal, resolvePrincipal } from '../../src/core/security/permissions.ts';
import { assertTestDatabase } from '../../src/core/test_data/test_database_marker.ts';
import { getChildrenData } from '../../src/core/ts_object/ts_api.ts';
import { toolTimeMachineApplyValue } from '../../tools/tool_time_machine/server/tool_time_machine.ts';
import { cleanScratchRecord } from '../helpers/test_data.ts';

const USER_ID = -1;
const SUPERUSER: Principal = { userId: -1, isGlobalAdmin: true, isDeveloper: true };

const TERM_SECTION = 'testcoincatalog1';
/** A VIRTUAL section of testcoincatalog1 (the numisdata665 twin). */
const VIRTUAL_TERM_SECTION = 'test6409';
const POINTER = 'testcoincatalog1004';
const COINS_COPY = 'testcoincatalog1013';
const ORDERED_COPY = 'testcoincatalog1019';
const TERM_PARENT = 'testcoincatalog1006';
const TERM_CHILDREN = 'testcoincatalog1007';

const TYPE_SECTION = 'test6099';
const TYPE_COINS = 'test6157';
const TYPE_ORDERED = 'test6105';
const COIN_SECTION = 'test6100';
const COIN_TYPE_LINK = 'test6230';
const ORDERED_SECTION = 'test6310';
/** A section the pointer may name that does NOT declare the copied source. */
const MINT_SECTION = 'testmint1';

const created: { sectionTipo: string; sectionId: number }[] = [];
const tables = new Map<string, string>();

async function tableOf(sectionTipo: string): Promise<string> {
	const known = tables.get(sectionTipo);
	if (known !== undefined) return known;
	const table = await getMatrixTableFromTipo(sectionTipo);
	if (table === null) throw new Error(`no matrix table for ${sectionTipo}`);
	tables.set(sectionTipo, table);
	return table;
}

async function born(sectionTipo: string): Promise<number> {
	const sectionId = await createSectionRecord(sectionTipo, USER_ID);
	created.push({ sectionTipo, sectionId });
	return sectionId;
}

const locator = (from: string, sectionTipo: string, sectionId: number, type = 'dd151') => ({
	type,
	section_tipo: sectionTipo,
	section_id: String(sectionId),
	from_component_tipo: from,
});

/** A relation save through THE door (propagation + obligation ledger included). */
async function saveRelation(
	componentTipo: string,
	sectionTipo: string,
	sectionId: number,
	value: unknown[],
): Promise<void> {
	const saved = await saveComponentData({
		componentTipo,
		sectionTipo,
		sectionId,
		lang: 'lg-nolan',
		changedData: [{ action: 'set_data', id: null, value }] as never,
		userId: USER_ID,
	});
	expect(saved.ok, saved.message).toBe(true);
}

type Item = Record<string, unknown>;

async function relationKey(sectionTipo: string, sectionId: number, key: string): Promise<Item[]> {
	const rows = (await sql.unsafe(
		`SELECT relation->$3 AS value FROM "${await tableOf(sectionTipo)}" WHERE section_tipo = $1 AND section_id = $2`,
		[sectionTipo, sectionId, key],
	)) as { value: unknown }[];
	const value = rows[0]?.value;
	return Array.isArray(value) ? (value as Item[]) : [];
}

async function hasRelationKey(sectionTipo: string, sectionId: number, key: string) {
	const rows = (await sql.unsafe(
		`SELECT relation ? $3 AS has FROM "${await tableOf(sectionTipo)}" WHERE section_tipo = $1 AND section_id = $2`,
		[sectionTipo, sectionId, key],
	)) as { has: boolean }[];
	return rows[0]?.has === true;
}

async function indexKey(sectionTipo: string, sectionId: number, key: string): Promise<unknown> {
	const rows = (await sql.unsafe(
		`SELECT relation_search->$3 AS value FROM "${await tableOf(sectionTipo)}" WHERE section_tipo = $1 AND section_id = $2`,
		[sectionTipo, sectionId, key],
	)) as { value: unknown }[];
	return rows[0]?.value ?? null;
}

async function tmRows(sectionTipo: string, sectionId: number, tipo: string): Promise<number> {
	const rows = (await sql.unsafe(
		'SELECT count(*)::int AS n FROM matrix_time_machine WHERE section_tipo = $1 AND section_id = $2 AND tipo = $3',
		[sectionTipo, sectionId, tipo],
	)) as { n: number }[];
	return rows[0]?.n ?? 0;
}

/** The non-empty TM values of one key, oldest first (the empty epoch row excluded). */
async function tmValueRows(
	sectionTipo: string,
	sectionId: number,
	tipo: string,
): Promise<unknown[]> {
	const rows = (await sql.unsafe(
		`SELECT data FROM matrix_time_machine WHERE section_tipo = $1 AND section_id = $2 AND tipo = $3
		 AND data IS NOT NULL AND data <> 'null'::jsonb ORDER BY id`,
		[sectionTipo, sectionId, tipo],
	)) as { data: unknown }[];
	return rows.map((row) => row.data);
}

/** Store one relation key RAW (a source bag), bypassing every door and propagation. */
async function storeRelationKey(
	sectionTipo: string,
	sectionId: number,
	key: string,
	value: unknown[],
): Promise<void> {
	await assertTestDatabase('observer_source_overwrite_native.storeRelationKey');
	await sql.unsafe(
		`UPDATE "${await tableOf(sectionTipo)}" SET relation = jsonb_set(COALESCE(relation, '{}'::jsonb), ARRAY[$3::text], $4::text::jsonb)
		 WHERE section_tipo = $1 AND section_id = $2`,
		[sectionTipo, sectionId, key, JSON.stringify(value)],
	);
}

/** The (section_tipo, section_id) addresses of a bag, in stored order. */
const addresses = (items: Item[]): string[] =>
	items.map((item) => `${String(item.section_tipo)}/${String(Number(item.section_id))}`);

const addr = (sectionTipo: string, sectionId: number) => `${sectionTipo}/${sectionId}`;

let typeA = 0;
let typeB = 0;
let coinA1 = 0;
let coinA2 = 0;
let coinB1 = 0;
let ordered1 = 0;
let ordered2 = 0;
let ordered3 = 0;
let termReal = 0;
let termVirtual = 0;

beforeAll(async () => {
	typeA = await born(TYPE_SECTION);
	typeB = await born(TYPE_SECTION);
	coinA1 = await born(COIN_SECTION);
	coinA2 = await born(COIN_SECTION);
	coinB1 = await born(COIN_SECTION);
	ordered1 = await born(ORDERED_SECTION);
	ordered2 = await born(ORDERED_SECTION);
	ordered3 = await born(ORDERED_SECTION);
	// The types' coins by THE cascade (coin → test6230 → relay → test6157).
	await saveRelation(COIN_TYPE_LINK, COIN_SECTION, coinA1, [
		locator(COIN_TYPE_LINK, TYPE_SECTION, typeA),
	]);
	await saveRelation(COIN_TYPE_LINK, COIN_SECTION, coinB1, [
		locator(COIN_TYPE_LINK, TYPE_SECTION, typeB),
	]);
	await saveRelation(TYPE_ORDERED, TYPE_SECTION, typeA, [
		locator(TYPE_ORDERED, ORDERED_SECTION, ordered1),
		locator(TYPE_ORDERED, ORDERED_SECTION, ordered2),
	]);
	await saveRelation(TYPE_ORDERED, TYPE_SECTION, typeB, [
		locator(TYPE_ORDERED, ORDERED_SECTION, ordered3),
	]);
	termReal = await born(TERM_SECTION);
	termVirtual = await born(VIRTUAL_TERM_SECTION);
}, 120_000);

afterAll(async () => {
	for (const { sectionTipo, sectionId } of created.reverse()) {
		await cleanScratchRecord(sectionTipo, sectionId, await tableOf(sectionTipo));
	}
}, 120_000);

describe('FLOOR — the situation the copies read', () => {
	test('the types hold their coins (cascade) and their ordered coins', async () => {
		expect(addresses(await relationKey(TYPE_SECTION, typeA, TYPE_COINS))).toEqual([
			addr(COIN_SECTION, coinA1),
		]);
		expect(addresses(await relationKey(TYPE_SECTION, typeB, TYPE_COINS))).toEqual([
			addr(COIN_SECTION, coinB1),
		]);
		expect(addresses(await relationKey(TYPE_SECTION, typeA, TYPE_ORDERED))).toEqual([
			addr(ORDERED_SECTION, ordered1),
			addr(ORDERED_SECTION, ordered2),
		]);
	});
});

describe('1. a save of the pointer fills both copies', () => {
	for (const [label, section] of [
		['REAL term section', TERM_SECTION],
		['VIRTUAL term section (test6409 → testcoincatalog1)', VIRTUAL_TERM_SECTION],
	] as const) {
		test(`${label}: 1013 = type.test6157, 1019 = type.test6105 — observer-owned, indexed, one TM row each`, async () => {
			const term = section === TERM_SECTION ? termReal : termVirtual;
			await saveRelation(POINTER, section, term, [locator(POINTER, TYPE_SECTION, typeA)]);

			const coins = await relationKey(section, term, COINS_COPY);
			const ordered = await relationKey(section, term, ORDERED_COPY);
			expect(addresses(coins), 'the coins copy is not the type’s test6157').toEqual([
				addr(COIN_SECTION, coinA1),
			]);
			expect(
				addresses(ordered),
				'the ordered copy is not the type’s test6105, in source order',
			).toEqual([addr(ORDERED_SECTION, ordered1), addr(ORDERED_SECTION, ordered2)]);
			for (const [key, bag] of [
				[COINS_COPY, coins],
				[ORDERED_COPY, ordered],
			] as const) {
				expect(bag.every((item) => item.from_component_tipo === key)).toBe(true);
				expect(bag.every((item) => typeof item.section_id === 'number')).toBe(true);
				// observer-owned ids: 1..n, never the source's
				expect(bag.map((item) => item.id)).toEqual(bag.map((_, at) => at + 1));
				// the stored relation_search agrees with the SAVE law's derivation
				// (a portal keeps none; the mirror write derives it in the same UPDATE)
				expect(
					await hiIndexDisagrees(key, bag, await indexKey(section, term, key)),
					`${key}: relation_search index disagrees with the save law`,
				).toBe(false);
				// ONE history row carries the value (a first write of a key also
				// records the empty epoch row before it — the TM epoch convention)
				expect(await tmValueRows(section, term, key), `${key}: one TM value row`).toEqual([bag]);
			}
		}, 120_000);
	}

	test('the TYPE the pointer names gets no copy slot (host precondition)', async () => {
		expect(await hasRelationKey(TYPE_SECTION, typeA, COINS_COPY)).toBe(false);
		expect(await hasRelationKey(TYPE_SECTION, typeA, ORDERED_COPY)).toBe(false);
	});
});

describe('2-3. the declared inverse edge (test6105 → 1019) and the order', () => {
	test('a save of test6105 on the type updates the term’s 1019; its targets get no write', async () => {
		await saveRelation(TYPE_ORDERED, TYPE_SECTION, typeA, [
			locator(TYPE_ORDERED, ORDERED_SECTION, ordered1),
			locator(TYPE_ORDERED, ORDERED_SECTION, ordered2),
			locator(TYPE_ORDERED, ORDERED_SECTION, ordered3),
		]);
		for (const [section, term] of [
			[TERM_SECTION, termReal],
			[VIRTUAL_TERM_SECTION, termVirtual],
		] as const) {
			expect(addresses(await relationKey(section, term, ORDERED_COPY))).toEqual([
				addr(ORDERED_SECTION, ordered1),
				addr(ORDERED_SECTION, ordered2),
				addr(ORDERED_SECTION, ordered3),
			]);
		}
		for (const id of [ordered1, ordered2, ordered3]) {
			expect(await hasRelationKey(ORDERED_SECTION, id, ORDERED_COPY)).toBe(false);
		}
	}, 120_000);

	test('a REORDER of test6105 reorders 1019 (the order is the value), ids kept', async () => {
		const before = await relationKey(TERM_SECTION, termReal, ORDERED_COPY);
		const idOf = new Map(before.map((item) => [Number(item.section_id), item.id]));
		await saveRelation(TYPE_ORDERED, TYPE_SECTION, typeA, [
			locator(TYPE_ORDERED, ORDERED_SECTION, ordered3),
			locator(TYPE_ORDERED, ORDERED_SECTION, ordered1),
			locator(TYPE_ORDERED, ORDERED_SECTION, ordered2),
		]);
		const after = await relationKey(TERM_SECTION, termReal, ORDERED_COPY);
		expect(addresses(after)).toEqual([
			addr(ORDERED_SECTION, ordered3),
			addr(ORDERED_SECTION, ordered1),
			addr(ORDERED_SECTION, ordered2),
		]);
		for (const item of after) {
			expect(item.id, 'a kept item keeps its stored id').toBe(idOf.get(Number(item.section_id)));
		}
	}, 120_000);
});

describe('4. the DERIVED edge test6157 → 1013 (via the pointer)', () => {
	test('FLOOR: the registry carries it (law-derived, via 1004); 1019 ← test6105 stays declared', async () => {
		const derived = (await getObserverSubscriptions(TYPE_COINS)).filter(
			(sub) => sub.observerTipo === COINS_COPY,
		);
		expect(derived.map((sub) => [sub.declaration, sub.origin, sub.via])).toEqual([
			['law-derived', 'law', POINTER],
		]);
		const declared = (await getObserverSubscriptions(TYPE_ORDERED)).filter(
			(sub) => sub.observerTipo === ORDERED_COPY,
		);
		expect(declared.length).toBe(1);
		expect(declared[0]?.origin).not.toBe('law');
		// the obligation ledger's "is anyone observing this key" pre-gate sees it
		expect(await isObservedTipo(TYPE_COINS)).toBe(true);
	});

	test('linking a new coin to the type grows test6157 by cascade, and the term’s 1013', async () => {
		await saveRelation(COIN_TYPE_LINK, COIN_SECTION, coinA2, [
			locator(COIN_TYPE_LINK, TYPE_SECTION, typeA),
		]);
		const typeCoins = addresses(await relationKey(TYPE_SECTION, typeA, TYPE_COINS));
		expect(typeCoins, 'FLOOR: the type’s inverse mirror grew').toContain(
			addr(COIN_SECTION, coinA2),
		);
		for (const [section, term] of [
			[TERM_SECTION, termReal],
			[VIRTUAL_TERM_SECTION, termVirtual],
		] as const) {
			expect(
				addresses(await relationKey(section, term, COINS_COPY)),
				'the term’s coins copy did not follow its type — no derived edge from test6157',
			).toEqual(typeCoins);
		}
	}, 120_000);
});

describe('5-8. the pointer decides the source', () => {
	test('5. type switch A → B: B’s bags, nothing of A left', async () => {
		await saveRelation(POINTER, TERM_SECTION, termReal, [locator(POINTER, TYPE_SECTION, typeB)]);
		expect(addresses(await relationKey(TERM_SECTION, termReal, COINS_COPY))).toEqual([
			addr(COIN_SECTION, coinB1),
		]);
		expect(addresses(await relationKey(TERM_SECTION, termReal, ORDERED_COPY))).toEqual([
			addr(ORDERED_SECTION, ordered3),
		]);
	}, 120_000);

	test('6. the FIRST QUALIFYING locator: a first link into a section without the source is skipped', async () => {
		const mint = await born(MINT_SECTION);
		await saveRelation(POINTER, TERM_SECTION, termReal, [
			locator(POINTER, MINT_SECTION, mint),
			locator(POINTER, TYPE_SECTION, typeA),
		]);
		expect(
			addresses(await relationKey(TERM_SECTION, termReal, ORDERED_COPY)),
			'the copy did not come from the first locator whose section declares test6105',
		).toEqual(addresses(await relationKey(TYPE_SECTION, typeA, TYPE_ORDERED)));
		expect(addresses(await relationKey(TERM_SECTION, termReal, COINS_COPY))).toEqual(
			addresses(await relationKey(TYPE_SECTION, typeA, TYPE_COINS)),
		);
	}, 120_000);

	test('7. unlink (empty pointer) → both copies []', async () => {
		await saveRelation(POINTER, TERM_SECTION, termReal, []);
		expect(await relationKey(TERM_SECTION, termReal, COINS_COPY)).toEqual([]);
		expect(await relationKey(TERM_SECTION, termReal, ORDERED_COPY)).toEqual([]);
	}, 120_000);

	test('8. a DANGLING source (the pointed record is gone) → [] (PHP parity)', async () => {
		const doomed = await born(TYPE_SECTION);
		await storeRelationKey(TYPE_SECTION, doomed, TYPE_ORDERED, [
			{ id: 1, ...locator(TYPE_ORDERED, ORDERED_SECTION, ordered1), section_id: ordered1 },
		]);
		const term = await born(TERM_SECTION);
		await saveRelation(POINTER, TERM_SECTION, term, [locator(POINTER, TYPE_SECTION, doomed)]);
		expect(
			addresses(await relationKey(TERM_SECTION, term, ORDERED_COPY)),
			'FLOOR: the copy was filled before the source vanished',
		).toEqual([addr(ORDERED_SECTION, ordered1)]);
		await cleanScratchRecord(TYPE_SECTION, doomed, await tableOf(TYPE_SECTION));
		const outcome = await refreshExternalMirror(
			ORDERED_COPY,
			TERM_SECTION,
			term,
			USER_ID,
			new Date(),
		);
		expect(outcome.skippedShrink, 'a dangling source is not a degraded value').toBeUndefined();
		expect(await relationKey(TERM_SECTION, term, ORDERED_COPY)).toEqual([]);
	}, 120_000);
});

describe('9. no drift → zero writes', () => {
	test('a refresh of an agreeing copy writes nothing (no TM row)', async () => {
		const term = termVirtual;
		const before = await tmRows(VIRTUAL_TERM_SECTION, term, ORDERED_COPY);
		const bag = await relationKey(VIRTUAL_TERM_SECTION, term, ORDERED_COPY);
		expect(bag.length, 'FLOOR: the copy is non-empty').toBeGreaterThan(0);
		const outcome = await refreshExternalMirror(
			ORDERED_COPY,
			VIRTUAL_TERM_SECTION,
			term,
			USER_ID,
			new Date(),
		);
		expect(outcome.changed).toBe(false);
		expect(outcome.wrote).not.toBe(true);
		expect(await tmRows(VIRTUAL_TERM_SECTION, term, ORDERED_COPY)).toBe(before);
		expect(await relationKey(VIRTUAL_TERM_SECTION, term, ORDERED_COPY)).toEqual(bag);
	}, 120_000);
});

describe('10. the tree badge (get_children_data emits the 1019 icon)', () => {
	test('a child term whose pointer save returned shows the "Monedas" 1019 icon', async () => {
		const parent = await born(VIRTUAL_TERM_SECTION);
		const child = await born(VIRTUAL_TERM_SECTION);
		await saveRelation(TERM_PARENT, VIRTUAL_TERM_SECTION, child, [
			locator(TERM_PARENT, VIRTUAL_TERM_SECTION, parent, 'dd47'),
		]);
		const iconOf = async (): Promise<Item | undefined> => {
			const response = await getChildrenData(
				{
					dd_api: 'dd_ts_api',
					action: 'get_children_data',
					source: {
						section_tipo: VIRTUAL_TERM_SECTION,
						section_id: parent,
						children_tipo: TERM_CHILDREN,
					},
				} as never,
				SUPERUSER,
			);
			const children = (response.data as { ar_children_data: Item[] }).ar_children_data;
			const node = children.find((entry) => Number(entry.section_id) === child);
			expect(node, 'FLOOR: the child is in the parent’s children page').toBeDefined();
			return ((node?.ar_elements ?? []) as Item[]).find(
				(element) => element.type === 'icon' && element.tipo === ORDERED_COPY,
			);
		};
		expect(await iconOf(), 'no badge before the term is linked').toBeUndefined();
		await saveRelation(POINTER, VIRTUAL_TERM_SECTION, child, [
			locator(POINTER, TYPE_SECTION, typeA),
		]);
		expect(
			(await iconOf())?.value,
			'the badge did not follow the save — the copy was not computed before the save returned',
		).toBe('Monedas');
	}, 120_000);
});

describe('11. duplicate of a term recomputes its copies', () => {
	test('the clone’s 1013/1019 are the bags its copied pointer names', async () => {
		const clone = await duplicateSectionRecord(VIRTUAL_TERM_SECTION, termVirtual, USER_ID);
		created.push({ sectionTipo: VIRTUAL_TERM_SECTION, sectionId: clone });
		expect(addresses(await relationKey(VIRTUAL_TERM_SECTION, clone, POINTER))).toEqual([
			addr(TYPE_SECTION, typeA),
		]);
		expect(addresses(await relationKey(VIRTUAL_TERM_SECTION, clone, COINS_COPY))).toEqual(
			addresses(await relationKey(TYPE_SECTION, typeA, TYPE_COINS)),
		);
		expect(addresses(await relationKey(VIRTUAL_TERM_SECTION, clone, ORDERED_COPY))).toEqual(
			addresses(await relationKey(TYPE_SECTION, typeA, TYPE_ORDERED)),
		);
	}, 120_000);
});

/** The newest whole-record TM row (the delete's snapshot) — the undelete's handle. */
async function wholeRecordRowId(sectionTipo: string, sectionId: number): Promise<number> {
	const rows = (await sql.unsafe(
		`SELECT id FROM matrix_time_machine WHERE section_tipo = $1 AND section_id = $2 AND tipo = $1
		 ORDER BY id DESC LIMIT 1`,
		[sectionTipo, sectionId],
	)) as { id: number }[];
	const row = rows[0];
	if (row === undefined) throw new Error(`no whole-record TM row for ${sectionTipo}/${sectionId}`);
	return Number(row.id);
}

/** THE undelete door (tool_time_machine apply_value of the delete's snapshot). */
async function undelete(sectionTipo: string, sectionId: number): Promise<void> {
	const response = await toolTimeMachineApplyValue({
		principal: await resolvePrincipal(USER_ID),
		userId: USER_ID,
		options: {
			section_tipo: sectionTipo,
			section_id: sectionId,
			tipo: sectionTipo,
			lang: 'lg-nolan',
			matrix_id: await wholeRecordRowId(sectionTipo, sectionId),
		},
		background: false,
	} as never);
	expect(response.ok, 'the undelete door refused').toBe(true);
}

async function recordExists(sectionTipo: string, sectionId: number): Promise<boolean> {
	const rows = (await sql.unsafe(
		`SELECT count(*)::int AS n FROM "${await tableOf(sectionTipo)}" WHERE section_tipo = $1 AND section_id = $2`,
		[sectionTipo, sectionId],
	)) as { n: number }[];
	return (rows[0]?.n ?? 0) === 1;
}

describe('12. the DELETE and UNDELETE doors converge the copies (no explicit refresh)', () => {
	test('deleting the pointed TYPE empties the term’s 1013/1019; undeleting it leaves the term converged', async () => {
		const doomed = await born(TYPE_SECTION);
		const coin = await born(COIN_SECTION);
		await saveRelation(COIN_TYPE_LINK, COIN_SECTION, coin, [
			locator(COIN_TYPE_LINK, TYPE_SECTION, doomed),
		]);
		await saveRelation(TYPE_ORDERED, TYPE_SECTION, doomed, [
			locator(TYPE_ORDERED, ORDERED_SECTION, ordered1),
		]);
		const term = await born(VIRTUAL_TERM_SECTION);
		await saveRelation(POINTER, VIRTUAL_TERM_SECTION, term, [
			locator(POINTER, TYPE_SECTION, doomed),
		]);
		expect(addresses(await relationKey(VIRTUAL_TERM_SECTION, term, COINS_COPY)), 'FLOOR').toEqual([
			addr(COIN_SECTION, coin),
		]);
		expect(addresses(await relationKey(VIRTUAL_TERM_SECTION, term, ORDERED_COPY)), 'FLOOR').toEqual(
			[addr(ORDERED_SECTION, ordered1)],
		);

		// THE DOOR, outside any transaction: COMMIT + the ledger drain happen
		// before it returns. No refreshExternalMirror follows.
		await deleteSectionRecord(TYPE_SECTION, doomed, USER_ID);
		expect(await recordExists(TYPE_SECTION, doomed), 'FLOOR: the type is gone').toBe(false);
		expect(
			await relationKey(VIRTUAL_TERM_SECTION, term, POINTER),
			'FLOOR: the delete stripped the term’s pointer (inverse references)',
		).toEqual([]);
		expect(
			await relationKey(VIRTUAL_TERM_SECTION, term, COINS_COPY),
			'a stale copy of a DELETED type’s coins survived the delete door',
		).toEqual([]);
		expect(
			await relationKey(VIRTUAL_TERM_SECTION, term, ORDERED_COPY),
			'a stale copy of a DELETED type’s ordered coins survived the delete door',
		).toEqual([]);

		await undelete(TYPE_SECTION, doomed);
		expect(await recordExists(TYPE_SECTION, doomed), 'FLOOR: the type is back').toBe(true);
		expect(
			addresses(await relationKey(TYPE_SECTION, doomed, TYPE_ORDERED)),
			'FLOOR: the type’s own bag came back',
		).toEqual([addr(ORDERED_SECTION, ordered1)]);
		// Converged: the term's stored copies are exactly the law's answer — a
		// refresh finds nothing to write, for both slots.
		for (const key of [COINS_COPY, ORDERED_COPY]) {
			const before = await tmRows(VIRTUAL_TERM_SECTION, term, key);
			const outcome = await refreshExternalMirror(
				key,
				VIRTUAL_TERM_SECTION,
				term,
				USER_ID,
				new Date(),
			);
			expect(outcome.changed, `${key}: the undelete left the term drifted`).toBe(false);
			expect(await tmRows(VIRTUAL_TERM_SECTION, term, key)).toBe(before);
		}
		// The type's undelete must not grow a copy slot on the TYPE (host precondition).
		expect(await hasRelationKey(TYPE_SECTION, doomed, COINS_COPY)).toBe(false);
		expect(await hasRelationKey(TYPE_SECTION, doomed, ORDERED_COPY)).toBe(false);
	}, 180_000);

	test('undeleting a TERM whose source changed while it was deleted recomputes its copies — never the snapshot’s', async () => {
		const type = await born(TYPE_SECTION);
		await saveRelation(TYPE_ORDERED, TYPE_SECTION, type, [
			locator(TYPE_ORDERED, ORDERED_SECTION, ordered1),
		]);
		const term = await born(TERM_SECTION);
		await saveRelation(POINTER, TERM_SECTION, term, [locator(POINTER, TYPE_SECTION, type)]);
		expect(addresses(await relationKey(TERM_SECTION, term, ORDERED_COPY)), 'FLOOR').toEqual([
			addr(ORDERED_SECTION, ordered1),
		]);
		await deleteSectionRecord(TERM_SECTION, term, USER_ID);
		expect(await recordExists(TERM_SECTION, term), 'FLOOR: the term is gone').toBe(false);
		// The source moves on while the term is deleted (the snapshot holds [ordered1]).
		await saveRelation(TYPE_ORDERED, TYPE_SECTION, type, [
			locator(TYPE_ORDERED, ORDERED_SECTION, ordered2),
			locator(TYPE_ORDERED, ORDERED_SECTION, ordered1),
		]);
		await undelete(TERM_SECTION, term);
		expect(
			addresses(await relationKey(TERM_SECTION, term, POINTER)),
			'FLOOR: pointer back',
		).toEqual([addr(TYPE_SECTION, type)]);
		expect(
			addresses(await relationKey(TERM_SECTION, term, ORDERED_COPY)),
			'the undeleted term’s copy is the snapshot’s, not the law’s recompute',
		).toEqual([addr(ORDERED_SECTION, ordered2), addr(ORDERED_SECTION, ordered1)]);
		const outcome = await refreshExternalMirror(
			ORDERED_COPY,
			TERM_SECTION,
			term,
			USER_ID,
			new Date(),
		);
		expect(outcome.changed, 'the undelete left the copy drifted').toBe(false);
	}, 180_000);
});
