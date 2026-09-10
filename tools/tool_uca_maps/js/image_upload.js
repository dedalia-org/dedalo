// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global L, DEDALO_MEDIA_URL, SHOW_DEVELOPER */
/*eslint no-undef: "error"*/



/**
* IMAGE_UPLOAD
* Fila #11 del audit ("Upload file to map"), IMAGE half — hito 13. The vector
* half is `vector_upload.js` (hito 12); both share the ONE button+panel that
* file builds, which is why nothing here creates a control of its own.
*
* THREE doors, in order, none of them invented here:
*   1. `create` — a fresh record in the Images section (`rsc170`), the same
*      thing v6 does (`render_tool_leaflet_special_tools.js:1541`). An image
*      on a map has to BE media before it can be served, and Dédalo's media
*      lives on records, so the upload gets one.
*   2. `service_upload` + `tool_upload::process_uploaded_file` — the engine's
*      own ingest. It stores the master untouched, builds the web derivative,
*      and writes files_info back on the record. Nothing in this tool copies,
*      converts or serves a byte of it.
*   3. `tool_uca_maps::get_image_overlay` — the one question left: WHERE on
*      the map the image goes. v6 answers it by pulling the raw GeoTIFF back
*      into the browser and parsing it there with `georaster` +
*      `georaster-layer-for-leaflet`; this asks the server, which already has
*      GDAL, and both libraries disappear (see `server/image_overlay.ts`).
*
* WHAT PERSISTS. Not the overlay — Leaflet image overlays are not features and
* the geolocation component would not save one. What persists is a TRANSPARENT
* RECTANGLE carrying `properties.uca_maps.image` (v6 does the same, calling it
* a `clipPolygon`): the rectangle is a normal drawn object, so the component's
* own save writes it like any other, and `hydrate_image_overlays` rebuilds the
* overlay from those properties on every load. The record identity is stored,
* NOT an absolute URL (v6 stores the URL): a host or media-root change would
* break every saved overlay in the install otherwise.
*/



import {upload} from '../../../core/services/service_upload/js/service_upload.js'
import {response_data, request_failed} from '../../../core/common/js/api_error.js'
import {error_text} from '../../../core/common/js/render_api_error.js'
import {data_manager} from '../../../core/common/js/data_manager.js'
import {event_manager} from '../../../core/common/js/event_manager.js'
import {commit, ensure_properties, report_client_error} from './object_console.js'
import {hull_bounds, is_image_editing, attach_handles, detach_handles, seal_carrier_from_geoman, attach_carrier_drag, detach_carrier_drag} from './image_edit.js'



/** v6's own two constants (`render_tool_leaflet_special_tools.js:1550-1551`,
 * there quoting DD_TIPOS.DEDALO_SECTION_RESOURCES_IMAGE_TIPO /
 * DEDALO_COMPONENT_RESOURCES_IMAGE_TIPO). Seed-shipped ontology, present in
 * every install — not an installation TLD. Making them configurable would go
 * through the tool's `default_config`; see the hito 13 dossier. */
const IMAGE_SECTION_TIPO	= 'rsc170'
const IMAGE_COMPONENT_TIPO	= 'rsc29'

const IMAGE_UPLOAD_EXTENSIONS	= ['tif', 'tiff', 'jpg', 'jpeg', 'png']
/** Refused in the BROWSER, before the bytes leave. Not a policy the server
 * relies on (it has its own limits) — it is what stops a mistakenly picked
 * multi-GB raster from uploading for ten minutes to be rejected at the end. */
const IMAGE_UPLOAD_MAX_BYTES	= 100_000_000
const IMAGE_UPLOAD_KEY_DIR		= 'image'

/** v6's own default (`special_tools_upload.js`: imageOpacity 1, image_zIndex
 * 200) — kept so a map built in v6 and one built here stack the same way. */
const DEFAULT_IMAGE_OPACITY	= 1
const DEFAULT_IMAGE_Z_INDEX	= 200



/**
* LOAD_ROTATED_OVERLAY
* Loads the vendored `Leaflet.ImageOverlay.Rotated` plugin as a CLASSIC
* `<script>`, for the same spec reason `map_image_download.js`'s
* `load_dom_to_image` documents at length: a Leaflet plugin extends the `L`
* GLOBAL at its own top level, and an `import()`ed file is evaluated as a
* module, where that global is not what the plugin was written against.
* Idempotent (cached promise). Rejects LOUDLY on a load failure — v6 wrapped
* this very plugin in a silent `try{}catch(e){}`, which is audit bug #3.
*
* @returns {Promise<void>}
*/
let rotated_load_promise = null

