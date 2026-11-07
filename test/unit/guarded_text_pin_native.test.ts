/**
 * `fetchGuardedText` CONNECTS TO THE ADDRESS IT VETTED (SURF-2, 2026-09-30).
 *
 * The public single-call door — translation, transcription, the RDF import, whose
 * URL a client supplies — used to vet the name with `assertPublicUrl` and then hand
 * the NAME to a bare `fetch`, which resolved it AGAIN at connect time. An attacker's
 * DNS server answers the first query with a public address and the second with
 * 127.0.0.1 (DNS rebinding): every refusal in the guard's truth table was one TTL=0
 * record away from bypass.
 *
 * The situation is BUILT, hermetically, through the door's `deps` seam: a rebinding
 * resolver (first `attacker.test` query public, every later one loopback) and a
 * recording socket. The outcome asserted is where the ONE connection went — the
 * vetted IP in the URL, the real name in the Host header and the TLS server name —
 * plus the door's other contracts on the same seam: a 3xx is refused, not followed;
 * a non-2xx is a typed `security.outbound_failed` with its status; a
 * `URLSearchParams` body reaches the socket as one (Bun sets the form content type
 * from it); a resolver that stalls or a socket that fails is a typed
 * `security.outbound_failed` with `reason` and `stage`, not a raw Bun error; a POST
 * is never re-sent to the next vetted address unless the failure proves nothing was
 * sent (RFC 9110 §9.2.2 — a re-sent `transcribe` starts a second, billed job), and a GET
 * from a caller whose provider counts requests (`resendOnlyUnsent`, the geo services) gets
 * the same rule.
 *
 * THE BYTE CEILING and THE ERROR PAGE, on BOTH text doors (`fetchGuardedText` through
 * the seam, `fetchBoundedText` against a loopback peer — it has no seam): a caller's
 * `maxBytes` and the default ceiling end the read as `body_cap` with the stream
 * cancelled (DOS-05/06: the cap lives in the shared hop core now, so only an outcome
 * speaks for it), and a non-2xx is `HTTP <n>` with its body cancelled UNREAD — an
 * error page that stalls or overflows must not turn into a timeout or a body_cap.
 *
 * THE DEADLINE, on BOTH text doors: a caller's `timeoutMs` ends a stalled resolver or a
 * wedged peer within an UPPER bound (an ignored option would still end as reason
 * timeout — at the 15 s default, inside the runner's 30 s budget), and with no
 * `timeoutMs` the DEFAULT ends it at exactly 15 s under a fake clock (translation,
 * transcription and the RDF import pass none: that default is all that frees a job
 * lane from a wedged peer). And on `fetchBoundedText` — the private-destination
 * transport, no seam — the rest of its promise as outcomes on a loopback peer: a 302
 * is refused typed with its Location never contacted (a followed redirect escapes the
 * caller's address policy), a closed port is `transport`/`connect`, and the running
 * job's stop reaches the connect (`aborted`). The same on `fetchGuardedText`, the door
 * translation and transcription take INSIDE job lanes (PERF-11): a socket that never
 * answers is released by the job's stop as `aborted`/`connect`, well before the deadline.
 *
 * MUTATIONS — 2026-09-30, src/core/security/ssrf_guard.ts, each alone, gate set this
 * file + job_lane_budget_native + outbound_fetch_tripwire + ssrf_one_guard_tripwire:
 *   Mt_guardedOpt       guarded door ignores timeoutMs         red (resolve-stall bound)
 *   Mt_boundedOpt       bounded door ignores timeoutMs         red (2: wedged-peer bounds)
 *   Mt_guardedDefault   guarded default 15 s → 60 s            red (fake-clock default)
 *   Mt_boundedDefault   bounded default 15 s → 60 s            red (fake-clock default)
 *   Mbounded_untyped    connectUnpinned rethrows Bun's error   red (8, closed port first)
 *   Mbounded_follow     connectUnpinned redirect: 'follow'     red (3xx outcome + structure)
 *   Mbounded_noSignal   connectUnpinned drops the signal       red (6, outcome + structure)
 *   Mguarded_detached   guardedTextRequest detachedFromJob:true red (1, job-stop outcome)
 */

