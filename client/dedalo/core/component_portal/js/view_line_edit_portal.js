// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_label, DEDALO_CORE_URL, Promise */
/*eslint no-undef: "error"*/



/**
* VIEW_LINE_EDIT_PORTAL
*
* Edit-mode "line" view for `component_portal`.
*
* The "line" view renders each linked target record as a compact horizontal row
* inside a scrollable list, as opposed to the "default" view (full table with
* header row) or the "mosaic" view (card grid).  It is chosen when the ontology
* or request-config sets `context.view = 'line'` and `mode = 'edit'`.
*
* Public API (all assigned as static methods on the exported constructor):
*   - `view_line_edit_portal.render(self, options)`   — top-level render entry point.
*   - `view_line_edit_portal.render_column_id(options)` — builds the "open record" cell
*       for this view, including an optional ontology-tree button for ontology sections.
*   - `view_line_edit_portal.render_column_remove(options)` — builds the "unlink" cell
*       with a native confirm dialog (simpler than the full modal used by the default view).
*
* Private helpers (module-local, not exported):
*   - `get_content_data(self, rows, children_view, id_variant)` — hands the page's rows
*       to the row door inside a `content_data` container; references, server-side
*       errors and the empty-iri placeholder go to the `.list_after` slot.
*   - `rebuild_columns_map(self)` — appends the `section_id` then the `remove`
*       column after the ontology-provided base columns; memoised via
*       `self.fixed_columns_map`.
*
* Differences from `view_default_edit_portal`:
*   - No column header row is built; the list is purely rows.
*   - The `render_column_id` implementation is simpler: no drag handle; the ROW is the
*       drag source (delegated, drag_and_drop.js bind_row_drag `source:'row'`).
*   - The `render_column_remove` implementation uses `window.confirm()` directly instead
*       of the multi-button modal. (!) This means there is no "delete resource" option here.
*   - Double-clicking the wrapper triggers `self.change_mode()` only when the portal is
*       embedded inside a parent portal (i.e. the component is not already in the main
*       section's edit mode). When the portal IS the main section's own component, no mode
*       change is needed and the event is ignored.
*
* Data shapes consumed from `self`:
*   - `self.context.view`          {string}  — e.g. `'line'`; also used as CSS class suffix.
*   - `self.context.children_view` {string}  — view used when building child section records.
*   - `self.columns_map`           {Array}   — ordered list of column descriptors; each has
*       `{ id, label, width, callback }`. Populated by the ontology / request-config builder
*       and extended here by `rebuild_columns_map`.
*   - `self.fixed_columns_map`     {boolean} — memoisation flag set by `rebuild_columns_map`.
*   - `self.add_component_info`    {boolean} — when true, injects `render_column_component_info`
*       as the callback for the `ddinfo` column.
*   - `self.data.references`       {Array}   — back-references to render at the bottom.
*   - `self.data.errors`           {Array}   — server-detected errors (e.g. infinite loops).
*   - `self.data.pagination`       {Object}  — `{ offset, limit }` adjusted on record removal.
*   - `self.total`                 {number}  — total matched records (pagination denominator).
*   - `self.permissions`           {number}  — `1` read-only, `≥2` full edit.
*   - `self.ar_instances`          {Array}   — accumulator for child instances; the row
*       door pushes the BUILT rows so they can be destroyed on teardown.
*   - `self.caller`                {Object|null} — parent instance; checked for `model` when
*       rendering a placeholder in the empty-and-inside-IRI case.
*   - `self.section_tipo`          {string}  — used to detect whether `self` lives in the
*       main page's section (dblclick guard) and to detect ontology sections.
*   - `self.mode`                  {string}  — current render mode (`'edit'`).
*
* @module view_line_edit_portal
* @see render_edit_component_portal.js  for the shared edit helpers and view dispatch.
* @see view_default_edit_portal.js      for the full-table default edit view.
* @see component_portal.js             for the constructor, lifecycle, and prototype wiring.
* @see docs/core/components/component_portal.md  for the full specification.
*/



