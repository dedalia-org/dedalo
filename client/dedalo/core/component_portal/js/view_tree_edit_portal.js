// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_label, Promise, SHOW_DEBUG, DEDALO_CORE_URL*/
/*eslint no-undef: "error"*/



/**
* VIEW_TREE_EDIT_PORTAL
* Tree-style edit-mode view for `component_portal`.
*
* This module implements the `'tree'` render path dispatched by
* `render_edit_component_portal.prototype.edit` when `self.context.view` is `'tree'`.
* It is suited for portals whose linked records form or belong to a hierarchical structure
* (e.g. thesaurus term portals in area_thesaurus), where the implicit ordering of linked
* items matters and the delete column is the only structural control column needed.
*
* Differences from the default view:
* - Rows share the LINE view's design (`context.children_view` section_records + the line view's
*   `section_id` and `remove` columns), so tree portals and children/parent portals
*   read the same. Only the toolbar differs.
* - The toolbar leaves only `button_tree` active (the tree picker is the canonical way to
*   attach new terms in this view). It is DECLARED on the view's registration entry in
*   `component_portal.js` and composed once by `component_portal.prototype.build`; this
*   module writes no `show_interface` flag, so there is exactly one writer per view.
* - The rows are windowed (`window_section_rows`) in `'list'` mode, view `context.children_view` (not `'tree'`)
*   so the child section records render as the line view's, not a further recursive tree render.
* - Like other portal views, a `render_level='content'` early return lets callers
*   refresh only the record list without rebuilding the full wrapper.
*
* Exports:
*   `view_tree_edit_portal` — namespace constructor (never instantiated directly).
*   `view_tree_edit_portal.render` — async static entry point called by the dispatch layer.
*   `add_events` — re-exported thin wrapper around `add_wrapper_events`.
*
* @module view_tree_edit_portal
* @see render_edit_component_portal.js  for view-dispatch switch and all shared helpers.
* @see component_portal.js             for the constructor, data shape, and lifecycle.
* @see docs/core/components/component_portal.md for the full specification.
*/



// imports
	import {ui} from '../../common/js/ui.js'
	import {window_section_rows} from '../../section/js/section.js'
	import {
		add_wrapper_events,
		get_buttons
	} from './render_edit_component_portal.js'
	import {view_line_edit_portal} from './view_line_edit_portal.js'



/**
* VIEW_TREE_EDIT_PORTAL
* Namespace constructor for the tree edit-mode portal view.
*
* Never instantiated — only the static `render` method is invoked by the dispatch layer in
* `render_edit_component_portal.prototype.edit`. Defined as a function to follow the
* Dédalo view-module pattern used by all sibling view modules.
*
* @returns {boolean} Always true.
*/
export const view_tree_edit_portal = function() {

	return true
}//end view_tree_edit_portal




/**
* RENDER
* Build (or partially refresh) the tree edit view for a portal instance.
*
* Two execution paths are controlled by `options.render_level`:
*
* - `'full'` (default): constructs the full wrapper with toolbar and section records.
*   The `show_interface` flags are NOT written here — they are declared
*   on the view registration and composed by `component_portal.prototype.build`.
*
* - `'content'` (partial refresh): returns `content_data` directly without rebuilding
*   the outer wrapper.  The existing wrapper retains its events and CSS.  Callers use this
*   after pagination or filter changes.
*
* Side effects:
*   - Populates `self.columns_map` with the rebuilt column descriptor array (once per
*     render; subsequent calls return immediately via `self.fixed_columns_map`).
*   - Pushes all section_record instances onto `self.ar_instances` for lifecycle cleanup.
*
* @param {Object} self - The `component_portal` instance.
* @param {Object} options - Render options.
* @param {string} [options.render_level='full'] - `'full'` rebuilds the full wrapper;
*   `'content'` refreshes only the record list inside an existing wrapper.
* @returns {Promise<HTMLElement>} The rendered wrapper node (full path), or the
*   content_data node (content path).
*/
view_tree_edit_portal.render = async function(self, options) {

	// options
		const render_level = options.render_level || 'full'

	// columns_map
		const columns_map = await rebuild_columns_map(self)
		self.columns_map = columns_map

	// rows. The page's locator entries; instances are built by the row window
		const rows = self.data?.entries || []
		self.ar_instances = self.ar_instances || []

	// content_data
		const content_data = await get_content_data(self, rows)
		if (render_level==='content') {
			return content_data
		}

	// buttons
		// (!) THE TOOLBAR IS NOT WRITTEN HERE. This view used to overwrite
		// button_tree/add/link/list/fullscreen at this point — AFTER
		// component_portal.prototype.build's tool-caller switch had already composed
		// show_interface — so which of the two won was last-writer-wins by accident.
		// The toolbar is DECLARED as data on the view's registration entry
		// (component_portal.js render_views, the {view:'tree', mode:'edit'} entry) and
		// build() composes it ONCE, with the tool-caller and source.mode constraints
		// still applying. One writer per view; a comment is not a gate, the declaration is.
		// (!) show_autocomplete is deliberately NOT part of that declaration: a picker
		// view ADDS an input path and removes none, so the autocomplete input a portal
		// declares (e.g. properties.source.mode 'autocomplete') survives. That was
		// incidental while this block existed; with the declared toolbar it is intentional.
		const buttons = (self.permissions > 1)
			? get_buttons(self)
			: null

	// wrapper. ui build_edit returns component wrapper
		const wrapper = ui.component.build_wrapper_edit(self, {
			content_data	: content_data,
			// label		: null,
			buttons			: buttons,
			add_styles		: ['portal','view_line'] // added to the wrapper before view style
		})
		// set pointers
		wrapper.content_data = content_data

	// (!) NO THESAURUS PANE IS BUILT HERE, and that is the whole point.
	// tool_indexation — the working reference — renders the area into its own
	// `left_container`, a SIBLING of the pane that holds the components. The
	// thesaurus is never a descendant of a component.
	// An earlier version of this view appended the pane INSIDE this wrapper, and
	// every conflict that followed came from that one decision: the area's drag
	// events bubbled into the portal's dragover, its space collided with the
	// autocomplete, its height drove the component's, and its stacking context was
	// the component's. The pane is therefore created OUTSIDE the component DOM
	// entirely — see component_portal.toggle_thesaurus_pane.

	// events
		add_events(self, wrapper)


	return wrapper
}//end render



