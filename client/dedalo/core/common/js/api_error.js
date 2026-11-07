// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global */
/*eslint no-undef: "error"*/

/**
 * API_ERROR
 * The ONE client-side error model for every failure a server call can produce.
 *
 * PURE MODULE: no DOM, no `window`, no `page_globals`, no labels. It is imported
 * by the page (data_manager.js), by the cache Worker (page/js/worker_cache.js)
 * and by the module Service Worker (core/service_worker.js), so nothing here may touch a
 * browser global that a worker scope lacks.
 *
 * CONTRACT (envelope v2 — the wire law, see engineering/wire_contract/
 * WC-*-error-envelope-v2 and docs/core/client/data_manager.md):
 *
 *   success  { ok:true,  request_id, data, notices?:[{code,label_key,details,retryable}], csrf_token? }
 *   failure  { ok:false, request_id, error:{code, category, message, label_key,
 *                                          retryable, details?, debug?}, csrf_token? }
 *
 * `ok:false ⇒ HTTP status ∉ 2xx`; the status is registry metadata, never a
 * client decision. Codes follow `<domain>.<condition>` (`auth.not_logged`,
 * `perm.denied`, `request.invalid_tipo`, …). Failures the CLIENT produces
 * (no server answer at all) use the `client.*` domain below.
 *
 * Every failure — envelope, transport, stream — becomes an `ApiError`, and the
 * client dispatches on `api_error.code` ONLY. `message` is the registry's
 * English (logs, curl); the browser renders `label_key` (render_api_error.js).
 *
 * The v1 compat mirror (`result` / `msg` / `errors` beside `data` / `error`)
 * is GONE on both ends (removed 2026-08-16,
 * WC-2026-08-16-error-envelope-compat-removal): a failure is `ok:false` + a
 * coded `error`, a success is `data` — read through `response_data()` — and a
 * handler-owned top-level field through `response_extension()`.
 */

/**
 * CLIENT_ERROR
 * Codes for failures the client itself produces (no envelope reached us).
 * Grammar `<domain>.<condition>` — same as the server registry, domain `client`.
 */
export const CLIENT_ERROR = Object.freeze({
	NETWORK: 'client.network', // fetch rejected: DNS, refused, CORS, offline mid-flight
	TIMEOUT: 'client.timeout', // our own AbortController fired (server silent)
	ABORTED: 'client.aborted', // the CALLER aborted (its own AbortSignal) — never an error to show
	BAD_RESPONSE: 'client.bad_response', // 2xx but not JSON / not an envelope; unparseable stream frame
	HTTP_STATUS: 'client.http_status', // non-2xx with a body that is not an envelope (proxy page, empty)
	WORKER: 'client.worker', // a Worker / Service Worker channel failed
	OFFLINE: 'client.offline', // navigator.onLine === false before we even tried
	RENDER_FAILED: 'client.render_failed', // a render callback THREW (no request involved): the node the user waited for cannot be built
});

/**
 * CLIENT_ERROR_LABEL_KEY
 * code → UI label key (src/core/labels/master.json). Convention is the server
 * one: `error_` + code with `.` → `_`.
 */
export const CLIENT_ERROR_LABEL_KEY = Object.freeze({
	[CLIENT_ERROR.NETWORK]: 'error_client_network',
	[CLIENT_ERROR.TIMEOUT]: 'error_client_timeout',
	[CLIENT_ERROR.ABORTED]: 'error_client_aborted',
	[CLIENT_ERROR.BAD_RESPONSE]: 'error_client_bad_response',
	[CLIENT_ERROR.HTTP_STATUS]: 'error_client_http_status',
	[CLIENT_ERROR.WORKER]: 'error_client_worker',
	[CLIENT_ERROR.OFFLINE]: 'error_client_offline',
	[CLIENT_ERROR.RENDER_FAILED]: 'error_client_render_failed',
});

/**
 * CLIENT_ERROR_MESSAGE
 * English fallback text per client code, used when no label catalog is loaded
 * (pre-login, workers). Mirrors what the server registry does for its codes.
 */
const CLIENT_ERROR_MESSAGE = Object.freeze({
	[CLIENT_ERROR.NETWORK]: 'Network connection failed',
	[CLIENT_ERROR.TIMEOUT]: 'The request timed out',
	[CLIENT_ERROR.ABORTED]: 'The request was cancelled',
	[CLIENT_ERROR.BAD_RESPONSE]: 'The server response could not be read',
	[CLIENT_ERROR.HTTP_STATUS]: 'The server answered with an HTTP error',
	[CLIENT_ERROR.WORKER]: 'A background worker failed',
	[CLIENT_ERROR.OFFLINE]: 'You are offline',
	[CLIENT_ERROR.RENDER_FAILED]: 'This part of the page could not be built',
});

