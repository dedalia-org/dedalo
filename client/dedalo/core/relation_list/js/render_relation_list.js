// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*eslint no-undef: "error"*/



// import
	import {ui} from '../../common/js/ui.js'
	import {object_to_url_vars, open_window, same_section_id} from '../../common/js/utils/index.js'



/**
* RENDER_RELATION_LIST
* Client-side rendering module for the relation_list component.
*
* Builds the HTML representation of a paginated, multi-section relation grid.
* A relation_list shows all records from other sections that reference the
* current record (i.e. inbound relations). Results may span multiple section
* tipos; each section tipo is rendered as a separate labelled grid whose
* columns are determined by the context layer returned by the server.
*
* Exported symbol:
*   render_relation_list — constructor whose prototype methods are mixed into
*   the relation_list instance by relation_list.js.
*
* Rendering pipeline (edit mode):
*   edit()
*     → get_content_data()          build the content_data <div>
*         → parse_html()            iterate context section_tipos
*             → build_grid_html()   emit header + column labels + data rows
*     → self.paginator.render()     the compact ('mini') strip, above the content
*
* Server datum shape expected on self.datum:
*   {
*     context: [
*       { section_tipo, section_label, component_tipo, component_label },
*       …
*     ],
*     data: [
*       // Row-header objects identify a record; value objects follow in order:
*       { section_tipo, section_id },        // row header (component_tipo === 'id')
*       { from_component_tipo, value },      // column value for same section_id
*       …
*     ]
*   }
*
* The module relies on several instance properties set by relation_list.js:
*   self.datum        — API response (context + data arrays, see above)
*   self.model        — always 'relation_list'
*   self.tipo         — structure tipo of this component instance
*   self.mode         — always 'edit' for this renderer
*   self.type         — display variant (e.g. 'detail')
*   self.section_tipo — parent section tipo
*   self.offset       — current pagination offset (integer, ≥ 0)
*   self.limit        — page size (integer, > 0)
*   self.total        — total related-record count across all section tipos
*                       (number by the time rendering begins; see NOTE below)
*
* NOTE: the paginator is a real `paginator` instance in 'mini' mode (created by
* relation_list.init, state refreshed by build). It reads limit/offset from
* self.rqo.sqo and the total from self.get_total().
*
* Globals consumed: DEDALO_CORE_URL (base URL for edit-record deep links, injected
* by environment.js.php at runtime).
*/



/**
* RENDER_RELATION_LIST
* Constructor for the render mixin. Dédalo uses the prototype-assignment
* pattern: render_relation_list.prototype.edit is assigned onto the
* relation_list constructor in relation_list.js so that every relation_list
* instance shares this rendering logic without class inheritance.
*
* The constructor itself does nothing; all logic lives on the prototype.
*
* @returns {boolean} true (Dédalo constructor convention)
*/
export const render_relation_list = function() {

	return true
}//end relation_list



/**
* EDIT
* Build and return the full edit-mode DOM node for this relation_list.
*
* Two rendering levels are supported via options.render_level:
*   'content' — return only the inner content_data element (used when the
*               caller manages its own wrapper, e.g. partial refreshes).
*   'full'    — (default) wrap content_data in a wrapper <div>, attach the
*               paginator, and return the complete subtree.
*
* Side effects: injects a <style> element into <head> (inside build_grid_html
* via parse_html) to hold the dynamic grid-template-columns rule.
*
* @param {Object} options - Rendering options
* @param {string} [options.render_level='full'] - 'full' for wrapper+paginator,
*   'content' for inner content_data only
* @returns {Promise<HTMLElement>} The wrapper <div> (full) or content_data
*   <div> (content level)
*/
render_relation_list.prototype.edit = async function(options={render_level:'full'}) {

	const self = this

	const render_level = options.render_level

	// content_data
		const current_content_data = get_content_data(self)
		if (render_level==='content') {
			return current_content_data
		}

	// wrapper relation_list
		const wrapper = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'wrapper_relation_list ' + self.model + ' ' + self.tipo + ' ' + self.mode
		})

	// paginator. The shared compact strip ('1-10 of 4.683'), first in the wrapper —
	// the same control the inspector's Latest changes panel renders.
		if (self.paginator) {
			const paginator_container = ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'paginator_container',
				parent			: wrapper
			})
			const paginator_wrapper = await self.paginator.render()
			if (paginator_wrapper) {
				paginator_container.appendChild(paginator_wrapper)
			}
		}

	// content_data
		wrapper.appendChild(current_content_data)
		// pointer for common.render's 'content' refresh: a page turn swaps ONLY
		// this node, so the wrapper (and the strip in it) stays mounted.
		wrapper.content_data = current_content_data


	return wrapper
}//end edit



/**
* GET_CONTENT_DATA
* Create the content_data container <div> and populate it by calling
* parse_html, which iterates over all section tipos in the datum context
* and appends a grid fragment for each.
*
* The element carries CSS class 'content_data' plus self.type so that
* different display variants (e.g. 'detail') can be styled independently.
*
* @param {Object} self - The relation_list instance
* @returns {HTMLElement} The populated content_data <div>
*/
const get_content_data = function(self) {

	// content_data
	const content_data = document.createElement('div')
		  content_data.classList.add('content_data', self.type)

	// Render the data html
		parse_html(self, content_data)


	return content_data
}//end get_content_data



