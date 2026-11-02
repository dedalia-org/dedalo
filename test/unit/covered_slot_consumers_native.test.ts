/**
 * covered-slot consumers — the doors OUTSIDE observers.ts that read the
 * covered-observer predicate (isCoveredObserverTipo), gated after it was
 * broadened from "inverse_search only" to every STORED external value law
 * (external_laws/: inverse_search, source_overwrite, observed_data).
 *
 *   1. DUPLICATE (duplicate_record.ts) strips every covered slot, but a COPY
 *      law reads the record's OWN data, which IS copied — its slot is
 *      recomputed on the clone from that copy (record_write.ts
 *      ownDataCoveredSlots → the birth's selfRecompute), never inherited:
 *        1a an `observed_data` slot (test6380, the svg-tag locators of the
 *           test6263 legend) — the text is a string-column key, no birth edge
 *           reaches it, so without the selfRecompute the clone stays empty;
 *        1b a `source_overwrite` slot (testcoincatalog1013, the bag of
 *           test6157 on the record its copied pointer testcoincatalog1004
 *           names).
 *      Both sources store a STALE slot first, so an inherited copy fails.
 *      1c CREATE (create_record.ts) unions the same slots into its birth's
 *         selfRecompute: a record born with a `dato_default` on a copy law's
 *         input (a tagged text) holds the default's tag locators — no birth
 *         edge reaches a text default, so only that recompute fills the slot.
 *   2. BULK REVERT (bulk_revert_records.ts isReferenced): a locator in a
 *      covered slot is not a link only when the slot RE-STATES an indexed
 *      edge (inverse mirror, source_overwrite copy). An observed_data slot is
 *      the only indexed witness of a text tag's link, so it still counts: a
 *      coin born in a run, tagged by a legend saved OUTSIDE it, survives the
 *      run's revert (driven through the real bulk-revert door).
 *
 * SITUATION: repo-owned `test`/`testcoincatalog` nodes (the suite ontology),
 * plus the `zzcsc` scratch situation for 1c (a defaulted tagged text and its
 * observed_data slot — built after the coin its default tags, dropped after);
 * every record created at runtime and swept in afterAll (records + TM rows,
 * the dd800 run records).
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { config } from '../../src/config/config.ts';
import { sql } from '../../src/core/db/postgres.ts';
import { getMatrixTableFromTipo } from '../../src/core/ontology/resolver.ts';
import { createSectionRecord } from '../../src/core/section/record/create_record.ts';
import { duplicateSectionRecord } from '../../src/core/section/record/duplicate_record.ts';
import { isCoveredObserverTipo } from '../../src/core/section/record/observers.ts';
import { saveComponentData } from '../../src/core/section/record/save_component.ts';
import { ownDataCoveredSlots } from '../../src/core/section_record/record_write.ts';
import { resolvePrincipal } from '../../src/core/security/permissions.ts';
import {
	dropSituation,
	ensureSituation,
	type Situation,
	situation,
} from '../../src/core/test_data/situations/situation.ts';
import { assertTestDatabase } from '../../src/core/test_data/test_database_marker.ts';
import { toolTimeMachineBulkRevert } from '../../tools/tool_time_machine/server/bulk_revert.ts';
import { isRestatedEdgeSlot } from '../../tools/tool_time_machine/server/bulk_revert_records.ts';
import { countActivityRows, sweepActivityRows } from '../helpers/activity_rows.ts';
import { cleanScratchRecord } from '../helpers/test_data.ts';

const TABLE = 'matrix_test';
const USER_ID = -1;

/** observed_data: the legend section, its text and the tag-locator slot. */
const LEGEND_SECTION = 'test6124';
const LEGEND_TEXT = 'test6263';
const TAG_SLOT = 'test6380';

/** source_overwrite: the catalog term, its pointer, the copy slot, the source. */
const TERM_SECTION = 'testcoincatalog1';
const POINTER = 'testcoincatalog1004';
const COPY_SLOT = 'testcoincatalog1013';
const TYPE_SECTION = 'test6099';
const TYPE_COINS = 'test6157';
const COIN_SECTION = 'test6100';

const svgTag = (tagId: number, sectionId: number) =>
	`[svg-n-${tagId}--data:{'section_tipo':'${COIN_SECTION}','section_id':'${sectionId}','component_tipo':'test6232'}:data]`;

