/**
 * `with_lang_versions` — THE CONTRACT, door by door (WC-2026-10-31-
 * transliterate-value-emitted).
 *
 * A TRANSLITERABLE component is NOT translatable, yet keeps per-language
 * VERSIONS beside its lg-nolan BASE: a component whose ontology `properties`
 * say `with_lang_versions: true` (the `test` TLD's test166, a
 * component_input_text — "Augustus" in lg-nolan, "Αύγουστος" in lg-ell) and
 * EVERY component_iri (test140). The base is what the edit form, list cells,
 * labels and exports show; a version is what tool_lang edits.
 *
 * The PHP contract this file pins (v6 semantics — the frozen v7 PHP never read
 * the property, see resolver.ts hasLangVersions):
 *
 *   1. INSTANCE LANG (class.component_common.php:666-678 + common::
 *      get_element_lang :3684): non-translatable → lg-nolan, EXCEPT a
 *      transliterable keeps the lang the caller EXPLICITLY asked for. The
 *      ambient page data lang of a section/list read is never an explicit ask
 *      — were it one, the normal edit form would build and SAVE the component
 *      in lg-spa instead of its base. (resolver.ts elementLang)
 *   2. CONTEXT `lang` = the instance lang: the client copies it into the
 *      instance (instances.js get_instance, section_record children), so the
 *      tool_lang target builds in the version's lang and every other instance
 *      in the base. Doors: get_element_context (omitted lang → the rule's
 *      default), the section read's per-ddo context, a ddo's declared lang.
 *   3. TOOLS (class.common.php:4130): requirement_translatable tools
 *      (tool_lang) are offered when translatable OR transliterable.
 *   4. DATA: `transliterate_value` — gated in depth by
 *      lang_versions_emit_native.test.ts (both directions, null vs [], the
 *      save echo, list cells, iri id/iri/title); here only its pairing with
 *      the round-trips below.
 *   5. CSV IMPORT (class.tool_import_dedalo_csv.php:921,1038): a lang-keyed
 *      cell files each version in its own lang; a plain cell is the base.
 *   6. DIFFUSION (v6 class.diffusion_sql.php:1727): an empty lang slice falls
 *      back to the base — the pure publication side (atoms, parsers, ladder,
 *      term path) lives in diffusion_lang_versions.test.ts; the ddo LANG PIN
 *      (resolver.ts applyDdoLangPin) needs the ontology's with_lang_versions
 *      flag and is gated here.
 *
 * And the neighbours the rule must NOT drag along: a select-family relation
 * (test87, component_radio_button — instance lang lg-nolan by the same rule)
 * still labels its options in the request DATA lang (PHP get_list_of_values(
 * DEDALO_DATA_LANG)), whatever lang the read asked for.
 *
 * Plus the doors the rule reaches beyond PHP's own list, each of which used to
 * collapse a version into the base or hide it: the SEARCH (a lang-less clause
 * searches every lang, so a version matches — PHP get_search_query's 'all'),
 * the agent write door (setField keeps an explicit lang), and tool_lang's
 * translation write (translateAndWrite: a version is written beside the base,
 * never over it).
 *
 * CONTRASTS, every one on the same scratch record: test162 (plain
 * non-translatable input_text — nolan-forced whatever is asked, no tool_lang)
 * and test52 (translatable — the ambient lang is its default).
 *
 * THE SITUATION IS BUILT: scratch test3 records minted through the engine's
 * create door (no id band, no canonical record touched), values seeded per
 * case, the record + its TM / activity rows + the CSV run's bulk-process rows
 * swept after. The CSV file lives under the suite media root, removed after.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setField } from '../../src/ai/mcp/tools/fields_write.ts';
import { config } from '../../src/config/config.ts';
import { type ApiRequestContext, dispatchRqo } from '../../src/core/api/dispatch.ts';
import type { Rqo } from '../../src/core/concepts/rqo.ts';
import type { MatrixRecord } from '../../src/core/db/matrix.ts';
import { updateMatrixRecord } from '../../src/core/db/matrix_write.ts';
import { sql } from '../../src/core/db/postgres.ts';
import {
	effectiveSaveLang,
	elementLang,
	getMatrixTableFromTipo,
	hasLangVersions,
	savesInRequestLang,
} from '../../src/core/ontology/resolver.ts';
import { getEditDatalist } from '../../src/core/relations/datalist.ts';
import { runWithRequestLangs } from '../../src/core/resolve/request_lang.ts';
import { buildStructureContext } from '../../src/core/resolve/structure_context.ts';
import { readComponentData } from '../../src/core/section/read.ts';
import { createSectionRecord } from '../../src/core/section/record/create_record.ts';
import { type Principal, resolvePrincipal } from '../../src/core/security/permissions.ts';
import { assertTestDatabase } from '../../src/core/test_data/test_database_marker.ts';
import type { ImportFileReport } from '../../src/core/tools/import_wire.ts';
import { getLoadedTool } from '../../src/core/tools/loader.ts';
import { translateAndWrite } from '../../src/core/tools/translation.ts';
import { defaultPublicationValue } from '../../src/diffusion/resolve/default_value.ts';
import { applyDdoLangPin } from '../../src/diffusion/resolve/resolver.ts';
import { mustGet } from '../helpers/assert.ts';
import { cleanScratchRecord } from '../helpers/test_data.ts';
import { superuserTranslationGrant } from '../helpers/translation_grant.ts';

const SECTION = 'test3';
const TABLE = 'matrix_test';
/** component_input_text, NOT translatable, `properties.with_lang_versions: true`. */
const XLIT = 'test166';
/** component_input_text, NOT translatable, no properties — the plain contrast. */
const PLAIN = 'test162';
/** component_input_text, translatable. */
const TRANSLATABLE = 'test52';
/** component_iri, NOT translatable — always transliterable. */
const IRI = 'test140';
const INPUT = 'component_input_text';

