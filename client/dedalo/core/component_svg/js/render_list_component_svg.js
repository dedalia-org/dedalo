// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_label, page_globals, SHOW_DEBUG, DEDALO_CORE_URL*/
/*eslint no-undef: "error"*/



// imports
	// rare views are lazy (CONVENTIONS S3-37 #3): the common render only needs the default view
	import {view_default_list_svg} from './view_default_list_svg.js'



/**
* RENDER_LIST_COMPONENT_SVG
* Constructor for the list-mode render object of component_svg.
*
* This module provides the `list` prototype method that is assigned to both
* component_svg.prototype.list in component_svg.js.
* It dispatches to the appropriate view module based on `self.context.view`:
*   - 'mini'    → view_mini_list_svg    (compact image thumbnail, e.g. autocomplete)
*   - 'text'    → view_text_list_svg    (inline <span>/<img> with error fallback)
*   - 'tag'     → view_tag_list_svg     (image with dataset metadata for autocomplete grids)
*   - 'default' → view_default_list_svg (standard list thumbnail with click-to-upload/viewer)
*/
export const render_list_component_svg = function() {

	return true
}//end render_list_component_svg



/**
* LIST
* Builds and returns the DOM node for the SVG component in list (and tm) mode.
*
* Reads `self.context.view` to choose the view module and delegates to its static
* `render(self, options)` method. Falls through to 'default' for any unrecognised
* view value. The method is declared `async` although none of the current view
* modules return a Promise — they all return an HTMLElement synchronously.
*
* This method is assigned to component_svg.prototype.list, so thesaurus-mode
* rendering uses the same view dispatch as the regular record list
* (see component_svg.js).
*
* @param {Object} options - Render options forwarded verbatim to the selected view
*   module. Relevant keys vary by view; `view_default_list_svg` reads
*   `options.render_level` ('full'|'content') to support partial re-renders.
* @returns {Promise<HTMLElement>} Resolves to the assembled wrapper node ready to
*   be inserted into the page by the caller (common.prototype.render).
*   In practice all current view modules return synchronously, but the async
*   declaration allows future view implementations to be genuinely asynchronous.
*/
render_list_component_svg.prototype.list = async function(options) {

	const self = this

	// view
		const view	= self.context.view || 'default'

	switch(view) {

		case 'mini': {
			const {view_mini_list_svg} = await import('./view_mini_list_svg.js')
			return view_mini_list_svg.render(self, options)
		}

		case 'text': {
			const {view_text_list_svg} = await import('./view_text_list_svg.js')
			return view_text_list_svg.render(self, options)
		}

		case 'tag': {
			const {view_tag_list_svg} = await import('./view_tag_list_svg.js')
			return view_tag_list_svg.render(self, options)
		}

		case 'default':
		default:
			return view_default_list_svg.render(self, options)
	}
}//end list



// @license-end
