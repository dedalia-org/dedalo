/**
 * THE HARVESTING DOOR (src/core/harvest/) — every rule it promises, driven.
 *
 * Each describe block pins one clause of the door's headers against a FAKE HOP
 * (the `hop` seam): the scripted "site" answers per URL — honouring `maxBytes`,
 * `overflow` and `acceptBody` the way the primitive does — and the test reads
 * what the door sent and what it refused. A few cases run the REAL primitive,
 * `fetchPinnedHop`, under its own seams (a scripted resolver and socket), so the
 * door's reading of the primitive's errors is pinned against the primitive itself.
 *
 * NO WALL CLOCK. The clock, the pacing sleep and the drain timer are seams; a
 * negative claim ("the second request has NOT started") is checked after
 * `settle()`, which drains every pending microtask — deterministic, because
 * nothing in these fakes waits on a timer or on I/O.
 *
 * Written for the PR #114 review (2026-09-29) and hardened by its mutation
 * audit: each case below failed against at least one surviving mutant.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { DedaloError, isDedaloError, toErrorBody } from '../../src/core/errors/index.ts';
import { specOf } from '../../src/core/errors/registry.ts';
import {
	reachedProviderBeforeRefusal,
	stoppedBeforeAnyRequest,
} from '../../src/core/harvest/abort.ts';
import {
	assertHopAllowed,
	hostMatches,
	MAX_REDIRECTS,
	MAX_URL_LENGTH,
	nextPlan,
	siteKey,
} from '../../src/core/harvest/follow.ts';
import {
	decodeBody,
	HARVEST_DEFAULT_IDLE_TIMEOUT_MS,
	HARVEST_DEFAULT_MAX_BYTES,
	HARVEST_DEFAULT_TIMEOUT_MS,
	HARVEST_MAX_BYTES,
	HARVEST_MAX_TIMEOUT_MS,
	HARVEST_USER_AGENT,
	type HarvestDeps,
	type HarvestRequest,
	harvestFetch,
	type InteractiveDeps,
	type InteractiveRequest,
	interactiveFetch,
	retryAfterMs,
} from '../../src/core/harvest/harvest.ts';
import {
	clearInteractiveForTests,
	INTERACTIVE_DEFAULT_IDLE_TIMEOUT_MS,
	INTERACTIVE_DEFAULT_MAX_BYTES,
	INTERACTIVE_DEFAULT_TIMEOUT_MS,
	INTERACTIVE_FALLBACK_BACKOFF_MS,
	INTERACTIVE_MAX_BACKOFF_MS,
	INTERACTIVE_MAX_BYTES,
	INTERACTIVE_MAX_CONCURRENT,
	INTERACTIVE_MAX_HOLDER_LENGTH,
	INTERACTIVE_MAX_HOLDER_QUEUE,
	INTERACTIVE_MAX_INTERVAL_MS,
	INTERACTIVE_MAX_QUEUE,
	INTERACTIVE_MAX_REGISTRY_PER_HOLDER,
	INTERACTIVE_MAX_STORED_PER_HOLDER,
	INTERACTIVE_MAX_STORED_QUEUE,
	INTERACTIVE_MAX_STORED_TOTAL,
	INTERACTIVE_MAX_TIMEOUT_MS,
	INTERACTIVE_MAX_TOTAL,
	INTERACTIVE_MAX_TOTAL_QUEUE,
	INTERACTIVE_MAX_WAIT_MS,
	interactiveHolderAtOriginState,
	interactiveHolderState,
	interactiveState,
} from '../../src/core/harvest/interactive_limits.ts';
import {
	acquireTurn,
	clearPacingForTests,
	MAX_INTERVAL_MS,
	MIN_INTERVAL_MS,
	type PacingDeps,
	paceInterval,
	trackedOrigins,
} from '../../src/core/harvest/pacing.ts';
import { siteOf, UNPARSEABLE_SITE, unexpectedType } from '../../src/core/harvest/refusals.ts';
import {
	cachedRobotsOrigins,
	cachedRobotsWeight,
	canonicalPath,
	clearRobotsCache,
	escapeWildcards,
	globMatches,
	isPathAllowed,
	linearIndexOf,
	parseRobots,
	pathVerdict,
	policyFromResponse,
	ROBOTS_CACHE_MAX_WEIGHT,
	ROBOTS_FAILURE_TTL_MS,
	ROBOTS_MAX_BYTES,
	ROBOTS_MAX_MATCH_WORK,
	ROBOTS_MAX_ORIGINS,
	ROBOTS_MAX_PATTERN_LENGTH,
	ROBOTS_MAX_RULES,
	ROBOTS_RULE_WEIGHT,
	ROBOTS_TTL_MS,
	type RobotsPolicy,
	robotsPolicyFor,
	robotsText,
} from '../../src/core/harvest/robots.ts';
import { currentJobSignal, runWithJobSignal } from '../../src/core/media/job_scope.ts';
import {
	fetchPinnedHop,
	type PinnedHopRequest,
	type PinnedHopResponse,
	SSRF_REFUSAL_KINDS,
} from '../../src/core/security/ssrf_guard.ts';
import { RELEASE_IDENTITY } from '../../src/core/update/build_stamp.ts';

// ---------------------------------------------------------------------------
// The fake site
// ---------------------------------------------------------------------------

/** A scripted answer. A 301/302/303/307/308 with `location` is a redirect. */
interface Scripted {
	status: number;
	body?: string;
	location?: string;
	contentType?: string;
	headers?: Record<string, string>;
	/** Thrown instead of answering (a refusal, a transport failure). */
	error?: unknown;
	/** Held until this settles (a slow site). */
	gate?: Promise<void>;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** Answer one request the way the primitive would: cap, overflow, acceptBody. */
function scriptedResponse(request: PinnedHopRequest, answer: Scripted): PinnedHopResponse {
	const headers = new Headers(answer.headers);
	if (answer.contentType !== undefined) headers.set('content-type', answer.contentType);
	const location = REDIRECT_STATUSES.has(answer.status) ? (answer.location ?? null) : null;
	const base = { status: answer.status, headers, location, truncated: false };
	if (location !== null || request.acceptBody?.(answer.status, headers) === false) {
		return { ...base, bytes: new Uint8Array(0), bodySkipped: true };
	}
	const body = new TextEncoder().encode(answer.body ?? '');
	if (body.byteLength <= request.maxBytes) return { ...base, bytes: body, bodySkipped: false };
	if (request.overflow !== 'truncate') {
		throw new DedaloError('security.outbound_failed', {
			coordinates: { reason: 'body_cap', max_bytes: request.maxBytes },
		});
	}
	return {
		...base,
		bytes: body.subarray(0, request.maxBytes),
		truncated: true,
		bodySkipped: false,
	};
}

interface FakeSite {
	deps: HarvestDeps;
	/** Every request the door sent, in order. */
	sent: PinnedHopRequest[];
	/** The fake clock's reading at each of those requests, in the same order. */
	sentAt: number[];
	/** Every pacing sleep, in ms. */
	slept: number[];
	/** Drain timers scheduled (never run unless a test runs them). */
	timers: { callback: () => void; ms: number }[];
	clock: { now: number };
}

/** A fake site: answers by URL, records every request, owns the clock. */
function fakeSite(routes: Record<string, Scripted>): FakeSite {
	const sent: PinnedHopRequest[] = [];
	const sentAt: number[] = [];
	const slept: number[] = [];
	const timers: FakeSite['timers'] = [];
	const clock = { now: 1_000_000 };
	const hop = async (request: PinnedHopRequest): Promise<PinnedHopResponse> => {
		sent.push(request);
		sentAt.push(clock.now);
		const answer = routes[request.url.toString()] ?? { status: 404 };
		if (answer.gate !== undefined) await answer.gate;
		if (answer.error !== undefined) throw answer.error;
		return scriptedResponse(request, answer);
	};
	const deps: HarvestDeps = {
		hop,
		now: () => clock.now,
		sleep: async (ms) => {
			slept.push(ms);
			clock.now += ms;
		},
		setTimer: (callback, ms) => {
			timers.push({ callback, ms });
		},
	};
	return { deps, sent, sentAt, slept, timers, clock };
}

/** The fake clock's reading at each request sent to `host`, in order. */
function sentTimesTo(site: FakeSite, host: string): number[] {
	return site.sentAt.filter((_, index) => site.sent[index]?.url.host === host);
}

/** The paths of the requests sent to `host`. */
function pathsSent(site: FakeSite, host: string): string[] {
	return site.sent
		.filter((r) => r.url.host === host)
		.map((r) => `${r.url.pathname}${r.url.search}`);
}

/** The DedaloError a rejected promise carried (fails the test if it resolved). */
async function failureOf(promise: Promise<unknown>): Promise<DedaloError> {
	try {
		await promise;
	} catch (error) {
		if (isDedaloError(error)) return error;
		throw new Error(`untyped failure: ${String(error)}`);
	}
	throw new Error('expected a failure, the promise resolved');
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
	try {
		await promise;
		return 'none';
	} catch (error) {
		return isDedaloError(error) ? error.code : `untyped: ${String(error)}`;
	}
}

/**
 * Drain every pending microtask. Deterministic here: the fakes resolve through
 * promises only, so after one macrotask tick everything that CAN run has run.
 */
function settle(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

/** A promise and the function that settles it. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve = (): void => {};
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function harvest(site: FakeSite, request: Partial<HarvestRequest> & { url: string }) {
	return harvestFetch({ hosts: 'public', ...request }, site.deps);
}

const NOT_FOUND: Scripted = { status: 404 };

beforeEach(() => {
	clearRobotsCache();
	clearPacingForTests();
	clearInteractiveForTests();
});

// ---------------------------------------------------------------------------
// robots.txt — parsing and matching (RFC 9309)
// ---------------------------------------------------------------------------

/**
 * THE DOCUMENTED NUMBERS, pinned literally — once each. Every other case reads the
 * exported constant, so a silent change to one (20 MiB → 21, an hour → a day) would
 * move the test with it and stay green; these are what server_contract.md and
 * OUTBOUND_SPEC.md promise, and changing one is a documented decision.
 */
describe('the documented bounds', () => {
	test('each bound is the number the documentation states', () => {
		const MiB = 1024 * 1024;
		expect(HARVEST_DEFAULT_MAX_BYTES).toBe(20 * MiB);
		expect(HARVEST_MAX_BYTES).toBe(100 * MiB);
		expect(HARVEST_DEFAULT_TIMEOUT_MS).toBe(120_000);
		expect(HARVEST_MAX_TIMEOUT_MS).toBe(600_000);
		expect(HARVEST_DEFAULT_IDLE_TIMEOUT_MS).toBe(30_000);
		expect(MAX_REDIRECTS).toBe(5);
		expect(MAX_URL_LENGTH).toBe(4096);
		expect(MIN_INTERVAL_MS).toBe(3_000);
		expect(MAX_INTERVAL_MS).toBe(60_000);
		expect(ROBOTS_MAX_BYTES).toBe(512 * 1024);
		expect(ROBOTS_TTL_MS).toBe(3_600_000);
		expect(ROBOTS_FAILURE_TTL_MS).toBe(300_000);
		expect(ROBOTS_MAX_ORIGINS).toBe(512);
		expect(ROBOTS_MAX_RULES).toBe(4096);
		expect(ROBOTS_MAX_PATTERN_LENGTH).toBe(2048);
		expect(ROBOTS_CACHE_MAX_WEIGHT).toBe(16 * MiB);
		expect(ROBOTS_RULE_WEIGHT).toBe(80);
		expect(ROBOTS_MAX_MATCH_WORK).toBe(8 * MiB);
	});

	test('the interactive profile’s bounds are the numbers OUTBOUND_SPEC.md §3.1 states', () => {
		const MiB = 1024 * 1024;
		expect(INTERACTIVE_DEFAULT_MAX_BYTES).toBe(1 * MiB);
		expect(INTERACTIVE_MAX_BYTES).toBe(8 * MiB);
		expect(INTERACTIVE_DEFAULT_TIMEOUT_MS).toBe(10_000);
		expect(INTERACTIVE_MAX_TIMEOUT_MS).toBe(20_000);
		expect(INTERACTIVE_DEFAULT_IDLE_TIMEOUT_MS).toBe(5_000);
		expect(INTERACTIVE_MAX_CONCURRENT).toBe(4);
		expect(INTERACTIVE_MAX_QUEUE).toBe(256);
		expect(INTERACTIVE_MAX_TOTAL).toBe(16);
		expect(INTERACTIVE_MAX_TOTAL_QUEUE).toBe(512);
		expect(INTERACTIVE_MAX_STORED_TOTAL).toBe(8);
		expect(INTERACTIVE_MAX_STORED_QUEUE).toBe(32);
		expect(INTERACTIVE_MAX_STORED_PER_HOLDER).toBe(3);
		expect(INTERACTIVE_MAX_REGISTRY_PER_HOLDER).toBe(4);
		expect(INTERACTIVE_MAX_HOLDER_QUEUE).toBe(512);
		expect(INTERACTIVE_MAX_HOLDER_LENGTH).toBe(64);
		expect(INTERACTIVE_MAX_WAIT_MS).toBe(10_000);
		expect(INTERACTIVE_MAX_INTERVAL_MS).toBe(5_000);
		expect(INTERACTIVE_MAX_BACKOFF_MS).toBe(30_000);
		expect(INTERACTIVE_FALLBACK_BACKOFF_MS).toBe(2_000);
		// Its limits are shorter than the default's in every dimension (the reason it exists).
		expect(INTERACTIVE_MAX_BYTES).toBeLessThan(HARVEST_MAX_BYTES);
		expect(INTERACTIVE_MAX_TIMEOUT_MS).toBeLessThan(HARVEST_MAX_TIMEOUT_MS);
		expect(INTERACTIVE_DEFAULT_TIMEOUT_MS).toBeLessThan(HARVEST_DEFAULT_TIMEOUT_MS);
		// The stored budget is a part of the global one: the registry always keeps the rest.
		expect(INTERACTIVE_MAX_STORED_TOTAL).toBeLessThan(INTERACTIVE_MAX_TOTAL);
		expect(INTERACTIVE_MAX_STORED_TOTAL).toBeGreaterThanOrEqual(INTERACTIVE_MAX_CONCURRENT);
		// One person's share of the stored budget is under the origin's own cap and well under the budget:
		// two hosts of their own can never be all of it, and a single slow host leaves a slot for the others.
		expect(INTERACTIVE_MAX_STORED_PER_HOLDER).toBeLessThan(INTERACTIVE_MAX_CONCURRENT);
		expect(INTERACTIVE_MAX_STORED_PER_HOLDER * 2).toBeLessThan(INTERACTIVE_MAX_STORED_TOTAL);
		// One person's places in a REGISTRY origin's line: as many as it has slots (a lone viewer is not
		// slowed), and a whole number of people fill its queue exactly — so the bound is not one person's.
		expect(INTERACTIVE_MAX_REGISTRY_PER_HOLDER).toBeLessThanOrEqual(INTERACTIVE_MAX_CONCURRENT);
		expect(
			(INTERACTIVE_MAX_CONCURRENT + INTERACTIVE_MAX_QUEUE) % INTERACTIVE_MAX_REGISTRY_PER_HOLDER,
		).toBe(0);
		expect(INTERACTIVE_MAX_QUEUE / INTERACTIVE_MAX_REGISTRY_PER_HOLDER).toBeGreaterThan(2);
		// A map's viewport: a 3840x2160 display shows 16 x 10 tiles of one layer. The queue of ONE origin
		// holds a layer whole (another layer is another host's queue), and a person's own queue, which
		// every layer of theirs on a stored host waits in, holds two.
		expect(INTERACTIVE_MAX_QUEUE).toBeGreaterThanOrEqual(16 * 10);
		expect(INTERACTIVE_MAX_HOLDER_QUEUE).toBeGreaterThanOrEqual(16 * 10 * 2);
		// A wait the queue can never exceed: a start further off than this is refused.
		expect(INTERACTIVE_MAX_BACKOFF_MS).toBeGreaterThan(INTERACTIVE_MAX_WAIT_MS);
	});
});

describe('robots.txt — RFC 9309 group selection and matching', () => {
	const text = [
		'User-agent: *',
		'Disallow: /',
		'',
		'User-agent: Dedalo',
		'User-agent: otherbot',
		'Disallow: /private',
		'Allow: /private/open',
		'Disallow: /*.pdf$',
		'Crawl-delay: 7',
	].join('\n');

	test('a group naming our token wins over *, and all its agents share it', () => {
		const policy = parseRobots(text);
		expect(isPathAllowed(policy, '/catalogue')).toBe(true); // * says "/" — not ours
		expect(isPathAllowed(policy, '/private/x')).toBe(false);
		expect(policy.kind === 'rules' && policy.crawlDelayMs).toBe(7000);
	});

	test('the product token is the leading [a-zA-Z_-]+ of the value, any case', () => {
		const ours = (agent: string) =>
			isPathAllowed(
				parseRobots(`User-agent: *\nDisallow: /\n\nUser-agent: ${agent}\nAllow: /`),
				'/x',
			);
		expect(ours('dedalo/7')).toBe(true);
		expect(ours('Dedalo bot')).toBe(true);
		expect(ours('DEDALO')).toBe(true);
		expect(ours('dedalobot')).toBe(false);
		expect(ours('otherbot dedalo')).toBe(false);
	});

	test('a Sitemap or Crawl-delay line between user-agent lines does not split the group', () => {
		for (const between of ['Sitemap: https://a.test/s.xml', 'Crawl-delay: 5']) {
			const policy = parseRobots(
				`User-agent: dedalo\n${between}\nUser-agent: otherbot\nDisallow: /x`,
			);
			expect(isPathAllowed(policy, '/x'), between).toBe(false);
		}
		// …while a rule line DOES end it: the next user-agent starts a new group.
		const split = parseRobots('User-agent: dedalo\nAllow: /\nUser-agent: otherbot\nDisallow: /x');
		expect(isPathAllowed(split, '/x')).toBe(true);
	});

	test('longest match wins, and Allow wins a tie — in either order of the lines', () => {
		const policy = parseRobots(text);
		expect(isPathAllowed(policy, '/private/open/lot1')).toBe(true);
		const tie = parseRobots('User-agent: *\nDisallow: /a\nAllow: /a');
		expect(isPathAllowed(tie, '/a/b')).toBe(true);
		const allowFirst = parseRobots('User-agent: *\nAllow: /page\nDisallow: /page');
		expect(isPathAllowed(allowFirst, '/page')).toBe(true);
	});

	test('a value with no space after the colon is the same rule', () => {
		const policy = parseRobots('User-agent:*\nDisallow:/private');
		expect(isPathAllowed(policy, '/private/x')).toBe(false);
		expect(isPathAllowed(policy, '/public')).toBe(true);
	});

	test('longest match wins the other way too: a shorter Allow never beats a longer Disallow', () => {
		// §2.2.2: length decides, not the kind — in either order of the lines.
		for (const lines of ['Allow: /\nDisallow: /private', 'Disallow: /private\nAllow: /']) {
			const policy = parseRobots(`User-agent: *\n${lines}`);
			expect(isPathAllowed(policy, '/private/x'), lines).toBe(false);
			expect(isPathAllowed(policy, '/public'), lines).toBe(true);
		}
	});

	test('every group naming us is merged, however it spells the token (§2.2.1)', () => {
		const policy = parseRobots(
			'User-agent: dedalo\nDisallow: /a\n\nUser-agent: *\nDisallow: /c\n\nUser-agent: Dedalo/7\nDisallow: /b\n',
		);
		expect(isPathAllowed(policy, '/a')).toBe(false);
		expect(isPathAllowed(policy, '/b')).toBe(false); // the SECOND group naming us
		expect(isPathAllowed(policy, '/c')).toBe(true); // `*` is not ours once one group is
	});

	test('* and $ mean what the RFC says; an empty Disallow allows everything', () => {
		const policy = parseRobots(text);
		expect(isPathAllowed(policy, '/docs/x.pdf')).toBe(false);
		expect(isPathAllowed(policy, '/docs/x.pdf?download=1')).toBe(true); // $ anchors
		expect(isPathAllowed(parseRobots('User-agent: *\nDisallow:'), '/anything')).toBe(true);
		expect(globMatches('/a*c', '/abbbc/x')).toBe(true);
		expect(globMatches('/a*c$', '/abbbc/x')).toBe(false);
		// A MIDDLE segment is required: missing, the glob does not match.
		expect(globMatches('/a*b*c', '/ac')).toBe(false);
		expect(globMatches('/a*b*c$', '/ac')).toBe(false);
		expect(globMatches('/a*b*c', '/a-b-c')).toBe(true);
	});

	test('a single-segment $ anchors: "Allow: /$" admits the root and nothing else', () => {
		const policy = parseRobots('User-agent: *\nDisallow: /\nAllow: /$');
		expect(isPathAllowed(policy, '/')).toBe(true);
		expect(isPathAllowed(policy, '/x')).toBe(false);
	});

	test('/robots.txt itself is always allowed', () => {
		const policy = parseRobots('User-agent: *\nDisallow: /');
		expect(isPathAllowed(policy, '/robots.txt')).toBe(true);
		expect(isPathAllowed(policy, '/robots.txt.bak')).toBe(false);
	});

	test('without our group or a * group, nothing is disallowed', () => {
		expect(isPathAllowed(parseRobots('User-agent: somebot\nDisallow: /'), '/x')).toBe(true);
	});

	test('a path is also judged in canonical form: doubled slashes and ;params cannot dodge', () => {
		const policy = parseRobots('User-agent: *\nDisallow: /private');
		expect(canonicalPath('//private/lot')).toBe('/private/lot');
		expect(canonicalPath('/;x/private?a=1;b')).toBe('/private?a=1;b');
		expect(isPathAllowed(policy, '//private/lot')).toBe(false);
		expect(isPathAllowed(policy, '/;x/private')).toBe(false);
		expect(isPathAllowed(policy, '/public;private')).toBe(true);
	});

	test('Crawl-delay: empty, negative or non-numeric asks nothing; the first usable one wins', () => {
		const delay = (lines: string) => {
			const policy = parseRobots(`User-agent: *\n${lines}`);
			return policy.kind === 'rules' ? policy.crawlDelayMs : 'not rules';
		};
		expect(delay('Crawl-delay:')).toBeNull();
		expect(delay('Crawl-delay: abc')).toBeNull();
		expect(delay('Crawl-delay: -1')).toBeNull();
		expect(delay('Crawl-delay: 2\nCrawl-delay: 9')).toBe(2000);
		expect(delay('Crawl-delay: abc\nCrawl-delay: 4')).toBe(4000);
		expect(delay('Crawl-delay: 1.5')).toBe(1500);
	});

	test('status decides meaning: 4xx allows all; 5xx, 429 and a bare 3xx refuse all', () => {
		expect(policyFromResponse(400, '').kind).toBe('allow_all'); // the first 4xx
		expect(policyFromResponse(404, '').kind).toBe('allow_all');
		expect(policyFromResponse(401, '').kind).toBe('allow_all');
		expect(policyFromResponse(499, '').kind).toBe('allow_all');
		expect(policyFromResponse(500, '').kind).toBe('unavailable');
		expect(policyFromResponse(399, '').kind).toBe('unavailable');
		expect(policyFromResponse(299, 'User-agent: *\nDisallow: /').kind).toBe('rules');
		expect(policyFromResponse(503, '').kind).toBe('unavailable');
		expect(policyFromResponse(429, '').kind).toBe('unavailable');
		expect(policyFromResponse(302, '').kind).toBe('unavailable');
		expect(policyFromResponse(300, '').kind).toBe('unavailable');
		expect(policyFromResponse(200, 'User-agent: *\nDisallow: /').kind).toBe('rules');
		expect(isPathAllowed({ kind: 'unavailable' }, '/')).toBe(false);
		expect(isPathAllowed({ kind: 'too_complex' }, '/')).toBe(false);
	});

	test('an inline comment ends the rule; a rule before any User-agent belongs to nobody', () => {
		const policy = parseRobots('Disallow: /orphan\nUser-agent: *\nDisallow: /private # staff only');
		expect(isPathAllowed(policy, '/private/x')).toBe(false);
		expect(isPathAllowed(policy, '/orphan')).toBe(true);
	});

	test('one percent-encoding: %xx hex case, and non-ASCII as UTF-8 octets, never dodge a rule', () => {
		const lowerHex = parseRobots('User-agent: *\nDisallow: /a%2fb');
		expect(isPathAllowed(lowerHex, '/a%2Fb')).toBe(false); // a URL's path is upper-case hex
		const unicode = parseRobots('User-agent: *\nDisallow: /café');
		expect(isPathAllowed(unicode, '/caf%C3%A9')).toBe(false); // what new URL() sends
		expect(isPathAllowed(unicode, new URL('https://s.test/café').pathname)).toBe(false);
	});

	test('one percent-encoding: %XX of an unreserved character IS that character', () => {
		const policy = parseRobots('User-agent: *\nDisallow: /private\nDisallow: /~user');
		expect(isPathAllowed(policy, '/%70rivate')).toBe(false);
		expect(isPathAllowed(policy, '/%7Euser')).toBe(false);
		expect(isPathAllowed(parseRobots('User-agent: *\nDisallow: /%7euser'), '/~user')).toBe(false);
	});

	test('one percent-encoding: space, {}, " and | meet in one form, whichever side encodes', () => {
		// The path is what `new URL()` sends: it encodes space, {, }, " and keeps | and ^.
		const refuses = (rule: string, url: string): boolean => {
			const parsed = new URL(url);
			const policy = parseRobots(`User-agent: *\nDisallow: ${rule}`);
			return !isPathAllowed(policy, `${parsed.pathname}${parsed.search}`);
		};
		const pairs: [string, string][] = [
			['/Collections Online/', 'https://s.test/Collections Online/lot1'],
			['/Collections%20Online/', 'https://s.test/Collections Online/lot1'],
			['/search/{id}', 'https://s.test/search/{id}'],
			['/search/%7Bid%7D', 'https://s.test/search/{id}'],
			['/q?term="', 'https://s.test/q?term="x'],
			['/q?term=%22', 'https://s.test/q?term="x'],
			['/a%7Cb', 'https://s.test/a|b'],
			['/a|b', 'https://s.test/a|b'],
			['/a|b', 'https://s.test/a%7Cb'],
			['/a%5Eb', 'https://s.test/a^b'],
		];
		for (const [rule, url] of pairs) expect(refuses(rule, url), `${rule} vs ${url}`).toBe(true);
		expect(refuses('/a|b', 'https://s.test/ab')).toBe(false);
	});

	test('RFC 9309 §2.2.2 table, rows 1-5: each rule reaches the path a URL sends', () => {
		const rows: [string, string][] = [
			['/foo/bar?baz=quz', '/foo/bar?baz=quz'],
			['/foo/bar?baz=https://foo.bar', '/foo/bar?baz=https%3A%2F%2Ffoo.bar'],
			['/foo/bar/ツ', '/foo/bar/%E3%83%84'],
			['/foo/bar/%E3%83%84', '/foo/bar/%E3%83%84'],
			['/foo/bar/%62%61%7A', '/foo/bar/baz'],
		];
		for (const [rule, path] of rows) {
			const policy = parseRobots(`User-agent: *\nDisallow: ${rule}`);
			expect(isPathAllowed(policy, path), rule).toBe(false);
		}
		// The rule's side decoded too: an encoded reserved rule reaches the raw character.
		expect(isPathAllowed(parseRobots('User-agent: *\nDisallow: /a%3Ab'), '/a:b')).toBe(false);
	});

	test('the reserved-decoded form only refuses more; %2A and %24 never become * or $', () => {
		// Decoded, the Allow ties the Disallow and would win — the exact form still refuses.
		const policy = parseRobots('User-agent: *\nDisallow: /a%2Fb\nAllow: /a/b');
		expect(isPathAllowed(policy, '/a%2Fb')).toBe(false);
		expect(isPathAllowed(policy, '/a/b')).toBe(true);
		const star = parseRobots('User-agent: *\nDisallow: /a%2Ab\nDisallow: /c%24');
		expect(isPathAllowed(star, '/aXXb')).toBe(true);
		expect(isPathAllowed(star, '/c/more')).toBe(true);
		expect(isPathAllowed(star, '/a%2Ab')).toBe(false);
	});

	test('RFC 9309 §2.2.3 table: %2A and %24 in a rule reach a literal * and $ in the path', () => {
		const rows: [string, string][] = [
			['/path/file-with-a-%2A.html', '/path/file-with-a-*.html'],
			['/path/foo-%24', '/path/foo-$'],
		];
		for (const [rule, url] of rows) {
			const parsed = new URL(`https://www.example.com${url}`);
			const policy = parseRobots(`User-agent: *\nDisallow: ${rule}`);
			expect(isPathAllowed(policy, `${parsed.pathname}${parsed.search}`), rule).toBe(false);
		}
		expect(escapeWildcards('/a*b$')).toBe('/a%2Ab%24');
		// Still literal-only: %2A is no wildcard, and a mid-pattern $ still meets a literal one.
		const star = parseRobots('User-agent: *\nDisallow: /a%2Ab');
		expect(isPathAllowed(star, '/aXb')).toBe(true);
		expect(isPathAllowed(parseRobots('User-agent: *\nDisallow: /a$b'), '/a$b')).toBe(false);
	});

	test('a path with no second form is judged ONCE: forms are deduplicated before weighing', () => {
		// 4096 wildcard rules against a 1500-character plain path: one form fits the work
		// bound, two would not — so a judgement repeated for an identical form refuses it.
		const policy = parseRobots(`User-agent: *\n${'Disallow: *zz\n'.repeat(ROBOTS_MAX_RULES)}`);
		expect(pathVerdict(policy, `/${'a'.repeat(1500)}`)).toBe('allowed');
		expect(pathVerdict(policy, `/${'a'.repeat(1500)}zz`)).toBe('disallowed');
		// With a reserved-decoded rule list, a plain path is two judgements (one per list),
		// never one per duplicate spelling: 700 characters fit twice, not five times.
		const reserved = parseRobots(
			`User-agent: *\nDisallow: /q%2Fr\n${'Disallow: *zz\n'.repeat(ROBOTS_MAX_RULES - 1)}`,
		);
		expect(pathVerdict(reserved, `/${'a'.repeat(700)}`)).toBe('allowed');
	});

	test('a robots.txt that is not UTF-8 is read byte-wise, and its rules still bind', () => {
		const latin1 = Uint8Array.from([
			...new TextEncoder().encode('User-agent: *\nDisallow: /caf'),
			0xe9,
		]);
		const policy = parseRobots(robotsText(latin1, false));
		expect(isPathAllowed(policy, '/caf%E9')).toBe(false); // what the site's own links send
		expect(isPathAllowed(policy, '/cafe')).toBe(true);
		// Mixed: a UTF-8 line escapes to what the encoding makes of it; a BOM is dropped.
		const mixed = Uint8Array.from([
			0xef,
			0xbb,
			0xbf,
			...new TextEncoder().encode('User-agent: *\nDisallow: /café\nDisallow: /na'),
			0xef,
			0x76,
			0x65,
		]);
		const both = parseRobots(robotsText(mixed, false));
		expect(isPathAllowed(both, new URL('https://s.test/café').pathname)).toBe(false);
		expect(isPathAllowed(both, '/na%EFve')).toBe(false);
		expect(robotsText(new TextEncoder().encode('Disallow: /café'), false)).toBe('Disallow: /café');
	});

	test('glob edges: an anchored tail cannot overlap the prefix; segments cannot overlap', () => {
		expect(globMatches('/a*a$', '/a')).toBe(false);
		expect(globMatches('/a*a$', '/aa')).toBe(true);
		expect(globMatches('/*ab*ab', '/ab')).toBe(false);
		expect(globMatches('/*ab*ab', '/abab')).toBe(true);
	});

	test('a CR-only file splits into lines like any other', () => {
		expect(isPathAllowed(parseRobots('User-agent: *\rDisallow: /x'), '/x')).toBe(false);
		const bytes = new TextEncoder().encode('User-agent: *\rDisallow: /a\rDisallow: /pri');
		expect(robotsText(bytes, true)).toBe('User-agent: *\rDisallow: /a');
	});

	test('a truncated file loses its partial last line (half a rule is another rule)', () => {
		const bytes = new TextEncoder().encode('User-agent: *\nDisallow: /a\nDisallow: /pri');
		expect(robotsText(bytes, true)).toBe('User-agent: *\nDisallow: /a');
		expect(robotsText(bytes, false)).toEndWith('/pri');
		expect(robotsText(new TextEncoder().encode('no line break at all'), true)).toBe('');
		const policy = parseRobots(robotsText(bytes, true));
		expect(isPathAllowed(policy, '/private')).toBe(true);
		expect(isPathAllowed(policy, '/a')).toBe(false);
	});
});

describe('robots.txt — bounded work (M1)', () => {
	test('a many-star pattern costs one indexOf per star, never a backtracking search', () => {
		const pattern = `/${'*a'.repeat(40)}b`; // 40 stars
		const path = `/${'a'.repeat(50_000)}`;
		const original = String.prototype.indexOf;
		let calls = 0;
		String.prototype.indexOf = function (this: string, ...args: Parameters<string['indexOf']>) {
			calls++;
			return original.apply(this, args);
		};
		try {
			expect(globMatches(pattern, path)).toBe(false);
		} finally {
			String.prototype.indexOf = original;
		}
		expect(calls).toBe(40);
	});

	test('linearIndexOf finds what String.indexOf finds, on hostile and ordinary inputs', () => {
		const haystacks = ['', 'a', 'abab', 'aaaaaaab', 'abcabcabd', `/${'a'.repeat(300)}b`, 'xyz'];
		const needles = ['', 'a', 'ab', 'aab', 'abcabd', 'abab', `a${'b'}`, `${'a'.repeat(260)}b`, 'z'];
		for (const haystack of haystacks) {
			for (const needle of needles) {
				for (const from of [0, 1, 3, haystack.length]) {
					expect(linearIndexOf(haystack, needle, from), `${needle} in ${haystack} @${from}`).toBe(
						haystack.indexOf(needle, from),
					);
				}
			}
		}
	});

	/**
	 * The most rules of one kind a file may hold and still have `path` JUDGED (not
	 * refused as too complex) — found by bisection on the verdict itself, so each
	 * shape below is measured AT the work bound, never comfortably under it.
	 */
	function largestJudged(rule: string, path: string): RobotsPolicy {
		const fileOf = (count: number) => parseRobots(`User-agent: *\n${`${rule}\n`.repeat(count)}`);
		let low = 1;
		let high = ROBOTS_MAX_RULES;
		while (low < high) {
			const middle = Math.ceil((low + high) / 2);
			const candidate = fileOf(middle);
			// A file past its own bounds is no policy at all: too big, like past the work bound.
			if (candidate.kind !== 'rules' || pathVerdict(candidate, path) === 'too_complex')
				high = middle - 1;
			else low = middle;
		}
		const policy = fileOf(low);
		expect(pathVerdict(policy, path)).not.toBe('too_complex');
		expect(pathVerdict(fileOf(low + 1), path)).toBe('too_complex'); // it IS the bound
		return policy;
	}

	/** Milliseconds one verdict takes (the best of three: the gate measures work, not noise). */
	function verdictMs(policy: RobotsPolicy, path: string): number {
		let best = Number.POSITIVE_INFINITY;
		for (let run = 0; run < 3; run++) {
			const started = performance.now();
			pathVerdict(policy, path);
			best = Math.min(best, performance.now() - started);
		}
		return best;
	}

	/**
	 * The shapes that cost the most per character step, each AT the work bound:
	 *  - JSC's `String.indexOf` degrades once a needle passes ~256 characters, so a
	 *    257-character literal the path almost matches everywhere (measured
	 *    2026-09-29: 1.4 s of event loop for ONE hop with the old matcher);
	 *  - the bounds do not compose: a hop URL keeps `|` literal and the encoding
	 *    triples it, `//` makes the canonical form differ, `*` and `$` the escaped
	 *    one, `%3A` the reserved-decoded one — eight forms of a 12 000-character
	 *    path (measured 2026-09-29: 610 ms per hop against 4096 short `*` rules,
	 *    every input inside its own bound).
	 * At the bound a linear matcher takes about 25 ms; the ceiling is ten times that.
	 */
	test('every hostile shape at the work bound is judged within the ceiling', () => {
		const flat = `/${'a'.repeat(MAX_URL_LENGTH - 30)}`;
		const amplified = new URL(`https://evil.test/x//${'|'.repeat(MAX_URL_LENGTH - 42)}*$%3A`);
		expect(amplified.href.length).toBeLessThanOrEqual(MAX_URL_LENGTH);
		expect(() => assertHopAllowed(amplified, null, { hosts: 'public' })).not.toThrow();
		const shapes: [string, string][] = [
			[`Disallow: /*ab${'a'.repeat(255)}`, flat],
			[`Disallow: /*ab${'a'.repeat(255)}*z`, flat], // the literal as a MIDDLE segment
			[`Disallow: *${'|'.repeat(40)}X`, `${amplified.pathname}${amplified.search}`],
			[`Disallow: *${'a'.repeat(60)}b`, `/${'a'.repeat(MAX_URL_LENGTH - 30)}%3A`],
		];
		for (const [rule, path] of shapes) {
			const policy = largestJudged(rule, path);
			expect(verdictMs(policy, path), rule.slice(0, 24)).toBeLessThan(250);
		}
	});

	test('past the work bound a hop is refused unmatched: 4096 short * rules, eight path forms', () => {
		const url = new URL(`https://evil.test/x//${'|'.repeat(MAX_URL_LENGTH - 42)}*$%3A`);
		const policy = parseRobots(
			`User-agent: *\n${`Disallow: *${'|'.repeat(40)}X\n`.repeat(ROBOTS_MAX_RULES)}`,
		);
		expect(policy.kind).toBe('rules'); // every INPUT is inside its own bound
		const started = performance.now();
		expect(pathVerdict(policy, `${url.pathname}${url.search}`)).toBe('too_complex');
		expect(isPathAllowed(policy, `${url.pathname}${url.search}`)).toBe(false); // fails closed
		expect(performance.now() - started).toBeLessThan(50); // weighed, never matched
		// The same file judges an ordinary path: the refusal is the hop's, not the file's.
		expect(pathVerdict(policy, '/catalogue/lot-17')).toBe('allowed');
	});

	test('a hop past the work bound is harvest.refused robots_too_complex, the page never asked', async () => {
		const path = `/x//${'|'.repeat(MAX_URL_LENGTH - 42)}*$%3A`;
		const site = fakeSite({
			'https://heavy.test/robots.txt': {
				status: 200,
				body: `User-agent: *\n${`Disallow: *${'|'.repeat(40)}X\n`.repeat(ROBOTS_MAX_RULES)}`,
			},
		});
		const error = await failureOf(harvest(site, { url: `https://heavy.test${path}` }));
		expect(toErrorBody(error).details).toEqual({
			site: 'https://heavy.test',
			reason: 'robots_too_complex',
		});
		expect(pathsSent(site, 'heavy.test')).toEqual(['/robots.txt']);
	});

	test('a file within the byte ceiling is obeyed as written, whatever its script (§2.5)', () => {
		// 3-byte characters: nine pattern characters each once encoded — a file of them
		// near the byte ceiling holds three times its size in pattern text.
		const rule = `Disallow: /${'漢'.repeat(200)}\n`; // 612 bytes, 1801 encoded characters
		const count = Math.min(ROBOTS_MAX_RULES, Math.floor((ROBOTS_MAX_BYTES - 20) / 612));
		const body = `User-agent: *\n${rule.repeat(count)}`;
		expect(new TextEncoder().encode(body).length).toBeLessThanOrEqual(ROBOTS_MAX_BYTES);
		const policy = parseRobots(body);
		expect(policy.kind).toBe('rules');
		expect(isPathAllowed(policy, `/${encodeURI('漢'.repeat(200))}/x`)).toBe(false);
		expect(isPathAllowed(policy, '/other')).toBe(true);
	});

	test('ONE reserved escape does not turn a large file into too_complex', () => {
		// Measured 2026-09-29: 3000 rules parsed, and one added `/a%2Fb` refused the whole
		// file — the decoded form was a full second copy counted against a text total.
		const rules = Array.from({ length: 3000 }, (_, i) => `Disallow: /${'x'.repeat(80)}${i}\n`);
		const body = `User-agent: *\n${rules.join('')}Disallow: /a%2Fb\n`;
		const policy = parseRobots(body);
		expect(policy.kind).toBe('rules');
		expect(isPathAllowed(policy, '/a/b')).toBe(false);
		expect(isPathAllowed(policy, '/a%2Fb')).toBe(false);
		// …and the decoded form shares every rule it leaves unchanged.
		if (policy.kind !== 'rules' || policy.reservedRules === null) throw new Error('two forms');
		expect(policy.reservedRules[0] === policy.rules[0]).toBe(true);
		expect(policy.reservedRules[3000] === policy.rules[3000]).toBe(false);
	});

	test('past the rule or pattern bound the file is refused whole, never truncated', () => {
		const many = `User-agent: *\n${'Disallow: /x\n'.repeat(ROBOTS_MAX_RULES + 1)}`;
		expect(parseRobots(many).kind).toBe('too_complex');
		const long = `User-agent: *\nDisallow: /${'a'.repeat(ROBOTS_MAX_PATTERN_LENGTH)}`;
		expect(parseRobots(long).kind).toBe('too_complex');
		const atBound = `User-agent: *\n${'Disallow: /x\n'.repeat(ROBOTS_MAX_RULES)}`;
		expect(parseRobots(atBound).kind).toBe('rules');
	});

	test('a too-complex file refuses the harvest as harvest.refused, not retryable', async () => {
		const site = fakeSite({
			'https://big.test/robots.txt': {
				status: 200,
				body: `User-agent: *\n${'Disallow: /x\n'.repeat(ROBOTS_MAX_RULES + 1)}`,
			},
		});
		const error = await failureOf(harvest(site, { url: 'https://big.test/lot' }));
		expect(error.code).toBe('harvest.refused');
		expect(toErrorBody(error).details).toEqual({
			site: 'https://big.test',
			reason: 'robots_too_complex',
		});
		expect(toErrorBody(error).retryable).toBe(false);
	});

	test('after a redirect, robots_too_complex names the site whose robots.txt decided', async () => {
		// The disclosure rule (refusals.ts): every robots verdict names the deciding
		// origin, which already answered its robots.txt from a public address.
		const site = fakeSite({
			'https://asked.test/robots.txt': NOT_FOUND,
			'https://asked.test/lot': { status: 302, location: 'https://other.test/lot' },
			'https://other.test/robots.txt': {
				status: 200,
				body: `User-agent: *\n${'Disallow: /x\n'.repeat(ROBOTS_MAX_RULES + 1)}`,
			},
		});
		const error = await failureOf(harvest(site, { url: 'https://asked.test/lot' }));
		expect(toErrorBody(error).details).toEqual({
			site: 'https://other.test',
			reason: 'robots_too_complex',
		});
	});

	test('a hop URL past MAX_URL_LENGTH is refused; one exactly at it is not', () => {
		const base = 'https://a.test/';
		const at = new URL(`${base}${'a'.repeat(MAX_URL_LENGTH - base.length)}`);
		expect(at.href.length).toBe(MAX_URL_LENGTH);
		expect(() => assertHopAllowed(at, null, { hosts: 'public' })).not.toThrow();
		const over = new URL(`${base}${'a'.repeat(MAX_URL_LENGTH - base.length + 1)}`);
		expect(() => assertHopAllowed(over, null, { hosts: 'public' })).toThrow(DedaloError);
		try {
			assertHopAllowed(over, null, { hosts: 'public' });
		} catch (error) {
			expect((error as DedaloError).details?.reason).toBe('url_too_long');
		}
	});
});

// ---------------------------------------------------------------------------
// robots.txt — the fetch, its policy, its cache
// ---------------------------------------------------------------------------

describe('robots.txt — the fetch runs under the door’s own policy', () => {
	test('it sends its OWN headers, never the caller’s Accept or Referer', async () => {
		const site = fakeSite({
			'https://h.test/robots.txt': NOT_FOUND,
			'https://h.test/': { status: 200 },
		});
		await harvest(site, {
			url: 'https://h.test/',
			headers: { Accept: 'application/json', Referer: 'https://secret.test/page' },
		});
		const robots = site.sent[0];
		expect(robots?.url.pathname).toBe('/robots.txt');
		expect(robots?.headers.get('accept')).toBe('text/plain, */*;q=0.1');
		expect(robots?.headers.get('referer')).toBeNull();
		expect(robots?.headers.get('user-agent')).toBe(HARVEST_USER_AGENT);
		expect(site.sent[1]?.headers.get('referer')).toBe('https://secret.test/page');
	});

	test('a cross-authority redirect is followed, and the verdict applies to the origin asked', async () => {
		const site = fakeSite({
			'https://off.test/robots.txt': {
				status: 302,
				location: 'https://cdn.example/robots/off.txt',
			},
			'https://cdn.example/robots/off.txt': { status: 200, body: 'User-agent: *\nDisallow: /x' },
			'https://off.test/y': { status: 200 },
		});
		expect(await codeOf(harvest(site, { url: 'https://off.test/x' }))).toBe(
			'harvest.robots_disallowed',
		);
		expect(pathsSent(site, 'cdn.example')).toEqual(['/robots/off.txt']);
		const answer = await harvest(site, { url: 'https://off.test/y' });
		expect(answer.ok).toBe(true);
		expect(pathsSent(site, 'cdn.example')).toHaveLength(1); // cached for off.test
	});

	test('a robots redirect is followed even when the caller allowlists only the page’s host', async () => {
		const site = fakeSite({
			'https://site.test/robots.txt': { status: 301, location: 'https://www.site.test/robots.txt' },
			'https://www.site.test/robots.txt': { status: 200, body: 'User-agent: *\nDisallow: /no' },
		});
		expect(await codeOf(harvest(site, { url: 'https://site.test/no', hosts: ['site.test'] }))).toBe(
			'harvest.robots_disallowed',
		);
	});

	test('a 3xx without a Location is unavailable, not "allow all"', async () => {
		const site = fakeSite({ 'https://bare.test/robots.txt': { status: 302 } });
		expect(await codeOf(harvest(site, { url: 'https://bare.test/lot' }))).toBe(
			'harvest.robots_unavailable',
		);
	});

	test('a robots redirect the URL rules refuse is harvest.refused, NOT retryable, kept the full TTL', async () => {
		const site = fakeSite({
			'https://a.test/robots.txt': { status: 301, location: 'http://a.test/robots.txt' },
		});
		const error = await failureOf(harvest(site, { url: 'https://a.test/lot' }));
		expect(error.code).toBe('harvest.refused');
		expect(toErrorBody(error).details).toEqual({
			site: 'https://a.test',
			reason: 'robots_redirect_refused',
		});
		expect(toErrorBody(error).retryable).toBe(false);
		expect(site.sent.map((r) => r.url.href)).toEqual(['https://a.test/robots.txt']);
		// Deterministic, so not re-asked after the failure TTL (an outage would be).
		site.clock.now += ROBOTS_FAILURE_TTL_MS + 1;
		expect(await codeOf(harvest(site, { url: 'https://a.test/lot' }))).toBe('harvest.refused');
		expect(site.sent).toHaveLength(1);
	});

	test('too many robots redirects reads as "allow all" (RFC 9309 §2.3.1.2)', async () => {
		const routes: Record<string, Scripted> = { 'https://loop.test/lot': { status: 200 } };
		routes['https://loop.test/robots.txt'] = { status: 302, location: '/r1' };
		for (let i = 1; i <= 10; i++)
			routes[`https://loop.test/r${i}`] = { status: 302, location: `/r${i + 1}` };
		const site = fakeSite(routes);
		const answer = await harvest(site, { url: 'https://loop.test/lot' });
		expect(answer.ok).toBe(true);
	});

	test('a file over the byte bound is read to the bound, not refused (§2.5)', async () => {
		const filler = `# ${'x'.repeat(100)}\n`.repeat(Math.ceil(ROBOTS_MAX_BYTES / 100));
		const site = fakeSite({
			'https://huge.test/robots.txt': {
				status: 200,
				body: `User-agent: *\nDisallow: /early\n${filler}Disallow: /late\n`,
			},
			'https://huge.test/late': { status: 200 },
		});
		expect(await codeOf(harvest(site, { url: 'https://huge.test/early' }))).toBe(
			'harvest.robots_disallowed',
		);
		expect((await harvest(site, { url: 'https://huge.test/late' })).ok).toBe(true);
		expect(site.sent[0]?.maxBytes).toBe(ROBOTS_MAX_BYTES);
		expect(site.sent[0]?.overflow).toBe('truncate');
	});

	test('the shared robots fetch ignores any one job’s stop signal; the page does not', async () => {
		const site = fakeSite({
			'https://job.test/robots.txt': NOT_FOUND,
			'https://job.test/': { status: 200 },
		});
		await harvest(site, { url: 'https://job.test/' });
		expect(site.sent.find((r) => r.url.pathname === '/robots.txt')?.detachedFromJob).toBe(true);
		expect(site.sent.find((r) => r.url.pathname === '/')?.detachedFromJob).toBeUndefined();
	});

	test('a stopped job leaves a robots load at once; the load finishes for everyone else', async () => {
		const robotsGate = deferred();
		const robotsSent = deferred();
		const site = fakeSite({
			'https://wait.test/robots.txt': { status: 404, gate: robotsGate.promise },
			'https://wait.test/a': { status: 200 },
		});
		const hop = site.deps.hop;
		const deps: HarvestDeps = {
			...site.deps,
			hop: (request) => {
				if (request.url.pathname === '/robots.txt') robotsSent.resolve();
				return hop?.(request) as Promise<PinnedHopResponse>;
			},
		};
		const job = new AbortController();
		const stopped = runWithJobSignal(job.signal, () =>
			harvestFetch({ url: 'https://wait.test/a', hosts: 'public' }, deps),
		);
		await robotsSent.promise;
		job.abort();
		const error = await failureOf(stopped);
		expect(error.code).toBe('security.outbound_failed');
		expect(error.coordinates).toEqual({ reason: 'aborted', stage: 'robots' });
		// The load itself was never cancelled: release it, and another caller uses it.
		robotsGate.resolve();
		const answer = await harvestFetch({ url: 'https://wait.test/a', hosts: 'public' }, deps);
		expect(answer.ok).toBe(true);
		expect(pathsSent(site, 'wait.test')).toEqual(['/robots.txt', '/a']);
	});
});

describe('robots.txt — the per-origin cache', () => {
	test('two harvests of one origin read robots.txt once', async () => {
		const site = fakeSite({
			'https://c.test/robots.txt': NOT_FOUND,
			'https://c.test/a': { status: 200 },
			'https://c.test/b': { status: 200 },
		});
		await harvest(site, { url: 'https://c.test/a' });
		await harvest(site, { url: 'https://c.test/b' });
		expect(pathsSent(site, 'c.test')).toEqual(['/robots.txt', '/a', '/b']);
	});

	test('an unavailable verdict is re-asked after the failure TTL — a good one is kept longer', async () => {
		const site = fakeSite({ 'https://down.test/robots.txt': { status: 503 } });
		const now = () => site.clock.now;
		const ask = () => robotsPolicyFor(new URL('https://down.test/x'), now(), site.deps);
		expect((await ask()).kind).toBe('unavailable');
		site.clock.now += ROBOTS_FAILURE_TTL_MS - 1;
		await ask();
		expect(pathsSent(site, 'down.test')).toHaveLength(1);
		site.clock.now += 2;
		await ask();
		expect(pathsSent(site, 'down.test')).toHaveLength(2);

		const good = fakeSite({ 'https://up.test/robots.txt': NOT_FOUND });
		const askGood = () => robotsPolicyFor(new URL('https://up.test/x'), good.clock.now, good.deps);
		await askGood();
		good.clock.now += ROBOTS_FAILURE_TTL_MS + 1;
		await askGood();
		expect(pathsSent(good, 'up.test')).toHaveLength(1);
	});

	test('an origin the guard refuses is not remembered: the refusal is the answer every time', async () => {
		const refusal = new DedaloError('security.ssrf_blocked', {
			coordinates: { reason: 'private_resolved', host: 'inside.test' },
		});
		const site = fakeSite({ 'https://inside.test/robots.txt': { status: 0, error: refusal } });
		for (let i = 0; i < 2; i++) {
			expect(await codeOf(harvest(site, { url: 'https://inside.test/x' }))).toBe(
				'security.ssrf_blocked',
			);
		}
		expect(pathsSent(site, 'inside.test')).toEqual(['/robots.txt', '/robots.txt']);
		expect(cachedRobotsOrigins()).toBe(0);
	});

	test('the cache is bounded by what it retains, not only by origin count', async () => {
		// Each file holds as much pattern text as the byte ceiling admits; a handful of
		// them pass the cache's budget long before ROBOTS_MAX_ORIGINS entries.
		const rule = `Disallow: /${'x'.repeat(ROBOTS_MAX_PATTERN_LENGTH - 2)}\n`;
		const body = `User-agent: *\n${rule.repeat(Math.floor(ROBOTS_MAX_BYTES / rule.length) - 1)}`;
		const policy = parseRobots(body);
		const per = policy.kind === 'rules' ? policy.weight : 0;
		expect(per).toBeGreaterThan(0);
		const needed = Math.ceil(ROBOTS_CACHE_MAX_WEIGHT / per) + 2;
		const routes: Record<string, Scripted> = {};
		for (let i = 0; i < needed; i++)
			routes[`https://w${i}.test/robots.txt`] = { status: 200, body };
		const site = fakeSite(routes);
		for (let i = 0; i < needed; i++)
			await robotsPolicyFor(new URL(`https://w${i}.test/`), site.clock.now, site.deps);
		expect(cachedRobotsWeight()).toBeLessThanOrEqual(ROBOTS_CACHE_MAX_WEIGHT);
		expect(cachedRobotsOrigins()).toBeLessThan(needed);
		const before = site.sent.length;
		await robotsPolicyFor(new URL(`https://w${needed - 1}.test/`), site.clock.now, site.deps);
		expect(site.sent.length).toBe(before); // newest kept
		await robotsPolicyFor(new URL('https://w0.test/'), site.clock.now, site.deps);
		expect(site.sent.length).toBe(before + 1); // oldest evicted, fetched again
	});

	test('a policy weighs its rule OBJECTS too: exact rules, and the reserved rules it does not share', async () => {
		const site = fakeSite({
			'https://w.test/robots.txt': {
				status: 200,
				body: 'User-agent: *\nDisallow: /a%2Fb\nDisallow: /c\n',
			},
		});
		await robotsPolicyFor(new URL('https://w.test/'), site.clock.now, site.deps);
		const exact = '/a%2Fb'.length + '/c'.length + 2 * ROBOTS_RULE_WEIGHT;
		const reserved = '/a/b'.length + ROBOTS_RULE_WEIGHT + 8; // `/c` is shared: a slot
		expect(cachedRobotsWeight()).toBe(exact + reserved);
	});

	/**
	 * The budget is a promise about MEMORY, so it is measured as memory: 512 origins of
	 * 4096 one-character rules (plus one reserved escape, which once copied them all)
	 * pinned 230 MB while the weight read a quarter of its budget (measured 2026-09-29).
	 */
	test('512 hostile files of short rules retain no more than the cache budget', async () => {
		const body = `User-agent: *\n${'Disallow: /\n'.repeat(ROBOTS_MAX_RULES - 1)}Disallow: /%2F\n`;
		const encoded = new TextEncoder().encode(body);
		const hop = async () => ({
			status: 200,
			headers: new Headers(),
			location: null,
			bytes: encoded,
			truncated: false,
			bodySkipped: false,
		});
		clearRobotsCache();
		Bun.gc(true);
		const before = process.memoryUsage().heapUsed;
		const now = Date.now();
		for (let i = 0; i < ROBOTS_MAX_ORIGINS; i++)
			await robotsPolicyFor(new URL(`https://s${i}.hostile.test/x`), now, { hop });
		Bun.gc(true);
		const retained = process.memoryUsage().heapUsed - before;
		expect(cachedRobotsWeight()).toBeLessThanOrEqual(ROBOTS_CACHE_MAX_WEIGHT);
		expect(cachedRobotsOrigins()).toBeLessThan(ROBOTS_MAX_ORIGINS);
		// The estimate must not undercount: what is retained stays within the budget
		// (a quarter of slack for the heap's own noise).
		expect(retained).toBeLessThan(ROBOTS_CACHE_MAX_WEIGHT * 1.25);
		clearRobotsCache();
	}, 30_000);

	test('a trailing-dot host is the same server: one robots.txt read, one pace', async () => {
		const site = fakeSite({
			'https://dot.test/robots.txt': NOT_FOUND,
			'https://dot.test/a': { status: 200 },
			'https://dot.test./b': { status: 200 },
		});
		await harvest(site, { url: 'https://dot.test./b' });
		await harvest(site, { url: 'https://dot.test/a' });
		expect(site.sent.map((r) => r.url.href)).toEqual([
			'https://dot.test/robots.txt',
			'https://dot.test./b',
			'https://dot.test/a',
		]);
		expect(cachedRobotsOrigins()).toBe(1);
		// …and the second request waited out the first one's interval: one queue.
		expect(site.slept).toEqual([MIN_INTERVAL_MS]);
		expect(siteKey(new URL('https://Dot.Test.:8443/x'))).toBe('https://dot.test:8443');
		expect(siteKey(new URL('https://[::1]/x'))).toBe('https://[::1]');
	});

	test(`past ${ROBOTS_MAX_ORIGINS} origins the oldest is evicted`, async () => {
		const site = fakeSite({});
		const ask = (i: number) =>
			robotsPolicyFor(new URL(`https://o${i}.test/`), site.clock.now, site.deps);
		for (let i = 0; i <= ROBOTS_MAX_ORIGINS; i++) await ask(i);
		expect(cachedRobotsOrigins()).toBe(ROBOTS_MAX_ORIGINS);
		const before = site.sent.length;
		await ask(ROBOTS_MAX_ORIGINS); // newest: still cached
		expect(site.sent.length).toBe(before);
		await ask(0); // oldest: evicted, fetched again
		expect(site.sent.length).toBe(before + 1);
	});
});

describe('M2: an address refusal is reported AS itself, never as "robots unavailable"', () => {
	// Every address reason the guard can throw — read from its own compiler-checked table.
	const addressReasons = Object.entries(SSRF_REFUSAL_KINDS)
		.filter(([, kind]) => kind === 'address')
		.map(([reason]) => reason);
	test('the guard has address reasons to drive (anti-vacuity)', () => {
		expect(addressReasons.length).toBeGreaterThanOrEqual(7);
	});
	for (const reason of addressReasons) {
		test(`reason ${reason}`, async () => {
			const refusal = new DedaloError('security.ssrf_blocked', {
				coordinates: { reason, host: 'x.test' },
			});
			const site = fakeSite({ 'https://x.test/robots.txt': { status: 0, error: refusal } });
			const error = await failureOf(harvest(site, { url: 'https://x.test/admin' }));
			expect(error).toBe(refusal);
		});
	}

	test('a transport failure of the robots fetch IS "unavailable"', async () => {
		const failure = new DedaloError('security.outbound_failed', {
			coordinates: { reason: 'timeout', stage: 'connect' },
		});
		const site = fakeSite({ 'https://t.test/robots.txt': { status: 0, error: failure } });
		expect(await codeOf(harvest(site, { url: 'https://t.test/x' }))).toBe(
			'harvest.robots_unavailable',
		);
	});
});

// ---------------------------------------------------------------------------
// The per-hop policy: shape, host, redirects
// ---------------------------------------------------------------------------

describe('per-hop policy — URL shape and host', () => {
	test('an allowlist admits the site and its subdomains, never a look-alike', () => {
		expect(hostMatches('lots.example.org', ['example.org'])).toBe(true);
		expect(hostMatches('EXAMPLE.org.', ['example.org'])).toBe(true);
		expect(hostMatches('evilexample.org', ['example.org'])).toBe(false);
		expect(hostMatches('example.org.evil.net', ['example.org'])).toBe(false);
	});

	test('IPv6 literals match bracketed or bare, on either side; an IP admits only itself', () => {
		expect(hostMatches('[2606:4700:4700::1111]', ['2606:4700:4700::1111'])).toBe(true);
		expect(hostMatches('[2606:4700:4700::1111]', ['[2606:4700:4700::1111]'])).toBe(true);
		expect(hostMatches('2606:4700:4700::1111', ['[2606:4700:4700::1111]'])).toBe(true);
		expect(hostMatches('[2606:4700:4700::1112]', ['[2606:4700:4700::1111]'])).toBe(false);
		expect(hostMatches('9.1.2.3', ['1.2.3'])).toBe(false);
	});

	test('a foreign scheme, a credential (a user name alone too) and a downgrade are refused', () => {
		const https = new URL('https://a.test/');
		const cases: [string, URL | null, string][] = [
			['ftp://a.test/', null, 'protocol'],
			['https://user:pw@a.test/', null, 'credentials'],
			['https://user@a.test/', null, 'credentials'],
			['https://:secret@a.test/', null, 'credentials'], // a password alone too
			['http://a.test/x', https, 'downgrade'],
			['https://b.test/', null, 'host_not_allowed'],
		];
		for (const [url, previous, reason] of cases) {
			let caught: unknown;
			try {
				assertHopAllowed(new URL(url), previous, { hosts: ['a.test'] });
			} catch (error) {
				caught = error;
			}
			expect(isDedaloError(caught) && caught.code, url).toBe('harvest.refused');
			expect((caught as DedaloError).details?.reason, url).toBe(reason);
		}
		expect(() => assertHopAllowed(new URL('http://a.test/'), https, { hosts: 'public' })).toThrow();
		expect(() =>
			assertHopAllowed(new URL('http://a.test/'), null, { hosts: 'public' }),
		).not.toThrow();
	});

	test('requireHttps refuses an http first hop', () => {
		expect(() =>
			assertHopAllowed(new URL('http://a.test/'), null, { hosts: 'public', requireHttps: true }),
		).toThrow(DedaloError);
		expect(() =>
			assertHopAllowed(new URL('https://a.test/'), null, { hosts: 'public', requireHttps: true }),
		).not.toThrow();
	});

	test('the redirect rules: 303 → bodiless GET; 301/302 turn a POST into a GET; 307/308 keep both', () => {
		const post = { url: new URL('https://a.test/form'), method: 'POST' as const, body: 'q=1' };
		for (const status of [301, 302, 303]) {
			expect(nextPlan(post, status, '/result')).toEqual({
				url: new URL('https://a.test/result'),
				method: 'GET',
			});
		}
		for (const status of [307, 308]) {
			expect(nextPlan(post, status, '/again')).toEqual({
				...post,
				url: new URL('https://a.test/again'),
			});
		}
	});

	test('a Location that is not a URL is a hop refusal, not a raw TypeError', () => {
		const plan = { url: new URL('https://a.test/'), method: 'GET' as const };
		expect(() => nextPlan(plan, 302, 'http://[::1')).toThrow(DedaloError);
	});
});

describe('harvestFetch — redirects end to end', () => {
	test('an https → http redirect is refused and no http hop is ever sent', async () => {
		const site = fakeSite({
			'https://sec.test/robots.txt': NOT_FOUND,
			'https://sec.test/lot': { status: 301, location: 'http://sec.test/lot' },
			'http://sec.test/robots.txt': NOT_FOUND,
			'http://sec.test/lot': { status: 200 },
		});
		const error = await failureOf(harvest(site, { url: 'https://sec.test/lot' }));
		expect(error.code).toBe('harvest.refused');
		expect(error.details?.reason).toBe('downgrade');
		expect(site.sent.some((r) => r.url.protocol === 'http:')).toBe(false);
	});

	test('a bad Location after a cross-origin redirect names the site ASKED, the hop only in the log', async () => {
		const site = fakeSite({
			'https://a.test/robots.txt': NOT_FOUND,
			'https://a.test/x': { status: 302, location: 'https://other.test/y' },
			'https://other.test/robots.txt': NOT_FOUND,
			'https://other.test/y': { status: 302, location: 'http://[bad' },
		});
		const error = await failureOf(harvest(site, { url: 'https://a.test/x' }));
		expect(toErrorBody(error).details).toEqual({ site: 'https://a.test', reason: 'bad_location' });
		expect(error.coordinates?.hop).toBe('other.test');
	});

	test('a user name alone in the URL is refused before anything is sent', async () => {
		const site = fakeSite({});
		const error = await failureOf(harvest(site, { url: 'https://user@cred.test/' }));
		expect(error.details?.reason).toBe('credentials');
		expect(site.sent).toHaveLength(0);
	});

	test(`exactly ${MAX_REDIRECTS} redirects are followed; the next one is refused, never sent`, async () => {
		const chain = (length: number): Record<string, Scripted> => {
			const routes: Record<string, Scripted> = { 'https://r.test/robots.txt': NOT_FOUND };
			for (let i = 0; i < length; i++)
				routes[`https://r.test/r${i}`] = { status: 302, location: `/r${i + 1}` };
			routes[`https://r.test/r${length}`] = { status: 200, body: 'end' };
			return routes;
		};
		const five = fakeSite(chain(MAX_REDIRECTS));
		const answer = await harvest(five, { url: 'https://r.test/r0' });
		expect(answer.url).toBe(`https://r.test/r${MAX_REDIRECTS}`);
		expect(answer.text()).toBe('end');

		clearRobotsCache();
		const six = fakeSite(chain(MAX_REDIRECTS + 1));
		const error = await failureOf(harvest(six, { url: 'https://r.test/r0' }));
		expect(error.details?.reason).toBe('too_many_redirects');
		const pages = pathsSent(six, 'r.test').filter((p) => p !== '/robots.txt');
		expect(pages).toHaveLength(MAX_REDIRECTS + 1);
		expect(pages).not.toContain(`/r${MAX_REDIRECTS + 1}`);
	});

	test('POST sends its method and body; 308 keeps them; 301 drops them and the Content-Type', async () => {
		const site = fakeSite({
			'https://p.test/robots.txt': NOT_FOUND,
			'https://p.test/search': { status: 308, location: '/search2' },
			'https://p.test/search2': { status: 301, location: '/results' },
			'https://p.test/results': { status: 200 },
		});
		await harvest(site, {
			url: 'https://p.test/search',
			method: 'POST',
			body: 'q=coin',
			headers: { 'Content-Type': 'text/plain' },
		});
		const [first, second, third] = site.sent.filter((r) => r.url.pathname !== '/robots.txt');
		expect([first?.method, first?.body, first?.headers.get('content-type')]).toEqual([
			'POST',
			'q=coin',
			'text/plain',
		]);
		expect([second?.method, second?.body]).toEqual(['POST', 'q=coin']);
		expect([third?.method, third?.body, third?.headers.get('content-type')]).toEqual([
			'GET',
			undefined,
			null,
		]);
	});

	test('a redirect leaving the allowlist is refused, and the wire names the site ASKED', async () => {
		const site = fakeSite({
			'https://a.test/robots.txt': NOT_FOUND,
			'https://a.test/out': { status: 301, location: 'https://10.0.0.5/admin' },
			'https://a.test/in': { status: 301, location: 'https://www.a.test/page' },
			'https://www.a.test/robots.txt': NOT_FOUND,
			'https://www.a.test/page': { status: 200, body: 'hello', contentType: 'text/html' },
		});
		const error = await failureOf(harvest(site, { url: 'https://a.test/out', hosts: ['a.test'] }));
		const body = toErrorBody(error);
		expect(body.code).toBe('harvest.refused');
		expect(body.details).toEqual({ site: 'https://a.test', reason: 'host_not_allowed' });
		const { debug: _debugOnly, ...wire } = body; // debug exists only under DEDALO_DEBUG_API_ERRORS
		expect(JSON.stringify(wire)).not.toContain('10.0.0.5');
		expect(body.message).toBe('This request may not visit that host');
		const answer = await harvest(site, { url: 'https://a.test/in', hosts: ['a.test'] });
		expect(answer.url).toBe('https://www.a.test/page');
		expect(answer.text()).toBe('hello');
	});

	test('an unparseable URL and a refused scheme are harvest.refused, with their reason', async () => {
		const site = fakeSite({});
		const bad = await failureOf(harvest(site, { url: 'not a url' }));
		expect(toErrorBody(bad).details).toEqual({ site: UNPARSEABLE_SITE, reason: 'unparseable' });
		// The caller's text never reaches the wire: it may hold credentials, a path, a query.
		const leaky = 'https://user:s3cret@exa mple.org/private/lot?token=abc';
		// The PUBLIC wire only: `debug` (DEDALO_DEBUG_API_ERRORS) carries a stack whose
		// file paths would make this depend on where the checkout lives.
		const { debug: _operatorOnly, ...body } = toErrorBody(
			await failureOf(harvest(site, { url: leaky })),
		);
		const wire = JSON.stringify(body);
		for (const secret of ['s3cret', 'private', 'token', 'exa mple']) {
			expect(wire).not.toContain(secret);
		}
		// A URL that parses but has no http(s) origin (an opaque one) names the fixed token,
		// never the literal "null".
		for (const opaque of ['file:///etc/passwd', 'data:text/plain,hi', 'javascript:alert(1)']) {
			const refused = toErrorBody(await failureOf(harvest(site, { url: opaque })));
			expect(refused.details, opaque).toEqual({ site: UNPARSEABLE_SITE, reason: 'protocol' });
			expect(refused.message, opaque).not.toContain('null');
		}
		expect(siteOf('x'.repeat(5000))).toBe(UNPARSEABLE_SITE);
		expect(siteOf('https://ok.test/a?b=1')).toBe('https://ok.test');
		// A first hop outside the allowlist: no redirect happened, and the sentence says so.
		const first = toErrorBody(
			await failureOf(harvest(site, { url: 'https://evil.test/lot', hosts: ['museum.test'] })),
		);
		expect(first.details).toEqual({ site: 'https://evil.test', reason: 'host_not_allowed' });
		expect(first.message).not.toContain('redirect');
		const ftp = await failureOf(harvest(site, { url: 'ftp://a.test/x' }));
		expect(ftp.details?.reason).toBe('protocol');
		const plain = await failureOf(harvest(site, { url: 'http://a.test/x', requireHttps: true }));
		expect(plain.details?.reason).toBe('requires_https');
	});

	test('https://[2606:4700:4700::1111]/x harvests — allowlisted bracketed, bare, or public', async () => {
		for (const hosts of [['[2606:4700:4700::1111]'], ['2606:4700:4700::1111'], 'public'] as const) {
			clearRobotsCache();
			clearPacingForTests();
			const site = fakeSite({
				'https://[2606:4700:4700::1111]/robots.txt': NOT_FOUND,
				'https://[2606:4700:4700::1111]/x': { status: 200, body: 'v6' },
			});
			const answer = await harvest(site, { url: 'https://[2606:4700:4700::1111]/x', hosts });
			expect(answer.text(), JSON.stringify(hosts)).toBe('v6');
		}
	});
});

// ---------------------------------------------------------------------------
// harvestFetch — the request and the response
// ---------------------------------------------------------------------------

describe('harvestFetch — the request the door sends', () => {
	test('robots Disallow refuses BEFORE the page is requested; the wire names the site', async () => {
		const site = fakeSite({
			'https://a.test/robots.txt': { status: 200, body: 'User-agent: *\nDisallow: /lots' },
		});
		const error = await failureOf(harvest(site, { url: 'https://a.test/lots/1' }));
		expect(error.code).toBe('harvest.robots_disallowed');
		expect(toErrorBody(error).details).toEqual({ site: 'https://a.test' });
		expect(site.sent.map((r) => r.url.pathname)).toEqual(['/robots.txt']);
	});

	test('a query-only Disallow (/*?sessionid) applies through harvestFetch', async () => {
		const site = fakeSite({
			'https://q.test/robots.txt': { status: 200, body: 'User-agent: *\nDisallow: /*?sessionid' },
			'https://q.test/lot?page=2': { status: 200 },
		});
		expect(await codeOf(harvest(site, { url: 'https://q.test/lot?sessionid=9' }))).toBe(
			'harvest.robots_disallowed',
		);
		expect((await harvest(site, { url: 'https://q.test/lot?page=2' })).ok).toBe(true);
	});

	test('an unreadable robots.txt (5xx) refuses, retryably, naming the site', async () => {
		const site = fakeSite({ 'https://a.test/robots.txt': { status: 500 } });
		const error = await failureOf(harvest(site, { url: 'https://a.test/lot' }));
		expect(error.code).toBe('harvest.robots_unavailable');
		expect(toErrorBody(error)).toMatchObject({
			retryable: true,
			details: { site: 'https://a.test' },
		});
	});

	test('the caller-header allowlist is exactly five names, any case', async () => {
		const site = fakeSite({
			'https://ua.test/robots.txt': NOT_FOUND,
			'https://ua.test/': { status: 200 },
		});
		await harvest(site, {
			url: 'https://ua.test/',
			headers: {
				accept: 'text/html',
				'Accept-Language': 'es',
				'X-Requested-With': 'XMLHttpRequest',
				Referer: 'https://ua.test/list',
			},
		});
		const page = site.sent[1];
		expect(page?.headers.get('accept-language')).toBe('es');
		expect(page?.headers.get('user-agent')).toBe(HARVEST_USER_AGENT);
		expect(HARVEST_USER_AGENT.toLowerCase().startsWith('dedalo/')).toBe(true);
		// The product version is the RELEASE IDENTITY (design Q10): what the sent
		// header names is the software that sent it. Bites on any non-stable
		// checkout — there the data version (`7.0.0`) is not the identity
		// (`7.0.0.dev`, `7.0.0-beta.N`), and the space after the version keeps a
		// `7.0.0` prefix of `7.0.0.dev` from matching.
		expect(
			page?.headers.get('user-agent')?.startsWith(`dedalo/${RELEASE_IDENTITY.version} (`),
		).toBe(true);
		for (const name of ['Authorization', 'Host', 'User-Agent', 'Cookie', 'cookie', 'Origin']) {
			expect(
				await codeOf(harvest(site, { url: 'https://ua.test/', headers: { [name]: 'x' } })),
				name,
			).toBe('internal.invariant');
		}
	});

	test('a form body (URLSearchParams) is sent urlencoded; a caller Content-Type wins', async () => {
		const site = fakeSite({
			'https://f.test/robots.txt': NOT_FOUND,
			'https://f.test/s': { status: 200 },
		});
		await harvest(site, {
			url: 'https://f.test/s',
			method: 'POST',
			body: new URLSearchParams({ q: 'denario romano', page: '2' }),
		});
		const form = site.sent[1];
		expect(form?.body).toBe('q=denario+romano&page=2');
		expect(form?.headers.get('content-type')).toBe(
			'application/x-www-form-urlencoded;charset=UTF-8',
		);
		await harvest(site, {
			url: 'https://f.test/s',
			method: 'POST',
			body: new URLSearchParams({ q: '1' }),
			headers: { 'Content-Type': 'application/x-custom' },
		});
		expect(site.sent[2]?.headers.get('content-type')).toBe('application/x-custom');
		expect(await codeOf(harvest(site, { url: 'https://f.test/s', body: 'q=1' }))).toBe(
			'internal.invariant',
		);
	});

	test('limits: absent → default; huge → clamped; a fraction never rounds to 0; NaN/0/∞ → defect', async () => {
		const site = fakeSite({
			'https://l.test/robots.txt': NOT_FOUND,
			'https://l.test/': { status: 200 },
		});
		await harvest(site, { url: 'https://l.test/' });
		expect(site.sent[1]).toMatchObject({
			timeoutMs: HARVEST_DEFAULT_TIMEOUT_MS,
			idleTimeoutMs: HARVEST_DEFAULT_IDLE_TIMEOUT_MS,
		});
		await harvest(site, {
			url: 'https://l.test/',
			maxBytes: 1e12,
			timeoutMs: 1e12,
			idleTimeoutMs: 1e12,
		});
		expect(site.sent[2]).toMatchObject({
			maxBytes: HARVEST_MAX_BYTES,
			timeoutMs: HARVEST_MAX_TIMEOUT_MS,
			idleTimeoutMs: HARVEST_MAX_TIMEOUT_MS,
		});
		await harvest(site, { url: 'https://l.test/', maxBytes: 0.5, timeoutMs: 5_000 });
		expect(site.sent[3]).toMatchObject({ maxBytes: 1, timeoutMs: 5_000, idleTimeoutMs: 5_000 });
		for (const bad of [Number.NaN, 0, -1, Number.POSITIVE_INFINITY]) {
			for (const key of ['maxBytes', 'timeoutMs', 'idleTimeoutMs'] as const) {
				expect(
					await codeOf(harvest(site, { url: 'https://l.test/', [key]: bad })),
					`${key}=${bad}`,
				).toBe('internal.invariant');
			}
		}
	});

	test('allowlist entries are normalized; a non-host entry is a defect', async () => {
		const site = fakeSite({
			'https://lots.norm.test/robots.txt': NOT_FOUND,
			'https://lots.norm.test/x': { status: 200 },
		});
		const answer = await harvest(site, {
			url: 'https://lots.norm.test/x',
			hosts: [' Norm.TEST. '],
		});
		expect(answer.ok).toBe(true);
		for (const bad of ['', 'norm.test/path', 'norm.test:8080']) {
			expect(await codeOf(harvest(site, { url: 'https://norm.test/', hosts: [bad] })), bad).toBe(
				'internal.invariant',
			);
		}
	});
});

describe('harvestFetch — the answer it returns', () => {
	test('ok is exactly 2xx; a non-2xx page is returned with its status, not thrown', async () => {
		const site = fakeSite({
			'https://s.test/robots.txt': NOT_FOUND,
			'https://s.test/200': { status: 200 },
			'https://s.test/299': { status: 299 },
			'https://s.test/300': { status: 300 },
			'https://s.test/410': { status: 410 },
		});
		const status = async (path: string) => {
			const answer = await harvest(site, { url: `https://s.test/${path}` });
			return [answer.status, answer.ok];
		};
		expect(await status('200')).toEqual([200, true]);
		expect(await status('299')).toEqual([299, true]);
		expect(await status('300')).toEqual([300, false]);
		expect(await status('410')).toEqual([410, false]);
	});

	test('content type lowercased; only the exposed headers, frozen', async () => {
		const site = fakeSite({
			'https://h2.test/robots.txt': NOT_FOUND,
			'https://h2.test/f': {
				status: 200,
				contentType: 'Application/PDF',
				headers: {
					'Content-Disposition': 'attachment; filename="lot.pdf"',
					ETag: '"v1"',
					'Last-Modified': 'Tue, 29 Sep 2026 10:00:00 GMT',
					'cf-mitigated': 'challenge',
					'Retry-After': '120',
					'Set-Cookie': 'session=secret',
					Server: 'nginx',
				},
			},
		});
		const answer = await harvest(site, { url: 'https://h2.test/f' });
		expect(answer.contentType).toBe('application/pdf');
		expect(answer.headers).toEqual({
			'cf-mitigated': 'challenge',
			'content-disposition': 'attachment; filename="lot.pdf"',
			'content-type': 'Application/PDF',
			etag: '"v1"',
			'last-modified': 'Tue, 29 Sep 2026 10:00:00 GMT',
			'retry-after': '120',
		});
		expect(Object.isFrozen(answer.headers)).toBe(true);
	});

	test('a body over the ceiling is harvest.too_large, naming the site and the limit', async () => {
		const site = fakeSite({
			'https://big2.test/robots.txt': NOT_FOUND,
			'https://big2.test/f': { status: 200, body: 'x'.repeat(100) },
		});
		const error = await failureOf(harvest(site, { url: 'https://big2.test/f', maxBytes: 10 }));
		expect(error.code).toBe('harvest.too_large');
		expect(toErrorBody(error)).toMatchObject({
			retryable: false,
			details: { site: 'https://big2.test', max_bytes: 10 },
		});
		// The request is wrong for this file (400, like media.too_large) — not a
		// rate limit: a 429 that is not retryable would contradict itself.
		expect(specOf('harvest.too_large')).toMatchObject({ category: 'caller', status: 400 });
	});

	test('expectContentType refuses a 2xx of another type unread; a non-2xx is returned', async () => {
		const site = fakeSite({
			'https://img.test/robots.txt': NOT_FOUND,
			'https://img.test/a.jpg': { status: 200, contentType: 'IMAGE/JPEG', body: 'jpg' },
			'https://img.test/page': {
				status: 200,
				contentType: 'text/html; charset=utf-8',
				body: '<p>',
			},
			'https://img.test/gone': { status: 404, contentType: 'text/html', body: 'nope' },
		});
		const expectContentType = ['image/'];
		expect((await harvest(site, { url: 'https://img.test/a.jpg', expectContentType })).text()).toBe(
			'jpg',
		);
		const error = await failureOf(
			harvest(site, { url: 'https://img.test/page', expectContentType }),
		);
		expect(error.code).toBe('harvest.unexpected_type');
		expect(toErrorBody(error).details).toEqual({
			site: 'https://img.test',
			content_type: 'text/html',
		});
		const gone = await harvest(site, { url: 'https://img.test/gone', expectContentType });
		expect([gone.status, gone.text()]).toEqual([404, 'nope']);
		for (const empty of [[], [''], ['  ']]) {
			expect(
				await codeOf(harvest(site, { url: 'https://img.test/a.jpg', expectContentType: empty })),
				JSON.stringify(empty),
			).toBe('internal.invariant');
		}
	});

	test('expectContentType prefixes are case-blind; a 3xx the door does not follow is returned whole', async () => {
		const site = fakeSite({
			'https://case.test/robots.txt': NOT_FOUND,
			'https://case.test/a.png': { status: 200, contentType: 'image/png', body: 'png' },
			'https://case.test/choices': { status: 300, contentType: 'text/html', body: 'pick one' },
		});
		const expectContentType = ['Image/'];
		const image = await harvest(site, { url: 'https://case.test/a.png', expectContentType });
		expect(image.text()).toBe('png');
		// Only a 2xx is type-filtered: a 300 is information, read and returned.
		const choices = await harvest(site, { url: 'https://case.test/choices', expectContentType });
		expect([choices.status, choices.ok, choices.text()]).toEqual([300, false, 'pick one']);
	});

	test('expectContentType is a PREFIX of the media type, not a substring anywhere in the header', async () => {
		const site = fakeSite({
			'https://pre.test/robots.txt': NOT_FOUND,
			'https://pre.test/p': { status: 200, contentType: 'text/html; x=image/', body: '<p>' },
		});
		const error = await failureOf(
			harvest(site, { url: 'https://pre.test/p', expectContentType: ['image/'] }),
		);
		expect(error.code).toBe('harvest.unexpected_type');
	});

	test('a media type on the wire is type/subtype or "none" — never the site’s free text', () => {
		const hostile = unexpectedType('https://s.test', 'text/html<script>alert(1)</script>');
		expect(toErrorBody(hostile).details).toEqual({ site: 'https://s.test', content_type: 'none' });
		const plain = unexpectedType('https://s.test', 'Text/HTML; charset=utf-8');
		expect(toErrorBody(plain).details).toEqual({
			site: 'https://s.test',
			content_type: 'text/html',
		});
	});

	test('charset: the header wins, then an XML declaration or <meta> in the first KiB, else UTF-8', () => {
		const latin1 = new Uint8Array([0x4d, 0xe1, 0x6c, 0x61, 0x67, 0x61]); // "Málaga"
		expect(decodeBody(latin1, 'text/html; charset=iso-8859-1')).toBe('Málaga');
		const meta = new TextEncoder().encode('<meta charset="windows-1252">');
		expect(decodeBody(new Uint8Array([...meta, 0xe1]), 'text/html')).toEndWith('á');
		const xml = new TextEncoder().encode('<?xml version="1.0" encoding="ISO-8859-1"?><r>');
		expect(decodeBody(new Uint8Array([...xml, 0xe1]), 'text/xml')).toEndWith('á');
		// The header outranks the document's own declaration.
		const utf8 = new TextEncoder().encode('<meta charset="windows-1252">é');
		expect(decodeBody(utf8, 'text/html; charset=utf-8')).toEndWith('é');
		// A label no decoder knows falls back to UTF-8 instead of throwing.
		expect(decodeBody(new TextEncoder().encode('ñ'), 'text/html; charset=x-no-such')).toBe('ñ');
		expect(decodeBody(new TextEncoder().encode('ñ'), 'text/html')).toBe('ñ');
		// A declaration past the first KiB is not a declaration: the body stays UTF-8.
		const late = new TextEncoder().encode(`${' '.repeat(1024)}<meta charset="windows-1252">`);
		expect(decodeBody(new Uint8Array([...late, 0xe1]), 'text/html')).toEndWith('\uFFFD');
	});
});

// ---------------------------------------------------------------------------
// Pacing
// ---------------------------------------------------------------------------

/** Clock + sleep + timer seams for acquireTurn alone. */
function pacingSeams(start = 5_000_000) {
	const clock = { now: start };
	const slept: number[] = [];
	const timers: { callback: () => void; ms: number }[] = [];
	const deps: PacingDeps = {
		now: () => clock.now,
		sleep: async (ms) => {
			slept.push(ms);
			clock.now += ms;
		},
		setTimer: (callback, ms) => {
			timers.push({ callback, ms });
		},
	};
	const runTimers = () => {
		for (const timer of timers.splice(0)) timer.callback();
	};
	return { clock, slept, timers, deps, runTimers };
}

describe('pacing — strictly serial per origin', () => {
	test('paceInterval clamps; NaN is the default, never NaN; Infinity is the ceiling', () => {
		expect(paceInterval(0)).toBe(MIN_INTERVAL_MS);
		expect(paceInterval(null)).toBe(MIN_INTERVAL_MS);
		expect(paceInterval(7_000)).toBe(7_000);
		expect(paceInterval(86_400_000)).toBe(MAX_INTERVAL_MS);
		expect(paceInterval(Number.NaN)).toBe(MIN_INTERVAL_MS);
		// The slowest pace asked for is our slowest, never our fastest.
		expect(paceInterval(Number.POSITIVE_INFINITY)).toBe(MAX_INTERVAL_MS);
		const overlong = parseRobots(`User-agent: *\nCrawl-delay: ${'9'.repeat(400)}`);
		expect(overlong.kind === 'rules' && paceInterval(overlong.crawlDelayMs)).toBe(MAX_INTERVAL_MS);
	});

	test('a turn is HELD across the request: the next waits for done, then the interval', async () => {
		const { clock, slept, deps } = pacingSeams();
		const first = await acquireTurn('https://pace.test', 4_000, deps);
		let secondStarted = false;
		const queued = deferred();
		const second = acquireTurn('https://pace.test', 4_000, deps, () => queued.resolve()).then(
			(done) => {
				secondStarted = true;
				return done;
			},
		);
		await queued.promise;
		await settle();
		expect(secondStarted, 'a slow request must not overlap the next one').toBe(false);
		clock.now += 10_000; // the first request took 10 s
		first();
		(await second)();
		expect(slept).toEqual([4_000]); // interval counted from the END of the first
	});

	test('onWait hears the queue (at least the interval) and then the exact pause', async () => {
		const { deps } = pacingSeams();
		const waits: [number, string][] = [];
		const onWait = (ms: number, origin: string) => {
			waits.push([ms, origin]);
		};
		const first = await acquireTurn('https://w.test', 5_000, deps, onWait);
		expect(waits).toEqual([]); // nobody ahead, nothing to wait for
		const second = acquireTurn('https://w.test', 5_000, deps, onWait);
		await settle();
		first();
		(await second)();
		expect(waits).toEqual([
			[5_000, 'https://w.test'],
			[5_000, 'https://w.test'],
		]);
	});

	test('done called twice is harmless: the next holder still excludes a third caller', async () => {
		const { clock, deps, runTimers } = pacingSeams();
		const first = await acquireTurn('https://twice.test', 3_000, deps);
		first();
		first();
		const holder = await acquireTurn('https://twice.test', 3_000, deps);
		clock.now += 60_000;
		runTimers(); // a drain must not forget an origin somebody holds
		let thirdStarted = false;
		const third = acquireTurn('https://twice.test', 3_000, deps).then((done) => {
			thirdStarted = true;
			return done;
		});
		await settle();
		expect(thirdStarted).toBe(false);
		holder();
		(await third)();
	});

	test('an idle origin is drained; a drain that fires early re-arms instead of stranding it', async () => {
		const { clock, timers, deps, runTimers } = pacingSeams();
		(await acquireTurn('https://drain.test', 3_000, deps))();
		expect(trackedOrigins()).toBe(1);
		expect(timers.map((t) => t.ms)).toEqual([3_000]); // armed for the interval, not 0
		runTimers(); // fires before the interval is over
		expect(trackedOrigins()).toBe(1);
		expect(timers.map((t) => t.ms)).toEqual([3_000]); // re-armed for what is LEFT
		clock.now += 3_000;
		runTimers();
		expect(trackedOrigins()).toBe(0);
	});

	test('a STALE drain timer never deletes the queue that replaced its own', async () => {
		const { clock, timers, deps } = pacingSeams();
		(await acquireTurn('https://stale.test', 3_000, deps))();
		(await acquireTurn('https://stale.test', 3_000, deps))();
		expect(timers).toHaveLength(2); // two drains armed on the same (first) queue
		clock.now += 60_000;
		timers[0]?.callback(); // drains the first queue
		expect(trackedOrigins()).toBe(0);
		const holder = await acquireTurn('https://stale.test', 3_000, deps); // a NEW queue, held
		timers[1]?.callback(); // the first queue's leftover timer
		expect(trackedOrigins()).toBe(1);
		let nextStarted = false;
		const next = acquireTurn('https://stale.test', 3_000, deps).then((done) => {
			nextStarted = true;
			return done;
		});
		await settle();
		expect(nextStarted, 'second request started while the first still holds the turn').toBe(false);
		holder();
		(await next)();
	});

	test('an onWait observer that throws never wedges the origin — queued or pausing', async () => {
		const { clock, deps } = pacingSeams();
		const throwing = () => {
			throw new Error('observer bug');
		};
		const logged: unknown[] = [];
		const originalError = console.error;
		console.error = (...args: unknown[]) => {
			logged.push(args);
		};
		try {
			// Queued branch: B joins behind A with a throwing observer.
			const a = await acquireTurn('https://obs.test', 3_000, deps);
			const b = acquireTurn('https://obs.test', 3_000, deps, throwing);
			await settle();
			a();
			(await b)(); // B still got its turn, and releases it
			// Interval branch: C pauses with a throwing observer.
			const c = await acquireTurn('https://obs.test', 3_000, deps, throwing);
			c();
			clock.now += 60_000;
			(await acquireTurn('https://obs.test', 3_000, deps))(); // nobody is stuck
		} finally {
			console.error = originalError;
		}
		expect(logged.length).toBeGreaterThanOrEqual(2);
	});

	test('a 429/503 Retry-After lengthens the next caller’s wait, clamped', async () => {
		expect(retryAfterMs('30', 0)).toBe(30_000);
		expect(retryAfterMs('86400', 0)).toBe(MAX_INTERVAL_MS);
		expect(
			retryAfterMs('Tue, 29 Sep 2026 10:00:20 GMT', Date.parse('Tue, 29 Sep 2026 10:00:00 GMT')),
		).toBe(20_000);
		expect(retryAfterMs('soon', 0)).toBe(0);
		expect(retryAfterMs(null, 0)).toBe(0);
		const site = fakeSite({
			'https://busy.test/robots.txt': NOT_FOUND,
			'https://busy.test/a': { status: 429, headers: { 'Retry-After': '30' } },
			'https://busy.test/b': { status: 200 },
			'https://busy.test/c': { status: 200, headers: { 'Retry-After': '50' } },
			'https://busy.test/d': { status: 200 },
		});
		expect((await harvest(site, { url: 'https://busy.test/a' })).status).toBe(429);
		await harvest(site, { url: 'https://busy.test/b' });
		expect(site.slept).toEqual([30_000]);
		await harvest(site, { url: 'https://busy.test/c' }); // Retry-After on a 200: ignored
		await harvest(site, { url: 'https://busy.test/d' });
		expect(site.slept).toEqual([30_000, MIN_INTERVAL_MS, MIN_INTERVAL_MS]);

		const unavailable = fakeSite({
			'https://down2.test/robots.txt': NOT_FOUND,
			'https://down2.test/a': { status: 503, headers: { 'Retry-After': '20' } },
			'https://down2.test/b': { status: 200 },
		});
		expect((await harvest(unavailable, { url: 'https://down2.test/a' })).status).toBe(503);
		await harvest(unavailable, { url: 'https://down2.test/b' });
		expect(unavailable.slept).toEqual([20_000]);
	});

	test('Retry-After is read by the guard’s ONE reader: a lenient date asks no wait', async () => {
		// `Date.parse` reads each as a far-future instant — a private reader would hold the
		// origin for the full minute; RFC 9110 knows neither form.
		for (const asked of ['2099-01-01T00:00:00Z', 'Fri, 01 Jan 2100 00:00:00 +0000', '1.5']) {
			clearPacingForTests();
			clearRobotsCache();
			const site = fakeSite({
				'https://lenient.test/robots.txt': NOT_FOUND,
				'https://lenient.test/a': { status: 429, headers: { 'Retry-After': asked } },
				'https://lenient.test/b': { status: 200 },
			});
			await harvest(site, { url: 'https://lenient.test/a' });
			await harvest(site, { url: 'https://lenient.test/b' });
			expect(site.slept, asked).toEqual([MIN_INTERVAL_MS]);
		}
	});

	test('every wait on the job’s signal removes its abort listener when it ends', async () => {
		// A wait that leaves its listener behind leaks one per request on a long job's
		// signal: the queue, the pause and the shared robots load all use one primitive.
		const signal = new AbortController().signal;
		const live = new Set<unknown>();
		let added = 0;
		const add = signal.addEventListener.bind(signal);
		const remove = signal.removeEventListener.bind(signal);
		signal.addEventListener = ((type: string, listener: EventListener, options?: object) => {
			if (type === 'abort') {
				added++;
				live.add(listener);
			}
			add(type, listener, options);
		}) as typeof signal.addEventListener;
		signal.removeEventListener = ((type: string, listener: EventListener, options?: object) => {
			if (type === 'abort') live.delete(listener);
			remove(type, listener, options);
		}) as typeof signal.removeEventListener;
		const site = fakeSite({
			'https://quiet.test/robots.txt': NOT_FOUND,
			'https://quiet.test/a': { status: 200 },
			'https://quiet.test/b': { status: 200 },
		});
		await runWithJobSignal(signal, async () => {
			await harvest(site, { url: 'https://quiet.test/a' });
			await Promise.all([
				harvest(site, { url: 'https://quiet.test/b' }),
				harvest(site, { url: 'https://quiet.test/a' }),
			]);
		});
		expect(added).toBeGreaterThan(0); // the waits did listen (anti-vacuity)
		expect(live.size).toBe(0);
	});

	test('Crawl-delay is obeyed but clamped; each redirect hop takes its own turn', async () => {
		const slow = fakeSite({
			'https://slow.test/robots.txt': { status: 200, body: 'User-agent: *\nCrawl-delay: 86400' },
			'https://slow.test/a': { status: 301, location: '/b' },
			'https://slow.test/b': { status: 200 },
		});
		await harvest(slow, { url: 'https://slow.test/a' });
		expect(slow.slept).toEqual([MAX_INTERVAL_MS]);
	});

	test('a hop that throws still releases its turn: the next harvest to the origin completes', async () => {
		const site = fakeSite({
			'https://fail.test/robots.txt': NOT_FOUND,
			'https://fail.test/a': {
				status: 0,
				error: new DedaloError('security.outbound_failed', {
					coordinates: { reason: 'transport' },
				}),
			},
			'https://fail.test/b': { status: 200 },
		});
		expect(await codeOf(harvest(site, { url: 'https://fail.test/a' }))).toBe(
			'security.outbound_failed',
		);
		let finished = false;
		const next = harvest(site, { url: 'https://fail.test/b' }).then(() => {
			finished = true;
		});
		await settle();
		expect(finished).toBe(true);
		await next;
		expect(site.slept).toEqual([MIN_INTERVAL_MS]);
	});

	test('a slow site never gets a second request while the first is unanswered', async () => {
		const firstAnswered = deferred();
		const site = fakeSite({
			'https://slow2.test/robots.txt': NOT_FOUND,
			'https://slow2.test/a': { status: 200, gate: firstAnswered.promise },
			'https://slow2.test/b': { status: 200 },
		});
		const first = harvest(site, { url: 'https://slow2.test/a' });
		const queued = deferred();
		const second = harvest(site, { url: 'https://slow2.test/b', onWait: () => queued.resolve() });
		await queued.promise;
		await settle();
		expect(pathsSent(site, 'slow2.test')).toEqual(['/robots.txt', '/a']);
		firstAnswered.resolve();
		await Promise.all([first, second]);
		expect(pathsSent(site, 'slow2.test')).toEqual(['/robots.txt', '/a', '/b']);
	});

	test('a job stopped in the QUEUE leaves at once, and its place never lets the next caller jump', async () => {
		const { deps } = pacingSeams();
		const holder = await acquireTurn('https://q2.test', 3_000, deps);
		const job = new AbortController();
		const queued = deferred();
		const stopped = runWithJobSignal(job.signal, () =>
			acquireTurn('https://q2.test', 3_000, deps, () => queued.resolve()),
		);
		await queued.promise;
		let thirdStarted = false;
		const third = acquireTurn('https://q2.test', 3_000, deps).then((done) => {
			thirdStarted = true;
			return done;
		});
		job.abort();
		const error = await failureOf(stopped);
		expect(error.coordinates).toEqual({ reason: 'aborted', stage: 'queue' });
		await settle();
		expect(thirdStarted, 'the stopped place released before the holder finished').toBe(false);
		holder();
		(await third)();
	});

	test('a job stopped during the PAUSE leaves at once (real sleep, timer cleared)', async () => {
		const clock = { now: 7_000_000 };
		const deps: PacingDeps = { now: () => clock.now, setTimer: () => {} };
		(await acquireTurn('https://p2.test', MAX_INTERVAL_MS, deps))();
		const job = new AbortController();
		const pausing = deferred();
		// Watch the real sleep's timer: a stopped pause must CLEAR it, not leave a
		// minute-long timer holding its closure.
		const originalSet = globalThis.setTimeout;
		const originalClear = globalThis.clearTimeout;
		const armed: unknown[] = [];
		const cleared: unknown[] = [];
		globalThis.setTimeout = ((callback: () => void, ms?: number) => {
			const timer = originalSet(callback, ms);
			if ((ms ?? 0) >= MAX_INTERVAL_MS) armed.push(timer);
			return timer;
		}) as unknown as typeof setTimeout;
		globalThis.clearTimeout = ((timer: Parameters<typeof clearTimeout>[0]) => {
			cleared.push(timer);
			originalClear(timer);
		}) as typeof clearTimeout;
		let stopped: Promise<unknown>;
		try {
			stopped = runWithJobSignal(job.signal, () =>
				acquireTurn('https://p2.test', 3_000, deps, () => pausing.resolve()),
			);
			await pausing.promise;
			await settle();
			job.abort();
		} finally {
			globalThis.setTimeout = originalSet;
			globalThis.clearTimeout = originalClear;
		}
		expect(armed).toHaveLength(1);
		expect(cleared).toContain(armed[0]);
		const error = await failureOf(stopped);
		expect(error.coordinates).toEqual({ reason: 'aborted', stage: 'pace' });
		// The place was given back: the origin's next caller is not stuck behind it.
		clock.now += MAX_INTERVAL_MS;
		(await acquireTurn('https://p2.test', 3_000, deps))();
	});

	test('done() clamps what it is handed: past the ceiling waits the ceiling, NaN waits the interval', async () => {
		const { slept, deps } = pacingSeams();
		(await acquireTurn('https://clamp.test', 3_000, deps))(10 * MAX_INTERVAL_MS);
		(await acquireTurn('https://clamp.test', 3_000, deps))(Number.NaN);
		(await acquireTurn('https://clamp.test', 3_000, deps))();
		expect(slept).toEqual([MAX_INTERVAL_MS, 3_000]);
	});

	test('a job stopped just before its pause never sleeps it (the real sleep checks first)', async () => {
		const job = new AbortController();
		const clock = { now: 7_000_000 };
		const deps: PacingDeps = { now: () => clock.now, setTimer: () => {} }; // the REAL sleep
		(await acquireTurn('https://late.test', 3_000, deps))();
		const started = performance.now();
		const error = await failureOf(
			runWithJobSignal(job.signal, () =>
				acquireTurn('https://late.test', 3_000, deps, () => job.abort()),
			),
		);
		expect(error.coordinates).toEqual({ reason: 'aborted', stage: 'pace' });
		expect(performance.now() - started).toBeLessThan(1_000);
	});

	test('an already-stopped job never takes a turn', async () => {
		const job = new AbortController();
		job.abort();
		const { deps } = pacingSeams();
		(await acquireTurn('https://pre.test', 3_000, deps))();
		const error = await failureOf(
			runWithJobSignal(job.signal, () => acquireTurn('https://pre.test', 3_000, deps)),
		);
		expect(error.coordinates?.reason).toBe('aborted');
	});
});

// ---------------------------------------------------------------------------
// The REAL primitive under the door
// ---------------------------------------------------------------------------

describe('fetchPinnedHop — the guard runs inside the primitive', () => {
	test('a private or rebinding-shaped target is refused before any socket', async () => {
		for (const url of [
			'http://127.0.0.1/',
			'http://[::1]/',
			'http://[64:ff9b::a9fe:a9fe]/',
			'http://localhost/',
		]) {
			const code = await codeOf(
				fetchPinnedHop(
					{
						url: new URL(url),
						method: 'GET',
						headers: new Headers(),
						maxBytes: 1,
						timeoutMs: 1_000,
					},
					{
						// A name resolves through the seam, never the machine's resolver.
						lookup: async () => [
							{ address: '127.0.0.1', family: 4 },
							{ address: '::1', family: 6 },
						],
					},
				),
			);
			expect(code, url).toBe('security.ssrf_blocked');
		}
	});

	test('the door reads the real primitive’s body cap and skipped body as its own codes', async () => {
		const answers: Record<string, Response> = {};
		const pinned = {
			lookup: async () => [{ address: '93.184.215.14', family: 4 }],
			fetch: async (url: string) => {
				const path = new URL(url).pathname;
				if (path === '/robots.txt') return new Response('', { status: 404 });
				return answers[path] ?? new Response('', { status: 404 });
			},
		};
		answers['/big'] = new Response('x'.repeat(64), { status: 200 });
		const big = await failureOf(
			harvestFetch(
				{ url: 'https://real.test/big', hosts: 'public', maxBytes: 8 },
				{ pinned, sleep: async () => {} },
			),
		);
		expect(big.code).toBe('harvest.too_large');
		answers['/page'] = new Response('<p>', {
			status: 200,
			headers: { 'content-type': 'text/html' },
		});
		const page = await failureOf(
			harvestFetch(
				{ url: 'https://real.test/page', hosts: 'public', expectContentType: ['image/'] },
				{ pinned, sleep: async () => {} },
			),
		);
		expect(page.code).toBe('harvest.unexpected_type');
	});
});

// ---------------------------------------------------------------------------
// The interactive profile (OUTBOUND_SPEC.md §3.1)
// ---------------------------------------------------------------------------
//
// `interactiveFetch` is the door's second, CLOSED profile — a request a person is
// waiting for, relayed by a core route. These gates pin, by OUTCOME, what the
// profile promises and what it must never change: the default path (robots.txt,
// the 3 s serial pace, its own queue) is untouched, a tool cannot select the new
// profile, the profile's state is its own, its caps hold, a stopped caller frees
// its place, and every redirect hop is still vetted.

const TILES = 'https://tiles.test';
const TILES_ORIGIN = TILES;
const PNG: Scripted = { status: 200, contentType: 'image/png', body: 'tile' };

/** Wait-ceiling timers a test fires by hand, so no real 10 s timer is ever waited on. */
function ceilingTimers() {
	const armed: { fire: () => void; ms: number; cancelled: boolean }[] = [];
	const startTimer: NonNullable<InteractiveDeps['startTimer']> = (fire, ms) => {
		const entry = { fire, ms, cancelled: false };
		armed.push(entry);
		return () => {
			entry.cancelled = true;
		};
	};
	return { armed, startTimer };
}

/**
 * `call` inside a job scope, as a core route runs it (`runWithJobSignal(request.signal, …)`):
 * a signal nobody fires — the client that stays — unless the caller already brought its own.
 * `interactiveFetch` REFUSES to run without one.
 */
function stoppable<T>(call: () => T): T {
	if (currentJobSignal() !== undefined) return call();
	return runWithJobSignal(new AbortController().signal, call);
}

/**
 * Spacing pauses the test lifts by hand. The fake site's own sleep moves the clock at
 * once, which is right for one caller at a time and wrong for several pausing together:
 * here a pause lasts until `advance` brings the clock to it, so what each request did
 * and WHEN can be read off the clock.
 */
function manualPauses(clock: { now: number }) {
	const waiting: { at: number; wake: () => void }[] = [];
	const sleep: NonNullable<InteractiveDeps['sleep']> = (ms) =>
		new Promise<void>((wake) => {
			waiting.push({ at: clock.now + ms, wake });
		});
	return {
		sleep,
		pending: () => waiting.length,
		advance: async (ms: number) => {
			clock.now += ms;
			for (const due of waiting.filter((pause) => pause.at <= clock.now)) {
				waiting.splice(waiting.indexOf(due), 1);
				due.wake();
			}
			await settle();
		},
	};
}

/** Each call is by default a person of its own, so a gate about origins and budgets is not also a gate about one person's cap. */
let holderSequence = 0;

/** One interactive request to the tile host, with the fake site's clock and seams. */
function interactive(
	site: FakeSite,
	request: Partial<InteractiveRequest> & { url: string },
	extra: Partial<InteractiveDeps> = {},
) {
	return stoppable(() =>
		interactiveFetch(
			{
				hosts: ['tiles.test'],
				mediaTypes: ['image/png'],
				addressFrom: 'registry',
				holder: `user:${++holderSequence}`,
				...request,
			},
			{ ...site.deps, ...extra },
		),
	);
}

/** A tile route per index, each held by its own gate. */
function gatedTiles(count: number, host = 'tiles.test') {
	const gates = Array.from({ length: count }, () => deferred());
	const routes: Record<string, Scripted> = {};
	gates.forEach((gate, index) => {
		routes[`https://${host}/t/${index}.png`] = { ...PNG, gate: gate.promise };
	});
	return { gates, routes };
}

describe('interactiveFetch — the default path is unchanged', () => {
	test('harvestFetch still asks robots.txt; the interactive profile never does', async () => {
		const site = fakeSite({
			'https://tiles.test/robots.txt': { status: 200, body: 'User-agent: *\nDisallow: /' },
			'https://tiles.test/t/1.png': PNG,
		});
		// The default profile obeys the Disallow…
		expect(await codeOf(harvest(site, { url: 'https://tiles.test/t/1.png' }))).toBe(
			'harvest.robots_disallowed',
		);
		clearRobotsCache();
		site.sent.length = 0;
		// …the interactive one never reads it: a person's browser asked for the tile.
		const response = await interactive(site, { url: 'https://tiles.test/t/1.png' });
		expect(response.ok).toBe(true);
		expect(site.sent.map((r) => r.url.pathname)).toEqual(['/t/1.png']);
		expect(cachedRobotsOrigins()).toBe(0);
	});

	test('an interactive request leaves the default pace exactly as it was', async () => {
		const site = fakeSite({
			'https://cat.test/robots.txt': NOT_FOUND,
			'https://cat.test/a': { status: 200 },
			'https://cat.test/b': { status: 200 },
			'https://tiles.test/t/1.png': PNG,
		});
		await harvest(site, { url: 'https://cat.test/a' });
		for (let i = 0; i < 3; i++) await interactive(site, { url: 'https://tiles.test/t/1.png' });
		await harvest(site, { url: 'https://cat.test/b' });
		// The default pace slept its own floor once, for its own two requests.
		expect(site.slept).toEqual([MIN_INTERVAL_MS]);
		expect(trackedOrigins()).toBe(1); // cat.test alone — tiles.test never entered its map
	});

	test('the default path’s limits are the documented ones, not the interactive profile’s', async () => {
		const site = fakeSite({ 'https://cat.test/robots.txt': NOT_FOUND, 'https://cat.test/a': PNG });
		await harvest(site, { url: 'https://cat.test/a' });
		const hop = site.sent.find((r) => r.url.pathname === '/a');
		expect(hop?.maxBytes).toBe(HARVEST_DEFAULT_MAX_BYTES);
		expect(hop?.timeoutMs).toBe(HARVEST_DEFAULT_TIMEOUT_MS);
		expect(hop?.idleTimeoutMs).toBe(HARVEST_DEFAULT_IDLE_TIMEOUT_MS);
		// …and an expected type there is still a PREFIX match (the interactive one is exact).
		const prefixed = fakeSite({
			'https://cat.test/robots.txt': NOT_FOUND,
			'https://cat.test/svg': { status: 200, contentType: 'image/svg+xml', body: '<svg/>' },
		});
		const response = await harvest(prefixed, {
			url: 'https://cat.test/svg',
			expectContentType: ['image/'],
		});
		expect(response.contentType).toBe('image/svg+xml');
	});
});

describe('interactiveFetch — a tool cannot select the profile', () => {
	test('no type carries a profile selector', () => {
		// Each directive is verified by `tsc` (an unused one is an error): the line below
		// it must NOT type-check, which is the whole assertion.
		const takesRequest = (_request: HarvestRequest): void => {};
		const takesDeps = (_deps: HarvestDeps): void => {};
		const takesInteractive = (_request: InteractiveRequest): void => {};
		// @ts-expect-error HarvestRequest has no profile field
		takesRequest({ url: 'u', hosts: 'public', profile: 'interactive' });
		// @ts-expect-error HarvestDeps has no profile field
		takesDeps({ profile: 'interactive' });
		// One short line each, so the directive and the error sit on the same line.
		const ok = {
			url: 'u',
			hosts: ['x.test'],
			mediaTypes: ['image/png'],
			addressFrom: 'registry',
			holder: 'user:1',
		} as const;
		// @ts-expect-error an interactive request needs an allowlist, never 'public'
		takesInteractive({ ...ok, hosts: 'public' });
		// @ts-expect-error nor a method…
		takesInteractive({ ...ok, method: 'POST' });
		// @ts-expect-error …a body…
		takesInteractive({ ...ok, body: 'x' });
		// @ts-expect-error …or a wait observer
		takesInteractive({ ...ok, onWait: () => {} });
		// @ts-expect-error who chose the host is required: a route cannot forget to say
		takesInteractive({ url: 'u', hosts: ['x.test'], mediaTypes: ['image/png'], holder: 'u' });
		// @ts-expect-error and so is who is waiting
		takesInteractive({
			url: 'u',
			hosts: ['x.test'],
			mediaTypes: ['image/png'],
			addressFrom: 'stored',
		});
		// @ts-expect-error and it is one of two closed values
		takesInteractive({ ...ok, addressFrom: 'user' });
		// Anti-vacuity: the same shapes without the extras DO type-check.
		takesRequest({ url: 'u', hosts: 'public' });
		takesDeps({});
		takesInteractive(ok);
		takesInteractive({ ...ok, addressFrom: 'stored' });
	});

	test('harvestFetch REFUSES a request or deps that name one, before any socket', async () => {
		const site = fakeSite({
			'https://tiles.test/robots.txt': NOT_FOUND,
			'https://tiles.test/t/1.png': PNG,
		});
		const url = 'https://tiles.test/t/1.png';
		for (const selector of [
			{ profile: 'interactive' },
			{ profile: 'default' },
			{ interactive: true },
		]) {
			const inRequest = await failureOf(
				harvestFetch({ url, hosts: 'public', ...selector } as never, site.deps),
			);
			expect(inRequest.code, JSON.stringify(selector)).toBe('internal.invariant');
			expect(inRequest.coordinates?.where).toBe('request');
			const inDeps = await failureOf(
				harvestFetch({ url, hosts: 'public' }, { ...site.deps, ...selector } as never),
			);
			expect(inDeps.code, JSON.stringify(selector)).toBe('internal.invariant');
			expect(inDeps.coordinates?.where).toBe('deps');
		}
		expect(site.sent).toEqual([]); // nothing was fetched, robots.txt included
		// Anti-vacuity: the same call without the selector goes through.
		expect((await harvest(site, { url })).ok).toBe(true);
	});

	test('a selector inherited from a prototype is seen too', async () => {
		const site = fakeSite({});
		const request = Object.create({ profile: 'interactive' }) as HarvestRequest;
		Object.assign(request, { url: 'https://tiles.test/t/1.png', hosts: 'public' });
		expect((await failureOf(harvestFetch(request, site.deps))).code).toBe('internal.invariant');
		expect(site.sent).toEqual([]);
	});

	test('an interactive request carries nothing but what InteractiveRequest names', async () => {
		const site = fakeSite({ 'https://tiles.test/t/1.png': PNG });
		// A method, a body and a profile smuggled in through an untyped caller: dropped.
		await interactive(site, {
			url: 'https://tiles.test/t/1.png',
			...({ method: 'POST', body: 'x=1', profile: 'default' } as object),
		});
		expect(site.sent).toHaveLength(1);
		expect(site.sent[0]?.method).toBe('GET');
		expect(site.sent[0]?.body).toBeUndefined();
	});
});

describe('interactiveFetch — the request it sends', () => {
	// The User-Agent depends on the installation's configured address: pin it, restore it.
	const ADDRESS_KEYS = ['DEDALO_PROTOCOL', 'DEDALO_HOST'] as const;
	const savedAddress = new Map<string, string | undefined>();
	beforeEach(() => {
		for (const key of ADDRESS_KEYS) savedAddress.set(key, process.env[key]);
		process.env.DEDALO_PROTOCOL = 'https://';
		process.env.DEDALO_HOST = '';
	});
	afterEach(() => {
		for (const [key, value] of savedAddress) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	});

	test('the User-Agent names the installation when an outside machine could reach it, and is the door’s plain identity otherwise', async () => {
		const site = fakeSite({ 'https://tiles.test/t/1.png': PNG });
		process.env.DEDALO_HOST = 'museum.example.org';
		await interactive(site, { url: 'https://tiles.test/t/1.png' });
		expect(site.sent[0]?.headers.get('user-agent')).toBe(
			HARVEST_USER_AGENT.replace(/\)$/, '; https://museum.example.org)'),
		);
		// an internal name is not published to a provider: the plain identity, byte for byte
		process.env.DEDALO_HOST = 'intranet-srv01';
		await interactive(site, { url: 'https://tiles.test/t/1.png' });
		expect(site.sent[1]?.headers.get('user-agent')).toBe(HARVEST_USER_AGENT);
		// the DEFAULT profile's identity is unchanged by the installation's address: one string for a crawler
		process.env.DEDALO_HOST = 'museum.example.org';
		const crawl = fakeSite({
			'https://tiles.test/robots.txt': NOT_FOUND,
			'https://tiles.test/t/1.png': PNG,
		});
		await harvest(crawl, { url: 'https://tiles.test/t/1.png', hosts: ['tiles.test'] });
		expect(crawl.sent.length).toBeGreaterThan(0);
		for (const request of crawl.sent) {
			expect(request.headers.get('user-agent'), request.url.pathname).toBe(HARVEST_USER_AGENT);
		}
	});

	test('GET, with the door’s identity and only the headers it allows', async () => {
		const site = fakeSite({ 'https://tiles.test/t/1.png': PNG });
		await interactive(site, {
			url: 'https://tiles.test/t/1.png',
			headers: { Accept: 'image/png', referer: 'https://dedalo.example/' },
		});
		const sent = site.sent[0];
		expect(sent?.headers.get('user-agent')).toBe(HARVEST_USER_AGENT);
		expect(sent?.headers.get('accept')).toBe('image/png');
		expect(sent?.headers.get('referer')).toBe('https://dedalo.example/');
		expect([...(sent?.headers.keys() ?? [])].sort()).toEqual(['accept', 'referer', 'user-agent']);
	});

	test('a revalidation’s two validators are allowed — and ONLY the interactive profile’s caller may set them', async () => {
		const site = fakeSite({
			'https://tiles.test/t/1.png': { status: 304, headers: { ETag: '"v1"' } },
			'https://cat.test/robots.txt': NOT_FOUND,
			'https://cat.test/t.png': PNG,
		});
		const answered = await interactive(site, {
			url: 'https://tiles.test/t/1.png',
			headers: {
				Accept: 'image/png',
				'If-None-Match': '"v1"',
				'if-modified-since': 'Wed, 21 Oct 2026 07:28:00 GMT',
			},
		});
		const sent = site.sent[0];
		expect(sent?.headers.get('if-none-match')).toBe('"v1"');
		expect(sent?.headers.get('if-modified-since')).toBe('Wed, 21 Oct 2026 07:28:00 GMT');
		expect([...(sent?.headers.keys() ?? [])].sort()).toEqual([
			'accept',
			'if-modified-since',
			'if-none-match',
			'user-agent',
		]);
		// a 304 comes back as the non-2xx it is, with the validator it states and no body
		expect(answered.status).toBe(304);
		expect(answered.ok).toBe(false);
		expect(answered.headers.etag).toBe('"v1"');
		expect(answered.bytes.byteLength).toBe(0);
		// the default profile's caller is unchanged: a tool may not set a validator
		for (const name of ['If-None-Match', 'If-Modified-Since']) {
			const failure = await failureOf(
				harvest(site, { url: 'https://cat.test/t.png', headers: { [name]: 'x' } }),
			);
			expect(failure.code, name).toBe('internal.invariant');
		}
	});

	test('any other header is a defect — a cookie, a credential, the identity — and nothing is sent', async () => {
		const site = fakeSite({ 'https://tiles.test/t/1.png': PNG });
		for (const name of [
			'Cookie',
			'Authorization',
			'User-Agent',
			'Host',
			'X-Requested-With',
			'Content-Type',
		]) {
			const failure = await failureOf(
				interactive(site, { url: 'https://tiles.test/t/1.png', headers: { [name]: 'x' } }),
			);
			expect(failure.code, name).toBe('internal.invariant');
		}
		expect(site.sent).toEqual([]);
	});

	test('the limits are the interactive ones, a caller may only lower them', async () => {
		const site = fakeSite({ 'https://tiles.test/t/1.png': PNG });
		await interactive(site, { url: 'https://tiles.test/t/1.png' });
		expect(site.sent[0]).toMatchObject({
			maxBytes: INTERACTIVE_DEFAULT_MAX_BYTES,
			timeoutMs: INTERACTIVE_DEFAULT_TIMEOUT_MS,
			idleTimeoutMs: INTERACTIVE_DEFAULT_IDLE_TIMEOUT_MS,
		});
		await interactive(site, {
			url: 'https://tiles.test/t/1.png',
			maxBytes: 100 * 1024 * 1024,
			timeoutMs: 10 * 60_000,
			idleTimeoutMs: 10 * 60_000,
		});
		expect(site.sent[1]).toMatchObject({
			maxBytes: INTERACTIVE_MAX_BYTES,
			timeoutMs: INTERACTIVE_MAX_TIMEOUT_MS,
			idleTimeoutMs: INTERACTIVE_MAX_TIMEOUT_MS, // never longer than the total
		});
		await interactive(site, { url: 'https://tiles.test/t/1.png', maxBytes: 64, timeoutMs: 1_000 });
		expect(site.sent[2]).toMatchObject({ maxBytes: 64, timeoutMs: 1_000, idleTimeoutMs: 1_000 });
		for (const odd of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
			const failure = await failureOf(
				interactive(site, { url: 'https://tiles.test/t/1.png', maxBytes: odd }),
			);
			expect(failure.code, String(odd)).toBe('internal.invariant');
		}
	});

	test('an allowlist, a media type and who chose the host are REQUIRED, and nothing is sent without them', async () => {
		const site = fakeSite({ 'https://tiles.test/t/1.png': PNG });
		const url = 'https://tiles.test/t/1.png';
		const base = {
			url,
			hosts: ['tiles.test'],
			mediaTypes: ['image/png'],
			addressFrom: 'registry' as const,
			holder: 'user:1',
		};
		const broken: object[] = [
			{ ...base, hosts: 'public' },
			{ ...base, hosts: [] },
			{ ...base, hosts: undefined },
			{ ...base, hosts: ['not a host'] },
			{ ...base, mediaTypes: [] },
			{ ...base, mediaTypes: undefined },
			{ ...base, mediaTypes: [''] },
			// Who chose the host: absent, unknown, a different case, or the wrong kind of value.
			{ ...base, addressFrom: undefined },
			{ ...base, addressFrom: 'editor' },
			{ ...base, addressFrom: 'STORED' },
			{ ...base, addressFrom: true },
			// Who is waiting: absent, empty, too long, or not a string.
			{ ...base, holder: undefined },
			{ ...base, holder: '' },
			{ ...base, holder: 'u'.repeat(INTERACTIVE_MAX_HOLDER_LENGTH + 1) },
			{ ...base, holder: 957 },
		];
		for (const request of broken) {
			const failure = await failureOf(
				stoppable(() => interactiveFetch(request as InteractiveRequest, site.deps)),
			);
			expect(failure.code, JSON.stringify(request)).toBe('internal.invariant');
		}
		expect(site.sent).toEqual([]);
		expect(interactiveState(TILES_ORIGIN).total).toBe(0);
		// Anti-vacuity: the base request itself goes through, and so does the other value.
		expect((await stoppable(() => interactiveFetch(base, site.deps))).ok).toBe(true);
		expect(
			(await stoppable(() => interactiveFetch({ ...base, addressFrom: 'stored' }, site.deps))).ok,
		).toBe(true);
		const longest = 'u'.repeat(INTERACTIVE_MAX_HOLDER_LENGTH);
		expect(
			(await stoppable(() => interactiveFetch({ ...base, holder: longest }, site.deps))).ok,
		).toBe(true);
	});

	test('a spacing that is not a finite number >= 0 is a defect; a long one is clamped', async () => {
		const site = fakeSite({ 'https://tiles.test/t/1.png': PNG });
		for (const odd of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
			const failure = await failureOf(
				interactive(site, { url: 'https://tiles.test/t/1.png', minIntervalMs: odd }),
			);
			expect(failure.code, String(odd)).toBe('internal.invariant');
		}
		await interactive(site, { url: 'https://tiles.test/t/1.png', minIntervalMs: 60_000 });
		await interactive(site, { url: 'https://tiles.test/t/1.png', minIntervalMs: 60_000 });
		expect(site.slept).toEqual([INTERACTIVE_MAX_INTERVAL_MS]);
	});
});

describe('interactiveFetch — the answer it accepts', () => {
	test('only the exact media types: svg, html and a look-alike are refused unread', async () => {
		const answers: Record<string, string> = {
			'/png': 'image/png',
			'/params': 'IMAGE/PNG; charset=binary',
			'/svg': 'image/svg+xml',
			'/html': 'text/html; charset=utf-8',
			'/lookalike': 'image/pngx',
			'/none': '',
		};
		const routes: Record<string, Scripted> = {};
		for (const [path, contentType] of Object.entries(answers)) {
			routes[`https://tiles.test${path}`] = { status: 200, body: 'body', contentType };
		}
		const site = fakeSite(routes);
		const outcome = async (path: string) =>
			codeOf(interactive(site, { url: `https://tiles.test${path}` }));
		expect(await outcome('/png')).toBe('none');
		expect(await outcome('/params')).toBe('none');
		for (const path of ['/svg', '/html', '/lookalike', '/none']) {
			expect(await outcome(path), path).toBe('harvest.unexpected_type');
		}
	});

	test('several media types may be named, each matched whole', async () => {
		const site = fakeSite({
			'https://tiles.test/jpg': { status: 200, contentType: 'image/jpeg', body: 'j' },
			'https://tiles.test/gif': { status: 200, contentType: 'image/gif', body: 'g' },
		});
		const types = ['image/png', 'image/jpeg'];
		expect((await interactive(site, { url: 'https://tiles.test/jpg', mediaTypes: types })).ok).toBe(
			true,
		);
		expect(
			await codeOf(interactive(site, { url: 'https://tiles.test/gif', mediaTypes: types })),
		).toBe('harvest.unexpected_type');
	});

	test('a non-2xx answer is returned with its status, not turned into a transport failure', async () => {
		const site = fakeSite({
			'https://tiles.test/gone': { status: 404, contentType: 'text/html', body: '<p>no</p>' },
		});
		const response = await interactive(site, { url: 'https://tiles.test/gone' });
		expect(response.status).toBe(404);
		expect(response.ok).toBe(false);
	});

	test('the byte ceiling is enforced, and the default is the interactive one', async () => {
		const site = fakeSite({
			'https://tiles.test/big': { ...PNG, body: 'x'.repeat(INTERACTIVE_DEFAULT_MAX_BYTES + 1) },
			'https://tiles.test/fits': { ...PNG, body: 'x'.repeat(INTERACTIVE_DEFAULT_MAX_BYTES) },
		});
		const big = await failureOf(interactive(site, { url: 'https://tiles.test/big' }));
		expect(big.code).toBe('harvest.too_large');
		expect(big.coordinates?.max_bytes).toBe(INTERACTIVE_DEFAULT_MAX_BYTES);
		expect((await interactive(site, { url: 'https://tiles.test/fits' })).bytes.byteLength).toBe(
			INTERACTIVE_DEFAULT_MAX_BYTES,
		);
		const small = await failureOf(
			interactive(site, { url: 'https://tiles.test/fits', maxBytes: 16 }),
		);
		expect(small.code).toBe('harvest.too_large');
	});
});

describe('interactiveFetch — every hop is still vetted', () => {
	test('the URL itself must be on the allowlist', async () => {
		const site = fakeSite({ 'https://other.test/t/1.png': PNG });
		const failure = await failureOf(interactive(site, { url: 'https://other.test/t/1.png' }));
		expect(failure.code).toBe('harvest.refused');
		expect(failure.coordinates?.reason).toBe('host_not_allowed');
		expect(site.sent).toEqual([]);
	});

	test('a redirect off the allowlist is refused and the new target is never contacted', async () => {
		const site = fakeSite({
			'https://tiles.test/t/1.png': { status: 302, location: 'https://evil.test/t/1.png' },
			'https://evil.test/t/1.png': PNG,
		});
		const failure = await failureOf(interactive(site, { url: 'https://tiles.test/t/1.png' }));
		expect(failure.coordinates?.reason).toBe('host_not_allowed');
		expect(site.sent.map((r) => r.url.host)).toEqual(['tiles.test']);
		expect(interactiveState(TILES_ORIGIN).inFlight).toBe(0);
	});

	test('a redirect inside the allowlist is followed, each hop taking its own slot in turn', async () => {
		const last = deferred();
		const site = fakeSite({
			'https://tiles.test/a': { status: 301, location: '/b' },
			'https://tiles.test/b': { status: 302, location: 'https://cdn.tiles.test/c' },
			'https://cdn.tiles.test/c': { ...PNG, gate: last.promise },
		});
		const call = interactive(site, { url: 'https://tiles.test/a' });
		await settle();
		expect(site.sent.map((r) => r.url.pathname)).toEqual(['/a', '/b', '/c']);
		// One slot at a time: the earlier hops gave theirs back before the next took it.
		expect(interactiveState(TILES_ORIGIN).inFlight).toBe(0);
		expect(interactiveState('https://cdn.tiles.test').inFlight).toBe(1);
		last.resolve();
		const response = await call;
		expect(response.url).toBe('https://cdn.tiles.test/c');
		expect(interactiveState('https://cdn.tiles.test').inFlight).toBe(0);
	});

	test('https → http is refused, requireHttps refuses a plain first hop, and the loop ends', async () => {
		const site = fakeSite({
			'https://tiles.test/down': { status: 302, location: 'http://tiles.test/down2' },
			'http://tiles.test/plain': PNG,
			'https://tiles.test/loop': { status: 302, location: '/loop' },
		});
		const down = await failureOf(interactive(site, { url: 'https://tiles.test/down' }));
		expect(down.coordinates?.reason).toBe('downgrade');
		const plain = await failureOf(
			interactive(site, { url: 'http://tiles.test/plain', requireHttps: true }),
		);
		expect(plain.coordinates?.reason).toBe('requires_https');
		const loop = await failureOf(interactive(site, { url: 'https://tiles.test/loop' }));
		expect(loop.coordinates?.reason).toBe('too_many_redirects');
		expect(site.sent.filter((r) => r.url.pathname === '/loop')).toHaveLength(MAX_REDIRECTS + 1);
		expect(interactiveState(TILES_ORIGIN).inFlight).toBe(0);
	});

	test('credentials in the address and a non-http scheme are refused before any socket', async () => {
		const site = fakeSite({});
		for (const [url, reason] of [
			['https://user:pw@tiles.test/t.png', 'credentials'],
			['ftp://tiles.test/t.png', 'protocol'],
			['not a url', 'unparseable'],
		] as const) {
			const failure = await failureOf(interactive(site, { url }));
			expect(failure.coordinates?.reason, url).toBe(reason);
		}
		expect(site.sent).toEqual([]);
	});

	test('the guard runs inside the real primitive: a private address is refused, its slot given back', async () => {
		let sockets = 0;
		const pinned = {
			lookup: async () => [{ address: '10.0.0.7', family: 4 }],
			fetch: async () => {
				sockets++;
				return new Response('x');
			},
		};
		const failure = await failureOf(
			stoppable(() =>
				interactiveFetch(
					{
						url: 'https://tiles.test/t/1.png',
						hosts: ['tiles.test'],
						mediaTypes: ['image/png'],
						addressFrom: 'registry',
						holder: 'user:1',
					},
					{ pinned },
				),
			),
		);
		expect(failure.code).toBe('security.ssrf_blocked');
		expect(sockets).toBe(0);
		expect(interactiveState(TILES_ORIGIN)).toMatchObject({ inFlight: 0, total: 0, origins: 0 });
	});

	test('through the real primitive: an image is returned and robots.txt is never requested', async () => {
		const requested: string[] = [];
		const pinned = {
			lookup: async () => [{ address: '93.184.215.14', family: 4 }],
			fetch: async (url: string) => {
				requested.push(new URL(url).pathname);
				return new Response('tile-bytes', {
					status: 200,
					headers: { 'content-type': 'image/png' },
				});
			},
		};
		const response = await stoppable(() =>
			interactiveFetch(
				{
					url: 'https://tiles.test/t/1.png',
					hosts: ['tiles.test'],
					mediaTypes: ['image/png'],
					addressFrom: 'registry',
					holder: 'user:1',
				},
				{ pinned },
			),
		);
		expect(response.text()).toBe('tile-bytes');
		expect(requested).toEqual(['/t/1.png']);
		expect(cachedRobotsOrigins()).toBe(0);
	});
});

describe('interactiveFetch — only the scheme’s own port, on every hop', () => {
	const refusedPort = async (site: FakeSite, url: string) => {
		const failure = await failureOf(interactive(site, { url }));
		expect(failure.code, url).toBe('harvest.refused');
		expect(failure.coordinates?.reason, url).toBe('port_not_allowed');
		expect(failure.details?.reason, url).toBe('port_not_allowed');
		return failure;
	};

	test('a stored address on another port of an allowed host is refused before any socket', async () => {
		const site = fakeSite({
			'https://tiles.test:6379/t.png': PNG,
			'https://tiles.test:8443/t.png': PNG,
			'https://tiles.test:80/t.png': PNG,
			'http://tiles.test:443/t.png': PNG,
			'http://tiles.test:8080/t.png': PNG,
		});
		for (const url of [
			'https://tiles.test:6379/t.png',
			'https://tiles.test:8443/t.png',
			'https://tiles.test:80/t.png', // 80 is http's port, not https's
			'http://tiles.test:443/t.png',
			'http://tiles.test:8080/t.png',
		]) {
			await refusedPort(site, url);
		}
		expect(site.sent).toEqual([]);
		expect(interactiveState(TILES_ORIGIN)).toMatchObject({ inFlight: 0, total: 0, origins: 0 });
	});

	test('the scheme’s own port, spelled out or not, is the one that passes', async () => {
		const site = fakeSite({ 'https://tiles.test/t.png': PNG, 'http://tiles.test/t.png': PNG });
		expect((await interactive(site, { url: 'https://tiles.test:443/t.png' })).ok).toBe(true);
		expect((await interactive(site, { url: 'http://tiles.test:80/t.png' })).ok).toBe(true);
		expect(site.sent.map((r) => r.url.toString())).toEqual([
			'https://tiles.test/t.png',
			'http://tiles.test/t.png',
		]);
	});

	test('a redirect to another port of the allowed host is refused and never contacted', async () => {
		const site = fakeSite({
			'https://tiles.test/a': { status: 302, location: 'https://tiles.test:8443/b' },
			'https://tiles.test/c': { status: 302, location: 'https://cdn.tiles.test:5432/d' },
			'https://tiles.test:8443/b': PNG,
			'https://cdn.tiles.test:5432/d': PNG,
		});
		await refusedPort(site, 'https://tiles.test/a');
		await refusedPort(site, 'https://tiles.test/c');
		expect(site.sent.map((r) => r.url.host)).toEqual(['tiles.test', 'tiles.test']);
		expect(interactiveState(TILES_ORIGIN).inFlight).toBe(0);
	});

	test('an http → https upgrade on the standard ports is not a port change', async () => {
		const site = fakeSite({
			'http://tiles.test/a': { status: 301, location: 'https://tiles.test/a' },
			'https://tiles.test/a': PNG,
		});
		const response = await interactive(site, { url: 'http://tiles.test/a' });
		expect(response.url).toBe('https://tiles.test/a');
	});

	test('a host the allowlist does not admit is refused as that, whatever its port', async () => {
		const site = fakeSite({ 'https://other.test:8443/t.png': PNG });
		const failure = await failureOf(interactive(site, { url: 'https://other.test:8443/t.png' }));
		expect(failure.coordinates?.reason).toBe('host_not_allowed');
	});

	test('the default profile is unchanged: a harvesting tool may still name a port', async () => {
		const site = fakeSite({
			'https://cat.test:8443/robots.txt': NOT_FOUND,
			'https://cat.test:8443/page': { status: 200, body: 'ok' },
		});
		const response = await harvest(site, { url: 'https://cat.test:8443/page' });
		expect(response.ok).toBe(true);
		expect(site.sent.map((r) => r.url.port)).toEqual(['8443', '8443']);
	});
});

describe('interactiveFetch — the headers a cache follows', () => {
	const FRESHNESS = {
		'Cache-Control': 'public, max-age=3600',
		Expires: 'Wed, 21 Oct 2026 07:28:00 GMT',
		Age: '12',
		Date: 'Wed, 21 Oct 2026 06:28:00 GMT',
	};
	const answer: Scripted = {
		...PNG,
		headers: { ...FRESHNESS, ETag: '"v1"', 'Set-Cookie': 'sid=1', 'X-Anything': 'else' },
	};

	test('the interactive answer carries cache-control, expires, age and date — and still no cookie', async () => {
		const site = fakeSite({ 'https://tiles.test/t.png': answer });
		const response = await interactive(site, { url: 'https://tiles.test/t.png' });
		expect(response.headers).toEqual({
			'cache-control': 'public, max-age=3600',
			expires: 'Wed, 21 Oct 2026 07:28:00 GMT',
			age: '12',
			date: 'Wed, 21 Oct 2026 06:28:00 GMT',
			etag: '"v1"',
			'content-type': 'image/png',
		});
		expect(Object.isFrozen(response.headers)).toBe(true);
	});

	test('the default answer is what it was: a tool sees none of the four', async () => {
		const site = fakeSite({
			'https://cat.test/robots.txt': NOT_FOUND,
			'https://cat.test/t.png': answer,
		});
		const response = await harvest(site, { url: 'https://cat.test/t.png' });
		expect(Object.keys(response.headers).sort()).toEqual(['content-type', 'etag']);
	});
});

describe('interactiveFetch — the caps hold, in state of its own', () => {
	test('at most INTERACTIVE_MAX_CONCURRENT requests are in flight to one origin; the rest queue', async () => {
		const { gates, routes } = gatedTiles(INTERACTIVE_MAX_CONCURRENT + 2);
		const site = fakeSite(routes);
		const { startTimer } = ceilingTimers();
		const calls = gates.map((_, i) =>
			interactive(site, { url: `https://tiles.test/t/${i}.png` }, { startTimer }),
		);
		await settle();
		expect(pathsSent(site, 'tiles.test')).toHaveLength(INTERACTIVE_MAX_CONCURRENT);
		expect(interactiveState(TILES_ORIGIN)).toMatchObject({
			inFlight: INTERACTIVE_MAX_CONCURRENT,
			waiting: 2,
		});

		gates[0]?.resolve();
		await settle();
		expect(pathsSent(site, 'tiles.test')).toHaveLength(INTERACTIVE_MAX_CONCURRENT + 1);
		expect(interactiveState(TILES_ORIGIN)).toMatchObject({
			inFlight: INTERACTIVE_MAX_CONCURRENT,
			waiting: 1,
		});

		for (const gate of gates) gate.resolve();
		await Promise.all(calls);
		expect(pathsSent(site, 'tiles.test')).toHaveLength(gates.length);
		expect(interactiveState(TILES_ORIGIN)).toMatchObject({ inFlight: 0, waiting: 0, origins: 0 });
	});

	test('the cap is per origin: a saturated origin does not hold another back', async () => {
		const { gates, routes } = gatedTiles(INTERACTIVE_MAX_CONCURRENT + 1);
		const site = fakeSite({ ...routes, 'https://other.test/t/1.png': PNG });
		const { startTimer } = ceilingTimers();
		const busy = gates.map((_, i) =>
			interactive(site, { url: `https://tiles.test/t/${i}.png` }, { startTimer }),
		);
		await settle();
		const other = await interactive(
			site,
			{ url: 'https://other.test/t/1.png', hosts: ['other.test'] },
			{ startTimer },
		);
		expect(other.ok).toBe(true);
		for (const gate of gates) gate.resolve();
		await Promise.all(busy);
	});

	test('a global cap bounds the requests in flight across all origins', async () => {
		const total = INTERACTIVE_MAX_TOTAL + 4;
		const gates = Array.from({ length: total }, () => deferred());
		const routes: Record<string, Scripted> = {};
		gates.forEach((gate, i) => {
			routes[`https://h${i}.tiles.test/t.png`] = { ...PNG, gate: gate.promise };
		});
		const site = fakeSite(routes);
		const { startTimer } = ceilingTimers();
		const calls = gates.map((_, i) =>
			interactive(site, { url: `https://h${i}.tiles.test/t.png` }, { startTimer }),
		);
		await settle();
		expect(site.sent).toHaveLength(INTERACTIVE_MAX_TOTAL);
		expect(interactiveState(TILES_ORIGIN).total).toBe(INTERACTIVE_MAX_TOTAL);

		gates[0]?.resolve();
		await settle();
		expect(site.sent).toHaveLength(INTERACTIVE_MAX_TOTAL + 1);
		for (const gate of gates) gate.resolve();
		await Promise.all(calls);
		expect(interactiveState(TILES_ORIGIN)).toMatchObject({ total: 0, origins: 0 });
	});

	test('a caller refused at the global limiter gives its origin’s slot back', async () => {
		const gates = Array.from({ length: INTERACTIVE_MAX_TOTAL }, () => deferred());
		const routes: Record<string, Scripted> = { 'https://late.tiles.test/t.png': PNG };
		gates.forEach((gate, i) => {
			routes[`https://h${i}.tiles.test/t.png`] = { ...PNG, gate: gate.promise };
		});
		const site = fakeSite(routes);
		const { armed, startTimer } = ceilingTimers();
		const calls = gates.map((_, i) =>
			interactive(site, { url: `https://h${i}.tiles.test/t.png` }, { startTimer }),
		);
		await settle();
		const late = interactive(site, { url: 'https://late.tiles.test/t.png' }, { startTimer });
		await settle();
		// It holds its own origin's slot while it waits for one of the global few…
		expect(interactiveState('https://late.tiles.test').inFlight).toBe(1);
		expect(armed).toHaveLength(1);
		expect(armed[0]?.ms).toBe(INTERACTIVE_MAX_WAIT_MS); // the global queue has a ceiling too
		armed[0]?.fire();
		const refused = await failureOf(late);
		expect(refused.code).toBe('rate.limited');
		// …and gives it back when the global ceiling refuses it.
		expect(interactiveState('https://late.tiles.test').inFlight).toBe(0);
		expect(site.sent.some((r) => r.url.host === 'late.tiles.test')).toBe(false);
		for (const gate of gates) gate.resolve();
		await Promise.all(calls);
	});

	test('the queue is bounded: one caller too many is refused rate.limited, at once', async () => {
		const total = INTERACTIVE_MAX_CONCURRENT + INTERACTIVE_MAX_QUEUE + 1;
		const { gates, routes } = gatedTiles(total);
		const site = fakeSite(routes);
		const { startTimer } = ceilingTimers();
		const calls = gates.map((_, i) =>
			interactive(site, { url: `https://tiles.test/t/${i}.png` }, { startTimer }),
		);
		const refused = await failureOf(calls[total - 1] as Promise<unknown>);
		expect(refused.code).toBe('rate.limited');
		expect(refused.coordinates?.reason).toBe('queue_full');
		expect(interactiveState(TILES_ORIGIN)).toMatchObject({
			inFlight: INTERACTIVE_MAX_CONCURRENT,
			waiting: INTERACTIVE_MAX_QUEUE,
		});
		for (const gate of gates) gate.resolve();
		await Promise.all(calls.slice(0, total - 1));
		expect(site.sent).toHaveLength(total - 1);
	});

	test('a caller still queued when its wait ceiling arrives is refused; the running ones are untouched', async () => {
		const { gates, routes } = gatedTiles(INTERACTIVE_MAX_CONCURRENT + 1);
		const site = fakeSite(routes);
		const { armed, startTimer } = ceilingTimers();
		const calls = gates.map((_, i) =>
			interactive(site, { url: `https://tiles.test/t/${i}.png` }, { startTimer }),
		);
		const last = calls[INTERACTIVE_MAX_CONCURRENT] as Promise<unknown>;
		await settle();
		expect(armed).toHaveLength(1); // only the one that had to wait armed a ceiling
		expect(armed[0]?.ms).toBe(INTERACTIVE_MAX_WAIT_MS);
		armed[0]?.fire();
		const refused = await failureOf(last);
		expect(refused.code).toBe('rate.limited');
		expect(refused.coordinates?.reason).toBe('wait_exceeded');
		expect(site.sent).toHaveLength(INTERACTIVE_MAX_CONCURRENT);
		for (const gate of gates) gate.resolve();
		await Promise.all(calls.slice(0, INTERACTIVE_MAX_CONCURRENT));
		expect(interactiveState(TILES_ORIGIN)).toMatchObject({ inFlight: 0, waiting: 0 });
	});

	test('minIntervalMs spaces two starts at one origin, start to start', async () => {
		const site = fakeSite({ 'https://tiles.test/t/1.png': PNG });
		await interactive(site, { url: 'https://tiles.test/t/1.png', minIntervalMs: 1_000 });
		expect(site.slept).toEqual([]);
		await interactive(site, { url: 'https://tiles.test/t/1.png', minIntervalMs: 1_000 });
		expect(site.slept).toEqual([1_000]);
	});

	test('without minIntervalMs there is no pause at all — the cap alone paces it', async () => {
		const site = fakeSite({ 'https://tiles.test/t/1.png': PNG });
		for (let i = 0; i < 5; i++) await interactive(site, { url: 'https://tiles.test/t/1.png' });
		expect(site.slept).toEqual([]);
		expect(site.timers).toEqual([]); // and no drain timer: an idle, unspaced origin is gone at once
	});

	test('a hop that throws still gives its slot back', async () => {
		const site = fakeSite({
			'https://tiles.test/boom': {
				status: 0,
				error: new DedaloError('security.outbound_failed', {
					coordinates: { reason: 'transport' },
				}),
			},
			'https://tiles.test/t/1.png': PNG,
		});
		for (let i = 0; i < INTERACTIVE_MAX_CONCURRENT + 2; i++) {
			expect(await codeOf(interactive(site, { url: 'https://tiles.test/boom' }))).toBe(
				'security.outbound_failed',
			);
		}
		expect(interactiveState(TILES_ORIGIN)).toMatchObject({ inFlight: 0, total: 0 });
		expect((await interactive(site, { url: 'https://tiles.test/t/1.png' })).ok).toBe(true);
	});
});

describe('interactiveFetch — the hosts an editor wrote cannot take the whole budget', () => {
	/**
	 * `hosts` x `perHost` gated STORED requests, created in order host by host: the first
	 * INTERACTIVE_MAX_STORED_TOTAL of them can hold the stored budget, the rest queue for it
	 * (each holding its origin's slot — four per host is exactly the origin cap).
	 */
	function storedHolders(hostCount: number, perHost: number) {
		const hosts = Array.from({ length: hostCount }, (_, i) => `s${i}.stored.test`);
		const gates: ReturnType<typeof deferred>[] = [];
		const routes: Record<string, Scripted> = {};
		const requests: { url: string; host: string }[] = [];
		for (const host of hosts) {
			for (let j = 0; j < perHost; j++) {
				const gate = deferred();
				gates.push(gate);
				const url = `https://${host}/t/${j}.png`;
				routes[url] = { ...PNG, gate: gate.promise };
				requests.push({ url, host });
			}
		}
		const start = (site: FakeSite, extra: Partial<InteractiveDeps>) =>
			requests.map(({ url, host }) =>
				interactive(site, { url, hosts: [host], addressFrom: 'stored' }, extra),
			);
		return { hosts, gates, routes, start };
	}

	/** `count` gated REGISTRY requests, one origin each (so the origin cap is never the limit). */
	function registryHolders(count: number) {
		const gates = Array.from({ length: count }, () => deferred());
		const routes: Record<string, Scripted> = {};
		gates.forEach((gate, i) => {
			routes[`https://r${i}.registry.test/t.png`] = { ...PNG, gate: gate.promise };
		});
		const start = (site: FakeSite, extra: Partial<InteractiveDeps>) =>
			gates.map((_, i) =>
				interactive(
					site,
					{
						url: `https://r${i}.registry.test/t.png`,
						hosts: [`r${i}.registry.test`],
						addressFrom: 'registry',
					},
					extra,
				),
			);
		return { gates, routes, start };
	}

	/** A call's outcome as a value, so a refusal that lands early never goes unhandled. */
	const outcomes = (calls: readonly Promise<unknown>[]) =>
		calls.map((call) =>
			call.then(
				() => 'ok',
				(error: unknown) => (isDedaloError(error) ? error : 'untyped'),
			),
		);

	test('four slow hosts of different editors hold the stored budget and not a slot more, so the registry keeps its half', async () => {
		// The reproduction of the finding: 4 per origin x 4 origins used to be all 16 global slots.
		const stored = storedHolders(4, INTERACTIVE_MAX_CONCURRENT);
		const registry = registryHolders(INTERACTIVE_MAX_TOTAL - INTERACTIVE_MAX_STORED_TOTAL);
		const site = fakeSite({ ...stored.routes, ...registry.routes });
		const { startTimer } = ceilingTimers();
		const storedCalls = stored.start(site, { startTimer });
		await settle();
		// Sixteen stored requests, each holding its origin's slot: only the stored budget is in flight…
		expect(site.sent).toHaveLength(INTERACTIVE_MAX_STORED_TOTAL);
		expect(interactiveState(TILES_ORIGIN)).toMatchObject({
			stored: INTERACTIVE_MAX_STORED_TOTAL,
			storedWaiting: stored.gates.length - INTERACTIVE_MAX_STORED_TOTAL,
			total: INTERACTIVE_MAX_STORED_TOTAL,
			totalWaiting: 0, // a stored request waiting for its budget parks no global slot
		});

		// …so the other half of the global budget is free for the registry's origins, at once.
		const registryCalls = registry.start(site, { startTimer });
		await settle();
		expect(site.sent).toHaveLength(INTERACTIVE_MAX_TOTAL);
		expect(interactiveState(TILES_ORIGIN)).toMatchObject({
			total: INTERACTIVE_MAX_TOTAL,
			stored: INTERACTIVE_MAX_STORED_TOTAL,
		});

		for (const gate of [...registry.gates, ...stored.gates]) gate.resolve();
		const results = await Promise.all(outcomes([...registryCalls, ...storedCalls]));
		expect(results.every((result) => result === 'ok')).toBe(true);
		expect(interactiveState(TILES_ORIGIN)).toMatchObject({
			total: 0,
			stored: 0,
			storedWaiting: 0,
			origins: 0,
		});
	});

	test('a registry viewer’s burst is served while the stored budget is held, and refused by nothing', async () => {
		const stored = storedHolders(4, INTERACTIVE_MAX_CONCURRENT);
		const burst = Array.from(
			{ length: INTERACTIVE_MAX_TOTAL },
			(_, i) => `https://tiles.test/b/${i}.png`,
		);
		const site = fakeSite({
			...stored.routes,
			...Object.fromEntries(burst.map((url) => [url, PNG])),
		});
		const { startTimer } = ceilingTimers();
		const storedCalls = stored.start(site, { startTimer });
		await settle();
		const results = await Promise.all(
			outcomes(burst.map((url) => interactive(site, { url }, { startTimer }))),
		);
		// Every tile of the burst came back, while eight stored requests were still on the wire.
		expect(results).toEqual(burst.map(() => 'ok'));
		expect(interactiveState(TILES_ORIGIN).stored).toBe(INTERACTIVE_MAX_STORED_TOTAL);
		for (const gate of stored.gates) gate.resolve();
		await Promise.all(storedCalls);
	});

	test('a registry request never counts against the stored budget', async () => {
		const registry = registryHolders(INTERACTIVE_MAX_TOTAL);
		const site = fakeSite(registry.routes);
		const calls = registry.start(site, ceilingTimers());
		await settle();
		expect(interactiveState(TILES_ORIGIN)).toMatchObject({
			total: INTERACTIVE_MAX_TOTAL,
			stored: 0,
		});
		for (const gate of registry.gates) gate.resolve();
		await Promise.all(calls);
	});

	test('the stored requests that lose the budget are refused at their ceiling, and give their places back', async () => {
		const stored = storedHolders(4, INTERACTIVE_MAX_CONCURRENT);
		const site = fakeSite({ ...stored.routes, 'https://tiles.test/t/1.png': PNG });
		const { armed, startTimer } = ceilingTimers();
		const calls = stored.start(site, { startTimer });
		const results = outcomes(calls);
		const losers = results.slice(INTERACTIVE_MAX_STORED_TOTAL);
		await settle();
		// The eight that did not get the budget armed a ceiling; the eight that did armed none.
		expect(armed).toHaveLength(losers.length);
		expect(armed.every((timer) => timer.ms === INTERACTIVE_MAX_WAIT_MS)).toBe(true);
		for (const timer of armed) timer.fire();
		for (const error of await Promise.all(losers)) {
			expect(isDedaloError(error) ? error.code : error).toBe('rate.limited');
			expect(isDedaloError(error) ? error.coordinates?.reason : '').toBe('wait_exceeded');
		}
		// The two hosts that lost hold nothing; the two that won still hold their four each.
		expect(interactiveState('https://s2.stored.test').inFlight).toBe(0);
		expect(interactiveState('https://s3.stored.test').inFlight).toBe(0);
		expect(interactiveState('https://s0.stored.test').inFlight).toBe(INTERACTIVE_MAX_CONCURRENT);
		expect(interactiveState(TILES_ORIGIN)).toMatchObject({
			stored: INTERACTIVE_MAX_STORED_TOTAL,
			storedWaiting: 0,
		});
		// And the registry was never in the way.
		expect(
			(await interactive(site, { url: 'https://tiles.test/t/1.png' }, { startTimer })).ok,
		).toBe(true);
		for (const gate of stored.gates) gate.resolve();
		await Promise.all(results);
		expect(interactiveState(TILES_ORIGIN)).toMatchObject({ stored: 0, total: 0, origins: 0 });
	});

	test('the stored queue is bounded: past INTERACTIVE_MAX_STORED_QUEUE waiting, the next is refused at once', async () => {
		const perHost = INTERACTIVE_MAX_CONCURRENT;
		const fullHosts = (INTERACTIVE_MAX_STORED_TOTAL + INTERACTIVE_MAX_STORED_QUEUE) / perHost;
		const stored = storedHolders(fullHosts + 1, perHost);
		const site = fakeSite(stored.routes);
		const { startTimer } = ceilingTimers();
		const calls = stored.start(site, { startTimer });
		const results = outcomes(calls);
		await settle();
		// The first hosts fill the budget and its queue; every caller of the extra host finds
		// the queue full and is refused at once — no ceiling is waited for, no place is kept.
		expect(interactiveState(TILES_ORIGIN)).toMatchObject({
			stored: INTERACTIVE_MAX_STORED_TOTAL,
			storedWaiting: INTERACTIVE_MAX_STORED_QUEUE,
		});
		const extras = results.slice(fullHosts * perHost);
		expect(extras).toHaveLength(perHost);
		for (const error of await Promise.all(extras)) {
			expect(isDedaloError(error) ? error.code : error).toBe('rate.limited');
			expect(isDedaloError(error) ? error.coordinates?.reason : '').toBe('queue_full');
		}
		expect(interactiveState(`https://${stored.hosts[fullHosts]}`)).toMatchObject({ inFlight: 0 });
		// Everyone ahead of it is served in the end.
		for (const gate of stored.gates) gate.resolve();
		const served = await Promise.all(results.slice(0, fullHosts * perHost));
		expect(served.every((result) => result === 'ok')).toBe(true);
		expect(interactiveState(TILES_ORIGIN)).toMatchObject({
			stored: 0,
			storedWaiting: 0,
			origins: 0,
		});
	});

	test('a stored request that wins its budget but loses the global queue gives both places back', async () => {
		const registry = registryHolders(INTERACTIVE_MAX_TOTAL);
		const site = fakeSite({ ...registry.routes, 'https://late.stored.test/t.png': PNG });
		const { armed, startTimer } = ceilingTimers();
		const held = registry.start(site, { startTimer });
		await settle();
		const late = interactive(
			site,
			{ url: 'https://late.stored.test/t.png', hosts: ['late.stored.test'], addressFrom: 'stored' },
			{ startTimer },
		);
		await settle();
		// It holds its origin's slot and a stored one, and waits for one of the global few.
		expect(interactiveState('https://late.stored.test').inFlight).toBe(1);
		expect(interactiveState(TILES_ORIGIN)).toMatchObject({ stored: 1, totalWaiting: 1 });
		expect(armed).toHaveLength(1);
		armed[0]?.fire();
		const refused = await failureOf(late);
		expect(refused.code).toBe('rate.limited');
		expect(interactiveState('https://late.stored.test').inFlight).toBe(0);
		expect(interactiveState(TILES_ORIGIN)).toMatchObject({ stored: 0, totalWaiting: 0 });
		expect(site.sent.some((r) => r.url.host === 'late.stored.test')).toBe(false);
		for (const gate of registry.gates) gate.resolve();
		await Promise.all(held);
	});

	test('a stopped stored caller leaves the stored queue and hands its place on', async () => {
		const stored = storedHolders(3, INTERACTIVE_MAX_CONCURRENT); // 12 callers: 8 hold, 4 wait
		const site = fakeSite(stored.routes);
		const { startTimer } = ceilingTimers();
		const stopper = new AbortController();
		const calls = stored.hosts.flatMap((host, hostIndex) =>
			Array.from({ length: INTERACTIVE_MAX_CONCURRENT }, (_, j) => {
				const run = () =>
					interactive(
						site,
						{ url: `https://${host}/t/${j}.png`, hosts: [host], addressFrom: 'stored' },
						{ startTimer },
					);
				// The last host's first waiter belongs to a job that will be stopped.
				return hostIndex === 2 && j === 0 ? runWithJobSignal(stopper.signal, run) : run();
			}),
		);
		const results = outcomes(calls);
		await settle();
		expect(interactiveState(TILES_ORIGIN)).toMatchObject({ stored: 8, storedWaiting: 4 });

		stopper.abort();
		await settle();
		expect(interactiveState(TILES_ORIGIN).storedWaiting).toBe(3); // it left the queue at once
		expect(interactiveState('https://s2.stored.test').inFlight).toBe(3); // and gave its origin slot back
		const stopped = (await Promise.all(results.slice(8, 9)))[0];
		expect(isDedaloError(stopped) ? stopped.coordinates?.reason : stopped).toBe('aborted');

		// A stored slot freed now goes to the waiter behind it, in order.
		stored.gates[0]?.resolve();
		await settle();
		expect(interactiveState(TILES_ORIGIN)).toMatchObject({ stored: 8, storedWaiting: 2 });
		for (const gate of stored.gates) gate.resolve();
		await Promise.all(results);
		expect(interactiveState(TILES_ORIGIN)).toMatchObject({
			stored: 0,
			storedWaiting: 0,
			origins: 0,
		});
	});

	test('a redirect hop of a stored address draws on the stored budget in turn, like the first', async () => {
		const secondHop = deferred();
		const site = fakeSite({
			'https://tiles.test/old.png': { status: 301, location: 'https://tiles.test/t/2.png' },
			'https://tiles.test/t/2.png': { ...PNG, gate: secondHop.promise },
		});
		const call = interactive(site, {
			url: 'https://tiles.test/old.png',
			addressFrom: 'stored',
		});
		await settle();
		// The first hop released its places before the second took its own: one of each, not two.
		expect(site.sent.map((r) => r.url.pathname)).toEqual(['/old.png', '/t/2.png']);
		expect(interactiveState(TILES_ORIGIN)).toMatchObject({ stored: 1, total: 1, inFlight: 1 });
		secondHop.resolve();
		expect((await call).ok).toBe(true);
		expect(interactiveState(TILES_ORIGIN)).toMatchObject({ stored: 0, total: 0, origins: 0 });
	});
});

describe('interactiveFetch — one person cannot hold the stored budget on their own', () => {
	/**
	 * `count` gated STORED requests of ONE holder over `hostCount` origins (`h<N>.holder.test`),
	 * and the routes they hit. Four per host is the origin cap, so two hosts are the whole
	 * stored budget (8) were it not for the holder's cap.
	 */
	function holderCalls(holder: string, hostCount: number, count: number) {
		const gates: ReturnType<typeof deferred>[] = [];
		const routes: Record<string, Scripted> = {};
		const requests: { url: string; host: string }[] = [];
		for (let i = 0; i < count; i++) {
			const host = `h${i % hostCount}.holder.test`;
			const gate = deferred();
			gates.push(gate);
			const url = `https://${host}/t/${i}.png`;
			routes[url] = { ...PNG, gate: gate.promise };
			requests.push({ url, host });
		}
		const start = (site: FakeSite, extra: Partial<InteractiveDeps>, as = holder) =>
			requests.map(({ url, host }) =>
				interactive(site, { url, hosts: [host], addressFrom: 'stored', holder: as }, extra),
			);
		return { gates, routes, start };
	}

	test('a person with two slow hosts of their own holds INTERACTIVE_MAX_STORED_PER_HOLDER slots, not the eight of the stored budget', async () => {
		const mine = holderCalls('user:1', 2, 2 * INTERACTIVE_MAX_CONCURRENT);
		const site = fakeSite({ ...mine.routes, 'https://other.holder.test/t.png': PNG });
		const { startTimer } = ceilingTimers();
		const calls = mine.start(site, { startTimer });
		await settle();
		expect(site.sent, 'only the person’s cap reached the wire').toHaveLength(
			INTERACTIVE_MAX_STORED_PER_HOLDER,
		);
		expect(interactiveHolderState('user:1')).toMatchObject({
			inFlight: INTERACTIVE_MAX_STORED_PER_HOLDER,
			waiting: 2 * INTERACTIVE_MAX_CONCURRENT - INTERACTIVE_MAX_STORED_PER_HOLDER,
		});
		expect(interactiveState(TILES_ORIGIN)).toMatchObject({
			stored: INTERACTIVE_MAX_STORED_PER_HOLDER,
			total: INTERACTIVE_MAX_STORED_PER_HOLDER,
			totalWaiting: 0,
			storedWaiting: 0,
		});

		// another person’s stored request, to a third host, goes at once: the budget has room
		const other = await interactive(
			site,
			{
				url: 'https://other.holder.test/t.png',
				hosts: ['other.holder.test'],
				addressFrom: 'stored',
				holder: 'user:2',
			},
			{ startTimer },
		);
		expect(other.ok).toBe(true);
		// …and the SAME person’s registry request is not under the cap (an administrator chose that host)
		const registry = await interactive(
			site,
			{
				url: 'https://other.holder.test/t.png',
				hosts: ['other.holder.test'],
				addressFrom: 'registry',
				holder: 'user:1',
			},
			{ startTimer },
		);
		expect(registry.ok).toBe(true);

		// a slot turning over lets the next of the person’s requests go
		mine.gates[0]?.resolve();
		await settle();
		expect(
			site.sent.filter(
				(request) =>
					request.url.host.endsWith('.holder.test') && request.url.host !== 'other.holder.test',
			),
		).toHaveLength(INTERACTIVE_MAX_STORED_PER_HOLDER + 1);
		for (const gate of mine.gates) gate.resolve();
		const results = await Promise.all(calls);
		expect(results.every((response) => response.ok)).toBe(true);
		expect(interactiveHolderState('user:1')).toMatchObject({ holders: 0, inFlight: 0, waiting: 0 });
		expect(interactiveState(TILES_ORIGIN)).toMatchObject({ stored: 0, total: 0, origins: 0 });
	});

	test('three people with two hosts each fill the stored budget: the cap is per person, and the budget still holds', async () => {
		const a = holderCalls('user:1', 2, 2 * INTERACTIVE_MAX_CONCURRENT);
		const b = holderCalls('user:2', 2, 2 * INTERACTIVE_MAX_CONCURRENT);
		const routesB = Object.fromEntries(
			Object.entries(b.routes).map(([url, route]) => [
				url.replace('holder.test', 'holder2.test'),
				route,
			]),
		);
		const site = fakeSite({ ...a.routes, ...routesB });
		const { startTimer } = ceilingTimers();
		const callsA = a.start(site, { startTimer });
		const callsB = Object.keys(routesB).map((url) => {
			const host = new URL(url).hostname;
			return interactive(
				site,
				{ url, hosts: [host], addressFrom: 'stored', holder: 'user:2' },
				{ startTimer },
			);
		});
		await settle();
		expect(interactiveHolderState('user:1').inFlight).toBe(INTERACTIVE_MAX_STORED_PER_HOLDER);
		expect(interactiveHolderState('user:2').inFlight).toBe(INTERACTIVE_MAX_STORED_PER_HOLDER);
		expect(interactiveState(TILES_ORIGIN).stored).toBe(2 * INTERACTIVE_MAX_STORED_PER_HOLDER);
		expect(2 * INTERACTIVE_MAX_STORED_PER_HOLDER).toBeLessThanOrEqual(INTERACTIVE_MAX_STORED_TOTAL);
		for (const gate of [...a.gates, ...b.gates]) gate.resolve();
		await Promise.all([...callsA, ...callsB]);
		expect(interactiveState(TILES_ORIGIN)).toMatchObject({ stored: 0, total: 0, origins: 0 });
	});

	test('a person at their cap waits HOLDING NOTHING: another reader of the same host is not parked behind them', async () => {
		// the person has the cap in flight at ONE host (cap 3 of the origin’s 4), and a fourth waiting
		const mine = holderCalls('user:1', 1, INTERACTIVE_MAX_STORED_PER_HOLDER + 1);
		const site = fakeSite({ ...mine.routes, 'https://h0.holder.test/second.png': PNG });
		const { startTimer } = ceilingTimers();
		const calls = mine.start(site, { startTimer });
		await settle();
		const origin = 'https://h0.holder.test';
		expect(interactiveState(origin)).toMatchObject({
			inFlight: INTERACTIVE_MAX_STORED_PER_HOLDER,
			waiting: 0, // the fourth waits in the PERSON’s queue, not the origin’s
		});
		expect(interactiveHolderState('user:1').waiting).toBe(1);
		// a second reader of that very source takes the origin’s free slot at once
		const second = await interactive(
			site,
			{
				url: 'https://h0.holder.test/second.png',
				hosts: ['h0.holder.test'],
				addressFrom: 'stored',
				holder: 'user:2',
			},
			{ startTimer },
		);
		expect(second.ok).toBe(true);
		for (const gate of mine.gates) gate.resolve();
		await Promise.all(calls);
	});

	test('the wait for the cap is the one ceiling: a request still queued at it is refused, and holds and costs nothing', async () => {
		const mine = holderCalls('user:1', 1, INTERACTIVE_MAX_STORED_PER_HOLDER + 1);
		const site = fakeSite(mine.routes);
		const { armed, startTimer } = ceilingTimers();
		const calls = mine.start(site, { startTimer });
		const last = calls[INTERACTIVE_MAX_STORED_PER_HOLDER] as Promise<unknown>;
		await settle();
		expect(armed).toHaveLength(1);
		expect(armed[0]?.ms).toBe(INTERACTIVE_MAX_WAIT_MS);
		armed[0]?.fire();
		const refused = await failureOf(last);
		expect(refused.code).toBe('rate.limited');
		expect(refused.coordinates?.reason).toBe('wait_exceeded');
		expect(interactiveHolderState('user:1').waiting).toBe(0);
		expect(site.sent).toHaveLength(INTERACTIVE_MAX_STORED_PER_HOLDER);
		for (const gate of mine.gates) gate.resolve();
		await Promise.all(calls.slice(0, INTERACTIVE_MAX_STORED_PER_HOLDER));
	});

	test('a person’s queue is bounded and is theirs alone: one request too many is refused at once, another person is not touched', async () => {
		const total = INTERACTIVE_MAX_STORED_PER_HOLDER + INTERACTIVE_MAX_HOLDER_QUEUE + 1;
		const mine = holderCalls('user:1', 1, total);
		const site = fakeSite({ ...mine.routes, 'https://elsewhere.holder.test/t.png': PNG });
		const { startTimer } = ceilingTimers();
		const calls = mine.start(site, { startTimer });
		const refused = await failureOf(calls[total - 1] as Promise<unknown>);
		expect(refused.code).toBe('rate.limited');
		expect(refused.coordinates?.reason).toBe('queue_full');
		expect(interactiveHolderState('user:1')).toMatchObject({
			inFlight: INTERACTIVE_MAX_STORED_PER_HOLDER,
			waiting: INTERACTIVE_MAX_HOLDER_QUEUE,
		});
		const other = await interactive(
			site,
			{
				url: 'https://elsewhere.holder.test/t.png',
				hosts: ['elsewhere.holder.test'],
				addressFrom: 'stored',
				holder: 'user:2',
			},
			{ startTimer },
		);
		expect(other.ok).toBe(true);
		for (const gate of mine.gates) gate.resolve();
		await Promise.all(calls.slice(0, total - 1));
		expect(interactiveHolderState('user:1').holders).toBe(0);
	});

	test('a stopped request gives its place in the person’s queue back, and the failure of a hop frees the slot', async () => {
		const mine = holderCalls('user:1', 1, INTERACTIVE_MAX_STORED_PER_HOLDER);
		const site = fakeSite({ ...mine.routes, 'https://h0.holder.test/t/3.png': PNG });
		const { startTimer } = ceilingTimers();
		const controller = new AbortController();
		const running = mine.start(site, { startTimer });
		const stopping = runWithJobSignal(controller.signal, () =>
			interactiveFetch(
				{
					url: 'https://h0.holder.test/t/3.png',
					hosts: ['h0.holder.test'],
					mediaTypes: ['image/png'],
					addressFrom: 'stored',
					holder: 'user:1',
				},
				{ ...site.deps, startTimer },
			),
		);
		const stopped = failureOf(stopping);
		await settle();
		expect(interactiveHolderState('user:1').waiting).toBe(1);
		controller.abort();
		const failure = await stopped;
		expect(failure.code).toBe('security.outbound_failed');
		expect(interactiveHolderState('user:1').waiting).toBe(0);
		for (const gate of mine.gates) gate.resolve();
		await Promise.all(running);
		expect(interactiveHolderState('user:1')).toMatchObject({ holders: 0, inFlight: 0, waiting: 0 });
	});
});

describe('interactiveFetch — one person cannot be the whole line of a registry origin', () => {
	/**
	 * `count` gated REGISTRY requests of ONE holder to ONE host, and the routes they hit. A
	 * registry origin is the one every viewer of the installation draws on (the built-in
	 * OpenStreetMap), so its queue is what a big view of one person must not fill.
	 */
	function registryCalls(holder: string, count: number, host = 'tiles.test') {
		const gates: ReturnType<typeof deferred>[] = [];
		const routes: Record<string, Scripted> = {};
		const urls: string[] = [];
		for (let i = 0; i < count; i++) {
			const gate = deferred();
			gates.push(gate);
			const url = `https://${host}/${holder.replace(':', '_')}/${i}.png`;
			routes[url] = { ...PNG, gate: gate.promise };
			urls.push(url);
		}
		const start = (site: FakeSite, extra: Partial<InteractiveDeps>) =>
			urls.map((url) =>
				interactive(site, { url, hosts: [host], addressFrom: 'registry', holder }, extra),
			);
		return { gates, routes, urls, start };
	}

	test('a person with hundreds of tiles holds INTERACTIVE_MAX_REGISTRY_PER_HOLDER places at the origin; the rest wait in their own line, holding nothing', async () => {
		const mine = registryCalls('user:1', 300);
		const site = fakeSite(mine.routes);
		const { startTimer } = ceilingTimers();
		const calls = mine.start(site, { startTimer });
		await settle();
		expect(site.sent, 'only the person’s places reached the wire').toHaveLength(
			INTERACTIVE_MAX_REGISTRY_PER_HOLDER,
		);
		expect(interactiveHolderAtOriginState('user:1', TILES_ORIGIN)).toMatchObject({
			inFlight: INTERACTIVE_MAX_REGISTRY_PER_HOLDER,
			waiting: 300 - INTERACTIVE_MAX_REGISTRY_PER_HOLDER,
		});
		// …and none of the 296 is a position in the ORIGIN's queue, which is the whole point
		expect(interactiveState(TILES_ORIGIN)).toMatchObject({
			inFlight: INTERACTIVE_MAX_REGISTRY_PER_HOLDER,
			waiting: 0,
			total: INTERACTIVE_MAX_REGISTRY_PER_HOLDER,
			totalWaiting: 0,
			stored: 0,
		});
		for (const gate of mine.gates) gate.resolve();
		const results = await Promise.all(calls);
		expect(results.every((response) => response.ok)).toBe(true);
		expect(site.sent).toHaveLength(300);
		expect(interactiveHolderAtOriginState('user:1', TILES_ORIGIN)).toMatchObject({
			holders: 0,
			inFlight: 0,
			waiting: 0,
		});
		expect(interactiveState(TILES_ORIGIN)).toMatchObject({ inFlight: 0, waiting: 0, origins: 0 });
	});

	test('a second person is served after ONE turnover while the first still has hundreds of tiles waiting — not after all of them', async () => {
		// The finding: one person's 300 tiles filled the origin's whole queue (256) and the next
		// person's single tile was refused `queue_full` until the first had drained.
		const mine = registryCalls('user:1', 300);
		const site = fakeSite({ ...mine.routes, 'https://tiles.test/second.png': PNG });
		const { startTimer } = ceilingTimers();
		const calls = mine.start(site, { startTimer });
		await settle();
		expect(interactiveState(TILES_ORIGIN).inFlight).toBe(INTERACTIVE_MAX_CONCURRENT);

		const second = interactive(
			site,
			{ url: 'https://tiles.test/second.png', addressFrom: 'registry', holder: 'user:2' },
			{ startTimer },
		);
		await settle();
		// not refused, and not behind the 296: first in the origin's line
		expect(interactiveState(TILES_ORIGIN).waiting).toBe(1);
		expect(site.sent.some((request) => request.url.pathname === '/second.png')).toBe(false);

		// ONE of the first person's requests finishes: the origin's slot goes to the second person,
		// and the first person's next tile queues BEHIND them
		mine.gates[0]?.resolve();
		await settle();
		expect((await second).ok).toBe(true);
		expect(
			site.sent[INTERACTIVE_MAX_CONCURRENT]?.url.pathname,
			'the freed slot went to the second person, ahead of the first person’s next tile',
		).toBe('/second.png');
		expect(site.sent, 'the first person’s other tiles still wait their turn').toHaveLength(
			INTERACTIVE_MAX_CONCURRENT + 2, // the second person’s tile, and the first one’s next behind it
		);

		for (const gate of mine.gates) gate.resolve();
		await Promise.all(calls);
		expect(site.sent).toHaveLength(300 + 1);
		expect(interactiveState(TILES_ORIGIN)).toMatchObject({ inFlight: 0, waiting: 0, origins: 0 });
	});

	test('the places are per ORIGIN: a person’s two layers on two registry hosts are each served at the origin’s full speed', async () => {
		const osm = registryCalls('user:1', 40, 'osm.tiles.test');
		const ign = registryCalls('user:1', 40, 'ign.tiles.test');
		const site = fakeSite({ ...osm.routes, ...ign.routes });
		const { startTimer } = ceilingTimers();
		const calls = [...osm.start(site, { startTimer }), ...ign.start(site, { startTimer })];
		await settle();
		expect(site.sent).toHaveLength(2 * INTERACTIVE_MAX_REGISTRY_PER_HOLDER);
		for (const host of ['osm.tiles.test', 'ign.tiles.test']) {
			expect(interactiveHolderAtOriginState('user:1', `https://${host}`)).toMatchObject({
				inFlight: INTERACTIVE_MAX_REGISTRY_PER_HOLDER,
				waiting: 40 - INTERACTIVE_MAX_REGISTRY_PER_HOLDER,
			});
		}
		// a slow layer does not hold the other back: the holder’s line is one per origin
		for (const gate of ign.gates) gate.resolve();
		await settle();
		expect(pathsSent(site, 'ign.tiles.test')).toHaveLength(40);
		expect(pathsSent(site, 'osm.tiles.test')).toHaveLength(INTERACTIVE_MAX_REGISTRY_PER_HOLDER);
		for (const gate of osm.gates) gate.resolve();
		await Promise.all(calls);
		expect(interactiveHolderAtOriginState('user:1', 'https://osm.tiles.test').holders).toBe(0);
	});

	test('the origin’s queue is still bounded: when many PEOPLE fill it, the next is refused at once', async () => {
		const total = INTERACTIVE_MAX_CONCURRENT + INTERACTIVE_MAX_QUEUE;
		const people = total / INTERACTIVE_MAX_REGISTRY_PER_HOLDER;
		const { gates, routes } = gatedTiles(total + 1);
		const site = fakeSite(routes);
		const { startTimer } = ceilingTimers();
		const calls = gates.map((_, i) =>
			interactive(
				site,
				{
					url: `https://tiles.test/t/${i}.png`,
					holder: `user:p${Math.min(Math.floor(i / INTERACTIVE_MAX_REGISTRY_PER_HOLDER), people)}`,
				},
				{ startTimer },
			),
		);
		const refused = await failureOf(calls[total] as Promise<unknown>);
		expect(refused.code).toBe('rate.limited');
		expect(refused.coordinates?.reason).toBe('queue_full');
		expect(interactiveState(TILES_ORIGIN)).toMatchObject({
			inFlight: INTERACTIVE_MAX_CONCURRENT,
			waiting: INTERACTIVE_MAX_QUEUE,
		});
		// the refused person holds nothing at either level
		expect(interactiveHolderAtOriginState(`user:p${people}`, TILES_ORIGIN)).toMatchObject({
			inFlight: 0,
			waiting: 0,
		});
		for (const gate of gates) gate.resolve();
		await Promise.all(calls.slice(0, total));
		expect(site.sent).toHaveLength(total);
		expect(interactiveState(TILES_ORIGIN)).toMatchObject({ inFlight: 0, waiting: 0, origins: 0 });
	});

	test('a person’s line is bounded and theirs alone: one request too many is refused at once, another person is not touched', async () => {
		const total = INTERACTIVE_MAX_REGISTRY_PER_HOLDER + INTERACTIVE_MAX_HOLDER_QUEUE + 1;
		const mine = registryCalls('user:1', total);
		const site = fakeSite({ ...mine.routes, 'https://elsewhere.test/t.png': PNG });
		const { startTimer } = ceilingTimers();
		const calls = mine.start(site, { startTimer });
		const refused = await failureOf(calls[total - 1] as Promise<unknown>);
		expect(refused.code).toBe('rate.limited');
		expect(refused.coordinates?.reason).toBe('queue_full');
		expect(interactiveHolderAtOriginState('user:1', TILES_ORIGIN)).toMatchObject({
			inFlight: INTERACTIVE_MAX_REGISTRY_PER_HOLDER,
			waiting: INTERACTIVE_MAX_HOLDER_QUEUE,
		});
		const other = await interactive(
			site,
			{ url: 'https://elsewhere.test/t.png', hosts: ['elsewhere.test'], holder: 'user:2' },
			{ startTimer },
		);
		expect(other.ok).toBe(true);
		for (const gate of mine.gates) gate.resolve();
		await Promise.all(calls.slice(0, total - 1));
		expect(interactiveHolderAtOriginState('user:1', TILES_ORIGIN).holders).toBe(0);
	});

	test('the wait for a place is the one ceiling: a request still in the person’s line at it is refused, and holds and costs nothing', async () => {
		const mine = registryCalls('user:1', INTERACTIVE_MAX_REGISTRY_PER_HOLDER + 1);
		const site = fakeSite(mine.routes);
		const { armed, startTimer } = ceilingTimers();
		const calls = mine.start(site, { startTimer });
		const last = calls[INTERACTIVE_MAX_REGISTRY_PER_HOLDER] as Promise<unknown>;
		await settle();
		expect(armed).toHaveLength(1);
		expect(armed[0]?.ms).toBe(INTERACTIVE_MAX_WAIT_MS);
		armed[0]?.fire();
		const refused = await failureOf(last);
		expect(refused.code).toBe('rate.limited');
		expect(refused.coordinates?.reason).toBe('wait_exceeded');
		expect(interactiveHolderAtOriginState('user:1', TILES_ORIGIN).waiting).toBe(0);
		expect(site.sent).toHaveLength(INTERACTIVE_MAX_REGISTRY_PER_HOLDER);
		for (const gate of mine.gates) gate.resolve();
		await Promise.all(calls.slice(0, INTERACTIVE_MAX_REGISTRY_PER_HOLDER));
	});

	test('a stopped request leaves the person’s line at once, and the failure of a hop gives its place back', async () => {
		const mine = registryCalls('user:1', INTERACTIVE_MAX_REGISTRY_PER_HOLDER);
		const site = fakeSite({
			...mine.routes,
			'https://tiles.test/waiting.png': PNG,
			'https://tiles.test/boom': {
				status: 0,
				error: new DedaloError('security.outbound_failed', {
					coordinates: { reason: 'transport' },
				}),
			},
		});
		const { startTimer } = ceilingTimers();
		const controller = new AbortController();
		const running = mine.start(site, { startTimer });
		const stopping = runWithJobSignal(controller.signal, () =>
			interactiveFetch(
				{
					url: 'https://tiles.test/waiting.png',
					hosts: ['tiles.test'],
					mediaTypes: ['image/png'],
					addressFrom: 'registry',
					holder: 'user:1',
				},
				{ ...site.deps, startTimer },
			),
		);
		const stopped = failureOf(stopping);
		await settle();
		expect(interactiveHolderAtOriginState('user:1', TILES_ORIGIN).waiting).toBe(1);
		controller.abort();
		const failure = await stopped;
		expect(failure.code).toBe('security.outbound_failed');
		expect(failure.coordinates?.reason).toBe('aborted');
		expect(interactiveHolderAtOriginState('user:1', TILES_ORIGIN).waiting).toBe(0);
		expect(interactiveState(TILES_ORIGIN).waiting, 'it never reached the origin’s queue').toBe(0);
		for (const gate of mine.gates) gate.resolve();
		await Promise.all(running);
		// a hop that throws gives its place back as well: the next request is not shut out by it
		expect(
			await codeOf(interactive(site, { url: 'https://tiles.test/boom', holder: 'user:1' })),
		).toBe('security.outbound_failed');
		expect(interactiveHolderAtOriginState('user:1', TILES_ORIGIN)).toMatchObject({
			holders: 0,
			inFlight: 0,
			waiting: 0,
		});
	});

	test('a STORED address is not under this cap, and a registry one is not under the stored cap: the two are apart', async () => {
		const stored = holderCallsAcross('user:1', 'stored', INTERACTIVE_MAX_STORED_PER_HOLDER + 2);
		const registry = registryCalls(
			'user:1',
			INTERACTIVE_MAX_REGISTRY_PER_HOLDER + 2,
			'reg.tiles.test',
		);
		const site = fakeSite({ ...stored.routes, ...registry.routes });
		const { startTimer } = ceilingTimers();
		const calls = [...stored.start(site, { startTimer }), ...registry.start(site, { startTimer })];
		await settle();
		expect(interactiveHolderState('user:1').inFlight).toBe(INTERACTIVE_MAX_STORED_PER_HOLDER);
		expect(interactiveHolderAtOriginState('user:1', 'https://reg.tiles.test').inFlight).toBe(
			INTERACTIVE_MAX_REGISTRY_PER_HOLDER,
		);
		expect(site.sent).toHaveLength(
			INTERACTIVE_MAX_STORED_PER_HOLDER + INTERACTIVE_MAX_REGISTRY_PER_HOLDER,
		);
		for (const gate of [...stored.gates, ...registry.gates]) gate.resolve();
		await Promise.all(calls);
	});

	test('a stop that ends a wait says whether an earlier hop of the call had already been sent', async () => {
		// hop 1 is answered (a redirect) and hop 2 then waits in a queue the person fills: stopping the call there
		// is NOT "nothing of it ever left", and the error says so; stopping it in its first wait is
		const filler = registryCalls(
			'user:9',
			INTERACTIVE_MAX_REGISTRY_PER_HOLDER,
			'target.tiles.test',
		);
		const site = fakeSite({
			...filler.routes,
			'https://tiles.test/old.png': { status: 301, location: 'https://target.tiles.test/new.png' },
			'https://target.tiles.test/new.png': PNG,
		});
		const { startTimer } = ceilingTimers();
		const running = filler.start(site, { startTimer });
		await settle();
		const controller = new AbortController();
		const stopping = runWithJobSignal(controller.signal, () =>
			interactiveFetch(
				{
					url: 'https://tiles.test/old.png',
					hosts: ['tiles.test', 'target.tiles.test'],
					mediaTypes: ['image/png'],
					addressFrom: 'registry',
					holder: 'user:1',
				},
				{ ...site.deps, startTimer },
			),
		);
		const stopped = failureOf(stopping);
		await settle();
		// hop 1 went out; hop 2 queues behind the filler at target.tiles.test
		expect(site.sent.some((request) => request.url.pathname === '/old.png')).toBe(true);
		expect(interactiveState('https://target.tiles.test').waiting).toBe(1);
		controller.abort();
		const failure = await stopped;
		expect(failure.code).toBe('security.outbound_failed');
		expect(failure.coordinates).toMatchObject({
			reason: 'aborted',
			stage: 'limiter',
			after: 'request_sent',
		});
		expect(stoppedBeforeAnyRequest(failure)).toBe(false);

		// the same stop in the call's FIRST wait carries no such mark
		const first = new AbortController();
		const waiting = runWithJobSignal(first.signal, () =>
			interactiveFetch(
				{
					url: 'https://target.tiles.test/new.png',
					hosts: ['target.tiles.test'],
					mediaTypes: ['image/png'],
					addressFrom: 'registry',
					holder: 'user:9',
				},
				{ ...site.deps, startTimer },
			),
		);
		const firstStopped = failureOf(waiting);
		await settle();
		first.abort();
		const earlier = await firstStopped;
		expect(earlier.coordinates).toMatchObject({ reason: 'aborted', stage: 'limiter' });
		expect(earlier.coordinates?.after).toBeUndefined();
		expect(stoppedBeforeAnyRequest(earlier)).toBe(true);
		for (const gate of filler.gates) gate.resolve();
		await Promise.all(running);
	});

	test('a CAPACITY refusal of a later hop says the provider had already been asked; the same refusal of a first hop does not', async () => {
		// hop 1 is answered (a redirect) and hop 2 waits behind a filler past its ceiling: `wait_exceeded`
		// there is not "the provider was never asked", and a route that charges such calls must be told so
		const filler = registryCalls(
			'user:9',
			INTERACTIVE_MAX_REGISTRY_PER_HOLDER,
			'target.tiles.test',
		);
		const site = fakeSite({
			...filler.routes,
			'https://tiles.test/old.png': { status: 301, location: 'https://target.tiles.test/new.png' },
			'https://target.tiles.test/new.png': PNG,
		});
		const { armed, startTimer } = ceilingTimers();
		const running = filler.start(site, { startTimer });
		await settle();
		const fireWaiting = () => {
			for (const entry of armed) if (!entry.cancelled) entry.fire();
		};
		const redirected = failureOf(
			interactive(
				site,
				{
					url: 'https://tiles.test/old.png',
					hosts: ['tiles.test', 'target.tiles.test'],
					addressFrom: 'registry',
					holder: 'user:1',
				},
				{ startTimer },
			),
		);
		await settle();
		expect(site.sent.some((request) => request.url.pathname === '/old.png')).toBe(true);
		expect(interactiveState('https://target.tiles.test').waiting).toBe(1);
		fireWaiting();
		const later = await redirected;
		expect(later.code).toBe('rate.limited');
		expect(later.coordinates).toMatchObject({ reason: 'wait_exceeded', after: 'request_sent' });
		expect(reachedProviderBeforeRefusal(later)).toBe(true);
		expect(stoppedBeforeAnyRequest(later), 'a refusal is not a stop').toBe(false);

		// the same ceiling in a call's FIRST wait: nothing of it left, no mark
		const direct = failureOf(
			interactive(
				site,
				{
					url: 'https://target.tiles.test/new.png',
					hosts: ['target.tiles.test'],
					holder: 'user:2',
				},
				{ startTimer },
			),
		);
		await settle();
		fireWaiting();
		const first = await direct;
		expect(first.code).toBe('rate.limited');
		expect(first.coordinates?.after).toBeUndefined();
		expect(reachedProviderBeforeRefusal(first)).toBe(false);
		for (const gate of filler.gates) gate.resolve();
		await Promise.all(running);
	});

	/** `count` gated requests of `holder` to ONE stored host `stored.tiles.test`. */
	function holderCallsAcross(holder: string, addressFrom: 'stored' | 'registry', count: number) {
		const gates: ReturnType<typeof deferred>[] = [];
		const routes: Record<string, Scripted> = {};
		const urls: string[] = [];
		for (let i = 0; i < count; i++) {
			const gate = deferred();
			gates.push(gate);
			const url = `https://stored.tiles.test/${i}.png`;
			routes[url] = { ...PNG, gate: gate.promise };
			urls.push(url);
		}
		const start = (site: FakeSite, extra: Partial<InteractiveDeps>) =>
			urls.map((url) =>
				interactive(site, { url, hosts: ['stored.tiles.test'], addressFrom, holder }, extra),
			);
		return { gates, routes, start };
	}
});

describe('interactiveFetch — the spacing is a start, not a slot', () => {
	/** `count` requests each holding a global slot on an origin of its own, until its gate opens. */
	function globalHolders(count: number) {
		const gates = Array.from({ length: count }, () => deferred());
		const routes: Record<string, Scripted> = {};
		gates.forEach((gate, i) => {
			routes[`https://h${i}.tiles.test/t.png`] = { ...PNG, gate: gate.promise };
		});
		const hold = (site: FakeSite, extra: Partial<InteractiveDeps>) =>
			gates.map((_, i) =>
				interactive(
					site,
					{ url: `https://h${i}.tiles.test/t.png`, hosts: [`h${i}.tiles.test`] },
					extra,
				),
			);
		return { gates, routes, hold };
	}

	test('minIntervalMs holds when the global limiter is saturated: the starts leave one spacing apart', async () => {
		const holders = globalHolders(INTERACTIVE_MAX_TOTAL);
		const spaced = [1, 2, 3].map((n) => `https://spaced.test/${n}.png`);
		const site = fakeSite({
			...holders.routes,
			...Object.fromEntries(spaced.map((url) => [url, PNG])),
		});
		const pauses = manualPauses(site.clock);
		const extra = { ...ceilingTimers(), sleep: pauses.sleep };
		const busy = holders.hold(site, extra);
		await settle();
		// Every global slot is taken. Three requests to one spaced origin now take their ORIGIN
		// slots and queue for a global one — and have reserved no start yet.
		const calls = spaced.map((url) =>
			interactive(site, { url, hosts: ['spaced.test'], minIntervalMs: 1_000 }, extra),
		);
		await settle();
		expect(interactiveState('https://spaced.test')).toMatchObject({ inFlight: 3 });
		expect(pauses.pending()).toBe(0);

		// Three global slots come free in the same instant. The old order reserved the spacing
		// first, so all three paused, finished together and were released by the global queue
		// together; the provider saw them at one moment.
		for (const gate of holders.gates.slice(0, 3)) gate.resolve();
		await settle();
		const t0 = site.clock.now;
		expect(sentTimesTo(site, 'spaced.test')).toEqual([t0]); // one goes…
		expect(pauses.pending()).toBe(2); // …the others wait out their spacing, holding their slots
		await pauses.advance(1_000);
		await pauses.advance(1_000);
		await Promise.all(calls);
		expect(sentTimesTo(site, 'spaced.test')).toEqual([t0, t0 + 1_000, t0 + 2_000]);

		for (const gate of holders.gates) gate.resolve();
		await Promise.all(busy);
		expect(interactiveState('https://spaced.test')).toMatchObject({ inFlight: 0, total: 0 });
	});

	test('a start owes its spacing to the starts AFTER it; one that asked for none owes none', async () => {
		const site = fakeSite({ 'https://tiles.test/t/1.png': PNG });
		const url = 'https://tiles.test/t/1.png';
		await interactive(site, { url, minIntervalMs: 0 });
		await interactive(site, { url, minIntervalMs: 1_000 });
		expect(site.slept).toEqual([]); // asked 1000, but the start before it asked nothing
		await interactive(site, { url, minIntervalMs: 0 });
		expect(site.slept).toEqual([1_000]); // and that 1000 binds the one after it
		// Hence a route whose origin has terms passes them on every request to that origin.
	});

	test('the spacing counts inside the ceiling: a start the 10 s cannot hold is refused, taking no place', async () => {
		const site = fakeSite({ 'https://tiles.test/t/1.png': PNG });
		const pauses = manualPauses(site.clock);
		const extra = { ...ceilingTimers(), sleep: pauses.sleep };
		const url = 'https://tiles.test/t/1.png';
		const spaced = { url, minIntervalMs: INTERACTIVE_MAX_INTERVAL_MS };
		const t0 = site.clock.now;
		await interactive(site, spaced, extra); // goes at once and owes 5 s
		const second = interactive(site, spaced, extra); // +5 s
		const third = interactive(site, spaced, extra); // +10 s: the last the ceiling holds
		await settle();
		expect(pauses.pending()).toBe(2);
		const fourth = await failureOf(interactive(site, spaced, extra)); // +15 s
		expect(fourth.code).toBe('rate.limited');
		expect(fourth.coordinates?.reason).toBe('wait_exceeded');
		expect(interactiveState(TILES_ORIGIN)).toMatchObject({ inFlight: 2, waiting: 0, total: 2 });
		await pauses.advance(INTERACTIVE_MAX_INTERVAL_MS);
		await pauses.advance(INTERACTIVE_MAX_INTERVAL_MS);
		await Promise.all([second, third]);
		expect(site.sentAt).toEqual([t0, t0 + 5_000, t0 + 10_000]);
	});
});

describe('interactiveFetch — one ceiling for the whole wait', () => {
	test('the global queue gets what the origin queue left of the one ceiling', async () => {
		// Sixteen requests hold the global slots (four of them on the tile host), a thirteenth
		// origin queues for one, and a fifth tile request queues at its ORIGIN behind the four.
		const gates = Array.from({ length: INTERACTIVE_MAX_TOTAL }, () => deferred());
		const xGate = deferred(); // x keeps the global slot it is given, so `last` stays queued behind it
		const routes: Record<string, Scripted> = {
			'https://x.test/t.png': { ...PNG, gate: xGate.promise },
			'https://tiles.test/t/last.png': PNG,
		};
		gates.forEach((gate, i) => {
			const host = i < INTERACTIVE_MAX_CONCURRENT ? 'tiles.test' : `o${i}.test`;
			routes[`https://${host}/t/${i}.png`] = { ...PNG, gate: gate.promise };
		});
		const site = fakeSite(routes);
		const { armed, startTimer } = ceilingTimers();
		const holders = gates.map((_, i) => {
			const host = i < INTERACTIVE_MAX_CONCURRENT ? 'tiles.test' : `o${i}.test`;
			return interactive(
				site,
				{ url: `https://${host}/t/${i}.png`, hosts: [host] },
				{ startTimer },
			);
		});
		await settle();
		const x = interactive(site, { url: 'https://x.test/t.png', hosts: ['x.test'] }, { startTimer });
		const last = interactive(site, { url: 'https://tiles.test/t/last.png' }, { startTimer });
		await settle();
		expect(armed.map((timer) => timer.ms)).toEqual([
			INTERACTIVE_MAX_WAIT_MS, // x, queued at the global limiter
			INTERACTIVE_MAX_WAIT_MS, // last, queued at its origin
		]);

		// Six seconds pass, then the first tile request finishes. Its global slot goes to the
		// request ahead (x), its origin slot to `last`, which now queues at the global limiter —
		// with what is left of the ONE ceiling, not a fresh one.
		site.clock.now += 6_000;
		gates[0]?.resolve();
		await settle();
		expect(armed).toHaveLength(3);
		expect(armed[2]?.ms).toBe(INTERACTIVE_MAX_WAIT_MS - 6_000);
		expect(interactiveState(TILES_ORIGIN).totalWaiting).toBe(1);

		armed[2]?.fire(); // the four seconds are up
		const refused = await failureOf(last);
		expect(refused.code).toBe('rate.limited');
		expect(refused.coordinates?.reason).toBe('wait_exceeded');
		expect(site.sent.some((r) => r.url.pathname === '/t/last.png')).toBe(false);
		for (const gate of [...gates, xGate]) gate.resolve();
		await Promise.all([...holders, x]);
		expect(interactiveState(TILES_ORIGIN)).toMatchObject({ inFlight: 0, total: 0, origins: 0 });
	});

	test('the global queue is bounded: past INTERACTIVE_MAX_TOTAL_QUEUE waiting, the next is refused at once', async () => {
		const held = INTERACTIVE_MAX_TOTAL;
		const total = held + INTERACTIVE_MAX_TOTAL_QUEUE + 1;
		const gates = Array.from({ length: held }, () => deferred());
		const routes: Record<string, Scripted> = {};
		for (let i = 0; i < total; i++) {
			routes[`https://h${i}.tiles.test/t.png`] =
				i < held ? { ...PNG, gate: gates[i]?.promise } : PNG;
		}
		const site = fakeSite(routes);
		const { startTimer } = ceilingTimers();
		// One origin per request: it is the GLOBAL bound that is under test, not a per-origin one.
		const calls = Array.from({ length: total }, (_, i) =>
			interactive(
				site,
				{ url: `https://h${i}.tiles.test/t.png`, hosts: [`h${i}.tiles.test`] },
				{ startTimer },
			),
		);
		const refused = await failureOf(calls[total - 1] as Promise<unknown>);
		await settle(); // the refusal needs no timer; the held requests need a few ticks to reach the wire
		expect(refused.code).toBe('rate.limited');
		expect(refused.coordinates?.reason).toBe('queue_full');
		expect(interactiveState(TILES_ORIGIN)).toMatchObject({
			total: held,
			totalWaiting: INTERACTIVE_MAX_TOTAL_QUEUE,
		});
		expect(interactiveState(`https://h${total - 1}.tiles.test`).inFlight).toBe(0); // gave its origin slot back
		expect(site.sent).toHaveLength(held);
		for (const gate of gates) gate.resolve();
		await Promise.all(calls.slice(0, total - 1));
		expect(site.sent).toHaveLength(total - 1);
		expect(interactiveState(TILES_ORIGIN)).toMatchObject({ total: 0, totalWaiting: 0, origins: 0 });
	});
});

describe('interactiveFetch — its state is not the default pace’s', () => {
	test('a default harvest in flight to an origin neither delays nor is delayed by an interactive one', async () => {
		const slowPage = deferred();
		const slowTile = deferred();
		const site = fakeSite({
			'https://shared.test/robots.txt': NOT_FOUND,
			'https://shared.test/page': { status: 200, gate: slowPage.promise },
			'https://shared.test/t/slow.png': { ...PNG, gate: slowTile.promise },
			'https://shared.test/t/fast.png': PNG,
			'https://shared.test/page2': { status: 200 },
		});
		const tile = (path: string) =>
			interactive(site, { url: `https://shared.test${path}`, hosts: ['shared.test'] });

		// The default profile holds the origin's serial turn…
		const page = harvest(site, { url: 'https://shared.test/page' });
		await settle();
		// …and the interactive one is not queued behind it.
		expect((await tile('/t/fast.png')).ok).toBe(true);
		slowPage.resolve();
		await page;

		// And the other way round: an interactive request in flight blocks no default turn.
		const slow = tile('/t/slow.png');
		await settle();
		const before = site.slept.length;
		expect((await harvest(site, { url: 'https://shared.test/page2' })).ok).toBe(true);
		expect(site.slept.slice(before)).toEqual([MIN_INTERVAL_MS]); // its own floor, nobody else's
		slowTile.resolve();
		await slow;
	});

	test('the two states are separately observable and separately cleared', async () => {
		const gate = deferred();
		const site = fakeSite({
			'https://cat.test/robots.txt': NOT_FOUND,
			'https://cat.test/a': { status: 200, gate: gate.promise },
			'https://tiles.test/t/slow.png': { ...PNG, gate: gate.promise },
		});
		const page = harvest(site, { url: 'https://cat.test/a' });
		const tile = interactive(site, { url: 'https://tiles.test/t/slow.png' });
		await settle();
		expect(trackedOrigins()).toBe(1); // cat.test only
		expect(interactiveState(TILES_ORIGIN).origins).toBe(1); // tiles.test only
		clearPacingForTests();
		expect(interactiveState(TILES_ORIGIN).origins).toBe(1); // untouched by the default's reset
		clearInteractiveForTests();
		expect(interactiveState(TILES_ORIGIN).origins).toBe(0);
		gate.resolve();
		await Promise.all([page, tile]);
	});
});

describe('interactiveFetch — a provider that says slow down', () => {
	const slowDown = (status: number, headers: Record<string, string> = {}): Scripted => ({
		status,
		headers,
		contentType: 'text/plain',
		body: 'slow down',
	});

	test('Retry-After on a 429/503 holds the origin’s next start for exactly that long', async () => {
		for (const status of [429, 503]) {
			clearInteractiveForTests();
			const site = fakeSite({
				'https://tiles.test/limit': slowDown(status, { 'Retry-After': '8' }),
				'https://tiles.test/t/1.png': PNG,
			});
			expect((await interactive(site, { url: 'https://tiles.test/limit' })).status).toBe(status);
			await interactive(site, { url: 'https://tiles.test/t/1.png' });
			expect(site.slept, String(status)).toEqual([8_000]);
		}
	});

	test('no usable Retry-After still holds the origin off for the fallback, a lenient date included', async () => {
		for (const asked of [undefined, '2099-01-01T00:00:00Z', 'soon', '1.5']) {
			clearInteractiveForTests();
			const site = fakeSite({
				'https://tiles.test/limit': slowDown(
					429,
					asked === undefined ? {} : { 'Retry-After': asked },
				),
				'https://tiles.test/t/1.png': PNG,
			});
			await interactive(site, { url: 'https://tiles.test/limit' });
			await interactive(site, { url: 'https://tiles.test/t/1.png' });
			expect(site.slept, String(asked)).toEqual([INTERACTIVE_FALLBACK_BACKOFF_MS]);
		}
	});

	test('a Retry-After on any other status asks nothing', async () => {
		const site = fakeSite({
			'https://tiles.test/ok': { ...PNG, headers: { 'Retry-After': '30' } },
			'https://tiles.test/nf': { status: 404, headers: { 'Retry-After': '30' } },
		});
		await interactive(site, { url: 'https://tiles.test/ok' });
		await interactive(site, { url: 'https://tiles.test/nf' });
		await interactive(site, { url: 'https://tiles.test/ok' });
		expect(site.slept).toEqual([]);
	});

	test('a 429 that lands while a spaced start is already paused holds that start too', async () => {
		// B is reserved for one spacing after A's start and is pausing when A's answer — a 429 —
		// comes back. B must not go inside the Retry-After the provider has just asked for.
		const answer = deferred();
		const site = fakeSite({
			'https://tiles.test/limit': {
				...slowDown(429, { 'Retry-After': '5' }),
				gate: answer.promise,
			},
			'https://tiles.test/t/1.png': PNG,
		});
		const pauses = manualPauses(site.clock);
		const extra = { ...ceilingTimers(), sleep: pauses.sleep };
		const spaced = { minIntervalMs: 1_000 };
		const t0 = site.clock.now;
		const a = interactive(site, { url: 'https://tiles.test/limit', ...spaced }, extra);
		await settle();
		const b = interactive(site, { url: 'https://tiles.test/t/1.png', ...spaced }, extra);
		await settle();
		expect(pauses.pending()).toBe(1); // B waits out A's spacing, holding its slots
		await pauses.advance(50);
		answer.resolve(); // A's 429 arrives at +50 ms: the origin is held to +5050
		expect((await a).status).toBe(429);
		await pauses.advance(950); // +1 s, B's planned time
		expect(sentTimesTo(site, 'tiles.test')).toEqual([t0]); // B has not been sent
		await pauses.advance(4_050);
		expect((await b).ok).toBe(true);
		expect(sentTimesTo(site, 'tiles.test')).toEqual([t0, t0 + 5_050]);
		expect(interactiveState(TILES_ORIGIN)).toMatchObject({ inFlight: 0, waiting: 0, total: 0 });
	});

	test('a back-off longer than a caller may wait fails fast, and is clamped to its ceiling', async () => {
		const site = fakeSite({
			'https://tiles.test/limit': slowDown(429, { 'Retry-After': '3600' }),
			'https://tiles.test/t/1.png': PNG,
		});
		await interactive(site, { url: 'https://tiles.test/limit' });
		const sentBefore = site.sent.length;
		// 30 s (the clamp), not an hour: newcomers are refused at once rather than queued…
		const refused = await failureOf(interactive(site, { url: 'https://tiles.test/t/1.png' }));
		expect(refused.code).toBe('rate.limited');
		expect(site.sent).toHaveLength(sentBefore);
		expect(interactiveState(TILES_ORIGIN).waiting).toBe(0);
		// …and once the clamped 30 s have passed the origin is open again, with no pause.
		site.clock.now += INTERACTIVE_MAX_BACKOFF_MS + 1;
		expect((await interactive(site, { url: 'https://tiles.test/t/1.png' })).ok).toBe(true);
		expect(site.slept).toEqual([]);
	});
});

describe('interactiveFetch — the job’s stop signal', () => {
	/** An abort signal whose abort listeners are counted. */
	function countedSignal() {
		const controller = new AbortController();
		const { signal } = controller;
		const live = new Set<unknown>();
		const tally = { added: 0 };
		const add = signal.addEventListener.bind(signal);
		const remove = signal.removeEventListener.bind(signal);
		signal.addEventListener = ((type: string, listener: EventListener, options?: object) => {
			if (type === 'abort') {
				tally.added++;
				live.add(listener);
			}
			add(type, listener, options);
		}) as typeof signal.addEventListener;
		signal.removeEventListener = ((type: string, listener: EventListener, options?: object) => {
			if (type === 'abort') live.delete(listener);
			remove(type, listener, options);
		}) as typeof signal.removeEventListener;
		return { controller, live, tally };
	}

	test('a caller stopped while queued leaves the queue; its place goes to the next, with no listener left', async () => {
		const { gates, routes } = gatedTiles(INTERACTIVE_MAX_CONCURRENT + 2);
		const site = fakeSite(routes);
		const { startTimer } = ceilingTimers();
		const { controller, live, tally } = countedSignal();
		const running = gates
			.slice(0, INTERACTIVE_MAX_CONCURRENT)
			.map((_, i) => interactive(site, { url: `https://tiles.test/t/${i}.png` }, { startTimer }));
		const stopped = failureOf(
			runWithJobSignal(controller.signal, () =>
				interactive(
					site,
					{ url: `https://tiles.test/t/${INTERACTIVE_MAX_CONCURRENT}.png` },
					{ startTimer },
				),
			),
		);
		const behind = interactive(
			site,
			{ url: `https://tiles.test/t/${INTERACTIVE_MAX_CONCURRENT + 1}.png` },
			{ startTimer },
		);
		await settle();
		expect(interactiveState(TILES_ORIGIN).waiting).toBe(2);

		controller.abort();
		const error = await stopped;
		expect(error.code).toBe('security.outbound_failed');
		expect(error.coordinates).toMatchObject({ reason: 'aborted', stage: 'limiter' });
		expect(interactiveState(TILES_ORIGIN).waiting).toBe(1);

		gates[0]?.resolve();
		await settle();
		// The freed slot went to the caller behind, never to the one that left.
		expect(site.sent.map((r) => r.url.pathname)).toContain(
			`/t/${INTERACTIVE_MAX_CONCURRENT + 1}.png`,
		);
		expect(site.sent.map((r) => r.url.pathname)).not.toContain(
			`/t/${INTERACTIVE_MAX_CONCURRENT}.png`,
		);
		for (const gate of gates) gate.resolve();
		await Promise.all([...running, behind]);
		expect(tally.added).toBeGreaterThan(0); // the wait did listen (anti-vacuity)
		expect(live.size).toBe(0);
		expect(interactiveState(TILES_ORIGIN)).toMatchObject({
			inFlight: 0,
			waiting: 0,
			total: 0,
			origins: 0,
		});
	});

	test('a caller stopped during the spacing pause gives its slot back', async () => {
		const site = fakeSite({ 'https://tiles.test/t/1.png': PNG });
		await interactive(site, { url: 'https://tiles.test/t/1.png', minIntervalMs: 1_000 });
		const { controller, live } = countedSignal();
		// The pause never ends by itself: only the stop can finish it.
		const hang: Partial<InteractiveDeps> = { sleep: () => new Promise<void>(() => {}) };
		const stopped = failureOf(
			runWithJobSignal(controller.signal, () =>
				interactive(site, { url: 'https://tiles.test/t/1.png', minIntervalMs: 1_000 }, hang),
			),
		);
		await settle();
		expect(interactiveState(TILES_ORIGIN).inFlight).toBe(1);
		controller.abort();
		expect((await stopped).coordinates).toMatchObject({ reason: 'aborted' });
		expect(interactiveState(TILES_ORIGIN)).toMatchObject({ inFlight: 0, total: 0 });
		expect(live.size).toBe(0);
	});

	test('a caller stopped during the spacing pause hands its place to the one queued behind it', async () => {
		const held = deferred();
		const site = fakeSite({
			'https://tiles.test/t/held.png': { ...PNG, gate: held.promise },
			'https://tiles.test/t/1.png': PNG,
		});
		const pauses = manualPauses(site.clock);
		const extra = { ...ceilingTimers(), sleep: pauses.sleep };
		const call = (path: string) =>
			interactive(site, { url: `https://tiles.test/t/${path}`, minIntervalMs: 1_000 }, extra);
		// Four places: one goes at once and keeps its place; three pause for +1 s, +2 s, +3 s.
		// A fifth waits for a place.
		const running = call('held.png');
		const pausing = [call('1.png'), call('1.png')];
		const controller = new AbortController();
		const stopped = failureOf(runWithJobSignal(controller.signal, () => call('1.png')));
		await settle();
		const behind = call('1.png');
		await settle();
		expect(interactiveState(TILES_ORIGIN)).toMatchObject({ inFlight: 4, waiting: 1 });
		expect(site.sentAt).toHaveLength(1);

		controller.abort();
		expect((await stopped).coordinates).toMatchObject({ reason: 'aborted' });
		await settle();
		// The place went on at once: nobody is left waiting for a release that will not come.
		expect(interactiveState(TILES_ORIGIN)).toMatchObject({ inFlight: 4, waiting: 0 });

		held.resolve();
		for (let step = 0; step < 3; step++) await pauses.advance(1_000);
		await Promise.all([running, ...pausing, behind]);
		// The newcomer took the stopped one's start (+3 s); had the reservation stayed, +4 s.
		const t0 = site.sentAt[0] as number;
		expect(site.sentAt.map((at) => at - t0)).toEqual([0, 1_000, 2_000, 3_000]);
		// Nothing is held (the origin's entry stays only for the spacing the last start owes).
		expect(interactiveState(TILES_ORIGIN)).toMatchObject({ inFlight: 0, waiting: 0, total: 0 });
	});

	test('it refuses to run without a job signal: nothing is queued, sent or held', async () => {
		const site = fakeSite({ 'https://tiles.test/t/1.png': PNG });
		const request: InteractiveRequest = {
			url: 'https://tiles.test/t/1.png',
			hosts: ['tiles.test'],
			mediaTypes: ['image/png'],
			addressFrom: 'registry',
			holder: 'user:1',
		};
		const failure = await failureOf(interactiveFetch(request, site.deps));
		expect(failure.code).toBe('internal.invariant');
		expect(failure.message).toContain('runWithJobSignal');
		expect(site.sent).toEqual([]);
		expect(interactiveState(TILES_ORIGIN)).toMatchObject({ inFlight: 0, total: 0, origins: 0 });
		// Anti-vacuity: the same request inside a scope goes through.
		expect((await stoppable(() => interactiveFetch(request, site.deps))).ok).toBe(true);
	});

	test('a caller stopped while the hop is on the wire frees its slot (the real primitive honours it)', async () => {
		const pinned = {
			lookup: async () => [{ address: '93.184.215.14', family: 4 }],
			// A peer that never answers.
			fetch: () => new Promise<Response>(() => {}),
		};
		const controller = new AbortController();
		const stopped = failureOf(
			runWithJobSignal(controller.signal, () =>
				interactiveFetch(
					{
						url: 'https://tiles.test/t/1.png',
						hosts: ['tiles.test'],
						mediaTypes: ['image/png'],
						addressFrom: 'registry',
						holder: 'user:1',
					},
					{ pinned },
				),
			),
		);
		await settle();
		expect(interactiveState(TILES_ORIGIN).inFlight).toBe(1);
		controller.abort();
		const error = await stopped;
		expect(error.code).toBe('security.outbound_failed');
		expect(error.coordinates?.reason).toBe('aborted');
		expect(interactiveState(TILES_ORIGIN)).toMatchObject({ inFlight: 0, total: 0, origins: 0 });
	});

	test('a job already stopped sends nothing', async () => {
		const site = fakeSite({ 'https://tiles.test/t/1.png': PNG });
		const controller = new AbortController();
		controller.abort();
		const error = await failureOf(
			runWithJobSignal(controller.signal, () =>
				interactive(site, { url: 'https://tiles.test/t/1.png' }),
			),
		);
		expect(error.code).toBe('security.outbound_failed');
		expect(site.sent).toEqual([]);
		expect(interactiveState(TILES_ORIGIN)).toMatchObject({ inFlight: 0, origins: 0 });
	});
});
