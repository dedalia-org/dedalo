// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_label, page_globals, SHOW_DEBUG, DEDALO_CORE_URL*/
/*eslint no-undef: "error"*/



// imports
	import {ui} from '../../../common/js/ui.js'
	import {event_manager} from '../../../common/js/event_manager.js'
	import {same_section_id} from '../../../common/js/utils/index.js'



/**
* RENDER_LIST_STATE
* List-mode renderer for the `state` widget.
*
* Provides the `list` prototype method consumed by `state.prototype.list` (via state.js).
* In list mode the widget renders a compact icon strip per IPO entry: one clickable
* icon per output column (situation / state) that is non-zero. Clicking an icon opens
* a fly-out tooltip showing per-language detail values and the associated datalist label.
*
* Data shape expected on `self`:
*   self.ipo      – Array of IPO objects from the ontology.  Each entry has:
*                     { input: {...}, output: [{id, label}, ...] }
*   self.value    – Flat array of widget data items as the server emits them.
*                   Each item: { widget, key, id, widget_id, column, type, value, lang, locator? }
*                   (FLAT — there is no `.value` envelope around the item; the
*                   only `.value`-wrapped array here is self.datalist, below)
*                   where:
*                     key     – index into self.ipo (0-based)
*                     id      – output column identifier (e.g. 'state', 'situation')
*                     column  – 'state' | 'situation'
*                     type    – 'total' | 'detail'
*                     value   – numeric percentage (0–1 range from PHP; rendered as %)
*                     lang    – language tag or 'lg-nolan' for non-translatable components
*                     locator – optional locator object linking to the status/situation record
*   self.datalist – Array of datalist items used to resolve human-readable labels for
*                   locators ({ value: { section_tipo, section_id }, label }).
*   self.events_tokens – Array to store event subscription tokens for cleanup on destroy.
*   self.id       – Unique widget instance identifier used for event namespacing.
*
* Main exports: render_list_state (constructor, assigned to state.prototype.list)
*/
export const render_list_state = function() {

	return true
}//end render_list_state



/**
* LIST
* Render node for use in modes: list, edit_in_list
*
* Builds the list-mode DOM subtree: a wrapper element containing the icon-strip
* content_data node. Each IPO entry renders as a `<li>` with clickable state icons.
* The `content_data` pointer is set on the returned wrapper so callers can
* directly access the inner content node for targeted DOM replacement.
*
* @param {Object} options - Render options passed by widget_common.render()
* @returns {Promise<HTMLElement>} wrapper element with content_data pointer set
*/
render_list_state.prototype.list = async function(options) {

	const self = this

	// content_data
		const content_data = await get_content_data_list(self)

	// wrapper. ui build_edit returns widget wrapper
		const wrapper = ui.widget.build_wrapper_edit(self, {
			// content_data : content_data
		})
		wrapper.appendChild(content_data)
		// set pointers
		wrapper.content_data = content_data


	return wrapper
}//end list



/**
* GET_CONTENT_DATA_LIST
* Build the full `<ul>` icon-strip for all IPO entries in list mode.
*
* Iterates self.ipo and for each entry filters self.value to only the items
* belonging to that ipo key (item.key === i), then delegates to
* get_value_element() for the per-entry `<li>`.
*
* The function returns a DocumentFragment (not a `<div>`) so that it can be
* appended directly without introducing an extra wrapper node.
*
* @param {Object} self - The state widget instance
* @returns {Promise<DocumentFragment>} fragment containing the values_container `<ul>`
*/
const get_content_data_list = async function(self) {

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
			const data			= self.value.filter(el => el.key===i)
			const value_element	= get_value_element(i, data, self)
			values_container.appendChild(value_element)
		}


	return fragment
}//end get_content_data_list



