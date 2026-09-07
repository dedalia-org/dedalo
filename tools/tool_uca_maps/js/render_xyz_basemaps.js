// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*eslint no-undef: "error"*/



/**
* RENDER_XYZ_BASEMAPS
* DOM for the "XYZ" panel (functionality #5). Shell (header + add-form)
* built once at attach — inputs must survive a reopen mid-typing; the list
* rebuilds from `self.basemaps` on every open/mutation (same split as
* `render_object_console.js`'s properties editor). Mutations reach
* `self.<method>(...)`, never `xyz_basemaps.js` directly.
*
* @module render_xyz_basemaps
*/



import {ui} from '../../../core/common/js/ui.js'



/**
* RENDER_XYZ_BASEMAPS_PANEL
* @param {Object} self - tool_uca_maps instance
* @param {HTMLElement} panel - the panel shell (toolbar.js create_toolbar_panel)
* @returns {HTMLElement} panel
*/
export const render_xyz_basemaps_panel = function(self, panel) {

	const header = ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'uca-maps-panel-header',
		parent			: panel
	})
	ui.create_dom_element({
		element_type	: 'span',
		class_name		: 'uca-maps-panel-title',
		text_content	: self.get_tool_label('xyz_control_title') || 'XYZ basemaps',
		parent			: header
	})

	render_add_form(self, panel)

	ui.create_dom_element({
		element_type	: 'h5',
		class_name		: 'uca-maps-xyz-list-title',
		text_content	: self.get_tool_label('xyz_available_title') || 'Available base maps',
		parent			: panel
	})
	ui.create_dom_element({element_type: 'ul', class_name: 'uca-maps-xyz-list', parent: panel})

	return panel
}//end render_xyz_basemaps_panel



/**
* SHOW_XYZ_MESSAGE
* Plain in-flow error line — NOT `ui.show_message`, whose page-level toast
* CSS (`top: -height`, nothing resets it) would render clipped by this
* panel's own `overflow-y: auto` (`docs/hitos/hito_9.md`).
*
* @param {HTMLElement} panel
* @param {string} text
* @returns {void}
*/
const show_xyz_message = function(panel, text) {
	const message = panel.querySelector('.uca-maps-xyz-message')
	message.textContent	= text
	message.hidden			= false
}//end show_xyz_message



/**
* RENDER_ADD_FORM
* URL/name/attribution/min-max zoom + "Add" button — v6's own field set
* (`special_tools_xyz.js` load_modal), one flex column instead of v6's
* separate labelled divs (no behaviour to preserve in the exact markup).
*
* @param {Object} self
* @param {HTMLElement} panel
* @returns {void}
*/
const render_add_form = function(self, panel) {

	const form = ui.create_dom_element({element_type: 'div', class_name: 'uca-maps-xyz-add-form', parent: panel})

	const message = ui.create_dom_element({element_type: 'div', class_name: 'uca-maps-xyz-message', parent: form})
	message.hidden = true

	const url_input = ui.create_dom_element({element_type: 'input', class_name: 'uca-maps-xyz-input uca-maps-xyz-url', parent: form})
	url_input.type			= 'text'
	url_input.placeholder	= self.get_tool_label('xyz_url_placeholder') || 'Base map URL (required)'

	const name_input = ui.create_dom_element({element_type: 'input', class_name: 'uca-maps-xyz-input uca-maps-xyz-name', parent: form})
	name_input.type			= 'text'
	name_input.placeholder	= self.get_tool_label('xyz_name_placeholder') || 'Base map name (required)'

	const attribution_input = ui.create_dom_element({element_type: 'input', class_name: 'uca-maps-xyz-input uca-maps-xyz-attribution', parent: form})
	attribution_input.type			= 'text'
	attribution_input.placeholder	= self.get_tool_label('xyz_attribution_placeholder') || 'Attribution (optional)'

	const zoom_row = ui.create_dom_element({element_type: 'div', class_name: 'uca-maps-xyz-zoom-row', parent: form})
	const minzoom_input = ui.create_dom_element({
		element_type: 'input', class_name: 'uca-maps-xyz-input uca-maps-xyz-minzoom', value: 0, parent: zoom_row
	})
	minzoom_input.type	= 'number'
	minzoom_input.title	= self.get_tool_label('xyz_minzoom_title') || 'Min zoom (0-22)'
	const maxzoom_input = ui.create_dom_element({
		element_type: 'input', class_name: 'uca-maps-xyz-input uca-maps-xyz-maxzoom', value: 22, parent: zoom_row
	})
	maxzoom_input.type	= 'number'
	maxzoom_input.title	= self.get_tool_label('xyz_maxzoom_title') || 'Max zoom (0-22)'

	const add_btn = ui.create_dom_element({
		element_type	: 'button',
		class_name		: 'uca-maps-xyz-add-button',
		text_content	: self.get_tool_label('xyz_add_button') || 'Add base map',
		parent			: form
	})
	add_btn.type = 'button'
	add_btn.addEventListener('click', () => {

		const result = self.add_basemap({
			url			: url_input.value,
			name		: name_input.value,
			attribution	: attribution_input.value,
			minzoom		: minzoom_input.value,
			maxzoom		: maxzoom_input.value
		})

		if (!result.ok) {
			show_xyz_message(panel, result.error)
			return
		}

		message.hidden = true
		url_input.value			= ''
		name_input.value			= ''
		attribution_input.value	= ''
		minzoom_input.value		= 0
		maxzoom_input.value		= 22

		populate_xyz_basemaps(self, panel)

	})

}//end render_add_form



