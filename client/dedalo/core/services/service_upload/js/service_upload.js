// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_label, console, SHOW_DEVELOPER, DEDALO_UPLOAD_SERVICE_CHUNK_FILES, DEDALO_UPLOAD_SERVICE_MAX_CONCURRENT */
/*eslint no-undef: "error"*/



/**
* SERVICE_UPLOAD
* Generic multi-part file upload service for the Dédalo v7 platform.
*
* (!) THE WIRE LIVES IN `upload_transport.js`. Since the transport extraction
* this module holds NO XMLHttpRequest, no multipart shape, no CSRF handling and
* no chunk bookkeeping. What remains here is the DOM-aware, single-file UX layer:
* the instance lifecycle, the `upload_file_status_<id>` / `upload_file_done_<id>`
* event topics, and the blocking alert() on a validation refusal. Anything that
* is about bytes belongs in the transport; anything that a human sees belongs here.
*
* Responsibilities:
* - Negotiates server upload limits via `dd_utils_api::get_system_info`.
* - Delegates validation, chunking, concurrency, retries, the SEC-008 CSRF twin
*   and the server-side join to upload_transport.js (chunk size from
*   DEDALO_UPLOAD_SERVICE_CHUNK_FILES, window from DEDALO_UPLOAD_SERVICE_MAX_CONCURRENT).
* - Renders the transport's callbacks as `upload_file_status_<id>` events and
*   publishes `upload_file_done_<id>` after a successful upload, so callers
*   (render_edit_service_upload, tool_import, component_av, …) can update their UI
*   without tight coupling to this class.
*
* Consumers instantiate `service_upload`, call `init(options)` → `build()` → `render()`,
* then let the rendered UI call `upload_file()` automatically on file-selection or drop.
* The standalone `upload()` export may also be called directly by tools that manage
* their own file-picking UI (e.g. tool_import_dedalo_csv).
*
* Main exports:
* - `service_upload` constructor / prototype — the primary instantiable service class.
* - `upload` — the low-level, standalone upload function (chunked or single-shot).
*/

// import
	import { event_manager } from '../../../common/js/event_manager.js'
	import { data_manager } from '../../../common/js/data_manager.js'
	import { dd_console } from '../../../common/js/utils/index.js'
	import { common, create_source } from '../../../common/js/common.js'
	import { render_edit_service_upload } from './render_edit_service_upload.js'
	import { validate_file, create_connection_pool, create_transfer } from './upload_transport.js'
	import {response_data, request_failed, ApiError, CLIENT_ERROR} from '../../../common/js/api_error.js'
	import {error_text} from '../../../common/js/render_api_error.js'



