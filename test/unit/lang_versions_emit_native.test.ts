/**
 * TRANSLITERABLE components: `transliterate_value` + the tool_lang offer
 * (WC-2026-10-31-transliterate-value-emitted).
 *
 * A TRANSLITERABLE component is non-translatable but keeps per-language
 * VERSIONS beside its lg-nolan BASE: a component_input_text whose ontology says
 * `with_lang_versions` (the `test` TLD's test166 — "Augustus" lg-nolan,
 * "Αύγουστος" lg-ell), and EVERY component_iri (test140). PHP (v6 semantics,
 * component_input_text_json.php:195 / component_iri_json.php:178) put the
 * OTHER lang of the pair on each item as `transliterate_value` — the data-lang
 * version beside a base instance, the base beside a version instance (the
 * tool_lang target) — and offered requirement_translatable tools (tool_lang)
 * on them (class.common.php:4130).
 *
 * The situation is BUILT: one scratch test3 record minted through the engine's
 * create door holding a base + an lg-ell version on test166, a base on the
 * plain non-translatable sibling test162 (the contrast: no key at all) and a
 * base IRI on test140; a second scratch record with no data (the `null` shape).
 * Both are swept after (matrix row + TM + activity rows).
 *
 * Doors exercised: the component read (readComponentData — the tool_lang
 * target's door, with and without an explicit source.lang), the SECTION read
 * of a list cell (emitDdoData with the ambient page lang — must stay on the
 * base), the scalar save echo (dd_core_api save → decorateItem), and the
 * element-tools filter (registry getElementTools + the structure context stamp).
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { type ApiRequestContext, dispatchRqo } from '../../src/core/api/dispatch.ts';
import type { Rqo } from '../../src/core/concepts/rqo.ts';
import { updateMatrixRecord } from '../../src/core/db/matrix_write.ts';
import { sql } from '../../src/core/db/postgres.ts';
import { getMatrixTableFromTipo, hasLangVersions } from '../../src/core/ontology/resolver.ts';
import { runWithRequestLangs } from '../../src/core/resolve/request_lang.ts';
import { buildStructureContext } from '../../src/core/resolve/structure_context.ts';
import { readComponentData } from '../../src/core/section/read.ts';
import { createSectionRecord } from '../../src/core/section/record/create_record.ts';
import { assertTestDatabase } from '../../src/core/test_data/test_database_marker.ts';
import { getElementTools } from '../../src/core/tools/registry.ts';
import { cleanScratchRecord } from '../helpers/test_data.ts';

const SECTION = 'test3';
const TABLE = 'matrix_test';
/** component_input_text, NOT translatable, `properties.with_lang_versions: true`. */
const TRANSLITERABLE = 'test166';
/** component_input_text, NOT translatable, no properties — the plain contrast. */
const PLAIN = 'test162';
/** component_input_text, translatable. */
const TRANSLATABLE = 'test52';
/** component_iri, NOT translatable — always transliterable. */
const IRI = 'test140';

const NOLAN = 'lg-nolan';
const ELL = 'lg-ell';
const SPA = 'lg-spa';
const ENG = 'lg-eng';

const BASE = { id: 1, lang: NOLAN, value: 'Augustus' };
const VERSION = { id: 1, lang: ELL, value: 'Αύγουστος' };
const IRI_BASE = { id: 1, lang: NOLAN, iri: 'https://example.org/augustus', title: 'Augustus' };

let dataId = 0;
let emptyId = 0;

const rootContext: ApiRequestContext = {
	requestId: 'test',
	clientIp: '127.0.0.1',
	session: {
		userId: -1,
		username: 'root',
		isGlobalAdmin: true,
		csrfToken: 'tok',
		applicationLang: null,
		dataLang: null,
	},
	csrfCandidate: 'tok',
	principal: { userId: -1, isGlobalAdmin: true, isDeveloper: true },
};

type Item = {
	tipo?: string;
	section_id?: unknown;
	lang?: string;
	entries?: Record<string, unknown>[] | null;
	transliterate_value?: Record<string, unknown>[] | null;
};

/** One component's emitted item from the component read door. */
async function readItem(
	tipo: string,
	sectionId: number,
	dataLang: string,
	lang?: string,
	mode = 'edit',
): Promise<Item> {
	const items = (await runWithRequestLangs({ applicationLang: ENG, dataLang }, () =>
		readComponentData({
			source: {
				tipo,
				section_tipo: SECTION,
				section_id: sectionId,
				mode,
				...(lang === undefined ? {} : { lang }),
			},
		} as never),
	)) as Item[];
	const item = items.find(
		(entry) => entry.tipo === tipo && String(entry.section_id) === String(sectionId),
	);
	expect(item).toBeDefined();
	return item as Item;
}

