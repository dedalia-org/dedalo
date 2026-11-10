/**
 * PORTAL SUBDATUM IN LIST MODE — locator paging + child stamps.
 *
 * TS-native twin of the RETIRED `test/parity/portal_differential.test.ts`
 * (deleted with its frozen fixture `oracle_harvest/portal_differential.json`).
 * That gate byte-diffed the TS emission against a PHP response harvested on
 * the monedaiberica install: it read numisdata6 §2 (a record that happens to
 * hold 22 rsc332 bibliography locators) through numisdata163 → rsc473. Nothing
 * about the CONTRACT was corpus-specific, but every coordinate was: on any
 * other database the record, its locator count and the section_list-substituted
 * cell limit do not exist, so the gate was red by construction. The PHP half is
 * a fossil; the contract below is the asset, re-expressed over situations this
 * file BUILDS (AGENTS.md, 2026-08-19).
 *
 * The contract, 1:1 with the retired gate:
 *  - the portal's OWN item carries the PAGINATED locator slice (each locator
 *    stamped with its paginated_key) and `pagination.total` = the FULL stored
 *    locator count, `pagination.limit` = the resolved cell limit;
 *  - the LIST limit chain (relation_core.ts:335-360): the ddo-declared limit
 *    wins, else the component's effective list config limit (the section_list
 *    substitution, portal.ts:110-180), else PORTAL_LIST_LIMIT = 1;
 *  - the child items come in LOCATOR order, one per paged locator, carrying the
 *    target's identity (section_tipo + section_id) and the target's stored
 *    value — `entries: []` when the target is empty, never null (WC-001);
 *  - a DIRECT get_data of the portal (the client's refresh read, sent with the
 *    portal's own lang `lg-nolan`) resolves its translatable children in the
 *    ACTIVE data lang, exactly like the section read — never in lg-nolan, which
 *    would empty `entries` and push every value into `fallback_value`;
 *  - the section-read re-stamp (relation_core.ts:650-682): every emitted item
 *    is anchored to the OUTER record (row_section_id) and re-parented to the
 *    read's caller, while a child keeps `from_component_tipo` = the CREATING
 *    portal.
 *
 * Situations built here (one TLD, dropped in afterAll with residue asserted 0):
 *   zzpl1  section (relations test24 → matrix_test)   host record §900601
 *     zzpl2  component_portal → zzpl3, NO section_list child  ⇒ cell limit 1
 *     zzpl5  component_portal → zzpl3
 *       zzpl6  section_list, show.sqo_config.limit 2          ⇒ cell limit 2
 *   zzpl3  section (relations test24 → matrix_test)   targets §900701-900704
 *     zzpl4  component_input_text (translatable)
 * The four locators are stored in a NON-MONOTONIC order so "locator order" is
 * distinguishable from "id order", and one target (§900702) is left EMPTY so a
 * page that includes it pins the WC-001 empty contract.
 *
 * @twin-of      test/parity/portal_differential.test.ts
 * @twin-status  retired
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Rqo } from '../../src/core/concepts/rqo.ts';
import { runWithRequestLangs } from '../../src/core/resolve/request_lang.ts';
import { readComponentData, readSectionRows } from '../../src/core/section/read.ts';
import {
	dropSituation,
	ensureSituation,
	situation,
} from '../../src/core/test_data/situations/situation.ts';

const HOST = 'zzpl1';
const PORTAL = 'zzpl2'; // no section_list child  → cell limit falls to PORTAL_LIST_LIMIT
const TARGET = 'zzpl3';
const CHILD = 'zzpl4';
const PORTAL_LIMITED = 'zzpl5'; // section_list child declares sqo_config.limit 2

const HOST_ID = 900601;
/** Stored locator order — deliberately NOT the id order. */
const LOCATOR_IDS = [900703, 900702, 900704, 900701];
/** §900702 is stored with NO value at all (the WC-001 empty case). */
const TARGET_VALUES: Record<number, string | null> = {
	900701: 'target one',
	900702: null,
	900703: 'target three',
	900704: 'target four',
};

