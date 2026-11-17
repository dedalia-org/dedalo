// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global L */
/*eslint no-undef: "error"*/



/**
* XYZ_BASEMAPS
* The tool's base maps (session-only, in the layer control as base layers) and the XYZ
* layers a user adds, which are saved in the record (`map_sources.js`) and drawn by the
* component as overlays. Fixes v6's duplicated OSM: v6 mutated `layer_control._layers`
* while walking it; here every rebuild snapshots first, then removes.
*/



import {strip_tags, safe_url} from '../../../core/common/js/utils/util.js'
import {add_source, default_source, delete_source, plain_attribution} from './map_sources.js'
import {MAX_SOURCE_ZOOM, XYZ_PLACEHOLDERS} from './core_limits.js'
import {escape_html} from '../../../core/common/js/utils/render_escape.js'
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
* `section_tipo`, WITHOUT Google Maps: `mt1.google.com` is no documented endpoint, and
* requesting its tiles bypasses the official Map Tiles API, which its terms forbid. */
// exported for the client gate
export const DEFAULT_BASEMAPS = [
	// core's built-in, through the tile proxy (or straight from OpenStreetMap where the
	// server says so): the page may not name an OSM host of its own. Max zoom is its own.
	{
		builtin		: 'osm',
		name		: 'OSM',
		minzoom		: 0,
		maxzoom		: 19
	},
	// straight from Esri (core does not relay it: its terms forbid it), so missing from
	// the map image, unless the component configures an `arcgis` default (`default_id`),
	// which is drawn through the tile proxy
	{
		url			: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
		default_id	: 'arcgis',
		name		: 'ARCGIS',
		attribution	: 'Tiles © Esri — Source: Esri, i-cubed, USDA, USGS, AEX, GeoEye, Getmapping, Aerogrid, IGN, IGP, UPR-EGP, and the GIS User Community',
		minzoom		: 0,
		maxzoom		: 19
	}
]



/** Below every overlay: `L.control.layers` numbers its layers from 1 up. */
const BASEMAP_Z_INDEX = 0



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
		icon		: 'xyz_basemaps',
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
* IS_BASE_TILE_LAYER
* A tile layer the takeover replaces: every one but the record's own sources, which the
* component draws as overlays (`options.dedalo_source`) and rebuilds after each save.
*
* @param {Object} layer
* @returns {boolean}
*/
const is_base_tile_layer = function(layer) {
	return layer instanceof L.TileLayer && layer.options.dedalo_source!==true
}//end is_base_tile_layer



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
		map.eachLayer((layer) => { if (is_base_tile_layer(layer)) raw_tile_layers.push(layer) })
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
		.filter((entry) => is_base_tile_layer(entry.layer))
	for (const entry of existing_tile_entries) {
		layer_control.removeLayer(entry.layer)
		if (map.hasLayer(entry.layer)) {
			map.removeLayer(entry.layer)
		}
	}

	self._xyz_tile_layers = self.basemaps.map((basemap) => {
		const zooms		= {minZoom: basemap.minzoom, maxZoom: basemap.maxzoom}
		const configured	= basemap.default_id ? default_source(self, basemap.default_id) : null
		const tile_layer = basemap.builtin
			? geolocation.get_builtin_layer(basemap.builtin, zooms)
			: configured
				// a base layer, not one of the record's overlays (is_base_tile_layer)
				? geolocation.get_source_layer(
					{
						...configured,
						attribution	: configured.attribution || basemap.attribution,
						// an entry with no last zoom of its own asks no further than the
						// provider serves (Esri: 19), and Leaflet scales those up
						params		: Number.isInteger(configured.params?.max_zoom)
							? configured.params
							: {...configured.params, max_zoom: basemap.maxzoom}
					},
					{dedalo_source: false}
				)
				: L.tileLayer(basemap.url, {attribution: basemap.attribution, ...zooms})
		// the name is text (the panel list sets it as textContent), Leaflet's
		// control writes it as innerHTML
		layer_control.addBaseLayer(tile_layer, escape_html(basemap.name))
		// the control stacks each layer above the ones before it: re-added after the
		// record's own overlays, a base map would hide them until switched off
		tile_layer.setZIndex(BASEMAP_Z_INDEX)
		return tile_layer
	})

	const active_layer = self._xyz_tile_layers[activate_index] || self._xyz_tile_layers[0]
	if (active_layer) {
		active_layer.addTo(map)
	}

}//end rebuild_xyz_layer_control