/** 1c: a section whose tagged text carries a dato_default, and its observed_data slot. */
const TLD = 'zzcsc';
const DEFAULT_SECTION = `${TLD}1`;
const DEFAULT_TEXT = `${TLD}2`;
const DEFAULT_SLOT = `${TLD}3`;

/** The 1c situation — its default tags a coin created at runtime (the gone-record rule). */
function defaultedTextSituation(coinId: number): Situation {
	const html = `<p>Default ${svgTag(1, coinId)}</p>`;
	return situation({
		tld: TLD,
		name: 'covered_slot_consumers_default',
		nodes: [
			{ tipo: DEFAULT_SECTION, parent: 'test1', model: 'section', term: { 'lg-eng': 'Defaulted' } },
			{
				tipo: DEFAULT_TEXT,
				parent: DEFAULT_SECTION,
				model: 'component_text_area',
				term: { 'lg-eng': 'Defaulted legend' },
				is_translatable: false,
				properties: {
					dato_default: [{ id: 1, lang: 'lg-nolan', value: html }],
					observers: [{ section_tipo: 'self', component_tipo: DEFAULT_SLOT }],
				},
			},
			{
				tipo: DEFAULT_SLOT,
				parent: DEFAULT_SECTION,
				model: 'component_portal',
				term: { 'lg-eng': 'Defaulted legend symbols' },
				properties: {
					source: {
						mode: 'external',
						section_to_search: [DEFAULT_SECTION],
						set_observed_data: [
							{
								tipo: DEFAULT_TEXT,
								perform: { function: 'get_locators_of_tags', params: { ar_tags: ['svg'] } },
							},
						],
					},
					observe: [
						{
							component_tipo: DEFAULT_TEXT,
							server: {
								perform: {
									function: 'set_dato_external',
									params: { save: true, changed: false, current_dato: false, references_limit: 0 },
								},
							},
						},
					],
				},
			},
		],
	});
}

let defaultSituation: Situation | null = null;

/** dd800 run records (a run and its revert) — swept in afterAll. */
const runs: number[] = [];

const created: { sectionTipo: string; sectionId: number }[] = [];

async function born(sectionTipo: string): Promise<number> {
	const sectionId = await createSectionRecord(sectionTipo, USER_ID);
	created.push({ sectionTipo, sectionId });
	return sectionId;
}

/** Store one relation key RAW (a stale slot / a source bag), bypassing every door. */
async function storeRelationKey(
	sectionTipo: string,
	sectionId: number,
	key: string,
	value: unknown[],
): Promise<void> {
	await assertTestDatabase('covered_slot_consumers_native.storeRelationKey');
	await sql.unsafe(
		`UPDATE "${TABLE}" SET relation = jsonb_set(COALESCE(relation, '{}'::jsonb), ARRAY[$3::text], $4::text::jsonb)
		 WHERE section_tipo = $1 AND section_id = $2`,
		[sectionTipo, sectionId, key, JSON.stringify(value)],
	);
}

async function relationKey(
	sectionTipo: string,
	sectionId: number,
	key: string,
): Promise<unknown[]> {
	const rows = (await sql.unsafe(
		`SELECT relation->$3 AS value FROM "${TABLE}" WHERE section_tipo = $1 AND section_id = $2`,
		[sectionTipo, sectionId, key],
	)) as { value: unknown }[];
	const value = rows[0]?.value;
	return Array.isArray(value) ? value : [];
}

const idsOf = (items: unknown[]): number[] =>
	items.map((item) => Number((item as { section_id: unknown }).section_id)).sort((a, b) => a - b);

let coinA = 0;
let coinStale = 0;

beforeAll(async () => {
	coinA = await born(COIN_SECTION);
	coinStale = await born(COIN_SECTION);
	defaultSituation = defaultedTextSituation(coinA);
	await ensureSituation(defaultSituation);
}, 60_000);

afterAll(async () => {
	for (const { sectionTipo, sectionId } of created.reverse()) {
		await cleanScratchRecord(sectionTipo, sectionId, TABLE);
	}
	const runTable = await getMatrixTableFromTipo('dd800');
	for (const id of runs) await cleanScratchRecord('dd800', id, runTable ?? 'matrix');
	// The activity rows the doors logged for this file's records (dropSituation
	// does not count them — test/helpers/activity_rows.ts), swept and asserted 0.
	const activityIds = new Map<string, number[]>([['dd800', [...runs]]]);
	for (const { sectionTipo, sectionId } of created) {
		activityIds.set(sectionTipo, [...(activityIds.get(sectionTipo) ?? []), sectionId]);
	}
	for (const [sectionTipo, ids] of activityIds) {
		await sweepActivityRows(sectionTipo, ids);
		expect(await countActivityRows(sectionTipo, ids), `${sectionTipo} activity residue`).toBe(0);
	}
	// The zz scratch section is this file's own: every row naming it.
	await sweepActivityRows(DEFAULT_SECTION);
	expect(await countActivityRows(DEFAULT_SECTION), `${DEFAULT_SECTION} activity residue`).toBe(0);
	if (defaultSituation !== null) expect(await dropSituation(defaultSituation)).toBe(0);
}, 60_000);

