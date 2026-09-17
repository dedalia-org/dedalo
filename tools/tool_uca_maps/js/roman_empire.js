// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global L */
/*eslint no-undef: "error"*/



/**
* ROMAN_EMPIRE
* Hito 18, fila #14 del audit ("Imperio Romano"): search the Roman world's
* gazetteers and bring a place onto the map as a real object.
*
* ONE BUTTON, ONE PANEL, THREE SOURCES (Sergio, 2026-09-16): the row of the
* audit is one functionality — "find an ancient place and draw it" — served by
* three gazetteers, so the panel carries a source selector, not three stacked
* sections (which is what the toolbar law of hito 3c forbids).
*
* The three keep their REAL names, which closes audit correction #2: v6 titles
* one panel "Pelagios D.A.R.E" although it only searches Pelagios, while the
* actual DARE query (`imperium.ahlfeldt.se`) is a separate panel.
*
* TWO DELIBERATE DEVIATIONS FROM v6, both in `docs/hitos/hito_18.md`:
*  1. **Always available.** v6 only instantiates this control when the record's
*     `section_tipo` contains `numisdata` (`render_tool_leaflet_special_tools.js:2022`)
*     — an install's own TLD, which this port may not name at all. It is one
*     more button, like the other twelve.
*  2. **Pleiades and Pelagios are capability-gated, not assumed.** Their data
*     is not vendored into the repo (20 MB of a third party's datasets); an
*     install points `gazetteer_data_path` at a directory it owns and
*     `get_capabilities` reports what is there, exactly like GDAL. DARE needs
*     no local data and is therefore always offered.
*
* Session-scoped like every other search here: hits live in
* `self._roman_results` and die with the map.
*
* @module roman_empire
*/



import {response_data, request_failed} from '../../../core/common/js/api_error.js'
import {error_text} from '../../../core/common/js/render_api_error.js'
import {
	create_toolbar_button,
	create_toolbar_panel,
	is_toolbar_panel_visible,
	register_toolbar_node,
	remove_toolbar_button,
	remove_toolbar_panel,
	set_toolbar_panel_visible
} from './toolbar.js'
import {report_client_error} from './object_console.js'
import {render_roman_empire_panel, refresh_roman_sources} from './render_roman_empire.js'



/** The three sources, in the panel's own order. */
export const ROMAN_SOURCES = ['pleiades', 'pelagios', 'dare']

/** Server action behind each source's search. */
const SEARCH_ACTION = {
	pleiades	: 'search_pleiades',
	pelagios	: 'search_pelagios',
	dare		: 'search_dare'
}

/** Zoom used when the hit is a single point and has no extent to fit. */
const POINT_ZOOM = 14



/**
* ROMAN_MIN_QUERY
* The shortest query each source accepts — the SAME minimums the server
* refuses below (`server/roman_empire.ts`, v6's own `strlen` checks). The
* as-you-type search reads this so a half-typed word never travels, and the
* user never reads "at least N characters" as if it were a failure.
*
* @param {string} source - one of ROMAN_SOURCES
* @param {string} [type] - Pleiades only: 'name' or 'id'
* @returns {number}
*/
export const roman_min_query = function(source, type) {
	if (source==='pleiades') {
		return type==='id' ? 1 : 3
	}
	return source==='pelagios' ? 2 : 3
}//end roman_min_query



