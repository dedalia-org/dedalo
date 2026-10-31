/**
 * THE TWO-LANE CONTRACT, OUTCOME-FIRST (user, final, 2026-09-28;
 * WC-2026-09-27-bulk-revert-undo-log addendum "two lanes") — an INDEPENDENT
 * gate: every expectation below is a literal the contract dictates, never the
 * engine's own reader or lane law recomputed.
 *
 * THE CONTRACT, in one breath: every history row of a main (and of its
 * dataframes) is stored under the MAIN's tipo, in ONE lane. A LANGUAGE row
 * (lg-spa, lg-eng, lg-ell…) holds only that language's value, no frame; the
 * lg-nolan row holds the main's lg-nolan value (none for a translatable main)
 * and ALL its frames. The state at row R: lane X = the newest lane-X row with
 * id <= R; frames (+ lg-nolan value) = the newest lg-nolan row with id <= R.
 * The history list of language X shows lang IN (X, lg-nolan); each row's
 * preview is the reconstructed state; restoring a lane-X row puts X back from
 * the row and the frames as of it (other languages untouched, no orphan
 * frame); an lg-nolan row puts back the lg-nolan value and its frames.
 *
 * WHAT IS PROVEN (numbered as the task):
 *   1. a frame save on a main holding THREE languages writes exactly ONE row —
 *      lg-nolan, under the main, none under the slot (a bulk frame save: one
 *      pair, lg-nolan);
 *   2. a text save in one language writes ONE row in that lane only, unless it
 *      changed the frames (an item removed with its frame: + one lg-nolan row;
 *      an id still held by another language keeps its frame);
 *   3. the worked example (spa Casa, eng House, frames author, spa Casa grande,
 *      frames editor, eng Big house, frames translator): rows, lists, every
 *      listed row's preview in spa and eng, and restoring every row;
 *   4. the same over a TRANSLITERABLE main (with_lang_versions: an lg-nolan
 *      base + an lg-ell transliteration written by tool_lang's door);
 *   5. non-translatable relation (portal) and literal (number) mains: one
 *      composed lg-nolan row per save, main + frames;
 *   6. a bulk run over a translatable main with frames: pairs per lane, exact
 *      revert, exact revert-of-revert, and a per-lane conflict scope;
 *   7. PHP-era rows (a per-language main + frames row; an lg-nolan dataframe
 *      save row carrying every language) read under the rules.
 *
 * Pinned fix (2026-09-28): tool_lang's door (core/tools/translation.ts
 * translateItems) used to write a transliteration WITHOUT its source item's
 * `id`; the next base save stamped a fresh id on it — a real change of the
 * lg-ell lane, so that save wrote an lg-ell row beside its lg-nolan row, and
 * the frame of item 1 never paired the transliteration. Two tests of (4) pin
 * the fix.
 *
 * SITUATION: a `zztwl` scratch section on `test1` (→ matrix_test) with four
 * mains, each with its own slot; frame targets are runtime records of the
 * section. Everything is swept; the situation drop asserts zero residue.
 * assertTestDatabase first.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { sql } from '../../src/core/db/postgres.ts';
import { readFrameStateRowAt } from '../../src/core/db/time_machine.ts';
import { getMatrixTableFromTipo } from '../../src/core/ontology/resolver.ts';
import { resolveDataframeSlotTipos } from '../../src/core/relations/dataframe_slots.ts';
import { countTimeMachineData, readTimeMachineData } from '../../src/core/resolve/read_tm.ts';
import { runWithRequestLangs } from '../../src/core/resolve/request_lang.ts';
import { readComponentData } from '../../src/core/section/read.ts';
import { createSectionRecord } from '../../src/core/section/record/create_record.ts';
import { deleteSectionData } from '../../src/core/section/record/delete_record.ts';
import { duplicateSectionRecord } from '../../src/core/section/record/duplicate_record.ts';
import { saveComponentData } from '../../src/core/section/record/save_component.ts';
import { resolvePrincipal } from '../../src/core/security/permissions.ts';
import {
	dropSituation,
	ensureSituation,
	situation,
} from '../../src/core/test_data/situations/situation.ts';
import { assertTestDatabase } from '../../src/core/test_data/test_database_marker.ts';
import {
	previewLaneValue,
	readLaneValueAt,
	readRowLaneState,
} from '../../src/core/tm_record/lane_state.ts';
import { translateAndWrite } from '../../src/core/tools/translation.ts';
import { toolTimeMachineBulkRevert } from '../../tools/tool_time_machine/server/bulk_revert.ts';
import { toolTimeMachineApplyValue } from '../../tools/tool_time_machine/server/tool_time_machine.ts';
import { mustGet } from '../helpers/assert.ts';
import { insertLegacyBulkRow } from '../helpers/legacy_bulk_run.ts';
import { superuserTranslationGrant } from '../helpers/translation_grant.ts';

const TLD = 'zztwl';
const SECTION = `${TLD}1`;
const LMAIN = `${TLD}2`; // component_input_text, translatable, has_dataframe
const LSLOT = `${TLD}3`;
const XMAIN = `${TLD}4`; // component_input_text, NOT translatable, with_lang_versions, has_dataframe
const XSLOT = `${TLD}5`;
const PMAIN = `${TLD}6`; // component_portal (non-translatable relation main)
const PSLOT = `${TLD}7`;
const NMAIN = `${TLD}8`; // component_number (non-translatable literal main), has_dataframe
const NSLOT = `${TLD}9`;
const TPMAIN = `${TLD}10`; // component_portal whose ontology node says translatable — unsliced: lg-nolan lane only
const TPSLOT = `${TLD}11`;
const UMAIN = `${TLD}12`; // component_input_text, translatable, declares NO slot
const USLOT = `${TLD}13`; // a dataframe no main declares (parent: the section)
const IMAIN = `${TLD}14`; // component_iri, NOT translatable (its value in language lanes), has_dataframe
const ISLOT = `${TLD}15`;
const TABLE = 'matrix_test';
const USER_ID = -1;
const NOLAN = 'lg-nolan';
const SPA = 'lg-spa';
const ENG = 'lg-eng';
const FRA = 'lg-fra';
const ELL = 'lg-ell';

const SITUATION = situation({
	tld: TLD,
	name: 'tm_two_lanes',
	nodes: [
		{ tipo: SECTION, parent: 'test1', model: 'section', term: { 'lg-eng': 'Two lanes' } },
		{
			tipo: LMAIN,
			parent: SECTION,
			model: 'component_input_text',
			term: { 'lg-eng': 'Translatable main' },
			is_translatable: true,
			properties: { has_dataframe: true },
		},
		{ tipo: LSLOT, parent: LMAIN, model: 'component_dataframe', term: { 'lg-eng': 'L slot' } },
		{
			tipo: XMAIN,
			parent: SECTION,
			model: 'component_input_text',
			term: { 'lg-eng': 'Transliterable main' },
			properties: { has_dataframe: true, with_lang_versions: true },
		},
		{ tipo: XSLOT, parent: XMAIN, model: 'component_dataframe', term: { 'lg-eng': 'X slot' } },
		{
			tipo: PMAIN,
			parent: SECTION,
			model: 'component_portal',
			term: { 'lg-eng': 'Portal main' },
			properties: {
				source: {
					request_config: [
						{
							sqo: { section_tipo: [{ value: [SECTION], source: 'section' }] },
							show: { ddo_map: [{ tipo: PSLOT, parent: 'self', section_tipo: SECTION }] },
						},
					],
				},
			},
		},
		{ tipo: PSLOT, parent: PMAIN, model: 'component_dataframe', term: { 'lg-eng': 'P slot' } },
		{
			tipo: NMAIN,
			parent: SECTION,
			model: 'component_number',
			term: { 'lg-eng': 'Number main' },
			properties: { has_dataframe: true },
		},
		{ tipo: NSLOT, parent: NMAIN, model: 'component_dataframe', term: { 'lg-eng': 'N slot' } },
		{
			tipo: TPMAIN,
			parent: SECTION,
			model: 'component_portal',
			term: { 'lg-eng': 'Translatable portal main' },
			is_translatable: true,
			properties: {
				source: {
					request_config: [
						{
							sqo: { section_tipo: [{ value: [SECTION], source: 'section' }] },
							show: { ddo_map: [{ tipo: TPSLOT, parent: 'self', section_tipo: SECTION }] },
						},
					],
				},
			},
		},
		{ tipo: TPSLOT, parent: TPMAIN, model: 'component_dataframe', term: { 'lg-eng': 'TP slot' } },
		{
			tipo: UMAIN,
			parent: SECTION,
			model: 'component_input_text',
			term: { 'lg-eng': 'Undeclared-slot main' },
			is_translatable: true,
		},
		{ tipo: USLOT, parent: SECTION, model: 'component_dataframe', term: { 'lg-eng': 'U slot' } },
		{
			tipo: IMAIN,
			parent: SECTION,
			model: 'component_iri',
			term: { 'lg-eng': 'Iri main' },
			properties: { has_dataframe: true },
		},
		{ tipo: ISLOT, parent: IMAIN, model: 'component_dataframe', term: { 'lg-eng': 'I slot' } },
	],
});

type Item = Record<string, unknown>;

/** A main and its slot, with the column its value lives in. */
interface Main {
	tipo: string;
	slot: string;
	column: string;
}
const L: Main = { tipo: LMAIN, slot: LSLOT, column: 'string' };
const X: Main = { tipo: XMAIN, slot: XSLOT, column: 'string' };
const P: Main = { tipo: PMAIN, slot: PSLOT, column: 'relation' };
const N: Main = { tipo: NMAIN, slot: NSLOT, column: 'number' };
const TP: Main = { tipo: TPMAIN, slot: TPSLOT, column: 'relation' };
const U: Main = { tipo: UMAIN, slot: USLOT, column: 'string' };
const I: Main = { tipo: IMAIN, slot: ISLOT, column: 'iri' };
/** component_iri's FIXED label slot (its descriptor's fixedDataframeTipos) — the one its cells emit. */
const IL: Main = { tipo: IMAIN, slot: 'dd560', column: 'iri' };
/** The section dd560's frames target (the iri labels). */
const LABEL_SECTION = 'dd1706';

/** Frame roles: runtime records of the section a frame points at. */
const ROLES = ['author', 'editor', 'translator', 'reviewer'] as const;
type Role = (typeof ROLES)[number];
const roleTargets = new Map<Role, number>();
/**
 * Role by the LOCATOR a frame/portal item points at — section_tipo AND
 * section_id: the ids are per-section counters, so another section's record
 * (dd560's dd1706 labels) may hold the same id as a role target.
 */
const roleByLocator = new Map<string, Role>();
const locatorKey = (sectionTipo: unknown, sectionId: unknown): string =>
	`${String(sectionTipo)}_${Number(sectionId)}`;
const roleOf = (item: Item): Role | undefined =>
	roleByLocator.get(locatorKey(item.section_tipo, item.section_id));
const targetOf = (role: Role): number => mustGet(roleTargets.get(role), role);

// ---------------------------------------------------------------- lifecycle

beforeAll(async () => {
	await assertTestDatabase('tm_two_lanes_native');
	await ensureSituation(SITUATION);
	expect(await getMatrixTableFromTipo(SECTION)).toBe(TABLE);
	// STRUCTURE FLOOR: each main declares exactly its slot.
	for (const main of [L, X, P, N, TP]) {
		expect(await resolveDataframeSlotTipos(main.tipo)).toEqual([main.slot]);
	}
	expect(await resolveDataframeSlotTipos(UMAIN)).toEqual([]); // U's slot is undeclared
	for (const role of ROLES) {
		const id = await createSectionRecord(SECTION, USER_ID);
		roleTargets.set(role, id);
		roleByLocator.set(locatorKey(SECTION, id), role);
	}
}, 60_000);

const runs: number[] = [];
/** A section's activity rows (dd542: the audited address rides in misc dd551, never in `data`). */
const ACTIVITY_OF_SECTION = `matrix_activity WHERE section_tipo = 'dd542'
	   AND misc->'dd551'->0->'value'->>'section_tipo' = $1`;
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
	await sql.unsafe('DELETE FROM dedalo_ts_record_generation WHERE section_tipo = $1', [SECTION]);
	await sql.unsafe(`DELETE FROM "${TABLE}" WHERE section_tipo = $1`, [SECTION]);
	await sql.unsafe(`DELETE FROM ${ACTIVITY_OF_SECTION}`, [SECTION]);
	const residue = (await sql.unsafe(`SELECT count(*) AS n FROM ${ACTIVITY_OF_SECTION}`, [
		SECTION,
	])) as { n: number | string }[];
	expect(Number(residue[0]?.n)).toBe(0);
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
	extra: { bulk?: number | null; callerDataframe?: unknown } = {},
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
	});
	expect(saved.ok).toBe(true);
}

/** A literal item. */
const text = (itemId: number, lang: string, value: string): Item => ({ id: itemId, lang, value });

/** Replace the main's items of `lang` (set_data — the other languages stay). */
const setText = (main: Main, id: number, lang: string, items: Item[], bulk: number | null = null) =>
	save(id, main.tipo, lang, [{ action: 'set_data', value: items }], { bulk });

