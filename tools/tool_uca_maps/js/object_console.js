// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global L, turf */
/*eslint no-undef: "error"*/



/**
* OBJECT_CONSOLE
* The per-object console ("UCA" button + panel), anchored to the LIVE map so it
* outlives the transient modal. Selection rides the map's 'popupopen': the core
* already binds a popup to every geometry, so no second click listener fights
* its own (`init_feature`).
*/



import {event_manager} from '../../../core/common/js/event_manager.js'
import {response_data, request_failed, ApiError} from '../../../core/common/js/api_error.js'
import {exception_text, tool_error_text} from './tool_error_text.js'
import {render_console_panel, render_selected_object, render_placeholder} from './render_object_console.js'
import {is_onexone_rectangle} from './onexone_flags.js'
import {read_uca_maps} from './uca_maps_data.js'
import {
	create_toolbar_button,
	create_toolbar_panel,
	set_toolbar_panel_visible,
	is_toolbar_panel_visible,
	remove_toolbar_button,
	remove_toolbar_panel
} from './toolbar.js'



/** Keys the custom-properties editor never offers: v6's own filter
* (`special_tools.js` `modal_properties`: `color`, `layer_id`) plus this tool's
* namespace. `shape`/`radius` stay editable as in v6; the core re-stamps both on
* the next `update_draw_data`. */
export const RESERVED_PROPERTY_KEYS = ['color', 'layer_id', 'uca_maps']

/** v6's `get_incertidumbre` thresholds (`special_tools.js`), in m² as returned by
* `turf.area`. */
const UNCERTAINTY_TIERS = [1000, 10000, 100000, 1000000, 10000000]



/**
* ATTACH_CONSOLE
* Builds the "UCA" toolbar button and its panel (toolbar.js) on the live map.
* Idempotent: a stray second call (e.g. a refresh) attaches no duplicate.
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
		icon		: 'info',
		class_name	: 'uca-maps-control',
		on_click	: () => toggle_panel(self)
	})

	self.panel_node = create_toolbar_panel(self, {class_name: 'uca-maps-console'})
	render_console_panel(self, self.panel_node)

	hydrate(self)

}//end attach_console



/**
* TOGGLE_PANEL
* Reads the panel's own state (`is_toolbar_panel_visible`), never a cached flag:
* opening a sibling panel closes this one without passing through here.
*
* @param {Object} self - tool_uca_maps instance
* @returns {void}
*/
const toggle_panel = function(self) {
	if (self.panel_node) {
		set_toolbar_panel_visible(self, self.panel_node, self.map_control, !is_toolbar_panel_visible(self.panel_node))
	}
}//end toggle_panel



/**
* HYDRATE
* Subscribes the map events the console reacts to; idempotent (guarded by
* `self._popupopen_handler`). 'updated_layer_data_<id_base>', published by the
* core's `update_draw_data` on every change, keeps an open console in sync.
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
			schedule_geoman_reassert(self)
		}
	}
	self.geolocation.map.on('popupopen', self._popupopen_handler)

	// A second click on a marker closes its popup (no 'popupopen') yet the core
	// sweep still enables it; 'popupclose' fires before that sweep, so a deferred
	// re-assert lands after it. LOCK-ONLY: a click on the empty map closes a
	// popup too, and there the core turns editing off for all.
	self._popupclose_handler = () => schedule_geoman_reassert(self, true)
	self.geolocation.map.on('popupclose', self._popupclose_handler)

	// the core never reads properties.uca_maps back on load, so new geometry gets
	// this tool's extras here (reapply_style/reapply_hierarchy, below)
	self._pmcreate_handler = (event) => {
		if (event.layer) {
			default_geoman_off(self, event.layer)
			reapply_style(event.layer)
			reapply_hierarchy(event.layer)
			apply_geoman(event.layer)
		}
	}
	self.geolocation.map.on('pm:create', self._pmcreate_handler)
	reapply_all(self)

	// Geoman's own delete tool can remove the layer the panel shows: clear the
	// selection (a later edit on it would be lost) and unlock its centroid, which
	// only remove_centroid would otherwise ever unlock.
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
* Marks `layer` as the console's subject and renders it, WITHOUT opening the
* panel: as in v6 (`special_tools.js` `special_tools_panel_show_hide_events`), a
* click replaces the content; only the UCA button opens or closes the panel.
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
* Layers built here (the centroid marker) or drawn through Geoman's `pm:create`
* have no `.feature` yet; only the core's `load_layer` path seeds one. Exported so
* object_viewer.js seeds a never-clicked layer the same way.
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
* ENSURE_UCA_MAPS
* `ensure_properties` plus this tool's own namespace under it — the seed
* every writer of `properties.uca_maps` needs first.
*
* @param {Object} layer
* @returns {Object} layer.feature.properties.uca_maps, created if missing
*/
export const ensure_uca_maps = function(layer) {
	const properties	= ensure_properties(layer)
	properties.uca_maps	= properties.uca_maps || {}
	return properties.uca_maps
}//end ensure_uca_maps



