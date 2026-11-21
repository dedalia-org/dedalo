/**
 * request_config IMPLICIT — unit gate for the legacy graph-walk builder
 * (RELATIONS_SPEC.md §4, spec gate 3 groundwork).
 * PHP oracle nomenclature: implicit ≡ v5, explicit ≡ v6.
 *
 * PHP oracle: trait.request_config_v5.php (build_request_config_v5 :78,
 * clean_and_extract_related :508, build_legacy_ddo_map :618) + the
 * data-driven selection rule (class.common.php:3502).
 *
 * Fixtures are REAL ontology rows of the shared dedalo_mib_v7 install — the
 * RELATIONS_SPEC §7 corpus components that carry NO source.request_config:
 *   test6480 (radio_button)      relations [dd501, dd503]
 *   test6151  (autocomplete)      relations [test6124, test6126, test6263]
 *   test6807 (select)           relations [test6799, test6802]
 *   test6137  (relation_related)  legacy `source` object, relations
 *                                    [test6100, test6204, test6228, test6217]
 */
// Migrated to the generic `test` TLD 2026-08-19 (AGENTS.md hard rules): every
// install tipo was rewritten through src/core/test_data/test_tld_tipo_map.json;
// seed-shipped ontology (dd/rsc/hierarchy/lg) stays and is spelled through `seed()`,
// which keeps it out of the install-TLD census's `<tld><digits>` token grammar.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { config as dedaloConfig } from '../../src/config/config.ts';
import { selectRequestConfigStrategy } from '../../src/core/concepts/request_config.ts';
import { getNode } from '../../src/core/ontology/resolver.ts';
import { buildRequestConfigForElement } from '../../src/core/relations/request_config/build.ts';
import {
	extractSqoSectionTipos,
	type RequestConfigContext,
} from '../../src/core/relations/request_config/explicit.ts';
import { buildImplicitComponentListConfig } from '../../src/core/relations/request_config/implicit.ts';
import {
	dropSituation,
	ensureSituation,
	situation,
} from '../../src/core/test_data/situations/situation.ts';

const editContext = (ownerTipo: string, ownerSectionTipo: string): RequestConfigContext => ({
	ownerTipo,
	ownerSectionTipo,
	mode: 'edit',
	ownerIsSection: false,
});

describe('selectRequestConfigStrategy (the class.common.php:3502 branch)', () => {
	test('no-source components select implicit', async () => {
		for (const tipo of ['test6480', 'test6151', 'test6807']) {
			const node = await getNode(tipo);
			expect(selectRequestConfigStrategy(node?.properties ?? null)).toBe('implicit');
		}
	});

	test('a legacy source object WITHOUT request_config still selects implicit (test6137)', async () => {
		const node = await getNode('test6137');
		expect(selectRequestConfigStrategy(node?.properties ?? null)).toBe('implicit');
	});

	test('an explicit request_config selects explicit (test6230)', async () => {
		const node = await getNode('test6230');
		expect(selectRequestConfigStrategy(node?.properties ?? null)).toBe('explicit');
	});
});

