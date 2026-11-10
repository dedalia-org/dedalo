/**
 * A TIME-MACHINE RESTORE MUST NOT DELETE THE LANGUAGES IT DID NOT RESTORE
 * (audit 2026-08-26 DATA-03, S1 — WC-2026-08-27-tm-lang-slice-restore-merge).
 *
 * A lang-sliced component's TM row is NOT the component's value: it is the
 * EFFECTIVE-LANGUAGE SLICE of it (`save_component.ts:1231-1238` filters
 * `item.lang === effectiveLang`, PHP get_data_lang parity). `apply_value` wrote
 * that slice as the WHOLE component key, so restoring the Spanish version of a
 * trilingual literal DELETED the Basque and the English value — with `ok:true`,
 * no notice, and a fresh TM row carrying only the restored slice, so the loss
 * was invisible even in the history the restore itself created. Sequential
 * per-language restores ping-ponged: the tool structurally could not reassemble
 * a multilingual value.
 *
 * THE INVARIANTS THIS FILE GATES, stated once and asserted mechanically below:
 *   1. a restore of ONE language leaves every OTHER language BYTE-IDENTICAL
 *      (compared as stored jsonb text, not as re-serialized JS objects);
 *   2. ONE TM ROW IS ONE LANGUAGE: the row the restore writes is tagged with the
 *      language the RESTORED ROW speaks for and carries ONLY that language's
 *      items — the same slice `save_component.ts:1231-1238` writes for the same
 *      write. Every consumer of the table reads a row that way (the dd15 list
 *      filters by lang, both restore doors decide what they may replace from the
 *      row's own items), so a multi-language row under a single-language tag
 *      reverted languages the operator never selected. The ROW's language, not
 *      the REQUEST's: the server does not validate `options.lang` against
 *      `tmRow.lang`, and when they differ the request lang files the restore in
 *      the timeline of a language it did not touch;
 *   2b. the merged key keeps the array ORDER `save_component.ts` writes a
 *      lang-sliced save in — survivors first (in their stored order), restored
 *      items last. The restore must not invent a second array shape for a
 *      component the save path already shapes;
 *   3. restoring language B after language A keeps A — no ping-pong, and that
 *      holds for a row THIS DOOR wrote as well as for one the save path wrote;
 *   4. an EMPTY slice snapshot still clears exactly ONE language — and so does
 *      one that is not an item array at all (SQL NULL, a bare scalar), which
 *      must never fall back to replacing the whole key;
 *   5. a component the write engine does NOT slice by language is still
 *      replaced WHOLE — the merge must not resurrect items a later save removed;
 *   6. the destructive client action is CONFIRMED, the confirmation names what
 *      it overwrites, and the sentence it states is TRANSLATED (register.json)
 *      rather than English-only;
 *   7. BOTH restore doors obey the law (REMEDIATION P0-4 covers `apply_value`
 *      and `bulk_revert_process`): the bulk door merges through the same
 *      exported helpers, and reverting one language's batch write leaves the
 *      other languages standing.
 *
 * WHY THE FOUR PRE-EXISTING TM GATES COULD NOT CATCH IT — re-read and
 * re-verified 2026-08-27, not assumed: none of them ever holds a MULTILINGUAL
 * value. `tm_section_restore` and `delete_record_tm_native` are `lg-nolan`;
 * `tm_dataframe_restore_native`'s main is `test6836`, a component_portal, which
 * the write engine does not slice by language at all; `tm_bulk_revert`'s
 * component `testmint1002` IS ontology-translatable and lang-sliced (checked
 * against the suite ontology, not inferred from its name), but every record it
 * builds carries exactly ONE language, `lg-spa` — so the merge degenerates to
 * the replace that door always performed and the deletion has nothing to
 * delete. Both files still pass unchanged (27 tests together, measured
 * 2026-08-27).
 *
 * Scratch hygiene: the gate BUILDS its own ontology in the reserved `zztmlang`
 * TLD (a section on `matrix_test` + the three components whose ontology drives
 * each branch) and creates every record at runtime through the engine's own
 * write path. Nothing the archive holds is read or touched; teardown asserts a
 * ZERO residue and sweeps the dd542 activity rows the restore appends.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { sql } from '../../src/core/db/postgres.ts';
import {
	getColumnNameByModel,
	getMatrixTableFromTipo,
	getModelByTipo,
	getTranslatableByTipo,
} from '../../src/core/ontology/resolver.ts';
import { createSectionRecord } from '../../src/core/section/record/create_record.ts';
import { deleteSectionRecord } from '../../src/core/section/record/delete_record.ts';
import {
	isLangSlicedModel,
	saveComponentData,
} from '../../src/core/section/record/save_component.ts';
import { resolvePrincipal } from '../../src/core/security/permissions.ts';
import {
	dropSituation,
	ensureSituation,
	situation,
} from '../../src/core/test_data/situations/situation.ts';
import { toolTimeMachineBulkRevert } from '../../tools/tool_time_machine/server/bulk_revert.ts';
import { toolTimeMachineApplyValue } from '../../tools/tool_time_machine/server/tool_time_machine.ts';

const SECTION = 'zztmlang1';
/** input_text, ontology-TRANSLATABLE → one item per language in the `string` column. */
const TRANSLATABLE = 'zztmlang2';
/** input_text, ontology-NON-translatable → lang-sliced all the same, on `lg-nolan`. */
const NOLAN = 'zztmlang3';
/** number — its CLASS does not support translation, so its TM row is the whole value. */
const UNSLICED = 'zztmlang4';

/**
 * Where the scratch records live. Stated here and PROVEN in beforeAll: the
 * situation's section carries the `test24` matrix_table node, and a gate that
 * merely assumed it would read and sweep the installation's own table.
 */
const TABLE = 'matrix_test';

const SITUATION = situation({
	tld: 'zztmlang',
	name: 'tm_lang_slice_restore',
	nodes: [
		{
			tipo: SECTION,
			parent: 'test1',
			model: 'section',
			term: { 'lg-spa': 'Restauración por idioma', 'lg-eng': 'Lang slice restore' },
			relations: [{ tipo: 'test24' }],
		},
		{
			tipo: TRANSLATABLE,
			parent: SECTION,
			model: 'component_input_text',
			is_translatable: true,
			term: { 'lg-spa': 'Título', 'lg-eng': 'Title' },
		},
		{
			tipo: NOLAN,
			parent: SECTION,
			model: 'component_input_text',
			is_translatable: false,
			// Plain NON-translatable: every save is addressed on lg-nolan whatever
			// the request lang (resolver.ts effectiveSaveLang). NOT
			// `with_lang_versions` — a transliterable component keeps the request
			// lang (PHP component_common :666-678; tm_save_order_native).
			term: { 'lg-spa': 'Signatura', 'lg-eng': 'Shelf mark' },
		},
		{
			tipo: UNSLICED,
			parent: SECTION,
			model: 'component_number',
			term: { 'lg-spa': 'Orden', 'lg-eng': 'Order' },
		},
	],
});

async function context(options: Record<string, unknown>) {
	return {
		principal: await resolvePrincipal(-1),
		userId: -1,
		options,
		background: false,
	};
}