const load_rotated_overlay = function() {

	if (L.ImageOverlay && L.ImageOverlay.Rotated) {
		return Promise.resolve()
	}

	if (!rotated_load_promise) {
		rotated_load_promise = new Promise((resolve, reject) => {
			const script	= document.createElement('script')
			script.src		= new URL('./lib/leaflet-imageoverlay-rotated/leaflet-imageoverlay-rotated.js', import.meta.url).href
			script.onload	= () => resolve()
			script.onerror	= () => reject(new Error('tool_uca_maps: failed to load leaflet-imageoverlay-rotated'))
			document.head.appendChild(script)
		})
		// a FAILED load must not be cached: caching the rejection would
		// disable image overlays for the rest of the page session over one
		// transient network error, and re-report it on every later edit
		rotated_load_promise.catch(() => { rotated_load_promise = null })
	}

	return rotated_load_promise
}//end load_rotated_overlay



/**
* IMAGE_URL
* The one place a stored image descriptor becomes a URL. `file_path` is
* media-root-relative (the shape `files_info` stores and every core
* component_image view already resolves this way), so a moved install still
* resolves.
*
* @param {Object} image - properties.uca_maps.image descriptor
* @returns {string}
*/
const image_url = function(image) {
	return DEDALO_MEDIA_URL + image.file_path
}//end image_url



/** How much of the viewport's SHORTER side a coordinate-less image is given.
 * Not v6's 1.0 — see `corners_from_viewport`. */
const PLAIN_IMAGE_VIEWPORT_FRACTION = 0.5

/**
* NATURAL_SIZE
* The image's own pixel dimensions, read from the browser once it has loaded
* it. Asked here rather than on the server on purpose: `gdalinfo` would
* answer too, but then a GDAL-less install could not place an ordinary .jpg
* either — and the browser has to fetch the image anyway to draw it.
*
* Falls back to a square on any failure (a 404, a decode error): a wrong
* aspect ratio is a cosmetic mistake the user can see and fix, whereas
* failing the upload over it would throw away a file that IS on the server.
*
* @param {string} url
* @returns {Promise<{width: number, height: number}>}
*/
const natural_size = function(url) {

	return new Promise((resolve) => {
		const probe = new Image()
		probe.onload = () => resolve({
			width	: probe.naturalWidth || 1,
			height	: probe.naturalHeight || 1
		})
		probe.onerror = () => resolve({width: 1, height: 1})
		probe.src = url
	})
}//end natural_size



/**
* CORNERS_FROM_VIEWPORT
* Where a NON-georeferenced image goes. An image with no coordinates has
* none, so this is not a guess at the right place — it is a starting position
* the user then moves by hand.
*
* TWO DELIBERATE DEVIATIONS FROM v6, both about that last clause:
*
*  1. v6 stretches the image onto `map.getBounds()` — the viewport RECTANGLE.
*     Unless the map happens to be square that DISTORTS every image: a square
*     plan lands as a wide rectangle. Here the image keeps its own aspect
*     ratio, computed in CONTAINER PIXELS (degrees of latitude and longitude
*     are not the same length on screen, so doing this in lat/lon would
*     reintroduce the distortion it is meant to remove).
*  2. v6 fills the whole viewport. It gets half the shorter side instead —
*     visible, obviously placed by default, and with the map still readable
*     around it to judge the placement against (Sergio, validación hito 13).
*     Kept after "Activar edición" landed in hito 14: the handles make a
*     full-viewport image shrinkable, but not judgeable.
*
* @param {Object} map - the Leaflet map
* @param {Object} size - the image's natural {width, height} in pixels
* @returns {Object} {top_left, top_right, bottom_left} as [lat, lon] pairs
*/
export const corners_from_viewport = function(map, size) {

	const viewport	= map.getSize()
	const box		= Math.min(viewport.x, viewport.y) * PLAIN_IMAGE_VIEWPORT_FRACTION
	const width		= (size && size.width > 0) ? size.width : 1
	const height	= (size && size.height > 0) ? size.height : 1

	// fit INSIDE the box, never crop or stretch to it
	const scale		= Math.min(box / width, box / height)
	const draw_w	= width * scale
	const draw_h	= height * scale

	const left	= (viewport.x - draw_w) / 2
	const top	= (viewport.y - draw_h) / 2

	const to_corner = (x, y) => {
		const latlng = map.containerPointToLatLng(L.point(x, y))
		return [latlng.lat, latlng.lng]
	}

	return {
		top_left	: to_corner(left, top),
		top_right	: to_corner(left + draw_w, top),
		bottom_left	: to_corner(left, top + draw_h)
	}
}//end corners_from_viewport



