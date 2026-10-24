// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_label, page_globals, SHOW_DEBUG, DEDALO_CORE_URL, DEDALO_ROOT_WEB, console, document, window, alert, setTimeout, Option */
/*eslint no-undef: "error"*/



// imports
	import {ui} from '../../../core/common/js/ui.js'
	import {time_unit_auto, append_text_lines} from '../../../core/common/js/utils/index.js'
	import {data_manager} from '../../../core/common/js/data_manager.js'
	import {event_manager} from '../../../core/common/js/event_manager.js'
	import {request_failed, response_data} from '../../../core/common/js/api_error.js'
	import {handle_api_error} from '../../../core/common/js/error_dispatch.js'
	import {error_text} from '../../../core/common/js/render_api_error.js'
	import {render_stream} from '../../../core/common/js/render_common.js'
	import {dd_request_idle_callback} from '../../../core/common/js/events.js'



/**
* RENDER_TOOL_IMPORT_FILES
* Client-side render module for the tool_import_files batch importer.
*
* This module provides the 'edit' render layer (no read/list modes exist for this
* tool) and a set of exported helpers that build the GLOBAL option controls shown
* above the upload queue (the per-file selects themselves are emitted by
* `render_edit_service_upload_queue.js`, one pair per `.file-row`).
*
* Architectural overview:
*  - `render_tool_import_files` is a constructor/namespace whose prototype.edit is
*    mixed into `tool_import_files` (see tool_import_files.js).
*  - The edit UI is composed of:
*      1. An options_container (processor selector, target-field selector, quality
*         selector, matching options, configuration options).
*      2. A template_container that renders the upload QUEUE widget — its own
*         drop target plus one `.file-row` per file — via `self.service_upload`,
*         using dd_request_idle_callback for deferred load.
*      3. An inputs_container that renders `input_component` ddo_map entries via
*         `self.service_tmp_section` (a temporary section with live edit widgets).
*      4. A response_message area that streams SSE progress from the PHP background
*         process via `update_process_status`.
*      5. A bottom "IMPORT" button that collects per-file choices + component data
*         before dispatching `self.import_files(...)` to the API.
*
* Import modes (driven by tool_config.import_mode):
*  - 'default'           — file goes into the portal that triggered the tool.
*  - 'section'           — a new child section is created per file.
*  - 'section_resource'  — file goes directly into a resource section (e.g. Images).
*
* File-naming strategies written into tool_config.import_file_name_mode before
* the API call:
*  - null          — fresh section for each file.
*  - 'enumerate'   — numeric prefix of filename encodes section_id.
*  - 'named'       — basename groups files (multi-file records).
*  - 'match'       — numeric prefix matches an existing section; replaces media.
*  - 'match_freename' — full filename matched against stored filenames.
*
* Exported symbols (the global option selectors above the queue):
*  - render_file_processor_selector
*  - render_target_field_selector
*  - render_quality_selector
*  - render_matching_options
*  - render_configuration_options
*
* FIXED 2026-09-04 (P2-25 / DEAD-07). This note used to read "`event_manager` is
* accessed as a browser global (window.event_manager) … tools run in iframes and
* reach the singleton via the parent window. Do not add an import here". The
* reason was wrong, so the instruction was too: a BARE `event_manager` resolves
* against the module's OWN realm's window, never the parent's — code that really
* needs the parent bus must say `parent.window.event_manager`, as
* render_list_section.js does. All this file was doing was reading a global that
* event_manager.js happens to publish as a side effect, i.e. depending on another
* module's load order. It imports the singleton now, which in every realm is the
* same object the global names.
*/
export const render_tool_import_files = function() {

	return true
}//end render_tool_import_files



/**
* EDIT
* Builds and returns the full edit-mode DOM wrapper for the import-files tool.
*
* When render_level === 'content', skips wrapper construction and returns only the
* inner content_data node (used by the tool_common render pipeline for partial
* refreshes).  Otherwise returns a fully built ui.tool wrapper with content_data
* attached as a property.
*
* Side effects: builds service_upload and service_tmp_section inside idle
* callbacks; subscribes event_manager listeners stored in self.events_tokens.
*
* @param {Object} options
* @param {string} [options.render_level='full'] - 'full' | 'content'
* @returns {Promise<HTMLElement>} wrapper (full) or content_data (content)
*/
render_tool_import_files.prototype.edit = async function(options) {

	const self = this

	// options
		const render_level = options.render_level || 'full'

	// content_data
		const content_data = await get_content_data_edit(self)
		if (render_level==='content') {
			return content_data
		}

	// wrapper. ui build_edit returns component wrapper
		const wrapper = ui.tool.build_wrapper_edit(self, {
			content_data : content_data
		})
		wrapper.content_data = content_data


	return wrapper
}//end render_tool_import_files