async function stored(id: number, column: string, key: string): Promise<unknown> {
	const rows = (await sql.unsafe(
		`SELECT (${column} ? $3) AS present, ${column}->$3 AS v FROM "${TABLE}"
		 WHERE section_tipo = $1 AND section_id = $2`,
		[SECTION, id, key],
	)) as { present: boolean | null; v: unknown }[];
	return rows[0]?.present === true ? rows[0]?.v : undefined;
}

const asList = (value: unknown): Item[] => (Array.isArray(value) ? (value as Item[]) : []);

/** The main's live frames (its own, in its slot). */
async function liveFrames(main: Main, id: number): Promise<Item[]> {
	return asList(await stored(id, 'relation', main.slot)).filter(
		(frame) => frame.main_component_tipo === main.tipo,
	);
}

function frameSave(main: Main, id: number, idKey: number, change: Item, bulk: number | null) {
	return save(id, main.slot, NOLAN, [change], {
		bulk,
		callerDataframe: { main_component_tipo: main.tipo, id_key: idKey },
	});
}

const addFrame = (main: Main, id: number, idKey: number, role: Role, bulk: number | null = null) =>
	frameSave(
		main,
		id,
		idKey,
		{
			action: 'insert',
			id: null,
			value: { section_tipo: SECTION, section_id: String(targetOf(role)) },
		},
		bulk,
	);

async function changeFrame(
	main: Main,
	id: number,
	idKey: number,
	role: Role,
	bulk: number | null = null,
) {
	const frame = mustGet(
		(await liveFrames(main, id)).find((f) => Number(f.id_key) === idKey),
		`the frame of ${idKey}`,
	);
	await frameSave(
		main,
		id,
		idKey,
		{ action: 'update', id: frame.id, value: { ...frame, section_id: String(targetOf(role)) } },
		bulk,
	);
}

/** tool_lang's door (translateAndWrite) with a scripted provider: `dictionary[source text]`. */
async function transliterate(
	main: Main,
	id: number,
	targetLang: string,
	dictionary: Record<string, string>,
): Promise<void> {
	const outcome = await translateAndWrite(await superuserTranslationGrant(SECTION, main.tipo, id), {
		model: 'component_input_text',
		sourceLang: NOLAN,
		targetLang,
		provider: async (req) => ({
			ok: true,
			text: dictionary[req.text] ?? `?${req.text}`,
			msg: 'ok',
		}),
		uri: 'test://transliterate',
		key: '',
	});
	expect(outcome.ok).toBe(true);
}

interface TmRow {
	id: number;
	lang: string | null;
	data: unknown;
}

/** The VISIBLE rows of `tipo` above a watermark, id ASC. */
async function visibleRows(tipo: string, id: number, after = 0): Promise<TmRow[]> {
	const rows = (await sql.unsafe(
		`SELECT id, lang, data FROM matrix_time_machine
		  WHERE section_tipo = $1 AND section_id = $2 AND tipo = $3 AND id > $4 AND tm_role IS NULL
		  ORDER BY id ASC`,
		[SECTION, id, tipo, after],
	)) as TmRow[];
	return rows.map((row) => ({ ...row, id: Number(row.id) }));
}

/** Every row (any role) under `tipo` at the address. */
async function anyRowCount(tipo: string, id: number): Promise<number> {
	const rows = (await sql.unsafe(
		`SELECT count(*)::int AS n FROM matrix_time_machine
		  WHERE section_tipo = $1 AND section_id = $2 AND tipo = $3`,
		[SECTION, id, tipo],
	)) as { n: number }[];
	return rows[0]?.n ?? 0;
}

/** The rows of a bulk run at the address: [tm_role, lang, data], id ASC. */
async function runRows(tipo: string, id: number, bulk: number) {
	return (await sql.unsafe(
		`SELECT tm_role, lang, data FROM matrix_time_machine
		  WHERE section_tipo = $1 AND section_id = $2 AND tipo = $3 AND bulk_process_id = $4
		  ORDER BY id ASC`,
		[SECTION, id, tipo, bulk],
	)) as { tm_role: number | null; lang: string; data: unknown }[];
}

async function watermark(): Promise<number> {
	const rows = (await sql.unsafe('SELECT COALESCE(MAX(id), 0) AS m FROM matrix_time_machine')) as {
		m: number;
	}[];
	return Number(rows[0]?.m ?? 0);
}

async function applyRow(main: Main, id: number, rowId: number, lang: string): Promise<void> {
	const response = await toolTimeMachineApplyValue({
		principal: await resolvePrincipal(USER_ID),
		userId: USER_ID,
		options: { section_tipo: SECTION, section_id: id, tipo: main.tipo, lang, matrix_id: rowId },
		background: false,
	});
	expect(response.ok).toBe(true);
}

interface RevertData {
	counter: number;
	bulk_process_id: number;
	exact: 'full' | 'partial' | 'none';
	skipped: unknown[];
}

async function revert(bulk: number): Promise<RevertData> {
	const response = await toolTimeMachineBulkRevert({
		principal: await resolvePrincipal(USER_ID),
		userId: USER_ID,
		options: { bulk_process_id: bulk },
		background: false,
	});
	expect(response.ok).toBe(true);
	const data = response.data as RevertData;
	runs.push(data.bulk_process_id);
	return data;
}

/** The tool's dd15 request for the history of `lang` (a locator carrying the lang). */
const historyRqo = (main: Main, id: number, lang: string) =>
	({
		sqo: {
			filter_by_locators: [{ section_tipo: SECTION, section_id: id, tipo: main.tipo, lang }],
			limit: 100,
		},
		source: { lang },
		show: { ddo_map: [{ tipo: main.tipo, section_tipo: 'dd15' }] },
	}) as never;

/** The history LIST of `lang`, row ids ASC — read in `dataLang` (the request's data language) when given. */
async function listed(main: Main, id: number, lang: string, dataLang?: string): Promise<number[]> {
	const read = () => readTimeMachineData(historyRqo(main, id, lang));
	const { data } =
		dataLang === undefined
			? await read()
			: await runWithRequestLangs({ applicationLang: ENG, dataLang }, read);
	const head = (data as { tipo?: string; entries?: { matrix_id?: number }[] }[]).find(
		(item) => item.tipo === 'dd15',
	);
	return (head?.entries ?? []).map((entry) => Number(entry.matrix_id)).sort((a, b) => a - b);
}

/** The PREVIEW pane of row `rowId` viewed in `lang`: the main's entries and its frames' roles. */
async function preview(
	main: Main,
	id: number,
	rowId: number,
	lang: string,
): Promise<{ values: string[]; frames: string[] }> {
	const items = (await runWithRequestLangs(
		{ applicationLang: ENG, dataLang: lang === NOLAN ? ENG : lang },
		() =>
			readComponentData({
				source: {
					tipo: main.tipo,
					section_tipo: SECTION,
					section_id: id,
					lang,
					mode: 'edit',
					data_source: 'tm',
					matrix_id: rowId,
				},
			} as never),
	)) as { tipo?: string; entries?: Item[] }[];
	const entriesOf = (tipo: string) =>
		items.filter((item) => item.tipo === tipo).flatMap((item) => item.entries ?? []);
	return {
		values: entriesOf(main.tipo).map((entry) => `${entry.lang}:${entry.value}`),
		frames: framesRoles(
			entriesOf(main.slot).filter((frame) => frame.main_component_tipo === main.tipo),
		),
	};
}

/** Frames as `id_key→role`, sorted — the comparable frame state. */
function framesRoles(frames: readonly Item[]): string[] {
	return frames.map((frame) => `${frame.id_key}→${roleOf(frame) ?? frame.section_id}`).sort();
}

/** The frames of a row image (dd490 entries of this main). */
const rowFrames = (main: Main, data: unknown): Item[] =>
	asList(data).filter((entry) => entry.type === 'dd490' && entry.main_component_tipo === main.tipo);

/** The main items of a row image (everything that is not a frame). */
const rowItems = (data: unknown): Item[] => asList(data).filter((entry) => entry.type !== 'dd490');

/** A text value lane of the live key: `lang:value` of its items, in order. */
async function liveLane(main: Main, id: number, lang: string): Promise<string[]> {
	return asList(await stored(id, main.column, main.tipo))
		.filter((item) => item.lang === lang)
		.map((item) => `${item.lang}:${item.value}`);
}

/** The whole comparable state of a text main: the given lanes + the frames. */
async function textState(
	main: Main,
	id: number,
	lanes: readonly string[],
): Promise<Record<string, string[]>> {
	const out: Record<string, string[]> = {};
	for (const lane of lanes) out[lane] = await liveLane(main, id, lane);
	out.frames = framesRoles(await liveFrames(main, id));
	return out;
}

// ---------------------------------------------------------------- 1 + 2: what a save writes

describe('WRITES: one row per lane touched, never a copy per language, never under the slot', () => {
	/** A translatable main holding item 1 in THREE languages, with item 1's frame. */
	async function threeLanguages(): Promise<number> {
		const id = await rec();
		await setText(L, id, SPA, [text(1, SPA, 'Casa')]);
		await setText(L, id, ENG, [text(1, ENG, 'House')]);
		await setText(L, id, FRA, [text(1, FRA, 'Maison')]);
		await addFrame(L, id, 1, 'author');
		// FLOOR: three languages, one frame
		expect(asList(await stored(id, 'string', LMAIN)).map((item) => item.lang)).toEqual([
			SPA,
			ENG,
			FRA,
		]);
		expect(framesRoles(await liveFrames(L, id))).toEqual(['1→author']);
		return id;
	}

	test('(1) a FRAME save (insert, update, remove) on a main holding three languages writes exactly ONE row each — lg-nolan, the frames only, under the main; none under the slot', async () => {
		const id = await threeLanguages();
		for (const step of [
			() => addFrame(L, id, 1, 'editor'),
			() => changeFrame(L, id, 1, 'translator'),
			async () => {
				const frame = mustGet((await liveFrames(L, id)).at(-1), 'a frame');
				await frameSave(L, id, 1, { action: 'remove', id: frame.id, value: null }, null);
			},
		]) {
			const mark = await watermark();
			await step();
			const rows = await visibleRows(LMAIN, id, mark);
			expect(rows.map((row) => row.lang)).toEqual([NOLAN]);
			const row = rows[0] as TmRow;
			// the lg-nolan lane of a translatable main: no value, ALL its frames
			expect(rowItems(row.data)).toEqual([]);
			expect(framesRoles(rowFrames(L, row.data))).toEqual(framesRoles(await liveFrames(L, id)));
			expect(await watermark()).toBe(mark + 1); // nothing else, anywhere
		}
		expect(await anyRowCount(LSLOT, id)).toBe(0);
	}, 60_000);

	test('(1) a BULK frame save writes ONE pair — the lg-nolan lane — whatever the number of languages', async () => {
		const id = await threeLanguages();
		const run = await mint();
		await addFrame(L, id, 1, 'editor', run);
		const rows = await runRows(LMAIN, id, run);
		expect(rows.map((row) => [row.tm_role, row.lang])).toEqual([
			[1, NOLAN],
			[null, NOLAN],
		]);
		expect(framesRoles(rowFrames(L, rows[0]?.data))).toEqual(['1→author']);
		expect(framesRoles(rowFrames(L, rows[1]?.data))).toEqual(['1→author', '1→editor']);
		expect(await anyRowCount(LSLOT, id)).toBe(0);
	}, 60_000);

	test('(2) a TEXT save in one language writes ONE row in that lane: its value only, no frame', async () => {
		const id = await threeLanguages();
		const mark = await watermark();
		await setText(L, id, SPA, [text(1, SPA, 'Casa grande')]);
		const rows = await visibleRows(LMAIN, id, mark);
		expect(rows.map((row) => [row.lang, row.data])).toEqual([[SPA, [text(1, SPA, 'Casa grande')]]]);
		expect(await watermark()).toBe(mark + 1);
		expect(framesRoles(await liveFrames(L, id))).toEqual(['1→author']); // untouched
	}, 60_000);

	test('(2) a text save REMOVING an item that has a frame writes its lane row AND one lg-nolan row (the stripped frames)', async () => {
		const id = await threeLanguages();
		await setText(L, id, SPA, [text(1, SPA, 'Casa'), text(2, SPA, 'Jardín')]);
		await addFrame(L, id, 2, 'editor');
		expect(framesRoles(await liveFrames(L, id))).toEqual(['1→author', '2→editor']); // FLOOR
		const mark = await watermark();
		await save(id, LMAIN, SPA, [{ action: 'remove', id: 2, value: null }]);
		expect(framesRoles(await liveFrames(L, id))).toEqual(['1→author']); // 2's frame went with it
		const rows = await visibleRows(LMAIN, id, mark);
		expect(rows.map((row) => row.lang).sort()).toEqual([NOLAN, SPA].sort());
		const spaRow = mustGet(
			rows.find((row) => row.lang === SPA),
			'the spa row',
		);
		const nolanRow = mustGet(
			rows.find((row) => row.lang === NOLAN),
			'the lg-nolan row',
		);
		expect(spaRow.data).toEqual([text(1, SPA, 'Casa')]);
		expect(rowItems(nolanRow.data)).toEqual([]);
		expect(framesRoles(rowFrames(L, nolanRow.data))).toEqual(['1→author']);
		expect(await anyRowCount(LSLOT, id)).toBe(0);
	}, 60_000);

	test('(2) a `remove` of an id held in three languages drops it in EVERY language: one row per lane it changed + ONE lg-nolan row (its frame stripped)', async () => {
		const id = await threeLanguages();
		const mark = await watermark();
		await save(id, LMAIN, SPA, [{ action: 'remove', id: 1, value: null }]);
		// FLOOR: the TS remove strips the id in all languages (save_component.ts cascadeAppliedRemoves)
		expect(await stored(id, 'string', LMAIN)).toEqual([]);
		expect(framesRoles(await liveFrames(L, id))).toEqual([]);
		const rows = await visibleRows(LMAIN, id, mark);
		expect(rows.map((row) => row.lang).sort()).toEqual([ENG, FRA, NOLAN, SPA]);
		for (const row of rows) expect(row.data).toEqual([]);
		expect(await anyRowCount(LSLOT, id)).toBe(0);
	}, 60_000);
});