// imports
	import {get_section_id_from_tipo} from '../../common/js/utils/index.js'
	import {ui} from '../../common/js/ui.js'
	import {render_value} from '../../common/js/utils/render_escape.js'
	import {render_error} from '../../common/js/render_common.js'
	import {dd_request_idle_callback} from '../../common/js/events.js'
	import {window_section_rows} from '../../section/js/section.js'
	import {place_list_after} from '../../common/js/common.js'
	import {
		render_column_component_info,
		add_wrapper_events,
		get_buttons_by_permissions,
		render_list_after
	} from './render_edit_component_portal.js'
	import {bind_row_drag, can_reorder, can_drag_out} from './drag_and_drop.js'



/**
* VIEW_LINE_EDIT_PORTAL
* Constructor stub for the line-view edit delegate.
*
* Never instantiated directly.  Static methods (`render`, `render_column_id`,
* `render_column_remove`) are assigned below and called by `render_edit_component_portal`
* when `self.context.view === 'line'`.
*
* @returns {boolean} Always true (constructor no-op).
*/
export const view_line_edit_portal = function() {

	return true
}//end view_line_edit_portal




/**
* RENDER
* Manages the component's logic and appearance in client side
*
* Top-level entry point for the line edit view. Called by `render_edit_component_portal.prototype.edit`
* when the resolved view is `'line'`.
*
* Execution order:
*   1. Rebuild `self.columns_map` (adds `section_id` and `remove` sentinel columns).
*   2. Hand the page rows to the row door (`window_section_rows`), N=0 included.
*   3. Build the `content_data` container (rows only; references, errors and the
*      empty-iri placeholder travel as `content_data.list_after`).
*   4. If `render_level === 'content'`, return only the inner container (used during
*      partial refresh — e.g. after an add/remove — without rebuilding the full wrapper).
*   5. Build the toolbar buttons if permissions allow.
*   6. Build the full component wrapper via `ui.component.build_wrapper_edit`, attach the
*      autocomplete activation handler via `add_wrapper_events`, and attach the
*      double-click mode-switch handler.
*
* The double-click handler switches the component to `{ mode: 'list', view: 'line' }` only
* when the portal is NOT already in the main section's edit mode.  This guard prevents an
* unnecessary mode round-trip when the component is directly on the main page rather than
* embedded inside another portal's record.
*
* @param {Object} self - The `component_portal` instance.
* @param {Object} options - Render options.
* @param {string} [options.render_level='full'] - `'full'` builds the whole wrapper;
*   `'content'` returns only the refreshed `content_data` node (partial re-render).
* @returns {Promise<HTMLElement>} The rendered wrapper node (full render) or the
*   `content_data` node (content-level render).
*/
view_line_edit_portal.render = async function(self, options) {

	// options
		const render_level = options.render_level || 'full'

	// columns_map
		self.columns_map = await rebuild_columns_map(self)

	// view
		const children_view	= self.context.children_view || self.context.view || 'default'

	// rows. The page's locator entries; instances are built by the row window
		const rows = self.data?.entries || []
		self.ar_instances = self.ar_instances || []

	// content_data
		const content_data = await get_content_data(self, rows, children_view, self.id + '_' + (new Date()).getTime())
		if (render_level==='content') {
			return content_data
		}

	// buttons
		const buttons = get_buttons_by_permissions(self) // full toolbar >1; update-external only at 1

	// wrapper. ui build_edit returns component wrapper
		const wrapper = ui.component.build_wrapper_edit(self, {
			content_data	: content_data,
			buttons			: buttons
			// label		: null
		})
		wrapper.classList.add('portal')
		// set pointers
		wrapper.content_data = content_data

	// list_after. The non-row sibling, right after content_data
		place_list_after(wrapper, content_data)

	// service autocomplete + the wrapper MOVE zone
		add_wrapper_events(self, wrapper)

	// change_mode
		const dblclick_handler = (e) => {
			e.stopPropagation()
			e.preventDefault()

			// get the section loaded in page as main section
			const loaded_section = window.dd_page.ar_instances.find(el => el.model === 'section')

			// check if the component is loaded by main section
			// if yes, the component is editable by itself
			// if not, the component is behind a portal and need to be changed to be editable
			const need_change_mode = (loaded_section
				&& loaded_section.mode === self.mode
				&& loaded_section.section_tipo === self.section_tipo)
				? false // is in the main section and the edit is available
				: true // in inside a portal and the edit is not available

			const change_mode = 'list'
			const change_view = 'line'

			// if the test get the component inside the main section do not perform the change mode
			if(need_change_mode === true){
				self.change_mode({
					mode	: change_mode,
					view	: change_view
				})
			}
		}
		wrapper.addEventListener('dblclick', dblclick_handler)


	return wrapper
}//end render



