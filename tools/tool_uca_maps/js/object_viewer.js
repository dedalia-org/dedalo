// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global L */
/*eslint no-undef: "error"*/



/**
* OBJECT_VIEWER
*
* Hito 4, functionality #4 of
* `docs/Funcionalidades de tool_leaflet_special_tools.md` ("Objects — Visor
* de objetos"). v6 (`special_tools_objects.js`, 576 lines) is READ-ONLY on
* top of the console (#3, `object_console.js`): two lists — "Vector Objects"
* / "Rasterized Objects" — of everything currently drawn in the map's
* ACTIVE FeatureGroup, ported verbatim from `special_tools_objects.js:85`
* (`self.collection = component_geolocation.FeatureGroup[active_layer_id]`
* — v6 never showed every tag/layer at once, only whichever one is
* currently active for editing), each row a show/hide checkbox + a button
* that centers the map on that object. No edit affordance exists anywhere
* in v6's module — the audit's own finding (#5, "Huecos frente a lo
* esperado") — ported as read/toggle-only.
*
* RASTERIZED OBJECTS is always empty today: v6's second list is raster
* image overlays flagged `special_tools.is_clipPolygon` (functionality #11,
* "Upload file to map" → image overlay), which this port has not built yet
* (still "no iniciado" per `docs/HITOS.md`). The list still renders its own
* header + an empty-state placeholder, so nothing structural changes the
* day #11 lands — a raster object will need to flag itself under
* `properties.uca_maps.is_raster` (mirrors v6's `is_clipPolygon`) for
* `collect_objects` below to route it there instead of the vector list.
*
* DELIBERATE DEVIATION FROM v6 (nameless objects): v6's own naming fallback
* (`translate_nameless`) MUTATES `layer.feature.properties.name` the moment
* the list is opened — a silent write that would ride along on the NEXT
* real save even though nothing was actually edited, a stronger violation of
* CLAUDE.local.md "nada auto-guarda" than v6's own casual approach (opening
* a read-only panel is not a save gesture). This port computes the same
* fallback label for display only and never writes it back — no v6
* behaviour worth preserving here (same reasoning already applied to
* `RESERVED_PROPERTY_KEYS`, `object_console.js`).
*
* NOT PORTED — v6's `multi_id` grouping (a MultiPolygon split into several
* single-Polygon Leaflet layers sharing one `special_tools.multi_id` tag, so
* they show/hide/center as one merged row): nothing in this port can
* currently PRODUCE a multi_id feature. Geoman's own draw tools only ever
* create a single geometry per gesture, and the one v6 path that imports a
* real MultiPolygon (functionality #11, vector upload) is not built yet
* either — so there is no live case to build this against
* (CLAUDE.local.md/dedalo-ts-testing: build the situation a test needs,
* never speculative coverage). Revisit the day #11's importer needs it.
*
* LIVE REFRESH (review-diff correctness finding, hito 4): unlike v6, whose
* modal blocked map interaction while open (file header of
* `object_console.js`), this panel and Geoman's own draw toolbar ('topleft'
* vs 'topright') are usable at the same time — a user can leave "Objects"
* open while drawing/editing/deleting elsewhere. `attach_object_viewer`
* subscribes the SAME `updated_layer_data_<id_base>` event
* `object_console.js`'s `hydrate()` already listens for (published by the
* core's `update_draw_data`, itself called from every one of Geoman's
* `pm:create`/`pm:update`/`pm:edit`/`pm:remove` handlers,
* `component_geolocation.js`) and re-populates the two lists whenever the
* panel is currently visible — so a newly drawn object appears, and a
* deleted one's row disappears, without the user having to close and reopen
* the panel to notice.
*/



import {event_manager} from '../../../core/common/js/event_manager.js'
import {
	create_toolbar_button,
	create_toolbar_panel,
	set_toolbar_panel_visible,
	is_toolbar_panel_visible,
	remove_toolbar_button,
	remove_toolbar_panel
} from './toolbar.js'
import {commit, apply_display, ensure_properties} from './object_console.js'
import {render_object_viewer_panel, populate_object_viewer} from './render_object_viewer.js'



