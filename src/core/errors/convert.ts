/**
 * THE CONVERTER — the one place a thrown value becomes a wire body.
 *
 *   toDedaloError(unknown)          any throw → DedaloError (poison latch here)
 *   toErrorEnvelope(error, ctx)     → { status, body } (HTTP + tool surfaces)
 *   ok(data, ctx)                   → the ok:true envelope
 *   toStructuredErr(error)          → MCP structured error
 *   toStreamFrame(error)            → SSE terminal frame
 *   toFailureRecord(error, extend)  → a persisted failure outcome (job rows)
 *
 * Disclosure ladder (engineering/ERRORS_SPEC.md §2): `error.message` is the
 * registry English, or `publicMessage` only when the code's disclosure is
 * 'public'; `details` carries only the code's `details_keys`, scalars only;
 * `coordinates` and `cause` are never serialized; `debug` exists ONLY when
 * DEDALO_DEBUG_API_ERRORS=true, and the literal `debug` lives in this file
 * alone. `internal.*` never echoes the wrapped exception outside `debug`.
 *
 * The bounded compat block (`result` mirroring `data`,
 * `result:false`/`msg`/`errors:[code]` on failure) was DELETED on 2026-08-16
 * when the client compat-read census reached 0
 * (WC-2026-08-16-error-envelope-compat-removal). The converter never writes a
 * top-level `result` key; the schema refuses one
 * (schema.ts ENVELOPE_FORBIDDEN_KEYS) and error_taxonomy_tripwire A2 pins it.
 *
 * Every function here stays at cyclomatic ≤ 7 (crap_complexity_ratchet rule 3).
 */

import { readEnv } from '../../config/env.ts';
import { isModulePoisonError, markProcessPoisoned } from '../api/process_health.ts';
import { DedaloError, type ErrorDetailScalar, isDedaloError } from './dedalo_error.ts';
import { REASON_KEY, REASON_KEY_PATTERN } from './registry.ts';
import type { ApiErrorBody, ApiNotice, ErrEnvelope, OkEnvelope } from './schema.ts';

export type ErrorSurface = 'http' | 'tool' | 'mcp' | 'stream';

/**
 * Handler EXTENSION KEYS (ERRORS_SPEC §3): top-level fields beside the
 * envelope keys that a handler owns and the client reads by name
 * (`environment`, `in_use`, `total`, `pid`, `job_id`, `saml_redirect`,
 * `dedalo_notification`, `action`, …). Spread FIRST, so a reserved envelope
 * key can never be overridden by one.
 */
export type EnvelopeExtension = Readonly<Record<string, unknown>>;

export interface ErrorEnvelopeContext {
	readonly requestId: string;
	readonly surface?: ErrorSurface;
	/** Chokepoint-side extension keys (the CSRF gate's `action`); merged over the throw's own `extend`. */
	readonly extend?: EnvelopeExtension;
}

export interface OkEnvelopeContext {
	readonly requestId: string;
	readonly notices?: readonly ApiNotice[];
	readonly extend?: EnvelopeExtension;
}

/** Longest `cause` chain the converter follows (defensive; real chains are 1-3 deep). */
const MAX_CAUSE_DEPTH = 8;

function messageOf(value: unknown): string {
	return value instanceof Error ? value.message : String(value);
}

/** The first TDZ-shaped ReferenceError in `error` or its `cause` chain, else undefined. */
function findModulePoison(error: unknown): unknown {
	let cursor: unknown = error;
	for (let depth = 0; depth < MAX_CAUSE_DEPTH && cursor !== undefined && cursor !== null; depth++) {
		if (isModulePoisonError(cursor)) return cursor;
		cursor = (cursor as { cause?: unknown }).cause;
	}
	return undefined;
}

/**
 * Any thrown value → DedaloError. A DedaloError passes through unchanged; a
 * TDZ ReferenceError (raw or anywhere in the cause chain) flips the process
 * poison latch and — unless already typed — becomes `internal.module_poisoned`;
 * anything else is `internal.unexpected` carrying the original as `cause`.
 */
export function toDedaloError(error: unknown): DedaloError {
	const poison = findModulePoison(error);
	if (poison !== undefined) {
		markProcessPoisoned(`TDZ ReferenceError: ${messageOf(poison)}`);
		return isDedaloError(error)
			? error
			: new DedaloError('internal.module_poisoned', { cause: error, message: messageOf(error) });
	}
	if (isDedaloError(error)) return error;
	return new DedaloError('internal.unexpected', { cause: error, message: messageOf(error) });
}

