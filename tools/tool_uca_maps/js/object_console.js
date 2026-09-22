// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global L, turf */
/*eslint no-undef: "error"*/



/**
* OBJECT_CONSOLE
*
* Hito 2 (plan_implementacion.md §4, functionality #3 of
* `docs/Funcionalidades de tool_leaflet_special_tools.md`): the per-object
* console. Checkpoint 2a scope (this file): anchor a persistent panel to the
* LIVE map, track which drawn geometry is currently selected, and keep that
* selection fresh across edits. Checkpoint 2b adds the object-specific
* functions (style/properties/download/centroid/uncertainty/hierarchy) on top
* of this same plumbing.
*
* ARCHITECTURE (see docs/hitos/hito_2.md for the full rationale): the tool
* opens `open_as: 'modal'`, and `<dd-modal>` mounts a full-viewport overlay
* that blocks clicks on the map underneath (`client/dedalo/core/common/js/ui.js`
* `attach_to_modal`) — incompatible with "click a geometry on the live map
* while the console is available". Sergio confirmed v6/dedalo6's own real
* behaviour: the tool modal loads and closes itself, leaving its tools
* anchored to the map. This module is what stays behind after that: attached
* directly to `self.geolocation.map`, independent of the modal's lifetime.
* tool_uca_maps.js wires the lifecycle split (on_close_actions keeps the
* instance alive; on_geolocation_destroyed is the real teardown).
*
* Selection tracking reuses the map's own 'popupopen' event rather than
* binding a second 'click' listener per layer: `component_geolocation.js`
* already calls `data_layer.bindPopup(...)` on every geometry — existing
* (via `load_layer`) AND newly drawn (via the `pm:create` handler in
* `init_draw_editor`) — so 'popupopen' on the map fires for exactly the same
* gesture, for every layer, with zero extra wiring into the core and zero
* risk of a second listener fighting the core's own click handler
* (pm.enable/disable in `init_feature`).
*
* Nothing here touches `client/dedalo/core/` — every hook used
* (`self.geolocation.map`, `.FeatureGroup`, `.get_popup_content`,
* `.update_draw_data`, the `updated_layer_data_<id_base>` event) is already
* public on the live instance.
*
* TOOLBAR REFACTOR (2026-09-04, before hito 4 — see CLAUDE.local.md "Left
* toolbar: un botón por funcionalidad"): the "UCA" button+panel built here
* used to also carry server capabilities and the map-image-download picker
* as collapsible sections. Sergio confirmed live that reads as an incorrect
* approach, not as "features still landing" — the audit lists 15 SEPARATE
* functionalities. This module now owns functionality #3 ONLY; the button/
* panel plumbing itself moved to `toolbar.js`, shared with every other
* functionality's own button+panel (map_image_download.js, capabilities_panel.js).
*/



import {event_manager} from '../../../core/common/js/event_manager.js'
import {response_data, request_failed, ApiError} from '../../../core/common/js/api_error.js'
import {handle_api_error} from '../../../core/common/js/error_dispatch.js'
import {render_console_panel, render_selected_object, render_placeholder} from './render_object_console.js'
import {
	create_toolbar_button,
	create_toolbar_panel,
	set_toolbar_panel_visible,
	is_toolbar_panel_visible,
	remove_toolbar_button,
	remove_toolbar_panel
} from './toolbar.js'



/** Property keys never offered through the generic custom-properties CRUD
* (`set_property`/`delete_property`, `render_object_console.js`'s properties
* editor): the core's own bookkeeping plus this tool's namespace.
*
* EXACTLY v6's own filter (`special_tools.js` `modal_properties`: `color` and
* `layer_id`; `uca_maps` is an object, which v6's own `typeof!=='object'`
* test drops anyway). `shape`/`radius` were reserved here too until
* 2026-09-21 — hito 2 chose a deliberately wider list; the functional audit
* reverted it, because in v6 the measurements ARE ordinary properties the
* user reads, edits and deletes, and that is the behaviour being ported.
* Deleting one is cosmetic in both engines: the core re-stamps `shape`/
* `radius` on the next `update_draw_data`, exactly as v6's own
* `create_div_radius` rewrote it on every click. */
export const RESERVED_PROPERTY_KEYS = ['color', 'layer_id', 'uca_maps']

/** v6's exact `get_incertidumbre` thresholds (`special_tools.js:397`), in m²
* as returned by `turf.area`. Ported verbatim. */
const UNCERTAINTY_TIERS = [1000, 10000, 100000, 1000000, 10000000]



/**
* ATTACH_CONSOLE
* Builds and anchors the console UI to the live map: a toggle button ("UCA",
* functionality #3 ONLY — see toolbar.js file header for why this button no
* longer also opens server capabilities or the map-image download picker)
* plus its own panel, both built through toolbar.js so this module owns
* nothing but functionality #3's own content. Idempotent — a stray second
* call (e.g. a refresh) never attaches a duplicate control or panel.
*
* @param {Object} self - tool_uca_maps instance
* @returns {void}
*/
export const attach_console = function(self) {

	if (self.map_control || !self.geolocation || !self.geolocation.map) {
		return
	}

	self.map_control = create_toolbar_button(self, {
		title		: self.get_tool_label('uca_maps_control_title') || 'UCA Maps',
		text		: 'UCA',
		class_name	: 'uca-maps-control',
		on_click	: () => toggle_panel(self)
	})

	self.panel_node = create_toolbar_panel(self, {class_name: 'uca-maps-console'})
	render_console_panel(self, self.panel_node)

	hydrate(self)

}//end attach_console



/**
* TOGGLE_PANEL
* Show/Hide — functionality #3 of the v6 audit is literally named that.
* Reads the panel's OWN current state (`is_toolbar_panel_visible`), never a
* cached flag: opening a SIBLING panel (toolbar.js's mutual-exclusion,
* 2026-09-04) can close this one without going through this module at all,
* so `self.console_visible` alone would desync (a stray click would then
* look like a no-op "hide" instead of the reopen the user asked for).
*
* @param {Object} self - tool_uca_maps instance
* @returns {void}
*/
export const toggle_panel = function(self) {
	set_panel_visibility(self, !is_toolbar_panel_visible(self.panel_node))
}//end toggle_panel



const set_panel_visibility = function(self, visible) {
	self.console_visible = visible
	if (self.panel_node) {
		set_toolbar_panel_visible(self, self.panel_node, self.map_control, visible)
	}
}//end set_panel_visibility



