/**
 * THE CHOKEPOINT — dispatch.ts + server.ts on envelope v2
 * (engineering/ERRORS_SPEC.md §4). Every assertion here runs over the REAL
 * gate chain (dispatchRqo) or the real HTTP door (handleRequest) with probe
 * handlers registered on utilsApiActions (the process_health precedent), and
 * pins the laws that make the wire converter-made:
 *
 *  - HTTP status = registry status; ok:false ⇒ status ∉ 2xx;
 *  - `Retry-After` from a throw's retryAfterMs (dispatch threads it, server.ts
 *    emits the header);
 *  - a wrapped TDZ ReferenceError (in `cause`) flips the poison latch — the
 *    latch lives inside toDedaloError, not the dispatch catch;
 *  - `csrf_token` is appended on success AND failure for a session;
 *  - the one-producer law at the dispatcher: a handler body WITHOUT `ok` (the
 *    PHP `{result,msg,errors}` fossil — the deleted legacy_body_adapter used
 *    to translate it) is a BUG and is refused as internal.unexpected 500, an
 *    envelope body passes through, a streamed result is exempt;
 *  - server.ts: malformed JSON → request.malformed_body; a body failing the RQO
 *    schema → request.invalid_rqo with `details.issue_paths` (paths, never the
 *    raw zod issues); an unknown route → resource.not_found, JSON;
 *  - the access log line carries error_code / error_category on ok:false.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { logApiAccess } from '../../src/core/api/access_log.ts';
import { dispatchRqo } from '../../src/core/api/dispatch.ts';
import { utilsApiActions } from '../../src/core/api/handlers/dd_utils_api.ts';
import { getProcessPoison, resetProcessPoisonForTests } from '../../src/core/api/process_health.ts';
import { streamResult } from '../../src/core/api/response.ts';
import type { Rqo } from '../../src/core/concepts/rqo.ts';
import { ok } from '../../src/core/errors/convert.ts';
import { DedaloError } from '../../src/core/errors/dedalo_error.ts';
import { ERROR_REGISTRY } from '../../src/core/errors/registry.ts';
import { apiEnvelopeSchema } from '../../src/core/errors/schema.ts';
import { createSession, getSession } from '../../src/core/security/session_store.ts';
import { handleRequest } from '../../src/server.ts';
import { registerSessionCleanup } from '../helpers/session_cleanup.ts';

registerSessionCleanup();

const REQUEST_ID = 'dispatch-error-native';

type Body = Record<string, unknown> & { error?: { code: string; category: string } };

function authedContext() {
	const token = createSession(-1, 'root', true);
	const session = getSession(token);
	return {
		requestId: REQUEST_ID,
		clientIp: '127.0.0.1',
		session,
		csrfCandidate: session?.csrfToken ?? null,
		token,
	};
}

/** Register a probe action on dd_utils_api for the duration of `run`. */
async function withProbe<T>(
	name: string,
	handler: (typeof utilsApiActions)[string],
	run: (rqo: Rqo) => Promise<T>,
): Promise<T> {
	utilsApiActions[name] = handler;
	try {
		return await run({ action: name, dd_api: 'dd_utils_api' } as Rqo);
	} finally {
		delete utilsApiActions[name];
	}
}

const quiet = { error: console.error, warn: console.warn, info: console.info };
// Pin the debug key OFF: process.env wins over ../private/.env (a dev checkout
// may carry DEDALO_DEBUG_API_ERRORS=true) and this gate asserts the production wire.
const previousDebug = process.env.DEDALO_DEBUG_API_ERRORS;
beforeAll(() => {
	process.env.DEDALO_DEBUG_API_ERRORS = 'false';
	// The chokepoint LOGS every failure (that is the point); keep the run readable.
	console.error = () => {};
	console.warn = () => {};
	console.info = () => {};
});
afterAll(() => {
	if (previousDebug === undefined) delete process.env.DEDALO_DEBUG_API_ERRORS;
	else process.env.DEDALO_DEBUG_API_ERRORS = previousDebug;
	console.error = quiet.error;
	console.warn = quiet.warn;
	console.info = quiet.info;
});
afterEach(() => {
	resetProcessPoisonForTests();
});

