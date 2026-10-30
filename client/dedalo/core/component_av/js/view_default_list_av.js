// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_label, page_globals, SHOW_DEBUG, DEDALO_LIB_URL, DEDALO_CORE_URL */
/*eslint no-undef: "error"*/



// imports
	import {ui} from '../../common/js/ui.js'
	import {handler_open_viewer} from '../../component_media_common/js/component_media_common.js'
	import {get_media_url} from '../../component_media_common/js/media_url.js'



/**
* VIEW_DEFAULT_LIST_AV
* Default list-mode view for component_av — renders the AV component as a
* thumbnail image inside a standard Dédalo list-row wrapper.
*
* This is the view selected by `render_list_component_av` when
* `self.context.view` is 'default', 'column', or absent. The other list views
* ('mini', 'text') are handled by sibling modules.
*
* Rendering strategy:
*   In list mode the full AV player is NOT embedded. Instead, the module
*   displays the 'thumb' quality still image produced by the server when the
*   media file was first processed. Clicking/mousedown on the thumbnail
*   delegates to the shared `handler_open_viewer` (component_media_common),
*   which either opens the full viewer in a new window or fires tool_upload
*   when no rendition exists yet.
*
*   Fallback chain for the displayed image:
*     1. 'thumb' quality entry where file_exist === true  → DEDALO_MEDIA_URL + file_path
*     2. data.posterframe_url (server-rendered still frame)
*     3. page_globals.fallback_image (global placeholder PNG)
*
* Data contract (self.data):
*   {
*     entries         : Array<FileInfoObject>  // list of renditions; in list
*                                              // mode the server typically
*                                              // delivers only 'thumb' quality
*     posterframe_url : string|null            // absolute URL to a server-
*                                              // generated still frame, or null
*   }
*
*   FileInfoObject shape (each element of entries / files_info):
*   {
*     quality    : string  // rendition name, e.g. 'thumb', 'default', 'original'
*     file_path  : string  // media-relative path; prefix with DEDALO_MEDIA_URL
*     file_exist : boolean // true when the physical file is confirmed on disk
*     file_name  : string
*     file_size  : number
*     extension  : string  // e.g. 'mp4', 'webm', 'mp3'
*   }
*
* Globals consumed (beyond /*global*\/ declaration):
*   DEDALO_MEDIA_URL — base URL for the Dédalo media server. (!)
*     NOTE: this global is used on line ~85 but is NOT listed in the
*     /*global*\/ directive at the top of this file; ESLint will raise a
*     no-undef warning. Do not add it here — change the /*global*\/ line.
*
* @module view_default_list_av
* @exports {Function} view_default_list_av - namespace / no-op constructor
*/
export const view_default_list_av = function() {

	return true
}//end  view_default_list_av



/**
* RENDER
* Builds the full list-row DOM tree for a component_av instance.
*
* When `options.render_level === 'content'` the function short-circuits and
* returns only the inner content_data node, skipping the outer wrapper. This
* path is used by callers (e.g. portal or dataframe list renderers) that
* assemble the wrapper themselves.
*
* The outer wrapper receives CSS classes:
*   wrapper_component component_av <tipo> <section_tipo>_<tipo> list view_default
*   media media_wrapper
* (The 'media' and 'media_wrapper' classes are injected via add_styles.)
*
* A reference to the content_data node is also stored on wrapper.content_data
* so that callers can reach the inner node without a DOM query.
*
* @param {Object} self - component_av instance. Must expose:
*   `.data`         {Object}  — server payload (entries, posterframe_url, …)
*   `.tipo`         {string}  — ontology tipo identifier
*   `.section_tipo` {string}  — parent section tipo
*   `.section_id`   {number}  — record identifier
*   `.context`      {Object}  — server context object (view, quality, …)
*   `.permissions`  {number}  — access level (checked inside handler_open_viewer)
*   `.tools`        {Array}   — tool descriptors (used by handler_open_viewer)
* @param {Object} options - render configuration forwarded from the dispatcher.
* @param {string} [options.render_level='full'] - 'full' returns the complete
*   wrapper; 'content' returns the bare content_data fragment.
* @returns {Promise<HTMLElement>} resolved wrapper div, or the bare
*   content_data node when render_level === 'content'.
*/
view_default_list_av.render = async function(self, options) {

	// options
		const render_level = options.render_level || 'full'

	// content_data
		const content_data = get_content_data(self)
		if (render_level==='content') {
			return content_data
		}

	// wrapper
		const wrapper = ui.component.build_wrapper_list(self, {
			add_styles : ['media','media_wrapper']
		})
		wrapper.appendChild(content_data)
		// set pointers to content_data
		wrapper.content_data = content_data


	return wrapper
}//end render