/**
* HYDRATE
* Subscribes the map-level events the console reacts to. Idempotent (guarded
* by `self._popupopen_handler`) so a stray second `attach_console` call never
* double-subscribes.
*
* - 'popupopen' — selection (see file header).
* - 'updated_layer_data_<id_base>' — already published by
*   `component_geolocation.prototype.update_draw_data` on every geometry
*   create/edit/style change; keeps an open console in sync with the object
*   it is currently showing without polling.
*
* @param {Object} self - tool_uca_maps instance
* @returns {void}
*/
const hydrate = function(self) {

	if (self._popupopen_handler) {
		return
	}

	self._popupopen_handler = (event) => {
		const layer = event.popup && event.popup._source
		if (layer) {
			select_layer(self, layer)
			// AFTER the core's own click sweep, never during it — see
			// is_geoman_edition/apply_geoman for why this cannot be
			// synchronous. Only objects with an explicit stored state move.
			self._geoman_reassert = setTimeout(() => reapply_geoman_all(self), 0)
		}
	}
	self.geolocation.map.on('popupopen', self._popupopen_handler)

	// 2b: re-apply this tool's own style/hierarchy extras — the core never
	// reads properties.uca_maps back on load, so this module has to
	// (plan hydration step 2; reapply_style/reapply_hierarchy above)
	self._pmcreate_handler = (event) => {
		if (event.layer) {
			reapply_style(event.layer)
			reapply_hierarchy(event.layer)
			apply_geoman(event.layer)
		}
	}
	self.geolocation.map.on('pm:create', self._pmcreate_handler)
	reapply_all(self)

	// 2b: react to a layer being deleted from the map (Geoman's own delete
	// tool) while this tool's panel is still showing it — without this, an
	// edit made afterwards on the now-gone layer is silently lost (commit()
	// can no longer resolve a FeatureGroup for it) and, if the removed layer
	// had a centroid, that marker is orphaned on the map permanently locked
	// against removal (created with preventMarkerRemoval:true — only
	// remove_centroid's own path, requiring the now-gone parent's checkbox,
	// ever unlocks it). Review-diff correctness finding, 2026-09-02.
	self._pmremove_handler = (event) => {
		const removed_layer = event.layer
		if (!removed_layer) {
			return
		}

		if (self.active_console_layer===removed_layer) {
			self.active_console_layer = null
			render_placeholder(self)
		}

		unlock_orphaned_centroid(self, removed_layer)
	}
	self.geolocation.map.on('pm:remove', self._pmremove_handler)

	const token = event_manager.subscribe(
		'updated_layer_data_' + self.geolocation.id_base,
		() => {
			reapply_all(self)
			if (self.active_console_layer) {
				render_selected_object(self, self.active_console_layer)
			}
		}
	)
	self.events_tokens = self.events_tokens || []
	self.events_tokens.push(token)

}//end hydrate



/**
* SELECT_LAYER
* Marks `layer` as the console's current subject and renders its object
* section — WITHOUT opening the panel.
*
* (!) Selecting is not opening (Sergio, 2026-09-21, functional audit). This
* used to call `set_panel_visibility(self, true)`, so any click on any
* geometry flung the console open — and, through toolbar.js's one-panel-at-a-
* time rule, shut whatever the user actually had open. v6 never did that
* either: its console is visible by default and toggled by its own
* "Mostrar-Ocultar" button (`special_tools.js` `special_tools_panel_show_hide_events`);
* a click on a layer only REPLACES the content. The panel is opened and
* closed by the UCA button, and by nothing else.
*
* @param {Object} self - tool_uca_maps instance
* @param {Object} layer - Leaflet layer (Marker/Circle/Polygon/Polyline)
* @returns {void}
*/
const select_layer = function(self, layer) {

	self.active_console_layer = layer
	render_selected_object(self, layer)

}//end select_layer



/**
* ENSURE_PROPERTIES
* `layer.feature.properties` exists on everything loaded through
* `load_layer`/created through `pm:create` (the core always calls
* `layer.toGeoJSON()` — component_geolocation.js — which seeds `.feature`),
* but a bare Leaflet layer built directly in this module (the centroid
* marker, below, before it is handed to `pm:create`) does not have one yet.
*
* Exported (hito 4) so `object_viewer.js`'s `set_object_display` seeds a
* freshly-drawn, never-yet-clicked layer the exact same way instead of
* silently no-oping on it — a shape created via Geoman's `pm:create` reaches
* this module with NO `.feature` at all (`init_feature`,
* `component_geolocation.js`, never assigns one; only `L.geoJson`'s own
* `onEachFeature` — the `load_layer`/restore path — does), so a checkbox
* toggled before the object is ever opened in the "UCA" console needs this
* same lazy seed, not a second, weaker guard (review-diff correctness
* finding, hito 4).
*
* @param {Object} layer
* @returns {Object} layer.feature.properties, created if missing
*/
export const ensure_properties = function(layer) {
	layer.feature				= layer.feature || layer.toGeoJSON()
	layer.feature.properties	= layer.feature.properties || {}
	return layer.feature.properties
}//end ensure_properties



/**
* ENSURE_UID
* Lazily assigns a random per-OBJECT id under `properties.uca_maps.uid` the
* first time this console needs to cross-reference one Leaflet layer from
* another (centroid <-> parent, below). Necessary because the core's own
* `layer_id` identifies a whole FeatureGroup, not a single object —
* `update_draw_data(layer_id)` serialises EVERY layer currently in
* `self.FeatureGroup[layer_id]` as one FeatureCollection
* (`component_geolocation.js`, confirmed by reading its body: `active_layer.
* eachLayer(...)` pushes one GeoJSON feature per layer into the SAME
* layer_id's `features` array) — so two distinct shapes (a polygon and its
* centroid marker) can share one `layer_id` and need their own identity.
* Mirrors v6's own `tools_id` (`special_tools.js` `make_id(20)`), same
* purpose, ported rather than reused (v6's in-memory registry is gone).
*
* Exported (hito 7) so `onexone.js`'s `create_onexone_rectangle` links a
* marker to its newly-created 1x1 rectangle the exact same way toggle_centroid
* links a parent to its centroid, below — one uid scheme, not two.
*
* @param {Object} layer
* @returns {string}
*/
export const ensure_uid = function(layer) {
	const properties	= ensure_properties(layer)
	properties.uca_maps	= properties.uca_maps || {}
	if (!properties.uca_maps.uid) {
		properties.uca_maps.uid = Math.random().toString(36).slice(2) + Date.now().toString(36)
	}
	return properties.uca_maps.uid
}//end ensure_uid



/**
* COMMIT
* The one path every 2b mutation funnels through (plan_implementacion.md:
* "toda mutación de la consola termina en update_draw_data"): marks the
* owning FeatureGroup dirty via the core's own `update_draw_data` — the ONLY
* dirty/save-buffer entry point (CLAUDE.local.md "nada auto-guarda": this
* marks the record dirty, it never talks to the server itself — only the
* component's own save button commits) — then re-renders the panel so the
* just-made change is visible immediately, without waiting for the next
* `updated_layer_data_<id_base>` event `hydrate()` already listens for
* (that listener also calls render_selected_object, redundantly but
* harmlessly, once update_draw_data's own publish arrives).
*
* (!) If `layer` is no longer registered in any FeatureGroup — e.g. it was
* removed from the map via Geoman's own delete tool while this tool's panel
* was still open and still showing it as `active_console_layer` — the
* mutation stays written into `layer.feature.properties` in memory but there
* is no dirty/save-buffer entry point left to funnel it through, so it is
* effectively lost. `hydrate()`'s own `pm:remove` listener (below) reacts to
* the removal itself and clears a stale selection before this can normally
* happen; this `console.warn` is the last-resort surfaced signal for
* whatever narrower race it does not cover (review-diff correctness finding,
* 2026-09-02 — silent data loss with no user-visible signal was the defect).
*
* Exported (hito 4) so `object_viewer.js`'s `set_object_display` — a
* separate button+panel, not part of this console — funnels through the
* exact same dirty/save-buffer entry point rather than duplicating it.
*
* @param {Object} self - tool_uca_maps instance
* @param {Object} layer - the mutated Leaflet layer
* @returns {void}
*/
export const commit = function(self, layer) {
	mark_dirty(self, layer)
	if (self.active_console_layer===layer) {
		render_selected_object(self, layer)
	}
}//end commit



