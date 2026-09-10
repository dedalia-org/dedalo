// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global page_globals, SHOW_DEVELOPER, L */
/*eslint no-undef: "error"*/



/**
 * TOOL_UCA_MAPS
 *
 * Native v7 port of v6 `tool_leaflet_special_tools` (Museu de Prehistòria de
 * València / hispanicode-UCA). Plan: `plan_implementacion.md` (repo root).
 * Per-hito dossiers: `docs/HITOS.md` index + `docs/hitos/hito_<N>.md` (this
 * dir, local, not committed).
 *
 * HITO 1 SCOPE (vertical slice, closed): reach the live map, prove
 * open/close/reopen adds no duplicate control, and show server capabilities.
 *
 * HITO 2 SCOPE (checkpoint 2a, this revision): the object console — see
 * `object_console.js` for the full architecture note. Summary: `open_as:
 * 'modal'` blocks map clicks while open (`<dd-modal>`'s full-viewport
 * overlay), incompatible with "click a geometry on the live map while the
 * console is available". Sergio confirmed v6/dedalo6's own real behaviour:
 * the tool modal loads and closes itself, leaving its tools anchored to the
 * map. So here: `edit()` attaches the console to the live map, then closes
 * its own modal (`on_close_actions` intercepts the default destroy so the
 * INSTANCE survives that close — the console must outlive the modal, tied
 * instead to component_geolocation's own lifecycle). Real teardown now runs
 * from `on_geolocation_destroyed()`. Hito 1's capabilities panel moved from
 * the modal body into the anchored console (same server contract).
 *
 * WHY THIS FILE DOES NOT USE tool_config.ddo_map / self.main_element (unlike
 * tool_dev_template): this tool has no `ontology` entry in register.json, so
 * tool_common's cascade falls to its synthetic fallback, which builds a FRESH
 * component_geolocation instance via get_instance({..., id_variant: self.model})
 * — a different instance key than the one the user is already looking at, so a
 * SEPARATE, unrendered Leaflet map would exist nobody ever sees. This tool
 * targets the LIVE instance instead: `self.caller` is the component itself
 * (`ui.tool.build_component_tool_button` opens tools with `caller: self`, the
 * component), reached via `get_caller_by_model` — never a fixed-depth walk,
 * per CLAUDE.local.md and `test/unit/client_caller_chain_tripwire.test.ts` —
 * so the same code keeps working if this tool is ever opened from a portal.
 * The default ddo_map loader is therefore disabled (see build() below) rather
 * than left to build an instance nothing in this tool reads.
 *
 * LEFT TOOLBAR (2026-09-04, before hito 4 — see CLAUDE.local.md "Left
 * toolbar: un botón por funcionalidad"): the top-right icon still opens this
 * tool's own transient modal (unchanged, `render_tool_uca_maps.js`), which
 * still self-closes onto the live map — but what it leaves behind is no
 * longer ONE "UCA" button with a panel bundling every functionality as
 * collapsible sections. Every functionality now gets its OWN 'topleft'
 * button + its OWN panel, built through `toolbar.js`: "UCA" (functionality
 * #3, the object console — `object_console.js`), "Download map as image"
 * (functionality #10 — `map_image_download.js`), and a dev-only server-
 * capabilities diagnostic (`capabilities_panel.js`, SHOW_DEVELOPER-gated —
 * it is not one of the 15 functionalities in
 * `docs/Funcionalidades de tool_leaflet_special_tools.md`, so it does not
 * get an end-user button). Hito 4 adds "Objects" (functionality #4, the
 * read-only vector/rasterized object list — `object_viewer.js`). Hito 7 adds
 * "1x1" (functionality #7, a 1 m-radius rectangle around a clicked Marker —
 * `onexone.js`), the first of these with NO panel — v6 has none for this row
 * either, just a bare toggle button. Hito 9 adds "XYZ" (functionality #5,
 * custom base-map layers — `xyz_basemaps.js`), session-only persistence for
 * now (`docs/PREGUNTAS_FORO.md` #7). "WMS" (functionality #6, generic WMS
 * server layers — `wms_services.js`) adds one server action of its own
 * (`get_wms_layers`, an SSRF-guarded GetCapabilities proxy — no browser can
 * fetch a third-party WMS endpoint directly) but keeps the same session-only
 * persistence as XYZ. "Catastro" (functionality #8) and "UA" (functionality
 * #9, `administrative_units.js`) add the same fixed-host server proxy shape
 * (`catastro.ts`/`administrative_units.ts` — no client-supplied URL, unlike
 * WMS) behind the v6 record-language gate (es/cat/eus) shared by both. Hito
 * 12 adds "Upload file to map" (functionality #11, VECTOR HALF ONLY —
 * `vector_upload.js`): the raw file is staged via the engine's own generic
 * `service_upload.js` transport, then converted server-side to WGS84 GeoJSON
 * (`upload_vector_layer` — GDAL/PROJ, no vendored shapefile/KML reader or
 * hardcoded EPSG table, unlike v6). Hito 13 completes the SAME row with its
 * IMAGE half (`image_upload.js`), inside the same button/panel — the file is
 * ingested through the engine's own media door onto a fresh rsc170 record,
 * and the server (which already has GDAL) reports the footprint that decides
 * where the overlay goes, so v6's two browser-side GeoTIFF libraries are not
 * ported at all. The rest of the audit's rows land the same way: a new
 * button (+panel where the functionality actually needs one), never a new
 * section inside an existing panel.
 */



