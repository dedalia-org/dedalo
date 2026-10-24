// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_label, page_globals, SHOW_DEBUG, DEDALO_CORE_URL*/
/*eslint no-undef: "error"*/



// imports
	import {ui} from '../../../../common/js/ui.js'
	import {event_manager} from '../../../../common/js/event_manager.js'



/**
* RENDER_TAGS
* Client-side renderer for the `tags` widget (oh/tags).
*
* The `tags` widget displays read-only statistics computed by the PHP
* `class.tags` server-side counterpart. It parses a `component_text_area`
* transcription and counts:
*   - Time-code (TC) tags
*   - Index tags (unique in/out pairs)
*   - Missing/broken tags (blue / deleted)
*   - Tags marked for review (red)
*   - Private and public note annotations
*   - Character metrics (total chars, chars without spaces, real UTF-8 length)
*
* Architecture:
*   - `tags.js` assigns `render_tags.prototype.edit` to both `edit` and `list`
*     modes, so the same DOM is used in all contexts.
*   - The widget receives its computed values as `self.value` (an array of
*     server-side data objects, one per IPO output slot) and its IPO
*     configuration as `self.ipo`.
*   - Values are reactive: the PHP worker can emit
*     `update_widget_value_<ipo_index>_<widget_id>` events via `event_manager`
*     to refresh displayed values without a full re-render.
*
* Data shape of each item in `self.value`:
* ```json
* {
*   "widget"    : "tags",
*   "key"       : 0,
*   "widget_id" : "total_tc",
*   "value"     : 24
* }
* ```
*
* Exports: `render_tags` (constructor, assigned to `tags.prototype` methods
* in tags.js).
*/
export const render_tags= function() {

	return true
}//end render_tags



