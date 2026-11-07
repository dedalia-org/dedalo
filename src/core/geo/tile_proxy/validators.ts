/**
 * THE VALIDATORS OF A KEPT TILE — what the provider gave to recognise the tile by, and what the
 * proxy sends back to ask "is it still this one?" once the tile's freshness has run out
 * (RFC 9111 §4.3.2, a conditional request).
 *
 * Why the proxy revalidates at all. A tile that has run out of freshness is not necessarily
 * different: most are not. Fetching it in full again costs the provider the whole image for an
 * answer that says "same", and OpenStreetMap's tile usage policy asks a cache to use
 * `If-None-Match` / `If-Modified-Since` on exactly those. So an expired tile that came with a
 * validator is kept (tile_cache.ts) and asked for conditionally: a `304` renews its freshness
 * and costs the provider a header, a `200` replaces it.
 *
 * What a validator is allowed to be. Both come from the provider's own answer and go back to the
 * SAME provider (the cache key is the upstream address), so neither is an injection route into a
 * request, but both are still checked: an `ETag` must be an entity-tag in the grammar of RFC 9110
 * §8.8.3 (visible ASCII between quotes, optionally weak), a `Last-Modified` must be a date the
 * runtime can read, and neither may be longer than `MAX_VALIDATOR_LENGTH`. Anything else is NO
 * validator — the tile is then served for its freshness and fetched in full when it ends, as ever.
 *
 * PURE: no clock, no state.
 */

/** The longest validator kept or sent: a real entity-tag or HTTP-date is a few dozen characters. */
export const MAX_VALIDATOR_LENGTH = 256;

/** An entity-tag (RFC 9110 §8.8.3): optionally weak, visible ASCII between double quotes. */
const ENTITY_TAG = /^(?:W\/)?"[\x21\x23-\x7e]*"$/;

/** An HTTP-date is printable ASCII, and its shortest form is longer than this. */
const PRINTABLE_ASCII = /^[\x20-\x7e]+$/;

/** What identifies a kept tile at its provider; either may be absent. */
export interface TileValidators {
	readonly etag: string | null;
	readonly lastModified: string | null;
}

function validEtag(value: string | undefined): string | null {
	if (value === undefined) return null;
	const etag = value.trim();
	return etag.length <= MAX_VALIDATOR_LENGTH && ENTITY_TAG.test(etag) ? etag : null;
}

function validDate(value: string | undefined): string | null {
	if (value === undefined) return null;
	const date = value.trim();
	if (date === '' || date.length > MAX_VALIDATOR_LENGTH || !PRINTABLE_ASCII.test(date)) return null;
	return Number.isNaN(Date.parse(date)) ? null : date;
}

/**
 * The validators an answer's headers (by lower-case name) carry, or null when it carries none
 * the proxy would send back: there is then nothing to revalidate with.
 */
export function readValidators(headers: Readonly<Record<string, string>>): TileValidators | null {
	const etag = validEtag(headers.etag);
	const lastModified = validDate(headers['last-modified']);
	return validatorsOrNone(etag, lastModified);
}

/** The pair as validators, or null when neither is known: there is nothing to revalidate with. */
function validatorsOrNone(etag: string | null, lastModified: string | null): TileValidators | null {
	return etag === null && lastModified === null ? null : { etag, lastModified };
}

/** One validator after a `304`: the answered one when stated, else the kept one, else none. */
function renewedValidator(
	answered: TileValidators | null,
	kept: TileValidators | null,
	field: keyof TileValidators,
): string | null {
	return answered?.[field] ?? kept?.[field] ?? null;
}

/**
 * The validators of a tile once a `304` has renewed it: what the `304` states replaces what was
 * kept (RFC 9111 §4.3.4), and what it does not state stays.
 */
export function renewedValidators(
	answered: TileValidators | null,
	kept: TileValidators | null,
): TileValidators | null {
	return validatorsOrNone(
		renewedValidator(answered, kept, 'etag'),
		renewedValidator(answered, kept, 'lastModified'),
	);
}

/**
 * The conditional-request headers for a kept tile's validators, or none: `If-None-Match` from
 * the entity-tag and `If-Modified-Since` from the date, both when both are known (RFC 9110
 * §13.1.3: a server that handles the first ignores the second).
 */
export function validatorHeaders(validators: TileValidators | null): Record<string, string> {
	if (validators === null) return {};
	return {
		...(validators.etag === null ? {} : { 'If-None-Match': validators.etag }),
		...(validators.lastModified === null ? {} : { 'If-Modified-Since': validators.lastModified }),
	};
}
