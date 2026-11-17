// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global L */
/*eslint no-undef: "error"*/



/**
* ARMED_LAYER
* What Catastro and UA share: v6's language gate, a layer laid OVER the active basemap
* (both are transparent: alone, v6's basemap swap showed the bare container), and the
* point a map click asks the server about. Each keeps its state in `_<key>_*` slots;
* the shared `_armed_layer` holds the one feature armed right now.
*/



import {register_toolbar_node} from './toolbar.js'
import {escape_html} from '../../../core/common/js/utils/render_escape.js'



/**
* IS_SPANISH_OFFICIAL_LANG
* v6's gate for Catastro and UA (`render_tool_leaflet_special_tools.js`): the
* record's language is Spanish, Catalan or Basque.
*
* @param {Object} self - tool_uca_maps instance
* @returns {boolean}
*/
// exported for the client gate
export const is_spanish_official_lang = function(self) {
	const lang = self.geolocation?.section_lang
	return lang==='lg-spa' || lang==='lg-cat' || lang==='lg-eus'
}//end is_spanish_official_lang



const slot = (key, name) => `_${key}_${name}`

/** Over every basemap (z-index 0 in xyz_basemaps.js, Leaflet's default 1). */
const OVERLAY_Z_INDEX = 10



/**
* ENABLE_ARMED_LAYER
* Shows the feature's layer over the basemap and arms the click. A source core already
* offers (`source_key` = 'default:<id>') is switched on in place, never copied beside it;
* otherwise `build_layer`'s layer joins the control as an overlay. One at a time, as v6's
* `only_one_active_control`: another armed feature is disarmed first, by its own `disarm`.
* `attribution`: plain text the map credits while armed.
*
* @param {Object} self - tool_uca_maps instance
* @param {string} key - the feature's state key ('catastro' | 'ua')
* @param {{source_key?: string, build_layer: function(): Object, label: string, attribution?: string, on_click: function(Object): void, disarm: function(): void}} armed
* @returns {void}
*/
export const enable_armed_layer = function(self, key, {source_key, build_layer, label, attribution, on_click, disarm}) {

	const geolocation	= self.geolocation
	const map			= geolocation.map

	const armed = self._armed_layer
	if (armed && armed.key!==key) {
		armed.disarm()
	}
	self._armed_layer = {key, disarm}

	const core_item = source_key && geolocation.source_layers ? geolocation.source_layers[source_key] : null
	if (core_item) {
		self[slot(key, 'core_source')]	= source_key
		self[slot(key, 'core_was_on')]	= map.hasLayer(core_item.layer)
		self[slot(key, 'tile_layer')]	= core_item.layer
		core_item.layer.addTo(map) // the control ticks its own checkbox
	} else {
		if (!geolocation.layer_control) {
			geolocation.layer_control = L.control.layers({}).addTo(map)
			self[slot(key, 'created_layer_control')] = true
			register_toolbar_node(self, geolocation.layer_control.getContainer())
		}
		const given_layer = build_layer()
		// a tile layer, not a drawing one: core's overlayadd would make it the active layer
		given_layer.options.dedalo_source = true
		self[slot(key, 'tile_layer')] = given_layer
		geolocation.layer_control.addOverlay(given_layer, label)
		// above any basemap, even one switched on after it (a later sibling of equal z-index wins)
		given_layer.setZIndex(OVERLAY_Z_INDEX)
		given_layer.addTo(map)
	}

	if (attribution && map.attributionControl) {
		const credit = escape_html(attribution)
		map.attributionControl.addAttribution(credit)
		self[slot(key, 'attribution')] = credit
	}

	const click_handler = (event) => on_click(event.latlng)
	self[slot(key, 'click_handler')] = click_handler
	map.on('click', click_handler)

}//end enable_armed_layer



/**
* DISABLE_ARMED_LAYER
* Reverses ENABLE_ARMED_LAYER. Core's own source goes back to how the viewer had it
* (read by its key: a save rebuilds core's layers, so the one armed may be gone); the
* tool's own layer leaves the map and the control, where a stale entry would linger.
*
* @param {Object} self - tool_uca_maps instance
* @param {string} key - the feature's state key ('catastro' | 'ua')
* @returns {void}
*/
export const disable_armed_layer = function(self, key) {

	const geolocation	= self.geolocation
	const map			= geolocation.map

	const click_handler = self[slot(key, 'click_handler')]
	if (click_handler) {
		map.off('click', click_handler)
		self[slot(key, 'click_handler')] = null
	}

	const source_key	= self[slot(key, 'core_source')]
	const tile_layer	= self[slot(key, 'tile_layer')]
	if (source_key) {
		const core_item = geolocation.source_layers ? geolocation.source_layers[source_key] : null
		if (core_item && !self[slot(key, 'core_was_on')]) {
			map.removeLayer(core_item.layer)
		}
	} else if (tile_layer) {
		if (geolocation.layer_control) {
			geolocation.layer_control.removeLayer(tile_layer)
		}
		map.removeLayer(tile_layer)
	}
	self[slot(key, 'core_source')]	= null
	self[slot(key, 'core_was_on')]	= false
	self[slot(key, 'tile_layer')]	= null

	const credit = self[slot(key, 'attribution')]
	if (credit && map.attributionControl) {
		map.attributionControl.removeAttribution(credit)
	}
	self[slot(key, 'attribution')] = null

	if (self._armed_layer?.key===key) {
		self._armed_layer = null
	}

	// only remove the control if THIS feature created it (no provider one existed):
	// the same "created_layer_control" convention as xyz_basemaps.js
	if (self[slot(key, 'created_layer_control')] && geolocation.layer_control) {
		map.removeControl(geolocation.layer_control)
		geolocation.layer_control = false
		self[slot(key, 'created_layer_control')] = false
	}

}//end disable_armed_layer



/**
* WMS_POINT_OPTIONS
* The record plus the view and clicked pixel the server needs for its
* GetFeatureInfo: the browser cannot read those WMS replies itself.
*
* @param {Object} self - tool_uca_maps instance
* @param {Object} latlng - a Leaflet LatLng
* @returns {Object} tool_request options
*/
export const wms_point_options = function(self, latlng) {

	const bounds	= self.geolocation.map.getBounds()
	const point		= self.geolocation.map.latLngToContainerPoint(latlng)
	const size		= self.geolocation.map.getSize()

	return {
		tipo			: self.geolocation.tipo,
		section_id		: self.geolocation.section_id,
		section_tipo	: self.geolocation.section_tipo,
		bbox			: [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()],
		width			: size.x,
		height			: size.y,
		x				: point.x,
		y				: point.y
	}
}//end wms_point_options



// @license-end
