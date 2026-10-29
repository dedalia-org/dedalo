// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_label, page_globals, SHOW_DEBUG, DEDALO_CORE_URL*/
/*eslint no-undef: "error"*/



/**
* RENDER_TOOL_NUMISDATA_ORDER_COINS
* Client-side render module for the numisdata_order_coins tool.
*
* This tool provides a two-panel interface for curating numismatic lots:
*   - LEFT panel  — a draggable coin mosaic (view_coins_mosaic_portal) showing
*     all coins that belong to the current lot, each with original/copy radio
*     buttons and a "snap" checkbox.
*   - RIGHT panel — an ordered portal (ordered_coins) where the user drops coins
*     to establish their final catalogue sequence.
*
* Header buttons let the user re-sort the left mosaic by weight (numisdata133)
* or diameter (numisdata135) before dragging, or designate originals vs. copies
* via `set_original_copy`.
*
* Drag-and-drop contract:
*   The left mosaic fires a native HTML5 'dragstart' event (via
*   view_coins_mosaic_portal → drag_and_drop.js → on_dragstart_mosaic).
*   The JSON payload transferred is  { locator: {section_id, section_tipo} }.
*   Drop targets are `.column_numisdata9` cells inside ordered_coins.  On drop,
*   `assign_element` inserts the locator into that cell's component, then
*   `get_ordered_coins` rebuilds the right panel.
*
* Exports: render_tool_numisdata_order_coins (constructor, used as prototype source)
*/
// imports
	import {event_manager} from '../../../core/common/js/event_manager.js'
	import * as touch_pick from '../../../core/common/js/touch_pick.js'
	import {ui} from '../../../core/common/js/ui.js'
	import {render_node_info, prepend_bubble} from '../../../core/common/js/utils/notifications.js'



/**
* RENDER_TOOL_NUMISDATA_ORDER_COINS
* Constructor / namespace for prototype methods.
* All rendering logic is attached to the prototype and mixed into the
* tool_numisdata_order_coins instance by tool_numisdata_order_coins.js.
* @returns {boolean} Always returns true (Dédalo constructor convention).
*/
export const render_tool_numisdata_order_coins = function() {

	return true
}//end render_tool_numisdata_order_coins



/**
* EDIT
* Builds and returns the full tool DOM wrapper in edit mode.
*
* Orchestration order:
*   1. Resolve content_data (two-panel layout with the coins mosaic).
*   2. Wrap it in the standard tool chrome via ui.tool.build_wrapper_edit.
*   3. Inject header-option buttons (order-by, set-original/copy).
*   4. Inject the activity-info strip (save notifications).
*   5. Trigger get_ordered_coins to populate the right panel and wire drop zones.
*
* When render_level==='content' the method returns the inner content_data node
* directly, bypassing the wrapper, for in-place refreshes.
*
* @param {{render_level?: string}} options - Render options.
*   render_level: 'full' (default) returns the complete wrapper;
*                 'content' returns only content_data for partial updates.
* @returns {Promise<HTMLElement>} wrapper (full) or content_data (content level).
*/
render_tool_numisdata_order_coins.prototype.edit = async function(options={render_level:'full'}) {

	const self = this

	// render level
		const render_level = options.render_level || 'full'

	// content_data
		const content_data = await get_content_data_edit(self)
		if (render_level==='content') {
			return content_data
		}

	// wrapper. ui build_edit returns component wrapper
		const wrapper = ui.tool.build_wrapper_edit(self, {
			content_data : content_data
		})

	// transcription_options are the buttons to get access to other tools (buttons in the header)
		const header_options_node = await render_header_options(self, content_data)
		wrapper.tool_buttons_container.appendChild(header_options_node)

	// render_activity_info are the information of the activity as "Save"
		const activity_info = render_activity_info(self)
		wrapper.activity_info_container.appendChild(activity_info)

		self.node = wrapper
		// set pointers
		wrapper.content_data = content_data
		get_ordered_coins(self)


	return wrapper
}//end edit



