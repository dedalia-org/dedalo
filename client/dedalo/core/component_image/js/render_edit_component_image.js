// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/* global get_label, page_globals, SHOW_DEBUG */
/*eslint no-undef: "error"*/



// imports
	import {event_manager} from '../../common/js/event_manager.js'
	import {ui} from '../../common/js/ui.js'
	import {view_default_edit_image} from './view_default_edit_image.js'
	import {view_mini_image} from './view_mini_image.js'
	// rare views are lazy (CONVENTIONS S3-37 #3): the common render only needs the default view
	import {get_media_url} from '../../component_media_common/js/media_url.js'



/**
* RENDER_EDIT_COMPONENT_IMAGE
* Edit-mode render controller for component_image.
*
* Acts as the prototype source for component_image.prototype.edit (assigned in
* component_image.js). Dispatches rendering to the appropriate view module based
* on the component instance's `self.view` property, and exports the shared
* get_quality_selector helper used by view_default_edit_image.
*
* Exported symbols:
*  - render_edit_component_image  constructor (prototype host for .edit)
*  - get_quality_selector         standalone helper consumed by view modules
*/
export const render_edit_component_image = function() {

	return true
}//end render_edit_component_image



/**
* EDIT
* Entry point for edit-mode rendering. Selects and delegates to the correct view
* module based on `self.view`.
*
* Supported views:
*  - 'viewer'  — opens a standalone viewer window via view_viewer_image
*  - 'mini'    — compact thumbnail for autocomplete/list contexts via view_mini_image
*  - 'print'   — same DOM structure as 'default' but forces permissions=1 so
*                content_value renders read-only; the wrapper carries the extra
*                CSS class 'view_print' so stylesheets can target it
*  - 'line'    — same render as 'default' (no label)
*  - 'default' — full editable view with quality selector and tool buttons
*
* (!) The 'print' case intentionally falls through to 'default' — the switch
*     has no `break` after `self.permissions = 1`. This is by design: the
*     print view reuses the default DOM layout with read-only permissions.
*
* @param {Object} options - render options forwarded to the active view module
* @returns {Promise<HTMLElement>} the wrapper element produced by the chosen view
*/
render_edit_component_image.prototype.edit = async function(options) {

	const self = this

	// view
		const view = self.view || 'default'

	switch(view) {

		case 'viewer': {
			const {view_viewer_image} = await import('./view_viewer_image.js')
			return view_viewer_image.render(self, options)
		}

		case 'mini':
			return view_mini_image.render(self, options)

		case 'print':
			// view print use the same view as default, except it will use read only to render content_value
			// as different view as default it will set in the class of the wrapper
			// sample: <div class="wrapper_component component_input_text oh14 oh1_oh14 edit view_print disabled_component">...</div>
			// take account that to change the css when the component will render in print context
			// for print we need to use read of the content_value and it's necessary force permissions to use read only element render
			self.permissions = 1

		case 'line':
		case 'default':
		default:
			return view_default_edit_image.render(self, options)
	}
}//end edit



/**
* GET_QUALITY_SELECTOR
* Builds a <select> element populated with every available quality tier for the
* first image entry, filtered to the component's active file extension.
*
* The selector is shared between view_default_edit_image and other view modules
* that need to expose quality switching in the edit UI. On change it publishes
* the 'image_quality_change_'+self.id event with the new image URL as the
* payload; component_image.prototype.image_quality_change_handler (subscribed in
* init) receives that event and updates the displayed image.
*
* Data shape consumed from self:
*  self.data.entries[0].files_info — Array of file_info objects:
*    { quality: string, extension: string, file_path: string, file_exist: boolean, … }
*  self.quality         — currently active quality string (e.g. '1.5MB')
*  self.context.features.quality    — fallback quality when self.quality is unset
*  self.context.features.extension  — active file extension (e.g. 'jpg')
*
* Only file_info entries where file_exist===true and extension matches are shown.
* Duplicate qualities (same quality string, different file) are deduplicated via
* ar_resolved; the first occurrence wins.
*
* Each option's value URL is versioned by its file (get_media_url, ?v=<file_time>-<size>).
*
* @param {Object} self - component_image instance
* Returns null when fewer than two distinct qualities exist: a one-option select
* offers no choice, so it is not built (same rule as component_av).
*
* @returns {HTMLElement|null} the <select> quality selector element, or null
*/
export const get_quality_selector = (self) => {

	// short vars
		const data			= self.data || {}
		const entries		= data.entries || []
		// Only entries[0] is used: the quality selector always reflects the first image entry
		const files_info	= entries[0] && entries[0].files_info
			? entries[0].files_info
			: []
		const quality		= self.quality || self.context.features.quality
		const extension		= self.context.features.extension

	// retain only existing files of the currently active extension
		const quality_list	= files_info.filter(el => el.file_exist===true && el.extension===extension)

	// nothing to choose (a single rendition): no selector, as in component_av
		if (new Set(quality_list.map(el => el.quality)).size < 2) {
			return null
		}

	// create the quality selector
		const quality_selector = ui.create_dom_element({
			element_type	: 'select',
			class_name		: 'quality_selector'
		})
		// stop click/mousedown from bubbling to the image container and triggering
		// unintended tool-open handlers attached to ancestor nodes
		quality_selector.addEventListener('mousedown', function(e) {
			e.stopPropagation()
		})
		quality_selector.addEventListener('click', function(e) {
			e.stopPropagation()
		})
		// publish the selected image URL so image_quality_change_handler can swap
		// the displayed image without a full re-render
		quality_selector.addEventListener('change', (e) =>{
			const img_src = e.target.value
			event_manager.publish('image_quality_change_'+self.id, img_src)
		})

		// ar_resolved tracks quality strings already added to avoid duplicate <option> entries
		const ar_resolved = []
		const quality_list_len	= quality_list.length
		for (let i = 0; i < quality_list_len; i++) {

			const file_info = quality_list[i]
			// skip duplicate quality entries (same quality, different file variant)
			if (ar_resolved.find(el => el===file_info.quality)) {
				if(SHOW_DEBUG===true) {
					console.log('Skip quality already resolved:', file_info.quality, ar_resolved);
				}
				continue
			}

			// create the node with the all qualities sent by server
			// (!) file_info is always truthy here because quality_list only contains
			//     real entries, but the ternary is kept as a defensive guard
			const url = file_info
				? get_media_url(file_info)
				: null

			const select_option = ui.create_dom_element({
				element_type	: 'option',
				value			: url,
				text_node		: quality_list[i].quality,
				parent			: quality_selector
			})
			//set the default quality_list to config variable dedalo_image_quality_default
			select_option.selected = quality_list[i].quality===quality ? true : false

			ar_resolved.push(file_info.quality)
		}


	return quality_selector
}//end get_quality_selector



// @license-end
