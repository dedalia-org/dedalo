/**
 * PORTAL DECLARED-COLUMN ORDER — the CONFIG-RESOLUTION WIRING (WC-048, 2026-10-31 addendum).
 *
 * `orderLocatorsByDeclaredColumns` is THE declared-order ranking of the per-ddo
 * `order` feature — since the portal order model (WC-2026-10-31-portal-order-model)
 * no longer a read-time display order but the ONE function shared by the WRITE
 * chokepoint (record_write.ts `applyKeySaveRules` → `sortByDeclaredOrder`: the
 * stored array is kept sorted) and the `portal_declared_order` reconcile; the
 * read serves the stored array as stored (pinned by `portal_order_native`).
 * The temporary header sort is a separate read path (`view_order`,
 * `orderLocatorsByViewOrder`, also pinned there). The pure helpers it composes (`normalizeDirection`,
 * `hasDeclaredColumnOrder`, `orderedColumnsFromDdoMap`, `locatorTargetSections`,
 * `buildOrderEntries`, `rankLocatorsByColumns`) are gated by
 * `portal_order_by_columns_native.test.ts` and are NOT re-tested here.
 *
 * What this file owns is the WIRING they hang from:
 *
 *  - the raw per-ddo `order` key SURVIVES the request_config build
 *    (`buildRequestConfigForElement` → explicit parse → `...rawDdo`
 *    passthrough) into `config[0].show.ddo_map`, where
 *    `orderedColumnsFromDdoMap` reads it — asserted through the effect
 *    (asc/desc actually re-order the stored locators);
 *  - the ORDER PATH is anchored on the LOCATORS' TARGET section, never on the
 *    caller `sectionTipo` (`buildOrderEntries(ordered, firstTarget)`);
 *  - every short-circuit returns null so the caller keeps the STORED order;
 *  - `paginated_key` never survives into the returned objects.
 *
 * ANCHORING (measured, and NOT what the plan assumed): for a plain literal
 * column the emitted path is single-step, and the assembler takes its table
 * alias from the sqo — so a caller-anchored build would produce an IDENTICAL
 * result and an asc/desc pair over `test52` cannot see the anchor. The one
 * observable anchor difference is `buildOrderPath`'s activity shortcut
 * (WC-044): `dd547` resolves to the `dd547` DATE column on any normal section
 * but collapses to the structural `section_id` column when the anchor IS the
 * activity section `dd542`. The scratch fixture makes those two orders exact
 * INVERSES of each other, so the asc/desc pair below flips iff the anchor is
 * wrong. That is the anchoring gate.
 *
 * Fixture: scratch test3 records 931001/931002 (namespace 931000-931999) with
 * `test52` values 'Alpha'/'Beta' and `dd547` times inverse to their section_id.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { config } from '../../src/config/config.ts';
import { sql } from '../../src/core/db/postgres.ts';
import { orderLocatorsByDeclaredColumns } from '../../src/core/relations/order_locators.ts';
import { buildOrderPath } from '../../src/core/search/order_path.ts';

const TARGET_SECTION = 'test3'; // where the linked records live (matrix_test)
const ORDER_DDO = 'test52'; // component_input_text under test3
const PORTAL_TIPO = 'test80'; // component_portal under test3
/** A caller section that is NOT the locators' target (test2 is a real section). */
const CALLER_SECTION = 'test2';
/** Activity section + its "When" component — the anchor-observable pair (WC-044). */
const ACTIVITY_SECTION = 'dd542';
const WHEN_DDO = 'dd547';

/** ALPHA has the LOWER section_id but the LATER dd547 time — the two orders are inverses. */
const ALPHA = 931001;
const BETA = 931002;

/** The search assembler's order-select reads the module-level DATA_LANG (not the
 * request ALS), so the seeded component value must carry exactly that lang. */
const DATA_LANG = config.menu.dataLang;