/**
* ENSURE_UID
* Lazily assigns a per-OBJECT id under `properties.uca_maps.uid`: the core's
* `layer_id` names a whole FeatureGroup, which can hold several shapes (a polygon
* and its centroid). v6's `tools_id` (`special_tools.js` `make_id`). Exported so
* onexone.js links a marker to its 1x1 rectangle with the same scheme.
*
* @param {Object} layer
* @returns {string}
*/
export const ensure_uid = function(layer) {
	const uca_maps = ensure_uca_maps(layer)
	if (!uca_maps.uid) {
		uca_maps.uid = Math.random().toString(36).slice(2) + Date.now().toString(36)
	}
	return uca_maps.uid
}//end ensure_uid



/**
* COMMIT
* The one path every console mutation takes: marks the owning FeatureGroup dirty
* through the core's `update_draw_data` (nothing auto-saves; only the component's
* save button commits), then re-renders the panel at once. Exported so
* object_viewer.js's set_object_display marks dirty the same way.
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
* CIRCLE_MEASURE
* The one copy of the core popup's circle "area" (`2·π·r`, see
* `sync_measurements`), so the property and the console cannot disagree.
*
* @param {Object} layer - L.Circle
* @returns {string} two decimals, no unit
*/
const circle_measure = function(layer) {
	return (2 * Math.PI * layer.getRadius()).toFixed(2)
}//end circle_measure



/**
* SYNC_MEASUREMENTS
* Writes the geometry's `area` as an editable property, as v6 does (`special_tools.js`
* `create_div_circle_area`/`create_div_polygon_area`), and resyncs a checked
* uncertainty. Not `shape`/`radius`: the core stamps those, and two writers would
* loop. Dirty only on a real change, so merely selecting an object dirties nothing.
*
* @param {Object} self
* @param {Object} layer
* @returns {boolean} true when something was written
*/
export const sync_measurements = function(self, layer) {

	let value					= null
	let uncertainty_changed	= false

	if (layer instanceof L.Circle) {
		value = circle_measure(layer) + ' m'
	} else if (layer instanceof L.Polygon) {
		if (is_onexone_rectangle(layer)) {
			return false // v6 saves no area for a 1x1 — see compute_info
		}
		const area_m2		= turf.area(layer.toGeoJSON())
		value				= format_polygon_area(area_m2)
		uncertainty_changed	= sync_uncertainty(layer, area_m2)
	} else {
		return false
	}

	const properties	= ensure_properties(layer)
	const area_changed	= properties.area!==value
	if (!area_changed && !uncertainty_changed) {
		return false
	}

	properties.area = value
	mark_dirty(self, layer)

	return true
}//end sync_measurements



/**
* SYNC_UNCERTAINTY
* Recomputes a CHECKED uncertainty from the current geometry. "Changed" is
* judged by the tier and the area as printed, the criterion `properties.area`
* uses: a float jitter below what the console shows must not dirty a record
* the user has not touched.
*
* @param {Object} layer - polygon layer
* @param {number} area_m2 - `turf.area(layer.toGeoJSON())` result
* @returns {boolean} true when the stored uncertainty was rewritten
*/
const sync_uncertainty = function(layer, area_m2) {

	const uca_maps	= read_uca_maps(layer)
	const stored	= uca_maps && uca_maps.uncertainty
	if (!stored) {
		return false
	}

	const current = get_uncertainty(area_m2)
	if (
		stored.scale_tier===current.scale_tier
		&& typeof stored.area_m2==='number'
		&& format_polygon_area(stored.area_m2)===format_polygon_area(current.area_m2)
	) {
		return false
	}

	uca_maps.uncertainty = current

	return true
}//end sync_uncertainty



