/**
 * calculation widget (PHP core/widgets/calculation, class.calculation.php).
 *
 * The generic calculation engine, per ipo block: resolve each declared input
 * component to its calculation data (components/calculation_data.ts — the
 * descriptor facet `calculationData`, PHP per-model get_calculation_data, with
 * the input's own `options`), run the formula the block's `process` names
 * and emit one {widget, key, id, value} item per output id the formula
 * produced. A formula answering `[]` emits no item — a registered fn's
 * deliberate "no value" (fn_kit.ts CalculationFn), never an error path.
 *
 * Dispatch (src/tld/registry.ts resolveCalculationFn — the ONE core→tld
 * import): `process.file` is a LOOKUP KEY matched against frozen tables, never
 * a path (the TS answer to PHP SEC-052 dynamic includes). `/calculation/
 * formulas.ts` → the generic registry (./functions.ts); `/<tld>/calculation/
 * <module>.ts` → that TLD package's module. `process.engine` must be `'ts'`.
 *
 * Input scopes (PHP resolve_data): section_id 'current' — or absent, a
 * standing TS reading — iterates the components; a literal id resolves NO
 * components (PHP default branch). The 'all' / 'search_session' aggregate
 * scopes and `filter: true` SQO inputs are not implemented: they REFUSE
 * (engine.uncovered_scope) — the calculation_fn_registry_tripwire proves the
 * shipped ontology declares none.
 *
 * Refusals (ontology.invalid_node, never a silently blank value): a block
 * without `process.fn` (PHP reused the previous block's result), a PHP-era
 * block (`.php` file / `engine:'php'` — no alias; the ontology must be
 * updated), an unknown package / module, an fn the selected table does not
 * hold (a TLD fn under the generic file, or the reverse), an input without
 * tipo / var_name.
 * WC-2026-11-12-calculation-widget-port, WC-2026-11-13-calculation-tld-packages.
 */

import { resolveCalculationFn } from '../../../../../tld/registry.ts';
import { DedaloError } from '../../../../errors/dedalo_error.ts';
import { calculationDataOf } from '../../../calculation_data.ts';
import {
	type InfoWidgetDescriptor,
	resolveCurrent,
	type WidgetContext,
	type WidgetItem,
} from '../widget_common.ts';

/** One ipo block as the ontology declares it. */
interface CalculationBlock {
	input?: {
		section_tipo?: string;
		/** Ontology-authored scope: 'current' / 'all' / 'search_session' or a literal id. */
		section_id?: unknown;
		filter?: unknown;
		components?: unknown[];
	};
	/** Ontology-authored dispatch key + options — judged by resolveCalculationFn. */
	process?: { fn?: unknown; file?: unknown; engine?: unknown; options?: unknown };
	output?: { id?: string }[];
}

/** Aggregate scopes PHP implemented over search sessions / whole sections. */
const AGGREGATE_SCOPES: ReadonlySet<string> = new Set(['all', 'search_session']);

/** Refuse the not-implemented scopes: 'all' / 'search_session' aggregates, filter:true. */
function assertImplementedScope(input: NonNullable<CalculationBlock['input']>, key: number): void {
	const scope = input.section_id;
	const aggregate = typeof scope === 'string' && AGGREGATE_SCOPES.has(scope);
	if (!aggregate && input.filter !== true) return;
	throw new DedaloError('engine.uncovered_scope', {
		message: `calculation ipo[${key}]: input scope '${scope}' (filter ${input.filter}) is not implemented`,
		coordinates: { ipo_key: key, scope: `${scope}` },
	});
}

/** One declared input component, refused when it names no tipo / var_name. */
function inputComponent(
	component: unknown,
	key: number,
): { tipo: string; var_name: string; options: unknown } {
	const entry = component as { tipo?: unknown; var_name?: unknown; options?: unknown } | null;
	if (typeof entry?.tipo !== 'string' || typeof entry.var_name !== 'string') {
		throw new DedaloError('ontology.invalid_node', {
			message: `calculation ipo[${key}]: an input component lacks tipo / var_name`,
			coordinates: { ipo_key: key },
		});
	}
	return { tipo: entry.tipo, var_name: entry.var_name, options: entry.options ?? null };
}

/** var_name → calculation data of every input (PHP resolve_data). */
async function resolveInputs(
	block: CalculationBlock,
	key: number,
	context: WidgetContext,
): Promise<Record<string, unknown>> {
	const input = block.input ?? {};
	assertImplementedScope(input, key);
	const dataMap: Record<string, unknown> = {};
	// A literal id resolves no components (PHP default branch); absent = current.
	const scope = input.section_id;
	if (scope !== 'current' && scope !== undefined) return dataMap;
	const sectionTipo = String(resolveCurrent(input.section_tipo, context.sectionTipo));
	for (const component of input.components ?? []) {
		const { tipo, var_name, options } = inputComponent(component, key);
		dataMap[var_name] = await calculationDataOf(
			tipo,
			sectionTipo,
			context.sectionId,
			options,
			context,
		);
	}
	return dataMap;
}

/** The block's `process.options` as an object ({} when absent or not an object). */
function processOptions(block: CalculationBlock): Record<string, unknown> {
	const options = block.process?.options;
	return options !== null && typeof options === 'object' && !Array.isArray(options)
		? (options as Record<string, unknown>)
		: {};
}

/** One {widget, key, id, value} item per declared output the formula produced. */
function outputItems(
	block: CalculationBlock,
	key: number,
	result: { id: string; value: unknown }[],
): WidgetItem[] {
	const items: WidgetItem[] = [];
	for (const outputMap of Array.isArray(block.output) ? block.output : []) {
		const id = outputMap.id ?? '';
		const found = result.find((item) => item.id === id);
		if (found !== undefined) items.push({ widget: 'calculation', key, id, value: found.value });
	}
	return items;
}

async function computeCalculation(ipo: unknown[], context: WidgetContext): Promise<WidgetItem[]> {
	const data: WidgetItem[] = [];
	for (const [key, entry] of ipo.entries()) {
		const block = (entry ?? {}) as CalculationBlock;
		// The fn the block names, through the one dispatcher — or a loud refusal.
		const fn = resolveCalculationFn(block.process ?? {}, { ipo_key: key });
		const dataMap = await resolveInputs(block, key, context);
		const result = fn({
			dataMap,
			options: processOptions(block),
			callerSectionTipo: context.sectionTipo,
		});
		data.push(...outputItems(block, key, result));
	}
	return data;
}

export const calculation: InfoWidgetDescriptor = {
	name: 'calculation',
	path: '/calculation',
	computeData: computeCalculation,
};