/**
* GET_CONTENT_DATA
* Build the (empty) `content_data` container and hand the page's rows to the ROW
* DOOR (section.js window_section_rows → section_record/js/record_window.js) on
* EVERY content render, N=0 included. Each row uses the default build (one
* section_record, `children_view`); the window keeps the row invariant and builds
* at most ROW_WINDOW_MAX_ROWS rows at once (audit P2-31 / CLI-29). The fill is done
* before this resolves.
*
* Drag/drop is DELEGATED on this content_data (drag_and_drop.js bind_row_drag,
* `source:'row'`): the window stamps `draggable` on the rows only while the portal
* source rule holds (`can_reorder || can_drag_out`), and every row is a drop
* target. The hover highlight is CSS `:hover` (no per-row listener).
*
* The `.list_after` slot (expando `content_data.list_after`, never inside
* content_data) carries, when present:
* - **Empty list + IRI caller:** the `span.component_placeholder` with `self.label`,
*   so the IRI component displays a meaningful fallback text in its inline widget.
* - **References:** `self.data.references` (component_relation_related back-references).
* - **Server errors:** `self.data.errors` (e.g. infinite-loop detection).
* - the print notice (more rows than the window builds at once).
*
* @param {Object} self - The `component_portal` instance.
* @param {Array} rows - The page's locator entries (`self.data.entries`).
* @param {string} children_view - The view each row is rendered with.
* @param {string} id_variant - Instance id variant for the rows of this render.
* @returns {Promise<HTMLElement>} The populated `content_data` container element.
*/
const get_content_data = async function(self, rows, children_view, id_variant) {

	// content_data
		const content_data = ui.component.build_content_data(self)

	// rows. The door, always (N=0 included)
		const record_window = await window_section_rows({
			caller			: self,
			container		: content_data,
			rows			: rows,
			records_options	: {
				mode		: 'list',
				view		: children_view,
				id_variant	: id_variant
			},
			layout			: 'list',
			draggable_rows	: can_reorder(self) || can_drag_out(self)
		})

	// drag and drop. Delegated: the row itself is the source
		if (record_window) {
			bind_row_drag(self, content_data, {
				source : 'row'
			})
		}

	// placeholder. No records found inside a component_iri
		const placeholder = (rows.length===0 && self.caller?.model==='component_iri')
			? ui.create_dom_element({
				element_type	: 'span',
				class_name		: 'component_placeholder',
				inner_html		: render_value(self.label, 'text')
			  })
			: null

	// errors (server side detected errors like infinite loops, etc.)
		const error = self.data.errors?.length
			? render_error(self.data.errors)
			: null

	// list_after. References, error, placeholder, print notice
		content_data.list_after = render_list_after(self, {
			content_data	: content_data,
			record_window	: record_window,
			error		: error,
			placeholder	: placeholder
		})


	return content_data
}//end get_content_data



/**
* REBUILD_COLUMNS_MAP
* Adding control columns to the columns_map that will be processed by section_records
*
* Constructs the final ordered columns array used by section_record renderers to lay
* out each row cell.  The order is always:
*   1. Base columns  — whatever the ontology / request-config defined (`self.columns_map`).
*      If `self.add_component_info === true`, the `ddinfo` column's callback is patched
*      to `render_column_component_info` so its cell renders the component-info overlay.
*   2. `section_id`  — "open record" button (after the text: see the note in the body).
*   3. `remove`      — unlink button (appended last, only when permissions > 1 and the
*      portal's source mode is not `'external'`, since external sources are read-only).
*
* The result is memoised: `self.fixed_columns_map` is set to `true` on first call and
* the existing `self.columns_map` is returned unchanged on subsequent calls, avoiding
* redundant work during partial re-renders (e.g. content-level refresh after pagination).
*
* @param {Object} self - The `component_portal` instance.
* @returns {Promise<Array>} The rebuilt columns_map array.
*/
const rebuild_columns_map = async function(self) {

	// columns_map already rebuilt case
		if (self.fixed_columns_map===true) {
			return self.columns_map
		}

	const columns_map = []

	// base_columns_map
		const base_columns_map = self.columns_map || []

	// if the component has compnent_info its parents
	// add its own render column, the `ddinfo`,
	// columns exists because is added into common.js get_columns_map()
	// here only added the rendered callback
		if (self.add_component_info===true) {
			base_columns_map.forEach(el => {
				if(el.id==='ddinfo'){
					el.callback	= render_column_component_info
				}
			})
		}
		columns_map.push(...base_columns_map)

	// column section_id, AFTER the record's text: a row nested in a list cell
	// shows pen + trash inline at the END of its text (view_line_portal.less), as
	// one unit (no break opportunity between the two buttons). Top-level rows
	// place them by flex `order`, so this DOM order changes nothing there
		columns_map.push({
			id			: 'section_id',
			label		: 'Id',
			width		: 'auto',
			callback	: view_line_edit_portal.render_column_id
		})

	// column remove
		if ( self.context?.properties?.source?.mode !== 'external' && self.permissions > 1) {
			columns_map.push({
				id			: 'remove',
				label		: '', // get_label.delete || 'Delete',
				width		: 'auto',
				callback	: view_line_edit_portal.render_column_remove
			})
		}


	// fixed as calculated
		self.fixed_columns_map = true


	return columns_map
}//end rebuild_columns_map



