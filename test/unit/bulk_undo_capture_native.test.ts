/**
 * THE CAPTURE LAW OF A BULK RUN'S UNDO LOG (WC-2026-09-27-bulk-revert-undo-log
 * §2.3, decision D1) — one case per DOOR that writes under a dd800 bulk id,
 * measured on the rows it leaves in `matrix_time_machine`.
 *
 * Written by an author independent of the code under test: it pins what the
 * revert will READ, not how the writers are spelled.
 *
 * THE LAW, per changed key:
 *   - exactly ONE pair: a hidden BEFORE (tm_role 1) then the VISIBLE after-row
 *     (tm_role NULL), both carrying the run's bulk id, BEFORE's id lower, one
 *     shared timestamp — whatever `saveTm` says (D1: no role 2, ever);
 *   - BEFORE = the PRE-BYTES of the region the write owns: absence as SQL NULL
 *     (never `[]`), lang-less orphans kept, and items the save mutates IN PLACE
 *     (a date's recomputed `time`, a stamped item id) as they WERE;
 *   - AFTER = the persisted bytes of that region, re-read;
 *   - a write that changes nothing writes NO row;
 *   - a record the run CREATES gets one BIRTH marker (role 3) — only on a real
 *     insert, never on a conflict-tolerant no-op, never outside a run;
 *   - a record the run's cascade DELETES gets a role-4 twin of its snapshot;
 *   - a fault after the write inside the caller's transaction leaves NEITHER row.
 *
 * DOORS: saveComponentData (replace, append, slot, date, id stamp, absent, no-op,
 * saveTm:false, the absent-record refusal), createSectionRecord, the CSV door (replace, append,
 * legacy envelope frames), import_execute (update, create), propagate (add,
 * replace, delete), update_cache (a re-save that changes / one that does not),
 * bulk_revert (its own writes), the delete doors and the dataframe cascade.
 *
 * SITUATION: a `zzbuc` scratch section on `test1` (→ matrix_test) with a
 * portal MAIN whose request_config names a `delete_target` dataframe SLOT, a
 * translatable input_text and a date; the CSV / import / propagate /
 * update_cache doors run on runtime-created `test3` playground records (the
 * generic `test` TLD). Every record, TM row, activity row and dd800 run is
 * swept; the situation drop asserts zero residue. assertTestDatabase first.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from '../../src/config/config.ts';
import { sql, withTransaction } from '../../src/core/db/postgres.ts';
import { createSectionRecord } from '../../src/core/section/record/create_record.ts';
import {
	deleteSectionData,
	deleteSectionRecord,
} from '../../src/core/section/record/delete_record.ts';
import { saveComponentData } from '../../src/core/section/record/save_component.ts';
import { resolvePrincipal } from '../../src/core/security/permissions.ts';
import {
	dropSituation,
	ensureSituation,
	situation,
} from '../../src/core/test_data/situations/situation.ts';
import { assertTestDatabase } from '../../src/core/test_data/test_database_marker.ts';
import { importMappedRecords } from '../../src/core/tools/import_execute.ts';
import type { ImportFileReport } from '../../src/core/tools/import_wire.ts';
import { getLoadedTool } from '../../src/core/tools/loader.ts';
import type { ToolActionContext } from '../../src/core/tools/module.ts';
import { toolTimeMachineBulkRevert } from '../../tools/tool_time_machine/server/bulk_revert.ts';
import { resolveDataframeSlotTipos } from '../../tools/tool_time_machine/server/dataframe_restore.ts';
import { mustGet } from '../helpers/assert.ts';

const SECTION = 'zzbuc1';
const MAIN = 'zzbuc2'; // component_portal, request_config names SLOT
const SLOT = 'zzbuc3'; // component_dataframe, delete_policy: delete_target (soft)
const TEXT = 'zzbuc4'; // component_input_text, translatable
const DATE = 'zzbuc5'; // component_date
const DATE_MAIN = 'zzbuc6'; // component_date, has_dataframe → DATE_SLOT
const DATE_SLOT = 'zzbuc7'; // component_dataframe of DATE_MAIN
const XLIT = 'zzbuc8'; // component_input_text, NOT translatable, with_lang_versions (rsc85-like)
const TABLE = 'matrix_test';
const USER_ID = -1;
/** The importing PRINCIPAL (req 10: the executor asks the write door as it) — the superuser, so the door is not this gate's subject. */
const IMPORTER = { userId: -1, isGlobalAdmin: true, isDeveloper: true } as const;
/** The CSV door's per-user import dir (media root, marked by the suite). */
const CSV_USER = 987_681;

// the test3 playground (generic `test` TLD)
const T3 = 'test3';
const T3_TEXT = 'test52'; // component_input_text, translatable
const T3_PORTAL = 'test80'; // component_portal → test3
const T3_SLOT = 'test60'; // component_dataframe (legacy envelope frames)

