// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global L */
/*eslint no-undef: "error"*/



/**
* XYZ_BASEMAPS
* Session-only base maps: a tool cannot provision a section to keep them. Fixes v6's
* duplicated OSM: v6 mutated `layer_control._layers` while walking it; here every
* rebuild snapshots first, then removes. The tool takes over the map's base tile layer.
*/



import {strip_tags, safe_url} from '../../../core/common/js/utils/util.js'
import {
	create_toolbar_button,
	create_toolbar_panel,
	register_toolbar_node,
	set_toolbar_panel_visible,
	is_toolbar_panel_visible,
	remove_toolbar_button,
	remove_toolbar_panel
} from './toolbar.js'
import {render_xyz_basemaps_panel, populate_xyz_basemaps} from './render_xyz_basemaps.js'



/** v6's defaults (`class.tool_leaflet_special_tools.php`) for a non-numisdata
* `section_tipo`, except the OSM URL (see that entry) and WITHOUT Google Maps:
* `mt1.google.com` is no documented endpoint, and requesting its tiles bypasses the
* official Map Tiles API, which its terms forbid. */
// exported for the client gate
export const DEFAULT_BASEMAPS = [
	{
		// literal https, not v6's protocol-relative '//', as the core's TILE_URLS: an
		// http:// tile request that OSM redirects to https breaks the CSP in dev
		url			: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
		name		: 'OSM',
		attribution	: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
		minzoom		: 0,
		maxzoom		: 20
	},
	{
		url			: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
		name		: 'ARCGIS',
		attribution	: 'Tiles &copy; Esri — Source: Esri, i-cubed, USDA, USGS, AEX, GeoEye, Getmapping, Aerogrid, IGN, IGP, UPR-EGP, and the GIS User Community',
		minzoom		: 0,
		maxzoom		: 19
	}
]



/**
* ATTACH_XYZ_BASEMAPS
* Builds the button and panel, and takes over the map's base layer. Idempotent.
*
* @param {Object} self - tool_uca_maps instance
* @returns {void}
*/
export const attach_xyz_basemaps = function(self) {

	if (self.xyz_control || !self.geolocation || !self.geolocation.map) {
		return
	}

	self.basemaps = DEFAULT_BASEMAPS.map((basemap) => ({...basemap}))

	const title = self.get_tool_label('xyz_control_title') || 'XYZ basemaps'

	self.xyz_control = create_toolbar_button(self, {
		title		: title,
		text		: 'XYZ',
		class_name	: 'uca-maps-xyz-control',
		on_click	: () => toggle_xyz_panel(self)
	})

	self.xyz_panel = create_toolbar_panel(self, {
		class_name	: 'uca-maps-xyz-panel',
		centered	: true,
		title		: title
	})
	render_xyz_basemaps_panel(self, self.xyz_panel)

	rebuild_xyz_layer_control(self, {activate_index: 0})

}//end attach_xyz_basemaps



/**
* TOGGLE_XYZ_PANEL
* Reads the panel's real state, never a flag: a sibling opening closes this one
* without passing here.
*
* @param {Object} self
* @returns {void}
*/
const toggle_xyz_panel = function(self) {

	const next_visible = !is_toolbar_panel_visible(self.xyz_panel)

	if (next_visible) {
		populate_xyz_basemaps(self, self.xyz_panel)
	}

	set_toolbar_panel_visible(self, self.xyz_panel, self.xyz_control, next_visible)

}//end toggle_xyz_panel



/**
* REBUILD_XYZ_LAYER_CONTROL
* The ONE rebuild (attach and every mutation). Snapshot, then remove, never the live
* Leaflet array: walking it while removing was v6's duplicated-OSM bug.
*
* @param {Object} self
* @param {Object} [options]
* @param {number} [options.activate_index=0] - the self.basemaps entry active after the rebuild
* @returns {void}
*/
const rebuild_xyz_layer_control = function(self, {activate_index = 0} = {}) {

	const geolocation	= self.geolocation
	const map			= geolocation.map

	// one-time takeover sweeps map.eachLayer(), not the OSM branch's `tile_layer`:
	// GOOGLE/ARCGIS keep their base layer on no property, so a name check would
	// leave an untracked layer bleeding through. The theme observer would re-add OSM.
	if (!self._xyz_took_over_tiles) {
		if (geolocation.theme_observer && typeof geolocation.theme_observer.disconnect==='function') {
			geolocation.theme_observer.disconnect()
		}
		const raw_tile_layers = []
		map.eachLayer((layer) => { if (layer instanceof L.TileLayer) raw_tile_layers.push(layer) })
		for (const layer of raw_tile_layers) {
			map.removeLayer(layer)
		}
		self._xyz_took_over_tiles = true
	}

	if (!geolocation.layer_control) {
		geolocation.layer_control = L.control.layers({}).addTo(map)
		self._xyz_created_layer_control = true
		register_toolbar_node(self, geolocation.layer_control.getContainer())
	}
	const layer_control = geolocation.layer_control

	// snapshot-then-remove: never mutate `_layers` while walking it
	const existing_tile_entries = Object.values(layer_control._layers || {})
		.filter((entry) => entry.layer instanceof L.TileLayer)
	for (const entry of existing_tile_entries) {
		layer_control.removeLayer(entry.layer)
		if (map.hasLayer(entry.layer)) {
			map.removeLayer(entry.layer)
		}
	}

	self._xyz_tile_layers = self.basemaps.map((basemap) => {
		const tile_layer = L.tileLayer(basemap.url, {
			attribution	: basemap.attribution,
			minZoom		: basemap.minzoom,
			maxZoom		: basemap.maxzoom
		})
		layer_control.addBaseLayer(tile_layer, basemap.name)
		return tile_layer
	})

	const active_layer = self._xyz_tile_layers[activate_index] || self._xyz_tile_layers[0]
	if (active_layer) {
		active_layer.addTo(map)
	}

}//end rebuild_xyz_layer_control



