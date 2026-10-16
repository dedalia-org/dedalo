// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global L */
/*eslint no-undef: "error"*/



/**
* GEOLOCATE
* A panel-less toggle: armed, it asks the browser for the position, centres the map
* and drops a marker there, as v6 (`special_tools_geolocation.js`): on a survey the
* point is to record where you stand. Unlike v6 it ends in `commit()`, not a save:
* the record goes dirty and only the user's Save writes.
*
* @module geolocate
*/



import {
	create_toolbar_button,
	is_toolbar_button_armed,
	remove_toolbar_button,
	set_toolbar_button_armed
} from './toolbar.js'
import {commit, ensure_uid, remove_map_listeners, report_client_error} from './object_console.js'



const ENABLED_CLASS = 'uca-maps-geolocate-enabled'

// v6's own `map.locate` options, verbatim (special_tools_geolocation.js locate)
const LOCATE_OPTIONS = Object.freeze({
	setView				: true,
	maxZoom				: 16,
	enableHighAccuracy	: true,
	timeout				: 14000
})



/**
* ATTACH_GEOLOCATE
* The two `map.locate` listeners are bound ONCE, not per click: v6 re-binds a pair on
* every click, so the eighth click drops eight markers for one position. Idempotent.
*
* @param {Object} self - tool_uca_maps instance
* @returns {void}
*/
export const attach_geolocate = function(self) {

	if (self.geolocate_control || !self.geolocation || !self.geolocation.map) {
		return
	}

	self.geolocate_control = create_toolbar_button(self, {
		title		: self.get_tool_label('geolocate_control_title') || 'Geolocation',
		icon		: 'pointer',
		class_name	: 'uca-maps-geolocate-control',
		on_click	: () => toggle_geolocate(self)
	})

	self._geolocate_found_handler = (event) => {
		if (!is_geolocate_enabled(self)) {
			return
		}
		set_geolocate_enabled(self, false) // one fix per click — v6's own disarm
		create_position_marker(self, event.latlng)
	}
	self.geolocation.map.on('locationfound', self._geolocate_found_handler)

	self._geolocate_error_handler = () => {
		if (!is_geolocate_enabled(self)) {
			return
		}
		set_geolocate_enabled(self, false)
		// a toast instead of v6's modal: it also makes a DENIED browser permission
		// visible instead of a button that silently does nothing
		report_client_error(
			self.get_tool_label('geolocate_error') || 'Your location could not be determined.'
		)
	}
	self.geolocation.map.on('locationerror', self._geolocate_error_handler)

}//end attach_geolocate



/**
* IS_GEOLOCATE_ENABLED
* Read from the button's own class, never a cached flag.
*
* @param {Object} self - tool_uca_maps instance
* @returns {boolean}
*/
// exported for the client gate
export const is_geolocate_enabled = function(self) {
	return is_toolbar_button_armed(self.geolocate_control, ENABLED_CLASS)
}//end is_geolocate_enabled



/**
* SET_GEOLOCATE_ENABLED
* @param {Object} self - tool_uca_maps instance
* @param {boolean} enabled
* @returns {void}
*/
const set_geolocate_enabled = function(self, enabled) {
	set_toolbar_button_armed(self.geolocate_control, ENABLED_CLASS, enabled)
}//end set_geolocate_enabled



/**
* TOGGLE_GEOLOCATE
* Arms the control and starts the browser lookup; a second click while the
* lookup is still running cancels it (`stopLocate`), so a request that never
* answers — permission dialog left open, no GPS fix — is not a stuck button.
*
* @param {Object} self - tool_uca_maps instance
* @returns {void}
*/
// exported for the client gate
export const toggle_geolocate = function(self) {

	if (is_geolocate_enabled(self)) {
		set_geolocate_enabled(self, false)
		self.geolocation.map.stopLocate()
		return
	}

	set_geolocate_enabled(self, true)
	self.geolocation.map.locate(LOCATE_OPTIONS)

}//end toggle_geolocate



/**
* CREATE_POSITION_MARKER
* Through the real `pm:create` pipeline, then `commit()`: dirty record, no write.
* Exported for the client gate.
*
* @param {Object} self - tool_uca_maps instance
* @param {Object} latlng - Leaflet LatLng of the found position
* @returns {Object|null} the created marker, or null when there is no layer to put it in
*/
export const create_position_marker = function(self, latlng) {

	if (!latlng || !self.geolocation || !self.geolocation.map) {
		return null
	}

	// the core's 'pm:create' handler adds to `FeatureGroup[active_layer_id]` without
	// checking it exists, and would throw inside. A position fix, unlike 1x1, does
	// not start from a layer already in a group, so the group is checked here.
	const layer_id		= self.geolocation.active_layer_id
	const feature_group	= self.geolocation.FeatureGroup && self.geolocation.FeatureGroup[layer_id]
	if (!feature_group) {
		report_client_error(
			self.get_tool_label('geolocate_no_layer') || 'Select a map layer before using geolocation.'
		)
		return null
	}

	const marker = L.marker(latlng)
	ensure_uid(marker)

	self.geolocation.map.fire('pm:create', {layer: marker})

	commit(self, marker)

	return marker
}//end create_position_marker



/**
* DETACH_GEOLOCATE
* Also stops an in-flight lookup: `map.locate` without `watch` still holds a pending
* browser request until it answers.
*
* @param {Object} self - tool_uca_maps instance
* @returns {void}
*/
export const detach_geolocate = function(self) {

	if (self.geolocation && self.geolocation.map) {
		try {
			self.geolocation.map.stopLocate()
		} catch (error) {
			console.warn('tool_uca_maps detach_geolocate: error stopping the location request', error)
		}
		remove_map_listeners(self, 'detach_geolocate', [
			['locationfound',	'_geolocate_found_handler'],
			['locationerror',	'_geolocate_error_handler']
		])
	}

	remove_toolbar_button(self, self.geolocate_control)

	self.geolocate_control			= null
	self._geolocate_found_handler	= null
	self._geolocate_error_handler	= null

}//end detach_geolocate



// @license-end
