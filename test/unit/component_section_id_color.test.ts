/**
 * component_section_id context.color gate (TS-native; PHP-parity restoration).
 *
 * The client (view_default_edit_section_id.js, byte-identical to the frozen PHP
 * client) paints `context.color` as the wrapper background on BOTH the idle and
 * `.active` states, so the section-coloured Id badge never changes on click.
 * PHP appends it only in the FULL json-controller context
 * (component_section_id_json.php default branch → ontology_node::get_color →
 * the SECTION node's properties.color, fallback '#b9b9b9'); the 'simple'
 * context (get_structure_context_simple, addRequestConfig:false) omits it.
 *
 * Scratch-TLD fixtures (zzcolor*), purged before and after (hub-fire pattern,
 * same as component_alias.test.ts). No PHP oracle by design.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { deleteTldNodes, upsertDdOntologyNode } from '../../src/core/db/dd_ontology.ts';
import { buildStructureContext } from '../../src/core/resolve/structure_context.ts';

const TLD = 'zzcolor';
const SECTION_COLOURED = `${TLD}1`; // section with properties.color
const ID_OF_COLOURED = `${TLD}2`; // its component_section_id child
const SECTION_PLAIN = `${TLD}3`; // section with NO color property
const ID_OF_PLAIN = `${TLD}4`; // its component_section_id child

const SECTION_COLOR = '#a93f25';
const DEFAULT_COLOR = '#b9b9b9'; // PHP ontology_node::get_color fallback

beforeAll(async () => {
	await deleteTldNodes(TLD);
	await upsertDdOntologyNode({
		tipo: SECTION_COLOURED,
		model: 'section',
		tld: TLD,
		term: { 'lg-eng': 'Coloured section' },
		properties: { color: SECTION_COLOR },
	});
	await upsertDdOntologyNode({
		tipo: ID_OF_COLOURED,
		model: 'component_section_id',
		parent: SECTION_COLOURED,
		tld: TLD,
		is_translatable: false,
		term: { 'lg-eng': 'Id' },
	});
	await upsertDdOntologyNode({
		tipo: SECTION_PLAIN,
		model: 'section',
		tld: TLD,
		term: { 'lg-eng': 'Plain section' },
		properties: {},
	});
	await upsertDdOntologyNode({
		tipo: ID_OF_PLAIN,
		model: 'component_section_id',
		parent: SECTION_PLAIN,
		tld: TLD,
		is_translatable: false,
		term: { 'lg-eng': 'Id' },
	});
});
afterAll(async () => {
	await deleteTldNodes(TLD); // fires the hub — no scratch cache state left
});

const build = (tipo: string, sectionTipo: string, addRequestConfig?: boolean) =>
	buildStructureContext({
		configFrom: { source: 'own', reason: 'unit-test' },
		tipo,
		sectionTipo,
		mode: 'edit',
		lang: 'lg-eng',
		permissions: 3,
		...(addRequestConfig === undefined ? {} : { addRequestConfig }),
	});

describe('component_section_id context.color (full context)', () => {
	test('carries the parent SECTION node properties.color', async () => {
		const entry = await build(ID_OF_COLOURED, SECTION_COLOURED);
		expect(entry).not.toBeNull();
		expect(entry?.model).toBe('component_section_id');
		expect(entry?.color).toBe(SECTION_COLOR);
	});

	test("falls back to '#b9b9b9' when the section has no color property", async () => {
		const entry = await build(ID_OF_PLAIN, SECTION_PLAIN);
		expect(entry?.color).toBe(DEFAULT_COLOR);
	});
});

describe('component_section_id context.color (simple context omits it, PHP parity)', () => {
	test('addRequestConfig:false emits NO color (get_structure_context_simple)', async () => {
		const entry = await build(ID_OF_COLOURED, SECTION_COLOURED, false);
		expect(entry).not.toBeNull();
		expect(entry?.color).toBeUndefined();
	});
});
