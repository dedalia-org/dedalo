// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_label, page_globals, SHOW_DEBUG, DEDALO_CORE_URL, tool_propagate_component_data */
/*eslint no-undef: "error"*/



// imports
	import {ui} from '../../../core/common/js/ui.js'
	import {data_manager} from '../../../core/common/js/data_manager.js'
	import {event_manager} from '../../../core/common/js/event_manager.js'
	import {render_stream} from '../../../core/common/js/render_common.js'
	import {is_filter_empty} from '../../../core/search/js/search.js'
	import {response_data} from '../../../core/common/js/api_error.js'
	import {error_text} from '../../../core/common/js/render_api_error.js'
	import {get_caller_by_model, append_text_lines} from '../../../core/common/js/utils/index.js'



/**
* RENDER_TOOL_PROPAGATE_COMPONENT_DATA
*
* Client-side render layer for the tool_propagate_component_data tool.
*
* This module provides the DOM-building logic that turns a
* `tool_propagate_component_data` instance into an interactive edit panel.
* It is consumed exclusively by `tool_propagate_component_data.js`, which
* assigns `render_tool_propagate_component_data.prototype.edit` onto the
* tool's prototype chain.
*
* Responsibilities:
*  - Build the full edit panel: section info header, component editor widget,
*    three action buttons (Replace / Add / Delete), confirmation dialogs, and
*    a live SSE progress reporter.
*  - Guard against invalid caller contexts (requires a section in edit mode
*    three levels up: tool → component → section_group → section).
*  - Snapshot `section.rqo.sqo` at click time and send it to the PHP back-end
*    via `self.propagate_component_data()`, which runs the bulk operation in a
*    background CLI process.
*  - Poll `dd_utils_api::get_process_status` via a Server-Sent Events stream and
*    stream progress messages into the response panel until the CLI process ends.
*
* Caller context chain (three levels up from the tool):
*   tool_propagate_component_data (self)
*     → caller: component (e.g. component_json that hosts the tool button)
*       → caller: section_group
*         → caller: section  (must be model='section', mode='edit')
*
* Exports:
*  - render_tool_propagate_component_data  (constructor, prototype host)
*
* Noteworthy globals used but NOT imported (declared in the /*global* / header):
*  - event_manager  (module-global from the page bootstrap; used to publish/
*    subscribe the 'process_done' cross-component event)
*
* @see tools/tool_propagate_component_data/js/tool_propagate_component_data.js
* @see core/common/js/render_common.js (render_stream)
*/
export const render_tool_propagate_component_data = function() {

	return true
}//end render_tool_propagate_component_data



/**
* SECTION MODES this tool accepts.
*
* An ALLOWLIST, deliberately — not a negation. Section modes are a closed set
* (section.js validate_mode: edit | list | list_thesaurus | solved | tm), and only
* these two carry an `rqo.sqo` that describes a real, current record set:
*
*   'edit' — the sqo_session of the list the user came from (section.js:654-678)
*   'list' — literally the search the user is looking at, when the tool is opened
*            from the per-cell edit modal (component_common activate_edit_in_list)
*
* 'solved' is not a user search; propagating
* against either would write a set the user never chose. 'list_thesaurus' needs no
* entry — section.js normalises it to 'list' on build, before any cell is
* clickable. A future mode is refused by default, which is the point of a list.
*/
export const ALLOWED_SECTION_MODES = ['edit', 'list']