/**
* CREATE_IMAGE_RECORD
* Door 1: a fresh record in the Images section to host the file. Same rqo the
* core itself uses to mint a record from the client
* (`component_text_area.js:1558`, the time-machine note case).
*
* @returns {Promise<number|null>} the new section_id, or null on failure
*/
const create_image_record = async function() {

	const api_response = await data_manager.request({
		body : {
			action	: 'create',
			source	: {
				section_tipo : IMAGE_SECTION_TIPO
			}
		}
	})

	const section_id = response_data(api_response)

	return (typeof section_id==='number' && section_id>0)
		? section_id
		: null
}//end create_image_record



/**
* INGEST_UPLOADED_FILE
* Door 2b: hand the staged upload to `tool_upload::process_uploaded_file`.
*
* The rqo is assembled here rather than through tool_upload's own exported
* `process_uploaded_file()` helper: that helper refuses any caller whose
* `model` is not literally 'tool_upload' (`tools/tool_upload/js/tool_upload.js:304`),
* so using it would mean building a whole second tool instance for the sake
* of a guard. `source` only needs the tool name + action — the server's
* dispatcher reads nothing else from it (`dd_tools_api.ts` tool_request →
* `dispatchToolRequest(principal, userId, {model, action}, options)`), and the
* permission gate reads the identity out of `options`, which is where it
* belongs.
*
* @param {number} section_id - the new rsc170 record
* @param {Object} file_data - what service_upload's transport returned
* @returns {Promise<Object>} the raw api_response
*/
const ingest_uploaded_file = async function(section_id, file_data) {

	return await data_manager.request({
		body : {
			dd_api	: 'dd_tools_api',
			action	: 'tool_request',
			source	: {
				typo	: 'source',
				model	: 'tool_upload',
				action	: 'process_uploaded_file'
			},
			options	: {
				file_data		: file_data,
				tipo			: IMAGE_COMPONENT_TIPO,
				section_tipo	: IMAGE_SECTION_TIPO,
				section_id		: section_id,
				caller_type		: 'component'
			}
		},
		// the ingest builds every derivative tier synchronously; a big TIFF
		// legitimately takes far longer than a normal API call
		timeout : 600 * 1000
	})
}//end ingest_uploaded_file



