// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_label, page_globals, SHOW_DEBUG, DEDALO_CORE_URL*/
/*eslint no-undef: "error"*/



// imports
	import {ui} from '../../../../common/js/ui.js'
	import {event_manager} from '../../../../common/js/event_manager.js'



/**
* RENDER_GET_ARCHIVE_WEIGHTS
* Client-side render module for the `get_archive_weights` numisdata widget.
*
* This widget displays aggregated weight and diameter statistics computed from
* the set of qualifying numismatic records (coins) linked to the current
* section via a source portal. For each IPO entry the PHP backend
* (`class.get_archive_weights.php`) resolves the linked records, filters out
* unused and duplicated coins, and emits eight keyed output items:
*
*   Weight dimension:
*     media_weight            — mean weight across all qualifying coins (rounded to 2 dp)
*     max_weight              — maximum per-coin mean weight
*     min_weight              — minimum per-coin mean weight
*     total_elements_weights  — count of qualifying coins that had weight data
*
*   Diameter dimension:
*     media_diameter          — mean diameter across all qualifying coins (rounded to 2 dp)
*     max_diameter            — maximum per-coin mean diameter
*     min_diameter            — minimum per-coin mean diameter
*     total_elements_diameter — count of qualifying coins that had diameter data
*
* The eight items are delivered as a flat array on `self.value`; each element
* carries `{ widget, key, widget_id, value }` where `key` is the 0-based IPO
* index and `widget_id` matches one of the names above.
*
* In addition to the initial static render the widget subscribes to
* `update_widget_value_<key>_<id>` events via `event_manager` so that peer
* input widgets (e.g. a weight data-entry component on the same section page)
* can push live recalculations without a full page reload. The subscription
* token is pushed onto `self.events_tokens` so `widget_common.destroy()` can
* unsubscribe automatically.
*
* Note: the `event_manager` import is consumed inside `get_value_element`.
* The `page_globals`, `SHOW_DEBUG`, and `DEDALO_CORE_URL` globals are declared
* in the /*global*‌/ directive for ESLint but are not referenced in this file;
* they are available for future debug logging additions.
*
* Exported prototype methods are mixed into `get_archive_weights` instances
* by `get_archive_weights.js`.
*
* Main export: `render_get_archive_weights` (constructor, no instance state)
*/
export const render_get_archive_weights = function() {

	return true
}//end render_get_archive_weights



