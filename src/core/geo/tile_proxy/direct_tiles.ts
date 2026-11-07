/**
 * WHO LOADS AN IDENTITY-BOUND PROVIDER — the tile proxy, or the viewer's browser. ONE rule,
 * read by both sides of the decision so they cannot disagree:
 *
 *   - the tile route (`api/map_tile.ts`) refuses to relay a host whose provider asks for the
 *     installation's own identity (`identityRequiredFor`, builtin_sources.ts) when the
 *     installation has none to give (`reachablePublicOrigin() === null`, resolve/public_reach.ts);
 *   - the geolocation structure context tells the client, in `features.tile_direct`, which
 *     built-ins its browser loads directly for exactly that reason (resolve/structure_context.ts).
 *
 * WHY. OpenStreetMap's tile policy lets a relay through only under a clear, contactable
 * identity of the service, never a generic proxy identity that tunnels every client behind one
 * name. An installation with a public origin has one (`dedalo/<release> (+<origin>)`,
 * harvest/installation_identity.ts). One without has only the door's shared identity, the same
 * for every such installation: relaying under it is what the policy forbids, and one block of
 * it would take the base map of all of them down together. So such an installation does not
 * relay the provider, and its viewers' browsers ask the provider themselves — each with its own
 * User-Agent and Referer, the policy's preferred path, and the path the page took before the
 * proxy existed.
 *
 * Read per call (the configured origin is read by `reachablePublicOrigin` each time): this
 * module holds no copy of the configuration, and nothing it returns is cached by a caller.
 * Gate: test/unit/map_tile_proxy_native.test.ts (route) and map_tile_geometry_native.test.ts
 * (one table of configured values drives the senders, this rule and the context field).
 */

import { reachablePublicOrigin } from '../../resolve/public_reach.ts';
import { BUILTIN_SOURCE_IDS, findBuiltinSource, identityRequiredFor } from './builtin_sources.ts';

/** True when the proxy must NOT relay the provider at `hostname` from this installation. */
export function relayWithheld(hostname: string): boolean {
	return identityRequiredFor(hostname) && reachablePublicOrigin() === null;
}

/** The host a built-in's template names (placeholders read as digits), or ''. */
function builtinHost(id: string): string {
	const url = findBuiltinSource(id)?.source.url ?? '';
	return URL.parse(url.replace(/\{(?:z|x|y)\}/g, '0'))?.hostname ?? '';
}

/**
 * The built-ins this installation's browsers load DIRECTLY (`features.tile_direct`): exactly
 * the ids whose host the route withholds, in registry order; empty where the installation has
 * a public origin.
 */
export function directBuiltinIds(): string[] {
	return BUILTIN_SOURCE_IDS.filter((id) => relayWithheld(builtinHost(id)));
}
