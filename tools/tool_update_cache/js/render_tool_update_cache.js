// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_label, page_globals, SHOW_DEBUG, DEDALO_CORE_URL, tool_update_cache */
/*eslint no-undef: "error"*/



// imports
	import {ui} from '../../../core/common/js/ui.js'
	import {render_stream} from '../../../core/common/js/render_common.js'
	import {data_manager} from '../../../core/common/js/data_manager.js'
	import {request_failed} from '../../../core/common/js/api_error.js'
	import {handle_api_error} from '../../../core/common/js/error_dispatch.js'
	import {error_text} from '../../../core/common/js/render_api_error.js'



/**
* RENDER_TOOL_UPDATE_CACHE
* Client-side rendering module for the tool_update_cache Dédalo tool.
*
* This module provides the edit-mode view of the cache-update tool.  The tool
* allows editors to trigger a background PHP process that regenerates the
* section-component cache for a section (e.g. rebuilding denormalised search
* text, re-encoding media derivatives) without leaving the browser.
*
* Architecture overview:
*  - `render_tool_update_cache` is a constructor whose prototype methods are
*    mixed into `tool_update_cache` (see tool_update_cache.js).  Only `.edit`
*    is exported; the remaining helpers (`get_content_data`, `render_components_list`,
*    etc.) are module-private.
*  - The UI presents the caller section's component list as a checkbox group so
*    the editor can select which components to regenerate.  Certain media
*    components (3D, AV, image, PDF, SVG) are visually highlighted and may
*    expose additional "regenerate options" (e.g. "Delete normalised files").
*  - On submit, `self.update_cache()` (defined in tool_update_cache.js) sends a
*    background API request that forks a CLI process.  The response carries a
*    `pid` / `pfile` pair used to poll the process via Server-Sent Events (SSE)
*    through `data_manager.request_stream` + `data_manager.read_stream`.
*  - Progress is displayed live inside a `response_message` div via
*    `render_stream` (from render_common.js).  When the process finishes,
*    `render_response_report` appends a compact summary (components processed,
*    records updated).
*  - A local IndexedDB key (`process_update_cache`) persists the running
*    pid/pfile so that the progress panel is re-attached if the tool panel is
*    closed and re-opened while the background process is still running.
*
* Exports:
*  - render_tool_update_cache  Constructor; attach `.prototype.edit` to the tool.
*/



/**
* RENDER_TOOL_UPDATE_CACHE
* Constructor for the render prototype object.
*
* Does not initialise any instance state — all properties are managed by the
* owning `tool_update_cache` instance.  The constructor simply satisfies the
* prototype-chaining contract expected by `tool_update_cache.js`:
*   tool_update_cache.prototype.edit = render_tool_update_cache.prototype.edit
*/
export const render_tool_update_cache = function() {

	return true
}//end render_tool_update_cache



