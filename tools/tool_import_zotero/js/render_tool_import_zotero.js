// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_label, page_globals, SHOW_DEBUG, DEDALO_CORE_URL, DEDALO_ROOT_WEB, console, alert, window */
/*eslint no-undef: "error"*/



// imports
	import {ui} from '../../../core/common/js/ui.js'
	import {data_manager} from '../../../core/common/js/data_manager.js'
	import {create_source} from '../../../core/common/js/common.js'
	import {request_failed} from '../../../core/common/js/api_error.js'
	import {handle_api_error} from '../../../core/common/js/error_dispatch.js'



/**
* RENDER_TOOL_IMPORT_ZOTERO
*
* Client-side render module for the Zotero bibliographic import tool.
*
* Exports:
*   render_tool_import_zotero — hollow constructor whose prototype methods are
*     mixed into tool_import_zotero via prototype assignment (see tool_import_zotero.js).
*
* Prototype methods (assigned externally to tool_import_zotero.prototype):
*   edit — builds the full tool wrapper + content area in 'edit' mode.
*
* Internal helpers (module-private, not exported):
*   get_content_data_edit — assembles the file drop-zone, temporary-section
*     component inputs, and the "Import" button; wires the server request.
* Data flow:
*   1. tool_import_zotero.build() constructs service_upload in multi-file mode
*      (handles file uploads to the server's tmp dir) and service_tmp_section (renders a live
*      edit interface for optional metadata to be applied to every imported
*      record — e.g. project assignment).
*   2. render_tool_import_zotero.prototype.edit (→ get_content_data_edit) renders
*      both services and adds the "Import" button.
*   3. On button click the tool collects self.files_data (populated by
*      service_upload) and service_tmp_section.get_components_data(), then
*      issues a dd_tools_api / tool_request RQO to the PHP
*      tool_import_zotero::import_files() action.
*   4. On success the page is reloaded so the user can see the newly imported
*      records.
*
* Key instance properties consumed here (set by tool_import_zotero):
*   self.files_data          {Array}  — the upload queue's ENTRY ARRAY, adopted
*     verbatim; each entry has at least { name, status, tmp_name, previewElement }.
*   self.service_upload      {Object} — service_upload instance (multiple:true);
*     render() returns an HTMLElement with the upload queue UI.
*   self.service_tmp_section {Object} — service_tmp_section instance; render()
*     returns component nodes; get_components_data() extracts current values.
*   self.tool_config         {Object} — Registered tool configuration from dd1633;
*     contains ddo_map (component descriptors) and import_mode ('section' | null).
*   self.key_dir             {string} — Temporary upload directory key built from
*     caller.tipo + '_' + caller.section_tipo (e.g. 'oh17_oh1'); tells the
*     server where to find the uploaded files.
*   self.caller              {Object} — The component or section that opened the
*     tool; provides tipo, section_tipo, section_id for the server RQO.
*/
export const render_tool_import_zotero = function() {

	return true
}//end render_tool_import_zotero



/**
* EDIT
* Render node for use in current mode
*
* Builds the full tool wrapper for 'edit' mode. If options.render_level is
* 'content', the raw content_data node is returned immediately without a
* wrapper (used by callers that embed the tool inside another container).
*
* @param {Object} options - Render options
* @param {string} [options.render_level='full'] - 'full' returns the complete
*   wrapper; 'content' returns only the inner content_data node.
* @returns {Promise<HTMLElement>} Resolves to the wrapper (render_level='full')
*   or to the content_data node (render_level='content').
*/
render_tool_import_zotero.prototype.edit = async function(options) {

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
		wrapper.content_data	= content_data


	return wrapper
}//end render_tool_import_zotero



