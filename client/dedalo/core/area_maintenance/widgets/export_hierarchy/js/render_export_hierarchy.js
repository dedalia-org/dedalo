// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_label, page_globals, SHOW_DEBUG, DEDALO_CORE_URL, DEDALO_API_URL */
/*eslint no-undef: "error"*/



// imports
	import {ui} from '../../../../common/js/ui.js'
	import {data_manager} from '../../../../common/js/data_manager.js'
	import {request_failed, response_data, response_extension} from '../../../../common/js/api_error.js'
	import {handle_api_error} from '../../../../common/js/error_dispatch.js'



/**
* RENDER_EXPORT_HIERARCHY
* Client-side render module for the export_hierarchy maintenance widget.
*
* This module provides the visual layer for three independent maintenance
* operations exposed in area_maintenance:
*
*   1. Export hierarchies — serialises one or more thesaurus matrix tables to
*      gzip-compressed COPY files in the engine's hierarchy import directory
*      (install/import/hierarchy/es1.copy.gz).
*      The user supplies an explicit comma-separated list of section tipos of
*      ACTIVE hierarchies, such as 'es1,fr1' (WC-2026-10-10: the old '*' and
*      'all' forms are refused; the core 'lg' is never exported).
*
*   2. Export hierarchy.json — writes the thesaurus manifest the installer
*      reads (hierarchy.json, in install/import/hierarchy/): every active hierarchy
*      plus the sha256 of the data files present at that moment, so it is run
*      AFTER the data export.
*
*   3. Sync Hierarchy status — reconciles the 'Active' flag on hierarchy nodes
*      with the 'Active in thesaurus' flag so both are always consistent.
*
* Both operations trigger long-running server-side jobs (up to one hour) via
* `export_hierarchy.prototype.exec_export_hierarchy` /
* `export_hierarchy.prototype.sync_hierarchy_active_status`, which are defined
* in export_hierarchy.js and are exposed on the widget instance (self).
*
* The entry point wired by export_hierarchy.js is:
*   export_hierarchy.prototype.edit = render_export_hierarchy.prototype.list
*   export_hierarchy.prototype.list = render_export_hierarchy.prototype.list
*
* Each form section delegates submission and response rendering to the shared
* `area_maintenance.prototype.init_form` helper (self.caller.init_form) when
* the on_submit override is NOT needed, or overrides it with a custom
* on_submit callback that directly calls the API method and renders the
* JSON response inline.
*
* Exports:
*   render_export_hierarchy             — constructor (prototype-based class)
*   render_export_hierarchy_node        — named export; also used by render_area_maintenance
*   render_export_hierarchy_json_node   — named export
*   render_sync_hierarchy_active_status_node — named export
*/
export const render_export_hierarchy = function() {

	return true
}//end render_export_hierarchy



/**
* LIST
* Creates the nodes of current widget.
* The created wrapper will be append to the widget body in area_maintenance
* @param {Object} options
* 	Sample:
* 	{
*		render_level : "full"
*		render_mode : "list"
*   }
* @returns {HTMLElement} wrapper
* 	To append to the widget body node (area_maintenance)
*/
render_export_hierarchy.prototype.list = async function(options) {

	const self = this

	const render_level = options.render_level || 'full'

	// content_data
		const content_data = await get_content_data_edit(self)
		if (render_level==='content') {
			return content_data
		}

	// wrapper. ui build_edit returns widget wrapper
		const wrapper = ui.widget.build_wrapper_edit(self, {
			content_data : content_data
		})
		// set pointers
		wrapper.content_data = content_data


	return wrapper
}//end list



/**
* GET_CONTENT_DATA_EDIT
* Assembles the full content area for the widget's edit/list view.
*
* Reads `self.value` (populated by `get_value` on the server) to obtain
* `export_hierarchy_path`. Then builds and appends three independent
* DocumentFragment sections:
*   - render_export_hierarchy_node  — hierarchy data export form
*   - render_export_hierarchy_json_node — hierarchy.json manifest form
*   - render_sync_hierarchy_active_status_node — active-status sync form
*
* @param {Object} self - Widget instance (export_hierarchy). Must expose:
*   - self.value {Object}          — widget value with `export_hierarchy_path`
*   - self.caller {Object}         — area_maintenance instance owning init_form
* @returns {HTMLElement} content_data - <div> containing the three form sections
*/
const get_content_data_edit = async function(self) {

	// short vars
		const value					= self.value || {}
		const export_hierarchy_path	= value.export_hierarchy_path || null

	// content_data
		const content_data = ui.create_dom_element({
			element_type : 'div',
			class_name	 : 'content_data'
		})

	// export_hierarchy_node
		const export_hierarchy_node = render_export_hierarchy_node({
			self,
			export_hierarchy_path
		})
		content_data.appendChild(export_hierarchy_node)

	// export_hierarchy_json_node
		const export_hierarchy_json_node = render_export_hierarchy_json_node({
			self,
			export_hierarchy_path
		})
		content_data.appendChild(export_hierarchy_json_node)

	// sync_hierarchy_active_status_node
		const sync_hierarchy_active_status_node = render_sync_hierarchy_active_status_node({
			self
		})
		content_data.appendChild(sync_hierarchy_active_status_node)


	return content_data
}//end get_content_data_edit



