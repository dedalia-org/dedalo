// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_label, page_globals, SHOW_DEBUG, DEDALO_CORE_URL*/
/*eslint no-undef: "error"*/



// imports
	import {common} from '../../common/js/common.js'
	import {component_common} from '../../component_common/js/component_common.js'
	import {render_edit_component_pdf} from '../../component_pdf/js/render_edit_component_pdf.js'
	import {render_list_component_pdf} from '../../component_pdf/js/render_list_component_pdf.js'



/**
* COMPONENT_PDF
* Client-side controller for PDF document components in Dédalo.
*
* Manages the full lifecycle of a single PDF component instance: initialisation,
* rendering (edit / list / search / TM views), viewer interaction, and in-viewer
* page navigation driven by annotation tags from linked text-area components.
*
* Key responsibilities:
* - Delegates lifecycle and data-change operations to component_common / common prototypes.
* - Exposes view-specific render methods by aliasing the corresponding render_* module
*   prototypes (edit, list, search, tm).
* - Owns the pdf_viewer reference (a PDF.js-based viewer instance set during build).
*   The viewer is the single source of truth for the current page; go_to_page() drives
*   navigation into it from external tag clicks.
* - Exposes change_handler for updating lib_data.offset (and other viewer state) on the
*   active entry, serialising the change through component_common's change_value pipeline.
* - Provides get_data_tag / go_to_page to integrate with component_text_area annotation
*   tagging: a tag carries the page number; clicking it calls go_to_page on this instance.
*
* Data shape (self.data.entries[]):
*   {
*     id       : string|null            // entry identifier (null for new entries)
*     lib_data : {
*       offset : number                 // current viewer page offset (0-based page index)
*       [key]  : *                      // additional viewer state keys set via change_handler
*     }
*   }
*
* Context features consumed (self.context.features):
*   {
*     allowed_extensions      : Array<string>  // file extensions the PDF component accepts
*     default_target_quality  : string         // quality level used for initial rendering
*   }
*
* @package Dédalo
* @subpackage Core
*/
export const component_pdf = function(){

	this.id

	// element properties declare
	this.model
	this.tipo
	this.section_tipo
	this.section_id
	this.mode
	this.lang

	this.section_lang
	this.context
	this.data
	this.parent
	this.node

	this.tools
	this.quality

	this.file_name
	this.file_dir
}//end component_pdf



/**
* COMMON FUNCTIONS
* extend component functions from component common
*/
// prototypes assign
	// lifecycle
	component_pdf.prototype.init				= component_common.prototype.init
	component_pdf.prototype.render				= common.prototype.render
	component_pdf.prototype.refresh				= common.prototype.refresh
	component_pdf.prototype.destroy				= common.prototype.destroy

	// change data
	component_pdf.prototype.save				= component_common.prototype.save
	component_pdf.prototype.update_data_value	= component_common.prototype.update_data_value
	component_pdf.prototype.update_datum		= component_common.prototype.update_datum
	component_pdf.prototype.change_value		= component_common.prototype.change_value
	component_pdf.prototype.set_changed_data	= component_common.prototype.set_changed_data
	component_pdf.prototype.build_rqo			= common.prototype.build_rqo

	// render
	component_pdf.prototype.list				= render_list_component_pdf.prototype.list
	component_pdf.prototype.edit				= render_edit_component_pdf.prototype.edit
	// search renderer is lazy (CONVENTIONS S3-37 #3, rarely hit): edit/list never need it
	component_pdf.prototype.search				= async function(options) {
		const {render_search_component_pdf} = await import('../../component_pdf/js/render_search_component_pdf.js')
		return render_search_component_pdf.prototype.search.call(this, options)
	}



