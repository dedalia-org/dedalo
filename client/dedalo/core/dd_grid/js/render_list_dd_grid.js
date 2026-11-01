// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_label, page_globals, SHOW_DEBUG, DEDALO_CORE_URL*/
/*eslint no-undef: "error"*/



/**
* RENDER_LIST_DD_GRID
* Entry-point render module for dd_grid instances displayed in list mode.
*
* Responsibilities:
* - Acts as the prototype host for dd_grid.prototype.list, which is assigned by
*   dd_grid.js via `dd_grid.prototype.list = render_list_dd_grid.prototype.list`.
* - Dispatches the list render call to the correct view implementation based on
*   self.view (supplied by the server context layer during dd_grid.init).
* - Exports a set of standalone column-builder helpers (get_text_column,
*   get_av_column, get_img_column, get_label_column, get_button_column,
*   get_json_column, get_section_id_column, get_iri_column) that are imported and
*   reused by every view module (view_default_dd_grid, view_mini_dd_grid,
*   view_indexation_dd_grid, view_descriptors_dd_grid, view_table_dd_grid).
*
* Supported views (routed in prototype.list):
*   'table'       → view_table_dd_grid  (HTML <table> with header row)
*   'mini'        → view_mini_dd_grid   (compact card-style layout)
*   'indexation'  → view_indexation_dd_grid (thesaurus indexation panel)
*   'descriptors' → view_descriptors_dd_grid (descriptor list panel)
*   'default'     → view_default_dd_grid (standard div-based grid, the fallback)
*
* Column data shape expected by the helper functions:
*   {
*     cell_type        : string,        // 'text'|'av'|'img'|'iri'|'button'|'json'|'section_id'
*     value            : Array|*,       // cell content; exact shape depends on cell_type
*     fallback_value   : Array|*,       // optional; used when value is empty (get_text_column)
*     class_list       : string,        // optional; extra CSS classes
*     records_separator: string,        // optional; default ' | '
*     label            : string,        // optional; used by get_label_column
*     render_label     : boolean,       // optional; whether to prepend a label element
*     action           : Object,        // optional; button action descriptor (get_button_column)
*     type             : string,        // 'column' | container type string
*   }
*
* @module render_list_dd_grid
*/

// imports
	import {ui} from '../../common/js/ui.js'
	import {render_value, render_join} from '../../common/js/utils/render_escape.js'
	import {view_table_dd_grid} from './view_table_dd_grid.js'
	import {view_default_dd_grid} from './view_default_dd_grid.js'
	import {view_mini_dd_grid} from './view_mini_dd_grid.js'
	import {view_indexation_dd_grid} from './view_indexation_dd_grid.js'
	import {view_descriptors_dd_grid} from './view_descriptors_dd_grid.js'
	import {
		render_links_list
	} from '../../component_iri/js/render_list_component_iri.js'



/**
* RENDER_LIST_DD_GRID
* Manage the components logic and appearance in client side
*/
export const render_list_dd_grid = function() {

	return true
}//end render_list_dd_grid



/**
* LIST
* Dispatches the list-mode render call to the appropriate view implementation.
*
* Reads self.view (resolved in dd_grid.init from options.view or
* options.context.view, falling back to 'default') and delegates to the
* matching view module's static render() method.
*
* Note: The legacy 'csv', 'tsv', and 'table_export' views were removed; those
* export formats are now handled by tool_export via the flat-table protocol
* (see tools/tool_export/js/flat_table.js).
*
* @param {Object} options - render options forwarded verbatim to the view renderer
* @returns {Promise<HTMLElement>} the rendered wrapper node produced by the selected view
*/
render_list_dd_grid.prototype.list = async function(options) {

	const self = this

	// view
		const view	= self.view
			? self.view
			: 'default'

	switch(view) {

		// note: the legacy 'csv' / 'tsv' / 'table_export' views were removed:
		// tool_export renders CSV/TSV/XLSX from the flat-table export
		// protocol now (see tools/tool_export/js/flat_table.js)

		case 'table':
			return view_table_dd_grid.render(self, options)

		case 'mini':
			return view_mini_dd_grid.render(self, options)

		case 'indexation':
			return view_indexation_dd_grid.render(self, options)

		case 'descriptors':
			return view_descriptors_dd_grid.render(self, options)

		case 'default':
		default:
			return view_default_dd_grid.render(self, options)
	}
}//end list



