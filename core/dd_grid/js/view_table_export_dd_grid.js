// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_label, page_globals, SHOW_DEBUG, DEDALO_CORE_URL*/
/*eslint no-undef: "error"*/



// imports
	import {ui} from '../../common/js/ui.js'
	import {clone} from '../../common/js/utils/index.js'



/**
* VIEW_TABLE_EXPORT_DD_GRID
* Manage the components logic and appearance in client side
*/
export const view_table_export_dd_grid = function() {

	return true
}//end view_table_export_dd_grid



/**
* RENDER
* Render node for use in table
* @param object self
* @param object options
* @return HTMLElement wrapper
*/
view_table_export_dd_grid.render = function(self, options) {

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
* GET_TABLE_NODES
* @param object self
* @param array data
* 	array of objects; full data sent by the server with all information.
* @return DocumentFragment
* 	DOM node with the table
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
* This method calculate the rows when the main row has sub rows that comes from portals
* sometime the row don't has portal information, but the calculation will be the same, because
* the server use a row_count to identify the amount rows that will be necessary to build
* if the row don't has portals the row_count will be 1, if has portals have multiple locators,
* the row_count will be the total locators of the first level, sub-levels of information are
* calculated as section_id columns
* @param object self
* 	dd_grid instance
* @param object row
* 	array of objects; all information of the row, the main row
* @param array ar_columns_object
* 	array of object; the column map with all columns to be matched with the data
* @return DocumentFragment
*	wWith the tr of the table
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
*
* @param object self
* @param array column_data
* 	array of objects; full data with the columns to be processed, in the recursion it could be a part of this data to be processed
* @param array ar_columns_object
* 	array of object; the column map with all columns to be matched with the data
* @param int parent_row_key
* the current position of the row to be used to match with the portal data
* the columns has the information of the components
* is the component is a final component it will create a node
* if the component is a relation component, portals, it could has other rows or portal columns with "sub-columns" of the final components
* in the case of column has rows, extract the row with parent_row_key and star again
* in the case of the column of a portal, extract his value and star again
* @return DocumentFragment
* 	with the td of the table
*/
const get_columns = function(self, column_data, ar_columns_obj, parent_row_key) {

	const fragment = new DocumentFragment()

	// fill the gaps
	// when data is breakdown, repeat the main section data in all portal rows
	// fill the data in main section for every portal row, it helps to manage data in spreadsheets
	const fill_the_gaps = self.config.fill_the_gaps

	// first we loop all map columns, independently of the data
	const column_len	= ar_columns_obj.length
	for (let i = 0; i < column_len; i++) {
		// specify the current column to be filled
		const column = ar_columns_obj[i]
		// find the data of the column
		// Breakdown option get every column data in different columns_objecs, therefore use a filter instead a find to get all.
		const ar_column_values = column_data.filter(item => item.ar_columns_obj.find(el => el.id === column.id))
			? column_data.filter(item => item.ar_columns_obj.find(el => el.id === column.id))
			: null
		// if the column has not data, create a empty column
		const column_value = (ar_column_values.length)
			? clone( ar_column_values[0] )
			: {
				ar_columns_obj	: [column],
				type			: 'column',
				cell_type		: 'text',
				value			: '',
				class_list		: 'empty_value'
			}
		// Get the column values and join they into a new value. Used by breakdown option to show every data of its own column
		// when the breakdown is selected, every data is a column with its own value, therefore is necessary join all values
		const ar_columns_values_len	= ar_column_values?.length || 0
		if(ar_columns_values_len>1){
			const ar_values = []
			for (let j = 0; j < ar_columns_values_len; j++) {
				// empty value of this locator: use its own fallback value, not the first one
				const value = is_empty_value(ar_column_values[j].value) && !is_empty_value(ar_column_values[j].fallback_value)
					? ar_column_values[j].fallback_value
					: ar_column_values[j].value
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
* Use the column_data to create the right node
* @param object self
* @param object current_data
* the full column data
* @return array column_nodes
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
* Render table tr node as row container
* @param string class_name = null
* @return HTMLElement row_container
* table tr node
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
* Render table th element for a label
* @param object self
* @param object current_data
* @return HTMLElement th_node
* table th element
*/
const render_header_column = function(self, current_data) {

	const show_tipo_in_label = self.config.show_tipo_in_label || false

	const labels	= []
	const len		= current_data.ar_columns_obj.ar_labels.length
	for (let i = 0; i < len; i++) {
		if(i % 2 !== 1){
			continue
		}
		const current_label	= current_data.ar_columns_obj.ar_labels[i] || ''
		const current_tipo	= current_data.ar_columns_obj.ar_tipos[i]  || ''
		const label = (show_tipo_in_label === true)
			? current_label + " ["+current_tipo+"]"
			: current_label
		labels.push(label)
	}

	const th_node = ui.create_dom_element({
		element_type	: 'th',
		inner_html		: labels.join(' | ')
	})

	return th_node
}//end render_header_column



/**
* IS_EMPTY_VALUE
* Check if a cell value has no data (null, empty string or empty array)
* @param mixed value
* @return bool
*/
const is_empty_value = function(value) {
	return value===undefined || value===null || value==='' || (Array.isArray(value) && value.length===0)
}//end is_empty_value



/**
* RENDER_TEXT_COLUMN
* Render table td node for a text value
* @param object current_data
* @return HTMLElement td_node
*/
const render_text_column = function(current_data) {

	const class_list = current_data.class_list || 'text_column'

	const records_separator = (current_data.records_separator)
		? current_data.records_separator
		: ' | '

	const value = current_data.value && Array.isArray(current_data.value)
		? current_data.value.join(records_separator)
		: (current_data.value)


	const fallback_value = current_data.fallback_value && Array.isArray(current_data.fallback_value)
		? current_data.fallback_value.join(records_separator)
		: (current_data.fallback_value || '')

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
* Render table td node for a component_av value
* @param object current_data
* @return HTMLElement td_node
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

	// const td_node = ui.create_dom_element({
	// 	element_type	: 'td',
	// 	class_name		: class_list,
	// 	inner_html		: final_value
	// })

	return td_node
}//end render_av_column



/**
* RENDER_IMG_COLUMN
* Render table td node for a component_image value
* @param object current_data
* @return HTMLElement td_node
*/
const render_img_column = function(current_data) {

	const class_list = current_data.class_list || ''

	// image url
		const url = current_data.value[0]

	// append current domain and protocol only in local images, excluding
	// external like 'https://gallica.bnf.fr/ark:/12148/btv1b8498948z/f1.highres'
		const final_value = (!url)
			? null
			: url.indexOf('http')===0
				? url
				: window.location.origin + url

	// td_node
		const td_node = ui.create_dom_element({
			element_type	: 'td',
			class_name		: class_list,
			inner_html		: final_value || ''
		})


	return td_node
}//end render_img_column



/**
* RENDER_BUTTON_COLUMN
* Render table td node for a button value
* @param object current_data
* @return HTMLElement td_node
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
* Render table td node for a component_json value
* @param object current_data
* @param string|null data_format
* 	Like 'dedalo_raw'
* @return HTMLElement td_node
*/
const render_json_column = function(current_data, data_format) {

	const class_list = current_data.class_list || ''

	// stringify value
		const string_value = (!current_data.value || (Array.isArray(current_data.value) && !current_data.value.length))
			? ''
			: JSON.stringify(current_data.value)

	// value
	// if data_format is passed and is 'dedalo_raw', encode the HTML characters to prevent the browser from rendering it
		const value = data_format && data_format==='dedalo_raw'
			? string_value.replace(/[\u00A0-\u9999<>\&]/gim, (i) => {
				return '&#' + i.charCodeAt(0) + ';';
			  })
			: string_value

	const td_node = ui.create_dom_element({
		element_type	: 'td',
		class_name		: class_list,
		inner_html		: value
	})

	return td_node
}//end render_json_column



/**
* RENDER_SECTION_ID_COLUMN
* Render table td node for a component_section_id value
* @param object current_data
* @return HTMLElement td_node
*/
const render_section_id_column = function(current_data) {

	const class_list = current_data.class_list || ''

	const td_node = ui.create_dom_element({
		element_type	: 'td',
		class_name		: class_list,
		inner_html		: current_data.value
	})

	return td_node
}//end render_section_id_column



/**
* RENDER_IRI_COLUMN
* Render table td node for a component_iri value
* @param object current_data
* @return HTMLElement td_node
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
				inner_html		: item.title || item.iri,
				parent			: td_node
			})
			node.target = '_blank'

			// space
			if (i < data_length-1) {
				td_node.appendChild( document.createTextNode( records_separator ) );
			}
		}


	return td_node
}//end render_iri_column



// @license-end
