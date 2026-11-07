// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_label, page_globals, SHOW_DEBUG, DEDALO_CORE_URL, DEDALO_ROOT_WEB */
/*eslint no-undef: "error"*/



// imports
	import {ui} from '../../common/js/ui.js'
	import {data_manager} from '../../common/js/data_manager.js'
	import {event_manager} from '../../common/js/event_manager.js'
	import {request_failed, normalize_stream_error} from '../../common/js/api_error.js'
	import {handle_api_error} from '../../common/js/error_dispatch.js'
	import {render_error_inline} from '../../common/js/render_api_error.js'



/**
* RENDER_COMMON
* Shared DOM-rendering utilities used across multiple Dédalo features (search,
* tool_export, portals, etc.).
*
* Exports:
*  - render_components_list      Build a draggable component picker for a section.
*  - render_stream               Create a live-updating SSE progress panel.
*  - render_error                Render Dédalo standard inline error blocks.
*  - render_lang_behavior_check  Render the "search in all langs" toggle for translatable components.
*
* Internal (module-private):
*  - toggle_section_group_label_siblings  Collapse/expand a section_group label and its siblings.
*/



/**
* RENDER_COMPONENTS_LIST
* Build a draggable picker list of components and section groups for a given section,
* populating `options.target_div` with the result.
*
* The function iterates over `section_elements` (returned by the caller's
* `get_section_elements_context`) and creates one `<li>` element per component.
* Components with a `target_section_tipo` (portals, autocompletes) render a
* "has_subquery" pointer that, when clicked, recursively calls this same function
* to drill into the child section and display it inside `target_list_container`.
*
* Each generated `<li>` element receives:
*  - `.ddo`   — the raw section-element descriptor object.
*  - `.path`  — the resolved component path array (via `caller.calculate_component_path`).
*  - `data-path`, `data-tipo`, `data-section_tipo`, `data-section_id` attributes used
*    by drag-drop handlers.
*
* Side effects:
*  - Clears all children of `options.target_div` before rendering.
*  - Scrolls the window to the top after rendering.
*
* @see caller.get_section_elements_context
* @param {Object} options - Configuration object.
* @param {Object} options.self - Caller instance (e.g. search or tool_export); must
*   expose `calculate_component_path`, `get_section_id`, `on_dragstart`,
*   and `get_section_elements_context`. Optionally it may expose
*   `on_component_row({node, element, path})`, called once per draggable row
*   after that row is built — the hook a caller uses to add its own affordance
*   (search: a phone-only "+" that adds the field, since a finger cannot drag).
*   Callers without the hook are unaffected.
* @param {string} options.section_tipo - Ontology tipo of the section whose components
*   are being listed.
* @param {HTMLElement} options.target_div - Container to render into; its children
*   are fully replaced.
* @param {Array} options.path - Cumulative path array accumulated through recursive
*   portal/autocomplete drill-downs; pass `[]` at the root level.
* @param {Array} options.section_elements - Element descriptors from `get_section_elements_context`;
*   each object carries at minimum `{ model, tipo, section_tipo, label }` and optionally
*   `target_section_tipo` for portal/autocomplete linkage.
* @param {Array|null} [options.ar_components_exclude=null] - Optional list of component
*   tipos to suppress; forwarded verbatim to recursive calls.
 * @param {Array<string>} [options.ar_section_path=[]] - Ancestor SECTION labels, root first,
 *   nearest last, accumulated through the recursive portal drill-downs (`[]` at the root).
 *   Each level's bar renders the path (e.g. "People / Projects") in a `.section_bar_full_path`
 *   span. The phone layout shows it (a drilled level REPLACES its parents there, so the path
 *   is the only remaining context); the desktop layout keeps the plain level name.
* @returns {Array} Flat array of all `<li>` HTMLElement nodes created for individual
*   components (excludes section/group header nodes).
*/
export const render_components_list = function(options) {

	const ar_components = []

	// options
		const caller				= options.self // caller instance 'search' or 'tool_export'
		const section_tipo			= options.section_tipo
		const target_div			= options.target_div
		const path					= options.path
		const section_elements		= options.section_elements
		const ar_components_exclude = options.ar_components_exclude || null
		const ar_section_path		= options.ar_section_path || []

	// clean target_div
		target_div.replaceChildren()

	// First item check
	// section_elements[0] being undefined means the server returned an empty schema
	// context — guard before iteration to avoid silent no-ops.
		if (!section_elements || typeof section_elements[0]==="undefined") {
			console.warn(`[render_components_list] Warning. Empty section_elements on get_section_elements_context ${section_tipo} Nothing to render`, section_elements);
			return []
		}

	// list_container
	// Primary column that holds section headers, group labels, and component items.
		const list_container = ui.create_dom_element({
			element_type	: 'ul',
			class_name		: 'list_container',
			parent			: target_div
		})

	// target_list_container
	// Secondary column rendered to the right; used for portal/autocomplete drill-downs.
	// Populated lazily on component click via recursive render_components_list calls.
		const target_list_container = ui.create_dom_element({
			element_type	: 'ul',
			class_name		: 'list_container target_list_container',
			parent			: target_div
		})

	let section_group
	// this level's section label and its full ancestor path (root → here), used by the
	// section bar header and threaded down into the recursive portal drill-downs.
	let section_label
	let ar_path_labels = ar_section_path

	const len = section_elements.length
	for (let i = 0; i < len; i++) {
		const element = section_elements[i]

		switch (true) {

			case element.model==='section': {
				// section title bar
				section_label = element.label || element.tipo
				// Full navigation path (ancestors + this level). A drilled level REPLACES its
				// parents on a phone, so this path is the user's only context there.
				ar_path_labels = ar_section_path.concat([section_label])
				const section_bar = ui.create_dom_element({
					element_type	: 'li',
					class_name		: 'section_bar_label',
					parent			: list_container
				})
				if (ar_section_path.length > 0) {
					// deep level: the path is rendered on the phone (see search.less).
					// It is PLAIN TEXT (strip_tags) — text_content, never inner_html:
					// a breadcrumb is data, and the render boundary has ONE escaper.
					section_bar.classList.add('deep_path')
					ui.create_dom_element({
						element_type	: 'span',
						class_name		: 'section_bar_full_path',
						text_content	: ar_path_labels.map(strip_tags).join(' / '),
						parent			: section_bar
					})
				}
				// the level's own name (plain single label: desktop + root)
				ui.create_dom_element({
					element_type	: 'span',
					class_name		: 'section_bar_section_name',
					inner_html		: section_label,
					parent			: section_bar
				})
				// The `close_hide` class is added only at root depth (path.length===0)
				// because nested portal calls carry a non-empty path and the bar should
				// remain visible in those contexts.
				if (path.length===0) {
					section_bar.classList.add('close_hide')
				}
				// click event
				// Clears the target_list_container when the section bar itself is clicked.
				// Only fires when this node IS the target_list_container (i.e. in recursive
				// drill-down rendering), preventing unintended clears at the root level.
				const handle_click = (e) => {
					e.stopPropagation()
					if (target_div.classList.contains('target_list_container')) {
						// The parent list (this container's previous sibling) was hidden while
						// the drilled level existed; it returns, so slide it in from the left.
						const parent_list = target_div.previousElementSibling
						target_div.replaceChildren()
						play_level_transition(parent_list, 'back')
					}
				}
				section_bar.addEventListener('click', handle_click)
				break;
			}

			case element.model==='section_group' || element.model==='section_tab':
				// Section group container (ul)
				// Wraps the group label and all its child component items; used as the
				// collapse/expand target by toggle_section_group_label_siblings.
				section_group = ui.create_dom_element({
					element_type	: 'ul',
					class_name		: 'ul_regular',
					parent			: list_container
				})
				// Section group label (li)
				const section_group_label = ui.create_dom_element({
					element_type	: 'li',
					class_name		: 'section_group_label',
					inner_html		: element.label,
					parent			: section_group,
				})
				section_group_label.addEventListener('click', toggle_section_group_label_siblings)
				break;

			default: {
				// Calculated path (from DOM position)
				const calculated_component_path = caller.calculate_component_path( element, path )

				const class_names	= 'component_label element_draggable'
				const is_draggable	= true
				const section_id	= caller.get_section_id() // defined by the caller, sometimes "tmp_seach_" sometimes "list_" etc

				// component node
				// The path and ddo expando properties are attached directly on the DOM node
				// so that drag-drop handlers (on_dragstart) can read them without a dataset
				// JSON round-trip for rich objects.
					const component	= ui.create_dom_element({
						element_type	: 'li',
						class_name		: class_names,
						inner_html		: element.label,
						draggable		: is_draggable,
						data_set		: {
							path			: JSON.stringify(calculated_component_path),
							tipo			: element.tipo,
							section_tipo	: element.section_tipo,
							section_id		: section_id
						},
						parent			: section_group
					})
					component.ddo	= element
					component.path	= calculated_component_path

				// drag events
					component.addEventListener('dragstart',function(e){caller.on_dragstart(this,e)})

				// add
					ar_components.push(component)

				// caller hook. Let the caller decorate the row (search adds a
				// phone-only "+" so a finger can add a field; a finger cannot
				// drag). Optional — tools sharing this builder omit it.
					if (typeof caller.on_component_row === 'function') {
						caller.on_component_row({
							node	: component,
							element	: element,
							path	: calculated_component_path
						})
					}

				// Portals and autocomplete only
				// Pointer to open "children" target section (portals and autocompletes)
				// Builds li element
				// Only components that link to another section (portals / autocompletes)
				// carry target_section_tipo.  For those, clicking the item lazily loads
				// the child section into target_list_container via a recursive call.
					if (element.target_section_tipo){

						component.classList.add('has_subquery')

						const target_click_handler = async function(e) {
							e.stopPropagation()

							// loading
							target_list_container.classList.add('loading')

							// section_elements_context
								const current_section_elements = await caller.get_section_elements_context({
									section_tipo			: target_section,
									ar_components_exclude	: ar_components_exclude
								})

							// recursion render_components_list
								render_components_list({
									self				: caller,
									section_tipo		: target_section,
									target_div			: target_list_container,
									path				: calculated_component_path,
									section_elements	: current_section_elements,
									ar_section_path		: ar_path_labels
								})
							// Reset active in current wrap
							// Clear 'active' on any previously selected item in the same
							// list_container so only the clicked item is highlighted.
								const ar_active_now	= list_container.querySelectorAll('li.active')
								const len			= ar_active_now.length
								for (let i = len - 1; i >= 0; i--) {
									ar_active_now[i].classList.remove('active');
								}
							// Active current
							this.classList.add('active');

							// loading
							target_list_container.classList.remove('loading')

							// the drilled level slides in from the right (phone tier; the
							// keyframes live in search.less and the desktop layout ignores it)
							play_level_transition(target_list_container, 'forward')
						}//end target_click_handler

						// Event on click load "children" section inside target_list_container recursively
						const target_section = element.target_section_tipo[0] // Select first only
						component.addEventListener('click', target_click_handler)
					}
				break;
			}
		}//end switch (true)

	}//end for (let i = 0; i < len; i++)

	// Scroll window to top always
	// Ensures the user sees the newly rendered list from the beginning,
	// particularly useful when this is called after a portal drill-down.
		window.scrollTo(0, 0);


	return ar_components
}//end render_components_list