const NOLAN = 'lg-nolan';
const ELL = 'lg-ell';
const SPA = 'lg-spa';
const ENG = 'lg-eng';

const SUPERUSER: Principal = { userId: -1, isGlobalAdmin: true, isDeveloper: true };
/** The CSV door files uploads per user: this file's own upload directory. */
const CSV_USER = 987_166;
const csvDir = resolve(config.media.rootPath ?? '', 'import/files', String(CSV_USER));

/** Every scratch record this file minted (swept in afterAll). */
const minted: number[] = [];
/** Every bulk process (dd800) the CSV run opened (swept in afterAll). */
const bulkIds: number[] = [];

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

/** The root context whose SESSION picks `dataLang` (the dispatcher scopes the request data lang from it). */
function contextIn(dataLang: string): ApiRequestContext {
	return {
		...rootContext,
		session: { ...rootContext.session, dataLang } as ApiRequestContext['session'],
	};
}

type Item = {
	tipo?: string;
	section_id?: unknown;
	lang?: string;
	entries?: Record<string, unknown>[] | null;
	transliterate_value?: Record<string, unknown>[] | null;
};
type ContextEntry = { tipo?: string; lang?: string; tools?: { name?: string }[] };

/** A fresh scratch test3 record, swept after. */
async function newRecord(): Promise<number> {
	const id = await createSectionRecord(SECTION, -1);
	minted.push(id);
	return id;
}

/** Overwrite the `string` column's value of `tipo` on a scratch record (the engine's matrix door). */
async function seedString(id: number, values: Record<string, unknown[]>): Promise<void> {
	expect(await updateMatrixRecord(TABLE, SECTION, id, { string: values })).toBe('updated');
}

/** The stored items of `tipo` (raw matrix column), as sorted `lang:value` pairs. */
async function stored(id: number, tipo: string, column = 'string'): Promise<string[]> {
	const rows = (await sql.unsafe(
		`SELECT ${column}->$1 AS v FROM ${TABLE} WHERE section_tipo = $2 AND section_id = $3`,
		[tipo, SECTION, id],
	)) as { v: { lang?: string; value?: unknown; iri?: unknown }[] | null }[];
	return (rows[0]?.v ?? []).map((item) => `${item.lang}:${String(item.value ?? item.iri)}`).sort();
}

/** One component's emitted item from the component read door (the tool_lang target's door). */
async function readItem(tipo: string, id: number, dataLang: string, lang?: string): Promise<Item> {
	const items = (await runWithRequestLangs({ applicationLang: ENG, dataLang }, () =>
		readComponentData({
			source: {
				tipo,
				section_tipo: SECTION,
				section_id: id,
				mode: 'edit',
				...(lang === undefined ? {} : { lang }),
			},
		} as never),
	)) as Item[];
	const item = items.find(
		(entry) => entry.tipo === tipo && String(entry.section_id) === String(id),
	);
	expect(item).toBeDefined();
	return item as Item;
}