/**
* ATTACH_OBJECT_VIEWER
* Builds the "Objects" toggle button + panel (functionality #4 — see file
* header). Idempotent — a stray second call (e.g. a refresh) never attaches
* a duplicate control or panel. Content is NOT populated here — the panel is
* hidden by default and nothing reads it before the first open (same as
* every sibling panel: `map_image_download.js`/`capabilities_panel.js` never
* populate at attach time either); `toggle_object_viewer_panel` populates on
* the first and every subsequent SHOW.
*
* @param {Object} self - tool_uca_maps instance
* @returns {void}
*/
export const attach_object_viewer = function(self) {

	if (self.object_viewer_control || !self.geolocation || !self.geolocation.map) {
		return
	}

	self.object_viewer_control = create_toolbar_button(self, {
		title		: self.get_tool_label('object_viewer_control_title') || 'Objects',
		text		: 'OBJ',
		class_name	: 'uca-maps-object-viewer-control',
		on_click	: () => toggle_object_viewer_panel(self)
	})

	self.object_viewer_panel = create_toolbar_panel(self, {class_name: 'uca-maps-object-viewer-panel'})
	render_object_viewer_panel(self, self.object_viewer_panel)

	// live refresh while left open (file header) — self.events_tokens is
	// unsubscribed generically by common.prototype.destroy (tool_uca_maps.js
	// destroy()), same as object_console.js hydrate()'s own token
	const token = event_manager.subscribe(
		'updated_layer_data_' + self.geolocation.id_base,
		() => {
			if (is_toolbar_panel_visible(self.object_viewer_panel)) {
				populate_object_viewer(self, self.object_viewer_panel)
			}
		}
	)
	self.events_tokens = self.events_tokens || []
	self.events_tokens.push(token)

}//end attach_object_viewer



/**
* TOGGLE_OBJECT_VIEWER_PANEL
* Reads the panel's OWN current state (`is_toolbar_panel_visible`), never a
* cached flag — same reason as every other toggle_X in this tool (toolbar.js
* file header): a SIBLING panel opening (mutual exclusion) can close this
* one without going through this function at all.
*
* Rebuilds both lists every time the panel is about to SHOW — v6 does the
* same (`special_tools_objects.js` `create_containers`, called fresh from
* the control's own click handler, never cached): what is drawn can have
* changed since the last time this panel was open (a new geometry, a
* delete, a rename), so a stale list would be actively misleading rather
* than merely outdated.
*
* @param {Object} self - tool_uca_maps instance
* @returns {void}
*/
const toggle_object_viewer_panel = function(self) {

	const next_visible = !is_toolbar_panel_visible(self.object_viewer_panel)
	self.object_viewer_panel_visible = next_visible

	if (next_visible) {
		populate_object_viewer(self, self.object_viewer_panel)
	}

	set_toolbar_panel_visible(self, self.object_viewer_panel, self.object_viewer_control, next_visible)

}//end toggle_object_viewer_panel



/**
* DETACH_OBJECT_VIEWER
* Real teardown (CLAUDE.local.md "destrucción real") — called from
* `tool_uca_maps.prototype.destroy()` alongside the other `detach_*` calls.
*
* @param {Object} self - tool_uca_maps instance
* @returns {void}
*/
export const detach_object_viewer = function(self) {

	remove_toolbar_button(self, self.object_viewer_control)
	remove_toolbar_panel(self, self.object_viewer_panel)

	self.object_viewer_control			= null
	self.object_viewer_panel			= null
	self.object_viewer_panel_visible	= false

}//end detach_object_viewer



/**
* COLLECT_OBJECTS
* Walks the ACTIVE FeatureGroup only (file header — v6 parity) and splits
* its layers into the two v6 lists. `name` is a DISPLAY-ONLY fallback (file
* header — deliberately never written back to `properties`).
*
* @param {Object} self - tool_uca_maps instance
* @returns {{vector_objects: Array, raster_objects: Array}} each entry:
*   {layer, name: string, display: boolean}
*/
export const collect_objects = function(self) {

	const vector_objects	= []
	const raster_objects	= []

	const feature_group = self.geolocation && self.geolocation.FeatureGroup
		&& self.geolocation.FeatureGroup[self.geolocation.active_layer_id]

	if (!feature_group) {
		return {vector_objects, raster_objects}
	}

	feature_group.eachLayer((layer) => {

		const properties	= (layer.feature && layer.feature.properties) || {}
		const uca_maps		= properties.uca_maps || {}
		const name			= properties.name || properties.title
			|| (self.get_tool_label('object_viewer_nameless') || 'Untitled object')
		const display		= uca_maps.display!==false

		const entry = {layer, name, display}

		if (uca_maps.is_raster) {
			raster_objects.push(entry)
		} else {
			vector_objects.push(entry)
		}

	})

	return {vector_objects, raster_objects}
}//end collect_objects



