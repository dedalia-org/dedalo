// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_label, page_globals, SHOW_DEBUG, DEDALO_CORE_URL*/
/*eslint no-undef: "error"*/



// imports
	import {ui} from '../../common/js/ui.js'
	import {render_value} from '../../common/js/utils/render_escape.js'
	import {bind_edit_in_list} from '../../component_common/js/component_common.js'



/**
* VIEW_DEFAULT_LIST_FILTER
* Default list-view renderer for component_filter instances.
*
* This module is the 'default' case of the view-dispatch table in
* render_list_component_filter. It is selected when self.context.view is
* 'default' or absent. The other cases ('mini', 'text', 'collapse') are
* handled by their own view_*_list_filter siblings.
*
* The filter component stores its resolved human-readable labels in
* data.entries (an array of strings). This view joins them with <br>
* and wraps them in a standard list wrapper; a click on the wrapper
* opens the edit UI as a modal dialog so the user can update the
* filter selections without leaving the list context.
*
* Exports:
*   view_default_list_filter  – namespace constructor (no-op)
*   view_default_list_filter.render  – async static render function
*/
export const view_default_list_filter = function() {

	return true
}//end view_default_list_filter



/**
* RENDER
* Build the read-only list node for a component_filter in default view.
*
* Joins the resolved label strings from data.entries with HTML line-breaks
* and delegates wrapper construction to ui.component.build_wrapper_list,
* which applies the standard CSS classes, ontology CSS, and debug hooks.
*
* A click listener is attached so that a user can open the edit dialog
* (always in 'modal' mode) directly from the list row without switching
* the section mode. activate_edit_in_list handles permission and
* read-only guards before opening the modal.
*
* @param {Object} self    - component_filter instance; must expose .data.entries
*                           (Array of resolved label strings, possibly empty).
* @param {Object} options - Forwarded from render_list_component_filter.list;
*                           not consumed here but kept for interface parity.
* @returns {Promise<HTMLElement>} The constructed wrapper element ready to
*                                 be inserted into the DOM.
*/
view_default_list_filter.render = async function(self, options) {

	// short vars
		const data			= self.data
		// data.entries holds the pre-resolved display strings for selected filter values;
		// fall back to an empty array when no values are selected yet.
		const entries		= data.entries || []
		// Join with <br> so each entry appears on its own line inside the span.
		const value_string	= render_value(entries, self.context.render_class).join('<br>')

	// wrapper
		// build_wrapper_list creates the standard <div> with model/tipo CSS classes
		// and injects a <span> containing value_string as innerHTML.
		const wrapper = ui.component.build_wrapper_list(self, {
			value_string : value_string
		})

	// click handler for edit mode activation (modal)
		// (!) Always 'modal' — filter components need the full edit UI and are
		// typically too wide for inline editing within a list cell.
		// e.stopPropagation() prevents the section row click handler from
		// intercepting this event and triggering unintended row navigation.
		bind_edit_in_list(self, wrapper, { mode: 'modal' })


	return wrapper
}//end list



// @license-end