/** `get_element_context` through the dispatcher: the one context entry's lang. */
async function elementContextLang(
	tipo: string,
	dataLang: string,
	lang?: string,
): Promise<string | undefined> {
	const response = await dispatchRqo(
		{
			action: 'get_element_context',
			dd_api: 'dd_core_api',
			source: { tipo, section_tipo: SECTION, mode: 'edit', ...(lang ? { lang } : {}) },
		} as unknown as Rqo,
		contextIn(dataLang),
	);
	expect(response.status).toBe(200);
	const entries = (response.body as { data: ContextEntry[] }).data;
	return entries.find((entry) => entry.tipo === tipo)?.lang;
}

/**
 * A SECTION read (the edit form / list door) of one record with an explicit
 * show ddo_map, in the session's data lang `dataLang`: the component's
 * per-ddo context entry and data item.
 */
async function sectionRead(
	id: number,
	mode: 'edit' | 'list',
	ddo: Record<string, unknown>,
	dataLang: string,
): Promise<{ context: ContextEntry | undefined; item: Item | undefined }> {
	const response = await runWithRequestLangs({ applicationLang: ENG, dataLang }, () =>
		dispatchRqo(
			{
				action: 'read',
				dd_api: 'dd_core_api',
				source: {
					action: 'search',
					tipo: SECTION,
					section_tipo: SECTION,
					mode,
					lang: dataLang,
				},
				sqo: {
					section_tipo: [SECTION],
					filter_by_locators: [{ section_tipo: SECTION, section_id: String(id) }],
					limit: 1,
				},
				show: { ddo_map: [{ section_tipo: SECTION, parent: SECTION, mode, ...ddo }] },
			} as unknown as Rqo,
			contextIn(dataLang),
		),
	);
	expect(response.status).toBe(200);
	const body = (response.body as { data: { context: ContextEntry[]; data: Item[] } }).data;
	return {
		context: body.context.find((entry) => entry.tipo === ddo.tipo),
		item: body.data.find(
			(entry) => entry.tipo === ddo.tipo && String(entry.section_id) === String(id),
		),
	};
}

/** The component save door through the dispatcher (what the client's change_value sends). */
async function save(tipo: string, id: number, lang: string, value: Record<string, unknown>) {
	const response = await runWithRequestLangs({ applicationLang: ENG, dataLang: SPA }, () =>
		dispatchRqo(
			{
				action: 'save',
				dd_api: 'dd_core_api',
				source: { type: 'component', tipo, section_tipo: SECTION, section_id: id, lang },
				data: { changed_data: [{ action: 'update', id: value.id, value }] },
			} as unknown as Rqo,
			rootContext,
		),
	);
	expect(response.status).toBe(200);
}

/** `count` of test3 records whose `tipo` matches `q` (clause lang optional) — scoped to the minted ids. */
async function countMatches(tipo: string, q: string, lang?: string): Promise<number> {
	const response = await runWithRequestLangs({ applicationLang: ENG, dataLang: SPA }, () =>
		dispatchRqo(
			{
				action: 'count',
				dd_api: 'dd_core_api',
				sqo: {
					section_tipo: [SECTION],
					filter: {
						$and: [
							{
								q,
								...(lang === undefined ? {} : { lang }),
								path: [{ section_tipo: SECTION, component_tipo: tipo, model: INPUT }],
							},
						],
					},
				},
			} as unknown as Rqo,
			contextIn(SPA),
		),
	);
	expect(response.status).toBe(200);
	return (response.body as { data: { total: number } }).data.total;
}

beforeAll(async () => {
	await assertTestDatabase('with_lang_versions_native');
	expect(await getMatrixTableFromTipo(SECTION)).toBe(TABLE);
	mkdirSync(csvDir, { recursive: true });
}, 60_000);

afterAll(async () => {
	for (const id of minted) {
		await cleanScratchRecord(SECTION, id, TABLE);
		await sql`DELETE FROM matrix_activity
			WHERE data->>'section_tipo' = ${SECTION} AND data->>'section_id' = ${String(id)}`;
	}
	const bulkTable = await getMatrixTableFromTipo('dd800');
	for (const id of bulkIds) {
		await sql.unsafe(
			`DELETE FROM "${bulkTable}" WHERE section_tipo = 'dd800' AND section_id = $1`,
			[id],
		);
		await sql.unsafe(
			`DELETE FROM matrix_time_machine WHERE section_tipo = 'dd800' AND section_id = $1`,
			[id],
		);
	}
	rmSync(csvDir, { recursive: true, force: true });
}, 60_000);

