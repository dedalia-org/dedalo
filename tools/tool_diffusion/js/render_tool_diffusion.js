// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_label, page_globals, SHOW_DEBUG, DEDALO_CORE_URL, tool_diffusion */
/*eslint no-undef: "error"*/



// imports
	import {ui} from '../../../core/common/js/ui.js'
	import {object_to_url_vars, time_unit_auto, open_window, printf} from '../../../core/common/js/utils/index.js'
	import {render_stream} from '../../../core/common/js/render_common.js'
	import {data_manager} from '../../../core/common/js/data_manager.js'
	import {when_in_viewport} from '../../../core/common/js/events.js'
	import {build_report_model, tsv_tables, tsv_errors, report_download_url} from './report_model.js'
	// ONE error model for the stream: a frame that ENDED the run is read by
	// normalize_stream_error and routed by the shared dispatcher — the report
	// panel below keeps rendering the per-record error list, which is a RESULT,
	// not the failure that stopped the job.
	import {is_api_error, normalize_stream_error, request_failed, response_data} from '../../../core/common/js/api_error.js'
	import {handle_api_error} from '../../../core/common/js/error_dispatch.js'
	// The ONE error text resolver: label_key → English message → code. Used for
	// the coded `connection_status` verdict below (a payload, not an envelope).
	import {error_text} from '../../../core/common/js/render_api_error.js'



/**
* RENDER_TOOL_DIFFUSION
*
* Client-side render module for tool_diffusion.
*
* This module is responsible for building and wiring all DOM nodes shown by
* the diffusion publishing tool.  It is invoked indirectly through
* tool_diffusion.prototype.edit (prototype-assigned in tool_diffusion.js)
* which calls render_tool_diffusion.prototype.edit below.
*
* Exported symbols:
*  - render_tool_diffusion   Constructor (assigned as prototype source in tool_diffusion.js).
*  - render_publication_items  Builds the per-diffusion-element accordion panels.
*  - render_container_bottom   Builds the action buttons + progress area for one panel.
*
* Key data shapes consumed here:
*
*  self.diffusion_info  {Object} — result of dd_diffusion_api::get_diffusion_info.
*    .section_diffusion_nodes  {Array}  flat array of ontology nodes that target this
*      section.  Each node: { tipo, model, label, parents, children?,
*      connection_status?, database? }.  The `parents` path is used to find the
*      diffusion_group and diffusion_element (or diffusion_element_alias)
*      ancestors.
*    .resolve_levels              {number}  default ontology resolution depth.
*    .skip_publication_state_check {number} 1 = bypass component_publication check.
*
*  self.bun_status  {Object} — result of dd_diffusion_api::get_engine_advisory.
*    .result  {boolean}  true when the Bun engine is reachable.
*    .msg     {string}   human-readable status message.
*
*  self.active_processes  {Array}  — result of dd_diffusion_api::list_processes.
*    Each entry: { process_id, started_at, ... }.  Used to reconnect an
*    in-progress SSE stream after a page reload.
*
*  SSE chunk shape (sse_response) consumed by the stream handlers:
*    { process_id, is_running, started_at, total_time, errors: string[],
*      state?,                                  // server job state, when present
*      data:   { msg, counter, total, section_label?,
*                current?: { section_id, time }, total_ms?,
*                diffusion_data?, consolidated_files?, last_update_record_response? },
*      result?: { result: boolean, msg: string,
*                 tables?:  [{ table_name, records_count, records_affected }],
*                 errors?:  string[],
*                 consolidated_files?: { merged_url, zip_url },
*                 diffusion_data?:     [{ file_url }],
*                 diffusion_class? } }
*
*  (!) `tables` / `errors` / `consolidated_files` live INSIDE `result`, not at the
*  SSE top level — an earlier version of this docblock said otherwise, and the
*  code written against that claim gated the whole report on `result.tables`
*  being truthy. An rdf/xml run reports `tables: []`, which IS truthy, so its
*  download buttons were unreachable; a failed run has no `tables` at all, so it
*  rendered nothing whatsoever. Both defects are gone: the chunk is now
*  classified by ./report_model.js and the report is gated on NOTHING.
*/
export const render_tool_diffusion = function() {

	return true
}//end render_tool_diffusion



/**
* EDIT
* Build and return the top-level wrapper HTMLElement for the diffusion tool.
*
* Called by tool_common.prototype.render (through the prototype assignment in
* tool_diffusion.js).  When render_level is 'content' the inner content_data
* node is returned directly instead of a full wrapper (used for partial
* refreshes without rebuilding the chrome).
*
* @param {Object} options
* @param {string} [options.render_level='full'] - 'full' returns the whole wrapper;
*   'content' returns only the inner content node.
* @returns {Promise<HTMLElement>} wrapper or content_data node.
*/
render_tool_diffusion.prototype.edit = async function(options) {

	const self = this

	// options
		const render_level = options.render_level || 'full'

	// content_data
		const content_data = await get_content_data(self)
		if (render_level==='content') {
			return content_data
		}

	// wrapper. ui build_edit returns a standard built tool wrapper
		const wrapper = ui.tool.build_wrapper_edit(self, {
			content_data : content_data
		})


	return wrapper
}//end edit



