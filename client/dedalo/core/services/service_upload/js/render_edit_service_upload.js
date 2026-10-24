// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_label, DEDALO_CORE_URL */
/*eslint no-undef: "error"*/
// (!) page_globals is used at line ~161 (dedalo_application_langs) but is NOT listed in
//     the /*global*/ declaration above. ESLint will flag it as an undeclared global.
//     Add page_globals to the /*global*/ block to suppress the no-undef warning.



/**
* MODULE: render_edit_service_upload
*
* Client-side edit renderer for service_upload.  Builds the lightweight, native
* (no third-party library) single-file upload UI: a drag-and-drop target, a hidden
* file-input for click-to-browse, an optional OCR options panel (PDF only), an
* XHR progress bar, a result message area, and a collapsible diagnostic info panel.
*
* This module is the render layer for service_upload (see service_upload.js).
* service_upload mixes in the `edit` prototype method from
* render_edit_service_upload.prototype so that common.prototype.render can call it
* transparently.  All other exported symbols are standalone helpers that can be
* imported directly by tool renderers that embed the upload UI without going through
* the full service_upload lifecycle.
*
* Key contracts with the service_upload instance (`self`):
*   self.caller                   — {Object} the component/tool that owns this service.
*   self.caller.context.features  — {Object|null} optional; supplies target_quality and
*                                   key_dir if not set directly on self.
*   self.allowed_extensions       — {Array<string>} extensions accepted by the server
*                                   (e.g. ['jpg','png','pdf']).
*   self.pdf_ocr_engine           — {string|null} truthy when the server has a PDF OCR
*                                   engine configured; controls OCR panel visibility.
*   self.max_size_bytes           — {number} PHP upload_max_filesize in bytes; populated
*                                   by service_upload.build via get_system_info API.
*   self.upload_service_chunk_files — {number|null} MB per chunk (from server config);
*                                   0/null/false means chunking is disabled.
*   self.sys_get_temp_dir         — {string} PHP sys_get_temp_dir() path.
*   self.upload_tmp_dir           — {string} configured user upload temp directory.
*   self.upload_tmp_perms         — {string} octal permission string of upload_tmp_dir.
*   self.session_cache_expire     — {number} session expiry in minutes.
*   self.max_concurrent           — {number} maximum simultaneous XHR connections.
*   self.process_options          — {Object} set here; mutated by OCR controls.
*     .ocr      {boolean} whether OCR should be applied after upload (PDF only).
*     .ocr_lang {string|null} BCP-47 language tag chosen by the user; null = not set.
*   self.form                     — {HTMLElement} set here; the <form> element.
*   self.filedrag                 — {HTMLElement} set here; the drag-and-drop label.
*   self.progress_bar_container   — {HTMLElement} set here; outer progress wrapper.
*   self.progress_info            — {HTMLElement} set here; text progress description.
*   self.progress_line            — {HTMLProgressElement} set here; <progress> node.
*   self.response_msg             — {HTMLElement} set here; success/failure message div.
*   self.upload_file              — {Function} defined on service_upload.prototype;
*                                   called by file_selected to trigger the XHR upload.
*
* Exported symbols:
*   render_edit_service_upload    — constructor / prototype host for `edit`.
*   get_content_data              — sync; builds the complete inner UI tree.
*   render_info                   — sync; builds the collapsible diagnostic panel.
*   render_filedrag               — sync; builds the drag-and-drop drop target label.
*   file_selected                 — async; orchestrates upload on file pick or drop.
*   render_progress_bar           — sync; builds the XHR progress bar container.
*   file_drag_hover               — sync; dragover/dragleave CSS-class toggle handler.
*/

// imports
	import {ui} from '../../../common/js/ui.js'
	import {get_content_data_queue} from './render_edit_service_upload_queue.js'
	import {response_data, request_failed} from '../../../common/js/api_error.js'
	import {error_text} from '../../../common/js/render_api_error.js'



/**
* RENDER_EDIT_SERVICE_UPLOAD
* Constructor function — prototype host for the `edit` method that is mixed into
* service_upload via prototype assignment (see service_upload.js prototype assign block).
* The body intentionally contains only `return true`; all rendering logic lives in
* the exported helper functions below.
*/
export const render_edit_service_upload = function() {

	return true
}//end render_edit_service_upload