/**
* CHANGE_HANDLER
* Unified handler for component data changes across all views.
* Merges the incoming key/value pair into the lib_data object of the specified
* entry index, then delegates persistence to component_common.change_value.
* The change is sent without triggering a DOM refresh (refresh: false), so the
* caller is responsible for any visual update.
* @param {Object} options - handler options
* @param {string} options.key - lib_data property name to update (e.g. 'offset')
* @param {*} options.value - new value for the lib_data property
* @param {number} [options.index=0] - zero-based index into self.data.entries
* @returns {void}
*/
component_pdf.prototype.change_handler = function(options) {

	const self = this

	// options
	const key		= options.key
	const value		= options.value
	const index		= options.index ?? 0

	// current_value
	const current_value = self.data.entries?.[index]
	if (!current_value) {
		console.warn('! Ignored change_handler: missing entry at index', index)
		return
	}

	// update lib_data
	current_value.lib_data = current_value.lib_data || {}
	current_value.lib_data[key] = value

	// changed_data
	const changed_data = [Object.freeze({
		action	: 'update',
		id		: current_value.id || null,
		value	: current_value
	})]

	// change_value
	self.change_value({
		changed_data	: changed_data,
		refresh			: false
	})
}//end change_handler



/**
* BUILD
* Extends component_common.prototype.build with PDF-specific post-build setup.
* After the generic build completes (which fetches context + data from the server),
* this method seeds pdf_viewer to null (the viewer is only mounted by the render
* view, not during build) and caches the two context features most frequently used
* by render views: allowed_extensions and default_target_quality.
*
* (!) The end-label reads `build_custom` but the method is registered as `build` on
*     the prototype. This is a pre-existing label mismatch — do not rename the method.
*
* @param {boolean} [autoload=false] - when true, the component fetches its own data
*   without waiting for a parent section trigger
* @returns {Promise<boolean>} resolves with the result of component_common.prototype.build
*/
component_pdf.prototype.build = async function(autoload=false) {

	const self = this

	// call generic component common build
		const common_build = await component_common.prototype.build.call(this, autoload);

	// fix the pfd.js viewer
		self.pdf_viewer	= null

	// fix useful vars
		self.allowed_extensions		= self.context.features.allowed_extensions
		self.default_target_quality	= self.context.features.default_target_quality


	return common_build
}//end build_custom



/**
* GO_TO_PAGE
* Navigates the active PDF.js viewer to the page referenced by an annotation tag.
* Called by component_text_area when the user clicks a tag of type 'page' that
* was created by this component via get_data_tag.
*
* tag.dataset.data is expected to be a JSON-serialised array where the first
* element (index 0) is the 1-based page number to display. The array format
* matches the data_tag.data shape written during tag creation.
*
* (!) Requires self.pdf_viewer to be mounted and ready. Calling this before the
*     viewer is initialised (i.e. before the edit view has rendered) will throw
*     because self.pdf_viewer is null after build().
*
* @param {Object} options - handler options
* @param {HTMLElement} options.tag - the clicked tag element; must have dataset.data
* @returns {Promise<void>}
*/
component_pdf.prototype.go_to_page = async function(options) {

	const self = this

	// options
		const tag = options.tag

	// convert the tag dataset to 'real' object for manage it
		const page = JSON.parse(tag.dataset.data)

	// for every layer_id in the tag load the data from the DDBB
		self.pdf_viewer.page = page[0]
}//end go_to_page



/**
* GET_DATA_TAG
* Builds and returns a tag descriptor for creating a new page annotation tag in a
* linked component_text_area. Called by the text-area when the user initiates a tag
* referencing this PDF component's current viewer position.
*
* The returned object captures the current page offset (from lib_data.offset of
* the first entry) and the total page count (from the live viewer) so that the
* text-area can store a meaningful cross-reference.
*
* When no lib_data exists yet (the PDF has never been saved with viewer state),
* offset defaults to 0.
*
* (!) Requires self.pdf_viewer to be mounted. self.pdf_viewer.pagesCount is read
*     directly from the live PDF.js viewer object; calling this before the viewer
*     has loaded a document will return an undefined total_pages.
*
* @returns {Object} data_tag - tag descriptor with shape:
*   {
*     type        : 'page',
*     tag_id      : null,
*     state       : 'n',          // 'n' = new / unsaved
*     label       : '',
*     data        : '',
*     offset      : number,       // 0-based viewer page offset from lib_data
*     total_pages : number        // total pages reported by the PDF.js viewer
*   }
*/
component_pdf.prototype.get_data_tag = function() {

	const self = this
	const offset 		= self.data.entries[0] && self.data.entries[0].lib_data
		? self.data.entries[0].lib_data.offset
		: 0
	const total_pages 	= self.pdf_viewer.pagesCount

	const data_tag = {
		type		: 'page',
		tag_id		: null,
		state		: 'n',
		label		: '',
		data		: '',
		offset		: offset,
		total_pages	: total_pages
	}

	return data_tag
}//end get_data_tag