/**
* GET_CONTENT_DATA
* Build the full body of the diffusion tool panel.
*
* Assembles, in order:
*  1. Bun engine status row (green/red pill).
*  2. Pending-deletions row (async count + retry button) — hidden when count = 0.
*  3. Section identity header (name + tipo).
*  4. diffusion_info_container:
*     a. Depth-levels control (persisted in localStorage as 'diffusion_levels').
*     b. Info toggle (<pre> with raw diffusion_info JSON).
*     c. skip_publication_state_check checkbox
*        (persisted as 'diffusion_skip_publication_state').
*  5. Publication items accordion (one panel per diffusion element).
*  6. Record-count info line ("Publishing N selected records").
*
* All values that are persisted in localStorage are restored immediately after
* the input element is created so the UI reflects the user's last choice without
* requiring a server round-trip.
*
* @param {Object} self - tool_diffusion instance.
* @returns {Promise<HTMLElement>} content_data wrapper node.
*/
const get_content_data = async function(self) {

	const fragment = new DocumentFragment()

	// engine advisory gate: when the engine is not ok, show the advisory and stop
		const advisory = self.engine_advisory || { state:'ok' }
		if (advisory.state !== 'ok') {
			render_engine_advisory(self, advisory, fragment)
			return fragment
		}

	// short vars
		const diffusion_info = self.diffusion_info


	// bun_status
		const bun_status = self.bun_status || {}
		const bun_status_class = bun_status.ready === true ? 'bun_status ready' : 'bun_status fail'
		const bun_status_node = ui.create_dom_element({
			element_type	: 'div',
			class_name		: bun_status_class,
			parent			: fragment
		})
		ui.create_dom_element({
			element_type	: 'span',
			class_name		: 'label',
			text_content	: get_label.bun_engine || 'Bun engine',
			parent			: bun_status_node
		})
		ui.create_dom_element({
			element_type	: 'span',
			class_name		: 'value',
			text_content	: bun_status.label || (bun_status.ready === true ? 'Ready' : 'Unavailable'),
			parent			: bun_status_node
		})

	// pending_deletions
		// Deletions that could not reach one or more diffusion targets when the
		// record was deleted in the work system (Bun/target down). Loaded async;
		// shows a retry button when pending rows exist.
		const pending_deletions_node = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'pending_deletions hide',
			parent			: fragment
		})
		ui.create_dom_element({
			element_type	: 'span',
			class_name		: 'label',
			text_content	: self.get_tool_label('pending_deletions') || 'Pending deletions',
			parent			: pending_deletions_node
		})
		const pending_deletions_value = ui.create_dom_element({
			element_type	: 'span',
			class_name		: 'value',
			parent			: pending_deletions_node
		})
		const pending_deletions_button = ui.create_dom_element({
			element_type	: 'button',
			class_name		: 'retry_pending_deletions light',
			text_content	: self.get_tool_label('retry') || 'Retry',
			parent			: pending_deletions_node
		})
		// refresh_pending_deletions — queries the count and conditionally shows the row.
		// Also called after a successful retry to update the badge.
		const refresh_pending_deletions = function() {
			self.retry_pending_deletions({count_only: true})
			.then(function(response){
				// envelope v2 payload: `{summary, total, retried, remaining}`
				const pending = response_data(response)?.remaining ?? 0
				if (pending > 0) {
					pending_deletions_value.textContent = pending
					pending_deletions_node.classList.remove('hide')
				}else{
					pending_deletions_node.classList.add('hide')
				}
			})
		}
		// Retry click: disabled while in-flight, refreshes badge on completion.
		pending_deletions_button.addEventListener('click', function(e) {
			e.preventDefault()
			pending_deletions_button.disabled = true
			self.retry_pending_deletions({})
			.then(function(response){
				pending_deletions_button.disabled = false
				// the run's own sentence is the payload's `summary`; a refusal
				// carries the coded, translated error instead
				const retry_line = request_failed(response)
					? error_text(response.error)
					: response_data(response)?.summary
				if (retry_line) {
					pending_deletions_value.textContent = retry_line
				}
				refresh_pending_deletions()
			})
		})
		refresh_pending_deletions()

	// section_info
		const section_info = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'section_info',
			parent			: fragment
		})

		// section_name
			ui.create_dom_element({
				element_type	: 'h3',
				class_name		: 'section_name',
				text_content	: self.caller.label,
				parent			: section_info
			})
		// section_tipo
			ui.create_dom_element({
				element_type	: 'h3',
				class_name		: 'section_tipo',
				text_content	: self.caller.tipo,
				parent			: section_info
			})

	// diffusion_info_container
		const diffusion_info_container = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'diffusion_info_container',
			parent			: fragment
		})

	// resolve_levels
		// The depth value controls how many levels of related records the Bun
		// engine resolves when building the publication datum.  Minimum is 1.
		const resolve_levels_container = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'resolve_levels_container',
			parent			: diffusion_info_container
		})
		// label
		ui.create_dom_element({
			element_type	: 'label',
			class_name		: '',
			text_content	: get_label.levels || 'Levels',
			parent			: resolve_levels_container
		})
		// note about levels
		const note_about_levels = ui.create_dom_element({
			element_type	: 'a',
			class_name		: 'note_about_levels',
			text_content	: '?',
			title			: 'info',
			parent			: resolve_levels_container
		})
		// click
		const note_about_levels_click_handler = (e) => {
			e.stopPropagation()
			const text = (self.get_tool_label('levels_note') || 'levels_note')
				.replace(/\n/g,'<br>')
			// modal
			ui.attach_to_modal({
				header			: self.get_tool_label('depth_levels') || ' ? ',
				body			: text,
				footer			: null,
				size			: 'small',
				remove_overlay	: true
			})
		}
		note_about_levels.addEventListener('click', note_about_levels_click_handler)

		// resolve_levels_input
		const resolve_levels_input = ui.create_dom_element({
			element_type	: 'input',
			class_name		: 'resolve_levels_input',
			value			: self.resolve_levels,
			parent			: resolve_levels_container
		})
		resolve_levels_input.addEventListener('change', function(e) {
			e.preventDefault()
			// fix self levels value
			self.resolve_levels = parseInt(this.value)
			if (self.resolve_levels<1) {
				self.resolve_levels	= 1
				this.value	= 1
			}
			// store locally
			window.localStorage.setItem('diffusion_levels', this.value);
		})
		// restore local value
		const saved_diffusion_levels = localStorage.getItem('diffusion_levels')
		if (saved_diffusion_levels) {
			const resolve_levels_value	= parseInt(saved_diffusion_levels)
			resolve_levels_input.value	= resolve_levels_value
			self.resolve_levels			= resolve_levels_value
		}
		ui.create_dom_element({
			element_type	: 'label',
			class_name		: '',
			text_content	: self.get_tool_label('depth_levels') || 'Depth levels to solve',
			parent			: resolve_levels_container
		})

	// info
		// Collapsible <pre> showing the raw diffusion_info object — useful for
		// diagnosing ontology mis-configuration without opening the browser console.
		const button_info = ui.create_dom_element({
			element_type	: 'span',
			class_name		: 'button info',
			parent			: diffusion_info_container
		})
		const info_div = ui.create_dom_element({
			element_type	: 'pre',
			class_name		: 'info_div hide',
			text_content	: 'info: ' + JSON.stringify(diffusion_info, null, 2),
			parent			: diffusion_info_container
		})
		ui.collapse_toggle_track({
			toggler			: button_info,
			container		: info_div,
			collapsed_id	: 'collapsed_tool_diffusion_info',
			default_state 	: 'closed'
		})

	// skip_publication_state_check
		// When checked, the diffusion engine does not filter out records whose
		// component_publication is set to "not published".  Useful for staging
		// environments or forced re-publications.  Persisted in localStorage.
		const skip_publication_state_check_label = ui.create_dom_element({
			element_type	: 'label',
			text_content	: self.get_tool_label('skip_publication_state_check') || 'Ignore temporarily the publication status when publishing',
			parent			: resolve_levels_container
		})
		const skip_publication_state_check_node = ui.create_dom_element({
			element_type	: 'input',
			type			: 'checkbox',
			class_name		: 'skip_publication_state_check_input',
			name			: 'skip_publication_state_check',
			value			: 1
		})
		skip_publication_state_check_label.prepend(skip_publication_state_check_node)
		if (self.diffusion_info.skip_publication_state_check===1) {
			skip_publication_state_check_node.checked = true
		}
		skip_publication_state_check_node.addEventListener('change', function(e) {
			e.preventDefault()
			// fix self levels value
			self.skip_publication_state_check = this.checked ? 1 : 0
			// store locally
			window.localStorage.setItem('diffusion_skip_publication_state', self.skip_publication_state_check);
		})
		// restore local value
		const saved_skip_publication_state = localStorage.getItem('diffusion_skip_publication_state')
		if (saved_skip_publication_state) {
			const skip_publication_state_check_value	= saved_skip_publication_state > 0
			skip_publication_state_check_node.checked	= skip_publication_state_check_value // bool
			self.skip_publication_state_check			= skip_publication_state_check_value // bool
		}

	// publication items
		const publication_items = render_publication_items(self)
		fragment.appendChild(publication_items)

	// info_text
		// In list mode, get the real record count from the caller's paginator.
		// In edit mode (single-record view), total is always 1.
		const total = (self.caller.mode==='edit')
			? 1
			: await self.caller.get_total()
		const locale		= 'es-ES' // (page_globals.locale ?? 'es-CL').replace('_', '-')
		const total_label	= new Intl.NumberFormat(locale, {}).format(total);
		ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'info_text',
			text_content	: self.get_tool_label('publish_selected_records', total_label),
			parent			: diffusion_info_container
		})

	// content_data
		const content_data = ui.tool.build_content_data(self)
		content_data.appendChild(fragment)


	return content_data
}//end get_content_data



