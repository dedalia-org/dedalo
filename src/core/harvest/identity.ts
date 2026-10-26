/**
 * Who the harvesting door says it is — a leaf module, so the robots.txt reader
 * (`robots.ts`) and the door (`harvest.ts`) share ONE identity without importing
 * each other.
 *
 * The product token is what a webmaster writes in `User-agent:` to address us;
 * the User-Agent header carries it first, then the RELEASE IDENTITY and where a
 * webmaster reads what this crawler is (RFC 9309 §2.2.1: the token is the
 * leading `[a-zA-Z_-]+` of the header value).
 *
 * The identity (`7.0.0-beta.6`, `7.0.0`, `7.0.0-dev`), not the data version:
 * the header names the SOFTWARE that made the request, so a webmaster's log
 * (or a bug report quoting it) tells a beta from the stable release it
 * precedes (release identity design Q10; WC-2026-10-15-release-identity-from-tag).
 * Every identity is valid `product-version` token text (RFC 9110 §10.1.5).
 */

import { DEDALO_ENGINE_VERSION } from '../update/build_stamp.ts';

/** The product token robots.txt groups match on (case-insensitively). */
export const ROBOTS_PRODUCT_TOKEN = 'dedalo';

/** Sent on every request the door makes, robots.txt included. Never the caller's. */
export const HARVEST_USER_AGENT = `${ROBOTS_PRODUCT_TOKEN}/${DEDALO_ENGINE_VERSION} (+https://dedalo.dev; heritage cataloguing)`;