/**
* SET_STYLE_FIELD
* Every style field but the colour (`set_object_color`). Stored under
* `properties.uca_maps.style` because the core never restores them on load
* (`reapply_style` does), and applied at once with `layer.setStyle`.
*
* @param {Object} self
* @param {Object} layer
* @param {'fillColor'|'fillOpacity'|'weight'|'opacity'|'dashArray'} field
* @param {string|number|null} value - null/'' clears the field
* @returns {void}
*/
export const set_style_field = function(self, layer, field, value) {

	const uca_maps	= ensure_uca_maps(layer)
	uca_maps.style	= uca_maps.style || {}
	const style		= uca_maps.style

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
* One colour for border and body, as v6 paints them (`special_tools.js`
* `polygon_circle_style`). The stroke half is the core's (`properties.color`,
* restored by `init_feature`), so only the fill half goes in this namespace: one
* value, one home.
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

	const uca_maps	= ensure_uca_maps(layer)
	uca_maps.style	= uca_maps.style || {}
	const style		= uca_maps.style
	style.fillColor	= value

	layer.setStyle({color: value, fillColor: value})

	commit(self, layer)
}//end set_object_color



/**
* REAPPLY_STYLE
* Re-applies a saved `properties.uca_maps.style`: the core's `load_layer`/
* `init_feature` restore only `color`.
*
* @param {Object} layer
* @returns {void}
*/
const reapply_style = function(layer) {
	const uca_maps	= read_uca_maps(layer)
	const style		= uca_maps && uca_maps.style
	if (style && typeof layer.setStyle==='function') {
		layer.setStyle(style)
	}
}//end reapply_style



/**
* REAPPLY_HIERARCHY
* v6's `check_hierarchy` (`special_tools.js`), run on every load so a saved
* front/back order survives a reload before the layer is clicked again.
*
* @param {Object} layer
* @returns {void}
*/
const reapply_hierarchy = function(layer) {
	const uca_maps	= read_uca_maps(layer)
	const hierarchy	= uca_maps && uca_maps.hierarchy
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
* v6's per-object "Edición Geoman activa" checkbox (`special_tools.js`
* `create_div_geoman_edition_mode`). The core's click handler enables every layer
* of the clicked group AFTER 'popupopen', hence the deferred re-assert in hydrate().
* Only an explicit stored flag is re-asserted: untouched objects keep the core's.
*
* @param {Object} layer
* @returns {boolean}
*/
export const is_geoman_edition = function(layer) {
	const uca_maps = read_uca_maps(layer)
	return Boolean(uca_maps && uca_maps.geoman_edition)
}//end is_geoman_edition


/**
* @param {Object} layer
* @returns {boolean} true when the object carries an explicit stored state
*/
export const has_geoman_edition = function(layer) {
	const uca_maps = read_uca_maps(layer)
	return Boolean(uca_maps && typeof uca_maps.geoman_edition==='boolean')
}//end has_geoman_edition


/**
* @param {Object} self
* @param {Object} layer
* @param {boolean} enabled
* @returns {void}
*/
export const set_geoman_edition = function(self, layer, enabled) {

	ensure_uca_maps(layer).geoman_edition = Boolean(enabled)

	apply_geoman(layer)

	commit(self, layer)
}//end set_geoman_edition


/**
* @param {Object} layer
* @param {boolean} [lock_only=false] - only take edit mode OFF where the stored
*   state says off; never turn it on
* @returns {void}
*/
const apply_geoman = function(layer, lock_only=false) {

	if (!has_geoman_edition(layer) || !layer.pm) {
		return
	}

	// (!) NEVER RE-ASSERT A STATE THAT ALREADY HOLDS. `pm.disable()` fires
	// `pm:edit`, the core turns it into `update_draw_data`, whose event lands back
	// here: an endless loop of `get_elevation` requests.
	const enabled = typeof layer.pm.enabled==='function' ? layer.pm.enabled() : null

	if (is_geoman_edition(layer)) {
		if (!lock_only && enabled!==true && typeof layer.pm.enable==='function') {
			layer.pm.enable({
				allowSelfIntersection	: true,
				allowEditing			: true,
				draggable				: true,
				snappable				: true
			})
		}
	} else if (enabled!==false && typeof layer.pm.disable==='function') {
		layer.pm.disable()
	}
}//end apply_geoman


