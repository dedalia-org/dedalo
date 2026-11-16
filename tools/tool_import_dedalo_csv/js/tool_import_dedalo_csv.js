// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_label, page_globals, SHOW_DEBUG, DEDALO_CORE_URL */
/*eslint no-undef: "error"*/



// import needed modules
	import {dd_console} from '../../../core/common/js/utils/index.js'
	import {ui} from '../../../core/common/js/ui.js'
	import {data_manager} from '../../../core/common/js/data_manager.js'
	import {request_failed, response_data} from '../../../core/common/js/api_error.js'
	import {error_text} from '../../../core/common/js/render_api_error.js'
	import {event_manager} from '../../../core/common/js/event_manager.js'
	import {get_instance} from '../../../core/common/js/instances.js'
	import {common, create_source} from '../../../core/common/js/common.js'
	import {tool_common} from '../../../core/tools_common/js/tool_common.js'
	import {render_tool_import_dedalo_csv} from './render_tool_import_dedalo_csv.js' // self tool rendered (called from render common)
	import {apply_section_tipo_correction} from './section_tipo_from_file_name.js'



/**
* TOOL_IMPORT_DEDALO_CSV
* Client-side controller for the Dédalo CSV bulk-import tool.
*
* This module owns the data-layer responsibilities of the import tool:
* - Fetching the list of CSV files already staged in the server's per-user upload
*   directory (DEDALO_TOOL_IMPORT_DEDALO_CSV_FOLDER_PATH/<user_id>/).
* - Deleting a staged CSV file before import.
* - Querying the component list of a target section (for the column mapper).
* - Moving a freshly uploaded temp file to its definitive location.
* - Triggering the actual import run (background process) and polling its progress
*   via SSE through render_tool_import_dedalo_csv.
*
* All DOM rendering is delegated to render_tool_import_dedalo_csv (edit, upload_done).
* Lifecycle scaffolding (render, destroy, refresh) is mixed in from tool_common /
* common. Every API call goes through data_manager.request() to dd_tools_api with
* action 'tool_request', matching the server-side API_ACTIONS allowlist.
*
* @see class.tool_import_dedalo_csv.php  — server-side counterpart
* @see render_tool_import_dedalo_csv.js  — DOM rendering and process-stream handling
*/
export const tool_import_dedalo_csv = function () {

	// Standard fields shared by all tool/component instances (populated by tool_common.init).
	this.id				= null
	this.model			= null
	this.mode			= null
	this.node			= null
	this.ar_instances	= null // child instances (service_upload); destroyed on tool destroy
	this.events_tokens	= null // event_manager subscriptions; released on destroy
	this.status			= null
	this.main_element	= null
	this.type			= null
	this.source_lang	= null
	this.target_lang	= null
	this.langs			= null
	this.caller			= null // the section instance that opened this tool

	// Tool-specific fields.
	this.csv_files_list		= null // {Array} fetched by load_csv_files_list; each entry is a file descriptor object
	this.csv_files_notices	= null // {Array<string>} what the server DID to a staged file to read it (an encoding conversion); rendered by render()
	this.csv_files_errors	= null // {Array<string>} the staged files the server could NOT read (too large, NUL bytes, damaged text); rendered by render()
	this.section_tipo_corrections = {} // {Object} {file_name: section_tipo} the user typed by hand; browser-local (see load_section_tipo_corrections)
}//end tool_import_dedalo_csv



/**
* SECTION_TIPO_CORRECTIONS_ID
* Local DB ('data' table) key of the user's manual section_tipo corrections.
* Browser-only convenience: never sent to the server.
*/
const SECTION_TIPO_CORRECTIONS_ID = 'tool_import_dedalo_csv_section_tipo'



/**
* COMMON FUNCTIONS
* Extend tool_import_dedalo_csv with shared prototype methods from tool_common,
* common, and the render module.
*
* destroy / refresh come from the shared bases unchanged; render is the shared
* one WRAPPED below (it adds the staged-files notice surface and nothing else).
* edit and upload_done are provided by render_tool_import_dedalo_csv so that
* all DOM-building logic stays in the render module while the tool controller
* (this file) remains data-focused.
*/
// prototypes assign
	tool_import_dedalo_csv.prototype.destroy		= common.prototype.destroy
	tool_import_dedalo_csv.prototype.refresh		= common.prototype.refresh
	// render mode edit (default). Set the tool custom manager to build the DOM nodes view
	tool_import_dedalo_csv.prototype.edit			= render_tool_import_dedalo_csv.prototype.edit
	tool_import_dedalo_csv.prototype.upload_done	= render_tool_import_dedalo_csv.prototype.upload_done