// ---------------------------------------------------------------- 3: the worked example

/** One step of a worked example: the lane it must write, and the full state after it. */
interface Step {
	run: (id: number) => Promise<void>;
	lane: string;
	state: Record<string, string[]>;
}

/** One history row a driven step wrote, with the (literal) state at it. */
interface Entry {
	step: number;
	rowId: number;
	lane: string;
	state: Record<string, string[]>;
}

/** What driving the steps recorded: every row written, and the lanes each step wrote. */
interface Driven {
	entries: Entry[];
	lanesPerStep: { step: number; lanes: string[] }[];
}

/**
 * Drive the steps. After each: the live state equals the step's literal state
 * (asserted here — the situation is void otherwise); the lanes the step wrote
 * are COLLECTED (asserted by the caller's own test, so one wrong lane does not
 * hide the reconstruction checks); every row written is an Entry at the
 * step's state.
 */
async function drive(
	main: Main,
	id: number,
	steps: readonly Step[],
	lanes: readonly string[],
): Promise<Driven> {
	const driven: Driven = { entries: [], lanesPerStep: [] };
	for (const [n, step] of steps.entries()) {
		const mark = await watermark();
		await step.run(id);
		const rows = await visibleRows(main.tipo, id, mark);
		expect(rows.length).toBeGreaterThan(0); // FLOOR: every step changed something — it is recorded
		driven.lanesPerStep.push({ step: n + 1, lanes: rows.map((row) => row.lang ?? '') });
		// the row of the step's OWN lane is the entry (a stray extra row, if any,
		// is reported by lanesPerStep — its state is not the step's)
		for (const row of rows.filter((r) => (r.lang ?? '') === step.lane)) {
			driven.entries.push({ step: n + 1, rowId: row.id, lane: step.lane, state: step.state });
		}
		expect({ step: n + 1, ...(await textState(main, id, lanes)) }).toEqual({
			step: n + 1,
			...step.state,
		});
	}
	expect(await anyRowCount(main.slot, id)).toBe(0);
	return driven;
}

/** The lanes each step MUST write (one row, its lane). */
const lanesWanted = (steps: readonly Step[]) =>
	steps.map((step, n) => ({ step: n + 1, lanes: [step.lane] }));

/**
 * Apply every row in turn (newest first, then oldest first) and assert the
 * contract outcome from the steps' own literal states: the row's lane from the
 * state at it (an lg-nolan row of a translatable main: no value), the frames
 * as of it, every other lane exactly as it was before the apply. Then the
 * restore's OWN rows follow the write rule: the row's lane (a save always
 * writes its own lane), plus an lg-nolan row exactly when the frame lane (the
 * frames, or a transliterable main's lg-nolan base) changed — nothing else.
 */
async function applyEveryRow(
	main: Main,
	id: number,
	entries: readonly Entry[],
	lanes: readonly string[],
	opts: { nolanHoldsValue: boolean; viewLang: (lane: string) => string },
) {
	const order = [...entries].reverse().concat(entries);
	const states: { got: unknown[]; want: unknown[] } = { got: [], want: [] };
	const rules: { got: unknown[]; want: unknown[] } = { got: [], want: [] };
	for (const entry of order) {
		const tag = { step: entry.step, lane: entry.lane };
		const before = await textState(main, id, lanes);
		const expected: Record<string, string[]> = { ...before, frames: entry.state.frames ?? [] };
		if (entry.lane !== NOLAN || opts.nolanHoldsValue) {
			expected[entry.lane] = entry.state[entry.lane] ?? [];
		}
		const mark = await watermark();
		await applyRow(main, id, entry.rowId, opts.viewLang(entry.lane));
		const after = await textState(main, id, lanes);
		states.got.push({ ...tag, ...after });
		states.want.push({ ...tag, ...expected });
		const written = (await visibleRows(main.tipo, id, mark)).map((row) => row.lang ?? '');
		const frameLaneChanged =
			JSON.stringify(before.frames) !== JSON.stringify(after.frames) ||
			(opts.nolanHoldsValue && JSON.stringify(before[NOLAN]) !== JSON.stringify(after[NOLAN]));
		// a save ALWAYS writes its own lane (the restored row's), plus the
		// lg-nolan lane only when the frame lane changed
		rules.got.push({ ...tag, written: [...written].sort() });
		rules.want.push({
			...tag,
			written: [...new Set([entry.lane, ...(frameLaneChanged ? [NOLAN] : [])])].sort(),
		});
	}
	expect(states.got).toEqual(states.want);
	expect(rules.got).toEqual(rules.want);
}

describe('(3) THE WORKED EXAMPLE — spa Casa, eng House, frames author, spa Casa grande, frames editor, eng Big house, frames translator', () => {
	const STEPS: Step[] = [
		{
			run: (id) => setText(L, id, SPA, [text(1, SPA, 'Casa')]),
			lane: SPA,
			state: { [SPA]: ['lg-spa:Casa'], [ENG]: [], frames: [] },
		},
		{
			run: (id) => setText(L, id, ENG, [text(1, ENG, 'House')]),
			lane: ENG,
			state: { [SPA]: ['lg-spa:Casa'], [ENG]: ['lg-eng:House'], frames: [] },
		},
		{
			run: (id) => addFrame(L, id, 1, 'author'),
			lane: NOLAN,
			state: { [SPA]: ['lg-spa:Casa'], [ENG]: ['lg-eng:House'], frames: ['1→author'] },
		},
		{
			run: (id) => setText(L, id, SPA, [text(1, SPA, 'Casa grande')]),
			lane: SPA,
			state: { [SPA]: ['lg-spa:Casa grande'], [ENG]: ['lg-eng:House'], frames: ['1→author'] },
		},
		{
			run: (id) => changeFrame(L, id, 1, 'editor'),
			lane: NOLAN,
			state: { [SPA]: ['lg-spa:Casa grande'], [ENG]: ['lg-eng:House'], frames: ['1→editor'] },
		},
		{
			run: (id) => setText(L, id, ENG, [text(1, ENG, 'Big house')]),
			lane: ENG,
			state: { [SPA]: ['lg-spa:Casa grande'], [ENG]: ['lg-eng:Big house'], frames: ['1→editor'] },
		},
		{
			run: (id) => changeFrame(L, id, 1, 'translator'),
			lane: NOLAN,
			state: {
				[SPA]: ['lg-spa:Casa grande'],
				[ENG]: ['lg-eng:Big house'],
				frames: ['1→translator'],
			},
		},
	];
	const LANES = [SPA, ENG];

	let id = 0;
	let driven: Driven = { entries: [], lanesPerStep: [] };
	beforeAll(async () => {
		id = await rec();
		driven = await drive(L, id, STEPS, LANES);
	}, 60_000);

	test('seven saves → seven rows: spa, eng, lg-nolan, spa, lg-nolan, eng, lg-nolan; language rows are the value only, lg-nolan rows the frames only', async () => {
		expect(driven.lanesPerStep).toEqual(lanesWanted(STEPS));
		const rows = await visibleRows(LMAIN, id);
		expect(rows.map((row) => row.id)).toEqual(driven.entries.map((entry) => entry.rowId));
		const images = rows.map((row) =>
			row.lang === NOLAN
				? { items: rowItems(row.data), frames: framesRoles(rowFrames(L, row.data)) }
				: row.data,
		);
		expect(images).toEqual([
			[text(1, SPA, 'Casa')],
			[text(1, ENG, 'House')],
			{ items: [], frames: ['1→author'] },
			[text(1, SPA, 'Casa grande')],
			{ items: [], frames: ['1→editor'] },
			[text(1, ENG, 'Big house')],
			{ items: [], frames: ['1→translator'] },
		]);
	});

	test('the history LIST of spa is lang IN (spa, lg-nolan); of eng, lang IN (eng, lg-nolan)', async () => {
		const pick = (lanes: string[]) =>
			driven.entries.filter((entry) => lanes.includes(entry.lane)).map((entry) => entry.rowId);
		expect(await listed(L, id, SPA)).toEqual(pick([SPA, NOLAN]));
		expect(await listed(L, id, ENG)).toEqual(pick([ENG, NOLAN]));
	});

	test('every LISTED row previews, in spa and in eng, exactly the reconstructed state at it (middle states visible)', async () => {
		for (const view of LANES) {
			const got: unknown[] = [];
			const want: unknown[] = [];
			for (const entry of driven.entries) {
				if (entry.lane !== view && entry.lane !== NOLAN) continue; // not in this list
				const shown = await preview(L, id, entry.rowId, view);
				got.push({ view, step: entry.step, ...shown });
				want.push({
					view,
					step: entry.step,
					values: entry.state[view],
					frames: entry.state.frames,
				});
			}
			expect(got).toEqual(want);
		}
	}, 60_000);

	test('restoring EVERY row in turn gives exactly the state at it in its lane + the frames as of it, the other language untouched; the restore writes rows under the same rule', async () => {
		await applyEveryRow(L, id, driven.entries, LANES, {
			nolanHoldsValue: false,
			viewLang: (lane) => (lane === NOLAN ? SPA : lane),
		});
	}, 120_000);

	test('restoring, for each row, the newest row AS OF it in every lane rebuilds the FULL state at it', async () => {
		const got: unknown[] = [];
		const want: unknown[] = [];
		for (const target of driven.entries) {
			if (target.step < 2) continue; // eng is empty at step 1: no eng row to restore
			const upTo = driven.entries.filter((entry) => entry.rowId <= target.rowId);
			for (const lane of [SPA, ENG, NOLAN]) {
				const newest = upTo.filter((entry) => entry.lane === lane).at(-1);
				if (newest !== undefined) await applyRow(L, id, newest.rowId, lane === NOLAN ? SPA : lane);
			}
			got.push({ step: target.step, ...(await textState(L, id, LANES)) });
			want.push({ step: target.step, ...target.state });
		}
		expect(got).toEqual(want);
	}, 120_000);

	test('a frame of an item that no longer exists in ANY language is never written back by a restore (no orphan)', async () => {
		const other = await rec();
		await setText(L, other, SPA, [text(1, SPA, 'Casa'), text(2, SPA, 'Jardín')]);
		await setText(L, other, ENG, [text(1, ENG, 'House')]);
		await addFrame(L, other, 1, 'author');
		await addFrame(L, other, 2, 'editor');
		const frameRow = mustGet(
			(await visibleRows(LMAIN, other)).at(-1),
			'the lg-nolan row of both frames',
		);
		expect(framesRoles(rowFrames(L, frameRow.data))).toEqual(['1→author', '2→editor']); // FLOOR
		await changeFrame(L, other, 1, 'reviewer');
		await save(other, LMAIN, SPA, [{ action: 'remove', id: 2, value: null }]); // 2 exists nowhere now
		expect(framesRoles(await liveFrames(L, other))).toEqual(['1→reviewer']); // FLOOR
		// restoring the lg-nolan row: its frames — but 2 exists in no language: its frame stays out
		await applyRow(L, other, frameRow.id, SPA);
		expect(framesRoles(await liveFrames(L, other))).toEqual(['1→author']);
		expect(await liveLane(L, other, SPA)).toEqual(['lg-spa:Casa']);
	}, 60_000);
});

// ---------------------------------------------------------------- 4: transliterable

