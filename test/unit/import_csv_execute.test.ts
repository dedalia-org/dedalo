/**
 * CSV import EXECUTOR gate (src/core/tools/import_csv_execute.ts) — the write half,
 * driven through the tool's real `import_files` handler against the REAL DB on a
 * SCRATCH record (created and removed here; the canonical test3 playground is
 * never touched).
 *
 * These are the behaviours the planner/conform tests CANNOT see, because they only
 * exist once something is actually written:
 *
 *  1. METADATA COLUMNS. created_date/modified_date (dd199/dd201) and
 *     created_by_user/modified_by_user (dd200/dd197) need a DUAL write — the audit
 *     component AND the record's own `data`-column metadata — with the record's
 *     modified stamp SUPPRESSED for that row. Miss the suppression and the save
 *     that carries the imported timestamp overwrites it with "now, by the importer"
 *     one column later.
 *  2. WARNINGS. The one warning the engine produces: a lang that resolves but is
 *     not a project language. It must be IMPORTED and flagged — not rejected.
 *  3. PREFLIGHT. validate_import must catch a bad column map and write NOTHING.
 *  4. APPEND MODE (plan §5). A column in `import_mode: 'append'` ADDS to the
 *     stored items; a duplicate is skipped and reported; an empty cell is a
 *     no-op; an appended main's legacy frames are re-paired to the FINAL item
 *     id (no match fails the row); a replace slot that names or STORES frames
 *     of an append main fails the row (an unrelated one imports); a replace
 *     envelope whose frames name an append main fails the row.
 *  5. A REPLACE row's legacy envelope frames keep the imported dd201 stamp.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from '../../src/config/config.ts';
import { DATAFRAME_RELATION_TYPE, isDataframeEntry } from '../../src/core/concepts/subdatum.ts';
import { sql } from '../../src/core/db/postgres.ts';
import { ddDateToSeconds } from '../../src/core/media/file_date.ts';
import { resolvePrincipal } from '../../src/core/security/permissions.ts';
import type { ImportFileReport } from '../../src/core/tools/import_wire.ts';
import { getLoadedTool } from '../../src/core/tools/loader.ts';
import { mustGet } from '../helpers/assert.ts';

const SECTION = 'test3';
const USER = 987670;
const ID = 900700; // far outside the canonical test3 ids
const DF_ID = 914000; // the dataframe gate's own scratch record
const APPEND_ID = 914100; // the append-mode gate's own scratch record
const APPEND_FRAME_ID = 914110; // the append frame-remap gate's own scratch record
const MIXED_ID = 914120; // the mixed-mode envelope gate's own scratch record
const STAMP_ID = 914200; // the envelope-frames-keep-the-stamp gate's own scratch record
const BAD_SLOT_ID = 914210; // the non-dataframe-slot warning gate's own scratch record
const STAMPS_ID = 914220; // the four-stamp round-trip gate's own scratch record
const ZOTERO_FREE_ID = 914230; // the Zotero-limit scope gate: a record the CSV creates, then holds a code
const ZOTERO_KEYLESS_ID = 914231; // …and one that holds none
/** A component_portal of test3 (→ test3): an APPEND main distinct from TEXT. */
const PORTAL = 'test80';
/** A component_dataframe of the test3 family (parent test45). */
const DATAFRAME = 'test60';
const CSV = 'execute_gate.csv';
const dir = resolve(config.media.rootPath ?? '', 'import/files', String(USER));

/** Audit tipos (concepts/section.ts AUDIT_TIPOS). */
const CREATED_DATE = 'dd199';
const MODIFIED_DATE = 'dd201';
const CREATED_BY = 'dd200';
const MODIFIED_BY = 'dd197';
const SELECT_LANG = 'test89';
const TEXT = 'test52';

const bulkProcessIds: number[] = [];

beforeAll(() => {
	mkdirSync(dir, { recursive: true });
});

afterAll(async () => {
	rmSync(dir, { recursive: true, force: true });
	for (const id of [
		ID,
		DF_ID,
		APPEND_ID,
		APPEND_FRAME_ID,
		MIXED_ID,
		STAMP_ID,
		BAD_SLOT_ID,
		STAMPS_ID,
		ZOTERO_FREE_ID,
		ZOTERO_KEYLESS_ID,
	]) {
		await sql.unsafe('DELETE FROM matrix_test WHERE section_tipo = $1 AND section_id = $2', [
			SECTION,
			id,
		]);
		await sql.unsafe(
			'DELETE FROM matrix_time_machine WHERE section_tipo = $1 AND section_id = $2',
			[SECTION, id],
		);
	}
	for (const id of bulkProcessIds) {
		await sql.unsafe(`DELETE FROM matrix_notes WHERE section_tipo = 'dd800' AND section_id = $1`, [
			id,
		]);
		await sql.unsafe(
			`DELETE FROM matrix_time_machine WHERE section_tipo = 'dd800' AND section_id = $1`,
			[id],
		);
	}
});