/**
* INIT
* Custom tool initialisation. Delegates the bulk of the work to the generic
* tool_common.prototype.init (which sets id, model, mode, context, ar_instances,
* events_tokens, etc.) and then wires the tool-specific event subscription.
*
* The 'upload_file_done_<id>' event is published by service_upload once a file
* transfer completes. Subscribing here ensures upload_done() is called on the
* correct tool instance regardless of how many tool panels are open simultaneously.
*
* @param {Object} options - Initialisation options forwarded from get_instance / render
* @returns {Promise<boolean>} Resolves with the boolean result of tool_common.init
*/
tool_import_dedalo_csv.prototype.init = async function(options) {

	const self = this

	// call the generic common tool init
		const common_init = await tool_common.prototype.init.call(this, options);

	// set the self specific vars not defined by the generic init (in tool_common)
		// self.lang	= options.lang // page_globals.dedalo_data_lang
		// self.langs	= page_globals.dedalo_projects_default_langs
		// self.etc		= options.etc

	// events
		// Subscribe to the upload completion event keyed by this tool's id so
		// that upload_done() is only triggered for uploads belonging to this instance.
		const upload_file_done_handler = (options) => {
			self.upload_done(options)
		}
		self.events_tokens.push(
			event_manager.subscribe('upload_file_done_' + self.id, upload_file_done_handler)
		)


	return common_init
}//end init



/**
* BUILD
* Custom tool build. Delegates to tool_common.prototype.build for the shared
* scaffolding (context load, ddo rendering), then performs two tool-specific
* setup steps:
*
* 1. Fetches the list of CSV files already in the server staging directory and
*    stores it in self.csv_files_list. This list drives the file-picker UI in
*    render_tool_import_dedalo_csv.prototype.edit.
*
* 2. Creates and initialises a service_upload instance (restricted to .csv files,
*    scoped to the 'csv' key_dir) and registers it in self.ar_instances so it is
*    cleaned up when the tool is destroyed.
*
* Any failure inside the try block stores the error on self.error and logs it;
* the common_build result is still returned so the caller can detect init failure.
*
* @param {boolean} [autoload=false] - When true, tool_common.build triggers data auto-load
* @returns {Promise<boolean>} Resolves with the boolean result of tool_common.build
*/
tool_import_dedalo_csv.prototype.build = async function(autoload=false) {

	const self = this

	// call generic common tool build
		const common_build = await tool_common.prototype.build.call(this, autoload);

	try {

		// set allowed_extensions
			// self.context.features.allowed_extensions	= ['csv']
			// self.context.features.target_dir			= {
			// 	type	: 'dedalo_config',
			// 	value	: 'DEDALO_TOOL_IMPORT_DEDALO_CSV_FOLDER_PATH' // defined in config
			// }

		// load files list from dir (defined in Dédalo config file constants DEDALO_TOOL_IMPORT_DEDALO_CSV_FOLDER_PATH)
			self.csv_files_list = await self.load_csv_files_list()

		// section_tipo_corrections. Manual section_tipo per file name, remembered in this browser
			self.section_tipo_corrections = await self.load_section_tipo_corrections()

		// service_upload
			// get instance and init
			// (!) key_dir 'csv' scopes uploads to the CSV staging sub-directory;
			// allowed_extensions enforces server-side validation to .csv only.
			self.service_upload = await get_instance({
				model				: 'service_upload',
				mode				: 'edit',
				allowed_extensions	: ['csv'],
				caller				: self,
				key_dir 			: 'csv'
			})
			// console.log("self.service_upload:",self.service_upload);
			// store to destroy on close modal
			self.ar_instances.push(self.service_upload)

	} catch (error) {
		self.error = error
		console.error(error)
	}


	return common_build
}//end build