/**
* STRIP_TAGS
* Plain text of an ontology label: labels may carry markup (rich-text tool
* definitions), which must not leak into the joined breadcrumb string.
*
* @param {string} label
* @returns {string}
*/
const strip_tags = (label) => String(label ?? '').replace(/<[^>]*>/g, '') //end strip_tags



/**
* PLAY_LEVEL_TRANSITION
* Slides a fields level in while the user moves between portal levels (drill-down
* and back). The keyframes exist ONLY in the phone tier of search.less — on a
* desktop the class is inert, so the side-by-side columns are unchanged.
*
* The element is REUSED across visits to the same level (the recursion clears and
* repopulates the same container), so an in-flight animation must be restarted
* explicitly: remove the classes, force a reflow, then re-add.
*
* @param {HTMLElement|null} node - the entering list (child on drill, parent on back)
* @param {'forward'|'back'} direction - forward: enter from the right; back: return from the left
* @returns {void}
*/
const play_level_transition = (node, direction) => {
	if (!node) {
		return
	}
	const class_name = direction === 'back' ? 'level_slide_back' : 'level_slide_forward'
	node.classList.remove('level_slide_forward', 'level_slide_back')
	void node.offsetWidth // reflow: lets the animation run again on the same node
	node.classList.add(class_name)
} //end play_level_transition



