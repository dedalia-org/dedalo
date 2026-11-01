// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*eslint no-undef: "error"*/



/**
* FLAT_TABLE
* PAGE RENDERER of the export preview (tool_export at scale).
*
* The browser never holds an export any more: the export job writes it into a
* spool on the server, and the preview asks for ONE page of it
* (tool_export.get_export_preview → tools/tool_export/server/preview.ts). This
* module draws that page and nothing else — there is no accumulator, no row
* queue, no live insertion and no file serialisation here. Every downloadable
* format (CSV, TSV, ODS, XLSX, HTML, NDJSON, media ZIP) is built on the server
* from the whole spool (tools/tool_export/server/writers/).
*
* The page wire (data of get_export_preview):
*   cols : [{t:'col', i, key, group, path, label, ar_labels, cell_type, model, after}]
*          ALREADY IN DISPLAY ORDER (the final 'end' order once the job ended,
*          the live-insert order known so far while it runs — `final_order`),
*          and ONE COLUMN WINDOW of it (server PREVIEW_COLUMN_BUDGET; the rows
*          carry only that window's cells — render_tool_export.js draws the
*          column pager from col_page / first_col / total_cols).
*   rows : [{t:'row', rec, sub, c:{ordinal: scalar}}] — sparse cells keyed by the
*          column ordinal; `sub` > 0 marks a breakdown continuation row. A page
*          is counted in RECORDS, so a record is never split across pages.
*   elided : [{rec, rows, after}] — records whose LAST sub-rows the server did
*          not serve (the page's row budget); drawn as one 'rows_elided' marker
*          row right after rows[after] (the record's last served row). Placed by
*          POSITION, never by `rec`: rec is the bare section_id, repeated on one
*          page by an export of several sections. The downloads carry every row.
*
* The DOM therefore holds at most one page: the server clamps page_size to
* row_window.js ROW_WINDOW_MAX_ROWS records AND the rows to its row budget
* (spool_reader.ts PREVIEW_ROW_BUDGET), plus one marker per elided record.
* Rendering a new page REPLACES the table.
*
* Usage:
*   const ft = new flat_table({show_tipo_in_label: false})
*   container.replaceChildren( ft.render_page({cols, rows}) )
*/
export const flat_table = function(config={}) {

	// ordinal (integer) -> col line, for the page being drawn
	this.cols	= new Map()
	// ordinals in display order (the page response's col order)
	this.order	= []

	this.config	= {
		show_tipo_in_label : config.show_tipo_in_label===true
	}
}//end flat_table



/**
* RENDER_PAGE
* Build a complete <table> for one preview page. The column order is the order
* of `page.cols` (the server's), never re-derived here.
*
* @param {Object} page - {cols:Array, rows:Array} (get_export_preview data)
* @returns {HTMLElement} populated <table class="export_flat_table">
*/
flat_table.prototype.render_page = function(page) {

	const cols = Array.isArray(page?.cols) ? page.cols : []
	const rows = Array.isArray(page?.rows) ? page.rows : []

	this.cols	= new Map()
	this.order	= []
	for (const col of cols) {
		if (!col || this.cols.has(col.i)) {
			continue
		}
		this.cols.set(col.i, col)
		this.order.push(col.i)
	}

	const table = document.createElement('table')
	table.classList.add('export_flat_table')

	// header
		const header_tr = document.createElement('tr')
		header_tr.classList.add('row_header')
		for (const ordinal of this.order) {
			header_tr.appendChild( this._build_header_cell(this.cols.get(ordinal)) )
		}
		table.appendChild(header_tr)

	// rows — one fragment, one reflow
		const elided = new Map()
		for (const item of (Array.isArray(page?.elided) ? page.elided : [])) {
			if (item && item.rows > 0 && Number.isSafeInteger(item.after)) {
				elided.set(item.after, item.rows)
			}
		}
		const fragment = document.createDocumentFragment()
		for (let k = 0; k < rows.length; k++) {
			const row = rows[k]
			fragment.appendChild( this.render_row(row) )
			// after the record's last served row: its elided sub-rows, counted
			if (elided.has(k)) {
				fragment.appendChild( this.render_elided_row(elided.get(k)) )
			}
		}
		table.appendChild(fragment)

	return table
}//end render_page



/**
* GET_COLUMN_LABEL
* The display text of a column header: the server-resolved `col.label`
* (fallback `col.key`), plus ' [tipo]' of the leaf component when
* config.show_tipo_in_label is on.
* @param {Object} col - col line
* @returns {string}
*/
flat_table.prototype.get_column_label = function(col) {

	const label = col?.label || col?.key || ''

	if (this.config.show_tipo_in_label) {
		// the last path segment carries the leaf component tipo
		const leaf = Array.isArray(col?.path) && col.path.length
			? col.path[col.path.length-1]
			: null
		const tipo = leaf ? leaf.component_tipo : null
		return tipo ? label + ' [' + tipo + ']' : label
	}

	return label
}//end get_column_label