///// not used
/**
* GET_TEXT
* (!) DEAD CODE — never called. Retained for reference.
* Experimental utility that attempted to extract plain-text content from a
* specific PDF page using the PDF.js text-layer API (textContentItemsStr /
* textDivs). The intent was to reconstruct the reading order by comparing
* offsetTop values of text divs and inserting newlines at sentence boundaries
* detected by a small set of terminal punctuation characters.
*
* The function references the module-scope `self` implicitly, which means it
* relies on `self` being set in the enclosing scope at call time — this will
* throw a ReferenceError in strict ES-module context. Likewise, the `distance`
* variable is declared but never used.
*
* The large commented-out block inside explores an alternative approach using
* pdfPage.getTextContent() + viewport.transform to position each text span.
*
* @returns {void}
*/
function get_text() {

	const ar_text = self.pdf_viewer.pdfViewer.getPageView(8).textLayer.textContentItemsStr

	console.log("ar_text", ar_text);
	console.log("textDivs", self.pdf_viewer.pdfViewer.getPageView(8).textLayer.textDivs);
	console.log("textLayer", self.pdf_viewer.pdfViewer.getPageView(8).textLayer.textLayerDiv);
	console.log("outerText", self.pdf_viewer.pdfViewer.getPageView(8).textLayer.textLayerDiv.outerText);
	console.log("outerText", self.pdf_viewer.pdfViewer.getPageView(3).textLayer.textLayerDiv.outerText);
	const ar_divs = self.pdf_viewer.pdfViewer.getPageView(8).textLayer.textDivs

	let page_text			= ''
	let previous_offsetTop	= null
	const final_puntuation	= ['.','!','?',':']
	const accents			= ['\'','`','´','"','¨','’']
	let distance			= 0
	for (let i = 0; i < ar_divs.length; i++) {
		const currrent_div = ar_divs[i]
		if(previous_offsetTop === currrent_div.offsetTop){
			if(accents.includes(ar_text[i].slice(0,1))){
				page_text = page_text+ar_text[i]
			}else{
				page_text = page_text+' '+ar_text[i]
			}
		}else{
			if (final_puntuation.includes(page_text.slice(-1)) ||  final_puntuation.includes(page_text.slice(-2,-1)) ) {
				page_text = page_text +'\n'+ ar_text[i]
			}else{
				page_text = page_text + ' ' + ar_text[i]
			}
			previous_offsetTop = currrent_div.offsetTop
		}

		console.log("currrent_div.offsetTop:", currrent_div.offsetTop);
	}

	console.log("page_text", page_text);


	// const viewport = self.pdf_viewer.pdfViewer.getPageView(3).viewport
	//
	// const page2 = self.pdf_viewer.pdfViewer.getPageView(3).pdfPage
	// const text = page2.getTextContent({ normalizeWhitespace: true }).then(function (textContent) {
	// 	console.log("textContent", textContent);
	// 	textContent.items.forEach(function (textItem) {
	// 		console.log("textItem", textItem);
	//
	//
	// 		// const tx = self.pdf_js.Util.transform(
	// 		//   self.pdf_js.Util.transform(viewport.transform, textItem.transform),
	// 		//   [1, 0, 0, -1, 0, 0]
	// 		// );
	// 		//
	// 		// const style = textContent.styles[textItem.fontName];
	// 		//
	// 		// // adjust for font ascent/descent
	// 		// const fontSize = Math.sqrt((tx[2] * tx[2]) + (tx[3] * tx[3]));
	// 		//
	// 		// if (style.ascent) {
	// 		//   tx[5] -= fontSize * style.ascent;
	// 		// } else if (style.descent) {
	// 		//   tx[5] -= fontSize * (1 + style.descent);
	// 		// } else {
	// 		//   tx[5] -= fontSize / 2;
	// 		// }
	//
	// 			// adjust for rendered width
	// 			// if (textItem.width > 0) {
	// 			//   ctx.font = tx[0] + 'px ' + style.fontFamily;
	// 			//
	// 			//   const width = ctx.measureText(textItem.str).width;
	// 			//
	// 			//   if (width > 0) {
	// 			// 	//tx[0] *= (textItem.width * viewport.scale) / width;
	// 			// 	tx[0] = (textItem.width * viewport.scale) / width;
	// 			//   }
	// 			// }
	//
	// 		// const item = document.createElement('span');
	// 		// item.textContent = textItem.str;
	// 		// item.style.fontFamily = style.fontFamily;
	// 		// //item.style.transform = 'matrix(' + tx.join(',') + ')';
	// 		// item.style.fontSize = fontSize + 'px';
	// 		// item.style.transform = 'scaleX(' + tx[0] + ')';
	// 		// item.style.left = tx[4] + 'px';
	// 		// item.style.top = tx[5] + 'px';
	//
	// 	})
	// })

	// console.log("2222_extractText",self.pdf_viewer.pdfViewer.getPageView(3))
}//end

