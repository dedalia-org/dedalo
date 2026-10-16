// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global L */
/*eslint no-undef: "error"*/



/**
* ONEXONE
* Hito 7, functionality #7 ("Create 1x1 polygon"). Arms a mode where
* clicking a Marker creates a 1 m-radius rectangle around it, auto-flagged
* as uncertainty. First button this tool builds with NO panel — v6 has none
* for this row either. Full rationale (why popupopen not v6's per-layer
* listeners, why uid-linking not v6's multi_id, no cascade delete): `docs/hitos/hito_7.md`.
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
* Builds the "1x1" toggle button (no panel) and the two map listeners it
* needs: 'popupopen' (arms a rectangle on an eligible Marker click while
* enabled) and 'pm:remove' (clears a stale onexone_uid). Idempotent.
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
* The authoritative "is 1x1 mode armed" read — the button's own DOM class,
* never a cached flag (toolbar.js's same discipline, generalised: this
* button has no panel to read `hidden` off).
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
* Flips the button's own enabled class. Deliberately does NOT auto-disable
* after one rectangle — v6 stays armed until clicked again (docs/hitos/hito_7.md).
*
* @param {Object} self - tool_uca_maps instance
* @returns {void}
*/
const toggle_onexone = function(self) {
	set_toolbar_button_armed(self.onexone_control, ENABLED_CLASS, !is_onexone_enabled(self))
}//end toggle_onexone



/**
* CREATE_ONEXONE_RECTANGLE
* Ports v6's `oneXone_event` click handler minus the multi_id/property-
* propagation machinery (docs/hitos/hito_7.md "Decisiones"): a 1 m-radius
* rectangle around `marker`, added via the real `pm:create` pipeline, then
* auto-flagged uncertainty by reusing `toggle_uncertainty`. Exported for
* direct testability, same reason as object_console.js's toggle_centroid.
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

	toggle_uncertainty(self, rectangle) // auto-uncertainty (row 7) + commit()

}//end create_onexone_rectangle



/**
* CLEAR_ORPHANED_ONEXONE_UID
* Reacts to a removed layer (Geoman's delete tool). A no-op unless it
* carries `onexone_of` (it WAS a rectangle) — clears the origin marker's now-
* dangling `onexone_uid` so 1x1 can be used again. Mirrors object_console.js's
* `unlock_orphaned_centroid` search-by-uid idiom; no cascade delete (hito_7.md).
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
* Real teardown (CLAUDE.local.md "destrucción real") — called from
* tool_uca_maps.prototype.destroy().
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
