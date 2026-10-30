// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global */
/*eslint no-undef: "error"*/



/**
* API_TRANSPORT
* The ONE fetch+normalise core of the client. No DOM, no page globals: imported
* by data_manager.js (page), page/js/worker_cache.js (Worker) and core/service_worker.js
* (module Service Worker) — there is no fourth copy of "how to call the API"
* (client_error_contract_tripwire).
*
* Algorithm (one attempt):
*   fetch never throws on status → read the body text ONCE → parse JSON when the
*   content-type says JSON (or the text looks like JSON) → normalize_api_error.
*   Success returns {json, api_error:null, response}. Failure decides
*   `should_retry` from `api_error.retryable` and the `Retry-After` header
*   (honoured over the backoff) — NEVER from a status list — and, once out of
*   attempts, returns {json, api_error, response} (response null when the
*   network never answered). The loop emits NO UI: `on_wait(attempt, delay,
*   reason)` is the only hook ('busy' = the health probe found the server alive
*   mid-attempt and EXTENDED the deadline by that many ms; 'retry' = sleeping
*   before the next attempt).
*
* (!) Every attempt holds a live deadline at all times. A busy server buys the
* attempt more time; it never removes the timer (see `busy_grace` below).
*/

// imports
	import {
		normalize_api_error,
		normalize_transport_error,
		ApiError,
		CLIENT_ERROR
	} from './api_error.js'



/**
* CHECK_HEALTH
* Cache-busted GET of the engine liveness endpoint. Tells a slow-but-alive
* server from a dead one; never throws.
* @param {string} health_url
* @return Promise<bool>
*/
export const check_health = async (health_url) => {
	try {
		const url		= health_url + (health_url.includes('?') ? '&' : '?') + 'time=' + Date.now() + Math.floor(Math.random() * 1000)
		const response	= await fetch(url, {method:'GET', cache:'no-cache'})
		if (response.ok) {
			return true
		}
		// ALIVE BUT NOT READY (update audit 2026-10-29, U-01/U-04): a server whose
		// boot migration failed, or whose database is ahead of its code, answers
		// 503 with `db: 'ok'`. It is answering — this probe tells slow from DEAD,
		// so it must not read that as a dead server.
		if (response.status===503) {
			const body = await response.json().catch(() => null)
			return body?.db==='ok'
		}
		return false
	} catch (error) {
		return false
	}
}//end check_health



