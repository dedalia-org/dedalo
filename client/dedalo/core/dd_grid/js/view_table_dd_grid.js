// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_label, page_globals, SHOW_DEBUG, DEDALO_CORE_URL*/
/*eslint no-undef: "error"*/



/**
* VIEW_TABLE_DD_GRID
* HTML <table> view for the dd_grid component.
*
* This module is the 'table' view variant selected by render_list_dd_grid when
* `self.view === 'table'`. It converts the server-produced nested data array
* (`self.data`) into a proper <thead>/<tbody> structure rendered as
* <tr>/<th>/<td> elements inside a <table> wrapper.
*
* Architecture:
* - view_table_dd_grid is a static-method namespace (it is never instantiated).
* - render_list_dd_grid.prototype.list() delegates here when view === 'table'.
* - Two public methods are exported on the constructor object:
*     view_table_dd_grid.render()     – produces the full <table> from self.data
*     view_table_dd_grid.render_row() – produces a DocumentFragment for one row
*       (used by callers that need to re-render individual rows incrementally).
* - All DOM creation goes through ui.create_dom_element() (from common/js/ui.js).
*   Never use document.createElement() directly.
*
* Data shape expected in self.data (server-produced):
*   Array<RowObject> where:
*     [0]  – the column-map row:
*             { value: Array<ColumnEntry> }
*             Each ColumnEntry: { ar_columns_obj: ColumnObject }
*             ColumnObject: { id, label, ar_labels?, ar_tipos? }
*     [1…] – data rows:
*             { row_count: number, value: Array<ColumnEntry> }
*             row_count > 1 when a portal contributes multiple sub-rows.
*
* Column cell_type values handled by get_table_columns():
*   'header'     → <th>  via render_header_column()
*   'av' | '3d'  → <td> with posterframe <img>  via render_av_column()
*   'img'        → <td> with full-size <img>     via render_img_column()
*   'button'     → <td> with lazily imported module action  via render_button_column()
*   'json'       → <td> with JSON.stringify()    via render_json_column()
*   'section_id' → <td> with raw id text         via render_section_id_column()
*   'iri'        → <td> with <a> links           via render_iri_column()
*   'text'       → <td> with joined string       via render_text_column() (default)
*
* Config flags read from self.config:
*   fill_the_gaps     {boolean} – if true, repeat the first portal row's data in
*                                 empty sub-rows; if false, emit an empty cell.
*   show_tipo_in_label {boolean} – if true, append " [tipo]" to header labels.
*   data_format        {string}  – when 'dedalo_raw', render_json_column() HTML-
*                                  encodes special characters so they display as
*                                  literal text in the cell, not as markup.
*
* Exports: view_table_dd_grid
*/

// imports
	import {ui} from '../../common/js/ui.js'
	import {render_value, render_join} from '../../common/js/utils/render_escape.js'
	import {clone} from '../../common/js/utils/index.js'


/**
* VIEW_TABLE_DD_GRID
* Constructor namespace for the table view of dd_grid.
* This function is never called as a constructor — its static methods
* (render, render_row) are invoked directly on the constructor object.
* @returns {boolean} Always returns true (placeholder body).
*/
export const view_table_dd_grid = function() {

	return true
}//end view_table_dd_grid



/**
* RENDER
* Build a full <table> DOM node from the dd_grid instance data.
*
* Reads `self.data` (the server-produced column map + row array), creates a
* <table> wrapper, delegates header row construction to get_table_nodes(), and
* appends the resulting DocumentFragment. The wrapper receives CSS classes that
* encode the component tipo, current mode, and active view so LESS/CSS can scope
* styles per context.
*
* @param {Object} self    - dd_grid instance; must expose .data, .tipo, .mode, .view, .config
* @param {Object} options - Render options (currently unused by this view but kept for API parity with other views)
* @returns {HTMLElement} wrapper - The <table> element ready to be appended to the DOM
*/
view_table_dd_grid.render = function(self, options) {

	// data
		const data = self.data

	// wrapper
		const wrapper = ui.create_dom_element({
			element_type	: 'table',
			class_name		: `wrapper_dd_grid ${self.tipo} ${self.mode} view_${self.view}`
		})

	// grid. Value as string
		const grid = get_table_nodes(self, data)
		wrapper.appendChild(grid)


	return wrapper
}//end render



