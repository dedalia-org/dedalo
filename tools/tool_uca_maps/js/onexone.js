// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global L */
/*eslint no-undef: "error"*/



/**
* ONEXONE
* "Create 1x1 polygon" mode: clicking a Marker draws a 1 m-radius rectangle around it,
* flagged as uncertainty. No panel, as v6. Marker and rectangle are linked by uid, not
* v6's multi_id: each is valid data on its own, so nothing propagates or cascades.
*/



import {
	create_toolbar_button,
	is_toolbar_button_armed,
	remove_toolbar_button,
	set_toolbar_button_armed
} from './toolbar.js'
import {
	ensure_properties,
	ensure_uca_maps,
	ensure_uid,
	find_layer_id,
	toggle_uncertainty,
	commit,
	remove_map_listeners
} from './object_console.js'
import {is_onexone_marker, is_onexone_rectangle} from './onexone_flags.js'
import {read_uca_maps} from './uca_maps_data.js'



const ENABLED_CLASS = 'uca-maps-onexone-enabled'



/**
* ATTACH_ONEXONE
* One map-level 'popupopen' listener instead of v6's per-layer hooks: it also covers a
* marker drawn after arming. 'pm:remove' clears a stale onexone_uid. Idempotent.
*
* @param {Object} self - tool_uca_maps instance
* @returns {void}
*/
export const attach_onexone = function(self) {

	if (self.onexone_control || !self.geolocation || !self.geolocation.map) {
		return
	}

	self.onexone_control = create_toolbar_button(self, {
		title		: self.get_tool_label('onexone_control_title') || 'Create 1x1 polygon',
		text		: '1x1',
		class_name	: 'uca-maps-onexone-control',
		on_click	: () => toggle_onexone(self)
	})

	self._onexone_popupopen_handler = (event) => {
		if (!is_onexone_enabled(self)) {
			return
		}
		const layer = event.popup && event.popup._source
		if (layer instanceof L.Marker) {
			create_onexone_rectangle(self, layer)
		}
	}
	self.geolocation.map.on('popupopen', self._onexone_popupopen_handler)

	self._onexone_pmremove_handler = (event) => {
		if (event.layer) {
			clear_orphaned_onexone_uid(self, event.layer)
		}
	}
	self.geolocation.map.on('pm:remove', self._onexone_pmremove_handler)

}//end attach_onexone



/**
* IS_ONEXONE_ENABLED
* Read from the button's own class, never a cached flag: this button has no panel
* whose `hidden` could be read.
*
* @param {Object} self - tool_uca_maps instance
* @returns {boolean}
*/
// exported for the client gate
export const is_onexone_enabled = function(self) {
	return is_toolbar_button_armed(self.onexone_control, ENABLED_CLASS)
}//end is_onexone_enabled



/**
* TOGGLE_ONEXONE
* Does NOT disarm after one rectangle: v6 stays armed until clicked again.
*
* @param {Object} self - tool_uca_maps instance
* @returns {void}
*/
const toggle_onexone = function(self) {
	set_toolbar_button_armed(self.onexone_control, ENABLED_CLASS, !is_onexone_enabled(self))
}//end toggle_onexone



/**
* CREATE_ONEXONE_RECTANGLE
* v6's `oneXone_event` without the multi_id propagation. Goes through the real
* `pm:create` pipeline and reuses `toggle_uncertainty`, so the rectangle is an ordinary
* drawn polygon. The uid pointers only stop a second rectangle for the same marker.
*
* @param {Object} self - tool_uca_maps instance
* @param {Object} marker - the clicked Leaflet Marker
* @returns {void}
*/
export const create_onexone_rectangle = function(self, marker) {

	if (!(marker instanceof L.Marker)) {
		return
	}

	const uca_maps = ensure_uca_maps(marker)

	if (uca_maps.centroid_of || is_onexone_marker(marker)) {
		return
	}

	if (self.geolocation.map.pm.globalEditModeEnabled()) {
		return
	}

	const layer_id = find_layer_id(self, marker)
	if (layer_id===null) {
		return
	}

	const marker_uid	= ensure_uid(marker)
	const bounds		= marker.getLatLng().toBounds(1) // 1 m radius — v6 `radiusMts = 1`, verbatim
	const rectangle		= L.rectangle(bounds)

	ensure_properties(rectangle).uca_maps = {onexone_of: marker_uid}

	self.geolocation.active_layer_id = layer_id
	self.geolocation.map.fire('pm:create', {layer: rectangle})

	uca_maps.onexone_uid = ensure_uid(rectangle) // one uid scheme (ensure_uid), not two

	// The marker is locked, as v6 does (`special_tools_onexone.js`): the core's
	// click sweep would make it draggable, and a drag would leave its uncertainty
	// box behind. The stored false is what the console's deferred re-assert
	// keeps; moving the point stays possible, on purpose, from its checkbox.
	uca_maps.geoman_edition = false

	toggle_uncertainty(self, rectangle) // auto-uncertainty + commit()

}//end create_onexone_rectangle



/**
* CLEAR_ORPHANED_ONEXONE_UID
* Removing a 1x1 rectangle frees its marker for 1x1 again. Only that pointer is
* cleared: no cascade delete, and a rectangle's dangling `onexone_of` stays inert.
*
* @param {Object} self - tool_uca_maps instance
* @param {Object} removed_layer - the layer Geoman just removed
* @returns {void}
*/
const clear_orphaned_onexone_uid = function(self, removed_layer) {

	if (!is_onexone_rectangle(removed_layer) || !self.geolocation || !self.geolocation.FeatureGroup) {
		return
	}
	const onexone_of = read_uca_maps(removed_layer).onexone_of

	for (const layer_id in self.geolocation.FeatureGroup) {
		const feature_group	= self.geolocation.FeatureGroup[layer_id]
		const marker_layer		= feature_group.getLayers().find((candidate) => {
			const candidate_uca_maps = read_uca_maps(candidate)
			return Boolean(candidate_uca_maps && candidate_uca_maps.uid===onexone_of)
		})
		if (marker_layer) {
			delete marker_layer.feature.properties.uca_maps.onexone_uid
			commit(self, marker_layer)
			return
		}
	}
}//end clear_orphaned_onexone_uid



/**
* DETACH_ONEXONE
* Removes both map listeners and the button.
*
* @param {Object} self - tool_uca_maps instance
* @returns {void}
*/
export const detach_onexone = function(self) {

	if (self.geolocation && self.geolocation.map) {
		remove_map_listeners(self, 'detach_onexone', [
			['popupopen',	'_onexone_popupopen_handler'],
			['pm:remove',	'_onexone_pmremove_handler']
		])
	}

	remove_toolbar_button(self, self.onexone_control)

	self.onexone_control				= null
	self._onexone_popupopen_handler	= null
	self._onexone_pmremove_handler		= null

}//end detach_onexone



// @license-end
