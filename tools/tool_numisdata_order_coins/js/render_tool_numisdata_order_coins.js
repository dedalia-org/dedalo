// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_label, page_globals, SHOW_DEBUG, DEDALO_CORE_URL*/
/*eslint no-undef: "error"*/



	import {lock_rows} from '../../../core/common/js/common.js'
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
* Drag-and-drop contract (WC-2026-10-30-section-record-row-box):
*   The left mosaic is a tool row source (view_coins_mosaic_portal →
*   drag_and_drop.js bind_tool_row_drag): its 'text/plain' JSON payload carries
*   the dragged row's entry as `locator` ({section_id, section_tipo, …}).
*   Drop targets are the `.column_numisdata9` cells of the ordered_coins rows,
*   handled by ONE delegated listener set on the ordered_coins wrapper
*   (bind_ordered_coins_drop): the row is resolved with record_window `row_of`,
*   its record with the row window's `record_at` — never a node pointer. On
*   drop, `assign_element` inserts the locator into that cell's component, then
*   `get_ordered_coins` rebuilds the right panel.
*
* Exports: render_tool_numisdata_order_coins (constructor, used as prototype source);
* ORDERED_COINS_SLOT, drop_target_of, mark_coin_used, bind_ordered_coins_drop
* (the delegated drop target, exported for its hermetic gate
* tool_numisdata_order_coins_drop_native).
*/
// imports
	import {event_manager} from '../../../core/common/js/event_manager.js'
	import * as touch_pick from '../../../core/common/js/touch_pick.js'
	import {ui} from '../../../core/common/js/ui.js'
	import {prepend_bubble, render_node_info} from '../../../core/common/js/utils/notifications.js'
	import {row_of} from '../../../core/section_record/js/record_window.js'



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

		// row lock: a re-order is a row-set operation on the coins mosaic. Its
		// rows are committed and frozen BEFORE anything changes; a refusal (a
		// pending edit the user keeps) changes nothing, the button included
		// (common.lock_rows, WC-2026-10-30-section-record-row-box)
		const release = await lock_rows(self.coins)
		if (!release) {
			return false
		}
		try {

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
				weight_data.sort(function(a, b) {
					//check if the values are valid if not set null
					const a_value = a.value?.[0] ? a.value[0] : null
					const b_value = b.value?.[0] ? b.value[0] : null
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
			await self.coins.render('content')

		} finally {
			release()
		}

		return true
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
*   0. Takes the ordered_coins row lock (common.lock_rows): a pending edit the
*      user keeps refuses the rebuild and nothing changes.
*   1. Clears the right_container DOM (removes previous render).
*   2. Destroys the existing ordered_coins component instance tree
*      (instance=false so the JS instance is kept, delete_dependencies=true,
*       remove_dom=true).
*   3. Rebuilds ordered_coins from data (autoload=true).
*   4. Configures show_interface: add button visible, autocomplete hidden.
*   5. Renders and appends the new portal node.
*   6. Binds the delegated drop handler (bind_ordered_coins_drop) on the new
*      portal wrapper: its `.column_numisdata9` cells become drop targets.
*
* This function is called once on initial render and again after each successful
* coin drop (inside drop's promise handler) to reflect the updated ordered list.
*
* The drop handler sits on the portal WRAPPER and resolves the current
* content_data at each event, so it survives the portal's own content renders
* (page change, add) — only this full rebuild needs a new binding.
*
* @param {Object} self - tool_numisdata_order_coins instance.
* @returns {Promise<boolean>} false when the row lock was refused (nothing changed)
*/
const get_ordered_coins = async function(self){

	const right_container = self.node.content_data.right_container

	// row lock: the rebuild is a row-set operation on ordered_coins. Its rows
	// are committed and frozen before the destroy; a refusal (a pending edit
	// the user keeps) leaves the panel as it is
	// (common.lock_rows, WC-2026-10-30-section-record-row-box)
	const release = await lock_rows(self.ordered_coins)
	if (!release) {
		return false
	}
	let ordered_coins_node
	try {
		// clean the coins container
		while (right_container.firstChild) {
			right_container.removeChild(right_container.firstChild);
		}

		await self.ordered_coins.destroy(false, true, true) // instance=false, delete_dependencies=true, remove_dom=true
		await self.ordered_coins.build(true)
		self.ordered_coins.show_interface.button_add		= true
		self.ordered_coins.show_interface.show_autocomplete	= false

		ordered_coins_node = await self.ordered_coins.render()
	} finally {
		release()
	}

	// Coins
	const coins_container = ui.create_dom_element({
		element_type	: 'div',
		class_name 		: 'coins_container',
		parent 			: right_container
	})
	coins_container.appendChild(ordered_coins_node)

	bind_ordered_coins_drop(self, ordered_coins_node)


	return true
}//end get_ordered_coins



/**
* ORDERED_COINS_SLOT
* The column (component tipo) of an ordered_coins row that receives a coin: its
* `.column_<tipo>` cell is the drop slot and the row record's instance with that
* `column_id` is the component the coin is assigned to. ONE spelling for both reads.
* @type {string}
*/
export const ORDERED_COINS_SLOT = 'numisdata9'



/**
* DROP_TARGET_OF
* Resolve the ordered-coins drop slot an event is over: the row through
* record_window `row_of` (exact through nested records), then its OWN
* `.column_numisdata9` cell (a direct child of the row), and the slot's
* component from the row's built record (`record_at`) — never a node pointer.
* Read at event time (the wrapper's content_data pointer is the one the
* portal's content renders keep current), so a page change or an add never
* leaves a stale target.
* @param {Object} self - tool_numisdata_order_coins instance
* @param {HTMLElement} wrapper - The ordered_coins wrapper the listener sits on
* @param {Event} event
* @returns {{cell: HTMLElement, index: number, component: Object|null}|null}
*/
export const drop_target_of = function(self, wrapper, event) {

	const content_data	= wrapper.content_data || null
	const record_window	= self.ordered_coins?.record_windows?.rows || null
	if (!content_data || !record_window || !event.target) {
		return null
	}

	const hit = row_of(content_data, event.target)
	if (!hit || hit.node.classList.contains('placeholder')) {
		return null
	}
	const element	= event.target.nodeType===3 ? event.target.parentElement : event.target
	const cell		= element ? element.closest(`.column_${ORDERED_COINS_SLOT}`) : null
	if (!cell || cell.parentElement!==hit.node) {
		return null
	}

	const section_record	= record_window.record_at(hit.index)
	const component			= (section_record?.ar_instances || []).find(instance => instance.column_id===ORDERED_COINS_SLOT) || null


	return {
		cell		: cell,
		index		: hit.index,
		component	: component
	}
}//end drop_target_of



/**
* MARK_COIN_USED
* Mark the dragged coin's tile in the left mosaic as used. The tile is found
* through the mosaic's row window: its frozen entries give the row index, the
* row is `content_data.children[index]` (placeholders hold nothing to mark; a
* tile built later reads the refreshed ordered_coins datum at render).
* @param {Object} self - tool_numisdata_order_coins instance
* @param {Object} locator - {section_tipo, section_id} of the dragged coin
* @returns {void}
*/
export const mark_coin_used = function(self, locator) {

	const coins			= self.coins
	const record_window	= coins?.record_windows?.rows || null
	const content_data	= coins?.node?.content_data || null
	if (!record_window || !content_data || !locator) {
		return
	}

	for (let i = 0; i < record_window.size; i++) {
		const entry = record_window.entry_of(i)
		if (!entry || entry.section_tipo!==locator.section_tipo || String(entry.section_id)!==String(locator.section_id)) {
			continue
		}
		const row	= content_data.children[i]
		const drag	= row ? row.querySelector(':scope > .column_original .drag') : null
		if (drag) {
			drag.classList.add('used')
		}
	}
}//end mark_coin_used



/**
* BIND_ORDERED_COINS_DROP
* Turns the `.column_numisdata9` cells of the ordered-coins portal into drop
* targets with ONE delegated listener set on the portal wrapper (the wrapper
* lives as long as this full render; get_ordered_coins rebuilds it, and binds
* again, after every drop). The slot is resolved per event (drop_target_of).
*
* Event flow:
*   dragover  — over a slot: prevents default (enables drop), sets
*               dropEffect='move', marks the slot 'dragover'.
*   dragleave — leaving a slot: removes its 'dragover' mark.
*   drop      — on a slot: reads the 'text/plain' JSON payload of the mosaic
*               (bind_tool_row_drag: {locator, …}); `assign_element` performs a
*               change_value insert on the slot's component; on resolution the
*               right panel is rebuilt (get_ordered_coins) and the coin's mosaic
*               tile is marked used.
*   click     — the touch placement: a coin picked by a tap (touch_pick.js — a
*               finger cannot drag) is placed by a tap on a slot.
* Anywhere that is not a slot, every handler returns WITHOUT preventDefault /
* stopPropagation, so the portal's own handlers and its ancestors decide.
*
* Idempotent per wrapper: the portal's own refreshes (window_blur_, add_row_)
* call it again with the CURRENT wrapper node; a wrapper already bound is left as
* is, and a full refresh's new wrapper gets its listener set.
*
* @param {Object} self - tool_numisdata_order_coins instance.
* @param {HTMLElement} wrapper - The ordered_coins wrapper node.
* @returns {boolean} true when bound (now or before)
*/
const bound_ordered_coins_wrappers = new WeakSet()
export const bind_ordered_coins_drop = function(self, wrapper) {

	if (!wrapper) {
		return false
	}
	if (bound_ordered_coins_wrappers.has(wrapper)) {
		return true
	}
	bound_ordered_coins_wrappers.add(wrapper)

	// place: the drop's body, shared by the mouse drop and the touch placement
	// (one implementation, two gestures)
		const place = function(target, data) {

			// css
				target.cell.classList.remove('dragover')
				target.cell.classList.add('drop_ordered_coins')

			// the payload of the mosaic row (bind_tool_row_drag)
				let data_parse = null
				try {
					data_parse = JSON.parse(data)
				} catch (error) {
					console.error('[tool_numisdata_order_coins] invalid drop payload:', error);
					return
				}
				const locator = data_parse?.locator
				if (!locator || !target.component) {
					console.error('[tool_numisdata_order_coins] drop without locator or slot component', {locator, index: target.index});
					return
				}

			// assign element to target portal
				self.assign_element({
					caller	: target.component,
					locator	: locator
				}).then(() => {
					// Rebuild the right panel to reflect the newly inserted coin.
					get_ordered_coins(self)
					// change the drag icon to show as used
					mark_coin_used(self, locator)
				})
		}

	// dragover event
		wrapper.addEventListener('dragover', function(e) {
			const target = drop_target_of(self, wrapper, e)
			if (!target) {
				return
			}
			e.preventDefault()
			e.stopPropagation()
			e.dataTransfer.dropEffect = 'move'
			// css
				target.cell.classList.add('dragover')
				target.cell.classList.remove('drop')
		})

	// dragleave event
		wrapper.addEventListener('dragleave', function(e) {
			const target = drop_target_of(self, wrapper, e)
			if (!target || (e.relatedTarget && target.cell.contains(e.relatedTarget))) {
				return
			}
			target.cell.classList.remove('dragover')
		})

	// drop event
		wrapper.addEventListener('drop', function(e) {
			const target = drop_target_of(self, wrapper, e)
			if (!target) {
				return
			}
			e.preventDefault()
			e.stopPropagation()
			place(target, e.dataTransfer.getData('text/plain'))
		})

	// touch placement: a coin picked by a tap is placed by a tap on a slot
		wrapper.addEventListener('click', function(e) {
			if (!touch_pick.active()) {
				return
			}
			const target = drop_target_of(self, wrapper, e)
			if (!target) {
				return
			}
			e.preventDefault()
			e.stopPropagation()
			place(target, touch_pick.as_drop_event().dataTransfer.getData('text/plain'))
		})


	return true
}//end bind_ordered_coins_drop



// @license-end
