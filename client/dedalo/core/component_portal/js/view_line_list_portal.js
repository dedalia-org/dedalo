// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global Promise */
/*eslint no-undef: "error"*/



/**
* VIEW_LINE_LIST_PORTAL
*
* List-mode, line-view renderer for `component_portal`.
*
* This module is invoked by `render_list_component_portal.list()` when
* `self.context.view === 'line'` (and the caller's model is not
* `component_dataframe`).  It renders the linked target records as a
* horizontal row list rather than the default table grid, making it
* suitable for compact embeds inside parent sections.
*
* Architecture:
*   The module exports a single constructor stub (`view_line_list_portal`)
*   whose static methods act as a namespace:
*
*   - `view_line_list_portal.render(self, options)` — public entry point;
*     called by the list render dispatcher in `render_list_component_portal`.
*   - `get_content_data(self, rows, children_view)` — module-private; hands the
*     page's locator entries to the row door (section.js window_section_rows) inside
*     the content area; references go to the `.list_after` slot.
*   - `rebuild_columns_map(self)` — module-private; augments `self.columns_map`
*     with callbacks required for special columns (e.g. `ddinfo`), then marks
*     the map as fixed so successive calls are cheap no-ops.
*
* Key data shapes consumed from the component instance (`self`):
*   - `self.context.view`           — active view name (expected: 'line').
*   - `self.context.children_view`  — optional override for the child section
*                                     records' own view; falls back to `context.view`.
*   - `self.columns_map`            — `Array<Object>` column descriptors built by
*                                     `common.js::get_columns_map()`.  Each entry has
*                                     at minimum `{ id, label, width? }`.
*   - `self.fixed_columns_map`      — `boolean` flag; when true the columns_map has
*                                     already been augmented and can be returned as-is.
*   - `self.add_component_info`     — `boolean`; when true the 'ddinfo' column
*                                     receives its render callback.
*   - `self.ar_instances`           — `Array` accumulator for sub-instances; push
*                                     here so `common.destroy()` can clean them up.
*   - `self.data.references`        — optional `Array` of back-reference locators
*                                     appended below the record list.
*   - `self.show_interface.read_only` — `boolean`; suppresses the dblclick
*                                     mode-change handler when true.
*   - `self.permissions`            — `number`; `> 1` means the user has write access.
*   - `self.context.properties.with_value` — optional `{ mode, view }` descriptor
*                                     that overrides the default 'edit' / 'line'
*                                     targets for the dblclick mode change.
*
* Differences from `view_line_edit_portal`:
*   - Wrapper is built with `build_wrapper_list` (not `build_wrapper_edit`), which
*     enables the auto-load rebuild when the user returns from edit mode via the
*     close button.
*   - No toolbar buttons are rendered (list mode is read-display only).
*   - Rows are built (row door) without an explicit `mode` override, so child
*     section records inherit the caller's mode rather than being forced to 'list'.
*
* @module view_line_list_portal
* @see render_list_component_portal.js  for the dispatcher that calls this module.
* @see view_line_edit_portal.js         for the edit-mode equivalent.
* @see render_edit_component_portal.js  for shared helpers (render_references, render_column_component_info).
* @see docs/core/components/component_portal.md for the full portal specification.
*/



// imports
	import {window_section_rows} from '../../section/js/section.js'
	import {place_list_after} from '../../common/js/common.js'
	import {ui} from '../../common/js/ui.js'
	import {render_list_after, render_column_component_info} from './render_edit_component_portal.js'



/**
* VIEW_LINE_LIST_PORTAL
* Constructor stub that acts as a namespace for the line-view list renderer.
*
* This function is never instantiated.  Its static method `render` is the sole
* public API surface; the module-private helpers `get_content_data` and
* `rebuild_columns_map` are defined as `const` in module scope.
*
* Returning `true` is the conventional no-op pattern used throughout Dédalo
* view modules for constructor stubs.
*/
export const view_line_list_portal = function() {

	return true
}//end view_line_list_portal