/**
* RENDER_EXPORT_HIERARCHY_NODE
* Builds the DOM section that lets a maintenance user trigger a hierarchy
* export job on the server.
*
* Rendering is guarded by two early-return checks:
*   1. If `export_hierarchy_path` is falsy (the panel value failed to load),
*      displays a hint and exits — no form is rendered without a destination.
*      The path is a fixed server-side constant, so on a healthy server this
*      branch is not reached.
*   2. If `self.caller` is absent (widget rendered standalone, outside
*      area_maintenance), displays a diagnostic message and exits — init_form
*      is not available.
*
* When both guards pass the function:
*   - Renders a config_grid showing the resolved export_hierarchy_path value.
*   - Calls `self.caller.init_form()` to build a submission form with a single
*     text input for section_tipo.
*
* The on_submit callback:
*   - Extracts section_tipo from the submitted values array.
*   - Clears body_response, shows a spinner, locks the form.
*   - Awaits `self.exec_export_hierarchy(section_tipo)` (1-hour timeout).
*   - On resolution: removes spinner, unlocks form, renders the raw JSON
*     response in a <pre> block. Double-clicking the <pre> removes it.
*
* section_tipo accepts ONLY an explicit comma-separated list ('es1,fr1') of
* thesaurus/model section tipos of ACTIVE hierarchies; every other entry
* (including the retired '*' / 'all' and the core 'lg1') comes back as one
* line of the response's `errors`.
*
* @param {Object} options
* @param {Object} options.self - Widget instance exposing self.caller and
*   self.exec_export_hierarchy
* @param {string|null} options.export_hierarchy_path - The server's fixed
*   hierarchy export directory, or null if the panel value failed to load
* @returns {DocumentFragment} Fragment containing title, info, config grid,
*   submission form, and response container
*/
export const render_export_hierarchy_node = function (options) {

	const {
		self,
		export_hierarchy_path
	} = options

	const fragment = new DocumentFragment()

	// title
		ui.create_dom_element({
			element_type	: 'h6',
			class_name		: '',
			inner_html		: `Export hierarchies`,
			parent			: fragment
		})

	// export_hierarchy_path check
		if (!export_hierarchy_path) {
			ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'info_text',
				inner_html		: `Exporting is unavailable: the server did not report its hierarchy export directory`,
				parent			: fragment
			})
			return fragment
		}

	// Running without caller
		if (!self.caller) {
			ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'info_text',
				inner_html		: `Running without caller`,
				parent			: fragment
			})
			return fragment
		}

	// info
		ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'info_text',
			text_content	: get_label.export_hierarchy_data_info || 'Writes the data files (e.g. es1.copy.gz) of the listed active hierarchies into install/import/hierarchy. Languages (lg) are never exported: they ship in the install seed.',
			parent			: fragment
		})

	// body_response
		const body_response = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'body_response'
		})

		// config_grid
			const config_grid = ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'config_grid',
				parent			: fragment
			})
			// Helper: appends a label/value row pair to config_grid.
			const add_to_grid = (label, value) => {
				ui.create_dom_element({
					element_type	: 'div',
					class_name		: 'label',
					inner_html		: label,
					parent			: config_grid
				})
				ui.create_dom_element({
					element_type	: 'div',
					class_name		: 'value',
					text_content	: String(value ?? ''),
					parent			: config_grid
				})
			}
			// add lines to config_grid container
			add_to_grid('Config:', '')
			add_to_grid('export_hierarchy_path: ', export_hierarchy_path)

	// form init
		self.caller.init_form({
			submit_label	: 'Export hierarchy',
			confirm_text	: get_label.sure || 'Sure?',
			body_info		: fragment,
			body_response	: body_response,
			inputs			: [{
				type		: 'text',
				name		: 'section_tipo',
				label		: get_label.export_hierarchy_section_tipos || 'Section tipos, e.g. es1,fr1', // placeholder
				mandatory	: true,
				value		: ''
			}],
			on_submit		: (e, values) => {

				const input			= values.find(el => el.name==='section_tipo')
				const section_tipo	= input?.value // string like 'es1,fr1'

				// clean
				while (body_response.firstChild) {
					body_response.removeChild(body_response.firstChild);
				}

				// API process fire
				self.exec_export_hierarchy(section_tipo)
				.then(async function(response){

					if (request_failed(response)) {
						// ONE error model: policy + renderer decide the surface
						await handle_api_error(response.error, {wrapper: body_response})
						return
					}
					render_export_response(response, body_response)
				})
			}
		})

	// add at end body_response
		fragment.appendChild(body_response)


	return fragment
}//end render_export_hierarchy_node



