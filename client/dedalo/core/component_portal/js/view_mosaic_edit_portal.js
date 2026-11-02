// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global  */
/*eslint no-undef: "error"*/



// imports
	import {window_section_rows, build_section_record_for} from '../../section/js/section.js'
	import {place_list_after, log_pending_rows} from '../../common/js/common.js'
	import {row_of, apply_table_semantics} from '../../section_record/js/record_window.js'
	import {delegate_row_hover, HOVER_OVERLAY_CLASS} from '../../section_record/js/row_hover.js'
	import {event_manager} from '../../common/js/event_manager.js'
	import {ui} from '../../common/js/ui.js'
	import {
		render_column_id,
		render_column_component_info,
		render_column_remove,
		get_buttons_by_permissions,
		add_wrapper_events,
		render_list_after
	} from './render_edit_component_portal.js'
	import {bind_row_drag, can_reorder, can_drag_out} from './drag_and_drop.js'



/**
* VIEW_MOSAIC_EDIT_PORTAL
* Edit-mode mosaic (card grid) view for `component_portal`.
*
* This module renders the portal's linked records as a CSS grid of visual cards rather
* than a table.  It is dispatched by `render_edit_component_portal.prototype.edit` when
* `self.context.view === 'mosaic'`.
*
* Layout overview (WC-2026-10-30-section-record-row-box):
*
*   wrapper
*     └── list_body  (CSS grid)
*           └── content_data [role=list]
*                 └── .section_record [data-index=i][role=listitem]  ×N  (one tile per entry)
*                       └── .sr_mosaic_hover   (ONLY while hovered: built on demand)
*                             └── button_alt_container  (info icon → opens the table detail modal)
*     └── list_after  (the print notice, when the page has more rows than the window builds)
*     └── buttons  (portal toolbar; only when permissions > 1)
*
* ONE row kind: every tile is the row door's DEFAULT build (section.js
* window_section_rows, `records_options {mode:'list', columns_map}` = the
* `in_mosaic: true` columns). The window keeps the row invariant (exactly one
* `.section_record` per entry in content_data, index order) and builds at most
* ROW_WINDOW_MAX_ROWS tiles at once (audit P2-31 / CLI-29). No custom materialize.
*
* The two other records of a row are built ON DEMAND, never per tile:
*
*   1. **Hover overlay** (`id_variant: 'hover'`, the `hover: true` columns, built with
*      no drag handle) — ONE delegated controller per content_data
*      (section_record/js/row_hover.js `delegate_row_hover`) builds it lazily through
*      section.js `build_section_record_for` when the pointer enters a tile, prepends
*      it into the tile as `.sr_mosaic_hover`, and settles (flush) before tearing it
*      down: an overlay holding a pending edit is never destroyed. Its visibility is
*      CSS (`:is(:hover, :focus-within) > .sr_mosaic_hover`, view_mosaic_portal.less),
*      never a JS toggle.
*
*   2. **Alternative table** (`id_variant: 'table'`, the full columns, no drag
*      handle) — a delegated click on the overlay's `.button_alt_container` resolves
*      the row (record_window `row_of`) and `open_alt_record` builds ONE standard
*      `.list_body.layout_table` (header + content_data through the door, slot
*      `'alt'`, which never retires the tiles' `'rows'` window) inside a modal, with
*      the back-references in that modal's `.list_after`. Closing the modal flushes
*      and destroys the `'alt'` window first, so a close never drops an edit.
*      Not offered inside tool_time_machine (read-only snapshots).
*
* Drag/drop is DELEGATED (drag_and_drop.js bind_row_drag, `source:'row'`): the window
* stamps `draggable` on the tiles only while the portal source rule holds
* (`can_reorder || can_drag_out`); every tile is a drop target, and the wrapper is the
* MOVE zone (add_wrapper_events → bind_portal_drop). No listener sits on a tile.
*
* Key `self` properties consumed:
*   @see component_portal.js for the full instance shape.
*   - `self.columns_map`      {Array}   — full columns map; `in_mosaic` and `hover` flags
*                                         select the two sub-sets (set by `get_columns_map`
*                                         in `common.js` for the `'mosaic'` view).
*   - `self.ar_instances`     {Array}   — the live rows (door), the live hover record
*                                         (controller) and the alt row (door, slot alt).
*   - `self.record_windows`   {Object}  — `{rows, alt?}` window handles (the door).
*   - `self.row_hovers`       {Object}  — `{rows}` hover controller (row_hover.js).
*   - `self.events_tokens`    {Array}   — accumulator for event subscriptions.
*   - `self.permissions`      {number}  — 1 = read-only, 2 = full edit.
*   - `self.caller`           {Object}  — parent instance; checked for `tool_time_machine`.
*   - `self.data.references`  {Array}   — optional back-reference list rendered in the
*                                         alternative table modal.
*
* Exports:
*   `view_mosaic_edit_portal`        — namespace constructor (never instantiated directly).
*   `view_mosaic_edit_portal.render` — async static entry point called by the dispatcher.
*
* @module view_mosaic_edit_portal
* @see render_edit_component_portal.js  for the view-dispatch switch and all shared helpers.
* @see view_default_edit_portal.js      for the simpler table-row equivalent.
* @see component_portal.js             for the constructor, data shape, and lifecycle.
* @see docs/core/components/component_portal.md for the full specification.
*/
export const view_mosaic_edit_portal = function() {

	return true
}//end view_mosaic_edit_portal



