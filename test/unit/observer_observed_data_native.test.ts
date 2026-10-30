/**
 * SUB-LAW (a) — SET OBSERVED DATA, end to end on the suite DB (2026-10-30).
 *
 * The coin-legend case (S7): a legend text (test6263, the twin of
 * numisdata195) carries svg symbol tags whose payloads are locators; its
 * external portal test6380 (the twin of numisdata563) is the list of those
 * locators — `set_observed_data: [{tipo: test6263, perform:
 * {function: get_locators_of_tags, params: {ar_tags: ['svg']}}}]`. Before the
 * law registry the kernel REFUSED the node (the Phase-0 disarm) and the
 * no-config `observe` edge was "server shape not covered", so the slot was
 * never computed.
 *
 * WHAT IS PINNED (synthesis §4, critique 2/5, owner ruling Q4):
 *   1. a save of the text fills the slot through the declared self edge —
 *      DOCUMENT order, every payload key kept (critique 2: `component_tipo`),
 *      `section_id` a canonical int, `from_component_tipo` the observer,
 *      observer-owned ids, the save law's index, one TM value row;
 *   2. the tag set is the declared `ar_tags` (['svg']): a geo tag carrying a
 *      locator is not read; a non-locator svg payload is skipped; a repeated
 *      locator is listed once;
 *   3. a REORDER of the symbols in the text reorders the slot (the order is
 *      the value — merge order 'desired');
 *   4. removing a tag drops its item;
 *   5. the LANG RULE (Q4): the union of every stored lang — lg-nolan, then
 *      the main data lang, then the rest sorted — document order inside each
 *      text, first occurrence wins;
 *   6. no drift → zero writes (a re-save of the same text writes no TM row
 *      for the slot);
 *   7. an empty text → [];
 *   8. THE GONE-RECORD RULE: a tagged record deleted through the delete door
 *      (deleteSectionRecord — it strips the locator, not the tag) stays out of
 *      the slot on every later recompute: a save of the text, a refresh.
 *
 * SITUATION: repo-owned `test` nodes (the suite ontology); every record is
 * created at runtime and swept in afterAll (records + TM rows).
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { config } from '../../src/config/config.ts';
import { sql } from '../../src/core/db/postgres.ts';
import { createSectionRecord } from '../../src/core/section/record/create_record.ts';
import { deleteSectionRecord } from '../../src/core/section/record/delete_record.ts';
import { refreshExternalMirror } from '../../src/core/section/record/observers.ts';
import { saveComponentData } from '../../src/core/section/record/save_component.ts';
import { hiIndexDisagrees } from '../../src/core/section_record/record_write.ts';
import { assertTestDatabase } from '../../src/core/test_data/test_database_marker.ts';
import { cleanScratchRecord } from '../helpers/test_data.ts';

const TABLE = 'matrix_test';
const USER_ID = -1;

const LEGEND_SECTION = 'test6124';
const LEGEND_TEXT = 'test6263';
const TAG_SLOT = 'test6380';
const COIN_SECTION = 'test6100';
/** The component a symbol payload names (kept verbatim on the mirror item). */
const PAYLOAD_COMPONENT = 'test6232';

const created: { sectionTipo: string; sectionId: number }[] = [];

async function born(sectionTipo: string): Promise<number> {
	const sectionId = await createSectionRecord(sectionTipo, USER_ID);
	created.push({ sectionTipo, sectionId });
	return sectionId;
}

const svgTag = (tagId: number, sectionId: number) =>
	`[svg-n-${tagId}--data:{'section_tipo':'${COIN_SECTION}','section_id':'${sectionId}','component_tipo':'${PAYLOAD_COMPONENT}'}:data]`;

/** A text save through THE door (propagation + obligation ledger included). */
async function saveLegend(sectionId: number, html: string): Promise<void> {
	const lang = config.lang.dataLangDefault;
	const saved = await saveComponentData({
		componentTipo: LEGEND_TEXT,
		sectionTipo: LEGEND_SECTION,
		sectionId,
		lang,
		changedData: [{ action: 'set_data', value: [{ id: 1, lang, value: html }] }] as never,
		userId: USER_ID,
	});
	expect(saved.ok, saved.message).toBe(true);
}

