// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global L */
/*eslint no-undef: "error"*/



/**
* CATASTRO
* Panel-less toggle, as v6 (`special_tools_catastro.js`), for es/cat/eus records listing a
* `catastro` default in `properties.map_sources`. Armed, that source goes OVER the basemap
* through core's tile proxy (so the map image has it too), its checkbox ticked; v6 swapped
* the basemap, leaving only parcels on a bare container. A map click asks the server for
* the parcel, since the browser cannot read that WMS's replies, and draws it.
*/



import {response_data, request_failed} from '../../../core/common/js/api_error.js'
import {ui} from '../../../core/common/js/ui.js'
import {
	create_toolbar_button,
	is_toolbar_button_armed,
	remove_toolbar_button,
	set_toolbar_button_armed
} from './toolbar.js'
import {report_client_error} from './object_console.js'
import {
	disable_armed_layer,
	enable_armed_layer,
	is_spanish_official_lang,
	reset_armed_layer_state,
	wms_point_options
} from './armed_layer.js'
import {LOOKUP_TIMEOUT_MS} from './request_budgets.js'
import {render_attribution} from './render_download_line.js'
import {default_source} from './map_sources.js'
import {CATASTRO_CREDIT} from './core_limits.js'



const ENABLED_CLASS		= 'uca-maps-catastro-enabled'
// the `id` an administrator gives the cadastral WMS in `properties.map_sources`
const CATASTRO_SOURCE_ID	= 'catastro'



/**
* ATTACH_CATASTRO
* Idempotent; a no-op when the record's language does not gate it in (v6) or the
* component has no `catastro` source: Catastro's licence is the installation's to accept.
*
* @param {Object} self - tool_uca_maps instance
* @returns {void}
*/
export const attach_catastro = function(self) {

	if (self.catastro_control || !self.geolocation || !self.geolocation.map) {
		return
	}
	if (!is_spanish_official_lang(self) || !catastro_source(self)) {
		return
	}

	self.catastro_control = create_toolbar_button(self, {
		title		: self.get_tool_label('catastro_control_title') || 'Catastro',
		icon		: 'catastro',
		class_name	: 'uca-maps-catastro-control',
		on_click	: () => toggle_catastro(self)
	})

}//end attach_catastro



/**
* CATASTRO_SOURCE
* The component's `catastro` default (`properties.map_sources`), or null.
*
* @param {Object} self - tool_uca_maps instance
* @returns {Object|null} {kind, id, type, params, attribution, name}
*/
const catastro_source = function(self) {
	return default_source(self, CATASTRO_SOURCE_ID)
}//end catastro_source