/**
* ATTACH_ROMAN_EMPIRE
* Builds the "Roma" button+panel (toolbar.js pattern). Idempotent.
*
* @param {Object} self - tool_uca_maps instance
* @returns {void}
*/
export const attach_roman_empire = function(self) {

	if (self.roman_control || !self.geolocation || !self.geolocation.map) {
		return
	}

	self._roman_results			= null
	self._roman_source			= ROMAN_SOURCES[0]
	self._roman_gazetteers		= null
	self._roman_search_token	= 0
	self._roman_search_timer	= null
	self._roman_active_index	= -1

	self.roman_control = create_toolbar_button(self, {
		title		: self.get_tool_label('roman_control_title') || 'Roman Empire',
		text		: self.get_tool_label('roman_control_text') || 'Roma',
		class_name	: 'uca-maps-roman-control',
		on_click	: () => toggle_roman_panel(self)
	})

	// on_hide: a SIBLING panel forcing this one shut must take the floating
	// suggestion list with it — it lives OUTSIDE the panel (see below)
	self.roman_panel = create_toolbar_panel(self, {
		class_name	: 'uca-maps-roman-panel',
		on_hide		: () => close_roman_suggestions(self)
	})

	// THE SUGGESTION LIST HANGS FROM THE MAP, NOT FROM THE PANEL. Every panel
	// of this tool shares `.uca-maps-panel`'s `max-height: 70%; overflow-y:
	// auto`, so a dropdown absolutely positioned inside it would be clipped at
	// the panel's edge and scroll away with the content — and that CSS is
	// common to the other twelve functionalities, not this hito's to change.
	// Anchored to the input on every open, same approach (and same accepted
	// resize gap) as toolbar.js's own anchor_panel_to_button.
	self.roman_dropdown			= document.createElement('ul')
	self.roman_dropdown.className	= 'uca-maps-roman-dropdown'
	self.roman_dropdown.hidden		= true
	L.DomEvent.disableClickPropagation(self.roman_dropdown)
	L.DomEvent.disableScrollPropagation(self.roman_dropdown)
	self.geolocation.map.getContainer().appendChild(self.roman_dropdown)
	register_toolbar_node(self, self.roman_dropdown)

	render_roman_empire_panel(self, self.roman_panel)

	// which of the two LOCAL sources this install can actually serve — asked
	// once, applied to the panel when it answers (the panel renders usable
	// meanwhile: DARE never depends on local data)
	load_roman_capabilities(self)

}//end attach_roman_empire



/**
* TOGGLE_ROMAN_PANEL
* Same "read the DOM, never a cached flag" law as every other panel here.
*
* @param {Object} self - tool_uca_maps instance
* @returns {void}
*/
const toggle_roman_panel = function(self) {

	const next_visible = !is_toolbar_panel_visible(self.roman_panel)

	set_toolbar_panel_visible(self, self.roman_panel, self.roman_control, next_visible)

	if (!next_visible) {
		close_roman_suggestions(self)
	}

	if (next_visible) {
		const input = self.roman_panel.querySelector('.uca-maps-roman-input')
		if (input) {
			input.focus()
		}
	}

}//end toggle_roman_panel



/**
* CLOSE_ROMAN_SUGGESTIONS
* Hides the floating list and forgets which row was keyboard-active. The ONE
* place that closes it, so every path (Esc, choosing, clicking outside, the
* panel closing, teardown) leaves the same state behind.
*
* @param {Object} self - tool_uca_maps instance
* @returns {void}
*/
export const close_roman_suggestions = function(self) {
	if (self.roman_dropdown) {
		self.roman_dropdown.hidden = true
	}
	self._roman_active_index = -1
}//end close_roman_suggestions



/**
* LOAD_ROMAN_CAPABILITIES
* Reads the gazetteer half of `get_capabilities` and hands it to the panel.
* A failure here is NOT fatal: the two local sources stay offered and say so
* when a search comes back unavailable — worse would be hiding a source
* because one capabilities call happened to fail.
*
* @param {Object} self - tool_uca_maps instance
* @returns {Promise<Object|null>} the gazetteer capability, or null
*/
export const load_roman_capabilities = async function(self) {

	try {

		const response = await self.get_capabilities()

		// torn down while the request was in flight
		if (!self.roman_panel) {
			return null
		}
		if (request_failed(response)) {
			return null
		}

		const data = response_data(response)
		self._roman_gazetteers = (data && data.gazetteers) || null
		refresh_roman_sources(self, self.roman_panel)

		return self._roman_gazetteers

	} catch (error) {
		console.error('tool_uca_maps: gazetteer capabilities lookup failed', error)
		return null
	}
}//end load_roman_capabilities



/**
* SET_ROMAN_SOURCE
* @param {Object} self - tool_uca_maps instance
* @param {string} source - one of ROMAN_SOURCES
* @returns {void}
*/
export const set_roman_source = function(self, source) {

	if (!ROMAN_SOURCES.includes(source)) {
		return
	}
	self._roman_source	= source
	self._roman_results	= null
	close_roman_suggestions(self)

}//end set_roman_source



