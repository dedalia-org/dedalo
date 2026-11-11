// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_label, page_globals, SHOW_DEBUG, DEDALO_CORE_URL*/
/*eslint no-undef: "error"*/



// imports
	import {event_manager} from '../../common/js/event_manager.js'
	import {get_instance} from '../../common/js/instances.js'
	import {object_to_url_vars, open_window, same_section_id} from '../../common/js/utils/index.js'
	import {ui} from '../../common/js/ui.js'
	import {render_value} from '../../common/js/utils/render_escape.js'
	import {get_dataframe} from '../../component_common/js/component_common.js'
	import {delete_dataframe} from '../../component_common/js/component_common.js'
	import {handle_select_change} from './component_select.js'
	import {
		get_content_data
	} from './render_edit_component_select.js'



/**
* VIEW_DEFAULT_EDIT_SELECT
* Default edit-mode view for component_select.
*
* Provides the full edit UI for a select component: a native <select> element
* populated from the server-resolved datalist, an optional inline dataframe for
* qualifying the selected value, and an action toolbar (button_add / button_list /
* tools buttons) subject to permission guards.
*
* Architecture note
* -----------------
* This module is a *view* — it only builds DOM nodes and wires events; all state
* mutations go through the shared helpers in component_select.js
* (handle_select_change → set_changed_data → change_value → save) and
* component_common (get_dataframe / delete_dataframe).  No API calls are made
* directly from this file.
*
* Render flow (called by render_edit_component_select.prototype.edit):
*   render()  →  get_content_data()  →  get_content_value()  (one per entry)
*                                    →  get_content_value_read()  (permissions === 1)
*           →  get_buttons()         →  button_add / button_list / tools
*           →  ui.component.build_wrapper_edit()
*
* Value shape (self.data.entries[n]):
*   { section_id: string, section_tipo: string, id: number }
*   where `id` is the stable data-item id used as the dataframe pairing key.
*
* Datalist shape (self.data.datalist[n]):
*   { label: string, value: { section_id: string, section_tipo: string } | null,
*     section_id?: string }
*   The empty sentinel { label: '', value: null } is prepended at render time.
*
* Context shape (self.context):
*   { target_sections: Array<{ tipo, label, permissions, permissions_new }>,
*     view: string }
*
* show_interface flags consumed here:
*   button_edit  — pen icon on the select row to open the linked record
*   button_add   — toolbar button to create a new target-section record
*   button_list  — toolbar button to open the target section in list mode
*   tools        — render the tools toolbar via ui.add_tools()
*
* Related modules
* ---------------
* component_select.js          — handle_select_change, build_changed_data_item
* render_edit_component_select.js — get_content_data, edit() dispatcher
* view_line_edit_select.js     — alternative single-row layout
* component_common/dataframe.js — get_dataframe, delete_dataframe
*
* @module view_default_edit_select
*/



/**
* VIEW_DEFAULT_EDIT_SELECT
* Constructor stub — this module is used as a namespace for static methods;
* the constructor itself is never instantiated directly.
*/
export const view_default_edit_select = function() {

	return true
}//end view_default_edit_select



/**
* RENDER
* Entry point called by render_edit_component_select.prototype.edit().
* Builds the full wrapper DOM tree for the default edit view, or returns only
* the content_data subtree when render_level === 'content' (used for in-place
* refresh without rebuilding buttons / wrapper).
*
* Side effects:
*   - Attaches content_data as wrapper.content_data for downstream access.
*   - When permissions > 1, appends the buttons container to the wrapper.
*
* @param {Object} self - Component instance (component_select) providing .data,
*   .context, .permissions, .show_interface, .section_id, .section_tipo, .tipo
* @param {Object} options - Render options
* @param {string} [options.render_level='full'] - 'content' to return only the
*   content_data node; 'full' (default) to return the complete wrapper
* @returns {Promise<HTMLElement>} wrapper (full) or content_data node (content)
*/
view_default_edit_select.render = async function(self, options) {

	// options
		const render_level = options.render_level || 'full'

	// content_data
		const content_data = get_content_data(self, {
			render_content_data			: get_content_value,
			render_content_value_read	: get_content_value_read
		})
		if (render_level==='content') {
			return content_data
		}

	// buttons
		const buttons = (self.permissions > 1)
			? get_buttons(self)
			: null

	// wrapper. ui build_edit returns component wrapper
		const wrapper = ui.component.build_wrapper_edit(self, {
			content_data	: content_data,
			buttons			: buttons
		})
		// set pointers
		wrapper.content_data = content_data


	return wrapper
}//end render