// imports
	import {pause} from '../../../core/common/js/utils/index.js'
	import {get_caller_by_model} from '../../../core/common/js/utils/util.js'
	import {common} from '../../../core/common/js/common.js'
	import {dd_request_idle_callback} from '../../../core/common/js/events.js'
	import {tool_common, wire_tool} from '../../../core/tools_common/js/tool_common.js'
	import {render_tool_uca_maps} from './render_tool_uca_maps.js'
	import {
		attach_console,
		detach_console,
		compute_info,
		RESERVED_PROPERTY_KEYS,
		set_style_field,
		set_property,
		delete_property,
		download_vector,
		toggle_centroid,
		toggle_uncertainty,
		set_hierarchy
	} from './object_console.js'
	import {
		download_map_image,
		attach_map_image_download_control,
		detach_map_image_download_control
	} from './map_image_download.js'
	import {attach_capabilities_panel, detach_capabilities_panel} from './capabilities_panel.js'
	import {
		attach_object_viewer,
		detach_object_viewer,
		collect_objects,
		set_object_display,
		center_on_object
	} from './object_viewer.js'
	import {attach_onexone, detach_onexone} from './onexone.js'
	import {
		attach_xyz_basemaps,
		detach_xyz_basemaps,
		add_basemap,
		delete_basemap,
		move_basemap
	} from './xyz_basemaps.js'
	import {
		attach_wms_services,
		detach_wms_services,
		search_wms_layers,
		clear_wms_search,
		add_wms_layer,
		toggle_wms_layer,
		set_wms_layer_opacity,
		delete_wms_layer
	} from './wms_services.js'
	import {attach_catastro, detach_catastro} from './catastro.js'
	import {attach_administrative_units, detach_administrative_units} from './administrative_units.js'
	import {attach_file_upload, detach_file_upload, upload_vector_file} from './vector_upload.js'
	import {
		attach_image_overlays,
		detach_image_overlays,
		upload_image_file,
		set_image_display,
		get_image_href
	} from './image_upload.js'
	import {is_image_editing, set_image_interactive} from './image_edit.js'



/** Deterministic map wait (plan §3.5): budget + poll interval. */
export const MAP_WAIT_TIMEOUT_MS	= 8000
export const MAP_WAIT_INTERVAL_MS	= 100



