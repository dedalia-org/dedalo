// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global L*/
/*eslint no-undef: "error"*/



/**
* IMAGE_EDIT
* "Activar edición" — the console's image branch lets the user drag an
* uploaded overlay's three control points to place, scale and rotate it
* (v6 `special_tools.js:6280-6410` + the checkbox at `:6601`). Hito 14; the
* descriptor it moves was already being stored by hito 13, so nothing migrates.
*
* WHY THREE POINTS AND NOT FOUR. `Leaflet.ImageOverlay.Rotated` maps the image
* onto an AFFINE transform, which three corners define exactly: top-left,
* top-right and bottom-left. The fourth is inferred (`corner_bottom_right`),
* which is also why dragging one handle skews the picture rather than just
* stretching an edge — that is the feature, not a bug.
*
* IMPORT DIRECTION. `image_upload.js` imports from here, never the reverse:
* this module knows the geometry of a stored descriptor (`hull_bounds`) and
* owns the handles, and needs nothing from the upload flow. Keeping the arrow
* one-way is what stops the two files becoming a cycle.
*
* NOTHING HERE AUTO-SAVES. A drag ends in `commit()` — the record is marked
* dirty and the user's own Save button is still the only thing that writes
* (the second of component_geolocation's three laws). v6 called `save_object()`
* on every `dragend`, which in v7 would be exactly the auto-save that law
* forbids.
*/



import {commit} from './object_console.js'



/** Matches the marker CSS in `tool_uca_maps.less`. Anchored at its centre so
 * the stored corner is the point the user sees, not the icon's top-left. */
const HANDLE_SIZE = 14



/**
* HULL_BOUNDS
* The axis-aligned bounds enclosing the three control points AND the inferred
* fourth corner (top_right + bottom_left − top_left, the same inference the
* plugin itself makes) — dropping the fourth would clip the hull of a skewed
* raster.
*
* @param {Object} corners - {top_left, top_right, bottom_left}, each [lat, lng]
* @returns {Object} L.latLngBounds
*/
export const hull_bounds = function(corners) {

	const bottom_right = [
		corners.top_right[0] + corners.bottom_left[0] - corners.top_left[0],
		corners.top_right[1] + corners.bottom_left[1] - corners.top_left[1]
	]

	return L.latLngBounds([corners.top_left, corners.top_right, corners.bottom_left, bottom_right])
}//end hull_bounds



/**
* IS_IMAGE_EDITING
* Whether the carrier's overlay is currently in edit mode. Read from the
* STORED descriptor rather than from a cached flag: the descriptor is what
* survives a save and what a rebuilt overlay is restored from, so any other
* source can disagree with what the map is actually showing.
*
* @param {Object} carrier
* @returns {boolean}
*/
export const is_image_editing = function(carrier) {

	const image = carrier
		&& carrier.feature
		&& carrier.feature.properties
		&& carrier.feature.properties.uca_maps
		&& carrier.feature.properties.uca_maps.image

	return !!(image && image.interactive===true)
}//end is_image_editing



/**
* SET_IMAGE_INTERACTIVE
* The "Activar edición" checkbox's one writer. Persisted (v6 stores the same
* flag as `imageInteractive`) so a map reopened later comes back with the
* handles the user left showing.
*
* @param {Object} self - tool_uca_maps instance
* @param {Object} carrier
* @param {boolean} active
* @returns {void}
*/
export const set_image_interactive = function(self, carrier, active) {

	const image = carrier.feature.properties.uca_maps.image
	image.interactive = active===true

	if (image.interactive) {
		attach_handles(self, carrier)
	} else {
		detach_handles(self, carrier)
	}

	commit(self, carrier)

}//end set_image_interactive



