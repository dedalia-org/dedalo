// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global it, describe, assert, L, domtoimage, DEDALO_CORE_URL */
/*eslint no-undef: "error"*/
'use strict';

/**
 * TEST_TOOL_UCA_MAPS_IMAGES
 * LIVE MAP (tool_uca_maps_fixture.js): the map as image, the object viewer, 1x1, and the upload
 * panel with the image overlays it lays on the map.
 */

import { data_manager } from '../../../core/common/js/data_manager.js';
import { event_manager } from '../../../core/common/js/event_manager.js';
import { error_text } from '../../../core/common/js/render_api_error.js';
import { DEFAULT_MAP_IMAGE_NAME } from '../../../tools/tool_uca_maps/js/download_filename.js';
import { hull_bounds } from '../../../tools/tool_uca_maps/js/image_edit.js';
import {
	corners_from_viewport,
	create_image_object,
	IMAGE_COMPONENT_TIPO,
	IMAGE_DOWNLOAD_TIMEOUT_MS,
	IMAGE_SECTION_TIPO,
	image_download_width,
	ingest_image_upload,
} from '../../../tools/tool_uca_maps/js/image_upload.js';
import {
	detach_map_image_download_control,
	direct_tile_layer_names,
	download_map_image,
	keep_in_map_image,
	TRANSPARENT_PIXEL,
} from '../../../tools/tool_uca_maps/js/map_image_download.js';
import {
	apply_display,
	detach_console,
	toggle_centroid,
} from '../../../tools/tool_uca_maps/js/object_console.js';
import {
	associate_image,
	import_linked_images,
	object_images,
} from '../../../tools/tool_uca_maps/js/object_image.js';
import {
	center_on_object,
	collect_objects,
	set_object_display,
} from '../../../tools/tool_uca_maps/js/object_viewer.js';
import {
	create_onexone_rectangle,
	is_onexone_enabled,
} from '../../../tools/tool_uca_maps/js/onexone.js';
import { UPLOAD_MESSAGE_MS } from '../../../tools/tool_uca_maps/js/render_file_upload.js';
import { rotated_image_overlay } from '../../../tools/tool_uca_maps/js/rotated_image_overlay.js';
import { tool_uca_maps } from '../../../tools/tool_uca_maps/js/tool_uca_maps.js';
import { MAP_IMAGE_KEY_DIR } from '../../../tools/tool_uca_maps/js/upload_formats.js';
import { detach_file_upload } from '../../../tools/tool_uca_maps/js/vector_upload.js';
import {
	capture_download,
	IMAGE_DESCRIPTOR,
	image_descriptor,
	layer_by_uid,
	load_file,
	one_pixel_png,
	pick_file,
	staged_answer,
	stub_image_download,
	tick,
	toasts_during,
	until,
	use_live_map,
} from './tool_uca_maps_fixture.js';

/**
 * Runs `fn` with domtoimage.toBlob stubbed to answer `capture` (a 1-byte PNG Blob
 * by default), and puts the library back exactly as found, loaded or not. Returns
 * the node and options toBlob saw, null if it never ran.
 * @returns {Promise<{node: Element, options: object}|null>}
 */
const with_to_blob_stub = async function (fn, capture = new Blob(['x'], { type: 'image/png' })) {
	const had_library = Object.hasOwn(window, 'domtoimage');
	if (!had_library) window.domtoimage = {};
	const library = window.domtoimage;
	const had_to_blob = Object.hasOwn(library, 'toBlob');
	const real_to_blob = library.toBlob;
	let seen = null;
	library.toBlob = async function (node, options) {
		seen = { node, options };
		return capture;
	};
	try {
		await fn();
	} finally {
		if (!had_library) {
			// biome-ignore lint/performance/noDelete: restores the global's absence: the library was not loaded before
			delete window.domtoimage;
		} else if (had_to_blob) {
			library.toBlob = real_to_blob;
		} else {
			// biome-ignore lint/performance/noDelete: restores the method's absence on the library
			delete library.toBlob;
		}
	}
	return seen;
}; //end with_to_blob_stub

/**
 * create_image_object ends in map.fitBounds(), which starts a ZOOM ANIMATION.
 * A test ending with the frame still queued hands afterEach a map it destroys
 * under a pending _move(), and Leaflet throws inside the NEXT test's beforeEach.
 */
const settle_map = function (map) {
	return new Promise((resolve) => {
		const settled = () => resolve();
		map.once('moveend', settled);
		setTimeout(settled, 1000); // fitBounds on an already-matching view fires nothing
	});
};

const vector_file = () => new File(['{}'], 'plan.geojson', { type: 'application/geo+json' });
const image_file = () => new File(['x'], 'plan.png', { type: 'image/png' });

/** One drawable point, what the real vector upload round trip sends. */
const SAMPLE_UPLOAD_GEOJSON = {
	type: 'FeatureCollection',
	features: [
		{
			type: 'Feature',
			properties: {},
			geometry: { type: 'Point', coordinates: [-3.65, 40.45] },
		},
	],
};
const sample_vector_file = () =>
	new File([JSON.stringify(SAMPLE_UPLOAD_GEOJSON)], 'test.geojson', {
		type: 'application/geo+json',
	});

