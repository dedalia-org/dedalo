// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_label, page_globals, SHOW_DEBUG, DEDALO_LIB_URL, DEDALO_MEDIA_URL */
/*eslint no-undef: "error"*/



// imports
	import {ui} from '../../common/js/ui.js'



/**
* VIEW_MINI_LIST_3D
* View module for the 3D component in "mini list" display mode.
*
* Used when a section record is displayed as a compact thumbnail entry inside
* a relation list or portal. Exposes a single static method, `render`, which
* builds the mini wrapper node. The constructor itself is a no-op stub
* (returns true) following the Dédalo convention for view namespace objects.
*/
export const view_mini_list_3d = function() {

	return true
}//end view_mini_list_3d



/**
* RENDER
* Build and return the mini-list thumbnail node for a 3D component.
*
* Resolution order for the displayed image (most-specific wins):
*   1. 'thumb' quality entry from data.entries, when file_exist === true.
*   2. data.posterframe_url (a server-generated static snapshot of the model),
*      with a cache-busting timestamp query parameter appended.
*   3. page_globals.fallback_image — the site-wide placeholder image URL.
*
* A runtime 'error' listener on the <img> element replaces a broken src with
* the fallback image, preventing broken-image icons in the UI.
*
* The wrapper receives the 'media' CSS class (in addition to the standard
* 'mini' and model-specific classes added by build_wrapper_mini), which
* activates media-specific layout rules in the stylesheet.
*
* @param {Object} self    - Component instance. Expected shape:
*                           { data: { entries: Array, posterframe_url: string|null } }
* @param {Object} options - Reserved for future use; not consumed by this render.
* @returns {Promise<HTMLElement>} Resolves with the populated <span> wrapper element.
*/
view_mini_list_3d.render = async function(self, options) {

	// short vars
		const data		= self.data || {}
		const entries	= data.entries || []

	// wrapper
		const wrapper = ui.component.build_wrapper_mini(self)
		wrapper.classList.add('media')

	// files_info
		const files_info = entries

	// thumb, if thumb doesn't exist get the posterframe then if the posterframe doesn't exist get the default image.
		const thumb	= files_info.find(el => el.quality==='thumb' && el.file_exist===true)

	// posterframe (used as fallback)
	// The server versions the URL by file mtime+size (?v=), so a regenerated posterframe gets a new URL.
		const posterframe_url = data.posterframe_url
			? data.posterframe_url
			: page_globals.fallback_image

	// URL
	// if thumb doesn't exist get the posterframe then if the posterframe doesn't exist get the default image.
		const url = thumb?.file_path
			? DEDALO_MEDIA_URL + thumb.file_path
			: posterframe_url

	// image
	// The error handler catches network errors and missing files, replacing the
	// broken src with the global fallback only once (guard avoids an infinite loop
	// if the fallback itself is unreachable).
		const image = ui.create_dom_element({
			element_type	: 'img',
			parent			: wrapper
		})
		image.addEventListener('error', function(e) {
			if (image.src!==page_globals.fallback_image) {
				image.src = page_globals.fallback_image
			}
		})
		image.src = url


	return wrapper
}//end render



// @license-end
