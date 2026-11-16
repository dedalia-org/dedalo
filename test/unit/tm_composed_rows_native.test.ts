/**
 * COMPOSED TIME-MACHINE ROWS — the amendment's gate list, item 5
 * (WC-2026-09-27-bulk-revert-undo-log §COMPOSED ROWS; PHP
 * `component_common::get_time_machine_data_to_save` :1580).
 *
 * Written by an author independent of the code under test. Every case pins an
 * OUTCOME — the rows left in `matrix_time_machine`, the live value after a
 * revert and the revert's report — never a writer's spelling.
 *
 * THE CONTRACT, per case:
 *   - a NORMAL save of a dataframe main writes ONE visible row under the main:
 *     its data (its lang slice for a sliced model) followed by the FULL frames
 *     of every slot of the main (other mains' frames in a shared slot too); a
 *     main with no slot writes the plain row (no column marks a composed row —
 *     decision 2026-09-28);
 *   - a SLOT save writes NO row under the slot tipo: it writes the MAIN's
 *     composed row (the main as stored + every slot after the write), and only
 *     the main the change belongs to (a shared slot);
 *   - under a bulk id the undo pair is composed on both sides, under the main;
 *   - the revert restores the main AND its frames from that one row; two mains
 *     sharing a slot are TWO units now (the removed union-find coupling): one
 *     refused leaves the other reverting, its frames kept in place;
 *   - the CSV door (replace and append, main + dataframe columns) records its
 *     frames the same way, and its run reverts main + slot together;
 *   - rows the revert cannot place (any row on a slot tipo — TS-era beta
 *     history, PHP never wrote one) are `failed`, and nothing is written for
 *     them; a main's rows without a BEFORE are a PHP-era run (legacy path).
 *
 * RE-COVERAGE OF THE REMOVED UNIT-COUPLING LOGIC (`unitRoot`, `slotOwnersOf`):
 *   - main + slot keys of one record → one unit: bulk_revert_undo_native "a
 *     MAIN and its frames are ONE composed unit" (all-or-nothing included);
 *   - every language of a sliced main coupled through its slot → one unit:
 *     bulk_revert_undo_native "the COMPOSED revert" (two-language run);
 *   - a slot SHARED by two mains, both written in one run → coupled into one
 *     unit by `slotOwnersOf`: here, "two mains sharing a slot" — now two units,
 *     each restoring its own frames (decision D-A);
 *   - a slot key written with no main key in the run: here, "a FRAMES-ONLY run";
 *   - a legacy slot row → N/A since 2026-09-28: TS-era beta history, refused
 *     `failed` here ("a SLOT row with no BEFORE"); a PHP-era frameless row
 *     restores as "no frames" (tm_dataframe_restore_native);
 *   - the stranded-frames check (`assertNoStrandedFrames`): N/A — a frame of a
 *     removed main item is part of the main's composed image, so the conflict
 *     check sees it (bulk_revert_undo_native "a dataframe main whose SLOT the
 *     run never touched").
 *
 * SITUATION: a `zztcr` scratch section on `test1` (→ matrix_test): a portal
 * MAIN whose request_config names SLOT, a portal MAIN2 whose request_config
 * names the same SLOT (a shared slot), a PLAIN portal with no slot, and a
 * translatable input_text LMAIN (has_dataframe) with its own slot LSLOT. The
 * CSV cases run on runtime-created `test3` records (test52 main + test60
 * slot). Every record, TM row, activity row, dd800 run and import file is
 * swept; the situation drop asserts zero residue. assertTestDatabase first.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from '../../src/config/config.ts';
import { sql } from '../../src/core/db/postgres.ts';
import { getMatrixTableFromTipo } from '../../src/core/ontology/resolver.ts';
import { resolveDataframeSlotTipos } from '../../src/core/relations/dataframe_slots.ts';
import { readComponentData } from '../../src/core/section/read.ts';
import { createSectionRecord } from '../../src/core/section/record/create_record.ts';
import { saveComponentData } from '../../src/core/section/record/save_component.ts';
import { resolvePrincipal } from '../../src/core/security/permissions.ts';
import {
	dropSituation,
	ensureSituation,
	situation,
} from '../../src/core/test_data/situations/situation.ts';
import { assertTestDatabase } from '../../src/core/test_data/test_database_marker.ts';
import { buildTmSectionRecord } from '../../src/core/tm_record/tm_record.ts';
import type { ImportFileReport } from '../../src/core/tools/import_wire.ts';
import { getLoadedTool } from '../../src/core/tools/loader.ts';
import { translateAndWrite } from '../../src/core/tools/translation.ts';
import {
	type BulkRevertSkipped,
	toolTimeMachineBulkRevert,
} from '../../tools/tool_time_machine/server/bulk_revert.ts';
import { toolTimeMachineApplyValue } from '../../tools/tool_time_machine/server/tool_time_machine.ts';
import { mustGet } from '../helpers/assert.ts';
import { demoteToLegacyRun, insertLegacyBulkRow } from '../helpers/legacy_bulk_run.ts';
import { cleanScratchRecord } from '../helpers/test_data.ts';
import { superuserTranslationGrant } from '../helpers/translation_grant.ts';

const TLD = 'zztcr';
const SECTION = `${TLD}1`;
const MAIN = `${TLD}2`; // portal → SLOT
const SLOT = `${TLD}3`; // component_dataframe, child of MAIN, named by MAIN2 too
const MAIN2 = `${TLD}4`; // portal whose request_config names SLOT (shared)
const PLAIN = `${TLD}5`; // portal, no slot
const LMAIN = `${TLD}6`; // input_text, translatable (lang-SLICED), has_dataframe
const LSLOT = `${TLD}7`; // component_dataframe, child of LMAIN
const IRI = `${TLD}8`; // component_iri — its slot is the model's FIXED dd560 (no child, no config)
const IRI2 = `${TLD}9`; // a second iri: its labels share dd560
const IRI_SLOT = 'dd560'; // component_iri's label dataframe (descriptor fixedDataframeTipos)
const TABLE = 'matrix_test';
const USER_ID = -1;

// the test3 playground (generic `test` TLD) — the CSV door's section
const T3 = 'test3';
const T3_TEXT = 'test52'; // component_input_text, translatable
const T3_SLOT = 'test60'; // component_dataframe (frames of test52)
const CSV_USER = 987_693;

const portalNaming = (tipo: string, slot: string | null) => ({
	tipo,
	parent: SECTION,
	model: 'component_portal',
	term: { 'lg-eng': `Portal ${tipo}` },
	properties: {
		source: {
			request_config: [
				{
					sqo: { section_tipo: [{ value: [SECTION], source: 'section' }] },
					...(slot === null
						? {}
						: { show: { ddo_map: [{ tipo: slot, parent: 'self', section_tipo: SECTION }] } }),
				},
			],
		},
	},
});

const SITUATION = situation({
	tld: TLD,
	name: 'tm_composed_rows',
	nodes: [
		{ tipo: SECTION, parent: 'test1', model: 'section', term: { 'lg-eng': 'Composed rows' } },
		portalNaming(MAIN, SLOT),
		{ tipo: SLOT, parent: MAIN, model: 'component_dataframe', term: { 'lg-eng': 'Slot' } },
		portalNaming(MAIN2, SLOT),
		portalNaming(PLAIN, null),
		{
			tipo: LMAIN,
			parent: SECTION,
			model: 'component_input_text',
			term: { 'lg-eng': 'Literal main' },
			is_translatable: true,
			properties: { has_dataframe: true },
		},
		{ tipo: LSLOT, parent: LMAIN, model: 'component_dataframe', term: { 'lg-eng': 'L slot' } },
		{ tipo: IRI, parent: SECTION, model: 'component_iri', term: { 'lg-eng': 'Iri' } },
		{ tipo: IRI2, parent: SECTION, model: 'component_iri', term: { 'lg-eng': 'Iri 2' } },
	],
});

type Item = Record<string, unknown>;

interface TmRow {
	id: number;
	tipo: string;
	lang: string | null;
	tm_role: number | null;
	bulk: number | null;
	data: unknown;
	absent: boolean;
}

interface RevertData {
	counter: number;
	unchanged: number;
	bulk_process_id: number;
	exact: 'full' | 'partial' | 'none';
	skipped: BulkRevertSkipped[];
	inexact: unknown[];
}

const runs: number[] = [];
const t3Records: number[] = [];
let bulkTable = '';
const csvDir = resolve(config.media.rootPath ?? '', 'import/files', String(CSV_USER));

// ---------------------------------------------------------------- helpers

/** Every TM row of one record (optionally one tipo), id ASC. */
async function tmRows(sectionTipo: string, sectionId: number, afterId = 0): Promise<TmRow[]> {
	const rows = (await sql.unsafe(
		`SELECT id, tipo, lang, tm_role, bulk_process_id AS bulk, data, data IS NULL AS absent
		   FROM matrix_time_machine
		  WHERE section_tipo = $1 AND section_id = $2 AND id > $3 ORDER BY id ASC`,
		[sectionTipo, sectionId, afterId],
	)) as TmRow[];
	return rows.map((row) => ({
		...row,
		id: Number(row.id),
		tm_role: row.tm_role === null ? null : Number(row.tm_role),
		bulk: row.bulk === null ? null : Number(row.bulk),
	}));
}

