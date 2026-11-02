// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_label, Promise, SHOW_DEBUG */
/*eslint no-undef: "error"*/



// imports
	import {window_section_rows} from '../../section/js/section.js'
	import {event_manager} from '../../common/js/event_manager.js'
	import {
		clone,
		get_font_fit_size,
		object_to_url_vars,
		// open_window
	} from '../../common/js/utils/index.js'
	import {ui} from '../../common/js/ui.js'
	import {
		get_picker,
		render_term_pick_control,
		term_selectability
	} from '../../area_thesaurus/js/thesaurus_picker.js'
	import {set_element_css} from '../../page/js/css.js'
	import {place_list_after} from '../../common/js/common.js'
	import {apply_table_semantics} from '../../section_record/js/record_window.js'
	import {render_list_after} from './render_common_section.js'
	// // import {
	// 	render_column_id
	// } from './render_list_section.js'



/**
* VIEW_THESAURUS_LIST_SECTION
* List-view module for thesaurus sections (area_thesaurus context).
*
* This is the specialised counterpart of view_default_list_section for sections
* that display thesaurus terms. It differs from the generic list view in two
* main ways:
*
*   1. It injects its own render_column_id callback that offers the term-picking
*      affordance (built by the shared thesaurus_picker module) instead of the
*      standard edit/navigate buttons of the generic list. This is what makes a
*      SEARCH RESULT pickable — the primary way into a large thesaurus.
*
*   2. rebuild_columns_map is a module-private function (not a method on the
*      exported namespace), so callers cannot override it. This keeps the thesaurus
*      section_id column definition self-contained.
*
* Exported API:
*   view_thesaurus_list_section         — namespace constructor (always returns true)
*   view_thesaurus_list_section.render  — builds the full section DOM (async)
*
* Module-private helpers (not exported):
*   get_content_data    — hands the page's rows to the row window door
*   rebuild_columns_map — prepends the thesaurus section_id column to columns_map
*   get_buttons         — builds the toolbar (search toggle only)
*   render_column_id    — builds the id-column fragment for a single row;
*                         renders the picker's term control when a picker is attached
*
* DOM structure produced by render():
*   <section id="{self.id}" class="wrapper_section …">
*     [div.buttons_container]     — optional; only when self.buttons
*     [div.search_container]      — optional; only when self.filter
*     [div.paginator_container]   — optional; only when self.paginator
*     <div.list_body.layout_table role=table>      (WC-2026-10-30-section-record-row-box)
*       <div.header_wrapper_list role=row>…</div>   — column labels (N=0 included)
*       <div.content_data role=rowgroup>
*         <div.section_record data-index=i role=row>… — exactly N rows, nothing else
*       </div>
*     </div>
*     [div.list_after]                              — no_records / print notice
*   </section>
*
* @see view_default_list_section  — generic list view with richer toolbar
* @see render_list_section        — dispatcher that selects this module for
*                                   context.view === 'thesaurus_list'
* @see area_thesaurus             — the area that owns the thesaurus sections
*                                   rendered through this view
*/



/**
* VIEW_THESAURUS_LIST_SECTION
* Namespace constructor — never instantiated directly. All functionality lives
* on the static-style function properties (.render, etc.).
* @returns {boolean} Always returns true.
*/
export const view_thesaurus_list_section = function() {

	return true
}//end view_thesaurus_list_section