describe('(4) a TRANSLITERABLE main (with_lang_versions: lg-nolan base + lg-ell transliteration) with frames', () => {
	const GREEK: Record<string, string> = {
		Augustus: 'Αύγουστος',
		'Augustus Caesar': 'Αύγουστος Καίσαρ',
	};
	const STEPS: Step[] = [
		{
			run: (id) => setText(X, id, NOLAN, [text(1, NOLAN, 'Augustus')]),
			lane: NOLAN,
			state: { [NOLAN]: ['lg-nolan:Augustus'], [ELL]: [], frames: [] },
		},
		{
			run: (id) => transliterate(X, id, ELL, GREEK),
			lane: ELL,
			state: { [NOLAN]: ['lg-nolan:Augustus'], [ELL]: ['lg-ell:Αύγουστος'], frames: [] },
		},
		{
			run: (id) => addFrame(X, id, 1, 'author'),
			lane: NOLAN,
			state: {
				[NOLAN]: ['lg-nolan:Augustus'],
				[ELL]: ['lg-ell:Αύγουστος'],
				frames: ['1→author'],
			},
		},
		{
			run: (id) => setText(X, id, NOLAN, [text(1, NOLAN, 'Augustus Caesar')]),
			lane: NOLAN,
			state: {
				[NOLAN]: ['lg-nolan:Augustus Caesar'],
				[ELL]: ['lg-ell:Αύγουστος'],
				frames: ['1→author'],
			},
		},
		{
			run: (id) => transliterate(X, id, ELL, GREEK),
			lane: ELL,
			state: {
				[NOLAN]: ['lg-nolan:Augustus Caesar'],
				[ELL]: ['lg-ell:Αύγουστος Καίσαρ'],
				frames: ['1→author'],
			},
		},
		{
			run: (id) => changeFrame(X, id, 1, 'editor'),
			lane: NOLAN,
			state: {
				[NOLAN]: ['lg-nolan:Augustus Caesar'],
				[ELL]: ['lg-ell:Αύγουστος Καίσαρ'],
				frames: ['1→editor'],
			},
		},
	];
	const LANES = [NOLAN, ELL];

	let id = 0;
	let driven: Driven = { entries: [], lanesPerStep: [] };
	beforeAll(async () => {
		id = await rec();
		driven = await drive(X, id, STEPS, LANES);
	}, 60_000);

	test('each save writes ONE row in its lane: a base save lg-nolan, a transliteration lg-ell, a frame save lg-nolan', async () => {
		expect(driven.lanesPerStep).toEqual(lanesWanted(STEPS));
	});

	test('tool_lang’s transliteration keeps the SOURCE item id (the transliteration of item 1 is item 1: its frame pairs both)', async () => {
		const id2 = await rec();
		await setText(X, id2, NOLAN, [text(1, NOLAN, 'Augustus')]);
		await transliterate(X, id2, ELL, GREEK);
		expect(asList(await stored(id2, 'string', XMAIN))).toEqual([
			text(1, NOLAN, 'Augustus'),
			text(1, ELL, 'Αύγουστος'),
		]);
	});

	test('rows: the lg-nolan lane carries the BASE value + the frames; the lg-ell lane the transliteration only', async () => {
		const ids = new Set(driven.entries.map((entry) => entry.rowId));
		const rows = (await visibleRows(XMAIN, id)).filter((row) => ids.has(row.id));
		expect(rows.map((row) => row.id)).toEqual(driven.entries.map((entry) => entry.rowId));
		expect(
			rows.map((row) => ({
				lane: row.lang,
				items: rowItems(row.data).map((item) => `${item.lang}:${item.value}`),
				frames: framesRoles(rowFrames(X, row.data)),
			})),
		).toEqual(
			driven.entries.map((entry) =>
				entry.lane === NOLAN
					? { lane: NOLAN, items: entry.state[NOLAN] ?? [], frames: entry.state.frames ?? [] }
					: { lane: entry.lane, items: entry.state[entry.lane] ?? [], frames: [] as string[] },
			),
		);
	});

	test('the history LIST of lg-ell is lang IN (lg-ell, lg-nolan): every row; the TOOL’s lg-nolan request is read in the data language — every row when working in Greek, the base rows when working in Spanish', async () => {
		const all = await visibleRows(XMAIN, id);
		const nolanRows = all.filter((row) => row.lang === NOLAN).map((row) => row.id);
		expect(nolanRows.length).toBeLessThan(all.length); // FLOOR: lg-ell rows exist
		expect(await listed(X, id, ELL)).toEqual(all.map((row) => row.id));
		// the tool asks a transliterable main in lg-nolan (its context lang)
		expect(await listed(X, id, NOLAN, ELL)).toEqual(all.map((row) => row.id));
		expect(await listed(X, id, NOLAN, SPA)).toEqual(nolanRows);
	});

	test('the history LIST cell of every lg-nolan row, listed in lg-ell, is the BASE value the row records — its own lg-nolan items, never grafted from the lg-ell lane', async () => {
		const { data } = await readTimeMachineData(historyRqo(X, id, ELL));
		const cells = new Map<number, string[]>();
		for (const item of data as { tipo?: string; section_id?: number; entries?: Item[] }[]) {
			if (item.tipo !== XMAIN) continue;
			cells.set(
				Number(item.section_id),
				(item.entries ?? []).map((entry) => `${entry.lang}:${entry.value}`),
			);
		}
		const nolanEntries = driven.entries.filter((entry) => entry.lane === NOLAN);
		expect(nolanEntries).toHaveLength(4); // FLOOR
		for (const entry of nolanEntries) {
			expect(cells.get(entry.rowId)).toEqual(entry.state[NOLAN] ?? []);
		}
	});

	test('the history LIST cell of every lg-ell row, listed in lg-ell, is the VERSION the row records — its own entries, never an empty base slice serving it as a fallback', async () => {
		// read_tm laneCellLang pins a TRANSLITERABLE's cell to the row's audit
		// lang: an un-pinned cell would be the instance's lg-nolan base
		// (elementLang), read off an lg-ell row that holds only lg-ell items —
		// entries [] and the version shown as a missing-translation fallback.
		const { data } = await readTimeMachineData(historyRqo(X, id, ELL));
		const cells = new Map<number, { lang?: string; entries: string[]; fallback: unknown }>();
		for (const item of data as {
			tipo?: string;
			section_id?: number;
			lang?: string;
			entries?: Item[];
			fallback_value?: unknown;
		}[]) {
			if (item.tipo !== XMAIN) continue;
			cells.set(Number(item.section_id), {
				lang: item.lang,
				entries: (item.entries ?? []).map((entry) => `${entry.lang}:${entry.value}`),
				fallback: item.fallback_value ?? null,
			});
		}
		const ellEntries = driven.entries.filter((entry) => entry.lane === ELL);
		expect(ellEntries).toHaveLength(2); // FLOOR
		for (const entry of ellEntries) {
			expect(cells.get(entry.rowId)).toEqual({
				lang: ELL,
				entries: entry.state[ELL] ?? ['(no lg-ell state)'],
				fallback: null,
			});
		}
	});

	test('every row previews, viewed in lg-nolan (the edit form’s BASE instance), the BASE AS OF it + the frames as of it', async () => {
		// The base instance's preview door: an lg-ell row must not show the
		// version, and an old row must not show the LIVE base — the base lane
		// reconstructed as of each row ('Augustus' before step 4, 'Augustus
		// Caesar' after; the live base is the latter, so the early rows tell).
		const got: unknown[] = [];
		const want: unknown[] = [];
		for (const entry of driven.entries) {
			const shown = await preview(X, id, entry.rowId, NOLAN);
			got.push({ step: entry.step, ...shown });
			want.push({ step: entry.step, values: entry.state[NOLAN] ?? [], frames: entry.state.frames });
		}
		expect(
			new Set(want.map((row) => JSON.stringify((row as { values: unknown }).values))).size,
		).toBe(2); // FLOOR: two distinct bases as of the rows
		expect(got).toEqual(want);
	}, 60_000);

	test('every row previews, viewed in lg-ell, the lg-ell VERSION AS OF it + the frames as of it (an explicit lg-ell read of a transliterable serves its lg-ell lane)', async () => {
		// An EXPLICIT lang on a component read is the tool_lang target's ask
		// (resolver.ts elementLang): the LIVE read of a with_lang_versions main
		// in lg-ell serves its lg-ell version — never the base as its entries.
		const live = await runWithRequestLangs({ applicationLang: ENG, dataLang: ELL }, () =>
			readComponentData({
				source: { tipo: XMAIN, section_tipo: SECTION, section_id: id, lang: ELL, mode: 'edit' },
			} as never),
		);
		const liveMain = (live as { tipo?: string; lang?: string; entries?: Item[] }[]).find(
			(item) => item.tipo === XMAIN,
		);
		expect(liveMain?.lang).toBe(ELL);
		expect((liveMain?.entries ?? []).map((entry) => `${entry.lang}:${entry.value}`)).toEqual(
			driven.entries.at(-1)?.state[ELL] ?? ['(no final state)'],
		);
		expect(JSON.stringify(live)).toContain('Αύγουστος');
		// …and carries its lg-nolan BASE as `transliterate_value` (the version
		// instance's counterpart — what the translator transliterates from;
		// WC-2026-10-31-transliterate-value-emitted).
		const counterpart = (liveMain as { transliterate_value?: Item[] | null } | undefined)
			?.transliterate_value;
		expect(Array.isArray(counterpart)).toBe(true);
		expect((counterpart ?? []).map((entry) => `${entry.lang}:${entry.value}`)).toEqual(
			driven.entries.at(-1)?.state[NOLAN] ?? ['(no final base)'],
		);
		const got: unknown[] = [];
		const want: unknown[] = [];
		for (const entry of driven.entries) {
			const shown = await preview(X, id, entry.rowId, ELL);
			got.push({ step: entry.step, ...shown });
			want.push({ step: entry.step, values: entry.state[ELL] ?? [], frames: entry.state.frames });
		}
		expect(got).toEqual(want);
	}, 60_000);

	test('restoring EVERY row in turn: an lg-nolan row puts back the base + its frames; an lg-ell row the transliteration + the frames as of it; the other lane untouched', async () => {
		await applyEveryRow(X, id, driven.entries, LANES, {
			nolanHoldsValue: true,
			viewLang: () => ELL,
		});
	}, 120_000);
});

// ---------------------------------------------------------------- 5: non-translatable mains

describe('(5) NON-translatable mains (relation + literal): one composed lg-nolan row per save, main + frames', () => {
	const portalItem = (itemId: number, role: Role): Item => ({
		id: itemId,
		type: 'dd151',
		section_tipo: SECTION,
		section_id: targetOf(role),
		from_component_tipo: PMAIN,
	});
	const numberItem = (itemId: number, value: number): Item => ({ id: itemId, lang: NOLAN, value });
	const cases: { name: string; main: Main; items: (v: number) => Item[] }[] = [
		{
			name: 'portal',
			main: P,
			items: (v) => (v === 1 ? [portalItem(1, 'author')] : [portalItem(1, 'reviewer')]),
		},
		{ name: 'number', main: N, items: (v) => [numberItem(1, 100 + v)] },
	];
	for (const c of cases) {
		test(`${c.name}: main save, frame save, main change, frame change — each ONE lg-nolan row = the live main + all frames; restoring an old one restores both`, async () => {
			const id = await rec();
			const main = c.main;
			const rowIds: number[] = [];
			const images: unknown[] = [];
			for (const step of [
				() => save(id, main.tipo, NOLAN, [{ action: 'set_data', value: c.items(1) }]),
				() => addFrame(main, id, 1, 'author'),
				() => save(id, main.tipo, NOLAN, [{ action: 'set_data', value: c.items(2) }]),
				() => changeFrame(main, id, 1, 'editor'),
			]) {
				const mark = await watermark();
				await step();
				const rows = await visibleRows(main.tipo, id, mark);
				expect(rows.map((row) => row.lang)).toEqual([NOLAN]);
				const row = rows[0] as TmRow;
				const liveMain = asList(await stored(id, main.column, main.tipo));
				expect(rowItems(row.data)).toEqual(liveMain);
				expect(framesRoles(rowFrames(main, row.data))).toEqual(
					framesRoles(await liveFrames(main, id)),
				);
				rowIds.push(row.id);
				images.push({
					main: liveMain,
					frames: framesRoles(await liveFrames(main, id)),
				});
			}
			expect(await anyRowCount(main.slot, id)).toBe(0);
			// restore row 2 (item v1 + author): both come back together
			await applyRow(main, id, rowIds[1] as number, NOLAN);
			expect({
				main: asList(await stored(id, main.column, main.tipo)),
				frames: framesRoles(await liveFrames(main, id)),
			}).toEqual(images[1] as never);
			// restore row 1 (item v1, no frame yet): the frames are emptied
			await applyRow(main, id, rowIds[0] as number, NOLAN);
			expect(framesRoles(await liveFrames(main, id))).toEqual([]);
		}, 60_000);
	}
});

// ---------------------------------------------------------------- 6: bulk

