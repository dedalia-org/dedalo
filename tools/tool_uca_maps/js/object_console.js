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
*/



import {event_manager} from '../../../core/common/js/event_manager.js'
import {render_console_panel, render_selected_object, render_placeholder} from './render_object_console.js'



/** Property keys the CORE already manages on every feature
* (`component_geolocation.prototype.update_draw_data`, which additively
* stamps `layer_id`/`color`, plus `shape`/`radius` for circles) or that this
* tool itself owns (`uca_maps`, below) — never offered through the generic
* custom-properties CRUD in checkpoint 2b (`set_property`/`delete_property`,
* `render_object_console.js`'s properties editor). v6's own equivalent loop
* (`special_tools.js` `modal_properties`) only excludes `color`/`layer_id`;
* this list is deliberately more complete — a fresh CRUD UI we are building,
* not a literal port of that DOM, so there is no v6 behaviour to preserve
* here (unlike the uncertainty/hierarchy bugs below, which ARE preserved). */
export const RESERVED_PROPERTY_KEYS = ['color', 'layer_id', 'shape', 'radius', 'uca_maps']

/** v6's exact `get_incertidumbre` thresholds (`special_tools.js:397`), in m²
* as returned by `turf.area`. Ported verbatim. */
const UNCERTAINTY_TIERS = [1000, 10000, 100000, 1000000, 10000000]



/**
* ATTACH_CONSOLE
* Builds and anchors the console UI to the live map: a toggle control (this
* tool's existing hito-1 `L.Control`, now wired to show/hide the panel) plus
* the panel itself, appended directly to the map's own DOM container so it
* can hold arbitrary interactive content without fighting Leaflet's
* control-corner layout. Idempotent — a stray second call (e.g. a refresh)
* never attaches a duplicate control or panel.
*
* @param {Object} self - tool_uca_maps instance
* @returns {void}
*/
export const attach_console = function(self) {

	if (self.map_control || !self.geolocation || !self.geolocation.map) {
		return
	}

	// toggle control — 'topleft' matches v6's own special_tools control
	// position exactly (`render_tool_leaflet_special_tools.js`, `special_tools_options
	// = {position: "topleft"}`); 'topright' collides with Geoman's own drawing
	// toolbar, which component_geolocation already anchors there
	// (`component_geolocation.js` `map.pm.addControls({position: 'topright', ...})`) —
	// confirmed live by Sergio during 2a validation (2026-09-02): the UCA control
	// was sitting on top of the default draw icons.
		const UcaMapsControl = L.Control.extend({
			options : { position: 'topleft' },
			onAdd : function() {
				const container = L.DomUtil.create('div', 'leaflet-bar uca-maps-control')
				container.title		= self.get_tool_label('uca_maps_control_title') || 'UCA Maps'
				container.textContent	= 'UCA'
				container.addEventListener('click', () => toggle_panel(self))
				// prevent map drag/zoom/click from reaching the map through this control
				L.DomEvent.disableClickPropagation(container)
				L.DomEvent.disableScrollPropagation(container)
				return container
			}
		})

		self.map_control = new UcaMapsControl()
		self.map_control.addTo(self.geolocation.map)

	// panel — plain DOM overlay, not another L.Control (see file header).
	// (!) Unlike an L.Control (which Leaflet wraps with this same guard
	// automatically via its container), a bare div appended straight to the
	// map container needs it applied explicitly — missing here in 2a is why
	// dragging anything inside the panel (confirmed live: the opacity range
	// slider's thumb) panned the MAP instead of moving the control, because
	// the mousedown/touchstart bubbled up to Leaflet's own drag handler.
		self.panel_node = render_console_panel(self)
		L.DomEvent.disableClickPropagation(self.panel_node)
		L.DomEvent.disableScrollPropagation(self.panel_node)
		self.geolocation.map.getContainer().appendChild(self.panel_node)
		set_panel_visibility(self, false)

	hydrate(self)

}//end attach_console



