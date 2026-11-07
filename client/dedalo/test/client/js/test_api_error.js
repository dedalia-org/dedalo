// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global it, describe, assert, page_globals */
/*eslint no-undef: "error"*/
'use strict';

/**
* TEST_API_ERROR
* The client's ONE error model (core/common/js/api_error.js) and the transport
* built on it (api_transport.js, data_manager.request).
*
* WHY THESE ASSERTIONS. The client dispatches on `api_error.code` and nothing
* else, so every way a failure can reach the browser must land on the same
* shape: an envelope v2 `{ok:false, error:{code}}`, an `ok:false` without a
* code, a foreign non-2xx status page, a fetch rejection, a stream frame. Each
* branch below is one such road, asserted on the CODE it produces. The v1
* mirror (`result`/`msg`/`errors`) is GONE from the client (P4): the tests that
* asserted it now assert that it is ignored.
*
* Transport classification is BY CLASS (AbortError / TypeError), never by
* message text — asserted with real DOMException / TypeError instances.
*
* NO BACKEND, BY CONSTRUCTION: `fetch` is stubbed on window for the transport
* blocks and restored in `finally`, so a failing assertion cannot leave the
* suite talking to a fake network.
*/

import {
	ApiError,
	CLIENT_ERROR,
	CLIENT_ERROR_LABEL_KEY,
	is_api_error,
	normalize_api_error,
	normalize_transport_error,
	normalize_stream_error,
	request_failed,
	response_data
} from '../../../core/common/js/api_error.js'
import {fetch_api} from '../../../core/common/js/api_transport.js'
import {data_manager} from '../../../core/common/js/data_manager.js'
import {event_manager} from '../../../core/common/js/event_manager.js'



// fake_response — the subset of Response that normalize_api_error reads
	const fake_response = (ok, status, status_text='') => ({ok, status, statusText: status_text})

// with_stubbed_fetch — replace window.fetch, run fn, always restore
	const with_stubbed_fetch = async (impl, fn) => {
		const original = window.fetch
		window.fetch = impl
		try {
			await fn()
		} finally {
			window.fetch = original
		}
	}

// json_response — a real Response carrying a JSON body
	const json_response = (body, status=200, headers={}) => new Response(
		JSON.stringify(body),
		{status, headers: {'content-type': 'application/json', ...headers}}
	)