/**
* EDIT
* Render node for use in modes: edit, edit_in_list.
*
* Builds the full widget wrapper (including the outer chrome produced by
* `ui.widget.build_wrapper_edit`) or, when `options.render_level === 'content'`,
* returns only the inner content node (used when the caller wants to inject
* the content into its own container without the standard wrapper).
*
* @param {Object} options - Render options passed by `widget_common.render`.
* @param {string} options.render_level - Rendering depth; `'content'` skips
*   the outer wrapper and returns only the content node.
* @returns {Promise<HTMLElement>} The wrapper element (or content node when
*   render_level is 'content').
*/
render_tags.prototype.edit = async function(options) {

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
* Build the inner content node for the tags widget.
*
* Iterates over the IPO array (`self.ipo`) — one entry per configured
* transcription source — and delegates to `get_value_element` to build a
* `<li>` row of statistics for each IPO slot. All rows are collected inside
* a `<ul class="values_container">` and wrapped in a plain `<div>` that
* becomes the `content_data` node injected into the widget wrapper.
*
* Side effect: subscribes event listeners (via `get_value_element`) to
* `update_widget_value_<i>_<self.id>` for each IPO slot so the displayed
* values can be refreshed without a full re-render.
*
* (!) `self.value.lenght` — note the typo on the guard condition ('lenght'
* instead of 'length'); the check always evaluates as `undefined < 1` which
* is falsy, so the warning fires whenever `self.value` is falsy but NOT when
* the array is genuinely empty. Do not fix this silently — it is a pre-existing
* bug in the guard expression.
*
* @param {Object} self - The `tags` widget instance.
* @param {Array}  self.value - Array of server-computed data objects
*   (one per IPO output slot).
* @param {Array}  self.ipo   - IPO configuration array from the ontology.
* @returns {Promise<HTMLElement>} A `<div>` containing the `<ul>` statistics list.
*/
const get_content_data_edit = async function(self) {

	if (!self.value || self.value.length<1) {
		console.warn("tags get_content_data_edit. Value is empty!", self);
	}

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

		// One <li> row per IPO slot; data is the subset of self.value whose
		// 'key' property matches the current IPO index.
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
* Build one `<li>` statistics row for a single IPO slot.
*
* Creates a label/value pair node for every metric that the PHP `tags` widget
* computes and appends it to `values_container`. Each metric node is produced
* by `item_value_factory` and is also pushed into `reactive_items` so the
* event handler can update it efficiently.
*
* After building all metric nodes the function subscribes once to the
* `update_widget_value_<i>_<self.id>` event. When that event fires the handler
* walks `reactive_items` and rewrites each `.value.innerHTML` with the new
* value from `changed_data` (keyed by `widget_id`). The token is stored in
* `self.events_tokens` so the widget lifecycle (`destroy`) can unsubscribe.
*
* Metrics built (order matches the server-side IPO output map):
*   - `total_tc`              — number of time-code tags
*   - `total_index`           — unique in/out index-tag pairs
*   - `total_missing_tags`    — broken/deleted (blue) index tags
*   - `total_to_review_tags`  — red (to-review) index tags
*   - `total_private_notes`   — private (type-a) annotation tags
*   - `total_public_notes`    — public (type-b) annotation tags
*   - `total_chars`           — characters counted without HTML markup
*   - `total_chars_no_spaces` — same count excluding whitespace
*   - `total_real_chars`      — raw UTF-8 `mb_strlen` of the source string
*
* @param {number}      i                - IPO slot index (0-based).
* @param {Array}       data             - Subset of `self.value` where
*   `item.key === i`; each element is a server data object with `widget_id`
*   and `value` properties.
* @param {HTMLElement} values_container - The `<ul>` element to append the
*   new `<li>` to.
* @param {Object}      self             - The `tags` widget instance; used for
*   `self.id` (event channel suffix) and `self.events_tokens` (token store).
* @returns {HTMLElement} The newly created `<li>` element.
*/
const get_value_element = (i, data, values_container, self) => {

	// li, for every ipo will create a li node
		const li = ui.create_dom_element({
			element_type	: 'li',
			class_name		: 'widget_item tags',
			parent			: values_container
		})

	// reactive (Will be updated on every called event)
		const reactive_items = []

	// total_tc
		const total_tc = item_value_factory(
			'total_tc',
			'TC',
			data
		)
		li.appendChild(total_tc)
		reactive_items.push(total_tc)

	// total_index
		const total_index = item_value_factory(
			'total_index',
			'INDEX',
			data
		)
		li.appendChild(total_index)
		reactive_items.push(total_index)

	// total_missing_tags
		const total_missing_tags_node = item_value_factory(
			'total_missing_tags',
			(get_label.deleted_tags || 'Deleted tags'),
			data
		)
		li.appendChild(total_missing_tags_node)
		reactive_items.push(total_missing_tags_node)

	// total_to_review_tags
		const total_to_review_tags_node = item_value_factory(
			'total_to_review_tags',
			get_label.label_to_review || 'To review',
			data
		)
		li.appendChild(total_to_review_tags_node)
		reactive_items.push(total_to_review_tags_node)

	// total_private_notes
		const total_private_notes = item_value_factory(
			'total_private_notes',
			'Work NOTES',
			data
		)
		li.appendChild(total_private_notes)
		reactive_items.push(total_private_notes)

	// total_public_notes
		const total_public_notes = item_value_factory(
			'total_public_notes',
			'Public NOTES',
			data
		)
		li.appendChild(total_public_notes)
		reactive_items.push(total_public_notes)

	// total_chars
		const total_chars = item_value_factory(
			'total_chars',
			'CHARS',
			data
		)
		li.appendChild(total_chars)
		reactive_items.push(total_chars)

	// total_chars_no_spaces
		const total_chars_no_spaces = item_value_factory(
			'total_chars_no_spaces',
			'NO SPACES',
			data
		)
		li.appendChild(total_chars_no_spaces)
		reactive_items.push(total_chars_no_spaces)

	// total_real_chars
		const total_real_chars = item_value_factory(
			'total_real_chars',
			'CHARS REAL',
			data
		)
		li.appendChild(total_real_chars)
		reactive_items.push(total_real_chars)

	// update the values when the observable was changed
		const update_widget_value_handler = (changed_data) => {
			// Look up the new numeric/string value for a given widget_id in the
			// event payload; returns '' when no matching entry is found so the
			// DOM shows an empty cell rather than 'undefined'.
			function get_value_from_data(widget_id) {
				const found = changed_data.find(el => el.widget_id===widget_id)
				const value = found
					? found.value
					: ''
				return value;
			}

			// update reactive items value
			for (let i = 0; i < reactive_items.length; i++) {
				reactive_items[i].value.innerHTML = get_value_from_data(reactive_items[i].widget_id)
			}
		}
		// Event channel: 'update_widget_value_<ipo_index>_<widget_instance_id>'
		// The PHP worker publishes on this channel after recomputing tag stats.
		self.events_tokens.push(
			event_manager.subscribe('update_widget_value_'+i+'_'+self.id, update_widget_value_handler)
		)


	return li
}//end get_value_element



/**
* ITEM_VALUE_FACTORY
* Build a labelled metric node (wrapper > label + value spans) for a single
* statistic field.
*
* The returned element exposes two extra properties so callers can update the
* displayed value without querying the DOM:
*   - `wrapper.value`     {HTMLElement} — the `<span class="value">` node;
*     set `.innerHTML` to refresh the displayed count.
*   - `wrapper.widget_id` {string}      — the metric identifier; used by
*     `update_widget_value_handler` to locate the right node in `reactive_items`.
*
* Zero values are rendered as the string `'0'` because the `text_content`
* receives `current_value + ''`; this prevents falsy 0 from being treated as
* an empty string by `ui.create_dom_element`.
*
* @param {string} widget_id - Metric key matching a server data object's
*   `widget_id` property (e.g. `'total_tc'`, `'total_real_chars'`).
* @param {string} label     - Human-readable label shown before the value
*   (e.g. `'TC'`, `'CHARS REAL'`). A colon is appended automatically.
* @param {Array}  data      - Array of server data objects for the current
*   IPO slot; each has shape `{widget_id, value, key, widget}`.
* @returns {HTMLElement} A `<div class="<widget_id>">` element with `.value`
*   and `.widget_id` properties attached for reactive updates.
*/
const item_value_factory = function(widget_id, label, data) {

	const wrapper = ui.create_dom_element({
		element_type	: 'div',
		class_name		: widget_id
	})

	// label
		ui.create_dom_element({
			element_type	: 'span',
			class_name		: 'label',
			text_content	: label + ':',
			parent			: wrapper
		})

	// value
		const found			= data.find(item => item.widget_id===widget_id)
		const current_value	= found
			? found.value
			: ''

		const value_node = ui.create_dom_element({
			element_type	: 'span',
			class_name		: 'value',
			text_content	: current_value+'', // prevent zero values hide
			parent			: wrapper
		})

	// wrapper add values and pointers
		wrapper.value		= value_node
		wrapper.widget_id	= widget_id


	return wrapper
}//end item_value_factory



// @license-end
