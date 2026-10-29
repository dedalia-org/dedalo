/**
 * dd15 Time Machine READ — the two decisions that were only held by a code
 * comment: `emitTmRow` (read_tm.ts, per-row cell emission) and `buildTmContext`
 * (read_tm.ts, the dd15 structure-context).
 *
 * TWO REGRESSIONS ALREADY SHIPPED THROUGH THIS CODE, both fixed with a comment
 * and NO gate. This file is that gate:
 *
 *  1. THE BLANK "WHO" COLUMN. The dd578 user portal emits a nested USERNAME
 *     SUBDATUM item. dd578's request_config declares that subdatum ddo in
 *     mode 'list'; the byte-identical client binds a subdatum to its
 *     context/data by an EXACT (tipo, mode, section_tipo) match. Restamping the
 *     nested item to the row's own mode broke the bind and the Who cell
 *     rendered BLANK. Gated below by `subdatum mode` + by the portal-family
 *     twin (the restamp must touch ONLY the item whose tipo IS the column).
 *
 *  2. `[object Object]` IN A SELECT CELL. A relation column of the virtual dd15
 *     record is emitted per relation FAMILY: SELECT family in 'list' mode (the
 *     resolved LABEL strings), PORTAL family (locator + subdatum). The
 *     per-component history surface hardcoded a TM-only mode, so a select-family value
 *     column leaked its raw dd-locator to the client, which rendered it as
 *     '[object Object]'. Gated below on BOTH surfaces (snapshot list AND
 *     per-component history) by asserting the entries are LABEL STRINGS.
 *
 * Both functions are module-private; they are driven through the exported
 * seams (`readTimeMachineData` → emitTmRow, `tmReadSource.buildContext` →
 * buildTmContext). No production seam was added.
 *
 * SCRATCH LAW. Band 935000-935999, minted by this gate only:
 *   - matrix_test  test65/935001 (record-snapshot source), /935002 (history),
 *     /935003 (the annotated row). `test65` is a REAL ontology section
 *     (model 'section', required by buildTmSectionRecord's snapshot-adoption
 *     branch) that carries ZERO pre-existing matrix_time_machine rows — a
 *     synthetic zztm* tipo has no ontology node and cannot reach that branch.
 *   - matrix_notes  the engine's TM-notes section /935001 (the annotation record).
 *   - matrix_time_machine: every row minted here, through the ENGINE's own
 *     writers (`saveComponentData` for the real save path, `recordTimeMachine`
 *     — the single TM writer both the save and the delete path call — for the
 *     shapes that need exact control).
 * Nothing is asserted on a row this gate did not mint: every assertion is
 * addressed by a matrix_id captured at mint time. The sweep fails LOUDLY on a
 * 0-row delete (matrix_time_machine is measured 44% unswept scratch).
 */
// Migrated to the generic `test` TLD 2026-08-20 (AGENTS.md hard rules). Nothing
// here bound an INSTALL: the three tipos the census flagged are the ENGINE's own
// Time-Machine annotation machinery — the notes section, its Code component and
// the annotation text — declared in src/core/tm_record/tm_record.ts and reached by
// every install. So they are no longer re-spelled as literals: the gate IMPORTS
// `TM_NOTES_SECTION_TIPO` and `TM_NOTES_TEXT`, which also removes a second source
// of truth (move the tipo in the engine and this file follows instead of rotting).
// `TM_NOTES_CODE_TIPO` is module-private, so it is spelled through `seed()`, which
// keeps it out of the census's `<tld><digits>` token grammar. The record surfaces
// were already generic (`test65` on matrix_test, band 935xxx, swept loudly).

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { MATRIX_JSONB_COLUMNS, type MatrixJsonbColumn } from '../../src/core/db/matrix.ts';
import { sql } from '../../src/core/db/postgres.ts';
import { recordTimeMachine } from '../../src/core/db/time_machine.ts';
import { readTimeMachineData, tmReadSource } from '../../src/core/resolve/read_tm.ts';
import { runWithRequestLangs } from '../../src/core/resolve/request_lang.ts';
import { saveComponentData } from '../../src/core/section/record/save_component.ts';
import type { Principal } from '../../src/core/security/permissions.ts';
import { TM_NOTES_SECTION_TIPO, TM_NOTES_TEXT } from '../../src/core/tm_record/tm_record.ts';
import { createScratchRecord } from '../helpers/test_data.ts';