/**
* GET_VALUE_ELEMENT
* Build the `<li>` icon strip for a single IPO entry (index i).
*
* For each output row in ipo[i].output, a clickable icon (`<span class="state_icon">`)
* is appended only when either the situation or the state total is greater than zero —
* i.e. there is something meaningful to show. Clicking the icon toggles an 'active'
* class on the icon, clears 'active' from siblings, and renders a tooltip node via
* get_value_tooltip(). Clicking the tooltip itself closes it and resets the active state.
*
* The function also subscribes to the `update_widget_value_<i>_<id>` event so that
* live data changes from other components can update the rendered percentages without
* a full re-render. The subscription token is stored in self.events_tokens for cleanup.
*
* Known issue: `ar_nodes` is declared and initialized to [] but never populated in
* this list-mode implementation (unlike render_edit_state.js which does push to it).
* The fn_update_widget_value handler therefore always iterates zero nodes. This looks
* like an incomplete port of the edit-mode update logic to list mode — see flag below.
*
* Data items are matched by their `widget_id` against output_item.id — the same
* key render_edit_state.js uses. The server also emits an `id` twin (WC-026, a
* PHP-client compat shim); `widget_id` is the canonical selector because `id` is
* overloaded (the ontology's output[].id, and a media_icons row's `id` is a CELL
* object, not a string).
*
* @param {number} i - Zero-based index into self.ipo
* @param {Array} data - Subset of self.value items where item.key === i
* @param {Object} self - The state widget instance
* @returns {HTMLElement} `<li>` element with icon spans and event subscriptions attached
*/
const get_value_element = (i, data, self) => {

	// li, for every ipo will create a li node
		const value_element = ui.create_dom_element({
			element_type	: 'li',
			class_name		: 'widget_item state'
		})

		// (!) Data completeness caveat for translatable vs. non-translatable components:
		// When a component is translatable, `data` only contains items for languages that
		// actually have a value. When the component is non-translatable, `data` always
		// contains the lg-nolan reference (possibly empty). The output array is used as the
		// canonical reference for row iteration, not the data items themselves.
		// const project_langs = page_globals.dedalo_projects_default_langs
		// const nolan 		= page_globals.dedalo_data_nolan
		// select the current ipo.output
		const output		= self.ipo[i].output
		// we will store the nodes to re-create the value when the components change our data and send the 'update_widget_value' event
		const ar_nodes = []
		// create a node var to fill with the information of the state when the user click in the icon
		let tooltip_node
		// every ipo has one output array with the objects for every row
		// get the output for reference of the rows
		const output_length = output.length
		for (let z = 0; z < output_length; z++) {

			const output_item = output[z]

			// Situation
				// get the total item for situation
				const situation_total = data.find(item => item.widget_id === output_item.id
					&& item.column === 'situation'
					&& item.type ==='total'
				)
				// console.log('situation_total:', situation_total);

			// State
				// get the total item for state
				const state_total = data.find(item =>  item.widget_id === output_item.id
													&& item.column === 'state'
													&& item.type ==='total')
				// console.log('state_total:', state_total.value, state_total);

				// Only render the icon when at least one of situation or state has a non-zero total.
				// This suppresses icons for rows where the record has no meaningful state data.
				if(situation_total && (situation_total.value > 0 || state_total.value > 0)) {
					// node for the column situation
					const situation = ui.create_dom_element({
						element_type	: 'span',
						class_name		: 'state_icon ' + output_item.id,
						parent			: value_element
					})

					situation.addEventListener('click', function() {
						// delete the tool_tip node every time that user click in the icons
							if (tooltip_node) {
								tooltip_node.remove()
							}

						// Toggle off when already active: second click closes the tooltip.
						if (this.classList.contains('active')) {
							this.classList.remove('active')
							return
						}

						// reset and active current
							[].forEach.call(this.parentNode.children, function(child) {
								child.classList.remove('active')
							});
							this.classList.add('active')

						// tooltip_node
						tooltip_node = ui.create_dom_element({
							element_type	: 'span',
							class_name		: 'state_tooltip',
							parent			: value_element
						})
						tooltip_node.addEventListener('click', function(e){
							e.stopPropagation()

							tooltip_node.remove();

							// reset active
							[].forEach.call(situation.parentNode.children, function(child) {
								child.classList.remove('active')
							});
						})

						// get the value of specific output (situation, state ) with the totals
						const tooltip = get_value_tooltip(output_item, data, self)
						tooltip_node.appendChild(tooltip)
					})
				}
		}// end for (let o = 0; o < output.length; o++)

		self.events_tokens.push(
			event_manager.subscribe('update_widget_value_'+i+'_'+self.id, fn_update_widget_value)
		)
		function fn_update_widget_value(changed_data) {

			// get all detail nodes 'situation' and 'state' in DOM
			const detail_nodes	= ar_nodes //.filter(node => node.type === 'detail')
			const node_length	= detail_nodes.length

			// Iterate in reverse so that index-shifting from node removal (if any) does not
			// corrupt the traversal order.
			for (let o = node_length - 1; o >= 0; o--) {
				const node = detail_nodes[o]
				// find if the node has new data
				const new_data = changed_data.find(item => item.widget_id === node.widget_id
					&& item.column === node.column
					&& item.lang === node.lang
					&& item.key === i
					&& item.type === node.type
				)

				// set the new value
				if(new_data){
					node.node_value.textContent = new_data.value +'%'
					if(node.type==='detail'){
						const datalist_item = (new_data.locator)
							? self.datalist.find(item => item.value.section_tipo === new_data.locator.section_tipo
													&& same_section_id(item.value.section_id, new_data.locator.section_id))
							: {label: ''}

						node.node_label_list.textContent = datalist_item.label
					}

				}else{
					node.node_value.textContent = '0%'
					if(node.type==='detail'){
						node.node_label_list.textContent = ''
					}
				}// end if(new_data){
			}// end for (let o = node_length - 1; o >= 0; o--)

			return true
		}//end fn_update_widget_value


	return value_element
}//end get_value_element



