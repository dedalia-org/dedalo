/**
 * Plan-compile gate: an ontology PACKAGE that this deployment does not have
 * must not fail a diffusion element — but a missing node inside an INSTALLED
 * package still must (compile.ts uninstalledTldOf).
 *
 * Real symptom this pins (2026-08-11): the Oral History element referenced the
 * `zenon*` bibliographic nodes (the DAI catalogue package, src/external/
 * services/zenon.ts) through four ddo_maps. That package is not installed here,
 * so the whole run died with "diffusion plan compile failed … ddo tipo 'zenon4'
 * not found in the ontology". Which optional packages an install carries is a
 * deployment fact; only an authoring defect may fail a compile.
 *
 * The tree is SYNTHETIC (compileElementPlan accepts an injected
 * VirtualDiffusionTree), so this suite needs no diffusion domain and no dev
 * ontology — unlike diffusion_plan_compile.test.ts, which drives the real one.
 * The only DB read is getPopulatedTlds, and the two TLDs used are chosen so the
 * answer is install-independent:
 *   - 'zzzznotinstalled' — no Dédalo install has such rows (the package case);
 *   - 'dd'                — the engine's own namespace, present in every install,
 *                          with a number no ontology reaches (the defect case).
 *
 * getPopulatedTlds vs getActiveTlds matters here and has its own gate in
 * dd_ontology_write.test.ts: the install that surfaced this carried a bare
 * `zenon0` registry root, so check_active_tld called the package installed.
 */
// Migrated to the generic `test` TLD 2026-08-19: the INSTALLED-package half now
// uses `dd` (the engine's own namespace, install-invariant) instead of an
// install's TLD; the UNINSTALLED half was already a generic absent TLD.

import { beforeAll, describe, expect, test } from 'bun:test';
import { sql } from '../../src/core/db/postgres.ts';
import type { ParserClassifier } from '../../src/diffusion/plan/compile.ts';
import {
	compileElementPlan,
	PlanCompileError,
	validateElementPlan,
} from '../../src/diffusion/plan/compile.ts';
import type {
	RawOntologyNode,
	VirtualDiffusionTree,
	VirtualTreeNode,
} from '../../src/diffusion/plan/virtual_tree.ts';

const ELEMENT_TIPO = 'ddgate1';
const TABLE_TIPO = 'ddgate2';
const SECTION_TIPO = 'ddgate10';
/** No install has this TLD in dd_ontology → "package not installed". */
const ABSENT_TLD = 'zzzznotinstalled';
/** 'dd' IS installed everywhere; this node is not → authoring defect. */
const MISSING_CORE_TIPO = 'dd999999';

/** Every parser fn is a runtime step here: this suite pins the ddo split only. */
const runtimeClassifier: ParserClassifier = () => 'runtime';

/**
 * A real, resolvable component tipo of THIS install — the mixed-chain case needs
 * one ddo that actually compiles. Discovered instead of hard-coded: every
 * install has input_text components, but not the same ones.
 */
let resolvableDdoTipo: string;

beforeAll(async () => {
	const rows = (await sql`
		SELECT tipo FROM dd_ontology WHERE model = 'component_input_text' ORDER BY tipo LIMIT 1
	`) as { tipo: string }[];
	const tipo = rows[0]?.tipo;
	if (tipo === undefined) throw new Error('no component_input_text node in dd_ontology');
	resolvableDdoTipo = tipo;
});

function fieldNode(tipo: string, label: string, ddoTipos: string[]): RawOntologyNode {
	return {
		tipo,
		parent: TABLE_TIPO,
		model: 'component_input_text',
		term: { 'lg-spa': label },
		properties: {
			process: { ddo_map: ddoTipos.map((ddo) => ({ tipo: ddo, section_tipo: 'self' })) },
		},
		relations: null,
	};
}

/**
 * One diffusion element ('xml' format, so no MariaDB target and no SQL
 * identifier chokepoint on the labels — and, unlike rdf since T1-4, a COLUMN
 * format: its fields compile to columns, the law under test) over the given
 * field nodes.
 * `fieldTipos` may name a tipo absent from `nodes` — that is the missing-field
 * case, which compileFieldPlan classifies with the same rule.
 */