/**
* RENDER_PUBLICATION_ITEMS
* Build the accordion of publication panels — one per diffusion element.
*
* Each diffusion element (e.g. "Publication web", "Socrata") is an entry in
* self.diffusion_info.section_diffusion_nodes.  Nodes are first grouped by
* their diffusion_group parent label so related targets can be shown under a
* shared heading (future CSS grouping; currently each node creates its own
* accordion entry regardless of group).
*
* For every node in every group this function:
*  1. Locates the diffusion_element (or diffusion_element_alias) ancestor in
*     node.parents to extract element_tipo and the diffusion type string.
*  2. Derives a per-user, per-element, per-section process_id used to reconnect
*     an in-flight stream after a page reload.
*  3. Renders a collapsible panel with:
*     - Name, type, diffusion element tipo, and diffusion node tipo rows, each
*       with a link to open the ontology node in the dd5 documentation tool.
*     - Target database name (sql only) and DB connection status (if reported
*       by the server). An sql element's Name row reads 'Table name'.
*     - A fields sub-grid listing target column → source Dédalo component
*       (collapsed by default; click label to expand).
*     - A container_bottom with Publish button and SSE progress area.
*
* Collapse state for each panel is persisted in ui.collapse_toggle_track via
* 'collapsed_diffusion_item_<element_tipo>'.
*
* @param {Object} self - tool_diffusion instance.
* @returns {HTMLElement} publication_items container node.
*/
export const render_publication_items = function(self) {

	// short vars
		const section_diffusion_nodes	= self.diffusion_info.section_diffusion_nodes || []
		const lock_items				= []

	// publication_items container
		const publication_items = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'publication_items'
		})

	// group nodes by diffusion_group parent label
		const groups = new Map()
		for (const node of section_diffusion_nodes) {
			// find diffusion_group parent
			const diffusion_group_parent = node.parents.find(p => p.model === 'diffusion_group')
			const group_label = diffusion_group_parent ? diffusion_group_parent.label : 'Other'
			const group_tipo = diffusion_group_parent ? diffusion_group_parent.tipo : 'other'

			if (!groups.has(group_label)) {
				groups.set(group_label, {
					label: group_label,
					tipo: group_tipo,
					nodes: []
				})
			}
			groups.get(group_label).nodes.push(node)
		}

	// render each group
		for (const group of groups.values()) {

			// render each node in this group
				for (const node of group.nodes) {

					// find diffusion_element parent for type and element_tipo
						const diffusion_element_parent = node.parents.find(p => p.model === 'diffusion_element' || p.model === 'diffusion_element_alias')
						const element_tipo = diffusion_element_parent ? diffusion_element_parent.tipo : null
						const type = diffusion_element_parent ? diffusion_element_parent.type : null

					// process_id like 'process_diffusion_8_mht2_rsc170'
						const process_id = 'process_diffusion_' + page_globals.user_id + '_' + element_tipo + '_' + self.caller.section_tipo

					// publication_item_label
						const publication_item_label = ui.create_dom_element({
							element_type	: 'div',
							class_name		: 'publication_item_label label icon_arrow up',
							text_content	: diffusion_element_parent.label,
							parent			: publication_items
						})

					// publication_item_body
						const publication_item_body = ui.create_dom_element({
							element_type	: 'div',
							class_name		: 'publication_item_body',
							parent			: publication_items
						})

					// collapse body
						ui.collapse_toggle_track({
							toggler				: publication_item_label,
							container			: publication_item_body,
							collapsed_id		: 'collapsed_diffusion_item_' + element_tipo,
							collapse_callback	: collapse,
							expose_callback		: expose,
							default_state		: 'opened'
						})
						function collapse() {
							publication_item_label.classList.remove('up')
						}
						function expose() {
							publication_item_label.classList.add('up')
						}

					// publication_items_grid
						const publication_items_grid = ui.create_dom_element({
							element_type	: 'div',
							class_name		: 'publication_items_grid',
							parent			: publication_item_body
						})

					// name (an sql element publishes the node as a table)
						const name_label = ui.create_dom_element({
							element_type	: 'span',
							text_content	: type==='sql'
								? (get_label.table_name || 'Table name')
								: (get_label.name || 'Name'),
							class_name		: 'label',
							parent			: publication_items_grid
						})
						const name_value = ui.create_dom_element({
							element_type	: 'div',
							text_content	: node.label,
							class_name		: 'value',
							parent			: publication_items_grid
						})

					// type
						const type_label = ui.create_dom_element({
							element_type	: 'span',
							text_content	: get_label.type || 'Type',
							class_name		: 'label',
							parent			: publication_items_grid
						})
						const type_value = ui.create_dom_element({
							element_type	: 'div',
							text_content	: type || node.model,
							class_name		: 'value',
							parent			: publication_items_grid
						})

					// diffusion_element
						const diffusion_element_label = ui.create_dom_element({
							element_type	: 'span',
							text_content	: 'Diffusion element',
							class_name		: 'label',
							parent			: publication_items_grid
						})
						const diffusion_element_value = ui.create_dom_element({
							element_type	: 'div',
							text_content	: element_tipo,
							class_name		: 'value',
							parent			: publication_items_grid
						})
						const diffusion_element_link_node = ui.create_dom_element({
							element_type	: 'a',
							class_name		: 'button tree',
							title			: get_label.open || 'Open',
							parent			: diffusion_element_value
						})
						const click_handler = async (e) => {
							e.stopPropagation()
							const url = DEDALO_CORE_URL + `/page/?tipo=dd5&menu=false&search_tipos=${element_tipo}`
							window.open(url, 'docu_window')
						}
						diffusion_element_link_node.addEventListener('click', click_handler)

					// diffusion_tipo (main node tipo)
						const diffusion_tipo_label = ui.create_dom_element({
							element_type	: 'span',
							text_content	: 'Diffusion tipo',
							class_name		: 'label',
							parent			: publication_items_grid
						})
						const diffusion_tipo_value = ui.create_dom_element({
							element_type	: 'div',
							text_content	: node.tipo,
							class_name		: 'value',
							parent			: publication_items_grid
						})
						const diffusion_tipo_link_node = ui.create_dom_element({
							element_type	: 'a',
							class_name		: 'button tree',
							title			: get_label.open || 'Open',
							parent			: diffusion_tipo_value
						})
						const diffusion_tipo_click_handler = async (e) => {
							e.stopPropagation()
							const url = DEDALO_CORE_URL + `/page/?tipo=dd5&menu=false&search_tipos=${node.tipo}`
							window.open(url, 'docu_window')
						}
						diffusion_tipo_link_node.addEventListener('click', diffusion_tipo_click_handler)

					// database (sql only: the sanitized target the writer publishes into)
						if (type==='sql' && typeof node.database==='string' && node.database.length) {
							ui.create_dom_element({
								element_type	: 'span',
								text_content	: get_label.database || 'Database',
								class_name		: 'label',
								parent			: publication_items_grid
							})
							ui.create_dom_element({
								element_type	: 'div',
								text_content	: node.database,
								class_name		: 'value',
								parent			: publication_items_grid
							})
						}

					// DB connection_status
						if (node.connection_status) {
							ui.create_dom_element({
								element_type	: 'span',
								text_content	: get_label.connection_status || 'Connection status',
								class_name		: 'label',
								parent			: publication_items_grid
							})
							// WC-2026-08-15-diffusion-connection-status-ok-message: the
							// verdict is `{ok, code?, message}` (never the retired
							// `{result,msg}` pair). It is a NESTED PAYLOAD, not an
							// envelope: `ok` is the verdict and `code` (present only on
							// a negative one) is the registered reason.
							const connection_status	= node.connection_status
							const class_status		= connection_status.ok===true
								? 'success'
								: 'fail'
							// A coded verdict goes through the ONE error renderer so the
							// admin reads it in their language; `label_key` follows the
							// registry convention (ERRORS_SPEC §2.3: `error_` + code with
							// `.` → `_`), and `error_text` falls back to the server's
							// English `message` when that key is not in the catalog.
							const status_text = typeof connection_status.code==='string' && connection_status.code.length
								? error_text({
									code		: connection_status.code,
									label_key	: 'error_' + connection_status.code.replace(/\./g, '_'),
									message		: connection_status.message
								})
								: connection_status.message
							ui.create_dom_element({
								element_type	: 'div',
								text_content	: status_text,
								class_name		: 'value ' + class_status,
								parent			: publication_items_grid
							})
						}

					// children (fields) - using node.children as table_fields_info equivalent
						if (node.children?.length > 0) {
							const fields_label = ui.create_dom_element({
								element_type	: 'span',
								text_content	: get_label.fields || 'Fields',
								class_name		: 'label',
								parent			: publication_items_grid
							})
							const fields_value = ui.create_dom_element({
								element_type	: 'div',
								class_name		: 'value link icon_arrow unselectable',
								text_content	: get_label.show || 'Show',
								parent			: publication_items_grid
							})
							// Toggle all child detail rows in the grid when the fields header is clicked.
							fields_value.addEventListener('click', function(e) {
								ar_fields_nodes.map(el => {
									el.classList.toggle('hide')
								})
								this.classList.toggle('up')
							})

							// table_fields_info (children array)
								const ar_fields_nodes = []
								const children_length = node.children.length
								for (let i = 0; i < children_length; i++) {

									const child = node.children[i]

									// field (target)
										// child.label is the destination column/field name in the publication target
										const field_node = ui.create_dom_element({
											element_type	: 'span',
											text_content	: child.label,
											class_name		: 'fields_grid_value label hide',
											parent			: publication_items_grid
										})
										ar_fields_nodes.push(field_node)

									// related (Dédalo source)
										// related_label / related_tipo link back to the Dédalo component that
										// feeds this field.  Clicking opens dd5 positioned on that component.
										const related_item = ui.create_dom_element({
											element_type	: 'div',
											text_content	: child.related_label || '-',
											class_name		: 'fields_grid_value label link hide',
											title			: (child.related_tipo || '') + ' - ' + (child.related_model || ''),
											parent			: publication_items_grid
										})
										ar_fields_nodes.push(related_item)
										related_item.addEventListener('click', function(e) {
											e.stopPropagation()
											const url = DEDALO_CORE_URL + '/page/?' + object_to_url_vars({
												tipo			: 'dd5',
												search_tipos	: child.tipo,
												menu			: false
											})
											const window_width	= 1001
											const screen_width	= window.screen.width
											const screen_height	= window.screen.height
											window.docu_window	= window.open(
												url,
												'docu_window',
												`left=${screen_width-window_width},top=0,width=${window_width},height=${screen_height}`
											)
										})
										const model_node = ui.create_dom_element({
											element_type	: 'span',
											class_name		: 'fields_grid_value_obs label light hide',
											text_content	: child.model + ' | ' + child.tipo,
											parent			: publication_items_grid
										})
										ar_fields_nodes.push(model_node)
										const related_info_node = ui.create_dom_element({
											element_type	: 'div',
											class_name		: 'fields_grid_value_obs label light hide',
											text_content	: (child.related_model || '') + ' | ' + (child.related_tipo || ''),
											parent			: publication_items_grid
										})
										ar_fields_nodes.push(related_info_node)
								}

							// container_bottom
							const container_bottom = render_container_bottom(self, {
								element_tipo	: element_tipo,
								tipo			: node.tipo,
								type			: type,
								label			: node.label,
								children		: node.children
							}, lock_items, process_id)
							publication_items_grid.appendChild(container_bottom)
						}
			}//end for group.nodes
		}//end for groups


	return publication_items
}//end render_publication_items