/**
* RENDER_EXPORT_HIERARCHY_JSON_NODE
* Builds the DOM section that writes the thesaurus manifest
* `hierarchy.json` in `install/import/hierarchy/` (server action
* `export_hierarchy_json`, WC-2026-10-10-hierarchy-json-manifest).
*
* The manifest lists every ACTIVE hierarchy with its metadata and declared
* dependencies, plus the sha256 of the `<tld>1|2.copy.gz` files present in the
* directory at that moment — the installer refuses a data file whose checksum
* does not match. So the info text tells the operator to export the data files
* FIRST.
*
* Same guards as render_export_hierarchy_node (no destination / no caller).
* The form has no inputs; the response is rendered by render_export_response
* (the written file as a download link, census errors, empty thesauri).
*
* @param {Object} options
* @param {Object} options.self - Widget instance exposing self.caller and
*   self.exec_export_hierarchy_json
* @param {string|null} options.export_hierarchy_path - The server's fixed
*   hierarchy export directory, or null if the panel value failed to load
* @returns {DocumentFragment} Fragment containing title, info, submission form
*   and response container
*/
export const render_export_hierarchy_json_node = function (options) {

	const {
		self,
		export_hierarchy_path
	} = options

	const fragment = new DocumentFragment()

	// title
		ui.create_dom_element({
			element_type	: 'h6',
			class_name		: '',
			text_content	: get_label.export_hierarchy_json || 'Export hierarchy.json',
			parent			: fragment
		})

	// no destination / no caller: nothing can be submitted
		if (!export_hierarchy_path || !self.caller) {
			ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'info_text',
				text_content	: !export_hierarchy_path
					? 'Exporting is unavailable: the server did not report its hierarchy export directory'
					: 'Running without caller',
				parent			: fragment
			})
			return fragment
		}

	// info
		ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'info_text',
			text_content	: get_label.export_hierarchy_json_info || 'Writes install/import/hierarchy/hierarchy.json: every active hierarchy with its metadata, dependencies and the checksums of the data files present now. Export the data files first.',
			parent			: fragment
		})

	// body_response
		const body_response = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'body_response'
		})

	// form init
		self.caller.init_form({
			submit_label	: get_label.export_hierarchy_json || 'Export hierarchy.json',
			confirm_text	: get_label.sure || 'Sure?',
			body_info		: fragment,
			body_response	: body_response,
			inputs			: [],
			on_submit		: () => {

				// clean
				while (body_response.firstChild) {
					body_response.removeChild(body_response.firstChild);
				}

				// API process fire
				self.exec_export_hierarchy_json()
				.then(async function(response){

					if (request_failed(response)) {
						// ONE error model: policy + renderer decide the surface
						await handle_api_error(response.error, {wrapper: body_response})
						return
					}
					render_export_response(response, body_response)
				})
			}
		})

	// add at end body_response
		fragment.appendChild(body_response)


	return fragment
}//end render_export_hierarchy_json_node



/**
* RENDER_EXPORT_RESPONSE
* Renders the data-oriented export_hierarchy API response into the body_response node.
* The response carries no HTML; this function builds the DOM from its fields:
*   { result:bool, msg:string, errors:string[], files:[{section_tipo,table,file_name,bytes,url}], import_hint:string }
* The hierarchy.json action adds `empty_hierarchies` (tlds listed with no data
* file — activated EMPTY at install time), shown as one line when non-empty.
* @param object response
* @param HTMLElement body_response
* @return void
*/
const render_export_response = function(response, body_response) {

	// clean previous content
		while (body_response.firstChild) {
			body_response.removeChild(body_response.firstChild)
		}

	// summary line (payload + the widget's `msg` extension key) — server text as
	// TEXT, never an HTML sink
		const exported	= response_data(response)===true
		const summary	= response_extension(response, 'msg')
		ui.create_dom_element({
			element_type	: 'div',
			class_name		: exported ? 'response_ok' : 'response_error',
			text_content	: summary ? String(summary) : (exported ? 'OK' : 'Error'),
			parent			: body_response
		})

	// produced files as real download links
		const files = Array.isArray(response.files) ? response.files : []
		if (files.length>0) {
			const list = ui.create_dom_element({
				element_type	: 'ul',
				class_name		: 'export_files',
				parent			: body_response
			})
			files.forEach(file => {
				const item = ui.create_dom_element({
					element_type	: 'li',
					parent			: list
				})
				const link = ui.create_dom_element({
					element_type	: 'a',
					// text_content (not inner_html) keeps the value as data, never markup
					text_content	: file.file_name || file.url,
					parent			: item
				})
				link.href	= file.url
				link.target	= '_blank'
				link.rel	= 'noopener noreferrer'
			})
		}

	// errors
		const response_errors = response_extension(response, 'errors')
		const errors = Array.isArray(response_errors) ? response_errors : []
		if (errors.length>0) {
			const error_list = ui.create_dom_element({
				element_type	: 'ul',
				class_name		: 'export_errors',
				parent			: body_response
			})
			errors.forEach(error => {
				ui.create_dom_element({
					element_type	: 'li',
					class_name		: 'response_error',
					text_content	: error,
					parent			: error_list
				})
			})
		}

	// empty thesauri (hierarchy.json): active hierarchies that ship no data file
		const empty_hierarchies = Array.isArray(response.empty_hierarchies) ? response.empty_hierarchies : []
		if (empty_hierarchies.length>0) {
			ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'info_text',
				text_content	: (get_label.export_hierarchy_empty_thesauri || 'Installed as empty thesauri (no data file)')
					+ ': ' + empty_hierarchies.join(', '),
				parent			: body_response
			})
		}

	// import hint (plain text, selectable for copy-paste)
		if (response.import_hint) {
			ui.create_dom_element({
				element_type	: 'pre',
				class_name		: 'import_hint',
				text_content	: response.import_hint,
				parent			: body_response
			})
		}
}//end render_export_response



