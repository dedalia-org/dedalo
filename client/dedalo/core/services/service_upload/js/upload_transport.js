// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global DEDALO_API_URL, SHOW_DEBUG */
/*eslint no-undef: "error"*/



/**
* UPLOAD_TRANSPORT
* The wire core of the Dédalo upload path, extracted out of service_upload.js.
*
* This is the ONLY module in the client that constructs an XMLHttpRequest, and it
* is deliberately DOM-FREE: no event_manager, no get_label, no alert(), no DOM
* node, no CSS class. It speaks bytes and resolves objects; everything that a
* human sees is decided by the caller. That separation is what makes a
* multi-file queue possible: a queue cannot be built on top of a transport that
* blocks on alert() or that writes into one fixed progress bar.
*
* The page-identity latch is the one other import (error_dispatch
* `refused_by_page_identity`, LEAD-2): while a re-login as another user has
* revoked the page identity, no part opens a socket — every transport of the
* client asks the same question before it sends.
*
* The only other non-wire import is data_manager, because the chunked flow is NOT a
* single request — it is N multipart POSTs followed by ONE JSON RQO
* (dd_utils_api::join_chunked_files_uploaded) that assembles them server-side.
* Owning the join here is what lets `start()` resolve exactly once with the
* file_data of the FINAL assembled file; a caller that had to fire the join
* itself would have to reimplement the chunk bookkeeping.
*
* THE ONE LAW OF THIS MODULE: `start()` resolves exactly once on every terminal
* path and NEVER rejects. See create_transfer for why (defects D1/D2).
*
* Main exports:
* - `validate_file`          — pure, synchronous pre-flight check (no UI).
* - `create_connection_pool` — sliding-window concurrency semaphore.
* - `create_transfer`        — one file → one `{start, abort, status}` handle.
* - `join_chunked_files`     — the server-side assemble RQO (also used as the
*                              delegate of service_upload.prototype.join_chunked_files).
*/

// imports
	import { data_manager } from '../../../common/js/data_manager.js'
	import { refused_by_page_identity } from '../../../common/js/error_dispatch.js'
	import { JSON_parse_safely } from '../../../common/js/utils/util.js'
	import { ApiError, CLIENT_ERROR, normalize_api_error, request_failed, response_data } from '../../../common/js/api_error.js'



/**
* VALIDATE_FILE
* Pure, synchronous pre-flight validation of a file against the advertised
* client-side limits. It NEVER alerts, NEVER logs and NEVER throws — it returns
* a verdict and lets the caller decide how (or whether) to show it.
*
* `code` is the LABEL KEY, not a rendered string, precisely because the two
* callers want different presentations: the single-file service still blocks on
* alert() (legacy UX contract), while a multi-file queue must collect the
* verdicts and render them per row without ever blocking.
*
* (!) DEFECT D3 — FIXED HERE. The previous implementation did:
*         if (!allowed_extensions.includes(file_extension)) reject
*     with callers that pass `[]` (the import tools never assign the list).
*     `[].includes(x)` is ALWAYS false, so an empty list rejected EVERY file.
*     An absent or empty whitelist means "no whitelist configured" — i.e.
*     ALLOW ALL — never "whitelist of none". If this regresses, every upload
*     from a tool that does not configure allowed_extensions dies client-side
*     with an "invalid extension" alert and never reaches the network.
*     The real enforcement is server-side magic-byte sniffing
*     (src/core/media/engine/mime.ts sniffAndValidate); this list is advisory
*     UX only, so failing open here is safe.
*
* (!) A falsy or 0 `max_size_bytes` likewise means "no limit advertised", not
*     "maximum zero bytes". The server enforces its own cap
*     (config.media.upload.maxSizeBytes) independently of this check, and it
*     enforces it on the WHOLE FILE, not just on one request: parseUploadRequest
*     bounds each part as it arrives, receiveUpload keeps a running total per
*     transfer, and joinChunkedUpload sums the parts before assembling them.
*     So chunking a file does not get it past the limit.
*
* @param {Object} options
*   @param {File|Blob} options.file - The file to check (needs `name` and `size`).
*   @param {Array<string>} [options.allowed_extensions] - Lowercase extension
*     whitelist. Empty/absent = allow all.
*   @param {number} [options.max_size_bytes] - Size cap in bytes. Falsy = no cap.
* @returns {Object} `{valid:boolean, code:string|null, msg:string|null}` where
*   `code` is a get_label key ('invalid_extension' | 'filesize_is_too_big') and
*   `detail` is the DETAIL text meant to be appended to that resolved label
*   (keeping the legacy alert text byte-identical).
*/
export const validate_file = function(options) {

	// options
		const file					= options.file
		const allowed_extensions	= options.allowed_extensions
		const max_size_bytes		= options.max_size_bytes

	// valid_response
		const valid_response = {
			valid	: true,
			code	: null,
			detail	: null
		}

	// no file. Nothing to validate, nothing to refuse: the caller's own guard
	// (input.files[0] || null) already covers the empty-selection case.
		if (!file) {
			return valid_response
		}

	// extension check. Only when a non-empty whitelist was actually configured (D3).
		const file_name			= typeof file.name === 'string' ? file.name : ''
		const file_extension	= file_name.split('.').pop().toLowerCase()
		const has_whitelist		= Array.isArray(allowed_extensions) && allowed_extensions.length > 0
		if (has_whitelist && !allowed_extensions.includes(file_extension)) {
			return {
				valid	: false,
				code	: 'invalid_extension',
				detail	: ": \n" + file_extension + "\nUse any of: \n" + JSON.stringify(allowed_extensions)
			}
		}

	// size check. Only when a cap was actually advertised.
		const file_size_bytes = file.size || 0
		if (max_size_bytes && file_size_bytes > max_size_bytes) {
			return {
				valid	: false,
				code	: 'filesize_is_too_big',
				detail	: " Max file size is " + Math.floor(max_size_bytes / (1024*1024)) + " MB and current file is " + Math.floor(file_size_bytes / (1024*1024))
			}
		}


	return valid_response
}//end validate_file



