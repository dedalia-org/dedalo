// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global L */
/*eslint no-undef: "error"*/



/**
* ADMINISTRATIVE_UNITS
* Fila #9 del audit ("Unidades Administrativas", UA). Same gating condition
* and basemap-swap pattern as `catastro.js` (row #8) — gated on the record's
* language (`section_lang` es/cat/eus, duplicated here rather than imported
* from `catastro.js`: a one-line boolean is not worth a cross-file coupling).
*
* v6's own toggle (`special_tools_UA_es.js` UA_on/UA_off) does three things
* at once: shows a level `<select>`, SWAPS the active basemap for the
* AU.AdministrativeUnit WMS map (confirmed live by Sergio, 2026-09-08
* validation — same fix as `catastro.js`, see `enable_ua`'s own doc comment),
* and arms the click listener. This port keeps that single-toggle semantics
* but expresses "shown" through toolbar.js's own panel-visibility convention
* — opening the panel IS arming (`toggle_ua_panel` below), closing it
* disarms — rather than a bespoke show/hide class pair.
*/



import {response_data, request_failed} from '../../../core/common/js/api_error.js'
import {error_text} from '../../../core/common/js/render_api_error.js'
import {
	create_toolbar_button,
	create_toolbar_panel,
	register_toolbar_node,
	set_toolbar_panel_visible,
	is_toolbar_panel_visible,
	remove_toolbar_button,
	remove_toolbar_panel
} from './toolbar.js'
import {render_administrative_units_panel, show_ua_message, clear_ua_message} from './render_administrative_units.js'
import {report_client_error} from './object_console.js'



const UA_URL = 'https://www.ign.es/wms-inspire/unidades-administrativas'



/** Shared v6 gating condition — see `catastro.js`'s own copy for why this is
* duplicated rather than imported. */
const is_spanish_official_lang = function(self) {
	const lang = self.geolocation && self.geolocation.section_lang
	return lang==='lg-spa' || lang==='lg-cat' || lang==='lg-eus'
}//end is_spanish_official_lang



/**
* ATTACH_ADMINISTRATIVE_UNITS
* Builds the "UA" button+panel. Idempotent; a no-op when the record's
* language does not gate this functionality in (v6 parity, same condition as
* Catastro).
*
* @param {Object} self - tool_uca_maps instance
* @returns {void}
*/
export const attach_administrative_units = function(self) {

	if (self.ua_control || !self.geolocation || !self.geolocation.map) {
		return
	}
	if (!is_spanish_official_lang(self)) {
		return
	}

	self._ua_level = self._ua_level || 'Municipio'

	self.ua_control = create_toolbar_button(self, {
		title		: self.get_tool_label('ua_control_title') || 'Administrative Units',
		text		: 'UA',
		class_name	: 'uca-maps-ua-control',
		on_click	: () => toggle_ua_panel(self)
	})

	// on_hide: the actual fix for the doc comment below's claim — without it,
	// a SIBLING panel forcing this one shut (toolbar.js close_other_toolbar_
	// panels) left the overlay+click listener running with no panel visible
	// to show for it (review-diff finding, hito 11)
	self.ua_panel = create_toolbar_panel(self, {class_name: 'uca-maps-ua-panel', on_hide: () => disable_ua(self)})
	render_administrative_units_panel(self, self.ua_panel)

}//end attach_administrative_units



/**
* TOGGLE_UA_PANEL
* Opening the panel arms the overlay+click listener; closing it (including a
* SIBLING panel forcing this one shut via toolbar.js's own exclusivity) must
* also disarm — read from `is_toolbar_panel_visible` BEFORE the flip, same
* "DOM is truth" law as every other toggle_X here.
*
* @param {Object} self - tool_uca_maps instance
* @returns {void}
*/
const toggle_ua_panel = function(self) {

	const next_visible = !is_toolbar_panel_visible(self.ua_panel)

	set_toolbar_panel_visible(self, self.ua_panel, self.ua_control, next_visible)

	if (next_visible) {
		enable_ua(self)
	} else {
		disable_ua(self)
	}

}//end toggle_ua_panel



/**
* ENABLE_UA
* Swaps the active basemap for the AU.AdministrativeUnit WMS map (v6 parity,
* confirmed live by Sergio, 2026-09-08 validation — same fix as
* `catastro.js`'s `enable_catastro`, see its own doc comment for the full
* rationale: `geolocation.layer_control`'s real API, no simulated radio
* click). `self._ua_previous_base_layers` remembers whatever was active
* before the swap so DISABLE_UA can restore it exactly.
*
* @param {Object} self - tool_uca_maps instance
* @returns {void}
*/
const enable_ua = function(self) {

	const geolocation	= self.geolocation
	const map			= geolocation.map

	if (!geolocation.layer_control) {
		geolocation.layer_control = L.control.layers({}).addTo(map)
		self._ua_created_layer_control = true
		register_toolbar_node(self, geolocation.layer_control.getContainer())
	}
	const layer_control = geolocation.layer_control

	self._ua_previous_base_layers = []
	map.eachLayer((layer) => {
		if (layer instanceof L.TileLayer) {
			self._ua_previous_base_layers.push(layer)
			map.removeLayer(layer)
		}
	})

	self._ua_tile_layer = L.tileLayer.wms(UA_URL + '?', {
		layers		: 'AU.AdministrativeUnit',
		format		: 'image/png',
		transparent	: true,
		opacity		: 1
	})
	layer_control.addBaseLayer(self._ua_tile_layer, self.get_tool_label('ua_control_title') || 'Administrative Units')
	self._ua_tile_layer.addTo(map) // triggers layer_control's own _update() — no radio click to simulate

	self._ua_click_handler = (event) => check_administrative_unit_at_point(self, event.latlng)
	map.on('click', self._ua_click_handler)

}//end enable_ua



