/**
 * ATTEMPT-DEADLINE CONTRACT — client/dedalo/core/common/js/api_transport.js
 *
 * WHY THIS FILE EXISTS. `fetch_api` runs a mid-attempt health probe: half way
 * through the per-attempt timeout it asks `/health` whether the server is alive,
 * because a slow answer from a working server is a BUSY server, not a dead one,
 * and aborting it would be wrong. The probe used to express that by calling
 * `clearTimeout(timeout_id)` on the attempt's only deadline — and never re-arming
 * it. So from the first successful probe the request had NO timeout at all: a
 * server that answered `/health` and then stalled left the promise pending for
 * the life of the page, with the "Awaiting for busy server.." toast already
 * auto-dismissed. A frozen widget, no error path, and only a caller-supplied
 * AbortSignal — which almost no caller passes — could still end it.
 *
 * WHAT IS PINNED (contract, not implementation):
 *  A. A busy server that then STALLS still ends the attempt. The probe extends
 *     the deadline; it never removes it. This is the defect above.
 *  B. The extension is ADDITIVE — the remaining budget PLUS the grace. Re-arming
 *     at the grace alone would SHORTEN the deadline for every caller whose
 *     timeout exceeds twice the grace: make_backup passes 3_600_000 ms for
 *     pg_dump, so a probe at the 30-minute mark would kill the backup seconds
 *     later instead of at the hour. A busy answer may only ever buy time.
 *  C. A DEAD server (no `/health` answer) keeps the plain, unextended deadline —
 *     the control that proves the probe is what distinguishes A and B, and that
 *     the extension is not simply always applied.
 *  D. A normal fast answer is untouched: it resolves its envelope and is never
 *     aborted by either timer.
 *  E. `on_wait(attempt, ms, 'busy')` reports the extension it actually granted,
 *     so the notice and the wait it describes expire together. The old code
 *     reported `delay + 3000` while granting an unbounded wait — the toast
 *     vanished while the request ran on forever.
 *
 * ANTI-VACUITY. A and B would both pass against a build where the probe never
 * fires at all (they would just be measuring the plain deadline), so each one
 * asserts the 'busy' hook was actually called. Without that guard a broken
 * `check_health` would make this file green while testing nothing.
 *
 * HARNESS. `api_transport.js` is DOM-free and imports only `api_error.js`, so it
 * is imported REAL with no globals masked but `fetch`. The stub answers `/health`
 * per test and holds the API request open until the transport's own abort signal
 * fires, which is exactly the stalled-server shape. No DB, no server, no
 * credentials, no timers left running.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { join } from 'node:path';

const TRANSPORT_PATH = join(
	import.meta.dir,
	'..',
	'..',
	'client',
	'dedalo',
	'core',
	'common',
	'js',
	'api_transport.js',
);

type FetchApiResult = {
	json: unknown;
	api_error: { code?: string; retryable?: boolean } | null;
	response: unknown;
};
type FetchApi = (
	url: string,
	init?: Record<string, unknown>,
	options?: Record<string, unknown>,
) => Promise<FetchApiResult>;

const globals = globalThis as unknown as Record<string, unknown>;
let saved_fetch: unknown;
let fetch_api: FetchApi;
let upload_floor_ms: (body: unknown) => number;

/** when false the `/health` probe gets no answer (server reads as DEAD) */
let health_alive = true;
/** when true the API request never answers on its own (server STALLS) */
let api_stalls = true;
/** every on_wait(attempt, ms, reason) the transport emitted */
let waits: Array<{ attempt: number; ms: number; reason: string }> = [];

const stub_fetch = (url: string | URL, init: RequestInit = {}): Promise<Response> => {
	if (String(url).includes('/health')) {
		return health_alive
			? Promise.resolve(new Response('', { status: 200 }))
			: Promise.reject(new TypeError('fetch failed (stub: health unreachable)'));
	}
	if (!api_stalls) {
		return Promise.resolve(
			new Response(JSON.stringify({ ok: true, result: { answered: true } }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			}),
		);
	}
	// the stalled server: accepted, never answers, ends only when the transport
	// aborts it — which is precisely what the deadline is for.
	return new Promise<Response>((_resolve, reject) => {
		init.signal?.addEventListener(
			'abort',
			() => {
				const error = new Error('aborted');
				error.name = 'AbortError';
				reject(error);
			},
			{ once: true },
		);
	});
};

