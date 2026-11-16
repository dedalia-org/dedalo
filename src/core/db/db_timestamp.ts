/**
 * THE shared DB timestamp helper (PHP dd_date::get_timestamp_now_for_db).
 *
 * Every TM/data stamp path — component save, relations delete_locator,
 * translation tool, create/delete/duplicate record, observers — formats its
 * 'YYYY-MM-DD HH:MM:SS' stamps HERE, and nowhere else (S1-03: a UTC twin of
 * this helper once stamped matrix_time_machine with 2h-skewed rows).
 *
 * PHP emits WALL-CLOCK time in DEDALO_TIMEZONE (date_default_timezone_set at
 * bootstrap), NOT UTC — matrix_time_machine.timestamp is text-sorted, so both
 * engines must stamp the same clock or restore timelines mis-sort. The format
 * is timezone-aware (config.timezone), not host-local, so a host running on
 * UTC still stamps Dédalo's configured zone.
 */

import { config } from '../../config/config.ts';

/** One formatter per process — Intl.DateTimeFormat construction is expensive. */
const formatter = new Intl.DateTimeFormat('en-CA', {
	timeZone: config.timezone,
	year: 'numeric',
	month: '2-digit',
	day: '2-digit',
	hour: '2-digit',
	minute: '2-digit',
	second: '2-digit',
	hourCycle: 'h23',
});

/**
 * 'YYYY-MM-DD HH:MM:SS' at the given instant (default: now), expressed as
 * DEDALO_TIMEZONE wall-clock time (PHP get_timestamp_now_for_db parity).
 */
export function dbTimestamp(now: Date = new Date()): string {
	const parts: Partial<Record<Intl.DateTimeFormatPartTypes, string>> = {};
	for (const part of formatter.formatToParts(now)) {
		parts[part.type] = part.value;
	}
	return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

/**
 * How far BEFORE its change a backfill row is stamped (PHP tm_record::create
 * previous_data: `now − PT1M`). One constant for every backfill door — the
 * save-before of the history writer, the delete / observer / duplicate
 * backfills — so the history keeps one timeline convention.
 */
export const BACKFILL_LEAD_MS = 60_000;

/**
 * The stamp of a backfill row for a change made at `now`. Derived from the
 * SAME instant as the change's own stamp (`dbTimestamp(now)`): a wall-clock
 * string cannot be shifted back safely across a DST change, an instant can.
 */
export function backfillTimestamp(now: Date): string {
	return dbTimestamp(new Date(now.getTime() - BACKFILL_LEAD_MS));
}