/**
* RENDER_CONTAINER_BOTTOM
* Build the action area for a single diffusion element panel.
*
* Contains:
*  - A "Publish" button that asks for confirmation before starting.
*  - A response_message div used as the SSE progress container.
*  - A bottom_additions div reserved for type-specific additions
*    (the switch is intentionally empty; the old 'combine XML' post-action
*    was removed because the Bun engine now handles consolidation for RDF and
*    XML the same way).
*
* On mount, check_process_data inspects self.active_processes to see whether a
* diffusion job with this process_id is still running (e.g. after a page
* reload).  If found, update_process_status is called immediately to reconnect
* the SSE polling stream.
*
* The publish button is given focus as soon as it scrolls into the viewport,
* via when_in_viewport.
*
* @param {Object} self - tool_diffusion instance.
* @param {Object} item - Descriptor for the current diffusion node.
* @param {string} item.element_tipo - Ontology tipo of the diffusion_element parent.
* @param {string} item.tipo - Ontology tipo of the diffusion node itself.
* @param {string} item.type - Diffusion type string (e.g. 'database', 'rdf', 'xml').
* @param {string} item.label - Human-readable name for this diffusion target.
* @param {Array}  item.children - Field mappings (target column + Dédalo source).
* @param {Array}  lock_items - Shared array of button elements to disable during publish.
*   Shared across all panels in the same render_publication_items call so that
*   launching one process locks all Publish buttons simultaneously.
* @param {string} process_id - Unique identifier for the SSE stream, scoped to
*   user + diffusion element + section tipo.
* @returns {HTMLElement} container_bottom node.
*/
export const render_container_bottom = function (self, item, lock_items, process_id) {

	const container_bottom = ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'container_bottom'
	})

	// buttons_container
		const buttons_container = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'buttons_container',
			parent			: container_bottom
		})

	// response_message
		const response_message = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'response_message',
			parent			: container_bottom
		})

	// publication_button
		const publication_button = ui.create_dom_element({
			element_type	: 'button',
			class_name		: 'warning publication_button',
			text_content	: get_label.publish || 'Publish',
			parent			: buttons_container
		})
		lock_items.push(publication_button)
		// click event
		const click_handler = (e) => {
			e.stopPropagation()

			// user confirmation
			if (!confirm(get_label.sure || 'Sure?')) {
				return
			}

			// publish content exec
			publish_content(self, {
				response_message		: response_message,
				publication_button		: publication_button,
				item					: item,
				diffusion_tipo			: item.tipo,
				process_id				: process_id
			})
		}
		publication_button.addEventListener('click', click_handler)

	// disable cases removed - connection_status and table check will be handled by Bun API in future
		when_in_viewport(publication_button, ()=>{
			publication_button.focus()
		})

	// check process status always (reconnection after page reload)
		const check_process_data = () => {
			const processes = self.active_processes || []
			// Sort descending so the most recent is checked first
			const sorted_processes = [...processes].sort((a,b) => b.started_at - a.started_at)
			const my_process = sorted_processes.find(p => p.process_id === process_id)

			if (my_process) {
				update_process_status({
					self,
					item		: item, // real subject line instead of a parsed process_id
					process_id	: process_id,
					container	: response_message,
					lock_items	: lock_items
				})
			}
		}
		check_process_data()

	// bottom_additions
		const bottom_additions = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'bottom_additions',
			parent			: buttons_container
		})
		// note: XML consolidation (merged file + ZIP) is produced by the Bun
		// engine like RDF — the old 'combine XML files' post_action was removed
		switch (item.type) {

			default:

				break;
		}


	return container_bottom;
}//end render_container_bottom



/**
* PUBLISH_CONTENT
* Initiate a diffusion publish run and display live SSE progress.
*
* Flow:
*  1. Locks all lock_items (adds 'loading' class) and blurs the active element.
*  2. Calls self.export() which opens a ReadableStream from the Bun diffusion
*     API (action: 'diffuse', SSE protocol).
*  3. Sets up a render_stream panel inside response_message with a Stop button
*     that fires a cancel_process API call.
*  4. Reads stream chunks via data_manager.read_stream. Every chunk goes through
*     build_stream_handlers → render_run_report, which rebuilds the report panel
*     in place; the one-line message node carries the server's status message
*     and nothing else.
*  5. On completion (on_done): unlocks buttons and re-renders the report once.
*
* (!) The old "time remaining" estimate is GONE, deliberately. It averaged
*     data.current.time, which is CUMULATIVE elapsed for the attempt, not a
*     per-record duration (src/diffusion/runner.ts) — so the number it produced
*     was arithmetically meaningless. The underlying values are still shown, in
*     Diagnostics, under their honest names.
*
* The `process_id` is user+element+section scoped so concurrent diffusion jobs
* for different elements remain independent.
*
* (!) alert() is used for cancel_process errors.  This is intentional legacy
*     behaviour — do not replace with console.warn without verifying UX impact.
*
* @param {Object} self - tool_diffusion instance.
* @param {Object} options
* @param {HTMLElement} options.response_message - Container for SSE progress output.
* @param {HTMLElement} options.publication_button - The triggering button (locked during run).
* @param {Object}      options.item - Diffusion node descriptor (see render_container_bottom).
* @param {string}      options.diffusion_tipo - Ontology tipo of the diffusion node.
* @param {string}      options.process_id - Unique identifier for this SSE stream.
* @returns {Promise<void>}
*/
const publish_content = async (self, options) => {

	// options
		const response_message			= options.response_message
		const publication_button		= options.publication_button
		const item						= options.item
		const diffusion_element_tipo	= options.diffusion_element_tipo ?? item?.element_tipo
		const diffusion_tipo			= options.diffusion_tipo ?? item?.diffusion_tipo
		const process_id				= options.process_id

	// clean previous messages
		response_message.classList.remove('error')
		publication_button.classList.add('loading')

	// lock items
		const lock_items = [publication_button]

	// blur button
		document.activeElement.blur()

	// export API call — now returns a ReadableStream
		const stream = await self.export({
			item					: item,
			diffusion_element_tipo	: diffusion_element_tipo,
			diffusion_tipo			: diffusion_tipo,
			process_id				: process_id
		})
		if (!stream) {
			// The failure itself was already routed as ONE ApiError by export()
			// (tool_diffusion.js): here the panel only says the run did not start and
			// gives the button back. text_content, never update_node_content — that
			// helper is insertAdjacentHTML (ui.js).
			response_message.replaceChildren()
			ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'stream_not_opened',
				text_content	: 'The publication did not start.',
				parent			: response_message
			})
			response_message.classList.add('error')
			publication_button.classList.remove('loading')
			console.error('Error: data_manager.request_stream did not return a valid stream.');
			return
		}

	// clean container
		while (response_message.firstChild) {
			response_message.removeChild(response_message.firstChild);
		}

	// render base nodes for stream display
		const render_response = render_stream({
			container	: response_message,
			id			: process_id,
			// the raw chunk moves into the tool's own collapsed Diagnostics →
			// Raw response disclosure: always available (no SHOW_DEBUG gate),
			// but no longer a wall of JSON above everything else
			display_json: false,
			on_stop		: () => {
				data_manager.request({
					url : typeof DEDALO_DIFFUSION_API_URL !== 'undefined' ? DEDALO_DIFFUSION_API_URL : data_manager.url,
					body : {
						dd_api		: 'dd_diffusion_api',
						action		: 'cancel_process',
						process_id	: process_id
					}
				})
				.then(function(response){
					if(SHOW_DEBUG===true) {
						console.log('cancel_process API response:', response);
					}
					if (request_failed(response)) {
						handle_api_error(response.error, {wrapper: response_message?.parentNode});
					}
				})
			}
		})

	// stream handlers
		// The publish path and the reconnect path share ONE implementation: the two
		// blocks used to be byte-duplicates, which is how a formatter drifts.
		const {on_read, on_done} = build_stream_handlers({
			self,
			item			: item,
			container		: response_message,
			render_response	: render_response,
			lock_items		: lock_items
		})

	// read stream
		data_manager.read_stream(stream, on_read, on_done)
}//end publish_content



/**
* UPDATE_PROCESS_STATUS
* Reconnect to an already-running diffusion SSE stream after a page reload.
*
* Called from check_process_data (inside render_container_bottom) when
* self.active_processes contains an entry whose process_id matches this panel.
* It opens a NEW get_process_status stream from the Bun API so the user can
* follow progress without having initiated the Publish click in this session.
*
* Behaviour is identical to publish_content's streaming loop because it IS the
* same code: both call build_stream_handlers. They previously held byte-identical
* copies of the reader, the formatter and the completion hook.
*
* (!) alert() is used on cancel_process errors — same reasoning as publish_content.
*
* @param {Object} options
* @param {Object}      options.self       - tool_diffusion instance.
* @param {Object}      [options.item]     - diffusion node descriptor; when absent
*                                           the subject line is derived from the
*                                           process_id and flagged as derived.
* @param {string}      options.process_id - SSE stream identifier to reconnect to.
* @param {HTMLElement} options.container  - Node to render progress into (response_message).
* @param {Array}       options.lock_items - Button elements to lock while stream is active.
* @returns {void}
*/
const update_process_status = (options) => {

	const self			= options.self
	const process_id	= options.process_id
	const container		= options.container
	const lock_items	= options.lock_items
	const item			= options.item // may be undefined on an unrecognised panel

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

	// get_process_status from diffusion API — polling reconnection
	data_manager.request_stream({
		url : typeof DEDALO_DIFFUSION_API_URL !== 'undefined'
			? DEDALO_DIFFUSION_API_URL
			: data_manager.url,
		body : {
			dd_api		: 'dd_diffusion_api',
			action		: 'get_process_status',
			update_rate	: 1000, // int milliseconds
			process_id	: process_id
		}
	})
	.then(function(stream){

		if (!stream) {
			console.error('Error: request_stream did not return a valid stream for process:', process_id);
			lock_items.forEach(el => el.classList.remove('loading'))
			return
		}

		// render base nodes and set functions to manage
		// the stream reader events
		const render_response = render_stream({
			container	: container,
			id			: process_id,
			display_json: false, // see the publish path — raw chunk lives in Diagnostics
			on_stop		: () => {
				data_manager.request({
					url : typeof DEDALO_DIFFUSION_API_URL !== 'undefined' ? DEDALO_DIFFUSION_API_URL : data_manager.url,
					body : {
						dd_api		: 'dd_diffusion_api',
						action		: 'cancel_process',
						process_id	: process_id
					}
				})
				.then(function(response){
					if(SHOW_DEBUG===true) {
						console.log('cancel_process API response:', response);
					}
					if (request_failed(response)) {
						handle_api_error(response.error, {wrapper: container});
					}
				})
			}
		})

		// stream handlers (the SAME implementation the publish path uses)
		const {on_read, on_done} = build_stream_handlers({
			self,
			item			: item,
			container		: container,
			render_response	: render_response,
			lock_items		: lock_items
		})

		// read stream
		data_manager.read_stream(stream, on_read, on_done)
	})
	.catch((error) => {
		// request_stream REJECTS on a network failure or a non-2xx response
		// (it used to leave the promise pending forever, which is why this
		// handler did not exist). Behaviour here is unchanged — the reconnect
		// simply does not happen — but the failure is now reported instead of
		// surfacing as an unhandled rejection.
		console.error('[tool_diffusion] could not follow process status:', error)
	})
}//end update_process_status



