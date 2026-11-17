// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global L, domtoimage, DEDALO_ROOT_WEB */
/*eslint no-undef: "error"*/

/**
 * MAP_IMAGE_DOWNLOAD
 * "Download map as image", v6's five formats. PNG is produced in the browser; JPG,
 * GIF, WebP and GeoTIFF need ImageMagick/GDAL, so the server converts the same PNG
 * capture (`raster_download`).
 */

import { report_client_error } from './client_error.js';
import { deliver_download, trigger_blob_download } from './download_delivery.js';
import {
	DEFAULT_MAP_IMAGE_NAME,
	name_required_text,
	sanitize_download_name,
	with_extension,
} from './download_filename.js';
import { exception_text } from './panel_error_text.js';
import { render_map_image_download_panel } from './render_map_image_download.js';
import { CONVERSION_TIMEOUT_MS } from './request_budgets.js';
import {
	create_toolbar_button,
	create_toolbar_panel,
	is_toolbar_node,
	is_toolbar_panel_visible,
	remove_toolbar_button,
	remove_toolbar_panel,
	set_toolbar_panel_visible,
} from './toolbar.js';

/**
 * ATTACH_MAP_IMAGE_DOWNLOAD_CONTROL
 * Builds the toggle button and its panel. Idempotent.
 *
 * @param {Object} self - tool_uca_maps instance
 * @returns {void}
 */
export const attach_map_image_download_control = function (self) {
	if (self.map_image_control || !self.geolocation || !self.geolocation.map) {
		return;
	}

	const title = self.get_tool_label('map_image_download_title') || 'Download map as image';

	self.map_image_control = create_toolbar_button(self, {
		title: title,
		icon: 'download',
		class_name: 'uca-maps-map-image-control',
		on_click: () => toggle_map_image_panel(self),
	});

	self.map_image_panel = create_toolbar_panel(self, {
		class_name: 'uca-maps-map-image-panel',
		centered: true,
		title: title,
	});
	render_map_image_download_panel(self, self.map_image_panel);

	// the base map can change while the panel is open: the warning follows it
	self._map_image_layers_handler = () => {
		if (is_toolbar_panel_visible(self.map_image_panel)) {
			refresh_direct_layer_warning(self);
		}
	};
	self.geolocation.map.on('layeradd layerremove', self._map_image_layers_handler);
}; //end attach_map_image_download_control

/**
 * TOGGLE_MAP_IMAGE_PANEL
 * Reads the panel's real state, never a flag: a sibling opening closes this one
 * without passing here.
 *
 * @param {Object} self - tool_uca_maps instance
 * @returns {void}
 */
const toggle_map_image_panel = function (self) {
	const next_visible = !is_toolbar_panel_visible(self.map_image_panel);
	if (next_visible) {
		refresh_direct_layer_warning(self);
	}
	set_toolbar_panel_visible(self, self.map_image_panel, self.map_image_control, next_visible);
}; //end toggle_map_image_panel

/**
 * DIRECT_TILE_LAYER_NAMES
 * The tile layers on the map that load straight from their provider (another origin):
 * the page's CSP keeps the capture from reading their tiles, so the image cannot include
 * them. Told by origin, never by name: ARCGIS without its configured source, DARE, OSM
 * where the server lists it as direct. Named as the layer control lists them.
 *
 * @param {Object} self - tool_uca_maps instance
 * @returns {Array<string>} plain-text names, each once
 */
// exported for the client gate
export const direct_tile_layer_names = function (self) {
	const geolocation = self.geolocation;
	const entries = geolocation.layer_control
		? Object.values(geolocation.layer_control._layers || {})
		: [];
	const names = new Set();

	geolocation.map.eachLayer((layer) => {
		if (!(layer instanceof L.TileLayer) || typeof layer._url !== 'string') {
			return;
		}
		let url;
		try {
			url = new URL(layer._url.replace(/[{}]/g, ''), window.location.href);
		} catch {
			return;
		}
		if (
			(url.protocol !== 'http:' && url.protocol !== 'https:') ||
			url.origin === window.location.origin
		) {
			return;
		}
		const entry = entries.find((item) => item.layer === layer);
		// the control's names are escaped HTML: read back as text
		const name = entry
			? new DOMParser().parseFromString(String(entry.name), 'text/html').body.textContent.trim()
			: '';
		names.add(name !== '' ? name : url.hostname);
	});

	return Array.from(names);
}; //end direct_tile_layer_names

/**
 * REFRESH_DIRECT_LAYER_WARNING
 * The panel's standing warning: which active layers the image will leave out. The
 * download stays allowed (drawings and legend are still worth it), and those tiles
 * come out as plain background (`imagePlaceholder`), not as broken images.
 *
 * @param {Object} self - tool_uca_maps instance
 * @returns {void}
 */
const refresh_direct_layer_warning = function (self) {
	const line = self._map_image_direct_line;
	if (!line || !self.geolocation || !self.geolocation.map) {
		return;
	}

	const names = direct_tile_layer_names(self);
	if (names.length === 0) {
		line.hidden = true;
		line.textContent = '';
		return;
	}

	const template =
		self.get_tool_label('map_image_direct_layer') ||
		'The base layer «{name}» cannot be included in the image: it loads directly from its provider. To include it, an administrator can configure it for the section, or you can add it to this record from the XYZ panel.';
	line.textContent = template.replace('{name}', names.join('», «'));
	line.dataset.type = 'warning';
	line.hidden = false;
}; //end refresh_direct_layer_warning

/**
 * DETACH_MAP_IMAGE_DOWNLOAD_CONTROL
 * Removes the button and its panel.
 *
 * @param {Object} self - tool_uca_maps instance
 * @returns {void}
 */
