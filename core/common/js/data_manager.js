// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_label, page_globals, SHOW_DEBUG, DEDALO_CORE_URL, DEDALO_API_URL, Promise */
/*eslint no-undef: "error"*/



// imports
	import {JSON_parse_safely} from '../../../core/common/js/utils/util.js'
	import {event_manager} from './event_manager.js'



// Custom error classes
// @see _fetch_with_retry_and_timeout
class HttpError extends Error {
	constructor(status, statusText, response) {
		super(`HTTP ${status}: ${statusText}`);
		this.name = 'HttpError';
		this.status = status;
		this.statusText = statusText;
		this.response = response;
	}
}



/**
* DATA_MANAGER
*/
export const data_manager = function() {

}//end data_manager



/**
* GET_API_URL
* Get API URL from environment with fallback to default value
* @return string
*/
export const get_api_url = () => {
	return typeof DEDALO_API_URL !== 'undefined' ? DEDALO_API_URL : '../api/v1/json/'
}//end get_api_url



/**
* GET_API_HEALTH_URL
* Get API health endpoint URL
* @return string
*/
export const get_api_health_url = () => {
	return get_api_url() + 'health/'
}//end get_api_health_url



/**
* CHECK_SERVER_HEALTH
* Checks a lightweight PHP endpoint specifically for health checks.
* @return bool
*/
export const check_server_health = async () => {
	try {
		const url = get_api_health_url() + '?time=' + performance.now() + Math.floor(Math.random() * 1000)
		const response = await fetch( url, {
			method: 'GET',
			cache: 'no-cache'
		});
		return response.ok;
	} catch (error) {
		return false;
	}
}//end check_server_health



/**
* REQUEST_LEGACY
* Make a fetch request to server API
* Receives a JSON string to be parsed
* @param object options
* @return api_response
* 	Promise
*/
data_manager.request_legacy = async function(options) {

	const self = this

	const default_options = {
		url			: typeof DEDALO_API_URL !== 'undefined' ? DEDALO_API_URL : '../api/v1/json/',
		method		: 'POST', // *GET, POST, PUT, DELETE, etc.
		mode		: 'cors', // no-cors, cors, *same-origin
		cache		: 'no-cache', // *default, no-cache, reload, force-cache, only-if-cached
		credentials	: 'same-origin', // include, *same-origin, omit
		headers		: {'Content-Type': 'application/json'}, // 'Content-Type': 'application/x-www-form-urlencoded'
		redirect	: 'follow', // manual, *follow, error
		referrer	: 'no-referrer', // no-referrer, *client
		body		: null, // body data type must match "Content-Type" header
		use_worker	: false
	};

	const merged_options = { ...default_options, ...options };

	// vars from options applying defaults
	const { url, method, mode, cache, credentials, headers, redirect, referrer, body, use_worker } = merged_options;

	// Debug request
	if (typeof SHOW_DEBUG !== 'undefined' && SHOW_DEBUG === true) {
		const action		= body?.action || 'load';
		const worker_label	= use_worker ? '[wk] ' : ''
		console.warn(`> data_manager request ${worker_label}${method}:`, action.toUpperCase(), merged_options);
	}

	// recovery mode. Auto add if environment recovery_mode is true
	// On set to true, it is passed across all API request calls preserving the mode
	if (page_globals.recovery_mode && body) {
		body.recovery_mode = true
	}

	 // Reset page_globals.api_errors at the beginning of each request
	page_globals.api_errors = [];
	page_globals.request_message = null; // Reset request message

	// Check URL
	if (!url || !url.length) {
		const msg = 'Error: empty or invalid API URL';
		console.error(msg, { typeof: typeof url, value: url });
		self._record_api_error(
			'data_manager', // error_type
			msg, // message
			'data_manager URL validation', // trace
			null // details
		)
		return {
			result	: false,
			msg		: msg,
			error	: 'URL is not valid',
			errors	: ['URL is not valid']
		};
	}

	// using worker cases.
	// Note that execution is slower, but it is useful for low priority
	// calls like 'update_lock_components_state'
	// (!) Deactivated 22-05-2025 temporally to simplify network issues debug
	// if (use_worker === true) {
	// 	return this._handle_worker_request(url, body);
	// }

	// handle_errors
	const handle_errors = async (response) => {
		if (!response.ok) {
			console.warn("-> HANDLE_ERRORS response:", response);
			// extract response text to console
			const response_text = await response.text();
			console.error(response_text);
			self._record_api_error(
				'data_manager', // error_type
				response_text, // message
				'data_manager fetch handle_errors', // trace
				null // details
			)
			throw new Error(response.statusText || `HTTP error! status: ${response.status}`);
		}
		return response;
	}

	try {
		const fetch_response = await fetch(url, {
			method		: method,
			mode		: mode,
			cache		: cache,
			credentials	: credentials,
			headers		: headers,
			redirect	: redirect,
			referrer	: referrer,
			body		: body ? (typeof body === 'string' ? body : JSON.stringify(body)) : null
		})

		const json_response = await (await handle_errors(fetch_response)).json();

		// error occurred. Catch and alert
			if (json_response?.error) {

				// debug console message
				console.error("data_manager request api_response:", json_response);

				// update_lock_components_state fails. Do not send alert here
				const action = body?.action;
				if (action !== 'update_lock_components_state') {
					// alert msg to user
					const msg = json_response.msg || json_response.error;
					if (!page_globals.request_message || page_globals.request_message !== msg) {
						alert(`An error has occurred in the API connection\n[data_manager.request]\n\n${msg}`);
					}
					// request_message. Store request message temporally
					page_globals.request_message = msg;
					setTimeout(() => {
						page_globals.request_message = null;
					}, 3000);
				}

				// save error message. This is captured by page rendering to display the proper error
				// api_errors. store api_errors. Used to render error page_globals
				self._record_api_error(
					'data_manager', // error_type
					json_response.msg || json_response.error, // message
					'data_manager json_parsed', // trace
					json_response.errors?.length ? json_response.errors.join(' | ') : '' // details
				)

				return json_response;
			}

		return json_response;

	} catch (error) {

		console.warn('request url:', typeof url, url);
		console.warn("request options:", options);
		console.error("!!!!! [data_manager.request] SERVER ERROR. Received data is not JSON valid or network error. See your server log for details. catch ERROR:\n", error);

		// api_errors. store api_errors. Used to render error page_globals
		self._record_api_error(
			'data_manager', // error_type
			error.message || 'Network error or invalid JSON', // message
			'data_manager catch error', // trace
			error // details
		)

		return {
			result	: false,
			msg		: error.message || 'Network error',
			error	: error,
			errors	: [error.message || 'Network error'],
		};
	}
}//end request_legacy