/**
* ATTACH_HANDLES
* Puts the three draggable markers on the map for one carrier. Idempotent, and
* a no-op when the overlay is not built yet (there is nothing to reposition) —
* `attach_overlay` calls this again as soon as it is.
*
* `pmIgnore`/`snapIgnore` keep Geoman out: a handle is a control, not a drawn
* object, and without these it would be editable, snappable and — worst —
* collected into the component's data on save.
*
* @param {Object} self - tool_uca_maps instance
* @param {Object} carrier
* @returns {Array|null} the three markers, or null if none could be built
*/
export const attach_handles = function(self, carrier) {

	const map = self.geolocation && self.geolocation.map
	const overlay = carrier && carrier._uca_maps_overlay

	if (!map || !overlay || carrier._uca_maps_handles) {
		return null
	}

	const image	= carrier.feature.properties.uca_maps.image
	const icon	= L.divIcon({
		className	: 'uca-maps-image-handle',
		iconSize	: [HANDLE_SIZE, HANDLE_SIZE],
		iconAnchor	: [HANDLE_SIZE/2, HANDLE_SIZE/2]
	})

	const keys		= ['top_left', 'top_right', 'bottom_left']
	const handles	= keys.map((key) => L.marker(image.corners[key], {
		icon		: icon,
		draggable	: true,
		pmIgnore	: true,
		snapIgnore	: true,
		zIndexOffset: 1000
	}))

	for (const handle of handles) {
		handle.addTo(map)
		handle.on('drag', () => {
			apply_handles(carrier, handles)
		})
		// the record is marked dirty ONCE the gesture is over, not on every
		// pixel of it: commit() re-renders the console panel, and doing that
		// mid-drag would rebuild the very panel the user is dragging against
		handle.on('dragend', () => {
			apply_handles(carrier, handles)
			commit(self, carrier)
		})
	}

	carrier._uca_maps_handles = handles

	// a carrier hidden from the object viewer gets hidden handles: turning edit
	// mode on for an object the user has hidden must not paint three circles
	// over nothing (`object_console.js` apply_display does the reverse trip)
	if (carrier._path && carrier._path.style.display==='none') {
		for (const handle of handles) {
			if (handle._icon) { handle._icon.style.display = 'none' }
			if (handle._shadow) { handle._shadow.style.display = 'none' }
		}
	}

	return handles
}//end attach_handles



/**
* APPLY_HANDLES
* One drag step: the three live handle positions become the overlay's new
* transform, the stored corners, and the carrier's own outline. All three have
* to move together — the overlay is what the user sees, the descriptor is what
* is saved, and the carrier rectangle is what can be clicked and deleted.
*
* @param {Object} carrier
* @param {Array} handles - [top_left, top_right, bottom_left] markers
* @returns {void}
*/
const apply_handles = function(carrier, handles) {

	const image		= carrier.feature.properties.uca_maps.image
	const overlay	= carrier._uca_maps_overlay

	const top_left		= handles[0].getLatLng()
	const top_right		= handles[1].getLatLng()
	const bottom_left	= handles[2].getLatLng()

	if (overlay) {
		overlay.reposition(top_left, top_right, bottom_left)
	}

	image.corners = {
		top_left	: [top_left.lat, top_left.lng],
		top_right	: [top_right.lat, top_right.lng],
		bottom_left	: [bottom_left.lat, bottom_left.lng]
	}

	// the carrier follows as the axis-aligned hull it was built as. setLatLngs
	// rather than setBounds: a carrier reloaded from saved data comes back as a
	// plain polygon, and only L.Rectangle has setBounds
	const bounds = hull_bounds(image.corners)
	carrier.setLatLngs([
		bounds.getSouthWest(),
		bounds.getNorthWest(),
		bounds.getNorthEast(),
		bounds.getSouthEast()
	])

}//end apply_handles



/**
* DETACH_HANDLES
* Takes one carrier's handles off the map. Called when edit mode is switched
* off, when the object is deleted, when a layer reload replaces the carrier,
* and on teardown — a handle is not a drawn object, so nothing else in the
* engine would ever remove it ("destrucción real al cerrar").
*
* @param {Object} self - tool_uca_maps instance
* @param {Object} carrier
* @returns {void}
*/
export const detach_handles = function(self, carrier) {

	const handles = carrier && carrier._uca_maps_handles
	if (!handles) {
		return
	}

	const map = self.geolocation && self.geolocation.map
	for (const handle of handles) {
		handle.off()
		if (map) {
			map.removeLayer(handle)
		}
	}

	delete carrier._uca_maps_handles

}//end detach_handles