/**
* EDIT
* Entry point called by common.prototype.render when mode is 'edit'.
* Builds and returns the outer wrapper div (CSS class 'service_upload') that holds
* the complete upload UI.  When render_level is 'content' only the inner
* content_data element is returned (useful for partial refreshes without
* rebuilding the wrapper).
*
* TWO RENDERS, ONE MODEL. `self.multiple===true` selects the multi-file upload
* QUEUE (render_edit_service_upload_queue.js) instead of the single-file form,
* and the wrapper gains the `multiple` modifier class the LESS keys off
* (`.service_upload.multiple > .content_data`). The model string is NOT branched:
* see the note in the service_upload constructor for why a second model would
* cost a duplicate service directory.
*
* @param {Object} options
* @param {string} [options.render_level='full'] - 'full' returns the wrapper div;
*   'content' returns only the content_data element.
* @returns {Promise<HTMLElement>} wrapper div (render_level 'full') or
*   content_data div (render_level 'content').
*/
render_edit_service_upload.prototype.edit = async function (options) {

	const self = this

	// options
		const render_level = options.render_level || 'full'

	// content_data. The queue builder is async (it awaits the staged-file
	// listing); the single-file builder is sync and stays untouched.
		const content_data = self.multiple===true
			? await get_content_data_queue(self)
			: get_content_data(self)
		if (render_level==='content') {
			return content_data
		}

	// wrapper
		// Root element; callers can query wrapper.content_data for partial re-renders.
		const wrapper = ui.create_dom_element({
			element_type	: 'div',
			class_name		: self.multiple===true
				? 'service_upload multiple'
				: 'service_upload'
		})
		wrapper.appendChild(content_data)
		// set pointers
		wrapper.content_data = content_data


	return wrapper
}//end edit