/**
* GET_CONTENT_DATA_EDIT
* Constructs the content_data node containing all interactive sections of the
* import UI: options, template rows, input components, progress
* message area, and the import button.
*
* DOM structure produced:
*   .content_data
*     .options_container      — global options in three blocks:
*                               .source_options (processor, target field,
*                               quality, stacked), .tool_name_match_options,
*                               .tool_configuration_options
*     .template_container     — the upload queue widget (populated by service_upload)
*     .inputs_container       — "Values" section with service_tmp_section widgets
*     .response_message       — SSE progress output area
*     .buttons_bottom_container
*       button.button_process_import
*
* The `lock_items` array collects nodes that receive the CSS 'loading' class while
* a background import process is running.  They are unlocked by `on_done` inside
* `update_process_status`.
*
* On mount, `check_process_data` queries IndexedDB (via data_manager.get_local_db_data)
* to resume display of an in-flight process started in a previous page load.
*
* @param {Object} self - tool_import_files instance
* @returns {Promise<HTMLElement>} content_data node
*/
const get_content_data_edit = async function(self) {

	// content_data
		const content_data = ui.tool.build_content_data(self)

	// short vars
		const ar_file_processor	= self.tool_config.file_processor || null
		// local_db_id keys an IndexedDB record used to persist and resume process status
		const local_db_id		= 'process_import_files_' + self.section_tipo
		const lock_items		= []

	// options_container
		const options_container = render_options_container(self, content_data)
		lock_items.push(options_container)
		content_data.appendChild(options_container)

	// template_container
		const template_container = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'template_container',
			parent			: content_data
		})
		// set pointer
		content_data.template_container = template_container
		lock_items.push(template_container)

		// Deferred via idle callback so the browser can paint the skeleton UI first.
		dd_request_idle_callback(
			() => {
				ui.load_item_with_spinner({
					container			: template_container,
					preserve_content	: true,
					label				: 'Drop zone',
					callback			: async () => {
						await self.service_upload.build()
						return await self.service_upload.render()
					}
				})
			}
		);

	// inputs components container label
		const inputs_container = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'inputs_container',
			parent			: content_data
		})
		lock_items.push(inputs_container)

		// inputs_container_caption (Values)
		ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'inputs_container_caption',
			inner_html		: get_label.values || 'Values',
			parent			: inputs_container
		})

		// service_tmp_section
		// Renders any ddo_map entries with role 'input_component' as live edit widgets.
		// Deferred to avoid blocking the initial paint.
		dd_request_idle_callback(
			() => {
				ui.load_item_with_spinner({
					container			: inputs_container,
					preserve_content	: true,
					label				: 'Input components',
					callback			: async () => {
						await self.service_tmp_section.build()
						return await self.service_tmp_section.render();
					}
				})
			}
		);

	// response_message
		const response_message = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'response_message',
			parent			: content_data
		})

	// buttons_bottom_container
		const buttons_bottom_container = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'buttons_bottom_container success',
			parent			: content_data
		})
		lock_items.push(buttons_bottom_container)

	// button process import
		const button_process_import = ui.create_dom_element({
			element_type	: 'button',
			class_name		: 'button_process_import success loading', // create with loading class
			inner_html		: get_label.import || 'IMPORT',
			parent			: buttons_bottom_container
		})
		// click event
		// On click: validate files, collect per-file options and component values,
		// resolve the final import_file_name_mode, then dispatch the API request.
		const button_process_import_click_handler = async (e) => {
			e.stopPropagation()

			if(self.files_data.length < 1){
				return
			}

			// add loading class to wrapper to block all actions for the user
			self.node.classList.add('loading')

			// get the options from the every file uploaded
			// Iterates in reverse so splices (if any) don't shift unprocessed indices.
			for (let i = self.files_data.length - 1; i >= 0; i--) {
				const current_value = self.files_data[i]
				// Read the per-file processor choice from the queue's `.file-row`.
				if(ar_file_processor){
					self.files_data[i].file_processor = current_value.previewElement.querySelector(".file_processor_select").value === 'null'
					? null
					: current_value.previewElement.querySelector(".file_processor_select").value
				}
				// Read the per-file target component (portal) choice.
				self.files_data[i].component_option = current_value.previewElement.querySelector(".option_component_select").value;
			}
			// get the data from every component used to propagate to every file uploaded
			const components_temp_data = self.service_tmp_section.get_components_data()

			// get the global configuration (to apply in the server)
			// Determine which naming strategy checkbox the user activated.
			// Priority (highest wins): match_freename > match > enumerate > named > null.
			const is_section_or_section_resource_mode = ['section', 'section_resource'].includes(self.tool_config.import_mode);
			self.tool_config.import_file_name_mode = ( is_section_or_section_resource_mode && options_container.control_section_id_check_box.checked)
				? 'enumerate'
				: (is_section_or_section_resource_mode && options_container.same_name_check_box.checked)
					? 'named'
					: null

			// match is active
			// when match is active all previous set will be overwrite.
			// !! This mode is incompatible with other options
			self.tool_config.import_file_name_mode = !options_container.name_with_id_match_check_box.checked
				? self.tool_config.import_file_name_mode
				: 'match'

			self.tool_config.import_file_name_mode = !options_container.free_name_match_check_box.checked
				? self.tool_config.import_file_name_mode
				: 'match_freename'

			// API request
				const api_response = await self.import_files({
					components_temp_data : components_temp_data
				})
				self.node.classList.remove('loading')

				// error case
				// ONE error model: the failure is an ApiError on the envelope, the
				// dispatcher chooses the surface and the renderer emits TEXT. Never
				// alert() a server string — it is untrusted and unlocalised.
				if (request_failed(api_response)) {
					console.error('import_files failed:', api_response.error)
					await handle_api_error(api_response.error, {wrapper: response_message})
					return
				}

			// update_process_status
			// The API returns a pid + pfile for the background CLI process.
			// We immediately start streaming its status.
				update_process_status({
					pid			: api_response.pid,
					pfile		: api_response.pfile,
					local_db_id	: local_db_id,
					container	: response_message,
					lock_items	: lock_items,
					self		: self
				})
		}
		button_process_import.addEventListener('click', button_process_import_click_handler)

		// THE IMPORT UNLOCK, IN TWO HALVES.
		// The button starts in 'loading' (disabled-looking) state and must unlock as
		// soon as there is at least one IMPORTABLE file — that is, one whose bytes
		// are already on the server. A file arrives in that state by exactly two
		// routes, and each has its own event.
		//
		// (!) STATUS, NOT `url`. The previous test was `data.file.url` truthiness.
		// That silently depended on Dropzone's `displayExistingFile` path and does
		// NOT hold for the queue: the upload response's `file_data` carries
		// `key_dir / tmp_name / extension / thumbnail_url` but NO `url`
		// (upload_queue.js only copies one `if (file_data.url)`), so a freshly
		// uploaded `done` entry has `url === null` and would never unlock IMPORT.
		// Only restored `staged` rows are guaranteed a url. The queue's status
		// machine is the honest signal, so both handlers read it.

		// drop_zone_success. Published by render_edit_service_upload_queue's
		// `on_change` callback, and ONLY when `entry.status === 'done'`:
		//    event_manager.publish('drop_zone_success', {file: entry, api_response: {…}})
		// i.e. a fresh upload just finished.
		const drop_zone_success_handler = (data) => {
			if (data && data.file && data.file.status==='done') {
				button_process_import.classList.remove('loading')
			}
		}
		self.events_tokens.push(
			event_manager.subscribe('drop_zone_success', drop_zone_success_handler)
		)

		// drop_zone_addedfile. Published by the queue's `on_add` callback for EVERY
		// row, local or restored:
		//    event_manager.publish('drop_zone_addedfile', {file: entry})
		// Files restored from the server (list_uploaded_files → `add_staged`) enter
		// with status 'staged' — they are ALREADY on disk and must unlock IMPORT
		// exactly like a fresh upload does. A locally-added file ('pending') must
		// NOT unlock it, and a staged descriptor that arrived without a url is
		// admitted as 'error', which correctly unlocks nothing either.
		const drop_zone_addedfile_handler = (data) => {
			if (data && data.file && data.file.status==='staged') {
				button_process_import.classList.remove('loading')
			}
		}
		self.events_tokens.push(
			event_manager.subscribe('drop_zone_addedfile', drop_zone_addedfile_handler)
		)

		// on reload page, if files_data exists, activate button
		// files_data is persisted in-memory across soft reloads (same JS context).
		// NOTE: this synchronous check alone is not enough after a HARD reload —
		// the upload queue (and with it the server-side file restore) is built inside
		// a deferred idle callback, so files_data is still empty here and the restored
		// rows arrive later. The drop_zone_addedfile subscription above is what
		// actually unlocks the button in that case; this stays for the soft-reload
		// path, where the in-memory registry survives.
		if(self.files_data.length > 0){
			button_process_import.classList.remove('loading')
		}

	// check process status always
	// On mount, look in IndexedDB for a pid/pfile from a previously started import.
	// If found, resume the SSE stream so the user sees live progress even after a
	// page reload.
		const check_process_data = () => {
			data_manager.get_local_db_data(
				local_db_id,
				'status'
			)
			.then(function(local_data){
				if (local_data && local_data.value) {
					update_process_status({
						pid			: local_data.value.pid,
						pfile		: local_data.value.pfile,
						local_db_id	: local_db_id,
						container	: response_message,
						lock_items	: lock_items,
						self		: self
					})
				}
			})
		}
		check_process_data()


	return content_data
}//end get_content_data_edit



