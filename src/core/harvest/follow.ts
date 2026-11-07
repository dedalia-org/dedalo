/**
 * Redirects, followed ONE VETTED HOP AT A TIME.
 *
 * A redirect is a new target the server chose for us. `fetchGuardedText` answers
 * that by refusing every redirect, which is right for an API call and wrong for a
 * harvester: catalogue sites move pages, add `www.`, and upgrade to https. So the
 * harvesting door follows them — but only by re-running, for EVERY hop, the whole
 * policy the first URL passed:
 *
 *   - http(s) only, no credentials in the URL (a user name alone included), and
 *     never https → http (a downgrade hands the rest of the exchange to anyone on
 *     the path); https only, when the caller asked for `requireHttps`;
 *   - the caller's HOST policy (a public-only policy, or an allowlist) and, when it
 *     asked for `defaultPortsOnly`, the scheme's own port;
 *   - a URL no longer than `MAX_URL_LENGTH` (every per-hop check is linear in
 *     it, and a hostile redirect can mint any length it likes — robots matching,
 *     whose cost is ALSO the rule count, weighs its own work: `robots.ts`);
 *   - the caller's own per-hop check (robots.txt, pacing — `harvest.ts`), whose
 *     `done` is held until the hop has answered, and is told what it answered;
 *   - the public-address check and the socket pin, inside `fetchPinnedHop`.
 *
 * At most `MAX_REDIRECTS` redirects are followed — the sixth is a refusal, never
 * a silent stop on a 3xx. A `Location` that is not a URL is a refusal too, never a
 * raw TypeError. Every refusal is `harvest.refused` with its reason token
 * (`refusals.ts`); the redirect target's host rides only in the log.
 */

import { isIP } from 'node:net';
import {
	fetchPinnedHop,
	type PinnedHopDeps,
	type PinnedHopRequest,
	type PinnedHopResponse,
} from '../security/ssrf_guard.ts';
import { type HarvestRefusalReason, harvestRefused, siteOf } from './refusals.ts';

/** RFC 9110 lets a client choose; five is what browsers and RFC 9309 settle on. */
export const MAX_REDIRECTS = 5;

/** The longest URL a hop may name. Catalogue and OAI URLs are far shorter. */
export const MAX_URL_LENGTH = 4096;

/**
 * Where a harvest may go. `'public'`: any host whose every address is public (a
 * cataloguer pasted the URL). A list: ONLY those sites — each name entry matches
 * the host itself and its subdomains (`example.org` admits `lots.example.org`,
 * never `evilexample.org`); an IP-literal entry matches only itself — and their
 * addresses must still be public.
 */
export type HarvestHosts = 'public' | readonly string[];

/** The URL-level half of the per-hop policy (the address half is the primitive's). */
export interface HopPolicy {
	readonly hosts: HarvestHosts;
	/** Refuse any hop that is not https, the first one included. */
	readonly requireHttps?: boolean;
	/**
	 * Refuse any hop that names a port other than its scheme's own (80, 443), the first
	 * one included. An allowlist names a HOST, so without this a stored address may
	 * still reach any service on it — and a redirect any other port of it.
	 */
	readonly defaultPortsOnly?: boolean;
}

/** One request as the loop sends it; `method`/`body` change on a 301/302/303. */
export interface HopPlan {
	url: URL;
	method: 'GET' | 'POST';
	body?: string;
}

/** Injectable seams. Tests supply them; production supplies none. */
export interface FollowDeps {
	/** Replaces the primitive entirely (a scripted site). */
	readonly hop?: (request: PinnedHopRequest) => Promise<PinnedHopResponse>;
	/** Passed to the REAL primitive (a scripted resolver or socket) when `hop` is absent. */
	readonly pinned?: PinnedHopDeps;
}

/**
 * Called once a hop has finished: with its response, or null when it failed.
 * The pace (`harvest.ts`) reads a 429/503 `Retry-After` from it.
 */
export type HopDone = (response: PinnedHopResponse | null) => void;

export interface FollowOptions extends HopPolicy {
	readonly headers: Headers;
	readonly maxBytes: number;
	/** The TOTAL time one hop may take, its body included. */
	readonly timeoutMs: number;
	/** How long the body may stall without a byte (default: `timeoutMs`). */
	readonly idleTimeoutMs?: number;
	/** Past `maxBytes`: fail (`'error'`, the default) or keep the first `maxBytes`. */
	readonly overflow?: 'error' | 'truncate';
	/** Seen before the body is read; false leaves it unread (`bodySkipped`). */
	readonly acceptBody?: (status: number, headers: Headers) => boolean;
	/** Ignore the running job's stop signal (a fetch shared by many jobs). */
	readonly detachedFromJob?: boolean;
	/**
	 * Runs before each hop's socket opens (robots, pacing). Throws to refuse. May
	 * return a `done`, called exactly once when the hop has answered or failed.
	 */
	readonly beforeHop: (url: URL) => Promise<HopDone | undefined>;
	readonly deps?: FollowDeps;
}

export interface FollowResult {
	/** The URL that finally answered. */
	url: URL;
	response: PinnedHopResponse;
}

/** A host as compared: no IPv6 brackets, lower-case, no trailing dot. Also the tile proxy's terms key. */
export function bareHost(host: string): string {
	return host
		.trim()
		.replace(/^\[|\]$/g, '')
		.toLowerCase()
		.replace(/\.$/, '');
}

/**
 * The key a SERVER is known by — its origin with the host's trailing root dot
 * dropped. `https://example.org.` and `https://example.org` are one server, so the
 * pace (`pacing.ts`) and the robots.txt cache key on this, never on `url.origin`,
 * or alternating the two spellings would double the rate a site sees.
 */
