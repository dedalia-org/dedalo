// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global L */
/*eslint no-undef: "error"*/



/**
* OBJECT_VIEWER
* Read-only "Objects" panel (v6 `special_tools_objects.js`): lists only the ACTIVE
* FeatureGroup, as v6, split by `uca_maps.is_raster`. No v6 multi_id grouping: the
* vector importer explodes Multi* into single parts. The nameless label is display-only:
* v6 wrote it into `properties.name`, a silent edit that rode along on the next save.
*/



import {event_manager} from '../../../core/common/js/event_manager.js'
import {
	create_toolbar_button,
	create_toolbar_panel,
	set_toolbar_panel_visible,
	is_toolbar_panel_visible,
	remove_toolbar_button,
	remove_toolbar_panel
} from './toolbar.js'
import {commit, apply_display, ensure_uca_maps} from './object_console.js'
import {render_object_viewer_panel, populate_object_viewer} from './render_object_viewer.js'
import {read_uca_maps} from './uca_maps_data.js'



/**
* ATTACH_OBJECT_VIEWER
* Idempotent. The lists are filled on every open, not here.
*
* @param {Object} self - tool_uca_maps instance
* @returns {void}
*/
export const attach_object_viewer = function(self) {

	if (self.object_viewer_control || !self.geolocation || !self.geolocation.map) {
		return
	}

	const title = self.get_tool_label('object_viewer_control_title') || 'Objects'

	self.object_viewer_control = create_toolbar_button(self, {
		title		: title,
		icon		: 'object_viewer',
		class_name	: 'uca-maps-object-viewer-control',
		on_click	: () => toggle_object_viewer_panel(self)
	})

	self.object_viewer_panel = create_toolbar_panel(self, {
		class_name	: 'uca-maps-object-viewer-panel',
		centered	: true,
		title		: title
	})
	render_object_viewer_panel(self, self.object_viewer_panel)

	// Geoman's toolbar stays usable with this panel open (v6's modal blocked it), so
	// re-list on every draw-data update. common destroy() drops events_tokens.
	const token = event_manager.subscribe(
		'updated_layer_data_' + self.geolocation.id_base,
		() => {
			if (is_toolbar_panel_visible(self.object_viewer_panel)) {
				populate_object_viewer(self, self.object_viewer_panel)
			}
		}
	)
	self.events_tokens = self.events_tokens || []
	self.events_tokens.push(token)

}//end attach_object_viewer



/**
* TOGGLE_OBJECT_VIEWER_PANEL
* Reads the panel's real state, never a flag: a sibling opening closes this one
* without passing here. Rebuilds on every show, as v6: what is drawn may have changed.
*
* @param {Object} self - tool_uca_maps instance
* @returns {void}
*/
const toggle_object_viewer_panel = function(self) {

	const next_visible = !is_toolbar_panel_visible(self.object_viewer_panel)

	if (next_visible) {
		populate_object_viewer(self, self.object_viewer_panel)
	}

	set_toolbar_panel_visible(self, self.object_viewer_panel, self.object_viewer_control, next_visible)

}//end toggle_object_viewer_panel



/**
* DETACH_OBJECT_VIEWER
* Removes the button and panel; the event token goes with common destroy().
*
* @param {Object} self - tool_uca_maps instance
* @returns {void}
*/
export const detach_object_viewer = function(self) {

	remove_toolbar_button(self, self.object_viewer_control)
	remove_toolbar_panel(self, self.object_viewer_panel)

	self.object_viewer_control			= null
	self.object_viewer_panel			= null

}//end detach_object_viewer



/**
* COLLECT_OBJECTS
* Active FeatureGroup only, as v6. `name` is a display fallback, never written back.
*
* @param {Object} self - tool_uca_maps instance
* @returns {{vector_objects: Array, raster_objects: Array}} each entry:
*   {layer, name: string, display: boolean}
*/
export const collect_objects = function(self) {

	const vector_objects	= []
	const raster_objects	= []

	const feature_group = self.geolocation && self.geolocation.FeatureGroup
		&& self.geolocation.FeatureGroup[self.geolocation.active_layer_id]

	if (!feature_group) {
		return {vector_objects, raster_objects}
	}

	feature_group.eachLayer((layer) => {

		const properties	= (layer.feature && layer.feature.properties) || {}
		const uca_maps		= read_uca_maps(layer) || {}
		const name			= properties.name || properties.title
			|| (self.get_tool_label('object_viewer_nameless') || 'Untitled object')
		const display		= uca_maps.display!==false

		const entry = {layer, name, display}

		if (uca_maps.is_raster) {
			raster_objects.push(entry)
		} else {
			vector_objects.push(entry)
		}

	})

	return {vector_objects, raster_objects}
}//end collect_objects



/**
* SET_OBJECT_DISPLAY
* Takes the checkbox's own state instead of inverting the stored one, so the two can
* never desync. `ensure_uca_maps` because a freshly drawn shape has no `.feature` yet.
*
* @param {Object} self - tool_uca_maps instance
* @param {Object} layer - the Leaflet layer whose checkbox was toggled
* @param {boolean} visible - the checkbox's own new checked state
* @returns {void}
*/
export const set_object_display = function(self, layer, visible) {

	ensure_uca_maps(layer).display = visible

	apply_display(layer, visible)
	commit(self, layer)

}//end set_object_display



/**
* CENTER_ON_OBJECT
* v6's "eye" icon. A Marker uses `move_camera` (zoom 16, as v6); bounds raise
* `camera_is_moving` by hand, as no public door fits an arbitrary layer. `animate:false`
* because an animated fitBounds fires zoomend after the finally, marking the record dirty.
*
* @param {Object} self - tool_uca_maps instance
* @param {Object} layer - the Leaflet layer to center on
* @returns {void}
*/
export const center_on_object = function(self, layer) {

	const geolocation = self.geolocation
	if (!geolocation || !geolocation.map) {
		return
	}

	if (layer instanceof L.Marker) {
		const latlng = layer.getLatLng()
		geolocation.move_camera(latlng.lat, latlng.lng, 16)
		return
	}

	if (typeof layer.getBounds!=='function') {
		return
	}

	geolocation.camera_is_moving = true
	try {
		geolocation.map.fitBounds(layer.getBounds(), {animate: false})
	} finally {
		geolocation.camera_is_moving = false
	}

}//end center_on_object



// @license-end
