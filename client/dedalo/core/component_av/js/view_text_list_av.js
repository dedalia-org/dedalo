// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_label, page_globals, SHOW_DEBUG, DEDALO_LIB_URL*/
/*eslint no-undef: "error"*/
// (!) DEDALO_MEDIA_URL is used below but is not declared in the /*global*/ block above.
//     This is a pre-existing omission shared with view_mini_list_av.js.
//     The global is injected by the page bootstrap and works at runtime, but the
//     eslint no-undef rule will flag it. Do not add it here without a broader audit.



// imports
	import {ui} from '../../common/js/ui.js'
	import {get_media_url} from '../../component_media_common/js/media_url.js'



/**
* VIEW_TEXT_LIST_AV
* Inline-block ("text") list view for the audio/video component.
*
* Dispatched by render_list_component_av when self.context.view === 'text'.
* This view is used in contexts that require an inline-level container — for
* example, inside a portal's inline display — where a block-level <div> wrapper
* (as used by view_default_list_av) would break the surrounding flow.
*
* The rendered output is a <span> element containing a single <img> that shows
* the media thumbnail, falling back first to the posterframe and then to the
* application-wide fallback image (`page_globals.fallback_image`).
*
* Unlike view_default_list_av, this view does NOT attach a click/mousedown
* handler to open the media viewer; it is purely decorative / indicative.
*
* Main export: view_text_list_av.render (static async method)
*/
export const view_text_list_av = function() {

	return true
}//end  view_text_list_av



/**
* RENDER
* Build the inline-span thumbnail element for a component_av in 'text' list view.
*
* Image resolution priority (highest to lowest):
*   1. Thumb entry from data.entries where quality==='thumb' AND file_exist===true.
*      URL: get_media_url(thumb)  (versioned by its file (get_media_url, ?v=<file_time>-<size>)).
*   2. data.posterframe_url (if present), versioned by the server (?v=<mtime ms>-<size>).
*   3. page_globals.fallback_image — the application-wide placeholder image.
*
* On <img> error the handler attempts one recovery: if the current src is not
* already the fallback, it switches to page_globals.fallback_image. No further
* retry is made.
*
* The `options` parameter is accepted for API consistency with other view render
* methods but is not used in this implementation.
*
* @param {Object} self    - component_av instance; must expose:
*                           self.data         {Object} server-resolved component data
*                           self.data.entries {Array}  list of file-info objects, each
*                                             with {string} quality, {boolean} file_exist,
*                                             {string} file_path
*                           self.data.posterframe_url {string|undefined}
*                           self.model  {string} component model name (CSS class)
*                           self.mode   {string} current render mode (CSS class)
*                           self.view   {string} current view name (CSS class)
* @param {Object} options - render options (currently unused; reserved for future flags)
* @returns {Promise<HTMLElement>} resolves to the <span> wrapper element containing
*                                 the <img> thumbnail
*/
view_text_list_av.render = async function(self, options) {

	// short vars
		const data 		= self.data || {}
		const entries	= data.entries || []

	// files_info
	// entries is the files_info array: one object per quality level (original, high, low, thumb, …).
		const files_info = entries

	// thumb
	// Find the first entry that is both the 'thumb' quality and confirmed present on disk.
	// file_exist===true is set server-side; absent or false means the rendition was not yet generated.
		const thumb	= files_info.find(el => el.quality==='thumb' && el.file_exist===true)

	// posterframe_url
	// The posterframe is a still image extracted from the video (set separately from the
	// media renditions), versioned by the server (?v=<mtime ms>-<size>). Falls back to the global placeholder when absent.
		const posterframe_url = data.posterframe_url
			? data.posterframe_url
			: page_globals.fallback_image

	// URL
	// if thumb doesn't exist get the posterframe then if the posterframe doesn't exist get the default image.
		const url = thumb?.file_path
			? get_media_url(thumb)
			: posterframe_url

	// wrapper
	// An inline <span> is used (rather than <div>) so this view composes correctly
	// inside inline or portal contexts without disrupting surrounding text flow.
		const wrapper = ui.create_dom_element({
			element_type	: 'span',
			class_name		: `wrapper_component ${self.model} ${self.mode} media view_${self.view}`
		})

	// image
	// Uses native createElement rather than ui.create_dom_element so that the error
	// handler closure captures the `image` reference directly before src is set.
		const image	= document.createElement('img')
		image.loading	= 'lazy'
		image.decoding	= 'async'
		image.addEventListener('error', function(e) {
			// Guard prevents an infinite error loop if the fallback image itself is missing.
			if (image.src!==page_globals.fallback_image) {
				image.src = page_globals.fallback_image
			}
		})
		image.src = url
		wrapper.appendChild(image)


	return wrapper
}//end render



// @license-end
