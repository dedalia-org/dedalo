// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_label, page_globals, SHOW_DEBUG, DEDALO_CORE_URL*/
/*eslint no-undef: "error"*/



// imports
	import {ui} from '../../common/js/ui.js'
	import {get_media_url, fallback_on_error} from '../../component_media_common/js/media_url.js'



/**
* VIEW_MINI_LIST_SVG
* Compact thumbnail renderer for component_svg in 'mini' list mode.
*
* This module is selected by render_list_component_svg when `self.context.view === 'mini'`.
* It produces the most reduced representation of an SVG component: a plain <span> wrapper
* (built by ui.component.build_wrapper_mini) containing a single <img> tag whose src is
* set to the file matching the component's active quality level.
*
* Typical usage contexts are embedded list cells and autocomplete suggestions where
* screen real estate is very constrained. Unlike view_default_list_svg and
* view_tag_list_svg, this view attaches no mouse event listeners and carries no
* dataset metadata — it is purely presentational.
*
* Exported members:
*   view_mini_list_svg          — stub constructor (never instantiated; used as namespace)
*   view_mini_list_svg.render   — static entry point called by render_list_component_svg
*   get_value_fragment          — exported helper that builds the DocumentFragment with
*                                 the <img> element; can be imported independently
*
* (!) DEDALO_MEDIA_URL is used in get_value_fragment but is NOT declared in the
*     globals pragma at the top of this file. It is a page-bootstrap constant
*     injected by the PHP template into the global scope. Add 'DEDALO_MEDIA_URL' to the
*     globals list to silence the eslint no-undef warning.
*
* (!) The variable `external_source` (line 56) is read from data but never consumed
*     by this view — it was likely copied from view_default_list_svg where it is used
*     to override the resolved file URL. In this file it is dead code.
*/



/**
* VIEW_MINI_LIST_SVG
* Stub constructor. Acts only as a namespace carrier for the static `render` method.
* Never instantiated directly.
* @returns {boolean} Always returns true (no-op placeholder).
*/
export const view_mini_list_svg = function() {

	return true
}//end view_mini_list_svg



/**
* RENDER
* Entry point for the 'mini' list view of component_svg.
* Delegates all content construction to get_value_fragment and wraps it in the
* standard mini wrapper produced by ui.component.build_wrapper_mini.
*
* Called by render_list_component_svg.prototype.list when self.context.view === 'mini'.
*
* @param {Object} self    - The component_svg instance whose data and context supply
*                           the file list and active quality.
* @param {Object} options - Render options forwarded from the list dispatcher.
*                           Not currently consumed by this view but kept for interface
*                           parity with other view modules.
* @returns {HTMLElement} wrapper - A <span class="mini component_svg_mini"> element
*                                  containing the resolved <img> node (or fallback).
*/
view_mini_list_svg.render = function(self, options) {

	// value
		const fragment = get_value_fragment(self)

	// wrapper
		const wrapper = ui.component.build_wrapper_mini(self)
		wrapper.appendChild(fragment)


	return wrapper
}//end render



/**
* GET_VALUE_FRAGMENT
* Builds a DocumentFragment containing the <img> element for the SVG component's
* active quality file, or a fallback image when no matching file is found.
*
* Data contract — `self.data.entries` is expected to be an Array of file-info objects:
*   [{
*     quality    : {string}  - quality level key, e.g. 'standard', 'web', 'thumb', 'original'
*     file_path  : {string}  - server-relative path appended to DEDALO_MEDIA_URL
*     file_exist : {boolean} - whether the file is present on disk (not checked here;
*                              see view_default_list_svg.get_content_data for a version
*                              that guards on file_exist)
*   }, ...]
*
* Quality resolution:
*   Picks the first entry whose `quality` matches `self.quality` (preferred) or
*   `self.context.features.quality`. No file_exist check is performed — this view
*   prioritises compactness over guarding against missing files. If no match is found
*   the global `page_globals.fallback_image` URL is used instead.
*
* Caching:
*   Every non-fallback URL is versioned by its file (get_media_url, ?v=<file_time>-<size>).
*
* (!) The loop iterates from 0 to `value_length` (= entries.length || 1) but the
*     inner body performs a fixed `files_info.find(...)` that is independent of the
*     loop counter `i`. In practice this means a single <img> is created regardless
*     of how many entries are in the array — subsequent iterations merely overwrite
*     `file_info` and `url` with the same result and append duplicate <img> nodes.
*     This appears to be an unfinished iteration over qualities; do not change the
*     logic here — document and flag only.
*
* (!) `external_source` is destructured from `self.data` but never used inside this
*     function. It is dead code left over from view_default_list_svg (where it
*     overrides the resolved URL). Do not remove it here.
*
* @param {Object} self - The component_svg instance.
*   self.data                    {Object}        - Server data payload.
*   self.data.entries            {Array}         - List of file-info objects (see above).
*   self.data.external_source    {string|undefined} - External override URL (unused here).
*   self.quality                 {string}        - Instance-level quality preference.
*   self.context.features.quality {string}       - Fallback quality from context features.
* @returns {DocumentFragment} Fragment containing one or more <img> elements. In the
*   normal case (one quality level matched) this is a single <img>. When entries is
*   empty the loop still runs once (value_length defaults to 1) and the img src is
*   set to page_globals.fallback_image.
*/
export const get_value_fragment = function(self) {

	// short vars
		const data				= self.data || {}
		const entries			= data.entries || [] // value is a files_info list
		const files_info		= entries
		const external_source	= data.external_source
		const quality			= self.quality || self.context.features.quality

	const fragment = new DocumentFragment()

	// svg elements
		const inputs_value	= entries
		const value_length	= inputs_value.length || 1
		// (!) Loop counter `i` is never used inside the body — see function-level note above.
		for (let i = 0; i < value_length; i++) {

			// THE THUMB FIRST, like every other media mini view (image, av, pdf, 3d).
			// This one loaded the FULL VECTOR at the active quality, cache-busted on
			// every single render, and never checked that the file existed — so a
			// grid of autocompletes re-downloaded N complete SVG documents to draw
			// them at thumbnail size, and a record with no file asked the browser for
			// a URL that 404s instead of showing the placeholder. component_svg has a
			// raster thumb since 2026-08-08; this is the view it was built for.
				const thumb		= files_info.find(el => el.quality==='thumb' && el.file_exist===true)
				const file_info	= thumb
					|| files_info.find(el => el.quality===quality && el.file_exist===true)
					|| files_info.find(el => el.quality===quality)
				const url		= file_info?.file_path
					? get_media_url(file_info)
					: page_globals.fallback_image

			const image	= ui.create_dom_element({
				element_type	: 'img',
				src				: url,
				parent			: fragment
			})
			image.loading	= 'lazy'
			image.decoding	= 'async'
			fallback_on_error(image)
		}


	return fragment
}//end get_value_fragment



// @license-end