/**
* MARK_DIRTY
* `commit()` without the re-render — the half a writer that runs DURING a
* render needs (`sync_measurements`, below). Re-rendering from inside the
* render that called it would recurse; the `updated_layer_data_<id_base>`
* event `update_draw_data` publishes repaints the panel anyway.
*
* @param {Object} self
* @param {Object} layer
* @returns {void}
*/
const mark_dirty = function(self, layer) {
	const layer_id = find_layer_id(self, layer)
	if (layer_id!==null) {
		self.geolocation.update_draw_data(layer_id)
	} else {
		console.warn(
			'tool_uca_maps: commit() could not resolve a FeatureGroup for this layer — '
			+ 'the change was applied in memory only and was NOT marked dirty (the layer may '
			+ 'have been removed from the map).',
			layer
		)
	}
}//end mark_dirty



/**
* SYNC_MEASUREMENTS
* Writes the geometry's own measurement into `feature.properties` so it
* shows up — editable and deletable — in the properties list, which is what
* v6 does (`special_tools.js` `create_div_radius`/`create_div_circle_area`/
* `create_div_polygon_area`, each `properties.<key> = …; save_object()`).
* Ported 2026-09-21 (functional audit).
*
* Only `area` is written here. `shape` and `radius` are NOT: the core
* already stamps both on every `update_draw_data`
* (`component_geolocation.js`, "GeoJSON has no native circle type"), and
* since `layer.toGeoJSON()` shallow-copies the feature, that stamp lands on
* this very `properties` object. Writing a FORMATTED radius on top of the
* core's NUMBER would make the two writers overwrite each other on every
* pass — a dirty loop, not a disagreement about style.
*
* The value is the one the panel prints, deliberately: for a circle both
* come from `2·π·r` — the CIRCUMFERENCE, labelled "Area", wrong in v6
* (`special_tools.js:5690`) and wrong the same way in the core's own popup
* (`component_geolocation.js` `get_popup_content`). Fixing it here alone
* would make the property disagree with the popup the user reads on the same
* object; the formula is the core's to fix (audit ledger + PREGUNTAS_FORO).
*
* Dirty is marked ONLY when the value actually changed, so merely selecting
* an object does not dirty a record the user has not touched (the same
* criterion hito 16 applied to elevation) and the re-render the event
* triggers finds nothing to write and stops.
*
* @param {Object} self
* @param {Object} layer
* @returns {boolean} true when something was written
*/
export const sync_measurements = function(self, layer) {

	let value = null

	if (layer instanceof L.Circle) {
		value = (2 * Math.PI * layer.getRadius()).toFixed(2) + ' m'
	} else if (layer instanceof L.Polygon) {
		value = format_polygon_area(turf.area(layer.toGeoJSON()))
	} else {
		return false
	}

	const properties = ensure_properties(layer)
	if (properties.area===value) {
		return false
	}

	properties.area = value
	mark_dirty(self, layer)

	return true
}//end sync_measurements



/**
* SET_STYLE_FIELD
* Fill colour/opacity, stroke weight/opacity/dash — every style field
* except the object's COLOUR, which is half the core's and is written by
* `set_object_color` below. Stored under
* `properties.uca_maps.style` (this tool's own namespace — the core never
* reads fill/opacity/weight back on load, so re-applying it after every map
* load is this tool's own job; see `hydrate()`/`reapply_style` below) and
* applied immediately via `layer.setStyle` so the map reflects the change
* without waiting for a reload.
*
* @param {Object} self
* @param {Object} layer
* @param {'fillColor'|'fillOpacity'|'weight'|'opacity'|'dashArray'} field
* @param {string|number|null} value - null/'' clears the field
* @returns {void}
*/
export const set_style_field = function(self, layer, field, value) {

	const properties	= ensure_properties(layer)
	properties.uca_maps	= properties.uca_maps || {}
	const style			= properties.uca_maps.style = properties.uca_maps.style || {}

	if (value===null || value==='') {
		delete style[field]
	} else {
		style[field] = value
	}

	if (typeof layer.setStyle==='function') {
		layer.setStyle(style)
	}

	commit(self, layer)
}//end set_style_field



/**
* SET_OBJECT_COLOR
* ONE colour for border and body, as v6 paints them (`special_tools.js`
* `polygon_circle_style`), and the only style value with a split home. The
* STROKE half is the core's: `update_draw_data` copies `layer.options.color`
* into `properties.color` and `init_feature` re-applies it on load
* (`component_geolocation.js`), so storing it here too would give one value
* two homes, free to disagree. The FILL half nobody restores but this tool,
* so that one is written into its own namespace.
*
* @param {Object} self
* @param {Object} layer
* @param {string} value - '#rrggbb'
* @returns {void}
*/
export const set_object_color = function(self, layer, value) {

	if (!value || typeof layer.setStyle!=='function') {
		return
	}

	const properties	= ensure_properties(layer)
	properties.uca_maps	= properties.uca_maps || {}
	const style			= properties.uca_maps.style = properties.uca_maps.style || {}
	style.fillColor		= value

	layer.setStyle({color: value, fillColor: value})

	commit(self, layer)
}//end set_object_color



/**
* REAPPLY_STYLE
* Re-applies a previously saved `properties.uca_maps.style` to a layer just
* loaded/created — the core's own `load_layer`/`init_feature` only re-apply
* `color` (plan_implementacion.md), never this tool's own fill/opacity/
* weight extras, so this module has to do it itself on every hydration
* pass. Called from `hydrate()`'s FeatureGroup walk, below.
*
* @param {Object} layer
* @returns {void}
*/
const reapply_style = function(layer) {
	const properties	= layer.feature && layer.feature.properties
	const style			= properties && properties.uca_maps && properties.uca_maps.style
	if (style && typeof layer.setStyle==='function') {
		layer.setStyle(style)
	}
}//end reapply_style



/**
* REAPPLY_HIERARCHY
* Ports v6's `check_hierarchy` (`special_tools.js:5467`) — runs on every
* layer load, not just on click, so a saved front/back state visually
* persists across map reloads even before the layer is ever clicked again.
* Order (`bringToBack` before `bringToFront`) matches v6 verbatim; harmless
* either way since `set_hierarchy` never leaves both flags true.
*
* @param {Object} layer
* @returns {void}
*/
const reapply_hierarchy = function(layer) {
	const properties	= layer.feature && layer.feature.properties
	const hierarchy		= properties && properties.uca_maps && properties.uca_maps.hierarchy
	if (!hierarchy) {
		return
	}
	if (hierarchy.bringToBack && typeof layer.bringToBack==='function') {
		layer.bringToBack()
	}
	if (hierarchy.bringToFront && typeof layer.bringToFront==='function') {
		layer.bringToFront()
	}
}//end reapply_hierarchy



