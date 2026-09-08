// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*eslint no-undef: "error"*/



/**
* RENDER_WMS_SERVICES
* DOM for the "WMS" panel (functionality #6). Shell (header + search form +
* both list containers) built once at attach — the URL input must survive a
* reopen mid-typing; both lists rebuild from `self._wms_search_results`/
* `self.wms_layers` on every search/mutation (same split as
* `render_xyz_basemaps.js`). Mutations reach `self.<method>(...)`, never
* `wms_services.js` directly.
*
* @module render_wms_services
*/



import {ui} from '../../../core/common/js/ui.js'



/**
* RENDER_WMS_SERVICES_PANEL
* @param {Object} self - tool_uca_maps instance
* @param {HTMLElement} panel - the panel shell (toolbar.js create_toolbar_panel)
* @returns {HTMLElement} panel
*/
export const render_wms_services_panel = function(self, panel) {

	const header = ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'uca-maps-panel-header',
		parent			: panel
	})
	ui.create_dom_element({
		element_type	: 'span',
		class_name		: 'uca-maps-panel-title',
		text_content	: self.get_tool_label('wms_control_title') || 'WMS services',
		parent			: header
	})

	render_search_form(self, panel)

	ui.create_dom_element({
		element_type	: 'h5',
		class_name		: 'uca-maps-wms-list-title',
		text_content	: self.get_tool_label('wms_results_title') || 'Available layers',
		parent			: panel
	})
	ui.create_dom_element({element_type: 'ul', class_name: 'uca-maps-wms-results', parent: panel})

	ui.create_dom_element({
		element_type	: 'h5',
		class_name		: 'uca-maps-wms-list-title',
		text_content	: self.get_tool_label('wms_added_title') || 'Added layers',
		parent			: panel
	})
	ui.create_dom_element({element_type: 'ul', class_name: 'uca-maps-wms-list', parent: panel})

	return panel
}//end render_wms_services_panel



/**
* SHOW_WMS_MESSAGE
* Plain in-flow error/status line — NOT `ui.show_message`'s page-level toast,
* clipped by this panel's own `overflow-y: auto` (same reasoning as
* `render_xyz_basemaps.js` `show_xyz_message`).
*
* @param {HTMLElement} panel
* @param {string} text
* @returns {void}
*/
const show_wms_message = function(panel, text) {
	const message = panel.querySelector('.uca-maps-wms-message')
	message.textContent	= text
	message.hidden			= false
}//end show_wms_message



/**
* RENDER_SEARCH_FORM
* URL input + "Buscar capas"/"Limpiar búsqueda" buttons — v6's own field set
* (`special_tools_wms.js` load_modal), same flex-column shape as
* `render_xyz_basemaps.js` render_add_form.
*
* @param {Object} self
* @param {HTMLElement} panel
* @returns {void}
*/
const render_search_form = function(self, panel) {

	const form = ui.create_dom_element({element_type: 'div', class_name: 'uca-maps-wms-search-form', parent: panel})

	const message = ui.create_dom_element({element_type: 'div', class_name: 'uca-maps-wms-message', parent: form})
	message.hidden = true

	const url_input = ui.create_dom_element({element_type: 'input', class_name: 'uca-maps-wms-input uca-maps-wms-url', parent: form})
	url_input.type			= 'text'
	url_input.placeholder	= self.get_tool_label('wms_url_placeholder') || 'WMS server URL'

	const button_row = ui.create_dom_element({element_type: 'div', class_name: 'uca-maps-wms-button-row', parent: form})

	const search_btn = ui.create_dom_element({
		element_type	: 'button',
		class_name		: 'uca-maps-wms-search-button',
		text_content	: self.get_tool_label('wms_search_button') || 'Search layers',
		parent			: button_row
	})
	search_btn.type = 'button'
	search_btn.addEventListener('click', async () => {

		search_btn.disabled = true
		const result = await self.search_wms_layers(url_input.value)
		search_btn.disabled = false

		if (!result.ok) {
			show_wms_message(panel, result.error)
			panel.querySelector('.uca-maps-wms-results').replaceChildren()
			return
		}

		message.hidden = true
		if (result.layers.length===0) {
			show_wms_message(panel, self.get_tool_label('wms_no_layers') || 'No queryable layers found on this server.')
		}
		populate_wms_search_results(self, panel)

	})

	const clear_btn = ui.create_dom_element({
		element_type	: 'button',
		class_name		: 'uca-maps-wms-clear-button',
		text_content	: self.get_tool_label('wms_clear_button') || 'Clear search',
		parent			: button_row
	})
	clear_btn.type = 'button'
	clear_btn.addEventListener('click', () => {
		self.clear_wms_search()
		message.hidden = true
		url_input.value = ''
		populate_wms_search_results(self, panel)
	})

}//end render_search_form



