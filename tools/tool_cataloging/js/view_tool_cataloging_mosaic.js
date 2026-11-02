// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_label */
/*eslint no-undef: "error"*/



// imports
	import {place_list_after} from '../../../core/common/js/common.js'
	import {event_manager} from '../../../core/common/js/event_manager.js'
	import {ui} from '../../../core/common/js/ui.js'
	import {bind_tool_row_drag} from '../../../core/component_portal/js/drag_and_drop.js'
	import {set_element_css} from '../../../core/page/js/css.js'
	import {render_list_after} from '../../../core/section/js/render_common_section.js'
	import {
		render_column_id
	} from '../../../core/section/js/render_list_section.js'
	import {build_section_record_for, window_section_rows } from '../../../core/section/js/section.js'
	import {delegate_row_hover} from '../../../core/section_record/js/row_hover.js'
	import {
		compute_used_keys,
		get_catalog_target_tipos,
		locator_key,
		mark_used_row
	} from './used_state.js'



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
* the control columns added by `rebuild_columns_map`: the ROW WINDOW builds the
* tile of each row, the hover controller builds ONE overlay record on demand.
*
* ROWS (WC-2026-10-30-section-record-row-box)
* This view is an ordinary section in list mode: it renders the same search
* filter and paginator as the default list and reads the same saved pagination
* key (`<tipo>_list`), so a page size set in the normal list — up to the DEC-07
* ceiling of 1000 — lands here whole. `get_content_data` hands the page's entries
* to the row window door (section.js window_section_rows → record_window): the
* tile is the row (`content_data.children[i]` is row i), at most
* ROW_WINDOW_MAX_ROWS tiles are built at once (placeholders beyond), and it is
* called on every content render, N=0 included.
*
* DRAG-AND-DROP FLOW
* 1. The window stamps every built tile `draggable`; drag_and_drop.js
*    `bind_tool_row_drag` puts ONE delegated dragstart (+ the touch_pick tap) on
*    the content_data, riding the window's signal. Its payload is the row's
*    frozen entry (`get_row_transfer_data`), `text/plain` only, so the thesaurus
*    term (the drop target) reads it and every portal treats it as foreign.
* 2. On drop the thesaurus fires `ts_add_child_tool_cataloging`; the tool inserts
*    the locator and then re-reads the card's dd1596 (used_state.refresh_used_state),
*    which sets or clears the CSS class `used` on the card's drag indicator. A
*    removed term (delete, emptied link) clears it the same way — see used_state.js.
*
* USED MARKER
* `self.used_keys` (used_state.compute_used_keys) is the Set of the page's used
* records; the window's `decorate` marks every tile it builds from it (the fill
* AND a later placeholder swap), refresh_used_state keeps it current.
*
* HOVER OVERLAY
* Built LAZILY by core's row_hover.js `delegate_row_hover`: one delegated
* pointer listener set on the content_data; on hover the overlay record (hover
* columns, `id_variant: 'hover'`) is built through section.js
* `build_section_record_for` and prepended into the tile; it leaves again with
* the pointer (flushed first: an edit in the overlay is never dropped). At most
* one overlay exists per content_data.
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
* search toggle button, paginator, mosaic list body, the `.list_after` slot and
* the section wrapper. Also injects scoped CSS rules derived from `self.context.css`.
*
* When `options.render_level === 'content'`, only the inner `content_data` node is
* returned (used on paginator page-change to refresh only the record grid without
* rebuilding the outer chrome).
*
* Side effects:
* - The row window pushes every built tile into `self.ar_instances` (the live
*   rows only), so `common.destroy()` can clean them up on navigation.
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

	// list_after. The non-row sibling (no_records, print notice), after list_body
		place_list_after(wrapper, content_data)


	return wrapper
}//end render



/**
* GET_CONTENT_DATA
* Builds the `content_data` div and hands the page's entries to the row window
* door (section.js window_section_rows; WC-2026-10-30-section-record-row-box):
* the tile of row i is `content_data.children[i]`, built through the door (one
* section_record per row, registered in `self.ar_instances`) — at most
* ROW_WINDOW_MAX_ROWS at once (audit P2-31 / CLI-29 / CLI-30: this view reads the
* same saved pagination key as the ordinary list, so its page is the same
* 1000-row page). Called on every content render, N=0 included.
*
* On the window it installs, once per content_data:
*   - the tool drag source (drag_and_drop.js bind_tool_row_drag): delegated
*     dragstart + touch_pick tap;
*   - the lazy hover overlay (row_hover.js delegate_row_hover).
* The used marker is the window's `decorate` (see used_state.js).
* Nothing but rows goes into content_data: no_records and the print notice
* travel in `content_data.list_after` (render_list_after).
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

	// used marker. The Set of this page's used records (server truth, dd1596),
	// read by decorate for every tile the window builds and kept current by
	// the tool's refresh_used_state
		self.used_keys = compute_used_keys(self, get_catalog_target_tipos(self.caller?.area_thesaurus))

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
			// TOOL_ROW_SOURCES; the thesaurus term validates the payload)
			draggable_rows	: true,
			decorate		: (node, index) => {
				const entry = rows[index]
				mark_used_row(node, entry ? self.used_keys.has(locator_key(entry)) : false)
			}
		})

	// delegated drag source + lazy hover overlay (both ride the window's signal)
		if (record_window) {
			// caller_name: the thesaurus term publishes ts_add_child_tool_cataloging
			// (the record link) only when the payload names its caller
			bind_tool_row_drag(self, content_data, { caller_name : 'tool_cataloging' })
			delegate_row_hover({
				caller			: self,
				content_data	: content_data,
				signal			: record_window.signal,
				render_hover	: (index) => render_hover_view(self, record_window, index, maps.hover_columns_map)
			})
		}

	// list_after. no_records / print notice (never inside content_data)
		content_data.list_after = render_list_after(self, {
			content_data	: content_data,
			record_window	: record_window
		})


	return content_data
}//end get_content_data



/**
* RENDER_HOVER_VIEW
* The hover controller's `render_hover` (row_hover.js): builds and renders ONE
* row's overlay record (hover columns, `id_variant: 'hover'`) through section.js
* `build_section_record_for` — never get_section_records. The controller
* prepends the returned node into the tile (marking it `.sr_mosaic_hover`) and
* registers the instance; it also owns its teardown.
* @param {Object} self - Section instance.
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
* Builds the final columns_map of one record slice — the tile (row window) or
* the hover overlay (hover controller) — by prepending
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
* Column cell renderer that produces the drag indicator of each mosaic card. It
* doubles as the visual "used" indicator: it carries the CSS class `used` while
* the record is referenced by a term of a catalog hierarchy loaded in the
* thesaurus panel.
*
* The cell only renders the node. The `used` class is the row window's
* `decorate` (get_content_data), from `self.used_keys` (used_state.js) — one
* truth for the fill, a later placeholder swap and refresh_used_state. The drag
* itself is the whole tile (bind_tool_row_drag), not this node.
*
* @param {Object} options - Column-render options (unused: the cell is static).
* @returns {DocumentFragment} Fragment containing the dragger div.
*/
const render_column_drag = function(options) {

	// DocumentFragment
		const fragment = new DocumentFragment()

	// drag_item
		ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'dragger',
			parent			: fragment
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
