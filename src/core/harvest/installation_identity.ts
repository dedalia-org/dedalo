/**
 * Who an INSTALLATION says it is to a provider whose users it serves — the interactive
 * profile's `User-Agent` (`harvest.ts`).
 *
 * The harvesting door's own identity (`identity.ts`) is ONE string for every installation of
 * a release: right for a crawler, whose webmaster wants to read what Dédalo is. A map relay
 * is different. It carries the tile requests of an installation's viewers to a provider with
 * a usage policy, and that policy (OpenStreetMap's, for the one built-in that has one) asks a
 * relay for a clear, CONTACTABLE identity of the service and forbids tunnelling every client
 * behind one anonymous identity: with the door's string alone the provider sees a single
 * "dedalo" for every installation worldwide, cannot tell one abusive installation from the
 * rest, and a block of that string would take the base map of all of them down together.
 *
 * So the interactive profile appends the installation's PUBLIC ORIGIN when an outside machine
 * could reach it (`resolve/public_reach.ts`, the one rule the geo services' `User-Agent` and
 * the tile `Referer` follow too):
 *
 *   dedalo/<release identity> (+https://dedalo.dev; heritage cataloguing; https://museum.example.org)
 *
 * An installation reachable only from its own network has no origin to give, and an internal
 * hostname published to a third party is a map of that network for nothing: it keeps the
 * door's plain identity, which is also what a provider sees from every other such
 * installation. That is a limit of the policy, not a code path: such an installation that
 * finds its OpenStreetMap base layer refused needs a public `DEDALO_HOST`
 * (docs/core/system/map_tile_proxy.md).
 *
 * Read per call (the two config reads of `publicOrigin`): this module holds no copy of the
 * configuration. Nothing a client sent reaches it.
 */

import { reachablePublicOrigin } from '../resolve/public_reach.ts';
import { HARVEST_USER_AGENT } from './identity.ts';

/** The `User-Agent` of an interactive request: the door's identity, plus the installation's origin when it has one. */
export function installationUserAgent(): string {
	const origin = reachablePublicOrigin();
	if (origin === null) return HARVEST_USER_AGENT;
	return `${HARVEST_USER_AGENT.slice(0, -1)}; ${origin})`;
}
