// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global  */
/*eslint no-undef: "error"*/



/**
* VIEW_COINS_MOSAIC_PORTAL
*
* Custom `component_portal` view module for the `tool_numisdata_order_coins` tool.
* Renders the left-hand source panel — the "coins mosaic" — where a numismatic portal
* is displayed as a draggable tile grid that the user can drag from to populate the
* ordered coins list on the right.
*
* Architecture overview
* ---------------------
* This module is dynamically imported and registered as a custom view by
* `render_tool_numisdata_order_coins.get_content_data_edit`, which pushes an entry
* into `self.coins.render_views`:
*
*   { view: 'coins_mosaic', mode: 'edit', render: 'view_coins_mosaic_portal',
*     path: '../../../tools/tool_numisdata_order_coins/js/view_coins_mosaic_portal.js' }
*
* The portal render dispatcher (`render_edit_component_portal.prototype.edit`) then
* calls `view_coins_mosaic_portal.render(self, options)` when `self.context.view`
* equals `'coins_mosaic'`.
*
* Rows (WC-2026-10-30-section-record-row-box; audit P2-31 / CLI-29 / CLI-30)
* -------------------------------------------------------------------------
* This is a `component_portal` in EDIT mode, i.e. behind the paginator's
* "show all" door, whose page is `max_page_limit()`. Its rows therefore go
* through the row window door exactly like every core portal edit view:
* `get_content_data` hands the page's entries to section.js
* `window_section_rows` — the TILE is the row (`content_data.children[i]` is row
* i), at most ROW_WINDOW_MAX_ROWS are built at once (placeholders beyond) — on
* every content render, N=0 included.
*
*   1. TILE records (in_mosaic === true columns) — the visible draggable tiles.
*      Each tile renders its coin image plus an "Info" column produced by
*      `render_column_original_copy`, which exposes:
*        - Original / Copy radio buttons (wired to tipo numisdata157, the discard
*          component).  Value '1' = original, '2' = copy (stored in numisdata341).
*        - Snap checkbox: adds/removes the CSS class `snap` on the tile,
*          locking the tile's aspect ratio for visual alignment.
*        - A drag indicator div (`div.drag`) that becomes `div.drag.used` once the
*          coin has been assigned to an ordered position.
*
*   2. HOVER record (hover === true columns, `id_variant: 'hover'`) — a lightweight
*      detail panel built LAZILY by core's row_hover.js `delegate_row_hover`
*      (one delegated pointer listener set on the content_data): on hover ONE
*      overlay record is built through section.js `build_section_record_for`
*      and prepended into the tile; it leaves with the pointer, flushed first.
*
* Drag-and-drop integration
* -------------------------
* The window stamps every built tile `draggable`; drag_and_drop.js
* `bind_tool_row_drag` puts ONE delegated dragstart (+ the touch_pick tap) on
* the content_data, riding the window's signal. Its payload is the row's frozen
* entry (`get_row_transfer_data`), `text/plain` only — what the ordered-coins
* slots read (render_tool_numisdata_order_coins: the delegated slot handler) —
* never the portal MIME type, so every portal drop handler treats it as foreign.
*
* Columns map contract
* --------------------
* `self.columns_map` is an Array of column descriptor objects.  Each descriptor
* may carry the boolean flags:
*   - `in_mosaic : true`  — include this column in the main mosaic tiles.
*   - `hover     : true`  — include this column in the hover detail panel.
*
* `rebuild_columns_map` prepends a `section_id` column (for hover view only) and
* appends the custom `original` info column (for mosaic view only).
*
* Exported symbols
*   view_coins_mosaic_portal          — constructor (no-op, used as namespace)
*   view_coins_mosaic_portal.render   — async render entry point
*
* @module view_coins_mosaic_portal
* @see render_tool_numisdata_order_coins.js  for the parent tool render layer.
* @see tool_numisdata_order_coins.js         for the tool constructor and set_original_copy.
* @see core/component_portal/js/drag_and_drop.js  for bind_tool_row_drag.
*/



