// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global, SHOW_DEBUG, DEDALO_CORE_URL */
/*eslint no-undef: "error"*/



// imports
	import {ui} from '../../common/js/ui.js'
	import {render_value} from '../../common/js/utils/render_escape.js'
	import {object_to_url_vars, open_window, same_section_id} from '../../common/js/utils/index.js'
	import {view_default_edit_radio_button} from './view_default_edit_radio_button.js'
	import {view_line_edit_radio_button} from './view_line_edit_radio_button.js'
	import {view_rating_edit_radio_button} from './view_rating_edit_radio_button.js'
	import {handle_radio_change, build_changed_data_item} from './component_radio_button.js'



/**
* RENDER_EDIT_COMPONENT_RADIO_BUTTON
* Edit-mode render mixin for component_radio_button.
*
* This module is NOT a standalone class. It is a prototype-assignment vehicle:
* component_radio_button.prototype.edit is wired to
* render_edit_component_radio_button.prototype.edit (see component_radio_button.js).
* The constructor itself is a no-op placeholder so that prototype methods can be
* attached to it using the standard Dédalo pattern.
*
* Exports (named):
*   render_edit_component_radio_button — constructor / prototype carrier
*   get_content_data_edit              — builds the main content_data DOM node containing
*                                        all radio inputs (or read-only labels for permissions=1)
*   get_buttons                        — builds the buttons_container (list / reset / tools)
*
* Data shape expected on self.data:
*   datalist {Array<{value:{section_id:string, section_tipo:string}, label:string, section_id:string}>}
*     The full option list resolved by get_datalist() on the server. Each item represents
*     one selectable radio option.
*   entries  {Array<{id:number|null, section_id:string, section_tipo:string, type:string, from_component_tipo:string}>}
*     The currently selected relation locators (at most one entry for a radio button).
*     Radio buttons are single-selection: only one entry is expected in this array.
*
* Data shape expected on self.context:
*   view             {string} — render view name: 'default' | 'line' | 'rating' | 'print'
*   properties       {Object} — ontology properties block (show_interface, mandatory, …)
*   target_sections  {Array<{tipo:string, label:string}>} — one entry per navigable target
*                              section, used for button_list navigation buttons
*
* self.show_interface keys consumed here:
*   button_list   {boolean} — when true, renders a "go to list" navigation button per target_section
*   button_delete {boolean} — when true, renders a reset button that clears the current selection
*   tools         {boolean} — when true, appends ontology-configured tool buttons via ui.add_tools()
*
* Global references (page-provided, declared in the global directive):
*   SHOW_DEBUG      — boolean; when true, developer debug badges are shown in button labels
*   DEDALO_CORE_URL — base URL used when constructing deep-link navigation URLs
*
* (!) get_label (used in get_buttons for the reset button title) is referenced at line ~297
*     but is NOT declared in the /*global*\/ directive at the top of this file. This may
*     trigger an eslint no-undef warning. The missing declaration is a pre-existing issue
*     and should be added to the /*global*\/ line: get_label, SHOW_DEBUG, DEDALO_CORE_URL.
*/
export const render_edit_component_radio_button = function() {

	return true
}//end render_edit_component_radio_button



/**
* EDIT
* Dispatch to the appropriate view renderer based on self.context.view.
*
* View routing:
*   'line'    — compact inline view (no buttons_container, exit-edit button appended to
*               content_data); used when the component is rendered in a list row.
*   'rating'  — visual star/score rating variant where datalist items are sorted by
*               section_id and each item is rendered as a ratable cell.
*   'print'   — forces self.permissions to 1 (read-only), then falls through to 'default'.
*               This is an intentional fall-through (no return/break). The mutation of
*               self.permissions is side-effectful on the instance for the duration of the
*               render; the CSS class 'view_print' is applied by build_wrapper_edit() from
*               the context.view value. See inline comment preserved from original code.
*   'default' — full wrapper: label row, buttons_container, content_data with one radio
*               input per datalist option. Read users (permissions=1) see only the matched
*               entry label as a read-only node.
*
* (!) The 'print' case intentionally falls through to 'default' via a missing break/return.
*     Do not add one. The permissions mutation must execute before view_default renders.
*
* @param {Object} options - Render options forwarded verbatim to the selected view renderer
* @returns {Promise<HTMLElement>} Resolved component wrapper node (or content_data when
*                                 options.render_level === 'content')
*/
render_edit_component_radio_button.prototype.edit = async function(options) {

	const self = this

	// view
		const view = self.context.view || 'default'

	switch(view) {

		case 'line':
			return view_line_edit_radio_button.render(self, options)

		case 'rating':
			return view_rating_edit_radio_button.render(self, options)

		case 'print':
			// view print use the same view as default, except it will use read only to render content_value
			// as different view as default it will set in the class of the wrapper
			// sample: <div class="wrapper_component component_input_text oh14 oh1_oh14 edit view_print disabled_component">...</div>
			// take account that to change the css when the component will render in print context
			// for print we need to use read of the content_value and it's necessary force permissions to use read only element render
			self.permissions = 1

		case 'default':
		default:
			return view_default_edit_radio_button.render(self, options)
	}
}//end edit