/**
* SERVICE_UPLOAD
* Constructor for the file-upload service instance.
*
* All properties are initialised to null here; they are populated by
* `init()` (from common + upload-specific options) and `build()` (from the
* server's system-info response).
*
* Key properties set after `init()`:
* - `id`                  {string}  — unique instance id used as event-name suffix.
* - `caller`              {Object}  — the component or tool that owns this service;
*                                     MANDATORY — init() logs an error if absent.
* - `allowed_extensions`  {Array}   — lowercase extension whitelist, e.g. ['jpg','tiff'].
* - `key_dir`             {string|null} — server-side directory key that routes the
*                                     uploaded file to the correct storage path.
* - `max_concurrent`      {number}  — cap on simultaneous XHR chunk connections
*                                     (default 50, overridden by DEDALO_UPLOAD_SERVICE_MAX_CONCURRENT).
* - `progress_info`       {HTMLElement} — set by render_edit_service_upload; receives text updates.
* - `progress_line`       {HTMLElement} — <progress> element; receives numeric % updates.
* - `response_msg`        {HTMLElement} — receives final success/error text.
*
* Additional properties set after `build()` (values sourced from PHP ini / config):
* - `max_size_bytes`      {number}  — PHP upload_max_filesize expressed in bytes.
* - `sys_get_temp_dir`    {string}  — server system temp directory.
* - `upload_tmp_dir`      {string}  — PHP upload_tmp_dir ini value.
* - `upload_tmp_perms`    {number}  — octal permissions of upload_tmp_dir.
* - `session_cache_expire`{number}  — PHP session.cache_expire in minutes.
* - `upload_service_chunk_files` {number|boolean} — chunk size in MB, or false = disabled.
* - `pdf_ocr_engine`      {boolean} — whether the server's ocrmypdf binary is present and executable.
* - `pdf_ocr_langs`       {Array<string>} — application langs (`lg-*`) whose Tesseract model is
*                          installed: the only languages the OCR select may offer.
*/
export const service_upload = function () {

	this.id					= null
	this.model				= null
	this.mode				= null
	this.node				= null
	this.ar_instances		= null
	this.status				= null
	this.events_tokens		= null
	this.type				= null
	this.caller				= null

	this.max_size_bytes		= null
	this.allowed_extensions	= null

	this.max_concurrent 	= null

	// multi-file mode. `multiple===true` swaps the single-file form for the
	// upload-queue renderer (render_edit_service_upload_queue.js).
	// (!) ONE MODEL, NOT TWO. `self.model` stays 'service_upload' in both modes:
	// instances.js:262-280 derives the module path FROM the model string and then
	// requires the module's named export to equal the model exactly, so a second
	// model would force a whole duplicate service directory (own file, prototype
	// block, img/icon.svg — render_edit_service_upload.js builds the icon src from
	// self.model — LESS partial, main.less import and test rows) to say "the same
	// service, with more files".
	this.multiple			= null
	this.key_dir			= null
	this.component_option	= null
	this.file_processor		= null

	// set by the queue renderer; consumed by destroy()
	this.queue				= null
	this.row_map			= null
	this.object_urls		= null
	this.dom_listeners		= null
	this.queue_teardown		= null
}//end page



/**
* COMMON FUNCTIONS
* Extend instance with shared prototype methods from common / render modules.
*/
// prototypes assign
	service_upload.prototype.render		= common.prototype.render
	service_upload.prototype.refresh	= common.prototype.refresh
	service_upload.prototype.edit		= render_edit_service_upload.prototype.edit



/**
* INIT
* Initialises the service_upload instance.
*
* Delegates generic Dédalo instance setup to `common.prototype.init`, then applies
* upload-specific configuration.  Also subscribes to `upload_file_status_<id>` events
* so that any change in upload progress updates the progress bar and response message
* elements that are attached to `self` by `render_edit_service_upload`.
*
* The `upload_file_status` handler distinguishes three states via `options.value`:
*   - `false`  → error/abort: writes `options.text` into `response_msg`.
*   - `100`    → complete: writes "Upload done." into `response_msg`.
*   - 0–99     → in-progress: updates `progress_line.value` and `progress_info.innerHTML`.
*
* (!) `options.caller` is mandatory.  Without a caller the service cannot resolve
* `key_dir` during `upload_file()` and the upload will be misconfigured.
*
* @param {Object} options - Initialisation options forwarded from the owning caller.
*   @param {string}  [options.model='service_upload'] - Model name used for URL/icon resolution.
*   @param {Array}   [options.allowed_extensions=[]]  - Lowercase file extensions whitelist.
*   @param {string|null} [options.key_dir=null]       - Server directory routing key.
*   @param {boolean} [options.multiple=false]         - true renders the MULTI-FILE
*     upload queue instead of the single-file form. Strict === true.
*   @param {Array|null} [options.component_option=null] - Multi-file only: target
*     component ddos offered per row ({tipo, label, default}).
*   @param {Array|null} [options.file_processor=null]   - Multi-file only: processing
*     pipelines offered per row ({function_name, function_name_label, default}).
* @returns {Promise<boolean>} Result of common.prototype.init (true on success).
*/
service_upload.prototype.init = async function(options) {

	const self = this

	// call the generic common init
		const common_init = await common.prototype.init.call(this, options);

	// fix
		self.model				= options.model || 'service_upload'
		self.allowed_extensions	= options.allowed_extensions || []
		self.key_dir			= options.key_dir || null
		// multiple: strict === true. A truthy-ish value (a string, a 1) coming from
		// a tool config must not silently swap the whole renderer.
		self.multiple			= options.multiple === true
		// Multi-file only: the two per-row <select> lists. Absent = no
		// `.component.options` block is emitted at all.
		self.component_option	= options.component_option || null
		self.file_processor		= options.file_processor || null
		// Read the global constant injected by dd_core_api; fall back to 50
		// if the constant was not yet defined when this module loaded.
		self.max_concurrent 	= typeof DEDALO_UPLOAD_SERVICE_MAX_CONCURRENT === 'undefined'
			? 50
			: DEDALO_UPLOAD_SERVICE_MAX_CONCURRENT

	// check
		if (!self.caller) {
			console.error('Caller is mandatory for service_upload:', self);
		}

	// events
		const upload_file_status_handler = (options) => {
			// options
				const msg	= options.text
				const value	= options.value

			// DOM node fixed on render
				const progress_info	= self.progress_info
				const progress_line	= self.progress_line
				const response_msg	= self.response_msg

			// progress
				// `msg` is server/transport text (file names, refusal sentences,
				// exception details): TEXT only, never an HTML sink (DS-1).
				if (progress_info) {
					progress_info.textContent = msg // progress text info
				}
				if (progress_line) {
					progress_line.value = value // percentage line
				}

			// messages
				if (response_msg) {
					if(value===false) {
						response_msg.textContent = msg
					}
					else if(value===100) {
						response_msg.textContent = 'Upload done.'
					}
				}
		}
		self.events_tokens.push(
			event_manager.subscribe('upload_file_status_'+self.id, upload_file_status_handler)
		)


	return common_init
}//end init