/**
* RENDER
* The shared tool render (tool_common.prototype.render), plus the ONE thing the
* render module cannot show: what the server DID to a staged file in order to
* read it.
*
* WHY IT LIVES HERE. get_csv_files answers `{files, errors, notices}`. The
* `notices` are the encoding conversions (DATA-09: "this file is not UTF-8, it
* was read as windows-1252 and converted") — and the file list, the column map
* and the sample values the operator maps their columns from are all read out of
* that converted text. Until now the panel never showed it: the notice existed
* only in the import report, i.e. AFTER the records were written. An operator
* who is told what was done to the file BEFORE mapping can stop and re-export it
* as UTF-8 instead of discovering the conversion in the report.
*
* IN FLOW, NOT ui.show_message: `.wrapper_tool` sets `contain: content`, which
* makes it the containing block for absolutely positioned children AND clips
* them — and `.component_message` is `position:absolute; top:-3em`. A banner
* there is a surface that renders nowhere. This inserts ordinary text at the top
* of the tool body, the same shape (and the same classes) the report panel gives
* a notice — never the red error container, which is the error channel's.
*
* The READ ERRORS (T1-S18) ride the same place in the error channel's own shape:
* a staged file the server refused to read (too large, not text, damaged) is
* absent from the file list, so without this line it simply vanished from the
* panel and the operator could not tell why their upload "disappeared".
*
* @param {Object} [options={}] - Render options forwarded to tool_common.prototype.render
* @returns {Promise<HTMLElement>} The node the shared render returned, unchanged
*/
tool_import_dedalo_csv.prototype.render = async function(options={}) {

	const self = this

	const result = await tool_common.prototype.render.call(self, options)

	// container. A full render answers the tool wrapper (with a content_data
	// pointer); a content-level refresh answers the content_data node itself.
		const container = (result && result.content_data) ? result.content_data : result
		if (!container || typeof container.insertBefore!=='function') {
			return result
		}

	// notices + read errors (exported below so the DOM outcome is testable)
		render_csv_files_messages(self, container)


	return result
}//end render



/**
* RENDER_CSV_FILES_MESSAGES
* Paints get_csv_files' two per-file channels at the top of `container`, notices
* first: `self.csv_files_notices` (what the engine DID to a file to read it — the
* notice shape, never red) and `self.csv_files_errors` (the files it could NOT
* read — the error channel's shape, the one the report panel uses). Idempotent: a
* content-level refresh re-enters with the same node, so the previous lines are
* removed first.
*
* @param {Object} self - The tool instance (reads csv_files_notices / csv_files_errors)
* @param {HTMLElement} container - The tool body
* @returns {void}
*/
export const render_csv_files_messages = function(self, container) {

	// clean previous lines
		const previous = container.querySelectorAll(':scope > .notice_msg, :scope > .csv_files_errors')
		for (let i = previous.length - 1; i >= 0; i--) {
			previous[i].remove()
		}

	// errors. One line per staged file the server refused to read. Inserted first
	// so the notices, inserted after it at the top, read above it.
		const errors = self.csv_files_errors
		if (Array.isArray(errors) && errors.length>0) {
			const errors_container = ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'dedalo_last_error_container csv_files_errors'
			})
			ui.create_dom_element({
				element_type	: 'pre',
				class_name		: 'error_pre',
				text_content	: errors.join('\n'),
				parent			: errors_container
			})
			container.insertBefore(errors_container, container.firstChild)
		}

	// notices. One line per staged file the engine had to convert, at the TOP of
	// the panel: it is a fact about the files listed below it, so it is read
	// before they are mapped, not after the import.
		const notices = self.csv_files_notices
		if (Array.isArray(notices) && notices.length>0) {
			const notices_container = ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'user_msg_container notice_msg'
			})
			const notices_length = notices.length
			for (let i = 0; i < notices_length; i++) {
				ui.create_dom_element({
					element_type	: 'div',
					class_name		: 'text',
					text_content	: notices[i],
					parent			: notices_container
				})
			}
			container.insertBefore(notices_container, container.firstChild)
		}
}//end render_csv_files_messages



