/**
 * SELECT-FAMILY DATALIST — every door that hands a component its options
 * answers the SAME options the edit read does.
 *
 * WHY THIS FILE EXISTS. component_select_lang's options are the PROJECT
 * languages (PHP component_select_lang::get_list_of_values), but its node's sqo
 * names lg1 — every language record there is (~21.7k on the suite database).
 * The edit read knew (a model conditional in the select-family emitter); the
 * save echo, the temporal echo, filter_by_list and the state widget asked the
 * generic builder instead. So every select_lang SAVE read all ~21.7k lg1
 * records, labeled them, and shipped a 2.2 MB datalist back — 1.7 s cold in
 * process on a laptop, 8.7–10.3 s on a loaded CI runner, which is the
 * `component_select_lang (test89) save launched by deactivate did not settle`
 * flake of test_components_activate (gh runs 35843092386, 36262409411) — and
 * the echo then REPLACED the client's correct 12-option datalist with the
 * 21.7k-option one.
 *
 * The fix moved the rule to the ONE door (relations/datalist.ts getDatalist,
 * descriptor facet `datalistSource`). This gate measures the OUTCOME, per door,
 * for every select-family component of the test3 playground: the save echo's
 * and the temporal echo's datalist deep-equal the edit read's; select_lang's is
 * the project languages; the echo stays small.
 *
 * THE MISSING-LANG ENTRY (PHP component_select_lang_json edit branch). A
 * select_lang whose stored lang is NOT a project lang (one removed from
 * DEDALO_PROJECTS_DEFAULT_LANGS after the save) must still show it: every edit
 * door appends ONE "<name> *" entry, its name in the APPLICATION lang, and the
 * list value is that same label (WC-2026-10-02-select-lang-missing-entry).
 *
 * Situation: scratch test3 records and a scratch lg1 language record (code
 * 'qtx', ISO 639-3 local-use range — no project lang by construction) created here through the engine's
 * save door, never canonical ids; removed with their TM and activity rows in
 * afterAll.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { config } from '../../src/config/config.ts';
import { dispatchRqo } from '../../src/core/api/dispatch.ts';
import type { Rqo } from '../../src/core/concepts/rqo.ts';
import { sql } from '../../src/core/db/postgres.ts';
import { getDatalist, probeDatalistSize } from '../../src/core/relations/datalist.ts';
import { appendMissingLang, getSelectLangDatalist } from '../../src/core/relations/select_lang.ts';
import { runWithRequestLangs } from '../../src/core/resolve/request_lang.ts';
import { createSectionRecord } from '../../src/core/section/record/create_record.ts';
import { resolvePrincipal } from '../../src/core/security/permissions.ts';
import { createSession, getSession } from '../../src/core/security/session_store.ts';
import { registerSessionCleanup } from '../helpers/session_cleanup.ts';
import { cleanScratchRecord } from '../helpers/test_data.ts';

registerSessionCleanup();

const SECTION = 'test3';
const SELECT_LANG = 'test89';
const LANG = 'lg-nolan';

/** Every select-family component of the test3 playground (SELECT_FAMILY_MODELS). */
const SELECT_FAMILY: readonly { model: string; tipo: string }[] = [
	{ model: 'component_check_box', tipo: 'test88' },
	{ model: 'component_radio_button', tipo: 'test87' },
	{ model: 'component_select', tipo: 'test91' },
	{ model: 'component_select_lang', tipo: SELECT_LANG },
	{ model: 'component_publication', tipo: 'test92' },
	{ model: 'component_relation_model', tipo: 'test169' },
];

/**
 * A select_lang echo carrying the project languages is a few KB. The defect
 * shipped 2.2 MB; 64 KiB is two orders of magnitude of headroom either way.
 */
const SELECT_LANG_ECHO_MAX_BYTES = 64 * 1024;

let tsContext: Record<string, unknown>;
let recordId = 0;

/** The scratch non-project language (lg1 record) and the record storing it. */
const LANGS_SECTION = 'lg1';
const LANG_NAME_TIPO = 'hierarchy25';
const LANG_CODE_TIPO = 'hierarchy41';
// ISO 639-3 reserves qaa–qtz for local use: never a real (or project) language.
// Not a `zz…` code, which the scratch-TLD census reads as a TLD carrier.
const MISSING_CODE = 'qtx';
let missingLangId = 0;
let missingRecordId = 0;
/** An lg1 record with NO name and NO code (a half-built language). */
let barrenLangId = 0;
/**
 * Two DIFFERENT declared application langs: the session's interface lang and
 * its data lang. The scratch lang carries a distinct name in each, so the gate
 * tells "named in the application lang" from "named in the data lang".
 */
