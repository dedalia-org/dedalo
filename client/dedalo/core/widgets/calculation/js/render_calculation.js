// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_label, page_globals, SHOW_DEBUG, DEDALO_CORE_URL*/
/*eslint no-undef: "error"*/



// imports
	import {ui} from '../../../common/js/ui.js'
	import {event_manager} from '../../../common/js/event_manager.js'



/**
* RENDER_CALCULATION
* Client-side renderer for the `calculation` widget.
*
* The calculation widget renders read-only, computed values derived from one or
* more component fields through a server-side IPO (Input–Process–Output) pipeline
* (see class.calculation.php). The server resolves component values, optionally
* runs a PHP processing function, and returns a flat array of `{widget, key, id,
* value}` data items. This module consumes that resolved data to build the
* display DOM.
*
* Expected data shape on `self.value` (array populated by the server):
*   [
*     { widget: 'calculation', key: 0, id: 'total', value: '1,234.56' },
*     ...
*   ]
*
* Expected shape of `self.ipo` (mirrors the server-side IPO ontology config):
*   [
*     {
*       output: [
*         {
*           id: 'total',                    // widget_id matched against self.value
*           format: 'date'|undefined,       // optional: triggers date formatting
*           label_before: 'Total',          // displayed before the value (optional)
*           label_before_singular: '...',   // used when value === 1 (optional)
*           label_after: 'euros',           // displayed after the value (optional)
*           label_after_singular: '...',    // used when value === 1 (optional)
*           separator: ', '                 // appended after label_after (optional)
*         }
*       ]
*     }
*   ]
*
* For date-formatted values, `server_value` must be an object of the shape:
*   { day: number|null, month: number|null, year: number|null }
*
* Live updates are delivered via the `event_manager` event
* `update_widget_value_<i>_<self.id>`, fired when a component that feeds this
* calculation changes value in the same page session.
*
* Exports:
*   - `render_calculation` constructor (wired to calculation.prototype via
*     prototype alias in calculation.js)
*/



/**
* RENDER_CALCULATION
* Client-side render constructor for the calculation widget.
*
* This constructor serves as a mixin container: its prototype methods
* (`edit`, `list`) are mixed into `calculation.prototype` by calculation.js.
* The constructor itself is a no-op stub — instantiation is handled by
* widget_common.prototype.init.
*
* @returns {boolean} Always returns true.
*/
export const render_calculation = function() {

	return true
}//end render_calculation


/**
* EDIT
* Build and return the edit-mode DOM wrapper for the calculation widget.
*
* Delegates inner content construction to `get_content_data_edit`. When
* `options.render_level === 'content'` the inner `<div>` is returned
* directly (used by embedded/portal callers that manage their own wrapper).
* Otherwise `ui.widget.build_wrapper_edit` wraps the content in the standard
* widget shell and the full wrapper is returned.
*
* (!) The `add_events` call is currently commented out. This is intentional —
* event subscription for live updates is handled inside `get_value_element`
* via `event_manager.subscribe`, not here.
*
* @param {Object} options - Render options bag.
* @param {string} [options.render_level='full'] - 'full' returns the outer wrapper;
*   'content' returns only the inner content_data node.
* @returns {Promise<HTMLElement>} Resolves to the widget wrapper (full mode) or
*   the content_data div (content mode).
*/
render_calculation.prototype.edit = async function(options) {

	const self = this

	// render_level
		const render_level = options.render_level || 'full'

	// content_data
		const content_data = await get_content_data_edit(self)
		if (render_level==='content') {
			return content_data
		}

	// wrapper. ui build_edit returns widget wrapper
		const wrapper = ui.widget.build_wrapper_edit(self, {
			content_data : content_data
		})

	// events
		// add_events(self, wrapper)

	return wrapper
}//end edit



/**
* LIST
* Render the calculation widget for list (grid/table) mode.
*
* Aliased directly to `edit` because the calculation widget's output is
* read-only in both modes. The same DOM structure and event wiring applies.
*
* @returns {Promise<HTMLElement>} See `render_calculation.prototype.edit`.
*/
render_calculation.prototype.list = render_calculation.prototype.edit



