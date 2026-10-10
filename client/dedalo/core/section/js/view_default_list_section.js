// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_label, Promise */
/*eslint no-undef: "error"*/



// imports
	import {window_section_rows} from '../../section/js/section.js'
	import {event_manager} from '../../common/js/event_manager.js'
	import {clone, get_font_fit_size} from '../../common/js/utils/index.js'
	import {ui} from '../../common/js/ui.js'
	import {a11y} from '../../common/js/a11y.js'
	import {open_tool} from '../../../core/tools_common/js/tool_common.js'
	import {set_element_css} from '../../page/js/css.js'
	import {no_records_node, is_non_tools_section} from './render_common_section.js'
	import {
		build_semantic_quick_input,
		build_pinned_chip
	} from '../../search/js/render_semantic.js'
	import {
		render_column_id
	} from './render_list_section.js'



/**
* VIEW_DEFAULT_LIST_SECTION
* Default list-view renderer for a Dédalo section.
*
* This module provides the primary rendering path when a section is displayed
* in 'list' mode and no custom view override is configured. It is consumed by
* render_list_section.list (core/section/js/render_list_section.js) via the
* render_views fallback chain.
*
* Responsibilities:
*   - Assembles the full section list DOM: search/filter toolbar, paginator,
*     column header row, and content rows.
*   - Builds (or reuses) the columns_map — the ordered descriptor array that
*     drives both the CSS grid layout and the per-column render callbacks.
*   - Delegates per-row rendering to section_record instances built on demand
*     by the row window (section.js window_section_rows).
*   - Adapts the section-id column width and font size dynamically so that
*     long numeric IDs do not overflow the fixed-width id cell.
*
* All public API lives on static-style properties of the constructor function
* (view_default_list_section.render, .get_content_data, etc.). The constructor
* itself is a no-op; this module is never instantiated.
*
* The private helper `get_buttons` is module-scoped and not exported.
*
* (!) `page_globals` is referenced inside get_buttons but is NOT listed in the
*     file-level global pragma. At runtime it is injected as a true browser
*     global by the page bootstrap; the missing pragma is a lint-coverage gap
*     that should be addressed (adding `page_globals` to the global pragma line).
*/



/**
* VIEW_DEFAULT_LIST_SECTION
* Namespace constructor — never instantiated; all functionality is exposed as
* static-style properties (view_default_list_section.render, etc.).
*/
export const view_default_list_section = function() {

	return true
}//end view_default_list_section



