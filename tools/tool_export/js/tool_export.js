// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global page_globals*/
/*eslint no-undef: "error"*/



// import
	import {clone} from '../../../core/common/js/utils/index.js'
	import {data_manager, get_api_url} from '../../../core/common/js/data_manager.js'
	import {common, create_source} from '../../../core/common/js/common.js'
	import {get_instance} from '../../../core/common/js/instances.js'
	import {tool_common} from '../../tool_common/js/tool_common.js'
	import {view_csv_dd_grid} from '../../../core/dd_grid/js/view_csv_dd_grid.js'
	import {view_tsv_dd_grid} from '../../../core/dd_grid/js/view_tsv_dd_grid.js'
	import {render_tool_export} from './render_tool_export.js'
	import {
		on_dragstart,
		// on_dragend,
		on_dragover,
		on_dragleave,
		on_drop
	} from './drag_tool_export.js'



/**
* TOOL_EXPORT
* Tool to export data from sections
*/
export const tool_export = function () {

	this.id					= null
	this.model				= null
	this.mode				= null
	this.node				= null
	this.ar_instances		= null
	this.status				= null
	this.events_tokens		= []
	this.type				= null
	this.source_lang		= null
	this.caller				= null // section or component
	this.components_list	= {}
	this.data_format		= null
	// media_components. Set of grid data existing media components (used to export media)
	// e.g. new Set(['component_image']);
	this.media_components	= new Set([
		'component_3d',
		'component_av',
		'component_image',
		'component_pdf',
		'component_svg'
	]);
	// media_components_in_data. Array of media components in data (used to export media)
	this.media_components_in_data = [];
}//end tool_export



/**
* COMMON FUNCTIONS
* extend component functions from component common
*/
// prototypes assign
	tool_export.prototype.render						= tool_common.prototype.render
	tool_export.prototype.destroy						= common.prototype.destroy
	tool_export.prototype.refresh						= common.prototype.refresh
	tool_export.prototype.edit							= render_tool_export.prototype.edit
	tool_export.prototype.build_export_component		= render_tool_export.prototype.build_export_component
	// get and render list of components from common
	tool_export.prototype.get_section_elements_context	= common.prototype.get_section_elements_context
	tool_export.prototype.calculate_component_path		= common.prototype.calculate_component_path
	// drag
	tool_export.prototype.on_dragstart					= on_dragstart
	tool_export.prototype.on_dragover					= on_dragover
	tool_export.prototype.on_dragleave					= on_dragleave
	tool_export.prototype.on_drop						= on_drop



/**
* INIT
*
* @param object options
* Sample:
* {
*	lang: "lg-eng"
*	mode: "edit"
*	model: "tool_export"
*	section_id: "1"
*	section_tipo: "rsc167"
*	tipo: "rsc36"
*	tool_config: {section_id: "2", section_tipo: "dd1324", name: "tool_export", label: "Tool Indexation", icon: "/v6/tools/tool_export/img/icon.svg", …}
* }
* @return bool common_init
*/
tool_export.prototype.init = async function(options) {

	const self = this

	// call the generic common tool init
	const common_init = await tool_common.prototype.init.call(this, options);

	try {

		// build the section that call, it's necessary to build the rqo
			if (!self.caller || typeof self.caller.build!=='function') {
				throw new Error("Caller build is not available.");
			}
			await self.caller.build(true)

		// set the self specific vars not defined by the generic init (in tool_common)
			self.lang	= options.lang // from page_globals.dedalo_data_lang
			self.langs	= page_globals.dedalo_projects_default_langs

		// short vars
			self.events_tokens			= []
			self.parent_node			= null
			self.components_list		= {}
			self.ar_instances			= []
			self.source					= self.caller.rqo.source
			self.sqo					= self.caller.rqo.sqo
			self.target_section_tipo	= self.sqo.section_tipo // can be different to section_tipo
			self.limit					= self.sqo.limit ?? 10
			self.ar_ddo_to_export		= []

			// const load_promise = import('../../../lib/sheetjs/dist/xlsx.full.min.js')
			// await common.prototype.load_script(DEDALO_ROOT_WEB + '/lib/sheetjs/dist/xlsx.full.min.js')
	} catch (error) {
		self.error = error
		console.error(error)
	}


	return common_init
}//end init



