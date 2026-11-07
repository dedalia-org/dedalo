/**
 * THE CONVERTER — disclosure and classification law (ERRORS_SPEC §2-3).
 *
 *  - a non-DedaloError → internal.unexpected, generic message, cause kept off the wire;
 *  - DEDALO_DEBUG_API_ERRORS=true is the ONLY path that puts exception detail on the wire;
 *  - a TDZ ReferenceError (raw or wrapped as a cause) flips the poison latch;
 *  - publicMessage is honoured only for disclosure 'public';
 *  - details are filtered to details_keys, scalars only; coordinates never serialize.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { getProcessPoison, resetProcessPoisonForTests } from '../../src/core/api/process_health.ts';
import { toDedaloError, toErrorEnvelope, toStructuredErr } from '../../src/core/errors/convert.ts';
import {
	DedaloError,
	isDedaloError,
	isErrorInDomain,
	spec,
} from '../../src/core/errors/dedalo_error.ts';
import { SectionIdRefused } from '../../src/core/errors/families.ts';
import { ERROR_REGISTRY } from '../../src/core/errors/registry.ts';

const CTX = { requestId: 'req-converter-test' } as const;

/**
 * Pin the debug key around one call. readEnv reads process.env FIRST (it wins
 * over ../private/.env, where a dev checkout may carry
 * DEDALO_DEBUG_API_ERRORS=true), so 'off' is spelled process.env='false' —
 * unsetting would fall through to the private file and make this gate
 * environment-dependent.
 */
function withDebugFlag<T>(value: 'true' | 'false', fn: () => T): T {
	const previous = process.env.DEDALO_DEBUG_API_ERRORS;
	process.env.DEDALO_DEBUG_API_ERRORS = value;
	try {
		return fn();
	} finally {
		if (previous === undefined) {
			delete process.env.DEDALO_DEBUG_API_ERRORS;
		} else process.env.DEDALO_DEBUG_API_ERRORS = previous;
	}
}

afterEach(() => {
	resetProcessPoisonForTests();
});

describe('toDedaloError — classification', () => {
	test('a DedaloError passes through unchanged (same instance)', () => {
		const original = new DedaloError('perm.denied');
		expect(toDedaloError(original)).toBe(original);
	});

	test('a plain Error / string / undefined → internal.unexpected with the original as cause', () => {
		const plain = new Error('boom');
		const typed = toDedaloError(plain);
		expect(typed.code).toBe('internal.unexpected');
		expect(typed.cause).toBe(plain);
		expect(typed.message).toBe('boom'); // log-only; wire uses the registry message
		expect(toDedaloError('a string').code).toBe('internal.unexpected');
		expect(toDedaloError(undefined).code).toBe('internal.unexpected');
	});

	test('a raw TDZ ReferenceError flips the poison latch and becomes internal.module_poisoned', () => {
		expect(getProcessPoison().poisoned).toBe(false);
		const tdz = new ReferenceError("Cannot access 'X' before initialization");
		const typed = toDedaloError(tdz);
		expect(typed.code).toBe('internal.module_poisoned');
		expect(getProcessPoison().poisoned).toBe(true);
		expect(getProcessPoison().reason).toContain('before initialization');
	});

	test('a TDZ ReferenceError WRAPPED as a cause (any depth) also flips the latch', () => {
		const tdz = new ReferenceError("Cannot access 'Y' before initialization");
		const wrapped = new Error('outer', { cause: new Error('middle', { cause: tdz }) });
		expect(toDedaloError(wrapped).code).toBe('internal.module_poisoned');
		expect(getProcessPoison().poisoned).toBe(true);
		resetProcessPoisonForTests();
		// A typed error carrying a poisoned cause keeps its code but still latches.
		const typed = new DedaloError('record.save_failed', { cause: tdz });
		expect(toDedaloError(typed)).toBe(typed);
		expect(getProcessPoison().poisoned).toBe(true);
	});

	test('a non-TDZ ReferenceError does NOT latch', () => {
		toDedaloError(new ReferenceError('x is not defined'));
		expect(getProcessPoison().poisoned).toBe(false);
	});
});

