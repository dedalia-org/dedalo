// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global L, domtoimage */
/*eslint no-undef: "error"*/



/**
* MAP_IMAGE_DOWNLOAD
*
* Hito 3, checkpoint 3b: functionality #10 of
* `docs/Funcionalidades de tool_leaflet_special_tools.md` ("Download map as
* image") — a MAP-WIDE action, unlike checkpoint 3a's `download_vector`
* (per-object). v6 offers 5 formats (GeoTIFF/PNG/JPG/GIF/WebP); this port
* keeps all 5 (Sergio, plan approval: cheap given ImageMagick is already
* wired for `get_capabilities`, closes the whole audit row in one hito
* instead of half now and half in hito 7).
*
* PNG stays 100% client-side, same principle as 2b/3a's GeoJSON: no server
* round-trip for a format the browser already produces natively. JPG/GIF/
* WebP/GeoTIFF need real conversion (ImageMagick / GDAL are not a browser
* capability) — server action `raster_download` (`server/raster_download.ts`).
*
* TOOLBAR REFACTOR (2026-09-04, before hito 4 — CLAUDE.local.md "Left
* toolbar: un botón por funcionalidad"): this functionality used to be a
* collapsed section inside the "UCA" object-console panel
* (`object_console.js`). It now gets its OWN toggle button + OWN panel
* (`attach_map_image_download_control`/`detach_map_image_download_control`,
* below), built through `toolbar.js` — the same substrate every other
* functionality's button/panel now goes through.
*/



import {response_data} from '../../../core/common/js/api_error.js'
import {handle_api_error} from '../../../core/common/js/error_dispatch.js'
import {trigger_blob_download, base64_to_blob, report_client_error} from './object_console.js'
import {
	create_toolbar_button,
	create_toolbar_panel,
	set_toolbar_panel_visible,
	is_toolbar_panel_visible,
	remove_toolbar_button,
	remove_toolbar_panel,
	is_toolbar_node
} from './toolbar.js'
import {render_map_image_download_panel} from './render_map_image_download.js'



/**
* ATTACH_MAP_IMAGE_DOWNLOAD_CONTROL
* Builds the "Download map as image" toggle button + panel (functionality
* #10 — see file header). Idempotent — a stray second call (e.g. a refresh)
* never attaches a duplicate control or panel.
*
* @param {Object} self - tool_uca_maps instance
* @returns {void}
*/
export const attach_map_image_download_control = function(self) {

	if (self.map_image_control || !self.geolocation || !self.geolocation.map) {
		return
	}

	self.map_image_control = create_toolbar_button(self, {
		title		: self.get_tool_label('map_image_download_title') || 'Download map as image',
		text		: 'IMG',
		class_name	: 'uca-maps-map-image-control',
		on_click	: () => toggle_map_image_panel(self)
	})

	self.map_image_panel = create_toolbar_panel(self, {class_name: 'uca-maps-map-image-panel'})
	render_map_image_download_panel(self, self.map_image_panel)

}//end attach_map_image_download_control



/**
* TOGGLE_MAP_IMAGE_PANEL
* Reads the panel's own current state, never a cached flag — see
* toolbar.js `is_toolbar_panel_visible` file comment: a SIBLING panel
* opening (mutual exclusion, 2026-09-04) can close this one without going
* through this function at all.
*
* @param {Object} self - tool_uca_maps instance
* @returns {void}
*/
const toggle_map_image_panel = function(self) {
	self.map_image_panel_visible = !is_toolbar_panel_visible(self.map_image_panel)
	set_toolbar_panel_visible(self, self.map_image_panel, self.map_image_control, self.map_image_panel_visible)
}//end toggle_map_image_panel



/**
* DETACH_MAP_IMAGE_DOWNLOAD_CONTROL
* Real teardown (CLAUDE.local.md "destrucción real") — called from
* `tool_uca_maps.prototype.destroy()` alongside `detach_console`/
* `detach_capabilities_panel`.
*
* @param {Object} self - tool_uca_maps instance
* @returns {void}
*/
export const detach_map_image_download_control = function(self) {

	remove_toolbar_button(self, self.map_image_control)
	remove_toolbar_panel(self, self.map_image_panel)

	self.map_image_control			= null
	self.map_image_panel			= null
	self.map_image_panel_visible	= false

}//end detach_map_image_download_control



/**
* LOAD_DOM_TO_IMAGE
* Loads the vendored `dom-to-image-more` UMD bundle
* (`js/lib/dom-to-image-more/dom-to-image-more.min.js`) as a CLASSIC
* `<script>` — deliberately NOT `await import(...)` (tool_qr's own pattern
* for its vendored EasyQRCodeJS). Verified live in real headless Chrome
* during 3b's implementation: the library attaches itself with
* `this.domtoimage = …` at ITS OWN top level, and a dynamically `import()`ed
* file is always evaluated as an ES MODULE — whose top-level `this` is
* `undefined` by spec, in every browser, not a quirk of this one — so
* `import()`ing this exact file throws `Cannot set properties of undefined
* (setting 'domtoimage')`. A classic script's top-level `this` IS `window`
* (also spec, also verified), which is what the library's UMD wrapper was
* written for — long before dynamic `import()` existed. Idempotent (cached
* promise): a second call while the first is still loading — or after it
* finished — never injects a second `<script>` tag.
*
* @returns {Promise<void>}
*/
let dom_to_image_load_promise = null