const SITUATION = situation({
	tld: 'zzbuc',
	name: 'bulk_undo_capture',
	nodes: [
		{ tipo: SECTION, parent: 'test1', model: 'section', term: { 'lg-eng': 'Undo capture' } },
		{
			tipo: MAIN,
			parent: SECTION,
			model: 'component_portal',
			term: { 'lg-eng': 'Main' },
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
		{
			tipo: SLOT,
			parent: MAIN,
			model: 'component_dataframe',
			term: { 'lg-eng': 'Slot' },
			properties: { dataframe: { delete_policy: 'delete_target' } },
		},
		{
			tipo: TEXT,
			parent: SECTION,
			model: 'component_input_text',
			term: { 'lg-eng': 'Text' },
			is_translatable: true,
		},
		{ tipo: DATE, parent: SECTION, model: 'component_date', term: { 'lg-eng': 'Date' } },
		{
			tipo: DATE_MAIN,
			parent: SECTION,
			model: 'component_date',
			term: { 'lg-eng': 'Framed date' },
			properties: {
				has_dataframe: true,
				source: {
					request_config: [
						{
							sqo: { section_tipo: [{ value: [SECTION], source: 'section' }] },
							show: { ddo_map: [{ tipo: DATE_SLOT, parent: 'self', section_tipo: SECTION }] },
						},
					],
				},
			},
		},
		{
			tipo: DATE_SLOT,
			parent: DATE_MAIN,
			model: 'component_dataframe',
			term: { 'lg-eng': 'Date slot' },
		},
		{
			tipo: XLIT,
			parent: SECTION,
			model: 'component_input_text',
			term: { 'lg-eng': 'Name (transliterable)' },
			is_translatable: false,
			properties: { with_lang_versions: true },
		},
	],
});

const t3Records: number[] = [];
const bulkIds: number[] = [];
let bulkTable = '';
let nextSynthetic = 1_987_651_000;
/** A run id for a direct-door case: synthetic (no door reads dd800 back there). */
function syntheticBulk(): number {
	nextSynthetic += 1;
	bulkIds.push(nextSynthetic);
	return nextSynthetic;
}

interface UndoRow {
	id: number;
	tipo: string;
	lang: string;
	tm_role: number | null;
	bulk: number | null;
	data: unknown;
	absent: boolean;
	ts: string;
}

/** Every TM row of a record carrying `bulk`, id ASC. */
async function runRows(sectionTipo: string, sectionId: number, bulk: number): Promise<UndoRow[]> {
	const rows = (await sql.unsafe(
		`SELECT id, tipo, lang, tm_role, bulk_process_id AS bulk, data, data IS NULL AS absent,
		        timestamp::text AS ts
		   FROM matrix_time_machine
		  WHERE section_tipo = $1 AND section_id = $2 AND bulk_process_id = $3 ORDER BY id ASC`,
		[sectionTipo, sectionId, bulk],
	)) as UndoRow[];
	return rows.map((row) => ({
		...row,
		id: Number(row.id),
		tm_role: row.tm_role === null ? null : Number(row.tm_role),
		bulk: row.bulk === null ? null : Number(row.bulk),
	}));
}

/** The stored key: `undefined` = absent (a `?` probe, not `->` — null is a value). */
async function stored(
	sectionTipo: string,
	sectionId: number,
	column: string,
	key: string,
): Promise<unknown> {
	const table = sectionTipo === T3 ? 'matrix_test' : TABLE;
	const rows = (await sql.unsafe(
		`SELECT (${column} ? $3) AS present, ${column}->$3 AS v FROM "${table}"
		 WHERE section_tipo = $1 AND section_id = $2`,
		[sectionTipo, sectionId, key],
	)) as { present: boolean | null; v: unknown }[];
	if (rows.length === 0) return 'NO-RECORD';
	return rows[0]?.present === true ? rows[0]?.v : undefined;
}

async function seed(
	sectionTipo: string,
	sectionId: number,
	column: string,
	key: string,
	value: unknown,
): Promise<void> {
	await sql.unsafe(
		`UPDATE "${sectionTipo === T3 ? 'matrix_test' : TABLE}"
		    SET ${column} = COALESCE(${column}, '{}'::jsonb) || jsonb_build_object($3::text, $4::text::jsonb)
		  WHERE section_tipo = $1 AND section_id = $2`,
		[sectionTipo, sectionId, key, JSON.stringify(value)],
	);
}

const onlyLang = (value: unknown, lang: string): unknown =>
	(Array.isArray(value) ? value : []).filter(
		(item) =>
			(item as { lang?: unknown }).lang === lang || (item as { lang?: unknown }).lang === undefined,
	);

/**
 * THE PAIR LAW for one key: exactly [BEFORE, AFTER] among `rows` for `tipo`
 * (and `lang` when given) — roles 1 then NULL, ids ascending, one timestamp —
 * with BEFORE = `before` (`undefined` = absent) and AFTER = `after`.
 */
function expectPair(
	rows: readonly UndoRow[],
	tipo: string,
	before: unknown,
	after: unknown,
	lang?: string,
): void {
	const pair = rows.filter((row) => row.tipo === tipo && (lang === undefined || row.lang === lang));
	expect(pair.map((row) => row.tm_role)).toEqual([1, null]);
	const [b, a] = pair as [UndoRow, UndoRow];
	expect(b.id).toBeLessThan(a.id);
	expect(b.ts).toBe(a.ts);
	if (before === undefined) {
		expect(b.absent).toBe(true);
	} else {
		expect(b.absent).toBe(false);
		expect(b.data).toEqual(before);
	}
	if (after === undefined) expect(a.absent).toBe(true);
	else expect(a.data).toEqual(after);
}

/**
 * THE COMPOSED IMAGE of a dataframe main (PHP get_time_machine_data_to_save):
 * the main's value followed by its slot's full frames; no frame → the main's
 * value as it is (absence stays absence).
 */
function composedOf(main: unknown, slot: unknown): unknown {
	const frames = Array.isArray(slot) ? slot : [];
	if (frames.length === 0) return main;
	return [...(Array.isArray(main) ? main : []), ...frames];
}

async function newRecord(bulk: number | null = null): Promise<number> {
	return createSectionRecord(SECTION, USER_ID, new Date(), undefined, { bulkProcessId: bulk });
}

async function newT3Record(): Promise<number> {
	const id = await createSectionRecord(T3, USER_ID);
	t3Records.push(id);
	return id;
}

async function save(
	sectionId: number,
	componentTipo: string,
	lang: string,
	changedData: unknown[],
	extra: Record<string, unknown> = {},
): Promise<void> {
	const saved = await saveComponentData({
		componentTipo,
		sectionTipo: SECTION,
		sectionId,
		lang,
		changedData: changedData as never,
		userId: USER_ID,
		...extra,
	});
	expect(saved.ok).toBe(true);
}

async function context(
	options: Record<string, unknown>,
	userId = USER_ID,
): Promise<ToolActionContext> {
	return { principal: await resolvePrincipal(USER_ID), userId, options, background: false };
}

// ---------------------------------------------------------------- lifecycle

const csvDir = resolve(config.media.rootPath ?? '', 'import/files', String(CSV_USER));

beforeAll(async () => {
	await assertTestDatabase('bulk_undo_capture_native');
	await ensureSituation(SITUATION);
	// STRUCTURE FLOOR: the main's cascade reaches the slot by BOTH routes the
	// engine uses (ontology child for the revert, request_config for the strip).
	expect(await resolveDataframeSlotTipos(MAIN)).toEqual([SLOT]);
	const { getMatrixTableFromTipo } = await import('../../src/core/ontology/resolver.ts');
	expect(await getMatrixTableFromTipo(SECTION)).toBe(TABLE);
	bulkTable = (await getMatrixTableFromTipo('dd800')) as string;
	mkdirSync(csvDir, { recursive: true });
}, 60_000);

afterAll(async () => {
	for (const id of t3Records) {
		await sql.unsafe('DELETE FROM matrix_test WHERE section_tipo = $1 AND section_id = $2', [
			T3,
			id,
		]);
		await sql.unsafe(
			'DELETE FROM matrix_time_machine WHERE section_tipo = $1 AND section_id = $2',
			[T3, id],
		);
	}
	for (const id of bulkIds) {
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
	expect(await dropSituation(SITUATION)).toBe(0);
});

// ================================================================ save door

describe('saveComponentData under a bulk id', () => {
	test('replace on a SLICED key: BEFORE = its region incl. a lang-less orphan; AFTER visible; saveTm:false ignored', async () => {
		const id = await newRecord();
		const bulk = syntheticBulk();
		const seeded = [
			{ id: 1, lang: 'lg-eng', value: 'E' },
			{ id: 1, lang: 'lg-spa', value: 'S' },
			{ id: 2, value: 'orphan' },
		];
		await seed(SECTION, id, 'string', TEXT, seeded);
		await save(id, TEXT, 'lg-spa', [{ action: 'set_data', value: [{ id: 1, value: 'S2' }] }], {
			bulkProcessId: bulk,
			saveTm: false,
		});
		const rows = await runRows(SECTION, id, bulk);
		const live = await stored(SECTION, id, 'string', TEXT);
		expectPair(
			rows,
			TEXT,
			[
				{ id: 1, lang: 'lg-spa', value: 'S' },
				{ id: 2, value: 'orphan' },
			],
			onlyLang(live, 'lg-spa'),
			'lg-spa',
		);
		// D1: never a hidden AFTER (role 2); the other language is untouched
		expect(rows.some((row) => row.tm_role === 2)).toBe(false);
		expect((live as Record<string, unknown>[]).filter((item) => item.lang === 'lg-eng')).toEqual([
			{ id: 1, lang: 'lg-eng', value: 'E' },
		]);
	});

	test('a save that changes NOTHING writes no row', async () => {
		const id = await newRecord();
		const bulk = syntheticBulk();
		await seed(SECTION, id, 'string', TEXT, [{ id: 1, lang: 'lg-spa', value: 'same' }]);
		await save(id, TEXT, 'lg-spa', [{ action: 'set_data', value: [{ id: 1, value: 'same' }] }], {
			bulkProcessId: bulk,
		});
		expect(await runRows(SECTION, id, bulk)).toEqual([]);
	});

	test('append (insert) on an UNSLICED portal: BEFORE = the whole pre key, AFTER = the whole live key', async () => {
		const id = await newRecord();
		const target = await newRecord();
		const other = await newRecord();
		const bulk = syntheticBulk();
		const pre = [
			{
				id: 1,
				type: 'dd151',
				section_tipo: SECTION,
				section_id: target,
				from_component_tipo: MAIN,
			},
		];
		await seed(SECTION, id, 'relation', MAIN, pre);
		await save(
			id,
			MAIN,
			'lg-nolan',
			[{ action: 'insert', value: { section_tipo: SECTION, section_id: String(other) } }],
			{ bulkProcessId: bulk },
		);
		const live = await stored(SECTION, id, 'relation', MAIN);
		expect((live as unknown[]).length).toBe(2);
		expectPair(await runRows(SECTION, id, bulk), MAIN, pre, live);
	});

	test('an item the save STAMPS in place keeps its pre-bytes in BEFORE (id-less item)', async () => {
		const id = await newRecord();
		const bulk = syntheticBulk();
		const pre = [{ lang: 'lg-spa', value: 'no id yet' }];
		await seed(SECTION, id, 'string', TEXT, pre);
		await save(id, TEXT, 'lg-spa', [{ action: 'insert', value: { value: 'second' } }], {
			bulkProcessId: bulk,
		});
		const live = (await stored(SECTION, id, 'string', TEXT)) as { id?: unknown }[];
		expect(live.length).toBe(2);
		expectPair(await runRows(SECTION, id, bulk), TEXT, pre, onlyLang(live, 'lg-spa'), 'lg-spa');
	});

	test('a DATE the save recomputes in place keeps its pre-bytes in BEFORE', async () => {
		// An UPDATE of item 2 is a full-key write, and the date save override
		// recomputes `time` IN PLACE on EVERY stored item — item 1 included,
		// which the operator never touched. A BEFORE that shared the locked
		// read's objects would carry that `time` too.
		const id = await newRecord();
		const bulk = syntheticBulk();
		const pre = [
			{ id: 1, start: { year: 2000, month: 1, day: 1 } },
			{ id: 2, start: { year: 2001, month: 1, day: 1 } },
		];
		await seed(SECTION, id, 'date', DATE, pre);
		await save(
			id,
			DATE,
			'lg-nolan',
			[{ action: 'update', id: 2, value: { id: 2, start: { year: 2002, month: 2, day: 3 } } }],
			{ bulkProcessId: bulk },
		);
		const live = (await stored(SECTION, id, 'date', DATE)) as { start: { time?: unknown } }[];
		// anti-vacuity: the save really did mutate the untouched item 1
		expect(live[0]?.start.time).toBeDefined();
		expectPair(await runRows(SECTION, id, bulk), DATE, pre, live);
	});

	test('an ABSENT key: BEFORE is SQL NULL (absence), never [] or JSON null', async () => {
		const id = await newRecord();
		const bulk = syntheticBulk();
		expect(await stored(SECTION, id, 'string', TEXT)).toBeUndefined();
		await save(id, TEXT, 'lg-spa', [{ action: 'set_data', value: [{ value: 'first' }] }], {
			bulkProcessId: bulk,
		});
		const live = await stored(SECTION, id, 'string', TEXT);
		expectPair(await runRows(SECTION, id, bulk), TEXT, undefined, live, 'lg-spa');
	});

	test('a SLOT save (a frame into the dataframe) is a COMPOSED pair under the MAIN, no slot row', async () => {
		const id = await newRecord();
		const target = await newRecord();
		const role = await newRecord();
		const bulk = syntheticBulk();
		const mainItems = [
			{
				id: 1,
				type: 'dd151',
				section_tipo: SECTION,
				section_id: target,
				from_component_tipo: MAIN,
			},
		];
		await seed(SECTION, id, 'relation', MAIN, mainItems);
		await save(
			id,
			SLOT,
			'lg-nolan',
			[{ action: 'insert', value: { section_tipo: SECTION, section_id: String(role) } }],
			{ bulkProcessId: bulk, callerDataframe: { main_component_tipo: MAIN, id_key: 1 } },
		);
		const rows = await runRows(SECTION, id, bulk);
		const live = await stored(SECTION, id, 'relation', SLOT);
		expect(Array.isArray(live) && live.length === 1).toBe(true);
		// BEFORE = the main alone (the slot was absent); AFTER = main + the slot's frames.
		expectPair(rows, MAIN, mainItems, [...mainItems, ...(live as unknown[])]);
		expect(rows.filter((row) => row.tipo === SLOT)).toEqual([]);
	});

	test('a save onto a record that does not exist is refused and records NO birth (WC-2026-11-10-save-never-creates)', async () => {
		const [{ m } = { m: 0 }] = (await sql.unsafe(
			`SELECT COALESCE(MAX(section_id), 0) + 1000 AS m FROM "${TABLE}" WHERE section_tipo = $1`,
			[SECTION],
		)) as { m: number }[];
		const id = Number(m);
		const bulk = syntheticBulk();
		await expect(
			saveComponentData({
				componentTipo: TEXT,
				sectionTipo: SECTION,
				sectionId: id,
				lang: 'lg-spa',
				changedData: [{ action: 'set_data', value: [{ value: 'new' }] }] as never,
				userId: USER_ID,
				bulkProcessId: bulk,
			}),
		).rejects.toMatchObject({ code: 'resource.not_found' });
		expect(await runRows(SECTION, id, bulk)).toEqual([]);
		expect(await stored(SECTION, id, 'string', TEXT)).toBe('NO-RECORD');
	});
	test('a fault AFTER the save inside the caller’s transaction leaves neither row', async () => {
		const id = await newRecord();
		const bulk = syntheticBulk();
		await expect(
			withTransaction(async () => {
				await save(id, TEXT, 'lg-spa', [{ action: 'set_data', value: [{ value: 'y' }] }], {
					bulkProcessId: bulk,
				});
				expect((await runRows(SECTION, id, bulk)).length).toBe(2); // written, uncommitted
				throw new Error('injected fault');
			}),
		).rejects.toThrow('injected fault');
		expect(await runRows(SECTION, id, bulk)).toEqual([]);
		expect(await stored(SECTION, id, 'string', TEXT)).toBeUndefined();
	});

	test('outside a run: one ordinary visible row, no role, no bulk id; saveTm:false writes none', async () => {
		const id = await newRecord();
		await save(id, TEXT, 'lg-spa', [{ action: 'set_data', value: [{ value: 'plain' }] }]);
		const rows = (await sql.unsafe(
			`SELECT tm_role, bulk_process_id FROM matrix_time_machine
			 WHERE section_tipo = $1 AND section_id = $2 AND tipo = $3`,
			[SECTION, id, TEXT],
		)) as { tm_role: number | null; bulk_process_id: number | null }[];
		expect(rows).toEqual([{ tm_role: null, bulk_process_id: null }]);
		await save(id, TEXT, 'lg-spa', [{ action: 'set_data', value: [{ value: 'quiet' }] }], {
			saveTm: false,
		});
		const after = (await sql.unsafe(
			`SELECT count(*)::int AS n FROM matrix_time_machine
			 WHERE section_tipo = $1 AND section_id = $2 AND tipo = $3`,
			[SECTION, id, TEXT],
		)) as { n: number }[];
		expect(after[0]?.n).toBe(1);
	});
});

// ================================================================ record doors

describe('record creation and deletion under a bulk id', () => {
	test('createSectionRecord: a BIRTH marker only on a real insert, only in a run', async () => {
		const bulk = syntheticBulk();
		const born = await newRecord(bulk);
		const rows = await runRows(SECTION, born, bulk);
		expect(rows.map((row) => [row.tipo, row.tm_role, row.lang, row.data])).toEqual([
			[SECTION, 3, 'lg-nolan', {}],
		]);
		// a conflict-tolerant re-create of the SAME address inserted nothing
		await createSectionRecord(SECTION, USER_ID, new Date(), born, {
			conflictTolerant: true,
			bulkProcessId: bulk,
		});
		expect((await runRows(SECTION, born, bulk)).length).toBe(1);
		// outside a run: no marker at all
		const plain = await newRecord();
		const markers = (await sql.unsafe(
			`SELECT count(*)::int AS n FROM matrix_time_machine
			 WHERE section_tipo = $1 AND section_id = $2 AND tm_role IS NOT NULL`,
			[SECTION, plain],
		)) as { n: number }[];
		expect(markers[0]?.n).toBe(0);
	});

	test('the delete doors: a role-4 twin of the snapshot, same timestamp, only under a run', async () => {
		const bulk = syntheticBulk();
		const gone = await newRecord();
		await seed(SECTION, gone, 'string', TEXT, [{ id: 1, lang: 'lg-spa', value: 'A' }]);
		await deleteSectionRecord(SECTION, gone, USER_ID, undefined, { bulkProcessId: bulk });
		const twin = (await runRows(SECTION, gone, bulk)).filter((row) => row.tm_role === 4);
		expect(twin.length).toBe(1);
		expect((twin[0]?.data as { string: Record<string, unknown> }).string[TEXT]).toEqual([
			{ id: 1, lang: 'lg-spa', value: 'A' },
		]);
		const snapshot = (await sql.unsafe(
			`SELECT timestamp::text AS ts FROM matrix_time_machine
			 WHERE section_tipo = $1 AND section_id = $2 AND tipo = $1 AND tm_role IS NULL`,
			[SECTION, gone],
		)) as { ts: string }[];
		expect(snapshot.map((row) => row.ts)).toEqual([twin[0]?.ts as string]);

		const wiped = await newRecord();
		await seed(SECTION, wiped, 'string', TEXT, [{ id: 1, lang: 'lg-spa', value: 'W' }]);
		await deleteSectionData(SECTION, wiped, USER_ID, undefined, { bulkProcessId: bulk });
		const wipeTwin = (await runRows(SECTION, wiped, bulk)).filter((row) => row.tm_role === 4);
		expect(wipeTwin.length).toBe(1);
		expect(JSON.stringify(wipeTwin[0]?.data)).toContain('"W"');

		const plain = await newRecord();
		await deleteSectionRecord(SECTION, plain, USER_ID);
		const plainRoles = (await sql.unsafe(
			`SELECT count(*)::int AS n FROM matrix_time_machine
			 WHERE section_tipo = $1 AND section_id = $2 AND tm_role IS NOT NULL`,
			[SECTION, plain],
		)) as { n: number }[];
		expect(plainRoles[0]?.n).toBe(0);
	});
});

// ================================================================ the dataframe cascade

describe('the dataframe cascade of a run', () => {
	/** A main with one item (id 1) whose frame (in SLOT) points at `role`. */
	async function framedHost(): Promise<{ host: number; role: number; target: number }> {
		const host = await newRecord();
		const target = await newRecord();
		const role = await newRecord();
		// the target carries CONTENT, so the soft wipe has something to empty
		await seed(SECTION, role, 'string', TEXT, [{ id: 1, lang: 'lg-spa', value: 'role record' }]);
		await seed(SECTION, host, 'relation', MAIN, [
			{
				id: 1,
				type: 'dd151',
				section_tipo: SECTION,
				section_id: target,
				from_component_tipo: MAIN,
			},
		]);
		await seed(SECTION, host, 'relation', SLOT, [
			{
				id: 1,
				type: 'dd490',
				id_key: 1,
				section_tipo: SECTION,
				section_id: role,
				from_component_tipo: SLOT,
				main_component_tipo: MAIN,
			},
		]);
		return { host, role, target };
	}

	test('a FRAME removed from the slot (delete_target): the target is emptied, row kept, and twinned under the run', async () => {
		const { host, role } = await framedHost();
		// FLOOR: the target holds content before the cascade
		expect(await stored(SECTION, role, 'string', TEXT)).toEqual([
			{ id: 1, lang: 'lg-spa', value: 'role record' },
		]);
		const bulk = syntheticBulk();
		await save(host, SLOT, 'lg-nolan', [{ action: 'remove', id: 1, value: null }], {
			bulkProcessId: bulk,
		});
		// the row stays: no policy removes a frame target (WC-2026-09-29) — its content is emptied
		expect(await stored(SECTION, role, 'data', 'section_id')).not.toBe('NO-RECORD');
		const wiped = await stored(SECTION, role, 'string', TEXT);
		expect(wiped === undefined || (Array.isArray(wiped) && wiped.length === 0)).toBe(true);
		const twin = (await runRows(SECTION, role, bulk)).filter((row) => row.tm_role === 4);
		expect(twin.length).toBe(1);
		const emptied = await stored(SECTION, host, 'relation', SLOT);
		expect(emptied === undefined || (Array.isArray(emptied) && emptied.length === 0)).toBe(true);
		// The slot save is recorded as the MAIN's composed pair (the removed
		// frame names it): main + the frame before, the main alone after.
		const main = await stored(SECTION, host, 'relation', MAIN);
		const frame = {
			id: 1,
			type: 'dd490',
			id_key: 1,
			section_tipo: SECTION,
			section_id: role,
			from_component_tipo: SLOT,
			main_component_tipo: MAIN,
		};
		const rows = await runRows(SECTION, host, bulk);
		expectPair(rows, MAIN, composedOf(main, [frame]), composedOf(main, emptied));
		expect(rows.filter((row) => row.tipo === SLOT)).toEqual([]);
	});

	test('a MAIN item removed: ONE composed pair (main + its stripped slot), and the emptied frame target is twinned under the run', async () => {
		// §2.3 item 7 (M1): the cascade the main removal fires must carry the run
		// id down to the wipe door — the revert can restore only what it can find.
		const { host, role } = await framedHost();
		expect(await stored(SECTION, role, 'string', TEXT)).toEqual([
			{ id: 1, lang: 'lg-spa', value: 'role record' },
		]);
		const bulk = syntheticBulk();
		const slotBefore = await stored(SECTION, host, 'relation', SLOT);
		const mainBefore = await stored(SECTION, host, 'relation', MAIN);
		await save(host, MAIN, 'lg-nolan', [{ action: 'remove', id: 1, value: null }], {
			bulkProcessId: bulk,
		});
		const rows = await runRows(SECTION, host, bulk);
		const mainAfter = await stored(SECTION, host, 'relation', MAIN);
		const slotAfter = await stored(SECTION, host, 'relation', SLOT);
		expectPair(rows, MAIN, composedOf(mainBefore, slotBefore), composedOf(mainAfter, slotAfter));
		expect(rows.filter((row) => row.tipo === SLOT)).toEqual([]);
		// the row stays: no policy removes a frame target (WC-2026-09-29) — its content is emptied
		expect(await stored(SECTION, role, 'data', 'section_id')).not.toBe('NO-RECORD');
		const wiped = await stored(SECTION, role, 'string', TEXT);
		expect(wiped === undefined || (Array.isArray(wiped) && wiped.length === 0)).toBe(true);
		const twin = (await runRows(SECTION, role, bulk)).filter((row) => row.tm_role === 4);
		expect(twin.length).toBe(1);
	});
});

// ================================================================ the CSV door

async function importCsv(
	file: string,
	csv: string,
	columnsMap: Record<string, unknown>[],
	sectionTipo: string = T3,
): Promise<ImportFileReport> {
	writeFileSync(resolve(csvDir, file), csv);
	const loaded = await getLoadedTool('tool_import_dedalo_csv');
	const res = await mustGet(loaded?.module.apiActions.import_files, 'import_files').handler({
		principal: await resolvePrincipal(USER_ID),
		userId: CSV_USER,
		background: false,
		options: {
			files: [
				{ file, section_tipo: sectionTipo, bulk_process_label: file, ar_columns_map: columnsMap },
			],
		},
	});
	const report = (res.data as { files: ImportFileReport[] }).files[0] as ImportFileReport;
	if (report.bulk_process_id !== null) bulkIds.push(report.bulk_process_id);
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

describe('the CSV door', () => {
	test('REPLACE: one pair per language written; BEFORE = that language’s pre slice', async () => {
		const id = await newT3Record();
		const pre = [
			{ id: 1, lang: 'lg-spa', value: 'uno' },
			{ id: 1, lang: 'lg-eng', value: 'one' },
		];
		await seed(T3, id, 'string', T3_TEXT, pre);
		const cell = q(JSON.stringify({ 'lg-spa': ['dos'], 'lg-eng': ['two'] }));
		const report = await importCsv(
			`capture_replace_${id}.csv`,
			`section_id;${T3_TEXT}\n${id};${cell}\n`,
			[KEY, col(T3_TEXT, 'component_input_text')],
		);
		expect(report.failed).toEqual([]);
		const bulk = mustGet(report.bulk_process_id, 'run id');
		const rows = await runRows(T3, id, bulk);
		const live = await stored(T3, id, 'string', T3_TEXT);
		for (const lang of ['lg-spa', 'lg-eng']) {
			expectPair(rows, T3_TEXT, onlyLang(pre, lang), onlyLang(live, lang), lang);
		}
		expect(rows.length).toBe(4);
	}, 60_000);

	test('REPLACE re-import of an UNCHANGED id-less file writes NOTHING (the stored item ids carry over)', async () => {
		// WC §2 no-op law: a CSV cell names no item id; re-minting one on every
		// import made each re-import a change (a pair + a visible row per cell).
		const id = await newT3Record();
		const plain = await newT3Record();
		const cell = q(JSON.stringify({ 'lg-spa': ['dos', 'tres'], 'lg-eng': ['two'] }));
		const csv = `section_id;${T3_TEXT}\n${id};${cell}\n${plain};plain value\n`;
		const columns = [KEY, col(T3_TEXT, 'component_input_text')];
		const first = await importCsv(`capture_reimport_a_${id}.csv`, csv, columns);
		expect(first.failed).toEqual([]);
		const firstBulk = mustGet(first.bulk_process_id, 'run id');
		expect((await runRows(T3, id, firstBulk)).length).toBe(4);
		expect((await runRows(T3, plain, firstBulk)).length).toBe(2);
		const afterFirst = [
			await stored(T3, id, 'string', T3_TEXT),
			await stored(T3, plain, 'string', T3_TEXT),
		];
		const second = await importCsv(`capture_reimport_b_${id}.csv`, csv, columns);
		expect(second.failed).toEqual([]);
		const secondBulk = mustGet(second.bulk_process_id, 'run id');
		expect(await runRows(T3, id, secondBulk)).toEqual([]);
		expect(await runRows(T3, plain, secondBulk)).toEqual([]);
		expect([
			await stored(T3, id, 'string', T3_TEXT),
			await stored(T3, plain, 'string', T3_TEXT),
		]).toEqual(afterFirst);
	}, 60_000);

	test('REPLACE re-import of an UNCHANGED DATE writes NOTHING; the item id and its paired frame stay', async () => {
		// A stored date carries the DERIVED `time` the save stamps after the id
		// carry-over; the CSV conform yields none. Compared raw, the two always
		// differed: every re-import re-minted the date's id (a pair + a visible
		// row per cell) and the frame keyed to the old id (id_key) was orphaned.
		const id = await newRecord();
		const role = await newRecord();
		const date = [{ id: 7, start: { year: 2020, month: 1, day: 2, time: 64924502400 } }];
		const frame = [
			{
				id: 1,
				type: 'dd490',
				section_tipo: SECTION,
				section_id: String(role),
				id_key: 7,
				main_component_tipo: DATE_MAIN,
				from_component_tipo: DATE_SLOT,
			},
		];
		await seed(SECTION, id, 'date', DATE_MAIN, date);
		await seed(SECTION, id, 'relation', DATE_SLOT, frame);
		const report = await importCsv(
			`capture_reimport_date_${id}.csv`,
			`section_id;${DATE_MAIN}\n${id};2020-01-02\n`,
			[KEY, col(DATE_MAIN, 'component_date')],
			SECTION,
		);
		expect(report.failed).toEqual([]);
		const bulk = mustGet(report.bulk_process_id, 'run id');
		expect(await runRows(SECTION, id, bulk)).toEqual([]);
		expect(await stored(SECTION, id, 'date', DATE_MAIN)).toEqual(date);
		expect(await stored(SECTION, id, 'relation', DATE_SLOT)).toEqual(frame);
	}, 60_000);

	test('REPLACE re-import of an UNCHANGED flat PORTAL cell writes NOTHING; the locator ids and their paired frames stay', async () => {
		// A flat relation cell ('273,418') names no locator id; the relation
		// set_data re-minted one per locator (the id safety net), so every
		// re-import wrote a pair and left each frame's id_key on the OLD id —
		// unpaired (review 2026-09-28).
		const id = await newRecord();
		const a = await newRecord();
		const b = await newRecord();
		const role = await newRecord();
		const csv = `section_id;${MAIN}\n${id};${a},${b}\n`;
		const columns = [KEY, col(MAIN, 'component_portal')];
		const first = await importCsv(`capture_portal_a_${id}.csv`, csv, columns, SECTION);
		expect(first.failed).toEqual([]);
		const main = (await stored(SECTION, id, 'relation', MAIN)) as { id: number }[];
		expect(main.length).toBe(2);
		const frame = [
			{
				id: 1,
				type: 'dd490',
				section_tipo: SECTION,
				section_id: String(role),
				id_key: mustGet(main[1], 'second locator').id,
				main_component_tipo: MAIN,
				from_component_tipo: SLOT,
			},
		];
		await seed(SECTION, id, 'relation', SLOT, frame);
		const second = await importCsv(`capture_portal_b_${id}.csv`, csv, columns, SECTION);
		expect(second.failed).toEqual([]);
		const bulk = mustGet(second.bulk_process_id, 'run id');
		expect(await runRows(SECTION, id, bulk)).toEqual([]);
		expect(await stored(SECTION, id, 'relation', MAIN)).toEqual(main);
		expect(await stored(SECTION, id, 'relation', SLOT)).toEqual(frame);
	}, 60_000);

	test('APPEND: BEFORE = the stored portal, AFTER = stored + the appended locator', async () => {
		const id = await newT3Record();
		const a = await newT3Record();
		const b = await newT3Record();
		const pre = [
			{ id: 1, type: 'dd151', section_tipo: T3, section_id: a, from_component_tipo: T3_PORTAL },
		];
		await seed(T3, id, 'relation', T3_PORTAL, pre);
		const report = await importCsv(
			`capture_append_${id}.csv`,
			`section_id;${T3_PORTAL}\n${id};${b}\n`,
			[KEY, col(T3_PORTAL, 'component_portal', 'append')],
		);
		expect(report.failed).toEqual([]);
		const live = await stored(T3, id, 'relation', T3_PORTAL);
		expect((live as unknown[]).length).toBe(2);
		expectPair(
			await runRows(T3, id, mustGet(report.bulk_process_id, 'run id')),
			T3_PORTAL,
			pre,
			live,
		);
	}, 60_000);

	test('legacy ENVELOPE frames: the slot save is the MAIN’s lg-nolan pair, no slot row', async () => {
		const id = await newT3Record();
		const target = await newT3Record();
		const seeded = [{ id: 1, lang: 'lg-spa', value: 'seed' }];
		await seed(T3, id, 'string', T3_TEXT, seeded);
		const envelope = {
			data: [{ id: 1, lang: 'lg-spa', value: 'seed' }],
			dataframe: [
				{
					from_component_tipo: T3_SLOT,
					id_key: 1,
					main_component_tipo: T3_TEXT,
					section_tipo: T3,
					section_id: target,
				},
			],
		};
		const report = await importCsv(
			`capture_envelope_${id}.csv`,
			`section_id;${T3_TEXT}\n${id};${q(JSON.stringify({ dedalo_data: envelope }))}\n`,
			[KEY, col(T3_TEXT, 'component_input_text', 'append')],
		);
		expect(report.failed).toEqual([]);
		const rows = await runRows(T3, id, mustGet(report.bulk_process_id, 'run id'));
		const slot = await stored(T3, id, 'relation', T3_SLOT);
		expect(Array.isArray(slot) && slot.length === 1).toBe(true);
		// The main item was a duplicate (no main write of its own); the frame save
		// is recorded under the MAIN, in its lg-nolan FRAME lane (two lanes: the
		// lg-nolan value — none, the main is translatable — + every frame):
		// BEFORE absent (no frame, no lg-nolan value), AFTER the frames. The spa
		// value, unchanged, gets no pair.
		expect(rows.filter((row) => row.tipo === T3_SLOT)).toEqual([]);
		expect(rows.map((row) => row.lang)).toEqual(['lg-nolan', 'lg-nolan']);
		expectPair(rows, T3_TEXT, undefined, slot, 'lg-nolan');
	}, 60_000);
});

// ================================================================ import_execute

describe('import_execute (MARC21 / Zotero / RDF executor)', () => {
	test('an UPDATE run: one pair on the written key', async () => {
		const id = await newT3Record();
		await seed(T3, id, 'string', T3_TEXT, [{ id: 1, lang: 'lg-spa', value: 'old' }]);
		const report = await importMappedRecords(
			[{ sectionId: id, fields: [{ component_tipo: T3_TEXT, values: ['imported'] }] }],
			T3,
			IMPORTER,
			{ bulkLabel: 'bulk_undo_capture update' },
		);
		const bulk = mustGet(report.bulkProcessId, 'run id');
		bulkIds.push(bulk);
		expect(report.failed).toEqual([]);
		const rows = await runRows(T3, id, bulk);
		const pair = rows.filter((row) => row.tipo === T3_TEXT);
		expect(pair.map((row) => row.tm_role)).toEqual([1, null]);
		expect(pair[0]?.data).toEqual(
			onlyLang([{ id: 1, lang: 'lg-spa', value: 'old' }], pair[0]?.lang as string),
		);
		expect(pair[1]?.data).toEqual(
			onlyLang(await stored(T3, id, 'string', T3_TEXT), pair[1]?.lang as string),
		);
	}, 60_000);

	test('a CREATE run: the birth marker FIRST, then the key’s pair from absence', async () => {
		const report = await importMappedRecords(
			[{ sectionId: null, fields: [{ component_tipo: T3_TEXT, values: ['born'] }] }],
			T3,
			IMPORTER,
			{ bulkLabel: 'bulk_undo_capture create' },
		);
		const bulk = mustGet(report.bulkProcessId, 'run id');
		bulkIds.push(bulk);
		const id = report.createdIds[0] as number;
		t3Records.push(id);
		const rows = await runRows(T3, id, bulk);
		expect(rows[0]).toMatchObject({ tipo: T3, tm_role: 3 });
		const pair = rows.filter((row) => row.tipo === T3_TEXT);
		expect(pair.map((row) => [row.tm_role, row.absent])).toEqual([
			[1, true],
			[null, false],
		]);
	}, 60_000);
});

// ================================================================ propagate

describe('propagate_component_data', () => {
	async function propagate(ids: number[], action: string, value: unknown[]): Promise<number> {
		const loaded = await getLoadedTool('tool_propagate_component_data');
		const handler = mustGet(
			loaded?.module.apiActions.propagate_component_data,
			'propagate',
		).handler;
		const response = await handler(
			await context({
				section_tipo: T3,
				component_tipo: T3_TEXT,
				action,
				lang: 'lg-spa',
				total: ids.length,
				propagate_data_value: value,
				sqo: {
					section_tipo: [T3],
					filter_by_locators: ids.map((id) => ({ section_tipo: T3, section_id: String(id) })),
				},
			}),
		);
		const bulk = (response.data as { bulk_process_id: number }).bulk_process_id;
		bulkIds.push(bulk);
		return bulk;
	}

	for (const [action, value] of [
		['replace', [{ lang: 'lg-spa', value: 'P' }]],
		['add', [{ lang: 'lg-spa', value: 'P' }]],
		['delete', [{ lang: 'lg-spa', value: 'S' }]],
	] as const) {
		test(`${action}: per record ONE pair over the spa region, lg-eng untouched`, async () => {
			const ids = [await newT3Record(), await newT3Record()];
			const pre = [
				{ id: 1, lang: 'lg-spa', value: 'S' },
				{ id: 1, lang: 'lg-eng', value: 'E' },
			];
			for (const id of ids) await seed(T3, id, 'string', T3_TEXT, pre);
			const bulk = await propagate(ids, action, [...value]);
			for (const id of ids) {
				const live = await stored(T3, id, 'string', T3_TEXT);
				expect(onlyLang(live, 'lg-eng')).toEqual([{ id: 1, lang: 'lg-eng', value: 'E' }]);
				const rows = await runRows(T3, id, bulk);
				expect(rows.length).toBe(2);
				// A region with no spa item left is ABSENT (lang_region.ts: one absence law).
				const after = onlyLang(live, 'lg-spa') as unknown[];
				expectPair(
					rows,
					T3_TEXT,
					onlyLang(pre, 'lg-spa'),
					after.length === 0 ? undefined : after,
					'lg-spa',
				);
			}
		}, 60_000);
	}
});

// ================================================================ update_cache

async function sweep(id: number, sectionTipo = T3, tipo = T3_TEXT): Promise<number> {
	const loaded = await getLoadedTool('tool_update_cache');
	const handler = mustGet(loaded?.module.apiActions.update_cache, 'update_cache').handler;
	const response = await handler(
		await context({
			section_tipo: sectionTipo,
			components_selection: [{ tipo }],
			sqo: {
				section_tipo: [sectionTipo],
				filter_by_locators: [{ section_tipo: sectionTipo, section_id: String(id) }],
			},
		}),
	);
	const bulk = Number((response.data as { bulk_process_id?: unknown }).bulk_process_id ?? 0);
	const [{ m } = { m: 0 }] = (await sql.unsafe(
		`SELECT max(section_id)::int AS m FROM "${bulkTable}" WHERE section_tipo = 'dd800'`,
	)) as { m: number }[];
	const run = bulk > 0 ? bulk : Number(m);
	bulkIds.push(run);
	return run;
}

describe('update_cache (a regenerate sweep)', () => {
	test('a re-save that CHANGES the value (stamps a missing id) writes a VISIBLE pair (D1)', async () => {
		const id = await newT3Record();
		const pre = [{ lang: 'lg-spa', value: 'needs an id' }];
		await seed(T3, id, 'string', T3_TEXT, pre);
		const bulk = await sweep(id);
		const live = await stored(T3, id, 'string', T3_TEXT);
		expect((live as { id?: unknown }[])[0]?.id).toBeDefined();
		expectPair(await runRows(T3, id, bulk), T3_TEXT, pre, onlyLang(live, 'lg-spa'), 'lg-spa');
	}, 60_000);

	test('a re-save that changes NOTHING writes no row', async () => {
		const id = await newT3Record();
		await seed(T3, id, 'string', T3_TEXT, [{ id: 1, lang: 'lg-spa', value: 'settled' }]);
		const bulk = await sweep(id);
		expect(await runRows(T3, id, bulk)).toEqual([]);
	}, 60_000);
});

// ================================================================ bulk_revert's own writes

describe('bulk_revert writes its own undo log', () => {
	test('each reverted key: BEFORE = the run’s value it replaced, AFTER = the restored value, under the revert’s id', async () => {
		const id = await newRecord();
		await seed(SECTION, id, 'string', TEXT, [
			{ id: 1, lang: 'lg-spa', value: 'pre' },
			{ id: 1, lang: 'lg-eng', value: 'kept' },
		]);
		const run = await createSectionRecord('dd800', USER_ID);
		bulkIds.push(run);
		await save(id, TEXT, 'lg-spa', [{ action: 'set_data', value: [{ id: 1, value: 'run' }] }], {
			bulkProcessId: run,
		});
		const runValue = onlyLang(await stored(SECTION, id, 'string', TEXT), 'lg-spa');
		const response = await toolTimeMachineBulkRevert(await context({ bulk_process_id: run }));
		const revert = (response.data as { bulk_process_id: number }).bulk_process_id;
		bulkIds.push(revert);
		const live = await stored(SECTION, id, 'string', TEXT);
		expect(onlyLang(live, 'lg-spa')).toEqual([{ id: 1, lang: 'lg-spa', value: 'pre' }]);
		expectPair(
			await runRows(SECTION, id, revert),
			TEXT,
			runValue,
			onlyLang(live, 'lg-spa'),
			'lg-spa',
		);
	}, 60_000);
});

// ================================================================ a transliterable component

/** A key's items as `lang:value`, order-free (the languages of one key in any order are one state). */
async function langValues(id: number, tipo: string): Promise<string[]> {
	return (
		((await stored(SECTION, id, 'string', tipo)) as
			| { lang?: string; value?: unknown }[]
			| undefined) ?? []
	)
		.map((item) => `${item.lang}:${String(item.value)}`)
		.sort();
}

describe('a TRANSLITERABLE component (with_lang_versions): every door keeps the lg-nolan base and files each version in its own lane', () => {
	test('CSV REPLACE of a multi-lang cell {lg-nolan, lg-ell}: both kept, one pair per lane', async () => {
		const id = await newRecord();
		const cell = q(JSON.stringify({ 'lg-nolan': ['Augustus'], 'lg-ell': ['Αύγουστος'] }));
		const report = await importCsv(
			`capture_xlit_replace_${id}.csv`,
			`section_id;${XLIT}\n${id};${cell}\n`,
			[KEY, col(XLIT, 'component_input_text')],
			SECTION,
		);
		expect(report.failed).toEqual([]);
		expect(await langValues(id, XLIT)).toEqual(['lg-ell:Αύγουστος', 'lg-nolan:Augustus']);
		const rows = await runRows(SECTION, id, mustGet(report.bulk_process_id, 'run id'));
		expect(rows.map((row) => `${row.lang}:${row.tm_role}`).sort()).toEqual([
			'lg-ell:1',
			'lg-ell:null',
			'lg-nolan:1',
			'lg-nolan:null',
		]);
	}, 60_000);

	test('CSV APPEND of a multi-lang cell: the base gets its value, the transliteration its own — never one collapsed slice', async () => {
		const id = await newRecord();
		await seed(SECTION, id, 'string', XLIT, [{ id: 1, lang: 'lg-nolan', value: 'Augustus' }]);
		const cell = q(JSON.stringify({ 'lg-nolan': ['Octavianus'], 'lg-ell': ['Αύγουστος'] }));
		const report = await importCsv(
			`capture_xlit_append_${id}.csv`,
			`section_id;${XLIT}\n${id};${cell}\n`,
			[KEY, col(XLIT, 'component_input_text', 'append')],
			SECTION,
		);
		expect(report.failed).toEqual([]);
		expect(await langValues(id, XLIT)).toEqual([
			'lg-ell:Αύγουστος',
			'lg-nolan:Augustus',
			'lg-nolan:Octavianus',
		]);
	}, 60_000);

	test('propagate ADD in lg-ell adds to the transliteration only — the base stays, never read as the lg-ell region', async () => {
		const id = await newRecord();
		await seed(SECTION, id, 'string', XLIT, [
			{ id: 1, lang: 'lg-nolan', value: 'Augustus' },
			{ id: 1, lang: 'lg-ell', value: 'Αύγουστος' },
		]);
		const loaded = await getLoadedTool('tool_propagate_component_data');
		const handler = mustGet(
			loaded?.module.apiActions.propagate_component_data,
			'propagate',
		).handler;
		const response = await handler(
			await context({
				section_tipo: SECTION,
				component_tipo: XLIT,
				action: 'add',
				lang: 'lg-ell',
				total: 1,
				propagate_data_value: [{ lang: 'lg-ell', value: 'Οκταβιανός' }],
				sqo: {
					section_tipo: [SECTION],
					filter_by_locators: [{ section_tipo: SECTION, section_id: String(id) }],
				},
			}),
		);
		bulkIds.push((response.data as { bulk_process_id: number }).bulk_process_id);
		expect(await langValues(id, XLIT)).toEqual([
			'lg-ell:Αύγουστος',
			'lg-ell:Οκταβιανός',
			'lg-nolan:Augustus',
		]);
	}, 60_000);

	test('update_cache of an unchanged record writes NOTHING and creates no base (with a base; without one)', async () => {
		const withBase = await newRecord();
		await seed(SECTION, withBase, 'string', XLIT, [
			{ id: 1, lang: 'lg-cat', value: 'Pere de Portugal' },
			{ id: 1, lang: 'lg-nolan', value: 'Pedro de Portugal' },
		]);
		const noBase = await newRecord();
		await seed(SECTION, noBase, 'string', XLIT, [
			{ id: 1, lang: 'lg-cat', value: 'Ferran I' },
			{ id: 1, lang: 'lg-spa', value: 'Fernando I' },
			{ id: 1, lang: 'lg-vlca', value: 'Ferran I' },
		]);
		for (const id of [withBase, noBase]) {
			const before = await langValues(id, XLIT);
			const bulk = await sweep(id, SECTION, XLIT);
			expect(await runRows(SECTION, id, bulk)).toEqual([]);
			expect(await langValues(id, XLIT)).toEqual(before);
		}
	}, 60_000);
});