/**
* RENDER_OPTIONS_CONTAINER
* Builds the global options panel placed above the drop zone.
*
* The panel is assembled from sub-renderers and the resulting nodes are attached
* as named properties of the returned options_container element so that event
* handlers in get_content_data_edit can reach them by reference without DOM
* queries:
*
*   options_container.processor               — file-processor selector (optional)
*   options_container.target_component        — target-field selector
*   options_container.select_options          — the <select> inside target_component
*   options_container.select_quality          — quality <select> (optional)
*   options_container.name_with_id_match_check_box — matching-ID checkbox
*   options_container.free_name_match_check_box    — matching-name checkbox
*   options_container.control_field_check_box      — "suffix indicates field" checkbox
*   options_container.control_section_id_check_box — "prefix indicates id" checkbox
*   options_container.same_name_check_box          — "same name same record" checkbox
*
* The `option_components` array defaults to a synthetic single-item list built
* from the caller's tipo/label if no ddo_map entry with role 'component_option'
* is configured.
*
* @param {Object} self - tool_import_files instance
* @param {HTMLElement} content_data - parent content node (needed by sub-renderers
*   that must access template_container to toggle CSS classes)
* @returns {HTMLElement} options_container
*/
const render_options_container = function (self, content_data) {

	// component options to store the file, normally the component_portal,
	// it could be defined in the preferences or it could be the caller
	const ddo_option_components = self.tool_config.ddo_map.filter(el => el.role === 'component_option')
	const option_components = (ddo_option_components.length > 0)
		? ddo_option_components
		: [{
			role				: 'component_option',
			tipo				: self.caller.tipo,
			map_name			: null,
			label				: self.caller.label,
			section_id			: 'self',
			section_tipo		: self.caller.tipo,
			target_section_tipo	: self.tool_config.ddo_map.find(el => el.role === 'target_component').section_tipo
		  }]

	// options_container
	const options_container = ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'options_container'
	})

	// source options
	// The three selectors are ONE block (column 1 of the panel): what the file
	// goes into. They are stacked, not spread as three sibling columns.
	const source_options_container = ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'source_options',
		parent			: options_container
	})

	// processor
	// file processor options of the files, it could be defined in the preferences or could be the caller
	const file_processor_options = self.tool_config?.file_processor;
	if(file_processor_options){
		const processor_selector_container = render_file_processor_selector(self, options_container, file_processor_options, content_data);
		source_options_container.appendChild(processor_selector_container)
		// set pointer
		options_container.processor = processor_selector_container
	}

	// target field
	const target_field_selector_container = render_target_field_selector(self, options_container, option_components, content_data);
	source_options_container.appendChild(target_field_selector_container)
	// set pointer
	options_container.target_component = target_field_selector_container

	// quality
	// Define the quality target to upload the files
	// Only rendered when the target component context declares supported quality levels.
	const features = self.target_component_context.features || null
	if(features){

		const ar_quality				= features.ar_quality || ['original']
		const default_target_quality	= features.default_target_quality || 'original'
		self.custom_target_quality		= default_target_quality || null

		const quality_selector_container = render_quality_selector(self, options_container, ar_quality, default_target_quality)
		source_options_container.appendChild(quality_selector_container)
	}//end if(features)

	// matching options
	// name_match previous uploaded images.
	// Note that this options are rendered always but are only displayed for 'section' and 'section_resource' import modes
	const matching_options_container = render_matching_options(self, options_container, content_data)
	options_container.appendChild(matching_options_container)

	// configuration options
	// Includes check-boxes for name, section_id, same name
	const tool_configuration_options_container = render_configuration_options(self, options_container, content_data, option_components)
	options_container.appendChild(tool_configuration_options_container)


	return options_container
}//end render_options_container



