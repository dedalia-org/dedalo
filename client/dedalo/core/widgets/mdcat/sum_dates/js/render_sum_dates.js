// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_label, page_globals, SHOW_DEBUG, DEDALO_CORE_URL*/
/*eslint no-undef: "error"*/



// imports
	import {ui} from '../../../../common/js/ui.js'
	import {event_manager} from '../../../../common/js/event_manager.js'



/**
* RENDER_SUM_DATES
* Client-side renderer for the `sum_dates` widget (mdcat package).
*
* The `sum_dates` widget accumulates date intervals across a set of linked records
* sourced through a portal component. The server-side `class.sum_dates.php`
* iterates every record in the portal, computes the DateInterval between a
* `date_in` and `date_out` component for each record, sums all intervals, and
* separates real intervals from estimated ones. This module consumes that resolved
* data to build the display DOM.
*
* Expected shape of `self.value` (array of objects, one entry per widget_id per
* IPO group, as returned by class.sum_dates::get_data()):
*   [
*     { widget: 'sum_dates', key: 0, widget_id: 'sum_intervals',
*       value: { y: 2, m: 3, d: 15, h: 0, i: 0, s: 0 } },
*     { widget: 'sum_dates', key: 0, widget_id: 'sum_estitmated_time_add',
*       value: { y: 0, m: 0, d: 1, h: 0, i: 0, s: 0 } },
*     { widget: 'sum_dates', key: 0, widget_id: 'estitmated_time_undefined',
*       value: true }
*   ]
*
* The `value` field for `sum_intervals` and `sum_estitmated_time_add` mirrors a
* PHP DateInterval object: keys are `y` (years), `m` (months), `d` (days), `h`,
* `i`, `s`. Only `y`, `m`, and `d` are rendered.
*
* Expected shape of `self.ipo` (mirrors the server-side IPO ontology config —
* each entry maps one portal+date pair to a set of output widget_ids):
*   [
*     {
*       input: [
*         { type: 'source',   section_tipo: 'mdcat1', component_tipo: 'mdcat1' },
*         { type: 'date_in',  section_tipo: 'mdcat2', component_tipo: 'mdcat2' },
*         { type: 'date_out', section_tipo: 'mdcat3', component_tipo: 'mdcat3' }
*       ],
*       output: [
*         { id: 'sum_intervals' },
*         { id: 'sum_estitmated_time_add' },
*         { id: 'estitmated_time_undefined' }
*       ]
*     }
*   ]
*
* The render result is a `<ul class="values_container">` holding one `<li>` per
* IPO group. Each `<li>` contains:
*   - A `<div class="sum_intervals">` with the total computed time span.
*   - Optionally, a `<span class="sum_dates_period_notes">` with estimated and/or
*     indeterminate additions, shown in Catalan ("Temps estimat afegit:").
*
* NOTE: The estimated-time suffix label is hardcoded in Catalan
* ("Temps estimat afegit:", "indeterminat"). A future i18n pass should replace
* these literals with `get_label` calls.
*
* NOTE: The `event_manager` import and commented-out subscription block in
* `get_value_element` are intentionally kept for a planned reactive update
* feature (see inline comment at the commented-out block).
*
* Exports:
*   - `render_sum_dates` constructor, wired to `sum_dates.prototype.edit`
*     via a prototype alias in sum_dates.js.
*/



/**
* RENDER_SUM_DATES
* Manages the component's logic and appearance in client side
*/
export const render_sum_dates = function() {

	return true
}//end render_sum_dates