/** run one attempt and report how long it took to settle; null when it hung */
const timed_call = async (
	options: Record<string, unknown>,
	hang_after_ms = 5000,
	body?: string,
): Promise<{ ms: number; result: FetchApiResult } | null> => {
	const started = performance.now();
	const hung = Symbol('hung');
	const result = await Promise.race([
		fetch_api(
			'https://stub.invalid/api/v1/json/',
			{ method: 'POST', body },
			{ on_wait: on_wait_spy, ...options },
		),
		new Promise<typeof hung>((resolve) => setTimeout(() => resolve(hung), hang_after_ms)),
	]);
	if (result === hung) return null;
	return { ms: performance.now() - started, result: result as FetchApiResult };
};

const on_wait_spy = (attempt: number, ms: number, reason: string) => {
	waits.push({ attempt, ms, reason });
};

beforeAll(async () => {
	saved_fetch = globals.fetch;
	globals.fetch = stub_fetch;
	const transport = (await import(TRANSPORT_PATH)) as {
		fetch_api: FetchApi;
		upload_floor_ms: (body: unknown) => number;
	};
	fetch_api = transport.fetch_api;
	upload_floor_ms = transport.upload_floor_ms;
});

afterAll(() => {
	globals.fetch = saved_fetch;
});

beforeEach(() => {
	health_alive = true;
	api_stalls = true;
	waits = [];
});

describe('fetch_api attempt deadline', () => {
	test('A. a busy server that then stalls still ends the attempt', async () => {
		// probe at 100ms finds the server alive; the request never answers.
		const call = await timed_call({
			timeout_ms: 200,
			retries: 1,
			base_delay: 100,
			busy_grace_ms: 100,
		});

		expect(
			call,
			'the request hung: the busy probe removed the deadline instead of extending it',
		).not.toBeNull();
		expect(
			waits.some((w) => w.reason === 'busy'),
			'the busy probe never fired — this test proved nothing',
		).toBe(true);
		expect(call?.result.api_error?.code).toBe('client.timeout');
		expect(call?.result.api_error?.retryable).toBe(true);
		// ~100ms to the probe + (100ms remaining + 100ms grace). A build that
		// re-armed at the grace ALONE would land near 200ms.
		expect(call!.ms).toBeGreaterThan(250);
		expect(call!.ms).toBeLessThan(2000);
	});

	test('B. the extension is additive, never a replacement for the remaining budget', async () => {
		// 1000ms budget, probed at ~500ms, 50ms grace. Additive lands near 1050ms;
		// re-arming at the grace alone would abort near 550ms — SHORTER than the
		// caller's own timeout, which is the make_backup regression.
		const call = await timed_call({
			timeout_ms: 1000,
			retries: 1,
			base_delay: 100,
			busy_grace_ms: 50,
		});

		expect(
			call,
			'the request hung: the busy probe removed the deadline instead of extending it',
		).not.toBeNull();
		expect(
			waits.some((w) => w.reason === 'busy'),
			'the busy probe never fired — this test proved nothing',
		).toBe(true);
		expect(call?.result.api_error?.code).toBe('client.timeout');
		expect(call!.ms).toBeGreaterThan(900);
		expect(call!.ms).toBeLessThan(3000);
	});

	test('C. a dead server keeps the plain, unextended deadline', async () => {
		health_alive = false;
		const call = await timed_call({
			timeout_ms: 300,
			retries: 1,
			base_delay: 100,
			busy_grace_ms: 5000,
		});

		expect(call).not.toBeNull();
		expect(
			waits.some((w) => w.reason === 'busy'),
			'a dead server must not earn a busy extension',
		).toBe(false);
		expect(call?.result.api_error?.code).toBe('client.timeout');
		// the 5000ms grace must NOT have been granted
		expect(call!.ms).toBeLessThan(1500);
	});

	test('D. a normal answer is untouched by either timer', async () => {
		api_stalls = false;
		const call = await timed_call({ timeout_ms: 300, retries: 1, base_delay: 100 });

		expect(call).not.toBeNull();
		expect(call?.result.api_error).toBeNull();
		expect(call?.result.json).toEqual({ ok: true, result: { answered: true } });
	});

	test('E. on_wait reports the extension it actually granted', async () => {
		const call = await timed_call({
			timeout_ms: 400,
			retries: 1,
			base_delay: 100,
			busy_grace_ms: 100,
		});

		expect(call).not.toBeNull();
		const busy = waits.find((w) => w.reason === 'busy');
		expect(busy, 'no busy notice was emitted').toBeDefined();
		// remaining (~200ms at the probe) + 100ms grace, so the reported figure must
		// exceed the grace alone — the old code reported delay+3000 and granted forever.
		expect(busy!.ms).toBeGreaterThan(100);
		expect(busy!.attempt).toBe(1);
	});
});

