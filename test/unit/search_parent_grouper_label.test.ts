/**
 * Search-mode context.config.parent_grouper_label gate (TS-native; PHP-parity
 * restoration).
 *
 * The search panel labels each field with its parent grouper — "Id
 * [Identification]" — so a user can tell apart the several "Id" / "Name"
 * fields a section carries under different groupers. The client
 * (ui.js label_info) reads `context.config.parent_grouper_label`; PHP
 * class.common.php:1700-1707 stamps it in SEARCH mode only, from the
 * parent_grouper's term (frozen fixture component_publication_search_differential:
 * `config: { parent_grouper_label: "Identificación" }`). The TS engine had
 * dropped it, so the suffix never rendered.
 *
 * Scratch-TLD fixtures (zzgrplbl*), purged before and after. No PHP oracle by
 * design.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { deleteTldNodes, upsertDdOntologyNode } from '../../src/core/db/dd_ontology.ts';
import { buildStructureContext } from '../../src/core/resolve/structure_context.ts';

const TLD = 'zzgrplbl';
const SECTION = `${TLD}1`;
const GROUPER = `${TLD}2`; // section_group "Identification"
const FIELD = `${TLD}3`; // component_input_text under the grouper

const GROUPER_TERM = 'Identification';

beforeAll(async () => {
	await deleteTldNodes(TLD);
	await upsertDdOntologyNode({
		tipo: SECTION,
		model: 'section',
		tld: TLD,
		term: { 'lg-eng': 'Grouper label section', 'lg-spa': 'Grouper label section' },
		properties: {},
	});
	await upsertDdOntologyNode({
		tipo: GROUPER,
		model: 'section_group',
		parent: SECTION,
		tld: TLD,
		term: { 'lg-eng': GROUPER_TERM, 'lg-spa': GROUPER_TERM },
	});
	await upsertDdOntologyNode({
		tipo: FIELD,
		model: 'component_input_text',
		parent: GROUPER,
		tld: TLD,
		is_translatable: false,
		term: { 'lg-eng': 'Id', 'lg-spa': 'Id' },
	});
});
afterAll(async () => {
	await deleteTldNodes(TLD); // fires the hub — no scratch cache state left
});

const build = (mode: string) =>
	buildStructureContext({
		configFrom: { source: 'own', reason: 'unit-test' },
		tipo: FIELD,
		sectionTipo: SECTION,
		mode,
		lang: 'lg-eng',
		permissions: 3,
	});

describe('context.config.parent_grouper_label', () => {
	test('search mode carries the parent grouper term', async () => {
		const entry = await build('search');
		expect(entry).not.toBeNull();
		expect(entry?.parent_grouper).toBe(GROUPER);
		expect(entry?.config?.parent_grouper_label).toBe(GROUPER_TERM);
	});

	test('edit mode does not (PHP stamps it in search only)', async () => {
		const entry = await build('edit');
		expect(entry).not.toBeNull();
		expect(entry?.config?.parent_grouper_label).toBeUndefined();
	});
});