/**
* LABEL_EN
* English fallbacks for every string this report renders. The keys are final;
* the translated rows land in tools/tool_diffusion/register.json in a separate
* data-only commit, after which get_tool_label wins and these become the
* fallback path only. Shipping literals first keeps THIS diff reviewable.
* `{0}`-style placeholders are filled by printf (utils/util.js:571).
*/
const label_en = {
	// verdicts
	outcome_queued			: 'Queued',
	outcome_running			: 'Running',
	outcome_completed		: 'Completed',
	outcome_partial			: 'Partial',
	outcome_failed			: 'Failed',
	outcome_cancelled		: 'Cancelled',
	outcome_interrupted		: 'Interrupted',
	outcome_gone			: 'Process no longer tracked',
	outcome_unknown			: 'Unrecognised outcome',
	// metrics + subject
	metric_records			: '{0} records',
	metric_rows				: '{0} rows written',
	metric_files			: '{0} files written',
	subject_started			: 'started {0}',
	subject_last_id			: 'last id {0}',
	subject_derived			: 'subject derived from the process id',
	estimated				: 'estimated',
	estimate_exceeded		: 'estimate exceeded',
	// causes
	causes					: 'Causes',
	causes_dropped_note		: 'Per-record errors collected before the failure were not kept by the server. Only the causes above survive this run — see the server log.',
	// files
	files_title				: 'Files',
	file_kind_merged		: 'merged',
	file_kind_zip			: 'zip',
	file_kind_file			: 'file',
	files_unreported_note	: 'This format writes files (and a ZIP) to the diffusion files root, but the engine does not report their URLs. Use RDF or XML for downloadable output, or ask an administrator for the server path.',
	// errors
	errors_title			: 'Errors ({0})',
	errors_none				: 'none',
	errors_kept				: '{0} kept by server',
	errors_capped_note		: 'Showing the {0} errors the server kept. More may have occurred; the complete list exists only in the server log.',
	errors_occurrences		: '× {0}',
	errors_more_ids			: '+{0} more',
	error_source_job		: 'job',
	show_raw_errors			: 'Show raw error list ({0} lines, verbatim)',
	// tables
	tables_title			: 'Tables',
	classes_title			: 'Classes',
	tables_census			: '{0} of {1} plan tables wrote rows',
	tables_none_reported	: 'no table counts were reported for this run',
	tables_partial			: 'partial — the run did not finish',
	no_rows_note			: 'No plan table received any row. The run reported success but wrote nothing.',
	col_table				: 'Table',
	col_class				: 'Class',
	col_rows_written		: 'Rows written',
	col_rows_projected		: 'Rows projected',
	col_db_rows_changed		: 'DB rows changed',
	col_files_written		: 'Files written',
	col_affected			: 'Affected',
	delta_legend			: 'DB rows changed ≠ rows written: MariaDB counts 1 per insert, 2 per update, 0 when the row was already identical.',
	row_total				: 'TOTAL · {0} tables',
	show_zero_tables		: 'Show {0} tables that wrote nothing',
	hide_zero_tables		: 'Hide tables that wrote nothing',
	cancel_not_rollback		: 'A cancel is not a rollback. Everything committed before the stop stays published; the counts below are what actually landed.',
	// controls + diagnostics
	copy_tsv				: 'Copy TSV',
	copied					: 'Copied',
	diagnostics				: 'Diagnostics',
	raw_response			: 'Raw response',
	failure_message_raw		: 'Failure message (unsplit)',
	legacy_wrapper			: 'Legacy response wrapper',
	diag_job_state			: 'Job state',
	diag_status_line		: 'Status line',
	// The readout is a KEY column: its labels must be bare nouns. Reusing the
	// sentence labels here ('started {0}', '{0} records') leaked a literal
	// "{0}" into the UI, because a key is rendered with no printf arguments.
	diag_started_at			: 'Started at',
	diag_records_counted	: 'Records counted',
	diag_process_id			: 'Process id',
	diag_job_errors			: 'Job errors',
	diag_wall_clock			: 'Wall clock',
	// two DIFFERENT fields, so two different labels: data.current.time is the
	// engine's running clock for the attempt, data.total_ms is the total it
	// reports at the end. Labelling both the same made the readout look duplicated.
	diag_attempt_elapsed	: 'This attempt, cumulative elapsed',
	diag_reported_total_ms	: 'Reported total (ms)',
	diag_last_batch			: 'Last batch committed',
	diag_estimated_total	: 'Estimated total (client estimate, never corrected)',
	diag_counted_note		: 'primary-section records only; linked records resolved through relations are not counted'
}

/** Diagnostics readout: wire path → its translated key. */
const diag_key_of = {
	'state'						: 'diag_job_state',
	'process_id'				: 'diag_process_id',
	'started_at'				: 'diag_started_at',
	'total_time'				: 'diag_wall_clock',
	'data.msg'					: 'diag_status_line',
	'data.counter'				: 'diag_records_counted',
	'data.total'				: 'diag_estimated_total',
	'data.current.time'			: 'diag_attempt_elapsed',
	'data.current.section_id'	: 'diag_last_batch',
	'data.total_ms'				: 'diag_reported_total_ms',
	'errors'					: 'diag_job_errors'
}



/**
* BUILD_STREAM_HANDLERS
* The ONE stream-reader implementation, shared by publish_content (a fresh run)
* and update_process_status (reconnecting after a page reload). These two used
* to hold byte-identical copies of the reader, the message formatter and the
* completion hook — which is how a formatter silently drifts from its twin.
*
* @param {Object} options
* @param {Object}      options.self
* @param {Object}      [options.item] - diffusion node descriptor (subject line)
* @param {HTMLElement} options.container
* @param {Object}      options.render_response - the render_stream panel API
* @param {Array}       options.lock_items
* @return {Object} { on_read, on_done }
*/
const build_stream_handlers = function(options) {

	const self				= options.self
	const item				= options.item
	const container			= options.container
	const render_response	= options.render_response
	const lock_items		= options.lock_items || []

	let last_sse_response = null
	// The failure that ended the run is announced ONCE: a stream can deliver
	// several frames after it, and a diffusion run legitimately reports dozens of
	// per-record errors that are not this.
	let error_dispatched = false

	/**
	* ROUTE_FRAME_ERROR
	* A TERMINAL frame (or one read_stream could not parse) may carry the failure
	* that ended the run — envelope v2 `error`, or the COMPAT `errors[]` of a body
	* with no result. Everything else is a progress frame and says nothing here.
	*
	* @param {Object|null} sse_response
	*/
	const route_frame_error = (sse_response) => {

		if (error_dispatched || !sse_response) {
			return
		}
		const terminal = sse_response.is_running===false || is_api_error(sse_response.error)
		if (!terminal) {
			return
		}
		const api_error = normalize_stream_error(sse_response)
		if (!api_error) {
			return
		}
		error_dispatched = true
		// not awaited: the report panel must paint now, whatever surface the
		// policy chooses (a relogin overlay can stay open for minutes)
		handle_api_error(api_error, {wrapper: container, scope: 'tool_diffusion'})
			.catch((dispatch_error) => console.error('[tool_diffusion] error dispatch failed:', dispatch_error))
	}

	// on_read (every chunk)
	const on_read = (sse_response) => {

		render_response.update_info_node(
			sse_response,
			(info_node) => {

				const is_running = sse_response?.is_running ?? true

				if (!info_node.msg_node) {
					info_node.msg_node = ui.create_dom_element({
						element_type	: 'div',
						class_name		: 'msg_node' + (is_running===false ? ' done' : ''),
						parent			: info_node
					})
				}

				// One owner per fact: this line carries the server's status
				// message and NOTHING else — the counts, timings and ids it used
				// to concatenate now live in the report panel below, each in one
				// place. Set with textContent, never ui.update_node_content:
				// that helper is insertAdjacentHTML (ui.js:2035), and data.msg
				// carries server exception text and file paths straight from the
				// engine. This is the XSS fix for both former call sites.
				const frame_msg = sse_response?.data?.msg
				const line = frame_msg
					? String(frame_msg)
					: (is_running
						? 'Process running… please wait'
						: 'Process completed in ' + (sse_response?.total_time ?? ''))
				info_node.msg_node.textContent = line
			}
		)

		render_run_report({self, item, sse_response, container})

		route_frame_error(sse_response)

		last_sse_response = sse_response
	}

	// on_done (once, at close or cancel)
	const on_done = () => {

		render_response.done()

		lock_items.forEach(el => {
			el.classList.remove('loading')
		})

		// idempotent: same chunk, same signature — a no-op unless the last
		// read and the close disagree
		render_run_report({self, item, sse_response:last_sse_response, container})
	}

	return {on_read, on_done}
}//end build_stream_handlers