/**
* BUILD
* Fetches PHP server configuration needed by the upload UI and stores it on the instance.
*
* Called once after `init()`.  Issues a single API call (`dd_utils_api::get_system_info`)
* to retrieve upload limits and environment details that are only known server-side
* (PHP ini values, temp-dir paths, OCR engine availability, chunk-file setting).
*
* After `build()` returns, `self.max_size_bytes` is safe to use in extension/size
* validation, and `self.upload_service_chunk_files` controls whether chunked transfer
* is activated during `upload_file()`.
*
* @param {boolean} [autoload=false] - Unused; present for interface parity with common.build.
* @returns {Promise<boolean>} Always resolves to `true` once server info is stored.
*/
service_upload.prototype.build = async function(autoload=false) {

	const self = this

	// status update
		self.status = 'building'

	// fetch system info
		const system_info = await get_system_info(self)
		// set as tool properties
			self.max_size_bytes				= system_info.max_size_bytes
			self.sys_get_temp_dir			= system_info.sys_get_temp_dir
			self.upload_tmp_dir				= system_info.upload_tmp_dir
			self.upload_tmp_perms			= system_info.upload_tmp_perms
			self.session_cache_expire		= system_info.session_cache_expire
			self.upload_service_chunk_files	= system_info.upload_service_chunk_files
			self.pdf_ocr_engine				= system_info.pdf_ocr_engine
			self.pdf_ocr_langs				= Array.isArray(system_info.pdf_ocr_langs)
				? system_info.pdf_ocr_langs
				: []

	// queue limits. The queue is created by the renderer (it needs the DOM
	// callbacks), so a build() that runs AFTER a render — the refresh cycle does
	// exactly that — must push the refreshed server limits into the live queue.
	// Without this a re-built service keeps validating against whatever the limits
	// were on first render.
		if (self.queue) {
			self.queue.max_size_bytes	= self.max_size_bytes
			self.queue.chunk_size_mb	= self.upload_service_chunk_files || 0
		}

	// status update
		self.status = 'built'


	return true
}//end build_custom



/**
* RESET_QUEUE
* Empties the multi-file queue without destroying it, so the same instance can
* keep receiving files.
*
* The stable reset surface a consumer calls after an import completes
* (tool_import_files does it from its SSE finish handler). Mirrors the semantics
* of the retired `service_dropzone.reset_dropzone`: false means "nothing to
* reset", not "failed".
*
* (!) `clear()`, never `self.queue.entries = []` — the entries array IS the
* caller's `files_data`, adopted once and held forever; replacing it leaves every
* importer reading a detached array and sending zero files.
*
* @returns {boolean} true when a queue existed and was cleared.
*/
service_upload.prototype.reset_queue = function() {

	const self = this

	if (self.queue) {
		self.queue.clear()
		return true
	}

	return false
}//end reset_queue



