// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global SHOW_DEBUG, get_label */
/*eslint no-undef: "error"*/



// imports
	import {event_manager} from '../../common/js/event_manager.js'
	import {data_manager} from '../../common/js/data_manager.js'
	import {ui} from '../../common/js/ui.js'
	import {
		clone,
		object_to_url_vars,
		open_window,
		same_section_id
	} from '../../common/js/utils/index.js'
	import {open_tool} from '../../../core/tools_common/js/tool_common.js'
	import {view_default_list_section} from './view_default_list_section.js'
	import {view_graph_list_section} from './view_graph_list_section.js'
	import {view_base_list_section} from './view_base_list_section.js'
	import {view_thesaurus_list_section} from './view_thesaurus_list_section.js'
	import {view_tm_list_section} from './view_tm_list_section.js'
	import {view_search_user_presets} from './view_search_user_presets.js'
	import {view_export_user_presets} from './view_export_user_presets.js'
	import {response_data} from '../../common/js/api_error.js'



/**
* RENDER_LIST_SECTION
* Entry-point namespace for a section rendered in 'list' mode.
*
* The module provides two main exports:
*   - render_list_section       – view dispatcher; delegates to the appropriate
*                                 view module based on section.context.view.
*   - render_column_id          – builds the DOM fragment for the 'id' column of
*                                 every row in the list, including the link/edit/delete
*                                 buttons and their full event wiring.
*
* Two private helpers support render_column_id:
*   - _update_link_button       – async; resolves the initial linked/unlinked state
*                                 of a row's link button when the list is rendered
*                                 inside a portal-picker iframe.
*   - _set_link_button_state    – sync; reflects a known linked/unlinked boolean
*                                 onto the button and icon CSS classes immediately.
*
* Supported context.view values (render_list_section.list):
*   'base'               → view_base_list_section
*   'graph'              → view_graph_list_section
*   'thesaurus_list'     → view_thesaurus_list_section
*   'search_user_presets'→ view_search_user_presets
*   'export_user_presets'→ view_export_user_presets
*   'default' / unknown  → dynamic render_views lookup, then view_default_list_section
*/



/**
* RENDER_LIST_SECTION
* Namespace constructor — never instantiated; all functionality lives on the
* static-style function properties (render_list_section.list, etc.).
*/
export const render_list_section = function() {

	return true
}//end render_list_section



/**
* LIST
* View dispatcher for a section in list mode.
* Reads `self.context.view` and delegates rendering to the matching view module.
* Falls back to a dynamic `render_views` lookup (ontology-configured custom views)
* and finally to view_default_list_section if no match is found.
*
* Called as a method on a section instance (this === section instance).
*
* @param {Object} options - Render options forwarded verbatim to the view module.
*   Typical shape: { render_level: 'full'|'content', render_mode: 'list' }
* @returns {Promise<HTMLElement>} The rendered wrapper element produced by the view.
*/
render_list_section.list = async function(options) {

	const self = this

	// THE TIME MACHINE LIST.
	// Keyed on the SECTION, not on a view string: a dd15 list IS the Time Machine
	// list, always, for every consumer (the tool, the inspector's history blocks,
	// the bare browse). Routing on `self.view` instead made the row action depend
	// on an options hop that dd15's context — which declares no view of its own —
	// could not reinforce, so a lost view silently downgraded the list to a plain
	// read-only grid with no restore/preview affordance and no error.
	// See WC-2026-08-14-tm-ddo-mode-retired.
		if (self.section_tipo==='dd15') {
			return view_tm_list_section.render(self, options)
		}

	// view
		const view = self.context?.view || self.view || 'default'

	// wrapper
		switch(view) {

			case 'base':
				return view_base_list_section.render(self, options)

			case 'graph':
				return view_graph_list_section.render(self, options)

			case 'thesaurus_list':
				return view_thesaurus_list_section.render(self, options)

			// The Time Machine list — an ordinary list whose leading Id cell is the
			// restore/preview action (WC-2026-08-14-tm-ddo-mode-retired). Everything
			// else is delegated to view_default_list_section.
			case 'tm_list':
				return view_tm_list_section.render(self, options)

			case 'search_user_presets':
				return view_search_user_presets.render(self, options)

			case 'export_user_presets':
				return view_export_user_presets.render(self, options)

			case 'default':
			default: {
				// dynamic try
				// Check whether the ontology has registered a custom render_view for this
				// view/mode combination before falling back to the built-in default.
					const render_view = (self.render_views || []).find(el => el.view===view && el.mode===self.mode)
					if (render_view) {
						const path			= render_view.path || ('./' + render_view.render +'.js')
						const render_method	= await import (path)
						return render_method[render_view.render].render(self, options)
					}

				return view_default_list_section.render(self, options)
			}
		}
}//end list



