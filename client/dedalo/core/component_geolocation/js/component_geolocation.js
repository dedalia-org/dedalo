// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_label, page_globals, SHOW_DEBUG, DEDALO_CORE_URL, DEDALO_ROOT_WEB, L */
/*eslint no-undef: "error"*/



/**
* COMPONENT_GEOLOCATION
* Client-side controller for the geolocation component in Dédalo v7.
*
* Wraps a Leaflet map with one or more named FeatureGroups (layers). Each layer
* stores GeoJSON geometry (points, circles, polygons, polylines) that is
* serialised inside the component's `dato` under `entries[key].lib_data`.
*
* Key responsibilities:
* - Lazy-loading Leaflet and leaflet-geoman via `load_libs` (iro.js on first colour-picker open).
* - Creating the Leaflet map instance for every `data.entries` entry in `get_map`.
* - Keeping `current_value` in sync with the map view and geometry edits so the
*   save button always commits the most recent state.
*
* (!) THE MODEL — the view and the features are INDEPENDENT.
* An entry stores `{id?, lat, lon, zoom, alt?, lib_data?}`, and those are two
* separate things:
*   · `lat`/`lon`/`zoom` are THE VIEW — the map framing, and nothing else. The
*     view is NOT the position of a feature: an operator frames the space they
*     need to see, and with several points, or with context drawn around one,
*     the useful frame is often nowhere near any single feature. So they need
*     manual control of it.
*   · `lib_data` holds the FEATURES — the drawn geometry.
* Features do not determine the view and the view does not assert a feature.
* `alt` is real data some installs use and is never dropped.
*
* (!) HOW AN OPERATOR WORKS, and what the code must therefore allow.
* Panning and zooming changes the VIEW, freely, and the lat/lon/zoom INPUT
* FIELDS TRACK IT LIVE — that live readout is load-bearing: moving the map and
* reading the coordinates is how an operator approximates a position and how
* they sanity-check bad manual data. The `map_point` button in the map_inputs
* row then reads those inputs and CREATES A FEATURE. So a gesture changes the
* view, the button creates a feature; both are the operator acting and BOTH ARE
* SAVABLE. An earlier revision called pan/zoom "navigation, not data entry" and
* refused to write from it, which left the component unable to save the view on
* a record that had none ("Ignored geolocation save: the record has no value to
* send"). That refusal is deleted.
*
* What stops a FABRICATED value is not a restriction on gestures, it is these
* three, and they are the ones to keep:
*   1. the view NEVER seeds current_value at render — the original defect was
*      that merely opening a record gave it a value;
*   2. nothing auto-saves — a gesture only marks the component dirty, and only
*      an explicit click of the save button commits it;
*   3. `self.camera_is_moving` masks the component's OWN camera moves, so a
*      programmatic setView never feeds Leaflet's pixel-rounded centre back over
*      a value the user typed or an observer borrowed.
* Together: an untouched record still stores NOTHING — no gesture ran, so no
* entry was ever created, current_value stays absent and the save button sends
* nothing. 0 is a legal coordinate; there is no magic sentinel anywhere.
* - Bridging with linked `component_text_area` instances through `event_manager`
*   events: inserting/removing geo-tags triggers `load_tag_into_geo_editor` /
*   `handle_click_no_tag`, while geometry edits publish `updated_layer_data_<id_base>`.
* - Responding to external portal selections (`map_update_coordinates`) so that
*   clicking a toponymy record re-centres the map to its own coordinates.
*
* Data shape stored in `data.entries[key]`:
* ```json
* {
*   "lat"      : 41.652300,
*   "lon"      : -4.724500,
*   "zoom"     : 16,
*   "alt"      : 0,
*   "lib_data" : [
*     {
*       "layer_id"        : 1,
*       "layer_data"      : { "type": "FeatureCollection", "features": [...] },
*       "user_layer_name" : "layer_1"
*     }
*   ],
*   "sources"  : [ { "id": 4, "type": "xyz", "url": "…", "params": {}, "attribution": "…" } ],
*   "legend"   : { "title": "…", "groups": [ { "name": "…", "symbols": [ { "label": "…", "icon": "data:image/png;base64,…" } ] } ] }
* }
* ```
* `sources` and `legend` are OPTIONAL and server-owned in two ways: the server numbers
* the sources (`id`) and normalizes the legend, and a save REPLACES the entry. So the
* client must always send the whole entry it loaded — `get_entry_buffer` seeds the
* editable copy from the stored entry on every first touch, `map_update_coordinates`
* never borrows another record's definition, and `learn_saved_map_definition` takes
* the server's numbers back after a save (WC-2026-11-06-geolocation-map-sources-legend).
*
* Provider switch: controlled by `context.features.geo_provider` (OSM | GOOGLE |
* ARCGIS | NUMISDATA | VARIOUS). For OSM, dark mode keeps the standard OSM tiles
* and darkens them with a CSS filter on `.leaflet-layer` (see the dark mode block
* in component_geolocation.less); a MutationObserver on
* `document.documentElement[data-theme]` rebuilds the tile layer on theme changes.
*
* TILES COME FROM THE SERVER, NEVER FROM A PROVIDER. Every tile this component can
* proxy is requested from the same-origin tile proxy (`get_tile_url`): OpenStreetMap
* (the built-in `osm`), the sources stored in the entry (`sources`) and the ontology's
* default sources (`context.properties.map_sources`). The request names a source by
* id and never carries a URL: the server finds the source, checks the permission and
* builds the provider's address itself. That is why a canvas export of the map (DOM to
* image) is not tainted and the page's CSP admits no tile host for them. ArcGIS, the
* DARE atlas and Google are not proxied (the core relays only the providers whose
* terms allow it), so those provider branches still load directly.
*
* Main exports: `component_geolocation` constructor.
*/

// imports
	import {common} from '../../common/js/common.js'
	import {clone, get_json_langs, load_style, load_script} from '../../common/js/utils/index.js'
	import {component_common} from '../../component_common/js/component_common.js'
	import {escape_html} from '../../common/js/utils/render_escape.js'
	import {request_failed} from '../../common/js/api_error.js'
	import {event_manager} from '../../common/js/event_manager.js'
	import {render_edit_component_geolocation, render_popup_text, render_color_picker} from '../../component_geolocation/js/render_edit_component_geolocation.js'
	import {render_list_component_geolocation} from '../../component_geolocation/js/render_list_component_geolocation.js'



// TILE PROXY
// Every proxied tile is requested from `<DEDALO_CORE_URL>/api/v1/map_tile`, a same-origin,
// authenticated route that relays ONE tile of a source the request NAMES (a built-in id, a
// stored source id or an ontology default id) — see core/api/map_tile.ts on the server.
// Dark mode keeps the standard OSM tiles; the visual darkening is done purely with a CSS
// filter on `.leaflet-layer` (see the dark mode block in component_geolocation.less).

/** @type {string} The tile proxy's path under DEDALO_CORE_URL. */
const TILE_PROXY_PATH = '/api/v1/map_tile'

/**
* The attribution of the CORE'S built-in sources (code of this file, not data): the one
* place the page holds markup for Leaflet's attribution control. The attribution of a
* stored or default source is data and is plain text (the server refuses `<` and `>`).
* @type {Object<string, string>}
*/
const BUILTIN_ATTR = {
	osm				: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
	ign_admin_units	: 'CC BY 4.0 ign.es'
}

/** @type {number} Zoom ceiling of the engine (the server refuses a tile above it). */
const TILE_MAX_ZOOM = 22

/**
* ESCAPE_MARKUP
* Plain text made safe for Leaflet's HTML sinks (the layer control and the attribution
* control both write `innerHTML`), through the canonical `escape_html`. The text of a stored or
* default source is data: the server refuses `<` and `>` in it (save time for a stored source, read time for an
* ontology default), and this is the second hold — whatever a restored row, an old value
* or a hostile ontology update carries, the page never turns it into markup.
* @param {*} text
* @returns {string}
*/
const escape_markup = function(text) {

	return escape_html(String(text ?? ''))
}//end escape_markup

/**
* @type {Array<number>} How long (ms, before a little jitter) a refused tile waits before it
* is asked for again, once per entry. The proxy refuses a tile when the installation's
* queue or the person's share of the provider is used up (`rate.limited`, 429) or the
* provider is failing (503): an <img> cannot read the status or the Retry-After, and Leaflet
* never retries a failed tile on its own, so a busy moment would leave a blank patch until
* the viewer pans. Two bounded retries; a tile the provider does not have (404) is cached by
* the browser for a couple of minutes (the proxy says so in its Cache-Control), so asking again
* for it is answered from the browser's own cache and costs the server nothing.
* Kept on the prototype (`tile_retry_delays`) so a client test can shorten it.
*/
const TILE_RETRY_DELAYS_MS = [2000, 5000]

/**
 * @type {number} First zoom at which the server relays a tile of a WMS source whose CRS is
 * geographic (EPSG:4326, EPSG:4258). The service answers such a tile with a plate carrée crop,
 * which the map draws as a mercator tile: the two are within a pixel from zoom 8 and visibly
 * misregistered below it, so the server refuses those zooms and the layer does not ask for
 * them. Mirrors GEOGRAPHIC_TILE_MIN_ZOOM (src/core/geo/tile_proxy/tile_geometry.ts); a server
 * gate (map_tile_geometry_native) fails if the two differ.
 */
const GEOGRAPHIC_WMS_MIN_ZOOM = 8

/** @type {Array<string>} The CRSs of a WMS source that are geographic (see GEOGRAPHIC_WMS_MIN_ZOOM). */
const GEOGRAPHIC_CRS = ['EPSG:4326', 'EPSG:4258']

/**
 * @type {number} The stacking order of the OSM provider's base layer, which is NOT in the layer
 * control. Leaflet gives every tile layer z-index 1, and layers of an equal z-index stack in DOM
 * order: the one added LAST is on top. The layer control numbers the layers it holds 1, 2, 3 … in
 * the order they were added (`autoZIndex`, so their order survives switching them on and off), and
 * the sources are added to it, so the first source of an entry is numbered 1 — the base's own number.
 * That base is added again whenever the viewer toggles the theme, appended after the source in the
 * DOM, and covered it. Below every number the control hands out, the base can never be on top of
 * a source, however often it is re-added. (The VARIOUS and NUMISDATA bases are in the control, which
 * numbers them before any source: they need nothing.)
 */
const BASE_LAYER_Z_INDEX = 0

/**
* DEFAULT_VIEW_FALLBACK
* The hard camera fallback: the whole world. Used when the server emits no
* `context.features.default_view`. It is a VIEW, never a value, so it carries no
* `alt` (a camera has no altitude).
* (!) Operator-configurable through the ontology → `context.features.default_view`.
* @type {Object}
*/
const DEFAULT_VIEW_FALLBACK = {
	lat		: 20,
	lon		: 0,
	zoom	: 2
}

/**
* MAP_DEFINITION_KEYS
* The entry keys that describe the MAP (which tile services it is drawn over and what
* its symbols mean) rather than the VIEW or the FEATURES. They belong to the record
* that holds them: they are never borrowed from another record (map_update_coordinates),
* and their numbers are issued by the server (learn_saved_map_definition).
* @type {string[]}
*/
const MAP_DEFINITION_KEYS = ['sources', 'legend']

/**
* FN_FINITE_NUMBER
* The single "is this a coordinate?" predicate of the component.
*
* Absence is structural: null / undefined / '' mean NO coordinate and resolve to
* null. Everything else is coerced and kept only when finite, so 0 survives
* (Greenwich, the equator are legal coordinates) and a half-typed '-' does not.
*
* (!) Coordinates arrive as BOTH strings and numbers from the store (mixed in the
* same column) and always as strings from the DOM inputs — coercion here is the
* normal case, not a fallback.
*
* @param {*} value - Raw coordinate as stored or typed.
* @returns {number|null} The finite number, or null meaning "no coordinate".
*/
const fn_finite_number = function(value) {

	if (value===null || value===undefined || value==='') {
		return null
	}

	const number = Number(value)

	return Number.isFinite(number)
		? number
		: null
}//end fn_finite_number

/**
* FN_COLLECT_POSITIONS
* Flattens any GeoJSON `coordinates` member into a list of `[lon, lat]` pairs,
* whatever its nesting depth (Point, LineString, Polygon rings, Multi*).
* Positions whose lon/lat are not finite are dropped (coordinates arrive as
* strings too, see fn_finite_number).
*
* @param {*} coordinates - A GeoJSON coordinates member, or anything else.
* @param {Array} out - Accumulator, mutated.
* @returns {Array} `out`, holding `[lon, lat]` pairs.
*/
const fn_collect_positions = function(coordinates, out) {

	if (!Array.isArray(coordinates) || coordinates.length===0) {
		return out
	}

	// a position is a flat array of scalars: [lon, lat, (alt)]
	if (!Array.isArray(coordinates[0])) {
		const lon = fn_finite_number(coordinates[0])
		const lat = fn_finite_number(coordinates[1])
		if (lon!==null && lat!==null) {
			out.push([lon, lat])
		}
		return out
	}

	coordinates.forEach((item) => fn_collect_positions(item, out))

	return out
}//end fn_collect_positions

/**
* FN_GEOMETRY_POSITIONS
* Every drawn position of an entry, across ALL its lib_data layers, including
* the members of a GeometryCollection.
*
* @param {*} lib_data - The entry's `lib_data` array, or anything else.
* @returns {Array} `[lon, lat]` pairs; empty when nothing is drawn.
*/
const fn_geometry_positions = function(lib_data) {

	const out = []

	if (!Array.isArray(lib_data)) {
		return out
	}

	const fn_geometry = function(geometry) {
		if (!geometry || typeof geometry!=='object') {
			return
		}
		if (Array.isArray(geometry.geometries)) {
			geometry.geometries.forEach(fn_geometry)
			return
		}
		fn_collect_positions(geometry.coordinates, out)
	}

	lib_data.forEach((layer) => {
		const features = layer?.layer_data?.features
		if (!Array.isArray(features)) {
			return
		}
		features.forEach((feature) => fn_geometry(feature?.geometry))
	})

	return out
}//end fn_geometry_positions

/**
* FN_GEOMETRY_BOUNDS
* Bounding box of everything the operator drew in an entry, in Leaflet's
* `[[south, west], [north, east]]` shape.
*
* (!) This is CAMERA maths only: it tells the map where to look, and nothing
* computed here is ever stored. It mirrors the migration's server-side
* fitViewToGeometry rule (scripts/repair_geolocation_studio_default.ts) so a
* geometry record is framed the same way on both sides.
*
* @param {*} lib_data - The entry's `lib_data` array, or anything else.
* @returns {Array|null} `[[min_lat, min_lon], [max_lat, max_lon]]`, or null when
*   nothing usable is drawn.
*/
const fn_geometry_bounds = function(lib_data) {

	const positions = fn_geometry_positions(lib_data)
	if (positions.length===0) {
		return null
	}

	let min_lat = positions[0][1]
	let max_lat = positions[0][1]
	let min_lon = positions[0][0]
	let max_lon = positions[0][0]

	positions.forEach(([lon, lat]) => {
		if (lat < min_lat) min_lat = lat
		if (lat > max_lat) max_lat = lat
		if (lon < min_lon) min_lon = lon
		if (lon > max_lon) max_lon = lon
	})

	return [[min_lat, min_lon], [max_lat, max_lon]]
}//end fn_geometry_bounds

