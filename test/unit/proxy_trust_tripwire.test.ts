/**
 * PROXY TRUST: A HEADER IS ONLY AS TRUSTWORTHY AS ITS TRANSPORT (P2-4, 2026-08-24).
 *
 * `X-Forwarded-For` is a request header — anything that can open a connection can write
 * it. It is believable only because a reverse proxy is known to have rewritten it, which
 * makes "is a proxy in front of THIS listener?" part of the answer, not a deployment
 * detail.
 *
 * The hop arithmetic was already right (`TRUSTED_PROXY_HOPS` from the right, never the
 * left-most entry). What was missing is that it ran on EVERY listener. On the direct TCP
 * listener — the one a browser reaches with no web server in front — a client sent its
 * own `X-Forwarded-For` and simply chose the value. Three consequences, all real:
 *
 *  - the login throttle is keyed on that address, so an attacker minted a fresh
 *    brute-force bucket per request — the exact evasion the hop arithmetic exists for;
 *  - `dd544` activity rows recorded an attacker-chosen address as fact;
 *  - the address allowlists' `loopback` entry admitted `127.0.0.1` (the error-report
 *    intake, retired 2026-11-19; until 2026-10-12 also the install gate), so a forged
 *    header was a claim to be loopback. The old comment on the function read "this is never an authorization
 *    input"; that was not true.
 *
 * There was a second, quieter bug in the same expression: `Math.max(0, len - hops)`
 * clamped a SHORT header to index 0 and returned its LEFT-MOST entry — the attacker's
 * own value — whenever fewer entries arrived than the operator declared hops.
 *
 * HONEST LIMIT: this proves the resolution rule and its throttle consequence. It does
 * not prove that Bun reports the peer address correctly, nor that an operator's declared
 * transport matches their deployment — a `TRUSTED_PROXY_TRANSPORT=tcp` on a port with no
 * proxy is back to trusting the caller, which is why the default is `socket` and the
 * catalog says so.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import {
	buildThrottleKey,
	resetSessionStoreForTests,
} from '../../src/core/security/session_store.ts';
import { clientIpFromRequest, createRequestContext } from '../../src/server.ts';

afterEach(() => resetSessionStoreForTests());

const req = (headers: Record<string, string> = {}): Request =>
	new Request('http://x/', { headers });

/** A listener with NO proxy in front: the dev TCP port a browser reaches directly. */
const untrusted = (peerIp: string | null = '198.51.100.9') =>
	createRequestContext({ devListener: true, peerIp, proxyTrusted: false });

/** A listener behind the reverse proxy: the production unix socket. */
const trusted = () => createRequestContext({ proxyTrusted: true, peerIp: null });

describe('proxy trust: an untrusted transport never believes the header', () => {
	test('a forged X-Forwarded-For cannot move the resolved address', () => {
		const forged = req({ 'x-forwarded-for': '9.9.9.9' });
		expect(clientIpFromRequest(forged, untrusted())).toBe('198.51.100.9');
	});

	test('a forged CHAIN cannot move it either, however long', () => {
		const forged = req({ 'x-forwarded-for': '9.9.9.9, 8.8.8.8, 7.7.7.7' });
		expect(clientIpFromRequest(forged, untrusted())).toBe('198.51.100.9');
	});

	test('a forged loopback claim is not honoured', () => {
		// An allowlist's `loopback` entry admits 127.0.0.1, so this spelling is a claim
		// to be on the machine. It must come from the connection, never from a header.
		const forged = req({ 'x-forwarded-for': '127.0.0.1' });
		expect(clientIpFromRequest(forged, untrusted())).not.toBe('127.0.0.1');
	});

	test('no peer address either → local, never the header', () => {
		const forged = req({ 'x-forwarded-for': '127.0.0.1' });
		expect(clientIpFromRequest(forged, untrusted(null))).toBe('local');
	});

	test('createRequestContext defaults to UNTRUSTED', () => {
		// A context nobody described is a context with no proxy behind it. Defaulting
		// the other way would hand the spoofable behaviour to every future caller by
		// omission.
		const context = createRequestContext();
		expect(context.proxyTrusted).toBe(false);
		expect(clientIpFromRequest(req({ 'x-forwarded-for': '9.9.9.9' }), context)).toBe('local');
	});
});