/**
* TOOL_UCA_MAPS
* Tool constructor. Declares every instance property used by this tool.
*
* Properties:
*   id            - unique tool instance identifier (set by tool_common.init)
*   model         - string model name, always 'tool_uca_maps'
*   mode          - display mode: 'edit', 'list', etc.
*   node          - root HTMLElement rendered by render()
*   ar_instances  - kept empty (see file header); never populated from ddo_map
*   events_tokens - array of event subscription tokens for cleanup in destroy()
*   status        - current lifecycle state (null | 'inited' | 'built' | 'ready')
*   type          - tool type as declared in register.json
*   caller        - the component_geolocation instance that opened this tool
*   langs         - project default languages array from page_globals
*   geolocation   - the LIVE component_geolocation instance (get_caller_by_model
*                   result); this is what get_map()/self.map belong to, NOT a
*                   ddo_map-built clone
*   map_ready     - true once self.geolocation.map was found within budget
*   map_control   - the "UCA" toolbar button (functionality #3, object
*                   console); removed in destroy() so closing/reopening
*                   never leaves a duplicate
*   panel_node    - the anchored object-console panel (object_console.js),
*                   appended directly to the map's own DOM container
*   console_visible - whether panel_node is currently shown (Show/Hide)
*   active_console_layer - the Leaflet layer the console is currently
*                   showing, or null before any geometry has been clicked
*   _popupopen_handler - the map 'popupopen' listener object_console.js
*                   subscribes for selection tracking; kept so destroy() can
*                   unsubscribe the exact same reference
*   _pmcreate_handler - the map 'pm:create' listener object_console.js (2b)
*                   subscribes to re-apply style/hierarchy extras to newly
*                   created geometry; same unsubscribe-by-reference reason
*   _pmremove_handler - the map 'pm:remove' listener object_console.js (2b)
*                   subscribes to clear a stale selection and unlock/remove
*                   an orphaned centroid when a layer is deleted from the
*                   map by some path other than this tool's own controls
*                   (typically Geoman's delete tool); same reason
*   map_image_control - the "Download map as image" toolbar button
*                   (functionality #10, map_image_download.js)
*   map_image_panel - its anchored panel
*   map_image_panel_visible - whether map_image_panel is currently shown
*   capabilities_control - the dev-only server-capabilities toolbar button
*                   (capabilities_panel.js), null unless SHOW_DEVELOPER
*   capabilities_panel - its anchored panel, same SHOW_DEVELOPER gate
*   capabilities_panel_visible - whether capabilities_panel is currently shown
*   object_viewer_control - the "Objects" toolbar button (functionality #4,
*                   object_viewer.js)
*   object_viewer_panel - its anchored panel
*   object_viewer_panel_visible - whether object_viewer_panel is currently shown
*   onexone_control - the "1x1" toolbar button (functionality #7, onexone.js)
*                   — the first button with NO panel (v6 has none either;
*                   see onexone.js file header)
*   _onexone_popupopen_handler - the map 'popupopen' listener onexone.js
*                   subscribes to arm a new rectangle on an eligible Marker
*                   click while 1x1 mode is on
*   _onexone_pmremove_handler - the map 'pm:remove' listener onexone.js
*                   subscribes to clear a stale onexone_uid pointer when the
*                   rectangle itself is deleted
*   xyz_control   - the "XYZ" toolbar button (functionality #5, xyz_basemaps.js)
*   xyz_panel     - its anchored panel
*   basemaps      - session-only array of {url, name, attribution, minzoom,
*                   maxzoom} (no shared/ontology persistence yet — see
*                   docs/PREGUNTAS_FORO.md #7); resets to the 3 v6 defaults
*                   on every attach
*   _xyz_tile_layers - the live L.TileLayer instances mirroring `basemaps`,
*                   1:1, rebuilt on every mutation (xyz_basemaps.js)
*   _xyz_took_over_tiles - true once this tool has removed the map's own
*                   raw tile layer/theme_observer (xyz_basemaps.js), so a
*                   second rebuild never repeats that takeover
*   _xyz_created_layer_control - true when this tool built the layer_control
*                   itself (no provider one existed) — detach_xyz_basemaps
*                   removes it entirely in that case, leaves a reused one
*   wms_control   - the "WMS" toolbar button (functionality #6, wms_services.js)
*   wms_panel     - its anchored panel
*   wms_layers    - session-only array of {url, name, title, opacity, visible}
*                   (no shared/ontology persistence yet, same as basemaps
*                   above); resets to an empty list on every attach
*   _wms_tile_layers - the live L.TileLayer.WMS instances mirroring
*                   `wms_layers`, 1:1 (wms_services.js)
*   _wms_search_results - {base_url, layers: [{name, title}]} from the last
*                   successful GetCapabilities search, or null before any
*                   search/after "Clear search"
*   catastro_control - the "Catastro" toolbar button (functionality #8,
*                   catastro.js), null unless the record's language gates it
*                   in (v6 parity — es/cat/eus). No panel, same shape as
*                   onexone_control
*   _catastro_tile_layer - the live cadastral L.TileLayer.WMS while armed
*                   (SWAPPED IN as the active basemap, v6 parity — not an
*                   overlay), or null
*   _catastro_previous_base_layers - the tile layer(s) that were active right
*                   before arming, restored verbatim on disable
*   _catastro_created_layer_control - true when THIS toggle created
*                   geolocation.layer_control itself (no provider/xyz one
*                   existed) — disable removes it entirely in that case
*   _catastro_click_handler - the map 'click' listener while armed, or null
*   _catastro_busy - true while a catastro lookup request is in flight (no
*                   overlapping lookups)
*   ua_control    - the "UA" toolbar button (functionality #9,
*                   administrative_units.js), same language gate as Catastro
*   ua_panel      - its anchored panel (a level select) — opening it arms the
*                   basemap swap+click listener, closing it disarms
*   _ua_level     - selected level ('Municipio'|'Provincia'|'CCAA'), session-only
*   _ua_tile_layer - the live AU.AdministrativeUnit L.TileLayer.WMS while
*                   armed (swapped in as the active basemap, v6 parity), or null
*   _ua_previous_base_layers - the tile layer(s) active before arming,
*                   restored verbatim on disable
*   _ua_created_layer_control - true when THIS toggle created
*                   geolocation.layer_control itself, same reason as Catastro
*   _ua_click_handler - the map 'click' listener while armed, or null
*   _ua_busy      - true while a UA lookup request is in flight
*   upload_control - the "Upload file to map" toolbar button (functionality
*                   #11, vector half only — hito 12, vector_upload.js)
*   upload_panel  - its anchored panel (file input + optional EPSG override)
*   _upload_busy  - true while a vector upload/conversion request is in
*                   flight (no overlapping uploads)
*   _image_upload_busy - the same latch for the image half (hito 13); separate
*                   from _upload_busy because the two sub-flows share a panel
*                   but not a request
*   _image_overlays - every live L.ImageOverlay.Rotated this tool put on the
*                   map. Overlays are NOT drawn objects, so nothing else in
*                   the engine tracks them and teardown must
*   _image_overlay_remove_handler / _image_overlay_token - the 'pm:remove'
*                   listener and the layer-data subscription that keep those
*                   overlays following their carrier rectangles
*   _toolbar_nodes - every DOM node any of this tool's button/panel pairs
*                   built (toolbar.js registers/unregisters them); the
*                   registry map_image_download.js's screenshot capture
*                   filters out generically, instead of naming each node
*/
export const tool_uca_maps = function () {

	this.id						= null
	this.model						= null
	this.mode						= null
	this.node						= null
	this.ar_instances				= null
	this.events_tokens				= null
	this.status						= null
	this.type						= null
	this.caller						= null
	this.langs						= null
	this.geolocation				= null
	this.map_ready					= false
	this.map_control				= null
	this.panel_node					= null
	this.console_visible			= false
	this.active_console_layer		= null
	this._popupopen_handler		= null
	this._pmcreate_handler			= null
	this._pmremove_handler			= null
	this.map_image_control			= null
	this.map_image_panel			= null
	this.map_image_panel_visible	= false
	this.capabilities_control		= null
	this.capabilities_panel		= null
	this.capabilities_panel_visible	= false
	this.object_viewer_control		= null
	this.object_viewer_panel		= null
	this.object_viewer_panel_visible	= false
	this.onexone_control			= null
	this._onexone_popupopen_handler	= null
	this._onexone_pmremove_handler	= null
	this.xyz_control				= null
	this.xyz_panel					= null
	this.basemaps					= null
	this._xyz_tile_layers			= null
	this._xyz_took_over_tiles		= false
	this._xyz_created_layer_control	= false
	this.wms_control				= null
	this.wms_panel					= null
	this.wms_layers					= null
	this._wms_tile_layers			= null
	this._wms_search_results		= null
	this.catastro_control			= null
	this._catastro_tile_layer		= null
	this._catastro_previous_base_layers	= null
	this._catastro_created_layer_control	= false
	this._catastro_click_handler	= null
	this._catastro_busy			= false
	this.ua_control					= null
	this.ua_panel					= null
	this._ua_level					= null
	this._ua_tile_layer			= null
	this._ua_previous_base_layers	= null
	this._ua_created_layer_control	= false
	this._ua_click_handler			= null
	this._ua_busy					= false
	this.upload_control				= null
	this.upload_panel				= null
	this._upload_busy				= false
	this._image_upload_busy		= false
	this._image_overlays			= null
	this._image_overlay_remove_handler = null
	this._image_overlay_token		= null
	this._toolbar_nodes			= null
}//end tool_uca_maps