/** One component save through the ENGINE's own write path (never raw SQL). */
async function save(
	tipo: string,
	sectionId: number,
	lang: string,
	changedData: { action: string; id?: number; key?: number | null; value: unknown }[],
	bulkProcessId?: number,
): Promise<void> {
	const result = await saveComponentData({
		componentTipo: tipo,
		sectionTipo: SECTION,
		sectionId,
		lang,
		changedData,
		userId: -1,
		bulkProcessId,
	});
	expect(result.ok).toBe(true);
}

/** Insert the FIRST item of a language slice (`key:0` shares the sibling languages' item id). */
const insertFirst = (value: string | number) => [{ action: 'insert', key: 0, value: { value } }];
/** Rewrite the slice's item in place, the shape the edit form sends. */
const updateItem = (id: number, value: string | number) => [
	{ action: 'update', id, value: { id, value } },
];

/**
 * The component's items AS STORED, each one's canonical jsonb text beside the
 * parsed object. The TEXT is what invariant 1 is asserted on: re-serializing a
 * parsed object in JS would compare what this test built, not what Postgres
 * holds.
 */
async function storedItems(
	sectionId: number,
	column: string,
	tipo: string,
): Promise<{ text: string; item: { id?: number; lang?: string; value?: unknown } }[]> {
	const rows = (await sql.unsafe(
		`SELECT element::text AS text, element AS item
		 FROM "${TABLE}",
		      LATERAL jsonb_array_elements(COALESCE("${column}"->$3, '[]'::jsonb)) AS element
		 WHERE section_tipo = $1 AND section_id = $2`,
		[SECTION, sectionId, tipo],
	)) as { text: string; item: { id?: number; lang?: string; value?: unknown } }[];
	return rows;
}

/** lang → the item's stored jsonb text (the byte-identity witness). */
async function textByLang(
	sectionId: number,
	column: string,
	tipo: string,
): Promise<Record<string, string>> {
	const byLang: Record<string, string> = {};
	for (const row of await storedItems(sectionId, column, tipo)) {
		byLang[String(row.item.lang)] = row.text;
	}
	return byLang;
}

/** Every TM row of one component on one record, oldest first. */
async function tmRows(
	sectionId: number,
	tipo: string,
): Promise<{ id: number; lang: string | null; data: unknown }[]> {
	return (await sql.unsafe(
		`SELECT id, lang, data FROM matrix_time_machine
		 WHERE section_tipo = $1 AND section_id = $2 AND tipo = $3 ORDER BY id ASC`,
		[SECTION, sectionId, tipo],
	)) as { id: number; lang: string | null; data: unknown }[];
}

/** Apply one TM row back onto the live record through the real tool door. */
async function restore(sectionId: number, tipo: string, lang: string, tmRowId: number) {
	return await toolTimeMachineApplyValue(
		await context({
			section_tipo: SECTION,
			section_id: sectionId,
			tipo,
			lang,
			matrix_id: tmRowId,
		}),
	);
}

beforeAll(async () => {
	await ensureSituation(SITUATION);
	// ANTI-VACUITY FLOOR. Every assertion below depends on these five ontology
	// facts; a moved, renamed or re-modelled fixture must redden this gate rather
	// than quietly satisfy it by making the merge branch unreachable.
	expect(await getMatrixTableFromTipo(SECTION)).toBe(TABLE);
	expect(await getModelByTipo(TRANSLATABLE)).toBe('component_input_text');
	expect(await getTranslatableByTipo(TRANSLATABLE)).toBe(true);
	expect(await getTranslatableByTipo(NOLAN)).toBe(false);
	expect(await getModelByTipo(UNSLICED)).toBe('component_number');
	// The write engine's own predicate — the one the restore door branches on.
	expect(isLangSlicedModel('component_input_text')).toBe(true);
	expect(isLangSlicedModel('component_number')).toBe(false);
	// The other literal model whose rows show the non-array snapshot shape slices
	// the same way, so the input_text fixture below stands for those rows rather
	// than beside them.
	expect(isLangSlicedModel('component_text_area')).toBe(true);
	expect(getColumnNameByModel('component_input_text')).toBe('string');
	expect(getColumnNameByModel('component_number')).toBe('number');
});

afterAll(async () => {
	// The dd542 rows apply_value appends are outside the situation's own sweep.
	await sql.unsafe(`DELETE FROM matrix_activity WHERE data->>'section_tipo' = $1`, [SECTION]);
	expect(await dropSituation(SITUATION)).toBe(0);
});