/**
* BUILD
* @param bool autoload = false
* @return bool common_build
*/
tool_export.prototype.build = async function(autoload=false) {

	const self = this

	// call generic common tool build
		const common_build = await tool_common.prototype.build.call(this, autoload);

	try {

		// nothing to do here

	} catch (error) {
		self.error = error
		console.error(error)
	}


	return common_build
}//end build_custom



/**
* GET_SECTION_ID
* @return string
* 	as 'tmp_export_1'
*/
tool_export.prototype.get_section_id = function() {

	const self		= this
	self.section_id	= ++self.section_id

	return 'tmp_export_' + self.section_id
}//end get_section_id



/**
* EXPORT_PAGE_SIZE
* Records requested per API page. Each page is one request, so the server memory is released per page.
* The tool URL can override it with ?export_page_size=N (used to test the page merge)
*/
const EXPORT_PAGE_SIZE = 1000

/**
* PREVIEW_ROWS
* Records rendered in the DOM. The full export is never rendered as a whole
*/
const PREVIEW_ROWS = 200


/**
* GET_EXPORT_PAGE_SIZE
* @return int page_size
*/
const get_export_page_size = function() {

	const param	= new URLSearchParams(window.location.search).get('export_page_size')
	const size	= parseInt(param, 10)

	return size > 0 ? size : EXPORT_PAGE_SIZE
}//end get_export_page_size



/**
* MERGE_EXPORT_HEADER
* Adds to the merged header the columns of one page that the previous pages do not have.
* Same position rule as the server (tool_export::build_export_grid): a locator column (id with '|')
* goes after the last column of its group, else at the end
* @param object|null merged
* 	header row (type row, value: header cells) merged from the previous pages
* @param object page_header
* 	header row of the page
* @return object merged
*/
const merge_export_header = function(merged, page_header) {

	// first page: copy the header row. The cells are kept as they come
	if (merged === null) {
		return {
			...page_header,
			value : [...page_header.value]
		}
	}

	const cells = merged.value

	for (const cell of page_header.value) {

		const column = cell.ar_columns_obj

		// already in the merged header
		const exists = cells.some(item => item.ar_columns_obj.id === column.id)
		if (exists) {
			continue
		}

		// position
		let position = cells.length
		if (column.id.indexOf('|') !== -1 && column.group !== undefined) {
			let last_group_index = -1
			cells.forEach((item, index) => {
				if (item.ar_columns_obj.group === column.group) {
					last_group_index = index
				}
			})
			if (last_group_index > 0) {
				position = last_group_index + 1
			}
		}

		cells.splice(position, 0, cell)
	}

	merged.column_count = cells.length

	return merged
}//end merge_export_header



/**
* PARSE_CSV_TEXT
* Parses the text built by the csv/tsv views (every cell quoted, '""' is a quote)
* @param string text
* @param string column_separator
* @return array rows of arrays of strings
*/
const parse_csv_text = function(text, column_separator) {

	const rows		= []
	let row			= []
	let cell		= ''
	let in_quotes	= false

	for (let i = 0; i < text.length; i++) {

		const char = text[i]

		if (in_quotes) {
			if (char === '"') {
				if (text[i+1] === '"') {
					cell += '"'
					i++
				}else{
					in_quotes = false
				}
			}else{
				cell += char
			}
		}else if (char === '"') {
			in_quotes = true
		}else if (char === column_separator) {
			row.push(cell)
			cell = ''
		}else if (char === '\n') {
			row.push(cell)
			rows.push(row)
			row		= []
			cell	= ''
		}else if (char !== '\r') {
			cell += char
		}
	}

	// last row without trailing new line
	if (cell !== '' || row.length > 0) {
		row.push(cell)
		rows.push(row)
	}

	return rows
}//end parse_csv_text



/**
* ESCAPE_HTML
* @param string value
* @return string
*/
const escape_html = function(value) {

	return String(value)
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;')
}//end escape_html