/**
* RENDER
* Builds and returns the full list-mode wrapper element for the section.
*
* Two-phase rendering:
*   1. 'content' render_level — only the content rows are (re-)built and returned
*      as a detached <div class="content_data"> node. Used by pagination to swap
*      in new rows without rebuilding the chrome (header, buttons, paginator).
*   2. 'full' render_level (default) — builds the complete DOM: buttons toolbar,
*      optional search container, optional paginator, list_body (containing the
*      column header and rows), and the outer <section> wrapper.
*
* Side effects:
*   - Stores the resolved columns_map on self.columns_map.
*   - Stores self.node_body pointing to the list_body element.
*   - Stores self.search_container for the search panel to attach into.
*   - Sets scoped CSS grid layout via set_element_css using the selector
*     `{section_tipo}_{tipo}.list`.
*
* @param {Object} self - The section instance (contains rqo, context, mode,
*   tipo, section_tipo, ar_instances, filter, paginator, buttons, data, …).
* @param {Object} options - Render options.
*   @param {string} [options.render_level='full'] - 'full' for initial render;
*     'content' to regenerate only the data rows (e.g. on pagination).
* @returns {Promise<HTMLElement>} On 'full': the <section> wrapper element.
*   On 'content': the <div class="content_data"> element.
*/
view_default_list_section.render = async function(self, options) {

	// options
		const render_level = options.render_level || 'full'

	// columns_map
		const columns_map	= await this.rebuild_columns_map(self)
		self.columns_map	= columns_map

	// rows. The page's locator entries; instances are built by the row window
	// (section.js window_section_rows) only for the rows the viewport reaches
		const rows = self.data?.entries || []
		self.ar_instances = self.ar_instances || []

	// content_data
		const content_data = await this.get_content_data(self, rows)
		if (render_level==='content') {

			// pinned chip. A content refresh (show_all, the chip's own ✕, a
			// semantic search) keeps the header, so the SQO-derived chip must be
			// re-synced here or it outlives the pins it reports.
				sync_pinned_chip(self)

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
			.then(function(){
				self.paginator.render()
				.then(paginator_wrapper =>{
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

		const set_list_body_css = (replace) => {

			// list_body css
				const selector = `${self.section_tipo}_${self.tipo}.list`

			// custom properties defined css
				// if (self.context.css) {
					// use defined section css
					// set_element_css(selector, self.context.css)
				// }
				// flat columns create a sequence of grid widths taking care of sub-column space
				// like 1fr 1fr 1fr 3fr 1fr
				const items				= ui.flat_column_items(columns_map)
				const template_columns	= items.join(' ')

				// re-parse template_columns as percent
					// const items_lenght = items.length
					// const percent_template_columns = items.map(el => {
					// 	if (el==='1fr') {
					// 		return Math.ceil(90 / (items_lenght -1)) + '%'
					// 	}
					// 	return el
					// }).join(' ')
					// console.log("percent_template_columns:",percent_template_columns);

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

				// set css
				set_element_css(selector, css_object, replace)
		}//end set_list_body_css
		set_list_body_css(true)

		// Adapt section_id column width/font to the longest ID on this page (first render)
		view_default_list_section.adapt_section_id_column(list_body, self)

	// list_header_node. Create and append if the page is not empty
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
* Builds the <div class="content_data"> element for the current page and hands
* its rows to a ROW WINDOW (section.js window_section_rows → common/js/
* row_window.js): only the rows the viewport can reach are built — at most
* ROW_WINDOW_MAX_ROWS at once — and rows past the far edge are released. The
* first window is filled before this resolves, so the returned node already
* holds the first rows (audit P2-31 / CLI-29: the page DEC-07 permits is 1000
* rows, and every one used to be built synchronously).
*
* When the rows array is empty a "no records found" placeholder is shown
* instead of an empty grid (via no_records_node from render_common_section).
*
* After building the content node, re-runs adapt_section_id_column so that
* the id column is resized to match the longest ID on the new page (important
* on pagination, where self.node_body already exists from the first render).
*
* @param {Object} self - The section instance. Must expose: mode, type, node_body.
* @param {Array} rows - The page's locator entries (`self.data.entries`), or
*   already-built section_record instances (the TM inspector panels).
* @returns {Promise<HTMLElement>} The populated <div class="content_data"> node.
*/
view_default_list_section.get_content_data = async function(self, rows) {

	// content_data
		const content_data = document.createElement('div')
			  content_data.classList.add('content_data', self.mode, self.type)

	// rows
		if (!rows || rows.length===0) {

			// no records found case
			content_data.appendChild(no_records_node())

		}else{

			// row window: builds and renders section_record rows on demand
			await window_section_rows({
				caller			: self,
				container		: content_data,
				rows			: rows,
				render_options	: {
					add_hilite_row : true
				}
			})
		}

	// Re-adapt section_id column on every content refresh (pagination).
	// self.node_body is set on first render; on pagination it is the existing list_body.
		if (self.node_body) {
			view_default_list_section.adapt_section_id_column(self.node_body, self)
		}

	return content_data
}//end get_content_data



/**
 * ADAPT_SECTION_ID_COLUMN
 * Computes the font-size and column-width CSS variables needed to fit
 * the longest section_id in the current page into the id column.
 *
 * Reads self.data.entries to find the entry whose section_id string
 * representation has the most characters. When that length exceeds 5 digits
 * get_font_fit_size is used to shrink the font proportionally, and the
 * column width is widened to `char_count × font_size + 0.25 rem`.
 *
 * Certain section tipos (dd542 = Activity, dd15) intentionally keep a fixed
 * id-column style and are excluded from the calculation.
 *
 * When all IDs on the page are short (≤ 5 chars) any previously applied
 * inline CSS variables are removed so the stylesheet default takes effect again
 * (avoids stale overrides carried over from previous pagination pages).
 *
 * CSS custom properties written (on list_body_node inline style):
 *   --section_id_font_size  (rem)
 *   --column_id_width       (rem)
 *
 * @param {HTMLElement} list_body_node - The .list_body element whose inline
 *   style receives the CSS custom properties.
 * @param {Object} self - The section instance. Must expose:
 *   self.data.entries (Array of record entry objects with a section_id field),
 *   self.tipo (string, section tipo used for the exclusion list).
 * @returns {void}
 */
view_default_list_section.adapt_section_id_column = function(list_body_node, self) {
	if (!list_body_node || !self) return

	const ar_entries = self.data?.entries || []
	if (ar_entries.length === 0) return

	const base_size = 1.25 // matches --section_id_font_size default in vars.less

	// find the entry whose section_id has the most characters
	const longest_id = ar_entries.reduce((longest, el) => {
		const current = String(el.section_id ?? '')
		return current.length > longest.length ? current : longest
	}, '')

	if (longest_id.length > 5) {
		const font_size = get_font_fit_size(longest_id, base_size, 4)
		if (font_size !== base_size) {
			const non_button_tipos = ['dd542','dd15']
			if (!non_button_tipos.includes(self.tipo)) {
				list_body_node.style.setProperty('--section_id_font_size', `${font_size}rem`)
				const column_id_width = longest_id.length * font_size + 0.25
				list_body_node.style.setProperty('--column_id_width', `${column_id_width}rem`)
				return
			}
		}
	}

	// reset: new page has short IDs — undo any previously applied enlargement
	list_body_node.style.removeProperty('--section_id_font_size')
	list_body_node.style.removeProperty('--column_id_width')
}//end adapt_section_id_column



/**
* REBUILD_COLUMNS_MAP
* Builds the ordered columns descriptor array used by the list renderer.
*
* A columns_map entry describes a single visual column in the list grid.
* Each entry contains at minimum:
*   id        {string}   – unique identifier for the column
*   label     {string}   – header display text
*   tipo      {string}   – ontology tipo used for sort routing
*   sortable  {boolean}  – whether the column header shows a sort arrow
*   width     {string}   – CSS sizing token (e.g. 'minmax(auto, var(--column_id_width))')
*   path      {Array}    – array of path-step objects describing how to reach
*                          the component value from the section root; each step
*                          carries { component_tipo, model, name, section_tipo }
*   callback  {Function} – render function invoked per row to produce the cell node
*
* This function always prepends a synthetic 'section_id' column before the
* ontology-defined columns (self.columns_map). The section_id column uses
* render_column_id from render_list_section.js as its default callback,
* but callers may override it via this.render_column_id (e.g. custom views
* that extend the default behaviour).
*
* The idempotency guard (self.fixed_columns_map === true) prevents the id
* column from being prepended twice when the section re-renders its content
* (e.g. on pagination). It is set to true only when ontology columns were
* present; sections with no configured columns never set the flag and will
* re-enter this function on each call (safe because columns_map stays
* consistent across calls).
*
* @param {Object} self - The section instance. Reads:
*   self.columns_map {Array|undefined} – base columns from the ontology/context.
*   self.fixed_columns_map {boolean|undefined} – idempotency flag.
*   self.section_tipo {string} – used to populate path[0].section_tipo.
* @returns {Promise<Array>} The final columns_map with the id column at index 0.
*/
view_default_list_section.rebuild_columns_map = async function(self) {

	// Early return if columns_map already rebuilt
	if (self.fixed_columns_map===true) {
		return self.columns_map || []
	}

	// Initialize columns_map array
	const columns_map = []

	// Add section_id column
    const section_id_column = {
		id			: 'section_id',
		label		: 'Id',
		tipo		: 'section_id', // used to sort only
		sortable	: true,
		width		: 'minmax(auto, var(--column_id_width))',
		path		: [{
			// note that component_tipo=section_id is valid here
			// because section_id is a direct column in search
			component_tipo	: 'section_id',
			// optional. Just added for aesthetics
			model			: 'component_section_id',
			name			: 'ID',
			section_tipo	: self.section_tipo
		}],
		callback	: this.render_column_id || render_column_id
    }
	columns_map.push(section_id_column)

	// Add base columns if they exist
	const base_columns_map = self.columns_map || [];
    if (Array.isArray(base_columns_map)) {
        columns_map.push(...base_columns_map);
    }

	// Mark as fixed if we have base columns
	if (base_columns_map.length > 0) {
		self.fixed_columns_map = true
	}


	return columns_map
}//end rebuild_columns_map



/**
* SYNC_PINNED_CHIP
* Re-derives the pinned-state chip from the current SQO on a 'content'
* re-render, where get_buttons does not run: drops the old chip and places the
* new one (if any) where get_buttons puts it, right after the search buttons.
* @param {Object} self - The section instance (list view).
* @returns {void}
*/
const sync_pinned_chip = function(self) {

	const buttons_container = self.node?.querySelector(':scope > .buttons_container')
	if (!buttons_container) {
		return
	}

	buttons_container.querySelector(':scope > .semantic_pinned_chip')?.remove()

	const pinned_chip = build_pinned_chip(self)
	if (!pinned_chip) {
		return
	}
	const search_buttons_container = buttons_container.querySelector(':scope > .search_buttons_container')
	if (search_buttons_container) {
		search_buttons_container.after(pinned_chip)
	}else{
		buttons_container.prepend(pinned_chip)
	}
}//end sync_pinned_chip



/**
* GET_BUTTONS
* Builds the full toolbar fragment containing search controls and action buttons
* for the section list view.
*
* Structure of the returned DocumentFragment:
*   buttons_container
*     ├─ search_buttons_container
*     │    ├─ filter_button         (toggles the search panel via event_manager)
*     │    └─ show_all_button       (resets filters by calling self.filter.show_all)
*     ├─ other_buttons_block        (hidden by default; toggled by show_other_buttons_button)
*     │    ├─ <dynamic action buttons from self.context.buttons>
*     │    └─ <tool buttons via ui.add_tools_menu: pinned + one Tools popover>
*     └─ show_other_buttons_button  (collapse/expand toggle with persistent state)
*
* Button models handled in the action button loop:
*   'button_new'              – publishes 'new_section_{id}' to create a new record.
*   'button_delete'           – opens the multi-delete dialog via
*                               self.render_delete_record_dialog; restricted to
*                               global admins (page_globals.is_global_admin).
*   'button_import'           – opens a tool via open_tool (legacy import entry-point).
*   'button_trigger'          – opens a tool via open_tool (general-purpose tool trigger;
*                               prefer this over button_import for new ontology items).
*   default                   – publishes 'click_{model}' for custom event listeners.
*
* Certain section tipos are considered non-editable (dd542 = Activity, dd15 =
* Time Machine, dd1324 = Registered tools) and receive only the search buttons;
* the other_buttons_block is not added for them.
*
* Returns null (not a fragment) when self.context.buttons is absent, so the caller
* must guard against a falsy return value.
*
* (!) page_globals is accessed as a browser global (not imported / declared in
*     the global pragma). This is a pre-existing issue — do not resolve here.
*
* @param {Object} self - The section instance. Must expose: context.buttons,
*   filter, id, tipo, section_tipo, rqo.sqo, render_delete_record_dialog.
* @returns {DocumentFragment|null} The toolbar fragment, or null when
*   self.context.buttons is not defined.
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

	// search buttons container
		const search_buttons_container = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'search_buttons_container',
			parent			: buttons_container
		})

	// filter button (search) . Show and hide all search elements
		const filter_button	= ui.create_dom_element({
			element_type	: 'button',
			class_name		: 'warning search',
			inner_html		: get_label.find || 'Search',
			parent			: search_buttons_container
		})
		// mousedown event
		const mousedown_handler = (e) => {
			e.stopPropagation()
			// Note that self section is who is observing this event (init)
			event_manager.publish('toggle_search_panel_'+self.id)
		}
		// a11y (audit P1-18 / CLI-11): a mousedown-only <button> is keyboard-dead.
		a11y.make_activable(filter_button, {
			pointer_event	: 'mousedown',
			on_activate		: mousedown_handler
		})

	// show_all_button. Show all records button
		const show_all_button	= ui.create_dom_element({
			element_type	: 'button',
			class_name		: 'warning show_all',
			inner_html		: get_label.show_all || 'Show all',
			parent			: search_buttons_container
		})
		// mousedown event
		const show_all_mousedown_handler = (e) => {
			e.stopPropagation()
			// Trigger section filter (search.js instance) method 'show_all' like search form do.
			self.filter.show_all(show_all_button)
		}
		a11y.make_activable(show_all_button, {
			pointer_event	: 'mousedown',
			on_activate		: show_all_mousedown_handler
		})

	// semantic quick input (RAG, 2026-07-22). Hidden unless the searched
	// section declares embed groups; Enter fires the search instance's
	// exec_semantic_search (resolve-once-then-pin).
		const semantic_quick_input = build_semantic_quick_input(self)
		search_buttons_container.appendChild(semantic_quick_input)

	// pinned-state chip — SQO-derived (pins persist in the server session SQO
	// across reloads while client memory dies with the page; without this chip
	// the list is invisibly filtered — adversarial review #1).
		const pinned_chip = build_pinned_chip(self)
		if (pinned_chip) {
			buttons_container.appendChild(pinned_chip)
		}

	// non_editable_sections. Read-only log sections + registered tools + every
	// section_tool "process" page (oh81 …): they carry no action buttons and no
	// section tools (consultation-only, WC-010 + WC-2026-10-06-consultation-only-no-section-tools;
	// section_tool pages drive their content through config.tool_context, not the
	// target section's toolbar), so the other-buttons drawer and its toggle are
	// omitted — only the search controls remain. Activity (dd542) and Time machine
	// (dd15) MUST behave identically; the rule is shared with
	// view_graph_list_section (render_common_section.is_non_tools_section).
		if (is_non_tools_section(self)) {
			return fragment
		}

	// other_buttons_block
		const other_buttons_block = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'other_buttons_block hide',
			parent			: buttons_container
		})

	// other buttons
		const ar_buttons_length = ar_buttons.length;
		for (let i = 0; i < ar_buttons_length; i++) {

			const current_button = ar_buttons[i]

			// button_delete multiple
			// check if user is global admin to activate the button delete (avoid users to delete multiple sections)
				if(current_button.model==='button_delete' && page_globals.is_global_admin===false){
					continue
				}

			// button node
				const class_name	= 'warning ' + current_button.model.replace('button_', '')
				const button_node	= ui.create_dom_element({
					element_type	: 'button',
					class_name		: class_name,
					inner_html		: current_button.label,
					parent			: other_buttons_block
				})
				// icon
				// section buttons option for custom button CSS classes.
				// To define a button class, set ontology item properties such as "css": { "style": "import_files" }
				if (current_button.properties?.css && current_button.properties?.css.style) {
					button_node.classList.add(current_button.properties.css.style)
				}
				// import/trigger buttons open a tool but carry no registry icon;
				// give them the target tool's descriptive icon via the unified
				// ::before / --icon-path path (same as ui.build_button), so every
				// toolbar button shows an icon and is spinner-capable.
				if ((current_button.model==='button_import' || current_button.model==='button_trigger') && current_button.tools?.[0]?.icon) {
					button_node.classList.add('has_icon')
					button_node.style.setProperty('--icon-path', "url('" + current_button.tools[0].icon + "')")
				}
				// click event
				const click_handler = (e) => {
					e.stopPropagation()

					switch(current_button.model){
						case 'button_new':
							event_manager.publish('new_section_' + self.id)
							break;

						case 'button_delete': {
							// sqo conform
							const delete_sqo = clone(self.rqo.sqo)
							delete_sqo.limit = null
							delete delete_sqo.offset

							// delete_record
							self.render_delete_record_dialog({
								section			: self,
								section_id		: null,
								section_tipo	: self.section_tipo,
								sqo				: delete_sqo
							})
							break;
						}
						// button_import and button_trigger cases for compatibility with v5 ontology
						// in future version will be merge both with new model button_tool
						// in the mid-time use button_trigger for general cases to dispatch tools.
						case 'button_import':
						case 'button_trigger':
							// open_tool (tool_common)
							open_tool({
								tool_context	: current_button.tools[0],
								caller			: self,
								caller_options	: {
									section_tipo	: self.section_tipo,
									button_tipo		: current_button.tipo
								}
							})
							break;

						default:
							event_manager.publish('click_' + current_button.model)
							break;
					}
				}
				button_node.addEventListener('click', click_handler)
		}//end for (let i = 0; i < ar_buttons_length; i++)

	// tools buttons
		ui.add_tools_menu(self, other_buttons_block)

	// show_other_buttons_button
		const show_other_buttons_label	= get_label.show_buttons || 'Show buttons'
		const show_other_buttons_button	= ui.create_dom_element({
			element_type	: 'button',
			class_name		: 'icon_arrow show_other_buttons_button',
			title			: show_other_buttons_label,
			dataset			: {
				label : show_other_buttons_label
			},
			parent			: buttons_container
		})
		// a11y: icon-only toggle — the title is the name the operator reads on
		// hover, so it is the name the accessibility tree gets too.
		a11y.set_label(show_other_buttons_button, show_other_buttons_label)
		show_other_buttons_button.addEventListener('click', function(e) {
			e.stopPropagation()
		})

	// track collapse toggle state of content
		ui.collapse_toggle_track({
			toggler				: show_other_buttons_button,
			container			: other_buttons_block,
			collapsed_id		: 'section_other_buttons_block',
			collapse_callback	: () => {show_other_buttons_button.classList.remove('up')},
			expose_callback		: () => {show_other_buttons_button.classList.add('up')},
			default_state		: 'closed'
		})


	return fragment
}//end get_buttons



// @license-end