/**
* GET_TEXT_COLUMN
* Render a span DOM node with given value
*
* Builds a <span> containing the display-ready string for a 'text' cell.
* The value is expected to be an Array of resolved strings; elements are joined
* with records_separator (default ' | '). When use_fallback is true the function
* falls back to data_item.fallback_value when the primary value array is empty.
*
* Safety limits applied before setting innerHTML:
*   - Arrays longer than 25 items → replaced with the literal 'Data is too big'
*     to prevent unbounded DOM growth in list rows.
*   - Joined strings longer than 2 000 characters → same sentinel.
* These thresholds protect the list render path only; the table view performs
* its own truncation inside render_text_column.
*
* When the resulting string is empty the span receives the CSS class 'empty' so
* callers can style missing-value cells distinctly.
*
* @param {Object} data_item - server-supplied column descriptor for a text cell
* @param {Array|*} data_item.value - primary display value; usually an Array of strings
* @param {Array|*} [data_item.fallback_value] - secondary value used when value is absent (requires use_fallback=true)
* @param {string} [data_item.class_list=''] - additional CSS classes appended to the span
* @param {string} [data_item.records_separator=' | '] - glue string for joining array items
* @param {boolean} [use_fallback=false] - when true, substitute fallback_value if value is empty
* @returns {HTMLElement} <span> node with the formatted text as innerHTML
* @throws {Error} if data_item is not a non-null object
*/
export const get_text_column = function(data_item, use_fallback=false) {

	// Input validation
	if (!data_item || typeof data_item !== 'object') {
		throw new Error('data_item must be a valid object');
	}

	const class_list		= data_item.class_list || '';
	const records_separator	= data_item.records_separator || ' | ';

	// Determine which value to use
	const value = use_fallback===true
		? (data_item.value && data_item.value[0]!==undefined ? data_item.value : data_item.fallback_value)
		: data_item.value

	// Convert value to string — through the render-boundary escaper, keyed on
	// the cell's server-stamped render_class (absent → text).
	const value_string = !value
		? ''
		: Array.isArray(value)
			? (value.length > 25
				? 'Data is too big' // array length limit
				: render_join(value, records_separator, data_item.render_class))
			: render_value(value, data_item.render_class) // non-array values

	// safe_value_string. Max chars is 2000 characters
	const safe_value_string = value_string.length > 2000
		? 'Data is too big'
		: value_string;

	// Determine additional CSS class
	const add_style = value_string.length === 0 ? 'empty' : ''

	// Create and return DOM element
	const text_node = ui.create_dom_element({
		element_type	: 'span',
		class_name		: [class_list, add_style].join(' ').trim(),
		inner_html		: safe_value_string
	})


	return text_node
}//end get_text_column