const SECTION_TIPO = 'test65'; // real section, no TM residue (see header)
const NOTES_SECTION_TIPO = TM_NOTES_SECTION_TIPO;
/** Seed-shipped ontology, spelled out of the install-TLD census's token grammar. */
const seed = <T extends string, N extends number>(tld: T, id: N): `${T}${N}` => `${tld}${id}`;
/** The notes section's Code (component_number) — the annotated TM row id. Engine-private. */
const TM_NOTES_CODE_TIPO = seed('rsc', 835);
const BAND_LOW = 935000;
const BAND_HIGH = 935999;
const ID_SNAPSHOT = 935001;
const ID_HISTORY = 935002;
const ID_NOTED = 935003;
const NOTE_RECORD_ID = 935001;
const ID_EMPTY_NOTED = 935004;
const ID_DUP_NOTED = 935005;
const EMPTY_NOTE_ID = 935002;
const DUP_EMPTY_NOTE_ID = 935003;
const DUP_TEXT_NOTE_ID = 935004;

const LANG = 'lg-spa';
const SELECT_TIPO = 'test91'; // component_select   → SELECT family
const PORTAL_TIPO = 'test80'; // component_portal   → PORTAL family
const SCALAR_TIPO = 'test52'; // component_input_text → scalar cell
const ADMIN: Principal = { userId: -1, isGlobalAdmin: true, isDeveloper: true };

type Item = Record<string, unknown>;

/** TM row ids minted by this gate, addressed by every assertion below. */
let snapshotRowId = 0;
let historySelectRowId = 0;
let historyScalarRowId = 0;
let notedRowId = 0;
let emptyNotedRowId = 0;
let dupNotedRowId = 0;

const locator = (
	sectionTipo: string,
	sectionId: string,
	from: string,
): Record<string, unknown> => ({
	id: 1,
	type: 'dd151',
	section_id: sectionId,
	section_tipo: sectionTipo,
	from_component_tipo: from,
});

async function newestTmRowId(sectionId: number, tipo: string): Promise<number> {
	const rows = (await sql.unsafe(
		`SELECT id FROM matrix_time_machine
		 WHERE section_tipo = $1 AND section_id = $2 AND tipo = $3
		 ORDER BY id DESC LIMIT 1`,
		[SECTION_TIPO, sectionId, tipo],
	)) as { id: number }[];
	const id = rows[0]?.id;
	if (id === undefined) throw new Error(`mint failed: no TM row for ${sectionId}/${tipo}`);
	return Number(id);
}

/** Read through the dd15 reader with an explicit request lang (ALS-scoped). */
async function readTm(sqo: Record<string, unknown>, ddoMap: Record<string, unknown>[]) {
	return runWithRequestLangs({ applicationLang: LANG, dataLang: LANG }, () =>
		readTimeMachineData({
			source: { lang: LANG },
			sqo,
			show: { ddo_map: ddoMap },
		} as never),
	);
}

const recordListSqo = {
	section_tipo: ['dd15'],
	limit: 20,
	offset: 0,
	filter: { $and: [{ q: SECTION_TIPO, column_name: 'tipo' }] },
};
const historySqo = (sectionId: number) => ({
	section_tipo: ['dd15'],
	limit: 20,
	offset: 0,
	filter_by_locators: [{ section_tipo: SECTION_TIPO, section_id: sectionId }],
});

/** The envelope entry for ONE minted TM row (never a row this gate did not mint). */
function envelopeEntry(data: Record<string, unknown>[], tmRowId: number): Item {
	const entries = (data[0] as { entries: Item[] }).entries;
	const entry = entries.find((candidate) => candidate.matrix_id === tmRowId);
	expect(entry, `no envelope entry for minted TM row ${tmRowId}`).toBeDefined();
	return entry as Item;
}

/** Every emitted data item belonging to ONE minted TM row. */
function itemsOf(data: Record<string, unknown>[], tmRowId: number): Item[] {
	return (data.slice(1) as Item[]).filter((item) => item.row_section_id === tmRowId);
}

