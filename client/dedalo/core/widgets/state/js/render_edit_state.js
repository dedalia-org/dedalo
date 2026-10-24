// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_label, page_globals, SHOW_DEBUG, DEDALO_CORE_URL*/
/*eslint no-undef: "error"*/



/**
* RENDER_EDIT_STATE
* Edit-mode renderer for the `state` widget (core/widgets/state).
*
* This module builds the full edit-mode DOM subtree for the `state` widget —
* a diagnostic panel that shows the completion percentage of a record split
* into two metric columns:
*   - "situation" — user-controlled completion status (dd174 section, dd92 value)
*   - "state"     — admin-controlled completion status (dd501 section, dd83 value)
*
* Each column renders a collapsible detail: a summary percentage (total) that
* expands to per-language (or non-language) breakdown rows on mouseenter.
*
* Architecture overview:
*   - `render_edit_state` is a no-op constructor. Its prototype methods are
*     mixed into the `state` class via
*       state.prototype.edit = render_edit_state.prototype.edit
*     (see state.js). It is never instantiated directly.
*   - All DOM-building delegates to `ui.create_dom_element` (core/common/js/ui.js).
*   - Live value updates (e.g. when the user changes a state/situation component
*     in the same session) are delivered via `event_manager` on the channel
*     `update_widget_value_<ipo_index>_<widget_id>`.
*   - Event subscription tokens are stored in `self.events_tokens` so the
*     widget's `destroy()` lifecycle hook can unsubscribe them.
*
* Data contract — `self.value` (produced by class.state.php::get_data()):
*   An array of FLAT objects — no `.value` envelope around the item:
*   {
*     widget:    string,   // always 'state'
*     key:       number,   // zero-based IPO index this item belongs to
*     id:        string,   // same as widget_id (WC-026 emits both keys)
*     widget_id: string,   // var_name from IPO output — e.g. 'state'|'situation'
*     lang:      string,   // language tag (e.g. 'lg-spa') or 'lg-nolan' for non-translatable
*     value:     number,   // completion percentage 0–1 (total rows) or 0/1 (detail rows)
*     locator:   {section_tipo:string, section_id:string, ...} | null,
*     column:    string,   // 'situation' | 'state'
*     type:      string,   // 'total' | 'detail'
*     items:     number    // TOTAL ITEMS ONLY — the source-record count this
*                          // total is averaged over, i.e. its own divisor
*                          // (WC-2026-08-03-state-widget-total-source-count).
*                          // A source with nothing saved emits no detail item,
*                          // so this is the only way to know a row is missing.
*   }
*   (self.datalist IS `.value`-wrapped — do not confuse the two.)
*
* `self.datalist` (produced by class.state.php::get_data_list()):
*   An array of list-of-values items. Each entry has a `.value` with
*   `.section_tipo` and `.section_id` keys, plus a top-level `.label` string
*   used to display the human-readable name of the selected state option.
*
* `self.ipo` (from ontology properties — Input/Process/Output config):
*   An array of IPO objects:
*   {
*     input:  { type: 'locator'|'component_data', source: [...], paths: [...] },
*     output: [ { id: string, label: string }, ... ]   // columns to render
*   }
*
* Companion files:
*   - render_list_state.js  — compact list-mode renderer for the same widget
*   - state.js              — constructor + prototype wiring
*   - class.state.php       — server-side data builder
*
* @module render_edit_state
*/

// imports
	import {ui} from '../../../common/js/ui.js'
	import {event_manager} from '../../../common/js/event_manager.js'
	import {same_section_id} from '../../../common/js/utils/index.js'



/**
* RENDER_EDIT_STATE
* Constructor stub. All logic lives on the prototype and is mixed into `state`.
* @returns {boolean} true
*/
export const render_edit_state = function() {

	return true
}//end render_edit_state



