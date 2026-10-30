/**
 * A PORTAL INTO A THESAURUS SHOWS ITS TERM IN THE DATA LANG, THEN THE
 * THESAURUS'S OWN MAIN LANG — resolveLocatorLabels (relations/datalist.ts).
 *
 * THE RULE. A portal whose configured label IS the target thesaurus's term
 * component reads the term through the term resolver: the data lang first,
 * then the thesaurus main lang, never the install default or the first lang
 * found. Toponymy therefore stays untranslated, and a term that has no value in
 * either lang shows nothing rather than a foreign translation.
 *
 * FIXTURE. The canonical test3 playground (test/preload/canonical_test3.ts) is
 * the thesaurus: test3's section map names `test52` as its term, and test3 is
 * the `test` TLD's own thesaurus, so no ontology is written here.
 *   test3/1  → term in lg-eng only   ('input text content of one')
 *   test3/27 → term in lg-spa only   ('El dos')
 */

import { describe, expect, test } from 'bun:test';
import { resolveLocatorLabels } from '../../src/core/relations/datalist.ts';

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

	test('neither the data lang nor the main lang has the term: nothing, never a foreign translation', async () => {
		// test3/27 is Spanish-only; an lg-eng read is main-lang English, so empty.
		// The component chain would have returned 'El dos' here, which is the
		// behaviour this change removes for thesaurus targets.
		// The English locator in the same read is the positive control: it proves
		// the lookup actually ran, so the empty verdict below is not a blind census.
		expect(await labelsOf('lg-eng', [LOCATOR_ENGLISH_ONLY, LOCATOR_SPANISH_ONLY])).toEqual([
			'input text content of one',
		]);
		expect(await labelsOf('lg-eng', [LOCATOR_SPANISH_ONLY])).toEqual([]);
	});
});
