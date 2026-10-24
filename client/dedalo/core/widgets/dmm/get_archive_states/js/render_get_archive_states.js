// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_label, page_globals, SHOW_DEBUG, DEDALO_CORE_URL*/
/*eslint no-undef: "error"*/



// imports
	import {ui} from '../../../../common/js/ui.js'
	import {event_manager} from '../../../../common/js/event_manager.js'



/**
* RENDER_GET_ARCHIVE_STATES
* Client-side render module for the `get_archive_states` DMM widget.
*
* This widget displays aggregated boolean/radio-button state counts and
* percentages for a set of linked archive records. Two state dimensions are
* shown for each IPO entry:
*   - "closed"  — whether a record has been closed (affirmative/negative counts)
*   - "answer"  — whether a response has been provided (positive/negative counts)
*
* The PHP counterpart (`class.get_archive_states.php`) resolves the linked
* records via a source portal and produces 14 keyed output items per IPO
* entry (e.g. `closed_afirmative`, `closed_afirmative_percent`, …).
* This file consumes those items and renders them as read-only `<ul>/<li>`
* HTML panels.
*
* Exported prototype methods are mixed into `get_archive_states` instances
* via `get_archive_states.js`.
*
* Main export: `render_get_archive_states` (constructor, no instance state)
*/
export const render_get_archive_states = function() {

	return true
}//end render_get_archive_states