/**
* RENDER_ROW
* Render a single data row (or the set of sub-rows derived from portal data).
*
* Delegates to get_portal_rows(), which handles both flat rows (row_count === 1)
* and multi-row portal expansions (row_count > 1). The caller is responsible for
* appending the returned fragment to the correct parent <tbody>/<table> node.
*
* @param {Object} self           - dd_grid instance; must expose .config
* @param {Object} row_data       - A single row object from self.data (index >= 1):
*                                  { row_count: number, value: Array<ColumnEntry> }
* @param {Array}  ar_columns_obj - The column-map array extracted from data[0]; used
*                                  to match each column entry to its header definition
* @returns {DocumentFragment} Fragment containing one or more <tr> elements
*/
view_table_dd_grid.render_row = function(self, row_data, ar_columns_obj) {
	return get_portal_rows(self, row_data, ar_columns_obj)
}



/**
* GET_TABLE_NODES
* Build the complete table structure (header row + all data rows) as a DocumentFragment.
*
* This is the core layout driver for the table view. It performs two passes over
* the server data:
*
* Pass 1 – Header:
*   Reads data[0].value (the column-map row) to produce <th> cells in a single
*   header <tr>. Each column entry may itself describe nested sub-columns; the
*   shape is handled by get_table_columns().
*
* Pass 2 – Data rows:
*   Iterates data[1…] and delegates each row to get_portal_rows(). A row with
*   row_count === N expands into N <tr> elements to flatten portal sub-records.
*
* Column map (ar_columns_obj):
*   Extracted from data[0].value as the array of ar_columns_obj objects. This
*   map is passed down to every row renderer so each cell can be matched to the
*   correct column definition, including columns synthesised from portal section_ids.
*
* Portal expansion note:
*   When the export has portals, some columns are "section_id columns" — they are
*   dynamically generated per locator, e.g. "profession", "profession|1", etc.
*   data[0] is the only row that always carries the full set of generated columns.
*
* @param {Object} self - dd_grid instance; must expose .config (fill_the_gaps, show_tipo_in_label, data_format)
* @param {Array}  data - Server-produced data array; data[0] is the column-map row; data[1…] are data rows
* @returns {DocumentFragment} Fragment containing one header <tr> and N data <tr> elements
*/
const get_table_nodes = function(self, data) {

	// the root node
		const fragment = new DocumentFragment()

	// First row;
	// get the columns form the first row of the data, it content the columns map with all columns calculated in the server for all data,
	// sometimes the columns are section_id columns, that is, some columns comes from rows inside portals, all rows below the main portal will be converted to section_id columns
	// some portals could have a information that other rows of the same portal doesn't has, ex: one interview, with two informants, every informant has different amount of professions,
	// every profession of every informant will create his own columns as: profession ; profession|1 ; etc
	// the first row has all columns, direct columns and calculated columns (from section_ids rows)
	// ar_columns_obj will be the map of the columns, used for create the header of the table and for extract the data and fill the empty values.
		const ar_columns		= data[0].value
		// const ar_columns_obj	= ar_columns.map(item => item.column_obj)
		const ar_columns_obj	= data[0].value.map(item => item.ar_columns_obj)

	// build the header
	// get every column to create the header of the table, get the node and add to the root node
		// tr row
		const row_header_node = render_row_container('row_header')
		fragment.appendChild(row_header_node)
		// td columns
		const ar_columns_len = ar_columns.length
		for (let i = 0; i < ar_columns_len; i++) {
			const column		= ar_columns[i]
			const column_nodes	= get_table_columns(self, column)
			const node_len		= column_nodes.length
			for (let j = 0; j < node_len; j++) {
				row_header_node.appendChild(column_nodes[j])
			}
		}

	// build the rows, row 0 are the columns that is not used here
	// get every row with data, the first row is the header, and it begins at 1 row to calculate the cells
	// the top row doesn't create node, because it will be created by the get_portal_rows() to be compatible between flat row or portal rows
		const data_len = data.length
		for (let i = 1; i < data_len; i++) {
			// the current row
			const row_data = data[i]
			const nodes = get_portal_rows(self, row_data, ar_columns_obj)
			fragment.appendChild(nodes)
		}


	return fragment
}//end get_table_nodes



