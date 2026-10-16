// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global L */
/*eslint no-undef: "error"*/



/**
* CATASTRO
* Panel-less toggle, as v6 (`special_tools_catastro.js`), offered for es/cat/eus
* records. Armed, the cadastral WMS REPLACES the basemap, as v6, through the layer
* control's own API instead of v6's simulated radio click. A map click asks the server
* for the parcel (the browser cannot read that WMS's replies) and draws it.
*/



import {response_data, request_failed} from '../../../core/common/js/api_error.js'
import {tool_error_text} from './tool_error_text.js'
import {ui} from '../../../core/common/js/ui.js'
import {
	create_toolbar_button,
	is_toolbar_button_armed,
	remove_toolbar_button,
	set_toolbar_button_armed
} from './toolbar.js'
import {report_client_error} from './object_console.js'
import {
	disable_basemap_swap,
	enable_basemap_swap,
	is_spanish_official_lang,
	wms_point_options
} from './basemap_swap.js'



const ENABLED_CLASS	= 'uca-maps-catastro-enabled'
const CATASTRO_URL	= 'https://ovc.catastro.meh.es/Cartografia/WMS/ServidorWMS.aspx'



/**
* ATTACH_CATASTRO
* Idempotent; a no-op when the record's language does not gate it in (v6).
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
		text		: 'CAT',
		class_name	: 'uca-maps-catastro-control',
		on_click	: () => toggle_catastro(self)
	})

}//end attach_catastro



/**
* IS_CATASTRO_ENABLED
* Read from the button's own class, never a cached flag.
*
* @param {Object} self - tool_uca_maps instance
* @returns {boolean}
*/
// exported for the client gate
export const is_catastro_enabled = function(self) {
	return is_toolbar_button_armed(self.catastro_control, ENABLED_CLASS)
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
* Arms the button, then swaps the basemap for the cadastral WMS and arms the click.
*
* @param {Object} self - tool_uca_maps instance
* @returns {void}
*/
const enable_catastro = function(self) {

	set_toolbar_button_armed(self.catastro_control, ENABLED_CLASS, true)

	enable_basemap_swap(self, 'catastro', {
		url			: CATASTRO_URL,
		wms_options	: {
			layers		: 'Catastro',
			format		: 'image/png',
			transparent	: true,
			opacity		: 1,
			maxZoom		: 21
		},
		label		: self.get_tool_label('catastro_control_title') || 'Catastro',
		on_click	: (latlng) => check_catastro_at_point(self, latlng)
	})

}//end enable_catastro



/**
* DISABLE_CATASTRO
* Reverses ENABLE_CATASTRO.
*
* @param {Object} self - tool_uca_maps instance
* @returns {void}
*/
const disable_catastro = function(self) {

	set_toolbar_button_armed(self.catastro_control, ENABLED_CLASS, false)

	disable_basemap_swap(self, 'catastro')

}//end disable_catastro



/**
* CHECK_CATASTRO_AT_POINT
* v6's `map_click` with a busy flag instead of its off/on re-subscribe: one lookup at
* a time, no click queued. Skipped in Geoman's edit mode. Exported for the client gate.
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

		const response = await self.tool_request({
			action	: 'get_catastro_parcel',
			options	: wms_point_options(self, latlng)
		})

		// torn down or disarmed while in flight: a late response must not create a
		// parcel nobody asks for any more
		if (!self.catastro_control || !is_catastro_enabled(self)) {
			return
		}

		if (request_failed(response)) {
			const failed = self.get_tool_label('catastro_error_failed') || 'The cadastral parcel could not be looked up.'
			show_catastro_message(self, tool_error_text(response.error, failed))
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
		// torn down while in flight: the page toast would report work the
		// user already left behind
		if (!self.catastro_control) {
			return
		}
		console.error('tool_uca_maps: catastro lookup failed unexpectedly', error)
		report_client_error((error && error.message) || 'Catastro lookup failed')
	} finally {
		self._catastro_busy = false
	}

}//end check_catastro_at_point



/**
* CREATE_CATASTRO_PARCEL
* The points arrive as [lat, lon], so no reprojection. The parcel URL is a REGULAR
* property, as v6: the console lists it as a visible key, not hidden bookkeeping.
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
* No panel to hold a line, so the core's banner, scoped to the map component so it
* never fights another component's message.
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
* Disarms first, so the basemap swap and the click listener are reversed.
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
