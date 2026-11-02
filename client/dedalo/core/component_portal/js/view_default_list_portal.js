// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/* global get_label, Promise, SHOW_DEBUG, DEDALO_CORE_URL */
/*eslint no-undef: "error"*/



// imports
	import {window_section_rows} from '../../section/js/section.js'
	import {place_list_after} from '../../common/js/common.js'
	import {apply_table_semantics} from '../../section_record/js/record_window.js'
	import {ui} from '../../common/js/ui.js'
	import {render_list_after} from './render_edit_component_portal.js'
	import {set_element_css} from '../../page/js/css.js'



/**
* VIEW_DEFAULT_LIST_PORTAL
* Default list-mode view renderer for `component_portal`.
*
* Handles the common grid layout: iterates the portal's linked entries, renders
* each as a `section_record` child instance, and inserts the resulting nodes into
* a CSS-grid list body.  This view is the fallback for both 'default' and 'mosaic'
* portal views (see `render_list_component_portal.js`).
*
* The CSS grid column widths are computed on-the-fly from `self.columns_map` via
* `ui.flat_column_items()` and injected as a scoped stylesheet rule via
* `set_element_css()`.  The mosaic view is exempted because it does not use the
* column-based grid layout.
*
* Exported static methods:
*   view_default_list_portal.render(self, options) — entry point called by `list()`.
*
* Private helpers (module-scoped, not exported):
*   get_content_data(self, rows, children_view) — builds the content_data container.
*/
export const view_default_list_portal = function() {

	return true
}//end view_default_list_portal



/**
* RENDER
* Entry point for the default list view of a portal component.
*
* Orchestrates the full render pipeline:
*   1. Resolves the child view name from context (falls back to 'default').
*   2. Hands the locators in `self.data.entries` to `get_content_data()`, whose
*      row window (section.js window_section_rows) builds and renders a
*      `section_record` only for the rows the viewport reaches.
*   4. Builds the list_body grid container and injects per-section CSS grid
*      column widths using `set_element_css()`.
*   5. Wraps everything in a standard list wrapper with an absorbing click
*      listener (prevents click propagation to the parent section).
*
* When `options.render_level === 'content'`, steps 4–5 are skipped and the
* raw content_data element is returned directly.  This path is used by the
* portal's refresh mechanism to replace only the inner record area without
* rebuilding the full outer shell.
*
* Side effects:
*   - Materialized `section_record` instances are pushed into `self.ar_instances`
*     by the row window so that `common.destroy()` can tear them down on unmount.
*   - Calls `set_element_css()` (async, not awaited here) to inject a scoped
*     CSS rule for `grid-template-columns` on the `.list_body` cell.
*     The key is scoped to `<section_tipo>_<tipo>.list.view_<view_name>` to
*     avoid collisions between different portals on the same page.
*
* @param {Object} self    - The `component_portal` instance being rendered.
* @param {Object} options - Render options forwarded from `list()`.
* @param {string} [options.render_level='full'] - 'full' returns the complete
*   wrapper element; 'content' returns only the inner content_data node.
* @returns {Promise<HTMLElement>} The wrapper (full) or content_data (content) node.
*/
view_default_list_portal.render = async function(self, options) {

	// options
		const render_level = options.render_level || 'full'

	// view
		const children_view	= self.context.children_view || self.context.view || 'default'

	// rows. The page's locator entries; instances are built by the row window
		const rows = self.data?.entries || []
		self.ar_instances = self.ar_instances || []

	// content_data
		const content_data = await get_content_data(self, rows, children_view)
		if (render_level==='content') {
			return content_data
		}

	// columns_map
		const columns_map = self.columns_map || []

	// fragment container
		const fragment = new DocumentFragment()

	// list_body
		const view_name = self.view || self.context.view || 'default'
		const list_body = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'list_body ' + self.mode +  ' view_' + view_name,
			parent			: fragment
		})
		// flat columns create a sequence of grid widths taking care of sub-column space
		// like 1fr 1fr 1fr 3fr 1fr
		const items				= ui.flat_column_items(columns_map)
		const template_columns	= `${items.join(' ')}`
		// set CSS on-the fly js
			if (self.view!=='mosaic') {
				const css_object = {
					'.list_body' : {
						'grid-template-columns': template_columns
					}
				}
				set_element_css(
					`${self.section_tipo}_${self.tipo}.list.view_${view_name}`, // selector
					css_object
				)
			}

	// content_data append
		list_body.appendChild(content_data)

	// table semantics. A list whose rows render cells is a header-less table
	// (the window drops role=table again while it holds no row); mosaic and text
	// rows (inline values, no cells) are a list layout
		if (rows_layout(self, children_view)==='table') {
			list_body.classList.add('layout_table')
			apply_table_semantics(list_body, null)
		}

	// wrapper
		const wrapper = ui.component.build_wrapper_list(self, {
			autoload : true // bool set build autoload param on mode change (close button)
		})
		wrapper.classList.add('portal')
		wrapper.appendChild(fragment)
		// set pointers
		wrapper.content_data	= content_data
		wrapper.list_body		= list_body
		// list_after. The non-row sibling, right after list_body (never inside role=table)
		place_list_after(wrapper, content_data)
		// click event capture
		wrapper.addEventListener('click', function(e) {
			e.stopPropagation()
			// nothing to do in list mode, only catch click event
		})


	return wrapper
}//end render



/**
* ROWS_LAYOUT
* The row window layout of this view (record_window roles): 'table' when every
* row renders `.column` cells, 'list' for the mosaic tiles and for text rows
* (view_text_section_record joins the values inline: a row with no cell is no
* table row).
* @param {Object} self - The `component_portal` instance being rendered.
* @param {string} children_view - The view each row is rendered with.
* @returns {string} 'table' | 'list'
*/
const rows_layout = function(self, children_view) {

	return (self.view==='mosaic' || children_view==='text') ? 'list' : 'table'
}//end rows_layout



/**
* GET_CONTENT_DATA
* Builds the (empty) `content_data` container and hands the page's rows to the ROW
* DOOR (section.js window_section_rows → section_record/js/record_window.js) on
* EVERY content render, N=0 included (WC-2026-10-30-section-record-row-box). The
* window keeps the row invariant and builds at most ROW_WINDOW_MAX_ROWS rows at
* once (audit P2-31 / CLI-29: "show all" is the server ceiling, up to 1000 rows).
* The fill is done before this resolves. List mode has no drag source.
*
* @param {Object} self          - The `component_portal` instance being rendered.
* @param {Array}  rows          - The page's locator entries (`self.data.entries`).
* @param {string} children_view - The view each row is rendered with.
* @returns {Promise<HTMLElement>} The populated `content_data` div element.
*/
const get_content_data = async function(self, rows, children_view) {

	// content_data
	const content_data = ui.component.build_content_data(self)
		  content_data.classList.add(self.mode, self.tipo)

	// rows. The door, always (N=0 included)
	const record_window = await window_section_rows({
		caller			: self,
		container		: content_data,
		rows			: rows || [],
		records_options	: {
			view : children_view
		},
		layout			: rows_layout(self, children_view)
	})

	// list_after. Only the print notice can apply here
	content_data.list_after = render_list_after(self, {
		content_data	: content_data,
		record_window	: record_window,
		references		: false
	})


	return content_data
}//end get_content_data



// @license-end