/**
* GET_EXPORT_GRID
* Fetches the export page by page (one API request per page).
* Each page is kept as a JSON Blob, so only one page of rows is in memory at a time.
* The grid of the tool (preview) only receives the first PREVIEW_ROWS records.
* @param object options
* @return dd_grid
*/
tool_export.prototype.get_export_grid = async function(options) {

	const self = this

	// options
		const data_format			= options.data_format
		const view					= options.view || 'table'
		const show_tipo_in_label	= options.show_tipo_in_label
		const fill_the_gaps			= options.fill_the_gaps

	// pages. The header is merged across pages (a column can appear in a later page)
		const page_size		= get_export_page_size()
		const preview_rows	= []
		self.export_pages	= []
		self.export_header	= null
		self.export_records	= 0
		let offset			= 0
		while (true) {

			const page = await self.fetch_export_page(options, offset, page_size)

			self.export_header = merge_export_header(self.export_header, page.header)
			self.export_pages.push(
				new Blob([JSON.stringify(page.rows)], {type:'application/json'})
			)
			self.export_records += page.rows.length

			// preview. Only the first records are rendered
			if (preview_rows.length < PREVIEW_ROWS) {
				preview_rows.push(...page.rows.slice(0, PREVIEW_ROWS - preview_rows.length))
			}

			// last page: the whole result came in one response, or the page is not full
			if (!page.paged || page.rows.length < page_size) {
				break
			}
			offset += page_size
		}

	// preview data
		const preview_data = [self.export_header, ...preview_rows]

	// already exists dd_grid case. Returns it
		if (self.dd_grid) {
			// inject data
			self.dd_grid.data = preview_data
			// reset view
			self.dd_grid.view = view
			// reset show_tipo_in_label
			self.dd_grid.config.show_tipo_in_label = show_tipo_in_label
			// reset fill_the_gaps
			self.dd_grid.config.fill_the_gaps = fill_the_gaps
			// reset data_format
			self.dd_grid.config.data_format = data_format
			// build
			await self.dd_grid.build(false)
			// reset node
			self.dd_grid.node = null

			// return instance ready to render
			return self.dd_grid
		}

	// dd_grid. Init the dd_grid instance if it isn't already
		const dd_grid = self.dd_grid || await get_instance({
			model				: 'dd_grid',
			section_tipo		: self.caller.section_tipo,
			tipo				: self.caller.section_tipo,
			mode				: 'list',
			view				: view, // 'table',
			config				: {
				show_tipo_in_label	: show_tipo_in_label, // true of false
				fill_the_gaps		: fill_the_gaps, // true of false
				data_format			: data_format // like 'dedalo_raw'
			},
			lang				: page_globals.dedalo_data_lang,
			data				: preview_data
		})

		// build. Do not autoload
			await dd_grid.build(false)

		// fix dd_grid
			self.dd_grid = dd_grid

		// ar_instances. Add current dd_grid instance. (Will be removed on destroy)
			self.ar_instances.push(dd_grid)


	return dd_grid
}//end get_export_grid



/**
* FETCH_EXPORT_PAGE
* One streamed API request: lines {t:'row', row} per record, then one {t:'end', header, paged}.
* Not data_manager.request (it parses one JSON document)
* @param object options
* @param int offset
* @param int limit
* @return object {header, rows, paged}
*/
tool_export.prototype.fetch_export_page = async function(options, offset, limit) {

	const self = this

	// options
		const data_format			= options.data_format
		const ar_ddo_to_export		= options.ar_ddo_to_export

	// sqo. The page of the search (the server keeps the sqo order)
		const sqo = clone(self.sqo)
		sqo.limit	= limit
		sqo.offset	= offset

	// source. Note that second argument is the name of the function to manage the tool request like 'get_export_grid'
	// this generates a call as my_tool_name::my_function_name(options)
		const source = create_source(self, 'get_export_grid')

	// API request
		const rqo = {
			dd_api			: 'dd_tools_api',
			action			: 'tool_request',
			source			: source,
			prevent_lock	: true, // close session to unlock the browser and allow to abort
			options			: {
				section_tipo		: self.caller.section_tipo, // section that call to the tool, it will be used to get the records from db
				model				: self.caller.model,
				data_format			: data_format, // format selected by the user to get data
				ar_ddo_to_export	: ar_ddo_to_export, // array with the ddo map and paths to get the info
				sqo					: sqo,
				ndjson_stream		: true // server streams the grid as NDJSON lines
			}
		}
		if (page_globals.recovery_mode) {
			rqo.recovery_mode = true
		}

		const response = await fetch(get_api_url(), {
			method		: 'POST',
			mode		: 'cors',
			cache		: 'no-cache',
			credentials	: 'same-origin',
			headers		: {'Content-Type': 'application/json'},
			redirect	: 'follow',
			referrer	: 'no-referrer',
			body		: JSON.stringify(rqo)
		})
		if (!response.ok) {
			console.error('Error:', `HTTP error! status: ${response.status}`);
			throw new Error(`HTTP error! status: ${response.status}`);
		}

		const reader	= response.body.getReader()
		const decoder	= new TextDecoder()
		const rows		= []
		let header		= null
		let paged		= false
		let buffer		= ''

		const handle_line = (line) => {
			if (!line.trim()) {
				return
			}
			const frame = JSON.parse(line)
			// pre-stream error envelope from the API (no 't' field)
			if (frame.t === undefined) {
				throw new Error(frame.msg || 'Unknown error on API tool_request')
			}
			if (frame.t === 'row') {
				rows.push(frame.row)
			}else if (frame.t === 'end') {
				header	= frame.header
				paged	= frame.paged === true
			}
		}//end handle_line

		while (true) {
			const { value, done } = await reader.read()
			if (done) {
				break
			}
			buffer += decoder.decode(value, { stream: true })
			const lines = buffer.split('\n')
			buffer = lines.pop()
			for (const line of lines) {
				handle_line(line)
			}
		}

		// flush decoder and last line without trailing newline
		buffer += decoder.decode()
		for (const line of buffer.split('\n')) {
			handle_line(line)
		}

		if (header === null) {
			console.error('Error:', 'export stream truncated');
			throw new Error('export stream truncated');
		}

	return { header, rows, paged }
}//end fetch_export_page