/**
* TOGGLE_SECTION_GROUP_LABEL_SIBLINGS
* Collapse or expand all sibling nodes of a section_group_label element.
*
* Toggles the 'closed' CSS class on the clicked label.  When closed, all
* sibling `<li>` nodes within the same parent `<ul>` are given the 'hide'
* class (CSS hides them); when re-opened the 'hide' class is removed.
* The label node itself is skipped during the sibling loop to prevent
* the label from hiding itself.
*
* This is a module-private helper registered via addEventListener inside
* render_components_list — it is not exported.
*
* @param {Event} e - The click event fired on the section_group_label element.
* @returns {void}
*/
const toggle_section_group_label_siblings = function (e) {
	e.stopPropagation()

	// clicked node
	const section_group_label = e.target

	// toggle style
	section_group_label.classList.toggle('closed')

	// sibling nodes
	const ar_sibling		= section_group_label.parentNode.childNodes
	const ar_sibling_length	= ar_sibling.length

	// toggle siblings
	// Read the class state after the toggle above so the loop acts on the NEW state.
	const is_closed = section_group_label.classList.contains('closed')
	for (let i = 0; i < ar_sibling_length; i++) {
		const item = ar_sibling[i]
		if (item===section_group_label) {
			// ignore self node
			continue
		}
		if (is_closed) {
			item.classList.add('hide')
		}else{
			item.classList.remove('hide')
		}
	}
}//end toggle_section_group_label_siblings