/**
* UPDATE_PROCESS_STATUS
* Opens an SSE stream to the dd_utils_api get_process_status action and renders
* live progress into the response_message container.
*
* Steps:
*  1. Locks all lock_items with the 'loading' CSS class so the user cannot
*     interact with the form while an import runs.
*  2. Clears the response_message container.
*  3. Opens the SSE stream via data_manager.request_stream.
*  4. Calls render_stream (from render_common.js) to create the base progress
*     nodes and obtain the update_info_node / done callbacks.
*  5. For each SSE chunk (on_read), computes a compound message showing:
*       msg | counter of total | elapsed time | estimated remaining time
*     The remaining-time estimate is based on a rolling average of the last
*     100 per-record processing times (data.current_time samples).
*  6. When the stream closes (on_done), unlocks the UI, resets the upload queue's
*     file list, and re-adds 'loading' to the import button.
*
* @param {Object} options
* @param {number|string} options.pid        - OS process ID of the background import
* @param {string}        options.pfile      - path to the process status file
* @param {string}        options.local_db_id - IndexedDB key for resuming after reload
* @param {HTMLElement}   options.container  - node where progress is rendered
* @param {Array<HTMLElement>} options.lock_items - nodes to lock during processing
* @param {Object}        options.self       - tool_import_files instance
* @returns {void}
*/
const update_process_status = (options) => {

	const pid			= options.pid
	const pfile			= options.pfile
	const local_db_id	= options.local_db_id
	const container		= options.container
	const lock_items	= options.lock_items
	const self			= options.self

	// locks lock_items
	lock_items.forEach(el =>{
		el.classList.add('loading')
	})

	// blur button
	document.activeElement.blur()

	// clean container
	while (container.firstChild) {
		container.removeChild(container.firstChild);
	}

	// get_process_status from API and returns a SEE stream
	data_manager.request_stream({
		body : {
			dd_api		: 'dd_utils_api',
			action		: 'get_process_status',
			update_rate	: 1000, // int milliseconds
			options		: {
				pid		: pid,
				pfile	: pfile
			}
		}
	})
	.then(function(stream){

		// The final report is rendered ONCE. `on_read` fires per chunk and a
		// terminal frame can be read more than once (a re-poll, a reconnect), which
		// would otherwise append a second copy of the summary and the error list.
		let final_report_rendered = false

		// render base nodes and set functions to manage
		// the stream reader events
		const render_response = render_stream({
			container	: container,
			id			: local_db_id,
			pid			: pid,
			pfile		: pfile
		})

		// average process time for record
		// Tracks the last 100 per-record durations (ms) to estimate remaining time.
			const ar_samples = []
			const get_average = (arr) => {
				let sum = 0;
				const arr_length = arr.length;
				for (let i = 0; i < arr_length; i++) {
					sum += arr[i];
				}
				return Math.ceil( sum / arr_length );
			}

		// on_read event (called on every chunk from stream reader)
		// sse_response shape: { is_running: bool, data: { msg, counter, total, total_ms, current_time, errors }, total_time }
		const on_read = (sse_response) => {

			// fire update_info_node on every reader read chunk
			render_response.update_info_node(sse_response, (info_node) => {

				// is_running defaults to true when absent (stream still open)
				const is_running = sse_response?.is_running ?? true

				// THE FINAL REPORT, at the end of the stream.
				//
				// (!) The last frame is NOT shaped like a progress frame. A progress
				// frame's `data` is the raw payload the handler published (msg /
				// counter / total / errors); the TERMINAL frame's `data` is the
				// handler's whole ENVELOPE — src/core/tools/background.ts:210 ("the
				// RETURN VALUE becomes the final SSE frame's data") through
				// src/core/media/jobs.ts:628 (`record.data = result`). So the report
				// sits one level deeper, and `response_data` is the ONE accessor that
				// reaches it (`data`, then the compat `result` mirror); a progress
				// frame has neither, so it falls back to itself and nothing changes.
				//
				// Import report keys (tools/tool_import_files/server/index.ts:1127-1133,
				// asserted in test/unit/tool_import_files.test.ts:258):
				//   summary  — the run sentence (envelope v2 has NO success `msg`)
				//   errors   — the per-file failures; the batch never aborts on one file
				//   imported — how many landed
				if (is_running===false && final_report_rendered===false) {

					final_report_rendered = true
					const report = response_data(sse_response.data) || sse_response.data || {}

					// run summary — a text node, never an HTML sink
					if (typeof report.summary==='string' && report.summary.length>0) {
						append_text_lines(
							ui.create_dom_element({
								element_type	: 'div',
								class_name		: 'container summary',
								parent			: container
							}),
							report.summary
						)
					}

					// per-file failures. Also the frame's OWN `errors`: when the handler
					// throws outright there is no report at all, and the job manager
					// records the exception there (src/core/media/jobs.ts:630).
					const report_failures	= report.errors
					const frame_failures	= sse_response.errors
					const report_errors		= [
						...(Array.isArray(report_failures) ? report_failures : []),
						...(Array.isArray(frame_failures) ? frame_failures : [])
					]
					if (report_errors.length>0) {
						// TEXT nodes + real <br> elements: a stream frame is server text
						// (paths, tool output) and must never be parsed as HTML.
						// A bare string prints as-is; a coded entry resolves through the
						// ONE renderer (label in the user's language, then message, then code).
						append_text_lines(
							ui.create_dom_element({
								element_type	: 'div',
								class_name		: 'container error',
								parent			: container
							}),
							report_errors.map(entry => typeof entry==='string' ? entry : error_text(entry))
						)
					}
				}

				// compound_msg builds a |-delimited progress summary string.
				// Falls back to generic text when the server message is too short
				// (< 6 chars) to be meaningful.
				const compound_msg = (sse_response) => {
					const data = sse_response.data
					const parts = []
					parts.push(data.msg)
					if (data.counter) {
						parts.push(data.counter +' '+ (get_label.of || 'of') +' '+ data.total)
					}
					if (data.total_ms) {
						parts.push( time_unit_auto(data.total_ms) )
					}else{
						parts.push(sse_response.total_time)
					}
					if (data.current_time) {
						// save in samples array to make average
						// Cap the rolling window at 100 samples; discard oldest first.
						if (ar_samples.length>100) {
							ar_samples.shift() // remove older element
						}
						ar_samples.push(data.current_time)

						const average			= get_average(ar_samples)
						const remaining_ms		= ((data.total - data.counter) * average)
						const remaining_time	= time_unit_auto(remaining_ms)
						parts.push('Time remaining: ' + remaining_time)
					}

					return parts.join(' | ')
				}

				const frame_line = sse_response && sse_response.data && sse_response.data.msg
				const msg = (typeof frame_line==='string' && frame_line.length>5)
					? compound_msg(sse_response)
					: is_running
						? 'Process running... please wait'
						: 'Process completed in ' + sse_response.total_time

				// Lazily create msg_node on first chunk; subsequent chunks update in-place.
				if(!info_node.msg_node) {
					info_node.msg_node = ui.create_dom_element({
						element_type	: 'div',
						class_name		: 'msg_node' + (is_running===false ? ' done' : ''),
						parent			: info_node
					})
				}
				// textContent: `msg` embeds the server's own `data.msg`
				info_node.msg_node.textContent = msg
			})
		}

		// on_done event (called once at finish or cancel the stream read)
		const on_done = () => {
			// is triggered at the reader's closing
			render_response.done()
			// unlock lock_items
			lock_items.forEach(el =>{
				el.classList.remove('loading')
			})

			// service_upload. Clean files list.
			// (!) `reset_queue`, not a reassignment of files_data: the queue owns
			// that exact array reference, so it must be EMPTIED, never replaced.
			self.service_upload.reset_queue();

			// de-activate button_process_import
			// Puts the button back into 'loading' (disabled) state until the user
			// drops new files. Selects by class because the node is not closed over
			// here — but SCOPED TO THIS TOOL'S OWN SUBTREE: `document.querySelector`
			// returns the FIRST match on the page, which is another tool's button
			// whenever two importers are open at once.
			const button_process_import = self.node
				? self.node.querySelector('.button_process_import')
				: null
			if (button_process_import) {
				button_process_import.classList.add('loading')
			}
		}

		// read stream. Creates ReadableStream that fire
		// 'on_read' function on each stream chunk at update_rate
		// (1 second default) until stream is done (PID is no longer running)
		data_manager.read_stream(stream, on_read, on_done)

		// scroll down page
		// Short delay ensures DOM has settled before scrolling.
		setTimeout(function(){
			// window.scrollTo(0, document.body.scrollHeight);
			window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' })
		}, 25)
	})
	.catch((error) => {
		// request_stream REJECTS on a network failure or a non-2xx response (it
		// used to leave the promise pending forever, which is why this handler did
		// not exist). Behaviour is unchanged — the stream simply does not start —
		// but the failure is reported rather than surfacing as an unhandled
		// rejection.
		console.error('[tool_import_files] could not open the status stream:', error)
	})
}//end update_process_status