import { afterAll, afterEach, beforeEach, describe, expect, jest, test } from 'bun:test';
import { DedaloError } from '../../src/core/errors/index.ts';
import { runWithJobSignal } from '../../src/core/media/job_scope.ts';
import {
	type AddressLookup,
	fetchBoundedText,
	fetchGuardedText,
	nat64DiscoveryState,
	type PinnedFetchInit,
	type PinnedHopDeps,
	setNat64DiscoveryForTests,
} from '../../src/core/security/ssrf_guard.ts';

/**
 * Hermetic discovery and no declared prefix: an empty, UNEXPIRED cache (no real
 * `ipv4only.arpa` query) and `DEDALO_NAT64_PREFIXES` pinned to '' (a deleted key
 * falls back to ../private/.env through readEnv). Both restored after each case.
 */
const originalDiscovery = nat64DiscoveryState();
const NAT64_SETTING = 'DEDALO_NAT64_PREFIXES';
const originalNat64 = process.env[NAT64_SETTING];
beforeEach(() => {
	process.env[NAT64_SETTING] = '';
	setNat64DiscoveryForTests({ prefixes: [], expiresAt: Date.now() + 10 * 60_000 });
});
afterEach(() => {
	// A fake-clock case that fails mid-way must not leave the clock fake for the next.
	jest.useRealTimers();
	if (originalNat64 === undefined) delete process.env[NAT64_SETTING];
	else process.env[NAT64_SETTING] = originalNat64;
	setNat64DiscoveryForTests(originalDiscovery);
});

const PUBLIC_V4 = '93.184.216.34';
const TARGET = 'https://attacker.test/x';

/** The attacker's DNS: the FIRST answer for `attacker.test` is public, every later one loopback. */
function rebindingLookup(): { lookup: AddressLookup; queries: string[] } {
	const queries: string[] = [];
	return {
		queries,
		lookup: async (host) => {
			queries.push(host);
			if (host !== 'attacker.test') throw new Error(`ENOTFOUND ${host}`);
			const first = queries.filter((query) => query === 'attacker.test').length === 1;
			return [{ address: first ? PUBLIC_V4 : '127.0.0.1', family: 4 }];
		},
	};
}

interface SeenCall {
	url: string;
	init: PinnedFetchInit;
}

/** A socket seam that records every call and answers with `respond`. */
function recordingFetch(respond: () => Response | Promise<Response>): {
	calls: SeenCall[];
	fetch: NonNullable<PinnedHopDeps['fetch']>;
} {
	const calls: SeenCall[] = [];
	return {
		calls,
		fetch: async (url, init) => {
			calls.push({ url, init });
			return respond();
		},
	};
}

/**
 * The text doors' default TOTAL deadline when a caller passes no `timeoutMs` —
 * translation, transcription and the RDF import all rely on it (OUTBOUND_SPEC §2).
 * It is the only thing that stops a wedged peer holding a job lane for ever.
 */
const DEFAULT_DEADLINE_MS = 15_000;

/** A call whose settlement can be polled while a fake clock is advanced. */
function observe(work: Promise<string>): {
	settled: boolean;
	outcome: Promise<{ body?: string; error?: unknown }>;
} {
	const state = { settled: false, outcome: settle(work) };
	state.outcome.then(() => {
		state.settled = true;
	});
	return state;
}

/** Let every queued continuation run (no timer involved — the clock may be fake). */
async function flushMicrotasks(): Promise<void> {
	for (let turn = 0; turn < 50; turn++) await Promise.resolve();
}

/** The settled outcome of a call, so a red case prints WHAT happened instead. */
async function settle(work: Promise<string>): Promise<{ body?: string; error?: unknown }> {
	try {
		return { body: await work };
	} catch (error) {
		return { error };
	}
}