/**
* RENDER
* Build and return the complete portal wrapper node in mosaic (card grid) view.
*
* This is the async static entry point called by `render_edit_component_portal.prototype.edit`
* when `self.context.view === 'mosaic'`.
*
* Execution order:
*   1. Resolve the **hover** columns map (`hover: true` subset of `columns_map`, no
*      drag handle).
*   2. Resolve the **mosaic** columns map (`in_mosaic: true` subset of `columns_map`).
*   3. Assemble `content_data` (card grid) by calling `get_content_data`: the tiles
*      through the row door, the delegated drag, hover and alt listeners.
*   4. When `render_level === 'content'` return only the `content_data` node (partial refresh).
*   5. Otherwise wrap in `list_body` → `wrapper`, place the `.list_after` slot, attach
*      the toolbar buttons, wire wrapper-level autocomplete + MOVE zone, and apply
*      read-only context-menu suppression when permissions < 2.
*
* @param {Object} self    - The `component_portal` instance (see component_portal.js).
* @param {Object} options - Render options.
* @param {string} [options.render_level='full'] - `'full'` rebuilds the entire wrapper;
*   `'content'` returns only the refreshed `content_data` node for an in-place swap.
* @returns {Promise<HTMLElement>} The rendered wrapper node (full mode) or the
*   `content_data` node (content mode).
*/
view_mosaic_edit_portal.render = async function(self, options) {

	// options
		const render_level 	= options.render_level || 'full'
		self.ar_instances	= self.ar_instances || []

	// hover columns. The overlay never carries a drag source
		const hover_columns		= self.columns_map.filter(el => el.hover===true)
		const hover_columns_map	= await rebuild_columns_map(hover_columns, self, false)

	// content_data. Create the mosaic with only the marked ddo as "mosaic" with true value
		// columns_map
			const base_columns_map	= self.columns_map.filter(el => el.in_mosaic===true)
			const columns_map		= await rebuild_columns_map(base_columns_map, self, true)

		// rows. The page's locator entries; instances are built by the row door
			const rows = self.data?.entries || []

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
				class_name		: 'list_body ' + self.mode +  ' view_'+self.view
			})


			list_body.appendChild(content_data)

	// buttons
		const buttons = get_buttons_by_permissions(self) // full toolbar >1; update-external only at 1

	// wrapper. ui build_edit returns component wrapper
		const wrapper = ui.component.build_wrapper_edit(self, {
			buttons			: buttons,
			list_body		: list_body
		})
		wrapper.classList.add('portal', 'view_' + (self.view || self.context.view || 'default'))
		// set pointers
		wrapper.list_body		= list_body
		wrapper.content_data	= content_data

	// list_after. The non-row sibling, right after list_body
		place_list_after(wrapper, content_data)

	// service autocomplete + the wrapper MOVE zone
		add_wrapper_events(self, wrapper)

	// permissions control
	// set on read only permissions, remove the context menu
		if(self.permissions < 2){
			wrapper.addEventListener("contextmenu", (e) => {
				e.preventDefault();
				return false
			});
		}


	return wrapper
}//end render



