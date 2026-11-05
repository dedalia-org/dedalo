// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_label, page_globals, SHOW_DEBUG, DEDALO_CORE_URL*/
/*eslint no-undef: "error"*/



// imports
	import {ui} from '../../common/js/ui.js'
	import {get_media_url, fallback_on_error} from '../../component_media_common/js/media_url.js'



/**
* VIEW_TAG_LIST_SVG
*
* List-mode view for component_svg that emits a lightweight SVG image element
* pre-loaded with dataset attributes consumed by the service_autocomplete "grid
* choose" picker.
*
* Role in the render pipeline:
*   render_list_component_svg.prototype.list() dispatches to this module when
*   `self.context.view === 'tag'`. The 'tag' view is requested by the
*   service_autocomplete grid when the user is selecting an SVG record from a
*   visual grid rather than from a text-based dropdown. The rendered node must
*   carry enough metadata in its dataset for service_autocomplete to identify the
*   chosen record without a second server round-trip.
*
* Data contract — `self.data` shape expected at render time:
*   {
*     entries: Array<{
*       quality    : string,   // quality tier, e.g. 'web', 'thumb', 'original'
*       file_path  : string,   // server-relative path, appended to DEDALO_MEDIA_URL
*       file_exist : boolean   // true only when the file is present on disk
*     }>
*   }
*   An empty or absent `entries` array causes a fallback to `page_globals.fallback_image`.
*
* Globals relied upon (injected by the Dédalo page bootstrap):
*   - DEDALO_MEDIA_URL         — base URL prepended to all media file_path values.
*     (!) DEDALO_MEDIA_URL is NOT listed in the /*global*\/ pragma above; it is
*     injected at runtime via page_globals / the page bootstrap.  The linter will
*     flag it as an implicit global (no-undef). This is a known, pre-existing
*     pattern shared across SVG and image view modules — do not remove it.
*   - page_globals.dedalo_quality_thumb — fallback quality key when no explicit
*     `default_quality` is configured in the ontology context features.
*   - page_globals.fallback_image       — URL of the placeholder shown when no
*     matching file entry is found.
*
* Exports:
*   view_tag_list_svg  — constructor (no-op, acts as namespace)
*   view_tag_list_svg.render(self, options) — static render method
*/
export const view_tag_list_svg = function() {

	return true
}//end view_tag_list_svg



/**
* RENDER
* Render node for use in this view, mainly used in service_autocomplete grid choose
* The default_quality (normally 'web') is preferred here but
* a fallback to thumb is used just in case
*
* Builds the list-mode wrapper for the 'tag' view of component_svg.
*
* Behaviour:
*   1. Selects the active quality tier: `self.context.features.default_quality`
*      takes precedence; falls back to `page_globals.dedalo_quality_thumb`.
*   2. Searches `data.entries` for the first entry that matches the selected
*      quality AND has `file_exist === true`.
*   3. If a matching entry is found, constructs the image URL (get_media_url,
*      versioned by its file) and creates an <img> element whose dataset carries the
*      service_autocomplete pick payload (see dataset schema below).
*   4. If no matching entry is found, no <img> is appended — the wrapper is
*      returned empty. `page_globals.fallback_image` is stored in `url` but only
*      applied inside the `if (file_info)` guard, so the fallback URL is
*      effectively unused in the current implementation.
*      (!) This means an SVG with no qualifying file silently produces an empty
*      wrapper with no visual feedback. Consider whether a fallback <img> is
*      desirable — left as-is per doc-only policy.
*
* Dataset schema placed on the <img> element (consumed by service_autocomplete):
*   {
*     tag_id : 1,            // fixed sentinel value; marks this element as a tag pick target
*     type   : 'svg',        // media type identifier used by the picker
*     state  : 'n',          // initial state flag ('n' = normal / not-selected)
*     data   : string        // JSON-like string encoding { section_tipo, section_id,
*                            //   component_tipo }; double-quotes replaced with single-quotes
*                            //   for HTML5 dataset attribute compatibility (see note below)
*   }
*
* Note on data encoding:
*   HTML5 dataset values are stored as attribute values. If the JSON string were
*   embedded verbatim, the double-quotes in JSON would conflict with the surrounding
*   attribute quotes, causing the DOM parser to truncate the value. The replacement
*   `replace(/"/g, '\'')` converts JSON double-quotes to single-quotes before
*   storage. The consumer (service_autocomplete) must reverse this to reconstruct
*   valid JSON (i.e. replace single-quotes back to double-quotes before
*   `JSON.parse()`).
*
* @param {Object} self    - Fully initialised component_svg instance. Must have:
*                           `self.data`, `self.context.features.default_quality`,
*                           `self.section_tipo`, `self.section_id`, `self.tipo`.
* @param {Object} options - Render options forwarded from
*                           render_list_component_svg.prototype.list(). Not
*                           currently read by this view; reserved for future use.
* @returns {HTMLElement} wrapper — A list-view wrapper div (built by
*                           ui.component.build_wrapper_list). Contains one <img>
*                           child when a qualifying file entry is found; empty
*                           otherwise.
*/
view_tag_list_svg.render = function(self, options) {

	// short vars
		const data			= self.data || {}
		const entries		= data.entries || [] // value is a files_info list
		const files_info	= entries

	// wrapper
		const wrapper = ui.component.build_wrapper_list(self, {})

	// quality. default quality is 'web'. Fallback to thumbnail
		const quality = self.context?.features?.default_quality || page_globals.dedalo_quality_thumb

	// media url from files_info based on selected context quality
		const file_info	= files_info.find(el => el.quality===quality && el.file_exist===true)
		const url		= file_info
			? get_media_url(file_info)
			: page_globals.fallback_image

	// svg elements
		if (file_info) {

			// convert the data_tag to string to be used it in HTML
			// replace the " to ' to be compatible with the dataset of HTML5, the tag store his data ref inside the data-data HTML
			// JSON use " but it's not compatible with the data-data storage in HTML5
				const data_string = JSON.stringify({
					section_tipo	: self.section_tipo,
					section_id		: self.section_id,
					component_tipo	: self.tipo
				}).replace(/"/g, '\'')

			// dataset (used by service_autocomplete grid choose)
				const dataset = {
					tag_id	: 1,
					type	: 'svg',
					state	: 'n',
					data	: data_string
				}

			// image node
				const image = ui.create_dom_element({
					element_type	: 'img',
					src				: url,
					class_name		: 'svg',
					dataset			: dataset,
					parent			: wrapper
				})
				image.loading	= 'lazy'
				image.decoding	= 'async'
				fallback_on_error(image)
		}


	return wrapper
}//end render



// @license-end
