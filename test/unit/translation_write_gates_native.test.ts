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
import { saveComponentData } from '../../src/core/section/record/save_component.ts';
import type { Principal } from '../../src/core/security/permissions.ts';
import { assertTestDatabase } from '../../src/core/test_data/test_database_marker.ts';
import {
	babelProvider,
	type TranslationProvider,
	translateAndWrite,
	translationFailure,
} from '../../src/core/tools/translation.ts';
import { toolTimeMachineApplyValue } from '../../tools/tool_time_machine/server/tool_time_machine.ts';
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