/**
* GET_CONTENT_DATA_EDIT
*
* Assembles the content area for the Zotero import tool in edit mode.
*
* The content area contains (in DOM order, appended to a DocumentFragment):
*   1. options_wrapper — reserved container for configuration controls.
*      Currently it may be hidden (class_name_configuration='' | 'hide')
*      depending on whether the tool was opened in 'section' import_mode.
*      (!) class_name_configuration is built but never applied to any node —
*      see flags.
*   2. drop_zone — placeholder div that the service_upload template is NOT
*      appended to; both appear side-by-side inside the fragment. (!) The
*      drop_zone element is created but left empty; see flags. The queue brings
*      its own drop target, so nothing is lost by it staying empty.
*   3. template_container — receives the rendered service_upload node, which
*      carries the actual multi-file upload queue UI.
*   4. inputs_container — renders service_tmp_section components (metadata
*      fields the user fills before import) with a localised caption label.
*   5. buttons_bottom_container — holds the "Import" button.
*
* The "Import" button click handler:
*   - Guards against empty files_data (no files uploaded).
*   - Adds a CSS 'loading' class to self.node to block further interaction.
*   - Collects components_temp_data from service_tmp_section.
*   - Builds an RQO targeting dd_tools_api / tool_request / import_files with
*     a 1-hour timeout (Zotero imports can be large).
*   - On success, replaces the loading overlay with a localised result message
*     and installs a click handler on self.node that reloads the page.
*
* @param {Object} self - The tool_import_zotero instance (this-context of the
*   caller, passed explicitly so the closure does not capture the wrong this).
* @returns {Promise<HTMLElement>} Resolves to the content_data div node.
*/
const get_content_data_edit = async function(self) {

	const fragment = new DocumentFragment()

	// options container
		const options_wrapper = ui.create_dom_element({
			element_type	: 'div',
			class_name 		: 'component options',
			parent 			: fragment
		})

	// file name control
		// hide the options when the tool is caller by components, the import_mode is defined in preferences.
			const class_name_configuration = (self.tool_config.import_mode && self.tool_config.import_mode==='section')
				? ''
				: ' hide'

	// components container
		const drop_zone = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'drop_zone',
			parent			: fragment
		})

	// template_container
		const template_container = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'template_container',
			parent			: fragment
		})
		// service_upload render (multi-file queue)
		const template = await self.service_upload.render()
		template_container.appendChild(template)

	// inputs components container label
		const inputs_container = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'inputs_container',
			parent			: fragment
		})
		const inputs_container_caption = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'inputs_container_caption',
			inner_html		: get_label.values || 'Values',
			parent			: inputs_container
		})
		// service_tmp_section
		const inputs_nodes = await self.service_tmp_section.render()
		inputs_container.appendChild(inputs_nodes)

	// buttons_bottom_container
		const buttons_bottom_container = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'buttons_bottom_container success',
			parent			: fragment
		})

	// button process import
		const button_process_import = ui.create_dom_element({
			element_type	: 'button',
			class_name		: 'processing_import success',
			inner_html		: get_label.import || 'IMPORT',
			parent			: buttons_bottom_container
		})
		button_process_import.addEventListener('click', function(){
			if(self.files_data.length < 1){
				return
			}
			// add loading class to wrapper to block all actions for the user
				self.node.classList.add('loading')

			// get the options from the every file uploaded
			for (let i = self.files_data.length - 1; i >= 0; i--) {
				const current_value = self.files_data[i]
			}
			// files_data: JSON-SAFE projection of the upload queue's entries.
			// A queue entry carries a DOM node (`previewElement`, non-enumerable) and
			// a pile of transfer bookkeeping; posting it verbatim sends junk over the
			// wire. Only these four keys are read server-side, and
			// `tmp_name` is now LOAD-BEARING: the staged name is server-assigned
			// (two client names that sanitize alike become 'x.EXT' and 'x-1.EXT'),
			// so the server can no longer re-derive it from the display name.
				const safe_files_data = (self.files_data || []).map(el => {
					return {
						name		: encodeURI(el.name),
						tmp_name	: el.tmp_name || null,
						key_dir		: el.key_dir || null,
						extension	: el.extension || null
					}
				})

			// get the data from every component used to propagate to every file uploaded
			const components_temp_data = self.service_tmp_section.get_components_data()

			// source. Note that second argument is the name of the function to manage the tool request like 'delete_tag'
			// this generates a call as my_tool_name::my_function_name(options)
				const source = create_source(self, 'import_files')

			// process the images in the server (uploaded previously)
			// rqo
				const rqo = {
					dd_api	: 'dd_tools_api',
					action	: 'tool_request',
					source	: source,
					options	: {
						tipo					: self.caller.tipo,
						section_tipo			: self.caller.section_tipo,
						section_id				: self.caller.section_id,
						tool_config				: self.tool_config,
						files_data				: safe_files_data,
						components_temp_data	: components_temp_data,
						key_dir					: self.key_dir
					}
				}

			// call to the API, fetch data and get response
				return new Promise(function(resolve){

					data_manager.request({
						body : rqo,
						retries : 1, // one try only
						timeout : 3600 * 1000 // 3600 secs waiting response
					})
					.then(function(response){

						if(SHOW_DEBUG===true) {
							console.warn("-> API response:",response);
						}
						// change the loading to content_data to show message
						self.node.classList.remove('loading')
						self.node.content_data.classList.add('loading')
						// get message
						const failed	= request_failed(response)
						const msg		= failed
							? self.get_tool_label('upload_error') || 'Files no imported!'
							: self.get_tool_label('upload_done')  || 'Files imported successfully'
						// add the message to wrapper (outside content_data that has loading class)
						// TEXT only: the node may end up next to server text (DS-1)
						const msg_container = ui.create_dom_element({
							element_type	: 'div',
							class_name		: 'msg_container',
							text_content	: msg,
							parent			: self.node
						})
						// the ONE error surface: shows the real cause under the generic label
						if (failed) {
							handle_api_error(response.error, {wrapper: msg_container})
						}else{
							// the run's report: what was written, refused, dropped (T1-7)
							render_import_report(response.data, msg_container)
						}
						// when user click reload the tool
						self.node.addEventListener('click',function(){
							window.location.reload();
						})
						resolve(response)
					})
				})
		})

	// content_data
		const content_data = ui.tool.build_content_data(self)
		content_data.appendChild(fragment)


	return content_data
}//end get_content_data_edit