/**
* FN_BOUNDS_CENTRE
* Centre of a bounds pair. Rounded to 6 decimals (≈0.1 m, the precision the
* component stores) EXCEPT when the extent is degenerate on an axis — a single
* drawn point is returned verbatim, exactly as drawn, never re-rounded. Same
* rule as the migration's fitViewToGeometry.
*
* @param {Array} bounds - `[[min_lat, min_lon], [max_lat, max_lon]]`.
* @returns {Object} `{lat, lon}`.
*/
const fn_bounds_centre = function(bounds) {

	const [[min_lat, min_lon], [max_lat, max_lon]] = bounds

	const fn_axis = (min, max) => (min===max)
		? min
		: Math.round(((min + max) / 2) * 1e6) / 1e6

	return {
		lat	: fn_axis(min_lat, max_lat),
		lon	: fn_axis(min_lon, max_lon)
	}
}//end fn_bounds_centre

/**
* FN_TILE_QUERY
* Builds the query a tile request carries: the key=value pairs of the request's source
* (built-in id, stored source or default) with each value percent-encoded, followed by
* Leaflet's own `{z}`, `{x}`, `{y}` placeholders LITERALLY — Leaflet fills them per tile,
* and a URLSearchParams would have encoded the braces away.
* @param {Array<Array<string|number>>} pairs - [name, value] pairs.
* @returns {string}
*/
const fn_tile_query = (pairs) => {
	const query = pairs.map(([name, value]) => name + '=' + encodeURIComponent(value))
	query.push('z={z}', 'x={x}', 'y={y}')
	return query.join('&')
}

/**
* FN_CORE_URL
* The base of the core's URLs (`/dedalo/core`), from the page global when it exists.
* @returns {string}
*/
const fn_core_url = () => (typeof DEDALO_CORE_URL!=='undefined' ? DEDALO_CORE_URL : '/dedalo/core')



/**
* COMPONENT_GEOLOCATION
* Constructor for the geolocation component client instance.
*
* All properties below are declared here for discoverability; most are
* populated by `component_common.prototype.init` and `init` in this file.
* The render views (edit/list/search) add further runtime properties
* (e.g. `node.content_data`) to the instance.
*/
export const component_geolocation = function(){

	/** @type {string} Unique instance identifier assigned by common.init. */
	this.id

	// element properties declare
	/** @type {string} Component model name, always 'component_geolocation'. */
	this.model
	/** @type {string} Structure tipo of this component (e.g. 'hierarchy31'). */
	this.tipo
	/** @type {string} Section tipo that owns this component. */
	this.section_tipo
	/** @type {number|string} Record identifier of the current section. */
	this.section_id
	/** @type {string} Render mode: 'edit' | 'list' | 'search'. */
	this.mode
	/** @type {string} Active data language code (e.g. 'lg-spa'). */
	this.lang
	/** @type {string} Language code used by the parent section. */
	this.section_lang

	/** @type {Object} Server-side context object (permissions, features, etc.). */
	this.context
	/** @type {Object} Server-side data object; `data.entries` holds coordinate records. */
	this.data

	/** @type {Object} Parent component or section instance. */
	this.parent
	/** @type {HTMLElement} Root DOM node for this component. */
	this.node

	/** @type {Array} Tool instances attached to this component. */
	this.tools

	/** @type {boolean} Whether duplicate entries are allowed (always false here). */
	this.duplicates = false
	/** @type {Array} Tokens returned by event_manager.subscribe calls, used for cleanup. */
	this.events_tokens
}//end component_geolocation



/**
* COMMON FUNCTIONS
* Extend component_geolocation with shared prototype methods from common and
* component_common modules.
*
* destroy is overridden locally to disconnect the MutationObserver that swaps
* OSM tile layers on theme changes before delegating to the base destroyer.
*/
// prototypes assign
	component_geolocation.prototype.build				= component_common.prototype.build
	component_geolocation.prototype.render				= common.prototype.render
	component_geolocation.prototype.destroy				= async function(delete_self=true, delete_dependencies=false, remove_dom=false) {
		const self = this
		// theme_observer watches document.documentElement[data-theme] to swap OSM tiles;
		// it must be disconnected here to prevent the callback referencing a torn-down map.
		if (self.theme_observer) {
			self.theme_observer.disconnect()
			self.theme_observer = null
		}
		// disconnect resize observers (created per content_value render)
		if (Array.isArray(self.resize_observers)) {
			self.resize_observers.forEach(observer => observer.disconnect())
			self.resize_observers = []
		}
		// release the Leaflet map: it holds tile layers, DOM and many self.map.on(...)
		// handlers that close over self. Without this the whole instance graph leaks.
		if (self.map) {
			try {
				self.map.off()
				self.map.remove()
			} catch (e) {
				console.warn('component_geolocation destroy: error removing map', e)
			}
			self.map = null
			self.tile_layer = null
			self.source_layers = {}
			self.FeatureGroup = {}
		}
		return common.prototype.destroy.call(self, delete_self, delete_dependencies, remove_dom)
	}
	component_geolocation.prototype.refresh				= common.prototype.refresh
	// save — component_common's, then take the server's numbers back (see learn_saved_map_definition)
	component_geolocation.prototype.save				= async function(new_changed_data) {
		const self = this
		const api_response = await component_common.prototype.save.call(self, new_changed_data)
		// only a CONFIRMED save: a failed or degraded one leaves self.data on the previous model,
		// and learning from it would overwrite the unsaved edit it failed to store
		if (api_response && !request_failed(api_response) && self.data_degraded!==true) {
			self.learn_saved_map_definition(0)
			// the saved sources (and the numbers the server gave them) are what the tile proxy
			// serves: a map that is open shows them now, keeping which ones were switched on
			if (self.map) {
				self.build_source_layers(0)
			}
		}
		return api_response
	}
	component_geolocation.prototype.load_data			= component_common.prototype.load_data
	component_geolocation.prototype.get_value			= component_common.prototype.get_value
	component_geolocation.prototype.set_value			= component_common.prototype.set_value
	component_geolocation.prototype.update_data_value	= component_common.prototype.update_data_value
	component_geolocation.prototype.update_datum		= component_common.prototype.update_datum
	component_geolocation.prototype.change_value		= component_common.prototype.change_value
	component_geolocation.prototype.set_changed_data	= component_common.prototype.set_changed_data
	component_geolocation.prototype.build_rqo			= common.prototype.build_rqo

	// render
	component_geolocation.prototype.list				= render_list_component_geolocation.prototype.list
	// (!) tm mode reuses the list render — no separate time-machine view for geolocation.
	component_geolocation.prototype.edit				= render_edit_component_geolocation.prototype.edit
	// search renderer is lazy (CONVENTIONS S3-37 #3, rarely hit): edit/list never need it
	component_geolocation.prototype.search				= async function(options) {
		const {render_search_component_geolocation} = await import('../../component_geolocation/js/render_search_component_geolocation.js')
		return render_search_component_geolocation.prototype.search.call(this, options)
	}

	component_geolocation.prototype.change_mode			= component_common.prototype.change_mode



/**
* INIT
* Initialises the geolocation component instance after the base component_common
* init has run. Sets all Leaflet-specific state properties to their defaults and
* establishes the geographic fallback position.
*
* Leaflet libraries are NOT loaded here; they are loaded lazily by `get_map` via
* `load_libs` to avoid blocking the page when the map is not yet in view.
*
* Event observations (e.g. `click_tag_geo` → `load_tag_into_geo_editor`) are wired
* up through the ontology properties config rather than explicitly here; see the
* in-code example below for the expected properties shape.
*
* @param {Object} options - Standard init options passed through from component_common.
* @returns {Promise<boolean>} Resolves to the result of component_common.prototype.init.
*/
component_geolocation.prototype.init = async function(options) {

	const self = this

	// call the generic common tool init
		const common_init = await component_common.prototype.init.call(this, options);

	// Leaflet map state — all set to null/false/empty until get_map() creates the instance.
		self.ar_layer_loaded	= null  // Array<{layer_id, layer_data, user_layer_name}> cloned from data on get_map
		self.map				= null  // Leaflet Map instance
		self.tile_layer			= null  // active Leaflet TileLayer (OSM provider only)
		self.theme_observer		= null  // MutationObserver watching data-theme for dark mode tile swap
		self.layer_control		= false // Leaflet layer-control widget; false = not yet created
		self.source_layers		= {}    // proxied source layers by '<kind>:<id>' -> {layer, name}; see build_source_layers
		self.tile_retry_delays	= TILE_RETRY_DELAYS_MS // ms before each retry of a refused tile; see retry_refused_tiles
		self.camera_is_moving	= false // true while move_camera drives the map; see move_camera

	// temporary data_value: component_geolocation does not save the values when the inputs change their value.
	// We need a temporary value for all current values of the inputs (lat, lon, zoom, alt)
	// to will be used for save it when the user clicks on the save button
		this.current_value = []

	// draw editor vars
		self.drawControl				= null   // unused placeholder; kept for future leaflet-draw migration
		self.draw_editor_is_initated	= false  // guards against double init_draw_editor calls
		self.FeatureGroup				= {}     // plain object keyed by layer_id → Leaflet FeatureGroup
		self.active_layer_id			= 1      // layer_id that receives new geometry from the toolbar

	// Data buffer will store the changes send by text area when the tags are removed or inserted
	// if the user undo the remove tag in the editor, restore for the data_buffer the layer data
	// this var will not save in DB, if the user delete the tag and do not undo in the same session or close the window the buffer will erase
		self.ar_data_buffer = []  // sparse array indexed by layer_id; allows undo of geo-tag removal

	// default_view — the CAMERA: where the map OPENS when the record stores nothing.
	// (!) It is NOT a value and is never written to current_value or to the record.
	// It replaces the old `default_value`, whose only job was to fabricate a
	// coordinate for records that had none.
	// Source: context.features.default_view (operator-configurable per section/
	// component through the ontology), hard fallback = the world view.
	// No `alt`: altitude is data entered by the user, a camera has none.
		const context_default_view = self.context?.features?.default_view
		self.default_view = {
			lat		: fn_finite_number(context_default_view?.lat)  ?? DEFAULT_VIEW_FALLBACK.lat,
			lon		: fn_finite_number(context_default_view?.lon)  ?? DEFAULT_VIEW_FALLBACK.lon,
			zoom	: fn_finite_number(context_default_view?.zoom) ?? DEFAULT_VIEW_FALLBACK.zoom
		}

	// load dependencies js/css. Set the self specific libraries and variables not defined by the generic init
		// await self.load_libs()

	// event subscriptions
		// (!) Note that component properties could set observe events like (numisdata264, hierarchy31):
		// {
		//   "client": {
		//     "event": "click_tag_geo",
		//     "perform": {
		//       "function": "load_tag_into_geo_editor"
		//     }
		//   },
		//   "component_tipo": "numisdata19"
		// }


	return common_init
}//end init



/**
* MOVE_CAMERA
* The SINGLE door for every programmatic map move. Moving the camera is never
* data entry, so this method makes the map's own move feedback inert while it
* runs: `camera_is_moving` is raised, and the dragend/zoomend handlers installed
* by get_map return immediately when they see it.
*
* (!) ONE setView with animate:false, never panTo + setZoom. Three measured
* reasons, all of which produced fabricated values before:
*  a) a setZoom CANCELS an in-flight panTo animation, so the map never moved;
*  b) setZoom fires zoomend ASYNCHRONOUSLY (~250ms), so its handler ran after
*     the caller had already restored/written the value and overwrote it;
*  c) even when the move lands, Leaflet's getCenter() is the PIXEL-ROUNDED
*     centre of the container — writing it back replaces the exact typed
*     41.6523 with 41.65229…
* animate:false fires the map events synchronously, inside this call, so the
* flag below is enough to cover them; the try/finally lowers it even if Leaflet
* throws on a degenerate view.
*
* @param {number} lat  - Camera latitude (finite).
* @param {number} lon  - Camera longitude (finite).
* @param {number} zoom - Camera zoom level (finite).
* @returns {boolean} True when the map moved, false when there is no map yet.
*/
component_geolocation.prototype.move_camera = function(lat, lon, zoom) {

	const self = this

	if (!self.map) {
		return false
	}

	self.camera_is_moving = true
	try {
		self.map.setView([lat, lon], zoom, {animate:false})
	} finally {
		self.camera_is_moving = false
	}

	return true
}//end move_camera



/**
* GET_STORED_ENTRY
* Honest read of what the record actually stores for `key`. Returns the entry
* verbatim, or null when there is nothing stored — it NEVER invents one.
*
* (!) WC-001: the engine ALWAYS emits an array for data.entries — `[]` where the
* PHP oracle emitted `null`. The PHP-era truthiness idiom
* (`self.data.entries || [...]`) is therefore wrong: an empty array is truthy, so
* an unsaved record fell through to `entries[0].lat` and threw.
*
* This replaces the former `get_entries`, whose non-empty guarantee was itself the
* fabrication: callers could not tell a stored coordinate from an invented one.
*
* @param {number} key - Index into data.entries (always 0 today).
* @returns {Object|null} The stored entry, or null when absent.
*/
component_geolocation.prototype.get_stored_entry = function(key) {

	const entries = this.data?.entries

	if (!Array.isArray(entries)) {
		return null
	}

	const entry = entries[key]

	return (entry!==undefined && entry!==null)
		? entry
		: null
}//end get_stored_entry



/**
* GET_ENTRY_BUFFER
* The EDITABLE copy of the entry at `key` (`current_value[key]`), created on first
* touch. Every edit path goes through here — a pan or zoom (update_input_values), a
* typed coordinate (handle_coord_change), a drawing (update_draw_data), a geo-tag
* insert or remove (layer_data_change).
*
* (!) THE FIRST TOUCH SEEDS FROM THE STORED ENTRY, never from `{}` when the record
* stores one. A save REPLACES the entry (monovalue update, server side), so a buffer
* built from nothing silently deletes everything it did not carry: the other half of
* the view, the drawn layers, and the entry's `sources` and `legend`. get_map seeds the
* buffer too, but only after its libraries load and the map is built; an input typed
* before that, or a caller that never builds a map, would otherwise save a stripped
* value. A record that stores nothing still starts from `{}`: opening and editing are
* different things, and an untouched record has nothing to save.
*
* @param {number} key - Index into `current_value` (and `data.entries`).
* @returns {Object} The live buffer (mutable, owned by this instance).
*/
component_geolocation.prototype.get_entry_buffer = function(key) {

	const self = this

	if (self.current_value[key]===undefined || self.current_value[key]===null) {
		const stored_entry = self.get_stored_entry(key)
		self.current_value[key] = stored_entry
			? clone(stored_entry)
			: {}
	}

	return self.current_value[key]
}//end get_entry_buffer



