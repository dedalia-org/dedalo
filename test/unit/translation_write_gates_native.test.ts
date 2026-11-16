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
import { isDedaloError } from '../../src/core/errors/dedalo_error.ts';
import { getMatrixTableFromTipo } from '../../src/core/ontology/resolver.ts';
import { saveComponentData } from '../../src/core/section/record/save_component.ts';
import { assertTestDatabase } from '../../src/core/test_data/test_database_marker.ts';
import {
	babelProvider,
	type TranslationProvider,
	translateAndWrite,
	translationFailure,
} from '../../src/core/tools/translation.ts';
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