/** The highest TM row id now (a watermark: rows a case writes are above it). */
async function watermark(): Promise<number> {
	const rows = (await sql.unsafe('SELECT COALESCE(MAX(id), 0) AS m FROM matrix_time_machine')) as {
		m: number;
	}[];
	return Number(rows[0]?.m ?? 0);
}

async function rec(sectionTipo = SECTION): Promise<number> {
	const id = await createSectionRecord(sectionTipo, USER_ID);
	if (sectionTipo === T3) t3Records.push(id);
	return id;
}

async function mint(): Promise<number> {
	const id = await createSectionRecord('dd800', USER_ID);
	runs.push(id);
	return id;
}

/** The stored key: `undefined` = absent. */
async function stored(
	sectionId: number,
	column: string,
	key: string,
	sectionTipo = SECTION,
): Promise<unknown> {
	const rows = (await sql.unsafe(
		`SELECT (${column} ? $3) AS present, ${column}->$3 AS v FROM "${TABLE}"
		 WHERE section_tipo = $1 AND section_id = $2`,
		[sectionTipo, sectionId, key],
	)) as { present: boolean | null; v: unknown }[];
	if (rows.length === 0) return 'NO-RECORD';
	return rows[0]?.present === true ? rows[0]?.v : undefined;
}

async function seed(
	sectionId: number,
	column: string,
	key: string,
	value: unknown,
	sectionTipo = SECTION,
): Promise<void> {
	await sql.unsafe(
		`UPDATE "${TABLE}" SET ${column} = COALESCE(${column}, '{}'::jsonb) || jsonb_build_object($3::text, $4::text::jsonb)
		 WHERE section_tipo = $1 AND section_id = $2`,
		[sectionTipo, sectionId, key, JSON.stringify(value)],
	);
}

async function save(
	sectionId: number,
	componentTipo: string,
	lang: string,
	changedData: unknown[],
	extra: { bulk?: number | null; callerDataframe?: unknown } = {},
): Promise<Item[]> {
	const saved = await saveComponentData({
		componentTipo,
		sectionTipo: SECTION,
		sectionId,
		lang,
		changedData: changedData as never,
		userId: USER_ID,
		bulkProcessId: extra.bulk ?? null,
		callerDataframe: extra.callerDataframe as never,
	});
	expect(saved.ok).toBe(true);
	return (saved.data ?? []) as Item[];
}

async function insertLocator(
	id: number,
	main: string,
	target: number,
	bulk: number | null = null,
): Promise<number> {
	const items = await save(
		id,
		main,
		'lg-nolan',
		[{ action: 'insert', value: { section_tipo: SECTION, section_id: String(target) } }],
		{ bulk },
	);
	const found = items.find((item) => Number(item.section_id) === target);
	return Number(mustGet(found, 'inserted locator').id);
}

function insertFrame(
	id: number,
	slot: string,
	main: string,
	idKey: number,
	target: number,
	bulk: number | null = null,
) {
	return save(
		id,
		slot,
		'lg-nolan',
		[{ action: 'insert', value: { section_tipo: SECTION, section_id: String(target) } }],
		{ bulk, callerDataframe: { main_component_tipo: main, id_key: idKey } },
	);
}

const locator = (id: number, target: number, main = MAIN) => ({
	id,
	type: 'dd151',
	section_tipo: SECTION,
	section_id: target,
	from_component_tipo: main,
});
const frame = (id: number, idKey: number, target: number, main = MAIN, slot = SLOT) => ({
	id,
	type: 'dd490',
	id_key: idKey,
	section_tipo: SECTION,
	section_id: target,
	from_component_tipo: slot,
	main_component_tipo: main,
});
const framePairs = (value: unknown): string[] =>
	(Array.isArray(value) ? (value as Item[]) : [])
		.map(
			(entry) =>
				`${String(entry.main_component_tipo)}#${Number(entry.id_key)}->${Number(entry.section_id)}`,
		)
		.sort();
const targetsOf = (value: unknown): number[] =>
	(Array.isArray(value) ? (value as Item[]) : []).map((item) => Number(item.section_id)).sort();
const reasons = (data: RevertData): string[] => data.skipped.map((entry) => entry.reason).sort();

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

/** The newest VISIBLE history row of (record, tipo[, lang]). */
async function newestRow(sectionId: number, tipo: string, lang?: string): Promise<TmRow> {
	const rows = (await tmRows(SECTION, sectionId)).filter(
		(row) => row.tipo === tipo && row.tm_role === null && (lang === undefined || row.lang === lang),
	);
	return mustGet(rows.at(-1), `a visible ${tipo} row`);
}

/** apply_value of one history row (the tool's per-row "Apply and save"). */
async function applyValue(sectionId: number, tipo: string, row: TmRow): Promise<void> {
	const response = await toolTimeMachineApplyValue({
		principal: await resolvePrincipal(USER_ID),
		userId: USER_ID,
		options: {
			section_tipo: SECTION,
			section_id: sectionId,
			tipo,
			lang: row.lang ?? 'lg-nolan',
			matrix_id: row.id,
		},
		background: false,
	});
	expect(response.ok).toBe(true);
}

// CSV door (the tool's real import_files handler)
async function importCsv(
	file: string,
	csv: string,
	columnsMap: Record<string, unknown>[],
): Promise<ImportFileReport> {
	writeFileSync(resolve(csvDir, file), csv);
	const loaded = await getLoadedTool('tool_import_dedalo_csv');
	const res = await mustGet(loaded?.module.apiActions.import_files, 'import_files').handler({
		principal: await resolvePrincipal(USER_ID),
		userId: CSV_USER,
		background: false,
		options: {
			files: [{ file, section_tipo: T3, bulk_process_label: file, ar_columns_map: columnsMap }],
		},
	});
	const report = (res.data as { files: ImportFileReport[] }).files[0] as ImportFileReport;
	if (report.bulk_process_id !== null) runs.push(report.bulk_process_id);
	return report;
}
const col = (tipo: string, model: string, mode?: string): Record<string, unknown> => ({
	tipo,
	model,
	checked: true,
	map_to: tipo,
	...(mode === undefined ? {} : { import_mode: mode }),
});
const KEY = { tipo: 'section_id', model: 'section_id' };
const q = (value: string): string => `"${value.replace(/"/g, '""')}"`;

