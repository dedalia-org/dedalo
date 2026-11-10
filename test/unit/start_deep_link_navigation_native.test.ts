/**
 * A SECTION RECORD DEEP LINK REOPENS INSIDE ITS NAVIGATION —
 * WC-2026-11-09-start-deep-link-found-set-position.
 *
 * Every edit view carries `?tipo=X&mode=edit&id=N` in the address bar, so every
 * RELOAD is a deep link. `start` used to stamp `section_id` alone; the client
 * pinned that one record (build_rqo_show → filter_by_locators [N]) and the
 * paginator showed 1/1 — the user's found set and position were gone, and the
 * pinned read then OVERWROTE the stored found set in the session.
 *
 * Now `start` resolves the record's position (search/record_position.ts) and
 * ships the page view exactly as the list→edit navigation does: a `main`
 * request_config with the sqo + `section_id_selected`, no `section_id`.
 *
 *   1. stored found set holding the record → its sqo at the record's offset
 *      (cheap probe hit AND the numbered-scan path, under a DESC order);
 *   2. record outside the stored found set → the whole section, filter/order
 *      stated null so the session merge cannot leak the stored filter back in;
 *   3. a stored SINGLE PIN is not a found set → whole section;
 *   4. session_save=false / a viewer → the record stays pinned (section_id);
 *   5. the shipped sqo, READ, yields exactly the record (offset is truthful);
 *   6. a single-pin read never replaces the stored found set (read.ts).
 *
 * Situation: three test3 records created here and swept; the stored session
 * SQO is set per test on a synthetic (in-memory) session.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { type ApiRequestContext, dispatchRqo } from '../../src/core/api/dispatch.ts';
import type { Rqo } from '../../src/core/concepts/rqo.ts';
import { isFoundSetSqoOf, isSingleRecordPin } from '../../src/core/concepts/sqo.ts';
import { createSectionRecord } from '../../src/core/section/record/create_record.ts';
import { createSession, getSession, setSessionSqo } from '../../src/core/security/session_store.ts';
import { assertTestDatabase } from '../../src/core/test_data/test_database_marker.ts';
import { DB_READY } from '../helpers/db_ready.ts';
import { cleanScratchRecord } from '../helpers/test_data.ts';

const SECTION = 'test3';
const TEXT = 'test52'; // component_input_text — the standing generic component

const recordIds: number[] = [];

function freshContext(): ApiRequestContext {
	const token = createSession(-1, 'root', true);
	const session = getSession(token);
	return {
		requestId: 'deep-link-navigation-native',
		clientIp: '127.0.0.1',
		session,
		csrfCandidate: session?.csrfToken ?? null,
		principal: { userId: -1, isGlobalAdmin: true, isDeveloper: true },
	};
}

function pinsOf(ids: number[]): { section_tipo: string; section_id: number }[] {
	return ids.map((section_id) => ({ section_tipo: SECTION, section_id }));
}

async function startEntry(
	search_obj: Record<string, unknown>,
	context: ApiRequestContext,
): Promise<Record<string, unknown>> {
	const outcome = await dispatchRqo(
		{
			action: 'start',
			dd_api: 'dd_core_api',
			prevent_lock: true,
			options: { search_obj, menu: false },
		} as Rqo,
		context,
	);
	expect(outcome.status).toBe(200);
	const entry = (outcome.body.data as { context: Record<string, unknown>[] }).context.find(
		(item) => item.tipo === SECTION,
	);
	expect(entry).toBeDefined();
	return entry as Record<string, unknown>;
}

function navigationSqoOf(entry: Record<string, unknown>): Record<string, unknown> {
	const requestConfig = entry.request_config as
		| { api_engine?: string; type?: string; sqo?: Record<string, unknown> }[]
		| undefined;
	const main = requestConfig?.find((item) => item.api_engine === 'dedalo' && item.type === 'main');
	expect(main?.sqo).toBeDefined();
	return main?.sqo as Record<string, unknown>;
}

/** Read `sqo` as the edit view would (session_save off: the probe must not move the session). */
async function readIds(
	sqo: Record<string, unknown>,
	context: ApiRequestContext,
): Promise<number[]> {
	const outcome = await dispatchRqo(
		{
			action: 'read',
			dd_api: 'dd_core_api',
			source: {
				action: 'search',
				model: 'section',
				tipo: SECTION,
				section_tipo: SECTION,
				mode: 'edit',
				lang: 'lg-spa',
				session_save: false,
			},
			sqo: structuredClone(sqo),
		} as unknown as Rqo,
		context,
	);
	expect(outcome.status).toBe(200);
	const data = (
		outcome.body.data as { data: { typo?: string; entries?: { section_id: number }[] }[] }
	).data;
	return (data.find((item) => item.typo === 'sections')?.entries ?? []).map((entry) =>
		Number(entry.section_id),
	);
}

