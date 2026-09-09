// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global L */
/*eslint no-undef: "error"*/



/**
* VECTOR_UPLOAD
* Fila #11 del audit ("Upload file to map"), VECTOR HALF ONLY — hito 12. The
* raster/image-overlay half (v6's "Subir imagen") is a separate later hito
* (`docs/HITOS.md`); the button+panel this file builds is named at the ROW
* level (`upload_control`/`upload_panel`, `attach_file_upload`/
* `detach_file_upload`) precisely so that hito can extend the SAME panel
* instead of renaming anything.
*
* v6 (`special_tools_upload.js`) reads .zip/.geojson/.kml CLIENT-SIDE with a
* 500+ line vendored `L.Shapefile`/`L.KML` reader pair and a hardcoded
* 18-entry EPSG table (browser proj4js cannot resolve an arbitrary EPSG code
* without a network fetch). This port uploads the raw file with the engine's
* own generic transport (`service_upload.js`) and asks the SERVER to convert
* it to WGS84 GeoJSON with `ogr2ogr` (`server/vector_upload.ts` — GDAL/PROJ
* carries the full EPSG database, so any embedded CRS reprojects with no
* lookup table at all); the client only ever draws `L.geoJSON`, same pattern
* already proven for Catastro/UA (hito 11).
*/



import {upload} from '../../../core/services/service_upload/js/service_upload.js'
import {response_data, request_failed} from '../../../core/common/js/api_error.js'
import {error_text} from '../../../core/common/js/render_api_error.js'
import {
	create_toolbar_button,
	create_toolbar_panel,
	set_toolbar_panel_visible,
	is_toolbar_panel_visible,
	remove_toolbar_button,
	remove_toolbar_panel
} from './toolbar.js'
import {render_file_upload_panel} from './render_file_upload.js'
import {report_client_error} from './object_console.js'



const VECTOR_UPLOAD_EXTENSIONS	= ['zip', 'geojson', 'kml']
const VECTOR_UPLOAD_MAX_BYTES	= 10_000_000 // v6/server parity, see vector_upload.ts
const VECTOR_UPLOAD_KEY_DIR	= 'uca_maps_vector'



/**
* ATTACH_FILE_UPLOAD
* Builds the "Upload file to map" button+panel. No language/section-tipo
* gate (unlike Catastro/UA) — v6 has none for this row either. Idempotent.
*
* @param {Object} self - tool_uca_maps instance
* @returns {void}
*/
export const attach_file_upload = function(self) {

	if (self.upload_control || !self.geolocation || !self.geolocation.map) {
		return
	}

	self.upload_control = create_toolbar_button(self, {
		title		: self.get_tool_label('upload_control_title') || 'Upload file to map',
		text		: 'UP',
		class_name	: 'uca-maps-upload-control',
		on_click	: () => toggle_upload_panel(self)
	})

	self.upload_panel = create_toolbar_panel(self, {class_name: 'uca-maps-upload-panel'})
	render_file_upload_panel(self, self.upload_panel)

}//end attach_file_upload



/**
* TOGGLE_UPLOAD_PANEL
* Plain show/hide — unlike Catastro/UA, nothing is "armed" by opening this
* panel (no map click listener, no basemap swap): every upload is one
* explicit file-picker + button gesture, so there is no state to disarm on
* close beyond hiding the DOM (toolbar.js's own exclusivity already handles
* a sibling panel forcing this one shut).
*
* @param {Object} self - tool_uca_maps instance
* @returns {void}
*/
const toggle_upload_panel = function(self) {

	const next_visible = !is_toolbar_panel_visible(self.upload_panel)

	set_toolbar_panel_visible(self, self.upload_panel, self.upload_control, next_visible)

}//end toggle_upload_panel



/**
* UPLOAD_VECTOR_FILE
* Two-step flow: (1) `service_upload.js`'s generic transport stages the raw
* file, (2) `upload_vector_layer` (server) converts the staged file to WGS84
* GeoJSON. EXPORTED (takes plain `file`/`epsg` args, not a DOM event) so
* tests can await it directly — same testability convention as
* `wms_services.js`'s `search_wms_layers`.
*
* @param {Object} self - tool_uca_maps instance
* @param {File} file - the browser File object chosen by the user
* @param {string} epsg - optional EPSG code override (digits only, or '')
* @returns {Promise<{ok: boolean, error?: string, feature_count?: number}>}
*/
export const upload_vector_file = async function(self, file, epsg) {

	if (self._upload_busy) {
		return {ok: false}
	}
	if (!file) {
		return {ok: false, error: self.get_tool_label('upload_no_file') || 'Please choose a file first.'}
	}

	self._upload_busy = true

	try {

		const upload_response = await upload({
			id					: self.id,
			file				: file,
			key_dir				: VECTOR_UPLOAD_KEY_DIR,
			allowed_extensions	: VECTOR_UPLOAD_EXTENSIONS,
			max_size_bytes		: VECTOR_UPLOAD_MAX_BYTES,
			tipo				: self.geolocation.tipo
		})

		if (!response_data(upload_response)) {
			const message = upload_response && upload_response.error
				? error_text(upload_response.error)
				: (self.get_tool_label('upload_error_transport') || 'The file could not be uploaded.')
			return {ok: false, error: message}
		}

		const response = await self.tool_request({
			action	: 'upload_vector_layer',
			options	: {
				tipo			: self.geolocation.tipo,
				section_id		: self.geolocation.section_id,
				section_tipo	: self.geolocation.section_tipo,
				file_data		: upload_response.file_data,
				epsg			: String(epsg || '').trim()
			}
		})

		// the panel may have been closed / the tool torn down while this
		// request was in flight (same "DOM is truth, discard a late response"
		// law as check_administrative_unit_at_point, hito 11)
		if (!self.upload_panel) {
			return {ok: false}
		}

		if (request_failed(response)) {
			return {ok: false, error: error_text(response.error)}
		}

		const data = response_data(response)
		const feature_count = create_features_from_geojson(self, data && data.geojson)

		return {ok: true, feature_count}

	} catch (error) {
		console.error('tool_uca_maps: upload_vector_file failed unexpectedly', error)
		report_client_error((error && error.message) || 'Vector file upload failed')
		return {ok: false, error: self.get_tool_label('upload_error_transport') || 'The file could not be uploaded.'}
	} finally {
		self._upload_busy = false
	}

}//end upload_vector_file



/**
* CREATE_FEATURES_FROM_GEOJSON
* `L.geoJSON` builds one layer per feature and sets `.feature` on each
* (Leaflet's own `geometryToLayer`), same as `administrative_units.js`
* `create_administrative_unit_object` — fired once per layer here because a
* shapefile/KML upload routinely holds MANY objects, unlike a single
* Catastro/UA lookup. Fits the map to the WHOLE collection's combined
* bounds, simpler and more useful than v6's own per-type "fit to the last
* one processed" logic.
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
* Real teardown (CLAUDE.local.md) — no map listener/overlay to reverse
* (unlike Catastro/UA), just the button+panel themselves.
*
* @param {Object} self - tool_uca_maps instance
* @returns {void}
*/
export const detach_file_upload = function(self) {

	remove_toolbar_button(self, self.upload_control)
	remove_toolbar_panel(self, self.upload_panel)

	self.upload_control	= null
	self.upload_panel		= null
	self._upload_busy		= false

}//end detach_file_upload



// @license-end