// imports
	import {window_section_rows, build_section_record_for} from '../../../core/section/js/section.js'
	import {place_list_after} from '../../../core/common/js/common.js'
	import {delegate_row_hover} from '../../../core/section_record/js/row_hover.js'
	import {ui} from '../../../core/common/js/ui.js'
	import {
		render_column_id,
		get_buttons,
		activate_autocomplete,
		render_list_after
	} from '../../../core/component_portal/js/render_edit_component_portal.js'
	import {bind_tool_row_drag} from '../../../core/component_portal/js/drag_and_drop.js'



/**
* VIEW_COINS_MOSAIC_PORTAL
* Constructor / namespace object for the coins-mosaic portal view.
* All functionality lives on the static `.render` method; the constructor
* itself is a no-op placeholder that returns `true`.
*/
export const view_coins_mosaic_portal = function() {

	return true
}//end view_coins_mosaic_portal



/**
* RENDER
* Manages the component's logic and appearance in client side
*
* Entry point called by the `component_portal` render dispatcher when
* `self.context.view === 'coins_mosaic'`.  The row window builds the draggable
* mosaic tiles; the hover controller builds the detail panel of the hovered
* tile on demand. Assembles and returns the full wrapper node.
*
* When `options.render_level === 'content'` (e.g. during a refresh cycle)
* only the inner `content_data` HTMLElement is returned, skipping the wrapper
* scaffold so the caller can splice it into an existing DOM tree.
*
* Side effects:
*   - The row window (and the hover controller, for its overlay) pushes the live
*     section-record instances onto `self.ar_instances` so they are destroyed
*     when the portal is rebuilt or destroyed.
*   - Attaches a click listener on the wrapper that lazily activates the
*     autocomplete service (via `activate_autocomplete`) when `self.active`.
*
* @param {Object} self    - The `component_portal` instance acting as caller.
*                           Key properties consumed:
*                           `self.columns_map` {Array}   — column descriptors (see module header).
*                           `self.ar_instances` {Array}  — accumulator for created instances.
*                           `self.permissions` {number}  — 1=read-only, 2=edit.
*                           `self.mode` {string}         — current mode string (e.g. 'edit').
*                           `self.view` {string}         — resolved view name.
*                           `self.context.view` {string} — context view (echoed onto wrapper class).
*                           `self.total` {number}        — total records.
*                           `self.active` {boolean}      — whether the component is focused.
* @param {Object} options - Render options.
*   @param {string} [options.render_level='full'] - 'full' builds the complete wrapper;
*          'content' returns only the inner content_data node.
* @returns {Promise<HTMLElement>} The assembled wrapper node (render_level='full') or
*          the content_data div (render_level='content').
*/
view_coins_mosaic_portal.render = async function(self, options) {
	// options
		const render_level 	= options.render_level || 'full'


	// hover columns. The overlay's column slice (one section_record per row)
		const hover_columns		= self.columns_map.filter(el => el.hover===true)
		const hover_columns_map	= await rebuild_columns_map(hover_columns, self, false)

	// content_data. Create the mosaic with only the marked ddo as "mosaic" with true value
		// columns_map

			const base_columns_map	= self.columns_map.filter(el => el.in_mosaic===true)
			const columns_map		= await rebuild_columns_map(base_columns_map, self, true)

		// rows. The page's locator entries; instances are built by the row window
			const rows			= self.data?.entries || []
			self.ar_instances	= self.ar_instances || []

		// content_data
			const content_data = await get_content_data(self, rows, {
				columns_map			: columns_map,
				hover_columns_map	: hover_columns_map
			})


		// render_level
			if (render_level==='content') {
				return content_data
			}

		// list_body
			const list_body = ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'list_body ' + self.mode +  ' view_'+self.view,
			})

			list_body.appendChild(content_data)


	// buttons
		const buttons = (self.permissions > 1)
			? get_buttons(self)
			: null

	// top
		// const top = get_top(self)

	// wrapper. ui build_edit returns component wrapper
		const wrapper = ui.component.build_wrapper_edit(self, {
			// content_data	: content_data,
			buttons			: buttons,
			list_body		: list_body
			// top			: top
		})
		wrapper.classList.add('portal', 'view_'+self.context.view)
		// set pointers
		wrapper.list_body		= list_body
		wrapper.content_data	= content_data

	// list_after. The non-row sibling (print notice), after list_body
		place_list_after(wrapper, content_data)

	// autocomplete
		wrapper.addEventListener('click', function(e) {
			e.stopPropagation()
			setTimeout(function(){
				if (self.active) {
					activate_autocomplete(self, wrapper)
				}
			}, 1)
		})



	return wrapper
}//end render