///// not used
/**
* GETHIGHTLIGHTCOORDS
* (!) DEAD CODE — never called. Retained for reference.
* Experimental utility that computes PDF coordinate rectangles for the user's
* current text selection within a PDF.js page canvas. It reads the selection
* rects from the browser's Selection API, maps them into PDF-space coordinates
* using viewport.convertToPdfPoint(), and returns an object describing the page
* index and the array of coordinate quads.
*
* Intended companion to showHighlight() — the coords it returns would be passed
* there to draw pink overlay divs over the selected region.
*
* (!) References `self` from the module scope implicitly; same caveat as get_text().
* Note: the function name has a typo — "Hightlight" should be "Highlight".
*
* @returns {Object} - { page: number, coords: Array<Array<number>> }
*/
function getHightlightCoords() {
	const pageIndex			= self.pdf_viewer.pdfViewer.currentPageNumber - 1;
	const page				= self.pdf_viewer.pdfViewer.getPageView(pageIndex);
	const pageRect			= page.canvas.getClientRects()[0];
	const selectionRects	= window.getSelection().getRangeAt(0).getClientRects();
	const selection_text	= window.getSelection().toString()
	const viewport			= page.viewport;
	const selected			= selectionRects.map(function (r) {
	  return viewport.convertToPdfPoint(r.left - pageRect.x, r.top - pageRect.y).concat(
	     viewport.convertToPdfPoint(r.right - pageRect.x, r.bottom - pageRect.y));
	});
	return {page: pageIndex, coords: selected};
}//end getHightlightCoords

///// not used
/**
* SHOWHIGHLIGHT
* (!) DEAD CODE — never called. Retained for reference.
* Experimental utility that renders pink overlay <div> elements over a set of
* PDF coordinate rectangles obtained from getHightlightCoords(). Each rect in
* selected.coords is converted from PDF-space to viewport-space with
* viewport.convertToViewportRectangle(), then a positioned <div> is appended to
* the page's canvas parent element.
*
* (!) References `self` from the module scope implicitly; same caveat as get_text().
*
* @param {Object} selected - value returned by getHightlightCoords()
* @param {number} selected.page - zero-based page index
* @param {Array<Array<number>>} selected.coords - PDF coordinate quads to highlight
* @returns {void}
*/
function showHighlight(selected) {
	const pageIndex		= selected.page;
	const page			= self.pdf_viewer.pdfViewer.getPageView(pageIndex);
	const pageElement	= page.canvas.parentElement;
	const viewport		= page.viewport;
	selected.coords.forEach(function (rect) {
	  const bounds = viewport.convertToViewportRectangle(rect);
	  const el = document.createElement('div');
	  el.setAttribute('style', 'position: absolute; background-color: pink;' +
	    'left:' + Math.min(bounds[0], bounds[2]) + 'px; top:' + Math.min(bounds[1], bounds[3]) + 'px;' +
	    'width:' + Math.abs(bounds[0] - bounds[2]) + 'px; height:' + Math.abs(bounds[1] - bounds[3]) + 'px;');
	  pageElement.appendChild(el);
	});
}//end showHighlight



// @license-end
