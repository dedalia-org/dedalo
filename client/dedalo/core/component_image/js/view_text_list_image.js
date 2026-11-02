// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_label, page_globals, SHOW_DEBUG, DEDALO_CORE_URL*/
/*eslint no-undef: "error"*/



// imports
	import {ui} from '../../common/js/ui.js'
	import {get_media_url} from '../../component_media_common/js/media_url.js'



/**
* VIEW_TEXT_LIST_IMAGE
* Inline thumbnail renderer for component_image when view='text'.
*
* Used when a component_image instance must be embedded inside flowing text or a
* compact text-list context (e.g. a grid cell that mixes labels and images).
* Unlike view_default_list_image — which produces a block-level <div> wrapper via
* ui.component.build_wrapper_list — this view wraps the <img> in an inline <span>
* so the element participates in normal text flow without breaking the surrounding
* layout.
*
* The view is selected by render_list_component_image.prototype.list when
* self.context.view === 'text'.
*
* Data shape expected on self.data:
*   {
*     entries        : Array<{quality: string, file_path: string, ...}>,
*     external_source: string|undefined  // full URI; bypasses DEDALO_MEDIA_URL when present
*   }
*
* Globals consumed (declared in the /*global* / pragma above):
*   - page_globals.dedalo_quality_thumb — string key that selects the quality entry to display
*   - page_globals.fallback_image       — URL of the placeholder shown when no file matches
*   - DEDALO_MEDIA_URL                  — base URL prepended to entries[].file_path values
*
* (!) DEDALO_MEDIA_URL is used at runtime but is NOT listed in the /*global* / pragma.
*     It is injected as a browser-side global by the page bootstrap, so the linter silently
*     accepts it via eslint no-undef suppression on the pragma level. For consistency with
*     other view_* files in this directory, consider adding DEDALO_MEDIA_URL to the pragma.
*
* Exports:
*   view_text_list_image         — constructor (always returns true; acts as a namespace)
*   view_text_list_image.render  — static render factory; returns an HTMLElement
*/



/**
* VIEW_TEXT_LIST_IMAGE
* Namespace constructor for the text/inline image view.
* Always returns true; the real work is on the static render method below.
* Follows the Dédalo view module convention shared by all view_* files.
*/
export const view_text_list_image = function() {

	return true
}//end view_text_list_image



/**
* RENDER
* Builds and returns an inline DOM subtree for one component_image instance in text-list mode.
*
* The subtree consists of a <span> (inline element) containing a single <img>.
* Using <span> instead of a block wrapper keeps the image in the text flow and avoids
* unwanted line breaks when the component is placed alongside text labels.
*
* URL resolution priority (highest to lowest):
*   1. data.external_source  — arbitrary external URI (bypasses the media server entirely)
*   2. entries entry matching page_globals.dedalo_quality_thumb — Dédalo-hosted thumbnail
*   3. page_globals.fallback_image — placeholder shown when no suitable entry exists
*
* Dédalo-hosted URLs are versioned by its file (get_media_url, ?v=<file_time>-<size>).
*
* The <img> element is created with document.createElement directly (rather than via
* ui.create_dom_element) so that the src assignment and the error listener can be set
* up in the exact same order as in view_mini_image.js, keeping the two minimal views
* structurally identical and easy to diff.
*
* Side effects:
*   - Creates and appends one <img> element to the returned <span> wrapper.
*   - Attaches an 'error' event listener on the image for fallback handling.
*
* (!) options is accepted for interface parity with other render methods but is not
*     used by this view. There is no viewer launch on click, unlike view_default_list_image.
*
* @param {Object} self - Component instance. Must expose:
*   self.data        — data object with entries array and optional external_source string
*   self.model       — component model name string (used as a CSS class)
*   self.mode        — render mode string (e.g. 'list'; used as a CSS class)
*   self.view        — view name string (e.g. 'text'; used as a CSS class)
* @param {Object} options - Render options forwarded from the caller. Currently unused
*   by this view but present for interface parity with other view modules.
* @returns {HTMLElement} wrapper - An inline <span> containing the resolved <img>.
*/
view_text_list_image.render = function(self, options) {

	// short vars
		const data				= self.data || {}
		const entries			= data.entries || [] // value is a files_info list
		const files_info		= entries
		const external_source	= data.external_source

	// url
		// dedalo_quality_thumb is a string key (e.g. '1.5MB') that must match the
		// 'quality' field on one of the entries objects returned by the server.
		const quality	= page_globals.dedalo_quality_thumb // '1.5MB'
		const file_info	= files_info.find(item => item.quality===quality)
		// Resolution cascade: prefer an explicit external URI over a Dédalo-hosted
		// file, falling back to the global placeholder when neither is available.
		const url		= external_source
			? external_source
			: file_info
				? get_media_url(file_info)
				: page_globals.fallback_image

	// wrapper
		// A <span> (inline element) rather than a block <div> keeps the image in normal
		// text flow so it can sit alongside text labels without forcing a line break.
		// CSS classes mirror the standard component wrapper convention so the shared
		// stylesheet still applies model/mode/view-specific rules.
		const wrapper = ui.create_dom_element({
			element_type	: 'span',
			class_name		: `wrapper_component ${self.model} ${self.mode} media view_${self.view}`
		})

	// image
		const image	= document.createElement('img')
		// a11y (WCAG 1.1.1): the text view has no label beside the image — name it
		image.alt		= self.label ?? ''
		image.loading	= 'lazy'
		image.decoding	= 'async'
		// error event
		// Guard against infinite retry: only swap src to the fallback once.
		// If the fallback itself fails to load, the broken-image icon will show
		// rather than triggering another error → src assignment loop.
		image.addEventListener('error', function(){
			if (image.src!==page_globals.fallback_image) {
				image.src = page_globals.fallback_image
			}
		})
		// Setting src after the error listener is registered ensures the handler
		// is in place before the browser initiates the network request.
		image.src = url
		wrapper.appendChild(image)


	return wrapper
}//end render



// @license-end
