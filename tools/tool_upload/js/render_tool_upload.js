// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_label, page_globals, SHOW_DEBUG, DEDALO_TOOLS_URL */
/*eslint no-undef: "error"*/



// imports
	import {dd_request_idle_callback} from '../../../core/common/js/events.js'
	import {get_instance} from '../../../core/common/js/instances.js'
	import {ui} from '../../../core/common/js/ui.js'
	import {request_failed, response_data} from '../../../core/common/js/api_error.js'
	import {handle_api_error} from '../../../core/common/js/error_dispatch.js'
	import {error_text, render_error_inline} from '../../../core/common/js/render_api_error.js'



/**
* RENDER_TOOL_UPLOAD
* Client-side rendering module for the tool_upload tool.
*
* Responsibilities:
* - Builds the edit-mode wrapper DOM that hosts the `service_upload` file-picker widget
*   (drag-and-drop, button, progress bar — all delegated to the `service_upload` service).
* - Handles the `upload_file_done_<id>` event dispatched by `service_upload` after a
*   successful upload: calls `process_uploaded_file_controller` to move the temp file to
*   its final destination, shows a spinner + status message, and — when the caller is a
*   component — re-instantiates and renders that component in a preview panel so the user
*   can see the result without reloading the page.
* - Provides the `get_content_data` helper that creates the two main DOM zones:
*   `process_file` (status/spinner area) and `preview_component_container` (live preview).
*
* Life-cycle (orchestrated by `tool_upload.js`):
*   tool_upload.init() → subscribes to 'upload_file_done_<id>'
*   tool_upload.build() → creates and builds `service_upload` service instance
*   tool_upload.render() [→ tool_common.prototype.render]
*     → calls render_tool_upload.prototype.edit()
*       → get_content_data() — builds fixed DOM slots
*       → service_upload.build() then service_upload.render() — injects file picker
*   [user picks/drops file]
*   service_upload publishes 'upload_file_done_<id>' with file_data + process_options
*   tool_upload.upload_done() [→ render_tool_upload.prototype.upload_done()]
*     → process_uploaded_file_controller() → server-side move + component processing
*     → optional: re-renders caller component in preview_component_container
*
* Main exports:
* - `render_tool_upload` — constructor used as mixin prototype source by `tool_upload`.
* - `get_content_data` — standalone DOM builder shared by the edit/list/mini views.
*/
export const render_tool_upload = function() {

	return true
}//end render_tool_upload



/**
* EDIT
* Builds and returns the full edit-mode DOM node for tool_upload.
*
* Called as `render_tool_upload.prototype.edit` and also aliased to `.list` and
* `.mini` in `tool_upload.js` so all three modes share the same layout.
*
* Steps:
* 1. If `render_level === 'content'`, returns only the content_data fragment
*    (used when the host layout wants to inject the tool into an existing shell).
* 2. Otherwise builds the standard tool wrapper via `ui.tool.build_wrapper_edit`,
*    creates a `service_upload_container` div immediately after the tool header,
*    shows a temporary spinner while `service_upload` initialises, then appends
*    the rendered service_upload node and removes the spinner.
*
* The `service_upload` instance must already exist on `self` at call time
* (populated by `tool_upload.prototype.build()`).
*
* @param {Object} options - Render options.
* @param {string} [options.render_level='full'] - 'full' builds the whole wrapper;
*   'content' returns only the inner content_data fragment.
* @returns {Promise<HTMLElement>} The finished wrapper element (or content_data
*   fragment when render_level is 'content').
*/
render_tool_upload.prototype.edit = async function (options) {

	const self = this

	// options
		const render_level = options.render_level || 'full'

	// content_data
		const content_data = get_content_data(self)
		if (render_level==='content') {
			return content_data
		}

	// wrapper. ui build_edit returns component wrapper
		const wrapper = ui.tool.build_wrapper_edit(self, {
			content_data : content_data
		})

	// service_upload
		// Use the service_upload to get and render the button to upload the file,
		// get functionality defined (drag, drop, create folder, etc..)
		// service_upload_container
		const service_upload_container = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'service_upload_container'
		})
		wrapper.tool_header.after(service_upload_container)
		// spinner
		const spinner = ui.create_dom_element({
			element_type	: 'div',
			class_name		: "spinner",
			parent			: service_upload_container
		})
		// service_upload. Build and render
		self.service_upload.build()
		.then(function(){
			self.service_upload.render()
			.then(function(tool_upload_node){
				service_upload_container.appendChild(tool_upload_node)
				spinner.remove()
			})
		})


	return wrapper
}//end edit