describe('toErrorEnvelope — disclosure', () => {
	test('without DEDALO_DEBUG_API_ERRORS the wire carries no exception detail at all', () => {
		const body = withDebugFlag(
			'false',
			() => toErrorEnvelope(new Error('secret /path/to/file'), CTX).body,
		);
		expect(JSON.stringify(body)).not.toContain('secret');
		expect(body.error.debug).toBeUndefined();
		const structured = withDebugFlag('false', () => toStructuredErr(new Error('secret2')));
		expect(JSON.stringify(structured)).not.toContain('secret2');
	});

	test('DEDALO_DEBUG_API_ERRORS=true is the only path to exception/stack/coordinates/cause_chain', () => {
		const inner = new Error('inner-cause');
		const typed = new DedaloError('record.save_failed', {
			cause: inner,
			message: 'save blew up',
			coordinates: { tipo: 'test3', section_id: 7 },
		});
		const body = withDebugFlag('true', () => toErrorEnvelope(typed, CTX).body);
		expect(body.error.debug).toBeDefined();
		expect(body.error.debug?.exception).toBe('save blew up');
		expect(body.error.debug?.cause_chain).toEqual(['inner-cause']);
		expect(body.error.debug?.coordinates).toEqual({ tipo: 'test3', section_id: 7 });
		expect(typeof body.error.debug?.stack).toBe('string');
		// The wire message is STILL the registry English even in debug mode.
		expect(body.error.message).toBe(ERROR_REGISTRY['record.save_failed'].message);
	});

	test('publicMessage is honoured only when the code discloses public', () => {
		// A generic public code. (Not a site_builder.* one: since WIRE-MAP every site-builder
		// refusal has its own code and its label is the text — none carries publicMessage.)
		expect(ERROR_REGISTRY['request.invalid_options'].disclosure).toBe('public');
		const pub = toErrorEnvelope(
			new DedaloError('request.invalid_options', { publicMessage: 'A site name is required.' }),
			CTX,
		).body;
		expect(pub.error.message).toBe('A site name is required.');
		expect(ERROR_REGISTRY['perm.denied'].disclosure).toBe('operator');
		const op = toErrorEnvelope(
			new DedaloError('perm.denied', { publicMessage: 'you cannot read /etc/passwd' }),
			CTX,
		).body;
		expect(op.error.message).toBe('Insufficient permissions');
		expect(JSON.stringify(op)).not.toContain('passwd');
	});

	test('details are filtered to details_keys, scalars only; coordinates never serialize', () => {
		const typed = new DedaloError('record.delete_children_refused', {
			details: {
				not_deleted: '12,13',
				extra: 'must-not-appear',
				// biome-ignore lint/suspicious/noExplicitAny: deliberately non-scalar probe
				nested: { a: 1 } as any,
			},
			coordinates: { section_id: 99, tipo: 'coord-tipo' },
		});
		const body = withDebugFlag('false', () => toErrorEnvelope(typed, CTX).body);
		expect(body.error.details).toEqual({ not_deleted: '12,13' });
		const text = JSON.stringify(body);
		expect(text).not.toContain('must-not-appear');
		expect(text).not.toContain('coord-tipo');
		// A code without details_keys drops every detail.
		const none = withDebugFlag(
			'false',
			() => toErrorEnvelope(new DedaloError('perm.denied', { details: { x: 1 } }), CTX).body,
		);
		expect(none.error.details).toBeUndefined();
		// Non-scalar under a declared key is dropped, not stringified.
		const nonScalar = new DedaloError('record.delete_children_refused', {
			// biome-ignore lint/suspicious/noExplicitAny: deliberately non-scalar probe
			details: { not_deleted: [1, 2] as any },
		});
		expect(toErrorEnvelope(nonScalar, CTX).body.error.details).toBeUndefined();
	});

	test('details.reason_key: carried by an opted-in code (a key-shaped string only), dropped from every other', () => {
		const refusal = (code: 'request.invalid_options' | 'perm.denied', reason: unknown) =>
			withDebugFlag(
				'false',
				() =>
					toErrorEnvelope(
						new DedaloError(code, {
							// biome-ignore lint/suspicious/noExplicitAny: deliberately non-scalar probe
							details: { reason_key: reason as any },
							publicMessage: 'Fallback sentence.',
						}),
						CTX,
					).body,
			);
		// an opted-in public code carries it, with the fallback sentence beside it
		const carried = refusal('request.invalid_options', 'bad_bbox');
		expect(carried.error.details).toEqual({ reason_key: 'bad_bbox' });
		expect(carried.error.message).toBe('Fallback sentence.');
		// a code that did not opt in drops it (and keeps the registry sentence)
		const dropped = refusal('perm.denied', 'bad_bbox');
		expect(dropped.error.details).toBeUndefined();
		expect(dropped.error.message).toBe('Insufficient permissions');
		// the shape guard: free text, a number, an object, an empty string never reach the wire
		for (const bad of [
			'Not a key',
			'with-dash',
			'UPPER',
			'',
			'x'.repeat(49),
			7,
			true,
			{ a: 1 },
			null,
		]) {
			expect(
				refusal('request.invalid_options', bad).error.details,
				JSON.stringify(bad),
			).toBeUndefined();
		}
		// it rides beside the code's own declared details
		const both = withDebugFlag(
			'false',
			() =>
				toErrorEnvelope(
					new DedaloError('tool.source_unavailable', {
						details: { site: 'https://tiles.example.org', reason_key: 'down', extra: 'no' },
						publicMessage: 'The tile server is down.',
					}),
					CTX,
				).body,
		);
		expect(both.error.details).toEqual({ site: 'https://tiles.example.org', reason_key: 'down' });
	});

	test('MCP structured error also filters details and never carries the cause', () => {
		const structured = withDebugFlag('false', () =>
			toStructuredErr(new Error('engine prose with /paths')),
		);
		expect(structured.error.code).toBe('internal.unexpected');
		expect(JSON.stringify(structured)).not.toContain('/paths');
	});
});

