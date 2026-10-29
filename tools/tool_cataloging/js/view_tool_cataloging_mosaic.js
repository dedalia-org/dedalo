// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global DD_TIPOS, get_label */
/*eslint no-undef: "error"*/



// imports
	import {event_manager} from '../../../core/common/js/event_manager.js'
	import * as touch_pick from '../../../core/common/js/touch_pick.js'
	import {window_section_rows} from '../../../core/section/js/section.js'
	import {ui} from '../../../core/common/js/ui.js'
	import {set_element_css} from '../../../core/page/js/css.js'
	import {get_catalog_target_tipos, is_used} from './used_state.js'
	import {
		render_column_id
	} from '../../../core/section/js/render_list_section.js'



/**
* VIEW_TOOL_CATALOGING_MOSAIC
* Custom section view rendered by tool_cataloging on the left pane of the
* split-pane cataloging window. It presents the source section's records as a
* draggable mosaic grid so users can drag cards onto thesaurus nodes in the
* right pane to classify them.
*
* ARCHITECTURE OVERVIEW
* This module is not a standalone component — it is injected into a section
* instance at render time via `section.render_views`. The section's `self` object
* (a tool_cataloging-owned section instance) is passed directly to every function
* in this module; all persistent state lives in that section instance.
*
* COLUMNS MAP CONTRACT
* Each entry in `self.columns_map` may carry two optional boolean flags:
*   - `in_mosaic: true`  — include this column in the main mosaic grid
*   - `hover: true`      — include this column in the hover overlay
* Both sets of columns are filtered from the full columns_map and merged with
* the control columns added by `rebuild_columns_map`; the ROW WINDOW then builds
* ONE section_record per set for each row it materializes.
*
* DRAG-AND-DROP FLOW
* 1. `get_content_data` hands the page's entries to the row window, which builds
*    the two section_records (tile + hover) of a row when the viewport reaches it.
* 2. The window's materialize renders the tile node and calls `set_drag_and_drop`.
* 3. `set_drag_and_drop` marks the node draggable and attaches a dragstart handler.
* 4. `on_dragstart_mosaic` serialises locator + paginated_key as JSON in
*    dataTransfer so the drop target (thesaurus) can read them.
* 5. On drop the thesaurus fires `ts_add_child_tool_cataloging`; the tool inserts
*    the locator and then re-reads the card's dd1596 (used_state.refresh_used_state),
*    which sets or clears the CSS class `used` on the drag indicator. A removed term
*    (delete, emptied link) clears it the same way — see used_state.js.
*
* HOVER OVERLAY
* Each row's hover record (hover columns, `id_variant: 'hover'`) is built by the
* same window step as its tile and prepended into it, hidden (`display_none`)
* until `mouseenter`. It is the row's own node — no shared park container and no
* pub/sub bridge: a windowed row must own everything it built, or a released row
* would leave a subscriber behind (this is the shape core's
* view_mosaic_edit_portal already uses).
*
* ROW WINDOW (audit P2-31 / CLI-29 / CLI-30)
* This view is an ordinary section in list mode: it renders the same search
* filter and paginator as the default list and reads the same saved pagination
* key (`<tipo>_list`), so a page size set in the normal list — up to the DEC-07
* ceiling of 1000 — lands here whole. Its rows are therefore windowed exactly
* like the default list's: at most ROW_WINDOW_MAX_ROWS rows (tile + hover each)
* exist at once, and rows past the far edge are released.
*
* Exports:
*   view_tool_cataloging_mosaic           — constructor (no-op; required by module system)
*   view_tool_cataloging_mosaic.render    — main entry point called by section.render
*/
export const view_tool_cataloging_mosaic = function() {

	return true
}//end view_tool_cataloging_mosaic