/**
* GET_CONTENT_DATA_EDIT
* Build the content_data DOM node that holds all radio button inputs or read-only labels.
*
* Branching on self.permissions:
*
*   permissions === 1 (read-only):
*     Iterates self.data.entries (the currently selected locators) and, for each entry,
*     finds the matching datalist item by comparing (section_id, section_tipo). When a
*     match is found, a read-only content_value node is appended displaying only the label
*     text. If no entry matches (e.g. empty selection) nothing is appended, so the
*     content_data may remain empty — contrast with component_check_box which always
*     ensures at least one empty node. The section_id comparison uses loose equality (==)
*     because values may be string from the server vs number from the client.
*
*   permissions >= 2 (read-write):
*     Iterates the full self.data.datalist and renders one interactive radio input node
*     per option (via get_content_value). Each radio is pre-checked when its datalist_value
*     locator matches an entry in self.data.entries. Because radio buttons are single-select,
*     only one can ever be checked at a time.
*
* Numeric index pointers are also set on the content_data node itself
* (content_data[i] = content_value_node) so that callers can target individual slots by
* index for fine-grained refresh.
*
* @param {Object} self - Component instance (component_radio_button); must have
*                        self.data.datalist, self.data.entries, and self.permissions set
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

		// Read only case

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
				// set the pointer
				content_data[i] = content_value_node
			}
		}

	}else{

		// Read and write case

		// Rende the values
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
* Build a single interactive radio button option node for one datalist item.
*
* DOM output shape:
*   <div class="content_value">
*     <label class="label [checked]">
*       <input type="radio" name="{self.id}" [disabled]>
*       {label text}
*     </label>
*   </div>
*
* The radio input is pre-checked when any entry in self.data.entries has the same
* (section_id, section_tipo) pair as datalist_value. Strict equality is used for
* both fields (===), unlike the read-only path in get_content_data_edit which uses
* loose equality (==) for section_id.
*
* All inputs in a component share the same `name` attribute (self.id) so the browser
* enforces single-selection across the group automatically.
*
* Events attached to input:
*   focus  — activates the component via ui.component.activate(self) when not already
*             active; supports keyboard tab-navigation to the radio group.
*   change — delegates to handle_radio_change(self, datalist_value), which reads the
*             current entry id from self.data (not from the closure) to avoid stale-id
*             issues after the first save, then calls self.change_value(). After the
*             async change completes, update_status(this) re-applies the CSS 'checked'
*             class to the label so the visual state stays in sync with the data.
*
* The nested update_status function iterates all current entries and applies the
* 'checked' CSS class to input_label when the entry matches datalist_value, or removes
* it otherwise. It is also called immediately after construction to reflect the initial
* persisted selection.
*
* @param {number} i             - Zero-based index of this item in the datalist array
* @param {Object} datalist_item - One datalist entry: {value:{section_id, section_tipo},
*                                 label:string, section_id:string}
* @param {Object} self          - Component instance (component_radio_button)
* @returns {HTMLElement} content_value <div> with the radio label inside
*/
const get_content_value = (i, datalist_item, self) => {

	// short vars
		const entries			= self.data.entries || []
		const value_length		= entries.length
		const datalist_value	= datalist_item.value
		const label				= datalist_item.label

	// content_value
		const content_value = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'content_value'
		})

	// label
		const input_label = ui.create_dom_element({
			element_type	: 'label',
			class_name		: 'label',
			inner_html		: render_value(label, self.context.render_class),
			parent			: content_value
		})

	// input radio button
		const input = ui.create_dom_element({
			element_type	: 'input',
			type			: 'radio',
			name			: self.id
		})
		input_label.prepend(input)
		// change handler
		const change_handler = async function() {

			// update the checked status of ALL option labels in the group. The
			// browser fires 'change' only on the newly-checked input, so the
			// previously-checked label must be cleared here too — sync every
			// label class from its own input's native checked state.
			const content_data = this.closest('.content_data')
			const sync_labels = () => {
				const group_labels = content_data?.querySelectorAll(':scope > .content_value > .label') || []
				group_labels.forEach(el => {
					const group_input = el.querySelector('input')
					el.classList.toggle('checked', !!(group_input && group_input.checked))
				})
			}
			// sync BEFORE the save: waiting for the round-trip left the old label
			// '.checked' — two lit chips until the save resolved (flicker)
			sync_labels()

			// common change handler (clone value + add id, set_changed_data, change_value)
			// read id dynamically from self.data (not from stale closure)
			await handle_radio_change(self, datalist_value)

			// re-sync after the save (a queued change may have moved the selection)
			sync_labels()
		}
		input.addEventListener('change', change_handler)
		// focus event
		const focus_handler = () => {
			// force activate on input focus (tabulating case)
			if (!self.active) {
				ui.component.activate(self)
			}
		}
		input.addEventListener('focus', focus_handler)
		// permissions. Set disabled on low permissions
		if (self.permissions<2) {
			input.disabled = 'disabled'
		}

	// update status checked input set on match
		const update_status = (input) => {
			for (let j = 0; j < value_length; j++) {
				if (entries[j] && datalist_value &&
					same_section_id(entries[j].section_id, datalist_value.section_id) &&
					entries[j].section_tipo===datalist_value.section_tipo
					) {
						input.checked = 'checked'
						input_label.classList.add('checked')
				}
				else{
					input_label.classList.remove('checked')
				}
			}
		}
		// initial status checked input set on match
		update_status(input)


	return content_value
}//end get_content_value