describe('DedaloError + families', () => {
	test('isDedaloError / isErrorInDomain / spec', () => {
		const err = new SectionIdRefused('section_id.numeric_shaped', {
			coordinates: { source: 'test-door' },
		});
		expect(isDedaloError(err)).toBe(true);
		expect(isErrorInDomain(err, 'section_id')).toBe(true);
		expect(isErrorInDomain(err, 'section')).toBe(false);
		expect(isErrorInDomain(new TypeError('x'), 'section_id')).toBe(false);
		expect(spec(err).category).toBe('caller');
		expect(err.name).toBe('SectionIdRefused');
		expect(err.message).toBe(ERROR_REGISTRY['section_id.numeric_shaped'].message);
		expect(err instanceof Error).toBe(true);
	});
});

describe('logError — grammar + counters', () => {
	test('[subsystem] code k=v [req id] + severity routing + counters', async () => {
		const { logError, formatErrorLine } = await import('../../src/core/errors/log.ts');
		const { getCounters } = await import('../../src/core/api/counters.ts');
		const err = new DedaloError('perm.denied', {
			coordinates: { tipo: 'test3', section_id: 1 },
			details: { secret_detail: 'never-logged' },
		});
		const line = formatErrorLine(err, { requestId: 'r-9' });
		expect(line).toBe('[perm] perm.denied tipo=test3 section_id=1 [req r-9]');
		expect(formatErrorLine(err, { subsystem: 'dispatch' })).toBe(
			'[dispatch] perm.denied tipo=test3 section_id=1',
		);
		expect(line).not.toContain('never-logged');
		const before = getCounters().error_perm_denied ?? 0;
		const beforeTotal = getCounters().errors_total ?? 0;
		const original = console.warn;
		const captured: unknown[][] = [];
		console.warn = (...args: unknown[]) => {
			captured.push(args);
		};
		try {
			logError(err, { requestId: 'r-9' });
		} finally {
			console.warn = original;
		}
		expect(captured.length).toBe(1);
		expect(captured[0]?.[0]).toBe(line);
		expect(captured[0]?.[1]).toBe(err);
		expect(getCounters().error_perm_denied).toBe(before + 1);
		expect(getCounters().errors_total).toBe(beforeTotal + 1);
	});
});
