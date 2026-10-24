// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_label, page_globals, SHOW_DEBUG, DEDALO_CORE_URL*/
/*eslint no-undef: "error"*/



// imports
	import {ui} from '../../../../common/js/ui.js'



/**
* RENDER_GET_COINS_BY_PERIOD
* Client-side render module for the `get_coins_by_period` numisdata widget.
*
* This widget displays the distribution of numismatic records (coins) grouped
* by chronological period. The PHP backend (`class.get_coins_by_period.php`)
* resolves linked coin records, walks the thesaurus hierarchy, optionally
* rolls counts up to parent "Era" terms (when `use_parent` is enabled in the
* IPO config), and emits a single keyed output item per IPO entry:
*
*   period — an ordered array of period objects, each with:
*     {
*       section_id   : string|null  — thesaurus term section_id (null for catch-all)
*       section_tipo : string|null  — thesaurus section_tipo    (null for catch-all)
*       parent       : Object|null  — parent locator used during hierarchy traversal
*       label        : string       — localised term label; '?' for unmatched coins
*       count        : number       — number of coins assigned to this period term
*     }
*
* The PHP method returns one value item per IPO entry:
*   {
*     widget    : 'get_coins_by_period',  // string — widget class name
*     key       : 0,                      // number — 0-based IPO index
*     widget_id : 'period',               // string — always 'period' for this widget
*     value     : { "0": {...}, "1": {...} }  // Object keyed by order index
*   }
*
* Note: `value` inside each period datum is an ordered plain Object (not an
* Array); the keys are numeric-string insertion-order indices produced by PHP's
* `json_encode`. `get_value_element` iterates it with `Object.entries()`.
*
* The `get_label`, `page_globals`, `SHOW_DEBUG`, and `DEDALO_CORE_URL` globals
* are declared in the `/*global*‌/` directive for ESLint but are not referenced
* in this file; they are available for future localisation or debug additions.
*
* Prototype methods exported here are mixed into `get_coins_by_period` widget
* instances by the main module (`get_coins_by_period.js`).
*
* Main export: `render_get_coins_by_period` (constructor, no instance state)
*/
export const render_get_coins_by_period = function() {

	return true
}//end render_get_coins_by_period



/**
* EDIT
* Render node for use in modes: edit, edit_in_list.
*
* Builds the full widget wrapper (or just the inner content node when
* `render_level === 'content'`) by delegating DOM layout to
* `get_content_data_edit`. When `render_level` is not 'content' the result is
* wrapped in a standard widget shell via `ui.widget.build_wrapper_edit`.
*
* @param {Object} options - render options supplied by widget_common.render()
* @param {string} options.render_level - when 'content', returns only the inner
*   content_data element; any other value returns the full decorated wrapper
* @returns {Promise<HTMLElement>} wrapper element or content_data node
*/
render_get_coins_by_period.prototype.edit = async function(options) {

	const self = this

	const render_level = options.render_level

	// content_data
		const content_data = await get_content_data_edit(self)
		if (render_level==='content') {
			return content_data
		}

	// wrapper. ui build_edit returns widget wrapper
		const wrapper = ui.widget.build_wrapper_edit(self, {
			content_data : content_data
		})


	return wrapper
}//end edit