let appLang = '';
let dataLang = '';
const APP_NAME = 'Zzq interface name';
const DATA_NAME = 'Zzq data name';

type Item = Record<string, unknown> & { tipo?: string; datalist?: unknown[] };

function mainItem(body: unknown, tipo: string): Item {
	const items = (body as { data?: { data?: Item[] } }).data?.data ?? [];
	const found = items.find((item) => item.tipo === tipo);
	if (found === undefined) throw new Error(`no data item for ${tipo} in the response`);
	return found;
}

async function readEdit(
	model: string,
	tipo: string,
	sectionId: number,
	mode: 'edit' | 'list' = 'edit',
): Promise<Item> {
	const response = await dispatchRqo(
		{
			action: 'read',
			dd_api: 'dd_core_api',
			source: {
				model,
				tipo,
				section_tipo: SECTION,
				section_id: sectionId,
				mode,
				lang: LANG,
				action: 'get_data',
			},
		} as unknown as Rqo,
		tsContext as never,
	);
	expect(response.status).toBe(200);
	return mainItem(response.body, tipo);
}

async function save(
	model: string,
	tipo: string,
	sectionId: number,
	changedData: unknown[],
	extraSource: Record<string, unknown> = {},
	sectionTipo: string = SECTION,
) {
	const response = await dispatchRqo(
		{
			action: 'save',
			dd_api: 'dd_core_api',
			prevent_lock: true,
			source: {
				model,
				tipo,
				section_tipo: sectionTipo,
				section_id: sectionId,
				mode: 'edit',
				lang: LANG,
				...extraSource,
			},
			data: { entries: [], changed_data: changedData },
		} as unknown as Rqo,
		tsContext as never,
	);
	expect(response.status).toBe(200);
	return response;
}

beforeAll(async () => {
	const token = createSession(-1, 'root', true);
	const declared = Object.keys(config.lang.applicationLangs);
	appLang = declared[0] ?? '';
	dataLang = declared[1] ?? '';
	if (appLang === '' || dataLang === '') throw new Error('two declared application langs needed');
	// The session pins both langs (dispatch scopes the request with them).
	const session = { ...getSession(token), applicationLang: appLang, dataLang } as Record<
		string,
		unknown
	>;
	tsContext = {
		requestId: 'select_family_echo_datalist_native',
		clientIp: '127.0.0.1',
		session,
		csrfCandidate: session?.csrfToken ?? null,
		principal: await resolvePrincipal(-1),
	};
	recordId = await createSectionRecord(SECTION, -1);

	// The non-project language, built through the engine's save door.
	missingLangId = await createSectionRecord(LANGS_SECTION, -1);
	await save(
		'component_input_text',
		LANG_CODE_TIPO,
		missingLangId,
		[{ action: 'set_data', value: [{ id: 1, lang: 'lg-nolan', value: MISSING_CODE }] }],
		{ lang: 'lg-nolan' },
		LANGS_SECTION,
	);
	for (const [lang, name] of [
		[appLang, APP_NAME],
		[dataLang, DATA_NAME],
	] as const) {
		await save(
			'component_input_text',
			LANG_NAME_TIPO,
			missingLangId,
			[{ action: 'set_data', value: [{ id: 1, lang, value: name }] }],
			{ lang },
			LANGS_SECTION,
		);
	}
	missingRecordId = await createSectionRecord(SECTION, -1);
	barrenLangId = await createSectionRecord(LANGS_SECTION, -1);
});

/** The project-lang options as the session's request scope labels them. */
function sessionProjectLangs() {
	return runWithRequestLangs({ applicationLang: appLang, dataLang }, () =>
		getSelectLangDatalist(LANG),
	);
}

/** Remove a scratch record, its TM rows and the dd542 activity rows of its saves. */
async function cleanScratch(sectionTipo: string, sectionId: number, table: string): Promise<void> {
	if (sectionId <= 0) return;
	await cleanScratchRecord(sectionTipo, sectionId, table);
	await sql.unsafe(
		`DELETE FROM matrix_activity
		 WHERE section_tipo = 'dd542'
		   AND misc->'dd551'->0->'value'->>'section_tipo' = $1
		   AND misc->'dd551'->0->'value'->>'section_id' = $2`,
		[sectionTipo, String(sectionId)],
	);
}

afterAll(async () => {
	await cleanScratch(SECTION, recordId, 'matrix_test');
	await cleanScratch(SECTION, missingRecordId, 'matrix_test');
	await cleanScratch(LANGS_SECTION, missingLangId, 'matrix_langs');
	await cleanScratch(LANGS_SECTION, barrenLangId, 'matrix_langs');
});

