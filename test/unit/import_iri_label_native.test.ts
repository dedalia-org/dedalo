/**
 * component_iri IMPORT LABELS — TS-native gate for T0-12 (OX2).
 *
 * THE DEFECT THIS PINS. A CSV/mapped import of a labelled iri cell
 * (`'<label id>, https://…'`, `'<label text>, https://…'`, or a JSON item
 * carrying `label_id`) stored the label as a stray `label_id` key on the iri
 * item and NEVER wrote the dd560 label frame — so the label was invisible to
 * every reader (the read pairs dd560 by `id_key → item.id`), and a raw export
 * re-emitted the stray key. A text label was refused outright.
 *
 * THE CONTRACT. The stored shape is EXACTLY the editor's: the literal item
 * `{id, lang, iri}` (no `label_id`; the deprecated `title` kept) plus ONE dd560
 * frame `{type:'dd490', section_tipo:'dd1706', section_id, from_component_tipo:
 * 'dd560', main_component_tipo:<iri tipo>, id_key:<item id>, id}`. A text label
 * resolves to an existing dd1706 record (trimmed, case- and accent-insensitive,
 * whole value; several → the LOWEST id + a warning), else one is CREATED inside
 * the row's transaction (a rolled-back row leaves none). An unknown numeric
 * label refuses the field (nothing written).
 *
 * Scratch surface (suite DB, generic `test` TLD): test3 records created at
 * runtime, `test140` (component_iri on test3), the core label vocabulary
 * dd1706/dd1715 and the fixed slot dd560. Every dd1706 label this gate creates
 * — or the import creates for it — carries a unique `zz…<run>` value and is
 * swept after (records + TM rows); the persona rows use explicit ids in this
 * file's own band and are swept too. No ontology node is created.
 */

import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from '../../src/config/config.ts';
import { encodeForJsonb } from '../../src/core/db/json_codec.ts';
import type { MatrixJsonbColumn } from '../../src/core/db/matrix.ts';
import {
	deleteMatrixRecord,
	insertMatrixRecordWithExplicitId,
} from '../../src/core/db/matrix_write.ts';
import * as postgresModule from '../../src/core/db/postgres.ts';
import { sql } from '../../src/core/db/postgres.ts';
import { createSectionRecord } from '../../src/core/section/record/create_record.ts';
import * as saveComponentModule from '../../src/core/section/record/save_component.ts';
import { saveComponentData } from '../../src/core/section/record/save_component.ts';
import {
	clearPermissionsCache,
	clearPrincipalCache,
	clearUserProjectsCache,
	resolvePrincipal,
} from '../../src/core/security/permissions.ts';
import { assertTestDatabase } from '../../src/core/test_data/test_database_marker.ts';
import { importMappedRecords } from '../../src/core/tools/import_execute.ts';
import type { ImportFileReport } from '../../src/core/tools/import_wire.ts';
import { getLoadedTool } from '../../src/core/tools/loader.ts';
import { mustGet } from '../helpers/assert.ts';
import { cleanScratchRecord } from '../helpers/test_data.ts';

const SECTION = 'test3';
const TABLE = 'matrix_test';
const IRI = 'test140'; // component_iri on test3
const SLOT = 'dd560'; // the iri label frame slot (fixed, data_limit 1)
const LABEL_SECTION = 'dd1706';
const LABEL_VALUE = 'dd1715';
const LABEL_TABLE = 'matrix_list';
const USER = 987681; // this gate's own import dir
const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
/** Every label value this gate (or the import, for it) writes starts with this. */
const LABEL_PREFIX = `zzilb012${RUN}`;

const dir = resolve(config.media.rootPath ?? '', 'import/files', String(USER));
const createdRecords: number[] = [];
const bulkProcessIds: number[] = [];

type Item = Record<string, unknown>;

/**
 * The REAL save module, snapshotted (a SPREAD copy) before any mock.module swap:
 * mock.module is process-global and mock.restore() does not revert it, so the
 * file-level afterEach re-installs this (case 4 forces one refused save).
 */
const REAL_SAVE_COMPONENT = { ...saveComponentModule };
/** The REAL postgres module, same discipline (R6 observes the lock order). */
const REAL_POSTGRES = { ...postgresModule };
afterEach(() => {
	mock.module('../../src/core/section/record/save_component.ts', () => REAL_SAVE_COMPONENT);
	mock.module('../../src/core/db/postgres.ts', () => REAL_POSTGRES);
	mock.restore();
});

// ---------------------------------------------------------------- helpers

async function newRecord(): Promise<number> {
	const id = await createSectionRecord(SECTION, -1);
	createdRecords.push(id);
	return id;
}

/** A dd1706 label record carrying `value` (built through the engine's doors). */
async function newLabel(value: string): Promise<number> {
	const id = await createSectionRecord(LABEL_SECTION, -1);
	const outcome = await saveComponentData({
		componentTipo: LABEL_VALUE,
		sectionTipo: LABEL_SECTION,
		sectionId: id,
		lang: 'lg-nolan',
		changedData: [{ action: 'set_data', id: null, value: [{ value }] }],
		userId: -1,
	});
	if (outcome.ok === false) throw new Error(`label seed refused: ${outcome.message}`);
	return id;
}

