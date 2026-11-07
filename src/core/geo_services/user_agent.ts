/**
 * WHO THE GEO SERVICES SAY THEY ARE.
 *
 * Nominatim's usage policy does not accept a stock User-Agent: the request must
 * identify the application, and OpenStreetMap's tile policy asks for one a webmaster
 * can act on. Every geo service sends the same header, built from what the
 * installation already says about itself — no key of its own:
 *
 *   dedalo/<release identity> (+https://dedalo.dev; <this installation's public origin>)
 *
 *   - the product token and the RELEASE IDENTITY, the harvesting door's (a beta tells
 *     itself from the stable release it precedes in a provider's log);
 *   - the project's site, so a provider can read what Dédalo is;
 *   - the installation's PUBLIC ORIGIN (`DEDALO_PROTOCOL` + `DEDALO_HOST`), and only an
 *     origin a provider could reach: it is left out when the host is unset, a loopback
 *     name or address, a private or reserved IP literal (RFC 1918, ULA, link-local…), a
 *     single-label name (`intranet-srv01`) or a name under a suffix no outside resolver
 *     answers (`.local`, `.internal`, `.lan`, `.home.arpa`, `.test`…). That origin is
 *     sent to five third parties on every call, so an installation whose address means
 *     something only inside its own network must not publish it: the header would be
 *     a map of that network, and a provider can do nothing with it. The rule is
 *     `resolve/public_reach.ts`'s, shared with the tile proxy's Referer
 *     (`geo/tile_proxy/referer.ts`) so the two senders cannot disagree about it.
 *
 * NO PERSON'S ADDRESS IS EVER SENT. An earlier draft added the From address of the
 * installation's outgoing mail (`DEDALO_SMTP_FROM`) as a contact. That key configures the
 * mailer, not a statement about who to write to: an installation that set it up for
 * password-reset mail would have started telling five providers a curator's address on every
 * call, with no way to refuse short of disabling its mail. A contact is a decision, so it
 * would be a key of its own, opt-in and empty by default (a catalog change for the
 * maintainer); until one exists the header carries the origin alone.
 *
 * A part is checked, not repaired: it joins the header only if the whole of it is in a
 * conservative character set and at most 100 characters; otherwise it is left out whole.
 * Stripping would publish a different host than the one configured, and cutting a long
 * one a prefix that names someone else. Nothing configured can carry a delimiter, a
 * control character or a non-ASCII byte into the header.
 *
 * Read per call (the two config reads of `publicOrigin`): this module holds no copy of
 * the configuration.
 */

import { ROBOTS_PRODUCT_TOKEN } from '../harvest/identity.ts';
import { reachablePublicOrigin } from '../resolve/public_reach.ts';
import { DEDALO_ENGINE_VERSION } from '../update/build_stamp.ts';

/** The project's site: what a provider reads to learn what Dédalo is. */
const PROJECT_SITE = '+https://dedalo.dev';

/** The User-Agent every geo service call sends. */
export function geoUserAgent(): string {
	const parts = [PROJECT_SITE, reachablePublicOrigin() ?? ''].filter((part) => part !== '');
	return `${ROBOTS_PRODUCT_TOKEN}/${DEDALO_ENGINE_VERSION} (${parts.join('; ')})`;
}