/** One portal request_config item (mirrors the test80 shape: search-only limit). */
function portalProperties(): Record<string, unknown> {
	return {
		source: {
			request_config: [
				{
					sqo: { section_tipo: [{ value: [TARGET], source: 'section' }] },
					show: {
						ddo_map: [{ tipo: CHILD, parent: 'self', section_tipo: 'self', mode: 'list' }],
					},
					// A `search` limit must NOT leak into the list cell.
					search: {
						ddo_map: [{ tipo: CHILD, parent: 'self', section_tipo: 'self' }],
						sqo_config: { limit: 30 },
						fields_separator: ', ',
					},
				},
			],
		},
	};
}

function locator(sectionId: number, portalTipo: string): Record<string, unknown> {
	return {
		section_id: sectionId,
		section_tipo: TARGET,
		type: 'dd151',
		from_component_tipo: portalTipo,
	};
}

const S = situation({
	name: 'portal list-cell pagination',
	tld: 'zzpl',
	nodes: [
		{
			tipo: HOST,
			parent: 'test1',
			model: 'section',
			term: { 'lg-eng': 'Portal host section' },
			relations: [{ tipo: 'test24' }],
		},
		{ tipo: PORTAL, parent: HOST, model: 'component_portal', properties: portalProperties() },
		{
			tipo: TARGET,
			parent: 'test1',
			model: 'section',
			term: { 'lg-eng': 'Portal target section' },
			relations: [{ tipo: 'test24' }],
		},
		{ tipo: CHILD, parent: TARGET, model: 'component_input_text', is_translatable: true },
		{
			tipo: PORTAL_LIMITED,
			parent: HOST,
			model: 'component_portal',
			order_number: 2,
			properties: portalProperties(),
		},
		{
			tipo: 'zzpl6',
			parent: PORTAL_LIMITED,
			model: 'section_list',
			properties: {
				source: {
					request_config: [
						{
							show: {
								ddo_map: [{ tipo: CHILD, parent: 'self', section_tipo: 'self', mode: 'list' }],
								sqo_config: { limit: 2 },
							},
						},
					],
				},
			},
		},
	],
	records: [
		{
			section_tipo: HOST,
			section_id: HOST_ID,
			columns: {
				relation: {
					[PORTAL]: LOCATOR_IDS.map((id) => locator(id, PORTAL)),
					[PORTAL_LIMITED]: LOCATOR_IDS.map((id) => locator(id, PORTAL_LIMITED)),
				},
			},
		},
		...Object.entries(TARGET_VALUES).map(([id, value]) => ({
			section_tipo: TARGET,
			section_id: Number(id),
			// component_input_text stores in the `string` column (its descriptor).
			columns: {
				string: value === null ? {} : { [CHILD]: [{ lang: 'lg-eng', value }] },
			},
		})),
	],
});

/** The section LIST read the retired gate issued, retargeted at the situation. */
function readRqo(portalTipo: string, ddoLimit?: number): Rqo {
	const portalDdo: Record<string, unknown> = {
		tipo: portalTipo,
		section_tipo: 'self',
		parent: 'self',
		mode: 'list',
	};
	if (ddoLimit !== undefined) portalDdo.limit = ddoLimit;
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
				portalDdo,
				{ tipo: CHILD, section_tipo: TARGET, parent: portalTipo, mode: 'list', lang: 'lg-eng' },
			],
		},
	} as unknown as Rqo;
}

async function readItems(
	portalTipo: string,
	ddoLimit?: number,
): Promise<Record<string, unknown>[]> {
	const out = (await readSectionRows(readRqo(portalTipo, ddoLimit))) as unknown as Record<
		string,
		unknown
	>[];
	return out;
}

function itemsOf(data: Record<string, unknown>[], tipo: string): Record<string, unknown>[] {
	return data.filter((item) => item.tipo === tipo);
}

beforeAll(async () => {
	await ensureSituation(S);
});

afterAll(async () => {
	expect(await dropSituation(S)).toBe(0);
});