/**
* GET_CONTENT_DATA
* Build the `content_data` node and hand the page's entries to the row window
* door (section.js window_section_rows; WC-2026-10-30-section-record-row-box):
* the tile of row i is `content_data.children[i]`, built through the door (one
* section_record per row, registered in `self.ar_instances`) — at most
* ROW_WINDOW_MAX_ROWS at once (audit P2-31 / CLI-29 / CLI-30: this portal is in
* EDIT mode, so "show all" can bring a `max_page_limit()` page). Called on every
* content render, N=0 included.
*
* On the window it installs, once per content_data:
*   - the tool drag source (drag_and_drop.js bind_tool_row_drag): delegated
*     dragstart + touch_pick tap, so tiles can be dropped onto the ordered-coins
*     right panel;
*   - the lazy hover detail panel (row_hover.js delegate_row_hover).
* Nothing but rows goes into content_data: the print notice travels in
* `content_data.list_after` (render_list_after).
*
* @param {Object} self - The component_portal instance.
* @param {Array}  rows - The page's locator entries (`self.data.entries`).
* @param {Object} maps
* @param {Array}  maps.columns_map       - The `in_mosaic` columns (tile).
* @param {Array}  maps.hover_columns_map - The `hover` columns (overlay).
* @returns {Promise<HTMLElement>} The content_data div holding the windowed rows.
*/
const get_content_data = async function(self, rows, maps) {

	// content_data
		const content_data = ui.component.build_content_data(self)

	// row window
		const record_window = await window_section_rows({
			caller			: self,
			container		: content_data,
			rows			: rows,
			records_options	: {
				mode		: 'list',
				columns_map	: maps.columns_map
			},
			layout			: 'list',
			// tool source: today's unconditional stamping (drag_and_drop.js
			// TOOL_ROW_SOURCES; the ordered-coins slot validates the payload)
			draggable_rows	: true
		})

	// delegated drag source + lazy hover panel (both ride the window's signal)
		if (record_window) {
			bind_tool_row_drag(self, content_data)
			delegate_row_hover({
				caller			: self,
				content_data	: content_data,
				signal			: record_window.signal,
				render_hover	: (index) => render_hover_view(self, record_window, index, maps.hover_columns_map)
			})
		}

	// list_after. The print notice only: this panel never listed references
		content_data.list_after = render_list_after(self, {
			references		: false,
			content_data	: content_data,
			record_window	: record_window
		})


	return content_data
}//end get_content_data



/**
* RENDER_HOVER_VIEW
* The hover controller's `render_hover` (row_hover.js): builds and renders ONE
* tile's detail panel (hover columns, `id_variant: 'hover'`) through section.js
* `build_section_record_for` — never get_section_records. The controller
* prepends the returned node into the tile (marking it `.sr_mosaic_hover`) and
* registers the instance; it also owns its teardown.
* @param {Object} self - The component_portal instance.
* @param {Object} record_window - The tile window (entries come from it).
* @param {number} index - The hovered row.
* @param {Array} hover_columns_map - The `hover` columns.
* @returns {Promise<{instance: Object, node: HTMLElement}|null>}
*/
const render_hover_view = async function(self, record_window, index, hover_columns_map) {

	const entry = record_window.entry_of(index)
	if (!entry) {
		return null
	}

	const instance = await build_section_record_for(self, entry, {
		mode			: 'list',
		columns_map		: hover_columns_map,
		id_variant		: 'hover',
		row_key_base	: index
	})
	if (!instance) {
		return null
	}
	const node = await instance.render()


	return {
		instance	: instance,
		node		: node || null
	}
}//end render_hover_view



