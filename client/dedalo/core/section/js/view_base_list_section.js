// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_label, Promise */
/*eslint no-undef: "error"*/



// imports
	import {window_section_rows} from '../../section/js/section.js'
	import {event_manager} from '../../common/js/event_manager.js'
	import {ui} from '../../common/js/ui.js'
	import {a11y} from '../../common/js/a11y.js'
	import {set_element_css} from '../../page/js/css.js'
	import {no_records_node} from './render_common_section.js'



/**
* VIEW_BASE_LIST_SECTION
* Minimal base view for rendering a section in list (grid) mode.
*
* This module provides the simplest complete implementation of a list view:
* it handles the full render lifecycle without the extra features found in
* view_default_list_section (font-size adaptation, show-all button, per-button
* access control, etc.).
*
* Intended use cases:
* - Lightweight list views where the richer view_default_list_section is not
*   required.
* - Base template that specialised views can import and override selectively
*   by assigning their own render or get_content_data to the function object.
*
* Exported API:
*   view_base_list_section          — namespace constructor (always returns true)
*   view_base_list_section.render   — builds the full section DOM (async)
*
* Module-private helpers (not exported):
*   get_content_data                — builds the scrollable row area
*   get_buttons                     — builds the toolbar with the search toggle
*
* DOM structure produced by render():
*   <section id="{self.id}" class="wrapper_section …">
*     [div.buttons_container]          — optional; only when self.buttons
*     [div.search_container]           — optional; only when self.filter
*     [div.paginator_container]        — optional; only when self.paginator
*     <div.list_body>
*       <div.list_header>…</div>       — column labels; hidden when 0 records
*       <div.content_data>
*         <div.no_records>             — when the page has no rows
*         | <div>…</div>              — one section_record row per record
*       </div>
*     </div>
*   </section>
*/
export const view_base_list_section = function() {

	return true
}//end view_base_list_section



