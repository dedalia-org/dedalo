// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/* global get_label, page_globals, SHOW_DEBUG, DEDALO_CORE_URL,Promise */
/*eslint no-undef: "error"*/



/**
* VIEW_DEFAULT_EDIT_PORTAL
* Default table-style edit-mode view for `component_portal`.
*
* This module implements the "default" render path dispatched by
* `render_edit_component_portal.prototype.edit` when `self.context.view` is `'default'`
* (or absent/unrecognised).  It is also the fallback used by the `'print'` view after
* forcing permissions to read-only.
*
* Layout produced (WC-2026-10-30-section-record-row-box):
*   wrapper
*     └── list_body.layout_table [role=table]  (CSS grid; column widths from columns_map)
*           ├── header_wrapper_list [role=row]  (built by build_header; hidden when list is empty)
*           └── content_data [role=rowgroup]    (EXACTLY one .section_record row per entry)
*     └── list_after   (references; never inside the role=table list_body)
*     └── buttons  (add / link / tree / fullscreen — only rendered when permissions > 1)
*
* The number of grid columns is driven by `columns_map`, which is assembled in
* `rebuild_columns_map` and stored on `self` so that partial refreshes (`render_level='content'`)
* can skip the expensive rebuild step.
*
* Exports:
*   `view_default_edit_portal` — namespace constructor (never instantiated directly).
*   `view_default_edit_portal.render` — async static entry point called by the dispatch layer.
*
* @module view_default_edit_portal
* @see render_edit_component_portal.js  for the view-dispatch switch and all shared helpers.
* @see component_portal.js             for the constructor, data shape, and lifecycle.
* @see docs/core/components/component_portal.md for the full specification.
*/



// imports
	import {window_section_rows} from '../../section/js/section.js'
	import {place_list_after} from '../../common/js/common.js'
	import {apply_table_semantics} from '../../section_record/js/record_window.js'
	import {ui} from '../../common/js/ui.js'
	import {set_element_css} from '../../page/js/css.js'
	import {
		render_column_id,
		render_column_component_info,
		render_column_remove,
		get_buttons_by_permissions,
		add_wrapper_events,
		build_header,
		render_list_after,
		open_move_to_position
	} from './render_edit_component_portal.js'
	import {bind_row_drag} from './drag_and_drop.js'



/**
* VIEW_DEFAULT_EDIT_PORTAL
* Namespace constructor for the default edit-mode portal view.
*
* Never instantiated — only the static `render` method is called by
* `render_edit_component_portal.prototype.edit`. Defined as a function to
* follow the Dédalo view-module pattern (enables `instanceof` checks and
* consistent module structure across all view modules).
*
* @returns {boolean} Always true.
*/
export const view_default_edit_portal = function() {

	return true
}//end view_default_edit_portal



