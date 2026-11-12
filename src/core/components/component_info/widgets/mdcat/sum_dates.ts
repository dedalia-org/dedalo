/**
 * sum_dates widget (PHP core/widgets/mdcat/sum_dates).
 *
 * Reads date_in/date_out pairs from the records linked by the source portal,
 * computes the interval per pair (PHP DateTime::diff calendar semantics) and
 * sums them into a total duration. Missing dates estimate a "1 day" default
 * (tracked in sum_estitmated_time_add); a missing date_out bridged by a
 * LATER date spans forward and flags estitmated_time_undefined. Output
 * values are DateInterval-shaped objects
 * {y,m,d,h,i,s,f,invert,days,from_string} — the render reads y/m/d.
 *
 * computeDataParsed (PHP get_data_parsed override — the grid/export/
 * diffusion face) humanizes the intervals with the localized year/month/day
 * labels; the PHP-hardcoded 'indeterminat' suffix is preserved verbatim.
 *
 * Declared by mdcat812 in the vendored ontology (published by mdcat1181) —
 * shape gate: test/unit/info_widget_ports.test.ts against the PHP class
 * contract; the parsed face reaches the export through
 * registry.ts widgetComputeDataParsed.
 * (Ontology typo 'estitmated' preserved verbatim — it is the wire id.)
 */

import {
	findTyped,
	type InfoWidgetDescriptor,
	readWidgetComponentData,
	type TypedInput,
	type WidgetContext,
	type WidgetItem,
} from '../widget_common.ts';

/** PHP DateInterval JSON shape (json_encode of a diff() result). */
interface Interval {
	y: number;
	m: number;
	d: number;
	h: number;
	i: number;
	s: number;
	f: number;
	invert: number;
	days: number | false;
	from_string: boolean;
}

const DAY_MS = 24 * 3600 * 1000;

/** A dd_date-like start object read from a component_date item. */
interface DdDateLike {
	year?: number;
	month?: number;
	day?: number;
}

/** dd_date->get_dd_timestamp('Y-m-d') twin: defaults month/day to 1. */
function toUtcDate(date: DdDateLike): Date {
	return new Date(Date.UTC(date.year ?? 0, (date.month ?? 1) - 1, date.day ?? 1));
}

/**
 * PHP DateTime::diff calendar semantics for date-only values (UTC — the h>0
 * DST correction of the PHP original can never trigger here, matching the
 * whole-day totals it was compensating toward).
 */
function dateDiff(from: Date, to: Date): Interval {
	const invert = to.getTime() < from.getTime() ? 1 : 0;
	const [a, b] = invert === 1 ? [to, from] : [from, to];
	let years = b.getUTCFullYear() - a.getUTCFullYear();
	let months = b.getUTCMonth() - a.getUTCMonth();
	let days = b.getUTCDate() - a.getUTCDate();
	if (days < 0) {
		// borrow the previous month's length (PHP diff semantics)
		const prevMonthDays = new Date(Date.UTC(b.getUTCFullYear(), b.getUTCMonth(), 0)).getUTCDate();
		days += prevMonthDays;
		months--;
	}
	if (months < 0) {
		months += 12;
		years--;
	}
	const totalDays = Math.round((b.getTime() - a.getTime()) / DAY_MS);
	return {
		y: years,
		m: months,
		d: days,
		h: 0,
		i: 0,
		s: 0,
		f: 0,
		invert,
		days: totalDays,
		from_string: false,
	};
}

/** PHP sum_intervals: anchor at 00:00, add every interval, diff vs anchor. */
function sumIntervals(intervals: Interval[]): Interval {
	// PHP DateTime('00:00') anchors "today"; the calendar identity of the
	// anchor affects month-length borrows exactly as it does in PHP. A fixed
	// epoch anchor keeps the compute deterministic (PHP's varies with the
	// server date — an accepted approximation while no instance declares the
	// widget; reconcile against a live oracle when one exists).
	const anchor = new Date(Date.UTC(2001, 0, 1));
	const moved = new Date(anchor.getTime());
	for (const interval of intervals) {
		const sign = interval.invert === 1 ? -1 : 1;
		moved.setUTCFullYear(moved.getUTCFullYear() + sign * interval.y);
		moved.setUTCMonth(moved.getUTCMonth() + sign * interval.m);
		moved.setUTCDate(moved.getUTCDate() + sign * (interval.d + interval.h / 24));
	}
	return dateDiff(anchor, moved);
}

