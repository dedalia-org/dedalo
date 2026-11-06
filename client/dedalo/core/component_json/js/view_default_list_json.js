// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_label, page_globals, SHOW_DEBUG, DEDALO_CORE_URL, JSONEditor */
/*eslint no-undef: "error"*/



/**
* VIEW_DEFAULT_LIST_JSON
* Default list-mode view for component_json.
*
* Activated by render_list_component_json when `context.view` is 'default'
* (or not set). Renders a single-row wrapper in the section's record list
* that shows a human-readable summary of the stored JSON value and opens a
* full-screen JSONEditor modal when clicked.
*
* Architecture:
*   - view_default_list_json        – namespace stub / constructor (never called directly)
*   - view_default_list_json.render – async factory; returns the DOM wrapper node
*   - get_value_string              – exported pure helper; computes the preview string
*
* The summary string is derived from `data.entries[0]` (the first — and normally
* only — stored entry) using a configurable `list_show_key` property from the
* ontology context.  The modal is 90 % wide to give the JSON editor enough room.
*
* Contrast with view_collapse_list_json, which adds a collapse/expand toggle and
* handles the Activity-section (dd542) special case; that code was extracted from
* the commented-out block in get_value_string below.
*
* Main exports:
*   - view_default_list_json        – namespace / constructor stub
*   - view_default_list_json.render – async DOM factory
*   - get_value_string              – pure preview-string helper
*/



// imports
	import {ui} from '../../common/js/ui.js'
	import {render_value} from '../../common/js/utils/render_escape.js'
	import {bind_edit_in_list} from '../../component_common/js/component_common.js'
	import {json_preview} from './json_preview.js'



/**
* VIEW_DEFAULT_LIST_JSON
* Namespace stub for the default list view of component_json.
* Never instantiated; all behaviour lives on the static `.render` method.
*/
export const view_default_list_json = function() {

	return true
}//end view_default_list_json



/**
* RENDER
* Build the DOM wrapper for a component_json instance in default list mode.
*
* Constructs a standard list-row wrapper via `ui.component.build_wrapper_list`,
* appends a `div.content_data` child holding the preview string, and wires a
* click handler that opens the JSONEditor in a 90%-wide modal.
*
* Click handler details:
*   - `e.stopPropagation()` prevents the section-record row from intercepting
*     the click (e.g. row-selection highlight or outer click-to-edit handlers).
*   - `mode: 'modal'` forces the full modal path inside activate_edit_in_list
*     regardless of the wrapper width (unlike 'auto' mode).
*   - `lang` is resolved from `self.data.lang` instead of `self.lang` /
*     `self.context.lang` to avoid a known mismatch with component_text_area
*     context lang (see inline comment below).
*   - `on_close` refreshes the component (autoload: false) so the summary string
*     reflects any edits made inside the modal without re-fetching from the server.
*
* Note: `value_string` is intentionally NOT passed to `build_wrapper_list`
* (the call site has it commented out).  Instead the string is rendered into a
* separate `div.content_data > span` so that CSS styling can target it
* independently from the wrapper's own layout classes.
*
* @param {Object} self    - component_json instance. Must expose:
*                           `self.data` {Object}, `self.lang` {string},
*                           `self.context` {Object}, `self.mode` {string},
*                           `self.type` {string}, and `self.refresh` {Function}.
* @param {Object} options - Reserved; not consumed by this view renderer.
* @returns {Promise<HTMLElement>} Resolves to the fully wired wrapper `<div>`.
*/
view_default_list_json.render = async function(self, options) {

	// value_string
		const value_string = get_value_string(self)

	// wrapper
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
					// refresh whole component
					self.refresh({
						autoload : false
					})
				}
			})

	// content_data
		const content_data = document.createElement('div')
			  content_data.classList.add('content_data', self.mode, self.type)
			  wrapper.appendChild(content_data)
			  // set pointers
			  wrapper.content_data = content_data

	// value
		ui.create_dom_element({
			element_type	: 'span',
			inner_html		: render_value(value_string, self.context.render_class),
			parent			: content_data
		})


	return wrapper
}//end render



/**
* GET_VALUE_STRING
* Derive a short human-readable preview string from the component's stored
* JSON data for display in a list-mode row cell.
*
* Data shape:
*   `self.data.entries` is the flat array of stored entry objects, each with the
*   shape `{ id: number|null, value: * }`.  Index 0 is the primary entry for
*   the current request language.  This function reads `data.entries` directly
*   (not `data.entries[0].value`) and treats each element of the array as a raw
*   JSON object from which a display key is extracted.
*
* Strategy:
*   1. Read `context.properties.list_show_key` (falls back to `'msg'` when the
*      context has no `properties` object).  This key names the property inside
*      the first stored JSON object that should be used as the cell label.
*   2. If `entries[0]` exists AND contains the configured key, use that value.
*   3. If `entries[0]` exists but the key is absent, JSON-stringify the whole
*      `entries` array, truncate to 100 characters, and append ' …' so the cell
*      is never misleadingly empty for unrecognised JSON shapes.
*   4. If `entries` is empty, return an empty string.
*
* Note on the commented-out block (dd542 Activity section):
*   The special-case code that formatted Activity-log JSON as `key: value<br>`
*   lines was moved to view_collapse_list_json.get_value_string, which owns the
*   collapse view used by the Activity section.  It is kept here as a
*   historical reference; do not reinstate it in this view.
*
* Note on data shape difference vs. view_collapse_list_json:
*   view_collapse_list_json reads `self.data.entries[0].value` (the inner value
*   object) and compares against that.  This function reads `self.data.entries`
*   (the whole array) and accesses `entries[0][list_show_key]` directly.  The
*   two get_value_string implementations are intentionally not identical.
*
* @param {Object} self - component_json instance.  Must expose:
*                        `self.data` {Object} with an `entries` {Array} property,
*                        and `self.context` {Object} (may have a `properties`
*                        sub-object with `list_show_key` {string}).
* @returns {string} Preview string for the list cell (may be an empty string).
*/
export const get_value_string = function(self) {

	// short vars
		const data	= self.data
		const value	= data.entries || []

	// value_string Activity. Moved to view 'collapse' (view_collapse_list_json)
		// if(self.section_tipo==='dd542'){
		// 	// activity section case
		// 	const ar_values	= []
		// 	const value_len	= value.length
		// 	for (let i = 0; i < value_len; i++) {
		// 		const value_map = new Map(Object.entries(value[i]))
		// 		for (let [key, value] of value_map) {
		// 			ar_values.push( key + ': ' + value )
		// 		}
		// 	}
		// 	const value_string = ar_values.join('<br>')
		// 	return value_string
		// }

	// default cases
		const list_show_key = typeof self.context.properties!=='undefined'
			? self.context.properties.list_show_key
			: 'msg'

		const value_string = value[0] && (typeof value[0][list_show_key]!=='undefined')
			? value[0][list_show_key]
			: value[0]
				? json_preview(value, 100)+' ...'
				: ''


	return value_string
}//end get_value_string



// @license-end