describe('the door — getDatalist applies the model option source', () => {
	test('component_select_lang options are the project languages, not the lg1 section', async () => {
		const options = await getDatalist(
			SELECT_LANG,
			null,
			{ section_tipo: SECTION, section_id: null },
			LANG,
		);
		const projectLangs = await getSelectLangDatalist(LANG);
		// Floor: an empty list would make every equality below vacuous.
		expect(projectLangs.length).toBeGreaterThan(0);
		expect(options).toEqual(projectLangs);
		// The language token, not a record id — the select_lang option shape.
		for (const option of options) expect(String(option.section_id)).toMatch(/^lg-/);
		// The probe and the build agree about what the options ARE.
		expect(
			await probeDatalistSize(
				SELECT_LANG,
				null,
				{ section_tipo: SECTION, section_id: null },
				LANG,
				100_000,
			),
		).toBe(options.length);
	});
});

describe('the save echo carries the edit read datalist', () => {
	for (const { model, tipo } of SELECT_FAMILY) {
		test(`${model} (${tipo})`, async () => {
			const read = await readEdit(model, tipo, recordId);
			expect(Array.isArray(read.datalist)).toBe(true);
			const response = await save(model, tipo, recordId, [{ action: 'set_data', value: [] }]);
			const echo = mainItem(response.body, tipo);
			expect(echo.datalist).toEqual(read.datalist);
		});
	}

	test('a select_lang save persists the picked language and echoes a small body', async () => {
		// A project lang stored: the options exactly, no "<name> *" entry.
		const options = await sessionProjectLangs();
		const picked = options[options.length - 1];
		if (picked === undefined) throw new Error('no project language to pick');
		const response = await save('component_select_lang', SELECT_LANG, recordId, [
			{
				action: 'update',
				key: 0,
				value: { ...picked.value, type: 'dd151', from_component_tipo: SELECT_LANG },
			},
		]);
		const echo = mainItem(response.body, SELECT_LANG);
		expect(echo.datalist).toEqual(options);
		expect(echo.entries).toEqual([expect.objectContaining(picked.value)]);
		expect(JSON.stringify(response.body).length).toBeLessThan(SELECT_LANG_ECHO_MAX_BYTES);
		// And the read agrees with what the echo said was stored.
		const read = await readEdit('component_select_lang', SELECT_LANG, recordId);
		expect(read.entries).toEqual([expect.objectContaining(picked.value)]);
		expect(read.datalist).toEqual(options);
	});
});

describe('the temporal echo carries the edit read datalist', () => {
	test('component_select_lang (test89)', async () => {
		const read = await readEdit('component_select_lang', SELECT_LANG, recordId);
		const response = await save(
			'component_select_lang',
			SELECT_LANG,
			recordId,
			[{ action: 'set_data', value: [] }],
			{ is_temporal: true },
		);
		expect(mainItem(response.body, SELECT_LANG).datalist).toEqual(read.datalist);
	});
});

