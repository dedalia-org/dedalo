// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*eslint no-undef: "error"*/



/**
* RENDER_OBJECT_VIEWER
* DOM for the "Objects" panel: v6's two lists, Vector / Rasterized Objects
* (`special_tools_objects.js` `create_containers`), rebuilt on every open and
* on a live publish while open (`object_viewer.js`), never at attach: the
* panel starts hidden. Mutations go through `self.<method>(...)`.
*
* @module render_object_viewer
*/



import {ui} from '../../../core/common/js/ui.js'
import {eye_node} from './icons.js'



/**
* RENDER_OBJECT_VIEWER_PANEL
* Populates the panel shell `toolbar.js` create_toolbar_panel built with the
* two empty list sections; `populate_object_viewer` fills them on open.
*
* @param {Object} self - tool_uca_maps instance
* @param {HTMLElement} panel - the panel shell (`toolbar.js` create_toolbar_panel)
* @returns {HTMLElement} panel
*/
export const render_object_viewer_panel = function(self, panel) {

	// the header (title + ×) is toolbar.js's: the panel opens centred

	create_object_list_section(
		self, panel,
		self.get_tool_label('object_viewer_vector_title') || 'Vector Objects',
		'uca-maps-object-viewer-vector-list'
	)
	create_object_list_section(
		self, panel,
		self.get_tool_label('object_viewer_raster_title') || 'Rasterized Objects',
		'uca-maps-object-viewer-raster-list'
	)

	return panel
}//end render_object_viewer_panel



/**
* CREATE_OBJECT_LIST_SECTION
* One `<h5>` title + its empty `<ul>`, the shape both lists share; filled
* later by `render_list`, found by `list_class`.
*
* @param {Object} self - tool_uca_maps instance
* @param {HTMLElement} panel
* @param {string} title
* @param {string} list_class - the specific class (…-vector-list / …-raster-list)
*   `populate_object_viewer` queries back to find this exact list
* @returns {void}
*/
const create_object_list_section = function(self, panel, title, list_class) {

	ui.create_dom_element({
		element_type	: 'h5',
		class_name		: 'uca-maps-object-viewer-title',
		text_content	: title,
		parent			: panel
	})
	ui.create_dom_element({
		element_type	: 'ul',
		class_name		: 'uca-maps-object-viewer-list ' + list_class,
		parent			: panel
	})

}//end create_object_list_section



/**
* POPULATE_OBJECT_VIEWER
* Rebuilds both `<ul>` lists from `self.collect_objects()`'s snapshot, whole,
* as v6 rebuilds on open: no incremental diff to get wrong.
*
* @param {Object} self - tool_uca_maps instance
* @param {HTMLElement} panel
* @returns {HTMLElement} panel
*/
export const populate_object_viewer = function(self, panel) {

	const {vector_objects, raster_objects} = self.collect_objects()

	render_list(
		self,
		panel.querySelector('.uca-maps-object-viewer-vector-list'),
		vector_objects,
		self.get_tool_label('object_viewer_empty_vector') || 'No vector objects yet.'
	)
	render_list(
		self,
		panel.querySelector('.uca-maps-object-viewer-raster-list'),
		raster_objects,
		self.get_tool_label('object_viewer_empty_raster') || 'No rasterized objects yet.'
	)

	return panel
}//end populate_object_viewer



/**
* RENDER_LIST
* One `<ul>`'s rows: a show/hide checkbox, the name (ellipsis by CSS rather
* than v6's `max_length_str` truncation) and v6's "eye" button
* (`icon-view-object`) that centers the map on it.
*
* @param {Object} self - tool_uca_maps instance
* @param {HTMLElement} list - the `<ul>` to (re)fill
* @param {Array} objects - `collect_objects` entries: {layer, name, display}
* @param {string} empty_label
* @returns {void}
*/
const render_list = function(self, list, objects, empty_label) {

	list.replaceChildren()

	if (objects.length===0) {
		ui.create_dom_element({
			element_type	: 'li',
			class_name		: 'uca-maps-empty-state',
			text_content	: empty_label,
			parent			: list
		})
		return
	}

	const center_label = self.get_tool_label('object_viewer_center_button') || 'Center'

	for (const {layer, name, display} of objects) {

		const item = ui.create_dom_element({element_type: 'li', class_name: 'uca-maps-object-viewer-item', parent: list})

		const checkbox = ui.create_dom_element({
			element_type	: 'input',
			class_name		: 'uca-maps-object-viewer-checkbox',
			title			: self.get_tool_label('object_viewer_display_toggle') || 'Show/Hide',
			checked			: display,
			parent			: item
		})
		checkbox.type = 'checkbox'
		checkbox.addEventListener('change', () => self.set_object_display(layer, checkbox.checked))

		ui.create_dom_element({
			element_type	: 'span',
			class_name		: 'uca-maps-object-viewer-name',
			text_content	: name,
			title			: name,
			parent			: item
		})

		const center_btn = ui.create_dom_element({
			element_type	: 'button',
			class_name		: 'uca-maps-object-viewer-center',
			title			: center_label,
			parent			: item
		})
		center_btn.appendChild(eye_node())
		center_btn.type = 'button'
		center_btn.setAttribute('aria-label', center_label) // icon-only: title alone is not an accessible name
		center_btn.addEventListener('click', () => self.center_on_object(layer))

	}
}//end render_list



// @license-end
