// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/* global Promise, structuredClone, SHOW_DEBUG, SHOW_DEVELOPER, DEDALO_TOOLS_URL, DEDALO_TOOLS_URLS, get_label */
/*eslint no-undef: "error"*/



import {data_manager} from '../../js/data_manager.js'
import {event_manager} from '../../js/event_manager.js'
import {get_instance} from '../../js/instances.js'



/**
* UTIL
* General-purpose utility library for Dédalo's client-side JS.
*
* Exports standalone helper functions covering:
* - Deep cloning and structural equality comparison (clone, is_equal, array_equals, object_equals)
* - Logging (dd_console) and safe JSON parsing (JSON_parse_safely)
* - DOM asset loading with deduplication (load_style, load_script)
* - URL encoding/decoding (object_to_url_vars, url_vars_to_object)
* - Window/navigation helpers (open_window, open_records_in_window, open_window_with_post)
* - File download (download_file)
* - DOM traversal (find_up_node, find_up_tag)
* - Text/number formatting (bytes_format, printf, strip_tags, get_font_fit_size, time_unit_auto)
* - Non-cryptographic hashing (generate_hash)
* - Ontology tipo parsing (get_tld_from_tipo, get_section_id_from_tipo)
* - Instance tree traversal (get_caller_by_model)
* - Language data resolution (get_json_langs)
* - Tool URL resolution (tool_base_url)
*
* None of these functions carry module-level state except for the deduplication Maps
* (pending_styles, pending_scripts) and the singleton promise (_json_langs_promise),
* which are intentionally module-scoped.
*/



/**
* CLONE
* Returns a deep, independent copy of any serialisable value using the
* platform-native structuredClone algorithm.
*
* Prefer this over JSON.parse(JSON.stringify(x)) because structuredClone
* correctly handles Dates, TypedArrays, Maps, Sets, and circular references
* (though Dédalo data objects are plain JSON-safe structures in practice).
* @param {*} item - The value to clone; must be structuredClone-compatible
* @returns {*} A deep clone of item with no shared references to the original
*/
export function clone(item) {

	// return JSON.parse(JSON.stringify(item));
	return structuredClone(item)
}//end clone



/**
* DD_CONSOLE
* Branded console output for Dédalo runtime messages.
*
* Routes messages through console.error (ERROR level) or console.warn
* (WARNING and DEBUG levels), mapped from the level string. Applies a violet-on-black CSS style so
* Dédalo messages stand out in mixed browser consoles.
*
* DEBUG-level messages are silently suppressed unless the SHOW_DEBUG or
* SHOW_DEVELOPER globals are set to true, keeping development noise out of
* production deployments.
* @param {string} msg - The message text to display
* @param {string} [level='WARNING'] - Severity: 'DEBUG' | 'WARNING' | 'ERROR'
* @param {*} [items] - Optional extra data appended after the message
* @returns {void}
*/
export function dd_console(msg, level='WARNING', items){

	if ( level==='DEBUG' && (SHOW_DEBUG!==true && SHOW_DEVELOPER!==true) ) {
		return
	}

	const type = level==='ERROR'
		? 'error'
		: (level==='WARNING'
			? 'warn'
			: 'warn')

	const style = 'background: #000000; color: violet; font-size: 1.2em; padding:2px; padding-left:4px; padding-right:4px;'

	if (items) {
		console[type]('%c' + msg, style, items);
	}else{
		console[type]('%c' + msg, style);
	}
}//end dd_console



/**
* JSON_PARSE_SAFELY
* Wraps JSON.parse with a try/catch so callers do not need to handle
* SyntaxError on malformed input.
*
* Logs the parse error to console.error so failures are still visible
* during development, then returns error_value instead of throwing.
* Use this whenever the JSON source is untrusted (e.g. server responses,
* localStorage, user-supplied strings).
* @param {string} str - The JSON string to parse
* @param {*} [error_value=null] - Value returned when parsing fails
* @returns {*} The parsed JavaScript value, or error_value on failure
*/
export function JSON_parse_safely(str, error_value=null) {
	try {
		return JSON.parse(str);
	}
	catch (e) {
		console.error(e);
		// Return a default object, or null based on use case.
		return error_value
	}
}//end JSON_parse_safely



/**
* GROUP_OBJECTS_BY
* Groups an array of objects into a plain object keyed by a shared property.
*
* Equivalent to SQL GROUP BY — each key maps to an array of all objects whose
* [key] property equals that key value. Objects with a missing/undefined key
* are grouped under the string "undefined".
* @param {Array} xs - The array of objects to group
* @param {string|number} key - The property name to group by
* @returns {Object} A plain object mapping key values to arrays of matching objects
*/
export function group_objects_by(xs, key) {

	return xs.reduce(function(rv, x) {
		(rv[x[key]] = rv[x[key]] || []).push(x);
		return rv;
	}, {});
}//end group_objects_by




/**
* WAIT_FOR_GLOBAL
* Polls window[name] on an exponentially increasing interval until the value
* is defined or the timeout expires.
*
* Designed for loading optional third-party libraries (e.g. Leaflet) via
* dynamic <script> tags where the library sets a global when ready. The
* doubling backoff (30 ms → 60 ms → 120 ms …) keeps CPU usage low without
* adding unnecessary latency for fast loads.
* @param {string} name - Property name on window to watch, e.g. 'L' for Leaflet
* @param {number} [timeout=300] - Maximum wait time in seconds before rejecting
* @returns {Promise<void>} Resolves when window[name] is defined; rejects with
*   {message: 'Timeout'} if the limit is reached
*/
export function wait_for_global(name, timeout=300) {

	return new Promise((resolve, reject) => {
		let waited = 0

		function wait(interval) {
			console.log("waiting interval...... :", interval);
			setTimeout(() => {
				waited += interval
				// some logic to check if script is loaded
				// usually it something global in window object
				if (window[name] !== undefined) {
					return resolve()
				}
				if (waited >= timeout * 1000) {
					return reject({ message: 'Timeout' })
				}
				wait(interval * 2)
			}, interval)
		}

		wait(30)
	})
}//end wait_for_global