/** The dd1706 records whose dd1715 value is exactly `value`, ascending. */
async function labelIdsWithValue(value: string): Promise<number[]> {
	const rows = (await sql.unsafe(
		`SELECT section_id FROM ${LABEL_TABLE}
		 WHERE section_tipo = $1 AND string->$2 @> $3::text::jsonb ORDER BY section_id`,
		[LABEL_SECTION, LABEL_VALUE, JSON.stringify([{ value }])],
	)) as { section_id: number }[];
	return rows.map((row) => Number(row.section_id));
}

/** The dd1715 items of one label record. */
async function labelValueItems(sectionId: number): Promise<Item[]> {
	const rows = (await sql.unsafe(
		`SELECT string->$3 AS value FROM ${LABEL_TABLE} WHERE section_tipo = $1 AND section_id = $2`,
		[LABEL_SECTION, sectionId, LABEL_VALUE],
	)) as { value: Item[] | null }[];
	return rows[0]?.value ?? [];
}

async function stored(sectionId: number, column: string, tipo: string): Promise<Item[]> {
	const rows = (await sql.unsafe(
		`SELECT ${column}->$3 AS value FROM ${TABLE} WHERE section_tipo = $1 AND section_id = $2`,
		[SECTION, sectionId, tipo],
	)) as { value: Item[] | null }[];
	return rows[0]?.value ?? [];
}

const iriItems = (sectionId: number): Promise<Item[]> => stored(sectionId, 'iri', IRI);
const frames = (sectionId: number): Promise<Item[]> => stored(sectionId, 'relation', SLOT);

/** The frame the editor writes for one labelled item (bookkeeping `id` checked apart). */
function expectEditorFrame(frame: Item | undefined, labelId: number, idKey: unknown): void {
	expect(frame).toBeDefined();
	const { id, ...rest } = frame as Item;
	expect(rest).toEqual({
		type: 'dd490',
		section_tipo: LABEL_SECTION,
		section_id: labelId,
		from_component_tipo: SLOT,
		main_component_tipo: IRI,
		id_key: idKey,
	});
	expect(Number.isInteger(id)).toBe(true);
	expect(typeof labelId).toBe('number');
}

const KEY = { tipo: 'section_id', model: 'section_id' };
function col(tipo: string, model: string, mode?: string): Record<string, unknown> {
	const entry: Record<string, unknown> = { tipo, model, checked: true, map_to: tipo };
	if (mode !== undefined) entry.import_mode = mode;
	return entry;
}
const IRI_COL = (mode?: string) => col(IRI, 'component_iri', mode);
/** CSV-quote a cell (doubling inner quotes). */
const q = (value: string): string => `"${value.replace(/"/g, '""')}"`;

let fileCounter = 0;
async function importCsv(
	csv: string,
	columnsMap: Record<string, unknown>[],
	userId = -1,
): Promise<ImportFileReport> {
	fileCounter += 1;
	const file = `t012_${fileCounter}.csv`;
	writeFileSync(resolve(dir, file), csv);
	const loaded = await getLoadedTool('tool_import_dedalo_csv');
	const res = await mustGet(loaded?.module.apiActions.import_files, 'import_files').handler({
		principal: await resolvePrincipal(userId),
		userId: USER,
		background: false,
		options: {
			files: [
				{ file, section_tipo: SECTION, bulk_process_label: file, ar_columns_map: columnsMap },
			],
		},
	});
	const report = (res.data as { files: ImportFileReport[] }).files[0] as ImportFileReport;
	if (report.bulk_process_id !== null) bulkProcessIds.push(report.bulk_process_id);
	return report;
}

/** The one-column CSV `section_id;test140` for one row. */
function iriCsv(sectionId: number, cell: string): string {
	return `section_id;${IRI}\n${sectionId};${q(cell)}\n`;
}

async function sweepLabels(): Promise<void> {
	const rows = (await sql.unsafe(
		`SELECT section_id FROM ${LABEL_TABLE}
		 WHERE section_tipo = $1 AND EXISTS (
		   SELECT 1 FROM jsonb_array_elements(COALESCE(string->$2, '[]'::jsonb)) AS e
		   WHERE f_unaccent(lower(e->>'value')) LIKE $3)`,
		[LABEL_SECTION, LABEL_VALUE, `%${LABEL_PREFIX}%`],
	)) as { section_id: number }[];
	for (const row of rows)
		await cleanScratchRecord(LABEL_SECTION, Number(row.section_id), LABEL_TABLE);
}

// ---------------------------------------------------------------- lifecycle

beforeAll(async () => {
	await assertTestDatabase('import_iri_label_native');
	mkdirSync(dir, { recursive: true });
});

afterAll(async () => {
	rmSync(dir, { recursive: true, force: true });
	await sweepLabels();
	for (const id of createdRecords) await cleanScratchRecord(SECTION, id, TABLE);
	for (const id of bulkProcessIds) {
		await sql.unsafe(`DELETE FROM matrix_notes WHERE section_tipo = 'dd800' AND section_id = $1`, [
			id,
		]);
		await sql.unsafe(
			`DELETE FROM matrix_time_machine WHERE section_tipo = 'dd800' AND section_id = $1`,
			[id],
		);
	}
	// Zero residue: no label of this run survives.
	const left = (await sql.unsafe(
		`SELECT count(*)::int AS n FROM ${LABEL_TABLE} WHERE section_tipo = $1 AND string::text LIKE $2`,
		[LABEL_SECTION, `%${LABEL_PREFIX}%`],
	)) as { n: number }[];
	expect(left[0]?.n).toBe(0);
});