/**
* DEFAULT_GEOMAN_OFF
* A just-created geometry is born with edit handles OFF and says so, v6's default
* (`special_tools_onexone.js`, `check_geoman_edition_mode`). Only at creation, so
* existing objects keep the core's behaviour. Markers have no vertex handles; an
* image carrier is sealed by image_edit.js.
*
* @param {Object} self
* @param {Object} layer
* @returns {void}
*/
const default_geoman_off = function(self, layer) {

	if (layer instanceof L.Marker || has_geoman_edition(layer)) {
		return
	}

	const uca_maps = ensure_uca_maps(layer)
	if (uca_maps.image) {
		return
	}

	uca_maps.geoman_edition = false

	mark_dirty(self, layer)
}//end default_geoman_off



/**
* REAPPLY_GEOMAN_ALL
* Re-asserts every stored per-object state across every FeatureGroup. Called
* from `reapply_all` (load/hydration) and, deferred, after each click.
*
* @param {Object} self
* @param {boolean} [lock_only=false] - see `apply_geoman`
* @returns {void}
*/
const reapply_geoman_all = function(self, lock_only=false) {
	const feature_groups = self.geolocation && self.geolocation.FeatureGroup
	if (!feature_groups) {
		return
	}
	for (const layer_id in feature_groups) {
		feature_groups[layer_id].eachLayer((layer) => apply_geoman(layer, lock_only))
	}
}//end reapply_geoman_all


/**
* SCHEDULE_GEOMAN_REASSERT
* One pending re-assert at a time: one click can fire both 'popupclose' and
* 'popupopen', and teardown can only cancel the timer it still holds. A full
* pass replaces a pending lock-only one; a lock-only request leaves any pending
* pass alone, since every pass locks.
*
* @param {Object} self
* @param {boolean} [lock_only=false] - see `apply_geoman`
* @returns {void}
*/
const schedule_geoman_reassert = function(self, lock_only=false) {
	if (self._geoman_reassert) {
		if (lock_only) {
			return
		}
		clearTimeout(self._geoman_reassert)
	}
	self._geoman_reassert = setTimeout(() => {
		self._geoman_reassert = null
		reapply_geoman_all(self, lock_only)
	}, 0)
}//end schedule_geoman_reassert



/**
* APPLY_DISPLAY
* Show/Hide for one object: v6's raw DOM toggle (`special_tools_objects.js`
* `load_modal`), not removeLayer, because the layer must stay in its FeatureGroup
* (Geoman, `find_layer_id`, `update_draw_data`). Exported for object_viewer.js;
* `reapply_display` reuses it so a hidden state survives a reload.
*
* @param {Object} layer
* @param {boolean} visible
* @returns {void}
*/
export const apply_display = function(layer, visible) {

	// An uploaded image is TWO nodes: the carrier rectangle that takes the clicks
	// and the overlay that paints it. Read as a layer property, never by importing
	// image_upload.js, which already imports this module.
	const overlay = layer._uca_maps_overlay
	if (overlay) {
		set_node_display(overlay._image, visible)
	}

	// and its drag handles, when edit mode is on: they are markers on
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
* Only a layer a previous session left hidden
* (`properties.uca_maps.display===false`) has work to do: a fresh one starts visible.
*
* @param {Object} layer
* @returns {void}
*/
const reapply_display = function(layer) {
	const uca_maps = read_uca_maps(layer)
	if (uca_maps && uca_maps.display===false) {
		apply_display(layer, false)
	}
}//end reapply_display



/**
* REAPPLY_ALL
* Re-applies style, hierarchy, display and Geoman state to every layer, at attach
* and on every `updated_layer_data_<id_base>`: the core restores none of them.
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
* Custom-properties CRUD over `layer.feature.properties`, refusing
* RESERVED_PROPERTY_KEYS so the editor never shadows a core or tool field.
* Client-side only, as v6's `create_property`/`edit_property` already were.
*
* @param {Object} self
* @param {Object} layer
* @param {string} raw_key - trimmed; an empty or reserved key is refused
* @param {string} value
* @returns {boolean} false if key was empty/reserved (nothing written)
*/
export const set_property = function(self, layer, raw_key, value) {

	const key = String(raw_key || '').trim()
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
* The anchor-click download every format ends in, local Blob or decoded server
* answer. Exported so map_image_download.js shares the one trigger.
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
* Decodes a download carried in the API envelope: unlike v6's web-exposed
* `downloads/` folder, no generated file reaches a servable path. A manual loop,
* NOT `fetch('data:…')`: `APP_CSP` (`src/core/api/static_asset.ts`) has no `data:`
* in `connect-src`, so that fetch fails.
*
* @param {string} base64
* @param {string} mime
* @returns {Blob}
*/
const base64_to_blob = function(base64, mime) {

	const binary	= atob(base64)
	const bytes		= new Uint8Array(binary.length)

	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i)
	}

	return new Blob([bytes], {type: mime})
}//end base64_to_blob



