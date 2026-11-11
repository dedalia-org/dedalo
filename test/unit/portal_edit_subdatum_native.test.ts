/**
 * PORTAL SUBDATUM IN EDIT MODE — the relation-component foundation, expressed
 * generically (AGENTS.md 2026-08-19: a test BUILDS the situation it tests).
 *
 * REPLACES test/parity/portal_edit_subdatum_differential.test.ts, which
 * byte-diffed a frozen PHP capture of ONE install's coin section (a portal on
 * a specific record with a specific locator count, a specific sqo_config
 * limit and two specific nested portals). That gate could only ever be green
 * on the machine that held the corpus; its PHP half is a fossil. What it
 * PROVED is re-expressed here as a TS-native assertion over a situation this
 * file materializes — no oracle, no corpus, the same contracts 1:1:
 *
 *  (a) SECTION EDIT READ of a portal column: the portal's own item pages by
 *      its OWN request_config limit (`sqo.limit ?? show.sqo_config.limit`,
 *      LAST config item wins — the situation declares two items, 3 then 9,
 *      and the second's sqo.limit 9 beats its own sqo_config 99), while
 *      pagination.total is the FULL locator count. Every paginated locator's
 *      target expands through the child ddos, stamped from_component_tipo =
 *      the portal, row_section_id = the OUTER record, parent_tipo = the
 *      section; child modes are declared-edit / stamped-list. NESTED portals
 *      inside the page RECURSE with their OWN config (own child, own page
 *      limit), and their children keep the NESTED portal as
 *      from_component_tipo. Asserted as an ordered, byte-equal item sequence.
 *  (b) GET_DATA client paging: sqo.limit/offset drive the page; limit 0
 *      (show-all) and an over-ceiling limit CLAMP to CLIENT_MAX_LIMIT (1000)
 *      with the offset echoed; subdatum rows anchor row_section_id on the
 *      LOCATOR TARGET (not the outer record), and the portal's OWN item
 *      carries no row_section_id at all.
 *  (c) GET_DATA context: one entry for the portal plus one per UNIQUE
 *      (tipo, section_tipo, mode) actually resolved — the nested portal's
 *      child included — in first-emission order, each parented to its
 *      GENERATING component, `view` taken from the generating ddo and
 *      parent_grouper from the ontology parent (the situation puts one child
 *      under a section_group_div to make that visible).
 *  (d) OFFSET PAGING continuity: the window is [offset, offset+limit),
 *      paginated_key = index + offset, pagination {total = FULL, limit,
 *      offset}, and the expanded children are the paged targets'.
 *  (e) INSTANCE LANG on the get_data path: with a real request data lang the
 *      TRANSLATABLE children resolve in it while the non-translatable ones
 *      are nolan-forced (read.ts:1864). The client's paging/refresh rqos ask
 *      for the portal's own lg-nolan: the translatable children then resolve
 *      in the session's ACTIVE data lang, never lg-nolan (contracts b/d —
 *      WC-2026-11-10-portal-get-data-children-lang; the retired differential
 *      pinned PHP's lg-nolan children, whose values all fell to fallback).
 *
 * COMPARISON SURFACE: the differential's normalize() built a NINE-key object
 * per item — tipo, section_tipo, section_id, mode, lang, from_component_tipo,
 * row_section_id, parent_tipo, `entries`, pagination — and byte-compared the
 * whole thing in order. `entries` is IN, here as there: every child's resolved
 * value payload and every portal item's full locator array (id / type /
 * section_tipo / section_id / from_component_tipo / paginated_key per entry)
 * are part of what this gate holds. The `sections` envelope item is filtered
 * out of the sequence exactly as the old normalize() did, and asserted on its
 * own below.
 *
 * Engine under test: src/core/relations/relation_core.ts (expandPortal — the
 * own-edit-limit chain, the page slice + paginated_key, the portal/child
 * stamps, allowNestedOwnConfig) and src/core/section/read.ts (the client
 * limit clamp, the get_data portal expansion, the instance-lang rule,
 * buildGetDataContext).
 *
 * SITUATION (`zzpe`, scratch TLD, matrix_test ids >= 900000): a host section
 * with a portal onto a target section that carries four literal children AND
 * a nested portal onto a third section; one host record with 3 locators
 * (contract a), one with 12 (contracts b, d, e), twelve targets each holding
 * one nested locator. Dropped in afterAll with residue asserted 0.
 *
 * @twin-of      test/parity/portal_edit_subdatum_differential.test.ts
 * @twin-status  retired
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { dispatchRqo } from '../../src/core/api/dispatch.ts';
import { resolvePrincipal } from '../../src/core/security/permissions.ts';
import {
	createSession,
	getSession,
	setSessionLangs,
} from '../../src/core/security/session_store.ts';
import {
	dropSituation,
	ensureSituation,
	situation,
} from '../../src/core/test_data/situations/situation.ts';
import { registerSessionCleanup } from '../helpers/session_cleanup.ts';

registerSessionCleanup();

const HOST = 'zzpe1';
const PORTAL = 'zzpe2';
const TARGET = 'zzpe3';
const NESTED_PORTAL = 'zzpe6';
const NESTED_SECTION = 'zzpe7';
const NESTED_CHILD = 'zzpe8';
/** Host record read in EDIT (contract a) — 3 locators, pages under the limit. */
const HOST_SMALL = 900201;
/** Host record paged by the client paginator (contracts b, d, e) — 12 locators. */
const HOST_PAGED = 900202;
const FIRST_TARGET = 900301;
const TARGET_COUNT = 12;
const NESTED_TARGET = 900401;
/** src/core/concepts/sqo.ts CLIENT_MAX_LIMIT — re-stated so the clamp is pinned, not derived. */
const CLIENT_CEILING = 1000;

