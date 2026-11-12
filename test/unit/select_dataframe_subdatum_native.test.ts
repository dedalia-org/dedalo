/**
 * SELECT + DATAFRAME — a component_select whose request_config declares a
 * component_dataframe slot emits, AFTER its own item, one frame item per stored
 * item (+ the frame's children) and their context entries
 * (WC-2026-11-12-select-dataframe-subdatum; T1-8 / O02).
 *
 * WHY THIS FILE EXISTS. PHP component_select_json (frozen v7 :196-234, v6
 * :90-108) appends `get_subdatum($tipo, $value)` restricted to the dataframe
 * ddo of `request_config[0].show.ddo_map` in its `case 'edit': default:` arm.
 * The TS select-family resolver pushed ONE item and nothing else, so the
 * client's get_dataframe (component_common/js/dataframe.js) found no frame
 * context and the widget never rendered — frames could be neither seen nor
 * created from the select (the vendored carrier: numisdata291 → numisdata872).
 *
 * OUTCOMES pinned (each with a floor so it cannot pass vacuously):
 *  1. get_data edit: a SLOT item paired to the stored item (id_key INT,
 *     main_component_tipo SEL) with its frame entries, the frame child at its
 *     target, the SEL item first and unchanged;
 *  2. its context carries SLOT (at the host section) and the frame child;
 *  3. section edit read: the CLIENT predicate (dataframe.js) finds slot ddo,
 *     data and context;
 *  4. an item without frame → empty SLOT item (the widget's blank slot);
 *  5. a legacy multi-item value → one SLOT item per item, no cross-pairing;
 *  6. save echo of a first pick carries the SLOT context + empty item at the
 *     new entry's id;
 *  7. guards: list / search / empty value / a select without slot → no frame.
 *
 * SITUATION: `zzsdf` scratch sections (→ matrix_test), swept in afterAll
 * (records, TM, activity); the situation drop asserts zero residue.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { dispatchRqo } from '../../src/core/api/dispatch.ts';
import { sql } from '../../src/core/db/postgres.ts';
import { clearOntologyDerivedCaches } from '../../src/core/ontology/cache_invalidation.ts';
import { resolvePrincipal } from '../../src/core/security/permissions.ts';
import { createSession, getSession } from '../../src/core/security/session_store.ts';
import {
	dropSituation,
	ensureSituation,
	situation,
} from '../../src/core/test_data/situations/situation.ts';
import { assertTestDatabase } from '../../src/core/test_data/test_database_marker.ts';
import { registerSessionCleanup } from '../helpers/session_cleanup.ts';

registerSessionCleanup();

const TLD = 'zzsdf';
const HOST = `${TLD}1`; // host section
const SEL = `${TLD}2`; // component_select, declares SLOT
const SLOT = `${TLD}3`; // component_dataframe
const FRAME = `${TLD}4`; // frame target section
const RATING = `${TLD}5`; // frame child (component_input_text in FRAME)
const OPT = `${TLD}6`; // option section
const LABEL = `${TLD}7`; // option label
const SEL_PLAIN = `${TLD}8`; // component_select WITHOUT slot

const self = { parent: 'self', section_tipo: 'self' } as const;
const pick = (id: number, optionId: number, from = SEL) => ({
	id,
	type: 'dd151',
	section_tipo: OPT,
	section_id: optionId,
	from_component_tipo: from,
});
const frame = (id: number, idKey: number, frameId: number) => ({
	id,
	type: 'dd490',
	id_key: idKey,
	section_tipo: FRAME,
	section_id: frameId,
	from_component_tipo: SLOT,
	main_component_tipo: SEL,
});
const selConfig = (withSlot: boolean) => ({
	source: {
		request_config: [
			{
				sqo: { section_tipo: [{ value: [OPT], source: 'section' }] },
				show: {
					ddo_map: [
						{ tipo: LABEL, ...self },
						// The numisdata291 shape: the slot names the HOST section.
						...(withSlot
							? [{ tipo: SLOT, parent: 'self', section_tipo: HOST, view: 'default' }]
							: []),
					],
				},
			},
		],
	},
});

const SITUATION = situation({
	tld: TLD,
	name: 'select_dataframe_subdatum',
	nodes: [
		{ tipo: HOST, parent: 'test1', model: 'section', term: { 'lg-eng': 'Host' } },
		{
			tipo: SEL,
			parent: HOST,
			model: 'component_select',
			term: { 'lg-eng': 'Select' },
			properties: selConfig(true),
		},
		{
			tipo: SLOT,
			parent: SEL,
			model: 'component_dataframe',
			term: { 'lg-eng': 'Slot' },
			properties: {
				source: {
					request_config: [
						{
							sqo: { section_tipo: [{ value: [FRAME], source: 'section' }] },
							show: {
								ddo_map: [{ tipo: RATING, mode: 'edit', ...self }],
								sqo_config: { limit: 1 },
							},
						},
					],
				},
			},
		},
		{
			tipo: SEL_PLAIN,
			parent: HOST,
			model: 'component_select',
			term: { 'lg-eng': 'Plain select' },
			properties: selConfig(false),
		},
		{ tipo: FRAME, parent: 'test1', model: 'section', term: { 'lg-eng': 'Frame' } },
		{ tipo: RATING, parent: FRAME, model: 'component_input_text', term: { 'lg-eng': 'Rating' } },
		{ tipo: OPT, parent: 'test1', model: 'section', term: { 'lg-eng': 'Options' } },
		{ tipo: LABEL, parent: OPT, model: 'component_input_text', term: { 'lg-eng': 'Label' } },
	],
	records: [
		...[1, 2].map((id) => ({
			section_tipo: OPT,
			section_id: id,
			columns: { string: { [LABEL]: [{ id: 1, lang: 'lg-nolan', value: `option ${id}` }] } },
		})),
		...[1, 2].map((id) => ({
			section_tipo: FRAME,
			section_id: id,
			columns: { string: { [RATING]: [{ id: 1, lang: 'lg-nolan', value: `sure ${id}` }] } },
		})),
		{
			section_tipo: HOST,
			section_id: 1,
			columns: {
				relation: {
					[SEL]: [pick(1, 1)],
					[SLOT]: [frame(1, 1, 1)],
					[SEL_PLAIN]: [pick(1, 1, SEL_PLAIN)],
				},
			},
		},
		{ section_tipo: HOST, section_id: 2, columns: { relation: { [SEL]: [pick(1, 1)] } } },
		{ section_tipo: HOST, section_id: 3 }, // the save test's first pick
		{ section_tipo: HOST, section_id: 5 }, // stays empty
		{
			section_tipo: HOST,
			section_id: 4,
			columns: {
				relation: {
					[SEL]: [pick(1, 1), pick(2, 2)],
					[SLOT]: [frame(1, 1, 1), frame(2, 2, 2)],
				},
			},
		},
	],
});

type Item = Record<string, unknown> & {
	tipo?: string;
	section_tipo?: string;
	section_id?: unknown;
	entries?: unknown;
	typo?: string;
};
type Ctx = Record<string, unknown> & { tipo?: string; section_tipo?: string; model?: string };

let tsContext: Record<string, unknown>;

async function callRqo(rqo: unknown): Promise<{ data: Item[]; context: Ctx[] }> {
	const body = (await dispatchRqo(structuredClone(rqo) as never, tsContext as never)).body as {
		ok?: boolean;
		error?: unknown;
		data?: { data?: Item[]; context?: Ctx[] } | Item[];
		context?: Ctx[];
	};
	expect(body.error ?? null).toBeNull();
	expect(body.ok).not.toBe(false);
	if (Array.isArray(body.data)) return { data: body.data, context: body.context ?? [] };
	return { data: body.data?.data ?? [], context: body.data?.context ?? body.context ?? [] };
}

const getData = (sectionId: number, mode = 'edit', tipo = SEL) =>
	callRqo({
		action: 'read',
		dd_api: 'dd_core_api',
		prevent_lock: true,
		source: {
			typo: 'source',
			type: 'component',
			action: 'get_data',
			model: 'component_select',
			tipo,
			section_tipo: HOST,
			section_id: sectionId,
			mode,
			lang: 'lg-nolan',
		},
	});

const slotItems = (data: Item[]) => data.filter((item) => item.tipo === SLOT);
const entryIds = (entries: unknown) =>
	(Array.isArray(entries) ? (entries as { section_tipo: string; section_id: unknown }[]) : []).map(
		(entry) => `${entry.section_tipo}/${String(entry.section_id)}`,
	);

beforeAll(async () => {
	await assertTestDatabase('select_dataframe_subdatum_native');
	await ensureSituation(SITUATION);
	await clearOntologyDerivedCaches();
	const token = createSession(-1, 'root', true);
	const session = getSession(token);
	tsContext = {
		requestId: 'select-dataframe-subdatum',
		clientIp: '127.0.0.1',
		session,
		csrfCandidate: session?.csrfToken ?? null,
		principal: await resolvePrincipal(-1),
	};
}, 60_000);

afterAll(async () => {
	await sql.unsafe(
		`DELETE FROM matrix_activity
		  WHERE section_tipo = 'dd542'
		    AND misc->'dd551'->0->'value'->>'section_tipo' LIKE $1`,
		[`${TLD}%`],
	);
	expect(await dropSituation(SITUATION)).toBe(0);
	await clearOntologyDerivedCaches();
});

describe('get_data edit of a select declaring a dataframe slot', () => {
	test('emits the paired frame item + the frame child after the select item', async () => {
		const { data, context } = await getData(1);
		// The select item is FIRST and keeps its value + datalist.
		expect(data[0]?.tipo).toBe(SEL);
		expect(entryIds(data[0]?.entries)).toEqual([`${OPT}/1`]);
		expect(Array.isArray(data[0]?.datalist)).toBe(true);
		const slots = slotItems(data);
		expect(slots.length).toBe(1); // FLOOR
		const slot = slots[0] as Item;
		expect(slot.section_tipo).toBe(HOST);
		expect(Number(slot.section_id)).toBe(1);
		expect(slot.id_key).toBe(1);
		expect(slot.main_component_tipo).toBe(SEL);
		expect(slot.from_component_tipo).toBe(SEL);
		expect(entryIds(slot.entries)).toEqual([`${FRAME}/1`]);
		expect((slot.pagination as { total?: number }).total).toBe(1);
		const rating = data.find((item) => item.tipo === RATING);
		expect(rating?.section_tipo).toBe(FRAME);
		expect(Number(rating?.section_id)).toBe(1);
		expect(rating?.from_component_tipo).toBe(SLOT);
		expect(JSON.stringify(rating?.entries)).toContain('sure 1');
		// Contexts of the frame and its child.
		expect(
			context.find((entry) => entry.tipo === SLOT && entry.section_tipo === HOST),
		).toBeDefined();
		expect(context.find((entry) => entry.tipo === RATING)).toBeDefined();
	});

	test('an item without frame → an EMPTY slot item at its id (the blank widget)', async () => {
		const slots = slotItems((await getData(2)).data);
		expect(slots.length).toBe(1);
		expect(slots[0]?.id_key).toBe(1);
		expect(slots[0]?.entries).toEqual([]);
		expect((slots[0]?.pagination as { total?: number }).total).toBe(0);
	});

	test('a multi-item value → one slot item per item, no cross-pairing', async () => {
		const slots = slotItems((await getData(4)).data);
		expect(
			slots.map((item) => `${String(item.id_key)}:${entryIds(item.entries).join(',')}`),
		).toEqual([`1:${FRAME}/1`, `2:${FRAME}/2`]);
	});
});

describe('section edit read — the client get_dataframe predicate', () => {
	test('slot ddo, frame data and frame context are all found', async () => {
		const { data, context } = await callRqo({
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
				filter_by_locators: [{ section_tipo: HOST, section_id: 1 }],
			},
		});
		// dataframe.js:174 — the slot ddo from the main's context request_config.
		const selContext = context.find((entry) => entry.tipo === SEL) as
			| { request_config?: { show?: { ddo_map?: Ctx[] } }[] }
			| undefined;
		const slotDdo = selContext?.request_config?.[0]?.show?.ddo_map?.find(
			(ddo) => ddo.model === 'component_dataframe',
		);
		expect(slotDdo?.tipo).toBe(SLOT);
		const selItem = data.find((item) => item.tipo === SEL);
		const firstId = (selItem?.entries as { id: number }[] | undefined)?.[0]?.id;
		expect(firstId).toBe(1);
		// dataframe.js:223 — the frame item.
		const frameItem = data.find(
			(item) =>
				item.tipo === slotDdo?.tipo &&
				item.section_tipo === slotDdo?.section_tipo &&
				Number.parseInt(String(item.section_id), 10) === 1 &&
				Number.parseInt(String(item.id_key), 10) === firstId &&
				item.main_component_tipo === SEL,
		);
		expect(frameItem).toBeDefined();
		// dataframe.js:256 — the frame context.
		expect(
			context.find(
				(entry) => entry.tipo === slotDdo?.tipo && entry.section_tipo === slotDdo?.section_tipo,
			),
		).toBeDefined();
	});
});

describe('save echo of a first pick', () => {
	test('carries the slot context and an empty slot item at the new entry id', async () => {
		const { data, context } = await callRqo({
			action: 'save',
			dd_api: 'dd_core_api',
			prevent_lock: true,
			source: {
				typo: 'source',
				type: 'component',
				model: 'component_select',
				tipo: SEL,
				section_tipo: HOST,
				section_id: '3',
				mode: 'edit',
				lang: 'lg-nolan',
				action: null,
			},
			data: {
				section_id: '3',
				section_tipo: HOST,
				tipo: SEL,
				lang: 'lg-nolan',
				from_component_tipo: SEL,
				changed_data: [
					{
						action: 'insert',
						id: null,
						value: { type: 'dd151', section_tipo: OPT, section_id: 2, from_component_tipo: SEL },
					},
				],
			},
		});
		const selItem = data.find((item) => item.tipo === SEL);
		const newId = (selItem?.entries as { id: number }[] | undefined)?.[0]?.id;
		expect(typeof newId).toBe('number'); // FLOOR: the pick was stored
		const slots = slotItems(data);
		expect(slots.length).toBe(1);
		expect(slots[0]?.id_key).toBe(newId as number);
		expect(slots[0]?.entries).toEqual([]);
		expect(
			context.find((entry) => entry.tipo === SLOT && entry.section_tipo === HOST),
		).toBeDefined();
	});
});

describe('guards — no frame where PHP emitted none', () => {
	test('list mode: labels only', async () => {
		const { data } = await getData(1, 'list');
		expect(data.map((item) => item.tipo)).toEqual([SEL]);
	});
	test('search mode: no slot item', async () => {
		const { data } = await getData(1, 'search');
		expect(data.some((item) => item.tipo === SEL)).toBe(true);
		expect(slotItems(data)).toEqual([]);
	});
	test('an EMPTY select: its own empty item, no slot item', async () => {
		const { data } = await getData(5, 'edit');
		expect(data.map((item) => item.tipo)).toEqual([SEL]);
		expect(data[0]?.entries).toEqual([]);
	});
	test('a select without slot: its own item only', async () => {
		const { data } = await getData(1, 'edit', SEL_PLAIN);
		expect(data.map((item) => item.tipo)).toEqual([SEL_PLAIN]);
		expect(entryIds(data[0]?.entries)).toEqual([`${OPT}/1`]);
	});
});