/**
* REQUEST
* Make a fetch request to server API
* Receives a JSON string to be parsed
* @param object options
* @return api_response
* 	Promise
*/
data_manager.request = async function(options) {

	const self = this

	const default_options = {
		url			: get_api_url(),
		method		: 'POST', // *GET, POST, PUT, DELETE, etc.
		mode		: 'cors', // no-cors, cors, *same-origin
		cache		: 'no-cache', // *default, no-cache, reload, force-cache, only-if-cached
		credentials	: 'same-origin', // include, *same-origin, omit
		headers		: {'Content-Type': 'application/json'}, // 'Content-Type': 'application/x-www-form-urlencoded'
		redirect	: 'follow', // manual, *follow, error
		referrer	: 'no-referrer', // no-referrer, *client
		body		: null, // body data type must match "Content-Type" header
		use_worker	: false,
		retries		: 5, // default request retries int
		base_delay	: 500, // default base delay in ms
		timeout		: 5000 // default timeout in ms
	};

	const merged_options = { ...default_options, ...options };

	// vars from options applying defaults
	const { url, method, mode, cache, credentials, headers, redirect, referrer, body, use_worker, retries, base_delay, timeout } = merged_options;

	// Debug request
	if(SHOW_DEBUG) {
		const action		= body?.action || 'load';
		const worker_label	= use_worker ? '[wk] ' : ''
		const source_model	= body?.source?.model || ''
		console.warn(`> data_manager request ${worker_label}${method}:`, action.toUpperCase(), source_model, merged_options);
	}

	// recovery mode. Auto add if environment recovery_mode is true
	// On set to true, it is passed across all API request calls preserving the mode
	if (page_globals.recovery_mode && body) {
		if (typeof body === 'object') {
			body.recovery_mode = true;
		}
	}

	// Reset page_globals.api_errors at the beginning of each request
	page_globals.api_errors = [];
	page_globals.request_message = null; // Reset request message

	// Check URL
	if (!url || !url.length) {
		const msg = 'Error: empty or invalid API URL';
		console.error(msg, { typeof: typeof url, value: url });
		self._record_api_error(
			'data_manager', // error_type
			msg, // message
			'data_manager URL validation', // trace
			null // details
		)
		return {
			result	: false,
			msg		: msg,
			error	: 'URL is not valid',
			errors	: ['URL is not valid']
		};
	}
	// Adding 'time' param prevents potential proxy problems in 'no-cache' calls
	// 'time' param is ignored by the API endpoint (@see ../json/index.php)
	const safe_url = merged_options.cache === 'no-cache'
		? url + '?time=' + performance.now() + Math.floor(Math.random() * 1000)
		: url

	// using worker cases.
		// Note that execution is slower, but it is useful for low priority
		// calls like 'update_lock_components_state'
		// (!) Deactivated 22-05-2025 temporally to simplify network issues debug
		// if (use_worker === true) {
		// 	return this._handle_worker_request(url, body);
		// }

	// handle_errors
	const handle_errors = async (response) => {
		if (!response.ok) {
			console.warn("-> HANDLE_ERRORS response:", response);
			// extract response text to console
			let response_text;
			try {
				response_text = await response.text();
			} catch (textError) {
				response_text = `Failed to read response text: ${textError.message}`;
			}
			console.error(response_text);
			self._record_api_error(
				'data_manager', // error_type
				response_text, // message
				'data_manager fetch handle_errors', // trace
				null // details
			);
			throw new Error(response.statusText || `HTTP error! status: ${response.status}`);
		}
		return response;
	}

	try {
		const request_start_time = performance.now();

		// Prepare body for request
		let request_body = null;
		if (body) {
			if (typeof body === 'string') {
				request_body = body;
			} else {
				try {
					request_body = JSON.stringify(body);
				} catch (jsonError) {
					throw new Error(`Failed to serialize request body: ${jsonError.message}`);
				}
			}
		}

		// exec fetch with retry and timeout
		const fetch_response = await _fetch_with_retry_and_timeout(
			safe_url,
			{
				method		: method,
				mode		: mode,
				cache		: cache,
				credentials	: credentials,
				headers		: headers,
				redirect	: redirect,
				referrer	: referrer,
				body		: request_body
			},
			retries,
			base_delay,
			timeout
		)

		const data_start_time = performance.now();

		// Parse API JAON response handling errors
		const json_response = await (await handle_errors(fetch_response)).json();

		if(SHOW_DEBUG) {
			console.log(`_*_Time to request: ${(performance.now() - request_start_time).toFixed(2)}ms`);
			console.log(`_*_Time to download data: ${(performance.now() - data_start_time).toFixed(2)}ms`);
		}

		// Error occurred. Catch and alert
		if (json_response?.error) {

			// debug console message
			console.error("data_manager request api_response:", json_response);

			// update_lock_components_state fails. Do not send alert here
			const action = body?.action;
			if (action !== 'update_lock_components_state') {
				// alert msg to user
				const msg = json_response.msg || json_response.error;
				if (!page_globals.request_message || page_globals.request_message !== msg) {
					render_msg_to_inspector(
						`An error has occurred in the API connection\n[data_manager.request]\n\n${msg}`,
						'error',
						10000
					);
				}
				// request_message. Store request message temporally
				page_globals.request_message = msg;
				setTimeout(() => {
					page_globals.request_message = null;
				}, 3000);
			}

			// save error message. This is captured by page rendering to display the proper error
			// api_errors. store api_errors. Used to render error page_globals
			self._record_api_error(
				'data_manager', // error_type
				json_response.msg || json_response.error, // message
				'data_manager json_parsed', // trace
				json_response.errors?.length ? json_response.errors.join(' | ') : '' // details
			)

			return json_response;
		}

		return json_response;

	} catch (error) {

		console.warn('request url:', typeof url, url);
		console.warn("request options:", options);
		console.error("!!!!! [data_manager.request] SERVER ERROR. Received data is not JSON valid or network error. See your server log for details. catch ERROR:\n", error);

		// api_errors. store api_errors. Used to render error page_globals
		self._record_api_error(
			'data_manager', // error_type
			error.message || 'Network error or invalid JSON', // message
			'data_manager catch error', // trace
			error // details
		)

		return {
			result	: false,
			msg		: error.message || 'Network error',
			error	: error,
			errors	: [error.message || 'Network error'],
		};
	}
}//end request