/**
* CELL_TO_TEXT
* Plain-text form of a cell value (the media cells' server-relative URLs made
* absolute). Used for tooltips / text fallbacks of the preview only — files are
* written on the server (writers/cells.ts owns the file-side rule).
* @param {Object|null} col
* @param {*} value
* @returns {string}
*/
flat_table.prototype.cell_to_text = function(col, value) {

	if (value===null || value===undefined) {
		return ''
	}

	const text = String(value)

	if (col && (col.cell_type==='img' || col.cell_type==='av')) {
		return text
			.split(' | ')
			.map(url => resolve_media_url(url))
			.filter(url => url!=='')
			.join(' | ')
	}

	return text
}//end cell_to_text



/**
* _BUILD_HEADER_CELL
* One <th>: the resolved label as text, the key path as tooltip.
* @param {Object} col
* @returns {HTMLElement}
*/
flat_table.prototype._build_header_cell = function(col) {

	const th = document.createElement('th')
	th.textContent	= this.get_column_label(col)
	th.title		= col?.key || ''

	return th
}//end _build_header_cell



/**
* RENDER_ROW
* One <tr> for a row line, cells in this.order (missing ordinals → empty td).
* Breakdown continuation rows (sub > 0) get the class 'sub_row'.
* @param {Object} row - {rec, sub, c}
* @returns {HTMLElement}
*/
flat_table.prototype.render_row = function(row) {

	const tr = document.createElement('tr')
	if (row.sub > 0) {
		tr.classList.add('sub_row')
	}

	const cells = row.c || {}
	for (const ordinal of this.order) {
		tr.appendChild( this._build_cell(this.cols.get(ordinal), cells[ordinal]) )
	}

	return tr
}//end render_row



/**
* RENDER_ELIDED_ROW
* One marker <tr class="rows_elided"> spanning every column: '… +N', N = the
* record's sub-rows the preview page does not carry (they are in the downloads).
* @param {number} count
* @returns {HTMLElement}
*/
flat_table.prototype.render_elided_row = function(count) {

	const tr = document.createElement('tr')
	tr.classList.add('sub_row', 'rows_elided')

	const td = document.createElement('td')
	td.colSpan		= Math.max(1, this.order.length)
	td.textContent	= '… +' + Number(count).toLocaleString()
	tr.appendChild(td)

	return tr
}//end render_elided_row



/**
* _BUILD_CELL
* One <td>, by the column's cell_type:
* - 'img' / 'av': lazy <img> thumbnails (' | '-joined URLs);
* - 'iri': a link (first IRI as href, full value as text);
* - anything else: text.
* Text only through textContent / attributes — never an HTML-parsing sink.
* @param {Object|null} col
* @param {*} value
* @returns {HTMLElement}
*/
flat_table.prototype._build_cell = function(col, value) {

	const td = document.createElement('td')

	if (value===null || value===undefined || value==='') {
		return td
	}

	switch (col ? col.cell_type : 'text') {

		case 'img':
		case 'av': {
			for (const url of String(value).split(' | ')) {
				const resolved = resolve_media_url(url)
				if (!resolved) continue
				const img = document.createElement('img')
				img.src			= resolved
				img.loading		= 'lazy'
				img.className	= 'export_media_thumb'
				img.alt			= '' // a11y: the column header names the media (decorative)
				td.appendChild(img)
			}
			break
		}

		case 'iri': {
			const href = String(value).split(', ')[0]
			// only http(s) links become anchors: a javascript: IRI stays text
			if (/^https?:\/\//i.test(href)) {
				const a = document.createElement('a')
				a.href			= href
				a.target		= '_blank'
				a.rel			= 'noopener noreferrer'
				a.textContent	= String(value)
				td.appendChild(a)
			}else{
				td.textContent = String(value)
			}
			break
		}

		default:
			td.textContent = String(value)
			break
	}

	return td
}//end _build_cell



/**
* RESOLVE_MEDIA_URL
* The export emits server-relative media paths ('/dedalo/media/…'); the preview
* needs them absolute. External URLs (http…) pass unchanged.
* @param {string} url
* @returns {string} absolute URL, or '' for a falsy url
*/
export const resolve_media_url = function(url) {

	if (!url || !url.length) {
		return ''
	}

	return url.indexOf('http')===0
		? url
		: window.location.origin + url
}//end resolve_media_url



// @license-end
