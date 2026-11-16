/**
 * Runtime parsers — parser_date family.
 * Oracle: diffusion/api/v1/lib/parsers/parser_date.ts (behavior parity).
 *
 * Converts stored dd_date objects ({start,end,period} of {year,month,day,
 * hour,minute,second}) to diffusion strings/timestamps. All fns are pure —
 * even publication timestamps are NOT here (parser_global::
 * publication_unix_timestamp is a compile-time system source step).
 */

import { ddDateToUnixSeconds } from '../../core/concepts/dd_date_time.ts';
import type { ItemParserFn, ParserItem } from './types.ts';

/** One date component bag as stored inside a dd_date value. */
interface DdDatePart {
	year?: number;
	month?: number;
	day?: number;
	hour?: number;
	minute?: number;
	second?: number;
}

// ---------------------------------------------------------------------------
// select_properties — pick {start|end|period} parts out of dd_date objects
// ---------------------------------------------------------------------------

/** Extracts the requested dd_date properties (default ['start']) and flattens them. */
export const selectProperties: ItemParserFn = (items, options) => {
	if (!items || items.length === 0) return null;

	const selectProps = (options.select as string[]) ?? ['start'];
	const result: ParserItem[] = [];

	for (const item of items) {
		const val = item.value;
		const values = Array.isArray(val) ? val : [val];

		const extracted: unknown[] = [];
		for (const dateObj of values) {
			if (!dateObj || typeof dateObj !== 'object') continue;
			for (const prop of selectProps) {
				const part = (dateObj as Record<string, unknown>)[prop];
				if (part !== undefined && part !== null) {
					extracted.push(part);
				}
			}
		}

		if (extracted.length > 0) {
			result.push({ ...item, value: extracted });
		}
	}

	return result.length > 0 ? result : null;
};

// ---------------------------------------------------------------------------
// select_keys — positional pick + SQL zero-padding
// ---------------------------------------------------------------------------

/**
 * Picks array elements by index (default [0]) and pads missing month/day
 * with 0 for SQL date compatibility. Copies each part before padding —
 * unlike the oracle, the input IR is never mutated.
 */
export const selectKeys: ItemParserFn = (items, options) => {
	if (!items || items.length === 0) return null;

	const keys = (options.keys as number[]) ?? [0];
	const result: ParserItem[] = [];

	for (const item of items) {
		const val = item.value;
		const values = Array.isArray(val) ? val : [val];

		const selected: unknown[] = [];
		for (const keyIndex of keys) {
			if (keyIndex >= values.length || values[keyIndex] === undefined) continue;
			const datePart = values[keyIndex];

			if (datePart && typeof datePart === 'object') {
				const padded = { ...(datePart as DdDatePart) };
				if (padded.month === undefined || padded.month === null) padded.month = 0;
				if (padded.day === undefined || padded.day === null) padded.day = 0;
				selected.push(padded);
			} else {
				selected.push(datePart);
			}
		}

		if (selected.length > 0) {
			result.push({ ...item, value: selected });
		}
	}

	return result.length > 0 ? result : null;
};

// ---------------------------------------------------------------------------
// format_string_date — dd_date parts → pattern string
// ---------------------------------------------------------------------------

/**
 * Formats dd_date parts with a PHP-token pattern (default 'Y-m-d'; tokens
 * Y y m d H i s). Parts within one item join with fields_separator; when
 * multiple items result, they collapse to ONE joined item (records_separator)
 * — the oracle joins across records here, regardless of lang.
 */
export const formatStringDate: ItemParserFn = (items, options) => {
	if (!items || items.length === 0) return null;

	const pattern = (options.pattern as string) ?? 'Y-m-d';
	const recordsSeparator = (options.records_separator as string) ?? ' | ';
	const fieldsSeparator = (options.fields_separator as string) ?? ', ';

	const result: ParserItem[] = [];

	for (const item of items) {
		const val = item.value;
		const values = Array.isArray(val) ? val : [val];

		const formattedParts: string[] = [];
		for (const datePart of values) {
			if (datePart && typeof datePart === 'object') {
				// Oracle parser_date.ts:164-166 calls date_part.get_unix_timestamp(),
				// a dd_date CLASS method that plain JSON values never have (it would
				// throw). We compute the timestamp instead — same intent, no crash.
				if (pattern === 'unix_timestamp') {
					formattedParts.push(String(ddDateToUnix(datePart as DdDatePart)));
				} else {
					formattedParts.push(formatDdDate(datePart as DdDatePart, pattern));
				}
			}
		}

		if (formattedParts.length > 0) {
			result.push({ ...item, value: formattedParts.join(fieldsSeparator) });
		}
	}

	if (result.length > 1) {
		const first = result[0] as ParserItem;
		const combined = result.map((r) => r.value).join(recordsSeparator);
		return [{ ...first, value: combined }];
	}

	return result.length > 0 ? result : null;
};