/**
* RENDER
* Entry point for the line-view list render of a portal component.
*
* Orchestrates three sequential stages:
*   1. Build the column map (idempotent after first call — see `rebuild_columns_map`).
*   2. Hand the page's locator entries to `get_content_data`, whose row door
*      (section.js window_section_rows) builds and renders the rows.
*   3. When `render_level !== 'content'`, wrap the content area in a list-mode
*      component wrapper and attach a dblclick handler that switches the portal to
*      edit mode if the user has write permissions.
*
* The `render_level === 'content'` short-circuit is used by `self.refresh()` to
* rebuild only the inner record list without tearing down and re-creating the outer
* wrapper node (avoids layout flicker during in-place refreshes).
*
* Wrapper note: `build_wrapper_list` is deliberately used instead of
* `build_wrapper_edit` because it sets the `autoload` flag that triggers a rebuild
* when the user closes edit mode via the close button.  This keeps the list view
* consistent even after the child records have been modified.
*
* @param {Object} self    - The `component_portal` instance (acts as `this` context).
* @param {Object} options - Render options forwarded from the dispatcher.
* @param {string} [options.render_level='full'] - `'full'` builds the complete
*   wrapper; `'content'` rebuilds only the record-list content area (used for
*   in-place refreshes).
* @returns {Promise<HTMLElement>} Resolves to the wrapper element (render_level 'full')
*   or the content_data element (render_level 'content').
*/
view_line_list_portal.render = async function(self, options) {

	// options
		const render_level = options.render_level || 'full'

	// view
		// children_view: the view used by child section_record instances; defaults
		// to the portal's own context view when no explicit override is set.
		const children_view	= self.context.children_view || self.context.view || 'default'

		// columns_map
		// Augment columns_map with special-column callbacks before fetching records
		// so that section_record instances receive the fully configured map.
		self.columns_map = await rebuild_columns_map(self)

	// rows. The page's locator entries; instances are built by the row door
		const rows = self.data?.entries || []
		self.ar_instances = self.ar_instances || []

	// content_data
		const content_data = await get_content_data(self, rows, children_view)
		// Short-circuit for in-place refresh: return only the inner content node
		// so the caller can swap it into the existing wrapper without a full rebuild.
		if (render_level==='content') {
			return content_data
		}

	// wrapper. ui build_edit returns component wrapper.
	// Note: Use 'build_wrapper_list' instead 'build_wrapper_edit' because allow user to change mode on dblclick
		const wrapper = ui.component.build_wrapper_list(self, {
			autoload : true // bool set autoload when change mode is called (close button)
		})
		wrapper.classList.add('portal', 'view_line')
		wrapper.appendChild(content_data)
		// set pointers
		wrapper.content_data = content_data
		// list_after. The non-row sibling, right after content_data
		place_list_after(wrapper, content_data)

	// change_mode
		// Only attach the dblclick handler when the portal is not in strict read-only
		// mode and the current user holds write permissions (> 1).
		if (self.show_interface.read_only !== true && self.permissions > 1) {
			wrapper.addEventListener('dblclick', function(e) {
				e.stopPropagation()

				// self.show_interface.read_only = true
				// Resolve target mode: use the with_value override when it differs
				// from the current mode, otherwise fall back to 'edit'.
				const change_mode = self.context?.properties?.with_value
					&& self.context.properties.with_value.mode !== self.mode
						? self.context.properties.with_value.mode
						: 'edit'

				// Resolve target view: use the with_value override when it differs
				// from the current context view, otherwise fall back to 'line'.
				const change_view = self.context?.properties?.with_value
					&& self.context.properties.with_value.view !== self.context.view
						? self.context.properties.with_value.view
						: 'line'

				self.change_mode({
					mode	: change_mode,
					view	: change_view
				})
			})
		}


	return wrapper
}//end render



/**
* GET_CONTENT_DATA
* Build the content area and hand the page's locator entries to the ROW DOOR
* (section.js window_section_rows → section_record/js/record_window.js) on EVERY
* content render, N=0 included (WC-2026-10-30-section-record-row-box). The window
* keeps the row invariant (exactly one `.section_record` per entry, in index order)
* and builds at most ROW_WINDOW_MAX_ROWS rows at once (audit P2-31 / CLI-29); the
* fill is done before this resolves. List mode has no drag source.
*
* Back-references (`self.data.references`, component_relation_related portals) and
* the print notice go to the `.list_after` slot (expando `content_data.list_after`),
* never into content_data.
*
* The `autoload: true` option passed to `build_content_data` ensures that a refresh
* triggered externally (e.g. by a paginator page change) re-enters `render()`
* instead of serving a stale node.
*
* @param {Object} self          - The `component_portal` instance.
* @param {Array}  rows          - The page's locator entries (`self.data.entries`).
* @param {string} children_view - The view each row is rendered with.
* @returns {Promise<HTMLElement>} Resolves to the populated `content_data` container element.
*/
const get_content_data = async function(self, rows, children_view) {

	// content_data
	const content_data = ui.component.build_content_data(self, {
		autoload : true
	})

	// rows. The door, always (N=0 included)
	const record_window = await window_section_rows({
		caller			: self,
		container		: content_data,
		rows			: rows,
		records_options	: {
			view : children_view
		},
		layout			: 'list'
	})

	// list_after. References + print notice (never inside content_data)
	content_data.list_after = render_list_after(self, {
		content_data	: content_data,
		record_window	: record_window
	})


	return content_data
}//end get_content_data



/**
* REBUILD_COLUMNS_MAP
* Augment `self.columns_map` with render callbacks for special columns, then
* mark the map as fixed so subsequent calls are instant no-ops.
*
* The function is idempotent: when `self.fixed_columns_map === true` the already-
* augmented map is returned immediately without any further processing.  This is
* important because `render()` calls this function on every full render cycle, but
* the column map should only be built once per portal instance lifecycle.
*
* Currently the only special column handled here is `ddinfo` (component_info):
*   - The `ddinfo` column descriptor is created by `common.js::get_columns_map()` when
*     `self.add_component_info === true` (set during init from the ontology/request config).
*   - `get_columns_map()` adds the descriptor but leaves `callback` undefined because it
*     cannot import view-specific helpers without creating circular dependencies.
*   - This function resolves the callback by assigning `render_column_component_info`
*     (imported from `render_edit_component_portal.js`) to the `ddinfo` entry in place.
*
* Note: the mutation is performed on `base_columns_map` directly (the same array
* reference as `self.columns_map`) before spreading into `columns_map`.  This means
* the callback is also visible on the original `self.columns_map` array, which is the
* intended behaviour for consistency.
*
* @param {Object} self - The `component_portal` instance.
* @returns {Promise<Array>} Resolves to the augmented columns_map array.
*/
const rebuild_columns_map = async function(self) {

	// columns_map already rebuilt case
	// (!) Early return to avoid re-running augmentation on every refresh cycle.
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
	// Note: 'compnent_info' is the original spelling in the comment above — do not alter.
		if (self.add_component_info===true) {
			base_columns_map.forEach(el => {
				if(el.id==='ddinfo'){
					// Inject the view-specific render callback; the column skeleton already
					// exists from get_columns_map() but its callback is unset at that point.
					el.callback	= render_column_component_info
				}
			})
		}
		columns_map.push(...base_columns_map)


	// fixed as calculated
	// Mark the map as done so future calls hit the early-return guard above.
		self.fixed_columns_map = true


	return columns_map
}//end rebuild_columns_map



// @license-end