/**
* LOAD_CSV_FILES_LIST
* Fetches the list of CSV files currently staged in the per-user upload directory
* on the server. The directory path is resolved server-side from the constant
* DEDALO_TOOL_IMPORT_DEDALO_CSV_FOLDER_PATH (typically DEDALO_MEDIA_PATH/import/files/<user_id>/).
*
* The response is an array of file-descriptor objects. Each descriptor has at
* minimum: { name, dir, n_records, n_columns, file_info, sample_data,
* sample_data_errors, ar_columns_map }. The render module augments each object
* with UI state properties (checked, section_tipo, bulk_process_label, etc.).
*
* The 'options' body is intentionally left empty so the server falls back to the
* default configured path; a custom 'dir' could be passed here if needed.
*
* (!) SHOW_DEVELOPER is used for debug logging but is not declared in the file's
* global directive — see flags.
*
* @returns {Promise<Array>} Resolves with the array of file-descriptor objects
*   returned by server-side tool_import_dedalo_csv::get_csv_files()
*/
tool_import_dedalo_csv.prototype.load_csv_files_list = async function() {

	const self = this

	// source. Note that second argument is the name of the function to manage the tool request like 'apply_value'
	// this generates a call as my_tool_name::my_function_name(options)
		const source = create_source(self, 'get_csv_files')

	// rqo
		const rqo = {
			dd_api	: 'dd_tools_api',
			action	: 'tool_request',
			source	: source,
			options : {
				// dir : use default as fallback (DEDALO_TOOL_IMPORT_DEDALO_CSV_FOLDER_PATH)
			}
		}

	// call to the API, fetch data and get response
		return new Promise(function(resolve){

			data_manager.request({
				use_worker	: true,
				body		: rqo
			})
			.then(function(response){
				if(SHOW_DEVELOPER===true) {
					dd_console("-> load_csv_files_list API response:",'DEBUG',response);
				}

				// envelope v2 payload:
				// `{files:[…], errors:[per-file read problems], notices:[what we DID to a file]}`.
				// The caller wants the LIST — an unreadable CSV is reported per file
				// and must not hide the ones that did parse.
				const files_data	= response_data(response)
				// ERRORS — kept for render() to show the operator (T1-S18). A file the
				// server could not read (too large, not text, damaged) is NOT in
				// `files`, so a console line was its only trace: it vanished from the
				// panel with no reason given.
				const file_errors	= files_data?.errors
				self.csv_files_errors = Array.isArray(file_errors) ? file_errors : []

				// NOTICES — kept for render() to show the operator. This is the
				// MAPPER PREVIEW's own channel: the columns and sample values below
				// are what the engine read AFTER converting a file that was not UTF-8
				// (DATA-09), and the operator maps their columns from exactly that.
				// Dropping it here (the previous behaviour: notices were not even
				// read) left that conversion with no operator surface at all — it
				// reached the panel only later, in the import report, after the
				// records were written.
				// A notice is NEVER merged into `errors`: the panel paints errors red
				// and an intended, successful conversion is not a failure.
				const file_notices	= files_data?.notices
				self.csv_files_notices = Array.isArray(file_notices) ? file_notices : []

				resolve(Array.isArray(files_data?.files) ? files_data.files : [])
			})
		})
}//end load_csv_files_list