/**
* DELIVER_DOWNLOAD
* The tail every server-built download shares: a refusal becomes the text
* for the button's line; an answer is decoded and handed to the browser.
*
* @param {Object} response - the tool_request envelope
* @param {string} failed - the download's own fallback text
* @returns {Promise<{ok: boolean, error?: string}>}
*/
export const deliver_download = async function(response, failed) {

	const data = response_data(response)
	if (!data) {
		return {ok: false, error: request_failed(response) ? tool_error_text(response.error, failed) : failed}
	}

	const {content_base64, filename, mime} = data
	trigger_blob_download(await base64_to_blob(content_base64, mime), filename)

	return {ok: true}
}//end deliver_download



/**
* REPORT_CLIENT_ERROR
* Surfaces a thrown client-side exception (no envelope to read) through the same
* global toast as server failures (`api_error`, subscribed in page.js). The
* `client.` prefix marks it client-origin and falls through error_policy.js's '*'
* wildcard, so nothing needs registering.
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
* GeoJSON is built in the browser; SHP/KML go through the server's
* `vector_download` (ogr2ogr). No reprojection: v6's `turf.toMercator` broke RFC
* 7946, and `toGeoJSON()` is already WGS84. One try around the whole body: a throw
* is reported and returned for the line, never an unhandled rejection.
*
* @param {Object} self - tool_uca_maps instance
* @param {Object} layer
* @param {'geojson'|'shp'|'kml'} format
* @returns {Promise<{ok: boolean, error?: string}>} `error`: a server refusal
*   or a client-side throw, for the section's line
*/
export const download_vector = async function(self, layer, format) {

	const failed = self.get_tool_label('vector_download_error_failed') || 'The object could not be downloaded.'

	try {

		const geojson = layer.toGeoJSON()

		if (format==='geojson') {
			const blob = new Blob([JSON.stringify(geojson, null, 2)], {type: 'application/geo+json'})
			trigger_blob_download(blob, 'uca_maps_object.geojson')
			return {ok: true}
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

		return await deliver_download(response, failed)

	} catch (error) {
		console.error('tool_uca_maps: vector_download failed unexpectedly', error)
		report_client_error((error && error.message) || 'Vector download failed')
		return {ok: false, error: exception_text(error, failed)}
	}
}//end download_vector


/**
* DOWNLOAD_OBJECT_PDF
* The object's properties, geometry and images as one server-built PDF
* (`tools/tool_uca_maps/server/pdf_report.ts`). Images travel as record identities,
* never paths, so the report cannot read media the caller may not; the labels
* travel so it speaks the record's language.
*
* @param {Object} self - tool_uca_maps instance
* @param {Object} layer
* @returns {Promise<{ok: boolean, error?: string}>} `error`: a server refusal
*   or a client-side throw, for the section's line
*/
export const download_object_pdf = async function(self, layer) {

	const failed = self.get_tool_label('pdf_error_failed') || 'The PDF could not be created.'

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

		return await deliver_download(response, failed)

	} catch (error) {
		console.error('tool_uca_maps: object_pdf_report failed unexpectedly', error)
		report_client_error((error && error.message) || 'PDF export failed')
		return {ok: false, error: exception_text(error, failed)}
	}
}//end download_object_pdf