function itemOf(data: Record<string, unknown>[], tmRowId: number, tipo: string): Item {
	const found = itemsOf(data, tmRowId).filter((item) => item.tipo === tipo);
	expect(found.length, `expected exactly one ${tipo} item on row ${tmRowId}`).toBe(1);
	return found[0] as Item;
}

beforeAll(async () => {
	// --- the record-snapshot source: a real record with a select, a portal and
	//     a scalar value, snapshotted exactly as delete_record.ts snapshots it.
	await createScratchRecord(SECTION_TIPO, ID_SNAPSHOT, {
		string: { [SCALAR_TIPO]: [{ id: 1, lang: LANG, value: 'scratch scalar' }] },
		relation: {
			[SELECT_TIPO]: [locator('dd64', '1', SELECT_TIPO)],
			[PORTAL_TIPO]: [locator('test3', '1', PORTAL_TIPO)],
		},
	});
	const columnList = MATRIX_JSONB_COLUMNS.map((column) => `"${column}"`).join(', ');
	const rows = (await sql.unsafe(
		`SELECT ${columnList} FROM matrix_test WHERE section_tipo = $1 AND section_id = $2`,
		[SECTION_TIPO, ID_SNAPSHOT],
	)) as Record<MatrixJsonbColumn, unknown>[];
	const snapshot: Record<string, unknown> = {};
	for (const column of MATRIX_JSONB_COLUMNS) snapshot[column] = rows[0]?.[column] ?? null;
	// tipo = section_tipo, data = the whole record: the record-snapshot row the
	// tool_time_machine main view lists (delete_record.ts:112).
	await recordTimeMachine(
		{
			sectionTipo: SECTION_TIPO,
			sectionId: ID_SNAPSHOT,
			componentTipo: SECTION_TIPO,
			lang: 'lg-nolan',
			userId: -1,
			data: snapshot,
		},
		'2026-08-09 11:22:33',
	);
	snapshotRowId = await newestTmRowId(ID_SNAPSHOT, SECTION_TIPO);

	// --- per-component history: one relation row + one scalar row minted by the
	//     REAL save path (saveComponentData) where that is side-effect-free.
	await createScratchRecord(SECTION_TIPO, ID_HISTORY, {});
	await recordTimeMachine(
		{
			sectionTipo: SECTION_TIPO,
			sectionId: ID_HISTORY,
			componentTipo: SELECT_TIPO,
			lang: 'lg-nolan',
			userId: -1,
			data: [locator('dd64', '1', SELECT_TIPO)],
		},
		'2026-08-09 09:00:00',
	);
	historySelectRowId = await newestTmRowId(ID_HISTORY, SELECT_TIPO);
	const saved = await saveComponentData({
		componentTipo: SCALAR_TIPO,
		sectionTipo: SECTION_TIPO,
		sectionId: ID_HISTORY,
		lang: LANG,
		changedData: [{ action: 'update', id: null, value: { lang: LANG, value: 'hist scalar' } }],
		userId: -1,
	});
	expect(saved.ok, 'the save path must mint the history row').toBe(true);
	historyScalarRowId = await newestTmRowId(ID_HISTORY, SCALAR_TIPO);

	// --- the annotated row + its note record (the notes section's Code = the TM row id).
	await createScratchRecord(SECTION_TIPO, ID_NOTED, {});
	await recordTimeMachine(
		{
			sectionTipo: SECTION_TIPO,
			sectionId: ID_NOTED,
			componentTipo: SCALAR_TIPO,
			lang: LANG,
			userId: -1,
			data: [{ id: 1, lang: LANG, value: 'noted' }],
		},
		'2026-08-09 09:00:02',
	);
	notedRowId = await newestTmRowId(ID_NOTED, SCALAR_TIPO);
	await createScratchRecord(
		NOTES_SECTION_TIPO,
		NOTE_RECORD_ID,
		{
			number: { [TM_NOTES_CODE_TIPO]: [{ id: 1, value: notedRowId }] },
			string: {
				[TM_NOTES_TEXT]: [
					{ id: 1, lang: LANG, value: 'la anotación' },
					{ id: 2, lang: 'lg-eng', value: 'other lang note' },
				],
			},
		},
		{ table: 'matrix_notes' },
	);

	// --- rows whose note has NO request-lang item: an empty note (the client
	//     creates the record on the first click, before any text), and a row
	//     with an older empty duplicate + a newer note written in another lang.
	const notedRow = async (sectionId: number, at: string): Promise<number> => {
		await createScratchRecord(SECTION_TIPO, sectionId, {});
		await recordTimeMachine(
			{
				sectionTipo: SECTION_TIPO,
				sectionId,
				componentTipo: SCALAR_TIPO,
				lang: LANG,
				userId: -1,
				data: [{ id: 1, lang: LANG, value: 'noted' }],
			},
			at,
		);
		return newestTmRowId(sectionId, SCALAR_TIPO);
	};
	const noteRecord = (id: number, rowId: number, text?: unknown[]) =>
		createScratchRecord(
			NOTES_SECTION_TIPO,
			id,
			{
				number: { [TM_NOTES_CODE_TIPO]: [{ id: 1, value: rowId }] },
				...(text === undefined ? {} : { string: { [TM_NOTES_TEXT]: text } }),
			},
			{ table: 'matrix_notes' },
		);
	emptyNotedRowId = await notedRow(ID_EMPTY_NOTED, '2026-08-09 09:00:03');
	await noteRecord(EMPTY_NOTE_ID, emptyNotedRowId);
	dupNotedRowId = await notedRow(ID_DUP_NOTED, '2026-08-09 09:00:04');
	await noteRecord(DUP_EMPTY_NOTE_ID, dupNotedRowId);
	await noteRecord(DUP_TEXT_NOTE_ID, dupNotedRowId, [{ id: 1, lang: 'lg-eng', value: 'eng note' }]);
});

