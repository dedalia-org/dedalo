/**
 * GENERIC calculation PROCESS FUNCTION registry — the fns the ontology files
 * under `/calculation/formulas.ts` (PHP core/widgets/calculation/formulas.php).
 *
 * TS NEVER loads code from ontology-authored paths (PHP SEC-052 loaded
 * `process.file` under DEDALO_WIDGETS_PATH). Since 2026-11-13 the ontology's
 * `process.file` is the DISPATCH KEY, matched against frozen tables, never a
 * path: `/calculation/formulas.ts` selects THIS table; `/<tld>/calculation/
 * <module>.ts` selects a TLD package's module (src/tld/<tld>/, through the one
 * registry src/tld/registry.ts). `process.engine` must be `'ts'`. A PHP-era
 * block (`.php` file, `engine:'php'`), an unknown package / module / fn, or a
 * generic file naming a TLD fn (and vice versa) is REFUSED loudly
 * (ontology.invalid_node) by `resolveCalculationFn` — never an alias, never a
 * silent `[]`. The tripwire test/unit/calculation_fn_registry_tripwire.test.ts
 * judges every shipped and suite block through that dispatch.
 *
 * What lives here: `summarize` only — int / float: Σ of every non-empty input
 * (owner ruling 2026-11-11 — PHP crashed on any non-empty input); date: Σ
 * timestamps + periods, projected to the merged shape (formulas.php:114-227).
 * Every other shipped fn is declared under `/mdcat/calculation/mdcat.*` and
 * lives in src/tld/mdcat/calculation.ts (ruling Q3 2026-11-13: an fn whose
 * ontology file is under a TLD is that TLD's scope). A TLD package may NOT
 * re-export a generic name (engine_install_tld_tripwire leg 4 + the registry's
 * load-time assertion).
 * WC-2026-11-12-calculation-widget-port, WC-2026-11-13-calculation-tld-packages.
 */

import {
	type DdDate,
	ddDateFromUnixSeconds,
	ddDateToUnixSeconds,
} from '../../../../concepts/dd_date_time.ts';
import {
	arraySum,
	type CalculationFn,
	type CalculationOutput,
	isPhpEmpty,
	isPlainObject,
	phpRound,
	refuseInput,
	total,
} from './fn_kit.ts';

export type {
	CalculationFn,
	CalculationFnArgs,
	CalculationOutput,
	CalculationValue,
} from './fn_kit.ts';

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

/** The generic table: what `/calculation/formulas.ts` resolves. */
export const CALCULATION_FUNCTIONS: Readonly<Record<string, CalculationFn>> = {
	summarize({ dataMap, options }) {
		if (options.type === 'date') return summarizeDate(dataMap);
		let sum = 0;
		for (const [varName, value] of Object.entries(dataMap)) {
			if (!isPhpEmpty(value)) sum += arraySum(value, varName, 'summarize');
		}
		return total(phpRound(sum, summarizePrecision(options)));
	},
};