// ---------------------------------------------------------------- cases

describe('CSV REPLACE — a labelled iri cell writes the editor shape', () => {
	test('1. numeric label id → clean literal item + ONE paired dd560 frame', async () => {
		const labelId = await newLabel(`${LABEL_PREFIX}-one`);
		const record = await newRecord();
		const report = await importCsv(iriCsv(record, `${labelId}, https://a.test/1`), [
			KEY,
			IRI_COL(),
		]);
		expect(report.failed).toEqual([]);
		const items = await iriItems(record);
		expect(items).toHaveLength(1);
		const item = items[0] as Item;
		expect(Object.hasOwn(item, 'label_id')).toBe(false);
		expect(item.iri).toBe('https://a.test/1');
		expect(Number.isInteger(item.id)).toBe(true);
		const stored = await frames(record);
		expect(stored).toHaveLength(1);
		expectEditorFrame(stored[0], labelId, item.id);
	});

	test('2. text label → ONE new dd1706 record (dd1715 lg-nolan) + paired frame', async () => {
		const value = `${LABEL_PREFIX}-two`;
		const record = await newRecord();
		const report = await importCsv(iriCsv(record, `${value}, https://a.test/2`), [KEY, IRI_COL()]);
		expect(report.failed).toEqual([]);
		const labels = await labelIdsWithValue(value);
		expect(labels).toHaveLength(1);
		const labelId = labels[0] as number;
		const valueItems = await labelValueItems(labelId);
		expect(valueItems).toEqual([{ id: 1, lang: 'lg-nolan', value }]);
		const items = await iriItems(record);
		expect(items).toHaveLength(1);
		expect(Object.hasOwn(items[0] as Item, 'label_id')).toBe(false);
		const stored = await frames(record);
		expect(stored).toHaveLength(1);
		expectEditorFrame(stored[0], labelId, (items[0] as Item).id);
	});
});