/**
* REBUILD_COLUMNS_MAP
* Adding control columns to the columns_map that will processed by section_recods
*
* Wraps a filtered `base_columns_map` with tool-specific control columns:
*
*   For HOVER view (view_mosaic === false):
*     Prepends a `section_id` column (renders as an "open record" link button
*     via `render_column_id` from `render_edit_component_portal`).
*
*   For MOSAIC view (view_mosaic === true):
*     Appends an `original` column rendered by `render_column_original_copy`,
*     which provides the Original/Copy radio buttons, the Snap checkbox, and
*     the drag-used indicator.
*
* @param {Array}   base_columns_map - Pre-filtered column descriptors
*                                     (either `in_mosaic:true` or `hover:true` set).
* @param {Object}  self             - The component_portal instance (passed through for context).
* @param {boolean} view_mosaic      - `true` to build the mosaic columns set;
*                                     `false` to build the hover columns set.
* @returns {Promise<Array>} The full columns_map array including the injected control columns.
*/
const rebuild_columns_map = async function(base_columns_map, self, view_mosaic) {

	const full_columns_map = []

	// column section_id
		if(!view_mosaic) {
			full_columns_map.push({
				id			: 'section_id',
				label		: 'Id',
				width		: 'auto',
				callback	: render_column_id
			})
		}

	// base_columns_map
		full_columns_map.push(...base_columns_map)

	// column info and remove
		if(view_mosaic) {
			full_columns_map.push({
				id			: 'original',
				label		: 'Info',
				callback	: render_column_original_copy
			})
		}


	return full_columns_map
}//end rebuild_columns_map