/** Store the legend's `string` items RAW (several langs at once), no propagation. */
async function storeLegendItems(sectionId: number, items: unknown[]): Promise<void> {
	await assertTestDatabase('observer_observed_data_native.storeLegendItems');
	await sql.unsafe(
		`UPDATE "${TABLE}" SET "string" = jsonb_set(COALESCE("string", '{}'::jsonb), ARRAY[$3::text], $4::text::jsonb)
		 WHERE section_tipo = $1 AND section_id = $2`,
		[LEGEND_SECTION, sectionId, LEGEND_TEXT, JSON.stringify(items)],
	);
}

type Item = Record<string, unknown>;

async function slot(sectionId: number): Promise<Item[]> {
	const rows = (await sql.unsafe(
		`SELECT relation->$3 AS value FROM "${TABLE}" WHERE section_tipo = $1 AND section_id = $2`,
		[LEGEND_SECTION, sectionId, TAG_SLOT],
	)) as { value: unknown }[];
	const value = rows[0]?.value;
	return Array.isArray(value) ? (value as Item[]) : [];
}

async function slotIndex(sectionId: number): Promise<unknown> {
	const rows = (await sql.unsafe(
		`SELECT relation_search->$3 AS value FROM "${TABLE}" WHERE section_tipo = $1 AND section_id = $2`,
		[LEGEND_SECTION, sectionId, TAG_SLOT],
	)) as { value: unknown }[];
	return rows[0]?.value ?? null;
}

/** The non-empty TM values of the slot, oldest first (the empty epoch row excluded). */
async function tmValueRows(sectionId: number): Promise<unknown[]> {
	const rows = (await sql.unsafe(
		`SELECT data FROM matrix_time_machine WHERE section_tipo = $1 AND section_id = $2 AND tipo = $3
		 AND data IS NOT NULL AND data <> 'null'::jsonb ORDER BY id`,
		[LEGEND_SECTION, sectionId, TAG_SLOT],
	)) as { data: unknown }[];
	return rows.map((row) => row.data);
}

const ids = (items: Item[]): number[] => items.map((item) => Number(item.section_id));

let coinA = 0;
let coinB = 0;
let coinC = 0;
let coinD = 0;

beforeAll(async () => {
	coinA = await born(COIN_SECTION);
	coinB = await born(COIN_SECTION);
	coinC = await born(COIN_SECTION);
	coinD = await born(COIN_SECTION);
}, 60_000);

afterAll(async () => {
	for (const { sectionTipo, sectionId } of created.reverse()) {
		await cleanScratchRecord(sectionTipo, sectionId, TABLE);
	}
}, 60_000);

describe('1-4. a save of the text maintains the tag-locator slot', () => {
	let legend = 0;

	test('1. document order, payload keys kept, canonical ids, observer-owned, indexed, one TM row', async () => {
		legend = await born(LEGEND_SECTION);
		// B written BEFORE A: the slot follows the text, not the ids.
		await saveLegend(legend, `<p>${svgTag(1, coinB)} and ${svgTag(2, coinA)}</p>`);
		const items = await slot(legend);
		expect(ids(items), 'the slot is not the text’s svg locators in document order').toEqual([
			coinB,
			coinA,
		]);
		for (const [at, item] of items.entries()) {
			expect(item.section_tipo).toBe(COIN_SECTION);
			expect(typeof item.section_id, 'section_id is the canonical int').toBe('number');
			expect(
				item.component_tipo,
				'a payload key other than the address was dropped (critique 2)',
			).toBe(PAYLOAD_COMPONENT);
			expect(item.from_component_tipo).toBe(TAG_SLOT);
			expect(item.id, 'observer-owned item ids').toBe(at + 1);
		}
		expect(await hiIndexDisagrees(TAG_SLOT, items, await slotIndex(legend))).toBe(false);
		expect(await tmValueRows(legend)).toEqual([items]);
	}, 120_000);

	test('2. only the declared tag types; non-locator payloads skipped; a repeat listed once', async () => {
		const geo = `[geo-n-3--data:{'section_tipo':'${COIN_SECTION}','section_id':'${coinC}'}:data]`;
		const notLocator = `[svg-n-4--data:{'foo':'bar'}:data]`;
		await saveLegend(
			legend,
			`<p>${svgTag(1, coinB)} ${geo} ${notLocator} ${svgTag(2, coinA)} ${svgTag(5, coinB)}</p>`,
		);
		expect(
			ids(await slot(legend)),
			'a geo tag (not in ar_tags), a non-locator payload or a repeat leaked into the slot',
		).toEqual([coinB, coinA]);
	}, 120_000);

	test('3. a REORDER of the symbols reorders the slot; kept items keep their ids', async () => {
		const before = new Map((await slot(legend)).map((item) => [Number(item.section_id), item.id]));
		await saveLegend(legend, `<p>${svgTag(2, coinA)} ${svgTag(1, coinB)}</p>`);
		const after = await slot(legend);
		expect(ids(after)).toEqual([coinA, coinB]);
		for (const item of after) expect(item.id).toBe(before.get(Number(item.section_id)));
	}, 120_000);

	test('4. removing a tag drops its item', async () => {
		await saveLegend(legend, `<p>${svgTag(2, coinA)}</p>`);
		expect(ids(await slot(legend))).toEqual([coinA]);
	}, 120_000);

	test('6. no drift: a re-save of the same text writes no TM row for the slot', async () => {
		const rows = (await tmValueRows(legend)).length;
		expect(rows, 'FLOOR: the slot has history').toBeGreaterThan(0);
		await saveLegend(legend, `<p>${svgTag(2, coinA)} </p>`);
		expect(ids(await slot(legend))).toEqual([coinA]);
		expect((await tmValueRows(legend)).length).toBe(rows);
	}, 120_000);

	test('7. an empty text → []', async () => {
		await saveLegend(legend, '<p></p>');
		expect(await slot(legend)).toEqual([]);
	}, 120_000);
});