/**
* LEARN_SAVED_MAP_DEFINITION
* After a CONFIRMED save, takes the server-owned map definition (`sources`, `legend`)
* of the stored entry back into the edit buffer. The stored entry is the save echo
* (component_common.save replaced `self.data` with it).
*
* Why: the server NUMBERS the sources it receives and normalizes the legend. The
* buffer was sent without those numbers, so without this the next save would send the
* sources id-less again — which the server recognises by content when they are
* unchanged, but renumbers when the editor changed them, breaking the one identity a
* tile request names (`{section_tipo, section_id, component_tipo, source_id}`). The
* view and the features are NOT touched: they are what the editor holds, and an edit
* made while the save was on the wire is not the echo's to overwrite.
*
* A buffer that does not exist is left alone (nothing was edited); an echo without the
* keys deletes them from the buffer (the save removed them).
*
* @param {number} key - Index into `current_value` (and `data.entries`).
* @returns {boolean} True when the buffer exists and was synchronised.
*/
component_geolocation.prototype.learn_saved_map_definition = function(key) {

	const self = this

	const buffer = self.current_value[key]
	if (buffer===undefined || buffer===null) {
		return false
	}

	const stored_entry = self.get_stored_entry(key)
	for (const name of MAP_DEFINITION_KEYS) {
		if (stored_entry && stored_entry[name]!==undefined) {
			buffer[name] = clone(stored_entry[name])
		} else {
			delete buffer[name]
		}
	}

	return true
}//end learn_saved_map_definition



/**
* GET_VIEW
* Resolves the CAMERA for `key`: where the map should open. This is a view, never
* a value — nothing returned here is ever stored.
*
* A stored entry supplies the camera when it carries usable coordinates (mixed
* string/number is the normal case, see fn_finite_number); otherwise the component
* opens on `default_view`. A stored entry without a usable lat/lon is absence for
* camera purposes, so it does NOT drag the map to (0,0).
*
* (!) GEOMETRY FRAMES ITSELF. An entry can hold drawn geometry and NO coordinate
* — that is the normal shape of a shape drawn without typing a coordinate, and of
* an imported geometry-only cell. Opening such a record on `default_view` put the
* operator's own drawing off-screen on the world map: it read as lost work. So the
* camera is derived from the bbox centre of the drawn geometry.
* get_view only COMPUTES a camera — it writes nothing itself, and
* fit_camera_to_geometry then fits the zoom to the same extent.
* (!) That derived camera is not sealed off from the record: the first user
* gesture syncs whatever the map is showing into the view and marks the
* component dirty, so a pan or a zoom here can commit the fitted framing.
* That is correct — the view IS lat/lon/zoom, and framing a record's own
* drawing is the operator's work — but it is why nothing may write the camera
* WITHOUT a gesture: see camera_is_moving.
*
* (!) zoom falls back per field: an entry can carry coordinates but no zoom.
*
* @param {number} key - Index into data.entries (always 0 today).
* @returns {Object} `{lat, lon, zoom}` — always finite numbers.
*/
component_geolocation.prototype.get_view = function(key) {

	const self = this

	const entry = self.get_stored_entry(key)
	if (!entry) {
		return self.default_view
	}

	const zoom = fn_finite_number(entry.zoom) ?? self.default_view.zoom

	const lat = fn_finite_number(entry.lat)
	const lon = fn_finite_number(entry.lon)
	if (lat===null || lon===null) {
		// no coordinate: frame the drawn geometry when there is any
		const bounds = fn_geometry_bounds(entry.lib_data)
		if (bounds) {
			const centre = fn_bounds_centre(bounds)
			return {
				lat		: centre.lat,
				lon		: centre.lon,
				zoom	: zoom
			}
		}
		return self.default_view
	}

	return {
		lat		: lat,
		lon		: lon,
		zoom	: zoom
	}
}//end get_view



/**
* GET_GEOMETRY_BOUNDS
* The extent of the geometry stored for `key`, in Leaflet's
* `[[south, west], [north, east]]` shape, or null when nothing is drawn.
* Read-only: this is camera input, never a value.
*
* @param {number} key - Index into data.entries (always 0 today).
* @returns {Array|null}
*/
component_geolocation.prototype.get_geometry_bounds = function(key) {

	const entry = this.get_stored_entry(key)

	return entry
		? fn_geometry_bounds(entry.lib_data)
		: null
}//end get_geometry_bounds



/**
* FIT_CAMERA_TO_GEOMETRY
* Fits the map to the extent of the STORED geometry of `key` — the zoom half of
* the geometry framing get_view starts (get_view can only supply a centre).
*
* Applied ONLY when the entry has no usable coordinate: a stored lat/lon on a
* geometry record IS the operator's chosen framing and must be obeyed as-is.
*
* (!) it goes through camera_is_moving, exactly like move_camera: fitBounds is
* the component's OWN move, not the operator's, so its dragend/zoomend feedback
* must not be read back as the view. Without the mask the derived frame would be
* written into current_value and the record would save a view nobody set.
*
* @param {number} key - Index into data.entries (always 0 today).
* @returns {boolean} True when the map was fitted.
*/
component_geolocation.prototype.fit_camera_to_geometry = function(key) {

	const self = this

	if (!self.map) {
		return false
	}

	const entry = self.get_stored_entry(key)
	if (!entry) {
		return false
	}
	if (fn_finite_number(entry.lat)!==null && fn_finite_number(entry.lon)!==null) {
		return false
	}

	const bounds = self.get_geometry_bounds(key)
	if (!bounds) {
		return false
	}

	self.camera_is_moving = true
	try {
		// maxZoom caps the degenerate case: a single drawn point has a zero-size
		// extent and Leaflet would otherwise slam to the maximum zoom level.
		self.map.fitBounds(bounds, {animate:false, padding:[20,20], maxZoom:16})
	} catch (error) {
		console.warn('component_geolocation fit_camera_to_geometry: error fitting bounds', error)
		return false
	} finally {
		self.camera_is_moving = false
	}

	return true
}//end fit_camera_to_geometry



/**
* LOAD_LIBS
* Lazy-loads all third-party scripts and stylesheets required by the map editor,
* in dependency order:
*  1. Leaflet CSS + JS  — must resolve before geoman attaches itself to L.
*  2. leaflet-geoman CSS + JS — drawing toolbar, geometry editing, and pm.* API.
*  3. json_langs — user-language lookup table used to set geoman's UI language.
*  4. turf.js — geometry calculations used by `get_popup_content` (area, distance).
*
* iro.js (colour picker) is NOT loaded here: render_color_picker loads it on first open.
*
* CSS files are injected without awaiting because they do not block JS execution.
* Leaflet is awaited before geoman (dependency); turf and json_langs load in parallel.
*
* (!) Leaflet exposes itself as the global `L` (listed in the `globals` pragma).
*     turf.js exposes `turf` (used in this file).
*
* @returns {Promise<boolean>} Resolves true when all scripts have loaded.
*/
component_geolocation.prototype.load_libs = async function () {

	const self = this

	const license = null
			// `
			// /**
			//  *
			//  * @source: http://www.lduros.net/some-javascript-source.js
			//  *
			//  * @licstart  The following is the entire license notice for the
			//  *  JavaScript code in this page.
			//  *
			//  * Copyright (C) 2014  Loic J. Duros
			//  *
			//  *
			//  * The JavaScript code in this page is free software: you can
			//  * redistribute it and/or modify it under the terms of the GNU
			//  * General Public License (GNU GPL) as published by the Free Software
			//  * Foundation, either version 3 of the License, or (at your option)
			//  * any later version.  The code is distributed WITHOUT ANY WARRANTY;
			//  * without even the implied warranty of MERCHANTABILITY or FITNESS
			//  * FOR A PARTICULAR PURPOSE.  See the GNU GPL for more details.
			//  *
			//  * As additional permission under GNU GPL version 3 section 7, you
			//  * may distribute non-source (e.g., minimized or compacted) forms of
			//  * that code without the copy of the GNU GPL normally required by
			//  * section 4, provided you include this license notice and a URL
			//  * through which recipients can access the Corresponding Source.
			//  *
			//  * @licend  The above is the entire license notice
			//  * for the JavaScript code in this page.
			//  *
			//  */
			//  `

	// JSON langs are independent of the scripts: fetch in parallel
		const json_langs_promise = self.json_langs
			? Promise.resolve(self.json_langs)
			: get_json_langs()

	// turf (popup area/distance) does not depend on leaflet: fetch in parallel
		const turf_promise = load_script(
			DEDALO_ROOT_WEB + '/lib/turf/turf.min.js',
			license
		)

	// leaflet. (!) It's necessary to be fully loaded before 'geoman'
		const leaflet_chain = (async () => {
			load_style(
				DEDALO_ROOT_WEB + '/lib/leaflet/dist/leaflet.css'
			)
			await load_script(
				DEDALO_ROOT_WEB + '/lib/leaflet/dist/leaflet.js',
				license
			)
			// geoman
			load_style(
				DEDALO_ROOT_WEB + '/lib/geoman/dist/leaflet-geoman.css'
			)
			await load_script(
				DEDALO_ROOT_WEB + '/lib/geoman/dist/leaflet-geoman.min.js',
				license
			)
		})()

	// awaited together so no branch's rejection is left unhandled
		const [json_langs] = await Promise.all([json_langs_promise, turf_promise, leaflet_chain])

	// set JSON langs file
		self.json_langs = json_langs


	return true
}//end load_libs



/**
* GET_TILE_URL
* The Leaflet URL template of the tile proxy for ONE source. It names the source and never
* carries an address: exactly one of
*   { builtin   : 'osm' }       a source of the core's closed registry
*   { source_id : 4 }           a source stored in THIS record's value (needs section_id)
*   { default_id: 'regional' }  an ontology default (`properties.map_sources`)
* plus the component's own section/component tipos, which are what the server checks the
* permission against. `{z}`, `{x}`, `{y}` stay literal for Leaflet to fill; for a WMS source
* the SERVER turns the tile into the GetMap bbox, so the browser never computes one.
*
* Every tile this component proxies is requested through here — the one place the page
* forms a tile address.
*
* @param {Object} source - One of the three shapes above.
* @returns {string} A same-origin URL template.
*/
component_geolocation.prototype.get_tile_url = function(source) {

	const self = this

	const pairs = [
		['section_tipo',	self.section_tipo],
		['component_tipo',	self.tipo]
	]
	if (source.source_id!==undefined) {
		pairs.push(['section_id', self.section_id], ['source_id', source.source_id])
	} else if (source.default_id!==undefined) {
		pairs.push(['default_id', source.default_id])
	} else {
		pairs.push(['builtin', source.builtin])
	}

	return fn_core_url() + TILE_PROXY_PATH + '?' + fn_tile_query(pairs)
}//end get_tile_url



/**
* GET_BUILTIN_LAYER
* A Leaflet tile layer of one of the core's built-in sources, through the tile proxy.
* @param {string} id - Built-in id ('osm', 'ign_admin_units').
* @param {Object} [options] - Leaflet tileLayer options merged over the defaults.
* @returns {Object} Leaflet TileLayer.
*/
component_geolocation.prototype.get_builtin_layer = function(id, options={}) {

	const self = this

	return self.retry_refused_tiles(
		L.tileLayer(self.get_tile_url({builtin:id}), {
			attribution	: BUILTIN_ATTR[id] || '',
			maxZoom		: TILE_MAX_ZOOM,
			...options
		})
	)
}//end get_builtin_layer


/**
* RETRY_REFUSED_TILES
* Makes a tile layer ask again, a bounded number of times, for a tile that failed to load.
* The proxy answers `rate.limited` (429) when the installation's queue is full or the
* person's share of the provider is used up, and 503 when the provider fails: those are
* moments, not verdicts, and Leaflet does not retry on its own. The delays are
* `self.tile_retry_delays` (default TILE_RETRY_DELAYS_MS), with jitter so the tiles of a
* viewport do not all come back at the same instant. A tile that has left the page by then
* (the viewer panned, the layer was removed) is not asked for again.
* @param {Object} layer - Leaflet TileLayer.
* @returns {Object} The same layer.
*/
component_geolocation.prototype.retry_refused_tiles = function(layer) {

	const self = this

	layer.on('tileerror', (event) => {

		const tile = event.tile
		if (!tile || typeof tile.src!=='string' || tile.src==='') {
			return
		}

		const delays	= self.tile_retry_delays || TILE_RETRY_DELAYS_MS
		const attempts	= tile.dedalo_tile_retries || 0
		if (attempts>=delays.length) {
			return
		}
		tile.dedalo_tile_retries = attempts + 1

		const address = tile.src
		setTimeout(() => {
			if (tile.isConnected) {
				tile.src = address
			}
		}, delays[attempts] * (1 + Math.random() * 0.5))
	})

	return layer
}//end retry_refused_tiles



/**
* GET_OSM_LAYER
* The OpenStreetMap base layer, through the tile proxy. Called at map creation time and
* again each time the MutationObserver detects a theme change (the old layer is removed
* before calling this). Both themes use the same tiles: dark mode is a CSS filter.
* @param {Object} [options] - Extra Leaflet tileLayer options merged with defaults.
* @returns {Object} Leaflet TileLayer ready to be added to a map.
*/
component_geolocation.prototype.get_osm_layer = function(options={}) {

	const self = this

	return self.get_builtin_layer('osm', {maxZoom:19, ...options})
}//end get_osm_layer



/**
* GET_SOURCE_LAYER
* A Leaflet tile layer for a STORED source or an ontology DEFAULT, through the tile proxy. An
* xyz and a wms source are drawn the same way — as a tile layer over the proxy: the server
* builds the provider's address, and for a wms source computes each tile's bbox itself.
*
* The layer is tagged (`options.dedalo_source`) so the layer-control code that treats every
* overlay as a drawing layer (layers_loader 'full', the overlayadd handler) can tell it
* apart. The attribution is data: it is escaped here as well, because Leaflet's attribution
* control writes HTML.
*
* @param {Object} source
* @param {string} source.kind - 'stored' | 'default'
* @param {number|string} source.id - Source id (stored) or default name.
* @param {string} [source.type] - 'xyz' | 'wms'.
* @param {Object} [source.params] - min_zoom / max_zoom for xyz (tiles are asked for from min_zoom
*   up, and scaled up beyond max_zoom); crs for wms (a geographic CRS is only asked for from
*   GEOGRAPHIC_WMS_MIN_ZOOM up).
* @param {string} [source.attribution] - Plain text.
* @param {Object} [options] - Leaflet tileLayer options merged over the defaults.
* @returns {Object} Leaflet TileLayer.
*/
component_geolocation.prototype.get_source_layer = function(source, options={}) {

	const self = this

	const params = source.params || {}
	const url = source.kind==='default'
		? self.get_tile_url({default_id:source.id})
		: self.get_tile_url({source_id:source.id})

	// below the source's own first zoom the layer asks for NOTHING: not `minNativeZoom`, which
	// would make Leaflet load that zoom's tiles and scale them DOWN, so the tiles asked for
	// grow by 4 per zoom level of difference (a 1000x600 map at zoom 2 over a source that
	// starts at zoom 8 is 37,901 tiles, and a world view of one that starts at 12 is millions).
	// A WMS source in a geographic CRS is not relayed below GEOGRAPHIC_WMS_MIN_ZOOM either.
	// Above the source's last zoom, scaling UP (`maxNativeZoom`) is cheap: the same tiles, bigger.
		const geographic = source.type==='wms' && GEOGRAPHIC_CRS.includes(params.crs)
		const min_zoom = Math.max(
			Number.isInteger(params.min_zoom) ? params.min_zoom : 0,
			geographic ? GEOGRAPHIC_WMS_MIN_ZOOM : 0
		)

	return self.retry_refused_tiles(
		L.tileLayer(url, {
			attribution		: escape_markup(source.attribution),
			minZoom			: min_zoom,
			maxNativeZoom	: Number.isInteger(params.max_zoom) ? params.max_zoom : TILE_MAX_ZOOM,
			maxZoom			: TILE_MAX_ZOOM,
			dedalo_source	: true,
			...options
		})
	)
}//end get_source_layer