/**
* CREATE_CONNECTION_POOL
* Sliding-window concurrency semaphore over arbitrary async tasks.
*
* ONE pool is meant to be SHARED across many transfers. That is the whole point:
* chunk concurrency multiplies by file concurrency, so a per-file window of 50
* becomes 500 open sockets the moment a queue uploads 10 files at once — which
* is how a browser (6 connections per host) and the server's request budget both
* get exhausted at the same time. A shared pool caps the TOTAL.
*
* A falsy `max_concurrent` means UNBOUNDED, which is the legacy behaviour of the
* old process_queue (`if (max_concurrent && active_count >= max_concurrent)`).
*
* @param {number|false} max_concurrent - Maximum simultaneous tasks; falsy = unlimited.
* @returns {Object} `{run(task_fn):Promise, set_max(n), in_flight():number}`.
*   `run` resolves/rejects with whatever `task_fn` settles to; the slot is
*   released on BOTH paths, so a throwing task can never leak the window shut.
*/
export const create_connection_pool = function(max_concurrent) {

	// state
		let limit			= max_concurrent || 0 // 0 = unbounded
		let active_count	= 0
		const waiting		= []

	// pump
		// Start as many queued tasks as the window allows. Called on every
		// enqueue and on every release, which is what makes the window SLIDING
		// rather than batched.
		const pump = function() {
			while ((!limit || active_count < limit) && waiting.length > 0) {
				const start_next = waiting.shift()
				active_count++
				start_next()
			}
		}

	// run
		const run = function(task_fn) {
			return new Promise(function(resolve, reject) {
				const start_task = function() {
					// Promise.resolve().then(task_fn) so a task_fn that throws
					// SYNCHRONOUSLY is still routed through the release path
					// instead of escaping and wedging the window.
					Promise.resolve().then(task_fn).then(
						function(result) {
							active_count--
							pump()
							resolve(result)
						},
						function(error) {
							active_count--
							pump()
							reject(error)
						}
					)
				}
				waiting.push(start_task)
				pump()
			})
		}

	// set_max
		// Live re-tune (the service's info panel exposes this as a number input).
		// Raising the limit must immediately admit waiting tasks, hence the pump.
		const set_max = function(value) {
			limit = value || 0
			pump()
		}

	// in_flight
		const in_flight = function() {
			return active_count
		}


	return {
		run			: run,
		set_max		: set_max,
		in_flight	: in_flight
	}
}//end create_connection_pool



/**
* JOIN_CHUNKED_FILES
* Instructs the server to concatenate the uploaded chunk temp-files into the
* single final staged file (dd_utils_api::join_chunked_files_uploaded → TS
* joinChunkedUpload, which also RE-SNIFFS the assembled bytes, SEC-066).
*
* retries:5 / timeout:10s are carried over verbatim from the legacy
* implementation: the join is disk-bound (append + re-sniff of a possibly
* multi-GB file) and a single slow response must not lose an upload that has
* already fully transferred.
*
* A multi-GB join outlives one request budget: after ~24 s the resend gets
* idempotency.in_progress (not retryable) while the first join is still running,
* and the user saw an error for a file that ended up staged. So the call is
* repeated in rounds until it settles. Each round is a new request (data_manager
* mints its key); the server's join is idempotent per upload_id: a round while
* the first join runs gets media.upload_conflict, and a round after it ends gets
* the recorded result (upload.ts joinChunkedUpload).
*
* @param {Object} options
*   @param {Object} options.file_data - `file_data` of the last chunk response
*     (carries key_dir / tmp_name / total_chunks).
*   @param {Array<string>} options.files_chunked - Server-side temp names indexed
*     by chunk_index.
*   @param {Function} [options.is_stopped] - Returns true when the caller
*     cancelled the transfer, to stop waiting.
* @returns {Promise<Object>} The API response `{ok, data, file_data?}`.
*/
export const join_chunked_files = async function(options) {

	// options
		const file_data		= options.file_data
		const files_chunked	= options.files_chunked

	// rqo
		const rqo = {
			dd_api	: 'dd_utils_api',
			action	: 'join_chunked_files_uploaded',
			options	: {
				file_data		: file_data,
				files_chunked	: files_chunked
			}
		}

	// call to the API, fetch data and get response
		const deadline = Date.now() + JOIN_MAX_WAIT_MS
		while (true) {
			const response = await data_manager.request({
				body	: rqo,
				retries	: 5, // try
				timeout	: 10 * 1000 // 10 secs waiting response
			})
			// still running on the server (or its answer was lost): ask again
			const code		= response?.error?.code
			const pending	= code==='media.upload_conflict'
				|| code==='idempotency.in_progress'
				|| code===CLIENT_ERROR.TIMEOUT
				|| code===CLIENT_ERROR.NETWORK
			if (!pending || Date.now() >= deadline || options.is_stopped?.()) {
				return response
			}
			await new Promise(resolve_wait => setTimeout(resolve_wait, JOIN_POLL_MS))
		}
}//end join_chunked_files



/**
* JOIN_MAX_WAIT_MS / JOIN_POLL_MS
* How long join_chunked_files keeps asking for a running join, and the pause
* between rounds. 30 min covers a 10 GB join on slow storage (~6 MB/s).
*/
const JOIN_MAX_WAIT_MS	= 30 * 60 * 1000
const JOIN_POLL_MS		= 5 * 1000