/** One child ddo of the portal's request_config show map. */
const childDdo = (tipo: string, extra: Record<string, unknown> = {}) => ({
	tipo,
	parent: PORTAL,
	section_tipo: TARGET,
	...extra,
});

/** The show map both config items declare (dedup keeps ONE set of children). */
const showDdoMap = [
	childDdo('zzpe4', { mode: 'edit' }), // declared EDIT inside a list-mode expansion
	childDdo(NESTED_PORTAL), // the nested portal — recurses with its own config
	childDdo('zzpe5', { view: 'line' }), // `view` travels to the context entry
	childDdo('zzpe9'),
	childDdo('zzpe10'), // lives under a section_group_div (parent_grouper)
];

const S = situation({
	name: 'portal edit subdatum',
	tld: 'zzpe',
	nodes: [
		{ tipo: HOST, parent: 'test1', model: 'section', relations: [{ tipo: 'test24' }] },
		{
			tipo: PORTAL,
			parent: HOST,
			model: 'component_portal',
			properties: {
				source: {
					request_config: [
						// FIRST item: its limit (3) is superseded by the second's.
						{
							sqo: { section_tipo: [{ value: [TARGET], source: 'section' }] },
							show: { ddo_map: showDdoMap, sqo_config: { limit: 3 } },
						},
						// LAST item wins, and within it sqo.limit beats sqo_config.limit.
						{
							sqo: { section_tipo: [{ value: [TARGET], source: 'section' }], limit: 9 },
							show: { ddo_map: showDdoMap, sqo_config: { limit: 99 } },
						},
					],
				},
			},
		},
		{ tipo: TARGET, parent: 'test1', model: 'section', relations: [{ tipo: 'test24' }] },
		{ tipo: 'zzpe4', parent: TARGET, model: 'component_input_text', is_translatable: true },
		{ tipo: 'zzpe5', parent: TARGET, model: 'component_number', order_number: 2 },
		{ tipo: 'zzpe9', parent: TARGET, model: 'component_input_text', order_number: 3 },
		{ tipo: 'zzpe11', parent: TARGET, model: 'section_group_div', order_number: 4 },
		{ tipo: 'zzpe10', parent: 'zzpe11', model: 'component_text_area', is_translatable: true },
		{
			tipo: NESTED_PORTAL,
			parent: TARGET,
			model: 'component_portal',
			order_number: 5,
			properties: {
				source: {
					request_config: [
						{
							sqo: { section_tipo: [{ value: [NESTED_SECTION], source: 'section' }] },
							show: {
								ddo_map: [
									{ tipo: NESTED_CHILD, parent: NESTED_PORTAL, section_tipo: NESTED_SECTION },
								],
								// The nested portal's OWN page limit — never the outer 9.
								sqo_config: { limit: 2 },
							},
						},
					],
				},
			},
		},
		{ tipo: NESTED_SECTION, parent: 'test1', model: 'section', relations: [{ tipo: 'test24' }] },
		{ tipo: NESTED_CHILD, parent: NESTED_SECTION, model: 'component_input_text' },
	],
	records: [
		{
			section_tipo: HOST,
			section_id: HOST_SMALL,
			columns: {
				relation: {
					[PORTAL]: [0, 1, 2].map((index) => ({
						id: index + 1,
						type: 'dd151',
						section_id: FIRST_TARGET + index,
						section_tipo: TARGET,
						from_component_tipo: PORTAL,
					})),
				},
			},
		},
		{
			section_tipo: HOST,
			section_id: HOST_PAGED,
			columns: {
				relation: {
					[PORTAL]: Array.from({ length: TARGET_COUNT }, (_, index) => ({
						id: index + 1,
						type: 'dd151',
						section_id: FIRST_TARGET + index,
						section_tipo: TARGET,
						from_component_tipo: PORTAL,
					})),
				},
			},
		},
		...Array.from({ length: TARGET_COUNT }, (_, index) => ({
			section_tipo: TARGET,
			section_id: FIRST_TARGET + index,
			columns: {
				string: {
					zzpe4: [{ id: 1, lang: 'lg-eng', value: `target ${index}` }],
					zzpe9: [{ id: 1, lang: 'lg-nolan', value: `plain ${index}` }],
					zzpe10: [{ id: 1, lang: 'lg-eng', value: `area ${index}` }],
				},
				number: { zzpe5: [{ id: 1, value: 100 + index }] },
				relation: {
					[NESTED_PORTAL]: [
						{
							id: 1,
							type: 'dd151',
							section_id: NESTED_TARGET,
							section_tipo: NESTED_SECTION,
							from_component_tipo: NESTED_PORTAL,
						},
					],
				},
			},
		})),
		{
			section_tipo: NESTED_SECTION,
			section_id: NESTED_TARGET,
			columns: { string: { [NESTED_CHILD]: [{ id: 1, lang: 'lg-nolan', value: 'nested leaf' }] } },
		},
	],
});