/** Save `value` into the record's test52 (lg-spa — the lang the order reads) through the client's own save rqo. */
async function saveText(
	sectionId: number,
	value: string,
	context: ApiRequestContext,
): Promise<void> {
	const item = { id: 1, lang: 'lg-spa', value };
	const outcome = await dispatchRqo(
		{
			action: 'save',
			dd_api: 'dd_core_api',
			prevent_lock: true,
			source: {
				typo: 'source',
				type: 'component',
				model: 'component_input_text',
				tipo: TEXT,
				section_tipo: SECTION,
				section_id: String(sectionId),
				mode: 'edit',
				lang: 'lg-spa',
				action: null,
			},
			data: {
				section_id: String(sectionId),
				section_tipo: SECTION,
				tipo: TEXT,
				lang: 'lg-spa',
				from_component_tipo: TEXT,
				value: [item],
				changed_data: [{ action: 'set_data', key: null, value: [item] }],
			},
		} as unknown as Rqo,
		context,
	);
	expect(outcome.status).toBe(200);
}

describe.if(DB_READY)('start: a section record deep link reopens inside its navigation', () => {
	beforeAll(async () => {
		await assertTestDatabase('start_deep_link_navigation_native');
		for (let index = 0; index < 3; index++) {
			recordIds.push(await createSectionRecord(SECTION, -1));
		}
		// Sort keys that reorder the records against their id order: m, a, z.
		const context = freshContext();
		for (const [index, value] of ['m', 'a', 'z'].entries()) {
			await saveText(recordIds[index] as number, value, context);
		}
	});

	afterAll(async () => {
		for (const id of recordIds) await cleanScratchRecord(SECTION, id);
	});

	test('stored found set, stored offset still names the record → same offset (probe hit)', async () => {
		// The situation floor: every case below reads the three records built here.
		expect(recordIds).toHaveLength(3);
		const context = freshContext();
		const [, middle] = recordIds as [number, number, number];
		setSessionSqo(context.session!, SECTION, {
			section_tipo: [SECTION],
			filter_by_locators: pinsOf(recordIds),
			limit: 1,
			offset: 1,
		});
		const entry = await startEntry({ tipo: SECTION, mode: 'edit', id: String(middle) }, context);
		expect(entry.mode).toBe('edit');
		expect(entry.section_id).toBeUndefined();
		expect(entry.section_id_selected).toBe(middle);
		const sqo = navigationSqoOf(entry);
		expect(sqo.offset).toBe(1);
		expect(sqo.limit).toBe(1);
		expect(sqo.filter_by_locators).toEqual(pinsOf(recordIds));
		expect(await readIds(sqo, context)).toEqual([middle]);
	});

	test('stored found set under a DESC order, stale offset → the numbered scan finds it', async () => {
		const context = freshContext();
		const [first] = recordIds as [number, number, number];
		setSessionSqo(context.session!, SECTION, {
			section_tipo: [SECTION],
			filter_by_locators: pinsOf(recordIds),
			order: [{ direction: 'DESC', path: [{ component_tipo: 'section_id' }] }],
			limit: 10,
			offset: 0,
		});
		const entry = await startEntry({ tipo: SECTION, mode: 'edit', id: String(first) }, context);
		const sqo = navigationSqoOf(entry);
		// DESC over three ascending ids: the smallest is the LAST row.
		expect(sqo.offset).toBe(2);
		expect(sqo.limit).toBe(1);
		expect(await readIds(sqo, context)).toEqual([first]);
	});

	test('record outside the stored found set → the whole section, filter and order stated null', async () => {
		const context = freshContext();
		const [first, middle, last] = recordIds as [number, number, number];
		setSessionSqo(context.session!, SECTION, {
			section_tipo: [SECTION],
			filter_by_locators: pinsOf([first, middle]),
			limit: 1,
			offset: 0,
		});
		const entry = await startEntry({ tipo: SECTION, mode: 'edit', id: String(last) }, context);
		const sqo = navigationSqoOf(entry);
		expect(sqo.filter_by_locators).toEqual([]);
		expect(sqo).toHaveProperty('filter', null);
		expect(sqo).toHaveProperty('order', null);
		expect(typeof sqo.offset).toBe('number');
		// The offset is TRUTHFUL over the whole section, read the way the client reads it.
		expect(await readIds(sqo, context)).toEqual([last]);
	});

	test('no stored found set → the whole section', async () => {
		const context = freshContext();
		const [, middle] = recordIds as [number, number, number];
		const entry = await startEntry({ tipo: SECTION, mode: 'edit', id: String(middle) }, context);
		const sqo = navigationSqoOf(entry);
		expect(sqo.filter_by_locators).toEqual([]);
		expect(await readIds(sqo, context)).toEqual([middle]);
	});

	test('a stored SINGLE PIN is a record view, not a found set → ignored', async () => {
		const context = freshContext();
		const [first] = recordIds as [number, number, number];
		setSessionSqo(context.session!, SECTION, {
			section_tipo: [SECTION],
			filter_by_locators: pinsOf([first]),
			limit: 1,
			offset: 0,
		});
		// Linking the PINNED record itself: were the pin taken as a found set, the
		// answer would be that pin at offset 0 — a 1/1 navigation again.
		const entry = await startEntry({ tipo: SECTION, mode: 'edit', id: String(first) }, context);
		const sqo = navigationSqoOf(entry);
		expect(sqo.filter_by_locators).toEqual([]);
		expect(await readIds(sqo, context)).toEqual([first]);
	});

	test('a COMPONENT sort with a stale offset → the scan follows the read order, not the id order', async () => {
		const context = freshContext();
		const [first, middle, last] = recordIds as [number, number, number];
		// values m, a, z → ASC order: middle (a), first (m), last (z)
		const order = [{ direction: 'ASC', path: [{ section_tipo: SECTION, component_tipo: TEXT }] }];
		for (const [record, expected] of [
			[first, 1],
			[last, 2],
			[middle, 0],
		] as const) {
			setSessionSqo(context.session!, SECTION, {
				section_tipo: [SECTION],
				filter_by_locators: pinsOf(recordIds),
				order,
				limit: 1,
				offset: (expected + 1) % 3, // stale: names a neighbour, forcing the scan
			});
			const entry = await startEntry({ tipo: SECTION, mode: 'edit', id: String(record) }, context);
			const sqo = navigationSqoOf(entry);
			expect(sqo.offset).toBe(expected);
			expect(await readIds(sqo, context)).toEqual([record]);
		}
	});

	test('an UNBUILDABLE stored SQO (a removed tipo) falls back to the whole section, the page boots', async () => {
		const context = freshContext();
		const [, middle] = recordIds as [number, number, number];
		setSessionSqo(context.session!, SECTION, {
			section_tipo: [SECTION],
			filter: {
				$and: [{ q: ['x'], path: [{ section_tipo: SECTION, component_tipo: 'test999999' }] }],
			},
			limit: 1,
			offset: 0,
		});
		const entry = await startEntry({ tipo: SECTION, mode: 'edit', id: String(middle) }, context);
		const sqo = navigationSqoOf(entry);
		expect(sqo).toHaveProperty('filter', null);
		expect(await readIds(sqo, context)).toEqual([middle]);
	});

	test('an id that names no record has no position (pinned, no scan)', async () => {
		const context = freshContext();
		const entry = await startEntry({ tipo: SECTION, mode: 'edit', id: '2147483000' }, context);
		expect(entry.section_id).toBe(2147483000);
		expect(entry.request_config).toBeUndefined();
	});

	test('a component deep link is not a section navigation (keeps its section_id)', async () => {
		const context = freshContext();
		const [first] = recordIds as [number, number, number];
		const outcome = await dispatchRqo(
			{
				action: 'start',
				dd_api: 'dd_core_api',
				prevent_lock: true,
				options: {
					search_obj: { tipo: TEXT, section_tipo: SECTION, id: String(first), mode: 'edit' },
					menu: false,
				},
			} as Rqo,
			context,
		);
		const entry = (outcome.body.data as { context: Record<string, unknown>[] }).context.find(
			(item) => item.tipo === TEXT,
		);
		expect(entry?.section_id).toBe(first);
		expect(entry?.request_config).toBeUndefined();
	});

	test('session_save=false keeps the record pinned (section_id, no navigation)', async () => {
		const context = freshContext();
		const [first] = recordIds as [number, number, number];
		const entry = await startEntry(
			{ tipo: SECTION, mode: 'edit', id: String(first), session_save: 'false' },
			context,
		);
		expect(entry.section_id).toBe(first);
		expect(entry.section_id_selected).toBeUndefined();
		expect(entry.request_config).toBeUndefined();
	});

	test('a viewer deep link keeps the record pinned', async () => {
		const context = freshContext();
		const [first] = recordIds as [number, number, number];
		const entry = await startEntry(
			{ tipo: SECTION, mode: 'edit', id: String(first), view: 'viewer' },
			context,
		);
		expect(entry.section_id).toBe(first);
		expect(entry.request_config).toBeUndefined();
	});

	test('a single-pin read never replaces the stored found set', async () => {
		const context = freshContext();
		const [first, middle] = recordIds as [number, number, number];
		const foundSet = {
			section_tipo: [SECTION],
			filter_by_locators: pinsOf(recordIds),
			limit: 1,
			offset: 2,
		};
		setSessionSqo(context.session!, SECTION, structuredClone(foundSet));
		const pinRead = await dispatchRqo(
			{
				action: 'read',
				dd_api: 'dd_core_api',
				source: {
					action: 'search',
					model: 'section',
					tipo: SECTION,
					section_tipo: SECTION,
					mode: 'edit',
					lang: 'lg-spa',
					session_save: true,
				},
				sqo: { section_tipo: [SECTION], filter_by_locators: pinsOf([first]), limit: 1, offset: 0 },
			} as unknown as Rqo,
			context,
		);
		expect(pinRead.status).toBe(200);
		expect(context.session?.sqoSession?.[SECTION]).toEqual(foundSet);

		// Non-vacuity: a PAGE VIEW read with session_save does replace it.
		const pageRead = await dispatchRqo(
			{
				action: 'read',
				dd_api: 'dd_core_api',
				source: {
					action: 'search',
					model: 'section',
					tipo: SECTION,
					section_tipo: SECTION,
					mode: 'edit',
					lang: 'lg-spa',
					session_save: true,
				},
				sqo: {
					section_tipo: [SECTION],
					filter_by_locators: pinsOf([first, middle]),
					limit: 1,
					offset: 1,
				},
			} as unknown as Rqo,
			context,
		);
		expect(pageRead.status).toBe(200);
		const stored = context.session?.sqoSession?.[SECTION] as Record<string, unknown>;
		expect(stored.offset).toBe(1);
		expect(stored.filter_by_locators).toEqual(pinsOf([first, middle]));
	});
});