describe('API_ERROR — the one client error model', function() {

	it('CLIENT_ERROR codes follow the <domain>.<condition> grammar and each has a label key', function() {
		for (const code of Object.values(CLIENT_ERROR)) {
			assert.match(code, /^client\.[a-z_]+$/, code)
			assert.equal(CLIENT_ERROR_LABEL_KEY[code], 'error_' + code.replace('.', '_'))
		}
	})

	it('ApiError is an Error (message survives for legacy .message readers) and is duck-typed after clone', function() {
		const api_error = new ApiError({code: 'perm.denied', message: 'Insufficient permissions', request_id: 'rq1'})
		assert.instanceOf(api_error, Error)
		assert.equal(api_error.message, 'Insufficient permissions')
		assert.equal(api_error.code, 'perm.denied')
		assert.isTrue(is_api_error(api_error))
		// structured clone (postMessage / worker) drops the prototype but not the marker
		const cloned = JSON.parse(JSON.stringify(api_error))
		assert.isTrue(is_api_error(cloned))
		assert.equal(cloned.code, 'perm.denied')
		assert.equal(cloned.request_id, 'rq1')
		assert.isFalse(is_api_error({code: 'x'}), 'a bare object with a code is not an ApiError')
		assert.isFalse(is_api_error(null))
	})

	it('ApiError.tool: null unless given, kept by toJSON (the cache worker / postMessage clone carry it)', function() {
		assert.isNull(new ApiError({code: 'perm.denied'}).tool)
		assert.isNull(new ApiError({code: 'perm.denied', tool: ''}).tool)
		assert.isNull(new ApiError({code: 'perm.denied', tool: 7}).tool)
		const api_error = new ApiError({code: 'request.invalid_options', tool: 'tool_zz_probe', details: {reason_key: 'bad_bbox'}})
		assert.equal(api_error.tool, 'tool_zz_probe')
		assert.equal(JSON.parse(JSON.stringify(api_error)).tool, 'tool_zz_probe')
		// the server never sets it: an envelope body's own `tool` key is not read
		const normalized = normalize_api_error(fake_response(false, 400), {ok: false, tool: 'tool_zz_probe', error: {code: 'request.invalid_options', tool: 'tool_zz_probe'}})
		assert.isNull(normalized.tool)
		assert.deepEqual(new ApiError({code: 'request.invalid_options', details: {reason_key: 'bad_bbox'}}).details, {reason_key: 'bad_bbox'}, 'details.reason_key survives as a plain detail')
	})

	it('client codes default retryable/transport/label from the code alone', function() {
		assert.isTrue(new ApiError({code: CLIENT_ERROR.NETWORK}).retryable)
		assert.isTrue(new ApiError({code: CLIENT_ERROR.TIMEOUT}).retryable)
		assert.isFalse(new ApiError({code: CLIENT_ERROR.ABORTED}).retryable)
		assert.isTrue(new ApiError({code: CLIENT_ERROR.NETWORK}).transport)
		assert.isFalse(new ApiError({code: 'auth.not_logged'}).transport)
		assert.equal(new ApiError({code: CLIENT_ERROR.OFFLINE}).label_key, 'error_client_offline')
	})

	it('normalize_api_error: envelope v2 copies the fields verbatim (code, label_key, details, request_id, retryable)', function() {
		const api_error = normalize_api_error(fake_response(false, 403), {
			ok			: false,
			request_id	: 'rq-v2',
			error		: {code: 'perm.denied', category: 'permission', message: 'Insufficient permissions', label_key: 'no_access_page', retryable: false, details: {tipo: 'oh1'}}
		})
		assert.isTrue(is_api_error(api_error))
		assert.equal(api_error.code, 'perm.denied')
		assert.equal(api_error.status, 403)
		assert.equal(api_error.label_key, 'no_access_page')
		assert.deepEqual(api_error.details, {tipo: 'oh1'})
		assert.equal(api_error.request_id, 'rq-v2')
		assert.equal(api_error.category, 'permission')
		assert.isFalse(api_error.retryable)
		assert.isFalse(api_error.transport)
		assert.equal(api_error.source, 'envelope')
	})

	it('normalize_api_error: a body that is not ok:false is never a failure (the v1 mirror is gone)', function() {
		assert.isNull(normalize_api_error(fake_response(true, 200), {result: {rows: []}, errors: ['a warning']}))
		assert.isNull(normalize_api_error(fake_response(true, 200), {result: false, msg: 'x', errors: ['not_logged']}))
	})

	it('normalize_api_error: ok:false without a coded error → server.unspecified', function() {
		assert.equal(normalize_api_error(fake_response(false, 500), {ok: false}).code, 'server.unspecified')
	})

	it('normalize_api_error: non-2xx without an envelope → client.http_status with the status in details', function() {
		const api_error = normalize_api_error(fake_response(false, 502, 'Bad Gateway'), null)
		assert.equal(api_error.code, CLIENT_ERROR.HTTP_STATUS)
		assert.equal(api_error.status, 502)
		assert.deepEqual(api_error.details, {status: 502, status_text: 'Bad Gateway'})
		assert.isTrue(api_error.transport)
		assert.isTrue(api_error.retryable, 'a gateway page is transient')
		assert.isFalse(normalize_api_error(fake_response(false, 404), null).retryable)
	})

	it('normalize_api_error: success bodies (v2 ok:true, v1 truthy result) → null', function() {
		assert.isNull(normalize_api_error(fake_response(true, 200), {ok: true, data: {a: 1}}))
		assert.isNull(normalize_api_error(fake_response(true, 200), {result: {context: [], data: []}, errors: []}))
		assert.isNull(normalize_api_error(null, null))
	})

	it('normalize_transport_error classifies BY CLASS: AbortError+timed_out→timeout, AbortError→aborted, TypeError→network, else bad_response', function() {
		const abort = new DOMException('The user aborted a request.', 'AbortError')
		assert.equal(normalize_transport_error(abort, {timed_out: true}).code, CLIENT_ERROR.TIMEOUT)
		assert.equal(normalize_transport_error(abort, {}).code, CLIENT_ERROR.ABORTED)
		assert.equal(normalize_transport_error(abort, {timed_out: true, caller_aborted: true}).code, CLIENT_ERROR.ABORTED, 'the caller wins')
		assert.equal(normalize_transport_error(new TypeError('Failed to fetch')).code, CLIENT_ERROR.NETWORK)
		assert.equal(normalize_transport_error(new TypeError('anything at all')).code, CLIENT_ERROR.NETWORK, 'no message matching')
		assert.equal(normalize_transport_error(new SyntaxError('Unexpected token')).code, CLIENT_ERROR.BAD_RESPONSE)
		assert.equal(normalize_transport_error('a string').code, CLIENT_ERROR.BAD_RESPONSE)
		assert.isTrue(normalize_transport_error(new TypeError('x')).retryable)
		assert.isTrue(normalize_transport_error(abort, {timed_out: true}).retryable)
		assert.isFalse(normalize_transport_error(abort, {}).retryable)
		assert.isTrue(normalize_transport_error(new TypeError('x')).transport)
	})

	it('normalize_stream_error: v2 frame.error.code, already-normalised frames, clean frames', function() {
		assert.equal(normalize_stream_error({is_running: false, error: {code: 'job.failed', message: 'x'}, request_id: 'rq'}).code, 'job.failed')
		assert.equal(normalize_stream_error({is_running: false, error: {code: 'job.failed'}, request_id: 'rq'}).request_id, 'rq')
		assert.isNull(normalize_stream_error({data: {errors: ['not_logged']}}), 'the v1 frame shape is no longer read')
		const already = new ApiError({code: CLIENT_ERROR.BAD_RESPONSE, source: 'stream'})
		assert.strictEqual(normalize_stream_error({error: already}), already)
		assert.isNull(normalize_stream_error({data: {msg: 'running'}, is_running: true}))
		assert.isNull(normalize_stream_error(null))
	})

	it('normalize_stream_error: {tool} names the tool a frame belongs to (v2 and BARE); a frame never names its own', function() {
		const frame = {is_running: false, error: {code: 'request.invalid_options', details: {reason_key: 'bad_bbox'}}, request_id: 'rq'}
		const stamped = normalize_stream_error(frame, {tool: 'tool_zz_probe'})
		assert.equal(stamped.tool, 'tool_zz_probe')
		assert.equal(stamped.details.reason_key, 'bad_bbox', 'the key rides through to error_text')
		assert.equal(stamped.source, 'stream')
		// the BARE terminal body gets the same stamp
		const bare = {code: 'tool.source_unavailable', details: {reason_key: 'down', site: 'tiles.example.org'}}
		assert.equal(normalize_stream_error(bare, {tool: 'tool_zz_probe'}).tool, 'tool_zz_probe')
		// no tool given, or a value that is not a tool name: null (the core label, as before)
		for (const ctx of [undefined, {}, null, {tool: ''}, {tool: 7}, {tool: null}]) {
			assert.isNull(normalize_stream_error(frame, ctx).tool, JSON.stringify(ctx))
		}
		// the server's body is never trusted for it
		assert.isNull(normalize_stream_error({is_running: false, tool: 'tool_evil', error: {code: 'x.y', tool: 'tool_evil'}}).tool)
		// an already-normalised error comes back as it is, unmodified
		const already = new ApiError({code: CLIENT_ERROR.BAD_RESPONSE, source: 'stream'})
		assert.strictEqual(normalize_stream_error({error: already}, {tool: 'tool_zz_probe'}), already)
		assert.isNull(already.tool)
		// a clean frame stays clean
		assert.isNull(normalize_stream_error({is_running: true, data: {msg: 'running'}}, {tool: 'tool_zz_probe'}))
	})

	it('request_failed / response_data are the two accessors callers migrate onto', function() {
		assert.isTrue(request_failed({ok: false, error: new ApiError({code: 'x'})}))
		assert.isFalse(request_failed({ok: true, data: 1}))
		assert.isFalse(request_failed({result: false, error: 'legacy string'}), 'a legacy scalar is not an ApiError')
		assert.isFalse(request_failed(null))
		assert.equal(response_data({ok: true, data: 'D'}), 'D')
		assert.isUndefined(response_data({result: 'R'}), 'the v1 mirror is not a payload any more')
		assert.equal(response_data({data: 'D', result: 'R'}), 'D')
		assert.isUndefined(response_data(null))
	})
})