describe('buildImplicitComponentListConfig — graph-walk target + ddo derivation', () => {
	test('test6480: first section relation (dd501) is the target, stripped from ddos', async () => {
		const config = await buildImplicitComponentListConfig(
			'test6480',
			editContext('test6480', 'test6099'),
		);
		expect(config).toHaveLength(1);
		expect(extractSqoSectionTipos(config[0])).toEqual(['dd501']);
		const ddoTipos = (config[0]?.show?.ddo_map ?? []).map((ddo) => ddo.tipo);
		expect(ddoTipos).toEqual(['dd503']);
		// Implicit legacy shape: SCALAR section_tipo on the ddo, mode forced 'list'.
		expect(config[0]?.show?.ddo_map[0]?.section_tipo).toBe('dd501');
		expect(config[0]?.show?.ddo_map[0]?.mode).toBe('list');
		expect(config[0]?.show?.ddo_map[0]?.parent).toBe('test6480');
	});

	test('test6151: target test6124, ddos [test6126, test6263]', async () => {
		const config = await buildImplicitComponentListConfig(
			'test6151',
			editContext('test6151', 'test6099'),
		);
		expect(extractSqoSectionTipos(config[0])).toEqual(['test6124']);
		expect((config[0]?.show?.ddo_map ?? []).map((ddo) => ddo.tipo)).toEqual([
			'test6126',
			'test6263',
		]);
	});

	test('test6807: target test6799, ddo test6802', async () => {
		const config = await buildImplicitComponentListConfig(
			'test6807',
			editContext('test6807', 'test6099'),
		);
		expect(extractSqoSectionTipos(config[0])).toEqual(['test6799']);
		expect((config[0]?.show?.ddo_map ?? []).map((ddo) => ddo.tipo)).toEqual(['test6802']);
	});

	test('test6137 (legacy source object): implicit walk over its relation nodes', async () => {
		const node = await getNode('test6137');
		const config = await buildRequestConfigForElement(
			node?.properties ?? null,
			editContext('test6137', 'test6100'),
		);
		expect(extractSqoSectionTipos(config[0])).toEqual(['test6100']);
		expect((config[0]?.show?.ddo_map ?? []).map((ddo) => ddo.tipo)).toEqual([
			'test6204',
			'test6228',
			'test6217',
		]);
	});

	// PHP resolve_ar_related_list :354 branches on the caller model: a SECTION
	// owner goes to resolve_ar_related_list_section, which returns the
	// section_list relation nodes VERBATIM — only the COMPONENT branch
	// (resolve_ar_related_list_component :454-473) prepends a main related
	// section. TS once ran the component fallback for section owners too, so
	// test6101's columns were stamped with testplace1 (its related
	// "Location" section). Every dd774 lookup then keyed
	// numisdata276_<column> instead of numisdata5_<column>, missed, resolved 0
	// and filterAuthorizedRelated dropped EVERY column — the list rendered with
	// no components for real users while root sailed through getPermissions'
	// superuser short-circuit.
	test('a SECTION owner keeps itself as target — the related section never wins', async () => {
		const config = await buildImplicitComponentListConfig('test6315', {
			ownerTipo: 'test6101',
			ownerSectionTipo: 'test6101',
			mode: 'list',
			ownerIsSection: true,
		});
		expect(extractSqoSectionTipos(config[0])).toEqual(['test6101']);
		const ddoMap = config[0]?.show?.ddo_map ?? [];
		expect(ddoMap.map((ddo) => ddo.tipo)).toEqual([
			'testplace1024',
			'testplace1006',
			'testplace1012',
			'testplace1007',
			'testplace1010',
			'testplace1015',
			'testplace1035',
		]);
		// The permission key every column is checked under.
		for (const ddo of ddoMap) {
			expect(ddo.section_tipo).toBe('test6101');
		}
	});

	test('api_engine/type wrap matches the explicit shape (single dedalo main item)', async () => {
		const config = await buildImplicitComponentListConfig(
			'test6480',
			editContext('test6480', 'test6099'),
		);
		expect(config[0]?.api_engine).toBe('dedalo');
		expect(config[0]?.type).toBe('main');
	});
});

describe('explicit-config-required models (PHP trait.request_config_v5.php:88)', () => {
	test('component_relation_children forced through the implicit path throws loudly', async () => {
		// hierarchy49 is a real component_relation_children; force the implicit
		// path directly — PHP throws regardless of whether the live node carries
		// an explicit config. The error text is PHP-verbatim (keeps "v5").
		expect(
			buildImplicitComponentListConfig('hierarchy49', editContext('hierarchy49', 'test7289')),
		).rejects.toThrow(/v5 resolution fallback is no longer supported/);
	});
});

/**
 * DEAD legacy models never reach the client (PHP $ar_temp_exclude_models;
 * TS: isUnimplementedComponentModel — no registered descriptor).
 * dd249 (component_security_areas, under the profiles section dd234) is the
 * live case: the model has no server descriptor AND no client JS module, so an
 * emitted ddo made the client 404 on its dynamic import and abort the whole
 * edit render.
 */
