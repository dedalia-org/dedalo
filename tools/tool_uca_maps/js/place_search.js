// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global L */
/*eslint no-undef: "error"*/



/**
* PLACE_SEARCH
* Hito 15, functionality #1 ("Buscador de lugares"). Search a toponym, pick a
* hit, the map flies to it. v6 gets this from `leaflet-control-geocoder`
* dropped straight onto the map (`render_tool_leaflet_special_tools.js:328`).
*
* THREE DELIBERATE DEVIATIONS FROM v6, all in `docs/hitos/hito_15.md`:
*
*  1. **The library is not vendored; the search goes through this tool's own
*     server action** (`server/place_search.ts`). Forced, not preferred: the
*     app serves `connect-src 'self' blob:`, so ANY library calling Nominatim
*     from the page is blocked by CSP on every search. The proxy is the shape
*     the tool already uses for every third-party map service (wms.js,
*     catastro.js, administrative_units.js).
*  2. **A button + its own panel**, not a free-floating search box — the "one
*     button per functionality" law (CLAUDE.local.md, toolbar.js file header)
*     covers every row of the audit, this one included.
*  3. **It speaks the record's language.** v6's geocoder is the one control
*     whose text never passes through translation (audit gap #6): the panel's
*     own chrome comes from the tool's labels, and the RESULT names come back
*     in the record's own language (the server sends `Accept-Language`).
*
* Session-scoped, like WMS/XYZ: results live in `self._place_results` and die
* with the map. Nothing here writes to the record — the map moves, that is all
* (v6's `markgeocode` handler is `map.fitBounds(bbox)` and nothing else).
*
* @module place_search
*/



import {response_data, request_failed} from '../../../core/common/js/api_error.js'
import {error_text} from '../../../core/common/js/render_api_error.js'
import {
	create_toolbar_button,
	create_toolbar_panel,
	is_toolbar_panel_visible,
	remove_toolbar_button,
	remove_toolbar_panel,
	set_toolbar_panel_visible
} from './toolbar.js'
import {report_client_error} from './object_console.js'
import {render_place_search_panel} from './render_place_search.js'



/** Zoom used when a hit carries no bounding box (a single node, typically). */
const POINT_ZOOM = 16



/**
* ATTACH_PLACE_SEARCH
* Builds the "Search" button+panel (toolbar.js pattern). Idempotent.
*
* @param {Object} self - tool_uca_maps instance
* @returns {void}
*/
export const attach_place_search = function(self) {

	if (self.place_search_control || !self.geolocation || !self.geolocation.map) {
		return
	}

	self._place_results = null

	self.place_search_control = create_toolbar_button(self, {
		title		: self.get_tool_label('place_search_control_title') || 'Place search',
		text		: self.get_tool_label('place_search_control_text') || 'Search',
		class_name	: 'uca-maps-place-search-control',
		on_click	: () => toggle_place_search_panel(self)
	})

	self.place_search_panel = create_toolbar_panel(self, {class_name: 'uca-maps-place-search-panel'})
	render_place_search_panel(self, self.place_search_panel)

}//end attach_place_search



/**
* TOGGLE_PLACE_SEARCH_PANEL
* Same "read the DOM, never a cached flag" law as every other panel here
* (toolbar.js file header).
*
* @param {Object} self - tool_uca_maps instance
* @returns {void}
*/
const toggle_place_search_panel = function(self) {

	const next_visible = !is_toolbar_panel_visible(self.place_search_panel)

	set_toolbar_panel_visible(self, self.place_search_panel, self.place_search_control, next_visible)

	if (next_visible) {
		const input = self.place_search_panel.querySelector('.uca-maps-place-search-input')
		if (input) {
			input.focus()
		}
	}

}//end toggle_place_search_panel



/**
* SEARCH_PLACES
* Asks the server for the hits, stores them for the panel to render, and
* returns a plain `{ok, error?, results?}` verdict — never throws at the DOM
* handler that called it (same contract as wms_services.js search_wms_layers:
* a rejected promise there leaves the panel's Search button disabled forever).
*
* @param {Object} self - tool_uca_maps instance
* @param {string} raw_query
* @returns {Promise<{ok: boolean, error?: string, results?: Array<Object>}>}
*/
export const search_places = async function(self, raw_query) {

	const query = String(raw_query || '').trim()
	if (!query) {
		return {ok: false, error: self.get_tool_label('place_search_error_empty') || 'Type a place name to search.'}
	}
	// torn down between the click and this line — no map to move, and the
	// request would be built out of a null caller
	if (!self.geolocation) {
		return {ok: false}
	}

	try {

		const response = await self.tool_request({
			action	: 'search_places',
			options	: {
				tipo			: self.geolocation.tipo,
				section_id		: self.geolocation.section_id,
				section_tipo	: self.geolocation.section_tipo,
				query			: query,
				lang			: self.geolocation.section_lang
			}
		})

		// the tool may have been torn down (record deleted/navigated away)
		// while this request was in flight — writing results into a dead
		// instance would resurrect state nothing shows any more (the same
		// guard wms_services.js needs, for the same reason)
		if (!self.place_search_panel) {
			return {ok: false}
		}

		if (request_failed(response)) {
			return {ok: false, error: error_text(response.error)}
		}

		const data		= response_data(response)
		const results	= (data && Array.isArray(data.results)) ? data.results : []

		self._place_results = results

		return {ok: true, results: results}

	} catch (error) {
		console.error('tool_uca_maps: search_places failed unexpectedly', error)
		report_client_error((error && error.message) || 'Place search failed')
		return {ok: false, error: self.get_tool_label('place_search_error_failed') || 'The place search could not be completed.'}
	}
}//end search_places



/**
* FOCUS_PLACE_RESULT
* Moves the map to the hit at `index`. v6's whole `markgeocode` handler is
* `map.fitBounds(bbox)`; the `setView` half covers the hit that comes back
* with no bounding box at all, where v6 would silently do nothing.
*
* @param {Object} self - tool_uca_maps instance
* @param {number} index - position in `self._place_results`
* @returns {boolean} true when the map actually moved
*/
export const focus_place_result = function(self, index) {

	const result = self._place_results && self._place_results[index]
	if (!result || !self.geolocation || !self.geolocation.map) {
		return false
	}

	if (Array.isArray(result.bbox) && result.bbox.length===4) {
		const [south, west, north, east] = result.bbox
		self.geolocation.map.fitBounds(L.latLngBounds([south, west], [north, east]))
		return true
	}

	if (Array.isArray(result.point) && result.point.length===2) {
		self.geolocation.map.setView(L.latLng(result.point[0], result.point[1]), POINT_ZOOM)
		return true
	}

	return false
}//end focus_place_result



/**
* CLEAR_PLACE_SEARCH
* Drops the stored hits (the panel's "Clear" button).
*
* @param {Object} self - tool_uca_maps instance
* @returns {void}
*/
export const clear_place_search = function(self) {
	self._place_results = null
}//end clear_place_search



/**
* DETACH_PLACE_SEARCH
* Real teardown (CLAUDE.local.md "destrucción real") — called from
* tool_uca_maps.prototype.destroy().
*
* @param {Object} self - tool_uca_maps instance
* @returns {void}
*/
export const detach_place_search = function(self) {

	remove_toolbar_panel(self, self.place_search_panel)
	remove_toolbar_button(self, self.place_search_control)

	self.place_search_panel		= null
	self.place_search_control	= null
	self._place_results			= null

}//end detach_place_search



// @license-end
