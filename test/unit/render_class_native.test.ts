/**
 * NATIVE gate — the per-model RENDER CLASS is one fact with two consequences
 * (P2-6 / CARRY-01, XSS-03).
 *
 * The descriptor's `render` facet decides, once per model:
 *   - on SAVE: the write engine runs the ONE HTML sanitizer iff the class is
 *     'html' (save_component.ts). Before this facet the check was the model
 *     string `component_text_area`, which is exactly the kind of rule that is
 *     true until the next model that stores markup;
 *   - on READ: the structure context stamps `render_class` on every component
 *     entry (WC-2026-09-04-context-render-class), and the client's ONE escaper
 *     switches on it (render_escape_tripwire holds the client half).
 *
 * This file BUILDS its situation on a `zz` scratch TLD: one section with a
 * rich-text component (html), a plain text one (text), a number (number) and
 * an IRI (url); saves a script payload through the real saveComponentData into
 * the html-class and the text-class components and reads the raw column back;
 * then builds the structure context for each and reads the stamped class.
 *
 * Not hermetic: the situation is dd_ontology rows and matrix_test records on
 * the SUITE database (dedalo_test_marker), written and swept through the
 * engine's own doors.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { getComponentModel, getRenderClass } from '../../src/core/components/registry.ts';
import { sql } from '../../src/core/db/postgres.ts';
import { getMatrixTableFromTipo } from '../../src/core/ontology/resolver.ts';
import { buildStructureContext } from '../../src/core/resolve/structure_context.ts';
import { saveComponentData } from '../../src/core/section/record/save_component.ts';
import {
	dropSituation,
	ensureSituation,
	situation,
} from '../../src/core/test_data/situations/situation.ts';
import { cleanScratchRecord } from '../helpers/test_data.ts';

const TEST_TABLE = 'matrix_test';
const SECTION = 'zzrcl1';
const RICH_TEXT = 'zzrcl2'; // component_text_area → 'html'
const PLAIN_TEXT = 'zzrcl3'; // component_input_text → 'text'
const NUMBER = 'zzrcl4'; // component_number → 'number'
const IRI = 'zzrcl5'; // component_iri → 'url'
const LEGACY_HTML = 'zzrcl6'; // component_html_text alias → 'html' through the hop
const NO_DESCRIPTOR = 'zzrcl7'; // component_ip: a model the registry does not describe
const ANCHOR_ID = 917310;
const RECORD_ID = 917311;

const PAYLOAD = '<p>Hello</p><script>alert(1)</script><img src=x onerror="alert(2)">';

const SITUATION = situation({
	tld: 'zzrcl',
	name: 'render_class_native',
	nodes: [
		{
			tipo: SECTION,
			parent: 'test1',
			model: 'section',
			term: { 'lg-eng': 'Render class' },
			relations: [{ tipo: 'test24' }],
		},
		{ tipo: RICH_TEXT, parent: SECTION, model: 'component_text_area', term: { 'lg-eng': 'Rich' } },
		{
			tipo: PLAIN_TEXT,
			parent: SECTION,
			model: 'component_input_text',
			term: { 'lg-eng': 'Plain' },
		},
		{ tipo: NUMBER, parent: SECTION, model: 'component_number', term: { 'lg-eng': 'Number' } },
		{ tipo: IRI, parent: SECTION, model: 'component_iri', term: { 'lg-eng': 'IRI' } },
		{
			tipo: LEGACY_HTML,
			parent: SECTION,
			model: 'component_html_text',
			term: { 'lg-eng': 'Legacy' },
		},
		{ tipo: NO_DESCRIPTOR, parent: SECTION, model: 'component_ip', term: { 'lg-eng': 'IP' } },
	],
	records: [{ section_tipo: SECTION, section_id: ANCHOR_ID }],
});

async function storedItems(
	componentTipo: string,
	column: 'string' | 'iri' | 'number' = 'string',
): Promise<{ value: unknown }[] | null> {
	const rows = (await sql.unsafe(
		`SELECT ${column}->$1 AS items FROM ${TEST_TABLE} WHERE section_tipo = $2 AND section_id = $3`,
		[componentTipo, SECTION, RECORD_ID],
	)) as { items: { value: unknown }[] | null }[];
	return rows[0]?.items ?? null;
}

async function storedValues(
	componentTipo: string,
	column: 'string' | 'iri' | 'number' = 'string',
): Promise<unknown[]> {
	return ((await storedItems(componentTipo, column)) ?? []).map((item) => item.value);
}

async function saveInto(componentTipo: string, value: string): Promise<void> {
	const outcome = await saveComponentData({
		componentTipo,
		sectionTipo: SECTION,
		sectionId: RECORD_ID,
		lang: 'lg-nolan',
		changedData: [{ action: 'insert', id: null, value: { id: null, lang: 'lg-nolan', value } }],
		userId: -1,
	});
	expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
}

beforeAll(async () => {
	await ensureSituation(SITUATION);
	expect(await getMatrixTableFromTipo(SECTION)).toBe(TEST_TABLE);
	await cleanScratchRecord(SECTION, RECORD_ID, TEST_TABLE);
});

afterAll(async () => {
	await cleanScratchRecord(SECTION, RECORD_ID, TEST_TABLE);
	expect(await dropSituation(SITUATION)).toBe(0);
});

describe('render class — the save half', () => {
	test("a script payload saved into the 'html' class is SANITIZED, formatting kept", async () => {
		expect(getRenderClass('component_text_area')).toBe('html');
		await saveInto(RICH_TEXT, PAYLOAD);
		const [stored] = await storedValues(RICH_TEXT);
		expect(stored).toBeDefined();
		expect(stored).toContain('<p>Hello</p>');
		expect(stored).not.toContain('<script');
		expect(stored).not.toContain('onerror');
	}, 30000);

	test("the same payload saved into the 'text' class is stored VERBATIM — the client escapes it", async () => {
		// Storing text verbatim is correct: the value IS the text the user typed,
		// and the client renders a 'text' class through escape_html. Sanitizing
		// here would silently alter a plain field's content.
		expect(getRenderClass('component_input_text')).toBe('text');
		await saveInto(PLAIN_TEXT, PAYLOAD);
		expect(await storedValues(PLAIN_TEXT)).toEqual([PAYLOAD]);
	}, 30000);

	test("the 'number' and 'url' classes store VERBATIM too — 'html' is the ONE class that sanitizes", async () => {
		// The sanitizer is keyed on `=== 'html'`, not on `!== 'text'`: a number
		// or an IRI that fails its own shape is the client's to escape (the
		// 'number' class renders non-numerals as text, 'url' renders a refused
		// scheme as text), never a value the write engine rewrites.
		// A number item whose `value` is a string is not a number item at all: since
		// 2026-10-03 the save door's value-shape law refuses it before any value
		// gate runs (WC-2026-10-03-save-refuses-malformed-value-shape) — refused,
		// never rewritten, and nothing stored: the number a canonical save put there
		// first is exactly what the column still holds after the refusal.
		expect(getRenderClass('component_number')).toBe('number');
		const numberSaved = await saveComponentData({
			componentTipo: NUMBER,
			sectionTipo: SECTION,
			sectionId: RECORD_ID,
			lang: 'lg-nolan',
			changedData: [{ action: 'insert', id: null, value: { id: null, value: 42 } }],
			userId: -1,
		});
		expect(numberSaved.ok, JSON.stringify(numberSaved)).toBe(true);
		const numberBefore = await storedItems(NUMBER, 'number');
		expect(numberBefore?.map((item) => item.value)).toEqual([42]);
		await expect(saveInto(NUMBER, PAYLOAD)).rejects.toMatchObject({
			code: 'request.invalid_data',
		});
		expect(await storedItems(NUMBER, 'number')).toEqual(numberBefore);
		expect(getRenderClass('component_iri')).toBe('url');
		await saveInto(IRI, PAYLOAD);
		expect(await storedValues(IRI, 'iri')).toEqual([PAYLOAD]);
	}, 30000);

	test("the legacy html_text alias saves as 'html' too (one class, through the alias hop)", async () => {
		expect(getRenderClass('component_html_text')).toBe('html');
		await saveInto(LEGACY_HTML, PAYLOAD);
		const [stored] = await storedValues(LEGACY_HTML);
		expect(stored).toContain('<p>Hello</p>');
		expect(stored).not.toContain('<script');
	}, 30000);

	test('a model WITHOUT a descriptor keeps the graceful `no matrix column` refusal (no throw)', async () => {
		// the render-class hop must not run ahead of the column check: a
		// descriptor-less model (component_ip, component_layout, …) has no class
		// AND no column, and the write engine answers {ok:false}, never a throw
		// the converter would turn into internal.unexpected
		expect(getComponentModel('component_ip')).toBeUndefined();
		expect(() => getRenderClass('component_ip')).toThrow(/no descriptor/);
		const outcome = await saveComponentData({
			componentTipo: NO_DESCRIPTOR,
			sectionTipo: SECTION,
			sectionId: RECORD_ID,
			lang: 'lg-nolan',
			changedData: [
				{ action: 'insert', id: null, value: { id: null, lang: 'lg-nolan', value: PAYLOAD } },
			],
			userId: -1,
		});
		expect(outcome).toEqual({ ok: false, message: "no matrix column for model 'component_ip'" });
		// nothing was written under the tipo (the key is absent, not an empty list)
		expect(await storedItems(NO_DESCRIPTOR)).toBeNull();
	}, 30000);
});

describe('render class — the read half', () => {
	const expected: ReadonlyArray<[string, string, string]> = [
		[RICH_TEXT, 'component_text_area', 'html'],
		[PLAIN_TEXT, 'component_input_text', 'text'],
		[NUMBER, 'component_number', 'number'],
		[IRI, 'component_iri', 'url'],
		[LEGACY_HTML, 'component_text_area', 'html'],
	];

	for (const [tipo, model, renderClass] of expected) {
		for (const mode of ['edit', 'list'] as const) {
			test(`${model} ${mode}: the context entry carries render_class '${renderClass}'`, async () => {
				const entry = await buildStructureContext({
					configFrom: { source: 'own', reason: 'unit-test' },
					tipo,
					sectionTipo: SECTION,
					mode,
					lang: 'lg-eng',
					permissions: 3,
				});
				expect(entry).not.toBeNull();
				expect(entry?.model).toBe(model);
				expect(entry?.render_class).toBe(renderClass as never);
			});
		}
	}

	test('a SECTION entry carries no render_class at all (it has no value)', async () => {
		const entry = await buildStructureContext({
			configFrom: { source: 'own', reason: 'unit-test' },
			tipo: SECTION,
			sectionTipo: SECTION,
			mode: 'edit',
			lang: 'lg-eng',
			permissions: 3,
		});
		expect(entry).not.toBeNull();
		expect('render_class' in (entry as object)).toBe(false);
	});
});
