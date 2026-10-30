// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_label, page_globals, SHOW_DEBUG, DEDALO_CORE_URL*/
/*eslint no-undef: "error"*/



// imports
	import {ui} from '../../common/js/ui.js'
	import {handler_open_viewer} from '../../component_media_common/js/component_media_common.js'
	import {get_media_url} from '../../component_media_common/js/media_url.js'



/**
* VIEW_DEFAULT_LIST_SVG
* List-mode view for component_svg.
*
* Renders a compact, read-only thumbnail of an SVG asset suitable for use inside
* grid/table list layouts (e.g. search results, relation lists). Clicking the
* thumbnail either opens the dedicated viewer window (when an SVG file exists)
* or launches the upload tool so the user can supply the missing file.
*
* Exported symbols:
*   view_default_list_svg        - namespace constructor (no-op; carries static `.render`)
*   view_default_list_svg.render - entry point called by render_list_component_svg
*   get_content_data             - exported helper; also used by other list-view files
*
* Data shape expected on `self` (component_svg instance):
*   self.data         {Object}  - server data layer; has `entries` (Array of file_info objects)
*                                 and optional `external_source` (string URL override)
*   self.context      {Object}  - server context layer; has `features.quality` (string)
*   self.quality      {string}  - quality override (takes precedence over context.features.quality)
*   self.tipo         {string}  - ontology tipo key, e.g. 'rsc855'
*   self.section_tipo {string}  - parent section tipo, e.g. 'rsc302'
*   self.section_id   {string|number} - record id of the parent section
*   self.tools        {Array}   - tool descriptor objects; used to locate 'tool_upload'
*
* `data.entries` is a flat array of file_info objects (same structure as `data.json`
* sample). Each file_info has at minimum:
*   { quality: string, file_path: string, file_exist: boolean }
*
* (!) DEDALO_MEDIA_URL is used in get_content_data but is NOT declared in the
*     global pragma at the top of this file. The eslint no-undef rule will
*     flag it. Add DEDALO_MEDIA_URL to the pragma when the pragma is next revised.
*/
export const view_default_list_svg = function() {

	return true
}//end view_default_list_svg



/**
* RENDER
* Build and return the list-mode DOM wrapper for a component_svg instance.
*
* The wrapper uses the shared `ui.component.build_wrapper_list` builder so it
* receives all standard list CSS classes and data attributes. An additional
* `media` / `media_wrapper` class pair is appended to mark this node as a media
* component for CSS targeting.
*
* A pointer `wrapper.content_data` is stored directly on the node so callers can
* reach the inner content element without re-querying the DOM.
*
* (!) `render_level` is read from options but is never used in this function.
*     The full render is always produced regardless of its value. This mirrors
*     the pattern in view_default_edit_svg where render_level='content' causes
*     an early return, but that branch was not implemented here.
*
* @param {Object} self    - fully initialised component_svg instance
* @param {Object} options - render options; `render_level` ('full'|'content') is
*                           read but currently has no effect in this view
* @returns {HTMLElement} wrapper - the mounted list-mode wrapper node
*/
view_default_list_svg.render = function(self, options) {

	// options
		const render_level = options.render_level || 'full'

	// content_data
		const content_data = get_content_data(self)

	// wrapper
		const wrapper = ui.component.build_wrapper_list(self, {})
		wrapper.classList.add('media','media_wrapper')
		wrapper.appendChild(content_data)
		// set pointers
		wrapper.content_data = content_data


	return wrapper
}//end render



/**
* GET_CONTENT_DATA
* Build the inner content node that displays the SVG thumbnail and wires the
* click-to-view / click-to-upload interaction.
*
* Quality resolution:
*   The active quality string (e.g. 'web', 'original') is read first from
*   `self.quality` and falls back to `self.context.features.quality`. This value
*   determines which file_info entry from the entries array is treated as the
*   primary SVG file.
*
* Image URL selection (priority order):
*   1. Thumb quality JPG (`quality === 'thumb'`, `file_exist === true`) — used as
*      the displayed preview image.
*   2. SVG file matching the active quality.
*   Both are versioned by their file (get_media_url, ?v=<file_time>-<size>).
*   3. `page_globals.fallback_image` — shown when no file exists at all.
*
*   If `data.external_source` is set, it overrides the locally resolved URL
*   entirely; the file_info lookup is still performed to determine whether any
*   file exists (for the mousedown branch decision).
*
* Mousedown behaviour:
*   - No file exists → open tool_upload so the user can supply an SVG file.
*     The tool context is looked up by model name from `self.tools`; if not found
*     the string literal 'tool_upload' is passed as a fallback.
*   - File exists → open the dedicated viewer page in a new named window (target
*     'viewer', 1024 × 720 px) by constructing a DEDALO_CORE_URL page URL with
*     mode='edit' and view='viewer'.
*
* @param {Object} self - fully initialised component_svg instance
* @returns {HTMLElement} content_data - the content node, ready to be appended to a wrapper
*/
export const get_content_data = function(self) {

	// short vars
		const data				= self.data || {}
		const entries			= data.entries || [] // value is a files_info list
		const files_info		= entries
		const quality			= self.quality || self.context.features.quality
		const external_source	= data.external_source

	// content_data
		const content_data = ui.component.build_content_data(self)

	// svg element
		const svg_file	= files_info.find(el => el.quality===quality && el.file_exist===true)
	// thumb
		const thumb	= files_info.find(el => el.quality==='thumb' && el.file_exist===true)

		// Prefer the thumb (JPG rendition) for display — smaller payload, no re-encode
		// artifacts. Fall back to the full SVG at the active quality, then to the
		// global fallback image when no file is present.
		const file = thumb?.file_path
			? get_media_url(thumb)
			: svg_file
				? get_media_url(svg_file)
				: page_globals.fallback_image

		// file_url
			// When an external_source URL is provided it replaces the locally
			// resolved file URL. The file_exist check below is still performed
			// against the local entries array so the upload branch can fire
			// correctly even when an external source is configured.
			const file_url = external_source
				? external_source
				: file

		// image
			const image = ui.create_dom_element({
				element_type	: 'img',
				src				: file_url,
				parent			: content_data
			})
			image.loading	= 'lazy'
			image.decoding	= 'async'

	// open viewer — THE SHARED HANDLER (component_media_common.handler_open_viewer),
	// the one the other four media list views use.
	//
	// This view carried its own copy, and the copy had drifted in two ways that the
	// operator meets: it did not check `self.permissions`, so a READ-ONLY user
	// clicking an empty SVG got the upload dialog offered to them, and it ignored
	// `external_source`, so a record whose vector lives outside Dédalo opened the
	// upload tool instead of the viewer. Neither is svg-specific behaviour — they
	// are the shared rules, minus the shared code.
	//
	// `open_window_features` is how a list view states its own viewer size; the
	// handler reads it off the node.
		image.open_window_features = { width: 1024, height: 720 }
		image.addEventListener('mousedown', handler_open_viewer.bind(self))


	return content_data
}//end get_content_data



// @license-end
