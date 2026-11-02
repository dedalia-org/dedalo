/**
 * TRANSLITERABLE components in publication — the v6 "row lang, else the
 * lg-nolan BASE" rule (feature: ontology `properties.with_lang_versions`;
 * every component_iri). A transliterable stores an lg-nolan base plus optional
 * per-language versions (Augustus lg-nolan, Αύγουστος lg-ell). v6 publishes,
 * per output row, the version in that row's lang when one exists and the base
 * otherwise (v6 class.diffusion_sql.php:1727, component_input_text /
 * component_iri get_diffusion_value, get_value_with_fallback_from_dato_full).
 *
 * Gated on the three publication paths a transliterable value can take:
 *
 *   1. component_input_text, direct read: one atom per stored item, keyed by
 *      lang, through the projection ladder (exact → nolan) — already correct,
 *      pinned here so it cannot drift;
 *   2. component_iri, direct read + parser_iri::flat and the raw `dato`
 *      (no-parser json) path: the atoms are split PER LANG and the parser
 *      formats each lang on its own (before: every slice merged into one
 *      lang-neutral value, so each row published base + versions together);
 *   3. thesaurus TERM path (parents rewriter → nodeTermForLang): exact → main
 *      lang → lg-nolan → project langs (before: no nolan rung, so a row with no
 *      version got the first VERSION in project order).
 *
 * Pure: the record IR is fabricated in full (no DB read), generic test TLD.
 */

import { describe, expect, test } from 'bun:test';
import type { MatrixRecord } from '../../src/core/db/matrix.ts';
import type { ParserContext } from '../../src/diffusion/parsers/types.ts';
import { resolveColumnForLang } from '../../src/diffusion/project/lang_ladder.ts';
import { defaultPublicationValue } from '../../src/diffusion/resolve/default_value.ts';
import { nodeTermForLang } from '../../src/diffusion/resolve/rewriters.ts';
import type { FieldTransformSpec } from '../../src/diffusion/resolve/transform.ts';
import { fieldValuesToColumn } from '../../src/diffusion/resolve/transform.ts';

/** The test3 transliterable input text (with_lang_versions) and its IRI twin. */
const INPUT_TIPO = 'test166';
const IRI_TIPO = 'test140';
const NOLAN = 'lg-nolan';
const ELL = 'lg-ell';
const SPA = 'lg-spa';
const ENG = 'lg-eng';

const CTX: ParserContext = { langs: [SPA, ENG, ELL], mainLang: SPA };

function record(columns: MatrixRecord['columns']): MatrixRecord {
	return { id: 1, section_id: 1, section_tipo: 'test3', columns, rawText: {} };
}

/** Every output row of one column, the way projection expands it. */
function rows(
	atoms: ReturnType<typeof defaultPublicationValue>,
	spec: FieldTransformSpec,
): Record<string, string | null> {
	const column = fieldValuesToColumn(atoms, spec, CTX);
	return Object.fromEntries(
		CTX.langs.map((lang) => [lang, resolveColumnForLang(column, lang, CTX.mainLang)]),
	);
}

describe('component_input_text with_lang_versions: row lang version, else the base', () => {
	const rec = record({
		string: {
			[INPUT_TIPO]: [
				{ id: 1, lang: NOLAN, value: 'Augustus' },
				{ id: 1, lang: ELL, value: 'Αύγουστος' },
			],
		},
	});

	test('one atom per stored item, lg-nolan → lang-neutral, the version keeps its lang', () => {
		const atoms = defaultPublicationValue(rec, INPUT_TIPO, 'component_input_text', {
			tipo: INPUT_TIPO,
		});
		expect(atoms.length).toBe(2);
		expect(atoms.map((atom) => atom.lang)).toEqual([null, ELL]);
	});

	test('the Greek row gets the version; every other row the lg-nolan base', () => {
		const atoms = defaultPublicationValue(rec, INPUT_TIPO, 'component_input_text', {
			tipo: INPUT_TIPO,
		});
		expect(rows(atoms, { transform: [] })).toEqual({
			[SPA]: 'Augustus',
			[ENG]: 'Augustus',
			[ELL]: 'Αύγουστος',
		});
	});
});

