// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global SHOW_DEVELOPER */
/*eslint no-undef: "error"*/



/**
* CAPABILITIES_PANEL
*
* Dev-only diagnostic (GDAL/ImageMagick server binaries) — NOT one of the 15
* functionalities in `docs/Funcionalidades de tool_leaflet_special_tools.md`.
* It was added in hito 1 to prove the vertical slice actually reached the
* server; Sergio's decision on the toolbar refactor (2026-09-04,
* CLAUDE.local.md "Left toolbar: un botón por funcionalidad") was that it
* does not earn an end-user button — it gets its own button+panel same as
* every real functionality, but gated behind `SHOW_DEVELOPER`, the exact
* same flag `tool_uca_maps.prototype.get_capabilities` already uses for its
* own `console.log`. A logged-out/non-dev user never sees this button at all.
*
* @module capabilities_panel
*/



import {
	create_toolbar_button,
	create_toolbar_panel,
	set_toolbar_panel_visible,
	is_toolbar_panel_visible,
	remove_toolbar_button,
	remove_toolbar_panel
} from './toolbar.js'
import {render_capabilities_panel} from './render_capabilities_panel.js'



/**
* ATTACH_CAPABILITIES_PANEL
* No-op unless `SHOW_DEVELOPER===true` (see file header). Idempotent — a
* stray second call never attaches a duplicate control or panel.
*
* @param {Object} self - tool_uca_maps instance
* @returns {void}
*/
export const attach_capabilities_panel = function(self) {

	if (self.capabilities_control || !self.geolocation || !self.geolocation.map) {
		return
	}
	if (typeof SHOW_DEVELOPER==='undefined' || SHOW_DEVELOPER!==true) {
		return
	}

	self.capabilities_control = create_toolbar_button(self, {
		title		: self.get_tool_label('capabilities_title') || 'Server capabilities',
		text		: 'DEV',
		class_name	: 'uca-maps-capabilities-control',
		on_click	: () => toggle_capabilities_panel(self)
	})

	self.capabilities_panel = create_toolbar_panel(self, {class_name: 'uca-maps-capabilities-panel'})
	render_capabilities_panel(self, self.capabilities_panel)

}//end attach_capabilities_panel



/**
* TOGGLE_CAPABILITIES_PANEL
* Reads the panel's own current state, never a cached flag — see
* toolbar.js `is_toolbar_panel_visible` file comment: a SIBLING panel
* opening (mutual exclusion, 2026-09-04) can close this one without going
* through this function at all.
*
* @param {Object} self - tool_uca_maps instance
* @returns {void}
*/
const toggle_capabilities_panel = function(self) {
	self.capabilities_panel_visible = !is_toolbar_panel_visible(self.capabilities_panel)
	set_toolbar_panel_visible(self, self.capabilities_panel, self.capabilities_control, self.capabilities_panel_visible)
}//end toggle_capabilities_panel



/**
* DETACH_CAPABILITIES_PANEL
* Safe to call even when `attach_capabilities_panel` never ran (not a dev
* session) — both fields are already null and the toolbar removers are
* themselves no-ops on a null control/panel.
*
* @param {Object} self - tool_uca_maps instance
* @returns {void}
*/
export const detach_capabilities_panel = function(self) {

	remove_toolbar_button(self, self.capabilities_control)
	remove_toolbar_panel(self, self.capabilities_panel)

	self.capabilities_control			= null
	self.capabilities_panel			= null
	self.capabilities_panel_visible	= false

}//end detach_capabilities_panel



// @license-end
