/**
 * THE TILE MEMORY — a small cache of the tiles the proxy relayed, bounded BY BYTES AND BY
 * COUNT, whose admission costs the same however full it is.
 *
 * A viewer pans and zooms over the same few tiles, and every provider asks to be spared
 * the repeats (OpenStreetMap's policy asks for the server's caching headers to be
 * honoured). The memory answers an identical upstream request from bytes already held.
 *
 * WHAT IS KEPT, and why it may be shared between viewers:
 *   - the bytes and the media type of a SUCCESSFUL, VERIFIED image answer (the route stores
 *     nothing else: not a failure, not a redirect, not an HTML page, not an image whose
 *     bytes are not the type it claims), for the time the provider's own headers allow,
 *     clamped (freshness.ts);
 *   - keyed by the UPSTREAM ADDRESS the server built. The key holds no user, session,
 *     language or record: it is the question asked of the provider, and the answer is the
 *     provider's, the same for everyone who may ask it. (The address may carry a provider
 *     token — the key lives in memory only and is never logged, listed or returned.)
 *
 * WHO CHECKS PERMISSION. Not this module, and it must not need to: the route resolves the
 * session, the component grant, the record scope and the source BEFORE it builds the
 * address, and so before it looks here. A hit can only answer a caller who was already
 * allowed to ask for that very source (api/map_tile.ts, gated by map_tile_proxy_native).
 * The order is the whole safety of sharing; putting a user into the key would hide a
 * reordering, not prevent one.
 *
 * HOW MUCH, in two bounds. `TOTAL_BYTES` in all, and `MAX_ENTRIES` in count.
 *   - Every entry COSTS at least `MIN_ENTRY_COST_BYTES`, whatever its bytes: an entry is a
 *     Map slot, a record, a typed array and a key string, so a 70-byte tile is not a
 *     70-byte entry. Without the floor a stored source hosted by an editor (one valid
 *     70-byte PNG per `{z}/{x}/{y}` — about as many distinct keys as the grammar allows)
 *     would fill the byte budget with a hundred thousand entries.
 *   - `MAX_ENTRIES` is the hard ceiling on the Map itself, so its size does not depend on
 *     what a provider chooses to send.
 *   An entry larger than `ENTRY_BYTES` is served but not kept.
 *
 * ADMISSION IS CONSTANT-TIME in the size of the memory. The byte total is a running number
 * kept in step with the Map (added on set, taken off on delete), never recomputed by a
 * scan; making room evicts from the OLDEST end only (a Map iterates in insertion order, and
 * an entry stored again is re-inserted at the newest end), one entry at a time, until the
 * newcomer fits. A STALE entry is dropped when it is asked for and when eviction reaches it;
 * there is no sweep, because a stale entry costs only the bytes it was already budgeted and
 * is the first to go once it is the oldest. The first draft rescanned every entry on every
 * admission (to drop the stale and to add up the bytes): measured with 70 000 tiny entries,
 * 0.65 ms of blocked event loop per new tile and about 20 s of it to fill. The gate fills
 * the memory with tiny tiles and compares the cost of the last admissions with the first
 * (a wide margin, so a scan is caught and a busy machine is not), and checks the running
 * total against the arithmetic of the entries it holds.
 *
 * Lifecycle (`module_state_tripwire` lists the maps and the running total): TIME-CLEARED
 * and SIZE-BOUNDED. The process restarting forgets it all, which is correct: it is a
 * courtesy to providers, never a source of truth. `clearTileCacheForTests` empties it for
 * gate isolation.
 *
 * WHAT IS NOT KEPT, said plainly: only a successful, verified image is. The provider's "no such
 * tile" (a 404, a 410, no content) is not remembered here, nor is any failure: the maintainers'
 * decision for this memory is a cache of successful image responses and nothing else, and a
 * second shared store for refusals would be one more thing a source that answers 404 to every
 * distinct `{z}/{x}/{y}` could fill. What stops a viewer asking again for the same missing tile
 * is the browser's own cache (`freshness.ts` `absentCacheControl`), which is per person.
 *
 * REVALIDATION (validators.ts). A tile that has run out of freshness and came with a validator
 * (`ETag`, `Last-Modified`) is kept as a STALE entry for `STALE_RETENTION_MS` more and is not
 * served: `recallStale` hands it to the route, which asks the provider conditionally; a `304`
 * renews it (`rememberTile` again, new freshness) and a `200` replaces it. A tile with no
 * validator has nothing to ask with and is dropped at its expiry, as before. A stale entry costs
 * what it always cost, is the same Map slot and goes first when it is the oldest, so it needs no
 * sweep and no second bound.
 */

import type { TileValidators } from './validators.ts';

/** The most the memory holds, in bytes (the cost of every entry). */
const TOTAL_BYTES = 32 * 1024 * 1024;

/** A tile whose entry costs more than this is served but not kept. */
const ENTRY_BYTES = 512 * 1024;

/** What an entry costs beyond its bytes and its key (the Map slot, the record, the typed array). */
const ENTRY_OVERHEAD_BYTES = 128;

/** No entry costs less than this: a tiny tile is still a whole entry in memory. */
const MIN_ENTRY_COST_BYTES = 1024;