/**
* VALIDATE_BASEMAP_FIELDS
* Name AND attribution are stripped of tags: Leaflet renders the attribution through
* innerHTML. The URL must be absolute (a relative string is no tile template) and pass
* `safe_url`, the app's one scheme allowlist.
*
* @param {Object} self
* @param {Object} fields - {url, name, attribution, minzoom, maxzoom} (raw form strings)
* @returns {{ok: boolean, error?: string, basemap?: Object}}
*/
const validate_basemap_fields = function(self, fields) {

	const raw_url		= String(fields.url || '').trim()
	const name			= strip_tags(String(fields.name || '').trim())
	const attribution	= strip_tags(String(fields.attribution || '').trim())
	const minzoom		= parseInt(fields.minzoom, 10)
	const maxzoom		= parseInt(fields.maxzoom, 10)

	if (!raw_url) {
		return {ok: false, error: self.get_tool_label('xyz_error_url_required') || 'The base map URL is required.'}
	}
	const url = /^(https?:)?\/\//i.test(raw_url) ? safe_url(raw_url) : null
	if (!url) {
		return {ok: false, error: self.get_tool_label('xyz_error_url_invalid') || 'Please enter a valid URL.'}
	}
	if (!name) {
		return {ok: false, error: self.get_tool_label('xyz_error_name_required') || 'The base map name is required.'}
	}
	if (!Number.isInteger(minzoom) || minzoom<0 || minzoom>22) {
		return {ok: false, error: self.get_tool_label('xyz_error_minzoom') || 'Min zoom must be an integer between 0 and 22.'}
	}
	if (!Number.isInteger(maxzoom) || maxzoom<0 || maxzoom>22) {
		return {ok: false, error: self.get_tool_label('xyz_error_maxzoom') || 'Max zoom must be an integer between 0 and 22.'}
	}
	if (minzoom>maxzoom) {
		return {ok: false, error: self.get_tool_label('xyz_error_zoom_range') || 'Min zoom cannot be greater than max zoom.'}
	}

	return {ok: true, basemap: {url, name, attribution, minzoom, maxzoom}}
}//end validate_basemap_fields



/**
* ADD_BASEMAP
* Appends and activates the new entry, as v6 does after a successful add.
*
* @param {Object} self
* @param {Object} fields - see validate_basemap_fields
* @returns {{ok: boolean, error?: string}}
*/
export const add_basemap = function(self, fields) {

	const validation = validate_basemap_fields(self, fields)
	if (!validation.ok) {
		return validation
	}

	self.basemaps.push(validation.basemap)
	rebuild_xyz_layer_control(self, {activate_index: self.basemaps.length - 1})

	return {ok: true}
}//end add_basemap



/**
* DELETE_BASEMAP
* Refuses to delete the last entry: a map with no base layer goes blank, which v6
* does not guard against.
*
* @param {Object} self
* @param {number} index
* @returns {{ok: boolean, error?: string}}
*/
export const delete_basemap = function(self, index) {

	if (index<0 || index>=self.basemaps.length) {
		return {ok: false}
	}
	if (self.basemaps.length<=1) {
		return {ok: false, error: self.get_tool_label('xyz_error_last_basemap') || 'At least one base map must remain.'}
	}

	self.basemaps.splice(index, 1)
	rebuild_xyz_layer_control(self, {activate_index: 0})

	return {ok: true}
}//end delete_basemap



/**
* MOVE_BASEMAP
* One step up or down (▲/▼) instead of v6's HTML5 drag-and-drop, which headless Mocha
* cannot drive reliably; same result.
*
* @param {Object} self
* @param {number} index
* @param {number} direction - -1 (up) or +1 (down)
* @returns {{ok: boolean}}
*/
export const move_basemap = function(self, index, direction) {

	const target = index + direction
	if (index<0 || index>=self.basemaps.length || target<0 || target>=self.basemaps.length) {
		return {ok: false}
	}

	const [moved] = self.basemaps.splice(index, 1)
	self.basemaps.splice(target, 0, moved)
	rebuild_xyz_layer_control(self, {activate_index: 0})

	return {ok: true}
}//end move_basemap



/**
* DETACH_XYZ_BASEMAPS
* Removes every tile layer this tool added, and the layer_control only if this tool
* created it: a provider's own control is left, emptied of ours.
*
* @param {Object} self
* @returns {void}
*/
export const detach_xyz_basemaps = function(self) {

	remove_toolbar_button(self, self.xyz_control)
	remove_toolbar_panel(self, self.xyz_panel)

	const geolocation	= self.geolocation
	const map			= geolocation && geolocation.map
	if (map) {
		for (const tile_layer of self._xyz_tile_layers || []) {
			if (geolocation.layer_control) {
				geolocation.layer_control.removeLayer(tile_layer)
			}
			if (map.hasLayer(tile_layer)) {
				map.removeLayer(tile_layer)
			}
		}
		if (self._xyz_created_layer_control && geolocation.layer_control) {
			map.removeControl(geolocation.layer_control)
			geolocation.layer_control = false
		}
	}

	self.xyz_control				= null
	self.xyz_panel					= null
	self.basemaps					= null
	self._xyz_tile_layers			= null
	self._xyz_took_over_tiles		= false
	self._xyz_created_layer_control	= false

}//end detach_xyz_basemaps



// @license-end