/**
* RENDER_COLUMN_ORIGINAL_COPY
* Renders the "Info" control column appended to each mosaic tile.
*
* Produces a DocumentFragment with two main areas:
*
*   LEFT — `.options_left_contaniner`
*     Radio buttons (Original / Copy) bound to tipo `numisdata157` (the discard
*     component).  The current value is read from `options.caller.datum.data`
*     via the record's `locator.section_id`:
*       - `discard_value === '1'`  → pre-styles the Original label as active.
*       - `discard_value === '2'`  → pre-styles the Copy label as active.
*     Labels for both radio buttons are retrieved from the tool via
*     `tool_caller.get_tool_label('original')` / `get_tool_label('copy')`.
*     Each radio button's mouseup handler toggles its checked state; holding
*     Alt deselects (unchecks) it, allowing both to be cleared.
*
*     Snap checkbox (`.checkbox_snap`) — adds/removes the CSS class `snap`
*     on the ancestor row container (3 levels up: snap_item → options_left_contaniner
*     → section_record_node → row_container) to freeze the tile's layout.
*     Label text comes from `tool_caller.get_tool_label('snap')`.
*
*   RIGHT — `.drag`
*     A drag-indicator div.  Receives the additional class `used` when the coin
*     has already been assigned to an ordered position (detected by looking up
*     `options.locator` in `tool_caller.ordered_coins.datum.data`).
*
* DOM path used to reach the tool instance:
*   options.caller (section_record instance) → .caller (component_portal) → .caller (tool)
*   i.e. `options.caller.caller` is the `tool_numisdata_order_coins` instance.
*
* Ontology constants referenced:
*   `numisdata157` — the discard/classification component (Original vs Copy flag).
*   `numisdata341` — the section holding classification enum values (section_id '1'=original,
*                    '2'=copy).
*
* @param {Object} options
* @param {Object} options.caller  - The section_record instance for this tile.
* @param {Object} options.locator - Locator for the current record
*                                   `{ section_tipo, section_id, ... }`.
* @returns {DocumentFragment} Fragment containing the assembled control column nodes.
*/
const render_column_original_copy = function(options){

	// DocumentFragment
	const fragment = new DocumentFragment()

	const tool_caller = options.caller.caller

	const locator = options.locator

	// Read the current discard/classification value for this coin from the portal's datum.
	// numisdata157 is the discard component; its value[0].section_id indicates:
	//   '1' → Original, '2' → Copy (enum stored in numisdata341).
	const discard_data		= options.caller.datum.data.find(item => item.section_id === locator.section_id && item.tipo === 'numisdata157')
	const discard_context	= options.caller.datum.context.find(item => item.tipo === 'numisdata157')

	const discard_value 	= 	discard_data.value && discard_data.value.length > 0
		? discard_data.value[0].section_id
		: null

	// Check whether this coin already appears in the ordered_coins portal data,
	// so the drag indicator can show a 'used' state.
	const orderer_data		= options.caller.caller.ordered_coins.datum.data
	const used_coin 		= orderer_data.find(el => el.section_tipo===locator.section_tipo && el.section_id === locator.section_id)

	// options
		const options_left_contaniner  = ui.create_dom_element({
			element_type	: 'div',
			class_name		: "options_left_contaniner",
			parent			: fragment
		})

	// discard buttons
		const radio_button_contaniner  = ui.create_dom_element({
			element_type	: 'div',
			class_name		: "radio_button_contaniner",
			parent			: options_left_contaniner
		})
			const input_original  = ui.create_dom_element({
				element_type	: 'input',
				type			: 'radio',
				id				: 'original_' + locator.section_id,
				class_name		: "input_original",
				name			: 'set_discart' + locator.section_id,
				value			: locator.section_id,
				parent			: radio_button_contaniner
			})
			input_original.section_id = locator.section_id
			// Alt+click deselects; plain click selects. Both radio inputs in the group share
			// the same `name`, so this toggle-off behaviour requires explicit handling since
			// HTML radio buttons normally cannot be unchecked by the user.
			input_original.addEventListener('mouseup',(event)=>{
				input_original.checked = (event.altKey===true)
					? false
					: true
			})
			const original_class_name = (discard_value==='1')
				? 'label_original'
				: ''
				const original_label = ui.create_dom_element({
					element_type	: 'label',
					for 			: 'original_' + locator.section_id,
					class_name		: original_class_name,
					text_content	: tool_caller.get_tool_label('original') || 'Original',
					parent			: radio_button_contaniner
				})
				// Clicking the label also toggles the checked state to allow deselection.
				original_label.addEventListener('mouseup',()=>{
					input_original.checked = input_original.checked
						? false
						: true
				})
				input_original.label = original_label
			// copy button
			const input_copy  = ui.create_dom_element({
				element_type	: 'input',
				type 			: 'radio',
				id				: 'copy_' + locator.section_id,
				class_name		: "input_copy",
				name 			: 'set_discart' + locator.section_id,
				value 			: locator.section_id,
				parent			: radio_button_contaniner
			})
			input_copy.section_id = locator.section_id
			input_copy.addEventListener('mouseup',(event)=>{
				input_copy.checked = (event.altKey===true)
					? false
					: true
			})
				const copy_class_name = (discard_value==='2')
					? 'label_copy'
					: ''
				const copy_label = ui.create_dom_element({
					element_type	: 'label',
					for 			: 'copy_'+ locator.section_id,
					class_name		: copy_class_name,
					text_content	: tool_caller.get_tool_label('copy') || 'Copy',
					parent			: radio_button_contaniner
				})
				copy_label.addEventListener('mouseup',()=>{
					input_copy.checked = input_copy.checked
						? false
						: true
				})
				input_copy.label = copy_label

	// columns snap_item
		const snap_item  = ui.create_dom_element({
			element_type	: 'div',
			class_name		: "row_snap",
			parent			: options_left_contaniner
		})
			const checkbox_snap  = ui.create_dom_element({
					element_type	: 'input',
					type 			: 'checkbox',
					id 				: 'checkbox_snap_' + locator.section_id,
					class_name		: "checkbox_snap",
					value 			: locator.section_id,
					parent			: snap_item
				})
				const checkbox_snap_label  = ui.create_dom_element({
					element_type	: 'label',
					text_content 	: tool_caller.get_tool_label('snap') || 'Snap',
					parent			: snap_item
				})
				checkbox_snap_label.setAttribute('for','checkbox_snap_' + locator.section_id)
				// Toggling snap walks up to the row_container (3 levels: snap_item →
				// options_left_contaniner → section_record_node → row_container) and
				// adds/removes the 'snap' CSS class, which locks the tile's aspect ratio.
				checkbox_snap.addEventListener("change", function(){

					const row_container = snap_item.parentNode.parentNode.parentNode

					if (checkbox_snap.checked) {
						row_container.classList.add("snap")
					}else{
						row_container.classList.remove("snap")
					}
				},false)

	// columns drag indication
		// If this coin already appears in ordered_coins, mark the drag handle as 'used'
		// so the user can see at a glance which coins have already been assigned.
		const used_coin_class = used_coin
			? ' used'
			: ''
		const drag_item  = ui.create_dom_element({
			element_type	: 'div',
			class_name		: "drag"+used_coin_class,
			parent			: fragment
		})

	return fragment
}//end render_column_original_copy



// @license-end
