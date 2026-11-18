/**
 * AUTOMATIC TRANSLATION IS GATED LIKE A SAVE (T1-14 / OX7).
 *
 * THE DEFECT. `translateAndWrite` (tool_lang / tool_lang_multi
 * `automatic_translation`) wrote the provider's result straight through
 * `persistRecordKeys`, the model-agnostic record chokepoint — so the write
 * engine's VALUE gates (`applyWriteValueGates`: the rich-text sanitizer +
 * WC-042 media-src relativize for an `html` render class) never ran. Babel's
 * post-processing is PHP `strip_tags` with a tag allowlist: it KEEPS attributes,
 * and its entity decode turns text an editor typed literally
 * (`&lt;strong onmouseover=…&gt;`, stored harmless) into LIVE markup. The client
 * renders a `component_text_area` unescaped: stored XSS for every viewer. PHP
 * sanitized in `component_text_area::save` (`clean_text`), which tool_lang called.
 *
 * WHAT IS ASSERTED — outcomes, never spellings:
 *   A1 a hostile provider result is stored BYTE-EQUAL to what the save door
 *      stores for the same raw value (cross-door parity) and carries no handler;
 *   A2 the real `babelProvider` round trip (fetch stubbed) — entity-encoded
 *      source text does not come back live;
 *   A3 a result EMPTY after the gate is `translation.empty_result`: nothing
 *      written, no TM row (WC-2026-11-10 — never blank a language);
 *   A4 the TM row holds the gated value, never the raw markup;
 *   A5 benign rich text + Dédalo marks are stored byte-identical (non-vacuity);
 *   A6 OTHER languages are untouched — even a raw value seeded past the gate
 *      (the two-lanes contract: only the target lane is written);
 *   A7 a non-`html` model (input_text) stores the provider text verbatim.
 *
 * THE TIME MACHINE RESTORE DOORS ARE GATED LIKE A SAVE TOO (C58 / T1-14 N1,
 * WC-2026-11-17-tm-restore-value-gates). `tool_time_machine.apply_value` — the
 * component restore and the whole-record restore — replayed a history image
 * past the value gates: a row written before a gate existed put its raw value
 * back (PHP restored through `component->Save()`, which cleaned). Outcomes:
 *   R1 a hostile component row restores BYTE-EQUAL to the save-door form; the
 *      restore's own history row holds the gated value; another language's
 *      raw live value is not rewritten (the row speaks for its lane only);
 *   R2 a benign row restores byte-identical (a valid restore is unchanged);
 *   R3 a whole-record row: the text area gated to the save-door form, a number
 *      formatted as its node declares, a non-html literal verbatim; the
 *      recover's own whole-record history row holds the gated values;
 *   R4 a credential row that is not a stored hash is REFUSED
 *      (`tool.snapshot_unrestorable`), nothing written — whether a save would
 *      refuse it (it breaks the policy) or hash it (it conforms): a replay
 *      never mints a credential from history bytes; a stored hash replays
 *      verbatim. On the WHOLE-RECORD door the image is refused WHOLE: its
 *      other keys are not written either, no history row is added.
 *   R5 a LEGACY v6 CIPHERTEXT credential (owner ruling 2026-11-18) replays
 *      VERBATIM on both doors — never refused, never hashed — so a user record
 *      from before the upgrade can be restored / undeleted and
 *      `scripts/migrate_v6_passwords.ts` still converts it; a non-hash value
 *      that only LOOKS like one (one base64 layer, a body that is no AES block
 *      run) stays refused.
 *
 * THE BULK REVERT'S WRITERS ARE GATED LIKE A SAVE TOO (C58, owner ruling
 * 2026-11-18: "every save the same way, no exceptions"). Through the real
 * `bulk_revert_process` door, against runs written by the save door:
 *   B1 an exact key whose pre-run image is hostile reverts to the SAVE-DOOR
 *      form (never the raw image); a second revert of the same run finds it
 *      `unchanged` (the cleaned value is not a phantom `changed_since_run`);
 *      the revert of the revert chains;
 *   B2 a number is formatted as its node declares;
 *   B3 a credential image that is neither a hash nor a v6 ciphertext refuses
 *      ITS unit — `skipped[{reason:'failed', code:'tool.snapshot_unrestorable'}]`,
 *      located, nothing written, the run's other units still reverted; a v6
 *      ciphertext image is put back verbatim;
 *   B4 a COMPOSED unit (a main with a dataframe slot) writes its main gated;
 *   B5 a record a run WIPED gets its pre-wipe values back gated, and a repeat
 *      revert finds it `present` (never `cascade_delete_not_reverted`);
 *   B6 the undelete door (`restoreAbsentSectionRow`) inserts the snapshot
 *      gated, refuses a non-replayable credential whole, replays a v6
 *      ciphertext verbatim.
 *
 * Situation: the suite's `test3` playground (matrix_test) with its translatable
 * `component_text_area` test17 and `component_input_text` test52. Records are
 * minted at runtime through the counter (no reserved ids) and removed — rows,
 * TM rows, activity rows — in afterAll.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { readMatrixRecord } from '../../src/core/db/matrix.ts';
import {
	deleteMatrixRecord,
	insertMatrixRecordWithCounter,
	updateMatrixRecord,
} from '../../src/core/db/matrix_write.ts';
import { sql } from '../../src/core/db/postgres.ts';
import { recordTimeMachine } from '../../src/core/db/time_machine.ts';
import { isDedaloError } from '../../src/core/errors/dedalo_error.ts';
import { getMatrixTableFromTipo } from '../../src/core/ontology/resolver.ts';
import { createSectionRecord } from '../../src/core/section/record/create_record.ts';
import { deleteSectionData } from '../../src/core/section/record/delete_record.ts';
import { saveComponentData } from '../../src/core/section/record/save_component.ts';
import {
	DEFAULT_INFORMATION,
	encryptLegacyPasswordForTest,
} from '../../src/core/security/legacy_password.ts';
import { isArgon2Hash, isLegacyEncryptedPassword } from '../../src/core/security/password_hash.ts';
import { type Principal, resolvePrincipal } from '../../src/core/security/permissions.ts';
import {
	dropSituation,
	ensureSituation,
	situation,
} from '../../src/core/test_data/situations/situation.ts';
import { assertTestDatabase } from '../../src/core/test_data/test_database_marker.ts';
import {
	babelProvider,
	type TranslationProvider,
	translateAndWrite,
	translationFailure,
} from '../../src/core/tools/translation.ts';
import {
	type BulkRevertSkipped,
	toolTimeMachineBulkRevert,
} from '../../tools/tool_time_machine/server/bulk_revert.ts';
import { resolveDataframeSlotTipos } from '../../tools/tool_time_machine/server/dataframe_restore.ts';
import {
	restoreAbsentSectionRow,
	toolTimeMachineApplyValue,
} from '../../tools/tool_time_machine/server/tool_time_machine.ts';
import { demoteToLegacyRun } from '../helpers/legacy_bulk_run.ts';
import { refusalOf } from '../helpers/refusal.ts';
import { superuserTranslationGrant } from '../helpers/translation_grant.ts';

const SECTION = 'test3';
/** component_text_area, translatable, render class `html` → `string` column. */
const TEXT_AREA = 'test17';
const TEXT_AREA_MODEL = 'component_text_area';
/** component_input_text, translatable, NOT html (the client escapes it). */
const INPUT_TEXT = 'test52';
const INPUT_TEXT_MODEL = 'component_input_text';
const URI = 'https://93.184.216.34/translate'; // IP literal: no DNS (see translation_pipeline_native)