/**
* RENDER
* Main entry point for the mosaic view. Called by the section's render dispatcher
* when `self.view === 'tool_cataloging_mosaic'`. Builds the full DOM structure:
* search toggle button, paginator, mosaic list body, optional hover overlay, and
* the section wrapper. Also injects scoped CSS rules derived from `self.context.css`.
*
* When `options.render_level === 'content'`, only the inner `content_data` node is
* returned (used on paginator page-change to refresh only the record grid without
* rebuilding the outer chrome).
*
* Side effects:
* - Pushes all built section_record instances into `self.ar_instances` so that
*   `common.destroy()` can clean them up on navigation.
* - Overwrites `self.columns_map` with the mosaic-filtered + augmented version so
*   subsequent renders use the same column set.
* - Sets `self.node_body` to the `list_body` div (used by pagination selection).
* - Sets `self.search_container` pointer (populated later by the search subsystem).
* - Calls `set_element_css` to queue a scoped CSS rule for the list wrapper.
*
* @param {Object} self - Section instance (`section_to_cataloging`) owned by tool_cataloging.
*   Key properties read: columns_map, show_interface, ar_instances, total, paginator,
*   filter, buttons, context, section_tipo, tipo, mode, view, type, model, events_tokens.
* @param {Object} options
* @param {string} [options.render_level='full'] - 'full' builds the entire wrapper;
*   'content' returns only the refreshed content_data node.
* @returns {Promise<HTMLElement>} Resolves to the `<section>` wrapper node on full render,
*   or the `content_data` div on content-only render.
*/
view_tool_cataloging_mosaic.render = async function(self, options) {

	// options
		const render_level = options.render_level || 'full'

	// interface configurations. Applied to every section_record the window builds
		// button_delete prevent to show
		self.show_interface.button_delete = false
		// button edit click, opens record in a new window instead navigate
		self.show_interface.button_edit_options.action_mousedown = 'open_window'

	// hover columns. The overlay's column slice (one section_record per row)
		const hover_columns		= self.columns_map.filter(el => el.hover===true)
		const hover_columns_map	= await rebuild_columns_map(hover_columns, self, false)

	// content_data. Create the mosaic with only the marked ddo as "mosaic" with true value
		// columns_map
			const base_columns_map	= self.columns_map.filter(el => el.in_mosaic===true)
			const columns_map		= await rebuild_columns_map(base_columns_map, self, true)
			self.columns_map		= columns_map

		// rows. The page's locator entries; instances are built by the row window
			const rows = self.data?.entries || []
			self.ar_instances = self.ar_instances || []

		// content_data
			const content_data = await get_content_data(self, rows, {
				columns_map			: columns_map,
				hover_columns_map	: hover_columns_map
			})
			if (render_level==='content') {

				// force to refresh paginator
				if (self.paginator) {
					self.paginator.refresh()
				}

				return content_data
			}

	// DocumentFragment
		const fragment = new DocumentFragment()

	// buttons add
		if (self.buttons) {
			const buttons_node = get_buttons(self);
			if(buttons_node){
				fragment.appendChild(buttons_node)
			}
		}

	// search filter node
		if (self.filter) {
			const search_container = ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'search_container',
				parent			: fragment
			})
			// set pointers
			self.search_container = search_container
		}

	// paginator container node
		if (self.paginator) {
			const paginator_container = ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'paginator_container',
				parent			: fragment
			})
			self.paginator.build()
			.then(function(){
				self.paginator.render().then(paginator_wrapper =>{
					paginator_container.appendChild(paginator_wrapper)
				})
			})
		}

	// list_body
		const list_body = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'list_body ' + self.mode +  ' view_'+self.view,
			parent			: fragment
		})
		// fix last list_body (for pagination selection)
		self.node_body = list_body
		// content_data append
		list_body.appendChild(content_data)

		// list_body css
			const selector		= `${self.section_tipo}_${self.tipo}.view_tool_cataloging_mosaic`
			const css_object	= {}
			if (self.context.css) {
				// use defined section css
				for(const property in self.context.css) {
					css_object[property] = self.context.css[property]
				}
			}
			// use calculated css
			set_element_css(selector, css_object)


	// wrapper
		const wrapper = ui.create_dom_element({
			element_type	: 'section',
			class_name		: `wrapper_${self.type} ${self.model} ${self.tipo} ${self.section_tipo+'_'+self.tipo} view_${self.context.view}`
		})
		wrapper.appendChild(fragment)
		// set pointers
		wrapper.content_data	= content_data
		wrapper.list_body		= list_body


	return wrapper
}//end render