/**
* OBSERVE_CHANGES
* Wraps a MutationObserver in a Promise so callers can await a single DOM
* mutation instead of managing observer lifecycle manually.
*
* Currently used by service_tinymce.js to detect when the editor has finished
* injecting its DOM structure.
*
* When once is true the observer is disconnected after the first matching
* mutation, preventing memory leaks from long-lived observers. When once is
* false the observer remains active and the promise resolves on every matching
* event (though awaiting a promise that resolves multiple times is unusual —
* callers relying on repeated notifications should use the MutationObserver
* directly).
* @param {HTMLElement} element - The target node to observe
* @param {MutationObserverInit} config - Observer options (childList, attributes, etc.)
* @param {boolean} once - When true, disconnects the observer after the first event
* @returns {Promise<string>} Resolves with mutation.type for childList mutations
*   or mutation.attributeName for attribute mutations
*/
export async function observe_changes(element, config, once) {

	// config are the options for the observer (which mutations to observe)

	return new Promise((resolve) => {
		// Callback function to execute when mutations are observed
		const callback = function(mutationsList, observer) {
			// Use traditional 'for loops' for IE 11
			for(let mutation of mutationsList) {
					if (mutation.type==='childList') {
						console.log('A child node has been added or removed.');

						if (once===true) {
							observer.disconnect();
						}
						resolve( mutation.type )
					}
					else if (mutation.type==='attributes') {
						console.log('The ' + mutation.attributeName + ' attribute was modified.');

						if (once===true) {
							observer.disconnect();
						}
						resolve( mutation.attributeName )
					}
			}
		};

		// Create an observer instance linked to the callback function
		const observer = new MutationObserver(callback);

		// Start observing the target node for configured mutations
		observer.observe(element, config);
	})
}//end observe_changes



/**
* LOAD_STYLE
* Dynamically inserts a <link rel="stylesheet"> for src and returns a Promise
* that resolves/rejects with src when the browser finishes loading.
*
* Idempotent: if src is already present as a <link href> in the document, the
* promise resolves immediately without creating a duplicate element.
*
* Concurrent calls for the same src return the same in-flight Promise (stored
* in pending_styles) to prevent race conditions that would otherwise create
* duplicate <link> tags and fire the load event prematurely.
* @param {string} src - Absolute or root-relative URL of the stylesheet
* @returns {Promise<string>} Resolves with src on success; rejects with src on error
*/
// pending_styles: module-level deduplication registry for in-flight <link> loads;
// cleared per entry once the load/error event fires.
const pending_styles = new Map();
export function load_style(src) {

	// check if a load is already in-flight for this src
	const pending = pending_styles.get(src);
	if (pending) {
		return pending;
	}

	const promise = new Promise(function(resolve, reject) {

		// check already loaded
			const links 	= document.getElementsByTagName('link');
			const links_len = links.length;
			for (let i = links_len - 1; i >= 0; i--) {
				if(links[i].getAttribute('href')===src) {
					resolve(src);
					return;
				}
			}

		// DOM tag
			const element 	  = document.createElement('link');
				  element.rel = 'stylesheet';

			element.addEventListener('load', function() {
				pending_styles.delete(src);
				resolve(src);
			});

			element.addEventListener('error', function() {
				pending_styles.delete(src);
				reject(src);
			});

			element.href = src;

			document.head.appendChild(element);
	});

	// register as in-flight before returning
	pending_styles.set(src, promise);

	return promise;
}//end load_style



/**
* LOAD_SCRIPT
* Dynamically inserts a <script defer> element for src and returns a Promise
* that resolves/rejects with src when the browser finishes loading.
*
* Idempotent: if a <script src="src"> already exists in the document, the
* promise resolves immediately without creating a duplicate element.
*
* When content is provided, it is injected as the script's textContent (not
* innerHTML) to avoid HTML-parser side-effects. This is the correct way to set
* inline script source (SEC-XSS-004).
*
* Concurrent calls for the same src return the same in-flight Promise (stored
* in pending_scripts) to prevent race conditions that would otherwise create
* duplicate <script> tags.
* @param {string} src - URL of the external script file
* @param {string|null} [content=null] - Optional inline script source; when provided
*   textContent is set before appending the element to the document
* @returns {Promise<string>} Resolves with src on success; rejects with src on network error
*/
// pending_scripts: module-level deduplication registry for in-flight <script> loads;
// cleared per entry once the load/error event fires.
const pending_scripts = new Map();
export function load_script(src, content=null) {

	// check if a load is already in-flight for this src
	const pending = pending_scripts.get(src);
	if (pending) {
		return pending;
	}

	const promise = new Promise(function(resolve, reject) {

		// check already loaded
			const scripts 	  = document.getElementsByTagName('script');
			const scripts_len = scripts.length;
			for (let i = scripts_len - 1; i >= 0; i--) {
				if(scripts[i].getAttribute('src')===src) {
					resolve(src);
					return;
				}
			}

		// DOM tag
			const element = document.createElement('script');
			element.setAttribute('defer', 'defer');

			if(content) {
				// SEC-XSS-004: textContent is the correct way to set script source;
				// innerHTML triggers the HTML parser unnecessarily.
				element.textContent = content;
			}

			element.addEventListener('load', function() {
				pending_scripts.delete(src);
				resolve(src);
			});

			element.addEventListener('error', function() {
				pending_scripts.delete(src);
				// Remove the FAILED tag: the "already loaded" check above resolves
				// on finding a matching <script src>, so leaving it would make every
				// later attempt resolve without loading anything (no retry possible).
				element.remove();
				reject(src);
			});

			element.src = src;

			document.head.appendChild(element);
	});

	// register as in-flight before returning
	pending_scripts.set(src, promise);

	return promise;
}//end load_script



/**
* OBJECT_TO_URL_VARS
* Serialises a plain object into a URL query string (without the leading '?').
*
* Each value is percent-encoded with encodeURIComponent. Boolean and numeric
* values are coerced to strings automatically by encodeURIComponent.
*
* The key 't' is explicitly forbidden (it conflicts with the reserved Dédalo
* query-string abbreviation for tipo) — a console.error is emitted and the
* key is still included (callers must not pass it).
*
* Example input:  { tipo: 'rsc197', menu: false }
* Example output: 'tipo=rsc197&menu=false'
* @param {Object} vars_obj - Key/value map of URL parameters
* @returns {string} Ampersand-delimited query string without a leading '?'
*/
export function object_to_url_vars(vars_obj) {

	const pairs = []
	for (const key in vars_obj) {
		if (key==='t') {
			console.error('url key "t" is not valid for tipo');
		}
		const current_value = encodeURIComponent( vars_obj[key] )

		pairs.push( key +'='+ current_value )
	}

	const url_vars = pairs.join('&')


	return url_vars
}//end object_to_url_vars