function describeError(error: unknown): string {
	if (error instanceof DedaloError) {
		return `${error.code} ${JSON.stringify(error.coordinates ?? {})} ${error.message}`;
	}
	return String(error);
}

describe('fetchGuardedText: vetted, pinned, typed', () => {
	test('a rebinding resolver cannot move the socket: ONE connection, to the vetted IP, SNI and Host kept', async () => {
		const dns = rebindingLookup();
		const socket = recordingFetch(() => new Response('the body'));
		const outcome = await settle(
			fetchGuardedText(TARGET, {}, { lookup: dns.lookup, fetch: socket.fetch }),
		);
		expect(
			outcome.error === undefined ? 'ok' : describeError(outcome.error),
			'the door must vet through the resolver it is handed and connect to what it vetted',
		).toBe('ok');
		expect(outcome.body).toBe('the body');
		expect(socket.calls.length, 'exactly one connection').toBe(1);
		const call = socket.calls[0] as SeenCall;
		expect(new URL(call.url).hostname, 'the socket aims at the VETTED address, not the name').toBe(
			PUBLIC_V4,
		);
		expect(new Headers(call.init.headers).get('host')).toBe('attacker.test');
		expect(call.init.tls?.serverName).toBe('attacker.test');
		expect(
			dns.queries.filter((query) => query === 'attacker.test'),
			'the name is resolved ONCE — a second resolution is the rebinding window',
		).toHaveLength(1);
	});

	test('a 3xx is refused, not followed: one connection, the Location never contacted', async () => {
		const socket = recordingFetch(
			() => new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/admin' } }),
		);
		const outcome = await settle(
			fetchGuardedText(TARGET, {}, { lookup: rebindingLookup().lookup, fetch: socket.fetch }),
		);
		expect(outcome.body, 'a redirect is not an answer').toBeUndefined();
		expect(socket.calls.length).toBe(1);
		expect(describeError(outcome.error)).toMatch(/redirect/i);
		expect(describeError(outcome.error)).not.toMatch(/dns_failed/);
	});

	test('a non-2xx is a typed security.outbound_failed carrying its status', async () => {
		const socket = recordingFetch(() => new Response('gone', { status: 404 }));
		const outcome = await settle(
			fetchGuardedText(TARGET, {}, { lookup: rebindingLookup().lookup, fetch: socket.fetch }),
		);
		expect(describeError(outcome.error)).toStartWith('security.outbound_failed');
		expect((outcome.error as DedaloError).coordinates?.status).toBe(404);
		expect((outcome.error as DedaloError).message).toBe('HTTP 404');
		expect(socket.calls.length).toBe(1);
	});

	test('a URLSearchParams body reaches the socket AS URLSearchParams, method POST', async () => {
		const socket = recordingFetch(() => new Response('translated'));
		const body = new URLSearchParams({ text: 'hola', lang: 'lg-spa' });
		const outcome = await settle(
			fetchGuardedText(
				TARGET,
				{ init: { method: 'POST', body } },
				{ lookup: rebindingLookup().lookup, fetch: socket.fetch },
			),
		);
		expect(outcome.error === undefined ? 'ok' : describeError(outcome.error)).toBe('ok');
		const call = socket.calls[0] as SeenCall;
		expect(call.init.method).toBe('POST');
		expect(call.init.body).toBeInstanceOf(URLSearchParams);
		expect((call.init.body as URLSearchParams).get('text')).toBe('hola');
	});

	test('a resolver that stalls past the deadline is a typed timeout at the resolve stage', async () => {
		const stalled: AddressLookup = () => new Promise(() => {});
		const socket = recordingFetch(() => new Response('never'));
		const startedAt = performance.now();
		const outcome = await settle(
			fetchGuardedText(TARGET, { timeoutMs: 50 }, { lookup: stalled, fetch: socket.fetch }),
		);
		const elapsed = performance.now() - startedAt;
		expect(describeError(outcome.error)).toStartWith('security.outbound_failed');
		expect((outcome.error as DedaloError).coordinates).toMatchObject({
			reason: 'timeout',
			stage: 'resolve',
		});
		// The CALLER's deadline, not the 15 s default: without an upper bound an ignored
		// `timeoutMs` still ends as reason timeout, inside the runner's 30 s budget.
		expect(elapsed, "the caller's timeoutMs is the deadline").toBeLessThan(1000);
		expect(socket.calls.length).toBe(0);
	});

	test('with no timeoutMs the DEFAULT deadline (15 s) ends a stalled resolver — at 15 s, not before, not never', async () => {
		jest.useFakeTimers();
		try {
			// Re-armed under the fake clock: the discovery cache must stay unexpired.
			setNat64DiscoveryForTests({ prefixes: [], expiresAt: Date.now() + 10 * 60_000 });
			const stalled: AddressLookup = () => new Promise(() => {});
			const socket = recordingFetch(() => new Response('never'));
			const call = observe(fetchGuardedText(TARGET, {}, { lookup: stalled, fetch: socket.fetch }));
			jest.advanceTimersByTime(DEFAULT_DEADLINE_MS - 1);
			await flushMicrotasks();
			expect(call.settled, 'nothing ends the call before the default deadline').toBe(false);
			jest.advanceTimersByTime(1);
			await flushMicrotasks();
			expect(call.settled, 'the default deadline ends the call').toBe(true);
			const outcome = await call.outcome;
			expect(describeError(outcome.error)).toStartWith('security.outbound_failed');
			expect((outcome.error as DedaloError).coordinates).toMatchObject({
				reason: 'timeout',
				stage: 'resolve',
			});
			expect(socket.calls.length).toBe(0);
		} finally {
			jest.useRealTimers();
		}
	});

	test("a socket that never answers is released by the running job's stop, typed aborted (PERF-11)", async () => {
		// Translation and transcription run inside job lanes through THIS door: a stopped
		// job must free its lane now, not at the 15 s deadline.
		const job = new AbortController();
		const parked: NonNullable<PinnedHopDeps['fetch']> = () => new Promise(() => {});
		const startedAt = performance.now();
		const call = runWithJobSignal(job.signal, () =>
			settle(
				fetchGuardedText(
					TARGET,
					{ timeoutMs: 20_000 },
					{ lookup: rebindingLookup().lookup, fetch: parked },
				),
			),
		);
		setTimeout(() => job.abort(), 50);
		const outcome = await call;
		const elapsed = performance.now() - startedAt;
		expect(describeError(outcome.error)).toStartWith('security.outbound_failed');
		expect((outcome.error as DedaloError).coordinates).toMatchObject({
			reason: 'aborted',
			stage: 'connect',
		});
		expect(elapsed, 'the job signal reaches the pinned connect').toBeLessThan(2000);
	});

	test('a socket that fails is a typed transport failure at the connect stage, not a raw Bun error', async () => {
		const socket = recordingFetch(() => {
			throw new TypeError('ConnectionRefused');
		});
		const outcome = await settle(
			fetchGuardedText(TARGET, {}, { lookup: rebindingLookup().lookup, fetch: socket.fetch }),
		);
		expect(describeError(outcome.error)).toStartWith('security.outbound_failed');
		expect((outcome.error as DedaloError).coordinates).toMatchObject({
			reason: 'transport',
			stage: 'connect',
		});
	});

	test('a method, body or init key the pinned hop cannot carry is refused loudly, before any socket', async () => {
		for (const init of [
			{ method: 'PUT' },
			{ method: 'POST', body: new FormData() },
			// a key the hop cannot carry is refused, never silently dropped
			{ signal: new AbortController().signal },
			{ redirect: 'follow' },
		] as RequestInit[]) {
			const socket = recordingFetch(() => new Response('never'));
			const outcome = await settle(
				fetchGuardedText(
					TARGET,
					{ init },
					{ lookup: rebindingLookup().lookup, fetch: socket.fetch },
				),
			);
			expect(describeError(outcome.error), Object.keys(init).join(',')).toStartWith(
				'request.invalid_data',
			);
			expect(socket.calls.length).toBe(0);
		}
	});

	test('positive control: a name that resolves inward is refused before any socket', async () => {
		const inward: AddressLookup = async () => [{ address: '127.0.0.1', family: 4 }];
		const socket = recordingFetch(() => new Response('never'));
		const outcome = await settle(
			fetchGuardedText(TARGET, {}, { lookup: inward, fetch: socket.fetch }),
		);
		expect(outcome.error).toBeInstanceOf(DedaloError);
		expect((outcome.error as DedaloError).code).toBe('security.ssrf_blocked');
		expect((outcome.error as DedaloError).coordinates?.reason).toBe('private_resolved');
		expect(socket.calls.length).toBe(0);
	});
});

