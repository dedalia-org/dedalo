/**
 * component_relation_related LIST cells expand the declared show.ddo_map
 * children (WC-2026-11-10-related-list-cells).
 *
 * Before: the list branch of relations/models/relation_related.ts emitted, per
 * stored locator, the TARGET section's component_section_id item instead of
 * the children of the column's request_config show.ddo_map. The client (the
 * relation_related renderer is component_portal's) builds its columns from
 * that ddo_map, found no data and painted a BLANK cell — in section lists, in
 * the Time Machine (dd15) history list and in nested portal cells. List now
 * takes the portal path like every other non-search mode.
 *
 * Legs: the list cell carries a test52 item with the TARGET's value for each
 * locator; the own item keeps entries + pagination; an EMPTY test54 still
 * emits its own (empty) item; the dd15 history cell for test54 carries the
 * child value too; a legacy STRING section_id locator renders (canonicalized
 * by expandPortal); a non-address remote id ('001338683', the external-target
 * shape) is never dropped: it stays verbatim in the own item's entries and
 * gets no child (nothing stored to render — a true external target renders
 * through component_external ddos, gated in external_degradation_native; the
 * `test` TLD's test54 map declares no external section, so that leg cannot be
 * built on test54 itself).
 *
 * Structure: repo-owned `test` TLD nodes only (test54 on test3, list map →
 * test52). Records: scratch test3 rows allocated through createSectionRecord,
 * TM rows minted through the single TM writer; all swept in afterAll.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { recordTimeMachine } from '../../src/core/db/time_machine.ts';
import { readTimeMachineData, TM_SUBJECT_CELL_LIMIT } from '../../src/core/resolve/read_tm.ts';
import { runWithRequestLangs } from '../../src/core/resolve/request_lang.ts';
import { readSection } from '../../src/core/section/read.ts';
import { createSectionRecord } from '../../src/core/section/record/create_record.ts';
import { assertTestDatabase } from '../../src/core/test_data/test_database_marker.ts';
import { DB_READY } from '../helpers/db_ready.ts';
import { cleanScratchRecord, createScratchRecord } from '../helpers/test_data.ts';

const SECTION = 'test3';
const RELATED = 'test54'; // component_relation_related; list map shows test52
const CHILD = 'test52'; // component_input_text (translatable)
const LANG = 'lg-spa';
const REMOTE_ID = '001338683';

type Item = Record<string, unknown>;

const ids = { alpha: 0, beta: 0, subject: 0, empty: 0, wide: 0 };

const locator = (sectionId: number | string, id: number): Item => ({
	id,
	type: 'dd89',
	section_tipo: SECTION,
	section_id: sectionId,
	from_component_tipo: RELATED,
});

const inLang = <T>(fn: () => Promise<T>): Promise<T> =>
	runWithRequestLangs({ applicationLang: LANG, dataLang: LANG }, fn);

/** The cell page size: the default list cell pages to ONE locator (PORTAL_LIST_LIMIT). */
function listRqo(sectionId: number, limit?: number): never {
	return {
		action: 'read',
		source: { action: null, model: 'section', tipo: SECTION, section_tipo: SECTION, mode: 'list' },
		sqo: {
			section_tipo: [SECTION],
			limit: 1,
			offset: 0,
			filter_by_locators: [{ section_tipo: SECTION, section_id: sectionId }],
		},
		show: {
			ddo_map: [
				{
					tipo: RELATED,
					section_tipo: SECTION,
					parent: SECTION,
					mode: 'list',
					...(limit === undefined ? {} : { limit }),
				},
			],
		},
	} as never;
}

/** The own test54 item of one record. */
function ownItem(data: Item[], sectionId: number): Item {
	const found = data.filter(
		(item) => item.tipo === RELATED && Number(item.section_id) === sectionId,
	);
	expect(found, `exactly one ${RELATED} item for ${sectionId}`).toHaveLength(1);
	return found[0] as Item;
}

/** The plain-text value(s) of the test52 child item(s) emitted for one target. */
function childValues(data: Item[], targetId: number): string[] {
	return data
		.filter((item) => item.tipo === CHILD && Number(item.section_id) === targetId)
		.flatMap((item) => (item.entries ?? item.value ?? []) as Item[])
		.map((entry) => String(entry.value));
}