/**
* RENDER
* Builds the complete list DOM for a thesaurus section and returns its wrapper
* element. Supports two render levels:
*
*   'full' (default):
*     Builds the entire wrapper including optional buttons bar, search placeholder,
*     paginator slot, column header, and content rows. DOM pointers
*     (wrapper.content_data, wrapper.list_body, wrapper.list_header_node) are set
*     on the returned element so callers can reach sub-nodes without re-querying.
*
*   'content':
*     Rebuilds only the row area (content_data). Used by the pagination handler to
*     swap rows without tearing down the existing wrapper. Returns content_data
*     directly, NOT the wrapper (its `.list_after` is swapped by common.render).
*
* CSS grid layout:
*   ui.flat_column_items() flattens columns_map (including nested sub-columns) into
*   a list of CSS track-size strings, e.g. ['minmax(auto,6rem)', '1fr', '3fr'].
*   These are joined and written to the .list_body grid-template-columns rule via
*   set_element_css() with a scoped selector ({section_tipo}_{tipo}.list) so that
*   multiple sections on the same page do not clash. Any CSS rules defined in
*   self.context.css are merged on top of this computed grid definition.
*
* columns_map:
*   rebuild_columns_map() is always called first. It prepends the thesaurus
*   section_id column (with the link-term render_column_id callback) and appends
*   any existing self.columns_map entries. The result is stored back on
*   self.columns_map and self.fixed_columns_map is set to true so that subsequent
*   pagination renders skip the rebuild.
*
* ar_instances:
*   Holds only the BUILT rows — the row window (section.js
*   window_section_rows) builds section_record instances on demand and a
*   released row leaves the array through its own destroy.
*
* buttons / filter / paginator:
*   These optional sections are suppressed in 'tm' (Time Machine) mode. The search
*   container is a bare placeholder div; the section's search.js instance attaches
*   its own DOM to it when it initialises.
*
* @param {Object} self    - The section instance. Expected properties:
*   id, type, model, tipo, section_tipo, mode, view, context, columns_map,
*   ar_instances, buttons, filter, paginator, node (set on 'content' re-renders).
* @param {Object} options - Render options.
*   @param {string} [options.render_level='full'] - 'full' | 'content'
* @returns {Promise<HTMLElement>} The section wrapper <section> element on a full
*   render, or the content_data <div> element on a 'content' re-render.
*/
view_thesaurus_list_section.render = async function(self, options) {

	// options
		const render_level = options.render_level || 'full'

	// columns_map
		const columns_map	= await rebuild_columns_map(self)
		self.columns_map	= columns_map

	// rows. The page's locator entries; instances are built by the row window
	// (section.js window_section_rows) only for the rows the viewport reaches
		const rows = self.data?.entries || []
		self.ar_instances = self.ar_instances || []

	// content_data
		const content_data = await get_content_data(self, rows)
		if (render_level==='content') {
			// its `.list_after` travels as content_data.list_after (common.render swaps it)
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
				self.paginator.render()
				.then(paginator_wrapper =>{
					paginator_container.appendChild(paginator_wrapper)
				})
			})
		}

	// list body
		// `layout_table` marks the row box table (list.less): header, content_data
		// and every row share the list_body grid through subgrid
		// (WC-2026-10-30-section-record-row-box)
		const list_body = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'list_body layout_table',
			parent			: fragment
		})
		// fix last list_body (for pagination selection)
		self.node_body = list_body

		// list_body css
			const selector = `${self.section_tipo}_${self.tipo}.list`

		// custom properties defined css
			// flat columns create a sequence of grid widths taking care of sub-column space
			// like 1fr 1fr 1fr 3fr 1fr
			const items				= ui.flat_column_items(columns_map)
			const template_columns	= items.join(' ')


			const css_object = {
				'.list_body' : {
					'grid-template-columns' : template_columns
				}
			}
			if (self.context?.css) {
				// use defined section css
				for(const property in self.context.css) {
					css_object[property] = self.context.css[property]
				}
			}
			// use calculated css
			set_element_css(selector, css_object)

	// list_header_node. Always present, N=0 included: the table keeps its
	// header row when it has no rows (a role=table owning no row fails
	// aria-required-children; the window drops only the rowgroup role at N=0)
		const list_header_node = ui.render_list_header(columns_map, self)
		list_body.appendChild(list_header_node)

	// content_data append
		list_body.appendChild(content_data)

	// a11y. Static table semantics; the dynamic part (rowgroup, row roles,
	// aria-rowcount) belongs to the window
		apply_table_semantics(list_body, list_header_node)

	// wrapper
		const wrapper = ui.create_dom_element({
			element_type	: 'section',
			id				: self.id,
			class_name		: `wrapper_${self.type} ${self.model} ${self.section_tipo}_${self.tipo} ${self.tipo} ${self.mode} view_${self.view}`
		})
		wrapper.appendChild(fragment)
		// set pointers
		wrapper.content_data		= content_data
		wrapper.list_body			= list_body
		wrapper.list_header_node	= list_header_node

	// list_after. The non-row sibling, right after list_body
		place_list_after(wrapper, content_data)


	return wrapper
}//end render