describe('restoring ONE language slice keeps every other language', () => {
	let recordId = 0;
	let tmSpaV1 = 0;
	let tmEng = 0;
	let before: Record<string, string> = {};

	beforeAll(async () => {
		recordId = await createSectionRecord(SECTION, -1);
		// Three languages, then a fourth save that moves Spanish forward — the
		// trilingual record the audit reproduced the wipe on, built here through
		// the save door so the TM rows are the ones the engine really writes.
		await save(TRANSLATABLE, recordId, 'lg-eng', insertFirst('HELLO ENGLISH'));
		await save(TRANSLATABLE, recordId, 'lg-eus', insertFirst('KAIXO MUNDUA'));
		await save(TRANSLATABLE, recordId, 'lg-spa', insertFirst('HOLA v1'));
		await save(TRANSLATABLE, recordId, 'lg-spa', updateItem(1, 'HOLA v2'));
		before = await textByLang(recordId, 'string', TRANSLATABLE);
	});

	test('the fixture is real: three language slices stored, four one-language TM rows', async () => {
		// Anti-vacuity: without a genuinely multilingual live value there is
		// nothing for a restore to delete and every assertion below is free.
		expect(Object.keys(before).sort()).toEqual(['lg-eng', 'lg-eus', 'lg-spa']);
		const rows = await tmRows(recordId, TRANSLATABLE);
		expect(rows.length).toBe(4);
		// THE DEFECT'S PREMISE, asserted rather than asserted-about: every TM row
		// the save path wrote is a ONE-LANGUAGE slice of a three-language value.
		for (const row of rows) {
			const items = row.data as { lang?: string }[];
			expect(items.length).toBe(1);
			expect(items[0]?.lang).toBe(row.lang as string);
		}
		tmSpaV1 = rows.find((row) => (row.data as { value?: string }[])[0]?.value === 'HOLA v1')
			?.id as number;
		tmEng = rows.find((row) => row.lang === 'lg-eng')?.id as number;
		expect(tmSpaV1).toBeGreaterThan(0);
		expect(tmEng).toBeGreaterThan(0);
	});

	test('the restore answers ok', async () => {
		const response = await restore(recordId, TRANSLATABLE, 'lg-spa', tmSpaV1);
		expect(response.ok).toBe(true);
	});

	test('lg-eng and lg-eus survive BYTE-IDENTICAL', async () => {
		const after = await textByLang(recordId, 'string', TRANSLATABLE);
		// Stored jsonb text, character for character — this is the assertion the
		// defect failed: both keys were simply absent afterwards.
		expect(after['lg-eng']).toBe(before['lg-eng']);
		expect(after['lg-eus']).toBe(before['lg-eus']);
	});

	test('the restored language holds the historical value, and nothing else changed shape', async () => {
		const items = await storedItems(recordId, 'string', TRANSLATABLE);
		expect(items.length).toBe(3);
		const byLang = Object.fromEntries(items.map((row) => [row.item.lang, row.item.value]));
		expect(byLang).toEqual({
			'lg-eng': 'HELLO ENGLISH',
			'lg-eus': 'KAIXO MUNDUA',
			'lg-spa': 'HOLA v1',
		});
	});

	test("the merged key keeps the SAVE PATH's array order: survivors first, restored last", async () => {
		// Invariant 2b. `mergeRestoredLangSlice` returns `[...survivors, ...restored]`,
		// which is the order `save_component.ts` writes a lang-sliced save in
		// (`items = [...otherLangs, ...stamped]`, PHP set_data_lang :1052-1128).
		// Nothing else in the gate looks at ORDER, so putting the restored slice
		// first would pass everything while giving the same component two array
		// shapes depending on which door last wrote it.
		const items = await storedItems(recordId, 'string', TRANSLATABLE);
		expect(items.map((row) => row.item.lang)).toEqual(['lg-eng', 'lg-eus', 'lg-spa']);
	});

	test('the TM row the restore writes is ONE LANGUAGE — the one it was asked for', async () => {
		// Invariant 2. The row is the Spanish timeline's newest entry and it holds
		// the Spanish slice of the post-merge value, exactly as the save path
		// writes the same change (save_component.ts :1231-1238). A row carrying
		// lg-eng beside lg-spa under a `lang: lg-spa` tag is what made restoring
		// this very row revert English from the Spanish timeline.
		const rows = await tmRows(recordId, TRANSLATABLE);
		expect(rows.length).toBe(5);
		const fresh = rows[rows.length - 1];
		expect(fresh?.lang).toBe('lg-spa');
		const items = fresh?.data as { lang?: string; value?: unknown }[];
		expect(items.length).toBe(1);
		expect(items[0]?.lang).toBe('lg-spa');
		expect(items[0]?.value).toBe('HOLA v1');
		// And the shape holds for EVERY row of this component: one row, one
		// language, tag and payload agreeing — the assumption the dd15 list, the
		// preview emit and both restore doors are built on.
		for (const row of rows) {
			const rowItems = row.data as { lang?: string }[];
			expect(rowItems.length).toBe(1);
			expect(rowItems[0]?.lang).toBe(row.lang as string);
		}
	});

	test('NO PING-PONG: restoring a second language keeps the first', async () => {
		// The old door made these two restores mutually exclusive: each wrote its
		// own slice as the whole key, so the record could never hold both.
		await save(TRANSLATABLE, recordId, 'lg-eng', updateItem(1, 'HELLO v2'));
		const response = await restore(recordId, TRANSLATABLE, 'lg-eng', tmEng);
		expect(response.ok).toBe(true);
		const items = await storedItems(recordId, 'string', TRANSLATABLE);
		// The COUNT first: `Object.fromEntries` collapses a duplicated language to
		// its last item, so a merge that appended the restored slice BESIDE a
		// surviving item of the same language would read as correct below.
		expect(items.length).toBe(3);
		expect(Object.fromEntries(items.map((row) => [row.item.lang, row.item.value]))).toEqual({
			'lg-eng': 'HELLO ENGLISH',
			'lg-eus': 'KAIXO MUNDUA',
			'lg-spa': 'HOLA v1',
		});
	});
});

describe('an EMPTY slice snapshot clears exactly one language', () => {
	let recordId = 0;

	beforeAll(async () => {
		recordId = await createSectionRecord(SECTION, -1);
		await save(TRANSLATABLE, recordId, 'lg-eng', insertFirst('KEEP ME'));
		await save(TRANSLATABLE, recordId, 'lg-spa', insertFirst('BÓRRAME'));
	});

	test('the lg-spa items go, the lg-eng items stay', async () => {
		// A cleared slice is what save_component writes when the last item of one
		// language is removed: an EMPTY array stamped with that language. The
		// snapshot cannot name its own language, so the row's `lang` column is what
		// tells the restore which single language to clear — and clearing none (a
		// no-op) would be as wrong as clearing all.
		const rows = (await sql.unsafe(
			`INSERT INTO matrix_time_machine (section_id, section_tipo, tipo, lang, timestamp, user_id, data)
			 VALUES ($1, $2, $3, 'lg-spa', '2026-08-27 10:00:00', -1, '[]'::jsonb)
			 RETURNING id`,
			[recordId, SECTION, TRANSLATABLE],
		)) as { id: number }[];
		const response = await restore(recordId, TRANSLATABLE, 'lg-spa', rows[0]?.id as number);
		expect(response.ok).toBe(true);
		const items = await storedItems(recordId, 'string', TRANSLATABLE);
		expect(items.length).toBe(1);
		expect(items[0]?.item.lang).toBe('lg-eng');
		expect(items[0]?.item.value).toBe('KEEP ME');
	});
});

describe('a NON-translatable component is not corrupted by the merge', () => {
	let recordId = 0;

	beforeAll(async () => {
		recordId = await createSectionRecord(SECTION, -1);
		// Lang-sliced by CLASS, stored on lg-nolan whatever lang the request
		// carries: every item shares one language, so the merge must degenerate to
		// the replace PHP performed — no v1 residue beside v2.
		await save(NOLAN, recordId, 'lg-eng', insertFirst('SIG v1'));
		await save(NOLAN, recordId, 'lg-eng', updateItem(1, 'SIG v2'));
	});

	test('the whole lg-nolan slice is replaced, with no survivor from the live value', async () => {
		const rows = await tmRows(recordId, NOLAN);
		expect(rows.length).toBe(2);
		expect(rows[0]?.lang).toBe('lg-nolan');
		const response = await restore(recordId, NOLAN, 'lg-eng', rows[0]?.id as number);
		expect(response.ok).toBe(true);
		const items = await storedItems(recordId, 'string', NOLAN);
		expect(items.length).toBe(1);
		expect(items[0]?.item.value).toBe('SIG v1');
	});

	test('the audit row is stamped with the EFFECTIVE lang, not the request lang', async () => {
		// The request carried lg-eng; the component is ontology-non-translatable,
		// so the engine addresses it on lg-nolan and the row must say so — the same
		// `translatable || iri ? lang : 'lg-nolan'` rule the save path stamps with
		// (save_component.ts :680). A row tagged with the request lang while its
		// items speak lg-nolan is the one-row-one-language contract broken from the
		// other end: the dd15 list would file this restore under a language the
		// component does not have.
		const rows = await tmRows(recordId, NOLAN);
		const fresh = rows[rows.length - 1];
		expect(fresh?.lang).toBe('lg-nolan');
		const items = fresh?.data as { lang?: string; value?: unknown }[];
		expect(items.map((item) => item.lang)).toEqual(['lg-nolan']);
		expect(items[0]?.value).toBe('SIG v1');
	});
});

