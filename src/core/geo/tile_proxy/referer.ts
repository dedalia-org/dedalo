/**
 * THE REFERER THE TILE PROXY SENDS — the installation's public origin, for the providers
 * whose terms ask for one (`ProviderTerms.sendReferer`), and ONLY when it is an origin an
 * outside machine could reach.
 *
 * OpenStreetMap's tile policy asks a server that proxies tiles not to strip or blank the
 * Referer: it is how a webmaster tells which site a tile load comes from. The browser's
 * own request to the proxy is same-origin, so the page address that would have been the
 * Referer is the installation's own — and the proxy, which has no page of its own to
 * quote, sends the ORIGIN alone (scheme, host, port; never a path or a query, never the
 * record a viewer is looking at). That is what a browser sends cross-origin under the
 * app's `Referrer-Policy: strict-origin-when-cross-origin`.
 *
 * WHERE IT SENDS LESS THAN THE BROWSER DID, on purpose. A browser on an installation that
 * is reachable only from its own network (DEDALO_HOST unset, `localhost`, a private IP, a
 * `.local` name, a single label) used to send that origin to OpenStreetMap as the Referer.
 * The proxy does not: this is the rule the geo services' User-Agent follows too
 * (`resolve/public_reach.ts`, ONE rule for all three senders), because an internal origin published to a
 * third party is a map of the network for nothing, and a request that now comes from the
 * SERVER is one decision for the whole installation, not one browser's habit. Such an
 * installation still identifies itself to OpenStreetMap by the door's shared `User-Agent`
 * (`dedalo/<release> (+https://dedalo.dev; heritage cataloguing)`); an installation that
 * HAS a public origin is named as the contact instead (`dedalo/<release> (+<origin>)`,
 * harvest/installation_identity.ts) — the very origin this Referer carries, one derivation,
 * so the two are present together, absent together and byte-equal. OpenStreetMap's policy
 * asks a proxy for the Referer and for an identity of the service and may block traffic that
 * carries neither; what it does with a request from such an installation was NOT confirmed
 * against the live service: if an installation behind a private address finds its
 * OpenStreetMap base layer refused, the fix is a public `DEDALO_HOST`, not a code path here
 * (docs/core/system/map_tile_proxy.md).
 *
 * Read per call: this module holds no copy of the configuration.
 */

import { reachablePublicOrigin } from '../../resolve/public_reach.ts';

/**
 * The Referer value (`<origin>/`), or null when the installation has no origin a provider
 * could use. Checked, never repaired: a configured value that is not a clean origin
 * (credentials, a path, a query, a control character, over the length) is left out whole.
 */
export function tileReferer(): string | null {
	const origin = reachablePublicOrigin();
	return origin === null ? null : `${origin}/`;
}