/**
* GET_PORTAL_ROWS
* Expand a single data row into one or more <tr> elements, accounting for portal sub-rows.
*
* The server pre-calculates `row.row_count` — the total number of visual rows
* this record needs. When the record has no portals, row_count === 1 and a single
* <tr> is emitted. When the record has a first-level portal with N locators,
* row_count === N and N <tr> elements are emitted, each reading from the
* corresponding portal sub-row via the `row_key` index passed down to get_columns().
*
* Second-level portals (portals nested inside portals) do NOT generate additional
* rows — they are instead flattened into extra section_id columns in the column map.
*
* @param {Object} self           - dd_grid instance; must expose .config
* @param {Object} row            - A row descriptor from self.data:
*                                  { row_count: number, value: Array<ColumnEntry> }
* @param {Array}  ar_columns_obj - Column-map array from data[0]; see get_table_nodes()
* @returns {DocumentFragment} Fragment with row_count <tr> elements (each containing <td>/<th> cells)
*/
const get_portal_rows = function(self, row, ar_columns_obj) {

	const fragment = new DocumentFragment()

	// get the total rows will be created
	// the top row has the total rows that is collected for every component, in a portal has two locators and other portal has 5 locators the amount of rows will be 5
	const data_len = row.row_count

	for (let row_key = 0; row_key < data_len; row_key++) {

		// get the columns data
		const column_data = row.value
		// create the node
		const row_node = render_row_container()
		fragment.appendChild(row_node)
		// process the data column to get the cells
		const nodes = get_columns(self, column_data, ar_columns_obj, row_key)
		row_node.appendChild(nodes)
	}

	return fragment
}//end get_portal_rows