/** Run the tool's real import_files over a CSV written for this test. */
async function importCsv(
	csv: string,
	columnsMap: Record<string, unknown>[],
): Promise<ImportFileReport> {
	writeFileSync(resolve(dir, CSV), csv);
	const loaded = await getLoadedTool('tool_import_dedalo_csv');
	const res = await mustGet(loaded!.module.apiActions.import_files, 'import_files').handler({
		principal: await resolvePrincipal(-1),
		userId: USER,
		background: false,
		options: {
			time_machine_save: true,
			files: [
				{
					file: CSV,
					section_tipo: SECTION,
					bulk_process_label: 'execute gate',
					ar_columns_map: columnsMap,
				},
			],
		},
	});
	const report = (res.data as { files: ImportFileReport[] }).files[0] as ImportFileReport;
	if (report.bulk_process_id !== null) bulkProcessIds.push(report.bulk_process_id);
	return report;
}

const KEY_COLUMN = { tipo: 'section_id', model: 'section_id' };

describe('metadata columns get the dual write, with the modified stamp suppressed', () => {
	test('an imported created_date lands in BOTH the component and the record metadata', async () => {
		const report = await importCsv(
			`section_id;${CREATED_DATE}_dmy;${MODIFIED_DATE}_dmy;${TEXT}\n` +
				`${ID};21-05-1998;03-04-2001;a record with history\n`,
			[
				KEY_COLUMN,
				{
					tipo: `${CREATED_DATE}_dmy`,
					model: 'component_date',
					checked: true,
					map_to: CREATED_DATE,
				},
				{
					tipo: `${MODIFIED_DATE}_dmy`,
					model: 'component_date',
					checked: true,
					map_to: MODIFIED_DATE,
				},
				{ tipo: TEXT, model: 'component_input_text', checked: true, map_to: TEXT },
			],
		);
		expect(report.failed).toEqual([]);
		expect(report.created).toEqual([ID]);

		const rows = (await sql.unsafe(
			`SELECT date -> '${CREATED_DATE}' AS created_component,
			        date -> '${MODIFIED_DATE}' AS modified_component,
			        data ->> 'created_date'   AS created_metadata
			   FROM matrix_test WHERE section_tipo = $1 AND section_id = $2`,
			[SECTION, ID],
		)) as {
			created_component: { start?: Record<string, number> }[];
			modified_component: { start?: Record<string, number> }[];
			created_metadata: string | null;
		}[];
		const row = rows[0];

		// 1. the audit COMPONENT carries the imported date (the edit view reads this).
		// The PERSISTED shape also carries the virtual-calendar sort key: PHP
		// component_date::save() runs add_time() on every non-empty item and the TS
		// twin does the same (save_component.ts → addTimeToDateItem), so a stored
		// date WITHOUT `time` is the bug — it cannot be ordered or range-searched.
		expect(row?.created_component?.[0]?.start).toEqual({
			day: 21,
			month: 5,
			year: 1998,
			time: ddDateToSeconds({ day: 21, month: 5, year: 1998 }),
		});

		// 2. the record's own `data` METADATA carries it too (list views read THIS).
		// Writing only the component leaves a record whose edit view says 1998 while
		// every list says "created today".
		expect(row?.created_metadata).toContain('1998-05-21');

		// 3. THE SUPPRESSION: the imported modified_date survived. Every other column
		// of this row was saved AFTER it; without skipModifiedStamp each of those
		// saves re-stamps dd201 with "now", silently destroying the value we imported.
		expect(row?.modified_component?.[0]?.start).toEqual({
			day: 3,
			month: 4,
			year: 2001,
			time: ddDateToSeconds({ day: 3, month: 4, year: 2001 }),
		});
	});
});

