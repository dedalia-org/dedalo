/**
 * TOOL REFUSAL REASON KEYS — the server half of `details.reason_key`
 * (engineering/ERRORS_SPEC.md §9.1).
 *
 * A tool's refusal is an existing public code plus ONE key out of the closed map
 * the tool declares (`ToolServerModule.reasonKeys`: key → the English fallback
 * sentence); the browser turns the key into the tool's own translated sentence.
 * The converter only knows codes, never which tool threw, so the map is enforced
 * here, at the one place the tool module is known: `guardReasonKeys` wraps every
 * wire-producing entry of a loaded module (action handlers — foreground AND
 * background, since both call `spec.handler` off the loaded registry — `admit`
 * hooks and route handlers) and re-throws a malformed refusal as
 * `internal.invariant`. Loud on purpose: the converter would otherwise drop an
 * undeclared detail silently and the tool would ship a refusal whose label never
 * resolves.
 *
 * THE SENTENCE BELONGS TO THE DECLARATION, NEVER TO THE THROW. The English
 * fallback is the one field the client prints verbatim, so it is the one string a
 * refusal must not be able to carry at runtime. The tool declares it ONCE, beside
 * the key (`reasonKeys: { bad_bbox: 'The bounding box is not numeric.' }`), where
 * the loader vets it (a non-empty string of at most `PUBLIC_MESSAGE_MAX`
 * characters with no control, line-separator or invisible-formatting character —
 * bidi overrides and zero-width characters included). A refusal then needs only
 * code + key: the guard puts the declared sentence on it, and a refusal that
 * brings a DIFFERENT `publicMessage` (an upstream's text, a driver message, a
 * URL) is `internal.invariant` instead of being printed. Nothing a request or an
 * upstream produced can reach `error.message` of a keyed refusal, whatever
 * helper the tool builds its errors with.
 *
 * WHAT IS COVERED, PRECISELY — a keyed refusal in any of these forms:
 *  - THROWN out of an action handler, an `admit` hook or a route handler: checked
 *    and given its sentence by the wrapper;
 *  - RETURNED by an action handler as a failure envelope
 *    (`{ ok: false, error: { details: { reason_key } } }`, which `ToolResponse`
 *    permits): checked by the wrapper (its `message` must be the declared
 *    sentence);
 *  - EMBEDDED in a payload (the per-item errors of a batch: `{ uri, error: <wire
 *    body> }`): built with `toolErrorBody`, which runs the same check, logs a
 *    refusal it turns into `internal.invariant` (no wrapper and no dispatcher
 *    catch sees an embedded one) and then builds the body; the gate bans every
 *    one of the converter's body builders in a tool that declares keys.
 * NOT COVERED, and said so: a `Response` a route RETURNS is not parsed (a route
 * refuses by throwing), and an error body a tool hand-assembles and nests in a
 * payload without any builder is seen only by the static scan of literal
 * `reason_key:` writes (error_taxonomy_tripwire B1 blocks the `ok: false` literal
 * that would usually carry it).
 *
 * A reason_key refusal must satisfy ALL of:
 *  - its code is one the registry opted in (`REASON_KEY_CODES`), every one of them
 *    `disclosure: 'public'` (the converter puts the sentence on the wire because
 *    the code is public);
 *  - the key is one the tool DECLARED;
 *  - it carries no `publicMessage`, or exactly the declared sentence.
 *
 * THE WRAPPER KEEPS ITS ORIGINAL. A guarded entry is an anonymous wrapper, so
 * every consumer that reads a SERVED handler's source (the action_scope_binding
 * census judges what a handler can write) would see the wrapper's few lines and
 * go dark. Each wrapper therefore carries the raw function under a private symbol,
 * and `unguarded(fn)` is the ONE accessor that returns it (identity on a function
 * that was never wrapped). Gate: tool_reason_keys_tripwire section C compares the
 * real registry against the raw imports.
 *
 * LOG HYGIENE. The offending key is request-derived when a tool computes it, and
 * `coordinates` are printed raw by the log line, so an echoed value is reduced to
 * `[A-Za-z0-9_.-]` and a bounded length first (`echoed`): a newline or an escape
 * sequence in it cannot forge a second log line.
 *
 * Stateless: the guard holds no module state (module_state_tripwire).
 * Gate: test/unit/tool_reason_keys_tripwire.test.ts.
 */