/**
* GET_CONTENT_DATA
* Builds the scrollable row area for the thesaurus list view.
*
* Hands the page's rows to the row window door (section.js window_section_rows;
* at most ROW_WINDOW_MAX_ROWS built at once — audit P2-31 / CLI-29): content_data
* holds exactly the page's N `.section_record` rows in server order, N=0
* included, and the window is filled before this resolves. The "No records
* found" node and the print notice go to the expando `content_data.list_after`
* (render_list_after), never into content_data
* (WC-2026-10-30-section-record-row-box).
*
* The returned div carries CSS classes 'content_data', self.mode, and self.type
* so that layout rules can target mode/type combinations without relying on
* ancestor selectors.
*
* @param {Object} self              - The section instance. Used for .mode and
*                                     .type class names applied to content_data.
* @param {Array}  rows - The page's locator entries (`self.data.entries`).
* @returns {Promise<HTMLElement>} A div.content_data element containing all row
*   nodes in their original server order, with `.list_after` (node|null) attached.
*/
const get_content_data = async function(self, rows) {

	// content_data
		const content_data = document.createElement('div')
			  content_data.classList.add('content_data', self.mode, self.type)

	// rows. The row window (section.js window_section_rows) builds and renders
	// section_record rows on demand, at most ROW_WINDOW_MAX_ROWS at once. Called
	// at N=0 too: an N>0→N=0 transition retires the previous window. The CSS
	// ring of `.list_body.layout_table` is the row highlight
		const record_window = await window_section_rows({
			caller			: self,
			container		: content_data,
			rows			: rows || [],
			render_options	: {
				add_hilite_row : false
			},
			layout			: 'table'
		})

	// list_after. no_records / print notice (never inside content_data)
		content_data.list_after = render_list_after(self, {
			content_data	: content_data,
			record_window	: record_window
		})


	return content_data
}//end get_content_data



/**
* REBUILD_COLUMNS_MAP
* Prepends the thesaurus section_id control column to the section's columns_map.
*
* This function adds an 'Id' column as the first (leftmost) column in the grid.
* The column uses the module-private render_column_id as its callback, which
* provides the term-linking button instead of the generic edit/navigate button
* from render_list_section.render_column_id.
*
* The section_id column definition:
*   - id: 'section_id' — must match the string used by ui.render_list_header to
*     identify the sort target.
*   - tipo: 'section_id' — used by the search/sort layer as a direct column name
*     (section_id is a real DB column, not a JSONB component path).
*   - width: 'minmax(auto, 6rem)' — CSS grid track size; fixed to 6 rem so that
*     numeric IDs up to 5–6 digits fit without clipping.
*   - path: a single-entry array with component_tipo: 'section_id', used by
*     section_record to build the sort event payload.
*   - callback: render_column_id — the thesaurus-specific id-column renderer.
*
* Short-circuit: if self.fixed_columns_map === true the already-built map is
* returned immediately (avoids duplicate prepend on pagination re-renders).
*
* (!) self.columns_map is expected to be a Promise or a resolved Array at the
* point this function is called. It is awaited with `await self.columns_map`
* so that both forms are handled correctly.
*
* @param {Object} self - The section instance. Reads self.fixed_columns_map,
*   self.columns_map, and self.section_tipo. Writes self.fixed_columns_map.
* @returns {Promise<Array>} Resolved columns_map array with the section_id column
*   prepended to any base columns defined in the ontology.
*/
const rebuild_columns_map = async function(self) {

	// columns_map already rebuilt case
		if (self.fixed_columns_map===true) {
			return self.columns_map
		}

	const columns_map = []

	// column section_id check
		columns_map.push({
			id			: 'section_id',
			label		: 'Id',
			tipo		: 'section_id', // used to sort only
			sortable	: true,
			width		: 'minmax(auto, 6rem)',
			path		: [{
				// note that component_tipo=section_id is valid here
				// because section_id is a direct column in search
				component_tipo	: 'section_id',
				// optional. Just added for aesthetics
				model			: 'component_section_id',
				name			: 'ID',
				section_tipo	: self.section_tipo
			}],
			callback	: render_column_id
		})

	// columns base
		const base_columns_map = await self.columns_map
		columns_map.push(...base_columns_map)

	// fixed as calculated
		self.fixed_columns_map = true


	return columns_map
}//end rebuild_columns_map



