/**
 * CLIENT OUTCOME-UNKNOWN NATIVE GATE — the client's "the server does not know
 * whether it ran" verdict (`error_dispatch.js outcome_unknown`) is measured
 * against the answers the REAL server gives, not against a list of spellings.
 *
 * WHY (cross-client review r3, 2026-10). `outcome_unknown()` is what keeps a
 * non-idempotent control DISABLED (move_transform's Run, the acquisition tools'
 * Confirm): an unknown outcome must not re-arm, because the operator's next
 * click mints a NEW idempotency key and the server executes the work a SECOND
 * time beside the first. The client decides it from the server's error code
 * (OUTCOME_UNKNOWN_CODES). Nothing tied that set to the server: rename or
 * retire one of the idempotency codes and the server ships the new spelling,
 * `outcome_unknown()` answers false, the answer reads as a known REFUSAL and
 * the control re-arms — while error_taxonomy_tripwire C2 (which scans only
 * error_policy.js + `new ApiError({code})` sites) and the Mocha cases (which
 * repeat the same literals) stay green.
 *
 * WHAT IS MEASURED. Each of the server's three "outcome unknown" situations is
 * BUILT through the real door — `dispatchRqo` (Gate 4, the idempotency ledger)
 * on the generic `test` TLD, with the handler replaced by a probe that never
 * writes — and the wire body it answers is handed to the client's OWN code
 * (`api_error.js normalize_api_error` → `error_dispatch.js outcome_unknown`,
 * their shipped bytes):
 *  - a twin of a leader that THREW              → must read UNKNOWN;
 *  - a twin of a leader whose answer could not be kept (an oversized body)
 *                                               → must read UNKNOWN;
 *  - a twin of a leader still RUNNING past the real production bound
 *                                               → must read UNKNOWN;
 * and the CONTROL that makes the verdict mean something: a known server
 * refusal from the same gate (the same key with a different request) must read
 * KNOWN. Every verdict is taken on a real `ApiError` with `transport:false`, so
 * the "not an ApiError ⇒ unknown" fallback cannot satisfy the gate by accident.
 *
 * Whatever the server's codes are called, this gate goes red the moment the
 * client stops recognising one of these situations — the outcome, not a
 * spelling.
 *
 * TIER: DB (the real dispatcher resolves the root principal). Writes nothing:
 * every probe handler answers without touching the database; the session store
 * is the suite's scratch one (registerSessionCleanup).
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	actionTableFor,
	dispatchRqo,
	idempotencyLedgerStats,
	resetIdempotencyLedgerForTests,
} from '../../src/core/api/dispatch.ts';
import type { ApiRequestContext } from '../../src/core/api/handler_context.ts';
import type { ApiResult } from '../../src/core/api/response.ts';
import { type Rqo, rqoSchema } from '../../src/core/concepts/rqo.ts';
import { ok } from '../../src/core/errors/convert.ts';
import { resolvePrincipal } from '../../src/core/security/permissions.ts';
import { createSession, getSession } from '../../src/core/security/session_store.ts';
import { registerSessionCleanup } from '../helpers/session_cleanup.ts';

registerSessionCleanup();

const REPO_ROOT = join(import.meta.dir, '..', '..');
const REAL_CLIENT = 'client/dedalo/core/common/js';
const SECTION = 'testmint1';
const USER_ID = -1;

type ClientApiError = { code: string; transport: boolean };
let normalizeApiError: (
	response: { ok: boolean; status: number } | null,
	body: unknown,
) => ClientApiError | null;
let isApiError: (value: unknown) => boolean;
let outcomeUnknown: (error: unknown) => boolean;
let scratchRoot = '';

/**
 * The client's error modules are browser modules; `error_dispatch.js` reaches
 * the DOM only through `render_api_error.js`. The three modules under test are
 * copied VERBATIM (the shipped bytes) into a scratch tree, and only that DOM
 * leaf is a stub — no `mock.module`, so nothing leaks into other files.
 */
beforeAll(async () => {
	scratchRoot = mkdtempSync(join(tmpdir(), 'dd-outcome-'));
	const jsDir = join(scratchRoot, 'client', 'dedalo', 'core', 'common', 'js');
	mkdirSync(jsDir, { recursive: true });
	for (const name of ['error_dispatch.js', 'api_error.js', 'error_policy.js']) {
		cpSync(join(REPO_ROOT, REAL_CLIENT, name), join(jsDir, name));
	}
	writeFileSync(
		join(jsDir, 'render_api_error.js'),
		[
			"export const error_text = () => ''",
			'export const render_error_toast = () => {}',
			'export const render_error_inline = () => {}',
			'export const render_error_panel = () => {}',
			'export const render_error_modal = () => {}',
			"export const severity_type = () => 'error'",
			'',
		].join('\n'),
	);
	const apiError = await import(join(jsDir, 'api_error.js'));
	const dispatch = await import(join(jsDir, 'error_dispatch.js'));
	normalizeApiError = apiError.normalize_api_error;
	isApiError = apiError.is_api_error;
	outcomeUnknown = dispatch.outcome_unknown;
	resetIdempotencyLedgerForTests();
});

afterAll(() => {
	resetIdempotencyLedgerForTests();
	if (scratchRoot !== '') rmSync(scratchRoot, { recursive: true, force: true });
});

function context(): ApiRequestContext {
	const token = createSession(USER_ID, 'root', true);
	const session = getSession(token);
	return {
		requestId: `outcome-${crypto.randomUUID()}`,
		clientIp: '127.0.0.1',
		session,
		csrfCandidate: session?.csrfToken ?? null,
	} as ApiRequestContext;
}