describe('the FOUR audit stamps round-trip (export → re-import restores who AND when)', () => {
	test('dd199/dd200/dd197/dd201 land in the components + the record metadata; nothing re-stamps them', async () => {
		// The import ACTS as -1 (importCsv's principal: executeCsvImport stamps
		// createSectionRecord + every save with principal.userId; ctx.userId=USER
		// only names the staging dir). The file says the record was created AND
		// modified by STAMPED_USER, a different dd128 id, so every WHO assertion
		// below tells an imported stamp from the importer's own (-1): a dropped
		// dual write or a re-stamp would leave -1 and go red.
		const STAMPED_USER = USER;
		expect(STAMPED_USER).not.toBe((await resolvePrincipal(-1)).userId);
		const locator = (tipo: string): string =>
			`"[{""type"":""dd151"",""section_id"":${STAMPED_USER},""section_tipo"":""dd128"",""from_component_tipo"":""${tipo}""}]"`;
		const report = await importCsv(
			`section_id;${CREATED_DATE}_dmy;${CREATED_BY};${MODIFIED_BY};${MODIFIED_DATE}_dmy;${TEXT}\n` +
				`${STAMPS_ID};21-05-1998;${locator(CREATED_BY)};${locator(MODIFIED_BY)};03-04-2001;stamped\n`,
			[
				KEY_COLUMN,
				{
					tipo: `${CREATED_DATE}_dmy`,
					model: 'component_date',
					checked: true,
					map_to: CREATED_DATE,
				},
				{ tipo: CREATED_BY, model: 'component_select', checked: true, map_to: CREATED_BY },
				{ tipo: MODIFIED_BY, model: 'component_select', checked: true, map_to: MODIFIED_BY },
				{
					tipo: `${MODIFIED_DATE}_dmy`,
					model: 'component_date',
					checked: true,
					map_to: MODIFIED_DATE,
				},
				// A column saved AFTER the modified pair: without the suppression it
				// re-stamps dd197/dd201 with "now, by USER".
				{ tipo: TEXT, model: 'component_input_text', checked: true, map_to: TEXT },
			],
		);
		expect(report.failed).toEqual([]);
		expect(report.created).toEqual([STAMPS_ID]);

		const rows = (await sql.unsafe(
			`SELECT relation -> '${CREATED_BY}' AS created_by,
			        relation -> '${MODIFIED_BY}' AS modified_by,
			        date -> '${CREATED_DATE}' AS created_date,
			        date -> '${MODIFIED_DATE}' AS modified_date,
			        (data ->> 'created_by_user_id')::int AS created_by_metadata,
			        data ->> 'created_date' AS created_date_metadata
			   FROM matrix_test WHERE section_tipo = $1 AND section_id = $2`,
			[SECTION, STAMPS_ID],
		)) as {
			created_by: { section_id?: number | string; section_tipo?: string }[] | null;
			modified_by: { section_id?: number | string; section_tipo?: string }[] | null;
			created_date: { start?: Record<string, number> }[] | null;
			modified_date: { start?: Record<string, number> }[] | null;
			created_by_metadata: number | null;
			created_date_metadata: string | null;
		}[];
		const row = rows[0];
		const userOf = (items: { section_id?: number | string }[] | null | undefined): number[] =>
			(items ?? []).map((item) => Number(item.section_id));

		// WHO: both user components hold exactly the imported user, never the importer.
		expect(userOf(row?.created_by)).toEqual([STAMPED_USER]);
		expect(userOf(row?.modified_by)).toEqual([STAMPED_USER]);
		// The created_by `data` twin (list views read it) follows the component.
		// (The modified pair has NO `data` twin — record_metadata.ts: the modified
		// stamps live only in the relation/date columns asserted here.)
		expect(row?.created_by_metadata).toBe(STAMPED_USER);
		// WHEN: both dates are the imported ones.
		expect(row?.created_date?.[0]?.start).toMatchObject({ day: 21, month: 5, year: 1998 });
		expect(row?.created_date_metadata).toContain('1998-05-21');
		expect(row?.modified_date?.[0]?.start).toMatchObject({ day: 3, month: 4, year: 2001 });
	});
});

describe('imported dataframe frames carry the ENGINE marker (D19)', () => {
	test('a frame written by import satisfies isDataframeEntry (type dd490)', async () => {
		// D19, FIXED 2026-08-09: writeDataframeFrames stamped the literal
		// 'dataframe' from a module-local constant, overwriting even a correct
		// dd490 the engine's OWN export had produced. No reader recognises it:
		// isDataframeEntry/dataframeEntriesEqual test dd490, so the frame was
		// invisible in the widget and undeletable through the UI — and WORSE, the
		// `type !== 'dd490'` filters in save_component's observer diff and
		// delete_record's cascade read it as a REAL portal edge.
		const envelope = JSON.stringify({
			dedalo_data: {
				dato: ['a main value with a frame'],
				dataframe: [
					{
						// the framed target locator (never the host record itself) + the
						// engine's OWN export shape: a CORRECT dd490 the importer used to
						// downgrade on a plain export → import round trip.
						section_tipo: SECTION,
						section_id: String(DF_ID + 1),
						from_component_tipo: DATAFRAME,
						id_key: 1,
						type: 'dd490',
					},
				],
			},
		});
		// CSV-quote the cell: the reader strips bare double quotes otherwise.
		const cell = `"${envelope.replace(/"/g, '""')}"`;
		const report = await importCsv(`section_id;${TEXT}\n${DF_ID};${cell}\n`, [
			KEY_COLUMN,
			{ tipo: TEXT, model: 'component_input_text', checked: true, map_to: TEXT },
		]);
		expect(report.failed).toEqual([]);
		expect(report.created).toEqual([DF_ID]);

		const rows = (await sql.unsafe(
			`SELECT relation -> '${DATAFRAME}' AS frames
			   FROM matrix_test WHERE section_tipo = $1 AND section_id = $2`,
			[SECTION, DF_ID],
		)) as { frames: Record<string, unknown>[] | null }[];
		const frames = rows[0]?.frames ?? [];
		expect(frames.length).toBe(1);
		// the REAL reader, not a string compare on the column
		expect(isDataframeEntry(frames[0])).toBe(true);
		expect(frames[0]).toMatchObject({
			type: DATAFRAME_RELATION_TYPE,
			from_component_tipo: DATAFRAME,
			section_tipo: SECTION,
			// int-canonical stored address (WC-2026-08-10-section-id-int-canonical)
			section_id: DF_ID + 1,
			id_key: 1,
			main_component_tipo: TEXT,
		});
	});
});