/**
* GET_CONTENT_DATA
* Builds the inner content subtree: a <div class="content_data"> containing a
* lazy-loaded <img class="link"> that shows the AV thumbnail (or a fallback
* image) and opens the media viewer on mousedown.
*
* This helper is intentionally kept private (not exported) because it is only
* meaningful in the context of the full render flow managed by
* `view_default_list_av.render`.
*
* Fallback chain for the <img> source (evaluated in order):
*   1. entries entry with quality === 'thumb' and file_exist === true
*      → get_media_url(thumb)          (versioned by its file, ?v=<file_time>-<size>)
*   2. data.posterframe_url             (versioned by the server, ?v=<mtime ms>-<size>)
*   3. page_globals.fallback_image      (global placeholder PNG; unversioned)
*
* The error event on the image re-assigns src to page_globals.fallback_image
* once, preventing infinite error loops (the condition guards against the case
* where the fallback itself fails to load).
*
* The `open_window_features` object set on the <img> element is read by
* `handler_open_viewer` (component_media_common) to size the viewer popup to
* 1024 × 860 px, which is wider than the default 1024 × 720 used by most
* other list views — accommodating widescreen AV content.
*
* @param {Object} self - component_av instance (same contract as render()).
* @returns {HTMLElement} <div class="content_data"> node ready to be appended
*   to the wrapper.
*/
const get_content_data = function(self) {

	// short vars
		const data			= self.data || {}
		const entries		= data.entries || [] // value is a files_info list
		const files_info	= entries

	// content_data
		const content_data = ui.create_dom_element({
			element_type	: 'div',
			class_name 		: 'content_data'
		})

	// posterframe (used as fallback)
		const posterframe_url = data.posterframe_url
			? data.posterframe_url
			: page_globals.fallback_image

	// thumb
		// Locate the first entry whose quality is 'thumb' and whose physical
		// file is confirmed present on disk (file_exist flag set by server).
		const thumb	= files_info.find(el => el.quality==='thumb' && el.file_exist===true)

	// URL
	// if thumb doesn't exist get the posterframe then if the posterframe doesn't exist get the default image.
		// (!) DEDALO_MEDIA_URL is not declared in the /*global*/ comment above;
		//     ESLint will raise a no-undef error on this line at lint time.
		const url = thumb?.file_path
			? get_media_url(thumb)
			: posterframe_url

	// image
		const image = ui.create_dom_element({
			element_type	: 'img',
			class_name		: 'link',
			parent			: content_data
		})
		image.draggable = false
		image.loading = 'lazy'
		image.decoding = 'async'
		// tells handler_open_viewer window dimensions
		// The viewer is a full-bleed stage, so the popup takes the thumbnail's
		// ratio (read at click time, once loaded); 16:9 until then. The viewer
		// refits it to the real stream ratio on loadedmetadata.
		image.open_window_features = {
			width	: 1024,
			get height() {
				return image.naturalWidth && image.naturalHeight
					? Math.round(1024 * image.naturalHeight / image.naturalWidth)
					: 576
			}
		}

		// load event
			// image.addEventListener('load', set_bg_color, false)
			// function set_bg_color() {
			// 	this.removeEventListener('load', set_bg_color, false)
			// 	ui.set_background_image(this, this)
			// }

		// error event
			// Guard: only substitute the fallback once. Without this check a
			// broken fallback_image URL would trigger an infinite error loop.
			image.addEventListener('error', () => {
				if ( image.src !== page_globals.fallback_image) {
					image.src = page_globals.fallback_image
					return
				}
			}, false)

		// set source url
			image.src = url

		// open viewer. Media common handler for 3d, av, image, pdf, svg
			// handler_open_viewer is bound to `self` so it can access
			// self.tipo, self.section_tipo, self.section_id, self.tools, and
			// self.permissions when deciding whether to open the viewer or
			// fire the upload tool.
			image.addEventListener('mousedown', handler_open_viewer.bind(self))


	return content_data
}//end get_content_data



// @license-end
