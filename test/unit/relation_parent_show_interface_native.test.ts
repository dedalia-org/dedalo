/**
 * "No add button" context law (T1-29 / O05 — PHP-parity restoration).
 *
 * The PHP json controllers of EXACTLY two models stamp
 * `properties.show_interface.button_add = false` on the element context AFTER
 * the structure context is built (component_relation_related_json.php:77,
 * component_relation_parent_json.php:77): a parent link is attached from the
 * children side / the tree, never by creating a new record from the parent
 * field, and related links are picked, never created inline. The client
 * (component_relation_parent = component_portal alias) otherwise defaults
 * button_add to true and renders a "+" that creates a new record in the
 * target section and links it as parent.
 *
 * The engine reads the law from the descriptor facet `forbidsAddButton`
 * (components/registry.ts getForbidsAddButton) — the set itself is pinned
 * against the PHP oracle in descriptor_completeness_tripwire.
 *
 * Scratch-TLD fixtures (zzrpshow*), purged before and after.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { deleteTldNodes, upsertDdOntologyNode } from '../../src/core/db/dd_ontology.ts';
import { getNode } from '../../src/core/ontology/resolver.ts';
import { buildStructureContext } from '../../src/core/resolve/structure_context.ts';

const TLD = 'zzrpshow';
const SECTION = `${TLD}1`;
const PARENT_PLAIN = `${TLD}2`; // relation_parent, no ontology show_interface (an explicit RQO is mandatory for the model)
const PARENT_OPEN = `${TLD}3`; // relation_parent whose ontology asks for button_add:true
const RELATED_PLAIN = `${TLD}4`; // relation_related, no ontology show_interface
const PORTAL_OPEN = `${TLD}5`; // component_portal control (ontology button_add:true)

const SELF_REQUEST_CONFIG = {
	source: {
		request_config: [
			{
				api_engine: 'dedalo',
				type: 'main',
				sqo: { section_tipo: [{ source: 'section', value: [SECTION] }] },
				show: { ddo_map: [] },
			},
		],
	},
};

beforeAll(async () => {
	await deleteTldNodes(TLD);
	await upsertDdOntologyNode({
		tipo: SECTION,
		model: 'section',
		tld: TLD,
		term: { 'lg-eng': 'Show-interface scratch section' },
		properties: {},
	});
	await upsertDdOntologyNode({
		tipo: PARENT_PLAIN,
		model: 'component_relation_parent',
		parent: SECTION,
		tld: TLD,
		is_translatable: false,
		term: { 'lg-eng': 'Parent' },
		properties: { ...SELF_REQUEST_CONFIG },
	});
	await upsertDdOntologyNode({
		tipo: PARENT_OPEN,
		model: 'component_relation_parent',
		parent: SECTION,
		tld: TLD,
		is_translatable: false,
		term: { 'lg-eng': 'Parent (asks for add)' },
		properties: {
			...SELF_REQUEST_CONFIG,
			show_interface: { button_add: true, button_link: true },
		},
	});
	await upsertDdOntologyNode({
		tipo: RELATED_PLAIN,
		model: 'component_relation_related',
		parent: SECTION,
		tld: TLD,
		is_translatable: false,
		term: { 'lg-eng': 'Related' },
		properties: {},
	});
	await upsertDdOntologyNode({
		tipo: PORTAL_OPEN,
		model: 'component_portal',
		parent: SECTION,
		tld: TLD,
		is_translatable: false,
		term: { 'lg-eng': 'Portal control' },
		properties: { ...SELF_REQUEST_CONFIG, show_interface: { button_add: true } },
	});
});
afterAll(async () => {
	await deleteTldNodes(TLD); // fires the hub — no scratch cache state left
});

const build = (
	tipo: string,
	extra: { addRequestConfig?: boolean; propertiesOverride?: Record<string, unknown> } = {},
) =>
	buildStructureContext({
		configFrom: { source: 'own', reason: 'unit-test' },
		tipo,
		sectionTipo: SECTION,
		mode: 'edit',
		lang: 'lg-eng',
		permissions: 3,
		...extra,
	});

const showInterfaceOf = (entry: unknown): Record<string, unknown> | undefined =>
	(entry as { properties?: { show_interface?: Record<string, unknown> } } | null)?.properties
		?.show_interface;

describe('component_relation_parent: button_add is always false (PHP json controller)', () => {
	test('no ontology show_interface → created with button_add:false', async () => {
		const entry = await build(PARENT_PLAIN);
		expect(entry?.model).toBe('component_relation_parent');
		expect(showInterfaceOf(entry)?.button_add).toBe(false);
	});

	test('ontology button_add:true is overruled; sibling keys survive (merge, not replace)', async () => {
		const showInterface = showInterfaceOf(await build(PARENT_OPEN));
		expect(showInterface?.button_add).toBe(false);
		expect(showInterface?.button_link).toBe(true);
	});

	test('an RQO propertiesOverride cannot re-open it', async () => {
		// the override REPLACES the node's properties (PHP set_properties), so it
		// carries the model's mandatory explicit RQO itself
		const entry = await build(PARENT_PLAIN, {
			propertiesOverride: { ...SELF_REQUEST_CONFIG, show_interface: { button_add: true } },
		});
		expect(showInterfaceOf(entry)?.button_add).toBe(false);
	});

	test('the simple context (addRequestConfig:false) carries it too', async () => {
		const entry = await build(PARENT_OPEN, { addRequestConfig: false });
		expect(showInterfaceOf(entry)?.button_add).toBe(false);
	});
});

describe('component_relation_related: unchanged (now read from the same facet)', () => {
	test('no ontology show_interface → button_add:false', async () => {
		expect(showInterfaceOf(await build(RELATED_PLAIN))?.button_add).toBe(false);
	});

	test('an RQO propertiesOverride cannot re-open it', async () => {
		const entry = await build(RELATED_PLAIN, {
			propertiesOverride: { show_interface: { button_add: true } },
		});
		expect(showInterfaceOf(entry)?.button_add).toBe(false);
	});
});

describe('controls', () => {
	test('component_portal keeps its ontology button_add (no forced key)', async () => {
		expect(showInterfaceOf(await build(PORTAL_OPEN))?.button_add).toBe(true);
	});

	test('the stamp never pollutes the cached ontology node', async () => {
		await build(PARENT_PLAIN);
		const node = await getNode(PARENT_PLAIN);
		expect(node).not.toBeNull();
		const properties = (node?.properties ?? {}) as Record<string, unknown>;
		expect(properties.show_interface).toBeUndefined();
		const open = await getNode(PARENT_OPEN);
		const openShow = (open?.properties as { show_interface?: Record<string, unknown> } | null)
			?.show_interface;
		expect(openShow?.button_add).toBe(true);
	});
});