describe('CSV REPLACE — idempotence, sharing, refusal, rollback', () => {
	test('3. re-importing the same file creates no second label, frame or item', async () => {
		const value = `${LABEL_PREFIX}-three`;
		const record = await newRecord();
		const csv = iriCsv(record, `${value}, https://a.test/3`);
		expect((await importCsv(csv, [KEY, IRI_COL()])).failed).toEqual([]);
		const firstItems = await iriItems(record);
		expect((await importCsv(csv, [KEY, IRI_COL()])).failed).toEqual([]);
		expect(await labelIdsWithValue(value)).toHaveLength(1);
		const items = await iriItems(record);
		expect(items).toHaveLength(1);
		expect(items[0]?.id).toBe(firstItems[0]?.id as number);
		const stored = await frames(record);
		expect(stored).toHaveLength(1);
		expectEditorFrame(stored[0], (await labelIdsWithValue(value))[0] as number, items[0]?.id);
	});

	test('4. one new label on two rows and twice in one cell → ONE dd1706 record', async () => {
		const value = `${LABEL_PREFIX}-four`;
		const [a, b] = [await newRecord(), await newRecord()];
		const csv =
			`section_id;${IRI}\n` +
			`${a};${q(`${value}, https://a.test/4a | ${value}, https://a.test/4b`)}\n` +
			`${b};${q(`${value}, https://a.test/4c`)}\n`;
		const report = await importCsv(csv, [KEY, IRI_COL()]);
		expect(report.failed).toEqual([]);
		const labels = await labelIdsWithValue(value);
		expect(labels).toHaveLength(1);
		const aItems = await iriItems(a);
		const aFrames = await frames(a);
		expect(aItems).toHaveLength(2);
		expect(aFrames).toHaveLength(2);
		expect(aFrames.map((frame) => frame.id_key).sort()).toEqual(aItems.map((i) => i.id).sort());
		expect(new Set(aFrames.map((frame) => frame.section_id))).toEqual(new Set(labels));
		expect(await frames(b)).toHaveLength(1);
	});

	test('5. an unknown numeric label id refuses the field — no item, no frame', async () => {
		const record = await newRecord();
		const report = await importCsv(iriCsv(record, '2147480000, https://a.test/5'), [
			KEY,
			IRI_COL(),
		]);
		expect(report.failed).toHaveLength(1);
		expect(report.failed[0]?.component_tipo).toBe(IRI);
		expect(report.failed[0]?.msg).toContain('2147480000');
		expect(await iriItems(record)).toEqual([]);
		expect(await frames(record)).toEqual([]);
	});

	test('6. a rolled-back row leaves no created label behind', async () => {
		const value = `${LABEL_PREFIX}-six`;
		const record = await newRecord();
		// test17 (text_area) in APPEND refuses a value carrying an index tag, AFTER
		// the iri column created its label in the same row transaction.
		const report = await importCsv(
			`section_id;${IRI};test17\n${record};${q(`${value}, https://a.test/6`)};see [index-n-1] here\n`,
			[KEY, IRI_COL(), col('test17', 'component_text_area', 'append')],
		);
		expect(report.failed).toHaveLength(1);
		expect(report.failed[0]?.msg).toContain('rolled back');
		expect(await labelIdsWithValue(value)).toEqual([]);
		expect(await iriItems(record)).toEqual([]);
		expect(await frames(record)).toEqual([]);
	});

	test('7. JSON item with label_id + title → clean item (title KEPT) + paired frame', async () => {
		const labelId = await newLabel(`${LABEL_PREFIX}-seven`);
		const record = await newRecord();
		const cell = JSON.stringify([{ iri: 'https://a.test/7', label_id: labelId, title: 'T' }]);
		const report = await importCsv(iriCsv(record, cell), [KEY, IRI_COL()]);
		expect(report.failed).toEqual([]);
		const items = await iriItems(record);
		expect(items).toHaveLength(1);
		expect(Object.hasOwn(items[0] as Item, 'label_id')).toBe(false);
		expect(items[0]?.title).toBe('T');
		expect(items[0]?.iri).toBe('https://a.test/7');
		const stored = await frames(record);
		expect(stored).toHaveLength(1);
		expectEditorFrame(stored[0], labelId, items[0]?.id);
	});

	test('7b. trimmed case/accent-insensitive whole-value match; duplicates → lowest id + warning', async () => {
		const storedLabel = await newLabel(`Nómisma-${LABEL_PREFIX}`);
		const record = await newRecord();
		const report = await importCsv(iriCsv(record, `nomisma-${LABEL_PREFIX}, https://a.test/7b`), [
			KEY,
			IRI_COL(),
		]);
		expect(report.failed).toEqual([]);
		// no new record: the folded value matched the stored one
		expect(await labelIdsWithValue(`nomisma-${LABEL_PREFIX}`)).toEqual([]);
		expectEditorFrame((await frames(record))[0], storedLabel, (await iriItems(record))[0]?.id);
		// a SUBSTRING is not a match: a longer label is a new record
		const longer = await newRecord();
		await importCsv(iriCsv(longer, `nomisma-${LABEL_PREFIX}-x, https://a.test/7c`), [
			KEY,
			IRI_COL(),
		]);
		expect(await labelIdsWithValue(`nomisma-${LABEL_PREFIX}-x`)).toHaveLength(1);

		const low = await newLabel(`Ñandú-${LABEL_PREFIX}`);
		const high = await newLabel(`ñandu-${LABEL_PREFIX}`);
		const twin = await newRecord();
		const twinReport = await importCsv(iriCsv(twin, ` NANDU-${LABEL_PREFIX} , https://a.test/7d`), [
			KEY,
			IRI_COL(),
		]);
		expect(twinReport.failed).toEqual([]);
		expectEditorFrame((await frames(twin))[0], Math.min(low, high), (await iriItems(twin))[0]?.id);
		const warning = twinReport.warnings.find((issue) => issue.component_tipo === IRI);
		expect(warning?.msg).toContain(String(Math.max(low, high)));
	});

	test('8. replacing one lang slice keeps the other slice item AND its frame', async () => {
		const spa = await newLabel(`${LABEL_PREFIX}-spa`);
		const eng = await newLabel(`${LABEL_PREFIX}-eng`);
		const spa2 = await newLabel(`${LABEL_PREFIX}-spa2`);
		const record = await newRecord();
		const both = JSON.stringify({
			'lg-spa': [`${spa}, https://a.test/8s`],
			'lg-eng': [`${eng}, https://a.test/8e`],
		});
		expect((await importCsv(iriCsv(record, both), [KEY, IRI_COL()])).failed).toEqual([]);
		const engItem = (await iriItems(record)).find((item) => item.lang === 'lg-eng') as Item;
		expect(engItem).toBeDefined();
		const spaOnly = JSON.stringify({ 'lg-spa': [`${spa2}, https://a.test/8s2`] });
		expect((await importCsv(iriCsv(record, spaOnly), [KEY, IRI_COL()])).failed).toEqual([]);
		const items = await iriItems(record);
		expect(items.find((item) => item.lang === 'lg-eng')).toEqual(engItem);
		const spaItem = items.find((item) => item.lang === 'lg-spa') as Item;
		expect(spaItem.iri).toBe('https://a.test/8s2');
		const stored = await frames(record);
		expectEditorFrame(
			stored.find((frame) => frame.id_key === engItem.id),
			eng,
			engItem.id,
		);
		expectEditorFrame(
			stored.find((frame) => frame.id_key === spaItem.id),
			spa2,
			spaItem.id,
		);
	});
});

