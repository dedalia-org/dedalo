/**
 * calculation PROCESS FUNCTION registry — the TS answer to PHP SEC-052.
 *
 * PHP's calculation widget loads external fn files declared in the ontology
 * (`process: {engine:'php', file, fn, options}` → include under
 * DEDALO_WIDGETS_PATH with realpath confinement + fn-name regex +
 * ReflectionFunction file check). TS NEVER loads code from ontology-authored
 * paths: every process function is a STATIC registry entry here; `file` and
 * `engine` keys are ignored (verification data only). An fn not registered
 * here is refused by the widget (ontology.invalid_node) — the tripwire
 * test/unit/calculation_fn_registry_tripwire.test.ts proves every shipped one
 * is registered.
 *
 * The nine functions the shipped ontology declares (PHP core/widgets/
 * calculation/formulas.php and core/widgets/mdcat/calculation/mdcat.php),
 * ported over the TYPED inputs of components/calculation_data.ts:
 *  - summarize          int / float: Σ of every non-empty input (owner ruling
 *                       2026-11-11 — PHP crashed on any non-empty input);
 *                       date: Σ timestamps + periods, projected to the
 *                       merged shape (formulas.php:114-227).
 *  - calculate_period   days → years / months / days buckets (30.42-day months).
 *  - calculate_import_major / _minor  grant amounts by months (verbatim
 *                       constants, including the 30.42 vs 30.4 asymmetry).
 *  - to_euros           pesetas → euros (166.386).
 *  - range_to_days      date range → days (minimum 1).
 *  - days_correction_manually  the manual day count wins when set.
 *  - subtract           total − total_period.
 *  - final_total        manual / major / minor amount − paid.
 *
 * Every value a formula SUMS must be an array (PHP array_sum): a non-empty
 * scalar there is a definition error and refuses (ontology.invalid_node)
 * instead of PHP's TypeError. Two branches wait on owner decisions and refuse
 * loudly until ruled (engine.uncovered_scope): a grant import with no day
 * value at all (OD-2 — a summarized 0 runs the formula, as in PHP) and
 * final_total's major-grant caller (OD-1).
 * WC-2026-11-12-calculation-widget-port.
 */

import {
	type DdDate,
	ddDateFromUnixSeconds,
	ddDateToUnixSeconds,
} from '../../../../concepts/dd_date_time.ts';
import { DedaloError } from '../../../../errors/dedalo_error.ts';
import { finiteNumber } from '../../../calculation_data.ts';
import { phpRound } from '../widget_common.ts';

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

export type CalculationFn = (args: CalculationFnArgs) => CalculationOutput[];

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** The scalars PHP empty() treats as empty (an object is never empty; [] is checked apart). */
const EMPTY_SCALARS: ReadonlySet<unknown> = new Set([undefined, null, false, 0, '', '0']);

/** No value at all: absent, null or the facet's false. */
const NO_VALUE: ReadonlySet<unknown> = new Set([undefined, null, false]);

/** PHP empty(). */
function isPhpEmpty(value: unknown): boolean {
	return EMPTY_SCALARS.has(value) || (Array.isArray(value) && value.length === 0);
}