// The transport class is retryable when the SAME request may succeed a moment
// later without anyone changing anything: the network blipped or the server was
// slow. A caller abort, a malformed answer or a foreign status page are not.
const CLIENT_ERROR_RETRYABLE = new Set([CLIENT_ERROR.NETWORK, CLIENT_ERROR.TIMEOUT]);

// Server code emitted when a body says "failed" without naming why (v1
// `result:false` with nothing else, v2 `ok:false` without `error.code`).
export const SERVER_UNSPECIFIED = 'server.unspecified';

/**
 * CLASS API_ERROR
 * Extends Error so a rejected promise / thrown value still reads as an Error to
 * every consumer that only knows `.message` — while carrying the typed fields
 * the client actually dispatches on.
 *
 * Fields:
 *   code        string   registry code (`auth.not_logged`) or client code (`client.network`)
 *   status      number|null   HTTP status when there was a response, else null
 *   message     string   English text (registry / fallback) — logs only, never dispatched on
 *   label_key   string|null   UI label to render (null ⇒ fall back to message, then code)
 *   details     object   closed per-code scalars (`{param}` values for the label)
 *   request_id  string|null   the server correlation id (the ONLY join key with the server log)
 *   retryable   boolean  the same request may succeed later unchanged
 *   transport   boolean  true when the failure is ours (no envelope): client.* codes
 *   severity    'error'|'warning'|'info'
 *   source      'envelope'|'transport'|'stream'|'client'
 *   tool        string|null   the tool a `tool_request` addressed; with `details.reason_key` it
 *               selects the tool's own label (render_api_error.error_text). Never read from the
 *               server's body. Two writers, both on the CLIENT's side of the call: data_manager
 *               stamps it from the request before publishing 'api_error', and a stream/job frame
 *               site that KNOWS its tool names it through `normalize_stream_error(frame, {tool})`.
 *   raw         the original body / frame / Error, for debugging only
 *   is_api_error true — survives structured clone (postMessage), unlike instanceof
 */
export class ApiError extends Error {
	constructor(fields = {}) {
		const code =
			typeof fields.code === 'string' && fields.code.length ? fields.code : SERVER_UNSPECIFIED;
		const message =
			typeof fields.message === 'string' && fields.message.length
				? fields.message
				: CLIENT_ERROR_MESSAGE[code] || code;

		super(message);

		this.name = 'ApiError';
		this.is_api_error = true;
		this.code = code;
		this.status = Number.isInteger(fields.status) ? fields.status : null;
		this.label_key =
			typeof fields.label_key === 'string' && fields.label_key.length
				? fields.label_key
				: CLIENT_ERROR_LABEL_KEY[code] || null;
		this.details =
			fields.details && typeof fields.details === 'object' && !Array.isArray(fields.details)
				? fields.details
				: {};
		this.request_id =
			typeof fields.request_id === 'string' && fields.request_id.length ? fields.request_id : null;
		this.retryable =
			typeof fields.retryable === 'boolean' ? fields.retryable : CLIENT_ERROR_RETRYABLE.has(code);
		this.transport =
			typeof fields.transport === 'boolean' ? fields.transport : code.startsWith('client.');
		this.severity = ['error', 'warning', 'info'].includes(fields.severity)
			? fields.severity
			: 'error';
		this.source = ['envelope', 'transport', 'stream', 'client'].includes(fields.source)
			? fields.source
			: 'client';
		this.raw = fields.raw === undefined ? null : fields.raw;
		this.category = typeof fields.category === 'string' ? fields.category : null;
		this.debug = fields.debug ?? null;
		this.tool = typeof fields.tool === 'string' && fields.tool.length ? fields.tool : null;
	}

	/**
	 * TO_JSON
	 * Plain, clonable projection (postMessage, JSON.stringify, console). `raw` is
	 * dropped: it may hold a Response or an Error the structured clone refuses.
	 */
	toJSON() {
		return {
			is_api_error: true,
			code: this.code,
			status: this.status,
			message: this.message,
			label_key: this.label_key,
			details: this.details,
			request_id: this.request_id,
			retryable: this.retryable,
			transport: this.transport,
			severity: this.severity,
			source: this.source,
			category: this.category,
			tool: this.tool,
		};
	}
} //end class ApiError

/**
 * IS_API_ERROR
 * Duck-typed on purpose: an ApiError that crossed a postMessage boundary is a
 * plain object again, and one built in another realm (iframe) fails instanceof.
 * @param {*} value
 * @return bool
 */