/**
* IS_GEOMAN_EDITION / SET_GEOMAN_EDITION / REAPPLY_GEOMAN
* v6's "Edición Geoman activa" checkbox, per object
* (`special_tools.js` `create_div_geoman_edition_mode`, `pm_enable`,
* `pm_disable`, `check_geoman_edition_mode`, `feature.special_tools.
* geoman_edition`). Ported 2026-09-21 (functional audit; H-01 in the
* ledger, which hito 2 had left out of scope).
*
* (!) THIS FIGHTS THE CORE, AND HAS TO. The core has no per-object notion of
* editability: its own click handler (`component_geolocation.js`
* `init_feature`) calls `pm.enable()` on EVERY layer of the clicked
* FeatureGroup and `pm.disable()` on every layer of all the others. That
* handler is registered after `bindPopup`'s, so it runs AFTER the
* 'popupopen' this module selects on — a state written from here during the
* same click would be overwritten microseconds later. Hence the deferred
* re-assert in `hydrate()`: the stored per-object state is re-applied once
* the core's own sweep has finished.
*
* Only an object with an EXPLICITLY stored flag is re-asserted. An object
* nobody has ticked keeps the core's behaviour untouched — porting v6's
* "default false" literally would silently kill the edit handles every user
* of every map gets today on a plain click, which is a change to the core's
* feel, not to this tool's.
*
* v6's own `pm_disable` is `pm.enable({allowEditing:false, draggable:false…})`
* rather than `pm.disable()`; this port uses `pm.disable()`, the same call
* the core uses for the same intent.
*
* @param {Object} layer
* @returns {boolean}
*/
export const is_geoman_edition = function(layer) {
	const properties = layer && layer.feature && layer.feature.properties
	const uca_maps = properties && properties.uca_maps
	return Boolean(uca_maps && uca_maps.geoman_edition)
}//end is_geoman_edition


/**
* @param {Object} layer
* @returns {boolean} true when the object carries an explicit stored state
*/
export const has_geoman_edition = function(layer) {
	const properties = layer && layer.feature && layer.feature.properties
	const uca_maps = properties && properties.uca_maps
	return Boolean(uca_maps && typeof uca_maps.geoman_edition==='boolean')
}//end has_geoman_edition


/**
* @param {Object} self
* @param {Object} layer
* @param {boolean} enabled
* @returns {void}
*/
export const set_geoman_edition = function(self, layer, enabled) {

	const properties	= ensure_properties(layer)
	properties.uca_maps	= properties.uca_maps || {}
	properties.uca_maps.geoman_edition = Boolean(enabled)

	apply_geoman(layer)

	commit(self, layer)
}//end set_geoman_edition


/**
* @param {Object} layer
* @returns {void}
*/
const apply_geoman = function(layer) {

	if (!has_geoman_edition(layer) || !layer.pm) {
		return
	}

	if (is_geoman_edition(layer)) {
		if (typeof layer.pm.enable==='function') {
			layer.pm.enable({
				allowSelfIntersection	: true,
				allowEditing			: true,
				draggable				: true,
				snappable				: true
			})
		}
	} else if (typeof layer.pm.disable==='function') {
		layer.pm.disable()
	}
}//end apply_geoman


/**
* REAPPLY_GEOMAN_ALL
* Re-asserts every stored per-object state across every FeatureGroup. Called
* from `reapply_all` (load/hydration) and, deferred, after each click.
*
* @param {Object} self
* @returns {void}
*/
const reapply_geoman_all = function(self) {
	const feature_groups = self.geolocation && self.geolocation.FeatureGroup
	if (!feature_groups) {
		return
	}
	for (const layer_id in feature_groups) {
		feature_groups[layer_id].eachLayer(apply_geoman)
	}
}//end reapply_geoman_all



/**
* APPLY_DISPLAY
* Show/Hide for one object (hito 4, functionality #4 — `object_viewer.js`).
* Raw DOM visibility toggle, ported from v6's own mechanism
* (`special_tools_objects.js` `load_modal`'s click handler:
* `layer._path.style.display`/`layer._icon.style.display`) rather than
* `map.removeLayer`/`addLayer` — the layer must STAY registered in its
* FeatureGroup (Geoman's own edit/delete tools, `find_layer_id`,
* `update_draw_data`'s own FeatureGroup walk all assume it is); only its
* rendered DOM node hides. Exported for `object_viewer.js`'s
* `set_object_display`; also used below by `reapply_display` so a hidden
* state survives a map reload.
*
* @param {Object} layer
* @param {boolean} visible
* @returns {void}
*/
export const apply_display = function(layer, visible) {

	// An uploaded image (hito 13) is TWO nodes: the transparent carrier
	// rectangle that takes the clicks, and the overlay that shows the
	// picture. Hiding only the carrier would leave the image fully painted
	// and no longer selectable — worse than not hiding it at all. Reached as
	// a plain property on the layer, never by importing `image_upload.js`:
	// that module already imports THIS one, and the pair must stay
	// one-directional (same convention as render_X.js/X.js).
	const overlay = layer._uca_maps_overlay
	if (overlay) {
		set_node_display(overlay._image, visible)
	}

	// and its drag handles, when edit mode is on (hito 14): they are markers on
	// the map, so hiding the picture without them would leave three circles
	// floating over nothing — still draggable, still moving an invisible image
	for (const handle of (layer._uca_maps_handles || [])) {
		set_node_display(handle._icon, visible)
		set_node_display(handle._shadow, visible)
	}

	if (layer instanceof L.Marker) {
		set_node_display(layer._icon, visible)
		set_node_display(layer._shadow, visible)
		return
	}

	set_node_display(layer._path, visible)

}//end apply_display



/**
* SET_NODE_DISPLAY
* One node's worth of `apply_display`'s raw style toggle — a Marker touches
* two DOM nodes (icon/shadow), everything else touches one (`_path`); this
* is the single place that decides how to fail safe on either.
*
* @param {HTMLElement|null|undefined} node
* @param {boolean} visible
* @returns {void}
*/
const set_node_display = function(node, visible) {
	try {
		if (node) {
			node.style.display = visible ? '' : 'none'
		}
	} catch (e) {}
}//end set_node_display



/**
* REAPPLY_DISPLAY
* A layer freshly loaded/rebuilt from `layer_data` starts visible — this
* only has work to do when a previous session left it explicitly hidden
* (`properties.uca_maps.display===false`, `object_viewer.js`
* `set_object_display`). Called from `reapply_all`, same reason as
* `reapply_style`/`reapply_hierarchy` above.
*
* @param {Object} layer
* @returns {void}
*/
const reapply_display = function(layer) {
	const properties	= layer.feature && layer.feature.properties
	const uca_maps		= properties && properties.uca_maps
	if (uca_maps && uca_maps.display===false) {
		apply_display(layer, false)
	}
}//end reapply_display



/**
* REAPPLY_ALL
* Walks every layer in every FeatureGroup and re-applies both 2b
* reapplication steps (plus hito 4's display state). Called once from
* `hydrate()` (attach time) and again on every `updated_layer_data_<id_base>`
* event, matching the plan's hydration step 2
* (`~/.claude/plans/ancient-watching-turing.md`).
*
* @param {Object} self
* @returns {void}
*/
const reapply_all = function(self) {
	const feature_groups = self.geolocation && self.geolocation.FeatureGroup
	if (!feature_groups) {
		return
	}
	for (const layer_id in feature_groups) {
		feature_groups[layer_id].eachLayer((layer) => {
			reapply_style(layer)
			reapply_hierarchy(layer)
			reapply_display(layer)
			apply_geoman(layer)
		})
	}
}//end reapply_all