/**
* SEAL_CARRIER_FROM_GEOMAN
* The carrier is a bookkeeping rectangle, not a drawn shape: its vertices are
* the axis-aligned HULL of the image, so editing them would move a box that is
* not the picture's own footprint and desync the two. Geoman disagrees —
* `component_geolocation.js:2529` calls `layer.pm.enable()` on every layer of
* the clicked FeatureGroup, which is what painted four vertex circles over the
* image on click, competing with this module's own three handles.
*
* `allowRemoval` is deliberately LEFT ALONE: deleting the object with Geoman's
* remove tool is the supported way to remove an image, and removal never
* consults `allowEditing`.
*
* @param {Object} carrier
* @returns {void}
*/
export const seal_carrier_from_geoman = function(carrier) {

	if (!carrier || !carrier.pm || typeof carrier.pm.setOptions!=='function') {
		return
	}

	carrier.pm.setOptions({
		allowEditing	: false,
		allowCutting	: false,
		allowRotation	: false
	})

}//end seal_carrier_from_geoman



/**
* ATTACH_CARRIER_DRAG
* Makes the PICTURE follow its carrier. Geoman's drag mode grabs the carrier —
* a transparent rectangle — so before this the user dragged an invisible box
* and the image stayed behind: the two desynced and nothing appeared to move.
* v6 had no way to drag an image at all; this is the hole being closed, not
* parity with it.
*
* Translation only. The three handles stay the tool for scaling and rotating,
* so a drag must not touch the shape — the delta is taken from the carrier's
* own centre and added to the corners captured when the gesture started, never
* accumulated step by step (that drifts).
*
* @param {Object} self - tool_uca_maps instance
* @param {Object} carrier
* @returns {void}
*/
export const attach_carrier_drag = function(self, carrier) {

	if (!carrier || !carrier.on || carrier._uca_maps_drag_bound) {
		return
	}

	let origin	= null
	let corners	= null

	const on_start = () => {
		const image = carrier.feature.properties.uca_maps.image
		origin	= carrier.getBounds().getCenter()
		corners	= JSON.parse(JSON.stringify(image.corners))
	}

	const on_move = () => {
		if (!origin || !corners) {
			return
		}

		const now		= carrier.getBounds().getCenter()
		const delta_lat	= now.lat - origin.lat
		const delta_lng	= now.lng - origin.lng

		const image = carrier.feature.properties.uca_maps.image
		image.corners = {
			top_left	: [corners.top_left[0] + delta_lat,		corners.top_left[1] + delta_lng],
			top_right	: [corners.top_right[0] + delta_lat,	corners.top_right[1] + delta_lng],
			bottom_left	: [corners.bottom_left[0] + delta_lat,	corners.bottom_left[1] + delta_lng]
		}

		if (carrier._uca_maps_overlay) {
			carrier._uca_maps_overlay.reposition(
				L.latLng(image.corners.top_left),
				L.latLng(image.corners.top_right),
				L.latLng(image.corners.bottom_left)
			)
		}

		// the handles are markers on the MAP, not children of the carrier, so
		// Geoman moves neither: without this they stay where the image was
		const handles = carrier._uca_maps_handles
		if (handles) {
			handles[0].setLatLng(image.corners.top_left)
			handles[1].setLatLng(image.corners.top_right)
			handles[2].setLatLng(image.corners.bottom_left)
		}
	}

	const on_end = () => {
		on_move()
		origin	= null
		corners	= null
		// dirty at the END of the gesture, as the handle drag does: commit()
		// re-renders the console panel and doing that mid-drag rebuilds the
		// very panel the user is dragging against
		commit(self, carrier)
	}

	carrier.on('pm:dragstart', on_start)
	carrier.on('pm:drag', on_move)
	carrier.on('pm:dragend', on_end)

	carrier._uca_maps_drag_bound = {on_start, on_move, on_end}

}//end attach_carrier_drag



/**
* DETACH_CARRIER_DRAG
* Named handlers, removed one by one: a bare `carrier.off('pm:drag')` would
* also take the core's own listeners off a layer this tool does not own.
*
* @param {Object} carrier
* @returns {void}
*/
export const detach_carrier_drag = function(carrier) {

	const bound = carrier && carrier._uca_maps_drag_bound
	if (!bound) {
		return
	}

	carrier.off('pm:dragstart', bound.on_start)
	carrier.off('pm:drag', bound.on_move)
	carrier.off('pm:dragend', bound.on_end)

	delete carrier._uca_maps_drag_bound

}//end detach_carrier_drag
