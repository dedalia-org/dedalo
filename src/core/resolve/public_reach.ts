/**
 * IS THE INSTALLATION'S PUBLIC ORIGIN ONE AN OUTSIDE MACHINE COULD REACH — the one
 * answer, for everything the engine says about itself to a third party.
 *
 * Three senders put the installation's origin in a request to a provider: the geo services'
 * `User-Agent` (`geo_services/user_agent.ts`), the map tile proxy's `Referer`
 * (`geo/tile_proxy/referer.ts`) and the interactive door's `User-Agent`, which names the
 * installation as the party to contact (`harvest/installation_identity.ts`). They used to
 * carry their own copy of the rule (the contact identity even a stricter second reading of
 * the configured value), and a copy drifts: one sender would publish an origin another
 * withheld. The rule is here, once, as ONE derivation all three import
 * (`test/unit/map_tile_geometry_native.test.ts` drives the three senders over one table of
 * configured values and asserts byte-equal origins, present or absent together, so a second
 * copy is caught by outcome, not by spelling).
 *
 * THE RULE. The configured value (`DEDALO_PROTOCOL` + `DEDALO_HOST`) is parsed ONCE, as a
 * WHATWG URL, and that one parsed value is judged. An UNSET `DEDALO_HOST` yields nothing
 * before any parse (`publicOrigin`'s `localhost` fallback builds URLs, it names no one). It
 * yields an origin only when it is:
 *
 *   - free of control characters and whitespace as configured (URL parsing would silently
 *     drop a tab or a newline; a value that carries one is not what the operator meant);
 *   - an `http:` or `https:` URL, in any spelling URL parsing reads as one (`HTTPS://`,
 *     `https:host`): the scheme's case and slashes do not change the origin. This is the
 *     ONE scheme check (`WEB_SCHEMES` in the rule module; the header character set judges
 *     the host part only);
 *   - on a port a connection could use: an explicit port 0 yields nothing;
 *   - a BARE origin: no credentials, no path but `/`, no query, no fragment (not even an
 *     empty `?` or `#`). Such a value is not repaired into an origin the operator never
 *     wrote: it yields NOTHING, for every sender (the shared-identity fallback applies);
 *   - reachable from outside (`isReachableFromOutside`): not a loopback name or address, not
 *     a private or reserved IP literal (RFC 1918, ULA, link-local, shared address space,
 *     documentation…), a well-formed host name (labels of 1–63 letters, digits and hyphens,
 *     no hyphen at either end, no empty label but one trailing dot) of at least two labels,
 *     not under a suffix no outside resolver answers (`.local`, `.internal`, `.lan`, `.arpa`,
 *     `.alt`, `.test`…). An internal origin published to a third party is a map of that
 *     network for nothing, and a provider can do nothing with it;
 *   - at most 100 characters as a CANONICAL origin, which is what is sent: a longer one is
 *     left out whole, never cut (a prefix would name someone else).
 *
 * What URL parsing canonicalizes names the SAME origin and is accepted: the host's case, an
 * IDN host (sent as its punycode, so the header stays ASCII), a default or zero-padded port,
 * a trailing `/`. The output is always `scheme://ascii-host[:port]`: no delimiter, control
 * character or non-ASCII byte can reach a header. The loopback and private predicates are
 * the SSRF guard's own (`isLoopbackHost`, `isPrivateIp`: the ONE owner of "which address is
 * private"); no range table is copied.
 *
 * Read per call (`DEDALO_HOST`, then the two config reads of `publicOrigin`): this module
 * holds no copy of the configuration.
 */

import { readString } from '../../config/readers.ts';
import { currentNat64Context } from '../security/ssrf_guard.ts';
import { publicOrigin } from './public_origin.ts';
import { identifiableOrigin } from './public_reach_rule.ts';

// The rule's tables and its one judgement live in the CONFIG-FREE `public_reach_rule.ts`
// (the terminal installer validates a public-address answer with the same function before
// any configuration exists); this module is the configured-value door the senders import.
export { identifiableOrigin, isReachableFromOutside } from './public_reach_rule.ts';

/**
 * The configured public origin, canonical (`https://museum.example.org`), when a provider
 * could reach it AND it is a clean origin safe to put in a header; null otherwise. Every
 * sender reads it here, so the `User-Agent`s and the `Referer` agree byte for byte.
 */
export function reachablePublicOrigin(): string | null {
	// `publicOrigin()`'s `localhost` fallback is a URL-construction default (update manifests
	// on a developer box), never an identity: glued onto a DEDALO_PROTOCOL that carries a host
	// (`https://museum.example.org` + unset host → `https://museum.example.orglocalhost`) it
	// would name a host nobody configured. An unset host names NOTHING to a third party.
	if (readString('DEDALO_HOST') === '') return null;
	return identifiableOrigin(publicOrigin(), currentNat64Context());
}