describe('legacy envelope frames honour the imported modified stamp (replace mode)', () => {
	test('a row carrying dd201 + an envelope with frames keeps the imported dd201', async () => {
		const envelope = JSON.stringify({
			dedalo_data: {
				data: [{ id: 1, value: 'framed, stamped' }],
				dataframe: [
					{
						section_tipo: SECTION,
						section_id: 2,
						from_component_tipo: DATAFRAME,
						id_key: 1,
						type: 'dd490',
					},
				],
			},
		});
		const cell = `"${envelope.replace(/"/g, '""')}"`;
		// dd201 FIRST: the frames (pass 2) are saved after it — the save that used
		// to re-stamp it with "now, by the importer".
		const report = await importCsv(
			`section_id;${MODIFIED_DATE}_dmy;${TEXT}\n${STAMP_ID};03-04-2001;${cell}\n`,
			[
				KEY_COLUMN,
				{
					tipo: `${MODIFIED_DATE}_dmy`,
					model: 'component_date',
					checked: true,
					map_to: MODIFIED_DATE,
				},
				{ tipo: TEXT, model: 'component_input_text', checked: true, map_to: TEXT },
			],
		);
		expect(report.failed).toEqual([]);
		const rows = (await sql.unsafe(
			`SELECT date -> '${MODIFIED_DATE}' AS modified, relation -> '${DATAFRAME}' AS frames
			   FROM matrix_test WHERE section_tipo = $1 AND section_id = $2`,
			[SECTION, STAMP_ID],
		)) as { modified: { start?: Record<string, number> }[]; frames: unknown[] | null }[];
		// the frame WAS written (so its save ran) …
		expect(rows[0]?.frames).toHaveLength(1);
		// … and did not overwrite the imported stamp
		expect(rows[0]?.modified?.[0]?.start).toEqual({
			day: 3,
			month: 4,
			year: 2001,
			time: ddDateToSeconds({ day: 3, month: 4, year: 2001 }),
		});
	});
});

describe('legacy envelope frames aimed at a NON-dataframe slot (replace mode)', () => {
	test("two frames in one bad slot: ONE IGNORED warning, data = the slot's normalised frames", async () => {
		const frame = (idKey: number) => ({
			section_tipo: SECTION,
			section_id: 2,
			from_component_tipo: PORTAL, // a component_portal, not a component_dataframe
			id_key: String(idKey),
		});
		const envelope = JSON.stringify({
			dedalo_data: { data: [{ id: 1, value: 'bad slot' }], dataframe: [frame(1), frame(2)] },
		});
		const report = await importCsv(
			`section_id;${TEXT}\n${BAD_SLOT_ID};"${envelope.replace(/"/g, '""')}"\n`,
			[KEY_COLUMN, { tipo: TEXT, model: 'component_input_text', checked: true, map_to: TEXT }],
		);
		expect(report.failed).toEqual([]);
		const ignored = report.warnings.filter((w) =>
			String(w.msg).includes('which is not a component_dataframe'),
		);
		expect(ignored).toHaveLength(1);
		expect(ignored[0]?.component_tipo).toBe(PORTAL);
		const data = ignored[0]?.data as Record<string, unknown>[];
		expect(data).toHaveLength(2);
		for (const [index, entry] of data.entries()) {
			expect(entry).toMatchObject({
				type: DATAFRAME_RELATION_TYPE,
				id_key: index + 1,
				main_component_tipo: TEXT,
			});
		}
	});
});

describe('the warnings channel (imported, but flagged)', () => {
	test('a lang outside the project languages is IMPORTED and warned about', async () => {
		// lg-vtvn resolves to a real lg1 record but is not in DEDALO_PROJECTS_DEFAULT_LANGS.
		const outsider = 'lg-vtvn';
		expect(config.menu.projectsDefaultLangs).not.toContain(outsider);

		const report = await importCsv(`section_id;${SELECT_LANG}\n${ID};${outsider}\n`, [
			KEY_COLUMN,
			{
				tipo: SELECT_LANG,
				model: 'component_select_lang',
				checked: true,
				map_to: SELECT_LANG,
			},
		]);

		// A warning is NOT a rejection: the row still imported.
		expect(report.failed).toEqual([]);
		expect(report.warnings).toHaveLength(1);
		expect(report.warnings[0]?.msg).toContain('not be accessible until the project languages');
		expect(report.warnings[0]?.component_tipo).toBe(SELECT_LANG);
		expect(report.warnings[0]?.row).toBe(2); // the header is row 1

		// …and the data really is on the record.
		const rows = (await sql.unsafe(
			`SELECT relation -> '${SELECT_LANG}' AS langs
			   FROM matrix_test WHERE section_tipo = $1 AND section_id = $2`,
			[SECTION, ID],
		)) as { langs: { section_tipo?: string }[] }[];
		expect(rows[0]?.langs?.[0]?.section_tipo).toBe('lg1');
	});
});