/**
* GET_CONTENT_DATA
* Builds the inner content DOM for the tool_upload UI.
*
* Creates two fixed zones that are later populated dynamically:
* - `process_file` — receives a spinner and status text while the server processes
*   the uploaded file; stored as `self.process_file` so `upload_done` can update it.
* - `preview_component_container` — receives a freshly-rendered instance of the
*   caller component after processing succeeds; stored as
*   `self.preview_component_container`.
*
* Both nodes are stored as instance properties so `upload_done` can reference them
* without re-querying the DOM.
*
* Wraps the fragment in `ui.tool.build_content_data(self)` to produce a
* standard `.content_data` container element.
*
* @param {Object} self - The tool_upload instance.
* @returns {HTMLElement} The populated content_data container element.
*/
export const get_content_data = function(self) {

	const fragment = new DocumentFragment()

	// process_file
		const process_file = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'process_file',
			parent			: fragment
		})
		self.process_file = process_file

	// preview_component_container
		const preview_component_container = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'preview_component_container',
			parent			: fragment
		})
		// fix
		self.preview_component_container = preview_component_container

	// content_data
		const content_data = ui.tool.build_content_data(self)
		content_data.appendChild(fragment)


	return content_data
}//end get_content_data



/**
* UPLOAD_DONE
* Reacts to a successful file upload and triggers server-side processing.
*
* Subscribed to the `upload_file_done_<id>` event published by `service_upload`
* once all chunks have been joined server-side (see `tool_upload.prototype.init`
* in tool_upload.js).
*
* Workflow:
* 1. Clears and re-fills `self.process_file` with a spinner + "Processing file.."
*    message so the user has visual feedback during the (potentially long)
*    server-side move / transcoding step.
* 2. Calls `self.process_uploaded_file_controller(file_data, process_options)`,
*    which POSTs to `tool_upload::process_uploaded_file` on the PHP side via
*    `data_manager.request` with a 3 600-second timeout (large media files can
*    take a long time to transcode).
* 3. On failure: shows the server error message as plain text (textContent, not
*    innerHTML — avoids XSS from file paths or error strings with HTML characters)
*    and adds the 'failed' CSS class.
* 4. On success: shows the success message, hides the service_upload form and
*    progress bar via `dd_request_idle_callback` (deferred to keep the UI
*    responsive), and — when `self.caller.type === 'component'` — creates a fresh
*    component instance (using `id_variant` to avoid id conflicts with the
*    original caller instance), builds it, optionally calls its `upload_handler`
*    callback (e.g. for 3D posterframe creation), and renders it into
*    `self.preview_component_container`.
*
* Side effects:
* - Mutates `self.process_file` DOM (clears children, adds spinner/text).
* - Pushes the new component instance onto `self.ar_instances` so it is cleaned
*   up by `destroy()`.
* - Sets `component_instance.show_interface.tools = false` before rendering to
*   suppress the component's own tool buttons inside the preview.
*
* @param {Object} options - Payload from the 'upload_file_done_<id>' event.
* @param {Object} options.file_data - Server-side file metadata returned by
*   service_upload after joining chunks:
*   `{ error: number, extension: string, name: string, size: number,
*      tmp_name: string, type: string }`.
* @param {Object} [options.process_options] - Optional processing flags forwarded
*   to the PHP handler (e.g. `{ ocr: true, ocr_lang: 'lg-spa' }`).
* @returns {Promise<boolean>} Resolves to `true` on success, `false` on failure.
*/
render_tool_upload.prototype.upload_done = async function (options) {

	const self = this

	// options
		const file_data			= options.file_data;
		const process_options	= options.process_options;

	// process_file loading
		while (self.process_file.firstChild) {
			self.process_file.removeChild(self.process_file.firstChild);
		}
		const spinner = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'spinner',
			parent			: self.process_file
		})
		const process_file_info = ui.create_dom_element({
			element_type	: 'span',
			inner_html		: 'Processing file..',
			class_name		: 'info',
			parent			: self.process_file
		})
		self.process_file.appendChild(spinner)

	// process uploaded file (move temp uploaded file to definitive location and name)
		const response = await self.process_uploaded_file_controller(file_data, process_options)

	// spinner remove
		spinner.remove()

	// reset classes
		process_file_info.classList.remove('failed')
		process_file_info.classList.remove('success')

	// response payload (envelope v2). `response_data` is the ONE accessor:
	// `data` on a v2 success, the compat `result` mirror while it lasts, and
	// `false` on a failure envelope — so the guard below covers both shapes.
		const response_data_value = response_data(response)

	// response failed case
		if (request_failed(response) || !response_data_value) {

			// ERROR case
			// The dispatcher owns the surface for a real ApiError; the inline text
			// is the fallback for a body that is neither a v2 failure nor a payload.
			// SEC-XSS-005: server text may contain file paths / < > & characters —
			// textContent, never an HTML sink.
			process_file_info.textContent = request_failed(response)
				? error_text(response.error)
				: 'Error on processing file!'
			process_file_info.classList.add('failed')

			if (request_failed(response)) {
				handle_api_error(response.error, {wrapper: process_file_info.parentNode});
			}

			return false
		}

	// response OK case
		// Envelope v2 has NO prose `msg` on success, and tool_upload's server does
		// not compose one either (its payload is original_file_name / extension /
		// files_info / derivative_errors — tools/tool_upload/server/index.ts:96-104).
		// The sentence is therefore the client's own.
		// SEC-XSS-005
		process_file_info.textContent = 'Processing file done successfully.'
		process_file_info.classList.add('success')

	// derivative_errors. The upload LANDED (the file was moved and indexed) but one
	// or more derivatives could not be built, so the server reports them BESIDE the
	// success instead of failing the envelope (server/index.ts:85-95). Each entry is
	// its own line so a multi-derivative failure stays readable.
		const derivative_errors = Array.isArray(response_data_value.derivative_errors)
			? response_data_value.derivative_errors
			: []
		for (const entry of derivative_errors) {
			// The SAME surface the failure branch above uses (handle_api_error →
			// render_error_inline into this wrapper), so the two kinds of bad news
			// read alike. A bare string prints as-is; a coded entry resolves through
			// the ONE renderer (label in the user's language, message, then code).
			render_error_inline(self.process_file, entry)
		}

	// ingest_notices (T0-11). What the upload did that the curator must know and
	// that is NOT a failure — e.g. "replaced N chars of existing transcription"
	// (Time Machine keeps the previous version). Plain text lines BESIDE the
	// success, never through the error renderer: nothing here went wrong.
		const ingest_notices = Array.isArray(response_data_value.ingest_notices)
			? response_data_value.ingest_notices
			: []
		for (const entry of ingest_notices) {
			ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'process_file_notice',
				text_content	: String(entry), // textContent, never an HTML sink
				parent			: self.process_file
			})
		}

	// HAND THE TRANSCODE TO THE TRAY. The server has been returning `job_id` here
	// all along and this client dropped it, which is why uploading a video looked
	// finished while ffmpeg still had an hour of work to do: the UPLOAD was
	// complete, the derivative was not, and nothing on screen distinguished the
	// two. The tray carries it from here, so the message above stays true and the
	// operator keeps sight of the work after this dialog closes.
		if (response.job_id && page_globals.job_tray) {
			page_globals.job_tray.refresh()
		}

	// hide service_upload elements. To upload again, user must to reload the page
		dd_request_idle_callback(
			() => {
				[self.service_upload.form, self.service_upload.progress_bar_container].forEach(el => el.classList.add('hide'));
			}
		)

	// preview_component_container
		if (self.caller.type==='component') {

			// component_instance. Get instance and init, build
				// Must be a new one, not use the caller instance to prevent problems
				// with data update on build
				const component_instance = await get_instance({
					model			: self.caller.model,
					mode			: 'edit',
					view			: 'default',
					permissions		: 1,
					tipo			: self.caller.tipo,
					section_tipo	: self.caller.section_tipo,
					section_id		: self.caller.section_id,
					lang			: self.caller.lang,
					id_variant		: self.model + '_' + self.caller.id, // id_variant prevents id conflicts
					caller			: self // set current tool as component caller (to check if component is inside tool or not)
				})
				// add to tool instances to allow delete on destroy
				self.ar_instances.push(component_instance)
				// build
				await component_instance.build(true)

			// upload_handler callback
				// Used for example to create posterframe when component is rendered and viewer is ready
				// @see component_3d
				if (typeof component_instance.upload_handler==='function') {
					component_instance.upload_handler()
				}

			// render component
				// show_interface
				component_instance.show_interface.tools = false
				// render instance
				const component_node = await component_instance.render()

			// preview. Add rendered component node
				self.preview_component_container.appendChild(component_node)
		}


	return true
}//end upload_done



