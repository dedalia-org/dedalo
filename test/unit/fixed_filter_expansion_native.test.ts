/**
 * `expandFixedFilter` + `resolveComponentDataRecursively` — the request_config
 * `fixed_filter` expansion (src/core/relations/request_config/filters.ts,
 * PHP component_relation_common::get_fixed_filter :2948 /
 * resolve_component_data_recursively :3171).
 *
 * WHY THIS GATE. `fixed_filter` clauses are pre-applied to EVERY search a
 * relation config executes — they are the mechanism that keeps an autocomplete
 * or a portal bounded to its intended subset. Losing a clause silently widens
 * a search to the whole section (the never-silently-unbounded law); emitting a
 * wrong one silently hides records. The whole expansion was at 0% coverage.
 *
 * FIXTURE. The test3 playground, scratch ids 928000-928999 ONLY (this file's
 * reserved namespace — the suite database is shared with concurrent writers,
 * so nothing here asserts a table-global count and every assertion is scoped
 * to these ids). Seeded by direct upsert; `afterAll` deletes the matrix rows
 * AND their matrix_time_machine tail and fails loud if the sweep is not zero.
 *
 * Ontology facts this file binds to (probed, not assumed):
 *   test3  section → matrix_test, section_id component `test102`
 *   test80 component_portal · test91 component_select · test52 input_text
 *   test201 relation_children ↔ test71 relation_parent (dd47 / dd48)
 *   section_map test3 thesaurus.order = test22 (children unordered here, so
 *   getChildren falls back to stable section_id order)
 *
 * NO PRODUCTION EDITS. `resolveComponentDataRecursively` is private and is
 * reached exclusively through the `component_data` source, which is how the
 * engine reaches it too.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { sql } from '../../src/core/db/postgres.ts';
import { expandFixedFilter } from '../../src/core/relations/request_config/filters.ts';
import { refusalOf } from '../helpers/refusal.ts';
import { cleanScratchRecord, createScratchRecord } from '../helpers/test_data.ts';

const SECTION = 'test3';
const TABLE = 'matrix_test';

/** This file's reserved scratch id range. Nothing outside it is touched. */
const ID_MIN = 928000;
const ID_MAX = 928999;

// --- component_data fixture -------------------------------------------------
const OWNER = 928010; // test80 → TARGET_A, TARGET_B
const OWNER_EMPTY = 928011; // exists, holds no test80
const OWNER_MALFORMED = 928012; // test80 → TARGET_A + a locator with no section_tipo + one with no section_id
const TARGET_A = 928020; // test91 → dd64/1
const TARGET_B = 928021; // test91 → dd64/2
const ABSENT = 928999; // deliberately never created

// --- 3-level ddo_map chain fixture ------------------------------------------
// self → test80 (portal) → test37 (portal) → test91 (select, leaf).
// Two owners: one whose intermediate holds ONLY the next portal (the pure
// chain), one whose intermediate ALSO holds the leaf component directly (which
// is what makes the TRANSITIVE descendant fan-out observable).
const DEEP_OWNER = 928030; // test80 → DEEP_MID
const DEEP_MID = 928031; // test37 → TARGET_A            (no own test91)
const DEEP_OWNER_FLAT = 928032; // test80 → DEEP_MID_LEAFY
const DEEP_MID_LEAFY = 928033; // test37 → TARGET_A  AND  own test91 → dd64/3

// --- hierarchy_terms fixture ------------------------------------------------
const H_ROOT = 928000;
const H_CHILD_1 = 928001;
const H_CHILD_2 = 928002;
const H_GRANDCHILD = 928003; // child of H_CHILD_2

const SEEDED_IDS = [
	OWNER,
	OWNER_EMPTY,
	OWNER_MALFORMED,
	TARGET_A,
	TARGET_B,
	H_ROOT,
	H_CHILD_1,
	H_CHILD_2,
	H_GRANDCHILD,
	DEEP_OWNER,
	DEEP_MID,
	DEEP_OWNER_FLAT,
	DEEP_MID_LEAFY,
];