// wire_tool performs the standard prototype assignments (render/destroy/refresh
// from tool_common/common, edit from render_tool_uca_maps). destroy is then
// overridden below to add the map-control teardown.
wire_tool(tool_uca_maps, render_tool_uca_maps)

// (!) wire_tool does NOT copy tool_request (verified against its source: only
// render/destroy/refresh/edit/list are wired) — every production tool that
// calls self.tool_request() assigns it explicitly (tools/tool_export/js/tool_export.js:121
// is the confirmed-working reference). tool_dev_template's own copy calls
// self.tool_request() without this assignment; that looks like a pre-existing
// scaffold gap, not a contract this tool can rely on — documented here, not
// "fixed" in a file outside this tool's directory.
tool_uca_maps.prototype.tool_request = tool_common.prototype.tool_request



/**
* INIT
* Seeds common tool properties via tool_common.prototype.init, then resolves
* the LIVE component_geolocation instance this tool operates on.
*
* @param {Object} options - init options forwarded from open_tool
* @returns {Promise<boolean>} the common_init sentinel value
*/
tool_uca_maps.prototype.init = async function(options) {

	const self = this

	const common_init = await tool_common.prototype.init.call(this, options);

	try {

		self.lang	= options.lang
		self.langs	= page_globals.dedalo_projects_default_langs

		// resolve the live map owner. Cycle-safe, depth-agnostic (file header).
		// self.caller is set by tool_common.prototype.init above.
			self.geolocation = self.caller
				? get_caller_by_model(self.caller, 'component_geolocation')
				: null

		if (!self.geolocation) {
			console.error('tool_uca_maps: no component_geolocation found in the caller chain', self.caller);
		}

	} catch (error) {
		self.error = error
		console.error(error)
	}


	return common_init
}//end init



