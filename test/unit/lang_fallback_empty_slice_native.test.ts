/**
 * LANGUAGE FALLBACK judges a lang slice by EMPTINESS, not item count
 * (T1-34 / O14; WC-2026-11-12-lang-fallback-judges-emptiness).
 *
 * A cleared translation is persisted as `{id, lang, value: ''}` — the save keeps
 * the item so its id stays paired with the editor and the dataframes. Counting
 * items called that slice "present": no fallback was computed, and a cleared
 * main-lang / nolan rung STOPPED the chain and was served as an empty fallback.
 * PHP (component_string_common::get_component_data_fallback) asks is_empty_data
 * at the trigger and at every rung, with the per-class item rule (string trims,
 * text_area also treats the editor's ghost markup as empty, '0' is a value).
 *
 * Langs are the INSTALL's (config), never literals: DEFAULT = the data-lang
 * default; OTHER / THIRD = project langs without declared equivalents.
 *
 * Pure resolver cases read record LITERALS through resolveComponentValue (the
 * ontology lookups hit the suite DB's `test` TLD: test52 input_text and test17
 * text_area, both translatable; test140 component_iri). Door cases BUILD one
 * scratch test3 record through the engine's create door, write the slices, read
 * through the component read, the section list read and the relation_list cell
 * reader, and sweep it after.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { config } from '../../src/config/config.ts';
import { type ApiRequestContext, dispatchRqo } from '../../src/core/api/dispatch.ts';
import type { Rqo } from '../../src/core/concepts/rqo.ts';
import type { MatrixRecord } from '../../src/core/db/matrix.ts';
import { updateMatrixRecord } from '../../src/core/db/matrix_write.ts';
import { sql } from '../../src/core/db/postgres.ts';
import { getMatrixTableFromTipo, getTranslatableByTipo } from '../../src/core/ontology/resolver.ts';
import { resolveComponentValue, shownItems } from '../../src/core/resolve/component_data.ts';
import { isEmptyComponentData } from '../../src/core/resolve/data_item_emptiness.ts';
import { equivalentLangsOf } from '../../src/core/resolve/lang_alias.ts';
import { resolveCellItems } from '../../src/core/resolve/relation_list.ts';
import { runWithRequestLangs } from '../../src/core/resolve/request_lang.ts';
import { readComponentData } from '../../src/core/section/read.ts';
import { createSectionRecord } from '../../src/core/section/record/create_record.ts';
import { assertTestDatabase } from '../../src/core/test_data/test_database_marker.ts';
import { cleanScratchRecord } from '../helpers/test_data.ts';

const SECTION = 'test3';
const TABLE = 'matrix_test';
const INPUT_TEXT = 'test52';
const TEXT_AREA = 'test17';
const IRI = 'test140';
const M_INPUT = 'component_input_text';
const M_AREA = 'component_text_area';
const M_IRI = 'component_iri';
const NOLAN = 'lg-nolan';

const DEFAULT = config.lang.dataLangDefault;
const plainLangs = config.menu.projectsDefaultLangs.filter(
	(lang) => lang !== DEFAULT && lang !== NOLAN && equivalentLangsOf(lang).length === 0,
);
const OTHER = plainLangs[0] as string;
const THIRD = plainLangs[1] as string;

type Resolved = { value: unknown[] | null; fallbackValue: unknown[] | null };
const observed: { model: string; resolved: Resolved }[] = [];

function recordOf(tipo: string, items: unknown[], column = 'string'): MatrixRecord {
	return {
		id: 1,
		section_id: 1,
		section_tipo: SECTION,
		columns: { [column]: { [tipo]: items } },
		rawText: {},
	} as unknown as MatrixRecord;
}

async function resolve(
	tipo: string,
	model: string,
	items: unknown[],
	lang: string,
	column = 'string',
): Promise<Resolved> {
	const resolved = await resolveComponentValue(recordOf(tipo, items, column), tipo, model, lang);
	observed.push({ model, resolved });
	return resolved;
}

const MAIN = { id: 1, lang: DEFAULT, value: 'Main' };

beforeAll(() => {
	// Anti-vacuity: the lang picks exist on this install.
	expect(plainLangs.length).toBeGreaterThanOrEqual(2);
});

describe('resolver: the trigger judges the requested slice by emptiness', () => {
	test("R1 a cleared '' slice keeps its items AND gets the default-lang fallback", async () => {
		const cleared = { id: 1, lang: OTHER, value: '' };
		const r = await resolve(INPUT_TEXT, M_INPUT, [MAIN, cleared], OTHER);
		expect(r.value).toEqual([cleared]);
		expect(r.fallbackValue).toEqual([MAIN]);
	});

	test('R2 a cleared null slice → the fallback', async () => {
		const r = await resolve(
			INPUT_TEXT,
			M_INPUT,
			[MAIN, { id: 1, lang: OTHER, value: null }],
			OTHER,
		);
		expect(r.fallbackValue).toEqual([MAIN]);
	});

	test('R3 a whitespace-only slice is empty for the string rule', async () => {
		const r = await resolve(
			INPUT_TEXT,
			M_INPUT,
			[MAIN, { id: 1, lang: OTHER, value: '   ' }],
			OTHER,
		);
		expect(r.fallbackValue).toEqual([MAIN]);
	});

	test('R4 text_area: every editor ghost spelling is empty', async () => {
		const main = { id: 1, lang: DEFAULT, value: '<p>Main</p>' };
		for (const ghost of ['<p></p>', ' <p> </p> ', '<br data-mce-bogus="1">']) {
			const r = await resolve(
				TEXT_AREA,
				M_AREA,
				[main, { id: 1, lang: OTHER, value: ghost }],
				OTHER,
			);
			expect(r.fallbackValue, ghost).toEqual([main]);
		}
	});
});

describe('resolver: every chain rung judges by emptiness', () => {
	test('R5 a cleared DEFAULT rung is skipped → the next filled project lang', async () => {
		const other = { id: 1, lang: OTHER, value: 'Other' };
		const r = await resolve(
			INPUT_TEXT,
			M_INPUT,
			[{ id: 1, lang: DEFAULT, value: null }, other],
			THIRD,
		);
		expect(r.value).toBeNull();
		expect(r.fallbackValue).toEqual([other]);
	});

	test('R6 a cleared NOLAN rung is skipped', async () => {
		const other = { id: 1, lang: OTHER, value: 'Other' };
		const r = await resolve(INPUT_TEXT, M_INPUT, [{ id: 1, lang: NOLAN, value: '' }, other], THIRD);
		expect(r.fallbackValue).toEqual([other]);
	});

	test('R7 every lang cleared → no fallback at all', async () => {
		const r = await resolve(
			INPUT_TEXT,
			M_INPUT,
			[
				{ id: 1, lang: DEFAULT, value: '' },
				{ id: 1, lang: OTHER, value: null },
				{ id: 1, lang: NOLAN, value: ' ' },
			],
			THIRD,
		);
		expect(r.fallbackValue).toBeNull();
	});
});

describe('resolver: values stay values (guards)', () => {
	test("'0' and 0 are values — no fallback", async () => {
		for (const zero of ['0', 0]) {
			const item = { id: 1, lang: OTHER, value: zero };
			const r = await resolve(INPUT_TEXT, M_INPUT, [MAIN, item], OTHER);
			expect(r).toEqual({ value: [item], fallbackValue: null });
		}
	});

	test('a multi-item slice with ONE filled item is present', async () => {
		const slice = [
			{ id: 1, lang: OTHER, value: 'kept' },
			{ id: 2, lang: OTHER, value: '' },
		];
		const r = await resolve(INPUT_TEXT, M_INPUT, [MAIN, ...slice], OTHER);
		expect(r).toEqual({ value: slice, fallbackValue: null });
	});

	test('no tag stripping outside rich text: <b></b> on input_text is a value', async () => {
		const item = { id: 1, lang: OTHER, value: '<b></b>' };
		const r = await resolve(INPUT_TEXT, M_INPUT, [MAIN, item], OTHER);
		expect(r).toEqual({ value: [item], fallbackValue: null });
	});

	test('component_iri keeps its no-fallback shape for a cleared slice', async () => {
		const cleared = { id: 1, lang: OTHER, iri: '', title: '' };
		const base = { id: 1, lang: NOLAN, iri: 'https://example.org/x', title: 'X' };
		const r = await resolve(IRI, M_IRI, [base, cleared], OTHER, 'iri');
		expect(r).toEqual({ value: [cleared], fallbackValue: null });
	});

	test('shownItems: the fallback when one resolved, else the value', () => {
		expect(shownItems({ value: [MAIN], fallbackValue: null })).toEqual([MAIN]);
		expect(shownItems({ value: [{ value: '' }], fallbackValue: [MAIN] })).toEqual([MAIN]);
		expect(shownItems({ value: null, fallbackValue: null })).toBeNull();
	});

	test('INVARIANT over every case above: fallbackValue !== null ⇒ value is empty by rule', () => {
		expect(observed.length).toBeGreaterThan(10); // anti-vacuity
		for (const { model, resolved } of observed) {
			if (resolved.fallbackValue === null) continue;
			expect(isEmptyComponentData(model, resolved.value)).toBe(true);
		}
	});
});

// ---------------------------------------------------------------------------
// Doors: a BUILT scratch record read through the engine's own read paths.
// ---------------------------------------------------------------------------

const CLEARED_INPUT = { id: 1, lang: OTHER, value: '' };
const MAIN_AREA = { id: 1, lang: DEFAULT, value: '<p>Main text</p>' };
const GHOST_AREA = { id: 1, lang: OTHER, value: '<p></p>' };
let recordId = 0;

const rootContext: ApiRequestContext = {
	requestId: 'test',
	clientIp: '127.0.0.1',
	session: {
		userId: -1,
		username: 'root',
		isGlobalAdmin: true,
		csrfToken: 'tok',
		applicationLang: null,
		dataLang: OTHER,
	},
	csrfCandidate: 'tok',
	principal: { userId: -1, isGlobalAdmin: true, isDeveloper: true },
} as ApiRequestContext;

type Item = {
	tipo?: string;
	section_id?: unknown;
	entries?: unknown[] | null;
	fallback_value?: unknown[] | null;
};

async function readItem(tipo: string): Promise<Item> {
	const items = (await runWithRequestLangs({ applicationLang: OTHER, dataLang: OTHER }, () =>
		readComponentData({
			source: { tipo, section_tipo: SECTION, section_id: recordId, mode: 'edit' },
		} as never),
	)) as Item[];
	const item = items.find((e) => e.tipo === tipo && String(e.section_id) === String(recordId));
	expect(item).toBeDefined();
	return item as Item;
}

async function listItem(tipo: string): Promise<Item | undefined> {
	const response = await runWithRequestLangs({ applicationLang: OTHER, dataLang: OTHER }, () =>
		dispatchRqo(
			{
				action: 'read',
				dd_api: 'dd_core_api',
				source: {
					action: 'search',
					tipo: SECTION,
					section_tipo: SECTION,
					mode: 'list',
					lang: OTHER,
				},
				sqo: {
					section_tipo: [SECTION],
					filter_by_locators: [{ section_tipo: SECTION, section_id: String(recordId) }],
					limit: 1,
				},
				show: { ddo_map: [{ tipo, section_tipo: SECTION, parent: SECTION, mode: 'list' }] },
			} as unknown as Rqo,
			rootContext,
		),
	);
	expect(response.status).toBe(200);
	const data = (response.body as { data: { data: Item[] } }).data.data;
	return data.find((e) => e.tipo === tipo && String(e.section_id) === String(recordId));
}

describe('doors: a cleared translation shows the fallback', () => {
	beforeAll(async () => {
		await assertTestDatabase('lang_fallback_empty_slice_native');
		expect(await getMatrixTableFromTipo(SECTION)).toBe(TABLE);
		expect(await getTranslatableByTipo(INPUT_TEXT)).toBe(true);
		expect(await getTranslatableByTipo(TEXT_AREA)).toBe(true);
		recordId = await createSectionRecord(SECTION, -1);
		expect(
			await updateMatrixRecord(TABLE, SECTION, recordId, {
				string: {
					[INPUT_TEXT]: [MAIN, CLEARED_INPUT],
					[TEXT_AREA]: [MAIN_AREA, GHOST_AREA],
				},
			}),
		).toBe('updated');
	}, 60_000);

	afterAll(async () => {
		if (recordId === 0) return;
		await cleanScratchRecord(SECTION, recordId, TABLE);
		await sql`DELETE FROM matrix_activity
			WHERE data->>'section_tipo' = ${SECTION} AND data->>'section_id' = ${String(recordId)}`;
	}, 60_000);

	test('R8 component EDIT read: entries = the cleared slice (ids kept), fallback_value = the default slice', async () => {
		const item = await readItem(INPUT_TEXT);
		expect(item.entries).toEqual([CLEARED_INPUT]);
		expect(item.fallback_value).toEqual([MAIN]);
	}, 30_000);

	test('R9 section LIST read: the input_text cell carries the fallback', async () => {
		const cell = await listItem(INPUT_TEXT);
		expect(cell).toBeDefined();
		expect(cell?.fallback_value).toEqual([MAIN]);
	}, 30_000);

	test('R10 text_area EDIT read: a <p></p> slice gets the fallback', async () => {
		const item = await readItem(TEXT_AREA);
		expect(item.entries).toEqual([GHOST_AREA]);
		expect(item.fallback_value).toEqual([MAIN_AREA]);
	}, 30_000);

	test('OPEN owner decision D1 (T1-34): text_area LIST keeps the PHP count trigger — no fallback while the slice holds items', async () => {
		// PHP component_text_area_json list: empty(get_list_value) — a slice of
		// cleared items maps to [''] and is "present". Pinned as the status quo
		// until the owner rules; flipping it is this assertion + the emit hook.
		const cell = await listItem(TEXT_AREA);
		expect(cell).toBeDefined();
		expect(cell?.fallback_value ?? null).toBeNull();
	}, 30_000);

	test('R11 relation_list cell: the cleared slice shows the fallback text', async () => {
		const parts = await runWithRequestLangs({ applicationLang: OTHER, dataLang: OTHER }, () =>
			resolveCellItems(SECTION, recordId, INPUT_TEXT, OTHER, []),
		);
		expect(parts).toEqual(['Main']);
	}, 30_000);
});