/**
* GET_CONTENT_DATA_EDIT
* Build the inner content DOM for the calculation widget.
*
* Iterates `self.ipo` (the server-side IPO configuration array) to produce one
* `<li>` element per IPO entry. For each entry, server values are matched by
* index (`key`) from `self.value` and forwarded to `get_value_element` for
* DOM construction.
*
* The returned `content_data` `<div>` wraps a `<ul class="values_container">`
* whose children are the rendered `<li>` items for each IPO group.
*
* @param {Object} self - The calculation widget instance. Expected properties:
*   - `self.ipo`   {Array}  IPO configuration groups from the ontology.
*   - `self.value` {Array}  Resolved data items from the server
*                           ({ key, widget_id, value, … }).
*   - `self.mode`  {string} Current render mode (e.g. 'edit', 'list').
* @returns {Promise<HTMLElement>} Resolves to the `<div>` content_data node.
*/
const get_content_data_edit = async function(self) {

	// sort vars
		const mode = self.mode

	const fragment = new DocumentFragment()

	// values_container
		const values_container = ui.create_dom_element({
			element_type	: 'ul',
			class_name 		: 'values_container',
			parent 			: fragment
		})

	// values
		const ipo 			= self.ipo
		const ipo_length 	= ipo.length

		for (let i = 0; i < ipo_length; i++) {
			const data = self.value.filter(item => item.key === i)
			get_value_element(i, data, values_container, self)
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
* Build a single `<li>` element representing one IPO output group and attach a
* live-update event subscription for reactive DOM updates.
*
* For each output descriptor in `ipo[i].output` the function:
*   1. Finds the matching server value in `data` by `widget_id === data_map.id`.
*   2. Applies date formatting when `data_map.format === 'date'`, producing a
*      `day/month/year` string from the `{day, month, year}` server value object.
*      Only present parts are included — a value with only a year renders as `YYYY`.
*   3. Selects singular/plural label variants: when `value == 1` the keys
*      `label_before_singular` and `label_after_singular` are tried; otherwise
*      `label_before` and `label_after` are used. Missing keys produce empty strings.
*   4. Labels are looked up through `get_label` (the i18n map). If no key is
*      found there, the raw ontology string is used verbatim.
*   5. Subscribes to `update_widget_value_<i>_<self.id>` so that when the
*      upstream components change (e.g. the user edits a field in the same section),
*      the rendered label/value/separator DOM nodes update in place without a full
*      re-render.
*
* (!) The event subscription token is pushed to `self.events_tokens`. The caller
* (widget_common.prototype.destroy) iterates that array and unsubscribes all
* tokens on widget teardown — callers must not skip the destroy lifecycle.
*
* (!) The commented-out `Date`/`toLocaleString` implementation (lines 131–133)
* was replaced by the manual array-join approach below it. The commented block
* is left in place; do not remove it without a separate decision.
*
* @param {number}      i                - IPO group index (used as the `key` filter
*                                         and as part of the event channel name).
* @param {Array}       data             - Server value items for this IPO group;
*                                         each element has at minimum `widget_id`
*                                         and `value` properties.
* @param {HTMLElement} inputs_container - The `<ul>` node to append the new `<li>` to.
* @param {Object}      self             - The calculation widget instance.
* @returns {HTMLElement} The constructed `<li>` element.
*/
const get_value_element = (i, data, inputs_container, self) => {

	const output = self.ipo[i].output

	// li
		const li = ui.create_dom_element({
			element_type	: 'li',
			class_name		: 'widget_item calculation',
			parent			: inputs_container
		})

	for (let j = 0; j < output.length; j++) {

		const data_map = output[j]
		const current_data = data.find(el => el.widget_id===data_map.id)

		// server_value is null when no matching data item exists for this output descriptor.
		// This happens when the server IPO process produced no result for the given output id
		// (e.g. the input component has no data yet, or the processing function returned nothing).
		const server_value = (typeof current_data!=='undefined')
			? current_data.value
			: null

		// get_date_string formats a structured {day, month, year} server value as "day/month/year".
		// Parts are included only when truthy, so sparse dates (e.g. year-only) render correctly.
		const get_date_string = ()=>{

			if(server_value){

				// const date		= new Date(server_value.year, server_value.month -1, server_value.day);
				// const locale	= page_globals.locale
				// const result	= date.toLocaleString(locale, {year:"numeric",month:"numeric",day:"numeric"});

				const ar_date = []
				if(server_value.day){
					ar_date.push(server_value.day)
				}
				if(server_value.month){
					ar_date.push(server_value.month)
				}
				if(server_value.year){
					ar_date.push(server_value.year)
				}
				const result = ar_date.join('/')
				return result
			}
		}

		// Apply date formatting when the output descriptor specifies format:'date';
		// otherwise the server value (string, number, etc.) is used as-is.
		const value = (data_map.format && data_map.format === 'date')
			? get_date_string()
			: server_value

		// Singular label variant: when value equals exactly 1 (loose equality to
		// handle numeric strings), append '_singular' to probe label_before/label_after keys.
		const label_suffix = Number(value)===1 ? '_singular' : ''

		// label before
			const current_label_before = (value && data_map['label_before'+label_suffix])
				? data_map['label_before'+label_suffix]
				: ''
			const label_before = ui.create_dom_element({
				element_type	: "label",
				class_name		: 'before',
				inner_html		: get_label[current_label_before] || current_label_before,
				parent			: li
			})

		// value
			const element_value = ui.create_dom_element({
				element_type	: "span",
				class_name		: 'value',
				inner_html		: value,
				parent			: li
			})

		// label after
			const current_label_after = (value && data_map['label_after'+label_suffix])
				? data_map['label_after'+label_suffix]
				: ''
			const separator = (value && data_map['separator'])
				? data_map['separator']
				: ''
			const label_after =  ui.create_dom_element({
				element_type	: "label",
				class_name		: 'after',
				text_content	: ' '+(get_label[current_label_after] || current_label_after) + separator,
				parent			: li
			})

		// event update_widget_value
		// Fired by the calculation widget instance when any upstream component changes.
		// `changed_data` has the same shape as `self.value` (flat array of {widget_id, value}).
		// When the changed set contains no entry for this output descriptor, all three DOM
		// nodes are cleared to reflect the absence of a value.
			const update_widget_value_handler = (changed_data) => {

				const current_data = changed_data.find(el => el.widget_id===data_map.id)

				if(typeof current_data==='undefined'){
					element_value.innerHTML = ''
					label_before.textContent = ''
					label_after.textContent = ''
					return
				}
				const value = current_data.value
				element_value.innerHTML = value

				// labels
				const label_suffix = Number(value)===1 ? '_singular' : ''

				// label before
				const current_label_before = (value && data_map['label_before'+label_suffix])
					? data_map['label_before'+label_suffix]
					: ''
				label_before.textContent = get_label[current_label_before] || current_label_before

				// label after
				const current_label_after = (value && data_map['label_after'+label_suffix])
					? data_map['label_after'+label_suffix]
					: ''
				const separator = (value && data_map['separator'])
					? data_map['separator']
					: ''
				label_after.textContent = (get_label[current_label_after] || current_label_after) + separator
			}
			self.events_tokens.push(
				event_manager.subscribe('update_widget_value_'+i+'_'+self.id, update_widget_value_handler)
			)
	}//end for loop


	return li
}//end get_value_element



// @license-end