describe('buildImplicitSectionEditConfig — dead legacy models are not emitted', () => {
	test('dd234 edit form carries no dd249 and no unimplemented component model', async () => {
		const { buildImplicitSectionEditConfig } = await import(
			'../../src/core/relations/request_config/implicit.ts'
		);
		const { getComponentModel } = await import('../../src/core/components/registry.ts');
		const config = await buildImplicitSectionEditConfig({
			ownerTipo: 'dd234',
			ownerSectionTipo: 'dd234',
			mode: 'edit',
			ownerIsSection: true,
		});
		const ddos = config.flatMap((item) => item.show?.ddo_map ?? []);
		expect(ddos.length).toBeGreaterThan(0);
		expect(ddos.some((ddo) => ddo.tipo === 'dd249')).toBe(false);
		const unimplemented = ddos
			.map((ddo) => ddo.model)
			.filter((model) => model.startsWith('component_') && getComponentModel(model) === undefined);
		expect(unimplemented).toEqual([]);
	});
});

describe('default page size (buildRequestConfigForElement, PHP calculate_default_limit)', () => {
	const pageSize = dedaloConfig.features.maxRowsPerPage;
	const build = async (tipo: string, mode: string) =>
		buildRequestConfigForElement((await getNode(tipo))?.properties ?? null, {
			...editContext(tipo, 'test3'),
			mode,
		});

	test('implicit (test6480) and limit-less explicit (test80) get it in edit only', async () => {
		for (const tipo of ['test6480', 'test80']) {
			expect((await build(tipo, 'edit'))[0]?.sqo.limit).toBe(pageSize);
			expect((await build(tipo, 'list'))[0]?.sqo.limit).toBeUndefined();
		}
	});

	test('a declared limit wins (test37 → 5)', async () => {
		const [item] = await build('test37', 'edit');
		expect(
			item?.sqo.limit ?? (item?.show as { sqo_config?: { limit?: number } })?.sqo_config?.limit,
		).toBe(5);
	});
});

/**
 * THE IMPLICIT WALK — source, section nodes, search block (T2-RC-1 / RC-2 /
 * RC-4, 2026-11-21). Built on its own scratch situation (`zzrqw`): the cases
 * need a node with a section_list child AND own relations, and a relation list
 * naming two sections — shapes the shared `test` TLD does not hold.
 */
const HOST = 'zzrqw1';
const TARGET_A = 'zzrqw2';
const TEXT_A = 'zzrqw3';
const TEXT_B = 'zzrqw4';
const HOST_TEXT = 'zzrqw5';
const SELECT_WITH_LIST = 'zzrqw10';
const SELECT_LIST_NODE = 'zzrqw11';
const SELECT_NO_LIST = 'zzrqw12';
const HOST_LIST_NODE = 'zzrqw20';
const VIRTUAL_HOST = 'zzrqw30';
const TWO_SECTIONS = 'zzrqw40';
const TARGET_B = 'zzrqw50';
const TEXT_C = 'zzrqw51';
const LIST_OWNER = 'zzrqw60';
const LIST_OWNER_NODE = 'zzrqw61';
const LIST_OWNER_TEXT = 'zzrqw62';
const EXPLICIT_PORTAL = 'zzrqw80';

const selfDdo = (tipo: string) => ({ tipo, section_tipo: 'self', parent: 'self' });