let tsContext: Record<string, unknown>;

/** The session data lang the paging reads run under (the values live in it). */
const SESSION_DATA_LANG = 'lg-eng';

beforeAll(async () => {
	await ensureSituation(S);
	const token = createSession(-1, 'root', true);
	// The session's ACTIVE data lang — what a lg-nolan get_data's translatable
	// children resolve in (WC-2026-11-10-portal-get-data-children-lang).
	setSessionLangs(token, { dataLang: SESSION_DATA_LANG });
	const session = getSession(token);
	tsContext = {
		requestId: 'portal-edit-subdatum',
		clientIp: '127.0.0.1',
		session,
		csrfCandidate: session?.csrfToken ?? null,
		principal: await resolvePrincipal(-1),
	};
}, 60000);

afterAll(async () => {
	expect(await dropSituation(S)).toBe(0);
});

interface Item {
	typo?: unknown;
	tipo?: unknown;
	section_tipo?: unknown;
	section_id?: unknown;
	mode?: unknown;
	lang?: unknown;
	from_component_tipo?: unknown;
	row_section_id?: unknown;
	parent_tipo?: unknown;
	entries?: unknown;
	pagination?: unknown;
}

/** The comparison surface — the exact nine keys the retired differential compared. */
function surfaceOf(item: Item): Record<string, unknown> {
	return {
		tipo: item.tipo,
		section_tipo: item.section_tipo,
		section_id: item.section_id,
		mode: item.mode,
		lang: item.lang,
		from_component_tipo: item.from_component_tipo,
		row_section_id: item.row_section_id ?? null,
		parent_tipo: item.parent_tipo ?? null,
		entries: item.entries ?? null,
		pagination: item.pagination ?? null,
	};
}

async function callRqo(
	rqo: unknown,
): Promise<{ data: Item[]; context: Record<string, unknown>[] }> {
	const body = (await dispatchRqo(structuredClone(rqo) as never, tsContext as never)).body as {
		ok?: boolean;
		data?: { data?: Item[]; context?: Record<string, unknown>[] };
	};
	expect(body.ok).not.toBe(false);
	return { data: body.data?.data ?? [], context: body.data?.context ?? [] };
}