/**
* GET_CONTENT_VALUE
* Builds the interactive content node for a single select entry (edit mode).
*
* Creates a native <select> element populated with all datalist options, sets the
* currently selected option, and wires three events:
*
*  focus  — activates the component when reached via tab navigation.
*  click  — stops click from bubbling to the section (prevents accidental deactivation).
*  change — full save pipeline:
*             1. delete_dataframe() to remove any existing frame for the old value,
*                because a value change is an 'update' action; the server remove-cascade
*                does NOT fire, so the client must unlink the frame explicitly.
*             2. handle_select_change() to parse, persist and save the new value.
*             3. Show/hide the button_edit pen icon and load a fresh dataframe for the
*                new selection.
*             4. Publish 'set_lang_value_<id_base>' so sibling components
*                (e.g. component_select_lang) can react to the language change.
*
* If the component already has a value when the view is first rendered, the matching
* dataframe is fetched and appended asynchronously (fire-and-forget .then()).
*
* Dataframe pairing key
* ---------------------
* The pairing key is ALWAYS self.data.entries[0].id (the stable data-item id assigned
* by the server), never the target section_id. This avoids collisions when the same
* target record is linked from multiple components.  The id is re-read from self.data
* after each save because the first save on an empty component assigns the id for the
* first time.
*
* Empty sentinel option
* ---------------------
* An { label: '', value: null } option is unshift()ed into the datalist so the user
* can actively de-select a value.  This mutation is local to this render call;
* the datalist reference is shared from self.data so callers should be aware.
* (!) The unshift() mutates self.data.datalist in place.
*
* @param {number} i - Zero-based index of this entry within the entries array
*   (always 0 for component_select which holds at most one value)
* @param {Object|null} current_value - Locator for the currently stored value:
*   { section_id: string, section_tipo: string, id?: number } or null when empty
* @param {Object} self - Component instance pointer
* @returns {HTMLElement} content_value div containing the <select> and optional
*   button_edit pen and dataframe node
*/
const get_content_value = (i, current_value, self) => {

	// short vars
		const data					= self.data || {}

	// add empty option at beginning of the datalist array.
	// Build a new array instead of mutating the shared/cached data.datalist,
	// which would accumulate duplicate empty options on every re-render.
		const empty_option = {
			label	: '',
			value	: null
		}
		const datalist				= [empty_option, ...(data.datalist || [])]

	// content_value
		const content_value = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'content_value'
		})

	// select
		const select = ui.create_dom_element({
			element_type	: 'select',
			class_name		: 'select',
			parent			: content_value
		})
		// focus event
			const focus_handler = () => {
				// force activate on input focus (tabulating case)
				if (!self.active) {
					ui.component.activate(self)
				}
			}
			select.addEventListener('focus', focus_handler)
		// click event
			select.addEventListener('click', function(e){
				e.stopPropagation()
			})
		// change event
			const change_handler = async function(e) {

				// when user changes the value of the select, remove its dataframe
				// (explicit unlink: a select value change is an 'update' action and
				// does not fire the server remove cascade)
				// read current entry values dynamically (they change after each save)
				// pairing key is the data item id, never the target section_id
				// NOT awaited, deliberately: handle_select_change below must set
				// changed_data SYNCHRONOUSLY on the change event (the unsaved-data
				// guard and the select gates read it right after dispatch), and
				// an await ahead of it breaks that contract. Since 2026-09-21 this
				// is a real slot `remove` (the server strips the frame and applies
				// the slot's delete policy to its target), so the frame unlink and
				// the value save are two requests on one record, issued in this
				// order; a refused unlink is surfaced by the save path's own error
				// handling. `false` is the ordinary answer of an item with no frame.
					const current_entry = self.data.entries?.[0] || null
					if(current_entry?.id){
						delete_dataframe({
							self				: self,
							section_id			: self.section_id,
							section_tipo		: self.section_tipo,
							id_key				: current_entry.id,
							main_component_tipo	: self.tipo,
							delete_instace		: true
						})
					}

				// common change handler (parse, build changed_data_item, set_changed_data, change_value)
				// read id dynamically from self.data (not from stale closure)
				const current_id = self.data.entries?.[0]?.id ?? null
				const parsed_value = await handle_select_change(self, select, current_id)

				// show/hide button_edit based on value
					if (select.button_edit) {
						if (parsed_value) {
							select.button_edit.classList.remove('hide')

							// pairing key is the data item id (re-read after save)
							const value_item_id = self.data.entries?.[0]?.id ?? parsed_value.id

							const component_dataframe = await get_dataframe({
								self				: self,
								section_id			: self.section_id,
								section_tipo		: self.section_tipo,
								id_key				: value_item_id,
								main_component_tipo	: self.tipo,
								view				: 'default'
							})

							if (component_dataframe) {

								self.ar_instances.push(component_dataframe)
								const dataframe_node = await component_dataframe.render()

								content_value.appendChild(dataframe_node)
								// set pointers
								select.dataframe = dataframe_node
							}

						}else{
							select.button_edit.classList.add('hide')
						}
					}

				// set_lang_value publish event
				// Notify sibling language-selector components (e.g. component_select_lang)
				// about the new selection so they can sync their displayed language.
				// The event channel is 'set_lang_value_<section_tipo>_<section_id>_<tipo>'.
					if (parsed_value) {
						const datalist_item = datalist.find(el =>
							el.value &&
							String(el.value.section_id)===String(parsed_value.section_id) &&
							el.value.section_tipo==parsed_value.section_tipo
						)
						if (datalist_item) {
							event_manager.publish('set_lang_value_' + self.id_base, datalist_item.section_id)
						}
					}
			}
			select.addEventListener('change', change_handler)

	// select options
	// Iterate datalist (which now starts with the empty sentinel) and create one
	// <option> per item. In debug mode the section_id is appended to the label.
		const datalist_length = datalist.length
		for (let i = 0; i < datalist_length; i++) {

			const datalist_item = datalist[i]

			const current_section_id = typeof datalist_item.section_id!=='undefined'
				? datalist_item.section_id
				: null

			const current_label = (SHOW_DEBUG===true)
				? datalist_item.label + (current_section_id ? " [" + current_section_id + "]" : '')
				: datalist_item.label

			// The option value is the full locator serialized as JSON so parse() can
			// recover the { section_id, section_tipo } object in the change handler.
			const option_node = ui.create_dom_element({
				element_type	: 'option',
				value			: JSON.stringify(datalist_item.value),
				inner_html		: render_value(current_label, self.context.render_class),
				parent			: select
			})
			// selected options set on match
			if (current_value && datalist_item.value &&
				same_section_id(current_value.section_id, datalist_item.value.section_id) &&
				current_value.section_tipo===datalist_item.value.section_tipo
				) {

				option_node.selected = true
			}

			// developer_info
				// if (current_section_id) {
				// 	// developer_info
				// 	ui.create_dom_element({
				// 		element_type	: 'span',
				// 		class_name		: 'developer_info hide show_on_active',
				// 		text_content	: ` [${current_section_id}]`,
				// 		parent			: option_node
				// 	})
				// }
		}//end for (let i = 0; i < datalist_length; i++)

	// button_edit. Default is hidden
	// Shown only when show_interface.button_edit === true (set in render_edit_component_select
	// for global admins). Opens the currently selected target record in a modal window;
	// refreshes the component with build_autoload when the window loses focus.
		if(self.show_interface.button_edit===true) {

			const button_edit = ui.create_dom_element({
				element_type	: 'span',
				class_name		: 'button pen grey show_on_active',
				parent			: content_value
			})
			// set pointers
			select.button_edit = button_edit

			// click event
			const fn_click = function(e) {
				e.stopPropagation()

				// nothing is selected case
					if (!select.value || select.value==='null') {
						return false
					}

				// short vars
					const selected_locator		= JSON.parse(select.value)
					const target_section_tipo	= selected_locator.section_tipo
					const target_section_id		= selected_locator.section_id

				// open a new window
					const url = DEDALO_CORE_URL + '/page/?' + object_to_url_vars({
						tipo			: target_section_tipo,
						id				: target_section_id,
						mode			: 'edit',
						menu			: false,
						session_save	: false
					})
					open_window({
						url		: url,
						name	: 'record_view',
						on_blur : () => {
							// refresh current instance
							return self.refresh({
								build_autoload : true
							})
						}
					})
			}//end fn_click
			button_edit.addEventListener('click', fn_click)

			// hide button on no value
			if (!select.value || select.value==='null') {
				button_edit.classList.add('hide')
			}
		}

	// first dataframe load if the component has data
	// pairing key is the data item id, never the target section_id
	// (!) get_dataframe() is called without await here — the returned Promise is stored
	//     in a local variable but never awaited (fire-and-forget pattern). The dataframe
	//     renders asynchronously and appends itself to content_value when ready.
		if(current_value?.id){

			const component_dataframe = get_dataframe({
				self				: self,
				section_id			: self.section_id,
				section_tipo		: self.section_tipo,
				id_key				: current_value.id,
				main_component_tipo	: self.tipo,
				view				: 'default'
			}).then(async function(component_dataframe){

				if(component_dataframe){

					self.ar_instances.push(component_dataframe)
					const dataframe_node = await component_dataframe.render()

					content_value.appendChild(dataframe_node)
				}
			})
			.catch((error) => {
				console.error('component_select: dataframe load failed', error)
			})
		}


	return content_value
}//end get_content_value