describe('(6) a BULK run over a translatable main with frames: pairs per lane, exact revert, exact revert-of-revert', () => {
	/** spa item 1 + spa-only item 2, eng item 1, frames 1→author and 2→editor. */
	async function preRun(): Promise<number> {
		const id = await rec();
		await setText(L, id, SPA, [text(1, SPA, 'Casa'), text(2, SPA, 'Jardín')]);
		await setText(L, id, ENG, [text(1, ENG, 'House')]);
		await addFrame(L, id, 1, 'author');
		await addFrame(L, id, 2, 'editor');
		return id;
	}

	async function fullKey(id: number) {
		return {
			value: asList(await stored(id, 'string', LMAIN))
				.map((item) => `${item.lang}:${item.id}:${item.value}`)
				.sort(),
			frames: framesRoles(await liveFrames(L, id)),
		};
	}

	test('the undo log follows the lanes; the revert restores the pre-run state exactly and its revert the post-run state', async () => {
		const id = await preRun();
		const pre = await fullKey(id);
		const run = await mint();
		await save(id, LMAIN, SPA, [{ action: 'remove', id: 2, value: null }], { bulk: run }); // strips its frame
		await setText(L, id, SPA, [text(1, SPA, 'Casa roja')], run);
		await setText(L, id, ENG, [text(1, ENG, 'Red house')], run);
		await changeFrame(L, id, 1, 'translator', run);
		const post = await fullKey(id);
		expect(post).toEqual({
			value: ['lg-eng:1:Red house', 'lg-spa:1:Casa roja'],
			frames: ['1→translator'],
		}); // FLOOR
		const rows = await runRows(LMAIN, id, run);
		expect(rows.length).toBeGreaterThan(0); // FLOOR: the run left its undo log
		const hidden = rows.filter((row) => row.tm_role === 1);
		const visible = rows.filter((row) => row.tm_role === null);
		// remove: lg-nolan (item 2's frame stripped — the frame lane FIRST) + spa; spa save: spa; eng save: eng; frame change: lg-nolan
		expect(hidden.map((row) => row.lang)).toEqual([NOLAN, SPA, SPA, ENG, NOLAN]);
		expect(visible.map((row) => row.lang)).toEqual([NOLAN, SPA, SPA, ENG, NOLAN]);
		for (const row of rows) {
			if (row.lang === NOLAN)
				expect(rowItems(row.data)).toEqual([]); // no value in the frame lane
			else expect(rowFrames(L, row.data)).toEqual([]); // no frame in a language lane
		}
		expect(await anyRowCount(LSLOT, id)).toBe(0);
		const data = await revert(run);
		expect(data.skipped).toEqual([]);
		expect(data.exact).toBe('full');
		expect(await fullKey(id)).toEqual(pre);
		const again = await revert(data.bulk_process_id);
		expect(again.skipped).toEqual([]);
		expect(again.exact).toBe('full');
		expect(await fullKey(id)).toEqual(post);
	}, 60_000);

	test('conflicts are per LANE: a language the run never touched, edited after it, is kept — the run’s lanes still revert', async () => {
		const id = await preRun();
		const run = await mint();
		await setText(L, id, SPA, [text(1, SPA, 'Casa roja'), text(2, SPA, 'Jardín')], run);
		await changeFrame(L, id, 1, 'translator', run);
		await setText(L, id, ENG, [text(1, ENG, 'Curator house')]); // after the run, not in it
		const data = await revert(run);
		expect(data.skipped).toEqual([]);
		expect(data.exact).toBe('full');
		expect(await fullKey(id)).toEqual({
			value: ['lg-eng:1:Curator house', 'lg-spa:1:Casa', 'lg-spa:2:Jardín'],
			frames: ['1→author', '2→editor'],
		});
	}, 60_000);

	test('a TRANSLATABLE-flagged portal (unsliced) with a slot, saved from spa, eng, spa requests in ONE run: every pair is lg-nolan, ONE chain — the revert is exact, never interleaved_write', async () => {
		const locator = (role: Role): Item => ({
			type: 'dd151',
			section_tipo: SECTION,
			section_id: String(targetOf(role)),
			from_component_tipo: TPMAIN,
		});
		const portalSave = (id: number, lang: string, value: Item[], bulk: number | null) =>
			runWithRequestLangs({ applicationLang: ENG, dataLang: lang }, () =>
				save(id, TPMAIN, lang, [{ action: 'set_data', value }], { bulk }),
			);
		const portalState = async (id: number) => ({
			value: asList(await stored(id, 'relation', TPMAIN)).map((item) => roleOf(item)),
			frames: framesRoles(await liveFrames(TP, id)),
		});
		const id = await rec();
		await portalSave(id, SPA, [locator('author')], null);
		const authorItem = mustGet(asList(await stored(id, 'relation', TPMAIN))[0], 'the author item');
		await addFrame(TP, id, Number(authorItem.id), 'editor');
		const pre = await portalState(id);
		const run = await mint();
		const current = () => stored(id, 'relation', TPMAIN).then(asList);
		await portalSave(id, SPA, [...(await current()), locator('reviewer')], run);
		await portalSave(id, ENG, [...(await current()), locator('translator')], run);
		await portalSave(
			id,
			SPA,
			(await current()).filter((item) => Number(item.section_id) !== targetOf('reviewer')),
			run,
		);
		const post = await portalState(id);
		expect(post.value).toEqual(['author', 'translator']); // FLOOR
		// decision 2026-09-29: a relation's lane is lg-nolan whatever the request language
		expect((await runRows(TPMAIN, id, run)).map((row) => row.lang)).toEqual([
			NOLAN,
			NOLAN,
			NOLAN,
			NOLAN,
			NOLAN,
			NOLAN,
		]);
		const data = await revert(run);
		expect(data.skipped).toEqual([]);
		expect(data.exact).toBe('full');
		expect(await portalState(id)).toEqual(pre);
		const again = await revert(data.bulk_process_id);
		expect(again.skipped).toEqual([]);
		expect(await portalState(id)).toEqual(post);
	}, 60_000);
});

// ---------------------------------------------------------------- 7: PHP-era rows

describe('(7) PHP-era rows read under the rules', () => {
	const phpRow = (main: Main, id: number, lang: string, data: unknown[]) =>
		insertLegacyBulkRow({
			sectionTipo: SECTION,
			sectionId: id,
			tipo: main.tipo,
			lang,
			bulkId: null,
			data,
		});

	const phpFrame = (main: Main, frameId: number, idKey: number, role: Role): Item => ({
		id: frameId,
		type: 'dd490',
		id_key: idKey,
		section_tipo: SECTION,
		section_id: targetOf(role),
		from_component_tipo: main.slot,
		main_component_tipo: main.tipo,
	});

	/** spa Casa + eng House (item 1) with 1→author, all engine-written. */
	async function engineRecord(): Promise<number> {
		const id = await rec();
		await setText(L, id, SPA, [text(1, SPA, 'Casa')]);
		await setText(L, id, ENG, [text(1, ENG, 'House')]);
		await addFrame(L, id, 1, 'author');
		return id;
	}

	test('a PHP MAIN save (one language’s value + the frames): its lane’s value AND its frames — previewed and restored; the other language untouched', async () => {
		const id = await engineRecord();
		const row = await phpRow(L, id, SPA, [text(1, SPA, 'Casa vieja'), phpFrame(L, 1, 1, 'editor')]);
		expect(await preview(L, id, row, SPA)).toEqual({
			values: ['lg-spa:Casa vieja'],
			frames: ['1→editor'],
		});
		await applyRow(L, id, row, SPA);
		expect(await textState(L, id, [SPA, ENG])).toEqual({
			[SPA]: ['lg-spa:Casa vieja'],
			[ENG]: ['lg-eng:House'],
			frames: ['1→editor'],
		});
	}, 60_000);

	test('a PHP main save row IS a frame state: a later engine language row reads its frames as of it', async () => {
		// The live frames are the PHP row's (written without history), so the
		// PHP row answers for them: the eng save records no baseline.
		const id = await rec();
		await setText(L, id, SPA, [text(1, SPA, 'Casa')]);
		await setText(L, id, ENG, [text(1, ENG, 'House')]);
		await seedKey(id, 'relation', L.slot, [phpFrame(L, 1, 1, 'editor')]);
		await phpRow(L, id, SPA, [text(1, SPA, 'Casa vieja'), phpFrame(L, 1, 1, 'editor')]);
		const mark = await watermark();
		await setText(L, id, ENG, [text(1, ENG, 'Big house')]);
		const rows = await visibleRows(LMAIN, id, mark);
		expect(rows.map((row) => row.lang)).toEqual([ENG]); // FLOOR: one frameless language row
		const engRow = mustGet(rows[0], 'the engine eng row');
		await changeFrame(L, id, 1, 'author'); // live ≠ the state at the eng row
		expect(await preview(L, id, engRow.id, ENG)).toEqual({
			values: ['lg-eng:Big house'],
			frames: ['1→editor'],
		});
		await applyRow(L, id, engRow.id, ENG);
		expect(framesRoles(await liveFrames(L, id))).toEqual(['1→editor']);
	}, 60_000);

	test('a PHP DATAFRAME save row (lg-nolan, the main in EVERY language + the frames) is the lg-nolan lane: its frames only on a translatable main — the languages it carries are ignored', async () => {
		const id = await engineRecord();
		await setText(L, id, SPA, [text(1, SPA, 'Casa grande')]);
		const row = await phpRow(L, id, NOLAN, [
			text(1, SPA, 'Casa PHP'),
			text(1, ENG, 'House PHP'),
			phpFrame(L, 1, 1, 'translator'),
		]);
		expect(await preview(L, id, row, SPA)).toEqual({
			values: ['lg-spa:Casa grande'], // spa as of the row, not the row's spa copy
			frames: ['1→translator'],
		});
		expect(await preview(L, id, row, ENG)).toEqual({
			values: ['lg-eng:House'],
			frames: ['1→translator'],
		});
		await applyRow(L, id, row, SPA);
		expect(await textState(L, id, [SPA, ENG])).toEqual({
			[SPA]: ['lg-spa:Casa grande'],
			[ENG]: ['lg-eng:House'],
			frames: ['1→translator'],
		});
	}, 60_000);

	test('a PHP dataframe save row of a TRANSLITERABLE main: its lg-nolan base + its frames; the lg-ell item it carries is ignored', async () => {
		const id = await rec();
		await setText(X, id, NOLAN, [text(1, NOLAN, 'Augustus')]);
		await transliterate(X, id, ELL, { Augustus: 'Αύγουστος' });
		await addFrame(X, id, 1, 'author');
		const row = await phpRow(X, id, NOLAN, [
			text(1, NOLAN, 'Octavianus'),
			text(1, ELL, 'Οκταβιανός'),
			phpFrame(X, 1, 1, 'editor'),
		]);
		await applyRow(X, id, row, NOLAN);
		expect(await textState(X, id, [NOLAN, ELL])).toEqual({
			[NOLAN]: ['lg-nolan:Octavianus'],
			[ELL]: ['lg-ell:Αύγουστος'],
			frames: ['1→editor'],
		});
	}, 60_000);

	test('a PHP lg-nolan row with NO frame is a frame state: this main’s frames were EMPTY then', async () => {
		const id = await engineRecord();
		const row = await phpRow(L, id, NOLAN, [text(1, SPA, 'Casa'), text(1, ENG, 'House')]);
		expect((await preview(L, id, row, SPA)).frames).toEqual([]);
		await applyRow(L, id, row, SPA);
		expect(await textState(L, id, [SPA, ENG])).toEqual({
			[SPA]: ['lg-spa:Casa'],
			[ENG]: ['lg-eng:House'],
			frames: [],
		});
	}, 60_000);

	test('the revert of a two-language LEGACY framed run records ONE history after the frame half: each language row it writes reads its value WITH the restored frames', async () => {
		// Pre-run (PHP rows): items 1 + 2 in spa and eng, frames 1→author, 2→editor.
		// The legacy run removed item 2 and its frame in both languages.
		const id = await rec();
		const [f1, f2] = [phpFrame(L, 1, 1, 'author'), phpFrame(L, 2, 2, 'editor')];
		const spaPre = [text(1, SPA, 'Casa'), text(2, SPA, 'Jardín')];
		const engPre = [text(1, ENG, 'House'), text(2, ENG, 'Garden')];
		await phpRow(L, id, SPA, [...spaPre, f1, f2]);
		await phpRow(L, id, ENG, [...engPre, f1, f2]);
		const run = await mint();
		const legacy = (lang: string, data: unknown[]) =>
			insertLegacyBulkRow({
				sectionTipo: SECTION,
				sectionId: id,
				tipo: LMAIN,
				lang,
				bulkId: run,
				data,
			});
		await legacy(SPA, [text(1, SPA, 'Casa'), f1]);
		await legacy(ENG, [text(1, ENG, 'House'), f1]);
		await seedKey(id, 'string', LMAIN, [text(1, SPA, 'Casa'), text(1, ENG, 'House')]);
		await seedKey(id, 'relation', LSLOT, [f1]);
		const data = await revert(run);
		expect(data.skipped).toEqual([]);
		expect(await textState(L, id, [SPA, ENG])).toEqual({
			[SPA]: ['lg-spa:Casa', 'lg-spa:Jardín'],
			[ENG]: ['lg-eng:House', 'lg-eng:Garden'],
			frames: ['1→author', '2→editor'],
		}); // FLOOR
		const coords = { sectionTipo: SECTION, sectionId: id, componentTipo: LMAIN };
		const law = { sliced: true, translatable: true };
		const langRows = (await visibleRows(LMAIN, id)).filter((row) => row.lang !== NOLAN);
		const revertRows = (await runRows(LMAIN, id, data.bulk_process_id)).length;
		expect(revertRows).toBeGreaterThan(0); // FLOOR: the revert wrote its history
		const written = langRows.slice(-2);
		expect(written.map((row) => row.lang).sort()).toEqual([ENG, SPA]);
		for (const row of written) {
			const state = await readRowLaneState({ coords, row, law, fallbackLang: SPA });
			expect(framesRoles(rowFrames(L, state.frameImage))).toEqual(['1→author', '2→editor']);
		}
	}, 60_000);
});

// ---------------------------------------------------------------- 8: the frame lane is complete

/** Write a key raw — a door that records NO history (saveTm:false, a migration, a pre-undo-log import). */
async function seedKey(id: number, column: string, key: string, value: unknown): Promise<void> {
	await sql.unsafe(
		`UPDATE "${TABLE}" SET ${column} = COALESCE(${column}, '{}'::jsonb) || jsonb_build_object($3::text, $4::text::jsonb)
		 WHERE section_tipo = $1 AND section_id = $2`,
		[SECTION, id, key, JSON.stringify(value)],
	);
}