let table = 'matrix_test';
const minted: number[] = [];

const REAL_FETCH = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = REAL_FETCH;
});

beforeAll(async () => {
	await assertTestDatabase('translation_write_gates_native');
	table = (await getMatrixTableFromTipo(SECTION)) ?? 'matrix_test';
});

afterAll(async () => {
	await assertTestDatabase('translation_write_gates_native');
	for (const id of minted) {
		await deleteMatrixRecord(table, SECTION, id);
		await sql`DELETE FROM matrix_time_machine WHERE section_tipo = ${SECTION} AND section_id = ${id}`;
		await sql`
			DELETE FROM matrix_activity WHERE section_tipo = 'dd542'
			  AND misc->'dd551'->0->'value'->>'section_tipo' = ${SECTION}
			  AND misc->'dd551'->0->'value'->>'section_id' = ${String(id)}
		`;
	}
});

/** Mint a test3 record (counter-allocated) holding `items` under `tipo`. */
async function mint(tipo: string, items: unknown[]): Promise<number> {
	const id = await insertMatrixRecordWithCounter(table, SECTION, {});
	minted.push(id);
	if (items.length > 0) {
		expect(await updateMatrixRecord(table, SECTION, id, { string: { [tipo]: items } })).toBe(
			'updated',
		);
	}
	return id;
}

async function storedItems(id: number, tipo: string): Promise<Record<string, unknown>[]> {
	const record = await readMatrixRecord(table, SECTION, id);
	const column = (record?.columns.string ?? {}) as Record<string, unknown>;
	const items = column[tipo];
	return Array.isArray(items) ? (items as Record<string, unknown>[]) : [];
}

async function storedValue(id: number, tipo: string, lang: string): Promise<unknown> {
	return (await storedItems(id, tipo)).find((item) => item.lang === lang)?.value;
}

/** What the SAVE door stores for `raw` written into `lang` of a fresh record. */
async function saveDoorStored(raw: string, lang: string): Promise<unknown> {
	const id = await mint(TEXT_AREA, []);
	const outcome = await saveComponentData({
		componentTipo: TEXT_AREA,
		sectionTipo: SECTION,
		sectionId: id,
		lang,
		changedData: [{ action: 'set_data', id: null, value: [{ value: raw, lang }] }],
		userId: -1,
	});
	expect(outcome.ok).toBe(true);
	return await storedValue(id, TEXT_AREA, lang);
}

async function tmRows(id: number, tipo: string): Promise<{ lang: string; data: unknown }[]> {
	return (await sql`
		SELECT lang, data FROM matrix_time_machine
		 WHERE section_tipo = ${SECTION} AND section_id = ${id} AND tipo = ${tipo}
		 ORDER BY id ASC
	`) as { lang: string; data: unknown }[];
}

const stubReturning =
	(text: string): TranslationProvider =>
	async () => ({ ok: true, text, msg: 'ok' });

async function translate(id: number, tipo: string, model: string, provider: TranslationProvider) {
	return await translateAndWrite(await superuserTranslationGrant(SECTION, tipo, id), {
		model,
		sourceLang: 'lg-eng',
		targetLang: 'lg-spa',
		provider,
		uri: URI,
		key: 'k',
	});
}

const HOSTILE = '<p onmouseover="alert(1)">hola</p><img src=x onerror=alert(1)>';

describe('A1/A4 — a hostile provider result is stored as the save door stores it', () => {
	test('stored lg-spa byte-equals the save-door form and carries no handler; TM holds it too', async () => {
		const id = await mint(TEXT_AREA, [{ id: 1, lang: 'lg-eng', value: '<p>hello</p>' }]);
		const outcome = await translate(id, TEXT_AREA, TEXT_AREA_MODEL, stubReturning(HOSTILE));
		expect(outcome.ok).toBe(true);

		const stored = await storedValue(id, TEXT_AREA, 'lg-spa');
		const parity = await saveDoorStored(HOSTILE, 'lg-spa');
		expect(typeof stored).toBe('string');
		expect(stored).toBe(parity as string);
		expect(String(stored)).not.toMatch(/\son\w+\s*=/i);
		expect(String(stored)).toContain('hola');

		// A4: the history row of the target lane holds the gated value.
		const rows = await tmRows(id, TEXT_AREA);
		const spa = rows.filter((row) => row.lang === 'lg-spa');
		expect(spa).toHaveLength(1);
		const serialized = JSON.stringify(spa[0]?.data);
		expect(serialized).not.toMatch(/on(mouseover|error)/i);
		expect(serialized).toContain(JSON.stringify(stored).slice(1, -1));
	});
});

