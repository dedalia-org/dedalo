/**
 * IS THE INSTALLATION'S PUBLIC ORIGIN ONE AN OUTSIDE MACHINE COULD REACH — the one
 * answer, for everything the engine says about itself to a third party.
 *
 * Two senders put the installation's origin in a request to a provider: the geo services'
 * `User-Agent` (`geo_services/user_agent.ts`) and the map tile proxy's `Referer`
 * (`geo/tile_proxy/referer.ts`). Both used to carry their own copy of the rule, and a
 * copy drifts: one would have started sending an internal hostname to OpenStreetMap while
 * the other still withheld it. The rule is here, once, and both import it
 * (`test/unit/map_tile_geometry_native.test.ts` drives the two senders over one table of
 * hosts, so a third copy is caught by outcome, not by spelling).
 *
 * THE RULE. An origin goes to a provider only when it is an `http(s)` origin whose host is
 * reachable from outside: not unset, not a loopback name or address, not a private or
 * reserved IP literal (RFC 1918, ULA, link-local, shared address space, documentation…),
 * not a single-label name (`intranet-srv01`) and not a name under a suffix no outside
 * resolver answers (`.local`, `.internal`, `.lan`, `.home.arpa`, `.test`…). Such an origin
 * means something only inside the installation's own network, so publishing it to a third
 * party would be a map of that network for nothing, and a provider can do nothing with it.
 * The loopback and private predicates are the SSRF guard's own (`isLoopbackHost`,
 * `isPrivateIp`: the ONE owner of "which address is private"); no range table is copied.
 *
 * A part is checked, not repaired: it joins a header only if the whole of it is in a
 * conservative character set and at most 100 characters; otherwise it is left out whole.
 * Stripping would publish a different host than the one configured, and cutting a long one
 * a prefix that names someone else. Nothing configured can carry a delimiter, a control
 * character or a non-ASCII byte into a header.
 *
 * Read per call (the two config reads of `publicOrigin`): this module holds no copy of the
 * configuration.
 */

import { isIP } from 'node:net';
import { isLoopbackHost, isPrivateIp } from '../security/ssrf_guard.ts';
import { publicOrigin } from './public_origin.ts';

/**
 * Suffixes no outside resolver answers: the special-use names (RFC 6761 `test`,
 * `example`, `invalid`, `localhost`; RFC 6762 `local`; RFC 8375 `home.arpa`; RFC 7686
 * `onion`) and the ones networks conventionally keep private. A host equal to a suffix is
 * under it.
 */
const UNREACHABLE_SUFFIXES: readonly string[] = Object.freeze([
	'corp',
	'example',
	'home',
	'home.arpa',
	'internal',
	'intranet',
	'invalid',
	'lan',
	'local',
	'localdomain',
	'localhost',
	'onion',
	'private',
	'test',
]);

/** The longest origin that joins a header: a longer one is left out, never cut. */
const MAX_ORIGIN_LENGTH = 100;

/** An origin as it may stand in a header: scheme, host (an IPv6 literal bracketed), port. */
const SAFE_ORIGIN = /^https?:\/\/[A-Za-z0-9._:[\]-]+$/;

/** True when an outside machine could resolve and reach `hostname` (a `URL.hostname`). */
export function isReachableFromOutside(hostname: string): boolean {
	const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
	const name = host.endsWith('.') ? host.slice(0, -1) : host;
	if (isLoopbackHost(name)) return false;
	if (isIP(name) !== 0) return !isPrivateIp(name);
	if (!name.includes('.')) return false;
	return !UNREACHABLE_SUFFIXES.some((suffix) => name === suffix || name.endsWith(`.${suffix}`));
}

/** True when `url` parsed and is an http(s) address (an origin a provider could be told about). */
function isWebUrl(url: URL | null): url is URL {
	return url !== null && (url.protocol === 'https:' || url.protocol === 'http:');
}

/** True when `origin` is short enough and in the conservative character set to stand in a header. */
function fitsInHeader(origin: string): boolean {
	return origin.length <= MAX_ORIGIN_LENGTH && SAFE_ORIGIN.test(origin);
}

/**
 * The configured public origin, canonical (`https://museum.example.org`, no path, no
 * credentials, a default port dropped), when a provider could reach it AND it is safe to put
 * in a header; null otherwise.
 */
export function reachablePublicOrigin(): string | null {
	const url = URL.parse(publicOrigin());
	if (!isWebUrl(url) || !isReachableFromOutside(url.hostname)) return null;
	return fitsInHeader(url.origin) ? url.origin : null;
}