/**
* POPULATE_XYZ_BASEMAPS
* Rebuilds the `<ul>` from `self.basemaps` — called on every open and after
* every mutation (add/delete/move), same "no incremental diff" reasoning as
* `render_object_viewer.js`'s populate_object_viewer.
*
* @param {Object} self - tool_uca_maps instance
* @param {HTMLElement} panel
* @returns {void}
*/
export const populate_xyz_basemaps = function(self, panel) {

	const list = panel.querySelector('.uca-maps-xyz-list')
	list.replaceChildren()

	self.basemaps.forEach((basemap, index) => {

		const item = ui.create_dom_element({element_type: 'li', class_name: 'uca-maps-xyz-item', parent: list})

		ui.create_dom_element({
			element_type	: 'span',
			class_name		: 'uca-maps-xyz-item-name',
			text_content	: basemap.name,
			title			: basemap.url,
			parent			: item
		})

		const controls = ui.create_dom_element({element_type: 'div', class_name: 'uca-maps-xyz-item-controls', parent: item})

		const up_btn = ui.create_dom_element({element_type: 'button', class_name: 'uca-maps-xyz-move-up', text_content: '▲', parent: controls})
		up_btn.type		= 'button'
		up_btn.title		= self.get_tool_label('xyz_move_up_button') || 'Move up'
		up_btn.disabled	= index===0
		up_btn.addEventListener('click', () => {
			self.move_basemap(index, -1)
			populate_xyz_basemaps(self, panel)
		})

		const down_btn = ui.create_dom_element({element_type: 'button', class_name: 'uca-maps-xyz-move-down', text_content: '▼', parent: controls})
		down_btn.type		= 'button'
		down_btn.title		= self.get_tool_label('xyz_move_down_button') || 'Move down'
		down_btn.disabled	= index===self.basemaps.length-1
		down_btn.addEventListener('click', () => {
			self.move_basemap(index, 1)
			populate_xyz_basemaps(self, panel)
		})

		const delete_btn = ui.create_dom_element({element_type: 'button', class_name: 'uca-maps-xyz-delete', text_content: '✕', parent: controls})
		delete_btn.type	= 'button'
		delete_btn.title	= self.get_tool_label('xyz_delete_button') || 'Delete'
		delete_btn.addEventListener('click', () => {
			const result = self.delete_basemap(index)
			if (!result.ok && result.error) {
				show_xyz_message(panel, result.error)
				return
			}
			panel.querySelector('.uca-maps-xyz-message').hidden = true
			populate_xyz_basemaps(self, panel)
		})

	})

}//end populate_xyz_basemaps



// @license-end
