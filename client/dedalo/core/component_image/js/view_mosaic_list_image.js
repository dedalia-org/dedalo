// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_label, page_globals, SHOW_DEBUG, DEDALO_CORE_URL*/
/*eslint no-undef: "error"*/



// imports
	import {ui} from '../../common/js/ui.js'
	import {handler_open_viewer} from '../../component_media_common/js/component_media_common.js'
	import {get_media_url} from '../../component_media_common/js/media_url.js'



/**
* VIEW_MOSAIC_LIST_IMAGE
* Compact mosaic-grid thumbnail renderer for component_image in list/mosaic contexts.
*
* Used when component_image is rendered inside a record list configured with
* view='mosaic' (dispatched from render_list_component_image.list → view_mosaic_list_image.render).
* Produces a lazy-loaded <img> nested inside a standard list wrapper so the shared
* stylesheet can apply grid/mosaic layout rules.
*
* Differences from view_default_list_image:
* - The viewer popup is opened on 'click' (not 'mousedown').
* - The popup window is sized to 320×240 instead of 720×540, keeping the mosaic
*   context compact.
* - The 'content' render_level allows callers to obtain only the inner content_data
*   node (no outer wrapper) for partial re-renders (e.g., refreshing only the image
*   without rebuilding the wrapper's event listeners or DOM position).
* - A pointer (wrapper.content_data) is stored on the wrapper so parent code can
*   reach the inner node without traversing the DOM.
*
* Data shape expected on self.data:
*   {
*     entries         : Array<{quality: string, file_path: string, file_exist: boolean, ...}>,
*     external_source : string|undefined  // full URI; bypasses DEDALO_MEDIA_URL when present
*   }
*
* Globals consumed (declared in the /*global* / pragma above):
*   - page_globals.dedalo_quality_thumb  — string key selecting which quality entry to display
*   - page_globals.fallback_image        — URL of the placeholder shown when no file matches
*   - DEDALO_MEDIA_URL                   — base URL prepended to file_path values
*
* (!) DEDALO_MEDIA_URL is not listed in the /*global* / pragma but is used at runtime
*     as a browser global injected by the page bootstrap. Consider adding it to the
*     pragma for ESLint consistency (same omission exists in view_default_list_image.js
*     and view_mini_image.js).
*
* Exports:
*   view_mosaic_list_image          — constructor (always returns true; acts as namespace)
*   view_mosaic_list_image.render   — static render factory; returns an HTMLElement
*/



/**
* VIEW_MOSAIC_LIST_IMAGE
* Namespace constructor for the mosaic-mode image view.
* Always returns true; the real work is on the static render method below.
* Follows the Dédalo view module convention shared by all view_* files.
*/
export const view_mosaic_list_image = function() {

	return true
}//end view_mosaic_list_image



/**
* RENDER
* Builds and returns the DOM subtree for one component_image instance in mosaic mode.
*
* When options.render_level is 'content', returns only the inner content_data node
* (a bare <div>) so that callers can refresh just the image without rebuilding the
* full wrapper. For any other render_level (including the default 'full'), a complete
* wrapper <div> is returned with content_data appended and cross-referenced via
* wrapper.content_data.
*
* URL resolution priority (highest to lowest):
*   1. data.external_source  — arbitrary external URI; bypasses the media server entirely.
*   2. entries entry matching page_globals.dedalo_quality_thumb — Dédalo-hosted thumbnail.
*   3. page_globals.fallback_image — placeholder when no suitable entry exists.
*
* Dédalo-hosted URLs are versioned by its file (get_media_url, ?v=<file_time>-<size>).
*
* Side effects:
*   - Attaches two event listeners on the <img>: 'load' and 'error'.
*   - Attaches a 'click' listener delegating to handler_open_viewer (bound to self),
*     which opens a 320×240 popup or triggers the upload tool if no file exists yet.
*   - When self.permissions < 2 (read-only), suppresses the browser context menu on
*     the image to help protect media from casual right-click downloads.
*   - Sets image.open_window_features = { width: 320, height: 240 } so that
*     handler_open_viewer opens the viewer popup at the correct compact size.
*
* @param {Object} self - Component instance; must expose self.data, self.tools,
*   self.permissions, self.tipo, self.section_tipo, self.section_id.
* @param {Object} options - View rendering options.
* @param {string} [options.render_level='full'] - Pass 'content' to return only the
*   inner content_data node; any other value returns the full wrapper.
* @returns {HTMLElement} wrapper (full mode) or content_data (content mode).
*/
view_mosaic_list_image.render = function(self, options) {

	// options
		const render_level = options.render_level || 'full'

	// content_data
		const content_data = get_content_data(self)
		if (render_level==='content') {
			return content_data
		}

	// wrapper
		const wrapper = ui.component.build_wrapper_list(self, {
			autoload : false
		})
		wrapper.classList.add('media','media_wrapper')
		wrapper.appendChild(content_data)
		// add pointers
		wrapper.content_data = content_data


	return wrapper
}//end render



