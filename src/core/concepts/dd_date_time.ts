/**
 * DD_DATE TIME — the derived `time` key of a stored component_date item (PHP
 * dd_date::convert_date_to_seconds + component_date::add_time).
 *
 * `time` is DERIVED: the save door recomputes it from the date fields on every
 * component_date write and never trusts an incoming value. Pure (no I/O), so
 * the concepts layer (item_value.ts — "is this incoming item the stored one?")
 * can compare two items as they would be PERSISTED without importing the media
 * reader that used to host these functions (media/file_date.ts re-exports them).
 */

/** Sparse dd_date fields (PHP core/common/class.dd_date.php — nulls omitted). */
export interface DdDate {
	year?: number;
	month?: number;
	day?: number;
	hour?: number;
	minute?: number;
	second?: number;
	ms?: number;
	/** Virtual-calendar sort seconds — injected by {@link withDedaloTime} on save. */
	time?: number;
}

/**
 * PHP dd_date::convert_date_to_seconds (:1027): virtual 372-day years and
 * 31-day months (31*12, symmetric partial-date arithmetic; NOT Unix time).
 * Twins: search/builders/builder_date.ts convertDateToSeconds (search ranges),
 * section/record/create_record.ts virtualDateNow (audit dates).
 */
export function ddDateToSeconds(date: DdDate): number {
	const year = date.year ?? 0;
	const month = oneBasedOffset(date.month);
	const day = oneBasedOffset(date.day);
	const hour = nonNegative(date.hour);
	const minute = nonNegative(date.minute);
	const second = nonNegative(date.second);
	return year * 372 * 86400 + month * 31 * 86400 + day * 86400 + hour * 3600 + minute * 60 + second;
}

/**
 * PHP "Rectified 25-11-2017": a month/day is 1-based when present — its
 * 0-based offset, clamped at 0 (absent, 0, negative or NaN all count as 0).
 */
function nonNegative(value: number | undefined): number {
	return Math.max(value ?? 0, 0);
}

function oneBasedOffset(value: number | undefined): number {
	const offset = (value ?? 0) - 1;
	// biome-ignore lint/complexity/useMathMinMax: NaN-absorbing clamp: Math.max(NaN, x) is NaN, this ternary yields the floor.
	return offset > 0 ? offset : 0;
}

/**
 * The persisted-shape stamp (PHP component_date::save → add_time →
 * build_dd_date_with_time): recompute 'time' server-side and attach it. The
 * media-import path stamps explicitly; interactive saves go through
 * {@link addTimeToDateItem} on the component_date save path.
 */
export function withDedaloTime(date: DdDate): DdDate {
	return { ...date, time: ddDateToSeconds(date) };
}

/**
 * PHP component_date::add_time (class.component_date.php:634) — (re)compute the
 * absolute-seconds `time` on each dd_date container of ONE stored date item,
 * mutating in place, and always overriding any client-supplied value (the
 * server never trusts the client's `time`). The modes are mutually exclusive by
 * the top-level key present:
 *   - `period` → stamp `period.time`;
 *   - `start`  → stamp `start.time` (+ `end.time` when `end` is present);
 *   - bare `hour` at root → the item itself is the dd_date.
 * Unknown/empty shapes are left untouched. This is the sort/range-search key —
 * without it a stored date can't be ordered or range-filtered.
 */
export function addTimeToDateItem(item: unknown): void {
	if (!isObject(item)) return;
	const container = item as { period?: DdDate | null; start?: DdDate | null; end?: DdDate | null };
	if (isDate(container.period)) {
		stampTime(container.period);
	} else if (isDate(container.start)) {
		stampTime(container.start);
		if (isDate(container.end)) stampTime(container.end);
	} else if ((item as DdDate).hour !== undefined) {
		stampTime(item as DdDate);
	}
}

function isObject(value: unknown): value is object {
	return value !== null && typeof value === 'object';
}

function isDate(value: DdDate | null | undefined): value is DdDate {
	return value !== undefined && value !== null;
}

function stampTime(date: DdDate): void {
	date.time = ddDateToSeconds(date);
}

/**
 * dd_date → Unix epoch seconds, UTC (PHP dd_date::get_unix_timestamp, and the
 * diffusion `parser_date::unix_timestamp` — ONE home for both). Absent fields
 * fall back to the epoch's own (month/day 1, time 0); absent year is 1970.
 *
 * Years 0–99 are REAL years (`setUTCFullYear`), never 1900+year: `Date.UTC`
 * maps a two-digit year into the 20th century, which turned year 50 into 1950
 * (WC-2026-11-12-calculation-widget-port).
 */
export function ddDateToUnixSeconds(date: DdDate): number {
	const { year = 1970, month = 1, day = 1, hour = 0, minute = 0, second = 0 } = date;
	const moment = new Date(0);
	moment.setUTCFullYear(year, month - 1, day);
	moment.setUTCHours(hour, minute, second, 0);
	return Math.floor(moment.getTime() / 1000);
}

/**
 * Unix epoch seconds → a FULL dd_date (year…second), UTC (PHP
 * dd_date::get_dd_date_from_unix_timestamp, which read the server time zone —
 * here the instant is the same everywhere).
 */
export function ddDateFromUnixSeconds(
	seconds: number,
): Required<Pick<DdDate, 'year' | 'month' | 'day' | 'hour' | 'minute' | 'second'>> {
	const moment = new Date(seconds * 1000);
	return {
		year: moment.getUTCFullYear(),
		month: moment.getUTCMonth() + 1,
		day: moment.getUTCDate(),
		hour: moment.getUTCHours(),
		minute: moment.getUTCMinutes(),
		second: moment.getUTCSeconds(),
	};
}