/**
* _FETCH_WITH_RETRY_AND_TIMEOUT
* Make a fetch request to server API
* Receives a JSON string to be parsed
* Note: Revised by Chat GPT Copilot
* @param string url
* 	The URL for the fetch request.
* @param object options = {}
* 	Additional options for the fetch (such as headers, method, etc.).
* @param int retries = 5
* 	Number of times the fetch will retry in case of failure.
* @param int base_delay = 500
* 	The initial delay between retries (in milliseconds). It will exponentially increase with each failed attempt.
* @param int timeout = 5000
* 	The timeout limit for the request (in milliseconds). If the request exceeds this time, it will be aborted.
* @return response
* 	Promise APi response
*/
async function _fetch_with_retry_and_timeout(url, options = {}, retries = 5, base_delay = 500, timeout = 5000) {

	let attempts = 0;

	while (attempts < retries) {
		attempts++;

		if(SHOW_DEBUG && attempts > 1) {
			console.log('Trying : ', attempts);
		}

		// Delay between tries. Exponential backoff
		const delay = base_delay * Math.pow(2, attempts - 1); // Fixed: attempts-1 for proper backoff

		// Increase timeout in each API call
		const current_time_out = attempts === 1
			? timeout
			: timeout + delay

		// Create a controller for the request in each iteration
		const controller = new AbortController();
		const signal = controller.signal;

		// Set the controller timeout and get his ID
		const timeout_id = setTimeout(() => controller.abort(), current_time_out);

		// check_long_process_time
		// If there is no response from the server within the assigned timeout period,
		// the server will be asked for its status (minimum health request).
		// If the server responds before the timeout ends, the timeout will be removed
		// to allow time to complete the main request (a long process probably).
		const check_long_process_time = parseInt( current_time_out / 2 )
		const server_health_timeout_id = setTimeout(async () => {
			try {
				// fast API call to check health
				const is_server_health = await check_server_health()
				if (is_server_health) {
					// Clear main timeout to prevent fire the signal timeout
					// This allows to wait until main request ends (stops new tries).
					clearTimeout(timeout_id);
					const msg = 'Awaiting for busy server..'
					if(SHOW_DEBUG) {
						console.log(msg);
					}
					render_msg_to_inspector(msg, 'warning', delay + 3000);
				}
			} catch (health_error) {
				// Handle health check errors silently or log them
				if(SHOW_DEBUG) {
					console.log('Health check failed:', health_error.message);
				}
			}

		},  check_long_process_time)

		try {

			// Attempt the fetch request with timeout and retry logic
			const response = await fetch(url, { ...options, signal });

			// Clear timeouts once fetch completes
			clearTimeout(timeout_id);
			clearTimeout(server_health_timeout_id);

			// Handle HTTP errors (4xx, 5xx)
			if (!response?.ok) {
				throw new HttpError(response.status, response.statusText, response);
			}

			return response;
		} catch (error) {

			// ensure cleanup timeouts if fetch throws before completion
			clearTimeout(timeout_id);
			clearTimeout(server_health_timeout_id);

			// HttpError. Don't retry on client errors (4xx) except 408, 429
			if (error instanceof HttpError) {
				// notify to user
				const msg = `Server responded with status ${error.status}`;
				render_msg_to_inspector(msg, 'warning', 7000);

				const retryableStatuses = [408, 429, 500, 502, 503, 504];
				if( !retryableStatuses.includes(error.status) ) {
					const msg = `Not retry-able HTTP error ${error.status}`;
					render_msg_to_inspector(msg, 'error', null);
					console.error(msg);
					throw new Error(msg);
				}
			}

			// AbortError. Controller abort case
			if (error.name === 'AbortError') {
				// notify to user
				const msg = `Request (${attempts}) timed out after ${current_time_out/1000}s`
				render_msg_to_inspector(msg, 'warning', delay + 3000);
				console.error(msg);
			}

			// TypeError. Network error
			if (error instanceof TypeError && error.message.includes('fetch')) {
				// notify to user
				const msg = `Network connection failed`
				render_msg_to_inspector(msg, 'warning', delay + 3000);
				console.error(msg);
			}

			// If we've exhausted the retries, throw error
			if (attempts >= retries) {
				const msg = 'Max retries reached, request failed.';
				render_msg_to_inspector(msg, 'error', null);
				throw new Error(msg);
			}

			// Exponential backoff: increase delay between retries
			{
				const msg = `Retrying in ${delay}ms. Please wait...`
				render_msg_to_inspector(msg, 'warning', delay + 3000);
				if(SHOW_DEBUG) {
					console.log(`Retrying in ${delay}ms...`);
				}
				await new Promise(resolve => setTimeout(resolve, delay));
			}
		}
	}
}//end _fetch_with_retry_and_timeout