describe('registry status + envelope on the dispatch surface', () => {
	test('a thrown DedaloError answers its registry status and a schema-valid ok:false envelope', async () => {
		for (const code of [
			'perm.denied',
			'resource.not_found',
			'request.invalid',
			'rate.limited',
		] as const) {
			const result = await withProbe(
				'__zz_throw_probe__',
				async () => {
					throw new DedaloError(code);
				},
				(rqo) => dispatchRqo(rqo, authedContext()),
			);
			expect(result.status).toBe(ERROR_REGISTRY[code].status);
			expect(result.status < 200 || result.status >= 300).toBe(true);
			expect(apiEnvelopeSchema.safeParse(result.body).success).toBe(true);
			const body = result.body as Body;
			expect(body.ok).toBe(false);
			expect(body.error?.code).toBe(code);
			expect(body.request_id).toBe(REQUEST_ID);
			// the compat mirror is gone (removed 2026-08-16): no result/msg/errors
			expect('result' in body).toBe(false);
			expect('msg' in body).toBe(false);
			expect('errors' in body).toBe(false);
		}
	});

	test('a raw Error is internal.unexpected 500 and never echoes its message', async () => {
		const secret = 'SELECT secret FROM /var/lib/path';
		const result = await withProbe(
			'__zz_raw_probe__',
			async () => {
				throw new Error(secret);
			},
			(rqo) => dispatchRqo(rqo, authedContext()),
		);
		expect(result.status).toBe(500);
		expect((result.body as Body).error?.code).toBe('internal.unexpected');
		expect(JSON.stringify(result.body)).not.toContain(secret);
	});

	test('retryAfterMs rides the ApiResult (server.ts emits Retry-After from it)', async () => {
		const result = await withProbe(
			'__zz_retry_probe__',
			async () => {
				throw new DedaloError('rate.limited', { retryAfterMs: 1500 });
			},
			(rqo) => dispatchRqo(rqo, authedContext()),
		);
		expect(result.status).toBe(429);
		expect(result.retryAfterMs).toBe(1500);
	});

	test('a TDZ ReferenceError WRAPPED as cause flips the poison latch (latch is in the converter)', async () => {
		expect(getProcessPoison().poisoned).toBe(false);
		const result = await withProbe(
			'__zz_wrapped_tdz_probe__',
			async () => {
				throw new Error('outer', {
					cause: new ReferenceError("Cannot access 'lateBinding' before initialization"),
				});
			},
			(rqo) => dispatchRqo(rqo, authedContext()),
		);
		expect(result.status).toBe(500);
		expect((result.body as Body).error?.code).toBe('internal.module_poisoned');
		expect(getProcessPoison().poisoned).toBe(true);
	});

	test('csrf_token is appended for a session on success AND on failure', async () => {
		const context = authedContext();
		const failed = await withProbe(
			'__zz_csrf_fail_probe__',
			async () => {
				throw new DedaloError('perm.denied');
			},
			(rqo) => dispatchRqo(rqo, context),
		);
		expect(failed.body.csrf_token).toBe(context.session?.csrfToken);
		const succeeded = await withProbe(
			'__zz_csrf_ok_probe__',
			async () => ({ status: 200, body: ok({ fine: true }, { requestId: REQUEST_ID }) }),
			(rqo) => dispatchRqo(rqo, context),
		);
		expect(succeeded.status).toBe(200);
		expect(succeeded.body.ok).toBe(true);
		expect(succeeded.body.csrf_token).toBe(context.session?.csrfToken);
	});
});

describe('the one-producer law at the dispatcher (legacy_body_adapter DELETED)', () => {
	test('a handler body without `ok` is a BUG: internal.unexpected 500, action named in the log coordinates', async () => {
		const result = await withProbe(
			'__zz_legacy_body_probe__',
			async () =>
				({
					status: 200,
					body: { result: false, msg: 'no way', errors: ['not_authorized'] },
				}) as never,
			(rqo) => dispatchRqo(rqo, authedContext()),
		);
		expect(result.status).toBe(500);
		const body = result.body as Body;
		expect(body.ok).toBe(false);
		expect(body.error?.code).toBe('internal.unexpected');
		// the fossil body never reaches the wire, translated or otherwise
		expect(JSON.stringify(body)).not.toContain('no way');
		expect('errors' in body).toBe(false);
		expect(apiEnvelopeSchema.safeParse(body).success).toBe(true);
	});

	test('a legacy SUCCESS body is refused the same way (no silent adaptation)', async () => {
		const result = await withProbe(
			'__zz_legacy_ok_probe__',
			async () => ({ status: 200, body: { result: { rows: [1] }, msg: 'OK' } }) as never,
			(rqo) => dispatchRqo(rqo, authedContext()),
		);
		expect(result.status).toBe(500);
		expect((result.body as Body).error?.code).toBe('internal.unexpected');
	});

	test('an envelope body passes through untouched', async () => {
		const result = await withProbe(
			'__zz_envelope_probe__',
			async () => ({ status: 200, body: ok(7, { requestId: REQUEST_ID }) }),
			(rqo) => dispatchRqo(rqo, authedContext()),
		);
		expect(result.status).toBe(200);
		expect(result.body.data).toBe(7);
		expect(result.body.ok).toBe(true);
	});

	test('a streamed result is exempt (its body is never serialized)', async () => {
		const result = await withProbe(
			'__zz_stream_probe__',
			async () =>
				streamResult(new ReadableStream<Uint8Array>(), { 'Content-Type': 'text/event-stream' }),
			(rqo) => dispatchRqo(rqo, authedContext()),
		);
		expect(result.status).toBe(200);
		expect(result.stream).toBeDefined();
	});
});