/**
* RENDER_COLUMN_ID
* It is called by section_record to create the column id with custom options
*
* Builds the leftmost cell for a single row in the line edit view.  The cell contains:
*
* - **`button_edit`** (always): clicking it calls `self.edit_record_handler()` to open
*   the target record (inline panel or page, depending on config).  Listening on
*   `mousedown` rather than `click` gives faster response and avoids interference with
*   the wrapper's `dblclick` handler.  A `focus` handler activates the component when
*   keyboard-tabbing into the button.
*
* - **Ontology-tree button** (only when the target section is an ontology section, i.e.
*   `get_section_id_from_tipo(self.section_tipo) === '0'`): opens a new `area_ontology`
*   window centred on the linked term.  This is used by thesaurus portals so cataloguers
*   can quickly jump to the ontology tree from the record.
*
* (!) This line-view implementation does NOT include a drag handle: the ROW is the
* drag source (delegated on content_data in `get_content_data`). The `render_column_id`
* exported by `render_edit_component_portal.js` (used by the default table view) is the
* richer version with the drag handle.
*
* (!) `SHOW_DEBUG` is a global injected by the page bootstrap; its absence would cause a
* reference error when the debug build is not loaded.  It is declared in the component's
* own file rather than here — the global-annotation header at the top of each file only
* lists globals used in that particular file.
*
* @param {Object} options - Options bag passed from the section_record renderer.
* @param {Object} options.caller - The `component_portal` instance (`self`).
* @param {string} options.section_id - The section_id of the linked target record.
* @param {string} options.section_tipo - The section_tipo of the linked target record.
* @returns {DocumentFragment} Fragment containing the button_edit and, conditionally,
*   the ontology-tree button.
*/
view_line_edit_portal.render_column_id = function(options) {

	// options
		const self			= options.caller
		const section_id	= options.section_id
		const section_tipo	= options.section_tipo

	const fragment = new DocumentFragment()

	// edit icon title, also the icon-only button's accessible name (axe button-name)
		const pen_title = SHOW_DEBUG
			? (get_label.open || 'Open') + ` ${section_tipo}-${section_id}`
			: (get_label.open || 'Open')

	// button_edit
		const button_edit = ui.create_dom_element({
			element_type	: 'button',
			class_name		: 'button_edit button_view_' + (self.view || self.context.view || 'default'),
			aria			: {label : pen_title},
			parent			: fragment
		})
		// click event
		const click_handler = (e) => {
			e.stopPropagation()
			// edit_record_handler
			self.edit_record_handler({
				section_tipo	: section_tipo,
				section_id		: section_id
			})
		}
		button_edit.addEventListener('mousedown', click_handler)
		// focus event
		const focus_handler = (e) => {
			// force activate on input focus (tabulating case)
			if (!self.active) {
				ui.component.activate(self)
			}
		}
		button_edit.addEventListener('focus', focus_handler)

	// edit icon
		ui.create_dom_element({
			element_type	: 'span',
			class_name		: 'button pen icon grey',
			title			: pen_title,
			parent			: button_edit
		})

	// button_tree ontology only
		const is_ontology = get_section_id_from_tipo(self.section_tipo) === '0'
		if (is_ontology) {
			// button_tree
			const button_tree = ui.create_dom_element({
				element_type	: 'span',
				class_name		: 'button tree grey',
				title			: pen_title,
				parent			: fragment
			})
			// mousedown event
			const mousedown_handler = (e) => {
				e.stopPropagation()
				// open new area_ontology window and search the current term
				const search_tipos = section_tipo + section_id
				self.open_ontology_window('default', search_tipos)
			}
			button_tree.addEventListener('mousedown', mousedown_handler)
		}


	return fragment
}//end render_column_id