/**
* _FETCH_WITH_RACE
* Launch n retries in a race promise and abort all on finish.
* @return object api_response
*/
async function _fetch_with_race(url, options = {}, retries = 5, base_delay = 500, timeout = 5000) {

	// Create a controller in each iteration
	const controller = new AbortController();
	const signal = controller.signal;

	const race_calls = []
	const total_timeout = timeout * retries
	for (let i = 0; i < retries; i++) {

		const delay = (i==0)
			? 0
			: base_delay * Math.pow(2, i+1);

		const api_response = new Promise(function(resolve){
			if(SHOW_DEBUG) {
				console.log('Promise :', i+1 + ' - delay: ' + delay);
			}
			setTimeout(() => {
				resolve(
					fetch(url, { ...options, signal })
				)
			}, delay);
		})
		// const api_response = new Promise(resolve => setTimeout(resolve, 6000));

		race_calls.push(api_response)
	}
	// Add a total timeout to the race to prevent an infinite wait.
	race_calls.push( new Promise(resolve => setTimeout(resolve, total_timeout)) )

	try {
		const api_response = await Promise.race(race_calls)

		// Handle HTTP errors (4xx, 5xx)
		if (!api_response?.ok) {
			controller.abort();
			throw new Error(api_response);
		}

		// set the controller to abort after parse JSON
		api_response.controller = controller

		return api_response
	} catch (error) {
		controller.abort();
		// Error case
		console.error("RACE failed with error:", error);
		const msg = 'Max retries reached, request failed. ' + error;
		throw new Error(msg)
	}
}//end fetch_with_race



/**
* RENDER_MSG_TO_INSPECTOR
* Manages the inspector notifications using a 'notification' event
* @param string msg
* @param string type
* @param int|null remove_time
* @return void
*/
export const render_msg_to_inspector = (msg, type, remove_time) => {

	event_manager.publish('notification', {
		msg			: msg,
		type		: type,
		remove_time	: remove_time
	})
}//end render_msg_to_inspector



/**
* _HANDLE_WORKER_REQUEST
* Manages the worker API request
* @param string url
* @param object body
* @param object options
* @return api_response
*/
data_manager._handle_worker_request = function(url, body) {

	return new Promise((resolve, reject) => {
		try {
			const current_worker = new Worker(DEDALO_CORE_URL + '/common/js/worker_data.js', {
				type: 'module'
			});

			current_worker.postMessage({ url, body });

			current_worker.onerror = (event) => {
				console.error("There is an error with current worker error!", event);
				this._record_api_error('data_manager', 'Worker error', 'worker onerror', event);
				current_worker.terminate();
				reject(this._create_error_response('Worker error', event.message));
			};

			current_worker.onmessage = (e) => {
				if (!e.data?.api_response) {
					const error_message = 'Error in worker response: missing api_response';
					console.error(error_message, 'e.data:', e.data);
					this._record_api_error('data_manager', error_message, 'worker onmessage', e.data);
					current_worker.terminate();
					reject(this._create_error_response(error_message, 'Missing API response from worker'));
					return;
				}
				current_worker.terminate();
				resolve(e.data.api_response);
			};
		} catch (error) {
			console.error("Error creating worker:", error);
			this._record_api_error('data_manager', error.message, 'worker creation');
			reject(this._create_error_response(error.message, 'Failed to create worker'));
		}
	}).catch(error => {
		console.error("Worker Promise Catch:", error);
		this._record_api_error('data_manager', error.message, 'data_manager worker catch error');
		return this._create_error_response(error.message, error);
	});
}//end _handle_worker_request



