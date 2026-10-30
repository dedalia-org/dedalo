// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_label, page_globals, SHOW_DEBUG, DEDALO_CORE_URL*/
/*eslint no-undef: "error"*/



// imports
	import {get_media_url} from '../../component_media_common/js/media_url.js'



/**
* VIEW_TEXT_LIST_SVG
* Lightweight inline list view for component_svg.
*
* Renders the SVG asset as a plain <img> element wrapped in a <span>, suitable
* for embedding inside flowing text or compact list contexts where the full list
* chrome built by ui.component.build_wrapper_list() is unnecessary (e.g. inside
* an autocomplete label or a grid cell whose container already supplies layout).
*
* This module is selected by render_list_component_svg when self.context.view === 'text'.
* It exports only the static render() method; the constructor is a no-op placeholder
* required by the view dispatch convention in render_list_component_svg.prototype.list.
*
* Globals consumed (declared in the file header /*global*\/ line):
*   page_globals      {Object} - application-wide runtime settings, including
*                                page_globals.fallback_image for broken-image recovery
*/
export const view_text_list_svg = function() {

	return true
}//end view_text_list_svg



/**
* RENDER
* Build and return the inline DOM node for an SVG asset in 'text' list view.
*
* Resolves the best matching file_info entry from data.entries by comparing the
* active quality level to each entry's 'quality' field. If a match is found the
* asset URL is get_media_url(file_info), versioned by its file (a replaced SVG
* gets a new URL). If no
* matching entry is found, page_globals.fallback_image is used instead.
*
* The <img> element registers an 'error' event listener before its src is assigned
* so that a broken-image load falls back to the fallback image rather than
* displaying a broken-image icon.
*
* data.external_source is read but not used in the current implementation.
* (!) See flags — external_source appears to be unused dead code in this view
*     (contrast with view_default_list_svg, which substitutes external_source for
*     the local file URL when present).
*
* @param {Object} self    - component_svg instance. Relevant properties:
*   self.data             {Object}       server-supplied record data
*   self.data.entries     {Array}        list of file_info objects, each with:
*                                          quality   {string}  quality tier key
*                                          file_path {string}  relative media path
*                                          file_exist {boolean} whether the file is on disk
*   self.data.external_source {string|undefined} optional external media URL
*   self.quality          {string}       active quality override (e.g. 'standard')
*   self.context.features.quality {string} fallback quality when self.quality is absent
*   self.view             {string}       active view name; appended to the img CSS class
* @param {Object} options  - reserved for future use; not read by this view
* @returns {HTMLElement} <span> element containing the <img> child, ready to insert into the DOM
*/
view_text_list_svg.render = function(self, options) {

	// short vars
		const data				= self.data || {}
		const entries			= data.entries || [] // value is a files_info list
		const files_info		= entries
		const external_source	= data.external_source

	// url
		const quality	= self.quality || self.context.features.quality
		const file_info	= files_info.find(item => item.quality===quality)
		const url		= file_info
			? get_media_url(file_info)
			: page_globals.fallback_image

	// image
		const image	= document.createElement('img')
		image.loading	= 'lazy'
		image.decoding	= 'async'
		image.className	= 'component_svg media view_' + self.view
		image.addEventListener('error', function(e) {
			if (image.src!==page_globals.fallback_image) {
				image.src = page_globals.fallback_image
			}
		})
		image.src = url

	// wrapper
		const wrapper = document.createElement('span')
		wrapper.appendChild(image)


	return wrapper
}//end render



// @license-end
