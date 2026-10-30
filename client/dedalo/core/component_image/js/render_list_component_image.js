// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_label, page_globals, SHOW_DEBUG, DEDALO_CORE_URL*/
/*eslint no-undef: "error"*/



// imports
	import {view_default_list_image} from './view_default_list_image.js'
	import {view_mini_image} from './view_mini_image.js'
	// rare views are lazy (CONVENTIONS S3-37 #3): the common render only needs the default view
	import {view_mosaic_list_image} from './view_mosaic_list_image.js'



/**
* RENDER_LIST_COMPONENT_IMAGE
* Constructor for the list-mode render object of component_image.
*
* This module provides the `list` prototype method that component_image.prototype.list
* is assigned to (see component_image.js).
* It dispatches to the appropriate view module based on the context view value:
*   - 'viewer'  → view_viewer_image   (standalone popup viewer window)
*   - 'mini'    → view_mini_image     (compact thumbnail, e.g. autocomplete results)
*   - 'text'    → view_text_list_image (inline <span>-based text + image)
*   - 'mosaic'  → view_mosaic_list_image (grid mosaic with click-to-open viewer)
*   - 'default' → view_default_list_image (standard list thumbnail with lazy loading)
*/
export const render_list_component_image = function() {

	return true
}//end render_list_component_image



/**
* LIST
* Builds and returns the DOM node for the image component in list (and tm) mode.
*
* Reads `self.context.view` to select the appropriate view module and delegates
* to its static `render(self, options)` method. Falls through to 'default' for
* any unrecognised view value.
*
* This method is assigned to component_image.prototype.list, so the
* thesaurus-mode render uses the same view dispatch as the regular record list.
*
* @param {Object} options - Render options forwarded verbatim to the view module.
*   Relevant keys depend on the selected view; the mosaic view uses
*   `options.render_level` ('full'|'content') to support partial re-renders.
* @returns {Promise<HTMLElement>} The assembled wrapper (or content_data) node ready to
*   be inserted into the page by the caller (common.prototype.render).
*/
render_list_component_image.prototype.list = async function(options) {

	const self = this

	// view
		const view	= self.context.view || 'default'

	switch(view) {

		case 'viewer': {
			const {view_viewer_image} = await import('./view_viewer_image.js')
			return view_viewer_image.render(self, options)
		}

		case 'mini':
			return view_mini_image.render(self, options)

		case 'text': {
			const {view_text_list_image} = await import('./view_text_list_image.js')
			return view_text_list_image.render(self, options)
		}

		case 'mosaic':
			return view_mosaic_list_image.render(self, options)

		case 'default':
		default:
			return view_default_list_image.render(self, options)
	}
}//end list



// @license-end