/**
* REMOVE_FILE
* Deletes a staged CSV file from the server's per-user upload directory and
* clears any persisted import-process state for this tool from the local IndexedDB.
*
* Clearing local DB state (process_import_dedalo_csv / status) is important because
* check_process_data() in the render module reads that key on every full render to
* resume a live import. If stale state were left behind after a file delete, the next
* render could try to reconnect to a process that no longer exists.
*
* The server-side handler (tool_import_dedalo_csv::delete_csv_file) validates the
* resolved path against the user's staging directory before deleting, so callers do
* not need to sanitise item.name themselves.
*
* @param {Object} item - File-descriptor object from csv_files_list; must have a
*   {string} item.name property matching the file's basename on disk
* @returns {Promise<*>} Resolves with the response PAYLOAD (`{deleted:<file_name>}`)
*/
tool_import_dedalo_csv.prototype.remove_file = function(item) {

	const self = this

	// remove of local database the process connection
	// Wipe any pending-process state so that check_process_data() does not try to
	// resume a non-existent import after the file has been deleted.
		data_manager.delete_local_db_data(
			'process_import_dedalo_csv', // like 'make_backup_process'
			'status' // string table
		)

	// forget the remembered section_tipo of the deleted file
		self.save_section_tipo_correction(item.name, null, null)

	// source. Note that second argument is the name of the function to manage the tool request like 'apply_value'
	// this generates a call as my_tool_name::my_function_name(options)
		const source = create_source(self, 'delete_csv_file')

	// rqo
		const rqo = {
			dd_api	: 'dd_tools_api',
			action	: 'tool_request',
			source	: source,
			options	: {
				file_name : item.name
			}
		}

	// call to the API, fetch data and get response
		return new Promise(function(resolve){

			data_manager.request({
				body : rqo
			})
			.then(function(response){
				if(SHOW_DEVELOPER===true) {
					dd_console("-> remove_file API response:",'DEBUG',response);
				}

				// envelope v2 payload: `{deleted:<file_name>}`
				resolve(response_data(response))
			})
		})
}//end remove_file



/**
* LOAD_SECTION_TIPO_CORRECTIONS
* Reads the user's remembered section_tipo corrections from the browser local DB.
* Never throws: an unavailable/blocked IndexedDB just means nothing is remembered.
* @returns {Promise<Object>} {file_name: section_tipo}
*/
tool_import_dedalo_csv.prototype.load_section_tipo_corrections = async function() {

	try {
		const response = await data_manager.get_local_db_data(
			SECTION_TIPO_CORRECTIONS_ID,
			'data'
		)
		const value = response && response.value
		return (value && typeof value==='object' && !Array.isArray(value))
			? value
			: {}
	} catch (error) {
		console.warn('[load_section_tipo_corrections] local DB unavailable:', error)
		return {}
	}
}//end load_section_tipo_corrections



/**
* SAVE_SECTION_TIPO_CORRECTION
* Remembers (or forgets) the section_tipo the user set for a file name.
* A value equal to the file-name guess, or null, removes the entry
* (see apply_section_tipo_correction). Skips the write when nothing changed.
* @param {string} file_name
* @param {string|null} section_tipo
* @param {string|null} detected_section_tipo - guess from the file name
* @returns {Promise<boolean>} true when the store changed
*/
tool_import_dedalo_csv.prototype.save_section_tipo_correction = async function(file_name, section_tipo, detected_section_tipo) {

	const self = this

	const current	= self.section_tipo_corrections || {}
	const next		= apply_section_tipo_correction(current, file_name, section_tipo, detected_section_tipo)
	if (current[file_name]===next[file_name]) {
		return false
	}
	self.section_tipo_corrections = next

	try {
		await data_manager.set_local_db_data(
			{
				id		: SECTION_TIPO_CORRECTIONS_ID,
				value	: next
			},
			'data'
		)
	} catch (error) {
		console.warn('[save_section_tipo_correction] local DB unavailable:', error)
	}

	return true
}//end save_section_tipo_correction