/**
* GET_AV_COLUMN
* Builds an <img> element for an audio-visual component cell in list view.
*
* Reads data_item.value[0].posterframe_url as the image source.
* On load error the src is replaced with page_globals.fallback_image (the global
* placeholder image URL), guarded against an infinite error loop by checking
* whether the current src already equals the fallback.
*
* Note: the set_bg_color background-colour helper is commented out but left in
* place for reference; it was removed when the background-image approach was
* abandoned in favour of a pure <img> element.
*
* @param {Object} data_item - server-supplied column descriptor for an AV cell
* @param {Array} data_item.value - must have at least one element; value[0].posterframe_url is the image URL
* @param {string} [data_item.class_list=''] - CSS classes applied to the <img>
* @returns {HTMLElement} <img> element with src set to the posterframe URL
*/
export const get_av_column = function(data_item) {

	const class_list = data_item.class_list || ''

	// url
		const posterframe_url	= data_item.value[0].posterframe_url
		const url				= posterframe_url

	// image
		const image = ui.create_dom_element({
			element_type	: 'img',
			class_name		: class_list

		})
		image.addEventListener('error', function(e) {
			if (image.src!==page_globals.fallback_image) {
				image.src = page_globals.fallback_image
			}
		})

		image.src = url

	// set_bg_color
		// image.addEventListener('load', set_bg_color, false)
		// function set_bg_color() {
		// 	this.removeEventListener('load', set_bg_color, false)
		// 	ui.set_background_image(this, image)
		// }

	return image
}//end get_av_column



/**
* GET_IMG_COLUMN
* Builds an <img> element for a component_image cell in list view.
*
* Reads data_item.value[0] as the raw image URL string. Unlike the table-view
* counterpart (render_img_column in view_table_dd_grid), this helper does NOT
* prepend window.location.origin to relative URLs — the value is used as-is.
*
* On load error the src falls back to page_globals.fallback_image, with the
* same infinite-loop guard used in get_av_column.
*
* Note: the set_bg_color helper is commented out (same reason as get_av_column).
*
* @param {Object} data_item - server-supplied column descriptor for an image cell
* @param {Array} data_item.value - must have at least one element; value[0] is the image URL string
* @param {string} [data_item.class_list=''] - CSS classes applied to the <img>
* @returns {HTMLElement} <img> element with src set to the image URL
*/
export const get_img_column = function(data_item) {

	const class_list = data_item.class_list || ''

	// url
		const url = data_item.value[0]

	// image
		const image = ui.create_dom_element({
			element_type	: 'img',
			class_name		: class_list
		})
		image.addEventListener('error', function(e) {
			if (image.src!==page_globals.fallback_image) {
				image.src = page_globals.fallback_image
			}
		})

		image.src = url

	// set_bg_color
		// image.addEventListener('load', set_bg_color, false)
		// function set_bg_color() {
		// 	this.removeEventListener('load', set_bg_color, false)
		// 	ui.set_background_image(this, image)
		// }

	return image
}//end get_img_column



/**
* GET_LABEL_COLUMN
* Builds a <label> element containing the human-readable column heading.
*
* Used by view_default_dd_grid and view_indexation_dd_grid when a data item
* carries render_label=true, to prepend a label node to the column container
* before the value node is appended.
*
* @param {Object} current_data - server-supplied column descriptor
* @param {string} current_data.label - the text to render inside the label element
* @returns {HTMLElement} <label> element with inner_html set to current_data.label
*/
export const get_label_column = function(current_data) {

	const label_node = ui.create_dom_element({
		element_type	: 'label',
		inner_html		: render_value(current_data.label, 'text')
	})

	return label_node
}//end get_label_column



/**
* GET_BUTTON_COLUMN
* Builds an <img>-based interactive button for a 'button' cell.
*
* The button is rendered as an <img> element (not a <button>) so that it can
* display an icon image. The click action is fully dynamic: the event type,
* module path, method name, and options are all supplied by the server in
* current_data.value[0].action, allowing the button to trigger arbitrary
* behaviour without compile-time coupling.
*
* Action descriptor shape (current_data.value[0].action):
*   {
*     event       : string,  // DOM event name, e.g. 'click'
*     module_path : string,  // ES module path passed to dynamic import()
*     method      : string,  // exported function name to call on the module
*     options     : Object   // forwarded to the method; button_caller is injected
*   }
*
* Note: options.button_caller is mutated in the event handler to point to
* e.target before being passed to the imported method. Callers relying on a
* clean options object should be aware of this side-effect.
*
* @param {Object} current_data - server-supplied column descriptor for a button cell
* @param {Array} current_data.value - must have at least one element; value[0] holds action + class_list
* @returns {HTMLElement} <img> element (acts as a clickable button icon)
*/
export const get_button_column = function(current_data) {

	const value			= current_data.value[0]
	const class_list	= value.class_list || ''

	// image
		const button = ui.create_dom_element({
			element_type	: 'img',
			// a11y: an icon-only action — its name is the server's button label
			alt				: value.label ?? '',
			class_name		: class_list
		})

	// event
		if (value.action && value.action.event) {

			button.addEventListener(value.action.event, async (e)=>{
				const options			= value.action.options
				options.button_caller	= e.target

				const module = await import (value.action.module_path)
				module[value.action.method](options)
			})
		}

	return button
}//end get_button_column