export const is_api_error = (value) => {
	if (value instanceof ApiError) {
		return true;
	}
	return (
		!!value &&
		typeof value === 'object' &&
		value.is_api_error === true &&
		typeof value.code === 'string'
	);
}; //end is_api_error

/**
 * NORMALIZE_API_ERROR
 * Reads a (parsed) response body and decides whether it is a failure. Returns
 * the ApiError, or null when the body is a success (or there is nothing to say).
 *
 * Order — the FIRST branch that recognises the body wins:
 *   1. v2 `body.ok===false && body.error?.code`         → copy the fields verbatim
 *   2. `body.ok===false` and nothing else               → 'server.unspecified'
 *   3. `response && !response.ok` and no parseable body → client.http_status
 *   4. null
 *
 * @param {Response|{ok,status,statusText}|null} response - the fetch Response (or a lookalike); null when none
 * @param {*} body - the parsed JSON body; null/undefined when unparseable
 * @param {Object} [ctx] - {source:'envelope'|'stream', tool:string} (source defaults to 'envelope').
 *   `tool` is the CALLER's knowledge of which tool the call was for (the body never says), stamped
 *   on a v2 failure only — see ApiError.tool.
 * @return ApiError|null
 */
export const normalize_api_error = (response, body, ctx = {}) => {
	const source = ctx.source || 'envelope';
	const status = Number.isInteger(response?.status) ? response.status : null;
	const is_object = !!body && typeof body === 'object' && !Array.isArray(body);

	// 1. envelope v2
	if (
		is_object &&
		body.ok === false &&
		body.error &&
		typeof body.error === 'object' &&
		typeof body.error.code === 'string'
	) {
		const error = body.error;
		return new ApiError({
			code: error.code,
			status: status,
			message: typeof error.message === 'string' ? error.message : null,
			label_key: typeof error.label_key === 'string' ? error.label_key : null,
			details: error.details,
			request_id:
				typeof body.request_id === 'string'
					? body.request_id
					: typeof error.request_id === 'string'
						? error.request_id
						: null,
			retryable: error.retryable === true,
			transport: false,
			severity: error.severity,
			category: error.category,
			debug: error.debug,
			source: source,
			tool: ctx.tool,
			raw: body,
		});
	}

	// 2. failed, unnamed
	if (is_object && body.ok === false) {
		return new ApiError({
			code: SERVER_UNSPECIFIED,
			status: status,
			message: 'The server reported a failure without a code',
			label_key: null,
			request_id: typeof body.request_id === 'string' ? body.request_id : null,
			retryable: false,
			transport: false,
			source: source,
			raw: body,
		});
	}

	// 3. non-2xx with no envelope at all (proxy error page, empty body)
	if (response && response.ok === false && !is_object) {
		return new ApiError({
			code: CLIENT_ERROR.HTTP_STATUS,
			status: status,
			details: {
				status: status,
				status_text: typeof response.statusText === 'string' ? response.statusText : '',
			},
			retryable: status === 408 || status === 429 || (status !== null && status >= 500),
			transport: true,
			source: 'transport',
			raw: body ?? null,
		});
	}

	// 4. success
	return null;
}; //end normalize_api_error

/**
 * NORMALIZE_TRANSPORT_ERROR
 * Classifies a rejection of `fetch()` / body reading BY CLASS, never by message
 * text (messages differ per browser and per locale).
 *   AbortError + timed_out          → client.timeout   (our own timer fired)
 *   AbortError (caller's signal)    → client.aborted   (silent by policy)
 *   TypeError                       → client.network   (fetch's only network failure class)
 *   anything else                   → client.bad_response
 * `retryable` is true for network/timeout only.
 *
 * @param {*} error - the rejection value
 * @param {Object} [flags] - {timed_out:bool, caller_aborted:bool}
 * @return ApiError
 */
export const normalize_transport_error = (error, flags = {}) => {
	// A DOMException carries its class in `name` (there is no AbortError constructor
	// to instanceof against); Node/Bun's AbortError does the same. Still a class
	// discriminator, not a message grep.
	const is_abort = !!error && typeof error === 'object' && error.name === 'AbortError';

	let code;
	if (is_abort && flags.timed_out === true && flags.caller_aborted !== true) {
		code = CLIENT_ERROR.TIMEOUT;
	} else if (is_abort) {
		code = CLIENT_ERROR.ABORTED;
	} else if (error instanceof TypeError) {
		code = CLIENT_ERROR.NETWORK;
	} else {
		code = CLIENT_ERROR.BAD_RESPONSE;
	}

	return new ApiError({
		code: code,
		status: null,
		details: {
			...(flags.timeout_ms ? { timeout_ms: flags.timeout_ms } : {}),
			...(Number.isInteger(flags.attempt) ? { attempt: flags.attempt } : {}),
		},
		transport: true,
		source: 'transport',
		severity: code === CLIENT_ERROR.ABORTED ? 'info' : 'error',
		raw: error,
	});
}; //end normalize_transport_error

