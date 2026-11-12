/**
 * THE SAVE-BEFORE (T1-21 / O16) — PHP `tm_record::create($values,
 * $previous_data)` (class.tm_record.php, v6 JSON_RecordObj_matrix): when a
 * component save changes data whose (record, tipo, lang) has NO history yet —
 * an imported value, a v6 migration, a writer that records none — the prior
 * value is recorded FIRST, as a visible row stamped one minute earlier, no
 * bulk id, so dd15 shows what the edit overwrote and "restore previous" has
 * something to restore.
 *
 * The law lives in the ONE history writer (relations/dataframe_slots.ts
 * recordMainHistory), so every door gets it: the component save (main and
 * slot), tool_lang's translation, apply_value, the portal locator removal,
 * the relation_parent write, the wiped-filter reconcile, bulk revert/undo.
 * Only the lanes the change actually rewrote are eligible (PHP `same_data`
 * and its per-lang probe): a save of lg-spa never backfills lg-eng.
 * WC-2026-09-27-bulk-revert-undo-log, addendum 2026-11-12.
 *
 * Every expectation is a literal of the contract. The "un-historied" situation
 * is BUILT: the value is written through the engine's own save, then its TM
 * rows are deleted (= an import that wrote no history). Controls (an existing
 * history, an unchanged save, an empty before, saveTm:false, an excluded
 * address) pin that the backfill fires only where the law says.
 *
 * SITUATION: a `zzsbf` scratch section on `test1` (→ matrix_test);
 * assertTestDatabase first; every record, TM row, run and activity row swept;
 * the situation drop asserts zero residue.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { TM_EXCLUDED_SECTIONS } from '../../src/core/concepts/section.ts';
import { sql } from '../../src/core/db/postgres.ts';
import { getMatrixTableFromTipo } from '../../src/core/ontology/resolver.ts';
import { historyStamp, recordMainHistory } from '../../src/core/relations/dataframe_slots.ts';
import { deletePortalLocator } from '../../src/core/relations/save.ts';
import { createSectionRecord } from '../../src/core/section/record/create_record.ts';
import { saveComponentData } from '../../src/core/section/record/save_component.ts';
import { resolvePrincipal } from '../../src/core/security/permissions.ts';
import {
	dropSituation,
	ensureSituation,
	situation,
} from '../../src/core/test_data/situations/situation.ts';
import { assertTestDatabase } from '../../src/core/test_data/test_database_marker.ts';
import { translateAndWrite } from '../../src/core/tools/translation.ts';
import { toolTimeMachineBulkRevert } from '../../tools/tool_time_machine/server/bulk_revert.ts';
import { toolTimeMachineApplyValue } from '../../tools/tool_time_machine/server/tool_time_machine.ts';
import { mustGet } from '../helpers/assert.ts';
import { superuserTranslationGrant } from '../helpers/translation_grant.ts';

const TLD = 'zzsbf';
const SECTION = `${TLD}1`;
const TEXT = `${TLD}2`; // component_input_text, translatable, no slot
const PORTAL = `${TLD}3`; // component_portal (unsliced), declares SLOT
const SLOT = `${TLD}4`;
const XLIT = `${TLD}5`; // component_input_text, NOT translatable, with_lang_versions
const FTEXT = `${TLD}6`; // component_input_text, translatable, has_dataframe
const FSLOT = `${TLD}7`;
const TABLE = 'matrix_test';
const USER_ID = -1;
const NOLAN = 'lg-nolan';
const SPA = 'lg-spa';
const ENG = 'lg-eng';
const ELL = 'lg-ell';

const SITUATION = situation({
	tld: TLD,
	name: 'tm_save_before',
	nodes: [
		{ tipo: SECTION, parent: 'test1', model: 'section', term: { 'lg-eng': 'Save before' } },
		{
			tipo: TEXT,
			parent: SECTION,
			model: 'component_input_text',
			term: { 'lg-eng': 'Text' },
			is_translatable: true,
		},
		{
			tipo: PORTAL,
			parent: SECTION,
			model: 'component_portal',
			term: { 'lg-eng': 'Portal' },
			properties: {
				source: {
					request_config: [
						{
							sqo: { section_tipo: [{ value: [SECTION], source: 'section' }] },
							show: { ddo_map: [{ tipo: SLOT, parent: 'self', section_tipo: SECTION }] },
						},
					],
				},
			},
		},
		{ tipo: SLOT, parent: PORTAL, model: 'component_dataframe', term: { 'lg-eng': 'Slot' } },
		{
			tipo: XLIT,
			parent: SECTION,
			model: 'component_input_text',
			term: { 'lg-eng': 'Transliterable' },
			properties: { with_lang_versions: true },
		},
		{
			tipo: FTEXT,
			parent: SECTION,
			model: 'component_input_text',
			term: { 'lg-eng': 'Framed text' },
			is_translatable: true,
			properties: { has_dataframe: true },
		},
		{ tipo: FSLOT, parent: FTEXT, model: 'component_dataframe', term: { 'lg-eng': 'F slot' } },
	],
});

type Item = Record<string, unknown>;

const runs: number[] = [];
const ACTIVITY_OF_SECTION = `matrix_activity WHERE section_tipo = 'dd542'
	   AND misc->'dd551'->0->'value'->>'section_tipo' = $1`;
/** A TM-excluded section the control (K) writes through the writer directly. */
const EXCLUDED = mustGet([...TM_EXCLUDED_SECTIONS][0], 'an excluded section');
const EXCLUDED_ID = 987_654_321;