data_manager._record_api_error = function(error_type, message, trace, details = null) {
	page_globals.api_errors.push({
		error	: error_type,
		msg		: message,
		trace	: trace,
		details	: details,
	});
}//end _record_api_error



data_manager._create_error_response = function(msg, error) {
	return {
		result	: false,
		msg		: msg,
		error	: error,
		errors	: [msg],
	};
}//end _create_error_response



/**
* REQUEST_STREAM
* Make a fetch request_stream to server API
* Note that, unlike 'request', this method receives a stream that must be read by a reader 'getReader'.
* The 'is_stream' body property indicates that server must parse the result as readable stream
* with header("Content-Type: text/event-stream")
* @see ReadableStream: https://developer.mozilla.org/en-US/docs/Web/API/ReadableStream/ReadableStream
* @param object options
* @return api_response
*/
data_manager.request_stream = async function(options) {

	// short vars
	const url			= options.url || (typeof DEDALO_API_URL!=='undefined' ? DEDALO_API_URL : '../api/v1/json/')
	const method		= options.method || 'POST' // *GET, POST, PUT, DELETE, etc.
	const mode			= options.mode || 'cors' // no-cors, cors, *same-origin
	const cache			= options.cache || 'no-cache' // *default, no-cache, reload, force-cache, only-if-cached
	const credentials	= options.credentials || 'same-origin' // include, *same-origin, omit
	const headers		= options.headers || {
		'Content-Type'		: 'application/json',
		'Accept'			: 'text/event-stream',
		'Content-Encoding'	: 'none',
	}
	const redirect		= options.redirect || 'follow' // manual, *follow, error
	const referrer		= options.referrer || 'no-referrer' // no-referrer, *client
	const body			= options.body // body data type must match "Content-Type" header
	// always force the request as a stream
	body.is_stream = true

	return new Promise(function(resolve){

		fetch(
			url,
			{
				method		: method,
				mode		: mode,
				cache		: cache,
				credentials	: credentials,
				headers		: headers,
				redirect	: redirect,
				referrer	: referrer,
				body		: JSON.stringify(body)
			}
		)
		.then(response => {

			// Get the readable stream from the response body
			const stream = response.body;

			resolve(stream)
		})
		.catch(error => {
			// Log the error
			console.error(error);
		});
	})
}//end request_stream



/**
* READ_STREAM
* Read a SSE ReadableStream from server API response
* @see ReadableStream: https://developer.mozilla.org/en-US/docs/Web/API/ReadableStream/getReader
* @param ReadableStream stream
* 	from fetch response.body
* @param function on_read
* 	callback function fired for each reader chunk
* @param function on_done
* 	callback function fired on reader done (close read)
* @param function|null on_error
* 	optional callback function fired on reader error (connection lost, etc.)
* @return void
*/
data_manager.read_stream = function(stream, on_read, on_done, on_error=null) {

	// Get the reader from the stream
	const reader = stream.getReader();

	// register reader (allow stop on page navigation)
	page_globals.stream_readers.push(reader)

	// exec previous callback
	on_read({
		data : {
			msg : 'Preparing data...'
		},
		is_running	: true
	}, reader)

	const ar_chunks = []
	// Define a function to read each chunk
	const readChunk = () => {
		// Read a chunk from the reader

		reader.read()
			.then(({
				value,
				done
			}) => {

				// Check if the stream is done
				if (done) {
					// Log a message
					console.log('Stream finished', done, value);
					// exec callback function on_done
					on_done(true)
					// Return from the function
					return;
				}

				// CHEKING THE STRING TO DETERMINATE THE MSG SENT
				// The event message always begins with "data:\n" and end with "\n\n"
				// PHP create the message correctly, but HTTP server can split it or merge it into a chunk
				// Why is not coherent ???? (only gods knows!)
				// So, every value received needs to be analyzed to determinate:
				//	1 - It's a full message, perfect! the message is OK.
				// 	2 - It's a part (message divided in parts, then need to be joined to get the message)
				//	3 - It has more than 1 message (merged, then need to be split to get the message)

				// Get the last two character of the value
				// it will be check to determinate if the value is the final message
				const last		= value[value.length-1]
				const previous	= value[value.length-2]

				// Convert the chunk value to a string
				// every chuck is decoded and analyzed to determinate if the message is a part or it's a full
					const chunk_string		= new TextDecoder().decode(value);

					// split the string by the initial string: data:\n
					const chunk_split_in	= chunk_string.split('data:\n');
					// split again the string with the end string and initial
					// this case has two message in one chunk, so delete the previous message because is complicate to rebuild it
					// and it's not the final message (the message has new one that begins with "data:\n")
					const chunk_split_in2	= chunk_string.split('\n\ndata:\n');
					// in the case that the string has two o more message deletes previous stored message and begins again.
					if(chunk_split_in2.length > 1){
						// reset the array
						ar_chunks.length = 0
					}
					// check if the split has information (some messages can be empty)
					// and get the last one or previous (empty message will be discarded)
					const valid_chunk = chunk_split_in.length >1 && !chunk_split_in[chunk_split_in.length-1].length
						?  chunk_split_in[chunk_split_in.length-2]
						:  chunk_split_in[chunk_split_in.length-1]
					//add the valid chuck into the array, is used to add divided messages into 1 valid.
					ar_chunks.push(valid_chunk)

				// if the value indicate the is the final part of the message, decode it and get the JSON
				// if not, the message is incomplete and can't be processed and showed.
				if(last === 10 && previous === 10){

					// join the messages parts into one string
					// and parse message response as JSON
					// JSON_parse_safely is needed to check and don't stop the event loop
					// BUT only a valid JSON is expected here.
					const data_string	= ar_chunks.join('')
					const sse_response	= JSON_parse_safely(data_string) || {
						data : {
							msg : 'JSON invalid SSE message'
						},
						is_running	: true,
						errors		: ['Invalid JSON message'],
						total_time	: '0 sec',
						data_string	: data_string
					}

					// reset the array
					ar_chunks.length = 0

					if(sse_response){
						// exec callback function on_read
						on_read(sse_response, reader)
					}
				}

				// Read the next chunk
				readChunk();
			})
			.catch(error => {
				// Log the error
				console.error(error);
				// exec optional callback function on_error
				if (typeof on_error==='function') {
					on_error(error)
				}
			});
	};
	// Start reading the first chunk
	readChunk();
}//end read_stream



