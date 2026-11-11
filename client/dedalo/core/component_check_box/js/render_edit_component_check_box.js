// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_label, page_globals, SHOW_DEBUG, DEDALO_CORE_URL*/
/*eslint no-undef: "error"*/



// import
	import {ui} from '../../common/js/ui.js'
	import {render_value} from '../../common/js/utils/render_escape.js'
	import {object_to_url_vars, open_window, same_section_id} from '../../common/js/utils/index.js'
	import {view_default_edit_check_box} from './view_default_edit_check_box.js'
	import {view_tools_edit_check_box} from './view_tools_edit_check_box.js'
	import {view_line_edit_check_box} from './view_line_edit_check_box.js'



/**
* RENDER_EDIT_COMPONENT_CHECK_BOX
* Edit-mode render mixin for component_check_box.
*
* This module is NOT a standalone class.  It is a prototype-assignment vehicle:
* component_check_box.prototype.edit is wired to
* render_edit_component_check_box.prototype.edit (see component_check_box.js).
* The constructor itself is a no-op placeholder so that prototype methods can be
* attached to it using the standard Dédalo pattern.
*
* Exports (named):
*   render_edit_component_check_box — constructor / prototype carrier
*   get_content_data_edit           — builds the main content_data DOM node with all
*                                     checkbox inputs (or read-only labels for permission=1)
*   get_buttons                     — builds the buttons_container (list / reset / tools)
*
* Data shape expected on self.data:
*   datalist {Array<{value:{section_id,section_tipo}, label:string, section_id:string}>}
*     The full option list resolved by get_datalist() on the server.
*   entries  {Array<{type:string, section_id:string, section_tipo:string, from_component_tipo:string}>}
*     The subset of relation locators that are currently checked; a subset of datalist.
*
* Data shape expected on self.context:
*   view             {string}  — render view name: 'default'|'line'|'print'|'tools'
*   properties       {Object}  — ontology properties block (show_interface, mandatory, …)
*   target_sections  {Array<{tipo:string, label:string}>} — one item per target section
*                                for the button_list navigation buttons
*
* self.show_interface keys consumed here:
*   button_list   {boolean} — when true, renders a "go to list" navigation button per target_section
*   button_delete {boolean} — when true, renders a bulk-reset button
*   tools         {boolean} — when true, renders the tool buttons via ui.add_tools()
*
* Global references (page-provided, declared in the /*global*\/ directive):
*   get_label       — localised label map ({reset:'Reset', …})
*   SHOW_DEBUG      — boolean flag; when true, developer debug badges are shown
*   DEDALO_CORE_URL — base URL for building deep-link navigation URLs
*/
export const render_edit_component_check_box = function() {

	return true
}//end render_edit_component_check_box



/**
* EDIT
* Dispatch to the appropriate view renderer based on self.context.view.
*
* View routing:
*   'tools'   — two-column grid with a Select-all master checkbox and tool icons;
*               used for the security-tools profiles field (dd1067).
*   'line'    — same content as 'default' but wrapped for compact inline display
*               (label:null, display:contents).
*   'print'   — forces self.permissions to 1 (read-only) then falls through to
*               'default'.  This is an intentional fall-through (no return/break).
*               The mutation of self.permissions is side-effectful on the instance
*               for the lifetime of the render call; the view_print CSS class is
*               applied by ui.component.build_wrapper_edit() from the context.view.
*   'default' — full wrapper: label row, buttons_container, content_data with one
*               checkbox per datalist option.  Read users (permissions=1) see only the
*               selected labels as read-only nodes.
*
* (!) The 'print' case intentionally falls through to 'default' via a missing break/
*     return.  Do not add one.  The permissions mutation is the entire purpose of the
*     'print' branch; it must execute before build_wrapper_edit() is called.
*
* @param {Object} options - Render options forwarded verbatim to the selected view renderer
* @returns {Promise<HTMLElement>} Resolved component wrapper node (or content_data when
*                                 options.render_level==='content')
*/
render_edit_component_check_box.prototype.edit = async function(options) {

	const self = this

	// view
		const view	= self.context.view || 'default'

	switch(view) {

		case 'tools':
			return view_tools_edit_check_box.render(self, options)

		case 'line':
			return view_line_edit_check_box.render(self, options)

		case 'print':
			// view print use the same view as default, except it will use read only to render content_value
			// as different view as default it will set in the class of the wrapper
			// sample: <div class="wrapper_component component_input_text oh14 oh1_oh14 edit view_print disabled_component">...</div>
			// take account that to change the css when the component will render in print context
			// for print we need to use read of the content_value and it's necessary force permissions to use read only element render
			self.permissions = 1;

		case 'default':
		default:
			return view_default_edit_check_box.render(self, options)
	}
}//end edit