function isDetailScalar(value: unknown): value is ErrorDetailScalar {
	return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

/**
 * One declared detail's value as the wire may carry it: a scalar — and, for the
 * tool refusal enum (`reason_key`), a scalar that also spells a key
 * (REASON_KEY_PATTERN). The pattern keeps free text off the wire under the one
 * key a client turns into a LABEL NAME; the tool loader checks the set, this
 * checks the shape for a throw that bypassed it.
 */
function isWireDetail(key: string, value: unknown): value is ErrorDetailScalar {
	if (key === REASON_KEY) return typeof value === 'string' && REASON_KEY_PATTERN.test(value);
	return isDetailScalar(value);
}

/** `details` filtered to the code's closed key set, scalars only. */
function wireDetails(error: DedaloError): Record<string, ErrorDetailScalar> | undefined {
	const keys = error.spec.details_keys;
	const details = error.details;
	if (keys === undefined || details === undefined) return undefined;
	const out: Record<string, ErrorDetailScalar> = {};
	for (const key of keys) {
		const value = details[key];
		if (isWireDetail(key, value)) out[key] = value;
	}
	return Object.keys(out).length === 0 ? undefined : out;
}

/**
 * The text a DedaloError may put ON THE WIRE: registry English, or the vetted
 * publicMessage when the code's disclosure allows it. Exported for the
 * ok:true surfaces (an identify source's `declined.detail`, a vision model
 * decline) that speak a DedaloError's sentence OUTSIDE an error envelope —
 * `.message` is the LOG-ONLY field (dedalo_error.ts) and is never theirs to
 * forward: a provider constructor names the api_key_env it could not read there.
 */
export function wireMessage(error: DedaloError): string {
	const spec = error.spec;
	return spec.disclosure === 'public' && error.publicMessage !== undefined
		? error.publicMessage
		: spec.message;
}

function causeChain(error: DedaloError): string[] {
	const chain: string[] = [];
	let cursor: unknown = error.cause;
	for (let depth = 0; depth < MAX_CAUSE_DEPTH && cursor !== undefined && cursor !== null; depth++) {
		chain.push(messageOf(cursor));
		cursor = (cursor as { cause?: unknown }).cause;
	}
	return chain;
}

/** The debug block — present ONLY under DEDALO_DEBUG_API_ERRORS=true. */
function debugBlock(error: DedaloError): ApiErrorBody['debug'] {
	if (readEnv('DEDALO_DEBUG_API_ERRORS') !== 'true') return undefined;
	return {
		exception: error.message,
		...(error.stack === undefined ? {} : { stack: error.stack }),
		...(error.coordinates === undefined ? {} : { coordinates: error.coordinates }),
		cause_chain: causeChain(error),
	};
}

/** The `error` object of the v2 envelope (shared by envelope, tool and stream surfaces). */
export function toErrorBody(error: DedaloError): ApiErrorBody {
	const spec = error.spec;
	const details = wireDetails(error);
	const debug = debugBlock(error);
	return {
		code: error.code,
		category: spec.category,
		message: wireMessage(error),
		label_key: spec.label_key,
		retryable: spec.retryable,
		...(details === undefined ? {} : { details }),
		...(debug === undefined ? {} : { debug }),
	};
}

export interface ErrorEnvelopeResult {
	readonly status: number;
	readonly body: ErrEnvelope;
	/** The typed error the body was made from — for logError at the chokepoint (one classification, one latch flip). */
	readonly error: DedaloError;
	/** Set for limit/unavailable codes when the throw carried one — the chokepoint emits Retry-After. */
	readonly retryAfterMs?: number;
}

/** Any throw → `{status, body}` for the HTTP/tool surfaces. */
export function toErrorEnvelope(error: unknown, ctx: ErrorEnvelopeContext): ErrorEnvelopeResult {
	const typed = toDedaloError(error);
	const body = toErrorBody(typed);
	const envelope: ErrEnvelope = {
		...typed.extend,
		...ctx.extend,
		ok: false,
		request_id: ctx.requestId,
		error: body,
	};
	return typed.retryAfterMs === undefined
		? { status: typed.spec.status, body: envelope, error: typed }
		: { status: typed.spec.status, body: envelope, error: typed, retryAfterMs: typed.retryAfterMs };
}

/**
 * The ok:true envelope. `ctx.extend` = the handler's extension keys (see
 * EnvelopeExtension); the payload lives in `data` and nowhere else.
 */
export function ok<T>(data: T, ctx: OkEnvelopeContext): OkEnvelope {
	return {
		...ctx.extend,
		ok: true,
		request_id: ctx.requestId,
		data,
		...(ctx.notices === undefined ? {} : { notices: [...ctx.notices] }),
	};
}

export interface StructuredErrV2 {
	ok: false;
	error: {
		code: ApiErrorBody['code'];
		message: string;
		hint?: string;
		details?: Record<string, ErrorDetailScalar>;
	};
	/** The throw's `extend` keys (a tool's model-facing payload — e.g. `candidates`). */
	[extension: string]: unknown;
}

/**
 * MCP structured error — carries the registry hint for the model. The throw's
 * `extend` keys ride at top level beside `error` (the same rule as the HTTP
 * failure envelope: spread FIRST, so `ok`/`error` can never be overridden).
 */
export function toStructuredErr(error: unknown): StructuredErrV2 {
	const typed = toDedaloError(error);
	const body = toErrorBody(typed);
	const hint = typed.spec.hint;
	return {
		...typed.extend,
		ok: false,
		error: {
			code: body.code,
			message: body.message,
			...(hint === undefined ? {} : { hint }),
			...(body.details === undefined ? {} : { details: body.details }),
		},
	};
}

export interface FailureRecord {
	ok: false;
	error: ApiErrorBody;
	/** The reader-facing extension keys (a job result's `msg`, `tables`, …). */
	[extension: string]: unknown;
}

/**
 * A PERSISTED failure outcome — a diffusion job row's `result`, a report
 * entry: `{ok:false, error}` (the envelope's error body, no request identity)
 * plus the extension keys its reader needs. `extend` is spread FIRST, so
 * `ok`/`error` can never be overridden (the same rule as every surface here).
 * The success twin is a plain `{ok:true, …}` literal at the site — a success
 * carries no error body, so there is nothing for the converter to make.
 */
export function toFailureRecord(error: unknown, extend?: EnvelopeExtension): FailureRecord {
	return { ...extend, ok: false, error: toErrorBody(toDedaloError(error)) };
}

export interface StreamErrorFrame {
	is_running: false;
	error: ApiErrorBody;
}

/** Terminal SSE/stream frame — a frame, not an envelope. */
export function toStreamFrame(error: unknown): StreamErrorFrame {
	return { is_running: false, error: toErrorBody(toDedaloError(error)) };
}