/**
* ADD_EVENTS
* Delegates to shared add_wrapper_events
* @param {Object} self - The `component_portal` instance.
* @param {HTMLElement} wrapper - The portal's wrapper DOM node.
* @returns {boolean} The return value from `add_wrapper_events` (always true).
*/
export const add_events = function(self, wrapper) {

	return add_wrapper_events(self, wrapper)
}//end add_events



/**
* GET_CONTENT_DATA
* Build the `content_data` container and hand the page's rows to a ROW WINDOW
* (section.js window_section_rows → common/js/row_window.js): a `section_record`
* is built and rendered only for the rows the viewport can reach — at most
* ROW_WINDOW_MAX_ROWS at once — and released past the far edge (audit P2-31 /
* CLI-29: the picker's page is the portal's, and "show all" is the server
* ceiling). The first window is filled before this resolves.
*
* Empty list handling: when `rows` is empty the container stays blank.
*
* The `button_close: null` option passed to `build_content_data` suppresses the
* close-button that some other views add to the content area header.
*
* @param {Object} self - The `component_portal` instance (forwarded for `build_content_data`).
* @param {Array} rows - The page's locator entries (`self.data.entries`).
* @returns {Promise<HTMLElement>} The populated content_data div node.
*/
const get_content_data = async function(self, rows) {

	// content_data
		const content_data = ui.component.build_content_data(self,{button_close: null})

	// row window
		if (rows.length > 0) {
			await window_section_rows({
				caller			: self,
				container		: content_data,
				rows			: rows,
				// rows share the line view's design (children/parent portals): the
				// server's children_view ('text' for the relation family), never 'tree'
				records_options	: {
					mode : 'list',
					view : self.context.children_view || 'text'
				}
			})
		}


	return content_data
}//end get_content_data



/**
* REBUILD_COLUMNS_MAP
* Assemble the column descriptor array used by section_record row renderers.
*
* Same columns as the line view: a `section_id` column (edit + ontology tree buttons),
* the base `self.columns_map` (provided by the server via the ontology / request config)
* and a `remove` column appended when the user has write permission (permissions > 1).
* Both control columns reuse the `view_line_edit_portal` callbacks.
*
* The `self.fixed_columns_map` guard prevents the map from being rebuilt on partial
* refreshes (`render_level='content'`).  Once the flag is set to `true` the function
* returns the already-built map immediately.
*
* @param {Object} self - The `component_portal` instance.
* @returns {Promise<Array>} The assembled columns_map array. Each entry is an object
*   with at minimum `{ id, label, width, callback }`.
*/
const rebuild_columns_map = async function(self) {

	// columns_map already rebuilt case
		if (self.fixed_columns_map===true) {
			return self.columns_map
		}

	const columns_map = []

	// column section_id (edit + ontology tree buttons), as the line view
		columns_map.push({
			id			: 'section_id',
			label		: 'Id',
			width		: 'auto',
			callback	: view_line_edit_portal.render_column_id
		})

	// base_columns_map
		const base_columns_map = self.columns_map || []
		columns_map.push(...base_columns_map)

	// button_remove column
		if (self.permissions>1) {
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



// @license-end