describe('CSV APPEND — the label rides the append id map', () => {
	test('9. duplicate iri without a frame gains it; a DIFFERENT label refuses the row', async () => {
		const first = await newLabel(`${LABEL_PREFIX}-nine`);
		const other = await newLabel(`${LABEL_PREFIX}-nine-other`);
		const record = await newRecord();
		expect((await importCsv(iriCsv(record, 'https://a.test/9'), [KEY, IRI_COL()])).failed).toEqual(
			[],
		);
		const seeded = await iriItems(record);
		expect(seeded).toHaveLength(1);
		expect(await frames(record)).toEqual([]);

		const appended = await importCsv(iriCsv(record, `${first}, https://a.test/9`), [
			KEY,
			IRI_COL('append'),
		]);
		expect(appended.failed).toEqual([]);
		const items = await iriItems(record);
		expect(items).toEqual(seeded); // the item is a duplicate: kept byte-for-byte
		const stored = await frames(record);
		expect(stored).toHaveLength(1);
		expectEditorFrame(stored[0], first, seeded[0]?.id);

		// same label again: nothing changes
		expect(
			(await importCsv(iriCsv(record, `${first}, https://a.test/9`), [KEY, IRI_COL('append')]))
				.failed,
		).toEqual([]);
		expect(await frames(record)).toEqual(stored);

		// a different label on the same item: the slot's data_limit refuses the row
		const refused = await importCsv(iriCsv(record, `${other}, https://a.test/9`), [
			KEY,
			IRI_COL('append'),
		]);
		expect(refused.failed).toHaveLength(1);
		expect(refused.failed[0]?.msg).toContain('rolled back');
		expect(await frames(record)).toEqual(stored);
		expect(await iriItems(record)).toEqual(seeded);
	});

	test('9b. a NEW labelled item appended pairs its frame with its final id', async () => {
		const value = `${LABEL_PREFIX}-nine-b`;
		const record = await newRecord();
		expect(
			(await importCsv(iriCsv(record, 'https://a.test/9b1'), [KEY, IRI_COL()])).failed,
		).toEqual([]);
		const report = await importCsv(iriCsv(record, `${value}, https://a.test/9b2`), [
			KEY,
			IRI_COL('append'),
		]);
		expect(report.failed).toEqual([]);
		const items = await iriItems(record);
		expect(items).toHaveLength(2);
		const added = items.find((item) => item.iri === 'https://a.test/9b2') as Item;
		expect(typeof added.id).toBe('number'); // the import-local key never stored
		const stored = await frames(record);
		expect(stored).toHaveLength(1);
		expectEditorFrame(stored[0], (await labelIdsWithValue(value))[0] as number, added.id);
	});
});

describe('the mapped executor (MARC21/Zotero/RDF) — same stored shape', () => {
	test('10. one labelled field → clean item + paired dd560 frame', async () => {
		const labelId = await newLabel(`${LABEL_PREFIX}-ten`);
		const record = await newRecord();
		const report = await importMappedRecords(
			[
				{
					sectionId: record,
					fields: [{ component_tipo: IRI, values: [`${labelId}, https://a.test/10`] }],
				},
			],
			SECTION,
			await resolvePrincipal(-1),
		);
		if (report.bulkProcessId !== null) bulkProcessIds.push(report.bulkProcessId);
		expect(report.failed).toEqual([]);
		const items = await iriItems(record);
		expect(items).toHaveLength(1);
		expect(Object.hasOwn(items[0] as Item, 'label_id')).toBe(false);
		const stored = await frames(record);
		expect(stored).toHaveLength(1);
		expectEditorFrame(stored[0], labelId, items[0]?.id);
	});
});

// ---------------------------------------------------------------- personas (11, 11b)

/** This file's own persona band (explicit ids, swept after). */
const PROJECT = 949321;
const NO_LABEL_PROFILE = 949311;
const LABEL_PROFILE = 949312;
const NO_LABEL_USER = 949301;
const LABEL_USER = 949302;
const PERSONA_ROWS: { table: string; sectionTipo: string; sectionId: number }[] = [
	{ table: 'matrix_users', sectionTipo: 'dd128', sectionId: NO_LABEL_USER },
	{ table: 'matrix_users', sectionTipo: 'dd128', sectionId: LABEL_USER },
	{ table: 'matrix_profiles', sectionTipo: 'dd234', sectionId: NO_LABEL_PROFILE },
	{ table: 'matrix_profiles', sectionTipo: 'dd234', sectionId: LABEL_PROFILE },
	{ table: 'matrix_projects', sectionTipo: 'dd153', sectionId: PROJECT },
];

const personaLocator = (from: string, sectionTipo: string, sectionId: number) => ({
	id: 1,
	type: 'dd151',
	section_id: sectionId,
	section_tipo: sectionTipo,
	from_component_tipo: from,
});

/** Every tipo under a section (the grantable components), recursively. */
async function grantableTipos(sectionTipo: string): Promise<string[]> {
	const rows = (await sql.unsafe(
		`WITH RECURSIVE t AS (SELECT tipo FROM dd_ontology WHERE parent = $1
		 UNION ALL SELECT o.tipo FROM dd_ontology o JOIN t ON o.parent = t.tipo)
		 SELECT tipo FROM t`,
		[sectionTipo],
	)) as { tipo: string }[];
	return rows.map((row) => row.tipo);
}

async function sectionGrants(sectionTipo: string): Promise<Record<string, unknown>[]> {
	return [
		{ tipo: sectionTipo, section_tipo: sectionTipo, value: 2 },
		...(await grantableTipos(sectionTipo)).map((tipo) => ({
			tipo,
			section_tipo: sectionTipo,
			value: 2,
		})),
	];
}

