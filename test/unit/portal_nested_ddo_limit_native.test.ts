/**
 * NESTED PORTAL CELL — the child ddo `limit` is honoured per row.
 *
 * Reported on the cataloguing tool (numisdata672): the "Ordered coins" portal
 * (numisdata965, a component_portal over numisdata267 records) declares a
 * child ddo `numisdata9` with `limit: 4`. Each row (a numisdata267 record) holds
 * a nested component_portal numisdata9 of coins, and the cell showed ONE coin
 * per row instead of the declared four.
 *
 * The contract pinned here, over a situation this file BUILDS on the generic
 * `test` TLD (no install TLD, AGENTS.md 2026-08-19):
 *   - the outer portal (ROW_PORTAL) lists ROW records;
 *   - each ROW record holds a nested portal (NESTED_PORTAL) with SIX coin
 *     locators, the NESTED ddo declaring `limit: 4`;
 *   - every NESTED item emitted under a row carries 4 entries (the declared
 *     page), `pagination.total` = 6 (the stored count) and `pagination.limit` = 4.
 *
 * The limit is declared on the CHILD ddo (not on the portal's own ddo), which
 * is the shape the tool's request_config uses. Dropping it anywhere between
 * the ddo_map and expandPortal (relation_core.ts / portal.ts) collapses the
 * cell to the one-locator default and turns this gate red.
 *
 * TWO READ PATHS, both pinned:
 *   - the SECTION read with a client show.ddo_map (the first page load);
 *   - the COMPONENT get_data read with NO show map (the client's refresh(),
 *     save echo and paging), whose children come from the outer portal's OWN
 *     request_config. This is where the bug lived: section/read.ts rebuilt
 *     the child ddos copying only tipo/section_tipo/parent/mode/lang, so every
 *     refresh collapsed each row to 1 coin. Both twins now share
 *     configChildRenderFields (relations/config_ddo_map.ts).
 *
 * Situations built here (one TLD, dropped in afterAll with residue asserted 0):
 *   zzpnl1  section (relations test24)            host record §900801
 *     zzpnl2  component_portal → zzpnl3 (rows)     own config: zzpnl5 child, limit 4
 *   zzpnl3  section (relations test24)            rows §900811, §900812
 *     zzpnl5  component_portal → zzpnl6 (coins)    the nested portal
 *   zzpnl6  section (relations test24)            coins §900821-900826
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Rqo } from '../../src/core/concepts/rqo.ts';
import { readComponentData, readSectionRows } from '../../src/core/section/read.ts';
import {
	dropSituation,
	ensureSituation,
	situation,
} from '../../src/core/test_data/situations/situation.ts';

const HOST = 'zzpnl1';
const ROW_PORTAL = 'zzpnl2';
const ROW = 'zzpnl3';
const NESTED_PORTAL = 'zzpnl5';
const COIN = 'zzpnl6';

const HOST_ID = 900801;
const ROW_IDS = [900811, 900812];
const COIN_IDS = [900821, 900822, 900823, 900824, 900825, 900826];
/** The child ddo's declared page size (the tool's `numisdata9` → `limit: 4`). */
const NESTED_LIMIT = 4;

function locator(
	sectionTipo: string,
	sectionId: number,
	fromTipo: string,
): Record<string, unknown> {
	return {
		section_id: sectionId,
		section_tipo: sectionTipo,
		type: 'dd151',
		from_component_tipo: fromTipo,
	};
}

const S = situation({
	name: 'nested portal ddo limit',
	tld: 'zzpnl',
	nodes: [
		{
			tipo: HOST,
			parent: 'test1',
			model: 'section',
			term: { 'lg-eng': 'Nested portal host section' },
			relations: [{ tipo: 'test24' }],
		},
		{
			tipo: ROW_PORTAL,
			parent: HOST,
			model: 'component_portal',
			// The tool's numisdata965 shape: the nested ddo's limit is declared in
			// the OUTER portal's OWN request_config — the map the component
			// get_data read (refresh / save echo / paging) builds its children from.
			properties: {
				source: {
					request_config: [
						{
							sqo: { section_tipo: [{ value: [ROW], source: 'section' }] },
							show: {
								ddo_map: [
									{
										tipo: NESTED_PORTAL,
										section_tipo: 'self',
										parent: 'self',
										mode: 'list',
										limit: NESTED_LIMIT,
									},
								],
							},
						},
					],
				},
			},
		},
		{
			tipo: ROW,
			parent: 'test1',
			model: 'section',
			term: { 'lg-eng': 'Nested portal row section' },
			relations: [{ tipo: 'test24' }],
		},
		{ tipo: NESTED_PORTAL, parent: ROW, model: 'component_portal' },
		{
			tipo: COIN,
			parent: 'test1',
			model: 'section',
			term: { 'lg-eng': 'Nested portal coin section' },
			relations: [{ tipo: 'test24' }],
		},
	],
	records: [
		{
			section_tipo: HOST,
			section_id: HOST_ID,
			columns: {
				relation: {
					[ROW_PORTAL]: ROW_IDS.map((id) => locator(ROW, id, ROW_PORTAL)),
				},
			},
		},
		...ROW_IDS.map((rowId) => ({
			section_tipo: ROW,
			section_id: rowId,
			columns: {
				relation: {
					[NESTED_PORTAL]: COIN_IDS.map((id) => locator(COIN, id, NESTED_PORTAL)),
				},
			},
		})),
		...COIN_IDS.map((id) => ({
			section_tipo: COIN,
			section_id: id,
			columns: {},
		})),
	],
});