import {
	type ApiErrorBody,
	DedaloError,
	type ErrorCode,
	isDedaloError,
	logError,
	REASON_KEY,
	REASON_KEY_CODES,
	REASON_KEY_PATTERN,
	toDedaloError,
	toErrorBody,
} from '../errors/index.ts';
import type {
	ToolActionContext,
	ToolActionSpec,
	ToolAdmissionContext,
	ToolHttpRoute,
	ToolResponse,
	ToolServerModule,
} from './module.ts';

/** Longest slice of an offending value echoed into the (log-only) message and coordinates. */
const COORDINATE_ECHO_MAX = 80;

/** What an echoed value may keep: anything else is shown as `?` (see LOG HYGIENE above). */
const UNSAFE_ECHO = /[^A-Za-z0-9_.-]/g;

/**
 * Text a fallback sentence may not hold: a C0/C1 control character (newline,
 * escape), a Unicode line or paragraph separator, or an invisible formatting
 * character (bidi override U+202E, zero-width space U+200B, byte-order mark).
 * `\p{…}` classes, not code-point ranges, so the rule is the Unicode categories.
 */
const UNSAFE_TEXT = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

/**
 * The longest fallback sentence a tool may declare (characters). A sentence for a
 * toast, not a paragraph.
 */
export const PUBLIC_MESSAGE_MAX = 200;

/** Where a guarded wrapper keeps the function it stands in for (read via `unguarded`). */
const UNGUARDED: unique symbol = Symbol('tools.reason_keys.unguarded');

type AnyFunction = (...args: never[]) => unknown;

/** key → the English fallback sentence, as the guard reads the declaration (a Map: `constructor` is a key, not a prototype hit). */
type Declared = ReadonlyMap<string, string>;

/** Where a check runs: the tool and the action (or route prefix) it guards. */
interface Site {
	readonly tool: string;
	readonly action: string;
}

/** What a refusal claims, whether it was thrown, returned or embedded. */
interface Refusal {
	readonly code: ErrorCode;
	readonly reason: unknown;
	/** The sentence it carries (`undefined` = none: the guard supplies the declared one). */
	readonly carried: string | undefined;
}

/** The verdict on a refusal: the declared sentence it is entitled to, or why it is refused. */
type Verdict = { readonly sentence: string } | { readonly problem: string };

/** `wrapper`, recording `original` as the function it guards (non-enumerable, read-only). */
function markGuarded<F extends AnyFunction>(wrapper: F, original: F): F {
	Object.defineProperty(wrapper, UNGUARDED, { value: original });
	return wrapper;
}

/**
 * The raw function behind a guarded entry of a LOADED module (`apiActions[x]
 * .handler`, `.admit`, `httpRoutes[i].handle`), or `fn` itself when it was never
 * wrapped. For gates that judge what a served handler does — a census that read
 * the wrapper's source would judge nothing.
 */
export function unguarded<F extends AnyFunction>(fn: F): F {
	return (fn as F & { readonly [UNGUARDED]?: F })[UNGUARDED] ?? fn;
}

/**
 * `value` as a short, log-safe token: a string cut to COORDINATE_ECHO_MAX with
 * everything outside `[A-Za-z0-9_.-]` shown as `?`; anything that is not a string
 * is named by its type and never stringified (a hostile `toString` cannot run).
 */
function echoed(value: unknown): string {
	if (typeof value !== 'string') return `(${typeof value})`;
	return value.slice(0, COORDINATE_ECHO_MAX).replace(UNSAFE_ECHO, '?');
}

/** A non-null, non-array object. */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Why a declared fallback sentence is not acceptable, or null. */
function sentenceProblem(key: string, sentence: unknown): string | null {
	const where = `tool.reasonKeys.${echoed(key)}`;
	if (typeof sentence !== 'string' || sentence.trim() === '') {
		return `${where} needs its fallback sentence (a non-empty string, shown when the tool has no label in the user's language)`;
	}
	if (sentence.length > PUBLIC_MESSAGE_MAX) {
		return `${where} is ${sentence.length} characters (the most a fallback sentence may be is ${PUBLIC_MESSAGE_MAX})`;
	}
	return UNSAFE_TEXT.test(sentence)
		? `${where} holds a control, line-separator or invisible formatting character`
		: null;
}

/** Why one declared entry is not acceptable (key grammar, then the sentence), or null. */
function declaredEntryProblem(key: string, sentence: unknown): string | null {
	if (!REASON_KEY_PATTERN.test(key)) {
		return `tool.reasonKeys key '${echoed(key)}' must match ${REASON_KEY_PATTERN}`;
	}
	return sentenceProblem(key, sentence);
}