/** custom_date_add_sub twin: apply "N day(s)" to a dd_date, add or sub. */
function customDateAddSub(date: DdDateLike, intervalDays: number, type: 'add' | 'sub'): Date {
	const base = toUtcDate(date);
	const sign = type === 'add' ? 1 : -1;
	base.setUTCDate(base.getUTCDate() + sign * intervalDays);
	return base;
}

/** First stored date item's start container (PHP reset + ->start unwrap). */
async function readFirstDate(
	sectionTipo: string,
	sectionId: number | string,
	componentTipo: string,
): Promise<DdDateLike | null> {
	const items = (await readWidgetComponentData(sectionTipo, sectionId, componentTipo)) as {
		start?: DdDateLike;
	}[];
	const first = items[0];
	if (first === undefined || first === null) return null;
	if (first.start !== undefined) return first.start;
	return first as DdDateLike;
}

async function computeSumDates(ipo: unknown[], context: WidgetContext): Promise<WidgetItem[]> {
	const data: WidgetItem[] = [];
	for (const [key, entry] of ipo.entries()) {
		const block = entry as { input?: unknown[]; output?: { id?: string }[] };
		const input = Array.isArray(block.input) ? block.input : [];
		const output = Array.isArray(block.output) ? block.output : [];

		const source = findTyped(input, 'source');
		const dateIn = findTyped(input, 'date_in') as TypedInput | undefined;
		const dateOut = findTyped(input, 'date_out') as TypedInput | undefined;
		if (source?.component_tipo === undefined || dateIn === undefined || dateOut === undefined) {
			continue;
		}
		const portalData = (await readWidgetComponentData(
			source.section_tipo === 'self' || source.section_tipo === 'current'
				? context.sectionTipo
				: (source.section_tipo ?? context.sectionTipo),
			context.sectionId,
			source.component_tipo,
		)) as { section_id?: unknown; section_tipo?: unknown }[];
		if (portalData.length === 0) return data;

		// parallel date arrays: per-locator date_in / date_out + the flat
		// interleaved array the gap-bridging forward scan walks
		const arDatesIn: (DdDateLike | null)[] = [];
		const arDatesOut: (DdDateLike | null)[] = [];
		const arDatesAll: (DdDateLike | null)[] = [];
		for (const locator of portalData) {
			const recordSection = String(locator.section_tipo ?? '');
			const recordId = locator.section_id as number | string;
			const recordDateIn = await readFirstDate(
				recordSection,
				recordId,
				dateIn.component_tipo ?? '',
			);
			arDatesIn.push(recordDateIn);
			arDatesAll.push(recordDateIn);
			const recordDateOut = await readFirstDate(
				recordSection,
				recordId,
				dateOut.component_tipo ?? '',
			);
			arDatesOut.push(recordDateOut);
			arDatesAll.push(recordDateOut);
		}

		const hasYear = (date: DdDateLike | null): date is DdDateLike =>
			date !== null && date.year !== undefined && date.year !== null && date.year !== 0;
		const isLastDate = (offsetKey: number): boolean => {
			for (let index = offsetKey + 1; index < arDatesAll.length; index++) {
				if (hasYear(arDatesAll[index] ?? null)) return false;
			}
			return true;
		};

		const arInterval: Interval[] = [];
		const estimatedTimeAdd: Interval[] = [];
		let estimatedTimeUndefined = false;
		let keyJump = 0;
		for (const [keyDates, currentDateIn] of arDatesIn.entries()) {
			if (keyDates < keyJump) continue; // bridged by a previous span
			const currentDateOut = arDatesOut[keyDates] ?? null;

			let interval: Interval | null = null;
			if (hasYear(currentDateIn) && hasYear(currentDateOut)) {
				interval = dateDiff(toUtcDate(currentDateIn), toUtcDate(currentDateOut));
			} else if (!hasYear(currentDateIn) && !hasYear(currentDateOut)) {
				interval = null; // nothing to do
			} else if (!hasYear(currentDateIn) && hasYear(currentDateOut)) {
				// date_in missing: estimate date_out − 1 day
				interval = dateDiff(customDateAddSub(currentDateOut, 1, 'sub'), toUtcDate(currentDateOut));
				estimatedTimeAdd.push(interval);
			} else if (hasYear(currentDateIn)) {
				// date_out missing: bridge forward or estimate +1 day
				const flatIndex = keyDates * 2;
				if (isLastDate(flatIndex) || hasYear(arDatesAll[flatIndex + 2] ?? null)) {
					interval = dateDiff(toUtcDate(currentDateIn), customDateAddSub(currentDateIn, 1, 'add'));
					estimatedTimeAdd.push(interval);
				} else {
					estimatedTimeUndefined = true;
					for (let key2 = flatIndex + 1; key2 < arDatesAll.length; key2++) {
						const candidate = arDatesAll[key2] ?? null;
						if (hasYear(candidate)) {
							interval = dateDiff(toUtcDate(currentDateIn), toUtcDate(candidate));
							keyJump = Math.floor(key2 / 2);
							if (key2 % 2 !== 0) keyJump++; // is_out: date_out slot closed the gap
							break;
						}
					}
				}
			}
			if (interval !== null) arInterval.push(interval);
		}

		const stats: Record<string, unknown> = {
			sum_intervals: sumIntervals(arInterval),
			sum_estitmated_time_add: sumIntervals(estimatedTimeAdd),
			estitmated_time_undefined: estimatedTimeUndefined,
		};
		for (const dataMap of output) {
			const id = dataMap.id ?? '';
			data.push({
				widget: 'sum_dates',
				key,
				widget_id: id,
				value: stats[id] ?? null,
			});
		}
	}
	return data;
}

