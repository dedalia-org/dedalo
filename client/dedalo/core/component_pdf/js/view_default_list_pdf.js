// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global DEDALO_CORE_URL*/
/*eslint no-undef: "error"*/



/**
* VIEW_DEFAULT_LIST_PDF
*
* Renders the standard list-mode thumbnail for a PDF component instance.
*
* This module is one of three list-view modules for component_pdf (alongside
* view_mini_pdf and view_text_list_pdf). It is selected by render_list_component_pdf
* when self.context.view is 'default' or unrecognised.
*
* Rendering strategy:
*   1. Look for a 'thumb' quality entry in data.entries with file_exist === true
*      and derive a thumbnail URL from it (served via DEDALO_MEDIA_URL).
*      Falls back to a bundled SVG PDF icon when no thumbnail is available.
*   2. Look for an entry matching the context's expected quality + extension to
*      determine whether a full-resolution file actually exists.  If no such
*      entry is found, page_globals.fallback_image is used as the <img> src
*      instead of the thumbnail URL.
*   3. Attaches a mousedown handler (handler_open_viewer, shared with all media
*      components) to the <img> element; the handler opens the PDF viewer popup
*      or the upload tool depending on file availability.
*
* Globals consumed — (!) marks globals not declared in the file-level eslint-global
* comment at the top of this file:
*   DEDALO_CORE_URL   — base URL for Dédalo assets (correctly declared above).
*   DEDALO_MEDIA_URL  — base URL for media file serving; (!) undeclared — ESLint
*                       will flag this under "no-undef". The global comment should
*                       include DEDALO_MEDIA_URL, matching view_mini_pdf.js.
*   page_globals      — application-wide runtime globals object; (!) undeclared —
*                       ESLint will flag this. The global comment should include
*                       page_globals, matching view_mini_pdf.js and view_default_edit_pdf.js.
*
* @module view_default_list_pdf
*/

// imports
	import {ui} from '../../common/js/ui.js'
	import {handler_open_viewer} from '../../component_media_common/js/component_media_common.js'
	import {fallback_on_error, get_media_url} from '../../component_media_common/js/media_url.js'



/**
* VIEW_DEFAULT_LIST_PDF
* Constructor stub — no instance state is needed; all logic lives in
* the static render() method below. Returns true to satisfy Dédalo's
* convention for view-module constructors.
*/
export const view_default_list_pdf = function() {

	return true
}//end view_default_list_pdf



/**
* RENDER
* Builds and returns the list-mode wrapper node for a PDF component.
*
* Selects a display URL through a two-stage priority lookup:
*   a) Preferred: a 'thumb' quality entry with file_exist === true in
*      data.entries, prefixed with DEDALO_MEDIA_URL to form an absolute URL.
*   b) Fallback:  DEDALO_CORE_URL + '/themes/default/icons/file-pdf-o.svg'
*      when no thumbnail entry exists (new/not-yet-processed PDFs).
*
* The <img> element receives the CSS class 'icon_pdf' when the fallback SVG
* icon is used (URL contains 'file-pdf'), allowing CSS to style it differently
* from rendered thumbnails.  A 'link' class is always added to signal
* pointer-cursor interactivity.
*
* open_window_features ({width: 1024, height: 800}) is attached directly to
* the DOM image element so that handler_open_viewer can read the desired popup
* dimensions without extra closure state.
*
* An 'error' event listener logs to the console when the browser fails to
* load the resolved image URL (e.g. missing/corrupt media file).
*
* A 'mousedown' event listener delegates to handler_open_viewer (imported from
* component_media_common) bound to self, which handles both the "open viewer
* popup" and "open upload tool" paths.
*
* @param {Object} self    - The component_pdf instance. Must expose:
*   self.data             {Object}  — data payload; data.entries is an Array of
*                                     file-info objects (see data shape below).
*   self.context          {Object}  — server context; context.features.extension
*                                     and context.features.quality select the
*                                     primary quality/format entry.
* @param {Object} options - Render options (currently unused; reserved for
*   future render_level / partial-render support consistent with other views).
* @returns {Promise<HTMLElement>} The fully assembled wrapper element, ready
*   for insertion into the DOM by the caller (render_list_component_pdf.list).
*
* Data shape — individual item in data.entries:
* {
*   quality    : string,   // e.g. 'thumb', 'master', 'lg'
*   extension  : string,   // e.g. 'pdf'
*   file_exist : boolean,  // true when the physical file is present on disk
*   file_path  : string    // relative path, prefixed with DEDALO_MEDIA_URL
* }
*/
view_default_list_pdf.render = async function(self, options) {

	// short vars
		const data				= self.data || {}
		const entries			= data.entries || []
		const files_info		= entries
		const external_source	= data.external_source
		const extension			= self.context.features.extension
		const quality			= self.context.features.quality;

	// wrapper
		const wrapper = ui.component.build_wrapper_list(self, {})
		wrapper.classList.add('media','media_wrapper')

	// image

		// url
		const file_info	= files_info.find(el => el.quality===quality && el.extension===extension && el.file_exist===true) //

		// thumb
		const thumb	= files_info.find(el => el.quality==='thumb' && el.file_exist===true)

		// Resolve the thumbnail URL.
		// Uses DEDALO_MEDIA_URL (! not declared in /*global*/ — see module header flag).
		// Falls back to the bundled PDF icon SVG when no thumb entry exists or has no path.
		const thumb_file = thumb?.file_path
			? get_media_url(thumb)
			: DEDALO_CORE_URL + '/themes/default/icons/file-pdf-o.svg'

		// If a matching quality/extension entry exists, show the thumbnail;
		// otherwise show page_globals.fallback_image (! not declared in /*global*/).
		// Note: file_info is checked here (not thumb) to decide between thumb_file
		// and the fallback, so it is possible to show an SVG icon even when a
		// primary-quality file exists but no thumbnail does (and vice versa).
		const url = file_info
			? thumb_file
			: page_globals.fallback_image

		const image = ui.create_dom_element({
			element_type	: 'img',
			// 'icon_pdf' class is applied only when falling back to the SVG icon,
			// allowing CSS to size/style icon differently from real thumbnails.
			class_name		: (url.indexOf('file-pdf')!==-1 ? 'icon_pdf' : ''),
			src				: url,
			parent			: wrapper
		})
		image.loading	= 'lazy'
		image.decoding	= 'async'
		image.classList.add('link')
		// tells handler_open_viewer window dimensions
		image.open_window_features = {
			width	: 1024,
			height	: 800
		}

		// error event: missing file → placeholder (shared media helper)
			fallback_on_error(image)

		// open viewer. Media common handler for 3d, av, image, pdf, svg
			image.addEventListener('click', handler_open_viewer.bind(self))


	return wrapper
}//end render



// @license-end
