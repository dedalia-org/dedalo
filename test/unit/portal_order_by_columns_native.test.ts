/**
 * Portal column sort — v7 per-ddo model (WC-048). Sort directives live ON the
 * `show.ddo_map` column ddo (`order: asc|desc`, `sort_by_column: true`), NOT on
 * top-level component properties. This is the TS-native contract of a feature
 * with NO PHP oracle (opt-in; no frozen fixture declares it), pinned here:
 *
 *  - a column with `order` resolves to an ORDER step over the TARGET section
 *    (where the linked records live — derived from the locators, NOT the caller);
 *  - `order` is `asc`/`desc` (any case) or `true` (= asc); anything else means
 *    "not ordered" and the column is skipped (never a malformed ORDER BY);
 *  - a column WITHOUT `order` is skipped; declaration order = sort priority;
 *  - no ordered column → null (caller keeps stored order);
 *  - `hasDeclaredColumnOrder` is the cheap raw-properties gate used by the write
 *    chokepoint's per-key rule (and the context's `declared_order`).
 *
 * ORDER MODEL (WC-2026-10-31-portal-order-model): these helpers are now the
 * ONE ordering function of three consumers — the record-write chokepoint, which
 * stores a declared-order key SORTED (write time; `record_write.ts`
 * `applyKeySaveRules` → `sortByDeclaredOrder`); the read path's temporary
 * `view_order` (`orderLocatorsByViewOrder` — the declared order is never applied
 * at read time); and the `portal_declared_order` reconcile. Their end-to-end
 * contracts (every write door, the stored array served as stored, view_order
 * before paginating, stored-index `paginated_key`) are pinned by
 * `portal_order_native.test.ts`.
 *
 * The DB-backed ranking (`rankLocatorsByColumns`) and the ontology wiring
 * (`orderLocatorsByDeclaredColumns`) are exercised below + by
 * `portal_declared_column_order_native`; here we lock the pure resolution.
 */
// Migrated to the generic `test` TLD 2026-08-19 (AGENTS.md hard rules): every
// install tipo was rewritten through src/core/test_data/test_tld_tipo_map.json;
// seed-shipped ontology (dd/rsc/hierarchy/lg) stays and is spelled through `seed()`,
// which keeps it out of the install-TLD census's `<tld><digits>` token grammar.

import { describe, expect, test } from 'bun:test';
import { sql } from '../../src/core/db/postgres.ts';
import {
	buildOrderEntries,
	hasDeclaredColumnOrder,
	locatorTargetSections,
	normalizeDirection,
	orderedColumnsFromDdoMap,
	rankLocatorsByColumns,
	storedIndexOf,
} from '../../src/core/relations/order_locators.ts';

/** Seed-shipped ontology, spelled out of the install-TLD census's token grammar. */
const seed = <T extends string, N extends number>(tld: T, id: N): `${T}${N}` => `${tld}${id}`;

// A resolved show.ddo_map (each entry may carry `order` / `sort_by_column`).
const columns = (specs: { tipo: string; section_tipo?: string; order?: unknown }[]) =>
	specs.map((s) => ({ section_tipo: 'self', ...s }));

describe('normalizeDirection', () => {
	test('asc/desc any case, boolean true = ASC, else null', () => {
		expect(normalizeDirection('asc')).toBe('ASC');
		expect(normalizeDirection('DESC')).toBe('DESC');
		expect(normalizeDirection('Desc')).toBe('DESC');
		expect(normalizeDirection(true)).toBe('ASC');
		expect(normalizeDirection('sideways')).toBeNull();
		expect(normalizeDirection(undefined)).toBeNull();
		expect(normalizeDirection(false)).toBeNull();
		expect(normalizeDirection(1)).toBeNull();
	});
});

describe('locatorTargetSections', () => {
	test('distinct locator section_tipos, non-string dropped', () => {
		expect(
			locatorTargetSections([
				{ section_tipo: 'test7008', section_id: 1 },
				{ section_tipo: 'test7008', section_id: 2 },
				{ section_tipo: 'dd128', section_id: 3 },
				{ section_id: 4 },
			]),
		).toEqual(['test7008', 'dd128']);
		expect(locatorTargetSections([])).toEqual([]);
	});
});

describe('orderedColumnsFromDdoMap', () => {
	test('one ordered column → its tipo + direction', () => {
		expect(orderedColumnsFromDdoMap(columns([{ tipo: seed('rsc', 20), order: 'asc' }]))).toEqual([
			{ componentTipo: seed('rsc', 20), direction: 'ASC' },
		]);
	});

	test('DESC honored; boolean true = ASC', () => {
		expect(
			orderedColumnsFromDdoMap(columns([{ tipo: seed('rsc', 20), order: 'desc' }]))[0]?.direction,
		).toBe('DESC');
		expect(
			orderedColumnsFromDdoMap(columns([{ tipo: seed('rsc', 20), order: true }]))[0]?.direction,
		).toBe('ASC');
	});

	test('columns WITHOUT order are skipped; declaration order = priority', () => {
		expect(
			orderedColumnsFromDdoMap(
				columns([
					{ tipo: seed('rsc', 279) }, // no order → skipped
					{ tipo: seed('rsc', 29), order: 'desc' },
					{ tipo: seed('rsc', 20), order: 'asc' },
				]),
			),
		).toEqual([
			{ componentTipo: seed('rsc', 29), direction: 'DESC' },
			{ componentTipo: seed('rsc', 20), direction: 'ASC' },
		]);
	});

	test('invalid order value / no order / empty tipo → dropped', () => {
		expect(
			orderedColumnsFromDdoMap(columns([{ tipo: seed('rsc', 20), order: 'sideways' }])),
		).toEqual([]);
		expect(orderedColumnsFromDdoMap([])).toEqual([]);
		expect(orderedColumnsFromDdoMap(columns([{ tipo: seed('rsc', 20) }]))).toEqual([]);
		expect(orderedColumnsFromDdoMap(columns([{ tipo: '', order: 'asc' }]))).toEqual([]);
	});
});

