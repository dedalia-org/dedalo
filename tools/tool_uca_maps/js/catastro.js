// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global L */
/*eslint no-undef: "error"*/



/**
* CATASTRO
* Fila #8 del audit. Toggle button with NO panel — v6 has none either
* (`special_tools_catastro.js`), same "no panel needed" precedent as
* `onexone.js` (hito 7). Gated on the record's language (`section_lang`
* es/cat/eus, v6's own condition — `render_tool_leaflet_special_tools.js:
* 2016-2107` — shared verbatim with UA, `administrative_units.js`).
*
* While armed: the cadastral WMS map REPLACES the active basemap (v6 parity —
* confirmed live by Sergio, 2026-09-08 validation: v6's own UX swaps the base
* layer and marks it selected in the map's own layer-control, it is not an
* overlay sitting on top). This port reuses `geolocation.layer_control`'s real
* API the exact same way `xyz_basemaps.js` (hito 9) already does —
* `addBaseLayer` + `.addTo(map)`, which Leaflet's own control redraws itself
* from (`_update()`, driven by `map.hasLayer`) — rather than v6's DOM-fragile
* `catastro_on` (removes every tile layer by hand, then simulates a click on
* the LAST `.leaflet-control-layers-selector` radio to select the one it just
* added). Clicking the map queries the parcel under the cursor — a
* server-side proxy (`server/catastro.ts`, the browser cannot read that WMS
* server's HTML/GML replies directly) — and draws the result as a new
* polygon through the real `pm:create` pipeline, same mechanism as
* `onexone.js`.
*/



import {response_data, request_failed} from '../../../core/common/js/api_error.js'
import {error_text} from '../../../core/common/js/render_api_error.js'
import {ui} from '../../../core/common/js/ui.js'
import {create_toolbar_button, register_toolbar_node, remove_toolbar_button} from './toolbar.js'
import {report_client_error} from './object_console.js'



const ENABLED_CLASS	= 'uca-maps-catastro-enabled'
const CATASTRO_URL	= 'https://ovc.catastro.meh.es/Cartografia/WMS/ServidorWMS.aspx'



/**
* IS_SPANISH_OFFICIAL_LANG
* Shared v6 gating condition for Catastro/UA — a plain record-language read,
* duplicated (not imported) in `administrative_units.js`: importing a one-line
* boolean across the two files would be a real coupling for zero reuse benefit.
*
* @param {Object} self - tool_uca_maps instance
* @returns {boolean}
*/
export const is_spanish_official_lang = function(self) {
	const lang = self.geolocation && self.geolocation.section_lang
	return lang==='lg-spa' || lang==='lg-cat' || lang==='lg-eus'
}//end is_spanish_official_lang



/**
* ATTACH_CATASTRO
* Builds the "Catastro" toggle button. Idempotent; a no-op entirely when the
* record's language does not gate this functionality in (v6 parity).
*
* @param {Object} self - tool_uca_maps instance
* @returns {void}
*/
export const attach_catastro = function(self) {

	if (self.catastro_control || !self.geolocation || !self.geolocation.map) {
		return
	}
	if (!is_spanish_official_lang(self)) {
		return
	}

	self.catastro_control = create_toolbar_button(self, {
		title		: self.get_tool_label('catastro_control_title') || 'Catastro',
		text		: 'Catastro',
		class_name	: 'uca-maps-catastro-control',
		on_click	: () => toggle_catastro(self)
	})

}//end attach_catastro



/**
* IS_CATASTRO_ENABLED
* Same "read the DOM, never a cached flag" law as every other toggle here
* (toolbar.js file header, onexone.js is_onexone_enabled).
*
* @param {Object} self - tool_uca_maps instance
* @returns {boolean}
*/
export const is_catastro_enabled = function(self) {
	const container = self.catastro_control && self.catastro_control.getContainer
		&& self.catastro_control.getContainer()
	return Boolean(container && container.classList.contains(ENABLED_CLASS))
}//end is_catastro_enabled



const toggle_catastro = function(self) {
	if (is_catastro_enabled(self)) {
		disable_catastro(self)
	} else {
		enable_catastro(self)
	}
}//end toggle_catastro