/**
* GET_JSON_COLUMN
* Builds a <span> element containing the JSON-serialised representation of a
* component_json cell value.
*
* The entire value object is passed through JSON.stringify without truncation.
* For large JSON payloads in a list context this may produce very long strings;
* the table-view counterpart (render_json_column) additionally HTML-encodes
* special characters when data_format is 'dedalo_raw'.
*
* @param {Object} current_data - server-supplied column descriptor for a JSON cell
* @param {*} current_data.value - the value to serialise; passed directly to JSON.stringify
* @param {string} [current_data.class_list=''] - CSS classes applied to the <span>
* @returns {HTMLElement} <span> element with innerHTML set to JSON.stringify(value)
*/
export const get_json_column = function(current_data) {

	const class_list = current_data.class_list || ''

	const text_json = ui.create_dom_element({
		element_type	: 'span',
		class_name		: class_list,
		inner_html		: render_value(JSON.stringify(current_data.value), 'text')
	})

	return text_json
}//end get_json_column



/**
* GET_SECTION_ID_COLUMN
* Builds a <span> element displaying the raw section_id value of a record.
*
* Intended for cells whose cell_type is 'section_id'. The value is rendered
* verbatim (no joining or transformation) because section IDs are always scalar
* integers or strings.
*
* @param {Object} current_data - server-supplied column descriptor for a section_id cell
* @param {string|number} current_data.value - the section ID to display
* @param {string} [current_data.class_list=''] - CSS classes applied to the <span>
* @returns {HTMLElement} <span> element with innerHTML set to the section ID
*/
export const get_section_id_column = function(current_data) {

	const class_list = current_data.class_list || ''

	const section_id_node = ui.create_dom_element({
		element_type	: 'span',
		class_name		: class_list,
		inner_html		: render_value(current_data.value, 'number')
	})

	return section_id_node
}//end get_section_id_column



/**
* GET_IRI_COLUMN
* Builds a <span> wrapper containing the IRI link fragment for a component_iri cell.
*
* Delegates rendering to render_links_list (imported from
* render_list_component_iri.js), which converts current_data into a
* DocumentFragment of anchor elements. The fragment is then appended to a
* wrapping <span> so that callers can treat the result as a single HTMLElement
* regardless of how many IRI links the cell contains.
*
* Expected current_data shape (passed through to render_links_list):
*   {
*     data             : Array<{iri: string, title: string}>,
*     fields_separator : string,   // optional
*     class_list       : string,   // optional
*   }
*
* @param {Object} current_data - server-supplied column descriptor for an IRI cell
* @param {string} [current_data.class_list=''] - CSS classes applied to the outer <span>
* @returns {HTMLElement} <span> element containing one or more anchor links
*/
export const get_iri_column = function(current_data) {

	const class_list = current_data.class_list || ''

	// DOM fragment
		const fragment = render_links_list(current_data)

	// column
		const column = ui.create_dom_element({
			element_type	: 'span',
			class_name		: class_list
		})
		column.appendChild(fragment)


	return column
}//end get_iri_column



// @license-end
