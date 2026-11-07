// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_label, page_globals, SHOW_DEBUG, DEDALO_CORE_URL*/
/*eslint no-undef: "error"*/



// imports
	import {ui} from '../../common/js/ui.js'
	import {handler_open_viewer} from '../../component_media_common/js/component_media_common.js'
	import {get_media_url} from '../../component_media_common/js/media_url.js'



/**
* VIEW_DEFAULT_LIST_IMAGE
* Read-only thumbnail renderer for component_image in list/grid contexts.
*
* This view is used when component_image is rendered inside a record list
* (mode='list', view='default'). It produces a single <img> element inside a
* standard list wrapper. Clicking the image delegates to handler_open_viewer,
* which either opens the full-quality viewer window or, when no file exists yet
* and the user has write permission, triggers the upload tool.
*
* Contrast with view_default_edit_image (SVG-overlay editor, multi-quality
* selector) and view_mini_image (compact thumbnail without viewer launch).
*
* Data shape expected on self.data:
*   {
*     entries        : Array<{quality: string, file_path: string, file_exist: boolean, ...}>,
*     external_source: string|undefined  // full URI; bypasses DEDALO_MEDIA_URL when present
*   }
*
* Globals consumed (declared in the /*global* / pragma above):
*   - page_globals.dedalo_quality_thumb  — string key selecting which quality entry to display
*   - page_globals.fallback_image        — URL of the placeholder shown when no file matches
*   - DEDALO_MEDIA_URL                   — base URL prepended to file_path values
*
* (!) DEDALO_MEDIA_URL is not listed in the /*global* / pragma. It is used at runtime as a
*     browser global injected by the page bootstrap. The eslint pragma only declares symbols
*     that the linter must not flag; DEDALO_MEDIA_URL appears to be intentionally omitted.
*     Flag: consider adding DEDALO_MEDIA_URL to the /*global* / declaration to keep the
*     eslint contract consistent with view_default_edit_image.js and view_mini_image.js.
*
* Exports:
*   view_default_list_image          — constructor (always returns true; acts as namespace)
*   view_default_list_image.render   — static render factory; returns an HTMLElement
*/



/**
* VIEW_DEFAULT_LIST_IMAGE
* Namespace constructor for the list-mode image view.
* Always returns true; the real work is on the static render method below.
* Follows the Dédalo view module convention shared by all view_* files.
*/
export const view_default_list_image = function() {

	return true
}//end view_default_list_image



/**
* RENDER
* Builds and returns the DOM subtree for one component_image instance in list mode.
*
* The subtree consists of a single wrapper <div> containing a lazy-loaded <img>.
* URL resolution priority (highest to lowest):
*   1. data.external_source  — arbitrary external URI (bypasses the media server)
*   2. entries entry matching page_globals.dedalo_quality_thumb — Dédalo-hosted file
*   3. page_globals.fallback_image — placeholder when no suitable entry exists
*
* Dédalo-hosted URLs are versioned by its file (get_media_url, ?v=<file_time>-<size>).
*
* Side effects:
*   - Appends the <img> to the returned wrapper element.
*   - Attaches three event listeners on the image (load, error, mousedown).
*   - Sets image.open_window_features so that handler_open_viewer can open the
*     viewer popup at the correct size (720×540).
*
* @param {Object} self - Component instance; must expose self.data, self.tools,
*   self.permissions, self.tipo, self.section_tipo, self.section_id.
* @param {Object} options - View rendering options (currently unused in this view
*   but present for interface parity with other render methods).
* @returns {HTMLElement} wrapper - The assembled list-item wrapper <div>.
*/
view_default_list_image.render = function(self, options) {

	// short vars
		const data				= self.data || {}
		const entries			= data.entries || [] // value is a files_info list
		const files_info		= entries
		const external_source	= data.external_source

	// wrapper
		// Produces a <div> with standard list + media CSS classes so the shared
		// stylesheet can apply grid/thumbnail layout rules uniformly.
		const wrapper = ui.component.build_wrapper_list(self, {
			add_styles : ['media','media_wrapper']
		})

	// url
		// Select the thumbnail quality entry. dedalo_quality_thumb is a string
		// key (e.g. '1.5MB') that matches the 'quality' field in each files_info entry.
		const quality	= page_globals.dedalo_quality_thumb
		const file_info	= files_info.find(item => item.quality===quality)
		// Resolution cascade: external URI → Dédalo media server path → fallback placeholder.
		const url		= external_source
			? external_source
			: file_info
				? get_media_url(file_info)
				: page_globals.fallback_image

	// image
		// Start hidden; the load event below reveals it to prevent a flash of broken layout
		// while the network request is in flight.
		const image = ui.create_dom_element({
			element_type	: 'img',
			class_name		: 'hidden',
			parent			: wrapper
		})
		image.draggable	= false
		image.loading	= 'lazy'
		image.decoding	= 'async'
		// tells handler_open_viewer window dimensions
		// handler_open_viewer reads e.srcElement.open_window_features to size the popup.
		// These dimensions are intentionally smaller than the default (1024×720) to keep
		// the viewer compact for image previews in list context.
		image.open_window_features = {
			width	: 720,
			height	: 540
		}

	// load event
		// Reveal the image once it has fully loaded to avoid a layout jump.
		// (!) ui.set_background_image(this, wrapper) is commented out — it was used to
		//     extract the dominant background colour from the image and apply it to the
		//     wrapper. The feature has been disabled but the call is kept for reference.
		image.addEventListener('load', set_bg_color, false)
		function set_bg_color() {
			this.removeEventListener('load', set_bg_color, false)
			// ui.set_background_image(this, wrapper)
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

	// open viewer. Media common handler for 3d, av, image, pdf, svg
		// handler_open_viewer is bound to self (the component instance) so it can
		// access self.data, self.permissions, self.tools, and self.tipo.
		// It either opens the full-screen viewer popup or triggers the upload tool
		// when no uploadable file exists yet.
		image.addEventListener('click', handler_open_viewer.bind(self))


	return wrapper
}//end render



// @license-end