/**
* URL_VARS_TO_OBJECT
* Parses a URL query string into a plain key/value object.
*
* Falls back to window.location.search when query_string is falsy. Keys that
* appear more than once (e.g. checkboxes) are returned as an Array of values;
* single-occurrence keys are returned as plain strings.
* @param {string} [query_string] - Query string to parse, with or without a
*   leading '?'; defaults to window.location.search when omitted/falsy
* @returns {Object} Plain object mapping parameter names to string values (or
*   string arrays for repeated keys)
*/
export function url_vars_to_object(query_string) {

	// default from window.location
		if (!query_string) {
			query_string = window.location.search
		}

	// parse query string
		const params = new URLSearchParams(query_string);

	// one entry per distinct key. Built with Object.fromEntries (CreateDataProperty),
	// never `vars_obj[key] = …`: the key is URL text, and an assignment to
	// `__proto__` on a literal re-parents the object (CodeQL #8032/#8033).
	// fromEntries makes `__proto__` an ordinary OWN key, like any other.
		const vars_obj = Object.fromEntries(
			[...new Set(params.keys())].map((key) => {
				const values = params.getAll(key)
				return [key, values.length > 1 ? values : values[0]]
			})
		);

	return vars_obj;
}//end url_vars_to_object



/**
* OPEN_WINDOW_WITH_POST
* Opens a new browser tab/window and submits data via a synthetic HTML form POST.
*
* Browsers block window.open with POST natively, so this function constructs a
* hidden <form>, populates it with hidden <input> fields from the data object,
* appends it to the body, submits it targeting _blank, then immediately removes
* it. The new window opens with the POST response.
*
* (!) The form is removed synchronously after submit() — this works because the
* browser has already captured the form state before the call returns.
* @param {string} url - The action URL that will receive the POST request
* @param {Object} data - Key/value pairs to submit as hidden form fields
* @returns {boolean} Always returns false (useful as an event handler return value)
*/
export function open_window_with_post(url, data) {

	const form = document.createElement("form");
	form.target			= "_blank";
	form.method			= "POST";
	form.action			= url;
	form.style.display	= "none";

	for (const key in data) {

		const input	= document.createElement("input");
		input.type	= "hidden";
		input.name	= key;
		input.value	= data[key];
		form.appendChild(input);
	}

	document.body.appendChild(form);
	form.submit();
	document.body.removeChild(form);

	return false;
}//end open_window_with_post



/**
* BYTES_FORMAT
* Converts a raw byte count to a human-readable size string.
*
* Uses binary prefixes where 1 KB = 1024 bytes, 1 MB = 1024 KB, 1 GB = 1024 MB.
* Locale is fixed to 'en-US' for consistent decimal separators regardless of
* the user's browser locale. Returns false for zero, negative, or falsy input.
*
* Examples: 1536 → '2 KB', 1572864 → '1.5 MB', 1610612736 → '1.5 GB'
* @param {number} bytes - Raw byte count; falsy or < 1 returns false
* @returns {string|boolean} Formatted size string (e.g. '1.5 MB') or false on invalid input
*/
export function bytes_format(bytes) {

	if (!bytes || bytes<1) {
		return false
	}

	const kb		= (bytes/1024)
	const _locale	= 'en-US'

	let result
	switch (true) {

		case (kb >= 1048576): {
			// Giga Bytes
			const gb = (kb / 1048576).toLocaleString(_locale, {
				minimumFractionDigits: 0,
				maximumFractionDigits: 2
			})
			result = `${gb} GB`
			break;
		}

		case (kb >= 1024): {
			// Mega Bytes
			const mb = (kb / 1024).toLocaleString(_locale, {
				minimumFractionDigits: 0,
				maximumFractionDigits: 2
			})
			result = `${mb} MB`
			break;
		}

		default: {
			// KBytes
			const kb_round = Math.round(kb)
			result = `${kb_round} KB`
		}
	}


	return result
}//end bytes_format



/**
* PRINTF
* JavaScript equivalent to printf / String.Format with positional token substitution.
*
* Tokens of the form {N} (where N is a zero-based integer) are replaced by the
* Nth extra argument. Tokens with no corresponding argument are left as-is.
*
* Also handles legacy-style %s placeholders from Dédalo label strings (e.g. dd340):
* each %s is converted to {0}, {1}, … in left-to-right order before the numeric
* substitution pass runs.
*
* Example: printf('The content of {0} records from {1}', 25, 12)
*          → 'The content of 25 records from 12'
* @param {string} format - Template string with {0}, {1}, … or %s placeholders
* @param {...*} args - Values to substitute into the template, in order
* @returns {string} The formatted output string
*/
export function printf(format) {

	const args = Array.prototype.slice.call(arguments, 1);

	// fix old %s vars from labels like dd340
	let counter = 0
	format = format.replace(/%s/g, function(match, number) {
		const current_value = '{'+counter+'}'
		counter++
		return current_value
	})

	const output = format.replace(/{([\d]+)}/g, function(match, number) {
		return typeof args[number] != 'undefined'
			? args[number]
			: match
	})

	return output
}//end printf



/**
* STRIP_TAGS
* Removes all HTML tags from a string and returns plain text.
*
* Uses a detached <template> element so that innerHTML parsing happens in an
* inert context: scripts are never executed and subresources (images, iframes)
* are never loaded (SEC-XSS-003). The parsed node tree's textContent is then
* extracted, which automatically decodes HTML entities (e.g. &amp; → &).
*
* (!) Do NOT use a plain <div> with insertAdjacentHTML here — parsing in a live
* context can trigger side-effects on certain browsers even for detached nodes.
* @param {string} value - HTML string to sanitise
* @returns {string} Plain text content with all tags removed; empty string when
*   the template produces no text content
*/
export function strip_tags(value) {

	// SEC-XSS-003: previously used insertAdjacentHTML on a detached <div>.
	// That decodes HTML entities into the DOM before extracting textContent,
	// which can create tags from entity-encoded input and, in edge cases,
	// trigger side-effects during parsing. <template> innerHTML does NOT
	// execute scripts or load subresources, so it is the safe way to strip
	// tags while preserving text.
	const template = document.createElement("template");
	template.innerHTML = value;
	const text_clean = template.content.textContent || "";

	return text_clean;
}//end strip_tags



/**
* ARRAY_EQUALS
* Deep-compares two arrays for structural equality.
*
* Recursively delegates to is_equal for element-level comparison so that
* nested arrays and plain objects are handled correctly. Two different object
* instances with identical contents are considered equal.
*
* Returns false immediately when lengths differ (short-circuit). Returns false
* when array is falsy (null/undefined).
* @param {Array} source - The reference array
* @param {Array} array - The array to compare against source
* @returns {boolean} true when both arrays have the same length and every
*   corresponding element is deeply equal
*/
export function array_equals(source, array) {
	// if the other array is a false value, return
	if (!array)
		return false;

	// compare lengths - can save a lot of time
	if (source.length !== array.length)
		return false;

	for (let i = 0, l=source.length; i < l; i++) {
		// Check if we have nested arrays
		if (source[i] instanceof Array && array[i] instanceof Array) {
			// recurse into the nested arrays
			// if (!source[i].equals(array[i]))
			if (!is_equal(source[i], array[i]))
				return false;
		}
		// else if (source[i] != array[i]) {
		else if (!is_equal(source[i], array[i])) {
			// Warning - two different object instances will never be equal: {x:20} != {x:20}
			return false;
		}
	}

	return true;
}//end array_equals