describe('record_position predicates (the client is_pinned_record_view rule)', () => {
	test('one locator is a record pin; two are a result set; TM is neither', () => {
		expect(isSingleRecordPin({ filter_by_locators: pinsOf([1]) })).toBe(true);
		expect(isSingleRecordPin({ filter_by_locators: pinsOf([1, 2]) })).toBe(false);
		expect(isSingleRecordPin({ filter_by_locators: [] })).toBe(false);
		expect(isSingleRecordPin({ mode: 'tm', filter_by_locators: pinsOf([1]) })).toBe(false);
		expect(isSingleRecordPin(null)).toBe(false);
	});

	test('a found set is a page view of exactly this section', () => {
		expect(isFoundSetSqoOf({ section_tipo: [SECTION] }, SECTION)).toBe(true);
		expect(
			isFoundSetSqoOf({ section_tipo: SECTION, filter_by_locators: pinsOf([1, 2]) }, SECTION),
		).toBe(true);
		expect(
			isFoundSetSqoOf({ section_tipo: [SECTION], filter_by_locators: pinsOf([1]) }, SECTION),
		).toBe(false);
		expect(isFoundSetSqoOf({ section_tipo: ['test2'] }, SECTION)).toBe(false);
		expect(isFoundSetSqoOf({ section_tipo: [SECTION, 'test2'] }, SECTION)).toBe(false);
		expect(isFoundSetSqoOf({ section_tipo: [SECTION], mode: 'tm' }, SECTION)).toBe(false);
		expect(isFoundSetSqoOf({ section_tipo: [SECTION], children_recursive: true }, SECTION)).toBe(
			false,
		);
		expect(isFoundSetSqoOf([], SECTION)).toBe(false);
	});
});
