// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/* global */
/*eslint no-undef: "error"*/



// imports
	import {ui} from '../../common/js/ui.js'
	import {render_fallback_value, render_value} from '../../common/js/utils/render_escape.js'
	import {attach_item_dataframe} from '../../component_common/js/component_common.js'



/**
* VIEW_MINI_INPUT_TEXT
* Compact read-only renderer for component_input_text in 'mini' mode.
*
* 'Mini' mode is used when the component's value must be shown in a very
* constrained space (e.g. inside a portal cell, a relation chip, or a
* compact grid column). No edit affordance is provided; the output is a
* single <span class="mini component_input_text_mini"> containing one
* <span> child per value item separated by context.fields_separator.
*
* This module exports only the constructor stub (identity function) and the
* static render method attached to it. The constructor is never called
* directly — component_input_text's prototype chain delegates its 'mini'
* render slot to view_mini_input_text.render via the render dispatcher in
* render_edit_component_input_text.
*
* @module view_mini_input_text
* @see render_edit_component_input_text  Render dispatcher that calls this view.
* @see component_input_text              Component that owns the data/context passed as `self`.
* @see ui.component.build_wrapper_mini  Builds the outer wrapper <span>.
* @see attach_item_dataframe            Appends structured dataframe metadata nodes (no-op when
*                                       context.properties.has_dataframe is falsy).
*/
export const view_mini_input_text = function() {

	return true
}//end view_mini_input_text



/**
* RENDER
* Build and return the DOM subtree that represents a component_input_text value
* in 'mini' display mode.
*
* Layout produced:
*   <span class="mini component_input_text_mini">
*     <span>{value}{transliterate_suffix}</span>
*     [<span>{separator}</span>]  ← inserted between items, not after the last
*     <span>{value2}{transliterate_suffix}</span>
*     …
*   </span>
*
* Fallback behaviour: when `data.entries[i]` is null/undefined for a given
* index (i.e. the current language has no value), `get_fallback_value` wraps
* the alternate-language value in <mark>…</mark> so the caller can visually
* distinguish untranslated content. The fallback source is `data.fallback_value`,
* populated by the server when a fallback language is resolved.
*
* Transliteration suffix: when `context.properties.with_lang_versions` is true
* and `data.transliterate_value[0].value` is non-empty, a parenthesised
* transliteration string is appended to every item span's inner_html (e.g.
* "Raspa (ラスパ)"). `data.transliterate_value` is an Array of `{id, value, lang}`
* (the other-lang counterpart; null when the component holds no data), read the
* same way as view_default_list_input_text.
*
* Dataframe: `attach_item_dataframe` is called for every item. It is a no-op
* when `context.properties.has_dataframe` is false/absent, so calling it
* unconditionally is safe and avoids a conditional import path.
*
* Separator: `context.fields_separator` is expected to be a non-empty string
* (e.g. ' | '). It is set as a default in render_edit_component_input_text
* before any view is called; read it from context rather than hard-coding.
*
* @param {Object} self    - The component_input_text instance (provides data, context, tipo, etc.)
* @param {Object} options - Reserved for future use; currently unused by this view.
* @returns {Promise<HTMLElement>} The populated wrapper <span> element, ready to be inserted into the DOM.
*/
view_mini_input_text.render = async function(self, options) {

	// short vars
		const data					= self.data
		const entries				= data.entries || []
		const fallback_value		= data.fallback_value || []
		const fallback				= render_fallback_value(entries, fallback_value, self.context.render_class)
		const with_lang_versions	= self.context.properties.with_lang_versions ?? false

	// transliterate components
	// add the translation of the data
		// `self.data.transliterate_value` is an Array<{id,value,lang}> per the server
		// contract; the first item's value is rendered (escaped) as the suffix.
		const transliterate_value = (with_lang_versions && self.data.transliterate_value?.[0]?.value && entries.length)
			? ' (' + render_value(self.data.transliterate_value[0].value, self.context.render_class) + ')'
			: ''

	// wrapper — <span class="mini component_input_text_mini">
		const wrapper = ui.component.build_wrapper_mini(self, {})

		const fallback_length = fallback.length
		for (let i = 0; i < fallback_length; i++) {

			// combine the resolved display string with any transliteration hint
			const value_string = fallback[i] + transliterate_value

			// each item renders as an inline <span> appended directly to the wrapper
			const content_value = ui.create_dom_element({
				element_type	: 'span',
				inner_html		: value_string,
				parent			: wrapper
			})

			// component_dataframe (shared literal-view glue, no-op without has_dataframe)
			await attach_item_dataframe({
				self		: self,
				item		: entries[i],
				container	: content_value,
				view		: 'mini'
			})

			// separator — injected between items, not after the last one
			if( i < entries.length -1 ){
				ui.create_dom_element({
					element_type	: 'span',
					inner_html		: render_value(self.context.fields_separator, 'text'),
					parent			: content_value
				})
			}
		}//end for (let i = 0; i < fallback_length; i++)


	return wrapper
}//end view_mini_input_text.render



// @license-end
