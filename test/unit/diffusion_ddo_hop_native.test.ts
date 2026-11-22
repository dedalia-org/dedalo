/**
 * TWO DDO KEYS OF A RELATION HOP, compiled and honoured (T2-DIF-2, T2-DIF-3).
 *
 * DIF-2 — ddo `empty_value` (WC-2026-11-22-diffusion-ddo-empty-value). The
 * frozen-v7 chain processor (dd_object::$empty_value, chain_processor
 * :370-405) emits, per parent locator whose child ddos resolved NOTHING, one
 * placeholder locator whose section_id is the declared value — v6's
 * resolve_value `empty_value` (a coin with no hoard publishes "0", so every
 * coin keeps its slot). The TS compiler never read the ddo key: the hop
 * published two ids for three locators. RED before: `1,3` instead of `1,0,3`.
 * A ddo key the engine cannot honour (empty_value on a terminal component,
 * a malformed value) REFUSES the compile.
 *
 * DIF-3 — the dataframe hop scoped to its main
 * (WC-2026-11-22-diffusion-dataframe-hop). A component_dataframe ddo whose
 * `parent` names its MAIN component publishes only that main's frames
 * (frozen-v7 component_dataframe::get_diffusion_data :621-650), read from the
 * HOST record (the record holding the main — not the main's linked records),
 * each frame carrying its pairing `id_key`. One slot here serves two mains;
 * the ddo is scoped to one. RED before: the step hung under the main's hop and
 * ran against the main's TARGET records — no frame published at all. A parent
 * that is not a ddo of the map, or does not declare the slot, REFUSES.
 *
 * Built on its OWN situation (`zzdhp`, dropped with residue 0); the
 * publication gate is the ordinary one (no component_publication → publish).
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { clearOntologyDerivedCaches } from '../../src/core/ontology/cache_invalidation.ts';
import {
	dropSituation,
	ensureSituation,
	situation,
} from '../../src/core/test_data/situations/situation.ts';
import { assertTestDatabase } from '../../src/core/test_data/test_database_marker.ts';
import { compileElementPlan, validateElementPlan } from '../../src/diffusion/plan/compile.ts';
import type { PublicationPlan, ResolveStep } from '../../src/diffusion/plan/types.ts';
import {
	buildVirtualDiffusionTree,
	type VirtualDiffusionTree,
} from '../../src/diffusion/plan/virtual_tree.ts';
import {
	type FieldResolutionError,
	leafMergeColumns,
	resolvePublication,
} from '../../src/diffusion/resolve/resolver.ts';
import { DB_READY } from '../helpers/db_ready.ts';

const DOMAIN_NAME = 'zzdhp ddo hop domain';
const HOST = 'zzdhp1';
const PORTAL_S = 'zzdhp2'; // HOST → S (carries empty_value)
const MAIN_1 = 'zzdhp3'; // HOST → T, main 1 of the slot
const MAIN_2 = 'zzdhp4'; // HOST → T, main 2 of the slot (declares it by request_config)
const FRAME_SLOT = 'zzdhp5'; // component_dataframe, ontology child of MAIN_1
const HOST_TEXT = 'zzdhp6'; // a terminal component of HOST
const SECTION_S = 'zzdhp10';
const PORTAL_U = 'zzdhp11'; // S → U (the child ddo of PORTAL_S)
const SECTION_U = 'zzdhp15';
const SECTION_T = 'zzdhp20';
const SECTION_R = 'zzdhp25'; // frame targets
const ELEMENT = 'zzdhp42';
const BAD_ELEMENT = 'zzdhp62';
const LEAF_ELEMENT = 'zzdhp70'; // compile-only: the column topology of a root literal main
const LITERAL_FRAME_FIELD = 'zzdhp73';

const EMPTY_FIELD = 'zzdhp45';
const CONTROL_FIELD = 'zzdhp46';
const FRAME_FIELD = 'zzdhp47';

// The v6-compatible projection (string ids) — the shape the migrated v6
// columns carrying empty_value publish through.
const SECTION_ID = 'parser_locator::get_v6_section_id';

/** A per-source grouped cell (`["1"] | ["3"]`) → its ids, in order. */
const cellIds = (cell: string | null | undefined): string[] =>
	String(cell)
		.split(' | ')
		.flatMap((part) => JSON.parse(part) as string[]);