/**
* RENDER_FILEDRAG
* @return HTMLElement filedrag
*/
// export const render_filedrag = function(self) {

// 	// filedrag node
// 		const filedrag = ui.create_dom_element({
// 			element_type	: 'label',
// 			class_name		: 'filedrag'
// 			// text_content	: 'Select a file to upload or drop it here', // get_label.select_a_file ||
// 			// parent		: form
// 		})
// 		filedrag.setAttribute('for','file_to_upload')
// 		filedrag.addEventListener("dragover", file_drag_hover, false);
// 		filedrag.addEventListener("dragleave", file_drag_hover, false);
// 		filedrag.addEventListener("drop", function(e){

// 			// cancel event and hover styling
// 			file_drag_hover(e);

// 			// fetch FileList object
// 			const files = e.target.files || e.dataTransfer.files;

// 			// process all File objects
// 			// for (let i = 0; i < files.length; i++) {

// 				// const file = files[i]

// 				// parse file info
// 				// parse_local_file(file);

// 				// upload
// 				// self.upload_file(file, content_data, response_msg, preview_image, progress_bar_container)


// 				const file = files[0] || null
// 				if (!file) {
// 					return false
// 				}

// 				file_selected(self, file)

// 				filedrag.classList.add('loading_file')

// 				// reset preview_image
// 				if (self.preview_image) {
// 					self.preview_image.src = ''
// 				}