describe('1. the ONE instance-lang rule (resolver.ts elementLang) — the facts every door below stands on', () => {
	test('which component is transliterable: with_lang_versions yes, every iri yes, plain no, translatable no', async () => {
		expect(await hasLangVersions(XLIT, INPUT)).toBe(true);
		expect(await hasLangVersions(IRI, 'component_iri')).toBe(true);
		expect(await hasLangVersions(PLAIN, INPUT)).toBe(false);
		expect(await hasLangVersions(TRANSLATABLE, INPUT)).toBe(false);
		// The save door keeps a version's lang; a plain one is always the base.
		expect(await savesInRequestLang(XLIT, INPUT)).toBe(true);
		expect(await effectiveSaveLang(XLIT, INPUT, ELL)).toBe(ELL);
		expect(await effectiveSaveLang(PLAIN, INPUT, ELL)).toBe(NOLAN);
	});

	test('transliterable: an EXPLICIT ask is kept, no ask is the base — the ambient lang never counts', async () => {
		expect(await elementLang(XLIT, INPUT, { requested: ELL, ambient: SPA })).toBe(ELL);
		expect(await elementLang(XLIT, INPUT, { ambient: SPA })).toBe(NOLAN);
		expect(await elementLang(XLIT, INPUT, { requested: null, ambient: SPA })).toBe(NOLAN);
		// An empty-string lang is no ask (a client that sends `lang: ''`).
		expect(await elementLang(XLIT, INPUT, { requested: '', ambient: SPA })).toBe(NOLAN);
		// component_iri is in the transliterable branch (PHP get_element_lang
		// reads only `translatable`): its default is the base, not the data lang.
		expect(await elementLang(IRI, 'component_iri', { ambient: SPA })).toBe(NOLAN);
		expect(await elementLang(IRI, 'component_iri', { requested: ELL, ambient: SPA })).toBe(ELL);
	});

	test('contrasts: translatable takes the ask else the ambient lang; plain is lg-nolan whatever is asked', async () => {
		expect(await elementLang(TRANSLATABLE, INPUT, { ambient: SPA })).toBe(SPA);
		expect(await elementLang(TRANSLATABLE, INPUT, { requested: ELL, ambient: SPA })).toBe(ELL);
		expect(await elementLang(PLAIN, INPUT, { requested: ELL, ambient: SPA })).toBe(NOLAN);
		expect(await elementLang(PLAIN, INPUT, { ambient: SPA })).toBe(NOLAN);
	});
});

describe('2. context `lang` = the instance lang, at every context door', () => {
	test('get_element_context: an omitted lang is the BASE (the client builds a model-less instance from it); an explicit one is kept', async () => {
		// instances.js get_instance sends no lang and overwrites options.lang with
		// context.lang: an ambient default here would build rsc85-like fields in
		// the session's data lang and save them there.
		expect(await elementContextLang(XLIT, SPA)).toBe(NOLAN);
		expect(await elementContextLang(XLIT, SPA, ELL)).toBe(ELL);
		expect(await elementContextLang(IRI, SPA)).toBe(NOLAN);
		// Contrasts at the same door.
		expect(await elementContextLang(PLAIN, SPA, ELL)).toBe(NOLAN);
		expect(await elementContextLang(TRANSLATABLE, SPA)).toBe(SPA);
	}, 30_000);

	test('buildStructureContext: requestedLang is the explicit signal; the read lang alone is ambient', async () => {
		const build = (requestedLang?: string) =>
			buildStructureContext({
				configFrom: { source: 'own', reason: 'unit-test' },
				tipo: XLIT,
				sectionTipo: SECTION,
				mode: 'edit',
				lang: SPA,
				permissions: 2,
				addRequestConfig: false,
				...(requestedLang === undefined ? {} : { requestedLang }),
			});
		expect((await build())?.lang).toBe(NOLAN);
		expect((await build(ELL))?.lang).toBe(ELL);
	});

	test('the SECTION edit read in a Spanish session: the transliterable child runs in its base (context AND data)', async () => {
		const id = await newRecord();
		await seedString(id, {
			[XLIT]: [
				{ id: 1, lang: NOLAN, value: 'Augustus' },
				{ id: 1, lang: SPA, value: 'Augusto' },
			],
		});
		const { context, item } = await sectionRead(id, 'edit', { tipo: XLIT }, SPA);
		expect(context?.lang).toBe(NOLAN);
		expect(item?.lang).toBe(NOLAN);
		expect(item?.entries).toEqual([{ id: 1, lang: NOLAN, value: 'Augustus' }]);
		// …with the session's version beside it.
		expect(item?.transliterate_value).toEqual([{ id: 1, lang: SPA, value: 'Augusto' }]);
		// The tool button rides that context: the client renders context.tools verbatim.
		expect((context?.tools ?? []).map((tool) => tool.name)).toContain('tool_lang');
	}, 30_000);

	test('a ddo that DECLARES its lang is an explicit ask: context and data run in it (PHP oracle: an iri ddo with lang lg-spa)', async () => {
		const id = await newRecord();
		await seedString(id, {
			[XLIT]: [
				{ id: 1, lang: NOLAN, value: 'Augustus' },
				{ id: 1, lang: ELL, value: 'Αύγουστος' },
			],
		});
		const { context, item } = await sectionRead(id, 'list', { tipo: XLIT, lang: ELL }, SPA);
		expect(context?.lang).toBe(ELL);
		expect(item?.lang).toBe(ELL);
		expect(item?.entries).toEqual([{ id: 1, lang: ELL, value: 'Αύγουστος' }]);
		expect(item?.transliterate_value).toEqual([{ id: 1, lang: NOLAN, value: 'Augustus' }]);
		// The same declared lang on a PLAIN component is ignored: lg-nolan.
		const plain = await sectionRead(id, 'list', { tipo: PLAIN, lang: ELL }, SPA);
		expect(plain.context?.lang).toBe(NOLAN);
	}, 30_000);
});