describe('A2 — the real Babel round trip does not resurrect entity-encoded markup', () => {
	test('`&lt;strong onmouseover=…&gt;` source text is not stored live', async () => {
		const answer = '<p>&lt;strong onmouseover=&quot;alert(1)&quot;&gt;hola&lt;/strong&gt;</p>';
		globalThis.fetch = (async () =>
			new Response(answer, { status: 200 })) as unknown as typeof fetch;
		// What the provider itself hands the writer (decode + strip_tags allowlist):
		// the parity raw value, and proof the provider alone does NOT neutralise it.
		const provided = await babelProvider({
			uri: URI,
			key: 'k',
			sourceLang: 'lg-eng',
			targetLang: 'lg-spa',
			text: 'x',
		});
		expect(provided.ok).toBe(true);
		const raw = (provided as { text: string }).text;
		expect(raw).toContain('onmouseover');

		const id = await mint(TEXT_AREA, [
			{
				id: 1,
				lang: 'lg-eng',
				value: '<p>&lt;strong onmouseover=&quot;alert(1)&quot;&gt;hello&lt;/strong&gt;</p>',
			},
		]);
		const outcome = await translate(id, TEXT_AREA, TEXT_AREA_MODEL, babelProvider);
		expect(outcome.ok).toBe(true);
		const stored = await storedValue(id, TEXT_AREA, 'lg-spa');
		expect(String(stored)).not.toContain('onmouseover');
		expect(stored).toBe((await saveDoorStored(raw, 'lg-spa')) as string);
	});
});

describe('A3 — a result empty AFTER the gate is refused, never written', () => {
	test('`<script>` for visible source text → translation.empty_result, record and TM unchanged', async () => {
		const seeded = [{ id: 1, lang: 'lg-eng', value: '<p>hello</p>' }];
		const id = await mint(TEXT_AREA, seeded);
		const before = await readMatrixRecord(table, SECTION, id);
		const outcome = await translate(
			id,
			TEXT_AREA,
			TEXT_AREA_MODEL,
			stubReturning('<script>alert(1)</script>'),
		);
		expect(outcome.ok).toBe(false);
		expect(outcome.emptyResult).toBe(true);
		expect(outcome.count).toBe(0);
		const failure = translationFailure(outcome);
		expect(isDedaloError(failure) && failure.code).toBe('translation.empty_result');

		const after = await readMatrixRecord(table, SECTION, id);
		expect(JSON.stringify(after?.columns.string)).toBe(JSON.stringify(before?.columns.string));
		expect(await storedItems(id, TEXT_AREA)).toEqual(seeded);
		expect(await tmRows(id, TEXT_AREA)).toHaveLength(0);
	});
});

describe('A5/A6 — benign rich text intact; other languages untouched', () => {
	test('formatting + Dédalo marks stored byte-identical; a raw lg-cat value is not rewritten', async () => {
		const benign =
			'<p><strong>hola</strong> <em>mundo</em> [TC_00:00:01.000_TC] [index-n-12-Guerra-data:{"section_tipo":"test3"}:data]</p>';
		// lg-cat seeded RAW, past every gate: a value the translation must not touch.
		const rawCat = '<p onclick="x()">bon dia</p>';
		const id = await mint(TEXT_AREA, [
			{ id: 1, lang: 'lg-eng', value: '<p>hello</p>' },
			{ id: 1, lang: 'lg-cat', value: rawCat },
		]);
		const outcome = await translate(id, TEXT_AREA, TEXT_AREA_MODEL, stubReturning(benign));
		expect(outcome.ok).toBe(true);
		expect(await storedValue(id, TEXT_AREA, 'lg-spa')).toBe(benign);
		expect(await storedValue(id, TEXT_AREA, 'lg-cat')).toBe(rawCat);
		expect(await storedValue(id, TEXT_AREA, 'lg-eng')).toBe('<p>hello</p>');
	});
});

describe('A7 — the gate is keyed on the render class, not on the tool', () => {
	test('a non-html model stores the provider text verbatim', async () => {
		const text = 'a < b <i>x</i>';
		const id = await mint(INPUT_TEXT, [{ id: 1, lang: 'lg-eng', value: 'hello' }]);
		const outcome = await translate(id, INPUT_TEXT, INPUT_TEXT_MODEL, stubReturning(text));
		expect(outcome.ok).toBe(true);
		expect(await storedValue(id, INPUT_TEXT, 'lg-spa')).toBe(text);
	});
});

// ---------------------------------------------------------------------------
// C58 — the Time Machine restore doors
// ---------------------------------------------------------------------------

/** component_number, `properties: {type:'float', precision:4}` → `number` column. */
const NUMBER = 'test211';
/** component_password (a credential) → `string` column, lane lg-nolan. */
const PASSWORD = 'test152';
const ADMIN: Principal = { userId: -1, isGlobalAdmin: true, isDeveloper: true };
/** A stored credential: the password gate passes an Argon2 PHC string through verbatim. */
const STORED_HASH =
	'$argon2id$v=19$m=65536,t=2,p=1$c2FsdHNhbHRzYWx0$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNo';

let tmClock = 0;

/**
 * A history row of `tipo` on record `id` written PAST every gate — the row a
 * door stored before its gate existed. Answers the row's id.
 */
async function mintTmRow(id: number, tipo: string, lang: string, data: unknown): Promise<number> {
	tmClock += 1;
	await recordTimeMachine(
		{ sectionTipo: SECTION, sectionId: id, componentTipo: tipo, lang, userId: -1, data },
		`2017-01-18 10:00:${String(tmClock).padStart(2, '0')}`,
	);
	const rows = (await sql`
		SELECT id FROM matrix_time_machine
		 WHERE section_tipo = ${SECTION} AND section_id = ${id} AND tipo = ${tipo}
		 ORDER BY id DESC LIMIT 1
	`) as { id: number }[];
	const rowId = Number(rows[0]?.id ?? 0);
	expect(rowId).toBeGreaterThan(0);
	return rowId;
}

function restore(id: number, tipo: string, lang: string, matrixId: number) {
	return toolTimeMachineApplyValue({
		principal: ADMIN,
		userId: ADMIN.userId,
		options: { section_tipo: SECTION, section_id: id, tipo, lang, matrix_id: matrixId },
		background: false,
	} as never);
}

async function storedColumnItems(
	id: number,
	column: 'string' | 'number',
	tipo: string,
): Promise<Record<string, unknown>[]> {
	const record = await readMatrixRecord(table, SECTION, id);
	const items = ((record?.columns[column] ?? {}) as Record<string, unknown>)[tipo];
	return Array.isArray(items) ? (items as Record<string, unknown>[]) : [];
}

