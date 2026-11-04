/**
 * ORIGINAL-LANGUAGE GATE (the v6 get_original_lang mechanism, ported 2026-07-28).
 *
 * Interviews in one installation are recorded in different languages, so the AV
 * section carries a component_select_lang ("Original language", test89) beside
 * the transcription text_area (test17). The engine must force the text_area to
 * that per-record language in TWO places:
 *
 *   1. the EDIT context carries `options.related_component_lang` — the (until
 *      now dead) client code in tool_transcription/tool_indexation/tool_lang
 *      reads it to open the component in the interview's own language and to
 *      hint the speech recogniser;
 *   2. the LIST emission reads the value in the original language, so a list of
 *      interviews shows each transcript in its own language instead of an empty
 *      current-lang slice.
 *
 * The load-bearing negative: a record WITHOUT an original language must behave
 * exactly as before — no `options` key, request-lang slice — in whatever order
 * the two records are read (the cache-poisoning guard: contexts are built from
 * a shared structural core, and a per-record stamp must never leak across).
 *
 * Uses the REAL ontology triple test17/test3/test89 and the real lg1 records in
 * the suite DB; the matrix rows are scratch (created and deleted here).
 */
// Migrated to the generic `test` TLD 2026-08-20 (AGENTS.md hard rule). The triple is
// now test17 (component_text_area, is_translatable) / test3 (its section) / test89
// (component_select_lang under the same section) — structurally the same triple the
// gate used to read off the install, and the `lg` records it resolves against are
// seed-shipped, so they are generic already.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { getOriginalLang } from '../../src/core/components/component_text_area/original_lang.ts';
import type { Rqo } from '../../src/core/concepts/rqo.ts';
import {
	deleteMatrixRecord,
	insertMatrixRecordWithCounter,
} from '../../src/core/db/matrix_write.ts';
import { getMatrixTableFromTipo } from '../../src/core/ontology/resolver.ts';
import { ElementNodeRegistry } from '../../src/core/relations/element_registry.ts';
import {
	clearSelectLangCache,
	getLangCodeBySectionId,
	getLangSectionIdByCode,
} from '../../src/core/relations/select_lang.ts';
import { buildGetDataContext, readSection } from '../../src/core/section/read.ts';
import {
	dropSituation,
	ensureSituation,
	situation,
} from '../../src/core/test_data/situations/situation.ts';

const SECTION = 'zzolang1';
const TEXT_AREA = 'zzolang2';
const SELECT_LANG = 'zzolang3';
const LIST = 'zzolang4';
/** Resolved after the situation exists — a scratch section owns its own table. */
let TABLE = 'matrix_test';

/**
 * BUILT, not borrowed. The resolution under test walks the TEXT_AREA node's own
 * `relations` for a related `component_select_lang`
 * (resolver.ts relatedTipoByModel, via component_text_area/original_lang.ts), and
 * NO shipped `test` text_area declares that relation — a plain rename would have
 * left the walk with nothing to find and the gate asserting `null` everywhere.
 * So the triple is built with exactly the link the shipped rsc36 → rsc263 pair
 * has. The lang records it resolves INTO are the seed's own `lg1`, which is
 * generic on every installation.
 */
const ORIGINAL_LANG_SITUATION = situation({
	tld: 'zzolang',
	name: 'component_text_area original lang',
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
			// The LIST leg needs a section_list naming the column it emits — a
			// section without one emits no component at all, and the "the list
			// forces the original language" cases would have nothing to assert on.
			tipo: LIST,
			model: 'section_list',
			parent: SECTION,
			relations: [{ tipo: TEXT_AREA }, { tipo: SELECT_LANG }],
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
	],
});

/** lg1 ids resolved from the REAL langs table at setup. */
let spaLg1Id = 0;
/** Scratch records: with and without an original language. */
let withLangId = 0;
let withoutLangId = 0;

/** The stored transcript, deliberately ONLY in lg-spa. */
const SPA_TEXT = '<p>Transcripción original en español.</p>';

beforeAll(async () => {
	await ensureSituation(ORIGINAL_LANG_SITUATION);
	TABLE = (await getMatrixTableFromTipo(SECTION)) ?? 'matrix_test';
	spaLg1Id = (await getLangSectionIdByCode('lg-spa')) ?? 0;
	expect(spaLg1Id).toBeGreaterThan(0); // the suite DB carries real lg1 data

	withLangId = await insertMatrixRecordWithCounter(TABLE, SECTION, {
		relation: {
			[SELECT_LANG]: [
				{
					id: 1,
					type: 'dd151',
					section_tipo: 'lg1',
					section_id: String(spaLg1Id),
					from_component_tipo: SELECT_LANG,
				},
			],
		},
		string: { [TEXT_AREA]: [{ id: 1, value: SPA_TEXT, lang: 'lg-spa' }] },
	});
	withoutLangId = await insertMatrixRecordWithCounter(TABLE, SECTION, {
		string: { [TEXT_AREA]: [{ id: 1, value: SPA_TEXT, lang: 'lg-spa' }] },
	});
});