/**
* SET_METER
* Paint the progress meter of a `.total` node from its percentage.
* The bar itself is a CSS pseudo-element (see widgets/state/css/state.less): this
* only publishes the two inputs it reads — `--pct` (fill width) and `data-state`
* (fill colour: ok / partial / empty). Called on build AND on every live
* `update_widget_value`, so the bar can never drift from the number beside it.
*
* @param {HTMLElement} total_node - the `.total` div holding the percentage.
* @param {number|string} value - percentage 0–100 as delivered by the server.
* @returns {number} the clamped percentage actually painted.
*/
const set_meter = function(total_node, value) {

	const pct = Math.max(0, Math.min(100, Number(value) || 0))

	total_node.style.setProperty('--pct', pct)
	total_node.dataset.state = pct >= 100
		? 'ok'
		: (pct > 0 ? 'partial' : 'empty')

	return pct
}//end set_meter



/**
* PLACE_DETAIL
* Decide which way the breakdown panel opens, measured at open time.
*
* The widget renders inside `.content_value`, which carries `contain: content`
* (component_info.less) — PAINT containment, so anything drawn outside that box
* is clipped, not scrolled into view. A static rule cannot know: the panel's
* height depends on how many languages or source records the row has, so the
* same row overflows on one record and not on the next.
*
* @param {HTMLElement} detail_node - the `.detail` panel, already visible.
* @returns {void}
*/
const place_detail = function(detail_node) {

	// measure in the default position (below the cell, left-aligned, unclamped)
	detail_node.style.transform = ''
	detail_node.style.maxHeight = ''

	const bounds_node = detail_node.closest('.content_value') || detail_node.closest('.wrapper_widget')
	if (!bounds_node) {
		return
	}
	const bounds	= bounds_node.getBoundingClientRect()
	let panel		= detail_node.getBoundingClientRect()

	// Last resort only: a panel taller than the whole widget (a translatable leaf
	// draws one row per project language) scrolls. Scrolled rows are reachable;
	// clipped ones are not.
	if (panel.height > bounds.height - 4) {
		detail_node.style.maxHeight = Math.max(0, bounds.height - 8) + 'px'
		panel = detail_node.getBoundingClientRect()
	}

	// SLIDE the panel back inside the paint box rather than flipping it above the
	// cell. Flipping trades one clipped edge for another: the widget card is only
	// as tall as its rows, so on a short card neither side has room and the panel
	// ends up either cut off or scrolled — and what falls off the bottom is the
	// total row, the one number that explains all the others. A translation keeps
	// the panel whole and adjacent; overlapping its own cell is the cheap part.
	let dx = 0
	let dy = 0
	if (panel.bottom > bounds.bottom)	dy = bounds.bottom - panel.bottom - 2
	if (panel.top + dy < bounds.top)	dy = bounds.top - panel.top + 2
	if (panel.right > bounds.right)		dx = bounds.right - panel.right - 2
	if (panel.left + dx < bounds.left)	dx = bounds.left - panel.left + 2
	if (dx !== 0 || dy !== 0) {
		detail_node.style.transform = 'translate(' + dx + 'px, ' + dy + 'px)'
	}
}//end place_detail



/**
* BUILD_SOURCE_ROWS
* Breakdown rows for a NON-translatable leaf: one per SOURCE RECORD.
*
* The total is `sum / langs / source-record-count` (server:
* src/core/components/component_info/widgets/state/state.ts), and a source
* record with nothing saved contributes 0 to that average while emitting NO
* detail item. Listing only the details therefore showed `50%` under a cell
* reading `25%` with nothing to explain the gap. The server publishes the
* divisor as `items` on the total item
* (WC-2026-08-03-state-widget-total-source-count), so the missing sources get
* their own explicit 0% rows and the average becomes self-evident.
*
* Falls back to the details themselves when `items` is absent or smaller than
* the number of details — the panel must never DROP a row it was given, and an
* older server (or a shape this code has not met) is not a reason to lie.
*
* @param {Array} details - the detail items of this cell, in server order.
* @param {Object|null} total_item - the cell's total item (carries `items`).
* @param {string} nolan - page_globals.dedalo_data_nolan.
* @returns {Array} row descriptors {label, lang, item}.
*/
const build_source_rows = function(details, total_item, nolan) {

	const declared	= Number(total_item && total_item.items)
	const count		= Math.max(details.length, Number.isFinite(declared) ? declared : 0, 1)

	const rows = []
	for (let r = 0; r < count; r++) {
		rows.push({
			label	: '',
			lang	: nolan,
			item	: details[r] || null
		})
	}

	return rows
}//end build_source_rows