/**
* GET_CONTENT_DATA
* Builds the inner content_data <div> containing the lazy-loaded thumbnail <img>.
*
* This function is module-private (not exported). It is called by render() both for
* the initial full render and (via render_level='content') for partial re-renders.
*
* URL resolution cascade (same as the module-level description):
*   external_source → quality-matched entry from data.entries → fallback_image.
*
* The quality key used is page_globals.dedalo_quality_thumb (a string such as '1.5MB').
* Each entry in data.entries must have a 'quality' string field to be matched.
*
* The image is initially hidden (class 'hidden link') and revealed by the 'load' event
* to avoid a flash of broken layout while the network request is in flight. The 'link'
* class signals to the stylesheet that this image is interactive (clickable).
*
* (!) The call to ui.set_background_image(this, content_data) inside set_bg_color is
*     commented out. That helper extracted the dominant background colour from the image
*     and applied it to the container. The feature has been disabled; the commented call
*     is retained for reference.
*
* @param {Object} self - Component instance (same contract as render's self parameter).
* @returns {HTMLElement} content_data - The assembled content container <div>.
*/
const get_content_data = function(self) {

	// short vars
		const data				= self.data || {}
		const entries			= data.entries || [] // value is a files_info list
		const files_info		= entries
		const external_source	= data.external_source

	// content_data
		const content_data = ui.component.build_content_data(self, {})

	// url
		const quality	= page_globals.dedalo_quality_thumb // '1.5MB'
		const file_info	= files_info.find(item => item.quality===quality)
		// Resolution cascade: external URI → Dédalo media server path → fallback placeholder.
		const url		= external_source
			? external_source
			: file_info
				? get_media_url(file_info)
				: page_globals.fallback_image

	// image
		// Start hidden with class 'link'; the load event below reveals it to prevent
		// a flash of broken layout while the network request is in flight.
		const image = ui.create_dom_element({
			element_type	: 'img',
			class_name		: 'hidden link', // loading
			parent			: content_data
		})
		image.draggable = false
		image.loading = 'lazy'
		image.decoding = 'async'

		// tells handler_open_viewer window dimensions
		// handler_open_viewer reads e.srcElement.open_window_features to size the popup.
		// 320×240 keeps the viewer compact for the dense mosaic grid context.
		image.open_window_features = {
			width	: 320,
			height	: 240
		}

	// load event
		image.addEventListener('load', set_bg_color, false)
		function set_bg_color() {
			this.removeEventListener('load', set_bg_color, false)
			// ui.set_background_image(this, content_data)
			image.classList.remove('hidden')
		}

	// error event
		// If the primary URL fails (e.g. the file was deleted or is still processing),
		// fall back to the global placeholder. Guard against infinite retry: only swap
		// the src once, not if the fallback itself fails.
		image.addEventListener('error', function(){
			if (image.src!==page_globals.fallback_image) {
				image.src = page_globals.fallback_image
			}
		}, false)

	// set source url
		// Setting src after all listeners are attached ensures the load/error handlers
		// are registered before the browser begins the network request.
		image.src = url

	// permissions control
	// set on read only permissions, remove the context menu
		if(self.permissions < 2){
			image.addEventListener("contextmenu", (e) => {
				e.preventDefault();
				return false
			});
		}

	// open viewer
	//open viewer. Media common handler for 3d, av, image, pdf, svg
	// handler_open_viewer is bound to self (the component instance) so it can access
	// self.data, self.permissions, self.tools, and self.tipo. It opens the full-screen
	// viewer popup or triggers the upload tool when no uploadable file exists yet.
	// (!) Uses 'click' (not 'mousedown') unlike view_default_list_image, which fires on mousedown.
	image.addEventListener('click', handler_open_viewer.bind(self))

	return content_data
}//end get_content_data



// @license-end