/** The most entries the memory holds, whatever they cost. */
const MAX_ENTRIES = 16_384;

/**
 * How long past its freshness a tile with a validator stays in the memory to be revalidated.
 * Without a bound an entry nobody asks for again would wait for eviction alone; a week matches
 * the longest freshness the memory grants.
 */
const STALE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** The limits, for the gate. */
export const TILE_CACHE_LIMITS = Object.freeze({
	totalBytes: TOTAL_BYTES,
	entryBytes: ENTRY_BYTES,
	overheadBytes: ENTRY_OVERHEAD_BYTES,
	minEntryCostBytes: MIN_ENTRY_COST_BYTES,
	maxEntries: MAX_ENTRIES,
	staleRetentionMs: STALE_RETENTION_MS,
});

/** A kept tile. */
export interface KeptTile {
	readonly bytes: Uint8Array;
	/** The verified media type (`image/png`). */
	readonly contentType: string;
	/** The first moment at which the tile is no longer served. */
	readonly freshUntil: number;
	/** What the entry counts against `TOTAL_BYTES`. */
	readonly cost: number;
	/** What the provider gave to recognise the tile by; null: nothing to revalidate with. */
	readonly validators: TileValidators | null;
}

/** Kept tiles by upstream address, oldest first. */
const TILES = new Map<string, KeptTile>();

/** The bytes the held entries cost, kept in step with `TILES` by `rememberTile` and `forget` alone. */
const RUNNING = { bytes: 0 };

/** What an entry costs: its bytes, its key (UTF-16) and the fixed overhead, never below the floor. */
export function tileCost(key: string, bytes: Uint8Array): number {
	return Math.max(MIN_ENTRY_COST_BYTES, bytes.byteLength + key.length * 2 + ENTRY_OVERHEAD_BYTES);
}

/** Take `key` out of the memory, whatever it holds; true when something was there. */
function forget(key: string): boolean {
	const kept = TILES.get(key);
	if (kept === undefined) return false;
	TILES.delete(key);
	RUNNING.bytes -= kept.cost;
	return true;
}

/** True when `kept` is past its freshness but can still be revalidated at `now`. */
function revalidatable(kept: KeptTile, now: number): boolean {
	return kept.validators !== null && now < kept.freshUntil + STALE_RETENTION_MS;
}

/**
 * The tile kept for `key` that is still fresh at `now`, or null. A stale one is dropped unless
 * it can be revalidated (`recallStale`).
 */
export function recallTile(key: string, now: number): KeptTile | null {
	const kept = TILES.get(key);
	if (kept === undefined) return null;
	if (kept.freshUntil > now) return kept;
	if (!revalidatable(kept, now)) forget(key);
	return null;
}

/**
 * The tile kept for `key` that has run out of freshness but came with a validator and is within
 * its retention: the one the route may ask the provider about conditionally. Null for anything
 * else (a fresh tile is `recallTile`'s; an entry that cannot be revalidated is dropped).
 */
export function recallStale(key: string, now: number): KeptTile | null {
	const kept = TILES.get(key);
	if (kept === undefined || kept.freshUntil > now) return null;
	if (revalidatable(kept, now)) return kept;
	forget(key);
	return null;
}

/** Take `key` out of the memory (the provider now says the tile is gone); true when something was there. */
export function forgetTile(key: string): boolean {
	return forget(key);
}

/** True while the memory cannot take `cost` more bytes or one more entry. */
function lacksRoomFor(cost: number): boolean {
	return RUNNING.bytes + cost > TOTAL_BYTES || TILES.size >= MAX_ENTRIES;
}

/** Evict from the oldest end until `cost` more bytes and one more entry fit. */
function makeRoomFor(cost: number): void {
	while (lacksRoomFor(cost)) {
		const oldest = TILES.keys().next().value;
		if (oldest === undefined) return;
		forget(oldest);
	}
}

/**
 * Keep `bytes` as the answer to `key` for `lifetimeMs` from `now` (and, with `validators`, for
 * `STALE_RETENTION_MS` more as a tile to revalidate). Returns whether it was kept: a non-positive
 * lifetime or an entry over the per-entry ceiling is not (and an older answer for the same key is
 * forgotten rather than left to be served).
 */
export function rememberTile(
	key: string,
	tile: { readonly bytes: Uint8Array; readonly contentType: string },
	lifetimeMs: number,
	now: number,
	validators: TileValidators | null = null,
): boolean {
	const cost = tileCost(key, tile.bytes);
	forget(key);
	if (!(lifetimeMs > 0) || cost > ENTRY_BYTES) return false;
	makeRoomFor(cost);
	TILES.set(key, {
		bytes: tile.bytes,
		contentType: tile.contentType,
		freshUntil: now + lifetimeMs,
		cost,
		validators,
	});
	RUNNING.bytes += cost;
	return true;
}

/** Entries held right now — observability for the gates. */
export function tilesKept(): number {
	return TILES.size;
}

/** Bytes the held entries count against the ceiling — observability for the gates. */
export function tileBytesKept(): number {
	return RUNNING.bytes;
}

/** Forget every kept tile — TEST ISOLATION ONLY. */
export function clearTileCacheForTests(): void {
	TILES.clear();
	RUNNING.bytes = 0;
}