/**
* EDIT
* Render the full edit-mode DOM for the tool and return the wrapper element.
*
* Called automatically by `tool_common.prototype.render` (wired via the
* prototype assignment in tool_update_cache.js).  Supports two render levels:
*  - `'full'`    (default) — builds a complete tool wrapper via
*                `ui.tool.build_wrapper_edit`, including title bar and chrome.
*  - `'content'` — returns only the inner `content_data` node; used when
*                composing tool panels that already provide their own wrapper.
*
* The heavy lifting is delegated to the module-private `get_content_data`.
*
* @param {Object} options - Render configuration forwarded from render common.
* @param {string} [options.render_level='full'] - Depth of the rendered output.
* @returns {Promise<HTMLElement>} The wrapper element (full) or content_data
*   node (content) containing the complete tool UI.
*/
render_tool_update_cache.prototype.edit = async function(options) {

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
* Build and return the inner content area of the tool panel.
*
* Constructs the full tool body as a DocumentFragment and then appends it to a
* `content_data` wrapper created by `ui.tool.build_content_data`.  The layout
* produced is:
*
*   section_info
*     h3.section_name   — human-readable caller section label
*     h3.section_tipo   — ontology tipo of the caller section (e.g. "rsc10")
*   components_list_container
*     <ul> (from render_components_list)
*   buttons_container
*     button.button_apply  — triggers the cache-update background process
*     span.records_total   — the scope: caller list's matched total
*   div.response_message   — live SSE progress output area
*
* On mount, `check_process_data` immediately consults IndexedDB (key
* `process_update_cache`) and, if a pid/pfile pair is found there, reconnects
* to the still-running background process so the progress panel is restored
* without requiring the user to re-submit.
*
* The `button_apply` click handler guards against empty selection (alert) and
* requires a confirmation dialog before dispatching the API request.  After a
* successful API response (which returns `pid` + `pfile`), it hands off to
* `update_process_status` for SSE streaming.
*
* Note: `response_message` is referenced by the `click_handler` closure before
* it is assigned later in the same function.  This works because `click_handler`
* is an async arrow function that is only invoked on user action, by which point
* the `response_message` const is already initialised. (!)
*
* @param {Object} self - The owning `tool_update_cache` instance; must expose
*   `caller` (section context), `selected_tipos` (Array), `get_tool_label`,
*   `components_list` (Array), `config` (Object), and `update_cache` (Function).
* @returns {Promise<HTMLElement>} The `content_data` div containing the
*   assembled tool body.
*/
const get_content_data = async function(self) {

	const fragment = new DocumentFragment()

	// short vars
		// IndexedDB key used to persist pid/pfile for process resume on re-open
		const local_db_id = 'process_update_cache'

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
				inner_html		: self.caller.label,
				parent			: section_info
			})
		// section_tipo
			ui.create_dom_element({
				element_type	: 'h3',
				class_name		: 'section_tipo',
				inner_html		: self.caller.tipo,
				parent			: section_info
			})

	// components_list_container
		// Receives the 'loading' CSS class while an API process is running,
		// providing a visual lock that discourages duplicate submissions.
		const components_list_container = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'components_list_container',
			parent			: fragment
		})

	// components list checkbox
		const components_list_node = render_components_list(self)
		components_list_container.appendChild(components_list_node)

	// buttons_container
		const buttons_container = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'buttons_container',
			parent			: fragment
		})

	// button_apply (Update records)
		// The tool's primary action: `primary` gets the tool colour with its
		// matched ink (tool_common.less → .tool_action_button()), `reload` the icon.
		const button_apply = ui.create_dom_element({
			element_type	: 'button',
			class_name		: 'primary reload button_apply',
			text_content	: get_label.update || 'Update',
			parent			: buttons_container
		})
	// records_total. Scope of the operation (self.caller.total), shown beside
	// the action — not concatenated into its label — so the editor knows it
	// before confirming.
		ui.create_dom_element({
			element_type	: 'span',
			class_name		: 'records_total',
			text_content	: (self.get_tool_label('records') || 'Records') + ': ' + (self.caller.total ?? '?'),
			parent			: buttons_container
		})
		const click_handler = async (e) => {
			e.stopPropagation()
			e.preventDefault()

			// selection
				const checked_list			= self.selected_tipos
				const checked_list_length	= checked_list.length
				// empty case
				if (checked_list_length<1) {
					alert(get_label.empty_selection || 'Empty selection');
					return
				}

			// confirm update_cache. Carries the record count the request will
			// actually scope (the caller list's matched total — the same live sqo
			// update_cache() sends), so the user confirms a number, not a "Sure?".
				const records_count	= self.caller.total ?? '?'
				const confirm_msg	= (get_label.sure || 'Sure?')
					+ '\n' + (self.get_tool_label('records') || 'Records') + ': ' + records_count
					+ ' | ' + (get_label.components || 'components') + ': ' + checked_list_length
				if (!confirm(confirm_msg)) {
					return
				}

			// loading styles and clean
				// components_list_container.classList.add('loading')
				button_apply.classList.add('loading')
				button_apply.classList.add('button_spinner')
				// blur button
				document.activeElement.blur()

			// API request
				// update_cache forks a background CLI process and returns immediately
				// with { result, pid, pfile } — the actual work is tracked via SSE.
				const api_response = await self.update_cache()

			// response failed case. Envelope v2: a refusal carries the coded error
			// (rendered by the ONE renderer, in the user's language); a success has
			// no prose at all, and the run's account arrives on the stream.
				if (request_failed(api_response)) {
					button_apply.classList.remove('loading')
					button_apply.classList.remove('button_spinner')
					// text, never innerHTML: this is server text
					response_message.textContent = error_text(api_response.error)
					handle_api_error(api_response.error, {wrapper: response_message.parentNode});
					ui.reveal(response_message)
					return
				}

			// fire update_process_status
				// On success the API response always provides pid + pfile so the
				// SSE stream can be opened to track the background process.
				update_process_status({
					pid							: api_response.pid,
					pfile						: api_response.pfile,
					local_db_id					: local_db_id,
					container					: response_message,
					button						: button_apply,
					components_list_container	: components_list_container,
					self						: self,
					reveal						: true
				})
		}
		button_apply.addEventListener('click', click_handler)

	// response_message
		// Empty placeholder div; filled by render_stream / render_response_report
		// during and after the background process respectively.
		const response_message = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'response_message',
			parent			: fragment
		})

	// check process status always
		// Immediately check IndexedDB for a persisted pid/pfile from a previous
		// (still-running) submit.  If found, re-attach the SSE progress panel so
		// the user can watch the ongoing operation without re-submitting.
		const check_process_data = () => {
			data_manager.get_local_db_data(
				local_db_id,
				'status'
			)
			.then(function(local_data){
				if (local_data && local_data.value) {
					update_process_status({
						pid							: local_data.value.pid,
						pfile						: local_data.value.pfile,
						local_db_id					: local_db_id,
						container					: response_message,
						button						: button_apply,
						components_list_container	: components_list_container,
						self						: self
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
* RENDER_COMPONENTS_LIST
* Build the checkbox list of section components that the user can select for
* cache regeneration.
*
* Iterates over `self.components_list` (an array of element descriptors fetched
* from the server via `get_component_list`) and emits one `<li>` row per
* component inside nested `<ul>` groups that mirror the section's layout
* hierarchy.
*
* Element descriptor shape (relevant fields):
*   {
*     model             : {string}  — e.g. 'component_image', 'section_group'
*     tipo              : {string}  — ontology tipo, e.g. 'rsc201'
*     label             : {string}  — human-readable name in the UI language
*     regenerate_options: {Array|null} — optional per-component option set
*   }
*
* Switch branches:
*   'section'                        — skipped; the root section element itself
*                                      carries no checkbox.
*   'section_group' | 'section_tab'  — emits a group header `<li>` with column
*                                      labels ("Regenerate options" / "Info") and
*                                      sets the `section_group` variable used as
*                                      the parent for subsequent component rows.
*   default                          — emits a component row with:
*                                      - `<label>` carrying `component_label.ddo`
*                                        (the raw element descriptor, referenced
*                                        by downstream consumers).
*                                      - `<input type=checkbox>` pre-pended into
*                                        the label; disabled for
*                                        `component_section_id` (auto field).
*                                      - A change handler that pushes/splices
*                                        the tipo in/out of `self.selected_tipos`.
*                                      - An optional `regenerate_container` built
*                                        by `render_regenerate_options` when the
*                                        element exposes `regenerate_options`.
*                                      - An `info_node` showing the model and
*                                        tipo string for developer orientation.
*
* Hilite rules (class 'hilite' is added to the label):
*   1. The tipo is in `config.hilite_tipos.value` (administrator-configured list
*      stored as a tool property under dd999 / dd1633 in the register.json).
*   2. The element model is one of the built-in media models:
*      component_3d, component_av, component_image, component_pdf, component_svg.
*
* Note: `section_group` is declared with `let` outside the loop and mutated on
* every section_group/section_tab encounter.  If `self.components_list` begins
* with component rows before the first section_group element, appending to
* `section_group` will throw because the variable is still `undefined`. (!)
*
* @param {Object} self - The owning `tool_update_cache` instance; must expose
*   `caller.section_tipo` (string), `components_list` (Array), `config` (Object),
*   `selected_tipos` (Array), and `get_tool_label` (Function).
* @returns {DocumentFragment} Fragment containing the complete `<ul>` component
*   picker tree, ready for insertion into the DOM.
*/
const render_components_list = function(self) {

	const fragment = new DocumentFragment()

	// short vars
		const section_tipo		= self.caller.section_tipo
		const section_elements	= self.components_list
		const config			= self.config || {}

	// hilite
		// hilite_tipos comes from the tool's stored config property (dd999/dd1633).
		// Its shape is { value: string[], client: boolean }.
		const hilite_tipos = config.hilite_tipos || {}
	// hilite models
		// Media components are highlighted by default regardless of hilite_tipos
		// because cache regeneration for them is often the primary reason to run
		// this tool (they embed expensive derivative file metadata in the cache).
		const hilite_models = [
			'component_3d',
			'component_av',
			'component_image',
			'component_pdf',
			'component_svg'
		]

	// list_container
		const list_container = ui.create_dom_element({
			element_type	: 'ul',
			class_name		: 'list_container',
			parent			: fragment
		})

	// section_group holds the current <ul> group container.
	// It is reassigned each time a section_group/section_tab element is encountered.
	let section_group

	const section_elements_length = section_elements.length
	for (let i = 0; i < section_elements_length; i++) {

		const element = section_elements[i]

		switch (true) {

			case element.model==='section': {
				// ignore section
				// The top-level section element itself has no cacheable data of
				// its own; only its children (components) are regenerable.
				break;
			}

			case element.model==='section_group' || element.model==='section_tab': {

				// Section group container (ul). Set var `section_group` on each iteration
				// Each group/tab creates a fresh <ul> that becomes the parent for
				// the component rows that follow it in the element list.
					section_group = ui.create_dom_element({
						element_type	: 'ul',
						class_name		: 'ul_regular',
						parent			: list_container
					})

				// li section_group_label
					const section_group_label = ui.create_dom_element({
						element_type	: 'li',
						class_name		: 'li_line section_group_label',
						parent			: section_group,
					})

				// label
					ui.create_dom_element({
						element_type	: 'span',
						inner_html		: element.label,
						parent			: section_group_label,
					})

				// regenerate_options
				// Column header aligned with regenerate_container cells in component rows.
					ui.create_dom_element({
						element_type	: 'span',
						inner_html		: self.get_tool_label('regenerate_options') || 'Regenerate options',
						parent			: section_group_label,
					})

				// info
				// Column header aligned with info_node cells in component rows.
					ui.create_dom_element({
						element_type	: 'span',
						inner_html		: self.get_tool_label('info') || 'Info',
						parent			: section_group_label,
					})
				break;
			}

			default: {

				// ul_regular fallback group
				// Sections without any section_group/section_tab (e.g. media sections)
				// would otherwise append rows straight to list_container, skipping the
				// .ul_regular wrapper that ALL grid/layout CSS is rooted at — leaving
				// the rows unstyled. Lazily create a default group so every li_line
				// lives inside a .ul_regular and the CSS contract holds.
					if (!section_group) {
						section_group = ui.create_dom_element({
							element_type	: 'ul',
							class_name		: 'ul_regular',
							parent			: list_container
						})
					}

				// li_container
					const li_container	= ui.create_dom_element({
						element_type	: 'li',
						class_name		: 'li_line li_container',
						parent			: section_group
					})

				// component_label
				// The <label> wraps the checkbox so clicking the label text also
				// toggles the checkbox.  `.ddo` is the raw element descriptor,
				// useful for downstream inspection.
					const component_label = ui.create_dom_element({
						element_type	: 'label',
						class_name		: 'component_label',
						inner_html		: element.label,
						title			: `${element.model} - ${element.tipo}`,
						parent			: li_container,
					})
					component_label.ddo = element

					// hilite
					// Condition 1: tipo is in the admin-configured hilite list.
					// Condition 2: model is one of the built-in media types.
					// Both conditions are OR-ed; the || is intentionally loose
					// (short-circuit: if hilite_tipos.value is falsy, the includes
					// call is skipped entirely). (!)
					if (hilite_tipos.value && hilite_tipos.value.includes(element.tipo) ||
						hilite_models.includes(element.model)
						) {
						component_label.classList.add('hilite')
					}

				// input checkbox
				// The checkbox id is scoped with section_tipo to avoid id conflicts
				// when multiple instances of the tool are rendered simultaneously.
					const input_checkbox = ui.create_dom_element({
						element_type	: 'input',
						type			: 'checkbox',
						id				: section_tipo + '_' +  element.tipo,
						value			: element.tipo
					})
					if (element.model==='component_section_id') {
						// component_section_id is a system auto-field; it cannot be
						// meaningfully regenerated and is therefore locked.
						input_checkbox.disabled = true
					}
					component_label.prepend(input_checkbox)
					// change event handler
					// Mutates self.selected_tipos directly (push/splice) to keep
					// the selection state in sync with `self.update_cache()`.
						const change_handler = (e) => {
							if (input_checkbox.checked) {
								self.selected_tipos.push(element.tipo)
							}else{
								const index = self.selected_tipos.indexOf(element.tipo)
								if (index > -1) {
									self.selected_tipos.splice(index, 1)
								}
							}
						}
						input_checkbox.addEventListener('change', change_handler)

				// regenerate_container. Regeneration options for update (like component_image)
				// Only rendered when the server provides `element.regenerate_options`
				// (e.g. "Delete normalised files" for component_image/component_av).
					const regenerate_container = ui.create_dom_element({
						element_type	: 'div',
						class_name		: 'regenerate_container',
						parent			: li_container
					})
					if (element.regenerate_options) {
						regenerate_container.appendChild(
							render_regenerate_options(self, element)
						)
					}

				// info_node (model, tipo, etc.)
				// Developer-facing metadata column; hidden or small in normal use.
					ui.create_dom_element({
						element_type	: 'div',
						class_name		: 'info_node',
						text_content	: `${element.model} - ${element.tipo}`,
						parent			: li_container
					})
				break;
			}
		}//end switch (true)
	}


	return fragment
}//end render_components_list



/**
* RENDER_REGENERATE_OPTIONS
* Build the collapsible "regeneration options" panel for a single component row.
*
* Certain components (primarily media: image, AV) expose per-regeneration
* flags that the user can toggle before submitting.  The server signals this by
* including a `regenerate_options` array in the element descriptor.  Each entry
* in that array has at minimum:
*   { name: string, type: 'boolean' }
*
* Currently only `type: 'boolean'` is implemented; any other type is logged as
* a warning and skipped.  The 'boolean' branch renders a labelled checkbox
* whose change handler writes into `self.regenerate_options[tipo]`:
*   self.regenerate_options = { 'rsc201': { delete_normalized_files: true }, ... }
* This map is later merged into the API request body by `self.update_cache()`.
*
* The collapse/expand toggle is persisted by `ui.collapse_toggle_track` using
* the key `'regenerate_options_' + item.tipo`, so the panel remembers its
* open/closed state across re-renders for the same section tipo.
*
* Collapse/expose callbacks manage the `'up'` CSS class on `head_node`, which
* rotates the arrow icon via CSS transform.  `default_state: 'opened'` means
* the options are visible by default; `ui.collapse_toggle_track` may override
* this if a persisted closed state is found in IndexedDB.
*
* @param {Object} self - The owning `tool_update_cache` instance; must expose
*   `get_tool_label` (Function) and `regenerate_options` (Object, mutated
*   in-place by the change handler).
* @param {Object} item - Element descriptor for the component; must have
*   `tipo` (string) and `regenerate_options` (Array of option descriptors).
* @returns {HTMLElement} The `div.regenerate_options_container` wrapper element
*   containing the collapse toggle and all option controls.
*/
const render_regenerate_options = function(self, item) {

	const tipo = item.tipo

	// wrapper
		const wrapper = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'regenerate_options_container'
		})

	// head_node
	// Clickable toggle button; the 'up' class rotates the arrow icon via CSS.
		const head_node = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'head_node icon_arrow',
			title			: self.get_tool_label('regenerate_options') || 'Regenerate options',
			parent			: wrapper
		})

	// body_node
	// Hidden by default via 'hide' class; collapse_toggle_track manages visibility.
		const body_node = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'body_node hide',
			parent			: wrapper
		})

	// track collapse toggle state of content
	// Persists open/closed state in IndexedDB under 'regenerate_options_<tipo>'
	// so the panel is restored to the same state on next render.
		ui.collapse_toggle_track({
			toggler				: head_node,
			container			: body_node,
			collapsed_id		: 'regenerate_options_' + item.tipo,
			collapse_callback	: collapse,
			expose_callback		: expose,
			default_state		: 'opened' // 'opened|closed'
		})
		function collapse() {
			head_node.classList.remove('up')
		}
		function expose() {
			head_node.classList.add('up')
		}

	// render regenerate_options
	// Iterate the option descriptors provided by the server and build the
	// appropriate input control for each one.
		const regenerate_options = item.regenerate_options
		const regenerate_options_length = regenerate_options.length
		for (let i = 0; i < regenerate_options_length; i++) {

			const regenerate_item = regenerate_options[i]

			switch (regenerate_item.type) {

				// boolean. Use a checkbox
				case 'boolean':
					// label
					const option_label = ui.create_dom_element({
						element_type	: 'label',
						inner_html		: self.get_tool_label(regenerate_item.name) || regenerate_item.name,
						parent			: body_node
					})
					// input_checkbox
					const input_checkbox = ui.create_dom_element({
						element_type	: 'input',
						type			: 'checkbox'
					})
					option_label.prepend(input_checkbox)
					// change event
					// Writes the current checkbox state into self.regenerate_options
					// keyed by tipo so update_cache() can forward it to the API.
					// Each change replaces the entire per-tipo object, so only one
					// boolean option per component is effectively tracked. (!)
					const change_handler = () => {
						// set tool var regenerate_options item value
						// Merge into the existing per-tipo object so sibling boolean
						// options on the same component are preserved instead of being
						// overwritten on each toggle.
						self.regenerate_options[tipo] = {
							...self.regenerate_options[tipo],
							[regenerate_item.name] : input_checkbox.checked
						}
						if(SHOW_DEBUG===true) {
							console.log('self.regenerate_options:', self.regenerate_options);
						}
					}
					input_checkbox.addEventListener('change', change_handler)
					break;

				default:
					// Only 'boolean' is currently supported.  Log unknown types
					// for developer visibility without crashing the UI.
					console.warn('Ignored regenerate item type not allowed: ', regenerate_item.type);
					break;
			}
		}//end for (let i = 0; i < regenerate_options_length; i++)


	return wrapper
}//end render_regenerate_options