/**
* SET_IMPORT_MODE
* Applies or resets the "suffix indicates field" naming convention on all
* currently queued files.
*
* When apply === true, the function parses each file's name against the pattern:
*   `<prefix>-<base>-<map_key>.<ext>`
* e.g. "123-interview-A.jpg" → map_key = "A"
*
* The map_key is matched (case-insensitively) against ddo_map entries whose
* role === 'component_option' and map_name === map_key.  If found, the
* corresponding <select.option_component_select> in the queue's `.file-row` is
* updated to that entry's tipo.
*
* When apply === false, each file's selector is reset to the configured default
* component_option (or the first available option if none is marked default).
*
* This function is called:
*  - On every 'drop_zone_addedfile' event (to auto-assign new files).
*  - When the "suffix indicates field" checkbox changes state.
*
* @param {Object} self - tool_import_files instance; provides files_data and tool_config
* @param {boolean} apply - true to parse-and-assign; false to reset to default
* @returns {boolean} always true
*/
const set_import_mode = function (self, apply) {

	const files_data		= self.files_data || []
	const files_data_length	= files_data.length
	for (let i = 0; i < files_data_length; i++) {

		const current_value = files_data[i]

		// current element selector options node
		const option_component_select = current_value.previewElement.querySelector('.option_component_select')

		if(apply===true){

			// Regex captures: [0]=full, [1]=prefix, [2]=base, [3]=map_key, [4]=ext
			const regex = /^(.*?)-(.*?)-?([a-zA-Z]{1,2})\.([a-zA-Z]{3,4})$/gm;
			// const name = current_value.name; //`123 85-456 fd-a.jpg`;
			const map_name = regex.exec(current_value.name)
			if ( map_name!==null && map_name[3]!==null ) {

				const map_name_upper = map_name[3].toUpperCase();
				const target_portal = self.tool_config.ddo_map.find(el => el.role==='component_option' && el.map_name.toUpperCase()===map_name_upper)
				if (target_portal && option_component_select) {
					option_component_select.value = target_portal.tipo
				}
			}
		}else{

			if (option_component_select) {
				const default_target_portal	= self.tool_config.ddo_map.find(el => el.role === 'component_option' && el.default === true)
				if(default_target_portal){
					option_component_select.value = default_target_portal.tipo
				}else{
					// note that option_component_select.options may not exists
					// Fallback: select the first available option when no default is configured.
					if (option_component_select.options[0]) {
						option_component_select.options[0].selected = true
					}
				}
			}
		}
	}


	return true
}//end set_import_mode



/**
* RENDER_FILE_PROCESSOR_SELECTOR
* Builds a labeled <select> that lets the operator choose a file processor
* function to apply to every queued file.
*
* The global selector's change handler propagates its value to all per-file
* <select.file_processor_select> nodes in the upload queue's `.file-row`s,
* keeping them in sync.
*
* The first option is always an empty/null sentinel; subsequent options are built
* from file_processor_options[].function_name.  Each function_name is also used
* as the i18n key via self.get_tool_label().
*
* The selected value per file is read back in the import button click handler via:
*   previewElement.querySelector('.file_processor_select').value
*
* @param {Object} self - tool_import_files instance
* @param {HTMLElement} options_container - parent container (stored as
*   options_container.processor after this call; not used inside this function)
* @param {Array<{function_name: string}>} file_processor_options - list of
*   processor descriptors from tool_config.file_processor
* @param {HTMLElement} [content_data] - THIS tool's content_data node; the search
*   root for the per-row selects. Omitted = the propagation is a no-op (it can
*   reach no row), which is the only safe degradation: a document-wide search
*   writes into every other importer open on the page.
* @returns {HTMLElement} processor_selector_container
*/
export const render_file_processor_selector = function (self, options_container, file_processor_options, content_data) {

	const processor_selector_container = ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'processor_selector_container'
	})

	// label
	const label = self.get_tool_label('file_processor') || 'Processor'
	ui.create_dom_element({
		element_type	: 'label',
		class_name		: 'processor label',
		text_content	: label + ': ',
		parent			: processor_selector_container
	})

	// select_process
	const select_process = ui.create_dom_element({
		element_type	: 'select',
		class_name		: 'component select',
		parent			: processor_selector_container
	})
	// change event handler
	// Propagates the global processor choice to every per-file selector in the queue.
	// (!) SCOPED TO THIS TOOL'S content_data, never `document`. The per-row selects
	// carry a bare class name that the upload queue emits for EVERY caller, so a
	// document-wide query rewrote the rows of every other import widget on the page
	// — silently, and with this tool's processor choice.
	const select_process_change_handler = () => {
		const file_processor_nodes = content_data
			? content_data.querySelectorAll('select.file_processor_select')
			: []
		const len = file_processor_nodes.length
		for (let i = len - 1; i >= 0; i--) {
			file_processor_nodes[i].value = select_process.value
		}
	}
	select_process.addEventListener('change', select_process_change_handler)

	// default option
	// Empty string value / null text acts as "no processor" sentinel.
	const default_option_node = new Option('', null, true, false);
	select_process.appendChild(default_option_node)

	// other options
	const file_processor_options_length = file_processor_options?.length
	for (let i = 0; i < file_processor_options_length; i++) {

		const option = file_processor_options[i]

		if (!option || !option.function_name) {
			console.warn(`Invalid option at index ${i}:`, option);
			continue;
		}

		const option_procesor_node = ui.create_dom_element({
			element_type	: 'option',
			class_name		: 'component select',
			inner_html		: self.get_tool_label(option.function_name),
			parent			: select_process
		})
		option_procesor_node.value = option.function_name
	}//end for (let i = 0; i < file_processor_options.length; i++)


	return processor_selector_container
}//end render_file_processor_selector