/** A lookup answering two public addresses for `attacker.test` (a dual-stack-like name). */
const TWO_ADDRESSES: AddressLookup = async () => [
	{ address: PUBLIC_V4, family: 4 },
	{ address: '93.184.216.35', family: 4 },
];

/** A socket seam whose FIRST call rejects with a Bun-shaped `code`, every later one answers. */
function firstCallFails(code: string): ReturnType<typeof recordingFetch> {
	let calls = 0;
	return recordingFetch(() => {
		calls += 1;
		if (calls === 1) throw Object.assign(new TypeError(`socket failed: ${code}`), { code });
		return new Response('second address');
	});
}

describe('fetchGuardedText: a failed attempt is re-sent only when that is safe', () => {
	test('a POST reset AFTER it was sent is NOT re-sent to the next address: one fetch, typed', async () => {
		const socket = firstCallFails('ECONNRESET');
		const outcome = await settle(
			fetchGuardedText(
				TARGET,
				{ init: { method: 'POST', body: 'method_name=transcribe' } },
				{ lookup: TWO_ADDRESSES, fetch: socket.fetch },
			),
		);
		expect(socket.calls.length, 'a non-idempotent request is never replayed').toBe(1);
		expect((outcome.error as DedaloError).coordinates).toMatchObject({
			reason: 'transport',
			stage: 'connect',
		});
	});

	test('a POST whose connection was REFUSED (nothing sent) moves on to the next address', async () => {
		const socket = firstCallFails('ConnectionRefused');
		const outcome = await settle(
			fetchGuardedText(
				TARGET,
				{ init: { method: 'POST', body: 'x=1' } },
				{ lookup: TWO_ADDRESSES, fetch: socket.fetch },
			),
		);
		expect(outcome.error === undefined ? 'ok' : describeError(outcome.error)).toBe('ok');
		expect(outcome.body).toBe('second address');
		expect(socket.calls.length).toBe(2);
	});

	test('a GET (idempotent) moves on after a reset too', async () => {
		const socket = firstCallFails('ECONNRESET');
		const outcome = await settle(
			fetchGuardedText(TARGET, {}, { lookup: TWO_ADDRESSES, fetch: socket.fetch }),
		);
		expect(outcome.body).toBe('second address');
		expect(socket.calls.length).toBe(2);
	});

	// A caller whose provider COUNTS requests (the geo services: Nominatim allows one a second for
	// the whole installation, and the caller's slot is one request) asks for the POST rule on a GET:
	// a reset that arrives after the request left must not become a second request at the provider.
	test('a GET with resendOnlyUnsent is NOT re-sent after a reset: one fetch, typed — the POST rule', async () => {
		const socket = firstCallFails('ECONNRESET');
		const outcome = await settle(
			fetchGuardedText(
				TARGET,
				{ resendOnlyUnsent: true },
				{ lookup: TWO_ADDRESSES, fetch: socket.fetch },
			),
		);
		expect(socket.calls.length, 'the second address was never tried').toBe(1);
		expect((outcome.error as DedaloError).code).toBe('security.outbound_failed');
		expect((outcome.error as DedaloError).coordinates).toMatchObject({
			reason: 'transport',
			stage: 'connect',
		});
	});

	test('a GET with resendOnlyUnsent still moves on when the connection was REFUSED (nothing sent), for every code that proves it', async () => {
		for (const code of [
			'ConnectionRefused',
			'FailedToOpenSocket',
			'ECONNREFUSED',
			'EHOSTUNREACH',
			'ENETUNREACH',
			'EADDRNOTAVAIL',
		]) {
			const socket = firstCallFails(code);
			const outcome = await settle(
				fetchGuardedText(
					TARGET,
					{ resendOnlyUnsent: true },
					{ lookup: TWO_ADDRESSES, fetch: socket.fetch },
				),
			);
			expect(outcome.body, code).toBe('second address');
			expect(socket.calls.length, code).toBe(2);
		}
	});

	test('a failure with no code at all proves nothing was sent, so resendOnlyUnsent does not move on', async () => {
		let calls = 0;
		const socket = recordingFetch(() => {
			calls += 1;
			if (calls === 1) throw new TypeError('socket failed');
			return new Response('second address');
		});
		const outcome = await settle(
			fetchGuardedText(
				TARGET,
				{ resendOnlyUnsent: true },
				{ lookup: TWO_ADDRESSES, fetch: socket.fetch },
			),
		);
		expect(socket.calls.length).toBe(1);
		expect(outcome.error).toBeInstanceOf(DedaloError);
	});
});