/**
* RENDER_RUN_REPORT
* Render (or update in place) the run report panel.
*
* GATED ON NOTHING. Its predecessor required `engine_result.tables` to exist,
* which meant a failed run — the case where a report matters most — rendered
* nothing at all, and an rdf/xml run (whose `tables` is a truthy `[]`) could
* never reach its download buttons. Both defects were properties of the branch
* structure, so the structure is gone: every chunk produces a panel, and what
* differs is only which zones open, per the severity ladder in report_model.js.
*
* Every node is built with text_content. No inner_html, no update_node_content.
*
* @param {Object} options
* @param {Object}      options.self
* @param {Object}      [options.item]
* @param {Object}      options.sse_response - may be null → the unknown skeleton
* @param {HTMLElement} options.container
* @return {HTMLElement} the panel
*/
const render_run_report = function(options) {

	const self			= options.self
	const item			= options.item
	const sse_response	= options.sse_response
	const container		= options.container

	if (!container) {
		return null
	}

	// label resolver: translated key first, English literal second, key last
	const tl = (key, ...rest) => {
		const translated = self?.get_tool_label ? self.get_tool_label(key, ...rest) : null
		if (translated) {
			return translated
		}
		const literal = label_en[key] ?? key
		return rest.length > 0 ? printf(literal, ...rest) : literal
	}

	// grouped numbers, so 1224190 reads as a quantity and not a serial number
	const fmt_n = (n) => Number(n ?? 0).toLocaleString()

	const model = build_report_model(sse_response, {
		item			: item,
		section_tipo	: item?.section_tipo ?? null
	})

	// panel lookup — updated in place, never appended twice
	let panel = container.querySelector(':scope > .diffusion_report.run_report')
	if (!panel) {
		panel = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'diffusion_report run_report',
			parent			: container
		})
	}

	// Flicker guard: while running we get ~2 chunks/second. Rebuilding the DOM
	// on each would fight the user's scroll and slam any disclosure they opened.
	// The signature ignores the values that legitimately tick every chunk, so a
	// pure progress update touches only three text nodes.
	const signature = JSON.stringify({
		outcome	: model.outcome,
		severity: model.severity,
		tables	: model.tables.rows.length,
		nonzero	: model.tables.nonzero_count,
		errors	: model.issues.total,
		files	: model.files.entries.length,
		causes	: model.causes.list.length
	})
	const progress_only = panel.dataset.signature === signature
	if (progress_only) {
		const metrics_node	= panel.querySelector('.run_metrics')
		const fill_node		= panel.querySelector('.run_bar_fill')
		const note_node		= panel.querySelector('.run_bar_note')
		if (metrics_node)	metrics_node.textContent	= build_metrics_text(model, tl, fmt_n)
		if (fill_node)		fill_node.style.width		= model.progress.percent + '%'
		if (note_node)		note_node.textContent		= build_bar_note(model, tl)
		return panel
	}
	panel.dataset.signature	= signature
	panel.dataset.outcome	= model.outcome
	panel.className			= 'diffusion_report run_report state_' + model.severity
	panel.replaceChildren()

	// ── verdict ──────────────────────────────────────────────────────────────
	const verdict = ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'run_verdict',
		parent			: panel
	})
	ui.create_dom_element({
		element_type	: 'span',
		class_name		: 'dd_badge state_' + model.severity,
		text_content	: tl('outcome_' + model.outcome),
		parent			: verdict
	})
	ui.create_dom_element({
		element_type	: 'span',
		class_name		: 'run_metrics',
		text_content	: build_metrics_text(model, tl, fmt_n),
		parent			: verdict
	})
	// the server's own sentence, shown when it carries meaning beyond the badge
	if (model.headline && model.severity !== 'ok') {
		ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'run_headline',
			text_content	: model.headline,
			parent			: panel
		})
	}

	// ── subject ──────────────────────────────────────────────────────────────
	const subject_parts = []
	if (model.subject.label)		subject_parts.push(model.subject.label)
	else if (model.subject.element_tipo) subject_parts.push(model.subject.element_tipo)
	if (model.subject.section_tipo)	subject_parts.push('→ ' + model.subject.section_tipo)
	if (model.format)				subject_parts.push(model.format.toUpperCase())
	if (model.subject.started_at_ms) {
		subject_parts.push(tl('subject_started', new Date(model.subject.started_at_ms).toLocaleTimeString()))
	}
	if (model.is_running && model.subject.last_section_id !== null) {
		subject_parts.push(tl('subject_last_id', model.subject.last_section_id))
	}
	if (model.subject.derived_from_process_id) {
		subject_parts.push('(' + tl('subject_derived') + ')')
	}
	ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'run_subject',
		text_content	: subject_parts.join(' · '),
		parent			: panel
	})

	// ── progress ─────────────────────────────────────────────────────────────
	if (model.progress.show) {
		const progress_node = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'run_progress',
			parent			: panel
		})
		const bar = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'run_bar',
			parent			: progress_node
		})
		const fill = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'run_bar_fill',
			parent			: bar
		})
		fill.style.width = model.progress.percent + '%'
		ui.create_dom_element({
			element_type	: 'span',
			class_name		: 'run_bar_note',
			text_content	: build_bar_note(model, tl),
			parent			: progress_node
		})
	}

	// ── causes (failure) ─────────────────────────────────────────────────────
	if (model.causes.list.length > 0) {
		const zone = build_zone(panel, 'zone_causes', tl('causes'), model.causes.list.length)
		const list = ui.create_dom_element({
			element_type	: 'ol',
			class_name		: 'run_cause_list',
			parent			: zone
		})
		model.causes.list.forEach((cause) => {
			ui.create_dom_element({
				element_type	: 'li',
				class_name		: 'run_cause',
				text_content	: cause,
				parent			: list
			})
		})
		if (model.causes.dropped) {
			ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'dd_note state_warning causes_dropped_note',
				text_content	: tl('causes_dropped_note'),
				parent			: zone
			})
		}
	}

	// ── files ────────────────────────────────────────────────────────────────
	if (model.files.entries.length > 0 || model.files.unreported_format) {
		const zone = build_zone(panel, 'zone_files', tl('files_title'), model.files.entries.length)
		if (model.files.entries.length > 0) {
			const grid = ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'dd_table files_table',
				parent			: zone
			})
			model.files.entries.forEach((entry) => {
				const row = ui.create_dom_element({
					element_type	: 'div',
					class_name		: 'dd_tr',
					parent			: grid
				})
				ui.create_dom_element({
					element_type	: 'div',
					class_name		: 'dd_td kind',
					text_content	: tl('file_kind_' + entry.kind),
					parent			: row
				})
				ui.create_dom_element({
					element_type	: 'div',
					class_name		: 'dd_td name',
					text_content	: entry.name,
					parent			: row
				})
				const act = ui.create_dom_element({
					element_type	: 'div',
					class_name		: 'dd_td act',
					parent			: row
				})
				const button = ui.create_dom_element({
					element_type	: 'button',
					class_name		: 'download warning',
					text_content	: (get_label.download || 'Download'),
					parent			: act
				})
				button.addEventListener('click', function(e) {
					e.stopPropagation()
					// the artifact URL rides the MEDIA address: absolute on a
					// split-origin install, root-relative otherwise
					const url = report_download_url(entry.url, window.location.origin)
					if (url !== null) open_window({url : url})
				})
			})
		}
		if (model.files.unreported_format) {
			ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'dd_note state_warning files_unreported_note',
				text_content	: tl('files_unreported_note'),
				parent			: zone
			})
		}
	}

	// ── errors ───────────────────────────────────────────────────────────────
	{
		const issues = model.issues
		const zone = build_zone(panel, 'zone_errors', tl('errors_title', issues.total), null)
		if (issues.total === 0) {
			ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'dd_empty',
				text_content	: tl('errors_none'),
				parent			: zone
			})
		} else {
			if (issues.capped) {
				ui.create_dom_element({
					element_type	: 'div',
					class_name		: 'dd_note state_warning errors_capped',
					text_content	: tl('errors_capped_note', issues.total),
					parent			: zone
				})
			}
			issues.groups.forEach((group) => {
				const group_node = ui.create_dom_element({
					element_type	: 'div',
					class_name		: 'error_group',
					parent			: zone
				})
				const head = ui.create_dom_element({
					element_type	: 'div',
					class_name		: 'error_group_head',
					parent			: group_node
				})
				ui.create_dom_element({
					element_type	: 'span',
					class_name		: 'error_text',
					text_content	: group.text,
					parent			: head
				})
				if (group.count > 1) {
					ui.create_dom_element({
						element_type	: 'span',
						class_name		: 'dd_badge error_count',
						text_content	: tl('errors_occurrences', group.count),
						parent			: head
					})
				}
				if (group.source === 'job') {
					ui.create_dom_element({
						element_type	: 'span',
						class_name		: 'dd_badge job',
						text_content	: tl('error_source_job'),
						parent			: head
					})
				}
				if (group.ids.length > 0) {
					const shown = group.ids.slice(0, 3)
					const rest	= group.ids.length - shown.length
					ui.create_dom_element({
						element_type	: 'div',
						class_name		: 'error_ids',
						text_content	: shown.join(', ') + (rest > 0 ? ', ' + tl('errors_more_ids', rest) : ''),
						parent			: group_node
					})
				}
			})
			// verbatim list + TSV — grouping is a view, never the only copy
			const raw_toggle = ui.create_dom_element({
				element_type	: 'span',
				class_name		: 'run_toggle toggle_raw_errors',
				text_content	: tl('show_raw_errors', issues.raw.length),
				parent			: zone
			})
			const raw_errors = ui.create_dom_element({
				element_type	: 'pre',
				class_name		: 'run_console raw_errors hide',
				text_content	: issues.raw.join('\n'),
				parent			: zone
			})
			add_toggle(raw_toggle, raw_errors, 'collapsed_tool_diffusion_report_errors_raw', false)
			add_copy_button(zone, () => tsv_errors(model), tl)
		}
	}

	// ── tables ───────────────────────────────────────────────────────────────
	{
		const is_class_list	= model.format === 'rdf' || model.format === 'xml'
		const zone			= build_zone(
			panel,
			'zone_tables',
			tl(is_class_list ? 'classes_title' : 'tables_title'),
			null
		)
		// the census rides on the zone's own eyebrow, NOT a sibling lookup
		const census_text = model.tables.none_reported
			? ''
			: (model.outcome === 'cancelled' || model.outcome === 'interrupted'
				? tl('tables_partial')
				: tl('tables_census', model.tables.nonzero_count, model.tables.total_count))
		const tables_eyebrow = zone.querySelector(':scope > .dd_eyebrow')
		if (census_text !== '' && tables_eyebrow) {
			ui.create_dom_element({
				element_type	: 'span',
				class_name		: 'zone_count',
				text_content	: census_text,
				parent			: tables_eyebrow
			})
		}

		if (model.outcome === 'cancelled') {
			ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'dd_note state_warning',
				text_content	: tl('cancel_not_rollback'),
				parent			: zone
			})
		}
		if (model.all_zero_anomaly) {
			ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'dd_note state_warning no_rows_note',
				text_content	: tl('no_rows_note'),
				parent			: zone
			})
		}

		if (model.tables.none_reported) {
			ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'dd_empty',
				text_content	: tl('tables_none_reported'),
				parent			: zone
			})
		} else {
			const grid = ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'dd_table tables_report',
				parent			: zone
			})
			const col_left	= is_class_list ? 'col_class' : 'col_table'
			const col_mid	= (model.is_file_format && !model.is_table_format) ? 'col_rows_projected' : 'col_rows_written'
			const col_right	= model.is_table_format
				? 'col_db_rows_changed'
				: (model.is_file_format ? 'col_files_written' : 'col_affected')
			;[[col_left,''], [col_mid,' num'], [col_right,' num']].forEach(([key, extra]) => {
				ui.create_dom_element({
					element_type	: 'div',
					class_name		: 'dd_th' + extra,
					text_content	: tl(key),
					parent			: grid
				})
			})
			// The grid is FLAT: the three heading cells are direct children of the
			// .dd_table and are laid out by grid-template-columns, so there is no
			// header ROW element to create. The heading TEXT is format-dependent —
			// the same two numbers mean different things per target (sql: rows
			// written vs rows MariaDB reports changed; rdf/xml: rows projected vs
			// files written) — and falls back to a neutral word when the format is
			// unknown rather than asserting either meaning.

			// non-zero first (the signal), then every zero row in PLAN ORDER,
			// hidden but present — "show all" is a class flip, never a re-fetch
			const append_row = (row) => {
				const tr = ui.create_dom_element({
					element_type	: 'div',
					class_name		: 'dd_tr' + (row.zero ? ' zero hide' : ''),
					parent			: grid
				})
				ui.create_dom_element({
					element_type	: 'div',
					class_name		: 'dd_td target',
					text_content	: row.table_name,
					parent			: tr
				})
				ui.create_dom_element({
					element_type	: 'div',
					class_name		: 'dd_td num',
					text_content	: fmt_n(row.records_count),
					parent			: tr
				})
				ui.create_dom_element({
					element_type	: 'div',
					class_name		: 'dd_td num' + (row.delta ? ' flag_delta' : ''),
					text_content	: fmt_n(row.records_affected),
					parent			: tr
				})
				return tr
			}
			model.tables.rows.filter(r => !r.zero).forEach(append_row)
			const zero_rows = model.tables.rows.filter(r => r.zero).map(append_row)

			// totals
			const total_row = ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'dd_tr total_row',
				parent			: grid
			})
			ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'dd_td target',
				text_content	: tl('row_total', model.tables.total_count),
				parent			: total_row
			})
			ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'dd_td num',
				text_content	: fmt_n(model.tables.totals.records_count),
				parent			: total_row
			})
			ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'dd_td num',
				text_content	: fmt_n(model.tables.totals.records_affected),
				parent			: total_row
			})

			if (model.tables.any_delta) {
				ui.create_dom_element({
					element_type	: 'div',
					class_name		: 'dd_note delta_legend',
					text_content	: tl('delta_legend'),
					parent			: zone
				})
			}
			if (zero_rows.length > 0) {
				const zero_toggle = ui.create_dom_element({
					element_type	: 'span',
					class_name		: 'run_toggle toggle_zero_tables',
					text_content	: tl('show_zero_tables', zero_rows.length),
					parent			: zone
				})
				let zeros_open = model.zone_open.tables_zeros
				const paint_zeros = () => {
					zero_rows.forEach(tr => tr.classList.toggle('hide', !zeros_open))
					zero_toggle.textContent = zeros_open
						? tl('hide_zero_tables')
						: tl('show_zero_tables', zero_rows.length)
					zero_toggle.classList.toggle('open', zeros_open)
				}
				paint_zeros()
				zero_toggle.addEventListener('click', () => {
					zeros_open = !zeros_open
					paint_zeros()
				})
			}
			add_copy_button(zone, () => tsv_tables(model), tl)
		}
	}

	// ── diagnostics ──────────────────────────────────────────────────────────
	{
		const zone = build_zone(panel, 'zone_diagnostics', null, null)
		const diag_toggle = ui.create_dom_element({
			element_type	: 'span',
			class_name		: 'run_toggle toggle_diagnostics',
			text_content	: tl('diagnostics'),
			parent			: zone
		})
		const body = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'diagnostics_body hide',
			parent			: zone
		})
		add_toggle(diag_toggle, body, 'collapsed_tool_diffusion_report_diagnostics', model.zone_open.diagnostics)

		// ENUMERATED, never hand-listed: report_model emits every wire path a
		// primary zone did not consume, so a field added to the wire tomorrow
		// appears here by itself instead of vanishing from the UI.
		const readout = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'dd_readout',
			parent			: body
		})
		model.diagnostics.forEach((entry) => {
			const row = ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'dd_row' + (entry.kind === 'unknown' ? ' uncurated' : ''),
				parent			: readout
			})
			const key_text = entry.kind === 'known' && diag_key_of[entry.path]
				? tl(diag_key_of[entry.path])
				: entry.path
			ui.create_dom_element({
				element_type	: 'span',
				class_name		: 'dd_k',
				text_content	: key_text,
				parent			: row
			})
			ui.create_dom_element({
				element_type	: 'span',
				class_name		: 'dd_v',
				text_content	: (entry.value === null || entry.value === undefined)
					? '—'
					: (typeof entry.value === 'object' ? JSON.stringify(entry.value) : String(entry.value)),
				parent			: row
			})
		})

		// the unsplit failure text, in case the split ever mangles it
		if (model.causes.raw) {
			add_console_disclosure(body, tl('failure_message_raw'), model.causes.raw,
				'failure_message_raw', 'collapsed_tool_diffusion_report_failure_raw', false)
		}
		if (model.legacy_wrapper) {
			add_console_disclosure(body, tl('legacy_wrapper'), model.legacy_wrapper,
				'legacy_wrapper', 'collapsed_tool_diffusion_report_legacy', false)
		}
		// the complete chunk, verbatim — this is what display_json_box used to
		// dump unconditionally at the top of the panel
		add_console_disclosure(body, tl('raw_response'), model.raw_json,
			'raw_response', 'collapsed_tool_diffusion_report_raw', model.zone_open.raw)
	}

	return panel
}//end render_run_report