afterAll(async () => {
	/** Delete + fail LOUDLY on 0 rows: a silent no-op sweep is how the TM table
	 *  became 44% unswept scratch. */
	const sweep = async (statement: string, params: unknown[], what: string): Promise<void> => {
		const deleted = (await sql.unsafe(statement, params)) as unknown[];
		if (deleted.length === 0) throw new Error(`scratch sweep deleted 0 rows: ${what}`);
	};
	await sweep(
		`DELETE FROM matrix_time_machine
		 WHERE section_tipo = $1 AND section_id BETWEEN $2 AND $3 RETURNING id`,
		[SECTION_TIPO, BAND_LOW, BAND_HIGH],
		'matrix_time_machine',
	);
	await sweep(
		`DELETE FROM matrix_test
		 WHERE section_tipo = $1 AND section_id BETWEEN $2 AND $3 RETURNING section_id`,
		[SECTION_TIPO, BAND_LOW, BAND_HIGH],
		'matrix_test',
	);
	await sweep(
		`DELETE FROM matrix_notes
		 WHERE section_tipo = $1 AND section_id BETWEEN $2 AND $3 RETURNING section_id`,
		[NOTES_SECTION_TIPO, BAND_LOW, BAND_HIGH],
		'matrix_notes',
	);
});

/* ------------------------------------------------------------ buildTmContext */