/**
 * A body that is never finished: one chunk per pull, until cancelled — or until the
 * FUSE (`fuseBytes`), which errors the stream so a regressed ceiling fails this gate
 * instead of eating the machine. Each pull yields a macrotask, so the door's timers
 * still run against a peer that answers instantly.
 */
function endlessBody(
	chunk: Uint8Array,
	fuseBytes: number,
): { stream: ReadableStream<Uint8Array>; state: { pulled: number; cancelled: boolean } } {
	const state = { pulled: 0, cancelled: false };
	const stream = new ReadableStream<Uint8Array>({
		async pull(controller) {
			await new Promise((resolve) => setImmediate(resolve));
			if (state.pulled >= fuseBytes) {
				controller.error(
					new Error(`test fuse: ${fuseBytes} bytes served, no ceiling stopped the read`),
				);
				return;
			}
			state.pulled += chunk.byteLength;
			controller.enqueue(chunk);
		},
		cancel() {
			state.cancelled = true;
		},
	});
	return { stream, state };
}

/** A body that sends nothing and never ends: an error page that stalls. */
function stalledBody(): { stream: ReadableStream<Uint8Array>; state: { cancelled: boolean } } {
	const state = { cancelled: false };
	const stream = new ReadableStream<Uint8Array>({
		pull: () => new Promise<void>(() => {}),
		cancel() {
			state.cancelled = true;
		},
	});
	return { stream, state };
}