/**
* GET_COLUMNS
* Recursively resolve and render <td> cells for a set of columns, handling nested portal structures.
*
* This function is the most complex part of the table view. It walks the column map
* (ar_columns_obj) and matches each column definition against the actual cell data
* (column_data) using a pre-built O(1) index map, then dispatches to either:
*
*   a) get_table_columns() — when the column is a leaf cell (has a cell_type): emits <td>/<th>.
*   b) get_columns() recursively — when the column is a container (no cell_type):
*        i)  If its value contains 'row' entries: this is a first-level portal. The
*            row at index `parent_row_key` is selected, and get_columns() recurses
*            into its cells.
*       ii)  If its value contains non-'row' entries: this is a section_id column
*            (nested portal flattened to columns). get_columns() recurses directly
*            into that value array.
*
* Empty-cell handling:
*   When no data exists for a column in the index, a synthetic empty cell object is
*   constructed so the table always has the correct number of cells per row.
*
* Breakdown (multiple values in the same column):
*   When the index returns more than one data entry for a column (breakdown mode,
*   where every locator gets its own column), the values are merged into a single
*   array before rendering.
*
* fill_the_gaps behaviour (self.config.fill_the_gaps):
*   When a portal sub-row at `parent_row_key` does not exist:
*   - fill_the_gaps === false → emit an empty cell.
*   - fill_the_gaps === true  → repeat data from the first available sub-row
*     (sub_portal_values[0]), making spreadsheet copy-paste easier.
*
* Performance note:
*   The column index (Map<column_id, cell[]>) is built once per call in O(cells)
*   time, reducing the inner lookup from O(columns × cells) to O(1) per column.
*   This matters for grids with many columns and many rows.
*
* @param {Object} self           - dd_grid instance; must expose .config.fill_the_gaps
* @param {Array}  column_data    - Array of ColumnEntry objects for this row (or sub-row slice
*                                  during recursion); each entry has { ar_columns_obj, type, cell_type, value, class_list }
* @param {Array}  ar_columns_obj - Column-map definitions to iterate; each entry is a ColumnObject { id, … }
* @param {number} parent_row_key - Zero-based index into portal sub-rows; identifies which
*                                  portal locator is being rendered in the current <tr>
* @returns {DocumentFragment} Fragment of <td> (and/or <th>) elements for one table row
*/
const get_columns = function(self, column_data, ar_columns_obj, parent_row_key) {

	const fragment = new DocumentFragment()

	// fill the gaps
	// when data is breakdown, repeat the main section data in all portal rows
	// fill the data in main section for every portal row, it helps to manage data in spreadsheets
	const fill_the_gaps = self.config.fill_the_gaps

	// Build an index map: column_id -> [matching cells] for O(1) lookups per column
	// This replaces the O(columns × cells) filter+find pattern with O(cells) build + O(1) lookups
	const column_index = new Map();
	const column_data_len = column_data.length;
	for (let k = 0; k < column_data_len; k++) {
		const item = column_data[k];
		const item_cols = item.ar_columns_obj;
		const item_cols_len = item_cols.length;
		for (let m = 0; m < item_cols_len; m++) {
			const col_id = item_cols[m].id;
			let bucket = column_index.get(col_id);
			if (!bucket) {
				bucket = [];
				column_index.set(col_id, bucket);
			}
			bucket.push(item);
		}
	}

	// first we loop all map columns, independently of the data
	const column_len = ar_columns_obj.length
	for (let i = 0; i < column_len; i++) {
		// specify the current column to be filled
		const column = ar_columns_obj[i]
		// find the data of the column using the pre-built index
		const ar_column_values = column_index.get(column.id) || []
		// if the column has not data, create a empty column
		const column_value = (ar_column_values.length)
			? { ...ar_column_values[0], value: ar_column_values[0].value }
			: {
				ar_columns_obj	: [column],
				type			: 'column',
				cell_type		: 'text',
				value			: '',
				class_list		: 'empty_value'
			}
		// Get the column values and join they into a new value. Used by breakdown option to show every data of its own column
		// when the breakdown is selected, every data is a column with its own value, therefore is necessary join all values
		const ar_columns_values_len	= ar_column_values.length
		if(ar_columns_values_len>1){
			const ar_values = []
			for (let j = 0; j < ar_columns_values_len; j++) {
				const value = ar_column_values[j].value
				// set the value into the value array.
				// important, sometimes the value could be a object (because is a column inside a column)
				// therefore don't join the values, use the spread to assign the current value as is.
				if(Array.isArray(value)){
					ar_values.push(...value)
				}else{
					ar_values.push(value)
				}
			}
			column_value.value = ar_values
		}

		// if the column is the last column with data, identify by cell_type property, render the node
		if(column_value && column_value.type === 'column' && column_value.cell_type){

			const column_nodes = get_table_columns(self, column_value)
			const node_len = column_nodes.length
			for (let j = 0; j < node_len; j++) {
				fragment.appendChild(column_nodes[j])
			}
		// else if the column is a portal column, it could has rows (the portal rows) or could be colum_portal, that has the column with the information.
		// in the second case, the column of the portal, this column content the other components columns and if the sub component is a relation component it is created by the section_id in the portal
		}else if(column_value && column_value.type === 'column'){
			const sub_portal_values	= column_value.value

			// if the column has rows:
			// this case is the main portal in the section to export, sub-portals don't create rows
			if(sub_portal_values[0].type === 'row'){
				const current_ar_columns_obj = [column]
				// some times sub_values could be empty, because the rows_columns created by section_id could be empty between different rows, it depends of the data
				// if the data don't exist, create a empty node to be rendered
				const sub_values	= sub_portal_values[parent_row_key]
					? sub_portal_values[parent_row_key].value
					: (fill_the_gaps === false)
						? [{
								ar_columns_obj	: [{id:current_ar_columns_obj}],
								type			: 'column',
								cell_type		: 'text',
								value			: '',
								class_list		: 'empty_value'
							}]
						: sub_portal_values[0].value
							? sub_portal_values[0].value
							: [{
								ar_columns_obj	: [{id:current_ar_columns_obj}],
								type			: 'column',
								cell_type		: 'text',
								value			: '',
								class_list		: 'empty_value'
							}]

				const sub_portal_nodes = get_columns(self, sub_values, current_ar_columns_obj, parent_row_key)
				fragment.appendChild(sub_portal_nodes)

			// else, the column don't has rows and is section_id column (portal inside portal doesn't create rows, it only create columns)
			}else{
				const current_ar_columns_obj = [column]
				const sub_nodes = get_columns(self, sub_portal_values, current_ar_columns_obj, parent_row_key)
				fragment.appendChild(sub_nodes)
			}
		}
	}

	return fragment
}//end get_columns