/**
* PARSE_HTML
* Iterate over each distinct section_tipo present in the datum context and
* build one grid fragment per section_tipo, appending it to content_data_node.
*
* The datum may contain results from several section tipos in a single
* response (e.g. both 'oh1' Oral History records and 'pci1' Intangible
* Heritage records). The function groups context rows and data rows by
* section_tipo so that each group can be rendered as an independent grid
* with its own column layout.
*
* A single shared <style> element is created and appended to <head> once;
* each call to build_grid_html adds one CSS rule to its sheet.
*
* @param {Object} self - The relation_list instance (provides self.datum)
* @param {HTMLElement} content_data_node - Container to receive the grid fragments
* @returns {boolean} false when self.datum is falsy; true otherwise
*/
const parse_html = function(self, content_data_node) {

	// datum
		const datum = self.datum

	// empty datum case
		if(!datum) {
			return false
		}

	// get the context and the data information of the JSON received
		const context		= datum.context;
		const data			= datum.data;
		// Isolate only the 'id' pseudo-component rows from context —
		// one entry per section_tipo — to use as the iteration anchor.
		const context_id	= context.filter(main_header => main_header.component_tipo === 'id');

	// create new styleSheet
	// A single <style> element is injected into <head> to hold per-grid
	// grid-template-columns rules generated dynamically from column count.
		const style = document.createElement("style");
		document.head.appendChild(style);
		const CSS_style_sheet = style.sheet;


	// loop of the different section_tipo inside the context to build the specific list for every section_tipo
	context_id.forEach(function(current_context){

		// All context columns for this section_tipo (used for the header row and CSS grid).
		const current_context_colums	= context.filter(current_context_colums => current_context_colums.section_tipo === current_context.section_tipo);
		// All data rows belonging to this section_tipo (both id rows and value rows).
		const current_data				= data.filter(current_data_header => current_data_header.section_tipo === current_context.section_tipo);
		// The subset of data rows that are 'id' rows — one per record — used to count records.
		const count_data				= current_data.filter(current_data_count => current_data_count.component_tipo === 'id');

		// render the list html for current section_tipo
		const node = build_grid_html(
			self,
			current_context,
			current_context_colums,
			current_data,
			count_data,
			CSS_style_sheet
		)

		content_data_node.appendChild(node)
	})


	return true
}//end parse_html