/**
* NEW_UPLOAD_ID
* Mints the identity of ONE transfer: an opaque token that every part of that
* file carries and that no other transfer shares.
*
* WHY: the receiver stages chunk parts under `.up_<upload_id>/<i>.part` and
* claims the final staged name atomically. Without an explicit id it derives one
* from `sha256(key_dir, RAW file name, total_chunks)` — which is already safe for
* a single transfer and already separates `María.jpg` from `Mar#a.jpg` (it hashes
* BEFORE sanitising). The residue that only an explicit id closes is TWO
* SIMULTANEOUS transfers of the same raw name into the same key_dir, which is
* unreachable with one file picker and perfectly reachable from a queue. So the
* fallback is not a reason to omit this — the queue is exactly the caller that
* breaks it.
*
* The server VALIDATES `^[A-Za-z0-9_-]{8,64}$` and REFUSES anything else rather
* than sanitising it, so every branch below must emit only those characters.
*
* crypto.randomUUID() is unavailable outside a secure context (an http:// dev
* install is exactly that case), so falling back is not optional — an exception
* here would break every upload on plain http. getRandomValues has the same
* secure-context caveat in practice, hence the third tier; it is weaker but the
* id only needs to be unique among ONE user's concurrent uploads, not
* unguessable — it grants no authority, and the server scopes staging per user.
*
* @returns {string} 32 hex chars (or an equally-shaped fallback token).
*/
const new_upload_id = function() {

	const random_source = (typeof crypto !== 'undefined') ? crypto : null

	if (random_source && typeof random_source.randomUUID === 'function') {
		// Dashes stripped: '-' is inside the accepted charset, but a bare hex run
		// is what the server's staging directory names read best as.
		return random_source.randomUUID().replace(/-/g, '')
	}
	if (random_source && typeof random_source.getRandomValues === 'function') {
		const bytes = new Uint8Array(16)
		random_source.getRandomValues(bytes)
		let out = ''
		for (let i = 0; i < bytes.length; i++) {
			out += bytes[i].toString(16).padStart(2, '0')
		}
		return out
	}

	return (Date.now().toString(16) + Math.random().toString(16).slice(2)).padEnd(32, '0').slice(0, 32)
}//end new_upload_id



/**
* CURRENT_CSRF_TOKEN
* Reads the CSRF token AT SEND TIME, never at init time.
*
* SEC-008: the token rotates on every API response (data_manager.request writes
* the fresh one back into window.page_globals.csrf_token). A transfer can sit in
* the pool's waiting list for minutes behind other uploads, so a token captured
* when the transfer was CREATED is very likely stale by the time its chunk goes
* out — and a stale token is a 403 that looks exactly like a broken upload.
*
* @returns {string|null} The current token, or null when there is none.
*/
const current_csrf_token = function() {

	if (typeof window === 'undefined' || !window.page_globals || !window.page_globals.csrf_token) {
		return null
	}

	return window.page_globals.csrf_token
}//end current_csrf_token



/**
* TO_TEXT
* Coerces an unknown value into something safe to place in a STRING slot.
*
* A message slot takes a STRING. An object that reaches one renders as the
* useless "[object Object]" in the UI, which is indistinguishable from a bug,
* so stringify anything that is not already a string.
*
* @param {*} value
* @returns {string}
*/
const to_text = function(value) {

	if (typeof value === 'string') {
		return value
	}
	if (value === null || typeof value === 'undefined') {
		return ''
	}
	try {
		return JSON.stringify(value)
	} catch (_error) {
		return String(value)
	}
}//end to_text



/**
* API_ERROR_FROM
* The parsed upload body → ONE ApiError, through the ONE normaliser.
*
* The upload endpoint is converter-made like every other door
* (media/ingest/upload_endpoint.ts: `ok(true, {extend:{file_data}})` or
* `toErrorEnvelope`), so the diagnosis a curator needs — bad magic bytes, path
* escape, oversize part — arrives as `error.code` + `error.message`, and the
* renderer resolves it in the user's language. When the body is not our JSON at
* all (a proxy/gateway HTML page) there is no envelope to read: the status
* itself is the failure, and normalize_api_error mints `client.http_status`.
*
* @param {Object|null} api_response - Parsed body, or null when it was not JSON.
* @param {number} status - The HTTP status code.
* @param {string} [raw_text] - The raw responseText, used when parsing failed.
* @returns {ApiError} never null: an unrecognised body still becomes one.
*/
const api_error_from = function(api_response, status, raw_text) {

	const ok		= status >= 200 && status < 300
	const api_error	= normalize_api_error({ok:ok, status:status, statusText:''}, api_response)
	if (api_error) {
		return api_error
	}
	// A body that is not our JSON is usually a proxy/gateway HTML error page.
	// Truncate: the text goes straight into a UI slot, and a full HTML document
	// there is noise that hides the status code that follows it.
	const detail = (typeof raw_text === 'string' && raw_text !== '')
		? (raw_text.length > 300 ? raw_text.slice(0, 300) + '…' : raw_text)
		: 'Upload failed. HTTP status ' + status

	return new ApiError({
		code		: CLIENT_ERROR.BAD_RESPONSE,
		status		: status,
		message		: detail,
		transport	: true,
		source		: 'transport'
	})
}//end api_error_from



/**
* SLICE
* Cross-browser File.slice. Kept from the legacy implementation: the vendor
* prefixes are inert on every currently supported browser but cost nothing, and
* removing them is not this module's decision to make.
*
* @param {File} file
* @param {number} start
* @param {number} end
* @returns {Blob}
*/
const slice = function(file, start, end) {

	const slice_fn = file.mozSlice
		? file.mozSlice
		: file.webkitSlice
			? file.webkitSlice
			: file.slice
				? file.slice
				: function(){}

	return slice_fn.bind(file)(start, end)
}//end slice



