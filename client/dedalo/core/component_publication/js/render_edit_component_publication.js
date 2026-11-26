// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_label, page_globals, SHOW_DEBUG, DEDALO_CORE_URL*/
/*eslint no-undef: "error"*/



/**
* RENDER_EDIT_COMPONENT_PUBLICATION
* Edit-mode renderer for component_publication — the per-record publication
* switch that gates whether a record is visible to external diffusion targets.
*
* This module is imported by component_publication.js and wired to the
* instance via:
*   component_publication.prototype.edit = render_edit_component_publication.prototype.edit
*
* It exports two helper functions consumed by the view modules:
*   - get_content_data  — builds the row of switch widgets (used by both
*                         view_default_edit_publication and view_line_edit_publication)
*   - get_buttons       — builds the toolbar button container
*
* Data shape expected on `self.data`:
*   {
*     entries  : Array<{id:number, type:string, section_id:string,
*                        section_tipo:string, from_component_tipo:string}>,
*     datalist : Array<{section_id:string, value:Object, label:string}>
*   }
* `section_id "1"` is *yes* (NUMERICAL_MATRIX_VALUE_YES), `"2"` is *no*.
* An empty entries array means the switch has not been set.
*
* View dispatch:
*   'line'    → view_line_edit_publication  (compact inline switch, no label)
*   'print'   → falls through to 'default' after forcing permissions = 1
*   'default' → view_default_edit_publication (full switch + optional toolbar)
*/

// imports
	import {ui} from '../../common/js/ui.js'
	import {render_value} from '../../common/js/utils/render_escape.js'
	import {view_default_edit_publication} from './view_default_edit_publication.js'
	import {view_line_edit_publication} from './view_line_edit_publication.js'



/**
* RENDER_EDIT_COMPONENT_PUBLICATION
* Constructor (namespace only). All edit-mode logic lives on the prototype.
* The instance is never constructed directly; component_publication delegates
* its `.edit` prototype slot here via prototype assignment.
*/
export const render_edit_component_publication = function() {

	return true
}//end render_edit_component_publication



/**
* EDIT
* Entry-point prototype method for edit mode. Resolves the requested view
* from `self.context.view` and delegates to the matching view module.
*
* The `print` case intentionally falls through to `default` so that the
* same view_default_edit_publication renderer is reused; the only difference
* is that permissions are forced to 1 (read-only) so that
* get_content_value_read is used instead of the interactive switch.
* The CSS class `view_print` is set on the wrapper by the view module to
* allow print-specific styling.
*
* @param {Object} options - render options forwarded to the view module
*   @param {string} [options.render_level='full'] - 'full' returns the full
*     component wrapper; 'content' returns only the content_data node
* @returns {Promise<HTMLElement>} the rendered wrapper (or content_data node
*   when render_level is 'content')
*/
render_edit_component_publication.prototype.edit = async function(options) {

	const self = this

	// view
		const view = self.context.view || 'default'

	switch(view) {

		case 'line':
			return view_line_edit_publication.render(self, options)

		case 'print':
			// view print use the same view as default, except it will use read only to render content_value
			// as different view as default it will set in the class of the wrapper
			// sample: <div class="wrapper_component component_publication oh32 oh1_oh32 edit view_print disabled_component">...</div>
			// take account that to change the css when the component will render in print context
			// for print we need to use read of the content_value and it's necessary force permissions to use read only element render
			self.permissions = 1

		case 'default':
		default:
			return view_default_edit_publication.render(self, options)
	}
}//end edit



/**
* GET_CONTENT_DATA
* Builds the main content container for the edit view, populating it with
* one content_value widget per `data.entries` entry (or a single empty
* widget when the entries array is empty — representing the unset state).
*
* The rendering path for each entry depends on the instance permission level:
*   permissions === 1 (read-only) → get_content_value_read (label text)
*   permissions >= 2              → get_content_value      (interactive switch)
*
* Each built content_value node is also stored as a numeric index property
* on content_data (content_data[i] = content_value) so that view modules
* and external callers can address individual value slots by index.
*
* The 'nowrap' class is added to prevent line-wrapping of the switch row
* when multiple entries are present.
*
* @param {Object} self - component_publication instance
* @returns {HTMLElement} content_data container node
*/
export const get_content_data = function(self) {

	// short vars
		const entries = self.data.entries || []

	// content_data
		const content_data = ui.component.build_content_data(self, {
			button_close : null // set to null to prevent it from being created
		})
		content_data.classList.add('nowrap')

	// build values
		// When no entries exist, render a single empty widget so the switch
		// appears in the UI and the user can toggle it to set a value.
		const inputs_value	= (entries.length<1) ? [''] : entries
		const value_length	= inputs_value.length
		// a tool showing the component read-only (time machine panes, tool_lang…)
		// keeps the edit switch, locked, so the state reads at a glance
		const locked_switch	= self.permissions===1 && self.show_interface?.read_only===true
		for (let i = 0; i < value_length; i++) {
			// get the content_value
			const content_value = (self.permissions===1 && !locked_switch)
				? get_content_value_read(i, inputs_value[i], self)
				: get_content_value(i, inputs_value[i], self, locked_switch)
			// add node to content_data
			content_data.appendChild(content_value)
			// set the pointer
			content_data[i] = content_value
		}


	return content_data
}//end get_content_data