/**
* BUILD
* Loads the tool CSS (via tool_common) but skips the default ddo_map loader
* (see file header) — this tool builds nothing of its own; it waits for the
* live component_geolocation's map instead.
*
* @param {boolean} [autoload=false]
* @returns {Promise<boolean>} the common_build sentinel value
*/
tool_uca_maps.prototype.build = async function(autoload=false) {

	const self = this

	const common_build = await tool_common.prototype.build.call(this, autoload, {
		// no ddo_map entries to resolve — see file header
		load_ddo_map : async () => { self.ar_instances = [] }
	});

	try {

		self.map_ready = await self.wait_for_map()

	} catch (error) {
		self.error = error
		console.error(error)
	}


	return common_build
}//end build



/**
* WAIT_FOR_MAP
* Deterministic wait for `self.geolocation.map` (plan §3.5: "espera
* determinista del mapa"). component_geolocation defers Leaflet init to an
* IntersectionObserver callback (`lazy_in_viewport`, un-awaited at its call
* site — see `client/dedalo/core/component_geolocation/js/view_default_edit_geolocation.js`),
* so the map can legitimately not exist yet the instant this tool opens.
*
* Polls rather than subscribing to an event because component_geolocation
* publishes no "map ready" event to hook into. Bails early — WITHOUT setting
* map_ready — if this tool instance is destroyed while waiting (e.g. the user
* closes the modal before the map finished loading), so a slow map can never
* resurrect a torn-down instance.
*
* @returns {Promise<boolean>} true once self.geolocation.map exists; false on
*   timeout or if self.geolocation is null (no map component found at all)
*/
tool_uca_maps.prototype.wait_for_map = async function() {

	const self = this

	if (!self.geolocation) {
		return false
	}

	const deadline = Date.now() + MAP_WAIT_TIMEOUT_MS
	while (Date.now() < deadline) {

		if (self.status==='destroyed') {
			return false
		}
		if (self.geolocation.map) {
			return true
		}
		await pause(MAP_WAIT_INTERVAL_MS)
	}


	return Boolean(self.geolocation.map)
}//end wait_for_map



/**
* GET_CAPABILITIES
* Calls the server 'get_capabilities' action (GDAL/ImageMagick availability).
* Permission 'record_tipo': needs the map component's tipo + a record in scope.
*
* @returns {Promise<Object>} API response envelope; response.result on success
*   is the UcaMapsCapabilities shape (tools/tool_uca_maps/server/capabilities.ts)
*/
tool_uca_maps.prototype.get_capabilities = async function() {

	const self = this

	const response = await self.tool_request({
		action	: 'get_capabilities',
		options	: {
			tipo			: self.geolocation.tipo,
			section_id		: self.geolocation.section_id,
			section_tipo	: self.geolocation.section_tipo
		}
	})

	if(SHOW_DEVELOPER===true) {
		console.log('-> get_capabilities API response:', response);
	}

	return response
}//end get_capabilities



/**
* ATTACH_CONSOLE
* Thin prototype wrapper over object_console.js's attach_console (see that
* file for the full architecture note). Idempotent — a stray extra render
* pass never attaches a duplicate control/panel.
*
* @returns {void}
*/
tool_uca_maps.prototype.attach_console = function() {
	attach_console(this)
}//end attach_console



/**
* ATTACH_MAP_IMAGE_DOWNLOAD_CONTROL / ATTACH_CAPABILITIES_PANEL
* Thin prototype wrappers over map_image_download.js/capabilities_panel.js —
* same reason as attach_console above. Called alongside it from edit()
* (render_tool_uca_maps.js): each functionality's own button+panel, built
* through toolbar.js (CLAUDE.local.md "Left toolbar: un botón por
* funcionalidad").
*/
tool_uca_maps.prototype.attach_map_image_download_control = function() {
	attach_map_image_download_control(this)
}//end attach_map_image_download_control

tool_uca_maps.prototype.attach_capabilities_panel = function() {
	attach_capabilities_panel(this)
}//end attach_capabilities_panel

tool_uca_maps.prototype.attach_object_viewer = function() {
	attach_object_viewer(this)
}//end attach_object_viewer