function clearPersonaCaches(): void {
	clearPrincipalCache();
	clearUserProjectsCache();
	clearPermissionsCache();
}

async function purgePersonas(): Promise<void> {
	for (const row of PERSONA_ROWS) {
		await deleteMatrixRecord(row.table, row.sectionTipo, row.sectionId);
		await sql.unsafe(
			'DELETE FROM matrix_time_machine WHERE section_tipo = $1 AND section_id = $2',
			[row.sectionTipo, row.sectionId],
		);
	}
	clearPersonaCaches();
}

async function installPersonas(): Promise<void> {
	await assertTestDatabase('import_iri_label_native personas');
	await purgePersonas();
	const insert = (table: string, sectionTipo: string, id: number, columns: object) =>
		insertMatrixRecordWithExplicitId(
			table,
			sectionTipo,
			id,
			columns as Partial<Record<MatrixJsonbColumn, unknown>>,
		);
	await insert('matrix_projects', 'dd153', PROJECT, {
		string: { dd156: [{ id: 1, lang: 'lg-eng', value: `${LABEL_PREFIX} project` }] },
	});
	const test3Grants = await sectionGrants(SECTION);
	const labelGrants = await sectionGrants(LABEL_SECTION);
	const grantRows = (grants: Record<string, unknown>[]) =>
		grants.map((grant, index) => ({ id: index + 1, ...grant }));
	await insert('matrix_profiles', 'dd234', NO_LABEL_PROFILE, {
		string: { dd237: [{ id: 1, lang: 'lg-eng', value: 'zzilb012 no-label profile' }] },
		misc: { dd774: grantRows(test3Grants) },
	});
	await insert('matrix_profiles', 'dd234', LABEL_PROFILE, {
		string: { dd237: [{ id: 1, lang: 'lg-eng', value: 'zzilb012 label profile' }] },
		misc: { dd774: grantRows([...test3Grants, ...labelGrants]) },
	});
	for (const [user, profile] of [
		[NO_LABEL_USER, NO_LABEL_PROFILE],
		[LABEL_USER, LABEL_PROFILE],
	] as const) {
		await insert('matrix_users', 'dd128', user, {
			string: { dd132: [{ id: 1, lang: 'lg-nolan', value: `zzilb012_user_${user}` }] },
			relation: {
				dd131: [personaLocator('dd131', 'dd64', 1)],
				dd244: [personaLocator('dd244', 'dd64', 2)],
				dd515: [personaLocator('dd515', 'dd64', 2)],
				dd1725: [personaLocator('dd1725', 'dd234', profile)],
				dd170: [personaLocator('dd170', 'dd153', PROJECT)],
			},
		});
	}
	clearPersonaCaches();
}

/**
 * A test3 record filed in the personas' project (so they may write it). test3
 * is excluded from the birth project default (record_defaults.ts), so the
 * filter is written here, as the crawl persona fixture files its records.
 */
async function personaRecord(): Promise<number> {
	const id = await newRecord();
	await sql.unsafe(
		`UPDATE ${TABLE}
		 SET relation = COALESCE(relation, '{}'::jsonb) || jsonb_build_object('test101', $3::text::jsonb)
		 WHERE section_tipo = $1 AND section_id = $2`,
		[
			SECTION,
			id,
			encodeForJsonb([{ ...personaLocator('test101', 'dd153', PROJECT), type: 'dd675' }]),
		],
	);
	return id;
}

describe('the importer is asked — and the vocabulary is shared (D6b)', () => {
	beforeAll(installPersonas);
	afterAll(purgePersonas);

	test('11. an importer who may not create labels: loud refusal, the iri NOT written label-less', async () => {
		const value = `${LABEL_PREFIX}-eleven`;
		const record = await personaRecord();
		// positive control: the same persona writes an unlabelled iri
		const plain = await importCsv(
			iriCsv(record, 'https://a.test/11plain'),
			[KEY, IRI_COL()],
			NO_LABEL_USER,
		);
		expect(plain.failed).toEqual([]);
		expect(await iriItems(record)).toHaveLength(1);

		const report = await importCsv(
			iriCsv(record, `${value}, https://a.test/11`),
			[KEY, IRI_COL()],
			NO_LABEL_USER,
		);
		expect(report.failed).toHaveLength(1);
		expect(report.failed[0]?.msg).toContain('dd1706');
		expect(await labelIdsWithValue(value)).toEqual([]);
		const items = await iriItems(record);
		expect(items.map((item) => item.iri)).toEqual(['https://a.test/11plain']);
		expect(await frames(record)).toEqual([]);
	});

	test('11b. a project-scoped importer REUSES a label of another project; an unknown one is created in its project', async () => {
		const value = `${LABEL_PREFIX}-elevenb`;
		const foreign = await newLabel(value); // filed by root, not in the persona's project
		const record = await personaRecord();
		const report = await importCsv(
			iriCsv(record, `${value}, https://a.test/11b`),
			[KEY, IRI_COL()],
			LABEL_USER,
		);
		expect(report.failed).toEqual([]);
		expect(await labelIdsWithValue(value)).toEqual([foreign]);
		expectEditorFrame((await frames(record))[0], foreign, (await iriItems(record))[0]?.id);

		const fresh = `${LABEL_PREFIX}-elevenb-new`;
		const other = await personaRecord();
		const created = await importCsv(
			iriCsv(other, `${fresh}, https://a.test/11c`),
			[KEY, IRI_COL()],
			LABEL_USER,
		);
		expect(created.failed).toEqual([]);
		const ids = await labelIdsWithValue(fresh);
		expect(ids).toHaveLength(1);
		const filter = (await sql.unsafe(
			`SELECT relation->'dd1716' AS value FROM ${LABEL_TABLE} WHERE section_tipo = $1 AND section_id = $2`,
			[LABEL_SECTION, ids[0]],
		)) as { value: Item[] | null }[];
		expect((filter[0]?.value ?? []).map((locator) => Number(locator.section_id))).toContain(
			PROJECT,
		);
	});
});