/**
* CREATE_TRANSFER
* Builds ONE upload handle for ONE file. Nothing happens until `start()`.
*
* THE SETTLEMENT LAW — `start()` resolves EXACTLY ONCE on EVERY terminal path
* (success, server refusal, transport error, abort, max-retries-exceeded) and
* NEVER rejects. Both halves matter:
*
* (!) DEFECT D1 — FIXED HERE. The legacy `upload()` returned
*     `new Promise(async function(resolve){…})` and called `resolve` ONLY from
*     the xhr "load" handler. The upload-"error" handler and the abort handler
*     published an event and returned. So on ANY transport failure the awaited
*     promise NEVER SETTLED: `await upload_file()` never returned, the caller's
*     spinner span stayed on screen forever, and no error was ever rendered.
*     Every exit below goes through `settle()`, which is the single writer of
*     the outer promise and is idempotent. If a new exit path is added without
*     calling settle(), the wedge comes back.
*
* (!) DEFECT D2 — FIXED HERE. The legacy `send_chunk` returned
*     `new Promise(function(resolve){` — only `resolve` was bound — yet called
*     `reject(...)` in three places (max retries exceeded, abort, non-2xx load).
*     All three were a ReferenceError at runtime, so the CHUNKED path had no
*     working failure mode at all: a rejected chunk threw inside a handler and
*     the transfer hung. This module never uses reject for a transfer outcome;
*     a failure is a RESOLVED `{ok:false, error:ApiError}` value, because a
*     rejection the caller cannot render is indistinguishable from a crash.
*
* Progress is BYTE-WEIGHTED: `sum(bytes_of_each_chunk_done) / total_bytes`. The
* legacy code averaged the per-chunk PERCENTAGES, which is only correct when all
* chunks are the same size — and the last chunk never is. On a 3-chunk transfer
* of 80/80/2 MB the old bar showed 66% when 98% of the bytes were gone.
* The per-chunk ratio (loaded/total of that REQUEST) is what gets weighted, not
* the raw `loaded`, because the request body also carries the multipart
* boundaries and the other form fields — weighting raw bytes would overshoot.
*
* @param {Object} options
*   @param {File} options.file - The file to send.
*   @param {string} [options.name] - Wire file name; defaults to `file.name`.
*   @param {string} options.key_dir - Server-side directory routing key.
*   @param {string|null} [options.tipo] - Ontology tipo of the owning component.
*   @param {number} [options.chunk_size_mb] - >0 = chunked, otherwise single-shot.
*   @param {Object} [options.pool] - Shared connection pool; a private unbounded
*     one is created when absent.
*   @param {number} [options.max_retry=3] - Retries per chunk on TRANSPORT error.
*   @param {Object} [options.callbacks] - All optional:
*     `on_start()`, `on_progress({loaded,total,percent})`,
*     `on_retry({chunk_index,attempt,max_retry})`,
*     `on_chunk({chunk_index,total_chunks})`,
*     `on_done(api_response)`, `on_error(api_response)` — the terminal pair, so a
*     renderer can repaint one queue row without holding the `start()` promise.
* @returns {Object} `{start():Promise<Object>, abort():void, status():string,
*   upload_id():string}` where status is
*   'idle'|'queued'|'running'|'done'|'error'|'aborted'.
*   `upload_id()` is this transfer's identity — the same token every part sends
*   as the `upload_id` multipart field, minted once at creation. Exposed for the
*   queue's cancel-and-sweep; see the note in abort().
*   'queued' is the window between `start()` and the first part the pool admits:
*   a transfer with no socket open yet is NOT uploading, and a queue that cannot
*   distinguish the two shows every pending row as "in progress".
*/
export const create_transfer = function(options) {

	// options
		const file			= options.file
		const name			= options.name || (file && file.name) || 'upload.bin'
		const key_dir		= options.key_dir
		const tipo			= options.tipo
		const chunk_size_mb	= options.chunk_size_mb
		const pool			= options.pool || create_connection_pool(0)
		const max_retry		= typeof options.max_retry === 'number' ? options.max_retry : 3
		const callbacks		= options.callbacks || {}

	// upload_id
		// Minted ONCE per transfer, here — never per part and never per retry. A
		// retried chunk that re-minted would land in a DIFFERENT staging artifact
		// dir and the join would then be missing a part it believes it sent.
		const upload_id = new_upload_id()

	// state
		const total_bytes	= (file && file.size) || 0
		let transfer_status	= 'idle'
		let settled			= false
		// TWO cancellation flags, deliberately distinct:
		//  - `aborted`   : the USER cancelled (abort()). The verdict is "User aborts upload".
		//  - `cancelled` : the TRANSFER already failed and the remaining parts are
		//                  pointless. The verdict must stay the SERVER's diagnosis,
		//                  which is why this cannot reuse `aborted`.
		// Collapsing them would either overwrite a real error message with
		// "User aborts upload" or make a user cancellation look like a server error.
		let aborted			= false
		let cancelled		= false
		let start_promise	= null
		let settle			= null // bound by start()
		// Every XHR this transfer currently owns, so abort() can cancel the whole
		// file and not just whichever chunk happens to be first.
		const live_requests	= new Set()

	// cancel_live_requests
		// Kill every in-flight request of THIS transfer. Used by abort() and by the
		// fail-fast path.
		//
		// (!) This is not a nicety — it is a DISK LEAK fix. Every chunk that
		// completes makes the receiver write `<staging>/<i>-<tmp>.blob`
		// (src/core/media/ingest/upload.ts receiveUpload), and those parts are
		// unlinked ONLY inside joinChunkedUpload. When a transfer has already
		// failed the join never runs, so every chunk still in flight becomes a
		// permanent orphan on the server — a failed 4 GB upload parked ~4 GB of
		// garbage. Letting the survivors finish also kept the progress bar climbing
		// after the caller had already been told the upload failed.
		const cancel_live_requests = function() {
			live_requests.forEach(function(xhr){
				try {
					xhr.abort()
				} catch (error) {
					console.error('upload_transport abort error:', error)
				}
			})
			live_requests.clear()
		}

	// fire
		// Callbacks belong to the CALLER's layer (DOM, labels, queue rows). A
		// throw there must never abort a transfer that is going perfectly well.
		const fire = function(name_of_callback, payload) {
			const callback = callbacks[name_of_callback]
			if (typeof callback !== 'function') {
				return
			}
			try {
				callback(payload)
			} catch (error) {
				console.error('upload_transport callback error in ' + name_of_callback + ':', error)
			}
		}

	// progress state
		// chunk_bytes[i] = the byte size of chunk i; chunk_loaded[i] = how many of
		// those bytes are confirmed sent. Both are dense arrays indexed by chunk.
		const chunk_bytes	= []
		const chunk_loaded	= []
		let last_percent	= -1
		let last_loaded		= 0
		// Part accounting, used ONLY as the zero-byte fallback denominator below.
		let total_parts		= 1
		let done_parts		= 0

	// publish_progress
		const publish_progress = function() {

			let sum = 0
			for (let i = 0; i < chunk_loaded.length; i++) {
				sum += chunk_loaded[i] || 0
			}
			// Monotonic: a retried chunk restarts from zero bytes, and a bar that
			// walks backwards reads as "it broke" even when the retry succeeds.
			const loaded	= Math.max(sum, last_loaded)
			last_loaded		= loaded
			// A ZERO-BYTE file has no bytes to weight, so byte-weighting can only
			// ever yield 0 and a progress-driven renderer would leave a perfectly
			// successful upload stuck at 0%. Fall back to counting PARTS, which is
			// the only meaningful denominator when total_bytes is 0. (The single-file
			// service masks this because it publishes 100 itself on completion; a
			// Phase 3 queue row driven by on_progress alone does not.)
			const percent	= total_bytes
				? Math.min(100, Math.round(loaded / total_bytes * 100))
				: Math.min(100, Math.round(done_parts / (total_parts || 1) * 100))
			// Dedupe on the integer percent: one XHR emits hundreds of progress
			// events and each one would otherwise be a DOM write.
			if (percent === last_percent) {
				return
			}
			last_percent = percent

			fire('on_progress', {
				loaded	: loaded,
				total	: total_bytes,
				percent	: percent
			})
		}//end publish_progress

	// send_part
		// One multipart POST: a chunk, or the whole file in single-shot mode.
		// NEVER rejects — it resolves an outcome object:
		//   {ok:true,  api_response}
		//   {ok:false, aborted:true}                    → user cancelled
		//   {ok:false, cancelled:true}                  → transfer already failed
		//   {ok:false, retryable:true}                  → transport error
		//   {ok:false, msg, api_response?}              → server refusal / bad body
		const send_part = function(part) {

			return new Promise(function(resolve) {

				// Short-circuit anything still queued in the pool: a part that has not
				// opened a socket yet must never open one after the transfer is over,
				// or a cancelled 200-chunk upload keeps writing staging blobs long
				// after the user was shown the error.
					if (aborted) {
						resolve({ ok:false, aborted:true })
						return
					}
					if (cancelled) {
						resolve({ ok:false, cancelled:true })
						return
					}
				// The page-identity latch (LEAD-2): a part is the page's cached state
				// (a file bound to A's record) — never sent under another identity.
				// Terminal, not retryable: the identity does not come back by waiting.
					if (refused_by_page_identity(null)) {
						resolve({
							ok		: false,
							error	: new ApiError({
								code	: CLIENT_ERROR.ABORTED,
								source	: 'transport',
								details	: { reason:'page_identity_revoked', action:'upload' }
							})
						})
						return
					}

				const xhr = new XMLHttpRequest()
				live_requests.add(xhr)

				// finish
					// Single writer of this part's outcome, and the ONLY place the pool
					// slot is released. A double-fire (error + loadend for one failure)
					// must not release twice; a NO-fire must not happen at all — which
					// is what the loadend listener below guarantees.
					let part_settled = false
					const finish = function(outcome) {
						if (part_settled) {
							return
						}
						part_settled = true
						live_requests.delete(xhr)
						resolve(outcome)
					}

				xhr.open('POST', DEDALO_API_URL, true)

				// request headers
					// (!) WIRE CONTRACT — byte-identical to the legacy client. The
					// header ORDER, the field ORDER and the field NAMES are all
					// reproduced exactly; the receiver is src/core/media/ingest/upload.ts.
					// Pinned by test/unit/client_upload_transport.test.ts — biome does
					// not lint client/, so nothing else would notice a drift.
					if (part.chunked && part.end > part.start) {
						// Content-Range: bytes 0-999999/4582884 (RFC 7233: end is
						// INCLUSIVE in the header, exclusive in the slice).
						// (!) Guarded on a NON-EMPTY range: a zero-byte upload emitted
						// `bytes 0--1/0`, which is malformed RFC 7233. Our receiver
						// ignores the header, but an intermediary proxy that parses it
						// may not, and emitting syntactically invalid headers is never
						// the right answer. An empty part simply carries no range.
						const chunk_end = part.end - 1
						xhr.setRequestHeader('Content-Range', 'bytes ' + part.start + '-' + chunk_end + '/' + total_bytes)
					}
					xhr.setRequestHeader('X-File-Name', encodeURIComponent(name))
					// SEC-008 CSRF twin: header + form field, both read fresh.
					const csrf_token = current_csrf_token()
					if (csrf_token) {
						xhr.setRequestHeader('X-Dedalo-Csrf-Token', csrf_token)
					}

				// formdata
					// (!) The receiver currently reads NEITHER Content-Range NOR
					// start/end (it derives everything from chunk_index/total_chunks).
					// They are sent anyway: dropping a field that a deployed server
					// might read is a wire change, and a wire change is not this
					// module's decision.
					// (!) `tipo` is sent ONLY in single-shot mode — exactly as the
					// legacy client did. Adding it to chunks would be a wire change
					// with no reader on the other side.
					// (!) `upload_id` — the transfer's identity, added 2026-08-03 for the
					// staged-identity receiver. Sent on EVERY part, chunked and
					// single-shot, always the same value for one file. Its position is
					// the one placement rule this shape has: it is the LAST SCALAR
					// BEFORE the blob in both modes, so a streaming parser has read the
					// whole routing/identity set before the big part arrives.
					const formdata = new FormData()
					if (part.chunked) {
						formdata.append('key_dir', key_dir)
						formdata.append('file_name', name)
						formdata.append('chunked', true)
						formdata.append('start', part.start)
						formdata.append('end', part.end)
						formdata.append('chunk_index', part.chunk_index)
						formdata.append('total_chunks', part.total_chunks)
						formdata.append('upload_id', upload_id)
						formdata.append('file_to_upload', part.blob)
						if (csrf_token) {
							formdata.append('csrf_token', csrf_token)
						}
					} else {
						formdata.append('key_dir', key_dir)
						formdata.append('file_name', name)
						formdata.append('chunked', false)
						formdata.append('upload_id', upload_id)
						formdata.append('file_to_upload', part.blob)
						formdata.append('tipo', tipo)
						if (csrf_token) {
							formdata.append('csrf_token', csrf_token)
						}
					}

				// progress
					xhr.upload.addEventListener('progress', function(event) {
						// Weight the REQUEST ratio by the chunk's real byte size, so
						// multipart overhead never inflates the total (see the
						// byte-weighting note in the block comment above).
						const ratio = event.total ? (event.loaded / event.total) : 0
						chunk_loaded[part.chunk_index] = Math.min(1, ratio) * (chunk_bytes[part.chunk_index] || 0)
						publish_progress()
					}, false)

				// upload error / abort
					xhr.upload.addEventListener('error', function() {
						finish({ ok:false, retryable:true })
					}, false)
					xhr.upload.addEventListener('abort', function() {
						// `aborted` is set by abort() BEFORE xhr.abort() is called, so
						// this handler never re-enters the retry path on a cancellation:
						// the outcome carries no `retryable` flag at all.
						finish({ ok:false, aborted:true })
					}, false)

				// request-level failures
					// The legacy client listened ONLY on xhr.upload, which covers
					// failures during the REQUEST body. A connection dropped while
					// waiting for the RESPONSE emitted nothing there — another way the
					// outer promise used to hang forever (D1).
					xhr.addEventListener('error', function() {
						finish({ ok:false, retryable:true })
					}, false)
					// (!) `abort` on the XHR ITSELF, not only on xhr.upload. Once the
					// body is fully sent the spec sets the upload-complete flag and
					// abort() then fires ONLY here — so a transfer cancelled while
					// waiting for the response never released its pool slot, and after
					// enough of them the pool deadlocked with in_flight() pinned at the
					// limit and zero sockets open. Invisible in the single-file UI
					// (one transfer, one slot, page reload); fatal for a shared queue.
					xhr.addEventListener('abort', function() {
						finish({ ok:false, aborted:true })
					}, false)
					// Belt and braces: whatever terminal event the browser chose,
					// loadend ALWAYS follows it. If every branch above somehow missed,
					// the slot is still released here and the part reports a retryable
					// failure rather than hanging. finish() is idempotent, so this is
					// inert on every normal path.
					xhr.addEventListener('loadend', function() {
						finish({ ok:false, retryable:true })
					}, false)

				// load
					xhr.addEventListener('load', function(evt) {

						const status		= evt.target.status
						const raw_text		= evt.target.responseText
						const api_response	= JSON_parse_safely(evt.target.response)

						// A non-2xx is a REFUSAL, not a transport glitch: retrying it
						// just repeats the same rejection. Terminal, with the server's
						// own diagnosis attached. Except 502/503/504: a proxy or a
						// restarting server, where one blip must not kill a long
						// transfer; a resent part lands in the same staging slot.
						if (status < 200 || status >= 300) {
							// api_response is forwarded so settle_failure can pass the
							// server's errors[] through. handleMediaUpload returns
							// errors[] with a 400, so omitting it here dropped the array
							// in exactly the case that populates it.
							finish({
								ok			: false,
								error		: api_error_from(api_response, status, raw_text),
								api_response: api_response,
								retryable	: status===502 || status===503 || status===504
							})
							return
						}
						if (!api_response) {
							console.error('Error in XMLHttpRequest load response. Invalid response is received')
							finish({
								ok		: false,
								error	: api_error_from(null, status, raw_text)
							})
							return
						}
						// A 2xx body can still BE a failure envelope (ok:false).
						if (request_failed(api_response) || response_data(api_response) !== true) {
							finish({
								ok			: false,
								error		: api_error_from(api_response, status, raw_text),
								api_response: api_response
							})
							return
						}
						// Count the chunk's bytes as fully sent: the last progress
						// event can lag the load event and would leave the bar short.
						chunk_loaded[part.chunk_index] = chunk_bytes[part.chunk_index] || 0
						publish_progress()

						finish({ ok:true, api_response:api_response })
					}, false)

				// The transfer is only 'running' once a part actually leaves the pool
				// and hits the wire; before that it is 'queued'.
					if (transfer_status === 'queued') {
						transfer_status = 'running'
					}

				xhr.send(formdata)
			})
		}//end send_part

	// send_part_with_retry
		// Retries only TRANSPORT failures, with the legacy 5-second back-off.
		// (!) The legacy condition was `retry_number <= max_retry`, which with
		// max_retry=3 produced FOUR retries and logged "Retry attempt 4/3". The
		// bound here is `attempt < max_retry`: max_retry means max_retry.
		const send_part_with_retry = async function(part) {

			let attempt = 0
			for (;;) {
				const outcome = await send_part(part)
				if (outcome.ok || outcome.aborted || outcome.cancelled || !outcome.retryable) {
					return outcome
				}
				if (attempt >= max_retry) {
					return {
						ok	: false,
						msg	: 'Upload failed after ' + max_retry + ' retries'
					}
				}
				attempt++
				fire('on_retry', {
					chunk_index	: part.chunk_index,
					attempt		: attempt,
					max_retry	: max_retry
				})
				await new Promise(function(resolve_wait){
					setTimeout(resolve_wait, 5000)
				})
				if (aborted) {
					return { ok:false, aborted:true }
				}
				if (cancelled) {
					return { ok:false, cancelled:true }
				}
			}
		}//end send_part_with_retry

	// run_single
		const run_single = async function() {

			total_parts		= 1
			chunk_bytes[0]	= total_bytes
			chunk_loaded[0]	= 0

			// (!) THROUGH THE POOL, exactly like a chunk. The single-shot path used
			// to call send_part_with_retry directly, so the pool's window did not
			// apply to it at all — and single-shot is the COMMON case for a queue
			// (a folder of images under the chunk threshold, or an install with
			// chunking off), which would have made the queue's only concurrency
			// control a no-op precisely where it matters most.
			const outcome = await pool.run(function(){
				return send_part_with_retry({
					blob		: file,
					chunked		: false,
					chunk_index	: 0,
					total_chunks: 1,
					start		: 0,
					end			: total_bytes
				})
			})
			if (outcome.ok) {
				done_parts++
				publish_progress()
				fire('on_chunk', { chunk_index:0, total_chunks:1 })
				settle(outcome.api_response, 'done')
				return
			}
			settle_failure(outcome)
		}//end run_single

	// run_chunked
		const run_chunked = async function() {

			const chunk_size = chunk_size_mb * 1024 * 1024
			// Math.max(1, …): a ZERO-BYTE file yields ceil(0/n) === 0 chunks, so the
			// legacy loop sent nothing, Promise.all([]) resolved instantly, the join
			// never fired and the outer promise hung (another D1 face). One empty
			// part is a well-defined upload; zero parts is a wedge.
			const total_chunks	= Math.max(1, Math.ceil(total_bytes / chunk_size))
			const files_chunked	= []
			let last_file_data	= null
			total_parts			= total_chunks

			const parts = []
			let start = 0
			for (let i = 0; i < total_chunks; i++) {
				const check_end	= start + chunk_size
				const end		= (total_bytes - check_end < 0)
					? total_bytes
					: check_end
				chunk_bytes[i]	= end - start
				chunk_loaded[i]	= 0
				parts.push({
					blob		: slice(file, start, end),
					chunked		: true,
					chunk_index	: i,
					total_chunks: total_chunks,
					start		: start,
					end			: end
				})
				start += chunk_size
			}

			// Every part goes through the shared pool, which is what bounds the
			// simultaneous connections. Promise.all is safe because send_part_with_retry
			// never rejects — the failures arrive as values.
			let first_failure = null
			const outcomes = await Promise.all(parts.map(function(part){
				return pool.run(function(){
					return send_part_with_retry(part)
				}).then(function(outcome){
					// FAIL FAST + CANCEL THE REST. Reporting the failure is only half
					// of it: the surviving chunks must also be stopped. Each one that
					// completes makes the receiver write a staging blob that ONLY the
					// join deletes — and after a failure the join never runs, so every
					// survivor is a permanent orphan on the server's disk. They also
					// kept driving on_progress upwards after the caller had already
					// been told the upload failed.
					// `cancelled` (not `aborted`) so the settled msg stays the SERVER's
					// diagnosis instead of "User aborts upload".
					if (!outcome.ok && first_failure === null) {
						first_failure = outcome
						cancelled = true
						cancel_live_requests()
						settle_failure(outcome)
					}
					if (outcome.ok) {
						// Only feeds the zero-byte progress fallback; the byte-weighted
						// path is already driven by chunk_loaded.
						done_parts++
						publish_progress()
					}
					return outcome
				})
			}))
			if (first_failure !== null) {
				return
			}

			for (let i = 0; i < outcomes.length; i++) {
				const outcome = outcomes[i]
				const file_data = outcome.api_response.file_data
				if (file_data) {
					// The server echoes the staged temp name per chunk; index by OUR
					// chunk index rather than the echoed one so a server that omits it
					// cannot silently collapse the array (which would make the join
					// assemble the wrong number of parts).
					files_chunked[i]	= file_data.tmp_name
					last_file_data		= file_data
				}
				fire('on_chunk', {
					chunk_index		: i,
					total_chunks	: total_chunks
				})
			}

			if (aborted) {
				settle({
					ok		: false,
					error	: new ApiError({
						code	: CLIENT_ERROR.ABORTED,
						message	: 'Upload aborted'
					})
				}, 'aborted')
				return
			}

			// Join. `start()` resolves with the JOIN's response, so the caller
			// receives ONE file_data describing the final assembled file — never a
			// per-chunk descriptor it would have to reassemble itself.
			try {
				const join_response = await join_chunked_files({
					file_data		: last_file_data,
					files_chunked	: files_chunked,
					is_stopped		: () => aborted || cancelled
				})
				if (!join_response || request_failed(join_response) || response_data(join_response) !== true) {
					settle({
						ok		: false,
						error	: api_error_from(join_response || null, 200)
					}, 'error')
					return
				}
				settle(join_response, 'done')
			} catch (error) {
				// data_manager.request throws on an exhausted retry budget. Without
				// this catch the rejection would escape into an unhandled promise and
				// the caller would hang exactly as in D1.
				settle({
					ok		: false,
					error	: new ApiError({
						code	: CLIENT_ERROR.BAD_RESPONSE,
						message	: 'Error joining the uploaded chunks. ' + to_text(error && error.message)
					})
				}, 'error')
			}
		}//end run_chunked

	// settle_failure
		// Maps a part outcome onto the ONE failure shape the caller renders.
		const settle_failure = function(outcome) {

			if (outcome.aborted) {
				settle({
					ok		: false,
					error	: new ApiError({
						code	: CLIENT_ERROR.ABORTED,
						message	: 'User aborts upload'
					})
				}, 'aborted')
				return
			}
			// `cancelled` parts are collateral of an ALREADY-settled failure: the
			// real verdict was recorded by the part that failed first. Never let one
			// of them reach settle() with a message of its own.
			if (outcome.cancelled) {
				return
			}
			// ONE failure shape, the same the page transport answers with: an
			// `error` ApiError the caller renders through error_text(). The
			// server's own diagnosis rides inside it (code + message), so nothing
			// has to be re-derived from prose.
			const response = {
				ok		: false,
				error	: outcome.error || new ApiError({
					code	: CLIENT_ERROR.BAD_RESPONSE,
					message	: 'Error on upload file'
				})
			}
			settle(response, 'error')
		}//end settle_failure

	// start
		const start = function() {

			// Idempotent: a second start() returns the SAME promise instead of
			// launching a second set of XHRs against the same staging name.
			if (start_promise) {
				return start_promise
			}

			start_promise = new Promise(function(resolve) {

				settle = function(api_response, next_status) {
					if (settled) {
						if (typeof SHOW_DEBUG !== 'undefined' && SHOW_DEBUG === true) {
							console.log('upload_transport: settle called twice, ignored', next_status)
						}
						return
					}
					settled				= true
					transfer_status		= next_status
					// Terminal callbacks. A renderer that owns ONE row of a queue needs
					// to repaint on completion without holding (and awaiting) every
					// start() promise; the promise stays the caller-facing result, these
					// are the push notification of the same event. Fired BEFORE resolve
					// so a row is never repainted after the caller has already reacted.
					if (next_status === 'done') {
						fire('on_done', api_response)
					} else {
						fire('on_error', api_response)
					}
					resolve(api_response)
				}

				// 'queued', not 'running': until the pool actually admits a part this
				// transfer has no socket open, and a queue UI that cannot tell waiting
				// from uploading shows N rows all claiming to be in progress. The first
				// real byte movement (on_start of the first part) flips it to 'running'.
				transfer_status = 'queued'
				fire('on_start', {})

				// The whole run is wrapped: ANY unforeseen throw still settles the
				// promise, because a transport that can hang is worse than one that
				// reports an error it does not understand.
				const runner = (chunk_size_mb > 0)
					? run_chunked
					: run_single
				runner().catch(function(error){
					console.error('upload_transport unexpected error:', error)
					settle({
						ok		: false,
						error	: new ApiError({
							code	: CLIENT_ERROR.BAD_RESPONSE,
							message	: 'Unexpected upload error. ' + to_text(error && error.message)
						})
					}, 'error')
				})
			})

			return start_promise
		}//end start

	// abort
		const abort = function() {

			// (!) ORDER IS LOAD-BEARING: the flag is raised BEFORE xhr.abort(), so
			// the "abort" listeners (which fire synchronously from abort()) see a
			// user cancellation and do not schedule a retry of a transfer the user
			// just cancelled.
			aborted = true
			cancel_live_requests()
			// (!) NOT swept from here. The server accepts `upload_id` on
			// dd_utils_api::delete_uploaded_file for an immediate cancel-and-sweep
			// instead of waiting for the 24h orphan GC — but firing it here would
			// make the transport know a second API action, own its failure handling,
			// and decide a retention policy, none of which is transport's business.
			// The queue layer already calls that action and already has
			// `upload_id()` + key_dir + name from this handle, so the sweep belongs
			// there, where cancel is a user gesture with a UI to report into.
			// A transfer aborted while still waiting in the pool has no live XHR to
			// emit anything, so settle here too. settle() is idempotent, so an abort
			// that races a completion cannot overwrite the real outcome.
			if (settle) {
				settle({
					ok		: false,
					error	: new ApiError({
						code	: CLIENT_ERROR.ABORTED,
						message	: 'User aborts upload'
					})
				}, 'aborted')
			} else {
				transfer_status = 'aborted'
			}
		}//end abort

	// status
		const status = function() {
			return transfer_status
		}


	// upload_id accessor
		// Exposed so the queue layer can run the cancel-and-sweep
		// (dd_utils_api::delete_uploaded_file) without the transport having to know
		// that action exists — see the note in abort().
		const get_upload_id = function() {
			return upload_id
		}


	return {
		start		: start,
		abort		: abort,
		status		: status,
		upload_id	: get_upload_id
	}
}//end create_transfer



// @license-end