/**
* UPLOAD_IMAGE_FILE
* The whole flow, exported taking a plain `file` (not a DOM event) so tests
* can await it directly — same testability convention as
* `vector_upload.js`'s `upload_vector_file`.
*
* @param {Object} self - tool_uca_maps instance
* @param {File} file - the browser File object chosen by the user
* @returns {Promise<{ok: boolean, error?: string, georeferenced?: boolean}>}
*/
export const upload_image_file = async function(self, file) {

	if (self._image_upload_busy) {
		return {ok: false}
	}
	if (!file) {
		return {ok: false, error: self.get_tool_label('upload_no_file') || 'Please choose a file first.'}
	}

	self._image_upload_busy = true

	try {

		// The bytes are staged BEFORE the record is minted, deliberately —
		// v6 does it the other way round and leaves an empty rsc170 record
		// behind every time an upload is refused or cancelled. Nothing in the
		// staging step needs the record (`tipo` here is the component TIPO, a
		// constant), so the record is only created once there is a file to
		// put in it.
		// (!) This NARROWS the orphan-record window, it does not close it: a
		// failure AFTER the mint (a refused ingest, a torn-down tool, a
		// missing renderable tier) still leaves the rsc170 record behind.
		// Cleaning that up means the tool DELETING a core-section record,
		// which is a decision of its own — see the hito 13 dossier.
		const upload_response = await upload({
			id					: self.id,
			file				: file,
			key_dir				: IMAGE_UPLOAD_KEY_DIR,
			allowed_extensions	: IMAGE_UPLOAD_EXTENSIONS,
			max_size_bytes		: IMAGE_UPLOAD_MAX_BYTES,
			tipo				: IMAGE_COMPONENT_TIPO
		})

		if (!response_data(upload_response)) {
			const message = upload_response && upload_response.error
				? error_text(upload_response.error)
				: (self.get_tool_label('upload_error_transport') || 'The file could not be uploaded.')
			return {ok: false, error: message}
		}

		const section_id = await create_image_record()
		if (section_id===null) {
			return {
				ok		: false,
				error	: self.get_tool_label('upload_image_error_record')
					|| 'A record to hold the image could not be created.'
			}
		}

		const ingest_response = await ingest_uploaded_file(section_id, upload_response.file_data)
		if (request_failed(ingest_response)) {
			return {ok: false, error: error_text(ingest_response.error)}
		}

		const overlay_response = await self.tool_request({
			action	: 'get_image_overlay',
			options	: {
				tipo			: IMAGE_COMPONENT_TIPO,
				section_tipo	: IMAGE_SECTION_TIPO,
				section_id		: section_id
			}
		})

		// the tool may have been torn down while all of the above was in
		// flight (same "DOM is truth, discard a late response" law as
		// check_administrative_unit_at_point, hito 11)
		if (!self.upload_panel || !self.geolocation || !self.geolocation.map) {
			return {ok: false}
		}

		if (request_failed(overlay_response)) {
			return {ok: false, error: error_text(overlay_response.error)}
		}

		const data = response_data(overlay_response)
		if (!data || !data.file_path) {
			// NOT the "record could not be created" message: by this point the
			// record exists and the file is ingested — what failed is that the
			// answer named no displayable file
			return {
				ok		: false,
				error	: self.get_tool_label('upload_image_error_no_display')
					|| 'The uploaded image has no version this browser can display.'
			}
		}

		// a coordinate-less image needs its own pixel dimensions to be placed
		// without distortion, and only the browser has them for free
		const corners = data.georeferenced
			? data.corners
			: corners_from_viewport(
				self.geolocation.map,
				await natural_size(image_url({file_path: data.file_path}))
			)

		// natural_size awaits a network fetch — re-check the teardown
		if (!self.upload_panel || !self.geolocation || !self.geolocation.map) {
			return {ok: false}
		}

		const image = {
			file_path		: data.file_path,
			quality			: data.quality,
			section_tipo	: IMAGE_SECTION_TIPO,
			section_id		: section_id,
			tipo			: IMAGE_COMPONENT_TIPO,
			corners			: corners,
			opacity			: DEFAULT_IMAGE_OPACITY,
			z_index			: DEFAULT_IMAGE_Z_INDEX
		}

		await create_image_object(self, image)

		return {
			ok					: true,
			georeferenced		: data.georeferenced===true,
			georeference_unavailable : data.georeference_unavailable===true
		}

	} catch (error) {
		console.error('tool_uca_maps: upload_image_file failed unexpectedly', error)
		report_client_error((error && error.message) || 'Image upload failed')
		return {ok: false, error: self.get_tool_label('upload_error_transport') || 'The file could not be uploaded.'}
	} finally {
		self._image_upload_busy = false
	}

}//end upload_image_file