/**
* ENABLE_CATASTRO
* Swaps the active basemap for the cadastral WMS map (file header — v6
* parity) and arms the map click listener. Reuses `geolocation.layer_control`
* if one already exists (xyz_basemaps.js's own attach runs first — render_
* tool_uca_maps.js attach order — so in practice it always does) and creates
* one itself only as a defensive fallback, same guard `rebuild_xyz_layer_
* control` uses.
*
* `self._catastro_previous_base_layers` remembers whatever tile layer(s) were
* actually active on the map right before the swap (asked live via
* `map.hasLayer`, never a cached "current basemap" reference) — DISABLE_
* CATASTRO restores exactly those, whatever they were (an XYZ custom basemap,
* the provider's own default, …).
*
* @param {Object} self - tool_uca_maps instance
* @returns {void}
*/
const enable_catastro = function(self) {

	const geolocation	= self.geolocation
	const map			= geolocation.map

	self.catastro_control.getContainer().classList.add(ENABLED_CLASS)

	if (!geolocation.layer_control) {
		geolocation.layer_control = L.control.layers({}).addTo(map)
		self._catastro_created_layer_control = true
		register_toolbar_node(self, geolocation.layer_control.getContainer())
	}
	const layer_control = geolocation.layer_control

	self._catastro_previous_base_layers = []
	map.eachLayer((layer) => {
		if (layer instanceof L.TileLayer) {
			self._catastro_previous_base_layers.push(layer)
			map.removeLayer(layer)
		}
	})

	self._catastro_tile_layer = L.tileLayer.wms(CATASTRO_URL + '?', {
		layers		: 'Catastro',
		format		: 'image/png',
		transparent	: true,
		opacity		: 1,
		maxZoom		: 21
	})
	layer_control.addBaseLayer(self._catastro_tile_layer, self.get_tool_label('catastro_control_title') || 'Catastro')
	self._catastro_tile_layer.addTo(map) // triggers layer_control's own _update() — no radio click to simulate

	self._catastro_click_handler = (event) => check_catastro_at_point(self, event.latlng)
	map.on('click', self._catastro_click_handler)

}//end enable_catastro



/**
* DISABLE_CATASTRO
* Reverses ENABLE_CATASTRO exactly: drops the cadastral layer from both the
* map and the layer-control (v6's own `catastro_off` also removes it from
* `layer_control`, not just the map — a stale disabled entry would otherwise
* linger in the basemap list), restores whatever basemap(s) were active
* before, and disarms the click listener.
*
* @param {Object} self - tool_uca_maps instance
* @returns {void}
*/
const disable_catastro = function(self) {

	const geolocation	= self.geolocation
	const map			= geolocation.map

	self.catastro_control.getContainer().classList.remove(ENABLED_CLASS)

	if (self._catastro_click_handler) {
		map.off('click', self._catastro_click_handler)
		self._catastro_click_handler = null
	}

	if (self._catastro_tile_layer) {
		if (geolocation.layer_control) {
			geolocation.layer_control.removeLayer(self._catastro_tile_layer)
		}
		map.removeLayer(self._catastro_tile_layer)
		self._catastro_tile_layer = null
	}

	for (const layer of self._catastro_previous_base_layers || []) {
		layer.addTo(map)
	}
	self._catastro_previous_base_layers = null

	// only remove the control if THIS toggle created it (no provider one
	// existed) — same "created_layer_control" convention as xyz_basemaps.js
	if (self._catastro_created_layer_control && geolocation.layer_control) {
		map.removeControl(geolocation.layer_control)
		geolocation.layer_control = false
		self._catastro_created_layer_control = false
	}

}//end disable_catastro



