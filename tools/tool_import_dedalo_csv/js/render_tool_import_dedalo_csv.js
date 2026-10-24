// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_tool_label, page_globals, SHOW_DEBUG, DEDALO_CORE_URL, tool_import_dedalo_csv */
/*eslint no-undef: "error"*/



// imports
	import {validate_tipo} from '../../../core/common/js/common.js'
	import {append_text_lines} from '../../../core/common/js/utils/index.js'
	import {ui} from '../../../core/common/js/ui.js'
	import {data_manager} from '../../../core/common/js/data_manager.js'
	import {request_failed, response_data} from '../../../core/common/js/api_error.js'
	import {error_text} from '../../../core/common/js/render_api_error.js'
	import {handle_api_error} from '../../../core/common/js/error_dispatch.js'
	import {get_section_tipo_candidates} from './section_tipo_from_file_name.js'



/**
* RENDER_TOOL_IMPORT_DEDALO_CSV
* Client-side render controller for the CSV import tool.
*
* This module provides the DOM-building layer for tool_import_dedalo_csv. Its
* prototype methods are mixed into the tool class in tool_import_dedalo_csv.js
* via direct prototype assignment, following the Dédalo render-file pattern.
*
* Exported functions:
* - render_tool_import_dedalo_csv  (constructor, mixed into the tool class)
* - render_tool_import_dedalo_csv.prototype.edit        – builds the full edit wrapper
* - render_tool_import_dedalo_csv.prototype.upload_done – called when a file upload finishes
*
* Private helpers (module-scoped, not exported):
* - render_service_upload    – (re-)renders the drag-and-drop upload zone
* - get_content_data         – builds the main tool body (file list + submit controls)
* - render_file_info         – renders one CSV file card with column mapper
* - render_columns_mapper    – async; fetches component list and renders column-mapping UI
* - follow_import_job        – subscribes to the job's PUSH event stream (get_job_events)
* - render_progress_node     – the live panel: progress bar + record/component + counters
* - render_final_report      – renders each file's ImportFileReport (created / updated / failed / warnings)
* - check_process_data       – re-attaches to a running (or just-finished) import after a reload
*
* Data shapes consumed by this module:
*
* csv_files_list item (one entry per uploaded CSV file, returned by load_csv_files_list):
* {
*   name              : string   – filename, e.g. 'exported_oral-history_-1-oh1.csv'
*   dir               : string   – server-side directory path
*   n_records         : number   – number of data rows (excluding header)
*   n_columns         : number   – number of columns
*   file_info         : string[] – column names (first row of the CSV)
*   sample_data       : Array[]  – up to 10 parsed DATA rows for preview, never the header (each an array of cell values)
*   sample_data_errors: Object[] – JSON parse errors found in sample rows (empty if OK)
*   ar_columns_map    : Object[] – per-column map: { tipo, model, label, checked, map_to, decimal?, import_mode? }
*   section_tipo      : string   – auto-detected or user-supplied target section tipo (e.g. 'oh1')
*   section_label     : string   – resolved section label (set by render_columns_mapper)
*                       import_mode: 'replace' | 'append' — absent means 'replace'
*                       (the server default); only set on columns whose target
*                       component has an import_append policy
*   bulk_process_label: string   – editable title for the bulk-process tracking record
*   checked           : boolean  – whether the file checkbox is selected for import
*   result_container  : HTMLElement – injected by render_file_info; render_final_report writes here
* }
*
* import_files API response (api_response inside fn_import .then):
* {
*   result : boolean  – true when the background job was queued successfully
*   job_id : string   – THE handle: dd_utils_api::get_job_events subscribes to it and
*                       pushes every state change (progress frames, then the report).
* }
*
* The progress/report wire is typed in src/core/tools/import_wire.ts —
* ImportProgressFrame while it runs, ImportBatchReport on the terminal frame.
*/
export const render_tool_import_dedalo_csv = function() {

	return true
}//end render_tool_import_dedalo_csv



/**
* EDIT
* Render tool DOM nodes
* This function is called by render common attached in 'tool_import_dedalo_csv.js'
* @param {Object} options
* @param {string} [options.render_level='full'] - 'full' builds the entire wrapper;
*   'content' rebuilds only the body (content_data) and re-attaches service_upload.
* @returns {HTMLElement} wrapper (full render) or content_data node (content render)
*/
render_tool_import_dedalo_csv.prototype.edit = async function(options) {

	const self = this

	// options
		const render_level = options.render_level || 'full'

	// content_data
		const content_data = await get_content_data(self)
		if (render_level==='content') {
			// Content-level refresh: edit() returns before the service_upload block below,
			// but refresh() already destroyed and rebuilt the service_upload dependency.
			// Re-attach the fresh instance to its persistent container so the drop/select
			// file zone keeps working after import or remove (otherwise it stays visible
			// but dead, as its drag & drop listeners were torn down on destroy).
			if (self.service_upload_container) {
				render_service_upload(self)
			}
			return content_data
		}

	// wrapper. ui build_edit returns a standard built tool wrapper
		const wrapper = ui.tool.build_wrapper_edit(self, {
			content_data : content_data
		})
		// set pointers
		wrapper.content_data = content_data

	// service_upload
		// Use the service_upload to get and render the button to upload the file,
		// get functionality defined (drag, drop, create folder, etc..)
		// service_upload_container
		const service_upload_container = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'service_upload_container'
		})
		wrapper.tool_header.after(service_upload_container)
		// store pointer to the persistent container so content-level refreshes can
		// re-attach the rebuilt service_upload instance (see render_service_upload)
		self.service_upload_container = service_upload_container
		// service_upload. Build and render into its container
		render_service_upload(self)


	return wrapper
}//end edit



/**
* RENDER_SERVICE_UPLOAD
* Builds and renders the service_upload (drop/select file) component into the
* persistent service_upload_container, replacing any previous node.
* Used both on the initial full render and on content-level refresh: refresh()
* destroys and rebuilds the service_upload dependency but edit() returns early
* for 'content' renders, so without re-rendering here the drop zone would stay
* visible yet dead (its drag & drop listeners removed on destroy).
* @param {Object} self - tool_import_dedalo_csv instance
* @returns {void}
*/
const render_service_upload = function(self) {

	const service_upload_container = self.service_upload_container
	if (!service_upload_container) {
		return
	}

	// clean previous node (refresh case)
		while (service_upload_container.firstChild) {
			service_upload_container.removeChild(service_upload_container.firstChild)
		}

	// spinner
		const spinner = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'spinner',
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
}//end render_service_upload