/**
* DISABLE_UA
* Reverses ENABLE_UA exactly — see `catastro.js`'s `disable_catastro` for the
* same shape (drop from map+control, restore the previous basemap(s), remove
* a self-created control).
*
* @param {Object} self - tool_uca_maps instance
* @returns {void}
*/
const disable_ua = function(self) {

	const geolocation	= self.geolocation
	const map			= geolocation.map

	if (self._ua_click_handler) {
		map.off('click', self._ua_click_handler)
		self._ua_click_handler = null
	}

	if (self._ua_tile_layer) {
		if (geolocation.layer_control) {
			geolocation.layer_control.removeLayer(self._ua_tile_layer)
		}
		map.removeLayer(self._ua_tile_layer)
		self._ua_tile_layer = null
	}

	for (const layer of self._ua_previous_base_layers || []) {
		layer.addTo(map)
	}
	self._ua_previous_base_layers = null

	if (self._ua_created_layer_control && geolocation.layer_control) {
		map.removeControl(geolocation.layer_control)
		geolocation.layer_control = false
		self._ua_created_layer_control = false
	}

}//end disable_ua



/**
* CHECK_ADMINISTRATIVE_UNIT_AT_POINT
* Ports v6's map click handler (`init_UA`), minus the client-side
* `nationallevel` filtering — the server (`administrative_units.ts`) already
* returns at most the ONE feature matching the selected level. EXPORTED
* (takes a plain latlng, not a Leaflet event) so tests can await it directly,
* same testability convention as `wms_services.js`'s exported
* `search_wms_layers`.
*
* @param {Object} self - tool_uca_maps instance
* @param {Object} latlng - a Leaflet LatLng
* @returns {Promise<void>}
*/
export const check_administrative_unit_at_point = async function(self, latlng) {

	if (self._ua_busy || self.geolocation.map.pm.globalEditModeEnabled()) {
		return
	}
	self._ua_busy = true

	try {

		const bounds	= self.geolocation.map.getBounds()
		const point		= self.geolocation.map.latLngToContainerPoint(latlng)
		const size		= self.geolocation.map.getSize()

		const response = await self.tool_request({
			action	: 'get_administrative_unit',
			options	: {
				tipo			: self.geolocation.tipo,
				section_id		: self.geolocation.section_id,
				section_tipo	: self.geolocation.section_tipo,
				bbox			: [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()],
				width			: size.x,
				height			: size.y,
				x				: point.x,
				y				: point.y,
				level			: self._ua_level
			}
		})

		// the tool may have been torn down, OR the panel may have been closed
		// (by its own toggle or a sibling forcing it shut) while this request
		// was in flight — either way a late response must not create an
		// object nobody asked for any more (review-diff finding, hito 11)
		if (!self.ua_panel || !is_toolbar_panel_visible(self.ua_panel)) {
			return
		}

		if (request_failed(response)) {
			show_ua_message(self.ua_panel, error_text(response.error))
			return
		}

		const data = response_data(response)
		if (!data || !data.found) {
			show_ua_message(
				self.ua_panel,
				self.get_tool_label('ua_not_found') || 'No administrative unit could be found at this point.'
			)
			return
		}

		clear_ua_message(self.ua_panel)
		create_administrative_unit_object(self, data.feature)

	} catch (error) {
		console.error('tool_uca_maps: administrative unit lookup failed unexpectedly', error)
		report_client_error((error && error.message) || 'Administrative unit lookup failed')
	} finally {
		self._ua_busy = false
	}

}//end check_administrative_unit_at_point



/**
* CREATE_ADMINISTRATIVE_UNIT_OBJECT
* `L.geoJSON` already sets `.feature` on every layer it builds (Leaflet's own
* `geometryToLayer`) — no manual assignment needed here, unlike
* `catastro.js`'s hand-built `L.polygon`. Pan to a point, fit bounds to
* anything with an area/length — v6's own tie-break (`init_UA`), simplified
* because the server returns exactly one feature, never several to compare.
*
* @param {Object} self - tool_uca_maps instance
* @param {Object} feature - a GeoJSON Feature
* @returns {void}
*/
const create_administrative_unit_object = function(self, feature) {

	const [layer] = L.geoJSON(feature).getLayers()
	if (!layer) {
		return
	}

	self.geolocation.map.fire('pm:create', {layer})

	if (typeof layer.getLatLng==='function') {
		self.geolocation.map.panTo(layer.getLatLng())
	} else if (typeof layer.getBounds==='function') {
		self.geolocation.map.fitBounds(layer.getBounds())
	}

}//end create_administrative_unit_object



/**
* DETACH_ADMINISTRATIVE_UNITS
* Real teardown (CLAUDE.local.md) — mirrors `wms_services.js`'s detach shape.
*
* @param {Object} self - tool_uca_maps instance
* @returns {void}
*/
export const detach_administrative_units = function(self) {

	if (self.geolocation && self.geolocation.map) {
		disable_ua(self)
	}

	remove_toolbar_button(self, self.ua_control)
	remove_toolbar_panel(self, self.ua_panel)

	self.ua_control				= null
	self.ua_panel				= null
	self._ua_busy				= false
	self._ua_previous_base_layers	= null
	self._ua_created_layer_control	= false

}//end detach_administrative_units



// @license-end