describe('a bare section_id into component_select_lang imports (D20)', () => {
	test('the target section resolves, so the id is not refused as an invalid target', async () => {
		// D20, FIXED 2026-08-09: test89 declares its sqo section_tipo as the
		// SCALAR form {"value":"lg1","source":"section"}, which
		// resolveSqoSectionTipos dropped — the component resolved ZERO target
		// sections and conform refused every bare id with
		// "IGNORED: Trying to import invalid target_section_tipo" (the pure gate
		// is test/unit/request_config_source_cases.test.ts). The code form
		// ('lg-spa') always worked, which is why this went unseen.
		const report = await importCsv(`section_id;${SELECT_LANG}\n${DF_ID};17344\n`, [
			KEY_COLUMN,
			{
				tipo: SELECT_LANG,
				model: 'component_select_lang',
				checked: true,
				map_to: SELECT_LANG,
			},
		]);
		expect(report.failed).toEqual([]);
		expect(report.errors).toEqual([]);

		const rows = (await sql.unsafe(
			`SELECT relation -> '${SELECT_LANG}' AS langs
			   FROM matrix_test WHERE section_tipo = $1 AND section_id = $2`,
			[SECTION, DF_ID],
		)) as { langs: { section_tipo?: string; section_id?: number }[] | null }[];
		// int-canonical stored address (WC-2026-08-10-section-id-int-canonical)
		expect(rows[0]?.langs?.[0]).toMatchObject({ section_tipo: 'lg1', section_id: 17344 });
	});
});

describe('validate_import (preflight) — catches the map BEFORE anything is written', () => {
	test('a column mapped outside the section is reported, and nothing is imported', async () => {
		writeFileSync(resolve(dir, CSV), `section_id;ontology5\n${ID};not my component\n`);
		const loaded = await getLoadedTool('tool_import_dedalo_csv');
		const res = await mustGet(loaded!.module.apiActions.validate_import, 'validate_import').handler(
			{
				principal: await resolvePrincipal(-1),
				userId: USER,
				background: false,
				options: {
					files: [
						{
							file: CSV,
							section_tipo: SECTION,
							// ontology5 is a real component tipo — of a DIFFERENT section.
							ar_columns_map: [
								KEY_COLUMN,
								{
									tipo: 'ontology5',
									model: 'component_input_text',
									checked: true,
									map_to: 'ontology5',
								},
							],
						},
					],
				},
			},
		);
		const file = (res.data as { files: Record<string, unknown>[] }).files[0] as Record<
			string,
			unknown
		>;
		expect(file.ok).toBe(false);
		expect((file.errors as string[]).join(' ')).toContain('not a component of section');

		// The preflight is READ-ONLY: it must not have created the record.
		const rows = (await sql.unsafe(
			'SELECT 1 FROM matrix_test WHERE section_tipo = $1 AND section_id = $2',
			[SECTION, 900701],
		)) as unknown[];
		expect(rows).toHaveLength(0);
	});

	test('a clean map + parseable values preflight OK', async () => {
		writeFileSync(resolve(dir, CSV), `section_id;${TEXT}\n${ID};fine\n`);
		const loaded = await getLoadedTool('tool_import_dedalo_csv');
		const res = await mustGet(loaded!.module.apiActions.validate_import, 'validate_import').handler(
			{
				principal: await resolvePrincipal(-1),
				userId: USER,
				background: false,
				options: {
					files: [
						{
							file: CSV,
							section_tipo: SECTION,
							ar_columns_map: [
								KEY_COLUMN,
								{ tipo: TEXT, model: 'component_input_text', checked: true, map_to: TEXT },
							],
						},
					],
				},
			},
		);
		const file = (res.data as { files: Record<string, unknown>[] }).files[0] as Record<
			string,
			unknown
		>;
		expect(file.ok).toBe(true);
		expect(file.errors).toEqual([]);
		expect(file.failed).toEqual([]);
		expect(file.rows_total).toBe(1);
	});
});