/**
* SEARCH_ROMAN
* Runs the active source's search and stores the hits for the panel to
* render. Returns a plain verdict, never throws at the DOM handler that
* called it (same contract as place_search.js search_places).
*
* @param {Object} self - tool_uca_maps instance
* @param {Object} params - the active source's own form values
* @returns {Promise<{ok: boolean, error?: string, results?: Array<Object>}>}
*/
export const search_roman = async function(self, params) {

	const source = self._roman_source
	const action = SEARCH_ACTION[source]
	if (!action || !self.geolocation) {
		return {ok: false}
	}

	const query = String((params && params.query) || '').trim()
	if (!query) {
		return {ok: false, error: self.get_tool_label('roman_error_empty') || 'Type something to search.'}
	}
	if (source==='pelagios' && (!params.datasets || params.datasets.length===0)) {
		return {ok: false, error: self.get_tool_label('roman_error_no_dataset') || 'Select at least one dataset.'}
	}

	// as-you-type means several searches can be in flight at once: only the
	// NEWEST may write the list, or a slow early keystroke overwrites the
	// results of the word the user actually finished typing
	const token = (self._roman_search_token || 0) + 1
	self._roman_search_token = token

	try {

		const options = {
			tipo			: self.geolocation.tipo,
			section_id		: self.geolocation.section_id,
			section_tipo	: self.geolocation.section_tipo
		}
		if (source==='pleiades') {
			options.type	= params.type==='id' ? 'id' : 'name'
			options.value	= query
		} else {
			options.query = query
		}
		if (source==='pelagios') {
			options.datasets = params.datasets
		}
		if (source==='dare') {
			options.name_type	= params.name_type==='ass' ? 'ass' : 'mss'
			options.type_id		= params.type_id || ''
			options.country		= params.country || ''
		}

		const response = await self.tool_request({action: action, options: options})

		// torn down (record deleted / navigated away) while in flight, or
		// overtaken by a later keystroke — neither may touch the panel
		if (!self.roman_panel || token!==self._roman_search_token) {
			return {ok: false}
		}

		if (request_failed(response)) {
			return {ok: false, error: error_text(response.error)}
		}

		const data		= response_data(response)
		const results	= (data && Array.isArray(data.results)) ? data.results : []

		self._roman_results = results

		return {ok: true, results: results}

	} catch (error) {
		console.error('tool_uca_maps: roman gazetteer search failed unexpectedly', error)
		report_client_error((error && error.message) || 'Gazetteer search failed')
		return {ok: false, error: self.get_tool_label('roman_error_failed') || 'The search could not be completed.'}
	}
}//end search_roman



/**
* ADD_ROMAN_RESULT
* Draws the hit at `index` on the map. A Pelagios/DARE hit already carries its
* GeoJSON feature; a Pleiades hit carries only an id, so its geometry is
* fetched first (`get_pleiades_place`).
*
* @param {Object} self - tool_uca_maps instance
* @param {number} index - position in `self._roman_results`
* @returns {Promise<{ok: boolean, error?: string, created?: number}>}
*/
export const add_roman_result = async function(self, index) {

	const result = self._roman_results && self._roman_results[index]
	if (!result || !self.geolocation || !self.geolocation.map) {
		return {ok: false}
	}

	try {

		if (result.feature) {
			// a feature whose geometry Leaflet cannot build is the same failure
			// as a Pleiades place with none — say so, never a silent "ok, 0"
			const created = create_roman_objects(self, result.feature)
			return created===0
				? {ok: false, error: self.get_tool_label('roman_error_no_geometry') || 'This result carries no geometry.'}
				: {ok: true, created: created}
		}

		if (!result.id) {
			return {ok: false, error: self.get_tool_label('roman_error_no_geometry') || 'This result carries no geometry.'}
		}

		const response = await self.tool_request({
			action	: 'get_pleiades_place',
			options	: {
				tipo			: self.geolocation.tipo,
				section_id		: self.geolocation.section_id,
				section_tipo	: self.geolocation.section_tipo,
				id				: result.id
			}
		})

		if (!self.roman_panel) {
			return {ok: false}
		}
		if (request_failed(response)) {
			return {ok: false, error: error_text(response.error)}
		}

		const data	= response_data(response)
		const place	= data && data.place
		if (!place) {
			return {ok: false, error: self.get_tool_label('roman_error_no_geometry') || 'This result carries no geometry.'}
		}

		const created = create_roman_objects(self, place)
		if (created===0) {
			return {ok: false, error: self.get_tool_label('roman_error_no_geometry') || 'This result carries no geometry.'}
		}

		return {ok: true, created: created}

	} catch (error) {
		console.error('tool_uca_maps: adding a gazetteer result failed unexpectedly', error)
		report_client_error((error && error.message) || 'Adding the place failed')
		return {ok: false, error: self.get_tool_label('roman_error_failed') || 'The search could not be completed.'}
	}
}//end add_roman_result