/** A portal's effective properties declaring ONE ordered column. */
const propertiesOrderedBy = (
	tipo: string,
	order: unknown,
	extraConfig: unknown[] = [],
): unknown => ({
	source: {
		request_config: [
			{
				sqo: { section_tipo: [{ value: [TARGET_SECTION], source: 'section' }] },
				show: {
					ddo_map: [
						{
							tipo,
							parent: 'self',
							section_tipo: 'self',
							...(order === undefined ? {} : { order }),
						},
					],
				},
			},
			...extraConfig,
		],
	},
});

const locator = (sectionId: number, extra: Record<string, unknown> = {}) => ({
	section_tipo: TARGET_SECTION,
	section_id: sectionId,
	from_component_tipo: PORTAL_TIPO,
	type: 'dd128',
	...extra,
});

const idsOf = (items: unknown[] | null): number[] =>
	(items ?? []).map((item) => Number((item as { section_id?: unknown }).section_id));

async function seed(sectionId: number, value: string, whenTime: number): Promise<void> {
	await sql.unsafe(
		`INSERT INTO matrix_test (section_id, section_tipo, string, date, data)
		 VALUES ($1, $2, $3::text::jsonb, $4::text::jsonb, $5::text::jsonb)
		 ON CONFLICT (section_id, section_tipo)
		 DO UPDATE SET string = EXCLUDED.string, date = EXCLUDED.date, data = EXCLUDED.data`,
		[
			sectionId,
			TARGET_SECTION,
			JSON.stringify({ [ORDER_DDO]: [{ id: 1, lang: DATA_LANG, value }] }),
			JSON.stringify({ [WHEN_DDO]: [{ id: 1, lang: 'lg-nolan', start: { time: whenTime } }] }),
			JSON.stringify({ label: value, section_id: sectionId, section_tipo: TARGET_SECTION }),
		],
	);
}

beforeAll(async () => {
	// The scratch namespace must be EMPTY before anything executes — a leftover
	// row from an aborted run would silently change the ranking.
	const pre = (await sql`
		SELECT count(*)::int AS n FROM matrix_test
		WHERE section_tipo = ${TARGET_SECTION} AND section_id BETWEEN 931000 AND 931999
	`) as { n: number }[];
	expect(pre[0]?.n).toBe(0);

	await seed(ALPHA, 'Alpha', 2000);
	await seed(BETA, 'Beta', 1000);
});

afterAll(async () => {
	await sql`
		DELETE FROM matrix_test
		WHERE section_tipo = ${TARGET_SECTION} AND section_id BETWEEN 931000 AND 931999
	`;
	await sql`
		DELETE FROM matrix_time_machine
		WHERE section_tipo = ${TARGET_SECTION} AND section_id BETWEEN 931000 AND 931999
	`;
	const residue = (await sql`
		SELECT
			(SELECT count(*) FROM matrix_test
				WHERE section_tipo = ${TARGET_SECTION} AND section_id BETWEEN 931000 AND 931999)
			+ (SELECT count(*) FROM matrix_time_machine
				WHERE section_tipo = ${TARGET_SECTION} AND section_id BETWEEN 931000 AND 931999)
			AS n
	`) as { n: string | number }[];
	expect(Number(residue[0]?.n)).toBe(0);
});

describe('fixture preconditions', () => {
	test('the scratch records carry both ordered component values', async () => {
		const rows = (await sql`
			SELECT section_id, string->${ORDER_DDO} AS v, date->${WHEN_DDO} AS d FROM matrix_test
			WHERE section_tipo = ${TARGET_SECTION} AND section_id IN (${ALPHA}, ${BETA})
			ORDER BY section_id
		`) as {
			section_id: number;
			v: { value?: string }[];
			d: { start?: { time?: number } }[];
		}[];
		expect(rows.map((row) => Number(row.section_id))).toEqual([ALPHA, BETA]);
		expect(rows.map((row) => row.v?.[0]?.value)).toEqual(['Alpha', 'Beta']);
		// the dd547 order is the INVERSE of the section_id order (the anchor probe)
		expect(rows.map((row) => row.d?.[0]?.start?.time)).toEqual([2000, 1000]);
	});

	test('dd547 resolves a DIFFERENT order column per anchor section (WC-044)', async () => {
		const onTarget = await buildOrderPath(WHEN_DDO, TARGET_SECTION);
		const onActivity = await buildOrderPath(WHEN_DDO, ACTIVITY_SECTION);
		expect(onTarget.at(-1)?.component_tipo).toBe(WHEN_DDO);
		expect(onActivity.at(-1)?.component_tipo).toBe('section_id');
	});
});