/**
* RENDER_TARGET_FIELD_SELECTOR
* Builds a labeled <select> for choosing which component_option portal receives
* each uploaded file.
*
* option_components is an array of ddo_map entries with role === 'component_option'.
* Each entry provides:
*   - tipo    {string}  — ontology tipo of the portal; used as <option> value.
*   - label   {string}  — human-readable name; used as <option> inner text.
*   - default {boolean} — when true the option is pre-selected.
*
* The global selector's change handler mirrors the chosen value to every
* per-file <select.option_component_select> in the upload queue's `.file-row`s.
*
* The chosen tipo is read back at import-click time via:
*   previewElement.querySelector('.option_component_select').value
*
* Side effect: stores the <select> node as options_container.select_options so
* other widgets (e.g. set_import_mode) can read or reset it.
*
* @param {Object} self - tool_import_files instance
* @param {HTMLElement} options_container - receives .select_options pointer
* @param {Array<{tipo: string, label: string, default?: boolean}>} option_components
* @param {HTMLElement} [content_data] - THIS tool's content_data node; the search
*   root for the per-row selects. Omitted = the propagation is a no-op (it can
*   reach no row), which is the only safe degradation: a document-wide search
*   writes into every other importer open on the page.
* @returns {HTMLElement} target_field_selector_container
*/
export const render_target_field_selector = function (self, options_container, option_components, content_data) {

	// target_component
	const target_field_selector_container = ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'target_component'
	})

	// label
	const target_component_label = self.get_tool_label('target_component') || 'Target field'
	ui.create_dom_element({
		element_type	: 'label',
		class_name		: 'target_component label',
		text_content	: target_component_label + ': ',
		parent			: target_field_selector_container
	})

	// select_options
	const select_options = ui.create_dom_element({
		element_type	: 'select',
		class_name		: 'component select',
		parent			: target_field_selector_container
	})
	// set pointer
	options_container.select_options = select_options
	// change event handler
	// Propagates the global target-field choice to every per-file selector in the queue.
	// (!) SCOPED TO THIS TOOL'S content_data, never `document` — same reason as the
	// processor selector above: `.option_component_select` is a shared class name
	// emitted by the upload queue for every caller on the page.
	const change_handler = () => {
		const option_component_nodes = content_data
			? content_data.querySelectorAll('select.option_component_select')
			: []
		const len = option_component_nodes.length
		for (let i = len - 1; i >= 0; i--) {
			option_component_nodes[i].value = select_options.value
		}
	}
	select_options.addEventListener('change', change_handler)

	// options
	for (let i = 0; i < option_components.length; i++) {

		const option = option_components[i]

		if (!option || !option.tipo) {
			console.warn(`Invalid option at index ${i}:`, option);
			continue;
		}

		const option_node = ui.create_dom_element({
			element_type	: 'option',
			class_name		: 'component select',
			inner_html		: option.label,
			parent			: select_options
		})

		if(option.default){
			option_node.selected = true
		}

		option_node.value = option.tipo
	}


	return target_field_selector_container
}//end render_target_field_selector



/**
* RENDER_QUALITY_SELECTOR
* Builds a labeled <select> for choosing the media quality tier to use when
* uploading files (e.g. 'original', 'medium', 'small').
*
* The available tiers come from `target_component_context.features.ar_quality`
* (resolved in tool_import_files.build).  The default tier is pre-selected and
* excluded from the "other options" loop to avoid duplicating it.
*
* On change, self.custom_target_quality is updated so the value is available when
* the import button is clicked and the API request options are assembled.
*
* Side effect: stores the <select> node as options_container.select_quality.
*
* @param {Object} self - tool_import_files instance; self.custom_target_quality is mutated
* @param {HTMLElement} options_container - receives .select_quality pointer
* @param {Array<string>} ar_quality - list of quality tier identifiers
* @param {string} default_target_quality - the tier to pre-select
* @returns {HTMLElement} quality_selector_container
*/
export const render_quality_selector = function (self, options_container, ar_quality, default_target_quality) {

	// target_quality
	const quality_selector_container = ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'target_quality'
	})

	// label
	const quality_label = self.get_tool_label('quality') || 'Quality'
	ui.create_dom_element({
		element_type	: 'label',
		class_name		: 'quality label',
		text_content	: quality_label + ': ',
		parent			: quality_selector_container
	})

	// select_quality. options process
	const select_quality = ui.create_dom_element({
		element_type	: 'select',
		class_name		: 'component select',
		parent			: quality_selector_container
	})
	// set pointer
	options_container.select_quality = select_quality
	// change event handler
	const change_handler = () => {
		self.custom_target_quality = select_quality.value
	}
	select_quality.addEventListener('change', change_handler)

	// default option
	// Pre-selected with selected=true; value and label are both the quality string.
	const default_option_node = new Option(default_target_quality, default_target_quality, true, true);
	select_quality.appendChild(default_option_node)

	// other options
	// Skip the default tier to avoid showing it twice.
	for (let i = 0; i < ar_quality.length; i++) {

		const option = ar_quality[i]

		if(option===default_target_quality){
			continue
		}

		const option_procesor_node = ui.create_dom_element({
			element_type	: 'option',
			class_name		: 'component select',
			inner_html		: option,
			parent			: select_quality
		})
		option_procesor_node.value = option
	}//end for (let i = 0; i < ar_quality.length; i++)


	return quality_selector_container
}//end render_quality_selector