/** The item sequence the differential compared: the `sections` envelope is out. */
const rowsOf = (data: Item[]): Item[] => data.filter((item) => item.typo !== 'sections');

/** Assert an ordered, byte-equal item sequence (the differential's core check). */
function expectSequence(items: Item[], expected: Record<string, unknown>[]): void {
	expect(items.length).toBe(expected.length);
	for (let index = 0; index < expected.length; index++) {
		expect(JSON.stringify(surfaceOf(items[index] as Item))).toBe(JSON.stringify(expected[index]));
	}
}

/** The page window's locator entries, each carrying its absolute paginated_key. */
const portalLocators = (offset: number, count: number) =>
	Array.from({ length: count }, (_, index) => ({
		id: offset + index + 1,
		type: 'dd151',
		section_id: FIRST_TARGET + offset + index,
		section_tipo: TARGET,
		from_component_tipo: PORTAL,
		paginated_key: offset + index,
	}));

/** The nested portal's single locator (every target holds exactly one). */
const nestedLocator = {
	id: 1,
	type: 'dd151',
	section_id: NESTED_TARGET,
	section_tipo: NESTED_SECTION,
	from_component_tipo: NESTED_PORTAL,
	paginated_key: 0,
};

/**
 * A translatable child's entries: the resolved lang's slice (the values live
 * in lg-eng; any other lang gets an empty `entries` plus a fallback_value,
 * outside this surface).
 */
const translatedEntries = (lang: string, value: string) =>
	lang === 'lg-eng' ? [{ id: 1, lang, value }] : [];

/**
 * The six items one paginated locator's target emits, in ddo_map order:
 * the declared-edit literal, the nested portal (own pagination), the nested
 * portal's OWN child (from_component_tipo = the nested portal), then the
 * three stamped-list literals — with the value payload each one must resolve.
 */
function subdatumOf(
	index: number,
	options: { rowAnchor: number; callerTipo: string; requestLang: string },
): Record<string, unknown>[] {
	const { rowAnchor, callerTipo, requestLang } = options;
	const target = FIRST_TARGET + index;
	const row = (extra: Record<string, unknown>): Record<string, unknown> =>
		surfaceOf({
			section_tipo: TARGET,
			section_id: target,
			mode: 'list',
			lang: 'lg-nolan',
			from_component_tipo: PORTAL,
			row_section_id: rowAnchor,
			parent_tipo: callerTipo,
			...extra,
		});
	return [
		row({
			tipo: 'zzpe4',
			mode: 'edit',
			lang: requestLang,
			entries: translatedEntries(requestLang, `target ${index}`),
		}),
		row({
			tipo: NESTED_PORTAL,
			entries: [nestedLocator],
			pagination: { total: 1, limit: 2, offset: 0 },
		}),
		row({
			tipo: NESTED_CHILD,
			section_tipo: NESTED_SECTION,
			section_id: NESTED_TARGET,
			from_component_tipo: NESTED_PORTAL,
			entries: [{ id: 1, lang: 'lg-nolan', value: 'nested leaf' }],
		}),
		row({ tipo: 'zzpe5', entries: [{ id: 1, value: 100 + index }] }),
		row({ tipo: 'zzpe9', entries: [{ id: 1, lang: 'lg-nolan', value: `plain ${index}` }] }),
		row({
			tipo: 'zzpe10',
			lang: requestLang,
			entries: translatedEntries(requestLang, `area ${index}`),
		}),
	];
}

/** The client paginator rqo (PHP get_data): the component reads its own record. */
const getDataRqo = (limit: number, offset: number, lang = 'lg-nolan') => ({
	action: 'read',
	dd_api: 'dd_core_api',
	prevent_lock: true,
	source: {
		typo: 'source',
		type: 'component',
		action: 'get_data',
		model: 'component_portal',
		tipo: PORTAL,
		section_tipo: HOST,
		section_id: HOST_PAGED,
		mode: 'edit',
		lang,
	},
	sqo: {
		section_tipo: [TARGET],
		limit,
		offset,
		filter_by_locators: [{ section_tipo: HOST, section_id: HOST_PAGED }],
	},
});