/**
* DESTROY
* Deterministic teardown of the multi-file render, then the generic destructor.
*
* Order matters: abort transfers first (a chunk that lands after the row is gone
* writes a staging blob nothing will ever join), then release the object URLs and
* row map, then unbind every DOM listener — including the two `document`-level
* drag guards, which are the ONLY listeners this widget puts outside its own
* subtree and therefore the only ones that could stack across renders. That
* stacking is precisely what forced `service_dropzone` to grow a bespoke
* `destroy()`: Dropzone attached to `document.body` and left everything behind.
*
* (!) ALL THREE ARGUMENTS ARE FORWARDED. The dropzone override swallowed them
* (`common.prototype.destroy.call(self)`), silently forcing the defaults — so a
* caller asking for `remove_dom` or `delete_dependencies` got neither.
*
* @param {boolean} [delete_self=true]
* @param {boolean} [delete_dependencies=false]
* @param {boolean} [remove_dom=false]
* @returns {Promise<Object>} The generic destructor's result.
*/
service_upload.prototype.destroy = async function(delete_self=true, delete_dependencies=false, remove_dom=false) {

	const self = this

	// queue
		if (self.queue && typeof self.queue.destroy==='function') {
			try {
				self.queue.destroy()
			} catch (error) {
				console.error('service_upload destroy: error destroying the upload queue', error)
			}
			self.queue = null
		}

	// render-owned resources (object URLs, row map, thumbnail scheduler)
		if (typeof self.queue_teardown==='function') {
			try {
				self.queue_teardown()
			} catch (error) {
				console.error('service_upload destroy: error tearing down the queue render', error)
			}
			self.queue_teardown = null
		}

	// DOM listeners
		if (Array.isArray(self.dom_listeners)) {
			for (let i = self.dom_listeners.length - 1; i >= 0; i--) {
				const listener = self.dom_listeners[i]
				try {
					listener.node.removeEventListener(listener.type, listener.handler, listener.options)
				} catch (error) {
					console.error('service_upload destroy: error removing a DOM listener', error)
				}
			}
			self.dom_listeners = []
		}


	return common.prototype.destroy.call(self, delete_self, delete_dependencies, remove_dom)
}//end destroy



/**
* GET_SYSTEM_INFO
* Queries the server for PHP environment values that are not available on the client.
*
* The returned object shape mirrors `dd_utils_api::get_system_info()`:
* ```json
* {
*   "max_size_bytes":           <number>,
*   "sys_get_temp_dir":         <string>,
*   "upload_tmp_dir":           <string>,
*   "upload_tmp_perms":         <number>,
*   "session_cache_expire":     <number>,  // minutes
*   "upload_service_chunk_files": <number|false>,
*   "pdf_ocr_engine":           <boolean>,
*   "pdf_ocr_langs":            <string[]>  // e.g. ["lg-spa","lg-eng"]
* }
* ```
* Called internally by `build()`.  Not exported.
*
* @returns {Promise<Object>} Resolved system-info object from the API response's `result` field.
*/
const get_system_info = async function() {

	// rqo
		const rqo = {
			dd_api	: 'dd_utils_api',
			action	: 'get_system_info'
		}

	// call to the API, fetch data and get response
		return new Promise(function(resolve){

			data_manager.request({
				body : rqo
			})
			.then(function(response){
				if(SHOW_DEVELOPER===true) {
					dd_console("-> get_system_info API response:",'DEBUG',response);
				}

				resolve(response_data(response))
			})
		})
}//end get_system_info