describe('the copy laws are covered (FLOOR — else every case below is vacuous)', () => {
	test('both slots are covered and their sections declare them as own-data slots', async () => {
		expect(await isCoveredObserverTipo(TAG_SLOT)).toBe(true);
		expect(await isCoveredObserverTipo(COPY_SLOT)).toBe(true);
		expect(await ownDataCoveredSlots(LEGEND_SECTION)).toContain(TAG_SLOT);
		expect(await ownDataCoveredSlots(TERM_SECTION)).toContain(COPY_SLOT);
		// an inverse mirror is empty by construction on a new record: never listed
		expect(await ownDataCoveredSlots(TYPE_SECTION)).not.toContain(TYPE_COINS);
	}, 60_000);
});

describe('1. a duplicate recomputes its copy-law slots from the copied data', () => {
	test('1a: observed_data — the clone’s tag slot lists its copied text’s svg locators', async () => {
		const source = await born(LEGEND_SECTION);
		const lang = config.lang.dataLangDefault;
		const saved = await saveComponentData({
			componentTipo: LEGEND_TEXT,
			sectionTipo: LEGEND_SECTION,
			sectionId: source,
			lang,
			changedData: [
				{
					action: 'set_data',
					value: [{ id: 1, lang, value: `<p>Legend ${svgTag(1, coinA)}</p>` }],
				},
			] as never,
			userId: USER_ID,
		});
		expect(saved.ok, saved.message).toBe(true);
		// The source's slot goes STALE: an inherited copy names coinStale.
		await storeRelationKey(LEGEND_SECTION, source, TAG_SLOT, [
			{
				id: 1,
				type: 'dd151',
				section_tipo: COIN_SECTION,
				section_id: coinStale,
				from_component_tipo: TAG_SLOT,
			},
		]);

		const clone = await duplicateSectionRecord(LEGEND_SECTION, source, USER_ID);
		created.push({ sectionTipo: LEGEND_SECTION, sectionId: clone });
		expect(
			idsOf(await relationKey(LEGEND_SECTION, clone, TAG_SLOT)),
			'the clone’s observed_data slot is not its copied text’s tag locators — the duplicate stripped it and never recomputed it (no selfRecompute by declaration), or it inherited the source’s stale copy',
		).toEqual([coinA]);
	}, 120_000);

	test('1b: source_overwrite — the clone’s copy slot is the bag its copied pointer names', async () => {
		const type = await born(TYPE_SECTION);
		await storeRelationKey(TYPE_SECTION, type, TYPE_COINS, [
			{
				id: 1,
				type: 'dd151',
				section_tipo: COIN_SECTION,
				section_id: coinA,
				from_component_tipo: TYPE_COINS,
			},
		]);
		const source = await born(TERM_SECTION);
		const saved = await saveComponentData({
			componentTipo: POINTER,
			sectionTipo: TERM_SECTION,
			sectionId: source,
			lang: 'lg-nolan',
			changedData: [
				{
					action: 'set_data',
					id: null,
					value: [
						{
							type: 'dd151',
							section_tipo: TYPE_SECTION,
							section_id: String(type),
							from_component_tipo: POINTER,
						},
					],
				},
			] as never,
			userId: USER_ID,
		});
		expect(saved.ok, saved.message).toBe(true);
		await storeRelationKey(TERM_SECTION, source, COPY_SLOT, [
			{
				id: 1,
				type: 'dd151',
				section_tipo: COIN_SECTION,
				section_id: coinStale,
				from_component_tipo: COPY_SLOT,
			},
		]);

		const clone = await duplicateSectionRecord(TERM_SECTION, source, USER_ID);
		created.push({ sectionTipo: TERM_SECTION, sectionId: clone });
		expect(
			idsOf(await relationKey(TERM_SECTION, clone, POINTER)),
			'FLOOR: the pointer was copied',
		).toEqual([type]);
		expect(
			idsOf(await relationKey(TERM_SECTION, clone, COPY_SLOT)),
			'the clone’s source_overwrite slot is not the bag its copied pointer names — recomputed from nothing, or inherited the source’s stale copy',
		).toEqual([coinA]);
	}, 120_000);
});