function expectBodyCap(error: unknown, maxBytes: number): void {
	expect(describeError(error)).toStartWith('security.outbound_failed');
	expect((error as DedaloError).coordinates).toMatchObject({
		reason: 'body_cap',
		max_bytes: maxBytes,
	});
}

function expectHttpStatus(error: unknown, status: number): void {
	expect(describeError(error)).toStartWith('security.outbound_failed');
	expect((error as DedaloError).message).toBe(`HTTP ${status}`);
	expect((error as DedaloError).coordinates?.status).toBe(status);
}

describe('fetchGuardedText: the byte ceiling and the error page', () => {
	test("a caller's maxBytes ends the read as body_cap, the stream cancelled", async () => {
		const body = endlessBody(new Uint8Array(64), 64 * 1024);
		const socket = recordingFetch(() => new Response(body.stream));
		const outcome = await settle(
			fetchGuardedText(TARGET, { maxBytes: 8 }, { lookup: TWO_ADDRESSES, fetch: socket.fetch }),
		);
		expectBodyCap(outcome.error, 8);
		expect(body.state.cancelled, 'over the ceiling the body is cancelled, not drained').toBe(true);
	});

	test('with no maxBytes the DEFAULT ceiling (25 MiB) still ends an endless body', async () => {
		const MIB = 1024 * 1024;
		const body = endlessBody(new Uint8Array(MIB), 64 * MIB);
		const socket = recordingFetch(() => new Response(body.stream));
		const outcome = await settle(
			fetchGuardedText(
				TARGET,
				{ timeoutMs: 10_000 },
				{ lookup: TWO_ADDRESSES, fetch: socket.fetch },
			),
		);
		expectBodyCap(outcome.error, 25 * MIB);
		expect(body.state.cancelled).toBe(true);
		expect(body.state.pulled, 'the reader stops at the ceiling').toBeLessThanOrEqual(28 * MIB);
	});

	test('a 503 whose body never ends is HTTP 503, its body cancelled unread', async () => {
		const body = stalledBody();
		const socket = recordingFetch(() => new Response(body.stream, { status: 503 }));
		const outcome = await settle(
			fetchGuardedText(TARGET, { timeoutMs: 2000 }, { lookup: TWO_ADDRESSES, fetch: socket.fetch }),
		);
		expectHttpStatus(outcome.error, 503);
		expect(body.state.cancelled).toBe(true);
	});

	test('a 500 whose body is over maxBytes is HTTP 500, not body_cap', async () => {
		const body = endlessBody(new Uint8Array(1024), 1024 * 1024);
		const socket = recordingFetch(() => new Response(body.stream, { status: 500 }));
		const outcome = await settle(
			fetchGuardedText(TARGET, { maxBytes: 64 }, { lookup: TWO_ADDRESSES, fetch: socket.fetch }),
		);
		expectHttpStatus(outcome.error, 500);
		expect(body.state.cancelled).toBe(true);
		expect(body.state.pulled, 'an error page is not read').toBeLessThanOrEqual(64 * 1024);
	});
});