// ---------------------------------------------------------------- lifecycle

beforeAll(async () => {
	await assertTestDatabase('tm_composed_rows_native');
	await ensureSituation(SITUATION);
	// STRUCTURE FLOOR: the slot sets every case depends on.
	expect(await getMatrixTableFromTipo(SECTION)).toBe(TABLE);
	expect(await resolveDataframeSlotTipos(MAIN)).toEqual([SLOT]);
	expect(await resolveDataframeSlotTipos(MAIN2)).toEqual([SLOT]);
	expect(await resolveDataframeSlotTipos(PLAIN)).toEqual([]);
	expect(await resolveDataframeSlotTipos(LMAIN)).toEqual([LSLOT]);
	expect(await resolveDataframeSlotTipos(IRI)).toEqual([IRI_SLOT]);
	bulkTable = (await getMatrixTableFromTipo('dd800')) as string;
	mkdirSync(csvDir, { recursive: true });
}, 60_000);

afterAll(async () => {
	for (const id of t3Records) {
		await cleanScratchRecord(T3, id, TABLE);
		await sql.unsafe(
			'DELETE FROM matrix_time_machine WHERE section_tipo = $1 AND section_id = $2',
			[T3, id],
		);
	}
	await sql.unsafe('DELETE FROM matrix_time_machine WHERE section_tipo = $1', [SECTION]);
	await sql.unsafe('DELETE FROM dedalo_ts_record_generation WHERE section_tipo = $1', [SECTION]);
	await sql.unsafe(`DELETE FROM "${TABLE}" WHERE section_tipo = $1`, [SECTION]);
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
	for (const sectionTipo of [SECTION, T3]) {
		await sql.unsafe(`DELETE FROM matrix_activity WHERE data->>'section_tipo' = $1`, [sectionTipo]);
	}
	rmSync(csvDir, { recursive: true, force: true });
	const residue = (await sql.unsafe(
		`SELECT count(*)::int AS n FROM "${TABLE}" WHERE section_tipo = $1 AND section_id = ANY(string_to_array($2, ',')::int[])`,
		[T3, t3Records.join(',') || '0'],
	)) as { n: number }[];
	expect(residue[0]?.n).toBe(0);
	expect(await dropSituation(SITUATION)).toBe(0);
});

// ================================================================ normal saves

describe('a NORMAL save (outside a run) of a dataframe main', () => {
	test('the main row is COMPOSED: its items, then the FULL slot — every main’s frames in it', async () => {
		const id = await rec();
		const [t1, t2, r1, rOther] = [await rec(), await rec(), await rec(), await rec()];
		const slot = [frame(1, 1, r1), frame(2, 1, rOther, MAIN2)];
		await seed(id, 'relation', MAIN, [locator(1, t1)]);
		await seed(id, 'relation', SLOT, slot);
		const mark = await watermark();
		await insertLocator(id, MAIN, t2);
		const rows = await tmRows(SECTION, id, mark);
		const main = await stored(id, 'relation', MAIN);
		expect(targetsOf(main)).toEqual([t1, t2].sort());
		// Re-pinned 2026-11-12 (T1-21): the keys are seeded RAW (no history), so the
		// writer's save-before first records the composed BEFORE row, then the change.
		expect(rows.map((row) => [row.tipo, row.tm_role, row.bulk])).toEqual([
			[MAIN, null, null],
			[MAIN, null, null],
		]);
		expect(rows[0]?.data).toEqual([locator(1, t1), ...slot]);
		expect(rows[1]?.data).toEqual([...(main as unknown[]), ...slot]);
	});

	test('a main with NO slot writes the plain row: its items only', async () => {
		const id = await rec();
		const t1 = await rec();
		const mark = await watermark();
		await insertLocator(id, PLAIN, t1);
		const rows = await tmRows(SECTION, id, mark);
		expect(rows.map((row) => [row.tipo])).toEqual([[PLAIN]]);
		expect(rows[0]?.data).toEqual(await stored(id, 'relation', PLAIN));
	});

	test('a SLICED main writes its LANGUAGE lane only (its value, no frame): an unchanged frame writes no lg-nolan row', async () => {
		const id = await rec();
		const r1 = await rec();
		await seed(id, 'string', LMAIN, [{ id: 1, lang: 'lg-eng', value: 'eng text' }]);
		const slot = [frame(1, 1, r1, LMAIN, LSLOT)];
		await seed(id, 'relation', LSLOT, slot); // written WITHOUT history
		const first = await watermark();
		await save(id, LMAIN, 'lg-spa', [
			{ action: 'set_data', value: [{ id: 1, lang: 'lg-spa', value: 'spa draft' }] },
		]);
		// the frame lane is completed first: ONE lg-nolan baseline of the live frames
		const baseline = await tmRows(SECTION, id, first);
		expect(baseline.map((row) => [row.tipo, row.lang])).toEqual([
			[LMAIN, 'lg-nolan'],
			[LMAIN, 'lg-spa'],
		]);
		expect(baseline[0]?.data).toEqual(slot);
		const mark = await watermark();
		await save(id, LMAIN, 'lg-spa', [
			{ action: 'set_data', value: [{ id: 1, lang: 'lg-spa', value: 'spa text' }] },
		]);
		const rows = await tmRows(SECTION, id, mark);
		expect(rows.map((row) => [row.tipo, row.lang])).toEqual([[LMAIN, 'lg-spa']]);
		const spa = ((await stored(id, 'string', LMAIN)) as Item[]).filter(
			(item) => item.lang === 'lg-spa',
		);
		expect(spa.length).toBe(1);
		expect(rows[0]?.data).toEqual(spa);
	});

	test('a main whose slot is EMPTY writes a composed row equal to its items ("no frames" is recorded)', async () => {
		const id = await rec();
		const t1 = await rec();
		const mark = await watermark();
		await insertLocator(id, MAIN, t1);
		const rows = await tmRows(SECTION, id, mark);
		expect(rows.map((row) => [row.tipo])).toEqual([[MAIN]]);
		expect(rows[0]?.data).toEqual(await stored(id, 'relation', MAIN));
	});
});

describe('a NORMAL save of a SLOT', () => {
	test('writes NO slot row: the MAIN’s composed row records the frames after the write', async () => {
		const id = await rec();
		const [t1, r1] = [await rec(), await rec()];
		await seed(id, 'relation', MAIN, [locator(1, t1)]);
		const mark = await watermark();
		await insertFrame(id, SLOT, MAIN, 1, r1);
		const rows = await tmRows(SECTION, id, mark);
		const slot = await stored(id, 'relation', SLOT);
		expect(framePairs(slot)).toEqual([`${MAIN}#1->${r1}`]);
		expect(rows.filter((row) => row.tipo === SLOT)).toEqual([]);
		// Re-pinned 2026-11-12 (T1-21): the keys are seeded RAW (no history), so the
		// writer's save-before first records the composed BEFORE row, then the change.
		expect(rows.map((row) => [row.tipo, row.tm_role])).toEqual([
			[MAIN, null],
			[MAIN, null],
		]);
		expect(rows[0]?.data).toEqual([locator(1, t1)]);
		expect(rows[1]?.data).toEqual([locator(1, t1), ...(slot as unknown[])]);
	});

	test('a frame of MAIN2 into the SHARED slot is recorded under MAIN2 only — MAIN gets no row', async () => {
		const id = await rec();
		const [t1, r1, r2] = [await rec(), await rec(), await rec()];
		await seed(id, 'relation', MAIN, [locator(1, t1)]);
		await seed(id, 'relation', MAIN2, [locator(1, t1, MAIN2)]);
		await seed(id, 'relation', SLOT, [frame(1, 1, r1)]);
		const mark = await watermark();
		await insertFrame(id, SLOT, MAIN2, 1, r2);
		const rows = await tmRows(SECTION, id, mark);
		// Re-pinned 2026-11-12 (T1-21): the keys are seeded RAW (no history), so the
		// writer's save-before first records the composed BEFORE row, then the change.
		expect(rows.map((row) => [row.tipo])).toEqual([[MAIN2], [MAIN2]]);
		const slot = await stored(id, 'relation', SLOT);
		expect(rows[0]?.data).toEqual([locator(1, t1, MAIN2), frame(1, 1, r1)]);
		// MAIN2's items, then the FULL slot (MAIN's frame included — PHP's shape)
		expect(rows[1]?.data).toEqual([locator(1, t1, MAIN2), ...(slot as unknown[])]);
		expect(framePairs(slot)).toEqual([`${MAIN2}#1->${r2}`, `${MAIN}#1->${r1}`].sort());
	});
});