describe('a stored NON-project lang gets ONE "<name> *" entry at every edit door', () => {
	/** The lg1 locator of the scratch language, as the widget posts it. */
	const missingLocator = () => ({
		section_tipo: LANGS_SECTION,
		section_id: missingLangId,
		type: 'dd151',
		from_component_tipo: SELECT_LANG,
	});
	const expectedEntry = () => ({
		value: { section_tipo: LANGS_SECTION, section_id: missingLangId },
		label: `${APP_NAME} *`,
		section_id: `lg-${MISSING_CODE}`,
	});
	const entriesOfMissing = (datalist: unknown[] | undefined) =>
		(datalist ?? []).filter((option) => {
			const value = (option as { value?: { section_tipo?: unknown; section_id?: unknown } }).value;
			return value?.section_tipo === LANGS_SECTION && Number(value?.section_id) === missingLangId;
		});

	test('the scratch lang is no project lang (else the case is vacuous)', async () => {
		expect(missingLangId).toBeGreaterThan(0);
		const projectLangs = await getSelectLangDatalist(LANG);
		expect(projectLangs.length).toBeGreaterThan(0);
		expect(entriesOfMissing(projectLangs)).toEqual([]);
	});

	test('save echo == edit read == temporal echo, the entry present exactly once, appended last', async () => {
		const options = await sessionProjectLangs();
		const response = await save('component_select_lang', SELECT_LANG, missingRecordId, [
			{ action: 'update', key: 0, value: missingLocator() },
		]);
		const echo = mainItem(response.body, SELECT_LANG);
		expect(echo.entries).toEqual([expect.objectContaining({ section_id: missingLangId })]);

		const read = await readEdit('component_select_lang', SELECT_LANG, missingRecordId);
		expect(read.entries).toEqual([expect.objectContaining({ section_id: missingLangId })]);
		// The project options untouched, then the one entry — named in the
		// APPLICATION lang (not the data lang), coded 'lg-<code>'.
		expect(read.datalist).toEqual([...options, expectedEntry()]);
		expect(entriesOfMissing(read.datalist)).toHaveLength(1);

		expect(echo.datalist).toEqual(read.datalist);

		const temporal = await save(
			'component_select_lang',
			SELECT_LANG,
			missingRecordId,
			// The temporal door applies the delta to the client's entries.
			[{ action: 'insert', key: 0, value: missingLocator() }],
			{ is_temporal: true },
		);
		expect(mainItem(temporal.body, SELECT_LANG).datalist).toEqual(read.datalist);
	});

	test('the shared option list (getDatalist) never carries it', async () => {
		expect(
			entriesOfMissing(
				await getDatalist(SELECT_LANG, null, { section_tipo: SECTION, section_id: null }, LANG),
			),
		).toEqual([]);
	});

	test('list mode shows the same application-lang label', async () => {
		const listed = await readEdit('component_select_lang', SELECT_LANG, missingRecordId, 'list');
		expect(listed.value ?? listed.entries).toEqual([`${APP_NAME} *`]);
	});

	test('a nameless, codeless lang still shows: locator-string label, null code (never a bare " *")', async () => {
		const options = await sessionProjectLangs();
		const stored = [{ section_tipo: LANGS_SECTION, section_id: barrenLangId }];
		const completed = await appendMissingLang(options, stored, appLang);
		expect(completed).toEqual([
			...options,
			{
				value: { section_tipo: LANGS_SECTION, section_id: barrenLangId },
				label: `${LANGS_SECTION}_${barrenLangId} *`,
				section_id: null,
			},
		]);
		// The input is never mutated (the options may be a shared list).
		expect(options).toHaveLength(completed.length - 1);
		// Only the FIRST stored locator is guarded (PHP get_missing_lang($value[0])).
		const firstIsOption = [{ ...options[0]?.value }, ...stored];
		expect(await appendMissingLang(options, firstIsOption, appLang)).toEqual(options);
	});
});

/**
 * FILTER FAMILY (component_filter / _master / _records) — the option set is
 * USER-SCOPED (the caller's authorized projects / administered sections), so it
 * is resolved by its own read doors (relations/models/portal.ts filterResolver;
 * the component_filter_records emit hook) and NEVER by the generic
 * target-section enumeration getDatalist builds. Every save echo must still
 * carry the SAME options the edit read does: the client's post-save render
 * reads self.data.datalist, and tool_propagate_component_data renders its
 * editable clone straight from the TEMPORAL echo — an echo without the key
 * rendered the propagate tool's selector with ZERO options
 * (reported 2026-10-23: the tool opened on a component_filter showed none).
 * The attach is getEchoDatalist (relations/datalist.ts), the ONE router both
 * echo doors share; this block pins echo == read for every member.
 */
const FILTER_FAMILY: readonly { model: string; tipo: string }[] = [
	{ model: 'component_filter', tipo: 'test101' },
	{ model: 'component_filter_master', tipo: 'test70' },
	{ model: 'component_filter_records', tipo: 'test69' },
];

describe('the FILTER family — every door answers the user-scoped options', () => {
	test('the edit read carries a NON-empty datalist (the floor)', async () => {
		for (const { model, tipo } of FILTER_FAMILY) {
			const read = await readEdit(model, tipo, recordId);
			// An empty list would make every equality below vacuous: the whole
			// point is that the ECHO carries the options, not the bare item.
			expect(Array.isArray(read.datalist)).toBe(true);
			expect((read.datalist ?? []).length).toBeGreaterThan(0);
		}
	});

	for (const { model, tipo } of FILTER_FAMILY) {
		test(`the save echo carries the edit read datalist — ${model} (${tipo})`, async () => {
			const read = await readEdit(model, tipo, recordId);
			const response = await save(model, tipo, recordId, [{ action: 'set_data', value: [] }]);
			expect(mainItem(response.body, tipo).datalist).toEqual(read.datalist);
		});

		test(`the temporal echo carries the edit read datalist — ${model} (${tipo})`, async () => {
			const read = await readEdit(model, tipo, recordId);
			const response = await save(model, tipo, recordId, [{ action: 'set_data', value: [] }], {
				is_temporal: true,
			});
			expect(mainItem(response.body, tipo).datalist).toEqual(read.datalist);
		});
	}
});