describe('TOOL_UCA_MAPS (live map: images)', function () {
	this.timeout(20000);

	let geolocation, tool;
	const {
		BLANK_TILE,
		real_tool_request,
		stub_tool_request,
		seeded_layer,
		active_group,
		select_carrier,
		stub_linked_import,
		add_image_carrier,
		requests_sent_by,
	} = use_live_map((mounted) => ({ geolocation, tool } = mounted));

	/** Every URL dom-to-image-more asks for while `capture` runs (it fetches by XHR). */
	const xhr_urls_during = async function (capture) {
		const requested = [];
		const original_open = XMLHttpRequest.prototype.open;
		XMLHttpRequest.prototype.open = function (method, url, ...rest) {
			requested.push(String(url));
			return original_open.call(this, method, url, ...rest);
		};
		try {
			await capture();
		} finally {
			XMLHttpRequest.prototype.open = original_open;
		}
		return requested;
	}; //end xhr_urls_during

	/** What a real PNG download asks for: none at all would make a clean list prove nothing. */
	const capture_png_requests = async function () {
		let blob;
		const requested = await xhr_urls_during(async () => {
			blob = (await capture_download(() => download_map_image(tool, 'png'))).blob;
		});
		assert.isOk(blob, 'expected the capture to finish');
		assert.isAbove(requested.length, 0, 'expected the capture to fetch by XHR at all');
		return requested;
	}; //end capture_png_requests

	/** The same map with both of download_map_image's guards open: the control a clean list needs. */
	const capture_unguarded_requests = function () {
		return xhr_urls_during(() =>
			domtoimage.toBlob(geolocation.map.getContainer(), {
				filter: () => true,
				filterUrls: () => true,
			}),
		);
	}; //end capture_unguarded_requests

	// the hydration places the overlay synchronously; awaited anyway, so no test
	// depends on that
	const await_overlay = (carrier) => until(() => carrier._uca_maps_overlay);

	const add_image_carrier_with_overlay = async function () {
		const carrier = add_image_carrier();
		tool.attach_image_overlays();
		await await_overlay(carrier);
		return carrier;
	};

	// MAP AS IMAGE (map_image_download.js) — its own button and panel: PNG is
	// captured in the browser, the other formats are converted by the server.

	it('attach_map_image_download_control builds its own button+panel with all 5 formats, in order', function () {
		tool.attach_map_image_download_control();

		const control = geolocation.map.getContainer().querySelector('.uca-maps-map-image-control');
		assert.isOk(control, 'expected the map-image-download toggle button');
		assert.isOk(tool.map_image_panel, 'expected the map-image-download panel built');
		assert.equal(tool.map_image_panel.hidden, true, 'expected the panel hidden by default');
		assert.equal(
			geolocation.map.getContainer().contains(tool.map_image_panel),
			true,
			"expected the panel appended to the map's own DOM container",
		);

		const select = tool.map_image_panel.querySelector('.uca-maps-map-image-format');
		const options = Array.from(select.querySelectorAll('option')).map((o) => o.value);
		assert.deepEqual(
			options,
			['png', 'jpg', 'gif', 'webp', 'geotiff'],
			'expected all 5 v6 formats, in order',
		);

		assert.isOk(
			tool.map_image_panel.querySelector('.uca-maps-map-image-button'),
			'expected the download button',
		);

		// v6's own name field
		const name_input = tool.map_image_panel.querySelector('.uca-maps-map-image-name');
		assert.isOk(name_input, 'expected the file-name field');
		assert.equal(
			name_input.value,
			DEFAULT_MAP_IMAGE_NAME,
			'expected it pre-filled with the default base name (v6 opens with "archivo")',
		);
		assert.isOk(
			tool.map_image_panel.querySelector('.uca-maps-map-image-name-label'),
			'expected the field labelled',
		);

		control.click();
		assert.equal(tool.map_image_panel.hidden, false, 'expected the panel shown after one click');
		control.click();
		assert.equal(
			tool.map_image_panel.hidden,
			true,
			'expected the panel hidden again after a second click',
		);
	});

	it("download_map_image('png') captures the live map client-side under the default name, no server round-trip", async function () {
		tool.attach_console();
		tool.attach_map_image_download_control();

		let tool_request_called = false;
		stub_tool_request(async function (options) {
			tool_request_called = true;
			return real_tool_request(options);
		});

		// no name argument: omitted is the default, unlike an empty field
		const captured = await capture_download(() => download_map_image(tool, 'png'));

		assert.isOk(captured.blob, 'expected download_map_image to build a Blob');
		assert.equal(captured.blob.type, 'image/png', 'expected a real PNG capture');
		assert.isAbove(captured.blob.size, 0, 'expected a non-empty capture');
		assert.equal(
			captured.name,
			`${DEFAULT_MAP_IMAGE_NAME}.png`,
			'expected the default base name when the caller passes nothing',
		);
		assert.equal(tool_request_called, false, 'expected NO server round-trip for the PNG format');
	});

	// one byte is no PNG: the upload door refuses it by its signature, before any conversion
	it('a capture the upload door refuses answers the lead and its reason, and asks no conversion', async function () {
		const asked = [];
		stub_tool_request(async function (options) {
			asked.push(options.action);
			return real_tool_request(options);
		});

		// the refusal is an answer, not a throw: the catch-all would also give two lines
		const unexpected = [];
		const original_error = console.error;
		console.error = (...args) => unexpected.push(String(args[0]));
		let result = null;
		try {
			await with_to_blob_stub(async () => {
				result = await download_map_image(tool, 'jpg');
			});
		} finally {
			console.error = original_error;
		}

		assert.deepEqual(
			unexpected.filter((line) => line.includes('failed unexpectedly')),
			[],
			'expected the refusal handled, not thrown',
		);
		assert.isFalse(result.ok, 'expected the download refused');
		const [lead, reason] = result.error.split('\n');
		assert.equal(lead, 'The map image could not be downloaded.');
		assert.isOk(reason, "expected the upload door's own reason on its own line");
		assert.notInclude(asked, 'raster_download', 'expected no conversion asked');
	});

	/** Random pixels do not compress: a real map's size, past core's 512 KiB cap on `options`. */
	it("download_map_image('jpg') converts a capture larger than a request's options may carry", async function () {
		this.timeout(60000);
		const side = 512;
		const canvas = document.createElement('canvas');
		canvas.width = side;
		canvas.height = side;
		const context = canvas.getContext('2d');
		const pixels = context.createImageData(side, side);
		for (let i = 0; i < pixels.data.length; i++) {
			pixels.data[i] = i % 4 === 3 ? 255 : Math.floor(Math.random() * 256);
		}
		context.putImageData(pixels, 0, 0);
		const capture = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
		assert.isAbove(capture.size, 512 * 1024, 'expected a capture over the options cap');

		const sent = [];
		stub_tool_request(async function (options) {
			sent.push(options.options);
			return real_tool_request(options);
		});

		let result = null;
		const captured = await capture_download(() =>
			with_to_blob_stub(async () => {
				result = await download_map_image(tool, 'jpg');
			}, capture),
		);

		assert.deepEqual(result, { ok: true }, 'expected the server conversion to succeed');
		assert.equal(captured.blob.type, 'image/jpeg', 'expected the converted JPEG');
		assert.equal(captured.name, `${DEFAULT_MAP_IMAGE_NAME}.jpg`);
		assert.lengthOf(sent, 1, 'expected one raster_download request');
		assert.notProperty(sent[0], 'image_base64', 'expected the capture staged, not inlined');
		assert.equal(sent[0].file_data.key_dir, MAP_IMAGE_KEY_DIR);
	});

	it('the download panel warns, by origin, of an active layer the image cannot include, and follows the map while it is open', function () {
		tool.attach_map_image_download_control();
		const map = geolocation.map;
		const line = tool.map_image_panel.querySelector('.uca-maps-map-image-direct');
		const offline = (layer) => {
			layer.getTileUrl = () => BLANK_TILE;
			return layer;
		};
		assert.isOk(line, 'expected the warning line in the panel');
		// built from a map with no tile layer at all, whatever the suite server serves
		// directly: so the branch that hides the warning has a real empty case to reach
		const ambient = [];
		map.eachLayer((layer) => {
			if (layer instanceof L.TileLayer) ambient.push(layer);
		});
		for (const layer of ambient) {
			map.removeLayer(layer);
		}
		try {
			assert.deepEqual(direct_tile_layer_names(tool), [], 'expected no direct layer to start from');

			// same origin (the tile proxy) and data: tiles are never named; a direct one is,
			// by its control name read back as text, or by its host when unlisted
			const proxied = offline(
				L.tileLayer('/dedalo/core/api/v1/map_tile?builtin=test&z={z}&x={x}&y={y}'),
			).addTo(map);
			const inline = offline(L.tileLayer(BLANK_TILE)).addTo(map);
			const listed = offline(L.tileLayer('https://tiles.example.com/{z}/{x}/{y}.png'));
			geolocation.ensure_layer_control().addBaseLayer(listed, 'Test &amp; direct');
			listed.addTo(map);
			const unlisted = offline(L.tileLayer('https://{s}.other.example.org/{z}/{x}/{y}.png')).addTo(
				map,
			);
			assert.sameMembers(
				direct_tile_layer_names(tool),
				['Test & direct', 's.other.example.org'],
				'expected only the cross-origin layers, by name or host',
			);

			tool.map_image_control.getContainer().click();
			assert.equal(tool.map_image_panel.hidden, false);
			assert.equal(line.hidden, false, 'expected the warning shown on opening');
			assert.include(line.textContent, '«Test & direct', 'expected the layer named in the warning');
			assert.equal(
				line.dataset.type,
				'warning',
				'expected a warning, not an error: the download stays allowed',
			);
			assert.isFalse(
				tool.map_image_panel.querySelector('.uca-maps-map-image-button').disabled,
				'expected the download still allowed',
			);

			map.removeLayer(listed);
			map.removeLayer(unlisted);
			assert.notInclude(
				line.textContent,
				'Test & direct',
				'expected the warning to follow a layer switched off while the panel is open',
			);
			assert.equal(line.hidden, true, 'expected the line hidden once no direct layer is left');

			for (const layer of [proxied, inline]) {
				map.removeLayer(layer);
			}
			geolocation.layer_control.removeLayer(listed);
		} finally {
			for (const layer of ambient) {
				layer.addTo(map);
			}
		}
	});

	it("detaching the download control stops it following the map's layers", function () {
		tool.attach_map_image_download_control();
		const map = geolocation.map;
		const handler = tool._map_image_layers_handler;
		assert.isOk(handler, 'expected the layer follower attached');
		assert.isTrue(
			map.listens('layeradd', handler) && map.listens('layerremove', handler),
			'expected it on both events',
		);

		detach_map_image_download_control(tool);
		assert.isFalse(map.listens('layeradd', handler), 'expected layeradd unhooked');
		assert.isFalse(map.listens('layerremove', handler), 'expected layerremove unhooked');
		assert.isNull(tool._map_image_layers_handler);
	});

	it('download_map_image paints a tile it cannot read as plain background, never a broken image', async function () {
		tool.attach_map_image_download_control();

		const seen = await with_to_blob_stub(() =>
			capture_download(() => download_map_image(tool, 'png')),
		);

		assert.isOk(seen && seen.options, 'expected the capture to run');
		assert.equal(
			seen.options.imagePlaceholder,
			TRANSPARENT_PIXEL,
			'expected the transparent placeholder for an unreadable tile',
		);
	});

	it('download_map_image names the PNG with what the user typed, sanitized', async function () {
		tool.attach_console();
		tool.attach_map_image_download_control();

		const captured = await capture_download(() =>
			download_map_image(tool, 'png', '../Necrópolis de Cádiz'),
		);

		assert.isOk(captured.blob, 'expected a Blob');
		assert.equal(
			captured.name,
			'Necrópolis de Cádiz.png',
			'expected the typed name, separators stripped and the extension appended once',
		);
	});

	it('the map image keeps scale, legend and attribution, and drops every other control', function () {
		tool.attach_map_image_download_control();
		tool.attach_scale_bar();
		tool.attach_legend();

		const container = geolocation.map.getContainer();
		// a panel is no .leaflet-control: only the toolbar-node rule keeps an open one out
		container.querySelector('.uca-maps-map-image-control').click();
		assert.isFalse(tool.map_image_panel.hidden, 'expected the panel open on the map');
		// what dom-to-image-more does with the filter: a dropped node takes its subtree
		const survives = (node) => {
			for (let current = node; current && current !== container; current = current.parentNode) {
				if (!keep_in_map_image(tool, current)) {
					return false;
				}
			}
			return true;
		};

		const attribution = container.querySelector('.leaflet-control-attribution');
		assert.isOk(attribution, "expected Leaflet's attribution on the live map");
		assert.sameMembers(
			[...container.querySelectorAll('.leaflet-control')].filter((node) =>
				keep_in_map_image(tool, node),
			),
			[tool.scale_control.getContainer(), tool.legend_overlay.getContainer(), attribution],
			'expected only the cartographic controls kept',
		);
		for (const node of [
			tool.scale_control.getContainer(),
			tool.legend_overlay.getContainer(),
			attribution,
			container.querySelector('.leaflet-map-pane'),
		]) {
			assert.isTrue(survives(node), `expected ${node.className} in the image`);
		}

		// floors: each control the filter exists to drop is really on the map
		for (const selector of [
			'.leaflet-control-zoom',
			'.leaflet-control-layers',
			'.leaflet-pm-toolbar',
			'[class*="leaflet-pm-icon-"]',
			'.uca-maps-map-image-control',
			'.uca-maps-panel',
		]) {
			const nodes = [...container.querySelectorAll(selector)];
			assert.isAbove(nodes.length, 0, `expected ${selector} on the live map`);
			assert.isFalse(nodes.some(survives), `expected every ${selector} out of the image`);
		}
	});

	it("capturing the map requests no URL made out of an SVG icon's own #reference", async function () {
		tool.attach_map_image_download_control();

		// Geoman's icons are data: SVGs with `url(#mask-2)`-style references,
		// which dom-to-image-more fetched as page URLs (404s and console noise)
		assert.isOk(
			geolocation.map.getContainer().querySelector('[class*="leaflet-pm-icon-"]'),
			"expected Geoman's icons on the map",
		);

		const is_reference = (url) => /#|%23/.test(url);
		const requested = await capture_png_requests();

		assert.deepEqual(
			requested.filter(is_reference),
			[],
			'expected no request built from an SVG #reference',
		);
		assert.isAbove(
			(await capture_unguarded_requests()).filter(is_reference).length,
			0,
			'expected an unguarded capture to ask for them',
		);
	});

	it('download_map_image captures through keep_in_map_image: Geoman, zoom and an open panel out, the attribution in', async function () {
		tool.attach_map_image_download_control();
		const container = geolocation.map.getContainer();
		container.querySelector('.uca-maps-map-image-control').click();

		const seen = await with_to_blob_stub(() =>
			capture_download(() => download_map_image(tool, 'png')),
		);

		assert.isOk(seen, 'expected the capture to go through domtoimage.toBlob');
		assert.equal(seen.node, container, 'expected the map container captured');
		// a stamped tile URL is outside the tile proxy's closed grammar: refused, blank
		assert.notEqual(
			seen.options.cacheBust,
			true,
			'expected no cache-busting stamp on the tile requests',
		);
		assert.isUndefined(
			seen.options.requestInterceptor,
			'expected same-origin tiles fetched as they are',
		);
		const filter = seen.options.filter;
		assert.isFalse(
			filter(container.querySelector('.leaflet-pm-toolbar')),
			"expected Geoman's toolbar out of the image",
		);
		assert.isFalse(
			filter(container.querySelector('.leaflet-control-zoom')),
			'expected the zoom buttons out of the image',
		);
		assert.isFalse(filter(tool.map_image_panel), 'expected the open panel out of the image');
		assert.isTrue(
			filter(container.querySelector('.leaflet-control-attribution')),
			'expected the attribution the tile licence asks for',
		);
		assert.isTrue(
			filter(container.querySelector('.leaflet-map-pane')),
			'expected the map content kept',
		);
	});

	it('download_map_image refuses an EMPTY name (v6 parity) without capturing or calling the server', async function () {
		tool.attach_console();
		tool.attach_map_image_download_control();

		let tool_request_called = false;
		stub_tool_request(async function (options) {
			tool_request_called = true;
			return real_tool_request(options);
		});

		// A name that sanitizes to nothing is a refusal, never a silent
		// fallback to the default (download_filename.js).
		let result = null;
		let captured = null;
		// The refusal has to be VISIBLE, not just "nothing happened": it comes
		// back for the panel's line, under the field it is about, and nothing
		// toasts — no request failed.
		const errors = await toasts_during(async () => {
			captured = await capture_download(async () => {
				result = await download_map_image(tool, 'png', '   ');
			});
		});

		assert.isNotOk(captured.blob, 'expected no capture at all');
		assert.isNotOk(captured.name, 'expected no download triggered');
		assert.equal(tool_request_called, false, 'expected no server round-trip either');
		assert.deepEqual(
			result,
			{ ok: false, error: 'Please enter a name for the file' },
			"expected the reason for the panel's line",
		);
		assert.equal(errors.length, 0, 'expected no page toast for a field the user left empty');
	});

	it("the panel's Download button passes its own field to download_map_image", async function () {
		tool.attach_map_image_download_control();

		const calls = [];
		tool.download_map_image = function (format, file_name) {
			calls.push([format, file_name]);
		};

		tool.map_image_panel.querySelector('.uca-maps-map-image-name').value = 'plano general';
		tool.map_image_panel.querySelector('.uca-maps-map-image-format').value = 'jpg';
		tool.map_image_panel.querySelector('.uca-maps-map-image-button').click();

		assert.deepEqual(
			calls,
			[['jpg', 'plano general']],
			"expected the click to carry BOTH the format and the field's current value",
		);
	});

	/** The server converts the same PNG capture: the real raster_download, never a stub. */
	it("download_map_image('jpg') sends the sanitized name and gets a real JPEG back (skipped without ImageMagick)", async function () {
		tool.attach_console();
		tool.attach_map_image_download_control();

		let sent = null;
		let response = null;
		stub_tool_request(async function (options) {
			sent = options;
			response = await real_tool_request(options);
			return response;
		});

		const captured = await capture_download(() =>
			download_map_image(tool, 'jpg', '../Necrópolis de Cádiz'),
		);

		assert.isOk(sent, 'expected a server round-trip for a non-PNG format');
		assert.equal(sent.action, 'raster_download', 'expected the raster_download action');
		assert.equal(
			sent.options.file_name,
			'Necrópolis de Cádiz',
			'expected the SANITIZED name to travel in options.file_name',
		);

		if (response && response.ok !== true) {
			assert.equal(
				response.error && response.error.code,
				'tool.dependency_unavailable',
				'expected the only acceptable failure to be a missing ImageMagick binary — full response: ' +
					JSON.stringify(response),
			);
			this.skip();
		}

		assert.isOk(
			captured.blob,
			'expected download_map_image to build a Blob from the server response',
		);
		assert.equal(captured.blob.type, 'image/jpeg', 'expected the JPEG MIME type');
		assert.equal(
			captured.name,
			'Necrópolis de Cádiz.jpg',
			'expected the typed name back on the download',
		);
		const bytes = new Uint8Array(await captured.blob.arrayBuffer());
		assert.deepEqual(
			Array.from(bytes.slice(0, 3)),
			[0xff, 0xd8, 0xff],
			'expected real JPEG bytes, not a relabelled PNG',
		);
	});

	/** IFD0 of a little-endian TIFF, SHORT and DOUBLE tags only: where GDAL puts the georeference. */
	const read_tiff_tags = function (bytes) {
		const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
		const ifd = view.getUint32(4, true);
		const tags = {};
		for (let i = 0; i < view.getUint16(ifd, true); i++) {
			const entry = ifd + 2 + i * 12;
			const type = view.getUint16(entry + 2, true);
			const count = view.getUint32(entry + 4, true);
			const size = { 3: 2, 12: 8 }[type];
			if (!size) {
				continue;
			}
			const offset = count * size > 4 ? view.getUint32(entry + 8, true) : entry + 8;
			tags[view.getUint16(entry, true)] = Array.from({ length: count }, (value, k) =>
				type === 3 ? view.getUint16(offset + k * 2, true) : view.getFloat64(offset + k * 8, true),
			);
		}
		return tags;
	};

	it("download_map_image('geotiff') gets a GeoTIFF in EPSG:3857 tied at the view's north-west corner (skipped without GDAL)", async function () {
		tool.attach_console();
		tool.attach_map_image_download_control();

		let response = null;
		stub_tool_request(async function (options) {
			response = await real_tool_request(options);
			return response;
		});

		const captured_blob = (await capture_download(() => download_map_image(tool, 'geotiff'))).blob;

		if (response && response.ok !== true) {
			assert.equal(
				response.error && response.error.code,
				'tool.dependency_unavailable',
				'expected the only acceptable failure to be a missing GDAL binary — full response: ' +
					JSON.stringify(response),
			);
			this.skip();
		}

		assert.isOk(
			captured_blob,
			'expected download_map_image to build a Blob from the server response',
		);
		assert.equal(captured_blob.type, 'image/tiff', 'expected the GeoTIFF MIME type');

		const bytes = new Uint8Array(await captured_blob.arrayBuffer());
		// little-endian 'II*\0', GDAL's own default byte order
		assert.deepEqual(
			Array.from(bytes.slice(0, 4)),
			[0x49, 0x49, 0x2a, 0x00],
			'expected real TIFF magic bytes',
		);

		const tags = read_tiff_tags(bytes);
		const geokeys = tags[34735] || []; // GeoKeyDirectory: 4 header shorts, then {key, location, count, value}
		const projected = Array.from({ length: geokeys[3] || 0 }, (value, k) =>
			geokeys.slice(4 + k * 4, 8 + k * 4),
		).find(([key]) => key === 3072); // ProjectedCSTypeGeoKey
		assert.isOk(projected, 'expected a projected CRS key in the GeoTIFF');
		assert.equal(
			projected[3],
			3857,
			"expected EPSG:3857, the grid the screenshot's pixels are uniform in",
		);

		const tiepoint = tags[33922]; // ModelTiepoint: raster (0,0) to model (x, y)
		const north_west = L.CRS.EPSG3857.project(geolocation.map.getBounds().getNorthWest());
		assert.isOk(tiepoint, 'expected the model tiepoint');
		assert.deepEqual(tiepoint.slice(0, 2), [0, 0], 'expected the tiepoint on the top-left pixel');
		assert.closeTo(
			tiepoint[3],
			north_west.x,
			0.01,
			"expected the image tied at the view's west edge",
		);
		assert.closeTo(
			tiepoint[4],
			north_west.y,
			0.01,
			"expected the image tied at the view's north edge",
		);
	});

	// OBJECTS (object_viewer.js) — read-only lists of the ACTIVE FeatureGroup,
	// as v6. (!) The 'full' load leaves active_layer_id at 3: load_layer sets
	// it for each layer it loads, the marker last. Each test sets it first.

	it('attach_object_viewer builds its button+panel with both lists empty until the first open fills them', function () {
		geolocation.active_layer_id = 1; // the seeded polygon
		tool.attach_object_viewer();

		const control = geolocation.map.getContainer().querySelector('.uca-maps-object-viewer-control');
		assert.isOk(control, 'expected the "Objects" toggle button');
		assert.isOk(tool.object_viewer_panel, 'expected the "Objects" panel built');
		assert.equal(tool.object_viewer_panel.hidden, true, 'expected the panel hidden by default');
		assert.equal(
			geolocation.map.getContainer().contains(tool.object_viewer_panel),
			true,
			"expected the panel appended to the map's own DOM container",
		);

		const vector_list = tool.object_viewer_panel.querySelector(
			'.uca-maps-object-viewer-vector-list',
		);
		const raster_list = tool.object_viewer_panel.querySelector(
			'.uca-maps-object-viewer-raster-list',
		);
		assert.isOk(vector_list, 'expected the Vector Objects list');
		assert.isOk(raster_list, 'expected the Rasterized Objects list');

		// built lazily on the first open, like every sibling panel
		assert.equal(
			vector_list.children.length,
			0,
			'expected the Vector Objects list still empty before the first open',
		);
		assert.equal(
			raster_list.children.length,
			0,
			'expected the Rasterized Objects list still empty before the first open',
		);

		control.click();
		assert.equal(
			tool.object_viewer_panel.hidden,
			false,
			'expected the panel shown after one click',
		);

		// the first open is what populates it — the seeded polygon (active
		// layer 1) is listed now
		const vector_items = vector_list.querySelectorAll('.uca-maps-object-viewer-item');
		assert.equal(vector_items.length, 1, 'expected the one seeded polygon in Vector Objects');
		assert.isOk(
			raster_list.querySelector('.uca-maps-empty-state'),
			'expected Rasterized Objects to show its empty-state placeholder: no image on the map',
		);

		control.click();
		assert.equal(
			tool.object_viewer_panel.hidden,
			true,
			'expected the panel hidden again after a second click',
		);
	});

	it('each listed object carries an icon-only eye button: an SVG with an accessible name, no text', function () {
		geolocation.active_layer_id = 1; // the seeded polygon
		tool.attach_object_viewer();
		tool.object_viewer_control.getContainer().click();

		const eye = tool.object_viewer_panel.querySelector(
			'.uca-maps-object-viewer-item .uca-maps-object-viewer-center',
		);
		assert.isOk(eye, 'expected the eye button on the listed object');
		assert.instanceOf(
			eye.querySelector('svg'),
			SVGSVGElement,
			'expected a real SVG icon, not markup turned into text',
		);
		assert.isOk(eye.querySelector('svg path').getAttribute('d'), 'expected the eye drawn');
		assert.equal(eye.textContent.trim(), '', 'expected no text beside the icon');
		assert.isOk(
			eye.getAttribute('aria-label'),
			'expected the icon-only button to carry an accessible name',
		);
	});

	it('collect_objects reads the ACTIVE FeatureGroup only (v6 parity), with a display-only nameless fallback', function () {
		geolocation.active_layer_id = 1; // the seeded polygon
		tool.attach_object_viewer();

		let { vector_objects, raster_objects } = collect_objects(tool);
		assert.equal(
			vector_objects.length,
			1,
			"expected only the active layer's (1, polygon) one object",
		);
		assert.equal(raster_objects.length, 0, 'expected no raster objects: no image on the map');
		assert.equal(
			vector_objects[0].name,
			'Untitled object',
			'expected the display-only nameless fallback',
		);
		assert.equal(vector_objects[0].display, true, 'expected visible by default');
		assert.equal(
			seeded_layer(1).feature.properties.name,
			undefined,
			'expected collect_objects to NEVER write the nameless fallback back into properties, unlike v6',
		);

		geolocation.active_layer_id = 3; // switch to the seeded marker's FeatureGroup
		({ vector_objects, raster_objects } = collect_objects(tool));
		assert.equal(
			vector_objects.length,
			1,
			"expected the marker FeatureGroup's one object once active_layer_id changes",
		);
		assert.instanceOf(vector_objects[0].layer, L.Marker, 'expected the seeded marker');
	});

	it('set_object_display hides/shows a Polygon (DOM style + stored uca_maps.display) and marks the record dirty', function () {
		tool.attach_console(); // hydrate()'s reapply_all/commit plumbing lives here
		geolocation.active_layer_id = 1;
		tool.attach_object_viewer();

		const layer = seeded_layer(1);
		assert.instanceOf(layer, L.Polygon, 'expected the seeded polygon');

		for (const visible of [false, true]) {
			geolocation.is_data_changed = false;
			set_object_display(tool, layer, visible);
			assert.equal(
				layer.feature.properties.uca_maps.display,
				visible,
				'expected display stored ' + visible,
			);
			assert.equal(
				layer._path.style.display === 'none',
				!visible,
				'expected the Path DOM node ' + (visible ? 'shown' : 'hidden'),
			);
			assert.isTrue(
				geolocation.is_data_changed,
				'expected the record dirty, or Save drops the change',
			);
		}
	});

	it('set_object_display works for a Marker too (icon + shadow, not _path), and marks the record dirty', function () {
		tool.attach_console();
		geolocation.active_layer_id = 3;
		tool.attach_object_viewer();

		const layer = seeded_layer(3);
		assert.instanceOf(layer, L.Marker, 'expected the seeded marker');
		assert.isOk(layer._shadow, "expected the default icon's shadow drawn");

		for (const visible of [false, true]) {
			geolocation.is_data_changed = false;
			set_object_display(tool, layer, visible);
			assert.equal(
				layer.feature.properties.uca_maps.display,
				visible,
				'expected display stored ' + visible,
			);
			assert.equal(
				layer._icon.style.display === 'none',
				!visible,
				'expected the marker icon ' + (visible ? 'shown' : 'hidden'),
			);
			assert.equal(
				layer._shadow.style.display === 'none',
				!visible,
				'expected its shadow ' + (visible ? 'shown' : 'hidden') + ' with it',
			);
			assert.isTrue(
				geolocation.is_data_changed,
				'expected the record dirty, or Save drops the change',
			);
		}
	});

	it('set_object_display seeds .feature on a layer freshly drawn via Geoman (pm:create never assigns one)', function () {
		tool.attach_console();
		geolocation.active_layer_id = 1;
		tool.attach_object_viewer();

		// the core's init_feature never assigns .feature (only the L.geoJson
		// restore does): a shape just drawn with Geoman reaches this module bare
		const layer = seeded_layer(1);
		// biome-ignore lint/performance/noDelete: a shape just drawn with Geoman has no `feature` at all
		delete layer.feature;
		assert.isNotOk(
			layer.feature,
			'expected the fixture layer to start with no .feature, matching a freshly-drawn one',
		);

		set_object_display(tool, layer, false);

		assert.isOk(
			layer.feature,
			'expected set_object_display to seed .feature via ensure_properties',
		);
		assert.equal(
			layer.feature.properties.uca_maps.display,
			false,
			'expected display persisted false even from a featureless layer',
		);
		assert.equal(layer._path.style.display, 'none', 'expected the Path DOM node hidden');
	});

	it('the rendered checkbox passes its OWN new .checked value, not an inversion of the stored one', function () {
		tool.attach_console();
		geolocation.active_layer_id = 1; // the seeded polygon
		tool.attach_object_viewer();

		const layer = seeded_layer(1);

		tool.object_viewer_control.getContainer().click(); // show + populate
		const checkbox = tool.object_viewer_panel.querySelector(
			'.uca-maps-object-viewer-vector-list .uca-maps-object-viewer-checkbox',
		);
		assert.isOk(checkbox, "expected the seeded polygon's checkbox");
		assert.equal(checkbox.checked, true, 'expected checked (visible) by default');

		checkbox.checked = false;
		checkbox.dispatchEvent(new Event('change'));

		assert.equal(
			layer.feature.properties.uca_maps.display,
			false,
			'expected the checkbox change to reach set_object_display',
		);
		assert.equal(
			layer._path.style.display,
			'none',
			'expected the checkbox change to hide the Path DOM node too',
		);

		// re-checking must show it again: a handler inverting the stored value
		// would pass the first change and fail this one
		checkbox.checked = true;
		checkbox.dispatchEvent(new Event('change'));
		assert.equal(
			layer.feature.properties.uca_maps.display,
			true,
			'expected display persisted true again',
		);
		assert.notEqual(layer._path.style.display, 'none', 'expected the Path DOM node shown again');
	});

	it('the panel refreshes itself on the next updated_layer_data publish while open, and never while closed', function () {
		geolocation.active_layer_id = 1;
		tool.attach_object_viewer(); // never opened yet

		const vector_list = tool.object_viewer_panel.querySelector(
			'.uca-maps-object-viewer-vector-list',
		);
		const items = () => vector_list.querySelectorAll('.uca-maps-object-viewer-item').length;
		// a second object in the SAME FeatureGroup, announced the way every
		// Geoman pm:* handler of the core announces one: update_draw_data
		const add_object = function (lat) {
			const extra = L.circle([lat, -3.7], { radius: 50 }).addTo(geolocation.FeatureGroup[1]);
			extra.feature = extra.toGeoJSON();
			geolocation.update_draw_data(1);
		};

		add_object(40.41);
		assert.equal(
			vector_list.children.length,
			0,
			'expected the closed panel left untouched by the publish',
		);

		tool.object_viewer_control.getContainer().click(); // open: populates once
		assert.equal(items(), 2, 'expected the seeded polygon and the circle on the first open');

		add_object(40.42);
		assert.equal(
			items(),
			3,
			'expected the open panel to pick up the new object WITHOUT being closed and reopened',
		);
	});

	it("center_on_object fits a Polygon's bounds unanimated under camera_is_moving, and leaves the record clean", function () {
		geolocation.active_layer_id = 1;
		tool.attach_object_viewer();

		const layer = seeded_layer(1);

		let fit_bounds_called_with = null;
		let camera_is_moving_during_call = null;
		const original_fit_bounds = geolocation.map.fitBounds;
		geolocation.map.fitBounds = function (bounds, options) {
			fit_bounds_called_with = { bounds, options };
			camera_is_moving_during_call = geolocation.camera_is_moving;
			return original_fit_bounds.call(this, bounds, options);
		};

		geolocation.is_data_changed = false;
		center_on_object(tool, layer);

		assert.isOk(fit_bounds_called_with, 'expected map.fitBounds to be called');
		assert.isOk(
			fit_bounds_called_with.bounds.equals(layer.getBounds()),
			"expected the layer's own bounds",
		);
		// the core's dragend/zoomend guard reads the flag when the move ends: an
		// animated zoomend would land after it is lowered and mark the record dirty
		assert.strictEqual(
			fit_bounds_called_with.options && fit_bounds_called_with.options.animate,
			false,
			'expected an unanimated move',
		);
		assert.equal(
			camera_is_moving_during_call,
			true,
			'expected camera_is_moving raised DURING the move',
		);
		assert.equal(
			geolocation.camera_is_moving,
			false,
			'expected camera_is_moving lowered again afterwards',
		);
		assert.equal(
			geolocation.is_data_changed,
			false,
			'expected NO dirty flag from a read-only "Center" click',
		);
	});

	it('center_on_object (v6\'s "eye" icon) moves a Marker through the masked move_camera at v6\'s zoom 16, record clean', function () {
		geolocation.active_layer_id = 3;
		tool.attach_object_viewer();

		const layer = seeded_layer(3);
		const latlng = layer.getLatLng();

		let move_camera_called_with = null;
		const original_move_camera = geolocation.move_camera;
		geolocation.move_camera = function (lat, lon, zoom) {
			move_camera_called_with = { lat, lon, zoom };
			return original_move_camera.call(this, lat, lon, zoom);
		};

		geolocation.is_data_changed = false;
		center_on_object(tool, layer);

		assert.isOk(
			move_camera_called_with,
			'expected move_camera to be called — never a bare map.setView',
		);
		assert.equal(move_camera_called_with.lat, latlng.lat, "expected the marker's own latitude");
		assert.equal(move_camera_called_with.lon, latlng.lng, "expected the marker's own longitude");
		assert.equal(move_camera_called_with.zoom, 16, "expected v6's own hardcoded zoom level");
		assert.equal(
			geolocation.is_data_changed,
			false,
			'expected NO dirty flag from a read-only "Center" click',
		);
	});

	it('a hidden display state survives a reload (reapply_all/reapply_display, hydrate())', function () {
		tool.attach_console(); // hydrate() — the only path that subscribes updated_layer_data_<id_base>
		geolocation.active_layer_id = 1;
		tool.attach_object_viewer();

		const layer = seeded_layer(1);
		set_object_display(tool, layer, false);
		assert.equal(layer._path.style.display, 'none', 'expected hidden before the reload event');

		// simulate what a real reload would trigger: the layer's own DOM node
		// gets rebuilt (Leaflet re-adds it to the SVG renderer), losing the
		// inline style — reapply_all (object_console.js hydrate()) is what
		// restores it on the next updated_layer_data_<id_base> publish
		layer._path.style.display = '';
		geolocation.update_draw_data(1);

		assert.equal(
			layer._path.style.display,
			'none',
			'expected reapply_display to re-hide the layer on the next hydration pass',
		);
	});

	it('detach_object_viewer removes the control and panel; destroy drops its updated_layer_data subscription', async function () {
		// read off the event manager, not events_tokens: a token the tool
		// forgot to keep would outlive the tool and still be found here
		const event_name = `updated_layer_data_${geolocation.id_base}`;
		const tokens = () =>
			[...event_manager.tokenMap]
				.filter(([, entry]) => entry.event_name === event_name)
				.map(([token]) => token);
		const before = tokens();
		tool.attach_object_viewer();
		const added = tokens().filter((token) => !before.includes(token));
		assert.equal(added.length, 1, 'expected attach to subscribe updated_layer_data once');
		const map_container_node = geolocation.map.getContainer();
		assert.isOk(tool.object_viewer_control, 'expected the control attached first');
		assert.isOk(
			map_container_node.querySelector('.uca-maps-object-viewer-control'),
			'expected the button in the DOM before teardown',
		);

		// on_geolocation_destroyed's own call: only delete_self unsubscribes events_tokens
		await tool.destroy(true, true, true);

		assert.equal(tool.object_viewer_control, null, 'expected object_viewer_control cleared');
		assert.equal(tool.object_viewer_panel, null, 'expected object_viewer_panel cleared');
		assert.isNotOk(
			map_container_node.querySelector('.uca-maps-object-viewer-control'),
			'expected the button removed from the DOM',
		);
		assert.isFalse(
			event_manager.tokenMap.has(added[0]),
			'expected the updated_layer_data subscription dropped with the tool',
		);
	});

	// 1x1 (onexone.js) — a toggle with no panel: while armed, clicking a marker
	// draws a 1 m rectangle around it, flagged as uncertainty. The seeded
	// marker (layer_id 3) is the subject throughout.

	it('attach_onexone builds a bare toggle button (no panel), off by default; clicking flips it', function () {
		tool.attach_onexone();

		const control = geolocation.map.getContainer().querySelector('.uca-maps-onexone-control');
		assert.isOk(control, 'expected the "1x1" toggle button');
		assert.equal(is_onexone_enabled(tool), false, 'expected 1x1 mode off by default');

		control.click();
		assert.equal(is_onexone_enabled(tool), true, 'expected 1x1 mode armed after one click');

		control.click();
		assert.equal(
			is_onexone_enabled(tool),
			false,
			'expected 1x1 mode disarmed after a second click',
		);
	});

	it("create_onexone_rectangle adds a 1 m rectangle to the marker's own FeatureGroup, linked by uid, auto-flagged uncertainty", function () {
		const marker = seeded_layer(3);
		const layers_before = geolocation.FeatureGroup[3].getLayers().length;
		// another layer active: the rectangle must follow the marker, not the selection
		geolocation.active_layer_id = 1;
		const other_before = geolocation.FeatureGroup[1].getLayers().length;

		create_onexone_rectangle(tool, marker);

		const onexone_uid = marker.feature.properties.uca_maps.onexone_uid;
		assert.isOk(onexone_uid, 'expected an onexone_uid recorded on the marker');

		const layers_after = geolocation.FeatureGroup[3].getLayers();
		assert.equal(
			layers_after.length,
			layers_before + 1,
			'expected one new layer (the rectangle) added',
		);
		assert.equal(
			geolocation.FeatureGroup[1].getLayers().length,
			other_before,
			'expected nothing added to the active layer',
		);

		const rectangle = layer_by_uid(geolocation.FeatureGroup[3], onexone_uid);
		assert.isOk(rectangle, 'expected to find the rectangle by its uid');
		assert.instanceOf(
			rectangle,
			L.Rectangle,
			"expected an L.Rectangle, matching v6's own L.rectangle(bounds)",
		);
		// a 1 m square centred on the point: v6's `radiusMts = 1` fed to toBounds
		const expected = marker.getLatLng().toBounds(1);
		const bounds = rectangle.getBounds();
		for (const corner of ['getSouthWest', 'getNorthEast']) {
			assert.closeTo(
				bounds[corner]().lat,
				expected[corner]().lat,
				1e-9,
				'expected the ' + corner + ' latitude of a 1 m square',
			);
			assert.closeTo(
				bounds[corner]().lng,
				expected[corner]().lng,
				1e-9,
				'expected the ' + corner + ' longitude of a 1 m square',
			);
		}
		assert.isBelow(
			bounds.getCenter().distanceTo(marker.getLatLng()),
			0.01,
			'expected the square centred on the marker',
		);
		assert.equal(
			rectangle.feature.properties.uca_maps.onexone_of,
			marker.feature.properties.uca_maps.uid,
			'expected the rectangle linked back to the marker by uid',
		);
		assert.isOk(
			rectangle.feature.properties.uca_maps.uncertainty,
			'expected the rectangle flagged as uncertainty on creation',
		);
	});

	it('create_onexone_rectangle is idempotent — a marker that already has one does not get a second', function () {
		const marker = seeded_layer(3);
		create_onexone_rectangle(tool, marker);
		const layers_after_first = geolocation.FeatureGroup[3].getLayers().length;

		create_onexone_rectangle(tool, marker);
		assert.equal(
			geolocation.FeatureGroup[3].getLayers().length,
			layers_after_first,
			'expected the second call to no-op (onexone_uid guard, v6 parity: is_oneXone)',
		);
	});

	it('create_onexone_rectangle skips a centroid marker — not a real drawn point a user could 1x1', function () {
		const parent = seeded_layer(1); // seeded polygon
		toggle_centroid(tool, parent);
		const centroid_uid = parent.feature.properties.uca_maps.centroid_uid;
		const centroid = layer_by_uid(geolocation.FeatureGroup[1], centroid_uid);
		// a missing centroid would leave by the not-a-Marker exit instead
		assert.instanceOf(centroid, L.Marker, 'expected the centroid marker on the map');
		const layers_before = geolocation.FeatureGroup[1].getLayers().length;

		create_onexone_rectangle(tool, centroid);

		assert.equal(
			geolocation.FeatureGroup[1].getLayers().length,
			layers_before,
			'expected no rectangle created for a centroid marker (centroid_of guard)',
		);
	});

	it("create_onexone_rectangle skips a Marker while Geoman is mid-edit elsewhere on the map (v6's geoman_edition_mode guard)", function () {
		const marker = seeded_layer(3);
		const layers_before = geolocation.FeatureGroup[3].getLayers().length;

		const original_global_edit_mode_enabled = geolocation.map.pm.globalEditModeEnabled;
		geolocation.map.pm.globalEditModeEnabled = () => true;
		try {
			create_onexone_rectangle(tool, marker);
		} finally {
			geolocation.map.pm.globalEditModeEnabled = original_global_edit_mode_enabled;
		}

		assert.equal(
			geolocation.FeatureGroup[3].getLayers().length,
			layers_before,
			'expected no rectangle created while Geoman reports a global edit in progress',
		);
	});

	it('popupopen only arms a rectangle while 1x1 mode is on (not before, not after a second click disarms it)', function () {
		tool.attach_onexone();
		const marker = seeded_layer(3);
		const layers_before = geolocation.FeatureGroup[3].getLayers().length;
		const button = tool.onexone_control.getContainer();

		marker.openPopup(); // 1x1 mode still off
		assert.equal(
			geolocation.FeatureGroup[3].getLayers().length,
			layers_before,
			'expected no rectangle while disarmed',
		);
		marker.closePopup();

		button.click(); // arm
		button.click(); // and disarm again
		marker.openPopup();
		assert.equal(
			geolocation.FeatureGroup[3].getLayers().length,
			layers_before,
			'expected no rectangle once the second click disarms it',
		);
		marker.closePopup();

		button.click(); // arm it
		marker.openPopup();
		assert.equal(
			geolocation.FeatureGroup[3].getLayers().length,
			layers_before + 1,
			'expected one rectangle created once armed and the marker is clicked',
		);
	});

	it("deleting the rectangle clears the marker's onexone_uid (usable again); deleting the marker leaves the rectangle", function () {
		tool.attach_onexone();
		const marker = seeded_layer(3);
		create_onexone_rectangle(tool, marker);

		const onexone_uid = marker.feature.properties.uca_maps.onexone_uid;
		const rectangle = layer_by_uid(geolocation.FeatureGroup[3], onexone_uid);

		geolocation.FeatureGroup[3].removeLayer(rectangle);
		geolocation.map.fire('pm:remove', { layer: rectangle });

		assert.equal(
			marker.feature.properties.uca_maps.onexone_uid,
			undefined,
			'expected the dangling onexone_uid cleared once its rectangle is gone',
		);
		assert.isOk(
			geolocation.FeatureGroup[3].hasLayer(marker),
			"expected the marker itself untouched by its rectangle's own deletion",
		);

		// re-run: the marker is usable again now that onexone_uid is cleared
		create_onexone_rectangle(tool, marker);
		assert.isOk(
			marker.feature.properties.uca_maps.onexone_uid,
			'expected 1x1 usable again on the same marker',
		);

		// the reverse direction: deleting the MARKER must not touch its rectangle
		const second_uid = marker.feature.properties.uca_maps.onexone_uid;
		const second_rectangle = layer_by_uid(geolocation.FeatureGroup[3], second_uid);
		geolocation.FeatureGroup[3].removeLayer(marker);
		geolocation.map.fire('pm:remove', { layer: marker });

		assert.isOk(
			geolocation.FeatureGroup[3].hasLayer(second_rectangle),
			'expected NO cascade delete (deliberate deviation from v6, onexone.js file header): the rectangle stands alone',
		);
	});

	it('deleting the rectangle gives the marker back the editing state the 1x1 locked, unless the box was used since', function () {
		tool.attach_onexone();
		const marker = seeded_layer(3);
		const uca_maps = () => marker.feature.properties.uca_maps;
		const rows = [
			{ label: 'no state before', before: undefined, since: [], after: undefined },
			{ label: 'ticked before', before: true, since: [], after: true },
			{ label: 'locked before', before: false, since: [], after: false },
			{ label: 'ticked since', before: undefined, since: [true], after: true },
			{ label: 'ticked then unticked since', before: true, since: [true, false], after: false },
		];
		for (const row of rows) {
			if (row.before === undefined) {
				// biome-ignore lint/performance/noDelete: restores the absence of the key the row started without
				delete (marker.feature.properties.uca_maps || {}).geoman_edition;
			} else {
				tool.set_geoman_edition(marker, row.before);
			}
			create_onexone_rectangle(tool, marker);
			assert.equal(
				uca_maps().geoman_edition,
				false,
				'expected the 1x1 to lock the marker: ' + row.label,
			);
			for (const enabled of row.since) {
				tool.set_geoman_edition(marker, enabled);
			}

			const rectangle = layer_by_uid(geolocation.FeatureGroup[3], uca_maps().onexone_uid);
			geolocation.FeatureGroup[3].removeLayer(rectangle);
			geolocation.map.fire('pm:remove', { layer: rectangle });

			assert.equal(
				uca_maps().geoman_edition,
				row.after,
				'expected the editing state after the delete: ' + row.label,
			);
			assert.notProperty(
				uca_maps(),
				'onexone_prior_geoman_edition',
				'expected no trace of the 1x1 left: ' + row.label,
			);
			if (row.after === true) {
				assert.equal(
					marker.pm.enabled(),
					true,
					'expected a ticked marker unlocked at once: ' + row.label,
				);
			}
		}
	});

	/**
	 * 1x1 AND GEOMAN HANDLES, against v6: what the console says about a 1x1,
	 * and the handles a new geometry is born with.
	 */

	it('a geometry created on the map is born with its Geoman handles off and says so; a marker and an image carrier are not', async function () {
		tool.attach_console();
		geolocation.active_layer_id = 1;

		const polygon = L.polygon([
			[40.4, -3.71],
			[40.4, -3.6],
			[40.5, -3.6],
		]);
		geolocation.map.fire('pm:create', { layer: polygon });
		assert.equal(
			polygon.feature.properties.uca_maps.geoman_edition,
			false,
			'expected the explicit stored false v6 writes on creation (special_tools_onexone.js)',
		);
		// the stored flag alone would pass on a layer Geoman never touched:
		// replay the core's click sweep (init_feature runs pm.enable() over the
		// group) and the deferred re-assert must take the handles off again
		assert.equal(
			polygon.pm.enabled(),
			false,
			'expected no vertex handles on a shape nobody asked to edit',
		);
		polygon.pm.enable();
		assert.equal(
			polygon.pm.enabled(),
			true,
			'expected the simulated core sweep to paint the handles',
		);
		polygon.openPopup();
		await tick();
		assert.equal(
			polygon.pm.enabled(),
			false,
			'expected the stored false to clear the handles the core sweep painted',
		);

		const marker = L.marker([40.42, -3.68]);
		geolocation.map.fire('pm:create', { layer: marker });
		const marker_uca =
			marker.feature && marker.feature.properties && marker.feature.properties.uca_maps;
		assert.isNotOk(
			marker_uca && typeof marker_uca.geoman_edition === 'boolean',
			'expected a marker left with no opinion — it carries no vertex handles',
		);

		const carrier = L.rectangle([
			[40.4, -3.71],
			[40.5, -3.6],
		]);
		carrier.feature = carrier.toGeoJSON();
		carrier.feature.properties.uca_maps = { image: { id: 'x' } };
		geolocation.map.fire('pm:create', { layer: carrier });
		assert.isNotOk(
			typeof carrier.feature.properties.uca_maps.geoman_edition === 'boolean',
			'expected an image carrier left to image_edit.js own seal: a new image arrives editable',
		);
	});

	it('re-asserting a stored geoman state that already holds touches nothing — the loop guard', function () {
		tool.attach_console();
		const polygon = seeded_layer(1);

		// an object with the handles explicitly off, already applied
		tool.set_geoman_edition(polygon, false);

		let disables = 0;
		let enables = 0;
		const real_disable = polygon.pm.disable.bind(polygon.pm);
		const real_enable = polygon.pm.enable.bind(polygon.pm);
		polygon.pm.disable = function () {
			disables++;
			return real_disable();
		};
		polygon.pm.enable = function (options) {
			enables++;
			return real_enable(options);
		};

		// the core's own republish (update_draw_data fires this on every
		// serialisation) runs reapply_all over every layer
		event_manager.publish('updated_layer_data_' + geolocation.id_base, {});

		// pm.disable() answers with pm:edit, the core with update_draw_data, and
		// that publish comes straight back here: an endless loop
		assert.equal(disables, 0, 'expected NO pm.disable() on a layer already disabled');
		assert.equal(enables, 0, 'expected no pm.enable() either — the stored state is off');

		// control: the re-assert does reach this layer. Enable it behind the
		// stored state's back, as the core's click sweep does
		real_enable();
		event_manager.publish('updated_layer_data_' + geolocation.id_base, {});
		assert.equal(
			disables,
			1,
			'expected the re-assert to reach this layer and clear a state that disagrees',
		);
	});

	it("the 1x1 marker console carries v6's reference-point line and the uncertainty scale, ringed at tier 1 and titled 1.00 m²", function () {
		tool.attach_console();
		const marker = seeded_layer(3);
		create_onexone_rectangle(tool, marker);

		marker.openPopup();
		const section = tool.console_panel.querySelector('.uca-maps-object-section');

		assert.isOk(
			section.querySelector('.uca-maps-onexone-reference'),
			"expected v6 create_div_oneXone's own line: the marker says what it now is",
		);
		const scale = section.querySelector('.uca-maps-uncertainty-scale');
		const svg = scale && scale.querySelector('svg');
		assert.isOk(svg, 'expected the scale bar v6 draws as img/escala-1.png');
		assert.equal(svg.querySelectorAll('rect').length, 6, "expected v6's six bands");
		assert.equal(
			scale.getAttribute('title'),
			'1.00 m²',
			"expected the 1x1's own area as the scale's title, as v6",
		);
		assert.equal(
			svg.querySelector('circle').getAttribute('cx'),
			'20',
			'expected the ring on the first band: a 1 m² square is tier 1',
		);
	});

	it('the 1x1 rectangle console prints the nominal area, stores none, and hides the centroid box', function () {
		tool.attach_console();
		const marker = seeded_layer(3);
		create_onexone_rectangle(tool, marker);

		const onexone_uid = marker.feature.properties.uca_maps.onexone_uid;
		const rectangle = layer_by_uid(geolocation.FeatureGroup[3], onexone_uid);

		assert.equal(
			tool.compute_info(rectangle)[0].value,
			'1 m²',
			"expected v6's nominal area (create_div_polygon_area, is_oneXone branch), not turf's measurement",
		);
		assert.equal(
			rectangle.feature.properties.uca_maps.geoman_edition,
			false,
			'expected the 1x1 rectangle born with the handles off, like any other new geometry',
		);

		// AFTER the render: `render_selected_object` calls sync_measurements,
		// which is the writer the 1x1 guard has to stop — asserted before the
		// render, this could not fail
		rectangle.openPopup();
		assert.equal(
			rectangle.feature.properties.area,
			undefined,
			'expected no stored area: v6 saves one only in its non-1x1 branch',
		);

		const plain_polygon = seeded_layer(1);
		plain_polygon.openPopup();
		assert.isOk(
			plain_polygon.feature.properties.area,
			'expected the guard to be narrow: a plain polygon still stores its measured area',
		);

		rectangle.openPopup();
		const section = tool.console_panel.querySelector('.uca-maps-object-section');
		assert.isNotOk(
			section.querySelector('.uca-maps-centroid'),
			'expected NO centroid checkbox on a 1x1 (v6 create_div_centroid)',
		);
		assert.isOk(
			section.querySelector('.uca-maps-uncertainty-scale svg'),
			'expected the scale bar beside the checked box',
		);
	});

	it('the 1x1 marker is born locked, as v6, and stays locked whatever a real click does to its popup', async function () {
		tool.attach_console();
		const marker = seeded_layer(3);
		create_onexone_rectangle(tool, marker);

		assert.equal(
			marker.feature.properties.uca_maps.geoman_edition,
			false,
			'expected the explicit stored false v6 writes on the 1x1 marker (special_tools_onexone.js)',
		);

		// REAL clicks on the icon, so bindPopup's opener and the core's
		// init_feature sweep (pm.enable() over the whole group) run in their own
		// order; counting the sweep's enables proves each click reached it
		assert.isOk(marker._icon, 'expected the marker drawn on the map');
		let sweeps = 0;
		const real_enable = marker.pm.enable.bind(marker.pm);
		marker.pm.enable = function (options) {
			sweeps++;
			return real_enable(options);
		};
		const click = async () => {
			marker._icon.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
			await tick();
		};

		await click();
		assert.equal(sweeps, 1, 'expected the first click to reach the core sweep');
		assert.isTrue(marker.isPopupOpen(), 'expected the first click to open the popup');
		assert.equal(
			marker.pm.enabled(),
			false,
			'expected the re-assert to lock the marker after the sweep',
		);

		const box = tool.console_panel.querySelector('.uca-maps-object-section .uca-maps-geoman input');
		assert.isOk(box, 'expected the "Geoman editing active" checkbox on the marker console');
		assert.equal(box.checked, false, 'expected the checkbox to say the marker is locked');

		// a second click CLOSES a marker's popup (Leaflet's toggle; the open popup
		// swallows that click's 'preclick') and fires no 'popupopen', yet the
		// core sweep still enables the marker
		await click();
		assert.equal(sweeps, 2, 'expected the second click to reach the core sweep');
		assert.isFalse(marker.isPopupOpen(), 'expected the second click to close the popup');
		assert.equal(
			marker.pm.enabled(),
			false,
			'expected the marker still locked after the closing click',
		);

		// the box is the way out, and no later re-assert locks it back
		await click();
		assert.isTrue(marker.isPopupOpen(), 'expected the third click to reopen the popup');
		const unlock = tool.console_panel.querySelector(
			'.uca-maps-object-section .uca-maps-geoman input',
		);
		unlock.checked = true;
		unlock.dispatchEvent(new Event('change'));
		assert.equal(marker.pm.enabled(), true, 'expected the ticked box to unlock the marker');
		await click();
		assert.isFalse(marker.isPopupOpen(), 'expected the fourth click to close the popup');
		assert.equal(
			marker.pm.enabled(),
			true,
			"expected the marker still unlocked after the closing click's re-assert",
		);
	});

	it('a click on the empty map stops editing a ticked object even with its popup open, as v6', async function () {
		tool.attach_console();
		const polygon = seeded_layer(1);
		tool.set_geoman_edition(polygon, true);
		polygon.openPopup();
		await tick();
		assert.equal(
			polygon.pm.enabled(),
			true,
			'expected the ticked object in edit mode, its popup open',
		);

		// a REAL click on the empty map: the open popup closes on that click's
		// 'preclick' ('popupclose'), then the core's map click turns editing off
		// for every layer; the popupclose re-assert must not turn it back on
		geolocation.map
			.getContainer()
			.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
		assert.isFalse(polygon.isPopupOpen(), 'expected the click to close the popup');
		assert.equal(polygon.pm.enabled(), false, 'expected the core map click to stop editing');
		await tick();
		assert.equal(
			polygon.pm.enabled(),
			false,
			'expected the object still off after the deferred re-assert',
		);
	});

	// switching popups fires popupclose then popupopen in one click
	it('switching popups turns a ticked object of another group back on, whichever of popupclose and popupopen comes first', async function () {
		tool.attach_console();
		const polygon = seeded_layer(1);
		const marker = seeded_layer(3);
		tool.set_geoman_edition(polygon, true);

		for (const order of [
			['popupclose', 'popupopen'],
			['popupopen', 'popupclose'],
		]) {
			polygon.pm.disable(); // what the core's sweep of another group leaves
			assert.equal(
				polygon.pm.enabled(),
				false,
				'expected the ticked object off before ' + order.join(' + '),
			);
			for (const type of order) {
				geolocation.map.fire(type, { popup: { _source: marker } });
			}
			await tick();
			assert.equal(
				polygon.pm.enabled(),
				true,
				'expected the full pass to turn the ticked object back on after ' + order.join(' + '),
			);
		}
	});

	// the core's click sweep enables the clicked group and stops every other
	it("a click that closes a marker's popup turns a ticked object of another group back on", async function () {
		tool.attach_console();
		const polygon = seeded_layer(1);
		const marker = seeded_layer(3);
		tool.set_geoman_edition(polygon, true);

		const click = async () => {
			marker._icon.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
			await tick();
		};
		await click();
		assert.isTrue(marker.isPopupOpen(), "expected the first click to open the marker's popup");
		assert.equal(
			polygon.pm.enabled(),
			true,
			'expected the ticked object on after the opening click',
		);

		await click();
		assert.isFalse(marker.isPopupOpen(), 'expected the second click to close the popup');
		assert.equal(
			polygon.pm.enabled(),
			true,
			'expected the ticked object back on after the closing click',
		);
	});

	// with a popup, Leaflet stops the click at the polygon; without one it
	// reaches the map's own click too, and that is still not the empty map
	it('a real click on a ticked polygon, another popup open, leaves it in edit mode, with or without its own popup', async function () {
		tool.attach_console();
		const polygon = seeded_layer(1);
		const marker = seeded_layer(3);
		tool.set_geoman_edition(polygon, true);
		const popup = polygon.getPopup();
		assert.isOk(popup, 'expected the core to bind the polygon a popup');

		try {
			for (const with_popup of [true, false]) {
				if (!with_popup) {
					polygon.unbindPopup();
				}
				marker.openPopup();
				await tick();

				assert.isOk(polygon._path, 'expected the polygon drawn on the map');
				polygon._path.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
				assert.isFalse(marker.isPopupOpen(), "expected the click to close the marker's popup");
				await tick();
				assert.equal(
					polygon.pm.enabled(),
					true,
					'expected the ticked polygon in edit mode after the deferred re-assert, ' +
						(with_popup ? 'with' : 'without') +
						' its popup',
				);
				polygon.closePopup();
				await tick();
			}
		} finally {
			polygon.bindPopup(popup);
		}
	});

	// the re-assert is a microtask: done before the browser paints, so a locked
	// object never flashes the handles the core sweep gave it
	it("a real click on a locked polygon takes the sweep's handles off before the browser can paint", async function () {
		tool.attach_console();
		const polygon = seeded_layer(1);
		tool.set_geoman_edition(polygon, false);
		let sweeps = 0;
		const real_enable = polygon.pm.enable.bind(polygon.pm);
		polygon.pm.enable = function (options) {
			sweeps++;
			return real_enable(options);
		};

		try {
			assert.isOk(polygon._path, 'expected the polygon drawn on the map');
			polygon._path.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
			assert.equal(sweeps, 1, 'expected the click to reach the core sweep');
			assert.equal(polygon.pm.enabled(), true, 'expected the sweep to have turned the handles on');
			// microtasks only: a paint needs a task boundary, and none has passed
			await Promise.resolve();
			assert.equal(
				polygon.pm.enabled(),
				false,
				'expected the handles off before any later task could paint them',
			);
		} finally {
			polygon.pm.enable = real_enable;
			polygon.closePopup();
		}
	});

	it('detach_console takes its five map listeners off and cancels a re-assert still queued', async function () {
		tool.attach_console();
		const map = geolocation.map;
		const handlers = ['popupopen', 'popupclose', 'click', 'pm:create', 'pm:remove'].map((type) => {
			const handler = tool['_' + type.replace('pm:', 'pm') + '_handler'];
			assert.isTrue(map.listens(type, handler), 'expected the console listening to ' + type);
			return [type, handler];
		});

		// a re-assert queued over a locked polygon the core sweep enabled
		const polygon = seeded_layer(1);
		tool.set_geoman_edition(polygon, false);
		polygon.pm.enable();
		map.fire('popupclose');

		detach_console(tool);

		for (const [type, handler] of handlers) {
			assert.isFalse(map.listens(type, handler), 'expected ' + type + ' taken off the map');
		}
		await tick();
		assert.equal(
			polygon.pm.enabled(),
			true,
			'expected the queued re-assert cancelled, not run on a detached console',
		);
	});

	// the core drops events_tokens only on destroy(true): the tool drops its own
	it('destroy(false) leaves no subscription of the tool behind', async function () {
		tool.attach_console();
		tool.attach_object_viewer();
		const tokens = [...tool.events_tokens];
		assert.isAtLeast(tokens.length, 2, 'expected the console and the viewer subscribed');
		const live = () => event_manager.get_events().filter((event) => tokens.includes(event.token));
		assert.equal(live().length, tokens.length, 'expected every token live before teardown');

		await tool.destroy(false, false, false);

		assert.deepEqual(live(), [], "expected the tool's subscriptions gone after destroy(false)");
	});

	it('detach_onexone removes the button and takes both map listeners off', async function () {
		tool.attach_onexone();
		const map = geolocation.map;
		const map_container_node = map.getContainer();
		assert.isOk(tool.onexone_control, 'expected the control attached first');
		const listeners = [
			['popupopen', tool._onexone_popupopen_handler],
			['pm:remove', tool._onexone_pmremove_handler],
		];
		for (const [type, handler] of listeners) {
			assert.isTrue(map.listens(type, handler), 'expected 1x1 listening to ' + type);
		}

		await tool.destroy(false, false, false);

		for (const [type, handler] of listeners) {
			assert.isFalse(map.listens(type, handler), 'expected ' + type + ' taken off the map');
		}
		assert.equal(tool.onexone_control, null, 'expected onexone_control cleared');
		assert.equal(
			tool._onexone_popupopen_handler,
			null,
			'expected _onexone_popupopen_handler cleared',
		);
		assert.equal(
			tool._onexone_pmremove_handler,
			null,
			'expected _onexone_pmremove_handler cleared',
		);
		assert.isNotOk(
			map_container_node.querySelector('.uca-maps-onexone-control'),
			'expected the button removed from the DOM',
		);
	});

	// UPLOAD FILE TO MAP, vector half (vector_upload.js). The round-trip tests
	// run the real service_upload transport and upload_vector_layer action.

	/**
	 * Releases what a test staged for real and nobody ingested, through the door
	 * the upload queue uses for a removed row. Answers each release's response.
	 */
	const release_staged = async function (staged) {
		const answers = [];
		for (const file_data of staged) {
			answers.push(
				await data_manager.request({
					body: {
						dd_api: 'dd_utils_api',
						action: 'delete_uploaded_file',
						options: { key_dir: file_data.key_dir, file_name: file_data.tmp_name },
					},
				}),
			);
		}
		return answers;
	};

	// the two halves share the guard's sentence; "no request" is counted at every
	// door, service_upload's XHR included, not at tool_request alone
	it('both upload halves refuse a missing file with upload_no_file, sending no request by any door', async function () {
		tool.attach_file_upload();

		const rows = [
			{ label: 'vector', run: () => tool.upload_vector_file(null, {}) },
			{ label: 'image', run: () => tool.upload_image_file(null) },
		];
		for (const row of rows) {
			const { result, sent } = await requests_sent_by(row.run);
			assert.deepEqual(
				result,
				{
					ok: false,
					error: tool.get_tool_label('upload_no_file') || 'Please choose a file first.',
				},
				`expected the no-file sentence, not the transport catch: ${row.label}`,
			);
			assert.deepEqual(sent, [], `expected NO request of any kind without a file: ${row.label}`);
		}
	});

	// a server without GDAL answers tool.dependency_unavailable and the case is skipped, never passed
	it('upload_vector_file (real round trip) uploads a .geojson file and creates a matching object (skipped without GDAL)', async function () {
		tool.attach_file_upload();

		let response = null;
		stub_tool_request(async function (options) {
			response = await real_tool_request(options);
			return response;
		});

		const before_layer_count = active_group().getLayers().length;
		const result = await tool.upload_vector_file(sample_vector_file(), {});
		await settle_map(geolocation.map); // the new object is fitted, which animates

		if (response && response.ok !== true) {
			assert.equal(
				response.error?.code,
				'tool.dependency_unavailable',
				`expected the only acceptable failure to be a missing GDAL binary — full response: ${JSON.stringify(response)}`,
			);
			this.skip();
		}

		assert.isTrue(
			result.ok,
			`expected the upload to succeed — full result: ${JSON.stringify(result)}`,
		);
		assert.equal(result.feature_count, 1, 'expected exactly the one uploaded feature');
		assert.equal(
			active_group().getLayers().length,
			before_layer_count + 1,
			'expected one new object added to the active FeatureGroup via pm:create',
		);
		assert.isUndefined(result.read_as, 'expected no encoding warning for a UTF-8 file');
	});

	// older software saves a GeoJSON in the system code page: converted, never U+FFFD
	it('upload_vector_file (real round trip) reads a windows-1252 .geojson as such and says so (skipped without GDAL)', async function () {
		tool.attach_file_upload();

		let response = null;
		stub_tool_request(async function (options) {
			response = await real_tool_request(options);
			return response;
		});

		const text = JSON.stringify({
			type: 'FeatureCollection',
			features: [{ ...SAMPLE_UPLOAD_GEOJSON.features[0], properties: { name: 'Ripollès' } }],
		});
		// every character is below U+0100 and outside C1: its code is its windows-1252 byte
		const bytes = Uint8Array.from(text, (character) => character.charCodeAt(0));
		const result = await tool.upload_vector_file(
			new File([bytes], 'legacy.geojson', { type: 'application/geo+json' }),
			{},
		);
		await settle_map(geolocation.map);

		if (response && response.ok !== true) {
			assert.equal(
				response.error?.code,
				'tool.dependency_unavailable',
				`expected the only acceptable failure to be a missing GDAL binary — full response: ${JSON.stringify(response)}`,
			);
			this.skip();
		}

		assert.isTrue(
			result.ok,
			`expected the upload to succeed — full result: ${JSON.stringify(result)}`,
		);
		assert.equal(
			result.read_as,
			'windows-1252',
			'expected the guessed encoding handed to the panel',
		);
		assert.equal(
			response.data.geojson.features[0].properties.name,
			'Ripollès',
			'expected the accent converted, not replaced',
		);
	});

	it('upload_vector_file (real round trip) brings a malformed EPSG code back as request.invalid_options, with no GDAL needed', async function () {
		tool.attach_file_upload();

		let response = null;
		let sent = null;
		stub_tool_request(async function (options) {
			sent = options;
			response = await real_tool_request(options);
			return response;
		});

		const file = sample_vector_file();

		// the EPSG format check runs BEFORE the ogr2ogr call (vector_upload.ts),
		// so this exercises the real staged-upload + server round trip without
		// depending on GDAL being installed. The reason rides as a key that core's
		// error_text turns into the tool's own label; the panel adds no line.
		try {
			const result = await tool.upload_vector_file(file, {
				epsg: 'not-a-code',
				zone: '30',
				band: 'N',
			});

			assert.equal(result.ok, false);
			assert.isOk(response, 'expected tool_request to have been reached');
			assert.equal(response.error && response.error.code, 'request.invalid_options');
			assert.equal(
				response.error.details?.reason_key,
				'epsg_invalid',
				'expected the reason as a key',
			);
			assert.equal(
				response.error.message,
				'The EPSG code must be 4 to 6 digits.',
				"expected the declared sentence, not the throw's",
			);
			assert.equal(
				response.error.tool,
				'tool_uca_maps',
				'expected the refusal stamped with its tool',
			);
			assert.equal(
				error_text(response.error),
				'The EPSG code must be 4 to 6 digits.',
				"expected the key's sentence, not the code's generic label",
			);
			assert.isUndefined(result.error, "expected no panel line beside core's notice");
			// all three reach the wire: a dropped zone or band would make the server
			// refuse every UTM projection, and nothing else here would notice
			assert.deepInclude(sent.options, { epsg: 'not-a-code', zone: '30', band: 'N' });
		} finally {
			if (sent?.options?.file_data) {
				await release_staged([sent.options.file_data]);
			}
		}
	});

	// a quiet drop, not the catch: building objects on a destroyed tool throws,
	// and the catch would answer an error and toast it
	it('upload_vector_file drops a response that arrives after detach_file_upload already ran', async function () {
		tool.attach_file_upload();

		let resolve_tool_request;
		let staged = null;
		stub_tool_request(
			(options) =>
				new Promise((resolve) => {
					staged = options.options.file_data;
					resolve_tool_request = resolve;
				}),
		);

		try {
			await toasts_during(async (toasts) => {
				const before_layer_count = active_group().getLayers().length;
				const pending = tool.upload_vector_file(sample_vector_file(), {});

				// the real staging upload runs first: tool_request has no "about to be
				// called" hook, so its arrival is polled
				await until(() => resolve_tool_request);
				assert.isOk(resolve_tool_request, 'expected tool_request reached within the wait budget');

				await tool.destroy(false, false, false);
				assert.equal(tool.upload_panel, null, 'expected the panel already torn down');

				resolve_tool_request({
					ok: true,
					data: { geojson: SAMPLE_UPLOAD_GEOJSON, feature_count: 1 },
				});
				const result = await pending;

				assert.deepEqual(
					result,
					{ ok: false },
					'expected a quiet drop, with no error for a panel that is gone',
				);
				assert.equal(
					toasts.length,
					0,
					'expected NO toast for an upload the closed tool left in flight',
				);
				assert.equal(
					active_group().getLayers().length,
					before_layer_count,
					'expected no object created',
				);
			});
		} finally {
			if (staged) {
				await release_staged([staged]);
			}
		}
	});

	// UPLOAD FILE TO MAP, image half (image_upload.js), in the same panel. Only
	// the browser half is here — the panel, the refusal, the overlay lifecycle
	// — on carriers built by hand (IMAGE_DESCRIPTOR); the server half is
	// test/unit/tool_uca_maps_image_overlay.test.ts's.

	it('attach_file_upload builds one button and one hidden panel carrying both the vector and the image sub-flows', function () {
		tool.attach_file_upload();

		assert.isOk(
			geolocation.map.getContainer().querySelector('.uca-maps-upload-control'),
			'expected the "Upload file to map" toggle button',
		);
		assert.equal(tool.upload_panel.hidden, true, 'expected the panel hidden by default');
		assert.isOk(
			tool.upload_panel.querySelector('.uca-maps-upload-image-file'),
			'expected the image file input in the same panel',
		);
		assert.isOk(
			tool.upload_panel.querySelector('.uca-maps-upload-file'),
			'expected the vector file input still there — one row, one panel',
		);
		// the vector half uploads from its own button, the image half on pick,
		// so it has none (the header's × is toolbar.js's)
		assert.deepEqual(
			Array.from(
				tool.upload_panel.querySelectorAll(
					':scope > :not(.uca-maps-panel-header) button, :scope > button',
				),
			).map((b) => b.className),
			['uca-maps-upload-projections-button', 'uca-maps-upload-submit'],
			"expected v6's projections toggle and the vector Upload button, nothing in the image half",
		);
	});

	it('each half owns its status line: under the vector Upload button, under the image picker', function () {
		tool.attach_file_upload();

		const children = Array.from(tool.upload_panel.children);
		const index = (selector) => children.indexOf(tool.upload_panel.querySelector(selector));
		const messages = tool.upload_panel.querySelectorAll('.uca-maps-upload-message');

		assert.equal(messages.length, 2, 'expected one status line per sub-flow');
		assert.equal(
			children.indexOf(messages[0]),
			index('.uca-maps-upload-submit') + 1,
			'expected the vector line under its Upload button',
		);
		assert.equal(
			children.indexOf(messages[1]),
			index('.uca-maps-upload-image-file') + 1,
			'expected the image line under the image picker',
		);
		assert.isAbove(
			index('.uca-maps-upload-epsg-row'),
			index('.uca-maps-upload-file'),
			"expected the projection fields BELOW the picker, in v6's order",
		);
		assert.isAbove(
			index('.uca-maps-upload-submit'),
			index('.uca-maps-upload-epsg-row'),
			'expected the Upload button after the fields it reads',
		);
	});

	it("the vector half is v6's modal: title, picker, projections toggle, EPSG/zone/band fields, projections list, then Upload", function () {
		tool.attach_file_upload();

		const panel = tool.upload_panel;
		const children = Array.from(panel.children);
		const index = (selector) => children.indexOf(panel.querySelector(selector));

		const title = panel.querySelector('.uca-maps-upload-vector-title');
		assert.isOk(title, 'expected the vector half titled, as the image half is');
		assert.equal(
			title.textContent,
			tool.get_tool_label('upload_vector_title') || 'Upload vector file',
		);

		const order = [
			'.uca-maps-upload-vector-title',
			'.uca-maps-upload-file',
			'.uca-maps-upload-projections-button',
			'.uca-maps-upload-epsg-row',
			'.uca-maps-upload-projections-list',
			'.uca-maps-upload-submit',
			'.uca-maps-upload-message',
		].map(index);
		assert.deepEqual(
			order,
			[...order].sort((a, b) => a - b),
			"expected v6's order, got " + order,
		);
		assert.notInclude(order, -1);

		const row = panel.querySelector('.uca-maps-upload-epsg-row');
		const inputs = Array.from(row.querySelectorAll('input'));
		assert.deepEqual(
			inputs.map((i) => i.placeholder),
			['32619', '19', 'N'],
			"expected v6's three fields and placeholders",
		);
		assert.deepEqual(
			inputs.map((i) => i.getAttribute('aria-label')),
			['EPSG', 'zone', 'band'],
		);
		assert.deepEqual(
			Array.from(row.querySelectorAll('span')).map((s) => s.textContent),
			['EPSG: ', 'zone: ', 'band: '],
		);
	});

	it('"Default projections" shows and hides v6\'s 18 codes', function () {
		tool.attach_file_upload();

		const button = tool.upload_panel.querySelector('.uca-maps-upload-projections-button');
		const list = tool.upload_panel.querySelector('.uca-maps-upload-projections-list');

		assert.equal(button.type, 'button');
		assert.equal(list.hidden, true, 'expected the list closed at first, as in v6');
		assert.equal(button.getAttribute('aria-expanded'), 'false');
		assert.equal((list.textContent.match(/EPSG:\d+/g) || []).length, 18);
		assert.include(list.textContent, 'EPSG:25830');

		button.click();
		assert.equal(list.hidden, false);
		assert.equal(button.getAttribute('aria-expanded'), 'true');

		button.click();
		assert.equal(list.hidden, true);
		assert.equal(button.getAttribute('aria-expanded'), 'false');
	});

	it('the epsg.io link follows the typed EPSG code, escaped', function () {
		tool.attach_file_upload();

		const input = tool.upload_panel.querySelector('.uca-maps-upload-epsg');
		const link = tool.upload_panel.querySelector('.uca-maps-upload-epsg-link');
		assert.equal(link.getAttribute('href'), 'https://epsg.io/');
		assert.equal(link.rel, 'noopener noreferrer');

		input.value = '25830';
		input.dispatchEvent(new Event('input'));
		assert.equal(link.getAttribute('href'), 'https://epsg.io/25830');
		assert.equal(link.textContent, 'https://epsg.io/25830');

		input.value = '"><b>x';
		input.dispatchEvent(new Event('input'));
		assert.equal(link.getAttribute('href'), 'https://epsg.io/' + encodeURIComponent('"><b>x'));
		assert.equal(link.children.length, 0, 'expected text only, never markup');
	});

	it('choosing an image uploads it, and its result lands in the image half only', async function () {
		tool.attach_file_upload();

		const picker = tool.upload_panel.querySelector('.uca-maps-upload-image-file');
		const messages = tool.upload_panel.querySelectorAll('.uca-maps-upload-message');
		const file = image_file();

		let asked_for = null;
		let disabled_during = null;
		tool.upload_image_file = async function (given) {
			asked_for = given;
			disabled_during = picker.disabled;
			return { ok: true, georeferenced: true };
		};

		pick_file(picker, file);
		await tick();

		assert.equal(asked_for, file, 'expected the upload fired by the pick, with no second click');
		assert.equal(disabled_during, true, 'expected the picker disabled for the round trip');
		assert.equal(picker.disabled, false, 'expected the picker enabled again afterwards');
		assert.equal(
			picker.value,
			'',
			'expected the picker emptied, so the same file can be picked again',
		);
		assert.equal(messages[0].hidden, true, "expected the vector half's line untouched");
		assert.equal(messages[1].hidden, false, 'expected the result in the image half');
		assert.equal(
			messages[1].textContent,
			tool.get_tool_label('upload_image_success_placed') || 'Image placed at its own coordinates.',
		);
		assert.equal(messages[1].dataset.type, 'ok', 'expected a success, not the error tint');
	});

	it('an upload of either half that outlives the panel writes nothing to it', async function () {
		const rows = [
			{
				label: 'vector',
				picker: '.uca-maps-upload-file',
				line: 0,
				method: 'upload_vector_file',
				start: (panel, picker) => {
					load_file(picker, vector_file());
					panel.querySelector('.uca-maps-upload-submit').click();
				},
			},
			{
				label: 'image',
				picker: '.uca-maps-upload-image-file',
				line: 1,
				method: 'upload_image_file',
				start: (_panel, picker) => pick_file(picker, image_file()),
			},
		];
		for (const row of rows) {
			tool.attach_file_upload();

			const panel = tool.upload_panel;
			const picker = panel.querySelector(row.picker);
			const submit = panel.querySelector('.uca-maps-upload-submit');
			const message = panel.querySelectorAll('.uca-maps-upload-message')[row.line];

			let settle = null;
			tool[row.method] = function () {
				return new Promise((resolve) => {
					settle = resolve;
				});
			};

			row.start(panel, picker);
			await tick();
			assert.isOk(settle, `expected the upload in flight: ${row.label}`);

			detach_file_upload(tool); // the panel's own teardown, as destroy() runs it
			assert.equal(tool.upload_panel, null, `expected the panel already torn down: ${row.label}`);
			const left = { hidden: message.hidden, text: message.textContent, submit: submit.disabled };
			settle({ ok: false, error: 'late answer' });
			await tick();

			assert.equal(message.isConnected, false, `expected the panel gone: ${row.label}`);
			assert.deepEqual(
				{ hidden: message.hidden, text: message.textContent, submit: submit.disabled },
				left,
				`expected the late answer never written: ${row.label}`,
			);
			assert.equal(
				picker.disabled,
				true,
				`expected the detached picker left as it was: ${row.label}`,
			);
		}
	});

	/** Runs `fn` with window.setTimeout recorded: each timer's id, delay and callback. */
	const timers_set_by = async function (fn) {
		const timers = [];
		const original = window.setTimeout;
		window.setTimeout = function (callback, ms, ...rest) {
			const id = original.call(window, callback, ms, ...rest);
			timers.push({ id, ms, callback });
			return id;
		};
		try {
			await fn();
		} finally {
			window.setTimeout = original;
		}
		return timers;
	};

	// the map is the confirmation of a success, so its line goes; an error, or
	// a file that read nothing, is read while fixing the input, so it stays
	it('a success or caveat line hides after UPLOAD_MESSAGE_MS; an error or "read nothing" stays until the next gesture', async function () {
		assert.isAtLeast(
			UPLOAD_MESSAGE_MS,
			1000,
			'expected a couple of seconds, long enough to be read',
		);
		assert.isAtMost(UPLOAD_MESSAGE_MS, 3000, 'expected a couple of seconds, not a lingering line');

		tool.attach_file_upload();

		const panel = tool.upload_panel;
		const messages = panel.querySelectorAll('.uca-maps-upload-message');
		const vector_picker = panel.querySelector('.uca-maps-upload-file');
		const image_picker = panel.querySelector('.uca-maps-upload-image-file');
		const submit = panel.querySelector('.uca-maps-upload-submit');

		const halves = {
			vector: {
				method: 'upload_vector_file',
				message: messages[0],
				run: () => {
					load_file(vector_picker, vector_file());
					submit.click();
				},
				// the next Upload clears the line before its own answer
				next: { hidden: true },
			},
			image: {
				method: 'upload_image_file',
				message: messages[1],
				run: () => pick_file(image_picker, image_file()),
				// the next pick replaces it with its neutral working line
				next: { hidden: false, text: 'Uploading the image…', type: 'info' },
			},
		};
		const rows = [
			{
				half: 'image',
				answer: { ok: true, georeferenced: false },
				text:
					tool.get_tool_label('upload_image_success_viewport') ||
					'The image carries no coordinates: placed over the current view.',
				type: 'warning',
				hides: true,
			},
			{
				half: 'image',
				answer: { ok: false, error: 'the ingest refused it' },
				text: 'the ingest refused it',
				type: 'error',
				hides: false,
			},
			{
				half: 'vector',
				answer: { ok: true, feature_count: 2 },
				text:
					(tool.get_tool_label('upload_success_message') || 'File uploaded successfully.') + ' (2)',
				type: 'ok',
				hides: true,
				// only a success empties the picker: a failure keeps the file for the retry
				check: () =>
					assert.equal(vector_picker.value, '', 'expected the picker emptied after a success'),
			},
			{
				half: 'vector',
				answer: { ok: true, feature_count: 2, read_as: 'windows-1252' },
				text:
					(tool.get_tool_label('upload_success_message') || 'File uploaded successfully.') +
					' (2) ' +
					(tool.get_tool_label('upload_encoding_converted') ||
						"It was not in UTF-8 and was read as Windows-1252: check the objects' texts."),
				// read while checking the objects' texts: it stays
				type: 'warning',
				hides: false,
				check: () =>
					assert.equal(vector_picker.value, '', 'expected the picker emptied after a success'),
			},
			{
				half: 'vector',
				answer: { ok: true, feature_count: 0 },
				text:
					tool.get_tool_label('upload_no_features') || 'No objects could be read from this file.',
				type: 'warning',
				hides: false,
			},
			{
				half: 'vector',
				answer: { ok: false, error: 'zone and band do not match' },
				text: 'zone and band do not match',
				type: 'error',
				hides: false,
			},
		];
		for (const row of rows) {
			const half = halves[row.half];
			const message = half.message;
			const label = `${row.half} ${JSON.stringify(row.answer)}`;
			tool[half.method] = async function () {
				return row.answer;
			};

			const timers = await timers_set_by(async () => {
				half.run();
				await tick();
			});

			assert.equal(message.hidden, false, `expected the line shown: ${label}`);
			assert.equal(message.textContent, row.text, label);
			assert.equal(message.dataset.type, row.type, label);
			if (row.check) {
				row.check();
			}
			if (row.hides) {
				const timer = timers.find((candidate) => candidate.id === message._uca_maps_hide_timer);
				assert.isOk(timer, `expected a hide timer armed: ${label}`);
				assert.equal(timer.ms, UPLOAD_MESSAGE_MS, label);
				timer.callback();
				assert.equal(message.hidden, true, `expected the line gone once its timer fires: ${label}`);
				continue;
			}
			assert.isNull(
				message._uca_maps_hide_timer,
				`expected NO hide timer, the line stays: ${label}`,
			);

			// the next gesture is what removes it, before its own answer
			let settle = null;
			tool[half.method] = () =>
				new Promise((resolve) => {
					settle = resolve;
				});
			half.run();
			assert.equal(
				message.hidden,
				half.next.hidden,
				`expected the next gesture to take the line: ${label}`,
			);
			if (!half.next.hidden) {
				assert.equal(message.textContent, half.next.text, label);
				assert.equal(message.dataset.type, half.next.type, label);
			}
			settle({ ok: false });
			await tick();
		}
	});

	it('UP closed by a SIBLING panel reopens clean too, in both halves', async function () {
		tool.attach_file_upload();
		tool.attach_map_image_download_control();

		const panel = tool.upload_panel;
		const messages = panel.querySelectorAll('.uca-maps-upload-message');
		const vector_picker = panel.querySelector('.uca-maps-upload-file');
		const image_picker = panel.querySelector('.uca-maps-upload-image-file');
		tool.upload_vector_file = async function () {
			return { ok: false, error: 'vector refused' };
		};
		tool.upload_image_file = async function () {
			return { ok: false, error: 'image refused' };
		};

		tool.upload_control.getContainer().click();

		load_file(vector_picker, vector_file());
		panel.querySelector('.uca-maps-upload-epsg').value = '25830';
		panel.querySelector('.uca-maps-upload-submit').click();
		pick_file(image_picker, image_file());
		await tick();
		assert.equal(messages[0].hidden, false, 'expected the vector error shown');
		assert.equal(messages[1].hidden, false, 'expected the image error shown');

		// closed by toolbar.js close_other_toolbar_panels, never by UP's own toggle
		tool.map_image_control.getContainer().click();
		assert.equal(panel.hidden, true, 'expected UP closed by the sibling');
		tool.upload_control.getContainer().click();

		assert.equal(messages[0].hidden, true, 'expected no vector message');
		assert.equal(messages[1].hidden, true, 'expected no image message');
		assert.equal(vector_picker.files.length, 0, 'expected no vector file chosen');
		assert.equal(image_picker.value, '', 'expected no image file chosen');
		assert.equal(panel.querySelector('.uca-maps-upload-epsg').value, '', 'expected EPSG empty');
	});

	it("reopening UP mid-upload leaves that half's file and working line alone", async function () {
		tool.attach_file_upload();

		const panel = tool.upload_panel;
		const toggle = () => tool.upload_control.getContainer().click();
		const picker = panel.querySelector('.uca-maps-upload-image-file');
		const message = panel.querySelectorAll('.uca-maps-upload-message')[1];

		let settle = null;
		tool.upload_image_file = function () {
			return new Promise((resolve) => {
				settle = resolve;
			});
		};

		toggle();
		pick_file(picker, image_file());
		await tick();
		assert.isOk(settle, 'expected the upload in flight');
		assert.equal(message.hidden, false, 'expected the working line shown');

		toggle();
		toggle();
		assert.equal(message.hidden, false, 'expected the working line kept while the upload runs');
		assert.equal(picker.disabled, true, 'expected the picker still locked');

		settle({ ok: true, georeferenced: true });
		await tick();
		assert.equal(
			message.textContent,
			tool.get_tool_label('upload_image_success_placed') || 'Image placed at its own coordinates.',
		);
		assert.equal(picker.disabled, false);
	});

	it('reopening UP mid vector upload leaves its file, fields and controls alone', async function () {
		tool.attach_file_upload();

		const panel = tool.upload_panel;
		const toggle = () => tool.upload_control.getContainer().click();
		const picker = panel.querySelector('.uca-maps-upload-file');
		const submit = panel.querySelector('.uca-maps-upload-submit');
		const message = panel.querySelectorAll('.uca-maps-upload-message')[0];
		const inputs = Array.from(panel.querySelectorAll('.uca-maps-upload-epsg-row input'));
		const file = vector_file();

		let settle = null;
		tool.upload_vector_file = function () {
			return new Promise((resolve) => {
				settle = resolve;
			});
		};

		toggle();
		load_file(picker, file);
		inputs[0].value = '25830';
		inputs[1].value = '30';
		inputs[2].value = 'N';
		submit.click();
		await tick();
		assert.isOk(settle, 'expected the upload in flight');

		toggle();
		toggle();
		assert.equal(picker.files[0], file, 'expected the file kept while the upload runs');
		assert.deepEqual(
			inputs.map((i) => i.value),
			['25830', '30', 'N'],
			'expected the fields kept',
		);
		assert.equal(picker.disabled, true, 'expected the picker still locked');
		assert.equal(submit.disabled, true, 'expected Upload still locked');

		settle({ ok: true, feature_count: 1 });
		await tick();
		assert.equal(
			message.textContent,
			(tool.get_tool_label('upload_success_message') || 'File uploaded successfully.') + ' (1)',
		);
		assert.equal(submit.disabled, false);
	});

	it("reopening UP starts clean, as v6's rebuilt modal: no message, no file, no projection", async function () {
		tool.attach_file_upload();

		const panel = tool.upload_panel;
		const toggle = () => tool.upload_control.getContainer().click();
		const picker = panel.querySelector('.uca-maps-upload-file');
		const epsg = panel.querySelector('.uca-maps-upload-epsg');
		const link = panel.querySelector('.uca-maps-upload-epsg-link');
		const list = panel.querySelector('.uca-maps-upload-projections-list');
		const message = panel.querySelectorAll('.uca-maps-upload-message')[0];
		tool.upload_vector_file = async function () {
			return { ok: false, error: 'Please choose a file first.' };
		};

		toggle();
		assert.equal(panel.hidden, false, 'expected UP open');

		load_file(picker, vector_file());
		epsg.value = '25830';
		epsg.dispatchEvent(new Event('input'));
		panel.querySelector('.uca-maps-upload-zone').value = '30';
		panel.querySelector('.uca-maps-upload-band').value = 'N';
		panel.querySelector('.uca-maps-upload-projections-button').click();
		panel.querySelector('.uca-maps-upload-submit').click();
		await tick();
		assert.equal(message.hidden, false, 'expected the error shown');

		toggle();
		assert.equal(panel.hidden, true, 'expected UP closed');
		toggle();

		assert.equal(message.hidden, true, 'expected no message on reopening');
		assert.equal(picker.files.length, 0, 'expected no file chosen');
		assert.deepEqual(
			Array.from(panel.querySelectorAll('.uca-maps-upload-epsg-row input')).map((i) => i.value),
			['', '', ''],
			'expected EPSG, zone and band empty',
		);
		assert.equal(
			link.getAttribute('href'),
			'https://epsg.io/',
			'expected the epsg.io link back to its base',
		);
		assert.equal(list.hidden, true, 'expected the projections list closed');
	});

	it('the teardown cancels a pending hide timer', async function () {
		tool.attach_file_upload();

		const picker = tool.upload_panel.querySelector('.uca-maps-upload-image-file');
		const message = tool.upload_panel.querySelectorAll('.uca-maps-upload-message')[1];
		tool.upload_image_file = async function () {
			return { ok: true, georeferenced: true };
		};

		pick_file(picker, image_file());
		await tick();
		const timer = message._uca_maps_hide_timer;
		assert.isOk(timer, 'expected a hide timer armed');

		const cleared = [];
		const original_clear = window.clearTimeout;
		window.clearTimeout = function (id) {
			cleared.push(id);
			return original_clear.call(window, id);
		};
		try {
			await tool.destroy(false, false, false);
		} finally {
			window.clearTimeout = original_clear;
		}
		assert.include(cleared, timer, 'expected the armed timer itself cancelled, not just forgotten');
		assert.equal(message._uca_maps_hide_timer, null, 'expected the timer cancelled with the panel');
	});

	it('choosing a vector file uploads nothing; Upload sends it with the EPSG, zone and band typed, and a failure keeps it', async function () {
		tool.attach_file_upload();

		const picker = tool.upload_panel.querySelector('.uca-maps-upload-file');
		const submit = tool.upload_panel.querySelector('.uca-maps-upload-submit');
		const messages = tool.upload_panel.querySelectorAll('.uca-maps-upload-message');
		tool.upload_panel.querySelector('.uca-maps-upload-epsg').value = '25830';
		tool.upload_panel.querySelector('.uca-maps-upload-zone').value = '30';
		tool.upload_panel.querySelector('.uca-maps-upload-band').value = 'N';

		let asked_for = null;
		tool.upload_vector_file = async function (file, projection) {
			asked_for = { file, projection };
			return { ok: false, error: 'no coordinate system' };
		};

		const file = vector_file();
		pick_file(picker, file);
		await tick();
		assert.equal(asked_for, null, 'expected choosing the file to upload nothing');

		submit.click();
		await tick();

		assert.deepEqual(
			asked_for,
			{ file, projection: { epsg: '25830', zone: '30', band: 'N' } },
			"expected Upload to send the chosen file with the three fields' values",
		);
		// the retry is: correct the fields, press Upload again
		assert.equal(picker.files[0], file, 'expected the file kept after a failure');
		assert.equal(submit.disabled, false, 'expected Upload enabled again');
		assert.equal(
			messages[0].textContent,
			'no coordinate system',
			'expected the error in the vector half',
		);
		assert.equal(messages[1].hidden, true, "expected the image half's line untouched");
	});

	/** The body core's tool_request sends for `action` and `options`, captured, never sent. */
	const tool_request_body = async function (action, options) {
		let body = null;
		const original = data_manager.request;
		data_manager.request = async function (request) {
			body = request.body;
			return { ok: true, data: null };
		};
		try {
			await tool_uca_maps.prototype.tool_request.call(tool, { action, options });
		} finally {
			data_manager.request = original;
		}
		return body;
	};

	/**
	 * Stands in for core's create, the ingest, the file check and delete, so no
	 * record is ever written; the staging upload stays real (service_upload).
	 * `ingest` answers per call; every staged file is kept for release_staged.
	 * The file check answers "no file" unless `file_check` says otherwise.
	 */
	const no_image_file = () => ({
		ok: false,
		error: {
			is_api_error: true,
			code: 'resource.not_found',
			details: { reason_key: 'image_not_on_server' },
			message: 'The image is no longer on the server.',
			transport: false,
		},
	});
	const stub_image_record_doors = function (
		new_id,
		ingest,
		delete_answer,
		file_check = no_image_file,
	) {
		const original_request = data_manager.request;
		const seen = { created: [], deleted: [], staged: [], checked: [] };
		data_manager.request = async function (options) {
			const body = options && options.body;
			if (body && body.action === 'create') {
				seen.created.push(body);
				return { ok: true, data: new_id };
			}
			if (
				body &&
				body.action === 'tool_request' &&
				body.source &&
				body.source.action === 'process_uploaded_file'
			) {
				seen.staged.push(body.options.file_data);
				return ingest();
			}
			if (
				body &&
				body.action === 'tool_request' &&
				body.source &&
				body.source.action === 'get_image_file'
			) {
				seen.checked.push(body.options);
				return file_check();
			}
			if (body && body.action === 'delete') {
				seen.deleted.push(body);
				return delete_answer();
			}
			return original_request.apply(this, arguments);
		};
		seen.restore = async function () {
			data_manager.request = original_request;
			return await release_staged(seen.staged);
		};
		return seen;
	};

	// only a refusal raised before the file moved, with no file found after it,
	// proves the record empty; any other answer may still be filling it, so it
	// is named, never deleted
	it('only a refusal raised before the file moved, on a record with no file, deletes it; any other failure names it', async function () {
		const NEW_ID = 987654;
		const reason = 'The staged file is not an image';
		const refusal = {
			is_api_error: true,
			code: 'request.invalid_options',
			label_key: 'error_request_invalid_options',
			message: reason,
			transport: false,
		};
		const record_left = 'Image record ' + NEW_ID + ' may have been left empty: review it.';
		const rows = [
			{
				label: 'a clean ingest',
				ingest: null,
				answer: null,
				deletes: false,
				result: { ok: true, section_id: NEW_ID },
			},
			{
				label: 'an envelope refusal',
				ingest: refusal,
				answer: { ok: true, data: [NEW_ID] },
				deletes: true,
				result: { ok: false, staged_untouched: true },
			},
			{
				label: 'a timeout: the server may still finish',
				ingest: {
					is_api_error: true,
					code: 'client.timeout',
					message: 'The request timed out',
					transport: true,
				},
				answer: null,
				deletes: false,
				result: { ok: false, error: record_left, staged_untouched: false },
			},
			{
				// what a resend gets while the first attempt is still ingesting
				label: 'an idempotency replay: an envelope, yet the ingest is running',
				ingest: {
					is_api_error: true,
					code: 'idempotency.in_progress',
					message: 'Still running',
					transport: false,
				},
				answer: null,
				deletes: false,
				result: { ok: false, error: record_left, staged_untouched: false },
			},
			{
				// persistUploadedMedia refusing AFTER the file is in the media tree
				label: 'a failure after the move: the file is on disk',
				ingest: {
					is_api_error: true,
					code: 'db.lock_timeout',
					message: 'Lock timeout',
					transport: false,
				},
				answer: null,
				deletes: false,
				result: { ok: false, error: record_left, staged_untouched: false },
			},
			{
				// a resend re-run after a restart: the first run consumed the staged file
				label: 'a staged file already consumed',
				ingest: {
					is_api_error: true,
					code: 'media.file_not_found',
					message: 'Staged upload not found',
					transport: false,
				},
				answer: null,
				deletes: false,
				result: { ok: false, error: record_left, staged_untouched: false },
			},
			{
				label: 'an envelope refusal whose delete is refused',
				ingest: refusal,
				answer: {
					ok: false,
					error: {
						is_api_error: true,
						code: 'perm.denied',
						message: 'Permission denied',
						transport: false,
					},
				},
				deletes: true,
				result: { ok: false, error: record_left, staged_untouched: true },
			},
			{
				// core answers no id for a record it did not find, or one it kept
				label: 'an envelope refusal whose delete removes nothing',
				ingest: refusal,
				answer: { ok: true, data: [] },
				deletes: true,
				result: { ok: false, error: record_left, staged_untouched: true },
			},
			{
				// a refusal core raises after the move one day: the file is the fact
				label: 'an envelope refusal on a record that holds a file',
				ingest: refusal,
				check: () => ({
					ok: true,
					data: { file_path: '/image/1.5MB/0/rsc29_rsc170_' + NEW_ID + '.jpg', quality: '1.5MB' },
				}),
				answer: null,
				deletes: false,
				result: { ok: false, error: record_left, staged_untouched: true },
			},
			{
				label: 'an envelope refusal whose file check fails',
				ingest: refusal,
				check: () => ({
					ok: false,
					error: {
						is_api_error: true,
						code: 'client.timeout',
						message: 'The request timed out',
						transport: true,
					},
				}),
				answer: null,
				deletes: false,
				result: { ok: false, error: record_left, staged_untouched: true },
			},
		];

		const released = [];
		for (const row of rows) {
			const seen = stub_image_record_doors(
				NEW_ID,
				() => (row.ingest ? { ok: false, error: row.ingest } : { ok: true, data: true }),
				() => row.answer,
				row.check,
			);
			let result;
			try {
				result = await ingest_image_upload(tool, one_pixel_png());
			} finally {
				released.push(...(await seen.restore()));
			}

			assert.equal(
				seen.created.length,
				1,
				`expected the record minted before the ingest: ${row.label}`,
			);
			assert.equal(
				seen.created[0].source.section_tipo,
				IMAGE_SECTION_TIPO,
				`expected it minted in the Images section: ${row.label}`,
			);
			// the refusal rides along for a batch's report; core's notice shows it here
			assert.deepEqual(
				result,
				row.ingest ? { ...row.result, refusal: row.ingest } : row.result,
				row.label,
			);
			const pre_move = row.ingest === refusal;
			assert.deepEqual(
				seen.checked,
				pre_move
					? [{ tipo: IMAGE_COMPONENT_TIPO, section_tipo: IMAGE_SECTION_TIPO, section_id: NEW_ID }]
					: [],
				`expected the minted record's file checked only after a pre-move refusal: ${row.label}`,
			);
			if (row.deletes) {
				assert.deepEqual(
					seen.deleted,
					[
						{
							action: 'delete',
							source: {
								delete_mode: 'delete_record',
								section_tipo: IMAGE_SECTION_TIPO,
								section_id: NEW_ID,
							},
						},
					],
					`expected the minted record, and only it, deleted once: ${row.label}`,
				);
			} else {
				assert.deepEqual(seen.deleted, [], `expected nothing deleted: ${row.label}`);
			}
		}
		assert.equal(released.length, rows.length, "expected every row's staged file released");
		assert.isTrue(
			released.every((answer) => answer && answer.ok !== false),
			`expected the staging left clean: ${JSON.stringify(released)}`,
		);
	});

	// a refusal of the step after the ingest: core's notice says why, the
	// panel adds no line
	it('an image refusal leaves no panel line: the map overlay and an associated image', async function () {
		tool.attach_file_upload();
		const layer = seeded_layer(1);
		tool.active_console_layer = layer;

		const reason = 'Coordinates out of range';
		const rows = [
			{
				label: 'overlay',
				action: 'get_image_overlay',
				run: () => tool.upload_image_file(one_pixel_png()),
			},
			{
				label: 'associate_image',
				action: 'get_image_file',
				run: () => associate_image(tool, layer, one_pixel_png()),
			},
		];
		const seen = stub_image_record_doors(
			9100,
			() => ({ ok: true, data: true }),
			() => ({ ok: true, data: [] }),
		);
		let released = [];
		try {
			for (const row of rows) {
				let asked = null;
				stub_tool_request(async function (options) {
					if (options.action !== row.action) {
						return real_tool_request(options);
					}
					asked = options.action;
					return {
						ok: false,
						error: {
							is_api_error: true,
							code: 'request.invalid_options',
							label_key: 'error_request_invalid_options',
							message: reason,
							transport: false,
						},
					};
				});
				const result = await row.run();
				assert.equal(asked, row.action, `expected the step after the ingest reached: ${row.label}`);
				assert.isFalse(result.ok, row.label);
				assert.isUndefined(result.error, `expected no panel line: ${row.label}`);
			}
		} finally {
			released = await seen.restore();
		}
		assert.deepEqual(object_images(layer), [], 'expected nothing hung off the object');
		assert.equal(released.length, rows.length, 'expected both staged files released');
	});

	// the three outcomes the panel tells apart, each ending with the image on the map
	it('an accepted image lands on the map, placed, over the view, or over the view for want of GDAL', async function () {
		tool.attach_file_upload();
		const CORNERS = {
			top_left: [40.46, -3.66],
			top_right: [40.46, -3.64],
			bottom_left: [40.44, -3.66],
		};
		const rows = [
			{
				label: 'placed by its own coordinates',
				answer: { georeferenced: true, corners: CORNERS },
				result: { ok: true, georeferenced: true, georeference_unavailable: false },
			},
			{
				label: 'no coordinates',
				answer: { georeferenced: false, corners: null },
				result: { ok: true, georeferenced: false, georeference_unavailable: false },
			},
			{
				label: 'GDAL missing',
				answer: { georeferenced: false, georeference_unavailable: true, corners: null },
				result: { ok: true, georeferenced: false, georeference_unavailable: true },
			},
		];
		const seen = stub_image_record_doors(
			9200,
			() => ({ ok: true, data: true }),
			() => ({ ok: true, data: [] }),
		);
		const carrier_of = (file_path) => {
			let found = null;
			geolocation.map.eachLayer((layer) => {
				if (layer.feature?.properties?.uca_maps?.image?.file_path === file_path) found = layer;
			});
			return found;
		};
		try {
			for (const [index, row] of rows.entries()) {
				const file_path = `/image/1.5MB/0/rsc29_rsc170_${9200 + index}.jpg`;
				stub_tool_request(async function (options) {
					if (options.action !== 'get_image_overlay') {
						return real_tool_request(options);
					}
					return { ok: true, data: { file_path, quality: '1.5MB', ...row.answer } };
				});
				assert.deepEqual(await tool.upload_image_file(one_pixel_png()), row.result, row.label);
				await settle_map(geolocation.map);

				const carrier = carrier_of(file_path);
				assert.isOk(carrier, `expected the image's carrier on the map: ${row.label}`);
				assert.isOk(await await_overlay(carrier), `expected its overlay drawn: ${row.label}`);
				assert.isTrue(geolocation.map.hasLayer(carrier._uca_maps_overlay), row.label);
				if (row.answer.corners) {
					assert.deepEqual(
						carrier.feature.properties.uca_maps.image.corners,
						CORNERS,
						"expected the server's corners kept",
					);
				}
			}
		} finally {
			await seen.restore();
		}
	});

	// a link can fail past the stage too: a stage that names no file, or an
	// ingested image the server does not serve
	it('import_linked_images names a link whose stage brings no file, or whose ingested image is not served', async function () {
		const layer = seeded_layer(1);
		tool.active_console_layer = layer;
		const empty = { url: 'https://images.example/empty.jpg' };
		const unserved = { url: 'https://images.example/unserved.jpg' };
		layer.feature.properties.images = [empty, unserved];
		layer.feature.properties.uca_maps = {};

		const reason = 'No displayable version';
		const seen = stub_linked_import((url) =>
			url === empty.url ? { ok: true, data: {} } : staged_answer('unserved.jpg'),
		);
		const stub_body = data_manager.request;
		let stage_body = null;
		data_manager.request = function (options, ...rest) {
			const body = options?.body;
			if (body?.source?.action === 'stage_external_image' && !stage_body) {
				stage_body = body;
			}
			return stub_body.call(this, options, ...rest);
		};
		stub_tool_request(async function (options) {
			return options.action === 'get_image_file'
				? {
						ok: false,
						error: {
							is_api_error: true,
							code: 'request.invalid_options',
							message: reason,
							transport: false,
						},
					}
				: real_tool_request(options);
		});
		try {
			const result = await import_linked_images(tool, layer);

			assert.deepEqual(
				result.failures,
				[
					{ url: empty.url, error: 'The image could not be loaded.' },
					{ url: unserved.url, error: reason },
				],
				'expected each link named with why it failed',
			);
			assert.equal(result.imported, 0);
			assert.equal(
				seen.created,
				1,
				'expected a record minted only for the link that staged a file',
			);
			assert.deepEqual(
				layer.feature.properties.images,
				[empty, unserved],
				'expected both links kept',
			);
			assert.deepEqual(object_images(layer), [], 'expected nothing hung off the object');

			data_manager.request = stub_body;
			assert.deepEqual(
				stage_body,
				await tool_request_body('stage_external_image', stage_body.options),
				'expected the stage sent as tool_request builds it, its own timeout apart',
			);
		} finally {
			data_manager.request = stub_body;
			seen.restore();
		}
	});

	it('import_linked_images asks nothing while an import is already running', async function () {
		const layer = seeded_layer(1);
		tool.active_console_layer = layer;
		layer.feature.properties.images = [{ url: 'https://images.example/a.jpg' }];
		layer.feature.properties.uca_maps = {};

		let stage = null;
		const seen = stub_linked_import(
			() =>
				new Promise((resolve) => {
					stage = resolve;
				}),
		);
		try {
			const first = import_linked_images(tool, layer);
			assert.isOk(await until(() => stage), 'expected the first run to start downloading');

			const second = await import_linked_images(tool, layer);
			assert.deepEqual(
				second,
				{ ok: false, imported: 0, failures: [] },
				'expected the second run refused outright',
			);
			assert.equal(seen.stages.length, 1, 'expected only the first run to download anything');

			// control: the first run is unaffected and imports its link
			stage(staged_answer('a.jpg'));
			assert.equal((await first).imported, 1, 'expected the running import to finish its link');
		} finally {
			seen.restore();
		}
	});

	it('attach_image_overlays rebuilds a saved overlay from its carrier rectangle', async function () {
		const carrier = add_image_carrier();

		tool.attach_image_overlays();

		// the plugin loads on demand (classic <script>): the overlay waits for it
		await await_overlay(carrier);

		assert.isOk(
			carrier._uca_maps_overlay,
			'expected the overlay rebuilt from properties.uca_maps.image',
		);
		assert.equal(
			geolocation.map.hasLayer(carrier._uca_maps_overlay),
			true,
			'expected the overlay actually on the map',
		);
		assert.equal(tool._image_overlays.length, 1, 'expected the overlay tracked for teardown');
	});

	it('a coordinate-less image keeps its own aspect ratio and does not fill the viewport', function () {
		// v6 stretches the image onto map.getBounds(): every image distorts the
		// moment the map is not square, and it hides the map it must be placed
		// against. Both departures are deliberate (corners_from_viewport).
		const viewport = geolocation.map.getSize();
		assert.isAbove(
			viewport.x,
			0,
			'expected a laid-out map — every assertion below is in its pixels',
		);
		assert.isAbove(
			viewport.y,
			0,
			'expected a laid-out map — every assertion below is in its pixels',
		);
		const map_ratio = viewport.x / viewport.y;

		// a deliberately NON-square image, so a stretched result is unmissable
		const corners = corners_from_viewport(geolocation.map, { width: 400, height: 100 });

		// measured back in PIXELS, as degrees of lat and lon differ on screen.
		// Unrounded (map.project): latLngToContainerPoint rounds to whole pixels,
		// which on a short map moves a 4:1 ratio by more than any tolerance means
		const to_point = (c) => geolocation.map.project(L.latLng(c[0], c[1]));
		const tl = to_point(corners.top_left);
		const tr = to_point(corners.top_right);
		const bl = to_point(corners.bottom_left);
		const drawn_w = tr.x - tl.x;
		const drawn_h = bl.y - tl.y;
		assert.isAbove(drawn_h, 1, 'expected an image tall enough to measure a ratio on');

		assert.closeTo(
			drawn_w / drawn_h,
			4,
			0.01,
			"expected the image's own 4:1 ratio preserved, not the map's",
		);
		assert.isAbove(
			Math.abs(drawn_w / drawn_h - map_ratio),
			0.05,
			'expected the image NOT stretched to the viewport ratio (the v6 bug this replaces)',
		);

		// half the shorter side, and centred in the container
		assert.closeTo(
			drawn_w,
			Math.min(viewport.x, viewport.y) * 0.5,
			1,
			'expected half the shorter viewport side',
		);
		const in_container = (c) => geolocation.map.latLngToContainerPoint(L.latLng(c[0], c[1]));
		assert.closeTo(
			(in_container(corners.top_left).x + in_container(corners.top_right).x) / 2,
			viewport.x / 2,
			1,
			'expected horizontally centred',
		);
		assert.closeTo(
			(in_container(corners.top_left).y + in_container(corners.bottom_left).y) / 2,
			viewport.y / 2,
			1,
			'expected vertically centred',
		);
	});

	it('create_image_object flags the object is_raster so the object viewer lists it as a raster', async function () {
		// the PRODUCTION builder, not a hand-made carrier: object_viewer.js
		// collect_objects splits its two lists on properties.uca_maps.is_raster,
		// so the flag has to be written where the object is actually created
		const carrier = await create_image_object(tool, image_descriptor());

		await settle_map(geolocation.map);

		assert.equal(
			carrier.feature.properties.uca_maps.is_raster,
			true,
			'expected is_raster written by the builder',
		);
		assert.isOk(
			carrier.feature.properties.uca_maps.image,
			'expected the image descriptor stored on the object',
		);

		const objects = collect_objects(tool);

		assert.equal(objects.raster_objects.length, 1, 'expected the image in the RASTER list');
		assert.equal(
			objects.vector_objects.some((el) => el.layer === carrier),
			false,
			'expected the image NOT in the vector list',
		);
	});

	// a plain image lands at an arbitrary spot, so the next gesture is moving
	// it: v6 uploads straight into edit mode. The builder fills a MISSING flag,
	// it never decides for a caller that set one
	it('create_image_object hands a new image back editable, as v6 does, and keeps an interactive flag already given', async function () {
		for (const [given, expected] of [
			[undefined, true],
			[false, false],
		]) {
			const descriptor = image_descriptor();
			if (given === undefined) {
				// biome-ignore lint/performance/noDelete: the case where the descriptor never names the key
				delete descriptor.interactive;
			} else {
				descriptor.interactive = given;
			}

			const carrier = await create_image_object(tool, descriptor);
			await settle_map(geolocation.map);

			assert.equal(
				carrier.feature.properties.uca_maps.image.interactive,
				expected,
				`expected interactive ${expected} for a descriptor giving ${given}`,
			);
		}
	});

	it('the carrier is sealed from Geoman editing but still removable', async function () {
		// component_geolocation.js click handler calls layer.pm.enable() on
		// every layer of the clicked FeatureGroup — which painted four vertex
		// circles over the image, competing with this module's three handles.
		// Removal must survive: Geoman's remove tool is how an image is deleted
		const carrier = await create_image_object(tool, image_descriptor());
		await settle_map(geolocation.map);

		assert.equal(
			carrier.pm.options.allowEditing,
			false,
			'expected Geoman editing refused on the carrier',
		);
		assert.notEqual(
			carrier.pm.options.allowRemoval,
			false,
			'expected Geoman removal still allowed',
		);

		// and the enable() the component fires on click must be a no-op
		carrier.pm.enable();
		assert.equal(
			carrier.pm.enabled(),
			false,
			'expected pm.enable() to leave the carrier un-edited',
		);
	});

	it('dragging the carrier carries the picture, the handles and the stored corners with it', async function () {
		// Geoman's drag mode grabs the CARRIER, a transparent rectangle: unless
		// the picture follows, the user drags an invisible box and nothing seems
		// to move. v6 could not drag an image at all
		const carrier = await create_image_object(tool, image_descriptor());
		await settle_map(geolocation.map);

		const before = JSON.parse(JSON.stringify(carrier.feature.properties.uca_maps.image.corners));
		const handles = carrier._uca_maps_handles;
		assert.equal(
			handles && handles.length,
			3,
			'expected the three handles up (a new image is editable)',
		);

		const delta_lat = 0.01;
		const delta_lng = 0.02;

		// what Geoman itself does: move the layer, then announce it
		carrier.fire('pm:dragstart');
		carrier.setLatLngs(
			carrier.getLatLngs()[0].map((el) => L.latLng(el.lat + delta_lat, el.lng + delta_lng)),
		);
		carrier.fire('pm:dragend');

		const after = carrier.feature.properties.uca_maps.image.corners;
		for (const key of ['top_left', 'top_right', 'bottom_left']) {
			assert.closeTo(
				after[key][0],
				before[key][0] + delta_lat,
				1e-9,
				key + ' lat followed the carrier',
			);
			assert.closeTo(
				after[key][1],
				before[key][1] + delta_lng,
				1e-9,
				key + ' lng followed the carrier',
			);
		}

		// TRANSLATION ONLY: the shape is the handles' job, so the drag must not
		// have skewed or scaled anything
		assert.closeTo(
			after.top_right[1] - after.top_left[1],
			before.top_right[1] - before.top_left[1],
			1e-9,
			'expected the width unchanged by a drag',
		);

		// the picture itself, and every handle, at the stored corners
		const overlay = carrier._uca_maps_overlay;
		assert.isOk(overlay, 'expected the picture on the map');
		const placed = overlay.get_corners();
		const keys = ['top_left', 'top_right', 'bottom_left'];
		keys.forEach((key, index) => {
			for (const [label, latlng] of [
				['picture', placed[key]],
				['handle', handles[index].getLatLng()],
			]) {
				assert.closeTo(
					latlng.lat,
					after[key][0],
					1e-9,
					`expected the ${label}'s ${key} moved with the carrier`,
				);
				assert.closeTo(
					latlng.lng,
					after[key][1],
					1e-9,
					`expected the ${label}'s ${key} moved with the carrier`,
				);
			}
		});
	});

	// the carrier is the picture's selection handle: one stored off its corners (saved
	// before it followed its handles) is put back over the picture when it is drawn
	it('a stored carrier that disagrees with its corners is fitted over the picture on load', async function () {
		const carrier = add_image_carrier();
		const image = carrier.feature.properties.uca_maps.image;
		// a picture turned and moved, its carrier still where the old corners were
		image.corners = {
			top_left: [40.47, -3.67],
			top_right: [40.48, -3.65],
			bottom_left: [40.455, -3.665],
		};

		tool.attach_image_overlays();
		await await_overlay(carrier);

		const expected = hull_bounds(image.corners);
		const actual = carrier.getBounds();
		for (const corner of ['getSouthWest', 'getNorthEast']) {
			assert.closeTo(
				actual[corner]().lat,
				expected[corner]().lat,
				1e-9,
				`expected the carrier's ${corner} on the picture's hull`,
			);
			assert.closeTo(
				actual[corner]().lng,
				expected[corner]().lng,
				1e-9,
				`expected the carrier's ${corner} on the picture's hull`,
			);
		}
	});

	it('two concurrent hydrations never paint the same image twice', async function () {
		// hydrate_image_overlays runs un-serialized on every layer-data event: a
		// second rebuild must find the carrier taken, or it paints a duplicate
		// only one of which anything can reach afterwards
		const carrier = add_image_carrier();

		tool.attach_image_overlays();
		event_manager.publish('updated_layer_data_' + geolocation.id_base, {});
		event_manager.publish('updated_layer_data_' + geolocation.id_base, {});

		await await_overlay(carrier);
		// let any racing rebuild finish before counting
		await tick(100);

		assert.equal(
			tool._image_overlays.length,
			1,
			'expected exactly one overlay, not a stacked duplicate',
		);
	});

	// a stored descriptor Leaflet cannot place throws inside the rebuild: it must
	// reach the user, leave no picture, and not stop a later rebuild painting it
	it('a hydration that throws is reported once, and the next one paints a single overlay', async function () {
		const map = geolocation.map;
		const original_add_layer = map.addLayer;
		let throws = 1;
		map.addLayer = function (layer) {
			if (throws > 0 && layer instanceof L.ImageOverlay) {
				throws--;
				throw new Error('Boom.');
			}
			return original_add_layer.call(this, layer);
		};
		try {
			await toasts_during(async (toasts) => {
				const carrier = add_image_carrier();
				tool.attach_image_overlays();
				await until(() => toasts.length > 0);

				assert.deepEqual(
					toasts.map((toast) => toast.message),
					['Boom.'],
					"expected the rebuild's throw reported, once",
				);
				assert.isUndefined(carrier._uca_maps_overlay, 'expected no picture from the failed build');

				event_manager.publish(`updated_layer_data_${geolocation.id_base}`, {});
				await await_overlay(carrier);
				await tick(100);
				assert.isOk(carrier._uca_maps_overlay, 'expected the next hydration to paint the picture');
				assert.equal(tool._image_overlays.length, 1, 'expected exactly one overlay');
			});
		} finally {
			map.addLayer = original_add_layer;
		}
	});

	/** Every corner of the picture on the layer point of its corner: the written matrix,
	 * and the box the browser actually draws (a wrong transform-origin shifts it, a hidden
	 * picture collapses it), which by construction is the container's. */
	const assert_on_corners = function (overlay, corners, when) {
		const map = geolocation.map;
		const container = overlay.getElement();
		const picture = container.querySelector('img');
		const origin = L.DomUtil.getPosition(container);
		const matrix = new DOMMatrix(picture.style.transform);
		const [tl, tr, bl] = [corners.top_left, corners.top_right, corners.bottom_left].map((el) =>
			map.latLngToLayerPoint(L.latLng(el)),
		);
		const w = picture.naturalWidth;
		const h = picture.naturalHeight;
		const expected = [
			[0, 0, tl, 'top-left'],
			[w, 0, tr, 'top-right'],
			[0, h, bl, 'bottom-left'],
			[w, h, L.point(tr.x + bl.x - tl.x, tr.y + bl.y - tl.y), 'bottom-right (inferred)'],
		];
		for (const [x, y, target, name] of expected) {
			const landed = matrix.transformPoint(new DOMPoint(x, y));
			assert.closeTo(
				origin.x + landed.x,
				target.x,
				0.01,
				`expected the picture's ${name} on its corner ${when} (x)`,
			);
			assert.closeTo(
				origin.y + landed.y,
				target.y,
				0.01,
				`expected the picture's ${name} on its corner ${when} (y)`,
			);
		}
		const drawn = picture.getBoundingClientRect();
		const box = container.getBoundingClientRect();
		assert.isAbove(drawn.width * drawn.height, 0, `expected the picture drawn ${when}`);
		for (const side of ['left', 'top', 'right', 'bottom']) {
			assert.closeTo(
				drawn[side],
				box[side],
				0.5,
				`expected the drawn picture to fill its box ${when} (${side})`,
			);
		}
	};

	it('a rotated, skewed picture lands on its three corners, and stays on them through zooms and a move', async function () {
		const map = geolocation.map;
		const zoom = map.getZoom();
		const center = map.getCenter();
		// a real picture: the matrix needs a natural size, and the fixture's media path is not on disk
		const canvas = document.createElement('canvas');
		canvas.width = 40;
		canvas.height = 20;
		const corners = {
			top_left: [center.lat + 0.004, center.lng - 0.006],
			top_right: [center.lat + 0.006, center.lng + 0.005],
			bottom_left: [center.lat - 0.003, center.lng - 0.008],
		};
		const overlay = rotated_image_overlay(
			canvas.toDataURL('image/png'),
			corners.top_left,
			corners.top_right,
			corners.bottom_left,
			{ opacity: 0.5, zIndex: 300, className: 'uca-maps-image-overlay' },
		);
		const loaded = new Promise((resolve, reject) => {
			overlay.once('load', resolve);
			overlay.once('error', () => reject(new Error('the test picture did not load')));
		});
		overlay.addTo(map);
		try {
			await loaded;

			const container = overlay.getElement();
			assert.isTrue(
				container.classList.contains('uca-maps-image-overlay'),
				'expected the className on the overlay',
			);
			assert.equal(container.style.opacity, '0.5', 'expected the opacity on the overlay');
			assert.equal(container.style.zIndex, '300', 'expected the zIndex on the overlay');
			assert_on_corners(overlay, corners, 'as placed');

			map.setZoom(zoom + 1, { animate: false });
			assert_on_corners(overlay, corners, 'after a zoom');

			// animated, as a wheel or +/- zooms: the inherited zoom animation reads the
			// overlay's bounds, and a throw there leaves the map stuck mid-zoom
			const zoomed = new Promise((resolve) => map.once('zoomend', resolve));
			map.setZoom(zoom);
			await Promise.race([
				zoomed,
				tick(3000).then(() => {
					throw new Error('the animated zoom never ended');
				}),
			]);
			assert.equal(map.getZoom(), zoom, 'expected the animated zoom to land');
			assert_on_corners(overlay, corners, 'after an animated zoom');

			const moved = {
				top_left: [corners.top_left[0] + 0.001, corners.top_left[1]],
				top_right: [corners.top_right[0] - 0.002, corners.top_right[1] + 0.003],
				bottom_left: corners.bottom_left,
			};
			overlay.reposition(moved.top_left, moved.top_right, moved.bottom_left);
			assert_on_corners(overlay, moved, 'after a move');
		} finally {
			overlay.remove();
			map.setZoom(zoom, { animate: false });
		}
	});

	it('hiding an uploaded image hides the picture, not just its carrier', async function () {
		const carrier = await add_image_carrier_with_overlay();

		apply_display(carrier, false);

		assert.equal(
			carrier._uca_maps_overlay._image.style.display,
			'none',
			'expected the overlay hidden too — hiding only the transparent carrier would leave the picture painted and unselectable',
		);

		apply_display(carrier, true);
		assert.notEqual(
			carrier._uca_maps_overlay._image.style.display,
			'none',
			'expected it shown again',
		);
	});

	it("an image carrier's console shows v6's sections: image controls, downloads, properties, never the geometry ones", async function () {
		const carrier = add_image_carrier();
		tool.attach_console();
		tool.attach_image_overlays();
		await await_overlay(carrier);

		// the carrier is built by hand here, so it carries no popup — fire the
		// selection event the console actually listens to (object_console.js
		// hydrate's 'popupopen' handler reads popup._source and nothing else)
		select_carrier(carrier);

		const section = tool.console_panel.querySelector('.uca-maps-object-section');
		assert.isOk(section.querySelector('.uca-maps-image-view'), 'expected the "View image" link');
		assert.isOk(section.querySelector('.uca-maps-image-opacity'), 'expected the opacity control');
		assert.isOk(section.querySelector('.uca-maps-image-z-index'), 'expected the z-index control');

		// what v6 adds after them (special_tools.js:6526-6568 + info_console_load_properties)
		const order = [
			'.uca-maps-image-view',
			'.uca-maps-download-section',
			'.uca-maps-object-images',
			'.uca-maps-properties-editor',
		].map((selector) => {
			const node = section.querySelector(selector);
			assert.isOk(node, 'expected ' + selector + ' for an image carrier');
			return Array.from(section.children).indexOf(node);
		});
		assert.deepEqual(
			order,
			[...order].sort((a, b) => a - b),
			'expected image controls, download, images, properties — in that order',
		);
		assert.isOk(
			section.querySelector('.uca-maps-property-pdf-button'),
			'expected the PDF export, which rides in the properties block',
		);

		// and what v6 never shows for a picture
		for (const selector of [
			'.uca-maps-object-type',
			'.uca-maps-object-info',
			'.uca-maps-elevation-section',
			'.uca-maps-geoman',
			'.uca-maps-centroid',
			'.uca-maps-uncertainty',
			'.uca-maps-style-controls',
			'.uca-maps-hierarchy-controls',
		]) {
			assert.isNotOk(
				section.querySelector(selector),
				'expected NO ' + selector + ' for an image carrier',
			);
		}
	});

	it('"Download image" is v6\'s form: GeoTIFF/png/jpg, seven qualities at 0.8, a name — right after the image controls', function () {
		const carrier = add_image_carrier();
		tool.attach_console();
		select_carrier(carrier);

		const section = tool.console_panel.querySelector('.uca-maps-object-section');
		const download = section.querySelector('.uca-maps-image-download-section');
		assert.isOk(download, 'expected the image download section');

		const format = download.querySelector('.uca-maps-image-download-format');
		assert.deepEqual(
			Array.from(format.options).map((o) => o.value),
			['geotiff', 'png', 'jpg'],
		);
		assert.equal(format.value, 'geotiff', "expected v6's first format selected");

		const quality = download.querySelector('.uca-maps-image-download-quality');
		assert.deepEqual(
			Array.from(quality.options).map((o) => o.value),
			['0.4', '0.6', '0.8', '0.9', '1', '1.5', '2'],
		);
		assert.equal(quality.value, '0.8', 'expected v6\'s "medium" selected');

		assert.equal(download.querySelector('.uca-maps-image-download-name').value, 'image');

		const children = Array.from(section.children);
		assert.isBelow(
			children.indexOf(download),
			children.indexOf(section.querySelector('.uca-maps-download-section')),
			'expected the image download before the vector one, as v6',
		);
	});

	it('"Download image" sends the CURRENT corners and v6\'s quality as a width — never the opacity', async function () {
		const carrier = add_image_carrier();
		const image = carrier.feature.properties.uca_maps.image;
		image.opacity = 0.3;
		tool.attach_console();
		select_carrier(carrier);

		// a handle drag that nobody saved yet: the download must follow it
		image.corners.top_right = [40.47, -3.63];

		let sent = null;
		let transport = null;
		const restore = stub_image_download(async function (request, transport_options) {
			sent = request;
			transport = transport_options;
			return { ok: false, error: { code: 'request.invalid_options' } };
		});

		try {
			const download = tool.console_panel.querySelector('.uca-maps-image-download-section');
			download.querySelector('.uca-maps-image-download-quality').value = '2';
			download.querySelector('.uca-maps-image-download-format').value = 'jpg';
			download.querySelector('.uca-maps-image-download-button').click();
			await until(() => sent, 100);

			assert.equal(sent.action, 'image_download');
			assert.equal(sent.options.section_tipo, IMAGE_DESCRIPTOR.section_tipo);
			assert.equal(sent.options.section_id, IMAGE_DESCRIPTOR.section_id);
			assert.equal(sent.options.tipo, IMAGE_DESCRIPTOR.tipo);
			assert.equal(
				sent.options.file_path,
				IMAGE_DESCRIPTOR.file_path,
				'expected the file the map shows named, for the server to match',
			);
			assert.deepEqual(
				sent.options.corners.top_right,
				[40.47, -3.63],
				'expected the live corners, not the uploaded ones',
			);
			assert.equal(sent.options.format, 'jpg');
			assert.equal(sent.options.width, image_download_width(geolocation.map, image.corners, 2));
			assert.equal(sent.options.file_name, 'image');
			assert.notProperty(
				sent.options,
				'opacity',
				'expected opacity left out: it is how the map shows the picture',
			);
			assert.equal(
				transport.timeout,
				IMAGE_DOWNLOAD_TIMEOUT_MS,
				'expected its own timeout, past the default 5 s per attempt',
			);
			assert.isTrue(
				transport.busy_notice,
				'expected the slow-server cue kept, which a long timeout turns off by default',
			);
		} finally {
			restore();
		}

		// the rest of the request is exactly what tool_request would send
		assert.deepEqual(
			Object.keys(transport).sort(),
			['body', 'busy_notice', 'retries', 'timeout'],
			'expected nothing but the body and the three transport options',
		);
		assert.equal(
			transport.retries,
			1,
			'expected a readOnly action sent once: it is never ledgered',
		);
		assert.deepEqual(
			transport.body,
			await tool_request_body('image_download', transport.body.options),
			'expected the body tool_request builds: dd_api, prevent_lock and the source included',
		);
	});

	it('"Download image" saves what the server sends, under its name and type', async function () {
		const carrier = add_image_carrier();
		const restore = stub_image_download(async function () {
			return {
				ok: true,
				data: { content_base64: btoa('x'), mime: 'image/png', filename: 'plan.png' },
			};
		});
		try {
			const captured = await capture_download(() =>
				tool.download_image(carrier, 'png', 0.8, 'plan'),
			);
			assert.equal(captured.name, 'plan.png', "expected the server's file name on the anchor");
			assert.equal(
				captured.blob && captured.blob.type,
				'image/png',
				"expected the server's mime on the blob",
			);
		} finally {
			restore();
		}
	});

	it('"Download image" refused: its line stays empty', async function () {
		const carrier = add_image_carrier();
		tool.attach_console();
		select_carrier(carrier);

		let answered = false;
		const restore = stub_image_download(async function () {
			answered = true;
			return {
				ok: false,
				error: {
					is_api_error: true,
					code: 'resource.not_found',
					details: { reason_key: 'image_not_on_server' },
					message: 'The image is no longer on the server.',
					transport: false,
				},
			};
		});
		try {
			const download = tool.console_panel.querySelector('.uca-maps-image-download-section');
			const line = download.querySelector('.uca-maps-download-message');
			const button = download.querySelector('.uca-maps-image-download-button');
			assert.isTrue(line.hidden, 'expected no line before any attempt');

			button.click();
			await until(() => answered && !button.disabled, 100);

			assert.isTrue(answered, 'expected the download asked');
			assert.isTrue(line.hidden, "expected no line beside core's notice");
		} finally {
			restore();
		}
	});

	it("image_download_width is v6's quality over the fitted on-screen size, and never moves the map", function () {
		const map = geolocation.map;
		const corners = image_descriptor().corners;
		const center = map.getCenter();
		const zoom = map.getZoom();

		const one = image_download_width(map, corners, 1);
		assert.isAbove(one, 1);
		assert.closeTo(
			image_download_width(map, corners, 2),
			one * 2,
			1,
			'expected twice the pixels at "Excelente"',
		);
		assert.closeTo(image_download_width(map, corners, 0.4), one * 0.4, 1);

		assert.deepEqual(
			[map.getCenter(), map.getZoom()],
			[center, zoom],
			'expected the map not moved by measuring',
		);

		// fitted, not "as seen now": zooming the map changes nothing
		map.setZoom(zoom - 2, { animate: false });
		const zoomed = [map.getCenter(), map.getZoom()];
		assert.equal(
			image_download_width(map, corners, 1),
			one,
			'expected the same width at any current zoom',
		);
		assert.deepEqual(
			[map.getCenter(), map.getZoom()],
			zoomed,
			'expected the zoomed map not moved by measuring',
		);
		map.setView(center, zoom, { animate: false });
	});

	it('"Download image" with an empty name is refused without asking the server', async function () {
		const carrier = add_image_carrier();
		let asked = false;
		const restore = stub_image_download(async function () {
			asked = true;
			return { ok: false };
		});
		try {
			let result = null;
			const toasts = await toasts_during(async () => {
				result = await tool.download_image(carrier, 'png', 0.8, '   ');
			});
			assert.equal(asked, false, 'expected no request for an empty name');
			assert.deepEqual(
				result,
				{ ok: false, error: 'Please enter a name for the file' },
				"expected the reason for the section's line",
			);
			assert.equal(toasts.length, 0, 'expected the line alone to say it, no page toast');
		} finally {
			restore();
		}
	});

	it('"View image" is left out, not pointed at the bare file, when the descriptor names no record', function () {
		tool.attach_console();

		for (const missing of ['section_id', 'section_tipo']) {
			const carrier = add_image_carrier();
			delete carrier.feature.properties.uca_maps.image[missing];
			select_carrier(carrier);

			assert.equal(tool.get_image_href(carrier), null, 'expected no target without ' + missing);
			assert.isNotOk(
				tool.console_panel.querySelector('.uca-maps-image-view'),
				'expected no link without ' + missing,
			);
			assert.isOk(
				tool.console_panel.querySelector('.uca-maps-image-z-index'),
				'expected the rest of the image controls still there',
			);
		}

		const zero = add_image_carrier();
		zero.feature.properties.uca_maps.image.section_id = 0;
		assert.equal(tool.get_image_href(zero), null, 'expected no target for section_id 0');
	});

	it('"View image" opens the Images record the upload created, as v6, not the bare file', async function () {
		const carrier = add_image_carrier();
		tool.attach_console();
		select_carrier(carrier);

		const link = tool.console_panel.querySelector('.uca-maps-image-view');
		const url = new URL(link.href, window.location.href);
		assert.equal(
			url.pathname,
			new URL(DEDALO_CORE_URL + '/page/', window.location.href).pathname,
			'expected the core page, not the media tree',
		);
		assert.equal(url.searchParams.get('tipo'), IMAGE_DESCRIPTOR.section_tipo);
		assert.equal(url.searchParams.get('id'), String(IMAGE_DESCRIPTOR.section_id));
		assert.equal(url.searchParams.get('mode'), 'edit');
		assert.equal(url.searchParams.get('menu'), 'true', "expected v6's menu=true");
		assert.equal(
			url.searchParams.get('session_save'),
			'false',
			"expected this window's navigation left alone",
		);
		assert.equal(link.target, '_blank');
	});

	it("the z-index is v6's 0..1000 slider: showing the stored value, previewing on input, committing on release", async function () {
		const carrier = add_image_carrier();
		carrier.feature.properties.uca_maps.image.z_index = 640;
		tool.attach_console();
		tool.attach_image_overlays();
		await await_overlay(carrier);
		select_carrier(carrier);

		const slider = tool.console_panel.querySelector('.uca-maps-image-z-index');
		assert.equal(slider.type, 'range', 'expected a slider, as v6, not a number box');
		assert.equal(slider.min, '0');
		assert.equal(slider.max, '1000');
		// above 100 on purpose: with `value` set before `max` it would read 100
		assert.equal(slider.value, '640', 'expected the stored z-index, not a clamped one');

		let commits = 0;
		const original = geolocation.update_draw_data;
		geolocation.update_draw_data = function () {
			commits++;
			return original.apply(this, arguments);
		};

		slider.value = '850';
		slider.dispatchEvent(new Event('input'));
		assert.equal(
			carrier.feature.properties.uca_maps.image.z_index,
			850,
			'expected the preview written while dragging',
		);
		assert.equal(
			carrier._uca_maps_overlay.options.zIndex,
			850,
			'expected the live overlay restacked while dragging',
		);
		assert.equal(commits, 0, 'expected NO commit mid-drag');

		slider.dispatchEvent(new Event('change'));
		assert.equal(commits, 1, 'expected exactly one commit on release');
	});

	it('a z-index outside 0..1000 is bounded where it is used, so the slider and the overlay agree', async function () {
		// the old number box could store anything; nothing validated it
		const carrier = add_image_carrier();
		carrier.feature.properties.uca_maps.image.z_index = 1500;
		tool.attach_console();
		tool.attach_image_overlays();
		await await_overlay(carrier);
		select_carrier(carrier);

		const slider = tool.console_panel.querySelector('.uca-maps-image-z-index');
		assert.equal(slider.value, '1000', 'expected the slider at its top');
		assert.equal(
			carrier._uca_maps_overlay.options.zIndex,
			1000,
			'expected the overlay stacked where the slider says',
		);
		assert.equal(
			carrier.feature.properties.uca_maps.image.z_index,
			1500,
			'expected NO silent rewrite just for showing it',
		);

		tool.set_image_display(carrier, { z_index: -5 }, false);
		assert.equal(
			carrier.feature.properties.uca_maps.image.z_index,
			0,
			'expected a write bounded too',
		);
	});

	it('set_image_display writes the live overlay AND the descriptor that gets saved', async function () {
		const carrier = await add_image_carrier_with_overlay();

		tool.set_image_display(carrier, { opacity: 0.4, z_index: 300 }, false);

		assert.equal(
			carrier.feature.properties.uca_maps.image.opacity,
			0.4,
			'expected the stored opacity updated',
		);
		assert.equal(
			carrier.feature.properties.uca_maps.image.z_index,
			300,
			'expected the stored z-index updated',
		);
		assert.equal(
			carrier._uca_maps_overlay.options.opacity,
			0.4,
			'expected the live overlay updated too',
		);

		// out-of-range input is clamped, never stored raw
		tool.set_image_display(carrier, { opacity: 5 }, false);
		assert.equal(
			carrier.feature.properties.uca_maps.image.opacity,
			1,
			'expected opacity clamped to 1',
		);
	});

	it('a wholesale FeatureGroup reload does not stack a second copy of every image', async function () {
		// layers_loader() rebuilds a FeatureGroup from scratch on a layer
		// switch/reload and fires NO 'pm:remove' — the carriers are simply
		// replaced by new objects. An overlay is not a drawn object, so
		// nothing in the engine would take the old ones off the map.
		const stale = await add_image_carrier_with_overlay();
		const stale_overlay = stale._uca_maps_overlay;
		assert.equal(
			geolocation.map.hasLayer(stale_overlay),
			true,
			'expected the first overlay on the map',
		);

		// the reload: the old carrier is gone from the group, a new one takes
		// its place, and only the layer-data event announces it
		active_group().removeLayer(stale);
		const fresh = add_image_carrier();
		event_manager.publish('updated_layer_data_' + geolocation.id_base, {});

		await await_overlay(fresh);

		assert.isOk(fresh._uca_maps_overlay, 'expected the new carrier to get its overlay');
		assert.equal(
			geolocation.map.hasLayer(stale_overlay),
			false,
			'expected the stale overlay swept off the map',
		);
		assert.equal(
			tool._image_overlays.length,
			1,
			'expected exactly one tracked overlay, not two stacked',
		);
	});

	// IMAGE EDIT MODE (image_edit.js) — the overlay's three control points as
	// draggable handles, on the same hand-built carriers.

	it('the console offers "Activar edición" and it reflects the stored state', async function () {
		const carrier = await add_image_carrier_with_overlay();
		tool.attach_console();
		select_carrier(carrier);

		const checkbox = tool.console_panel.querySelector(
			'.uca-maps-object-section .uca-maps-image-edit',
		);
		assert.isOk(checkbox, 'expected the "Activar edición" checkbox in the image branch');
		assert.equal(
			checkbox.checked,
			false,
			'expected edit mode off for a descriptor that never stored it',
		);

		tool.set_image_interactive(carrier, true);
		select_carrier(carrier);

		assert.equal(
			tool.console_panel.querySelector('.uca-maps-object-section .uca-maps-image-edit').checked,
			true,
			'expected the re-rendered checkbox to read the stored flag, not a cached one',
		);
	});

	it('set_image_interactive puts three draggable handles on the map and persists the flag', async function () {
		const carrier = await add_image_carrier_with_overlay();

		tool.set_image_interactive(carrier, true);

		assert.equal(
			carrier._uca_maps_handles.length,
			3,
			'expected one handle per stored control point',
		);
		for (const handle of carrier._uca_maps_handles) {
			assert.equal(
				geolocation.map.hasLayer(handle),
				true,
				'expected the handle actually on the map',
			);
			assert.equal(handle.options.draggable, true, 'expected the handle draggable');
			// a handle is a control, not a drawn object: Geoman must not edit,
			// snap to, or — worst — collect it into the component's data
			assert.equal(handle.options.pmIgnore, true, 'expected Geoman to ignore the handle');
		}
		assert.equal(
			carrier.feature.properties.uca_maps.image.interactive,
			true,
			'expected the flag stored on the descriptor, which is what survives a save',
		);
	});

	it('dragging a handle moves the overlay, the stored corners and the carrier together', async function () {
		const carrier = await add_image_carrier_with_overlay();
		tool.set_image_interactive(carrier, true);

		const before = JSON.parse(JSON.stringify(carrier.feature.properties.uca_maps.image.corners));
		const handle = carrier._uca_maps_handles[1]; // top_right
		handle.setLatLng(L.latLng(40.47, -3.6));
		handle.fire('drag');

		const after = carrier.feature.properties.uca_maps.image.corners;
		assert.deepEqual(after.top_right, [40.47, -3.6], 'expected the dragged corner stored');
		assert.deepEqual(after.top_left, before.top_left, 'expected the other two corners untouched');
		assert.deepEqual(
			after.bottom_left,
			before.bottom_left,
			'expected the other two corners untouched',
		);

		// the overlay is what the user sees
		const placed = carrier._uca_maps_overlay.get_corners();
		assert.closeTo(
			placed.top_right.lat,
			40.47,
			1e-9,
			'expected the image itself moved with the handle',
		);
		assert.closeTo(
			placed.top_right.lng,
			-3.6,
			1e-9,
			'expected the image itself moved with the handle',
		);
		assert.deepEqual(
			[placed.top_left.lat, placed.top_left.lng],
			before.top_left,
			"expected the image's other corners untouched",
		);
		assert.deepEqual(
			[placed.bottom_left.lat, placed.bottom_left.lng],
			before.bottom_left,
			"expected the image's other corners untouched",
		);

		// the carrier is what can be clicked and deleted — an overlay that
		// moved away from it would be unselectable
		const bounds = carrier.getBounds();
		assert.closeTo(
			bounds.getNorth(),
			40.47,
			1e-9,
			'expected the carrier outline to follow the handle',
		);
		assert.closeTo(
			bounds.getEast(),
			-3.6,
			1e-9,
			'expected the carrier outline to follow the handle',
		);
	});

	it('a drag marks the record dirty only when the gesture ends', async function () {
		const carrier = await add_image_carrier_with_overlay();
		tool.set_image_interactive(carrier, true);

		let commits = 0;
		const original = geolocation.update_draw_data;
		geolocation.update_draw_data = function () {
			commits++;
			return original.apply(this, arguments);
		};

		const handle = carrier._uca_maps_handles[0];
		handle.setLatLng(L.latLng(40.465, -3.665));
		handle.fire('drag');
		assert.equal(
			commits,
			0,
			'expected NO commit mid-drag — commit() re-renders the panel being dragged against',
		);

		handle.fire('dragend');
		assert.equal(commits, 1, 'expected exactly one commit when the gesture ends');
	});

	it('switching edit mode off removes the handles', async function () {
		const carrier = await add_image_carrier_with_overlay();
		tool.set_image_interactive(carrier, true);
		const handles = carrier._uca_maps_handles.slice();

		tool.set_image_interactive(carrier, false);

		assert.isNotOk(carrier._uca_maps_handles, 'expected the handles untracked');
		for (const handle of handles) {
			assert.equal(geolocation.map.hasLayer(handle), false, 'expected the handle off the map');
		}
		assert.equal(
			carrier.feature.properties.uca_maps.image.interactive,
			false,
			'expected the flag stored off',
		);
	});

	it('an overlay rebuilt from saved data comes back with the handles the user left showing', async function () {
		const carrier = add_image_carrier();
		// exactly what a record saved with edit mode on hands back on load
		carrier.feature.properties.uca_maps.image.interactive = true;

		tool.attach_image_overlays();
		await until(() => carrier._uca_maps_handles);

		assert.isOk(
			carrier._uca_maps_handles,
			'expected the stored edit mode restored, not silently dropped',
		);
		assert.equal(carrier._uca_maps_handles.length, 3);
	});

	it('hiding the object hides its handles, in both directions', async function () {
		const carrier = await add_image_carrier_with_overlay();
		tool.set_image_interactive(carrier, true);

		// hiding an object with edit mode ON must not leave three circles
		// floating over an invisible image — still draggable, still moving it
		apply_display(carrier, false);
		for (const handle of carrier._uca_maps_handles) {
			assert.equal(
				handle._icon.style.display,
				'none',
				'expected the handle hidden with its object',
			);
		}

		apply_display(carrier, true);
		assert.notEqual(
			carrier._uca_maps_handles[0]._icon.style.display,
			'none',
			'expected it shown again',
		);

		// and the other direction: turning edit mode ON for an already hidden
		// object must not paint the handles either
		tool.set_image_interactive(carrier, false);
		apply_display(carrier, false);
		tool.set_image_interactive(carrier, true);

		for (const handle of carrier._uca_maps_handles) {
			assert.equal(
				handle._icon.style.display,
				'none',
				'expected handles born hidden on a hidden object',
			);
		}
	});

	it('teardown removes every overlay and handle the tool put on the map', async function () {
		const carrier = await add_image_carrier_with_overlay();
		tool.set_image_interactive(carrier, true);
		const overlay = carrier._uca_maps_overlay;
		const handles = carrier._uca_maps_handles.slice();

		await tool.destroy(false, false, false);

		assert.equal(
			geolocation.map.hasLayer(overlay),
			false,
			'expected the overlay removed on teardown',
		);
		for (const handle of handles) {
			assert.equal(
				geolocation.map.hasLayer(handle),
				false,
				'expected the handle removed on teardown — nothing else in the engine tracks it',
			);
		}
	});

	it('deleting the carrier takes its overlay and its handles off the map with it', async function () {
		const carrier = await add_image_carrier_with_overlay();
		tool.set_image_interactive(carrier, true);
		const overlay = carrier._uca_maps_overlay;
		const handles = carrier._uca_maps_handles.slice();

		geolocation.map.fire('pm:remove', { layer: carrier });

		assert.equal(
			geolocation.map.hasLayer(overlay),
			false,
			'expected the orphaned image removed from the map',
		);
		assert.equal(tool._image_overlays.length, 0, 'expected the overlay untracked');
		for (const handle of handles) {
			assert.equal(
				geolocation.map.hasLayer(handle),
				false,
				'expected the handle removed with its object',
			);
		}
	});

	it('detach_file_upload removes the button and panel', async function () {
		tool.attach_file_upload();
		const map_container_node = geolocation.map.getContainer();

		await tool.destroy(false, false, false);

		assert.equal(tool.upload_control, null, 'expected upload_control cleared');
		assert.equal(tool.upload_panel, null, 'expected upload_panel cleared');
		assert.isNotOk(
			map_container_node.querySelector('.uca-maps-upload-control'),
			'expected the button removed from the DOM',
		);
		assert.isNotOk(
			map_container_node.querySelector('.uca-maps-upload-panel'),
			'expected the panel removed from the DOM',
		);
	});

	it('capturing the map requests no URL held by a CSS custom property', async function () {
		tool.attach_map_image_download_control();

		// core tokens such as --search_icon_url hold relative url()s the browser
		// never resolves. dom-to-image-more serialises a pseudo-element with
		// every property it inherits, those tokens included, and fetched them
		// against the page's own path (404s and console noise)
		const pane = geolocation.map.getContainer().querySelector('.leaflet-map-pane');
		const style = getComputedStyle(pane);
		const token_paths = [...style]
			.filter((name) => name.startsWith('--'))
			.flatMap((name) =>
				[...style.getPropertyValue(name).matchAll(/url\(\s*[\x27\x22]?([^\x27\x22)]+)/g)].map(
					(match) => match[1],
				),
			)
			.filter((path) => !path.startsWith('data:'));
		assert.isAbove(
			token_paths.length,
			0,
			'expected the map to inherit custom properties holding a url()',
		);

		// the library may resolve a path before asking: match on what follows the ../
		const is_token = (url) =>
			token_paths.some((path) => url.includes(path.replace(/^(\.\.?\/)+/, '')));
		const pseudo_rule = document.createElement('style');
		pseudo_rule.textContent = '.leaflet-map-pane::before { content: ""; }';
		document.head.appendChild(pseudo_rule);
		let requested, unguarded;
		try {
			assert.notEqual(
				getComputedStyle(pane, '::before').getPropertyValue('content'),
				'none',
				'expected a pseudo-element in the map',
			);
			requested = await capture_png_requests();
			unguarded = await capture_unguarded_requests();
		} finally {
			pseudo_rule.remove();
		}

		assert.deepEqual(
			requested.filter(is_token),
			[],
			'expected no request for a url() a custom property holds',
		);
		assert.isAbove(
			unguarded.filter(is_token).length,
			0,
			'expected an unguarded capture to ask for them',
		);
	});
});

// @license-end
