/**
 * THE REQUEST-LANGUAGE LAW — outcome twins (T2 B10: OX7-1b, O15-3b).
 *
 * "Request identity (application lang, data lang) is read from the request
 * scope; a language is configuration, never a literal." The mechanical half is
 * request_lang_law_tripwire (no install-lang read, no language-literal default);
 * this file is the BEHAVIOUR half for every site the law moved that has no gate
 * home of its own: each case runs the same call under TWO request scopes whose
 * languages name the situation differently and asserts each scope gets ITS
 * language. A site reading the install default (or a literal) answers both
 * scopes the same, so one of the two lanes is red.
 *
 *   - O15-3b request_config filter_by_list: a context without `lang` expands
 *     the field in the request DATA lang (was literal lg-spa).
 *   - OX7-1b create_record: the new record's `data.label` is the section term
 *     in the request APPLICATION lang (PHP build_metadata,
 *     DEDALO_APPLICATION_LANG — a per-request constant).
 *   - login context: the login ddo's `lang` is the request application lang
 *     (the pre-auth cookie seeds the scope), as its labels already were.
 *   - MCP: describe_section labels default to the request application lang,
 *     read_record / search_section default to the request data lang (were
 *     literal lg-eng); buildLlmMap resolves link targets in the request data
 *     lang (was the install DATA_LANG).
 *
 * SITUATION `zzrll` (matrix_test, dropped with residue 0): section zzrll1
 * (term differs per lang), translatable input_text zzrll2, portal zzrll3 whose
 * request_config declares a filter_by_list on zzrll2. One record holds zzrll2
 * as 'alpha' (lg-eng) / 'alfa' (lg-spa).
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { describeSection } from '../../src/ai/mcp/tools/discovery.ts';
import { buildLlmMap } from '../../src/ai/mcp/tools/llm_map.ts';
import { readSectionRecord, searchSectionRecords } from '../../src/ai/mcp/tools/records_read.ts';
import { buildLoginContext } from '../../src/core/api/handlers/login_context.ts';
import { sql } from '../../src/core/db/postgres.ts';
import { clearOntologyDerivedCaches } from '../../src/core/ontology/cache_invalidation.ts';
import { termByTipo } from '../../src/core/ontology/labels.ts';
import { getPropertiesByTipo } from '../../src/core/ontology/resolver.ts';
import { buildRequestConfigForElement } from '../../src/core/relations/request_config/build.ts';
import { runWithRequestLangs } from '../../src/core/resolve/request_lang.ts';
import { createSectionRecord } from '../../src/core/section/record/create_record.ts';
import { saveComponentData } from '../../src/core/section/record/save_component.ts';
import type { Principal } from '../../src/core/security/permissions.ts';
import {
	dropSituation,
	ensureSituation,
	situation,
} from '../../src/core/test_data/situations/situation.ts';
import { assertTestDatabase } from '../../src/core/test_data/test_database_marker.ts';

const TLD = 'zzrll';
const SECTION = `${TLD}1`;
const TEXT = `${TLD}2`;
const PORTAL = `${TLD}3`;
const ENG = 'lg-eng';
const SPA = 'lg-spa';
/** Both lanes of every case: each must answer in ITS language. */
const LANES = [ENG, SPA] as const;

const SUPERUSER: Principal = { userId: -1, isGlobalAdmin: true, isDeveloper: true };

const SITUATION = situation({
	tld: TLD,
	name: 'request_lang_law',
	nodes: [
		{
			tipo: SECTION,
			parent: 'test1',
			model: 'section',
			term: { [ENG]: 'Law host', [SPA]: 'Anfitrión de la ley' },
		},
		{
			tipo: TEXT,
			parent: SECTION,
			model: 'component_input_text',
			is_translatable: true,
			term: { [ENG]: 'Law text', [SPA]: 'Texto de la ley' },
		},
		{
			tipo: PORTAL,
			parent: SECTION,
			model: 'component_portal',
			term: { [ENG]: 'Law portal', [SPA]: 'Portal de la ley' },
			properties: {
				source: {
					request_config: [
						{
							sqo: {
								section_tipo: [{ value: [SECTION], source: 'section' }],
								filter_by_list: [{ section_tipo: SECTION, component_tipo: TEXT }],
							},
							show: { ddo_map: [{ tipo: TEXT, parent: 'self', section_tipo: 'self' }] },
						},
					],
				},
			},
		},
	],
});

/** Run `fn` with BOTH request languages set to `lang`. */
const inLang = <T>(lang: string, fn: () => Promise<T>): Promise<T> =>
	runWithRequestLangs({ applicationLang: lang, dataLang: lang }, fn);

let recordId = 0;
const createdIds: number[] = [];