describe('API_TRANSPORT — fetch_api', function() {

	it('success: reads the body once, parses JSON, returns {json, api_error:null}', async function() {
		await with_stubbed_fetch(async () => json_response({ok: true, data: {a: 1}}), async () => {
			const out = await fetch_api('/fake', {method: 'POST'}, {retries: 2, base_delay: 1, timeout_ms: 2000})
			assert.isNull(out.api_error)
			assert.deepEqual(out.json, {ok: true, data: {a: 1}})
			assert.equal(out.response.status, 200)
		})
	})

	it('failure envelope with retryable:false is returned after ONE attempt (no status list, 401/403 included)', async function() {
		for (const status of [401, 403, 409, 500]) {
			let calls = 0
			await with_stubbed_fetch(async () => { calls++; return json_response({ok: false, error: {code: 'auth.not_logged', retryable: false}}, status) }, async () => {
				const out = await fetch_api('/fake', {}, {retries: 4, base_delay: 1, timeout_ms: 2000})
				assert.equal(out.api_error.code, 'auth.not_logged')
				assert.equal(out.api_error.status, status)
				assert.equal(calls, 1, `status ${status}: an answer is not retried`)
			})
		}
	})

	it('retry is keyed on api_error.retryable and honours Retry-After over the backoff; on_wait is the only hook', async function() {
		let calls = 0
		const waits = []
		await with_stubbed_fetch(async (url) => {
			if (String(url).endsWith('/health')) return new Response('ok')
			calls++
			return calls < 3
				? json_response({ok: false, error: {code: 'unavailable.busy', retryable: true}}, 503, {'retry-after': '0'})
				: json_response({ok: true, data: 'done'})
		}, async () => {
			const out = await fetch_api('/fake', {}, {retries: 5, base_delay: 50, timeout_ms: 2000, on_wait: (attempt, delay, reason) => waits.push({attempt, delay, reason})})
			assert.isNull(out.api_error)
			assert.equal(out.json.data, 'done')
			assert.equal(calls, 3)
			assert.deepEqual(waits.map(w => w.reason), ['retry', 'retry'])
			assert.deepEqual(waits.map(w => w.delay), [0, 0], 'Retry-After: 0 wins over the 50/100ms backoff')
		})
	})

	it('a fetch rejection (TypeError) → client.network, retried up to retries', async function() {
		let calls = 0
		await with_stubbed_fetch(async () => { calls++; throw new TypeError('Failed to fetch') }, async () => {
			const out = await fetch_api('/fake', {}, {retries: 3, base_delay: 1, timeout_ms: 2000})
			assert.equal(out.api_error.code, CLIENT_ERROR.NETWORK)
			assert.isNull(out.response)
			assert.isNull(out.json)
			assert.equal(calls, 3)
		})
	})

	it('a 2xx that is not JSON → client.bad_response; a non-2xx status page → client.http_status', async function() {
		await with_stubbed_fetch(async () => new Response('<html>', {status: 200, headers: {'content-type': 'text/html'}}), async () => {
			const out = await fetch_api('/fake', {}, {retries: 1, base_delay: 1})
			assert.equal(out.api_error.code, CLIENT_ERROR.BAD_RESPONSE)
		})
		await with_stubbed_fetch(async () => new Response('<html>', {status: 404, headers: {'content-type': 'text/html'}}), async () => {
			const out = await fetch_api('/fake', {}, {retries: 3, base_delay: 1})
			assert.equal(out.api_error.code, CLIENT_ERROR.HTTP_STATUS)
			assert.equal(out.api_error.details.status, 404)
		})
	})

	it('our own timeout → client.timeout; the caller\'s AbortSignal → client.aborted and NO retry', async function() {
		const never = (url, init) => new Promise((resolve, reject) => {
			if (String(url).endsWith('/health')) { resolve(new Response('', {status: 503})); return }
			init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
		})
		await with_stubbed_fetch(never, async () => {
			const out = await fetch_api('/fake', {}, {retries: 2, base_delay: 1, timeout_ms: 30})
			assert.equal(out.api_error.code, CLIENT_ERROR.TIMEOUT)
		})
		let calls = 0
		await with_stubbed_fetch((url, init) => { calls++; return never(url, init) }, async () => {
			const controller = new AbortController()
			setTimeout(() => controller.abort(), 10)
			const out = await fetch_api('/fake', {signal: controller.signal}, {retries: 3, base_delay: 1, timeout_ms: 5000})
			assert.equal(out.api_error.code, CLIENT_ERROR.ABORTED)
			assert.equal(calls, 1)
		})
	})
})