/**
* EDIT
* Render node for use in modes: edit, edit_in_list
*
* Builds the full widget DOM for the sum_dates widget in edit (display) mode.
* When `options.render_level` is `'content'`, only the inner content_data node
* is returned (used when embedding this widget inside a parent container that
* already supplies its own wrapper). Otherwise, a full `ui.widget.build_wrapper_edit`
* wrapper is returned with content_data slotted in.
*
* @param {Object} options - Render options passed by widget_common.prototype.render.
* @param {string} [options.render_level] - If `'content'`, skip wrapper creation and
*   return the raw content_data node directly.
* @returns {Promise<HTMLElement>} Resolves to either the full wrapper element or the
*   content_data node (when render_level is 'content').
*/
render_sum_dates.prototype.edit = async function(options) {

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
* Build the inner content DOM for the sum_dates widget.
*
* Iterates `self.ipo` (the IPO configuration array from the ontology) to produce
* one `<li>` element per IPO group. For each group, server value items from
* `self.value` are filtered by the group index (`key === i`) and forwarded to
* `get_value_element` for DOM construction.
*
* The returned `content_data` `<div>` wraps a `<ul class="values_container">`
* whose children are the individual interval display rows.
*
* @param {Object} self - The sum_dates widget instance. Expected properties:
*   - `self.ipo`   {Array}  IPO configuration groups from the ontology.
*   - `self.value` {Array}  Resolved data items from the server
*                           ({ key, widget_id, value, … }).
* @returns {Promise<HTMLElement>} Resolves to the `<div>` content_data node
*   containing the rendered interval rows.
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
* Build a single `<li>` row representing one IPO group's computed date interval
* and append it to `values_container`.
*
* The function extracts three data items from `data` (the filtered server values
* for IPO group `i`) by their `widget_id`:
*   - `sum_intervals`           — total summed DateInterval object {y,m,d,…}
*   - `sum_estitmated_time_add` — additional estimated interval when a date was
*                                  missing and a 1-day default was injected by the
*                                  server (object or null)
*   - `estitmated_time_undefined` — boolean flag: true when an intermediate gap
*                                   between records could not be precisely measured
*
* Rendering logic:
*   1. The total interval (`sum_intervals`) is formatted as a space-joined string
*      of non-zero y/m/d parts. Singular/plural forms are selected via `get_label`
*      (e.g. `get_label.years` vs `get_label.year`). Zero-value parts are omitted.
*   2. If there is any estimated time addition OR the undefined flag is true, a
*      `<span class="sum_dates_period_notes">` is appended showing:
*        "( Temps estimat afegit: [estimated time] [+ indeterminat] )"
*      — both the label prefix and "indeterminat" are currently hardcoded in
*      Catalan (see module-level NOTE about i18n).
*
* (!) `data.find(item => item.widget_id === 'sum_estitmated_time_add').value`
* falls back to `null` when the find returns undefined. The subsequent property
* accesses on `sum_estitmated_time_add` (`.y`, `.m`, `.d`) are guarded by
* truthiness checks (`sum_estitmated_time_add.y > 0`). However, when the server
* returns `null` for this field (no estimated time), those checks safely return
* false because `null > 0` is false in JS. If the server omits the item entirely,
* `find` returns `undefined` and `.value` would throw — the `|| null` default
* guards against this only if the item exists with an undefined value. A missing
* item would still throw; no defensive guard is present.
*
* (!) The event_manager subscription block at the end of this function is fully
* commented out. It was a planned reactive-update feature (updating the displayed
* interval when an upstream component in the same section changes) that was not
* implemented because the widget's source data comes from a different section than
* the one the user is currently editing — so the live-update channel never fires
* in practice. The commented code (lines ~192–211) is left intentionally for
* future reference; do not remove it.
*
* @param {number}      i                - IPO group index (zero-based); used to
*                                         label the event channel if activated.
* @param {Array}       data             - Server value items for this IPO group;
*                                         each element is { widget, key, widget_id,
*                                         value }.
* @param {HTMLElement} values_container - The `<ul>` node to append the new `<li>` to.
* @param {Object}      self             - The sum_dates widget instance.
* @returns {HTMLElement} The constructed `<li>` element.
*/
const get_value_element = (i, data, values_container, self) => {

	// li
		const li = ui.create_dom_element({
			element_type	: 'li',
			class_name		: 'widget_item sum_dates',
			parent			: values_container
		})

	const sum_intervals				= data.find(item => item.widget_id === 'sum_intervals').value || {}
	const sum_estitmated_time_add	= data.find(item => item.widget_id === 'sum_estitmated_time_add').value || null
	const estitmated_time_undefined	= data.find(item => item.widget_id === 'estitmated_time_undefined').value || null

	// get the text of the sum_interval
	const ar_sum_intervals =[]

		if( sum_intervals.y > 0 ){
			const year_label = (sum_intervals.y > 1)
				? get_label.years
				: get_label.year
			const year_text = `${sum_intervals.y} ${year_label}`
			ar_sum_intervals.push(year_text)
		}
		if( sum_intervals.m > 0 ){
			const month_label = (sum_intervals.m > 1)
				? get_label.months
				: get_label.month
			const month_text = `${sum_intervals.m} ${month_label}`
			ar_sum_intervals.push(month_text)
		}
		if( sum_intervals.d > 0){
			const day_label = (sum_intervals.d > 1)
				? get_label.days
				: get_label.day
			const day_text = `${sum_intervals.d} ${day_label}`
			ar_sum_intervals.push(day_text)
		}

	// format estimated-time-add interval as text parts
	// (!) sum_estitmated_time_add is null when no estimation was needed. The
	// property accesses below (.y, .m, .d) are safe because `null > 0` evaluates
	// to false in JS, so the branches are simply skipped. If the server omits
	// the item entirely (find returns undefined), `.value` above would throw
	// before reaching this block — the `|| null` default only guards against an
	// item whose value property is undefined/falsy, not a missing array item.
	const ar_sum_estitmated_time_add =[]

		if( sum_estitmated_time_add.y > 0 ){
			const estimated_year_label = (sum_estitmated_time_add.y > 1)
				? get_label.years
				: get_label.year
			const estimated_year_text = `${sum_estitmated_time_add.y} ${estimated_year_label}`
			ar_sum_estitmated_time_add.push(estimated_year_text)
		}
		if( sum_estitmated_time_add.m > 0 ){
			const estimated_month_label = (sum_estitmated_time_add.m > 1)
				? get_label.months
				: get_label.month
			const estimated_month_text = `${sum_estitmated_time_add.m} ${estimated_month_label}`
			ar_sum_estitmated_time_add.push(estimated_month_text)
		}
		if( sum_estitmated_time_add.d > 0 ){
			const estimated_day_label = (sum_estitmated_time_add.d > 1)
				? get_label.days
				: get_label.day
			const estimated_day_text = `${sum_estitmated_time_add.d} ${estimated_day_label}`
			ar_sum_estitmated_time_add.push(estimated_day_text)
		}

	// render total interval
	// Always rendered even when ar_sum_intervals is empty (all parts are zero),
	// resulting in an empty <div>. No guard is needed because a zero-length
	// interval is a valid server response (no records in the portal).
		const sum_intervals_node = ui.create_dom_element({
			element_type: 'div',
			class_name	: 'sum_intervals',
			text_content	: ar_sum_intervals.join(' '),
			parent 		: li
		})

		// render period notes (estimated / indeterminate)
		// Only appended when at least one estimated interval was injected OR an
		// indeterminate gap was detected — avoids showing an empty footnote.
		if( ar_sum_estitmated_time_add.length > 0 || estitmated_time_undefined === true){

			// (!) These string literals are hardcoded in Catalan. A future i18n pass
			// should replace them with get_label calls once corresponding label keys
			// are defined in the ontology.
			const ar_indeterminate = ['( Temps estimat afegit:'];

			if( ar_sum_estitmated_time_add.length  > 0 ){
				 ar_indeterminate.push( ar_sum_estitmated_time_add.join(' ') )
			}
			if( estitmated_time_undefined === true ){

				if( ar_sum_estitmated_time_add.length  > 0 ){
					  ar_indeterminate.push( ' + ' )
				}
				 ar_indeterminate.push( 'indeterminat' )
			}

			 ar_indeterminate.push( ')' )

			const sum_estitmated_time_add_node = ui.create_dom_element({
				element_type: 'span',
				class_name	: 'sum_dates_period_notes',
				text_content	: ar_indeterminate.join(' '),
				parent 		: li
			})

		}



		// event_manager subscription — intentionally disabled
		// This widget does not use live event updates because the computed value
		// lives in a different section from the input components the user edits.
		// The two are never visible simultaneously, so the update channel never
		// fires in practice. The code below is kept for reference; do not remove.
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