/**
* GET_CONTENT_DATA_EDIT
* Builds the two-panel content_data node for edit mode.
*
* Panel structure:
*   content_data
*   ├── left_container   — coins mosaic portal (self.coins, view: coins_mosaic)
*   └── right_container  — ordered coins drop target (filled by get_ordered_coins)
*
* The coins component receives a custom render_view entry before being rendered,
* injecting view_coins_mosaic_portal as the 'coins_mosaic' view.  The external
* window button is suppressed (show_interface.button_external = false) because the
* mosaic is intended to stay embedded in this tool's left panel.
*
* Pointers saved on content_data (.left_container, .right_container) allow
* downstream functions to locate the panels without re-querying the DOM.
*
* @param {Object} self - tool_numisdata_order_coins instance.
* @returns {Promise<HTMLElement>} content_data div containing both panels.
*/
const get_content_data_edit = async function(self) {

	const fragment = new DocumentFragment()

	// left_container
		const left_container = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'left_container',
			parent			: fragment
		})

	// component_epigraphy. render another node of component caller and append to container
		self.coins.render_views.push(
			{
				view	: 'coins_mosaic',
				mode	: 'edit',
				render	: 'view_coins_mosaic_portal',
				path 	: '../../../tools/tool_numisdata_order_coins/js/view_coins_mosaic_portal.js'
			}
		)
		self.coins.show_interface.button_external = false
		const coins_node = await self.coins.render()
		left_container.appendChild(coins_node)


	// right_container
		const right_container = ui.create_dom_element({
			element_type	: 'div',
			class_name 		: 'right_container',
			parent 			: fragment
		})


	// content_data
		const content_data = ui.tool.build_content_data(self)
		content_data.appendChild(fragment)
		// save the pointers of the content_data nodes, to used by the buttons to access to the components
		content_data.left_container		= left_container
		content_data.right_container	= right_container


	return content_data
}//end get_content_data_edit