/**
 * NORMALIZE_STREAM_ERROR
 * SSE / NDJSON frames are not envelopes: a failing run ends with a frame
 *   v2      {is_running:false, error:{code, message, label_key, details, request_id}}
 *   v2 BARE {code, category, message, label_key, retryable, details?, hint?}
 *
 * The BARE shape is a frame whose event NAME already says "terminal", so the
 * server sends the error BODY itself with no wrapper (ERRORS_SPEC §5.3 — the
 * agent SSE `event: error`, src/core/api/handlers/dd_mcp_api.ts agentErrorFrame).
 * It is recognised LAST, and only when there is a string `code` and neither an
 * `error` key nor `is_running`, so a wrapped frame can never fall into it.
 *
 * A frame does not say which tool it belongs to, and the tool's own refusal sentence
 * (`details.reason_key` → the tool's `reason_<key>` label, render_api_error.error_text)
 * needs it. The site that follows a tool's job knows (its `self.model`), so it passes
 * `{tool}` here — the same stamp data_manager gives a `tool_request` failure. Without it
 * the refusal reads in the core code's label, as it always did. A frame site that does not
 * know its tool (the page's job tray lists jobs of every kind) simply omits it.
 *
 * @param {*} frame - one parsed stream message
 * @param {Object} [ctx] - {tool:string} the tool the frame's job belongs to
 * @return ApiError|null
 */
export const normalize_stream_error = (frame, ctx = {}) => {
	if (!frame || typeof frame !== 'object') {
		return null;
	}
	const tool = ctx?.tool;

	// already normalised (read_stream synthesises these for unparseable frames)
	if (is_api_error(frame.error)) {
		return frame.error;
	}

	// v2 frame
	if (frame.error && typeof frame.error === 'object' && typeof frame.error.code === 'string') {
		return normalize_api_error(
			null,
			{ ok: false, error: frame.error, request_id: frame.request_id },
			{ source: 'stream', tool: tool },
		);
	}

	// v2 BARE body: the frame IS the error body. Guarded on `code` being a string
	// AND on the absence of both wrapper keys, so this branch can only ever catch
	// what the branches above already refused.
	if (
		typeof frame.code === 'string' &&
		frame.code.length &&
		frame.error === undefined &&
		frame.is_running === undefined
	) {
		return normalize_api_error(
			null,
			{ ok: false, error: frame, request_id: frame.request_id },
			{ source: 'stream', tool: tool },
		);
	}

	return null;
}; //end normalize_stream_error

/**
 * REQUEST_FAILED
 * THE way to ask "did this call fail" on a data_manager.request envelope:
 * the transport attaches an ApiError under `error` on every failure, and
 * NOTHING under it on success.
 * @param {Object} api_response
 * @return bool
 */
export const request_failed = (api_response) => is_api_error(api_response?.error);

/**
 * RESPONSE_DATA
 * THE accessor for the payload of a successful call: the envelope's `data`.
 * A failure has no payload — it has `error` (request_failed / error_text).
 * @param {Object} api_response
 * @return *
 */
export const response_data = (api_response) => api_response?.data;

/**
 * RESPONSE_EXTENSION
 * THE accessor for a handler-owned EXTENSION KEY (ERRORS_SPEC §3.0): a
 * top-level field beside the envelope keys that ONE handler owns and the client
 * reads by name — `msg` / `errors` on the maintenance-widget
 * surfaces, `in_use` on the lock surface, `environment` on `start`, …
 *
 * SUCCESS ONLY, and that is the whole point: a failure has ONE channel,
 * `api_response.error` (error_text / handle_api_error) — an extension key on a
 * failure is exceptional and named (ERRORS_SPEC §3.0: `start`'s `environment`,
 * the CSRF gate's `action`, tool_hierarchy / tool_ontology_parser `errors`),
 * and those readers go through `api_response.<key>` on the failure branch
 * deliberately. This returns undefined for a failure so a `msg` / `errors`
 * extension can never be mistaken for the error text.
 * @param {Object} api_response
 * @param {string} key - the extension key the handler owns
 * @return *
 */
export const response_extension = (api_response, key) =>
	request_failed(api_response) ? undefined : api_response?.[key];

/**
 * CLIENT_ERROR_MESSAGE_FOR
 * English fallback for a client code (exported for the renderer / tests).
 * @param {string} code
 * @return string|null
 */
export const client_error_message_for = (code) => CLIENT_ERROR_MESSAGE[code] || null;

// @license-end