/**
* RENDER
* Render node for the current view
*
* Builds the complete list DOM for a section instance and returns its wrapper
* element. The function supports two render levels:
*
* - 'full'    (default): builds the entire wrapper including buttons, search
*   placeholder, paginator slot, column header, and content rows. All DOM
*   pointers (wrapper.content_data, wrapper.list_body, wrapper.list_header_node)
*   are set before the wrapper is returned.
*
* - 'content': rebuilds only the row area (content_data). Used by the
*   pagination handler to swap rows without tearing down the entire wrapper.
*   Before returning, the list header's 'hide' class is removed if new records
*   arrived. Returns the content_data element directly, NOT the wrapper.
*
* columns_map resolution order:
*   1. If self.rebuild_columns_map is defined (injected by the caller), it is
*      called and the result is stored back on self.columns_map.
*   2. Otherwise self.columns_map is used as-is.
*
* CSS grid template:
*   ui.flat_column_items() flattens nested column entries into a list of CSS
*   track-size strings (e.g. ['minmax(auto,4rem)', '1fr', '1fr']). These are
*   joined and written to the .list_body grid-template-columns rule via
*   set_element_css() using a scoped selector so that multiple sections on the
*   same page do not clash.
*
* (!) ar_instances holds only the MATERIALIZED rows: the row window
*   (section.js window_section_rows) builds them on demand and a released row
*   leaves the array through its own destroy.
*
* @param {Object} self    - The section instance (type: section). Expected
*                           properties: id, type, model, tipo, section_tipo,
*                           mode, view, context, columns_map, ar_instances,
*                           buttons, filter, paginator, rebuild_columns_map.
* @param {Object} options - Render options.
*   @param {string} [options.render_level='full'] - 'full' | 'content'
* @returns {Promise<HTMLElement>} The section wrapper element (render_level
*   'full') or the content_data div (render_level 'content').
*/
view_base_list_section.render = async function(self, options) {

	// options
		const render_level = options.render_level || 'full'

	// columns_map
	// the method could be injected by caller in this case use it
	// or it can build its own columns and inject the final columns_map
	const columns_map = (self.rebuild_columns_map)
		? await self.rebuild_columns_map(self)
		: self.columns_map

	// assign the result of rebuild columns_map to the instance
	self.columns_map = columns_map

	// rows. The page's locator entries; instances are built by the row window
	// (section.js window_section_rows) only for the rows the viewport reaches
		const rows = self.data?.entries || []
		self.ar_instances = self.ar_instances || []

	// content_data
		const content_data = await get_content_data(self, rows)
		if (render_level==='content') {

			// list_header_node. Remove possible style 'hide' if not empty
				if (rows.length>0) {
					const wrapper = self.node
					if (wrapper.list_header_node && wrapper.list_header_node.classList.contains('hide')) {
						wrapper.list_header_node.classList.remove('hide')
					}
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
			.then(async function(){
				await self.paginator.render().then(paginator_wrapper =>{
					paginator_container.appendChild(paginator_wrapper)
				})
			})

		}

	// list body
		const list_body = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'list_body',
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
			if (self.context.css) {
				// use defined section css
				for(const property in self.context.css) {
					css_object[property] = self.context.css[property]
				}
			}
			// use calculated css
			set_element_css(selector, css_object)

	// list_header_node. Create and append if ar_instances is not empty
		const list_header_node = ui.render_list_header(columns_map, self)
		list_body.appendChild(list_header_node)
		if (rows.length<1) {
			list_header_node.classList.add('hide')
		}

	// content_data append
		list_body.appendChild(content_data)

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


	return wrapper
}//end render



/**
* GET_CONTENT_DATA
* Builds the scrollable row area for the list view.
*
* Hands the page's rows to the row window (at most ROW_WINDOW_MAX_ROWS built at
* once — audit P2-31 / CLI-29) instead of iterating them; each materialized
* row is a section_record node in its original server order, and the first
* window is filled before this resolves. When the array is empty, a localised
* "No records found" placeholder is rendered instead via no_records_node().
*
* The returned div carries the CSS classes 'content_data', self.mode, and
* self.type so that layout rules can target mode/type combinations without
* relying on ancestor selectors.
*
* @param {Object} self              - The section instance (used for .mode and
*                                     .type class names on content_data).
* @param {Array}  rows - The page's locator entries (`self.data.entries`); rows
*                        are built and rendered by the row window on demand.
* @returns {Promise<HTMLElement>} A div.content_data element containing all
*   row nodes (or the no_records placeholder).
*/
const get_content_data = async function(self, rows) {

	// content_data
		const content_data = document.createElement('div')
			  content_data.classList.add('content_data', self.mode, self.type)

	// rows. A row window (section.js window_section_rows) builds and renders
	// section_record rows on demand, at most ROW_WINDOW_MAX_ROWS at once
		if (!rows || rows.length===0) {

			// no records found case
			content_data.appendChild(no_records_node())

		}else{

			await window_section_rows({
				caller			: self,
				container		: content_data,
				rows			: rows,
				render_options	: {
					add_hilite_row : true
				}
			})
		}


	return content_data
}//end get_content_data



/**
* GET_BUTTONS
* Builds the section toolbar fragment containing the search toggle button.
*
* Returns null when self.context.buttons is absent (no ontology buttons defined
* for this section), allowing the caller to skip appending anything.
*
* Only one button is produced in this base view:
*   - "Search" / filter toggle: publishes the event_manager channel
*     'toggle_search_panel_{self.id}', which the search panel instance
*     (initialised in section.js) subscribes to in order to show/hide itself.
*
* (!) 'mousedown' is intentionally used instead of 'click' so that the toolbar
*   button receives the event before focus leaves the active component, which
*   would otherwise fire component blur/save handlers first.
*
* Note: this is a stripped-down variant. view_default_list_section provides a
* richer toolbar with show-all, delete, import, and per-user-role button guards.
*
* @param {Object} self - The section instance. Reads self.context.buttons and
*                        self.id.
* @returns {DocumentFragment|null} Fragment containing div.buttons_container
*   (with the search button inside), or null if no buttons are configured.
*/
const get_buttons = function(self) {

	// ar_buttons list from context
		const ar_buttons = self.context.buttons
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
		// a11y (audit P1-18 / CLI-11). A real <button> whose ONLY listener is
		// `mousedown` is keyboard-dead: Enter and Space dispatch `click`. Routing
		// both through the shared helper is what makes the search panel reachable.
		a11y.make_activable(filter_button, {
			pointer_event	: 'mousedown',
			on_activate		: function(e) {
				e.stopPropagation()
				// Note that self section is who is observing this event (init)
				event_manager.publish('toggle_search_panel_'+self.id)
			}
		})
		// warm up on intent: build requests start before the click
		const warm_handler = () => self.warm_search_panel?.()
		filter_button.addEventListener('pointerenter', warm_handler)
		filter_button.addEventListener('focus', warm_handler)


	return fragment
}//end get_buttons



// @license-end