/**
* RENDER_MATCHING_OPTIONS
* Builds the "Replace existing files" matching-options panel containing two
* iOS-style toggle switches:
*
*  1. "Matching ID"   (name_with_id_match_check_box)
*     Activates import_file_name_mode = 'match'.  The numeric prefix of the
*     file name is used to locate an existing source section and its linked
*     media records are replaced.
*
*  2. "Matching name" (free_name_match_check_box)
*     Activates import_file_name_mode = 'match_freename'.  The whole filename
*     is matched against stored filenames in the target media section.
*
* The two toggles are mutually exclusive with each other and with all checkboxes
* from render_configuration_options.  Activating either one also adds a CSS
* 'lock' class to the processor and target_component selectors (they are
* irrelevant when matching, because destination is determined by the match
* result on the server).
*
* The container is hidden (CSS class 'hide') when import_mode is not 'section'.
* It is rendered unconditionally so the event wiring works regardless; the
* server validates and ignores incompatible combinations.
*
* Attaches to options_container:
*   .name_with_id_match_check_box  — exposed to import-click handler
*   .free_name_match_check_box     — exposed to import-click handler
*
* @param {Object} self - tool_import_files instance
* @param {HTMLElement} options_container - receives checkbox pointers
* @param {HTMLElement} content_data - used to toggle CSS classes on template_container
* @returns {HTMLElement} matching_options_container
*/
export const render_matching_options = function (self, options_container, content_data) {

	// file name control
	// hide the options when the tool is caller by components, the import_mode is defined in preferences.
	const import_mode = self.tool_config?.import_mode

	// matching_options_container
	const matching_options_container = ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'tool_name_match_options'
	})
	// Only show for 'section' mode (not 'section_resource' or 'default').
	if (!['section'].includes(import_mode)) {
		matching_options_container.classList.add('hide')
	}

	// replace_existing_images_label
	ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'label title',
		inner_html		: self.get_tool_label('replace_existing_files') || 'Replace existing files',
		parent			: matching_options_container
	})

	// tool_name_match_label
	ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'label match',
		inner_html		: self.get_tool_label('match_name_with_previous_upload') || 'Matching the name with a previous upload:',
		parent			: matching_options_container
	})


	// name_match_id
	const name_match_id = ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'name_control name_match',
		parent			: matching_options_container
	})

	// switcher name_match id
	const name_match_switcher = ui.create_dom_element({
		element_type	: 'label',
		class_name		: 'switcher text_unselectable',
		parent			: name_match_id
	})
	// check_box
	const name_with_id_match_check_box = ui.create_dom_element({
		element_type	: 'input',
		type			: 'checkbox',
		class_name		: 'ios-toggle',
		parent			: name_match_switcher
	})
	// event change
	// When activated: deactivates all other checkboxes, adds 'match' class to
	// template_container, and locks processor/target_component selectors.
	const name_with_id_match_check_box_change_handler = () => {
		options_container.control_field_check_box.checked		= false
		options_container.same_name_check_box.checked			= false
		options_container.control_section_id_check_box.checked	= false
		options_container.free_name_match_check_box.checked		= false
		content_data.template_container.classList.remove('name_id','same_name_section','match_freename')
		if(name_with_id_match_check_box.checked === true){
			content_data.template_container.classList.add('match')
			if(options_container.processor){
				options_container.processor.classList.add('lock')
			}
			if(options_container.target_component){
				options_container.target_component.classList.add('lock')
			}
		}else{
			content_data.template_container.classList.remove('match')
			if(options_container.processor){
				options_container.processor.classList.remove('lock')
			}
			if(options_container.target_component){
				options_container.target_component.classList.remove('lock')
			}
		}
	}
	name_with_id_match_check_box.addEventListener('change', name_with_id_match_check_box_change_handler)
	// switch_label
	// The <i> element is the CSS-rendered toggle knob (no text content needed).
	ui.create_dom_element({
		element_type	: 'i',
		parent			: name_match_switcher
	})

	// label_section_id_check_box
	ui.create_dom_element({
		element_type	: 'span',
		class_name		: 'checkbox-label',
		inner_html		: self.get_tool_label('matching_id') || 'Matching ID',
		parent			: name_match_id
	})
	// set the node to be used when data will send to server
	options_container.name_with_id_match_check_box = name_with_id_match_check_box

	// name_match_container
	const name_match_container = ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'name_control name_match',
		parent			: matching_options_container
	})

	// switcher free names
	const free_names_match_switcher = ui.create_dom_element({
		element_type	: 'label',
		class_name		: 'switcher text_unselectable',
		parent			: name_match_container
	})
	// check_box
	const free_name_match_check_box = ui.create_dom_element({
		element_type	: 'input',
		type			: 'checkbox',
		class_name		: 'ios-toggle',
		parent			: free_names_match_switcher
	})
	// set pointer. Set the node to be used when data will send to server
	options_container.free_name_match_check_box = free_name_match_check_box
	// change event
	// Mirror of name_with_id_match_check_box_change_handler; uses 'match_freename' class.
	const free_name_match_check_box_change_handler = () => {
		options_container.control_field_check_box.checked		= false
		options_container.same_name_check_box.checked			= false
		options_container.control_section_id_check_box.checked	= false
		options_container.name_with_id_match_check_box.checked	= false
		content_data.template_container.classList.remove('name_id','same_name_section','match')
		if(free_name_match_check_box.checked === true){
			content_data.template_container.classList.add('match_freename')
			if(options_container.processor){
				options_container.processor.classList.add('lock')
			}
			if(options_container.target_component){
				options_container.target_component.classList.add('lock')
			}
		}else{
			content_data.template_container.classList.remove('match_freename')
			if(options_container.processor){
				options_container.processor.classList.remove('lock')
			}
			if(options_container.target_component){
				options_container.target_component.classList.remove('lock')
			}
		}
	}
	free_name_match_check_box.addEventListener('change', free_name_match_check_box_change_handler)
	// switch_label
	ui.create_dom_element({
		element_type	: 'i',
		parent			: free_names_match_switcher
	})
	// label_section_id_check_box
	ui.create_dom_element({
		element_type	: 'span',
		class_name		: 'checkbox-label',
		inner_html		: self.get_tool_label('matching_name') || 'Matching name',
		parent			: name_match_container
	})


	return matching_options_container
}//end render_matching_options