/**
* OBJECT_EQUALS
* Deep-compares two plain objects for structural equality.
*
* Considers two objects equal when they have the same set of own enumerable
* keys and every corresponding value is deeply equal (via is_equal). The null
* case is handled explicitly because typeof null === 'object' in JavaScript —
* a null operand causes the function to fall back to strict === comparison
* rather than key-walking.
*
* The commented-out block below (object_equals_DES) is an earlier alternative
* implementation that used a nested isObject helper. It is preserved for
* reference and must not be removed.
* @param {Object} o1 - First object
* @param {Object} o2 - Second object
* @returns {boolean} true when both objects are structurally identical
*/
	// export function object_equals_DES(obj1, obj2) {

	// 	if (obj1 === obj2) {
	// 		return true;
	// 	}else if (isObject(obj1) && isObject(obj2)) {
	// 		if (Object.keys(obj1).length !== Object.keys(obj2).length) {
	// 			return false
	// 		}
	// 		for (const prop in obj1) {
	// 			if (!object_equals(obj1[prop], obj2[prop])) {
	// 				return false;
	// 			}
	// 		}
	// 		return true;
	// 	}
	// 	return false;

	// 	// Private
	// 	function isObject(obj) {
	// 		if (typeof obj === "object" && obj != null) {
	// 			return true;
	// 		} else {
	// 			return false;
	// 		}
	// 	}
	// }//end object_equals
export function object_equals(o1, o2) {

	// check if the o1 is object
	// null is a object but it's not possible check his keys, so use the ===
	// check if the object keys has length, has any property
	const equal = (o1 !== null && o2 !== null) && typeof o1 === 'object' && Object.keys(o1).length > 0
		? Object.keys(o1).length === Object.keys(o2).length
		  && Object.keys(o1).every(p => is_equal(o1[p], o2[p]))
		: o1 === o2;

	// debug
		// console.log('o1:', o1);
		// console.log('o2:', o2);
		// console.log('equal:', equal);

	return equal
}//end object_equals



/**
* IS_EQUAL
* Polymorphic deep-equality check for any JS value.
*
* Dispatches to the correct comparison strategy based on the runtime type of
* the arguments:
* - Primitive values (string, number, boolean): strict ===
* - Arrays: array_equals (recursive)
* - Plain objects: object_equals (recursive)
* - null / undefined: both sides must be null/undefined simultaneously
*
* Note: `typeof null === 'object'` in JS, so null is guarded explicitly
* before the object branch to avoid incorrect object_equals calls.
* @param {*} el1 - First value to compare
* @param {*} el2 - Second value to compare
* @returns {boolean} true when el1 and el2 are deeply structurally equal
*/
export function is_equal(el1, el2) {

	// direct check
	if (el1===el2) {
		return true
	}
	// check the typo of elements object != string
	// Note: this check could fail when check objects because null === object in js
	if (typeof el1!==typeof el2) {
		return false
	}

	// check null or undefined case
	const chek_null_obj = o => o === null || o === undefined;
	if(chek_null_obj(el1) !== chek_null_obj(el2)){
		return false
	}
	// check if new element is array
	if (Array.isArray(el1)) {
		return array_equals(el1, el2)
	}
	// check if new element is object
	if (typeof el1==="object" && el1!==null) {
		return object_equals(el1, el2)
	}


	return false
}//end is_equal



/**
* OPEN_WINDOW
* Unified helper for opening a Dédalo page in a separate browser window.
*
* Applies safe defaults (1280×905) and clamps the dimensions to the current
* screen size so that the new window always fits on screen. Accepts a special
* features value of 'new_tab' to open without window.open feature constraints
* (resulting in a true new tab in most browsers).
*
* Safari workaround: prevent_open_new_window() currently always returns false
* (the Safari-detection branch is commented out), but the guard remains so
* that tool URLs can be redirected to window.location instead of window.open
* if Safari logout issues recur.
*
* The optional on_blur callback is invoked via a 'focus' event on the opener
* window (the inverse of the new window losing focus) rather than a 'blur'
* event on the child window, because cross-origin event access is restricted.
* The commented-out direct approach is preserved for reference.
* @param {Object} options - Window options
* @param {string} options.url - URL to open
* @param {string} [options.target] - Window name / target (also accepts options.name)
* @param {number} [options.width] - Desired width in pixels; capped to screen width
* @param {number} [options.height] - Desired height in pixels; capped to screen height
* @param {number} [options.top=0] - Vertical offset from screen top
* @param {number} [options.left=0] - Horizontal offset from screen left
* @param {string|null} [options.features] - Raw window.open features string, or 'new_tab'
* @param {Function|null} [options.on_blur] - Callback fired when the opener window
*   regains focus (i.e. the user switches back from the new window)
* @returns {Window|null} The opened window object; the current window when the
*   Safari redirect path is taken; null when the browser refused to open the
*   window (pop-up blocker, window-count limit). Every caller that dereferences
*   the result MUST branch on null — see the guard in the body.
*/
export function open_window(options) {

	// defaults
		const default_width		= 1280
		const default_height	= 905

	// options
		const url		= options.url
		const target	= options.target || options.name || 'new_window'
		const features	= options.features || null
		const width		= options.width && (options.width < window.screen.width)
			? options.width
			: ((default_width < window.screen.width) ? default_width : window.screen.width)
		const height	= options.height && (options.height < window.screen.height)
			? options.height
			: ((default_height < window.screen.height) ? default_height : window.screen.height)
		const top		= options.top || 0
		const left		= options.left || 0
		const on_blur	= options.on_blur || null

	// window_features
		const window_features = (()=>{

			if (features==='new_tab') {
				return  null
			}

			const features_string = `width=${width},height=${height},top=${top},left=${left}` + (features ? (','+features) : '')

			return features_string
		})()

	// window
		if (prevent_open_new_window()===true && url.indexOf('tool=')!==-1) {

			// Prevent Safari logout problems on open new tabs for tools (!)
			window.location = url

			return window

		}else{
			const new_window = window.open(
				url,
				target,
				window_features
			)

			// (!) window.open returns null when the browser refuses the pop-up
			// (blocker, window-count limit, an about:blank refusal). Dereferencing
			// it threw a TypeError that escaped open_window and aborted the caller
			// mid-operation — and callers get here with work already done and not
			// undoable (open_records_in_window has already pinned a server-session
			// filter by this point). So: tell the user, and hand the caller a null
			// it can branch on instead of an exception it cannot.
				if (!new_window) {
					event_manager.publish('notification', {
						msg			: (typeof get_label!=='undefined' && get_label.unable_to_open_window) || 'The browser blocked the new window. Allow pop-ups for this site and try again.',
						type		: 'error',
						remove_time	: 10000
					})
					return null
				}

			// (!) resizeTo is NOT on the cross-origin WindowProxy allow-list (only
			// close/closed/focus/blur/frames/length/opener/parent/postMessage/top/
			// self/window and the location setter are): once an external-engine URL
			// has committed its own origin, touching it throws SecurityError — the
			// same escaping-throw defect in a different coat. focus() IS allowed
			// cross-origin, so it gets its own attempt rather than being skipped by
			// a resize refusal. Both are cosmetic: the window IS open either way.
				try {
					new_window.resizeTo(width, height) // needed for Firefox
				} catch (error) {
					console.warn('open_window: resizeTo refused by the browser:', error);
				}
				try {
					new_window.focus()
				} catch (error) {
					console.warn('open_window: focus refused by the browser:', error);
				}

			// on_blur optional action callback
				if (typeof on_blur==='function') {

					// direct
						// const fn_on_blur = function(e) {
						// 	// remove self instance to prevent duplicity
						// 	new_window.removeEventListener('blur', fn_on_blur)
						// 	// exec callback function
						// 	on_blur(e)
						// }
						// new_window.addEventListener('blur', fn_on_blur)

					// inverse
						const fn_on_focus = function(e) {
							// remove self instance to prevent duplicity
							window.removeEventListener('focus', fn_on_focus)
							// exec callback function
							on_blur(e)
						}
						window.addEventListener('focus', fn_on_focus)
				}

			return new_window
		}
}//end open_window