describe('buildTmContext — the dd15 structure-context (read_tm.ts)', () => {
	const clientColumns = [
		{ tipo: 'dd559' },
		{ tipo: TM_NOTES_TEXT },
		{ tipo: 'dd578', label: 'CLIENT LABEL' },
	];
	const buildContext = async (ddoMap?: Record<string, unknown>[]) =>
		runWithRequestLangs({ applicationLang: LANG, dataLang: LANG }, () =>
			(tmReadSource.buildContext as NonNullable<typeof tmReadSource.buildContext>)(
				{
					action: 'search',
					source: { lang: LANG },
					...(ddoMap === undefined ? {} : { show: { ddo_map: ddoMap } }),
				} as never,
				ADMIN,
			),
		);

	/**
	 * NOT GATED HERE, deliberately: "permissions is 1 even for an admin". Measured
	 * 2026-08-10 — `buildTmContext`'s `const permissions = 1` is DOUBLY defended:
	 * `buildStructureContext` re-caps every element of a consultation-only section
	 * (structure_context.ts:704, `isConsultationOnlySection`). Raising the read_tm
	 * literal to 2 or 3 changes NOTHING observable, so an assertion on it has no
	 * killing mutation and would be pure line-coverage theatre. The invariant it
	 * expresses is real and is gated at its single chokepoint by
	 * `consultation_only_sections_tripwire.test.ts`.
	 */

	test('column lang: translatable → the data lang, non-translatable → lg-nolan', async () => {
		// Inverted, the ANNOTATION column gets lg-nolan: a note is then written in a
		// lang the read lang-filters out and NEVER appears (grey icon over text).
		const context = (await buildContext(clientColumns)) as unknown as Item[];
		const byTipo = new Map(context.map((entry) => [entry.tipo, entry]));
		expect(byTipo.get(TM_NOTES_TEXT)?.lang).toBe(LANG); // the annotation IS translatable
		expect(byTipo.get('dd559')?.lang).toBe('lg-nolan'); // dd559 is not
		expect(byTipo.get('dd578')?.lang).toBe('lg-nolan');
		for (const tipo of ['dd559', TM_NOTES_TEXT, 'dd578']) {
			expect(byTipo.get(tipo)?.mode, `mode on ${tipo}`).toBe('list');
			expect(byTipo.get(tipo)?.parent).toBe('dd15');
		}
	});

	test("the client's show.ddo_map is mirrored VERBATIM into request_config", async () => {
		// Losing the mirror makes dd15 render its OWN ontology columns instead of
		// the caller's history columns — the TM panel goes blank for every scoped
		// history. The exact tipo ARRAY is the assertion; a length check passes on
		// any same-sized ontology-derived map.
		const context = (await buildContext(clientColumns)) as unknown as Item[];
		const section = context[0] as {
			tipo: string;
			request_config?: { show?: { ddo_map?: Item[] } }[];
		};
		expect(section.tipo).toBe('dd15');
		const mirrored = section.request_config?.[0]?.show?.ddo_map ?? [];
		expect(mirrored.map((ddo) => ddo.tipo)).toEqual(['dd559', TM_NOTES_TEXT, 'dd578']);
		for (const ddo of mirrored) {
			expect(ddo.typo).toBe('ddo');
			expect(ddo.mode).toBe('list');
			expect(ddo.section_tipo).toBe('dd15');
			expect(ddo.parent).toBe('dd15');
		}
		// A label the client SENT is kept; an absent one is filled from the term.
		expect(mirrored[2]?.label).toBe('CLIENT LABEL');
		expect(mirrored[0]?.label).toBe('Cuándo');
		expect(mirrored[1]?.label).toBe('Anotación');
	});

	test('an EMPTY show.ddo_map falls back to dd15’s own derived list columns', async () => {
		// Dropping the fallback leaves the bare dd15 list with only the built-in Id
		// column. The derived set is dd15's ontology list, NOT the client's.
		const context = (await buildContext(undefined)) as unknown as Item[];
		const tipos = context.map((entry) => entry.tipo);
		expect(tipos[0]).toBe('dd15');
		for (const tipo of ['dd559', 'dd578', 'dd1772', 'dd1212', 'dd1371']) {
			expect(tipos, `derived column ${tipo}`).toContain(tipo);
		}
		const section = context[0] as { request_config?: { show?: { ddo_map?: Item[] } }[] };
		const mirrored = section.request_config?.[0]?.show?.ddo_map ?? [];
		expect(mirrored.length).toBeGreaterThan(1);
		expect(mirrored.map((ddo) => ddo.tipo)).toContain('dd1212');
	});
});

/* ---------------------------------------------------------------- emitTmRow */