describe('3. requirement_translatable tools are offered on transliterables', () => {
	test('get_element_context stamps tool_lang on test166 and test140, never on the plain sibling', async () => {
		const toolsOf = async (tipo: string) => {
			const response = await dispatchRqo(
				{
					action: 'get_element_context',
					dd_api: 'dd_core_api',
					source: { tipo, section_tipo: SECTION, mode: 'edit' },
				} as unknown as Rqo,
				contextIn(SPA),
			);
			const entry = (response.body as { data: ContextEntry[] }).data.find(
				(candidate) => candidate.tipo === tipo,
			);
			expect(entry).toBeDefined();
			return (entry?.tools ?? []).map((tool) => tool.name);
		};
		expect(await toolsOf(XLIT)).toContain('tool_lang');
		expect(await toolsOf(IRI)).toContain('tool_lang');
		expect(await toolsOf(TRANSLATABLE)).toContain('tool_lang');
		expect(await toolsOf(PLAIN)).not.toContain('tool_lang');
	}, 30_000);
});

describe('4. round-trips: every write lands in its own lane, every read shows the right one', () => {
	test('the edit form saves the BASE (it sends context.lang = lg-nolan); a version save never touches the base', async () => {
		const id = await newRecord();
		// What the form instance sends: its own lang, which the context set to the base.
		await save(XLIT, id, NOLAN, { id: 1, lang: NOLAN, value: 'Augustus' });
		// What the tool_lang target sends: the version's lang.
		await save(XLIT, id, ELL, { id: 1, lang: ELL, value: 'Αύγουστος' });
		expect(await stored(id, XLIT)).toEqual([`${ELL}:Αύγουστος`, `${NOLAN}:Augustus`]);
		// Re-saving the base keeps the version.
		await save(XLIT, id, NOLAN, { id: 1, lang: NOLAN, value: 'Octavianus' });
		expect(await stored(id, XLIT)).toEqual([`${ELL}:Αύγουστος`, `${NOLAN}:Octavianus`]);

		// The default read (no explicit lang) shows the base, with the session's version beside it.
		const base = await readItem(XLIT, id, ELL);
		expect(base.lang).toBe(NOLAN);
		expect(base.entries).toEqual([{ id: 1, lang: NOLAN, value: 'Octavianus' }]);
		expect(base.transliterate_value).toEqual([{ id: 1, lang: ELL, value: 'Αύγουστος' }]);
		// The explicit read (the tool_lang target) shows the version, the base beside it.
		const version = await readItem(XLIT, id, SPA, ELL);
		expect(version.lang).toBe(ELL);
		expect(version.entries).toEqual([{ id: 1, lang: ELL, value: 'Αύγουστος' }]);
		expect(version.transliterate_value).toEqual([{ id: 1, lang: NOLAN, value: 'Octavianus' }]);
	}, 60_000);

	test('the same saves on a PLAIN component collapse into the base (the contrast that makes the lanes observable)', async () => {
		const id = await newRecord();
		await save(PLAIN, id, NOLAN, { id: 1, lang: NOLAN, value: 'plain' });
		await save(PLAIN, id, ELL, { id: 1, lang: ELL, value: 'πλέον' });
		expect(await stored(id, PLAIN)).toEqual([`${NOLAN}:πλέον`]);
		const read = await readItem(PLAIN, id, SPA, ELL);
		expect(read.lang).toBe(NOLAN);
		expect('transliterate_value' in read).toBe(false);
	}, 60_000);

	test('tool_lang translation write (translateAndWrite lg-nolan → lg-ell) adds the version beside the base', async () => {
		const id = await newRecord();
		await seedString(id, { [XLIT]: [{ id: 1, lang: NOLAN, value: 'Augustus' }] });
		const outcome = await translateAndWrite(await superuserTranslationGrant(SECTION, XLIT, id), {
			model: INPUT,
			sourceLang: NOLAN,
			targetLang: ELL,
			provider: async (request) => ({
				ok: true,
				text: request.text === 'Augustus' ? 'Αύγουστος' : `?${request.text}`,
				msg: 'ok',
			}),
			uri: 'test://transliterate',
			key: '',
		});
		expect(outcome.ok).toBe(true);
		expect(await stored(id, XLIT)).toEqual([`${ELL}:Αύγουστος`, `${NOLAN}:Augustus`]);
	}, 60_000);

	test('the agent write door (setField) keeps an explicit lang on a transliterable, defaults to the base', async () => {
		const id = await newRecord();
		await runWithRequestLangs({ applicationLang: ENG, dataLang: SPA }, async () => {
			await setField(SUPERUSER, {
				section_tipo: SECTION,
				section_id: id,
				field: XLIT,
				value: 'Augustus',
				mode: 'replace',
			});
			await setField(SUPERUSER, {
				section_tipo: SECTION,
				section_id: id,
				field: XLIT,
				value: 'Αύγουστος',
				lang: ELL,
				mode: 'replace',
			});
		});
		expect(await stored(id, XLIT)).toEqual([`${ELL}:Αύγουστος`, `${NOLAN}:Augustus`]);
	}, 60_000);

	test('setField REPLACE on a transliterable replaces the version IN its lang — never matches the base, never appends a second version', async () => {
		// The version carries a DIFFERENT id than the base (an MCP append mints a
		// fresh one): matching "any stored item" would pick the base (id 1), send
		// its id into the lg-ell slice, find nothing and append.
		const id = await newRecord();
		await seedString(id, {
			[XLIT]: [
				{ id: 1, lang: NOLAN, value: 'Augustus' },
				{ id: 2, lang: ELL, value: 'Αύγουστος' },
			],
			[PLAIN]: [{ id: 1, lang: NOLAN, value: 'plain' }],
		});
		await runWithRequestLangs({ applicationLang: ENG, dataLang: SPA }, async () => {
			await setField(SUPERUSER, {
				section_tipo: SECTION,
				section_id: id,
				field: XLIT,
				value: 'Αυγουστος',
				lang: ELL,
				mode: 'replace',
			});
			// No lang: the base, replaced in place.
			await setField(SUPERUSER, {
				section_tipo: SECTION,
				section_id: id,
				field: XLIT,
				value: 'Augustus Caesar',
				mode: 'replace',
			});
			// The plain contrast: one slice, its stored item replaced.
			await setField(SUPERUSER, {
				section_tipo: SECTION,
				section_id: id,
				field: PLAIN,
				value: 'plain 2',
				mode: 'replace',
			});
		});
		expect(await stored(id, XLIT)).toEqual([`${ELL}:Αυγουστος`, `${NOLAN}:Augustus Caesar`]);
		expect(await stored(id, PLAIN)).toEqual([`${NOLAN}:plain 2`]);
	}, 60_000);

	test('component_iri: a version written beside the base, each read in its own lane', async () => {
		const id = await newRecord();
		const base = { id: 1, lang: NOLAN, iri: 'https://example.org/augustus', title: 'Augustus' };
		const version = {
			id: 1,
			lang: ELL,
			iri: 'https://example.org/el/augustus',
			title: 'Αύγουστος',
		};
		expect(await updateMatrixRecord(TABLE, SECTION, id, { iri: { [IRI]: [base] } })).toBe(
			'updated',
		);
		await save(IRI, id, ELL, version);
		expect(await stored(id, IRI, 'iri')).toEqual([
			`${ELL}:https://example.org/el/augustus`,
			`${NOLAN}:https://example.org/augustus`,
		]);
		const read = await readItem(IRI, id, SPA, ELL);
		expect(read.lang).toBe(ELL);
		expect(read.entries).toEqual([version]);
		expect(read.transliterate_value).toEqual([base]);
	}, 60_000);
});