/**
* PREVENT_OPEN_NEW_WINDOW
* Guards against Safari-specific logout problems that occurred when opening
* tool URLs in new tabs via window.open.
*
* Currently returns false unconditionally — the Safari user-agent detection
* is disabled (see commented-out line). The function is kept so that
* open_window can re-enable the workaround without restructuring its call site.
* @returns {boolean} true when opening a new window should be suppressed in
*   favour of a same-window navigation; currently always false
*/
export function prevent_open_new_window() {
	return false
	// return (navigator.userAgent.indexOf('Safari')!==-1 && navigator.userAgent.indexOf('Chrome')===-1)
}//end prevent_open_new_window



/**
* OPEN_RECORDS_IN_WINDOW
* Opens a new window pre-filtered to show only the given section_id records.
*
* The filter cannot be passed via URL because large id arrays (thousands of
* person relationships, for example) would exceed URL length limits. Instead,
* a temporary ("dummy") section instance is built client-side with the desired
* SQO filter; building it causes the server to store the filter in the PHP
* session keyed to section_tipo. The new window then loads the section
* normally and picks up the session filter automatically.
*
* The dummy section is destroyed immediately after building to avoid leaking
* client-side state. Inter-window event messaging is intentionally avoided
* because its reliability varies when the target window may be new or recycled.
*
* (!) The session-filter approach means only one filter per section_tipo can
* be active in a given browser session at a time. Concurrent calls for the
* same section_tipo will overwrite each other's session filter.
* @param {Object} options - Open options
* @param {Object} options.caller - The calling Dédalo instance (used in request_config)
* @param {string} options.section_tipo - Ontology tipo of the target section
* @param {Array} options.ar_section_id - Array of section_id values to show
* @param {string} [options.target_window] - window.open target name for reuse
* @param {number} [options.width=1280] - Window width in pixels
* @param {number} [options.height=900] - Window height in pixels
* @param {number} [options.left=0] - Horizontal screen offset
* @param {number} [options.top=0] - Vertical screen offset
* @returns {Promise<boolean>} Resolves to true once the window has been opened;
*   false when the browser refused it (the session filter stays pinned — see the
*   note at the open_window call)
*/
export const open_records_in_window = async function( options ) {

	// create a dummy section with calculated section_id array as filter

	// ! NOTE: This session server solution is adopted because passing the whole list of section_id
	// using the URL is not feasible for large arrays (e.g., for person relationships),
	// and events between windows is very unstable depending on whether the window is new or recycled, etc.

	const caller		= options.caller
	const section_tipo	= options.section_tipo
	const ar_section_id	= options.ar_section_id
	const target_window	= options.target_window
	const width			= options.width 	|| 1280
	const height		= options.height 	|| 900
	const left			= options.left 		|| 0
	const top			= options.top 		|| 0

	// request_config
		const request_config = [{
			api_engine	: 'dedalo',
			type		: 'main',
			show		: { ddo_map : [] },
			sqo : {
				section_tipo	: [section_tipo],
				limit			: 10,
				offset			: 0,
				filter			: {
					'$and' : [
						{
							q : [ ar_section_id.join(',') ],
							path : [{
								section_tipo	:  section_tipo,
								component_tipo	: 'section_id',
								model			: 'component_section_id',
								name			: 'Id'
							}]
						}
					]
				}
			}
		}]

	// instance_options (context)
		const instance_options = {
			type			: 'section',
			typo			: 'ddo',
			tipo			: section_tipo,
			section_tipo	: section_tipo,
			section_id		: null,
			lang			: page_globals.dedalo_data_nolan,
			mode			: 'edit',
			model			: 'section',
			add_show		: true, // force to use request_config 'show' value
			caller			: caller,
			request_config	: request_config,
			id_variant		: 'relation_list_' + (new Date()).getTime()
		}

	// dummy section init and build
		const section = await get_instance(instance_options)
		// build. Forces to load section data and fix filter in server session
		await section.build(true)
		// destroy after use it (only affects client side)
		section.destroy()

		const features = `width=${width},height=${height},left=${left},top=${top}`;

	// open a new window without additional params.
		// Note that the new window will be use the session value fixed in server
		// for this section tipo by the previous dummy section build
		const new_window = open_window({
			url			: `${DEDALO_CORE_URL}/page/?tipo=${section_tipo}&menu=false`,
			target		: target_window,
			features	: features
		})

		// (!) The expensive, irreversible half already ran: the dummy section was
		// built (which is what pinned the SQO filter in the server session for this
		// section_tipo) and destroyed. If the window did not open, that filter stays
		// pinned with nothing showing it, so NEVER answer true here — the caller
		// would report success for records the user never saw. open_window has
		// already told the user why; this is the machine-readable half of the same
		// report.
		if (!new_window) {
			console.warn('open_records_in_window: window refused; the session filter stays pinned for section_tipo:', section_tipo);
			return false
		}


	return true
}//end open_records_in_window