/**
* GET_CONTENT_DATA_EDIT
* Build the content_data DOM node that holds all checkbox inputs (or read-only labels).
*
* Branching on self.permissions:
*
*   permissions === 1 (read-only):
*     Iterates self.data.entries (the currently selected locators), finds the
*     matching datalist item for each, and renders a read-only content_value node
*     containing only the label text.  If no entries match any datalist item
*     (e.g. empty selection), one empty content_value node is appended at index 0
*     so the wrapper is never completely empty.  This prevents the UI from
*     collapsing in list/print contexts.
*
*   permissions >= 2 (read-write):
*     Iterates the full self.data.datalist and renders one interactive checkbox
*     per option (via get_content_value).  Each checkbox is pre-checked when its
*     datalist_value locator matches an entry in self.data.entries.
*
* Numeric index pointers are set on the content_data node itself
* (content_data[i] = content_value_node) so that callers can access individual
* slots by index for targeted refresh.
*
* @param {Object} self - Component instance (component_check_box)
* @returns {HTMLElement} content_data node with all child content_value nodes appended
*/
export const get_content_data_edit = function(self) {

	// short vars
		const data				= self.data || {}
		const datalist			= data.datalist || []
		const datalist_length	= datalist.length
		const entries			= data.entries || []
		const permissions		= self.permissions

	// content_data
		const content_data = ui.component.build_content_data(self)

	// permissions switch
		if (permissions===1) {

			// filtered_datalist. Datalist values that exists into component value
				for (let i = 0; i < entries.length; i++) {
					const data_value = entries[i]
					const current_datalist_item	= datalist.find(el =>
						el.value &&
						String(el.value.section_id)===String(data_value.section_id) &&
						el.value.section_tipo===data_value.section_tipo
					)
					if(current_datalist_item){
						const current_value = current_datalist_item.label || ''
						// build options
						const content_value_node = get_content_value_read(0, current_value, self)
						content_data.appendChild(content_value_node)
						// set pointers
						content_data[i] = content_value_node
					}
				}

			// fill empty value cases with one empty content_value node
				if(!content_data[0]) {
					const current_value = '';
					const content_value_node = get_content_value_read(0, current_value, self)
					content_data.appendChild(content_value_node)
					// set pointers
					content_data[0] = content_value_node
				}

		}else{

			// build options
				for (let i = 0; i < datalist_length; i++) {
					const input_element_node = get_content_value(i, datalist[i], self)
					content_data.appendChild(input_element_node)
					// set pointers
					content_data[i] = input_element_node
				}
		}


	return content_data
}//end get_content_data_edit