/**
* GET_CONTENT_VALUE
* Builds the interactive on/off switch widget for a single data entry.
* The switch is a CSS-styled `<label class="switcher_publication">` wrapping
* an `<input type="checkbox">` and a decorative `<i>` element.
*
* The checkbox value is the JSON-serialised locator of the current_value so
* the DOM carries the full state even without re-querying the instance.
*
* On `change`, the handler selects the correct locator from `self.data.datalist`:
*   - checked=true  → datalist item with section_id==1 (yes / published)
*   - checked=false → datalist item with section_id==2 (no  / not published)
* It then calls `self.change_handler()` which saves on every toggle and
* publishes `change_publication_value_<id_base>` for dependent UI elements.
*
* Initial checked state: the checkbox is pre-checked when `current_value.section_id == 1`.
* (!) Loose equality (==) is intentional — section_id may be a string "1" or a number 1.
*
* @param {number} i - zero-based index of this entry in `self.data.entries`
* @param {Object} current_value - locator for the current stored state, shape:
*   {type:string, section_id:string, section_tipo:string, from_component_tipo:string}
*   or '' (empty string) when entries is empty and no value has been set yet
* @param {Object} self - component_publication instance
* @param {boolean} [disabled=false] - locked switch (read-only tool view)
* @returns {HTMLElement} content_value container node
*/
const get_content_value = (i, current_value, self, disabled=false) => {

	// content_value
		const content_value = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'content_value'
		})

	// div_switcher
		const div_switcher = ui.create_dom_element({
			element_type	: 'label',
			class_name		: 'switcher_publication text_unselectable',
			parent			: content_value
		})

	// input checkbox
		const input = ui.create_dom_element({
			element_type	: 'input',
			type			: 'checkbox',
			value			: JSON.stringify(current_value),
			parent			: div_switcher
		})
		input.disabled = disabled
		input.addEventListener('change', function() {

			const checked		= input.checked
			const datalist		= self.data?.datalist || []
			// Resolve the target locator from the datalist based on the new toggle state.
			// section_id "1" = yes (published), "2" = no (not published).
			const changed_value	= (checked===true)
				? datalist.filter(item => item.section_id==1)[0]?.value
				: datalist.filter(item => item.section_id==2)[0]?.value

			// change handler (unified)
			self.change_handler({
				value	: changed_value,
				action	: 'update',
				index	: i
			})
		})
		// set checked from current value
		if (current_value.section_id==1) {
			input.setAttribute('checked', true)
		}

	// switch_label
		// The <i> element provides the visual slider graphic via CSS (no text content).
		ui.create_dom_element({
			element_type	: 'i',
			parent			: div_switcher
		})


	return content_value
}//end get_content_value



/**
* GET_CONTENT_VALUE_READ
* Builds a read-only display node for a single data entry, showing the
* resolved yes/no label instead of an interactive switch.
*
* Used when `self.permissions === 1` (read-only), which is the case for
* users without write access and for `view === 'print'` (where the caller
* forces permissions to 1 before delegating to get_content_data).
*
* Label resolution: the datalist is searched for the item whose `section_id`
* matches `current_value.section_id`. If no match is found, or if the
* matched item has no label, the node is rendered with an empty string.
* (!) Loose equality is intentional — section_id may be a string or number.
*
* @param {number} i - zero-based index of this entry (unused in the DOM build
*   but kept for API parity with get_content_value)
* @param {Object} current_value - current locator, shape:
*   {type:string, section_id:string, section_tipo:string, from_component_tipo:string}
* @param {Object} self - component_publication instance
* @returns {HTMLElement} content_value container node with 'read_only' CSS class
*/
const get_content_value_read = (i, current_value, self) => {

	// get current datalist item that match with current_value to get the label to show it
		const data			= self.data || {}
		const datalist		= data.datalist || []
		const datalist_item	= datalist.find(item => item.section_id==current_value.section_id)

	// content_value
		const content_value = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'content_value read_only',
			inner_html 		: render_value(datalist_item?.label, self.context.render_class)
		})

	return content_value
}//end get_content_value_read



/**
* GET_BUTTONS
* Builds the toolbar buttons container for the edit view.
* Tool buttons (time machine, propagate, etc.) are appended when
* `self.show_interface.tools === true`.
*
* The `buttons_container` node is returned for the view module to attach
* to the component wrapper. When no tools are active, the container is
* empty but still returned (the view module decides whether to include it).
*
* @param {Object} self - component_publication instance
* @returns {HTMLElement} buttons_container node, possibly containing tool buttons
*/
export const get_buttons = (self) => {

	// short vars
		const show_interface = self.show_interface

	// fragment
		const fragment = new DocumentFragment()

	// buttons tools
		if(show_interface.tools === true){
			ui.add_tools(self, fragment)
		}

	// buttons container
		const buttons_container = ui.component.build_buttons_container(self)
		buttons_container.appendChild(fragment)


	return buttons_container
}//end get_buttons



// @license-end