/**
* IMPORT_FILES
* Dispatches the bulk-import request to the server and resolves with the full API
* response (including pid and pfile) so the caller can open an SSE progress stream.
*
* background_running:true instructs the server (process_runner.php) to fork the import
* as a background process and return the PID immediately. The actual import can take
* many minutes for large datasets; the 3600-second timeout and retries:1 prevent the
* worker from giving up while still sending exactly one request.
*
* Each element of 'files' is a plain object assembled by the render module:
* {
*   file              : {string}  basename of the staged CSV file
*   section_tipo      : {string}  target section tipo (e.g. 'oh1')
*   ar_columns_map    : {Array}   column-to-component mapping built by the column mapper UI;
*                                 each entry: { tipo, model, label, checked, map_to [, decimal] [, import_mode] }
*                                 import_mode: 'replace' | 'append' (absent = 'replace'); set only
*                                 on columns whose target component has an import_append policy
*   bulk_process_label: {string}  human-readable name for the bulk-process record (dd800)
* }
*
* @param {Array}   files             - Array of file-descriptor objects (see above)
* No time-machine switch is sent: the import runs under a bulk id, and every
* save carrying one writes its undo pair (hidden BEFORE row + visible after-row),
* so the whole run can be reverted exactly from the Time Machine tool
* (WC-2026-09-27-bulk-revert-undo-log, decision D1).
* @returns {Promise<Object>} Resolves with the full API response object; on success
*   response.result===true and response.pid/response.pfile identify the background process
*/
tool_import_dedalo_csv.prototype.import_files = function(files) {

	const self = this

	// source. Note that second argument is the name of the function to manage the tool request like 'apply_value'
	// this generates a call as my_tool_name::my_function_name(options)
		const source = create_source(self, 'import_files')

	// rqo
		const rqo = {
			dd_api	: 'dd_tools_api',
			action	: 'tool_request',
			source	: source,
			options	: {
				background_running	: true,
				files				: files
			}
		}

	// call to the API, fetch data and get response
		return new Promise(function(resolve){

			data_manager.request({
				use_worker	: true,
				body		: rqo,
				retries : 1, // one try only
				timeout : 3600 * 1000 // 3600 secs waiting response
			})
			.then(function(response){
				if(SHOW_DEVELOPER===true) {
					dd_console("-> import_files API response:",'DEBUG',response);
				}

				resolve(response)
			})
		})
}//end import_files



/**
* GET_BACKGROUND_JOBS
* The caller's background jobs for THIS tool, newest first (framework action
* 'get_background_jobs', served by the tool dispatcher for every tool).
*
* This is how the tool re-attaches to an import after a page reload: the job runs
* inside the server process and its registry already records the tool, the action
* and the owner — so the client asks, and keeps no state of its own. (It used to
* park the job_id in IndexedDB, which was per-browser, went stale across a server
* restart, and duplicated a fact the server owns.)
*
* @param {string} [action] - narrow to one action, e.g. 'import_files'
* @returns {Promise<Object>} api_response; `result` is
*   [{id, tool, action, status, error, started_at}] (newest first)
*/
tool_import_dedalo_csv.prototype.get_background_jobs = function(action) {

	const self = this

	const rqo = {
		dd_api	: 'dd_tools_api',
		action	: 'tool_request',
		source	: create_source(self, 'get_background_jobs'),
		options	: {
			action : action
		}
	}

	return new Promise(function(resolve){

		data_manager.request({
			use_worker	: true,
			body		: rqo
		})
		.then(function(response){
			if(SHOW_DEVELOPER===true) {
				dd_console("-> get_background_jobs API response:",'DEBUG',response);
			}
			resolve(response)
		})
	})
}//end get_background_jobs



