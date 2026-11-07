/**
 * THE ANSWERS A PROVIDER ASKED US TO KEEP — a small memory for an identical question.
 *
 * Nominatim's usage policy says results must be cached on our side and that a client which
 * sends the same query again and again may be classified as faulty and blocked. Calls in the
 * air are shared (`flights.ts`), but that covers only questions asked at the same moment:
 * a cataloguer who re-runs a search, or the browser transport's re-send after the first
 * attempt has already finished, would reach the provider every time. So a service whose
 * table row carries `keepAnswerMs` (`table.ts`: both Nominatim services) has its answers
 * kept here, and an identical question inside that time is answered from memory — no
 * flight, no limiter slot, no socket, no request at the provider.
 *
 * WHAT IS KEPT, and why that is safe to share:
 *   - the BODY TEXT of a good answer, or of a provider's "nothing there" (a 200 the service's
 *     contract reads as `external.not_found`: the same repeated question, answered the same
 *     way). Never a failure, never an answer off the contract (`external.protocol`), never an
 *     answer over `ENTRY_BYTES`. The text is immutable and every caller parses it for itself
 *     (`answers.ts`), so no two callers hold one object.
 *   - keyed by the service id and the address the engine built for it (`request.ts`): public
 *     provider data, the same for everybody, with no user, session or language in the key.
 *
 * WHO CHECKS PERMISSION. This module has no notion of a principal, and it must not need one:
 * the only way in is `callGeoService`, and its callers (a tool action, whose permission kind
 * the dispatcher checks before the handler runs; a job, which runs as its own principal)
 * have been through their gate BEFORE they ask, so a memory hit can never answer a caller
 * who was not allowed to ask. What it holds is public data keyed by the question alone,
 * which is why a hit may be handed to anyone who is allowed to ask.
 *
 * HOW LONG, and how much. The text door returns no response headers, so a provider's own
 * `Cache-Control` cannot be followed: the lifetime is the table's number. The memory is
 * bounded BY BYTES (`TOTAL_BYTES`), counting each entry's body, its key and a fixed overhead,
 * so a flood of tiny answers cannot grow it by count; when a new entry does not fit, the
 * LEAST RECENTLY USED are evicted first (a Map iterates in insertion order, and a fresh entry
 * that is asked for again is moved to the newest end by `recallAnswer` — same body, same cost,
 * same `staleAt`: a hit renews its place, never its lifetime).
 *
 * Lifecycle (`module_state_tripwire` lists the map): TIME-CLEARED and SIZE-BOUNDED. A stale
 * entry is dropped when it is recalled or evicted least-recently-used first; the byte ceiling is enforced
 * on every admission against a running total. `clearAnswerMemoryForTests`
 * empties it for gate isolation. The process restarting forgets it all, which is correct:
 * the memory is a courtesy to a provider, never a source of truth.
 */

/** The most the memory holds, in bytes (body, key and overhead of every entry). */
const TOTAL_BYTES = 2 * 1024 * 1024;

/** An answer whose entry costs more than this is served but not kept. */
const ENTRY_BYTES = 64 * 1024;

/** What an entry costs beyond its body and its key (the Map slot, the record). */
const ENTRY_OVERHEAD_BYTES = 64;

/** The limits, for the gate. */
export const ANSWER_MEMORY_LIMITS = Object.freeze({
	totalBytes: TOTAL_BYTES,
	entryBytes: ENTRY_BYTES,
	overheadBytes: ENTRY_OVERHEAD_BYTES,
});

interface Kept {
	readonly body: string;
	/** What the entry counts against `TOTAL_BYTES`. */
	readonly cost: number;
	/** The first moment at which the entry is no longer served. */
	readonly staleAt: number;
}

/** Kept answers by service id + built address, least recently used first. */
const KEPT = new Map<string, Kept>();

/** What an entry counts: its body in UTF-8, its key (UTF-16) and the fixed overhead. */
function costOf(key: string, body: string): number {
	return Buffer.byteLength(body, 'utf8') + key.length * 2 + ENTRY_OVERHEAD_BYTES;
}

/** The bytes the held entries cost, kept in step with `KEPT` by `rememberAnswer` and `forget` alone. */
const RUNNING = { bytes: 0 };

/** Take `key` out of the memory, whatever it holds. */
function forget(key: string): void {
	const kept = KEPT.get(key);
	if (kept === undefined) return;
	KEPT.delete(key);
	RUNNING.bytes -= kept.cost;
}

/**
 * The body kept for `key` that is still fresh at `now`, or null (a stale entry is dropped). A
 * hit moves the entry to the newest end, the record unchanged — so the running total is too.
 */
export function recallAnswer(key: string, now: number): string | null {
	const kept = KEPT.get(key);
	if (kept === undefined) return null;
	if (kept.staleAt <= now) {
		forget(key);
		return null;
	}
	KEPT.delete(key);
	KEPT.set(key, kept);
	return kept.body;
}

/** Evict the least recently used entries until `cost` more bytes fit under the ceiling. */
function makeRoomFor(cost: number): void {
	for (const key of KEPT.keys()) {
		if (RUNNING.bytes + cost <= TOTAL_BYTES) return;
		forget(key);
	}
}

/**
 * Keep `body` as the answer to `key` for `keepMs` from `now`. Too big an entry is not kept
 * (and an older answer for the same key is forgotten rather than left to be served).
 * Admission is constant-time in the size of the memory: the byte total is a running number,
 * and there is no stale sweep — a stale entry costs only the bytes it was already budgeted,
 * is dropped when recalled, and is otherwise evicted least-recently-used first.
 */
export function rememberAnswer(key: string, body: string, keepMs: number, now: number): void {
	const cost = costOf(key, body);
	forget(key);
	if (cost > ENTRY_BYTES) return;
	makeRoomFor(cost);
	KEPT.set(key, { body, cost, staleAt: now + keepMs });
	RUNNING.bytes += cost;
}

/** Entries held right now — observability for the gates. */
export function answersKept(): number {
	return KEPT.size;
}

/** Bytes the held entries count against the ceiling — observability for the gates. */
export function answerBytesKept(): number {
	return RUNNING.bytes;
}

/** Forget every kept answer — TEST ISOLATION ONLY. */
export function clearAnswerMemoryForTests(): void {
	KEPT.clear();
	RUNNING.bytes = 0;
}
