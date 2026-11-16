/**
 * DATALIST CACHE KEY — the option list of a component is identified by
 * (componentTipo, OWNER SECTION, lang), never by (componentTipo, lang).
 *
 * WHY THIS FILE EXISTS. `getDatalist`'s target sections can resolve FROM THE
 * CALLER: any `{source:'self'}` sqo, and — since 2026-08-14 — the
 * component_relation_model default (`targetSource: 'section_model'`, the
 * caller section's terms→model twin: `hierarchy27` in `testgeoa1` targets
 * `testgeoa2`, the SAME node in `testgeob1` targets `testgeob2` — the two
 * SYNTHETIC activated hierarchies of src/core/test_data/
 * synthetic_hierarchy_fixture.ts, which replaced the real Spain/France pair
 * 2026-08-25: the need was two DISTINCT registry-paired twins, never any
 * country's data). A `componentTipo_lang` key cannot express that answer, so
 * the first caller's list would be served to every other owner section. The
 * consequence is not a display bug: the widget posts the picked option's
 * locator back verbatim and save persists those bytes, so a cataloguer
 * editing a `testgeob1` term would be offered the A hierarchy's typologies
 * and writing one would store `{section_tipo:'testgeoa2'}` into a `testgeob1`
 * record — silent cross-thesaurus corruption. `getRelationListValue` then
 * matches stored locators against that same wrong list, blanking the
 * Tipología column of every other hierarchy.
 *
 * This gate is what makes shipping the target resolution WITHOUT the
 * owner-aware key fail: with the old key every case below serves the
 * first-built list to the second owner (measured RED — see the report), and
 * with no target resolution at all both lists are empty and the "different
 * option lists" assertions fail trivially. The two halves are one change.
 *
 * WHAT IS GATED:
 *  - the two ways a target resolves from the caller — the model default
 *    (hierarchy27 in testgeoa1 vs testgeob1) and a plain `{source:'self'}` sqo (the same
 *    latent bleed, which predates this change);
 *  - ORDER INDEPENDENCE: the answer must not depend on which owner asked
 *    first — that is precisely the pre-fix failure mode;
 *  - `probeDatalistSize` and `getDatalist` agreeing PER OWNER: the probe reads
 *    the same cache, so a probe answering from another owner's entry is the
 *    same bug on the cheap path (it feeds the "is this list over the cap?"
 *    refusals);
 *  - the `datalistKeysBySection` reverse index still evicting correctly with
 *    the 3-part key: a write to ONE target section drops the lists built from
 *    it and leaves the other owner's list untouched.
 *
 * NON-VACUITY. Every case needs the two owners to resolve DIFFERENT targets,
 * and the probe case needs the two lists to have DIFFERENT lengths — otherwise
 * a bleed would be indistinguishable from a correct answer. Both are asserted
 * as fixture preconditions with their own loud messages, never assumed.
 *
 * SCRATCH SURFACE: matrix_hierarchy rows 941001-941999 in `testgeoa2` and
 * `testgeob2` ONLY — seeded here, swept in afterAll (rows + their TM tail,
 * fail-loud). The synthetic model twins hold the engine-minted root at id 1
 * (a truly empty twin cannot activate), so assertions never compare whole
 * lists: they project the built list onto the seeded ids, and the length
 * cases compare the two owners' totals (root included on both sides).
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { sql } from '../../src/core/db/postgres.ts';
import { getModelSectionForSection } from '../../src/core/ontology/model_section.ts';
import {
	clearDatalistCache,
	type DatalistItem,
	getDatalist as getComponentDatalist,
	probeDatalistSize,
} from '../../src/core/relations/datalist.ts';
import { fireSaveEvent } from '../../src/core/section_record/save_event.ts';
import {
	SYNTHETIC_HIERARCHY_A_TLD,
	SYNTHETIC_HIERARCHY_B_TLD,
} from '../../src/core/test_data/synthetic_hierarchy_constants.ts';

/**
 * These gates exercise the GENERIC target-section option list (their components
 * declare no model `datalistSource`), so the wider door type narrows here.
 */