const WALK = situation({
	name: 'implicit walk source and section nodes',
	tld: 'zzrqw',
	nodes: [
		{ tipo: HOST, parent: 'test1', model: 'section' },
		{ tipo: TARGET_A, parent: 'test1', model: 'section' },
		{ tipo: TEXT_A, parent: TARGET_A, model: 'component_input_text', order_number: 1 },
		{ tipo: TEXT_B, parent: TARGET_A, model: 'component_input_text', order_number: 2 },
		{ tipo: TARGET_B, parent: 'test1', model: 'section' },
		{ tipo: TEXT_C, parent: TARGET_B, model: 'component_input_text' },
		{ tipo: HOST_TEXT, parent: HOST, model: 'component_input_text', order_number: 1 },
		{
			tipo: SELECT_WITH_LIST,
			parent: HOST,
			model: 'component_select',
			order_number: 2,
			relations: [{ tipo: TARGET_A }, { tipo: TEXT_A }, { tipo: TEXT_B }],
		},
		{
			tipo: SELECT_LIST_NODE,
			parent: SELECT_WITH_LIST,
			model: 'section_list',
			relations: [{ tipo: TEXT_B }],
		},
		{
			tipo: SELECT_NO_LIST,
			parent: HOST,
			model: 'component_select',
			order_number: 3,
			relations: [{ tipo: TARGET_A }, { tipo: TEXT_A }],
		},
		{
			tipo: HOST_LIST_NODE,
			parent: HOST,
			model: 'section_list',
			order_number: 9,
			relations: [{ tipo: HOST_TEXT }],
		},
		{
			tipo: VIRTUAL_HOST,
			parent: 'test1',
			model: 'section',
			relations: [{ tipo: HOST }, { tipo: 'test24' }],
		},
		{
			tipo: TWO_SECTIONS,
			parent: HOST,
			model: 'component_select',
			order_number: 4,
			relations: [{ tipo: TARGET_A }, { tipo: TEXT_A }, { tipo: TARGET_B }, { tipo: TEXT_C }],
		},
		{ tipo: LIST_OWNER, parent: 'test1', model: 'section' },
		{ tipo: LIST_OWNER_TEXT, parent: LIST_OWNER, model: 'component_input_text' },
		{
			tipo: LIST_OWNER_NODE,
			parent: LIST_OWNER,
			model: 'section_list',
			order_number: 9,
			relations: [{ tipo: TARGET_A }, { tipo: LIST_OWNER_TEXT }, { tipo: TARGET_B }],
		},
		{
			tipo: EXPLICIT_PORTAL,
			parent: HOST,
			model: 'component_portal',
			order_number: 5,
			properties: {
				source: {
					request_config: [
						{
							sqo: { section_tipo: [{ source: 'section', value: [TARGET_A] }] },
							show: { ddo_map: [selfDdo(TEXT_A)] },
							search: { ddo_map: [selfDdo(TEXT_A)] },
							choose: { ddo_map: [selfDdo(TEXT_B)] },
						},
					],
				},
			},
		},
	],
});

