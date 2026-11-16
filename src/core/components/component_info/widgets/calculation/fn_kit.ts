/**
 * calculation FN KIT — the types and the pure primitives every calculation
 * process function is built from, shared by the GENERIC registry
 * (./functions.ts, `/calculation/formulas.ts`) and the TLD packages
 * (src/tld/<tld>/calculation.ts). It imports kernel-side helpers only, so a
 * TLD package depends on core through this one surface and closes no cycle.
 *
 * The primitives are PHP's effective arithmetic over the TYPED inputs of
 * components/calculation_data.ts: `array_sum` (arraySum), `reset()`
 * (firstValue / firstNumber), `empty()` (isPhpEmpty), `round()` (phpRound). A
 * value a formula SUMS must be a list — a non-empty scalar there is a
 * definition error and refuses (ontology.invalid_node) instead of PHP's
 * TypeError.
 * WC-2026-11-12-calculation-widget-port, WC-2026-11-13-calculation-tld-packages.
 */

import { DedaloError } from '../../../../errors/dedalo_error.ts';
import { finiteNumber } from '../../../calculation_data.ts';
import { phpRound } from '../widget_common.ts';

export { phpRound };

export interface CalculationFnArgs {
	/** var_name → the input's calculation data (components/calculation_data.ts). */
	dataMap: Record<string, unknown>;
	/** The ipo `process.options` block. */
	options: Record<string, unknown>;
	/** The section whose record is being computed (PHP arg caller_section_tipo). */
	callerSectionTipo: string;
}

/**
 * A formula's output value: DATA, never markup — a number, a date's numeric
 * parts (summarize type date), or null (no value). The client renders it as
 * TEXT (render_calculation.js); this type keeps a future formula from handing
 * it a string (T1-18).
 */
export type CalculationValue = number | Readonly<Record<string, number>> | null;

/** One formula output item: the widget output id and its value. */
export interface CalculationOutput {
	id: string;
	value: CalculationValue;
}

/**
 * A registered calculation process function.
 *
 * AN EMPTY ARRAY IS A DELIBERATE "NO VALUE COMPUTED": the widget then emits
 * NO item for the block's declared outputs — the component renders empty,
 * nothing is faked (e.g. a grant import over zero days, A2 ruling 2026-11-13;
 * PHP's `calculate_period` used the same shape for "nothing to say"). It is
 * NEVER an error signal: a definition or input problem THROWS a DedaloError
 * (ontology.invalid_node), and an fn the ontology names but the registries do
 * not hold is refused BEFORE any fn runs (src/tld/registry.ts
 * resolveCalculationFn). A `[]` therefore only ever comes from a registered fn
 * that chose to say nothing.
 */
export type CalculationFn = (args: CalculationFnArgs) => CalculationOutput[];

export function isPlainObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** The scalars PHP empty() treats as empty (an object is never empty; [] is checked apart). */
const EMPTY_SCALARS: ReadonlySet<unknown> = new Set([undefined, null, false, 0, '', '0']);

/** No value at all: absent, null or the facet's false. */
export const NO_VALUE: ReadonlySet<unknown> = new Set([undefined, null, false]);

/** PHP empty(). */
export function isPhpEmpty(value: unknown): boolean {
	return EMPTY_SCALARS.has(value) || (Array.isArray(value) && value.length === 0);
}

/** Refuse an input that is not what the formula's definition requires (names the var). */
export function refuseInput(fn: string, varName: string, what: string): never {
	throw new DedaloError('ontology.invalid_node', {
		message: `calculation fn '${fn}': input '${varName}' is not ${what}`,
		coordinates: { fn, var_name: varName },
	});
}

/**
 * PHP array_sum over an input: numbers and numeric strings add, anything else
 * (objects, locators) is skipped; absent / null / false sum to 0. A non-empty
 * SCALAR is a definition error (PHP TypeError) — refused, naming the var.
 */
export function arraySum(value: unknown, varName: string, fn: string): number {
	if (NO_VALUE.has(value)) return 0;
	if (!Array.isArray(value)) refuseInput(fn, varName, 'a list of values');
	return value.reduce<number>((sum, element) => sum + (finiteNumber(element) ?? 0), 0);
}

/** PHP reset(): the first element of a list (false when empty), a scalar as itself. */
export function firstValue(value: unknown): unknown {
	if (!Array.isArray(value)) return value;
	return value.length > 0 ? value[0] : false;
}

/** A first element as a number (PHP (float), is_object → ->value). */
export function firstNumber(value: unknown): number {
	const first = firstValue(value);
	return finiteNumber(isPlainObject(first) ? first.value : first) ?? 0;
}

/** A scalar input (a timestamp) as a number; no value → 0. */
export function scalarNumber(value: unknown, varName: string, fn: string): number {
	if (NO_VALUE.has(value)) return 0;
	return finiteNumber(value) ?? refuseInput(fn, varName, 'a number');
}

/** The one-output shape most formulas emit: `[{id:'total', value}]`. */
export function total(value: CalculationValue): CalculationOutput[] {
	return [{ id: 'total', value }];
}