/**
* ATTACH_ONEXONE
* Thin prototype wrapper over onexone.js's attach_onexone — same reuse
* reason as the other attach_* wrappers above (functionality #7, "Create
* 1x1 polygon"). No render_X.js counterpart: this button has no panel
* (onexone.js file header).
*/
tool_uca_maps.prototype.attach_onexone = function() {
	attach_onexone(this)
}//end attach_onexone



/**
* HITO 9 (fila #5, "XYZ basemaps") — THIN PROTOTYPE WRAPPERS OVER
* xyz_basemaps.js, same reuse reason as every other block above:
* render_xyz_basemaps.js calls self.<method>(...), never xyz_basemaps.js
* directly.
*/
tool_uca_maps.prototype.attach_xyz_basemaps = function() {
	attach_xyz_basemaps(this)
}//end attach_xyz_basemaps

tool_uca_maps.prototype.add_basemap = function(fields) {
	return add_basemap(this, fields)
}//end add_basemap

tool_uca_maps.prototype.delete_basemap = function(index) {
	return delete_basemap(this, index)
}//end delete_basemap

tool_uca_maps.prototype.move_basemap = function(index, direction) {
	return move_basemap(this, index, direction)
}//end move_basemap



/**
* "WMS" (functionality #6) — THIN PROTOTYPE WRAPPERS OVER wms_services.js,
* same reuse reason as every other block here: render_wms_services.js calls
* self.<method>(...), never wms_services.js directly.
*/
tool_uca_maps.prototype.attach_wms_services = function() {
	attach_wms_services(this)
}//end attach_wms_services

tool_uca_maps.prototype.search_wms_layers = function(raw_url) {
	return search_wms_layers(this, raw_url)
}//end search_wms_layers

tool_uca_maps.prototype.clear_wms_search = function() {
	return clear_wms_search(this)
}//end clear_wms_search

tool_uca_maps.prototype.add_wms_layer = function(fields) {
	return add_wms_layer(this, fields)
}//end add_wms_layer

tool_uca_maps.prototype.toggle_wms_layer = function(index) {
	return toggle_wms_layer(this, index)
}//end toggle_wms_layer

tool_uca_maps.prototype.set_wms_layer_opacity = function(index, opacity) {
	return set_wms_layer_opacity(this, index, opacity)
}//end set_wms_layer_opacity

tool_uca_maps.prototype.delete_wms_layer = function(index) {
	return delete_wms_layer(this, index)
}//end delete_wms_layer



/**
* "Catastro" (functionality #8) / "UA" (functionality #9) — THIN PROTOTYPE
* WRAPPERS, same reuse reason as every other block here. Neither
* catastro.js/administrative_units.js needs a self.<method> call from a
* render_X.js of its OWN (Catastro has no panel; administrative_units.js's
* level `<select>` writes straight to self._ua_level from
* render_administrative_units.js) — attach_X/detach_X are the only entry
* points tool_uca_maps.js itself needs to call.
*/
tool_uca_maps.prototype.attach_catastro = function() {
	attach_catastro(this)
}//end attach_catastro

tool_uca_maps.prototype.attach_administrative_units = function() {
	attach_administrative_units(this)
}//end attach_administrative_units



/**
* "Upload file to map" (functionality #11) — THIN PROTOTYPE WRAPPERS OVER
* vector_upload.js (vector half) and image_upload.js (image half), same reuse
* reason as every other block here: render_file_upload.js calls
* self.<method>(...), never either module directly.
*/
tool_uca_maps.prototype.attach_file_upload = function() {
	attach_file_upload(this)
}//end attach_file_upload

tool_uca_maps.prototype.upload_vector_file = function(file, epsg) {
	return upload_vector_file(this, file, epsg)
}//end upload_vector_file

tool_uca_maps.prototype.upload_image_file = function(file) {
	return upload_image_file(this, file)
}//end upload_image_file

tool_uca_maps.prototype.attach_image_overlays = function() {
	attach_image_overlays(this)
}//end attach_image_overlays

tool_uca_maps.prototype.set_image_display = function(layer, values, do_commit) {
	set_image_display(this, layer, values, do_commit)
}//end set_image_display

tool_uca_maps.prototype.get_image_href = function(layer) {
	return get_image_href(layer)
}//end get_image_href

tool_uca_maps.prototype.is_image_editing = function(layer) {
	return is_image_editing(layer)
}//end is_image_editing

tool_uca_maps.prototype.set_image_interactive = function(layer, active) {
	set_image_interactive(this, layer, active)
}//end set_image_interactive



/**
* HITO 4 — THIN PROTOTYPE WRAPPERS OVER object_viewer.js
* Same reuse reason as the checkpoint 2b block below: `render_object_viewer.js`
* calls `self.collect_objects()`/`self.set_object_display(...)`/
* `self.center_on_object(...)`, never `object_viewer.js` directly — the same
* one-directional render/logic convention as every other functionality here.
*/
tool_uca_maps.prototype.collect_objects = function() {
	return collect_objects(this)
}//end collect_objects