/**
* GET_CONTENT_DATA
* Builds and returns the main tool body as a content_data wrapper element.
*
* The content_data node contains:
*   - process_file    – transient upload-progress indicator (spinner + status text)
*   - user_msg_container – reserved for user-facing messages
*   - files_list      – one render_file_info card per uploaded CSV file
*   - submit_container – import button
*   - process_info_container – SSE progress display (hidden until import starts)
*
* Also triggers check_process_data so that a previously-started import that was
* interrupted (e.g. page reload) is automatically resumed.
*
* @param {Object} self - tool_import_dedalo_csv instance
* @returns {Promise<HTMLElement>} content_data wrapper element
*/
const get_content_data = async function(self) {

	// DocumentFragment
		const fragment = new DocumentFragment()

	// process_file
		const process_file = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'process_file',
			parent			: fragment
		})
		self.process_file = process_file

	// user_msg_container
		const user_msg_container = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'user_msg_container',
			parent			: fragment
		})
		self.user_msg_container = user_msg_container

	// files_list
		const files_list = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'files_list',
			parent			: fragment
		})
		const csv_files_list_length = self.csv_files_list.length
		for (let i = 0; i < csv_files_list_length; i++) {
			const item		= self.csv_files_list[i]
			const file_info	= render_file_info(self, item)
			files_list.appendChild(file_info)
		}

	// submit_container
		const submit_container = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'submit_container',
			parent			: fragment
		})

	// fn_import
		// Arrow function (not a method) capturing submit_container DOM references.
		// Validates that at least one file is checked, builds the files payload, and
		// calls self.import_files(). On success it starts the SSE progress poll.
		const fn_import = (e) => {
			e.stopPropagation()

			// selected files
				const selected_files = self.csv_files_list.filter(el => el.checked===true)
				if (selected_files.length<1) {
					// (!) alert() is intentional UI feedback here; not an error dialog.
					alert( self.get_tool_label('select_a_file') || 'Select a file');
					return
				}

			// loading
				// const loading_items = (SHOW_DEBUG === true)
				// 	? [content_data, process_info_container]
				// 	: [content_data]
				// loading_items.map((el)=>{
				// 	// el.classList.add('loading')
				// 	if (el.classList.contains('hide')) {
				// 		el.classList.remove('hide')
				// 	}
				// })

			// blur button
				document.activeElement.blur()

			// array of file names
				// Build the stripped-down file descriptor that the server expects.
				// ar_columns_map objects follow the shape: { tipo, model, label, checked, map_to, decimal?, import_mode? }
				// import_mode ('replace'|'append') is only present on columns whose
				// target accepts append; absent = 'replace' on the server.
				const files = selected_files.map(el => {
					return {
						file				: el.name, // string like 'exported_oral-history_-1-oh1.csv'
						section_tipo		: el.section_tipo, // string like 'oh1'
						ar_columns_map		: el.ar_columns_map, // array of objects like [{checked: false, label: "", mapped_to: "", model: "", tipo: "section_id"}]
						bulk_process_label	: el.bulk_process_label // name of the process fired, it could be changed by user.
					}
				})

			// import_files
				// No time-machine switch: every CSV import runs under a bulk id, and a
				// save carrying a bulk id ALWAYS writes its undo pair (a hidden BEFORE
				// row + the normal visible after-row), so the run is revertible exactly
				// (WC-2026-09-27-bulk-revert-undo-log, decision D1).
				self.import_files(files)
				.then(async function(api_response){
					if(SHOW_DEBUG===true) {
						console.log(')) import_files api_response:', api_response)
					}
					// failure. ONE error model: before this a refused import was
					// completely silent — the button simply did nothing.
					if (request_failed(api_response)) {
						console.error('import_files failed:', api_response.error)
						await handle_api_error(api_response.error, {wrapper: process_info_container})
						return
					}
					if(response_data(api_response)===true && api_response.job_id){
						// The job runs in the server process we are talking to, so its id is
						// the whole handle: subscribe and every state change is PUSHED to us.
						follow_import_job({
							self					: self,
							job_id					: api_response.job_id,
							button_submit			: import_button,
							process_info_container	: process_info_container
						})
					}
				})//end .then(function(api_response)
		}//end fn_import

	// import_button
		const import_button = ui.create_dom_element({
			element_type	: 'button',
			class_name		: 'warning import_button csv',
			inner_html		: self.get_tool_label('import') || 'Import',
			parent			: submit_container
		})
		import_button.addEventListener('click', fn_import)

	// process_info_container
		// Hidden until import_files returns a job_id; shown by follow_import_job.
		const process_info_container = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'process_info_container hide',
			parent			: fragment
		})

	// check if the process is active
		check_process_data({
			self					: self,
			button_submit			: import_button,
			process_info_container	: process_info_container

		})

	// content_data
		const content_data = ui.tool.build_content_data(self)
		content_data.appendChild(fragment)


	return content_data
}//end get_content_data



/**
* AUDIT_COLUMN_TIPOS
* The section's audit components (created/modified by/date: dd200, dd199,
* dd197, dd201 — src/core/concepts/section.ts). The engine stamps them; an
* import column mapped to one of them is never offered append mode. The
* server refuses it too (by tipo), this only keeps the UI honest.
*/
const AUDIT_COLUMN_TIPOS = ['dd197', 'dd199', 'dd200', 'dd201']



/**
* IMPORT_MODE_ALLOWED
* Whether a mapped column may offer the replace/append mode selector.
* @param {Object|null} column_map - one ar_columns_map entry
* @param {string|null} policy - the target component's import_append policy
*   ('items' | 'geo_layer' | 'text_paragraphs'), null when append is refused
* @returns {boolean}
*/
export const import_mode_allowed = function(column_map, policy) {

	if (!column_map || typeof policy!=='string' || policy.length<1) {
		return false
	}
	// the record key column: matched on, never written as a component
	if (column_map.tipo==='section_id'
		|| column_map.model==='section_id'
		|| column_map.model==='component_section_id') {
		return false
	}
	// an audit column (by target tipo)
	if (AUDIT_COLUMN_TIPOS.includes(column_map.map_to)) {
		return false
	}

	return true
}//end import_mode_allowed



/**
* DATALIST_COUNTER
* Unique suffix for each file card's section_tipo datalist id.
*/
let datalist_counter = 0