afterAll(async () => {
	if (withLangId > 0) await deleteMatrixRecord(TABLE, SECTION, withLangId);
	if (withoutLangId > 0) await deleteMatrixRecord(TABLE, SECTION, withoutLangId);
	// Residue asserted, not trusted — the scratch ontology goes with the records.
	expect(await dropSituation(ORIGINAL_LANG_SITUATION)).toBe(0);
});

describe('getLangCodeBySectionId (lg1 → lg-tag)', () => {
	test('round-trips with getLangSectionIdByCode', async () => {
		expect(await getLangCodeBySectionId(spaLg1Id)).toBe('lg-spa');
	});

	test('an unknown lg1 record is null, never lg-undefined', async () => {
		expect(await getLangCodeBySectionId(999999999)).toBeNull();
		expect(await getLangCodeBySectionId(0)).toBeNull();
		expect(await getLangCodeBySectionId(-1)).toBeNull();
	});

	test('survives a cache clear (the save-event invalidation path)', async () => {
		clearSelectLangCache();
		expect(await getLangCodeBySectionId(spaLg1Id)).toBe('lg-spa');
	});
});

describe('getOriginalLang', () => {
	test('resolves the record-declared original language', async () => {
		expect(await getOriginalLang(TEXT_AREA, SECTION, withLangId)).toBe('lg-spa');
	});

	test('a record without the select_lang value is null (no forcing)', async () => {
		expect(await getOriginalLang(TEXT_AREA, SECTION, withoutLangId)).toBeNull();
	});

	test('a tipo whose ontology relates no select_lang is null', async () => {
		// test52 is a test3-playground component with no related component_select_lang.
		expect(await getOriginalLang('test52', 'test3', 1)).toBeNull();
	});
});

describe('edit context carries options.related_component_lang', () => {
	function editRqo(sectionId: number): Rqo {
		return {
			action: 'read',
			source: {
				action: 'read',
				model: 'component_text_area',
				tipo: TEXT_AREA,
				section_tipo: SECTION,
				section_id: sectionId,
				mode: 'edit',
				lang: 'lg-eng', // the menu is on English; the record is Spanish
			},
		} as unknown as Rqo;
	}

	test('stamped for the record WITH an original language', async () => {
		const context = await buildGetDataContext(editRqo(withLangId), {
			items: [],
			nodes: new ElementNodeRegistry(),
		});
		const main = context.find((entry) => entry.tipo === TEXT_AREA);
		expect(main).toBeDefined();
		expect(main?.options).toEqual({ related_component_lang: 'lg-spa' });
	});

	test('ABSENT for the record without one — read AFTER the stamped one (cache-poisoning guard)', async () => {
		// Order matters: the previous test stamped a context built from the same
		// structural core. If the stamp leaked into the shared core, this record
		// would now claim an original language it does not have.
		const context = await buildGetDataContext(editRqo(withoutLangId), {
			items: [],
			nodes: new ElementNodeRegistry(),
		});
		const main = context.find((entry) => entry.tipo === TEXT_AREA);
		expect(main).toBeDefined();
		expect(main?.options).toBeUndefined();
		expect('options' in (main ?? {})).toBe(false); // key absent, not null — the PHP wire shape
	});

	test('and the stamped record still resolves after the bare one (both orders)', async () => {
		const context = await buildGetDataContext(editRqo(withLangId), {
			items: [],
			nodes: new ElementNodeRegistry(),
		});
		expect(context.find((entry) => entry.tipo === TEXT_AREA)?.options).toEqual({
			related_component_lang: 'lg-spa',
		});
	});
});