describe('R1 — a hostile component history row restores as the save door stores it', () => {
	test('stored lg-spa byte-equals the save-door form; its history row too; lg-cat untouched', async () => {
		// lg-cat seeded RAW, past every gate: a lane the lg-spa row does not speak for.
		const rawCat = '<p onclick="x()">bon dia</p>';
		const id = await mint(TEXT_AREA, [
			{ id: 1, lang: 'lg-eng', value: '<p>hello</p>' },
			{ id: 1, lang: 'lg-cat', value: rawCat },
		]);
		const rowId = await mintTmRow(id, TEXT_AREA, 'lg-spa', [
			{ id: 1, lang: 'lg-spa', value: HOSTILE },
		]);
		const answer = (await restore(id, TEXT_AREA, 'lg-spa', rowId)) as { ok?: boolean };
		expect(answer.ok).toBe(true);

		const stored = await storedValue(id, TEXT_AREA, 'lg-spa');
		const parity = await saveDoorStored(HOSTILE, 'lg-spa');
		expect(typeof stored).toBe('string');
		expect(stored).toBe(parity as string);
		expect(String(stored)).not.toMatch(/\son\w+\s*=/i);
		expect(String(stored)).toContain('hola');
		expect(await storedValue(id, TEXT_AREA, 'lg-cat')).toBe(rawCat);
		expect(await storedValue(id, TEXT_AREA, 'lg-eng')).toBe('<p>hello</p>');

		// The restore's OWN history row (newer than the replayed one) holds the gated value.
		const newer = (await sql`
			SELECT data FROM matrix_time_machine
			 WHERE section_tipo = ${SECTION} AND section_id = ${id} AND tipo = ${TEXT_AREA}
			   AND lang = 'lg-spa' AND id > ${rowId}
		`) as { data: unknown }[];
		expect(newer).toHaveLength(1);
		const serialized = JSON.stringify(newer[0]?.data);
		expect(serialized).not.toMatch(/on(mouseover|error)/i);
		expect(serialized).toContain(JSON.stringify(stored).slice(1, -1));
	});
});

describe('R2 — a valid restore is unchanged', () => {
	test('benign rich text + Dédalo marks restore byte-identical', async () => {
		const benign =
			'<p><strong>hola</strong> <em>mundo</em> [TC_00:00:01.000_TC] [index-n-12-Guerra-data:{"section_tipo":"test3"}:data]</p>';
		const id = await mint(TEXT_AREA, [{ id: 1, lang: 'lg-spa', value: '<p>ahora</p>' }]);
		const rowId = await mintTmRow(id, TEXT_AREA, 'lg-spa', [
			{ id: 1, lang: 'lg-spa', value: benign },
		]);
		const answer = (await restore(id, TEXT_AREA, 'lg-spa', rowId)) as { ok?: boolean };
		expect(answer.ok).toBe(true);
		expect(await storedItems(id, TEXT_AREA)).toEqual([{ id: 1, lang: 'lg-spa', value: benign }]);
	});
});

describe('R3 — a whole-record history row is gated key by key', () => {
	test('text area as the save door stores it; number formatted; input_text verbatim', async () => {
		const literal = 'a < b <i>x</i>';
		const id = await mint(TEXT_AREA, [{ id: 1, lang: 'lg-spa', value: '<p>ahora</p>' }]);
		const rowId = await mintTmRow(id, SECTION, 'lg-nolan', {
			string: {
				[TEXT_AREA]: [{ id: 1, lang: 'lg-spa', value: HOSTILE }],
				[INPUT_TEXT]: [{ id: 1, lang: 'lg-spa', value: literal }],
			},
			number: { [NUMBER]: [{ id: 1, lang: 'lg-nolan', value: 1.23456789 }] },
		});
		const answer = (await restore(id, SECTION, 'lg-nolan', rowId)) as { ok?: boolean };
		expect(answer.ok).toBe(true);

		const stored = await storedValue(id, TEXT_AREA, 'lg-spa');
		expect(stored).toBe((await saveDoorStored(HOSTILE, 'lg-spa')) as string);
		expect(String(stored)).not.toMatch(/\son\w+\s*=/i);
		// test211 declares float / precision 4 — the number a save stores.
		expect((await storedColumnItems(id, 'number', NUMBER)).map((item) => item.value)).toEqual([
			1.2346,
		]);
		// Not an `html` render class: the client escapes it, the gate leaves it.
		expect(await storedValue(id, INPUT_TEXT, 'lg-spa')).toBe(literal);

		// The recover's OWN whole-record history row (the record AS WRITTEN, newer
		// than the replayed one) holds the gated values — never the raw image.
		const newer = (await sql`
			SELECT data FROM matrix_time_machine
			 WHERE section_tipo = ${SECTION} AND section_id = ${id} AND tipo = ${SECTION}
			   AND id > ${rowId}
		`) as { data: Record<string, Record<string, { value: unknown }[]>> }[];
		expect(newer).toHaveLength(1);
		const written = newer[0]?.data ?? {};
		expect(JSON.stringify(written)).not.toMatch(/on(mouseover|error)/i);
		expect(written.string?.[TEXT_AREA]?.map((item) => item.value)).toEqual([stored]);
		expect(written.number?.[NUMBER]?.map((item) => item.value)).toEqual([1.2346]);
	});
});