/**
* UPDATE_PROCESS_STATUS
* Open an SSE connection to the `dd_utils_api::get_process_status` endpoint and
* drive the live progress panel until the background process exits.
*
* This function is the bridge between the one-shot API response from
* `self.update_cache()` (which returns immediately with `pid` + `pfile`) and
* the continuous SSE progress feed.  It is also called on tool mount by
* `check_process_data` when a persisted pid/pfile is found in IndexedDB, so
* that progress is resumed without re-submitting.
*
* Flow:
*  1. Lock the UI: add 'loading' to `button` and `components_list_container`,
*     blur the active element, and clear `container`.
*  2. Call `data_manager.request_stream` with the pid/pfile pair; the API
*     responds with an SSE stream that emits process-status objects at
*     `update_rate` (default 1 000 ms) intervals until the PID exits.
*  3. Create a `render_stream` controller (`render_response`) which manages the
*     base progress nodes inside `container`.
*  4. Pass `on_read` and `on_done` to `data_manager.read_stream`:
*     - `on_read` is called for each SSE chunk.  It delegates to
*       `render_response.update_info_node`, which updates timing and status
*       indicators.  The inner callback builds the `compound_msg` text
*       (msg | counter/total | n_components | current section id | elapsed) and
*       writes it into a lazily-created `msg_node`.  When `is_running` flips to
*       false on the final chunk, `render_response_report` is appended.
*     - `on_done` is called once, either on natural completion or stream cancel.
*       It restores the UI (removes 'loading' classes) and calls
*       `render_response.done()` to finalise the stream panel.
*
* SSE chunk shape (relevant fields inside `sse_response`):
*   {
*     is_running : {boolean}   — false only on the last chunk after PID exits
*     total_time : {string}    — human-readable elapsed time
*     data : {
*       msg          : {string}  — current status message from the PHP process
*       counter      : {number}  — records processed so far
*       total        : {number}  — total records in scope
*       n_components : {number}  — number of components being processed
*       current      : { section_id: number }  — record currently being cached
*     }
*   }
*
* @param {Object} options - Configuration object.
* @param {number|string} options.pid     - OS process ID of the background CLI.
* @param {string}        options.pfile   - Path to the process status file
*                                          monitored by dd_utils_api.
* @param {HTMLElement}   options.button  - The submit button; gets 'loading' /
*                                          'button_spinner' classes while running.
* @param {string}        options.local_db_id - IndexedDB key used by render_stream
*                                          to persist pid/pfile for resume on re-open.
* @param {HTMLElement}   options.container - The response_message div; its children
*                                          are cleared before the stream panel is built.
* @param {HTMLElement}   options.components_list_container - The component checklist
*                                          div; receives 'loading' class to block
*                                          changes while a run is in progress.
* @param {Object}        options.self    - The owning `tool_update_cache` instance.
* @param {boolean}       [options.reveal=false] - Scroll the progress panel into
*                                          view once built (user submit only).
* @returns {void}
*/
const update_process_status = (options) => {

	const pid						= options.pid
	const pfile						= options.pfile
	const button					= options.button
	const local_db_id				= options.local_db_id
	const container					= options.container
	const components_list_container	= options.components_list_container
	const self						= options.self
	// reveal: scroll the progress panel into view once it exists. Only the
	// user's submit asks for it — a page-load re-attach must not move the page.
	const reveal					= options.reveal===true

	// locks the button submit
	button.classList.add('loading')
	components_list_container.classList.add('loading')

	// blur button
	document.activeElement.blur()

	// clean container
	// Remove any stale progress content from a previous run before opening the
	// new SSE stream.
	while (container.firstChild) {
		container.removeChild(container.firstChild);
	}

	// get_process_status from API and returns a SEE stream
	// The API holds the connection open and emits one JSON object per tick
	// (update_rate ms) until the monitored PID is no longer running.
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

		// render base nodes and set functions to manage
		// the stream reader events.
		// render_stream returns a controller object with update_info_node and done.
		const render_response = render_stream({
			container	: container,
			id			: local_db_id,
			pid			: pid,
			pfile		: pfile
		})
		// it lands below the components list, under the fold on a long selection
		if (reveal) {
			ui.reveal(container)
		}

		// on_read event (called on every chunk from stream reader)
		const on_read = (sse_response) => {

			// fire update_info_node on every reader read chunk
			// The callback receives `info_node`, the live status DOM node managed
			// by render_stream, so we can append/update child nodes as needed.
			render_response.update_info_node(sse_response, (info_node) => {

				// is_running defaults to true when the field is absent (early chunks
				// before the process has reported its first status).
				const is_running = sse_response?.is_running ?? true

				// On the final chunk (is_running===false), append the compact
				// summary report immediately so it is visible before on_done fires,
				// and scroll it into view: it lands below the components list, under
				// the fold on a long selection.
				if (is_running===false && sse_response.data) {
					ui.reveal(container.appendChild(
						render_response_report(self, sse_response.data)
					))
				}

				// compound_msg assembles a pipe-delimited status string from the
				// available data fields, omitting any that are absent/empty.
				const compound_msg = (sse_response) => {
					const data = sse_response.data
					const parts = []
					parts.push(data.msg)
					if (data.counter && data.total) {
						parts.push(data.counter +' '+ (get_label.of || 'of') +' '+ data.total)
					}
					if (data.n_components) {
						parts.push('n components: ' + data.n_components)
					}
					if (data.current?.section_id) {
						parts.push('id: ' + data.current?.section_id)
					}
					parts.push(sse_response.total_time)
					return parts.join(' | ')
				}

				// Choose message text: use compound_msg when the process has
				// reported a meaningful msg (length > 5), otherwise fall back to a
				// generic "running" or "completed" string.
				const frame_line = sse_response && sse_response.data && sse_response.data.msg
				const msg = (typeof frame_line==='string' && frame_line.length>5)
					? compound_msg(sse_response)
					: is_running
						? 'Process running... please wait'
						: 'Process completed in ' + sse_response.total_time

				// Lazily create msg_node on first read so it is always present
				// from the first chunk onward; subsequent reads reuse it.
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
			// unlocks the button submit
			button.classList.remove('loading')
			button.classList.remove('button_spinner')
			container.classList.remove('loading')
			components_list_container.classList.remove('loading')

			// render_response()
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
		console.error('[tool_update_cache] could not open the status stream:', error)
	})
}//end update_process_status



/**
* RENDER_RESPONSE_REPORT
* Build a compact summary panel from the final SSE data payload.
*
* Called once by the `on_read` handler in `update_process_status` when
* `is_running === false` and `sse_response.data` is present.  The node is
* appended to `container` (the `response_message` div) directly from that
* call site.
*
* The `api_response` object is the `data` field from the last SSE chunk, as
* emitted by the PHP `get_process_status` action.  Expected shape:
*   {
*     msg          : {string}   — final human-readable status message
*     n_components : {number}   — total number of components processed
*     counter      : {number}   — total number of records whose cache was updated
*   }
*
* Each piece of data is rendered as a separate `span.msg_detail` so the CSS
* can arrange them as a flex row.  Fields that are falsy (0, null, undefined)
* are silently omitted except the "Updated" label which is always emitted.
*
* @param {Object} self         - The owning `tool_update_cache` instance;
*                                must expose `get_tool_label` (Function).
* @param {Object} api_response - Final-chunk data object from the SSE stream.
* @param {number} [api_response.n_components] - Count of regenerated components.
* @param {number} [api_response.counter]      - Count of regenerated records.
* @returns {HTMLElement} A `span.report_node` containing the summary details.
*/
const render_response_report = function (self, api_response) {

	const report_node = ui.create_dom_element({
		element_type	: 'span',
		class_name		: 'report_node'
	})

	// Updated text
	// Always emitted as the first detail so the report has a clear heading even
	// when n_components and counter are both absent.
	{
		const label = (self.get_tool_label('updated') || 'Updated')
			+ ': '
		ui.create_dom_element({
			element_type	: 'span',
			class_name		: 'msg_detail',
			text_content	: label,
			parent			: report_node
		})
	}

	// response n_components
	// Omit when the server did not return a component count (e.g. lightweight runs).
	if (api_response.n_components) {
		const label = (self.get_tool_label('components') || 'Components')
			+ ': '
			+ (api_response.n_components || 'Unknown')
		ui.create_dom_element({
			element_type	: 'span',
			class_name		: 'msg_detail',
			text_content	: label,
			parent			: report_node
		})
	}

	// response counter (n_records)
	// Omit when no records were processed (e.g. empty section or all skipped).
	if (api_response.counter) {
		const label = (self.get_tool_label('records') || 'Records')
			+ ': '
			+ (api_response.counter || 'Unknown')
		ui.create_dom_element({
			element_type	: 'span',
			class_name		: 'msg_detail',
			text_content	: label,
			parent			: report_node
		})
	}


	return report_node
}//end render_response_report



// @license-end