/**
* BUILD_DETAIL_CONTAINER
* Build the hover/focus breakdown panel of ONE metric cell (one column of one
* output row), and register its nodes for live updates.
*
* Why it exists at all: the panel used to render one row per PROJECT LANGUAGE,
* found by `data.find(… lang === lang …)`. That is only true for a translatable
* leaf. For a NON-translatable one every detail item carries 'lg-nolan', so:
*   - `find` returned the FIRST item and the rest were invisible — a record with
*     two audiovisuals showed only the transcribed one, and
*   - that single per-source value was labelled `total :`, which is not what it
*     is. The server total is `sum / langs / source-record-count`
*     (src/core/components/component_info/widgets/state/state.ts), so on a
*     2-resource record the panel said `total : 50%` while the cell said `25%`.
*     Two different numbers, both labelled total, neither explaining the other.
*
* So: one row per detail item that actually exists (by lang when translatable,
* one per source record otherwise), plus an explicit total row carrying the same
* number the cell shows. Nothing in the panel is labelled total but isn't.
*
* @param {Object} params
* @param {HTMLElement} params.column_node - the `.situation` / `.state` cell.
* @param {Array}  params.data - self.value items of this IPO entry.
* @param {Object} params.output_item - the IPO output row ({id, label}).
* @param {string} params.column - 'situation' | 'state'.
* @param {boolean} params.translatable - is the leaf component translatable.
* @param {Array}  params.project_langs - page_globals.dedalo_projects_default_langs.
* @param {string} params.nolan - page_globals.dedalo_data_nolan.
* @param {Object} params.total_item - the cell's total item (value + `items`).
* @param {Object} params.self - the `state` widget instance (for self.datalist).
* @param {Array}  params.ar_nodes - live-update registry to push into.
* @param {number} params.key - IPO index.
* @returns {HTMLElement} the `.detail` container (starts hidden).
*/
const build_detail_container = function(params) {

	const column_node	= params.column_node
	const data			= params.data
	const output_item	= params.output_item
	const column		= params.column
	const translatable	= params.translatable
	const project_langs	= params.project_langs
	const nolan			= params.nolan
	const self			= params.self
	const ar_nodes		= params.ar_nodes
	const key			= params.key

	const detail_container = ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'detail hide',
		parent			: column_node
	})

	// every detail item of this cell, in server order
	const details = data.filter(item => item.widget_id === output_item.id
									&& item.column === column
									&& item.type === 'detail')

	// rows to draw.
	// translatable: one per project lang, empty ones included (a language with
	// nothing saved is a real, meaningful gap — it is what the total divides by).
	// non-translatable: one per detail item — that is one per SOURCE RECORD, and
	// they are not interchangeable, so none may be dropped.
	const rows = translatable
		? project_langs.map(lang_item => ({
			label	: lang_item.label + ': ',
			lang	: lang_item.value,
			item	: details.find(item => item.lang === lang_item.value) || null
		}))
		: build_source_rows(details, params.total_item, nolan)

	for (let r = 0; r < rows.length; r++) {
		const row = rows[r]

		// lang name, or nothing at all when the rows are per source record —
		// there the option chip IS the identity of the row
		ui.create_dom_element({
			element_type	: 'label',
			text_content	: row.label,
			parent			: detail_container
		})
		const node_value = ui.create_dom_element({
			element_type	: 'span',
			class_name		: 'value',
			text_content	: (row.item ? row.item.value : 0) + '%',
			parent			: detail_container
		})
		// selected option name
		const datalist_item = (row.item && row.item.locator)
			? self.datalist.find(item => item.value.section_tipo === row.item.locator.section_tipo
									&& same_section_id(item.value.section_id, row.item.locator.section_id)) || {label: ''}
			: {label: ''}
		const node_label_list = ui.create_dom_element({
			element_type	: 'label',
			text_content	: datalist_item.label,
			parent			: detail_container
		})

		// save the nodes for reuse later in the 'update_widget_value' event.
		// detail_index disambiguates rows that share the same lang (the
		// per-source-record case) — without it every one of them would take the
		// value of the first match.
		ar_nodes.push({
			node_value		: node_value,
			node_label_list	: node_label_list,
			type			: 'detail',
			value			: row.item ? row.item.value : 0,
			lang			: row.lang,
			detail_index	: r,
			per_source		: !translatable,
			widget_id		: output_item.id,
			key				: key,
			column			: column
		})
	}

	// the aggregate, spelled out: this is the number the cell shows, and the only
	// row in the panel entitled to be called a total
	ui.create_dom_element({
		element_type	: 'label',
		class_name		: 'total_label',
		text_content	: (get_label['total'] || 'total') + ' :',
		parent			: detail_container
	})
	const node_total_value = ui.create_dom_element({
		element_type	: 'span',
		class_name		: 'value total_value',
		text_content	: params.total_item.value + '%',
		parent			: detail_container
	})
	ui.create_dom_element({
		element_type	: 'label',
		parent			: detail_container
	})
	ar_nodes.push({
		node_value	: node_total_value,
		type		: 'total',
		value		: params.total_item.value,
		lang		: nolan,
		widget_id	: output_item.id,
		key			: key,
		column		: column
	})

	detail_container.classList.add('rows_' + rows.length)


	return detail_container
}//end build_detail_container