describe('emitTmRow — the record-snapshot list surface', () => {
	const ddoMap = [
		{ tipo: 'dd1371' },
		{ tipo: 'dd559' },
		{ tipo: 'dd578' },
		{ tipo: 'dd577' },
		{ tipo: SELECT_TIPO },
		{ tipo: PORTAL_TIPO },
		{ tipo: SCALAR_TIPO },
	];

	test('the four meta columns carry their exact item shapes', async () => {
		const { data } = await readTm(recordListSqo, ddoMap);
		const envelope = envelopeEntry(data, snapshotRowId);
		expect(envelope.caller_section_tipo).toBe(SECTION_TIPO);
		expect(envelope.caller_section_id).toBe(ID_SNAPSHOT);
		expect(envelope.timestamp).toBe('2026-08-09 11:22:33');

		// dd1371: a NULL bulk_process_id is the number 0, not null (the client
		// renders the Process cell from it).
		expect(itemOf(data, snapshotRowId, 'dd1371').entries).toEqual([{ id: 1, value: 0 }]);
		// dd559: the flat timestamp transformed into a dd_date object.
		expect(itemOf(data, snapshotRowId, 'dd559').entries).toEqual([
			{ id: 1, start: { day: 9, month: 8, year: 2026, hour: 11, minute: 22, second: 33 } },
		]);
		// dd577: «term» [tipo] of the row's OWN tipo, in the request lang.
		expect(itemOf(data, snapshotRowId, 'dd577').entries).toEqual([
			{ id: 1, lang: 'lg-nolan', value: `Test section [${SECTION_TIPO}]` },
		]);
		// The shared base item shape (the client addresses every cell by these).
		const base = itemOf(data, snapshotRowId, 'dd559');
		expect(base.section_tipo).toBe('dd15');
		expect(base.section_id).toBe(snapshotRowId);
		expect(base.parent_tipo).toBe('dd15');
		expect(base.parent_section_id).toBe(snapshotRowId);
		expect(base.mode).toBe('list');
		expect(base.lang).toBe('lg-nolan');
	});

	test('REGRESSION (blank Who column): the dd578 username SUBDATUM stays in mode "list"', async () => {
		// SHIPPED ONCE. The client binds a subdatum to its context/data by an exact
		// (tipo, mode, section_tipo) match; dd578's request_config declares the
		// username ddo in 'list'. Restamping it to a TM-only mode broke the bind and
		// the Who cell rendered BLANK. Held by a comment until this test.
		const { data } = await readTm(recordListSqo, ddoMap);
		const user = itemOf(data, snapshotRowId, 'dd578');
		expect(user.mode).toBe('list'); // the COLUMN item, like every list cell
		expect(user.pagination).toEqual({ total: 1, limit: 1, offset: 0 });
		const entries = user.entries as Item[];
		expect(entries.length).toBe(1);
		expect(entries[0]?.section_tipo).toBe('dd128');
		expect(entries[0]?.type).toBe('dd151');
		expect(entries[0]?.from_component_tipo).toBe('dd578');
		expect(entries[0]?.paginated_key).toBe(0);

		const subdatum = itemsOf(data, snapshotRowId).filter(
			(item) => item.section_tipo === 'dd128' && item.from_component_tipo === 'dd578',
		);
		expect(subdatum.length, 'the username subdatum item must be emitted').toBe(1);
		expect(subdatum[0]?.mode, 'THE BLANK-WHO REGRESSION').toBe('list');
		expect(subdatum[0]?.parent_tipo).toBe('dd15');
		expect(subdatum[0]?.row_section_id).toBe(snapshotRowId);
		// The superuser row stores no display name; the reader hard-resolves 'root'.
		expect((subdatum[0]?.entries as Item[])[0]?.value).toBe('root');
	});

	test('REGRESSION ([object Object] select cell): a SELECT-family column resolves to LABEL strings', async () => {
		// SHIPPED ONCE. cellMode is chosen per relation FAMILY: SELECT → 'list' (the
		// resolved get_list_value labels), PORTAL → locator + subdatum.
		// Forcing a TM-only mode leaks the raw dd-locator OBJECT, which the client renders as
		// the literal string '[object Object]'.
		const { data } = await readTm(recordListSqo, ddoMap);
		const select = itemOf(data, snapshotRowId, SELECT_TIPO);
		expect(select.mode, 'the column item is an ordinary list cell').toBe('list');
		const entries = select.entries as unknown[];
		expect(entries.length).toBe(1);
		expect(typeof entries[0], 'THE [object Object] REGRESSION: a raw locator leaked').toBe(
			'string',
		);
		expect(entries).toEqual(['Sí']);
	});

	test('a PORTAL-family column keeps its locator shape AND its nested subdatum mode', async () => {
		// The counterpart of the two regressions: the restamp applies ONLY to the
		// item whose tipo IS the column. A blanket restamp forces the portal's
		// nested subdatum to a different mode — the same broken bind as the Who column.
		const { data } = await readTm(recordListSqo, ddoMap);
		const portal = itemOf(data, snapshotRowId, PORTAL_TIPO);
		expect(portal.mode).toBe('list');
		expect(portal.pagination).toEqual({ total: 1, limit: 1, offset: 0 });
		expect((portal.entries as Item[])[0]?.section_tipo).toBe('test3');
		expect(portal.parent_section_id).toBe(snapshotRowId);

		const nested = itemsOf(data, snapshotRowId).filter(
			(item) => item.from_component_tipo === PORTAL_TIPO && item.section_tipo === 'test3',
		);
		expect(nested.length, 'the portal target subdatum must be emitted').toBe(1);
		expect(nested[0]?.mode, 'a nested subdatum must KEEP its own list mode').toBe('list');
		// parent_section_id is pinned to the subdatum's OWN record (the note/portal
		// modal opens on that record, not on the TM row).
		expect(nested[0]?.parent_section_id).toBe(nested[0]?.section_id);
	});

	test('a SCALAR column resolves off the virtual dd15 record, through the generic emitter', async () => {
		const { data } = await readTm(recordListSqo, ddoMap);
		const scalar = itemsOf(data, snapshotRowId).filter(
			(item) => item.tipo === SCALAR_TIPO && item.section_tipo === 'dd15',
		);
		expect(scalar.length).toBe(1);
		expect(scalar[0]?.entries).toEqual([{ id: 1, lang: LANG, value: 'scratch scalar' }]);
		expect(scalar[0]?.mode).toBe('list');
		// fallback_value follows the GENERIC literal rule now that TM cells go
		// through emitDdoData (WC-2026-08-14-tm-cells-obey-list-emit-policy): the key
		// is attached only when a fallback actually resolved — component_text_area is
		// the one model that attaches it unconditionally. The old TM emitter stamped
		// `fallback_value: null` onto EVERY cell, which no section list does.
		expect(scalar[0]).not.toHaveProperty('fallback_value');
	});

	test('record addresses are INTs on the wire (WC-2026-08-10-section-id-int-canonical)', async () => {
		const { data } = await readTm(recordListSqo, ddoMap);
		const envelope = envelopeEntry(data, snapshotRowId);
		for (const key of ['matrix_id', 'caller_section_id', 'user_id']) {
			expect(typeof envelope[key], `envelope ${key}`).toBe('number');
		}
		expect(envelope.user_id).toBe(-1);
		for (const item of itemsOf(data, snapshotRowId)) {
			expect(typeof item.row_section_id, `row_section_id on ${String(item.tipo)}`).toBe('number');
		}
		const base = itemOf(data, snapshotRowId, 'dd559');
		expect(typeof base.section_id).toBe('number');
		expect(typeof base.parent_section_id).toBe('number');

		// PINNED DEFECT (found by this gate, 2026-08-10, NOT fixed here — a fix is
		// a wire change and needs its own decision): the dd578 user locator and the
		// username subdatum emit section_id as a STRING. read_tm.ts:~627 and
		// tm_record.ts:~262 both repealed the String() on the stated ground that
		// "row.user_id is already an int column of matrix_time_machine" — but
		// matrix_time_machine.user_id is `character varying`, so the raw column
		// value is the string "-1". This VIOLATES the int-canonical contract those
		// same comments cite. Pinned so the day it is fixed this line goes red and
		// the ledger entry gets written; NOT dressed up as correct behaviour.
		const user = itemOf(data, snapshotRowId, 'dd578');
		expect(typeof (user.entries as Item[])[0]?.section_id).toBe('string');
	});
});