/**
* EDIT
* Render node for use in modes: edit, edit_in_list.
*
* Builds the full widget wrapper (or just the inner content when
* `render_level === 'content'`) by delegating data layout to
* `get_content_data_edit`.
*
* @param {Object} options - render options passed by widget_common.render()
* @param {string} options.render_level - 'content' returns only the inner
*   content node; any other value returns the full wrapper element
* @returns {Promise<HTMLElement>} wrapper element (or content_data when
*   render_level is 'content')
*/
render_get_archive_states.prototype.edit = async function(options) {

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
* Builds the scrollable list of IPO-entry panels.
*
* Iterates over every entry in `self.ipo` and delegates rendering of each
* entry's statistics row to `get_value_element`. The resulting `<li>` nodes
* are collected inside a `<ul class="values_container">` and wrapped in a
* plain `<div>` that becomes the widget's `content_data` node.
*
* Data contract (self.value):
*   An array of flat data-item objects produced by the PHP `get_data()` method,
*   keyed by `key` (IPO index, 0-based) and `widget_id` (one of the 14 output
*   slot names). Example item:
*   {
*     widget    : 'get_archive_states',
*     key       : 0,
*     widget_id : 'closed_afirmative',
*     closed_label : 'Closed',    // only present on 'closed_afirmative' items
*     answer_label : 'Answer',    // only present on 'closed_afirmative' items
*     value     : 12
*   }
*
* @param {Object} self - the `get_archive_states` widget instance
* @returns {Promise<HTMLElement>} content_data div containing the rendered list
*/
const get_content_data_edit = async function(self) {

	const fragment = new DocumentFragment()

	// values container
		const values_container = ui.create_dom_element({
			element_type	: 'ul',
			class_name 		: 'values_container',
			parent 			: fragment
		})

	// values
		const ipo 			= self.ipo
		const ipo_length 	= ipo.length

		// Each IPO entry produces one <li> row of statistics.
		// self.value items are filtered by `key === i` to select the 14 output
		// slots that belong to the current IPO entry.
		for (let i = 0; i < ipo_length; i++) {
			const data 		= self.value.filter(item => item.key === i)
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
* Renders one statistics row (`<li>`) for a single IPO entry.
*
* Extracts all 14 output slot values from `data` (filtered to the current IPO
* key) and builds two sub-panels inside the `<li>`:
*
*   1. `.closed`  — "closed" dimension: affirmative count, negative count, and
*      a summary "n of total" line, each with percentage in parentheses.
*      The human-readable dimension label (e.g. "Closed") is read from the
*      `closed_label` property on the `closed_afirmative` data item, which is
*      only populated on that slot by the PHP backend.
*
*   2. `.answer`  — "answer" dimension: positive count (labelled "pos:"),
*      negative count (labelled "neg:"), and a summary "n of total" line.
*      The dimension label comes from `answer_label` on the same item.
*
* Counts and percentages are only rendered when the respective raw count is
* truthy and > 0; otherwise the segment contributes an empty string to the
* joined display, keeping the " | " separator clean.
*
* Localised strings "yes", "no", and "of" are sourced from the global
* `get_label` object; each falls back to its English literal when the key is
* absent.
*
* Note: a real-time `event_manager` subscription block is present in the
* source but is commented out (see the commented block near the end of this
* function). Unlike its sibling widget `get_archive_states_weights`, this
* widget deliberately omits live updates because the source data and the
* display panel are never visible at the same time for the end user.
*
* @param {number} i - 0-based IPO index; used only to identify the row
*   (the data itself is already pre-filtered by the caller)
* @param {Array} data - subset of `self.value` items for IPO key `i`;
*   expected to contain exactly 14 objects, one per output slot
* @param {HTMLElement} values_container - the `<ul>` element that receives
*   the new `<li>` as a child
* @param {Object} self - the `get_archive_states` widget instance (held for
*   potential event subscription; not read directly in this function)
* @returns {HTMLElement} the constructed `<li>` node (also appended to
*   values_container as a side-effect)
*/
const get_value_element = (i, data, values_container, self) => {

	// Extract all 14 output slot values up front.
	// Array.find() is used rather than a keyed map to stay consistent with the
	// flat PHP output format; each slot is identified by `widget_id`.
	const closed_afirmative			= data.find(item => item.widget_id === 'closed_afirmative').value
	const closed_label 				= data.find(item => item.widget_id === 'closed_afirmative').closed_label
	const answer_label 				= data.find(item => item.widget_id === 'closed_afirmative').answer_label
	const closed_afirmative_percent	= data.find(item => item.widget_id === 'closed_afirmative_percent').value
	const closed_negative			= data.find(item => item.widget_id === 'closed_negative').value
	const closed_negative_percent	= data.find(item => item.widget_id === 'closed_negative_percent').value
	const closed_count				= data.find(item => item.widget_id === 'closed_count').value
	const closed_count_percent		= data.find(item => item.widget_id === 'closed_count_percent').value
	const closed_total				= data.find(item => item.widget_id === 'closed_total').value
	const answer_afirmative			= data.find(item => item.widget_id === 'answer_afirmative').value
	const answer_afirmative_percent	= data.find(item => item.widget_id === 'answer_afirmative_percent').value
	const answer_negative			= data.find(item => item.widget_id === 'answer_negative').value
	const answer_negative_percent	= data.find(item => item.widget_id === 'answer_negative_percent').value
	const answer_count				= data.find(item => item.widget_id === 'answer_count').value
	const answer_count_percent		= data.find(item => item.widget_id === 'answer_count_percent').value
	const answer_total				= data.find(item => item.widget_id === 'answer_total').value

	// Localised display labels with English fallbacks.
	const label_yes	= get_label.yes || 'yes'
	const label_no	= get_label.no || 'no'
	const label_of	= get_label.of || 'of'

	// li
		const li = ui.create_dom_element({
			element_type	: 'li',
			class_name		: 'widget_item get_archive_states',
			parent			: values_container
		})

	//closed
		const closed_node = ui.create_dom_element({
			element_type: 'div',
			class_name	: 'closed',
			parent 		: li
		})

		// label
		// (!) closed_label_node is intentionally not referenced after creation —
		// ui.create_dom_element appends it to closed_node as a side-effect.
		const closed_label_node = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'states_label closed_label',
			text_content	: closed_label + ':',
			parent			: closed_node
		})
			// closed_text
			// Build each segment conditionally; empty strings are excluded from the
			// joined display so the " | " separator only appears between present values.
			const closed_text =[]
			const closed_afirmative_text = closed_afirmative && closed_afirmative > 0
				? `${label_yes}: ${closed_afirmative} (${closed_afirmative_percent}%)`
				: ''

			const closed_negative_text = closed_negative && closed_negative > 0
				? `${label_no}: ${closed_negative} (${closed_negative_percent}%)`
				: ''

			// "n: <responded> of <total> (<percent>%)" summary segment
			const closed_total_text = closed_count && closed_count > 0
				? `n: ${closed_count} ${label_of} ${closed_total} (${closed_count_percent}%)`
				: ''
			closed_text.push(closed_afirmative_text)
			closed_text.push(closed_negative_text)
			closed_text.push(closed_total_text)

			// closed_text_node
			// (!) closed_text_node is intentionally not referenced after creation —
			// ui.create_dom_element appends it to closed_node as a side-effect.
				const closed_text_node = ui.create_dom_element({
					element_type: 'span',
					class_name	: 'text',
					inner_html 	: closed_text.join(' | ') ,
					parent 		: closed_node
				})

	//answer
		const answer_node = ui.create_dom_element({
			element_type: 'div',
			class_name	: 'answer',
			parent 		: li
		})

		// label
		// (!) answer_label_node is intentionally not referenced after creation —
		// ui.create_dom_element appends it to answer_node as a side-effect.
		const answer_label_node = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'states_label answer_label',
			text_content	: answer_label + ':',
			parent			: answer_node
		})
			// answer_text
			// "pos:" / "neg:" labels are intentionally not localised here; they are
			// short technical tokens rather than user-facing words.
			const answer_text =[]
			const answer_afirmative_text = answer_afirmative && answer_afirmative > 0
				? `pos: ${answer_afirmative} (${answer_afirmative_percent}%)`
				: ''

			const answer_negative_text = answer_negative && answer_negative > 0
				? `neg: ${answer_negative} (${answer_negative_percent}%)`
				: ''

			const answer_total_text = answer_count && answer_count > 0
				? `n: ${answer_count} ${label_of} ${answer_total} (${answer_count_percent}%)`
				: ''
			answer_text.push(answer_afirmative_text)
			answer_text.push(answer_negative_text)
			answer_text.push(answer_total_text)

			// answer_text_node
			// (!) answer_text_node is intentionally not referenced after creation —
			// ui.create_dom_element appends it to answer_node as a side-effect.
				const answer_text_node = ui.create_dom_element({
					element_type: 'span',
					class_name	: 'text',
					inner_html 	: answer_text.join(' | ') ,
					parent 		: answer_node
				})




		// event_manager subscription — deliberately omitted for this widget.
		// The live-update pattern via event_manager is used in sibling widgets (e.g.
		// get_archive_states_weights) when the data source and the display panel
		// coexist in the same section view. Here they do not: the user never sees the
		// input components and the summary panel at the same time, so a subscription
		// would never fire in practice.
		//
		// (!) The commented-out fn_update_widget_value body below was copied from
		// get_archive_states_weights and references weight/diameter fields that do not
		// exist in this widget's value schema. It should be removed once confirmed
		// that live-update support is not planned for this widget.
		// self.events_tokens.push(
		// 	event_manager.subscribe('update_widget_value_'+i+'_'+self.id, fn_update_widget_value)
		// )
		// function fn_update_widget_value(changed_data) {

		// 	media_weight_value.innerHTML	= changed_data.find(item => item.id==='media_weight').value
		// 	max_weight_value.innerHTML		= changed_data.find(item => item.id==='max_weight').value
		// 	min_weight_value.innerHTML		= changed_data.find(item => item.id==='min_weight').value
		// 	total_weight_value.innerHTML	= changed_data.find(item => item.id==='total_elements_weights').value

		// 	media_diameter_value.innerHTML	= changed_data.find(item => item.id==='media_diameter').value
		// 	max_diameter_value.innerHTML	= changed_data.find(item => item.id==='max_diameter').value
		// 	min_diameter_value.innerHTML	= changed_data.find(item => item.id==='min_diameter').value
		// 	total_diameter_value.innerHTML	= changed_data.find(item => item.id==='total_elements_diameter').value

		// 	return true
		// }


	return li
}//end get_value_element



// @license-end