/**
* RESOLVE_PROPAGATE_SECTION
* Find the section whose current search this tool should propagate across.
*
* Resolved by MODEL, never by DEPTH. The depth genuinely differs by surface:
*   edit mode : tool → component → section_group  → section
*   list mode : tool → component → section_record → section   (the edit modal)
* — so the historical `self.caller.caller?.caller` walk resolved a section_group
* in list mode and the tool refused to open. `get_caller_by_model` is also
* cycle-safe, which a hand-rolled loop would not be: tool_common's window path
* sets `caller.caller = self`, making the chain circular and a naive walk hang
* the tab.
*
* Two things are then checked, and both matter:
*
*  - the section must be one this tool accepts (ALLOWED_SECTION_MODES);
*  - the section must be the one the component BELONGS to. A component inside a
*    portal reaches the OUTER section, whose sqo describes a DIFFERENT record set
*    — propagating against it would write the wrong records. The old fixed-depth
*    walk refused that case by accident (it landed on a section_group); this
*    refuses it on purpose.
*
* Exported for unit testing: the resolution is pure over the caller chain, so it
* can be driven with synthetic instances instead of a live DOM.
*
* @param {Object} self - the tool instance
* @returns {{section: Object|null, reason: string}} the resolved section, or null
*   plus the user-facing reason it was refused.
*/
export const resolve_propagate_section = function(self) {

	const component = self?.caller || null
	if (!component) {
		return {section: null, reason: 'Caller section is unavailable'}
	}

	const nearest = get_caller_by_model(component, 'section')
	if (!nearest) {
		return {section: null, reason: 'Caller section is unavailable'}
	}

	// Ownership: the nearest section must be the component's own.
	if (component.section_tipo && nearest.tipo !== component.section_tipo) {
		return {
			section	: null,
			reason	: 'This component belongs to a different section than the one open here. Open its own section to propagate.'
		}
	}

	if (!ALLOWED_SECTION_MODES.includes(nearest.mode)) {
		return {
			section	: null,
			reason	: 'Sorry. Only edit and list modes are allowed. This tool works on the current search of a section.'
		}
	}

	return {section: nearest, reason: ''}
}//end resolve_propagate_section