/**
* RENDER_COLUMN_ID
* Builds the DOM DocumentFragment that populates the 'id' column for one row
* in the section list.  Called as a callback from section_record for every
* rendered row.
*
* The fragment's content varies by context:
*
*   1. initiator (iframe portal-picker)
*      A section list rendered inside an iframe with an `initiator` URL parameter
*      pointing to a component_* instance in the parent window.  The button
*      toggles a link/unlink relationship with that component.  The visual state
*      (linked vs. unlinked) is resolved asynchronously by _update_link_button
*      so the button renders immediately and the icon updates without blocking.
*
*   2. section_tool source  (self.config.source_model === 'section_tool')
*      A tool-driven list.  Renders an edit-pen button that opens the configured
*      tool via open_tool() rather than navigating to the record edit page.
*      Only shown when permissions > 1.
*
*   3. Activity log (dd542) or Time Machine (dd15)
*      Renders a plain container div with a distinguishing CSS class instead of
*      an interactive button.
*
*   4. Default (read-only)  permissions < 2
*      Renders a disabled button — no navigation, no edit action.
*
*   5. Default (edit)  permissions >= 2
*      Renders an edit-pen button with two actions attached:
*        - navigate()    – fires a 'user_navigation' event to open the record in
*                          the same page (default mousedown action).
*        - open_window() – opens the record edit page in a new browser window
*                          (default contextmenu action).
*      Which action fires on each interaction is controlled by
*      self.show_interface.button_edit_options (action_mousedown / action_contextmenu).
*      Additionally renders a delete button when the 'button_delete' button is
*      present in self.context.buttons AND self.show_interface.button_delete is true.
*
* @param {Object} options - Row render options supplied by section_record.
* @param {Object} options.caller - The section or portal instance that owns this list.
* @param {string|number} options.section_id - The record's section_id.
* @param {string} options.section_tipo - The record's ontology tipo, e.g. 'dd345'.
* @param {number} options.paginated_key - Zero-based position of this row in the full result set.
*   Used as the SQO offset when navigating to a specific record in edit mode.
* @returns {DocumentFragment} Fragment containing the rendered id-column nodes.
*/
export const render_column_id = function(options) {

	// options
		const self			= options.caller // object instance, usually section or portal
		const section_id	= options.section_id
		const section_tipo	= options.section_tipo
		const paginated_key	= options.paginated_key // int . Current item paginated_key in all result

	// permissions
		// Integer level: 0=none, 1=read, 2=edit, 3=admin (same scale as server-side permissions).
		const permissions = self.permissions

	// show_interface
		// show_interface is a map of feature flags that control which UI controls appear.
		// It is set by common.set_context_vars from the server context response.
		const show_interface = self.show_interface || {}

	// DocumentFragment
		const fragment = new DocumentFragment()

	// section_id
		// The id_node is a shared span; the switch below appends it to whichever
		// button/container is built for this row.
		const section_id_node = ui.create_dom_element({
			element_type	: 'span',
			class_name		: 'section_id',
			text_content	: section_id
		})
		if(SHOW_DEBUG===true) {
			// Expose the absolute row position (paginated_key) as a tooltip in debug mode
			// so developers can verify SQO offset arithmetic when navigating to a record.
			section_id_node.title = 'paginated_key: ' + paginated_key
		}
		// font-size and column width are adapted once at the list level
		// via scoped CSS variables set on list_body — see view_default_list_section.get_content_data

	// buttons
		// Priority switch: the first truthy case wins and determines which button
		// variant to render.  Cases are evaluated in source order.
		switch(true){

			// initiator. is a url var used in iframe containing section list to link to opener portal
			// This case handles a section list rendered inside an <iframe> that was
			// opened by a component_portal (or similar) in the parent window.  The
			// component's instance ID is passed as the 'initiator' URL variable so we
			// can reach back across the window boundary to publish link/unlink events.
			case (self.initiator?.includes('component_')): {

				// (!) window.parent is the parent frame; it may equal window itself if
				// the page is not embedded.  get_instance_by_id is a global helper
				// exposed on the parent page object.
				const top_window 	= window.parent
				const initiator		= self.initiator
				const caller_instance = top_window ? top_window.get_instance_by_id(initiator) : null

				// link_icon
				// Starts hidden (hide_opacity) so the icon only becomes visible once
				// _update_link_button has determined the correct state asynchronously.
					const link_icon = ui.create_dom_element({
						element_type	: 'span',
						class_name		: 'button link icon hide_opacity'
					})

				// link_button. component portal caller (link)
					const link_button = ui.create_dom_element({
						element_type	: 'button',
						class_name		: 'link_button',
						parent			: fragment
					})

				// update link button
				// Fire-and-forget: resolves the linked/unlinked initial state without
				// blocking the synchronous render of this row.  The icon becomes visible
				// once the promise settles (see _update_link_button → requestAnimationFrame).
					_update_link_button(initiator, link_icon, link_button, section_tipo, section_id)

				// Click event
				// Optimistic UI pattern: update the in-memory Map and the icon immediately,
				// then publish the cross-window event.  The parent component receives the
				// event and persists the change; no round-trip to the server is made here.
					const link_click_handler = (e) => {
						e.stopPropagation()

						if (!top_window || !top_window.event_manager) {
							console.error('Unable to get top_window event_manager:', top_window);
							return
						}

						// item_key: composite string used as the Map key.
						// Matching must be type-safe; section_id from the server can be
						// a number while entries_full items may be strings.
						const item_key = String(section_tipo) + '_' + String(section_id)
						const is_added = caller_instance && caller_instance.session_linked_items
							? caller_instance.session_linked_items.get(item_key) === true
							: false

						if (is_added) {
							// top window event to unlink
							top_window.event_manager.publish('initiator_unlink_' + initiator, {
								section_tipo	: section_tipo,
								section_id		: section_id,
								close_modal		: false
							})
							// update session state
							// Mirror the removal in the cached Map so subsequent clicks in
							// the same session do not need another API fetch.
							if (caller_instance && caller_instance.session_linked_items) {
								caller_instance.session_linked_items.set(item_key, false)
							}
							// keep entries_full synchronized (remove item)
							if (caller_instance && Array.isArray(caller_instance.data?.entries_full)) {
								const index = caller_instance.data.entries_full.findIndex(
									item => String(item.section_tipo) === String(section_tipo) && String(item.section_id) === String(section_id)
								)
								if (index !== -1) caller_instance.data.entries_full.splice(index, 1)
							}
							// Decrement the cached total used by _update_link_button's
							// cache-invalidation guard so the Map is not discarded prematurely.
							if (caller_instance && caller_instance.data?.pagination?.total !== undefined) {
								caller_instance.data.pagination.total = Math.max(0, caller_instance.data.pagination.total - 1)
								caller_instance._linked_cache_total = caller_instance.data.pagination.total
							}
							// optimistically update UI
							_set_link_button_state(false, link_icon, link_button)
						} else {
							// top window event to link
							top_window.event_manager.publish('initiator_link_' + initiator, {
								section_tipo	: section_tipo,
								section_id		: section_id,
								close_modal		: false
							})
							// update session state
							if (caller_instance && caller_instance.session_linked_items) {
								caller_instance.session_linked_items.set(item_key, true)
							}
							// keep entries_full synchronized (add item)
							// Guard against duplicates: only push when not already present.
							if (caller_instance && Array.isArray(caller_instance.data?.entries_full)) {
								const exists = caller_instance.data.entries_full.some(
									item => String(item.section_tipo) === String(section_tipo) && String(item.section_id) === String(section_id)
								)
								if (!exists) caller_instance.data.entries_full.push({ section_tipo, section_id })
							}
							if (caller_instance && caller_instance.data?.pagination?.total !== undefined) {
								caller_instance.data.pagination.total += 1
								caller_instance._linked_cache_total = caller_instance.data.pagination.total
							}
							// optimistically update UI
							_set_link_button_state(true, link_icon, link_button)
						}
					}
					link_button.addEventListener('click', link_click_handler)
					// Append nodes
					link_button.appendChild(section_id_node)
					link_button.appendChild(link_icon)


				// button_edit
					// const button_edit = ui.create_dom_element({
					// 	element_type	: 'button',
					// 	class_name		: 'button_edit',
					// 	parent			: fragment
					// })
					// button_edit.addEventListener('click', async function(){
					// 	// navigate link
					// 		// const user_navigation_options = {
					// 		// 	tipo		: section_tipo,
					// 		// 	section_id	: section_id,
					// 		// 	model		: self.model,
					// 		// 	mode		: 'edit'
					// 		// }
					// 		const user_navigation_rqo = {
					// 			caller_id	: self.id,
					// 			source		: {
					// 				action			: 'search',
					// 				model			: 'section',
					// 				tipo			: section_tipo,
					// 				section_tipo	: section_tipo,
					// 				mode			: 'edit',
					// 				lang			: self.lang
					// 			},
					// 			sqo : {
					// 				section_tipo		: [{tipo : section_tipo}],
					// 				limit				: 1,
					// 				offset				: 0,
					// 				filter_by_locators	: [{
					// 					section_tipo : section_tipo,
					// 					section_id : section_id
					// 				}]
					// 			}
					// 		}

					// 		if(SHOW_DEBUG===true) {
					// 			console.log("// section_record build_id_column user_navigation_rqo initiator component:", user_navigation_rqo);
					// 		}
					// 		event_manager.publish('user_navigation', user_navigation_rqo)

					// 	// detail_section
					// 		// ( async () => {
					// 		// 	const options = {
					// 		// 		model 			: 'section',
					// 		// 		type			: 'section',
					// 		// 		tipo			: self.section_tipo,
					// 		// 		section_tipo  	: self.section_tipo,
					// 		// 		section_id 		: self.section_id,
					// 		// 		mode 			: 'edit',
					// 		// 		lang 			: page_globals.dedalo_data_lang
					// 		// 	}
					// 		// 	const page_element_call	= await data_manager.get_page_element(options)
					// 		// 	const page_element		= page_element_call.result

					// 		// 	// detail_section instance. Create target section page element and instance
					// 		// 		const detail_section = await get_instance(page_element)

					// 		// 		// set self as detail_section caller (!)
					// 		// 			detail_section.caller = initiator

					// 		// 		// load data and render wrapper
					// 		// 			await detail_section.build(true)
					// 		// 			const detail_section_wrapper = await detail_section.render()

					// 		// 	// modal container (header, body, footer, size)
					// 		// 		const header = ui.create_dom_element({
					// 		// 			element_type	: 'div',
					// 		// 			text_content 	: detail_section.label
					// 		// 		})
					// 		// 		const modal = ui.attach_to_modal(header, detail_section_wrapper, null, 'big')
					// 		// 		modal.on_close = () => {
					// 		// 			detail_section.destroy(true, true, true)
					// 		// 		}
					// 		// })()

					// 	// iframe
					// 		// ( async () => {
					// 		// 	const iframe = ui.create_dom_element({
					// 		// 		element_type	: 'iframe',
					// 		// 		src 			: DEDALO_CORE_URL + '/page/?tipo=' + self.section_tipo + '&section_id=' + self.section_id + '&mode=edit'
					// 		// 	})
					// 		// 	// modal container (header, body, footer, size)
					// 		// 		const header = ui.create_dom_element({
					// 		// 			element_type	: 'div',
					// 		// 			text_content 	: detail_section.label
					// 		// 		})
					// 		// 		const modal = ui.attach_to_modal(header, iframe, null, 'big')
					// 		// 		modal.on_close = () => {
					// 		// 			detail_section.destroy(true, true, true)
					// 		// 	}
					// 		// })()
					// })
					// button_edit.appendChild(section_id_node)
					// // edit_icon
					// 	ui.create_dom_element({
					// 		element_type	: 'span',
					// 		class_name		: 'button edit icon',
					// 		parent			: button_edit
					// 	})
				break;
			}

			// section_tool source: the list is driven by a tool configuration rather
			// than the default record-navigation workflow.  Clicking the edit pen
			// opens the configured tool (e.g. a data-import or batch-edit tool)
			// with this row's section_id as context.
			case (self.config && self.config.source_model==='section_tool'): {

				// button_edit (pen)
				// Only show the pen button for users with write permission (permissions > 1).
				if ( permissions > 1 ) {

					const button_edit = ui.create_dom_element({
						element_type	: 'button',
						// CSS suffix from tool_context.name lets each tool apply its own styles.
						class_name		: 'button_edit list_'+ self.config.tool_context.name,
						parent			: fragment
					})
					button_edit.addEventListener('click', function(e){
						e.stopPropagation();

						// tool_context
							const tool_context = self.config.tool_context

						// section_id_selected (!) Important to allow parse 'self' values
						// (!) Must be set on self BEFORE calling open_tool so that any
						// ddo_map entries with section_id==='self' can be resolved by the tool.
							self.section_id_selected = section_id

						// parse ddo_map section_id. (!) Unnecessary. To be done at tool_common init
							// tool_context.tool_config.ddo_map.map(el => {
							// 	if (el.section_id==='self') {
							// 		el.section_id = section_id
							// 	}
							// })

						// open_tool (tool_common)
							open_tool({
								tool_context	: tool_context,
								caller			: self
							})
					})
					button_edit.appendChild(section_id_node)
					// edit_icon
					ui.create_dom_element({
						element_type	: 'span',
						class_name		: 'button edit icon',
						parent			: button_edit
					})
				}
				break;
			}

			// Activity log (dd542) and Time Machine (dd15) sections use a plain
			// container div rather than an interactive button — these records are
			// read-only audit trails and cannot be navigated to in edit mode.
			case (self.tipo==='dd542' || self.tipo==='dd15'): {

				// activity | time_machine cases

				const add_css = self.tipo==='dd15' ? 'time_machine' : 'activity'

				const button_edit = ui.create_dom_element({
					element_type	: 'div',
					class_name		: 'section_id_container ' + add_css,
					parent			: fragment
				})
				// Append generic section_id_node
				button_edit.appendChild(section_id_node)
				break;
			}

			default: {
				if ( permissions < 2 ) {

					// read only case
					// Render a visually disabled (non-clickable) button so the id column
					// still renders consistently but provides no edit action.

					const button_edit = ui.create_dom_element({
						element_type	: 'button', // button|a
						class_name		: 'button_edit disable',
						parent			: fragment
					})
					button_edit.appendChild(section_id_node)

				}else{

					// url
					// Pre-build the full page URL for the open_window action.
					// session_save=false prevents overwriting the user's current list
					// session when the record is opened in a new window.
					// menu=false hides the navigation menu when session_save is false
					// (no saved session means the menu cannot restore the previous state).
						const url = DEDALO_CORE_URL + '/page/?' + object_to_url_vars({
							tipo			: section_tipo,
							section_tipo	: section_tipo,
							id				: section_id,
							mode			: 'edit',
							session_save	: false, // prevent to overwrite current section session
							menu			: false // prevent navigation when session_save = false
						})

					// button_edit (pen)
					// Two action methods are attached directly to the button DOM node so
					// both event listeners can dispatch the correct action without closures
					// that capture the wrong fn reference.
					// button_edit
						const button_edit = ui.create_dom_element({
							element_type	: 'button', // button|a
							class_name		: 'button_edit',
							parent			: fragment
						})
						// open_window action
						// Opens the record in a new browser window/tab using the pre-built
						// url above.  The on_blur callback refreshes the list when the
						// window loses focus (user returns from the record edit page).
						button_edit.open_window = (features) => {

							// open a new window
							open_window({
								url			: url,
								name		: 'record_view_' + section_id,
								features	: features || null,
								on_blur : () => {
									// refresh current instance
									self.refresh({
										build_autoload : true
									})
								}
							})
						}//end open_window
						// navigate action
						// Navigates within the same page by publishing a 'user_navigation'
						// event.  The SQO is cloned from the current list RQO so the edit
						// view inherits the same search/filter context; only limit and offset
						// are overridden to land on exactly this record.
						button_edit.navigate = () => {

							// MODE USING PAGE USER_NAVIGATION
							// sqo. Note that sqo will be used as request_config.sqo on navigate
								const sqo = clone(self.rqo.sqo)
								// set updated filter
								sqo.filter = self.rqo.sqo.filter
								// reset pagination
								// limit=1 shows only this record in edit view; offset=paginated_key
								// positions it correctly within the result set for prev/next navigation.
								sqo.limit	= 1
								sqo.offset	= paginated_key

							// source
								const source = {
									action				: 'search',
									model				: self.model, // 'section'
									tipo				: section_tipo,
									section_tipo		: section_tipo,
									// section_id		: section_id, // (!) enabling affect local db stored rqo's
									section_id_selected	: section_id,
									mode				: 'edit',
									lang				: self.lang
								}

							// user_navigation
								const user_navigation_rqo = {
									caller_id	: self.id,
									source		: source,
									sqo			: sqo
								}
								// page js is observing this event
								event_manager.publish('user_navigation', user_navigation_rqo)
						}//end navigate

						// contextmenu event
							// Prevent the browser's native context menu.
							// Instead, dispatch the action configured in show_interface
							// (defaults to open_window so right-click opens a new window).
							// If alt is also held, open a new tab instead.
							button_edit.addEventListener('contextmenu', (e) => {
								e.stopPropagation()
								e.preventDefault();

								// if alt is pressed open new tab instead new window
								const features = e.altKey===true
									? 'new_tab'
									: null

								// function to execute. see definition in common.set_context_vars
								// values: string navigate|open_window
								const fn = show_interface.button_edit_options?.action_contextmenu || 'open_window'
								if (typeof button_edit[fn]==='function') {
									return button_edit[fn](features)
								}
							})

						// mousedown event
							// Use mousedown instead of click so the action fires before
							// any blur event that might destroy the list instance.
							button_edit.addEventListener('mousedown', (e) => {
								e.stopPropagation()
								e.preventDefault()

								// if the user click with right mouse button, stop here
								// Right-click (which===3) is handled by the contextmenu listener above.
								// altKey+click is also deferred to contextmenu (opens new tab).
								if (e.which == 3 || e.altKey===true) {
									return
								}

								// function to execute. see definition in common.set_context_vars
								// values: string navigate|open_window
								const fn = show_interface.button_edit_options?.action_mousedown || 'navigate'
								if (typeof button_edit[fn]==='function') {
									return button_edit[fn]()
								}

								/* MODE USING SECTION change_mode
									// menu. Get from caller page
										const menu = self.caller && self.caller.ar_instances
											? self.caller.ar_instances.find(el => el.model==='menu')
											: null;
									// change section mode. Creates a new instance and replace DOM node wrapper
										self.change_mode({
											mode : 'edit'
										})
										.then(function(new_instance){

											async function section_label_on_click(e) {
												e.stopPropagation();

												new_instance.change_mode({
													mode : 'list'
												})
												.then(function(list_instance){

													// update_section_label value
													menu.update_section_label({
														value					: list_instance.label,
														mode					: 'list',
														section_label_on_click	: null
													})

													// update browser url and navigation history
													const source	= create_source(list_instance, null)
													const sqo		= list_instance.request_config_object.sqo
													const title		= list_instance.id
													// url search. Append section_id if exists
													const url_vars = url_vars_to_object({
														tipo : list_instance.tipo,
														mode : list_instance.mode
													})
													const url = '?' + object_to_url_vars(url_vars)
													// browser navigation update
													push_browser_history({
														source	: source,
														sqo		: sqo,
														title	: title,
														url		: url
													})
												})
											}//end section_label_on_click

											// update_section_label value
												menu.update_section_label({
													value					: new_instance.label,
													mode					: new_instance.mode,
													section_label_on_click	: section_label_on_click
												})

											// update browser url and navigation history
												const source	= create_source(new_instance, null)
												const sqo		= new_instance.request_config_object.sqo
												const title		= new_instance.id
												// url search. Append section_id if exists
												const url_vars = url_vars_to_object({
													tipo : new_instance.tipo,
													mode : new_instance.mode
												})
												const url = '?' + object_to_url_vars(url_vars)
												// browser navigation update
												push_browser_history({
													source	: source,
													sqo		: sqo,
													title	: title,
													url		: url
												})
										})//end then
										*/
							})
						button_edit.appendChild(section_id_node)

					// edit_icon
						ui.create_dom_element({
							element_type	: 'span',
							class_name		: 'button edit icon',
							parent			: button_edit
						})

					// button_delete (trash can)
					// The delete button is optional: it must be declared in the ontology
					// context (context.buttons) AND explicitly enabled in show_interface.
					// Both conditions must be true to render the button, preventing
					// accidental deletion in views where it was not configured.
						const button_delete = self.context.buttons && self.context.buttons.length
							? self.context.buttons.find(el => el.model==='button_delete')
							: null

						if (button_delete && self.show_interface.button_delete===true) {
							// delete_button
								// icon-only: the name says what it deletes (WCAG 4.1.2, axe button-name)
								const delete_label = (get_label.delete || 'Delete') + ' ' + section_id
								const delete_button = ui.create_dom_element({
									element_type	: 'button',
									class_name		: 'button_delete',
									title			: delete_label,
									aria			: {label : delete_label},
									parent			: fragment
								})
								// delete event
								// Publishes a scoped 'delete_section_<id>' event that section.init
								// subscribes to.  The SQO payload targets exactly this one record
								// so the server-side delete is unambiguous.
								const delete_handler = (e) => {
									e.stopPropagation()

									// fire delete_section event, see section.init
									event_manager.publish('delete_section_' + options.caller.id, {
										section_tipo	: section_tipo,
										section_id		: section_id,
										caller			: options.caller, // section
										sqo				: {
											section_tipo		: [section_tipo],
											filter_by_locators	: [{
												section_tipo	: section_tipo,
												section_id		: section_id
											}],
											limit				: 1
										}
									})
								}
								delete_button.addEventListener('click', delete_handler)
							// delete_icon
								ui.create_dom_element({
									element_type	: 'span',
									class_name		: 'button delete_light icon',
									parent			: delete_button
								})
						}
				}
				break;
			}
		}


	return fragment
}//end render_column_id