/**
* GET_BUTTONS
* Builds the section toolbar fragment containing the search toggle button.
*
* Returns null when self.context.buttons is absent (no ontology buttons configured
* for this section), allowing the caller to skip appending anything to the DOM.
*
* In this thesaurus view the toolbar is intentionally minimal — only the search
* toggle is rendered. The richer toolbar provided by view_default_list_section
* (show-all, delete, import, per-role guards) is not needed here because thesaurus
* term lists are navigated via the tree, not by bulk operations.
*
* (!) 'mousedown' is used instead of 'click' so the button receives the event
* before focus leaves any active input, which would otherwise fire blur/save
* handlers on the currently edited component first.
*
* Event published: 'toggle_search_panel_{self.id}'
*   Subscribed to by the section's search.js instance to show/hide the search
*   panel. The event channel name is namespaced by section id to avoid cross-talk
*   when multiple sections are visible simultaneously.
*
* @param {Object} self - The section instance. Reads self.context.buttons (used
*   only as an existence check) and self.id (for the event channel name).
* @returns {DocumentFragment|null} Fragment containing div.buttons_container
*   with the search button inside, or null if no buttons are configured.
*/
const get_buttons = function(self) {

	// ar_buttons list from context
		const ar_buttons = self.context?.buttons
		if(!ar_buttons) {
			return null;
		}

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
			// Note that self section is who is observing this event (init)
			event_manager.publish('toggle_search_panel_'+self.id)
		})
		// warm up on intent: build requests start before the click
		const warm_handler = () => self.warm_search_panel?.()
		filter_button.addEventListener('pointerenter', warm_handler)
		filter_button.addEventListener('focus', warm_handler)

	return fragment
}//end get_buttons