describe('review fixes — exact folded lookup, one fold, the mapped door rolls back', () => {
	test('R1. 50 labels CONTAINING the word do not hide the exact one (no cap refusal)', async () => {
		const word = `${LABEL_PREFIX}word`;
		const exact = await newLabel(word);
		for (let i = 1; i <= 50; i++) await newLabel(`${word} variant ${i}`);
		const record = await newRecord();
		const report = await importCsv(iriCsv(record, `${word}, https://a.test/r1`), [KEY, IRI_COL()]);
		expect(report.failed).toEqual([]);
		expect(await labelIdsWithValue(word)).toEqual([exact]);
		expectEditorFrame((await frames(record))[0], exact, (await iriItems(record))[0]?.id);
	}, 120000);

	test('R2. ONE fold (Postgres f_unaccent): stored Øresund is reused for oresund', async () => {
		const stored = await newLabel(`Øresund-${LABEL_PREFIX}`);
		const record = await newRecord();
		const report = await importCsv(iriCsv(record, `oresund-${LABEL_PREFIX}, https://a.test/r2`), [
			KEY,
			IRI_COL(),
		]);
		expect(report.failed).toEqual([]);
		expect(await labelIdsWithValue(`oresund-${LABEL_PREFIX}`)).toEqual([]);
		expectEditorFrame((await frames(record))[0], stored, (await iriItems(record))[0]?.id);
	});

	test('R4. mapped door: a REFUSED main lang save rolls the record back — no orphan label, no frameless slice', async () => {
		const value = `${LABEL_PREFIX}-r4`;
		const record = await newRecord();
		// One lang save of the labelled field answers ok:false (a refusal the
		// engine reports instead of throwing); every other save is the real one.
		mock.module('../../src/core/section/record/save_component.ts', () => ({
			...REAL_SAVE_COMPONENT,
			saveComponentData: (request: Parameters<typeof saveComponentData>[0]) =>
				request.componentTipo === IRI && request.lang === 'lg-eng'
					? Promise.resolve({ ok: false, message: 'forced refusal (R4)', data: [] })
					: REAL_SAVE_COMPONENT.saveComponentData(request),
		}));
		const cell = JSON.stringify({
			'lg-spa': [`${value}, https://a.test/r4s`],
			'lg-eng': [`${value}, https://a.test/r4e`],
		});
		const report = await importMappedRecords(
			[{ sectionId: record, fields: [{ component_tipo: IRI, values: [cell] }] }],
			SECTION,
			await resolvePrincipal(-1),
		);
		if (report.bulkProcessId !== null) bulkProcessIds.push(report.bulkProcessId);
		expect(report.failed.some((issue) => issue.msg.includes('forced refusal (R4)'))).toBe(true);
		expect(await labelIdsWithValue(value)).toEqual([]);
		expect(await iriItems(record)).toEqual([]);
		expect(await frames(record)).toEqual([]);
	});
});

/**
 * Observe, in one ordered log, every FIRST acquisition of an advisory node
 * lock (`lock:<key>`) and every component save (`save:<tipo>`) — through the
 * real primitives (the spies only record, then delegate).
 */
function observeLocksAndSaves(): string[] {
	const log: string[] = [];
	const seen = new Set<string>();
	mock.module('../../src/core/db/postgres.ts', () => ({
		...REAL_POSTGRES,
		acquireNodeLock: (sectionTipo: string, sectionId: number | string) => {
			const key = `${sectionTipo}_${sectionId}`;
			if (!seen.has(key)) {
				seen.add(key);
				log.push(`lock:${key}`);
			}
			return REAL_POSTGRES.acquireNodeLock(sectionTipo, sectionId);
		},
	}));
	mock.module('../../src/core/section/record/save_component.ts', () => ({
		...REAL_SAVE_COMPONENT,
		saveComponentData: (request: Parameters<typeof saveComponentData>[0]) => {
			log.push(`save:${request.componentTipo}`);
			return REAL_SAVE_COMPONENT.saveComponentData(request);
		},
	}));
	return log;
}

/**
 * The RECORD's events of a log (its label locks, its own node lock, the saves
 * of its components — the run's dd800 bookkeeping is outside the record's
 * transaction): the label locks are taken FIRST, once each, in sorted order.
 */