describe('the implicit walk (zzrqw situation)', () => {
	beforeAll(async () => {
		await dropSituation(WALK);
		await ensureSituation(WALK);
	});
	afterAll(async () => {
		expect(await dropSituation(WALK)).toBe(0);
	});

	const build = async (tipo: string, sectionTipo: string, mode: string, ownerIsSection = false) =>
		buildRequestConfigForElement((await getNode(tipo))?.properties ?? null, {
			ownerTipo: tipo,
			ownerSectionTipo: sectionTipo,
			mode,
			ownerIsSection,
		});
	const shown = (config: Awaited<ReturnType<typeof build>>) =>
		(config[0]?.show?.ddo_map ?? []).map((ddo) => ddo.tipo);

	describe('RC-1 — the walk source is the section_list child in every mode but edit / related_list', () => {
		test('a component with a section_list child: edit walks its own relations', async () => {
			const config = await build(SELECT_WITH_LIST, HOST, 'edit');
			expect(shown(config)).toEqual([TEXT_A, TEXT_B]);
			expect(extractSqoSectionTipos(config[0])).toEqual([TARGET_A]);
		});

		test('search, tm and any other mode walk the section_list child, as list does', async () => {
			for (const mode of ['list', 'search', 'tm', 'solved']) {
				const config = await build(SELECT_WITH_LIST, HOST, mode);
				expect([mode, shown(config)]).toEqual([mode, [TEXT_B]]);
				// the list node names no section: the component's main related one
				expect([mode, extractSqoSectionTipos(config[0])]).toEqual([mode, [TARGET_A]]);
			}
		});

		test('related_list keeps the own relations; no section_list child = own relations', async () => {
			expect(shown(await build(SELECT_WITH_LIST, HOST, 'related_list'))).toEqual([TEXT_A, TEXT_B]);
			expect(shown(await build(SELECT_NO_LIST, HOST, 'search'))).toEqual([TEXT_A]);
		});

		test("a section in search mode walks its section_list (a virtual one, its real section's)", async () => {
			const own = await build(HOST, HOST, 'search', true);
			expect(shown(own)).toEqual([HOST_TEXT]);
			expect(extractSqoSectionTipos(own[0])).toEqual([HOST]);
			const virtual = await build(VIRTUAL_HOST, VIRTUAL_HOST, 'search', true);
			expect(shown(virtual)).toEqual([HOST_TEXT]);
			expect(extractSqoSectionTipos(virtual[0])).toEqual([VIRTUAL_HOST]);
		});
	});

	describe('RC-4 — a section node is never a column; the LAST one is the target', () => {
		test('component owner: two section nodes → none is a ddo, the last is the target', async () => {
			const config = await build(TWO_SECTIONS, HOST, 'edit');
			const ddoMap = config[0]?.show?.ddo_map ?? [];
			expect(ddoMap.map((ddo) => ddo.tipo)).toEqual([TEXT_A, TEXT_C]);
			expect(ddoMap.filter((ddo) => ddo.model === 'section')).toEqual([]);
			expect(extractSqoSectionTipos(config[0])).toEqual([TARGET_B]);
			for (const ddo of ddoMap) expect(ddo.section_tipo).toBe(TARGET_B);
		});

		// The section-owner half ships the v6 rule (last wins) until owner ruling M3b.
		test('section owner (v6 rule until M3b): the last section node of its list is the target', async () => {
			const config = await build(LIST_OWNER, LIST_OWNER, 'list', true);
			const ddoMap = config[0]?.show?.ddo_map ?? [];
			expect(ddoMap.map((ddo) => ddo.tipo)).toEqual([LIST_OWNER_TEXT]);
			expect(extractSqoSectionTipos(config[0])).toEqual([TARGET_B]);
			expect(ddoMap[0]?.section_tipo).toBe(TARGET_B);
		});

		test('the principal-free walk: no section link, one target on every link', async () => {
			const { implicitComponentChildren, implicitRelationWalk } = await import(
				'../../src/core/relations/request_config/implicit.ts'
			);
			expect((await implicitComponentChildren(TWO_SECTIONS)).map((child) => child.tipo)).toEqual([
				TEXT_A,
				TEXT_C,
			]);
			const walk = await implicitRelationWalk(TWO_SECTIONS);
			expect(walk.targetSectionTipo).toBe(TARGET_B);
			expect(walk.links).toEqual([
				{ tipo: TEXT_A, model: 'component_input_text', sectionTipo: TARGET_B },
				{ tipo: TEXT_C, model: 'component_input_text', sectionTipo: TARGET_B },
			]);
		});
	});

	// RC-2 (owner ruling, NOT ported — WC-2026-10-30 addendum 2026-11-21): the
	// engine synthesizes no search.sqo_config; the picker size is the designed 25.
	describe('RC-2 — a search block without sqo_config stays without', () => {
		test('explicit config: search.sqo_config is absent in every mode, choose limit is 25', async () => {
			for (const mode of ['edit', 'search', 'list']) {
				const [item] = await build(EXPLICIT_PORTAL, HOST, mode);
				expect(item?.search?.ddo_map.map((ddo) => ddo.tipo)).toEqual([TEXT_A]);
				expect(
					item?.search !== null && item?.search !== undefined && 'sqo_config' in item.search,
				).toBe(false);
				expect(
					(item?.choose as { sqo_config?: { limit?: unknown } } | null)?.sqo_config?.limit,
				).toBe(25);
			}
		});

		test('implicit config: no search block at all', async () => {
			for (const mode of ['edit', 'search']) {
				const [item] = await build(SELECT_NO_LIST, HOST, mode);
				expect(item).toBeDefined();
				expect(item?.search).toBeNull();
			}
		});
	});
});