/**
* RENDER_FILE_INFO
* Renders a single file card for one uploaded CSV file.
*
* Each card contains:
*   - A checkbox to select the file for import (toggles item.checked)
*   - An editable section_tipo input with live validation via update_section_warn()
*   - A delete button (calls self.remove_file + self.refresh)
*   - Record/column summary info text
*   - An editable bulk_process_label field
*   - A preview toggle showing raw sample_data or parse errors as <pre>
*   - A columns_mapper div populated asynchronously by render_columns_mapper()
*   - A result_container div written into later by render_final_report()
*
* The nested update_section_warn() is called immediately on construction and on
* every keyup in the section_tipo input. It validates the tipo, clears and
* rebuilds the columns_mapper, and updates section_label. On invalid input it
* shows a warning and focuses the input after a short delay.
*
* @param {Object} self - tool_import_dedalo_csv instance
* @param {Object} item - one entry from self.csv_files_list (shape documented in module header)
* @returns {HTMLElement} item_wrapper – the assembled card node
*/
const render_file_info = function(self, item) {

	const fragment = new DocumentFragment()

	// file_line
		const file_line = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'file_line',
			parent			: fragment
		})

		// icon file
			const button_csv = ui.create_dom_element({
				element_type	: 'span',
				class_name		: 'button csv',
				parent			: file_line
			})

		// checkbox
			const checkbox_label = ui.create_dom_element({
				element_type	: 'label',
				class_name		: 'checkbox_label',
				text_content	: item.name,
				parent			: file_line
			})
			const checkbox_file_selection = ui.create_dom_element({
				element_type	: 'input',
				type			: 'checkbox',
				value			: item.dir + '/' + item.name,
				class_name		: ''
			})
			checkbox_file_selection.addEventListener("change", function(){
				item.checked = checkbox_file_selection.checked ? true : false
				button_csv.classList.toggle('active')
				arrow_right.classList.toggle('active')
			})
			checkbox_label.prepend(checkbox_file_selection)

		// icon arrow_right >
			const arrow_right = ui.create_dom_element({
				element_type	: 'span',
				class_name		: 'icon arrow_right',
				parent			: file_line
			})

		// section_tipo
			// Resolution order:
			//   1. the user's manual correction for this file name, remembered in this browser
			//   2. the guess from the file name: the last word with the tipo grammar
			//      e.g. 'export_Ceca_07-10-2026-numisdata6-raw.csv' → 'numisdata6'
			//   3. the caller's own tipo
			// Every tipo-shaped word of the name is offered in a datalist, so an
			// ambiguous name is fixed with one pick.
			const candidates			= get_section_tipo_candidates(item.name)
			const detected_section_tipo	= candidates.length ? candidates[candidates.length - 1] : null
			const default_section_tipo	= detected_section_tipo || self.caller.tipo
			const remembered			= self.section_tipo_corrections?.[item.name]
			const section_tipo			= remembered || default_section_tipo

			const section_tipo_label = ui.create_dom_element({
				element_type	: 'label',
				class_name		: 'section_tipo_label',
				inner_html		: 'section tipo',
				parent			: file_line
			})
			const input_section_tipo = ui.create_dom_element({
				element_type	: 'input',
				type			: 'text',
				value			: section_tipo,
				class_name		: 'input_section_tipo',
				parent			: section_tipo_label
			})
			// candidates datalist (browser-native suggestions)
			const datalist_values = [...new Set([...candidates, self.caller.tipo].filter(Boolean))]
			if (datalist_values.length>1) {
				const datalist_id = 'section_tipo_candidates_' + (++datalist_counter)
				const datalist = ui.create_dom_element({
					element_type	: 'datalist',
					id				: datalist_id,
					parent			: section_tipo_label
				})
				for (const value of datalist_values) {
					ui.create_dom_element({
						element_type	: 'option',
						value			: value,
						parent			: datalist
					})
				}
				input_section_tipo.setAttribute('list', datalist_id)
			}
			// remembered mark. Visible while a manual correction is stored; click forgets it
			const remembered_mark = ui.create_dom_element({
				element_type	: 'button',
				type			: 'button',
				class_name		: 'section_tipo_remembered' + (remembered ? '' : ' hide'),
				text_content	: self.get_tool_label('remembered') || 'remembered',
				title			: self.get_tool_label('remembered_title') || 'Saved in this browser for this file name. Click to forget it',
				parent			: section_tipo_label
			})
			remembered_mark.addEventListener('click', function(e){
				e.preventDefault()
				e.stopPropagation()
				self.save_section_tipo_correction(item.name, null, detected_section_tipo)
				remembered_mark.classList.add('hide')
				input_section_tipo.value	= default_section_tipo
				item.section_tipo			= default_section_tipo
				update_section_warn()
			})
			item.section_tipo = section_tipo // assign to item
			// 'input' (not keyup): a datalist pick fires no key event
			input_section_tipo.addEventListener('input', function(){
				item.section_tipo = input_section_tipo.value.trim() // update item value
				update_section_warn()
			})
			// remember a valid manual value (debounced: one write per pause, not per key)
			let save_timer = null
			const remember_section_tipo = function() {
				clearTimeout(save_timer)
				save_timer = setTimeout(function(){
					self.save_section_tipo_correction(item.name, item.section_tipo, detected_section_tipo)
					.then(function(){
						const is_remembered = !!self.section_tipo_corrections?.[item.name]
						remembered_mark.classList.toggle('hide', !is_remembered)
					})
				}, 400)
			}
			function update_section_warn() {

				// clean columns_maper
				while (columns_maper.firstChild) {
					columns_maper.removeChild(columns_maper.firstChild);
				}

				// section_label reset
				section_label.textContent = ''

				// validate
				const valid_section_tipo = validate_tipo(item.section_tipo)
				if (!valid_section_tipo) {
					section_warn.classList.remove('hide')
					if (!item.section_tipo || !item.section_tipo.length) {
						// SEC-031: textContent prevents HTML injection from filename-derived section_tipo.
						section_warn.textContent = `The section tipo seems to be empty. Please, fill in the target section_tipo`
					}else{
						section_warn.textContent = `Auto-detected file name section tipo "${item.section_tipo}" seems to be invalid.`
					}
					setTimeout(function(){
						input_section_tipo.focus()
					}, 500)
				}else{
					section_warn.classList.add('hide')
					columns_maper.classList.add('loading')

					// remember the value when it is a manual correction
					remember_section_tipo()

					// render again columns_maper
					render_columns_mapper(self, item)
					.then(function(columns_list){
						while (columns_maper.firstChild) {
							columns_maper.removeChild(columns_maper.firstChild);
						}
						columns_maper.appendChild(columns_list)

						// section_label (SEC-031: textContent)
						section_label.textContent = item.section_label || ''

						bulk_process_label.value = self.context.label
						bulk_process_label.dispatchEvent(new Event('input'));

						columns_maper.classList.remove('loading')
					})
				}
			}//end update_section_warn

			// section_label
				ui.create_dom_element({
					element_type	: 'span',
					class_name		: 'section_name',
					inner_html		: 'section name:',
					parent			: section_tipo_label
				})
				const section_label = ui.create_dom_element({
					element_type	: 'span',
					class_name		: 'section_label',
					text_content	: item.section_label || 'XX',
					parent			: section_tipo_label
				})

		// icon delete
			const icon_delete = ui.create_dom_element({
				element_type	: 'span',
				class_name		: 'button delete',
				parent			: file_line
			})
			icon_delete.addEventListener('click', function(e){
				e.stopPropagation()

				if(confirm(self.get_tool_label('sure') || 'Sure?')) {
					// remove file
					self.remove_file(item)
					.then(function(){
						self.refresh()
					})
				}
			})

	// section_tipo input
		const section_warn = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'warning error hide',
			parent			: fragment
		})
		// update_section_warn()

	// info
		const info_container = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'info_container',
			parent			: fragment
		})
		// const info_text = `Records: ${item.n_records} - Columns: ${item.n_columns} - Header:<br><span class="columns">` + item.file_info.join(', ') + '</span>'
		const info_text = `${self.get_tool_label('records') || 'Records'}: ${item.n_records} - ${self.get_tool_label('columns') || 'Columns'}: ${item.n_columns}`
		ui.create_dom_element({
			element_type	: 'span',
			class_name		: 'info_text',
			text_content	: info_text,
			parent			: info_container
		})

		// updated by the render_columns_mapper
		ui.create_dom_element({
			element_type	: 'span',
			class_name		: 'bulk_process_name_label',
			inner_html		: self.get_tool_label('bulk_process_title') || 'Process title: ',
			parent			: info_container
		})
		item.bulk_process_label = `${self.context.label} | ${item.section_tipo} | ${item.section_label}`
		const bulk_process_label = ui.create_dom_element({
			element_type	: 'input',
			type			: 'text',
			class_name		: 'bulk_process_label input_section_tipo',
			value			: item.bulk_process_label,
			parent			: info_container
		})
		bulk_process_label.addEventListener('input', function(e){
			item.bulk_process_label = bulk_process_label.value
		})

	// preview
		const button_preview = ui.create_dom_element({
			element_type	: 'button',
			class_name		: 'button_preview info',
			inner_html		: self.get_tool_label('preview') || 'Preview',
			parent			: fragment
		})
		button_preview.addEventListener('click', function(e){
			e.stopPropagation()

			preview.classList.toggle('hide')
		})
		// preview text
		let preview
		if (item.sample_data_errors.length>0) {

			// errors found
			const text = JSON.stringify(item.sample_data_errors, null, 2)
			preview = ui.create_dom_element({
				element_type	: 'pre',
				class_name		: 'preview error hide',
				text_content	: text.replaceAll('<br>','\n'),
				parent			: fragment
			})
			button_preview.classList.add('error')
			// SEC-031: appendChild text node to avoid re-parsing existing button content as HTML.
			button_preview.appendChild(document.createTextNode('. ERROR: BAD JSON FORMAT'))

		}else{

			const text = JSON.stringify(item.sample_data, null, 2)
			preview = ui.create_dom_element({
				element_type	: 'pre',
				class_name		: 'preview hide',
				text_content	: text.replaceAll('<br>','\n'),
				parent			: fragment
			})
			button_preview.classList.add('ok')
		}

	// columns_mapper
		const columns_maper = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'columns_mapper',
			parent			: fragment
		})

	// result_container
		const result_container = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'result_container',
			parent			: fragment
		})
		item.result_container = result_container

	// item_wrapper
		const item_wrapper = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'file_item'
		})
		item_wrapper.appendChild(fragment)

	// update_section_warn first time
		update_section_warn()


	return item_wrapper
}//end render_file_info