/**
* BUILD_GRID_HTML
* Build the complete DOM fragment for one section_tipo's relation grid.
*
* The grid is composed of three parts:
*   1. A grid container <div class="relation_list_grid">
*   2. A header bar showing the section label + record count. Clicking the
*      header fetches all related record ids for this section_tipo and opens
*      them in a section list window. Holding ALT opens a brand-new window
*      instead of reusing the recycled one.
*   3. Data rows — one <ul> per related record. Each <ul> starts with a
*      centered <li> showing the section_id, followed by one <li> per
*      component value. Clicking a row opens that record in an edit window
*      via edit_relation().
*
* Column widths are set dynamically: a CSS rule '.relation_grid_<section_tipo>'
* is inserted into CSS_style_sheet with grid-template-columns:
*   60px (id column) + 1fr for each remaining component column.
*
* Data rows in self.datum.data are flat and ordered. The function tracks
* curent_section_id (intentional spelling in the original code) to detect
* section boundaries and open a new <ul> for each new record.
*
* @param {Object} self - The relation_list instance
* @param {Object} context - The 'id' context row for this section_tipo:
*   { section_tipo, section_label, component_tipo: 'id', component_label: 'id' }
* @param {Array} columns - All context rows for this section_tipo (including
*   the 'id' row), one entry per displayed column
* @param {Array} data - All datum.data rows for this section_tipo, interleaved
*   id-header and value objects in server response order
* @param {Array} count_data - Subset of data containing only id-header rows,
*   used solely to derive the displayed record count
* @param {CSSStyleSheet} CSS_style_sheet - Live sheet to receive the
*   grid-template-columns rule for this section_tipo
* @returns {DocumentFragment} The complete grid fragment ready to be appended
*/
const build_grid_html = function(self, context, columns, data, count_data, CSS_style_sheet) {

	const fragment = new DocumentFragment()

	const section_tipo = context.section_tipo

	// create the css selector for the variable gid style
	const css_selector = 'relation_grid_'+context.section_tipo
	// Subtract 1 because the first column (id) is fixed-width (60px),
	// and the remaining columns each receive 1fr.
	const columns_length = columns.length -1

	// create the CSS_style_sheet with the variable grid columns, every section can has different number of columns
	CSS_style_sheet.insertRule( '.'+css_selector+'{display: grid;grid-template-columns: 60px repeat('+columns_length+', 1fr);}');

	/* 1 Create the grid container */
		// create a grid content
		const grid  = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'relation_list_grid',
			parent			: fragment,
		})

	/* 2 Create the header */
		//create a section_header, main info header, section name and counter
		const header = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'relation_list_header',
			inner_html		: context.section_label,
			parent			: grid
		})
		// click handler
		const click_handler = async (e) => {
			e.stopPropagation()

			// target window
			// By default, the same window is used (recycled) but,
			// if user clicks with ALT key, a new window is opened
			const target_window = (e.altKey===true)
				? section_tipo +'_'+ (new Date()).getTime()
				: null

			// loading class
			grid.classList.add('loading')
			// calculate all related records to current section
			const related_records = await self.get_related_records(section_tipo)
			// open new window with them
			await self.open_related_records(section_tipo, related_records, target_window)
			// loading class
			grid.classList.remove('loading')
		}
		header.addEventListener('click', click_handler)

		// Create the counter
		ui.create_dom_element({
			element_type	: 'span',
			class_name		: 'relation_list_count',
			// count_data contains one entry per related record for this section_tipo
			text_node		: count_data.length,
			parent			: header
		})

		//create the columns labels container
		const data_header = ui.create_dom_element({
			element_type	: 'ul',
			class_name		: css_selector + ' relation_list_data_header',
			parent			: grid
		})

		//create a labels columns info header, the name of the components of the related sections
		columns.forEach(function(column){

			// The 'id' column label is centered; all others are flush
			const class_name = (column.component_label==='id')
				? 'relation_list_data_row_center'
				: ''

			const data_header_label = ui.create_dom_element({
				element_type	: 'li',
				class_name		: class_name,
				text_node		: column.component_label,
				parent			: data_header
			})
		})

	/* 3 Create the rows with the data */
		// curent_section_id tracks the active record while iterating the flat data array.
		// When this value differs from current_data.section_id, a new record has started.
		// (!) Note: 'curent_section_id' is the original spelling — do not rename.
		let curent_section_id	= 0;
		let data_row_header		= ''
		data.forEach(function(current_data){

			//check if the columns id the first column for create the ul node and the first id column
			// type-safe compare: a mid-array int/string section_id flip must not split one record into two rows
			if(!same_section_id(curent_section_id, current_data.section_id)){

				curent_section_id = current_data.section_id;

				//first row, id row, the ul is the container for all row
				// const event_function	= [{'type':'click','name':'relation_list.edit_relation'}];
				data_row_header = ui.create_dom_element({
					element_type				: 'ul',
					class_name					: css_selector + ' relation_list_data_row',
					// custom_function_events	: event_function,
					// data_set					: current_data,
					parent						: grid
				})
				const click_handler = (e) => {
					e.stopPropagation()
					// Open the clicked record in its own edit window.
					// current_data is captured from the outer forEach scope.
					edit_relation(current_data)
				}
				data_row_header.addEventListener('click', click_handler)

				//the id information
				const data_row = ui.create_dom_element({
					element_type	: 'li',
					class_name		: 'relation_list_data_row_center',
					text_node		: current_data.section_id,
					parent			: data_row_header,
				})

			}else{
				// the information columns of the components of the section
				const data_row = ui.create_dom_element({
					element_type	: 'li',
					//class_name	: 'relation_list_data_hearder',
					text_node		: current_data.value,
					parent			: data_row_header
				})
			}
		})


	return fragment
}//end build_grid_html



/**
* EDIT_RELATION
* Open a related record in a new browser window for editing.
*
* Constructs a deep-link URL to the record's edit page using:
*   DEDALO_CORE_URL/page/?tipo=<section_tipo>&id=<section_id>&mode=edit
*     &menu=false&session_save=false
*
* The session_save=false parameter is important: it prevents the server from
* overwriting the current user's section navigation history with the
* newly opened record's location.
*
* The window is always named 'section_view', so repeated clicks on the same
* or different records reuse the same tab (unless the browser policy differs).
* For opening many records at once, callers should use open_related_records
* on the relation_list instance instead.
*
* DEDALO_CORE_URL is a global constant injected by environment.js.php.
*
* @param {Object} current_data - A datum data row that carries section identity:
*   { section_tipo: string, section_id: number, … }
* @returns {boolean} false when section_id or section_tipo are undefined;
*   true after successfully requesting the window
*/
const edit_relation = function(current_data) {

	//get the locator of the related section
	const section_id	= current_data.section_id
	const section_tipo	= current_data.section_tipo

	if (typeof section_id=="undefined") {
		console.error("[relation_list.edit_relation] Error on find section_id", current_data);
		return false
	}
	if (typeof section_tipo=="undefined") {
		console.error("[relation_list.edit_relation] Error on find section_tipo", current_data);
		return false
	}

	// open a new window
		const url = DEDALO_CORE_URL + '/page/?' + object_to_url_vars({
			tipo			: section_tipo,
			id				: section_id,
			mode			: 'edit',
			menu			: false,
			session_save	: false // prevent to overwrite current section session
		})
		open_window({
			url		: url,
			name	: 'section_view'
		})


	return true
}//end edit_relation



// @license-end