// ================================================================ undo pairs

describe('the undo pair of a bulk run is composed (main + frames)', () => {
	test('a MAIN save under a run: BEFORE and AFTER both carry the untouched frames', async () => {
		const id = await rec();
		const [t1, t2, r1] = [await rec(), await rec(), await rec()];
		const slot = [frame(1, 1, r1)];
		await seed(id, 'relation', MAIN, [locator(1, t1)]);
		await seed(id, 'relation', SLOT, slot);
		const run = await mint();
		await insertLocator(id, MAIN, t2, run);
		const rows = (await tmRows(SECTION, id)).filter((row) => row.bulk === run);
		expect(rows.map((row) => [row.tipo, row.tm_role])).toEqual([
			[MAIN, 1],
			[MAIN, null],
		]);
		expect(rows[0]?.data).toEqual([locator(1, t1), ...slot]);
		expect(rows[1]?.data).toEqual([
			...((await stored(id, 'relation', MAIN)) as unknown[]),
			...slot,
		]);
	});

	test('a SLOT save under a run with the main ALREADY framed: BEFORE = main + old frames, AFTER = main + all frames', async () => {
		const id = await rec();
		const [t1, r1, r2] = [await rec(), await rec(), await rec()];
		const pre = [frame(1, 1, r1)];
		await seed(id, 'relation', MAIN, [locator(1, t1)]);
		await seed(id, 'relation', SLOT, pre);
		const run = await mint();
		await insertFrame(id, SLOT, MAIN, 1, r2, run);
		const rows = (await tmRows(SECTION, id)).filter((row) => row.bulk === run);
		expect(rows.map((row) => [row.tipo, row.tm_role])).toEqual([
			[MAIN, 1],
			[MAIN, null],
		]);
		expect(rows[0]?.data).toEqual([locator(1, t1), ...pre]);
		expect(rows[1]?.data).toEqual([
			locator(1, t1),
			...((await stored(id, 'relation', SLOT)) as unknown[]),
		]);
	});
});

// ================================================================ revert

describe('two mains sharing a slot, both written in ONE run (the removed slotOwnersOf coupling)', () => {
	async function sharedRun() {
		const id = await rec();
		const [t1, t2, t3, rPre, rA, rB] = [
			await rec(),
			await rec(),
			await rec(),
			await rec(),
			await rec(),
			await rec(),
		];
		await seed(id, 'relation', MAIN, [locator(1, t1)]);
		await seed(id, 'relation', MAIN2, [locator(1, t1, MAIN2)]);
		await seed(id, 'relation', SLOT, [frame(1, 1, rPre)]);
		const pre = {
			main: await stored(id, 'relation', MAIN),
			main2: await stored(id, 'relation', MAIN2),
			slot: await stored(id, 'relation', SLOT),
		};
		const run = await mint();
		const itemA = await insertLocator(id, MAIN, t2, run);
		await insertFrame(id, SLOT, MAIN, itemA, rA, run);
		const itemB = await insertLocator(id, MAIN2, t3, run);
		await insertFrame(id, SLOT, MAIN2, itemB, rB, run);
		return { id, run, pre, rPre, rB, itemB };
	}

	test('each main is its OWN unit: both revert exactly, and the shared slot comes back whole', async () => {
		const { id, run, pre } = await sharedRun();
		const afterRun = {
			main: await stored(id, 'relation', MAIN),
			main2: await stored(id, 'relation', MAIN2),
			slot: framePairs(await stored(id, 'relation', SLOT)),
		};
		const data = await revert(run);
		expect(await stored(id, 'relation', MAIN)).toEqual(pre.main);
		expect(await stored(id, 'relation', MAIN2)).toEqual(pre.main2);
		expect(framePairs(await stored(id, 'relation', SLOT))).toEqual(framePairs(pre.slot));
		expect(data).toMatchObject({ counter: 2, unchanged: 0, exact: 'full', skipped: [] });
		const again = await revert(data.bulk_process_id);
		expect(await stored(id, 'relation', MAIN)).toEqual(afterRun.main);
		expect(await stored(id, 'relation', MAIN2)).toEqual(afterRun.main2);
		expect(framePairs(await stored(id, 'relation', SLOT))).toEqual(afterRun.slot);
		expect(again).toMatchObject({ counter: 2, exact: 'full', skipped: [] });
	});

	test('MAIN2’s frames edited after the run refuse MAIN2 ONLY: MAIN reverts, MAIN2 and its frames stay', async () => {
		const { id, run, pre, rPre, rB, itemB } = await sharedRun();
		const rEdit = await rec();
		await insertFrame(id, SLOT, MAIN2, 1, rEdit); // curator, after the run
		const main2After = await stored(id, 'relation', MAIN2);
		const data = await revert(run);
		expect(reasons(data)).toEqual(['changed_since_run']);
		expect(data.counter).toBe(1);
		expect(data.exact).toBe('partial');
		expect(await stored(id, 'relation', MAIN)).toEqual(pre.main);
		expect(await stored(id, 'relation', MAIN2)).toEqual(main2After);
		// MAIN's run frame gone, its pre frame kept; MAIN2's run frame AND the edit untouched
		expect(framePairs(await stored(id, 'relation', SLOT))).toEqual(
			[`${MAIN}#1->${rPre}`, `${MAIN2}#${itemB}->${rB}`, `${MAIN2}#1->${rEdit}`].sort(),
		);
	});
});

describe('a FRAMES-ONLY run (slot saves, the main never written by the run)', () => {
	test('the revert restores the frames under the main’s unit; revert-of-revert is exact', async () => {
		const id = await rec();
		const [t1, r1, r2] = [await rec(), await rec(), await rec()];
		await seed(id, 'relation', MAIN, [locator(1, t1)]);
		await seed(id, 'relation', SLOT, [frame(1, 1, r1)]);
		const pre = await stored(id, 'relation', SLOT);
		const run = await mint();
		await insertFrame(id, SLOT, MAIN, 1, r2, run);
		const afterRun = await stored(id, 'relation', SLOT);
		const data = await revert(run);
		expect(await stored(id, 'relation', SLOT)).toEqual(pre);
		expect(await stored(id, 'relation', MAIN)).toEqual([locator(1, t1)]);
		expect(data).toMatchObject({ counter: 1, unchanged: 0, exact: 'full', skipped: [] });
		const again = await revert(data.bulk_process_id);
		expect(framePairs(await stored(id, 'relation', SLOT))).toEqual(framePairs(afterRun));
		expect(again).toMatchObject({ counter: 1, exact: 'full', skipped: [] });
	});

	test('on a TRANSLATABLE literal main (the slot save speaks lg-nolan): counter 1, NOTHING unchanged', async () => {
		// The slot save is recorded under the main tagged with the main's lang
		// rule for the request lang (lg-nolan): no language of the main was
		// touched, so no language may be reported `unchanged` (WC §5: KEYS).
		const id = await rec();
		const r1 = await rec();
		await seed(id, 'string', LMAIN, [{ id: 1, lang: 'lg-spa', value: 'spa' }]);
		const run = await mint();
		await insertFrame(id, LSLOT, LMAIN, 1, r1, run);
		const data = await revert(run);
		expect(await stored(id, 'relation', LSLOT)).toBeUndefined();
		expect(await stored(id, 'string', LMAIN)).toEqual([{ id: 1, lang: 'lg-spa', value: 'spa' }]);
		expect(data).toMatchObject({ counter: 1, unchanged: 0, exact: 'full', skipped: [] });
	});
});