/**
* GET_CONTENT_DATA
* Builds the `content_data` div and hands the page's rows to a ROW WINDOW
* (section.js window_section_rows → common/js/row_window.js): the TWO
* section_records of a row (the mosaic tile and its hover overlay) are built and
* rendered only for the rows the viewport can reach — at most ROW_WINDOW_MAX_ROWS
* at once — and released again past the far edge (audit P2-31 / CLI-29 / CLI-30:
* this view reads the same saved pagination key as the ordinary list, so its page
* is the same 1000-row page, and it used to build 2 instances for every row of it).
*
* Per materialized row:
*   1. Builds the tile and hover records through the window's `build_row` (each
*      registered in `self.ar_instances`, with the row's page-wide row_key).
*   2. Renders both, prepends the hover overlay into the tile (hidden until hover).
*   3. Attaches drag-and-drop (`set_drag_and_drop`, `paginated_key` = row index).
*   4. Attaches the `mouseenter` / `mouseleave` listeners that toggle the overlay
*      and the `mosaic_over` class.
* Per released row: destroys both records and drops the row's drag handle from
* the section's `drag_nodes` registry (see render_column_drag).
*
* CSS from `self.context.css['.content_data'].style.height` is applied inline if
* present (legacy selector support for per-section overrides stored in the ontology).
*
* @param {Object} self - Section instance.
* @param {Array}  rows - The page's locator entries (`self.data.entries`).
* @param {Object} maps
* @param {Array}  maps.columns_map       - The `in_mosaic` columns (tile).
* @param {Array}  maps.hover_columns_map - The `hover` columns (overlay).
* @returns {Promise<HTMLElement>} content_data div holding the windowed rows.
*/
const get_content_data = async function(self, rows, maps) {

	// content_data
		const content_data = ui.tool.build_content_data(self)

	// drag handle registry (render_column_drag / used_state.js): a new page
	// starts a new registry, so handles of the previous page are not refreshed.
	// The release below closes over THIS map: a late release of a previous
	// page's row cannot delete the same index of the new page.
		const drag_nodes = new Map()
		self.drag_nodes = drag_nodes

	// row window
		if (rows.length > 0) {

			// index → the row's two instances
			const companions = new Map()

			await window_section_rows({
				caller			: self,
				container		: content_data,
				rows			: rows,
				records_options	: {
					mode : 'list'
				},
				materialize		: async (row, i, build_row) => {

					// the two records of the row, built together
					const [section_record, hover_section_record] = await Promise.all([
						build_row({ columns_map: maps.columns_map }),
						build_row({ columns_map: maps.hover_columns_map, id_variant: 'hover' })
					])
					if (!section_record || !hover_section_record) {
						for (const built of [section_record, hover_section_record]) {
							if (built && built.status!=='destroyed') {
								await built.destroy(true, true, true)
							}
						}
						return null
					}

					// tile + hover overlay
					const [section_record_node, hover_view] = await Promise.all([
						section_record.render(),
						render_hover_view(hover_section_record)
					])
					section_record_node.prepend(hover_view)

					// drag and drop
					set_drag_and_drop({
						section_record_node	: section_record_node,
						total_records		: self.total,
						locator				: section_record.locator,
						paginated_key		: i,
						caller				: self
					})

					// mouseenter event
					section_record_node.addEventListener('mouseenter', function(e){
						e.stopPropagation()
						hover_view.classList.remove('display_none')
						section_record_node.classList.add('mosaic_over')
					})

					// mouseleave event
					section_record_node.addEventListener('mouseleave', function(e){
						e.stopPropagation()
						hover_view.classList.add('display_none')
						section_record_node.classList.remove('mosaic_over')
					})

					companions.set(i, {
						section_record			: section_record,
						hover_section_record	: hover_section_record
					})

					return section_record_node
				},
				release			: async (row, i) => {
					// the drag column registers one handle per rendered card
					drag_nodes.delete(i)
					const companion = companions.get(i)
					companions.delete(i)
					if (!companion) {
						return
					}
					for (const built of [companion.section_record, companion.hover_section_record]) {
						if (built && built.status!=='destroyed') {
							await built.destroy(true, true, true)
						}
					}
				}
			})
		}//end if (rows.length > 0)

	// css
		const element_css	= self.context.css || {}
		const legacy_selector_content_data = '.content_data'
		if (element_css[legacy_selector_content_data]) {
			// style
				if (element_css[legacy_selector_content_data].style) {
					// height from style
					if (element_css[legacy_selector_content_data].style.height) {
						content_data.style.setProperty('height', element_css[legacy_selector_content_data].style.height);
					}
				}
		}


	return content_data
}//end get_content_data



