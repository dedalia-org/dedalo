// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_label, page_globals, SHOW_DEBUG, DEDALO_CORE_URL */
/*eslint no-undef: "error"*/



// imports
	import {ui} from '../../common/js/ui.js'
	import {render_join} from '../../common/js/utils/render_escape.js'
	import {attach_item_dataframe, bind_edit_in_list} from '../../component_common/js/component_common.js'
	import {get_ar_raw_data_value} from './render_edit_component_date.js'



/**
* VIEW_DEFAULT_LIST_DATE
* Read-only list view for component_date.
*
* Displays date, time, range, period, or date-time values as a plain text
* string inside a standard list wrapper. The component enters edit mode
* (via a modal dialog) when the user clicks the wrapper.
*
* This view is activated by render_list_component_date when context.view is
* 'default' (or absent). It is the primary list representation shown in
* record grids, portal autocomplete results, and the section list table.
*
* Exported symbol: view_default_list_date
*   .render(self, options) → Promise<HTMLElement>
*/
export const view_default_list_date = function() {

	return true
}//end view_default_list_date



/**
* RENDER
* Build the read-only list wrapper node for component_date.
*
* The returned element is a <div> produced by ui.component.build_wrapper_list,
* carrying CSS classes that identify the component type, tipo, section_tipo,
* mode ('list'), and view ('default'). When any date entries are present, they
* are serialised to a human-readable string and inserted as a <span> child by
* the builder.
*
* Data shape consumed from `self`:
*   self.data.entries  {Array<Object>}  - Array of raw date entry objects. Each
*       entry shape depends on the date_mode (from ontology properties):
*         'date'       → { id, start: { day, month, year, time } }
*         'date_time'  → { id, start: { day, month, year, time } } (with time)
*         'time'       → { id, start: { time } }
*         'range'      → { id, start: {...}, end: {...} }
*         'time_range' → { id, start: {...}, end: {...} }
*         'period'     → { id, period: { year, month, day } }
*       The serialisation to display strings is delegated to get_ar_raw_data_value,
*       which calls the appropriate self.date_to_string / self.time_to_string /
*       self.date_time_to_string method per mode.
*   self.context.fields_separator {string} - Separator between multiple entry
*       strings (e.g. ', ' or ' | '). Defined in ontology component properties.
*
* Click behaviour:
*   A single click on the wrapper calls activate_edit_in_list with mode 'modal',
*   which always opens a modal dialog regardless of wrapper width. Read-only and
*   dataframe contexts are handled inside activate_edit_in_list (returns false
*   without opening the editor). The click event is stopped from bubbling so
*   parent containers (e.g. a list row) do not also react.
*
* Dataframe support:
*   After building the wrapper, attach_item_dataframe is called for each entry.
*   When the component has an associated dataframe (has_dataframe), this appends
*   the dataframe UI element to the wrapper. It is a no-op for plain date
*   components without a dataframe.
*
* @param {Object} self - component_date instance providing context and data.
* @param {Object} options - Render options passed through from the list renderer.
* @returns {Promise<HTMLElement>} The constructed list wrapper element.
*/
view_default_list_date.render = async function(self, options) {

	// short vars
		// get_ar_raw_data_value converts raw entries to display strings per date_mode
		const ar_value		= get_ar_raw_data_value(self)
		// join multiple date values using the ontology-configured separator
		const value_string	= render_join(ar_value, self.context.fields_separator, self.context.render_class)

	// wrapper
		// build_wrapper_list creates a <div> with component/model/tipo/section_tipo CSS classes
		// and, when value_string is non-empty, inserts it inside a <span> child.
		const wrapper = ui.component.build_wrapper_list(self, {
			value_string : value_string
		})

	// click handler for edit mode activation (modal)
		// (!) Always modal — component_date's full-width calendar UI is not suited for inline mode.
		bind_edit_in_list(self, wrapper, { mode: 'modal' })

	// component_dataframe (shared literal-view glue, no-op without has_dataframe)
		// Re-read entries from self.data rather than reusing ar_value, because
		// attach_item_dataframe needs the original entry objects (with their id),
		// not the serialised display strings.
		const entries = self.data.entries || []
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
