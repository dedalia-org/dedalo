/**
 * CALCULATION FN REGISTRY TRIPWIRE — every `calculation` widget an ontology
 * ships is RUNNABLE by the engine: its formula is registered, its inputs feed
 * a calculation, its scope is one the engine implements.
 *
 * THE DEFECT THIS GATE EXISTS FOR (T1-1, 2026-11-12). The calculation widget
 * held 3 of the 9 formulas the shipped ontology declares and answered an
 * unknown fn with a silent `[]`: every mdcat grant amount, period and total
 * rendered blank, and nothing said which declared formulas the engine could
 * not run. The widget now REFUSES an unregistered fn (ontology.invalid_node);
 * this gate makes that refusal impossible on the shipped release — and proves
 * the refusals for the not-implemented scopes ('all' / 'search_session' /
 * filter:true / the true-false constants) are never reached either.
 *
 * THE CORPORA (OUTCOME over data):
 *   1. install/import/ontology/<release>/*.copy.gz — the shipped packages, read
 *      through the ONE package-row loader (test/helpers/
 *      vendored_ontology_corpus.ts vendoredOntologyNodes; a node's model is
 *      its ontology6 locator's ontology43 machine name);
 *   2. src/core/test_data/test_tld_ontology.json — the suite's own twins.
 *
 * WHAT IS PINNED, per `widgets[widget_name='calculation'].ipo[]` block:
 *   - process.fn ∈ CALCULATION_FUNCTIONS (widgets/calculation/functions.ts);
 *   - input.section_id is 'current', filter is not true, no true/false keys;
 *   - every input names a tipo + var_name, the tipo is a node of the corpus,
 *     and its model has a calculationData facet (registry getCalculationDataId);
 *   - a relation input carries options.ddo_map with a 'self' anchor, and every
 *     ddo fn is a registered ddo function (CALCULATION_DDO_FUNCTIONS) on a
 *     model with the facet.
 * ANTI-VACUITY: ≥ 22 shipped calculation blocks, all nine formulas seen across
 * the corpora, and a positive control (a synthetic block with fn 'nope' and an
 * aggregate scope IS reported).
 *
 * HERMETIC: tracked files only, no database.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CALCULATION_DDO_FUNCTIONS } from '../../src/core/components/calculation_data.ts';
import { CALCULATION_FUNCTIONS } from '../../src/core/components/component_info/widgets/calculation/functions.ts';
import { getCalculationDataId } from '../../src/core/components/registry.ts';
import { vendoredOntologyNodes } from '../helpers/vendored_ontology_corpus.ts';

const REPO_ROOT = join(import.meta.dir, '..', '..');

/** A judged node: tipo, properties, resolved model name, corpus. */
interface CorpusNode {
	tipo: string;
	properties: unknown;
	model: string | null;
	corpus: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function loadPackageNodes(): CorpusNode[] {
	const { nodes } = vendoredOntologyNodes();
	const machineNames = new Map(nodes.map((node) => [node.tipo, node.machineName]));
	return nodes.map((node) => ({
		tipo: node.tipo,
		properties: node.properties,
		model: node.modelTipo === null ? null : (machineNames.get(node.modelTipo) ?? null),
		corpus: node.corpus,
	}));
}

function loadTestTldNodes(): CorpusNode[] {
	const doc = JSON.parse(
		readFileSync(join(REPO_ROOT, 'src/core/test_data/test_tld_ontology.json'), 'utf8'),
	) as { nodes: { tipo: string; model: string | null; properties: unknown }[] };
	return doc.nodes.map((node) => ({
		tipo: node.tipo,
		properties: node.properties,
		model: node.model,
		corpus: 'test_tld_ontology.json',
	}));
}

const PACKAGE_NODES = loadPackageNodes();
const TEST_NODES = loadTestTldNodes();

/** One calculation ipo block, located. */
interface CalculationBlock {
	tipo: string;
	key: number;
	block: unknown;
}

function calculationBlocks(nodes: readonly CorpusNode[]): CalculationBlock[] {
	const blocks: CalculationBlock[] = [];
	for (const node of nodes) {
		const widgets = isPlainObject(node.properties) ? node.properties.widgets : undefined;
		if (!Array.isArray(widgets)) continue;
		for (const widget of widgets) {
			if (!isPlainObject(widget) || widget.widget_name !== 'calculation') continue;
			const ipo = Array.isArray(widget.ipo) ? widget.ipo : [];
			for (const [key, block] of ipo.entries()) blocks.push({ tipo: node.tipo, key, block });
		}
	}
	return blocks;
}

/** Every reason one block is not runnable ([] = runnable). */
function judgeBlock(entry: CalculationBlock, modelOf: (tipo: string) => string | null): string[] {
	const at = `${entry.tipo} ipo[${entry.key}]`;
	const problems: string[] = [];
	const block = isPlainObject(entry.block) ? entry.block : {};
	const process = isPlainObject(block.process) ? block.process : {};
	const fn = process.fn;
	if (typeof fn !== 'string' || !Object.hasOwn(CALCULATION_FUNCTIONS, fn)) {
		problems.push(`${at}: process.fn '${String(fn)}' is not a registered calculation function`);
	}
	const input = isPlainObject(block.input) ? block.input : {};
	if (input.section_id !== 'current') {
		problems.push(`${at}: input.section_id '${String(input.section_id)}' is not implemented`);
	}
	if (input.filter === true) problems.push(`${at}: input.filter true is not implemented`);
	for (const constant of ['true', 'false']) {
		if (constant in input) problems.push(`${at}: input.${constant} constants are not implemented`);
	}
	for (const component of Array.isArray(input.components) ? input.components : []) {
		problems.push(...judgeInput(at, component, modelOf));
	}
	return problems;
}

function judgeInput(
	at: string,
	component: unknown,
	modelOf: (tipo: string) => string | null,
): string[] {
	if (!isPlainObject(component) || typeof component.tipo !== 'string') {
		return [`${at}: an input component has no tipo`];
	}
	if (typeof component.var_name !== 'string')
		return [`${at}: input ${component.tipo} has no var_name`];
	const model = modelOf(component.tipo);
	const facet = model === null ? undefined : getCalculationDataId(model);
	if (facet === undefined) {
		return [`${at}: input ${component.tipo} (model ${String(model)}) cannot feed a calculation`];
	}
	if (facet !== 'relation') return [];
	const options = isPlainObject(component.options) ? component.options : {};
	const ddoMap = Array.isArray(options.ddo_map) ? options.ddo_map : [];
	if (ddoMap.length === 0) return [`${at}: relation input ${component.tipo} declares no ddo_map`];
	const problems: string[] = [];
	if (!ddoMap.some((ddo) => isPlainObject(ddo) && ddo.parent === 'self')) {
		problems.push(`${at}: relation input ${component.tipo}: no ddo anchored to 'self'`);
	}
	for (const ddo of ddoMap) {
		const ddoFn = isPlainObject(ddo) ? (ddo.fn ?? ddo.data_fn) : undefined;
		if (ddoFn === undefined) continue;
		const ddoTipo = isPlainObject(ddo) ? String(ddo.tipo) : '?';
		if (typeof ddoFn !== 'string' || !CALCULATION_DDO_FUNCTIONS.has(ddoFn)) {
			problems.push(`${at}: ddo ${ddoTipo} fn '${String(ddoFn)}' is not a registered ddo function`);
			continue;
		}
		const ddoModel = modelOf(ddoTipo);
		if (ddoModel === null || getCalculationDataId(ddoModel) === undefined) {
			problems.push(`${at}: ddo ${ddoTipo} (model ${String(ddoModel)}) cannot feed a calculation`);
		}
	}
	return problems;
}

function modelResolver(nodes: readonly CorpusNode[]): (tipo: string) => string | null {
	const byTipo = new Map(nodes.map((node) => [node.tipo, node.model]));
	return (tipo) => byTipo.get(tipo) ?? null;
}

const PACKAGE_BLOCKS = calculationBlocks(PACKAGE_NODES);
const TEST_BLOCKS = calculationBlocks(TEST_NODES);

describe('calculation fn registry tripwire', () => {
	test('anti-vacuity: the shipped blocks are found and every formula is exercised', () => {
		expect(PACKAGE_NODES.length, 'shipped ontology nodes').toBeGreaterThan(10000);
		expect(PACKAGE_BLOCKS.length, 'shipped calculation blocks').toBeGreaterThanOrEqual(22);
		expect(TEST_BLOCKS.length, 'suite twin calculation blocks').toBeGreaterThanOrEqual(22);
		const seen = new Set(
			[...PACKAGE_BLOCKS, ...TEST_BLOCKS].map((entry) =>
				isPlainObject(entry.block) && isPlainObject(entry.block.process)
					? entry.block.process.fn
					: undefined,
			),
		);
		expect([...seen].sort()).toEqual(Object.keys(CALCULATION_FUNCTIONS).sort());
	});

	test('positive control: an unregistered fn and an aggregate scope ARE reported', () => {
		const problems = judgeBlock(
			{
				tipo: 'synthetic',
				key: 0,
				block: {
					input: { section_id: 'all', filter: true, components: [] },
					process: { fn: 'nope' },
				},
			},
			() => null,
		);
		expect(problems).toHaveLength(3);
	});

	test('every SHIPPED calculation block is runnable', () => {
		const modelOf = modelResolver(PACKAGE_NODES);
		expect(PACKAGE_BLOCKS.flatMap((entry) => judgeBlock(entry, modelOf))).toEqual([]);
	});

	test('every suite twin calculation block is runnable', () => {
		const modelOf = modelResolver(TEST_NODES);
		expect(TEST_BLOCKS.flatMap((entry) => judgeBlock(entry, modelOf))).toEqual([]);
	});
});
