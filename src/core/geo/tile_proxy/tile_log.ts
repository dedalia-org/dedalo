/**
 * WHAT THE TILE PROXY TELLS THE OPERATOR — and how rarely.
 *
 * Every line the route writes is reachable by a person holding a session: an out-of-range
 * zoom, a view the source does not take, a stored source that no longer validates, a
 * provider that is down all fail EVERY tile of EVERY viewer, a viewport asks twenty to fifty
 * tiles and a pan more. A line per tile would let one logged-in user (or one broken
 * provider) write the log as fast as they can click, bury the operator's signal and cost
 * disk and shipping at no price to themselves. So:
 *
 *   - what a caller controls and the operator cannot act on is COUNTED, never logged
 *     (a zoom outside a source, a view it does not take, a provider that has no such tile:
 *     `incrementCounter` at the call site);
 *   - what the operator CAN act on (a provider failing, a source that no longer validates, a
 *     person held to their budget) is logged ONCE per distinct line per `WINDOW_MS`, the
 *     repeats counted in `map_tile_log_suppressed`. The first line names the source and the
 *     reason; "it is still failing" is the counter growing, not more lines.
 *
 * The same pattern the external subsystem's one logging door uses (`logExternalError`), for
 * the same reason. A line carries no address, token or stack (the grammar of
 * `formatErrorLine`: the door's code and the source's name, never its URL).
 *
 * Keys are the disclosure-safe log line WITHOUT its request id — never a session, user
 * address or language. Forgetting a key early costs one repeated line, nothing else.
 * State: a module Map in `module_state_tripwire`, TIME-CLEARED (the keys older than the
 * window are dropped on every admission, oldest first) and SIZE-BOUNDED (`MAX_KEYS`, oldest
 * first); `clearTileLogForTests` empties it for gate isolation. The clock is a parameter.
 */

import { incrementCounter } from '../../api/counters.ts';

/** A distinct line is written at most once in this long. */
const WINDOW_MS = 60_000;

/** The most distinct lines remembered; the oldest is forgotten for a newcomer past it. */
const MAX_KEYS = 256;

/** The limits, for the gate. */
export const TILE_LOG_LIMITS = Object.freeze({ windowMs: WINDOW_MS, maxKeys: MAX_KEYS });

/** Line → when it was last written, oldest first. */
const LOGGED = new Map<string, number>();

/** True when `key` was written inside the window ending at `now`. */
function recentlyLogged(key: string, now: number): boolean {
	const at = LOGGED.get(key);
	// A clock that went back (a gate's fake one) is not "recent".
	return at !== undefined && now >= at && now - at < WINDOW_MS;
}

/** Forget the keys the window has passed, oldest first (they are in insertion order). */
function dropExpired(now: number): void {
	for (const [key, at] of LOGGED) {
		if (now >= at && now - at < WINDOW_MS) return;
		LOGGED.delete(key);
	}
}

/** Remember `key` as written at `now`, at the newest end, within the size bound. */
function remember(key: string, now: number): void {
	LOGGED.delete(key);
	LOGGED.set(key, now);
	while (LOGGED.size > MAX_KEYS) {
		const oldest = LOGGED.keys().next().value;
		if (oldest === undefined) return;
		LOGGED.delete(oldest);
	}
}

/**
 * Write `line` (through `write`) unless the same `key` was written inside the window; count
 * the ones that were not. Returns whether it was written.
 *
 * @param key the line without its request id: what makes two occurrences "the same".
 */
export function reportOncePerWindow(key: string, now: number, write: () => void): boolean {
	dropExpired(now);
	if (recentlyLogged(key, now)) {
		incrementCounter('map_tile_log_suppressed');
		return false;
	}
	remember(key, now);
	write();
	return true;
}

/** Distinct lines remembered right now — observability for the gates. */
export function tileLogKeys(): number {
	return LOGGED.size;
}

/** Forget every line — TEST ISOLATION ONLY, so a gate starts from "nothing said". */
export function clearTileLogForTests(): void {
	LOGGED.clear();
}