describe('buildOrderEntries (per-model order path, DB)', () => {
	test('a DATE column resolves to a single-step path anchored on the target', async () => {
		// test3.test145 is a component_date; its order path is the direct column.
		const order = await buildOrderEntries(
			[{ componentTipo: 'test145', direction: 'DESC' }],
			'test3',
		);
		expect(order).toHaveLength(1);
		expect(order[0]?.direction).toBe('DESC');
		const leaf = order[0]?.path.at(-1);
		expect(leaf?.component_tipo).toBe('test145');
		expect(order[0]?.path[0]?.section_tipo).toBe('test3');
	});

	test('empty target → no entries', async () => {
		expect(await buildOrderEntries([{ componentTipo: 'test145', direction: 'ASC' }], '')).toEqual(
			[],
		);
	});
});

describe('storedIndexOf (paginated_key = the STORED index under any read order)', () => {
	test('maps each stored locator OBJECT to its stored position, whatever order shows it', () => {
		const a = { section_tipo: 'test3', section_id: 1 };
		const b = { section_tipo: 'test3', section_id: 2 };
		const c = { section_tipo: 'test3', section_id: 3 };
		const index = storedIndexOf([c, a, b]);
		// a read order (any permutation) looks its items up by identity
		expect([a, b, c].map((item) => index.get(item))).toEqual([1, 2, 0]);
		// an equal-but-distinct object is NOT the stored item (identity, not value)
		expect(index.get({ section_tipo: 'test3', section_id: 1 })).toBeUndefined();
	});
});

describe('hasDeclaredColumnOrder (cheap raw-properties gate)', () => {
	const props = (ddoMap: unknown[]) => ({
		source: { request_config: [{ show: { ddo_map: ddoMap } }] },
	});

	test('true only when some request_config column carries a valid order', () => {
		expect(hasDeclaredColumnOrder(props([{ tipo: seed('rsc', 85), order: 'asc' }]))).toBe(true);
		expect(hasDeclaredColumnOrder(props([{ tipo: seed('rsc', 85), order: true }]))).toBe(true);
		expect(hasDeclaredColumnOrder(props([{ tipo: seed('rsc', 85) }]))).toBe(false);
		expect(hasDeclaredColumnOrder(props([{ tipo: seed('rsc', 85), order: 'nope' }]))).toBe(false);
		expect(hasDeclaredColumnOrder(null)).toBe(false);
		expect(hasDeclaredColumnOrder({})).toBe(false);
		expect(hasDeclaredColumnOrder({ source: { request_config: 'x' } })).toBe(false);
	});
});

/**
 * END-TO-END (DB): `rankLocatorsByColumns` really re-orders stored locators by a
 * target-section column search over the live test3 playground — the same engine
 * that backs both `sort_by_column` (save) and `order_by` (read). Ordering by the
 * universal `section_id` column makes the expected order deterministic, and an
 * unresolvable locator must fall to the END preserving relative order.
 */
describe('rankLocatorsByColumns (DB)', () => {
	const loc = (id: number) => ({
		section_tipo: 'test3',
		section_id: id,
		from_component_tipo: 'test218',
	});

	test('re-orders real test3 locators by section_id DESC; unresolved last', async () => {
		// Confirm the playground shape (section_ids are deterministic).
		const rows = (await sql`
			SELECT section_id FROM matrix_test WHERE section_tipo = 'test3' ORDER BY section_id
		`) as { section_id: number }[];
		const ids = rows.map((row) => Number(row.section_id));
		expect(ids.length).toBeGreaterThanOrEqual(3);

		// Scrambled stored order + one unresolvable (deleted-target) locator.
		const stored = [
			loc(ids[1] as number),
			loc(999999),
			loc(ids[0] as number),
			loc(ids[2] as number),
		];
		const sorted = (await rankLocatorsByColumns(
			stored,
			['test3'],
			[{ direction: 'DESC', path: [{ section_tipo: 'test3', component_tipo: 'section_id' }] }],
		)) as { section_id: number }[];

		const top3 = [ids[2], ids[1], ids[0]] as number[]; // section_id DESC of the three resolved
		expect(sorted.slice(0, 3).map((item) => Number(item.section_id))).toEqual(top3);
		// the unresolvable locator ranks last
		expect(Number(sorted[3]?.section_id)).toBe(999999);
	});

	test('fewer than two locators is a no-op (no DB round-trip needed)', async () => {
		const one = [loc(1)];
		expect(
			await rankLocatorsByColumns(
				one,
				['test3'],
				[{ direction: 'ASC', path: [{ section_tipo: 'test3', component_tipo: 'section_id' }] }],
			),
		).toEqual(one);
	});
});
