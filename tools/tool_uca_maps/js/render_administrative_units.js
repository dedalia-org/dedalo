// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*eslint no-undef: "error"*/

/**
 * RENDER_ADMINISTRATIVE_UNITS
 * DOM for the "UA" panel, built once at attach: an in-flow message line (the
 * unit found, or why not) and the hint. No level select: core's service
 * answers one unit of no chosen level (see `administrative_units.js`).
 *
 * @module render_administrative_units
 */

import { ui } from '../../../core/common/js/ui.js';
import { create_panel_message, show_panel_message } from './render_download_line.js';

/**
 * RENDER_ADMINISTRATIVE_UNITS_PANEL
 * @param {Object} self - tool_uca_maps instance
 * @param {HTMLElement} panel - the panel shell (toolbar.js create_toolbar_panel)
 * @returns {HTMLElement} panel
 */
export const render_administrative_units_panel = function (self, panel) {
	// the header (title + ×) is toolbar.js's: the panel opens centred

	create_panel_message(panel, 'uca-maps-ua-message');

	ui.create_dom_element({
		element_type: 'div',
		class_name: 'uca-maps-ua-hint',
		text_content:
			self.get_tool_label('ua_hint') || 'Click the map to look up the unit at that point.',
		parent: panel,
	});

	return panel;
}; //end render_administrative_units_panel

/**
 * SHOW_UA_MESSAGE
 * The panel's in-flow line (`render_download_line.js` show_panel_message).
 *
 * @param {HTMLElement} panel
 * @param {string} text
 * @param {string} [type='error'] - 'error' | 'warning' (nothing found) | 'ok' | 'info' (working)
 * @returns {void}
 */
export const show_ua_message = function (panel, text, type = 'error') {
	show_panel_message(panel.querySelector('.uca-maps-ua-message'), text, type);
}; //end show_ua_message

/**
 * CLEAR_UA_MESSAGE
 * @param {HTMLElement} panel
 * @returns {void}
 */
export const clear_ua_message = function (panel) {
	panel.querySelector('.uca-maps-ua-message').hidden = true;
}; //end clear_ua_message

// @license-end