const getDatalist = (...args: Parameters<typeof getComponentDatalist>) =>
	getComponentDatalist(...args) as Promise<DatalistItem[]>;

/** The two callers of the ONE component node, and the model section each must
 * reach — the SYNTHETIC hierarchies' terms/model twins (ES_/FR_ names kept:
 * they read as "first owner"/"second owner", and the seeded labels below
 * keep the same initials). */
const ES_OWNER = `${SYNTHETIC_HIERARCHY_A_TLD}1`;
const ES_TARGET = `${SYNTHETIC_HIERARCHY_A_TLD}2`;
const FR_OWNER = `${SYNTHETIC_HIERARCHY_B_TLD}1`;
const FR_TARGET = `${SYNTHETIC_HIERARCHY_B_TLD}2`;
/** The live node this rule exists for (Tipología, model component_relation_model). */
const RELATION_MODEL_TIPO = 'hierarchy27';
/** The label ddo of a thesaurus model record. */
const LABEL_DDO = 'hierarchy25';
const TABLE = 'matrix_hierarchy';
const LANG = 'lg-eng';

/**
 * Seeded options, DELIBERATELY of different counts per target: the probe case
 * can only detect a cross-owner answer when the two lists differ in length.
 */
const ES_OPTIONS = [
	{ section_id: 941001, label: 'ZZ Scratch ES Alpha' },
	{ section_id: 941002, label: 'ZZ Scratch ES Beta' },
];
const FR_OPTIONS = [
	{ section_id: 941011, label: 'ZZ Scratch FR Alpha' },
	{ section_id: 941012, label: 'ZZ Scratch FR Beta' },
	{ section_id: 941013, label: 'ZZ Scratch FR Gamma' },
];
const ES_IDS = ES_OPTIONS.map((option) => option.section_id);
const FR_IDS = FR_OPTIONS.map((option) => option.section_id);
/** Seeded mid-test by the eviction case only. */
const LATE_FR_ID = 941020;

/**
 * The SHIPPED properties of hierarchy27 — an sqo that declares `section_tipo:
 * []` (defined and empty: the node cannot name its target, which is the whole
 * reason the model declares a `targetSource`) plus the label ddo resolved
 * against the option's own record (`section_tipo: 'self'`).
 */
const RELATION_MODEL_PROPERTIES = {
	source: {
		request_config: [
			{
				sqo: { section_tipo: [] },
				show: {
					ddo_map: [
						{ tipo: LABEL_DDO, parent: 'self', section_tipo: 'self', value_with_parents: false },
					],
					fields_separator: ', ',
				},
			},
		],
	},
};

/**
 * A config whose target is the CALLER's own section — the generic form of the
 * same caller-dependent answer, independent of the component_relation_model
 * default (numisdata73-style self-referencing portals declare exactly this).
 */
const SELF_SOURCE_PROPERTIES = {
	source: {
		request_config: [
			{
				sqo: { section_tipo: [{ source: 'self' }] },
				show: { ddo_map: [{ tipo: LABEL_DDO, parent: 'self', section_tipo: 'self' }] },
			},
		],
	},
};

async function writeOption(sectionTipo: string, sectionId: number, label: string): Promise<void> {
	await sql.unsafe(
		`INSERT INTO ${TABLE} (section_id, section_tipo, string, data)
		 VALUES ($1, $2, $3::text::jsonb, $4::text::jsonb)
		 ON CONFLICT (section_id, section_tipo)
		 DO UPDATE SET string = EXCLUDED.string, data = EXCLUDED.data`,
		[
			sectionId,
			sectionTipo,
			JSON.stringify({ [LABEL_DDO]: [{ id: 1, lang: LANG, value: label }] }),
			JSON.stringify({ section_id: sectionId, section_tipo: sectionTipo }),
		],
	);
}