/**
* RENDER_STREAM
* Build a live-updating SSE progress panel and return handle functions so the
* caller's stream reader can drive it.
*
* Creates DOM structure inside `options.container`:
*   process_status_node > spinner + info_node + button_stop_process
*
* The returned `update_info_node` function is intended to be called on every
* SSE chunk received from `data_manager.read_stream`.  It interprets the
* `sse_response` object and updates the `info_node` text accordingly.  When
* `sse_response.is_running` becomes false, the spinner is removed and the local
* DB status entry is cleaned up (unless `delete_local_db_data` is false).
*
* The "Stop" button is shown only when a PHP process PID or an `on_stop`
* callback is provided.  If `on_stop` is a function it is called directly;
* otherwise a `stop_process` API action is sent via `data_manager.request`
* using the supplied `pid`.
*
* Caller usage pattern:
*   const stream = render_stream({ container, id, pid, pfile });
*   data_manager.read_stream(url, (chunk) => stream.update_info_node(chunk));
*
* @param {Object} options - Configuration for the stream panel.
* @param {HTMLElement} options.container - Parent node; its children are cleared
*   before the panel is inserted.
* @param {string} options.id - Key used to persist process status in the local DB
*   (e.g. `'process_make_backup'`).
* @param {number|null} [options.pid] - PHP process ID.  When provided, the Stop
*   button triggers a `stop_process` API call.
* @param {string|null} [options.pfile] - Filename of the process output file;
*   stored in the local DB alongside `pid` for later retrieval.
* @param {Function|null} [options.on_stop] - Optional callback invoked when the
*   Stop button is clicked (used by Bun/diffusion processes that do not have a
*   Unix PID).  Takes priority over the `pid`-based API call.
* @param {boolean} [options.display_json] - When true (or when SHOW_DEBUG is
*   true), renders a `<pre>` box with the raw JSON of each SSE chunk.
*   Defaults to the value of `SHOW_DEBUG`.
* @param {boolean} [options.delete_local_db_data=true] - When true, removes the
*   local DB status entry once `is_running` becomes false.
* @param {string|null} [options.tool] - The tool whose job this is (its `self.model`).
*   A failed run ends with a frame that does not say which tool it belongs to; with this
*   the frame's `details.reason_key` resolves to THAT tool's own `reason_<key>` label
*   (render_api_error.error_text) instead of the core code's generic one. Omit it for a
*   run that is not a tool's.
* @returns {Object} response - Handle object with:
*   - `{HTMLElement} process_status_node` — root panel node.
*   - `{Function} update_info_node(sse_response, [callback])` — call on each SSE chunk.
*     `callback(info_node)` is used for fully custom rendering inside the info area.
*   - `{Function} done()` — removes the spinner immediately (e.g. on stream abort).
*/
export const render_stream = function(options) {

	// options
		const container				= options.container
		const id					= options.id
		const pid					= options.pid
		const pfile					= options.pfile
		const on_stop				= options.on_stop
		const display_json			= options.display_json ?? (SHOW_DEBUG===true)
		const delete_local_db_data	= options.delete_local_db_data ?? true
		const tool					= options.tool

	// response. Object to fill and return
		const response = {
			process_status_node	: undefined,
			update_info_node	: undefined,
			done				: undefined
		}

	// clean container node
		while (container.firstChild) {
			container.removeChild(container.firstChild);
		}

	// process_status_node
		const process_status_node = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'process_status_node',
			parent			: container
		})
		// set specific node to response
		response.process_status_node = process_status_node

	// spinner
		const spinner = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'spinner',
			parent			: process_status_node
		})

	// info node
		const info_node = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'info_node',
			parent			: process_status_node
		})

	// button_stop_process
	// Shown when a PID exists (PHP process) or an on_stop callback is provided (Bun/diffusion).
	// The 'hide' class is added at creation time when neither mechanism is available, so
	// the button is never shown at all rather than appearing and then being removed.
		const has_stop_capability = pid || on_stop
		const button_stop_process = ui.create_dom_element({
			element_type	: 'button',
			class_name		: 'gear button_stop_process' + (has_stop_capability ? '' : ' hide'),
			text_content	: 'Stop',
			parent			: process_status_node
		})
		button_stop_process.addEventListener('click', function(e) {
			e.stopPropagation()
			// on_stop takes priority: Bun/diffusion processes supply a JS-side
			// abort handler and do not have a Unix PID.
			if (typeof on_stop === 'function') {
				on_stop()
				return
			}
			// always clear local state so the user can exit a stuck loop even if
			// the server-side stop fails (e.g. process was never registered in DB)
			if (delete_local_db_data === true) {
				data_manager.delete_local_db_data(id, 'status')
			}
			data_manager.request({
				body : {
					dd_api		: 'dd_utils_api',
					action		: 'stop_process',
					options		: {
						pid		: pid,
						// the job handle: stop_process derives the job id from the
						// pfile basename (the pid alone is the SERVER's process id,
						// shared by every background job)
						pfile	: pfile
					}
				}
			})
			.then(function(response){
				if(SHOW_DEBUG===true) {
					console.log('stop_process API response:', response);
				}
				if (request_failed(response)) {
					handle_api_error(response.error, {wrapper: container})
				}
			})
		})

	// store local info about this process
	// Persists pid + pfile so the page can resume or inspect the process status
	// after navigation or refresh (retrieved via data_manager.get_local_db_data).
		data_manager.set_local_db_data(
			{
				id		: id, // like 'process_make_backup',
				value	: {
					pid		: pid,
					pfile	: pfile
				}
			}, // mixed data
			'status' // string table
		)

	// update_info_node function. loop from data_manager.read_stream
	// Closure over spinner, info_node, button_stop_process, and config options so the
	// caller does not need to pass those references on every SSE chunk.
		const update_info_node = (sse_response, callback) => {
			if(SHOW_DEBUG===true) {
				console.log('update_info_node sse_response:', typeof sse_response, sse_response);
			}

			// sample sse_response
				// {
				// 		pid			: int pid,
				// 		pfile		: string pfile,
				// 		is_running	: bool is_running,
				// 		data		: JSON data,
				// 		errors		: array []
				// }

			// process running status
			// Default to true (treat unknown state as still-running) to avoid
			// prematurely removing the spinner when the first chunk arrives.
				const is_running = sse_response?.is_running ?? true

			// data
				const data = sse_response?.data || {}

			// info node render
				if(typeof callback === 'function'){

					// callback option
					// Note that info_node is passed as a node
					// container where to place the new custom nodes
					callback(info_node)

				}else{

					// msg_node. Create once
					// Lazily created so callers using the callback path never
					// allocate a node they will not use.
					if (!info_node.msg_node) {
						info_node.msg_node = ui.create_dom_element({
							element_type	: 'div',
							class_name		: 'msg_node',
							parent			: info_node
						})
					}

					// msg
					// SEC-XSS-002: server-provided messages may contain HTML
					// metacharacters (file paths, exception text) and reach the DOM
					// as TEXT NODES only — never through inner_html.
					if(is_running===true) {

						// Short messages (≤3 chars) are likely malformed; show a safe default.
						const msg = data.msg && data.msg.length>3
							? data.msg
							: 'Process running... please wait'

						info_node.msg_node.textContent = msg

						if (has_stop_capability) {
							button_stop_process.classList.remove('hide')
						}

					}else{

						// avoid freezing the last message in cases where
						// the process does not return anything at end
						// Build a completion line that distinguishes success from error
						// so the user never sees a blank or stale "running" message.

						// A failed run ends with a coded frame; normalize_stream_error
						// reads the v2 `{is_running:false, error:{code,…}}` shape (and the
						// BARE agent-SSE error body). The tool (when the caller named one)
						// is what lets a `reason_key` refusal read in the tool's own words.
						const api_error = normalize_stream_error(sse_response, {tool})

						info_node.msg_node.textContent = api_error
							? `${get_label?.proceso || 'Process'} ${sse_response.total_time ?? ''}`
							: `${get_label?.proceso_completado || 'Process completed'} ${sse_response.total_time ?? ''}`

						if (api_error) {
							info_node.msg_node.classList.add('error')
							// the reason, in the user's language, inside the panel the
							// user is already looking at (text-only)
							render_error_inline(info_node.msg_node, api_error)
							// … and the recovery on top of it: a session that died
							// mid-job must reach the relogin overlay, not a dead line
							// of text. Every other code is already stated inline, so
							// the policy's toast would only repeat it.
							if (api_error.code.startsWith('auth.')) {
								handle_api_error(api_error)
							}
						}

						button_stop_process.classList.add('hide')
					}
				}

			// debug display_json_box
			// Lazily created like msg_node; renders the raw SSE chunk as pretty-printed
			// JSON for development inspection without polluting the production UI.
				if(display_json) {
					// display_json_box. Create once
					if (!info_node.display_json_box) {
						info_node.display_json_box = ui.create_dom_element({
							element_type	: 'pre',
							class_name		: 'display_json_box',
							parent			: info_node
						})
					}
					// text, not HTML: the dump quotes whatever the server sent
					info_node.display_json_box.textContent = JSON.stringify(sse_response, null, 2)
				}

			// running state check. If false, delete local DB reference
			// Finalise the panel: remove the spinner, clean local DB state,
			// and mark the message node so CSS can style the completion state.
				if(is_running===false) {
					spinner.remove()

					if(delete_local_db_data === true){
						data_manager.delete_local_db_data(
							id, // like 'make_backup_process'
							'status' // string table
						)
					}

					if (info_node.msg_node) {
						info_node.msg_node.classList.add('done')
					}
				}

		}
		// set specific function
		response.update_info_node = update_info_node

	// done function
	// Teardown for cases where the caller ends the stream externally
	// (e.g. abort, auth failure) without receiving a final is_running===false chunk.
	// Always clears the local DB entry so a dead/unregistered process cannot lock
	// the widget in an infinite "Preparing data..." loop on the next page load.
		const done = () => {
			spinner.remove()
			if (delete_local_db_data === true) {
				data_manager.delete_local_db_data(id, 'status')
			}
		}
		// set specific function
		response.done = done


	return response
}//end render_stream



