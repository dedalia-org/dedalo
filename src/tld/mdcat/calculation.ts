/**
 * mdcat calculation module — the fns the mdcat ontology files under
 * `/mdcat/calculation/mdcat.ts` (PHP core/widgets/mdcat/calculation/mdcat.php,
 * ruling Q3 2026-11-13: an fn whose ontology file is under a TLD is that TLD's
 * scope, so `to_euros` and `calculate_period` live here, not in the generic
 * registry). Ported over the TYPED inputs of components/calculation_data.ts
 * with the shared kit (widgets/calculation/fn_kit.ts):
 *
 *  - calculate_period   days → years / months / days buckets (30.42-day months).
 *  - calculate_import_major / _minor  grant amounts by months (verbatim
 *                       constants, including the 30.42 vs 30.4 asymmetry).
 *                       A2 (ruling 2026-11-13): ZERO DAYS — no day value at
 *                       all (absent / null / []) or a day list summing to 0,
 *                       int or float — computes NO OUTPUT (`[]`). PHP meant
 *                       `total_days === 0 → return 0`: an int 0 crashed the
 *                       read, a float 0.0 slipped past `===` and served the
 *                       formula minimum — an accident, not a contract.
 *  - to_euros           pesetas → euros (166.386).
 *  - range_to_days      date range → days (minimum 1).
 *  - days_correction_manually  the manual day count wins when set.
 *  - subtract           total − total_period.
 *  - final_total        manual / major / minor amount − paid. A1 (ruling
 *                       2026-11-13): the MAJOR-grant branch is taken by ONE
 *                       caller section, MAJOR_GRANT_SECTION — TLD-owned code,
 *                       not an ontology option (`options.major_section_tipos`
 *                       exists in no ontology and is not read).
 *
 * THE ONE INSTALL TIPO IN THE ENGINE TREE lives here, and only here:
 * `MAJOR_GRANT_SECTION`. engine_install_tld_tripwire leg 2 allows a package
 * to name its OWN TLD's tipos and nothing else; a gate reads the exported
 * constant, never the literal.
 * WC-2026-11-13-calculation-tld-packages.
 */

import {
	arraySum,
	type CalculationFn,
	type CalculationOutput,
	firstNumber,
	NO_VALUE,
	phpRound,
	scalarNumber,
	total,
} from '../../core/components/component_info/widgets/calculation/fn_kit.ts';

/** The ontology `process.file` that selects this module (the dispatch KEY, never a path). */
export const MDCAT_CALCULATION_FILE = '/mdcat/calculation/mdcat.ts';

/**
 * The mdcat section whose final_total takes the MAJOR-grant branch (PHP
 * mdcat.php:702 hard-coded it; ruling A1 2026-11-13 keeps it in TLD code).
 * The "major" grant file of the grant programme this chain computes.
 */
export const MAJOR_GRANT_SECTION = 'mdcat2605';

/** The grant months of a day count (verbatim PHP: 30.42-day months, 30.4 remainder). */
function grantMonths(totalDays: number): number {
	const totalMonths = Math.floor(totalDays / 30.42);
	const days = Math.floor(totalDays - totalMonths * 30.4);
	return days > 0 ? totalMonths + 1 : totalMonths;
}

/**
 * A grant import over `total_days`. Zero days — absent / null / [] (sum to 0
 * through NO_VALUE / an empty list) or a list summing to 0 — is NO OUTPUT
 * (A2): the widget emits no `total` item. JS has one number type, so int 0
 * and float 0.0 are the same case here.
 */
function grantImport(
	dataMap: Record<string, unknown>,
	fn: string,
	rates: { base: number; perMonth: number; cap: number },
): CalculationOutput[] {
	const totalDays = arraySum(dataMap.total_days, 'total_days', fn);
	if (totalDays === 0) return [];
	const months = grantMonths(totalDays);
	const amount = months <= 6 ? rates.base : (months - 6) * rates.perMonth + rates.base;
	return total(Math.min(amount, rates.cap));
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

/** What `/mdcat/calculation/mdcat.ts` resolves. */
export const MDCAT_CALCULATION_FUNCTIONS: Readonly<Record<string, CalculationFn>> = {
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

	final_total({ dataMap, callerSectionTipo }) {
		const paid = arraySum(dataMap.paid, 'paid', 'final_total');
		const importManual = arraySum(dataMap.import_manual, 'import_manual', 'final_total');
		if (importManual !== 0) return total(phpRound(importManual - paid, 2));
		const totalMajor = firstNumber(dataMap.total_major);
		const major = callerSectionTipo === MAJOR_GRANT_SECTION && totalMajor > 0;
		const amount = major ? totalMajor : firstNumber(dataMap.total_minor);
		return total(phpRound(amount - paid, 2));
	},
};