/**
* RENDER_HEADER_OPTIONS
* Builds the header button strip and wires all interactive sort / action controls.
*
* Buttons created:
*   • "Order by:"  — static label (span, not interactive).
*   • "Weight"     — toggleable sort by numisdata133 (weight component).
*   • "Diameter"   — toggleable sort by numisdata135 (diameter component).
*   • "Set Original / Copy" — reads checked radio inputs from the left panel and
*     delegates to self.set_original_copy().
*
* Sort mechanics (inner `order_by` function):
*   When a sort button is toggled ON, the function:
*     1. Reads self.coins.datum.data, filtering items whose .tipo matches the
*        chosen criterion (e.g. 'numisdata133' for weight).
*     2. Sorts those items numerically ascending, with null values pushed to the end.
*     3. Maps each sorted datum back to self.coins.data.value to produce a
*        reordered array of coin locators.
*     4. Writes the reordered array into self.coins.data.value and rebuilds/re-renders
*        the coins portal in place.
*   When toggled OFF (button loses 'active' class), the coin locators are
*   re-sorted by section_id (i.e., restored to database insertion order).
*
* Event subscription:
*   Subscribes to the 'window_bur_<id>' event published by the coins portal when
*   its popout window closes.
*   (!) 'window_bur_' is a persistent typo for 'window_blur_' — the portal publishes
*   'window_blur_<id>' (see component_portal.js line ~2062). This subscription will
*   never fire. Flagged; do NOT fix here.
*
* @param {Object} self - tool_numisdata_order_coins instance.
* @param {HTMLElement} content_data - The two-panel content_data node (used to
*   locate left_container when collecting radio-button selections).
* @returns {Promise<DocumentFragment>} Fragment containing all header controls.
*/
const render_header_options = async function(self, content_data) {

	const fragment = new DocumentFragment()

	// "Order by:" is the CAPTION of the two sort toggles, not a control. It was
	// classed `tool_button … light`, which under the shared header contract gave
	// it a button's height and fill beside the real buttons — a dead, unfillable
	// button. `top_label` is the class the band's caption idiom names (the same
	// one tool_indexation uses for SHOW / APPROACH), so it now renders as the
	// caption it is. Nothing selects `.order_by` (the `order_by` hits elsewhere
	// in this file are the sort FUNCTION), so dropping it is safe.
	const order_by_label = ui.create_dom_element({
		element_type	: 'span',
		class_name		: 'top_label',
		text_content	: self.get_tool_label('order_by') || 'Order by:',
		parent			: fragment
	})

	const order_active = {}

	// set a order object to define the current active option

	const order_by_weight = ui.create_dom_element({
		element_type	: 'button',
		class_name		: 'tool_button order_by_weight light',
		text_content	: self.get_tool_label('weight') || 'Weight',
		parent			: fragment
	})
	// mouseup event
	const order_by_weight_mouseup_handler = (e) => {
		e.stopPropagation()

		// deactivate the competing sort button before toggling this one
		order_by_diameter.classList.remove('active')

		order_active.button_node	= order_by_weight
		order_active.tipo			= 'numisdata133'

		order_by(order_active)
	}
	order_by_weight.addEventListener('mouseup', order_by_weight_mouseup_handler)

	const order_by_diameter = ui.create_dom_element({
		element_type	: 'button',
		class_name		: 'tool_button order_by_diameter light',
		text_content	: self.get_tool_label('diameter') || 'Diameter',
		parent			: fragment
	})
	// mouseup event
	const order_by_diameter_mouseup_handler = (e) => {
		e.stopPropagation()

		// deactivate the competing sort button before toggling this one
		order_by_weight.classList.remove('active')

		order_active.button_node	= order_by_diameter
		order_active.tipo			= 'numisdata135'

		order_by(order_active)
	}
	order_by_diameter.addEventListener('mouseup', order_by_diameter_mouseup_handler)

	// subscribe to window_blur of the portal coins
	// (!) The event name 'window_bur_<id>' is a typo for 'window_blur_<id>'.
	// component_portal publishes 'window_blur_<id>' (see component_portal.js ~line 2062).
	// This subscription will never receive the event. Must be fixed in code, not here.
	const fn_reorder = () => {
		if (!order_active.button_node) {
			return
		}
		// When the portal's external window closes, deactivate the sort button
		// and re-apply the sort so the coins order reflects the current state.
		order_active.button_node.classList.remove('active')
		order_by(order_active)
	}
	self.events_tokens.push(
		event_manager.subscribe('window_blur_'+self.coins.id, fn_reorder)
	)

	// order_by, get data and order by components or by section_id
	const order_by = async function (options) {

		// options
		const button_node	= options.button_node
		const tipo			= options.tipo

		// toggle 'active' class: ON = sort by component value, OFF = reset to section_id order
		button_node.classList.toggle('active')

		const data = self.coins.data
		const order_data_value = []

		// if the button is active order by the component
		// else order by id (reorder the original data)
		if(button_node.classList.contains('active')){
			// Collect datum items for the chosen measurement tipo, sort them ascending.
			// Null/missing values are pushed to the end (sort trick: (null===null)-(b===null) === 0-1 === -1).
			const weight_data	= self.coins.datum.data.filter(el => el.tipo === tipo)
			const order_weight	= weight_data.sort(function(a, b) {
				//check if the values are valid if not set null
				const a_value = a.value && a.value[0] ? a.value[0] : null
				const b_value = b.value && b.value[0] ? b.value[0] : null
				// order null values to end and lower data first ---> 0.1, 0.5, 1, 8, null
				return (a_value === null) - (b_value === null) || a_value - b_value;
			});
			// use the component order (diameter or weight) and apply to data of the coins portal data
			// Walk the sorted weight/diameter items and find the matching coin locator in data.value.
			const weight_data_len = weight_data.length
			for (let i = 0; i < weight_data_len; i++) {
				const section_id	= weight_data[i].section_id
				const value_order	= data.value.find(el=>el.section_id === section_id)
				if (value_order) {
					order_data_value.push(value_order)
				}
			}
		}else{
			// order by original section_id
			// Restore the canonical (database insertion) order when the sort is toggled off.
			const order_data = data.value.sort(function(a, b) {
				return a.section_id - b.section_id;
			});

			order_data_value.push(...order_data)
		}
		// set the order data to the component build and render it and append to the left container
		self.coins.data.value = order_data_value
		await self.coins.build(false)
		self.coins.render('content')
	}

	// set_original_button
	const set_original_button = ui.create_dom_element({
		element_type	: 'button',
		class_name		: 'tool_button set_original light',
		text_content	: self.get_tool_label('original_copy') || 'Set Original / Copy',
		parent			: fragment
	})
	//  mouseup event
	const set_original_button_mouseup_handler = (e) => {
		e.stopPropagation()

		const left_container = self.node.content_data.left_container

		// Collect all checked radio inputs for "original" and "copy" designations.
		// The radio buttons are rendered per coin by view_coins_mosaic_portal →
		// render_column_original_copy; input.section_id holds the coin's section_id.
		const input_original_nodes	= left_container.querySelectorAll('input.input_original')
		const input_copy_nodes		= left_container.querySelectorAll('input.input_copy')

		const ar_original = Array.from(input_original_nodes).filter(input => input.checked);
		const ar_copies   = Array.from(input_copy_nodes).filter(input => input.checked);

		self.set_original_copy({
			ar_original	: ar_original,
			ar_copies	: ar_copies
		})
	}
	set_original_button.addEventListener('mouseup', set_original_button_mouseup_handler)


	return fragment
}//end render_header_options