/**
* SET_PROPERTY / DELETE_PROPERTY
* Generic custom-properties CRUD over `layer.feature.properties`, guarded
* against the reserved keys (RESERVED_PROPERTY_KEYS, above) so a user can
* never shadow a core- or tool-managed field through this editor. No server
* round-trip (plan_implementacion.md: v6's own `create_property`/
* `edit_property` were already pure client-side validators before this
* port; the plan drops the server actions, not the behaviour).
*
* @param {Object} self
* @param {Object} layer
* @param {string} key
* @param {string} value
* @returns {boolean} false if key was empty/reserved (nothing written)
*/
export const set_property = function(self, layer, key, value) {

	key = String(key || '').trim()
	if (!key || RESERVED_PROPERTY_KEYS.includes(key)) {
		return false
	}

	const properties = ensure_properties(layer)
	properties[key] = value

	commit(self, layer)
	return true
}//end set_property

export const delete_property = function(self, layer, key) {

	if (RESERVED_PROPERTY_KEYS.includes(key)) {
		return
	}

	const properties = ensure_properties(layer)
	delete properties[key]

	commit(self, layer)
}//end delete_property



/**
* TRIGGER_BLOB_DOWNLOAD
* Shared anchor-click download idiom (hito 2b's original `download_geojson`
* body) — every vector format ends here, whether the Blob was built locally
* (GeoJSON) or decoded from the server's base64 response (SHP/KML, hito 3).
* Exported (hito 3b): `map_image_download.js` reuses it for the same reason —
* one download trigger, not two copies.
*
* @param {Blob} blob
* @param {string} filename
* @returns {void}
*/
export const trigger_blob_download = function(blob, filename) {

	const url		= URL.createObjectURL(blob)

	const link		= document.createElement('a')
	link.href		= url
	link.download	= filename
	document.body.appendChild(link)
	link.click()
	link.remove()
	URL.revokeObjectURL(url)
}//end trigger_blob_download



/**
* BASE64_TO_BLOB
* Decodes a base64 string (as returned by the `vector_download`/
* `raster_download` server actions) into a Blob — no server-generated file
* ever touches a publicly-servable path (v6 wrote to a web-exposed
* `downloads/` folder and handed back a URL; this tool has no server route of
* its own to serve one from — CLAUDE.local.md surface rule — so the bytes
* travel inside the API envelope instead).
*
* Manual `atob()`/`charCodeAt()` loop, NOT `fetch('data:...')` — review-diff
* (hito 3b) suggested `fetch()` as the browser's own bulk decoder instead of
* a per-character loop, and it was tried: **it fails for real**, silently, in
* THIS app. The server's CSP (`src/core/api/static_asset.ts` `APP_CSP`)
* declares `connect-src 'self' blob:` — no `data:` scheme — and Chrome
* classifies a `fetch()` of a `data:` URL as a `connect-src` check, so the
* fetch rejects under the real policy (confirmed live: every `test:client`
* download assertion failed with a null Blob after switching to `fetch()`,
* passed again on revert). Loosening `connect-src` is a core-file, app-wide
* security policy edit — outside this encargo's surface (CLAUDE.local.md) —
* so the loop stays. Kept synchronous on purpose (every caller `await`s it
* regardless; `await` on a non-Promise is a no-op, so this cannot regress if
* a future fix finds a CSP-safe bulk path).
*
* Exported (hito 3b): `map_image_download.js` reuses it for `raster_download`'s
* response the same way.
*
* @param {string} base64
* @param {string} mime
* @returns {Blob}
*/
export const base64_to_blob = function(base64, mime) {

	const binary	= atob(base64)
	const bytes		= new Uint8Array(binary.length)

	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i)
	}

	return new Blob([bytes], {type: mime})
}//end base64_to_blob



/**
* REPORT_CLIENT_ERROR
* Surfaces a THROWN client-side exception (never reached the server, so
* there is no envelope for `handle_api_error` to read) through the SAME
* global toast surface every server-reported failure uses:
* `event_manager.publish('api_error', …)`, subscribed once in `page.js`
* (`api_error_handler`) — the identical mechanism `data_manager.js`'s own
* transport-layer failures publish through. `code` is namespaced `client.*`
* on purpose — `ApiError`'s own constructor already treats that prefix as
* the client-origin signal (`this.transport = … : code.startsWith('client.')`)
* — and falls through `error_policy.js`'s `'*'` wildcard to a plain toast, so
* nothing needs registering for it.
*
* @param {string} message
* @returns {void}
*/
export const report_client_error = function(message) {
	event_manager.publish('api_error', new ApiError({
		code		: 'client.tool_uca_maps_failed',
		message		: message,
		source		: 'client',
		// NOT a transport (network/CSRF/retry) failure — the `client.` prefix
		// defaults `transport` to true, which is the wrong default for "a
		// screenshot capture or a decode threw", so it is overridden explicitly.
		transport	: false
	}))
}//end report_client_error



/**
* DOWNLOAD_VECTOR
* GeoJSON stays 100% client-side (`layer.toGeoJSON()` + Blob, hito 2b's
* original behaviour, unchanged — no server round-trip for the format the
* browser already produces natively). SHP/KML (hito 3) call the server's
* `vector_download` action: `ogr2ogr` runs server-side (GDAL is not a browser
* capability), the result comes back base64 in the envelope, decoded into a
* Blob and downloaded the same way.
*
* No client-side reprojection (v6 pre-reprojected to EPSG:3857 by hand with
* `turf.toMercator` before sending — the resulting GeoJSON was no longer
* valid WGS84 per RFC 7946). `layer.toGeoJSON()` is already valid WGS84; it
* travels as-is, and the server assigns `-a_srs EPSG:4326` — an accurate
* label for data already in that CRS, not a reprojection.
*
* Never silent (review-diff correctness finding, hito 3): a server-reported
* failure (GDAL missing, permission denied, …) goes through the project's own
* `handle_api_error` — the same call every other tool makes on a failed
* `tool_request` (e.g. `tool_media_versions`/`tool_time_machine`). The WHOLE
* function body (including `layer.toGeoJSON()` — review-diff finding, hito
* 3b: an earlier revision called it BEFORE the try block, so a throw there
* was not caught by this function's own handling) runs inside one try/catch;
* an unexpected client-side exception goes through `report_client_error`
* instead of only `console.error` (review-diff finding, hito 3b: the
* original catch only logged, contradicting this very doc comment) — never
* an unhandled promise rejection from the caller's un-awaited click handler
* (`render_object_console.js`), and never a silent no-op either.
*
* @param {Object} self - tool_uca_maps instance
* @param {Object} layer
* @param {'geojson'|'shp'|'kml'} format
* @returns {Promise<void>}
*/
export const download_vector = async function(self, layer, format) {

	try {

		const geojson = layer.toGeoJSON()

		if (format==='geojson') {
			const blob = new Blob([JSON.stringify(geojson, null, 2)], {type: 'application/geo+json'})
			trigger_blob_download(blob, 'uca_maps_object.geojson')
			return
		}

		const response = await self.tool_request({
			action	: 'vector_download',
			options	: {
				tipo			: self.geolocation.tipo,
				section_id		: self.geolocation.section_id,
				section_tipo	: self.geolocation.section_tipo,
				format			: format,
				geojson			: geojson
			}
		})

		const data = response_data(response)

		if (!data) {
			await handle_api_error(response.error, {})
			return
		}

		const {content_base64, filename, mime} = data
		trigger_blob_download(await base64_to_blob(content_base64, mime), filename)

	} catch (error) {
		console.error('tool_uca_maps: vector_download failed unexpectedly', error)
		report_client_error((error && error.message) || 'Vector download failed')
	}
}//end download_vector