/**
* CREATE_ROMAN_OBJECTS
* Fires `pm:create` for every layer in `geojson` — the same door every other
* import in this tool uses (administrative_units.js, vector_upload.js), so the
* new objects are real geometry the record saves, not decoration. The map then
* moves to the LARGEST of them (v6's own tie-break, `special_tools_roman_empire.js`:
* it fits the biggest polygon rather than whichever came last).
*
* EXPORTED for the client gate: it takes a plain GeoJSON value, no request.
*
* @param {Object} self - tool_uca_maps instance
* @param {Object} geojson - a Feature or FeatureCollection
* @returns {number} how many layers were created
*/
export const create_roman_objects = function(self, geojson) {

	let layers = []
	try {
		layers = L.geoJSON(geojson).getLayers()
	} catch (error) {
		console.error('tool_uca_maps: unreadable gazetteer geometry', error)
		return 0
	}
	if (layers.length===0) {
		return 0
	}

	const map = self.geolocation.map

	let best_bounds	= null
	let best_area	= -1
	let point		= null

	for (const layer of layers) {
		map.fire('pm:create', {layer})

		if (typeof layer.getBounds==='function') {
			const bounds	= layer.getBounds()
			const area		= bounds_area(bounds)
			if (area > best_area) {
				best_area	= area
				best_bounds	= bounds
			}
		} else if (typeof layer.getLatLng==='function' && point===null) {
			point = layer.getLatLng()
		}
	}

	if (best_bounds) {
		map.fitBounds(best_bounds)
	} else if (point) {
		map.setView(point, POINT_ZOOM)
	}

	return layers.length
}//end create_roman_objects



/**
* BOUNDS_AREA
* Degree-square extent, used only to compare two bounds of the SAME result —
* never reported to the user, so no projection is needed (v6 calls turf.area
* for the same comparison).
*
* @param {Object} bounds - a Leaflet LatLngBounds
* @returns {number}
*/
const bounds_area = function(bounds) {
	return Math.abs(bounds.getEast()-bounds.getWest()) * Math.abs(bounds.getNorth()-bounds.getSouth())
}//end bounds_area



/**
* CLEAR_ROMAN_SEARCH
* @param {Object} self - tool_uca_maps instance
* @returns {void}
*/
export const clear_roman_search = function(self) {
	self._roman_results = null
}//end clear_roman_search



/**
* DETACH_ROMAN_EMPIRE
* Real teardown (CLAUDE.local.md "destrucción real").
*
* @param {Object} self - tool_uca_maps instance
* @returns {void}
*/
export const detach_roman_empire = function(self) {

	// a pending as-you-type search must not fire into a torn-down panel
	if (self._roman_search_timer) {
		clearTimeout(self._roman_search_timer)
		self._roman_search_timer = null
	}

	// the "click outside closes the list" listener lives on the MAP container,
	// which belongs to component_geolocation and outlives this tool
	if (self._roman_outside_handler && self.geolocation && self.geolocation.map) {
		self.geolocation.map.getContainer().removeEventListener('mousedown', self._roman_outside_handler)
	}
	self._roman_outside_handler = null

	// remove_toolbar_panel is "unregister from _toolbar_nodes + take out of the
	// DOM" — which is exactly what the dropdown needs too, panel or not
	remove_toolbar_panel(self, self.roman_dropdown)
	self.roman_dropdown = null

	remove_toolbar_panel(self, self.roman_panel)
	remove_toolbar_button(self, self.roman_control)

	self.roman_panel		= null
	self.roman_control		= null
	self._roman_results			= null
	self._roman_gazetteers		= null
	self._roman_search_token	= 0
	self._roman_active_index	= -1

}//end detach_roman_empire



// @license-end