/**
* RENDER
* Build (or partially refresh) the default tabular edit view for a portal instance.
*
* Two execution paths are controlled by `options.render_level`:
*
* - `'full'` (default): constructs the full DOM tree including the `list_body` grid
*   wrapper (`layout_table`, table semantics), the column header row, the rows, the
*   `.list_after` slot, the button toolbar, and the outer component wrapper. The
*   autocomplete click handler and the wrapper MOVE zone are attached via
*   `add_wrapper_events`.
*
* - `'content'`: only rebuilds the inner `content_data` node (the rows) and updates
*   the visibility of the existing `header_wrapper_list` to match whether the list
*   is non-empty.  The existing wrapper and list_body are left in place.  This path
*   is used by `self.refresh()` so that pagination changes avoid a full re-render.
*
* Side-effects:
* - Calls `rebuild_columns_map(self)`, which sets `self.columns_map` and
*   `self.fixed_columns_map = true` after the first build so subsequent partial
*   refreshes reuse the cached result.
* - The row door (window_section_rows) pushes the BUILT section_record instances onto
*   `self.ar_instances` (never the whole page) so that `self.destroy()` can clean them up.
* - Injects a dynamic `<style>` rule via `set_element_css` to set the CSS Grid
*   `grid-template-columns` value for the `.list_body` element.  The selector is
*   scoped to `<section_tipo>_<tipo>.edit.view_<view>` to avoid collisions.
* - Sets `wrapper.list_body` and `wrapper.content_data` as DOM node properties for
*   fast access in subsequent refresh cycles.
*
* @param {Object} self - The `component_portal` instance being rendered.
* @param {Object} options - Render options.
* @param {string} [options.render_level='full'] - `'full'` for a complete re-render;
*   `'content'` to only refresh the record rows inside an existing wrapper.
* @returns {Promise<HTMLElement>} The component wrapper (full render) or the
*   `content_data` node (content-only render).
*/
view_default_edit_portal.render = async function(self, options) {

	// options
		const render_level = options.render_level || 'full'

	// columns_map
		const columns_map	= await rebuild_columns_map(self)
		self.columns_map	= columns_map

	// rows. The page's locator entries; instances are built by the row window
		const rows = self.data?.entries || []
		self.ar_instances = self.ar_instances || []

	// content_data
		const content_data = await get_content_data(self, rows)
		if (render_level==='content') {
			// show header_wrapper_list if is hidden
			const header_wrapper_list = self.node.list_body
				? self.node.list_body.querySelector(":scope >.header_wrapper_list")
				: null;
			if (header_wrapper_list) {
				if (rows.length>0) {
					header_wrapper_list.classList.remove('hide')
				}else{
					header_wrapper_list.classList.add('hide')
				}
			}

			return content_data
		}

	// header
		const list_header_node = build_header(columns_map, rows, self)

	// list_body
		const list_body = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'list_body'
		})

		const items				= ui.flat_column_items(columns_map);
		const template_columns	= items.join(' ')

		// new way on-the-fly css
		// Inject a scoped CSS rule so the .list_body grid tracks the active columns_map.
		// Using set_element_css avoids a style attribute on the element itself and lets
		// the rule be overridden by a theme stylesheet when needed.
			const css_object = {
				".list_body" : {
					"grid-template-columns" : template_columns
				}
			}
			const selector = `${self.section_tipo}_${self.tipo}.edit.view_${self.view}`
			set_element_css(selector, css_object)

		list_body.appendChild(list_header_node)
		list_body.appendChild(content_data)

	// table marker
		list_body.classList.add('layout_table')

	// buttons
		const buttons = get_buttons_by_permissions(self) // full toolbar >1; update-external only at 1

	// wrapper. ui build_edit returns component wrapper
		const wrapper_options = {
			list_body	: list_body,
			buttons		: buttons,
			add_styles	: ['portal'] // added to the wrapper before view style
		}
		const wrapper = ui.component.build_wrapper_edit(self, wrapper_options)

	// table semantics (static half; the window owns rowgroup / rows / cells).
	// After the wrapper: its label node (id set by a11y.label_group) names the table
		apply_table_semantics(list_body, list_header_node, wrapper.label?.id || null)

	// set pointers
	// Attach child nodes as named properties on the wrapper for O(1) access during refresh.
		wrapper.list_body		= list_body
		wrapper.content_data	= content_data

	// list_after. The non-row sibling, right after list_body (never inside role=table)
		place_list_after(wrapper, content_data)

	// service autocomplete + the wrapper MOVE zone (a record dragged from another portal)
		add_wrapper_events(self, wrapper)


	return wrapper
}//end render



/**
* GET_CONTENT_DATA
* Build the (empty) `content_data` container and hand the page's rows to the ROW
* DOOR (section.js window_section_rows → section_record/js/record_window.js) on
* EVERY content render, N=0 included (a zero-row window supersedes and retires the
* previous one). The window keeps the row invariant: `content_data.children` is
* exactly one `.section_record` per entry, in index order, `data-index` = page
* position; at most ROW_WINDOW_MAX_ROWS rows are built at once (placeholders
* beyond, audit P2-31 / CLI-29). The fill is done before this resolves.
*
* Drag/drop is DELEGATED on this content_data (drag_and_drop.js bind_row_drag,
* `source:'handle'`: rows stay non-draggable so their inputs keep text selection;
* the `.drag` handle of render_column_id is the source, dblclick / Enter on it
* opens move-to-position). Registered with the window's signal: retire / destroy
* removes it.
*
* Non-row content (`self.data.references`, the print notice) never goes into
* content_data: it travels as the expando `content_data.list_after`, placed after
* list_body by the full render and swapped by `common.render('content')`.
*
* @param {Object} self - The `component_portal` instance.
* @param {Array} rows - The page's locator entries (`self.data.entries`).
* @returns {Promise<HTMLElement>} The populated `content_data` element, ready to be
*   inserted into `list_body`.
*/
const get_content_data = async function(self, rows) {

	// content_data node
		const content_data = ui.component.build_content_data(self)

	// rows. The door, always (N=0 included)
		const record_window = await window_section_rows({
			caller			: self,
			container		: content_data,
			rows			: rows,
			records_options	: {
				mode : 'list'
			},
			layout			: 'table'
		})

	// drag and drop. Delegated: the row's own .drag handle is the source
		if (record_window) {
			bind_row_drag(self, content_data, {
				source			: 'handle',
				open_position	: (index, options) => open_move_to_position(self, index, options)
			})
		}

	// list_after. References + print notice (never inside content_data)
		content_data.list_after = render_list_after(self, {
			content_data	: content_data,
			record_window	: record_window
		})


	return content_data
}//end get_content_data