describe('R4 — a credential row that is not a stored hash is refused, never written', () => {
	// 'abc' breaks the policy (a save refuses it); the second conforms (a save
	// would HASH it — a replay must not: it is history bytes, not a new password).
	for (const plaintext of ['abc', 'Conforming-Passw0rd-2017!']) {
		test(`a non-hash row ('${plaintext.slice(0, 3)}…') → tool.snapshot_unrestorable, live value unchanged`, async () => {
			const live = [{ id: 1, lang: 'lg-nolan', value: STORED_HASH }];
			const id = await mint(PASSWORD, live);
			const rowId = await mintTmRow(id, PASSWORD, 'lg-nolan', [
				{ id: 1, lang: 'lg-nolan', value: plaintext },
			]);
			const refusal = await refusalOf(restore(id, PASSWORD, 'lg-nolan', rowId));
			expect(refusal.code).toBe('tool.snapshot_unrestorable');
			expect(JSON.stringify(refusal.coordinates ?? {})).not.toContain(plaintext);
			expect(await storedItems(id, PASSWORD)).toEqual(live);
		});
	}

	test('a WHOLE-RECORD image carrying a non-hash credential is refused whole: no key written, no history row', async () => {
		const liveText = [{ id: 1, lang: 'lg-spa', value: '<p>ahora</p>' }];
		const liveHash = [{ id: 1, lang: 'lg-nolan', value: STORED_HASH }];
		const id = await mint(TEXT_AREA, liveText);
		expect(
			await updateMatrixRecord(table, SECTION, id, {
				string: { [TEXT_AREA]: liveText, [PASSWORD]: liveHash },
			}),
		).toBe('updated');
		const plaintext = 'Conforming-Passw0rd-2017!';
		const rowId = await mintTmRow(id, SECTION, 'lg-nolan', {
			string: {
				// a clean, DIFFERENT text: the refusal is the credential's alone
				[TEXT_AREA]: [{ id: 1, lang: 'lg-spa', value: '<p>antes</p>' }],
				[PASSWORD]: [{ id: 1, lang: 'lg-nolan', value: plaintext }],
			},
		});
		const refusal = await refusalOf(restore(id, SECTION, 'lg-nolan', rowId));
		expect(refusal.code).toBe('tool.snapshot_unrestorable');
		expect(JSON.stringify(refusal.coordinates ?? {})).not.toContain(plaintext);
		expect(await storedItems(id, TEXT_AREA)).toEqual(liveText);
		expect(await storedItems(id, PASSWORD)).toEqual(liveHash);
		const newer = (await sql`
			SELECT id FROM matrix_time_machine
			 WHERE section_tipo = ${SECTION} AND section_id = ${id} AND id > ${rowId}
		`) as { id: number }[];
		expect(newer).toEqual([]);
	});

	test('a stored hash replays verbatim (never re-hashed)', async () => {
		const other = `${STORED_HASH}x`;
		const id = await mint(PASSWORD, [{ id: 1, lang: 'lg-nolan', value: other }]);
		const rowId = await mintTmRow(id, PASSWORD, 'lg-nolan', [
			{ id: 1, lang: 'lg-nolan', value: STORED_HASH },
		]);
		const answer = (await restore(id, PASSWORD, 'lg-nolan', rowId)) as { ok?: boolean };
		expect(answer.ok).toBe(true);
		expect(await storedItems(id, PASSWORD)).toEqual([
			{ id: 1, lang: 'lg-nolan', value: STORED_HASH },
		]);
	});
});

describe('R5 — a legacy v6 ciphertext credential replays VERBATIM (owner ruling 2026-11-18)', () => {
	// The v6 storage format, built by the suite's own encryptor (no PHP binary):
	// base64( base64( AES-256-CBC( serialize(password) ) ) ).
	const CIPHERTEXT = encryptLegacyPasswordForTest('v6-era-password', {
		information: DEFAULT_INFORMATION,
		infoKey: 'test_entity',
	});

	test('floor: the fixture is a v6 ciphertext, not a hash — a SAVE of it would mint a hash', () => {
		expect(isLegacyEncryptedPassword(CIPHERTEXT)).toBe(true);
		expect(isArgon2Hash(CIPHERTEXT)).toBe(false);
	});

	test('a component row holding it restores byte-identical: not refused, not hashed', async () => {
		const id = await mint(PASSWORD, [{ id: 1, lang: 'lg-nolan', value: STORED_HASH }]);
		const rowId = await mintTmRow(id, PASSWORD, 'lg-nolan', [
			{ id: 1, lang: 'lg-nolan', value: CIPHERTEXT },
		]);
		const answer = (await restore(id, PASSWORD, 'lg-nolan', rowId)) as { ok?: boolean };
		expect(answer.ok).toBe(true);
		expect(await storedItems(id, PASSWORD)).toEqual([
			{ id: 1, lang: 'lg-nolan', value: CIPHERTEXT },
		]);
	});

	test('a WHOLE-RECORD image holding it is restored: the credential verbatim, its other keys gated', async () => {
		const id = await mint(TEXT_AREA, [{ id: 1, lang: 'lg-spa', value: '<p>ahora</p>' }]);
		const rowId = await mintTmRow(id, SECTION, 'lg-nolan', {
			string: {
				[TEXT_AREA]: [{ id: 1, lang: 'lg-spa', value: HOSTILE }],
				[PASSWORD]: [{ id: 1, lang: 'lg-nolan', value: CIPHERTEXT }],
			},
		});
		const answer = (await restore(id, SECTION, 'lg-nolan', rowId)) as { ok?: boolean };
		expect(answer.ok).toBe(true);
		expect(await storedItems(id, PASSWORD)).toEqual([
			{ id: 1, lang: 'lg-nolan', value: CIPHERTEXT },
		]);
		expect(await storedValue(id, TEXT_AREA, 'lg-spa')).toBe(
			(await saveDoorStored(HOSTILE, 'lg-spa')) as string,
		);
	});

	// Shapes that are NOT the v6 format: one base64 layer over an AES-sized body
	// (a plaintext that happens to be base64), and two layers over a body that
	// is no whole number of AES blocks.
	const oneLayer = Buffer.alloc(32, 7).toString('base64');
	const badBlocks = Buffer.from(Buffer.alloc(20, 7).toString('base64'), 'utf8').toString('base64');
	for (const [what, lookalike] of [
		['one base64 layer', oneLayer],
		['a body that is no AES block run', badBlocks],
	] as const) {
		test(`a look-alike (${what}) is still refused — never written raw, never hashed`, async () => {
			expect(isLegacyEncryptedPassword(lookalike)).toBe(false);
			const live = [{ id: 1, lang: 'lg-nolan', value: STORED_HASH }];
			const id = await mint(PASSWORD, live);
			const rowId = await mintTmRow(id, PASSWORD, 'lg-nolan', [
				{ id: 1, lang: 'lg-nolan', value: lookalike },
			]);
			const refusal = await refusalOf(restore(id, PASSWORD, 'lg-nolan', rowId));
			expect(refusal.code).toBe('tool.snapshot_unrestorable');
			expect(await storedItems(id, PASSWORD)).toEqual(live);
		});
	}
});

// ---------------------------------------------------------------------------
// C58 — the bulk revert's writers (owner ruling 2026-11-18)
// ---------------------------------------------------------------------------

const GTLD = 'zzvgr';
const GSECTION = `${GTLD}1`;
const GTEXT = `${GTLD}2`; // component_text_area, translatable (html, lang-sliced)
const GNUM = `${GTLD}3`; // component_number, float / precision 2
const GPASS = `${GTLD}4`; // component_password
const GMAIN = `${GTLD}5`; // component_number WITH a dataframe slot — a composed unit
const GSLOT = `${GTLD}6`;
const GTABLE = 'matrix_test';