/**
* ENSURE_LAYER_CONTROL
* The Leaflet layer-control widget, created on first need. The NUMISDATA and VARIOUS providers
* build theirs with their base maps; every other path (drawing layers, source layers) gets
* one here, so `layer_control.addOverlay` can never meet `false`.
* @returns {Object} Leaflet Control.Layers.
*/
component_geolocation.prototype.ensure_layer_control = function() {

	const self = this

	if (self.layer_control===false) {
		self.layer_control = L.control.layers({}).addTo(self.map)
	}

	return self.layer_control
}//end ensure_layer_control



/**
* GET_DEFAULT_PARAMS
* The `params` of a layer descriptor for an ontology DEFAULT, from the flat keys the server
* sends in the picker entry (it never sends a `params` object: the layer list and the
* address stay on the server). Only the numbers and the CRS that decide which tiles are worth
* asking for.
* @param {Object} source - The picker entry.
* @returns {Object} {min_zoom?, max_zoom?, crs?}
*/
const get_default_params = function(source) {

	const params = {}
	if (Number.isInteger(source.min_zoom)) {
		params.min_zoom = source.min_zoom
	}
	if (Number.isInteger(source.max_zoom)) {
		params.max_zoom = source.max_zoom
	}
	if (typeof source.crs==='string') {
		params.crs = source.crs
	}

	return params
}//end get_default_params



/**
* GET_SOURCE_ENTRIES
* The sources the map can offer for `key`, as plain descriptors: the sources STORED in the
* entry (only the numbered ones — an unsaved source has no id the server could resolve) and
* the ontology's defaults (`context.properties.map_sources`, which the server sends as
* id/label/type plus what the page needs to DRAW the layer — the attribution, an xyz source's
* min_zoom/max_zoom and a wms source's crs — and never an address or a layer list).
* @param {number} key - Index into data.entries.
* @returns {Array<Object>} [{kind, id, type, params, attribution, name}]
*/
component_geolocation.prototype.get_source_entries = function(key) {

	const self = this

	const stored_entry	= self.get_stored_entry(key)
	const stored_list	= stored_entry && Array.isArray(stored_entry.sources) ? stored_entry.sources : []
	const defaults_list	= self.context && self.context.properties && Array.isArray(self.context.properties.map_sources)
		? self.context.properties.map_sources
		: []

	const entries = []
	for (const source of stored_list) {
		if (source && Number.isInteger(source.id) && source.id>0) {
			const attribution = typeof source.attribution==='string' ? source.attribution.trim() : ''
			entries.push({
				kind		: 'stored',
				id			: source.id,
				type		: source.type,
				params		: source.params || {},
				attribution	: attribution,
				name		: attribution!=='' ? attribution : '#' + source.id
			})
		}
	}
	for (const source of defaults_list) {
		if (source && typeof source.id==='string' && source.id!=='') {
			const attribution = typeof source.attribution==='string' ? source.attribution.trim() : ''
			entries.push({
				kind		: 'default',
				id			: source.id,
				type		: source.type,
				params		: get_default_params(source),
				attribution	: attribution,
				name		: typeof source.label==='string' && source.label!=='' ? source.label : source.id
			})
		}
	}

	return entries
}//end get_source_entries



/**
* BUILD_SOURCE_LAYERS
* Offers every source of the entry (stored and default) in the layer control as a switchable
* OVERLAY, through the tile proxy. None is switched on by itself: opening a map loads no
* tile from a source its editor did not ask to see. (An opaque source above the base map
* hides it until it is switched off — that is what the checkbox is for.)
*
* Idempotent: calling it again removes the layers it built and builds them anew from the
* current stored entry, keeping the ones the viewer had switched on (the same kind and id).
* Called by get_map, and after a confirmed save, which is when the server may have numbered
* new sources or removed old ones.
*
* @param {number} key - Index into data.entries.
* @returns {Array<string>} The keys ('<kind>:<id>') of the layers now offered.
*/
component_geolocation.prototype.build_source_layers = function(key) {

	const self = this

	if (!self.map) {
		return []
	}

	// forget the previous ones, remembering which were on the map
		const was_on = new Set()
		for (const [source_key, item] of Object.entries(self.source_layers)) {
			if (self.map.hasLayer(item.layer)) {
				was_on.add(source_key)
			}
			self.map.removeLayer(item.layer)
			if (self.layer_control) {
				self.layer_control.removeLayer(item.layer)
			}
		}
		self.source_layers = {}

	// offer the current ones
		const entries = self.get_source_entries(key)
		if (entries.length<1) {
			return []
		}
		const control = self.ensure_layer_control()
		for (const entry of entries) {
			const source_key = entry.kind + ':' + entry.id
			const layer = self.get_source_layer(entry)
			// the name is data (a default's label, a stored source's attribution) and Leaflet's layer
			// control writes it as HTML: escaped here, whatever the server let through
			control.addOverlay(layer, escape_markup(entry.name))
			self.source_layers[source_key] = {layer: layer, name: entry.name}
			if (was_on.has(source_key)) {
				layer.addTo(self.map)
			}
		}

	return Object.keys(self.source_layers)
}//end build_source_layers



/**
* GET_MAP
* Creates and fully initialises a Leaflet map inside `map_container` for the
* entry at index `key` within `data.entries`. This is the main entry point
* called by the edit view for each entry row.
*
* Sequence:
*  1. Lazily loads Leaflet and companion libraries via `load_libs`.
*  2. Resolves the CAMERA through `get_view(key)` — the stored coordinates when
*     the record has them, `default_view` otherwise. Resolving a camera stores
*     nothing by itself; only a user gesture writes the view (camera_is_moving
*     masks the component's own moves).
*  3. Clones the STORED entry (when there is one) into `current_value[key]` and
*     `ar_layer_loaded` so that subsequent edits do not mutate the server-received
*     data directly. With no stored entry both stay empty: opening a map is not
*     editing, so an untouched record must have nothing to save.
*  4. Constructs the Leaflet Map and tile layers according to
*     `context.features.geo_provider`. Provider-specific notes:
*     - OSM: single tile layer with automatic dark/light swap via MutationObserver.
*     - GOOGLE: uses the third-party `L.Google` plugin (must be loaded separately).
*     - ARCGIS: single satellite imagery tile layer.
*     - NUMISDATA: three base layers (dare, arcgis, osm) with a layer-selector control.
*     - VARIOUS: arcgis + osm base layers with a layer-selector control.
*  5. Attaches map-level event handlers (dragend, zoomend, click, overlayadd) that
*     keep `current_value[key]` and the coordinate input fields in sync.
*  6. On `whenReady`: initialises the geoman draw toolbar, sets the PM UI language
*     to match `page_globals.dedalo_data_lang`, and loads the first FeatureGroup.
*
* (!) Scroll-wheel zoom is intentionally disabled to avoid accidental zoom while
* scrolling the page. Enable it only if the map occupies the full viewport.
*
* @param {HTMLElement} map_container - The div that Leaflet will mount the map into.
* @param {number} key - Index into `data.entries` (and `current_value`) for this map.
* @returns {Promise<boolean>} Resolves true after map setup; does NOT wait for
*   `whenReady` to fire (that fires asynchronously after the DOM is painted).
*/
component_geolocation.prototype.get_map = async function(map_container, key) {

	const self = this

	// load libs
		await self.load_libs()

	// stored entry — null when the record has no geolocation value
		const stored_entry = self.get_stored_entry(key)

	// map_data — the CAMERA. Always finite (get_view guarantees it), so
	// new L.LatLng() can never receive undefined and throw (Invalid LatLng object).
		const map_data = self.get_view(key)

	// update the current_value with the data from DDBB
	// current_value will be update with different changes to create change_data to save
	// (!) ONLY when something is stored. Opening a map is not editing: on a record
	// with no value current_value[key] stays undefined so build_changed_data_item
	// returns null and the save button sends nothing. Every edit path creates the
	// entry on first touch (get_entry_buffer).
		if (stored_entry) {
			self.current_value[key] = clone(stored_entry)
		}

	// load all layers — deep-clone so that geometry edits don't mutate data.entries
		self.ar_layer_loaded = (stored_entry && typeof stored_entry.lib_data!=='undefined')
			? clone(stored_entry.lib_data)
			: []

	// new map vars
		let arcgis		= null
		let osm			= null
		let dare		= null
		let base_maps	= {}

	// Add layer to map — provider is configured per-section in context.features.geo_provider
	// (the server stamps it from properties.geo_provider ?? DEDALO_GEO_PROVIDER;
	// an absent features object falls to the default branch, not a crash)
		switch(self.context.features?.geo_provider) {

			case 'OSM':
				self.map = new L.Map(map_container, {center: new L.LatLng(map_data.lat, map_data.lon), zoom: map_data.zoom})
				self.tile_layer = self.get_osm_layer({zIndex:BASE_LAYER_Z_INDEX}).addTo(self.map)

				// swap tile layer when the user toggles dark/light mode — under every source (BASE_LAYER_Z_INDEX)
				self.theme_observer = new MutationObserver(() => {
					self.map.removeLayer(self.tile_layer)
					self.tile_layer = self.get_osm_layer({zIndex:BASE_LAYER_Z_INDEX}).addTo(self.map)
				})
				self.theme_observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
				break;

			case 'GOOGLE':
				self.map = new L.Map(map_container, {center: new L.LatLng(map_data.lat, map_data.lon), zoom: map_data.zoom});
				const googleLayer = new L.Google('ROADMAP');
				//map.addLayer(googleLayer);
				googleLayer.addTo(self.map);
				break;

			case 'ARCGIS':
				self.map = new L.Map(map_container, {center: new L.LatLng(map_data.lat, map_data.lon), zoom: map_data.zoom});
				L.tileLayer('https://server.arcgisonline.com/ArcGIS/' + 'rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
				maxZoom: 18,
				attribution: 'Tiles &copy; Esri — '
					+ 'Source: Esri, i-cubed, USDA, USGS, AEX, GeoEye, Getmapping, '
					+ 'Aerogrid, IGN, IGP, UPR-EGP, and the GIS User Community'}).addTo(self.map);
				break;

			case 'NUMISDATA':
				// LAYER
				// var dare = new L.TileLayer('http://dare.ht.lu.se/tiles/imperium/{z}/{x}/{y}.png');
				// dare = new L.tileLayer('http://pelagios.org/tilesets/imperium/{z}/{x}/{y}.png',{
				// 	maxZoom: 11
				// });
				// dare: Digital Atlas of the Roman Empire — ancient world tile overlay
				dare = new L.TileLayer('https://dh.gu.se/tiles/imperium/{z}/{x}/{y}.png',{
					maxZoom: 11
				});


				arcgis = new L.tileLayer('https://server.arcgisonline.com/ArcGIS/' + 'rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}');

				osm = self.get_osm_layer({ maxNativeZoom: 19 });

				// MAP
				self.map = new L.map(map_container, {layers: [osm], center: new L.LatLng(map_data.lat, map_data.lon), zoom: map_data.zoom});

				// LAYER SELECTOR — allows toggling among dare, arcgis, and osm base layers
				base_maps = {
					dare	: dare,
					arcgis	: arcgis,
					osm		: osm
				}
				if(self.layer_control===false) {
					self.layer_control = L.control.layers(base_maps).addTo(self.map);
				}
				break;

			case 'VARIOUS':
			default:
				// (!) 'VARIOUS' is also the DEFAULT branch: an absent or unknown
				// features.geo_provider must still build a map. Without it self.map
				// stays undefined and the next line throws — the same blank-map
				// symptom as an unhandled empty entries array.
				// LAYER
				arcgis = new L.tileLayer('https://server.arcgisonline.com/ArcGIS/' + 'rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}');
				osm = self.get_osm_layer();
				// MAP
				self.map = new L.map(map_container, {layers: [osm], center: new L.LatLng(map_data.lat, map_data.lon), zoom: map_data.zoom});

				// layer selector
				base_maps = {
					arcgis  : arcgis,
					osm 	: osm
				}
				if(self.layer_control===false) {
					self.layer_control = L.control.layers(base_maps).addTo(self.map);
				}
				break;
		}//end switch(self.context.features.geo_provider)

	// the sources of the entry (stored and ontology defaults), offered through the tile proxy
		self.build_source_layers(key)

	// geometry framing — a record whose value is a drawn shape and no coordinate
	// opens ON its work, not on the world view. get_view already centred the map;
	// this fits the zoom to the same extent. Camera only, nothing is stored, and
	// it runs before the map move listeners exist.
		self.fit_camera_to_geometry(key)

	// set active layer — when the user checks an overlay in the layer control, track it
		self.map.on('overlayadd', function(e) {
			// a tile SOURCE switched on is not a drawing layer: it must not become the active one
			if (e.layer && e.layer.options && e.layer.options.dedalo_source) {
				return
			}
			self.active_layer_id = e.name
		})
		// self.map.pm.setGlobalOptions({ measurements: { measurement: true, displayFormat: 'metric' } })

	// disable zoom handlers — prevents unintentional zoom during page scroll
		self.map.scrollWheelZoom.disable();
		// disable tap handler, if present.
		// if (self.map.tap) self.map.tap.disable();

	// map move listeners — a USER pan/zoom sets the VIEW. lat/lon/zoom are the
	// view, so the gesture writes them into current_value and into the input
	// fields, which track the map live: reading the coordinates while moving the
	// map is how an operator approximates a position. It marks the component
	// dirty and nothing more — only the save button commits.
	// The camera_is_moving guard skips the component's OWN moves (move_camera,
	// fit_camera_to_geometry): a programmatic setView must never feed its
	// rounded centre back over a typed or borrowed value.

		const fn_camera_sync = function(){
			if (self.camera_is_moving===true) {
				return
			}
			self.update_input_values(
				key,
				{
					lat		: self.map.getCenter().lat,
					lon		: self.map.getCenter().lng,
					zoom	: self.map.getZoom()
				},
				map_container
			)
		}

		self.map.on('dragend', fn_camera_sync);
		self.map.on('zoomend', fn_camera_sync);
		self.map.on('click', function(e){
			// disable layers — clicking the map canvas (not a feature) exits geometry edit mode
			for (let feature in self.FeatureGroup) {
				const feature_group = self.FeatureGroup[feature]
				feature_group.eachLayer(function (layer){
					layer.pm.disable()
				});
			}
		})

	// map ready event — fires once Leaflet has painted its first frame
		self.map.whenReady(async function(){
			// init map editor — attaches geoman toolbar and pm:create/pm:cut/pm:remove events
				self.init_draw_editor()

			// set the lang of the tool — map geoman UI matches the user's Dédalo data language
				const json_langs = self.json_langs || await get_json_langs() || []
				if (json_langs.length<1) {
					console.error('Error. Expected array of json_langs but empty result is obtained:', json_langs);
				}
				const dedalo_lang	= page_globals.dedalo_data_lang
				const lang_obj		= json_langs.find(item => item.dd_lang===dedalo_lang)
				const lang			= lang_obj
					? lang_obj.tld2  // two-letter ISO 639-1 code consumed by geoman setLang
					: 'en'
				self.map.pm.setLang(lang);

			// check if the map has any layer loaded, if not create new one
				const check_layer_loaded = self.FeatureGroup[self.active_layer_id]
				if(!check_layer_loaded){
					// load_layer — create the default FeatureGroup for active_layer_id when none exists
					self.layers_loader({
						load 		: 'layer',
						layer_id	: self.active_layer_id
					})
				}
		});

	return true
}//end get_map



