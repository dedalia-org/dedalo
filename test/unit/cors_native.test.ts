/**
 * CORS on the JSON API — TS-NATIVE gate (src/core/security/cors.ts).
 *
 * No PHP twin: the rewrite dropped `DEDALO_CORS` (SEC-012 in
 * `core/api/v1/json/index.php`) entirely, so this is a re-introduction rather
 * than a parity port, and the contract asserted here is the TS one. See
 * `engineering/wire_contract/WC-2026-08-03-cors-allowed-origins.md`.
 *
 * The invariants that matter are all NEGATIVE — the ways CORS is normally got
 * wrong — so they are pinned first and hardest:
 *   * off by default (an empty allowlist emits NOTHING);
 *   * never `*` ON THE WIRE, and never `Access-Control-Allow-Credentials`;
 *   * exact origin match only — no prefix, suffix, scheme or port fuzz, and no
 *     partial wildcard (`*.example.org` matches NOTHING, it is not a pattern);
 *   * `Vary: Origin` even when the origin is refused (cache poisoning).
 *
 * The one POSITIVE widening is the `*` sentinel (2026-08-08): a public ontology
 * master cannot enumerate its clients. It is config-only — the request origin is
 * still what is echoed — and it is pinned here so it can never be reached by
 * accident from an enumerated list.
 *
 * The pure `build*` entry points are used rather than the request-level
 * wrappers because the allowlist is read ONCE at boot: a test that mutated the
 * environment would be asserting against whatever the first import happened to
 * capture.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
	buildCorsPreflightResponse,
	buildCorsResponseHeaders,
} from '../../src/core/security/cors.ts';

const ALLOWED = 'https://client.example.org';
const LIST: ReadonlySet<string> = new Set([ALLOWED]);
const EMPTY: ReadonlySet<string> = new Set();
/** The public-ontology-master setting: `DEDALO_CORS_ALLOWED_ORIGINS=["*"]`. */
const ANY: ReadonlySet<string> = new Set(['*']);

describe('CORS is off unless configured', () => {
	test('an empty allowlist emits no headers at all', () => {
		expect(buildCorsResponseHeaders(ALLOWED, EMPTY)).toEqual({});
	});

	test('an empty allowlist answers no preflight', () => {
		expect(buildCorsPreflightResponse(ALLOWED, EMPTY)).toBeNull();
	});
});

describe('response headers', () => {
	test('an allowlisted origin is echoed back, with Vary', () => {
		expect(buildCorsResponseHeaders(ALLOWED, LIST)).toEqual({
			'Access-Control-Allow-Origin': ALLOWED,
			Vary: 'Origin',
		});
	});

	test('a refused origin still gets Vary — a shared cache must not mix the two', () => {
		const headers = buildCorsResponseHeaders('https://evil.example.org', LIST);
		expect(headers).toEqual({ Vary: 'Origin' });
		expect(headers['Access-Control-Allow-Origin']).toBeUndefined();
	});

	test('a same-origin request (no Origin header) is not echoed', () => {
		expect(buildCorsResponseHeaders(null, LIST)).toEqual({ Vary: 'Origin' });
	});

	test('the wildcard is never emitted', () => {
		for (const origin of [ALLOWED, 'https://evil.example.org', null]) {
			expect(Object.values(buildCorsResponseHeaders(origin, LIST))).not.toContain('*');
		}
	});

	test('credentials are never allowed — no cookie rides a cross-origin call', () => {
		const headers = buildCorsResponseHeaders(ALLOWED, LIST);
		expect(headers['Access-Control-Allow-Credentials']).toBeUndefined();
	});
});

describe('origin matching is exact', () => {
	// Every one of these is a real bypass in a naive prefix/suffix implementation.
	const nearMisses = [
		'https://client.example.org.evil.net', // suffix-extended
		'https://evil.org?https://client.example.org', // embedded
		'http://client.example.org', // scheme downgrade
		'https://client.example.org:8443', // different port
		'https://client.example.org/', // trailing slash is not an origin
		'https://CLIENT.example.org', // case differs
		'https://sub.client.example.org', // subdomain
		'null', // sandboxed iframe / file://
	];

	for (const origin of nearMisses) {
		test(`refuses ${origin}`, () => {
			expect(buildCorsResponseHeaders(origin, LIST)['Access-Control-Allow-Origin']).toBeUndefined();
			expect(buildCorsPreflightResponse(origin, LIST)).toBeNull();
		});
	}

	test('a partial wildcard is a literal string, never a pattern', () => {
		// The ONLY sentinel is a bare `*`. `*.example.org` and `https://*.example.org`
		// are ordinary (nonsensical) entries that match themselves and nothing else —
		// if either ever started matching subdomains, that IS the suffix bypass above.
		for (const pattern of ['*.example.org', 'https://*.example.org', 'https://*']) {
			const list: ReadonlySet<string> = new Set([pattern]);
			for (const origin of [ALLOWED, 'https://sub.example.org', 'https://example.org']) {
				expect(
					buildCorsResponseHeaders(origin, list)['Access-Control-Allow-Origin'],
				).toBeUndefined();
				expect(buildCorsPreflightResponse(origin, list)).toBeNull();
			}
		}
	});
});

/**
 * The public ontology master (`DEDALO_CORS_ALLOWED_ORIGINS=["*"]`): an
 * enumerated list cannot express "every Dédalo on the internet", so the bare
 * `*` entry is read as any origin. Two properties keep it from becoming the
 * footgun the rest of this file exists to prevent — it is still not emitted on
 * the wire, and it still never carries credentials.
 */
