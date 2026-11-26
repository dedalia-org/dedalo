/**
 * CALCULATION FN REGISTRY TRIPWIRE — every `calculation` widget an ontology
 * declares is judged through the engine's FULL dispatch: its `process` block
 * (`fn`, `file`, `engine`) resolves to a registered function, its inputs feed
 * a calculation, its scope is one the engine implements.
 *
 * THE DEFECT THIS GATE EXISTS FOR (T1-1, 2026-11-12). The calculation widget
 * held 3 of the 9 formulas the shipped ontology declares and answered an
 * unknown fn with a silent `[]`: every mdcat grant amount, period and total
 * rendered blank, and nothing said which declared formulas the engine could
 * not run. The widget REFUSES an unresolvable block (ontology.invalid_node);
 * this gate makes that refusal visible against the corpora — and proves the
 * refusals for the not-implemented scopes ('all' / 'search_session' /
 * filter:true / the true-false constants) are never reached either.
 *
 * THE DISPATCH IT JUDGES (2026-11-13, src/tld/registry.ts resolveCalculationFn):
 * `process.file` is the KEY — `/calculation/formulas.ts` → the generic table,
 * `/<tld>/calculation/<module>.ts` → that TLD package's module — and
 * `process.engine` must be `'ts'`. A PHP-era block (`.php`, `engine:'php'`) is
 * refused, no alias.
 *
 * THE CORPORA (OUTCOME over data):
 *   1. install/import/ontology/<release>/*.copy.gz — the shipped packages, read
 *      through the ONE package-row loader (test/helpers/
 *      vendored_ontology_corpus.ts vendoredOntologyNodes; a node's model is
 *      its ontology6 locator's ontology43 machine name);
 *   2. src/core/test_data/test_tld_ontology.json — the suite's own twins
 *      (flipped to the `.ts` / `engine:'ts'` shape at clone time, owner 2026-11-13).
 *
 * THE SHIPPED CORPUS IS TS-ERA (re-vendored 2026-11-26 from the v7 master's
 * release). Until then every shipped block was in the earlier engine's shape and
 * banked, shrink-only, as `SHIPPED_PHP_ERA` (ruling 2026-11-13); the bank is now
 * `{}` and stays the gate against a php-era block coming back:
 *   B. every shipped block is runnable as-is;
 *   C. the php-era histogram is EXACTLY `{}` — a re-vendored release that
 *      reintroduces one is red.
 * (Leg A — every php-era block refused ONLY by the engine/file rule — retired
 * with the last php-era block: it had nothing left to judge.)
 *
 * WHAT IS PINNED, per `widgets[widget_name='calculation'].ipo[]` block:
 *   - process resolves through resolveCalculationFn (fn + file + engine);
 *   - input.section_id is 'current', filter is not true, no true/false keys;
 *   - every input names a tipo + var_name, the tipo is a node of the corpus,
 *     and its model has a calculationData facet (registry getCalculationDataId);
 *   - a relation input carries options.ddo_map with a 'self' anchor, and every
 *     ddo fn is a registered ddo function (CALCULATION_DDO_FUNCTIONS) on a
 *     model with the facet.
 * ANTI-VACUITY: ≥ 22 shipped blocks, ≥ 22 suite blocks, the fn names seen
 * across the corpora == generic ∪ every package module (nine), and a positive
 * control (a synthetic block with fn 'nope', a php engine and an aggregate
 * scope IS reported).
 *
 * HERMETIC: tracked files only, no database.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CALCULATION_DDO_FUNCTIONS } from '../../src/core/components/calculation_data.ts';
import { CALCULATION_FUNCTIONS } from '../../src/core/components/component_info/widgets/calculation/functions.ts';
import { getCalculationDataId } from '../../src/core/components/registry.ts';
import { DedaloError } from '../../src/core/errors/dedalo_error.ts';
import { CALCULATION_ENGINE, resolveCalculationFn, TLD_PACKAGES } from '../../src/tld/registry.ts';
import { vendoredOntologyNodes } from '../helpers/vendored_ontology_corpus.ts';

const REPO_ROOT = join(import.meta.dir, '..', '..');

/**
 * THE SHIPPED PHP-ERA BANK — `<process.file>` → `<fn>` → block count, LIVE and
 * SHRINK-ONLY. Emptied 2026-11-26 when the release was re-vendored from the v7
 * master (every calculation block in the `.ts` / `engine:'ts'` shape).
 */
const SHIPPED_PHP_ERA: Readonly<Record<string, Readonly<Record<string, number>>>> = {};

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

/** The block's `process` object ({} when absent). */
function processOf(entry: CalculationBlock): Record<string, unknown> {
	const block = isPlainObject(entry.block) ? entry.block : {};
	return isPlainObject(block.process) ? block.process : {};
}

/** The dispatch verdict of one process block: null when it resolves, else the refusal message. */
function dispatchProblem(process: Record<string, unknown>, key: number): string | null {
	try {
		resolveCalculationFn(process, { ipo_key: key });
		return null;
	} catch (error) {
		if (error instanceof DedaloError && error.code === 'ontology.invalid_node') {
			return error.message;
		}
		throw error;
	}
}