export const detach_map_image_download_control = function (self) {
	if (self._map_image_layers_handler && self.geolocation && self.geolocation.map) {
		self.geolocation.map.off('layeradd layerremove', self._map_image_layers_handler);
	}
	remove_toolbar_button(self, self.map_image_control);
	remove_toolbar_panel(self, self.map_image_panel);

	self.map_image_control = null;
	self.map_image_panel = null;
	self._map_image_direct_line = null;
	self._map_image_layers_handler = null;
}; //end detach_map_image_download_control

let dom_to_image_load_promise = null;

/** A 1x1 transparent GIF: what the capture paints for a tile it cannot read. */
// exported for the client gate
export const TRANSPARENT_PIXEL =
	'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

/**
 * LOAD_DOM_TO_IMAGE
 * A classic `<script>`, not `import()`: the UMD bundle assigns `this.domtoimage`, and
 * a module's top-level `this` is undefined. The cached promise keeps a second call
 * from injecting a second tag.
 *
 * @returns {Promise<void>}
 */
const load_dom_to_image = function () {
	if (typeof domtoimage !== 'undefined') {
		return Promise.resolve();
	}

	if (!dom_to_image_load_promise) {
		dom_to_image_load_promise = new Promise((resolve, reject) => {
			const script = document.createElement('script');
			script.src = DEDALO_ROOT_WEB + '/lib/dom-to-image/dist/dom-to-image-more.min.js';
			script.onload = () => resolve();
			script.onerror = () => reject(new Error('tool_uca_maps: failed to load dom-to-image-more'));
			document.head.appendChild(script);
		});
	}

	return dom_to_image_load_promise;
}; //end load_dom_to_image

/**
 * PROJECTED_BOUNDS
 * The viewport corners in Web Mercator meters (Leaflet's own projection). The
 * screenshot's pixels are uniform in meters, not degrees, so these corners georeference
 * it without a resample; v6's degree corners drift off the equator.
 *
 * @param {Object} map - the live Leaflet map instance
 * @returns {{west:number, north:number, east:number, south:number}} EPSG:3857 meters
 */
const projected_bounds = function (map) {
	const bounds = map.getBounds();
	const north_west = L.CRS.EPSG3857.project(bounds.getNorthWest());
	const south_east = L.CRS.EPSG3857.project(bounds.getSouthEast());

	return {
		west: north_west.x,
		north: north_west.y,
		east: south_east.x,
		south: south_east.y,
	};
}; //end projected_bounds

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
export const keep_in_map_image = function (self, node) {
	if (is_toolbar_node(self, node)) {
		return false;
	}
	if (!node.classList || !node.classList.contains('leaflet-control')) {
		return true;
	}

	return (
		node.classList.contains('leaflet-control-attribution') ||
		(self.scale_control != null && node === self.scale_control.getContainer()) ||
		(self.legend_overlay != null && node === self.legend_overlay.getContainer())
	);
}; //end keep_in_map_image

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
export const download_map_image = async function (
	self,
	format,
	file_name = DEFAULT_MAP_IMAGE_NAME,
) {
	if (!self.geolocation || !self.geolocation.map) {
		return { ok: false };
	}

	const base_name = sanitize_download_name(file_name);
	if (base_name === '') {
		return { ok: false, error: name_required_text(self) };
	}

	const failed =
		self.get_tool_label('map_image_download_error_failed') ||
		'The map image could not be downloaded.';

	try {
		await load_dom_to_image();

		const container = self.geolocation.map.getContainer();
		// width/height as v6, not its cacheBust: the tile proxy refuses a stamped tile
		// (closed grammar), and its same-origin tiles need no interceptor. Geoman's
		// toolbar stays out: dom-to-image-more fetches its icons' `url(#…)`. filterUrls:
		// a relative URL with no base is an unresolved custom property, never painted.
		// imagePlaceholder: a tile it cannot read (a direct provider) is plain background.
		const capture_options = {
			width: container.offsetWidth,
			height: container.offsetHeight,
			filter: (node) => keep_in_map_image(self, node),
			filterUrls: (url, base_url) => Boolean(base_url) || /^[a-z][a-z0-9+.-]*:/i.test(url),
			imagePlaceholder: TRANSPARENT_PIXEL,
		};

		if (format === 'png') {
			const blob = await domtoimage.toBlob(container, capture_options);
			trigger_blob_download(blob, with_extension(base_name, 'png'));
			return { ok: true };
		}

		// JPG/GIF/WebP/GeoTIFF all need the server (ImageMagick/GDAL are not a
		// browser capability) — one PNG capture feeds every one of them.
		const data_url = await domtoimage.toPng(container, capture_options);
		const image_base64 = data_url.slice(data_url.indexOf(',') + 1);

		const response = await self.tool_request({
			action: 'raster_download',
			retries: 1,
			timeout: CONVERSION_TIMEOUT_MS,
			busy_notice: true,
			options: {
				tipo: self.geolocation.tipo,
				section_id: self.geolocation.section_id,
				section_tipo: self.geolocation.section_tipo,
				format: format,
				file_name: base_name,
				image_base64: image_base64,
				bounds: format === 'geotiff' ? projected_bounds(self.geolocation.map) : undefined,
			},
		});

		return await deliver_download(response, failed);
	} catch (error) {
		console.error('tool_uca_maps: download_map_image failed unexpectedly', error);
		report_client_error((error && error.message) || 'Map image download failed');
		return { ok: false, error: exception_text(error, failed) };
	}
}; //end download_map_image

// @license-end