/**
* RENDER_COLUMN_REMOVE
* It is called by section_record to create the column remove with custom options
* Render column_remove node
* Shared across views
*
* Builds the rightmost cell for a row in the line edit view: a single "unlink" button
* that removes the locator from the portal's data array.
*
* Unlike the full modal used by `render_edit_component_portal.render_column_remove` (which
* offers both "unlink only" and "delete resource + links" choices), this simpler version
* uses a native `window.confirm()` dialog with the `get_label.sure` text.  This keeps the
* line-view UI compact; the trade-off is that there is no "hard delete" option here.
*
* Pagination offset adjustment: when the row being removed is the first item on a page
* that is not the very first page (`row_key === 0 && pagination.offset > 0`), the stored
* `pagination.offset` is decremented by `pagination.limit` before the save API call so
* that the returned page window is correct after the removal.
*
* After unlinking, `dd_request_idle_callback` removes any visible Tippy tooltip
* (`'.ct.ct--shown'`) that may have been left open over the now-removed button.
*
* (!) Uses `window.confirm()` which blocks the main thread — this is a deliberate UX
* decision kept for simplicity in the line view; do not replace with a modal without
* a broader review.
*
* @param {Object} options - Options bag passed from the section_record renderer.
* @param {Object} options.caller - The `component_portal` instance (`self`).
* @param {number} options.row_key - Zero-based index in the full (unpaginated) data array.
* @param {number} options.paginated_key - Zero-based index within the current page window.
* @param {string} options.section_id - The section_id of the linked target record.
* @param {string} options.section_tipo - The section_tipo of the linked target record.
* @param {Object} options.locator - The full locator object to unlink.
* @returns {HTMLElement} The `button_remove` element.
*/
view_line_edit_portal.render_column_remove = function(options) {

	// options
		const self				= options.caller
		const row_key			= options.row_key
		const paginated_key		= options.paginated_key
		const section_id		= options.section_id
		const section_tipo		= options.section_tipo
		// const locator		= options.locator

	// button_remove
		const button_remove = ui.create_dom_element({
			element_type	: 'button',
			class_name		: 'button_remove'
		})
		// click event
		const click_handler = async (e) => {
			e.stopPropagation()

			// stop if the user does not confirm
				if (!confirm(get_label.sure)) {
					return
				}

			// data pagination offset. Check and update self data to allow save API request return the proper paginated data
				const key				= parseInt(row_key)
				const previous_offset	= self.data.pagination.offset
				if (key===0 && self.data.pagination.offset>0) {
					const next_offset = (self.data.pagination.offset - self.data.pagination.limit)
					// set before exec API request on Save
					self.data.pagination.offset = next_offset>0
						? next_offset
						: 0
				}

			// fire the unlink_record method
			// Note that this function refresh current instance. Its answer is READ:
			// a refused unlink (already surfaced by the save path) leaves the row
			// in place, so the offset moved above must be put back or the next
			// save would page the portal to a slot the row never left.
				const removed = await self.unlink_record(options.locator)
				if (removed!==true) {
					self.data.pagination.offset = previous_offset
					return
				}

			// remove the tooltip
				dd_request_idle_callback(
					() => {
						const tooltip = document.querySelector('.ct.ct--shown')
						if (tooltip) {
							tooltip.classList.remove('ct--shown')
						}
					}
				);
		}
		button_remove.addEventListener('click', click_handler)
		// focus event
		const focus_handler = (e) => {
			// force activate on input focus (tabulating case)
			if (!self.active) {
				ui.component.activate(self)
			}
		}
		button_remove.addEventListener('focus', focus_handler)

	// remove_icon
		ui.create_dom_element({
			element_type	: 'span',
			class_name		: 'button delete_light icon grey',
			title			: (get_label.delete_only_the_link || 'Delete only link'),
			parent			: button_remove
		})


	return button_remove
}//end render_column_remove



// @license-end