/**
* DOWNLOAD_OBJECT_PDF
* Fila #3's "Exportar como PDF": the selected object's properties, geometry
* and associated images as one document, built by the server
* (`server/pdf_report.ts` — and see its header for why it is not built in the
* browser the way v6 does it).
*
* What travels: the object as GeoJSON (same as `download_vector`), the image
* RECORD IDENTITIES — never their paths, which is what stops the report from
* becoming a way to read media the caller has no right to — the elevation
* already on screen, and the tool's own labels, so the document speaks the
* language of the record rather than the server's default.
*
* @param {Object} self - tool_uca_maps instance
* @param {Object} layer
* @returns {Promise<void>}
*/
export const download_object_pdf = async function(self, layer) {

	try {

		const geojson	= layer.toGeoJSON()
		const cached	= self._elevation
		const elevation	= (cached && cached.layer===layer && typeof cached.elevation==='number')
			? cached.elevation
			: null

		const images = self.object_images(layer).map(function(image) {
			return {
				section_tipo	: image.section_tipo,
				section_id		: image.section_id,
				tipo			: image.tipo,
				name			: image.name
			}
		})

		const response = await self.tool_request({
			action	: 'object_pdf_report',
			options	: {
				tipo			: self.geolocation.tipo,
				section_id		: self.geolocation.section_id,
				section_tipo	: self.geolocation.section_tipo,
				geojson			: geojson,
				images			: images,
				elevation		: elevation,
				labels			: {
					title			: self.get_tool_label('pdf_title'),
					geometry		: self.get_tool_label('pdf_geometry'),
					type			: self.get_tool_label('pdf_type'),
					images			: self.get_tool_label('object_images_title'),
					elevation		: self.get_tool_label('elevation'),
					no_properties	: self.get_tool_label('pdf_no_properties'),
					image_missing	: self.get_tool_label('pdf_image_missing'),
					image_format	: self.get_tool_label('pdf_image_format'),
					image_forbidden	: self.get_tool_label('pdf_image_forbidden')
				}
			}
		})

		const data = response_data(response)
		if (!data) {
			await handle_api_error(response.error, {})
			return
		}

		trigger_blob_download(await base64_to_blob(data.content_base64, data.mime), data.filename)

	} catch (error) {
		console.error('tool_uca_maps: object_pdf_report failed unexpectedly', error)
		report_client_error((error && error.message) || 'PDF export failed')
	}
}//end download_object_pdf



/**
* TOGGLE_CENTROID
* v6 (`special_tools.js` `create_div_centroid`): checking the box creates a
* marker at the layer's bounds center and fires it through the core's OWN
* creation pipeline (`map.fire('pm:create', ...)`,
* `component_geolocation.js init_draw_editor`'s `pm:create` handler —
* `e.layer.addTo(self.FeatureGroup[self.active_layer_id])` +
* `update_draw_data` + `init_feature`), rather than adding it to a
* FeatureGroup directly — so the new marker gets the exact same click/popup
* wiring as any user-drawn shape, for free. `active_layer_id` is set
* explicitly first: it is normally set by the core's own click handler on
* the layer the user just clicked, which IS this layer by the time a
* checkbox inside its already-open console is clicked — but setting it here
* removes any dependency on that ordering.
*
* Only offered for circle/polygon (`render_hierarchy`... see
* render_object_console.js `render_centroid_control` — `getBounds` is what
* both have and markers/polylines conceptually don't need here, matching
* v6: `create_div_centroid` is only ever called from the circle and polygon
* branches of v6's `set_info_console`).
*
* @param {Object} self
* @param {Object} layer - the circle/polygon layer (never the centroid itself)
* @returns {void}
*/
export const toggle_centroid = function(self, layer) {

	const properties	= ensure_properties(layer)
	properties.uca_maps	= properties.uca_maps || {}

	if (properties.uca_maps.centroid_uid) {
		remove_centroid(self, layer)
		return
	}

	if (typeof layer.getBounds!=='function') {
		return
	}

	const layer_id = find_layer_id(self, layer)
	if (layer_id===null) {
		return
	}

	const parent_uid	= ensure_uid(layer)
	const center		= layer.getBounds().getCenter()
	const marker		= L.marker(center)

	marker.feature				= marker.toGeoJSON()
	marker.feature.properties	= marker.feature.properties || {}
	marker.feature.properties.uca_maps = {
		uid			: Math.random().toString(36).slice(2) + Date.now().toString(36),
		centroid_of	: parent_uid
	}

	self.geolocation.active_layer_id = layer_id
	self.geolocation.map.fire('pm:create', {layer: marker})

	if (marker.pm) {
		marker.pm.setOptions({preventMarkerRemoval: true, allowRemoval: false})
	}

	properties.uca_maps.centroid_uid = marker.feature.properties.uca_maps.uid
	commit(self, layer)
}//end toggle_centroid



/**
* REMOVE_CENTROID
* Unchecking the centroid box (`toggle_centroid`, above). v6 used
* `centroid.pm.remove()` alone (its own per-object FeatureGroup model made
* that sufficient); this tool's FeatureGroups can hold several features
* (file header of `ensure_uid`), so removal goes through the owning
* FeatureGroup directly — `removeLayer` — which is the more correct
* operation for that data model, not a v6 behaviour being changed.
*
* @param {Object} self
* @param {Object} layer - the parent circle/polygon layer
* @returns {void}
*/
const remove_centroid = function(self, layer) {

	const properties	= ensure_properties(layer)
	const centroid_uid	= properties.uca_maps && properties.uca_maps.centroid_uid
	if (!centroid_uid) {
		return
	}

	const layer_id		= find_layer_id(self, layer)
	const feature_group	= layer_id!==null ? self.geolocation.FeatureGroup[layer_id] : null

	if (feature_group) {
		const centroid_layer = feature_group.getLayers().find((candidate) => {
			const candidate_properties = candidate.feature && candidate.feature.properties
			return Boolean(
				candidate_properties
				&& candidate_properties.uca_maps
				&& candidate_properties.uca_maps.uid===centroid_uid
			)
		})
		if (centroid_layer) {
			if (centroid_layer.pm) {
				centroid_layer.pm.setOptions({preventMarkerRemoval: false, allowRemoval: true})
			}
			feature_group.removeLayer(centroid_layer)
		}
	}

	delete properties.uca_maps.centroid_uid
	commit(self, layer)
}//end remove_centroid