describe('component_iri: one atom PER LANG, formatted per lang', () => {
	const base = { id: 1, lang: NOLAN, iri: 'https://example.org/augustus', title: 'Augustus' };
	const greek = { id: 1, lang: ELL, iri: 'https://example.org/el/augustus', title: 'Αύγουστος' };
	const IRI_FLAT: FieldTransformSpec = {
		transform: [{ fn: 'parser_iri::flat', options: {} }],
	};

	test('base + version → two atoms, lang stripped from the entries', () => {
		const atoms = defaultPublicationValue(
			record({ iri: { [IRI_TIPO]: [base, greek] } }),
			IRI_TIPO,
			'component_iri',
			{
				tipo: IRI_TIPO,
			},
		);
		expect(atoms.length).toBe(2);
		expect(atoms.map((atom) => atom.lang)).toEqual([null, ELL]);
		const values = atoms.map((atom) => (atom as { value: unknown }).value);
		expect(values).toEqual([
			[{ id: 1, iri: base.iri, title: base.title }],
			[{ id: 1, iri: greek.iri, title: greek.title }],
		]);
	});

	test('base only → the single lang-neutral atom it always was (byte-identical)', () => {
		const second = { id: 2, lang: NOLAN, iri: 'https://example.org/b', title: 'B' };
		const atoms = defaultPublicationValue(
			record({ iri: { [IRI_TIPO]: [base, second] } }),
			IRI_TIPO,
			'component_iri',
			{
				tipo: IRI_TIPO,
			},
		);
		expect(atoms.length).toBe(1);
		expect(atoms[0]?.lang).toBe(null);
		expect((atoms[0] as { value: unknown }).value).toEqual([
			{ id: 1, iri: base.iri, title: base.title },
			{ id: 2, iri: second.iri, title: second.title },
		]);
	});

	test('parser_iri::flat: the Greek row publishes the version alone, the others the base alone', () => {
		const atoms = defaultPublicationValue(
			record({ iri: { [IRI_TIPO]: [base, greek] } }),
			IRI_TIPO,
			'component_iri',
			{
				tipo: IRI_TIPO,
			},
		);
		expect(rows(atoms, IRI_FLAT)).toEqual({
			[SPA]: `Augustus, ${base.iri}`,
			[ENG]: `Augustus, ${base.iri}`,
			[ELL]: `Αύγουστος, ${greek.iri}`,
		});
	});

	test('raw json (no parser): each row carries only its own slice', () => {
		const atoms = defaultPublicationValue(
			record({ iri: { [IRI_TIPO]: [base, greek] } }),
			IRI_TIPO,
			'component_iri',
			{
				tipo: IRI_TIPO,
			},
		);
		const out = rows(atoms, { transform: [], outputFormat: 'json' });
		expect(JSON.parse(String(out[SPA]))).toEqual([{ id: 1, iri: base.iri, title: base.title }]);
		expect(JSON.parse(String(out[ELL]))).toEqual([{ id: 1, iri: greek.iri, title: greek.title }]);
	});

	// v6 parity, not a divergence: component_iri::get_diffusion_value returns
	// null (row lang and lg-nolan both empty), and its caller — the v6
	// diffusion_sql::build_data_field default branch (class.diffusion_sql.php
	// :1803-1825) — falls back to the main lang, then to any lang. So v6 too
	// publishes the only version in every row.
	test('a version-only record still publishes in every row (ladder rung: any)', () => {
		const atoms = defaultPublicationValue(
			record({ iri: { [IRI_TIPO]: [greek] } }),
			IRI_TIPO,
			'component_iri',
			{
				tipo: IRI_TIPO,
			},
		);
		const out = rows(atoms, IRI_FLAT);
		expect(Object.values(out).length).toBe(3);
		for (const value of Object.values(out)) expect(value).toBe(`Αύγουστος, ${greek.iri}`);
	});
});

describe('term path (nodeTermForLang): exact → main → lg-nolan → project langs', () => {
	const link = (term: Record<string, string | null>) => ({
		sectionTipo: 'test3',
		sectionId: 1,
		term,
	});

	test('transliterable term: the version in its own row, the base elsewhere', () => {
		const node = link({ [NOLAN]: 'Augustus', [ELL]: 'Αύγουστος' });
		// main lang (lg-spa) has no version → the base, NOT the first project-lang version.
		expect(nodeTermForLang(node, SPA, SPA, CTX.langs)).toBe('Augustus');
		expect(nodeTermForLang(node, ENG, SPA, CTX.langs)).toBe('Augustus');
		expect(nodeTermForLang(node, ELL, SPA, CTX.langs)).toBe('Αύγουστος');
	});

	test('main lang still outranks the base (v6 order)', () => {
		const node = link({ [NOLAN]: 'Augustus', [SPA]: 'Augusto' });
		expect(nodeTermForLang(node, ENG, SPA, CTX.langs)).toBe('Augusto');
	});

	test('translatable term (no lg-nolan key): project-lang walk unchanged', () => {
		const node = link({ 'lg-ara': 'وھران', 'lg-fra': 'Oran' });
		expect(nodeTermForLang(node, SPA, SPA, ['lg-spa', 'lg-fra', 'lg-ara'])).toBe('Oran');
	});

	test('empty base never wins over a value', () => {
		const node = link({ [NOLAN]: '', [ELL]: 'Αύγουστος' });
		expect(nodeTermForLang(node, SPA, SPA, CTX.langs)).toBe('Αύγουστος');
	});
});