/**
* SET_DRAG_AND_DROP
* Marks a rendered section_record node as draggable and wires the dragstart handler.
* Called once per record node during `get_content_data`; `options` is forwarded
* verbatim to `on_dragstart_mosaic` which serialises the transfer payload.
*
* @param {Object} options
* @param {HTMLElement} options.section_record_node - The rendered section_record DOM node to make draggable.
* @param {number|null} options.total_records - Total number of records in the paginated result (self.total).
* @param {Object} options.locator - Locator object for the dragged record ({ section_id, section_tipo }).
* @param {number} options.paginated_key - Zero-based index of this record in the current page's ar_section_record.
* @param {Object} options.caller - The section instance (self) that owns this mosaic.
* @returns {boolean} Always true.
*/
const set_drag_and_drop = function(options) {

	// options
		const drag_node = options.section_record_node

	// drag_node
		drag_node.draggable = true
		drag_node.classList.add('draggable')
		drag_node.addEventListener('dragstart', function(e){
			on_dragstart_mosaic(this, e, options)
		})

	// touch: a finger cannot drag (HTML5 dragstart never fires), so a TAP picks
	// the same payload and a tap on a thesaurus term places it (touch_pick.js;
	// the term side is wired in view_default_edit_ts_object.render_wrapper)
		if (touch_pick.is_touch()) {
			drag_node.addEventListener('click', function(e){
				e.stopPropagation()
				touch_pick.pick(
					get_transfer_data(options),
					String(options.locator?.section_id ?? '')
				)
			})
		}


	return true
}//end set_drag_and_drop



/**
* GET_TRANSFER_DATA
* The drop payload, as the 'text/plain' JSON string both gestures carry (the
* mouse drag and the touch pick). One builder, so the two cannot drift.
* @param {Object} options - {locator, paginated_key}
* @returns {string}
*/
const get_transfer_data = function(options) {
	return JSON.stringify({
		locator			: options.locator,
		paginated_key	: options.paginated_key,
		caller			: 'tool_cataloging'
	})
}//end get_transfer_data