/**
* RENDER_ACTIVITY_INFO
* Builds the activity-info strip that shows save notifications below the header.
*
* Subscribes to the global 'save' event.  When a save completes, the handler
* prepends a render_node_info notification node to the strip, providing visual
* feedback (e.g. "Saved" or error details) without navigating away.
*
* The returned node is appended to wrapper.activity_info_container by the
* caller (edit).
*
* @param {Object} self - tool_numisdata_order_coins instance.
*   self.events_tokens receives the event subscription token for later cleanup.
* @returns {HTMLElement} activity_info_body div that accumulates notification nodes.
*/
const render_activity_info = function(self) {

	// activity alert
		const activity_info_body = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'activity_info_body'
		})

	// event save
		self.events_tokens.push(
			event_manager.subscribe('save', fn_saved)
		)
		function fn_saved(options) {

			// received options contains an object with instance and api_response
			const node_info_options = Object.assign(options,{
				container : activity_info_body
			})

			// render notification node
			const node_info = render_node_info(node_info_options)
			prepend_bubble(activity_info_body, node_info)
		}


	return activity_info_body
}//end render_activity_info



/**
* GET_ORDERED_COINS
* Builds (or rebuilds) the right-panel ordered-coins portal and wires drag-drop
* targets after every refresh.
*
* Steps:
*   1. Clears the right_container DOM (removes previous render).
*   2. Destroys the existing ordered_coins component instance tree
*      (instance=false so the JS instance is kept, delete_dependencies=true,
*       remove_dom=true).
*   3. Rebuilds ordered_coins from data (autoload=true).
*   4. Configures show_interface: add button visible, autocomplete hidden.
*   5. Renders and appends the new portal node.
*   6. Calls prototype.drop() to attach dragover/dragleave/drop listeners to every
*      `.column_numisdata9` cell in the refreshed portal.
*
* This function is called once on initial render and again after each successful
* coin drop (inside drop's promise handler) to reflect the updated ordered list.
*
* Note: The commented-out event subscriptions below the destroy call were an
* earlier approach that delegated drop re-wiring to event callbacks; they have been
* replaced by the direct prototype.drop() call at the bottom of this function.
*
* @param {Object} self - tool_numisdata_order_coins instance.
* @returns {Promise<void>}
*/
const get_ordered_coins = async function(self){

	const right_container = self.node.content_data.right_container

	// clean the coins container
		while (right_container.firstChild) {
			right_container.removeChild(right_container.firstChild);
		}

	// Coins
		const coins_container = ui.create_dom_element({
			element_type	: 'div',
			class_name 		: 'coins_container',
			parent 			: right_container
		})

	await self.ordered_coins.destroy(false, true, true) // instance=false, delete_dependencies=true, remove_dom=true
	await self.ordered_coins.build(true)
	self.ordered_coins.show_interface.button_add		= true
	self.ordered_coins.show_interface.show_autocomplete	= false


	const ordered_coins_node = await self.ordered_coins.render()
	coins_container.appendChild(ordered_coins_node)

	// listen the portal refreshed in other window and assign the drop events to refreshed nodes
	// self.ordered_coins.events_tokens.push(
	// 	event_manager.subscribe('window_bur_'+ self.ordered_coins.id, assing_drop)
	// )
	// self.ordered_coins.events_tokens.push(
	// 	event_manager.subscribe('add_row_'+ self.ordered_coins.id, assing_drop)
	// )

	// function assing_drop(options) {

	// 	drop({
	// 		self : self
	// 	})
	// }

	render_tool_numisdata_order_coins.prototype.drop({
		self : self
	})
}//end get_ordered_coins