tool_uca_maps.prototype.set_object_display = function(layer, visible) {
	return set_object_display(this, layer, visible)
}//end set_object_display

tool_uca_maps.prototype.center_on_object = function(layer) {
	return center_on_object(this, layer)
}//end center_on_object



/**
* CHECKPOINT 2B — THIN PROTOTYPE WRAPPERS OVER object_console.js's MUTATORS
*
* Why these exist (review-diff tripwire-integrity finding, 2026-09-02):
* render_object_console.js needs to wire its DOM controls to these mutators,
* but it must never import them directly FROM object_console.js — this file
* (tool_uca_maps.js) already imports {render_console_panel,
* render_selected_object, ...} FROM render_object_console.js (the
* established one-directional convention across every render_X.js/X.js pair
* in tools/: logic imports render, never the reverse), and a render→logic
* import back would close a 2-node import cycle between the two 2b files.
* Every render_object_console.js call site uses `self.<method>(...)` instead
* — the same pattern `self.get_tool_label(...)`/`self.get_capabilities()`
* already used there since hito 1 — so render_object_console.js's only
* imports stay `ui`/`response_data` (core), no cycle.
*
* Each wrapper is a one-line passthrough; the real logic and its full
* documentation live in object_console.js, which still exports every one of
* these raw for direct testability (test_tool_uca_maps.js exercises them
* that way, bypassing the tool_common/get_instance ceremony same as the rest
* of that suite).
*/
tool_uca_maps.prototype.compute_info = function(layer) {
	return compute_info(this, layer)
}//end compute_info

tool_uca_maps.prototype.get_reserved_property_keys = function() {
	return RESERVED_PROPERTY_KEYS
}//end get_reserved_property_keys

tool_uca_maps.prototype.set_style_field = function(layer, field, value) {
	return set_style_field(this, layer, field, value)
}//end set_style_field

tool_uca_maps.prototype.set_property = function(layer, key, value) {
	return set_property(this, layer, key, value)
}//end set_property

tool_uca_maps.prototype.delete_property = function(layer, key) {
	return delete_property(this, layer, key)
}//end delete_property

tool_uca_maps.prototype.download_vector = function(layer, format) {
	return download_vector(this, layer, format)
}//end download_vector

/**
* CHECKPOINT 3B — map-wide raster download (functionality #10). Same thin-
* wrapper reason as the block above: `render_map_image_download.js` calls
* `self.download_map_image(...)`, never `map_image_download.js` directly.
*/
tool_uca_maps.prototype.download_map_image = function(format) {
	return download_map_image(this, format)
}//end download_map_image

tool_uca_maps.prototype.toggle_centroid = function(layer) {
	return toggle_centroid(this, layer)
}//end toggle_centroid

tool_uca_maps.prototype.toggle_uncertainty = function(layer) {
	return toggle_uncertainty(this, layer)
}//end toggle_uncertainty

tool_uca_maps.prototype.set_hierarchy = function(layer, edge, checked) {
	return set_hierarchy(this, layer, edge, checked)
}//end set_hierarchy



/**
* ON_CLOSE_ACTIONS
* Hook `view_modal` runs INSTEAD of its default destroy+refresh when the
* modal closes (`client/dedalo/core/tools_common/js/tool_common.js`, the same
* extension point `tool_export`/`tool_print`/etc. use). Deliberately does
* NOTHING: this tool's modal is transient scaffolding — `edit()` below closes
* it programmatically right after attaching the console — and the instance
* must survive that close with its console still anchored to the live map
* (file header). Real teardown fires only from on_geolocation_destroyed(),
* when component_geolocation itself is torn down.
*
* view_modal always calls this with the open_as string ('modal' here); no
* parameter is declared since nothing in this tool needs it (same pattern as
* tool_ontology.prototype.on_close_actions).
*
* @returns {boolean} always true
*/
tool_uca_maps.prototype.on_close_actions = function() {
	return true
}//end on_close_actions



/** How long the transient modal stays visible (spinner) before self-closing.
* v6's own equivalent (`render_tool_leaflet_special_tools.js`) held a
* `loading.gif` behind a hardcoded `setTimeout(…, 3000)` with no real work
* to wait on — an artificial pause purely for perceived feedback. An instant
* close here read as broken rather than "it worked" (Sergio, 2a validation,
* 2026-09-02) — this constant is the deliberate replacement, chosen with
* Sergio rather than inherited unexamined. */
export const TRANSIENT_MODAL_VISIBLE_MS = 2000