// 				self.upload_file({
// 					file : file
// 				})
// 				.then(function(response){
// 					// show filedrag again
// 						filedrag.classList.remove('loading_file')

// 					// on success actions
// 						if (response.result===true) {
// 							if (response.preview_url && self.preview_image) {
// 								self.preview_image.src = response.preview_url
// 								self.caller.refresh()
// 							}
// 							self.response_msg.innerHTML = response.msg || 'OK. File uploaded'
// 						}else{
// 							self.response_msg.innerHTML = response.msg || 'Error on upload file'
// 						}
// 				})

// 				// break; // only one is allowed
// 			// }
// 		})
// 		// fix
// 		self.filedrag = filedrag

// 	// label icon
// 		ui.create_dom_element({
// 			element_type	: 'img',
// 			src				: DEDALO_TOOLS_URL + '/' + self.model + '/img/icon.svg',
// 			parent			: filedrag
// 		})

// 	// label text
// 		ui.create_dom_element({
// 			element_type	: 'span',
// 			class_name		: '',
// 			text_content	: 'Select or drop a file it here',
// 			parent			: filedrag
// 		})

// 	// filedrag
// 		// const filedrag = ui.create_dom_element({
// 		// 	element_type	: 'div',
// 		// 	class_name		: 'filedrag',
// 		// 	text_content 	: 'or drop a file here',
// 		// 	parent 			: form
// 		// })


// 	return filedrag
// }//end render_filedrag



/**
* FILE_SELECTED
* Manages user drag file or user file selection
*/
// export const file_selected = async function(self, file) {

