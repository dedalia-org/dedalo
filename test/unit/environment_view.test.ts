/**
 * Environment diagnostic view — the dedicated, session-gated GET endpoint
 * (developer tool, core/api/environment_view.ts). Replaces the PHP menu link to
 * core/common/js/environment.js.php (which the TS server can't run). Verifies:
 *   - unauthenticated            → 404 (fail-closed, no existence leak);
 *   - authenticated              → 200, pretty JSON, == the buildEnvironment payload.
 *
 * The session gate runs without Postgres (superuser resolves in-memory); the 200
 * case exercises buildEnvironment (labels / page_globals) and NEEDS the suite
 * database — the unit tier always has one, so its absence is RED, never a silent
 * pass (it used to `return` before asserting).
 *
 * THE PAYLOAD SAMPLES THE PROCESS: `php_memory` / `memory` are
 * `process.memoryUsage().rss` rounded to MiB, read once per build — and the two
 * builds compared here are two reads. Under load (a CI host, a full-suite run) the
 * RSS moves between them, so those values are compared by SHAPE (`<n>M rss`) and
 * everything else byte-for-byte.
 */

import { beforeAll, describe, expect, test } from 'bun:test';
import { sql } from '../../src/core/db/postgres.ts';
import { buildEnvironment } from '../../src/core/resolve/environment.ts';
import { resolvePrincipal } from '../../src/core/security/permissions.ts';
import { createSession, getSession } from '../../src/core/security/session_store.ts';
import { handleRequest } from '../../src/server.ts';

const context = { requestId: 'env-view-test', startedAt: 0 };
const ENV_URL = '/dedalo/core/api/v1/environment';

function envRequest(sessionToken?: string): Request {
	return new Request(`http://localhost${ENV_URL}`, {
		headers: sessionToken !== undefined ? { Cookie: `dedalo_ts_session=${sessionToken}` } : {},
	});
}

let dbReady = false;
beforeAll(async () => {
	try {
		await sql`SELECT 1`;
		dbReady = true;
	} catch {
		dbReady = false; // asserted RED in the payload case, never skipped
	}
});

/** A process-memory sample, as buildEnvironment formats it. */
const RSS_SAMPLE = /^\d+M rss$/;

/** Every RSS sample replaced by its shape — the rest of the payload is untouched. */
function normaliseRss(value: unknown): unknown {
	if (typeof value === 'string') return RSS_SAMPLE.test(value) ? '<n>M rss' : value;
	if (Array.isArray(value)) return value.map(normaliseRss);
	if (value !== null && typeof value === 'object') {
		return Object.fromEntries(
			Object.entries(value).map(([k, v]) => [
				k,
				k === COUNTDOWN_KEY && typeof v === 'number' ? '<seconds left>' : normaliseRss(v),
			]),
		);
	}
	return value;
}

/** A live countdown (whole seconds to the session's absolute cap): two reads a second apart differ by one. */
const COUNTDOWN_KEY = 'dedalo_session_absolute_expires_in';

/** Every value of `key` anywhere in `value`. */
function valuesOf(value: unknown, key: string): unknown[] {
	if (Array.isArray(value)) return value.flatMap((item) => valuesOf(item, key));
	if (value === null || typeof value !== 'object') return [];
	return Object.entries(value).flatMap(([k, v]) => (k === key ? [v] : valuesOf(v, key)));
}

describe('environment diagnostic view (dedicated GET, session-gated)', () => {
	test('no session → 404 (endpoint not revealed)', async () => {
		const response = await handleRequest(envRequest(), context);
		expect(response.status).toBe(404);
	});

	test('authenticated → 200 pretty JSON == buildEnvironment payload', async () => {
		expect(dbReady, 'the suite database is unreachable — the unit tier always has one').toBe(true);
		const token = createSession(-1, 'root', true);
		const response = await handleRequest(envRequest(token), context);
		expect(response.status).toBe(200);

		const rawText = await response.text();
		expect(rawText).toContain('\n  '); // pretty-printed (2-space indent)
		const body = JSON.parse(rawText) as { result?: Record<string, unknown> };
		expect(body.result).toBeDefined();
		for (const key of ['page_globals', 'plain_vars']) {
			expect(body.result?.[key]).toBeDefined();
		}
		// WC-2026-11-07-labels-separate-resource: labels are their own resource.
		expect(body.result).not.toHaveProperty('get_label');

		// Same payload the boot-time get_environment returns to this user.
		const session = getSession(token);
		const principal = await resolvePrincipal(-1);
		const expected = await buildEnvironment(session, principal);
		// The payload DOES carry an RSS sample (else the normalisation hides nothing and
		// proves nothing) — and only the sample is normalised.
		expect(JSON.stringify(body)).toMatch(/"\d+M rss"/);
		// The countdown is compared within the second the two reads may straddle.
		const served = valuesOf(body, COUNTDOWN_KEY);
		const built = valuesOf(expected, COUNTDOWN_KEY);
		expect(served.length).toBeGreaterThan(0);
		expect(served.length).toBe(built.length);
		served.forEach((seconds, index) => {
			expect(typeof seconds).toBe('number');
			expect(Math.abs((seconds as number) - (built[index] as number))).toBeLessThanOrEqual(1);
		});
		expect(normaliseRss(body)).toEqual(normaliseRss(expected));
	});
});