const locator = (
	sectionTipo: string,
	sectionId: number,
	from: string,
	extra: Record<string, unknown> = {},
) => ({
	type: 'dd151',
	section_tipo: sectionTipo,
	section_id: sectionId,
	from_component_tipo: from,
	...extra,
});

const frame = (targetId: number, main: string, idKey: number) => ({
	type: 'dd490',
	section_tipo: SECTION_R,
	section_id: targetId,
	from_component_tipo: FRAME_SLOT,
	main_component_tipo: main,
	id_key: idKey,
});

const fieldNode = (
	tipo: string,
	parent: string,
	name: string,
	ddoMap: Record<string, unknown>[],
	relation: string,
	order: number,
	parser = SECTION_ID,
) => ({
	tipo,
	parent,
	model: 'field_text',
	term: { 'lg-spa': name },
	relations: [{ tipo: relation }],
	properties: { process: { parser: [{ fn: parser }], ddo_map: ddoMap } },
	order_number: order,
});

const SITUATION = situation({
	name: 'zzdhp diffusion ddo hop keys',
	tld: 'zzdhp',
	nodes: [
		{ tipo: HOST, parent: 'test1', model: 'section', term: { 'lg-spa': 'zzdhp host' } },
		{
			tipo: PORTAL_S,
			parent: HOST,
			model: 'component_portal',
			term: { 'lg-spa': 'zzdhp to S' },
			order_number: 1,
		},
		{
			tipo: MAIN_1,
			parent: HOST,
			model: 'component_portal',
			term: { 'lg-spa': 'zzdhp main 1' },
			order_number: 2,
		},
		{
			tipo: MAIN_2,
			parent: HOST,
			model: 'component_portal',
			term: { 'lg-spa': 'zzdhp main 2' },
			order_number: 3,
			properties: { source: { request_config: [{ show: { ddo_map: [{ tipo: FRAME_SLOT }] } }] } },
		},
		{
			tipo: FRAME_SLOT,
			parent: MAIN_1,
			model: 'component_dataframe',
			term: { 'lg-spa': 'zzdhp frame slot' },
			order_number: 1,
		},
		{
			tipo: HOST_TEXT,
			parent: HOST,
			model: 'component_input_text',
			term: { 'lg-spa': 'zzdhp text' },
			order_number: 4,
			// a LITERAL main: declares the slot by request_config
			properties: { source: { request_config: [{ show: { ddo_map: [{ tipo: FRAME_SLOT }] } }] } },
		},
		{ tipo: SECTION_S, parent: 'test1', model: 'section', term: { 'lg-spa': 'zzdhp S' } },
		{
			tipo: PORTAL_U,
			parent: SECTION_S,
			model: 'component_portal',
			term: { 'lg-spa': 'zzdhp to U' },
			order_number: 1,
		},
		{ tipo: SECTION_U, parent: 'test1', model: 'section', term: { 'lg-spa': 'zzdhp U' } },
		{ tipo: SECTION_T, parent: 'test1', model: 'section', term: { 'lg-spa': 'zzdhp T' } },
		{ tipo: SECTION_R, parent: 'test1', model: 'section', term: { 'lg-spa': 'zzdhp R' } },
		{
			tipo: 'zzdhp40',
			parent: 'dd1190',
			model: 'diffusion_domain',
			term: { 'lg-spa': DOMAIN_NAME },
		},
		{
			tipo: 'zzdhp41',
			parent: 'zzdhp40',
			model: 'diffusion_group',
			term: { 'lg-spa': 'zzdhp group' },
		},
		{
			tipo: ELEMENT,
			parent: 'zzdhp41',
			model: 'diffusion_element',
			term: { 'lg-spa': 'zzdhp sql element' },
			properties: { diffusion: { type: 'sql' } },
		},
		{ tipo: 'zzdhp43', parent: ELEMENT, model: 'database', term: { 'lg-spa': 'zzdhp_db' } },
		{
			tipo: 'zzdhp44',
			parent: 'zzdhp43',
			model: 'table',
			term: { 'lg-spa': 'zzdhp_host' },
			relations: [{ tipo: HOST }],
		},
		fieldNode(
			EMPTY_FIELD,
			'zzdhp44',
			'hoards',
			[
				{ tipo: PORTAL_S, section_tipo: 'self', parent: 'self', empty_value: ['0'] },
				{ tipo: PORTAL_U, section_tipo: SECTION_S, parent: PORTAL_S },
			],
			PORTAL_S,
			1,
		),
		fieldNode(
			CONTROL_FIELD,
			'zzdhp44',
			'hoards_control',
			[
				{ tipo: PORTAL_S, section_tipo: 'self', parent: 'self' },
				{ tipo: PORTAL_U, section_tipo: SECTION_S, parent: PORTAL_S },
			],
			PORTAL_S,
			2,
		),
		fieldNode(
			FRAME_FIELD,
			'zzdhp44',
			'main_frames',
			[
				{ tipo: MAIN_1, section_tipo: 'self', parent: 'self' },
				{ tipo: FRAME_SLOT, section_tipo: 'self', parent: MAIN_1 },
			],
			MAIN_1,
			3,
			'parser_locator::get_locator',
		),
		// The refusals: one element, every field carries one defect.
		{
			tipo: BAD_ELEMENT,
			parent: 'zzdhp41',
			model: 'diffusion_element',
			term: { 'lg-spa': 'zzdhp bad element' },
			properties: { diffusion: { type: 'sql' } },
		},
		{ tipo: 'zzdhp63', parent: BAD_ELEMENT, model: 'database', term: { 'lg-spa': 'zzdhp_bad_db' } },
		{
			tipo: 'zzdhp64',
			parent: 'zzdhp63',
			model: 'table',
			term: { 'lg-spa': 'zzdhp_bad' },
			relations: [{ tipo: HOST }],
		},
		fieldNode(
			'zzdhp65',
			'zzdhp64',
			'frame_parent_not_in_map',
			[{ tipo: FRAME_SLOT, section_tipo: 'self', parent: MAIN_2 }],
			FRAME_SLOT,
			1,
		),
		fieldNode(
			'zzdhp66',
			'zzdhp64',
			'frame_parent_without_slot',
			[
				{ tipo: PORTAL_S, section_tipo: 'self', parent: 'self' },
				{ tipo: FRAME_SLOT, section_tipo: 'self', parent: PORTAL_S },
			],
			PORTAL_S,
			2,
		),
		fieldNode(
			'zzdhp67',
			'zzdhp64',
			'empty_value_malformed',
			[{ tipo: PORTAL_S, section_tipo: 'self', parent: 'self', empty_value: '0' }],
			PORTAL_S,
			3,
		),
		fieldNode(
			'zzdhp68',
			'zzdhp64',
			'empty_value_on_terminal',
			[{ tipo: HOST_TEXT, section_tipo: 'self', parent: 'self', empty_value: ['0'] }],
			HOST_TEXT,
			4,
		),
		// Compile-only: a root LITERAL main + its scoped dataframe. The main is
		// not a leaf column (it is the frame's parent ddo) — the compiled hop
		// carries no `parent` (root level), only mainComponentTipo.
		{
			tipo: LEAF_ELEMENT,
			parent: 'zzdhp41',
			model: 'diffusion_element',
			term: { 'lg-spa': 'zzdhp leaf element' },
			properties: { diffusion: { type: 'sql' } },
		},
		{
			tipo: 'zzdhp71',
			parent: LEAF_ELEMENT,
			model: 'database',
			term: { 'lg-spa': 'zzdhp_leaf_db' },
		},
		{
			tipo: 'zzdhp72',
			parent: 'zzdhp71',
			model: 'table',
			term: { 'lg-spa': 'zzdhp_leaf' },
			relations: [{ tipo: HOST }],
		},
		fieldNode(
			LITERAL_FRAME_FIELD,
			'zzdhp72',
			'literal_frames',
			[
				{ tipo: HOST_TEXT, section_tipo: 'self', parent: 'self' },
				{ tipo: FRAME_SLOT, section_tipo: 'self', parent: HOST_TEXT },
			],
			HOST_TEXT,
			1,
			'parser_locator::get_locator',
		),
	],
	records: [
		{
			section_tipo: HOST,
			section_id: 1,
			columns: {
				relation: {
					[PORTAL_S]: [
						locator(SECTION_S, 1, PORTAL_S, { id: 1 }),
						locator(SECTION_S, 2, PORTAL_S, { id: 2 }),
						locator(SECTION_S, 3, PORTAL_S, { id: 3 }),
						// FOREIGN to the child ddo's section: no child applies (the whitelist branch).
						locator(SECTION_U, 9, PORTAL_S, { id: 4 }),
					],
					[MAIN_1]: [
						locator(SECTION_T, 1, MAIN_1, { id: 1 }),
						locator(SECTION_T, 2, MAIN_1, { id: 2 }),
					],
					[MAIN_2]: [locator(SECTION_T, 1, MAIN_2, { id: 1 })],
					// ONE slot, two mains: frames of MAIN_1 (id_key 1, 2) and of MAIN_2 (id_key 1).
					[FRAME_SLOT]: [frame(11, MAIN_1, 1), frame(12, MAIN_1, 2), frame(13, MAIN_2, 1)],
				},
			},
		},
		{
			section_tipo: SECTION_S,
			section_id: 1,
			columns: { relation: { [PORTAL_U]: [locator(SECTION_U, 1, PORTAL_U)] } },
		},
		// S/2 holds NO child value: the locator its parent points to resolves empty.
		{ section_tipo: SECTION_S, section_id: 2, columns: { relation: {} } },
		{
			section_tipo: SECTION_S,
			section_id: 3,
			columns: { relation: { [PORTAL_U]: [locator(SECTION_U, 3, PORTAL_U)] } },
		},
	],
});