/**
* TOGGLE_CENTROID
* v6's `create_div_centroid` (`special_tools.js`): a marker at the bounds centre,
* fired through the core's own `pm:create` so it gets the click/popup wiring of a
* drawn shape. `active_layer_id` is set first so it lands in this layer's group
* whatever the click order. Circle/polygon only, as in v6.
*
* @param {Object} self
* @param {Object} layer - the circle/polygon layer (never the centroid itself)
* @returns {void}
*/
export const toggle_centroid = function(self, layer) {

	const uca_maps = ensure_uca_maps(layer)

	if (uca_maps.centroid_uid) {
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

	const centroid_uid = ensure_uid(marker)
	ensure_uca_maps(marker).centroid_of = parent_uid

	self.geolocation.active_layer_id = layer_id
	self.geolocation.map.fire('pm:create', {layer: marker})

	if (marker.pm) {
		marker.pm.setOptions({preventMarkerRemoval: true, allowRemoval: false})
	}

	uca_maps.centroid_uid = centroid_uid
	commit(self, layer)
}//end toggle_centroid



/**
* REMOVE_CENTROID
* v6 used `centroid.pm.remove()`; here a FeatureGroup can hold several features
* (see `ensure_uid`), so the marker leaves through its owning group.
*
* @param {Object} self
* @param {Object} layer - the parent circle/polygon layer
* @returns {void}
*/
const remove_centroid = function(self, layer) {

	const uca_maps		= read_uca_maps(layer)
	const centroid_uid	= uca_maps && uca_maps.centroid_uid
	if (!centroid_uid) {
		return
	}

	const layer_id		= find_layer_id(self, layer)
	const feature_group	= layer_id!==null ? self.geolocation.FeatureGroup[layer_id] : null

	if (feature_group) {
		remove_centroid_layer(feature_group, centroid_uid)
	}

	delete uca_maps.centroid_uid
	commit(self, layer)
}//end remove_centroid



/**
* REMOVE_CENTROID_LAYER
* Unlocks the centroid marker `toggle_centroid` locked against removal and
* takes it out of `feature_group`.
*
* @param {Object} feature_group - L.FeatureGroup to search
* @param {string} centroid_uid - the marker's `uca_maps.uid`
* @returns {boolean} true when the marker was found (and removed)
*/
const remove_centroid_layer = function(feature_group, centroid_uid) {

	const centroid_layer = feature_group.getLayers().find((candidate) => {
		const candidate_uca_maps = read_uca_maps(candidate)
		return Boolean(candidate_uca_maps && candidate_uca_maps.uid===centroid_uid)
	})
	if (!centroid_layer) {
		return false
	}

	if (centroid_layer.pm) {
		centroid_layer.pm.setOptions({preventMarkerRemoval: false, allowRemoval: true})
	}
	feature_group.removeLayer(centroid_layer)

	return true
}//end remove_centroid_layer



/**
* UNLOCK_ORPHANED_CENTROID
* A parent removed by another path (Geoman's delete tool) would leave its centroid
* locked against removal forever: only `remove_centroid` unlocks it. Called for
* every removed layer; a no-op unless it had a `centroid_uid`.
*
* @param {Object} self
* @param {Object} removed_layer - the layer Geoman just removed
* @returns {void}
*/
const unlock_orphaned_centroid = function(self, removed_layer) {

	const uca_maps		= read_uca_maps(removed_layer)
	const centroid_uid	= uca_maps && uca_maps.centroid_uid
	if (!centroid_uid || !self.geolocation || !self.geolocation.FeatureGroup) {
		return
	}

	for (const layer_id in self.geolocation.FeatureGroup) {
		if (remove_centroid_layer(self.geolocation.FeatureGroup[layer_id], centroid_uid)) {
			return
		}
	}
}//end unlock_orphaned_centroid



/**
* GET_UNCERTAINTY
* v6's `special_tools.js` `get_incertidumbre` tiers, minus its bug: v6
* stored `1/area` as a string with an ' m²' suffix. The area is stored as
* the plain number it is; the console formats it when it shows it.
*
* @param {number} area_m2 - `turf.area(layer.toGeoJSON())` result
* @returns {{scale_tier: number, area_m2: number}}
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
		area_m2		: area_m2
	}
}//end get_uncertainty



/**
* TOGGLE_UNCERTAINTY
* Polygon only, as in v6 (`create_div_incertidumbre` is only called from the
* polygon branch of `set_info_console`).
*
* @param {Object} self
* @param {Object} layer - polygon layer
* @returns {void}
*/
export const toggle_uncertainty = function(self, layer) {

	const uca_maps = ensure_uca_maps(layer)

	if (uca_maps.uncertainty) {
		delete uca_maps.uncertainty
		commit(self, layer)
		return
	}

	const area_m2 = turf.area(layer.toGeoJSON())
	uca_maps.uncertainty = get_uncertainty(area_m2)
	commit(self, layer)
}//end toggle_uncertainty



/**
* SET_HIERARCHY
* v6's `create_div_hierarchy` boxes (`special_tools.js`), minus its bug: its
* uncheck called the opposite `bringTo*()` without setting that flag, an order no
* reload reproduces. Unchecking here restores the reload order
* (`restore_natural_order`). Not for markers, as in v6.
*
* @param {Object} self
* @param {Object} layer
* @param {'front'|'back'} edge - which checkbox was clicked
* @param {boolean} checked - the checkbox's new checked state
* @returns {void}
*/
export const set_hierarchy = function(self, layer, edge, checked) {

	const uca_maps	= ensure_uca_maps(layer)
	uca_maps.hierarchy	= uca_maps.hierarchy || {}
	const hierarchy		= uca_maps.hierarchy

	if (checked) {
		hierarchy.bringToFront	= edge==='front'
		hierarchy.bringToBack	= edge==='back'
		reapply_hierarchy(layer)
	} else {
		hierarchy[edge==='front' ? 'bringToFront' : 'bringToBack'] = false
		restore_natural_order(self)
	}

	commit(self, layer)
}//end set_hierarchy



/**
* RESTORE_NATURAL_ORDER
* Leaflet has no neutral z-order to put one path back into, so the whole
* stack is rebuilt as a load builds it: every path in FeatureGroup order,
* then each one's saved flags in that same order (`reapply_hierarchy`).
*
* @param {Object} self
* @returns {void}
*/
const restore_natural_order = function(self) {

	const map				= self.geolocation && self.geolocation.map
	const feature_groups	= self.geolocation && self.geolocation.FeatureGroup
	if (!map || !feature_groups) {
		return
	}

	const paths = []
	for (const layer_id in feature_groups) {
		feature_groups[layer_id].eachLayer((layer) => {
			if (layer instanceof L.Path && map.hasLayer(layer)) {
				paths.push(layer)
			}
		})
	}

	for (const path of paths) {
		path.bringToFront()
	}
	for (const path of paths) {
		reapply_hierarchy(path)
	}
}//end restore_natural_order



/**
* COMPUTE_INFO
* Mirrors the core popup's math (`get_popup_content`), not v6's, so panel and
* popup agree on the same click. The circle's "Area" is 2·π·r, mislabelled as in
* the core; another label here would contradict the popup. `format_polygon_area`
* replaces the core's private `readable_area`, which leaves < 1 ha undefined.
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
		const area		= circle_measure(layer) // as get_popup_content computes it
		return {
			label_key	: 'center_radius_area',
			label		: 'Center / Radius / Area',
			value		: geolocation.str_lat_lng(center) + ' · ' + geolocation.round_coordinate(radius, 2) + ' m · ' + area + ' m'
		}
	}

	if (layer instanceof L.Polygon) {
		// A 1x1 prints its NOMINAL area and v6 never measures it
		// (`create_div_polygon_area`, the is_oneXone branch): the rectangle
		// is a 1 m² reference around a point, not a shape the user drew.
		if (is_onexone_rectangle(layer)) {
			return {label_key: 'area', label: 'Area', value: '1 m²'}
		}
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
// exported for the client gate
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
* The selected object's centre elevation (`tools/tool_uca_maps/server/elevation.ts`).
* Not persisted, unlike v6, which saved it on a mere click: nothing auto-saves; it
* is shown and handed to the PDF in memory. Never throws: a service outage must
* not stop the console from opening.
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

	// THE CACHE IS NOT AN OPTIMISATION: commit() re-renders the section after every
	// mutation and Open-Elevation rate-limits. Keyed on layer AND coordinates, so a
	// moved shape re-asks; the PROMISE is cached at once, so a burst of renders
	// shares one request.
	const cache_key = center.lat + ',' + center.lng
	const cached = self._elevation
	if (cached && cached.layer===layer && cached.key===cache_key) {
		return cached.promise
	}

	// `elevation` is filled on arrival for the PDF export, which must print the
	// number the user is LOOKING AT — asking the service a second time could
	// legitimately answer differently and make the document disagree with the panel
	const entry = {layer: layer, key: cache_key, elevation: null, promise: null}
	entry.promise = request_elevation(self, center).then(function(result) {
		if (result.failed) {
			// a refused or thrown request is not an answer: the next render asks again
			if (self._elevation===entry) {
				self._elevation = null
			}
		} else {
			entry.elevation = result.elevation
		}
		return {elevation: result.elevation, unavailable: result.unavailable}
	})
	self._elevation = entry

	return entry.promise
}//end fetch_elevation



/**
* REQUEST_ELEVATION
* The one round trip behind `fetch_elevation`. `failed` separates a refusal or
* a throw (not cached) from an answer that has no elevation (cached).
*
* @param {Object} self - tool_uca_maps instance
* @param {Object} center - L.LatLng
* @returns {Promise<{elevation: number|null, unavailable: boolean, failed: boolean}>}
*/
const request_elevation = async function(self, center) {

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
			return {elevation: null, unavailable: true, failed: true}
		}

		const data = response_data(response)

		return (data && typeof data.elevation==='number')
			? {elevation: data.elevation, unavailable: false, failed: false}
			: {elevation: null, unavailable: true, failed: false}

	} catch (error) {
		console.error('tool_uca_maps: get_elevation failed unexpectedly', error)
		return {elevation: null, unavailable: true, failed: true}
	}
}//end request_elevation