describe("portal list cell — the portal's own item (paginated slice + pagination)", () => {
	test('page = the FIRST cell-limit locators, in stored order, with paginated_key', async () => {
		const items = await readItems(PORTAL);
		// Non-vacuity floor: the read really returned the host row + its cell.
		expect(items.length).toBeGreaterThan(1);
		const portal = itemsOf(items, PORTAL)[0] as Record<string, unknown>;
		expect(portal).toBeDefined();
		const entries = portal.entries as Record<string, unknown>[];
		// PORTAL_LIST_LIMIT: no ddo limit, no section_list-substituted cell limit
		// (the component's own config declares its 30 under `search`, which must
		// NOT leak into the list cell) ⇒ a one-locator cell.
		expect(entries.length).toBe(1);
		expect(entries[0]).toEqual({
			type: 'dd151',
			section_id: LOCATOR_IDS[0],
			section_tipo: TARGET,
			from_component_tipo: PORTAL,
			paginated_key: 0,
		});
	});

	test('pagination = {total: FULL locator count, limit: the cell limit}', async () => {
		const portal = itemsOf(await readItems(PORTAL), PORTAL)[0] as Record<string, unknown>;
		const pagination = portal.pagination as { total: number; limit: number; offset: number };
		// `total` is the STORED count (4), never the page size — the whole point
		// of the retired differential's numisdata6 §2 (22 locators, 1 shown).
		expect(pagination.total).toBe(LOCATOR_IDS.length);
		expect(pagination.limit).toBe(1);
		expect(pagination.offset).toBe(0);
	});

	test('the portal item is anchored to the OUTER record and re-parented to the caller', async () => {
		const portal = itemsOf(await readItems(PORTAL), PORTAL)[0] as Record<string, unknown>;
		expect(portal.section_tipo).toBe(HOST);
		expect(portal.section_id).toBe(HOST_ID);
		expect(portal.row_section_id).toBe(HOST_ID);
		// The section-read re-stamp: parent_tipo is the READ's caller (the host
		// section), not the portal — PHP class.common.php:2792-2799, which the
		// retired gate pinned by diffing against the live oracle.
		expect(portal.parent_tipo).toBe(HOST);
		expect(portal.parent_section_id).toBe(HOST_ID);
		expect(portal.mode).toBe('list');
		expect(portal.lang).toBe('lg-nolan'); // relation components are not translatable
		expect(portal.from_component_tipo).toBe(PORTAL);
	});
});

describe('portal list cell — the LIST limit chain', () => {
	test('a section_list child SUBSTITUTES the cell limit (2 here, not PORTAL_LIST_LIMIT)', async () => {
		const items = await readItems(PORTAL_LIMITED);
		const portal = itemsOf(items, PORTAL_LIMITED)[0] as Record<string, unknown>;
		const entries = portal.entries as Record<string, unknown>[];
		expect(entries.map((entry) => entry.section_id)).toEqual(LOCATOR_IDS.slice(0, 2));
		expect(entries.map((entry) => entry.paginated_key)).toEqual([0, 1]);
		expect(portal.pagination).toEqual({ total: LOCATOR_IDS.length, limit: 2, offset: 0 });
	});

	test('a ddo-DECLARED limit wins over both (same portal, limit 3)', async () => {
		const items = await readItems(PORTAL_LIMITED, 3);
		const portal = itemsOf(items, PORTAL_LIMITED)[0] as Record<string, unknown>;
		const entries = portal.entries as Record<string, unknown>[];
		expect(entries.map((entry) => entry.section_id)).toEqual(LOCATOR_IDS.slice(0, 3));
		expect(portal.pagination).toEqual({ total: LOCATOR_IDS.length, limit: 3, offset: 0 });
	});
});