/**
* UPDATE_INPUT_VALUES
* Writes a new VIEW (lat/lon/zoom, plus the alt read back from the DOM) into
* both the visible `<input>` fields and the in-memory `current_value[key]`
* buffer, and marks the component dirty.
*
* (!) SETTING THE VIEW IS THE OPERATOR ACTING, so every caller here writes.
* Three reach this method: a user pan/zoom (dragend/zoomend), the update_value
* observer borrowing a caller's coordinates, and the refresh button restoring
* the stored entry. lat/lon/zoom ARE the view — the map framing, independent of
* any drawn feature — and panning is how a view gets set, so all three may
* create the entry: `current_value[key]` is built on first touch below. The
* inputs track the map live because reading the coordinates while moving is how
* an operator approximates a position and checks bad manual data.
* An earlier revision took an `intent` parameter and refused anything but
* 'entry' on a record with no value; the result was a component that saved a
* drawn marker but never the view. Both the parameter and its guard are gone.
*
* The component's OWN camera moves are a different matter and never reach here:
* `move_camera` / `fit_camera_to_geometry` raise `camera_is_moving` and the map
* handlers return early, so a programmatic setView cannot write its pixel-rounded
* centre over the exact value a user typed or an observer borrowed.
*
* (!) It NEVER commits: no `set_changed_data`, no auto-save (see the disabled
* block at the end of the body). It updates the inputs, keeps the buffer in sync
* and sets the dirty flag; only an explicit click of the save button writes to
* the record. An untouched record therefore still stores NOTHING — no gesture
* ran, so no entry was ever created.
*
* The `alt` field is read back from the DOM rather than from `data` because
* altitude is entered manually by the user and not emitted by Leaflet map events.
*
* @param {number} key - Index into `current_value` identifying the active entry.
* @param {Object} data - New view values: `{lat, lon, zoom, [alt]}`.
* @param {HTMLElement} map_container - The map's root element; its `parentNode`
*   is expected to contain the `input[data-name=*]` coordinate fields.
* @returns {boolean} Always true.
*/
component_geolocation.prototype.update_input_values = function(key, data, map_container) {

	const self = this

	const content_value = map_container.parentNode

	// inputs — found by data-name attribute within the same content_value wrapper
		const input_lat		= content_value.querySelector("input[data-name='lat']")
		const input_lon		= content_value.querySelector("input[data-name='lon']")
		const input_zoom	= content_value.querySelector("input[data-name='zoom']")
		const input_alt		= content_value.querySelector("input[data-name='alt']")

	// Set values to inputs — guard for inputs not present in the current view.
	// (!) absence renders EMPTY: a geometry-only entry carries no lat/lon/zoom and
	// assigning undefined to a node value renders the literal string 'undefined'
	// in the VALUE fields, which add-point and handle_coord_change read back. 0
	// survives — it is a legal coordinate. The buffer below keeps the raw value,
	// so absence is never persisted as ''.
		const fn_node_value = (value) => (value===null || value===undefined)
			? ''
			: value
		if (input_lat) input_lat.value	= fn_node_value(data.lat)
		if (input_lon) input_lon.value	= fn_node_value(data.lon)
		if (input_zoom) input_zoom.value = fn_node_value(data.zoom)

	// get the value from alt input — altitude is not provided by Leaflet events; read from the DOM
		if (input_alt) {
			data.alt = input_alt.value
				? parseFloat(input_alt.value)
				: null
		}

	// set the current value — keep in-memory buffer in sync for the next save
	// (!) create on first touch: a record with no stored value has no
	// current_value[key] until the user acts. A pan or zoom IS the user acting,
	// so it creates the entry here — that is how the view of a record that had
	// none gets its first value.
		// (!) get_entry_buffer, not `|| {}`: the first touch seeds from the STORED
		// entry, so the view write cannot drop the layers, sources and legend.
		const entry_buffer = self.get_entry_buffer(key)
		entry_buffer.lat	= data.lat
		entry_buffer.lon	= data.lon
		entry_buffer.zoom	= data.zoom
		// use != null so a valid altitude of 0 is stored and an explicit null clears it
		// (the previous truthiness check silently dropped both 0 and null).
		entry_buffer.alt	= (data.alt != null) ? data.alt : null

	// mark dirty — the save button READS this flag (view_default_edit_geolocation
	// fn_save). Setting the view is real user work whether or not the record also
	// carries features, so it must be saveable.
	// (!) dirty is not saved: nothing here commits. Only an explicit click of the
	// save button writes the new view to the record.
	// (!) fn_refresh also routes through here and resets the flag to false right
	// after, so restoring the DB state does not leave the component dirty.
		self.is_data_changed = true

	// track changes in self.data.changed_data
		// (!) DISABLED because, when changing the position of the map, it is not saved unintentionally.
		// If you want to save, always use the save button.
		/*
		// changed_data
			const changed_data_item = Object.freeze({
				action	: 'update',
				key		: key,
				value	: self.current_value[key]
			})
		// fix instance changed_data
			self.set_changed_data(changed_data_item)
		*/

	return true
}//end update_input_values



/**
* BUILD_CHANGED_DATA_ITEM
* Creates a frozen changed_data_item for the given key, using the contents of
* `current_value[key]` as the value to be persisted. Centralises the
* `{action, id, value}` shape that `set_changed_data` and `change_value` expect,
* so that every caller (update_draw_data, layer_data_change, map_update_coordinates)
* produces a consistent payload.
*
* The item is frozen via `Object.freeze` to prevent accidental mutation before
* it reaches the server request.
*
* Returns NULL when `current_value[key]` does not exist: an untouched record has
* no value, and "no value" must be sent as nothing at all, not as a fabricated
* coordinate. Callers MUST handle null (see fn_save in the edit view).
*
* (!) `key` is mandatory in the emitted item. component_common's unchanged-guards
* (save + set_changed_data) resolve the DB twin as
* `db_data.entries.find(e => e.id===item.id)` when `id` is set and
* `db_data.entries[item.key]` otherwise. A new record has no id, so without `key`
* the lookup was `db_data.entries[undefined]` → always undefined → never equal →
* the guard never fired and every open+save wrote a row.
*
* (!) `id` IS THE REPLACE/APPEND SWITCH — it must be recovered from the STORED
* entry, not only from current_value. component_geolocation is not translatable,
* so the server takes the non-sliced branch of applyUpdate
* (src/core/section/record/save_component.ts): an id-less 'update' returns
* `[...items, change.value]` — an APPEND — and `key` is honoured only in the
* lang-sliced branch, so it cannot rescue it. The value CREATED by a first save
* does get a server-side id (save_component.ts stamps every id-less item with
* allocateComponentItemId before the write) and the save response replaces
* self.data, so `get_stored_entry(key).id` holds it afterwards — but
* current_value[key] is the client's own buffer and is never refreshed, so its
* id stayed null and the SECOND save appended a second item: the map reloaded at
* the stale first position and the record published two points.
* Reading the id back from the stored entry closes it, and stamping it into
* current_value keeps every later save (and component_common's id-keyed
* unchanged-guard) targeting the same item.
*
* @param {number} key - Index into `current_value` identifying the active entry.
* @returns {Object|null} Immutable changed_data_item `{action, key, id, value}`,
*   or null when there is no value to send.
*/
component_geolocation.prototype.build_changed_data_item = function(key) {

	const self = this

	const value = self.current_value[key]

	// absence is structural: nothing touched, nothing to save
	if (value===undefined || value===null) {
		return null
	}

	// id — the client's buffer first, the stored entry as the recovery source
	const stored_id = self.get_stored_entry(key)?.id
	const id = value.id ?? stored_id ?? null
	if (id!==null && (value.id===undefined || value.id===null)) {
		// stamp it so the NEXT save still replaces, and so the unchanged-guard
		// compares against the same shape the DB holds
		value.id = id
	}

	const changed_data_item = Object.freeze({
		action	: 'update',
		key		: key,
		id		: id,
		value	: value
	})

	return changed_data_item
}//end build_changed_data_item



/**
* HANDLE_COORD_CHANGE
* Unified handler for coordinate input changes (lat, lon, zoom, alt) fired when
* the user types directly into the lat/lon/zoom/alt input fields in the edit view.
*
* Updates `current_value[key][name]`, marks the component as dirty
* (`is_data_changed = true`), and immediately moves the Leaflet map to the new
* position. Map updates are guarded against NaN so that partial keyboard input
* (e.g. a leading minus sign) does not crash Leaflet's LatLng constructor.
*
* (!) altitude ('alt') changes do NOT update the map — Leaflet's 2-D map has no
* vertical dimension. The value is stored in current_value only, to be included
* in the next save payload.
*
* @param {number} key - Index into `current_value` for the active entry.
* @param {string} name - Field being changed: 'lat' | 'lon' | 'zoom' | 'alt'.
* @param {number|null} val - Parsed numeric value from the input field.
* @returns {boolean} Always true.
*/
component_geolocation.prototype.handle_coord_change = function(key, name, val) {

	const self = this

	// ensure current_value[key] exists — may not yet be set if map hasn't loaded;
	// seeded from the stored entry so the typed field cannot drop the rest of it
	self.get_entry_buffer(key)[name] = val

	// mark as changed
	self.is_data_changed = true

	// map updates — the camera follows what was typed; the typed value is the
	// record's, so it must survive the move untouched.
	// (!) fn_finite_number, NOT isNaN: isNaN(null) and isNaN('') are both FALSE,
	// so a half-filled form used to pan to (0,0) — the map jumping to the Gulf of
	// Guinea while the user was still typing the second coordinate.
	// (!) move_camera, never panTo + setZoom: typing a lat and then a zoom used to
	// cancel the pan AND let the async zoomend write the stale camera centre back
	// over both inputs. move_camera moves once, synchronously, with the map's
	// event feedback suppressed — see its header.
	if (self.map) {
		const lat	= fn_finite_number(self.current_value[key].lat)
		const lon	= fn_finite_number(self.current_value[key].lon)
		const zoom	= fn_finite_number(self.current_value[key].zoom)

		if (name === 'lat' || name === 'lon') {
			// both coordinates required: a lone lat is not a position
			if (lat!==null && lon!==null) {
				self.move_camera(lat, lon, zoom ?? self.map.getZoom())
			}
		} else if (name === 'zoom') {
			// zoom alone re-frames whatever the map is already looking at: keep
			// the typed coordinates when there are any, the current centre otherwise
			if (zoom!==null) {
				const centre = self.map.getCenter()
				self.move_camera(
					(lat!==null && lon!==null) ? lat : centre.lat,
					(lat!==null && lon!==null) ? lon : centre.lng,
					zoom
				)
			}
		}
	}

	if (SHOW_DEBUG === true) {
		console.log(`changed ${name} value to:`, val);
	}

	return true
}//end handle_coord_change



/**
* REFRESH_MAP
* Forces Leaflet to recalculate tile coverage and redraw after the map container
* has been resized (e.g. when a panel is expanded or a tab is shown).
*
* `invalidateSize` is the Leaflet-recommended approach; the older private API
* `_onResize` is left in a comment for historical reference but must not be used.
*
* @param {Object} map - A Leaflet Map instance.
* @returns {boolean} Always true.
*/
component_geolocation.prototype.refresh_map = function(map) {

	//map._onResize();
	map.invalidateSize(); // Force refresh map

	return true
}//end refresh_map



/**
* LAYERS_LOADER
* Dispatcher that either loads a single named layer or reloads every layer in
* `ar_layer_loaded`, depending on `options.load`.
*
* Modes:
* - 'layer': Load (or create) the FeatureGroup for `options.layer_id`. If the id
*   does not yet exist in `ar_layer_loaded`, a new empty layer entry is appended
*   and then passed to `load_layer`. This is used when a geo-tag is inserted into
*   a linked `component_text_area`.
* - 'full': Iterates all entries in `ar_layer_loaded` and calls `load_layer` on
*   each. After loading, activates all overlay checkboxes in the layer control by
*   programmatically clicking unchecked ones. Used when the geo-tag selection is
*   cleared (no tag focused).
*
* (!) 'full' mode accesses the private `_layers` and `_layerControlInputs` arrays
* on the Leaflet layer-control widget. These are undocumented Leaflet internals and
* may break on Leaflet upgrades.
*
* @param {Object} options - Dispatch options.
* @param {string} [options.load='full'] - 'layer' to load one layer, 'full' for all.
* @param {number|null} [options.layer_id=null] - Required when load is 'layer'.
* @returns {boolean} True on success; false if ar_layer_loaded is absent in 'layer' mode.
*/
component_geolocation.prototype.layers_loader = function(options) {

	const self = this

	// options
		const load		= options.load || 'full' // layer|full
		const layer_id	= options.layer_id || null // optional on full load

	// load_layer
		switch(load) {

			case ('full'):
				const ar_layer		=  self.ar_layer_loaded
				if (ar_layer && Array.isArray(ar_layer)) {
					const ar_layer_len	= ar_layer.length
					for (let i = 0; i < ar_layer_len; i++) {
						const layer = ar_layer[i]
						self.load_layer(layer)
					}
				}
				// active all layer in control — simulate checkbox clicks for unchecked overlays
				if (self.layer_control && self.layer_control._layers) {
					const control_layers_len = self.layer_control._layers.length
					for (let i = 0; i < control_layers_len; i++) {
						const layer = self.layer_control._layers[i]
						// (a tile SOURCE is an overlay too — switched on by the viewer only)
						if(layer.overlay && !(layer.layer && layer.layer.options && layer.layer.options.dedalo_source)){
							const input = self.layer_control._layerControlInputs[i]
							if(input && !input.checked){
								input.click()
							}
						}
					}
				}
				break;

			case ('layer'):
				if (!self.ar_layer_loaded) return false
				const loaded_layer = self.ar_layer_loaded.find((item) => item.layer_id === layer_id)
				// if the layer is not in the ar_layer_loaded, it will be new layer (ex:comes form new tag)
				// create new layer data with the new id and set to ar_layer_loaded
				const layer = typeof(loaded_layer)!=='undefined'
					? loaded_layer
					: (function(){
						const new_layer = {
							layer_id	: layer_id,
							layer_data	: []
						}
						self.ar_layer_loaded.push(new_layer)
						return new_layer
					  })()
				self.load_layer(layer)
				break;

			default:
				console.warn('Ignored invalid load mode:', load);
				break;
		}//end switch


	return true
}//end layers_loader