/**
* DOWNLOAD_FILE
* Triggers a browser file download for the given URL using a synthetic anchor
* click, without navigating the current page.
*
* The anchor is created with rel="noopener noreferrer" (SEC-033) to prevent
* the opened resource from accessing the opener window via window.opener.
* The download attribute hints to the browser to save as file_name rather than
* displaying inline; behaviour is subject to browser content-type enforcement.
*
* The anchor is removed immediately after the click event is dispatched.
* @param {Object} options - Download options
* @param {string} options.url - URL of the file to download
* @param {string} [options.file_name] - Suggested filename; falls back to the
*   last path segment of the URL when not provided
* @returns {boolean} Always returns true
*/
export function download_file(options) {

	// options
		const url		= options.url
		const file_name	= options.file_name || url.substring(url.lastIndexOf('/')+1)

	// anchor pseudo-link
		const anchor	= document.createElement('a');
		anchor.href		= url
		anchor.target	= '_blank'
		anchor.rel		= 'noopener noreferrer' // SEC-033
		anchor.download	= file_name
		anchor.click();
		anchor.remove()

	return true
}//end download_file



/**
* FIND_UP_NODE
* Walks up the DOM from el, returning the first ancestor that satisfies
* the given compare predicate, or the first ancestor whose tagName equals
* target_tag when no predicate is supplied.
*
* The walk continues until parentNode is null (document root reached), at
* which point null is returned. Compare takes precedence: when provided,
* target_tag is ignored.
* @param {HTMLElement} el - Starting element (not included in the search)
* @param {string} target_tag - Uppercase tag name to match, e.g. 'DIV'; ignored when
*   compare is supplied
* @param {Function} [compare] - Optional predicate (node) => boolean; return true
*   to select that node
* @returns {HTMLElement|null} The matching ancestor, or null if none found
*/
export function find_up_node(el, target_tag, compare) {

	let r = el
	while (r.parentNode) {
		r = r.parentNode;
		if (compare) {
			if (compare(r)===true) {
				return r
			}
		}else{
			if (r.tagName===target_tag) {
				return r;
			}
		}
	}

	return null;
}//end find_up_node



/**
* FIND_UP_TAG
* Walks up the DOM from el, returning the first ancestor (or el itself) that
* has the given CSS class name in its classList.
*
* Unlike find_up_node this function checks el itself before traversing, and
* uses classList.contains rather than tagName matching, making it suitable for
* locating wrapper elements by semantic class (e.g. 'wrap_ts_object').
* @param {HTMLElement} el - Starting element (included in the search)
* @param {string} class_name - CSS class to match, e.g. 'wrap_ts_object'
* @returns {HTMLElement|null} The matched element, or null if none found
*   before reaching the top of the DOM
*/
export function find_up_tag(el, class_name) {
	// Use a while loop to traverse up the DOM tree from the starting element
	while (el) {
		// Check if the current element has the specified class
		if (el.classList && el.classList.contains(class_name)) {
			return el;
		}
		// Move up to the next parent element in the hierarchy
		el = el.parentNode;
	}
	// If no parent with the class is found, return null
	return null;
}//end find_up_tag



/**
* PAUSE
* Returns a Promise that resolves to true after the given number of milliseconds,
* providing a lightweight async sleep for throttling, animation timing, or
* sequencing operations that depend on external state settling.
*
* Example: await pause(200) // wait 200 ms before continuing
* @param {number} milliseconds - Duration to wait before resolving
* @returns {Promise<boolean>} Resolves to true after the delay
*/
export function pause(milliseconds) {
	return new Promise(function(resolve){
		setTimeout(function(){
			resolve(true)
		}, milliseconds)
	})
}//end pause



/**
* GET_FONT_FIT_SIZE
* Calculates a CSS font-size value (typically in vw units) that scales down
* proportionally when the text is longer than a threshold, keeping labels
* legible within a fixed-width container.
*
* The formula applies a reduction factor of 0.037 per character beyond the
* combined (base_size + threshold) ceiling. Used primarily by section_id
* column cells to prevent numeric identifiers from overflowing their column.
*
* At the defaults (base_size=1.7, threshold=4), strings of 5 characters or
* fewer receive 1.7 vw; a 10-character string receives ~1.33 vw.
* @param {string} text - Text whose rendered length drives the scaling
* @param {number} [base_size=1.7] - Base font size (in vw or any CSS unit)
* @param {number} [threshold=4] - Character count below which no scaling occurs
* @returns {number} The calculated font size value (caller appends the unit)
*/
export function get_font_fit_size(text, base_size=1.7, threshold=4) {

	const text_length = String(text).length

	const font_size = (text_length > Math.floor(base_size + threshold) )
		? base_size - (text_length * 0.037)
		: base_size

	return font_size
}//end get_font_fit_size



/**
* TIME_UNIT_AUTO
* Converts a raw millisecond duration to a human-readable string with the
* most appropriate time unit (ms, sec, min, hour, day).
*
* Selects the unit by successive division: values under 1 s stay as ms, under
* 1 min become seconds (no decimal), and longer durations show three decimal
* places. Intended for profiling/logging output, not UI display.
*
* Example: time_unit_auto(75430) → '1.257 min'
* @param {number} total_ms - Elapsed time in milliseconds (e.g. from Date.now() diff)
* @returns {string} Formatted duration string with unit suffix
*/
export function time_unit_auto(total_ms) {

	const round = 3;

	// calculation is always in milliseconds
	// const total_ms = Date.now() - start;;

	if (total_ms > 1000) {
		const total_sec = total_ms / 1000;
		if (total_sec > 60) {
			const total_min = total_sec / 60;
			if (total_min > 60) {
				const total_hours = total_min / 60;
				if (total_hours > 24) {
					const total_days = total_hours / 24;
					return `${total_days.toFixed(round)} day`;
				}
				return `${total_hours.toFixed(round)} hour`;
			}
			return `${total_min.toFixed(round)} min`;
		}
		return `${total_sec.toFixed(0)} sec`;
	}
	return `${total_ms.toFixed(0)} ms`;
}//end time_unit_auto