/**
* CATASTRO_ARMED_CREDIT
* The licence asks for the source and the date on every use. The layer drawn is core's
* own, credited with the configured text alone: while armed the map also credits the
* date, after the source itself when the entry gives no credit (core's, for the same
* provider).
*
* @param {Object} self - tool_uca_maps instance
* @param {Object} source - catastro_source()
* @returns {string} plain text
*/
const catastro_armed_credit = function(self, source) {
	const name = source.attribution!==''
		? (self.get_tool_label('catastro_control_title') || 'Catastro')
		: CATASTRO_CREDIT
	// the viewer's own day: toISOString's is UTC, yesterday in Spain after midnight
	const now	= new Date()
	const day	= [now.getFullYear(), now.getMonth() + 1, now.getDate()]
		.map((part) => String(part).padStart(2, '0'))
		.join('-')
	return name + ', ' + day
}//end catastro_armed_credit



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
* Arms the button, then lays the cadastral source over the basemap and arms the click.
*
* @param {Object} self - tool_uca_maps instance
* @returns {void}
*/
const enable_catastro = function(self) {

	const source = catastro_source(self)

	set_toolbar_button_armed(self.catastro_control, ENABLED_CLASS, true)

	enable_armed_layer(self, 'catastro', {
		source_key	: 'default:' + CATASTRO_SOURCE_ID,
		build_layer	: () => self.geolocation.get_source_layer(source, {opacity: 1}),
		label		: self.get_tool_label('catastro_control_title') || 'Catastro',
		attribution	: catastro_armed_credit(self, source),
		on_click	: (latlng) => check_catastro_at_point(self, latlng),
		disarm		: () => disable_catastro(self)
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

	disable_armed_layer(self, 'catastro')

	clear_catastro_message(self)
	clear_catastro_credit(self)

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
	// a new lookup: the credit of the parcel found before is no longer the answer
	clear_catastro_credit(self)

	try {

		const response = await self.tool_request({
			action	: 'get_catastro_parcel',
			retries	: 1,
			timeout	: LOOKUP_TIMEOUT_MS,
			options	: wms_point_options(self, latlng)
		})

		// torn down or disarmed while in flight: a late response must not create a
		// parcel nobody asks for any more
		if (!self.catastro_control || !is_catastro_enabled(self)) {
			return
		}

		if (request_failed(response)) {
			// core's page notice says why, once and translated: an earlier
			// "No parcel" line must not stand beside it
			clear_catastro_message(self)
			return
		}

		const data = response_data(response)
		if (!data || !data.found) {
			// nothing failed: as UA's, a warning
			show_catastro_message(
				self,
				self.get_tool_label('catastro_not_found') || 'No parcel could be found at this point.',
				'warning'
			)
			return
		}

		// the parcel is the answer: an earlier "No parcel" no longer is. The
		// provider's credit (its licence asks for it) stays in the tool's own
		// line until the next lookup or Catastro is switched off
		clear_catastro_message(self)
		create_catastro_parcel(self, data)
		show_catastro_credit(self, data.attribution)

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
* @param {{points: Array<[number, number]>, url: string|null}} data
* @returns {void}
*/
const create_catastro_parcel = function(self, data) {

	const polygon = L.polygon(data.points)

	polygon.feature					= polygon.toGeoJSON()
	// the Sede's record of the parcel, when Catastro's answer links one
	polygon.feature.properties			= typeof data.url==='string' ? {url: data.url} : {}
	polygon.feature.properties.uca_maps	= {catastro: true}

	self.geolocation.map.fire('pm:create', {layer: polygon})
	self.geolocation.map.fitBounds(polygon.getBounds())

}//end create_catastro_parcel



/**
* SHOW_CATASTRO_MESSAGE
* No panel to hold a line, so the core's banner, scoped to the map component so it
* never fights another component's message. Each message replaces the line
* before it: the banner tints all its lines with the last type.
*
* @param {Object} self - tool_uca_maps instance
* @param {string} text
* @param {string} [type='error'] - 'error' | 'warning'
* @returns {void}
*/
const show_catastro_message = function(self, text, type='error') {
	ui.show_message(self.geolocation.node, text, type, 'uca-maps-catastro-message', true)
}//end show_catastro_message



/**
* CLEAR_CATASTRO_MESSAGE
* Takes the banner away: a found parcel or a disarmed Catastro leaves no line
* about a lookup that is over. Guarded, the component may already be gone.
*
* @param {Object} self - tool_uca_maps instance
* @returns {void}
*/
const clear_catastro_message = function(self) {
	const banner = self.geolocation && self.geolocation.node
		? self.geolocation.node.querySelector('.uca-maps-catastro-message')
		: null
	if (banner) {
		banner.remove()
	}
}//end clear_catastro_message



/**
* SHOW_CATASTRO_CREDIT / CLEAR_CATASTRO_CREDIT
* The tool's own line under the map component, as core's banner, but one that
* does not time out: the credit belongs beside the parcel while it is the answer.
*
* @param {Object} self - tool_uca_maps instance
* @param {string|null|undefined} text
* @returns {void}
*/
const show_catastro_credit = function(self, text) {
	clear_catastro_credit(self)
	if (!self.geolocation || !self.geolocation.node) {
		return
	}
	const credit = render_attribution(text, self.geolocation.node)
	if (credit) {
		credit.classList.add('uca-maps-catastro-credit')
		self._catastro_credit = credit
	}
}//end show_catastro_credit

const clear_catastro_credit = function(self) {
	if (self._catastro_credit) {
		self._catastro_credit.remove()
	}
	self._catastro_credit = null
}//end clear_catastro_credit



/**
* DETACH_CATASTRO
* Disarms first, so the armed layer and the click listener are reversed.
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
	clear_catastro_credit(self)

	self.catastro_control	= null
	self._catastro_busy		= false
	reset_armed_layer_state(self, 'catastro')

}//end detach_catastro



// @license-end