/**
* RENDER_COLUMNS_MAPPER
* Async; fetches the importable component list for the given section tipo from
* the server and renders a column-mapping table row for every column in the CSV.
*
* Each row shows:
*   - The original column name from the CSV header
*   - Server-detected model (e.g. 'component_text_area') and label
*   - A checked checkbox (auto-ticked when column name matches a component tipo)
*   - A <select> of available target components — auto-selects the matching entry
*   - (optional) A decimal-separator selector when the mapped component is component_number
*   - A sample data cell with the first non-empty value from item.sample_data
*
* The function writes back into item.ar_columns_map[i] and item.section_label.
*
* Special column names that bypass the tipo-split heuristic and are matched directly:
*   'section_id', 'created_date', 'modified_date', 'created_by_user', 'modified_by_user'
*
* For all other columns the column name is split on '_' and the first token is used
* as the candidate component tipo.
*
* A collapsible toggle is attached to the header via ui.collapse_toggle_track so
* the mapper body can be expanded/collapsed by the user.
*
* @param {Object} self - tool_import_dedalo_csv instance
* @param {Object} item - one entry from self.csv_files_list (shape documented in module header)
* @returns {Promise<DocumentFragment>} fragment containing the full columns-mapper UI
*/
export const render_columns_mapper = async function(self, item) {

	// short vars
		const file_info					= item.file_info // array of columns name (first row of csv file)
		const section_tipo				= item.section_tipo
		const section_components_list	= await self.get_section_components_list(section_tipo)
		const section_label				= section_components_list.label
		const ar_components				= section_components_list.list
		const ar_columns_map			= item.ar_columns_map

	const fragment = new DocumentFragment()

	// update item section_label
		item.section_label = section_label

	// no results case
		if (!ar_components) {
			ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'warning error',
				text_content	: section_components_list.error,
				parent			: fragment
			})

			return fragment
		}

	// check section_id column exists
		// TOOLS-07: the listing response no longer ships the full parsed 'data';
		// the first row (header / column names) is file_info (server: (array)$ar_data[0]).
		const first_row				= file_info
		const columns_section_id	= first_row
			? first_row.find(el => el==='section_id')
			: null
		if (!columns_section_id) {
			ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'container error',
				inner_html		: 'Error. Column section_id is mandatory in the first row of csv file!',
				parent			: fragment
			})
		}

	// header
		const header = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'columns_header icon_arrow',
			text_content	: 'Columns mapper: ',
			parent			: fragment
		})
		// the section label is server text — an ELEMENT, never markup in a string
		ui.create_dom_element({
			element_type	: 'b',
			text_content	: section_label,
			parent			: header
		})

	// body
		const body = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'columns_body',
			parent			: fragment
		})

	// columns names
		// line
			const line = ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'columns_mapper_line names',
				parent			: body
			})
			// ui.create_dom_element({
			// 	element_type	: 'div',
			// 	inner_html		: 'Position',
			// 	parent			: line
			// })
			ui.create_dom_element({
				element_type	: 'div',
				inner_html		: 'Name',
				parent			: line
			})
			ui.create_dom_element({
				element_type	: 'div',
				inner_html		: 'Model',
				parent			: line
			})
			ui.create_dom_element({
				element_type	: 'div',
				inner_html		: 'Label',
				parent			: line
			})
			ui.create_dom_element({
				element_type	: 'div',
				inner_html		: 'Selected',
				parent			: line
			})
			ui.create_dom_element({
				element_type	: 'div',
				inner_html		: 'Mapped to',
				parent			: line
			})
			ui.create_dom_element({
				element_type	: 'div',
				text_content	: self.get_tool_label('import_mode') || 'Mode',
				parent			: line
			})
			ui.create_dom_element({
				element_type	: 'div',
				inner_html		: 'Sample data',
				parent			: line
			})

	// column_import_append. Per column, the mapped component's append policy
	// ('items' | 'geo_layer' | 'text_paragraphs') or null when the server
	// refuses append for it. UI state only: it never travels in ar_columns_map.
		const column_import_append = []

	// columns value
		const file_info_length = file_info.length
		for (let i = 0; i < file_info_length; i++) {

			const column_name = file_info[i]

			// map entry. The server sends null for a header cell it cannot resolve
			// (empty cell, unknown tipo); the user may still map it by hand, so an
			// empty (unchecked) entry replaces it instead of crashing the mapper.
				if (!ar_columns_map[i] || typeof ar_columns_map[i]!=='object') {
					ar_columns_map[i] = {
						tipo	: column_name,
						model	: null,
						label	: '',
						checked	: false
					}
				}

			// line
				const line = ui.create_dom_element({
					element_type	: 'div',
					class_name		: 'columns_mapper_line',
					parent			: body
				})

			// original position
				// 	const position = ui.create_dom_element({
				// 		element_type	: 'div',
				// 		class_name		: 'position',
				// 		// text_content	: i,
				// 		parent			: line
				// 	})
				// 	position.textContent = i

			// column_name (original in csv document)
				ui.create_dom_element({
					element_type	: 'div',
					class_name		: 'column_name',
					text_content	: column_name,
					parent			: line
				})

			// column_info detected model
				ui.create_dom_element({
					element_type	: 'div',
					class_name		: 'column_info',
					text_content	: item.ar_columns_map[i].model,
					parent			: line
				})

			// column_info detected label
				ui.create_dom_element({
					element_type	: 'div',
					class_name		: 'column_info',
					text_content	: item.ar_columns_map[i].label,
					parent			: line
				})

			// selected checkbox
				const checkbox_file_selection = ui.create_dom_element({
					element_type	: 'input',
					type			: 'checkbox',
					value			: i,
					parent			: line
				})
				checkbox_file_selection.addEventListener('change', function(){
					ar_columns_map[i].checked = checkbox_file_selection.checked
				})

			// target component list selector

				// container
				const target_container = ui.create_dom_element({
					element_type	: 'div',
					class_name		: 'target_container',
					parent			: line
				})
				// components list selector
				const target_select = ui.create_dom_element({
					element_type	: 'select',
					class_name		: 'column_select',
					text_content	: column_name,
					parent			: target_container
				})
				// empty option
				ui.create_dom_element({
					element_type	: 'option',
					value			: '',
					parent			: target_select
				})
				// check if the column_name has specific name
				// else split the column name to get the identifier (oh25_oh1)
				const ar_identifier = (
						(column_name==='section_id')
						|| (column_name==='created_date')
						|| (column_name==='modified_date')
						|| (column_name==='created_by_user')
						|| (column_name==='modified_by_user')
					)
					? [column_name]
					: column_name.split('_')
				// in any case use the first element in the array, it could be specific name or the component_tipo
				const column_component_tipo	= ar_identifier[0]
				const ar_components_length	= ar_components.length
				for (let k = 0; k < ar_components_length; k++) {

					const option = ui.create_dom_element({
						element_type	: 'option',
						value			: ar_components[k].value,
						text_content	: ar_components[k].label + ' [' + ar_components[k].value + ' - '+ ar_components[k].model +']',
						parent			: target_select
					})
					// assign the model and the append policy to the option to be
					// obtained by the change event (import_append: the component's
					// append policy string, or null when append is refused)
					option.model			= ar_components[k].model
					option.import_append	= ar_components[k].import_append ?? null

					// selected options set on match
					if ( ar_components[k].value===column_component_tipo ||
						(column_component_tipo==='section_id' && ar_components[k].model==='component_section_id')) {
						option.selected = true
						// checkbox_file_selection update
						checkbox_file_selection.checked = true

						// update ar_columns_map object. The model is set here too:
						// the mode selector and the decimal selector read it, and
						// the target's model is the truth, not the header's guess.
						ar_columns_map[i].checked		= true
						ar_columns_map[i].map_to		= ar_components[k].value
						ar_columns_map[i].model			= ar_components[k].model
						// the policy is UI state, kept off the wire map
						column_import_append[i]			= option.import_append
					}

					// in any case the column_name will be the csv column name as user has specify
					ar_columns_map[i].column_name	= column_name
				}
				target_select.addEventListener('change', function(e){
					// checkbox_file_selection update
					if (e.target.value && e.target.value.length>0) {
						checkbox_file_selection.checked = true
					}else{
						checkbox_file_selection.checked = false
					}

					// update ar_columns_map object
					const selected_option = e.target.options[e.target.selectedIndex]
					const model = selected_option.model
					ar_columns_map[i].checked	= checkbox_file_selection.checked
					ar_columns_map[i].map_to	= e.target.value
					ar_columns_map[i].model		= model
					column_import_append[i]		= selected_option.import_append ?? null

					// empty container
						while (mapped_to_options_container.firstChild) {
							mapped_to_options_container.removeChild(mapped_to_options_container.firstChild);
						}
					// delete decimal property
						delete ar_columns_map[i].decimal

					// if the component selected is a component_number, add the decimal selector
						if(model === 'component_number'){
							render_decimal_selector({
								i			: i,
								container	: mapped_to_options_container
							})
						}

					// import mode: a new target resets the mode to the default
					// (replace) — the previous choice was made for another model
						ar_columns_map[i].import_mode = undefined // absent = replace (dropped by JSON)
						render_import_mode_selector({
							i			: i,
							container	: import_mode_container
						})
				})

				const mapped_to_options_container = ui.create_dom_element({
					element_type	: 'div',
					class_name		: 'mapped_to_options_container',
					parent			: target_container
				})

				// if the component selected is a component_number, add the decimal selector
				if(ar_columns_map[i].model === 'component_number'){
					render_decimal_selector({
						i			: i,
						container	: mapped_to_options_container
					})
				}

			// import mode (replace | append), its own grid cell under the 'Mode' header
				const import_mode_container = ui.create_dom_element({
					element_type	: 'div',
					class_name		: 'import_mode_container',
					parent			: line
				})
				render_import_mode_selector({
					i			: i,
					container	: import_mode_container
				})

			// sample_data (search non empty values)
				// Walk sample rows to find the first non-empty value for this column position,
				// giving the user a concrete example of what the CSV contains.
				let sample_data = ''
				const item_sample_data_length = item.sample_data.length
				for (let j = 0; j < item_sample_data_length; j++) {
					const sd = item.sample_data[j][i]
					if (sd && sd.length>0) {
						sample_data = sd
						break;
					}
				}
				ui.create_dom_element({
					element_type	: 'div',
					class_name		: 'sample_data',
					text_content	: sample_data,
					parent			: line
				})
		}//end for (let i = 0; i < file_info_length; i++)

	// collapse_toggle_track
		// Attaches expand/collapse behaviour to the mapper header; state is persisted
		// under the key 'collapsed_<section_tipo>' so the user's preference survives refreshes.
		ui.collapse_toggle_track({
			toggler				: header,
			container			: body,
			collapsed_id		: 'collapsed_' + item.section_tipo,
			collapse_callback	: collapse,
			expose_callback		: expose
		})
		function collapse() {
			header.classList.remove('up')
		}
		function expose() {
			header.classList.add('up')
		}

	// render the decimal node selector
		// Inline helper: builds a point/comma decimal-separator select inside `container`
		// and keeps ar_columns_map[i].decimal in sync.
		function render_decimal_selector(options){

			const i			= options.i
			const container	= options.container

			const column_name	= self.get_tool_label('decimal') || 'Decimal'
			const point_name	= self.get_tool_label('point_name') || 'Point'
			const comma_name	= self.get_tool_label('comma_name') || 'Comma'

			const decimal_label = ui.create_dom_element({
				element_type	: 'span',
				class_name		: 'decimal_label',
				inner_html 		: column_name,
				parent			: container
			})

			const decimal_select = ui.create_dom_element({
				element_type	: 'select',
				class_name		: 'decimal_select',
				parent			: container
			})
			// empty option
			const point_option = ui.create_dom_element({
				element_type	: 'option',
				value			: '.',
				text_content	: point_name + ': .',
				parent			: decimal_select
			})
			point_option.checked = true

			ui.create_dom_element({
				element_type	: 'option',
				value			: ',',
				text_content	: comma_name + ': ,',
				parent			: decimal_select
			})
			ar_columns_map[i].decimal	= decimal_select.value

			decimal_select.addEventListener('change', function(e) {
				ar_columns_map[i].decimal	= decimal_select.value
			})
		}

	// render the import mode selector
		// Inline helper, modelled on render_decimal_selector: builds a
		// replace/append select inside `container` and keeps
		// ar_columns_map[i].import_mode in sync. Nothing is rendered (and no
		// import_mode is sent, so the server applies its default 'replace') when
		// the column cannot append: no policy (the server refuses append for the
		// model), the section_id key column, or an audit column.
		function render_import_mode_selector(options){

			const i			= options.i
			const container	= options.container

			// empty container (re-render on target change)
				while (container.firstChild) {
					container.removeChild(container.firstChild)
				}

			const policy = column_import_append[i] ?? null
			if (!import_mode_allowed(ar_columns_map[i], policy)) {
				ar_columns_map[i].import_mode = undefined // absent = replace
				return
			}

			const mode_label	= self.get_tool_label('import_mode') || 'Mode'
			const replace_name	= self.get_tool_label('replace') || 'Replace'
			// geolocation appends a new map layer; every other policy appends values
			const append_name	= policy==='geo_layer'
				? (self.get_tool_label('append_layer') || 'Add as new layer')
				: (self.get_tool_label('append') || 'Append')

			const import_mode_select = ui.create_dom_element({
				element_type	: 'select',
				class_name		: 'import_mode_select',
				title			: mode_label,
				parent			: container
			})
			import_mode_select.setAttribute('aria-label', mode_label)
			ui.create_dom_element({
				element_type	: 'option',
				value			: 'replace',
				text_content	: replace_name,
				parent			: import_mode_select
			})
			ui.create_dom_element({
				element_type	: 'option',
				value			: 'append',
				text_content	: append_name,
				parent			: import_mode_select
			})
			import_mode_select.value = ar_columns_map[i].import_mode==='append'
				? 'append'
				: 'replace'
			ar_columns_map[i].import_mode = import_mode_select.value

			import_mode_select.addEventListener('change', function() {
				ar_columns_map[i].import_mode = import_mode_select.value
			})
		}

	return fragment
}//end render_columns_mapper