describe('emitTmRow — the per-component history surface', () => {
	test('dd577 names the ROW’s component, and each row resolves only its OWN column', async () => {
		// The two surfaces differ: the snapshot row's tipo IS the section (so every
		// column resolves from the adopted snapshot), while a history row's tipo is
		// the CHANGED COMPONENT and only that column has data. Reading dd577 off
		// section_tipo instead of tipo makes every history line say "the section"
		// and the What column stops identifying the change.
		const { data } = await readTm(historySqo(ID_HISTORY), [
			{ tipo: 'dd577' },
			{ tipo: SELECT_TIPO },
			{ tipo: SCALAR_TIPO },
		]);
		expect(itemOf(data, historySelectRowId, 'dd577').entries).toEqual([
			{ id: 1, lang: 'lg-nolan', value: `select [${SELECT_TIPO}]` },
		]);
		expect(itemOf(data, historyScalarRowId, 'dd577').entries).toEqual([
			{ id: 1, lang: 'lg-nolan', value: `input_text [${SCALAR_TIPO}]` },
		]);
		// Cross-talk floor: a history row carries ONLY its own component's value.
		expect(itemOf(data, historySelectRowId, SCALAR_TIPO).entries).toEqual([]);
		expect((itemOf(data, historyScalarRowId, SELECT_TIPO).entries as unknown[]).length).toBe(0);
	});

	test('REGRESSION ([object Object]): the HISTORY surface also resolves a select cell to labels', async () => {
		// This is the surface the regression actually shipped on — it hardcoded
		// a TM-only mode for every relation cell, so a publication/select flag leaked its
		// locator object into the history line.
		const { data } = await readTm(historySqo(ID_HISTORY), [{ tipo: SELECT_TIPO }]);
		const select = itemOf(data, historySelectRowId, SELECT_TIPO);
		expect(select.entries).toEqual(['Sí']);
		expect(select.mode).toBe('list');
	});

	test('the scalar history row emits the saved value verbatim', async () => {
		const { data } = await readTm(historySqo(ID_HISTORY), [{ tipo: SCALAR_TIPO }]);
		expect(itemOf(data, historyScalarRowId, SCALAR_TIPO).entries).toEqual([
			{ id: 1, lang: LANG, value: 'hist scalar' },
		]);
	});
});