/**
 * Why `module.reasonKeys` is not a valid declaration, or null: absent is valid
 * (the tool declares none); present must be an object whose every key matches
 * REASON_KEY_PATTERN (the label name is `reason_<key>`, so the grammar is also
 * the label-name grammar) and whose every value is a vetted fallback sentence.
 * Uniqueness is the object's own: a key cannot be declared twice.
 */
export function reasonKeysDeclarationProblem(module: ToolServerModule): string | null {
	const declared: unknown = module.reasonKeys;
	if (declared === undefined) return null;
	if (!isPlainRecord(declared)) {
		return 'tool.reasonKeys must be an object mapping each reason key to its fallback sentence';
	}
	for (const [key, sentence] of Object.entries(declared)) {
		const problem = declaredEntryProblem(key, sentence);
		if (problem !== null) return problem;
	}
	return null;
}

/** The module's declaration as the guard reads it (empty when the tool declares none). */
function declaredSentences(module: Pick<ToolServerModule, 'reasonKeys'>): Declared {
	return new Map(Object.entries(module.reasonKeys ?? {}));
}

/** The sentence declared for `reason`, or undefined when `reason` is not a declared key. */
function declaredSentenceOf(declared: Declared, reason: unknown): string | undefined {
	return typeof reason === 'string' ? declared.get(reason) : undefined;
}

/** What the guard decides about one refusal: the sentence it is entitled to, or the problem. */
function judge(refusal: Refusal, declared: Declared): Verdict {
	const code = echoed(refusal.code);
	if (!REASON_KEY_CODES.includes(refusal.code)) {
		return {
			problem: `${code} does not carry a reason_key (opted-in codes: ${REASON_KEY_CODES.join(', ')})`,
		};
	}
	const sentence = declaredSentenceOf(declared, refusal.reason);
	if (sentence === undefined) {
		return { problem: `'${echoed(refusal.reason)}' is not in the tool's declared reasonKeys` };
	}
	return refusal.carried === undefined || refusal.carried === sentence
		? { sentence }
		: {
				problem:
					'its message is not the sentence declared for the key (the declaration owns the fallback sentence: throw without publicMessage)',
			};
}

/** The refusal a thrown DedaloError makes, or null when it carries no reason_key. */
function thrownRefusal(error: DedaloError): Refusal | null {
	const reason = error.details?.[REASON_KEY];
	return reason === undefined ? null : { code: error.code, reason, carried: error.publicMessage };
}

/** The failure-envelope shape a handler may RETURN, read defensively (it is whatever the handler built). */
interface ReturnedFailure {
	readonly ok?: unknown;
	readonly error?: {
		readonly code: ErrorCode;
		readonly message?: unknown;
		readonly details?: Readonly<Record<string, unknown>>;
	} | null;
}

/**
 * The refusal a RETURNED failure envelope makes, or null (a success, a failure
 * with no reason_key, anything that is not an envelope). The envelope's `message`
 * is its sentence: it must be exactly the declared one.
 */
function returnedRefusal(result: unknown): Refusal | null {
	const body = result as ReturnedFailure | null | undefined;
	const failure = body?.ok === false ? body.error : undefined;
	const reason = failure?.details?.[REASON_KEY];
	if (failure == null || reason === undefined) return null;
	const { code, message } = failure;
	return { code, reason, carried: String(message) };
}

/** The `internal.invariant` that replaces a refused refusal (`cause` is the original — log-only). */
function invariant(
	site: Site,
	verb: 'threw' | 'returned',
	refusal: Refusal,
	problem: string,
	cause?: unknown,
): DedaloError {
	return new DedaloError('internal.invariant', {
		message: `${site.tool}.${site.action} ${verb} ${echoed(refusal.code)} with an invalid reason_key: ${problem}`,
		coordinates: {
			tool: site.tool,
			action: site.action,
			code: echoed(refusal.code),
			reason: echoed(refusal.reason),
		},
		cause,
	});
}

/** `error` carrying `sentence` as its publicMessage — the same error otherwise (stack, cause, coordinates). */
function withSentence(error: DedaloError, sentence: string): DedaloError {
	if (error.publicMessage === sentence) return error;
	const filled = new DedaloError(error.code, {
		message: error.message,
		details: error.details,
		coordinates: error.coordinates,
		publicMessage: sentence,
		retryAfterMs: error.retryAfterMs,
		extend: error.extend,
		cause: error.cause,
	});
	filled.stack = error.stack;
	return filled;
}

