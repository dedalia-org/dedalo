// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global beforeEach, afterEach, assert, L, HTMLAnchorElement */
/*eslint no-undef: "error"*/
'use strict';

/**
 * TOOL_UCA_MAPS FIXTURE
 * Shared by the test_tool_uca_maps* suites, one per feature group. use_live_map mounts a real
 * component_geolocation (TLD `test`) wired to a tool by hand, init() and tool_common's ceremony
 * skipped: production init only resolves `geolocation` and `map_ready` and the tool reads no
 * ontology. Lookups are stubbed; basemap and WMS tiles load from the network but are never
 * asserted on.
 */

import { data_manager } from '../../../core/common/js/data_manager.js';
import { event_manager } from '../../../core/common/js/event_manager.js';
import { get_instance } from '../../../core/common/js/instances.js';
import { ui } from '../../../core/common/js/ui.js';
import { populate_roman_results } from '../../../tools/tool_uca_maps/js/render_roman_empire.js';
import { tool_uca_maps } from '../../../tools/tool_uca_maps/js/tool_uca_maps.js';
import { elements, uca_maps_section_id } from './elements.js';

/** The colour a cataloguer picks in the style field: the tool's own hue
 * (`--tool_uca_maps` is Dédalo's orange, main.css), which no default shares. Read
 * from the token, not spelled: a colour spelled in a shipped file is counted
 * (colour_literal_ratchet_tripwire). Lowercase hex, what `<input type=color>` yields. */