/**
* UPLOAD_DONE
* Called on service_upload has finished of upload file using a event
* @see event subscription at 'init' function
*
* Triggered by the 'upload_file_done_<id>' event that service_upload fires after
* the file has been sent to the server. This method:
*   1. Clears the process_file area and shows a spinner.
*   2. Calls self.process_uploaded_file() to move the temp file to its permanent path.
*   3. On success calls self.refresh() to reload the file list; on failure shows the error.
*
* @param {Object} options
* @param {Object} options.file_data - upload metadata from service_upload:
*   { error, extension, name, size, tmp_name, type }
* @returns {Promise<boolean>} resolves true once the processing request is sent
*/
render_tool_import_dedalo_csv.prototype.upload_done = async function (options) {

	const self = this

	// options
		const file_data = options.file_data

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
		self.process_uploaded_file(file_data)
		.then(function(response) {

			spinner.remove()

			// process_file remove info loading. Envelope v2: a refusal carries the
			// coded, translated error; a success has no prose (the payload is
			// `{file_name}`), so the tool's own sentence is used.
			if (request_failed(response) || !response_data(response)) {
				// error case (SEC-031)
				process_file_info.textContent = request_failed(response)
					? error_text(response.error)
					: 'Error on processing file!'

			}else{
				// OK case (SEC-031)
				process_file_info.textContent = 'Processing file done successfully.'

				// self update (forces update list of files)
					self.refresh()
			}
		})


	return true
}//end upload_done