describe('search: a lang-less clause searches EVERY lang of a transliterable (PHP get_search_query lang=all)', () => {
	test('a version matches; an explicit lg-nolan clause sees only the base; the plain contrast sees its base', async () => {
		const id = await newRecord();
		// A token only this record holds, so the count is exact whatever else test3 carries.
		const token = `wlvtoken${id}`;
		await seedString(id, {
			[XLIT]: [
				{ id: 1, lang: NOLAN, value: 'Augustus' },
				{ id: 1, lang: ELL, value: `Αύγουστος ${token}` },
			],
			[PLAIN]: [{ id: 1, lang: NOLAN, value: `plain ${token}` }],
		});
		expect(await countMatches(XLIT, token)).toBe(1);
		expect(await countMatches(XLIT, token, ELL)).toBe(1);
		expect(await countMatches(XLIT, token, NOLAN)).toBe(0);
		expect(await countMatches(PLAIN, token)).toBe(1);
	}, 60_000);
});

describe('5. CSV import: a lang-keyed cell files each version in its own lang; a plain cell is the base', () => {
	async function importCsv(file: string, csv: string): Promise<ImportFileReport> {
		writeFileSync(resolve(csvDir, file), csv);
		const loaded = await getLoadedTool('tool_import_dedalo_csv');
		const response = await mustGet(loaded?.module.apiActions.import_files, 'import_files').handler({
			principal: await resolvePrincipal(-1),
			userId: CSV_USER,
			background: false,
			options: {
				files: [
					{
						file,
						section_tipo: SECTION,
						bulk_process_label: file,
						ar_columns_map: [
							{ tipo: 'section_id', model: 'section_id' },
							{ tipo: XLIT, model: INPUT, checked: true, map_to: XLIT },
						],
					},
				],
			},
		});
		const report = (response.data as { files: ImportFileReport[] }).files[0] as ImportFileReport;
		if (report.bulk_process_id !== null) bulkIds.push(report.bulk_process_id);
		return report;
	}
	const quote = (value: string): string => `"${value.replace(/"/g, '""')}"`;

	test('REPLACE {lg-nolan, lg-ell} → both slices; a plain cell → the base only', async () => {
		const keyed = await newRecord();
		const plain = await newRecord();
		const cell = quote(JSON.stringify({ [NOLAN]: ['Augustus'], [ELL]: ['Αύγουστος'] }));
		const report = await importCsv(
			`with_lang_versions_${keyed}.csv`,
			`section_id;${XLIT}\n${keyed};${cell}\n${plain};Tiberius\n`,
		);
		// No row refused (the stored slices below are the positive proof both rows ran).
		expect(report.failed.length).toBe(0);
		expect(await stored(keyed, XLIT)).toEqual([`${ELL}:Αύγουστος`, `${NOLAN}:Augustus`]);
		expect(await stored(plain, XLIT)).toEqual([`${NOLAN}:Tiberius`]);
	}, 60_000);
});