/** Remove one scratch test3 record and every trace of it. */
async function sweep(sectionId: number): Promise<void> {
	if (sectionId === 0) return;
	await cleanScratchRecord(SECTION, sectionId, TABLE);
	await sql`DELETE FROM matrix_activity
		WHERE data->>'section_tipo' = ${SECTION} AND data->>'section_id' = ${String(sectionId)}`;
}

beforeAll(async () => {
	await assertTestDatabase('lang_versions_emit_native');
	expect(await getMatrixTableFromTipo(SECTION)).toBe(TABLE);
	// The ontology facts the gate stands on (the suite DB's `test` TLD).
	expect(await hasLangVersions(TRANSLITERABLE, 'component_input_text')).toBe(true);
	expect(await hasLangVersions(PLAIN, 'component_input_text')).toBe(false);
	expect(await hasLangVersions(IRI, 'component_iri')).toBe(true);

	dataId = await createSectionRecord(SECTION, -1);
	emptyId = await createSectionRecord(SECTION, -1);
	// Only the two value columns are written; the minted record keeps the rest.
	expect(
		await updateMatrixRecord(TABLE, SECTION, dataId, {
			string: {
				[TRANSLITERABLE]: [BASE, VERSION],
				[PLAIN]: [{ id: 1, lang: NOLAN, value: 'plain' }],
			},
			iri: { [IRI]: [IRI_BASE] },
		}),
	).toBe('updated');
}, 60_000);

afterAll(async () => {
	await sweep(dataId);
	await sweep(emptyId);
}, 60_000);

describe('requirement_translatable tools (tool_lang) on transliterable components', () => {
	const toolsOf = async (tipo: string, model: string, translatable: boolean) =>
		(
			await getElementTools({ model, tipo, isComponent: true, translatable, toolConfigKeys: [] })
		).tools.map((tool) => tool.name);

	test('tool_lang: translatable yes, with_lang_versions yes, iri yes, plain non-translatable NO', async () => {
		expect(await toolsOf(TRANSLATABLE, 'component_input_text', true)).toContain('tool_lang');
		expect(await toolsOf(TRANSLITERABLE, 'component_input_text', false)).toContain('tool_lang');
		expect(await toolsOf(IRI, 'component_iri', false)).toContain('tool_lang');
		expect(await toolsOf(PLAIN, 'component_input_text', false)).not.toContain('tool_lang');
	});

	test('the structure-context stamp carries it (the client renders context.tools verbatim)', async () => {
		const entry = await buildStructureContext({
			tipo: TRANSLITERABLE,
			sectionTipo: SECTION,
			mode: 'edit',
			lang: ENG,
			permissions: 2,
			addRequestConfig: true,
		});
		const names = ((entry?.tools ?? []) as { name?: string }[]).map((tool) => tool.name);
		expect(names).toContain('tool_lang');
		// The views gate the hint on the RAW ontology property: it must ride the context.
		expect((entry?.properties as { with_lang_versions?: unknown } | null)?.with_lang_versions).toBe(
			true,
		);
		// No explicit ask → the base instance.
		expect(entry?.lang).toBe(NOLAN);
	});
});