/**
 * The section LIST read the cataloguing tool issues: the outer portal's own ddo
 * plus the nested portal's child ddo carrying `limit: NESTED_LIMIT`.
 */
function readRqo(): Rqo {
	return {
		action: 'read',
		dd_api: 'dd_core_api',
		prevent_lock: true,
		source: {
			model: 'section',
			tipo: HOST,
			section_tipo: HOST,
			mode: 'list',
			lang: 'lg-eng',
			action: 'search',
		},
		sqo: {
			section_tipo: [HOST],
			filter_by_locators: [{ section_tipo: HOST, section_id: HOST_ID }],
			limit: 1,
			offset: 0,
		},
		show: {
			ddo_map: [
				{
					tipo: ROW_PORTAL,
					section_tipo: 'self',
					parent: 'self',
					mode: 'list',
					limit: ROW_IDS.length,
				},
				{
					tipo: NESTED_PORTAL,
					section_tipo: ROW,
					parent: ROW_PORTAL,
					mode: 'list',
					limit: NESTED_LIMIT,
				},
			],
		},
	} as unknown as Rqo;
}

/**
 * The COMPONENT get_data read of the outer portal — the RQO the client issues
 * on `refresh()`, on a save echo and when paging (captured live on
 * numisdata665/112 → numisdata965): NO show map, so the children come from the
 * portal's OWN request_config, where the nested ddo declares its limit.
 */
function getDataRqo(): Rqo {
	return {
		action: 'read',
		source: {
			type: 'component',
			action: 'get_data',
			model: 'component_portal',
			tipo: ROW_PORTAL,
			section_tipo: HOST,
			section_id: HOST_ID,
			mode: 'edit',
			lang: 'lg-eng',
		},
		sqo: {
			section_tipo: [ROW],
			filter_by_locators: ROW_IDS.map((id) => ({ section_tipo: ROW, section_id: id })),
			limit: 300,
			offset: 0,
		},
	} as unknown as Rqo;
}

beforeAll(async () => {
	await ensureSituation(S);
});

afterAll(async () => {
	expect(await dropSituation(S)).toBe(0);
});

describe('nested portal cell — the child ddo limit reaches every row', () => {
	test('each row renders the declared page of nested coins (4, not 1)', async () => {
		const items = (await readSectionRows(readRqo())) as unknown as Record<string, unknown>[];
		// Non-vacuity floor: the outer rows and the nested cells were really read.
		const nested = items.filter((item) => item.tipo === NESTED_PORTAL);
		expect(nested.length).toBe(ROW_IDS.length);

		for (const rowId of ROW_IDS) {
			// The cell item is stamped with its ROW record's id (section_id); the
			// row_section_id is re-anchored to the OUTER host record.
			const cell = nested.find((item) => item.section_id === rowId);
			expect(cell).toBeDefined();
			const entries = (cell as Record<string, unknown>).entries as unknown[];
			expect(entries.length).toBe(NESTED_LIMIT);
		}
	});

	test('pagination of each nested cell = {total: stored count, limit: the ddo limit}', async () => {
		const items = (await readSectionRows(readRqo())) as unknown as Record<string, unknown>[];
		for (const cell of items.filter((item) => item.tipo === NESTED_PORTAL)) {
			const pagination = cell.pagination as { total: number; limit: number; offset: number };
			expect(pagination.total).toBe(COIN_IDS.length);
			expect(pagination.limit).toBe(NESTED_LIMIT);
			expect(pagination.offset).toBe(0);
		}
	});
});

describe('nested portal cell — the component get_data read keeps the child ddo limit', () => {
	test('each row of a get_data read renders the declared page (4, not the 1-locator default)', async () => {
		const items = (await readComponentData(getDataRqo())) as unknown as Record<string, unknown>[];
		// Non-vacuity floor: the outer portal and both nested cells were really read.
		expect(items.some((item) => item.tipo === ROW_PORTAL)).toBe(true);
		const nested = items.filter((item) => item.tipo === NESTED_PORTAL);
		expect(nested.length).toBe(ROW_IDS.length);

		for (const rowId of ROW_IDS) {
			// get_data subdatum rows anchor on the LOCATOR TARGET (the row record).
			const cell = nested.find((item) => item.section_id === rowId);
			expect(cell).toBeDefined();
			const entries = (cell as Record<string, unknown>).entries as unknown[];
			expect(entries.length).toBe(NESTED_LIMIT);
			const pagination = (cell as Record<string, unknown>).pagination as {
				total: number;
				limit: number;
				offset: number;
			};
			expect(pagination.total).toBe(COIN_IDS.length);
			expect(pagination.limit).toBe(NESTED_LIMIT);
			expect(pagination.offset).toBe(0);
		}
	});
});