beforeAll(async () => {
	await assertTestDatabase('tm_save_before_native');
	await ensureSituation(SITUATION);
	expect(await getMatrixTableFromTipo(SECTION)).toBe(TABLE);
}, 60_000);

afterAll(async () => {
	const bulkTable = (await getMatrixTableFromTipo('dd800')) as string;
	for (const id of runs) {
		await sql.unsafe(
			`DELETE FROM "${bulkTable}" WHERE section_tipo = 'dd800' AND section_id = $1`,
			[id],
		);
		await sql.unsafe(
			`DELETE FROM matrix_time_machine WHERE section_tipo = 'dd800' AND section_id = $1`,
			[id],
		);
	}
	await sql.unsafe('DELETE FROM matrix_time_machine WHERE section_tipo = $1', [SECTION]);
	await sql.unsafe('DELETE FROM matrix_time_machine WHERE section_tipo = $1 AND section_id = $2', [
		EXCLUDED,
		EXCLUDED_ID,
	]);
	await sql.unsafe('DELETE FROM dedalo_ts_record_generation WHERE section_tipo = $1', [SECTION]);
	await sql.unsafe(`DELETE FROM "${TABLE}" WHERE section_tipo = $1`, [SECTION]);
	await sql.unsafe(`DELETE FROM ${ACTIVITY_OF_SECTION}`, [SECTION]);
	expect(await dropSituation(SITUATION)).toBe(0);
}, 60_000);

// ---------------------------------------------------------------- doors

const rec = (): Promise<number> => createSectionRecord(SECTION, USER_ID);

async function mint(): Promise<number> {
	const id = await createSectionRecord('dd800', USER_ID);
	runs.push(id);
	return id;
}

async function save(
	id: number,
	tipo: string,
	lang: string,
	changedData: unknown[],
	extra: { bulk?: number | null; callerDataframe?: unknown; saveTm?: boolean } = {},
): Promise<void> {
	const saved = await saveComponentData({
		componentTipo: tipo,
		sectionTipo: SECTION,
		sectionId: id,
		lang,
		changedData: changedData as never,
		userId: USER_ID,
		bulkProcessId: extra.bulk ?? null,
		callerDataframe: extra.callerDataframe as never,
		...(extra.saveTm === undefined ? {} : { saveTm: extra.saveTm }),
	});
	expect(saved.ok).toBe(true);
}