/** The get_data response SUBJECT: hand-written, never read back off the engine. */
const getDataPortalItem = (offset: number, count: number, limit: number) =>
	surfaceOf({
		tipo: PORTAL,
		section_tipo: HOST,
		section_id: HOST_PAGED,
		mode: 'edit',
		lang: 'lg-nolan', // relation components are never translatable
		from_component_tipo: PORTAL,
		parent_tipo: PORTAL,
		entries: portalLocators(offset, count),
		pagination: { total: TARGET_COUNT, limit, offset },
	});

/** The subdatum blocks of a get_data page: rows anchor on the LOCATOR TARGET. */
const getDataSubdatum = (offset: number, count: number, requestLang: string) =>
	Array.from({ length: count }, (_, index) =>
		subdatumOf(offset + index, {
			rowAnchor: FIRST_TARGET + offset + index,
			callerTipo: PORTAL,
			requestLang,
		}),
	).flat();

describe('portal subdatum in EDIT mode — section read (contract a)', () => {
	test('own-config limit, FULL total, ordered subdatum, NESTED recursion', async () => {
		const { data } = await callRqo({
			action: 'read',
			dd_api: 'dd_core_api',
			prevent_lock: true,
			options: {},
			source: {
				typo: 'source',
				model: 'section',
				tipo: HOST,
				section_tipo: HOST,
				action: 'search',
				mode: 'edit',
				lang: 'lg-eng',
			},
			sqo: {
				section_tipo: [HOST],
				limit: 1,
				offset: 0,
				filter_by_locators: [{ section_tipo: HOST, section_id: HOST_SMALL }],
			},
			show: { ddo_map: [{ tipo: PORTAL, section_tipo: HOST, parent: HOST, mode: 'edit' }] },
		});

		// The `sections` envelope: the one searched record, outside the item surface.
		const sections = data[0] as Item;
		expect(sections.typo).toBe('sections');
		expect(sections.tipo).toBe(HOST);
		expect(sections.entries).toEqual([
			{ section_tipo: HOST, section_id: HOST_SMALL, paginated_key: 0 },
		] as never);

		// Then the portal item, then one subdatum block per paginated locator.
		const rows = rowsOf(data);
		expectSequence(rows, [
			surfaceOf({
				tipo: PORTAL,
				section_tipo: HOST,
				section_id: HOST_SMALL,
				mode: 'edit',
				lang: 'lg-nolan', // relation components are never translatable
				from_component_tipo: PORTAL,
				row_section_id: HOST_SMALL,
				parent_tipo: HOST,
				entries: portalLocators(0, 3),
				// The OWN request_config limit — LAST config item, sqo.limit over
				// its own sqo_config.limit — while total is the FULL locator count.
				pagination: { total: 3, limit: 9, offset: 0 },
			}),
			...[0, 1, 2].flatMap((index) =>
				subdatumOf(index, {
					// section read: children anchor on the OUTER record and parent
					// to the SECTION (the outer-subdatum re-stamp).
					rowAnchor: HOST_SMALL,
					callerTipo: HOST,
					requestLang: 'lg-eng',
				}),
			),
		]);
		// Non-vacuity floors: the block really is 6 items per locator and the
		// nested recursion really emitted its own child at every one of them.
		expect(rows.length).toBe(1 + 3 * 6);
		expect(rows.filter((item) => item.from_component_tipo === NESTED_PORTAL).length).toBe(3);
	}, 60000);
});

describe('portal subdatum in EDIT mode — get_data client paging (contract b)', () => {
	test('custom page, show-all clamp, over-ceiling clamp; rows anchor on the TARGET', async () => {
		for (const [limit, offset, expectedLimit] of [
			[2, 1, 2], // a custom client page
			[0, 0, CLIENT_CEILING], // show-all → ceiling clamp
			[5000, 0, CLIENT_CEILING], // over-ceiling → clamp
		] as [number, number, number][]) {
			const { data } = await callRqo(getDataRqo(limit, offset));
			// The response SUBJECT is not a subdatum row: no row_section_id AT ALL
			// (absent, which the surface below cannot tell from an explicit null).
			expect(Object.hasOwn(data[0] as object, 'row_section_id')).toBe(false);

			const pageSize = Math.min(expectedLimit, TARGET_COUNT - offset);
			expectSequence(data, [
				getDataPortalItem(offset, pageSize, expectedLimit),
				...getDataSubdatum(offset, pageSize, SESSION_DATA_LANG),
			]);
			expect(data.length).toBe(1 + pageSize * 6);
		}
	}, 60000);
});

