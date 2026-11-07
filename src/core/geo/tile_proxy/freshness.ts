/**
 * HOW LONG A RELAYED TILE STAYS FRESH — the provider's own word, read from the answer
 * (RFC 9111), clamped to the proxy's bounds.
 *
 * The tile cache (tile_cache.ts) is SHARED between every viewer, so it follows the rules
 * of a shared cache:
 *
 *   - `no-store`, `no-cache` and `private` keep the tile OUT of the cache (and tell the
 *     browser the same): the provider asked that nobody keep it. `no-cache` would allow
 *     keeping it only to revalidate it on EVERY use; the proxy keeps a tile to serve it fresh
 *     (and to revalidate it once that has run out), not to ask the provider each time, so it
 *     does not keep.
 *   - otherwise the freshness is `s-maxage`, else `max-age`, else `Expires` minus `Date`,
 *     less the `Age` the answer already had (a CDN's). A malformed number is read as
 *     "stale now" — the safe side.
 *   - an answer that says nothing keeps the ORIGIN's default (`ProviderTerms`: a tile of a
 *     service that publishes no freshness, an hour; OpenStreetMap's policy says a week
 *     when the headers cannot be read).
 *
 * The result is clamped: never longer than `MAX_LIFETIME_MS` (a week — the memory is
 * bounded by bytes anyway, and an unbounded lifetime would serve a map that has since
 * changed), and a tile fresher than `MIN_LIFETIME_MS` is not worth a place in the memory
 * (it would be gone before the next viewer asked) and is not kept.
 *
 * REVALIDATION. A tile whose freshness has run out and that came with a validator (`ETag`,
 * `Last-Modified`: validators.ts) is not dropped and fetched in full: the cache keeps it as
 * stale and the route asks the provider conditionally (`If-None-Match` / `If-Modified-Since`,
 * which OpenStreetMap's policy asks a cache to do). A `304` renews the tile by the freshness
 * the `304` itself states (RFC 9110 §15.4.5: it carries the `Cache-Control` / `Expires` /
 * `Date` a `200` would), a `200` replaces it. This module only reads freshness; keeping and
 * asking are tile_cache.ts and the route.
 *
 * THE BROWSER'S SHARE is not the memory's. The proxy URL names a source by id and a tile
 * by z/x/y, nothing else (the grammar is closed: no cache-buster can be added), and the
 * source behind an id can change without the URL changing: an editor changes the layers or the
 * address of a stored source (its id stays), an ontology update changes a default, a Time
 * Machine restore brings back an older value. The server memory is keyed by the upstream
 * address and is right the moment the address changes; the browser's copy is keyed by the
 * proxy URL and would be served stale for as long as it was told to keep it. So a tile of a
 * source that is DATA (`'editable'`: stored, default) is kept by a browser for minutes, not a
 * day; one of the core's own registry (`'fixed'`) can only change with the engine, and keeps
 * the day.
 *
 * PURE: the clock is a parameter.
 */

const SECOND_MS = 1000;
/** The longest a tile is kept, whatever the provider says. */
export const MAX_LIFETIME_MS = 7 * 24 * 60 * 60 * SECOND_MS;
/** A tile with less freshness than this is not kept at all. */
export const MIN_LIFETIME_MS = 10 * SECOND_MS;
/** The longest a browser is told to keep a tile (its cache is per person, so shorter than ours). */
export const MAX_BROWSER_LIFETIME_MS = 24 * 60 * 60 * SECOND_MS;
/**
 * The longest a browser is told to keep a tile of a source that is DATA (a stored source, an
 * ontology default): a source can be edited without its proxy URL changing, and this is how
 * long an old tile can outlive an edit in a browser that already had it.
 */
export const MAX_EDITABLE_BROWSER_LIFETIME_MS = 5 * 60 * SECOND_MS;

/**
 * What can change a source behind its proxy URL: `'fixed'` — only the engine (the closed
 * built-in registry); `'editable'` — an edit of a record, an ontology update, a restore.
 */
export type SourceStability = 'fixed' | 'editable';

/** The directives that keep an answer out of a shared cache. */
const UNSTORABLE: ReadonlySet<string> = new Set(['no-store', 'no-cache', 'private']);