beforeAll(async () => {
	await assertTestDatabase('request_lang_law_native');
	await dropSituation(SITUATION);
	await ensureSituation(SITUATION);
	await clearOntologyDerivedCaches();
	recordId = await createSectionRecord(SECTION, -1);
	createdIds.push(recordId);
	for (const [lang, value] of [
		[ENG, 'alpha'],
		[SPA, 'alfa'],
	] as const) {
		const outcome = await saveComponentData({
			componentTipo: TEXT,
			sectionTipo: SECTION,
			sectionId: recordId,
			lang,
			changedData: [{ action: 'set_data', id: null, value: [{ value, lang }] }],
			userId: -1,
		});
		expect(outcome.ok).toBe(true);
	}
}, 60_000);

afterAll(async () => {
	await sql.unsafe(
		`DELETE FROM matrix_activity
		  WHERE section_tipo = 'dd542'
		    AND misc->'dd551'->0->'value'->>'section_tipo' LIKE $1`,
		[`${TLD}%`],
	);
	expect(await dropSituation(SITUATION)).toBe(0);
	await clearOntologyDerivedCaches();
});

describe('premise: the situation names itself differently per language', () => {
	test('section and field terms differ between the two lanes', async () => {
		expect(await termByTipo(SECTION, ENG)).not.toBe(await termByTipo(SECTION, SPA));
		expect(await termByTipo(TEXT, ENG)).not.toBe(await termByTipo(TEXT, SPA));
	});
});

describe('O15-3b — request_config filter_by_list expands in the request data lang', () => {
	test('a context without lang: the filter field context speaks the request data lang', async () => {
		const properties = await getPropertiesByTipo(PORTAL);
		for (const lang of LANES) {
			const config = await inLang(lang, () =>
				buildRequestConfigForElement(properties, {
					ownerTipo: PORTAL,
					ownerSectionTipo: SECTION,
					mode: 'edit',
					ownerIsSection: false,
				}),
			);
			const expanded = config[0]?.sqo?.filter_by_list as
				| { context: { tipo?: string; lang?: string } }[]
				| undefined;
			expect(expanded?.length, lang).toBe(1);
			expect(expanded?.[0]?.context.tipo).toBe(TEXT);
			expect(expanded?.[0]?.context.lang, lang).toBe(lang);
		}
	});
});

describe('OX7-1b — a new record is labelled in the request application lang', () => {
	test('data.label = the section term in the creating request application lang', async () => {
		for (const lang of LANES) {
			const id = await inLang(lang, () => createSectionRecord(SECTION, -1));
			createdIds.push(id);
			const rows = (await sql.unsafe(
				`SELECT data->>'label' AS label FROM matrix_test WHERE section_tipo = $1 AND section_id = $2`,
				[SECTION, id],
			)) as { label: string | null }[];
			expect(rows[0]?.label, lang).toBe(await termByTipo(SECTION, lang));
		}
	});
});

describe('login context — the ddo lang is the request application lang', () => {
	test('lang follows the scope (the pre-auth cookie seeds it)', async () => {
		for (const lang of LANES) {
			const context = await inLang(lang, () => buildLoginContext());
			expect(context.lang, lang).toBe(lang);
		}
	});
});

describe('MCP — an omitted lang is the request lang, never a literal', () => {
	test('describe_section: field labels in the request application lang', async () => {
		for (const lang of LANES) {
			const described = await inLang(lang, () => describeSection(SUPERUSER, { section: SECTION }));
			const field = described.fields.find((item) => item.tipo === TEXT);
			expect(field?.label, lang).toBe(await termByTipo(TEXT, lang));
		}
	});

	test('read_record: the translatable value in the request data lang', async () => {
		for (const [lang, expected] of [
			[ENG, 'alpha'],
			[SPA, 'alfa'],
		] as const) {
			const read = await inLang(lang, () =>
				readSectionRecord(SUPERUSER, { section_tipo: SECTION, section_id: recordId, mode: 'edit' }),
			);
			const entry = (read.data as { tipo?: string; lang?: string; entries?: unknown }[]).find(
				(item) => item.tipo === TEXT,
			);
			expect(entry?.lang, lang).toBe(lang);
			expect(JSON.stringify(entry?.entries ?? null), lang).toContain(expected);
		}
	});

	test('search_section: a filter without lang matches the request data lang slice', async () => {
		for (const [lang, query] of [
			[ENG, '==alpha'],
			[SPA, '==alfa'],
		] as const) {
			const found = await inLang(lang, () =>
				searchSectionRecords(SUPERUSER, {
					section_tipo: SECTION,
					filter: { component_tipo: TEXT, query },
				}),
			);
			expect(
				found.hits.map((hit) => hit.section_id),
				lang,
			).toEqual([recordId]);
		}
	});

	test('llm map: link targets resolved in the request data lang', async () => {
		for (const lang of LANES) {
			const seen: string[] = [];
			await inLang(lang, () =>
				buildLlmMap({
					listSectionNodes: async () => [{ tipo: SECTION, term: null }],
					sectionFieldNodes: async () => [{ tipo: PORTAL, model: 'component_portal' } as never],
					linkTargetSections: async (_component, _section, targetLang) => {
						seen.push(targetLang);
						return [SECTION];
					},
				}),
			);
			expect(seen, lang).toEqual([lang]);
		}
	});
});