/**
* BUILD_METRICS_TEXT
* The verdict's one-line quantity summary. Rows for table targets, files for
* file targets; the record count always leads because it is the thing the user
* asked to publish.
*
* @param {Object} model
* @param {Function} tl
* @param {Function} fmt_n
* @return {string}
*/
const build_metrics_text = function(model, tl, fmt_n) {

	const parts = []

	if (model.is_running) {
		parts.push(fmt_n(model.metrics.counter) + (model.metrics.total > 0 ? ' / ' + fmt_n(model.metrics.total) : ''))
	} else {
		parts.push(tl('metric_records', fmt_n(model.metrics.counter)))
	}
	if (model.files.entries.length > 0) {
		parts.push(tl('metric_files', fmt_n(model.files.entries.length)))
	} else if (!model.tables.none_reported) {
		parts.push(tl('metric_rows', fmt_n(model.metrics.sum_records_count)))
	}
	if (model.metrics.total_time) {
		parts.push(model.metrics.total_time)
	} else if (model.metrics.total_ms !== null) {
		parts.push(time_unit_auto(model.metrics.total_ms))
	}

	return parts.join(' · ')
}//end build_metrics_text



/**
* BUILD_BAR_NOTE
* Progress-bar caption. `total` is a CLIENT estimate the server never corrects,
* so it is always labelled as such — and when the counter overtakes it we say
* so rather than rendering a bar past 100 %.
*
* @param {Object} model
* @param {Function} tl
* @return {string}
*/
const build_bar_note = function(model, tl) {
	return model.progress.exceeded
		? tl('estimate_exceeded')
		: model.progress.percent + ' % (' + tl('estimated') + ')'
}//end build_bar_note