/**
* FORMAT_POLYGON_AREA
* m² below a hectare, ha below a km², km² above — two decimals. Exported so
* the console prints a stored area the way it writes `properties.area`.
*
* @param {number} area_m2
* @returns {string}
*/
export const format_polygon_area = function(area_m2) {
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
* Searches the FeatureGroups instead of reading `active_layer_id`: the core sets
* that in a click handler registered after `bindPopup`'s, so on 'popupopen' it can
* still hold the previous layer's id.
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
* Called from tool_uca_maps' destroy(). Guarded: if component_geolocation went
* first, the map and its DOM (panel_node included) are already gone, so skipping
* the removal is correct, not a leak.
*
* @param {Object} self - tool_uca_maps instance
* @returns {void}
*/
export const detach_console = function(self) {

	if (self.geolocation && self.geolocation.map) {
		remove_map_listeners(self, 'detach_console', [
			['popupopen',	'_popupopen_handler'],
			['popupclose',	'_popupclose_handler'],
			['pm:create',	'_pmcreate_handler'],
			['pm:remove',	'_pmremove_handler']
		])
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
	self._popupclose_handler	= null
	self._pmcreate_handler		= null
	self._pmremove_handler		= null
	self.active_console_layer	= null

}//end detach_console



/**
* REMOVE_MAP_LISTENERS
* Unsubscribes each stored map listener a detach_* owns. One failing `off`
* is reported and does not stop the rest.
*
* @param {Object} self - tool_uca_maps instance (its map must exist)
* @param {string} scope - the detach_* name, for the warning
* @param {Array<[string, string]>} listeners - [event name, `self` key of the handler]
* @returns {void}
*/
export const remove_map_listeners = function(self, scope, listeners) {
	for (const [event_name, key] of listeners) {
		if (!self[key]) {
			continue
		}
		try {
			self.geolocation.map.off(event_name, self[key])
		} catch (error) {
			console.warn(`tool_uca_maps ${scope}: error removing ${event_name} listener`, error)
		}
	}
}//end remove_map_listeners



// @license-end