describe('append mode (import_mode: append)', () => {
	/** The stored input_text items of a scratch record. */
	async function storedText(sectionId: number): Promise<Record<string, unknown>[]> {
		const rows = (await sql.unsafe(
			`SELECT string -> '${TEXT}' AS items FROM matrix_test WHERE section_tipo = $1 AND section_id = $2`,
			[SECTION, sectionId],
		)) as { items: Record<string, unknown>[] | null }[];
		return rows[0]?.items ?? [];
	}

	const appendColumn = { tipo: TEXT, model: 'component_input_text', checked: true, map_to: TEXT };

	test('adds next to the stored value; a re-import skips + reports; an empty cell is a no-op', async () => {
		// Seed in REPLACE mode (the default).
		const seeded = await importCsv(`section_id;${TEXT}\n${APPEND_ID};alpha\n`, [
			KEY_COLUMN,
			appendColumn,
		]);
		expect(seeded.failed).toEqual([]);
		const before = await storedText(APPEND_ID);
		expect(before.map((item) => item.value)).toEqual(['alpha']);

		const appended = await importCsv(`section_id;${TEXT}\n${APPEND_ID};beta\n`, [
			KEY_COLUMN,
			{ ...appendColumn, import_mode: 'append' },
		]);
		expect(appended.failed).toEqual([]);
		expect(appended.warnings).toEqual([]);
		const after = await storedText(APPEND_ID);
		expect(after.map((item) => item.value)).toEqual(['alpha', 'beta']);
		// the stored item is kept byte-for-byte
		expect(after[0]).toEqual(mustGet(before[0], 'seeded item'));
		// the appended item got its own fresh id
		expect(after[1]?.id).not.toBe(after[0]?.id);

		// Re-importing the same file changes nothing, and says so.
		const again = await importCsv(`section_id;${TEXT}\n${APPEND_ID};beta\n`, [
			KEY_COLUMN,
			{ ...appendColumn, import_mode: 'append' },
		]);
		expect(again.failed).toEqual([]);
		expect(again.updated).toEqual([APPEND_ID]);
		expect(again.warnings).toHaveLength(1);
		expect(again.warnings[0]).toMatchObject({
			section_id: APPEND_ID,
			component_tipo: TEXT,
			msg: '1 already present, not added',
			row: 2,
		});
		expect(await storedText(APPEND_ID)).toEqual(after);

		// An empty cell NEVER clears in append mode.
		const empty = await importCsv(`section_id;${TEXT}\n${APPEND_ID};\n`, [
			KEY_COLUMN,
			{ ...appendColumn, import_mode: 'append' },
		]);
		expect(empty.failed).toEqual([]);
		expect(await storedText(APPEND_ID)).toEqual(after);
	});

	/** A {"dedalo_data":{data, dataframe}} legacy-envelope cell, CSV-quoted. */
	function legacyCell(itemId: number, value: string, idKey: number): string {
		const envelope = JSON.stringify({
			dedalo_data: {
				data: [{ id: itemId, value }],
				dataframe: [
					{
						section_tipo: SECTION,
						section_id: APPEND_FRAME_ID + 1,
						from_component_tipo: DATAFRAME,
						id_key: idKey,
						type: 'dd490',
					},
				],
			},
		});
		return `"${envelope.replace(/"/g, '""')}"`;
	}

	test('an appended main re-pairs its frames to the FINAL item id', async () => {
		// Seed a stored item so the file's id 1 is NOT the id the append gets.
		await importCsv(`section_id;${TEXT}\n${APPEND_FRAME_ID};seed\n`, [KEY_COLUMN, appendColumn]);
		const report = await importCsv(
			`section_id;${TEXT}\n${APPEND_FRAME_ID};${legacyCell(1, 'framed', 1)}\n`,
			[KEY_COLUMN, { ...appendColumn, import_mode: 'append' }],
		);
		expect(report.failed).toEqual([]);

		const items = await storedText(APPEND_FRAME_ID);
		const framed = items.find((item) => item.value === 'framed');
		expect(framed).toBeDefined();
		expect(framed?.id).not.toBe(1);

		const rows = (await sql.unsafe(
			`SELECT relation -> '${DATAFRAME}' AS frames FROM matrix_test WHERE section_tipo = $1 AND section_id = $2`,
			[SECTION, APPEND_FRAME_ID],
		)) as { frames: Record<string, unknown>[] | null }[];
		const frames = rows[0]?.frames ?? [];
		expect(frames).toHaveLength(1);
		expect(isDataframeEntry(frames[0])).toBe(true);
		expect(frames[0]).toMatchObject({ main_component_tipo: TEXT, id_key: framed?.id });
	});

	test('a frame whose item the cell does not carry FAILS the row', async () => {
		const before = await storedText(APPEND_FRAME_ID);
		const report = await importCsv(
			`section_id;${TEXT}\n${APPEND_FRAME_ID};${legacyCell(5, 'orphan-framed', 99)}\n`,
			[KEY_COLUMN, { ...appendColumn, import_mode: 'append' }],
		);
		expect(report.failed).toHaveLength(1);
		expect(report.failed[0]?.msg).toContain("this row's cell does not carry");
		// rolled back: the main append did not land either
		expect(await storedText(APPEND_FRAME_ID)).toEqual(before);
	});

	test('an empty REPLACE slot that STORES frames of an APPEND main fails the row', async () => {
		// APPEND_FRAME_ID's slot holds a frame of TEXT (the re-pair test above):
		// the empty replace cell would clear it under the appended main.
		const itemsBefore = await storedText(APPEND_FRAME_ID);
		const framesBefore = await storedFrames(APPEND_FRAME_ID);
		expect(framesBefore.some((frame) => frame.main_component_tipo === TEXT)).toBe(true);
		const report = await importCsv(`section_id;${TEXT};${DATAFRAME}\n${APPEND_FRAME_ID};delta;\n`, [
			KEY_COLUMN,
			{ ...appendColumn, import_mode: 'append' },
			{ tipo: DATAFRAME, model: 'component_dataframe', checked: true, map_to: DATAFRAME },
		]);
		expect(report.failed).toHaveLength(1);
		expect(report.failed[0]?.msg).toContain('REPLACE mode');
		expect(await storedText(APPEND_FRAME_ID)).toEqual(itemsBefore);
		expect(await storedFrames(APPEND_FRAME_ID)).toEqual(framesBefore);
	});

	test('an empty REPLACE slot holding no frame of the APPEND main imports cleanly', async () => {
		// APPEND_ID has no frames: a raw export's empty dataframe column beside an
		// unrelated append column is not a clash.
		expect(await storedFrames(APPEND_ID)).toEqual([]);
		const before = await storedText(APPEND_ID);
		const report = await importCsv(`section_id;${TEXT};${DATAFRAME}\n${APPEND_ID};delta;\n`, [
			KEY_COLUMN,
			{ ...appendColumn, import_mode: 'append' },
			{ tipo: DATAFRAME, model: 'component_dataframe', checked: true, map_to: DATAFRAME },
		]);
		expect(report.failed).toEqual([]);
		expect(report.updated).toEqual([APPEND_ID]);
		const after = await storedText(APPEND_ID);
		expect(after.slice(0, before.length)).toEqual(before);
		expect(after.map((item) => item.value)).toContain('delta');
	});

	test('a REPLACE envelope whose frames name an APPEND main fails the row (no unremapped id_key)', async () => {
		// Seed a stored portal item 1, so an unremapped id_key 1 WOULD pair with it.
		const seeded = await importCsv(
			`section_id;${PORTAL}\n${MIXED_ID};${`"${JSON.stringify([{ id: 1, section_tipo: SECTION, section_id: 2 }]).replace(/"/g, '""')}"`}\n`,
			[KEY_COLUMN, { tipo: PORTAL, model: 'component_portal', checked: true, map_to: PORTAL }],
		);
		expect(seeded.failed).toEqual([]);
		const portalBefore = await storedPortal(MIXED_ID);
		const envelope = JSON.stringify({
			dedalo_data: {
				data: [{ id: 1, value: 'replace text' }],
				dataframe: [
					{
						section_tipo: SECTION,
						section_id: 4,
						from_component_tipo: DATAFRAME,
						main_component_tipo: PORTAL,
						id_key: 1,
						type: 'dd490',
					},
				],
			},
		});
		const portalCell = JSON.stringify([{ id: 1, section_tipo: SECTION, section_id: 3 }]);
		const q = (value: string): string => `"${value.replace(/"/g, '""')}"`;
		const report = await importCsv(
			`section_id;${TEXT};${PORTAL}\n${MIXED_ID};${q(envelope)};${q(portalCell)}\n`,
			[
				KEY_COLUMN,
				appendColumn,
				{
					tipo: PORTAL,
					model: 'component_portal',
					checked: true,
					map_to: PORTAL,
					import_mode: 'append',
				},
			],
		);
		expect(report.failed).toHaveLength(1);
		expect(report.failed[0]?.msg).toContain('APPEND mode');
		expect(await storedPortal(MIXED_ID)).toEqual(portalBefore);
		expect(await storedFrames(MIXED_ID)).toEqual([]);
		expect(await storedText(MIXED_ID)).toEqual([]);
	});

	/** The stored frames of the DATAFRAME slot of a scratch record. */
	async function storedFrames(sectionId: number): Promise<Record<string, unknown>[]> {
		const rows = (await sql.unsafe(
			`SELECT relation -> '${DATAFRAME}' AS frames FROM matrix_test WHERE section_tipo = $1 AND section_id = $2`,
			[SECTION, sectionId],
		)) as { frames: Record<string, unknown>[] | null }[];
		return rows[0]?.frames ?? [];
	}

	/** The stored portal locators of a scratch record. */
	async function storedPortal(sectionId: number): Promise<Record<string, unknown>[]> {
		const rows = (await sql.unsafe(
			`SELECT relation -> '${PORTAL}' AS items FROM matrix_test WHERE section_tipo = $1 AND section_id = $2`,
			[SECTION, sectionId],
		)) as { items: Record<string, unknown>[] | null }[];
		return rows[0]?.items ?? [];
	}
});