/** `Cache-Control` as name → value (value '' for a bare directive); names lower-cased, quotes dropped. */
export function parseCacheControl(header: string | undefined): Map<string, string> {
	const directives = new Map<string, string>();
	for (const part of (header ?? '').split(',')) {
		const [rawName = '', ...rest] = part.split('=');
		const name = rawName.trim().toLowerCase();
		if (name !== '' && !directives.has(name)) {
			directives.set(name, rest.join('=').trim().replace(/^"|"$/g, ''));
		}
	}
	return directives;
}

/** A delta-seconds value as milliseconds; null when it is not one (the caller reads that as stale). */
function secondsToMs(raw: string | undefined): number | null {
	if (raw === undefined || !/^[0-9]{1,10}$/.test(raw)) return null;
	return Number(raw) * SECOND_MS;
}

/** The freshness the directives state: s-maxage, else max-age; undefined when neither is there. */
function directiveFreshness(directives: Map<string, string>): number | null | undefined {
	for (const name of ['s-maxage', 'max-age']) {
		if (directives.has(name)) return secondsToMs(directives.get(name));
	}
	return undefined;
}

/** `Expires` minus `Date` (or minus now when `Date` is absent or unreadable), in ms; 0 when stale or unreadable. */
function expiresFreshness(headers: Readonly<Record<string, string>>, nowMs: number): number {
	const expires = Date.parse(headers.expires ?? '');
	if (Number.isNaN(expires)) return 0;
	const date = Date.parse(headers.date ?? '');
	return Math.max(0, expires - (Number.isNaN(date) ? nowMs : date));
}

/**
 * The freshness of an answer in ms, or null when it must not be kept (the provider
 * said so). `headers` are the response headers by lower-case name; `defaultMs` is the
 * origin's default for an answer that states none.
 */
export function freshnessMs(
	headers: Readonly<Record<string, string>>,
	nowMs: number,
	defaultMs: number,
): number | null {
	const directives = parseCacheControl(headers['cache-control']);
	if ([...UNSTORABLE].some((name) => directives.has(name))) return null;
	const stated = directiveFreshness(directives);
	const heuristic = headers.expires === undefined ? defaultMs : expiresFreshness(headers, nowMs);
	const fresh = stated === undefined ? heuristic : (stated ?? 0);
	const age = secondsToMs(headers.age) ?? 0;
	return Math.max(0, fresh - age);
}

/**
 * How long the SHARED cache may keep an answer: its freshness clamped to
 * `MAX_LIFETIME_MS`, or 0 (do not keep) when the provider forbade it or too little is left.
 */
export function keepLifetimeMs(
	headers: Readonly<Record<string, string>>,
	nowMs: number,
	defaultMs: number,
): number {
	const fresh = freshnessMs(headers, nowMs, defaultMs);
	if (fresh === null || fresh < MIN_LIFETIME_MS) return 0;
	return Math.min(fresh, MAX_LIFETIME_MS);
}

/**
 * The `Cache-Control` value for the BROWSER, from the freshness left (`freshnessMs`, or the
 * time a cached tile has left): `private` always (the route is authenticated),
 * `no-store` when the provider forbade keeping the tile (null), else the time left, up to
 * a day (`'fixed'`) or a few minutes (`'editable'`, see the header).
 */
export function browserCacheControl(
	freshLeftMs: number | null,
	stability: SourceStability,
): string {
	if (freshLeftMs === null) return 'private, no-store';
	const ceiling =
		stability === 'fixed' ? MAX_BROWSER_LIFETIME_MS : MAX_EDITABLE_BROWSER_LIFETIME_MS;
	const seconds = Math.floor(Math.min(freshLeftMs, ceiling) / SECOND_MS);
	return `private, max-age=${seconds}`;
}

/**
 * How long a BROWSER is told it may remember that the provider has no tile for an address. The
 * proxy itself remembers nothing of the kind (tile_cache.ts keeps only successful images): this
 * is the browser's own, per-person cache, which is what stops a viewer panning over ground a
 * source does not cover from asking — and being charged a call — for the same missing tile on
 * every pan. A provider that renders on demand, or a record that was just fixed, is asked again
 * after this.
 */
export const ABSENT_BROWSER_LIFETIME_MS = 2 * 60 * SECOND_MS;

/**
 * The `Cache-Control` value for "the provider has no such tile": `private`, for
 * `ABSENT_BROWSER_LIFETIME_MS`. A constant: nothing on the server's side is remembered, so there
 * is no "time left" to report.
 */
export function absentCacheControl(): string {
	return `private, max-age=${ABSENT_BROWSER_LIFETIME_MS / SECOND_MS}`;
}