/**
* POPULATE_WMS_SEARCH_RESULTS
* Rebuilds the "Available layers" `<ul>` from `self._wms_search_results` —
* called after every search/clear, same "no incremental diff" reasoning as
* `render_xyz_basemaps.js` populate_xyz_basemaps.
*
* @param {Object} self - tool_uca_maps instance
* @param {HTMLElement} panel
* @returns {void}
*/
export const populate_wms_search_results = function(self, panel) {

	const list = panel.querySelector('.uca-maps-wms-results')
	list.replaceChildren()

	const search_results = self._wms_search_results
	if (!search_results) {
		return
	}

	search_results.layers.forEach((layer) => {

		const item = ui.create_dom_element({element_type: 'li', class_name: 'uca-maps-wms-result-item', parent: list})

		ui.create_dom_element({
			element_type	: 'span',
			class_name		: 'uca-maps-wms-result-title',
			text_content	: layer.title,
			title			: layer.name,
			parent			: item
		})

		const add_btn = ui.create_dom_element({
			element_type	: 'button',
			class_name		: 'uca-maps-wms-result-add',
			text_content	: self.get_tool_label('wms_add_button') || 'Add',
			parent			: item
		})
		add_btn.type = 'button'
		add_btn.addEventListener('click', () => {
			self.add_wms_layer({url: search_results.base_url, name: layer.name, title: layer.title})
			populate_wms_layers(self, panel)
		})

	})

}//end populate_wms_search_results



/**
* POPULATE_WMS_LAYERS
* Rebuilds the "Added layers" `<ul>` from `self.wms_layers` — called on every
* open and after every mutation (add/toggle/opacity/delete). Show/hide is a
* checkbox, same convention as `render_object_viewer.js` (functionality #4),
* not v6's own icon-swap button (this port has no view.png/hide.png asset).
*
* @param {Object} self - tool_uca_maps instance
* @param {HTMLElement} panel
* @returns {void}
*/
export const populate_wms_layers = function(self, panel) {

	const list = panel.querySelector('.uca-maps-wms-list')
	list.replaceChildren()

	self.wms_layers.forEach((layer, index) => {

		const item = ui.create_dom_element({element_type: 'li', class_name: 'uca-maps-wms-item', parent: list})

		const checkbox = ui.create_dom_element({element_type: 'input', class_name: 'uca-maps-wms-checkbox', parent: item})
		checkbox.type		= 'checkbox'
		checkbox.checked	= layer.visible
		checkbox.title		= self.get_tool_label('wms_display_toggle') || 'Show/Hide'
		checkbox.addEventListener('change', () => self.toggle_wms_layer(index))

		ui.create_dom_element({
			element_type	: 'span',
			class_name		: 'uca-maps-wms-item-title',
			text_content	: layer.title,
			title			: layer.url,
			parent			: item
		})

		const opacity_input = ui.create_dom_element({
			element_type: 'input', class_name: 'uca-maps-wms-opacity', value: layer.opacity, parent: item
		})
		opacity_input.type		= 'range'
		opacity_input.min		= 0
		opacity_input.max		= 1
		opacity_input.step		= 0.1
		opacity_input.title		= self.get_tool_label('wms_opacity_title') || 'Opacity'
		opacity_input.addEventListener('input', () => self.set_wms_layer_opacity(index, opacity_input.value))

		const delete_btn = ui.create_dom_element({element_type: 'button', class_name: 'uca-maps-wms-delete', text_content: '✕', parent: item})
		delete_btn.type	= 'button'
		delete_btn.title	= self.get_tool_label('wms_delete_button') || 'Delete'
		delete_btn.addEventListener('click', () => {
			self.delete_wms_layer(index)
			populate_wms_layers(self, panel)
		})

	})

}//end populate_wms_layers



// @license-end