/**
* GET_CONTENT_DATA
* Assembles the top-level content_data div.  The function is synchronous because
* the native file-input upload UI requires no async prefetching (unlike
* service_dropzone which must list previously uploaded files from the server).
*
* Structure of the returned element:
*   div.content_data
*   ├── form#form_upload[enctype=multipart/form-data method=post]
*   │   ├── input[type=file#file_to_upload]    — hidden; driven by the filedrag label
*   │   ├── label.filedrag                     — drag-drop zone + file-picker trigger
*   │   ├── div.file_info                      — placeholder (currently empty)
*   │   └── div.ocr_options_container          — OCR toggle (only when PDF + OCR engine)
*   │       ├── label.checkbox_label > input[type=checkbox]  — enable/disable OCR
*   │       └── label.combobox_label > select                — OCR language picker
*   ├── div.progress_bar_container             — XHR upload progress (see render_progress_bar)
*   ├── div.response_container
*   │   └── div.response_msg                   — success / error message after upload
*   ├── span.button.info                       — toggles the diagnostic panel
*   └── div.info_container (hidden by default) — diagnostic panel (see render_info)
*
* Side effects:
*   Sets self.process_options, self.form, self.progress_bar_container,
*   self.progress_info, self.progress_line, self.response_msg.
*   (render_filedrag also sets self.filedrag.)
*
* @param {Object} self - The service_upload instance.
* @returns {HTMLElement} The assembled content_data div.
*/
export const get_content_data = function(self) {

	const fragment = new DocumentFragment();

	// Initialise process_options before the OCR controls below can reference it.
	// These are forwarded to the server via the 'upload_file_done_' event payload
	// (see service_upload.prototype.upload_file) so the server-side post-processor
	// knows whether to run OCR and in which language.
	self.process_options = {
		ocr			: false,
		ocr_lang	: null
	}

	// form
		const form = ui.create_dom_element({
			element_type	: 'form',
			id				: 'form_upload',
			parent			: fragment
		})
		form.name		= 'form_upload'
		form.enctype	= 'multipart/form-data'
		form.method		= 'post'
		// fix form
		// Stored on self so tools that wrap this service (e.g. tool_import) can
		// inspect or reset form fields without traversing the DOM.
		self.form		= form

	// input_file
		// The <input type="file"> is the native browser file picker.  It is visually
		// hidden; the filedrag label (rendered below) is its <label for="file_to_upload">
		// counterpart so clicking the label opens the file dialog.
		const input_file = ui.create_dom_element({
			element_type	: 'input',
			type			: 'file',
			id				: 'file_to_upload',
			parent			: form
		})
		input_file.addEventListener('change',function() {

			const file = this.files[0] || null
			if (!file) {
				return false
			}

			file_selected(self, file)
		})
		// Build the `accept` attribute from the server-configured allowed_extensions
		// so the OS file picker pre-filters to only matching file types.
		input_file.accept = self.allowed_extensions.map((ext) => {return '.'+ext}).join(", ");

	// filedrag (add node to form)
		const filedrag = render_filedrag(self)
		form.appendChild(filedrag)

	// file_info
		// Placeholder div for optional status text injected by callers or future
		// functionality.  Currently rendered empty.
		ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'file_info',
			text_content	: '',
			parent			: form
		})


	// OCR options — only shown when the upload accepts PDF files AND the server has
	// an OCR engine configured (self.pdf_ocr_engine is truthy).
	// The OCR checkbox and language selector update self.process_options so that
	// after upload the server knows whether to start an OCR pipeline and which
	// language model to use.
	if(self.allowed_extensions.includes('pdf') && self.pdf_ocr_engine) {

		// OCR_options
			const ocr_options_container = ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'ocr_options_container',
				parent			: form
			})

		// checkbox_label
			const checkbox_label = ui.create_dom_element({
				element_type	: 'label',
				class_name		: 'label checkbox_label',
				inner_html		: 'OCR',
				parent			: ocr_options_container
			})

		// input checkbox
			const checkbox_input = ui.create_dom_element({
				element_type	: 'input',
				type			: 'checkbox',
				name			: 'checkbox_active'
			})

			checkbox_label.prepend(checkbox_input)

			checkbox_input.addEventListener('click', function(e) {
				e.stopPropagation()

				// Mirror the checkbox state into process_options so the upload handler
				// can pass it to the server-side OCR post-processor.
				self.process_options.ocr = checkbox_input.checked
			})

		// combobox_label
			const combobox_label = ui.create_dom_element({
				element_type	: 'label',
				class_name		: 'label combobox_label',
				inner_html		: get_label.language || 'Language',
				parent			: ocr_options_container
			})

		// input combobox
			const combobox_input = ui.create_dom_element({
				element_type	: 'select',
				name			: 'combobox_active'
			})

			combobox_label.prepend(combobox_input)

		// input Languages (from dedalo config)
			// page_globals.dedalo_application_langs is a window-level array injected by
			// the PHP template.  Each entry has shape {value: string, label: string}.
			// (!) page_globals is NOT listed in the /*global*/ declaration at the top of
			//     this file; ESLint will report a no-undef error on this line.
			page_globals.dedalo_application_langs.forEach((lang) => {
				ui.create_dom_element({
					element_type	: 'option',
					value			: lang.value,
					text_content	: lang.label,
					parent			: combobox_input
				});
			});

			// (!) The event type is 'click' instead of 'change'.  Using 'click' means
			//     the value is updated only on mouse interaction; keyboard navigation
			//     through the <select> options does NOT trigger the handler until the
			//     user clicks.  Consider changing to 'change' in a future pass.
			combobox_input.addEventListener('click', function(e) {
				self.process_options.ocr_lang = combobox_input.value;
			})
	}

	// progress_bar_container
		// Appended to the fragment (not to the form) so it sits outside the upload
		// form and remains visible even after a form reset.
		const progress_bar_container = render_progress_bar(self)
		fragment.appendChild(progress_bar_container)
		// fix progress_bar_container
		self.progress_bar_container = progress_bar_container

	// response_container
		const response_container = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'response_container',
			parent			: fragment
		})

	// response_msg
		// After each upload attempt file_selected writes a success or failure message
		// into this element and toggles 'success'/'failed' CSS classes.
		const response_msg = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'response_msg',
			parent			: response_container
		})
		// fix
		self.response_msg = response_msg

	// info
		// button_info
		// Clicking toggles the info_container visibility.  The info panel starts
		// hidden so it does not clutter the default upload UI.
		const button_info = ui.create_dom_element({
			element_type	: 'span',
			class_name		: 'button info',
			parent			: fragment
		})
		button_info.addEventListener('click', function(){
			info_node.classList.toggle('hide')
		})
		const info_node = render_info(self)
		info_node.classList.add('hide')
		fragment.appendChild(info_node)

	// content_data
		const content_data = document.createElement('div')
			  content_data.classList.add('content_data')
			  content_data.appendChild(fragment)


	return content_data
}//end get_content_data



