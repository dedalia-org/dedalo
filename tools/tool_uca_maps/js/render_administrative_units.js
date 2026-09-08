// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*eslint no-undef: "error"*/



/**
* RENDER_ADMINISTRATIVE_UNITS
* DOM for the "UA" panel (functionality #9). Shell built once at attach: a
* level `<select>` (v6's own three options — `special_tools_UA_es.js`
* create_select) plus an in-flow message line, same shape as
* `render_wms_services.js`/`render_xyz_basemaps.js`. Mutations reach
* `self.<method>(...)`, never `administrative_units.js` directly.
*
* @module render_administrative_units
*/



import {ui} from '../../../core/common/js/ui.js'



const LEVELS = ['Municipio', 'Provincia', 'CCAA']



/**
* RENDER_ADMINISTRATIVE_UNITS_PANEL
* @param {Object} self - tool_uca_maps instance
* @param {HTMLElement} panel - the panel shell (toolbar.js create_toolbar_panel)
* @returns {HTMLElement} panel
*/
export const render_administrative_units_panel = function(self, panel) {

	const header = ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'uca-maps-panel-header',
		parent			: panel
	})
	ui.create_dom_element({
		element_type	: 'span',
		class_name		: 'uca-maps-panel-title',
		text_content	: self.get_tool_label('ua_control_title') || 'Administrative Units',
		parent			: header
	})

	const message = ui.create_dom_element({element_type: 'div', class_name: 'uca-maps-ua-message', parent: panel})
	message.hidden = true

	const select = ui.create_dom_element({element_type: 'select', class_name: 'uca-maps-ua-level-select', parent: panel})
	LEVELS.forEach((level) => {
		const option = ui.create_dom_element({
			element_type	: 'option',
			text_content	: self.get_tool_label('ua_level_' + level.toLowerCase()) || level,
			parent			: select
		})
		option.value = level
	})
	// attach_administrative_units seeds self._ua_level BEFORE calling this —
	// a second '|| Municipio' default here would just be a fork of the same
	// literal to keep in sync by hand (review-diff finding, hito 11)
	select.value = self._ua_level
	select.addEventListener('change', () => { self._ua_level = select.value })

	ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'uca-maps-ua-hint',
		text_content	: self.get_tool_label('ua_hint') || 'Click the map to look up the unit at that point.',
		parent			: panel
	})

	return panel
}//end render_administrative_units_panel



/**
* SHOW_UA_MESSAGE
* Plain in-flow error line — same reasoning as `render_wms_services.js`
* show_wms_message.
*
* @param {HTMLElement} panel
* @param {string} text
* @returns {void}
*/
export const show_ua_message = function(panel, text) {
	const message = panel.querySelector('.uca-maps-ua-message')
	message.textContent	= text
	message.hidden			= false
}//end show_ua_message



/**
* CLEAR_UA_MESSAGE
* @param {HTMLElement} panel
* @returns {void}
*/
export const clear_ua_message = function(panel) {
	panel.querySelector('.uca-maps-ua-message').hidden = true
}//end clear_ua_message



// @license-end