/**
* GET_CONTENT_VALUE
* Build a single interactive checkbox option node for one datalist item.
*
* DOM output shape (appended to the parent content_data by the caller):
*   <div class="content_value">
*     <label>
*       <input type="checkbox" [checked]>
*       {label text}
*     </label>
*     [<span class="developer_info show_on_active">[section_id]</span>]  (SHOW_DEBUG only)
*   </div>
*
* The checkbox is pre-checked when any entry in self.data.entries has the same
* (section_id, section_tipo) pair as datalist_value.  Both comparisons use strict
* equality (===).  Note: the read-only branch in get_content_data_edit uses loose
* equality (==) for section_id because that value may arrive as a string from the
* server and as a number from the client.
*
* Events attached to input_checkbox:
*   focus  — activates the component via ui.component.activate(self) if not already
*             active; supports keyboard tab-navigation between checkboxes.
*   change — delegates to self.change_handler() with (self, e, i, datalist_value,
*             input_checkbox) so the shared handler in component_check_box.js can build
*             a changed_data atom (insert/remove) and call self.change_value().
*   click  — stopPropagation only; prevents the click from bubbling to the wrapper's
*             activation listener and causing a double-activate.
*
* @param {number} i             - Zero-based index of this item in the datalist array;
*                                 passed through to change_handler as the slot key
* @param {Object} current_value - One datalist item: {value:{section_id,section_tipo},
*                                 label:string, section_id:string}
* @param {Object} self          - Component instance (component_check_box)
* @returns {HTMLElement} content_value <div> with the checkbox label inside
*/
const get_content_value = (i, current_value, self) => {

	// short vars
		const entries			= self.data.entries || []
		const value_length		= entries.length
		const datalist_item		= current_value
		const datalist_value	= datalist_item.value
		const label				= datalist_item.label
		const section_id		= datalist_item.section_id

	// create content_value
		const content_value = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'content_value'
		})

	// label
		const option_label = ui.create_dom_element({
			element_type	: 'label',
			inner_html		: render_value(label, self.context.render_class),
			parent			: content_value
		})

	// input_checkbox
		const input_checkbox = ui.create_dom_element({
			element_type	: 'input',
			type			: 'checkbox'
		})

		option_label.prepend(input_checkbox)
		input_checkbox.addEventListener('focus', function() {
			// force activate on input focus (tabulating case)
			if (!self.active) {
				ui.component.activate(self)
			}
		})
		input_checkbox.addEventListener('change', function(e){

			self.change_handler({
				self			: self,
				e				: e,
				i				: i,
				datalist_value	: datalist_value,
				input_checkbox	: input_checkbox
			})
		})//end change event
		input_checkbox.addEventListener('click', function(e) {
			e.stopPropagation()
		})

		// checked option set on match
			for (let j = 0; j < value_length; j++) {
				if (entries[j] && datalist_value &&
					same_section_id(entries[j].section_id, datalist_value.section_id) &&
					entries[j].section_tipo===datalist_value.section_tipo
					) {
						input_checkbox.checked = 'checked'
				}
			}

	// developer_info
		if(SHOW_DEBUG){
			ui.create_dom_element({
				element_type	: 'span',
				class_name		: 'developer_info show_on_active',
				text_content	: `[${section_id}]`,
				parent			: content_value
			})
		}


	return content_value
}//end get_content_value



