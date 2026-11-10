// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_label, DEDALO_CORE_URL, Promise */
/*eslint no-undef: "error"*/



/**
* VIEW_MINI_LIST_DATAFRAME
* Read-only "mini" render view for component_dataframe in list / TM contexts.
*
* Renders the dataframe frame button in its most compact form: a single
* `span.button.activate` labelled with `properties.label`, painted with the
* rating colour when a rating ddo is configured. No add/modal chrome is present
* — this view is intentionally display-only and carries no interaction handlers.
*
* Context:
*   This file is the client-side counterpart to the PHP list rendering of
*   component_dataframe when the `view` is `mini`. It is loaded as a JS module
*   and used by the main component's list/TM render path to show a per-value
*   frame button inline with tight horizontal space (e.g. the IRI column).
*
* DOM output:
*   span.mini.component_dataframe_mini      <- wrapper (built by ui.component.build_wrapper_mini)
*     span.content_data
*       span.content_value
*         span.button.activate              <- labelled, optionally coloured by rating
*
* Rating mechanism (same as view_default_list_dataframe):
*   If the instance's request_config hide.ddo_map contains a ddo with
*   `role: "rating"` (a component_radio_button in the target section), the
*   resolved datum is fetched via `self.get_rating()`. Its first value entry is
*   matched against the rating component's datalist; the matched item's
*   `hide[0].literal` is used as the button background colour, and
*   `ui.get_text_color()` picks a WCAG-contrast-aware foreground colour.
*   When the datalist match fails (no rating set) the fallback is the
*   CSS variable `--color_blue_3` (#006ed2). When there are no entries at all,
*   no colour is applied.
*
* Main exports:
*   view_mini_list_dataframe              - namespace constructor (identity only)
*   view_mini_list_dataframe.render       - async entry point; call from parent render
*/
import {ui} from '../../common/js/ui.js'
import {same_section_id} from '../../common/js/utils/index.js'



/**
* VIEW_MINI_LIST_DATAFRAME
* Namespace constructor for the mini-list dataframe view.
* This function exists solely to provide a named namespace onto which static
* methods (`render`, etc.) are attached. It is never used as an object
* constructor with `new`. Returns `true` to signal successful registration.
* @returns {boolean} Always true
*/
export const view_mini_list_dataframe = function() {

	return true
}//end view_mini_list_dataframe



/**
* RENDER
* Entry point for the mini list view. Builds the component's DOM wrapper and
* content for display in a list or time-machine column.
*
* When `render_level` is `'content'`, returns only the inner `content_data`
* span (skipping the outer wrapper). This allows a parent component to embed
* the dataframe button directly into its own DOM subtree without the wrapper.
*
* When `render_level` is `'full'` (default), wraps the content in the mini
* wrapper produced by `ui.component.build_wrapper_mini(self)`, which yields
* a `span.mini.component_dataframe_mini` element. A `content_data` pointer is
* set on the wrapper for external refresh access.
*
* @param {Object} self - The component_dataframe instance (alias of component_portal).
*   Expected properties (accessed directly or by called helpers):
*     self.data           {Object}   - resolved component data with `entries` array
*     self.properties     {Object}   - ontology properties including `label`
*     self.get_rating     {Function} - method returning rating datum or null;
*       internally accesses self.datum and self.request_config_object
* @param {Object} options - Render options
* @param {string} [options.render_level='full'] - 'full' returns the full wrapper;
*   'content' returns only the inner content_data span
* @returns {Promise<HTMLElement>} Resolves to the wrapper (full) or content_data span (content)
*/
view_mini_list_dataframe.render = async function(self, options) {

	// options
		const render_level = options.render_level || 'full'

	// content_data
		const content_data = get_content_data(self)
		if (render_level==='content') {
			return content_data
		}

	// wrapper. ui build_edit returns component wrapper
		const wrapper = ui.component.build_wrapper_mini(self)
		wrapper.appendChild(content_data)
		// set pointers
		wrapper.content_data = content_data


	return wrapper
}//end render