/**
* PARSE_BODY
* Reads the body text once and parses it when it is (or looks like) JSON.
* @return {json:*|null, text:string}
*/
const parse_body = async (response) => {
	let text = ''
	try {
		text = await response.text()
	} catch (error) {
		return {json:null, text:'', read_error:error}
	}
	const content_type	= response.headers?.get?.('content-type') || ''
	const looks_json	= /^\s*[\[{]/.test(text)
	if (!content_type.includes('json') && !looks_json) {
		return {json:null, text}
	}
	try {
		return {json: JSON.parse(text), text}
	} catch (error) {
		return {json:null, text, parse_error:error}
	}
}//end parse_body



/**
* RETRY_AFTER_MS
* `Retry-After` as milliseconds (seconds or HTTP-date), or null.
*/
const retry_after_ms = (response) => {
	const value = response?.headers?.get?.('retry-after')
	if (!value) return null
	const seconds = Number(value)
	if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000)
	const at = Date.parse(value)
	return Number.isFinite(at) ? Math.max(0, at - Date.now()) : null
}//end retry_after_ms



/**
* FETCH_API
* @param {string} url
* @param {Object} init - native fetch init (method, headers, body, signal, …)
* @param {Object} [options]
*   timeout_ms  {number}   per-attempt abort (default 5000; grows by the backoff delay per retry)
*   retries     {number}   max attempts (default 5)
*   base_delay  {number}   backoff base in ms (default 500): delay = base_delay * 2^(attempt-1)
*   on_wait     {Function} (attempt, delay_ms, reason:'busy'|'retry') — UI hook, optional
*   health_url  {string}   liveness endpoint for the mid-attempt probe (default '/health')
*   busy_grace_ms {number} extra time granted ONCE per attempt when that probe finds
*                          the server alive (default: the attempt's backoff delay + 3000)
* @return Promise<{json:*, api_error:ApiError|null, response:Response|null}>
*/
export const fetch_api = async (url, init = {}, options = {}) => {

	const timeout_ms	= options.timeout_ms ?? 5000
	const retries		= Math.max(1, options.retries ?? 5)
	const base_delay	= options.base_delay ?? 500
	const on_wait		= typeof options.on_wait==='function' ? options.on_wait : null
	const health_url	= options.health_url ?? '/health'
	const busy_grace_ms	= options.busy_grace_ms ?? null // null = derive per attempt (delay + 3000)
	const caller_signal	= init.signal || null

	let attempt		= 0
	let last		= {json:null, api_error:null, response:null}

	while (attempt < retries) {
		attempt++
		const delay				= base_delay * Math.pow(2, attempt - 1)
		const current_timeout	= attempt===1 ? timeout_ms : timeout_ms + delay
		// the ONE extension a busy server earns; also the value on_wait reports, so
		// the notice and the wait it describes expire together
		const busy_grace		= busy_grace_ms ?? (delay + 3000)

		// one controller per attempt; the caller's signal aborts it too
		const controller	= new AbortController()
		let timed_out		= false
		let settled			= false
		const on_caller_abort = () => controller.abort()
		if (caller_signal) {
			if (caller_signal.aborted) controller.abort()
			else caller_signal.addEventListener('abort', on_caller_abort, {once:true})
		}
		// THE deadline for this attempt. In a `let` because the busy probe below
		// REPLACES it — the one thing it may never do is leave the attempt without one.
		// `attempt_started` is monotonic (performance.now, available in window, worker
		// and service worker alike) so the probe can extend the deadline additively.
		const attempt_started	= performance.now()
		const fire_timeout		= () => { timed_out = true; controller.abort() }
		let timeout_id			= setTimeout(fire_timeout, current_timeout)
		// mid-attempt health probe: an answering server is BUSY, not dead — so it
		// buys the attempt more time instead of being aborted at the deadline, and
		// the UI is told why it is waiting.
		// (!) It buys TIME, not IMMUNITY. This used to `clearTimeout(timeout_id)`
		// and never re-arm, so from the first successful probe the request had NO
		// timeout at all: a server that answered /health and then stalled left the
		// promise pending for the life of the page — busy toast already
		// auto-dismissed, frozen widget, no error path, and only a caller-supplied
		// AbortSignal (which almost no caller passes) could still end it.
		// ONE grant per attempt is deliberate: a server still busy when the grace
		// runs out fails this attempt and the retry loop hands the next one a larger
		// budget (timeout_ms + delay), which is where longer waits belong.
		const health_id = setTimeout(async () => {
			const alive = await check_health(health_url)
			// the probe may resolve after the request itself did — say nothing then
			if (alive && !settled) {
				// (!) ADDITIVE, never a replacement: re-arm at whatever is LEFT of the
				// original budget PLUS the grace, so a busy answer can only ever push
				// the deadline later. Re-arming at `busy_grace` alone would SHORTEN it
				// for every caller whose timeout exceeds twice the grace — make_backup
				// passes 3_600_000 ms for pg_dump, so a probe at the 30-minute mark
				// would have killed the backup 3.5 s later instead of at the hour.
				const remaining	= Math.max(0, current_timeout - (performance.now() - attempt_started))
				const extension	= remaining + busy_grace
				clearTimeout(timeout_id)
				timeout_id = setTimeout(fire_timeout, extension)
				if (on_wait) on_wait(attempt, extension, 'busy')
			}
		}, Math.floor(current_timeout / 2))

		try {
			const response	= await fetch(url, {...init, signal: controller.signal})
			settled = true
			clearTimeout(timeout_id); clearTimeout(health_id)
			const {json}	= await parse_body(response)
			let api_error	= normalize_api_error(response, json)
			if (!api_error && json===null) {
				// a 2xx that is not JSON is not an answer the client can use
				api_error = new ApiError({code: CLIENT_ERROR.BAD_RESPONSE, status: response.status, transport:true, source:'transport', details:{status: response.status}})
			}
			last = {json, api_error, response}
			if (!api_error) return last
			// should_retry: the answer says so, or the server named a wait
			const wait = retry_after_ms(response)
			if (!(api_error.retryable===true || wait!==null) || attempt >= retries) return last
			const sleep = wait ?? delay
			if (on_wait) on_wait(attempt, sleep, 'retry')
			await new Promise((resolve) => setTimeout(resolve, sleep))
		} catch (error) {
			settled = true
			clearTimeout(timeout_id); clearTimeout(health_id)
			const caller_aborted = !!caller_signal?.aborted
			const api_error = normalize_transport_error(error, {timed_out, caller_aborted, timeout_ms: current_timeout, attempt})
			last = {json:null, api_error, response:null}
			if (caller_aborted || api_error.retryable!==true || attempt >= retries) return last
			if (on_wait) on_wait(attempt, delay, 'retry')
			await new Promise((resolve) => setTimeout(resolve, delay))
		} finally {
			if (caller_signal) caller_signal.removeEventListener('abort', on_caller_abort)
		}
	}

	return last
}//end fetch_api



// @license-end