/** A portal locator as the engine stores it (section_id is a STRING on the wire). */
function portalLocator(id: number, idKey: number): Record<string, unknown> {
	return {
		id: idKey,
		type: 'dd151',
		section_id: String(id),
		section_tipo: SECTION,
		from_component_tipo: 'test80',
	};
}

/**
 * A SECOND portal locator, from a different component tipo (`test37` is a real
 * `component_portal` node), so a ddo chain can have three DISTINCT levels.
 * `resolveComponentDataRecursively` keys purely on the ddo tipo + the record's
 * stored component key, exactly as it does for `test80`.
 */
function portal37Locator(id: number, idKey: number): Record<string, unknown> {
	return {
		id: idKey,
		type: 'dd151',
		section_id: String(id),
		section_tipo: SECTION,
		from_component_tipo: 'test37',
	};
}

/** A component_select locator pointing at a dd64 term. */
function selectLocator(ddSectionId: number): Record<string, unknown> {
	return {
		id: 1,
		type: 'dd151',
		section_id: String(ddSectionId),
		section_tipo: 'dd64',
		from_component_tipo: 'test91',
	};
}

/** A component_relation_parent locator — the shape getChildren's inverse probe matches. */
function parentLocator(parentId: number): Record<string, unknown> {
	return {
		id: 1,
		type: 'dd47',
		section_id: String(parentId),
		section_tipo: SECTION,
		from_component_tipo: 'test71',
	};
}

/** The path an emitted filter item carries through untouched. */
const PATH = [{ section_tipo: SECTION, component_tipo: 'test52' }];

async function idsInRange(): Promise<number[]> {
	const rows = (await sql.unsafe(
		`SELECT section_id FROM ${TABLE}
		  WHERE section_tipo = $1 AND section_id BETWEEN $2 AND $3
		  ORDER BY section_id`,
		[SECTION, ID_MIN, ID_MAX],
	)) as { section_id: number }[];
	return rows.map((row) => row.section_id);
}

beforeAll(async () => {
	// Hygiene: the range must be empty before we write. A leftover row from a
	// crashed run would silently change every ordering assertion below.
	expect(await idsInRange()).toEqual([]);

	await createScratchRecord(SECTION, OWNER, {
		relation: { test80: [portalLocator(TARGET_A, 1), portalLocator(TARGET_B, 2)] },
	});
	await createScratchRecord(SECTION, OWNER_EMPTY, { relation: {} });
	await createScratchRecord(SECTION, OWNER_MALFORMED, {
		relation: {
			test80: [
				portalLocator(TARGET_A, 1),
				// No section_tipo → the recursive fan-out must skip it.
				{ id: 2, type: 'dd151', section_id: String(TARGET_B), from_component_tipo: 'test80' },
				// No section_id → must contribute NOTHING to a search_section_id join
				// (an 'undefined' or empty slot in the comma list is a corrupt filter).
				{ id: 3, type: 'dd151', section_tipo: SECTION, from_component_tipo: 'test80' },
			],
		},
	});
	await createScratchRecord(SECTION, TARGET_A, { relation: { test91: [selectLocator(1)] } });
	await createScratchRecord(SECTION, TARGET_B, { relation: { test91: [selectLocator(2)] } });

	await createScratchRecord(SECTION, DEEP_OWNER, {
		relation: { test80: [portalLocator(DEEP_MID, 1)] },
	});
	await createScratchRecord(SECTION, DEEP_MID, {
		relation: { test37: [portal37Locator(TARGET_A, 1)] },
	});
	await createScratchRecord(SECTION, DEEP_OWNER_FLAT, {
		relation: { test80: [portalLocator(DEEP_MID_LEAFY, 1)] },
	});
	await createScratchRecord(SECTION, DEEP_MID_LEAFY, {
		relation: { test37: [portal37Locator(TARGET_A, 1)], test91: [selectLocator(3)] },
	});

	await createScratchRecord(SECTION, H_ROOT, { relation: {} });
	await createScratchRecord(SECTION, H_CHILD_1, { relation: { test71: [parentLocator(H_ROOT)] } });
	await createScratchRecord(SECTION, H_CHILD_2, { relation: { test71: [parentLocator(H_ROOT)] } });
	await createScratchRecord(SECTION, H_GRANDCHILD, {
		relation: { test71: [parentLocator(H_CHILD_2)] },
	});

	expect(await idsInRange()).toEqual([...SEEDED_IDS].sort((a, b) => a - b));
}, 60000);