/**
* RENDER_COLUMN_ID
* Builds the DocumentFragment that populates the 'id' column for one row in
* the thesaurus section list. Called as the 'callback' property of the
* section_id column descriptor produced by rebuild_columns_map().
*
* This is the thesaurus-specific variant of render_column_id. Unlike the
* generic version in render_list_section.js it only handles a single use-case:
* picking a thesaurus term for the caller component that opened this thesaurus.
*
* Behaviour by context:
*
*   A picker is attached (self.caller.area_thesaurus carries a linker stamped by
*     attach_picker): the picker's term control is rendered around the section_id
*     span, exactly the control the tree rows offer. Clicking it toggles the term in
*     the picker's selection; the pick reaches the caller through the ONE publisher
*     in thesaurus_picker.js, which also owns the window resolution this file used to
*     duplicate. A term the server refuses (or has not answered for) renders disabled
*     and titled with the reason — visible, never hidden.
*
*   No picker: an empty fragment, as before (a browsed thesaurus list offers no
*     edit/navigate buttons here).
*
* (!) The gate used to be `self.initiator.indexOf('tool_indexation_')!==-1`, but a
* picker's initiator is the CALLER COMPONENT's id, not a tool name — so searching,
* the primary way into a large thesaurus, could never pick. The gate is now "a picker
* is attached", which is the fact the affordance actually depends on.
*
* Font-size adaptation:
*   get_font_fit_size() computes a scaled font size so that long section IDs fit
*   within the column width. The base size (1.25 rem) matches the --font_size CSS
*   variable defined in list.less. If the computed size differs from the base,
*   it is applied as an inline CSS custom property (--font_size) on the span.
*
* Debug mode:
*   When SHOW_DEBUG is true, the section_id span's title attribute is set to the
*   paginated_key so developers can verify SQO offset arithmetic.
*
* (!) The picker is resolved once, at row build time. It is stamped on the linker by
* attach_picker, which runs after the area is built, so a row rendered before the
* wiring simply gets no control (and the row re-renders with one when the list is
* refreshed) — no half-wired button that fails on click.
*
* @param {Object} options               - Row render options supplied by section_record.
* @param {Object} options.caller        - The section or portal instance that owns
*                                         this list (typically an area_thesaurus section).
* @param {string|number} options.section_id   - The record's section_id value.
* @param {string} options.section_tipo        - The record's ontology tipo, e.g. 'oh1'.
* @param {number} options.paginated_key       - Zero-based position of this row in the
*                                              full result set; used as a debug hint.
* @returns {DocumentFragment} Fragment containing the rendered id-column nodes.
*   Empty when no picker is attached to this thesaurus.
*/
const render_column_id = function(options) {

	// options
		const self			= options.caller // object instance, usually section or portal
		const section_id	= options.section_id
		const section_tipo	= options.section_tipo
		const paginated_key	= options.paginated_key // int . Current item paginated_key in all result
		// the row's envelope entry, verbatim from the section read. Carries the
		// server's per-row `is_indexable` answer for thesaurus sections.
		const locator		= options.locator || null

	// (!) Neither self.permissions nor self.show_interface is read here. They were
	// unused locals before the picker landed too, and reading them would suggest this
	// column decides an authorization it does not: the picker's affordance follows the
	// server's per-term answer, and the write path refuses whatever it should refuse.

	// DocumentFragment
		const fragment = new DocumentFragment()

	// picker
		// The affordance depends on ONE fact: this thesaurus was opened as a picker,
		// i.e. attach_picker stamped the picker on the linker component. The chain is
		// self (section) → self.caller (area_thesaurus) → its linker; get_picker does
		// that one hop and no caller-chain walk. The window resolution the retired
		// publisher carried here lives in thesaurus_picker.publish_link_terms now.
		const picker = get_picker(self.caller?.area_thesaurus)

	// section_id
		const section_id_node = ui.create_dom_element({
			element_type	: 'span',
			class_name		: 'section_id',
			text_content	: section_id
		})
		if(SHOW_DEBUG===true) {
			section_id_node.title = 'paginated_key: ' + paginated_key
		}
		// adjust the font size to fit it into the column
		// @see https://www.freecodecamp.org/news/learn-css-units-em-rem-vh-vw-with-code-examples/#what-are-vw-units
		const base_size	= 1.25 // defined as --font_size: 1.25rem; into CSS (list.less)
		const font_size	= get_font_fit_size(section_id, base_size, 4)
		if (font_size!==base_size) {
			section_id_node.style.setProperty('--font_size', `${font_size}rem`);
		}

	// term control. Rendered only when this thesaurus is a picker
		if (picker) {

			// (!) SELECTABILITY OF A LIST ROW.
			// term_selectability reads the server's answer and computes none:
			// root_terms_selectable (the area read) or the node's own is_indexable.
			// The section list read now stamps that SAME is_indexable on each
			// envelope entry for sections whose section_map declares it, and the
			// entry reaches this callback verbatim as options.locator — so a search
			// result is pickable exactly when the server says the term is. A section
			// that declares no such concept says THAT instead
			// (`selectability_declared:false`), which the write gate already treats
			// as an exemption, so its rows are pickable too. Only a declaring
			// section that fails to answer for a row stays UNKNOWN — never a guess
			// in either direction.
			const control = render_term_pick_control({
				picker		: picker,
				term		: {
					section_tipo	: section_tipo,
					section_id		: section_id,
					label			: self.label ? self.label : ''
				},
				selectable	: term_selectability(picker, {
					section_tipo			: section_tipo,
					section_id				: section_id,
					is_indexable			: locator?.is_indexable,
					// the section declares no per-term contract at all (People,
					// rsc197). Channel 3 — see term_selectability.
					selectability_declared	: locator?.selectability_declared
				}),
				parent		: fragment
			})
			if (control) {
				// list grid styling. `.column.column_section_id > .link_button` (list.less)
				// sizes this cell; the picker's own classes carry the states.
				control.classList.add('link_button')
				// the id number reads first, the arrow icon after it (as before)
				control.insertBefore(section_id_node, control.firstChild)
			} else {
				// (!) NO CONTROL IS NOT NO CELL. The row is not selectable (or the server
				// answered nothing for it), so it gets no link arrow — but the SECTION ID
				// still has to render. Appending it only inside the branch above left the
				// id column completely empty for every list row, which is a worse
				// regression than the missing arrow: the operator loses the record number
				// they navigate by.
				fragment.appendChild(section_id_node)
			}
		} else {
			// no picker: a browsed thesaurus list offers no pick control — but the
			// record number is still the operator's handle on the row, so the id
			// renders exactly as in the generic list.
			fragment.appendChild(section_id_node)
		}


	return fragment
}//end render_column_id




// @license-end
