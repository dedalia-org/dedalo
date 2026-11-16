/**
 * TAGS WIDGET READS THE RECORD'S TEXT SLICE (T1-44 / OX6,
 * WC-2026-11-13-tags-widget-original-lang).
 *
 * The `tags` info widget (transcription tag statistics) must count the tags of
 * the text the transcript actually lives in — v6 class.tags.php instanced the
 * text_area at the data lang, `set_lang(get_original_lang())`, then read the
 * LANG-SCOPED `get_dato()[0]` (no fallback). Frozen PHP v7 kept the set_lang
 * dance but called the FULL-array `get_data()`, so `[0]` was whichever lang
 * slice happened to be stored first; the TS port copied that regression.
 *
 * The situation is BUILT (scratch `zztagol` TLD, torn down after): a
 * translatable text_area related to a select_lang (the rsc36 → rsc263 shape),
 * a non-translatable text_area, and one component_info per text_area declaring
 * the tags widget. Each lang slice carries a DISTINCT number of TC tags, so a
 * count names the slice it was taken from.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { computeInfoWidgets } from '../../src/core/components/component_info/widgets/registry.ts';
import type { WidgetItem } from '../../src/core/components/component_info/widgets/widget_common.ts';
import type { Rqo } from '../../src/core/concepts/rqo.ts';
import {
	deleteMatrixRecord,
	insertMatrixRecordWithCounter,
} from '../../src/core/db/matrix_write.ts';
import { getMatrixTableFromTipo } from '../../src/core/ontology/resolver.ts';
import { getLangSectionIdByCode } from '../../src/core/relations/select_lang.ts';
import { readSection } from '../../src/core/section/read.ts';
import {
	dropSituation,
	ensureSituation,
	situation,
} from '../../src/core/test_data/situations/situation.ts';

const SECTION = 'zztagol1';
const TEXT_AREA = 'zztagol2';
const SELECT_LANG = 'zztagol3';
const INFO = 'zztagol4';
const PLAIN_TEXT_AREA = 'zztagol5';
const PLAIN_INFO = 'zztagol6';
const LIST = 'zztagol7';
let TABLE = 'matrix_test';

function tagsWidget(textAreaTipo: string) {
	return {
		widgets: [
			{
				widget_name: 'tags',
				path: '/oh/tags',
				ipo: [
					{
						input: { source: [{ var_name: 'transcription', component_tipo: textAreaTipo }] },
						output: [{ id: 'total_tc' }, { id: 'total_chars' }],
					},
				],
			},
		],
	};
}

const TAGS_SITUATION = situation({
	tld: 'zztagol',
	name: 'tags widget original lang',
	nodes: [
		{ tipo: SECTION, model: 'section', parent: 'dd14' },
		{
			tipo: TEXT_AREA,
			model: 'component_text_area',
			parent: SECTION,
			is_translatable: true,
			relations: [{ tipo: SELECT_LANG }],
		},
		{
			tipo: SELECT_LANG,
			model: 'component_select_lang',
			parent: SECTION,
			properties: {
				source: {
					request_config: [
						{
							type: 'main',
							api_engine: 'dedalo',
							sqo: { section_tipo: [{ value: 'lg1', source: 'section' }] },
						},
					],
				},
			},
		},
		{ tipo: INFO, model: 'component_info', parent: SECTION, properties: tagsWidget(TEXT_AREA) },
		{
			tipo: PLAIN_TEXT_AREA,
			model: 'component_text_area',
			parent: SECTION,
			is_translatable: false,
		},
		{
			tipo: PLAIN_INFO,
			model: 'component_info',
			parent: SECTION,
			properties: tagsWidget(PLAIN_TEXT_AREA),
		},
		{ tipo: LIST, model: 'section_list', parent: SECTION, relations: [{ tipo: INFO }] },
	],
});

const tc = (n: number) =>
	`<p>${Array.from({ length: n }, (_, i) => `[TC_00:00:0${i + 1}.000_TC]`).join(' x ')}</p>`;
const ENG = tc(1);
const SPA = tc(3);
const CAT = tc(2);

function langLocator(lg1Id: number) {
	return {
		[SELECT_LANG]: [
			{
				id: 1,
				type: 'dd151',
				section_tipo: 'lg1',
				section_id: String(lg1Id),
				from_component_tipo: SELECT_LANG,
			},
		],
	};
}

const created: number[] = [];
async function record(data: Record<string, unknown>): Promise<number> {
	const id = await insertMatrixRecordWithCounter(TABLE, SECTION, data);
	created.push(id);
	return id;
}

/** spa original, eng slice stored FIRST. */
let spaOriginalId = 0;
/** no original, [eng, spa]. */
let noOriginalId = 0;
/** no original, [spa] only. */
let spaOnlyId = 0;
/** vlca original, [eng, cat] (cat = vlca's equivalence sibling). */
let vlcaId = 0;
/** non-translatable text_area. */
let plainId = 0;