export function siteKey(url: URL): string {
	if (!url.hostname.endsWith('.')) return url.origin;
	const bare = new URL(url.origin);
	bare.hostname = bareHost(url.hostname);
	return bare.origin;
}

/**
 * Does allowlist entry `site` admit host `name`? A name admits its subdomains; an
 * IP address has none, so an IP (on either side) matches only itself — `9.1.2.3`
 * is not "under" `1.2.3`.
 */
function siteAdmits(site: string, name: string): boolean {
	if (name === site) return true;
	return isIP(site) === 0 && isIP(name) === 0 && name.endsWith(`.${site}`);
}

/** Does `host` equal an allowlisted site or sit under it? Brackets are stripped on both sides. */
export function hostMatches(host: string, allowed: readonly string[]): boolean {
	const name = bareHost(host);
	return allowed.some((entry) => siteAdmits(bareHost(entry), name));
}

/**
 * The URL-level half of the per-hop policy. `site` is what the refusal names on
 * the wire — the origin the CALLER asked for (`refusals.ts`), not this hop's.
 */
export function assertHopAllowed(
	url: URL,
	previous: URL | null,
	policy: HopPolicy,
	site: string = siteOf(url),
): void {
	const refusal =
		shapeRefusal(url) ??
		transportRefusal(url, previous, policy) ??
		hostRefusal(url, policy.hosts) ??
		portRefusal(url, policy);
	if (refusal !== null) throw harvestRefused(refusal, site, url.host);
}

/** Why a URL's own shape is refused, or null. */
function shapeRefusal(url: URL): HarvestRefusalReason | null {
	if (url.protocol !== 'https:' && url.protocol !== 'http:') return 'protocol';
	if (url.username !== '' || url.password !== '') return 'credentials';
	if (url.href.length > MAX_URL_LENGTH) return 'url_too_long';
	return null;
}

/** https only when asked; and https → http never (the rest would travel in clear). */
function transportRefusal(
	url: URL,
	previous: URL | null,
	policy: HopPolicy,
): HarvestRefusalReason | null {
	if (policy.requireHttps === true && url.protocol !== 'https:') return 'requires_https';
	if (previous?.protocol === 'https:' && url.protocol === 'http:') return 'downgrade';
	return null;
}

function hostRefusal(url: URL, hosts: HarvestHosts): HarvestRefusalReason | null {
	return hosts === 'public' || hostMatches(url.hostname, hosts) ? null : 'host_not_allowed';
}

/**
 * `url.port` is empty exactly when the port is the scheme's own (the WHATWG parser drops
 * `:443` on https and `:80` on http), so a non-empty one is another port. Judged after
 * the host: a host the policy does not admit is refused as that, whatever its port.
 */
function portRefusal(url: URL, policy: HopPolicy): HarvestRefusalReason | null {
	return policy.defaultPortsOnly === true && url.port !== '' ? 'port_not_allowed' : null;
}

/**
 * The request the NEXT hop sends. 303 always becomes a bodiless GET; 301/302 do
 * too for a POST (what every browser does, RFC 9110 §15.4.2-3); 307/308 keep the
 * method and the body. The primitive hands back a `location` only for those five
 * statuses, so no other status reaches here.
 */
export function nextPlan(
	plan: HopPlan,
	status: number,
	location: string,
	site: string = siteOf(plan.url),
): HopPlan {
	const url = URL.parse(location, plan.url);
	if (url === null) throw harvestRefused('bad_location', site, plan.url.host);
	const keepsMethod = status === 307 || status === 308;
	if (keepsMethod || plan.method === 'GET') return { ...plan, url };
	return { url, method: 'GET' };
}

/** Follow one request through its redirects, vetting every hop. */
export async function followVetted(start: HopPlan, options: FollowOptions): Promise<FollowResult> {
	const site = siteOf(start.url);
	let plan = start;
	let previous: URL | null = null;
	for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
		assertHopAllowed(plan.url, previous, options, site);
		const response = await sendHop(plan, options);
		if (response.location === null) return { url: plan.url, response };
		previous = plan.url;
		plan = nextPlan(plan, response.status, response.location, site);
	}
	throw harvestRefused('too_many_redirects', site, plan.url.host);
}

/** One hop: the caller's gate, the primitive, and `done` — whatever the hop did. */
async function sendHop(plan: HopPlan, options: FollowOptions): Promise<PinnedHopResponse> {
	const hop = options.deps?.hop ?? ((request) => fetchPinnedHop(request, options.deps?.pinned));
	const done = await options.beforeHop(plan.url);
	let response: PinnedHopResponse | null = null;
	try {
		response = await hop(hopRequest(plan, options));
		return response;
	} finally {
		done?.(response);
	}
}

/** The primitive's request for one hop. A hop without a body sends no Content-Type. */
function hopRequest(plan: HopPlan, options: FollowOptions): PinnedHopRequest {
	const headers = new Headers(options.headers);
	if (plan.body === undefined) headers.delete('content-type');
	const request: PinnedHopRequest = {
		url: plan.url,
		method: plan.method,
		headers,
		maxBytes: options.maxBytes,
		timeoutMs: options.timeoutMs,
	};
	return Object.assign(
		request,
		definedOnly({
			body: plan.body,
			idleTimeoutMs: options.idleTimeoutMs,
			overflow: options.overflow,
			acceptBody: options.acceptBody,
			detachedFromJob: options.detachedFromJob,
		}),
	);
}

/** The entries of `fields` that are set — an absent option stays absent, never `undefined`. */
function definedOnly<T extends object>(fields: T): Partial<T> {
	return Object.fromEntries(
		Object.entries(fields).filter(([, value]) => value !== undefined),
	) as Partial<T>;
}