function makeTree(fieldTipos: string[], nodes: RawOntologyNode[]): VirtualDiffusionTree {
	const byTipo = new Map(nodes.map((node) => [node.tipo, node]));
	const element: VirtualTreeNode = {
		tipo: ELEMENT_TIPO,
		model: 'diffusion_element',
		label: 'gate_element',
		properties: { diffusion: { type: 'xml', service_name: 'gate_test' } },
		realTipo: null,
		isAlias: false,
		parents: [],
		childrenTipos: [TABLE_TIPO],
		directChildrenTipos: [TABLE_TIPO],
		relatedSections: [],
	};
	const table: VirtualTreeNode = {
		tipo: TABLE_TIPO,
		model: 'owl:Class',
		label: 'gate_class',
		properties: null,
		realTipo: null,
		isAlias: false,
		parents: [
			{
				tipo: ELEMENT_TIPO,
				model: 'diffusion_element',
				label: 'gate_element',
				realTipo: null,
				type: 'xml',
			},
		],
		childrenTipos: fieldTipos,
		directChildrenTipos: fieldTipos,
		relatedSections: [SECTION_TIPO],
	};
	return {
		domainName: 'gate_domain',
		domainTipo: 'ddgate0',
		nodes: [element, table],
		index: {
			nodeOf: async (tipo) => byTipo.get(tipo) ?? null,
			childTipos: async () => [],
			relatedByModel: async () => [],
			relationTipos: async () => [],
			resolveAlias: async () => null,
		},
	};
}

const compileOptions = (tree: VirtualDiffusionTree) => ({
	tree,
	classifyParserFn: runtimeClassifier,
});

describe('uninstalled ontology package (deployment fact — never a compile failure)', () => {
	test('a ddo in an uninstalled TLD is skipped, the field keeps its empty column', async () => {
		const tree = makeTree(
			['ddgate3'],
			[fieldNode('ddgate3', 'ref_publications_title', [`${ABSENT_TLD}4`])],
		);
		const validation = await validateElementPlan(ELEMENT_TIPO, compileOptions(tree));

		expect(validation.errors).toEqual([]);
		expect(validation.result).not.toBeNull();
		const plan = validation.result as NonNullable<typeof validation.result>;

		// the column survives: the published schema must not shift with which
		// optional packages an install happens to carry
		const field = plan.sections[0]?.fields[0];
		expect(field?.id).toBe('ddgate3');
		expect(field?.columnName).toBe('ref_publications_title');
		expect(field?.sourceChain).toEqual([]);

		// skipped, not silent
		expect(plan.warnings).toContain(`uninstalled-tld:${ABSENT_TLD}@ddgate3`);
	});

	test('a FIELD node of an uninstalled TLD is dropped without an error', async () => {
		const tree = makeTree(
			[`${ABSENT_TLD}7`, 'ddgate3'],
			[fieldNode('ddgate3', 'kept', [resolvableDdoTipo])],
		);
		const validation = await validateElementPlan(ELEMENT_TIPO, compileOptions(tree));

		expect(validation.errors).toEqual([]);
		expect(validation.warnings).toContain(`uninstalled-tld:${ABSENT_TLD}@${ABSENT_TLD}7`);
		expect(validation.result?.sections[0]?.fields.map((field) => field.id)).toEqual(['ddgate3']);
	});

	test('surviving ddos of a partially-skipped field still compile', async () => {
		// mixed chain: the absent package's ddo drops out, the resolvable one stays
		const tree = makeTree(
			['ddgate3'],
			[fieldNode('ddgate3', 'mixed', [`${ABSENT_TLD}4`, resolvableDdoTipo])],
		);
		const validation = await validateElementPlan(ELEMENT_TIPO, compileOptions(tree));

		expect(validation.errors).toEqual([]);
		const chain = validation.result?.sections[0]?.fields[0]?.sourceChain ?? [];
		expect(chain.map((step) => (step.kind === 'system' ? 'system' : step.tipo))).toEqual([
			resolvableDdoTipo,
		]);
	});
});

describe('missing node inside an INSTALLED package (authoring defect — still fatal)', () => {
	test('a ddo tipo of an installed TLD with no node is a compile ERROR', async () => {
		const tree = makeTree(['ddgate3'], [fieldNode('ddgate3', 'broken_ddo', [MISSING_CORE_TIPO])]);
		expect(compileElementPlan(ELEMENT_TIPO, compileOptions(tree))).rejects.toThrow(
			PlanCompileError,
		);

		const validation = await validateElementPlan(ELEMENT_TIPO, compileOptions(tree));
		expect(validation.result).toBeNull();
		expect(validation.errors).toEqual([
			`field 'ddgate3' (broken_ddo): ddo tipo '${MISSING_CORE_TIPO}' not found in the ontology`,
		]);
		expect(validation.warnings).toEqual([]);
	});

	test('a missing FIELD node of an installed TLD is a compile ERROR', async () => {
		const tree = makeTree([MISSING_CORE_TIPO], []);
		const validation = await validateElementPlan(ELEMENT_TIPO, compileOptions(tree));

		expect(validation.result).toBeNull();
		expect(validation.errors).toEqual([
			`field '${MISSING_CORE_TIPO}': node not found in the ontology`,
		]);
	});
});