describe('a component the engine does NOT slice is still replaced whole', () => {
	let recordId = 0;

	beforeAll(async () => {
		recordId = await createSectionRecord(SECTION, -1);
		// component_number: its TM row is the FULL item array, so the second save's
		// row holds both items. Restoring the FIRST row must leave one item — a
		// merge applied here would keep the live second item and append the
		// snapshot on top, resurrecting a value a later save legitimately removed.
		await save(UNSLICED, recordId, 'lg-nolan', insertFirst(10));
		await save(UNSLICED, recordId, 'lg-nolan', [{ action: 'insert', value: { value: 20 } }]);
	});

	test('the live items the snapshot does not carry do NOT survive', async () => {
		const rows = await tmRows(recordId, UNSLICED);
		expect(rows.length).toBe(2);
		expect((rows[0]?.data as unknown[]).length).toBe(1);
		expect((rows[1]?.data as unknown[]).length).toBe(2);
		const response = await restore(recordId, UNSLICED, 'lg-nolan', rows[0]?.id as number);
		expect(response.ok).toBe(true);
		const items = await storedItems(recordId, 'number', UNSLICED);
		expect(items.length).toBe(1);
		expect(items[0]?.item.value).toBe(10);
	});
});

describe('a snapshot that is NOT an item array clears ONE language, never the key', () => {
	/**
	 * THE NON-ARRAY SHAPE. `matrix_time_machine.data` is a NULLABLE jsonb column
	 * (verified in the suite schema), so a lang-sliced component's snapshot can be
	 * something other than an item array — SQL NULL (what an empty slice is
	 * written as) or a bare scalar string, both of which PHP-era rows hold. A
	 * merge gated on `Array.isArray` sends exactly those rows back down the
	 * whole-key path, where the restore answers ok:true and deletes EVERY language
	 * the component holds. The snapshot's shape may decide how much of ONE
	 * language is restored; it may never decide whether a SIBLING language lives.
	 * Both shapes are BUILT here rather than counted somewhere.
	 */
	let nullRecord = 0;
	let scalarRecord = 0;

	beforeAll(async () => {
		nullRecord = await createSectionRecord(SECTION, -1);
		scalarRecord = await createSectionRecord(SECTION, -1);
		for (const id of [nullRecord, scalarRecord]) {
			await save(TRANSLATABLE, id, 'lg-eng', insertFirst('KEEP-ME'));
			await save(TRANSLATABLE, id, 'lg-spa', insertFirst('BORRAME'));
		}
	});

	/**
	 * A TM row whose `data` is written RAW — these two shapes are what the PHP
	 * engine left behind and what the TS save path never writes, so they cannot be
	 * built through the save door the way every other fixture here is.
	 */
	async function insertRawTmRow(sectionId: number, lang: string, dataSql: string): Promise<number> {
		const rows = (await sql.unsafe(
			`INSERT INTO matrix_time_machine
				(section_id, section_tipo, tipo, lang, timestamp, user_id, data)
			 VALUES ($1, $2, $3, $4, '2026-08-27 10:00:00', -1, ${dataSql}) RETURNING id`,
			[sectionId, SECTION, TRANSLATABLE, lang],
		)) as { id: number }[];
		return rows[0]?.id as number;
	}

	test('SQL NULL data: lg-spa is cleared, lg-eng survives untouched', async () => {
		const tmId = await insertRawTmRow(nullRecord, 'lg-spa', 'NULL');
		// Anti-vacuity: the row really is a non-array snapshot, and the record
		// really does hold two languages going in.
		const seeded = await storedItems(nullRecord, 'string', TRANSLATABLE);
		expect(seeded.length).toBe(2);
		const response = await restore(nullRecord, TRANSLATABLE, 'lg-spa', tmId);
		expect(response.ok).toBe(true);
		const items = await storedItems(nullRecord, 'string', TRANSLATABLE);
		expect(items.map((row) => [row.item.lang, row.item.value])).toEqual([['lg-eng', 'KEEP-ME']]);
	});

	test('scalar data: lg-spa is cleared, lg-eng survives untouched', async () => {
		const tmId = await insertRawTmRow(scalarRecord, 'lg-spa', `'"UN TEXTO ANTIGUO"'::jsonb`);
		const before = await textByLang(scalarRecord, 'string', TRANSLATABLE);
		const response = await restore(scalarRecord, TRANSLATABLE, 'lg-spa', tmId);
		expect(response.ok).toBe(true);
		const items = await storedItems(scalarRecord, 'string', TRANSLATABLE);
		expect(items.map((row) => [row.item.lang, row.item.value])).toEqual([['lg-eng', 'KEEP-ME']]);
		// BYTE-identical, not merely equal: the survivor is the stored object, not
		// a re-serialization of it.
		const after = await textByLang(scalarRecord, 'string', TRANSLATABLE);
		expect(after['lg-eng']).toBe(before['lg-eng']);
	});

	test('the component key itself is never replaced by the scalar', async () => {
		// The pre-fix write put the bare string INTO the component key, which is
		// not even a valid item array — every reader downstream sees a corrupt
		// component, not just a shorter one.
		const rows = (await sql.unsafe(
			`SELECT jsonb_typeof(string->$3) AS kind FROM "${TABLE}"
			 WHERE section_tipo = $1 AND section_id = $2`,
			[SECTION, scalarRecord, TRANSLATABLE],
		)) as { kind: string | null }[];
		expect(rows[0]?.kind).toBe('array');
	});
});

describe('restoring a row THIS DOOR wrote replaces only its own language', () => {
	/**
	 * The restore's own audit row is itself restorable, so it has to obey the same
	 * one-row-one-language contract as a saved row. It did not: it carried the
	 * whole merged value under the request's lang tag, so restoring it from the
	 * Spanish timeline reverted ENGLISH to the value it had when the Spanish
	 * restore ran — while the English timeline's newest row said something else.
	 */
	let recordId = 0;
	let freshSpaRow = 0;

	beforeAll(async () => {
		recordId = await createSectionRecord(SECTION, -1);
		await save(TRANSLATABLE, recordId, 'lg-eng', insertFirst('ENG-1'));
		await save(TRANSLATABLE, recordId, 'lg-spa', insertFirst('SPA-1'));
		await save(TRANSLATABLE, recordId, 'lg-spa', updateItem(1, 'SPA-2'));
		const history = await tmRows(recordId, TRANSLATABLE);
		const spaV1 = history.find((row) => (row.data as { value?: string }[])[0]?.value === 'SPA-1')
			?.id as number;
		expect(spaV1).toBeGreaterThan(0);
		const response = await restore(recordId, TRANSLATABLE, 'lg-spa', spaV1);
		expect(response.ok).toBe(true);
		const afterRestore = await tmRows(recordId, TRANSLATABLE);
		freshSpaRow = afterRestore[afterRestore.length - 1]?.id as number;
	});

	test('the row the restore wrote is tagged AND shaped for one language', async () => {
		const rows = await tmRows(recordId, TRANSLATABLE);
		const fresh = rows.find((row) => row.id === freshSpaRow);
		expect(fresh?.lang).toBe('lg-spa');
		const items = fresh?.data as { lang?: string; value?: unknown }[];
		expect(items.map((item) => item.lang)).toEqual(['lg-spa']);
		expect(items[0]?.value).toBe('SPA-1');
	});

	test('an English edit made AFTER it is not reverted by restoring it', async () => {
		await save(TRANSLATABLE, recordId, 'lg-eng', updateItem(1, 'ENG-2'));
		const response = await restore(recordId, TRANSLATABLE, 'lg-spa', freshSpaRow);
		expect(response.ok).toBe(true);
		const items = await storedItems(recordId, 'string', TRANSLATABLE);
		expect(items.length).toBe(2);
		expect(Object.fromEntries(items.map((row) => [row.item.lang, row.item.value]))).toEqual({
			'lg-eng': 'ENG-2',
			'lg-spa': 'SPA-1',
		});
		// And the two timelines still agree with the record: the English one's
		// newest row is the edit, not the value the Spanish restore rolled through.
		const rows = await tmRows(recordId, TRANSLATABLE);
		const englishRows = rows.filter((row) => row.lang === 'lg-eng');
		const newestEnglish = englishRows[englishRows.length - 1]?.data as { value?: unknown }[];
		expect(newestEnglish[0]?.value).toBe('ENG-2');
	});
});

