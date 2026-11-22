/**
 * The `properties.label` OBJECT override on the structure context (T2-SC-2, O08).
 *
 * THE CONTRACT (PHP build_structure_context :1928-1941, v6 identical): an
 * element whose properties carry `label` as a LANG MAP shows that label instead
 * of its ontology term; a STRING `label` never overrides (PHP reads it only as
 * an object). TS resolves the map through the engine's ONE ontology label chain
 * (ontology/labels.ts resolveLabel: requested lang → its declared equivalent →
 * the structure lang → the first non-empty) instead of PHP's "requested lang,
 * else the first entry in stored order" — the deliberate difference is
 * WC-2026-11-22-properties-label-override-chain, pinned by the alias leg below.
 * Stamped in the post-emission block, so an RQO properties override carrying a
 * label wins as PHP's set_properties did.
 *
 * SITUATION (tld `zzslo`, dropped in afterAll with residue asserted):
 *  zzslo1 REAL section (relations → test24)
 *    zzslo2 component_input_text  label {lg-spa, lg-eng}
 *    zzslo3 component_input_text  label "a string" (never overrides)
 *    zzslo4 component_input_text  label {lg-ara, lg-cat} (the alias/order leg)
 *    zzslo5 component_input_text  label {lg-deu: ''} (nothing usable)
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { ONTOLOGY_LABEL_FALLBACK_LANG } from '../../src/core/ontology/labels.ts';
import { translationLangOf } from '../../src/core/resolve/lang_alias.ts';
import { runWithRequestLangs } from '../../src/core/resolve/request_lang.ts';
import { buildStructureContext } from '../../src/core/resolve/structure_context.ts';
import {
	dropSituation,
	ensureSituation,
	situation,
} from '../../src/core/test_data/situations/situation.ts';
import { assertTestDatabase } from '../../src/core/test_data/test_database_marker.ts';

const SECTION = 'zzslo1';

const S = situation({
	name: 'properties.label override',
	tld: 'zzslo',
	nodes: [
		{
			tipo: SECTION,
			parent: 'test1',
			model: 'section',
			order_number: 97,
			term: { 'lg-eng': 'label override section' },
			relations: [{ tipo: 'test24' }],
		},
		{
			tipo: 'zzslo2',
			parent: SECTION,
			model: 'component_input_text',
			order_number: 1,
			term: { 'lg-eng': 'Ontology term two' },
			properties: { label: { 'lg-spa': 'Etiqueta propia', 'lg-eng': 'Own label' } },
		},
		{
			tipo: 'zzslo3',
			parent: SECTION,
			model: 'component_input_text',
			order_number: 2,
			term: { 'lg-eng': 'Ontology term three' },
			properties: { label: 'a string label' },
		},
		{
			tipo: 'zzslo4',
			parent: SECTION,
			model: 'component_input_text',
			order_number: 3,
			term: { 'lg-eng': 'Ontology term four' },
			properties: { label: { 'lg-ara': 'تسمية', 'lg-cat': 'Etiqueta catalana' } },
		},
		{
			tipo: 'zzslo5',
			parent: SECTION,
			model: 'component_input_text',
			order_number: 4,
			term: { 'lg-eng': 'Ontology term five' },
			properties: { label: { 'lg-deu': '' } },
		},
	],
});

beforeAll(async () => {
	await assertTestDatabase('structure_context_label_override_native');
	await ensureSituation(S);
}, 60_000);

afterAll(async () => {
	expect(await dropSituation(S)).toBe(0);
});

async function labelIn(
	tipo: string,
	lang: string,
	propertiesOverride?: Record<string, unknown>,
): Promise<unknown> {
	const entry = await runWithRequestLangs({ applicationLang: lang, dataLang: lang }, () =>
		buildStructureContext({
			configFrom: { source: 'own', reason: 'unit-test' },
			tipo,
			sectionTipo: SECTION,
			mode: 'edit',
			lang: 'lg-nolan',
			permissions: 2,
			...(propertiesOverride !== undefined ? { propertiesOverride } : {}),
		}),
	);
	return entry?.label;
}

describe('properties.label OBJECT override (T2-SC-2)', () => {
	test('a lang map replaces the ontology term, in the request application lang', async () => {
		expect(await labelIn('zzslo2', 'lg-eng')).toBe('Own label');
		expect(await labelIn('zzslo2', 'lg-spa')).toBe('Etiqueta propia');
	});

	test('a STRING label never overrides (PHP reads only an object)', async () => {
		expect(await labelIn('zzslo3', 'lg-eng')).toBe('Ontology term three');
	});

	test('the ONE label chain decides a missing lang — the declared alias, not the first stored entry', async () => {
		// lg-ara sorts FIRST in storage: PHP's fallback would show it to a
		// Valencian interface. The chain reads Valencian's declared source, Catalan.
		expect(translationLangOf('lg-vlca')).toBe('lg-cat');
		expect(await labelIn('zzslo4', 'lg-vlca')).toBe('Etiqueta catalana');
		// a lang with no alias falls to the structure lang, else the first non-empty
		const fallback = ONTOLOGY_LABEL_FALLBACK_LANG === 'lg-cat' ? 'Etiqueta catalana' : 'تسمية';
		expect(await labelIn('zzslo4', 'lg-eng')).toBe(fallback);
	});

	test('a map with no usable value leaves the ontology label', async () => {
		expect(await labelIn('zzslo5', 'lg-eng')).toBe('Ontology term five');
	});

	test('an RQO properties OVERRIDE carrying a label map wins; one carrying a string does not', async () => {
		expect(await labelIn('zzslo3', 'lg-eng', { label: { 'lg-eng': 'From the override' } })).toBe(
			'From the override',
		);
		expect(await labelIn('zzslo2', 'lg-eng', { label: 'string override' })).toBe(
			'Ontology term two',
		);
	});
});
