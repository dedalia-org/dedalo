// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global L */
/*eslint no-undef: "error"*/



/**
* BASEMAP_SWAP
* What Catastro and UA share: v6's language gate, swapping the basemap for one WMS
* and back, and the point a map click asks the server about. Each feature keeps its
* state on the tool under its own key (`_<key>_tile_layer`, `_<key>_click_handler`,
* `_<key>_previous_base_layers`, `_<key>_created_layer_control`). The one shared
* slot, `_basemap_swap_armed`, holds the swap that owns the basemap right now.
*/



import {register_toolbar_node} from './toolbar.js'



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



/**
* ENABLE_BASEMAP_SWAP
* Swaps the basemap for the WMS through the layer control's own API instead of v6's
* simulated radio click, and arms the click. Remembers the tile layers live on the map
* right then (asked via the map, never a cached "current"), so disabling restores
* exactly those. Creates a layer_control only if none exists.
* One swap at a time, as v6's `only_one_active_control`: another armed swap is
* disarmed first, through its feature's own `disarm` (button, banner, panel), so
* the basemap it took is back on the map before this one remembers it. Otherwise
* this swap would remember the other's WMS and restore it after its owner let go.
*
* @param {Object} self - tool_uca_maps instance
* @param {string} key - the feature's state key ('catastro' | 'ua')
* @param {{url: string, wms_options: Object, label: string, on_click: function(Object): void, disarm: function(): void}} swap
* @returns {void}
*/
export const enable_basemap_swap = function(self, key, {url, wms_options, label, on_click, disarm}) {

	const geolocation	= self.geolocation
	const map			= geolocation.map

	const armed = self._basemap_swap_armed
	if (armed && armed.key!==key) {
		armed.disarm()
	}
	self._basemap_swap_armed = {key, disarm}

	if (!geolocation.layer_control) {
		geolocation.layer_control = L.control.layers({}).addTo(map)
		self[slot(key, 'created_layer_control')] = true
		register_toolbar_node(self, geolocation.layer_control.getContainer())
	}
	const layer_control = geolocation.layer_control

	const previous_base_layers = []
	self[slot(key, 'previous_base_layers')] = previous_base_layers
	map.eachLayer((layer) => {
		if (layer instanceof L.TileLayer) {
			previous_base_layers.push(layer)
			map.removeLayer(layer)
		}
	})

	const tile_layer = L.tileLayer.wms(`${url}?`, wms_options)
	self[slot(key, 'tile_layer')] = tile_layer
	layer_control.addBaseLayer(tile_layer, label)
	tile_layer.addTo(map) // the layer control redraws itself: no radio click to simulate

	const click_handler = (event) => on_click(event.latlng)
	self[slot(key, 'click_handler')] = click_handler
	map.on('click', click_handler)

}//end enable_basemap_swap



/**
* DISABLE_BASEMAP_SWAP
* Reverses ENABLE_BASEMAP_SWAP. The WMS also leaves the layer control, as v6's
* `catastro_off`: a stale entry would linger in the basemap list.
*
* @param {Object} self - tool_uca_maps instance
* @param {string} key - the feature's state key ('catastro' | 'ua')
* @returns {void}
*/
export const disable_basemap_swap = function(self, key) {

	const geolocation	= self.geolocation
	const map			= geolocation.map

	const click_handler = self[slot(key, 'click_handler')]
	if (click_handler) {
		map.off('click', click_handler)
		self[slot(key, 'click_handler')] = null
	}

	const tile_layer = self[slot(key, 'tile_layer')]
	if (tile_layer) {
		if (geolocation.layer_control) {
			geolocation.layer_control.removeLayer(tile_layer)
		}
		map.removeLayer(tile_layer)
		self[slot(key, 'tile_layer')] = null
	}

	for (const layer of self[slot(key, 'previous_base_layers')] || []) {
		layer.addTo(map)
	}
	self[slot(key, 'previous_base_layers')] = null

	if (self._basemap_swap_armed?.key===key) {
		self._basemap_swap_armed = null
	}

	// only remove the control if THIS feature created it (no provider one existed):
	// the same "created_layer_control" convention as xyz_basemaps.js
	if (self[slot(key, 'created_layer_control')] && geolocation.layer_control) {
		map.removeControl(geolocation.layer_control)
		geolocation.layer_control = false
		self[slot(key, 'created_layer_control')] = false
	}

}//end disable_basemap_swap



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