/**
* RENDER_INFO
* Builds the collapsible diagnostic panel toggled by the info button in
* get_content_data.  The panel renders as a label/value grid via CSS and surfaces
* the server-side upload constraints that were fetched during service_upload.build:
*   - Caller component model name.
*   - Target media quality (from caller context.features, if present).
*   - Allowed file extensions.
*   - Maximum upload size in MB (highlighted with CSS 'warning' when < 100 MB).
*   - Chunk file size in MB, or the JSON representation of the falsy value when
*     chunking is disabled (null/0/false).
*   - PHP sys_get_temp_dir() path.
*   - Configured upload_tmp_dir path.
*   - Upload temp directory octal permissions string.
*   - Session cache expiry in Days (when > 24 h) or Hours, plus the raw minute
*     count in brackets for precision.
*   - An editable number input that lets the user tune self.max_concurrent at
*     runtime without reloading (change takes effect on the next upload).
*
* @param {Object} self - The service_upload instance.
* @returns {HTMLElement} The info div (class 'info_container'); NOT yet appended.
*/
export const render_info = function(self) {

	// container info
		const info = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'info_container '
		})

	// caller component
		ui.create_dom_element({
			element_type	: 'label',
			inner_html		: 'Caller',
			parent			: info
		})
		ui.create_dom_element({
			element_type	: 'div',
			inner_html		: self.caller.model,
			parent			: info
		})

	// target quality
		// context.features may be absent when the caller is a plain tool rather than a
		// component with a full context object.  The ternary guards against that case.
		const target_quality = self.caller.context.features
			? self.caller.context.features.target_quality || self.caller.context.features.default_target_quality
			: null
		if (target_quality) {
			ui.create_dom_element({
				element_type	: 'label',
				inner_html		: 'Target quality',
				parent			: info
			})
			ui.create_dom_element({
				element_type	: 'div',
				inner_html		: target_quality,
				parent			: info
			})
		}

	// allowed extensions
		ui.create_dom_element({
			element_type	: 'label',
			inner_html		: 'Allowed extensions',
			parent			: info
		})
		ui.create_dom_element({
			element_type	: 'div',
			text_content	: self.allowed_extensions.join(", "),
			parent			: info
		})

	// max file size upload file size
		// Converts bytes to MB; the 'warning' CSS class is applied when the limit is
		// below 100 MB to alert administrators that PHP's upload_max_filesize may
		// block large file submissions.
		const max_mb = Math.floor(self.max_size_bytes / (1024*1024))
		ui.create_dom_element({
			element_type	: 'label',
			inner_html		: 'Max file size',
			parent			: info
		})
		ui.create_dom_element({
			element_type	: 'div',
			class_name		: (max_mb < 100) ? 'warning' : '',
			text_content	: max_mb.toLocaleString() + ' MB',
			parent			: info
		})

	// DEDALO_UPLOAD_SERVICE_CHUNK_FILES
		// self.upload_service_chunk_files mirrors the server constant
		// DEDALO_UPLOAD_SERVICE_CHUNK_FILES (MB per chunk, set in config.php).
		// When chunking is disabled it is falsy (0 / null / false); JSON.stringify
		// makes the disabled state explicit in the UI rather than showing an empty div.
		ui.create_dom_element({
			element_type	: 'label',
			inner_html		: 'Chunk files size',
			parent			: info
		})
		const chunk_text = self.upload_service_chunk_files
			? self.upload_service_chunk_files + ' MB'
			: JSON.stringify(self.upload_service_chunk_files)
		ui.create_dom_element({
			element_type	: 'div',
			text_content	: chunk_text,
			parent			: info
		})

	// sys_get_temp_dir
		ui.create_dom_element({
			element_type	: 'label',
			inner_html		: 'System temp dir',
			parent			: info
		})
		ui.create_dom_element({
			element_type	: 'div',
			text_content	: self.sys_get_temp_dir,
			parent			: info
		})

	// upload_tmp_dir
		ui.create_dom_element({
			element_type	: 'label',
			inner_html		: 'User upload tmp dir',
			parent			: info
		})
		ui.create_dom_element({
			element_type	: 'div',
			text_content	: self.upload_tmp_dir,
			parent			: info
		})

	// upload_tmp_perms
		ui.create_dom_element({
			element_type	: 'label',
			inner_html		: 'User upload tmp perms',
			parent			: info
		})
		ui.create_dom_element({
			element_type	: 'div',
			text_content	: self.upload_tmp_perms,
			parent			: info
		})

	// session_cache_expire
		// self.session_cache_expire is in minutes.  Display in Days when the value
		// exceeds 24 * 60 = 1440 minutes, otherwise in Hours.  The raw minute count
		// is always shown in brackets for precise reference.
		const session_cache_expire = (self.session_cache_expire / 60) > 24
			? (self.session_cache_expire / (60 * 24)).toLocaleString() + ' Days'
			: (self.session_cache_expire / 60).toLocaleString() + ' Hours'
		ui.create_dom_element({
			element_type	: 'label',
			inner_html		: 'Session cache expire',
			parent			: info
		})
		ui.create_dom_element({
			element_type	: 'div',
			text_content	: session_cache_expire + ' [' + self.session_cache_expire.toLocaleString() + ' minutes]',
			parent 			: info
		})


	// Max simultaneous request
		// when this param is change in the interface, the upload will set its value as a limit of open connections
		// This live-edit input lets administrators reduce concurrency on slow servers
		// without a page reload.  The change handler writes directly to self.max_concurrent
		// which the upload queue (in service_upload.js upload()) reads before opening
		// each new connection.
		ui.create_dom_element({
			element_type	: 'label',
			inner_html		: 'Max simultaneous request',
			parent			: info
		})
		const max_concurrent_input = ui.create_dom_element({
			element_type	: 'input',
			type 			: 'number',
			value			: self.max_concurrent,
			parent			: info
		})
		const change_concurrent_handler = function() {
			self.max_concurrent = parseInt( max_concurrent_input.value )
		}
		max_concurrent_input.addEventListener('change', change_concurrent_handler)


	return info
}//end render_info