/**
* RENDER_EXPORT_VIEW
* Calls the csv or tsv view render directly and returns its text.
* dd_grid.render() can return the node of a previous view (status 'rendered'), the view itself
* always builds the text of the data given
* @param string view
* @param dd_grid dd_grid
* @param array data
* @return string
*/
const render_export_view = function(view, dd_grid, data) {

	dd_grid.data = data
	const view_module = view==='tsv' ? view_tsv_dd_grid : view_csv_dd_grid

	return view_module.render(dd_grid)
}//end render_export_view



/**
* RENDER_EXPORT_PAGES
* Calls the callback with the text built by the dd_grid view for every stored page.
* The text includes the header (first line); header_text is the header alone.
* Only one page is in memory at a time. The preview data is restored at the end
* @param string view
* 	csv|tsv|table_export
* @param function callback
* 	(text, page_index, rows_count, header_text)
* @return void
*/
tool_export.prototype.render_export_pages = async function(view, callback) {

	const self		= this
	const dd_grid	= self.dd_grid
	const preview	= { data: dd_grid.data, view: dd_grid.view }

	try {
		// header alone
		const header_text = render_export_view(view, dd_grid, [self.export_header])

		for (let i = 0; i < self.export_pages.length; i++) {

			const rows = JSON.parse(await self.export_pages[i].text())

			const text = render_export_view(view, dd_grid, [self.export_header, ...rows])

			await callback(text, i, rows.length, header_text)
		}
	} finally {
		// restore the preview
		dd_grid.data = preview.data
		dd_grid.view = preview.view
	}
}//end render_export_pages



/**
* EXPORT_TEXT_BLOB
* Builds the csv or tsv file page by page: header once, then the rows of every page
* @param string view
* 	csv|tsv
* @return Blob
*/
tool_export.prototype.export_text_blob = async function(view) {

	const self			= this
	const row_separator	= self.dd_grid.row_separator || '\n'
	const mime			= view==='csv' ? 'text/csv;charset=utf-8' : 'text/tab-separated-values;charset=utf-8'
	const parts			= []

	await self.render_export_pages(view, (text, index, rows_count, header_text) => {
		if (index === 0) {
			parts.push(header_text)
		}
		if (rows_count > 0) {
			// text = header_text + row_separator + body of the page
			parts.push(row_separator + text.slice(header_text.length + row_separator.length))
		}
	})

	return new Blob(parts, {type: mime})
}//end export_text_blob