/**
* GET_CONTENT_DATA_EDIT
* Builds the `<ul class="values_container">` list of period rows.
*
* Iterates over every entry in `self.ipo` (one per configured source portal /
* period group). For each IPO index `i`, it filters `self.value` to the single
* output item whose `key === i` and `widget_id === 'period'`, then delegates
* DOM construction for that row to `get_value_element`.
*
* Data contract (`self.value`):
*   A flat array produced by PHP `get_coins_by_period::get_data()`. Each
*   element has the shape:
*   {
*     widget    : 'get_coins_by_period',
*     key       : 0,          // 0-based IPO index
*     widget_id : 'period',
*     value     : {            // plain Object, keys are numeric-string order indices
*       "0": { section_id, section_tipo, parent, label, count },
*       "1": { ... },
*       ...
*     }
*   }
*   When the source portal has no linked records PHP returns [] and `self.value`
*   will be empty; the `filter` call yields [] and `get_value_element` will
*   throw a TypeError on the missing `.value` property (see flags).
*
* @param {Object} self - the `get_coins_by_period` widget instance; must expose
*   `self.ipo` (Array) and `self.value` (Array)
* @returns {Promise<HTMLElement>} content_data div wrapping the rendered list
*/
const get_content_data_edit = async function(self) {

	const fragment = new DocumentFragment()

	// values container
		const values_container = ui.create_dom_element({
			element_type	: 'ul',
			class_name		: 'values_container',
			parent			: fragment
		})

	// values
		const ipo			= self.ipo
		const ipo_length	= ipo.length

		// Each IPO entry produces a set of <li> rows — one per period term.
		// self.value items are filtered by `key === i` to isolate the output
		// slot that belongs to this IPO entry before passing to get_value_element.
		for (let i = 0; i < ipo_length; i++) {
			const data = self.value.filter(item => item.key === i)
			get_value_element(i, data , values_container, self)
		}

	// content_data
		const content_data = ui.create_dom_element({
			element_type : 'div'
		})
		content_data.appendChild(fragment)


	return content_data
}//end get_content_data_edit



/**
* GET_VALUE_ELEMENT
* Renders one `<li>` row per period term for a single IPO entry.
*
* Reads the `period` output slot from the `data` array (the item whose
* `widget_id === 'period'`), then iterates its ordered value Object with
* `Object.entries()`. For each chronological period term a pair of `<span>`
* elements is appended directly into `values_container`:
*
*   `.label` — localised name of the period term (e.g. "Roman", "s.I to s.II",
*              or "?" for coins that could not be matched to any term)
*   `.value` — coin count for that period term
*
* (!) The function creates a `DocumentFragment` internally but appends `<li>`
* nodes directly to `values_container`, NOT to the fragment. The returned
* `fragment` is always empty. The fragment is therefore unused; the real
* side-effect is the mutation of `values_container`. This should not be
* changed by callers who rely on the `values_container` side-effect.
* See flags for details.
*
* (!) If `data` contains no item with `widget_id === 'period'` (e.g. when
* `self.value` is empty because the source portal has no linked coins), the
* `.find()` call returns `undefined` and the `.value` property access will
* throw a TypeError. The caller (`get_content_data_edit`) does not guard
* against an empty `data` array. See flags.
*
* The `order` key from `Object.entries(value)` is iterated but not rendered
* into the DOM; it provides the insertion order of each period term as
* determined by the PHP backend traversal.
*
* @param {number} i - 0-based IPO index (not used in DOM construction, kept
*   for API parity with the sibling `get_archive_weights` render module)
* @param {Array} data - subset of `self.value` items for IPO key `i`;
*   must contain exactly one item with `widget_id === 'period'` whose
*   `value` is a plain Object mapping order keys to period term descriptors
* @param {HTMLElement} values_container - the `<ul>` node that receives the
*   new `<li>` elements as children (side-effect; the returned DocumentFragment
*   is always empty and can be ignored)
* @param {Object} self - the `get_coins_by_period` widget instance (unused
*   in this function body; kept for API parity with the sibling module)
* @returns {DocumentFragment} an always-empty DocumentFragment (the real
*   output is the side-effect on `values_container`)
*/
const get_value_element = (i, data, values_container, self) => {

const fragment = new DocumentFragment()

	// period
	// (!) `.find()` can return undefined if data is empty; `.value` access would throw.
	const value = data.find(item => item.widget_id === 'period').value

	// Iterate the ordered plain Object produced by PHP json_encode.
	// `order` is the numeric-string insertion key; `period` is the term descriptor.
	for (const [order, period] of Object.entries(value)) {

		// li
		const li = ui.create_dom_element({
			element_type	: 'li',
			class_name		: 'widget_item get_coins_by_period ',
			parent			: values_container
		})

		// label
		const period_label = ui.create_dom_element({
			element_type	: 'span',
			class_name		: 'label',
			text_content	: `${period.label}`,
			parent			: li
		})

		// value
		const period_count = ui.create_dom_element({
			element_type	: 'span',
			class_name		: 'value',
			text_content	: `${period.count}`,
			parent			: li
		})
	}

	return fragment
}//end get_value_element



// @license-end