/**
* GET_ELEMENT_CONTEXT
* Resolves full element context based on minimal source vars
* Like:
*	source = {
*		model: "component_input_text"
*		tipo: "test159"
*		section_tipo: "test65"
*		section_id: null
*		mode: "search"
*	}
* @param object source
* @return promise api_response
*/
data_manager.get_element_context = async function(source) {

	// api request
	const api_response = await this.request({
		body : {
			action			: 'get_element_context',
			prevent_lock	: true,
			source			: source
		}
	})


	return api_response
}//end get_element_context



/**
* RESOLVE_MODEL
* Resolves element simple context and extract the model
* from the response object
* Used in ts_object.js to resolve components model to load
* @param string tipo
* @param string section_tipo
* @return string|null model
*/
data_manager.resolve_model = async function(tipo, section_tipo) {

	// cache from page_globals
		const cache_key = tipo
		page_globals.models = page_globals.models || {}
		if (page_globals.models[cache_key]) {
			return page_globals.models[cache_key]
		}

	// api request
		const api_response = await this.request({
			body : {
				action			: 'get_element_context',
				prevent_lock	: true,
				simple			: true, // force simple context here
				source			: {
					tipo			: tipo,
					section_tipo	: section_tipo
				}
			}
		})

	// model from context simple response
		const model = api_response.result?.model || null

	// store in cache
		page_globals.models[cache_key] = model


	return model
}//end resolve_model



/**
* GET_ONTOLOGY_INFO
* Request API info about current tipo, resolving
* section_tipo and section_id from given tipo
* @param string tipo
* @return object ontology_info
*/
data_manager.get_ontology_info = async function(tipo) {

	// cache from page_globals
		const cache_key = tipo
		page_globals.ontology_info = page_globals.ontology_info || {}
		if (page_globals.ontology_info[cache_key]) {
			return page_globals.ontology_info[cache_key]
		}

	// load data from API
		const rqo = {
			action			: 'get_ontology_info',
			prevent_lock	: true,
			tipo			: tipo
		}
		const api_response = await data_manager.request({
			body : rqo
		})

	// ontology_info response
		const ontology_info = api_response?.result || false

	// store in cache
		page_globals.ontology_info[cache_key] = ontology_info


	return ontology_info
}//end get_ontology_info



/**
* GET_PAGE_ELEMENT
* Get full page element
* Expected options:
*
*	$tipo 			= $options->tipo ?? null;
*	$model 			= $options->model ?? (isset($tipo) ? RecordObj_dd::get_modelo_name_by_tipo($tipo,true) : null);
*	$lang 			= $options->lang ?? DEDALO_DATA_LANG;
*	$mode 			= $options->mode ?? 'list';
*	$section_id 	= $options->section_id ?? null;
*	$component_tipo = $options->component_tipo ?? null;
*
* @param object options
* @return promise api_response
*/
data_manager.prototype.get_page_element = async function(options) {

	// api request
		// const api_response = await this.request({
		const api_response = this.request({
			body : {
				action	: 'get_page_element',
				options	: options
			}
		})


	return api_response
}//end get_page_element



