// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_label, page_globals, SHOW_DEBUG, DEDALO_CORE_URL*/
/*eslint no-undef: "error"*/



// imports
	import {ui} from '../../common/js/ui.js'
	import {get_media_url} from '../../component_media_common/js/media_url.js'



/**
* VIEW_MINI_IMAGE
* Inline thumbnail renderer for component_image in 'mini' display mode.
*
* 'mini' mode is used wherever a compact, single-image preview is required
* without interactive controls — typically inside autocomplete suggestion
* rows, relation chips, or any embedded list cell that only needs a small
* visual reference. It does NOT include viewer or editor
* logic; those concerns belong to the list/mosaic/edit views.
*
* Exported members:
*   view_mini_image          — constructor stub (returns true; no instance state)
*   view_mini_image.render   — static factory: builds and returns the wrapper node
*
* Globals consumed (declared in the /*global* / pragma above):
*   - page_globals.dedalo_quality_thumb  — string key for the thumbnail quality tier
*                                          (e.g. '1.5MB') used to select the matching
*                                          file_info entry from data.entries
*   - page_globals.fallback_image        — absolute URL of the placeholder image shown
*                                          when no matching file_info entry exists or
*                                          the resolved URL fails to load
*
* (!) DEDALO_MEDIA_URL is referenced at line 45 but is NOT listed in the /*global* /
*     pragma. It is injected by the page bootstrap as a browser-side global. The eslint
*     pragma only declares the symbols actually named in it; omitting DEDALO_MEDIA_URL
*     causes an eslint no-undef warning at runtime linting. Consider adding it to the
*     pragma to keep it consistent with component_image's other view files.
*/
export const view_mini_image = function() {

	return true
}//end view_mini_image



/**
* RENDER
* Builds the mini-mode DOM node for a component_image instance.
*
* Priority order for resolving the image URL:
*   1. data.external_source — absolute URL provided by the server when the image
*      is hosted externally (e.g. a third-party media repository); bypasses the
*      Dédalo media store entirely.
*   2. entries entry whose 'quality' matches page_globals.dedalo_quality_thumb —
*      a Dédalo-hosted thumbnail; URL is constructed as:
*        get_media_url(file_info) — versioned by its file, so re-processing
*      gets a new URL.
*   3. page_globals.fallback_image — shown when neither of the above resolves,
*      keeping the layout stable even for records with no uploaded file.
*
* The error handler on the <img> element swaps in the fallback image only once:
* the guard 'image.src !== page_globals.fallback_image' prevents infinite retry
* loops if the fallback URL itself is broken or the error event re-fires.
*
* Like every media still, the <img> is lazy (off-screen grid cells fetch nothing
* until shown). No viewer handler is attached.
*
* @param {Object} self    - The component_image instance. Must expose:
*                             self.data    {Object}  — server response data layer
*                             self.view    {string}  — current view name (used as CSS class)
* @param {Object} options - Unused by this renderer; reserved for future extension.
* @returns {HTMLElement} wrapper — A <span> element (built by ui.component.build_wrapper_mini)
*                                  containing the resolved <img> element.
*/
view_mini_image.render = function(self, options) {

	// short vars
		const data				= self.data || {}
		const entries			= data.entries || [] // value is a files_info list
		const files_info		= entries
		const external_source	= data.external_source

	// wrapper
		const wrapper = ui.component.build_wrapper_mini(self)

	// url
		// Select the thumbnail quality entry from the file list; fall back through
		// external_source and the global placeholder as described above.
		const quality	= page_globals.dedalo_quality_thumb // '1.5MB'
		const file_info	= files_info.find(item => item.quality===quality)
		const url		= external_source
			? external_source
			: file_info
				? get_media_url(file_info)
				: page_globals.fallback_image

	// image
		// CSS class carries the view name so LESS rules can target '.view_mini' specifically.
		const image = ui.create_dom_element({
			element_type	: 'img',
			class_name		: 'view_' + self.view,
			parent			: wrapper
		})
		image.loading	= 'lazy'
		image.decoding	= 'async'
		// Fall back to the global placeholder on load failure.
		// Guard prevents an infinite retry loop if the fallback itself returns an error.
		image.addEventListener('error', function(e) {
			if (image.src!==page_globals.fallback_image) {
				image.src = page_globals.fallback_image
			}
		})
		image.src = url


	return wrapper
}//end render



// @license-end