/**
* RENDER_IMPORT_REPORT
* Renders the import_files report under the outcome label, every line as TEXT
* (DS-1: the lines quote values from the imported file). A run that refused a
* field or an attachment answers ok, so without this the operator read a
* partially failed run as a success.
*
* Report keys (WC-2026-11-12-zotero-csl-json-import): summary, failed[{msg}],
* errors[], notices[], attachments[], and what the call-number addresses came
* to, each in its own list: created_at_id[], updated_at_id[] (record ids) and
* refused[{item, code, message}].
*
* @param {Object|null} data - The response data (the report)
* @param {HTMLElement} parent - The node the report is appended to
* @returns {HTMLElement|null} The report node, or null when there is no report
*/
export const render_import_report = function(data, parent) {

	if (!data || typeof data!=='object' || typeof data.summary!=='string') {
		return null
	}

	const report_node = ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'import_report',
		parent			: parent
	})
	ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'import_summary',
		text_content	: data.summary,
		parent			: report_node
	})

	const failed_lines = (Array.isArray(data.failed) ? data.failed : []).map(item => {
		const where = item && item.section_id ? item.section_id + ' ' + (item.component_tipo || '') + ': ' : ''
		return where + ((item && item.msg) || '')
	})
	const refused_lines = (Array.isArray(data.refused) ? data.refused : []).map(item => {
		return ((item && item.item) || '') + ': ' + ((item && item.message) || '')
	})
	const groups = [
		['import_created_at_id', id_list_lines('Created at their call-number id: ', data.created_at_id)],
		['import_updated_at_id', id_list_lines('Updated at their call-number id: ', data.updated_at_id)],
		['import_refused', refused_lines],
		['import_failed', failed_lines],
		['import_errors', Array.isArray(data.errors) ? data.errors : []],
		['import_attachments', Array.isArray(data.attachments) ? data.attachments : []],
		['import_notices', Array.isArray(data.notices) ? data.notices : []]
	]
	for (const [class_name, lines] of groups) {
		if (lines.length===0) {
			continue
		}
		const list = ui.create_dom_element({
			element_type	: 'ul',
			class_name		: class_name,
			parent			: report_node
		})
		for (const line of lines) {
			ui.create_dom_element({
				element_type	: 'li',
				text_content	: String(line),
				parent			: list
			})
		}
	}


	return report_node
}//end render_import_report



/**
* ID_LIST_LINES
* One report line for a list of record ids ('<label>12, 15'), none when the
* list is empty or missing.
*
* @param {string} label - The line's lead text
* @param {Array<number>|undefined} ids - The record ids
* @returns {Array<string>} Zero or one line
*/
const id_list_lines = function(label, ids) {

	return Array.isArray(ids) && ids.length>0
		? [label + ids.join(', ')]
		: []
}//end id_list_lines



// @license-end