/**
* CREATE_IMAGE_OBJECT
* Builds the carrier rectangle + its overlay and hands the rectangle to the
* map as a normal drawn object (`pm:create`), which is what makes it part of
* the component's data and therefore saveable. The rectangle is the AXIS-
* ALIGNED hull of the three corners: it is a selection/deletion handle, not
* the image's own footprint (that lives in `corners`, exactly so a skewed
* raster is not squared off).
*
* @param {Object} self - tool_uca_maps instance
* @param {Object} image - the descriptor to store under properties.uca_maps.image
* Exported for the client gate: it is the production builder, and the two
* properties it writes (`image` + `is_raster`) are a contract other modules
* read (`object_viewer.js` splits its lists on the second).
*
* @returns {Promise<Object>} the carrier layer
*/
export const create_image_object = async function(self, image) {

	const map = self.geolocation.map

	const carrier = L.rectangle(hull_bounds(image.corners), {
		opacity	: 0,
		fillOpacity : 0,
		color	: 'transparent'
	})
	carrier.feature = carrier.toGeoJSON()

	const properties = ensure_properties(carrier)
	properties.color		= 'transparent'
	properties.uca_maps		= properties.uca_maps || {}
	properties.uca_maps.image	= image
	// A NEW image arrives EDITABLE, as in v6: a plain image lands at an
	// arbitrary spot, so the very next gesture is always moving it, and making
	// the user find a checkbox first is a step v6 never asked for (Sergio,
	// validación hito 14). Defaulted HERE and not in the upload flow because
	// this is the one production builder — and only a new object, never a
	// reload, comes through it, so a stored `false` is never overwritten.
	if (typeof image.interactive!=='boolean') {
		image.interactive = true
	}
	// object_viewer.js:215 splits its two lists on exactly this flag, and its
	// own header says the "Rasterized objects" list stays empty until this
	// row lands. This IS that landing — without it every uploaded image would
	// show up in the VECTOR list as "Untitled object" and the raster list
	// would stay permanently empty.
	properties.uca_maps.is_raster = true

	await attach_overlay(self, carrier)

	map.fire('pm:create', {layer: carrier})
	// padded: zooming to the image EXACTLY leaves it edge-to-edge with no map
	// around it, so there is nothing to judge the placement against (Sergio,
	// validación hito 13)
	map.fitBounds(hull_bounds(image.corners), {padding: [40, 40]})

	return carrier
}//end create_image_object



// `hull_bounds` moved to image_edit.js with the rest of the descriptor's
// geometry when the drag handles landed (hito 14) — the import direction is
// one-way, upload → edit, so the two files never become a cycle.



/**
* ATTACH_OVERLAY
* Creates the image overlay for one carrier layer and remembers it on BOTH
* the layer (`_uca_maps_overlay`, so the console and the removal hook find it
* from the object the user clicked) and the tool (`_image_overlays`, so
* teardown can sweep every one without walking the map).
*
* @param {Object} self - tool_uca_maps instance
* @param {Object} carrier - the transparent rectangle carrying the descriptor
* @returns {Promise<Object|null>} the overlay, or null if it could not be built
*/
export const attach_overlay = async function(self, carrier) {

	const image = carrier.feature
		&& carrier.feature.properties
		&& carrier.feature.properties.uca_maps
		&& carrier.feature.properties.uca_maps.image

	if (!image || !image.corners || carrier._uca_maps_overlay || carrier._uca_maps_overlay_pending) {
		return null
	}

	// the ONE funnel both an upload and a reload pass through, so it is where
	// the carrier stops being an editable polygon for Geoman and starts
	// carrying the picture with it when dragged (image_edit.js)
	seal_carrier_from_geoman(carrier)
	attach_carrier_drag(self, carrier)

	// CLAIM THE CARRIER BEFORE THE FIRST await. `hydrate_image_overlays` runs
	// un-serialized on every `updated_layer_data_` event, and the plugin load
	// below suspends: without this flag a geometry edit during that window
	// starts a SECOND rebuild that passes the `_uca_maps_overlay` guard (still
	// unset) and paints a duplicate overlay only one of which anything can
	// then reach.
	carrier._uca_maps_overlay_pending = true

	try {
		await load_rotated_overlay()
	} catch (error) {
		delete carrier._uca_maps_overlay_pending
		throw error
	}

	// the tool may have been torn down while the plugin was loading
	if (!self.geolocation || !self.geolocation.map) {
		delete carrier._uca_maps_overlay_pending
		return null
	}

	const overlay = L.imageOverlay.rotated(
		image_url(image),
		image.corners.top_left,
		image.corners.top_right,
		image.corners.bottom_left,
		{
			opacity		: typeof image.opacity==='number' ? image.opacity : DEFAULT_IMAGE_OPACITY,
			zIndex		: typeof image.z_index==='number' ? image.z_index : DEFAULT_IMAGE_Z_INDEX,
			// the CARRIER takes the clicks; two interactive stacked targets
			// would fight over them. `interactive:false` stops Leaflet firing
			// LAYER events but does not stop the div receiving the pointer at
			// all — the class carries the `pointer-events:none` that does
			// (tool_uca_maps.less), or the picture would sit on top of its own
			// selection handle
			interactive	: false,
			className	: 'uca-maps-image-overlay'
		}
	)

	overlay.addTo(self.geolocation.map)

	delete carrier._uca_maps_overlay_pending
	carrier._uca_maps_overlay = overlay
	// tracked as a PAIR, not as a bare overlay: the sweep in
	// hydrate_image_overlays needs to know which carrier each one belongs to
	self._image_overlays = self._image_overlays || []
	self._image_overlays.push({carrier, overlay})

	// edit mode is stored, so an overlay rebuilt from saved data comes back
	// with the handles the user left showing (image_edit.js)
	if (is_image_editing(carrier)) {
		attach_handles(self, carrier)
	}

	if(SHOW_DEVELOPER===true) {
		console.log('-> tool_uca_maps image overlay added:', image);
	}

	return overlay
}//end attach_overlay