describe('a sliced main written in TWO languages AND framed in one run', () => {
	test('everything the run changed is reverted: counter 1, NOTHING reported unchanged', async () => {
		// The frame save is tagged lg-nolan under the translatable main (its lang
		// rule for the slot save's request lang). That tag is no language region
		// of the main, and every change of the run is undone: `unchanged` (WC §5,
		// KEYS already at their pre-run value, nothing written) must be 0.
		const id = await rec();
		const r1 = await rec();
		await save(id, LMAIN, 'lg-spa', [
			{ action: 'set_data', value: [{ id: 1, lang: 'lg-spa', value: 'pre spa' }] },
		]);
		await save(id, LMAIN, 'lg-eng', [
			{ action: 'set_data', value: [{ id: 1, lang: 'lg-eng', value: 'pre eng' }] },
		]);
		const pre = await stored(id, 'string', LMAIN);
		const run = await mint();
		await save(
			id,
			LMAIN,
			'lg-spa',
			[{ action: 'set_data', value: [{ id: 1, lang: 'lg-spa', value: 'run spa' }] }],
			{ bulk: run },
		);
		await insertFrame(id, LSLOT, LMAIN, 1, r1, run);
		await save(
			id,
			LMAIN,
			'lg-eng',
			[{ action: 'set_data', value: [{ id: 1, lang: 'lg-eng', value: 'run eng' }] }],
			{ bulk: run },
		);
		const data = await revert(run);
		expect(await stored(id, 'string', LMAIN)).toEqual(pre);
		expect(await stored(id, 'relation', LSLOT)).toBeUndefined();
		expect(data).toMatchObject({ counter: 1, exact: 'full', skipped: [] });
		expect(data.unchanged).toBe(0);
	});
});

describe('rows the revert cannot place are failed, never replayed', () => {
	test('a BEFORE row on a SLOT tipo (the dropped per-slot design): failed, the slot untouched', async () => {
		const id = await rec();
		const [t1, r1] = [await rec(), await rec()];
		await seed(id, 'relation', MAIN, [locator(1, t1)]);
		const live = [frame(1, 1, r1)];
		await seed(id, 'relation', SLOT, live);
		const run = await mint();
		// a dev-run shape: a hidden BEFORE (absent) + a visible AFTER on the slot tipo
		const before = await insertLegacyBulkRow({
			sectionTipo: SECTION,
			sectionId: id,
			tipo: SLOT,
			lang: 'lg-nolan',
			bulkId: run,
			data: null,
		});
		await sql.unsafe('UPDATE matrix_time_machine SET tm_role = 1 WHERE id = $1', [before]);
		await insertLegacyBulkRow({
			sectionTipo: SECTION,
			sectionId: id,
			tipo: SLOT,
			lang: 'lg-nolan',
			bulkId: run,
			data: live,
		});
		const data = await revert(run);
		expect(reasons(data)).toEqual(['failed']);
		expect(data.counter).toBe(0);
		expect(await stored(id, 'relation', SLOT)).toEqual(live);
	});

	test('a SLOT row with no BEFORE (a TS-era beta legacy slot row): failed, the slot untouched', async () => {
		const id = await rec();
		const [t1, r1] = [await rec(), await rec()];
		await seed(id, 'relation', MAIN, [locator(1, t1)]);
		const live = [frame(1, 1, r1)];
		await seed(id, 'relation', SLOT, live);
		const run = await mint();
		await insertLegacyBulkRow({
			sectionTipo: SECTION,
			sectionId: id,
			tipo: SLOT,
			lang: 'lg-nolan',
			bulkId: run,
			data: live,
		});
		const data = await revert(run);
		expect(reasons(data)).toEqual(['failed']);
		expect(data.counter).toBe(0);
		expect(await stored(id, 'relation', SLOT)).toEqual(live);
	});
});

// ================================================================ review 2026-09-27 (composed rows, round 2)

describe('apply_value of a COMPOSED row restores THIS main’s frames only (a shared slot)', () => {
	test('MAIN2’s frames edited after MAIN’s row stay live; MAIN’s frames come back as recorded', async () => {
		const id = await rec();
		const [t1, t2, rA, rA2, rB, rB2] = [
			await rec(),
			await rec(),
			await rec(),
			await rec(),
			await rec(),
			await rec(),
		];
		await seed(id, 'relation', MAIN, [locator(1, t1)]);
		await seed(id, 'relation', MAIN2, [locator(1, t1, MAIN2)]);
		await seed(id, 'relation', SLOT, [frame(1, 1, rA), frame(2, 1, rB, MAIN2)]);
		await insertLocator(id, MAIN, t2); // MAIN's composed row R: the FULL slot {A→rA, B→rB}
		const row = await newestRow(id, MAIN);
		// FLOOR: a composed row carrying both mains' frames
		expect(framePairs((row.data as Item[]).filter((entry) => entry.type === 'dd490'))).toEqual(
			[`${MAIN}#1->${rA}`, `${MAIN2}#1->${rB}`].sort(),
		);
		await insertFrame(id, SLOT, MAIN, 1, rA2); // MAIN's own later frame
		await insertFrame(id, SLOT, MAIN2, 1, rB2); // MAIN2's later frame
		await applyValue(id, MAIN, row);
		expect(targetsOf(await stored(id, 'relation', MAIN))).toEqual([t1, t2].sort());
		// MAIN rewound to rA; MAIN2 keeps BOTH its frames — never rewound to R's moment
		expect(framePairs(await stored(id, 'relation', SLOT))).toEqual(
			[`${MAIN}#1->${rA}`, `${MAIN2}#1->${rB}`, `${MAIN2}#1->${rB2}`].sort(),
		);
	});
});