/**
* UNLOCK_ORPHANED_CENTROID
* Reacts to a PARENT layer (circle/polygon) being removed from the map by
* some path OTHER than this tool's own `remove_centroid` above — typically
* Geoman's own delete tool — while it still had a centroid marker. That
* marker was created with `preventMarkerRemoval:true`/`allowRemoval:false`
* (`toggle_centroid`) — `remove_centroid` is the only path that ever unlocks
* it, and it never runs here (nobody unchecked a checkbox; the parent is
* just gone) — so without this, the marker would be left on the map forever
* locked against removal. Called from `hydrate()`'s `pm:remove` handler for
* EVERY removed layer; a no-op unless that layer's own
* `properties.uca_maps.centroid_uid` says it had one (review-diff
* correctness finding, 2026-09-02).
*
* @param {Object} self
* @param {Object} removed_layer - the layer Geoman just removed
* @returns {void}
*/
const unlock_orphaned_centroid = function(self, removed_layer) {

	const properties	= removed_layer.feature && removed_layer.feature.properties
	const centroid_uid	= properties && properties.uca_maps && properties.uca_maps.centroid_uid
	if (!centroid_uid || !self.geolocation || !self.geolocation.FeatureGroup) {
		return
	}

	for (const layer_id in self.geolocation.FeatureGroup) {
		const feature_group	= self.geolocation.FeatureGroup[layer_id]
		const centroid_layer	= feature_group.getLayers().find((candidate) => {
			const candidate_properties = candidate.feature && candidate.feature.properties
			return Boolean(
				candidate_properties
				&& candidate_properties.uca_maps
				&& candidate_properties.uca_maps.uid===centroid_uid
			)
		})
		if (centroid_layer) {
			if (centroid_layer.pm) {
				centroid_layer.pm.setOptions({preventMarkerRemoval: false, allowRemoval: true})
			}
			feature_group.removeLayer(centroid_layer)
			return
		}
	}
}//end unlock_orphaned_centroid



/**
* GET_UNCERTAINTY
* Ports v6's `special_tools.js` `get_incertidumbre` exactly, INCLUDING its
* confirmed bug (plan_implementacion.md hito 2, Sergio's decision
* 2026-09-02: preserve byte-parity) — `value` stores `1/area`, not `area`,
* despite the ' m²' suffix implying otherwise. Do not "fix" this.
*
* @param {number} area_m2 - `turf.area(layer.toGeoJSON())` result
* @returns {{scale_tier: number, value: string}}
*/
const get_uncertainty = function(area_m2) {

	let scale_tier = UNCERTAINTY_TIERS.length + 1
	for (let i=0; i<UNCERTAINTY_TIERS.length; i++) {
		if (area_m2<=UNCERTAINTY_TIERS[i]) {
			scale_tier = i + 1
			break
		}
	}

	return {
		scale_tier	: scale_tier,
		value		: (1 / area_m2).toFixed(20) + ' m²' // (!) bug preserved verbatim from v6 — see file header
	}
}//end get_uncertainty



/**
* TOGGLE_UNCERTAINTY
* Polygon only — matches v6 exactly (`create_div_incertidumbre` is only
* ever called from the polygon branch of `set_info_console`; circles use a
* different, non-`turf.area`-based measure and never got this checkbox).
*
* @param {Object} self
* @param {Object} layer - polygon layer
* @returns {void}
*/
export const toggle_uncertainty = function(self, layer) {

	const properties	= ensure_properties(layer)
	properties.uca_maps	= properties.uca_maps || {}

	if (properties.uca_maps.uncertainty) {
		delete properties.uca_maps.uncertainty
		commit(self, layer)
		return
	}

	const area_m2 = turf.area(layer.toGeoJSON())
	properties.uca_maps.uncertainty = get_uncertainty(area_m2)
	commit(self, layer)
}//end toggle_uncertainty



/**
* SET_HIERARCHY
* Ports v6's `special_tools.js` `create_div_hierarchy` click handlers
* exactly, INCLUDING the confirmed bug (Sergio's decision, 2026-09-02):
* unchecking either box calls the OPPOSITE `bringTo*()` — a visible jump
* straight to the other end, never back to a neutral z-order — WITHOUT
* setting that opposite box's own flag true. So after a reload the
* checkboxes can show NEITHER box checked despite the layer having visually
* jumped to front/back. Do not "fix" this (preserve the exact asymmetry).
*
* Circle/polygon/polyline only — matches v6 (`create_div_hierarchy` is
* never called from the marker branch of `set_info_console`).
*
* @param {Object} self
* @param {Object} layer
* @param {'front'|'back'} edge - which checkbox was clicked
* @param {boolean} checked - the checkbox's new checked state
* @returns {void}
*/
export const set_hierarchy = function(self, layer, edge, checked) {

	const properties	= ensure_properties(layer)
	properties.uca_maps	= properties.uca_maps || {}
	const hierarchy		= properties.uca_maps.hierarchy = properties.uca_maps.hierarchy || {}

	if (edge==='back') {
		if (checked) {
			hierarchy.bringToBack	= true
			hierarchy.bringToFront	= false
			layer.bringToBack()
		} else {
			hierarchy.bringToBack = false // (!) bringToFront NOT set true — bug preserved, file header
			layer.bringToFront()
		}
	} else {
		if (checked) {
			hierarchy.bringToFront	= true
			hierarchy.bringToBack	= false
			layer.bringToFront()
		} else {
			hierarchy.bringToFront = false // (!) bringToBack NOT set true — bug preserved, file header
			layer.bringToBack()
		}
	}

	commit(self, layer)
}//end set_hierarchy



/**
* COMPUTE_INFO
* Mirrors component_geolocation.prototype.get_popup_content's OWN math
* (v7's native popup, `client/dedalo/core/component_geolocation/js/component_geolocation.js:1781-1866`)
* — NOT v6's `special_tools.js` — so this panel's numbers always match what
* the native Leaflet popup already shows for the very same layer on the
* very same click, rather than a second, possibly-diverging set of
* formulas. `get_popup_content` itself is not reused directly because it
* also builds the colour-picker widget this panel deliberately does not
* duplicate (already free via that native popup, plan_implementacion.md).
*
* Circle "area" is deliberately labelled `Area` (not `Circumference`)
* despite being `2*Math.PI*radius` (a circumference, not an area) — this
* mislabelling already exists in v7's OWN core (`get_popup_content`,
* line ~1804), out of scope here (client/dedalo/core/), and showing a
* different label in this panel for the same layer/same click would just
* be a second, contradictory answer next to the native popup's.
*
* Polygon area does NOT reuse the core's private `readable_area`
* (`component_geolocation.js:2592`, not exported) verbatim: that helper has
* its own separate, already-documented pre-existing bug (metric branch
* < 10,000 m² leaves its result `undefined` — a core defect, not part of
* this port, out of scope to fix in `client/dedalo/core/`) — `format_polygon_area`
* below matches its thresholds/precision with that one branch actually
* assigned.
*
* @param {Object} self
* @param {Object} layer
* @returns {{label: string, value: string}|null}
*/
export const compute_info = function(self, layer) {

	const geolocation = self.geolocation

	if (layer instanceof L.Marker) {
		return {label_key: 'coordinates', label: 'Coordinates', value: geolocation.str_lat_lng(layer.getLatLng())}
	}

	if (layer instanceof L.Circle) {
		const center	= layer.getLatLng()
		const radius	= layer.getRadius()
		const area		= (2 * Math.PI * radius).toFixed(2) // matches get_popup_content verbatim — file header
		return {
			label_key	: 'center_radius_area',
			label		: 'Center / Radius / Area',
			value		: geolocation.str_lat_lng(center) + ' · ' + geolocation.round_coordinate(radius, 2) + ' m · ' + area + ' m'
		}
	}

	if (layer instanceof L.Polygon) {
		const area_m2 = turf.area(layer.toGeoJSON())
		return {label_key: 'area', label: 'Area', value: format_polygon_area(area_m2)}
	}

	if (layer instanceof L.Polyline) {
		const latlngs = layer.getLatLngs()
		let distance = 0
		for (let i=0; i<latlngs.length-1; i++) {
			distance += latlngs[i].distanceTo(latlngs[i+1])
		}
		return {label_key: 'distance', label: 'Distance', value: geolocation.round_coordinate(distance, 2) + ' m'}
	}

	return null
}//end compute_info