/**
* GET_CONTENT_DATA
* Build the (empty) `content_data` card grid and hand the page's rows to the ROW
* DOOR (section.js window_section_rows → section_record/js/record_window.js) on
* EVERY content render, N=0 included: each tile is the default one-record build
* (`maps.columns_map`, the `in_mosaic` columns). The fill is done before this
* resolves.
*
* Then, on this content_data, all DELEGATED and registered with the window's
* signal (retire / destroy removes them):
*   1. drag/drop — drag_and_drop.js bind_row_drag, `source:'row'` (the window stamps
*      `draggable` only while `can_reorder || can_drag_out`);
*   2. the lazy hover overlay — row_hover.js delegate_row_hover, which calls
*      `render_hover_view` for the hovered tile (the door already retired the
*      previous controller with the previous window);
*   3. the alt table — a click on the overlay's `.button_alt_container` opens
*      `open_alt_record` for that row (not inside tool_time_machine).
*
* @param {Object} self - The `component_portal` instance.
* @param {Array}  rows - The page's locator entries (`self.data.entries`).
* @param {Object} maps
* @param {Array}  maps.columns_map       - The `in_mosaic` columns (tile).
* @param {Array}  maps.hover_columns_map - The `hover` columns (overlay).
* @returns {Promise<HTMLElement>} The populated `content_data` div node.
*/
const get_content_data = async function(self, rows, maps) {

	// content_data
		const content_data = ui.component.build_content_data(self)

	// rows. The door, always (N=0 included)
		const record_window = await window_section_rows({
			caller			: self,
			container		: content_data,
			rows			: rows,
			records_options	: {
				mode		: 'list',
				columns_map	: maps.columns_map
			},
			layout			: 'list',
			draggable_rows	: can_reorder(self) || can_drag_out(self)
		})

	if (record_window) {

		// drag and drop. Delegated: the tile itself is the source
			bind_row_drag(self, content_data, {
				source : 'row'
			})

		// hover overlay. Built on demand, one at a time
			delegate_row_hover({
				caller			: self,
				content_data	: content_data,
				signal			: record_window.signal,
				render_hover	: (index) => render_hover_view(self, index, maps.hover_columns_map)
			})

		// alt table. A click on the overlay's info button of a tile
			if (has_alt_table(self)) {
				content_data.addEventListener('click', function(e) {
					const button = e.target?.nodeType===1 && typeof e.target.closest==='function'
						? e.target.closest('.button_alt_container')
						: null
					if (!button) {
						return
					}
					const hit = row_of(content_data, button)
					// the button must be THIS tile's own overlay button (not a nested list's)
					const overlay = button.parentElement
					if (!hit || !overlay || overlay.parentElement!==hit.node || !overlay.classList.contains(HOVER_OVERLAY_CLASS)) {
						return
					}
					e.stopPropagation()
					open_alt_record(self, hit.index)
				}, { signal : record_window.signal })
			}
	}

	// list_after. Only the print notice (references live in the alt table)
		content_data.list_after = render_list_after(self, {
			content_data	: content_data,
			record_window	: record_window,
			references		: false
		})


	return content_data
}//end get_content_data



/**
* HAS_ALT_TABLE
* The alternative table is not offered inside tool_time_machine: its snapshots are
* read-only and need no inline editing.
* @param {Object} self - The `component_portal` instance.
* @returns {boolean}
*/
const has_alt_table = function(self) {

	return !(self.caller && self.caller.model==='tool_time_machine')
}//end has_alt_table



/**
* RENDER_HOVER_VIEW
* The `render_hover` of the tile hover controller (row_hover.js): build and render
* the overlay record of tile `index`.
*
* The overlay is a section_record built from the `hover: true` columns
* (`id_variant: 'hover'`, no drag handle) through section.js
* `build_section_record_for` — never get_section_records — for the window's frozen
* entry of that row. A `button_alt_container` (info icon) is appended to its node;
* a delegated click on it opens the alternative table (see get_content_data).
*
* The controller marks the node `.sr_mosaic_hover`, prepends it into the tile and
* registers the instance in `self.ar_instances`; this function inserts and
* registers nothing itself (a result that loses a race is discarded by the
* controller).
*
* @param {Object} self              - The `component_portal` instance.
* @param {number} index             - The hovered tile's page position.
* @param {Array}  hover_columns_map - The `hover` columns.
* @returns {Promise<{instance: Object, node: HTMLElement|null}|null>}
*/
const render_hover_view = async function(self, index, hover_columns_map) {

	// entry. Read from the live row window (frozen entries)
		const record_window	= self.record_windows?.rows || null
		const entry			= record_window ? record_window.entry_of(index) : null
		if (!entry) {
			return null
		}

	// hover section_record
		const hover_section_record = await build_section_record_for(self, entry, {
			mode			: 'list',
			columns_map		: hover_columns_map,
			id_variant		: 'hover',
			row_key_base	: index
		})
		if (!hover_section_record) {
			return null
		}

	// node
		const section_record_node = await hover_section_record.render()
		if (!section_record_node) {
			return {
				instance	: hover_section_record,
				node		: null
			}
		}

	// button alt view (table)
		if (has_alt_table(self)) {
			const button_alt_container = ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'button_alt_container',
				parent			: section_record_node
			})
			ui.create_dom_element({
				element_type	: 'span',
				class_name		: 'button info with_bg',
				parent			: button_alt_container
			})
		}


	return {
		instance	: hover_section_record,
		node		: section_record_node
	}
}//end render_hover_view