// ---------------------------------------------------------------------------
// string_date — select_properties → select_keys → format_string_date
// ---------------------------------------------------------------------------

/** The chained convenience parser with oracle defaults merged in. */
export const stringDate: ItemParserFn = (items, options, ctx) => {
	if (!items || items.length === 0) return null;

	const mergedOptions: Record<string, unknown> = {
		select: ['start'],
		keys: [0],
		pattern: 'Y-m-d',
		records_separator: ' | ',
		fields_separator: ', ',
		...options,
	};

	let result = selectProperties(items, mergedOptions, ctx);
	result = result === null ? null : selectKeys(result, mergedOptions, ctx);
	result = result === null ? null : formatStringDate(result, mergedOptions, ctx);

	return result;
};

// ---------------------------------------------------------------------------
// unix_timestamp — select_properties → select_keys → epoch seconds
// ---------------------------------------------------------------------------

/** Converts the selected dd_date part to a Unix timestamp (int seconds). */
export const unixTimestamp: ItemParserFn = (items, options, ctx) => {
	if (!items || items.length === 0) return null;

	const mergedOptions: Record<string, unknown> = {
		select: ['start'],
		keys: [0],
		...options,
	};

	let result = selectProperties(items, mergedOptions, ctx);
	result = result === null ? null : selectKeys(result, mergedOptions, ctx);
	if (!result || result.length === 0) return null;

	const finalResult: ParserItem[] = [];
	for (const item of result) {
		const val = item.value;
		const values = Array.isArray(val) ? val : [val];
		for (const datePart of values) {
			if (datePart && typeof datePart === 'object') {
				finalResult.push({ ...item, value: ddDateToUnix(datePart as DdDatePart) });
			}
		}
	}

	return finalResult.length > 0 ? finalResult : null;
};

// ---------------------------------------------------------------------------
// default — mode-aware component_date::get_diffusion_value port
// ---------------------------------------------------------------------------

/**
 * Registered as 'parser_date::default'. Modes via options.date_mode:
 *   'range'|'time_range' → "start_ts,end_ts" ("Y-m-d H:i:s", bare-comma join,
 *                          configurable via range_separator)
 *   'period'             → one item per ctx lang, "N years N months N days"
 *                          with localized unit labels
 *   'date' (default)     → "Y-m-d H:i:s" of the start part
 * Emits one item per date record with value:[string] (text_format shape);
 * the downstream plan merge joins across records.
 */