/**
* LAYER_CENTER
* The point an elevation is asked about: a marker's own position, anything
* else's bounds centre — v6 verbatim (`special_tools.js` `create_div_elevation`,
* which prints a different label for each of the two cases).
*
* @param {Object} layer
* @returns {Object|null} L.LatLng
*/
export const layer_center = function(layer) {

	if (!layer) {
		return null
	}
	if (layer instanceof L.Marker) {
		return layer.getLatLng()
	}
	if (typeof layer.getBounds!=='function') {
		return null
	}
	const bounds = layer.getBounds()

	return (bounds && bounds.isValid()) ? bounds.getCenter() : null
}//end layer_center



/**
* FETCH_ELEVATION
* Asks the server for the elevation of the selected object's centre
* (`server/elevation.ts` — the outbound call is the server's, as it already
* is in v6).
*
* WHAT IT DOES NOT DO: persist. v6 writes the answer into
* `feature.properties.center_elevation` and calls `save_object()` right there
* — so merely CLICKING an object dirties the record. That contradicts this
* tool's own law ("nada auto-guarda: un gesto marca dirty, solo el botón
* commitea", CLAUDE.local.md), and it stores derived third-party data as if
* the user had typed it. Here the elevation is DISPLAYED and handed to the
* PDF export in memory; if the user wants it stored, the properties editor
* right below already adds any key they like.
*
* Never throws: the caller is a render path, and a service outage must not
* stop the console from opening (see the server module's header).
*
* @param {Object} self - tool_uca_maps instance
* @param {Object} layer
* @returns {Promise<{elevation: number|null, unavailable: boolean}>}
*/
export const fetch_elevation = async function(self, layer) {

	const center = layer_center(layer)
	if (!center) {
		return {elevation: null, unavailable: true}
	}

	// THE CACHE IS NOT AN OPTIMISATION, it is what stops a public service being
	// hammered during ordinary editing. `render_selected_object` rebuilds the
	// whole object section, and `commit()` calls it after EVERY mutation —
	// each style field, property edit, property delete, centroid/uncertainty/
	// hierarchy toggle, image associate and image remove — on top of the
	// `updated_layer_data_*` re-render. Without this, editing five properties
	// on one polygon fires ~10 outbound requests about a centre that never
	// moved, and Open-Elevation rate-limits until the line reads "not
	// available" (review finding, hito 16).
	// Keyed on the layer AND the coordinates, so MOVING a shape does re-ask.
	const cache_key = center.lat + ',' + center.lng
	const cached = self._elevation
	if (cached && cached.layer===layer && cached.key===cache_key) {
		return {elevation: cached.elevation, unavailable: cached.elevation===null}
	}

	try {

		const response = await self.tool_request({
			action	: 'get_elevation',
			options	: {
				tipo			: self.geolocation.tipo,
				section_id		: self.geolocation.section_id,
				section_tipo	: self.geolocation.section_tipo,
				lat				: center.lat,
				lon				: center.lng
			}
		})

		if (request_failed(response)) {
			return {elevation: null, unavailable: true}
		}

		const data = response_data(response)

		const result = (data && typeof data.elevation==='number')
			? {elevation: data.elevation, unavailable: false}
			: {elevation: null, unavailable: true}

		// remembered for the re-render guard above AND for the PDF export, which
		// must print the number the user is LOOKING AT — asking the service a
		// second time could legitimately answer differently and make the
		// document disagree with the panel
		self._elevation = {layer: layer, key: cache_key, elevation: result.elevation}

		return result

	} catch (error) {
		console.error('tool_uca_maps: get_elevation failed unexpectedly', error)
		return {elevation: null, unavailable: true}
	}
}//end fetch_elevation



const format_polygon_area = function(area_m2) {
	if (area_m2>=1000000) {
		return Math.round((area_m2 / 1000000) * 100) / 100 + ' km²'
	}
	if (area_m2>=10000) {
		return Math.round((area_m2 / 10000) * 100) / 100 + ' ha'
	}
	return area_m2.toFixed(2) + ' m²'
}//end format_polygon_area



/**
* FIND_LAYER_ID
* Resolves which FeatureGroup (`self.geolocation.FeatureGroup[layer_id]`)
* owns `layer`. Deliberately NOT read from `self.geolocation.active_layer_id`
* — that value is set by the core's own click handler
* (`init_feature`, `component_geolocation.js`), which is registered AFTER
* `bindPopup`'s own click-to-open handler on the same layer, so at the exact
* moment 'popupopen' fires for a click, `active_layer_id` can still be
* holding the PREVIOUSLY clicked layer's id. Searching FeatureGroup directly
* has no such ordering dependency.
*
* @param {Object} self - tool_uca_maps instance
* @param {Object} layer - Leaflet layer to locate
* @returns {number|null} the owning layer_id, or null if not found
*/
export const find_layer_id = function(self, layer) {

	const feature_group = self.geolocation && self.geolocation.FeatureGroup
	if (!feature_group) {
		return null
	}

	for (const layer_id in feature_group) {
		if (feature_group[layer_id].hasLayer(layer)) {
			return Number(layer_id)
		}
	}


	return null
}//end find_layer_id



/**
* DETACH_CONSOLE
* Real teardown (CLAUDE.local.md "destrucción real") — called from
* tool_uca_maps.prototype.destroy(), itself only reached from
* on_geolocation_destroyed() (see file header: the console outlives the
* modal, never the map). Guarded throughout: the map may already be gone if
* component_geolocation was destroyed first, in which case its whole DOM
* subtree — including panel_node, appended as its child — is already gone
* too, so skipping the explicit removal here is correct, not a leak.
*
* @param {Object} self - tool_uca_maps instance
* @returns {void}
*/
export const detach_console = function(self) {

	if (self.geolocation && self.geolocation.map) {

		if (self._popupopen_handler) {
			try {
				self.geolocation.map.off('popupopen', self._popupopen_handler)
			} catch (error) {
				console.warn('tool_uca_maps detach_console: error removing popupopen listener', error)
			}
		}

		if (self._pmcreate_handler) {
			try {
				self.geolocation.map.off('pm:create', self._pmcreate_handler)
			} catch (error) {
				console.warn('tool_uca_maps detach_console: error removing pm:create listener', error)
			}
		}

		if (self._pmremove_handler) {
			try {
				self.geolocation.map.off('pm:remove', self._pmremove_handler)
			} catch (error) {
				console.warn('tool_uca_maps detach_console: error removing pm:remove listener', error)
			}
		}
	}

	// the deferred geoman re-assert may still be queued — a timer that fires
	// after teardown would touch a map this tool no longer owns
	if (self._geoman_reassert) {
		clearTimeout(self._geoman_reassert)
		self._geoman_reassert = null
	}

	remove_toolbar_button(self, self.map_control)
	remove_toolbar_panel(self, self.panel_node)

	self.map_control			= null
	self.panel_node				= null
	self._popupopen_handler	= null
	self._pmcreate_handler		= null
	self._pmremove_handler		= null
	self.active_console_layer	= null
	self.console_visible		= false

}//end detach_console



// @license-end