/**
* DETACH_OVERLAY
* The reverse, for one carrier — used when the user deletes the object and by
* the teardown sweep. Removing the carrier alone would leave the image
* painted on a map with nothing to select it by.
*
* @param {Object} self - tool_uca_maps instance
* @param {Object} carrier
* @returns {void}
*/
export const detach_overlay = function(self, carrier) {

	// the handles come off even when there is no overlay left to move: they
	// are markers on the map, and nothing else in the engine tracks them
	detach_handles(self, carrier)
	detach_carrier_drag(carrier)

	const overlay = carrier && carrier._uca_maps_overlay
	if (!overlay) {
		return
	}

	if (self.geolocation && self.geolocation.map) {
		self.geolocation.map.removeLayer(overlay)
	}
	if (Array.isArray(self._image_overlays)) {
		self._image_overlays = self._image_overlays.filter((el) => el.overlay!==overlay)
	}
	delete carrier._uca_maps_overlay

}//end detach_overlay



/**
* SET_IMAGE_DISPLAY
* Opacity/z-index writer for the console panel (functionality #3's image
* branch). Writes BOTH the live overlay and the stored descriptor: the first
* is what the user sees now, the second is what survives the save — the same
* two-step every other console setter in this tool does.
*
* `do_commit` is false while a slider is being DRAGGED and true when it is
* released: `commit()` re-renders the panel (it has to — a committed change
* can move other fields), and re-rendering an <input type=range> mid-drag
* replaces the very node the pointer is holding.
*
* @param {Object} self - tool_uca_maps instance
* @param {Object} carrier
* @param {Object} values - {opacity?: number, z_index?: number}
* @param {boolean} do_commit - mark the record dirty and re-render
* @returns {void}
*/
export const set_image_display = function(self, carrier, values, do_commit) {

	const image = carrier.feature.properties.uca_maps.image
	const overlay = carrier._uca_maps_overlay

	if (typeof values.opacity==='number' && Number.isFinite(values.opacity)) {
		image.opacity = Math.min(1, Math.max(0, values.opacity))
		if (overlay) {
			overlay.setOpacity(image.opacity)
		}
	}

	if (typeof values.z_index==='number' && Number.isFinite(values.z_index)) {
		image.z_index = Math.trunc(values.z_index)
		if (overlay) {
			overlay.setZIndex(image.z_index)
		}
	}

	if (do_commit===true) {
		commit(self, carrier)
	}

}//end set_image_display



/**
* GET_IMAGE_HREF
* The "Ver imagen" target (v6 `special_tools.js:6453`). Exported rather than
* inlined in the renderer so the URL is built in exactly one place.
*
* @param {Object} carrier
* @returns {string|null}
*/
export const get_image_href = function(carrier) {

	const image = carrier
		&& carrier.feature
		&& carrier.feature.properties
		&& carrier.feature.properties.uca_maps
		&& carrier.feature.properties.uca_maps.image

	return image ? image_url(image) : null
}//end get_image_href