/**
* GET_TABLE_COLUMNS
* Dispatch a column data object to the correct cell renderer and return an array of DOM nodes.
*
* Reads `current_data.type` and `current_data.cell_type` to decide which render
* function to call. If the data is missing or has no type, an empty text <td> is
* produced as a fallback so the table keeps its column alignment.
*
* cell_type dispatch table:
*   'header'     → render_header_column(self, current_data) → <th>
*   'av' | '3d'  → render_av_column(current_data)          → <td> with posterframe <img>
*   'img'        → render_img_column(current_data)          → <td> with full-size <img>
*   'button'     → render_button_column(current_data)       → <td> with async-loaded action <img>
*   'json'       → render_json_column(current_data, data_format) → <td> with JSON string
*   'section_id' → render_section_id_column(current_data)   → <td> with plain id value
*   'iri'        → render_iri_column(current_data)          → <td> with <a> links
*   'text' / *   → render_text_column(current_data)         → <td> with joined string (default)
*
* The returned array always contains exactly one element in the current implementation,
* but an array is returned for API flexibility (callers loop over it).
*
* @param {Object} self         - dd_grid instance; must expose .config.data_format
* @param {Object} current_data - ColumnEntry descriptor:
*                                { type, cell_type, value, class_list, ar_columns_obj, … }
* @returns {Array<HTMLElement>} Array of <td> or <th> elements (typically length 1)
*/
const get_table_columns = function(self, current_data) {

	const column_nodes = []

	const data_format = self.config.data_format || null

	if (current_data && current_data.type) {

		// column
			if(current_data.type==='column' && current_data.cell_type){

				switch(current_data.cell_type) {
					case 'header':
						column_nodes.push(
							render_header_column(self, current_data)
						)
						break;
					case 'av':
					case '3d':
						column_nodes.push(
							render_av_column(current_data)
						)
						break;

					case 'img':
						column_nodes.push(
							render_img_column(current_data)
						)
						break;

					case 'button':
						column_nodes.push(
							render_button_column(current_data)
						)
						break;

					case 'json':
						column_nodes.push(
							render_json_column(current_data, data_format)
						)
						break;

					case 'section_id':
						column_nodes.push(
							render_section_id_column(current_data)
						)
						break;

					case 'iri':
						column_nodes.push(
							render_iri_column(current_data)
						)
						break;

					case 'text':
					default:
						column_nodes.push(
							render_text_column(current_data)
						)
						break;
				}//end switch(current_data.cell_type)
			}//end if(current_data.type==='column' && current_data.cell_type)

	}else{

		const empty_data = {
			value : ''
		}
		const empty_node = render_text_column(empty_data)
		column_nodes.push(empty_node)
	}


	return column_nodes
}//end get_table_columns



/**
* RENDER_ROW_CONTAINER
* Create a bare <tr> element to serve as a table row container.
*
* Used for both the header row (class_name === 'row_header') and plain data rows
* (class_name === null, which ui.create_dom_element treats as no class attribute).
*
* @param {string|null} [class_name=null] - Optional CSS class to apply to the <tr>
* @returns {HTMLElement} A <tr> element (empty; cells are appended by the caller)
*/
const render_row_container = function(class_name=null) {

	const row_container = ui.create_dom_element({
		element_type	: 'tr',
		class_name		: class_name
	})

	return row_container
}//end render_row_container