/**
* GET_SECTION_COMPONENTS_LIST
* Retrieves the list of importable components for a given section tipo and caches
* the result on this instance so repeated calls for the same section_tipo skip the
* network round-trip (important because the column mapper calls this on every
* section_tipo change triggered by the user).
*
* On success, response.result is an array of component-descriptor objects:
*   { value: 'oh25', label: 'Title', model: 'component_input_text', import_append: 'items' }
* import_append is the component's append policy ('items' | 'geo_layer' |
* 'text_paragraphs'), or null when the server refuses append for that model.
*
* On failure (unknown tipo, etc.), response.result is falsy and response.msg carries
* the human-readable error. In that case this method resolves with
*   { list: false, label: false, msg: '...' }
* so callers can display the error without throwing.
*
* The on-instance cache (self.resolved_section_components_list) is a plain object
* keyed by section_tipo. It is not cleared between renders; if the section's schema
* changes while the tool is open, the user must close and reopen the tool.
*
* (!) The cache check returns the cached value directly (not wrapped in a new Promise).
* Callers that use .then() on the return value must handle both a plain-object fast-
* path and a Promise — which works because .then() on a non-thenable is simply
* ignored by await/Promise.resolve.
*
* @param {string} section_tipo - The ontology tipo of the target section (e.g. 'oh1')
* @returns {Promise<Object>|Object} Resolves with { list: Array|false, label: string|false, msg: string }
*/
tool_import_dedalo_csv.prototype.get_section_components_list = function(section_tipo) {

	const self = this

	// cache results
	// Lazily initialise the cache object; return immediately on a cache hit to
	// avoid a redundant network request when the user edits the same section_tipo field.
		self.resolved_section_components_list = self.resolved_section_components_list || {}
		if (self.resolved_section_components_list[section_tipo]) {
			return self.resolved_section_components_list[section_tipo]
		}

	// source. Note that second argument is the name of the function to manage the tool request like 'apply_value'
	// this generates a call as my_tool_name::my_function_name(options)
		const source = create_source(self, 'get_section_components_list')

	// rqo
		const rqo = {
			dd_api	: 'dd_tools_api',
			action	: 'tool_request',
			source	: source,
			options	: {
				section_tipo : section_tipo
			}
		}

	// call to the API, fetch data and get response
		return new Promise(function(resolve){

			data_manager.request({
				body		: rqo,
				use_worker	: true
			})
			.then(function(response){
				if(SHOW_DEVELOPER===true) {
					dd_console("-> get_section_components_list API response:",'DEBUG',response);
				}

				// envelope v2: the payload is `{components, label}`; a refusal carries
				// the coded error and no payload at all.
				const list_data = request_failed(response) ? null : response_data(response)
				if (!list_data || !Array.isArray(list_data.components)) {
					// error path: return a sentinel so callers can show the refusal
					// without having to catch a rejection
					resolve({
						list	: false,
						label	: false,
						error	: request_failed(response)
							? error_text(response.error)
							: (self.get_tool_label('no_components') || 'No components found for this section')
					})
					return
				}

				// cache result
				self.resolved_section_components_list[section_tipo] = {
					list	: list_data.components,
					label	: list_data.label,
					error	: null
				}

				resolve(self.resolved_section_components_list[section_tipo])
			})
		})
}//end get_section_components_list



/**
* PROCESS_UPLOADED_FILE
* Moves a freshly uploaded temporary CSV file from the service_upload staging area
* to the tool's definitive per-user directory (DEDALO_TOOL_IMPORT_DEDALO_CSV_FOLDER_PATH/<user_id>/)
* and parses its header row to populate the column-map metadata.
*
* This is called automatically by upload_done() (mixed in from render_tool_import_dedalo_csv)
* immediately after service_upload fires 'upload_file_done_<id>'. The file_data object
* is the raw descriptor returned by service_upload after a successful transfer:
* {
*   error     : {number} 0 = success (PHP UPLOAD_ERR_* codes)
*   extension : {string} e.g. "csv"
*   name      : {string} original filename, e.g. "exported_oral-history_-1-oh1.csv"
*   size      : {number} bytes
*   tmp_name  : {string} absolute server path to the uploaded temp file,
*                        e.g. "/hd/media/upload/service_upload/tmp/image/phpPJQvCp"
*   type      : {string} MIME type, e.g. "text/csv"
* }
*
* Note: the sample file_data shown in the original doc-block used a .tiff example —
* the actual files processed by this tool are always .csv. The shape of the descriptor
* is the same regardless of file type because it comes from the generic service_upload.
*
* On success the payload is `{file_name}` — the render layer refreshes the file
* list from it.
*
* @param {Object} file_data - Upload descriptor from service_upload (see above)
* @returns {Promise<Object>} Resolves with the full envelope; `response_data` holds
*   `{file_name}` on success, and a refusal carries the coded `error`
*/
tool_import_dedalo_csv.prototype.process_uploaded_file = function(file_data) {

	const self = this

	// source. Note that second argument is the name of the function to manage the tool request like 'apply_value'
	// this generates a call as my_tool_name::my_function_name(options)
		const source = create_source(self, 'process_uploaded_file')

	// rqo
		const rqo = {
			dd_api	: 'dd_tools_api',
			action	: 'tool_request',
			source	: source,
			options	: {
				file_data : file_data
			}
		}

	// call to the API, fetch data and get response
		return new Promise(function(resolve){

			data_manager.request({
				use_worker	: true,
				body		: rqo,
				retries : 1, // one try only
				timeout : 3600 * 1000 // 3600 secs waiting response
			})
			.then(function(response){
				if(SHOW_DEVELOPER===true) {
					dd_console("-> process_uploaded_file API response:",'DEBUG', response);
				}

				resolve(response)
			})
		})
}//end process_uploaded_file



// @license-end