/**
* CHECK_CATASTRO_AT_POINT
* Ports v6's `map_click` (`special_tools_catastro.js`): a busy flag replaces
* v6's own setTimeout-based debounce (its `map.off`/`map.on` pair around the
* request — a race-prone re-subscribe, not a lock) — one lookup in flight at
* a time, no click queued while it runs. Also skips while Geoman's own edit
* mode is active, same guard `onexone.js` uses. EXPORTED (takes a plain
* latlng, not a Leaflet event) so tests can await it directly, same
* testability convention as `wms_services.js`'s exported `search_wms_layers`.
*
* @param {Object} self - tool_uca_maps instance
* @param {Object} latlng - a Leaflet LatLng
* @returns {Promise<void>}
*/
export const check_catastro_at_point = async function(self, latlng) {

	if (self._catastro_busy || self.geolocation.map.pm.globalEditModeEnabled()) {
		return
	}
	self._catastro_busy = true

	try {

		const bounds	= self.geolocation.map.getBounds()
		const point		= self.geolocation.map.latLngToContainerPoint(latlng)
		const size		= self.geolocation.map.getSize()

		const response = await self.tool_request({
			action	: 'get_catastro_parcel',
			options	: {
				tipo			: self.geolocation.tipo,
				section_id		: self.geolocation.section_id,
				section_tipo	: self.geolocation.section_tipo,
				bbox			: [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()],
				width			: size.x,
				height			: size.y,
				x				: point.x,
				y				: point.y
			}
		})

		// the tool may have been torn down, OR the user may have disarmed
		// Catastro (second click) while this request was in flight — either
		// way a late response must not create a parcel nobody asked for any
		// more (review-diff finding, hito 11)
		if (!self.catastro_control || !is_catastro_enabled(self)) {
			return
		}

		if (request_failed(response)) {
			show_catastro_message(self, error_text(response.error))
			return
		}

		const data = response_data(response)
		if (!data || !data.found) {
			show_catastro_message(
				self,
				self.get_tool_label('catastro_not_found') || 'No parcel could be found at this point.'
			)
			return
		}

		create_catastro_parcel(self, data)

	} catch (error) {
		console.error('tool_uca_maps: catastro lookup failed unexpectedly', error)
		report_client_error((error && error.message) || 'Catastro lookup failed')
	} finally {
		self._catastro_busy = false
	}

}//end check_catastro_at_point



/**
* CREATE_CATASTRO_PARCEL
* `data.points` already arrives as [lat, lon] pairs (server-side GML parse,
* `catastro.ts` extractParcelPosList) — no reprojection needed, same as
* `L.polygon(latlngs)` in the v6 oracle. The refcat's own record URL is kept
* as a REGULAR (not `uca_maps`-namespaced) property — v6 parity: it is meant
* to show up as a normal, visible key in the object console's properties
* list, not hidden bookkeeping like `onexone.js`'s own uid links.
*
* @param {Object} self - tool_uca_maps instance
* @param {{points: Array<[number, number]>, url: string}} data
* @returns {void}
*/
const create_catastro_parcel = function(self, data) {

	const polygon = L.polygon(data.points)

	polygon.feature					= polygon.toGeoJSON()
	polygon.feature.properties			= {url: data.url}
	polygon.feature.properties.uca_maps	= {catastro: true}

	self.geolocation.map.fire('pm:create', {layer: polygon})
	self.geolocation.map.fitBounds(polygon.getBounds())

}//end create_catastro_parcel



/**
* SHOW_CATASTRO_MESSAGE
* This button has no anchored panel (file header) to write an in-flow line
* into (unlike `wms_services.js`/`xyz_basemaps.js`), so feedback goes through
* the core's own page-level banner instead, scoped to the live map component
* so it never fights another component's own `component_message`.
*
* @param {Object} self - tool_uca_maps instance
* @param {string} text
* @returns {void}
*/
const show_catastro_message = function(self, text) {
	ui.show_message(self.geolocation.node, text, 'error', 'uca-maps-catastro-message')
}//end show_catastro_message



/**
* DETACH_CATASTRO
* Real teardown (CLAUDE.local.md) — mirrors `onexone.js`'s detach shape.
*
* @param {Object} self - tool_uca_maps instance
* @returns {void}
*/
export const detach_catastro = function(self) {

	if (self.catastro_control) {
		if (self.geolocation && self.geolocation.map && is_catastro_enabled(self)) {
			disable_catastro(self)
		}
		remove_toolbar_button(self, self.catastro_control)
	}

	self.catastro_control				= null
	self._catastro_tile_layer			= null
	self._catastro_click_handler		= null
	self._catastro_busy				= false
	self._catastro_previous_base_layers	= null
	self._catastro_created_layer_control	= false

}//end detach_catastro



// @license-end