describe('orderLocatorsByDeclaredColumns — the ddo `order` key survives to config[0].show.ddo_map', () => {
	test("`order:'desc'` re-orders the stored locators by the column value", async () => {
		const sorted = await orderLocatorsByDeclaredColumns(
			[locator(ALPHA), locator(BETA)],
			propertiesOrderedBy(ORDER_DDO, 'desc'),
			PORTAL_TIPO,
			CALLER_SECTION,
		);
		// 'Beta' > 'Alpha' → DESC puts BETA first: the per-ddo key travelled
		// through buildRequestConfigForElement into the resolved show.ddo_map.
		expect(idsOf(sorted)).toEqual([BETA, ALPHA]);
	});

	test("`order:'asc'` re-orders the other way (the direction is not hard-coded)", async () => {
		const sorted = await orderLocatorsByDeclaredColumns(
			[locator(BETA), locator(ALPHA)], // stored order scrambled → ASC must re-sort
			propertiesOrderedBy(ORDER_DDO, 'asc'),
			PORTAL_TIPO,
			CALLER_SECTION,
		);
		expect(idsOf(sorted)).toEqual([ALPHA, BETA]);
	});

	test('`order:true` is ASC (the boolean form survives the config build)', async () => {
		const sorted = await orderLocatorsByDeclaredColumns(
			[locator(BETA), locator(ALPHA)],
			propertiesOrderedBy(ORDER_DDO, true),
			PORTAL_TIPO,
			CALLER_SECTION,
		);
		expect(idsOf(sorted)).toEqual([ALPHA, BETA]);
	});

	test('the caller`s stored array is never mutated', async () => {
		const stored = [locator(BETA), locator(ALPHA)];
		const sorted = await orderLocatorsByDeclaredColumns(
			stored,
			propertiesOrderedBy(ORDER_DDO, 'asc'),
			PORTAL_TIPO,
			CALLER_SECTION,
		);
		expect(idsOf(sorted)).toEqual([ALPHA, BETA]);
		expect(idsOf(stored)).toEqual([BETA, ALPHA]);
	});

	test('paginated_key is stripped from every returned object', async () => {
		const sorted = (await orderLocatorsByDeclaredColumns(
			[locator(BETA, { paginated_key: 0 }), locator(ALPHA, { paginated_key: 1 })],
			propertiesOrderedBy(ORDER_DDO, 'desc'),
			PORTAL_TIPO,
			CALLER_SECTION,
		)) as Record<string, unknown>[];
		expect(idsOf(sorted)).toEqual([BETA, ALPHA]);
		for (const item of sorted) {
			expect(Object.hasOwn(item, 'paginated_key')).toBe(false);
		}
	});
});

/**
 * THE ANCHOR. Caller section = dd542 (the activity section), ordered column =
 * dd547. Target-anchored (correct) the sort key is the dd547 DATE; caller-
 * anchored it collapses to section_id — and the fixture makes those two orders
 * exact inverses, so BOTH directions below flip if the anchor regresses.
 */