describe('5. the lang rule — union of every stored lang, in a fixed lang order', () => {
	test('lg-nolan, then the main data lang, then the rest sorted; first occurrence wins', async () => {
		const main = config.lang.dataLangDefault;
		// two non-main langs, stored in REVERSE sort order to prove the sort
		const others = ['lg-cat', 'lg-deu', 'lg-eng', 'lg-fra', 'lg-spa']
			.filter((lang) => lang !== main)
			.slice(0, 2);
		expect(others.length, 'FLOOR: two non-main langs').toBe(2);
		const [first, second] = others as [string, string];
		const legend = await born(LEGEND_SECTION);
		await storeLegendItems(legend, [
			{ id: 1, lang: second, value: `<p>${svgTag(1, coinD)} ${svgTag(2, coinA)}</p>` },
			{ id: 2, lang: first, value: `<p>${svgTag(1, coinC)}</p>` },
			{ id: 3, lang: main, value: `<p>${svgTag(1, coinB)} ${svgTag(2, coinA)}</p>` },
			{ id: 4, lang: 'lg-nolan', value: `<p>${svgTag(1, coinA)}</p>` },
		]);
		const outcome = await refreshExternalMirror(
			TAG_SLOT,
			LEGEND_SECTION,
			legend,
			USER_ID,
			new Date(),
		);
		expect(outcome.refusedLaw, 'the observed_data law was refused').toBeUndefined();
		expect(
			ids(await slot(legend)),
			`lang order must be lg-nolan, ${main}, ${first}, ${second}`,
		).toEqual([coinA, coinB, coinC, coinD]);
	}, 120_000);
});

describe('8. the gone-record rule — a deleted tag target never comes back', () => {
	test('delete strips it; a later text save and a refresh agree with the strip', async () => {
		const gone = await born(COIN_SECTION);
		const legend = await born(LEGEND_SECTION);
		await saveLegend(legend, `<p>${svgTag(1, gone)} ${svgTag(2, coinA)}</p>`);
		expect(ids(await slot(legend)), 'FLOOR: both tags listed').toEqual([gone, coinA]);

		const deleted = await deleteSectionRecord(COIN_SECTION, gone, USER_ID);
		expect(deleted.deleted, 'FLOOR: the delete door deleted the tagged record').toEqual([gone]);
		expect(ids(await slot(legend)), 'FLOOR: the delete door strips the slot').toEqual([coinA]);

		// The text still carries the dead record's tag: a save of it recomputes.
		await saveLegend(legend, `<p>${svgTag(1, gone)} ${svgTag(2, coinA)} </p>`);
		expect(
			ids(await slot(legend)),
			'a text save wrote the DELETED record’s locator back (no gone-record rule in the observed_data law)',
		).toEqual([coinA]);

		const outcome = await refreshExternalMirror(
			TAG_SLOT,
			LEGEND_SECTION,
			legend,
			USER_ID,
			new Date(),
		);
		expect(outcome.refusedLaw).toBeUndefined();
		expect(outcome.wrote, 'the refresh found drift after the strip').not.toBe(true);
		expect(ids(await slot(legend))).toEqual([coinA]);
		expect(await hiIndexDisagrees(TAG_SLOT, await slot(legend), await slotIndex(legend))).toBe(
			false,
		);
	}, 120_000);
});