const GATES_SITUATION = situation({
	tld: GTLD,
	name: 'bulk_revert_value_gates',
	nodes: [
		{ tipo: GSECTION, parent: 'test1', model: 'section', term: { 'lg-eng': 'Revert gates' } },
		{
			tipo: GTEXT,
			parent: GSECTION,
			model: 'component_text_area',
			term: { 'lg-eng': 'Text' },
			is_translatable: true,
		},
		{
			tipo: GNUM,
			parent: GSECTION,
			model: 'component_number',
			term: { 'lg-eng': 'Number' },
			properties: { type: 'float', precision: 2 },
		},
		{ tipo: GPASS, parent: GSECTION, model: 'component_password', term: { 'lg-eng': 'Secret' } },
		{
			tipo: GMAIN,
			parent: GSECTION,
			model: 'component_number',
			term: { 'lg-eng': 'Framed number' },
			properties: { type: 'float', precision: 2, has_dataframe: true },
		},
		{ tipo: GSLOT, parent: GMAIN, model: 'component_dataframe', term: { 'lg-eng': 'Slot' } },
	],
});

interface RevertReport {
	counter: number;
	unchanged: number;
	bulk_process_id: number;
	exact: 'full' | 'partial' | 'none';
	skipped: BulkRevertSkipped[];
	inexact: { basis: string; section_tipo: string; section_id: number }[];
}