/**
* GET_CONTENT_VALUE_READ
* Build a single read-only content_value node that displays a label string.
*
* Used when permissions === 1 or the component is rendered in 'print' view.
* Only the matched, currently-selected entries are rendered (not the full datalist),
* so the returned node simply shows the resolved label text without any interactive
* elements.  The node receives both 'content_value' and 'read_only' CSS classes so
* that the print/read stylesheet can apply the correct appearance.
*
* @param {number} i             - Zero-based slot index (currently unused inside this
*                                 function; reserved for potential caller use / pointer set)
* @param {string} current_value - Resolved label string for the matched datalist item,
*                                 or an empty string when the selection is empty
* @param {Object} self          - Component instance (component_check_box); not used
*                                 inside this function but kept for API symmetry with
*                                 get_content_value
* @returns {HTMLElement} <div class="content_value read_only"> with inner_html set to
*                        the label text, rendered through the ONE escaper by the
*                        component's wire render_class (a datalist label is
*                        record data — the target section's own values)
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
* Build the buttons_container DOM node for the edit toolbar.
*
* Three optional button groups are assembled into a DocumentFragment, then
* placed inside a buttons_fold wrapper that allows sticky positioning on
* taller components.  Each group is guarded by its self.show_interface flag,
* so ontology config drives what is visible without code changes:
*
*   button_list  {boolean} — one navigation button per target_section in
*     self.context.target_sections.  Each button opens the target list section in
*     a new browser window via open_window(), and refreshes the current instance
*     on window blur (so newly created options appear immediately).  In SHOW_DEBUG
*     mode the button title includes the section tipo.
*
*   button_delete {boolean} — a bulk-reset "trash" button.  Guards against
*     an already-empty entries array (early return true) to avoid a no-op save
*     round-trip.  Issues a single changed_data atom of action:'clear' — the
*     EXPLICIT wipe (DATA-06, 2026-08-30): every entry of this component, in every
*     language, both locally and on the server.  It is NOT a 'remove' with a null
*     id: that shape is refused now, at both doors.  change_value confirms 'clear'
*     with the same remove dialog; then a full refresh runs.
*
*   tools {boolean} — appends the ontology-configured tool buttons from self.tools[]
*     via ui.add_tools(self, fragment).  Tools are assembled server-side from the
*     model + ontology; no tool types are hardcoded here.
*
* @param {Object} self - Component instance (component_check_box); must have
*                        self.show_interface, self.context.target_sections,
*                        self.data.entries, self.tools, and self.permissions set
* @returns {HTMLElement} buttons_container node with the buttons_fold child already
*                        populated
*/
export const get_buttons = (self) => {

	// short vars
		const show_interface = self.show_interface

	// fragment
		const fragment = new DocumentFragment()

	// button_list (go to target section)
		if(show_interface.button_list === true){

			const target_sections			= self.context.target_sections
			const target_sections_length	= target_sections.length
			for (let i = 0; i < target_sections_length; i++) {

				const item = target_sections[i]

				// button edit
					const label = (SHOW_DEBUG===true)
						? `${item.label} [${item.tipo}]`
						: item.label
					const button_list = ui.create_dom_element({
						element_type	: 'span',
						class_name		: 'button pen',
						title			: label,
						parent			: fragment
					})
					button_list.addEventListener('mousedown', function(e){
						e.stopPropagation()

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
					})//end click event
			}//end for (let i = 0; i < target_sections_length; i++)
		}

	// button reset (delete) remove all values
		if(show_interface.button_delete === true){

			const button_reset = ui.create_dom_element({
				element_type	: 'span',
				class_name		: 'button reset',
				title			: get_label.reset || 'Reset',
				parent			: fragment
			})
			button_reset.addEventListener('click', function(e) {
				e.stopPropagation()

				if (!self.data.entries || self.data.entries.length===0) {
					return true
				}

				// DELIBERATE WIPE (DATA-06, 2026-08-30): uncheck EVERY box, in every
				// language. That is `action:'clear'` — the ONE explicit wildcard, in
				// component_common.update_data_value and in the server's
				// save_component.ts. Do NOT spell it as a `remove` with a null id
				// again: an id-less remove is now REFUSED, both by the client (a
				// visible alert, nothing saved) and by the server
				// (record.remove_without_id), because that same shape is what an
				// UNRESOLVED single-row delete produces (component_check_box.js
				// uncheck-one builds `locator?.id || null`) and it used to empty the
				// whole component while reporting success.
				// change_value still shows the remove-confirmation dialog for 'clear',
				// so the user confirms before anything is wiped.
				const changed_data = [Object.freeze({
					action	: 'clear',
					value	: null
				})]
				self.change_value({
					changed_data	: changed_data,
					label			: 'All',
					refresh			: true
				})
			})
		}

	// buttons tools
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