/**
* ON_DRAGSTART_MOSAIC
* Serialises the drag payload and stores it in `event.dataTransfer` as
* `text/plain` JSON. The payload carries enough information for the thesaurus
* drop handler to identify the record, retrieve it, and fire the
* `ts_add_child_tool_cataloging` event with the correct locator.
*
* Payload shape:
* ```json
* {
*   "locator"       : { "section_id": "42", "section_tipo": "dd100" },
*   "paginated_key" : 3,
*   "caller"        : "tool_cataloging"
* }
* ```
* `caller` is a fixed string tag so the thesaurus drop handler can distinguish
* drops originating from this tool versus other drag sources.
*
* The commented-out `node.classList.add('dragging')` line was left for future
* visual feedback during drag; do not remove it.
*
* @param {HTMLElement} node - The section_record node being dragged (same as `this` in the dragstart listener).
* @param {DragEvent} event - The native dragstart event; stopPropagation is called to avoid
*   outer containers capturing the drag.
* @param {Object} options
* @param {Object} options.locator - Locator of the dragged section_record.
* @param {number} options.paginated_key - Zero-based position of the record in the current page.
* @returns {boolean} Always true.
*/
const on_dragstart_mosaic = function(node, event, options) {
	event.stopPropagation();

	// options
		const locator		= options.locator
		const paginated_key	= options.paginated_key

	// will be necessary the original locator of the section_record and the paginated_key (the position in the array of data)
		const data = get_transfer_data({locator, paginated_key})

	event.dataTransfer.effectAllowed = 'move';
	event.dataTransfer.setData('text/plain', data);

	// style the drag element to be showed in drag mode
	// node.classList.add('dragging')

	return true
}//end on_dragstart_mosaic



/**
* RENDER_HOVER_VIEW
* Renders ONE row's hover overlay node.
*
* The overlay is the row's own hover section_record (built by the window in the
* same step as the tile), rendered with the classes `sr_mosaic_hover display_none`
* and prepended into the tile by `get_content_data`; the tile's
* `mouseenter` / `mouseleave` listeners toggle `display_none`.
*
* (Before the row window this was a page-wide parallel set parked in a hidden
* `hover_body` and teleported into the hovered card through the event_manager
* channels `mosaic_hover_*` / `mosaic_mouseleave_*`. A windowed row owns what it
* built — a released row cannot leave a subscriber behind — so the bridge is gone
* and the overlay is simply the tile's hidden first child, the shape core's
* view_mosaic_edit_portal uses.)
*
* @param {Object} hover_section_record - The row's hover-columns section_record
*   instance (`id_variant: 'hover'`).
* @returns {Promise<HTMLElement>} The rendered overlay node (initially hidden).
*/
const render_hover_view = async function(hover_section_record) {

	// section_record
		const section_record_node = await hover_section_record.render()
			  section_record_node.classList.add('sr_mosaic_hover', 'display_none')


	return section_record_node
}//end render_hover_view