describe('DATA_MANAGER.request — the envelope it resolves', function() {

	// collect the events one request publishes
	const capture_events = (names) => {
		const seen = {}
		const tokens = names.map((name) => event_manager.subscribe(name, (payload) => { (seen[name] = seen[name] || []).push(payload) }))
		return {seen, release: () => tokens.forEach((t) => event_manager.unsubscribe(t))}
	}

	it('success resolves the server envelope untouched (no error attached)', async function() {
		await with_stubbed_fetch(async () => json_response({ok: true, data: {x: 1}, csrf_token: 'tok-1', session_user_id: page_globals.user_id}), async () => {
			const api_response = await data_manager.request({body: {action: 'noop'}, retries: 1})
			assert.isFalse(request_failed(api_response))
			assert.deepEqual(response_data(api_response), {x: 1})
			assert.equal(page_globals.csrf_token, 'tok-1', 'the token is refreshed from every envelope of the page\'s own session')
		})
	})

	it('failure attaches the ApiError under `error`, keeps ok:false and publishes api_error', async function() {
		const events = capture_events(['api_error'])
		try {
			await with_stubbed_fetch(async () => json_response({ok: false, request_id: 'rq9', error: {code: 'auth.not_logged', message: 'Authentication required', retryable: false}}, 401), async () => {
				const api_response = await data_manager.request({body: {action: 'read'}, retries: 3})
				assert.isTrue(request_failed(api_response))
				assert.equal(api_response.ok, false)
				assert.equal(api_response.error.code, 'auth.not_logged')
				assert.equal(api_response.error.request_id, 'rq9')
			})
			assert.equal(events.seen.api_error?.length, 1)
			assert.equal(events.seen.api_error[0].code, 'auth.not_logged')
		} finally {
			events.release()
		}
	})

	it('a tool_request failure is stamped with the tool BEFORE api_error is published; any other request stays null', async function() {
		const refusal = {ok: false, request_id: 'rq-tool', error: {code: 'request.invalid_options', message: 'Fallback sentence', label_key: 'error_request_invalid_options', retryable: false, details: {reason_key: 'bad_bbox'}}}
		const at_publish = []
		const token = event_manager.subscribe('api_error', (api_error) => { at_publish.push(api_error.tool) })
		try {
			await with_stubbed_fetch(async () => json_response(refusal, 400), async () => {
				const tool_body = {dd_api: 'dd_tools_api', action: 'tool_request', source: {model: 'tool_zz_probe', action: 'save_source'}, options: {}}
				const api_response = await data_manager.request({body: tool_body, retries: 1})
				assert.equal(api_response.error.tool, 'tool_zz_probe')
				assert.equal(api_response.error.details.reason_key, 'bad_bbox')

				await data_manager.request({body: {dd_api: 'dd_core_api', action: 'read', source: {model: 'tool_zz_probe'}}, retries: 1})
				await data_manager.request({body: {dd_api: 'dd_tools_api', action: 'get_element_context', source: {model: 'tool_zz_probe'}}, retries: 1})
				await data_manager.request({body: {dd_api: 'dd_tools_api', action: 'tool_request', source: {}}, retries: 1})
				await data_manager.request({body: JSON.stringify(tool_body), retries: 1})
			})
		} finally {
			event_manager.unsubscribe(token)
		}
		assert.deepEqual(at_publish, ['tool_zz_probe', null, null, null, null], 'stamped before the page subscriber could toast; only a tool_request body names a tool')
	})

	it('a network failure resolves (never rejects) with a synthesised envelope + client.network', async function() {
		await with_stubbed_fetch(async () => { throw new TypeError('Failed to fetch') }, async () => {
			const api_response = await data_manager.request({body: {action: 'read'}, retries: 1, base_delay: 1})
			assert.isTrue(request_failed(api_response))
			assert.equal(api_response.error.code, CLIENT_ERROR.NETWORK)
			assert.equal(api_response.ok, false)
		})
	})

	it('csrf rejection is resent exactly once with the fresh token (auth.csrf_failed)', async function() {
		for (const body of [
			// the token's owner travels with it: the page's own session (a session of
			// ANOTHER user is never adopted nor resent — test_relogin_identity s3)
			{ok: false, error: {code: 'auth.csrf_failed', retryable: false}, csrf_token: 'fresh', session_user_id: page_globals.user_id}
		]) {
			let calls = 0
			const tokens = []
			await with_stubbed_fetch(async (url, init) => {
				calls++
				tokens.push(init.headers['X-Dedalo-Csrf-Token'])
				return calls === 1 ? json_response(body, 403) : json_response({ok: true, data: 'ok'})
			}, async () => {
				page_globals.csrf_token = 'stale'
				const api_response = await data_manager.request({body: {action: 'save'}, retries: 1})
				assert.equal(calls, 2)
				assert.equal(tokens[1], 'fresh', 'the retry carries the token the rejection delivered')
				assert.equal(response_data(api_response), 'ok')
			})
		}
	})

	it('an empty URL is a client failure envelope, no network', async function() {
		// `options.url || data_manager.url` — the only way to reach an empty URL is
		// an empty DEDALO_API_URL (a broken bootstrap), so that is what is simulated
		const original_api_url = window.DEDALO_API_URL
		let calls = 0
		try {
			window.DEDALO_API_URL = ''
			await with_stubbed_fetch(async () => { calls++; return json_response({ok: true}) }, async () => {
				const api_response = await data_manager.request({body: {action: 'x'}})
				assert.isTrue(request_failed(api_response))
				assert.equal(api_response.error.code, CLIENT_ERROR.NETWORK)
				assert.equal(api_response.error.details.reason, 'invalid_url')
				assert.equal(calls, 0)
			})
		} finally {
			window.DEDALO_API_URL = original_api_url
		}
	})
})