describe('the REQUEST lang may differ from the ROW lang — the audit row follows the ROW', () => {
	/**
	 * `apply_value` never validates `options.lang` against `tmRow.lang`: the
	 * target check covers section_tipo / section_id / tipo only. So a caller can
	 * hand this door a SPANISH row with `lang: lg-eng` — the client sends the
	 * lang of the component instance the strip was opened on, and nothing on the
	 * wire ties it to the row that was picked.
	 *
	 * The MERGE was already right on that axis (it reads the languages it may
	 * replace from the snapshot's own items). The AUDIT ROW was not: tagged and
	 * sliced with the REQUEST lang, it recorded NOTHING in the timeline of the
	 * language that actually changed, and appended to the UNTOUCHED language's
	 * timeline a row holding that language's surviving items — a row whose later
	 * restore reverts an edit nobody selected. Every other behavioural assertion
	 * in this file runs with request lang === row lang (or with the lg-nolan
	 * normalization that makes them equal), which is the axis that hid it.
	 * `bulk_revert.ts` :292 always derived it from the batch row's own lang; the
	 * two doors now agree.
	 */
	let recordId = 0;
	let tmSpaV1 = 0;
	let englishRowsBefore = 0;

	beforeAll(async () => {
		recordId = await createSectionRecord(SECTION, -1);
		await save(TRANSLATABLE, recordId, 'lg-eng', insertFirst('ENG STANDING'));
		await save(TRANSLATABLE, recordId, 'lg-spa', insertFirst('SPA-1'));
		await save(TRANSLATABLE, recordId, 'lg-spa', updateItem(1, 'SPA-2'));
		const history = await tmRows(recordId, TRANSLATABLE);
		tmSpaV1 = history.find((row) => (row.data as { value?: string }[])[0]?.value === 'SPA-1')
			?.id as number;
		englishRowsBefore = history.filter((row) => row.lang === 'lg-eng').length;
		// Anti-vacuity: the row really is Spanish, the request below really is
		// English, and the English timeline really has exactly one row to compare.
		expect(history.find((row) => row.id === tmSpaV1)?.lang).toBe('lg-spa');
		expect(englishRowsBefore).toBe(1);
		// THE AXIS: a SPANISH row restored under an ENGLISH request lang.
		const response = await restore(recordId, TRANSLATABLE, 'lg-eng', tmSpaV1);
		expect(response.ok).toBe(true);
	});

	test('the merge still replaces the ROW language and leaves the other standing', async () => {
		// DATA-03 proper does not reopen on this axis: the merge never consulted
		// the request lang.
		const items = await storedItems(recordId, 'string', TRANSLATABLE);
		expect(items.length).toBe(2);
		expect(Object.fromEntries(items.map((row) => [row.item.lang, row.item.value]))).toEqual({
			'lg-eng': 'ENG STANDING',
			'lg-spa': 'SPA-1',
		});
	});

	test('the audit row is TAGGED and SLICED for the ROW language, not the request one', async () => {
		const rows = await tmRows(recordId, TRANSLATABLE);
		const fresh = rows[rows.length - 1];
		expect(fresh?.lang).toBe('lg-spa');
		const items = fresh?.data as { lang?: string; value?: unknown }[];
		expect(items.map((item) => item.lang)).toEqual(['lg-spa']);
		expect(items[0]?.value).toBe('SPA-1');
	});

	test('the UNTOUCHED language timeline gains nothing', async () => {
		// The half that makes the mis-tag destructive rather than merely untidy: a
		// spurious English row duplicating the current English value is restorable,
		// and restoring it reverts whatever English edit came after it.
		const rows = await tmRows(recordId, TRANSLATABLE);
		const englishRows = rows.filter((row) => row.lang === 'lg-eng');
		expect(englishRows.length).toBe(englishRowsBefore);
		expect((englishRows[englishRows.length - 1]?.data as { value?: unknown }[])[0]?.value).toBe(
			'ENG STANDING',
		);
	});

	test('the CHANGED language timeline records the restore', async () => {
		// The other half: the language that actually changed must have the row, or
		// the restore is invisible in the only history that would undo it.
		const rows = await tmRows(recordId, TRANSLATABLE);
		const spanishRows = rows.filter((row) => row.lang === 'lg-spa');
		expect(spanishRows.length).toBe(3);
		expect((spanishRows[spanishRows.length - 1]?.data as { value?: unknown }[])[0]?.value).toBe(
			'SPA-1',
		);
	});
});