/**
* THE IMPORT PANEL — progress while it runs, then the report.
*
* Both halves are written against the TYPED WIRE (src/core/tools/import_wire.ts):
*   - every progress tick is an ImportProgressFrame;
*   - the terminal frame's data is an ImportBatchReport, whose per-file entries are
*     ImportFileReport ({ok, created[], updated[], failed[], warnings[], errors[],
*     rows_total, ms}).
*
* Note `created` / `updated` are ARRAYS OF SECTION_IDS, not counts — that is what
* lets the panel list them and offer "copy as column". (A count has no .length, so
* an earlier server that sent one made this whole block render nothing at all.)
*/


/**
* FOLLOW_IMPORT_JOB
* Subscribes to the import job's event stream and renders it.
*
* The stream is a PUSH: dd_utils_api::get_job_events (core/api/job_stream.ts)
* subscribes to the in-process job and emits a frame the instant the job changes
* state — there is no {pid, pfile} handle and no polling timer. The stream ends on
* the first frame with is_running:false, and THAT frame carries the report.
*
* @param {Object} options
* @param {Object} options.self - tool instance
* @param {string} options.job_id - the handle returned by import_files
* @param {HTMLElement} options.button_submit - locked while the job runs
* @param {HTMLElement} options.process_info_container - where the panel is drawn
* @returns {void}
*/
const follow_import_job = (options) => {

	const self						= options.self
	const job_id					= options.job_id
	const button_submit				= options.button_submit
	const process_info_container	= options.process_info_container

	// lock the submit button and reveal the panel
		button_submit.classList.add('loading')
		process_info_container.classList.remove('hide')

	const progress_node = render_progress_node(self, process_info_container)

	data_manager.request_stream({
		body : {
			dd_api	: 'dd_utils_api',
			action	: 'get_job_events',
			options	: {
				job_id : job_id
			}
		}
	})
	.then(function(stream){

		const on_read = (sse_response) => {

			const data = sse_response.data || {}

			// The job is over: this frame's data IS the report.
			if (sse_response.is_running===false) {

				progress_node.finish(
					(self.get_tool_label('process_completed') || 'Process completed') + ' ' + (sse_response.total_time || '') + ' ms'
				)

				// A job that died (server shutdown, an unhandled throw) reports here.
				const frame_errors = sse_response.errors
				const errors = (frame_errors && frame_errors.length)
					? frame_errors
					: null
				if (errors) {
					progress_node.error(
						(get_label.error || 'Error') + ': ' + errors.join(' | ')
					)
				}

				render_final_report({
					self					: self,
					batch_report			: data,
					process_info_container	: process_info_container
				})

				button_submit.classList.remove('loading')

				return
			}

			progress_node.update(data)
		}

		const on_done = () => {
			button_submit.classList.remove('loading')
		}

		data_manager.read_stream(stream, on_read, on_done)
	})
	.catch((error) => {
		// request_stream REJECTS on a network failure or a non-2xx response (it
		// used to leave the promise pending forever, which is why this handler did
		// not exist). Behaviour is unchanged — the stream simply does not start —
		// but the failure is reported rather than surfacing as an unhandled
		// rejection.
		console.error('[tool_import_dedalo_csv] could not open the status stream:', error)
	})
}//end follow_import_job