/**
* REBUILD_COLUMNS_MAP
* Builds the final columns_map array handed to the row window (one section_record
* per row and slice) by prepending
* or appending control columns around the caller-supplied data columns:
*
*   Hover mode  (view_mosaic=false):  section_id column prepended, no drag column.
*   Mosaic mode (view_mosaic=true):   no section_id, drag indicator column appended.
*
* The `section_id` control column uses `render_column_id` from render_list_section.js.
* The `drag` control column uses `render_column_drag` (local); its `id` field maps to
* the CSS class `column_drag` applied by section_record.
*
* Note: the label 'Info' on the drag column entry matches the column's visual role
* as both a drag handle and a used-indicator, not the standard Info button.
*
* @param {Array<Object>} base_columns_map - Filtered subset of section column descriptors
*   (each has at minimum: `tipo`, `callback`, and optionally `label`, `width`).
* @param {Object} self - Section instance (currently unused inside the function but kept
*   for API symmetry with other rebuild helpers across the codebase).
* @param {boolean} view_mosaic - True when building the main mosaic columns; false when
*   building the hover overlay columns.
* @returns {Promise<Array<Object>>} Augmented columns_map ready for the row window.
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
				id			: 'drag',
				label		: 'Info',
				callback	: render_column_drag
			})
		}


	return full_columns_map
}//end rebuild_columns_map



/**
* RENDER_COLUMN_DRAG
* Column cell renderer that produces the drag handle for each mosaic card. The
* handle doubles as a visual "used" indicator: it carries the CSS class `used`
* while the record is referenced by a term of a catalog hierarchy loaded in the
* thesaurus panel.
*
* USED DETECTION LOGIC (used_state.js)
* 1. `get_catalog_target_tipos` reads the dd100 datum of `area_thesaurus` and
*    keeps the target_section_tipo of its `type === 'hierarchy'` nodes.
* 2. The record's `DD_TIPOS.DEDALO_SECTION_INFO_INVERSE_RELATIONS` (dd1596) datum
*    carries its incoming relations in `entries` (the v7 wire key, WC-001 — v6
*    used `value`), computed live by the server (component_inverse emit hook).
* 3. `is_used` is true when any entry's `from_section_tipo` is one of those tipos.
*
* RECALCULATION
* The handle is registered in the section's `drag_nodes` Map (row_key →
* {locator, node}); the row window's release deletes it. The tool's
* refresh_used_state re-reads dd1596 for the registered cards after a drop, a
* term delete, a save of the term link component and a return to the window, and
* toggles `used` from that answer — a removed term clears the marker.
*
* @param {Object} options
* @param {Object} options.caller - The tool_cataloging-owned SECTION instance (a
*   column callback receives the record's `caller`, not the record itself).
* @param {Object} options.caller.caller - The tool_cataloging instance, giving
*   access to `area_thesaurus`.
* @param {number} options.row_key - The row's page index; keys the registry entry
*   deleted when the row window releases the row.
* @param {Object} options.locator - Locator of the record being rendered
*   ({ section_id, section_tipo }).
* @returns {DocumentFragment} Fragment containing the dragger div (and the used indicator).
*/
const render_column_drag = function(options) {

	// options
	// (!) a column callback is handed `self.caller` — for a mosaic card that is
	// the tool_cataloging-owned SECTION, not the section_record
	// (view_default_list_section_record.render_callback)
		const caller			= options.caller
		const tool_caller		= caller.caller
		const locator			= options.locator

	// catalog hierarchies loaded in the thesaurus panel
		const target_tipos = get_catalog_target_tipos(tool_caller.area_thesaurus)

	// get inverse_relations data
		const inverse_relations_tipo = DD_TIPOS.DEDALO_SECTION_INFO_INVERSE_RELATIONS
		const relation_data = caller.datum.data.find(el => el.tipo === inverse_relations_tipo
			&& el.section_tipo === locator.section_tipo
			&& String(el.section_id) === String(locator.section_id))

	// used: the record has an incoming relation from a catalog hierarchy term
		const used = is_used(relation_data?.entries, target_tipos)

	// DocumentFragment
		const fragment = new DocumentFragment()

	// drag_item
		const draged_node = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'dragger' + (used ? ' used' : ''),
			parent			: fragment
		})

	// registry. The tool's refresh_used_state toggles `used` on this node
		caller.drag_nodes = (caller.drag_nodes instanceof Map)
			? caller.drag_nodes
			: new Map()
		caller.drag_nodes.set(options.row_key, {
			locator	: locator,
			node	: draged_node
		})


	return fragment
}//end render_column_drag



/**
* GET_BUTTONS
* Builds the buttons toolbar for the mosaic view. Currently produces a single
* "Search" toggle button that publishes `toggle_search_panel_<self.id>` via the
* event_manager. The section's init code subscribes to this channel and shows or
* hides the search panel in response.
*
* The fragment is appended to the outer wrapper by `render` before the list_body
* so it appears at the top of the section.
*
* @param {Object} self - Section instance; `self.id` is used to namespace the event.
* @returns {DocumentFragment} Fragment with a `buttons_container` div holding the search button.
*/
const get_buttons = function(self) {

	// DocumentFragment
		const fragment = new DocumentFragment()

	// buttons_container
		const buttons_container = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'buttons_container',
			parent			: fragment
		})

	// filter button (search) . Show and hide all search elements
		const filter_button	= ui.create_dom_element({
			element_type	: 'button',
			class_name		: 'warning search',
			inner_html		: get_label.find || 'Search',
			parent			: buttons_container
		})
		filter_button.addEventListener('mousedown', function(e) {
			e.stopPropagation()
			event_manager.publish('toggle_search_panel_'+self.id)
		})


	return fragment
}//end get_buttons



// @license-end