const text = (itemId: number, lang: string, value: string): Item => ({ id: itemId, lang, value });
const setText = (
	id: number,
	tipo: string,
	lang: string,
	items: Item[],
	extra: { bulk?: number | null; saveTm?: boolean } = {},
) => save(id, tipo, lang, [{ action: 'set_data', value: items }], extra);

/** A portal locator item at a runtime target record. */
const locator = (itemId: number, target: number): Item => ({
	id: itemId,
	type: 'dd151',
	section_tipo: SECTION,
	section_id: target,
	from_component_tipo: PORTAL,
});

/** The "imported without history" situation: every TM row of the record is removed. */
async function forgetHistory(id: number): Promise<void> {
	await sql.unsafe('DELETE FROM matrix_time_machine WHERE section_tipo = $1 AND section_id = $2', [
		SECTION,
		id,
	]);
}

async function stored(id: number, column: string, key: string): Promise<unknown> {
	const rows = (await sql.unsafe(
		`SELECT ${column}->$3 AS v FROM "${TABLE}" WHERE section_tipo = $1 AND section_id = $2`,
		[SECTION, id, key],
	)) as { v: unknown }[];
	return rows[0]?.v ?? undefined;
}

interface TmRow {
	id: number;
	lang: string;
	data: unknown;
	tm_role: number | null;
	bulk_process_id: number | null;
	timestamp: string;
}

/** Every row (any role) of `tipo` at the record, id ASC. */
async function rowsOf(id: number, tipo: string, sectionTipo = SECTION): Promise<TmRow[]> {
	const rows = (await sql.unsafe(
		`SELECT id, lang, data, tm_role, bulk_process_id, timestamp::text AS timestamp FROM matrix_time_machine
		  WHERE section_tipo = $1 AND section_id = $2 AND tipo = $3 ORDER BY id ASC`,
		[sectionTipo, id, tipo],
	)) as TmRow[];
	return rows.map((row) => ({
		...row,
		id: Number(row.id),
		bulk_process_id: row.bulk_process_id === null ? null : Number(row.bulk_process_id),
		timestamp: String(row.timestamp),
	}));
}

const visible = (rows: TmRow[]): TmRow[] => rows.filter((row) => row.tm_role === null);
const asList = (value: unknown): Item[] => (Array.isArray(value) ? (value as Item[]) : []);
/** A row's language-lane values (literal items). */
const values = (row: TmRow | undefined): unknown[] => asList(row?.data).map((item) => item.value);
/** A row's main locator targets and its frames' targets, composed (main first, frames after). */
const portalShape = (row: TmRow | undefined) => {
	const items = asList(row?.data);
	return {
		main: items.filter((item) => item.from_component_tipo === PORTAL).map((i) => i.section_id),
		frames: items.filter((item) => item.main_component_tipo !== undefined).map((i) => i.section_id),
	};
};

/** Seconds between two stored wall-clock stamps. */
const secondsBetween = (earlier: string, later: string): number =>
	(Date.parse(later.replace(' ', 'T')) - Date.parse(earlier.replace(' ', 'T'))) / 1000;

/** The backfill row's contract: visible, no run, stamped exactly one minute before the change row. */
function expectBackfillOf(backfill: TmRow | undefined, change: TmRow | undefined): void {
	const row = mustGet(backfill, 'the backfill row');
	expect(row.tm_role).toBeNull();
	expect(row.bulk_process_id).toBeNull();
	expect(secondsBetween(row.timestamp, mustGet(change, 'the change row').timestamp)).toBe(60);
}

// ---------------------------------------------------------------- the law