describe('tag rendering survives the forcing (the lost-tags regression)', () => {
	const TAGGED = '<p>[TC_00:00:01.000_TC]Text en català</p>';
	let vlcaCatId = 0; // test89=vlca, transcript typed under lg-cat (equivalence sibling)
	let fraCatId = 0; // test89=fra (no equivalence), transcript under lg-cat → fallback path

	beforeAll(async () => {
		const vlca = (await getLangSectionIdByCode('lg-vlca')) ?? 0;
		const fra = (await getLangSectionIdByCode('lg-fra')) ?? 0;
		expect(vlca).toBeGreaterThan(0);
		expect(fra).toBeGreaterThan(0);

		vlcaCatId = await insertMatrixRecordWithCounter(TABLE, SECTION, {
			relation: {
				[SELECT_LANG]: [
					{
						id: 1,
						type: 'dd151',
						section_tipo: 'lg1',
						section_id: String(vlca),
						from_component_tipo: SELECT_LANG,
					},
				],
			},
			string: {
				[TEXT_AREA]: [
					{ id: 1, value: null, lang: 'lg-spa' },
					{ id: 1, value: TAGGED, lang: 'lg-cat' },
				],
			},
		});
		fraCatId = await insertMatrixRecordWithCounter(TABLE, SECTION, {
			relation: {
				[SELECT_LANG]: [
					{
						id: 1,
						type: 'dd151',
						section_tipo: 'lg1',
						section_id: String(fra),
						from_component_tipo: SELECT_LANG,
					},
				],
			},
			string: { [TEXT_AREA]: [{ id: 1, value: TAGGED, lang: 'lg-cat' }] },
		});
	});

	afterAll(async () => {
		if (vlcaCatId > 0) await deleteMatrixRecord(TABLE, SECTION, vlcaCatId);
		if (fraCatId > 0) await deleteMatrixRecord(TABLE, SECTION, fraCatId);
	});

	async function listItem(sectionId: number) {
		const rqo = {
			action: 'read',
			source: { tipo: SECTION, section_tipo: SECTION, mode: 'list', lang: 'lg-spa' },
			sqo: {
				section_tipo: [SECTION],
				filter_by_locators: [{ section_tipo: SECTION, section_id: String(sectionId) }],
				limit: 1,
				offset: 0,
			},
		} as unknown as Rqo;
		const { data } = await readSection(rqo);
		return data.find(
			(entry) =>
				(entry as { tipo?: string }).tipo === TEXT_AREA &&
				(entry as { section_id?: unknown }).section_id === sectionId,
		) as
			| { lang?: string; entries?: { value?: unknown }[]; fallback_value?: { value?: unknown }[] }
			| undefined;
	}

	test('the forcing follows the EQUIVALENCE sibling that holds the text (506 shape)', async () => {
		// test89 says Valencian; the transcript was typed under Catalan — the same
		// language. Forcing the literal vlca slice (empty) stranded the text in the
		// UNRENDERED fallback: visible, but with raw [TC_…] literals. The forced
		// lang must be the sibling that actually holds the text.
		const item = await listItem(vlcaCatId);
		expect(item?.lang).toBe('lg-cat');
		const value = String(item?.entries?.find((entry) => entry?.value)?.value ?? '');
		expect(value).toContain('<img');
		expect(value).not.toContain('[TC_00:00:01.000_TC]Text'); // rendered, not raw
	});

	test('a genuine cross-lang FALLBACK is tag-rendered too', async () => {
		// Original is French (no equivalence with Catalan): the cat text correctly
		// stays a fallback — but a LIST fallback must carry the same tag rendering
		// as a list value, never raw [TC_…] literals.
		const item = await listItem(fraCatId);
		expect(item?.lang).toBe('lg-fra');
		expect(item?.entries ?? []).toEqual([]);
		const fallback = String(item?.fallback_value?.find((entry) => entry?.value)?.value ?? '');
		expect(fallback).toContain('<img');
	});
});

describe('list emission forces the original language', () => {
	async function listRead(sectionId: number) {
		const rqo = {
			action: 'read',
			source: {
				tipo: SECTION,
				section_tipo: SECTION,
				mode: 'list',
				lang: 'lg-eng', // the menu is on English
			},
			sqo: {
				section_tipo: [SECTION],
				filter_by_locators: [{ section_tipo: SECTION, section_id: String(sectionId) }],
				limit: 1,
				offset: 0,
			},
		} as unknown as Rqo;
		return readSection(rqo);
	}

	test("the transcript emits in the record's own language, menu notwithstanding", async () => {
		const { data } = await listRead(withLangId);
		const item = data.find(
			(entry) =>
				(entry as { tipo?: string }).tipo === TEXT_AREA &&
				(entry as { section_id?: unknown }).section_id === withLangId,
		) as { lang?: string; entries?: unknown[] } | undefined;
		expect(item).toBeDefined();
		// PHP $this->lang switch: the item's lang AND slice follow the original.
		// (`entries` is the wire name of the value array — WC-001.)
		expect(item?.lang).toBe('lg-spa');
		expect(Array.isArray(item?.entries)).toBe(true);
		expect(String((item?.entries?.[0] as { value?: unknown })?.value ?? '')).toContain(
			'Transcripción',
		);
	});

	test('a record WITHOUT an original language keeps request-lang behaviour', async () => {
		const { data } = await listRead(withoutLangId);
		const item = data.find(
			(entry) =>
				(entry as { tipo?: string }).tipo === TEXT_AREA &&
				(entry as { section_id?: unknown }).section_id === withoutLangId,
		) as { lang?: string; entries?: unknown[] | null; fallback_value?: unknown } | undefined;
		expect(item).toBeDefined();
		expect(item?.lang).toBe('lg-eng'); // the request lang, unforced
		// The lg-eng slice is empty; the GLOBAL fallback machinery still applies —
		// the spa text surfaces only as the read-only fallback_value, exactly as
		// before this feature.
		expect(item?.entries).toEqual([]);
		expect(JSON.stringify(item?.fallback_value ?? '')).toContain('Transcripción');
	});
});