describe('(8) the frame lane is COMPLETE before a language row: frames written without history survive restoring it', () => {
	const frame = (role: Role): Item => ({
		id: 1,
		type: 'dd490',
		id_key: 1,
		section_tipo: SECTION,
		section_id: targetOf(role),
		from_component_tipo: LSLOT,
		main_component_tipo: LMAIN,
	});

	test('NO frame state recorded at all: the language save records the live frames first; restoring its row keeps them', async () => {
		const id = await rec();
		await setText(L, id, SPA, [text(1, SPA, 'Casa')]);
		await seedKey(id, 'relation', LSLOT, [frame('author')]); // no history row
		const mark = await watermark();
		await setText(L, id, SPA, [text(1, SPA, 'Casa grande')]);
		const rows = await visibleRows(LMAIN, id, mark);
		// ONE baseline lg-nolan row (the live frames), then the language row
		expect(rows.map((row) => row.lang)).toEqual([NOLAN, SPA]);
		expect(framesRoles(rowFrames(L, mustGet(rows[0], 'baseline').data))).toEqual(['1→author']);
		const spaRow = mustGet(rows[1], 'the spa row');
		expect((await preview(L, id, spaRow.id, SPA)).frames).toEqual(['1→author']);
		await applyRow(L, id, spaRow.id, SPA);
		expect(framesRoles(await liveFrames(L, id))).toEqual(['1→author']);
	}, 60_000);

	test('a STALE frame state (a PHP row, then frames edited without history): the language row reads the live frames, never rolls them back', async () => {
		const id = await rec();
		await setText(L, id, SPA, [text(1, SPA, 'Casa')]);
		await phpRow8(id, [text(1, SPA, 'Casa'), frame('editor')]);
		await seedKey(id, 'relation', LSLOT, [frame('author')]); // edited, no history row
		const mark = await watermark();
		await setText(L, id, SPA, [text(1, SPA, 'Casa grande')]);
		const rows = await visibleRows(LMAIN, id, mark);
		expect(rows.map((row) => row.lang)).toEqual([NOLAN, SPA]);
		const spaRow = mustGet(rows[1], 'the spa row');
		await applyRow(L, id, spaRow.id, SPA);
		expect(framesRoles(await liveFrames(L, id))).toEqual(['1→author']);
	}, 60_000);

	test('a frame state that already holds the live frames: the language save writes its ONE row only', async () => {
		const id = await rec();
		await setText(L, id, SPA, [text(1, SPA, 'Casa')]);
		await addFrame(L, id, 1, 'author'); // through the door: an lg-nolan row
		const mark = await watermark();
		await setText(L, id, SPA, [text(1, SPA, 'Casa grande')]);
		expect((await visibleRows(LMAIN, id, mark)).map((row) => row.lang)).toEqual([SPA]);
	}, 60_000);

	const phpRow8 = (id: number, data: unknown[]) =>
		insertLegacyBulkRow({
			sectionTipo: SECTION,
			sectionId: id,
			tipo: LMAIN,
			lang: SPA,
			bulkId: null,
			data,
		});
});

// ---------------------------------------------------------------- 9: the preview is the restore

describe('(9) the preview of a row shows its lane exactly as apply_value writes it (a PHP orphan + an lg-nolan item on a translatable main)', () => {
	test('previewLaneValue over the state at the row equals the value apply_value writes; the lg-nolan lane of a translatable main is never read as of the row', async () => {
		const id = await rec();
		const orphan = { id: 2, value: 'orphan' }; // PHP-era: no lang
		const nolanItem = { id: 3, lang: NOLAN, value: 'nolan copy' }; // PHP-era lg-nolan item
		await seedKey(id, 'string', LMAIN, [
			text(1, SPA, 'Casa'),
			orphan,
			nolanItem,
			text(1, ENG, 'House'),
		]);
		const rowId = await insertLegacyBulkRow({
			sectionTipo: SECTION,
			sectionId: id,
			tipo: LMAIN,
			lang: SPA,
			bulkId: null,
			data: [text(1, SPA, 'Casa vieja'), orphan],
		});
		const coords = { sectionTipo: SECTION, sectionId: id, componentTipo: LMAIN };
		const law = { sliced: true, translatable: true };
		const row = mustGet(
			(await visibleRows(LMAIN, id)).find((r) => r.id === rowId),
			'the PHP spa row',
		);
		const state = await readRowLaneState({ coords, row, law, fallbackLang: SPA });
		const asOf = await readLaneValueAt(coords, NOLAN, rowId, law);
		expect(asOf.recorded).toBe(false); // a translatable main's lg-nolan value: history never speaks for it
		const previewed = previewLaneValue(await stored(id, 'string', LMAIN), state, asOf, law);
		// the rendered pane viewed in lg-nolan still shows the live lg-nolan item
		expect((await preview(L, id, rowId, NOLAN)).values).toEqual(['lg-nolan:nolan copy']);
		await applyRow(L, id, rowId, SPA);
		const applied = await stored(id, 'string', LMAIN);
		expect(previewed).toEqual(applied);
		expect(applied).toEqual([nolanItem, text(1, ENG, 'House'), text(1, SPA, 'Casa vieja'), orphan]);
	}, 60_000);
});

// ---------------------------------------------------------------- 10: review findings (2026-09-28)

describe('(10) the order and completeness of the lanes', () => {
	test('an lg-nolan `remove` on a TRANSLITERABLE main (base + lg-ell + a frame) writes ONE lg-nolan row (the frame stripped) then the lg-ell row — never a frameless pre-save copy', async () => {
		const id = await rec();
		await setText(X, id, NOLAN, [text(1, NOLAN, 'Augustus')]);
		await transliterate(X, id, ELL, { Augustus: 'Αύγουστος' });
		await addFrame(X, id, 1, 'author');
		const mark = await watermark();
		await save(id, XMAIN, NOLAN, [{ action: 'remove', id: 1, value: null }]);
		// FLOOR: the remove reached every language and stripped the frame
		expect(await stored(id, 'string', XMAIN)).toEqual([]);
		expect(await liveFrames(X, id)).toEqual([]);
		const rows = await visibleRows(XMAIN, id, mark);
		expect(rows.map((row) => [row.lang, row.data])).toEqual([
			[NOLAN, []],
			[ELL, []],
		]);
	}, 60_000);

	test('a PHP ORPHAN never rides the frame lane of a TRANSLATABLE main, and never forces a baseline: a slot save, then a spa save, write ONE row each', async () => {
		const id = await rec();
		await seedKey(id, 'string', LMAIN, [text(1, SPA, 'Casa'), { id: 2, value: 'orphan' }]);
		const mark = await watermark();
		await addFrame(L, id, 1, 'author');
		const slotRows = await visibleRows(LMAIN, id, mark);
		expect(slotRows.map((row) => row.lang)).toEqual([NOLAN]);
		expect(rowItems(mustGet(slotRows[0], 'the slot row').data)).toEqual([]); // frames only
		const mark2 = await watermark();
		await setText(L, id, SPA, [text(1, SPA, 'Casa grande')]);
		expect((await visibleRows(LMAIN, id, mark2)).map((row) => row.lang)).toEqual([SPA]);
	}, 60_000);

	test('a PHP ORPHAN in the frame lane of a TRANSLITERABLE main is not part of the frame state: a transliteration after a frame save writes ONE lg-ell row', async () => {
		const id = await rec();
		await seedKey(id, 'string', XMAIN, [text(1, NOLAN, 'Augustus'), { id: 2, value: 'orphan' }]);
		await addFrame(X, id, 1, 'author'); // its lg-nolan row carries the orphan (the door's lane)
		const mark = await watermark();
		await transliterate(X, id, ELL, { Augustus: 'Αύγουστος' });
		expect((await visibleRows(XMAIN, id, mark)).map((row) => row.lang)).toEqual([ELL]);
	}, 60_000);

	/** spa [1 Casa, 2 Jardín], eng [1 House], frames 1→author and 2→editor. */
	async function twoItems(): Promise<number> {
		const id = await rec();
		await setText(L, id, SPA, [text(1, SPA, 'Casa'), text(2, SPA, 'Jardín')]);
		await setText(L, id, ENG, [text(1, ENG, 'House')]);
		await addFrame(L, id, 1, 'author');
		await addFrame(L, id, 2, 'editor');
		return id;
	}

	test('the language row of a save that REMOVED an item sits ABOVE its own lg-nolan row: its preview and its restore carry the post-save frames — no orphan frame comes back', async () => {
		const id = await twoItems();
		const mark = await watermark();
		await save(id, LMAIN, SPA, [{ action: 'remove', id: 2, value: null }]);
		const rows = await visibleRows(LMAIN, id, mark);
		expect(rows.map((row) => row.lang)).toEqual([NOLAN, SPA]);
		const spaRow = mustGet(rows[1], 'the spa removal row');
		await changeFrame(L, id, 1, 'reviewer');
		await setText(L, id, SPA, [text(1, SPA, 'Casa'), text(3, SPA, 'Patio')]);
		expect(await preview(L, id, spaRow.id, SPA)).toEqual({
			values: ['lg-spa:Casa'],
			frames: ['1→author'],
		});
		await applyRow(L, id, spaRow.id, SPA);
		expect(await textState(L, id, [SPA, ENG])).toEqual({
			[SPA]: ['lg-spa:Casa'],
			[ENG]: ['lg-eng:House'],
			frames: ['1→author'],
		});
	}, 60_000);

	test('a BULK removal: the visible spa after-row sits above the lg-nolan after-row; restoring it brings back no orphan frame', async () => {
		const id = await twoItems();
		const run = await mint();
		await save(id, LMAIN, SPA, [{ action: 'remove', id: 2, value: null }], { bulk: run });
		const visible = (await runRows(LMAIN, id, run)).filter((row) => row.tm_role === null);
		expect(visible.map((row) => row.lang)).toEqual([NOLAN, SPA]);
		const spaRow = mustGet(
			(await visibleRows(LMAIN, id)).filter((row) => row.lang === SPA).at(-1),
			'the bulk spa after-row',
		);
		await changeFrame(L, id, 1, 'reviewer');
		await applyRow(L, id, spaRow.id, SPA);
		expect(framesRoles(await liveFrames(L, id))).toEqual(['1→author']);
	}, 60_000);

	test('a row whose save ADDED an item whose frame was saved first (frame-first): its restore brings the item AND its frame back exactly', async () => {
		const id = await rec();
		await setText(L, id, SPA, [text(1, SPA, 'Casa')]);
		await addFrame(L, id, 2, 'editor'); // frame before its item
		const mark = await watermark();
		await setText(L, id, SPA, [text(1, SPA, 'Casa'), text(2, SPA, 'Jardín')]);
		const spaRow = mustGet((await visibleRows(LMAIN, id, mark))[0], 'the spa row');
		await save(id, LMAIN, SPA, [{ action: 'remove', id: 2, value: null }]);
		expect(await liveFrames(L, id)).toEqual([]); // FLOOR: stripped with its item
		await applyRow(L, id, spaRow.id, SPA);
		expect(await textState(L, id, [SPA])).toEqual({
			[SPA]: ['lg-spa:Casa', 'lg-spa:Jardín'],
			frames: ['2→editor'],
		});
	}, 60_000);
});