describe('apply_value of ONE language’s row takes the frames AS OF it (two lanes)', () => {
	test('an eng restore: eng back, the spa item live, the frames the lg-nolan lane held at the row — minus the frame of an item deleted since', async () => {
		const id = await rec();
		const [r1, r2, r3] = [await rec(), await rec(), await rec()];
		await seed(id, 'string', LMAIN, [{ id: 1, lang: 'lg-eng', value: 'eng v0' }]);
		await save(id, LMAIN, 'lg-spa', [
			{ action: 'set_data', value: [{ id: 2, lang: 'lg-spa', value: 'spa two' }] },
		]); // the history knows spa item 2
		await seed(id, 'relation', LSLOT, [frame(1, 1, r1, LMAIN, LSLOT)]);
		await insertFrame(id, LSLOT, LMAIN, 2, r2); // the lg-nolan row: f1 + f2
		await save(id, LMAIN, 'lg-eng', [
			{ action: 'set_data', value: [{ id: 1, lang: 'lg-eng', value: 'eng v1' }] },
		]);
		const row = await newestRow(id, LMAIN, 'lg-eng'); // its value only
		expect((row.data as Item[]).filter((entry) => entry.type === 'dd490')).toEqual([]);
		// later: eng edited, spa item 2 gone (with its frame), spa item 3 added + framed
		await save(id, LMAIN, 'lg-spa', [{ action: 'remove', id: 2, value: null }]);
		await seed(id, 'string', LMAIN, [
			{ id: 1, lang: 'lg-eng', value: 'eng v2' },
			{ id: 3, lang: 'lg-spa', value: 'spa three' },
		]);
		await insertFrame(id, LSLOT, LMAIN, 3, r3);
		await applyValue(id, LMAIN, row);
		const main = (await stored(id, 'string', LMAIN)) as Item[];
		expect(main.map((item) => `${String(item.lang)}:${String(item.value)}`).sort()).toEqual([
			'lg-eng:eng v1',
			'lg-spa:spa three',
		]);
		// the frames AS OF the row (f1, f2 — the lg-nolan lane then); f2 pairs item
		// 2, deleted since: never written back (no orphan); f3 came after the row
		const pairs = framePairs(await stored(id, 'relation', LSLOT));
		expect(pairs).toContain(`${LMAIN}#1->${r1}`);
		expect(pairs).not.toContain(`${LMAIN}#2->${r2}`);
		expect(pairs).not.toContain(`${LMAIN}#3->${r3}`);
	});
});

describe('a FRAMES-ONLY run whose main changed afterwards', () => {
	test('a curator replaced the framed main item: the revert refuses, frames and main untouched', async () => {
		const id = await rec();
		const [t1, t9, r1] = [await rec(), await rec(), await rec()];
		await seed(id, 'relation', MAIN, [locator(1, t1)]);
		const run = await mint();
		await insertFrame(id, SLOT, MAIN, 1, r1, run);
		const slotAfterRun = await stored(id, 'relation', SLOT);
		await seed(id, 'relation', MAIN, [locator(1, t9)]); // curator, after the run
		const data = await revert(run);
		expect(reasons(data)).toEqual(['changed_since_run']);
		expect(data.counter).toBe(0);
		expect(await stored(id, 'relation', SLOT)).toEqual(slotAfterRun);
		expect(await stored(id, 'relation', MAIN)).toEqual([locator(1, t9)]);
	});
});

describe('a LEGACY run over a main with a declared slot', () => {
	test('reverted twice: the second revert reports the key unchanged, never changed_since_run', async () => {
		const id = await rec();
		const [t1, t2, t3, r1] = [await rec(), await rec(), await rec(), await rec()];
		await seed(id, 'relation', MAIN, [locator(1, t1)]);
		await seed(id, 'relation', SLOT, [frame(1, 1, r1)]);
		await insertLocator(id, MAIN, t2); // the pre-run visible row
		const pre = await stored(id, 'relation', MAIN);
		const run = await mint();
		await insertLocator(id, MAIN, t3, run);
		expect(await demoteToLegacyRun(run)).toBe(1);
		const first = await revert(run);
		expect(first).toMatchObject({ counter: 1, skipped: [] });
		expect(await stored(id, 'relation', MAIN)).toEqual(pre);
		expect(await stored(id, 'relation', SLOT)).toEqual([frame(1, 1, r1)]);
		const second = await revert(run);
		expect(second).toMatchObject({ counter: 0, unchanged: 1, skipped: [] });
		expect(await stored(id, 'relation', MAIN)).toEqual(pre);
	});
});

describe('a PHP-era LEGACY run whose rows carry frames (composed, no BEFORE)', () => {
	/** Pre-run row + the run's row, both main + frames, live = the run's state. */
	async function phpEraRun(): Promise<{ id: number; run: number; pre: Item[]; r1: number }> {
		const id = await rec();
		const [t1, t2, r1, r2] = [await rec(), await rec(), await rec(), await rec()];
		const pre = [locator(1, t1)];
		await insertLegacyBulkRow({
			sectionTipo: SECTION,
			sectionId: id,
			tipo: MAIN,
			lang: null,
			bulkId: null,
			data: [...pre, frame(1, 1, r1)],
		});
		const run = await mint();
		const after = [locator(1, t1), locator(2, t2)];
		await insertLegacyBulkRow({
			sectionTipo: SECTION,
			sectionId: id,
			tipo: MAIN,
			lang: null,
			bulkId: run,
			data: [...after, frame(1, 1, r2)],
		});
		await seed(id, 'relation', MAIN, after);
		await seed(id, 'relation', SLOT, [frame(1, 1, r2)]);
		return { id, run, pre, r1 };
	}

	test('untouched since the run: main AND frames come back to the pre-run row', async () => {
		const { id, run, pre, r1 } = await phpEraRun();
		const data = await revert(run);
		expect(data).toMatchObject({ counter: 1, skipped: [] });
		expect(await stored(id, 'relation', MAIN)).toEqual(pre);
		expect(await stored(id, 'relation', SLOT)).toEqual([frame(1, 1, r1)]);
	});

	test('a FRAME edited after the run (main unchanged): changed_since_run, the curator’s frame kept', async () => {
		const { id, run } = await phpEraRun();
		const r3 = await rec();
		await seed(id, 'relation', SLOT, [frame(1, 1, r3)]); // curator, after the run
		const main = await stored(id, 'relation', MAIN);
		const data = await revert(run);
		expect(reasons(data)).toEqual(['changed_since_run']);
		expect(data.counter).toBe(0);
		expect(await stored(id, 'relation', SLOT)).toEqual([frame(1, 1, r3)]);
		expect(await stored(id, 'relation', MAIN)).toEqual(main);
	});
});

describe('a slot change of a TRANSLATABLE main from a lang-less door', () => {
	test('ONE lg-nolan row (the frame lane: no value, all the frames) — never a copy per language', async () => {
		const id = await rec();
		const r1 = await rec();
		const eng = { id: 1, lang: 'lg-eng', value: 'eng' };
		const spa = { id: 2, lang: 'lg-spa', value: 'spa' };
		await seed(id, 'string', LMAIN, [eng, spa]);
		const mark = await watermark();
		await insertFrame(id, LSLOT, LMAIN, 1, r1); // the slot save speaks lg-nolan
		const rows = await tmRows(SECTION, id, mark);
		const slot = (await stored(id, 'relation', LSLOT)) as Item[];
		expect(rows.map((row) => [row.tipo, row.lang])).toEqual([[LMAIN, 'lg-nolan']]);
		expect(rows[0]?.data).toEqual(slot);
	});
});

describe('a tool_lang translation of a framed main', () => {
	test('writes ONE row in the target language’s lane (its value, no frame) — after completing the frame lane — and it restores, the frames as of it', async () => {
		const id = await rec();
		const r1 = await rec();
		const eng = { id: 1, lang: 'lg-eng', value: 'hello' };
		const slot = [frame(1, 1, r1, LMAIN, LSLOT)];
		await seed(id, 'string', LMAIN, [eng]);
		await seed(id, 'relation', LSLOT, slot);
		const mark = await watermark();
		const outcome = await translateAndWrite(await superuserTranslationGrant(SECTION, LMAIN, id), {
			model: 'component_input_text',
			sourceLang: 'lg-eng',
			targetLang: 'lg-spa',
			provider: async (request) => ({ ok: true, text: `ES ${request.text}`, msg: 'OK' }),
			uri: 'http://translator.invalid',
			key: '',
		});
		expect(outcome.ok).toBe(true);
		const rows = await tmRows(SECTION, id, mark);
		// the frames were seeded WITHOUT history: ONE lg-nolan baseline of them first
		expect(rows.map((row) => [row.tipo, row.lang])).toEqual([
			[LMAIN, 'lg-nolan'],
			[LMAIN, 'lg-spa'],
		]);
		expect(rows[0]?.data).toEqual(slot);
		const spa = ((await stored(id, 'string', LMAIN)) as Item[]).filter(
			(item) => item.lang === 'lg-spa',
		);
		expect(rows[1]?.data).toEqual(spa);
		// the frames as of it: the baseline — restoring the translation keeps them
		await applyValue(id, LMAIN, mustGet(rows[1], 'translation row'));
		expect(await stored(id, 'relation', LSLOT)).toEqual(slot);
	});
});