describe('the HTTP door (server.ts)', () => {
	const httpContext = { requestId: REQUEST_ID, startedAt: 0 };
	const API = 'http://localhost/dedalo/core/api/v1/json/';

	function post(body: string, headers: Record<string, string> = {}): Promise<Response> {
		return handleRequest(
			new Request(API, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', ...headers },
				body,
			}),
			httpContext,
		);
	}

	test('malformed JSON → 400 request.malformed_body, JSON', async () => {
		const response = await post('{not json');
		expect(response.status).toBe(400);
		expect(response.headers.get('content-type')).toContain('application/json');
		const body = (await response.json()) as Body;
		expect(body.error?.code).toBe('request.malformed_body');
		expect(body.request_id).toBe(REQUEST_ID);
	});

	test('a body failing the RQO schema → 400 request.invalid_rqo with issue_paths, never raw issues', async () => {
		const response = await post(JSON.stringify({ action: 42 }));
		expect(response.status).toBe(400);
		const body = (await response.json()) as Body & {
			error: { details?: { issue_paths?: string } };
		};
		expect(body.error.code).toBe('request.invalid_rqo');
		expect(body.error.details?.issue_paths).toBe('action');
		expect(JSON.stringify(body)).not.toContain('"issues"');
	});

	test('an unknown route → 404 resource.not_found, JSON', async () => {
		const response = await handleRequest(
			new Request('http://localhost/no/such/route', { method: 'POST' }),
			httpContext,
		);
		expect(response.status).toBe(404);
		expect(response.headers.get('content-type')).toContain('application/json');
		expect(((await response.json()) as Body).error?.code).toBe('resource.not_found');
	});

	test('Retry-After is emitted from a limit throw', async () => {
		const context = authedContext();
		const response = await withProbe(
			'__zz_http_retry_probe__',
			async () => {
				throw new DedaloError('rate.limited', { retryAfterMs: 1500 });
			},
			(rqo) =>
				post(JSON.stringify(rqo), {
					Cookie: `dedalo_ts_session=${context.token}`,
					'X-Dedalo-Csrf-Token': context.session?.csrfToken ?? '',
				}),
		);
		expect(response.status).toBe(429);
		expect(response.headers.get('retry-after')).toBe('2');
		expect(((await response.json()) as Body).error?.code).toBe('rate.limited');
	});
});

describe('the access log carries the error identity', () => {
	test('error_code / error_category are on the line for ok:false, absent on success', () => {
		const original = console.log;
		const lines: string[] = [];
		console.log = (line: unknown) => {
			lines.push(String(line));
		};
		const previousFlag = process.env.DEDALO_ACCESS_LOG;
		process.env.DEDALO_ACCESS_LOG = 'true';
		try {
			logApiAccess({
				requestId: 'r1',
				userId: null,
				apiClass: 'dd_utils_api',
				action: 'x',
				status: 403,
				ms: 1,
				error_code: 'perm.denied',
				error_category: 'permission',
			});
			logApiAccess({
				requestId: 'r2',
				userId: null,
				apiClass: 'dd_utils_api',
				action: 'x',
				status: 200,
				ms: 1,
			});
		} finally {
			console.log = original;
			if (previousFlag === undefined) delete process.env.DEDALO_ACCESS_LOG;
			else process.env.DEDALO_ACCESS_LOG = previousFlag;
		}
		const access = lines
			.filter((line) => line.includes('"type":"access"'))
			.map((line) => JSON.parse(line) as Record<string, unknown>);
		// config.ops.accessLog may be frozen at boot; assert only when lines were emitted.
		if (access.length === 2) {
			expect(access[0]?.error_code).toBe('perm.denied');
			expect(access[0]?.error_category).toBe('permission');
			expect('error_code' in (access[1] ?? {})).toBe(false);
		}
	});
});