/**
* REBUILD_COLUMNS_MAP
* Assemble the full ordered list of column descriptors for the default table view,
* prepending the built-in ID column, inserting the caller-supplied `base_columns_map`
* from `self.columns_map`, and appending the optional `ddinfo` and remove-button columns.
*
* Each descriptor in the returned array is a plain object:
*   {
*     id       : {string}   — unique column key (e.g. 'section_id', 'remove', 'empty')
*     label    : {string}   — text for the column header cell
*     width    : {string}   [optional] — CSS grid track size, e.g. 'auto' or '1fr'
*     callback : {Function} [optional] — render function called per row for this column
*   }
*
* Column layout:
*   1. `section_id`  — the open-record / drag-handle cell (always first; rendered by
*      `render_column_id`).
*   2. `...base_columns_map` — zero or more data-component columns supplied by the
*      ontology/request-config (e.g. the component columns the cataloguer chose to display
*      inside the portal rows).
*   3. `ddinfo`      — optional component-info overlay column; included when
*      `self.add_component_info === true` (toggled by a developer tool for debugging).
*   4. `remove` / `empty` — the last column is the unlink/delete button when the portal
*      is editable (`permissions > 1` and `source.mode !== 'external'`).  For read-only or
*      external portals an empty placeholder column keeps the grid balanced.
*
* Once built, the result is memoised by setting `self.fixed_columns_map = true` so that
* subsequent `render_level='content'` refreshes skip this method entirely and reuse the
* cached `self.columns_map` value.
*
* @param {Object} self - The `component_portal` instance.
* @returns {Promise<Array>} The assembled columns_map array.
*/
const rebuild_columns_map = async function(self) {

	// columns_map already rebuilt case
	// Memoisation guard: once fixed_columns_map is set, the array on self is authoritative.
		if (self.fixed_columns_map===true) {
			return self.columns_map
		}

	const columns_map = []

	// column section_id check
		columns_map.push({
			id			: 'section_id',
			label		: 'Id',
			width		: 'auto',
			callback	: render_column_id
		})

	// base_columns_map
	// Merge the columns supplied by the ontology/request-config (may be an empty array
	// for portals that only show the ID + action columns).
		const base_columns_map = self.columns_map || []
		columns_map.push(...base_columns_map)

	// column component_info check
	// ddinfo is a developer/debug column that shows raw component-info strings per row.
	// It is enabled by setting self.add_component_info=true from the inspector or a tool.
		if (self.add_component_info===true) {
			columns_map.push({
				id			: 'ddinfo',
				label		: 'Info',
				callback	: render_column_component_info
			})
		}

	// button_remove
	// External portals (source.mode==='external') are read-only by convention even when
	// the user has edit permissions, so no remove column is shown.  Read-only permissions
	// (<= 1) also suppress the button.  In both cases an empty spacer column is added to
	// keep the grid-template-columns track count consistent with the header row.
		if (self.context?.properties?.source?.mode!=='external' && self.permissions>1) {
			columns_map.push({
				id			: 'remove',
				label		: '', // get_label.delete || 'Delete',
				width		: 'auto',
				callback	: render_column_remove
			})
		}else{
			columns_map.push({
				id		: 'empty',
				label	: '',
				width	: 'auto'
			})
		}

	// fixed as calculated
	// Mark the map as stable so refresh cycles skip rebuild_columns_map.
		self.fixed_columns_map = true


	return columns_map
}//end rebuild_columns_map



// @license-end
