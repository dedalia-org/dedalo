// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_label, page_globals, SHOW_DEBUG, DEDALO_LIB_URL*/
/*eslint no-undef: "error"*/
// (!) FLAG: DEDALO_MEDIA_URL is used on line 52 but is NOT declared in the /*global*/ directive
//     above, which will trigger an eslint no-undef error. The other AV view files
//     (view_default_list_av.js, view_text_list_av.js) have the same omission.
//     Add DEDALO_MEDIA_URL to the /*global*/ list when resolving lint warnings.



/**
* VIEW_MINI_LIST_AV
* Compact thumbnail view for component_av in list / relation-picker contexts.
*
* This module provides the 'mini' rendering path for audio/video components.
* It is dispatched from render_list_component_av when self.context.view === 'mini',
* which is typically configured for inline grids, relation pickers, and places where
* only a small visual indicator of the media asset is needed (no playback controls).
*
* Rendering strategy:
*   1. The preferred image source is the 'thumb' quality entry from data.entries
*      (the file-info array returned by the server) — the first entry where
*      quality === 'thumb' AND file_exist === true.
*   2. If no valid thumb exists, the component falls back to data.posterframe_url
*      (a static frame extracted from the video), versioned by the server (?v=<mtime ms>-<size>).
*   3. If neither thumb nor posterframe is available, page_globals.fallback_image
*      (a system-wide placeholder defined at page bootstrap) is used.
*   4. An 'error' listener on the <img> element implements a second-chance fallback:
*      if the resolved URL fails to load and is not already the fallback image,
*      the src is replaced with page_globals.fallback_image.
*
* The wrapper is a <span> with classes 'mini' and '<model>_mini', built by
* ui.component.build_wrapper_mini.  No click handler is attached here; the
* mini view is purely presentational. Callers that need viewer-open behaviour
* should use 'default' or 'column' views instead.
*
* Consumed globals (page-bootstrap injections):
*   DEDALO_MEDIA_URL  — base URL prepended to file_path for media asset resolution
*   page_globals      — runtime page config; .fallback_image is a full URL string
*
* @module view_mini_list_av
* @exports {Function} view_mini_list_av - constructor (no-op; static method only)
*/

// imports
	import {ui} from '../../common/js/ui.js'
	import {get_media_url} from '../../component_media_common/js/media_url.js'



/**
* VIEW_MINI_LIST_AV
* Constructor placeholder required by Dédalo's prototype-assignment convention.
* All behaviour lives in the static render method below.
*/
export const view_mini_list_av = function() {

	return true
}//end  view_mini_list_av



/**
* RENDER
* Build and return the mini-view DOM node for a component_av instance.
*
* Selects an image source using a three-tier priority chain:
*   thumb entry (quality='thumb', file_exist=true)
*     → data.posterframe_url (versioned by the server, ?v=<mtime ms>-<size>)
*       → page_globals.fallback_image
*
* The returned wrapper is a <span> element (see ui.component.build_wrapper_mini).
* An error listener provides a last-resort fallback if the resolved URL 404s or
* otherwise fails, preventing a broken-image icon in the UI.
*
* No options forwarding is performed; this view does not honour render_level or
* any other option. The method signature accepts only self.
*
* @param {Object} self - component_av instance; must carry:
*   self.data {Object}               — server data payload
*   self.data.entries {Array}        — file-info list; each item is
*                                      { quality: string, file_exist: boolean,
*                                        file_path: string }
*   self.data.posterframe_url {string|undefined} — optional posterframe URL
*   self.model {string}              — component model name (used for CSS class)
* @returns {Promise<HTMLElement>} wrapper - the rendered <span> element ready to
*   be inserted into the DOM
*/
view_mini_list_av.render = async function(self) {

	// short vars
		const data		= self.data || {}
		const entries	= data.entries || []

	// wrapper
		const wrapper = ui.component.build_wrapper_mini(self)

	// files_info
	// entries is the raw file-info array from the server payload; alias kept for clarity.
		const files_info = entries

	// thumb
	// Seek the first entry that represents an existing thumbnail-quality rendition.
		const thumb	= files_info.find(el => el.quality==='thumb' && el.file_exist===true)

	// posterframe_url
	// The server versions the URL by file mtime+size (?v=), so a regenerated posterframe gets a new URL.
		const posterframe_url	= data.posterframe_url
			? data.posterframe_url
			: page_globals.fallback_image

	// URL
	// if thumb doesn't exist get the posterframe then if the posterframe doesn't exist get the default image.
	// (!) DEDALO_MEDIA_URL is a page-bootstrap global that is not declared in /*global*/
	//     above; see the flag at the top of this file.
		const url = thumb?.file_path
			? get_media_url(thumb)
			: posterframe_url

	// image
	// Build the <img> element, append it to the wrapper, then set src after
	// attaching the error handler so the fallback fires even if the URL is
	// resolved synchronously from the browser cache.
		const image = ui.create_dom_element({
			element_type	: 'img',
			parent			: wrapper
		})
		image.loading	= 'lazy'
		image.decoding	= 'async'
		image.addEventListener('error', function(e) {
			// Prevent an infinite error loop: only replace src when it is not
			// already pointing at the fallback image.
			if (image.src!==page_globals.fallback_image) {
				image.src = page_globals.fallback_image
			}
		})
		image.src = url


	return wrapper
}//end render



// @license-end
