/**
 * A PORTAL INTO A THESAURUS SHOWS ITS TERM IN THE DATA LANG, THEN THE
 * THESAURUS'S OWN MAIN LANG — resolveLocatorLabels (relations/datalist.ts).
 *
 * THE RULE. A portal whose configured label IS the target thesaurus's term
 * component reads the term through the term resolver's one chain (T2 THES-01,
 * 2026-11-22): the data lang, then the thesaurus main lang, then lg-nolan, then
 * the project langs in config order — never the install default first, never
 * a language no project declares. Toponymy therefore shows its own (main) lang
 * before any other; a term with no value in any of those shows nothing.
 *
 * FIXTURE. The canonical test3 playground (test/preload/canonical_test3.ts) is
 * the thesaurus: test3's section map names `test52` as its term, and test3 is
 * the `test` TLD's own thesaurus, so no ontology is written here.
 *   test3/1  → term in lg-eng only   ('input text content of one')
 *   test3/27 → term in lg-spa only   ('El dos')
 * plus ONE scratch test3 record (term only in lg-tlh, a lang no project
 * declares), created and removed by this file.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { config } from '../../src/config/config.ts';
import { sql } from '../../src/core/db/postgres.ts';
import { resolveLocatorLabels } from '../../src/core/relations/datalist.ts';
import { clearTermCache } from '../../src/core/ts_object/term_resolver.ts';
import { cleanScratchRecord, createScratchRecord } from '../helpers/test_data.ts';

const TERM_SECTION = 'test3';
const TERM_TIPO = 'test52';
/** A portal whose label is the thesaurus term component. */
const PORTAL_WITH_TERM_LABEL = {
	source: {
		request_config: [
			{
				show: {
					ddo_map: [{ tipo: TERM_TIPO, section_tipo: TERM_SECTION, model: 'component_input_text' }],
				},
			},
		],
	},
};

const LOCATOR_ENGLISH_ONLY = { section_tipo: TERM_SECTION, section_id: 1 };
const LOCATOR_SPANISH_ONLY = { section_tipo: TERM_SECTION, section_id: 27 };
/** Scratch: the term only in a lang no project declares. */
const FOREIGN_ID = 925101;
const FOREIGN_LANG = 'lg-tlh';
const LOCATOR_FOREIGN_ONLY = { section_tipo: TERM_SECTION, section_id: FOREIGN_ID };

async function foreignRows(): Promise<number> {
	const rows = (await sql`
		SELECT count(*)::int AS n FROM matrix_test
		WHERE section_tipo = ${TERM_SECTION} AND section_id = ${FOREIGN_ID}
	`) as { n: number }[];
	return rows[0]?.n ?? -1;
}

beforeAll(async () => {
	expect(await foreignRows()).toBe(0);
	await createScratchRecord(TERM_SECTION, FOREIGN_ID, {
		string: { [TERM_TIPO]: [{ id: 1, lang: FOREIGN_LANG, value: 'Only Klingon' }] },
	});
});

afterAll(async () => {
	await cleanScratchRecord(TERM_SECTION, FOREIGN_ID);
	expect(await foreignRows()).toBe(0);
	clearTermCache();
});

// resolveLocatorLabels reads through the term cache; a case must not assert
// the previous case's entry.
beforeEach(() => {
	clearTermCache();
});

function labelsOf(lang: string, locators: { section_tipo: string; section_id: number }[]) {
	return resolveLocatorLabels('test50', PORTAL_WITH_TERM_LABEL, 'test3', lang, locators);
}

describe('resolveLocatorLabels — thesaurus term label', () => {
	test('data lang present: the term in the data lang', async () => {
		expect(await labelsOf('lg-spa', [LOCATOR_SPANISH_ONLY])).toEqual(['El dos']);
	});

	test('data lang missing, thesaurus main lang present: the term in the main lang, untranslated', async () => {
		// test3/1 has no lg-spa term; test3's main lang (lg-eng) supplies it.
		expect(await labelsOf('lg-spa', [LOCATOR_ENGLISH_ONLY])).toEqual(['input text content of one']);
	});

	test('neither the data lang nor the main lang has the term: the first PROJECT lang that does', async () => {
		// test3/27 is Spanish-only; lg-eng (data lang = main lang) and lg-nolan
		// are empty, so the project-lang rung supplies lg-spa (THES-01).
		expect(config.menu.projectsDefaultLangs).toContain('lg-spa');
		expect(await labelsOf('lg-eng', [LOCATOR_SPANISH_ONLY])).toEqual(['El dos']);
	});

	test('a term only in a lang no project declares: nothing — the chain stops at the project langs', async () => {
		expect(config.menu.projectsDefaultLangs).not.toContain(FOREIGN_LANG);
		// The English locator in the same read is the positive control: it proves
		// the lookup actually ran, so the empty verdict is not a blind census.
		const mixed = await labelsOf('lg-eng', [LOCATOR_ENGLISH_ONLY, LOCATOR_FOREIGN_ONLY]);
		expect(mixed).toHaveLength(1);
		expect(mixed).toEqual(['input text content of one']);
		expect(await labelsOf('lg-eng', [LOCATOR_FOREIGN_ONLY])).toEqual([]);
		// …and in its own lang the record does resolve.
		expect(await labelsOf(FOREIGN_LANG, [LOCATOR_FOREIGN_ONLY])).toEqual(['Only Klingon']);
	});
});