/**
* EDIT
* Render the tool's full edit panel.
*
* Entry point called by `tool_common.prototype.render` after the tool is
* initialised and built.  Delegates all DOM work to the private
* `get_content_data` helper, then wraps the result in the standard tool
* wrapper returned by `ui.tool.build_wrapper_edit`.
*
* When `options.render_level === 'content'`, the raw `content_data` fragment
* is returned directly (used by callers that embed the tool inside another
* container rather than rendering a standalone wrapper).
*
* @param {Object} options - Render options forwarded from `tool_common.prototype.render`.
* @param {string} [options.render_level='full'] - 'full' renders the full wrapper;
*   'content' returns only the inner content_data node.
* @returns {Promise<HTMLElement>} Resolves to the tool wrapper (full) or
*   content_data node (content).
*/
render_tool_propagate_component_data.prototype.edit = async function(options) {

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
* Build the interactive body of the propagation tool panel.
*
* Constructs the entire edit-mode UI as a DocumentFragment that is then
* appended to the standard `content_data` node returned by
* `ui.tool.build_content_data`.  The fragment contains:
*
*  1. `section_info` — displays the host component's human label and tipo.
*  2. `components_list_container` — renders the `component_to_propagate`
*     instance (a temporary, standalone clone of the main component whose
*     value will be broadcast to all matching records).
*  3. `buttons_container` — informational text (field name + target record
*     count) and the three action buttons: Replace / Add / Delete.
*  4. `response_message` — live SSE progress area populated by
*     `update_process_status` while the background CLI runs.
*
* Guard: if the caller chain does not resolve to a section in edit mode, the
* function renders an error message instead of the normal UI and returns early.
*
* Filter awareness: `section.rqo.sqo.filter` is inspected via `is_filter_empty`
* to decide whether to show a blanket-replacement warning when the user clicks
* an action button without any active filter.
*
* Process resumption: immediately after building the UI, `check_process_data`
* looks up `local_db_id` in the browser's local DB. If a previous invocation
* stored a pid/pfile there (e.g. the panel was closed and re-opened mid-run),
* `update_process_status` is called again so the user can track the still-running
* background job.
*
* @param {Object} self - The `tool_propagate_component_data` instance.
*   Expected properties consumed here:
*   - `self.caller`               {Object} component that opened the tool
*   - `self.component_to_propagate` {Object} temporary component instance
*   - `self.main_element`         {Object} source component descriptor
*   - `self.config`               {Object} tool config (components_monovalue list)
*   - `self.total`                {number} snapshot of the section total (set here)
*   - `self.get_tool_label`       {Function} i18n label resolver
*   - `self.propagate_component_data` {Function} API call method
* @returns {Promise<HTMLElement>} Resolves to the populated `content_data` node.
*/
const get_content_data = async function(self) {

	// DocumentFragment
		const fragment = new DocumentFragment()

	// short vars
		const local_db_id	= 'process_propagate_component_data'
		const lock_items	= []; // nodes to lock on process data

	// section. Resolve the section that OWNS this component (see
	// resolve_propagate_section) and snapshot it, so the click handler and this
	// render pass can never disagree about which section's SQO is the target.
	// FIRST, before any DOM: everything below is about that section, and a refusal
	// must replace the whole panel rather than half-build it.
		const resolution = resolve_propagate_section(self)
		const section = resolution.section
		self.propagate_section = section
		if (!section) {
			console.error('Ignored call. Unable to get valid section. caller:', self.caller);
			const content_data = ui.tool.build_content_data(self)
			content_data.appendChild(ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'msg',
				text_content		: resolution.reason
			}))
			return content_data
		}

	// section_info
		const section_info = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'section_info',
			parent			: fragment
		})
		// section_name / section_tipo — the SECTION's, not the component's. These
		// two nodes are class-named for the section and sat in a `section_info`
		// block while showing the component's label and tipo, which is actively
		// misleading in a dialog that is about to rewrite every matched record.
		// The component's own label still appears where it belongs, in the
		// "content will be added/removed from the field: X" line below.
			ui.create_dom_element({
				element_type	: 'h3',
				class_name		: 'section_name',
				text_content		: section.label,
				parent			: section_info
			})
			ui.create_dom_element({
				element_type	: 'h3',
				class_name		: 'section_tipo',
				text_content		: section.tipo,
				parent			: section_info
			})

	// components_list_container
		const components_list_container = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'components_list_container',
			parent			: fragment
		})
		lock_items.push(components_list_container)

	// component_to_propagate. Await is ready to minimise flicker.
		const component_node = await self.component_to_propagate.render()
		components_list_container.appendChild(component_node)

	// buttons_container
		const buttons_container = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'buttons_container',
			parent			: fragment
		})
		lock_items.push(buttons_container)

	// filter. Check the filter to know if the user has apply some filter or if will apply to all records
		const sqo_filter = section.rqo && section.rqo.sqo && section.rqo.sqo.filter
			? section.rqo.sqo.filter
			: null

		// check if the filter is empty
		const filter_empty = sqo_filter
			? is_filter_empty(sqo_filter)
			: true

	// info_text
		// Capture the total now and snapshot it onto self so the PHP back-end
		// can validate that the client and server agree on the record count before
		// committing the bulk write (security check in class.tool_propagate_component_data.php).
		const total				= await section.get_total()
		self.total				= total // fix total to check before propagate changes in server
		const all_records_label	= self.get_tool_label('all_records') || 'All'
		// When no filter is active, prefix the count with "All" to make clear the
		// operation will touch every record in the section, not just the visible subset.
		const total_label		= (filter_empty === false)
			? String(total)
			: all_records_label+' - '+total
		// The sentence is built as NODES: the label template keeps its two
		// placeholders ({0} the field, {1} the count) and each is emitted as a
		// <strong> TEXT node — the field label is ontology text, never markup
		// (ZERO MARKUP CONCATENATION, render_escape_tripwire).
		const text_template = self.get_tool_label('content_will_be_added_removed', '{0}', '{1}')
			|| 'The content will be added or removed from the field: {0} s in the {1} current records'
		const info_text = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'info_text',
			parent			: buttons_container
		})
		const slots = { '{0}': self.caller.label, '{1}': total_label }
		for (const piece of text_template.split(/(\{0\}|\{1\})/)) {
			if (piece === '') continue
			if (Object.hasOwn(slots, piece)) {
				ui.create_dom_element({
					element_type	: 'strong',
					text_content	: slots[piece],
					parent			: info_text
				})
			}else{
				info_text.appendChild(document.createTextNode(piece))
			}
		}

	// click_handler
		// Shared handler for all three action buttons (replace / add / delete).
		// Reads `action` from the DOM property set on each button element, runs
		// two confirmation dialogs (a second one when no filter is active), then
		// fires the background propagation request and wires up SSE progress tracking.
		const click_handler = async (e) => {
			e.stopPropagation()

			// action. Get form button property 'action'
				const action = e.target.action
				if (['replace','add','delete'].includes(action)===false) {
					console.error('Invalid action (click_handler):', e.target.action);
					return
				}

			// deactivate current component
				await ui.component.deactivate(self.component_to_propagate)

			// propagate_component_data
				const confirm_msg = 'Action to do: ' + action
				+ '\n ' + (get_label.total || 'Total') + ': '  + total
				+ '\n' + (get_label.sure || 'Sure?')
				if (!confirm(confirm_msg)) {
					return
				}

			// warning user before execute when no filter is used
				if(filter_empty === true){
					const msg = 'WARNING!'
					+ '\n' + (self.get_tool_label('will_replaced_all_records') || 'Data will be replaced in absolutely all records in this section.')
					if (!confirm(msg)){
						return false
					}
				}

			// loading class
				content_data.classList.add('loading')

			// button spinner
				const button = e.target
				button.classList.add('button_spinner')

			// API request to propagate_component_data
				self.propagate_component_data(action)
				.then(function(api_response){

					// loading class
					content_data.classList.remove('loading')

					// fire update_process_status
					update_process_status({
						pid			: api_response.pid,
						pfile		: api_response.pfile,
						local_db_id	: local_db_id,
						container	: response_message,
						lock_items	: lock_items
					})

					// button spinner. Remove on process is done
					event_manager.subscribe('process_done', (el) => {
						if (el.pid ===  api_response.pid) {
							button.classList.remove('button_spinner')
							// Refresh the section the run just rewrote. In edit mode
							// this was invisible — one record on screen, and the
							// tool's own on_close refresh covered it. Opened from a
							// LIST cell it is the first thing the user sees: every
							// visible row still shows the pre-propagation value until
							// something re-reads. Guarded because a section may have
							// been closed while the background job ran.
							if (typeof section?.refresh === 'function') {
								section.refresh().catch((error) => {
									console.warn('Could not refresh section after propagation:', error);
								})
							}
						}
					})
				})
		}//end click_handler

	// button_replace
		const replace_label = self.get_tool_label('do_replace') || 'Replace values'
		const button_replace = ui.create_dom_element({
			element_type	: 'button',
			class_name		: 'warning add button_replace',
			text_content		: replace_label,
			parent			: buttons_container
		})
		button_replace.action = 'replace'
		button_replace.addEventListener('click', click_handler)

	// button_add
		// 'Add' is suppressed for mono-value component types (e.g. component_image,
		// component_select) because they can only hold a single value; adding to them
		// without replacing would be semantically undefined.
		// The list is sourced from self.config.components_monovalue (register.json dd1633).
		const components_monovalue = self.config?.components_monovalue
			? self.config.components_monovalue.value
			: []
		if (!components_monovalue.includes(self.main_element.model)) {
			const add_label = self.get_tool_label('tool_do_add') || 'Add'
			const button_add = ui.create_dom_element({
				element_type	: 'button',
				class_name		: 'warning add button_add',
				text_content		: add_label,
				parent			: buttons_container
			})
			button_add.action = 'add'
			button_add.addEventListener('click', click_handler)
		}

	// button_delete
		const delete_action_label = self.get_tool_label('tool_do_delete') || 'Delete'
		const button_delete = ui.create_dom_element({
			element_type	: 'button',
			class_name		: 'warning remove button_delete',
			text_content		: delete_action_label,
			parent			: buttons_container
		})
		button_delete.action = 'delete'
		button_delete.addEventListener('click', click_handler)

	// response_message
		const response_message = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'response_message',
			parent			: fragment
		})

	// check process status always
		// If a propagation was launched in a previous session or during a panel
		// re-open, retrieve the saved pid/pfile from the browser local DB and
		// resume streaming.  This ensures the UI reflects a still-running background
		// process even after the modal is closed and re-opened.
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
						lock_items	: lock_items
					})
				}
			})
		}
		check_process_data()

	// content_data
		const content_data = ui.tool.build_content_data(self)
		content_data.appendChild(fragment)


	return content_data
}//end get_content_data