describe.if(DB_READY)('relation_related list cells render the declared children', () => {
	beforeAll(async () => {
		await assertTestDatabase('relation_related_list_cells_native');
		for (const key of Object.keys(ids) as (keyof typeof ids)[]) {
			ids[key] = await createSectionRecord(SECTION, -1);
		}
		await createScratchRecord(SECTION, ids.alpha, {
			string: { [CHILD]: [{ id: 1, lang: LANG, value: 'target alpha' }] },
		});
		await createScratchRecord(SECTION, ids.beta, {
			string: { [CHILD]: [{ id: 1, lang: LANG, value: 'target beta' }] },
		});
		const stored = [
			locator(ids.alpha, 1),
			// Legacy string form of a matrix address (unswept rows still hold it).
			locator(String(ids.beta), 2),
			// A non-address remote id (the external-target shape): no stored row.
			locator(REMOTE_ID, 3),
		];
		await createScratchRecord(SECTION, ids.subject, { relation: { [RELATED]: stored } });
		await createScratchRecord(SECTION, ids.empty, {});
		// A history row wider than the TM subject cap (11 > TM_SUBJECT_CELL_LIMIT).
		await createScratchRecord(SECTION, ids.wide, {});
		await recordTimeMachine(
			{
				sectionTipo: SECTION,
				sectionId: ids.wide,
				componentTipo: RELATED,
				lang: 'lg-nolan',
				userId: -1,
				data: Array.from({ length: 11 }, (_, i) => locator(ids.alpha, i + 1)),
			},
			'2026-11-10 10:00:00',
		);
		await recordTimeMachine(
			{
				sectionTipo: SECTION,
				sectionId: ids.subject,
				componentTipo: RELATED,
				lang: 'lg-nolan',
				userId: -1,
				data: stored,
			},
			'2026-11-10 10:00:00',
		);
	}, 120000);

	afterAll(async () => {
		for (const id of Object.values(ids)) if (id > 0) await cleanScratchRecord(SECTION, id);
	}, 120000);

	test('list cell: one test52 item per PAGED locator, carrying the TARGET value', async () => {
		const { data } = await inLang(() => readSection(listRqo(ids.subject, 10)));
		const items = data as Item[];
		expect(childValues(items, ids.alpha)).toEqual(['target alpha']);
		// The legacy string locator renders too (canonicalized address).
		expect(childValues(items, ids.beta)).toEqual(['target beta']);
		// The old list branch's section_id subdatum is gone.
		// Every item at a target is a declared child (the old branch emitted the
		// target's section_id component item there instead).
		const atTargets = items.filter((item) =>
			[ids.alpha, ids.beta].includes(Number(item.section_id)),
		);
		expect(new Set(atTargets.map((item) => item.tipo))).toEqual(new Set([CHILD]));
	});

	test('list cell: the default cell pages to one locator, total counts all', async () => {
		const { data } = await inLang(() => readSection(listRqo(ids.subject)));
		const own = ownItem(data as Item[], ids.subject);
		expect(((own.entries ?? own.value) as Item[]).map((entry) => entry.section_id)).toEqual([
			ids.alpha,
		]);
		expect(own.pagination).toMatchObject({ total: 3, limit: 1, offset: 0 });
		expect(childValues(data as Item[], ids.alpha)).toEqual(['target alpha']);
		expect(childValues(data as Item[], ids.beta)).toEqual([]);
	});

	test('list cell: the own item keeps every stored locator verbatim', async () => {
		const { data } = await inLang(() => readSection(listRqo(ids.subject, 10)));
		const own = ownItem(data as Item[], ids.subject);
		const entries = (own.entries ?? own.value) as Item[];
		expect(entries.map((entry) => String(entry.section_id))).toEqual([
			String(ids.alpha),
			String(ids.beta),
			REMOTE_ID,
		]);
		expect((own.pagination as Item).total).toBe(3);
		// The remote id is kept verbatim (never Number()-ed into a local address)
		// and renders nothing at all: no child, no fake section_id item (the old
		// list branch emitted the target's section_id item at the remote id).
		expect(entries[2]?.section_id).toBe(REMOTE_ID);
		expect((data as Item[]).filter((item) => String(item.section_id) === REMOTE_ID)).toEqual([]);
	});

	test('list cell: an EMPTY relation still emits its own (empty) item', async () => {
		const { data } = await inLang(() => readSection(listRqo(ids.empty)));
		const own = ownItem(data as Item[], ids.empty);
		expect((own.entries ?? own.value) as unknown[]).toEqual([]);
		expect((own.pagination as Item).total).toBe(0);
	});

	test('Time Machine (dd15) history cell carries the child value', async () => {
		const result = await inLang(() =>
			readTimeMachineData({
				source: { lang: LANG },
				sqo: {
					section_tipo: ['dd15'],
					limit: 10,
					offset: 0,
					filter_by_locators: [{ section_tipo: SECTION, section_id: ids.subject }],
				},
				show: { ddo_map: [{ tipo: RELATED, limit: 10 }] },
			} as never),
		);
		const items = (result.data as Item[]).slice(1);
		expect(items.some((item) => item.tipo === RELATED)).toBe(true);
		expect(childValues(items, ids.alpha)).toEqual(['target alpha']);
		expect(childValues(items, ids.beta)).toEqual(['target beta']);
	});

	test('Time Machine: the SUBJECT cell pages to TM_SUBJECT_CELL_LIMIT without a client limit', async () => {
		const tmCell = async (sectionId: number) => {
			const result = await inLang(() =>
				readTimeMachineData({
					source: { lang: LANG },
					sqo: {
						section_tipo: ['dd15'],
						limit: 10,
						offset: 0,
						filter_by_locators: [{ section_tipo: SECTION, section_id: sectionId }],
					},
					show: { ddo_map: [{ tipo: RELATED }] },
				} as never),
			);
			const items = (result.data as Item[]).slice(1);
			return { items, own: items.find((item) => item.tipo === RELATED) as Item };
		};
		// Under the cap: every locator, every target child.
		const small = await tmCell(ids.subject);
		expect(((small.own.entries ?? small.own.value) as unknown[]).length).toBe(3);
		expect(childValues(small.items, ids.alpha)).toEqual(['target alpha']);
		expect(childValues(small.items, ids.beta)).toEqual(['target beta']);
		// Over the cap: cut at TM_SUBJECT_CELL_LIMIT, total counts all.
		const wide = await tmCell(ids.wide);
		expect(((wide.own.entries ?? wide.own.value) as unknown[]).length).toBe(TM_SUBJECT_CELL_LIMIT);
		expect(wide.own.pagination).toMatchObject({ total: 11, limit: TM_SUBJECT_CELL_LIMIT });
	});
});
