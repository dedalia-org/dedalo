// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_label, page_globals, SHOW_DEBUG, DEDALO_CORE_URL*/
/*eslint no-undef: "error"*/



// imports
	import {ui} from '../../common/js/ui.js'
	import {render_join} from '../../common/js/utils/render_escape.js'
	import {attach_item_dataframe} from '../../component_common/js/component_common.js'
	import {bind_edit_in_list} from '../../component_common/js/component_common.js'



/**
* VIEW_DEFAULT_LIST_EMAIL
* Namespace object for the email component's default list view (read-only grid cell).
*
* Exposes a single static method, `render`, that the component's render pipeline
* calls when displaying an email value inside a section list/grid row. Clicking the
* rendered cell opens the full edit modal so the user can change the address without
* leaving the list context.
*
* This constructor is never instantiated; it exists solely to carry the static
* `render` method and to follow the view namespace convention used across all
* component view modules.
*/
export const view_default_list_email = function() {

	return true
}//end view_default_list_email



/**
* RENDER
* Build and return the DOM wrapper that represents this email component inside a
* list/grid row.
*
* Behaviour:
*  1. Concatenates all stored e-mail values (one per entry) into a single display
*     string, separated by `self.context.fields_separator` (e.g. a comma).
*  2. Delegates the wrapper construction to `ui.component.build_wrapper_list`, which
*     applies the standard list CSS classes and sets the visible text.
*  3. Attaches a click listener that calls `activate_edit_in_list` in 'modal' mode,
*     opening a 40 rem–wide edit dialog. `e.stopPropagation()` prevents the row's
*     own click handler from firing and double-triggering navigation.
*  4. Iterates over entries and calls `attach_item_dataframe` for each one. This is
*     a no-op when the component instance does not carry `has_dataframe` in its
*     context properties, so it is safe to call unconditionally.
*
* Data shape expected on `self.data`:
*   { entries: Array<{ id: number|string, value: string }> }
*   An absent or null `self.data` is handled gracefully — entries defaults to [].
*
* @param {Object} self    - Component instance (component_email). Must expose
*                           `self.data`, `self.context.fields_separator`,
*                           `self.permissions`, and `self.show_interface`.
* @param {Object} options - Render options passed down from the component pipeline
*                           (currently unused by this view, reserved for future use).
* @returns {Promise<HTMLElement>} The fully built list-row wrapper node, ready to be
*                                 inserted into the DOM by the caller.
*/
view_default_list_email.render = async function(self, options) {

	// short vars
		const data			= self.data || {}
		const entries		= data.entries || []
		// Join all email values with the configured separator (e.g. ', ').
		// An empty entries array produces an empty string, giving the cell a blank appearance.
		const value_string	= render_join(entries.map(item => item.value), self.context.fields_separator, self.context.render_class)

	// wrapper
		// build_wrapper_list sets the standard CSS classes and inserts value_string as
		// the cell's visible content. The returned node is a plain HTMLElement.
		const wrapper = ui.component.build_wrapper_list(self, {
			value_string : value_string
		})

	// click handler for edit mode activation (modal)
		// stopPropagation prevents the enclosing section row from intercepting the event.
		// modal_width of '40rem' gives enough room for an e-mail address without being
		// too large on narrow viewports.
		bind_edit_in_list(self, wrapper, { mode: 'modal', modal_width: '40rem' })

	// component_dataframe (shared literal-view glue, no-op without has_dataframe)
		// For each data entry, attempt to attach a companion dataframe component.
		// attach_item_dataframe returns null immediately when context.properties.has_dataframe
		// is falsy, so this loop is cheap when the feature is not configured.
		// The pairing key used inside attach_item_dataframe is entry.id (not the array index),
		// ensuring stable subdatum resolution across re-renders.
		for (const entry of entries) {
			await attach_item_dataframe({
				self		: self,
				item		: entry,
				container	: wrapper
			})
		}

	return wrapper
}//end render



// @license-end