/**
* RENDER_HEADER_COLUMN
* Create a <th> element for a table header cell from a column-map entry.
*
* The label is built from ar_labels, which is a flat array alternating between
* separator strings and label strings (odd indices are labels, even indices are
* separators — hence the `i % 2 !== 1` skip). Labels from different levels of
* the hierarchy are joined with ' | '.
*
* When self.config.show_tipo_in_label is true, each label is appended with the
* corresponding tipo identifier in brackets, e.g. "Name [oh1]". This is useful
* for developers inspecting exported data who need to trace columns back to
* component tipos.
*
* Fallback: if ar_labels is empty (dynamically added columns may lack it), the
* column's own .label property is used directly.
*
* @param {Object} self         - dd_grid instance; must expose .config.show_tipo_in_label
* @param {Object} current_data - ColumnEntry whose ar_columns_obj carries ar_labels and ar_tipos:
*                                { ar_columns_obj: { ar_labels: string[], ar_tipos: string[], label: string } }
* @returns {HTMLElement} A <th> element with the computed label as inner HTML
*/
const render_header_column = function(self, current_data) {

	const show_tipo_in_label = self.config.show_tipo_in_label || false

	const labels	= []
	const ar_labels = current_data.ar_columns_obj.ar_labels || []
	const len		= ar_labels.length
	for (let i = 0; i < len; i++) {
		if(i % 2 !== 1){
			continue
		}
		const current_label	= ar_labels[i] || ''
		const current_tipo	= (current_data.ar_columns_obj.ar_tipos && current_data.ar_columns_obj.ar_tipos[i]) || ''
		const label = (show_tipo_in_label === true)
			? current_label + " ["+current_tipo+"]"
			: current_label
		labels.push(label)
	}

	// fallback for dynamically added columns that don't have ar_labels
	if (labels.length === 0) {
		labels.push(current_data.ar_columns_obj.label || '')
	}

	const th_node = ui.create_dom_element({
		element_type	: 'th',
		inner_html		: render_join(labels, ' | ', 'text')
	})

	return th_node
}//end render_header_column



/**
* RENDER_TEXT_COLUMN
* Create a <td> element for a plain-text cell value.
*
* When `value` is an array, its items are joined with `records_separator`
* (default ' | ') before insertion. If the primary value is empty or absent,
* `fallback_value` is used instead (also joined if it is an array). This
* fallback mechanism supports "fill the gaps" scenarios where the server cannot
* guarantee a value is present for every visual row.
*
* The class_list defaults to 'text_column' but can be overridden per-column
* (e.g. 'empty_value' for synthesised empty cells).
*
* @param {Object} current_data - ColumnEntry:
*                                { value: string|Array<string>, fallback_value?: string|Array<string>,
*                                  class_list?: string, records_separator?: string }
* @returns {HTMLElement} A <td> element whose innerHTML is the resolved string value
*/
const render_text_column = function(current_data) {

	const class_list = current_data.class_list || 'text_column'

	const records_separator = (current_data.records_separator)
		? current_data.records_separator
		: ' | '

	const value = current_data.value && Array.isArray(current_data.value)
		? render_join(current_data.value, records_separator, current_data.render_class)
		: render_value(current_data.value, current_data.render_class)


	const fallback_value = current_data.fallback_value && Array.isArray(current_data.fallback_value)
		? render_join(current_data.fallback_value, records_separator, current_data.render_class)
		: render_value(current_data.fallback_value, current_data.render_class)

	const final_value = value && value.length>0
		? value
		: fallback_value

	const td_node = ui.create_dom_element({
		element_type	: 'td',
		class_name		: class_list,
		inner_html		: final_value
	})

	return td_node
}//end render_text_column



