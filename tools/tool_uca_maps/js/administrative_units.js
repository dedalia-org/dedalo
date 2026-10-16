// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global L */
/*eslint no-undef: "error"*/



/**
* ADMINISTRATIVE_UNITS
* "Administrative Units" (UA): the same language gate and basemap swap as Catastro.
* v6's one toggle (`special_tools_UA_es.js` UA_on/UA_off) shows the level select, swaps
* the basemap for the AU.AdministrativeUnit WMS and arms the click; here opening the
* panel IS arming, and closing it, by any path, disarms.
*/



import {response_data, request_failed} from '../../../core/common/js/api_error.js'
import {tool_error_text} from './tool_error_text.js'
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



/** v6's gate for Catastro and UA: the record's language is Spanish, Catalan or Basque. */
const is_spanish_official_lang = function(self) {
	const lang = self.geolocation && self.geolocation.section_lang
	return lang==='lg-spa' || lang==='lg-cat' || lang==='lg-eus'
}//end is_spanish_official_lang



/**
* ATTACH_ADMINISTRATIVE_UNITS
* Idempotent; a no-op when the record's language does not gate it in (v6).
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

	const title = self.get_tool_label('ua_control_title') || 'Administrative Units'

	self.ua_control = create_toolbar_button(self, {
		title		: title,
		text		: 'UA',
		class_name	: 'uca-maps-ua-control',
		on_click	: () => toggle_ua_panel(self)
	})

	// on_hide: a SIBLING panel forcing this one shut must disarm too, or the
	// overlay and click listener keep running with no panel to show for them
	self.ua_panel = create_toolbar_panel(self, {
		class_name	: 'uca-maps-ua-panel',
		centered	: true,
		title		: title,
		on_hide		: () => disable_ua(self)
	})
	render_administrative_units_panel(self, self.ua_panel)

}//end attach_administrative_units



/**
* TOGGLE_UA_PANEL
* Opening arms the overlay and click; closing disarms. Direction read from the
* panel's real state before the flip, never a flag.
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
* Swaps the basemap for the AU.AdministrativeUnit WMS, as `enable_catastro`: the layer
* control's own API, the previous tile layers remembered so disabling restores them.
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
	self._ua_tile_layer.addTo(map) // the layer control redraws itself: no radio click to simulate

	self._ua_click_handler = (event) => check_administrative_unit_at_point(self, event.latlng)
	map.on('click', self._ua_click_handler)

}//end enable_ua



/**
* DISABLE_UA
* Reverses ENABLE_UA: off the map and the control, previous basemaps back, a
* self-created control removed.
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
* v6's `init_UA` click without its client-side `nationallevel` filter: the server
* already returns at most the ONE feature of the chosen level. Exported for the
* client gate.
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

		// torn down or closed (by any path) while in flight: a late response must
		// not create an object nobody asks for any more
		if (!self.ua_panel || !is_toolbar_panel_visible(self.ua_panel)) {
			return
		}

		if (request_failed(response)) {
			const failed = self.get_tool_label('ua_error_failed') || 'The administrative unit could not be looked up.'
			show_ua_message(self.ua_panel, tool_error_text(response.error, failed))
			return
		}

		const data = response_data(response)
		if (!data || !data.found) {
			show_ua_message(
				self.ua_panel,
				self.get_tool_label('ua_not_found') || 'No administrative unit could be found at this point.',
				'warning'
			)
			return
		}

		clear_ua_message(self.ua_panel)
		create_administrative_unit_object(self, data.feature)

	} catch (error) {
		// torn down while in flight: the page toast would report work the
		// user already left behind
		if (!self.ua_panel) {
			return
		}
		console.error('tool_uca_maps: administrative unit lookup failed unexpectedly', error)
		report_client_error((error && error.message) || 'Administrative unit lookup failed')
	} finally {
		self._ua_busy = false
	}

}//end check_administrative_unit_at_point



/**
* CREATE_ADMINISTRATIVE_UNIT_OBJECT
* Pans to a point, fits anything with extent (v6's `init_UA`). With one feature from
* the server there is nothing to compare.
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
* Disarms first, so the basemap swap and the click listener are reversed.
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