/**
* OPEN_ALT_RECORD
* Open the alternative (full-columns) table of tile `index` in a modal, for inline
* editing.
*
* Builds ONE standard `.list_body.layout_table` (header + content_data, table
* semantics) whose single row goes through the row door in slot `'alt'`
* (`id_variant: 'table'`, the full columns, no drag handle): the `'alt'` slot never
* supersedes the tiles' `'rows'` window, so opening and closing it leaves the tile
* window's generation, signal and children unchanged. The back-references go to
* the modal's `.list_after`, after the list_body.
*
* The modal closes on its own close button or when the user opens a record from
* inside the table (`button_edit_click`). On close (dd-modal on_close: after hide,
* not refusable) the `'alt'` window is torn down through `close_alt_record` (flush
* first), so a close never drops an edit.
*
* @param {Object} self  - The `component_portal` instance.
* @param {number} index - The tile's page position.
* @returns {Promise<Object|null>} The modal, or null when the row has no entry.
*/
const open_alt_record = async function(self, index) {

	// entry. Read from the live row window
		const record_window	= self.record_windows?.rows || null
		const entry			= record_window ? record_window.entry_of(index) : null
		if (!entry) {
			return null
		}

	// one alt table at a time
		await close_alt_record(self)

	// columns. Full columns, no drag source
		const alt_columns_map = await rebuild_columns_map(self.columns_map, self, false)

	// list_body (table)
		const list_header_node = ui.render_list_header(alt_columns_map, self)
		const content_data = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'content_data'
		})
		const list_body = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'list_body layout_table'
		})
		list_body.style.setProperty('grid-template-columns', ui.flat_column_items(alt_columns_map).join(' '))
		list_body.appendChild(list_header_node)
		list_body.appendChild(content_data)
		// the portal's own label node names the alt table (the modal sits outside the wrapper)
		apply_table_semantics(list_body, list_header_node, self.node?.label?.id || null)

	// row. The door, slot 'alt'
		const alt_window = await window_section_rows({
			caller			: self,
			slot			: 'alt',
			container		: content_data,
			rows			: [entry],
			records_options	: {
				mode		: 'list',
				columns_map	: alt_columns_map,
				id_variant	: 'table'
			},
			layout			: 'table'
		})
		if (!alt_window) {
			return null
		}

	// header
		const header = ui.create_dom_element({
			element_type	: 'div',
			inner_html		: 'Editing mosaic inline'
		})

	// body. list_body + its list_after (references)
		const body = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'body content'
		})
		body.appendChild(list_body)
		const list_after = render_list_after(self, {
			content_data	: content_data,
			record_window	: alt_window,
			order_indicator	: false // the main list's slot shows it (one indicator per portal)
		})
		if (list_after) {
			body.appendChild(list_after)
		}

	// modal
		const modal = ui.attach_to_modal({
			header	: header,
			body	: body,
			footer	: null,
			size	: 'normal'
		})
		self.modal = modal

	// user click edit button action close the modal box
		const token = event_manager.subscribe('button_edit_click', () => {
			modal.close()
		})
		self.events_tokens.push(token)

	// before close. The alt rows commit FIRST: dd-modal awaits before_close
	// ahead of its page-wide check_unsaved_data, whose OK would reset a
	// typed-not-blurred alt value as "unsaved" (record_window flush: deactivate,
	// commit uncommitted nodes, settle). What the flush cannot commit stays
	// registered, so the guard that follows still asks about it.
		modal.before_close = async () => {
			const open_window = self.record_windows?.alt || null
			if (open_window===alt_window) {
				await alt_window.flush()
			}
			return true
		}

	// close. Unsubscribe, then flush + tear down the 'alt' window
		modal.on_close = () => {
			event_manager.unsubscribe(token)
			const token_index = self.events_tokens.indexOf(token)
			if (token_index!==-1) {
				self.events_tokens.splice(token_index, 1)
			}
			close_alt_record(self)
				.catch((error) => {
					console.error('[view_mosaic_edit_portal] alt table teardown failed:', error);
				})
		}


	return modal
}//end open_alt_record