describe('the `*` sentinel — any origin', () => {
	const strangers = [
		ALLOWED,
		'https://unknown.museum.example',
		'http://192.168.1.2:3500',
		'https://client.example.org.evil.net',
		// A sandboxed iframe / file:// document. Under `*` it is allowed like
		// anything else: "any origin except this one" would be an arbitrary
		// carve-out, since an attacker already controls a real origin.
		'null',
	];

	for (const origin of strangers) {
		test(`answers ${origin}`, () => {
			expect(buildCorsResponseHeaders(origin, ANY)).toEqual({
				'Access-Control-Allow-Origin': origin,
				Vary: 'Origin',
			});
			expect(buildCorsPreflightResponse(origin, ANY)?.status).toBe(204);
		});
	}

	test('the REQUEST origin is echoed — a literal `*` never reaches the wire', () => {
		const headers = buildCorsResponseHeaders('https://unknown.example', ANY);
		expect(headers['Access-Control-Allow-Origin']).toBe('https://unknown.example');
		expect(Object.values(headers)).not.toContain('*');
		const preflight = buildCorsPreflightResponse('https://unknown.example', ANY);
		expect(preflight?.headers.get('Access-Control-Allow-Origin')).toBe('https://unknown.example');
	});

	test('credentials stay refused — opening the door never opens a session', () => {
		expect(
			buildCorsResponseHeaders(ALLOWED, ANY)['Access-Control-Allow-Credentials'],
		).toBeUndefined();
		expect(
			buildCorsPreflightResponse(ALLOWED, ANY)?.headers.get('Access-Control-Allow-Credentials'),
		).toBeNull();
	});

	test('a same-origin request (no Origin header) is still not echoed', () => {
		expect(buildCorsResponseHeaders(null, ANY)).toEqual({ Vary: 'Origin' });
		expect(buildCorsPreflightResponse(null, ANY)).toBeNull();
	});

	test('it wins over the rest of the list rather than intersecting with it', () => {
		const mixed: ReadonlySet<string> = new Set([ALLOWED, '*']);
		expect(buildCorsResponseHeaders('https://stranger.example', mixed)).toEqual({
			'Access-Control-Allow-Origin': 'https://stranger.example',
			Vary: 'Origin',
		});
	});
});

describe('preflight', () => {
	test('an allowlisted origin gets a 204 with an empty body', async () => {
		const response = buildCorsPreflightResponse(ALLOWED, LIST);
		expect(response).not.toBeNull();
		expect(response?.status).toBe(204);
		expect(await response?.text()).toBe('');
	});

	test('it allows exactly the methods the API serves', () => {
		const allow = buildCorsPreflightResponse(ALLOWED, LIST)?.headers.get(
			'Access-Control-Allow-Methods',
		);
		expect(allow).toBe('POST, OPTIONS');
		// GET would be a lie: API_PATHS only routes POST.
		expect(allow).not.toContain('GET');
	});

	test('it allows every header data_manager.js actually sends', () => {
		const allow =
			buildCorsPreflightResponse(ALLOWED, LIST)?.headers.get('Access-Control-Allow-Headers') ?? '';
		// Content-Type: application/json is itself what forces the preflight;
		// X-Dedalo-Csrf-Token is injected for every non-bootstrap action.
		for (const header of ['Content-Type', 'X-Dedalo-Csrf-Token']) {
			expect(allow).toContain(header);
		}
	});

	test('it carries Allow-Origin and Vary — a preflight without them is failed', () => {
		const headers = buildCorsPreflightResponse(ALLOWED, LIST)?.headers;
		expect(headers?.get('Access-Control-Allow-Origin')).toBe(ALLOWED);
		expect(headers?.get('Vary')).toBe('Origin');
	});

	test('a refused origin is declined, not answered', () => {
		expect(buildCorsPreflightResponse('https://evil.example.org', LIST)).toBeNull();
		expect(buildCorsPreflightResponse(null, LIST)).toBeNull();
	});
});

/**
 * The wiring, gated at the SOURCE. Both halves live in `server.ts`, and both are
 * ordering-sensitive in a way no unit of `cors.ts` can catch:
 *
 *   * the preflight branch must precede every POST branch — the browser sends
 *     OPTIONS first, every API branch below tests for POST, so a preflight
 *     wired after them falls through to the 404 and the real request is never
 *     sent (the feature fails ENTIRELY, while every test above stays green);
 *   * the API response must carry `Allow-Origin` too — a passed preflight only
 *     buys the right to SEND, and the browser discards a response that does not
 *     repeat the header.
 *
 * Booting `handleRequest` here would need a configured box and a DB, and the
 * allowlist is boot-time anyway, so the honest cheap gate is to read the file.
 */
describe('wiring in server.ts', () => {
	const source = readFileSync(new URL('../../src/server.ts', import.meta.url), 'utf8');

	test('both halves are imported from the one emitter', () => {
		expect(source).toContain(
			"import { corsPreflightResponse, corsResponseHeaders } from './core/security/cors.ts';",
		);
	});

	test('the preflight branch comes before every POST branch', () => {
		const preflight = source.indexOf("request.method === 'OPTIONS'");
		expect(preflight).toBeGreaterThan(-1);

		// A branch is a POST branch when its own condition names POST — read the
		// condition only (the guard plus the next line), never the prose around it.
		const postBranches = [...source.matchAll(/API_PATHS\.has\(url\.pathname\)/g)]
			.map((match) => match.index ?? -1)
			.filter((index) => source.slice(index, index + 80).includes("request.method === 'POST'"));
		expect(postBranches.length).toBeGreaterThan(0);
		for (const index of postBranches) expect(preflight).toBeLessThan(index);
	});

	test('the API response merges the CORS headers', () => {
		expect(source).toContain('...corsResponseHeaders(request)');
	});
});