/**
* VALIDATE_BASEMAP_FIELDS
* The checks the server makes on a stored source, said first in the panel's words: an
* absolute http(s) template (`safe_url`, the app's scheme allowlist) with `{z}`, `{x}` and
* `{y}` and no other placeholder, and plain-text attribution. The attribution is required:
* a stored source has no name of its own, and the layer control lists it by its attribution.
*
* @param {Object} self
* @param {Object} fields - {url, attribution, minzoom, maxzoom} (raw form strings)
* @returns {{ok: boolean, error?: string, source?: Object}} source: an id-less xyz source
*/
const validate_basemap_fields = function(self, fields) {

	const raw_url		= String(fields.url || '').trim()
	// strip_tags DECODES entities (`&lt;b&gt;` is `<b>`): the server refuses `<` and `>`
	const attribution	= plain_attribution(strip_tags(String(fields.attribution || '')))
	const minzoom		= parseInt(fields.minzoom, 10)
	const maxzoom		= parseInt(fields.maxzoom, 10)

	if (!raw_url) {
		return {ok: false, error: self.get_tool_label('xyz_error_url_required') || 'The base map URL is required.'}
	}
	const url = /^https?:\/\//i.test(raw_url) ? safe_url(raw_url) : null
	if (!url) {
		return {ok: false, error: self.get_tool_label('xyz_error_url_invalid') || 'Please enter a valid URL.'}
	}
	const placeholders = url.match(/\{[^}]*\}/g) || []
	if (!XYZ_PLACEHOLDERS.every((placeholder) => placeholders.includes(placeholder))
		|| placeholders.some((placeholder) => !XYZ_PLACEHOLDERS.includes(placeholder))) {
		return {ok: false, error: self.get_tool_label('xyz_error_placeholders') || 'The URL must contain {z}, {x} and {y}, and no other placeholder such as {s}.'}
	}
	if (!attribution) {
		return {ok: false, error: self.get_tool_label('xyz_error_attribution_required') || 'The attribution is required: it names the layer on the map.'}
	}
	if (!Number.isInteger(minzoom) || minzoom<0 || minzoom>MAX_SOURCE_ZOOM) {
		return {ok: false, error: self.get_tool_label('xyz_error_minzoom') || 'Min zoom must be an integer between 0 and 22.'}
	}
	if (!Number.isInteger(maxzoom) || maxzoom<0 || maxzoom>MAX_SOURCE_ZOOM) {
		return {ok: false, error: self.get_tool_label('xyz_error_maxzoom') || 'Max zoom must be an integer between 0 and 22.'}
	}
	if (minzoom>maxzoom) {
		return {ok: false, error: self.get_tool_label('xyz_error_zoom_range') || 'Min zoom cannot be greater than max zoom.'}
	}

	return {
		ok		: true,
		source	: {
			type		: 'xyz',
			url			: url,
			params		: {min_zoom: minzoom, max_zoom: maxzoom},
			attribution	: attribution
		}
	}
}//end validate_basemap_fields



/**
* ADD_BASEMAP
* "Add and save": the layer is saved in the record, then the component draws it through
* the tile proxy and it is switched on, as v6 activates a new base map.
*
* @param {Object} self
* @param {Object} fields - see validate_basemap_fields
* @returns {Promise<{ok: boolean, error?: string}>}
*/
export const add_basemap = async function(self, fields) {

	const validation = validate_basemap_fields(self, fields)
	if (!validation.ok) {
		return validation
	}

	const result = await add_source(self, validation.source)
	if (!result.ok) {
		return {ok: false, error: self.get_tool_label('xyz_error_save') || 'The base map could not be saved.'}
	}

	return {ok: true}
}//end add_basemap



/**
* DELETE_SAVED_BASEMAP
* Removes an XYZ layer from the record and saves.
*
* @param {Object} self
* @param {number} id - the stored source's number
* @returns {Promise<{ok: boolean, error?: string}>}
*/
export const delete_saved_basemap = async function(self, id) {

	const result = await delete_source(self, id)
	if (!result.ok) {
		return {ok: false, error: self.get_tool_label('xyz_error_save') || 'The base map could not be saved.'}
	}

	return {ok: true}
}//end delete_saved_basemap



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