export const dateDefault: ItemParserFn = (items, options, ctx) => {
	if (!items || items.length === 0) return null;

	const dateMode = (options.date_mode as string) ?? 'date';
	// v6 joins a range start/end with a bare comma (no space) — keep as default.
	const rangeSeparator = (options.range_separator as string) ?? ',';

	const arDiffusionItems: ParserItem[] = [];
	const arPeriodItems: ParserItem[] = [];

	for (const item of items) {
		const val = item.value;
		const values = Array.isArray(val) ? val : [val];

		for (const rawDate of values) {
			if (!rawDate || typeof rawDate !== 'object') continue;
			const dateObj = rawDate as { start?: DdDatePart; end?: DdDatePart; period?: DdDatePart };

			switch (dateMode) {
				case 'range':
				case 'time_range': {
					const arDate: string[] = [];
					if (dateObj.start && dateObj.start.year !== undefined) {
						arDate.push(formatDdDate(dateObj.start, 'Y-m-d H:i:s'));
					}
					if (dateObj.end && dateObj.end.year !== undefined) {
						arDate.push(formatDdDate(dateObj.end, 'Y-m-d H:i:s'));
					}
					if (arDate.length > 0) {
						arDiffusionItems.push({ ...item, value: [arDate.join(rangeSeparator)] });
					}
					break;
				}

				case 'period': {
					if (!dateObj.period) break;
					const period = dateObj.period;

					// One item per configured output lang (localized unit labels)
					for (const targetLang of ctx.langs) {
						const parts: string[] = [];
						if (period.year !== undefined)
							parts.push(`${period.year} ${getLabel('years', targetLang)}`);
						if (period.month !== undefined)
							parts.push(`${period.month} ${getLabel('months', targetLang)}`);
						if (period.day !== undefined)
							parts.push(`${period.day} ${getLabel('days', targetLang)}`);
						if (parts.length > 0) {
							arPeriodItems.push({ ...item, lang: targetLang, value: [parts.join(' ')] });
						}
					}
					break;
				}

				default: {
					if (dateObj.start && dateObj.start.year !== undefined) {
						arDiffusionItems.push({ ...item, value: [formatDdDate(dateObj.start, 'Y-m-d H:i:s')] });
					}
					break;
				}
			}
		}
	}

	if (arPeriodItems.length > 0) return arPeriodItems;
	return arDiffusionItems.length > 0 ? arDiffusionItems : null;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Localized period unit labels (oracle mirror of PHP label::get_label). */
function getLabel(key: 'years' | 'months' | 'days', lang: string): string {
	const langCodeMap: Record<string, string> = {
		'lg-eng': 'en',
		'lg-spa': 'es',
		'lg-cat': 'ca',
		'lg-fra': 'fr',
		'lg-deu': 'de',
		'lg-por': 'pt',
		'lg-ita': 'it',
		'lg-nob': 'no',
		'lg-swe': 'sv',
		'lg-nld': 'nl',
	};
	const short = langCodeMap[lang] ?? lang;

	const labels: Record<string, Record<string, string>> = {
		years: {
			en: 'years',
			es: 'años',
			ca: 'anys',
			fr: 'ans',
			de: 'Jahre',
			pt: 'anos',
			it: 'anni',
			no: 'år',
			sv: 'år',
			nl: 'jaar',
		},
		months: {
			en: 'months',
			es: 'meses',
			ca: 'mesos',
			fr: 'mois',
			de: 'Monate',
			pt: 'meses',
			it: 'mesi',
			no: 'mnd',
			sv: 'mån',
			nl: 'maanden',
		},
		days: {
			en: 'days',
			es: 'días',
			ca: 'dies',
			fr: 'jours',
			de: 'Tage',
			pt: 'dias',
			it: 'giorni',
			no: 'dager',
			sv: 'dagar',
			nl: 'dagen',
		},
	};
	return labels[key]?.[short] ?? labels[key]?.en ?? key;
}

/**
 * dd_date part → string via PHP-style tokens.
 * 'Y' = zero-padded year (v6 sprintf %04d, negatives "-094");
 * 'y' = RAW year ("-72", not "-072") — replaced FIRST so the padded output
 * of 'Y' is not re-consumed. m/d/H/i/s are 2-digit padded.
 */
export function formatDdDate(datePart: DdDatePart, pattern: string): string {
	const year = datePart.year ?? 0;
	const month = datePart.month ?? 0;
	const day = datePart.day ?? 0;
	const hour = datePart.hour ?? 0;
	const minute = datePart.minute ?? 0;
	const second = datePart.second ?? 0;

	const yearStr =
		year < 0 ? `-${String(Math.abs(year)).padStart(3, '0')}` : String(year).padStart(4, '0');

	let result = pattern;
	result = result.replace(/y/g, String(year));
	result = result.replace(/Y/g, yearStr);
	result = result.replace(/m/g, String(month).padStart(2, '0'));
	result = result.replace(/d/g, String(day).padStart(2, '0'));
	result = result.replace(/H/g, String(hour).padStart(2, '0'));
	result = result.replace(/i/g, String(minute).padStart(2, '0'));
	result = result.replace(/s/g, String(second).padStart(2, '0'));

	return result;
}

/**
 * dd_date part → Unix epoch seconds (UTC). The ONE home is
 * core/concepts/dd_date_time.ts ddDateToUnixSeconds (the calculation widget's
 * date facet reads the same instant). Years 0-99 are real years — the oracle's
 * Date.UTC two-digit-year quirk (year 50 → 1950) is NOT kept
 * (WC-2026-11-12-calculation-widget-port).
 */
export function ddDateToUnix(datePart: DdDatePart): number {
	return ddDateToUnixSeconds(datePart);
}
