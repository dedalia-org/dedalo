// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_label, page_globals, SHOW_DEBUG, DEDALO_CORE_URL*/
/*eslint no-undef: "error"*/



// imports
	import {ui} from '../../common/js/ui.js'
	import {render_fallback_value, render_value} from '../../common/js/utils/render_escape.js'
	import {attach_item_dataframe, bind_edit_in_list} from '../../component_common/js/component_common.js'



/**
* VIEW_DEFAULT_LIST_INPUT_TEXT
* Default list-mode render view for component_input_text.
*
* Renders the stored text value(s) inside a standard list wrapper produced by
* `ui.component.build_wrapper_list`. Each value item in `data.entries` is
* rendered as a `<span>` element; when the component
* has `has_dataframe` set in its ontology properties, `attach_item_dataframe`
* appends the paired component_dataframe control to that span.
*
* Transliterated variants (`with_lang_versions: true`) show the alternative
* language value in parentheses after the main value string.
*
* Clicking the wrapper triggers `activate_edit_in_list`, which opens a modal
* (or inline) edit view — subject to the user's write permissions; read-only
* instances and those inside a dataframe are silently ignored.
*
* Exported as a namespace object: only the static `.render()` method is used.
* The constructor itself is a no-op returning `true`.
*/
export const view_default_list_input_text = function() {

	return true
}//end view_default_list_input_text



/**
* RENDER
* Builds and returns the DOM wrapper for component_input_text in list (and tm) mode.
*
* Data flow:
*   1. Reads `data.entries` (array of `{id, value, lang?}` items in the current language)
*      and `data.fallback_value` (same shape but for the fallback language).
*   2. Calls `get_fallback_value(entries, fallback_value)` to produce a flat array of
*      display strings; items present in the current language are used as-is, missing
*      items are replaced with the fallback value wrapped in `<mark>` tags.
*   3. When `context.properties.with_lang_versions` is true and
*      `data.transliterate_value[0].value` is non-empty (and at least one entry exists),
*      appends `" (<transliteration>)"` after each value item for the first entry.
*   4. Creates the standard list wrapper via `ui.component.build_wrapper_list(self)`.
*   5. Attaches a click handler that delegates to `activate_edit_in_list` (modal by default).
*   6. Iterates the resolved fallback array and creates one `<span>` per item, optionally
*      attaching a component_dataframe control and a `fields_separator` span between items.
*
* @param {Object} self    - The component_input_text instance. Expected properties:
*                           `self.data`              — `{entries, fallback_value, transliterate_value}`
*                           `self.context`           — `{properties, fields_separator, ...}`
*                           `self.context.properties.with_lang_versions` — {boolean} transliterable flag
* @param {Object} options - Pass-through render options (currently unused by this view).
* @returns {Promise<HTMLElement>} The populated wrapper div ready to insert into the DOM.
*/
view_default_list_input_text.render = async function(self, options) {

	// short vars
		const data					= self.data || {}
		const entries				= data.entries || []
		const fallback_value		= data.fallback_value || []
		const fallback				= render_fallback_value(entries, fallback_value, self.context.render_class)
		const with_lang_versions	= self.context.properties.with_lang_versions ?? false
		const transliterate_value 	= self.data.transliterate_value || []

	// transliterate components
	// add the translation of the data
		const transliterate_value_text = (with_lang_versions && transliterate_value[0]?.value && entries.length > 0)
			? ' (' + render_value(transliterate_value[0].value, self.context.render_class) + ')'
			: ''

	// wrapper
		const wrapper = ui.component.build_wrapper_list(self)

	// click handler for edit mode activation
		bind_edit_in_list(self, wrapper)

	// render values
		const fallback_length = fallback.length
		for (let i = 0; i < fallback_length; i++) {

			// The transliteration is appended as the rendered parenthetical
			// (`transliterate_value_text`, escaped above) — the raw array used to
			// be concatenated here, which coerced it through Array.toString().
			const value_string = fallback[i] + transliterate_value_text

			// Each fallback item gets its own <span> so dataframe controls can be
			// anchored to the correct item element and positioned correctly by CSS.
			const content_value = ui.create_dom_element({
				element_type	: 'span',
				inner_html		: value_string,
				parent			: wrapper
			})

			// component_dataframe (shared literal-view glue, no-op without has_dataframe)
			// `attach_item_dataframe` checks `context.properties.has_dataframe`; when the
			// flag is absent it returns null immediately without mutating the DOM.
				await attach_item_dataframe({
					self		: self,
					item		: entries[i],
					container	: content_value
				})

			// separator
			// A separator span is inserted only between consecutive items (never after the last).
			// Note: the separator is appended inside `content_value` rather than directly into
			// `wrapper`, which means it inherits the per-item span's styles and is included in
			// any dataframe click-target area for that item.
				if( i < entries.length -1 ) {
					// separator
					ui.create_dom_element({
						element_type	: 'span',
						inner_html		: render_value(self.context.fields_separator, 'text'),
						parent			: content_value
					})
				}
		}


	return wrapper
}//end list



// @license-end