// ================================================================ CSV door

describe('the CSV door with a main AND its dataframe column', () => {
	const frames = (target: number, idKey = 1) => [
		{ section_tipo: T3, section_id: target, main_component_tipo: T3_TEXT, id_key: idKey },
	];

	for (const mode of ['replace', 'append'] as const) {
		test(`${mode.toUpperCase()}: pairs only under the MAIN, composed; the revert restores main AND slot; revert-of-revert exact`, async () => {
			const host = await rec(T3);
			const [pre, target] = [await rec(T3), await rec(T3)];
			const preMain = [{ id: 1, lang: 'lg-spa', value: 'stored' }];
			const preSlot = [
				{
					id: 1,
					type: 'dd490',
					id_key: 1,
					section_tipo: T3,
					section_id: pre,
					from_component_tipo: T3_SLOT,
					main_component_tipo: T3_TEXT,
				},
			];
			await seed(host, 'string', T3_TEXT, preMain, T3);
			await seed(host, 'relation', T3_SLOT, preSlot, T3);
			const main = [{ id: 1, lang: 'lg-spa', value: `${mode} value` }];
			const report = await importCsv(
				`composed_${mode}_${host}.csv`,
				`section_id;${T3_SLOT};${T3_TEXT}\n${host};${q(JSON.stringify(frames(target)))};${q(JSON.stringify(main))}\n`,
				[
					KEY,
					col(T3_SLOT, 'component_dataframe', mode === 'append' ? 'append' : undefined),
					col(T3_TEXT, 'component_input_text', mode === 'append' ? 'append' : undefined),
				],
			);
			expect(report.failed).toEqual([]);
			const run = mustGet(report.bulk_process_id, 'run id');
			const afterRun = {
				main: await stored(host, 'string', T3_TEXT, T3),
				slot: await stored(host, 'relation', T3_SLOT, T3),
			};
			// FLOOR: the run changed both halves.
			expect(afterRun.main).not.toEqual(preMain);
			expect((afterRun.slot as Item[]).some((entry) => Number(entry.section_id) === target)).toBe(
				true,
			);
			const rows = (await tmRows(T3, host)).filter((row) => row.bulk === run);
			expect(rows.filter((row) => row.tipo === T3_SLOT)).toEqual([]);
			expect(rows.length).toBeGreaterThanOrEqual(2);
			expect(rows.every((row) => row.tipo === T3_TEXT)).toBe(true);
			// the NEWEST after-row records the slot as it stands after the run
			const newest = rows.filter((row) => row.tm_role === null).at(-1);
			const recordedFrames = (newest?.data as Item[]).filter((entry) => entry.type === 'dd490');
			expect(recordedFrames).toEqual(afterRun.slot as Item[]);

			const data = await revert(run);
			expect(data).toMatchObject({ exact: 'full', skipped: [] });
			expect(await stored(host, 'string', T3_TEXT, T3)).toEqual(preMain);
			expect(await stored(host, 'relation', T3_SLOT, T3)).toEqual(preSlot);
			const again = await revert(data.bulk_process_id);
			expect(again).toMatchObject({ exact: 'full', skipped: [] });
			expect(await stored(host, 'string', T3_TEXT, T3)).toEqual(afterRun.main);
			expect(framePairsT3(await stored(host, 'relation', T3_SLOT, T3))).toEqual(
				framePairsT3(afterRun.slot),
			);
		}, 60_000);
	}
});

function framePairsT3(value: unknown): string[] {
	return (Array.isArray(value) ? (value as Item[]) : [])
		.map((entry) => `${Number(entry.id_key)}->${Number(entry.section_id)}`)
		.sort();
}

// ================================================================ a FIXED slot (component_iri → dd560)

describe('component_iri: its FIXED dd560 label slot is a declared slot (review 2026-09-27)', () => {
	const LABEL_SECTION = 'dd1706'; // dd560's declared target (its sqo)
	const labels: number[] = [];
	const labelRecord = async (): Promise<number> => {
		const labelId = await createSectionRecord(LABEL_SECTION, USER_ID);
		labels.push(labelId);
		return labelId;
	};
	const label = (id: number, iri: string, idKey: number, target: number) => ({
		type: 'dd490',
		id,
		id_key: idKey,
		section_tipo: LABEL_SECTION,
		section_id: target,
		from_component_tipo: IRI_SLOT,
		main_component_tipo: iri,
	});
	const labelPairs = (value: unknown): string[] =>
		(Array.isArray(value) ? (value as Item[]) : [])
			.map(
				(entry) =>
					`${String(entry.main_component_tipo)}#${Number(entry.id_key)}->${Number(entry.section_id)}`,
			)
			.sort();

	afterAll(async () => {
		const table = (await getMatrixTableFromTipo(LABEL_SECTION)) as string;
		for (const labelId of labels) await cleanScratchRecord(LABEL_SECTION, labelId, table);
	});

	test('a label-less iri writes a COMPOSED row; applying it later removes the iri’s own later label, keeps another iri’s', async () => {
		const id = await rec();
		const [lLater, lOther] = [await labelRecord(), await labelRecord()];
		await seed(id, 'iri', IRI2, [{ id: 1, lang: 'lg-nolan', iri: 'https://example.org/two' }]);
		await seed(id, 'relation', IRI_SLOT, [label(1, IRI2, 1, lOther)]);
		const mark = await watermark();
		await save(id, IRI, 'lg-nolan', [
			{ action: 'set_data', value: [{ id: 1, lang: 'lg-nolan', iri: 'https://example.org/one' }] },
		]);
		const rows = (await tmRows(SECTION, id, mark)).filter((row) => row.tipo === IRI);
		// composed: "this iri had NO label" is recorded
		expect(rows.map((row) => [row.tm_role])).toEqual([[null]]);
		const row = await newestRow(id, IRI);
		await save(
			id,
			IRI_SLOT,
			'lg-nolan',
			[{ action: 'insert', value: { section_tipo: LABEL_SECTION, section_id: String(lLater) } }],
			{ callerDataframe: { main_component_tipo: IRI, id_key: 1 } },
		); // the curator labels it afterwards
		expect(labelPairs(await stored(id, 'relation', IRI_SLOT))).toEqual(
			[`${IRI}#1->${lLater}`, `${IRI2}#1->${lOther}`].sort(),
		);
		await applyValue(id, IRI, row);
		// the iri's own later label is gone (it did not exist in the snapshot); IRI2's stays
		expect(labelPairs(await stored(id, 'relation', IRI_SLOT))).toEqual([`${IRI2}#1->${lOther}`]);
	});

	// review 2026-09-28: every reader splits a snapshot by the ONE frame
	// predicate (splitComposed). The old iri strip kept only entries carrying
	// `iri`, so a v6 title-only item vanished from the list cell, the preview
	// and the restore — the restore then also rewrote its label away.
	const titleOnly = { id: 1, lang: 'lg-nolan', title: 'A v6 title-only item' };
	const iriItem = { id: 2, lang: 'lg-nolan', iri: 'https://example.org/two' };

	test('the dd15 list keeps a title-only iri item, in a composed row and in a frameless one', async () => {
		const id = await rec();
		const lA = await labelRecord();
		const row = (data: unknown[]) =>
			({
				id: 0,
				section_id: id,
				section_tipo: SECTION,
				tipo: IRI,
				lang: 'lg-nolan',
				timestamp: null,
				user_id: USER_ID,
				bulk_process_id: null,
				data,
				dataText: null,
			}) as never;
		const composed = await buildTmSectionRecord(
			row([titleOnly, iriItem, label(1, IRI, 1, lA)]),
			'lg-nolan',
			[IRI_SLOT],
		);
		expect((composed.columns.iri as Record<string, unknown>)[IRI]).toStrictEqual([
			titleOnly,
			iriItem,
		]);
		expect((composed.columns.relation as Record<string, unknown>)[IRI_SLOT]).toStrictEqual([
			label(1, IRI, 1, lA),
		]);
		const frameless = await buildTmSectionRecord(row([titleOnly]), 'lg-nolan', [IRI_SLOT]);
		expect((frameless.columns.iri as Record<string, unknown>)[IRI]).toStrictEqual([titleOnly]);
	});

	test('preview and apply_value of a composed iri row keep the title-only item AND its label', async () => {
		const id = await rec();
		const lA = await labelRecord();
		await seed(id, 'relation', IRI_SLOT, [label(1, IRI, 1, lA)]);
		await save(id, IRI, 'lg-nolan', [{ action: 'set_data', value: [titleOnly, iriItem] }]);
		const pre = await stored(id, 'iri', IRI);
		expect((pre as Item[]).map((item) => item.id)).toEqual([1, 2]); // FLOOR: the engine stored both
		const row = await newestRow(id, IRI);
		await save(id, IRI, 'lg-nolan', [{ action: 'set_data', value: [iriItem] }]);
		await seed(id, 'relation', IRI_SLOT, []); // the item's label went with it
		const previewed = (await readComponentData({
			source: {
				tipo: IRI,
				section_tipo: SECTION,
				section_id: id,
				lang: 'lg-nolan',
				mode: 'edit',
				data_source: 'tm',
				matrix_id: row.id,
			},
		} as never)) as { tipo: string; entries?: Item[] }[];
		expect(
			previewed.filter((item) => item.tipo === IRI).flatMap((item) => item.entries ?? []),
		).toEqual(pre as Item[]);
		await applyValue(id, IRI, row);
		expect(await stored(id, 'iri', IRI)).toEqual(pre);
		expect(labelPairs(await stored(id, 'relation', IRI_SLOT))).toEqual([`${IRI}#1->${lA}`]);
	});
});