/**
 * Seed (idempotent). Called before EVERY case, not only in beforeAll: the suite
 * DB is shared, and a case that reads the fixture must re-assert it in the same
 * body rather than trust an earlier file to have left it alone.
 */
async function seedOptions(): Promise<void> {
	for (const option of ES_OPTIONS) await writeOption(ES_TARGET, option.section_id, option.label);
	for (const option of FR_OPTIONS) await writeOption(FR_TARGET, option.section_id, option.label);
	// The seeds are rows, not saves: drop anything cached from a previous case.
	clearDatalistCache();
}

/** The built list projected onto the seeded ids, in build order. */
function seededIds(list: { section_id: number }[]): number[] {
	return list
		.map((item) => item.section_id)
		.filter((id) => ES_IDS.includes(id) || FR_IDS.includes(id));
}

beforeAll(async () => {
	// A DB failure must FAIL this file, never skip it: every case here is a DB
	// case, so a silent pass would be a green gate asserting nothing.
	await sql`SELECT 1`;
	await seedOptions();
});

afterAll(async () => {
	for (const sectionTipo of [ES_TARGET, FR_TARGET]) {
		await sql.unsafe(
			`DELETE FROM ${TABLE} WHERE section_tipo = $1 AND section_id BETWEEN 941000 AND 941999`,
			[sectionTipo],
		);
		await sql.unsafe(
			'DELETE FROM matrix_time_machine WHERE section_tipo = $1 AND section_id BETWEEN 941000 AND 941999',
			[sectionTipo],
		);
	}
	for (const sectionTipo of [ES_TARGET, FR_TARGET]) {
		const rows = (await sql.unsafe(
			`SELECT
				(SELECT count(*)::int FROM ${TABLE}
				  WHERE section_tipo = $1 AND section_id BETWEEN 941000 AND 941999) AS records,
				(SELECT count(*)::int FROM matrix_time_machine
				  WHERE section_tipo = $1 AND section_id BETWEEN 941000 AND 941999) AS tm`,
			[sectionTipo],
		)) as { records: number; tm: number }[];
		if (rows[0]?.records !== 0 || rows[0]?.tm !== 0) {
			throw new Error(
				`datalist_cache_key_native cleanup did not reach zero: ${rows[0]?.records} records / ${rows[0]?.tm} TM rows left in ${sectionTipo} 941000-941999`,
			);
		}
	}
	clearDatalistCache();
	// Drop any list this file cached for the files that run after it.
	await fireSaveEvent(ES_TARGET);
	await fireSaveEvent(FR_TARGET);
});