describe('orderLocatorsByDeclaredColumns — the order path is anchored on the TARGET section', () => {
	test('DESC ranks by the target-section date column, not the caller`s shortcut', async () => {
		const sorted = await orderLocatorsByDeclaredColumns(
			[locator(BETA), locator(ALPHA)],
			propertiesOrderedBy(WHEN_DDO, 'desc'),
			PORTAL_TIPO,
			ACTIVITY_SECTION,
		);
		// dd547 DESC → ALPHA (time 2000) first. Caller-anchored (section_id DESC)
		// would be [BETA, ALPHA].
		expect(idsOf(sorted)).toEqual([ALPHA, BETA]);
	});

	test('ASC ranks by the target-section date column too (the PAIR pins the anchor)', async () => {
		const sorted = await orderLocatorsByDeclaredColumns(
			[locator(ALPHA), locator(BETA)],
			propertiesOrderedBy(WHEN_DDO, 'asc'),
			PORTAL_TIPO,
			ACTIVITY_SECTION,
		);
		// dd547 ASC → BETA (time 1000) first. Caller-anchored (section_id ASC)
		// would be [ALPHA, BETA] — i.e. the stored order, indistinguishable
		// without this second direction.
		expect(idsOf(sorted)).toEqual([BETA, ALPHA]);
	});
});

describe('orderLocatorsByDeclaredColumns — short circuits (null = keep the stored order)', () => {
	test('fewer than two locators → null (before any config build)', async () => {
		expect(
			await orderLocatorsByDeclaredColumns(
				[locator(BETA)],
				propertiesOrderedBy(ORDER_DDO, 'desc'),
				PORTAL_TIPO,
				CALLER_SECTION,
			),
		).toBeNull();
		expect(
			await orderLocatorsByDeclaredColumns(
				[],
				propertiesOrderedBy(ORDER_DDO, 'desc'),
				PORTAL_TIPO,
				CALLER_SECTION,
			),
		).toBeNull();
	});

	test('no column declares `order` → null', async () => {
		expect(
			await orderLocatorsByDeclaredColumns(
				[locator(BETA), locator(ALPHA)],
				propertiesOrderedBy(ORDER_DDO, undefined),
				PORTAL_TIPO,
				CALLER_SECTION,
			),
		).toBeNull();
	});

	test('an invalid `order` value is not an order → null', async () => {
		expect(
			await orderLocatorsByDeclaredColumns(
				[locator(BETA), locator(ALPHA)],
				propertiesOrderedBy(ORDER_DDO, 'sideways'),
				PORTAL_TIPO,
				CALLER_SECTION,
			),
		).toBeNull();
	});

	test('properties without any request_config → null', async () => {
		expect(
			await orderLocatorsByDeclaredColumns(
				[locator(BETA), locator(ALPHA)],
				null,
				PORTAL_TIPO,
				CALLER_SECTION,
			),
		).toBeNull();
	});

	test('locators with no section_tipo → no ranking scope → null', async () => {
		expect(
			await orderLocatorsByDeclaredColumns(
				[{ section_id: BETA }, { section_id: ALPHA }],
				propertiesOrderedBy(ORDER_DDO, 'desc'),
				PORTAL_TIPO,
				CALLER_SECTION,
			),
		).toBeNull();
	});

	test('only the FIRST request_config item supplies the ordered columns', async () => {
		// PINNED CURRENT BEHAVIOUR (no defect id assigned): the cheap gate
		// `hasDeclaredColumnOrder` scans EVERY request_config item, but the
		// resolution reads `config[0].show.ddo_map` only — an `order` declared on
		// a SECOND config is inert. If that asymmetry is ever resolved, this
		// expectation becomes `[BETA, ALPHA]`.
		const properties = propertiesOrderedBy(ORDER_DDO, undefined, [
			{
				sqo: { section_tipo: [{ value: [TARGET_SECTION], source: 'section' }] },
				show: {
					ddo_map: [{ tipo: ORDER_DDO, parent: 'self', section_tipo: 'self', order: 'desc' }],
				},
			},
		]);
		expect(
			await orderLocatorsByDeclaredColumns(
				[locator(ALPHA), locator(BETA)],
				properties,
				PORTAL_TIPO,
				CALLER_SECTION,
			),
		).toBeNull();
	});
});