describe('6. publication: the ddo LANG PIN of a transliterable keeps its version alone (resolver.ts applyDdoLangPin)', () => {
	function record(columns: MatrixRecord['columns']): MatrixRecord {
		return { id: 1, section_id: 1, section_tipo: SECTION, columns, rawText: {} };
	}
	/** The atoms the walk hands the pin for one terminal ddo, as `lang:value` (pin output is lang-neutral). */
	async function pinned(
		tipo: string,
		model: string,
		columns: MatrixRecord['columns'],
		pin: string,
	) {
		const atoms = defaultPublicationValue(record(columns), tipo, model, { tipo });
		const out = await applyDdoLangPin(atoms, pin, tipo, model);
		return out.map((atom) => `${atom.lang}:${JSON.stringify((atom as { value?: unknown }).value)}`);
	}
	const versioned = (tipo: string) => ({
		string: {
			[tipo]: [
				{ id: 1, lang: NOLAN, value: 'Augustus' },
				{ id: 1, lang: ELL, value: 'Αύγουστος' },
			],
		},
	});

	test('with_lang_versions pinned to lg-ell: the version ALONE (v6: the instance in that lang) — the base no longer rides beside it', async () => {
		expect(await pinned(XLIT, INPUT, versioned(XLIT), ELL)).toEqual(['null:"Αύγουστος"']);
	});

	test('with_lang_versions pinned to a lang with NO version: the base (prefer, never eliminate)', async () => {
		expect(await pinned(XLIT, INPUT, versioned(XLIT), SPA)).toEqual(['null:"Augustus"']);
	});

	test('a PLAIN model keeps the old rule: a lang-null atom is lang-independent data and passes beside the pinned lang', async () => {
		// The SAME stored shape on test162: the contrast that makes the
		// transliterable branch observable (an inverted flag check reds here or above).
		expect(await pinned(PLAIN, INPUT, versioned(PLAIN), ELL)).toEqual([
			'null:"Augustus"',
			'null:"Αύγουστος"',
		]);
	});

	test('component_iri pinned to lg-ell: its version alone', async () => {
		const base = { id: 1, lang: NOLAN, iri: 'https://example.org/augustus', title: 'Augustus' };
		const version = {
			id: 1,
			lang: ELL,
			iri: 'https://example.org/el/augustus',
			title: 'Αύγουστος',
		};
		const out = await pinned(IRI, 'component_iri', { iri: { [IRI]: [base, version] } }, ELL);
		expect(out).toHaveLength(1);
		expect(out[0]).toContain('https://example.org/el/augustus');
		expect(out[0]).not.toContain('https://example.org/augustus"');
	});
});