/**
* EDIT
* Render node for use in modes: edit, edit_in_list.
*
* Builds a two-level structure:
*   wrapper (ui.widget.build_wrapper_edit)
*     └── content_data (div)
*           └── <ul class="values_container">
*                 └── <li class="widget_item state"> × ipo.length
*
* When `options.render_level === 'content'` the wrapper is bypassed and only
* the raw content_data element is returned. This is used by layouts that
* embed widgets directly without the standard widget chrome.
*
* @param {Object} options - Render options passed by the widget lifecycle.
* @param {string} options.render_level - When set to 'content', skip the wrapper
*   and return only the content_data element.
* @returns {Promise<HTMLElement>} wrapper (or content_data when render_level='content')
*/
render_edit_state.prototype.edit = async function(options) {

	const self = this

	// options
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
		// set pointers
		wrapper.content_data = content_data


	return wrapper
}//end edit



/**
* GET_CONTENT_DATA_EDIT
* Build the inner content_data container for edit mode.
*
* Iterates over every IPO entry (self.ipo) and builds one <li> per entry by
* delegating to `get_value_element`. Items from `self.value` are pre-filtered
* by IPO index (item.key === i) before being passed down.
*
* The returned element is a plain <div> wrapping a DocumentFragment that holds
* the <ul class="values_container">. The DocumentFragment is consumed by
* `content_data.appendChild()` which flattens it into the div.
*
* @param {Object} self - The `state` widget instance (this).
* @returns {Promise<HTMLElement>} content_data div element ready to be inserted
*   into the DOM.
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

		for (let i = 0; i < ipo_length; i++) {
			const data = self.value.filter(item => item.key === i)
			const value_element	= get_value_element(i, data, self)
			values_container.appendChild(value_element)
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
* Build the complete <li> element for one IPO entry (index `i`).
*
* Structure produced for each IPO entry:
*   <li class="widget_item state">
*     <div class="li_item header">
*       <label />              ← empty group-name column
*       <label>situation</label>
*       <label>state</label>
*     </div>
*     <!-- one .li_item.container per ipo[i].output row -->
*     <div class="li_item container">
*       <label>…row label…</label>
*       <div class="situation">
*         <div class="total">  ← shows aggregate % (mouseenter reveals detail)
*           <span class="value">X%</span>
*         </div>
*         <div class="detail hide">   ← per-language breakdown rows
*           …
*         </div>
*       </div>
*       <div class="state">
*         <div class="total"> … </div>
*         <div class="detail hide"> … </div>
*       </div>
*     </div>
*   </li>
*
* The "situation" column maps to ontology section dd174 (user-editable status);
* the "state" column maps to dd501 (admin-controlled status).
*
* Both "total" rows toggle their corresponding ".detail" panel via
* mouseenter/mouseleave events instead of a click handler. This means the
* detail panel disappears as soon as the pointer leaves the total node —
* there is no persistent-open/close toggle.
*
* The `ar_nodes` array accumulates node descriptors used by the
* `fn_update_widget_value` event handler to patch the DOM in place when the
* underlying component data changes without a full widget re-render.
*
* Node descriptor shape stored in ar_nodes:
*   For 'total' rows:
*   {
*     node_value : HTMLElement,  // the <span class="value"> that shows "X%"
*     type       : 'total',
*     value      : Object,       // original .value from self.value data item
*     lang       : string,       // always nolan for totals
*     widget_id  : string,       // output_item.id — e.g. 'state'|'situation'
*     key        : number,       // IPO index
*     column     : string        // 'situation'|'state'
*   }
*   For 'detail' rows (additional fields):
*   {
*     node_label_list : HTMLElement,  // <label> showing the list value name
*     value           : Object|number // 0 when item not found in data
*   }
*
* @param {number} i    - Zero-based index of the current IPO entry.
* @param {Array}  data - Subset of self.value items whose value.key === i.
* @param {Object} self - The `state` widget instance (this).
* @returns {HTMLElement} value_element — the fully built <li> element.
*/
const get_value_element = (i, data, self) => {

	// li, for every ipo will create a li node
		const value_element = ui.create_dom_element({
			element_type	: 'li',
			class_name		: 'widget_item state'
		})

	// header. First row with the header labels
		const header = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'li_item header',
			inner_html		: '',
			parent			: value_element
		})
		// group_name_column
			const group_name_column = ui.create_dom_element({
				element_type	: 'label',
				inner_html		: '',
				parent			: header
			})
		// label_situation
			const label_situation = ui.create_dom_element({
				element_type	: 'label',
				inner_html		: get_label['situation'] || 'situation',
				parent			: header
			})
		// label_state
			const label_state = ui.create_dom_element({
				element_type	: 'label',
				inner_html		: get_label['state'] || 'state',
				parent			: header
			})

		// (!) Data only contains langs that actually have a value.
		// When a component is translatable, not all project langs may be present in `data`
		// (only the ones with saved values). For non-translatable components, there is
		// always exactly one entry keyed to 'lg-nolan'.
		// We therefore always iterate over project_langs (or length 1 for nolan) instead
		// of the data array to ensure every language slot is rendered, even when empty.
		const project_langs	= page_globals.dedalo_projects_default_langs
		const nolan			= page_globals.dedalo_data_nolan

		// select the current ipo.output
		const output		= self.ipo[i].output

		// we will store the nodes to re-create the value when the components change our data and send the 'update_widget_value' event
		const ar_nodes = []

	// li container
		// every ipo has one output array whit the objects for every row
		// get the output for reference of the rows
		for (let o = 0; o < output.length; o++) {
			const output_item = output[o]
			// row container
				const container = ui.create_dom_element({
					element_type	: 'div',
					class_name		: 'li_item container',
					parent			: value_element
				})

				// label for the row
					const row_label = get_label[output_item.label] || output_item.id
					const label = ui.create_dom_element({
						element_type	: 'label',
						inner_html		: row_label,
						parent			: container
					})

			// Situation
				// node for the column situation.
				// (!) ALWAYS created, even when this output row has no situation data.
				// The row is a slice of a 3-column grid (label | situation | state)
				// whose cells are auto-placed: skip one and the NEXT row's label slides
				// into the hole, so the labels march across the columns and the table
				// collapses. An empty cell is what keeps the grid a grid.
				const situation = ui.create_dom_element({
					element_type	: 'div',
					class_name		: 'situation',
					parent			: container
				})

				// check if the component is translatable, with the first item in the data of the current column
				const situation_item = data.find(item => item.widget_id === output_item.id && item.column === 'situation')
				// get the total item for situation
				const situation_total = data.find(item => item.widget_id === output_item.id
															&& item.column === 'situation'
															&& item.type ==='total')
				if (situation_item && situation_total) {

					// check if the item is translatable
					const situation_translatable = (situation_item.lang !== nolan)

						// Reveal/hide the per-language detail panel on hover.
						// The detail panel is initially hidden (.hide class) and is shown
						// while the pointer is over the COLUMN — not over the total node
						// alone: the panel is rendered below the total, so a listener on
						// the total closed it the instant the pointer travelled towards it,
						// making the breakdown unreadable. The column is the hover area the
						// CSS `:hover` rule uses too, so both agree.
						// focusin/focusout mirror it for keyboard users: `.hide` is
						// `display:none !important` (layout/general.less), so a CSS
						// :focus-within rule could not win — the class has to be toggled here.
						situation.addEventListener('mouseenter', function(e) {
							situation_detail_container.classList.remove('hide')
							place_detail(situation_detail_container)
						})
						situation.addEventListener('mouseleave', function(e) {
							situation_detail_container.classList.add('hide')
						})
						situation.addEventListener('focusin', function(e) {
							situation_detail_container.classList.remove('hide')
							place_detail(situation_detail_container)
						})
						situation.addEventListener('focusout', function(e) {
							situation_detail_container.classList.add('hide')
						})
						// total
						const situation_total_node = ui.create_dom_element({
							element_type	: 'div',
							class_name		: 'total',
							parent			: situation
						})
						// create the node with the total value
						const situation_total_value = ui.create_dom_element({
							element_type	: 'span',
							class_name		: 'value',
							text_content		: situation_total.value + '%',
							parent			: situation_total_node
						})
						// meter + keyboard access. focus opens the same detail panel as
						// hover (CSS :focus-within), so the breakdown is reachable without
						// a mouse.
						const situation_pct = set_meter(situation_total_node, situation_total.value)
						situation_total_node.setAttribute('tabindex', '0')
						situation_total_node.setAttribute('aria-label',
							row_label + ' · ' + (get_label['situation'] || 'situation') + ' ' + situation_pct + '%'
						)
						// save the node for reuse later in 'update_widget_value' event
						ar_nodes.push({
							node_value	: situation_total_value,
							node_total	: situation_total_node,
							type		: 'total',
							value		: situation_total.value,
							lang		: nolan,
							widget_id	: output_item.id,
							key			: i,
							column		: 'situation'
						})

					// detail node: the breakdown behind the total
						const situation_detail_container = build_detail_container({
							column_node		: situation,
							data			: data,
							output_item		: output_item,
							column			: 'situation',
							translatable	: situation_translatable,
							project_langs	: project_langs,
							nolan			: nolan,
							total_item		: situation_total,
							self			: self,
							ar_nodes		: ar_nodes,
							key				: i
						})
				}else{
					// no data for this row/column: the cell stays, empty (see above)
					situation.classList.add('empty')
				}//end if (situation_item && situation_total)

			// State
				// node for state column. Always created too — same grid reason as
				// the situation cell above.
				const state = ui.create_dom_element({
					element_type 	: 'div',
					class_name		: 'state',
					parent 			: container
				})

				// check if the component is translatable, with the first item in the data of the current column
				const state_item = data.find(item => item.widget_id === output_item.id && item.column === 'state')
				const state_total = data.find(item => item.widget_id === output_item.id
													&& item.column === 'state'
													&& item.type ==='total')
				if (state_item && state_total) {
					// second, check if the item is translatable
					const state_translatable = (state_item.lang !== nolan)

						// Reveal/hide the per-language detail panel on hover (same pattern as
						// situation above: the COLUMN is the hover area, not the total node).
						state.addEventListener('mouseenter', function(e) {
							state_detail_container.classList.remove('hide')
							place_detail(state_detail_container)
						})
						state.addEventListener('mouseleave', function(e) {
							state_detail_container.classList.add('hide')
						})
						state.addEventListener('focusin', function(e) {
							state_detail_container.classList.remove('hide')
							place_detail(state_detail_container)
						})
						state.addEventListener('focusout', function(e) {
							state_detail_container.classList.add('hide')
						})
						// total
						const state_total_node = ui.create_dom_element({
							element_type 	: 'div',
							class_name		: 'total',
							parent 			: state
						})
						// create the node with the value
						const total_value = ui.create_dom_element({
							element_type	: 'span',
							class_name		: 'value',
							text_content	: state_total.value +'%',
							parent 			: state_total_node
						})
						// meter + keyboard access (see situation above)
						const state_pct = set_meter(state_total_node, state_total.value)
						state_total_node.setAttribute('tabindex', '0')
						state_total_node.setAttribute('aria-label',
							row_label + ' · ' + (get_label['state'] || 'state') + ' ' + state_pct + '%'
						)
						// save the node for reuse later in 'update_widget_value' event
						ar_nodes.push({
							node_value 	: total_value,
							node_total	: state_total_node,
							type 		: 'total',
							value 		: state_total.value,
							lang 		: nolan,
							widget_id	: output_item.id,
							key 		: i,
							column		: 'state'
						})

					// detail node: the breakdown behind the total
					const state_detail_container = build_detail_container({
						column_node		: state,
						data			: data,
						output_item		: output_item,
						column			: 'state',
						translatable	: state_translatable,
						project_langs	: project_langs,
						nolan			: nolan,
						total_item		: state_total,
						self			: self,
						ar_nodes		: ar_nodes,
						key				: i
					})
				}else{
					// no data for this row/column: the cell stays, empty (see above)
					state.classList.add('empty')
				}//end if (state_item && state_total)
		}//end for (let o = 0; o < output.length; o++)

		// Subscribe to live-update events for this IPO slot.
		// The event channel is keyed as 'update_widget_value_<i>_<widget.id>' so
		// that only the matching IPO entry responds when multiple state widgets
		// coexist on the same page. Tokens are pushed into self.events_tokens so
		// destroy() can unsubscribe all handlers when the widget is torn down.
		self.events_tokens.push(
			event_manager.subscribe('update_widget_value_'+i+'_'+self.id, fn_update_widget_value)
		)
		/**
		* FN_UPDATE_WIDGET_VALUE
		* Live-update handler invoked when `update_widget_value_<i>_<id>` fires.
		*
		* Iterates ar_nodes in reverse order and for each registered node finds
		* the matching item in `changed_data` using a five-key identity check
		* (widget_id, column, lang, key, type). When found, the node's
		* percentage span and — for detail rows — its list-label are updated
		* directly via innerHTML. When not found (e.g. value was cleared), the
		* percentage is reset to '0%' and the list-label is cleared.
		*
		* The reverse-order iteration is harmless here (no removal) but matches
		* the pattern used in list-mode for consistency.
		*
		* @param {Array} changed_data - Array of updated value objects in the same
		*   shape as `self.value` but with the new values set by the server.
		*/
		function fn_update_widget_value(changed_data) {

			// get all detail nodes 'situation' and 'state' in DOM
			const detail_nodes = ar_nodes //.filter(node => node.type === 'detail')
			const node_length = detail_nodes.length

			for (let o = node_length - 1; o >= 0; o--) {
				const node = detail_nodes[o]
				// find if the node has new data
				const matches = changed_data.filter(
					item => item.widget_id === node.widget_id
					&& item.column === node.column
					&& item.lang === node.lang
					&& item.key === i
					&& item.type === node.type
				)
				// per-source detail rows all carry lg-nolan, so the identity check
				// above cannot tell them apart — they are distinguished by their
				// position, exactly as they were built. Everything else takes the
				// single match.
				const new_data = node.per_source
					? matches[node.detail_index]
					: matches[0]
				// set the new value
				if(new_data){
					node.node_value.textContent = new_data.value +'%'
					// repaint the bar from the same number, or it would freeze at the
					// value the widget was built with
					if(node.node_total){
						set_meter(node.node_total, new_data.value)
					}
					if(node.type==='detail'){
						const datalist_item = (new_data.locator)
							? self.datalist.find(item => item.value.section_tipo===new_data.locator.section_tipo
													  && same_section_id(item.value.section_id, new_data.locator.section_id))
							: {label: ''}

						node.node_label_list.innerHTML = datalist_item.label
					}

				}else{
					node.node_value.innerHTML = '0%'
					if(node.node_total){
						set_meter(node.node_total, 0)
					}
					if(node.type==='detail'){
						node.node_label_list.innerHTML = ''
					}
				}// end if(new_data){
			}// end for (let o = node_length - 1; o >= 0; o--)
		}//end fn_update_widget_value


	return value_element
}//end get_value_element



// @license-end