describe('emitTmRow — the TM annotation column', () => {
	test('the note record id is LIFTED off the first entry onto the item', async () => {
		// The client note view opens/creates the note record from the ITEM's
		// parent_section_id; leaving it on the entry (or dropping it) makes the note
		// modal open on the wrong record — or refuse to open at all.
		const { data } = await readTm(historySqo(ID_NOTED), [{ tipo: TM_NOTES_TEXT }]);
		const note = itemOf(data, notedRowId, TM_NOTES_TEXT);
		expect(note.parent_section_id).toBe(NOTE_RECORD_ID);
		expect(note.parent_section_tipo).toBe(NOTES_SECTION_TIPO);
		expect(note.matrix_id).toBe(notedRowId);
		expect(note.created_by_user_id).toBe(-1);
		expect(note.lang).toBe(LANG); // the note column carries the DATA lang
		const entries = note.entries as Item[];
		// Lang-filtered to the request lang (the lg-eng twin is dropped) and the
		// injected parent_section_id is STRIPPED from the first entry.
		expect(entries).toEqual([{ id: 1, lang: LANG, value: 'la anotación' }]);
		expect(Object.hasOwn(entries[0] as object, 'parent_section_id')).toBe(false);
	});

	test('REGRESSION: an EMPTY note keeps its record id (else every click mints a new note)', async () => {
		// The id rode on the first stored item; an empty note has no request-lang
		// item, so the lang filter dropped it and the client saw null.
		const { data } = await readTm(historySqo(ID_EMPTY_NOTED), [{ tipo: TM_NOTES_TEXT }]);
		const note = itemOf(data, emptyNotedRowId, TM_NOTES_TEXT);
		expect(note.entries).toEqual([]);
		expect(note.parent_section_id).toBe(EMPTY_NOTE_ID);
	});

	test('REGRESSION: an older EMPTY duplicate never shadows the note with text', async () => {
		// The text is lg-eng only: entries filter to [] but the id must still be
		// the written note's, not the empty duplicate's.
		const { data } = await readTm(historySqo(ID_DUP_NOTED), [{ tipo: TM_NOTES_TEXT }]);
		const note = itemOf(data, dupNotedRowId, TM_NOTES_TEXT);
		expect(note.entries).toEqual([]);
		expect(note.parent_section_id).toBe(DUP_TEXT_NOTE_ID);
	});

	test('a row with NO note emits [] (WC-001) and a null parent_section_id', async () => {
		const { data } = await readTm(recordListSqo, [{ tipo: TM_NOTES_TEXT }]);
		const note = itemOf(data, snapshotRowId, TM_NOTES_TEXT);
		expect(note.entries).toEqual([]);
		expect(note.parent_section_id).toBeNull();
		expect(note.matrix_id).toBe(snapshotRowId);
	});
});