/**
* UPDATE_PROCESS_STATUS
* Start or resume live SSE progress tracking for a background propagation job.
*
* This function is the bridge between the one-shot API call that launches the
* background CLI process and the streaming UI that shows per-record progress.
* It performs three things in sequence:
*
*  1. Visually locks the interactive widgets in `lock_items` (adds 'loading'
*     class) and blurs any focused button to avoid double-clicks.
*  2. Clears the `container` node and calls `data_manager.request_stream` to
*     open a Server-Sent Events connection to `dd_utils_api::get_process_status`
*     at 1-second intervals.
*  3. Hands the resulting ReadableStream to `data_manager.read_stream`, which
*     fires `on_read` on every SSE chunk and `on_done` when the PHP process exits.
*
* `on_read` builds a human-readable status line by concatenating the server's
* `data.msg`, `data.section_label`, a progress counter (`counter / total`),
* the current `section_id`, and the elapsed `total_time`.  This compound message
* is written into the info panel managed by `render_stream`.  On the TERMINAL
* frame it also renders the run report — `summary` + the per-record `errors` —
* which lives one level deeper, inside the handler's envelope (see the note at
* the call site).
*
* `on_done` removes the 'loading' class from all lock_items and publishes the
* `'process_done'` event via the imported `event_manager` singleton so that button
* spinners and other cross-component listeners can react.
*
* (!) `event_manager` is a module-global injected by the page bootstrap — it is
* declared in the file-level `/*global* /` comment but is NOT imported.  If the
* bootstrap fails to define it, the `on_done` callback will throw a ReferenceError.
*
* @param {Object} options - Configuration object.
* @param {number} options.pid - Unix process ID of the PHP CLI worker; used by
*   the Stop button inside `render_stream` to send a `stop_process` API call.
* @param {string} options.pfile - Path to the process output file; forwarded to
*   `dd_utils_api::get_process_status` for log retrieval.
* @param {string} options.local_db_id - Key under which the current pid/pfile are
*   persisted in the browser local DB so the status panel can be resumed after a
*   page reload or panel close/re-open.
* @param {HTMLElement} options.container - DOM node for the SSE progress panel;
*   its children are cleared before rendering.
* @param {Array<HTMLElement>} options.lock_items - DOM nodes to decorate with the
*   'loading' class during the process and clean up in `on_done`.
* @returns {void}
*/
const update_process_status = (options) => {

	const pid			= options.pid
	const pfile			= options.pfile
	const local_db_id	= options.local_db_id
	const container		= options.container
	const lock_items	= options.lock_items

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

		// on_read event (called on every chunk from stream reader)
		const on_read = (sse_response) => {

			// fire update_info_node on every reader read chunk
			render_response.update_info_node(sse_response, (info_node) => {

				const is_running = sse_response?.is_running ?? true

				// THE FINAL REPORT, at the end of the stream.
				//
				// (!) The last frame is NOT shaped like a progress frame. A progress
				// frame's `data` is the raw payload the handler published (msg /
				// section_label / counter / total); the TERMINAL frame's `data` is the
				// handler's whole ENVELOPE — src/core/tools/background.ts:210 ("the
				// RETURN VALUE becomes the final SSE frame's data") through
				// src/core/media/jobs.ts:628 (`record.data = result`). So the report
				// sits one level deeper, and `response_data` is the ONE accessor that
				// reaches it (`data`, then the compat `result` mirror); a progress
				// frame has neither, so it falls back to itself and nothing changes.
				//
				// Report keys (tools/tool_propagate_component_data/server/index.ts:298-311):
				//   summary — the run sentence (envelope v2 has NO success `msg`), and
				//             the ONLY place STOPPED / 'done with warnings' is said
				//   errors  — the per-record failures; the batch never fails as a whole
				// Before this the run simply ended on "Process completed in Ns": both
				// were composed by the server and neither ever reached the operator.
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

					// per-record failures. Also the frame's OWN `errors`: when the
					// handler throws outright there is no report at all, and the job
					// manager records the exception there (src/core/media/jobs.ts:630).
					const report_failures	= report.errors
					const frame_failures	= sse_response.errors
					const report_errors		= [
						...(Array.isArray(report_failures) ? report_failures : []),
						...(Array.isArray(frame_failures) ? frame_failures : [])
					]
					if (report_errors.length>0) {
						// TEXT nodes + real <br> elements: server text (record ids,
						// exception detail) must never be parsed as HTML. A bare string
						// prints as-is; a coded entry resolves through the ONE renderer.
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

				// compound_msg. Builds a pipe-separated progress string from all
				// available server fields: message, section label, counter/total,
				// current section_id, and elapsed time.  Shown only when the server
				// sends a non-trivial msg (length > 5) to avoid displaying a raw
				// JSON placeholder during process start-up.
				const compound_msg = (sse_response) => {
					const data = sse_response.data
					const parts = []
					parts.push(data.msg)
					if (data.section_label) {
						parts.push(data.section_label)
					}
					if (data.counter) {
						parts.push(data.counter +' '+ (get_label.of || 'of') +' '+ data.total)
					}
					if (data.current?.section_id) {
						parts.push('id: ' + data.current?.section_id)
					}
					parts.push(sse_response.total_time)
					return parts.join(' | ')
				}

				// Choose the best available message: compound when the server sends a
				// real msg; a generic wait/done string otherwise.
				const frame_line = sse_response && sse_response.data && sse_response.data.msg
				const msg = (typeof frame_line==='string' && frame_line.length>5)
					? compound_msg(sse_response)
					: is_running
						? 'Process running... please wait'
						: 'Process completed in ' + sse_response.total_time

				if(!info_node.msg_node) {
					info_node.msg_node = ui.create_dom_element({
						element_type	: 'div',
						class_name		: 'msg_node' + (is_running===false ? ' done' : ''),
						parent			: info_node
					})
				}
				// `msg` is server stream text (labels, record ids, exception details):
				// TEXT only — update_node_content parses HTML (DS-1).
				info_node.msg_node.textContent = msg
			})
		}

		// on_done event (called once at finish or cancel the stream read)
		const on_done = () => {
			// is triggered at the reader's closing
			render_response.done()
			// unlocks the lock_items
			lock_items.forEach(el =>{
				el.classList.remove('loading')
			})

			event_manager.publish('process_done', {
				pid : pid
			})
		}

		// read stream. Creates ReadableStream that fire
		// 'on_read' function on each stream chunk at update_rate
		// (1 second default) until stream is done (PID is no longer running)
		data_manager.read_stream(stream, on_read, on_done)
	})
	.catch((error) => {
		// request_stream REJECTS on a network failure or a non-2xx response (it
		// used to leave the promise pending forever, which is why this handler did
		// not exist). Behaviour is unchanged — the stream simply does not start —
		// but the failure is reported rather than surfacing as an unhandled
		// rejection.
		console.error('[tool_propagate_component_data] could not open the status stream:', error)
	})
}//end update_process_status



/**
* CREATE_RESPONSE
* Render a response node
* @param {Object} self
* @param {HTMLElement} response_message
* @param {Object} response
* @param {string} action
* @returns {HTMLElement} response_node
*/
	// const create_response = function(self, response_message, response, action) {

	// 	// clean the previous msg
	// 	while (response_message.firstChild) {
	// 		response_message.removeChild(response_message.firstChild)
	// 	}

	// 	const response_node = new DocumentFragment()

	// 	const successfully_node = ui.create_dom_element({
	// 		element_type	: 'div',
	// 		class_name		: 'successfully',
	// 		inner_html		: self.get_tool_label('successfully') || 'Successfully',
	// 		parent 			: response_node
	// 	})

	// 	const count_label	= self.get_tool_label('updated_records') || 'Updated records'
	// 	const count			= response.count ||  ''

	// 	const updated_records_node = ui.create_dom_element({
	// 		element_type	: 'div',
	// 		class_name		: 'updated_records',
	// 		inner_html		: count_label + ": " + count + ' ('+action+')',
	// 		parent			: response_node
	// 	})


	// 	return response_node
	// }// end create_response



// @license-end