/**
* GET_JSON_LANGS
* Fetches the Dédalo language registry from core/common/js/lang.json and
* caches the result as window['json_langs'] for subsequent synchronous access.
*
* Returns immediately from the window cache when the data has already been
* loaded. Concurrent calls before the first response arrives all receive the
* same in-flight Promise (_json_langs_promise) to prevent duplicate HTTP
* requests. The request is sent with cache: 'force-cache' because lang.json
* does not change at runtime.
*
* Sample record shape:
* { section_id: 34, dd_lang: 'lg-aar', tld4: 'aar', tld2: 'aa',
*   glotocode: 'afar1241', walls: 'qaf', lat: 12.0, long: 42.0, locale: 'aa' }
*
* Used by: service_ckeditor, component_geolocation
* @returns {Promise<Array>} Resolves to the array of language registry objects
*/
// _json_langs_promise: module-level singleton to deduplicate concurrent fetches;
// reset to null once the response is cached in window['json_langs'].
let _json_langs_promise = null
export const get_json_langs = function () {

	// return from page global value. Shape-checked, not merely truthy: nothing
	// else in the tree writes this global, but the cache is served for the life
	// of the page, so an unusable value must never be handed out as a hit.
		if (Array.isArray(window['json_langs']) && window['json_langs'].length>0) {
			return Promise.resolve(window['json_langs'])
		}

	// return in-flight promise to prevent concurrent duplicate requests
		if (_json_langs_promise) {
			return _json_langs_promise
		}

	// calculate from server
	// NOTE only a USABLE payload is cached, and usable means what every consumer
	// actually does with it: a NON-EMPTY ARRAY of language records, which they
	// call .find() on. A failure envelope (`ok:false`), a 200 serving the wrong
	// body, an empty array or a network/parse error must never become the
	// permanent page global: the early return above never revalidates, so one
	// bad answer would freeze every later caller for the life of the page with
	// no retry. On anything unusable the singleton is released and null is
	// returned, so the next call re-fetches. Callers must treat null as "not
	// available" — they all guard the value with `|| []` before reading it.
		_json_langs_promise = data_manager.request({
			url		: DEDALO_CORE_URL + '/common/js/lang.json',
			method	: 'GET',
			cache	: 'force-cache' // force use cache because the file do not changes
		})
		.then(json_langs => {
			if (!Array.isArray(json_langs) || json_langs.length<1) {
				dd_console('[get_json_langs] Unable to load lang.json', 'ERROR', json_langs)
				_json_langs_promise = null
				return null
			}
			// fix as page global
			window['json_langs'] = json_langs
			_json_langs_promise = null
			return json_langs
		})
		.catch(error => {
			dd_console('[get_json_langs] Error loading lang.json', 'ERROR', error)
			_json_langs_promise = null
			return null
		})

	return _json_langs_promise
}//end get_json_langs



/**
* GET_TLD_FROM_TIPO
* Extracts the alphabetic TLD (top-level domain) prefix from a Dédalo ontology tipo.
*
* A tipo is a string of the form <tld><id>, where <tld> is two or more lowercase
* letters and <id> is a positive integer. For example 'rsc197' → 'rsc'.
*
* Returns false and logs a console.error when the input does not start with at
* least two lowercase letters (invalid tipo).
* @param {string} tipo - Ontology tipo identifier, e.g. 'rsc197', 'dd1', 'oh42'
* @returns {string|boolean} The alphabetic prefix (e.g. 'rsc'), or false on invalid input
*/
export const get_tld_from_tipo = function (tipo) {

	const match = tipo.match(/^[a-z]{2,}/);

	if (!match || !match[0]) {
		console.error(`Error: Invalid tipo received. Impossible get_tld_from_tipo this tipo: ${tipo}`);
		return false;
	}

  return match[0];
}//end get_tld_from_tipo



/**
* GET_SECTION_ID_FROM_TIPO
* Extracts the numeric section_id portion from a Dédalo ontology tipo.
*
* A tipo is a string of the form <tld><id>; this function returns the numeric
* <id> part as a string (not a number). For example 'rsc197' → '197'.
*
* Returns false and logs a console.error when the input contains no numeric
* substring (invalid tipo). Note: section_id 0 is considered invalid by the
* guard condition — this is intentional as Dédalo ids are 1-based.
* @param {string} tipo - Ontology tipo identifier, e.g. 'rsc197', 'dd1'
* @returns {string|boolean} The numeric portion as a string (e.g. '197'), or
*   false on invalid input
*/
export const get_section_id_from_tipo = function (tipo) {

	const match = tipo.match(/[0-9]+/);

	if (!match || (match[0] === '' && match[0] !== 0)) {
		console.error(`Error: Invalid tipo received. Impossible get_section_id_from_tipo this tipo: ${tipo}`);
		return false;
	}

  return match[0];
}//end get_section_id_from_tipo



/**
* SAME_SECTION_ID
* Type-safe equality for two section_id values that may arrive as number or
* string depending on their origin (URL params and dataset reads are always
* strings; bootstrap context and int-canonical wire payloads are numbers;
* stored locator data is historically string).
*
* Compares String(a) === String(b). This deliberately DIVERGES from the
* server's loose numeric compare on leading zeros ('05' vs 5 is NOT equal
* here) — and that is safe precisely because leading-zero section_ids exist
* ONLY on external-service records (e.g. zenon '001338683'), whose ids the
* server echoes verbatim on every path: both sides of any client comparison
* carry the identical byte form, so a numeric-value compare is never needed
* for them. Synthetic tokens ('search_1') compare byte-wise, which is the
* correct semantic too.
*
* null/undefined never equal anything (not even each other): a missing id is
* "no address", and two missing addresses are not the same record.
* @param {string|number|null|undefined} a
* @param {string|number|null|undefined} b
* @returns {bool}
*/
export const same_section_id = function(a, b) {

	if (a===null || a===undefined || b===null || b===undefined) {
		return false
	}

	return String(a) === String(b)
}//end same_section_id



/**
* GET_CALLER_BY_MODEL
* Walks the caller chain from instance upward and returns the first ancestor
* whose .model property equals the given model string.
*
* Every Dédalo instance holds a reference to its parent through the .caller
* property, forming a chain: component → section → page, for example. This
* function allows any nested component to locate the enclosing section or page
* without hard-coding depth assumptions.
*
* A Set of visited instances guards against circular references in the caller
* chain (which should not occur in normal operation but have been observed
* during hot reloads / incomplete teardown).
*
* Returns null when: instance has no .model, the chain terminates without a
* match, or a circular reference is detected.
* @param {Object} instance - The starting Dédalo instance
* @param {string} model - The model name to search for, e.g. 'section', 'page'
* @returns {Object|null} The first matching ancestor instance, or null
*/
export const get_caller_by_model = function(instance, model) {

	if (!instance.model) {
		console.error('Error. Instance do not proved model. NULL is returned:', instance);
		return null
	}

	let current_instance = instance;
    const visited = new Set();

	while (current_instance) {

        // Check for circular reference
        if (visited.has(current_instance)) {
            console.warn('Circular reference detected in get_caller_by_model:', instance, model);
            return null;
        }
        visited.add(current_instance);

		if (current_instance.model === model) {
			return current_instance;
		}

		current_instance = current_instance.caller;
	}

	return null;
}//end get_caller_by_model