/**
* RENDER_SYNC_HIERARCHY_ACTIVE_STATUS_NODE
* Builds the DOM section that lets a maintenance user trigger a hierarchy
* active-status synchronisation job on the server.
*
* Syncing reconciles each hierarchy node's 'Active' flag with its
* 'Active in thesaurus' flag so they are always consistent. This can diverge
* when thesaurus entries are activated/deactivated without the corresponding
* hierarchy update running.
*
* Rendering is guarded by an early-return check:
*   - If `self.caller` is absent (widget rendered outside area_maintenance),
*     displays a diagnostic message and returns early — init_form is not
*     available without a caller.
*
* The on_submit callback:
*   - Clears body_response, shows a spinner, locks the form.
*   - Awaits `self.sync_hierarchy_active_status()` (no options needed; the
*     server operation applies globally to all active hierarchies).
*   - On resolution: removes spinner, unlocks form, renders the raw JSON
*     response in a <pre> block. Double-clicking the <pre> removes it.
*
* Note: the @param JSDoc block on the original comment incorrectly listed
* `export_hierarchy_path` as a parameter; this function does not use it.
* The options object only destructures `self`.
*
* @param {Object} options
* @param {Object} options.self - Widget instance exposing self.caller and
*   self.sync_hierarchy_active_status
* @returns {DocumentFragment} Fragment containing title, info text,
*   submission form, and response container
*/
export const render_sync_hierarchy_active_status_node = function (options) {

	const {
		self
	} = options

	const fragment = new DocumentFragment()

	// title
		ui.create_dom_element({
			element_type	: 'h6',
			inner_html		: `Sync Hierarchy status`,
			class_name		: '',
			parent			: fragment
		})

	// Running without caller
		if (!self.caller) {
			ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'info_text',
				inner_html		: `Running without caller`,
				parent			: fragment
			})
			return fragment
		}

	// info
		ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'info_text',
			inner_html		: `Sync the 'Active' status with the 'Active in thesaurus' status.`,
			parent			: fragment
		})

	// body_response
		const body_response = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'body_response'
		})

	// form init
		self.caller.init_form({
			submit_label	: 'Sync Hierarchy',
			confirm_text	: get_label.sure || 'Sure?',
			body_info		: fragment,
			body_response	: body_response,
			inputs			: [],
			on_submit		: (e, values) => {

				// clean
					while (body_response.firstChild) {
						body_response.removeChild(body_response.firstChild);
					}

				// API process fire
				self.sync_hierarchy_active_status()
				.then(async function(response){

					if (request_failed(response)) {
						// ONE error model: policy + renderer decide the surface
						await handle_api_error(response.error, {wrapper: body_response})
						return
					}

					// the raw response carries server strings: TEXT, never an HTML sink
					const json_node = ui.create_dom_element({
						element_type	: 'pre',
						text_content	: JSON.stringify(response, null, 2),
						parent			: body_response
					})
					// Double-clicking the response node removes it from the DOM,
					// allowing the user to clear the result after reviewing it.
					const dblclick_handler = (e) => {
						json_node.remove()
					}
					json_node.addEventListener('dblclick', dblclick_handler)
				})
			}
		})

	// add at end body_response
		fragment.appendChild(body_response)


	return fragment
}//end render_sync_hierarchy_active_status_node



// @license-end
