// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_label, page_globals, SHOW_DEBUG, DEDALO_CORE_URL*/
/*eslint no-undef: "error"*/



/**
* VIEW_DEFAULT_LIST_RADIO_BUTTON
* Default list-mode renderer for component_radio_button.
*
* Produces a single, click-activatable wrapper that shows the component's
* current value as a flat string and opens an edit dialog when clicked.
*
* Dispatch: render_list_component_radio_button selects this module when
* self.context.view is 'default' (or absent). The other list views are
* view_mini_list_radio_button ('mini') and view_text_list_radio_button ('text').
*
* Exports:
*   view_default_list_radio_button        - No-op constructor (prototype carrier pattern)
*   view_default_list_radio_button.render - Async factory; builds and returns the wrapper
*/

// imports
	import {ui} from '../../common/js/ui.js'
	import {render_join} from '../../common/js/utils/render_escape.js'
	import {bind_edit_in_list} from '../../component_common/js/component_common.js'



/**
* VIEW_DEFAULT_LIST_RADIO_BUTTON
* No-op constructor used as the namespace carrier for the static `render` method.
* Following the Dédalo render-module pattern, only the static method on this
* export is called; the constructor is never instantiated directly.
*/
export const view_default_list_radio_button = function() {

	return true
}//end view_default_list_radio_button



/**
* RENDER
* Builds the list-mode DOM wrapper for a component_radio_button instance.
*
* Behaviour:
*   1. Reads self.data.entries (array of locator objects) and collapses them
*      into a single display string by joining with ' | '.  In practice a radio
*      button component holds at most one entry, so value_string will be either
*      a single label string or an empty string when the component has no value.
*   2. Delegates DOM construction to ui.component.build_wrapper_list, which
*      applies the standard CSS classes, wraps value_string in a <span>, and
*      wires up debug helpers when SHOW_DEBUG is active.
*   3. Attaches a click listener that calls activate_edit_in_list.  That helper
*      opens either an inline editor or a modal depending on wrapper width vs
*      self.minimum_width_px (default 90 px for component_radio_button), guarded
*      by permission and dataframe checks.  e.stopPropagation() prevents the
*      section-row click handler from also firing.
*
* Data contract (set by component_common.init):
*   self.data.entries — Array<{section_id: number, section_tipo: string, id?: number}>
*     The locator objects for the currently selected option(s).  The server
*     resolves these to labels before sending; in list mode the entries array
*     therefore contains pre-resolved label strings (not raw locators).
*     An empty array means no selection.
*
* (!) Note: entries is joined with the literal string ' | '.  Unlike
*   view_text_list_radio_button, this view does NOT use
*   self.context.fields_separator.  The two views intentionally diverge here:
*   'text' view is designed for embedding in rich text contexts that supply a
*   custom separator, while 'default' list view uses a fixed visual separator.
*
* @param {Object} self    - Live component_radio_button instance.
* @param {Object} options - Options forwarded from the render dispatcher;
*   currently unused by this view but kept for interface parity with other
*   view renderers.
* @returns {Promise<HTMLElement>} Resolves to the populated wrapper div.
*/
view_default_list_radio_button.render = async function(self, options) {

	// short vars
		const data			= self.data || {}
		const entries		= data.entries || []
		// collapse all entries into one display string; radio buttons have at most
		// one entry, so this join is effectively a no-op except for the empty case
		const value_string	= render_join(entries, ' | ', self.context.render_class)

	// wrapper
		const wrapper = ui.component.build_wrapper_list(self, {
			value_string : value_string
		})

	// click handler for edit mode activation
		bind_edit_in_list(self, wrapper)


	return wrapper
}//end render



// @license-end
