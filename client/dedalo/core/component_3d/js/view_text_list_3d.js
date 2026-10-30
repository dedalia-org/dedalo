// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_label, page_globals, SHOW_DEBUG, DEDALO_LIB_URL, DEDALO_MEDIA_URL */
/*eslint no-undef: "error"*/



// imports
	import {ui} from '../../common/js/ui.js'
	import {get_media_url} from '../../component_media_common/js/media_url.js'



/**
* VIEW_TEXT_LIST_3D
* Compact "text" view for component_3d instances rendered in list/tm mode.
*
* Selected by render_list_component_3d when context.view === 'text'. Unlike the
* default list view (which wraps the image inside a full list-column scaffold and
* attaches a viewer handler), this view returns a lightweight <span> containing
* only a thumbnail image — suitable for dense inline contexts such as grid cells
* or relation previews where the full viewer chrome is not required.
*
* Image resolution priority (same waterfall as view_mini_list_3d / view_default_list_3d):
*   1. 'thumb' quality entry from data.entries where file_exist === true
*   2. data.posterframe_url (versioned by the server, ?v=<mtime ms>-<size>)
*   3. page_globals.fallback_image (global placeholder, set at page bootstrap)
*
* The module exports one namespace object `view_text_list_3d` with a single static
* method `render`. There is no constructor logic; the exported function body is
* intentionally empty (returns true) and acts only as a namespace anchor for the
* static method.
*/
export const view_text_list_3d = function() {

	return true
}//end view_text_list_3d



/**
* RENDER
* Build and return the DOM node for the 'text' list view of a 3D component.
*
* Renders a <span> containing a single <img> whose src resolves through the
* thumbnail-first waterfall described in the module header. The <img> has an
* error handler that swaps in the global fallback image when the resolved URL
* fails to load, preventing broken-image icons in the UI.
*
* The wrapper class list encodes state that CSS rules in component_3d.less
* target: `wrapper_component`, the component model name, the current mode, the
* word 'media', and `view_text` (derived from `self.view === 'text'`).
*
* @param {Object} self - component_3d instance; must expose .data, .model, .mode,
*   and .view. self.data is the server-provided data item, which may include
*   an `entries` array of file-info objects (each with `quality`, `file_exist`,
*   and `file_path` keys) and an optional `posterframe_url` string.
* @param {Object} options - render options passed down from render_list_component_3d;
*   not consumed by this view but kept in the signature for consistency with
*   other view modules.
* @returns {Promise<HTMLElement>} Resolves to the <span> wrapper element ready to
*   be inserted into the DOM.
*/
view_text_list_3d.render = async function(self, options) {

	// short vars
		const data		= self.data || {}
		const entries	= data.entries || []

	// files_info
		const files_info = entries

	// thumb, if thumb doesn't exist get the posterframe then if the posterframe doesn't exist get the default image.
		const thumb	= files_info.find(el => el.quality==='thumb' && el.file_exist===true)

	// posterframe_url
		// versioned by the server (?v=<mtime ms>-<size>): a regenerated still gets a new URL
		const posterframe_url = data.posterframe_url
			? data.posterframe_url
			: page_globals.fallback_image

	// URL
	// if thumb doesn't exist get the posterframe then if the posterframe doesn't exist get the default image.
		const url = thumb?.file_path
			? get_media_url(thumb)
			: posterframe_url

	// wrapper
		// 'view_text' CSS class is derived at runtime from self.view; the component_3d.less
		// '&.view_text' rule controls sizing and layout for this mode.
		const wrapper = ui.create_dom_element({
			element_type	: 'span',
			class_name		: `wrapper_component ${self.model} ${self.mode} media view_${self.view}`
		})

	// image
		// (!) Set the error handler BEFORE assigning image.src so the handler is in place
		// before the browser attempts to load the URL. If the error guard were missing, a
		// failed src would permanently show a broken-image icon.
		const image	= document.createElement('img')
		image.loading	= 'lazy'
		image.decoding	= 'async'
		image.addEventListener('error', function(e) {
			if (image.src!==page_globals.fallback_image) {
				image.src = page_globals.fallback_image
			}
		})
		image.src = url
		wrapper.appendChild(image)


	return wrapper
}//end render



// @license-end