/** Every reason one block is not runnable ([] = runnable) — dispatch + scope + inputs. */
function judgeBlock(
	entry: CalculationBlock,
	modelOf: (tipo: string) => string | null,
	process: Record<string, unknown> = processOf(entry),
): string[] {
	const at = `${entry.tipo} ipo[${entry.key}]`;
	const problems: string[] = [];
	const dispatch = dispatchProblem(process, entry.key);
	if (dispatch !== null) problems.push(`${at}: ${dispatch}`);
	const block = isPlainObject(entry.block) ? entry.block : {};
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

/** A php-era process block: `.php` file or a non-ts engine. */
function isPhpEra(process: Record<string, unknown>): boolean {
	return (
		(typeof process.file === 'string' && process.file.endsWith('.php')) ||
		process.engine !== CALCULATION_ENGINE
	);
}

/** file → fn → count over the php-era blocks of a corpus. */
function phpEraHistogram(
	blocks: readonly CalculationBlock[],
): Record<string, Record<string, number>> {
	const histogram: Record<string, Record<string, number>> = {};
	for (const entry of blocks) {
		const process = processOf(entry);
		if (!isPhpEra(process)) continue;
		const file = String(process.file);
		const fn = String(process.fn);
		histogram[file] ??= {};
		histogram[file][fn] = (histogram[file][fn] ?? 0) + 1;
	}
	return histogram;
}

/** Every fn name the engine registers: generic ∪ every package module. */
function registeredFnNames(): string[] {
	const names = new Set(Object.keys(CALCULATION_FUNCTIONS));
	for (const pkg of TLD_PACKAGES.values()) {
		for (const fns of Object.values(pkg.calculationModules)) {
			for (const name of Object.keys(fns)) names.add(name);
		}
	}
	return [...names].sort();
}

const PACKAGE_BLOCKS = calculationBlocks(PACKAGE_NODES);
const TEST_BLOCKS = calculationBlocks(TEST_NODES);

describe('calculation fn registry tripwire', () => {
	test('anti-vacuity: the blocks are found and every registered formula is exercised', () => {
		expect(PACKAGE_NODES.length, 'shipped ontology nodes').toBeGreaterThan(10000);
		expect(PACKAGE_BLOCKS.length, 'shipped calculation blocks').toBeGreaterThanOrEqual(22);
		expect(TEST_BLOCKS.length, 'suite twin calculation blocks').toBeGreaterThanOrEqual(22);
		const seen = new Set(
			[...PACKAGE_BLOCKS, ...TEST_BLOCKS].map((entry) => String(processOf(entry).fn)),
		);
		expect([...seen].sort()).toEqual(registeredFnNames());
		expect(registeredFnNames()).toHaveLength(9);
	});

	test('positive control: an unknown fn, a php engine, an aggregate scope and filter ARE reported', () => {
		const problems = judgeBlock(
			{
				tipo: 'synthetic',
				key: 0,
				block: {
					input: { section_id: 'all', filter: true, components: [] },
					process: { fn: 'nope', file: '/calculation/formulas.ts', engine: 'php' },
				},
			},
			() => null,
		);
		expect(problems).toHaveLength(3);
		expect(problems[0]).toContain("process.engine 'php'");
		// The same block with a ts engine is refused for the fn, not the engine.
		const tsProblems = judgeBlock(
			{ tipo: 'synthetic', key: 0, block: { input: { section_id: 'current' } } },
			() => null,
			{ fn: 'nope', file: '/calculation/formulas.ts', engine: 'ts' },
		);
		expect(tsProblems).toEqual([
			"synthetic ipo[0]: calculation ipo[0]: process fn 'nope' is not registered in '/calculation/formulas.ts'",
		]);
	});

	test('every suite twin calculation block is runnable through the full dispatch', () => {
		const modelOf = modelResolver(TEST_NODES);
		expect(TEST_BLOCKS.flatMap((entry) => judgeBlock(entry, modelOf))).toEqual([]);
	});

	test('SHIPPED leg B: every block that is NOT php-era is runnable as-is', () => {
		const modelOf = modelResolver(PACKAGE_NODES);
		const tsEra = PACKAGE_BLOCKS.filter((entry) => !isPhpEra(processOf(entry)));
		expect(tsEra.flatMap((entry) => judgeBlock(entry, modelOf))).toEqual([]);
		expect(tsEra.length + PACKAGE_BLOCKS.filter((entry) => isPhpEra(processOf(entry))).length).toBe(
			PACKAGE_BLOCKS.length,
		);
	});

	test('SHIPPED leg C: the php-era bank is LIVE and EXACT — a new php-era block or a stale entry is red', () => {
		expect(phpEraHistogram(PACKAGE_BLOCKS)).toEqual(SHIPPED_PHP_ERA);
		// And the bank pins the mdcat / generic split: every banked file is a dispatch key once `.ts`.
		for (const file of Object.keys(SHIPPED_PHP_ERA)) {
			const tsFile = file.replace(/\.php$/, '.ts');
			for (const fn of Object.keys(SHIPPED_PHP_ERA[file] as object)) {
				expect(
					dispatchProblem({ fn, file: tsFile, engine: CALCULATION_ENGINE }, 0),
					`${tsFile} ${fn}`,
				).toBeNull();
			}
		}
	});

	test('the suite twins carry NO php-era block (flipped at clone time, owner 2026-11-13)', () => {
		expect(phpEraHistogram(TEST_BLOCKS)).toEqual({});
	});
});
