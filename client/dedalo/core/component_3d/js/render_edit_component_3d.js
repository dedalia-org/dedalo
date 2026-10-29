// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global DEDALO_MEDIA_URL */
/*eslint no-undef: "error"*/



/**
* RENDER_EDIT_COMPONENT_3D
* Edit-mode render namespace for component_3d.
*
* Provides the `edit` prototype method that component_3d inherits to handle
* all edit-mode views ('default', 'line', 'print'). Actual DOM construction
* is delegated to view_default_edit_3d.render().
*
* Also exports get_quality_selector(), a standalone DOM factory used by
* view_default_edit_3d to build the <select> control for choosing the
* 3D file quality level.
*
* Consumed by:
*  - component_3d (component_3d.prototype.edit = render_edit_component_3d.prototype.edit)
*  - view_default_edit_3d (imports get_quality_selector)
*/

// imports
	import {event_manager} from '../../common/js/event_manager.js'
	import {ui} from '../../common/js/ui.js'
	import {view_default_edit_3d} from './view_default_edit_3d.js'
	import {get_media_url} from '../../component_media_common/js/media_url.js'



/**
* RENDER_EDIT_COMPONENT_3D
* Namespace constructor for the edit-mode render layer of component_3d.
* Returns true when called directly; meaningful as a prototype carrier.
* @returns {boolean} true
*/
export const render_edit_component_3d = function() {

	return true
}//end render_edit_component_3d



/**
* EDIT
* Render node for use in modes: edit
* Entry point for the component_3d edit mode. Reads `self.context.view`
* to select the appropriate sub-view, then delegates to
* view_default_edit_3d.render(self, options).
*
* Supported views:
*  - 'default' — standard full-edit layout
*  - 'line'    — compact single-line layout (label suppressed by view_default_edit_3d)
*  - 'print'   — forces read-only permissions (self.permissions = 1) then falls
*                through to the 'default' branch
*
* (!) The 'print' case has no `break` — it intentionally falls through to 'default'.
*     self.permissions is mutated here to coerce the view into read-only rendering.
*
* @param {Object} options - render options forwarded to view_default_edit_3d.render()
*   @param {string} [options.render_level='full'] - 'full' returns a complete wrapper;
*          'content' returns only the content_data element
* @returns {Promise<HTMLElement>} wrapper element built by view_default_edit_3d.render()
*/
render_edit_component_3d.prototype.edit = async function(options) {

	const self = this

	// view
		const view = self.context.view || 'default'

	switch(view) {

		case 'print':
			// for print we need to use read of the content_value and it's necessary force permissions to use read only element render
			self.permissions = 1;

		case 'line':
		case 'default':
		default:
			return view_default_edit_3d.render(self, options)
	}
}//end edit



/**
* GET_QUALITY_SELECTOR
* Builds and returns a <select> DOM element that lists every available 3D
* file quality variant for the current component entry.
*
* Data shape consumed (from self.data.entries[0].files_info):
*   files_info: Array<{
*     file_exist  : boolean,   // only files with file_exist===true are shown
*     extension   : string,    // e.g. 'glb' — filtered to match context.features.extension
*     quality     : string,    // human-readable quality label used as <option> text and
*                              // to pre-select the active quality
*     file_path   : string     // server-relative path appended to DEDALO_MEDIA_URL
*   }>
*
* On change, the selector publishes event '3d_quality_change_'+self.id with the
* selected file URL, versioned by its file (get_media_url, ?v=<file_time>-<size>).
* view_default_edit_3d subscribes to this event via quality_change_handler.
*
* mousedown and click events are stopped at the selector to prevent the
* component wrapper from intercepting them.
*
* @param {Object} self - component_3d instance
* @returns {HTMLElement} quality_selector — a <select> element populated with
*   one <option> per matching file variant; appended to a DocumentFragment
*   (caller must insert it into the document)
*/
export const get_quality_selector = (self) => {

	// short vars
		const data			= self.data || {}
		const entries		= data.entries || []
		const files_info	= entries[0] && entries[0].files_info
			? entries[0].files_info
			: []
		// active quality label from instance state or ontology features
		const quality		= self.quality || self.context.features.quality
		// target extension filter (e.g. 'glb', 'gltf')
		const extension		= self.context.features.extension

	const fragment = new DocumentFragment()

	// create the quality selector
		const quality_selector = ui.create_dom_element({
			element_type	: 'select',
			class_name		: 'quality_selector',
			parent			: fragment
		})
		// prevent bubbling so the component wrapper does not interpret these as selection gestures
		quality_selector.addEventListener('mousedown', function(e) {
			e.stopPropagation()
		})
		quality_selector.addEventListener('click', function(e) {
			e.stopPropagation()
		})
		// on selection change, publish the chosen file URL for the viewer to reload
		quality_selector.addEventListener('change', (e) =>{
			const file_url = e.target.value
			event_manager.publish('3d_quality_change_'+self.id, file_url)
		})

		// filter to only the entries that exist on disk and match the required extension
		const quality_list		= files_info.filter(el => el.file_exist===true && el.extension===extension)
		const quality_list_len	= quality_list.length
		for (let i = 0; i < quality_list_len; i++) {

			const file_info = quality_list[i]

			// create the node with the all qualities sent by server
			// versioned by its file: a re-uploaded model gets a new URL
			const url = get_media_url(file_info)

			const select_option = ui.create_dom_element({
				element_type	: 'option',
				value			: url,
				text_node		: quality_list[i].quality,
				parent			: quality_selector
			})
			//set the default quality_list to config variable dedalo_image_quality_default
			select_option.selected = quality_list[i].quality===quality ? true : false
		}


	return quality_selector
}//end get_quality_selector



// @license-end