describe('portal subdatum in EDIT mode — get_data context (contract c)', () => {
	test('portal + one entry per UNIQUE (tipo, section_tipo, mode) resolved', async () => {
		const { context } = await callRqo(getDataRqo(2, 0));
		const surface = context.map((entry) => ({
			tipo: entry.tipo,
			section_tipo: entry.section_tipo,
			model: entry.model,
			mode: entry.mode,
			parent: entry.parent,
			parent_grouper: entry.parent_grouper ?? null,
			view: entry.view ?? null,
		}));
		// The resolved tree: the portal + its 5 config children + the NESTED
		// portal's own child, in first-emission order.
		expect(surface).toEqual([
			{
				tipo: PORTAL,
				section_tipo: HOST,
				model: 'component_portal',
				mode: 'edit',
				parent: HOST,
				parent_grouper: HOST,
				view: 'default',
			},
			{
				tipo: 'zzpe4',
				section_tipo: TARGET,
				model: 'component_input_text',
				mode: 'edit',
				parent: PORTAL,
				parent_grouper: TARGET,
				view: null,
			},
			{
				tipo: NESTED_PORTAL,
				section_tipo: TARGET,
				model: 'component_portal',
				mode: 'list',
				parent: PORTAL,
				parent_grouper: TARGET,
				view: 'default',
			},
			{
				tipo: NESTED_CHILD,
				section_tipo: NESTED_SECTION,
				model: 'component_input_text',
				mode: 'list',
				// parented to its GENERATING component, not to the outer portal
				parent: NESTED_PORTAL,
				parent_grouper: NESTED_SECTION,
				view: null,
			},
			{
				tipo: 'zzpe5',
				section_tipo: TARGET,
				model: 'component_number',
				mode: 'list',
				parent: PORTAL,
				parent_grouper: TARGET,
				// the `view` declared on the GENERATING ddo
				view: 'line',
			},
			{
				tipo: 'zzpe9',
				section_tipo: TARGET,
				model: 'component_input_text',
				mode: 'list',
				parent: PORTAL,
				parent_grouper: TARGET,
				view: null,
			},
			{
				tipo: 'zzpe10',
				section_tipo: TARGET,
				model: 'component_text_area',
				mode: 'list',
				parent: PORTAL,
				// the ONTOLOGY parent (a section_group_div), not the emitting portal
				parent_grouper: 'zzpe11',
				view: null,
			},
		]);
	}, 60000);
});

describe('portal subdatum in EDIT mode — offset paging (contract d)', () => {
	test('window [offset, offset+limit), paginated_key continuity, FULL total', async () => {
		const { data } = await callRqo(getDataRqo(5, 5));
		expectSequence(data, [getDataPortalItem(5, 5, 5), ...getDataSubdatum(5, 5, SESSION_DATA_LANG)]);
		expect(data.length).toBe(1 + 5 * 6);
	}, 60000);
});

describe('portal subdatum in EDIT mode — instance lang (contract e)', () => {
	test('translatable children follow the request lang, the rest stay lg-nolan', async () => {
		const { data } = await callRqo(getDataRqo(2, 0, 'lg-eng'));
		expectSequence(data, [getDataPortalItem(0, 2, 2), ...getDataSubdatum(0, 2, 'lg-eng')]);
		// Both halves of read.ts:1864 under assertion in ONE response: the
		// translatable pair resolves in lg-eng, the non-translatable trio does
		// not follow it.
		const langOf = (tipo: string) => data.filter((item) => item.tipo === tipo).map((i) => i.lang);
		expect(langOf('zzpe4')).toEqual(['lg-eng', 'lg-eng']);
		expect(langOf('zzpe10')).toEqual(['lg-eng', 'lg-eng']);
		expect(langOf('zzpe5')).toEqual(['lg-nolan', 'lg-nolan']);
		expect(langOf('zzpe9')).toEqual(['lg-nolan', 'lg-nolan']);
		expect(langOf(NESTED_CHILD)).toEqual(['lg-nolan', 'lg-nolan']);
	}, 60000);
});