/**
* EXPORT_WORKBOOK
* Builds the xlsx or ods file from the csv view of every page (no DOM table)
* @param string book_type
* 	xlsx|ods
* @param string file_name
* @return void
*/
tool_export.prototype.export_workbook = async function(book_type, file_name) {

	const self				= this
	// the separator of the csv view (set by its render). Fixed here: dd_grid.column_separator
	// is changed by the last view rendered (tsv sets a tab), so it can't be read before the render
	const column_separator	= ';'

	// library. Dynamically imported when the button is used
	const XLSX = await import( DEDALO_ROOT_WEB+"/lib/xlsx/build/xlsx.js" );

	let sheet = null

	await self.render_export_pages('csv', (text, index) => {
		const arrays = parse_csv_text(text, column_separator)
		// the header is only in the first sheet rows
		if (index > 0) {
			arrays.shift()
		}
		if (sheet === null) {
			sheet = XLSX.utils.aoa_to_sheet(arrays)
		}else if (arrays.length > 0) {
			XLSX.utils.sheet_add_aoa(sheet, arrays, {origin: -1})
		}
	})

	const workbook = XLSX.utils.book_new()
	XLSX.utils.book_append_sheet(workbook, sheet, 'Sheet1')

	// Export the workbook to file
	XLSX.writeFile(workbook, file_name, {bookType: book_type})
}//end export_workbook



/**
* EXPORT_HTML_BLOB
* Builds the html file from the csv view of every page (no DOM table)
* @return Blob
*/
tool_export.prototype.export_html_blob = async function() {

	const self				= this
	// the separator of the csv view (set by its render). Fixed here: dd_grid.column_separator
	// is changed by the last view rendered (tsv sets a tab), so it can't be read before the render
	const column_separator	= ';'

	let header_html	= ''
	const body		= []

	await self.render_export_pages('csv', (text, index) => {
		const arrays = parse_csv_text(text, column_separator)
		const header = arrays.shift()
		if (index === 0) {
			header_html = '<tr>' + header.map(item => '<th>' + escape_html(item) + '</th>').join('') + '</tr>\n'
		}
		for (const cells of arrays) {
			body.push('<tr>' + cells.map(item => '<td>' + escape_html(item) + '</td>').join('') + '</tr>\n')
		}
	})

	const html_string = '<!DOCTYPE html>' + "\n"
		+ '<html>' + "\n"
		+ '<head>' + "\n"
		+ '<meta charset="utf-8">' + "\n"
		+ '</head>' + "\n"
		+ '<body>' + "\n"
		+ '<table>' + "\n"
		+ '<thead>' + "\n" + header_html + '</thead>' + "\n"
		+ '<tbody>' + "\n" + body.join('') + '</tbody>' + "\n"
		+ '</table>' + "\n"
		+ '</body>' + "\n"
		+ '</html>'

	return new Blob([html_string], {type: 'text/html;charset=utf-8'})
}//end export_html_blob



/**
* DOWNLOAD_EXPORT_BLOB
* @param Blob blob
* @param string file_name
* @return void
*/
tool_export.prototype.download_export_blob = function(blob, file_name) {

	const url	= URL.createObjectURL(blob)
	const link	= document.createElement('a')
	link.href		= url
	link.download	= file_name
	document.body.appendChild(link)
	link.click()
	link.remove()
	setTimeout(() => URL.revokeObjectURL(url), 1000)
}//end download_export_blob



/**
* GET_EXPORT_CSV
* Load the export grid data
*/
	// tool_export.prototype.get_export_csv = async function () {

	// 	const self = this

	// 	// dd_grid
	// 	const new_dd_grid = await get_instance({
	// 		model			: 'dd_grid',
	// 		section_tipo	: self.caller.section_tipo,
	// 		// section_id	: section_id,
	// 		tipo			: self.caller.section_tipo,
	// 		mode			: 'list',
	// 		view			: 'csv',
	// 		lang			: page_globals.dedalo_data_lang,
	// 		// data_format	: data_format,
	// 		rqo				: self.rqo,
	// 		id_variant 		: 'csv_'
	// 	})
	// console.log('self.data:---------------------------<>', self);

	// 	if (self.data) {
	// 		new_dd_grid.data = self.data
	// 		await new_dd_grid.build(false)
	// 	}else{

	// 		await new_dd_grid.build(true)
	// 	}

	// 	const csv_string = await new_dd_grid.render()

	// 	return csv_string
	// }//end get_export_csv