/**
* TOGGLE_PANEL
* Show/Hide — functionality #3 of the v6 audit is literally named that.
*
* @param {Object} self - tool_uca_maps instance
* @returns {void}
*/
export const toggle_panel = function(self) {
	set_panel_visibility(self, !self.console_visible)
}//end toggle_panel



const set_panel_visibility = function(self, visible) {
	self.console_visible = visible
	if (self.panel_node) {
		self.panel_node.hidden = !visible
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
* Marks `layer` as the console's current subject, reveals the panel, and
* renders its object section. 2a shows geometry type + the FeatureGroup id
* it belongs to only — style/properties/download/centroid/uncertainty/
* hierarchy land in 2b, over this same selection.
*
* @param {Object} self - tool_uca_maps instance
* @param {Object} layer - Leaflet layer (Marker/Circle/Polygon/Polyline)
* @returns {void}
*/
const select_layer = function(self, layer) {

	self.active_console_layer = layer
	set_panel_visibility(self, true)
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
* @param {Object} layer
* @returns {Object} layer.feature.properties, created if missing
*/
const ensure_properties = function(layer) {
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
* @param {Object} layer
* @returns {string}
*/
const ensure_uid = function(layer) {
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
* @param {Object} self - tool_uca_maps instance
* @param {Object} layer - the mutated Leaflet layer
* @returns {void}
*/
const commit = function(self, layer) {
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
	if (self.active_console_layer===layer) {
		render_selected_object(self, layer)
	}
}//end commit



/**
* SET_STYLE_FIELD
* Fill colour/opacity/stroke weight — deliberately NOT stroke colour, which
* the core's own popup already edits for free via `render_color_picker` +
* `properties.color` (plan_implementacion.md: "el color de trazo YA
* funciona gratis vía el popup nativo del núcleo"). Stored under
* `properties.uca_maps.style` (this tool's own namespace — the core never
* reads fill/opacity/weight back on load, so re-applying it after every map
* load is this tool's own job; see `hydrate()`/`reapply_style` below) and
* applied immediately via `layer.setStyle` so the map reflects the change
* without waiting for a reload.
*
* @param {Object} self
* @param {Object} layer
* @param {'fillColor'|'fillOpacity'|'weight'} field
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
* REAPPLY_ALL
* Walks every layer in every FeatureGroup and re-applies both 2b
* reapplication steps. Called once from `hydrate()` (attach time) and again
* on every `updated_layer_data_<id_base>` event, matching the plan's
* hydration step 2 (`~/.claude/plans/ancient-watching-turing.md`).
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
* DOWNLOAD_GEOJSON
* Client-side only (plan_implementacion.md: "descarga: solo GeoJSON,
* layer.toGeoJSON() cliente, Blob download" — SHP/KML need the server's
* `ogr2ogr`, hito 3's `vector_download` action, not yet built).
*
* @param {Object} layer
* @returns {void}
*/
export const download_geojson = function(layer) {

	const geojson	= layer.toGeoJSON()
	const blob		= new Blob([JSON.stringify(geojson, null, 2)], {type: 'application/geo+json'})
	const url		= URL.createObjectURL(blob)

	const link		= document.createElement('a')
	link.href		= url
	link.download	= 'uca_maps_object.geojson'
	document.body.appendChild(link)
	link.click()
	link.remove()
	URL.revokeObjectURL(url)
}//end download_geojson



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

		if (self.map_control) {
			try {
				self.geolocation.map.removeControl(self.map_control)
			} catch (error) {
				console.warn('tool_uca_maps detach_console: error removing map control', error)
			}
		}

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

	if (self.panel_node && self.panel_node.parentNode) {
		self.panel_node.parentNode.removeChild(self.panel_node)
	}

	self.map_control			= null
	self.panel_node				= null
	self._popupopen_handler	= null
	self._pmcreate_handler		= null
	self._pmremove_handler		= null
	self.active_console_layer	= null
	self.console_visible		= false

}//end detach_console



// @license-end