describe('1c. a create recomputes its copy-law slots by declaration too', () => {
	test('a record born with a tagged-text dato_default holds the default’s tag locators', async () => {
		expect(
			await ownDataCoveredSlots(DEFAULT_SECTION),
			'FLOOR: the slot is a copy-law slot',
		).toContain(DEFAULT_SLOT);
		const record = await createSectionRecord(DEFAULT_SECTION, USER_ID);
		const rows = (await sql.unsafe(
			`SELECT "string"->$3 AS text FROM "${TABLE}" WHERE section_tipo = $1 AND section_id = $2`,
			[DEFAULT_SECTION, record, DEFAULT_TEXT],
		)) as { text: unknown }[];
		expect(
			JSON.stringify(rows[0]?.text ?? null),
			'FLOOR: the text was born with its default',
		).toContain('svg-n-1');
		expect(
			idsOf(await relationKey(DEFAULT_SECTION, record, DEFAULT_SLOT)),
			'the born record’s observed_data slot is empty — the birth never recomputed its copy-law slots (no birth edge reaches a text default)',
		).toEqual([coinA]);
	}, 120_000);
});

describe('2. bulk revert: which covered-slot locators are not links', () => {
	test('OUTCOME: a coin born in a run, tagged by a legend saved outside it, survives the revert', async () => {
		const run = await createSectionRecord('dd800', USER_ID);
		runs.push(run);
		const bornInRun = async (): Promise<number> => {
			const id = await createSectionRecord(COIN_SECTION, USER_ID, new Date(), undefined, {
				bulkProcessId: run,
			});
			created.push({ sectionTipo: COIN_SECTION, sectionId: id });
			return id;
		};
		const tagged = await bornInRun();
		const free = await bornInRun();
		// The legend lives OUTSIDE the run: its text tags the born coin.
		const legend = await born(LEGEND_SECTION);
		const lang = config.lang.dataLangDefault;
		const saved = await saveComponentData({
			componentTipo: LEGEND_TEXT,
			sectionTipo: LEGEND_SECTION,
			sectionId: legend,
			lang,
			changedData: [
				{ action: 'set_data', value: [{ id: 1, lang, value: `<p>${svgTag(1, tagged)}</p>` }] },
			] as never,
			userId: USER_ID,
		});
		expect(saved.ok, saved.message).toBe(true);
		expect(
			idsOf(await relationKey(LEGEND_SECTION, legend, TAG_SLOT)),
			'FLOOR: the tag slot lists the born coin',
		).toEqual([tagged]);

		const response = await toolTimeMachineBulkRevert({
			principal: await resolvePrincipal(USER_ID),
			userId: USER_ID,
			options: { bulk_process_id: run },
			background: false,
		});
		expect(response.ok).toBe(true);
		runs.push((response.data as { bulk_process_id: number }).bulk_process_id);

		const exists = async (id: number): Promise<boolean> =>
			(
				(await sql.unsafe(`SELECT 1 FROM "${TABLE}" WHERE section_tipo = $1 AND section_id = $2`, [
					COIN_SECTION,
					id,
				])) as unknown[]
			).length > 0;
		expect(
			await exists(free),
			'FLOOR: the revert deleted its unreferenced born coin (D2 ran)',
		).toBe(false);
		expect(
			await exists(tagged),
			'the revert DELETED a born coin a legend’s svg tag still points at — its observed_data slot was discounted as a non-link',
		).toBe(true);
		expect(idsOf(await relationKey(LEGEND_SECTION, legend, TAG_SLOT))).toEqual([tagged]);
	}, 120_000);

	// The predicate under the outcome (a unit pin).
	test('inverse mirror and source_overwrite copy re-state an edge; an observed_data slot does not', async () => {
		expect(await isRestatedEdgeSlot(TYPE_COINS)).toBe(true);
		expect(await isRestatedEdgeSlot(COPY_SLOT)).toBe(true);
		expect(
			await isRestatedEdgeSlot(TAG_SLOT),
			'an observed_data slot is the only indexed witness of a text tag’s link — discounted, a born record a tag points at is deleted under it',
		).toBe(false);
		expect(await isRestatedEdgeSlot(LEGEND_TEXT), 'a non-covered key is a link').toBe(false);
	}, 60_000);
});