describe('DATA_MANAGER.request — the SHOW_DEBUG request line', function() {

	// The debug line prints the request options for a developer. It must never
	// print an options VALUE: secrets ride there under names nobody listed —
	// the login form's password is `auth`, the reset flow sends `code`,
	// `new_password`, `reset_id` — and a list of "secret names" rots the day a
	// new form ships (the measured defect: `auth` was missing). So the rule is
	// structural: KEY NAMES only, for every key, including one invented here.
	it('carries the options key NAMES, never a value — whatever the key is called', async function() {
		const secrets = {
			auth				: 'zz-login-pass-1',
			code				: 'zz-reset-code-2',
			new_password		: 'zz-new-pass-3',
			reset_id			: 'zz-reset-id-4',
			zz_unlisted_secret	: 'zz-unlisted-5'
		}
		const lines			= []
		const sent			= []
		const original_warn	= console.warn
		const original_show	= window.SHOW_DEBUG
		try {
			window.SHOW_DEBUG = true
			console.warn = (...args) => { lines.push(args) }
			await with_stubbed_fetch(async (url, init) => { sent.push(init.body); return json_response({ok: true, data: null}) }, async () => {
				await data_manager.request({body: {dd_api: 'dd_utils_api', action: 'zz_debug_line', options: {...secrets, username: 'zz-user'}}, retries: 1})
			})
		} finally {
			console.warn		= original_warn
			window.SHOW_DEBUG	= original_show
		}
		const request_lines = lines.filter((args) => String(args[0]).startsWith('> data_manager request'))
		assert.equal(request_lines.length, 1, 'the debug line was written (positive control)')
		const shown = JSON.stringify(request_lines[0])
		for (const [key, value] of Object.entries(secrets)) {
			assert.notInclude(shown, value, `the value of '${key}' is not on the debug line`)
			assert.include(shown, `"${key}"`, `the key name '${key}' still is`)
		}
		assert.notInclude(shown, 'zz-user', 'not even a value that looks harmless')
		assert.include(shown, 'zz_debug_line', 'the action is still shown')
		// the request itself is unchanged
		assert.equal(sent.length, 1)
		assert.include(String(sent[0]), 'zz-login-pass-1', 'the server still receives the value')
	})
})



// @license-end