/**
* DROP
* Attaches HTML5 drag-and-drop event listeners to every `.column_numisdata9` cell
* in the ordered-coins portal, turning them into active drop targets.
*
* Event flow per target cell:
*   dragover  — prevents default (enables drop), sets dropEffect='move', adds
*               CSS class 'dragover', removes 'drop'.
*   dragleave — prevents default, removes CSS class 'dragover'.
*   drop      — prevents default; reads the JSON payload transferred by
*               on_dragstart_mosaic ({locator: {section_id, section_tipo}});
*               calls self.assign_element({caller, locator}) which performs a
*               change_value insert on the target cell's component_instance;
*               on resolution, rebuilds the right panel via get_ordered_coins and
*               marks the dragged coin's mosaic icon as 'used'.
*
* The iteration runs in reverse (drop_zones_len-1 → 0) because attaching listeners
* in reverse order is the Dédalo convention for live NodeLists — it has no
* functional impact here since ar_drop_nodes is a static snapshot (querySelectorAll).
*
* The 'used' class is applied to '#col_original .drag' of the source coin record.
* The source record is found by matching section_id, section_tipo, and excluding the
* 'hover' id_variant so only the visible mosaic tile is updated.
*
* (!) This method is called as render_tool_numisdata_order_coins.prototype.drop({self})
* rather than self.drop({self}), so `this` inside the function body is the prototype
* object, not the tool instance.  All instance access must go via the passed `self`.
*
* @param {{self: Object}} options
*   self: tool_numisdata_order_coins instance. Must have .ordered_coins.node and
*         .coins.ar_instances populated before this call.
* @returns {void}
*/
render_tool_numisdata_order_coins.prototype.drop = function (options) {

	const self			= options.self
	// querySelectorAll returns a static NodeList; column_numisdata9 is the
	// ontology tipo for the "ordered item" column inside ordered_coins portal rows.
	const ar_drop_nodes = self.ordered_coins.node.querySelectorAll('.column_numisdata9')

	const drop_zones_len = ar_drop_nodes.length
	for (let i = drop_zones_len - 1; i >= 0; i--) {

		const current_node = ar_drop_nodes[i]

		// dragover event
			current_node.addEventListener('dragover',function(e){
				e.preventDefault()
				e.stopPropagation()
				e.dataTransfer.dropEffect = 'move'
				// css
					current_node.classList.add('dragover')
					current_node.classList.remove('drop')
			},false)

			// dragleave event
				current_node.addEventListener('dragleave',function(e){
					e.preventDefault()
					e.stopPropagation()
					e.dataTransfer.dropEffect = 'move'
					// css
						current_node.classList.remove('dragover')
				},false)

			// place: the drop's body, shared by the mouse drop and the touch
			// placement below (one implementation, two gestures)
				const place = function(data) {

					// css
						current_node.classList.remove('dragover')
						current_node.classList.add('drop_ordered_coins')

					// the drag element will sent the data of the original position, the source_key
						const data_parse = JSON.parse(data)

					// assign element to target portal
						self.assign_element({
							caller 	: current_node.component_instance,
							locator : data_parse.locator
						}).then( response =>{
							// Rebuild the right panel to reflect the newly inserted coin.
							get_ordered_coins(self)

							// change the drag icon to show as used
							const draged_section_record = self.coins.ar_instances.find(el =>
								el.section_id === data_parse.locator.section_id
								&& el.section_tipo === data_parse.locator.section_tipo
								&& el.id_variant !== 'hover'
							)
							// select the drag node and add the class used
							if(draged_section_record){
								draged_section_record.node.querySelector('#col_original .drag').classList.add('used')
							}
						})
				}

			// drop event
				current_node.addEventListener('drop', function(e){
					e.preventDefault()
					e.stopPropagation()
					place(e.dataTransfer.getData('text/plain'))
				},false)

			// touch placement: a coin picked by a tap (touch_pick.js — a finger
			// cannot drag) is placed by a tap on this slot
				current_node.addEventListener('click', function(e){
					if (!touch_pick.active()) {
						return
					}
					e.preventDefault()
					e.stopPropagation()
					place(touch_pick.as_drop_event().dataTransfer.getData('text/plain'))
				},false)
	}// end for (let i = drop_zones_len - 1; i >= 0; i--)
}//end drop



// @license-end