/**
* RENDER_ERROR
* Build and return a detached DOM node that displays one or more Dédalo standard
* error objects in a consistent UI block.
*
* Accepts either a single error object or an array; single items are normalised
* to an array internally so the loop is always the same.
*
* Each error item is rendered as a `<div class="error_wrap">` containing:
*  - An `error_type` label (falls back to 'Unknown type').
*  - An `error_msg`  paragraph (falls back to 'Unknown msg').
*  - An `error_info` div block with `JSON.stringify(info)` when `info` is present.
*
* The returned node is not inserted into the DOM — the caller must append it.
*
* @see component_relation_parent for recursive error bubbling pattern.
* @param {Array|Object} error - A single error descriptor object or an array of them.
*   Each descriptor has the shape:
*   - `{string}  [type]` — machine-readable error category label.
*   - `{string}  [msg]`  — human-readable message (rendered as TEXT).
*   - `{*}       [info]` — arbitrary detail object; serialised to JSON for display.
* @returns {HTMLElement} Detached wrapper `<div>` element.
*/
export const render_error = function (error) {

	// Normalise: always operate on an array regardless of input shape.
	const errors = (Array.isArray(error))
		? error
		: [error]

	const wrapper = ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'wrapper_error error'
	})

	// title
	const title = ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'wrapper_error_title',
		text_content	: (get_label.errors_found || 'Errors found'),
		parent			: wrapper
	})
	ui.create_dom_element({
		element_type	: 'span',
		class_name		: 'button icon exclamation',
		parent			: title
	})

	const errors_length = errors.length
	for (let i = 0; i < errors_length; i++) {

		const item = errors[i]

		const type	= item.type || 'Unknown type'
		const msg	= item.msg || 'Unknown msg'
		const info	= item.info || null

		const error_wrap = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'error_wrap',
			parent			: wrapper
		})

		// type
		ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'error_type',
			text_content	: 'Type: ' + type,
			parent			: error_wrap
		})

		// msg
		// text_content, never inner_html: `msg` is server text (and may quote a
		// user-typed value) — see error_report_xss_tripwire.
		ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'error_msg',
			text_content	: msg,
			parent			: error_wrap
		})

		// error info
		if (info) {
			ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'error_info',
				text_content	: JSON.stringify(info, null, 2),
				parent			: error_wrap
			})
		}
	}


	return wrapper
}//end render_error