/**
* GET_EXPORT_XSL
* Load the export grid data and convert it to XLS format
* @param object options
* @return bool
*/
tool_export.prototype.get_export_xsl = async function (options) {

	const self = this

	// const workbook = XLSX.utils.book_new();
	// const ws1 = XLSX.utils.table_to_book(table);
	// console.log("ws1:",ws1);
	// XLSX.utils.book_append_sheet(workbook, ws1, "Sheet1");
 	// 	// const workbook = XLSX.read(table, {type:'string'});
	// XLSX.writeFile(workbook, 'out.csv' );

	const table		= options.table.firstChild //.outerHTML
	const name		= self.caller.section_tipo
	const filename	= options.filename

	// function tableToExcel(table, name, filename) {
	const uri = 'data:application/vnd.ms-excel;base64,',
	template = '<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel" xmlns="http://www.w3.org/TR/REC-html40"><meta charset="UTF-8"/><head><!--[if gte mso 9]><xml><x:ExcelWorkbook><x:ExcelWorksheets><x:ExcelWorksheet><x:Name>{worksheet}</x:Name><x:WorksheetOptions><x:DisplayGridlines/></x:WorksheetOptions></x:ExcelWorksheet></x:ExcelWorksheets></x:ExcelWorkbook></xml><![endif]--></head><body><table>{table}</table></body></html>',
	base64 = function(head_nodes) {
		return window.btoa(decodeURIComponent(encodeURIComponent(head_nodes)))
	},
	format = function(template, ctx) {
		return template.replace(/{(\w+)}/g,
			function(m, p) {
				return ctx[p];
			})
	}

	// if (!table.nodeType) table = document.getElementById(table)
	const ctx = {
		worksheet	: name || 'Worksheet',
		table		: table.innerHTML
	}

	const link = document.createElement('a');
	link.download = filename;
	link.href = uri + base64(format(template, ctx));
	link.click();

	return true
}//end get_export_xsl






/**
* ON_CLOSE_ACTIONS
* Executes specific action on close the tool
* @param string open_as
* 	modal|window
* @return promise: bool
*/
tool_export.prototype.on_close_actions = async function(open_as) {

	const self = this

	if (open_as==='modal') {
		// self.caller.refresh() // never refresh caller (component_json)
		self.destroy(true, true, true)
	}

	return true
}//end on_close_actions



/**
* UPDATE_LOCAL_DB_DATA
* Read and replaces the tool_export_config data portion from current section
* Saves the updated value read from self.ar_ddo_to_export
* @return bool
*/
tool_export.prototype.update_local_db_data = async function() {

	const self = this

	// target_section_tipo. Used to create a object property key different for each section
	const target_section_tipo = self.target_section_tipo[0]

	// get_local_db_data
	const id		= 'tool_export_config'
	const response	= await data_manager.get_local_db_data(
		id,
		'data'
	)

	// tool_export_config. Current section tool_export_config (fallback to basic object)
	const tool_export_config = response && response.value
		? response.value
		: {
			[target_section_tipo] : []
		  }

	// update current key only and save whole object
		tool_export_config[target_section_tipo] = self.ar_ddo_to_export

	// save
		const cache_data = {
			id		: 'tool_export_config',
			value	: tool_export_config
		}
		await data_manager.set_local_db_data(
			cache_data,
			'data'
		)

	// check if already exists current target section_tipo config ddo
		// const found = tool_export_config[target_section_tipo]
		// 	? tool_export_config[target_section_tipo].find(el => el.id===ddo.id)
		// 	: undefined

	// if not exists current ddo (as expected), add it to local database using current target section_tipo as key
		// if (!found) {
		// 	tool_export_config[target_section_tipo] = tool_export_config[target_section_tipo] || []
		// 	tool_export_config[target_section_tipo].push(ddo)
		// 	// save
		// 	const cache_data = {
		// 		id		: 'tool_export_config',
		// 		value	: tool_export_config
		// 	}
		// 	data_manager.set_local_db_data(
		// 		cache_data,
		// 		'data'
		// 	)
		// }

	return true
}//end update_local_db_data



/**
* COMPOSE_ID
* Compose the ddo id used in drag and drop in a unified way
* @param object ddo
* @param array path
* @return string id
*/
tool_export.prototype.compose_id = function (ddo, path) {

	const id = path.map(el => el.section_tipo +'_'+ el.component_tipo).join('_') +'_list_'+ ddo.lang

	return id
}//end compose_id



// @license-end