/**
 * What to throw for `thrown`: the value itself when it is not a DedaloError or
 * carries no reason_key; the same error with the DECLARED sentence when the
 * refusal is acceptable; otherwise an `internal.invariant` naming the tool, action
 * and the (sanitised) offending key — `onViolation` is told about that one, for a
 * caller no dispatcher catch will log.
 */
function checkReasonKey(
	thrown: unknown,
	site: Site,
	declared: Declared,
	onViolation?: (violation: DedaloError) => void,
): unknown {
	if (!isDedaloError(thrown)) return thrown;
	const refusal = thrownRefusal(thrown);
	if (refusal === null) return thrown;
	const verdict = judge(refusal, declared);
	if ('sentence' in verdict) return withSentence(thrown, verdict.sentence);
	const violation = invariant(site, 'threw', refusal, verdict.problem, thrown);
	onViolation?.(violation);
	return violation;
}

/**
 * A handler's RETURNED value, checked: a failure envelope that carries a
 * reason_key is held to the same rule as a thrown one (its `message` must be the
 * declared sentence); everything else passes by identity.
 */
function checkReturned(result: ToolResponse, site: Site, declared: Declared): ToolResponse {
	const refusal = returnedRefusal(result);
	if (refusal === null) return result;
	const verdict = judge(refusal, declared);
	if ('problem' in verdict) throw invariant(site, 'returned', refusal, verdict.problem);
	return result;
}

/**
 * The envelope v2 error body of `error` for a tool that EMBEDS a refusal in its
 * payload (a per-item error of a batch) instead of throwing it: the same check a
 * thrown refusal gets (the declared sentence is supplied; an undeclared key, a
 * code that does not carry one or a foreign sentence becomes `internal.invariant`
 * and is LOGGED here — nothing downstream catches an embedded refusal), then the
 * one converter. A tool that declares `reasonKeys` uses this and never a body
 * builder directly (gate (e)), so a `reason_key` cannot ride a payload past the
 * map. `module` is the tool's own module object (`tool`), read at call time.
 */
export function toolErrorBody(
	module: Pick<ToolServerModule, 'name' | 'reasonKeys'>,
	action: string,
	error: unknown,
): ApiErrorBody {
	const site: Site = { tool: module.name, action };
	const checked = checkReasonKey(error, site, declaredSentences(module), (violation) =>
		logError(violation, { subsystem: 'tools' }),
	);
	return toErrorBody(toDedaloError(checked));
}

/** An action spec whose handler and admission hook re-throw through checkReasonKey. */
function guardAction(site: Site, declared: Declared, spec: ToolActionSpec): ToolActionSpec {
	const handler = markGuarded(async (context: ToolActionContext): Promise<ToolResponse> => {
		let result: ToolResponse;
		try {
			result = await spec.handler(context);
		} catch (thrown) {
			throw checkReasonKey(thrown, site, declared);
		}
		return checkReturned(result, site, declared);
	}, spec.handler);
	const admission = spec.admit;
	if (admission === undefined) return { ...spec, handler };
	// The hook's return value is passed through untouched: runAdmission refuses a
	// thenable (an async admit), and the guard must not hide one.
	const admit = markGuarded((context: ToolAdmissionContext) => {
		try {
			return admission(context);
		} catch (thrown) {
			throw checkReasonKey(thrown, site, declared);
		}
	}, admission);
	return { ...spec, handler, admit };
}

/** A route whose handler re-throws through checkReasonKey. */
function guardRoute(tool: string, declared: Declared, route: ToolHttpRoute) {
	const site: Site = { tool, action: route.pathPrefix };
	const handle = markGuarded<ToolHttpRoute['handle']>(async (request, pathname) => {
		try {
			return await route.handle(request, pathname);
		} catch (thrown) {
			throw checkReasonKey(thrown, site, declared);
		}
	}, route.handle);
	return { ...route, handle };
}

/**
 * The module the registry serves: `module` with every wire-producing entry
 * guarded. A COPY — the imported object is untouched, so scanning the same
 * import twice (resetLoadedTools, tests) never double-wraps.
 */
export function guardReasonKeys(module: ToolServerModule): ToolServerModule {
	const declared = declaredSentences(module);
	const apiActions = Object.fromEntries(
		Object.entries(module.apiActions).map(([action, spec]) => [
			action,
			guardAction({ tool: module.name, action }, declared, spec),
		]),
	);
	const httpRoutes = module.httpRoutes?.map((route) => guardRoute(module.name, declared, route));
	return { ...module, apiActions, ...(httpRoutes === undefined ? {} : { httpRoutes }) };
}