describe('a change of an un-historied lane records the lane as it stood first', () => {
	test('(A) translatable literal: lg-spa backfilled, then the save; the untouched lg-eng lane gets no row', async () => {
		const id = await rec();
		await setText(id, TEXT, SPA, [text(1, SPA, 'S0')]);
		await setText(id, TEXT, ENG, [text(1, ENG, 'E0')]);
		await forgetHistory(id);
		await setText(id, TEXT, SPA, [text(1, SPA, 'S1')]);
		const rows = await rowsOf(id, TEXT);
		expect(rows.map((row) => [row.lang, values(row)])).toEqual([
			[SPA, ['S0']],
			[SPA, ['S1']],
		]);
		expectBackfillOf(rows[0], rows[1]);
	});

	test('(B) unsliced portal: the lg-nolan lane backfilled with the old locators, then the insert', async () => {
		const [a, b, id] = [await rec(), await rec(), await rec()];
		await save(id, PORTAL, NOLAN, [{ action: 'set_data', value: [locator(1, a)] }]);
		await forgetHistory(id);
		await save(id, PORTAL, NOLAN, [{ action: 'set_data', value: [locator(1, a), locator(2, b)] }]);
		const rows = await rowsOf(id, PORTAL);
		expect(rows.map((row) => [row.lang, portalShape(row).main])).toEqual([
			[NOLAN, [a]],
			[NOLAN, [a, b]],
		]);
		expectBackfillOf(rows[0], rows[1]);
	});

	test('(C) slot save: the frame lane backfilled composed (locator + OLD frame), then the new frame; nothing under the slot', async () => {
		const [a, author, editor, id] = [await rec(), await rec(), await rec(), await rec()];
		await save(id, PORTAL, NOLAN, [{ action: 'set_data', value: [locator(1, a)] }]);
		const caller = { main_component_tipo: PORTAL, id_key: 1 };
		await save(
			id,
			SLOT,
			NOLAN,
			[
				{
					action: 'insert',
					id: null,
					value: { section_tipo: SECTION, section_id: String(author) },
				},
			],
			{ callerDataframe: caller },
		);
		await forgetHistory(id);
		const frame = mustGet(
			asList(await stored(id, 'relation', SLOT)).find((f) => f.main_component_tipo === PORTAL),
			'the frame',
		);
		await save(
			id,
			SLOT,
			NOLAN,
			[{ action: 'update', id: frame.id, value: { ...frame, section_id: String(editor) } }],
			{ callerDataframe: caller },
		);
		const rows = await rowsOf(id, PORTAL);
		expect(rows.map((row) => [row.lang, portalShape(row)])).toEqual([
			[NOLAN, { main: [a], frames: [author] }],
			[NOLAN, { main: [a], frames: [editor] }],
		]);
		expectBackfillOf(rows[0], rows[1]);
		expect(await rowsOf(id, SLOT)).toEqual([]);
	});

	test('(D) a lane holding only a HIDDEN undo-log row has no history: backfilled', async () => {
		const id = await rec();
		await setText(id, TEXT, SPA, [text(1, SPA, 'S0')], { bulk: await mint() });
		// Keep the run's hidden before-row; drop its visible after-row.
		await sql.unsafe(
			`DELETE FROM matrix_time_machine WHERE section_tipo = $1 AND section_id = $2 AND tm_role IS NULL`,
			[SECTION, id],
		);
		expect((await rowsOf(id, TEXT)).length).toBeGreaterThan(0);
		await setText(id, TEXT, SPA, [text(1, SPA, 'S1')]);
		const shown = visible(await rowsOf(id, TEXT));
		expect(shown.map((row) => [row.lang, values(row)])).toEqual([
			[SPA, ['S0']],
			[SPA, ['S1']],
		]);
		expectBackfillOf(shown[0], shown[1]);
	});

	test('(F) under a bulk run: the backfill is VISIBLE, no bulk id; the run keeps its own rows and reverts to S0', async () => {
		const id = await rec();
		await setText(id, TEXT, SPA, [text(1, SPA, 'S0')]);
		await forgetHistory(id);
		const bulk = await mint();
		await setText(id, TEXT, SPA, [text(1, SPA, 'S1')], { bulk });
		const rows = await rowsOf(id, TEXT);
		const backfill = mustGet(rows[0], 'the backfill');
		expect([backfill.lang, values(backfill), backfill.bulk_process_id, backfill.tm_role]).toEqual([
			SPA,
			['S0'],
			null,
			null,
		]);
		const runRows = rows.filter((row) => row.bulk_process_id === bulk);
		expect(runRows.length).toBeGreaterThan(0);
		expect(rows.slice(1).every((row) => row.bulk_process_id === bulk)).toBe(true);
		const shown = visible(rows);
		expect(shown.map((row) => [row.lang, values(row)])).toEqual([
			[SPA, ['S0']],
			[SPA, ['S1']],
		]);
		expectBackfillOf(shown[0], shown[1]);
		const response = await toolTimeMachineBulkRevert({
			principal: await resolvePrincipal(USER_ID),
			userId: USER_ID,
			options: { bulk_process_id: bulk },
			background: false,
		});
		expect(response.ok).toBe(true);
		runs.push((response.data as { bulk_process_id: number }).bulk_process_id);
		expect(asList(await stored(id, 'string', TEXT)).map((item) => item.value)).toEqual(['S0']);
		expect((await rowsOf(id, TEXT))[0]).toEqual(backfill);
	});

	test('(H) sliced main with a frame: frame baseline, then the lg-spa backfill, then the save; apply_value of the backfill restores S0 and its frame', async () => {
		const [author, id] = [await rec(), await rec()];
		await setText(id, FTEXT, SPA, [text(1, SPA, 'S0')]);
		await save(
			id,
			FSLOT,
			NOLAN,
			[
				{
					action: 'insert',
					id: null,
					value: { section_tipo: SECTION, section_id: String(author) },
				},
			],
			{ callerDataframe: { main_component_tipo: FTEXT, id_key: 1 } },
		);
		await forgetHistory(id);
		await setText(id, FTEXT, SPA, [text(1, SPA, 'S1')]);
		const rows = await rowsOf(id, FTEXT);
		const frames = (row: TmRow | undefined) =>
			asList(row?.data)
				.filter((item) => item.main_component_tipo === FTEXT)
				.map((item) => item.section_id);
		expect(rows.map((row) => row.lang)).toEqual([NOLAN, SPA, SPA]);
		expect(frames(rows[0])).toEqual([author]);
		expect([values(rows[1]), values(rows[2])]).toEqual([['S0'], ['S1']]);
		expectBackfillOf(rows[0], rows[2]);
		expectBackfillOf(rows[1], rows[2]);
		const applied = await toolTimeMachineApplyValue({
			principal: await resolvePrincipal(USER_ID),
			userId: USER_ID,
			options: {
				section_tipo: SECTION,
				section_id: id,
				tipo: FTEXT,
				lang: SPA,
				matrix_id: mustGet(rows[1], 'the backfill').id,
			},
			background: false,
		});
		expect(applied.ok).toBe(true);
		expect(asList(await stored(id, 'string', FTEXT)).map((item) => item.value)).toEqual(['S0']);
		expect(
			asList(await stored(id, 'relation', FSLOT))
				.filter((f) => f.main_component_tipo === FTEXT)
				.map((f) => Number(f.section_id)),
		).toEqual([author]);
	});

	test('(J) transliterable base save (lg-nolan door): the base backfilled; the lg-ell lane untouched', async () => {
		const id = await rec();
		await setText(id, XLIT, NOLAN, [text(1, NOLAN, 'B0')]);
		await setText(id, XLIT, ELL, [text(1, ELL, 'L0')]);
		await forgetHistory(id);
		await setText(id, XLIT, NOLAN, [text(1, NOLAN, 'B1')]);
		const rows = await rowsOf(id, XLIT);
		expect(rows.map((row) => [row.lang, values(row)])).toEqual([
			[NOLAN, ['B0']],
			[NOLAN, ['B1']],
		]);
		expectBackfillOf(rows[0], rows[1]);
	});
});