/**
* GET_CONTENT_VALUE_READ
* Build a single read-only content_value node that displays a label string.
*
* Used when permissions === 1 or the component is rendered in 'print' view.
* Only matched, currently-selected entries are rendered (not the full datalist),
* so the returned node simply shows the resolved label text without any interactive
* elements. The node receives both 'content_value' and 'read_only' CSS classes so
* that the print/read stylesheet can apply the appropriate appearance.
*
* @param {number} i             - Zero-based slot index (currently unused inside this
*                                 function; reserved for potential caller use and pointer
*                                 assignment consistency with get_content_value)
* @param {string} current_value - Resolved label string for the matched datalist item
* @param {Object} self          - Component instance (component_radio_button); not used
*                                 inside this function but kept for API symmetry with
*                                 get_content_value
* @returns {HTMLElement} <div class="content_value read_only"> with inner_html set to
*                        the label text
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
* Three optional button groups are assembled into a DocumentFragment, then placed
* inside a buttons_fold wrapper that allows sticky positioning on taller components.
* Each group is guarded by its self.show_interface flag, so ontology configuration
* drives what is visible without any code changes:
*
*   button_list  {boolean} — one navigation button per entry in self.context.target_sections.
*     Each button opens the target list section in a new browser window via open_window(),
*     and triggers a full refresh of the current component on window blur (so newly created
*     options appear immediately). In SHOW_DEBUG mode the button title includes the section
*     tipo in square brackets. Falls back to an empty array if target_sections is absent.
*
*   button_delete {boolean} — a reset button that clears the current radio selection.
*     Guards against an already-empty entries array (early return true) to avoid a
*     no-op save round-trip. Issues a single frozen changed_data atom with action:'remove',
*     id read dynamically from self.data.entries[0].id (not from a stale closure), and
*     value:null, then calls self.change_value() with refresh:true. The label shown in the
*     confirmation is the currently checked value via self.get_checked_value_label().
*
*   tools {boolean} — appends the ontology-configured tool buttons from self.tools[] via
*     ui.add_tools(self, fragment). Tool types are assembled server-side from the model and
*     ontology; none are hardcoded here.
*
* (!) The reset button uses `title_label` (not `title`) in ui.create_dom_element.
*     In ui.js, title_label is an alias for title: HTML tags are stripped before assignment.
*     The effective behaviour is identical to using `title`.
*
* (!) `get_label` is referenced at line ~297 (get_label.reset) but is not declared in
*     the /*global*\/ directive at the top of this file. This is a pre-existing issue.
*
* @param {Object} self - Component instance (component_radio_button); must have
*                        self.show_interface, self.context.target_sections,
*                        self.data.entries, self.tools, and self.permissions set
* @returns {HTMLElement} buttons_container node with the buttons_fold child populated
*/
export const get_buttons = (self) => {

	// short vars
		const show_interface = self.show_interface

	// document fragment
		const fragment = new DocumentFragment()

	// button_list (go to target section)
		if(show_interface.button_list === true){

			const target_sections			= self.context.target_sections || []
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
					})
			}//end for (let i = 0; i < target_sections_length; i++)
		}

	// button reset
		if(show_interface.button_delete === true){

			const reset_button = ui.create_dom_element({
				element_type	: 'span',
				class_name		: 'button reset',
				title_label		: get_label.reset || 'Reset',
				parent			: fragment
			})
			reset_button.addEventListener('click', function(e) {
				e.stopPropagation()

				// force possible input change before remove
				document.activeElement.blur()

				if (!self.data?.entries || self.data.entries.length===0) {
					return true
				}

				// read id dynamically from self.data (not from stale closure)
				const current_id = self.data.entries?.[0]?.id ?? null
				const changed_data = [Object.freeze({
					action	: 'remove',
					id		: current_id,
					value	: null
				})]
				self.change_value({
					changed_data	: changed_data,
					label			: self.get_checked_value_label(),//'All',
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
