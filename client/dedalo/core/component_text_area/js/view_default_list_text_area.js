// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_label, page_globals, SHOW_DEBUG, DEDALO_CORE_URL*/
/*eslint no-undef: "error"*/



// imports
	import {ui} from '../../common/js/ui.js'
	import {attach_item_dataframe} from '../../component_common/js/component_common.js'
	import {render_fallback_value, escape_html} from '../../common/js/utils/render_escape.js'
	import {bind_edit_in_list} from '../../component_common/js/component_common.js'



/**
* VIEW_DEFAULT_LIST_TEXT_AREA
* Default list-mode view for component_text_area.
*
* Builds a clickable list wrapper that shows the rich-text field value as plain HTML
* and, on click, opens a 90%-wide modal containing the full edit-mode renderer so
* the user can modify the text without leaving the list view.
*
* This module is the 'default' case in render_list_component_text_area.prototype.list.
* It is also the fallback when self.context.view is absent or unrecognised.
*
* Data flow:
*   self.data.entries        — array of per-entry objects ({value: string} or null)
*   self.data.fallback_value — parallel array used when an entry is null (marked with <mark>)
*   get_fallback_value()     — merges entries + fallback_value into an array of display strings
*   fields_separator         — delimiter from context used to join multi-entry text into one string
*
* Exports: {view_default_list_text_area}
*/



/**
* VIEW_DEFAULT_LIST_TEXT_AREA
* Constructor function — no-op pattern used across Dédalo view modules.
* All rendering state lives on the component_text_area instance (self)
* passed into the static render method; this constructor is never instantiated.
* @returns {boolean} Always true
*/
export const view_default_list_text_area = function() {

	return true
}//end view_default_list_text_area



/**
* RENDER
* Builds the full default list-mode DOM node for a component_text_area instance.
*
* The returned wrapper is a standard Dédalo list wrapper div (built by
* ui.component.build_wrapper_list) containing:
*   1. A click handler that opens a 90%-wide edit modal (via activate_edit_in_list).
*   2. A content_data <div> holding a <span> with the resolved display text.
*   3. Optional dataframe label nodes appended by attach_item_dataframe for each entry.
*
* Language note: the lang used for the modal is read from self.data.lang rather than
* self.lang (the instance-level context language). component_text_area can hold content
* in a language that differs from the section context — reading it from data ensures the
* modal opens in the language that was actually loaded, not the ambient list language.
* After modal close the component refreshes with autoload:false to avoid a server round-trip.
*
* The value_string passed to the inner <span> is NOT forwarded to build_wrapper_list
* (that parameter is commented out). build_wrapper_list would add its own <span>; instead
* the value is placed manually into content_data so both the span and dataframe nodes sit
* inside the same scoped container.
*
* @param {Object} self    - component_text_area instance; must have .data, .context, .lang
* @param {Object} options - Render options forwarded from render_list_component_text_area
*                           (currently unused by this view but kept for API parity)
* @returns {Promise<HTMLElement>} Resolves to the wrapper div ready for DOM insertion
*/
view_default_list_text_area.render = async function(self, options) {

	// short vars
		const data				= self.data
		const entries			= data.entries || []
		const fallback_value	= data.fallback_value || []
		const fallback			= render_fallback_value(entries, fallback_value, self.context.render_class)
		const value_string		= fallback.join(escape_html(self.context.fields_separator))

	// wrapper
	// (!) value_string is intentionally NOT passed here — the span is added manually
	// below into content_data so that dataframe nodes share the same container.
		const wrapper = ui.component.build_wrapper_list(self, {
			// value_string : value_string
		})

	// click handler for edit mode activation
	// lang: Use lang from data instead from context because the problem with component_text_area context lang
		const lang = self.data && self.data.lang
			? self.data.lang
			: self.lang
		bind_edit_in_list(self, wrapper, {
				mode			: 'modal',
				modal_width		: '90%',
				lang			: lang,
				on_close		: () => {
					// force to preserve the editing language (can be different from the language in list mode)
					self.lang = lang
					// refresh whole component
					self.refresh({
						autoload : false
					})
				}
			})

	// content_data
	// Scoped container for the text value and any dataframe label nodes.
	// Exposed on wrapper.content_data so callers can access it directly if needed.
		const content_data = document.createElement('div')
			  content_data.classList.add('content_data', self.mode, self.type)
			  wrapper.appendChild(content_data)
			  // set pointers
			  wrapper.content_data = content_data

	// value
	// Render the merged display text (current language + fallback) as innerHTML so that
	// existing HTML markup in the rich-text value (e.g. <mark>, <p>) is preserved.
		ui.create_dom_element({
			element_type	: 'span',
			inner_html		: value_string,
			parent			: content_data
		})

	// component_dataframe (shared literal-view glue, no-op without has_dataframe)
	// Appends dataframe label nodes for each entry. attach_item_dataframe is a no-op
	// when the component's context does not declare has_dataframe, so iterating all
	// entries unconditionally is safe.
		for (const entry of entries) {
			await attach_item_dataframe({
				self		: self,
				item		: entry,
				container	: content_data
			})
		}


	return wrapper
}//end render



// @license-end