/**
* UPLOAD
* Thin, DOM-AWARE adapter over the wire core in upload_transport.js.
*
* Everything that touches bytes now lives in `create_transfer`; what stays here
* is exactly the legacy single-file UX contract, quarantined on purpose:
*
*  - the `upload_file_status_<id>` event topic, with the same value/text
*    semantics as before (0 on start, N in progress, 100 on done, `false` on
*    error or abort). service_upload.prototype.init subscribes to it and drives
*    the one progress bar / response message the service renders.
*  - the BLOCKING `alert()` on a validation failure. It stays HERE and not in
*    the transport because the multi-file queue must never block: a queue that
*    alerts once per rejected file is unusable. The transport returns a verdict;
*    this caller is the one that chose to shout it.
*
* Chunked vs single-shot is still decided by DEDALO_UPLOAD_SERVICE_CHUNK_FILES
* (MB per chunk; >0 = chunked), and the concurrency window still comes from the
* caller's `max_concurrent` — the info panel edits it live between uploads.
*
* (!) The pool is created PER CALL here, which reproduces the legacy per-file
* window. It is a deliberate hold: sharing one pool across files is only
* meaningful once something uploads more than one file at a time, and that
* belongs to the queue phase, not to this extraction.
*
* SEC-008 (CSRF), the multipart field/header shape and the server-side join are
* all owned by upload_transport.js and are byte-identical to the previous
* implementation — see the wire notes there.
*
* @param {Object} options - Upload configuration.
*   @param {Object}  [options.self]            - Ignored; kept for signature
*                                                compatibility with old callers.
*   @param {string}  options.id                - Unique identifier appended to event names.
*   @param {File}    options.file              - The browser File object to upload.
*   @param {string}  options.key_dir           - Server-side directory routing key.
*   @param {Array}   [options.allowed_extensions] - Lowercase extension whitelist.
*                                                EMPTY OR ABSENT = ALLOW ALL (defect D3).
*   @param {number}  [options.max_size_bytes]  - Maximum allowed size in bytes; falsy = no cap.
*   @param {string|null} [options.tipo]        - Ontology tipo of the owning component.
*   @param {number|false} [options.max_concurrent] - Max simultaneous XHR connections; falsy = unlimited.
* @returns {Promise<Object>} API response object. On success the envelope `{ok:true, data, file_data:{…}}`;
*   on ANY failure (validation, transport, abort, server refusal) `{ok:false, error:ApiError}`.
*   (!) It ALWAYS returns — see defect D1 in upload_transport.js.
*/
export const upload = async function(options) {

	// options
		const id					= options.id // id done by the caller, used to send the events of progress
		const file					= options.file // object {name:'xxx.jpg',size:5456456}
		const key_dir				= options.key_dir // string like 'image' used to target dir
		const allowed_extensions	= options.allowed_extensions // array ['tiff', 'jpeg']
		const max_size_bytes		= options.max_size_bytes // int 352142
		const tipo					= options.tipo // self.caller.caller.tipo, like service_upload.tool_upload.component_image.tipo
		const max_concurrent		= options.max_concurrent

	// publish_status
		// The one place this module talks to the UI.
		const publish_status = function(value, msg) {
			event_manager.publish('upload_file_status_' + id, {
				value	: value,
				text	: msg
			})
		}

	// validation
		// The transport decides IF the file is acceptable; this layer decides HOW
		// the refusal is shown. `code` is a get_label key, `msg` the detail text
		// appended to it, which keeps the alert text identical to the legacy one.
		const validation = validate_file({
			file				: file,
			allowed_extensions	: allowed_extensions,
			max_size_bytes		: max_size_bytes
		})
		if (validation.valid===false) {
			const label = get_label[validation.code] || validation.code
			const text	= label + validation.detail
			alert( text )
			publish_status(false, text)
			// ONE failure shape (the page transport's): a coded ApiError the caller
			// renders through error_text(). `media.upload_rejected` is the SAME
			// registry code the server answers a refused upload with — the refusal
			// is identical, this one simply happens before the bytes leave.
			return {
				ok		: false,
				error	: new ApiError({
					code		: 'media.upload_rejected',
					message		: text,
					severity	: 'warning',
					source		: 'client'
				})
			}
		}

	// chunk_size_mb
		// `typeof` guard: the constant is injected by the server environment
		// payload, and a module that loads before it exists must fall back to
		// single-shot rather than die on a ReferenceError.
		const chunk_size_mb = (typeof DEDALO_UPLOAD_SERVICE_CHUNK_FILES !== 'undefined' && DEDALO_UPLOAD_SERVICE_CHUNK_FILES > 0)
			? DEDALO_UPLOAD_SERVICE_CHUNK_FILES
			: 0

	// transfer
		const transfer = create_transfer({
			file			: file,
			name			: file.name,
			key_dir			: key_dir,
			tipo			: tipo,
			chunk_size_mb	: chunk_size_mb,
			pool			: create_connection_pool(max_concurrent),
			max_retry		: 3,
			callbacks		: {
				on_start : function() {
					publish_status(0, 'Loading file ' + file.name)
				},
				on_progress : function(progress) {
					publish_status(progress.percent, `Upload progress: ${progress.percent} %`)
				},
				on_retry : function() {
					// A network error is not necessarily fatal: the chunk is being
					// resent, so the message is a warning, not a verdict.
					publish_status(false, 'Trying to upload file ' + file.name)
				}
			}
		})

	// start. Resolves EXACTLY ONCE on every terminal path and never rejects, so
	// this await can no longer hang the caller (defect D1).
		const api_response = await transfer.start()

	// status
		if (!api_response || request_failed(api_response) || response_data(api_response)!==true) {
			const api_error = request_failed(api_response)
				? api_response.error
				: new ApiError({
					code	: CLIENT_ERROR.BAD_RESPONSE,
					message	: `${get_label.error_on_upload_file} ${file.name}`
				})
			publish_status(false, error_text(api_error))
			return {
				ok		: false,
				error	: api_error
			}
		}
		publish_status(100, 'Loaded file ' + file.name)


	return api_response
}//end upload



