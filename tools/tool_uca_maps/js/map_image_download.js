// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global L, domtoimage */
/*eslint no-undef: "error"*/



/**
* MAP_IMAGE_DOWNLOAD
* "Download map as image", v6's five formats. PNG is produced in the browser; JPG,
* GIF, WebP and GeoTIFF need ImageMagick/GDAL, so the server converts the same PNG
* capture (`raster_download`).
*/



import {exception_text} from './tool_error_text.js'
import {trigger_blob_download, deliver_download, report_client_error} from './object_console.js'
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
import {
	DEFAULT_MAP_IMAGE_NAME,
	sanitize_download_name,
	with_extension
} from './download_filename.js'



/**
* ATTACH_MAP_IMAGE_DOWNLOAD_CONTROL
* Builds the toggle button and its panel. Idempotent.
*
* @param {Object} self - tool_uca_maps instance
* @returns {void}
*/
export const attach_map_image_download_control = function(self) {

	if (self.map_image_control || !self.geolocation || !self.geolocation.map) {
		return
	}

	const title = self.get_tool_label('map_image_download_title') || 'Download map as image'

	self.map_image_control = create_toolbar_button(self, {
		title		: title,
		icon		: 'download',
		class_name	: 'uca-maps-map-image-control',
		on_click	: () => toggle_map_image_panel(self)
	})

	self.map_image_panel = create_toolbar_panel(self, {
		class_name	: 'uca-maps-map-image-panel',
		centered	: true,
		title		: title
	})
	render_map_image_download_panel(self, self.map_image_panel)

}//end attach_map_image_download_control



/**
* TOGGLE_MAP_IMAGE_PANEL
* Reads the panel's real state, never a flag: a sibling opening closes this one
* without passing here.
*
* @param {Object} self - tool_uca_maps instance
* @returns {void}
*/
const toggle_map_image_panel = function(self) {
	set_toolbar_panel_visible(self, self.map_image_panel, self.map_image_control, !is_toolbar_panel_visible(self.map_image_panel))
}//end toggle_map_image_panel



/**
* DETACH_MAP_IMAGE_DOWNLOAD_CONTROL
* Removes the button and its panel.
*
* @param {Object} self - tool_uca_maps instance
* @returns {void}
*/
export const detach_map_image_download_control = function(self) {

	remove_toolbar_button(self, self.map_image_control)
	remove_toolbar_panel(self, self.map_image_panel)

	self.map_image_control			= null
	self.map_image_panel			= null

}//end detach_map_image_download_control



let dom_to_image_load_promise = null

/**
* LOAD_DOM_TO_IMAGE
* A classic `<script>`, not `import()`: the UMD bundle assigns `this.domtoimage`, and
* a module's top-level `this` is undefined. The cached promise keeps a second call
* from injecting a second tag.
*
* @returns {Promise<void>}
*/
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
* The viewport corners in Web Mercator meters (Leaflet's own projection). The
* screenshot's pixels are uniform in meters, not degrees, so these corners georeference
* it without a resample; v6's degree corners drift off the equator.
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
* KEEP_IN_MAP_IMAGE
* The capture's `filter` (called on each original node, never the root). Map
* content stays; every Leaflet control is UI and goes, except the three that
* belong to a cartographic image: scale, legend and the attribution the tile
* licence asks for. A control added later stays out until it is named here.
*
* @param {Object} self - tool_uca_maps instance
* @param {Node} node
* @returns {boolean} false drops the node and its subtree
*/
// exported for the client gate
export const keep_in_map_image = function(self, node) {

	if (is_toolbar_node(self, node)) {
		return false
	}
	if (!node.classList || !node.classList.contains('leaflet-control')) {
		return true
	}

	return node.classList.contains('leaflet-control-attribution')
		|| (self.scale_control!=null && node===self.scale_control.getContainer())
		|| (self.legend_overlay!=null && node===self.legend_overlay.getContainer())
}//end keep_in_map_image



/**
* DOWNLOAD_MAP_IMAGE
* Captures the map's content, never the controls around it (`keep_in_map_image`):
* our panels are large overlays that would be baked into the image. Never silent: a
* failure comes back as the text for the panel's line, and a client-side throw is
* also reported.
*
* @param {Object} self - tool_uca_maps instance
* @param {'png'|'jpg'|'gif'|'webp'|'geotiff'} format
* @param {string} [file_name] - the user's own name for the file (panel
*   field, v6 parity). OMITTED and EMPTY are different: a caller that passes
*   nothing gets the default base name, an empty field is refused the way v6
*   refuses it ("Por favor, indique un nombre para el archivo").
* @returns {Promise<{ok: boolean, error?: string}>} `error`: an empty name, a
*   server refusal or a client-side throw, for the panel's line
*/
export const download_map_image = async function(self, format, file_name=DEFAULT_MAP_IMAGE_NAME) {

	if (!self.geolocation || !self.geolocation.map) {
		return {ok: false}
	}

	const base_name = sanitize_download_name(file_name)
	if (base_name==='') {
		return {ok: false, error: self.get_tool_label('map_image_name_required') || 'Please enter a name for the file'}
	}

	const failed = self.get_tool_label('map_image_download_error_failed') || 'The map image could not be downloaded.'

	try {

		await load_dom_to_image()

		const container			= self.geolocation.map.getContainer()
		// cacheBust + width/height as v6 (`domtoimage.toPng`). Geoman's toolbar stays
		// out: dom-to-image-more fetches the `url(#…)` in its SVG icons. filterUrls: a
		// relative URL with no base is an unresolved custom property, never painted.
		const capture_options	= {
			cacheBust	: true,
			width		: container.offsetWidth,
			height		: container.offsetHeight,
			filter		: (node) => keep_in_map_image(self, node),
			filterUrls	: (url, base_url) => Boolean(base_url) || /^[a-z][a-z0-9+.-]*:/i.test(url)
		}

		if (format==='png') {
			const blob = await domtoimage.toBlob(container, capture_options)
			trigger_blob_download(blob, with_extension(base_name, 'png'))
			return {ok: true}
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
				file_name		: base_name,
				image_base64	: image_base64,
				bounds			: format==='geotiff' ? projected_bounds(self.geolocation.map) : undefined
			}
		})

		return await deliver_download(response, failed)

	} catch (error) {
		console.error('tool_uca_maps: download_map_image failed unexpectedly', error)
		report_client_error((error && error.message) || 'Map image download failed')
		return {ok: false, error: exception_text(error, failed)}
	}
}//end download_map_image



// @license-end