/**
* GET_VALUE_TOOLTIP
* Build the tooltip DOM fragment shown when the user clicks a state icon.
*
* The fragment contains two column blocks:
*   1. Situation column (`<div class="situation">`) – tracks the user-controlled
*      workflow status (dd174 / component linked via 'situation' path).
*   2. State column (`<div class="state">`) – tracks the admin-controlled status
*      (dd501 / component linked via 'state' path).
*
* Each block contains:
*   - A `<div class="total">` showing the aggregated percentage across all languages.
*   - A `<div class="detail">` with one row per project language (or single row for
*     non-translatable components), each row showing: lang label, value %, datalist label.
*
* Translatable vs. non-translatable branching:
*   Translatability is determined by checking whether the first matching data item
*   carries a lang value other than `page_globals.dedalo_data_nolan`. If translatable,
*   iteration uses all entries of `page_globals.dedalo_projects_default_langs`; otherwise
*   a single iteration is performed using the nolan lang key.
*
* Every data lookup here reads the item FLAT (item.widget_id / item.column /
* item.lang / item.type), matching what the server emits. Only self.datalist
* entries are `.value`-wrapped ({value:{section_tipo,section_id}, label}).
*
* @param {Object} output_item - One entry from ipo[i].output, shape: { id, label }
* @param {Array} data - Subset of self.value items where item.key === i
* @param {Object} self - The state widget instance
* @returns {DocumentFragment} fragment containing the fully built tooltip DOM
*/
const get_value_tooltip = (output_item, data, self) => {

	const fragment = new DocumentFragment()

	// short vars
		const project_langs	= page_globals.dedalo_projects_default_langs
		const nolan			= page_globals.dedalo_data_nolan

	// row container
		const container = ui.create_dom_element({
			element_type	: 'div',
			class_name		: '',
			parent			: fragment
		})

		// label for the row
		ui.create_dom_element({
			element_type	: 'label',
			class_name		: 'output_label',
			text_content		: get_label[output_item.label] || output_item.id,
			parent			: container
		})

	// Situation
		// check if the component is translatable, with the first item in the data of the current column
		const situation_item = data.find(item => item.widget_id === output_item.id && item.column === 'situation')
		// check if the item is translatable
		const situation_translatable = (situation_item.lang !== nolan)
		// if the item is translatable select the all projects langs, else the item will be lg-nolan and only will has 1 item
		const situation_length = situation_translatable ? project_langs.length : 1;
		// get the total item for situation
		const situation_total = data.find(item =>  item.widget_id === output_item.id
			&& item.column === 'situation'
			&& item.type ==='total'
		)

		// node for the column situation
		const situation = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'situation',
			parent			: container
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
				text_content		: situation_total.value+'%',
				parent			: situation_total_node
			})

		// detail node with all languages
		const situation_detail = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'detail',
			parent			: situation
		})
		// situation detail
		for (let j = 0; j < situation_length; j++) {
			// select the language of for the item 'lg-spa, lg-eng, lg-cat, etc' else select the 'lg-nolan'
			const lang = situation_translatable ? project_langs[j].value : nolan
			const situation_items_data = data.find(item => item.widget_id === output_item.id
														&& item.column === 'situation'
														&& item.lang === lang
														&& item.type ==='detail')
			// build the label with the lang name
			const label_situation = ui.create_dom_element({
				element_type	: 'label',
				text_content	: (situation_translatable) ? project_langs[j].label+': ' : 'total :',
				parent			: situation_detail
			})
			// create the node with the value
			const item_situation = ui.create_dom_element({
				element_type	: 'span',
				class_name		: 'value',
				text_content	: (situation_items_data) ? situation_items_data.value+'%' : '0%',
				parent			: situation_detail
			})
			// build the label with the list name
			const datalist_item = (situation_items_data && situation_items_data.locator)
				? self.datalist.find(item => item.value.section_tipo === situation_items_data.locator.section_tipo
										  && same_section_id(item.value.section_id, situation_items_data.locator.section_id))
				: {label: ''}

			// label_list_situation
			ui.create_dom_element({
				element_type	: 'label',
				inner_html		: datalist_item ? datalist_item.label : '',
				parent			: situation_detail
			})
		} // end for (let j = 0; j < situation_length; j++)
	// State
		// check if the component is translatable, with the first item in the data of the current column
		const state_item = data.find(item => item.widget_id === output_item.id && item.column === 'state')
		// second, check if the item is translatable
		const state_translatable = (state_item.lang !== nolan)
		// if the item is translatable select the projects lang else the item is lg-nolan and only has 1 item
		const item_length = state_translatable ? project_langs.length : 1;

		const state_total = data.find(item =>  item.widget_id === output_item.id
											&& item.column === 'state'
											&& item.type ==='total')

		// node for state column
			const state = ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'state',
				parent			: container
			})
			// total
			const total_node = ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'total',
				parent			: state
			})
			// create the node with the value
			const total_value = ui.create_dom_element({
				element_type	: 'span',
				class_name		: 'value',
				text_content	: state_total.value+'%',
				parent			: total_node
			})

			// detail with all languages
			const detail = ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'detail',
				parent			: state
			})

		for (let k = 0; k < item_length; k++) {
			// select the language of for the item 'lg-spa, lg-eng, lg-cat, etc' else select the 'lg-nolan'
			const lang = state_translatable ? project_langs[k].value : nolan
			// find the data of the item with the lang
			const state_item_data = data.find(item =>  item.widget_id === output_item.id
														&& item.column === 'state'
														&& item.lang === lang
														&& item.type ==='detail')

			// label_state. build the label with the lang
			ui.create_dom_element({
				element_type	: 'label',
				text_content	: (state_translatable) ? project_langs[k].label+': ' : 'total :',
				parent			: detail
			})

			// item_state. create the node with the value
			ui.create_dom_element({
				element_type	: 'span',
				class_name		: 'value',
				text_content	: (state_item_data) ? state_item_data.value+'%' : '0%',
				parent			: detail
			})

			// build the label with the list name
			const datalist_item_status = (state_item_data && state_item_data.locator)
				? self.datalist.find(item => item.value.section_tipo === state_item_data.locator.section_tipo
										  && same_section_id(item.value.section_id, state_item_data.locator.section_id))
				: {label: ''}

			// label_list_state
			ui.create_dom_element({
				element_type	: 'label',
				inner_html		: datalist_item_status ? datalist_item_status.label : '',
				parent			: detail
			})
		}// end for (let k = 0; k < item_length; k++)


	return fragment
}//end get_value_tooltip



// @license-end