describe('portal list cell — the child items', () => {
	test('one child per PAGED locator, in locator order, with the target identity', async () => {
		// Page of 3 over a non-monotonic locator order: proves the children follow
		// the LOCATOR sequence, not the id order and not the stored id order.
		const children = itemsOf(await readItems(PORTAL_LIMITED, 3), CHILD);
		expect(children.length).toBe(3);
		expect(children.map((child) => child.section_id)).toEqual(LOCATOR_IDS.slice(0, 3));
		for (const child of children) {
			expect(child.section_tipo).toBe(TARGET);
			expect(child.tipo).toBe(CHILD);
			expect(child.mode).toBe('list');
			expect(child.lang).toBe('lg-eng');
		}
	});

	test("entries = the TARGET's stored value — [] when empty, never null (WC-001)", async () => {
		const children = itemsOf(await readItems(PORTAL_LIMITED, 3), CHILD);
		const byId = new Map(children.map((child) => [Number(child.section_id), child.entries]));
		expect(byId.get(900703)).toEqual([{ lang: 'lg-eng', value: TARGET_VALUES[900703] }]);
		expect(byId.get(900704)).toEqual([{ lang: 'lg-eng', value: TARGET_VALUES[900704] }]);
		// §900702 has no stored value at all: the empty contract is [], not null.
		expect(byId.get(900702)).toEqual([]);
		expect(byId.get(900702)).not.toBeNull();
	});

	test('subdatum stamps: row anchor = the OUTER record, parent = the caller, source = the portal', async () => {
		const children = itemsOf(await readItems(PORTAL_LIMITED, 3), CHILD);
		expect(children.length).toBe(3);
		for (const child of children) {
			// The child's own identity stays at the TARGET (asserted above) while
			// the row anchor is the OUTER record — the re-stamp that distinguishes
			// a section read from get_data's target anchor.
			expect(child.row_section_id).toBe(HOST_ID);
			expect(child.parent_tipo).toBe(HOST);
			// The CREATING portal survives the re-stamp.
			expect(child.from_component_tipo).toBe(PORTAL_LIMITED);
		}
	});

	test('the two portals of the same record page independently', async () => {
		const children = itemsOf(await readItems(PORTAL), CHILD);
		expect(children.length).toBe(1); // cell limit 1 ⇒ exactly one expanded target
		expect(children[0]?.from_component_tipo).toBe(PORTAL);
		expect(children[0]?.section_id).toBe(LOCATOR_IDS[0]);
	});
});

/** The client's portal refresh read: get_data on the portal itself, lang = its own lg-nolan. */
async function readPortalDirect(lang: string): Promise<Record<string, unknown>[]> {
	const items = await runWithRequestLangs({ applicationLang: 'lg-eng', dataLang: 'lg-eng' }, () =>
		readComponentData({
			action: 'read',
			source: {
				action: 'get_data',
				model: 'component_portal',
				tipo: PORTAL,
				section_tipo: HOST,
				section_id: HOST_ID,
				mode: 'edit',
				lang,
			},
			sqo: { section_tipo: [TARGET], limit: 10, offset: 0 },
		} as unknown as Rqo),
	);
	return items as unknown as Record<string, unknown>[];
}

describe('portal get_data (the refresh read) — children lang', () => {
	test('lang lg-nolan ⇒ translatable children resolve in the ACTIVE data lang', async () => {
		const children = itemsOf(await readPortalDirect('lg-nolan'), CHILD);
		// Non-vacuity: every stored locator was expanded (edit page of 10).
		expect(children.length).toBe(LOCATOR_IDS.length);
		const filled = children.filter((child) => TARGET_VALUES[Number(child.section_id)] !== null);
		expect(filled.length).toBe(3);
		for (const child of filled) {
			expect(child.lang).toBe('lg-eng');
			// The value is the child's OWN-lang entry, not a fallback (the client
			// marks fallbacks and drops the separators between them).
			expect(child.entries).toEqual([
				{ lang: 'lg-eng', value: TARGET_VALUES[Number(child.section_id)] },
			]);
		}
	});

	test('an EXPLICIT translatable lang ask is kept (lg-spa ⇒ children in lg-spa)', async () => {
		const children = itemsOf(await readPortalDirect('lg-spa'), CHILD);
		expect(children.length).toBe(LOCATOR_IDS.length);
		for (const child of children) {
			expect(child.lang).toBe('lg-spa');
			expect(child.entries).toEqual([]);
		}
	});
});