// ================================================================ review 2026-09-27 (2): lang of slot-attributed pairs

/** apply_value of one history row of any section. */
async function applyValueAt(
	sectionTipo: string,
	sectionId: number,
	tipo: string,
	row: TmRow,
): Promise<void> {
	const response = await toolTimeMachineApplyValue({
		principal: await resolvePrincipal(USER_ID),
		userId: USER_ID,
		options: {
			section_tipo: sectionTipo,
			section_id: sectionId,
			tipo,
			lang: row.lang ?? 'lg-nolan',
			matrix_id: row.id,
		},
		background: false,
	});
	expect(response.ok).toBe(true);
}

describe('a CSV FRAMES-ONLY import under a TRANSLATABLE literal main (review 2026-09-27)', () => {
	// The slot save speaks lg-nolan; the main holds eng + spa. TWO LANES: the
	// run's undo pair is ONE pair in the lg-nolan lane (the frame lane: no value,
	// all the frames) — never a copy per language.
	for (const mode of ['replace', 'append'] as const) {
		test(`${mode.toUpperCase()}: one lg-nolan pair; its after-row restores the frames; the revert's own history too`, async () => {
			const host = await rec(T3);
			const target = await rec(T3);
			const eng = { id: 1, lang: 'lg-eng', value: 'eng' };
			const spa = { id: 2, lang: 'lg-spa', value: 'spa' };
			await seed(host, 'string', T3_TEXT, [eng, spa], T3);
			const frames = [
				{ section_tipo: T3, section_id: target, main_component_tipo: T3_TEXT, id_key: 1 },
			];
			const mark = await watermark();
			const report = await importCsv(
				`frames_only_${mode}_${host}.csv`,
				`section_id;${T3_SLOT}\n${host};${q(JSON.stringify(frames))}\n`,
				[KEY, col(T3_SLOT, 'component_dataframe', mode === 'append' ? 'append' : undefined)],
			);
			expect(report.failed).toEqual([]);
			const run = mustGet(report.bulk_process_id, 'run id');
			const afterSlot = await stored(host, 'relation', T3_SLOT, T3);
			expect(framePairsT3(afterSlot)).toEqual([`1->${target}`]); // FLOOR: the run framed

			const rows = (await tmRows(T3, host, mark)).filter((row) => row.tipo === T3_TEXT);
			expect(rows.map((row) => row.lang)).toEqual(['lg-nolan', 'lg-nolan']); // B + A
			const pairAfter = mustGet(
				rows.find((row) => row.tm_role === null && row.bulk === run),
				'the pair after-row',
			);
			expect(pairAfter.data).toEqual(afterSlot);

			// a curator drops the frames (TM off); applying the run's visible after-row brings them back
			await seed(host, 'relation', T3_SLOT, [], T3);
			await applyValueAt(T3, host, T3_TEXT, pairAfter);
			expect(framePairsT3(await stored(host, 'relation', T3_SLOT, T3))).toEqual([`1->${target}`]);
			// the main is untouched in content (an lg-nolan row of a translatable main: frames only)
			const byId = (value: unknown) =>
				[...((value as Item[]) ?? [])].sort((a, b) => Number(a.id) - Number(b.id));
			expect(byId(await stored(host, 'string', T3_TEXT, T3))).toEqual([eng, spa]);

			// the revert's OWN frames-only history obeys the same rule
			const revertMark = await watermark();
			const reverted = await revert(run);
			expect(reverted).toMatchObject({ counter: 1, exact: 'full', skipped: [] });
			expect(framePairsT3(await stored(host, 'relation', T3_SLOT, T3))).toEqual([]);
			const revertRows = (await tmRows(T3, host, revertMark)).filter((row) => row.tipo === T3_TEXT);
			expect(revertRows.map((row) => row.lang)).toEqual(['lg-nolan', 'lg-nolan']);
			const again = await revert(reverted.bulk_process_id);
			expect(again).toMatchObject({ counter: 1, exact: 'full', skipped: [] });
			expect(framePairsT3(await stored(host, 'relation', T3_SLOT, T3))).toEqual([`1->${target}`]);
		}, 60_000);
	}
});

describe('the composed revert of a component_iri main keeps entries that are neither iri nor frame (review 2026-09-27)', () => {
	test('a title-only iri item replaced by a run comes back byte-exact', async () => {
		const id = await rec();
		const pre = [{ id: 1, lang: 'lg-nolan', title: 'A v6 title-only item' }];
		await seed(id, 'iri', IRI, pre);
		const run = await mint();
		await save(
			id,
			IRI,
			'lg-nolan',
			[
				{
					action: 'set_data',
					value: [{ id: 1, lang: 'lg-nolan', iri: 'https://example.org/new' }],
				},
			],
			{ bulk: run },
		);
		expect(await stored(id, 'iri', IRI)).not.toEqual(pre); // FLOOR: the run replaced it
		const data = await revert(run);
		expect(data).toMatchObject({ counter: 1, exact: 'full', skipped: [], inexact: [] });
		expect(await stored(id, 'iri', IRI)).toEqual(pre);
	});
});