describe('the neighbour the rule must not drag along: select-family option labels stay in the request DATA lang', () => {
	/** component_radio_button on test3, options = dd64 (yes / no), NOT translatable. */
	const RADIO = 'test87';
	type SelectItem = Item & { datalist?: { label?: unknown }[]; value?: unknown };

	async function readRadio(id: number, dataLang: string, mode: 'edit' | 'list', lang?: string) {
		const items = (await runWithRequestLangs({ applicationLang: ENG, dataLang }, () =>
			readComponentData({
				source: {
					tipo: RADIO,
					section_tipo: SECTION,
					section_id: id,
					mode,
					...(lang === undefined ? {} : { lang }),
				},
			} as never),
		)) as SelectItem[];
		const item = items.find((entry) => entry.tipo === RADIO);
		expect(item).toBeDefined();
		return item as SelectItem;
	}
	const labels = (item: SelectItem) => (item.datalist ?? []).map((option) => String(option.label));

	test("edit datalist + list value: the data lang's labels for an omitted, an explicit other and an lg-nolan lang (PHP get_list_of_values(DEDALO_DATA_LANG))", async () => {
		const id = await newRecord();
		expect(
			await updateMatrixRecord(TABLE, SECTION, id, {
				relation: {
					[RADIO]: [
						{ type: 'dd151', section_tipo: 'dd64', section_id: '1', from_component_tipo: RADIO },
					],
				},
			}),
		).toBe('updated');
		const props = null;
		const eng = (await getEditDatalist(RADIO, props, SECTION, ENG, [])).map((o) => String(o.label));
		const spa = (await getEditDatalist(RADIO, props, SECTION, SPA, [])).map((o) => String(o.label));
		// FLOOR: the two langs label differently, or the gate below proves nothing.
		expect(eng.length).toBeGreaterThan(0);
		expect(eng).not.toEqual(spa);
		for (const lang of [undefined, ENG, SPA, NOLAN]) {
			const edit = await readRadio(id, ENG, 'edit', lang);
			expect({ lang: lang ?? '(omitted)', labels: labels(edit) }).toEqual({
				lang: lang ?? '(omitted)',
				labels: eng,
			});
		}
		// …and a Spanish session gets Spanish labels, whatever lang is asked.
		expect(labels(await readRadio(id, SPA, 'edit', ENG))).toEqual(spa);
		// The LIST value (the stored option's label) follows the same lang.
		const listEng = await readRadio(id, ENG, 'list', NOLAN);
		const listSpa = await readRadio(id, SPA, 'list', NOLAN);
		expect(JSON.stringify(listEng.entries ?? listEng.value)).not.toEqual(
			JSON.stringify(listSpa.entries ?? listSpa.value),
		);
	}, 60_000);
});