/**
* RENDER_AV_COLUMN
* Create a <td> element for a component_av (audio/video) or component_3d cell.
*
* Reads the posterframe URL from value[0].posterframe_url and renders a thumbnail
* <img> inside the <td>. If the image fails to load (e.g. the media file has not
* been processed yet), the error handler substitutes page_globals.fallback_image.
* The guard `image.src !== page_globals.fallback_image` prevents an infinite error
* loop if the fallback itself is unavailable.
*
* When value[0] is absent or posterframe_url is falsy, the <td> is returned empty.
*
* @param {Object} current_data - ColumnEntry:
*                                { value: Array<{ posterframe_url: string }>, class_list?: string }
* @returns {HTMLElement} A <td> element, optionally containing an <img> thumbnail
*/
const render_av_column = function(current_data) {

	const class_list = current_data.class_list || ''

	const td_node = ui.create_dom_element({
		element_type : 'td'
	})

	// image
		// url
		const posterframe_url = current_data.value[0]
			? current_data.value[0].posterframe_url
			: null
		const url = posterframe_url
		if (url) {
			// image
			const image = ui.create_dom_element({
				element_type	: 'img',
				class_name		: class_list,
				parent			: td_node
			})
			image.addEventListener('error', function(e) {
				if (image.src!==page_globals.fallback_image) {
					image.src = page_globals.fallback_image
				}
			})

			image.src = url
		}

	return td_node
}//end render_av_column



/**
* RENDER_IMG_COLUMN
* Create a <td> element for a component_image cell.
*
* Reads the image URL from value[0]. If the URL does not begin with 'http',
* window.location.origin is prepended so that relative server paths are resolved
* correctly in the current browser context. External URLs (e.g. IIIF manifests,
* Gallica, etc.) are used as-is to avoid incorrectly prepending the local origin.
*
* An error handler substitutes page_globals.fallback_image on load failure,
* with the same infinite-loop guard as render_av_column().
*
* When value[0] is falsy, the <td> is returned empty.
*
* @param {Object} current_data - ColumnEntry:
*                                { value: Array<string>, class_list?: string }
*                                value[0] is the image URL (relative or absolute)
* @returns {HTMLElement} A <td> element, optionally containing an <img> element
*/
const render_img_column = function(current_data) {

	const class_list = current_data.class_list || ''

	// td_node
		const td_node = ui.create_dom_element({
			element_type : 'td'
		})

	// image
		const url = current_data.value[0]
		if (url) {

			// append current domain and protocol only in local images, excluding
			// external like 'https://gallica.bnf.fr/ark:/12148/btv1b8498948z/f1.highres'
			const full_url = url.indexOf('http')===0
				? url
				: window.location.origin + url

			// image
				const image = ui.create_dom_element({
					element_type	: 'img',
					class_name		: class_list,
					parent			: td_node
				})
				image.addEventListener('error', function(e) {
					if (image.src!==page_globals.fallback_image) {
						image.src = page_globals.fallback_image
					}
				})

				image.src = full_url
		}


	return td_node
}//end render_img_column