describe('the BULK door obeys the same law (P0-4 covers BOTH restore doors)', () => {
	/**
	 * `bulk_revert_process` reverts every component of a batch from the SAME
	 * per-language snapshots. Writing them as whole keys deleted the sibling
	 * languages of every reverted component at once — one click, the batch's
	 * blast radius. It now merges through the helpers `tool_time_machine.ts`
	 * exports, so there is one law and one implementation of it.
	 */
	const BATCH_BULK_ID = 9905301; // synthetic: no dd800 record is needed to READ it
	const mintedBulkIds: number[] = [];
	let recordId = 0;

	beforeAll(async () => {
		recordId = await createSectionRecord(SECTION, -1);
		await save(TRANSLATABLE, recordId, 'lg-eng', insertFirst('ENG KEEP'));
		await save(TRANSLATABLE, recordId, 'lg-spa', insertFirst('SPA BEFORE'));
		// The batch: one Spanish write stamped with the bulk id, through the same
		// save door a tool_propagate_component_data run writes through.
		await save(TRANSLATABLE, recordId, 'lg-spa', updateItem(1, 'SPA BATCH'), BATCH_BULK_ID);
	});

	afterAll(async () => {
		for (const bulkId of mintedBulkIds) {
			await sql`DELETE FROM matrix_notes WHERE section_tipo = 'dd800' AND section_id = ${bulkId}`;
		}
	});

	test('reverting the Spanish batch write leaves the English value standing', async () => {
		// Anti-vacuity: the batch really is one language of a two-language value.
		const seeded = await storedItems(recordId, 'string', TRANSLATABLE);
		expect(seeded.length).toBe(2);
		const response = await toolTimeMachineBulkRevert(
			(await context({
				section_tipo: SECTION,
				bulk_process_id: BATCH_BULK_ID,
				bulk_revert_process_label: 'gate lang-slice revert',
			})) as Parameters<typeof toolTimeMachineBulkRevert>[0],
		);
		expect(response.ok).toBe(true);
		const batch = response.data as {
			counter: number;
			bulk_process_id: number | null;
			skipped: string[];
		};
		expect(batch.skipped).toEqual([]);
		expect(batch.counter).toBe(1);
		if (typeof batch.bulk_process_id === 'number') mintedBulkIds.push(batch.bulk_process_id);

		const items = await storedItems(recordId, 'string', TRANSLATABLE);
		// The COUNT, not just the map: a door that appended the snapshot beside the
		// live Spanish item instead of replacing it leaves TWO lg-spa items, and
		// `Object.fromEntries` would report only the last one.
		expect(items.length).toBe(2);
		expect(Object.fromEntries(items.map((row) => [row.item.lang, row.item.value]))).toEqual({
			'lg-eng': 'ENG KEEP',
			'lg-spa': 'SPA BEFORE',
		});
	});

	test('the audit row the revert writes is ONE language too', async () => {
		const rows = await tmRows(recordId, TRANSLATABLE);
		const fresh = rows[rows.length - 1];
		expect(fresh?.lang).toBe('lg-spa');
		const items = fresh?.data as { lang?: string; value?: unknown }[];
		expect(items.map((item) => item.lang)).toEqual(['lg-spa']);
		expect(items[0]?.value).toBe('SPA BEFORE');
	});
});

describe('a restore that changes nothing leaves NO trace (history records changes, not clicks)', () => {
	/** The whole record row as stored text — value, modified stamps, relation_search, everything. */
	async function recordText(sectionId: number): Promise<string> {
		const rows = (await sql.unsafe(
			`SELECT t::text AS text FROM "${TABLE}" t WHERE section_tipo = $1 AND section_id = $2`,
			[SECTION, sectionId],
		)) as { text: string }[];
		return rows[0]?.text as string;
	}
	/** The RECOVER rows logActivity appended for this record. */
	async function activityCount(sectionId: number): Promise<number> {
		const rows = (await sql.unsafe(
			`SELECT count(*)::int AS n FROM matrix_activity
			 WHERE misc->'dd551'->0->'value'->>'section_tipo' = $1
			   AND misc->'dd551'->0->'value'->>'section_id' = $2`,
			[SECTION, String(sectionId)],
		)) as { n: number }[];
		return rows[0]?.n ?? 0;
	}
	/** Restore `rowId` and return what changed: new TM rows, new activity rows, whether the record row moved. */
	async function restoreDelta(sectionId: number, tipo: string, lang: string, rowId: number) {
		const tmBefore = (await tmRows(sectionId, tipo)).length;
		const activityBefore = await activityCount(sectionId);
		const textBefore = await recordText(sectionId);
		const response = await restore(sectionId, tipo, lang, rowId);
		expect(response.ok).toBe(true);
		return {
			tm: (await tmRows(sectionId, tipo)).length - tmBefore,
			activity: (await activityCount(sectionId)) - activityBefore,
			recordMoved: (await recordText(sectionId)) !== textBefore,
			notice:
				((response as { notices?: { code: string }[] }).notices ?? [])
					.map((n) => n.code)
					.join(',') || null,
		};
	}

	test('A → B → A, restoring the first A: no TM row, no stamp, no activity', async () => {
		const id = await createSectionRecord(SECTION, -1);
		await save(TRANSLATABLE, id, 'lg-eng', insertFirst('A'));
		await save(TRANSLATABLE, id, 'lg-eng', updateItem(1, 'B'));
		await save(TRANSLATABLE, id, 'lg-eng', updateItem(1, 'A'));
		const first = (await tmRows(id, TRANSLATABLE))[0];
		expect((first?.data as { value?: unknown }[])[0]?.value).toBe('A');
		expect(await restoreDelta(id, TRANSLATABLE, 'lg-eng', first?.id as number)).toEqual({
			tm: 0,
			activity: 0,
			recordMoved: false,
			notice: 'tool.restore_unchanged',
		});
	});

	test('an EMPTY row restored onto an empty live value is a no-op too', async () => {
		const id = await createSectionRecord(SECTION, -1);
		await save(TRANSLATABLE, id, 'lg-eng', insertFirst('X'));
		await save(TRANSLATABLE, id, 'lg-eng', [{ action: 'remove', id: 1, value: null }]);
		const rows = await tmRows(id, TRANSLATABLE);
		const empty = rows[rows.length - 1];
		expect(empty?.data as unknown[]).toEqual([]);
		expect(await restoreDelta(id, TRANSLATABLE, 'lg-eng', empty?.id as number)).toEqual({
			tm: 0,
			activity: 0,
			recordMoved: false,
			notice: 'tool.restore_unchanged',
		});
	});

	test('an UNSLICED main (component_number) obeys the same law', async () => {
		const id = await createSectionRecord(SECTION, -1);
		await save(UNSLICED, id, 'lg-nolan', insertFirst(7));
		await save(UNSLICED, id, 'lg-nolan', updateItem(1, 8));
		await save(UNSLICED, id, 'lg-nolan', updateItem(1, 7));
		const first = (await tmRows(id, UNSLICED))[0];
		expect(await restoreDelta(id, UNSLICED, 'lg-nolan', first?.id as number)).toEqual({
			tm: 0,
			activity: 0,
			recordMoved: false,
			notice: 'tool.restore_unchanged',
		});
	});

	test('DRY RUN answers {changed} and writes nothing, whether or not the restore would change something', async () => {
		const id = await createSectionRecord(SECTION, -1);
		await save(TRANSLATABLE, id, 'lg-eng', insertFirst('A'));
		await save(TRANSLATABLE, id, 'lg-eng', updateItem(1, 'B'));
		await save(TRANSLATABLE, id, 'lg-eng', updateItem(1, 'A'));
		const [first, b] = await tmRows(id, TRANSLATABLE);
		for (const [row, changed] of [
			[first, false],
			[b, true],
		] as const) {
			const tmBefore = (await tmRows(id, TRANSLATABLE)).length;
			const activityBefore = await activityCount(id);
			const textBefore = await recordText(id);
			const response = (await toolTimeMachineApplyValue(
				await context({
					section_tipo: SECTION,
					section_id: id,
					tipo: TRANSLATABLE,
					lang: 'lg-eng',
					matrix_id: row?.id,
					dry_run: true,
				}),
			)) as { ok: boolean; data?: unknown; notices?: { code: string }[] };
			expect(response.ok).toBe(true);
			expect(response.data).toEqual({ changed });
			expect((response.notices ?? []).map((n) => n.code)).toEqual(
				changed ? [] : ['tool.restore_unchanged'],
			);
			expect((await tmRows(id, TRANSLATABLE)).length).toBe(tmBefore);
			expect(await activityCount(id)).toBe(activityBefore);
			expect(await recordText(id)).toBe(textBefore);
		}
	});

	test('a SECTION restore refuses dry_run and writes nothing (the probe never reaches a real write)', async () => {
		const id = await createSectionRecord(SECTION, -1);
		await save(TRANSLATABLE, id, 'lg-eng', insertFirst('A'));
		await deleteSectionRecord(SECTION, id, -1);
		const [sectionRow] = await tmRows(id, SECTION);
		expect(sectionRow).toBeDefined();
		const tmBefore = (await tmRows(id, SECTION)).length;
		const error = await toolTimeMachineApplyValue(
			await context({
				section_tipo: SECTION,
				section_id: id,
				tipo: SECTION,
				lang: 'lg-nolan',
				matrix_id: sectionRow?.id,
				dry_run: true,
			}),
		).then(
			() => null,
			(thrown: unknown) => thrown as { code?: string },
		);
		expect(error?.code).toBe('request.invalid_options');
		// not undeleted, no new history
		expect(await recordText(id)).toBeUndefined();
		expect((await tmRows(id, SECTION)).length).toBe(tmBefore);
	});

	test('POSITIVE CONTROL: restoring a value that differs still writes one TM row and one activity row', async () => {
		const id = await createSectionRecord(SECTION, -1);
		await save(TRANSLATABLE, id, 'lg-eng', insertFirst('A'));
		await save(TRANSLATABLE, id, 'lg-eng', updateItem(1, 'B'));
		await save(TRANSLATABLE, id, 'lg-eng', updateItem(1, 'A'));
		const b = (await tmRows(id, TRANSLATABLE))[1];
		expect((b?.data as { value?: unknown }[])[0]?.value).toBe('B');
		expect(await restoreDelta(id, TRANSLATABLE, 'lg-eng', b?.id as number)).toEqual({
			tm: 1,
			activity: 1,
			recordMoved: true,
			notice: null,
		});
	});
});