/**
* EDIT
* Render node for use in modes: edit, edit_in_list.
*
* Builds the full widget wrapper (or just the inner content node when
* `render_level === 'content'`) by delegating data layout to
* `get_content_data_edit`. When called with `render_level !== 'content'` the
* method wraps the content in a standard widget wrapper created by
* `ui.widget.build_wrapper_edit`.
*
* @param {Object} options - render options supplied by widget_common.render()
* @param {string} options.render_level - when 'content', only the inner
*   content_data element is returned; any other value returns the full wrapper
* @returns {Promise<HTMLElement>} wrapper element or content_data node
*/
render_get_archive_weights.prototype.edit = async function(options) {

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
* Builds the `<ul class="values_container">` list of IPO-entry rows.
*
* Iterates over every entry in `self.ipo` (one entry per configured source
* portal / measurement group). For each entry it filters `self.value` to the
* eight output items whose `key` matches the current IPO index, then delegates
* DOM construction and event subscription to `get_value_element`.
*
* Data contract (`self.value`):
*   A flat array of objects produced by PHP `get_archive_weights::get_data()`.
*   Each object has the shape:
*   {
*     widget    : 'get_archive_weights',   // string — widget class name
*     key       : 0,                       // number — 0-based IPO index
*     widget_id : 'media_weight',          // string — one of 8 slot names
*     value     : 12.45                    // number|null — computed aggregate
*   }
*   When the source portal has no linked records the PHP method returns [] and
*   `self.value` will be empty; `filter` will then yield [] for every IPO key
*   and `get_value_element` will render blank value spans.
*
* @param {Object} self - the `get_archive_weights` widget instance; must expose
*   `self.ipo` (Array), `self.value` (Array), `self.id` (string), and
*   `self.events_tokens` (Array) for use by the child call
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

		// Each IPO entry produces one <li> row.
		// self.value items are pre-filtered by `key === i` to isolate the 8 output
		// slots that belong to this IPO entry before passing them to get_value_element.
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
* Builds two side-by-side measurement sub-panels inside the `<li>`:
*
*   1. `.archive_weights` — weight dimension:
*        `.sum_weights`    — mean weight (`media_weight`) displayed prominently,
*                            labelled via the localised `get_label.weight` string.
*        `.weights_values` — detail range row: max | min | n (total count).
*
*   2. `.archive_diameter` — diameter dimension:
*        `.sum_diameter`   — mean diameter (`media_diameter`) displayed prominently,
*                            labelled via the localised `get_label.diameter` string.
*        `.diameter_values` — detail range row: max | min | n (total count).
*
* All eight output slot values are read via optional-chaining + nullish-coalescing
* (`?.value ?? ''`) from the `data` array, so missing or null server values
* render as empty strings rather than causing exceptions.
*
* After building the static DOM the function subscribes to the event channel
* `update_widget_value_<i>_<self.id>` using `event_manager`. When another widget
* or component on the same page publishes fresh aggregate data on that channel,
* `fn_update_widget_value` replaces the `textContent` of all eight value spans
* with the new values — avoiding HTML injection by using `textContent` instead
* of `innerHTML` (the calculation outputs are always numeric strings).
*
* The subscription token is appended to `self.events_tokens` so that
* `widget_common.destroy()` can cleanly unsubscribe when the widget is removed
* from the DOM. The comment above the subscription block explains why live
* updates are wired here even though they are architecturally unusual for this
* widget type: the input components that feed the recalculation are on a
* different section, so the user cannot edit and view at the same time; the
* subscription is kept as a future-proof pattern compatible with sibling widgets.
*
* @param {number} i - 0-based IPO index; used to scope the event channel name
* @param {Array} data - subset of `self.value` items for IPO key `i`;
*   expected to contain up to 8 objects, one per output slot; missing slots
*   render as empty strings
* @param {HTMLElement} values_container - the `<ul>` node that receives the
*   new `<li>` as a child (side-effect)
* @param {Object} self - the `get_archive_weights` widget instance; `self.id`
*   and `self.events_tokens` are consumed here
* @returns {HTMLElement} the constructed `<li>` node (also appended to
*   values_container as a side-effect)
*/
const get_value_element = (i, data, values_container, self) => {

	// li
		const li = ui.create_dom_element({
			element_type	: 'li',
			class_name		: 'widget_item get_archive_weights',
			parent			: values_container
		})

	// weight dimension panel — contains the mean/max/min/count rows for weight data
		const archive_weights = ui.create_dom_element({
			element_type: 'div',
			class_name	: 'archive_weights',
			parent 		: li
		})

		// general
		const sum_weights = ui.create_dom_element({
			element_type: 'div',
			class_name	: 'sum_weights',
			parent 		: archive_weights
		})
			//media_weight
				// label
				// (flag) media_weight_label is assigned but not referenced after creation;
				// the label text is rendered via inner_html at construction time and the
				// element reference is only needed if the text must later be updated.
				// The live-update handler (fn_update_widget_value) updates only the
				// *_value spans, so *_label references are intentionally dead here.
					const media_weight_label = ui.create_dom_element({
						element_type: 'span',
						class_name	: 'label',
						inner_html 	: get_label.weight + ': ' ,
						parent 		: sum_weights
					})

				// value — holds the mean weight string; updated live by fn_update_widget_value
					const media_weight_value = ui.create_dom_element({
						element_type: 'span',
						class_name	: 'value',
						text_content 	: data.find(item => item.widget_id === 'media_weight')?.value ?? '',
						parent 		: sum_weights
					})

		// detail range row: max | min | n (count of qualifying coins with weight data)
		const weights_values = ui.create_dom_element({
			element_type: 'span',
			class_name	: 'weights_values',
			parent 		: archive_weights
		})
			//max_weight
				// label
				// (flag) max_weight_label — assigned but not read after creation (same pattern as media_weight_label above)
				const max_weight_label = ui.create_dom_element({
					element_type: 'span',
					class_name	: 'label_range',
					inner_html 	: 'max: ',
					parent 		: weights_values
				})

				// value — holds the maximum per-coin mean weight
				const max_weight_value = ui.create_dom_element({
					element_type: 'span',
					class_name	: 'value',
					text_content 	: data.find(item => item.widget_id === 'max_weight')?.value ?? '',
					parent 		: weights_values
				})

			// min_weight
				// label
				// (flag) min_weight_label — assigned but not read after creation
				const min_weight_label = ui.create_dom_element({
					element_type: 'span',
					class_name	: 'label_range',
					inner_html 	: ' | min: ',
					parent 		: weights_values
				})

				// value — holds the minimum per-coin mean weight
				const min_weight_value = ui.create_dom_element({
					element_type: 'span',
					class_name	: 'value',
					text_content 	: data.find(item => item.widget_id === 'min_weight')?.value ?? '',
					parent 		: weights_values
				})

			// total_elements_weights — count of qualifying coins that provided weight data
				// label
				// (flag) total_weight_label — assigned but not read after creation
				const total_weight_label = ui.create_dom_element({
					element_type: 'span',
					class_name	: 'label',
					inner_html 	: ' | n: ',
					parent 		: weights_values
				})

				// value — holds the qualifying-coin count for the weight dimension
				const total_weight_value = ui.create_dom_element({
					element_type: 'span',
					class_name	: 'value',
					text_content 	: data.find(item => item.widget_id === 'total_elements_weights')?.value ?? '',
					parent 		: weights_values
				})


	// diameter dimension panel — parallel structure to the weight panel above
		const archive_diameter = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'archive_diameter',
			parent			: li
		})

		const sum_diameter = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'sum_diameter',
			parent			: archive_diameter
		})
		// media_diameter
			// label
			// (flag) media_diameter_label — assigned but not read after creation (same dead-reference pattern as weight labels above)
				const media_diameter_label = ui.create_dom_element({
					element_type: 'span',
					class_name	: 'label',
					inner_html 	: get_label.diameter + ': ' ,
					parent 		: sum_diameter
				})

			// value — holds the mean diameter string; updated live by fn_update_widget_value
				const media_diameter_value = ui.create_dom_element({
					element_type: 'span',
					class_name	: 'value',
					text_content 	: data.find(item => item.widget_id === 'media_diameter')?.value ?? '',
					parent 		: sum_diameter
				})
		// detail range row: max | min | n for diameter
		const diameter_values = ui.create_dom_element({
			element_type	: 'span',
			class_name		: 'diameter_values',
			parent			: archive_diameter
		})
			// max_diameter
				// label
				// (flag) max_diameter_label — assigned but not read after creation
				const max_diameter_label = ui.create_dom_element({
					element_type: 'span',
					class_name	: 'label_range',
					inner_html 	: 'max: ',
					parent 		: diameter_values
				})

				// value — holds the maximum per-coin mean diameter
				const max_diameter_value = ui.create_dom_element({
					element_type: 'span',
					class_name	: 'value',
					text_content 	: data.find(item => item.widget_id === 'max_diameter')?.value ?? '',
					parent 		: diameter_values
				})

			// min_diameter
				// label
				// (flag) min_diameter_label — assigned but not read after creation
				const min_diameter_label = ui.create_dom_element({
					element_type: 'span',
					class_name	: 'label_range',
					inner_html 	: ' | min: ',
					parent 		: diameter_values
				})

				// value — holds the minimum per-coin mean diameter
				const min_diameter_value = ui.create_dom_element({
					element_type	: 'span',
					class_name		: 'value',
					text_content		: data.find(item => item.widget_id === 'min_diameter')?.value ?? '',
					parent			: diameter_values
				})


			//total_elements_diameter — count of qualifying coins that provided diameter data
				// label
				// (flag) total_diameter_label — assigned but not read after creation
				const total_diameter_label = ui.create_dom_element({
					element_type	: 'span',
					class_name		: 'label',
					inner_html		: ' | n: ',
					parent			: diameter_values
				})

				// value — holds the qualifying-coin count for the diameter dimension
				const total_diameter_value = ui.create_dom_element({
					element_type	: 'span',
					class_name		: 'value',
					text_content		: data.find(item => item.widget_id === 'total_elements_diameter')?.value ?? '',
					parent			: diameter_values
				})


		// Live-update subscription — future-proof pattern kept in place even though this
		// widget's input components (the weight/diameter fields) live on a different section
		// than the archive record the widget is embedded in. Because the user cannot view
		// both the statistics panel and the data-entry form simultaneously, the subscription
		// will only fire if a future sibling widget or automated process broadcasts on this
		// channel. The token is stored in self.events_tokens so widget_common.destroy()
		// can cleanly unsubscribe when the widget is removed from the DOM.
		self.events_tokens.push(
			event_manager.subscribe('update_widget_value_'+i+'_'+self.id, fn_update_widget_value)
		)

		/**
		* FN_UPDATE_WIDGET_VALUE
		* Live-update handler subscribed to `update_widget_value_<i>_<self.id>`.
		*
		* Replaces the textContent of all eight statistic value spans with fresh
		* aggregate data pushed on the event channel. Using `textContent` (not
		* `innerHTML`) is intentional: calculation outputs are always numeric strings
		* so there is no HTML to parse, and `textContent` prevents any accidental
		* HTML injection if an unexpected non-numeric value is received.
		*
		* Closed-over span references (`media_weight_value`, `max_weight_value`, etc.)
		* are the live DOM nodes built earlier in `get_value_element`; they remain
		* accessible via closure even after `get_value_element` returns.
		*
		* @param {Array} changed_data - same shape as the `data` parameter of
		*   `get_value_element`: an array of `{ widget_id, value }` items from the
		*   server or from a broadcasting sibling widget; items are matched by
		*   `widget_id` and unknown widget_ids are silently ignored
		* @returns {boolean} true — return value is ignored by event_manager but
		*   signals normal completion for any future assertion-based tests
		*/
		function fn_update_widget_value(changed_data) {

			// SEC-XSS-012: calculation outputs are numeric; textContent avoids HTML parsing.
			media_weight_value.textContent	= changed_data.find(item => item.widget_id==='media_weight')?.value ?? ''
			max_weight_value.textContent	= changed_data.find(item => item.widget_id==='max_weight')?.value ?? ''
			min_weight_value.textContent	= changed_data.find(item => item.widget_id==='min_weight')?.value ?? ''
			total_weight_value.textContent	= changed_data.find(item => item.widget_id==='total_elements_weights')?.value ?? ''

			media_diameter_value.textContent	= changed_data.find(item => item.widget_id==='media_diameter')?.value ?? ''
			max_diameter_value.textContent	= changed_data.find(item => item.widget_id==='max_diameter')?.value ?? ''
			min_diameter_value.textContent	= changed_data.find(item => item.widget_id==='min_diameter')?.value ?? ''
			total_diameter_value.textContent	= changed_data.find(item => item.widget_id==='total_elements_diameter')?.value ?? ''

			return true
		}


	return li
}//end get_value_element



// @license-end