// 	self.filedrag.classList.add('loading_file')

// 	// reset preview_image if exists
// 		if (self.preview_image) {
// 			self.preview_image.src = ''
// 		}

// 	// upload file to server
// 		const response = await self.upload_file({
// 			file : file
// 		})

// 	// show filedrag again
// 		self.filedrag.classList.remove('loading_file')

// 	// on success actions
// 		if (response.result===true) {
// 			if (response.preview_url && self.preview_image) {
// 				self.preview_image.src = response.preview_url
// 			}
// 			self.caller.refresh()
// 			self.response_msg.innerHTML = response.msg || 'OK. File uploaded'
// 		}else{
// 			self.response_msg.innerHTML = response.msg || 'Error on upload file'
// 		}


// 	return response
// }//end file_selected



/**
* RENDER_PROGRESS_BAR
*/
// export const render_progress_bar = function(self) {

// 	// progress_bar_container
// 		const progress_bar_container = ui.create_dom_element({
// 			element_type	: 'div',
// 			class_name		: 'progress_bar_container'
// 		})

// 	// progress_info
// 		const progress_info = ui.create_dom_element({
// 			element_type	: 'div',
// 			class_name		: 'progress_info',
// 			parent 			: progress_bar_container
// 		})
// 		// fix
// 		self.progress_info = progress_info

// 	// progress_line
// 		const progress_line = ui.create_dom_element({
// 			element_type	: 'progress',
// 			class_name		: 'progress_line',
// 			parent 			: progress_bar_container
// 		})
// 		progress_line.max   = 100;
// 		progress_line.value = 0;
// 		// fix
// 		self.progress_line = progress_line


// 	return progress_bar_container
// }//end render_progress_bar



/**
* FILE_DRAG_HOVER
*/
// export const file_drag_hover = function(e) {

// 	e.stopPropagation();
// 	e.preventDefault();

// 	if (e.type==="dragover") {
// 		e.target.classList.add("hover")
// 	}else{
// 		e.target.classList.remove("hover")
// 	}

// 	return true
// }//end file_drag_hover



/**
* FILE_SELECT_HANDLER
*/
// export const file_select_handler = function(e) {

// 	// cancel event and hover styling
// 	file_drag_hover(e);

// 	// fetch FileList object
// 	const files = e.target.files || e.dataTransfer.files;

// 	// process all File objects
// 	for (let i = 0; i < files.length; i++) {

// 		const file = files[i]

// 		// parse file info
// 		// parse_local_file(file);

// 		// upload
// 		self.upload_file(file, content_data, response_msg, preview_image, progress_bar_container)

// 		break; // only one is allowed
// 	}

// 	return true
// }//end file_select_handler



// Removed for the time being (!)
// // output information
// function msg_output(msg) {
// 	// file_info.innerHTML = msg + file_info.innerHTML;
// 	file_info.innerHTML += msg;
// }

// // output file information
// function parse_local_file(file) {

// 	msg_output(
// 		"<div><span>Name:</span> <strong>" + file.name + "</strong></div>" +
// 		"<div><span>Type:</span> <strong>" + file.type + "</strong></div>" +
// 		"<div><span>Size:</span> <strong>" + parseInt(file.size/1024) + "</strong> Kbytes</div>"
// 	);

// 	// display an image
// 	if (file.type.indexOf("image") == 0) {
// 		var reader = new FileReader();
// 		reader.onload = function(e) {
// 			msg_output(
// 				'<div><img src="' + e.target.result + '" /></div>'
// 			);
// 		}
// 		reader.readAsDataURL(file);
// 	}

// 	// display text
// 	if (file.type.indexOf("text") == 0) {
// 		var reader = new FileReader();
// 		reader.onload = function(e) {
// 			msg_output(
// 				"<p><strong>" + file.name + ":</strong></p><pre>" +
// 				e.target.result.replace(/</g, "&lt;").replace(/>/g, "&gt;") +
// 				"</pre>"
// 		);
// 		}
// 		reader.readAsText(file);
// 	}

// 	return true
// }//end parse_local_file



// @license-end