/**
* SET_OBJECT_DISPLAY
* Show/Hide one object (functionality #4). Persists under
* `properties.uca_maps.display` (this tool's own namespace, same as
* style/hierarchy in `object_console.js`) and funnels through the shared
* `commit` — the ONE dirty/save-buffer entry point — so the change survives
* a reload/save exactly like every other 2b mutation.
*
* Takes the target `visible` state explicitly rather than inverting whatever
* is currently stored (review-diff robustness finding, hito 4): the caller
* (`render_object_viewer.js`'s checkbox `change` listener) already knows the
* checkbox's own new `.checked` value — reading THAT instead of re-deriving
* "not what was stored" means this can never desync from what the checkbox
* visually shows, even if a future partial re-render updates a row without
* rebuilding that exact checkbox (today's single full-panel rebuild-per-open
* makes the two agree by construction, but that is an implementation detail
* this function should not have to rely on).
*
* `ensure_properties` (not a bare `layer.feature && layer.feature.properties`
* read) because a shape drawn via Geoman but never yet clicked open in the
* "UCA" console has NO `.feature` at all — `init_feature`
* (`component_geolocation.js`) never assigns one; only the restore path
* (`L.geoJson`'s own `onEachFeature`, `load_layer`) does. A bare read here
* would silently no-op on exactly that object: the checkbox flips in the DOM
* but nothing is hidden or persisted, with no signal to the user (review-diff
* correctness finding, hito 4) — the same lazy seed every OTHER mutator in
* `object_console.js` already uses (`set_style_field`, `set_property`, …).
*
* @param {Object} self - tool_uca_maps instance
* @param {Object} layer - the Leaflet layer whose checkbox was toggled
* @param {boolean} visible - the checkbox's own new checked state
* @returns {void}
*/
export const set_object_display = function(self, layer, visible) {

	const properties = ensure_properties(layer)
	properties.uca_maps = properties.uca_maps || {}
	properties.uca_maps.display = visible

	apply_display(layer, visible)
	commit(self, layer)

}//end set_object_display



/**
* CENTER_ON_OBJECT
* Ported from v6's "eye" icon (`special_tools_objects.js` `load_modal`'s
* second click-delegation block, `icon_view_object`): a Marker centers with
* `setView` at zoom 16 (v6's own hardcoded level, kept identical); anything
* else fits the map to its bounds.
*
* MASKED, never a bare `map.setView`/`map.fitBounds` (review-diff
* correctness finding, hito 4): `component_geolocation.js`'s own
* dragend/zoomend listener (`fn_camera_sync`) writes whatever the map is
* currently showing into the record's lat/lon/zoom and marks it dirty,
* UNLESS `camera_is_moving===true` — the exact guard `move_camera`/
* `fit_camera_to_geometry` raise for every one of the core's OWN
* programmatic moves (CLAUDE.local.md "Tres leyes de component_geolocation":
* "camera_is_moving enmascara los movimientos programáticos"). Without this,
* clicking "Center" in this READ-ONLY panel — file header, "No edit
* affordance exists" — would silently mark the record dirty with an
* incidental camera position nobody asked to save.
*
* A Marker goes through `move_camera` itself — the single public door for a
* point move, already masked internally. There is no equivalent PUBLIC door
* for an ARBITRARY layer's bounds (`fit_camera_to_geometry` only fits the
* record's OWN stored geometry, keyed by data-entry index, not a specific
* clicked layer — `component_geolocation.js`) and core is out of this tool's
* editable surface (CLAUDE.local.md), so the bounds case raises/lowers
* `camera_is_moving` itself, mirroring `fit_camera_to_geometry`'s own
* try/finally exactly — INCLUDING `animate:false`, not a style choice: an
* animated `fitBounds` fires 'zoomend'/'moveend' ASYNCHRONOUSLY (Leaflet,
* ~250ms), i.e. AFTER this synchronous `finally` has already lowered
* `camera_is_moving` — `move_camera`'s own doc comment measured exactly this
* race for `setZoom`. Without `animate:false` the mask would already be gone
* by the time the core's dragend/zoomend listener actually runs, silently
* re-opening the same hole this fix closes.
*
* @param {Object} self - tool_uca_maps instance
* @param {Object} layer - the Leaflet layer to center on
* @returns {void}
*/
export const center_on_object = function(self, layer) {

	const geolocation = self.geolocation
	if (!geolocation || !geolocation.map) {
		return
	}

	if (layer instanceof L.Marker) {
		const latlng = layer.getLatLng()
		geolocation.move_camera(latlng.lat, latlng.lng, 16)
		return
	}

	if (typeof layer.getBounds!=='function') {
		return
	}

	geolocation.camera_is_moving = true
	try {
		geolocation.map.fitBounds(layer.getBounds(), {animate: false})
	} finally {
		geolocation.camera_is_moving = false
	}

}//end center_on_object



// @license-end
