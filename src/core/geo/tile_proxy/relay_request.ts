/**
 * THE REQUEST THE TILE PROXY HANDS THE DOOR — built from the source it resolved, the
 * address it built and the terms of the ORIGIN, and from nothing a client chose.
 *
 * It is a module of its own, apart from the route, so that its duties can be driven with
 * numbers the registry does not hold: the route's registry rows owe no spacing today
 * (OpenStreetMap's policy states none), so a gate on the route alone could not tell the
 * request that passes the origin's spacing from one that forgets to. `relay_request`'s gate
 * (map_tile_geometry_native) builds the request with a synthetic `ProviderTerms` and pushes
 * two of them through the real door under a fake clock: the second start is spaced from the
 * first by exactly the terms' `minIntervalMs`, and a request built without it is not.
 *
 * WHAT IT FIXES:
 *   - `hosts: [the template's host]`  the redirect allowlist: a stored address that redirects
 *                                     elsewhere is refused by the door, not followed;
 *   - `mediaTypes`                    the exact types the address allows (never a prefix);
 *   - `addressFrom`                   who chose the host, as the SOURCE says (a stored source is
 *                                     `'stored'` whatever host it names);
 *   - `holder`                        who is waiting: the session's user (`holderOf`), so one
 *                                     person's stored hops hold only a few of the shared slots;
 *   - `headers`                       `Accept`, `Referer` ONLY where the origin's terms ask for
 *                                     one and the installation has an origin to send, and — when
 *                                     the route is revalidating a tile it kept — the validators
 *                                     THE PROVIDER gave for that tile (`If-None-Match`,
 *                                     `If-Modified-Since`: validators.ts), never anything else;
 *   - `maxBytes`, and for a stored address a shorter `timeoutMs`: an editor's slow host holds
 *                                     its slots for a shorter hop than a registry one;
 *   - `minIntervalMs`                 the spacing the ORIGIN is owed, on EVERY request to it
 *                                     (the terms are a property of the origin, so a stored source
 *                                     on a registry host passes the registry host's).
 *
 * PURE but for `tileReferer`, which reads the configured public origin per call.
 */

import type { InteractiveRequest } from '../../harvest/harvest.ts';
import type { ProviderTerms } from './builtin_sources.ts';
import { tileReferer } from './referer.ts';
import type { ResolvedTileSource } from './tile_source.ts';
import type { UpstreamRequest } from './upstream_url.ts';
import { type TileValidators, validatorHeaders } from './validators.ts';

/** The most bytes one relayed image may have (the door's own ceiling is the outer bound). */
export const TILE_MAX_BYTES = 2 * 1024 * 1024;

/** A stored address is an editor's choice: a slow host holds its slots for a shorter hop than a registry one. */
export const STORED_TIMEOUT_MS = 6_000;

/**
 * The holder name the door counts a person's hops under: the user id the session
 * established, never anything the client sent.
 */
export function holderOf(userId: number): string {
	return `user:${userId}`;
}

/** The door's request for this source: an allowlist of the template's host, the origin's terms, nothing a client chose. */
export function relayRequest(
	resolved: Pick<ResolvedTileSource, 'addressFrom'>,
	upstream: UpstreamRequest,
	terms: ProviderTerms,
	userId: number,
	validators: TileValidators | null = null,
): InteractiveRequest {
	const referer = terms.sendReferer ? tileReferer() : null;
	return {
		url: upstream.url,
		hosts: [upstream.host],
		mediaTypes: upstream.mediaTypes,
		addressFrom: resolved.addressFrom,
		holder: holderOf(userId),
		headers: {
			Accept: upstream.mediaTypes.join(','),
			...(referer === null ? {} : { Referer: referer }),
			...validatorHeaders(validators),
		},
		maxBytes: TILE_MAX_BYTES,
		...(resolved.addressFrom === 'stored' ? { timeoutMs: STORED_TIMEOUT_MS } : {}),
		minIntervalMs: terms.minIntervalMs,
	};
}