/**
* HYDRATE_IMAGE_OVERLAYS
* Rebuilds every stored overlay across the FeatureGroups. Walks them here
* rather than riding `object_console.js`'s own `reapply_all` pass: that would
* make the two modules import each other, and this hydration is asynchronous
* (the plugin loads on demand) while every reapply_* there is synchronous.
*
* @param {Object} self - tool_uca_maps instance
* @returns {Promise<number>} how many overlays were rebuilt
*/
export const hydrate_image_overlays = async function(self) {

	const feature_groups = self.geolocation && self.geolocation.FeatureGroup
	if (!feature_groups) {
		return 0
	}

	const carriers = []
	for (const layer_id in feature_groups) {
		feature_groups[layer_id].eachLayer((layer) => {
			const properties = layer.feature && layer.feature.properties
			if (properties && properties.uca_maps && properties.uca_maps.image) {
				carriers.push(layer)
			}
		})
	}

	// SWEEP FIRST. `layers_loader` rebuilds a FeatureGroup wholesale on a
	// layer switch/reload without ever firing 'pm:remove', so the carriers
	// this tool attached overlays to are simply replaced by new objects. The
	// old overlays are NOT drawn objects — nothing in the engine tracks them —
	// so without this they stay painted on the map and the rebuild below
	// stacks a second copy of every image on top.
	const live = new Set(carriers)
	for (const entry of (self._image_overlays || [])) {
		if (!live.has(entry.carrier)) {
			if (self.geolocation && self.geolocation.map) {
				self.geolocation.map.removeLayer(entry.overlay)
			}
			// the replaced carrier's handles are as orphaned as its overlay
			detach_handles(self, entry.carrier)
			detach_carrier_drag(entry.carrier)
			delete entry.carrier._uca_maps_overlay
		}
	}
	self._image_overlays = (self._image_overlays || []).filter((entry) => live.has(entry.carrier))

	let rebuilt = 0
	for (const carrier of carriers) {
		const overlay = await attach_overlay(self, carrier)
		if (overlay) {
			rebuilt++
		}
	}

	return rebuilt
}//end hydrate_image_overlays



/**
* ATTACH_IMAGE_OVERLAYS
* The image half's own lifecycle hook. NOT a toolbar entry — the row's button
* is the one `vector_upload.js` builds — but the overlays need the same
* attach/detach discipline every other feature here has: rebuild what was
* saved, follow the data while the tool is open, remove everything on close.
*
* Two subscriptions, both mirroring what `object_console.js` already does for
* its own state: `updated_layer_data_<id_base>` fires on every geometry
* create/edit/load, which is when a carrier can appear; `pm:remove` is when
* one goes away and its image must go with it. Idempotent.
*
* @param {Object} self - tool_uca_maps instance
* @returns {void}
*/
export const attach_image_overlays = function(self) {

	if (self._image_overlay_remove_handler || !self.geolocation || !self.geolocation.map) {
		return
	}

	self._image_overlays = self._image_overlays || []

	self._image_overlay_remove_handler = (event) => {
		if (event.layer) {
			detach_overlay(self, event.layer)
		}
	}
	self.geolocation.map.on('pm:remove', self._image_overlay_remove_handler)

	// both calls are deliberately not awaited (a Leaflet event handler and an
	// attach step, neither of which can block), so both need their own
	// rejection handler — the plugin load can fail, and a detached rejection
	// is invisible
	const rebuild = () => {
		hydrate_image_overlays(self).catch((error) => {
			console.error('tool_uca_maps: image overlays could not be rebuilt', error)
			report_client_error((error && error.message) || 'Image overlays could not be rebuilt')
		})
	}

	self._image_overlay_token = event_manager.subscribe(
		'updated_layer_data_' + self.geolocation.id_base,
		rebuild
	)

	rebuild()

}//end attach_image_overlays



/**
* DETACH_IMAGE_OVERLAYS
* Teardown: every overlay this tool put on the map comes off with it. An
* overlay is NOT a drawn object, so nothing else in the engine knows it is
* there — leaving one behind paints an image on a map the tool no longer
* owns (CLAUDE.local.md's "destrucción real al cerrar").
*
* @param {Object} self - tool_uca_maps instance
* @returns {void}
*/
export const detach_image_overlays = function(self) {

	const map = self.geolocation && self.geolocation.map

	if (self._image_overlay_remove_handler) {
		if (map) {
			map.off('pm:remove', self._image_overlay_remove_handler)
		}
		self._image_overlay_remove_handler = null
	}

	if (self._image_overlay_token) {
		event_manager.unsubscribe(self._image_overlay_token)
		self._image_overlay_token = null
	}

	for (const entry of (self._image_overlays || [])) {
		if (map) {
			map.removeLayer(entry.overlay)
		}
		detach_handles(self, entry.carrier)
		detach_carrier_drag(entry.carrier)
		delete entry.carrier._uca_maps_overlay
	}
	self._image_overlays = []

}//end detach_image_overlays



// @license-end