/**
* UPLOAD_FILE
* High-level upload entry-point called by the service's own render layer
* (`file_selected` in render_edit_service_upload.js) or by tool callers that
* have already obtained a File object.
*
* Resolves the server-side `key_dir` routing key using a three-level fallback
* cascade (in order of precedence):
*   1. `self.key_dir` — explicitly set during `init()`.
*   2. `self.caller.context.features.key_dir` — owning component's feature config.
*   3. `self.caller.caller.context.features.key_dir` — grandparent component's feature config.
*   4. `self.caller.caller.model` — grandparent model name used as a directory key (e.g. 'image').
*
* After a successful upload, publishes `upload_file_done_<caller.id>` with:
*   `{ file_data: <Object>, process_options: <Object> }`
* so that the owning component can trigger server-side post-processing
* (e.g. component_av media pipeline, tool_import_dedalo_csv row processing).
*
* On upload failure returns `{ ok:false, error:ApiError }` without publishing
* the done event, so callers can surface the error independently.
*
* @param {Object} options - Upload options.
*   @param {File} options.file - The browser File object selected or dropped by the user.
* @returns {Promise<Object>} API response from the underlying `upload()` call.
*   Shape: `{ result: boolean, file_data?: Object, msg?: string }`.
*/
service_upload.prototype.upload_file = async function(options) {

	const self = this

	// options
		const file = options.file;

	// short vars
		const allowed_extensions	= self.allowed_extensions
		// Resolve the server-side directory routing key via a waterfall:
		// self.key_dir → caller features → caller.caller features → caller.caller model name.
		const key_dir				= self.key_dir
			? self.key_dir
			: self.caller.context.features && self.caller.context.features.key_dir
				? self.caller.context.features.key_dir
				: self.caller.caller.context.features && self.caller.caller.context.features.key_dir
					? self.caller.caller.context.features.key_dir
					: (self.caller.caller.model || null) // like 'image'

	// upload (using service upload)
		const api_response = await upload({
			id					: self.id, // id done by the caller, used to send the events of progress
			file				: file, // object {name:'xxx.jpg',size:5456456}
			key_dir				: key_dir, // string like 'image' used to target dir
			allowed_extensions	: allowed_extensions, // array ['tiff', 'jpeg']
			max_size_bytes		: self.max_size_bytes, // int 352142
			tipo				: self.caller?.caller?.tipo || null,
			max_concurrent 		: self.max_concurrent // int | false, limit the open connections with the server
		})
		if (request_failed(api_response) || !response_data(api_response)) {
			console.error("Error on api_response:", api_response);
			return {
				ok		: false,
				error	: request_failed(api_response)
					? api_response.error
					: new ApiError({
						code	: CLIENT_ERROR.BAD_RESPONSE,
						message	: 'Error on api_response'
					})
			}
		}

	// event upload_file_done_
		event_manager.publish('upload_file_done_' + self.caller?.id, {
			file_data		: api_response.file_data,
			process_options	: self.process_options
		})


	return api_response
}//end upload_file



// @license-end