/**
* _UPDATE_LINK_BUTTON
* Async private helper that resolves and applies the initial linked/unlinked
* visual state for a row's link button in portal-picker mode.
*
* Strategy (in order):
*   1. Cache-invalidation check: if the parent component's data reference or
*      pagination total changed since the last render, wipe the session Map so
*      it is rebuilt from fresh data.
*   2. Instant path: if session_linked_items (a Map) already exists on the
*      caller instance, look up the key and return immediately — no API call.
*   3. Inline-data shortcut: if total <= limit, all linked items are already
*      in caller_instance.data.entries; copy them into entries_full directly.
*   4. New-record shortcut: if section_id is '0' or empty, no items can be
*      linked yet — set entries_full to [].
*   5. API fetch: fire a single 'read_raw' request for the caller component's
*      full linked-item list.  A shared promise (_loading_full_data) is stored
*      on the caller instance to prevent redundant parallel requests when many
*      rows are initialized simultaneously (race-condition guard).
*   6. Build the session_linked_items Map from entries_full once, then update
*      the button and reveal the icon via requestAnimationFrame.
*
* Side effects:
*   - Mutates caller_instance.session_linked_items (Map).
*   - Mutates caller_instance.data.entries_full (Array).
*   - Mutates caller_instance._linked_cache_entries_ref and _linked_cache_total.
*   - Temporarily sets caller_instance._loading_full_data (Promise; deleted in finally).
*   - Calls _set_link_button_state on the supplied DOM elements.
*   - Schedules a requestAnimationFrame to remove 'hide_opacity' from link_icon.
*
* @private
* @param {string} initiator - Instance ID of the component_portal caller in the parent window.
* @param {HTMLElement} link_icon - Icon span whose CSS classes reflect the linked state.
* @param {HTMLElement} link_button - Button element that wraps the icon; receives 'added' class.
* @param {string|number} section_tipo - Ontology tipo of the row's section.
* @param {string|number} section_id - Record id of the row.
* @returns {Promise<void>}
*/
const _update_link_button = async function(initiator, link_icon, link_button, section_tipo, section_id) {

	if (!initiator) return

	const top_window = window.parent
	if (!top_window || typeof top_window.get_instance_by_id !== 'function') return

	const caller_instance = top_window.get_instance_by_id(initiator)
	if (!caller_instance) {
		console.error('Caller instance not found for initiator:', initiator)
		return
	}

	// Cache Invalidation Check
	// If the parent component's data reference or total changed (e.g. user manually unlinked/linked externally),
	// we wipe the cached state so it reliably regenerates with fresh component state on reopening the iframe.
	const current_entries_ref = caller_instance.data?.entries
	const current_total = caller_instance.data?.pagination?.total
	if (
		caller_instance._linked_cache_entries_ref !== current_entries_ref ||
		caller_instance._linked_cache_total !== current_total
	) {
		caller_instance.session_linked_items = null
		delete caller_instance._loading_full_data
		if (caller_instance.data) {
			caller_instance.data.entries_full = null
		}
		caller_instance._linked_cache_entries_ref = current_entries_ref
		caller_instance._linked_cache_total = current_total
	}

	// Instant Return Optimization
	// If the session Map already exists, just update the UI and return.
	if (caller_instance.session_linked_items) {
		const item_key = String(section_tipo) + '_' + String(section_id)
		const is_added = caller_instance.session_linked_items.get(item_key) === true
		_set_link_button_state(is_added, link_icon, link_button)

		requestAnimationFrame(() => link_icon?.classList.remove('hide_opacity'))
		return
	}

	// Ensure caller_instance.data exists
	if (!caller_instance.data) {
		caller_instance.data = {}
	}

	// Try to get the full data from the caller instance
	const total = caller_instance.data.pagination?.total
	const limit = caller_instance.data.pagination?.limit || 10
	// Check if the data is below the limit.
	// If so, fetch the full data from component data, and prevent fetching full data from API.
	if (total !== undefined && (total <= limit)) {
		caller_instance.data.entries_full = caller_instance.data.entries || []
	} else if (!caller_instance.section_id || same_section_id(caller_instance.section_id, 0)) {
		// Optimization: if it is a new record, it cannot have linked items.
		caller_instance.data.entries_full = []
	}

	try {
		// Race condition protection: If data is being loaded, wait for the existing loading promise.
		// This prevents redundant API calls when multiple buttons (rows) are initialized simultaneously.
		if (caller_instance._loading_full_data) {
			await caller_instance._loading_full_data
		} else if (!caller_instance.data.entries_full) {

			// Create a shared promise for the API request
			caller_instance._loading_full_data = (async () => {
				const rqo = {
					action	: 'read_raw',
					options	: {
						type			: 'component',
						section_tipo	: caller_instance.section_tipo,
						tipo			: caller_instance.tipo,
						model			: caller_instance.model
					},
					sqo : {
						select 				: [],
						section_tipo		: [caller_instance.section_tipo],
						filter_by_locators 	: [{
							section_tipo : caller_instance.section_tipo,
							section_id : caller_instance.section_id
						}]
					}
				}
				const api_response = await data_manager.request({
					body : rqo
				})
				// Expecting the payload's first row to contain the array of linked items
				caller_instance.data.entries_full = response_data(api_response)?.[0] || []
			})()

			try {
				await caller_instance._loading_full_data
			} finally {
				delete caller_instance._loading_full_data
			}
		}

		// Initialize session_linked_items Map once from the full data array
		if (!caller_instance.session_linked_items) {
			caller_instance.session_linked_items = new Map()
			if (Array.isArray(caller_instance.data.entries_full)) {
				caller_instance.data.entries_full.forEach(item => {
					if (item.section_tipo && item.section_id) {
						const key = String(item.section_tipo) + '_' + String(item.section_id)
						caller_instance.session_linked_items.set(key, true)
					}
				})
			}
		}

		// Final UI update
		const item_key = String(section_tipo) + '_' + String(section_id)
		const is_added = caller_instance.session_linked_items.get(item_key) === true

		_set_link_button_state(is_added, link_icon, link_button)

	} catch (error) {
		console.error('Error in _update_link_button:', error)
	} finally {
		// Ensure the icon is at least revealed if it was hidden via hide_opacity
		requestAnimationFrame(() => {
			link_icon?.classList.remove('hide_opacity')
		})
	}
}//end _update_link_button



/**
* _SET_LINK_BUTTON_STATE
* Synchronous helper that reflects a known linked/unlinked boolean onto the
* button and icon DOM elements immediately, without any data lookup.
*
* When linked (is_added===true):
*   - link_button gets class 'added' and title 'Remove'.
*   - link_icon gets class 'check'; class 'link' is removed.
* When unlinked:
*   - link_button loses class 'added'; title is cleared.
*   - link_icon gets class 'link'; class 'check' is removed.
*
* @private
* @param {boolean} is_added - true when the row's record is currently linked to the caller component.
* @param {HTMLElement} link_icon - Icon span element whose CSS classes are toggled.
* @param {HTMLElement} link_button - Button element that wraps the icon; may be null/undefined.
* @returns {void}
*/
const _set_link_button_state = function(is_added, link_icon, link_button) {

	if (is_added) {
		if (link_button) {
			link_button.classList.add('added')
			link_button.title = 'Remove'
		}
		link_icon.classList.add('check')
		link_icon.classList.remove('link')
	} else {
		if (link_button) {
			link_button.classList.remove('added')
			link_button.title = ''
		}
		link_icon.classList.add('link')
		link_icon.classList.remove('check')
	}
}//end _set_link_button_state



// @license-end