afterAll(async () => {
	for (const id of SEEDED_IDS) {
		await cleanScratchRecord(SECTION, id, TABLE);
	}
	// Fail loud if the sweep did not reach zero — both ends.
	expect(await idsInRange()).toEqual([]);
	const tm = (await sql.unsafe(
		`SELECT count(*)::int AS n FROM matrix_time_machine
		  WHERE section_tipo = $1 AND section_id BETWEEN $2 AND $3`,
		[SECTION, ID_MIN, ID_MAX],
	)) as { n: number }[];
	expect(tm[0]?.n).toBe(0);
}, 60000);

// ---------------------------------------------------------------------------
// descriptor-list shell
// ---------------------------------------------------------------------------

describe('expandFixedFilter — descriptor list shell', () => {
	test('a non-array descriptor set expands to nothing', async () => {
		expect(await expandFixedFilter(null, SECTION, OWNER)).toEqual([]);
		expect(await expandFixedFilter(undefined, SECTION, OWNER)).toEqual([]);
		expect(await expandFixedFilter({ source: 'fixed_dato' }, SECTION, OWNER)).toEqual([]);
		expect(await expandFixedFilter([], SECTION, OWNER)).toEqual([]);
	});

	test('an unknown / missing source is a LOUD failure, never a dropped clause', async () => {
		await expect(
			expandFixedFilter([{ source: 'not_a_source', value: [] }], SECTION, OWNER),
		).rejects.toThrow(/unknown fixed_filter source 'not_a_source'/);
		await expect(expandFixedFilter([{ value: [] }], SECTION, OWNER)).rejects.toThrow(
			/unknown fixed_filter source/,
		);
		// The refusal is TYPED: a misconfigured node, not an unexpected error.
		expect((await refusalOf(expandFixedFilter([{ value: [] }], SECTION, OWNER))).code).toBe(
			'ontology.invalid_node',
		);
	});

	test('each descriptor becomes ONE group keyed by its operator ($or default)', async () => {
		const groups = await expandFixedFilter(
			[
				{ source: 'fixed_dato', value: [{ q: 'a' }] },
				{ source: 'fixed_dato', operator: '$and', value: [{ q: 'b' }] },
			],
			SECTION,
			OWNER,
		);
		expect(groups).toEqual([{ $or: [{ q: 'a' }] }, { $and: [{ q: 'b' }] }]);
	});
});

// ---------------------------------------------------------------------------
// source: fixed_dato
// ---------------------------------------------------------------------------