/**
* RENDER_BUTTON_COLUMN
* Create a <td> element for a server-defined action button (rendered as an <img>).
*
* The button descriptor lives in value[0] and carries an `action` object:
*   { event: string, module_path: string, method: string, options: Object }
*
* The event handler is wired up as an async listener that dynamically imports
* `module_path` at click time (lazy loading). The invoked method receives the
* merged options object augmented with `button_caller` pointing to the clicked
* element, so the action can position UI elements relative to the trigger.
*
* (!) The <img> element is created unconditionally even when value[0] has no src
* attribute, which may produce a broken-image icon. The action itself is only
* wired when value.action.event is truthy.
*
* @param {Object} current_data - ColumnEntry:
*                                { value: Array<{ class_list?: string,
*                                    action?: { event: string, module_path: string,
*                                               method: string, options: Object } }> }
* @returns {HTMLElement} A <td> element containing the button <img>
*/
const render_button_column = function(current_data) {

	const value			= current_data.value[0]
	const class_list	= value.class_list || ''

	const td_node = ui.create_dom_element({
		element_type : 'td'
	})

	// image
		const button = ui.create_dom_element({
			element_type	: 'img',
			// a11y: an icon-only action — its name is the server's button label
			alt				: value.label ?? '',
			class_name		: class_list,
			parent			: td_node
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

	return td_node
}//end render_button_column



/**
* RENDER_JSON_COLUMN
* Create a <td> element for a component_json cell, with optional HTML-entity encoding.
*
* Serialises the value to a JSON string with JSON.stringify(). When data_format is
* 'dedalo_raw', all characters outside the printable ASCII range (code points
*  –香) as well as '<', '>', and '&' are replaced with their HTML numeric
* character references (&#N;). This ensures the raw JSON is displayed as literal
* text in the table cell without the browser interpreting it as markup — important
* for export views where the cell content is later scraped or clipboard-copied.
*
* When the value is empty (null, undefined, or empty array), an empty string is used.
*
* @param {Object}      current_data - ColumnEntry: { value: *|Array, class_list?: string }
* @param {string|null} data_format  - Optional format hint; 'dedalo_raw' triggers HTML encoding
* @returns {HTMLElement} A <td> element whose innerHTML is the (optionally encoded) JSON string
*/
const render_json_column = function(current_data, data_format) {

	const class_list = current_data.class_list || ''

	// stringify value
		const string_value = (!current_data.value || (Array.isArray(current_data.value) && !current_data.value.length))
			? ''
			: JSON.stringify(current_data.value)

	// value
	// A JSON string is text in every format: the render-boundary escaper encodes
	// the HTML characters so the browser never parses it ('dedalo_raw' used to
	// carry its own entity encoder here — same outcome, one escaper).
		const value = render_value(string_value, 'text')

	const td_node = ui.create_dom_element({
		element_type	: 'td',
		class_name		: class_list,
		inner_html		: value
	})

	return td_node
}//end render_json_column



/**
* RENDER_SECTION_ID_COLUMN
* Create a <td> element for a component_section_id cell.
*
* Outputs the raw section id value (typically a numeric string) directly as
* innerHTML. No formatting or linking is applied — the id is presented as-is
* for use in export/spreadsheet contexts where raw ids are required.
*
* @param {Object} current_data - ColumnEntry: { value: string|number, class_list?: string }
* @returns {HTMLElement} A <td> element whose innerHTML is the section id value
*/
const render_section_id_column = function(current_data) {

	const class_list = current_data.class_list || ''

	const td_node = ui.create_dom_element({
		element_type	: 'td',
		class_name		: class_list,
		inner_html		: render_value(current_data.value, 'number')
	})

	return td_node
}//end render_section_id_column



/**
* RENDER_IRI_COLUMN
* Create a <td> element for a component_iri cell, rendered as a list of hyperlinks.
*
* Each item in current_data.data produces an <a> element linking to item.iri.
* The link text is item.title when present, otherwise item.iri itself is used
* as a self-descriptive label. Links open in a new tab (_blank) and carry
* rel="noopener noreferrer" (SEC-033) to prevent reverse-tabnapping attacks.
*
* Items are separated by the records_separator string (default ' | ') inserted
* as text nodes between <a> elements. No separator is appended after the last item.
*
* Note: current_data.value is present but not used here; the canonical data is
* in current_data.data which carries the full IRI descriptor objects.
*
* @param {Object} current_data - ColumnEntry:
*                                { data: Array<{ iri: string, title?: string }>,
*                                  class_list?: string, records_separator?: string }
* @returns {HTMLElement} A <td> element containing zero or more <a> link elements
*/
const render_iri_column = function(current_data) {

	const class_list		= current_data.class_list || ''
	const records_separator	= current_data.records_separator || ' | '

	// td_node
		const td_node = ui.create_dom_element({
			element_type	: 'td',
			class_name		: class_list
		})

	//  links
		const data			= current_data.data || []
		const ar_final		= []
		const data_length	= data.length
		for (let i = 0; i < data_length; i++) {
			const item = data[i]
			const node = ui.create_dom_element({
				element_type	: 'a',
				href			: item.iri,
				inner_html		: render_value(item.title, 'text') || render_value(item.iri, 'url'),
				parent			: td_node
			})
			node.target = '_blank'
			node.rel    = 'noopener noreferrer' // SEC-033

			// space
			if (i < data_length-1) {
				td_node.appendChild( document.createTextNode( records_separator ) );
			}
		}


	return td_node
}//end render_iri_column



// @license-end