describe('every history door gets the law (one writer)', () => {
	test('(I) tool_lang translation into an un-historied lg-eng lane: lg-eng backfilled first', async () => {
		const id = await rec();
		await setText(id, TEXT, SPA, [text(1, SPA, 'S0')]);
		await setText(id, TEXT, ENG, [text(1, ENG, 'E0')]);
		await forgetHistory(id);
		const outcome = await translateAndWrite(await superuserTranslationGrant(SECTION, TEXT, id), {
			model: 'component_input_text',
			sourceLang: SPA,
			targetLang: ENG,
			provider: async () => ({ ok: true, text: 'E1', msg: 'ok' }),
			uri: 'test://save_before',
			key: '',
		});
		expect(outcome.ok).toBe(true);
		const rows = await rowsOf(id, TEXT);
		expect(rows.map((row) => [row.lang, values(row)])).toEqual([
			[ENG, ['E0']],
			[ENG, ['E1']],
		]);
		expectBackfillOf(rows[0], rows[1]);
	});

	test('(I) portal locator removal over un-historied [A,B]: lg-nolan [A,B] backfilled, then [A]', async () => {
		const [a, b, id] = [await rec(), await rec(), await rec()];
		await save(id, PORTAL, NOLAN, [{ action: 'set_data', value: [locator(1, a), locator(2, b)] }]);
		await forgetHistory(id);
		const removed = mustGet(
			asList(await stored(id, 'relation', PORTAL)).find((item) => Number(item.section_id) === b),
			'the B locator',
		);
		const outcome = await deletePortalLocator(
			await resolvePrincipal(USER_ID),
			{ tipo: PORTAL, section_tipo: SECTION, section_id: id },
			{ locator: removed },
		);
		expect(outcome.removed).toBe(1);
		const rows = await rowsOf(id, PORTAL);
		expect(rows.map((row) => [row.lang, portalShape(row).main.map(Number)])).toEqual([
			[NOLAN, [a, b]],
			[NOLAN, [a]],
		]);
		expectBackfillOf(rows[0], rows[1]);
	});
});