/**
* GET_LOCAL_DB
* Get local indexedDB from browser
* If browser version is lower than current try, onupgradeneeded event is launched and browser indexedDB will be upgraded
* @return promise
*/
data_manager.get_local_db = async function() {

	// db storage
		// In the following line, you should include the prefixes of implementations you want to test.
		const current_indexedDB = window.indexedDB || window.mozIndexedDB || window.webkitIndexedDB || window.msIndexedDB;
		// DON'T use "var indexedDB = ..." if you're not in a function.
		// Moreover, you may need references to some window.IDB* objects:
		// const IDBTransaction = window.IDBTransaction || window.webkitIDBTransaction || window.msIDBTransaction || {READ_WRITE: "readwrite"}; // This line should only be needed if it is needed to support the object's constants for older browsers
		// const IDBKeyRange = window.IDBKeyRange || window.webkitIDBKeyRange || window.msIDBKeyRange;
		// (Mozilla has never prefixed these objects, so we don't need window.mozIDB*)

	// invalid local db case
		if (!current_indexedDB) {
			console.error("[get_local_db] Your browser doesn't support a stable version of IndexedDB. Such and such feature will not be available.");
		}


	return new Promise(function(resolve, reject){

		// open db. Let us open our database (name, version)
			const db_request = current_indexedDB.open('dedalo', 11);

		// error case
			db_request.onerror = function(event) {
				if(SHOW_DEBUG){
					console.error("[get_local_db] error:", event.target);
				}else{
					console.error("[get_local_db] It's not possible get_local_db, IndexedDB is blocked, Dédalo will run slowly without cache.");
				}

				reject(false)
			};

		// success case
			db_request.onsuccess = function(event) {

				const db = event.target.result;
				resolve(db)
			};

		// onupgradeneeded event
			db_request.onupgradeneeded = function(event) {

				console.log("[get_local_db] onupgradeneeded:", event.target);

				const db = event.target.result;
				console.log(`[get_local_db] Upgrading indexedDB 'dedalo' to version ${db.version}`);

				// objectStore

				// rqo
					db.objectStoreNames.contains('rqo') || db.createObjectStore('rqo', { keyPath:'id' });
				// context
					db.objectStoreNames.contains('context') || db.createObjectStore('context', { keyPath:'id' });
				// status
				// Used to store elements status like section_group collapse display
					db.objectStoreNames.contains('status') || db.createObjectStore('status', { keyPath:'id' });
				// data
				// Used to store temp data like menu datum resolution
					db.objectStoreNames.contains('data') || db.createObjectStore('data', { keyPath:'id' });
				// ontology
					db.objectStoreNames.contains('ontology') || db.createObjectStore('ontology', { keyPath:'id' });
				// sqo. No longer used (replaced by 'pagination')
					if (db.objectStoreNames.contains('sqo')) {
						db.deleteObjectStore("sqo");
						console.log(`[get_local_db] Deleting ObjectStore (table) sqo`);
					}
				// pagination
					db.objectStoreNames.contains('pagination') || db.createObjectStore('pagination', { keyPath:'id' });
			};
	})
	.catch(err => {
		console.error(err)
	});
}//end local_db



/**
* SET_LOCAL_DB_DATA
* Save data into the browser local database (IndexdDB)
* @param object data
* @param string table
* 	Tables:
* 		status : element stored status like collapsed, etc.
* 		rqo : rqo cache data
* 		ontology ;: ontology cache data
* 		data : generic data like menu resolution
* 		context : context cache data
* Calling sample:
* 	current_data_manager.set_local_db_data(
* 		rqo, // mixed data
* 		'rqo' // string table
* 	)
* @return promise
*/
data_manager.set_local_db_data = async function(data, table) {

	const self = this

	// get local db
		const db = await self.get_local_db()

	// check if is possible create and use IndexDB, if not, the promise will return undefined and we use false
		if(!db){
			return false
		}

	return new Promise(function(resolve, reject){

		// transaction
			const transaction = db.transaction(table, "readwrite");

			// complete. Do something when all the data is added to the database.
				// transaction.oncomplete = function(event) {
				// 	console.log("All done!");
				// };

			// error
				transaction.onerror = function(event) {
					if(SHOW_DEBUG){
						console.error("[set_local_db_data] error:", event.target);
					}else{
						console.error("[set_local_db_data] It's not possible get_local_db, IndexedDB is blocked, Dédalo will run slowly without cache.");
					}
					reject(false)
				};

		// request
			const objectStore = transaction.objectStore(table);

			// Put this updated object back into the database.
			const request = objectStore.put(data);

			request.onsuccess = function(event) {
				resolve(event.target.result)
			};
			request.onerror = function(event) {
				console.error("[set_local_db_data] error:", event.target);
				reject(event.target.error);
			};
	})
}//end set_local_db_data



/**
* GET_LOCAL_DB_DATA
* @param string id
* @param string table
* @param bool use_cache = false
* Calling sample:
*	current_data_manager.get_local_db_data('tool_export_config', 'data')
* @return promise
*/
const db_table_cache = new Map();
data_manager.get_local_db_data = async function(id, table, use_cache=false) {

	const self = this

	try {

		// Input validation
		if (!id || !table) {
			throw new Error('Missing required parameters: id and table');
		}

		// Get database with optional caching
		const db = use_cache && db_table_cache.has(table)
			? db_table_cache.get(table)
			: await self.get_local_db();

		// check if is possible create and use IndexDB, if not, the promise will return undefined and we use false
		if(!db){
			console.warn('[get_local_db_data] IndexedDB not available, running without cache');
			return false
		}

		// Cache database if requested
		if (use_cache && !db_table_cache.has(table)) {
			db_table_cache.set(table, db);
		}

		// Get data from IndexedDB
		const result = await new Promise(function(resolve, reject){

			// transaction
				const transaction = db.transaction(table, 'readwrite');

				// complete. Do something when all the data is added to the database.
					// transaction.oncomplete = function(event) {
					// 	console.log("All done!");
					// };

				// error
					transaction.onerror = function(event) {
						if(SHOW_DEBUG){
							console.error("[get_local_db_data] error:", event.target);
							console.error('[get_local_db_data] table:', table, 'db:',db);
						}else{
							console.error("[get_local_db_data] It's not possible get_local_db, IndexedDB is blocked, Dédalo will run slowly without cache.");
						}
						reject(false)
					};

			// request
				const objectStore	= transaction.objectStore(table);
				const request		= objectStore.get(id);

				request.onsuccess = function(event) {
					resolve(event.target.result)
				};
				request.onerror = function(event) {
					console.error("[get_local_db_data] error:", event.target);
					reject(event.target.error);
				};
		})

		return result;

	} catch (error) {
		console.error('[get_local_db_data] Error:', error.message);
		throw error; // Re-throw to let caller handle
	}
}//end get_local_db_data



