// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
 /*global get_label, page_globals, SHOW_DEBUG, DEDALO_CORE_URL*/
/*eslint no-undef: "error"*/



// imports
	import {ui} from '../../common/js/ui.js'
	import {render_join} from '../../common/js/utils/render_escape.js'
	import {attach_item_dataframe} from '../../component_common/js/component_common.js'
	import {bind_edit_in_list} from '../../component_common/js/component_common.js'



/**
* VIEW_DEFAULT_LIST_NUMBER
* Default list-cell view for component_number.
*
* This module renders a numeric component in its standard list (read) state: a
* single clickable wrapper that shows the joined numeric value(s) and, when the
* user has write permission (permissions > 1) and the component is not inside a
* dataframe, opens an edit modal on click.
*
* It is instantiated by render_list_component_number.prototype.list when
* context.view is 'default' (or absent). The other list views — 'mini' and
* 'text' — are handled by view_mini_number and view_text_list_number respectively.
*
* Main export: view_default_list_number.render (static async, no prototype methods).
*/
export const view_default_list_number = function() {

	return true
}//end view_default_list_number



/**
* VIEW_DEFAULT_LIST_NUMBER.RENDER
* Build the list-cell DOM node for a numeric component in default list view.
*
* Produces a `<div>` wrapper via ui.component.build_wrapper_list, adds a `<span>`
* with the joined numeric value(s), wires a click handler that opens an edit modal,
* and — when the component is configured with `has_dataframe` — appends a rendered
* component_dataframe node per entry.
*
* Data contract:
*   self.data.entries  — Array of `{ id: number|null, value: number|null }` objects.
*                        Non-translatable: no `lang` key is present.
*   self.context.fields_separator — Guaranteed to be set by the dispatcher
*                        (render_list_component_number.prototype.list) before this
*                        function is called; used to join multiple entries into one
*                        display string (e.g. ' | ').
*
* Click handler:
*   Calls activate_edit_in_list with mode 'modal'. e.stopPropagation() prevents
*   the click from bubbling to ancestor section-row handlers that would otherwise
*   consume it before the modal can open.
*   activate_edit_in_list performs its own read-only / permissions / dataframe-context
*   guards internally; this view does not duplicate those checks.
*
* Dataframe glue:
*   When context.properties.has_dataframe is truthy, attach_item_dataframe renders
*   and appends a sibling component_dataframe node inside the wrapper for each entry.
*   The loop is sequential (await inside for-of) because each call may mutate
*   self.ar_instances and must complete before the next iteration reads the counter.
*   attach_item_dataframe is a no-op when has_dataframe is absent, so the loop is
*   safe to run unconditionally.
*
* @param {Object} self    - The component_number instance (must have data, context,
*                           permissions, and section_id populated by init).
* @param {Object} options - Render options forwarded from the list dispatcher (not
*                           currently consumed by this view but preserved for API
*                           parity with other view modules).
* @returns {Promise<HTMLElement>} Resolves to the wrapper div ready to insert into
*   the list row.
*/
view_default_list_number.render = async function(self, options) {

	// short vars
		const data		= self.data || {}
		const entries	= data.entries || []

	// Value as string
		// Map each entry to its raw numeric value and join with the configured separator.
		// entries[n].value is a JS number (or null); String coercion happens inside
		// build_wrapper_list's innerHTML assignment.
		const value_string	= (entries.length>0)
			? render_join(entries.map(item => item.value), self.context.fields_separator, self.context.render_class)
			: ''

	// wrapper
		// build_wrapper_list creates the <div> with all standard CSS classes
		// (wrapper_component, model, tipo, section_tipo_tipo, list, view_default)
		// and injects a <span> with value_string when the string is non-empty.
		const wrapper = ui.component.build_wrapper_list(self, {
			value_string : value_string
		})

	// click handler for edit mode activation (modal)
		// (!) stopPropagation is required: without it the click bubbles to the section
		// row handler which intercepts all clicks for row-selection, swallowing the
		// intent to open the edit modal.
		bind_edit_in_list(self, wrapper, { mode: 'modal' })


	// component_dataframe (shared literal-view glue, no-op without has_dataframe)
		// Iterate entries sequentially to preserve the ar_instances push order and
		// the id_key counter alignment inside attach_item_dataframe.
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