/**
* RENDER_FILEDRAG
* Builds the drag-and-drop drop target: a <label for="file_to_upload"> element
* that visually represents the upload zone.  Because it is a <label> linked to the
* hidden file input by the `for` attribute, clicking anywhere on it also opens the
* native file dialog.
*
* The element handles three DOM events:
*   dragover  — forwards to file_drag_hover (adds 'hover' class).
*   dragleave — forwards to file_drag_hover (removes 'hover' class).
*   drop      — cancels hover styling, extracts the first dropped file, and calls
*               file_selected; only the first file is processed (single-upload
*               semantics; the multi-file loop code is commented out).
*
* Side effects: sets self.filedrag to the created element.
*
* @param {Object} self - The service_upload instance.
* @returns {HTMLElement} The filedrag label element (not yet appended to the DOM).
*/
export const render_filedrag = function(self) {

	// filedrag node
		// The element is a <label> rather than a <div> so that clicking it natively
		// activates the associated <input type="file" id="file_to_upload">.
		const filedrag = ui.create_dom_element({
			element_type	: 'label',
			class_name		: 'filedrag'
			// text_content	: 'Select a file to upload or drop it here', // get_label.select_a_file ||
			// parent		: form
		})
		filedrag.setAttribute('for','file_to_upload')
		filedrag.addEventListener("dragover", file_drag_hover, false);
		filedrag.addEventListener("dragleave", file_drag_hover, false);
		filedrag.addEventListener("drop", function(e){

			// cancel event and hover styling
			file_drag_hover(e);

			// fetch FileList object
			const files = e.target.files || e.dataTransfer.files;

			// process all File objects
			// for (let i = 0; i < files.length; i++) {

				// const file = files[i]

				// parse file info
				// parse_local_file(file);

				// Only the first dropped file is processed; service_upload is a
				// single-file uploader.  The commented-out loop above is leftover
				// scaffolding from an earlier multi-file design.
				const file = files[0] || null
				if (!file) {
					return false
				}

				file_selected(self, file)

				// break; // only one is allowed
			// }
		})
		// fix
		self.filedrag = filedrag

	// label icon
		// The icon SVG is served from the service's own img directory under
		// DEDALO_CORE_URL so each service can have its own branded upload icon.
		ui.create_dom_element({
			element_type	: 'img',
			src				: DEDALO_CORE_URL + '/services/' + self.model + '/img/icon.svg',
			parent			: filedrag
		})

	// label text
		// The note span lists allowed extensions inline so the user can see what
		// file types are accepted without opening the info panel.
		const filedrag_label = ui.create_dom_element({
			element_type	: 'span',
			class_name		: '',
			text_content	: 'Select or drop a file here ',
			parent			: filedrag
		})
		// the note is an ELEMENT; the extension list is server config text (DS-1)
		ui.create_dom_element({
			element_type	: 'span',
			class_name		: 'note',
			text_content	: '[' + self.allowed_extensions.join(',') + ']',
			parent			: filedrag_label
		})

	// filedrag
		// const filedrag = ui.create_dom_element({
		// 	element_type	: 'div',
		// 	class_name		: 'filedrag',
		// 	text_content 	: 'or drop a file here',
		// 	parent 			: form
		// })


	return filedrag
}//end render_filedrag



