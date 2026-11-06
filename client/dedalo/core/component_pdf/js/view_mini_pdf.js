// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_label, page_globals, SHOW_DEBUG, DEDALO_CORE_URL*/
/*eslint no-undef: "error"*/
// (!) DEDALO_MEDIA_URL is used in render() below but is NOT declared in the
//     /*global*/ block above. The global is injected by the page bootstrap and
//     is available at runtime, but eslint's no-undef rule will flag it.
//     This is a pre-existing omission that matches the same pattern in
//     view_default_list_pdf.js and component_av view files. Do not add it to
//     the /*global*/ directive without a broader cross-component audit.



// imports
	import {ui} from '../../common/js/ui.js'
	import {fallback_on_error, get_media_url} from '../../component_media_common/js/media_url.js'



/**
* VIEW_MINI_PDF
* Compact ("mini") list view for the PDF document component.
*
* Dispatched by render_list_component_pdf when self.context.view === 'mini'.
* This view is used in narrow display contexts — autocomplete dropdowns, relation
* chips, and inline result lists — where a full-sized thumbnail would be too large.
*
* The rendered output is a <span> wrapper (built by ui.component.build_wrapper_mini)
* containing a single <img> element. Image resolution priority:
*   1. The 'thumb' quality entry that exists on disk → DEDALO_MEDIA_URL + file_path
*   2. Fallback static icon → DEDALO_CORE_URL + '/themes/default/icons/file-pdf-o.svg'
*   3. Application-wide fallback → page_globals.fallback_image (when no matching
*      quality+extension entry is found in data.entries at all)
*
* This view does NOT attach a click/mousedown handler to open the PDF viewer;
* it is a read-only thumbnail indicator. For a clickable version see
* view_default_list_pdf.js.
*
* Consumed context features (self.context.features):
*   {string} extension - Target file extension used to locate the primary file_info entry.
*   {string} quality   - Target quality level used to locate the primary file_info entry.
*
* Consumed data shape (self.data.entries[]):
*   Array of file descriptor objects produced by the server:
*   {
*     quality    : {string}  - Quality label (e.g. 'thumb', 'high', 'master').
*     extension  : {string}  - File extension (e.g. 'pdf').
*     file_exist : {boolean} - Whether the physical file is present on disk.
*     file_path  : {string}  - Server-relative path to the file (appended to DEDALO_MEDIA_URL).
*   }
*
* @module view_mini_pdf
*/
export const view_mini_pdf = function() {

	return true
}//end view_mini_pdf



/**
* RENDER
* Builds the mini wrapper node for a PDF component instance.
*
* Selects the best available thumbnail image from the component's data entries,
* falling back to the generic PDF icon or the application fallback image when no
* suitable entry is found.
*
* Decision tree for the displayed image URL:
*   - If a 'thumb' quality entry with file_exist===true is present:
*       thumb_file = get_media_url(thumb)
*   - Otherwise:
*       thumb_file = DEDALO_CORE_URL + '/themes/default/icons/file-pdf-o.svg'
*   - If a primary entry matching self.context.features.quality AND .extension
*     AND file_exist===true exists, use thumb_file; otherwise fall back to
*     page_globals.fallback_image.
*
* Note: The primary file_info lookup (quality + extension) only controls the
* fallback branch — even when file_info is found, the displayed image is always
* the thumb (or the SVG icon), never the full-resolution PDF file.
*
* @param {Object} self    - The component_pdf instance providing context and data.
* @param {Object} options - Render options (currently unused by this view; forwarded
*                           from render_list_component_pdf.prototype.list).
* @returns {Promise<HTMLElement>} The assembled <span> wrapper containing an <img>,
*   ready to be inserted into the DOM by the caller.
*/
view_mini_pdf.render = async function(self, options) {

		const data				= self.data || {}
		const files_info		= data.entries || []
		const extension			= self.context.features.extension
		const quality			= self.context.features.quality;


	// wrapper
		const wrapper = ui.component.build_wrapper_mini(self)

		// url
		const file_info	= files_info.find(el => el.quality===quality && el.extension===extension && el.file_exist===true) //

		// thumb
		const thumb	= files_info.find(el => el.quality==='thumb' && el.file_exist===true) //

		// Prefer the thumbnail file served from media storage; fall back to the
		// generic PDF icon bundled with the default theme.
		const thumb_file = thumb?.file_path
			? get_media_url(thumb)
			: DEDALO_CORE_URL + '/themes/default/icons/file-pdf-o.svg'

		// Only show the thumbnail when the primary entry (quality+extension) exists
		// on disk; otherwise display the application-wide fallback image.
		const url = file_info
			? thumb_file
			: page_globals.fallback_image // page_globals.fallback_image

	// image append to wrapper
		const image = ui.create_dom_element({
			element_type	: 'img',
			src				: url,
			parent			: wrapper
		})
		image.loading	= 'lazy'
		image.decoding	= 'async'
		fallback_on_error(image)

	return wrapper
}//end render



// @license-end