function refuseInput(fn: string, varName: string, what: string): never {
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
function arraySum(value: unknown, varName: string, fn: string): number {
	if (NO_VALUE.has(value)) return 0;
	if (!Array.isArray(value)) refuseInput(fn, varName, 'a list of values');
	return value.reduce<number>((sum, element) => sum + (finiteNumber(element) ?? 0), 0);
}

/** PHP reset(): the first element of a list (false when empty), a scalar as itself. */
function firstValue(value: unknown): unknown {
	if (!Array.isArray(value)) return value;
	return value.length > 0 ? value[0] : false;
}

/** A first element as a number (PHP (float), is_object → ->value). */
function firstNumber(value: unknown): number {
	const first = firstValue(value);
	return finiteNumber(isPlainObject(first) ? first.value : first) ?? 0;
}

/** A scalar input (a timestamp) as a number; no value → 0. */
function scalarNumber(value: unknown, varName: string, fn: string): number {
	if (NO_VALUE.has(value)) return 0;
	return finiteNumber(value) ?? refuseInput(fn, varName, 'a number');
}

function total(value: CalculationValue): CalculationOutput[] {
	return [{ id: 'total', value }];
}

/**
 * OD-2 (owner decision, unruled), narrowed to the case PHP really crashed on:
 * a grant import with NO day value at all (absent / null / an empty list).
 * PHP's `array_sum` gives int 0 there, `=== 0` holds, the scalar 0 is returned
 * where a list was expected and the read crashes. A day LIST that sums to zero
 * is not that case: the shipped chain feeds the summarize output, whose PHP
 * round() is a float, so `0.0 === 0` was false and the formula served its
 * minimum — the record read never failed (T1-1 review). Whether the no-value
 * case serves no output, `total 0` or the formula minimum is the owner's call;
 * until then it refuses, loudly.
 */
function refuseZeroDayImport(fn: string): never {
	throw new DedaloError('engine.uncovered_scope', {
		message: `calculation fn '${fn}': total_days is 0 — the zero-day grant import is an open owner decision (OD-2, WC-2026-11-12-calculation-widget-port)`,
		coordinates: { fn },
	});
}

/** The grant months of a day count (verbatim PHP: 30.42-day months, 30.4 remainder). */
function grantMonths(totalDays: number): number {
	const totalMonths = Math.floor(totalDays / 30.42);
	const days = Math.floor(totalDays - totalMonths * 30.4);
	return days > 0 ? totalMonths + 1 : totalMonths;
}

function grantImport(
	dataMap: Record<string, unknown>,
	fn: string,
	rates: { base: number; perMonth: number; cap: number },
): CalculationOutput[] {
	if (isPhpEmpty(dataMap.total_days)) refuseZeroDayImport(fn);
	const totalDays = arraySum(dataMap.total_days, 'total_days', fn);
	const months = grantMonths(totalDays);
	const amount = months <= 6 ? rates.base : (months - 6) * rates.perMonth + rates.base;
	return total(Math.min(amount, rates.cap));
}

/** The install section PHP hard-codes as final_total's major-grant caller (mdcat.php:702). */
export const PHP_MAJOR_GRANT_SECTION = 'mdcat2605';

/**
 * OD-1 (owner decision, unruled): which caller sections take final_total's
 * MAJOR-grant branch. PHP hard-codes one install section (`mdcat2605`); the
 * alternatives are an ontology option (`major_section_tipos`) or both. Every
 * caller the options AGREE on (any other section, no option) takes the minor
 * branch; the contested ones refuse until ruled — never a guessed amount.
 */
function isMajorCaller(callerSectionTipo: string, options: Record<string, unknown>): boolean {
	if (callerSectionTipo === PHP_MAJOR_GRANT_SECTION || options.major_section_tipos !== undefined) {
		throw new DedaloError('engine.uncovered_scope', {
			message: `calculation fn 'final_total': the major-grant branch for '${callerSectionTipo}' is an open owner decision (OD-1, WC-2026-11-12-calculation-widget-port)`,
			coordinates: { fn: 'final_total', section_tipo: callerSectionTipo },
		});
	}
	return false;
}

/** The numeric date fields of a dd_date value. */
function dateFields(value: Record<string, unknown>): DdDate {
	const date: DdDate = {};
	for (const key of ['year', 'month', 'day'] as const) {
		if (typeof value[key] === 'number') date[key] = value[key];
	}
	return date;
}

/** A period added to an instant: day, then month, then year (PHP DateTime overflow = JS overflow). */
function addPeriod(seconds: number, period: DdDate): number {
	const moment = new Date(seconds * 1000);
	moment.setUTCDate(moment.getUTCDate() + (period.day ?? 0));
	moment.setUTCMonth(moment.getUTCMonth() + (period.month ?? 0));
	moment.setUTCFullYear(moment.getUTCFullYear() + (period.year ?? 0));
	return Math.floor(moment.getTime() / 1000);
}

/** The running state of a date summarize. */
interface DateSum {
	/** Which parts any specific date carried (a part present anywhere stays present). */
	shape: { year: boolean; month: boolean; day: boolean };
	values: number[];
}

/** Fold one non-empty date input into the running sum (formulas.php:114-227). */
function foldDate(sum: DateSum, varName: string, value: unknown): void {
	if (!isPlainObject(value)) {
		refuseInput('summarize', varName, "a date (set the input's options.format 'dd_date')");
	}
	const date = dateFields(value);
	if (value.format === 'period') {
		// A period needs an anchor date: skipped until one is seen.
		if (sum.values.length > 0) sum.values = [addPeriod(secondsSum(sum.values), date)];
		return;
	}
	sum.shape.year ||= date.year !== undefined;
	sum.shape.month ||= date.month !== undefined;
	sum.shape.day ||= date.day !== undefined;
	sum.values.push(ddDateToUnixSeconds(date));
}

function secondsSum(values: readonly number[]): number {
	return values.reduce((sum, item) => sum + item, 0);
}

/** summarize type date: Σ instants + periods, projected to the merged shape; none → null. */
function summarizeDate(dataMap: Record<string, unknown>): CalculationOutput[] {
	const sum: DateSum = { shape: { year: false, month: false, day: false }, values: [] };
	for (const [varName, value] of Object.entries(dataMap)) {
		if (!isPhpEmpty(value)) foldDate(sum, varName, value);
	}
	if (sum.values.length === 0) return total(null);
	const full = ddDateFromUnixSeconds(secondsSum(sum.values));
	const date: Record<string, number> = {};
	for (const key of ['year', 'month', 'day'] as const) {
		if (sum.shape[key]) date[key] = full[key];
	}
	return total(date);
}

/** summarize int / float rounding: float → options.precision (default 2), int → 0. */
function summarizePrecision(options: Record<string, unknown>): number {
	if (options.type !== 'float') return 0;
	return typeof options.precision === 'number' ? options.precision : 2;
}

/** calculate_period buckets (mdcat.php:69-136): 365-day years, 30.42-day months. */
function periodBuckets(totalDays: number, options: Record<string, unknown>) {
	const years = Math.floor(totalDays / 365);
	const yearsDays = totalDays - years * 365;
	const months = Math.floor(yearsDays / 30.42);
	const asTotal = options.total === true;
	return [
		{ flag: 'years', count: years, item: { id: 'years', value: years } },
		{
			flag: 'months',
			count: months,
			item: asTotal
				? { id: 'total_months', value: Math.floor(totalDays / 30.42) }
				: { id: 'months', value: months },
		},
		{
			flag: 'days',
			count: Math.floor(yearsDays - months * 30.42),
			item: asTotal
				? { id: 'total_days', value: totalDays }
				: { id: 'days', value: Math.floor(yearsDays - months * 30.42) },
		},
	];
}

export const CALCULATION_FUNCTIONS: Readonly<Record<string, CalculationFn>> = {
	summarize({ dataMap, options }) {
		if (options.type === 'date') return summarizeDate(dataMap);
		let sum = 0;
		for (const [varName, value] of Object.entries(dataMap)) {
			if (!isPhpEmpty(value)) sum += arraySum(value, varName, 'summarize');
		}
		return total(phpRound(sum, summarizePrecision(options)));
	},

	calculate_period({ dataMap, options }) {
		const totalDays = Array.isArray(dataMap.total_days)
			? arraySum(dataMap.total_days, 'total_days', 'calculate_period')
			: 0;
		return periodBuckets(totalDays, options)
			.filter((bucket) => bucket.count > 0 && options[bucket.flag] === true)
			.map((bucket) => bucket.item);
	},

	calculate_import_major({ dataMap }) {
		return grantImport(dataMap, 'calculate_import_major', {
			base: 150000,
			perMonth: 28000,
			cap: 1000000,
		});
	},

	calculate_import_minor({ dataMap }) {
		return grantImport(dataMap, 'calculate_import_minor', { base: 900, perMonth: 170, cap: 6010 });
	},

	to_euros({ dataMap }) {
		const number = arraySum(dataMap.number, 'number', 'to_euros');
		return total(number !== 0 ? phpRound(number / 166.386, 2) : 0);
	},

	range_to_days({ dataMap }) {
		const start = scalarNumber(dataMap.start, 'start', 'range_to_days');
		const time = NO_VALUE.has(dataMap.end)
			? 0
			: phpRound(scalarNumber(dataMap.end, 'end', 'range_to_days') - start, 0);
		return total(time <= 0 ? 1 : phpRound(time / 86400, 0));
	},

	days_correction_manually({ dataMap }) {
		const fn = 'days_correction_manually';
		const manual = Array.isArray(dataMap.manual_day)
			? arraySum(dataMap.manual_day, 'manual_day', fn)
			: scalarNumber(dataMap.manual_day, 'manual_day', fn);
		return total(manual !== 0 ? manual : arraySum(dataMap.calculation_day, 'calculation_day', fn));
	},

	subtract({ dataMap }) {
		return total(phpRound(firstNumber(dataMap.total) - firstNumber(dataMap.total_period), 2));
	},

	final_total({ dataMap, options, callerSectionTipo }) {
		const paid = arraySum(dataMap.paid, 'paid', 'final_total');
		const importManual = arraySum(dataMap.import_manual, 'import_manual', 'final_total');
		if (importManual !== 0) return total(phpRound(importManual - paid, 2));
		const totalMajor = firstNumber(dataMap.total_major);
		const amount =
			totalMajor > 0 && isMajorCaller(callerSectionTipo, options)
				? totalMajor
				: firstNumber(dataMap.total_minor);
		return total(phpRound(amount - paid, 2));
	},
};