/**
* RENDER_CONFIGURATION_OPTIONS
* Builds the "New files" configuration panel with three mutually exclusive
* iOS-style toggle switches that control how a newly uploaded file is
* assigned a section identity:
*
*  1. "Suffix indicates field" (control_field_check_box)
*     When checked, set_import_mode(self, true) is called on each newly added file
*     and on checkbox change.  The file name suffix (e.g. "-A") is parsed to
*     auto-assign the per-file target component.
*     Hidden in 'section_resource' mode (file goes to a resource, no routing).
*
*  2. "Prefix indicates id" / "Name indicates id" (control_section_id_check_box)
*     Activates import_file_name_mode = 'enumerate'.  The numeric prefix of the
*     filename is used as the section_id for the created section.
*     Label changes to 'Name indicates id' in 'section_resource' mode.
*
*  3. "Same name same record. Create new ID" (same_name_check_box)
*     Activates import_file_name_mode = 'named'.  Files sharing the same base
*     name are grouped into the same section.
*     Hidden in 'section_resource' mode.
*
* The three checkboxes in this panel are mutually exclusive with each other and
* with the matching checkboxes from render_matching_options.
*
* The container is hidden (CSS class 'hide') when import_mode is not 'section'
* or 'section_resource'.
*
* An info_options_select (read-only) shows the current map_name → label mapping
* for the "suffix indicates field" option.
*
* Attaches to options_container:
*   .control_field_check_box         — exposed to import-click handler
*   .control_section_id_check_box    — exposed to import-click handler
*   .same_name_check_box             — exposed to import-click handler
*
* Subscribes to the 'drop_zone_addedfile' event (token stored in self.events_tokens)
* to re-run set_import_mode on each newly added file.
*
* @param {Object} self - tool_import_files instance
* @param {HTMLElement} options_container - receives checkbox pointers
* @param {HTMLElement} content_data - used to toggle CSS classes on template_container
* @param {Array<{tipo: string, label: string, map_name?: string}>} option_components
* @returns {HTMLElement} tool_configuration_options_container
*/
export const render_configuration_options = function (self, options_container, content_data, option_components) {

	// file name control
	// hide the options when the tool is caller by components, the import_mode is defined in preferences.
	const import_mode = self.tool_config?.import_mode

	// tool_configuration_options_container
	const tool_configuration_options_container = ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'tool_configuration_options'
	})
	// Only show for section-creating modes.
	if (!['section','section_resource'].includes(import_mode)) {
		tool_configuration_options_container.classList.add('hide')
	}

	// new_files_label
	ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'label title',
		inner_html		: self.get_tool_label('new_files') || 'New files',
		parent			: tool_configuration_options_container
	})

	// NAME (Suffix indicates field)

		// name_control_field
		const name_control_field = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'name_control name_control_field',
			parent			: tool_configuration_options_container
		})
		// Suffix-parsing only makes sense when target routing is per-portal, not resource.
		if (import_mode==='section_resource') {
			name_control_field.classList.add('hide')
		}

		// switcher
		const control_field_switcher = ui.create_dom_element({
			element_type	: 'label',
			class_name		: 'switcher text_unselectable',
			parent			: name_control_field
		})

		// control_field_check_box
		const control_field_check_box = ui.create_dom_element({
			element_type	: 'input',
			type			: 'checkbox',
			parent			: control_field_switcher
		})
		// set pointer
		options_container.control_field_check_box = control_field_check_box
		// change event
		// Deactivates matching modes and calls set_import_mode with the current checked state.
		const control_field_check_box_change_handler = () => {
			// match deactivate
				options_container.name_with_id_match_check_box.checked	= false
				options_container.free_name_match_check_box.checked		= false
				if(options_container.processor){
					options_container.processor.classList.remove('lock')
				}
				if(options_container.target_component){
					options_container.target_component.classList.remove('lock')
				}
			content_data.template_container.classList.remove('match','match_freename')

			set_import_mode(self, control_field_check_box.checked)
		}
		control_field_check_box.addEventListener('change', control_field_check_box_change_handler)
		// when the images was added (drop) set the import mode
		// (check the name and assign the field)
		// Re-applies the suffix-to-field mapping whenever a new file is added to the queue.
		const drop_zone_addedfile_handler = () => {
			set_import_mode(self, control_field_check_box.checked)
		}
		self.events_tokens.push(
			event_manager.subscribe('drop_zone_addedfile', drop_zone_addedfile_handler)
		)
		// switch_label
		ui.create_dom_element({
			element_type	: 'i',
			parent			: control_field_switcher
		})
		// label_field_check_box
		ui.create_dom_element({
			element_type	: 'span',
			class_name		: 'checkbox-label',
			inner_html		: self.get_tool_label('name_to_field') || 'Suffix indicates field',
			parent			: name_control_field
		})

		// info_options_select
		// Read-only <select> showing the map_name → label pairs for reference.
		// The user cannot interact with it; it's informational only.
		const info_options = ui.create_dom_element({
			element_type	: 'select',
			class_name		: 'info_options_select',
			parent			: name_control_field
		})
		for (let i = 0; i < option_components.length; i++) {

			const option	= option_components[i]
			const map_name	= option.map_name ? `- ${option.map_name} -> ` : ''

			// option_node
			ui.create_dom_element({
				element_type	: 'option',
				text_content	: map_name + option.label,
				parent			: info_options
			})
		}//end for (let i = 0; i < option_components.length; i++)

	// SECTION ID (Prefix indicates id)

		// name_control_to_section_id
		const name_control_section_id = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'name_control name_control_section_id',
			parent			: tool_configuration_options_container
		})
		// switcher
		const control_section_id_switcher = ui.create_dom_element({
			element_type	: 'label',
			class_name		: 'switcher text_unselectable',
			parent			: name_control_section_id
		})
		// check_box
		const control_section_id_check_box = ui.create_dom_element({
			element_type	: 'input',
			type			: 'checkbox',
			class_name		: 'ios-toggle',
			parent			: control_section_id_switcher
		})
		// set pointer. Set the node to be used when data will send to server
		options_container.control_section_id_check_box = control_section_id_check_box
		// change event
		// Activating 'enumerate' deactivates matching and same_name_check_box;
		// adds 'name_id' class to template_container for CSS-driven preview annotations.
		const control_section_id_check_box_change_handler = () => {
			// match deactivate
			options_container.name_with_id_match_check_box.checked	= false
			options_container.free_name_match_check_box.checked		= false
			if(options_container.processor){
				options_container.processor.classList.remove('lock')
			}
			if(options_container.target_component){
				options_container.target_component.classList.remove('lock')
			}
			content_data.template_container.classList.remove('match','match_freename')
			if(control_section_id_check_box.checked){
				content_data.template_container.classList.add('name_id')
			}else{
				content_data.template_container.classList.remove('name_id')
			}
			// 'enumerate' and 'named' are mutually exclusive; uncheck same_name_check_box.
			if(options_container.same_name_check_box.checked){
				options_container.same_name_check_box.checked = false
				content_data.template_container.classList.remove('same_name_section')
			}
		}
		control_section_id_check_box.addEventListener('change', control_section_id_check_box_change_handler)
		// switch_label
		ui.create_dom_element({
			element_type	: 'i',
			parent			: control_section_id_switcher
		})
		// label_section_id_check_box
		// Label differs between modes: resource mode uses 'Name indicates id';
		// section mode uses self.get_tool_label('name_to_record_id') ('Prefix indicates id').
		const current_label = import_mode==='section_resource'
			? self.get_tool_label('name_indicates_id') || 'Name indicates id'
			: self.get_tool_label('name_to_record_id') || 'Prefix indicates id'
		ui.create_dom_element({
			element_type	: 'span',
			class_name		: 'checkbox-label',
			inner_html		: current_label,
			parent			: name_control_section_id
		})

	// SAME NAME (Same name same record. Create new ID)

		// same_name_same_section
		const same_name_same_section = ui.create_dom_element({
			element_type	: 'div',
			class_name 		: 'name_control same_name_same_section',
			parent 			: tool_configuration_options_container
		})
		// Grouping by basename only applies when creating new child sections.
		if (import_mode==='section_resource') {
			same_name_same_section.classList.add('hide')
		}

		// switcher
		const same_name_same_section_switcher = ui.create_dom_element({
			element_type	: 'label',
			class_name		: 'switcher text_unselectable',
			parent			: same_name_same_section
		})
		// check_box
		const same_name_check_box = ui.create_dom_element({
			element_type	: 'input',
			type			: 'checkbox',
			class_name		: 'ios-toggle',
			parent			: same_name_same_section_switcher
		})
		// set pointer. Set the node to be used when data will send to server
		options_container.same_name_check_box = same_name_check_box
		// change event
		// Activating 'named' deactivates matching and control_section_id_check_box;
		// adds 'same_name_section' class to template_container.
		const same_name_check_box_change_handler = () => {
			// match deactivate
				options_container.name_with_id_match_check_box.checked	= false
				options_container.free_name_match_check_box.checked		= false
				if(options_container.processor){
					options_container.processor.classList.remove('lock')
				}
				if(options_container.target_component){
					options_container.target_component.classList.remove('lock')
				}
			content_data.template_container.classList.remove('match','match_freename')
			// 'named' and 'enumerate' are mutually exclusive; uncheck control_section_id_check_box.
			if(control_section_id_check_box.checked){
				control_section_id_check_box.checked = false
				content_data.template_container.classList.remove('name_id')
			}
			if(same_name_check_box.checked){
				content_data.template_container.classList.add('same_name_section')
			}else{
				content_data.template_container.classList.remove('same_name_section')
			}
		}
		same_name_check_box.addEventListener('change', same_name_check_box_change_handler)
		// switch_label
		ui.create_dom_element({
			element_type	: 'i',
			parent			: same_name_same_section_switcher
		})
		// label_same_name_check_box
		ui.create_dom_element({
			element_type	: 'span',
			class_name		: 'checkbox-label',
			inner_html		: self.get_tool_label('same_name_same_record') || 'Same name same record. Create new ID',
			parent			: same_name_same_section
		})


	return tool_configuration_options_container
}//end render_configuration_options



// @license-end
