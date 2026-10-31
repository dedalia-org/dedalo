// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/* global get_label, page_globals, SHOW_DEBUG, DEDALO_CORE_URL,Promise */
/*eslint no-undef: "error"*/



/**
* VIEW_CONTENT_EDIT_PORTAL
*
* Edit-mode "content" view for `component_portal`.  This view renders each linked
* target record as a full embedded section_record node (as opposed to the compact
* table-row layout produced by `view_default_edit_portal` or the thumbnail grid of
* `view_mosaic_edit_portal`).  It is registered in `component_portal`'s `render_views`
* array with `{ view: 'content', mode: 'edit', render: 'view_content_edit_portal' }`
* and dispatched from `render_edit_component_portal.prototype.edit` when
* `self.context.view === 'content'`.
*
* Main exports:
*   `view_content_edit_portal`         — stub constructor (no instances created).
*   `view_content_edit_portal.render`  — async static render entry-point called by
*                                        `render_edit_component_portal`.
*
* Render levels:
*   `'full'`    — Rebuilds the entire wrapper DOM, including the column-header row,
*                 the `list_body` grid container, the CSS grid rule, and the
*                 autocomplete activation events.  Used on first render and after
*                 a full refresh.
*   `'content'` — Re-renders only the `content_data` child (the list of embedded
*                 records) inside the existing wrapper, toggling the
*                 `header_wrapper_list` visibility.  Used by
*                 `component_portal.prototype.refresh` to update the record list
*                 without tearing down the outer shell (e.g. after pagination, tag
*                 filter, or autocomplete selection).
*
* CSS grid layout:
*   Column widths are derived from `self.columns_map` via `ui.flat_column_items`
*   and injected as a scoped `grid-template-columns` rule through `set_element_css`.
*   The CSS selector is keyed on `<section_tipo>_<tipo>.edit.view_<view>` so that
*   multiple portals on the same page do not share a single rule.
*
* Key data shapes consumed from `self` (the `component_portal` instance):
*   `self.columns_map`     — `Array<ColumnDDO>` describing visible columns and their
*                            widths.  May be empty for portals with no explicit layout.
*   `self.fixed_columns_map` — `boolean|null` flag preventing `rebuild_columns_map`
*                              from running more than once per portal lifecycle.
*   `self.data.references` — `Array<Reference>` of back-reference locators; rendered
*                            as a read-only reference list below the record rows.
*   `self.ar_instances`    — `Array` accumulator; the row window pushes the MATERIALIZED
*                            section_record instances here so that `destroy()` can clean them up.
*   `self.node.list_body`  — Pointer to the live `list_body` DOM element, set on first
*                            full render; used by the `'content'` level to toggle the
*                            `header_wrapper_list` visibility without a DOM query from
*                            the root.
*
* @module view_content_edit_portal
* @see render_edit_component_portal.js  for the view-dispatch switch.
* @see component_portal.js              for the constructor and `render_views` registration.
* @see view_default_edit_portal.js      for the canonical table-layout implementation
*                                       (closest structural parallel).
* @see docs/core/components/component_portal.md for the full specification.
*/



// imports
	import {window_section_rows} from '../../section/js/section.js'
	import {place_list_after} from '../../common/js/common.js'
	import {apply_table_semantics} from '../../section_record/js/record_window.js'
	import {ui} from '../../common/js/ui.js'
	import {set_element_css} from '../../page/js/css.js'
	import {
		add_wrapper_events,
		build_header,
		render_list_after
	} from './render_edit_component_portal.js'



/**
* VIEW_CONTENT_EDIT_PORTAL
* Stub constructor for the content-view render module.
*
* Never instantiated directly.  The module follows the same pattern as all other
* portal view modules: the constructor is a no-op and the real logic lives on
* the static method `view_content_edit_portal.render`.  Exporting the function
* (rather than a plain object) allows consistent duck-typing checks elsewhere in
* the codebase.
*
* @returns {boolean} Always true.
*/
export const view_content_edit_portal = function() {

	return true
}//end view_content_edit_portal