/**
 * PHP get_data_parsed override: humanize the intervals ("2 años 3 meses
 * 15 días" via the localized label catalog) — the grid/export/diffusion face.
 */
async function computeSumDatesParsed(
	ipo: unknown[],
	context: WidgetContext,
): Promise<WidgetItem[]> {
	const raw = await computeSumDates(ipo, context);
	const { getLabels } = await import('../../../../labels/catalog.ts');
	const { currentApplicationLang } = await import('../../../../resolve/request_lang.ts');
	const labels = await getLabels(currentApplicationLang());

	const findValue = (id: string): unknown =>
		(raw.find((item) => item.widget_id === id) as { value?: unknown } | undefined)?.value;
	const sumIntervalsValue = (findValue('sum_intervals') ?? {}) as Partial<Interval>;
	const sumEstimatedValue = (findValue('sum_estitmated_time_add') ??
		null) as Partial<Interval> | null;
	const timeUndefined = findValue('estitmated_time_undefined') ?? null;

	const humanize = (interval: Partial<Interval> | null): string => {
		if (interval === null) return '';
		const parts: string[] = [];
		if ((interval.y ?? 0) > 0) {
			parts.push(
				`${interval.y} ${(interval.y as number) > 1 ? (labels.years ?? 'years') : (labels.year ?? 'year')}`,
			);
		}
		if ((interval.m ?? 0) > 0) {
			parts.push(
				`${interval.m} ${(interval.m as number) > 1 ? (labels.months ?? 'months') : (labels.month ?? 'month')}`,
			);
		}
		if ((interval.d ?? 0) > 0) {
			parts.push(
				`${interval.d} ${(interval.d as number) > 1 ? (labels.days ?? 'days') : (labels.day ?? 'day')}`,
			);
		}
		return parts.join(' ');
	};

	const estimatedText = humanize(sumEstimatedValue);
	const indeterminate: string[] = [];
	if (estimatedText !== '' || timeUndefined === true) {
		if (estimatedText !== '') indeterminate.push(estimatedText);
		if (timeUndefined === true) {
			if (estimatedText !== '') indeterminate.push(' + ');
			// (!) PHP-hardcoded Catalan literal — preserved verbatim
			indeterminate.push('indeterminat');
		}
	}

	return [
		{ widget_id: 'sum_intervals', value: humanize(sumIntervalsValue) },
		{ widget_id: 'sum_estitmated_time_add', value: indeterminate.join('') },
		{ widget_id: 'estitmated_time_undefined', value: timeUndefined },
	];
}

export const sum_dates: InfoWidgetDescriptor = {
	name: 'sum_dates',
	path: '/mdcat/sum_dates',
	computeData: computeSumDates,
	computeDataParsed: computeSumDatesParsed,
};