function expectLabelLocksFirstAndSorted(
	log: readonly string[],
	record: number,
	expected: readonly string[],
): void {
	const labelLock = (entry: string): boolean => entry.startsWith(`lock:${LABEL_SECTION}_label:`);
	const recordTipos = new Set(['test52', IRI, SLOT, LABEL_VALUE]);
	const events = log.filter(
		(entry) =>
			labelLock(entry) ||
			entry === `lock:${SECTION}_${record}` ||
			recordTipos.has(entry.replace(/^save:/, '')),
	);
	const labelLocks = events.filter(labelLock);
	expect(labelLocks).toEqual(expected.map((fold) => `lock:${LABEL_SECTION}_label:${fold}`));
	expect(events.slice(0, labelLocks.length)).toEqual(labelLocks);
	expect(events.length).toBeGreaterThan(labelLocks.length);
}

describe('review fixes 2 — one whitespace rule, global lock order, full report', () => {
	test('R5. ONE whitespace rule: a stored label padded with NBSP / tab / newline is reused', async () => {
		for (const [name, pad] of [
			['nb', '\u00a0'],
			['tb', '\t'],
			['nl', '\n'],
		] as const) {
			const value = `${LABEL_PREFIX}-r5${name}`;
			const storedId = await newLabel(`${pad}${value}${pad}`);
			const record = await newRecord();
			const report = await importCsv(iriCsv(record, `${value}, https://a.test/r5${name}`), [
				KEY,
				IRI_COL(),
			]);
			expect(report.failed).toEqual([]);
			// No second (unpadded) label was created; the frame points at the stored one.
			expect(await labelIdsWithValue(value)).toEqual([]);
			expectEditorFrame((await frames(record))[0], storedId, (await iriItems(record))[0]?.id);
		}
	});

	/**
	 * ORDER, NOT A RACE: this pins the lock ORDER that makes the crossed-order
	 * deadlock impossible — every label lock of the record taken ONCE, sorted by
	 * fold, before any other lock or write of the record. It does not run two
	 * concurrent transactions (a deadlock there is timing-dependent); two
	 * concurrent rows that each take their label locks in one global sorted
	 * order, ahead of their record locks, cannot wait on each other in a cycle.
	 */
	test('R6. mapped door: labels of EVERY field locked first, once, in sorted fold order (pins order, not a race)', async () => {
		const record = await newRecord();
		const log = observeLocksAndSaves();
		const report = await importMappedRecords(
			[
				{
					sectionId: record,
					fields: [
						{ component_tipo: 'test52', values: ['r6 plain text'] },
						{ component_tipo: IRI, values: [`${LABEL_PREFIX}-r6b, https://a.test/r6b`] },
						{ component_tipo: IRI, values: [`${LABEL_PREFIX}-r6a, https://a.test/r6a`] },
					],
				},
			],
			SECTION,
			await resolvePrincipal(-1),
		);
		if (report.bulkProcessId !== null) bulkProcessIds.push(report.bulkProcessId);
		expectLabelLocksFirstAndSorted(log, record, [`${LABEL_PREFIX}-r6a`, `${LABEL_PREFIX}-r6b`]);
	});

	test("R6b. CSV door: the row's label locks come before any other lock or save of the row (pins order, not a race)", async () => {
		const record = await newRecord();
		const log = observeLocksAndSaves();
		const csv = `section_id;test52;${IRI}\n${record};r6 text;${q(`${LABEL_PREFIX}-r6c, https://a.test/r6c | ${LABEL_PREFIX}-r6d, https://a.test/r6d`)}\n`;
		const report = await importCsv(csv, [KEY, col('test52', 'component_input_text'), IRI_COL()]);
		expect(report.failed).toEqual([]);
		expectLabelLocksFirstAndSorted(log, record, [`${LABEL_PREFIX}-r6c`, `${LABEL_PREFIX}-r6d`]);
	});

	test('R7. mapped door: a rolled-back record keeps its OTHER issues in the report', async () => {
		const value = `${LABEL_PREFIX}-r7`;
		const record = await newRecord();
		mock.module('../../src/core/section/record/save_component.ts', () => ({
			...REAL_SAVE_COMPONENT,
			saveComponentData: (request: Parameters<typeof saveComponentData>[0]) =>
				request.componentTipo === IRI
					? Promise.resolve({ ok: false, message: 'forced refusal (R7)', data: [] })
					: REAL_SAVE_COMPONENT.saveComponentData(request),
		}));
		const report = await importMappedRecords(
			[
				{
					sectionId: record,
					fields: [
						// A conform refusal (a bare token, no iri) …
						{ component_tipo: IRI, values: ['5'] },
						// … then the labelled field whose save is refused (rolls back).
						{ component_tipo: IRI, values: [`${value}, https://a.test/r7`] },
					],
				},
			],
			SECTION,
			await resolvePrincipal(-1),
		);
		if (report.bulkProcessId !== null) bulkProcessIds.push(report.bulkProcessId);
		const messages = report.failed.map((issue) => issue.msg);
		expect(messages.some((msg) => msg.includes('forced refusal (R7)'))).toBe(true);
		expect(messages).toContain('IGNORED: malformed data 5');
		expect(await labelIdsWithValue(value)).toEqual([]);
	});
});