/**
* FILE_SELECTED
* Orchestrates the upload flow when the user selects a file via the native file
* dialog or drops one onto the filedrag zone.  This is the single call-site that
* bridges the UI layer to service_upload.prototype.upload_file, which handles
* extension validation, size checking, chunking, XHR, and server-side post-
* processing.
*
* Flow:
*   1. Add 'loading_file' class to filedrag (CSS shows spinner / dims zone).
*   2. Await self.upload_file({file}) — may take seconds/minutes for large files.
*   3. Remove 'loading_file' class to restore the drag zone.
*   4. Clear previous success/failed classes from response_msg.
*   5. Write the result message and apply the appropriate CSS class.
*
* The function is async because upload_file itself is async (chunked XHR chain).
*
* @param {Object} self - The service_upload instance.
* @param {File} file - The native File object from the input or DataTransfer.
* @returns {Promise<Object>} The API response object from service_upload.upload_file.
*   Shape: { result: boolean, msg?: string, file_data?: Object }.
*/
export const file_selected = async function(self, file) {

	self.filedrag.classList.add('loading_file')

	// upload file to server
		const response = await self.upload_file({
			file : file
		})

	// show filedrag again
		self.filedrag.classList.remove('loading_file')

	// reset classes
		// Remove both outcome classes before applying the new one to avoid stale
		// state when the user uploads multiple files in the same session.
		self.response_msg.classList.remove('failed')
		self.response_msg.classList.remove('success')

	// on finish actions
		// The failure sentence comes from the ONE renderer (the coded error in the
		// curator's language) and reaches the DOM as TEXT, never parsed as HTML
		// (DS-1).
		if (!request_failed(response) && response_data(response)===true) {
			self.response_msg.textContent = 'OK. File uploaded'
			self.response_msg.classList.add('success')

		}else{
			self.response_msg.textContent = request_failed(response)
				? error_text(response.error)
				: 'Error on upload file'
			self.response_msg.classList.add('failed')
		}


	return response
}//end file_selected



/**
* RENDER_PROGRESS_BAR
* Builds the XHR upload progress container with two sub-elements:
*   progress_info  — a <div> that receives human-readable status text such as
*                    "Loading file foo.pdf" or "Upload progress: 42 %".
*                    Driven by the 'upload_file_status_' event handler in
*                    service_upload.prototype.init.
*   progress_line  — an HTML5 <progress> element (max=100, initial value=0)
*                    whose value is updated on each upload progress tick.
*
* Both elements are stored on `self` so the event handler installed in
* service_upload.init can update them without a DOM query.
*
* Note: the parameter name in the original stub doc-block was 'options' but the
* function only accepts `self`.  The doc-block has been corrected here.
*
* @param {Object} self - The service_upload instance.
* @returns {HTMLElement} The progress_bar_container div (not yet appended).
*/
export const render_progress_bar = function(self) {

	// progress_bar_container
		const progress_bar_container = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'progress_bar_container'
		})

	// progress_info
		const progress_info = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'progress_info',
			parent 			: progress_bar_container
		})
		// fix
		self.progress_info = progress_info

	// progress_line
		const progress_line = ui.create_dom_element({
			element_type	: 'progress',
			class_name		: 'progress_line',
			parent 			: progress_bar_container
		})
		progress_line.max   = 100;
		progress_line.value = 0;
		// fix
		self.progress_line = progress_line


	return progress_bar_container
}//end render_progress_bar



/**
* FILE_DRAG_HOVER
* Shared dragover/dragleave event handler for the filedrag zone.  Cancels the
* default browser drag behaviour (which would otherwise navigate to the dropped
* URL), and toggles the 'hover' CSS class on the event target to provide visual
* feedback while a file is dragged over the zone.
*
* Called directly as an event listener from render_filedrag for both 'dragover'
* and 'dragleave' events.
*
* Note: the original doc-block had '@return' without braces.  Corrected to
* '@returns {boolean}'.
*
* @param {DragEvent} e - The native dragover or dragleave DOM event.
* @returns {boolean} Always true (signals that the handler ran without error).
*/
export const file_drag_hover = function(e) {

	e.stopPropagation();
	e.preventDefault();

	if (e.type==="dragover") {
		e.target.classList.add("hover")
	}else{
		e.target.classList.remove("hover")
	}

	return true
}//end file_drag_hover



// @license-end