/**
* GET_CONTENT_VALUE_READ
* Builds a read-only content node for a single select entry (permissions === 1).
*
* Used by get_content_data() when the component is rendered in read-only mode (e.g.
* the 'print' view, or when the current user has view-only access).  The resolved
* label string (not the raw locator) is passed as current_value by get_content_data().
*
* @param {number} i - Zero-based index of this entry (unused internally but required
*   by the render_content_value_read callback contract)
* @param {string|null} current_value - The human-readable label string for the stored
*   locator, already resolved by get_content_data from the datalist
* @param {Object} self - Component instance pointer (unused internally)
* @returns {HTMLElement} content_value div with the label as its innerHTML
*/
const get_content_value_read = (i, current_value, self) => {

	// create content_value
		const content_value = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'content_value read_only',
			inner_html		: render_value(current_value, self.context.render_class)
		})


	return content_value
}//end get_content_value_read



/**
* GET_BUTTONS
* Builds the component action toolbar for edit mode.
*
* Conditionally renders up to three groups of buttons based on show_interface flags
* and permission levels:
*
*  button_add   — Creates a new record in the target section (via add_new_element()),
*                 then opens it in a modal; on close the component refreshes.
*                 Guard conditions: permissions_new > 1 AND show_interface.button_add
*                 === true AND model !== 'component_select_lang'.
*                 Multi-section: if target_sections has more than one entry the tipo
*                 would need to be resolved before calling add_new_element(); currently
*                 the handler alerts and returns early when target_sections.length > 1
*                 because the picker is not yet implemented.
*                 After add, any open service_autocomplete is destroyed to clean up.
*
*  button_list  — Opens each target section in list mode in a new window.
*                 One button per target_sections entry; the tipo is stored as a DOM
*                 property on the span so the shared fn_mousedown handler can read it.
*                 Guard: show_interface.button_list === true.
*
*  tools        — Appended via ui.add_tools() (tools defined in context.tools).
*                 Guard: show_interface.tools === true.
*
* Structure returned:
*   buttons_container > buttons_fold > fragment (all button nodes)
* buttons_fold exists to allow sticky positioning on tall components without the
* container itself being sticky.
*
* @param {Object} self - Component instance providing .context, .show_interface,
*   .model, .permissions, .section_id, .section_tipo, .tipo, .data, .ar_instances
* @returns {HTMLElement} buttons_container wrapping all action buttons
*/
const get_buttons = (self) => {

	// short vars
		const target_sections			= self.context.target_sections || []
		const target_sections_length	= target_sections.length
		const show_interface			= self.show_interface

	// permissions to create new values in the target section
	// permissions below 2 can not create new values.
		const permissions_new = target_sections[0]?.permissions_new || 0;

	// fragment
		const fragment = new DocumentFragment()

	// button_add (not in component_select_lang)
		if( permissions_new > 1 && show_interface.button_add === true && self.model !== 'component_select_lang'){

			const button_add = ui.create_dom_element({
				element_type	: 'span',
				class_name		: 'button add',
				title			: get_label.new || 'New',
				parent			: fragment
			})
			const fn_add = async function(e) {
				e.stopPropagation()

				// check current value. LImit to one
					const data	= self.data || {}
					const entries	= data.entries || []
					// if (entries.length>0) {
					// 	alert('Warning. Only one value is allowed');
					// 	return
					// }

				// target_section_tipo. to add section selector
				// (!) When multiple target sections exist, a section-picker UI would be
				//     required to let the user choose the target; this is not yet implemented.
				//     The handler currently alerts and bails out in that case.
					const target_section_tipo = target_sections_length > 1
						? false
						: target_sections[0].tipo
					if (!target_section_tipo) {
						alert('Error. Empty or invalid target_sections');
						return
					}

				// add_new_element
					const result = await self.add_new_element(target_section_tipo)
					if (result===true) {

						// last_value. Get the last value of the portal to open the new section
							const last_value	= self.data.entries[self.data.entries.length-1]
							const section_tipo	= last_value.section_tipo
							const section_id	= last_value.section_id

						// section. Create the new section instance
							const section = await get_instance({
								model			: 'section',
								mode			: 'edit',
								tipo			: section_tipo,
								section_tipo	: section_tipo,
								section_id		: section_id,
								inspector		: false,
								session_save	: false,
								session_key		: 'section_' + section_tipo + '_' + self.tipo
							})
							await section.build(true)
							const section_node = await section.render()

						// header
							// (!) attach_to_modal parses a string header as HTML: the section
							// label is ontology data and goes through the ONE escaper as text.
							const header = (get_label.new || 'New section') + ' ' + render_value(target_sections[0].label, 'text')

						// modal. Create a modal to attach the section node
							const modal = ui.attach_to_modal({
								header	: header,
								body	: section_node
							})
							modal.on_close = function(){
								self.refresh()
							}

						// activate_first_component. Get the first ddo in ddo_map to be focused
							ui.activate_first_component({
								section	: section
							})
					}//end if (result===true)

				// remove aux items
				// Destroy any open autocomplete overlay so it does not linger after
				// the modal has opened. page_globals.service_autocomplete is set by the
				// autocomplete service when active.
					if (window.page_globals.service_autocomplete) {
						window.page_globals.service_autocomplete.destroy(true, true, true)
					}
			}
			button_add.addEventListener('click', fn_add)
		}//end button_add

	// button_list (go to target section)
		if(show_interface.button_list === true){

			const fn_mousedown = (e) => {
				e.stopPropagation()

				const item = e.target

				// open a new window
					const url = DEDALO_CORE_URL + '/page/?' + object_to_url_vars({
						tipo	: item.tipo,
						mode	: 'list',
						menu	: false
					})
					open_window({
						url		: url,
						name	: 'section_view',
						on_blur : () => {
							// refresh current instance
							return self.refresh({
								build_autoload : true
							})
						}
					})
			}//end fn_mousedown

			for (let i = 0; i < target_sections_length; i++) {

				const item = target_sections[i]

				// button edit
				// In debug mode the tipo is appended to the label for identification.
				// Strip HTML tags from the title to avoid browser tooltip artefacts.
					const label = (SHOW_DEBUG===true)
						? `${item.label} [${item.tipo}]`
						: item.label || ''
					const button_list = ui.create_dom_element({
						element_type	: 'span',
						class_name		: 'button pen',
						title			: label.replace(/<\/?[^>]+(>|$)/g, ""),
						parent			: fragment
					})
					// Store tipo directly on the DOM node so fn_mousedown can read it
					// from e.target without a closure variable per iteration.
					button_list.tipo = item.tipo
					button_list.addEventListener('mousedown', fn_mousedown)
			}//end for (let i = 0; i < target_sections_length; i++)
		}

	// tools buttons
		if(show_interface.tools === true){
			ui.add_tools(self, fragment)
		}

	// buttons container
		const buttons_container = ui.component.build_buttons_container(self)

	// buttons_fold (allow sticky position on large components)
		const buttons_fold = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'buttons_fold',
			parent			: buttons_container
		})
		buttons_fold.appendChild(fragment)


	return buttons_container
}//end get_buttons



// @license-end