describe('transliterate_value — the other lang of the pair', () => {
	test('base instance (no explicit lang): entries = the base, transliterate_value = the DATA-lang version', async () => {
		const item = await readItem(TRANSLITERABLE, dataId, ELL);
		expect(item.lang).toBe(NOLAN);
		expect(item.entries).toEqual([BASE]);
		expect(item.transliterate_value).toEqual([VERSION]);
	}, 30_000);

	test('base instance, data lang with no version: [] (data exists, that slice is empty)', async () => {
		const item = await readItem(TRANSLITERABLE, dataId, SPA);
		expect(item.lang).toBe(NOLAN);
		expect(item.entries).toEqual([BASE]);
		expect(Array.isArray(item.transliterate_value)).toBe(true);
		expect(item.transliterate_value?.length).toBe(0);
	}, 30_000);

	test('version instance (EXPLICIT lg-ell — the tool_lang target): entries = the version, transliterate_value = the base', async () => {
		const item = await readItem(TRANSLITERABLE, dataId, SPA, ELL);
		expect(item.lang).toBe(ELL);
		expect(item.entries).toEqual([VERSION]);
		expect(item.transliterate_value).toEqual([BASE]);
	}, 30_000);

	test('version instance in an EMPTY lang: no entries of its own, the base as counterpart', async () => {
		const item = await readItem(TRANSLITERABLE, dataId, ENG, SPA);
		expect(item.lang).toBe(SPA);
		// NO entries of its own: the base never leaks into the version's entries
		// (it rides `fallback_value` / `transliterate_value` only) — a base served
		// as the lg-spa value would be saved back as the lg-spa version.
		expect((item.entries ?? []).length).toBe(0);
		expect(item.entries ?? []).not.toContainEqual(BASE);
		expect(item.transliterate_value).toEqual([BASE]);
	}, 30_000);

	test('no stored data at all: null (PHP get_data_lang returns get_data() verbatim)', async () => {
		const input = await readItem(TRANSLITERABLE, emptyId, ELL);
		expect('transliterate_value' in input).toBe(true);
		expect(input.transliterate_value).toBeNull();
		const iri = await readItem(IRI, emptyId, ELL);
		expect('transliterate_value' in iri).toBe(true);
		expect(iri.transliterate_value).toBeNull();
	}, 30_000);

	test('a PLAIN non-translatable component carries no key at all', async () => {
		const item = await readItem(PLAIN, dataId, ELL);
		expect(item.entries).toEqual([{ id: 1, lang: NOLAN, value: 'plain' }]);
		expect('transliterate_value' in item).toBe(false);
		// Even when a lang is asked for explicitly: a plain one is nolan-forced.
		const asked = await readItem(PLAIN, dataId, ELL, ELL);
		expect(asked.lang).toBe(NOLAN);
		expect('transliterate_value' in asked).toBe(false);
	}, 30_000);

	test('component_iri: always keyed; the counterpart keeps the full stored item (id/iri/title)', async () => {
		const base = await readItem(IRI, dataId, ELL);
		expect(base.lang).toBe(NOLAN);
		expect(base.entries).toEqual([IRI_BASE]);
		expect(Array.isArray(base.transliterate_value)).toBe(true);
		expect(base.transliterate_value?.length).toBe(0);
		// The tool_lang target in lg-ell: no lg-ell IRI yet, so the client adopts
		// the base's `id` for the new row (render_edit_component_iri.js) — the
		// counterpart must carry it.
		const version = await readItem(IRI, dataId, ENG, ELL);
		expect(version.lang).toBe(ELL);
		expect((version.entries ?? []).length).toBe(0);
		expect(version.transliterate_value).toEqual([IRI_BASE]);
	}, 30_000);

	test('a LIST cell of the section read stays on the base (the ambient page lang is never an explicit ask)', async () => {
		// The request DATA lang (PHP DEDALO_DATA_LANG) is the session's: the
		// dispatcher scopes it from there, so the session says lg-ell.
		const ellContext: ApiRequestContext = {
			...rootContext,
			session: { ...rootContext.session, dataLang: ELL } as ApiRequestContext['session'],
		};
		const response = await runWithRequestLangs({ applicationLang: ENG, dataLang: ELL }, () =>
			dispatchRqo(
				{
					action: 'read',
					dd_api: 'dd_core_api',
					source: {
						action: 'search',
						tipo: SECTION,
						section_tipo: SECTION,
						mode: 'list',
						lang: ELL,
					},
					sqo: {
						section_tipo: [SECTION],
						filter_by_locators: [{ section_tipo: SECTION, section_id: String(dataId) }],
						limit: 1,
					},
					show: {
						ddo_map: [
							{ tipo: TRANSLITERABLE, section_tipo: SECTION, parent: SECTION, mode: 'list' },
						],
					},
				} as unknown as Rqo,
				ellContext,
			),
		);
		expect(response.status).toBe(200);
		const data = (response.body as { data: { data: Item[] } }).data.data;
		const cell = data.find(
			(item) => item.tipo === TRANSLITERABLE && String(item.section_id) === String(dataId),
		);
		expect(cell).toBeDefined();
		expect(cell?.lang).toBe(NOLAN);
		expect(cell?.entries).toEqual([BASE]);
		expect(cell?.transliterate_value).toEqual([VERSION]);
	}, 30_000);

	test('the SAVE ECHO of a version carries the counterpart (the post-save render keeps the hint)', async () => {
		const response = await runWithRequestLangs({ applicationLang: ENG, dataLang: SPA }, () =>
			dispatchRqo(
				{
					action: 'save',
					dd_api: 'dd_core_api',
					source: {
						type: 'component',
						tipo: TRANSLITERABLE,
						section_tipo: SECTION,
						section_id: dataId,
						lang: SPA,
					},
					data: {
						changed_data: [
							{ action: 'update', id: 1, value: { id: 1, lang: SPA, value: 'Augusto' } },
						],
					},
				} as unknown as Rqo,
				rootContext,
			),
		);
		expect(response.status).toBe(200);
		const data = (response.body as { data: { data: Item[] } }).data.data;
		const echo = data.find(
			(item) => item.tipo === TRANSLITERABLE && String(item.section_id) === String(dataId),
		);
		expect(echo?.lang).toBe(SPA);
		expect(echo?.entries).toEqual([{ id: 1, lang: SPA, value: 'Augusto' }]);
		expect(echo?.transliterate_value).toEqual([BASE]);
		// The save kept the other slices (a version save never touches the base).
		const base = await readItem(TRANSLITERABLE, dataId, SPA);
		expect(base.entries).toEqual([BASE]);
		expect(base.transliterate_value).toEqual([{ id: 1, lang: SPA, value: 'Augusto' }]);
	}, 30_000);
});