describe("the Zotero import's record-number rules are ZOTERO's: the CSV section_id column is unchanged (owner ruling 2026-11-18)", () => {
	// The Zotero door refuses a call-number above int4 under its own code, adopts
	// or refuses by the record's Zotero key, and warns in envelope notices
	// (tools/tool_import_zotero/server/call_number_address.ts). NONE of that is
	// the CSV door's: its section_id column is read by `parseRecordIdCell` and
	// written as at 123d88b48d. Every assertion below is the outcome MEASURED
	// there — a limit moved into anything the two doors share turns one red.
	const TEXT_COLUMN = { tipo: TEXT, model: 'component_input_text', checked: true, map_to: TEXT };
	const CODE = 'test162';
	const titleOf = async (id: number): Promise<unknown[]> => {
		const rows = (await sql.unsafe(
			`SELECT string -> '${TEXT}' AS items FROM matrix_test WHERE section_tipo = $1 AND section_id = $2`,
			[SECTION, id],
		)) as { items: { value?: unknown }[] | null }[];
		return (rows[0]?.items ?? []).map((item) => item.value);
	};

	test('a section_id above 2147483647 keeps the CSV outcome: the FILE fails on the id as written — no Zotero code, no per-row refusal, no row written', async () => {
		const report = await importCsv(
			`section_id;${TEXT}\n${ZOTERO_FREE_ID};"written before the limit row?"\n2147483648;"above the limit"\n`,
			[KEY_COLUMN, TEXT_COLUMN],
		);
		expect(report.ok).toBe(false);
		expect(report.created).toEqual([]);
		expect(report.updated).toEqual([]);
		expect(report.failed).toEqual([]);
		// The id reaches the database as the file wrote it: no door of the CSV
		// path reads it as "not a record id", and none words it as the Zotero limit.
		expect(report.errors).toEqual(['value "2147483648" is out of range for type integer']);
		expect(JSON.stringify(report)).not.toContain('zotero');
		expect(JSON.stringify(report)).not.toContain('call-number');
		expect(report).not.toHaveProperty('refused');
		expect(report).not.toHaveProperty('taken_over_at_id');
		// The file is one unit here: the row before the limit row was not written either.
		expect(await titleOf(ZOTERO_FREE_ID)).toEqual([]);
	});

	test('a digit run too long for an exact integer is still the CSV row skip (DATA-22), never the Zotero limit', async () => {
		const report = await importCsv(`section_id;${TEXT}\n99999999999999999999;"huge"\n`, [
			KEY_COLUMN,
			TEXT_COLUMN,
		]);
		expect(report.ok).toBe(true);
		expect(report.errors).toEqual([
			"Row 2: SKIPPED — the section_id cell is '99999999999999999999', which is not a record id",
		]);
	});

	test('a free section_id is CREATED at it; a record holding a code, and one holding none, are UPDATED in place — no key guard, no take-over bucket, no refusal, no notice', async () => {
		const born = await importCsv(
			`section_id;${TEXT};${CODE}\n${ZOTERO_FREE_ID};"csv born";"ZKEY${ZOTERO_FREE_ID}"\n${ZOTERO_KEYLESS_ID};"csv keyless";""\n`,
			[
				KEY_COLUMN,
				TEXT_COLUMN,
				{ tipo: CODE, model: 'component_input_text', checked: true, map_to: CODE },
			],
		);
		expect(born.errors).toEqual([]);
		expect(born.failed).toEqual([]);
		expect(born.created).toEqual([ZOTERO_FREE_ID, ZOTERO_KEYLESS_ID]);
		expect(born.updated).toEqual([]);

		// The same ids again: one record now HOLDS a code (a Zotero key, to the
		// Zotero door), the other holds none. The CSV door asks neither question.
		const again = await importCsv(
			`section_id;${TEXT}\n${ZOTERO_FREE_ID};"csv keyed, updated"\n${ZOTERO_KEYLESS_ID};"csv keyless, updated"\n`,
			[KEY_COLUMN, TEXT_COLUMN],
		);
		expect(again.ok).toBe(true);
		expect(again.errors).toEqual([]);
		expect(again.failed).toEqual([]);
		expect(again.created).toEqual([]);
		expect(again.updated).toEqual([ZOTERO_FREE_ID, ZOTERO_KEYLESS_ID]);
		expect(again).not.toHaveProperty('refused');
		expect(again).not.toHaveProperty('taken_over_at_id');
		expect(await titleOf(ZOTERO_FREE_ID)).toEqual(['csv keyed, updated']);
		expect(await titleOf(ZOTERO_KEYLESS_ID)).toEqual(['csv keyless, updated']);
	});

	test('the CSV envelope carries no notice: the Zotero warnings are not ambient', async () => {
		writeFileSync(resolve(dir, CSV), `section_id;${TEXT}\n2147483648;"above"\n`);
		const loaded = await getLoadedTool('tool_import_dedalo_csv');
		const res = (await mustGet(loaded!.module.apiActions.import_files, 'import_files').handler({
			principal: await resolvePrincipal(-1),
			userId: USER,
			background: false,
			options: {
				files: [{ file: CSV, section_tipo: SECTION, ar_columns_map: [KEY_COLUMN, TEXT_COLUMN] }],
			},
		})) as { notices?: unknown[]; data: { files: ImportFileReport[] } };
		const id = res.data.files[0]?.bulk_process_id ?? null;
		if (id !== null) bulkProcessIds.push(id);
		expect(res.notices ?? []).toEqual([]);
	});
});
