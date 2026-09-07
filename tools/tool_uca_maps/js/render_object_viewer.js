// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*eslint no-undef: "error"*/



/**
* RENDER_OBJECT_VIEWER
* DOM for the "Objects" panel (functionality #4 — see `object_viewer.js`
* file header for the full architecture note). Two `<ul>` lists — Vector
* Objects / Rasterized Objects — v6's own two-title-two-container layout
* (`special_tools_objects.js` `create_containers`), rebuilt from scratch on
* every SHOW (`populate_object_viewer`, called from `object_viewer.js`'s
* `toggle_object_viewer_panel` on every open, and again on a live
* `updated_layer_data_<id_base>` publish while already open — file header of
* `object_viewer.js`) — never at attach time: the panel starts hidden and
* nothing reads it before the first click, same as every sibling panel
* (`map_image_download.js`/`capabilities_panel.js` build their content lazily
* too; review-diff simplification finding, hito 4 — this used to populate
* once eagerly here AND again on first open, discarding that first build).
*
* Same render/logic split as the rest of this tool: this file only builds
* DOM and reads state; every mutation (`set_object_display`,
* `center_on_object`) is reached through `self.<method>(...)` — the thin-
* prototype-wrapper pattern (`tool_uca_maps.js`), never a direct import from
* `object_viewer.js` (the established one-directional convention across
* every render_X.js/X.js pair in tools/: logic imports render, never the
* reverse — review-diff tripwire-integrity finding, hito 2).
*
* @module render_object_viewer
*/



import {ui} from '../../../core/common/js/ui.js'



/**
* RENDER_OBJECT_VIEWER_PANEL
* Populates the panel shell `toolbar.js`'s `create_toolbar_panel` already
* built and appended to the map container — header + the two (empty) list
* sections. Content itself is filled in later, on first open
* (`populate_object_viewer` — see file header).
*
* @param {Object} self - tool_uca_maps instance
* @param {HTMLElement} panel - the panel shell (`toolbar.js` create_toolbar_panel)
* @returns {HTMLElement} panel
*/
export const render_object_viewer_panel = function(self, panel) {

	const header = ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'uca-maps-panel-header',
		parent			: panel
	})
	ui.create_dom_element({
		element_type	: 'span',
		class_name		: 'uca-maps-panel-title',
		text_content	: self.get_tool_label('object_viewer_control_title') || 'Objects',
		parent			: header
	})

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
* One `<h5>` title + its empty `<ul>` — the identical shape "Vector Objects"
* and "Rasterized Objects" both need (v6's own two-title-two-container
* layout, file header). Content is filled in later by `render_list`, keyed
* off `list_class`.
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
* Rebuilds both `<ul>` lists from `self.collect_objects()`'s current
* snapshot — destructive re-render (`replaceChildren`), matching v6's own
* rebuild-on-open behaviour (no incremental diff needed: this panel's
* content only ever changes between opens, `object_viewer.js` file header).
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
* One `<ul>`'s worth of rows: a show/hide checkbox, the object's name
* (ellipsis via CSS rather than v6's `max_length_str` JS truncation — no
* behaviour to preserve there, the audit's own row 3 note already
* established this tool builds fresh UI rather than porting v6's DOM
* verbatim wherever nothing else depends on the exact markup), and a
* "Center" button (v6's "eye" icon, `icon-view-object`).
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
			class_name		: 'uca-maps-object-viewer-placeholder',
			text_content	: empty_label,
			parent			: list
		})
		return
	}

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
			text_content	: self.get_tool_label('object_viewer_center_button') || 'Center',
			parent			: item
		})
		center_btn.type = 'button'
		center_btn.addEventListener('click', () => self.center_on_object(layer))

	}
}//end render_list



// @license-end