/**
* DELETE_LOCAL_DB_DATA
* Delete specified element form DB table by id
* @param string id
* @param string table
* @return promise
*/
data_manager.delete_local_db_data = async function(id, table) {

	const self = this

	// get local db
		const db = await self.get_local_db()

	// check if is possible create and use IndexDB, if not, the promise will return undefined and we use false
		if(!db){
			return false
		}

	return new Promise(function(resolve, reject){

		// transaction
			const transaction = db.transaction(table, "readwrite");

			// complete. Do something when all the data is added to the database.
				// transaction.oncomplete = function(event) {
				// 	console.log("All done!");
				// };

			// error
				transaction.onerror = function(event) {
					if(SHOW_DEBUG){
						console.error("[delete_local_db_data] error:", event.target);
					}else{
						console.error("[delete_local_db_data] It's not possible get_local_db, IndexedDB is blocked ");
					}
					reject(false)
				};

		// request
			const objectStore	= transaction.objectStore(table);
			const request		= objectStore.delete(id);

			request.onsuccess = function(event) {
				// success
				resolve(event.target.result)
			};
			request.onerror = function(event) {
				console.error("[delete_local_db_data] delete_local_db_data error:", event.target);
				reject(event.target.error);
			};
	})
}//end delete_local_db_data



/**
* DELETE_WHOLE_LOCAL_DB
* Clean whole local indexed DB.
* Useful when important changes were made because an update
* @return promise
*/
data_manager.delete_whole_local_db = async function() {

	const self = this

	return new Promise(function(resolve, reject) {

		const db = window.indexedDB || window.mozIndexedDB || window.webkitIndexedDB || window.msIndexedDB;

		const request = db.deleteDatabase('dedalo');

		request.onsuccess = function(event) {
			console.log("[delete_whole_local_db] Deleted database successfully");
			resolve(event.target.result)
		};
		request.onerror = function(event) {
			console.log("[delete_whole_local_db] Couldn't delete database");
			reject(event.target.error);
		};
		request.onblocked = function () {
			console.log("[delete_whole_local_db] Couldn't delete database due to the operation being blocked. Reload page to apply changes");
		};
	})
}//end delete_whole_local_db



/**
* CLEAR_LOCAL_DB_TABLE
* Clean selected objectStore (table) from indexedDB.
* Useful when important changes were made because an update
* @param string table
* @return promise
*/
data_manager.clear_local_db_table = async function(table) {

	const self = this

	return new Promise(function(resolve, reject) {

		// Let us open our database
		const DBOpenRequest = window.indexedDB.open("dedalo");
		DBOpenRequest.onsuccess = (event) => {

			console.log("[clear_local_db_table] Database initialized");

			// store the result of opening the database in the db variable.
			const db = DBOpenRequest.result;

			// clear previous data
			const transaction = db.transaction([table], "readwrite");
			transaction.oncomplete = (event) => {
				console.log('[clear_local_db_table] Transaction done successful');
			};
			transaction.onerror = (event) => {
				console.error(`[clear_local_db_table] Transaction not opened due to error: ${transaction.error}`);
				reject(false)
			};
			const objectStore = transaction.objectStore("sqo");
			const objectStoreRequest = objectStore.clear();
			objectStoreRequest.onsuccess = (event) => {
				console.log('[clear_local_db_table] Request clear successful');
				resolve(true)
			};
		};
	})
}//end clear_local_db_table



/**
* DOWNLOAD_URL
* @param string url
* @param string filename
* Download url blob data and create a temporal auto-fired link
*/
export function download_url(url, filename) {
	fetch(url).then(function(t) {
		return t.blob().then((b)=>{
			var a = document.createElement("a");
			a.href = URL.createObjectURL(b);
			a.setAttribute("download", filename);
			a.click();
			a.remove();
		}
		);
	});
}//end download_url



/**
* DOWNLOAD_DATA
* @param mixed data
* @param string filename
* Download data blob data and create a temporal auto-fired link
*/
export function download_data(data, filename) {

	const json	= JSON.stringify(data, null, 2)
	const blob	= new Blob([json], {type: "octet/stream"})
	const url	= window.URL.createObjectURL(blob)

	const a = document.createElement("a")
	a.style = "display: none"
	document.body.appendChild(a)
	a.href = url
	a.download = filename
	a.click()
	window.URL.revokeObjectURL(url)

	return true
}//end download_data



// @license-end