describe('fixed_dato source', () => {
	test('objects pass through verbatim; an uninstalled last-path tipo is skipped', async () => {
		const installed = { q: 'keep', path: [{ component_tipo: 'test52' }] };
		const uninstalled = { q: 'drop', path: [{ component_tipo: 'zzt999notatipo' }] };
		const groups = await expandFixedFilter(
			[{ source: 'fixed_dato', value: [installed, uninstalled] }],
			SECTION,
			OWNER,
		);
		expect(groups).toEqual([{ $or: [installed] }]);
	});

	test("the pseudo tipo 'section_id' is allowlisted (it has no ontology node)", async () => {
		const object = { q: '1', path: [{ component_tipo: 'section_id' }] };
		expect(
			await expandFixedFilter([{ source: 'fixed_dato', value: [object] }], SECTION, OWNER),
		).toEqual([{ $or: [object] }]);
	});

	test('only the LAST path step is gated; earlier steps are not checked', async () => {
		const object = {
			q: 'x',
			path: [{ component_tipo: 'zzt999notatipo' }, { component_tipo: 'test52' }],
		};
		expect(
			await expandFixedFilter([{ source: 'fixed_dato', value: [object] }], SECTION, OWNER),
		).toEqual([{ $or: [object] }]);
	});

	test('a missing / empty / non-array path is not gated at all', async () => {
		const noPath = { q: 'a' };
		const emptyPath = { q: 'b', path: [] };
		const stringPath = { q: 'c', path: 'nonsense' };
		expect(
			await expandFixedFilter(
				[{ source: 'fixed_dato', value: [noPath, emptyPath, stringPath] }],
				SECTION,
				OWNER,
			),
		).toEqual([{ $or: [noPath, emptyPath, stringPath] }]);
	});

	test('an all-skipped descriptor emits no group; a missing value list is empty', async () => {
		expect(
			await expandFixedFilter(
				[{ source: 'fixed_dato', value: [{ q: 'x', path: [{ component_tipo: 'zzt999x1' }] }] }],
				SECTION,
				OWNER,
			),
		).toEqual([]);
		expect(await expandFixedFilter([{ source: 'fixed_dato' }], SECTION, OWNER)).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// source: component_data  →  resolveComponentDataRecursively
// ---------------------------------------------------------------------------

describe('component_data source — single hop (no ddo_map)', () => {
	test('the component lives in the CALLING section; each locator becomes one item', async () => {
		const groups = await expandFixedFilter(
			[{ source: 'component_data', value: [{ q: 'test80', path: PATH }] }],
			SECTION,
			OWNER,
		);
		expect(groups.length).toBe(1);
		const items = groups[0]?.$or as { q: Record<string, unknown>; path: unknown }[];
		expect(items.length).toBe(2);
		expect(items[0]).toEqual({ q: portalLocator(TARGET_A, 1), path: PATH });
		expect(items[1]).toEqual({ q: portalLocator(TARGET_B, 2), path: PATH });
	});

	test('malformed value entries are skipped (null, non-string q)', async () => {
		expect(
			await expandFixedFilter(
				[
					{
						source: 'component_data',
						value: [null, { path: PATH }, { q: 42, path: PATH }],
					},
				],
				SECTION,
				OWNER,
			),
		).toEqual([]);
	});

	test('use_from_component_tipo:false strips the key — CONTROL first, then the variant', async () => {
		const descriptor = (flag?: boolean) => [
			{
				source: 'component_data',
				value: [
					flag === undefined
						? { q: 'test80', path: PATH }
						: { q: 'test80', path: PATH, use_from_component_tipo: flag },
				],
			},
		];

		// CONTROL: with the flag omitted the key IS present.
		const control = await expandFixedFilter(descriptor(), SECTION, OWNER);
		const controlItems = control[0]?.$or as { q: Record<string, unknown> }[];
		expect(Object.hasOwn(controlItems[0]?.q ?? {}, 'from_component_tipo')).toBe(true);

		// `true` is NOT the strip trigger — only the literal `false` is.
		const explicitTrue = await expandFixedFilter(descriptor(true), SECTION, OWNER);
		const trueItems = explicitTrue[0]?.$or as { q: Record<string, unknown> }[];
		expect(Object.hasOwn(trueItems[0]?.q ?? {}, 'from_component_tipo')).toBe(true);

		// VARIANT: the key must be ABSENT (PHP unset), not merely undefined.
		const stripped = await expandFixedFilter(descriptor(false), SECTION, OWNER);
		const items = stripped[0]?.$or as { q: Record<string, unknown> }[];
		expect(items.length).toBe(2);
		expect(Object.hasOwn(items[0]?.q ?? {}, 'from_component_tipo')).toBe(false);
		expect(Object.hasOwn(items[1]?.q ?? {}, 'from_component_tipo')).toBe(false);
		expect(items[0]?.q).toEqual({
			id: 1,
			type: 'dd151',
			section_id: String(TARGET_A),
			section_tipo: SECTION,
		});
		// The stored record is NOT mutated by the strip (the copy is a clone).
		const reread = await expandFixedFilter(descriptor(), SECTION, OWNER);
		const rereadItems = reread[0]?.$or as { q: Record<string, unknown> }[];
		expect(rereadItems[0]?.q).toEqual(portalLocator(TARGET_A, 1));
	});
});

describe('component_data source — search_section_id', () => {
	test('the resolved section_ids collapse into ONE comma-joined item', async () => {
		const groups = await expandFixedFilter(
			[{ source: 'component_data', value: [{ q: 'test80', path: PATH, search_section_id: true }] }],
			SECTION,
			OWNER,
		);
		expect(groups).toEqual([{ $or: [{ q: `${TARGET_A},${TARGET_B}`, path: PATH }] }]);
	});

	test("an EMPTY resolution still emits q '' and the group SURVIVES", async () => {
		// The never-silently-unbounded contract: an owner with nothing to
		// resolve must produce a filter that matches NOTHING, not a dropped
		// clause that would widen the search to the whole section.
		const descriptor = [
			{ source: 'component_data', value: [{ q: 'test80', path: PATH, search_section_id: true }] },
		];
		// Positive twin, same descriptor, in the same body — proves the empty
		// half is not vacuously empty for some unrelated reason.
		expect(await expandFixedFilter(descriptor, SECTION, OWNER)).toEqual([
			{ $or: [{ q: `${TARGET_A},${TARGET_B}`, path: PATH }] },
		]);
		expect(await expandFixedFilter(descriptor, SECTION, OWNER_EMPTY)).toEqual([
			{ $or: [{ q: '', path: PATH }] },
		]);
	});

	test('locators without a section_id are dropped from the join, not stringified', async () => {
		const groups = await expandFixedFilter(
			[{ source: 'component_data', value: [{ q: 'test80', path: PATH, search_section_id: true }] }],
			SECTION,
			OWNER_MALFORMED,
		);
		// OWNER_MALFORMED's third locator carries no section_id at all.
		expect(groups).toEqual([{ $or: [{ q: `${TARGET_A},${TARGET_B}`, path: PATH }] }]);
	});

	test('search_section_id is only triggered by the literal true', async () => {
		const groups = await expandFixedFilter(
			[
				{
					source: 'component_data',
					value: [{ q: 'test80', path: PATH, search_section_id: 'yes' }],
				},
			],
			SECTION,
			OWNER,
		);
		const items = groups[0]?.$or as { q: unknown }[];
		expect(items.length).toBe(2);
		expect(items[0]?.q).toEqual(portalLocator(TARGET_A, 1));
	});
});

describe('component_data source — multi-hop ddo_map', () => {
	test('the chain walks portal → select and returns the LEAF data in record order', async () => {
		const groups = await expandFixedFilter(
			[
				{
					source: 'component_data',
					value: [
						{
							q: 'test91',
							path: PATH,
							ddo_map: [
								{ tipo: 'test80', parent: 'self', section_tipo: SECTION },
								{ tipo: 'test91', parent: 'test80', section_tipo: SECTION },
							],
						},
					],
				},
			],
			SECTION,
			OWNER,
		);
		expect(groups).toEqual([
			{
				$or: [
					{ q: selectLocator(1), path: PATH },
					{ q: selectLocator(2), path: PATH },
				],
			},
		]);
	});

	test('an intermediate element with no section_tipo is skipped, not resolved blindly', async () => {
		const groups = await expandFixedFilter(
			[
				{
					source: 'component_data',
					value: [
						{
							q: 'test91',
							path: PATH,
							ddo_map: [
								{ tipo: 'test80', parent: 'self', section_tipo: SECTION },
								{ tipo: 'test91', parent: 'test80', section_tipo: SECTION },
							],
						},
					],
				},
			],
			SECTION,
			OWNER_MALFORMED,
		);
		// Only TARGET_A's select survives; the section_tipo-less locator (which
		// points at TARGET_B) contributes nothing.
		expect(groups).toEqual([{ $or: [{ q: selectLocator(1), path: PATH }] }]);
	});

	test("no ddo entry anchored to the caller ('self' / caller tipo) → no resolution", async () => {
		expect(
			await expandFixedFilter(
				[
					{
						source: 'component_data',
						value: [
							{
								q: 'test91',
								path: PATH,
								ddo_map: [{ tipo: 'test91', parent: 'test80', section_tipo: SECTION }],
							},
						],
					},
				],
				SECTION,
				OWNER,
			),
		).toEqual([]);
	});

	test("the caller tipo anchors the chain exactly like 'self'", async () => {
		const groups = await expandFixedFilter(
			[
				{
					source: 'component_data',
					value: [
						{
							q: 'test80',
							path: PATH,
							ddo_map: [{ tipo: 'test80', parent: SECTION, section_tipo: SECTION }],
						},
					],
				},
			],
			SECTION,
			OWNER,
		);
		expect((groups[0]?.$or as unknown[]).length).toBe(2);
	});
});

describe('component_data source — deep (3-level) ddo_map chains', () => {
	/** self → test80 → test37 → test91(leaf). */
	const deepDescriptor = () => [
		{
			source: 'component_data',
			value: [
				{
					q: 'test91',
					path: PATH,
					ddo_map: [
						{ tipo: 'test80', parent: 'self', section_tipo: SECTION },
						{ tipo: 'test37', parent: 'test80', section_tipo: SECTION },
						{ tipo: 'test91', parent: 'test37', section_tipo: SECTION },
					],
				},
			],
		},
	];

	test('the leaf data arrives across TWO intermediate hops, not just one', async () => {
		// DEEP_OWNER --test80--> DEEP_MID --test37--> TARGET_A --test91--> dd64/1.
		// The leaf is a GRANDCHILD of the init ddo: nothing here is reachable
		// from a single direct-children hop off `self`.
		const groups = await expandFixedFilter(deepDescriptor(), SECTION, DEEP_OWNER);
		expect(groups).toEqual([{ $or: [{ q: selectLocator(1), path: PATH }] }]);
	});

	test('a deeper ddo is ALSO probed directly on each intermediate record (transitive fan-out)', async () => {
		// collectDdoDescendants is TRANSITIVE (PHP get_ddo_children_recursive):
		// resolving test80 fans out into [test37, test91] — so DEEP_MID_LEAFY's
		// OWN test91 (dd64/3) is picked up at the intermediate level, in
		// addition to the one reached through test37 → TARGET_A (dd64/1).
		// Pre-order: the test37 branch is emitted before the test91 sibling.
		const groups = await expandFixedFilter(deepDescriptor(), SECTION, DEEP_OWNER_FLAT);
		expect(groups).toEqual([
			{
				$or: [
					{ q: selectLocator(1), path: PATH },
					{ q: selectLocator(3), path: PATH },
				],
			},
		]);
	});

	test('search_section_id over a 3-level chain joins the LEAF ids only', async () => {
		const descriptor = deepDescriptor();
		(descriptor[0] as { value: Record<string, unknown>[] }).value[0]!.search_section_id = true;
		const groups = await expandFixedFilter(descriptor, SECTION, DEEP_OWNER_FLAT);
		// dd64 term ids of the two resolved selects — NOT the test3 hop ids.
		expect(groups).toEqual([{ $or: [{ q: '1,3', path: PATH }] }]);
	});

	test('a broken middle link truncates the chain to nothing — PAIRED with its twin', async () => {
		// Positive twin first (same descriptor shape, real chain).
		expect(await expandFixedFilter(deepDescriptor(), SECTION, DEEP_OWNER)).toEqual([
			{ $or: [{ q: selectLocator(1), path: PATH }] },
		]);
		// Now re-parent the middle ddo onto a tipo that is nowhere in the chain:
		// test37 is no longer a descendant of test80, so the walk dies at level 1.
		const broken = [
			{
				source: 'component_data',
				value: [
					{
						q: 'test91',
						path: PATH,
						ddo_map: [
							{ tipo: 'test80', parent: 'self', section_tipo: SECTION },
							{ tipo: 'test37', parent: 'zzt999notatipo', section_tipo: SECTION },
							{ tipo: 'test91', parent: 'test37', section_tipo: SECTION },
						],
					},
				],
			},
		];
		expect(await expandFixedFilter(broken, SECTION, DEEP_OWNER)).toEqual([]);
	});
});

describe('component_data source — the walk never writes the ddo_map (C8, T1-1)', () => {
	test('the leaf is a walker PARAMETER: no `last` key lands on the (cached) ddos', async () => {
		// PHP marked the leaf with `$resolve_ddo->last = true` on the ontology's
		// own ddo_map object; a node's properties are CACHED, so the mark leaked
		// into every later request (relations/component_data_walk.ts header).
		const ddoMap = [
			{ tipo: 'test80', parent: 'self', section_tipo: SECTION },
			{ tipo: 'test91', parent: 'test80', section_tipo: SECTION },
		];
		const descriptor = [
			{ source: 'component_data', value: [{ q: 'test91', path: PATH, ddo_map: ddoMap }] },
		];
		const before = structuredClone(ddoMap);
		const first = await expandFixedFilter(descriptor, SECTION, OWNER);
		// Positive control: the walk really resolved the leaf.
		expect(first).toEqual([
			{
				$or: [
					{ q: selectLocator(1), path: PATH },
					{ q: selectLocator(2), path: PATH },
				],
			},
		]);
		expect(ddoMap).toEqual(before);
		expect(ddoMap.some((ddo) => 'last' in ddo)).toBe(false);
		// The same (unmutated) map walks again to the same answer.
		expect(await expandFixedFilter(descriptor, SECTION, OWNER)).toEqual(first);
	});
});

describe('component_data source — resolveComponentDataRecursively refusals', () => {
	test('an fn / data_fn ddo is UNCOVERED SCOPE and throws — never a silent empty filter', async () => {
		await expect(
			expandFixedFilter(
				[
					{
						source: 'component_data',
						value: [
							{
								q: 'test80',
								path: PATH,
								ddo_map: [{ tipo: 'test80', parent: 'self', fn: 'get_calculation_data' }],
							},
						],
					},
				],
				SECTION,
				OWNER,
			),
		).rejects.toThrow(/fn 'get_calculation_data' is not implemented \(uncovered scope\)/);

		await expect(
			expandFixedFilter(
				[
					{
						source: 'component_data',
						value: [
							{
								q: 'test80',
								path: PATH,
								ddo_map: [{ tipo: 'test80', parent: 'self', data_fn: 'get_calculation_data' }],
							},
						],
					},
				],
				SECTION,
				OWNER,
			),
		).rejects.toThrow(/not implemented \(uncovered scope\)/);
	});

	test('a null caller section_id resolves nothing — PAIRED with its positive twin', async () => {
		const descriptor = [{ source: 'component_data', value: [{ q: 'test80', path: PATH }] }];
		// Positive twin FIRST: the very same descriptor against a real id.
		const positive = await expandFixedFilter(descriptor, SECTION, OWNER);
		expect((positive[0]?.$or as unknown[]).length).toBe(2);
		// Then the refusal.
		expect(await expandFixedFilter(descriptor, SECTION, null)).toEqual([]);
	});

	test('an unresolvable component tipo, section tipo or record resolves nothing', async () => {
		const value = (q: string) => [{ source: 'component_data', value: [{ q, path: PATH }] }];
		// model === null (no ontology node for the component tipo)
		expect(await expandFixedFilter(value('zzt999notatipo'), SECTION, OWNER)).toEqual([]);
		// table === null (the caller section tipo is not an installed section)
		expect(await expandFixedFilter(value('test80'), 'zzt999nosection1', OWNER)).toEqual([]);
		// record === null (the id is inside our range but was never created)
		expect(await expandFixedFilter(value('test80'), SECTION, ABSENT)).toEqual([]);
		// the component holds no data on this record
		expect(await expandFixedFilter(value('test80'), SECTION, OWNER_EMPTY)).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// source: hierarchy_terms
// ---------------------------------------------------------------------------

describe('hierarchy_terms source', () => {
	const terms = (recursive: boolean) => [
		{
			source: 'hierarchy_terms',
			value: [{ section_id: H_ROOT, section_tipo: SECTION, recursive }],
		},
	];

	test('flat: only the DIRECT children, joined into one section_id filter', async () => {
		const groups = await expandFixedFilter(terms(false), SECTION, OWNER);
		expect(groups).toEqual([
			{
				$or: [
					{
						q: `${H_CHILD_1},${H_CHILD_2}`,
						path: [
							{
								section_tipo: SECTION,
								component_tipo: 'test102',
								model: 'component_section_id',
								name: 'Id',
							},
						],
					},
				],
			},
		]);
	});

	test('recursive:true adds the whole subtree', async () => {
		const groups = await expandFixedFilter(terms(true), SECTION, OWNER);
		const items = groups[0]?.$or as { q: string }[];
		expect(items[0]?.q).toBe(`${H_CHILD_1},${H_CHILD_2},${H_GRANDCHILD}`);
	});

	test('recursive is only triggered by the literal true', async () => {
		const groups = await expandFixedFilter(
			[
				{
					source: 'hierarchy_terms',
					value: [{ section_id: H_ROOT, section_tipo: SECTION, recursive: 'true' }],
				},
			],
			SECTION,
			OWNER,
		);
		expect((groups[0]?.$or as { q: string }[])[0]?.q).toBe(`${H_CHILD_1},${H_CHILD_2}`);
	});

	test("a childless term still emits an item with q '' — the group SURVIVES", async () => {
		// Same never-silently-unbounded contract as search_section_id: a leaf
		// term must filter to nothing, not disappear from the clause.
		const groups = await expandFixedFilter(
			[
				{
					source: 'hierarchy_terms',
					value: [{ section_id: H_GRANDCHILD, section_tipo: SECTION }],
				},
			],
			SECTION,
			OWNER,
		);
		const items = groups[0]?.$or as { q: string }[];
		expect(items.length).toBe(1);
		expect(items[0]?.q).toBe('');
	});

	test('each term becomes its OWN item inside the one group', async () => {
		const groups = await expandFixedFilter(
			[
				{
					source: 'hierarchy_terms',
					value: [
						{ section_id: H_ROOT, section_tipo: SECTION },
						{ section_id: H_CHILD_2, section_tipo: SECTION },
					],
				},
			],
			SECTION,
			OWNER,
		);
		const items = groups[0]?.$or as { q: string }[];
		expect(items.map((item) => item.q)).toEqual([
			`${H_CHILD_1},${H_CHILD_2}`,
			String(H_GRANDCHILD),
		]);
	});

	test('malformed terms are skipped; an all-skipped descriptor emits no group', async () => {
		expect(
			await expandFixedFilter(
				[
					{
						source: 'hierarchy_terms',
						value: [null, { section_id: H_ROOT }, 'nonsense'],
					},
				],
				SECTION,
				OWNER,
			),
		).toEqual([]);
	});
});