describe('the option list is identified by (component, OWNER SECTION, lang)', () => {
	test('fixture precondition: the two owners resolve DIFFERENT target sections', async () => {
		// If this ever stops holding, EVERY case below becomes vacuous — a bleed
		// would be indistinguishable from the correct answer. Assert it, loudly,
		// before asserting anything about lists.
		expect(
			await getModelSectionForSection(ES_OWNER),
			`${ES_OWNER} no longer resolves a model section — the whole file is vacuous without it`,
		).toEqual([ES_TARGET]);
		expect(
			await getModelSectionForSection(FR_OWNER),
			`${FR_OWNER} no longer resolves a model section — the whole file is vacuous without it`,
		).toEqual([FR_TARGET]);
		expect(ES_TARGET).not.toBe(FR_TARGET);
	});

	test('one component tipo serves each owner its OWN target section', async () => {
		await seedOptions();
		const spanish = await getDatalist(
			RELATION_MODEL_TIPO,
			RELATION_MODEL_PROPERTIES,
			{ section_tipo: ES_OWNER, section_id: null },
			LANG,
		);
		const french = await getDatalist(
			RELATION_MODEL_TIPO,
			RELATION_MODEL_PROPERTIES,
			{ section_tipo: FR_OWNER, section_id: null },
			LANG,
		);

		// Two owners, ONE component tipo, ONE lang: two distinct lists.
		expect(spanish).not.toBe(french);
		expect(seededIds(spanish)).toEqual(ES_IDS);
		expect(seededIds(french)).toEqual(FR_IDS);

		// THE WRITE-PATH STAKE, stated as an assertion: every option the widget
		// offers carries the locator it will store, so an option from the other
		// thesaurus in this list IS the cross-section corruption — not a
		// cosmetic difference.
		for (const option of spanish) {
			expect(
				option.value.section_tipo,
				`${ES_OWNER} was offered an option from '${option.value.section_tipo}': picking it writes that section_tipo into an ${ES_OWNER} record`,
			).toBe(ES_TARGET);
		}
		for (const option of french) {
			expect(
				option.value.section_tipo,
				`${FR_OWNER} was offered an option from '${option.value.section_tipo}': picking it writes that section_tipo into an ${FR_OWNER} record`,
			).toBe(FR_TARGET);
		}
	});

	test('the answer does not depend on which owner asked FIRST', async () => {
		// The pre-fix failure is exactly "first caller wins", so the reversed
		// build order is the case that catches it in the other direction — a fix
		// that keyed on, say, the first-seen owner would pass the case above.
		await seedOptions();
		const french = await getDatalist(
			RELATION_MODEL_TIPO,
			RELATION_MODEL_PROPERTIES,
			{ section_tipo: FR_OWNER, section_id: null },
			LANG,
		);
		const spanish = await getDatalist(
			RELATION_MODEL_TIPO,
			RELATION_MODEL_PROPERTIES,
			{ section_tipo: ES_OWNER, section_id: null },
			LANG,
		);
		expect(seededIds(french)).toEqual(FR_IDS);
		expect(seededIds(spanish)).toEqual(ES_IDS);
		// …and the second call did not overwrite the first owner's entry either:
		// asking again returns the SAME cached array, not a rebuild of the other.
		expect(
			await getDatalist(
				RELATION_MODEL_TIPO,
				RELATION_MODEL_PROPERTIES,
				{ section_tipo: FR_OWNER, section_id: null },
				LANG,
			),
		).toBe(french);
	});

	test('the same bleed is gated for a plain {source:"self"} sqo', async () => {
		// Not a component_relation_model case: ANY sqo that resolves from the
		// caller has always had this exposure (the model default only made it
		// live). Owners here are the model sections themselves, each its own
		// target — one synthetic component tipo, two owners, two lists.
		await seedOptions();
		const spanish = await getDatalist(
			'zzdlkeyself1',
			SELF_SOURCE_PROPERTIES,
			{ section_tipo: ES_TARGET, section_id: null },
			LANG,
		);
		const french = await getDatalist(
			'zzdlkeyself1',
			SELF_SOURCE_PROPERTIES,
			{ section_tipo: FR_TARGET, section_id: null },
			LANG,
		);
		expect(seededIds(spanish)).toEqual(ES_IDS);
		expect(seededIds(french)).toEqual(FR_IDS);
		for (const option of french) expect(option.value.section_tipo).toBe(FR_TARGET);
	});

	test("probeDatalistSize answers per owner, never from another owner's list", async () => {
		await seedOptions();
		const spanish = await getDatalist(
			RELATION_MODEL_TIPO,
			RELATION_MODEL_PROPERTIES,
			{ section_tipo: ES_OWNER, section_id: null },
			LANG,
		);
		const french = await getDatalist(
			RELATION_MODEL_TIPO,
			RELATION_MODEL_PROPERTIES,
			{ section_tipo: FR_OWNER, section_id: null },
			LANG,
		);
		// Two owners = two entries. Stated before the counts so a shared entry
		// reads as what it is, rather than as a fixture-count complaint.
		expect(spanish, 'both owners were served ONE cached list').not.toBe(french);
		// Non-vacuity: equal lengths would make a cross-owner answer invisible.
		expect(
			spanish.length,
			`the ${ES_TARGET} and ${FR_TARGET} option lists have the same length (${spanish.length}) — reseed different counts or this case cannot detect a bleed`,
		).not.toBe(french.length);

		// The CACHED branch of the probe (both lists are cached right now): each
		// owner must be counted against its own entry.
		expect(
			await probeDatalistSize(
				RELATION_MODEL_TIPO,
				RELATION_MODEL_PROPERTIES,
				{ section_tipo: ES_OWNER, section_id: null },
				LANG,
				50,
			),
		).toBe(spanish.length);
		expect(
			await probeDatalistSize(
				RELATION_MODEL_TIPO,
				RELATION_MODEL_PROPERTIES,
				{ section_tipo: FR_OWNER, section_id: null },
				LANG,
				50,
			),
		).toBe(french.length);

		// The COLD (SQL) branch, with only the OTHER owner's list cached: the
		// probe must miss that entry and count its own target section.
		clearDatalistCache();
		await getDatalist(
			RELATION_MODEL_TIPO,
			RELATION_MODEL_PROPERTIES,
			{ section_tipo: ES_OWNER, section_id: null },
			LANG,
		);
		expect(
			await probeDatalistSize(
				RELATION_MODEL_TIPO,
				RELATION_MODEL_PROPERTIES,
				{ section_tipo: FR_OWNER, section_id: null },
				LANG,
				50,
			),
			`the ${FR_OWNER} probe was answered from the ${ES_OWNER} list`,
		).toBe(french.length);
	});

	test('a write to ONE target section evicts only the lists built from it', async () => {
		// The reverse index (datalistKeysBySection) stores WHOLE cache keys, so it
		// must keep working unchanged with the 3-part key — and must not evict the
		// other owner's list, which shares the component tipo and the lang.
		await seedOptions();
		await sql.unsafe(`DELETE FROM ${TABLE} WHERE section_tipo = $1 AND section_id = $2`, [
			FR_TARGET,
			LATE_FR_ID,
		]);
		clearDatalistCache();
		const spanishBefore = await getDatalist(
			RELATION_MODEL_TIPO,
			RELATION_MODEL_PROPERTIES,
			{ section_tipo: ES_OWNER, section_id: null },
			LANG,
		);
		const frenchBefore = await getDatalist(
			RELATION_MODEL_TIPO,
			RELATION_MODEL_PROPERTIES,
			{ section_tipo: FR_OWNER, section_id: null },
			LANG,
		);
		expect(frenchBefore.some((item) => item.section_id === LATE_FR_ID)).toBe(false);

		await writeOption(FR_TARGET, LATE_FR_ID, 'ZZ Scratch FR Delta');
		await fireSaveEvent(FR_TARGET); // the durable S1-11 eviction channel

		const frenchAfter = await getDatalist(
			RELATION_MODEL_TIPO,
			RELATION_MODEL_PROPERTIES,
			{ section_tipo: FR_OWNER, section_id: null },
			LANG,
		);
		expect(frenchAfter).not.toBe(frenchBefore);
		expect(frenchAfter.some((item) => item.section_id === LATE_FR_ID)).toBe(true);
		// The ES owner's list was built from a DIFFERENT target section: same
		// component tipo, same lang, untouched entry (this half is what proves the
		// eviction is keyed by target section and not a blanket wipe).
		expect(
			await getDatalist(
				RELATION_MODEL_TIPO,
				RELATION_MODEL_PROPERTIES,
				{ section_tipo: ES_OWNER, section_id: null },
				LANG,
			),
		).toBe(spanishBefore);

		await sql.unsafe(`DELETE FROM ${TABLE} WHERE section_tipo = $1 AND section_id = $2`, [
			FR_TARGET,
			LATE_FR_ID,
		]);
		await fireSaveEvent(FR_TARGET);
	});
});