/**
* CLOSE_TRANSIENT_MODAL
* Schedules this tool's own modal to close itself after a deliberate visible
* window (see TRANSIENT_MODAL_VISIBLE_MS) — file header: v6's confirmed real
* behaviour is the tool modal loads and closes itself, spinner-first for
* feedback. First deferred via dd_request_idle_callback rather than called
* synchronously from edit() because `self.node.modal` is only set by
* view_modal AFTER render() resolves (`wrapper.modal = modal`,
* `client/dedalo/core/tools_common/js/tool_common.js`) — by the time an idle
* callback fires, that wiring is guaranteed to have already run; the visible
* window is then held on TOP of that with a plain setTimeout.
*
* `transient = true` skips <dd-modal>'s page-wide unsaved-data guard: this
* modal owns no editable data of its own (the documented use case for the
* flag — same as ui.confirm()'s yes/no dialogs) — a stray "unsaved changes?"
* prompt on an auto-close the user never requested would be a bug, not a
* safety net.
*
* @returns {void}
*/
tool_uca_maps.prototype.close_transient_modal = function() {

	const self = this

	dd_request_idle_callback(() => {
		setTimeout(() => {
			const modal = self.node && self.node.modal
			if (modal && typeof modal.close==='function') {
				modal.transient = true
				modal.close()
			}
		}, TRANSIENT_MODAL_VISIBLE_MS)
	})
}//end close_transient_modal



/**
* DESTROY
* Real teardown (CLAUDE.local.md "destrucción real"): removes every
* button+panel this tool anchored to the shared map — object_console.js
* ("UCA"), map_image_download.js ("Download map as image"),
* capabilities_panel.js (dev-only diagnostic, a no-op if it never attached),
* object_viewer.js ("Objects"), onexone.js ("1x1", button only, no panel),
* xyz_basemaps.js ("XYZ"), wms_services.js ("WMS"), catastro.js ("Catastro",
* button only, no panel — possibly a no-op if the record's language never
* gated it in), administrative_units.js ("UA"). The map itself belongs to
* component_geolocation and outlives this tool's (self-closed, see file
* header) modal, so leaving any control/panel behind
* would be exactly the v6 "controls stay stuck to the map" defect the plan
* (§7 item 7) requires fixed. Only reached from on_geolocation_destroyed()
* now (on_close_actions intercepts the modal-close path) — every detach_*
* is still internally guarded for the map already being gone, matching the
* general "component being destroyed" ordering question, not a NEW
* assumption this revision adds.
*
* self.events_tokens is unsubscribed generically by common.prototype.destroy
* (called at the end here).
*
* @param {boolean} [delete_self=true]
* @param {boolean} [delete_dependencies=false]
* @param {boolean} [remove_dom=false]
* @returns {Promise<Object>} same shape as common.prototype.destroy
*/
tool_uca_maps.prototype.destroy = async function(delete_self=true, delete_dependencies=false, remove_dom=false) {

	const self = this

	detach_console(self)
	detach_map_image_download_control(self)
	detach_capabilities_panel(self)
	detach_object_viewer(self)
	detach_onexone(self)
	detach_xyz_basemaps(self)
	detach_wms_services(self)
	detach_catastro(self)
	detach_administrative_units(self)
	detach_file_upload(self)
	detach_image_overlays(self)
	self.geolocation = null

	// delegate to the standard instance teardown (unsubscribes events_tokens,
	// removes self from instances_map, nullifies heavy props, DOM removal) —
	// same pattern as component_geolocation.prototype.destroy's own override
		return common.prototype.destroy.call(self, delete_self, delete_dependencies, remove_dom)
}//end destroy



/**
* ON_GEOLOCATION_DESTROYED
* Subscribed in render (see render_tool_uca_maps.js) to 'destroy_' + geolocation.id
* — the ONLY real teardown trigger since hito 2 (file header): this tool's
* own modal already closed itself right after attaching the console, so the
* console's lifetime is tied to component_geolocation's, not to the modal's.
* Runs the full destroy() (control/panel removal, events_tokens unsubscribe,
* instance removed from the registry) — nothing is left running once the map
* itself is gone.
*
* `async`/`return` (not fire-and-forget): `destroy()` is itself `async` and
* does real awaited work inside `common.prototype.destroy` (event-token
* unsubscribe, `status` transition, paginator/services teardown) — without
* propagating that promise, a caller (or a test) awaiting this method would
* not actually be waiting for teardown to finish, and any rejection deep
* inside would become an unhandled rejection instead of surfacing here
* (review-diff correctness finding, 2026-09-02).
*
* @returns {Promise<Object>} same shape as destroy()/common.prototype.destroy
*/
tool_uca_maps.prototype.on_geolocation_destroyed = async function() {
	return this.destroy(true, true, true)
}//end on_geolocation_destroyed



// @license-end