/**
* LOAD_LAYER
* Renders a single named layer (FeatureGroup) onto the Leaflet map. Called by
* `layers_loader` for both 'full' and 'layer' modes, and also directly from
* `layer_data_change` during tag insert/remove undo flows.
*
* Terminology:
* - A Dédalo *layer* (`{layer_id, layer_data, user_layer_name}`) maps 1-to-1 to a
*   Leaflet `FeatureGroup` stored in `self.FeatureGroup[layer_id]`.
* - A GeoJSON *feature* inside `layer_data.features` maps to a Leaflet geometry
*   (Marker, Circle, Polygon, Polyline).
*
* Behaviour when the FeatureGroup does NOT yet exist:
*  1. Creates a new `L.FeatureGroup` and registers it as the geoman layerGroup.
*  2. Adds it to the map and registers it in the layer control as an overlay.
*
* Behaviour when the FeatureGroup ALREADY exists (e.g. switching active tag):
*  1. Removes all currently visible FeatureGroups from the map.
*  2. Re-adds only the requested one and updates the geoman target.
*
* For each GeoJSON feature, `L.geoJson` is used with:
* - `pointToLayer`: converts circle-shaped points (stored as GeoJSON Point with
*   `properties.shape='circle'`) back to `L.Circle`; other points become `L.Marker`.
* - `onEachFeature`: delegates to `init_feature` to add click handlers, popups,
*   and colour styling.
*
* geoman events attached to the FeatureGroup:
* - `pm:update` / `pm:edit` — serialise geometry back to `ar_layer_loaded` and
*   refresh the popup.
* - `pm:markerdrag` — refreshes the popup with new coordinates during drag
*   (geometry data is NOT serialised until `pm:edit` fires on drag end).
*
* @param {Object} layer - Layer descriptor from `ar_layer_loaded`.
* @param {number} layer.layer_id - Numeric id used as the FeatureGroup key.
* @param {Object|Array|string} layer.layer_data - GeoJSON FeatureCollection, or
*   empty array/string indicating no existing geometry.
* @returns {boolean} Always true.
*/
component_geolocation.prototype.load_layer = function(layer) {

	const self = this

	// set the layer data
		const layer_id				= layer.layer_id
		const layer_data			= layer.layer_data
		// const layer_name			= 'layer_' +layer_id
		// const user_layer_name	= typeof(layer.user_layer_name)!=='undefined'
		// 	? layer.user_layer_name
		// 	: layer_name

	// FEATUREGROUP BUILD : Verify if exist FeatureGroup, else create it. map is global var
	// if( self.map.hasLayer(self.FeatureGroup[layer_id])===false ) {
		if( typeof self.FeatureGroup[layer_id] === 'undefined'){

			// the FeatureGroup is not loaded and does not exist into the map
			// Create a new FeatureGroup
			self.FeatureGroup[layer_id] = new L.FeatureGroup();
			self.map.pm.setGlobalOptions({layerGroup: self.FeatureGroup[layer_id]})


			// set the FeatureGroup to the map
			self.FeatureGroup[layer_id].addTo(self.map);
			// add to the layer control with checkbox and the name of the user
			self.ensure_layer_control().addOverlay(self.FeatureGroup[layer_id], layer_id);
		}else{
			// FeatureGroup exist and it's loaded
			// remove the checkbox for all FeatureGroup into the control panel (remove the visualization)
			for (let feature in self.FeatureGroup) {
				self.FeatureGroup[feature].remove()
			}

			// add to the layer control with checkbox and the name of the user
			self.FeatureGroup[layer_id].addTo(self.map);
			// self.FeatureGroup[layer_id].options.tag_id = layer_id
			self.map.pm.setGlobalOptions({layerGroup: self.FeatureGroup[layer_id]})
		}

	// LAYERS : Load GeoJSON features from stored layer_data into the FeatureGroup
		if (typeof layer_data!=='undefined' && layer_data!=='undefined' && layer_data!=='') {
			// remove previous data into the layer — prevents duplicate features on repeated calls
			self.FeatureGroup[layer_id].clearLayers();

			// update the feature data — fires when geoman finishes moving a vertex
			self.FeatureGroup[layer_id].on('pm:update', (e) => {
				self.update_draw_data(layer_id);
				// recalculate the popup
				const content = self.get_popup_content(e.layer, layer_id);
				if (content) {
					e.layer.bindPopup(content,{
						minWidth : 155
					});
				}
			});

			// finish the editing feature data — fires when leaving edit mode
			self.FeatureGroup[layer_id].on('pm:edit', (e) => {
				self.update_draw_data(layer_id);
				// recalculate the popup
				const content = self.get_popup_content(e.layer, layer_id);
				if (content) {
					e.layer.bindPopup(content,{
						minWidth : 155
					});
				}
			});

			// when the user drag a handler update the popup data
			// (!) update_draw_data is intentionally NOT called here — serialisation
			// happens on pm:edit (drag end) to avoid excessive writes during drag
			self.FeatureGroup[layer_id].on('pm:markerdrag', (e) => {
				// self.update_draw_data(layer_id);
				// recalculate the popup
				const content = self.get_popup_content(e.layer, layer_id);
				if (content) {
					e.layer.bindPopup(content,{
						minWidth : 155
					});
				}
			});

			self.FeatureGroup[layer_id].options.tag_id = layer_id
			self.map.pm.setGlobalOptions({layerGroup: self.FeatureGroup[layer_id]})

			L.geoJson( layer_data, {
				pointToLayer: (feature, latlng) => {
					// circles are stored as GeoJSON Point with shape='circle'; restore the radius
					if (feature.properties.shape==='circle') {
						return new L.Circle(latlng, feature.properties.radius);
					} else {
						return new L.Marker(latlng);
					}
				},
				// For each Feature load all layer data of the tag
				onEachFeature: function (feature, data_layer) {
					init_feature({
						self		: self,
						data_layer	: data_layer,
						layer_id	: layer_id,
						feature		: feature
					})
				}//end onEachFeature
			})//end L.geoJson
		}//end if (typeof layer_data!=="undefined" && layer_data!=="undefined" && layer_data!=="")

	// ACTIVE_LAYER_ID : Set the current active layer id will be editable with the actual FeatureGroup
		self.active_layer_id = layer_id;

	// enable Edit Mode
		// self.FeatureGroup[layer_id].pm.enable();

	return true
}//end load_geo_editor



/**
* LOAD_TAG_INTO_GEO_EDITOR
* Event handler invoked when the user clicks a geo-tag image inside a linked
* `component_text_area`. The tag carries the `tag_id` that identifies which
* FeatureGroup to activate in the map editor.
*
* (!) This method is wired up through the ontology `properties.observe` config
* (event: 'click_tag_geo', perform.function: 'load_tag_into_geo_editor') rather
* than a hard-coded event subscription.
*
* @param {Object} options - Event payload.
* @param {Object} options.caller - The `component_text_area` instance that fired the event.
* @param {Object} options.tag - Tag descriptor from the text editor.
* @param {string} options.tag.tag_id - Numeric string id of the geo-tag (parsed to int).
* @param {Object} options.text_editor - The CKEditor service instance managing the text.
* @returns {Promise<boolean>} Resolves true after the layer is loaded.
*/
component_geolocation.prototype.load_tag_into_geo_editor = async function(options) {

	const self = this

	// options
		const tag_obj = options.tag

	// layer_id
		const layer_id = parseInt(tag_obj.tag_id)

	// load_layer
		self.layers_loader({
			load		: 'layer',
			layer_id	: layer_id
		})

	return true
}//end load_tag_into_geo_editor



/**
* HANDLE_CLICK_NO_TAG
* Event handler invoked when the user clicks inside a linked `component_text_area`
* but NOT on a geo-tag image — i.e. a generic click with no tag target.
*
* Responds by loading all stored layers onto the map simultaneously ('full' mode),
* which gives the user a complete view of all geometry when no specific tag is focused.
*
* (!) Like `load_tag_into_geo_editor`, this is wired via ontology properties.observe
* rather than an explicit subscription. The event name on the text_area side is
* typically 'click_no_tag_geo'.
*
* @param {Object} options - Event payload.
* @param {Object} options.caller - The `component_text_area` instance that fired the event.
* @returns {Promise<boolean>} Resolves true after all layers are loaded.
*/
component_geolocation.prototype.handle_click_no_tag = async function(options) {

	const self = this

	// load_layer ('full' indicates load all layers)
		self.layers_loader({
			load		: 'full',
			layer_id	: null
		})

	return true
}//end handle_click_no_tag



/**
* GET_DATA_TAG
* Builds the `data_tag` descriptor that a linked `component_text_area` uses when
* inserting a new geo-tag into the rich-text editor. The tag references this
* component's current layers so the text-area can render the correct layer list
* in its tag dialogue.
*
* `last_layer_id + 1` pre-increments the next available id so the text_area can
* assign a unique id to the freshly inserted tag without querying the component.
*
* @returns {Object} data_tag descriptor:
*   `{type:'geo', tag_id:null, state:'n', label:'', data:'',
*     last_layer_id:<number>, layers:[{layer_id, user_layer_name}]}`
*/
component_geolocation.prototype.get_data_tag = function() {

	const self = this

	const lib_data 		= self.get_lib_data()
	const last_layer_id = self.get_last_layer_id()

	// layers — strip layer_data from the descriptor; text_area only needs identity fields
	const layers = lib_data.map((item) => {
		const layer = {
			layer_id		: item.layer_id,
			user_layer_name	: item.user_layer_name
		}
		return layer
	})

	const data_tag = {
		type			: 'geo',
		tag_id			: null,
		state			: 'n',
		label			: '',
		data			: '',
		last_layer_id	: last_layer_id+1,
		layers			: layers
	}

	return data_tag
}//end get_data_tag



/**
* GET_LIB_DATA
* Returns the `lib_data` array from the first data entry (`data.entries[0]`).
* `lib_data` is the Leaflet-specific geometry store: an array of layer descriptors,
* each with `{layer_id, layer_data (GeoJSON FeatureCollection), user_layer_name}`.
*
* Falls back to a single default layer (`layer_id:1`, empty geometry) when:
* - `data.entries` is absent or empty, or
* - `data.entries[0].lib_data` is not defined (component has no saved geometry).
*
* (!) Only entries[0] is read — the component currently supports a single
* coordinate entry per record. If multi-entry support is added later, this method
* will need to accept a `key` parameter.
*
* @returns {Array} Array of `{layer_id, layer_data, user_layer_name}` descriptors.
*/
component_geolocation.prototype.get_lib_data = function() {

	const self = this

	const lib_data = self.data.entries && typeof(self.data.entries[0])!=='undefined' && typeof(self.data.entries[0].lib_data)!=='undefined'
		? self.data.entries[0].lib_data
		: [{
				layer_id		: 1,
				layer_data		: [],
				user_layer_name	: 'layer_1'
		  }]


	return lib_data
}//end get_lib_data



/**
* GET_LAST_LAYER_ID
* Returns the highest numeric `layer_id` currently present in `lib_data`.
* Used by `get_data_tag` to compute the next available id (`last_layer_id + 1`)
* for a freshly inserted geo-tag.
*
* `Math.max(...ar_layer_id)` returns `-Infinity` when `ar_layer_id` is empty, but
* `get_lib_data` always returns at least one entry (`layer_id: 1`) so this is safe
* in practice.
*
* @returns {number} The maximum layer_id found in lib_data.
*/
component_geolocation.prototype.get_last_layer_id = function() {

	const self = this

	const lib_data		= self.get_lib_data()
	const ar_layer_id	= lib_data.map((item) => item.layer_id)
	const last_layer_id	= Math.max(...ar_layer_id)

	return last_layer_id
}//end get_last_layer_id



/**
* GET_POPUP_CONTENT
* Builds the DOM node displayed inside a Leaflet popup when the user clicks a
* geometry shape. Content varies by layer type:
* - `L.Marker` — returns a formatted lat/lng string directly (no colour picker).
* - `L.Circle` — centre lat/lng, radius, circumference area, and a colour picker.
* - `L.Polygon` (Rectangle included) — computed area via turf.js, and colour picker.
* - `L.Polyline` — total distance in metres via Leaflet's `distanceTo`, and colour picker.
*
* (!) `L.Polygon` is a subclass of `L.Polyline` in Leaflet, so the instanceof
* checks MUST test `L.Polygon` before `L.Polyline`.
*
* The `ar_mesures` array is assembled with `{label, messure?, separator?}` items
* and passed to `render_popup_text` which builds the HTML structure. The colour
* picker node is then appended to the text container.
*
* Returns null implicitly when the layer type is not recognised (none of the
* instanceof checks match), in which case callers should not call `bindPopup`.
*
* @param {Object} layer - A Leaflet layer instance (Marker, Circle, Polygon, or Polyline).
* @param {number} layer_id - The numeric id of the parent FeatureGroup.
* @returns {HTMLElement|string} DOM node for the popup, or a lat/lng string for Markers.
*/
component_geolocation.prototype.get_popup_content = function(layer, layer_id) {

	const self = this
	const ar_mesures = []
	// Marker - add lat/long
	if (layer instanceof L.Marker) {
		return this.str_lat_lng(layer.getLatLng());

	// Circle - lat/long, radius
	// (!) Check Circle before Polygon — L.Circle extends L.Path, not L.Polygon,
	// but it's listed first here for clarity. Order relative to Polygon is safe.
	} else if (layer instanceof L.Circle) {
		const center	= layer.getLatLng()
		const radius	= layer.getRadius()
		const area		= (2 * Math.PI * radius).toFixed(2);

		ar_mesures.push(
			{
				label: "Center: "+this.str_lat_lng(center)
			},{
				label: "Radius: "+this.round_coordinate(radius, 2),
				messure: 'm'
			},{
				label: "Area: "+ area,
				messure: 'm'
			},{
				label: "Color: ",
				separator: false
			}
		)

	// Rectangle/Polygon - area
	// (!) Must come before L.Polyline because L.Polygon extends L.Polyline
	} else if (layer instanceof L.Polygon) {

		// const latlngs	= layer._defaultShape ? layer._defaultShape() : layer.getLatLngs()
		const geojson		= layer.toGeoJSON()
		// turf.area computes geodesic area in square metres from a GeoJSON feature
		const area			= turf.area(geojson)

		ar_mesures.push(
			{
				label: "Area: "+readable_area(area, true)
			},{
				label: "Color: ",
				separator: false
			}
		)

	// Polyline - distance
	} else if (layer instanceof L.Polyline) {
		const latlngs = layer._defaultShape ? layer._defaultShape() : layer.getLatLngs()
		let	distance = 0;
		if (latlngs.length < 2) {
			ar_mesures.push(
				{
					label: "Distance: N/A"
				},{
					label: "Color: ",
					separator: false
				}
			)
		} else {
			// sum segment distances in metres using Leaflet's WGS84 distanceTo
			for (let i = 0; i < latlngs.length-1; i++) {
				distance += latlngs[i].distanceTo(latlngs[i+1]);
			}
			ar_mesures.push(
				{
					label: "Distance: "+this.round_coordinate(distance, 2),
					messure: 'm'
				},{
					label: "Color: ",
					separator: false
				}
			)
		}
	}

	const text_node		= render_popup_text(ar_mesures)
	const color_node	= render_color_picker(self, layer, layer_id)
	text_node.appendChild(color_node)


	return text_node
}//end get_popup_content