/** A `dd_core_api:create` (a `mutating` action, so Gate 4 ledgers it) through the real parse door. */
function createRqo(key: string, variant = ''): Rqo {
	const rqo: Record<string, unknown> = {
		action: 'create',
		dd_api: 'dd_core_api',
		source: { model: 'section', tipo: SECTION, section_tipo: SECTION },
		idempotency_key: key,
	};
	if (variant !== '') rqo.options = { variant };
	return rqoSchema.parse(JSON.parse(JSON.stringify(rqo)));
}

async function dispatchAs(rqo: Rqo): Promise<ApiResult> {
	const ctx = context();
	ctx.principal = await resolvePrincipal(USER_ID);
	return dispatchRqo(rqo, ctx);
}

/**
 * Runs `scenario` with the create door replaced by `probe` — a handler that
 * never writes — and restores the real door whatever happens.
 */
async function withProbe<T>(
	probe: (calls: { count: number }) => Promise<ApiResult>,
	scenario: (calls: { count: number }) => Promise<T>,
): Promise<T> {
	const table = actionTableFor('dd_core_api');
	if (table === undefined) throw new Error('dd_core_api is not registered');
	const original = table.create;
	const calls = { count: 0 };
	resetIdempotencyLedgerForTests();
	table.create = async () => {
		calls.count++;
		return probe(calls);
	};
	try {
		return await scenario(calls);
	} finally {
		table.create = original as never;
		resetIdempotencyLedgerForTests();
	}
}

/** What the CLIENT makes of a server answer: its ApiError, as data_manager builds it. */
function clientErrorOf(result: ApiResult): ClientApiError {
	const response = { ok: result.status >= 200 && result.status < 300, status: result.status };
	const error = normalizeApiError(response, JSON.parse(JSON.stringify(result.body)));
	if (error === null)
		throw new Error(`the server answered a success: ${JSON.stringify(result.body)}`);
	// the verdict below must come from the CODE, never from the
	// "not an ApiError ⇒ unknown" fallback
	expect(isApiError(error)).toBe(true);
	expect(error.transport).toBe(false);
	return error;
}

const KEY_THREW = 'outcomegatekeyaaaaaaaaaaaaaaaaa1';
const KEY_HUGE = 'outcomegatekeybbbbbbbbbbbbbbbbb2';
const KEY_HELD = 'outcomegatekeyccccccccccccccccc3';
const KEY_REUSED = 'outcomegatekeyddddddddddddddddd4';

describe('client outcome_unknown — the server says it cannot know; the client must hear it', () => {
	test('a twin of a leader that THREW (it may already have committed) reads UNKNOWN', async () => {
		await withProbe(
			async () => {
				throw new Error('committed, then failed');
			},
			async (calls) => {
				const leader = await dispatchAs(createRqo(KEY_THREW));
				expect((leader.body as { ok?: unknown }).ok).toBe(false);
				const twin = await dispatchAs(createRqo(KEY_THREW));
				expect(calls.count, 'the twin is never executed').toBe(1);
				expect(outcomeUnknown(clientErrorOf(twin))).toBe(true);
			},
		);
	}, 60000);

	test('a twin of a leader whose answer could not be KEPT (it ran; what it said is lost) reads UNKNOWN', async () => {
		await withProbe(
			async () => ({
				status: 200,
				body: ok('x'.repeat(idempotencyLedgerStats().maxBodyBytes + 1), {
					requestId: 'outcome-huge',
				}),
			}),
			async (calls) => {
				const leader = await dispatchAs(createRqo(KEY_HUGE));
				expect((leader.body as { ok?: unknown }).ok).toBe(true);
				const twin = await dispatchAs(createRqo(KEY_HUGE));
				expect(calls.count, 'the twin is never executed').toBe(1);
				expect(outcomeUnknown(clientErrorOf(twin))).toBe(true);
			},
		);
	}, 60000);

	test('a twin of a leader still RUNNING past the real production bound reads UNKNOWN', async () => {
		let release: () => void = () => undefined;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		await withProbe(
			async () => {
				await held;
				return { status: 200, body: ok(true, { requestId: 'outcome-held' }) };
			},
			async (calls) => {
				const leader = dispatchAs(createRqo(KEY_HELD));
				for (let turn = 0; turn < 1000 && idempotencyLedgerStats().entries === 0; turn++) {
					await Promise.resolve();
				}
				expect(idempotencyLedgerStats().entries, 'the leader holds its reservation').toBe(1);
				const twin = await dispatchAs(createRqo(KEY_HELD));
				release();
				await leader;
				expect(calls.count, 'the twin is never executed').toBe(1);
				expect(outcomeUnknown(clientErrorOf(twin))).toBe(true);
			},
		);
	}, 60000);

	test('CONTROL: a KNOWN refusal from the same gate (same key, different request) reads KNOWN', async () => {
		await withProbe(
			async () => ({ status: 200, body: ok(true, { requestId: 'outcome-first' }) }),
			async (calls) => {
				const first = await dispatchAs(createRqo(KEY_REUSED));
				expect((first.body as { ok?: unknown }).ok).toBe(true);
				const reused = await dispatchAs(createRqo(KEY_REUSED, 'another'));
				expect(calls.count, 'the refused request is never executed').toBe(1);
				expect(outcomeUnknown(clientErrorOf(reused))).toBe(false);
			},
		);
	}, 60000);
});