/**
* BUILD_ZONE
* One report section: an eyebrow heading plus its body. Returns the body.
*
* @param {HTMLElement} panel
* @param {string} class_name
* @param {string|null} title
* @param {number|null} count
* @return {HTMLElement}
*/
const build_zone = function(panel, class_name, title, count) {

	const zone = ui.create_dom_element({
		element_type	: 'section',
		class_name		: 'run_zone ' + class_name,
		parent			: panel
	})
	if (title) {
		const head = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'dd_eyebrow',
			text_content	: title,
			parent			: zone
		})
		if (count !== null && count !== undefined) {
			ui.create_dom_element({
				element_type	: 'span',
				class_name		: 'zone_count',
				text_content	: String(count),
				parent			: head
			})
		}
	}
	return zone
}//end build_zone



/**
* ADD_TOGGLE
* Wire a show/hide control. When `force_open` the zone is rendered OPEN with a
* plain toggle and its state is NOT persisted: a danger-severity panel must not
* be able to hide its own evidence because the user collapsed it three runs ago.
* collapse_toggle_track resolves asynchronously off the local DB, so it would
* also race a post-hoc classList change.
*
* @param {HTMLElement} toggler
* @param {HTMLElement} body
* @param {string} collapsed_id
* @param {boolean} force_open
* @return {void}
*/
const add_toggle = function(toggler, body, collapsed_id, force_open) {

	if (force_open===true) {
		body.classList.remove('hide')
		toggler.classList.add('open')
		toggler.addEventListener('click', () => {
			const hidden = body.classList.toggle('hide')
			toggler.classList.toggle('open', !hidden)
		})
		return
	}

	ui.collapse_toggle_track({
		toggler			: toggler,
		container		: body,
		collapsed_id	: collapsed_id,
		default_state	: 'closed'
	})
}//end add_toggle



/**
* ADD_CONSOLE_DISCLOSURE
* A labelled toggle over a monospace <pre>. Used for every verbatim payload.
*
* @param {HTMLElement} parent
* @param {string} label
* @param {string} text
* @param {string} class_name
* @param {string} collapsed_id
* @param {boolean} force_open
* @return {void}
*/
const add_console_disclosure = function(parent, label, text, class_name, collapsed_id, force_open) {

	const toggler = ui.create_dom_element({
		element_type	: 'span',
		class_name		: 'run_toggle',
		text_content	: label,
		parent			: parent
	})
	const pre = ui.create_dom_element({
		element_type	: 'pre',
		class_name		: 'run_console ' + class_name + ' hide',
		text_content	: text,
		parent			: parent
	})
	add_toggle(toggler, pre, collapsed_id, force_open)
}//end add_console_disclosure



/**
* ADD_COPY_BUTTON
* Copy-to-clipboard for a TSV payload. On a non-secure origin the Clipboard API
* rejects; rather than failing silently we reveal the text and select it so the
* user can copy by hand.
*
* @param {HTMLElement} parent
* @param {Function} get_text
* @param {Function} tl
* @return {void}
*/
const add_copy_button = function(parent, get_text, tl) {

	const button = ui.create_dom_element({
		element_type	: 'button',
		class_name		: 'copy_tsv',
		text_content	: tl('copy_tsv'),
		parent			: parent
	})
	button.addEventListener('click', (e) => {
		e.stopPropagation()
		const text = get_text()
		const done = () => {
			button.textContent = tl('copied')
			setTimeout(() => { button.textContent = tl('copy_tsv') }, 2000)
		}
		if (navigator.clipboard && window.isSecureContext) {
			navigator.clipboard.writeText(text).then(done).catch(() => fallback_select(parent, text))
			return
		}
		fallback_select(parent, text)
	})
}//end add_copy_button



/**
* FALLBACK_SELECT
* Clipboard unavailable: show the payload and select it, never fail quietly.
*
* @param {HTMLElement} parent
* @param {string} text
* @return {void}
*/
const fallback_select = function(parent, text) {

	let pre = parent.querySelector(':scope > pre.run_console.copy_fallback')
	if (!pre) {
		pre = ui.create_dom_element({
			element_type	: 'pre',
			class_name		: 'run_console copy_fallback',
			text_content	: text,
			parent			: parent
		})
	}
	pre.classList.remove('hide')
	pre.textContent = text
	const range = document.createRange()
	range.selectNodeContents(pre)
	const selection = window.getSelection()
	selection.removeAllRanges()
	selection.addRange(range)
}//end fallback_select




/**
* RENDER_ENGINE_ADVISORY
* Calm, role-tailored banner shown when the diffusion engine is unreachable or
* unhealthy. Admins get cause + steps + a Retry action; regular users get a
* reassuring notice. Data comes from dd_diffusion_api::get_engine_advisory.
*
* (!) Natively this banner does not render: buildEngineAdvisory hardcodes
* state:'ok' because the engine is in-process, and get_content_data only calls
* this when state!=='ok'. It is kept as the shape a real unhealthy verdict would
* use (a target DB going away is the plausible one), NOT as live UI.
* @param instance self @param object advisory @param HTMLElement parent
*/
const render_engine_advisory = function(self, advisory, parent) {

	const state_class = advisory.state === 'unhealthy' ? 'unhealthy' : 'unreachable'
	const banner = ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'diffusion_engine_advisory ' + state_class,
		parent			: parent
	})

	ui.create_dom_element({
		element_type	: 'h3',
		class_name		: 'advisory_title',
		text_content	: advisory.title || (get_label.diffusion_unavailable || 'Diffusion is temporarily unavailable'),
		parent			: banner
	})

	if (advisory.cause) {
		ui.create_dom_element({
			element_type	: 'p',
			class_name		: 'advisory_cause',
			text_content	: advisory.cause,
			parent			: banner
		})
	}

	if (Array.isArray(advisory.steps) && advisory.steps.length) {
		const list = ui.create_dom_element({ element_type:'ul', class_name:'advisory_steps', parent:banner })
		advisory.steps.forEach(step => ui.create_dom_element({
			element_type:'li', text_content:step, parent:list
		}))
	}

	// actions
	const actions = Array.isArray(advisory.actions) ? advisory.actions : ['retry']
	const bar = ui.create_dom_element({ element_type:'div', class_name:'advisory_actions', parent:banner })

	const reload = async () => {
		const fresh = await self.get_engine_advisory()
		self.engine_advisory = fresh
		self.bun_status = {
			result : fresh.state === 'ok',
			msg    : fresh.state === 'ok' ? 'Ready' : (fresh.title || 'Unavailable'),
			checks : fresh.checks || null
		}
		if (fresh.state === 'ok') {
			// engine recovered: rebuild the full tool body
			self.refresh()
		} else {
			// still down: re-render just this banner in place, no full rebuild
			const frag = new DocumentFragment()
			render_engine_advisory(self, fresh, frag)
			banner.replaceWith(frag)
		}
	}

	// Retry is the ONLY action (WC-076). 'restart_engine' and 'show_log' were
	// removed with the daemon they addressed: the first restarted the external
	// diffusion service, the second tailed its log file. Neither referent exists
	// natively — the engine is this process, and its log is the server's journal.
	if (actions.includes('retry')) {
		const btn = ui.create_dom_element({ element_type:'button', class_name:'button retry', text_content:get_label.retry || 'Retry', parent:bar })
		btn.addEventListener('click', () => reload())
	}

	return banner
}//end render_engine_advisory



// @license-end