/**
* GET_CONTENT_DATA
* Builds the `span.content_data` container and populates it with the rendered
* content value. This is a thin structural wrapper; the visual content is fully
* produced by `render_content_value`.
* @param {Object} self - The component_dataframe instance
* @returns {HTMLElement} A `span.content_data` element containing the content value
*/
const get_content_data = function(self) {

	// content_data
		const content_data = ui.create_dom_element({
			element_type	: 'span',
			class_name		: 'content_data'
		})

	// content_value. render content_value node
		const content_value = render_content_value({
			self : self
		})
		content_data.appendChild(content_value)


	return content_data
}//end get_content_data



/**
* RENDER_CONTENT_VALUE
* Builds the `span.content_value` with the frame button and optional rating colours.
*
* The button label comes from `self.properties.label` (the ontology label of the
* dataframe slot). If no label is configured, it falls back to `'?'` as a
* visible indicator that the node has no label.
*
* Rating colour logic (applies only when `entries.length >= 1`):
*   1. `self.get_rating()` looks up the rating component datum from the instance's
*      subdatum (see `component_dataframe::get_rating()` in component_dataframe.js).
*   2. If a datum exists and has at least one value entry, the first value's
*      `section_id` is matched against `rating_data.datalist` to retrieve the
*      rated item, which carries a `hide[0].literal` hex colour string.
*   3. If the value is present but no datalist match is found (e.g. empty or
*      ABSENT datalist, or not-yet-set rating), the fallback colour is `--color_blue_3` (#006ed2),
*      read live from the document's CSS custom properties via `ui.css_var()`.
*   4. A WCAG-contrast foreground colour is computed by `ui.get_text_color()` and
*      applied to `button_activate.style.color`.
*
* (!) The `--color_blue_3` fallback is resolved via `ui.css_var()` at render time,
*     so it tracks live theme changes. The `view_default_list_dataframe` variant
*     stores the same fallback in a local constant; here it is read inline inside
*     the conditional branch. This is intentional — avoid calling `ui.css_var()`
*     when no entries are present (no colour is applied in that case).
*
* @param {Object} options - Options object
* @param {Object} options.self - The component_dataframe instance
* @returns {HTMLElement} A `span.content_value` containing the activate button
*/
const render_content_value = function(options) {

	// options
		const self	= options.self

	// short vars
		const data		= self.data || {}
		const entries	= data.entries || []

	// content_value
		const content_value = ui.create_dom_element({
			element_type	: 'span',
			class_name		: 'content_value'
		})

	// button_activate
		const button_activate = ui.create_dom_element({
			element_type	: 'span',
			class_name		: 'button activate' + (entries.length >= 1 ? ' has_value' : ''), // has_value: a frame exists (visible without a rating)
			text_content 	:  self.properties.label || '?',
			parent			: content_value
		})

		if(entries.length >= 1) {

			const rating_data = self.get_rating()
			// the selected rating locator lives in `entries` (the v7 data model);
			// `value` kept as a fallback for any legacy datum shape.
			const rating_entries = rating_data && (rating_data.entries ?? rating_data.value)
			if(rating_entries){

				const rating_value = rating_entries[0]
				// Match the first entry's section_id against the radio_button datalist.
				// When rating_value is falsy (value array is empty), synthesise a sentinel
				// object that supplies the blue fallback colour as hide[0].literal.
				// a rating item may arrive WITHOUT a datalist (e.g. mode 'solved'):
				// no datalist = no option = the default colour, never a throw.
				const default_bk_color	= ui.css_var('--color_blue_3', '#006ed2')
				const datalist			= Array.isArray(rating_data.datalist) ? rating_data.datalist : []
				const rating = (rating_value)
					? datalist.find(el => same_section_id(el.section_id, rating_value.section_id) )
					: {
						hide:[{
							literal: default_bk_color // default when the datalist is empty (rating not set)
						}]
					}

				// update background color
					// no matching option (no datalist, or a deleted/out-of-scope option):
					// the default colour; an option without a literal: the orange marker.
					const bg_color = rating
						? (rating.hide?.[0]?.literal || ui.css_var('--color_orange_dedalo', '#f78a1c'))
						: default_bk_color
					button_activate.style.backgroundColor = bg_color

				// update text color based on background
					// ui.get_text_color computes a WCAG-contrast foreground (black or white)
					// so the label remains legible regardless of the rating colour.
					const text_color = ui.get_text_color(bg_color)
					button_activate.style.color = text_color
			}
		}

	return content_value
}//end render_content_value



// @license-end