describe('fetchBoundedText: the same ceiling, error-page, deadline and redirect rules (loopback peer, no seam)', () => {
	// A second listener: where the redirect points. It counts every request it gets.
	const target = { hits: 0 };
	const redirectTarget = Bun.serve({
		port: 0,
		hostname: '127.0.0.1',
		fetch: () => {
			target.hits += 1;
			return new Response('followed');
		},
	});
	// Requests that are accepted and never answered (a wedged sidecar), released in afterAll.
	const parked: ((response: Response) => void)[] = [];
	const server = Bun.serve({
		port: 0,
		hostname: '127.0.0.1',
		fetch: (request) => {
			const path = new URL(request.url).pathname;
			if (path === '/parked') return new Promise<Response>((resolve) => parked.push(resolve));
			if (path === '/redirect') {
				const location = `http://127.0.0.1:${redirectTarget.port}/second`;
				return new Response(null, { status: 302, headers: { location } });
			}
			if (path === '/big') return new Response(new Uint8Array(64));
			if (path === '/huge') return new Response(new Uint8Array(30 * 1024 * 1024));
			if (path === '/error-page') return new Response(new Uint8Array(4096), { status: 500 });
			// Headers and a first chunk now (Bun.serve flushes headers with the first
			// chunk), the rest never: the error page that stalls.
			const stalled = new ReadableStream<Uint8Array>({
				start: (controller) => controller.enqueue(new TextEncoder().encode('<html>')),
				pull: () => new Promise<void>(() => {}),
			});
			return new Response(stalled, { status: 503 });
		},
	});
	afterAll(async () => {
		for (const answer of parked.splice(0)) answer(new Response('late'));
		await server.stop(true);
		await redirectTarget.stop(true);
	});
	const at = (path: string): string => `http://127.0.0.1:${server.port}${path}`;

	test('a 3xx is refused, typed, and its Location is never contacted', async () => {
		const outcome = await settle(fetchBoundedText(at('/redirect')));
		expect(outcome.body, 'a redirect is not an answer').toBeUndefined();
		expect(describeError(outcome.error)).toStartWith('security.outbound_failed');
		// The on-premise sidecar runs under the private-host exemption: a followed 302
		// to 169.254.169.254 would escape the caller's address policy entirely.
		expect(target.hits, 'the redirect target was reached').toBe(0);
	});

	test('a closed port is a typed transport failure at the connect stage, not a raw Bun error', async () => {
		const closed = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('') });
		const port = closed.port;
		await closed.stop(true);
		const outcome = await settle(fetchBoundedText(`http://127.0.0.1:${port}/transcribe`));
		expect(describeError(outcome.error)).toStartWith('security.outbound_failed');
		expect((outcome.error as DedaloError).coordinates).toMatchObject({
			reason: 'transport',
			stage: 'connect',
		});
	});

	test("a wedged peer ends at the caller's timeoutMs, not the default", async () => {
		const startedAt = performance.now();
		const outcome = await settle(fetchBoundedText(at('/parked'), { timeoutMs: 80 }));
		const elapsed = performance.now() - startedAt;
		expect((outcome.error as DedaloError).coordinates).toMatchObject({ reason: 'timeout' });
		expect(elapsed).toBeGreaterThanOrEqual(70);
		expect(elapsed, "the caller's timeoutMs is the deadline").toBeLessThan(2000);
	});

	test("a wedged peer is released by the running job's stop, typed aborted", async () => {
		const job = new AbortController();
		const startedAt = performance.now();
		const call = runWithJobSignal(job.signal, () =>
			settle(fetchBoundedText(at('/parked'), { timeoutMs: 20_000 })),
		);
		setTimeout(() => job.abort(), 50);
		const outcome = await call;
		const elapsed = performance.now() - startedAt;
		expect((outcome.error as DedaloError).coordinates).toMatchObject({ reason: 'aborted' });
		expect(elapsed, 'the job signal reaches the connect').toBeLessThan(2000);
	});

	test('with no timeoutMs the DEFAULT deadline (15 s) ends a wedged peer — at 15 s, not before', async () => {
		jest.useFakeTimers();
		try {
			const call = observe(fetchBoundedText(at('/parked')));
			jest.advanceTimersByTime(DEFAULT_DEADLINE_MS - 1);
			await flushMicrotasks();
			expect(call.settled, 'nothing ends the call before the default deadline').toBe(false);
			jest.advanceTimersByTime(1);
			const outcome = await call.outcome;
			expect((outcome.error as DedaloError).coordinates).toMatchObject({ reason: 'timeout' });
		} finally {
			jest.useRealTimers();
		}
	});

	test("a caller's maxBytes ends the read as body_cap", async () => {
		const outcome = await settle(fetchBoundedText(at('/big'), { maxBytes: 8 }));
		expectBodyCap(outcome.error, 8);
	});

	test('with no maxBytes the DEFAULT ceiling (25 MiB) ends a 30 MiB body', async () => {
		const outcome = await settle(fetchBoundedText(at('/huge')));
		expectBodyCap(outcome.error, 25 * 1024 * 1024);
	});

	test('a 503 whose body never ends is HTTP 503, not a timeout', async () => {
		const startedAt = Date.now();
		const outcome = await settle(fetchBoundedText(at('/stall'), { timeoutMs: 3000 }));
		expectHttpStatus(outcome.error, 503);
		expect(Date.now() - startedAt).toBeLessThan(2500);
	});

	test('a 500 whose body is over maxBytes is HTTP 500, not body_cap', async () => {
		const outcome = await settle(fetchBoundedText(at('/error-page'), { maxBytes: 64 }));
		expectHttpStatus(outcome.error, 500);
	});
});