export const picked_colour = function () {
	const value = getComputedStyle(document.documentElement)
		.getPropertyValue('--color_orange_dedalo')
		.trim()
		.toLowerCase();
	assert.match(value, /^#[0-9a-f]{6}$/, 'expected the orange token as a hex colour');
	return value;
};

export const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

export const two_frames = () =>
	new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

/** Polls until `done()` holds or the tries run out; the caller asserts what it waited for. */
export const until = async function (done, tries = 200, ms = 10) {
	for (let i = 0; i < tries && !done(); i++) {
		await tick(ms);
	}
};

/**
 * Runs `fn` with the tool's own stylesheet loaded, and removes it after:
 * the suite runs without it, so only a layout or paint test pays for it.
 */
export const with_tool_css = async function (fn) {
	const link = document.createElement('link');
	link.rel = 'stylesheet';
	link.href = new URL('../../../tools/tool_uca_maps/css/tool_uca_maps.css', import.meta.url).href;
	await new Promise((resolve, reject) => {
		link.addEventListener('load', resolve);
		link.addEventListener('error', reject);
		document.head.appendChild(link);
	});
	try {
		return await fn();
	} finally {
		link.remove();
	}
};

/** The tool's own stylesheet, as with_tool_css loaded it. */
export const tool_sheet = () =>
	[...document.styleSheets].find((s) => s.href && s.href.includes('/tool_uca_maps.css'));

/**
 * What `token` resolves to inside `parent`: a probe painted with it is appended,
 * its computed `property` read, and the probe removed (a leftover would join the
 * text walks and the layout of the panel it sits in).
 * @returns {string}
 */
export const resolve_token = function (parent, token, property = 'background-color') {
	const probe = document.createElement('div');
	probe.style.setProperty(property, 'var(' + token + ')');
	parent.appendChild(probe);
	const value = getComputedStyle(probe).getPropertyValue(property);
	probe.remove();
	return value;
}; //end resolve_token

/**
 * A stubbed `raster_download` never reaches the handler that deletes the map capture the
 * real upload staged: the stub releases it through core's own delete door instead.
 * A no-op for any other request.
 */
export const release_map_capture = async function (request) {
	const file_data = request && request.options && request.options.file_data;
	if (!file_data || request.action !== 'raster_download') return;
	await data_manager.request({
		body: {
			dd_api: 'dd_utils_api',
			action: 'delete_uploaded_file',
			options: { key_dir: file_data.key_dir, file_name: file_data.tmp_name },
		},
	});
}; //end release_map_capture

/**
 * Runs `fn` with URL.createObjectURL and the anchor's click spied: the Blob a
 * download builds, and the name trigger_blob_download puts on the anchor (the
 * only place a typed name shows on the client-only branches). Stubbing the
 * click also keeps the headless browser from downloading anything.
 * @returns {Promise<{blob: Blob|null, name: string|null}>}
 */
export const capture_download = async function (fn) {
	const original_create_object_url = URL.createObjectURL;
	const original_click = HTMLAnchorElement.prototype.click;
	const captured = { blob: null, name: null };
	URL.createObjectURL = (blob) => {
		captured.blob = blob;
		return 'blob:uca-maps-test-mock';
	};
	HTMLAnchorElement.prototype.click = function () {
		captured.name = this.download;
	};
	try {
		await fn();
	} finally {
		URL.createObjectURL = original_create_object_url;
		HTMLAnchorElement.prototype.click = original_click;
	}
	return captured;
}; //end capture_download

/**
 * Runs `fn(toasts)` with every page toast (`api_error`) collected into `toasts`,
 * and returns them: a test asserts mid-flight inside `fn`, or after it.
 * @returns {Promise<object[]>}
 */
export const toasts_during = async function (fn) {
	const toasts = [];
	const token = event_manager.subscribe('api_error', (error) => toasts.push(error));
	try {
		await fn(toasts);
	} finally {
		event_manager.unsubscribe(token);
	}
	return toasts;
}; //end toasts_during

/**
 * "Download image" asks through data_manager.request with its own timeout:
 * `answer` sees the {action, options} a tool_request stub would, plus the
 * transport options. Returns the restore (data_manager outlives the test).
 */
export const stub_image_download = function (answer) {
	const original = data_manager.request;
	data_manager.request = async function (options) {
		const body = options && options.body;
		if (
			body &&
			body.action === 'tool_request' &&
			body.source &&
			body.source.action === 'image_download'
		) {
			return answer({ action: body.source.action, options: body.options }, options);
		}
		return original.apply(this, arguments);
	};
	return () => {
		data_manager.request = original;
	};
};

/** The layer of `feature_group` whose properties.uca_maps.uid is `uid`. */
export const layer_by_uid = function (feature_group, uid) {
	return feature_group
		.getLayers()
		.find(
			(candidate) =>
				candidate.feature &&
				candidate.feature.properties &&
				candidate.feature.properties.uca_maps &&
				candidate.feature.properties.uca_maps.uid === uid,
		);
};

// hand the picker a real FileList, then fire what the browser fires
export const pick_file = function (input, file) {
	load_file(input, file);
	input.dispatchEvent(new Event('change'));
};

// load the picker without firing anything: the vector half uploads on click
export const load_file = function (input, file) {
	const transfer = new DataTransfer();
	transfer.items.add(file);
	input.files = transfer.files;
};

/** A real 1x1 PNG: the staging endpoint checks the file signature, and a picked icon is decoded and redrawn. */
export const one_pixel_png = (name = 'plan.png') =>
	new File(
		[
			Uint8Array.from(
				atob(
					'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
				),
				(c) => c.charCodeAt(0),
			),
		],
		name,
		{ type: 'image/png' },
	);

/**
 * A saved image overlay, as a record hands it back on load. No test uploads a
 * real image: that would mint a record and media on every run with no id
 * handed back to sweep them.
 */
export const IMAGE_DESCRIPTOR = {
	file_path: '/image/1.5MB/test99_test3_1.jpg',
	quality: '1.5MB',
	section_tipo: 'test3',
	section_id: 1,
	tipo: 'test99',
	corners: {
		top_left: [40.46, -3.66],
		top_right: [40.46, -3.64],
		bottom_left: [40.44, -3.66],
	},
	opacity: 1,
	z_index: 200,
};
export const image_descriptor = () => JSON.parse(JSON.stringify(IMAGE_DESCRIPTOR));

/** What the server answers once it has staged a linked image under `name`. */
export const staged_answer = (name) => ({
	ok: true,
	data: {
		file_data: {
			key_dir: 'image',
			tmp_name: name,
			name: name,
			extension: 'jpg',
			complete: true,
		},
	},
});

/** A one-point GeoJSON feature, the shape Pelagios/DARE hits carry. */
export const roman_feature = function (name, lat, lon) {
	return {
		type: 'Feature',
		properties: { name: name },
		geometry: { type: 'Point', coordinates: [lon, lat] },
	};
};
export const roman_hit = (name, lat, lon) => ({
	name: name,
	geometry_type: 'Point',
	feature: roman_feature(name, lat, lon),
});

/** An install that serves Pleiades and no Pelagios layer. */
export const WITH_PLEIADES = { configured: true, pleiades: true, pelagios: [] };

/**
 * USE_LIVE_MAP
 * Registers the live map's beforeEach/afterEach in the CALLER's describe (mocha binds a hook to
 * the describe that registers it) and returns the helpers the suites share. `bind` receives
 * {geolocation, tool, map_container} after every mount, so the suites keep their own names.
 * @param {Function} bind
 * @return {Object}
 */
export const use_live_map = function (bind) {
	const element = elements.find((el) => el.model === 'component_geolocation');
	if (!element) {
		throw new Error('elements.js holds no component_geolocation');
	}
	const section_tipo = element.section_tipo;
	// own record: the real-save case writes it (manifest.ts SUITE_ISOLATION_RECORDS[17])
	const section_id = uca_maps_section_id;
	const tipo = element.tipo;
	const lang = element.lang;

	const container = document.getElementById('content');
	const component_container = ui.create_dom_element({
		element_type: 'div',
		class_name: 'component_container_uca_maps',
		parent: container,
	});

	/**
	 * One drawn shape per FeatureGroup — layer_id 1 polygon, 2 circle, 3 marker —
	 * so any test reaches every geometry branch. The circle is a Point carrying
	 * `shape: 'circle'` and `radius` (metres), which component_geolocation's
	 * load_layer rebuilds as an L.Circle.
	 */
	const seeded_lib_data = () => [
		{
			layer_id: 1,
			layer_data: {
				type: 'FeatureCollection',
				features: [
					{
						type: 'Feature',
						properties: {},
						geometry: {
							type: 'Polygon',
							coordinates: [
								[
									[-3.71, 40.4],
									[-3.6, 40.4],
									[-3.6, 40.5],
									[-3.71, 40.5],
									[-3.71, 40.4],
								],
							],
						},
					},
				],
			},
		},
		{
			layer_id: 2,
			layer_data: {
				type: 'FeatureCollection',
				features: [
					{
						type: 'Feature',
						properties: { shape: 'circle', radius: 500 },
						geometry: { type: 'Point', coordinates: [-3.65, 40.45] },
					},
				],
			},
		},
		{
			layer_id: 3,
			layer_data: {
				type: 'FeatureCollection',
				features: [
					{
						type: 'Feature',
						properties: {},
						geometry: { type: 'Point', coordinates: [-3.68, 40.42] },
					},
				],
			},
		},
	];

	/** A 1x1 transparent GIF: a tile served without the network. */
	const BLANK_TILE =
		'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

	/**
	 * Arming UA builds the core's built-in IGN layer (`builtin=ign_admin_units`)
	 * and Catastro and ARCGIS their component defaults (`default_id=`), all
	 * through the tile proxy: while this is in place (beforeEach) their tiles come
	 * from BLANK_TILE, so no test makes the server reach a provider. The layers stay
	 * real L.TileLayer. Returns the restore (L is global).
	 */
	const offline_ua_wms = function () {
		const original = L.tileLayer;
		const patched = function (url, options) {
			const layer = original.call(this, url, options);
			if (String(url).includes('builtin=ign_admin_units') || String(url).includes('default_id=')) {
				layer.getTileUrl = () => BLANK_TILE;
			}
			return layer;
		};
		patched.wms = original.wms;
		L.tileLayer = patched;
		return () => {
			L.tileLayer = original;
		};
	};

	/** The `catastro` default an administrator lists in `properties.map_sources`, as core sends it. */
	const CATASTRO_DEFAULT = {
		id: 'catastro',
		label: 'Catastro',
		type: 'wms',
		attribution: 'Test credit',
		crs: 'EPSG:3857',
	};

	/** Catastro's button exists only for a component that lists that default. */
	const offer_catastro = function () {
		offer_defaults([CATASTRO_DEFAULT]);
	};

	/**
	 * The component lists `entries` as its `properties.map_sources`, and core offers each as
	 * its own overlay, as get_map does on a configured install. A copy of the context, so no
	 * other instance sharing it sees the entries.
	 */
	const offer_defaults = function (entries) {
		const properties = geolocation.context.properties || {};
		geolocation.context = {
			...geolocation.context,
			properties: { ...properties, map_sources: entries },
		};
		geolocation.build_source_layers(0);
	};

	/** A component_geolocation on the fixture record; `id_prefix` keeps it apart from every other instance. */
	const geolocation_instance = (id_prefix) =>
		get_instance({
			model: 'component_geolocation',
			tipo: tipo,
			section_tipo: section_tipo,
			section_id: section_id,
			lang: lang,
			mode: 'edit',
			view: 'default',
			id_variant: id_prefix + Math.random(),
		});

	/** A tool on `component` with what production init resolves, without the ceremony (file header). tool_request is the caller's. */
	const wire_tool_by_hand = function (component) {
		const wired = new tool_uca_maps();
		wired.model = 'tool_uca_maps';
		wired.caller = component;
		wired.geolocation = component;
		wired.map_ready = true;
		// init's own default: without it create_source() sends `source.mode:
		// null` and the server rejects every tool_request as request.invalid_rqo
		wired.mode = 'edit';
		wired.get_tool_label = () => undefined; // force the '||' fallback label strings
		return wired;
	};

	let geolocation, tool, map_container, restore_ua_wms;

	beforeEach(async function () {
		geolocation = await geolocation_instance('uca_console_');
		await geolocation.build(true);
		geolocation.data.entries = [{ id: 9001, lib_data: seeded_lib_data() }];
		geolocation.permissions = 2;

		const node = await geolocation.render();
		component_container.appendChild(node);

		map_container = node.content_data[0].map_container;
		await geolocation.get_map(map_container, 0);
		assert.isOk(geolocation.map, 'expected a live Leaflet map');
		restore_ua_wms = offline_ua_wms(); // L exists once get_map has loaded it

		// get_map() loads only the active layer: the circle and the marker need
		// the core's own 'full' load to get a FeatureGroup at all
		geolocation.layers_loader({ load: 'full', layer_id: null });

		tool = wire_tool_by_hand(geolocation);
		tool.tool_request = real_tool_request;

		bind({ geolocation, tool, map_container });
	});

	afterEach(async function () {
		if (restore_ua_wms) {
			restore_ua_wms();
			restore_ua_wms = null;
		}
		if (tool) {
			await tool.destroy(true, true, true);
		}
		if (geolocation && geolocation.status !== 'destroyed') {
			await geolocation.destroy(true);
		}
		while (component_container.firstChild) {
			component_container.removeChild(component_container.firstChild);
		}
	});

	/**
	 * The tool's own tool_request, except get_elevation: every popup asks it for
	 * the selected object and the server would ask open-elevation. "Unavailable"
	 * leaves the console's heading as it is drawn.
	 */
	const real_tool_request = function (options) {
		if (options && options.action === 'get_elevation') {
			return Promise.resolve({ ok: true, data: { elevation: null, unavailable: true } });
		}
		return tool_uca_maps.prototype.tool_request.call(tool, options);
	};

	// `tool` is rebuilt for every test, so a stub needs no restore
	const stub_tool_request = function (answer) {
		tool.tool_request = answer;
	};

	/** The one layer of a seeded FeatureGroup (seeded_lib_data). */
	const seeded_layer = (layer_id) => geolocation.FeatureGroup[layer_id].getLayers()[0];

	const active_group = () => geolocation.FeatureGroup[geolocation.active_layer_id];

	/** Attaches the console and selects a seeded layer through its real popup. */
	const open_console_on = function (layer_id) {
		tool.attach_console();
		const layer = seeded_layer(layer_id);
		layer.openPopup();
		return layer;
	};

	// a hand-built carrier has no popup: fire the selection the console listens
	// to (its popupopen handler reads popup._source and nothing else)
	const select_carrier = function (carrier) {
		geolocation.map.fire('popupopen', { popup: { _source: carrier } });
	};

	/**
	 * The four requests of one linked-image import: stage (server download),
	 * mint, ingest, where it is served. `stage` answers per url; the rest
	 * succeed. `restore()` puts data_manager back, which outlives the test.
	 */
	const stub_linked_import = function (stage, ingest) {
		const original_request = data_manager.request;
		const seen = { stages: [], created: 0, released: [] };
		let next_id = 9100;
		data_manager.request = async function (options) {
			const body = options && options.body;
			if (
				body &&
				body.action === 'tool_request' &&
				body.source &&
				body.source.action === 'stage_external_image'
			) {
				seen.stages.push({
					options: body.options,
					timeout: options.timeout,
					retries: options.retries,
				});
				return stage(body.options.url);
			}
			if (body && body.action === 'create') {
				seen.created++;
				return { ok: true, data: next_id++ };
			}
			if (
				body &&
				body.action === 'tool_request' &&
				body.source &&
				body.source.action === 'process_uploaded_file'
			) {
				return ingest ? ingest(body.options.file_data.tmp_name) : { ok: true, data: true };
			}
			if (body && body.action === 'delete') {
				return { ok: true, data: [body.source.section_id] };
			}
			if (body && body.action === 'delete_uploaded_file') {
				seen.released.push(body.options);
				return { ok: true, data: true };
			}
			return original_request.apply(this, arguments);
		};
		stub_tool_request(async function (options) {
			if (options.action === 'get_image_file') {
				return {
					ok: true,
					data: {
						file_path: '/image/1.5MB/' + options.options.section_id + '.jpg',
						quality: '1.5MB',
					},
				};
			}
			return real_tool_request(options);
		});
		seen.restore = function () {
			data_manager.request = original_request;
		};
		return seen;
	};

	/** A saved image's carrier rectangle, in the active FeatureGroup. */
	const add_image_carrier = function () {
		const carrier = L.rectangle(
			[
				[40.44, -3.66],
				[40.46, -3.64],
			],
			{ opacity: 0, fillOpacity: 0 },
		);
		carrier.feature = carrier.toGeoJSON();
		// the same two properties create_image_object writes in production
		carrier.feature.properties.uca_maps = {
			image: image_descriptor(),
			is_raster: true,
		};
		active_group().addLayer(carrier);
		return carrier;
	};

	// the install's answer is stubbed: no test reaches Pleiades, Pelagios or DARE
	const mount_roman = function (gazetteers = null) {
		tool.get_capabilities = async () => ({
			ok: true,
			data: { gazetteers: structuredClone(gazetteers) },
		});
		tool.attach_roman_empire();
	};

	const open_roman = () =>
		geolocation.map.getContainer().querySelector('.uca-maps-roman-control').click();

	// called AFTER opening the panel: opening resets it
	const seed_roman_list = function (source, results) {
		tool._roman_results = results;
		tool._roman_source = source;
		populate_roman_results(tool, tool.roman_panel);
	};

	/** What `fn` sent by any door: data_manager, an XHR (service_upload) or fetch. */
	const requests_sent_by = async function (fn) {
		const sent = [];
		const original_request = data_manager.request;
		const original_open = XMLHttpRequest.prototype.open;
		const original_fetch = window.fetch;
		data_manager.request = function (options) {
			sent.push('data_manager ' + JSON.stringify(options && options.body && options.body.action));
			return original_request.apply(this, arguments);
		};
		XMLHttpRequest.prototype.open = function (method, url) {
			sent.push('xhr ' + url);
			return original_open.apply(this, arguments);
		};
		window.fetch = function (input) {
			sent.push('fetch ' + ((input && input.url) || input));
			return original_fetch.apply(this, arguments);
		};
		try {
			return { result: await fn(), sent: sent };
		} finally {
			data_manager.request = original_request;
			XMLHttpRequest.prototype.open = original_open;
			window.fetch = original_fetch;
		}
	};

	return {
		BLANK_TILE,
		CATASTRO_DEFAULT,
		offer_catastro,
		offer_defaults,
		geolocation_instance,
		wire_tool_by_hand,
		real_tool_request,
		stub_tool_request,
		seeded_layer,
		active_group,
		open_console_on,
		select_carrier,
		stub_linked_import,
		add_image_carrier,
		mount_roman,
		open_roman,
		seed_roman_list,
		requests_sent_by,
	};
}; //end use_live_map

// @license-end