describe('(10) bulk revert, preview and list completeness', () => {
	test('a run that only ADDED a spa item, then a frame added for it after the run: the revert is refused (changed_since_run) — never an orphan frame', async () => {
		const id = await rec();
		await setText(L, id, SPA, [text(1, SPA, 'Casa')]);
		await addFrame(L, id, 1, 'author');
		const run = await mint();
		await setText(L, id, SPA, [text(1, SPA, 'Casa'), text(2, SPA, 'Jardín')], run);
		// FLOOR: the run wrote the spa lane only (its frame lane pair was a no-op)
		expect((await runRows(LMAIN, id, run)).map((row) => [row.tm_role, row.lang])).toEqual([
			[1, SPA],
			[null, SPA],
		]);
		await addFrame(L, id, 2, 'editor'); // after the run
		const data = await revert(run);
		expect((data.skipped as { reason: string }[]).map((skip) => skip.reason)).toEqual([
			'changed_since_run',
		]);
		expect(await textState(L, id, [SPA])).toEqual({
			[SPA]: ['lg-spa:Casa', 'lg-spa:Jardín'],
			frames: ['1→author', '2→editor'],
		});
	}, 60_000);

	test('a run that ADDED a spa item whose frame stood BEFORE the run (frame-first): the revert removes the item and keeps the pre-run frame', async () => {
		const id = await rec();
		await setText(L, id, SPA, [text(1, SPA, 'Casa')]);
		await addFrame(L, id, 2, 'editor'); // frame-first, before the run
		const run = await mint();
		await setText(L, id, SPA, [text(1, SPA, 'Casa'), text(2, SPA, 'Jardín')], run);
		const data = await revert(run);
		expect(data.skipped).toEqual([]);
		expect(await textState(L, id, [SPA])).toEqual({
			[SPA]: ['lg-spa:Casa'],
			frames: ['2→editor'],
		});
	}, 60_000);

	test('a NON-composed translatable main (no slot) holding a PHP lg-nolan item AND a lang-less orphan: a run removing the lg-nolan item reverts exactly — the orphan is never part of the lg-nolan lane', async () => {
		const id = await rec();
		const orphan: Item = { id: 3, value: 'Huérfano' };
		const pre = [text(1, NOLAN, 'Base'), text(2, SPA, 'Casa'), orphan];
		await seedKey(id, 'string', UMAIN, pre);
		const run = await mint();
		await save(id, UMAIN, SPA, [{ action: 'remove', id: 1, value: null }], { bulk: run });
		const lanes = (await runRows(UMAIN, id, run)).map((row) => row.lang);
		expect(lanes).toContain(NOLAN); // FLOOR: the run left an lg-nolan pair
		expect(await stored(id, 'string', UMAIN)).not.toContainEqual(text(1, NOLAN, 'Base')); // FLOOR
		const data = await revert(run);
		expect(data.skipped).toEqual([]);
		expect(data.exact).toBe('full');
		const restored = asList(await stored(id, 'string', UMAIN));
		expect(restored).toContainEqual(text(1, NOLAN, 'Base'));
		expect(restored).toContainEqual(orphan);
		expect(restored).toHaveLength(3);
	}, 60_000);

	test('the history LIST cell of an lg-nolan (frame) row of a TRANSLATABLE main shows the language value AS OF the row — never an emptied value', async () => {
		const id = await rec();
		await setText(L, id, SPA, [text(1, SPA, 'Casa')]);
		await setText(L, id, ENG, [text(1, ENG, 'House')]);
		await addFrame(L, id, 1, 'author');
		await setText(L, id, SPA, [text(1, SPA, 'Casa grande')]);
		await changeFrame(L, id, 1, 'editor');
		const frameRows = (await visibleRows(LMAIN, id)).filter((row) => row.lang === NOLAN);
		expect(frameRows).toHaveLength(2); // FLOOR
		const [first, second] = frameRows.map((row) => row.id) as [number, number];
		/** The main's list cell of each listed row of `lang`: row id → `lang:value` entries. */
		const cells = async (lang: string) => {
			const { data } = await readTimeMachineData(historyRqo(L, id, lang));
			const out = new Map<number, string[]>();
			for (const item of data as { tipo?: string; section_id?: number; entries?: Item[] }[]) {
				if (item.tipo !== LMAIN) continue;
				out.set(
					Number(item.section_id),
					(item.entries ?? []).map((entry) => `${entry.lang}:${entry.value}`),
				);
			}
			return out;
		};
		const spa = await cells(SPA);
		expect(spa.get(first)).toEqual(['lg-spa:Casa']);
		expect(spa.get(second)).toEqual(['lg-spa:Casa grande']);
		const eng = await cells(ENG);
		expect(eng.get(first)).toEqual(['lg-eng:House']);
		expect(eng.get(second)).toEqual(['lg-eng:House']);
	}, 60_000);

	test('the history LIST cell of an lg-nolan (frame) row of a NON-translatable component_iri (items in language lanes) shows the language value AS OF the row — never an emptied value', async () => {
		const iri = (itemId: number, lang: string, value: string): Item => ({
			id: itemId,
			lang,
			iri: `http://example.org/${value}`,
			title: value,
		});
		const id = await rec();
		await setText(I, id, SPA, [iri(1, SPA, 'casa')]);
		await addFrame(I, id, 1, 'author');
		await setText(I, id, SPA, [iri(1, SPA, 'casa-grande')]);
		await changeFrame(I, id, 1, 'editor');
		const rows = await visibleRows(IMAIN, id);
		// FLOOR: two value rows in lg-spa, two frames-only lg-nolan rows
		expect(rows.map((row) => row.lang)).toEqual([SPA, NOLAN, SPA, NOLAN]);
		expect(
			rows.filter((row) => row.lang === NOLAN).every((row) => rowItems(row.data).length === 0),
		).toBe(true);
		const [spaFirst, first, spaSecond, second] = rows.map((row) => row.id) as [
			number,
			number,
			number,
			number,
		];
		const { data } = await readTimeMachineData(historyRqo(I, id, SPA));
		const cells = new Map<number, string[]>();
		for (const item of data as { tipo?: string; section_id?: number; entries?: Item[] }[]) {
			if (item.tipo !== IMAIN) continue;
			cells.set(
				Number(item.section_id),
				(item.entries ?? []).map((entry) => `${entry.lang}:${entry.title}`),
			);
		}
		expect(cells.get(spaFirst)).toEqual(['lg-spa:casa']);
		expect(cells.get(first)).toEqual(['lg-spa:casa']);
		expect(cells.get(spaSecond)).toEqual(['lg-spa:casa-grande']);
		expect(cells.get(second)).toEqual(['lg-spa:casa-grande']);
	}, 60_000);

	test('the preview of an lg-nolan (frame) row of a TRANSLATABLE-flagged portal shows the value the row recorded, not the live one', async () => {
		const locator = (role: Role): Item => ({
			type: 'dd151',
			section_tipo: SECTION,
			section_id: String(targetOf(role)),
			from_component_tipo: TPMAIN,
		});
		await runWithRequestLangs({ applicationLang: ENG, dataLang: SPA }, async () => {
			const id = await rec();
			await save(id, TPMAIN, SPA, [{ action: 'set_data', value: [locator('author')] }]);
			const itemId = Number(
				mustGet(asList(await stored(id, 'relation', TPMAIN))[0], 'the portal item').id,
			);
			await addFrame(TP, id, itemId, 'editor');
			const frameRow = mustGet((await visibleRows(TPMAIN, id)).at(-1), 'the frame row');
			expect(frameRow.lang).toBe(NOLAN); // FLOOR
			await save(id, TPMAIN, SPA, [
				{
					action: 'set_data',
					value: [...asList(await stored(id, 'relation', TPMAIN)), locator('reviewer')],
				},
			]);
			const items = (await readComponentData({
				source: {
					tipo: TPMAIN,
					section_tipo: SECTION,
					section_id: id,
					lang: SPA,
					mode: 'edit',
					data_source: 'tm',
					matrix_id: frameRow.id,
				},
			} as never)) as { tipo?: string; entries?: Item[] }[];
			const shown = items
				.filter((item) => item.tipo === TPMAIN)
				.flatMap((item) => item.entries ?? [])
				.map((entry) => roleOf(entry));
			expect(shown).toEqual(['author']);
		});
	}, 60_000);

	test('a translatable main whose frames live in an UNDECLARED slot: its lg-nolan frame rows are in the language list and count', async () => {
		const id = await rec();
		await setText(U, id, SPA, [text(1, SPA, 'Casa')]);
		await addFrame(U, id, 1, 'author');
		const rows = await visibleRows(UMAIN, id);
		expect(rows.map((row) => row.lang)).toEqual([SPA, NOLAN]); // FLOOR: the writer filed a frame row
		expect(await listed(U, id, SPA)).toEqual(rows.map((row) => row.id));
		expect(await countTimeMachineData(historyRqo(U, id, SPA))).toBe(2);
	}, 60_000);
});

// ---------------------------------------------------------------- 11: the backfill is frame-first

describe('(11) the BACKFILL (duplicate, Delete data) writes the frame lane FIRST; an unsliced main saved from two request languages has ONE lane', () => {
	const frame = (role: Role): Item => ({
		id: 1,
		type: 'dd490',
		id_key: 1,
		section_tipo: SECTION,
		section_id: targetOf(role),
		from_component_tipo: LSLOT,
		main_component_tipo: LMAIN,
	});

	/** A translatable main with spa + eng items and a frame on item 1. */
	async function bilingualWithFrame(): Promise<number> {
		const id = await rec();
		await setText(L, id, SPA, [text(1, SPA, 'Casa')]);
		await setText(L, id, ENG, [text(1, ENG, 'House')]);
		await addFrame(L, id, 1, 'author');
		return id;
	}

	test('DUPLICATE: the copy’s backfill is lg-nolan (frames), spa, eng; the eng row — that language’s ONLY row — previews and restores WITH the frame', async () => {
		const id = await bilingualWithFrame();
		const copy = await runWithRequestLangs({ applicationLang: ENG, dataLang: SPA }, () =>
			duplicateSectionRecord(SECTION, id, USER_ID),
		);
		// The copy's frame (its target may be re-minted by the duplicate — compare to the copy's own).
		const copyFrames = framesRoles(await liveFrames(L, copy));
		expect(copyFrames).toHaveLength(1);
		const rows = await visibleRows(LMAIN, copy);
		expect(rows.map((row) => row.lang)).toEqual([NOLAN, SPA, ENG, SPA]);
		expect(framesRoles(rowFrames(L, mustGet(rows[0], 'frame lane').data))).toEqual(copyFrames);
		const engRow = mustGet(rows[2], 'the eng backfill row');
		expect((await preview(L, copy, engRow.id, ENG)).frames).toEqual(copyFrames);
		await applyRow(L, copy, engRow.id, ENG);
		expect(await textState(L, copy, [SPA, ENG])).toEqual({
			[SPA]: ['lg-spa:Casa'],
			[ENG]: ['lg-eng:House'],
			frames: copyFrames,
		});
	}, 60_000);

	test('DELETE DATA on a record with NO history: the pre-wipe backfill is lg-nolan (frames) first; restoring the pre-wipe eng row brings its value back WITH its frame', async () => {
		const id = await bilingualWithFrame();
		await sql.unsafe(
			'DELETE FROM matrix_time_machine WHERE section_tipo = $1 AND section_id = $2',
			[SECTION, id],
		);
		await deleteSectionData(SECTION, id, USER_ID);
		const rows = await visibleRows(LMAIN, id);
		expect(rows.slice(0, 3).map((row) => row.lang)).toEqual([NOLAN, SPA, ENG]);
		const engRow = mustGet(rows[2], 'the pre-wipe eng row');
		expect((await preview(L, id, engRow.id, ENG)).frames).toEqual(['1→author']);
		await applyRow(L, id, engRow.id, ENG);
		expect(await textState(L, id, [ENG])).toEqual({
			[ENG]: ['lg-eng:House'],
			frames: ['1→author'],
		});
	}, 60_000);

	test('DELETE DATA with a STALE frame lane (frames edited without history): a baseline lg-nolan row precedes the backfilled eng row — it pairs the live frames, never the stale ones', async () => {
		const id = await bilingualWithFrame();
		await sql.unsafe(
			'DELETE FROM matrix_time_machine WHERE section_tipo = $1 AND section_id = $2 AND lang = $3',
			[SECTION, id, ENG],
		);
		await seedKey(id, 'relation', LSLOT, [frame('editor')]); // no history row
		const mark = await watermark();
		await deleteSectionData(SECTION, id, USER_ID);
		const rows = await visibleRows(LMAIN, id, mark);
		expect(rows.slice(0, 2).map((row) => row.lang)).toEqual([NOLAN, ENG]);
		const engRow = mustGet(rows[1], 'the pre-wipe eng row');
		expect((await preview(L, id, engRow.id, ENG)).frames).toEqual(['1→editor']);
		await applyRow(L, id, engRow.id, ENG);
		expect(await textState(L, id, [ENG])).toEqual({
			[ENG]: ['lg-eng:House'],
			frames: ['1→editor'],
		});
	}, 60_000);

	test('DELETE DATA with NO lg-nolan row but a PHP lg-spa row CARRYING a frame, the frames empty now: a baseline empty lg-nolan row precedes the backfilled eng row — its frame state is empty, never the PHP frame', async () => {
		const id = await rec();
		// Live: spa + eng, no frame, no history but the PHP spa row (its frame since removed without history).
		await seedKey(id, 'string', LMAIN, [text(1, SPA, 'Casa'), text(1, ENG, 'House')]);
		await insertLegacyBulkRow({
			sectionTipo: SECTION,
			sectionId: id,
			tipo: LMAIN,
			lang: SPA,
			bulkId: null,
			data: [text(1, SPA, 'Casa'), frame('author')],
		});
		const mark = await watermark();
		await deleteSectionData(SECTION, id, USER_ID);
		const rows = await visibleRows(LMAIN, id, mark);
		expect(rows.slice(0, 2).map((row) => row.lang)).toEqual([NOLAN, ENG]);
		const engRow = mustGet(rows[1], 'the pre-wipe eng row');
		const state = await readFrameStateRowAt(
			{ sectionTipo: SECTION, sectionId: id, componentTipo: LMAIN },
			engRow.id,
		);
		expect(rowFrames(L, state?.data)).toEqual([]);
		expect((await preview(L, id, engRow.id, ENG)).frames).toEqual([]);
	}, 60_000);

	test('a TRANSLATABLE-flagged portal saved from TWO request languages: every row lg-nolan, listed in both timelines; the preview of its frame row shows the value the LAST save left, with its frames', async () => {
		const locator = (role: Role): Item => ({
			type: 'dd151',
			section_tipo: SECTION,
			section_id: String(targetOf(role)),
			from_component_tipo: TPMAIN,
		});
		const id = await rec();
		await runWithRequestLangs({ applicationLang: ENG, dataLang: SPA }, () =>
			save(id, TPMAIN, SPA, [{ action: 'set_data', value: [locator('author')] }]),
		);
		const first = asList(await stored(id, 'relation', TPMAIN));
		await runWithRequestLangs({ applicationLang: ENG, dataLang: ENG }, () =>
			save(id, TPMAIN, ENG, [{ action: 'set_data', value: [...first, locator('reviewer')] }]),
		);
		const items = asList(await stored(id, 'relation', TPMAIN));
		const reviewerItem = mustGet(
			items.find((item) => Number(item.section_id) === targetOf('reviewer')),
			'the reviewer item',
		);
		await addFrame(TP, id, Number(reviewerItem.id), 'editor');
		const rows = await visibleRows(TPMAIN, id);
		expect(rows.map((row) => row.lang)).toEqual([NOLAN, NOLAN, NOLAN]);
		expect(await countTimeMachineData(historyRqo(TP, id, SPA))).toBe(3);
		expect(await countTimeMachineData(historyRqo(TP, id, ENG))).toBe(3);
		const frameRow = mustGet(rows[2], 'the frame row');
		const shown = await runWithRequestLangs({ applicationLang: ENG, dataLang: SPA }, async () => {
			const read = (await readComponentData({
				source: {
					tipo: TPMAIN,
					section_tipo: SECTION,
					section_id: id,
					lang: SPA,
					mode: 'edit',
					data_source: 'tm',
					matrix_id: frameRow.id,
				},
			} as never)) as { tipo?: string; entries?: Item[] }[];
			const entriesOf = (tipo: string) =>
				read.filter((item) => item.tipo === tipo).flatMap((item) => item.entries ?? []);
			return {
				values: entriesOf(TPMAIN).map((entry) => roleOf(entry)),
				frames: framesRoles(entriesOf(TPSLOT)),
			};
		});
		expect(shown.values).toEqual(['author', 'reviewer']);
		expect(shown.frames).toEqual([`${reviewerItem.id}→editor`]);
	}, 60_000);
});