describe('the destructive client action is confirmed', () => {
	/**
	 * The client half cannot be driven from a server gate, so it is asserted at
	 * the source — deliberately on the SHAPE of the handler, not on the presence
	 * of the word `confirm` somewhere in the file: the block between the apply
	 * button's click handler and the `apply_value` call is what must contain the
	 * refusal path.
	 */
	const CLIENT = 'tools/tool_time_machine/js/render_tool_time_machine.js';
	const source = readFileSync(CLIENT, 'utf8');

	test('apply_value is not reached without a confirmation', () => {
		const start = source.indexOf("self.button_apply.addEventListener('click'");
		expect(start).toBeGreaterThan(-1);
		// The WRITE call (the dry-run probe before it writes nothing: it is rolled back).
		const call = source.indexOf("self.apply_value({...apply_options, notices: 'caller'})", start);
		expect(call).toBeGreaterThan(start);
		const handler = source.slice(start, call);
		// The guard AND its early return — a confirm whose answer is discarded
		// would be worse than none.
		expect(handler).toMatch(/if\s*\(!confirm\(/);
		expect(handler).toMatch(/return/);
		// The probe runs BEFORE the confirm: an unchanged restore never asks to overwrite.
		const probe = handler.indexOf('dry_run: true');
		expect(probe).toBeGreaterThan(-1);
		expect(probe).toBeLessThan(handler.search(/if\s*\(!confirm\(/));
	});

	test('the confirmation NAMES what will be overwritten', () => {
		const start = source.indexOf("self.button_apply.addEventListener('click'");
		const handler = source.slice(
			start,
			source.indexOf("self.apply_value({...apply_options, notices: 'caller'})", start),
		);
		// Component, language and record — a generic are-you-sure teaches nothing
		// and gets clicked through.
		expect(handler).toContain('component_label');
		// the language is the main's HISTORY lane (the server's lane law, decision 2026-09-29)
		expect(handler).toContain('self.history_lang()');
		expect(handler).toContain('record_address');
		expect(handler).toMatch(/OVERWRITTEN/);
	});

	test('the confirmation sentence is TRANSLATED, never English-only', () => {
		// The finding's third half: the client asked for a label that no lang block
		// carried, so every user in every language read the English literal in the
		// source. The key ships for EVERY language the tool already speaks — a key
		// present in some blocks and missing from others is the same defect moved.
		const register = JSON.parse(readFileSync('tools/tool_time_machine/register.json', 'utf8'));
		const labels = register.misc.dd1372[0].value as {
			lang: string;
			name: string;
			value: unknown;
		}[];
		const toolLangs = new Set(labels.map((label) => label.lang));
		const confirmLabels = labels.filter((label) => label.name === 'apply_value_confirm_msg');
		expect(new Set(confirmLabels.map((label) => label.lang))).toEqual(toolLangs);
		// Anti-vacuity: an empty label array would satisfy the set equality above.
		expect(confirmLabels.length).toBeGreaterThan(1);
		for (const label of confirmLabels) {
			// The three values the client passes, as POSITIONAL tokens (printf,
			// util.js): a translator may reorder them, which `%s` would forbid.
			for (const token of ['{0}', '{1}', '{2}']) {
				expect(String(label.value)).toContain(token);
			}
		}
	});

	test('the client asks that label for the three values the message names', () => {
		const start = source.indexOf("self.button_apply.addEventListener('click'");
		const handler = source.slice(
			start,
			source.indexOf("self.apply_value({...apply_options, notices: 'caller'})", start),
		);
		expect(handler).toContain("'apply_value_confirm_msg'");
		// component, language, record — the three tokens, in the order the English
		// label reads them.
		const call = handler.slice(handler.indexOf("'apply_value_confirm_msg'"));
		expect(call.indexOf('component_label')).toBeGreaterThan(-1);
		expect(call.indexOf('history_lang,')).toBeGreaterThan(call.indexOf('component_label'));
		expect(call.indexOf('record_address')).toBeGreaterThan(call.indexOf('history_lang,'));
	});

	test('the bulk-revert door still confirms too (the door that always did)', () => {
		const start = source.indexOf("self.button_bulk_revert_process.addEventListener('click'");
		expect(start).toBeGreaterThan(-1);
		const call = source.indexOf('self.bulk_revert_process(', start);
		expect(source.slice(start, call)).toMatch(/confirm\(/);
	});
});

describe('the restore-door census', () => {
	/**
	 * ENUMERATED, and enumerated MECHANICALLY (REMEDIATION P0-4: "add a scan rule
	 * that any new apply_value-shaped door is listed"). A restore door is a file
	 * that writes a TM snapshot back onto a live record — it replays a snapshot
	 * (`persistRecordKeys`) AND appends the audit row for it (`recordTimeMachine`).
	 * `dataframe_restore.ts` writes through the first and not the second: it
	 * replays FRAMES into their slots and deliberately writes no TM row of its
	 * own, so it is not a door, and the derivation says so rather than a list
	 * saying so.
	 *
	 * A third door added without the lang merge is a silent re-introduction of
	 * DATA-03 on a new surface. It reddens here. (The bulk revert's region law is
	 * proved behaviourally by bulk_revert_undo_native: a one-language run's
	 * revert leaves the other language byte-identical.)
	 */
	const DOOR_DIR = 'tools/tool_time_machine/server';
	const doorSource = (file: string) => readFileSync(`${DOOR_DIR}/${file}`, 'utf8');

	/**
	 * Does this door CALL the helper — as opposed to merely importing, defining or
	 * mentioning it? String containment is not enough on either side: a door that
	 * imports the helpers and never calls them would pass, and
	 * `tool_time_machine.ts` passes trivially because it DEFINES them. Import
	 * lines and comment lines are dropped, and the helper's own
	 * `export function <name>(` is excluded by the lookbehind, so what is left is
	 * an application of the function.
	 */
	function callsHelper(source: string, helper: string): boolean {
		const call = new RegExp(`(?<!function\\s)\\b${helper}\\s*\\(`);
		return source
			.split('\n')
			.filter((line) => {
				const trimmed = line.trimStart();
				return (
					!trimmed.startsWith('import') &&
					!trimmed.startsWith('//') &&
					!trimmed.startsWith('*') &&
					!trimmed.startsWith('/*')
				);
			})
			.some((line) => call.test(line));
	}

	/**
	 * A door is a file that writes a value back onto a live record
	 * (`persistRecordKeys` / `persistRestoredKeys`) AND audits that write in the time machine — through
	 * the plain door (`recordTimeMachine`) or the undo-log pair writer
	 * (`recordBulkPair`, WC-2026-09-27-bulk-revert-undo-log) — or through the
	 * two-lane writer over them (relations/dataframe_slots.ts
	 * `recordMainHistory`, WC addendum "two lanes"). Since the undo log, the bulk revert's WRITE
	 * lives in `bulk_revert_undo.ts` (a dataframe main's composed unit is
	 * PLANNED by `bulk_revert_composed.ts`, which writes nothing and is no door);
	 * `bulk_revert.ts` is the orchestrator and persists only its own dd800 label.
	 */
	const TM_WRITERS = ['recordTimeMachine', 'recordBulkPair', 'recordMainHistory'] as const;
	/**
	 * The key entries a write-back goes through: persistRecordKeys, or the
	 * COMPONENT-RESTORE entry persistRestoredKeys (a key's past value — its
	 * covered observer slot recomputed, never propagated; record_write.ts §3e).
	 */
	const KEY_WRITERS = ['persistRecordKeys', 'persistRestoredKeys'] as const;
	const restoreDoors = (): string[] =>
		readdirSync(DOOR_DIR)
			.filter((file) => file.endsWith('.ts'))
			.filter((file) => {
				const source = doorSource(file);
				return (
					KEY_WRITERS.some((writer) => callsHelper(source, writer)) &&
					TM_WRITERS.some((writer) => callsHelper(source, writer))
				);
			})
			.sort();

	/**
	 * How each door keeps the languages it did not restore. The two doors restore
	 * DIFFERENT things, so they merge through different — each ONE shared — rules:
	 *   - apply_value restores ONE LANE of a TM row (two lanes — the row's own
	 *     language, read for its lane only: a PHP row carrying several languages
	 *     restores just its tag's): `restoredLaneValue` (src/core/tm_record/
	 *     lane_state.ts, shared with the TM preview), which merges through
	 *     `mergeRestoredLangSlice` — pinned below — audited per lane by
	 *     `recordMainHistory`;
	 *   - the bulk revert restores a REGION it recorded exactly, cut with the
	 *     capture's lane law: `restoreLane` puts the live other-language items
	 *     back beside it and `laneRegion` cuts the live key the same way the
	 *     capture cut its pair (src/core/relations/main_lanes.ts, over
	 *     concepts/lang_region.ts). Its legacy
	 *     inference (bulk_revert_legacy.ts) reads whole history rows again, so
	 *     it merges through `mergeRestoredLangSlice` — pinned below;
	 *   - the soft-cascade restore (bulk_revert_records.ts) writes a WHOLE key
	 *     back over a key a data wipe emptied — every language was wiped, so
	 *     there is no sibling to keep — and only while `isWipedState` proves the
	 *     live key is still what the wipe left; `regionOf` cuts its audit pairs.
	 */
	const DOOR_MERGE: Readonly<Record<string, readonly string[]>> = {
		'tool_time_machine.ts': ['restoredLaneValue', 'recordMainHistory'],
		'bulk_revert_undo.ts': ['restoreLane', 'laneRegion'],
		'bulk_revert_records.ts': ['isWipedState', 'regionOf'],
	};

	test('exactly three doors write a TM snapshot back onto a live record', () => {
		const doors = restoreDoors();
		// Anti-vacuity: a moved or renamed directory would otherwise enumerate
		// nothing and pass.
		expect(doors.length).toBe(3);
		expect(doors).toEqual([
			'bulk_revert_records.ts',
			'bulk_revert_undo.ts',
			'tool_time_machine.ts',
		]);
	});

	test('EVERY door merges the slice through its ONE shared rule', () => {
		// Stated over the enumeration rather than per file: a door that writes a
		// value back and does NOT go through its rule deletes sibling languages.
		const doors = restoreDoors();
		expect(doors.length).toBeGreaterThan(1);
		expect(doors.filter((door) => DOOR_MERGE[door] === undefined)).toEqual([]);
		for (const door of doors) {
			for (const helper of DOOR_MERGE[door] ?? []) {
				expect(callsHelper(doorSource(door), helper), `${door} → ${helper}`).toBe(true);
			}
		}
		// The bulk revert's legacy inference restores whole history rows: the
		// apply_value merge, applied — not a local re-implementation.
		expect(callsHelper(doorSource('bulk_revert_legacy.ts'), 'mergeRestoredLangSlice')).toBe(true);
		// apply_value's lane value (and the preview's): the same merge, in core.
		const laneState = readFileSync('src/core/tm_record/lane_state.ts', 'utf8');
		expect(callsHelper(laneState, 'mergeRestoredLangSlice')).toBe(true);
	});

	test('the helper predicate is honest: it rejects a mention, an import and a definition', () => {
		// Anti-vacuity for `callsHelper` itself — the assertion above is only worth
		// what this one proves. Without it a predicate that returned `true` for any
		// input would make the census green forever.
		expect(
			callsHelper("import { tmAuditSlice } from './tool_time_machine.ts';", 'tmAuditSlice'),
		).toBe(false);
		expect(callsHelper('// see tmAuditSlice(value, lang) for why', 'tmAuditSlice')).toBe(false);
		expect(callsHelper(' * `tmAuditSlice(x)` slices one language', 'tmAuditSlice')).toBe(false);
		expect(
			callsHelper('export function tmAuditSlice(value: unknown): unknown {', 'tmAuditSlice'),
		).toBe(false);
		expect(
			callsHelper('\t\t\tdata: tmAuditSlice(restoredValue, snapshotLang),', 'tmAuditSlice'),
		).toBe(true);
	});
});