/**
* STR_LAT_LNG
* Formats a Leaflet `LatLng` object as a human-readable coordinate string of the
* form `(lat, lng)` with six decimal places of precision.
*
* Used by `get_popup_content` for Marker and Circle popups.
*
* @param {Object} latlng - Leaflet LatLng object with `lat` and `lng` properties.
* @returns {string} Formatted string, e.g. `'(41.652300, -4.724500)'`.
*/
component_geolocation.prototype.str_lat_lng = function(latlng) {

	const self = this

	const lat_lng = '(' + self.round_coordinate(latlng.lat, 6) + ', ' + self.round_coordinate(latlng.lng, 6) + ')'

	return lat_lng
}//end str_lat_lng



/**
* ROUND_COORDINATE
* Rounds a number to `len` decimal places using integer arithmetic to avoid
* floating-point representation issues with `toFixed`.
*
* Used by `str_lat_lng`, `get_popup_content` (radius, distance display).
*
* @param {number} num - The value to round.
* @param {number} len - Number of decimal places to keep.
* @returns {number} The rounded value (still a number, not a string).
*/
component_geolocation.prototype.round_coordinate = function(num, len) {

	return Math.round(num*(Math.pow(10, len)))/(Math.pow(10, len));
}//end round_coordinate



/**
* INIT_DRAW_EDITOR
* Attaches the leaflet-geoman (pm) drawing toolbar to the map and wires up the
* map-level pm events that serialise geometry changes back to `ar_layer_loaded`.
*
* Called once from inside the `map.whenReady` callback in `get_map`.
* `draw_editor_is_initated` is set to true after the first call; callers should
* check this flag if they need to guard against double-initialisation.
*
* Toolbar options:
* - `drawCircleMarker: false` — removed from the toolbar; full circles are still
*   supported via the 'draw circle' tool.
* - `drawText: false` — text annotations are not used in the geolocation component.
* - Measurements are enabled globally in metric format.
*
* Map-level pm events registered:
* - `pm:create` — fires when the user finishes drawing a new shape. Adds the new
*   Leaflet layer to the active FeatureGroup, serialises geometry, and runs
*   `init_feature` to attach click/popup handlers.
* - `pm:cut` — fires when the user cuts (clips) a shape. Removes the original
*   layer, serialises, and re-binds the popup on the resulting clipped layer.
* - `pm:remove` — fires when the user deletes a shape. Serialises geometry to
*   `ar_layer_loaded` without refreshing the popup (layer is gone).
*
* @see https://github.com/Leaflet/Leaflet.draw/issues/66 (legacy reference; now
*   using leaflet-geoman, not leaflet-draw)
* @returns {boolean} Always true.
*/
component_geolocation.prototype.init_draw_editor = function() {

	const self = this
	const map  = self.map

		// add Leaflet-Geoman controls with some options to the map
		map.pm.addControls({
			position: 'topright',
			drawCircleMarker: false,
			drawText: false
		});

		map.pm.setGlobalOptions({ measurements: { measurement: true, displayFormat: 'metric' } })
		// Listener on change the draw editor to "edited mode" for save the the current data of the editable_FeatureGroup
		// listen to when a layer is changed in Edit Mode
		map.on('pm:create', (e) => {
			// get layer active
			const layer = self.FeatureGroup[self.active_layer_id]
			// add the new feature to active layer
			e.layer.addTo(layer)
			// Update draw_data
			self.update_draw_data(self.active_layer_id);
			// init the feature — attach popup and click handlers to the newly created shape
			init_feature({
				self		: self,
				data_layer	: e.layer,
				layer_id	: self.active_layer_id
			})
		});

		// finish the editing feature data — pm:cut produces two layers: originalLayer (old) and layer (new clipped)
		map.on('pm:cut', (e) => {
			e.originalLayer.remove()
			e.originalLayer.removeFrom(map)
			self.update_draw_data(self.active_layer_id);
			// recalculate the popup
			const content = self.get_popup_content(e.layer, self.active_layer_id);
			if (content) {
				e.layer.bindPopup(content,{
					minWidth : 155
				});
			}//end if(content)
		});

		// Listener for delete the draw editor to "deleted mode" for save the current data of the editable_FeatureGroup
		map.on('pm:remove', () => {
			// Update draw_data — serialise the remaining geometry after removal
			self.update_draw_data(self.active_layer_id);
		});

	// DRAW_EDITOR_IS_INITATED : Set the a global variable to true (default is false) to avoid duplication
	self.draw_editor_is_initated = true;


	return true
}//end init_draw_editor



/**
* UPDATE_DRAW_DATA
* Serialises the current state of the Leaflet FeatureGroup for `layer_id` back
* into `ar_layer_loaded` and marks the component as dirty. This is the single
* point that reads live Leaflet layer state and writes it into the in-memory data
* model prior to saving.
*
* The save itself is NOT triggered here — that responsibility belongs to the save
* button handler in `render_edit_component_geolocation` / `view_default_edit_geolocation`.
*
* Serialisation logic:
* 1. Calls `FeatureGroup[layer_id].toGeoJSON()` to get a FeatureCollection skeleton.
* 2. Iterates each Leaflet layer via `eachLayer` to build augmented feature objects:
*    - Stamps `properties.layer_id` on every feature.
*    - Copies `options.color` into `properties.color` when a custom colour is set.
*    - For `L.Circle` layers, adds `properties.shape='circle'` and `properties.radius`
*      because GeoJSON does not natively represent circles (they are stored as Point).
* 3. Replaces the FeatureCollection's `features` array with the augmented list.
* 4. Resolves the active `key` from the map container's `dataset.key` attribute.
* 5. Publishes `updated_layer_data_<id_base>` via event_manager so that linked
*    `component_text_area` instances (e.g. hierarchy42 properties) can react.
* 6. Writes `ar_layer_loaded` into `current_value[key].lib_data` and calls
*    `set_changed_data` to enqueue the changed_data_item for the next save.
*
* @param {number} layer_id - Id of the FeatureGroup whose geometry has changed.
* @returns {boolean} True when the layer was serialised; false when there is
*                    nothing to serialise (map not built, or that layer is not
*                    loaded) — see the guard below.
*/
component_geolocation.prototype.update_draw_data = function(layer_id) {

	const self = this

	// NOTHING TO SERIALISE. `ar_layer_loaded` is null until get_map() builds the
	// map, and FeatureGroup[layer_id] only exists once load_layer rendered that
	// layer. The Leaflet handlers always run inside a built map, but create_point
	// does not: it is the programmatic entry point (the address search in
	// view_default_edit_geolocation, and direct calls from tests), so it can
	// arrive before either is true and the reads below would throw on null.
	// Nothing has been loaded, so there is no live geometry to write back — and
	// marking the component dirty here would enqueue a changed_data_item built
	// from data it never read.
		const active_layer = self.FeatureGroup[layer_id]
		if (!self.ar_layer_loaded || !active_layer) {
			return false
		}

	// current_layer. get the layer from the loaded data
		const current_layer = self.ar_layer_loaded.find((item) => item.layer_id===layer_id)
		if (!current_layer) {
			return false
		}

	// set the data_changed to true to control that the data was changed
		self.is_data_changed = true

	// layer_data. get the GeoJson of the active layer (from leaflet)
		current_layer.layer_data = active_layer.toGeoJSON()

		const features = []
		active_layer.eachLayer(function (layer){

			const json = layer.toGeoJSON();

			// add layer_id — stamp the feature so it can be reassigned to the correct layer on reload
			json.properties = json.properties
				? json.properties
				: {}
			json.properties.layer_id = layer_id
			const layer_color = layer.options.color

			if(layer_color){
				json.properties.color =  layer_color
			}

			// GeoJSON has no native circle type — persist shape + radius as properties
			// so pointToLayer in load_layer can reconstruct the L.Circle on next load
			if (layer instanceof L.Circle) {
				json.properties.shape	= 'circle';
				json.properties.radius	= layer.getRadius();
			}
			features.push(json)
		});
		current_layer.layer_data.features = features

	// value key — map container carries data-key to identify which entries index this map belongs to
		const key = parseInt(self.map.getContainer().dataset.key)

	// current_layer.user_layer_name 	= current_layer.data.user_layer_name

	// update the data in the instance previous to save
		// const entries = typeof (self.data.entries[0])!=='undefined'
		// 	? clone(self.data.entries[0])
		// 	: {}

	// publish the change to used by component_text_area from properties like 'hierarchy42'
		event_manager.publish(
			'updated_layer_data_'+ self.id_base,
			{
				layer: {
					type		: 'geo',
					layer_id	: layer_id
				},
				caller: self
			}
		)

		// create on first touch — drawing on a record with no stored value is the
		// action that CREATES the value; current_value[key] is undefined until now
		self.get_entry_buffer(key).lib_data = self.ar_layer_loaded


	// track changes in self.data.changed_data — enqueue for the next save
		const changed_data_item = self.build_changed_data_item(key)
		self.set_changed_data(changed_data_item)


	return true
}//end update_draw_data



/**
* MAP_UPDATE_COORDINATES
* Re-centres this geolocation map to the coordinates stored in a record pointed to
* by another component (e.g. a portal/autocomplete for toponymy). When the user
* picks a location record in the linked component, this method reads the geolocation
* data from that record and copies it to this component's map and data value.
*
* This method is fired via the ontology `observe` event system (event: 'update_value'
* on the observed component). It is NOT called directly by this component.
*
* The self component (geolocation that is listening) should be configured in properties as:
*
*	"observe": [
*		{
*			"client": {
*				"event": "update_value",
*				"perform": {
*				"function": "map_update_coordinates"
*				}
*			},
*			"component_tipo": "tch245"
*		}
*	]
*
* the observable component (portal with the data) should specify the component_geolocation that has the coordinates to be used
* it need to be defined in request_config 'hide' property with the role of 'target_geolocation_tipo'
* in this way:
*
* "request_config": [{
*		"hide": {
*			"ddo_map": [
*				{
*					"info": "component_geolocation to be used as data of the observer geolocation (move the map to the value of this component), role property identify it by map_update_coordinates() funcion",
*					"role": "target_geolocation_tipo",
*					"tipo": "hierarchy31",
*					"parent": "self",
*					"section_tipo": "self"
*				}
*			]
*		}
*	}]
*
* If the observable doesn't has specified the component_geolocation will use the default thesaurus component_geolocation: hierarchy31
*
* Resolution logic:
*  1. Reads `target_geolocation_tipo` from `caller.request_config_object.hide.ddo_map`
*     (role='target_geolocation_tipo'), falling back to 'hierarchy31'.
*  2. Uses `caller.data.entries` to identify which record was last selected (the
*     portal's last entry's section_id).
*  3. Searches `caller.datum.data` for the geolocation component data at that
*     section_id and updates this component's map and data accordingly.
*
* (!) `caller.datum.data` is the raw datum array from the portal; if the portal's
* request_config does not include the target geolocation tipo in its ddo_map, the
* find call will return undefined and the map will not be moved.
*
* @param {Object} options - Event payload dispatched by the observed component.
* @param {Object} options.caller - The portal/autocomplete instance whose value changed.
* @returns {Promise<void>}
*/
component_geolocation.prototype.map_update_coordinates = async function(options) {

	const self = this

	const caller = options.caller

	// check if the caller has defined 'target_geolocation_tipo' component in hide of rqo
	const target_geolocation_tipo = caller.request_config_object.hide?.ddo_map?.find(
		el => el.role === 'target_geolocation_tipo')?.tipo
		|| 'hierarchy31' // Default geolocation map in thesarus

	const original_value = caller.data.entries
	// if the caller has not data, do not update the map
	// (!) WC-001: an empty caller emits `[]` (truthy) — the length check is the
	// real guard; without it last_value is undefined and .section_id throws.
	if(!Array.isArray(original_value) || original_value.length===0){
		return
	}
	// get the last value of the caller portal
	// it will use to find the target_geolocation_tipo data
	const last_value = original_value[original_value.length-1]

	const target_geolocation_data = caller.datum.data.find( el =>
		el.tipo === target_geolocation_tipo
		&& parseInt(el.section_id) === parseInt(last_value.section_id)
	)

	// if target_geolocation_data, incorporate it to the current map and reload it
	if(target_geolocation_data){
		// geolocation doesn't has multiple maps and the key of the data array is always 0
		const key = 0

		// borrowed entries. (!) CLONE: current_value is mutated in place by
		// update_input_values, and assigning the caller's array by reference wrote
		// this component's altitude back into the observed record's datum.
		const borrowed_entries = Array.isArray(target_geolocation_data.entries)
			? clone(target_geolocation_data.entries)
			: []
		if (borrowed_entries[key]===undefined || borrowed_entries[key]===null) {
			// the target record has no coordinates: nothing to borrow, nothing to save
			return
		}

		// (!) THE COORDINATES ARE BORROWED, THE IDENTITY IS NOT. A stored entry of
		// the OBSERVED record carries its OWN item id. Keeping it would make this
		// record's save target a foreign id: build_changed_data_item prefers
		// value.id, applyUpdate (save_component.ts, non-sliced branch) finds no
		// item with that id and APPENDS — the record ends up holding two geo
		// items, reloads at the stale first one, and publishes both points.
		// Dropping it lets build_changed_data_item recover THIS record's own id
		// from its stored entry, so the borrowed coordinates REPLACE the value.
			borrowed_entries.forEach((entry) => {
				if (entry && typeof entry==='object') {
					delete entry.id
				}
			})

		// (!) THE MAP DEFINITION IS NOT BORROWED EITHER. The observed record's `sources`
		// and `legend` describe ITS map: copying them would put another record's tile
		// services (their numbers mean nothing here, and a number this record holds
		// would overwrite that source on save) into this record, and replacing the
		// buffer wholesale would delete this record's own. The borrowed entry keeps
		// none of the observed definition and carries THIS record's own — from the
		// edit buffer, else from the stored entry (the map may not be built yet).
			const host_entry = self.current_value[key] ?? self.get_stored_entry(key)
			borrowed_entries.forEach((entry, index) => {
				if (!entry || typeof entry!=='object') {
					return
				}
				for (const name of MAP_DEFINITION_KEYS) {
					delete entry[name]
					if (index===key && host_entry && host_entry[name]!==undefined) {
						entry[name] = clone(host_entry[name])
					}
				}
			})

		self.current_value = borrowed_entries

		// move the map to the borrowed point. move_camera is the single door: it
		// moves once (animate:false) and suppresses the map's own event feedback,
		// so the borrowed coordinates are never overwritten by the map centre.
		const view_lat	= fn_finite_number(self.current_value[key].lat)
		const view_lon	= fn_finite_number(self.current_value[key].lon)
		const view_zoom	= fn_finite_number(self.current_value[key].zoom)
		if (self.map && view_lat!==null && view_lon!==null) {
			self.move_camera(view_lat, view_lon, view_zoom ?? self.map.getZoom())
		}

		// the observer's borrowed values become this record's own view
		self.update_input_values(
			key,
			self.current_value[key],
			self.node.content_data[key].map_container
		)

		// modify his own data with the new values — change_value persists the borrowed coordinates
		const changed_data_item = self.build_changed_data_item(key)
		if (!changed_data_item) {
			return
		}
		self.change_value({
			changed_data	: [changed_data_item],
			refresh			: false
		})
	}

}//end map_update_coordinates