/**
* RENDER_PROGRESS_NODE
* The live panel: a real progress BAR (rows done / rows total — the server sends
* rows_total, which PHP never knew), the current file and record, and the running
* created/updated/failed/warning counts.
*
* @param {Object} self - tool instance
* @param {HTMLElement} container
* @returns {Object} { update(frame), finish(msg), error(msg) }
*/
const render_progress_node = (self, container) => {

	// clean the container
		while (container.firstChild) {
			container.removeChild(container.firstChild)
		}

	const panel = ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'import_progress_panel',
		parent			: container
	})

	// headline: what the engine is doing right now
		const headline = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'import_progress_headline',
			inner_html		: self.get_tool_label('preparing') || 'Preparing…',
			parent			: panel
		})

	// the bar
		const bar_track = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'import_progress_track',
			parent			: panel
		})
		const bar_fill = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'import_progress_fill',
			parent			: bar_track
		})

	// the detail line (record + component being written)
		const detail = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'import_progress_detail',
			parent			: panel
		})

	// the live counters
		const counters = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'import_progress_counters',
			parent			: panel
		})

	const label_of = (key, fallback) => self.get_tool_label(key) || fallback

	return {
		update : (frame) => {

			// 'reading' has no row count yet; 'importing' does.
			const rows_total	= frame.rows_total || 0
			const row			= frame.row || 0
			const percent		= rows_total > 0
				? Math.min(100, Math.round((row / rows_total) * 100))
				: 0

			bar_fill.style.width = percent + '%'
			bar_track.classList.toggle('indeterminate', rows_total === 0)

			const phase_label = frame.phase === 'reading'
				? label_of('reading', 'Reading')
				: label_of('importing', 'Importing')

			const position = (frame.files_total > 1)
				? ' (' + frame.file_index + '/' + frame.files_total + ')'
				: ''

			// textContent: `frame.file` and `frame.component_label` are server text
			headline.textContent =
				phase_label + ': ' + (frame.file || '') + position +
				(rows_total > 0 ? ' — ' + row + '/' + rows_total + ' (' + percent + '%)' : '')

			const ar_detail = []
			if (frame.section_id) ar_detail.push('id: ' + frame.section_id)
			if (frame.component_label) ar_detail.push(frame.component_label)
			detail.textContent = ar_detail.join(' | ')

			counters.textContent =
				label_of('created', 'Created') + ': ' + (frame.created || 0) + '  ·  ' +
				label_of('updated', 'Updated') + ': ' + (frame.updated || 0) + '  ·  ' +
				label_of('failed', 'Failed') + ': ' + (frame.failed || 0) + '  ·  ' +
				label_of('warnings', 'Warnings') + ': ' + (frame.warnings || 0)
		},
		finish : (msg) => {
			bar_track.classList.remove('indeterminate')
			bar_fill.style.width = '100%'
			panel.classList.add('done')
			headline.textContent = msg
			detail.textContent = ''
		},
		error : (msg) => {
			// `msg` carries the job's own error text — text_content, never HTML
			ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'error',
				text_content	: msg,
				parent			: panel
			})
		}
	}
}//end render_progress_node



/**
* COPY_BUTTON
* One "copy these ids" button. Both variants (comma-separated / one per line)
* differ only in their join, so they are built by the same function.
*
* @param {Object} self - tool instance
* @param {HTMLElement} parent
* @param {string} label_key
* @param {string} fallback_label
* @param {Function} get_text - () => the text to put on the clipboard
* @returns {HTMLElement}
*/
const copy_button = (self, parent, label_key, fallback_label, get_text) => {

	const button = ui.create_dom_element({
		element_type	: 'button',
		class_name		: 'warning copy_button copy',
		inner_html		: self.get_tool_label(label_key) || fallback_label,
		parent			: parent
	})
	button.addEventListener('click', (e) => {
		e.stopPropagation()

		// navigator.clipboard is undefined outside a secure context (plain HTTP).
		if (!navigator.clipboard) {
			alert(self.get_tool_label('insecure_context') || 'Insecure context, used only in https')
			return
		}
		navigator.clipboard.writeText(get_text())
		.then(() => {
			alert(self.get_tool_label('text_copied') || 'Text copied to clipboard')
		})
		.catch(err => {
			alert((self.get_tool_label('error_coping_text') || 'Error in copying text: ') + err)
		})
	})
	return button
}//end copy_button



/**
* RENDER_ID_BLOCK
* A titled list of section_ids with its two copy buttons (the block the user
* actually came for: "which records did this import touch?").
*
* @returns {void}
*/
const render_id_block = (self, parent, label_key, fallback_label, ids) => {

	if (!ids || ids.length < 1) return

	const header = ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'header',
		parent			: parent
	})
	ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'label',
		text_content	: (self.get_tool_label(label_key) || fallback_label) + ' (' + ids.length + ')',
		parent			: header
	})

	copy_button(self, header, 'copy_to_find', 'Copy as comma separated', () => ids.join(','))
	copy_button(self, header, 'copy_as_column', 'Copy as column', () => ids.join('\n'))

	append_text_lines(
		ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'section_id_container',
			parent			: parent
		}),
		ids
	)
}//end render_id_block