/**
* CLOSE_ALT_RECORD
* Tear down the `'alt'` window of the portal, if any: `destroy()` flushes first
* (deactivate + settle the active component, commit typed-not-committed editor
* nodes, settle unsaved instances; a still-dirty instance is orphaned, never
* destroyed), then the slot is deleted and the alt row instance — when it is still
* the portal's — is destroyed. A pending node (an editor that ignored the
* synthetic change) cannot be refused here (dd-modal on_close runs after hide): it
* is logged (common.js log_pending_rows).
* @param {Object} self - The `component_portal` instance.
* @returns {Promise<void>}
*/
const close_alt_record = async function(self) {

	const alt_window = self.record_windows?.alt || null
	if (!alt_window) {
		return
	}

	const instance = alt_window.record_at(0)
	delete self.record_windows.alt

	const destroyed = await alt_window.destroy()
	log_pending_rows(self, destroyed?.pending, 'view_mosaic_edit_portal (alt table close)')

	// an orphaned (still dirty) instance left ar_instances: it is not ours to destroy
	if (instance && instance.status!=='destroyed' && Array.isArray(self.ar_instances) && self.ar_instances.includes(instance)) {
		await instance.destroy(true, true, true)
	}
}//end close_alt_record



/**
* REBUILD_COLUMNS_MAP
* Prepend and append control columns to a base columns_map slice before it is
* passed to the row door (tiles), the hover overlay or the alt table.
*
* The function adds structural columns that are not declared in the ontology / request
* config but are needed by the portal's table controls:
*
*   - **`section_id` column** (prepended, table mode only) — renders the "open record"
*     button via `render_column_id`, ALWAYS without the drag handle: the table/hover
*     columns feed the hover overlay and the alt table, which are never a drag source
*     (the tile itself is). Skipped in mosaic mode (`view_mosaic === true`) because
*     card tiles do not have an ID column.
*
*   - **`ddinfo` column** (appended, table mode only) — shows the `component_info`
*     summary string.  Added only when `self.add_component_info === true`.
*
*   - **`remove` column** (appended, table mode only) — unlink / delete button.  Added
*     when the portal's source mode is not `'external'` AND `self.permissions > 1`.
*
* When `view_mosaic === true` (building the main mosaic card columns_map) none of the
* control columns are added; only the raw `base_columns_map` items are returned.
*
* @param {Array}   base_columns_map - The pre-filtered column descriptor slice to extend.
*   Each item shape: `{ id, label, width?, callback, tipo?, in_mosaic?, hover?, … }`.
* @param {Object}  self             - The `component_portal` instance (read: `add_component_info`,
*   `permissions`, `context.properties.source.mode`).
* @param {boolean} view_mosaic      - When `true`, suppress all control columns (mosaic card mode).
*   When `false`, add the full set of control columns (table / hover mode).
* @returns {Promise<Array>} The extended columns_map array with control columns spliced in.
*/
const rebuild_columns_map = async function(base_columns_map, self, view_mosaic) {

	const full_columns_map = []

	// column section_id
		if(!view_mosaic) {
			full_columns_map.push({
				id			: 'section_id',
				label		: 'Id',
				width		: 'auto',
				callback	: (options) => render_column_id({...options, drag : false})
			})
		}

	// base_columns_map
		full_columns_map.push(...base_columns_map)

	// column info and remove
		if(!view_mosaic) {
			// column component_info check
				if (self.add_component_info===true) {
					full_columns_map.push({
						id			: 'ddinfo',
						label		: 'Info',
						callback	: render_column_component_info
					})
				}

			// button_remove
				if(self.context?.properties?.source?.mode !=='external' && self.permissions>1) {
					full_columns_map.push({
						id			: 'remove',
						label		: '', // get_label.delete || 'Delete',
						width		: 'auto',
						callback	: render_column_remove
					})
				}
		}


	return full_columns_map
}//end rebuild_columns_map



// @license-end
