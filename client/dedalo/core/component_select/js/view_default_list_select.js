// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_label, page_globals, SHOW_DEBUG, DEDALO_CORE_URL*/
/*eslint no-undef: "error"*/



// imports
	import {ui} from '../../common/js/ui.js'
	import {render_join} from '../../common/js/utils/render_escape.js'
	import {bind_edit_in_list} from '../../component_common/js/component_common.js'



/**
* VIEW_DEFAULT_LIST_SELECT
* Read-only list-mode view for component_select.
*
* Renders the component's current selected value as a plain text label inside
* the standard list wrapper. Tapping/clicking the wrapper always opens the
* component in a modal editor (mode: 'modal'), which is the expected UX for a
* single-value dropdown whose inline width is usually too narrow for an inline
* edit widget.
*
* This constructor is a stub — all behaviour lives on the static render method.
* The pattern mirrors every other view_*_list_select sibling module.
*/
export const view_default_list_select = function() {

	return true
}//end view_default_list_select



/**
* RENDER
* Build the DOM node for component_select in list (read-only row) mode.
*
* Reads the component's resolved entries array, flattens their labels into a
* single space-separated string, and passes it to build_wrapper_list so the
* standard CSS class set is applied. A click listener wired to
* activate_edit_in_list opens the full edit UI in a modal overlay.
*
* Data shape expected in self.data:
*   { entries: [string, …] }
* Entries may be empty; the fallback is an empty array, producing an empty
* wrapper (no text node), which is the normal "no value yet" display.
*
* @param {Object} self    - Component instance (component_select). Must have
*                           self.data, self.permissions, self.show_interface,
*                           and self.minimum_width_px populated by build().
* @param {Object} options - Reserved for future render-level flags (currently unused).
* @returns {Promise<HTMLElement>} wrapper - The constructed list wrapper div,
*                                           ready to be inserted into the DOM.
*/
view_default_list_select.render = async function(self, options) {

	// short vars
		const data			= self.data || {}
		const entries		= data.entries || []
		// entries are already label strings at list-mode resolution; join with a
		// space to separate multiple values when component_select allows them.
		const value_string	= render_join(entries, ' ', self.context.render_class)

	// wrapper
		// build_wrapper_list applies the standard CSS class set and, when
		// value_string is truthy, appends a child <span> with the text.
		const wrapper = ui.component.build_wrapper_list(self, {
			value_string : value_string
		})

	// click handler for edit mode activation (modal)
		// (!) mode is forced to 'modal' — component_select in list rows is
		// typically too narrow for an inline editor; always use the overlay.
		bind_edit_in_list(self, wrapper, { mode: 'modal' })


	return wrapper
}//end render



// @license-end