beforeAll(async () => {
	await ensureSituation(TAGS_SITUATION);
	TABLE = (await getMatrixTableFromTipo(SECTION)) ?? 'matrix_test';
	const spa = (await getLangSectionIdByCode('lg-spa')) ?? 0;
	const vlca = (await getLangSectionIdByCode('lg-vlca')) ?? 0;
	expect(spa).toBeGreaterThan(0);
	expect(vlca).toBeGreaterThan(0);
	const engSpa = [
		{ id: 1, value: ENG, lang: 'lg-eng' },
		{ id: 1, value: SPA, lang: 'lg-spa' },
	];
	spaOriginalId = await record({ relation: langLocator(spa), string: { [TEXT_AREA]: engSpa } });
	noOriginalId = await record({ string: { [TEXT_AREA]: engSpa } });
	spaOnlyId = await record({ string: { [TEXT_AREA]: [{ id: 1, value: SPA, lang: 'lg-spa' }] } });
	vlcaId = await record({
		relation: langLocator(vlca),
		string: {
			[TEXT_AREA]: [
				{ id: 1, value: ENG, lang: 'lg-eng' },
				{ id: 1, value: CAT, lang: 'lg-cat' },
			],
		},
	});
	plainId = await record({
		string: { [PLAIN_TEXT_AREA]: [{ id: 1, value: SPA, lang: 'lg-nolan' }] },
	});
});

afterAll(async () => {
	for (const id of created) await deleteMatrixRecord(TABLE, SECTION, id);
	expect(await dropSituation(TAGS_SITUATION)).toBe(0);
});

async function compute(infoTipo: string, sectionId: number, lang: string) {
	const items = (await computeInfoWidgets(infoTipo, {
		sectionTipo: SECTION,
		sectionId,
		mode: 'list',
		lang,
	})) as WidgetItem[];
	const stat = (id: string) =>
		(
			items.find((item) => (item as { widget_id?: string }).widget_id === id) as
				| { value?: unknown }
				| undefined
		)?.value;
	const raw = items.filter((item) => (item as { widget?: string }).widget !== 'tags') as {
		lang?: string;
	}[];
	return { totalTc: stat('total_tc'), totalChars: stat('total_chars'), raw };
}

describe('tags widget reads the record text slice, not item[0] of every lang', () => {
	test('A: the original lang wins over the menu lang; the raw prefix is that slice only', async () => {
		const { totalTc, raw } = await compute(INFO, spaOriginalId, 'lg-eng');
		expect(totalTc).toBe(3);
		expect(raw.map((item) => item.lang)).toEqual(['lg-spa']);
	});

	test('B: menu lang = original lang', async () => {
		expect((await compute(INFO, spaOriginalId, 'lg-spa')).totalTc).toBe(3);
	});

	test('C: no original lang → the request lang slice (not the first stored)', async () => {
		expect((await compute(INFO, noOriginalId, 'lg-spa')).totalTc).toBe(3);
	});

	test("C': control — request lg-eng reads the eng slice", async () => {
		expect((await compute(INFO, noOriginalId, 'lg-eng')).totalTc).toBe(1);
	});

	test('D: no original lang, empty request slice → zeros, no raw items (v6 lang_fallback=false; OPEN owner decision T1-44 §7)', async () => {
		const { totalTc, totalChars, raw } = await compute(INFO, spaOnlyId, 'lg-eng');
		expect(totalTc).toBe(0);
		expect(totalChars).toBe(0);
		expect(raw).toHaveLength(0);
	});

	test('E: equivalence — vlca original, text under lg-cat → the cat slice', async () => {
		expect((await compute(INFO, vlcaId, 'lg-eng')).totalTc).toBe(2);
	});

	test('F: a non-translatable source reads its full (nolan) array', async () => {
		const { totalTc, raw } = await compute(PLAIN_INFO, plainId, 'lg-eng');
		expect(totalTc).toBe(3);
		expect(raw.map((item) => item.lang)).toEqual(['lg-nolan']);
	});
});

describe('G: the section list emission serves the same statistics', () => {
	test('case A through readSection list', async () => {
		const rqo = {
			action: 'read',
			source: { tipo: SECTION, section_tipo: SECTION, mode: 'list', lang: 'lg-eng' },
			sqo: {
				section_tipo: [SECTION],
				filter_by_locators: [{ section_tipo: SECTION, section_id: String(spaOriginalId) }],
				limit: 1,
				offset: 0,
			},
		} as unknown as Rqo;
		const { data } = await readSection(rqo);
		const info = data.find((item) => (item as { tipo?: string }).tipo === INFO) as
			| { entries?: { widget_id?: string; value?: unknown }[] }
			| undefined;
		expect(info).toBeDefined();
		const entry = (info?.entries ?? []).find((item) => item?.widget_id === 'total_tc');
		expect(entry?.value).toBe(3);
	});
});