/**
* GENERATE_HASH
* Generates a signed 32-bit integer hash from a string using the djb2-style
* rolling hash algorithm (hash = hash * 31 + charCode, kept 32-bit by bitwise OR 0).
*
* This is a non-cryptographic hash function suitable for cache keys, deduplication
* identifiers, and fast equality hints where security is not a concern. The same
* input always produces the same output within a JS engine session.
*
* The function also exposes generate_hash.toHex for a zero-padded 8-character
* hexadecimal representation of the same hash value.
* @param {string} input_string - The string to hash; must be a string
* @returns {number} Signed 32-bit integer hash value (may be negative)
* @throws {TypeError} When input_string is not a string
* @example
* generate_hash('hello world'); // e.g. -1058936117
* generate_hash('test') === generate_hash('test'); // true — deterministic
*/
export const generate_hash = (input_string) => {
  // Input validation
  if (typeof input_string !== 'string') {
    throw new TypeError('Input must be a string');
  }

  // Handle empty string case
  if (input_string.length === 0) {
    return 0;
  }

  let hash = 0;

  for (let i = 0; i < input_string.length; i++) {
    const char_code = input_string.charCodeAt(i);
    hash = ((hash << 5) - hash) + char_code;
    hash = hash | 0; // Convert to 32-bit integer
  }

  return hash;
};//end generate_hash
/**
* GENERATE_HASH.TOHEX
* Returns the same 32-bit hash as generate_hash but as a zero-padded 8-character
* lowercase hex string. The unsigned right-shift (>>> 0) converts the potentially
* negative signed integer to its unsigned 32-bit equivalent before hex formatting,
* ensuring the result is always exactly 8 characters.
*
* Example: generate_hash.toHex('hello world') → 'c1925e0b'
* @param {string} input_string - The string to hash (forwarded to generate_hash)
* @returns {string} Zero-padded 8-character lowercase hex string
*/
generate_hash.toHex = (input_string) => {
  const hash = generate_hash(input_string);
  // Convert to unsigned 32-bit integer and format as hex
  return (hash >>> 0).toString(16).padStart(8, '0');
};



/**
* TOOL_BASE_URL
* Resolves the base web URL for a given tool model, accounting for multi-root
* tool installations (DEDALO_ADDITIONAL_TOOLS).
*
* Tools that live outside the primary tools directory are registered in the
* DEDALO_TOOLS_URLS global map, which is populated server-side by
* tool_paths::get_additional_tools_url_map(). When a model key is present in
* that map its value is returned directly. Otherwise the URL is constructed
* from the primary DEDALO_TOOLS_URL root.
*
* Example outputs:
*   'tool_lang'   → '/dedalo/tools/tool_lang'   (primary root)
*   'tool_custom' → '/custom_tools/tool_custom'  (additional root)
* @param {string} model - Tool model identifier, e.g. 'tool_lang', 'tool_export'
* @returns {string} Absolute-path base URL for the tool, without a trailing slash
*/
export function tool_base_url(model) {

	if (typeof DEDALO_TOOLS_URLS!=='undefined'
		&& DEDALO_TOOLS_URLS
		&& DEDALO_TOOLS_URLS[model]) {
		return DEDALO_TOOLS_URLS[model]
	}

	return DEDALO_TOOLS_URL + '/' + model
}//end tool_base_url

/**
* APPEND_TEXT_LINES
* Append one or more lines to a node as TEXT NODES separated by real <br>
* elements. THE way to print server text (msg, errors, file paths, exception
* text) without an HTML sink: `inner_html` / `insertAdjacentHTML` parse whatever
* the server sent, this cannot (error_report_xss_tripwire, SEC-XSS-005).
*
* @param {HTMLElement} node - target container (its existing children are kept)
* @param {Array|string} lines - one line or a list of them; null/undefined dropped
* @returns {HTMLElement} the same node, for chaining
*/
export function append_text_lines(node, lines) {

	if (!node) {
		return node
	}

	const list = (Array.isArray(lines) ? lines : [lines]).filter(line => line!==null && line!==undefined)
	for (let i = 0; i < list.length; i++) {
		if (i > 0) {
			node.appendChild(document.createElement('br'))
		}
		node.appendChild(document.createTextNode(String(list[i])))
	}

	return node
}//end append_text_lines



/**
* SAFE_URL
* The ONE scheme allowlist for record-authored URLs (P2-6 / XSS-04).
*
* A record's value reaches `href`, `src` and `window.open` — and a
* `javascript:` URL in any of them EXECUTES. The app CSP makes injected
* <script> non-executing in-app, which is why this class is S3 rather than S2
* today, but a CSP is one header away from being the only control, and
* `window.open('javascript:…')` navigates a window this page opened: defence in
* depth is the whole point of having a second control at all.
*
* ALLOWLIST, never a blocklist. `javascript:` has too many spellings to deny —
* leading control characters and whitespace are stripped by the parser
* (`java\tscript:`), the scheme is case-insensitive, and HTML entities decode
* before the URL is read. Naming what is PERMITTED needs none of that: anything
* the URL parser does not resolve to one of these schemes is refused.
*
* Relative URLs are permitted: they cannot carry a scheme, and they are how
* every internal link in the application is written.
*
* @param {string} value - the candidate URL, as authored in the record
* @returns {string|null} the value when safe to navigate to, else null
*/
export const safe_url = function(value) {

	if (typeof value !== 'string') return null

	const trimmed = value.trim()
	if (trimmed === '') return null

	// A relative URL has no scheme to abuse. `new URL` throws on these, which is
	// how we tell them apart without parsing by hand.
	let parsed
	try {
		parsed = new URL(trimmed, window.location.origin)
	} catch (_error) {
		return null
	}

	// The parser has already lower-cased the scheme and stripped the control
	// characters and entities that make a blocklist unworkable.
	const allowed = ['http:', 'https:', 'mailto:', 'ftp:', 'ftps:']
	return allowed.includes(parsed.protocol) ? trimmed : null
}//end safe_url


// @license-end