const load_dom_to_image = function() {

	if (typeof domtoimage!=='undefined') {
		return Promise.resolve()
	}

	if (!dom_to_image_load_promise) {
		dom_to_image_load_promise = new Promise((resolve, reject) => {
			const script	= document.createElement('script')
			script.src		= new URL('./lib/dom-to-image-more/dom-to-image-more.min.js', import.meta.url).href
			script.onload	= () => resolve()
			script.onerror	= () => reject(new Error('tool_uca_maps: failed to load dom-to-image-more'))
			document.head.appendChild(script)
		})
	}

	return dom_to_image_load_promise
}//end load_dom_to_image



/**
* PROJECTED_BOUNDS
* The map's current viewport bounds (WGS84, what `map.getBounds()` returns),
* converted to the ACTUAL Web Mercator meters the captured screenshot's pixel
* grid represents — `L.CRS.EPSG3857.project(latlng)`, Leaflet's own
* projection (no reimplementing the Web Mercator formula, no extra library).
*
* WHY THIS MATTERS (the "reproyectado de verdad" the plan asks for): a
* Leaflet map's on-screen pixel grid is uniform in WEB MERCATOR METERS, never
* in degrees — Mercator compresses degree-spacing away from the equator.
* Assigning the raw WGS84 corner DEGREES to that pixel grid (as if a degree
* were a constant pixel distance, v6's implicit assumption per the audit's
* bug #4) mislabels the georeference everywhere off the equator. Assigning
* the TRUE Mercator meter corners is the honest, undistorted georeference —
* no `gdalwarp` resample needed at all, because the pixels already ARE
* uniform in that CRS.
*
* @param {Object} map - the live Leaflet map instance
* @returns {{west:number, north:number, east:number, south:number}} EPSG:3857 meters
*/
const projected_bounds = function(map) {

	const bounds		= map.getBounds()
	const north_west	= L.CRS.EPSG3857.project(bounds.getNorthWest())
	const south_east	= L.CRS.EPSG3857.project(bounds.getSouthEast())

	return {
		west	: north_west.x,
		north	: north_west.y,
		east	: south_east.x,
		south	: south_east.y
	}
}//end projected_bounds



/**
* DOWNLOAD_MAP_IMAGE
* Captures the live map's container — everything visible EXCEPT this tool's
* own UI chrome (every toolbar button/panel this tool owns, `filter` below).
* Validated live by Sergio (2026-09-03): without the filter, the "UCA" panel
* itself was baked into the exported image — v6's own equivalent
* is a small icon-only toolbar that happened not to read as intrusive in a
* screenshot, but that is an accident of its shape, not a behaviour worth
* porting; our panel is a large floating overlay and DOES intrude. Excluding
* our own nodes from a screenshot of the user's map is correct regardless of
* what v6 did.
*
* Never silent on failure (same discipline as `download_vector`, 3a
* review-diff finding): the whole body is a try/catch; a server-reported
* failure goes through `handle_api_error` (a real toast), and an unexpected
* CLIENT-side exception (dom-to-image-more failing to load, a CORS-tainted
* canvas from a cross-origin tile layer throwing a `SecurityError` on
* capture) goes through `report_client_error` instead of only
* `console.error` (review-diff finding, hito 3b: the original catch
* contradicted this very doc comment by only logging).
*
* @param {Object} self - tool_uca_maps instance
* @param {'png'|'jpg'|'gif'|'webp'|'geotiff'} format
* @returns {Promise<void>}
*/
export const download_map_image = async function(self, format) {

	if (!self.geolocation || !self.geolocation.map) {
		return
	}

	try {

		await load_dom_to_image()

		const container			= self.geolocation.map.getContainer()
		// cacheBust + explicit width/height: v6's own equivalent
		// (`special_tools_map_image_download.js`, `domtoimage.toPng`) passes the
		// same three options against the same kind of Leaflet pane — ported
		// verbatim, not reinvented.
		//
		// filter: dom-to-image-more calls this on every node in the cloned
		// subtree (never the root) and drops a node — and everything under it
		// — when it returns false. Excludes EVERY DOM root this tool itself
		// owns — every toolbar button and every panel, however many exist by
		// now (`toolbar.js` `is_toolbar_node`/`self._toolbar_nodes`) — not just
		// the two hardcoded references (`self.map_control`/`self.panel_node`)
		// this filter checked before the toolbar refactor (2026-09-04), which
		// would have silently stopped excluding the map-image/capabilities
		// buttons+panels the moment they existed.
		const capture_options	= {
			cacheBust	: true,
			width		: container.offsetWidth,
			height		: container.offsetHeight,
			filter		: (node) => !is_toolbar_node(self, node)
		}

		if (format==='png') {
			const blob = await domtoimage.toBlob(container, capture_options)
			trigger_blob_download(blob, 'uca_maps_map.png')
			return
		}

		// JPG/GIF/WebP/GeoTIFF all need the server (ImageMagick/GDAL are not a
		// browser capability) — one PNG capture feeds every one of them.
		const data_url		= await domtoimage.toPng(container, capture_options)
		const image_base64	= data_url.slice(data_url.indexOf(',') + 1)

		const response = await self.tool_request({
			action	: 'raster_download',
			options	: {
				tipo			: self.geolocation.tipo,
				section_id		: self.geolocation.section_id,
				section_tipo	: self.geolocation.section_tipo,
				format			: format,
				image_base64	: image_base64,
				bounds			: format==='geotiff' ? projected_bounds(self.geolocation.map) : undefined
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
		console.error('tool_uca_maps: download_map_image failed unexpectedly', error)
		report_client_error((error && error.message) || 'Map image download failed')
	}
}//end download_map_image



// @license-end