/**
* RENDER
* Entry point for the 'content' view of `component_portal` in edit mode.
*
* Orchestrates the two-phase render pattern used by all portal view modules:
*
*   Phase 1 — `render_level === 'full'` (default):
*     Builds the complete wrapper DOM tree: resolves the columns_map, fetches
*     section_record instances for the current page of locators, constructs the
*     `list_body` grid container (with an injected CSS grid rule), and wires up
*     the autocomplete click-activation handler.  Returns the finished wrapper.
*
*   Phase 2 — `render_level === 'content'`:
*     Only refreshes the `content_data` child inside an already-existing wrapper.
*     Toggles `header_wrapper_list` visibility depending on whether any records
*     are present, then returns the new `content_data` node so the caller can
*     swap it in-place.  Used by pagination, tag-filter, and record-link flows.
*
* Side effects:
*   - The row door (window_section_rows) pushes the built section_record instances
*     into `self.ar_instances` so the portal's `destroy()` can clean them up.
*   - Sets `self.columns_map` to the (possibly cached) resolved column map.
*   - Injects a scoped CSS `grid-template-columns` rule via `set_element_css`.
*   - Sets `wrapper.list_body` and `wrapper.content_data` pointers for subsequent
*     `'content'`-level renders to access the live DOM without a root-relative query.
*
* @param {Object} self - The `component_portal` instance.
* @param {Object} options - Render options forwarded from the edit dispatcher.
* @param {string} [options.render_level='full'] - `'full'` rebuilds the entire
*   wrapper; `'content'` refreshes only the record list inside the existing wrapper.
* @returns {Promise<HTMLElement>} The outer wrapper element (full render) or the
*   newly built `content_data` element (content-only render).
*/
view_content_edit_portal.render = async function(self, options) {

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
				if (rows.length>0) {
					// self.node.querySelector(":scope >.list_body>.header_wrapper_list").classList.remove('hide')
					self.node.list_body.querySelector(":scope >.header_wrapper_list").classList.remove('hide')
				}else{
					self.node.list_body.querySelector(":scope >.header_wrapper_list").classList.add('hide')
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

			const css_object = {
				".list_body" : {
					"grid-template-columns" : template_columns
				}
			}
			// Scope the CSS rule to this specific portal instance by keying it on
			// <section_tipo>_<tipo>.edit.view_<view>, preventing rule collisions when
			// multiple portals with the same tipo appear on the same page.
			const selector = `${self.section_tipo}_${self.tipo}.edit.view_${self.view}`
			set_element_css(selector, css_object)

		list_body.appendChild(list_header_node)
		list_body.appendChild(content_data)

	// table semantics (static half; the window owns rowgroup / rows / cells)
		list_body.classList.add('layout_table')
		apply_table_semantics(list_body, list_header_node)

	// wrapper. ui build_edit returns component wrapper
		const wrapper = ui.component.build_wrapper_edit(self, {
			list_body	: list_body,
			label		: null
		})
		wrapper.classList.add('portal', 'view_' + (self.view || self.context.view || 'default'))

	// set pointers
		wrapper.list_body		= list_body
		wrapper.content_data	= content_data

	// list_after. The non-row sibling, right after list_body (never inside role=table)
		place_list_after(wrapper, content_data)

	// service autocomplete + the wrapper MOVE zone
		add_wrapper_events(self, wrapper)


	return wrapper
}//end render



/**
* GET_CONTENT_DATA
* Build the (empty) `content_data` container and hand the page's rows to the ROW
* DOOR (section.js window_section_rows → section_record/js/record_window.js) on
* EVERY content render, N=0 included. The window keeps the row invariant (exactly
* one `.section_record` per entry, in index order) and builds at most
* ROW_WINDOW_MAX_ROWS rows at once (audit P2-31 / CLI-29). The fill is done before
* this resolves. The content view has no drag source.
*
* The server's back-references (`self.data.references`) and the print notice go
* to the `.list_after` slot (expando `content_data.list_after`), never into
* content_data (WC-2026-10-30-section-record-row-box).
*
* @param {Object} self - The `component_portal` instance.
* @param {Array} rows - The page's locator entries (`self.data.entries`).
* @returns {Promise<HTMLElement>} The populated `content_data` div, ready to be
*   inserted into the `list_body` container.
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

	// list_after. References + print notice (never inside content_data)
		content_data.list_after = render_list_after(self, {
			content_data	: content_data,
			record_window	: record_window
		})


	return content_data
}//end get_content_data



/**
* REBUILD_COLUMNS_MAP
* Return the resolved columns_map for this portal, building it at most once per
* portal lifecycle.
*
* The `content` view does not add any control columns (id button, drag handle, remove
* button) on top of the base map — unlike `view_default_edit_portal` which injects
* those extra DDO entries here.  The method exists for parity with other view modules
* and to support future extension without changing the call signature.
*
* Early-exit guard: if `self.fixed_columns_map === true` the method returns
* `self.columns_map` immediately, skipping the rebuild.  The flag is set to `true` at
* the end of the first successful call so that subsequent `'content'`-level renders
* reuse the already-computed map without re-running the logic.
*
* @param {Object} self - The `component_portal` instance.
* @param {boolean|null} self.fixed_columns_map - Guards against running more than once.
*   `null` = not yet run; `true` = already computed (skip).
* @param {Array} self.columns_map - The base columns_map, populated during
*   `component_portal.prototype.build` from the ontology / request config.
* @returns {Promise<Array>} The (possibly identical) columns_map array, ready to be
*   assigned back to `self.columns_map`.
*/
const rebuild_columns_map = async function(self) {

	// columns_map already rebuilt case
		if (self.fixed_columns_map===true) {
			return self.columns_map
		}

	const columns_map = []

	// base_columns_map
		const base_columns_map = self.columns_map || []
		columns_map.push(...base_columns_map)

	// fixed as calculated
		self.fixed_columns_map = true


	return columns_map
}//end rebuild_columns_map



// @license-end
