/**
 * Who an INSTALLATION says it is to a provider whose users it serves — the interactive
 * profile's `User-Agent` (`harvest.ts`), on every interactive request (every built-in map
 * source and every stored one).
 *
 * The harvesting door's own identity (`identity.ts`) is ONE string for every installation of
 * a release: right for a crawler, whose webmaster wants to read what Dédalo is. A map relay
 * is different. It carries the tile requests of an installation's viewers to a provider with
 * a usage policy, and that policy (OpenStreetMap's tile policy, for the one built-in that has
 * one) asks a relay for a clear, CONTACTABLE identity of the organisation/service and forbids
 * a generic proxy identity that tunnels every client behind one name: with the door's string
 * alone the provider sees a single "dedalo" for every installation worldwide, cannot tell one
 * abusive installation from the rest, and a block of that string would take the base map of
 * all of them down together.
 *
 * So the interactive profile names the INSTALLATION as the party to contact, in the `+URL`
 * comment convention, when it has a public origin:
 *
 *   dedalo/<release identity> (+https://museum.example.org)
 *
 * The origin is the SAME one, byte for byte, that the tile `Referer` and the geo services'
 * `User-Agent` send: ONE derivation (`reachablePublicOrigin`, `resolve/public_reach.ts`), the
 * configured `DEDALO_PROTOCOL` + `DEDALO_HOST` parsed once per call, never a request header.
 * It is an origin only when the configured value is a clean http(s) origin an outside machine
 * could reach (no credentials, path, query, fragment or control character; canonical, ASCII
 * or punycode, at most 100 characters). No new configuration key.
 *
 * THE FALLBACK. An installation with no such origin (unset, loopback, a private address, an
 * intranet name, a malformed host — or a value that carries credentials, a path or a query,
 * which is not repaired into a contact the operator never wrote) has no address an outside
 * party could contact: it sends the door's shared identity (`HARVEST_USER_AGENT`,
 * `+https://dedalo.dev`), the LESS identifying one — every such installation looks the same
 * to a provider — and, by the same rule, no `Referer`. Nothing is refused: the OpenStreetMap
 * built-in keeps working. If OpenStreetMap ever blocks that shared identity, the fix is a
 * public `DEDALO_HOST` (docs/core/system/map_tile_proxy.md), not a code path here.
 *
 * The default profile's `User-Agent` is not this one and does not change with the
 * installation's address. A caller never sets `User-Agent` on either profile.
 */

import { reachablePublicOrigin } from '../resolve/public_reach.ts';
import { DEDALO_ENGINE_VERSION } from '../update/build_stamp.ts';
import { HARVEST_USER_AGENT, ROBOTS_PRODUCT_TOKEN } from './identity.ts';

/** The `User-Agent` of an interactive request: the installation as contact, else the shared identity. */
export function installationUserAgent(): string {
	const origin = reachablePublicOrigin();
	if (origin === null) return HARVEST_USER_AGENT;
	return `${ROBOTS_PRODUCT_TOKEN}/${DEDALO_ENGINE_VERSION} (+${origin})`;
}