let tree: VirtualDiffusionTree;
let plan: PublicationPlan;

async function run(): Promise<{
	columns: Record<string, string | null>;
	errors: FieldResolutionError[];
}> {
	let columns: Record<string, string | null> | null = null;
	const errors: FieldResolutionError[] = [];
	for await (const batch of resolvePublication(plan, {
		sectionTipo: HOST,
		runStartedAt: 1_751_700_000,
		tree,
		maxLevels: 0,
		sqo: { section_tipo: HOST, filter_by_locators: [{ section_tipo: HOST, section_id: '1' }] },
	})) {
		errors.push(...batch.errors);
		for (const row of batch.rows) if (columns === null) columns = row.columns;
	}
	if (columns === null) throw new Error('the host record produced no row');
	return { columns, errors };
}

describe.if(DB_READY)('ddo hop keys: empty_value + main-scoped dataframe (T2-DIF-2/3)', () => {
	let outcome: Awaited<ReturnType<typeof run>>;

	beforeAll(async () => {
		await assertTestDatabase('diffusion_ddo_hop_native');
		await dropSituation(SITUATION);
		await ensureSituation(SITUATION);
		await clearOntologyDerivedCaches();
		const built = await buildVirtualDiffusionTree(DOMAIN_NAME);
		if (built === null) throw new Error(`no dd1190 domain node is named '${DOMAIN_NAME}'`);
		tree = built;
		plan = await compileElementPlan(ELEMENT, { tree });
		outcome = await run();
	}, 120_000);

	afterAll(async () => {
		await assertTestDatabase('diffusion_ddo_hop_native');
		expect(await dropSituation(SITUATION)).toBe(0);
		await clearOntologyDerivedCaches();
	}, 120_000);

	test('the run resolves without errors', () => {
		expect(outcome.errors).toEqual([]);
	});

	test('DIF-2: empty_value compiles onto the hop', () => {
		const field = plan.sections[0]?.fields.find((candidate) => candidate.id === EMPTY_FIELD);
		const hop = field?.sourceChain.find(
			(step): step is Extract<ResolveStep, { kind: 'relation-hop' }> =>
				step.kind === 'relation-hop' && step.tipo === PORTAL_S,
		);
		expect(hop?.emptyValue).toBe('0');
	});

	test('DIF-2: an empty locator and a foreign one → one placeholder each, in its slot', () => {
		const value = outcome.columns.hoards ?? null;
		expect(value).not.toBeNull();
		expect(cellIds(value)).toEqual(['1', '0', '3', '0']);
	});

	test('DIF-2 control: without empty_value the empty locator leaves no slot', () => {
		const value = outcome.columns.hoards_control ?? null;
		expect(cellIds(value)).toEqual(['1', '3']);
	});

	test('DIF-3: the dataframe ddo compiles to a host-record hop scoped to its main', () => {
		const field = plan.sections[0]?.fields.find((candidate) => candidate.id === FRAME_FIELD);
		const hop = field?.sourceChain.find(
			(step): step is Extract<ResolveStep, { kind: 'relation-hop' }> =>
				step.kind === 'relation-hop' && step.tipo === FRAME_SLOT,
		);
		expect(hop?.mainComponentTipo).toBe(MAIN_1);
		// the main is a ROOT ddo, so its frames are read at the root: the host record
		expect(hop?.parent).toBeUndefined();
	});

	test('DIF-3: a root literal main is not a leaf column — only its scoped dataframe is', async () => {
		const leafPlan = await compileElementPlan(LEAF_ELEMENT, { tree });
		const field = leafPlan.sections[0]?.fields.find(
			(candidate) => candidate.id === LITERAL_FRAME_FIELD,
		);
		const chain = field?.sourceChain ?? [];
		// the shape under test: a component main, a parentless scoped hop
		expect(chain.map((step) => (step.kind === 'system' ? 'system' : step.kind))).toEqual([
			'component',
			'relation-hop',
		]);
		const hop = chain[1] as Extract<ResolveStep, { kind: 'relation-hop' }>;
		expect(hop.parent).toBeUndefined();
		expect(hop.mainComponentTipo).toBe(HOST_TEXT);
		expect(leafMergeColumns(chain).map((column) => column.tipo)).toEqual([FRAME_SLOT]);
	});

	test("DIF-3: only the scoped main's frames publish, each with its pairing id", () => {
		const raw = outcome.columns.main_frames ?? null;
		expect(raw).not.toBeNull();
		const locators = String(raw)
			.split(' | ')
			.flatMap((part) => JSON.parse(part) as Record<string, unknown>[]);
		const frames = locators.filter((entry) => entry.section_tipo === SECTION_R);
		expect(
			frames.map((entry) => [String(entry.section_id), entry.id_key, entry.main_component_tipo]),
		).toEqual([
			['11', 1, MAIN_1],
			['12', 2, MAIN_1],
		]);
		// the main's own items still publish (the frames sit beside them)
		expect(
			locators
				.filter((entry) => entry.section_tipo === SECTION_T)
				.map((entry) => String(entry.section_id)),
		).toEqual(['1', '2']);
	});

	test('refusals: an unhonourable ddo key or a wrong dataframe parent fails the compile, named', async () => {
		const report = await validateElementPlan(BAD_ELEMENT, { tree });
		expect(report.result).toBeNull();
		const errors = report.errors.join('\n');
		expect(errors).toContain("'zzdhp65'");
		expect(errors).toContain(`names parent '${MAIN_2}', which is not a ddo of this ddo_map`);
		expect(errors).toContain("'zzdhp66'");
		expect(errors).toContain(`does not declare '${FRAME_SLOT}' as a dataframe slot`);
		expect(errors).toContain("'zzdhp67'");
		expect(errors).toContain("'empty_value' must be a non-empty list");
		expect(errors).toContain("'zzdhp68'");
		expect(errors).toContain("declares 'empty_value', which is honoured on a relation hop only");
		expect(report.errors.length).toBe(4);
	});
});