describe('B — the bulk revert writes its images gated like a save', () => {
	const runs: number[] = [];
	let bulkTable = '';
	const CIPHERTEXT = encryptLegacyPasswordForTest('another-v6-password', {
		information: DEFAULT_INFORMATION,
		infoKey: 'test_entity',
	});
	const PLAINTEXT = 'Conforming-Passw0rd-2017!';
	const RAW_NUMBER = 1.23456789;

	beforeAll(async () => {
		await assertTestDatabase('translation_write_gates_native');
		await ensureSituation(GATES_SITUATION);
		// STRUCTURE FLOOR — the unit kinds below depend on it.
		expect(await getMatrixTableFromTipo(GSECTION)).toBe(GTABLE);
		expect(await resolveDataframeSlotTipos(GMAIN)).toEqual([GSLOT]);
		expect(await resolveDataframeSlotTipos(GNUM)).toEqual([]);
		bulkTable = (await getMatrixTableFromTipo('dd800')) as string;
	}, 60_000);

	afterAll(async () => {
		await assertTestDatabase('translation_write_gates_native');
		await sql.unsafe('DELETE FROM matrix_time_machine WHERE section_tipo = $1', [GSECTION]);
		await sql.unsafe('DELETE FROM dedalo_ts_record_generation WHERE section_tipo = $1', [GSECTION]);
		await sql.unsafe(`DELETE FROM "${GTABLE}" WHERE section_tipo = $1`, [GSECTION]);
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
		await sql.unsafe(`DELETE FROM matrix_activity WHERE data->>'section_tipo' = $1`, [GSECTION]);
		expect(await dropSituation(GATES_SITUATION)).toBe(0);
	});

	const rec = (): Promise<number> => createSectionRecord(GSECTION, -1);

	/** A REAL dd800 run record. */
	async function run(): Promise<number> {
		const id = await createSectionRecord('dd800', -1);
		runs.push(id);
		return id;
	}

	/** Store `value` under a key PAST every gate — what a pre-gate door left there. */
	async function seed(id: number, column: string, key: string, value: unknown): Promise<void> {
		await sql.unsafe(
			`UPDATE "${GTABLE}" SET ${column} = COALESCE(${column}, '{}'::jsonb) || jsonb_build_object($3::text, $4::text::jsonb)
			 WHERE section_tipo = $1 AND section_id = $2`,
			[GSECTION, id, key, JSON.stringify(value)],
		);
	}

	/** The stored key (`undefined` = absent, 'NO-RECORD' = no row). */
	async function stored(id: number, column: string, key: string): Promise<unknown> {
		const rows = (await sql.unsafe(
			`SELECT (${column} ? $3) AS present, ${column}->$3 AS v FROM "${GTABLE}"
			 WHERE section_tipo = $1 AND section_id = $2`,
			[GSECTION, id, key],
		)) as { present: boolean | null; v: unknown }[];
		if (rows.length === 0) return 'NO-RECORD';
		return rows[0]?.present === true ? rows[0]?.v : undefined;
	}

	const valuesOf = (value: unknown): unknown[] =>
		(Array.isArray(value) ? (value as { value: unknown }[]) : []).map((item) => item.value);
	const langValue = (value: unknown, lang: string): unknown =>
		(Array.isArray(value) ? (value as { lang?: string; value: unknown }[]) : []).find(
			(item) => item.lang === lang,
		)?.value;

	/** set_data of ONE item (id 1) of `tipo` in `lang`, through the save door. */
	async function save(
		id: number,
		tipo: string,
		lang: string,
		value: unknown,
		bulk: number | null = null,
	): Promise<void> {
		const saved = await saveComponentData({
			componentTipo: tipo,
			sectionTipo: GSECTION,
			sectionId: id,
			lang,
			changedData: [{ action: 'set_data', id: null, value: [{ id: 1, lang, value }] }],
			userId: -1,
			bulkProcessId: bulk,
		});
		expect(saved.ok).toBe(true);
	}

	async function revert(bulk: number): Promise<RevertReport> {
		const response = await toolTimeMachineBulkRevert({
			principal: await resolvePrincipal(-1),
			userId: -1,
			options: { bulk_process_id: bulk },
			background: false,
		});
		expect(response.ok).toBe(true);
		const data = response.data as RevertReport;
		runs.push(data.bulk_process_id);
		return data;
	}

	/** What the SAVE door stores for `raw` in lg-spa of GTEXT (cross-door parity). */
	async function saveDoorText(raw: string): Promise<string> {
		const id = await rec();
		await save(id, GTEXT, 'lg-spa', raw);
		return String(langValue(await stored(id, 'string', GTEXT), 'lg-spa'));
	}

	test('B1 — a hostile pre-run text image reverts to the save-door form; a repeat is unchanged; the revert of the revert chains', async () => {
		const rawCat = '<p onclick="x()">bon dia</p>';
		const id = await rec();
		await seed(id, 'string', GTEXT, [
			{ id: 1, lang: 'lg-spa', value: HOSTILE },
			{ id: 1, lang: 'lg-cat', value: rawCat },
		]);
		const bulk = await run();
		await save(id, GTEXT, 'lg-spa', '<p>run</p>', bulk);
		expect(langValue(await stored(id, 'string', GTEXT), 'lg-spa')).toBe('<p>run</p>');

		const first = await revert(bulk);
		expect(first.skipped).toEqual([]);
		expect(first.counter).toBe(1);
		const live = await stored(id, 'string', GTEXT);
		const parity = await saveDoorText(HOSTILE);
		expect(langValue(live, 'lg-spa')).toBe(parity);
		expect(parity).not.toMatch(/\son\w+\s*=/i);
		expect(parity).toContain('hola');
		// The lane the run never wrote is not this revert's to rewrite.
		expect(langValue(live, 'lg-cat')).toBe(rawCat);

		// A second revert of the SAME run: the key holds what a revert leaves.
		const again = await revert(bulk);
		expect(again.skipped).toEqual([]);
		expect(again.counter).toBe(0);
		expect(again.unchanged).toBe(1);

		// The revert is itself exactly revertible (its own pair holds the gated bytes).
		const back = await revert(first.bulk_process_id);
		expect(back.skipped).toEqual([]);
		expect(langValue(await stored(id, 'string', GTEXT), 'lg-spa')).toBe('<p>run</p>');
	});

	test('B1 — the legacy path (a run with no BEFORE rows) writes the inferred image gated, and a repeat is unchanged', async () => {
		const id = await rec();
		await seed(id, 'string', GTEXT, [{ id: 1, lang: 'lg-spa', value: HOSTILE }]);
		const bulk = await run();
		await save(id, GTEXT, 'lg-spa', '<p>run</p>', bulk);
		// The save-before backfill row holds the raw pre-run value: the legacy pre-run row.
		expect(await demoteToLegacyRun(bulk)).toBeGreaterThan(0);

		const first = await revert(bulk);
		expect(first.skipped).toEqual([]);
		expect(first.inexact.map((entry) => entry.basis)).toEqual(['legacy_inference']);
		expect(langValue(await stored(id, 'string', GTEXT), 'lg-spa')).toBe(
			await saveDoorText(HOSTILE),
		);
		const again = await revert(bulk);
		expect(again.skipped).toEqual([]);
		expect(again.counter).toBe(0);
	});

	test('B2 — a pre-run number image is formatted as its node declares; a repeat is unchanged', async () => {
		const id = await rec();
		await seed(id, 'number', GNUM, [{ id: 1, lang: 'lg-nolan', value: RAW_NUMBER }]);
		const bulk = await run();
		await save(id, GNUM, 'lg-nolan', 5, bulk);
		expect(valuesOf(await stored(id, 'number', GNUM))).toEqual([5]);

		const first = await revert(bulk);
		expect(first.skipped).toEqual([]);
		expect(valuesOf(await stored(id, 'number', GNUM))).toEqual([1.23]);
		const again = await revert(bulk);
		expect(again.skipped).toEqual([]);
		expect(again.unchanged).toBe(1);
	});

	test('B3 — a credential image that is no hash and no v6 ciphertext refuses ITS unit, typed and located; the rest of the run reverts', async () => {
		const id = await rec();
		await seed(id, 'string', GPASS, [{ id: 1, lang: 'lg-nolan', value: PLAINTEXT }]);
		await seed(id, 'number', GNUM, [{ id: 1, lang: 'lg-nolan', value: 2 }]);
		const bulk = await run();
		await save(id, GPASS, 'lg-nolan', STORED_HASH, bulk);
		await save(id, GNUM, 'lg-nolan', 9, bulk);
		expect(valuesOf(await stored(id, 'string', GPASS))).toEqual([STORED_HASH]);

		const report = await revert(bulk);
		expect(report.skipped).toHaveLength(1);
		expect(report.skipped[0]).toMatchObject({
			reason: 'failed',
			code: 'tool.snapshot_unrestorable',
			section_tipo: GSECTION,
			section_id: id,
			tipo: GPASS,
		});
		expect(report.exact).toBe('partial');
		expect(JSON.stringify(report)).not.toContain(PLAINTEXT);
		// Nothing written to the credential; the other unit reverted.
		expect(valuesOf(await stored(id, 'string', GPASS))).toEqual([STORED_HASH]);
		expect(valuesOf(await stored(id, 'number', GNUM))).toEqual([2]);
	});

	test('B3 — a v6 ciphertext credential image is put back verbatim (never refused, never hashed)', async () => {
		const id = await rec();
		await seed(id, 'string', GPASS, [{ id: 1, lang: 'lg-nolan', value: CIPHERTEXT }]);
		const bulk = await run();
		await save(id, GPASS, 'lg-nolan', STORED_HASH, bulk);
		const report = await revert(bulk);
		expect(report.skipped).toEqual([]);
		expect(valuesOf(await stored(id, 'string', GPASS))).toEqual([CIPHERTEXT]);
	});

	test('B4 — a COMPOSED unit (a main with a dataframe slot) writes its main gated; a repeat is unchanged', async () => {
		const id = await rec();
		await seed(id, 'number', GMAIN, [{ id: 1, lang: 'lg-nolan', value: RAW_NUMBER }]);
		const bulk = await run();
		await save(id, GMAIN, 'lg-nolan', 7, bulk);
		expect(valuesOf(await stored(id, 'number', GMAIN))).toEqual([7]);

		const first = await revert(bulk);
		expect(first.skipped).toEqual([]);
		expect(first.counter).toBe(1);
		expect(valuesOf(await stored(id, 'number', GMAIN))).toEqual([1.23]);
		const again = await revert(bulk);
		expect(again.skipped).toEqual([]);
		expect(again.counter).toBe(0);
		const back = await revert(first.bulk_process_id);
		expect(back.skipped).toEqual([]);
		expect(valuesOf(await stored(id, 'number', GMAIN))).toEqual([7]);
	});

	test('B5 — a record a run WIPED gets its pre-wipe values back gated; a repeat finds it present', async () => {
		const id = await rec();
		await seed(id, 'string', GTEXT, [{ id: 1, lang: 'lg-spa', value: HOSTILE }]);
		await seed(id, 'number', GNUM, [{ id: 1, lang: 'lg-nolan', value: RAW_NUMBER }]);
		const bulk = await run();
		await deleteSectionData(GSECTION, id, -1, new Date(), { bulkProcessId: bulk });
		// FLOOR: the wipe emptied the keys and kept the row.
		expect(await stored(id, 'string', GTEXT)).toBeUndefined();
		expect(await stored(id, 'number', GNUM)).toBeUndefined();

		const first = await revert(bulk);
		expect(first.skipped).toEqual([]);
		expect(first.inexact.map((entry) => entry.basis)).toEqual(['cascade_undelete']);
		expect(langValue(await stored(id, 'string', GTEXT), 'lg-spa')).toBe(
			await saveDoorText(HOSTILE),
		);
		expect(valuesOf(await stored(id, 'number', GNUM))).toEqual([1.23]);

		// The record holds what the restore leaves: nothing to do, nothing alarming.
		const again = await revert(bulk);
		expect(again.skipped).toEqual([]);
		expect(again.inexact).toEqual([]);
	});

	test('B5 — a run that wrote a key on a record and then wiped it: the unit puts the key back gated, and a repeat revert is unchanged, full', async () => {
		const id = await rec();
		await seed(id, 'string', GTEXT, [{ id: 1, lang: 'lg-spa', value: HOSTILE }]);
		const bulk = await run();
		await save(id, GTEXT, 'lg-spa', '<p>run</p>', bulk);
		await deleteSectionData(GSECTION, id, -1, new Date(), { bulkProcessId: bulk });
		expect(await stored(id, 'string', GTEXT)).toBeUndefined();

		const first = await revert(bulk);
		expect(first.skipped).toEqual([]);
		// the wipe undone (the run's value back), then the run's key reverted — gated
		expect(langValue(await stored(id, 'string', GTEXT), 'lg-spa')).toBe(
			await saveDoorText(HOSTILE),
		);
		// The record is at the state the revert PRODUCES (its snapshot with the
		// unit's restore as the write stores it): not "written since".
		const again = await revert(bulk);
		expect(again.skipped).toEqual([]);
		expect(again.inexact).toEqual([]);
		expect(again.exact).toBe('full');
		expect(again.counter).toBe(0);
	});

	test('B5 — the same on a COMPOSED main of the wiped record: put back gated, a repeat revert unchanged, full', async () => {
		const id = await rec();
		await seed(id, 'number', GMAIN, [{ id: 1, lang: 'lg-nolan', value: RAW_NUMBER }]);
		const bulk = await run();
		await save(id, GMAIN, 'lg-nolan', 7, bulk);
		await deleteSectionData(GSECTION, id, -1, new Date(), { bulkProcessId: bulk });
		expect(await stored(id, 'number', GMAIN)).toBeUndefined();

		const first = await revert(bulk);
		expect(first.skipped).toEqual([]);
		expect(valuesOf(await stored(id, 'number', GMAIN))).toEqual([1.23]);
		const again = await revert(bulk);
		expect(again.skipped).toEqual([]);
		expect(again.inexact).toEqual([]);
		expect(again.exact).toBe('full');
		expect(again.counter).toBe(0);
	});

	test('B5 — a wiped record whose credential image is not replayable is refused whole, typed and located', async () => {
		const id = await rec();
		await seed(id, 'string', GTEXT, [{ id: 1, lang: 'lg-spa', value: '<p>antes</p>' }]);
		await seed(id, 'string', GPASS, [{ id: 1, lang: 'lg-nolan', value: PLAINTEXT }]);
		const bulk = await run();
		await deleteSectionData(GSECTION, id, -1, new Date(), { bulkProcessId: bulk });

		const report = await revert(bulk);
		expect(report.skipped).toHaveLength(1);
		expect(report.skipped[0]).toMatchObject({
			reason: 'failed',
			code: 'tool.snapshot_unrestorable',
			section_tipo: GSECTION,
			section_id: id,
		});
		expect(JSON.stringify(report)).not.toContain(PLAINTEXT);
		// All-or-nothing: no key of the record came back.
		expect(await stored(id, 'string', GTEXT)).toBeUndefined();
		expect(await stored(id, 'string', GPASS)).toBeUndefined();
	});

	test('B5 — a unit of a wiped record whose restore is refused fails with it; nothing of the record is written', async () => {
		const id = await rec();
		await seed(id, 'string', GTEXT, [{ id: 1, lang: 'lg-spa', value: '<p>antes</p>' }]);
		await seed(id, 'string', GPASS, [{ id: 1, lang: 'lg-nolan', value: PLAINTEXT }]);
		const bulk = await run();
		// the run writes a key of the record (a unit of its OWN record), then wipes it
		await save(id, GTEXT, 'lg-spa', '<p>run</p>', bulk);
		await deleteSectionData(GSECTION, id, -1, new Date(), { bulkProcessId: bulk });

		const report = await revert(bulk);
		// The unit failed, and its record stayed wiped. Neither entry is located:
		// a unit of the wiped record judges that record's scope in the very
		// prelude the refusal interrupted (SEC-16 — reason alone).
		expect(report.skipped.map((entry) => entry.reason).sort()).toEqual([
			'cascade_delete_not_reverted',
			'failed',
		]);
		expect(report.counter).toBe(0);
		expect(JSON.stringify(report)).not.toContain(PLAINTEXT);
		// the unit's transaction rolled the record's partial restore back with it
		expect(await stored(id, 'string', GTEXT)).toBeUndefined();
		expect(await stored(id, 'string', GPASS)).toBeUndefined();
	});

	test('B6 — the undelete door inserts the snapshot gated; a v6 ciphertext verbatim; a plaintext credential refuses the whole row', async () => {
		const free = async (): Promise<number> => {
			const id = await rec();
			expect(await deleteMatrixRecord(GTABLE, GSECTION, id)).toBe(1);
			return id;
		};
		const snapshot = (credential: string) => ({
			string: {
				[GTEXT]: [{ id: 1, lang: 'lg-spa', value: HOSTILE }],
				[GPASS]: [{ id: 1, lang: 'lg-nolan', value: credential }],
			},
			number: { [GNUM]: [{ id: 1, lang: 'lg-nolan', value: RAW_NUMBER }] },
		});

		const id = await free();
		const written = await restoreAbsentSectionRow(snapshot(CIPHERTEXT), 0, GSECTION, id, false, -1);
		expect(written).not.toBeNull();
		expect(langValue(await stored(id, 'string', GTEXT), 'lg-spa')).toBe(
			await saveDoorText(HOSTILE),
		);
		expect(valuesOf(await stored(id, 'number', GNUM))).toEqual([1.23]);
		expect(valuesOf(await stored(id, 'string', GPASS))).toEqual([CIPHERTEXT]);

		const refusedId = await free();
		const refusal = await refusalOf(
			restoreAbsentSectionRow(snapshot(PLAINTEXT), 0, GSECTION, refusedId, false, -1),
		);
		expect(refusal.code).toBe('tool.snapshot_unrestorable');
		expect(await stored(refusedId, 'string', GTEXT)).toBe('NO-RECORD');
	});
});