/**
* RENDER_LANG_BEHAVIOR_CHECK
* Render the "search in all languages" toggle switcher for a translatable component's
* search UI, and wire up the change handler that updates the component SQO in place.
*
* Language-search behaviour is controlled by `self.data.q_lang` inside the SQO:
*  - `null` or `'all'`  → search spans every stored language (checkbox ON / default).
*  - a language code     → search is restricted to `self.data.lang` (checkbox OFF).
* See `class.search.php → get_sql_where()` for the server-side enforcement of this flag.
*
* When the user toggles the switcher:
*  1. `self.data.q_lang` is updated synchronously on the component instance.
*  2. `event_manager.publish('change_search_element', self)` is fired so the rest
*     of the search UI can react (e.g. re-run the query).
*  3. The tooltip text is swapped to describe the NEW state the next click will produce.
*
* The returned node is the outer `<label class="switcher_translatable">` element.  The
* `<input type="checkbox">` is a child, but callers should treat the label as the
* attach-point when inserting into the DOM.
*
* @see render_search_component_text_area
* @see render_search_component_input_text
* @param {Object} self - The component search instance.  Must expose:
*   - `self.data.q_lang`  {string|null} — current SQO language filter value.
*   - `self.data.lang`    {string}      — the component's active data language code.
* @returns {HTMLElement} The `<label class="switcher_translatable">` wrapper element.
*/
export const render_lang_behavior_check = function (self) {

	// sqo saves the q_lang as all or not set
	// 'all' and null set the checkbox as true (search in all languages, the default).
	const q_lang_state = self.data.q_lang===null || self.data.q_lang==='all'
		? true // searching in all langs
		: false // searching in current data lang

	const title_on	= get_label.search_in_current_lang || 'Search in current lang'
	const title_off	= get_label.search_in_all_langs || 'Search in all langs'

	// div_switcher
	// by default the checkbox is set as true (without the class name off)
	const div_switcher = ui.create_dom_element({
		element_type	: 'label',
		class_name		: 'switcher_translatable text_unselectable',
		title			: title_off
	})
	// translatable option
	const lang_behavior_check = ui.create_dom_element({
		element_type	: 'input',
		type			: 'checkbox',
		class_name		: 'lang_behavior_check',
		parent			: div_switcher
	})
	// set the checkbox state
	lang_behavior_check.checked = q_lang_state
	if(!q_lang_state){
		div_switcher.classList.add('off')
		div_switcher.title = title_on
		self.data.q_lang = self.data.lang // searching in current data lang
	}
	// change event
	// The handler mutates self.data.q_lang synchronously before publishing so
	// any subscriber that immediately reads q_lang gets the updated value.
	// Titles are set to describe the NEXT toggle action (i.e. what clicking again will do).
	const change_handler = function(){
		if(lang_behavior_check.checked){
			div_switcher.classList.remove('off')

			// q_lang. Fix the data in the instance previous to save
			self.data.q_lang = null //all languages
			// publish search. Event to update the DOM elements of the instance
			event_manager.publish('change_search_element', self)

			div_switcher.title = title_off

		}else{
			div_switcher.classList.add('off')

			// q_lang. Fix the data in the instance previous to save
			self.data.q_lang = self.data.lang // search only in the current data lang
			// publish search. Event to update the DOM elements of the instance
			event_manager.publish('change_search_element', self)

			div_switcher.title = title_on
		}

		// reset tool tip
		// Force tooltip re-initialisation so the updated title attribute is
		// picked up by the tooltip library without waiting for a mouse-leave.
		ui.activate_tooltips(div_switcher, null, true)
	}
	lang_behavior_check.addEventListener('change', change_handler)

	// activate tool tip
	ui.activate_tooltips(div_switcher, null)


	return div_switcher
}//end render_lang_behavior_check



// @license-end
