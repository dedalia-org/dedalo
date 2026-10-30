// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global  */
/*eslint no-undef: "error"*/



// imports
	import {window_section_rows} from '../../section/js/section.js'
	import {event_manager} from '../../common/js/event_manager.js'
	import {ui} from '../../common/js/ui.js'
	import {
		render_column_id,
		render_column_component_info,
		render_column_remove,
		get_buttons_by_permissions,
		add_wrapper_events,
		add_section_record_drag_and_drop,
		render_references
	} from './render_edit_component_portal.js'



/**
* VIEW_MOSAIC_EDIT_PORTAL
* Edit-mode mosaic (card grid) view for `component_portal`.
*
* This module renders the portal's linked records as a CSS grid of visual cards rather
* than a table.  It is dispatched by `render_edit_component_portal.prototype.edit` when
* `self.context.view === 'mosaic'`.
*
* Layout overview:
*
*   wrapper
*     └── list_body  (CSS grid; card tiles built from the `in_mosaic` column subset)
*           └── content_data
*                 └── <section_record_node>   ×N   (one mosaic tile per linked record)
*                       └── hover_view        (overlaid on mouseenter; hidden by default)
*                             └── button_alt_container  (info icon → opens table detail modal)
*     └── buttons  (portal toolbar; only when permissions > 1)
*
* Every row (linked record) is THREE section_records, each with its own `columns_map`
* slice and `id_variant` so their DOM ids never collide:
*
*   1. **Mosaic record** (`id_variant` default) — rendered using only the columns that
*      carry `in_mosaic: true` in `self.columns_map`.  These become the visible card tiles.
*
*   2. **Hover record** (`id_variant: 'hover'`) — rendered using columns that carry
*      `hover: true`.  Each hover record is prepended into its matching mosaic tile and
*      remains hidden until the user mouses over the tile.
*
*   3. **Alternative table record** (`id_variant: 'table'`) — a full-column table row
*      of the record, revealed inside a modal when the user clicks the info icon on the
*      hover overlay.  Its rows live in `alt_list_body` (header built once in `render`),
*      which is NOT appended to the DOM here; it is passed into the modal on demand by
*      `subscribe_alt_row`'s event handler (see below).
*
* The rows are WINDOWED (audit P2-31 / CLI-29): `get_content_data` hands the page's
* entries to section.js `window_section_rows` with a custom materialize that builds
* the three records of ONE row (tile + hover + alt) and a release that destroys them
* and unsubscribes the row's bridge event — so at most ROW_WINDOW_MAX_ROWS tiles
* (and their companions) exist at once, however many rows "show all" brings.
*
* Pub/Sub bridge (mosaic ↔ table detail):
*   - `render_hover_view` publishes `mosaic_show_<id_base>_<section_tipo>_<section_id>`
*     when the user clicks the info icon button.
*   - `subscribe_alt_row` subscribes to that same event (deduplicated via
*     `event_manager.get_events()`) and, upon receipt, opens the matching table row in a
*     `dd-modal` (see `ui.attach_to_modal`).
*   - A separate `button_edit_click` subscription inside the handler closes the modal
*     when the user triggers a record-open action from within the table view.
*
* The materialized section_record instances are pushed into `self.ar_instances` so they
* are properly destroyed when the portal is refreshed or destroyed (a released row
* leaves it through its own destroy).
* All event subscriptions are pushed into `self.events_tokens` for cleanup.
*
* Key `self` properties consumed:
*   @see component_portal.js for the full instance shape.
*   - `self.columns_map`      {Array}   — full columns map; `in_mosaic` and `hover` flags
*                                         select the two sub-sets (set by `get_columns_map`
*                                         in `common.js` for the `'mosaic'` view).
*   - `self.ar_instances`     {Array}   — accumulator for child section_record instances.
*   - `self.events_tokens`    {Array}   — accumulator for event subscriptions.
*   - `self.permissions`      {number}  — 1 = read-only, 2 = full edit.
*   - `self.caller`           {Object}  — parent instance; checked for `tool_time_machine`.
*   - `self.data.references`  {Array}   — optional back-reference list rendered at the
*                                         bottom of the alternative table view.
*   - `self.context.css`      {Object}  — optional CSS overrides applied to `content_data`.
*   - `self.context.view`     {string}  — expected to be `'mosaic'` for this module.
*   - `self.total`            {number}  — total linked records (used by drag/drop clamp).
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
* when `self.context.view === 'mosaic'`.  It resolves the three column maps (mosaic,
* hover, alternative table), builds the alternative table's shell, and hands the rows
* to `get_content_data`, whose row window materializes them on demand.
*
* Execution order:
*   1. Build the **alternative table shell** (`alt_list_body`: close button + header).
*      It is not appended to the DOM; `subscribe_alt_row` holds a reference and moves
*      it into a modal on demand.  Skipped when the caller is `tool_time_machine`
*      because time-machine snapshots are read-only and do not need inline editing.
*   2. Resolve the **hover** columns map (`hover: true` subset of `columns_map`).
*   3. Resolve the **mosaic** columns map (`in_mosaic: true` subset of `columns_map`).
*   4. Assemble `content_data` (card grid) by calling `get_content_data`, whose window
*      builds, per reachable row:
*      - the mosaic tile, with the matching hover view prepended,
*      - `mouseenter`/`mouseleave` toggle events on the tile,
*      - drag-and-drop handlers when permissions ≥ 2,
*      - the alternative table row (hidden, in `alt_list_body`) and its bridge event.
*   5. When `render_level === 'content'` return only the `content_data` node (partial refresh).
*   6. Otherwise wrap in `list_body` → `wrapper`, attach the toolbar buttons, wire
*      wrapper-level autocomplete + drag/drop events, and apply read-only context-menu
*      suppression when permissions < 2.
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

	// alt. The alternative table shell (close button + header); its rows are
	// materialized per window row. Null inside tool_time_machine (read-only).
		const alt = await (async ()=>{

			// inside tool_time_machine case. Do not create the alt_list_body columns
				if (self.caller && self.caller.model==='tool_time_machine') {
					return null
				}

			// alt_list_body
				const alt_list_body = ui.create_dom_element({
					element_type	: 'div',
					class_name		: 'alt_list_body display_none'
				})

			// close_alt_list_body
				const close_alt_list_body = ui.create_dom_element({
					element_type	: 'div',
					class_name		: 'button close close_alt_list_body',
					parent 			: alt_list_body
				})
				close_alt_list_body.addEventListener('click', function(e){
					e.stopPropagation()
					alt_list_body.classList.add('display_none')
				})

			// columns
				const alt_columns_map	= await rebuild_columns_map(self.columns_map, self, false)

			// header. Build using common ui builder
				const list_header_node = ui.render_list_header(alt_columns_map, self)
				alt_list_body.appendChild(list_header_node)

			// references. Build references if exists (the rows are inserted before it)
				let references_node = null
				if(self.data.references && self.data.references.length>0){
					references_node = ui.create_dom_element({
						element_type	: 'div',
						class_name		: 'references_wrapper',
						parent			: alt_list_body
					})
					references_node.appendChild(render_references(self.data.references))
				}

			// alt_list_body columns
				const alt_items				= ui.flat_column_items(alt_columns_map);
				const alt_template_columns	= alt_items.join(' ')
				Object.assign(
					alt_list_body.style,
					{
						"grid-template-columns": alt_template_columns
					}
				)

			return {
				list_body	: alt_list_body,
				columns_map	: alt_columns_map,
				references	: references_node
			}
		})()

		// hover columns
			const hover_columns		= self.columns_map.filter(el => el.hover===true)
			const hover_columns_map	= await rebuild_columns_map(hover_columns, self, false)

	// content_data. Create the mosaic with only the marked ddo as "mosaic" with true value
		// columns_map
			const base_columns_map	= self.columns_map.filter(el => el.in_mosaic===true)
			const columns_map		= await rebuild_columns_map(base_columns_map, self, true)

		// rows. The page's locator entries; instances are built by the row window
			const rows = self.data?.entries || []

		// content_data
			const content_data = await get_content_data(self, rows, {
				columns_map			: columns_map,
				hover_columns_map	: hover_columns_map,
				alt					: alt
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

	// top
		// const top = get_top(self)

	// wrapper. ui build_edit returns component wrapper
		const wrapper = ui.component.build_wrapper_edit(self, {
			// content_data	: content_data,
			buttons			: buttons,
			list_body		: list_body
			// top			: top
		})
		wrapper.classList.add('portal', 'view_' + (self.view || self.context.view || 'default'))
		// set pointers
		wrapper.list_body		= list_body
		wrapper.content_data	= content_data

	// service autocomplete + drag/drop
		add_wrapper_events(self, wrapper, {drag_drop: true})

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
* Build the `content_data` card grid and hand the page's rows to a ROW WINDOW
* (section.js window_section_rows → common/js/row_window.js): the three
* section_records of a row (tile, hover overlay, alternative table row) are
* built and rendered only for the rows the viewport can reach — at most
* ROW_WINDOW_MAX_ROWS at once — and released past the far edge (audit P2-31 /
* CLI-29). The first window is filled before this resolves.
*
* Per materialized row:
*   1. Builds the tile, hover and (unless inside tool_time_machine) alt records
*      through the window's `build_row`, each with its columns_map slice / id_variant.
*   2. Renders the tile and its hover overlay (`render_hover_view`) concurrently and
*      prepends the overlay into the tile (hidden via CSS `display_none` until
*      `mouseenter`).
*   3. Attaches `mouseenter` / `mouseleave` listeners that toggle the overlay and the
*      `mosaic_over` highlight class on the tile.
*   4. Attaches drag-and-drop handlers to the tile when `self.permissions >= 2`
*      (`paginated_key` is the row's page index).
*   5. Renders the alt row hidden into `alt.list_body` and subscribes its bridge
*      event (`subscribe_alt_row`).
* Per released row: destroys the three records, removes the alt row node and
* unsubscribes the bridge event.
*
* Any `height` style override declared in `self.context.css['.content_data'].style.height`
* is applied inline to support ontology-driven CSS customisation per portal instance.
*
* @param {Object} self - The `component_portal` instance.
* @param {Array}  rows - The page's locator entries (`self.data.entries`).
* @param {Object} maps
* @param {Array}  maps.columns_map       - The `in_mosaic` columns (tile).
* @param {Array}  maps.hover_columns_map - The `hover` columns (overlay).
* @param {Object|null} maps.alt          - `{list_body, columns_map}` of the alternative
*                                          table, or null when it is not built.
* @returns {Promise<HTMLElement>} The populated `content_data` div node.
*/
const get_content_data = async function(self, rows, maps) {

	// content_data
		const content_data = ui.component.build_content_data(self)

	// row window
		if (rows.length > 0) {

			// index → the row's three instances and its bridge token
			const companions = new Map()

			await window_section_rows({
				caller			: self,
				container		: content_data,
				rows			: rows,
				records_options	: {
					mode : 'list'
				},
				materialize		: async (row, i, build_row) => {

					// the three records of the row, built together
					const [section_record, hover_section_record, alt_section_record] = await Promise.all([
						build_row({ columns_map: maps.columns_map }),
						build_row({ columns_map: maps.hover_columns_map, id_variant: 'hover' }),
						maps.alt
							? build_row({ columns_map: maps.alt.columns_map, id_variant: 'table' })
							: Promise.resolve(null)
					])
					if (!section_record || !hover_section_record) {
						for (const built of [section_record, hover_section_record, alt_section_record]) {
							if (built && built.status!=='destroyed') {
								await built.destroy(true, true, true)
							}
						}
						return null
					}

					// tile + hover overlay
					const [section_record_node, hover_view] = await Promise.all([
						section_record.render(),
						render_hover_view(self, hover_section_record)
					])
					section_record_node.prepend(hover_view)

					// drag and drop
					if (self.permissions >= 2) {
						add_section_record_drag_and_drop({
							section_record_node : section_record_node,
							paginated_key       : i,
							total_records       : self.total,
							locator             : section_record.locator,
							caller              : self
						})
					}

					// mouseenter event
					section_record_node.addEventListener('mouseenter', function(e) {
						e.stopPropagation()
						hover_view.classList.remove('display_none')
						section_record_node.classList.add('mosaic_over')
					})

					// mouseleave event
					section_record_node.addEventListener('mouseleave', function(e) {
						e.stopPropagation()
						hover_view.classList.add('display_none')
						section_record_node.classList.remove('mosaic_over')
					})

					// alt row (hidden, inside alt_list_body) + bridge event
					let alt_node	= null
					let alt_token	= null
					if (alt_section_record && maps.alt) {
						alt_node = await alt_section_record.render()
						alt_node.classList.add('display_none')
						alt_token = subscribe_alt_row(self, alt_section_record, alt_node, maps.alt.list_body)
						maps.alt.list_body.insertBefore(alt_node, maps.alt.references)
					}

					companions.set(i, {
						section_record			: section_record,
						hover_section_record	: hover_section_record,
						alt_section_record		: alt_section_record,
						alt_node				: alt_node,
						alt_token				: alt_token
					})

					return section_record_node
				},
				release			: async (row, i) => {
					const companion = companions.get(i)
					companions.delete(i)
					if (!companion) {
						return
					}
					if (companion.alt_token) {
						event_manager.unsubscribe(companion.alt_token)
						const token_index = self.events_tokens.indexOf(companion.alt_token)
						if (token_index!==-1) {
							self.events_tokens.splice(token_index, 1)
						}
					}
					if (companion.alt_node) {
						companion.alt_node.remove()
					}
					for (const built of [companion.section_record, companion.hover_section_record, companion.alt_section_record]) {
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
* SUBSCRIBE_ALT_ROW
* Wire ONE alternative-table row to the pub/sub bridge that opens it in a modal
* when the user clicks the hover info icon of its tile.
*
* This function is the subscriber side of the mosaic ↔ table-detail bridge:
*   1. Derives the event key:
*        `mosaic_show_<id_base>_<section_tipo>_<section_id>`
*      where `id_base` is the section_record's stable cross-page identifier (a composite
*      string of tipo + section_id + parent context — see `section_record.id_base`).
*   2. Checks `event_manager.get_events()` to prevent duplicate subscriptions when the
*      portal is refreshed without being fully destroyed.
*   3. Subscribes `fn_mosaic_show_alt`: on the first publish of the event it —
*      a. Hides all peer nodes in the same parent (keeping only the header and close button).
*      b. Makes `alt_list_body` and this record's node visible.
*      c. Wraps both in a `dd-modal` (via `ui.attach_to_modal`) labelled "Editing mosaic inline".
*      d. Subscribes a one-shot `button_edit_click` listener that closes the modal and
*         unsubscribes itself via `event_manager.unsubscribe(token)`.
*
* The window's release unsubscribes the returned token when the row leaves the
* window, so a re-materialized row subscribes again.
*
* (!) The `fn_mosaic_show_alt` closure captures both `section_record_node` and `alt_list_body`.
* `alt_list_body` is a reference to the shared node created in `render`; moving it
* into the modal body removes it from any prior DOM parent (correct behaviour — only one
* modal can show it at a time).
*
* (!) The `modal.on_close` callback is commented out deliberately: auto-refreshing on
* close caused UX issues. Manual refresh via the edit-button path is the intended flow.
*
* @param {Object}        self                - The `component_portal` instance.
* @param {Object}        section_record      - The row's alternative-table section_record
*                                              (`id_variant: 'table'`; full columns).
* @param {HTMLElement}   section_record_node - Its rendered (hidden) node.
* @param {HTMLElement}   alt_list_body       - The shared `alt_list_body` container node
*                                              created in `render`; passed by reference
*                                              so the event handler can move it into a modal.
* @returns {string|null} The subscription token (null when already subscribed).
*/
const subscribe_alt_row = function(self, section_record, section_record_node, alt_list_body) {

	// event subscribe
	// On user click button 'alt' trigger a event that we subscribe here to show the
	// proper table section record and hide the others
		const event_id = `mosaic_show_${section_record.id_base}_${section_record.caller.section_tipo}_${section_record.caller.section_id}`
		const found = event_manager.get_events().find(el => el.event_name===event_id)
		if (found) {
			return null
		}

		const fn_mosaic_show_alt = function() {

			// hide all except the header
				const ar_child_node	= section_record_node.parentNode.children;
				const len			= ar_child_node.length
				for (let i = len - 1; i >= 0; i--) {
					const node = ar_child_node[i]
					if(node.classList.contains('header_wrapper_list') || node.classList.contains('close_alt_list_body')){
						continue
					}
					node.classList.add('display_none')
				}
			// show list
				alt_list_body.classList.remove('display_none')
				section_record_node.classList.remove('display_none')

			// header
				const header = ui.create_dom_element({
					element_type	: 'div',
					inner_html		: 'Editing mosaic inline'
				})

			// body
				const body = ui.create_dom_element({
					element_type	: 'div',
					class_name		: 'body content'
				})
				body.appendChild(alt_list_body)

			// modal way
				const modal = ui.attach_to_modal({
					header	: header,
					body	: body,
					footer	: null,
					size	: 'normal'
				})
				self.modal = modal
				// modal.on_close = () => {
				// 	self.refresh()
				// }

			// user click edit button action close the modal box
				let token
				const button_edit_click_handler = () => {
					event_manager.unsubscribe(token)
					modal.close()
				}
				token = event_manager.subscribe('button_edit_click', button_edit_click_handler)
				self.events_tokens.push(token)
		}
		const token = event_manager.subscribe(event_id, fn_mosaic_show_alt)
		self.events_tokens.push(token)


	return token
}//end subscribe_alt_row



/**
* RENDER_HOVER_VIEW
* Build the hover overlay node for a single mosaic tile.
*
* The hover view is a rendered section_record (using the `hover`-flagged columns) with two
* extras appended on top:
*
*   1. The section_record's own component nodes (e.g. a label or thumbnail defined in the
*      ontology with `hover: true`) provide at-a-glance info without needing to open the
*      full record.
*
*   2. A `button_alt_container` div with an info icon (`<span class="button info with_bg">`)
*      is appended to the rendered node.  Clicking this button publishes the event:
*        `mosaic_show_<id_base>_<section_tipo>_<section_id>`
*      which is picked up by the matching subscriber in `subscribe_alt_row`
*      to open the full table detail in a modal.
*
* The returned node starts life with the classes `sr_mosaic_hover display_none`; the
* `display_none` is toggled by `get_content_data`'s `mouseenter`/`mouseleave` handlers.
*
* @param {Object} self                  - The `component_portal` instance.
* @param {Object} hover_section_record  - A single section_record instance built from the
*                                         `hover: true` column subset (`id_variant: 'hover'`).
* @returns {Promise<HTMLElement>} The rendered hover overlay node (initially hidden).
*/
const render_hover_view = async function(self, hover_section_record) {

	// add section_record rendered nodes
	// section_record
		const section_record_node = await hover_section_record.render()
			  section_record_node.classList.add('sr_mosaic_hover', 'display_none')

	// button alt view (table)
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
		// event publish
		// When user clicks 'alt' button, send an event 'mosaic_show_' + section_record_node.id
		button_alt_container.addEventListener('mouseup', function(e){
			e.stopPropagation()
			const event_id = `mosaic_show_${hover_section_record.id_base}_${hover_section_record.caller.section_tipo}_${hover_section_record.caller.section_id}`
			event_manager.publish(event_id, this)
		})


	return section_record_node
}//end render_hover_view



/**
* REBUILD_COLUMNS_MAP
* Prepend and append control columns to a base columns_map slice before it is
* passed to the row window (one section_record per row and slice).
*
* The function adds structural columns that are not declared in the ontology / request
* config but are needed by the portal's table controls:
*
*   - **`section_id` column** (prepended, table mode only) — renders the "open record"
*     button, drag handle, and drop target via `render_column_id`.  Skipped in mosaic
*     mode (`view_mosaic === true`) because card tiles do not have an ID column.
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
				callback	: render_column_id
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
