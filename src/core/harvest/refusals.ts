/**
 * The harvesting door's own refusals — the `harvest.*` codes, built in ONE place.
 *
 * A cataloguer who pasted a URL must learn WHY it was not fetched: which site,
 * and what rule said no. So every `harvest.*` code puts `site` on the wire (and
 * `harvest.refused` its `reason` token), under `details_keys` the registry
 * declares — and nothing else. What `site` may be is the disclosure rule:
 *
 *   - the ORIGIN (scheme, host, port) the CALLER asked for — never a path, a
 *     query or credentials, never a resolved address. A redirect's target is
 *     chosen by the remote server and has not been vetted when a policy refuses
 *     it, so its host rides only in the LOG-ONLY `coordinates`;
 *   - for every ROBOTS verdict — `harvest.robots_disallowed`,
 *     `harvest.robots_unavailable`, and `harvest.refused` reasons
 *     `robots_too_complex` and `robots_redirect_refused` — the origin whose
 *     robots.txt decided. That origin
 *     already answered from a public address (its robots.txt request passed the
 *     SSRF guard), and naming it is the point: after a redirect it is the site
 *     that said no, not the one the cataloguer pasted;
 *   - for caller text that is not a URL at all, the fixed `UNPARSEABLE_SITE`
 *     token: such text has no origin, and echoing it would put whatever it holds
 *     (a path, a query, a password) into the public details.
 *
 * Address refusals are NOT here: they stay `security.ssrf_blocked` (operator
 * disclosure — core/security/ssrf_guard.ts), because naming what an address
 * resolved to is exactly the internal-network oracle that code exists to deny.
 */

import { DedaloError, isDedaloError } from '../errors/index.ts';

/**
 * Why the harvesting rules refused a request. The token travels on the wire as
 * `details.reason`, beside the English sentence below.
 */
export type HarvestRefusalReason =
	| 'unparseable'
	| 'protocol'
	| 'credentials'
	| 'url_too_long'
	| 'requires_https'
	| 'downgrade'
	| 'host_not_allowed'
	| 'port_not_allowed'
	| 'bad_location'
	| 'too_many_redirects'
	| 'robots_too_complex'
	| 'robots_redirect_refused';

/** The vetted public sentence per reason (the code is `public` disclosure). */
const REFUSAL_SENTENCES: Readonly<Record<HarvestRefusalReason, string>> = {
	unparseable: 'The address is not a valid URL',
	protocol: 'Only http and https addresses can be fetched',
	credentials: 'An address with a user name or password in it is refused',
	url_too_long: 'The address is too long',
	requires_https: 'This request accepts only https addresses',
	downgrade: 'The site redirected from https to http, which is refused',
	host_not_allowed: 'This request may not visit that host',
	port_not_allowed: 'This request may only use the standard web ports',
	bad_location: 'The site redirected to an address that is not a valid URL',
	too_many_redirects: 'The site redirected too many times',
	robots_too_complex: "The site's robots.txt is larger or more complex than can be applied safely",
	robots_redirect_refused:
		"The site's robots.txt redirected to an address that is refused (for example https to http)",
};

/** What `site` says for caller text that has no origin (see the header). */
export const UNPARSEABLE_SITE = '(not a web address)';

/** The origin of `url` — or, for text with no http(s) origin, `UNPARSEABLE_SITE`. */
export function siteOf(url: URL | string): string {
	const parsed = typeof url === 'string' ? URL.parse(url) : url;
	const origin = parsed?.origin ?? 'null';
	return origin === 'null' ? UNPARSEABLE_SITE : origin;
}

/** `harvest.refused`: a public policy said no. `hop` (log-only) names the hop's host. */
export function harvestRefused(
	reason: HarvestRefusalReason,
	site: string,
	hop?: string,
): DedaloError {
	return new DedaloError('harvest.refused', {
		message: `harvest: refused (${reason}) for ${site}`,
		publicMessage: REFUSAL_SENTENCES[reason],
		details: { site, reason },
		coordinates: { reason, site, ...(hop === undefined ? {} : { hop }) },
	});
}

/** The reason token of a `harvest.refused`, or undefined for anything else. */
export function refusalReason(error: unknown): string | undefined {
	if (!isDedaloError(error) || error.code !== 'harvest.refused') return undefined;
	const reason = error.coordinates?.reason;
	return typeof reason === 'string' ? reason : undefined;
}

/** `harvest.robots_disallowed`: the site's robots.txt said no to this path. */
export function robotsDisallowed(url: URL): DedaloError {
	return new DedaloError('harvest.robots_disallowed', {
		message: `robots.txt disallows ${url.pathname} on ${url.origin}`,
		details: { site: url.origin },
		coordinates: { site: url.origin, path: url.pathname },
	});
}

/** `harvest.robots_unavailable`: RFC 9309 §2.3.1.4, an unreadable robots.txt is a complete disallow. */
export function robotsUnavailable(url: URL): DedaloError {
	return new DedaloError('harvest.robots_unavailable', {
		message: `robots.txt unreadable for ${url.origin}`,
		details: { site: url.origin },
		coordinates: { site: url.origin },
	});
}

/** `harvest.too_large`: the body passed the caller's ceiling. */
export function harvestTooLarge(site: string, maxBytes: number, cause: unknown): DedaloError {
	return new DedaloError('harvest.too_large', {
		message: `harvest: response from ${site} exceeds ${maxBytes} bytes`,
		details: { site, max_bytes: maxBytes },
		coordinates: { site, max_bytes: maxBytes },
		cause,
	});
}

/** A media type as a remote site sent it, reduced to `type/subtype` — never free text. */
const MEDIA_TYPE = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/;

/** `harvest.unexpected_type`: a 2xx answer of a kind the caller did not ask for. */
export function unexpectedType(site: string, contentType: string): DedaloError {
	const mediaType = (contentType.split(';', 1)[0] ?? '').trim().toLowerCase();
	const shown = MEDIA_TYPE.test(mediaType) ? mediaType : 'none';
	return new DedaloError('harvest.unexpected_type', {
		message: `harvest: ${site} answered ${shown}`,
		details: { site, content_type: shown },
		coordinates: { site, content_type: shown },
	});
}
