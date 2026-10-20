// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global L */
/*eslint no-undef: "error"*/



/**
* VECTOR_UPLOAD
* "Upload file to map": owns the button and panel the image upload shares. v6 parses
* .zip/.kml in the browser with a fixed 18-code EPSG table; here the raw file is staged
* and the server converts it with `ogr2ogr`, whose PROJ database reprojects any
* embedded CRS. The client only draws `L.geoJSON`.
*/



import {upload} from '../../../core/services/service_upload/js/service_upload.js'
import {response_data, request_failed} from '../../../core/common/js/api_error.js'
import {tool_error_text} from './tool_error_text.js'
import {
	create_toolbar_button,
	create_toolbar_panel,
	set_toolbar_panel_visible,
	is_toolbar_panel_visible,
	remove_toolbar_button,
	remove_toolbar_panel
} from './toolbar.js'
import {render_file_upload_panel, clear_upload_messages, reset_file_upload_panel} from './render_file_upload.js'
import {report_client_error} from './object_console.js'



const VECTOR_UPLOAD_EXTENSIONS	= ['zip', 'geojson', 'kml']
const VECTOR_UPLOAD_MAX_BYTES	= 10_000_000 // v6/server parity, see vector_upload.ts
const VECTOR_UPLOAD_KEY_DIR	= 'uca_maps_vector'



/**
* ATTACH_FILE_UPLOAD
* Builds the "Upload file to map" button+panel. No language/section-tipo
* gate (unlike Catastro/UA): v6 has none either. Idempotent.
*
* @param {Object} self - tool_uca_maps instance
* @returns {void}
*/
export const attach_file_upload = function(self) {

	if (self.upload_control || !self.geolocation || !self.geolocation.map) {
		return
	}

	const title = self.get_tool_label('upload_control_title') || 'Upload file to map'

	self.upload_control = create_toolbar_button(self, {
		title		: title,
		icon		: 'upload',
		class_name	: 'uca-maps-upload-control',
		on_click	: () => toggle_upload_panel(self)
	})

	self.upload_panel = create_toolbar_panel(self, {
		class_name	: 'uca-maps-upload-panel',
		centered	: true,
		title		: title
	})
	render_file_upload_panel(self, self.upload_panel)

}//end attach_file_upload



/**
* TOGGLE_UPLOAD_PANEL
* Nothing is "armed" by opening this panel, unlike Catastro/UA (no map click
* listener, no basemap swap). Every open starts clean, as v6's rebuilt modal
* does: an old message, chosen file or typed projection never greets it.
*
* @param {Object} self - tool_uca_maps instance
* @returns {void}
*/
const toggle_upload_panel = function(self) {

	const next_visible = !is_toolbar_panel_visible(self.upload_panel)
	if (next_visible) {
		reset_file_upload_panel(self.upload_panel)
	}

	set_toolbar_panel_visible(self, self.upload_panel, self.upload_control, next_visible)

}//end toggle_upload_panel



/**
* UPLOAD_VECTOR_FILE
* The engine's generic upload stages the raw file, then `upload_vector_layer`
* converts it to WGS84 GeoJSON. Takes plain arguments, not a DOM event, so the client
* gate can await it.
*
* @param {Object} self - tool_uca_maps instance
* @param {File} file - the browser File object chosen by the user
* @param {{epsg?: string, zone?: string, band?: string}} [projection] - v6's
*	manual UTM projection, all three or none (checked server-side)
* @returns {Promise<{ok: boolean, error?: string, feature_count?: number}>}
*/
export const upload_vector_file = async function(self, file, projection = {}) {

	if (self._upload_busy) {
		return {ok: false}
	}
	if (!file) {
		return {ok: false, error: self.get_tool_label('upload_no_file') || 'Please choose a file first.'}
	}

	self._upload_busy = true

	const not_uploaded = self.get_tool_label('upload_error_transport') || 'The file could not be uploaded.'

	try {

		const upload_response = await upload({
			id					: self.id,
			file				: file,
			key_dir				: VECTOR_UPLOAD_KEY_DIR,
			allowed_extensions	: VECTOR_UPLOAD_EXTENSIONS,
			max_size_bytes		: VECTOR_UPLOAD_MAX_BYTES,
			tipo				: self.geolocation.tipo
		})

		const rejected = self.get_tool_label('upload_error_rejected') || 'The file could not be loaded.'

		if (!response_data(upload_response)) {
			const message = upload_response && upload_response.error
				? tool_error_text(upload_response.error, rejected)
				: not_uploaded
			return {ok: false, error: message}
		}

		const response = await self.tool_request({
			action	: 'upload_vector_layer',
			options	: {
				tipo			: self.geolocation.tipo,
				section_id		: self.geolocation.section_id,
				section_tipo	: self.geolocation.section_tipo,
				file_data		: upload_response.file_data,
				epsg			: String(projection.epsg || '').trim(),
				zone			: String(projection.zone || '').trim(),
				band			: String(projection.band || '').trim()
			}
		})

		// torn down while in flight: a late response is discarded
		if (!self.upload_panel) {
			return {ok: false}
		}

		if (request_failed(response)) {
			return {ok: false, error: tool_error_text(response.error, rejected)}
		}

		const data = response_data(response)
		const feature_count = create_features_from_geojson(self, data && data.geojson)

		return {ok: true, feature_count}

	} catch (error) {
		console.error('tool_uca_maps: upload_vector_file failed unexpectedly', error)
		report_client_error((error && error.message) || 'Vector file upload failed')
		return {ok: false, error: not_uploaded}
	} finally {
		self._upload_busy = false
	}

}//end upload_vector_file



/**
* CREATE_FEATURES_FROM_GEOJSON
* One `pm:create` per layer: an upload routinely holds many objects. Fits the WHOLE
* collection's bounds rather than v6's "last one processed".
*
* @param {Object} self - tool_uca_maps instance
* @param {Object} geojson - a GeoJSON FeatureCollection, or null/undefined
* @returns {number} how many features were created
*/
const create_features_from_geojson = function(self, geojson) {

	if (!geojson || !Array.isArray(geojson.features) || geojson.features.length===0) {
		return 0
	}

	const layers = L.geoJSON(geojson).getLayers()

	const bounds = L.latLngBounds([])
	layers.forEach((layer) => {
		self.geolocation.map.fire('pm:create', {layer})
		if (typeof layer.getBounds==='function') {
			bounds.extend(layer.getBounds())
		} else if (typeof layer.getLatLng==='function') {
			bounds.extend(layer.getLatLng())
		}
	})

	if (bounds.isValid()) {
		self.geolocation.map.fitBounds(bounds)
	}

	return layers.length
}//end create_features_from_geojson



/**
* DETACH_FILE_UPLOAD
* No map listener or overlay to reverse: the button, the panel and any pending
* message timer.
*
* @param {Object} self - tool_uca_maps instance
* @returns {void}
*/
export const detach_file_upload = function(self) {

	clear_upload_messages(self.upload_panel)
	remove_toolbar_button(self, self.upload_control)
	remove_toolbar_panel(self, self.upload_panel)

	self.upload_control	= null
	self.upload_panel		= null
	self._upload_busy		= false

}//end detach_file_upload



// @license-end
