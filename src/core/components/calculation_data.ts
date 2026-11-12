/**
 * CALCULATION DATA — what each component model feeds into a `calculation`
 * widget formula (PHP per-model get_calculation_data; dispatch
 * class.calculation.php resolve_data). The descriptor names the facet
 * (`calculationData`, registry getCalculationDataId); this static map is its
 * implementation — no `if model === …` anywhere (the emit_hooks pattern).
 *
 *   number    the stored values as numbers (PHP base get_value() served the
 *             flat STRING, which crashed every array_sum — owner ruling
 *             2026-11-11: the real sum).
 *   date      PHP component_date::get_calculation_data: `select` (default
 *             start) of each item; `format:'dd_date'` → the first item's
 *             sub-object tagged `format` date|period; else Σ unix seconds
 *             (UTC midnight — PHP kept the server's current time of day).
 *             An item without `select` → false; no data → 0.
 *   info      the LIVE compute's `select` values (default value) — v6
 *             semantics (frozen v7 also prepended the whole widget items);
 *             an info value is never stored (WC-2026-09-03), so it is always
 *             computed here, never read.
 *   relation  PHP component_relation_common::get_calculation_data: each
 *             locator walks `options.ddo_map` (relations/component_data_walk.ts
 *             — the ONE walker); a `get_calculation_data` ddo feeds its
 *             facet, a plain leaf its item values (v6 dato parity; frozen v7
 *             summed the objects to 0). No locators → null.
 *
 * Refusals are loud (never-narrow law): a model without the facet
 * (engine.uncovered_scope), a relation input without a usable ddo_map, an
 * unknown ddo fn and a calculation cycle (ontology.invalid_node).
 *
 * Isolation: the cycle stack travels by argument (WidgetContext
 * calculationStack); record reads ride the read-scoped record memo.
 */

import { type DdDate, ddDateToUnixSeconds } from '../concepts/dd_date_time.ts';
import { memoizedReadMatrixRecord } from '../db/record_memo.ts';
import { DedaloError } from '../errors/dedalo_error.ts';
import { getMatrixTableFromTipo, getModelByTipo } from '../ontology/resolver.ts';
import {
	ddoFunctionName,
	elementAddress,
	readStoredComponentData,
	type WalkDdo,
	type WalkReader,
	walkComponentData,
} from '../relations/component_data_walk.ts';
import {
	readWidgetComponentData,
	type WidgetContext,
} from './component_info/widgets/widget_common.ts';
import { getCalculationDataId } from './registry.ts';
import type { CalculationDataId } from './types.ts';

/**
 * How deep chained calculation inputs may nest (an info fed by an info fed by
 * …). The deepest shipped chain is 5 (final_total → import_minor → portal sum
 * → days correction → range_to_days); 16 leaves room for an install's own
 * chains and stops a runaway definition long before the stack does.
 */
export const CALCULATION_MAX_DEPTH = 16;

/** The ddo fn a relation input may name (PHP resolve_component_data_recursively). */
export const CALCULATION_DDO_FUNCTIONS: ReadonlySet<string> = new Set(['get_calculation_data']);

export interface CalculationDataArgs {
	tipo: string;
	model: string;
	sectionTipo: string;
	sectionId: number | string;
	/** The input's own `options` (ipo input.components[].options, or the ddo's). */
	options: unknown;
	context: WidgetContext;
}

export type CalculationDataFn = (args: CalculationDataArgs) => Promise<unknown>;

/** A date sub-object handed to a formula (format tags how summarize treats it). */
export interface CalculationDdDate {
	year?: number;
	month?: number;
	day?: number;
	format: 'date' | 'period';
	[key: string]: unknown;
}