// ---------------------------------------------------------------- 12: list cells == preview frames

describe('(12) the history LIST shows, for EVERY listed row, exactly the frames its PREVIEW shows (WC-2026-09-29-tm-preview-frame-children-as-of, "the history list")', () => {
	/** The list of `lang` (read in that data language): row id → the main's frames in its slot cells. */
	async function listFrames(main: Main, id: number, lang: string): Promise<Map<number, string[]>> {
		const { data } = await runWithRequestLangs(
			{ applicationLang: ENG, dataLang: lang === NOLAN ? ENG : lang },
			() => readTimeMachineData(historyRqo(main, id, lang)),
		);
		const byRow = new Map<number, Item[]>();
		for (const item of data as Item[]) {
			if (item.tipo !== main.slot) continue;
			const rowId = Number(item.row_section_id ?? item.section_id);
			byRow.set(rowId, [...(byRow.get(rowId) ?? []), ...asList(item.entries)]);
		}
		return new Map(
			[...byRow].map(([rowId, frames]) => [
				rowId,
				framesRoles(frames.filter((frame) => frame.main_component_tipo === main.tipo)),
			]),
		);
	}

	/**
	 * Compare list and preview for EVERY row listed in each of `langs`. Answers
	 * the rows compared per lane of the row, the floor callers assert against
	 * (a comparison over no row, or over rows with no frame, proves nothing).
	 */
	async function expectListEqualsPreview(main: Main, id: number, langs: readonly string[]) {
		const compared: { rowLang: string | null; frames: string[] }[] = [];
		const byId = new Map((await visibleRows(main.tipo, id)).map((row) => [row.id, row]));
		for (const lang of langs) {
			const rowIds = await listed(main, id, lang);
			expect(rowIds.length).toBeGreaterThan(0); // FLOOR
			const cells = await listFrames(main, id, lang);
			for (const rowId of rowIds) {
				const shown = (await preview(main, id, rowId, lang)).frames;
				expect({ row: rowId, lang, frames: cells.get(rowId) ?? [] }).toEqual({
					row: rowId,
					lang,
					frames: shown,
				});
				compared.push({ rowLang: byId.get(rowId)?.lang ?? null, frames: shown });
			}
		}
		return compared;
	}

	/** Rows of a LANGUAGE lane (not lg-nolan) whose preview shows at least one frame. */
	const framedLanguageRows = (compared: { rowLang: string | null; frames: string[] }[]) =>
		compared.filter((c) => c.rowLang !== null && c.rowLang !== NOLAN && c.frames.length > 0);

	test('a TRANSLATABLE literal main (per-language rows + frames-only lg-nolan rows): every row of the spa and eng lists — a language row shows the frames it stood with', async () => {
		const id = await rec();
		await setText(L, id, SPA, [text(1, SPA, 'Casa')]);
		await setText(L, id, ENG, [text(1, ENG, 'House')]);
		await addFrame(L, id, 1, 'author');
		await setText(L, id, SPA, [text(1, SPA, 'Casa grande')]);
		await changeFrame(L, id, 1, 'editor');
		await setText(L, id, ENG, [text(1, ENG, 'Big house')]);
		const compared = await expectListEqualsPreview(L, id, [SPA, ENG]);
		// FLOOR: both lanes' language rows AND frames-only rows were compared, framed.
		expect(framedLanguageRows(compared).map((c) => c.rowLang)).toEqual([SPA, ENG]);
		expect(compared.filter((c) => c.rowLang === NOLAN && c.frames.length > 0).length).toBe(4);
		expect(compared.some((c) => c.frames.length === 0)).toBe(true); // the pre-frame rows
	}, 60_000);

	test('a component_iri main (NOT translatable, items in language lanes) with its FIXED label slot dd560: every row of the spa list', async () => {
		const iri = (itemId: number, value: string): Item => ({
			id: itemId,
			lang: SPA,
			iri: `http://example.org/${value}`,
			title: value,
		});
		// dd560 frames target the iri-label section dd1706: two runtime records, swept below.
		const labelTable = mustGet(await getMatrixTableFromTipo(LABEL_SECTION), 'the dd1706 table');
		const labels = [
			await createSectionRecord(LABEL_SECTION, USER_ID),
			await createSectionRecord(LABEL_SECTION, USER_ID),
		];
		const [first, second] = labels as [number, number];
		try {
			const id = await rec();
			const label = (change: Item) => frameSave(IL, id, 1, change, null);
			await setText(I, id, SPA, [iri(1, 'casa')]);
			await label({
				action: 'insert',
				id: null,
				value: { section_tipo: LABEL_SECTION, section_id: String(first) },
			});
			await setText(I, id, SPA, [iri(1, 'casa-grande')]);
			const frame = mustGet((await liveFrames(IL, id))[0], 'the dd560 frame');
			await label({
				action: 'update',
				id: frame.id,
				value: { ...frame, section_id: String(second) },
			});
			await setText(I, id, SPA, [iri(1, 'casa-chica')]);
			const compared = await expectListEqualsPreview(IL, id, [SPA]);
			// FLOOR: the language rows after each frame change show it (the defect: none).
			expect(framedLanguageRows(compared).map((c) => c.frames)).toEqual([
				[`1→${first}`],
				[`1→${second}`],
			]);
		} finally {
			for (const labelId of labels) {
				await sql.unsafe(
					`DELETE FROM "${labelTable}" WHERE section_tipo = $1 AND section_id = $2`,
					[LABEL_SECTION, labelId],
				);
				await sql.unsafe(
					'DELETE FROM matrix_time_machine WHERE section_tipo = $1 AND section_id = $2',
					[LABEL_SECTION, labelId],
				);
				await sql.unsafe(
					'DELETE FROM dedalo_ts_record_generation WHERE section_tipo = $1 AND section_id = $2',
					[LABEL_SECTION, labelId],
				);
				// createSectionRecord's activity row (misc dd551 carries the address).
				await sql.unsafe(
					`DELETE FROM matrix_activity WHERE section_tipo = 'dd542'
					   AND misc->'dd551'->0->'value'->>'section_tipo' = $1
					   AND misc->'dd551'->0->'value'->>'section_id' = $2`,
					[LABEL_SECTION, String(labelId)],
				);
			}
			for (const labelId of labels) {
				const residue = (await sql.unsafe(
					`SELECT (SELECT count(*) FROM "${labelTable}" WHERE section_tipo = $1 AND section_id = $2)
					      + (SELECT count(*) FROM matrix_time_machine WHERE section_tipo = $1 AND section_id = $2)
					      + (SELECT count(*) FROM matrix_activity WHERE section_tipo = 'dd542'
					           AND misc->'dd551'->0->'value'->>'section_tipo' = $1
					           AND misc->'dd551'->0->'value'->>'section_id' = $2::text) AS n`,
					[LABEL_SECTION, labelId],
				)) as { n: number | string }[];
				expect(Number(residue[0]?.n)).toBe(0);
			}
		}
	}, 60_000);

	test("a RELATION main (composed lg-nolan rows) and a NUMBER main: every row — the portal frame cell reads the ROW's record, never a record at the dd15 row id", async () => {
		const portalItem = (itemId: number, role: Role): Item => ({
			id: itemId,
			type: 'dd151',
			section_tipo: SECTION,
			section_id: targetOf(role),
			from_component_tipo: PMAIN,
		});
		const pid = await rec();
		await save(pid, PMAIN, NOLAN, [{ action: 'set_data', value: [portalItem(1, 'author')] }]);
		await addFrame(P, pid, 1, 'editor');
		await save(pid, PMAIN, NOLAN, [{ action: 'set_data', value: [portalItem(1, 'reviewer')] }]);
		await changeFrame(P, pid, 1, 'translator');
		const portal = await expectListEqualsPreview(P, pid, [SPA]);
		expect(portal.map((c) => c.frames)).toEqual([[], ['1→editor'], ['1→editor'], ['1→translator']]);
		const nid = await rec();
		await save(nid, NMAIN, NOLAN, [
			{ action: 'set_data', value: [{ id: 1, lang: NOLAN, value: 1 }] },
		]);
		await addFrame(N, nid, 1, 'author');
		await save(nid, NMAIN, NOLAN, [
			{ action: 'set_data', value: [{ id: 1, lang: NOLAN, value: 2 }] },
		]);
		const number = await expectListEqualsPreview(N, nid, [SPA]);
		expect(number.map((c) => c.frames)).toEqual([[], ['1→author'], ['1→author']]);
	}, 60_000);

	test("a row filed under a SLOT's own tipo (unsupported history): its list cell and its preview are both EMPTY", async () => {
		const id = await rec();
		await setText(L, id, SPA, [text(1, SPA, 'Casa')]);
		await addFrame(L, id, 1, 'author');
		const frame = mustGet((await liveFrames(L, id))[0], 'the live frame');
		const slotRow = await insertLegacyBulkRow({
			sectionTipo: SECTION,
			sectionId: id,
			tipo: LSLOT,
			lang: NOLAN,
			bulkId: null,
			data: [frame],
		});
		const slotMain: Main = { tipo: LSLOT, slot: LSLOT, column: 'relation' };
		expect(await listed(slotMain, id, SPA)).toEqual([slotRow]); // FLOOR: listed under the slot
		// The cell is read from the list that CONTAINS the row (the slot-scoped
		// one; the main's column requested too, which is what emits the slot's
		// frame cell), unfiltered. It must be EMITTED, and emitted empty: an
		// absent cell would pass any assertion on its content.
		const { data: slotList } = await runWithRequestLangs(
			{ applicationLang: ENG, dataLang: SPA },
			() =>
				readTimeMachineData({
					...(historyRqo(slotMain, id, SPA) as object),
					show: {
						ddo_map: [
							{ tipo: LMAIN, section_tipo: 'dd15' },
							{ tipo: LSLOT, section_tipo: 'dd15' },
						],
					},
				} as never),
		);
		const slotCells = (slotList as Item[]).filter(
			(item) => item.tipo === LSLOT && Number(item.row_section_id) === slotRow,
		);
		expect(slotCells.length).toBeGreaterThan(0); // FLOOR: the row's frame cell is emitted
		expect(slotCells.flatMap((item) => asList(item.entries))).toEqual([]);
		const shown = (await runWithRequestLangs({ applicationLang: ENG, dataLang: SPA }, () =>
			readComponentData({
				source: {
					tipo: LSLOT,
					section_tipo: SECTION,
					section_id: id,
					lang: SPA,
					mode: 'edit',
					data_source: 'tm',
					matrix_id: slotRow,
					caller_dataframe: { main_component_tipo: LMAIN, id_key: 1 },
				},
			} as never),
		)) as { tipo?: string; entries?: Item[] }[];
		expect(shown.flatMap((item) => (item.tipo === LSLOT ? (item.entries ?? []) : []))).toEqual([]);
	}, 60_000);

	test('an UNTAGGED PHP-era row of a translatable main (listed by a lang-less locator): read under the VIEW lane like its preview — a value row showing the frames it stood with', async () => {
		const id = await rec();
		await setText(L, id, SPA, [text(1, SPA, 'Casa')]);
		await addFrame(L, id, 1, 'author');
		const untagged = await insertLegacyBulkRow({
			sectionTipo: SECTION,
			sectionId: id,
			tipo: LMAIN,
			lang: null as never,
			bulkId: null,
			data: [text(1, SPA, 'Casa vieja')],
		});
		const { data } = await runWithRequestLangs({ applicationLang: ENG, dataLang: SPA }, () =>
			readTimeMachineData({
				sqo: {
					filter_by_locators: [{ section_tipo: SECTION, section_id: id, tipo: LMAIN }],
					limit: 100,
				},
				source: { lang: SPA },
				show: { ddo_map: [{ tipo: LMAIN, section_tipo: 'dd15' }] },
			} as never),
		);
		const cells = (data as Item[]).filter(
			(item) => item.tipo === L.slot && Number(item.row_section_id ?? item.section_id) === untagged,
		);
		expect(cells.length).toBeGreaterThan(0); // FLOOR: the untagged row is listed, its frame cell emitted
		const shown = (await preview(L, id, untagged, SPA)).frames;
		expect(shown).toEqual(['1→author']); // FLOOR: a framed picture, not an empty one
		expect(
			framesRoles(
				cells
					.flatMap((item) => asList(item.entries))
					.filter((frame) => frame.main_component_tipo === LMAIN),
			),
		).toEqual(shown);
	}, 60_000);
});
