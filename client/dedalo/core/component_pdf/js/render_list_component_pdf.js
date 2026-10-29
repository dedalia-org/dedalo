// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_label, page_globals, SHOW_DEBUG, DEDALO_CORE_URL */
/*eslint no-undef: "error"*/



// imports
	import {view_default_list_pdf} from './view_default_list_pdf.js'
	// rare views are lazy (CONVENTIONS S3-37 #3): the common render only needs the default view



/**
* RENDER_LIST_COMPONENT_PDF
* Constructor for the list-mode render object of component_pdf.
*
* This module provides the `list` prototype method that component_pdf.prototype.list
* is assigned to (see component_pdf.js).
* It dispatches to the appropriate view module based on the context view value:
*   - 'mini'    → view_mini_pdf     (compact thumbnail for autocomplete / inline results)
*   - 'text'    → view_text_list_pdf (span-based fallback with a generic PDF icon)
*   - 'default' → view_default_list_pdf (standard list thumbnail with click-to-open viewer)
*
* The constructor itself is a no-op stub — all rendering logic lives in the view
* modules imported above. The real entry point is the `list` prototype method below.
*/
export const render_list_component_pdf = function() {

	return true
}//end render_list_component_pdf



/**
* LIST
* Builds and returns the DOM node for the PDF component in list (and tm) mode.
*
* Reads `self.context.view` to select the appropriate view module and delegates
* to its static `render(self, options)` method. Falls through to 'default' for
* any unrecognised view value.
*
* This method is assigned to component_pdf.prototype.list, so thesaurus-mode
* renders share the same view dispatch as the regular record list
* (see component_pdf.js).
*
* View routing:
*   - 'mini'    → compact thumbnail, used in autocomplete dropdowns and relation chips
*   - 'text'    → icon-only span element; used in plain-text export contexts
*   - 'default' → full thumbnail with mousedown handler that opens the PDF viewer popup
*
* @param {Object} options - Render options forwarded verbatim to the chosen view module.
*   Individual view modules may read specific keys (e.g. render_level); see
*   view_default_list_pdf, view_mini_pdf, and view_text_list_pdf for details.
* @returns {Promise<HTMLElement>} The assembled wrapper node ready to be inserted
*   into the page by the caller (common.prototype.render).
*/
render_list_component_pdf.prototype.list = async function(options) {

	const self = this

	// view
		const view	= self.context.view || 'default'

	switch(view) {

		case 'mini': {
			const {view_mini_pdf} = await import('./view_mini_pdf.js')
			return view_mini_pdf.render(self, options)
		}

		case 'text': {
			const {view_text_list_pdf} = await import('./view_text_list_pdf.js')
			return view_text_list_pdf.render(self, options)
		}

		case 'default':
		default:
			return view_default_list_pdf.render(self, options)
	}
}//end list



// @license-end