/**
* RENDER_ISSUE_BLOCK
* The failed / warning rows. A failed cell was NOT written (the record kept its
* previous value); a warning cell WAS written but needs a human look.
*
* @returns {void}
*/
const render_issue_block = (self, parent, label_key, fallback_label, issues, css_class) => {

	if (!issues || issues.length < 1) return

	const header = ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'header',
		parent			: parent
	})
	ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'label',
		text_content	: (self.get_tool_label(label_key) || fallback_label) + ' (' + issues.length + ')',
		parent			: header
	})

	// The ids are what the user pastes into a search to go look at the damage.
	copy_button(self, header, 'copy_to_find', 'Copy as comma separated',
		() => issues.map(el => el.section_id).join(',')
	)
	copy_button(self, header, 'copy_as_column', 'Copy as column',
		() => issues.map(el => el.section_id).join('\n')
	)

	const issues_len = issues.length
	for (let i = 0; i < issues_len; i++) {

		const issue = issues[i]

		const row_label = issue.row ? ('row ' + issue.row + ' | ') : ''

		ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'failed_container ' + css_class,
			text_content	: row_label + issue.section_id + ' | ' + issue.component_tipo + ' | ' + issue.msg,
			parent			: parent
		})
		// a notice with no payload (e.g. 'N already present, not added') has
		// data:null — no 'null' line under it
		if (issue.data===null || issue.data===undefined) continue
		ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'failed_data_container ' + css_class,
			text_content	: JSON.stringify( issue.data ),
			parent			: parent
		})
	}
}//end render_issue_block



/**
* RENDER_FINAL_REPORT
* Draws each file's ImportFileReport into that file's own result container.
*
* @param {Object} options
* @param {Object} options.self - tool instance
* @param {Object} options.batch_report - the terminal frame's envelope; its payload
*   is the ImportBatchReport {files: ImportFileReport[], summary, created, updated, failed}
* @param {HTMLElement} options.process_info_container
* @returns {void}
*/
const render_final_report = function(options){

	const self			= options.self
	const batch_report	= options.batch_report

	// The terminal frame's `data` IS the handler's envelope (background.ts: "the
	// RETURN VALUE becomes the final SSE frame's data"), so the report is one
	// level deeper — `response_data` is the ONE accessor that reaches it.
	const report_data	= response_data(batch_report)
	const files			= report_data?.files
	if (!Array.isArray(files)) {
		console.error('Invalid import report:', batch_report)
		return
	}

	const selected_files	= self.csv_files_list

	for (let i = files.length - 1; i >= 0; i--) {

		const report = files[i]

		const current_file = selected_files.find(el =>
			el.name === report.file && el.section_tipo === report.section_tipo
		)
		const result_container = current_file ? current_file.result_container : null
		if (!result_container) continue

		// clean container
			while (result_container.firstChild) {
				result_container.removeChild(result_container.firstChild)
			}

		// OK / Error headline. A file is 'ok' when it RAN — it may still hold failed
		// rows, which is why the counts below matter more than this badge.
			const has_failures	= (report.failed && report.failed.length > 0)
			const message_class	= report.ok
				? (has_failures ? 'warning_text' : 'success')
				: 'danger'
			const message_label	= report.ok
				? (self.get_tool_label('ok') || 'OK')
				: (self.get_tool_label('error') || 'Error')

			ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'response_msg alert ' + message_class,
				inner_html		: message_label,
				parent			: result_container
			})

		// the summary line, built from the numbers (never parsed out of a message)
			const summary = [
				(self.get_tool_label('created') || 'Created') + ': ' + report.created.length,
				(self.get_tool_label('updated') || 'Updated') + ': ' + report.updated.length,
				(self.get_tool_label('failed') || 'Failed') + ': ' + report.failed.length,
				(self.get_tool_label('warnings') || 'Warnings') + ': ' + report.warnings.length
			].join(' · ')

			ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'user_msg_container',
				text_content	: report.section_tipo + ' — ' + summary +
					(report.ms ? ' (' + report.ms + ' ms)' : ''),
				parent			: result_container
			})

		// file-level NOTICES — what the engine DID to a file it could read (today:
		// "this file was not UTF-8, it was read as windows-1252 and converted").
		// Deliberately NOT the error container below: painting a successful,
		// intended conversion red told the operator their good import had failed.
		// A notice is a fact about the read, so it renders as ordinary report text.
			const file_notices = report.notices
			if (file_notices && file_notices.length > 0) {
				for (let n = 0; n < file_notices.length; n++) {
					ui.create_dom_element({
						element_type	: 'div',
						class_name		: 'user_msg_container notice_msg',
						text_content	: file_notices[n],
						parent			: result_container
					})
				}
			}

		// file-level errors (unreadable CSV, no mapped column, a skipped row…)
			const file_errors = report.errors
			if (file_errors && file_errors.length > 0) {
				const errors_container = ui.create_dom_element({
					element_type	: 'div',
					class_name		: 'dedalo_last_error_container',
					parent			: result_container
				})
				ui.create_dom_element({
					element_type	: 'pre',
					class_name		: 'error_pre',
					text_content	: file_errors.join('\n'),
					parent			: errors_container
				})
			}

		const result_info_container = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'result_info_container',
			parent			: result_container
		})

		render_issue_block(self, result_info_container, 'failed', 'Failed', report.failed, 'error')
		render_issue_block(self, result_info_container, 'warnings', 'Warnings', report.warnings, 'warning')
		render_id_block(self, result_info_container, 'created', 'Created', report.created)
		render_id_block(self, result_info_container, 'updated', 'Updated', report.updated)
	}
}//end render_final_report



/**
* CHECK_PROCESS_DATA
* Re-attaches to an import that is still running, after a page reload.
*
* It ASKS THE SERVER (tool_request → get_background_jobs), which is the only thing
* that actually knows: the job runs inside the server process and its registry
* already records the tool, the action and the owner. The client therefore keeps
* NO state of its own.
*
* This used to be an IndexedDB lookup, because PHP forked a detached CLI child the
* web layer had no memory of — so the client had to remember {pid, pfile} or lose
* the job. Persisting it here duplicated a fact the server owns, and did so badly:
* the record was per-browser (a second tab saw no running import), it went stale
* whenever the server restarted and the in-process job died with it, and writing it
* to the wrong object store threw NotFoundError from inside a promise.
*
* Re-attaching to a FINISHED job is fine and deliberate: get_job_events answers a
* terminal job with one frame carrying the report (retained ~1h), so a reload right
* after the run still renders the outcome.
*
* @param {Object} options
* @param {Object} options.self - tool instance
* @param {HTMLElement} options.button_submit
* @param {HTMLElement} options.process_info_container
* @returns {void}
*/
const check_process_data = (options) => {

	const self						= options.self
	const process_info_container	= options.process_info_container
	const button_submit				= options.button_submit

	self.get_background_jobs('import_files')
	.then(function(api_response){

		const job_rows	= response_data(api_response)
		const jobs		= Array.isArray(job_rows) ? job_rows : []

		// Newest first (the server sorts). Re-attach only to a run still going —
		// a finished one would otherwise re-render its report every time the tool
		// is opened, for as long as the server retains the record.
		const running = jobs.find(el => el.status === 'running')
		if (!running) {
			return
		}

		follow_import_job({
			self					: self,
			job_id					: running.id,
			process_info_container	: process_info_container,
			button_submit			: button_submit
		})
	})
}//end check_process_data



// @license-end