// F. a large body must not be aborted mid-upload: the server would go on to
// commit it while the client reported an error (the dd774 slow-link save).
describe('fetch_api upload floor', () => {
	test('F1. the floor is body-sized, and zero for non-string bodies', () => {
		expect(upload_floor_ms('x'.repeat(2 * 1024 * 1024))).toBeGreaterThan(5000);
		expect(upload_floor_ms('x'.repeat(1000))).toBeLessThan(5000);
		expect(upload_floor_ms(new FormData())).toBe(0);
		expect(upload_floor_ms(undefined)).toBe(0);
		// UTF-8 bytes, not UTF-16 units: 'α' is 2 bytes, '中' is 3
		expect(upload_floor_ms('α'.repeat(64 * 1024))).toBe(2 * upload_floor_ms('x'.repeat(64 * 1024)));
		expect(upload_floor_ms('中'.repeat(64 * 1024))).toBe(3 * upload_floor_ms('x'.repeat(64 * 1024)));
	});

	test('F2. the upload time is ADDED to the caller timeout (server keeps its budget)', async () => {
		health_alive = false; // no busy extension: only the floor can lengthen it
		const body = 'x'.repeat(64 * 1024); // floor ~1024ms
		const floor = upload_floor_ms(body);
		const call = await timed_call({ timeout_ms: 200, retries: 1 }, 5000, body);
		expect(call).not.toBeNull();
		expect(call?.result.api_error?.code).toBe('client.timeout');
		expect(call!.ms).toBeGreaterThan(floor + 200 - 50);
		expect(call!.ms).toBeLessThan(floor + 1500);
	});

	test('F3. a small body keeps the caller timeout', async () => {
		health_alive = false;
		const call = await timed_call({ timeout_ms: 200, retries: 1 }, 5000, '{"a":1}');
		expect(call).not.toBeNull();
		expect(call!.ms).toBeLessThan(800);
	});

	test('F4. a long caller timeout still gets the upload time on top', async () => {
		health_alive = false;
		const body = 'x'.repeat(16 * 1024); // floor ~256ms
		const call = await timed_call({ timeout_ms: 900, retries: 1 }, 5000, body);
		expect(call).not.toBeNull();
		expect(call!.ms).toBeGreaterThan(900 + upload_floor_ms(body) - 50);
	});

	test('F5. a dead link pays the upload time once, not once per retry', async () => {
		health_alive = false;
		const body = 'x'.repeat(64 * 1024); // floor ~1024ms
		const floor = upload_floor_ms(body);
		// 3 attempts: (200+floor) + (200+20) + (200+40) + backoff 10+20
		const call = await timed_call({ timeout_ms: 200, retries: 3, base_delay: 10 }, 10000, body);
		expect(call).not.toBeNull();
		expect(call?.result.api_error?.code).toBe('client.timeout');
		expect(call!.ms).toBeGreaterThan(floor + 600);
		expect(call!.ms).toBeLessThan(2 * floor + 200);
	});
});