// ---------------------------------------------------------------- controls

describe('controls: no backfill where the law says none', () => {
	test('(E) a lane with visible history: the save writes exactly its own row', async () => {
		const id = await rec();
		await setText(id, TEXT, SPA, [text(1, SPA, 'S0')]);
		const before = (await rowsOf(id, TEXT)).length;
		await setText(id, TEXT, SPA, [text(1, SPA, 'S1')]);
		const rows = await rowsOf(id, TEXT);
		expect(rows.length).toBe(before + 1);
		expect(values(rows.at(-1))).toEqual(['S1']);
	});

	test('(G) an unchanged save, an empty before, saveTm:false — no backfill', async () => {
		const same = await rec();
		await setText(same, TEXT, SPA, [text(1, SPA, 'S0')]);
		await forgetHistory(same);
		await setText(same, TEXT, SPA, [text(1, SPA, 'S0')]);
		expect((await rowsOf(same, TEXT)).map((row) => [row.lang, values(row)])).toEqual([
			[SPA, ['S0']],
		]);

		const fresh = await rec();
		await setText(fresh, TEXT, SPA, [text(1, SPA, 'S0')]);
		expect((await rowsOf(fresh, TEXT)).length).toBe(1);

		const silent = await rec();
		await setText(silent, TEXT, SPA, [text(1, SPA, 'S0')]);
		await forgetHistory(silent);
		await setText(silent, TEXT, SPA, [text(1, SPA, 'S1')], { saveTm: false });
		expect(await rowsOf(silent, TEXT)).toEqual([]);
	});

	test('(K) a TM-excluded address: the writer records nothing, backfill included', async () => {
		await recordMainHistory(
			{ table: TABLE, sectionTipo: EXCLUDED, sectionId: EXCLUDED_ID },
			{ tipo: TEXT, lang: SPA, sliced: true, translatable: true },
			{
				before: { value: [text(1, SPA, 'S0')], slots: { slots: [], images: {} } },
				after: { value: [text(1, SPA, 'S1')], slots: { slots: [], images: {} } },
			},
			historyStamp(USER_ID, null),
		);
		expect(await rowsOf(EXCLUDED_ID, TEXT, EXCLUDED)).toEqual([]);
	});
});