function invalidNode(message: string, coordinates: Record<string, string | number>): DedaloError {
	return new DedaloError('ontology.invalid_node', { message, coordinates });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** PHP isset() on a selected key: absent and null both count as not set. */
const NOT_SET: ReadonlySet<unknown> = new Set([undefined, null]);

/** PHP empty() for a scalar calculation value: these contribute nothing to a walk. */
const EMPTY_SCALARS: ReadonlySet<unknown> = new Set([undefined, null, false, 0]);

/** A string option of an input's `options`, or the fallback. */
function stringOption(options: unknown, key: string, fallback: string): string {
	const value = isPlainObject(options) ? options[key] : undefined;
	return typeof value === 'string' ? value : fallback;
}

/** A stored numeric value as a finite number (numeric strings accepted), else null. */
export function finiteNumber(value: unknown): number | null {
	const parsed =
		typeof value === 'number' || (typeof value === 'string' && value.trim() !== '')
			? Number(value)
			: Number.NaN;
	return Number.isFinite(parsed) ? parsed : null;
}

const numberData: CalculationDataFn = async ({ tipo, sectionTipo, sectionId }) => {
	const items = await readWidgetComponentData(sectionTipo, sectionId, tipo);
	return items
		.map((item) => finiteNumber((item as { value?: unknown } | null)?.value))
		.filter((value): value is number => value !== null);
};

/** The numeric date fields of a stored dd_date part. */
function dateFields(part: Record<string, unknown>): DdDate {
	const date: DdDate = {};
	for (const key of ['year', 'month', 'day'] as const) {
		if (typeof part[key] === 'number') date[key] = part[key];
	}
	return date;
}

/** Unix seconds of a stored date part; a part without a year has no instant (PHP crashed in setDate) → 0. */
function datePartSeconds(part: unknown): number {
	if (!isPlainObject(part) || typeof part.year !== 'number') return 0;
	return ddDateToUnixSeconds(dateFields(part));
}

/** A CLONE of the first item's part tagged for summarize (never the read item). */
function taggedDatePart(part: unknown, select: string): CalculationDdDate {
	return {
		...(isPlainObject(part) ? part : {}),
		format: select === 'period' ? 'period' : 'date',
	};
}

const dateData: CalculationDataFn = async ({ tipo, sectionTipo, sectionId, options }) => {
	const select = stringOption(options, 'select', 'start');
	const format = stringOption(options, 'format', 'unix_timestamp');
	const items = await readWidgetComponentData(sectionTipo, sectionId, tipo);
	const parts = items.map((item) => (isPlainObject(item) ? item[select] : undefined));
	// PHP: format dd_date answers the FIRST item's part (only one expected).
	if (format === 'dd_date' && parts.length > 0) {
		return NOT_SET.has(parts[0]) ? false : taggedDatePart(parts[0], select);
	}
	// PHP isset(): an item without the selected part answers false.
	if (parts.some((part) => NOT_SET.has(part))) return false;
	return parts.reduce<number>((total, part) => total + datePartSeconds(part), 0);
};

/** The stack one level down, refusing a cycle or a runaway depth. */
function enterCalculation(stack: readonly string[], key: string, tipo: string): string[] {
	const chain = [...stack, key].join(' → ');
	if (stack.includes(key)) {
		throw invalidNode(`calculation cycle: ${chain}`, { tipo, chain });
	}
	if (stack.length >= CALCULATION_MAX_DEPTH) {
		throw invalidNode(`calculation inputs nest deeper than ${CALCULATION_MAX_DEPTH}: ${chain}`, {
			tipo,
			depth: stack.length + 1,
		});
	}
	return [...stack, key];
}

const infoData: CalculationDataFn = async ({ tipo, sectionTipo, sectionId, options, context }) => {
	const select = stringOption(options, 'select', 'value');
	const calculationStack = enterCalculation(
		context.calculationStack ?? [],
		`${tipo}@${sectionTipo}/${sectionId}`,
		tipo,
	);
	const { computeInfoWidgets } = await import('./component_info/widgets/registry.ts');
	const items =
		(await computeInfoWidgets(tipo, { ...context, sectionTipo, sectionId, calculationStack })) ??
		[];
	// PHP isset(): present and not null.
	return items
		.map((item) => (isPlainObject(item) ? item[select] : undefined))
		.filter((value) => !NOT_SET.has(value));
};

/** A walked leaf element as a formula value: an item's `value`, a locator verbatim. */
function leafValue(element: unknown): unknown {
	if (isPlainObject(element) && 'value' in element && typeof element.section_tipo !== 'string') {
		return element.value;
	}
	return element;
}

/** A facet value as walk data: a list as is, an empty scalar as nothing, a scalar wrapped. */
function asWalkData(value: unknown): unknown[] {
	if (Array.isArray(value)) return value;
	return EMPTY_SCALARS.has(value) ? [] : [value];
}

/** The calculation read policy for the shared walker (see the module header). */
function calculationReader(context: WidgetContext): WalkReader {
	return async (ddo, address) => {
		const fn = ddoFunctionName(ddo);
		if (fn === undefined) return readStoredComponentData(ddo.tipo, address);
		if (!CALCULATION_DDO_FUNCTIONS.has(fn)) {
			throw invalidNode(`calculation ddo_map: unknown fn '${fn}' on ${ddo.tipo}`, {
				tipo: ddo.tipo,
				fn,
			});
		}
		return asWalkData(
			await calculationDataOf(
				ddo.tipo,
				address.section_tipo,
				address.section_id,
				ddo.options ?? null,
				context,
			),
		);
	};
}

/** A relation input's ddo_map + its anchor ddo — refused when unusable (PHP crashed / returned false). */
function relationWalkMap(
	options: unknown,
	tipo: string,
	sectionTipo: string,
): { map: WalkDdo[]; start: WalkDdo; leaf: WalkDdo | undefined } {
	const ddoMap = isPlainObject(options) ? options.ddo_map : undefined;
	if (!Array.isArray(ddoMap) || ddoMap.length === 0) {
		throw invalidNode(`calculation relation input ${tipo} declares no options.ddo_map`, { tipo });
	}
	const map = ddoMap as WalkDdo[];
	const start = map.find((ddo) => ddo?.parent === 'self' || ddo?.parent === sectionTipo);
	if (start === undefined) {
		throw invalidNode(`calculation relation input ${tipo}: no ddo_map entry anchored to 'self'`, {
			tipo,
		});
	}
	// The leaf: the first ddo naming the LAST ddo's tipo (PHP marked it `last`).
	const lastTipo = map.at(-1)?.tipo;
	return { map, start, leaf: map.find((ddo) => ddo?.tipo === lastTipo) };
}

/** The locators a relation component holds on one record (computed families included). */
async function relationLocators(
	tipo: string,
	model: string,
	sectionTipo: string,
	sectionId: number | string,
): Promise<unknown[]> {
	const table = await getMatrixTableFromTipo(sectionTipo);
	const record =
		table === null ? null : await memoizedReadMatrixRecord(table, sectionTipo, Number(sectionId));
	if (record === null) return [];
	const { componentLocators } = await import('../relations/locator_source.ts');
	return componentLocators(
		{ sectionTipo, sectionId, columns: record.columns as Record<string, unknown> },
		tipo,
		model,
	);
}

const relationData: CalculationDataFn = async (args) => {
	const { map, start, leaf } = relationWalkMap(args.options, args.tipo, args.sectionTipo);
	const locators = await relationLocators(args.tipo, args.model, args.sectionTipo, args.sectionId);
	// PHP: no data → false (summarize skips it).
	if (locators.length === 0) return null;
	const read = calculationReader(args.context);
	const values: unknown[] = [];
	for (const locator of locators) {
		const address = elementAddress(locator);
		if (address === null) continue;
		const data = await walkComponentData({ ddoMap: map, start, leaf, address, read });
		values.push(...data.map(leafValue));
	}
	return values;
};

/** The facet implementations, by descriptor id. */
export const CALCULATION_DATA: Readonly<Record<CalculationDataId, CalculationDataFn>> = {
	number: numberData,
	date: dateData,
	info: infoData,
	relation: relationData,
};

/**
 * The value `tipo` on (sectionTipo, sectionId) feeds a calculation — PHP
 * component_common::get_instance(…)->get_calculation_data($options).
 */
export async function calculationDataOf(
	tipo: string,
	sectionTipo: string,
	sectionId: number | string,
	options: unknown,
	context: WidgetContext,
): Promise<unknown> {
	const model = await getModelByTipo(tipo);
	if (model === null) {
		throw invalidNode(`calculation input ${tipo} has no ontology model`, { tipo });
	}
	const id = getCalculationDataId(model);
	if (id === undefined) {
		throw new DedaloError('engine.uncovered_scope', {
			message: `calculation input ${tipo}: model '${model}' cannot feed a calculation (no calculationData facet)`,
			coordinates: { tipo, model },
		});
	}
	return CALCULATION_DATA[id]({ tipo, model, sectionTipo, sectionId, options, context });
}