/**
* LAYER_DATA_CHANGE
* Reacts to geo-tag insertion and removal events from a linked `component_text_area`.
* Called when the user adds or deletes a geo-tag in the rich-text editor; synchronises
* the map's FeatureGroup state with the tag model.
*
* 'insert' action:
*   - Short-circuits if the layer is already loaded (idempotent).
*   - Recovers the layer from `ar_data_buffer` if available (supports undo after remove).
*   - Pushes the recovered or new empty layer into `ar_layer_loaded`, renders it on
*     the map, and persists the change via `change_value`.
*   - The db_data baseline is NOT touched here: save() advances it from the
*     server's answer (component_common.save).
*
* 'remove' action:
*   - Saves the layer into `ar_data_buffer[layer_id]` to enable undo recovery.
*   - Removes the FeatureGroup from the map and the layer control.
*   - Splices the entry out of `ar_layer_loaded` and persists via `change_value`.
*   - After save resolves: resets to layer 1 if no layers remain, or activates
*     the first available layer.
*
* (!) `key` is hardcoded to 0 because geolocation only supports a single coordinate
* entry per component instance. Multi-entry support would require reading the key
* from the event payload.
*
* @param {Object} change - Tag change descriptor.
* @param {string} change.action - 'insert' or 'remove'.
* @param {number|string} change.tag_id - The numeric id of the affected tag (parsed to int).
* @param {string} change.type - Always 'geo' for this component.
* @returns {boolean} True on success; false when the map is not built yet
*                   (`ar_layer_loaded` still null) or the layer to remove cannot be found.
*/
component_geolocation.prototype.layer_data_change = function(change) {

	const self = this

	// set the layer data
		const action		= change.action
		const layer_id		= parseInt(change.tag_id)
		const key			= 0; // fixed key (only one element is allowed)
		// const layer_name	= 'layer_' +layer_id

	// THE MAP MAY NOT BE BUILT YET. `ar_layer_loaded` is null until get_map()
	// clones the stored value into it, and the paired component_text_area fires
	// its tag events as soon as its editor loads content (set_content →
	// changeData → publish), which happens BEFORE the map is opened whenever the
	// geolocation component is not yet activated. Without this the subscriber
	// threw `Cannot read properties of null (reading 'find')` and the editor's
	// change handler died mid-flight. Nothing is loaded, so there is nothing to
	// synchronise — and writing current_value here would persist a layer set the
	// component has not read yet. Same guard as layers_loader ('layer' branch).
		if (!self.ar_layer_loaded) {
			return false
		}

		switch(action) {

			case 'insert':
				const layer_loaded = self.ar_layer_loaded.find((item) => item.layer_id===layer_id)
				if(layer_loaded){
					return true
				}
				// recover from buffer if the user previously removed this tag in the same session
				const recover_layer = self.ar_data_buffer[layer_id] ||
					{
						layer_id	: layer_id,
						layer_data	: []
					};

				self.ar_layer_loaded.push(recover_layer)
				self.load_layer(recover_layer)

				// create on first touch — inserting a geo-tag on a record with no
				// stored value is the action that CREATES the value
				self.get_entry_buffer(key).lib_data = self.ar_layer_loaded

				const recover_changed_data = [self.build_changed_data_item(key)]
				// (!) NO db_data SYNC HERE. save() already advances the baseline
				// from the SERVER's answer (component_common: `db_data = clone(data)`,
				// skipped on a degraded save on purpose). The line that used to sit
				// in a `.then()` here wrote `db_data.value[key]` — a phantom key:
				// this component's data carries `entries`, never `value`, so it threw
				// `Cannot set properties of undefined` on EVERY tag insertion, inside
				// a floating promise (an unhandled rejection, which is why the suite
				// stayed green). Written to the real key it would be worse than
				// useless: it would overwrite the server-confirmed baseline with local
				// state, exactly what save() refuses to do when the record is degraded.
				self.change_value({
					changed_data	: recover_changed_data,
					refresh			: false
				})
				break;

			case 'remove':
				// get the layer from the loaded data
				const layer = self.ar_layer_loaded.find((item) => item.layer_id===layer_id)
				if(!layer){
					return false
				}
				// store the layer into the data_buffer for possible undo recovery
				self.ar_data_buffer[layer_id] = layer;
				// remove the data of the FeatureGroup
				if(!self.FeatureGroup[layer_id]){
					return false
				}
				self.FeatureGroup[layer_id].remove();
				self.FeatureGroup[layer_id].clearLayers();
				if (self.layer_control) {
					self.layer_control.removeLayer(self.FeatureGroup[layer_id]);
				}
				delete self.FeatureGroup[layer_id];

				// remove the layer
				const index = self.ar_layer_loaded.findIndex((item) => item.layer_id===layer_id)
				self.ar_layer_loaded.splice(index,1)

				// create on first touch — removing a tag can arrive before any other
				// edit, so the entry may still be absent here too
				self.get_entry_buffer(key).lib_data = self.ar_layer_loaded

				const changed_data = [self.build_changed_data_item(key)]
				self.change_value({
					changed_data	: changed_data,
					refresh			: false
				})
				.then(()=>{
					// (!) no db_data sync — save() owns the baseline (see the insert
					// branch above; the line here threw the same way).
					// when the ar_layer_loaded is empty, the user has delete all tags and is necessary reset the load_layer

					if(self.ar_layer_loaded.length === 0){
						// reset the load_layer to 1 — ensures a valid empty FeatureGroup exists
						self.layers_loader({
							load 		: 'layer',
							layer_id	: 1
						})
					}else{
						// if the tag removed is not the last one, load the next layer that can be used
						const next_layer = self.ar_layer_loaded[0]
						self.load_layer(next_layer)
					}
				})
				break;
		}

	return true
}//end layer_data_change



/**
* CREATE_POINT
* Programmatically places a new Leaflet Marker at the given coordinates and adds
* it to the currently active FeatureGroup. Useful when an external component (e.g.
* a search result or autocomplete) provides coordinates to plot.
*
* After adding the marker, `update_draw_data` is called to serialise the updated
* FeatureGroup into `ar_layer_loaded` and mark the component as changed.
*
* @param {Object} point - Coordinate pair accepted by `L.marker`.
* @param {number} point.lat - WGS84 latitude in decimal degrees.
* @param {number} point.lng - WGS84 longitude in decimal degrees.
* @returns {boolean} True when the point was placed; false when the map is not
*                    built yet — see the guard below.
*/
component_geolocation.prototype.create_point = function(point) {

	const self = this

	// THE MAP MAY NOT BE BUILT YET. This is the PROGRAMMATIC entry point (the
	// address search in view_default_edit_geolocation, and direct calls from
	// tests), so unlike the Leaflet handlers it is not guaranteed to run inside
	// a built map: `self.map` is null until get_map() runs, and the active
	// FeatureGroup only exists once load_layer rendered it. Placing a marker on
	// a null map throws. Same guard as layer_data_change.
	const active_group = self.FeatureGroup[self.active_layer_id]
	if (!self.map || !self.ar_layer_loaded || !active_group) {
		return false
	}

	// create new point in the coordinates
	const new_point = L.marker(point).addTo(self.map);

	// add new point to the active layer
	active_group.addLayer(new_point)

	// update the layer data with the new point
	self.update_draw_data(self.active_layer_id)


	return true
}//end create_point



/**
* INIT_FEATURE
* Private module function (not on the prototype). Initialises a single Leaflet
* layer (geometry feature) by:
* 1. Applying a stored custom colour via `setStyle`, when `feature.properties.color`
*    is set (only applicable to non-Marker shapes).
* 2. Building and binding a measurement popup via `get_popup_content`.
* 3. Attaching a 'click' event listener that:
*    - Sets `active_layer_id` to this feature's `layer_id`.
*    - Enables geoman editing (`pm.enable`) on all features in the clicked layer's
*      FeatureGroup.
*    - Disables geoman editing on all features in all OTHER FeatureGroups.
* 4. Adding the Leaflet layer to its parent `FeatureGroup[layer_id]`.
*
* Called from `load_layer` (via `L.geoJson` `onEachFeature`) for restored geometry,
* and from `init_draw_editor`'s `pm:create` handler for newly drawn features.
*
* The colour-coded active/inactive styling blocks inside the click handler are
* intentionally commented out — the visual design uses geoman's own handles rather
* than custom stroke colours.
*
* @param {Object} options - Initialisation context.
* @param {Object} options.self - The `component_geolocation` instance.
* @param {Object} options.data_layer - Leaflet layer (Marker/Circle/Polygon/Polyline).
* @param {number} options.layer_id - Id of the parent FeatureGroup.
* @param {Object|null} [options.feature=null] - GeoJSON feature object; may be null
*   when called from `pm:create` (no feature properties available yet).
* @returns {void}
*/
const init_feature = function(options) {

	const self			= options.self
	const data_layer	= options.data_layer
	const layer_id		= options.layer_id
	const feature		= options.feature || null

	// check if the feature has data else do nothing
	if(data_layer){

		// color — restore the persisted stroke colour from GeoJSON properties
			const color = feature && feature.properties && feature.properties.color
				? feature.properties.color
				: null
			if(color){
				data_layer.setStyle({color: color})
			}
		// PopupContent. get the popup information
			const content = self.get_popup_content(data_layer, layer_id);
			if (content) {
				data_layer.bindPopup(content,{
					minWidth : 155
				});
			}//end if(content)
		// Click. Listener for each layer, when the user click into one layer, activate it and your feature, deactivate rest of the features and layers
			data_layer.on('click', function() {
				// ACTIVE_LAYER_ID : Set the current active layer id will be editable with the actual FeatureGroup
					self.active_layer_id = layer_id;

				// change all features and layers for activate or deactivate the edit mode.
					for (let feature in self.FeatureGroup) {

						if(feature){
							if(self.FeatureGroup[feature]===self.FeatureGroup[layer_id]){
								// enable editing on all features in the clicked layer
								self.FeatureGroup[layer_id].eachLayer(function (layer){
									// layer.editing.disable();
									layer.pm.enable()
									// if(!(layer instanceof L.Marker)){
									// 	layer.setStyle({color: '#31df25'});
									// }
								});
							}else{

								// disable editing on all features in other layers
								self.FeatureGroup[feature].eachLayer(function(layer) {
									// layer.editing.disable();
									layer.pm.disable()
									// if(!(layer instanceof L.Marker)){
									// 	layer.setStyle({color: '#3388ff'});
									// }
								});
							}
						}
					}
				// current layer activate and change to pink color
				//e.target.editing.enable();
				// if(!(e.target instanceof L.Marker)){
				// 	e.target.setStyle({color: '#97009C'});
				// }else{
				// 	console.log("Not e.target instanceof L.Marker ",);
				// }

			 });
		// addLayer — register the Leaflet layer into its parent FeatureGroup
			self.FeatureGroup[layer_id].addLayer(data_layer)
	}//end if (data_layer)
}//end init_feature



/**
* READABLE_AREA
* Private module function. Converts a raw area value in square metres to a
* human-readable string with an appropriate unit suffix, chosen by magnitude.
*
* Metric thresholds:
* - >= 1,000,000 m² → km²  (precision: 2 decimal places)
* - >= 10,000 m²    → ha   (precision: 2 decimal places)
* - < 10,000 m²     → m²   (no decimal places)
*
* Imperial thresholds:
* - >= 2,589,986.9952 m² → mi²   (1 square mile)
* - >= 4,046.8564224 m²  → acres (1 acre)
* - < 4,046.8564224 m²   → yd²
*
* Unit conversion uses `turf.convertArea`; rounding uses `turf.round`.
*
* (!) In metric mode, the `else` branch (area < 10,000) contains `area + ' m²'`
* without assigning the result to `area_string`. This is a pre-existing bug:
* the expression is computed but discarded, so `area_string` remains `undefined`
* for small polygons in metric mode. Do not fix here — document only.
*
* @param {number} area - Area in square metres as returned by `turf.area`.
* @param {boolean} [metric=true] - Use metric units when true, imperial otherwise.
* @returns {string|undefined} Formatted area string; undefined for metric areas < 10,000 m²
*   due to the pre-existing bug noted above.
*/
const readable_area = function (area, metric=true) {

	const precision = {
		km	: 2,
		ha	: 2,
		m	: 0,
		mi	: 2,
		ac	: 2,
		yd	: 0,
		ft	: 0,
		nm	: 2
	}

	let area_string

	if (metric) {

		if (area >= 1000000) {
			area_string = turf.round(turf.convertArea(area, 'meters', 'kilometers'), precision['km']) + ' km²';
		} else if (area >= 10000 ) {
			area_string = turf.round(turf.convertArea(area, 'meters', 'hectares'), precision['ha']) + ' ha';
		} else {
			area_string = area + ' m²';
		}
	} else {
		if (area >= 2589986.9952) { //2589986,9952 square meters are 1 square mile
			area_string = turf.round(turf.convertArea(area, 'meters', 'miles'), precision['mi']) + ' mi²';
		} else if (area >= 4046.8564224) { //4046.8564224 square meters are 1 acres
			area_string = turf.round(turf.convertArea(area, 'meters', 'acres'), precision['ac']) + ' acres';
		} else {
			area_string = turf.round(turf.convertArea(area, 'meters', 'yards'), precision['yd']) + ' yd²';
		}
	}

	return area_string
}//end readable_area



// @license-end
