// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global L */
/*eslint no-undef: "error"*/



/**
* GEOLOCATE
* Hito 15, functionality #13 ("Geolocation"). A toggle button with NO panel
* (the 1x1 shape, onexone.js): armed, it asks the browser for the user's
* position, centres the map there and DROPS A MARKER at it.
*
* The marker is v6's own behaviour (`special_tools_geolocation.js`
* `location_found_event`: `map.fire('pm:create', {layer: marker})`), not an
* embellishment — the point of the control on a field survey is to record
* where you are standing, not just to look at it. What v6 does NOT do, and
* this port must not either: v6's create path ends in the tool's own save.
* Here it ends in `commit()` — the record goes dirty and the user's own Save
* button stays the only thing that writes (second law of
* component_geolocation, CLAUDE.local.md).
*
* The plan (§7) had this row down as a "retirada condicionada" — to be
* dropped if v7 core already offered it. Hito 0 measured that it does not
* (`grep -rli "navigator.geolocation"` over `client/` and `src/`: zero), so
* it is ported.
*
* @module geolocate
*/



import {
	create_toolbar_button,
	remove_toolbar_button
} from './toolbar.js'
import {commit, ensure_properties, ensure_uid, report_client_error} from './object_console.js'



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
* Builds the button and the two map listeners `map.locate` answers through.
* Idempotent.
*
* The listeners are bound ONCE here rather than per click (v6 re-binds a new
* pair of handlers on every click of its own control, so an eighth click
* leaves eight `locationfound` listeners on the map and drops eight markers
* for one position).
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
		text		: 'GPS',
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
		// v6 shows its own modal here; this tool's user-visible failure
		// surface is the global toast (object_console.js report_client_error),
		// which is also what makes a DENIED browser permission VISIBLE
		// instead of a button that silently does nothing.
		report_client_error(
			self.get_tool_label('geolocate_error') || 'Your location could not be determined.'
		)
	}
	self.geolocation.map.on('locationerror', self._geolocate_error_handler)

}//end attach_geolocate



/**
* IS_GEOLOCATE_ENABLED
* The authoritative "is the control armed" read — the button's own DOM class,
* never a cached flag (toolbar.js file header, onexone.js is_onexone_enabled).
*
* @param {Object} self - tool_uca_maps instance
* @returns {boolean}
*/
export const is_geolocate_enabled = function(self) {
	const container = self.geolocate_control && self.geolocate_control.getContainer
		&& self.geolocate_control.getContainer()
	return Boolean(container && container.classList.contains(ENABLED_CLASS))
}//end is_geolocate_enabled



/**
* SET_GEOLOCATE_ENABLED
* @param {Object} self - tool_uca_maps instance
* @param {boolean} enabled
* @returns {void}
*/
const set_geolocate_enabled = function(self, enabled) {
	const container = self.geolocate_control && self.geolocate_control.getContainer
		&& self.geolocate_control.getContainer()
	if (container) {
		container.classList.toggle(ENABLED_CLASS, enabled===true)
	}
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
* Drops a marker at `latlng` through the REAL `pm:create` pipeline (the same
* door onexone.js uses), then `commit()`s — dirty record, no write.
* Exported for direct testability, same reason as onexone.js's
* create_onexone_rectangle.
*
* @param {Object} self - tool_uca_maps instance
* @param {Object} latlng - Leaflet LatLng of the found position
* @returns {Object|null} the created marker, or null when there is no layer to put it in
*/
export const create_position_marker = function(self, latlng) {

	if (!latlng || !self.geolocation || !self.geolocation.map) {
		return null
	}

	// component_geolocation's own 'pm:create' handler adds the new layer to
	// `FeatureGroup[active_layer_id]` with no existence check of its own
	// (component_geolocation.js:1954) — a map whose active layer has no group
	// yet would throw INSIDE the core handler. onexone.js never meets this
	// because it starts from a layer that is already IN a group; a position
	// fix starts from nothing, so the group is checked here.
	const layer_id		= self.geolocation.active_layer_id
	const feature_group	= self.geolocation.FeatureGroup && self.geolocation.FeatureGroup[layer_id]
	if (!feature_group) {
		report_client_error(
			self.get_tool_label('geolocate_no_layer') || 'Select a map layer before using geolocation.'
		)
		return null
	}

	const marker = L.marker(latlng)
	marker.feature = marker.toGeoJSON()
	ensure_properties(marker)
	ensure_uid(marker)

	self.geolocation.map.fire('pm:create', {layer: marker})

	commit(self, marker)

	return marker
}//end create_position_marker



/**
* DETACH_GEOLOCATE
* Real teardown (CLAUDE.local.md "destrucción real") — called from
* tool_uca_maps.prototype.destroy(). Stops any in-flight lookup as well as
* removing the listeners: `map.locate` with `watch:false` still holds a
* pending browser request until it answers.
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
		if (self._geolocate_found_handler) {
			try {
				self.geolocation.map.off('locationfound', self._geolocate_found_handler)
			} catch (error) {
				console.warn('tool_uca_maps detach_geolocate: error removing locationfound listener', error)
			}
		}
		if (self._geolocate_error_handler) {
			try {
				self.geolocation.map.off('locationerror', self._geolocate_error_handler)
			} catch (error) {
				console.warn('tool_uca_maps detach_geolocate: error removing locationerror listener', error)
			}
		}
	}

	remove_toolbar_button(self, self.geolocate_control)

	self.geolocate_control			= null
	self._geolocate_found_handler	= null
	self._geolocate_error_handler	= null

}//end detach_geolocate



// @license-end