describe('proxy trust: a trusted transport reads the TRUSTED hop', () => {
	test('the single trusted hop is the client, and the left-most is ignored', () => {
		expect(clientIpFromRequest(req({ 'x-forwarded-for': '1.2.3.4, 203.0.113.7' }), trusted())).toBe(
			'203.0.113.7',
		);
	});

	test('no header on a trusted transport → local', () => {
		expect(clientIpFromRequest(req(), trusted())).toBe('local');
	});

	test('a SHORT header is treated as forged, not as a shorter chain', () => {
		// The old code clamped the index to 0 and returned the left-most entry — the
		// attacker's own value — whenever the header was shorter than the hop count.
		const saved = process.env.TRUSTED_PROXY_HOPS;
		process.env.TRUSTED_PROXY_HOPS = '2';
		try {
			const resolved = clientIpFromRequest(req({ 'x-forwarded-for': '9.9.9.9' }), trusted());
			expect(resolved).not.toBe('9.9.9.9');
			expect(resolved).toBe('proxy-malformed');
		} finally {
			if (saved === undefined) delete process.env.TRUSTED_PROXY_HOPS;
			else process.env.TRUSTED_PROXY_HOPS = saved;
		}
	});

	test('the hop count is read per call, not captured at import', () => {
		// A module-level const is fixed at import: a gate written against one would be
		// asserting its own default and nothing else.
		const saved = process.env.TRUSTED_PROXY_HOPS;
		try {
			const header = { 'x-forwarded-for': '1.1.1.1, 2.2.2.2, 3.3.3.3' };
			process.env.TRUSTED_PROXY_HOPS = '1';
			expect(clientIpFromRequest(req(header), trusted())).toBe('3.3.3.3');
			process.env.TRUSTED_PROXY_HOPS = '2';
			expect(clientIpFromRequest(req(header), trusted())).toBe('2.2.2.2');
		} finally {
			if (saved === undefined) delete process.env.TRUSTED_PROXY_HOPS;
			else process.env.TRUSTED_PROXY_HOPS = saved;
		}
	});
});

describe('proxy trust: the throttle consequence', () => {
	test('rotating a forged XFF no longer mints a fresh throttle bucket', () => {
		// This is the whole point. Same peer, different forged headers, ONE bucket.
		const first = clientIpFromRequest(req({ 'x-forwarded-for': '9.9.9.9' }), untrusted());
		const second = clientIpFromRequest(req({ 'x-forwarded-for': '8.8.8.8' }), untrusted());
		expect(buildThrottleKey('login', 'victim', first)).toBe(
			buildThrottleKey('login', 'victim', second),
		);
	});

	test('a malformed-proxy sentinel still separates accounts', () => {
		// It must not amplify into an install-wide lockout: the login key carries the
		// USERNAME, so a misconfigured hop count degrades to one bucket per account.
		expect(buildThrottleKey('login', 'alice', 'proxy-malformed')).not.toBe(
			buildThrottleKey('login', 'bob', 'proxy-malformed'),
		);
	});
});

describe('proxy trust: the resolution has ONE production call site', () => {
	test('every production caller passes a request context', async () => {
		// A call without a context falls back to the socket-shaped default, which is
		// right for a test and wrong for a listener. Pin that no production code takes
		// that path by accident.
		const { Glob } = await import('bun');
		const { readFileSync } = await import('node:fs');
		const callers: string[] = [];
		for (const file of new Glob('**/*.ts').scanSync({ cwd: 'src', absolute: false })) {
			const source = readFileSync(`src/${file}`, 'utf8');
			for (const match of source.matchAll(/clientIpFromRequest\(([^)]*)\)/g)) {
				const args = (match[1] ?? '').trim();
				// The declaration itself carries a typed parameter list, not arguments.
				if (args.startsWith('request: Request')) continue;
				callers.push(`src/${file}: clientIpFromRequest(${args})`);
			}
		}
		expect(callers).toHaveLength(1);
		expect(callers[0]).toContain('request, context');
	});
});
