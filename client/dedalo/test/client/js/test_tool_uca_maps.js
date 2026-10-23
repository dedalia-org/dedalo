// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global it, describe, beforeEach, afterEach, assert, L, turf, domtoimage, HTMLAnchorElement, DEDALO_CORE_URL, DEDALO_MEDIA_URL */
/*eslint no-undef: "error"*/
'use strict';

/**
 * TEST_TOOL_UCA_MAPS
 *
 * Client suite for tool_uca_maps, in two describes. STRUCTURAL: pure exports
 * and the constructor, no fixture. LIVE MAP: every test builds a real
 * component_geolocation (TLD `test`, the elements.js record) seeded with a
 * polygon, a circle and a marker, and wires a tool to it by hand: init() and
 * tool_common's ceremony are skipped, because production init only resolves
 * `geolocation` and `map_ready` (get_caller_by_model) and the tool reads no
 * ontology.
 *
 * What it does not do: test the server actions (test/unit/tool_uca_maps_*),
 * or reach a third party's answer. Lookups are stubbed per test and
 * get_elevation in the beforeEach, which also blanks every IGN (UA) tile.
 * Basemap, Catastro and example.com WMS tiles still load from the network,
 * and nothing asserts on them. A few tests round-trip a GDAL/ImageMagick
 * action on the suite's own server. The tool stylesheet is loaded only by
 * with_tool_css() tests.
 */

import { elements } from './elements.js'
import { get_instance } from '../../../core/common/js/instances.js'
import { ui } from '../../../core/common/js/ui.js'
import { event_manager } from '../../../core/common/js/event_manager.js'
import { data_manager } from '../../../core/common/js/data_manager.js'
import { tool_uca_maps } from '../../../tools/tool_uca_maps/js/tool_uca_maps.js'
import {
	find_layer_id,
	download_object_pdf,
	layer_center,
	fetch_elevation,
	set_style_field,
	set_property,
	delete_property,
	download_vector,
	toggle_centroid,
	toggle_uncertainty,
	set_hierarchy,
	format_polygon_area,
	apply_display,
	detach_console,
	RESERVED_PROPERTY_KEYS,
	computed_property_keys
} from '../../../tools/tool_uca_maps/js/object_console.js'
import { download_map_image, keep_in_map_image } from '../../../tools/tool_uca_maps/js/map_image_download.js'
import { DEFAULT_MAP_IMAGE_NAME } from '../../../tools/tool_uca_maps/js/download_filename.js'
import { collect_objects, set_object_display, center_on_object } from '../../../tools/tool_uca_maps/js/object_viewer.js'
import { create_image_object, corners_from_viewport, image_download_width, ingest_image_upload, IMAGE_DOWNLOAD_TIMEOUT_MS, IMAGE_SECTION_TIPO, IMAGE_COMPONENT_TIPO } from '../../../tools/tool_uca_maps/js/image_upload.js'
import {
	associate_image,
	object_images,
	object_image_url,
	remove_object_image,
	linked_images,
	external_images_enabled,
	import_linked_images,
	MAX_OBJECT_IMAGES
} from '../../../tools/tool_uca_maps/js/object_image.js'
import { is_onexone_enabled, create_onexone_rectangle } from '../../../tools/tool_uca_maps/js/onexone.js'
import { DEFAULT_BASEMAPS, detach_xyz_basemaps } from '../../../tools/tool_uca_maps/js/xyz_basemaps.js'
import { parse_wms_capabilities_xml } from '../../../tools/tool_uca_maps/js/wms_services.js'
import { populate_wms_search_results } from '../../../tools/tool_uca_maps/js/render_wms_services.js'
import { UPLOAD_MESSAGE_MS } from '../../../tools/tool_uca_maps/js/render_file_upload.js'
import { detach_file_upload } from '../../../tools/tool_uca_maps/js/vector_upload.js'
import { tool_error_text, exception_text, REASON_CODES } from '../../../tools/tool_uca_maps/js/tool_error_text.js'
import { error_text } from '../../../core/common/js/render_api_error.js'
import { resolve_error_policy } from '../../../core/common/js/error_policy.js'
import { is_catastro_enabled, check_catastro_at_point } from '../../../tools/tool_uca_maps/js/catastro.js'
import { is_spanish_official_lang } from '../../../tools/tool_uca_maps/js/basemap_swap.js'
import { check_administrative_unit_at_point } from '../../../tools/tool_uca_maps/js/administrative_units.js'
import { focus_place_result, search_places } from '../../../tools/tool_uca_maps/js/place_search.js'
import { create_position_marker, is_geolocate_enabled, toggle_geolocate } from '../../../tools/tool_uca_maps/js/geolocate.js'
import { populate_place_search_results } from '../../../tools/tool_uca_maps/js/render_place_search.js'
import { attach_scale_bar, detach_scale_bar, format_distance, round_distance } from '../../../tools/tool_uca_maps/js/scale_bar.js'
import {
	empty_legend,
	default_element_icon,
	ALLOWED_ICON_TYPES,
	MAX_ICON_BYTES
} from '../../../tools/tool_uca_maps/js/legend.js'
import { populate_legend_columns } from '../../../tools/tool_uca_maps/js/render_legend.js'
import { default_symbol_colour } from '../../../tools/tool_uca_maps/js/legend_symbol.js'
import { is_toolbar_node, create_toolbar_panel, remove_toolbar_panel } from '../../../tools/tool_uca_maps/js/toolbar.js'
import {
	search_roman,
	add_roman_result,
	create_roman_objects,
	load_roman_capabilities,
	roman_min_query
} from '../../../tools/tool_uca_maps/js/roman_empire.js'
import {
	populate_roman_results,
	refresh_roman_sources,
	LIVE_SEARCH_DELAY_MS
} from '../../../tools/tool_uca_maps/js/render_roman_empire.js'



/** The colour a cataloguer picks in the style field: the tool's own hue
* (`--tool_uca_maps` is Dédalo's orange, main.css), which no default shares. Read
* from the token, not spelled: a colour spelled in a shipped file is counted
* (colour_literal_ratchet_tripwire). Lowercase hex, what `<input type=color>` yields. */
const picked_colour = function() {
	const value = getComputedStyle(document.documentElement).getPropertyValue('--color_orange_dedalo').trim().toLowerCase()
	assert.match(value, /^#[0-9a-f]{6}$/, 'expected the orange token as a hex colour')
	return value
}

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms))

const two_frames = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))

/** Polls until `done()` holds or the tries run out; the caller asserts what it waited for. */
const until = async function(done, tries = 200, ms = 10) {
	for (let i=0; i<tries && !done(); i++) {
		await tick(ms)
	}
}

/**
* Runs `fn` with the tool's own stylesheet loaded, and removes it after:
* the suite runs without it, so only a layout or paint test pays for it.
*/
const with_tool_css = async function(fn) {
	const link = document.createElement('link')
	link.rel	= 'stylesheet'
	link.href	= new URL('../../../tools/tool_uca_maps/css/tool_uca_maps.css', import.meta.url).href
	await new Promise((resolve, reject) => {
		link.addEventListener('load', resolve)
		link.addEventListener('error', reject)
		document.head.appendChild(link)
	})
	try {
		return await fn()
	} finally {
		link.remove()
	}
}

/**
* Runs `fn` with the tool sheet's phone rules applied at the suite's desktop
* width, where the phone @media never matches: the rules inside it whose
* selector names `selector_part` are lifted out of the loaded sheet and applied
* unconditionally. Call inside with_tool_css.
* @returns {Promise<*>}
*/
const with_phone_rules = async function(selector_part, fn) {
	const sheet = [...document.styleSheets].find((s) => s.href && s.href.includes('/tool_uca_maps.css'))
	const rules = [...sheet.cssRules]
		.filter((rule) => rule instanceof CSSMediaRule && /max-width:\s*600px/.test(rule.conditionText))
		.flatMap((rule) => [...rule.cssRules])
		.filter((rule) => rule.selectorText && rule.selectorText.includes(selector_part))
	assert.isAbove(rules.length, 0, 'expected phone rules for ' + selector_part)
	const style = document.createElement('style')
	style.textContent = rules.map((rule) => rule.cssText).join('\n')
	document.head.appendChild(style)
	try {
		return await fn()
	} finally {
		style.remove()
	}
}

/**
* Runs `fn` with URL.createObjectURL and the anchor's click spied: the Blob a
* download builds, and the name trigger_blob_download puts on the anchor (the
* only place a typed name shows on the client-only branches). Stubbing the
* click also keeps the headless browser from downloading anything.
* @returns {Promise<{blob: Blob|null, name: string|null}>}
*/
const capture_download = async function(fn) {
	const original_create_object_url	= URL.createObjectURL
	const original_click				= HTMLAnchorElement.prototype.click
	const captured = {blob: null, name: null}
	URL.createObjectURL = (blob) => {
		captured.blob = blob
		return 'blob:uca-maps-test-mock'
	}
	HTMLAnchorElement.prototype.click = function() {
		captured.name = this.download
	}
	try {
		await fn()
	} finally {
		URL.createObjectURL					= original_create_object_url
		HTMLAnchorElement.prototype.click	= original_click
	}
	return captured
}//end capture_download

/**
* "Download image" asks through data_manager.request with its own timeout:
* `answer` sees the {action, options} a tool_request stub would, plus the
* transport options. Returns the restore (data_manager outlives the test).
*/
const stub_image_download = function(answer) {
	const original = data_manager.request
	data_manager.request = async function(options) {
		const body = options && options.body
		if (body && body.action==='tool_request' && body.source && body.source.action==='image_download') {
			return answer({action: body.source.action, options: body.options}, options)
		}
		return original.apply(this, arguments)
	}
	return () => { data_manager.request = original }
}

/**
* create_image_object ends in map.fitBounds(), which starts a ZOOM ANIMATION.
* A test ending with the frame still queued hands afterEach a map it destroys
* under a pending _move(), and Leaflet throws inside the NEXT test's beforeEach.
*/
const settle_map = function(map) {
	return new Promise((resolve) => {
		const settled = () => resolve()
		map.once('moveend', settled)
		setTimeout(settled, 1000) // fitBounds on an already-matching view fires nothing
	})
}

/** The base tile layer on the map, read off the map itself: Catastro and UA swap it. */
const find_active_tile_layer = function(map) {
	let found = null
	map.eachLayer((layer) => { if (layer instanceof L.TileLayer) found = layer })
	return found
}

/** The layer of `feature_group` whose properties.uca_maps.uid is `uid`. */
const layer_by_uid = function(feature_group, uid) {
	return feature_group.getLayers().find((candidate) =>
		candidate.feature
		&& candidate.feature.properties
		&& candidate.feature.properties.uca_maps
		&& candidate.feature.properties.uca_maps.uid===uid
	)
}

// without the tool CSS a panel never scrolls: give it the cap it lacks
const make_panel_scrollable = function(panel) {
	panel.style.maxHeight	= '160px'
	panel.style.overflowY	= 'auto'
}

// hand the picker a real FileList, then fire what the browser fires
const pick_file = function(input, file) {
	load_file(input, file)
	input.dispatchEvent(new Event('change'))
}

// load the picker without firing anything: the vector half uploads on click
const load_file = function(input, file) {
	const transfer = new DataTransfer()
	transfer.items.add(file)
	input.files = transfer.files
}

const vector_file	= () => new File(['{}'], 'plan.geojson', {type: 'application/geo+json'})
const image_file	= () => new File(['x'], 'plan.png', {type: 'image/png'})
const pin_png		= () => new File([new Uint8Array([137, 80, 78, 71])], 'pin.png', {type: 'image/png'})

/** One drawable point, what the real vector upload round trip sends. */
const SAMPLE_UPLOAD_GEOJSON = {
	type		: 'FeatureCollection',
	features	: [{
		type		: 'Feature',
		properties	: {},
		geometry	: { type: 'Point', coordinates: [-3.65, 40.45] }
	}]
}
const sample_vector_file = () => new File([JSON.stringify(SAMPLE_UPLOAD_GEOJSON)], 'test.geojson', {type: 'application/geo+json'})

/** A GetCapabilities answer with one queryable layer: no WMS server is ever asked. */
const SAMPLE_CAPABILITIES_XML = `<?xml version="1.0" encoding="UTF-8"?>
	<WMS_Capabilities xmlns="http://www.opengis.net/wms" version="1.3.0">
		<Capability>
			<Layer>
				<Layer queryable="1">
					<Name>topo:layer1</Name>
					<Title>Layer One</Title>
				</Layer>
			</Layer>
		</Capability>
	</WMS_Capabilities>`

/** A parcel the Catastro proxy found, fresh per call. */
const parcel_found = (url = 'https://example.com/parcel') => ({
	found	: true,
	refcat	: '1234567AB1234C',
	url		: url,
	points	: [[40.1, -3.7], [40.2, -3.7], [40.2, -3.6], [40.1, -3.6]]
})

/**
* A saved image overlay, as a record hands it back on load. No test uploads a
* real image: that would mint a record and media on every run with no id
* handed back to sweep them.
*/
const IMAGE_DESCRIPTOR = {
	file_path		: '/image/1.5MB/test99_test3_1.jpg',
	quality			: '1.5MB',
	section_tipo	: 'test3',
	section_id		: 1,
	tipo			: 'test99',
	corners			: {
		top_left	: [40.46, -3.66],
		top_right	: [40.46, -3.64],
		bottom_left	: [40.44, -3.66]
	},
	opacity			: 1,
	z_index			: 200
}
const image_descriptor = () => JSON.parse(JSON.stringify(IMAGE_DESCRIPTOR))

/** An object's gallery already at the cap. */
const full_gallery = () => ({ images: Array.from(
	{length: MAX_OBJECT_IMAGES},
	(value, index) => ({file_path: '/' + index + '.jpg', section_tipo:'test3', section_id:index, tipo:'test99', name:null})
) })

/** What the server answers once it has staged a linked image under `name`. */
const staged_answer = (name) => ({ok: true, data: {file_data: {
	key_dir: 'image', tmp_name: name, name: name, extension: 'jpg', complete: true
}}})

/** The SVG a drawn legend symbol stores in `icon` (a base64 `data:` URL). */
const decode_symbol = function(icon) {
	const prefix = 'data:image/svg+xml;base64,'
	assert.isTrue(icon.startsWith(prefix), 'expected a drawn symbol stored as an SVG data URL')
	return new DOMParser().parseFromString(atob(icon.slice(prefix.length)), 'image/svg+xml').documentElement
}

/** How many pixels an SVG source paints when drawn at 24x24 (0 if it does not load). */
const opaque_pixels = async function(source) {
	const image = new Image()
	image.src = URL.createObjectURL(new Blob([source], {type: 'image/svg+xml'}))
	try {
		await image.decode()
	} catch {
		return 0
	} finally {
		URL.revokeObjectURL(image.src)
	}
	const canvas = Object.assign(document.createElement('canvas'), {width: 24, height: 24})
	const context = canvas.getContext('2d')
	context.drawImage(image, 0, 0, 24, 24)
	const {data} = context.getImageData(0, 0, 24, 24)
	let count = 0
	for (let i = 3; i < data.length; i += 4) if (data[i] > 0) count++
	return count
}

/** A one-point GeoJSON feature, the shape Pelagios/DARE hits carry. */
const roman_feature = function(name, lat, lon) {
	return {
		type		: 'Feature',
		properties	: { name: name },
		geometry	: { type: 'Point', coordinates: [lon, lat] }
	}
}
const roman_hit = (name, lat, lon) => ({ name: name, geometry_type: 'Point', feature: roman_feature(name, lat, lon) })

/** An install that serves Pleiades and no Pelagios layer. */
const WITH_PLEIADES = { configured: true, pleiades: true, pelagios: [] }



describe('TOOL_UCA_MAPS CLIENT TEST', function() {

	this.timeout(10000)

	it('a new instance starts unattached and idle, and the prototype carries what no other test calls', function() {

		// what the attach_* guards and destroy() read: an attach that sees a
		// stale value skips its work, a detach that sees one undoes another's
		const instance = new tool_uca_maps()
		const initial = {
			geolocation						: null,
			map_ready						: false,
			map_control						: null,
			_popupopen_handler				: null,
			_popupclose_handler				: null,
			_click_handler					: null,
			_catastro_busy					: false,
			_ua_busy						: false,
			_upload_busy					: false,
			_image_upload_busy				: false,
			_xyz_took_over_tiles			: false,
			_xyz_created_layer_control		: false,
			_catastro_created_layer_control	: false,
			_ua_created_layer_control		: false
		}
		for (const [key, value] of Object.entries(initial)) {
			assert.strictEqual(instance[key], value, 'expected ' + key + ' to start as ' + value)
		}

		// wire_tool's delegates and the members the live-map tests never call
		for (const name of ['render', 'refresh', 'init', 'build', 'wait_for_map', 'close_transient_modal', 'clear_roman_search']) {
			assert.isFunction(tool_uca_maps.prototype[name], 'expected ' + name + ' on the prototype')
		}
	})

	it('destroy() while wait_for_map pauses resolves it false, on the last pause and on a mid-wait one', async function() {

		// destroy() nulls `geolocation` before (or, with delete_self=false,
		// without ever) setting status 'destroyed': the read after the pause
		// is what used to throw, and build() only logged it
		const original_now = Date.now
		try {
			const last_pause = new tool_uca_maps()
			last_pause.geolocation = {map: null}
			const waiting_last = last_pause.wait_for_map()
			const start = original_now()
			Date.now = () => start + 60000 // the deadline passes during this pause
			await last_pause.destroy(true, true, true)
			assert.isFalse(await waiting_last, 'expected false once the deadline passed after destroy')
			Date.now = original_now

			const mid_wait = new tool_uca_maps()
			mid_wait.geolocation = {map: null}
			const waiting_mid = mid_wait.wait_for_map()
			await mid_wait.destroy(false, false, false)
			assert.isFalse(await waiting_mid, 'expected false on the next poll after a destroy that keeps the status')
		} finally {
			Date.now = original_now
		}
	})

	// the seed is the object v6 writes the first time
	// (`class.tool_leaflet_special_tools.php` legends()): persisting a legend
	// is writing this shape verbatim
	it('empty_legend seeds v6\'s own stored shape', function() {

		assert.deepEqual(empty_legend(), {legend: '', enable: true, columns: []})

		assert.deepEqual(
			ALLOWED_ICON_TYPES,
			['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml'],
			'expected v6\'s own accepted icon types'
		)
		assert.equal(MAX_ICON_BYTES, 2000000, 'expected v6\'s own 2 MB ceiling')
	})

	it('tool_error_text: a REASON_CODES refusal is the panel\'s lead, then the server\'s reason', function() {

		assert.includeMembers(
			Array.from(REASON_CODES),
			['request.invalid_options', 'tool.unsupported_target', 'media.file_not_found', 'media.upload_rejected'],
			'expected the public codes the server refuses with a reason, the upload receiver\'s included'
		)
		const rows = [
			// the reason core's generic label hides
			{code: 'request.invalid_options', lead: 'The file could not be loaded.', message: "Invalid UTM zone '61' (expected 1 to 60)"},
			{code: 'media.upload_rejected', lead: 'The image could not be loaded.', message: 'File content verification failed: not a JPEG — rejected'},
			...Array.from(REASON_CODES, (code) => ({code: code, lead: 'LEAD', message: 'Why it failed.'}))
		]
		for (const row of rows) {
			const refusal = {is_api_error: true, code: row.code, label_key: 'x', message: row.message}
			assert.equal(tool_error_text(refusal, row.lead), row.lead + '\n' + row.message, 'expected the reason shown for ' + row.code)
		}
	})

	it('tool_error_text: any other code, or a refusal with no reason, is core\'s error_text', function() {

		const other = {
			is_api_error	: true,
			code			: 'tool.action_failed',
			label_key		: 'error_tool_action_failed',
			message			: 'The tool action could not be completed'
		}
		const bare = {
			is_api_error	: true,
			code			: 'request.invalid_options',
			label_key		: 'error_request_invalid_options',
			message			: '  '
		}

		for (const api_error of [other, bare]) {
			const text = tool_error_text(api_error, 'LEAD')
			assert.equal(text, error_text(api_error), 'expected core\'s sentence for ' + api_error.code)
			assert.notInclude(text, 'LEAD', 'expected no lead without a reason to introduce')
		}
	})

	it('exception_text: the lead, then the exception\'s own message when it has one', function() {

		assert.equal(exception_text(new Error('Tainted canvas.'), 'LEAD'), 'LEAD\nTainted canvas.')
		for (const bare of [new Error(''), new Error('   '), {}, null, 'a string']) {
			assert.equal(exception_text(bare, 'LEAD'), 'LEAD', 'expected the lead alone for ' + JSON.stringify(bare))
		}
	})

	// js/wms_services.js, on a hand-written GetCapabilities: v6's rule is that
	// any `queryable` attribute counts, even "0" (`getAttribute()!==null`), and
	// an unnamed layer is a grouping node, skipped
	it('parse_wms_capabilities_xml keeps only queryable, named layers; falls back Title to Name', function() {

		const xml = `<?xml version="1.0" encoding="UTF-8"?>
			<WMS_Capabilities xmlns="http://www.opengis.net/wms" version="1.3.0">
				<Capability>
					<Layer>
						<Title>Root</Title>
						<Layer>
							<Name>topo:not_queryable</Name>
							<Title>Not queryable</Title>
						</Layer>
						<Layer queryable="1">
							<Name>topo:layer2</Name>
							<Title>Layer Two</Title>
						</Layer>
						<Layer queryable="1">
							<Name>topo:layer3</Name>
						</Layer>
						<Layer queryable="0">
							<Name>topo:layer4</Name>
							<Title>Layer Four</Title>
						</Layer>
					</Layer>
				</Capability>
			</WMS_Capabilities>`

		const result = parse_wms_capabilities_xml(xml)

		assert.equal(result.ok, true)
		assert.deepEqual(result.layers, [
			{name: 'topo:layer2', title: 'Layer Two'},
			{name: 'topo:layer3', title: 'topo:layer3'},
			{name: 'topo:layer4', title: 'Layer Four'}
		], 'expected queryable="0" kept: the attribute counts, not its value')
	})

	it('parse_wms_capabilities_xml reports a parse failure on malformed XML', function() {
		const result = parse_wms_capabilities_xml('<not-xml<<<')
		assert.equal(result.ok, false)
		assert.isOk(result.error)
	})

	// Name/Title are read from DIRECT children: a subtree search would hand an
	// unnamed group its nested child's Name and list a layer that does not exist
	it('parse_wms_capabilities_xml never inherits Name/Title from a NESTED child of an unnamed queryable group', function() {

		const xml = `<?xml version="1.0" encoding="UTF-8"?>
			<WMS_Capabilities xmlns="http://www.opengis.net/wms" version="1.3.0">
				<Capability>
					<Layer>
						<Layer queryable="1">
							<Title>Group (no own Name)</Title>
							<Layer queryable="1">
								<Name>topo:child2</Name>
								<Title>Child Two</Title>
							</Layer>
						</Layer>
					</Layer>
				</Capability>
			</WMS_Capabilities>`

		const result = parse_wms_capabilities_xml(xml)

		assert.equal(result.ok, true)
		assert.deepEqual(result.layers, [{name: 'topo:child2', title: 'Child Two'}], 'expected only the real leaf, never a bogus entry for the unnamed group')
	})

	it('the scale rounds to a readable distance and labels it in m or km', function() {

		// Leaflet's own _getRoundNum criterion: the largest 1/2/3/5/10 x 10^n
		// that still fits under the bar's max width
		assert.equal(round_distance(1234), 1000)
		assert.equal(round_distance(999), 500)
		assert.equal(round_distance(3400), 3000)
		assert.equal(round_distance(78), 50)
		assert.equal(round_distance(21), 20)

		assert.equal(format_distance(500), '500 m')
		assert.equal(format_distance(1000), '1 km')
		assert.equal(format_distance(1500), '1.5 km')
		// never "2.0 km" — a trailing zero on a map scale reads as precision
		// the bar does not have
		assert.equal(format_distance(2000), '2 km')
	})

})



describe('TOOL_UCA_MAPS OBJECT CONSOLE (live map)', function() {

	this.timeout(20000)

	const element = elements.find(el => el.model==='component_geolocation')
	if (!element) {
		console.error('Error: component_geolocation not found in elements');
	}
	const section_tipo	= element.section_tipo
	const section_id	= element.section_id
	const tipo			= element.tipo
	const lang			= element.lang

	const container = document.getElementById('content')
	const component_container = ui.create_dom_element({
		element_type	: 'div',
		class_name		: 'component_container_uca_maps',
		parent			: container
	})

	/**
	* One drawn shape per FeatureGroup — layer_id 1 polygon, 2 circle, 3 marker —
	* so any test reaches every geometry branch. The circle is a Point carrying
	* `shape: 'circle'` and `radius` (metres), which component_geolocation's
	* load_layer rebuilds as an L.Circle.
	*/
	const seeded_lib_data = () => [
		{
			layer_id	: 1,
			layer_data	: { type:'FeatureCollection', features:[{
				type		: 'Feature',
				properties	: {},
				geometry	: {
					type		: 'Polygon',
					coordinates	: [[[-3.71,40.40],[-3.60,40.40],[-3.60,40.50],[-3.71,40.50],[-3.71,40.40]]]
				}
			}]}
		},
		{
			layer_id	: 2,
			layer_data	: { type:'FeatureCollection', features:[{
				type		: 'Feature',
				properties	: { shape: 'circle', radius: 500 },
				geometry	: { type:'Point', coordinates:[-3.65,40.45] }
			}]}
		},
		{
			layer_id	: 3,
			layer_data	: { type:'FeatureCollection', features:[{
				type		: 'Feature',
				properties	: {},
				geometry	: { type:'Point', coordinates:[-3.68,40.42] }
			}]}
		}
	]

	/** A 1x1 transparent GIF: a tile served without the network. */
	const BLANK_TILE = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'

	/**
	* Arming UA builds the IGN's AU.AdministrativeUnit WMS: every WMS layer
	* pointed at www.ign.es takes its tiles from BLANK_TILE while this is in
	* place (beforeEach), so no test reaches IGN. The layer stays a real
	* L.TileLayer.WMS. Returns the restore (L is global).
	*/
	const offline_ua_wms = function() {
		const original = L.tileLayer.wms
		L.tileLayer.wms = function(url, options) {
			const layer = original.call(this, url, options)
			if (String(url).startsWith('https://www.ign.es/')) {
				layer.getTileUrl = () => BLANK_TILE
			}
			return layer
		}
		return () => { L.tileLayer.wms = original }
	}

	let geolocation, tool, map_container, restore_ua_wms

	beforeEach(async function() {

		geolocation = await get_instance({
			model			: 'component_geolocation',
			tipo			: tipo,
			section_tipo	: section_tipo,
			section_id		: section_id,
			lang			: lang,
			mode			: 'edit',
			view			: 'default',
			id_variant		: 'uca_console_' + Math.random()
		})
		await geolocation.build(true)
		geolocation.data.entries	= [ { id: 9001, lib_data: seeded_lib_data() } ]
		geolocation.permissions	= 2

		const node = await geolocation.render()
		component_container.appendChild(node)

		map_container = node.content_data[0].map_container
		await geolocation.get_map(map_container, 0)
		assert.isOk(geolocation.map, 'expected a live Leaflet map')
		restore_ua_wms = offline_ua_wms() // L exists once get_map has loaded it

		// get_map() loads only the active layer: the circle and the marker need
		// the core's own 'full' load to get a FeatureGroup at all
		geolocation.layers_loader({ load: 'full', layer_id: null })

		// what production init resolves, without the ceremony (file header)
		tool					= new tool_uca_maps()
		tool.model				= 'tool_uca_maps'
		tool.caller				= geolocation
		tool.geolocation		= geolocation
		tool.map_ready			= true
		// init's own default: without it create_source() sends `source.mode:
		// null` and the server rejects every tool_request as request.invalid_rqo
		tool.mode				= 'edit'
		tool.get_tool_label		= () => undefined // force the '||' fallback label strings
		tool.tool_request		= real_tool_request

	})

	afterEach(async function() {
		if (restore_ua_wms) {
			restore_ua_wms()
			restore_ua_wms = null
		}
		if (tool) {
			await tool.destroy(true, true, true)
		}
		if (geolocation && geolocation.status!=='destroyed') {
			await geolocation.destroy(true)
		}
		while (component_container.firstChild) {
			component_container.removeChild(component_container.firstChild)
		}
	})

	/**
	* The tool's own tool_request, except get_elevation: every popup asks it for
	* the selected object and the server would ask open-elevation. "Unavailable"
	* leaves the console's heading as it is drawn.
	*/
	const real_tool_request = function(options) {
		if (options && options.action==='get_elevation') {
			return Promise.resolve({ok: true, data: {elevation: null, unavailable: true}})
		}
		return tool_uca_maps.prototype.tool_request.call(tool, options)
	}

	// `tool` is rebuilt for every test, so a stub needs no restore
	const stub_tool_request = function(answer) {
		tool.tool_request = answer
	}

	/** The one layer of a seeded FeatureGroup (seeded_lib_data). */
	const seeded_layer = (layer_id) => geolocation.FeatureGroup[layer_id].getLayers()[0]

	const active_group = () => geolocation.FeatureGroup[geolocation.active_layer_id]

	/** Attaches the console and selects a seeded layer through its real popup. */
	const open_console_on = function(layer_id) {
		tool.attach_console()
		const layer = seeded_layer(layer_id)
		layer.openPopup()
		return layer
	}

	// a hand-built carrier has no popup: fire the selection the console listens
	// to (its popupopen handler reads popup._source and nothing else)
	const select_carrier = function(carrier) {
		geolocation.map.fire('popupopen', {popup: {_source: carrier}})
	}

	// what edit() reads of a tool that went through init()
	const run_edit = function() {
		tool.type		= 'tool'
		tool.mode		= 'edit'
		tool.context	= { label: 'Mapas UCA' }
		return tool.edit({})
	}

	/**
	* The four requests of one linked-image import: stage (server download),
	* mint, ingest, where it is served. `stage` answers per url; the rest
	* succeed. `restore()` puts data_manager back, which outlives the test.
	*/
	const stub_linked_import = function(stage, ingest) {
		const original_request = data_manager.request
		const seen = {stages: [], created: 0, released: []}
		let next_id = 9100
		data_manager.request = async function(options) {
			const body = options && options.body
			if (body && body.action==='tool_request' && body.source && body.source.action==='stage_external_image') {
				seen.stages.push({options: body.options, timeout: options.timeout})
				return stage(body.options.url)
			}
			if (body && body.action==='create') {
				seen.created++
				return {ok: true, data: next_id++}
			}
			if (body && body.action==='tool_request' && body.source && body.source.action==='process_uploaded_file') {
				return ingest ? ingest(body.options.file_data.tmp_name) : {ok: true, data: true}
			}
			if (body && body.action==='delete') {
				return {ok: true, data: [body.source.section_id]}
			}
			if (body && body.action==='delete_uploaded_file') {
				seen.released.push(body.options)
				return {ok: true, data: true}
			}
			return original_request.apply(this, arguments)
		}
		stub_tool_request(async function(options) {
			if (options.action==='get_image_file') {
				return {ok: true, data: {file_path: '/image/1.5MB/' + options.options.section_id + '.jpg', quality: '1.5MB'}}
			}
			return real_tool_request(options)
		})
		seen.restore = function() {
			data_manager.request = original_request
		}
		return seen
	}

	/** Every URL dom-to-image-more asks for while `capture` runs (it fetches by XHR). */
	const xhr_urls_during = async function(capture) {
		const requested		= []
		const original_open	= XMLHttpRequest.prototype.open
		XMLHttpRequest.prototype.open = function(method, url, ...rest) {
			requested.push(String(url))
			return original_open.call(this, method, url, ...rest)
		}
		try {
			await capture()
		} finally {
			XMLHttpRequest.prototype.open = original_open
		}
		return requested
	}//end xhr_urls_during

	/** What a real PNG download asks for: none at all would make a clean list prove nothing. */
	const capture_png_requests = async function() {
		let blob
		const requested = await xhr_urls_during(async () => {
			blob = (await capture_download(() => download_map_image(tool, 'png'))).blob
		})
		assert.isOk(blob, 'expected the capture to finish')
		assert.isAbove(requested.length, 0, 'expected the capture to fetch by XHR at all')
		return requested
	}//end capture_png_requests

	/** The same map with both of download_map_image's guards open: the control a clean list needs. */
	const capture_unguarded_requests = function() {
		return xhr_urls_during(() => domtoimage.toBlob(geolocation.map.getContainer(), {filter: () => true, filterUrls: () => true}))
	}//end capture_unguarded_requests

	/** A saved image's carrier rectangle, in the active FeatureGroup. */
	const add_image_carrier = function() {
		const carrier = L.rectangle([[40.44, -3.66], [40.46, -3.64]], {opacity: 0, fillOpacity: 0})
		carrier.feature = carrier.toGeoJSON()
		// the same two properties create_image_object writes in production
		carrier.feature.properties.uca_maps = {
			image		: image_descriptor(),
			is_raster	: true
		}
		active_group().addLayer(carrier)
		return carrier
	}

	// the overlay plugin loads on demand (classic <script>): the overlay appears asynchronously
	const await_overlay = (carrier) => until(() => carrier._uca_maps_overlay)

	const add_image_carrier_with_overlay = async function() {
		const carrier = add_image_carrier()
		tool.attach_image_overlays()
		await await_overlay(carrier)
		return carrier
	}

	const arm_catastro = function() {
		geolocation.section_lang = 'lg-spa' // Catastro exists only for es/cat/eus
		tool.attach_catastro()
		tool.catastro_control.getContainer().click()
	}

	// the install's answer is stubbed: no test reaches Pleiades, Pelagios or DARE
	const mount_roman = function(gazetteers = null) {
		tool.get_capabilities = async () => ({ ok: true, data: { gazetteers: structuredClone(gazetteers) } })
		tool.attach_roman_empire()
	}

	const open_roman = () => geolocation.map.getContainer().querySelector('.uca-maps-roman-control').click()

	// called AFTER opening the panel: opening resets it
	const seed_roman_list = function(source, results) {
		tool._roman_results	= results
		tool._roman_source	= source
		populate_roman_results(tool, tool.roman_panel)
	}



	it('attach_console adds exactly one control and one hidden panel, idempotently', function() {

		tool.attach_console()
		tool.attach_console() // second call: must be a no-op, never a duplicate

		const controls = geolocation.map.getContainer().querySelectorAll('.uca-maps-control')
		assert.equal(controls.length, 1, 'expected exactly one map control')
		assert.isOk(tool.panel_node, 'expected panel_node built')
		assert.equal(tool.panel_node.hidden, true, 'expected panel hidden by default')
		assert.equal(
			geolocation.map.getContainer().contains(tool.panel_node), true,
			'expected the panel appended to the map\'s own DOM container'
		)
	})

	it('the control toggles panel visibility (Show/Hide)', function() {

		tool.attach_console()
		const control = geolocation.map.getContainer().querySelector('.uca-maps-control')

		control.click()
		assert.equal(tool.panel_node.hidden, false, 'expected panel shown after one click')

		control.click()
		assert.equal(tool.panel_node.hidden, true, 'expected panel hidden again after a second click')
	})


	// the elevation is asked, never stored: v6 saves `center_elevation` on
	// every click, which dirties a record the user only looked at
	it('layer_center is a marker\'s own position and any other geometry\'s bounds centre', function() {

		const marker	= seeded_layer(3)
		const polygon	= seeded_layer(1)

		const marker_center = layer_center(marker)
		assert.closeTo(marker_center.lat, 40.42, 0.0001, 'expected the marker\'s own latitude')
		assert.closeTo(marker_center.lng, -3.68, 0.0001, 'expected the marker\'s own longitude')

		const polygon_center = layer_center(polygon)
		assert.closeTo(polygon_center.lat, 40.45, 0.0001, 'expected the polygon bounds centre latitude')
		assert.closeTo(polygon_center.lng, -3.655, 0.0001, 'expected the polygon bounds centre longitude')

		assert.equal(layer_center(null), null, 'expected null for no layer')
		assert.equal(layer_center({}), null, 'expected null for something with no position at all')
	})

	it('fetch_elevation asks about the centre and never writes it into the feature', async function() {

		const layer = seeded_layer(1)

		let asked = null
		stub_tool_request(async function(options) {
			asked = options
			return { ok:true, data:{ elevation: 412, unavailable:false } }
		})

		const result = await fetch_elevation(tool, layer)

		assert.equal(asked.action, 'get_elevation', 'expected the get_elevation action')
		assert.closeTo(asked.options.lat, 40.45, 0.0001, 'expected the bounds centre latitude')
		assert.closeTo(asked.options.lon, -3.655, 0.0001, 'expected the bounds centre longitude, under the key the server reads')
		assert.equal(result.elevation, 412, 'expected the reported elevation')
		assert.equal(result.unavailable, false, 'expected an available verdict')

		// v6 does `layer.feature.properties.center_elevation = ...; save_object()`
		const properties = (layer.feature && layer.feature.properties) || {}
		assert.isUndefined(properties.center_elevation, 'expected NOTHING written into the feature')
	})

	it('fetch_elevation keeps an answer with no elevation, and degrades a throw to unavailable', async function() {

		const layer = seeded_layer(1)

		let calls = 0
		stub_tool_request(async function() {
			calls++
			return { ok:true, data:{ elevation: null, unavailable:true } }
		})

		const degraded = await fetch_elevation(tool, layer)
		assert.equal(degraded.elevation, null, 'expected no elevation')
		assert.equal(degraded.unavailable, true, 'expected the degraded verdict')
		await fetch_elevation(tool, layer)
		assert.equal(calls, 1, 'expected "no elevation here" kept as an answer, not asked again')

		// emptied, or the cached answer above would serve the call and the stub never throw
		tool._elevation = null
		stub_tool_request(async function() { throw new Error('network down') })
		const thrown = await fetch_elevation(tool, layer)
		assert.equal(thrown.unavailable, true, 'expected an unexpected throw to degrade, not to propagate')
	})

	// every commit() re-renders the console, so renders arrive faster than the
	// third-party answer: caching only the ANSWER let each of them send its own
	it('fetch_elevation sends one request for renders that arrive before the answer; a failure is asked again', async function() {

		const layer = seeded_layer(1)

		let calls = 0
		let release = null
		const answer = new Promise(function(resolve) { release = resolve })
		stub_tool_request(async function() {
			calls++
			await answer
			return { ok:true, data:{ elevation: 412, unavailable:false } }
		})
		const burst = [fetch_elevation(tool, layer), fetch_elevation(tool, layer), fetch_elevation(tool, layer)]
		assert.equal(calls, 1, 'expected ONE request while the first is still in flight')
		release()
		const results = await Promise.all(burst)
		assert.deepEqual(results.map(result => result.elevation), [412, 412, 412], 'expected every render to get the answer')
		assert.equal(tool._elevation.elevation, 412, 'expected the answer kept for the PDF export')

		await fetch_elevation(tool, layer)
		assert.equal(calls, 1, 'expected the answered centre not to be asked again')

		// a refusal and a throw are not answers: neither may stick
		const refusal = {is_api_error: true, code: 'request.invalid_options', message: 'x', transport: false}
		for (const failing of [
			async function() { calls++; return {ok: false, error: refusal} },
			async function() { calls++; throw new Error('network down') }
		]) {
			tool._elevation	= null
			calls			= 0
			stub_tool_request(failing)
			await fetch_elevation(tool, layer)
			await fetch_elevation(tool, layer)
			assert.equal(calls, 2, 'expected a failed request to be asked again on the next render')
			assert.isNull(tool._elevation, 'expected no cache entry left by a failure')
		}
	})

	it('a failure still in flight for one object never clears the answer cached for the next', async function() {

		const first		= seeded_layer(1)
		const second	= seeded_layer(3)

		const asked		= {first: 0, second: 0}
		let release		= null
		const refusal	= {is_api_error: true, code: 'request.invalid_options', message: 'x', transport: false}
		stub_tool_request(async function(options) {
			if (Math.abs(options.options.lat - layer_center(first).lat) < 1e-9) {
				asked.first++
				await new Promise(function(resolve) { release = resolve })
				return {ok: false, error: refusal}
			}
			asked.second++
			return { ok:true, data:{ elevation: 7, unavailable:false } }
		})

		const pending = fetch_elevation(tool, first)
		assert.equal((await fetch_elevation(tool, second)).elevation, 7, 'expected the second object answered')
		release()
		await pending

		assert.strictEqual(tool._elevation && tool._elevation.layer, second, 'expected the second object\'s entry still cached')
		assert.equal(tool._elevation.elevation, 7, 'expected its elevation kept for the PDF export')
		await fetch_elevation(tool, second)
		assert.deepEqual(asked, {first: 1, second: 1}, 'expected the second object not asked again')
	})


	// an associated image is stored as a media-relative path (v6 stores an
	// absolute URL, which breaks on a host change), and the PDF export sends
	// record identities, never a path

	/** What `fn` sent by any door: data_manager, an XHR (service_upload) or fetch. */
	const requests_sent_by = async function(fn) {
		const sent				= []
		const original_request	= data_manager.request
		const original_open		= XMLHttpRequest.prototype.open
		const original_fetch	= window.fetch
		data_manager.request = function(options) {
			sent.push('data_manager ' + JSON.stringify(options && options.body && options.body.action))
			return original_request.apply(this, arguments)
		}
		XMLHttpRequest.prototype.open = function(method, url) {
			sent.push('xhr ' + url)
			return original_open.apply(this, arguments)
		}
		window.fetch = function(input) {
			sent.push('fetch ' + ((input && input.url) || input))
			return original_fetch.apply(this, arguments)
		}
		try {
			return {result: await fn(), sent: sent}
		} finally {
			data_manager.request			= original_request
			XMLHttpRequest.prototype.open	= original_open
			window.fetch					= original_fetch
		}
	}

	it('associate_image refuses with no file and never reaches the server', async function() {

		const layer = seeded_layer(1)
		tool.active_console_layer = layer

		let asked = false
		stub_tool_request(async function() { asked = true; return {} })

		const {result, sent} = await requests_sent_by(() => associate_image(tool, layer, null))

		assert.deepEqual(result, {ok: false, error: 'Please choose a file first.'}, 'expected the no-file sentence for the panel')
		assert.equal(asked, false, 'expected NO tool request without a file')
		assert.deepEqual(sent, [], 'expected NO request of any kind without a file')
		assert.deepEqual(object_images(layer), [], 'expected nothing stored')
	})

	it('associate_image refuses at v6\'s cap of 30 images before uploading anything', async function() {

		// v6's own number (special_tools.js create_pdf: "Max. 30")
		assert.equal(MAX_OBJECT_IMAGES, 30, 'expected v6\'s cap')
		const layer = seeded_layer(1)
		tool.active_console_layer = layer
		layer.feature.properties.uca_maps = full_gallery()

		let asked = false
		stub_tool_request(async function() { asked = true; return {} })

		const {result, sent} = await requests_sent_by(() => associate_image(tool, layer, new File(['x'], 'x.jpg', {type:'image/jpeg'})))

		assert.deepEqual(result, {ok: false, error: 'This object already holds the maximum number of images.'}, 'expected the cap sentence')
		assert.equal(asked, false, 'expected the cap checked BEFORE any tool request')
		assert.deepEqual(sent, [], 'expected the cap checked BEFORE the upload')
		assert.equal(object_images(layer).length, MAX_OBJECT_IMAGES, 'expected nothing added')
	})

	it('object_images / object_image_url read the stored descriptors', function() {

		const layer = seeded_layer(1)
		assert.deepEqual(object_images(layer), [], 'expected no images on a fresh object')
		assert.deepEqual(object_images(null), [], 'expected an array, never null')

		layer.feature.properties.uca_maps = { images: [
			{ file_path:'/image/1.5MB/test99_test3_88.jpg', section_tipo:'test3', section_id:88, tipo:'test99', name:'a.jpg' }
		] }

		assert.equal(object_images(layer).length, 1, 'expected the stored image')

		assert.equal(
			object_image_url(object_images(layer)[0]), DEDALO_MEDIA_URL + '/image/1.5MB/test99_test3_88.jpg',
			'expected the stored RELATIVE path resolved against the media url'
		)
		assert.equal(object_image_url({}), null, 'expected null for a descriptor with no path')
	})

	it('remove_object_image drops the association and refuses an out-of-range index', function() {

		tool.attach_console()
		const layer = seeded_layer(1)
		layer.feature.properties.uca_maps = { images: [
			{ file_path:'/a.jpg', section_tipo:'test3', section_id:1, tipo:'test99', name:'a' },
			{ file_path:'/b.jpg', section_tipo:'test3', section_id:2, tipo:'test99', name:'b' }
		] }

		assert.equal(remove_object_image(tool, layer, 5), false, 'expected a refusal past the end')
		assert.equal(remove_object_image(tool, layer, -1), false, 'expected a refusal below zero')
		assert.equal(object_images(layer).length, 2, 'expected nothing removed by a bad index')

		assert.equal(remove_object_image(tool, layer, 0), true, 'expected the first image removed')
		assert.equal(object_images(layer).length, 1, 'expected one left')
		assert.equal(object_images(layer)[0].name, 'b', 'expected the RIGHT one left')
	})

	/**
	* LINKED IMAGES (v6 `check_if_external_images`): an object's
	* `properties.images[]` entries that only carry a url are downloaded by the
	* server on the user's gesture, ingested like a picked file and MOVED into
	* the object's own images. A failed link stays, with its reason.
	*/
	it('linked_images picks only links with no Dédalo record, v6\'s own test', function() {

		const layer = seeded_layer(1)
		const link = {url: 'https://images.example/a.jpg'}
		layer.feature.properties.images = [
			link,
			{url: 'https://images.example/b.jpg', section_tipo: 'test3', section_id: 4, tipo: 'test99'},
			{url: '   '},
			{title: 'no url'},
			null,
			'https://images.example/c.jpg'
		]
		assert.deepEqual(linked_images(layer), [link], 'expected only the url entry with no record')
		layer.feature.properties.images = 'not a list'
		assert.deepEqual(linked_images(layer), [], 'expected nothing from a non-array')
		assert.deepEqual(linked_images(null), [], 'expected an array, never null')
	})

	it('external_images_enabled asks the install once, and a failed answer is off', async function() {

		let calls = 0
		tool._external_images_enabled = null
		tool.get_capabilities = async function() { calls++; return {ok: true, data: {externalImages: true}} }
		assert.equal(await external_images_enabled(tool), true, 'expected the install answer')
		assert.equal(await external_images_enabled(tool), true, 'expected the same answer again')
		assert.equal(calls, 1, 'expected ONE capabilities request per tool instance')

		tool._external_images_enabled = null
		tool.get_capabilities = async function() { throw new Error('network down') }
		assert.equal(await external_images_enabled(tool), false, 'expected a throw to read as off')

		tool._external_images_enabled = null
		tool.get_capabilities = async function() { return {ok: false, error: {is_api_error: true, code: 'perm.denied', message: 'x', transport: false}} }
		assert.equal(await external_images_enabled(tool), false, 'expected a refusal to read as off')
	})

	it('import_linked_images moves what it imports, keeps a failed link and says why', async function() {

		const layer = seeded_layer(1)
		tool.active_console_layer = layer
		const good		= {url: 'https://images.example/good.jpg'}
		const refused	= {url: 'https://images.example/refused.jpg'}
		const recorded	= {url: 'https://images.example/kept.jpg', section_tipo: 'test3', section_id: 4, tipo: 'test99'}
		layer.feature.properties.images = [good, refused, recorded]
		layer.feature.properties.uca_maps = {}

		const seen = stub_linked_import(function(url) {
			return url===good.url
				? staged_answer('good.jpg')
				: {ok: false, error: {is_api_error: true, code: 'harvest.robots_disallowed', message: 'The site does not allow it', transport: false}}
		})
		const progress = []
		try {
			const result = await import_linked_images(tool, layer, (done, total) => progress.push([done, total]))

			assert.equal(result.ok, false, 'expected a partial import to say so')
			assert.equal(result.imported, 1, 'expected one imported')
			assert.equal(result.failures.length, 1, 'expected one failure')
			assert.equal(result.failures[0].url, refused.url, 'expected the failure to name its link')
			assert.include(result.failures[0].error, 'The site does not allow it', 'expected the server reason shown')
			assert.deepEqual(progress, [[0, 2], [1, 2]], 'expected progress per link')

			assert.equal(seen.stages[0].options.url, good.url, 'expected the link itself sent')
			assert.equal(seen.stages[0].options.section_id, geolocation.section_id, 'expected the MAP record named for the write gate')
			assert.isAbove(seen.stages[0].timeout, 5000, 'expected a timeout past data_manager\'s 5 s default')

			assert.deepEqual(layer.feature.properties.images, [refused, recorded], 'expected the imported link moved out, the rest untouched')
			const images = object_images(layer)
			assert.equal(images.length, 1, 'expected the image hung off the object')
			assert.equal(images[0].source_url, good.url, 'expected where it came from kept')
			assert.equal(images[0].section_tipo, IMAGE_SECTION_TIPO, 'expected a Dédalo record behind it')
			assert.isUndefined(images[0].url, 'expected no absolute url stored')
			assert.isTrue(images[0].file_path.startsWith('/'), 'expected a media-root-relative path, no scheme or host')
		} finally {
			seen.restore()
		}
	})

	// a download the ingest refused before moving it is released; one whose
	// outcome is unknown is not (the server may still be consuming it)
	it('import_linked_images releases a staged download only when the ingest certainly left it', async function() {

		const layer = seeded_layer(1)
		tool.active_console_layer = layer
		const refused	= {url: 'https://images.example/refused.jpg'}
		const unknown	= {url: 'https://images.example/unknown.jpg'}
		layer.feature.properties.images = [refused, unknown]
		layer.feature.properties.uca_maps = {}

		const seen = stub_linked_import(
			url => staged_answer(url===refused.url ? 'refused.jpg' : 'unknown.jpg'),
			tmp_name => ({ok: false, error: tmp_name==='refused.jpg'
				? {is_api_error: true, code: 'media.upload_rejected', message: 'x', transport: false}
				: {is_api_error: true, code: 'internal.unexpected', message: 'x', transport: false}})
		)
		try {
			const result = await import_linked_images(tool, layer)
			assert.equal(result.failures.length, 2, 'expected both links reported')
			assert.deepEqual(seen.released, [{key_dir: 'image', file_name: 'refused.jpg'}],
				'expected only the pre-move refusal released, by its staged name')
			assert.deepEqual(layer.feature.properties.images, [refused, unknown], 'expected both links kept')
			assert.deepEqual(object_images(layer), [], 'expected nothing hung off the object')
		} finally {
			seen.restore()
		}
	})

	// an import that brings anything in commits, and the commit re-renders the
	// console: the failures must survive into the panel that replaces it
	it('a partial import still lists its failed links in the re-rendered panel', async function() {

		tool.attach_console()
		const layer = seeded_layer(1)
		const good		= {url: 'https://images.example/good.jpg'}
		const refused	= {url: 'https://images.example/refused.jpg'}
		layer.feature.properties.images = [good, refused]
		layer.feature.properties.uca_maps = {}

		const seen = stub_linked_import(function(url) {
			return url===good.url
				? staged_answer('good.jpg')
				: {ok: false, error: {is_api_error: true, code: 'harvest.robots_disallowed', message: 'x', transport: false}}
		})
		tool.external_images_enabled = async () => true
		try {
			layer.openPopup()
			await tick()
			const before = tool.panel_node.querySelector('.uca-maps-object-linked-import')
			assert.isOk(before, 'expected the import button')

			before.click()
			await until(() => !before.isConnected, 100, 0)
			assert.isFalse(before.isConnected, 'expected the commit to re-render the console')
			await tick()

			const lines = [...tool.panel_node.querySelectorAll('.uca-maps-object-linked-failure')]
			assert.equal(lines.length, 1, 'expected the failed link listed in the new panel')
			assert.include(lines[0].textContent, refused.url, 'expected the failure to name its link')
			assert.include(tool.panel_node.querySelector('.uca-maps-object-linked-import').textContent, '1',
				'expected the button offering the one link left')
		} finally {
			seen.restore()
		}
	})

	it('import_linked_images drops the emptied images list, and asks nothing at the cap', async function() {

		const layer = seeded_layer(1)
		tool.active_console_layer = layer
		layer.feature.properties.images = [{url: 'https://images.example/a.jpg'}]
		layer.feature.properties.uca_maps = {}

		let seen = stub_linked_import(() => staged_answer('a.jpg'))
		try {
			const result = await import_linked_images(tool, layer)
			assert.equal(result.ok, true, 'expected a clean import')
			assert.isUndefined(layer.feature.properties.images, 'expected no empty images list left behind')
		} finally {
			seen.restore()
		}

		layer.feature.properties.images = [{url: 'https://images.example/b.jpg'}]
		layer.feature.properties.uca_maps = full_gallery()
		seen = stub_linked_import(() => staged_answer('b.jpg'))
		try {
			const result = await import_linked_images(tool, layer)
			assert.equal(result.imported, 0, 'expected nothing imported at the cap')
			assert.equal(result.failures.length, 1, 'expected the link reported, not dropped')
			assert.equal(seen.stages.length, 0, 'expected NO download at the cap')
			assert.equal(seen.created, 0, 'expected NO record minted at the cap')
			assert.equal(layer.feature.properties.images.length, 1, 'expected the link kept')
		} finally {
			seen.restore()
		}
	})

	it('the import button shows only when the install allows it and there is something to import', async function() {

		tool.attach_console()
		const layer = seeded_layer(1)
		layer.feature.properties.images = [{url: 'https://images.example/a.jpg'}, {url: 'https://images.example/b.jpg'}]

		const button = () => tool.panel_node.querySelector('.uca-maps-object-linked-import')
		tool.external_images_enabled = async () => false
		layer.openPopup()
		await tick()
		assert.isNull(button(), 'expected no button when the install has it off')

		tool.external_images_enabled = async () => true
		layer.closePopup()
		layer.openPopup()
		await tick()
		assert.isOk(button(), 'expected the button when on and the object links images')
		assert.include(button().textContent, '2', 'expected the count of linked images')

		let asked = null
		tool.import_linked_images = async function(asked_layer) {
			asked = asked_layer
			return {ok: true, imported: 0, failures: [], still_shown: true}
		}
		button().click()
		await tick()
		assert.equal(asked, layer, 'expected the click to import this object\'s links')
	})

	it('download_object_pdf sends record identities and NEVER a file path', async function() {

		tool.attach_console()
		const layer = seeded_layer(1)
		layer.feature.properties.uca_maps = { images: [
			{ file_path:'/image/1.5MB/a.jpg', section_tipo:IMAGE_SECTION_TIPO, section_id:88, tipo:IMAGE_COMPONENT_TIPO, name:'a.jpg' }
		] }

		let asked = null
		stub_tool_request(async function(options) {
			asked = options
			// a real, minimal PDF so the blob path runs for real
			return { ok:true, data:{
				content_base64	: btoa('%PDF-1.4\n%%EOF\n'),
				filename		: 'uca_maps_object.pdf',
				mime			: 'application/pdf'
			} }
		})

		await download_object_pdf(tool, layer)

		assert.equal(asked.action, 'object_pdf_report', 'expected the pdf action')
		assert.isOk(asked.options.geojson, 'expected the object as geojson')
		assert.equal(asked.options.images.length, 1, 'expected the associated image listed')

		const sent = asked.options.images[0]
		assert.equal(sent.section_tipo, IMAGE_SECTION_TIPO, 'expected the record section')
		assert.equal(sent.tipo, IMAGE_COMPONENT_TIPO, 'expected the record component')
		assert.equal(sent.section_id, 88, 'expected the record id')
		assert.isUndefined(sent.file_path, 'expected NO file path sent — the server re-resolves it under its own gate')
		assert.isUndefined(sent.url, 'expected no url sent either')
	})

	// the page toast names the code ("Invalid request options"), never the
	// reason: the download's own line is where the reason reaches the user
	it('a refused download answers the section\'s lead and the server\'s reason, not only a toast', async function() {

		const layer		= seeded_layer(1)
		const refusal	= {is_api_error: true, code: 'request.invalid_options', message: 'The object could not be read.', transport: false}

		stub_tool_request(async function() {
			return {ok: false, error: refusal}
		})
		const rows = [
			{label: 'vector', run: () => download_vector(tool, layer, 'shp'), lead: 'The object could not be downloaded.'},
			{label: 'pdf', run: () => download_object_pdf(tool, layer), lead: 'The PDF could not be created.'},
			{label: 'map image', run: () => download_map_image(tool, 'jpg'), lead: 'The map image could not be downloaded.'}
		]
		for (const row of rows) {
			assert.deepEqual(await row.run(), {ok: false, error: row.lead + '\n' + refusal.message}, row.label)
		}

		// an answer without an envelope error still says what failed
		stub_tool_request(async function() {
			return {ok: false}
		})
		assert.deepEqual(await download_vector(tool, layer, 'kml'), {ok: false, error: 'The object could not be downloaded.'})
	})

	/**
	* Two attempts in flight could answer out of order: a slow refusal would
	* land under a later download that worked. The button is busy until its
	* answer is in.
	*/
	it('each download button shows its failure on its own line, asks once at a time, and the next attempt clears it', async function() {

		tool.attach_console()
		tool.attach_map_image_download_control()
		const layer = seeded_layer(1)

		const calls		= {}
		let answer		= null
		for (const name of ['download_vector', 'download_object_pdf', 'download_image', 'download_map_image']) {
			tool[name] = function() {
				calls[name] = (calls[name] || 0) + 1
				return new Promise(resolve => { answer = resolve })
			}
		}
		const object_section = () => tool.panel_node.querySelector('.uca-maps-object-section')

		const rows = [
			{
				label	: 'vector', name: 'download_vector', open: () => layer.openPopup(),
				box		: () => object_section().querySelector('.uca-maps-download-section'),
				button	: '.uca-maps-download-button', line: '.uca-maps-download-message'
			},
			{
				label	: 'pdf', name: 'download_object_pdf', open: () => layer.openPopup(),
				box		: () => object_section().querySelector('.uca-maps-properties-editor'),
				button	: '.uca-maps-property-pdf-button', line: '.uca-maps-download-message'
			},
			{
				label	: 'image', name: 'download_image',
				open	: () => select_carrier(add_image_carrier()),
				box		: () => tool.panel_node.querySelector('.uca-maps-image-download-section'),
				button	: '.uca-maps-image-download-button', line: '.uca-maps-download-message'
			},
			{
				label	: 'map image', name: 'download_map_image', open: () => {},
				box		: () => tool.map_image_panel,
				button	: '.uca-maps-map-image-button', line: '.uca-maps-map-image-message'
			}
		]
		for (const row of rows) {
			row.open()
			const box		= row.box()
			const line		= box.querySelector(row.line)
			const button	= box.querySelector(row.button)
			assert.isOk(line, 'expected a failure line: ' + row.label)
			assert.isTrue(line.hidden, 'expected no line before any attempt: ' + row.label)

			button.click()
			assert.isTrue(button.disabled, 'expected the button busy while it asks: ' + row.label)
			button.click()
			assert.equal(calls[row.name], 1, 'expected a click in flight to ask nothing more: ' + row.label)

			answer({ok: false, error: 'LEAD\nREASON'})
			await tick()
			assert.isFalse(button.disabled, 'expected the button free once answered: ' + row.label)
			assert.isFalse(line.hidden, 'expected the failure shown: ' + row.label)
			assert.equal(line.textContent, 'LEAD\nREASON', row.label)

			button.click()
			assert.isTrue(line.hidden, 'expected the next attempt to clear it: ' + row.label)
			answer({ok: true})
			await tick()
			assert.isTrue(line.hidden, 'expected no line after a download that worked: ' + row.label)
		}
	})

	it('a download that throws in the browser answers its lead and the exception, and keeps the page toast', async function() {

		const layer		= seeded_layer(1)
		const carrier	= add_image_carrier()

		// no envelope ever reached data_manager, so nothing else toasts it
		const toasts	= []
		const token		= event_manager.subscribe('api_error', (error) => toasts.push(error))
		stub_tool_request(async function() {
			throw new Error('Boom.')
		})
		const restore_image_download = stub_image_download(async () => { throw new Error('Boom.') })
		try {
			const rows = [
				{label: 'vector', run: () => download_vector(tool, layer, 'shp'), lead: 'The object could not be downloaded.'},
				{label: 'pdf', run: () => download_object_pdf(tool, layer), lead: 'The PDF could not be created.'},
				{label: 'image', run: () => tool.download_image(carrier, 'png', 0.8, 'plan'), lead: 'The image could not be downloaded.'},
				{label: 'map image', run: () => download_map_image(tool, 'jpg'), lead: 'The map image could not be downloaded.'}
			]
			for (const row of rows) {
				assert.deepEqual(await row.run(), {ok: false, error: row.lead + '\nBoom.'}, row.label)
			}
			assert.equal(toasts.length, rows.length, 'expected one page toast per throw')
			for (const toast of toasts) {
				assert.equal(toast.code, 'client.tool_uca_maps_failed', 'expected the client-origin code')
				assert.equal(toast.message, 'Boom.', 'expected the exception named in the toast')
				assert.strictEqual(toast.transport, false, 'expected a throw not read as a network failure')
				assert.equal(resolve_error_policy(toast).action, 'toast', 'expected the page policy to toast it')
			}
		} finally {
			event_manager.unsubscribe(token)
			restore_image_download()
		}
	})

	it('find_layer_id resolves the FeatureGroup that owns a layer', function() {

		const feature_group = geolocation.FeatureGroup[1]
		assert.isOk(feature_group, 'expected FeatureGroup[1] loaded from the seeded lib_data')
		const layers = feature_group.getLayers()
		assert.equal(layers.length, 1, 'expected the one seeded polygon layer')

		assert.equal(find_layer_id(tool, layers[0]), 1, 'expected find_layer_id to resolve layer_id 1')
		assert.equal(find_layer_id(tool, {}), null, 'expected null for a layer owned by no FeatureGroup')
	})

	it('the object kind heading and DARE\'s "all" options speak the user\'s language', function() {

		const spanish = {
			geometry_polygon			: 'Polígono',
			geometry_circle				: 'Círculo',
			geometry_marker				: 'Marcador',
			geometry_polyline			: 'Línea',
			geometry_object				: 'Objeto',
			roman_dare_all_types		: 'Todos los tipos',
			roman_dare_all_countries	: 'Todos los países'
		}
		tool.get_tool_label = (key) => spanish[key]

		tool.attach_console()
		const heading = () => tool.panel_node.querySelector('.uca-maps-object-section .uca-maps-object-type').textContent
		for (const [layer_id, expected] of [[1, 'Polígono'], [2, 'Círculo'], [3, 'Marcador']]) {
			seeded_layer(layer_id).openPopup()
			assert.equal(heading(), expected, 'expected the translated kind of layer ' + layer_id)
		}
		const line = L.polyline([[40.41, -3.70], [40.43, -3.66]])
		active_group().addLayer(line)
		line.bindPopup('line').openPopup()
		assert.equal(heading(), 'Línea', 'expected the translated kind of a line')
		// no drawing tool makes one today, but a kind the console does not
		// classify still heads as an object, translated, never blank
		const unknown = L.circleMarker([40.42, -3.68])
		active_group().addLayer(unknown)
		unknown.bindPopup('unknown').openPopup()
		assert.equal(heading(), 'Objeto', 'expected the translated fallback kind of an unclassified layer')

		mount_roman()
		const first_option = (selector) => tool.roman_panel.querySelector(selector).options[0]
		for (const [selector, expected] of [['.uca-maps-roman-dare-type', 'Todos los tipos'], ['.uca-maps-roman-dare-country', 'Todos los países']]) {
			assert.equal(first_option(selector).value, '', 'expected the "all" option first, with no value: ' + selector)
			assert.equal(first_option(selector).textContent, expected, 'expected it translated: ' + selector)
			assert.isFalse(Array.from(tool.roman_panel.querySelector(selector).options).slice(1).some((option) => option.value===''), 'expected one "all" option only: ' + selector)
		}
	})

	// selecting is not opening, as in v6: opening would also shut, through
	// toolbar.js's one-panel-at-a-time rule, whatever panel the user had open
	it('opening a drawn layer\'s popup selects it in the console WITHOUT opening the panel', function() {

		const layer = open_console_on(1)

		assert.strictEqual(tool.active_console_layer, layer, 'expected the clicked layer selected')
		assert.equal(tool.panel_node.hidden, true, 'expected the panel to stay closed when a geometry is selected')
		assert.isOk(
			tool.panel_node.querySelector('.uca-maps-object-section').textContent.includes('Polygon'),
			'expected the object section to name the geometry type'
		)

		// and the content keeps tracking the selection while it IS open
		// (`map_control` is the L.Control; the clickable node is its container)
		geolocation.map.getContainer().querySelector('.uca-maps-control').click()
		assert.equal(tool.panel_node.hidden, false, 'expected the UCA button to open it')
		seeded_layer(3).openPopup()
		assert.equal(tool.panel_node.hidden, false, 'expected a selection not to close an open panel either')
	})

	it('on_close_actions keeps the console alive; on_geolocation_destroyed is the real teardown', async function() {

		tool.attach_console()
		assert.equal(
			geolocation.map.getContainer().querySelectorAll('.uca-maps-control').length, 1,
			'expected the control attached'
		)

		// the tool's own modal closing must NOT tear the console down (file header)
		tool.on_close_actions()
		assert.equal(
			geolocation.map.getContainer().querySelectorAll('.uca-maps-control').length, 1,
			'expected the control to survive on_close_actions'
		)
		assert.isOk(tool.geolocation, 'expected the geolocation reference to survive on_close_actions')
		assert.isOk(tool.panel_node, 'expected panel_node to survive on_close_actions')

		// component_geolocation itself being torn down IS the real teardown trigger
		const map_container_node = geolocation.map.getContainer()
		await tool.on_geolocation_destroyed()

		assert.equal(
			map_container_node.querySelectorAll('.uca-maps-control').length, 0,
			'expected the control removed by real teardown'
		)
		assert.equal(tool.geolocation, null, 'expected the geolocation reference cleared')
		assert.equal(tool.panel_node, null, 'expected panel_node cleared')
		assert.equal(tool.map_control, null, 'expected map_control cleared')
	})

	// core's spinner covers the load, so the modal closes at the first idle
	// tick, not after a fixed wait; it stays open only to say why there is no map
	const stub_modal = function() {
		const modal = {closed: 0, transient: false, close() { this.closed++ }}
		tool.node = {modal: modal}
		return modal
	}
	// past dd_request_idle_callback's own 1 s ceiling, short of the old 2 s wait
	const within_idle = function(modal) {
		const deadline = Date.now() + 1500
		return new Promise(function(resolve) {
			const poll = function() {
				if (modal.closed>0 || Date.now()>deadline) { resolve(); return }
				setTimeout(poll, 25)
			}
			poll()
		})
	}

	it('a ready map closes the modal at the first idle tick, with an empty body', async function() {

		const modal = stub_modal()
		const wrapper = await run_edit()
		await within_idle(modal)

		assert.equal(modal.closed, 1, 'expected the modal closed once, without a fixed wait')
		assert.isTrue(modal.transient, 'expected the unsaved-data guard skipped')
		assert.isNull(wrapper.querySelector('.map_status_container'), 'expected no status box on a ready map')
	})

	it('a map that never became ready keeps the modal open with its notice', async function() {

		tool.map_ready = false
		const modal = stub_modal()
		const wrapper = await run_edit()
		await within_idle(modal)

		assert.equal(modal.closed, 0, 'expected the modal left open to be read')
		const notice = wrapper.querySelector('.map_status_container .notice.notice_warning')
		assert.isOk(notice, 'expected the notice')
		// read after wait_for_map gave up: it says the map did not load, never "waiting"
		assert.equal(
			notice.textContent,
			tool.get_tool_label('map_not_ready') || 'The map did not finish loading. Close the tool and open it again with the map in view.',
			'expected the notice to say the map did not load and what to do'
		)
	})

	it('a tool with no map component keeps the modal open with its error', async function() {

		tool.geolocation = null
		const modal = stub_modal()
		try {
			const wrapper = await run_edit()
			await within_idle(modal)

			assert.equal(modal.closed, 0, 'expected the modal left open to be read')
			assert.isOk(wrapper.querySelector('.map_status_container .notice.notice_error'), 'expected the error notice')
		} finally {
			tool.geolocation = geolocation // afterEach tears down through it
		}
	})

	// core drops the map BEFORE it announces its destroy, so every detach_*
	// runs against a map that is already gone
	it('destroying the map component tears the tool down through its event, with the map already gone', async function() {

		await run_edit()
		assert.isOk(tool.map_control, 'precondition: edit() attached the console')

		let teardown = null
		const on_destroyed = tool.on_geolocation_destroyed
		tool.on_geolocation_destroyed = function() {
			teardown = on_destroyed.call(this)
			return teardown
		}

		await geolocation.destroy(true)
		assert.isNull(geolocation.map, 'precondition: the map is gone before the tool hears of it')
		assert.isOk(teardown, 'expected the component\'s destroy event to reach the tool')
		await teardown // a detach_* that needs the map rejects here

		assert.equal(tool.status, 'destroyed', 'expected the tool instance destroyed')
		assert.isNull(tool.geolocation, 'expected the geolocation reference cleared')
		for (const key of [
			'map_control', 'panel_node', 'map_image_control', 'object_viewer_control', 'onexone_control',
			'xyz_control', 'wms_control', 'catastro_control', 'ua_control', 'upload_control',
			'place_search_control', 'geolocate_control', 'scale_control', 'legend_control', 'roman_control',
			'_toolbar_bar'
		]) {
			assert.isNull(tool[key], 'expected ' + key + ' released')
		}
	})



	// OBJECT FUNCTIONS — object_console.js's exported mutations (style,
	// properties, download, centroid, uncertainty, hierarchy), called directly
	// on the seeded layers.

	it('set_style_field writes properties.uca_maps.style, applies it live and marks dirty; null or \'\' clears the field', function() {

		const layer = seeded_layer(1)
		const dirty = []
		geolocation.update_draw_data = (layer_id) => dirty.push(layer_id)

		set_style_field(tool, layer, 'fillColor', picked_colour())
		set_style_field(tool, layer, 'weight', 5)

		assert.deepEqual(layer.feature.properties.uca_maps.style, {fillColor: picked_colour(), weight: 5}, 'expected style written to properties.uca_maps')
		assert.equal(layer.options.fillColor, picked_colour(), 'expected setStyle applied live')
		assert.deepEqual(dirty, [1, 1], 'expected each change to mark its FeatureGroup dirty')

		set_style_field(tool, layer, 'fillColor', null)
		set_style_field(tool, layer, 'weight', '')
		assert.deepEqual(layer.feature.properties.uca_maps.style, {}, 'expected an empty value to clear the field, not store it')
		assert.deepEqual(dirty, [1, 1, 1, 1], 'expected a clear to mark dirty too')
	})

	it('set_property/delete_property CRUD custom properties; reserved and empty keys are refused', function() {

		const layer = seeded_layer(1)

		// the fields core and the tool manage: a property of the user's must never overwrite them
		assert.deepEqual(RESERVED_PROPERTY_KEYS, ['color', 'layer_id', 'uca_maps'], 'expected the managed fields reserved')

		assert.equal(set_property(tool, layer, ' custom_key ', 'custom_value'), true, 'expected a non-reserved key accepted')
		assert.equal(layer.feature.properties.custom_key, 'custom_value', 'expected the value written under the trimmed key')

		for (const reserved of RESERVED_PROPERTY_KEYS) {
			assert.equal(set_property(tool, layer, reserved, 'x'), false, 'expected reserved key "' + reserved + '" refused')
		}
		for (const empty of ['', '   ', null]) {
			assert.equal(set_property(tool, layer, empty, 'x'), false, 'expected the empty key ' + JSON.stringify(empty) + ' refused')
		}
		assert.notProperty(layer.feature.properties, '', 'expected nothing written under an empty key')

		layer.feature.properties.color = picked_colour()
		delete_property(tool, layer, 'color')
		assert.equal(layer.feature.properties.color, picked_colour(), 'expected a reserved field never deleted')

		delete_property(tool, layer, 'custom_key')
		assert.equal('custom_key' in layer.feature.properties, false, 'expected the property removed')

		// what is rewritten from THIS layer's geometry: neither typed over nor
		// deleted, the next render or update_draw_data would put it back
		assert.deepEqual(computed_property_keys(layer), ['area'], 'expected a polygon\'s area computed')
		assert.deepEqual(computed_property_keys(seeded_layer(2)), ['shape', 'radius', 'area'], 'expected a circle\'s shape, radius and area computed, in that order')
		assert.deepEqual(computed_property_keys(seeded_layer(3)), [], 'expected nothing computed on a marker')
		layer.feature.properties.area = '12.00 m²'
		assert.equal(set_property(tool, layer, 'area', '999 m²'), false, 'expected the computed key refused')
		delete_property(tool, layer, 'area')
		assert.equal(layer.feature.properties.area, '12.00 m²', 'expected the computed value never written nor deleted by hand')

		// where nothing computes it, `area` is the user's own key
		const marker = seeded_layer(3)
		assert.equal(set_property(tool, marker, 'area', 'about 2 ha'), true, 'expected "area" accepted on a marker')
		delete_property(tool, marker, 'area')
		assert.notProperty(marker.feature.properties, 'area', 'expected the marker\'s own "area" deletable')
	})

	// computed_property_keys repeats sync_measurements' branches: they must agree
	// on every geometry, or a key is locked that nothing rewrites (or the reverse)
	it('"area" is computed exactly where sync_measurements writes it, the 1x1 included', function() {

		tool.attach_console()
		const marker = seeded_layer(3)
		create_onexone_rectangle(tool, marker)
		const rectangle	= layer_by_uid(geolocation.FeatureGroup[3], marker.feature.properties.uca_maps.onexone_uid)
		const polyline	= L.polyline([[40.40, -3.71], [40.45, -3.65]]).addTo(geolocation.FeatureGroup[1])

		try {
			const measured = []
			for (const [label, layer] of [['polygon', seeded_layer(1)], ['circle', seeded_layer(2)], ['marker', marker], ['1x1', rectangle], ['polyline', polyline]]) {
				if (layer.feature && layer.feature.properties) {
					delete layer.feature.properties.area
				}
				tool.sync_measurements(layer)
				const written = Boolean(layer.feature && layer.feature.properties && 'area' in layer.feature.properties)
				assert.equal(computed_property_keys(layer).includes('area'), written, 'expected computed ⇔ written for the ' + label)
				if (written) {
					measured.push(label)
				}
			}
			assert.deepEqual(measured, ['polygon', 'circle'], 'expected the polygon and the circle measured, and nothing else')

			// v6 never measures a 1x1: its "area" is the user's own key
			assert.deepEqual(computed_property_keys(rectangle), [], 'expected nothing computed on a 1x1')
			assert.equal(set_property(tool, rectangle, 'area', 'about 1 m²'), true, 'expected "area" accepted on a 1x1')
			delete_property(tool, rectangle, 'area')
			assert.notProperty(rectangle.feature.properties, 'area', 'expected the 1x1\'s own "area" deletable')
		} finally {
			geolocation.FeatureGroup[1].removeLayer(polyline)
		}
	})

	it('download_vector(\'geojson\') stays 100% client-side and downloads the real GeoJSON', async function() {

		const layer = seeded_layer(1)
		stub_tool_request(async function() { throw new Error('expected no server round trip for GeoJSON') })

		const captured = await capture_download(async () => {
			assert.deepEqual(await download_vector(tool, layer, 'geojson'), {ok: true}, 'expected the download to succeed without the server')
		})
		const captured_blob = captured.blob

		assert.equal(captured.name, 'uca_maps_object.geojson', 'expected the GeoJSON file name')
		assert.isOk(captured_blob, 'expected download_vector to build a Blob')
		assert.equal(captured_blob.type, 'application/geo+json', 'expected the GeoJSON MIME type')

		const parsed = JSON.parse(await captured_blob.text())
		assert.equal(parsed.type, 'Feature', 'expected the serialized payload to be the layer\'s own GeoJSON Feature')
		assert.equal(parsed.geometry.type, 'Polygon', 'expected the seeded polygon\'s own geometry type')
	})

	// a real round trip through the suite server's ogr2ogr; a server without
	// GDAL answers tool.dependency_unavailable and the case is skipped, never passed
	const server_vector_rows = [
		{
			format	: 'shp',
			title	: 'download_vector(\'shp\') downloads a real zip from the server\'s ogr2ogr (skipped without GDAL)',
			mime	: 'application/zip',
			check	: async function(blob) {
				const bytes = new Uint8Array(await blob.arrayBuffer())
				// the ZIP local-file-header magic, 'PK\x03\x04'
				assert.deepEqual(Array.from(bytes.slice(0, 4)), [0x50, 0x4b, 0x03, 0x04], 'expected real ZIP magic bytes')
			}
		},
		{
			format	: 'kml',
			title	: 'download_vector(\'kml\') downloads real KML in lon/lat from the server\'s ogr2ogr (skipped without GDAL)',
			mime	: 'application/vnd.google-earth.kml+xml',
			check	: async function(blob) {
				const kml			= new DOMParser().parseFromString(await blob.text(), 'application/xml')
				const coordinates	= kml.getElementsByTagName('coordinates')[0]
				assert.isOk(coordinates, 'expected real KML with the polygon\'s coordinates')
				const pairs = coordinates.textContent.trim().split(/\s+/).map(tuple => tuple.split(',').map(Number))
				assert.isAtLeast(pairs.length, 4, 'expected the polygon ring')
				// the seeded polygon spans lon -3.71..-3.60, lat 40.40..40.50: KML is lon,lat in WGS84
				for (const [lon, lat] of pairs) {
					assert.isTrue(lon>=-3.711 && lon<=-3.599 && lat>=40.399 && lat<=40.501, 'expected a lon,lat vertex in WGS84, got ' + lon + ',' + lat)
				}
			}
		}
	]
	for (const row of server_vector_rows) {
		it(row.title, async function() {

			const layer = seeded_layer(1)
			let response = null
			stub_tool_request(async function(options) {
				response = await real_tool_request(options)
				return response
			})

			const captured_blob = (await capture_download(() => download_vector(tool, layer, row.format))).blob

			if (response && response.ok!==true) {
				assert.equal(
					response.error && response.error.code, 'tool.dependency_unavailable',
					'expected the only acceptable failure to be a missing GDAL binary — full response: ' + JSON.stringify(response)
				)
				this.skip()
			}

			assert.isOk(captured_blob, 'expected download_vector to build a Blob from the server response')
			assert.equal(captured_blob.type, row.mime, 'expected the ' + row.format + ' MIME type')
			await row.check(captured_blob)
		})
	}

	for (const [layer_id, geometry] of [[1, 'Polygon'], [2, 'Circle']]) {
		it('toggle_centroid on a ' + geometry + ' creates a linked marker in the same FeatureGroup, and removes it on toggle-off', function() {

			const layer = seeded_layer(layer_id)
			const layers_before = geolocation.FeatureGroup[layer_id].getLayers().length

			toggle_centroid(tool, layer)

			const centroid_uid = layer.feature.properties.uca_maps.centroid_uid
			assert.isOk(centroid_uid, 'expected a centroid_uid recorded on the parent')

			const layers_after_create = geolocation.FeatureGroup[layer_id].getLayers()
			assert.equal(layers_after_create.length, layers_before + 1, 'expected one new layer (the centroid marker) added')

			const centroid_layer = layer_by_uid(geolocation.FeatureGroup[layer_id], centroid_uid)
			assert.isOk(centroid_layer, 'expected to find the centroid marker by its uid')
			assert.equal(
				centroid_layer.feature.properties.uca_maps.centroid_of,
				layer.feature.properties.uca_maps.uid,
				'expected the centroid marker linked back to the parent by uid'
			)

			toggle_centroid(tool, layer)

			assert.equal(layer.feature.properties.uca_maps.centroid_uid, undefined, 'expected centroid_uid cleared')
			assert.equal(
				geolocation.FeatureGroup[layer_id].getLayers().length, layers_before,
				'expected the centroid marker removed again'
			)
		})
	}

	it('toggle_uncertainty stores the area as a number, never v6\'s 1/area string', function() {

		const layer = seeded_layer(1)
		const area_m2 = turf.area(layer.toGeoJSON())
		assert.isAbove(area_m2, 1, 'expected a seeded polygon bigger than 1 m², or 1/area and area coincide')

		toggle_uncertainty(tool, layer)

		const uncertainty = layer.feature.properties.uca_maps.uncertainty
		assert.isOk(uncertainty, 'expected uncertainty recorded')
		assert.strictEqual(uncertainty.area_m2, area_m2, 'expected the area itself, as a number')
		assert.notProperty(uncertainty, 'value', 'expected no v6 string value beside it')
		assert.isAtLeast(uncertainty.scale_tier, 1, 'expected a scale tier assigned')
		assert.isAtMost(uncertainty.scale_tier, 6, 'expected a scale tier within the 6-tier v6 scale')

		toggle_uncertainty(tool, layer)
		assert.equal(layer.feature.properties.uca_maps.uncertainty, undefined, 'expected uncertainty cleared on second toggle')
	})

	it('the uncertainty badge prints the stored area, formatted', function() {

		tool.attach_console()
		const polygon = seeded_layer(1)
		toggle_uncertainty(tool, polygon)

		polygon.openPopup()
		const badge	= tool.panel_node.querySelector('.uca-maps-object-section .uca-maps-uncertainty-badge')
		const area	= format_polygon_area(polygon.feature.properties.uca_maps.uncertainty.area_m2)
		assert.isOk(badge, 'expected the badge beside the checked box')
		assert.isTrue(badge.textContent.endsWith(' — ' + area), 'expected the badge to end with "' + area + '", got "' + badge.textContent + '"')
		assert.equal(
			tool.panel_node.querySelector('.uca-maps-object-section .uca-maps-uncertainty-scale').getAttribute('title'), area,
			'expected the scale\'s title to carry the same area'
		)
	})

	it('the uncertainty scale rings the polygon\'s own tier on any polygon, not only a 1x1\'s tier 1', function() {

		tool.attach_console()
		const polygon = seeded_layer(1)
		toggle_uncertainty(tool, polygon)
		const ring_cx = () => tool.panel_node.querySelector('.uca-maps-object-section .uca-maps-uncertainty-scale svg circle').getAttribute('cx')

		// the seeded polygon is ~100 km², past the last band
		polygon.openPopup()
		assert.equal(polygon.feature.properties.uca_maps.uncertainty.scale_tier, 6)
		assert.equal(ring_cx(), '220', 'expected the ring on band 6 of a plain polygon (v6 create_div_incertidumbre)')

		// ~4,700 m²: the render resyncs the stored tier from the geometry first
		polygon.closePopup()
		polygon.setLatLngs([[40.45, -3.65], [40.45, -3.649], [40.4505, -3.649], [40.4505, -3.65]])
		polygon.openPopup()
		assert.equal(polygon.feature.properties.uca_maps.uncertainty.scale_tier, 2)
		assert.equal(ring_cx(), '60', 'expected the ring on the stored tier\'s band, as v6 picks escala-<tier>.png')
	})

	it('a checked uncertainty follows the geometry when the polygon is reshaped', function() {

		const polygon	= seeded_layer(1)
		const square	= function(side_deg) {
			return [[40.45, -3.655], [40.45, -3.655 + side_deg], [40.45 + side_deg, -3.655 + side_deg], [40.45 + side_deg, -3.655]]
		}

		polygon.setLatLngs(square(0.01)) // ~0.94 km² → tier 4
		toggle_uncertainty(tool, polygon)
		const before = polygon.feature.properties.uca_maps.uncertainty
		assert.equal(before.scale_tier, 4, 'expected the big square in tier 4')
		tool.sync_measurements(polygon) // settles `properties.area` for the new square
		assert.equal(tool.sync_measurements(polygon), false, 'expected an untouched geometry to write nothing')

		polygon.setLatLngs(square(0.0001)) // ~94 m² → tier 1
		const area_m2 = turf.area(polygon.toGeoJSON())
		assert.equal(tool.sync_measurements(polygon), true, 'expected the reshape to dirty the record')
		const after = polygon.feature.properties.uca_maps.uncertainty
		assert.equal(after.scale_tier, 1, 'expected the tier recomputed for the new size')
		assert.strictEqual(after.area_m2, area_m2, 'expected the stored area to be the new one')
		assert.equal(tool.sync_measurements(polygon), false, 'expected the resync to stop once in step')

		toggle_uncertainty(tool, polygon)
		polygon.setLatLngs(square(0.01))
		tool.sync_measurements(polygon)
		assert.isUndefined(polygon.feature.properties.uca_maps.uncertainty, 'expected an unchecked box never to come back on a reshape')
	})

	// "changed" is the tier or the area as printed: a stale uncertainty is
	// rewritten even when `properties.area` is current, and float jitter is not
	it('sync_measurements resyncs a stale uncertainty under a current area, and ignores a sub-print jitter', function() {

		const polygon	= seeded_layer(1)
		const square	= function(side_deg) {
			return [[40.45, -3.655], [40.45, -3.655 + side_deg], [40.45 + side_deg, -3.655 + side_deg], [40.45 + side_deg, -3.655]]
		}
		const dirty = []
		geolocation.update_draw_data = (layer_id) => dirty.push(layer_id)

		polygon.setLatLngs(square(0.01)) // ~0.94 km² → tier 4
		toggle_uncertainty(tool, polygon)
		tool.sync_measurements(polygon) // settles `properties.area`
		const uca_maps = polygon.feature.properties.uca_maps

		uca_maps.uncertainty = {scale_tier: 6, area_m2: 1}
		dirty.length = 0
		assert.equal(tool.sync_measurements(polygon), true, 'expected a stale uncertainty rewritten with the area current')
		assert.deepEqual(dirty, [1], 'expected the rewrite to mark the record dirty')
		assert.equal(uca_maps.uncertainty.scale_tier, 4, 'expected the tier of the geometry')

		polygon.setLatLngs(square(0.009)) // ~0.76 km², still tier 4
		const area_m2 = turf.area(polygon.toGeoJSON())
		assert.equal(tool.sync_measurements(polygon), true, 'expected a reshape inside the tier to write')
		assert.strictEqual(uca_maps.uncertainty.area_m2, area_m2, 'expected the stored area to follow inside the same tier')

		uca_maps.uncertainty.area_m2 += 1e-9
		dirty.length = 0
		assert.equal(tool.sync_measurements(polygon), false, 'expected a jitter below the printed area to write nothing')
		assert.deepEqual(dirty, [], 'expected no dirty mark for it')
	})

	it('set_hierarchy: unchecking clears the flag and restores the order a reload draws', function() {

		const polygon	= seeded_layer(1)
		const circle	= seeded_layer(2)
		const index_of	= (layer) => Array.prototype.indexOf.call(layer._path.parentNode.childNodes, layer._path)
		const flags_of	= (layer) => {
			const hierarchy = layer.feature.properties.uca_maps.hierarchy
			return [hierarchy.bringToFront, hierarchy.bringToBack]
		}
		assert.strictEqual(polygon._path.parentNode, circle._path.parentNode, 'expected both paths in one SVG renderer, or their order is not comparable')
		// natural order = FeatureGroup order; each case below is one v6 would get wrong
		assert.isBelow(index_of(polygon), index_of(circle), 'precondition: the polygon (FeatureGroup 1) drawn under the circle (FeatureGroup 2)')

		// the check moves a layer across the other; the uncheck must move it back
		set_hierarchy(tool, polygon, 'front', true)
		assert.isAbove(index_of(polygon), index_of(circle), 'expected checking front to raise the polygon over the circle')
		set_hierarchy(tool, polygon, 'front', false)
		assert.isBelow(index_of(polygon), index_of(circle), 'expected unchecking to put the polygon back under the circle, as a reload draws it')

		set_hierarchy(tool, circle, 'back', true)
		assert.isBelow(index_of(circle), index_of(polygon), 'expected checking back to sink the circle under the polygon')
		set_hierarchy(tool, circle, 'back', false)
		assert.isBelow(index_of(polygon), index_of(circle), 'expected unchecking to put the circle back over the polygon, as a reload draws it')

		// v6 jumped the polygon to the FRONT here
		set_hierarchy(tool, polygon, 'back', true)
		assert.deepEqual(flags_of(polygon), [false, true], 'expected only bringToBack set on check')
		set_hierarchy(tool, polygon, 'back', false)
		assert.deepEqual(flags_of(polygon), [false, false], 'expected both flags clear after unchecking')
		assert.isBelow(index_of(polygon), index_of(circle), 'expected the polygon back under the circle, not jumped to the front')

		// v6 jumped the circle to the BACK here
		set_hierarchy(tool, circle, 'front', true)
		assert.deepEqual(flags_of(circle), [true, false], 'expected only bringToFront set on check')
		set_hierarchy(tool, circle, 'front', false)
		assert.deepEqual(flags_of(circle), [false, false], 'expected both flags clear after unchecking')
		assert.isBelow(index_of(polygon), index_of(circle), 'expected the circle back over the polygon, not jumped to the back')

		// unchecking one object keeps every OTHER saved flag in force
		set_hierarchy(tool, circle, 'back', true)
		set_hierarchy(tool, polygon, 'front', true)
		set_hierarchy(tool, polygon, 'front', false)
		assert.deepEqual(flags_of(circle), [false, true], 'expected the circle\'s own flag untouched')
		assert.isBelow(index_of(circle), index_of(polygon), 'expected the circle still at the back after the polygon\'s uncheck')
	})

	/**
	* THE CONSOLE'S SHAPE, against v6: the order of its sections, the heading
	* of one, the kind of widget a field uses — none of which the plumbing
	* tests above look at.
	*/
	it('the object section follows v6\'s order: the checkboxes hang from the elevation heading, properties LAST', function() {

		const layer = open_console_on(1)

		const section = tool.panel_node.querySelector('.uca-maps-object-section')

		// no "Selected object" heading any more — the panel header names it
		assert.isNotOk(section.querySelector('h5'), 'expected no heading above the geometry type')

		const order = Array.from(section.children).map(function(node) {
			for (const name of [
				'uca-maps-object-type', 'uca-maps-object-info', 'uca-maps-elevation-section',
				'uca-maps-style-controls', 'uca-maps-hierarchy-controls',
				'uca-maps-download-section',
				'uca-maps-object-images', 'uca-maps-properties-editor'
			]) {
				if (node.classList.contains(name)) return name
			}
			return null
		}).filter(Boolean)

		assert.deepEqual(order, [
			'uca-maps-object-type', 'uca-maps-object-info', 'uca-maps-elevation-section',
			'uca-maps-style-controls', 'uca-maps-hierarchy-controls',
			'uca-maps-download-section',
			'uca-maps-object-images', 'uca-maps-properties-editor'
		], 'expected v6\'s own order (special_tools.js set_info_console, polygon branch)')

		// the elevation is the SECTION HEADING the three checkboxes belong to,
		// not a line above them
		const elevation_section = section.querySelector('.uca-maps-elevation-section')
		const heading = elevation_section.firstElementChild
		assert.equal(heading.tagName, 'H6', 'expected the elevation to be the section heading')
		assert.isOk(heading.classList.contains('uca-maps-object-elevation'))
		assert.equal(
			heading.textContent, 'Elevation of the centre',
			'expected the bare heading: no pending "…" and no "not available"'
		)

		const nested = Array.from(elevation_section.children).slice(1).map(node => node.className)
		assert.deepEqual(
			nested.map(name => name.split(' ').pop()),
			['uca-maps-geoman', 'uca-maps-centroid', 'uca-maps-uncertainty'],
			'expected the three checkboxes INSIDE the elevation section'
		)

		// and the PDF button exports the properties, so it lives with them
		const pdf_btn = section.querySelector('.uca-maps-property-pdf-button')
		assert.isOk(pdf_btn, 'expected the PDF export button')
		assert.isOk(
			pdf_btn.closest('.uca-maps-properties-editor'),
			'expected the PDF button at the foot of the properties section, not in one of its own'
		)
		assert.equal(pdf_btn.textContent, 'Export as PDF', 'expected the button to name what it does')

		const download = section.querySelector('.uca-maps-download-section')
		assert.isOk(download.querySelector('.uca-maps-download-button'), 'expected the download button')
		assert.deepEqual(
			Array.from(download.querySelectorAll('.uca-maps-download-format option'), (option) => option.value),
			['geojson', 'shp', 'kml'],
			'expected the three vector formats, in menu order'
		)
	})

	it('style offers v6\'s fields, with v6\'s own ranges, and paints border and body with ONE colour', function() {

		const layer = open_console_on(1)

		const controls = tool.panel_node.querySelector('.uca-maps-style-controls')

		const weight = controls.querySelector('.uca-maps-style-weight')
		assert.equal(weight.type, 'range', 'expected the stroke width to be a slider, as in v6')
		assert.equal(weight.min, '1')
		assert.equal(weight.max, '100')

		const stroke_opacity = controls.querySelector('.uca-maps-style-stroke-opacity')
		assert.isOk(stroke_opacity, 'expected a stroke-opacity slider (v6 polygon_circle_style)')
		assert.equal(stroke_opacity.max, '1')

		const dash = controls.querySelector('.uca-maps-style-dash')
		assert.isOk(dash, 'expected a dashed-border slider (v6 polygon_circle_style)')
		assert.equal(dash.max, '100')
		assert.equal(dash.step, '2')

		// and the two new fields reach the layer through the same one writer
		dash.value = '10'
		dash.dispatchEvent(new Event('change'))
		assert.equal(layer.feature.properties.uca_maps.style.dashArray, '10', 'expected the dash stored')
		assert.equal(layer.options.dashArray, '10', 'expected setStyle applied live')

		dash.value = '0'
		dash.dispatchEvent(new Event('change'))
		assert.equal(layer.feature.properties.uca_maps.style.dashArray, undefined, 'expected 0 to clear the field, not store "0"')

		// ONE colour for border and body (v6's own model), and the
		// only style value with a split home: the stroke half is the core's
		// `properties.color`, the fill half nobody restores but this tool
		const color = tool.panel_node.querySelector('.uca-maps-style-color')
		assert.isOk(color, 'expected a single colour field (v6 polygon_circle_style)')
		assert.equal(color.type, 'color')
		assert.isNotOk(
			tool.panel_node.querySelector('.uca-maps-style-stroke-color'),
			'expected NO separate stroke-colour field'
		)

		color.value = picked_colour()
		color.dispatchEvent(new Event('change'))
		assert.equal(layer.options.color, picked_colour(), 'expected the border painted live')
		assert.equal(layer.options.fillColor, picked_colour(), 'expected the body painted live, with the same colour')
		assert.equal(
			layer.feature.properties.uca_maps.style.fillColor, picked_colour(),
			'expected the fill half stored in this tool\'s namespace, which is the only thing that restores it'
		)
		assert.isUndefined(
			layer.feature.properties.uca_maps.style.color,
			'expected the stroke half NOT duplicated here: the core owns properties.color'
		)
	})

	it('a circle lists its shape, radius and area first and read-only; "Add" refuses each with a message and dirties nothing', function() {

		const layer = open_console_on(2) // circle: shape + radius come from the core

		assert.isOk(layer.feature.properties.area, 'expected the area written into the feature, as v6 does')

		// stored order as a jsonb read gives it back (keys by length): area first
		const properties = layer.feature.properties
		for (const key of ['shape', 'radius']) {
			const value = properties[key]
			delete properties[key]
			properties[key] = value
		}
		layer.closePopup()
		layer.openPopup()

		const rows = () => new Map(Array.from(
			tool.panel_node.querySelectorAll('.uca-maps-properties-list .uca-maps-property-item'),
			(item) => [item.querySelector('.uca-maps-property-key').textContent.replace(':', ''), item]
		))

		// still listed, first and in this order, since exports and the PDF carry
		// them; v6 offered them as editable text and lost the edit on the next click
		assert.deepEqual(Array.from(rows().keys()).slice(0, 3), ['shape', 'radius', 'area'], 'expected shape, radius and area leading the list')
		for (const key of ['shape', 'radius', 'area']) {
			const row = rows().get(key)
			assert.isOk(row, 'expected "' + key + '" listed with the other properties')
			assert.equal(row.querySelector('.uca-maps-property-computed').textContent, String(layer.feature.properties[key]), 'expected "' + key + '" shown as text')
			assert.isNotOk(row.querySelector('input'), 'expected no field to type over "' + key + '"')
			assert.isNotOk(row.querySelector('.uca-maps-property-delete'), 'expected no ✕ on "' + key + '"')
		}

		// nor through the add form: refused with its reason, nothing written or
		// dirtied, and the form keeps what was typed
		const dirty = []
		geolocation.update_draw_data = (layer_id) => dirty.push(layer_id)
		const values_before = {area: layer.feature.properties.area, radius: layer.feature.properties.radius, shape: layer.feature.properties.shape}
		const add_row = tool.panel_node.querySelector('.uca-maps-property-add')
		const message = tool.panel_node.querySelector('.uca-maps-property-add-message')
		assert.isTrue(message.hidden, 'expected no message before any refusal')
		for (const key of ['area', ' radius ', 'shape']) {
			add_row.querySelector('.uca-maps-property-add-key').value	= key
			add_row.querySelector('.uca-maps-property-add-value').value	= '999'
			add_row.querySelector('.uca-maps-property-add-button').click()
			assert.isFalse(message.hidden, 'expected the refusal of "' + key + '" said')
			assert.include(message.textContent, key.trim(), 'expected the message to name the refused key')
			assert.equal(add_row.querySelector('.uca-maps-property-add-key').value, key, 'expected the refused entry left in the form')
		}
		assert.deepEqual(dirty, [], 'expected a refused "Add" to dirty nothing')
		assert.deepEqual({area: layer.feature.properties.area, radius: layer.feature.properties.radius, shape: layer.feature.properties.shape}, values_before, 'expected the three values untouched')

		// a valid key after a refusal: the message goes, the property is written
		// and the record dirtied
		add_row.querySelector('.uca-maps-property-add-key').value	= 'note'
		add_row.querySelector('.uca-maps-property-add-value').value	= 'kept'
		add_row.querySelector('.uca-maps-property-add-button').click()
		assert.isTrue(message.hidden, 'expected the refusal message taken away by a valid "Add"')
		assert.equal(layer.feature.properties.note, 'kept', 'expected the valid property written')
		assert.equal(dirty.length, 1, 'expected the valid "Add" to dirty the record once')

		// idempotent: a second pass must not rewrite and re-dirty the record
		const before = layer.feature.properties.area
		assert.equal(tool.sync_measurements(layer), false, 'expected no write when the measurement has not changed')
		assert.equal(layer.feature.properties.area, before, 'expected the same value')
	})

	it('a circle stores its real area (π·r² in m²); one saved with v6\'s circumference is rewritten once', function() {

		const layer		= open_console_on(2)
		const radius	= layer.getRadius()
		const expected	= format_polygon_area(Math.PI * radius * radius)
		assert.equal(layer.feature.properties.area, expected, 'expected π·r² printed as a polygon\'s area')
		assert.notProperty(layer.feature.properties, 'perimeter', 'expected no perimeter key: the core keeps radius')

		const dirty = []
		geolocation.update_draw_data = (layer_id) => dirty.push(layer_id)
		layer.feature.properties.area = (2 * Math.PI * radius).toFixed(2) + ' m' // as v6 saved it
		assert.equal(tool.sync_measurements(layer), true, 'expected the circumference rewritten')
		assert.equal(layer.feature.properties.area, expected, 'expected the real area stored')
		assert.equal(dirty.length, 1, 'expected the record dirtied once')
		assert.equal(tool.sync_measurements(layer), false, 'expected the resync to stop once in step')
	})

	it('with the tool CSS, every "nothing here yet" line has the one look: legend, gallery, Roma dropdown', async function() {

		await with_tool_css(async () => {
			const look = (node) => {
				const style = getComputedStyle(node)
				return style.color + ' · ' + style.fontStyle + ' · ' + style.fontSize + ' · ' + style.opacity
			}

			tool.attach_console()
			const reference = tool.panel_node.querySelector('.uca-maps-object-section .uca-maps-empty-state')
			assert.isOk(reference, 'expected the console\'s own placeholder to compare with')
			// read now: selecting an object below replaces the placeholder
			const reference_look = look(reference)
			assert.include(reference_look, 'italic', 'expected the reference itself styled')

			open_console_on(1)
			const gallery_empty = tool.panel_node.querySelector('.uca-maps-object-gallery-empty')

			tool.attach_legend()
			tool.legend_control.getContainer().click()
			const legend_empty = tool.legend_panel.querySelector('.uca-maps-legend-empty')

			mount_roman()
			open_roman()
			seed_roman_list('dare', [])
			const roman_empty = geolocation.map.getContainer().querySelector('.uca-maps-roman-dropdown .uca-maps-roman-empty')

			for (const [label, node] of [['legend', legend_empty], ['gallery', gallery_empty], ['Roma', roman_empty]]) {
				assert.isOk(node, 'expected the empty line: ' + label)
				assert.equal(look(node), reference_look, 'expected the shared look: ' + label)
			}
		})
	})

	it('with the tool CSS, a long Roman name cuts with an ellipsis and its detail stays in the row', async function() {

		await with_tool_css(async () => {
			mount_roman(WITH_PLEIADES)
			open_roman()
			seed_roman_list('pleiades', [{ name: 'Colonia Iulia Augusta Faventia Paterna Barcino '.repeat(4).trim(), id: '246343' }])

			const button	= geolocation.map.getContainer().querySelector('.uca-maps-roman-dropdown .uca-maps-roman-result-button')
			const name		= button.querySelector('.uca-maps-roman-result-name')
			const detail	= button.querySelector('.uca-maps-roman-result-detail')
			assert.isAbove(name.scrollWidth, name.clientWidth, 'expected the name cut, not run past the row')
			assert.equal(getComputedStyle(name).textOverflow, 'ellipsis', 'expected the cut shown as an ellipsis')
			const row = button.getBoundingClientRect()
			const tail = detail.getBoundingClientRect()
			assert.isAtMost(tail.right, row.right + 0.5, 'expected the detail inside the row')
			assert.isAbove(tail.width, 0, 'expected the detail still drawn')
		})
	})

	it('the associate-image picker stays above the gallery it fills, and is the ONLY step', function() {

		const layer = open_console_on(1)

		const images = tool.panel_node.querySelector('.uca-maps-object-images')
		const nodes = Array.from(images.children)
		const index = selector => nodes.findIndex(node => node.matches(selector))

		// a missing node is index -1, which would sit "above" anything
		assert.isAtLeast(index('.uca-maps-object-image-file'), 0, 'expected the picker in the images section')
		assert.isAtLeast(index('.uca-maps-object-gallery'), 0, 'expected the gallery in the images section')
		assert.isBelow(
			index('.uca-maps-object-image-file'), index('.uca-maps-object-gallery'),
			'expected the picker above the gallery: a growing gallery must not push the control down the panel'
		)
		assert.isNotOk(
			images.querySelector('.uca-maps-object-image-associate'),
			'expected NO confirm button: choosing the file associates it'
		)
		assert.isOk(images.querySelector('.uca-maps-object-gallery-title'), 'expected the gallery subtitle (v6 "Galería")')
	})

	it('choosing a file is what associates it: the picker\'s own change event runs the upload', async function() {

		const layer = open_console_on(1)

		const picker = tool.panel_node.querySelector('.uca-maps-object-image-file')

		let asked_for	= undefined
		let disabled_during = null
		tool.associate_image = async function(asked_layer, file) {
			asked_for			= asked_layer
			disabled_during	= picker.disabled
			return {ok: true, still_shown: true}
		}

		picker.dispatchEvent(new Event('change'))
		await tick()

		assert.equal(asked_for, layer, 'expected the association fired for the selected object, with no second click')
		assert.equal(disabled_during, true, 'expected the picker disabled for the round trip')
	})

	it('the Geoman checkbox is per object and only overrides an explicit state', function() {

		const layer = open_console_on(1)

		assert.equal(tool.has_geoman_edition(layer), false, 'expected no stored state before anyone ticks it')

		// each change redraws the console: read the box afresh every time
		const box = () => tool.panel_node.querySelector('.uca-maps-geoman input')
		const set_box = function(checked) {
			box().checked = checked
			box().dispatchEvent(new Event('change'))
		}
		assert.isOk(box(), 'expected the "Geoman editing active" checkbox (v6 create_div_geoman_edition_mode)')
		assert.equal(layer.pm.enabled(), false, 'expected the handles off before the first tick')

		set_box(true)
		assert.equal(tool.has_geoman_edition(layer), true, 'expected the state stored once ticked')
		assert.equal(tool.is_geoman_edition(layer), true, 'expected editing on for THIS object')
		assert.equal(layer.pm.enabled(), true, 'expected geoman actually enabled on the layer')

		set_box(false)
		assert.equal(tool.is_geoman_edition(layer), false, 'expected editing off for THIS object')
		assert.equal(layer.pm.enabled(), false, 'expected geoman actually disabled on the layer')
		assert.equal(box().checked, false, 'expected the redrawn box to say so')

		// a sibling in another FeatureGroup is untouched: no stored state, no override
		const other = seeded_layer(2)
		assert.equal(tool.has_geoman_edition(other), false, 'expected the state to be per object, not per map')
	})



	// CIRCLE AND MARKER — the per-geometry branches: which sections each type
	// gets, and compute_info's formula for each. No polyline is seeded.

	it('compute_info: Marker shows coordinates only, no style/centroid/uncertainty/hierarchy sections', function() {

		tool.attach_console()
		const layer = seeded_layer(3)
		assert.instanceOf(layer, L.Marker, 'expected the seeded marker to load as an L.Marker')

		const info = tool.compute_info(layer)
		assert.deepEqual(info, [{label_key: 'coordinates', label: 'Coordinates', value: geolocation.str_lat_lng(layer.getLatLng())}], 'expected one Coordinates row, formatted as the core\'s own popup')

		layer.openPopup()
		const section = tool.panel_node.querySelector('.uca-maps-object-section')
		assert.isNotOk(section.querySelector('.uca-maps-style-controls'), 'expected NO style controls for a marker')
		assert.isNotOk(section.querySelector('.uca-maps-centroid'), 'expected NO centroid checkbox for a marker')
		assert.isNotOk(section.querySelector('.uca-maps-uncertainty'), 'expected NO uncertainty checkbox for a marker')
		assert.isNotOk(section.querySelector('.uca-maps-hierarchy-controls'), 'expected NO hierarchy checkboxes for a marker')
		assert.isOk(section.querySelector('.uca-maps-properties-editor'), 'expected the properties editor to still be offered')
		assert.isOk(section.querySelector('.uca-maps-download-button'), 'expected the download button to still be offered')
	})

	it('compute_info: Circle shows centre, radius and real area (π·r², not v6\'s 2·π·r) one per line, with style/centroid/hierarchy but NOT uncertainty', function() {

		tool.attach_console()
		const layer = seeded_layer(2)
		assert.instanceOf(layer, L.Circle, 'expected the seeded circle to reconstruct as an L.Circle (shape:"circle"+radius)')

		const radius	= layer.getRadius()
		const center	= geolocation.str_lat_lng(layer.getLatLng())
		const area		= format_polygon_area(Math.PI * radius * radius)
		assert.deepEqual(tool.compute_info(layer).map((row) => [row.label_key, row.value]), [
			['center', center],
			['radius', geolocation.round_coordinate(radius, 2) + ' m'],
			['area', area]
		], 'expected the area as π·r², printed as a polygon\'s, after centre and radius')

		layer.openPopup()
		const section = tool.panel_node.querySelector('.uca-maps-object-section')
		const lines = Array.from(section.querySelectorAll('.uca-maps-object-info > .uca-maps-object-info-row'), (row) => row.textContent)
		assert.deepEqual(lines, [
			(tool.get_tool_label('info_center') || 'Center') + ': ' + center,
			(tool.get_tool_label('info_radius') || 'Radius') + ': ' + geolocation.round_coordinate(radius, 2) + ' m',
			(tool.get_tool_label('info_area') || 'Area') + ': ' + area
		], 'expected one line per measure: Centre, Radius, Area')
		assert.isOk(section.querySelector('.uca-maps-style-controls'), 'expected style controls for a circle')
		assert.isOk(section.querySelector('.uca-maps-centroid'), 'expected a centroid checkbox for a circle')
		assert.isNotOk(section.querySelector('.uca-maps-uncertainty'), 'expected NO uncertainty checkbox for a circle (matches v6: polygon-only)')
		assert.isOk(section.querySelector('.uca-maps-hierarchy-controls'), 'expected hierarchy checkboxes for a circle')
	})



	// MAP AS IMAGE (map_image_download.js) — its own button and panel: PNG is
	// captured in the browser, the other formats are converted by the server.

	it('attach_map_image_download_control builds its own button+panel with all 5 formats, in order', function() {

		tool.attach_map_image_download_control()

		const control = geolocation.map.getContainer().querySelector('.uca-maps-map-image-control')
		assert.isOk(control, 'expected the map-image-download toggle button')
		assert.isOk(tool.map_image_panel, 'expected the map-image-download panel built')
		assert.equal(tool.map_image_panel.hidden, true, 'expected the panel hidden by default')
		assert.equal(
			geolocation.map.getContainer().contains(tool.map_image_panel), true,
			'expected the panel appended to the map\'s own DOM container'
		)

		const select = tool.map_image_panel.querySelector('.uca-maps-map-image-format')
		const options = Array.from(select.querySelectorAll('option')).map(o => o.value)
		assert.deepEqual(options, ['png', 'jpg', 'gif', 'webp', 'geotiff'], 'expected all 5 v6 formats, in order')

		assert.isOk(tool.map_image_panel.querySelector('.uca-maps-map-image-button'), 'expected the download button')

		// v6's own name field
		const name_input = tool.map_image_panel.querySelector('.uca-maps-map-image-name')
		assert.isOk(name_input, 'expected the file-name field')
		assert.equal(name_input.value, DEFAULT_MAP_IMAGE_NAME, 'expected it pre-filled with the default base name (v6 opens with "archivo")')
		assert.isOk(tool.map_image_panel.querySelector('.uca-maps-map-image-name-label'), 'expected the field labelled')

		control.click()
		assert.equal(tool.map_image_panel.hidden, false, 'expected the panel shown after one click')
		control.click()
		assert.equal(tool.map_image_panel.hidden, true, 'expected the panel hidden again after a second click')
	})

	it('download_map_image(\'png\') captures the live map client-side under the default name, no server round-trip', async function() {

		tool.attach_console()
		tool.attach_map_image_download_control()

		let tool_request_called = false
		stub_tool_request(async function(options) {
			tool_request_called = true
			return real_tool_request(options)
		})

		// no name argument: omitted is the default, unlike an empty field
		const captured = await capture_download(() => download_map_image(tool, 'png'))

		assert.isOk(captured.blob, 'expected download_map_image to build a Blob')
		assert.equal(captured.blob.type, 'image/png', 'expected a real PNG capture')
		assert.isAbove(captured.blob.size, 0, 'expected a non-empty capture')
		assert.equal(captured.name, `${DEFAULT_MAP_IMAGE_NAME}.png`, 'expected the default base name when the caller passes nothing')
		assert.equal(tool_request_called, false, 'expected NO server round-trip for the PNG format')
	})

	it('download_map_image names the PNG with what the user typed, sanitized', async function() {

		tool.attach_console()
		tool.attach_map_image_download_control()

		const captured = await capture_download(() => download_map_image(tool, 'png', '../Necrópolis de Cádiz'))

		assert.isOk(captured.blob, 'expected a Blob')
		assert.equal(captured.name, 'Necrópolis de Cádiz.png', 'expected the typed name, separators stripped and the extension appended once')
	})

	it('the map image keeps scale, legend and attribution, and drops every other control', function() {

		tool.attach_map_image_download_control()
		tool.attach_scale_bar()
		tool.attach_legend()

		const container = geolocation.map.getContainer()
		// a panel is no .leaflet-control: only the toolbar-node rule keeps an open one out
		container.querySelector('.uca-maps-map-image-control').click()
		assert.isFalse(tool.map_image_panel.hidden, 'expected the panel open on the map')
		// what dom-to-image-more does with the filter: a dropped node takes its subtree
		const survives = (node) => {
			for (let current = node; current && current!==container; current = current.parentNode) {
				if (!keep_in_map_image(tool, current)) {
					return false
				}
			}
			return true
		}

		const attribution = container.querySelector('.leaflet-control-attribution')
		assert.isOk(attribution, 'expected Leaflet\'s attribution on the live map')
		assert.sameMembers(
			[...container.querySelectorAll('.leaflet-control')].filter((node) => keep_in_map_image(tool, node)),
			[tool.scale_control.getContainer(), tool.legend_overlay.getContainer(), attribution],
			'expected only the cartographic controls kept'
		)
		for (const node of [tool.scale_control.getContainer(), tool.legend_overlay.getContainer(), attribution, container.querySelector('.leaflet-map-pane')]) {
			assert.isTrue(survives(node), `expected ${node.className} in the image`)
		}

		// floors: each control the filter exists to drop is really on the map
		for (const selector of ['.leaflet-control-zoom', '.leaflet-control-layers', '.leaflet-pm-toolbar', '[class*="leaflet-pm-icon-"]', '.uca-maps-map-image-control', '.uca-maps-panel']) {
			const nodes = [...container.querySelectorAll(selector)]
			assert.isAbove(nodes.length, 0, `expected ${selector} on the live map`)
			assert.isFalse(nodes.some(survives), `expected every ${selector} out of the image`)
		}
	})

	it('capturing the map requests no URL made out of an SVG icon\'s own #reference', async function() {

		tool.attach_map_image_download_control()

		// Geoman's icons are data: SVGs with `url(#mask-2)`-style references,
		// which dom-to-image-more fetched as page URLs (404s and console noise)
		assert.isOk(geolocation.map.getContainer().querySelector('[class*="leaflet-pm-icon-"]'), 'expected Geoman\'s icons on the map')

		const is_reference = (url) => /#|%23/.test(url)
		const requested = await capture_png_requests()

		assert.deepEqual(requested.filter(is_reference), [], 'expected no request built from an SVG #reference')
		assert.isAbove((await capture_unguarded_requests()).filter(is_reference).length, 0, 'expected an unguarded capture to ask for them')
	})

	it('download_map_image captures through keep_in_map_image: Geoman, zoom and an open panel out, the attribution in', async function() {

		tool.attach_map_image_download_control()
		const container = geolocation.map.getContainer()
		container.querySelector('.uca-maps-map-image-control').click()

		// only the options matter here: a stub capture, the real library left as found
		const had_library	= typeof window.domtoimage!=='undefined'
		if (!had_library) window.domtoimage = {}
		const library		= window.domtoimage
		const real_to_blob	= library.toBlob
		let seen = null
		library.toBlob = async function(node, options) {
			seen = {node, options}
			return new Blob(['png'], {type: 'image/png'})
		}
		try {
			await capture_download(() => download_map_image(tool, 'png'))
		} finally {
			if (had_library) {
				library.toBlob = real_to_blob
			} else {
				delete window.domtoimage
			}
		}

		assert.isOk(seen, 'expected the capture to go through domtoimage.toBlob')
		assert.equal(seen.node, container, 'expected the map container captured')
		const filter = seen.options.filter
		assert.isFalse(filter(container.querySelector('.leaflet-pm-toolbar')), 'expected Geoman\'s toolbar out of the image')
		assert.isFalse(filter(container.querySelector('.leaflet-control-zoom')), 'expected the zoom buttons out of the image')
		assert.isFalse(filter(tool.map_image_panel), 'expected the open panel out of the image')
		assert.isTrue(filter(container.querySelector('.leaflet-control-attribution')), 'expected the attribution the tile licence asks for')
		assert.isTrue(filter(container.querySelector('.leaflet-map-pane')), 'expected the map content kept')
	})

	it('capturing the map requests no URL held by a CSS custom property', async function() {

		tool.attach_map_image_download_control()

		// core tokens such as --search_icon_url hold relative url()s the browser
		// never resolves. dom-to-image-more serialises a pseudo-element with
		// every property it inherits, those tokens included, and fetched them
		// against the page's own path (404s and console noise)
		const pane		= geolocation.map.getContainer().querySelector('.leaflet-map-pane')
		const style		= getComputedStyle(pane)
		const token_paths	= [...style]
			.filter((name) => name.startsWith('--'))
			.flatMap((name) => [...style.getPropertyValue(name).matchAll(/url\(\s*['"]?([^'")]+)/g)].map((match) => match[1]))
			.filter((path) => !path.startsWith('data:'))
		assert.isAbove(token_paths.length, 0, 'expected the map to inherit custom properties holding a url()')

		// the library may resolve a path before asking: match on what follows the ../
		const is_token = (url) => token_paths.some((path) => url.includes(path.replace(/^(\.\.?\/)+/, '')))
		const pseudo_rule = document.createElement('style')
		pseudo_rule.textContent = '.leaflet-map-pane::before { content: ""; }'
		document.head.appendChild(pseudo_rule)
		let requested, unguarded
		try {
			assert.notEqual(getComputedStyle(pane, '::before').getPropertyValue('content'), 'none', 'expected a pseudo-element in the map')
			requested	= await capture_png_requests()
			unguarded	= await capture_unguarded_requests()
		} finally {
			pseudo_rule.remove()
		}

		assert.deepEqual(requested.filter(is_token), [], 'expected no request for a url() a custom property holds')
		assert.isAbove(unguarded.filter(is_token).length, 0, 'expected an unguarded capture to ask for them')
	})

	it('download_map_image refuses an EMPTY name (v6 parity) without capturing or calling the server', async function() {

		tool.attach_console()
		tool.attach_map_image_download_control()

		let tool_request_called = false
		stub_tool_request(async function(options) {
			tool_request_called = true
			return real_tool_request(options)
		})

		// The refusal has to be VISIBLE, not just "nothing happened": it comes
		// back for the panel's line, under the field it is about, and nothing
		// toasts — no request failed.
		const errors = []
		const token = event_manager.subscribe('api_error', (error) => errors.push(error))

		// A name that sanitizes to nothing is a refusal, never a silent
		// fallback to the default (download_filename.js).
		let result = null
		let captured = null
		try {
			captured = await capture_download(async () => {
				result = await download_map_image(tool, 'png', '   ')
			})
		} finally {
			event_manager.unsubscribe(token)
		}

		assert.isNotOk(captured.blob, 'expected no capture at all')
		assert.isNotOk(captured.name, 'expected no download triggered')
		assert.equal(tool_request_called, false, 'expected no server round-trip either')
		assert.deepEqual(result, {ok: false, error: 'Please enter a name for the file'}, 'expected the reason for the panel\'s line')
		assert.equal(errors.length, 0, 'expected no page toast for a field the user left empty')
	})

	it('the panel\'s Download button passes its own field to download_map_image', async function() {

		tool.attach_map_image_download_control()

		const calls = []
		tool.download_map_image = function(format, file_name) {
			calls.push([format, file_name])
		}

		tool.map_image_panel.querySelector('.uca-maps-map-image-name').value = 'plano general'
		tool.map_image_panel.querySelector('.uca-maps-map-image-format').value = 'jpg'
		tool.map_image_panel.querySelector('.uca-maps-map-image-button').click()

		assert.deepEqual(calls, [['jpg', 'plano general']], 'expected the click to carry BOTH the format and the field\'s current value')
	})

	/** The server converts the same PNG capture: the real raster_download, never a stub. */
	it('download_map_image(\'jpg\') sends the sanitized name and gets a real JPEG back (skipped without ImageMagick)', async function() {

		tool.attach_console()
		tool.attach_map_image_download_control()

		let sent = null
		let response = null
		stub_tool_request(async function(options) {
			sent		= options
			response	= await real_tool_request(options)
			return response
		})

		const captured = await capture_download(() => download_map_image(tool, 'jpg', '../Necrópolis de Cádiz'))

		assert.isOk(sent, 'expected a server round-trip for a non-PNG format')
		assert.equal(sent.action, 'raster_download', 'expected the raster_download action')
		assert.equal(sent.options.file_name, 'Necrópolis de Cádiz', 'expected the SANITIZED name to travel in options.file_name')

		if (response && response.ok!==true) {
			assert.equal(response.error && response.error.code, 'tool.dependency_unavailable', 'expected the only acceptable failure to be a missing ImageMagick binary — full response: ' + JSON.stringify(response))
			this.skip()
		}

		assert.isOk(captured.blob, 'expected download_map_image to build a Blob from the server response')
		assert.equal(captured.blob.type, 'image/jpeg', 'expected the JPEG MIME type')
		assert.equal(captured.name, 'Necrópolis de Cádiz.jpg', 'expected the typed name back on the download')
		const bytes = new Uint8Array(await captured.blob.arrayBuffer())
		assert.deepEqual(Array.from(bytes.slice(0, 3)), [0xff, 0xd8, 0xff], 'expected real JPEG bytes, not a relabelled PNG')
	})

	/** IFD0 of a little-endian TIFF, SHORT and DOUBLE tags only: where GDAL puts the georeference. */
	const read_tiff_tags = function(bytes) {
		const view	= new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
		const ifd	= view.getUint32(4, true)
		const tags	= {}
		for (let i = 0; i < view.getUint16(ifd, true); i++) {
			const entry	= ifd + 2 + (i * 12)
			const type	= view.getUint16(entry + 2, true)
			const count	= view.getUint32(entry + 4, true)
			const size	= {3: 2, 12: 8}[type]
			if (!size) {
				continue
			}
			const offset = (count * size) > 4 ? view.getUint32(entry + 8, true) : entry + 8
			tags[view.getUint16(entry, true)] = Array.from({length: count}, (value, k) => type===3
				? view.getUint16(offset + (k * 2), true)
				: view.getFloat64(offset + (k * 8), true))
		}
		return tags
	}

	it('download_map_image(\'geotiff\') gets a GeoTIFF in EPSG:3857 tied at the view\'s north-west corner (skipped without GDAL)', async function() {

		tool.attach_console()
		tool.attach_map_image_download_control()

		let response = null
		stub_tool_request(async function(options) {
			response = await real_tool_request(options)
			return response
		})

		const captured_blob = (await capture_download(() => download_map_image(tool, 'geotiff'))).blob

		if (response && response.ok!==true) {
			assert.equal(response.error && response.error.code, 'tool.dependency_unavailable', 'expected the only acceptable failure to be a missing GDAL binary — full response: ' + JSON.stringify(response))
			this.skip()
		}

		assert.isOk(captured_blob, 'expected download_map_image to build a Blob from the server response')
		assert.equal(captured_blob.type, 'image/tiff', 'expected the GeoTIFF MIME type')

		const bytes = new Uint8Array(await captured_blob.arrayBuffer())
		// little-endian 'II*\0', GDAL's own default byte order
		assert.deepEqual(Array.from(bytes.slice(0, 4)), [0x49, 0x49, 0x2a, 0x00], 'expected real TIFF magic bytes')

		const tags		= read_tiff_tags(bytes)
		const geokeys	= tags[34735] || [] // GeoKeyDirectory: 4 header shorts, then {key, location, count, value}
		const projected	= Array.from({length: geokeys[3] || 0}, (value, k) => geokeys.slice(4 + (k * 4), 8 + (k * 4)))
			.find(([key]) => key===3072) // ProjectedCSTypeGeoKey
		assert.isOk(projected, 'expected a projected CRS key in the GeoTIFF')
		assert.equal(projected[3], 3857, 'expected EPSG:3857, the grid the screenshot\'s pixels are uniform in')

		const tiepoint		= tags[33922] // ModelTiepoint: raster (0,0) to model (x, y)
		const north_west	= L.CRS.EPSG3857.project(geolocation.map.getBounds().getNorthWest())
		assert.isOk(tiepoint, 'expected the model tiepoint')
		assert.deepEqual(tiepoint.slice(0, 2), [0, 0], 'expected the tiepoint on the top-left pixel')
		assert.closeTo(tiepoint[3], north_west.x, 0.01, 'expected the image tied at the view\'s west edge')
		assert.closeTo(tiepoint[4], north_west.y, 0.01, 'expected the image tied at the view\'s north edge')
	})



	// OBJECTS (object_viewer.js) — read-only lists of the ACTIVE FeatureGroup,
	// as v6. (!) The 'full' load leaves active_layer_id at 3: load_layer sets
	// it for each layer it loads, the marker last. Each test sets it first.

	it('attach_object_viewer builds its button+panel with both lists empty until the first open fills them', function() {

		geolocation.active_layer_id = 1 // the seeded polygon
		tool.attach_object_viewer()

		const control = geolocation.map.getContainer().querySelector('.uca-maps-object-viewer-control')
		assert.isOk(control, 'expected the "Objects" toggle button')
		assert.isOk(tool.object_viewer_panel, 'expected the "Objects" panel built')
		assert.equal(tool.object_viewer_panel.hidden, true, 'expected the panel hidden by default')
		assert.equal(
			geolocation.map.getContainer().contains(tool.object_viewer_panel), true,
			'expected the panel appended to the map\'s own DOM container'
		)

		const vector_list = tool.object_viewer_panel.querySelector('.uca-maps-object-viewer-vector-list')
		const raster_list = tool.object_viewer_panel.querySelector('.uca-maps-object-viewer-raster-list')
		assert.isOk(vector_list, 'expected the Vector Objects list')
		assert.isOk(raster_list, 'expected the Rasterized Objects list')

		// built lazily on the first open, like every sibling panel
		assert.equal(vector_list.children.length, 0, 'expected the Vector Objects list still empty before the first open')
		assert.equal(raster_list.children.length, 0, 'expected the Rasterized Objects list still empty before the first open')

		control.click()
		assert.equal(tool.object_viewer_panel.hidden, false, 'expected the panel shown after one click')

		// the first open is what populates it — the seeded polygon (active
		// layer 1) is listed now
		const vector_items = vector_list.querySelectorAll('.uca-maps-object-viewer-item')
		assert.equal(vector_items.length, 1, 'expected the one seeded polygon in Vector Objects')
		assert.isOk(
			raster_list.querySelector('.uca-maps-empty-state'),
			'expected Rasterized Objects to show its empty-state placeholder: no image on the map'
		)

		control.click()
		assert.equal(tool.object_viewer_panel.hidden, true, 'expected the panel hidden again after a second click')
	})

	it('each listed object carries an icon-only eye button: an SVG with an accessible name, no text', function() {

		geolocation.active_layer_id = 1 // the seeded polygon
		tool.attach_object_viewer()
		tool.object_viewer_control.getContainer().click()

		const eye = tool.object_viewer_panel.querySelector('.uca-maps-object-viewer-item .uca-maps-object-viewer-center')
		assert.isOk(eye, 'expected the eye button on the listed object')
		assert.instanceOf(eye.querySelector('svg'), SVGSVGElement, 'expected a real SVG icon, not markup turned into text')
		assert.isOk(eye.querySelector('svg path').getAttribute('d'), 'expected the eye drawn')
		assert.equal(eye.textContent.trim(), '', 'expected no text beside the icon')
		assert.isOk(eye.getAttribute('aria-label'), 'expected the icon-only button to carry an accessible name')
	})

	it('collect_objects reads the ACTIVE FeatureGroup only (v6 parity), with a display-only nameless fallback', function() {

		geolocation.active_layer_id = 1 // the seeded polygon
		tool.attach_object_viewer()

		let {vector_objects, raster_objects} = collect_objects(tool)
		assert.equal(vector_objects.length, 1, 'expected only the active layer\'s (1, polygon) one object')
		assert.equal(raster_objects.length, 0, 'expected no raster objects: no image on the map')
		assert.equal(vector_objects[0].name, 'Untitled object', 'expected the display-only nameless fallback')
		assert.equal(vector_objects[0].display, true, 'expected visible by default')
		assert.equal(
			seeded_layer(1).feature.properties.name, undefined,
			'expected collect_objects to NEVER write the nameless fallback back into properties, unlike v6'
		)

		geolocation.active_layer_id = 3 // switch to the seeded marker's FeatureGroup
		;({vector_objects, raster_objects} = collect_objects(tool))
		assert.equal(vector_objects.length, 1, 'expected the marker FeatureGroup\'s one object once active_layer_id changes')
		assert.instanceOf(vector_objects[0].layer, L.Marker, 'expected the seeded marker')
	})

	it('set_object_display hides/shows a Polygon (DOM style + stored uca_maps.display) and marks the record dirty', function() {

		tool.attach_console() // hydrate()'s reapply_all/commit plumbing lives here
		geolocation.active_layer_id = 1
		tool.attach_object_viewer()

		const layer = seeded_layer(1)
		assert.instanceOf(layer, L.Polygon, 'expected the seeded polygon')

		for (const visible of [false, true]) {
			geolocation.is_data_changed = false
			set_object_display(tool, layer, visible)
			assert.equal(layer.feature.properties.uca_maps.display, visible, 'expected display stored ' + visible)
			assert.equal(layer._path.style.display==='none', !visible, 'expected the Path DOM node ' + (visible ? 'shown' : 'hidden'))
			assert.isTrue(geolocation.is_data_changed, 'expected the record dirty, or Save drops the change')
		}
	})

	it('set_object_display works for a Marker too (icon + shadow, not _path), and marks the record dirty', function() {

		tool.attach_console()
		geolocation.active_layer_id = 3
		tool.attach_object_viewer()

		const layer = seeded_layer(3)
		assert.instanceOf(layer, L.Marker, 'expected the seeded marker')
		assert.isOk(layer._shadow, 'expected the default icon\'s shadow drawn')

		for (const visible of [false, true]) {
			geolocation.is_data_changed = false
			set_object_display(tool, layer, visible)
			assert.equal(layer.feature.properties.uca_maps.display, visible, 'expected display stored ' + visible)
			assert.equal(layer._icon.style.display==='none', !visible, 'expected the marker icon ' + (visible ? 'shown' : 'hidden'))
			assert.equal(layer._shadow.style.display==='none', !visible, 'expected its shadow ' + (visible ? 'shown' : 'hidden') + ' with it')
			assert.isTrue(geolocation.is_data_changed, 'expected the record dirty, or Save drops the change')
		}
	})

	it('set_object_display seeds .feature on a layer freshly drawn via Geoman (pm:create never assigns one)', function() {

		tool.attach_console()
		geolocation.active_layer_id = 1
		tool.attach_object_viewer()

		// the core's init_feature never assigns .feature (only the L.geoJson
		// restore does): a shape just drawn with Geoman reaches this module bare
		const layer = seeded_layer(1)
		delete layer.feature
		assert.isNotOk(layer.feature, 'expected the fixture layer to start with no .feature, matching a freshly-drawn one')

		set_object_display(tool, layer, false)

		assert.isOk(layer.feature, 'expected set_object_display to seed .feature via ensure_properties')
		assert.equal(layer.feature.properties.uca_maps.display, false, 'expected display persisted false even from a featureless layer')
		assert.equal(layer._path.style.display, 'none', 'expected the Path DOM node hidden')
	})

	it('the rendered checkbox passes its OWN new .checked value, not an inversion of the stored one', function() {

		tool.attach_console()
		geolocation.active_layer_id = 1 // the seeded polygon
		tool.attach_object_viewer()

		const layer = seeded_layer(1)

		tool.object_viewer_control.getContainer().click() // show + populate
		const checkbox = tool.object_viewer_panel.querySelector('.uca-maps-object-viewer-vector-list .uca-maps-object-viewer-checkbox')
		assert.isOk(checkbox, 'expected the seeded polygon\'s checkbox')
		assert.equal(checkbox.checked, true, 'expected checked (visible) by default')

		checkbox.checked = false
		checkbox.dispatchEvent(new Event('change'))

		assert.equal(layer.feature.properties.uca_maps.display, false, 'expected the checkbox change to reach set_object_display')
		assert.equal(layer._path.style.display, 'none', 'expected the checkbox change to hide the Path DOM node too')

		// re-checking must show it again: a handler inverting the stored value
		// would pass the first change and fail this one
		checkbox.checked = true
		checkbox.dispatchEvent(new Event('change'))
		assert.equal(layer.feature.properties.uca_maps.display, true, 'expected display persisted true again')
		assert.notEqual(layer._path.style.display, 'none', 'expected the Path DOM node shown again')
	})

	it('the panel refreshes itself on the next updated_layer_data publish while open, and never while closed', function() {

		geolocation.active_layer_id = 1
		tool.attach_object_viewer() // never opened yet

		const vector_list	= tool.object_viewer_panel.querySelector('.uca-maps-object-viewer-vector-list')
		const items			= () => vector_list.querySelectorAll('.uca-maps-object-viewer-item').length
		// a second object in the SAME FeatureGroup, announced the way every
		// Geoman pm:* handler of the core announces one: update_draw_data
		const add_object = function(lat) {
			const extra = L.circle([lat, -3.70], {radius: 50}).addTo(geolocation.FeatureGroup[1])
			extra.feature = extra.toGeoJSON()
			geolocation.update_draw_data(1)
		}

		add_object(40.41)
		assert.equal(vector_list.children.length, 0, 'expected the closed panel left untouched by the publish')

		tool.object_viewer_control.getContainer().click() // open: populates once
		assert.equal(items(), 2, 'expected the seeded polygon and the circle on the first open')

		add_object(40.42)
		assert.equal(items(), 3, 'expected the open panel to pick up the new object WITHOUT being closed and reopened')
	})

	it('center_on_object fits a Polygon\'s bounds unanimated under camera_is_moving, and leaves the record clean', function() {

		geolocation.active_layer_id = 1
		tool.attach_object_viewer()

		const layer = seeded_layer(1)

		let fit_bounds_called_with = null
		let camera_is_moving_during_call = null
		const original_fit_bounds = geolocation.map.fitBounds
		geolocation.map.fitBounds = function(bounds, options) {
			fit_bounds_called_with = {bounds, options}
			camera_is_moving_during_call = geolocation.camera_is_moving
			return original_fit_bounds.call(this, bounds, options)
		}

		geolocation.is_data_changed = false
		center_on_object(tool, layer)

		assert.isOk(fit_bounds_called_with, 'expected map.fitBounds to be called')
		assert.isOk(fit_bounds_called_with.bounds.equals(layer.getBounds()), 'expected the layer\'s own bounds')
		// the core's dragend/zoomend guard reads the flag when the move ends: an
		// animated zoomend would land after it is lowered and mark the record dirty
		assert.strictEqual(fit_bounds_called_with.options && fit_bounds_called_with.options.animate, false, 'expected an unanimated move')
		assert.equal(camera_is_moving_during_call, true, 'expected camera_is_moving raised DURING the move')
		assert.equal(geolocation.camera_is_moving, false, 'expected camera_is_moving lowered again afterwards')
		assert.equal(geolocation.is_data_changed, false, 'expected NO dirty flag from a read-only "Center" click')
	})

	it('center_on_object (v6\'s "eye" icon) moves a Marker through the masked move_camera at v6\'s zoom 16, record clean', function() {

		geolocation.active_layer_id = 3
		tool.attach_object_viewer()

		const layer = seeded_layer(3)
		const latlng = layer.getLatLng()

		let move_camera_called_with = null
		const original_move_camera = geolocation.move_camera
		geolocation.move_camera = function(lat, lon, zoom) {
			move_camera_called_with = {lat, lon, zoom}
			return original_move_camera.call(this, lat, lon, zoom)
		}

		geolocation.is_data_changed = false
		center_on_object(tool, layer)

		assert.isOk(move_camera_called_with, 'expected move_camera to be called — never a bare map.setView')
		assert.equal(move_camera_called_with.lat, latlng.lat, 'expected the marker\'s own latitude')
		assert.equal(move_camera_called_with.lon, latlng.lng, 'expected the marker\'s own longitude')
		assert.equal(move_camera_called_with.zoom, 16, 'expected v6\'s own hardcoded zoom level')
		assert.equal(geolocation.is_data_changed, false, 'expected NO dirty flag from a read-only "Center" click')
	})

	it('a hidden display state survives a reload (reapply_all/reapply_display, hydrate())', function() {

		tool.attach_console() // hydrate() — the only path that subscribes updated_layer_data_<id_base>
		geolocation.active_layer_id = 1
		tool.attach_object_viewer()

		const layer = seeded_layer(1)
		set_object_display(tool, layer, false)
		assert.equal(layer._path.style.display, 'none', 'expected hidden before the reload event')

		// simulate what a real reload would trigger: the layer's own DOM node
		// gets rebuilt (Leaflet re-adds it to the SVG renderer), losing the
		// inline style — reapply_all (object_console.js hydrate()) is what
		// restores it on the next updated_layer_data_<id_base> publish
		layer._path.style.display = ''
		geolocation.update_draw_data(1)

		assert.equal(layer._path.style.display, 'none', 'expected reapply_display to re-hide the layer on the next hydration pass')
	})

	it('detach_object_viewer removes the control and panel; destroy drops its updated_layer_data subscription', async function() {

		// read off the event manager, not events_tokens: a token the tool
		// forgot to keep would outlive the tool and still be found here
		const event_name	= `updated_layer_data_${geolocation.id_base}`
		const tokens		= () => [...event_manager.tokenMap].filter(([, entry]) => entry.event_name===event_name).map(([token]) => token)
		const before		= tokens()
		tool.attach_object_viewer()
		const added = tokens().filter((token) => !before.includes(token))
		assert.equal(added.length, 1, 'expected attach to subscribe updated_layer_data once')
		const map_container_node = geolocation.map.getContainer()
		assert.isOk(tool.object_viewer_control, 'expected the control attached first')
		assert.isOk(
			map_container_node.querySelector('.uca-maps-object-viewer-control'),
			'expected the button in the DOM before teardown'
		)

		// on_geolocation_destroyed's own call: only delete_self unsubscribes events_tokens
		await tool.destroy(true, true, true)

		assert.equal(tool.object_viewer_control, null, 'expected object_viewer_control cleared')
		assert.equal(tool.object_viewer_panel, null, 'expected object_viewer_panel cleared')
		assert.isNotOk(
			map_container_node.querySelector('.uca-maps-object-viewer-control'),
			'expected the button removed from the DOM'
		)
		assert.isFalse(event_manager.tokenMap.has(added[0]), 'expected the updated_layer_data subscription dropped with the tool')
	})



	// 1x1 (onexone.js) — a toggle with no panel: while armed, clicking a marker
	// draws a 1 m rectangle around it, flagged as uncertainty. The seeded
	// marker (layer_id 3) is the subject throughout.

	it('attach_onexone builds a bare toggle button (no panel), off by default; clicking flips it', function() {

		tool.attach_onexone()

		const control = geolocation.map.getContainer().querySelector('.uca-maps-onexone-control')
		assert.isOk(control, 'expected the "1x1" toggle button')
		assert.equal(is_onexone_enabled(tool), false, 'expected 1x1 mode off by default')

		control.click()
		assert.equal(is_onexone_enabled(tool), true, 'expected 1x1 mode armed after one click')

		control.click()
		assert.equal(is_onexone_enabled(tool), false, 'expected 1x1 mode disarmed after a second click')
	})

	it('create_onexone_rectangle adds a 1 m rectangle to the marker\'s own FeatureGroup, linked by uid, auto-flagged uncertainty', function() {

		const marker = seeded_layer(3)
		const layers_before = geolocation.FeatureGroup[3].getLayers().length

		create_onexone_rectangle(tool, marker)

		const onexone_uid = marker.feature.properties.uca_maps.onexone_uid
		assert.isOk(onexone_uid, 'expected an onexone_uid recorded on the marker')

		const layers_after = geolocation.FeatureGroup[3].getLayers()
		assert.equal(layers_after.length, layers_before + 1, 'expected one new layer (the rectangle) added')

		const rectangle = layers_after.find((candidate) =>
			candidate.feature
			&& candidate.feature.properties
			&& candidate.feature.properties.uca_maps
			&& candidate.feature.properties.uca_maps.uid===onexone_uid
		)
		assert.isOk(rectangle, 'expected to find the rectangle by its uid')
		assert.instanceOf(rectangle, L.Rectangle, 'expected an L.Rectangle, matching v6\'s own L.rectangle(bounds)')
		// a 1 m square centred on the point: v6's `radiusMts = 1` fed to toBounds
		const expected = marker.getLatLng().toBounds(1)
		const bounds = rectangle.getBounds()
		for (const corner of ['getSouthWest', 'getNorthEast']) {
			assert.closeTo(bounds[corner]().lat, expected[corner]().lat, 1e-9, 'expected the ' + corner + ' latitude of a 1 m square')
			assert.closeTo(bounds[corner]().lng, expected[corner]().lng, 1e-9, 'expected the ' + corner + ' longitude of a 1 m square')
		}
		assert.isBelow(bounds.getCenter().distanceTo(marker.getLatLng()), 0.01, 'expected the square centred on the marker')
		assert.equal(
			rectangle.feature.properties.uca_maps.onexone_of,
			marker.feature.properties.uca_maps.uid,
			'expected the rectangle linked back to the marker by uid'
		)
		assert.isOk(
			rectangle.feature.properties.uca_maps.uncertainty,
			'expected the rectangle flagged as uncertainty on creation'
		)
	})

	it('create_onexone_rectangle is idempotent — a marker that already has one does not get a second', function() {

		const marker = seeded_layer(3)
		create_onexone_rectangle(tool, marker)
		const layers_after_first = geolocation.FeatureGroup[3].getLayers().length

		create_onexone_rectangle(tool, marker)
		assert.equal(
			geolocation.FeatureGroup[3].getLayers().length, layers_after_first,
			'expected the second call to no-op (onexone_uid guard, v6 parity: is_oneXone)'
		)
	})

	it('create_onexone_rectangle skips a centroid marker — not a real drawn point a user could 1x1', function() {

		const parent = seeded_layer(1) // seeded polygon
		toggle_centroid(tool, parent)
		const centroid_uid = parent.feature.properties.uca_maps.centroid_uid
		const centroid = layer_by_uid(geolocation.FeatureGroup[1], centroid_uid)
		// a missing centroid would leave by the not-a-Marker exit instead
		assert.instanceOf(centroid, L.Marker, 'expected the centroid marker on the map')
		const layers_before = geolocation.FeatureGroup[1].getLayers().length

		create_onexone_rectangle(tool, centroid)

		assert.equal(
			geolocation.FeatureGroup[1].getLayers().length, layers_before,
			'expected no rectangle created for a centroid marker (centroid_of guard)'
		)
	})

	it('create_onexone_rectangle skips a Marker while Geoman is mid-edit elsewhere on the map (v6\'s geoman_edition_mode guard)', function() {

		const marker = seeded_layer(3)
		const layers_before = geolocation.FeatureGroup[3].getLayers().length

		const original_global_edit_mode_enabled = geolocation.map.pm.globalEditModeEnabled
		geolocation.map.pm.globalEditModeEnabled = () => true
		try {
			create_onexone_rectangle(tool, marker)
		} finally {
			geolocation.map.pm.globalEditModeEnabled = original_global_edit_mode_enabled
		}

		assert.equal(
			geolocation.FeatureGroup[3].getLayers().length, layers_before,
			'expected no rectangle created while Geoman reports a global edit in progress'
		)
	})

	it('popupopen only arms a rectangle while 1x1 mode is on (not before, not after a second click disarms it)', function() {

		tool.attach_onexone()
		const marker = seeded_layer(3)
		const layers_before = geolocation.FeatureGroup[3].getLayers().length
		const button = tool.onexone_control.getContainer()

		marker.openPopup() // 1x1 mode still off
		assert.equal(geolocation.FeatureGroup[3].getLayers().length, layers_before, 'expected no rectangle while disarmed')
		marker.closePopup()

		button.click() // arm
		button.click() // and disarm again
		marker.openPopup()
		assert.equal(geolocation.FeatureGroup[3].getLayers().length, layers_before, 'expected no rectangle once the second click disarms it')
		marker.closePopup()

		button.click() // arm it
		marker.openPopup()
		assert.equal(
			geolocation.FeatureGroup[3].getLayers().length, layers_before + 1,
			'expected one rectangle created once armed and the marker is clicked'
		)
	})

	it('deleting the rectangle clears the marker\'s onexone_uid (usable again); deleting the marker leaves the rectangle', function() {

		tool.attach_onexone()
		const marker = seeded_layer(3)
		create_onexone_rectangle(tool, marker)

		const onexone_uid = marker.feature.properties.uca_maps.onexone_uid
		const rectangle = layer_by_uid(geolocation.FeatureGroup[3], onexone_uid)

		geolocation.FeatureGroup[3].removeLayer(rectangle)
		geolocation.map.fire('pm:remove', {layer: rectangle})

		assert.equal(
			marker.feature.properties.uca_maps.onexone_uid, undefined,
			'expected the dangling onexone_uid cleared once its rectangle is gone'
		)
		assert.isOk(
			geolocation.FeatureGroup[3].hasLayer(marker),
			'expected the marker itself untouched by its rectangle\'s own deletion'
		)

		// re-run: the marker is usable again now that onexone_uid is cleared
		create_onexone_rectangle(tool, marker)
		assert.isOk(marker.feature.properties.uca_maps.onexone_uid, 'expected 1x1 usable again on the same marker')

		// the reverse direction: deleting the MARKER must not touch its rectangle
		const second_uid = marker.feature.properties.uca_maps.onexone_uid
		const second_rectangle = layer_by_uid(geolocation.FeatureGroup[3], second_uid)
		geolocation.FeatureGroup[3].removeLayer(marker)
		geolocation.map.fire('pm:remove', {layer: marker})

		assert.isOk(
			geolocation.FeatureGroup[3].hasLayer(second_rectangle),
			'expected NO cascade delete (deliberate deviation from v6, onexone.js file header): the rectangle stands alone'
		)
	})

	it('deleting the rectangle gives the marker back the editing state the 1x1 locked, unless the box was used since', function() {

		tool.attach_onexone()
		const marker = seeded_layer(3)
		const uca_maps = () => marker.feature.properties.uca_maps
		const rows = [
			{label: 'no state before', before: undefined, since: [], after: undefined},
			{label: 'ticked before', before: true, since: [], after: true},
			{label: 'locked before', before: false, since: [], after: false},
			{label: 'ticked since', before: undefined, since: [true], after: true},
			{label: 'ticked then unticked since', before: true, since: [true, false], after: false}
		]
		for (const row of rows) {
			if (row.before===undefined) {
				delete (marker.feature.properties.uca_maps || {}).geoman_edition
			} else {
				tool.set_geoman_edition(marker, row.before)
			}
			create_onexone_rectangle(tool, marker)
			assert.equal(uca_maps().geoman_edition, false, 'expected the 1x1 to lock the marker: ' + row.label)
			for (const enabled of row.since) {
				tool.set_geoman_edition(marker, enabled)
			}

			const rectangle = layer_by_uid(geolocation.FeatureGroup[3], uca_maps().onexone_uid)
			geolocation.FeatureGroup[3].removeLayer(rectangle)
			geolocation.map.fire('pm:remove', {layer: rectangle})

			assert.equal(uca_maps().geoman_edition, row.after, 'expected the editing state after the delete: ' + row.label)
			assert.notProperty(uca_maps(), 'onexone_prior_geoman_edition', 'expected no trace of the 1x1 left: ' + row.label)
			if (row.after===true) {
				assert.equal(marker.pm.enabled(), true, 'expected a ticked marker unlocked at once: ' + row.label)
			}
		}
	})

	/**
	* 1x1 AND GEOMAN HANDLES, against v6: what the console says about a 1x1,
	* and the handles a new geometry is born with.
	*/

	it('a geometry created on the map is born with its Geoman handles off and says so; a marker and an image carrier are not', async function() {

		tool.attach_console()
		geolocation.active_layer_id = 1

		const polygon = L.polygon([[40.40, -3.71], [40.40, -3.60], [40.50, -3.60]])
		geolocation.map.fire('pm:create', {layer: polygon})
		assert.equal(
			polygon.feature.properties.uca_maps.geoman_edition, false,
			'expected the explicit stored false v6 writes on creation (special_tools_onexone.js)'
		)
		// the stored flag alone would pass on a layer Geoman never touched:
		// replay the core's click sweep (init_feature runs pm.enable() over the
		// group) and the deferred re-assert must take the handles off again
		assert.equal(polygon.pm.enabled(), false, 'expected no vertex handles on a shape nobody asked to edit')
		polygon.pm.enable()
		assert.equal(polygon.pm.enabled(), true, 'expected the simulated core sweep to paint the handles')
		polygon.openPopup()
		await tick()
		assert.equal(polygon.pm.enabled(), false, 'expected the stored false to clear the handles the core sweep painted')

		const marker = L.marker([40.42, -3.68])
		geolocation.map.fire('pm:create', {layer: marker})
		const marker_uca = marker.feature && marker.feature.properties && marker.feature.properties.uca_maps
		assert.isNotOk(
			marker_uca && typeof marker_uca.geoman_edition==='boolean',
			'expected a marker left with no opinion — it carries no vertex handles'
		)

		const carrier = L.rectangle([[40.40, -3.71], [40.50, -3.60]])
		carrier.feature = carrier.toGeoJSON()
		carrier.feature.properties.uca_maps = {image: {id: 'x'}}
		geolocation.map.fire('pm:create', {layer: carrier})
		assert.isNotOk(
			typeof carrier.feature.properties.uca_maps.geoman_edition==='boolean',
			'expected an image carrier left to image_edit.js own seal: a new image arrives editable'
		)
	})

	it('re-asserting a stored geoman state that already holds touches nothing — the loop guard', function() {

		tool.attach_console()
		const polygon = seeded_layer(1)

		// an object with the handles explicitly off, already applied
		tool.set_geoman_edition(polygon, false)

		let disables	= 0
		let enables		= 0
		const real_disable	= polygon.pm.disable.bind(polygon.pm)
		const real_enable	= polygon.pm.enable.bind(polygon.pm)
		polygon.pm.disable	= function() { disables++; return real_disable() }
		polygon.pm.enable	= function(options) { enables++; return real_enable(options) }

		// the core's own republish (update_draw_data fires this on every
		// serialisation) runs reapply_all over every layer
		event_manager.publish('updated_layer_data_' + geolocation.id_base, {})

		// pm.disable() answers with pm:edit, the core with update_draw_data, and
		// that publish comes straight back here: an endless loop
		assert.equal(disables, 0, 'expected NO pm.disable() on a layer already disabled')
		assert.equal(enables, 0, 'expected no pm.enable() either — the stored state is off')

		// control: the re-assert does reach this layer. Enable it behind the
		// stored state's back, as the core's click sweep does
		real_enable()
		event_manager.publish('updated_layer_data_' + geolocation.id_base, {})
		assert.equal(disables, 1, 'expected the re-assert to reach this layer and clear a state that disagrees')
	})

	it('the 1x1 marker console carries v6\'s reference-point line and the uncertainty scale, ringed at tier 1 and titled 1.00 m²', function() {

		tool.attach_console()
		const marker = seeded_layer(3)
		create_onexone_rectangle(tool, marker)

		marker.openPopup()
		const section = tool.panel_node.querySelector('.uca-maps-object-section')

		assert.isOk(
			section.querySelector('.uca-maps-onexone-reference'),
			'expected v6 create_div_oneXone\'s own line: the marker says what it now is'
		)
		const scale	= section.querySelector('.uca-maps-uncertainty-scale')
		const svg	= scale && scale.querySelector('svg')
		assert.isOk(svg, 'expected the scale bar v6 draws as img/escala-1.png')
		assert.equal(svg.querySelectorAll('rect').length, 6, 'expected v6\'s six bands')
		assert.equal(scale.getAttribute('title'), '1.00 m²', 'expected the 1x1\'s own area as the scale\'s title, as v6')
		assert.equal(svg.querySelector('circle').getAttribute('cx'), '20', 'expected the ring on the first band: a 1 m² square is tier 1')
	})

	it('the 1x1 rectangle console prints the nominal area, stores none, and hides the centroid box', function() {

		tool.attach_console()
		const marker = seeded_layer(3)
		create_onexone_rectangle(tool, marker)

		const onexone_uid	= marker.feature.properties.uca_maps.onexone_uid
		const rectangle		= layer_by_uid(geolocation.FeatureGroup[3], onexone_uid)

		assert.equal(
			tool.compute_info(rectangle)[0].value, '1 m²',
			'expected v6\'s nominal area (create_div_polygon_area, is_oneXone branch), not turf\'s measurement'
		)
		assert.equal(
			rectangle.feature.properties.uca_maps.geoman_edition, false,
			'expected the 1x1 rectangle born with the handles off, like any other new geometry'
		)

		// AFTER the render: `render_selected_object` calls sync_measurements,
		// which is the writer the 1x1 guard has to stop — asserted before the
		// render, this could not fail
		rectangle.openPopup()
		assert.equal(
			rectangle.feature.properties.area, undefined,
			'expected no stored area: v6 saves one only in its non-1x1 branch'
		)

		const plain_polygon = seeded_layer(1)
		plain_polygon.openPopup()
		assert.isOk(
			plain_polygon.feature.properties.area,
			'expected the guard to be narrow: a plain polygon still stores its measured area'
		)

		rectangle.openPopup()
		const section = tool.panel_node.querySelector('.uca-maps-object-section')
		assert.isNotOk(section.querySelector('.uca-maps-centroid'), 'expected NO centroid checkbox on a 1x1 (v6 create_div_centroid)')
		assert.isOk(section.querySelector('.uca-maps-uncertainty-scale svg'), 'expected the scale bar beside the checked box')
	})

	it('the 1x1 marker is born locked, as v6, and stays locked whatever a real click does to its popup', async function() {

		tool.attach_console()
		const marker = seeded_layer(3)
		create_onexone_rectangle(tool, marker)

		assert.equal(
			marker.feature.properties.uca_maps.geoman_edition, false,
			'expected the explicit stored false v6 writes on the 1x1 marker (special_tools_onexone.js)'
		)

		// REAL clicks on the icon, so bindPopup's opener and the core's
		// init_feature sweep (pm.enable() over the whole group) run in their own
		// order; counting the sweep's enables proves each click reached it
		assert.isOk(marker._icon, 'expected the marker drawn on the map')
		let sweeps = 0
		const real_enable = marker.pm.enable.bind(marker.pm)
		marker.pm.enable = function(options) { sweeps++; return real_enable(options) }
		const click = async () => {
			marker._icon.dispatchEvent(new MouseEvent('click', {bubbles: true, cancelable: true}))
			await tick()
		}

		await click()
		assert.equal(sweeps, 1, 'expected the first click to reach the core sweep')
		assert.isTrue(marker.isPopupOpen(), 'expected the first click to open the popup')
		assert.equal(marker.pm.enabled(), false, 'expected the re-assert to lock the marker after the sweep')

		const box = tool.panel_node.querySelector('.uca-maps-object-section .uca-maps-geoman input')
		assert.isOk(box, 'expected the "Geoman editing active" checkbox on the marker console')
		assert.equal(box.checked, false, 'expected the checkbox to say the marker is locked')

		// a second click CLOSES a marker's popup (Leaflet's toggle; the open popup
		// swallows that click's 'preclick') and fires no 'popupopen', yet the
		// core sweep still enables the marker
		await click()
		assert.equal(sweeps, 2, 'expected the second click to reach the core sweep')
		assert.isFalse(marker.isPopupOpen(), 'expected the second click to close the popup')
		assert.equal(marker.pm.enabled(), false, 'expected the marker still locked after the closing click')

		// the box is the way out, and no later re-assert locks it back
		await click()
		assert.isTrue(marker.isPopupOpen(), 'expected the third click to reopen the popup')
		const unlock = tool.panel_node.querySelector('.uca-maps-object-section .uca-maps-geoman input')
		unlock.checked = true
		unlock.dispatchEvent(new Event('change'))
		assert.equal(marker.pm.enabled(), true, 'expected the ticked box to unlock the marker')
		await click()
		assert.isFalse(marker.isPopupOpen(), 'expected the fourth click to close the popup')
		assert.equal(marker.pm.enabled(), true, 'expected the marker still unlocked after the closing click\'s re-assert')
	})

	it('a click on the empty map stops editing a ticked object even with its popup open, as v6', async function() {

		tool.attach_console()
		const polygon = seeded_layer(1)
		tool.set_geoman_edition(polygon, true)
		polygon.openPopup()
		await tick()
		assert.equal(polygon.pm.enabled(), true, 'expected the ticked object in edit mode, its popup open')

		// a REAL click on the empty map: the open popup closes on that click's
		// 'preclick' ('popupclose'), then the core's map click turns editing off
		// for every layer; the popupclose re-assert must not turn it back on
		geolocation.map.getContainer().dispatchEvent(new MouseEvent('click', {bubbles: true, cancelable: true}))
		assert.isFalse(polygon.isPopupOpen(), 'expected the click to close the popup')
		assert.equal(polygon.pm.enabled(), false, 'expected the core map click to stop editing')
		await tick()
		assert.equal(polygon.pm.enabled(), false, 'expected the object still off after the deferred re-assert')
	})

	// switching popups fires popupclose then popupopen in one click
	it('switching popups turns a ticked object of another group back on, whichever of popupclose and popupopen comes first', async function() {

		tool.attach_console()
		const polygon	= seeded_layer(1)
		const marker	= seeded_layer(3)
		tool.set_geoman_edition(polygon, true)

		for (const order of [['popupclose', 'popupopen'], ['popupopen', 'popupclose']]) {
			polygon.pm.disable() // what the core's sweep of another group leaves
			assert.equal(polygon.pm.enabled(), false, 'expected the ticked object off before ' + order.join(' + '))
			for (const type of order) {
				geolocation.map.fire(type, {popup: {_source: marker}})
			}
			await tick()
			assert.equal(polygon.pm.enabled(), true, 'expected the full pass to turn the ticked object back on after ' + order.join(' + '))
		}
	})

	// the core's click sweep enables the clicked group and stops every other
	it('a click that closes a marker\'s popup turns a ticked object of another group back on', async function() {

		tool.attach_console()
		const polygon	= seeded_layer(1)
		const marker	= seeded_layer(3)
		tool.set_geoman_edition(polygon, true)

		const click = async () => {
			marker._icon.dispatchEvent(new MouseEvent('click', {bubbles: true, cancelable: true}))
			await tick()
		}
		await click()
		assert.isTrue(marker.isPopupOpen(), 'expected the first click to open the marker\'s popup')
		assert.equal(polygon.pm.enabled(), true, 'expected the ticked object on after the opening click')

		await click()
		assert.isFalse(marker.isPopupOpen(), 'expected the second click to close the popup')
		assert.equal(polygon.pm.enabled(), true, 'expected the ticked object back on after the closing click')
	})

	// with a popup, Leaflet stops the click at the polygon; without one it
	// reaches the map's own click too, and that is still not the empty map
	it('a real click on a ticked polygon, another popup open, leaves it in edit mode, with or without its own popup', async function() {

		tool.attach_console()
		const polygon	= seeded_layer(1)
		const marker	= seeded_layer(3)
		tool.set_geoman_edition(polygon, true)
		const popup		= polygon.getPopup()
		assert.isOk(popup, 'expected the core to bind the polygon a popup')

		try {
			for (const with_popup of [true, false]) {
				if (!with_popup) {
					polygon.unbindPopup()
				}
				marker.openPopup()
				await tick()

				assert.isOk(polygon._path, 'expected the polygon drawn on the map')
				polygon._path.dispatchEvent(new MouseEvent('click', {bubbles: true, cancelable: true}))
				assert.isFalse(marker.isPopupOpen(), 'expected the click to close the marker\'s popup')
				await tick()
				assert.equal(polygon.pm.enabled(), true, 'expected the ticked polygon in edit mode after the deferred re-assert, ' + (with_popup ? 'with' : 'without') + ' its popup')
				polygon.closePopup()
				await tick()
			}
		} finally {
			polygon.bindPopup(popup)
		}
	})

	// the re-assert is a microtask: done before the browser paints, so a locked
	// object never flashes the handles the core sweep gave it
	it('a real click on a locked polygon takes the sweep\'s handles off before the browser can paint', async function() {

		tool.attach_console()
		const polygon = seeded_layer(1)
		tool.set_geoman_edition(polygon, false)
		let sweeps = 0
		const real_enable = polygon.pm.enable.bind(polygon.pm)
		polygon.pm.enable = function(options) { sweeps++; return real_enable(options) }

		try {
			assert.isOk(polygon._path, 'expected the polygon drawn on the map')
			polygon._path.dispatchEvent(new MouseEvent('click', {bubbles: true, cancelable: true}))
			assert.equal(sweeps, 1, 'expected the click to reach the core sweep')
			assert.equal(polygon.pm.enabled(), true, 'expected the sweep to have turned the handles on')
			// microtasks only: a paint needs a task boundary, and none has passed
			await Promise.resolve()
			assert.equal(polygon.pm.enabled(), false, 'expected the handles off before any later task could paint them')
		} finally {
			polygon.pm.enable = real_enable
			polygon.closePopup()
		}
	})

	it('detach_console takes its five map listeners off and cancels a re-assert still queued', async function() {

		tool.attach_console()
		const map		= geolocation.map
		const handlers	= ['popupopen', 'popupclose', 'click', 'pm:create', 'pm:remove'].map((type) => {
			const handler = tool['_' + type.replace('pm:', 'pm') + '_handler']
			assert.isTrue(map.listens(type, handler), 'expected the console listening to ' + type)
			return [type, handler]
		})

		// a re-assert queued over a locked polygon the core sweep enabled
		const polygon = seeded_layer(1)
		tool.set_geoman_edition(polygon, false)
		polygon.pm.enable()
		map.fire('popupclose')

		detach_console(tool)

		for (const [type, handler] of handlers) {
			assert.isFalse(map.listens(type, handler), 'expected ' + type + ' taken off the map')
		}
		await tick()
		assert.equal(polygon.pm.enabled(), true, 'expected the queued re-assert cancelled, not run on a detached console')
	})

	// the core drops events_tokens only on destroy(true): the tool drops its own
	it('destroy(false) leaves no subscription of the tool behind', async function() {

		tool.attach_console()
		tool.attach_object_viewer()
		const tokens = [...tool.events_tokens]
		assert.isAtLeast(tokens.length, 2, 'expected the console and the viewer subscribed')
		const live = () => event_manager.get_events().filter((event) => tokens.includes(event.token))
		assert.equal(live().length, tokens.length, 'expected every token live before teardown')

		await tool.destroy(false, false, false)

		assert.deepEqual(live(), [], 'expected the tool\'s subscriptions gone after destroy(false)')
	})

	it('detach_onexone removes the button and takes both map listeners off', async function() {

		tool.attach_onexone()
		const map					= geolocation.map
		const map_container_node	= map.getContainer()
		assert.isOk(tool.onexone_control, 'expected the control attached first')
		const listeners = [['popupopen', tool._onexone_popupopen_handler], ['pm:remove', tool._onexone_pmremove_handler]]
		for (const [type, handler] of listeners) {
			assert.isTrue(map.listens(type, handler), 'expected 1x1 listening to ' + type)
		}

		await tool.destroy(false, false, false)

		for (const [type, handler] of listeners) {
			assert.isFalse(map.listens(type, handler), 'expected ' + type + ' taken off the map')
		}
		assert.equal(tool.onexone_control, null, 'expected onexone_control cleared')
		assert.equal(tool._onexone_popupopen_handler, null, 'expected _onexone_popupopen_handler cleared')
		assert.equal(tool._onexone_pmremove_handler, null, 'expected _onexone_pmremove_handler cleared')
		assert.isNotOk(
			map_container_node.querySelector('.uca-maps-onexone-control'),
			'expected the button removed from the DOM'
		)
	})



	// TOOLBAR (toolbar.js) — one Leaflet bar, one button per functionality,
	// one panel open at a time.

	it('edit() stacks the buttons in attach order; an es/cat/eus section_lang adds Catastro and UA after WMS', async function() {

		const NAMES = {
			'uca-maps-control'					: 'UCA',
			'uca-maps-map-image-control'		: 'IMG',
			'uca-maps-object-viewer-control'	: 'OBJ',
			'uca-maps-onexone-control'			: '1x1',
			'uca-maps-xyz-control'				: 'XYZ',
			'uca-maps-wms-control'				: 'WMS',
			'uca-maps-catastro-control'			: 'Catastro',
			'uca-maps-ua-control'				: 'UA',
			'uca-maps-upload-control'			: 'UP',
			'uca-maps-place-search-control'		: 'Search',
			'uca-maps-geolocate-control'		: 'GPS',
			'uca-maps-legend-control'			: 'Legend',
			'uca-maps-roman-control'			: 'Roma'
		}
		const rows = [
			{section_lang: undefined,	order: ['UCA', 'IMG', 'OBJ', '1x1', 'XYZ', 'WMS', 'UP', 'Search', 'GPS', 'Legend', 'Roma']},
			{section_lang: 'lg-spa',	order: ['UCA', 'IMG', 'OBJ', '1x1', 'XYZ', 'WMS', 'Catastro', 'UA', 'UP', 'Search', 'GPS', 'Legend', 'Roma']}
		]
		for (const row of rows) {
			// the second row reuses the instance: destroy(false) only detaches
			tool.geolocation			= geolocation
			geolocation.section_lang	= row.section_lang
			assert.isNotOk(geolocation.map.getContainer().querySelector('.uca-maps-toolbar-button'), 'expected no button before edit() runs')
			await run_edit()

			const corner = tool.map_control.getContainer().closest('.leaflet-top.leaflet-left')
			assert.isOk(corner, 'expected the "UCA" button inside Leaflet\'s topleft corner')
			const order = Array.from(corner.querySelectorAll('.uca-maps-toolbar-button'), (button) =>
				Object.keys(NAMES).filter((name) => button.classList.contains(name)).map((name) => NAMES[name]).join('+') || 'unknown'
			)
			assert.deepEqual(order, row.order, 'expected the top-to-bottom order with section_lang ' + row.section_lang)

			await tool.destroy(false, false, false)
		}
	})

	it('opening one panel closes any other panel already open (only one at a time)', function() {

		tool.attach_console()
		tool.attach_map_image_download_control()
		tool.attach_object_viewer()

		const uca_control	= geolocation.map.getContainer().querySelector('.uca-maps-control')
		const img_control	= geolocation.map.getContainer().querySelector('.uca-maps-map-image-control')
		const obj_control	= geolocation.map.getContainer().querySelector('.uca-maps-object-viewer-control')

		uca_control.click()
		assert.equal(tool.panel_node.hidden, false, 'expected UCA open after its own click')

		img_control.click()
		assert.equal(tool.map_image_panel.hidden, false, 'expected IMG open after its own click')
		assert.equal(tool.panel_node.hidden, true, 'expected UCA closed by opening IMG')

		obj_control.click()
		assert.equal(tool.object_viewer_panel.hidden, false, 'expected OBJ open after its own click')
		assert.equal(tool.map_image_panel.hidden, true, 'expected IMG closed by opening OBJ')
		assert.equal(tool.panel_node.hidden, true, 'expected UCA to stay closed')

		// a sibling closed UCA: its own button still reopens it, since the
		// toggle reads the panel's `hidden`, never a flag of its own
		uca_control.click()
		assert.equal(tool.panel_node.hidden, false, 'expected UCA reopened by its own click, even though a sibling force-closed it earlier')
		assert.equal(tool.map_image_panel.hidden, true, 'expected IMG closed by reopening UCA')
		assert.equal(tool.object_viewer_panel.hidden, true, 'expected OBJ closed by reopening UCA')
	})

	it('"1x1" has no panel to close/be closed by — arming it does not touch an already-open panel', function() {

		tool.attach_console()
		tool.attach_onexone()

		const uca_control		= geolocation.map.getContainer().querySelector('.uca-maps-control')
		const onexone_control	= geolocation.map.getContainer().querySelector('.uca-maps-onexone-control')

		uca_control.click()
		assert.equal(tool.panel_node.hidden, false, 'expected UCA open after its own click')

		onexone_control.click()
		assert.equal(is_onexone_enabled(tool), true, 'expected 1x1 armed by its own click')
		assert.equal(tool.panel_node.hidden, false, 'expected UCA to stay open — 1x1 has no panel, so it never enters the exclusivity set')
	})

	it('toolbar buttons are links of ONE Leaflet bar: an icon each, no visible label; the title names each', async function() {

		tool.attach_console()
		tool.attach_xyz_basemaps()

		const uca_link = geolocation.map.getContainer().querySelector('.uca-maps-control')
		assert.equal(uca_link.tagName, 'A', 'expected the <a> Leaflet\'s .leaflet-bar styles as a button')
		const bar = uca_link.parentElement
		assert.isTrue(bar.classList.contains('leaflet-bar') && bar.classList.contains('uca-maps-toolbar'), 'expected the shared bar as its parent')
		assert.equal(uca_link.getAttribute('role'), 'button')
		assert.equal(uca_link.getAttribute('href'), '#', 'expected an href: without it the link takes no keyboard focus')
		assert.isOk(uca_link.title, 'expected a hover title')
		assert.equal(uca_link.getAttribute('aria-label'), uca_link.title, 'expected the title as the accessible name')
		assert.isOk(uca_link.querySelector(':scope > .uca-maps-toolbar-glyph.uca-maps-icon-info'), 'expected the core "info" icon')
		assert.equal(uca_link.textContent, '', 'expected no visible label beside an icon')

		const xyz_link = geolocation.map.getContainer().querySelector('.uca-maps-xyz-control')
		assert.equal(xyz_link.parentElement, bar, 'expected the second button in the SAME bar, not a control of its own')
		assert.isOk(xyz_link.querySelector(':scope > .uca-maps-toolbar-glyph.uca-maps-icon-xyz_basemaps'), 'expected the tool\'s own "xyz_basemaps" icon')
		assert.equal(xyz_link.textContent, '', 'expected no visible label: the icon replaced "XYZ"')

		// the '#' href must not navigate the page
		const click = new MouseEvent('click', {bubbles: true, cancelable: true})
		uca_link.dispatchEvent(click)
		assert.isTrue(click.defaultPrevented, 'expected the click\'s default prevented')
		assert.equal(tool.panel_node.hidden, false, 'expected the click on the link to reach the button\'s handler')

		// the bar goes with its last button
		detach_xyz_basemaps(tool)
		assert.equal(uca_link.parentElement, bar, 'expected the bar kept while a button remains')
		assert.isTrue(bar.isConnected)
		await tool.destroy(false, false, false)
		assert.isFalse(bar.isConnected, 'expected the bar removed with its last button')
		assert.isNull(tool._toolbar_bar, 'expected no stale bar handle')
	})

	// an icon is a CSS mask of a core theme icon or of the tool's own (img/): a
	// name with no rule, or a rule on a missing file, paints an empty square
	it('with the tool CSS, every toolbar button is the same square, they stack with no gap, and each icon paints', async function() {

		await with_tool_css(async () => {
			geolocation.section_lang = 'lg-spa' // gates Catastro and UA in
			await run_edit()

			const corner	= tool.map_control.getContainer().closest('.leaflet-top.leaflet-left')
			assert.equal(corner.querySelectorAll('.uca-maps-toolbar').length, 1, 'expected ONE bar')

			// the zoom bar stays first, set 30px apart from the tool's bar
			const zoom	= corner.querySelector('.leaflet-control-zoom')
			const bar	= corner.querySelector('.uca-maps-toolbar')
			assert.isOk(zoom, 'expected Leaflet\'s zoom bar in the same corner')
			assert.equal(zoom.compareDocumentPosition(bar) & Node.DOCUMENT_POSITION_FOLLOWING, Node.DOCUMENT_POSITION_FOLLOWING, 'expected the zoom bar above the tool\'s')
			assert.closeTo(bar.getBoundingClientRect().top - zoom.getBoundingClientRect().bottom, 30, 0.5, 'expected 30px between the zoom bar and the tool\'s')
			const links		= Array.from(corner.querySelectorAll('.uca-maps-toolbar > .uca-maps-toolbar-button'))

			const rects = links.map((node) => node.getBoundingClientRect())
			const sizes = new Set(rects.map((rect) => Math.round(rect.width) + 'x' + Math.round(rect.height)))
			assert.equal(sizes.size, 1, 'expected one size for every button, got ' + [...sizes].join(', '))
			const [width, height] = [...sizes][0].split('x').map(Number)
			assert.equal(width, height, 'expected a square')
			assert.isAtLeast(width, 26, 'expected Leaflet\'s bar size, not a collapsed box')

			// the goal is Geoman's own squares, top right
			const geoman = geolocation.map.getContainer().querySelector('.leaflet-pm-toolbar a.leaflet-buttons-control-button')
			assert.isOk(geoman, 'expected Geoman\'s draw bar on the map to compare with')
			const geoman_rect = geoman.getBoundingClientRect()
			assert.equal(Math.round(geoman_rect.width) + 'x' + Math.round(geoman_rect.height), width + 'x' + height, 'expected the size of Geoman\'s squares')

			// and Geoman's hairline between squares: under every one but the last
			const line		= (node) => getComputedStyle(node).borderBottomWidth + ' ' + getComputedStyle(node).borderBottomStyle + ' ' + getComputedStyle(node).borderBottomColor
			const geoman_line	= line(geoman)
			assert.notInclude(geoman_line, 'none', 'expected Geoman\'s first square to carry the hairline to compare with')
			links.slice(0, -1).forEach((node) => {
				assert.equal(line(node), geoman_line, 'expected Geoman\'s hairline under "' + (node.textContent || node.getAttribute('aria-label')) + '"')
			})
			assert.include(line(links[links.length - 1]), 'none', 'expected no hairline under the last square')

			for (let i = 1; i < rects.length; i++) {
				assert.closeTo(rects[i].top, rects[i - 1].bottom, 0.5, 'expected no gap above "' + (links[i].textContent || links[i].getAttribute('aria-label')) + '"')
			}

			// the exact set, so a new icon button has to be added here to be measured
			const glyphs = links.map((node) => node.querySelector(':scope > .uca-maps-toolbar-glyph')).filter(Boolean)
			const icon_of = (glyph) => [...glyph.classList].find((c) => c.startsWith('uca-maps-icon-')).slice('uca-maps-icon-'.length)
			assert.equal(glyphs.length, links.length, 'expected an icon on every button')
			const CORE_ICONS = ['download', 'info', 'search', 'upload']
			// pixels each own icon paints at 24x24, as banked: a frame alone clears
			// any fixed floor, so a lost inner mark is caught against its own count
			const OWN_ICON_PIXELS = {administrative_units: 229, catastro: 268, geolocate: 207, legend: 152, object_viewer: 308, onexone: 301, roman_empire: 286, wms_services: 280, xyz_basemaps: 240}
			const OWN_ICONS = Object.keys(OWN_ICON_PIXELS)
			assert.deepEqual(glyphs.map(icon_of).sort(), [...CORE_ICONS, ...OWN_ICONS].sort(), 'expected every icon button measured')
			for (const glyph of glyphs) {
				const name	= glyph.parentElement.getAttribute('aria-label')
				const style	= getComputedStyle(glyph)
				const mask	= style.maskImage || style.webkitMaskImage
				const url	= /^url\("(.+)"\)$/.exec(mask)
				assert.isOk(url, 'expected a mask image on the "' + name + '" icon, got ' + mask)
				// a rule is written by hand per icon: a slip paints another core icon, served too
				const home = CORE_ICONS.includes(icon_of(glyph)) ? '/core/themes/default/icons/' : '/tools/tool_uca_maps/img/'
				assert.isTrue(new URL(url[1], location.href).pathname.endsWith(home + icon_of(glyph) + '.svg'), 'expected the "' + name + '" button to paint its own icon, got ' + url[1])
				const response = await fetch(url[1])
				assert.equal(response.status, 200, 'expected the "' + name + '" icon served: ' + url[1])
				const source = await response.text()
				// served is not painted: an SVG that fails to parse, or draws nothing,
				// leaves the mask empty. A <text> paints in whatever font the machine has
				const painted = await opaque_pixels(source)
				assert.isAtLeast(painted, 24, 'expected the "' + name + '" icon to paint at 24x24')
				if (OWN_ICONS.includes(icon_of(glyph))) {
					assert.isNull(new DOMParser().parseFromString(source, 'image/svg+xml').querySelector('text'), 'expected the "' + name + '" icon drawn in outlines, not <text>')
					const floor = Math.floor(OWN_ICON_PIXELS[icon_of(glyph)] * 0.9)
					assert.isAtLeast(painted, floor, 'expected the "' + name + '" icon to paint all its marks; redrawn on purpose, bank its count in OWN_ICON_PIXELS')
				}
			}
		})
	})

	// the buttons once copied the action chrome by hand: only the disabled
	// state told a copy from the shared mixin, so both states are compared
	it('with the tool CSS, a panel header carries the hue as an edge, and every action button shares one chrome', async function() {

		await with_tool_css(async () => {
			seeded_layer(1).feature.properties.name = 'Saguntum' // a property row, with its ✕
			open_console_on(1)
			tool.attach_xyz_basemaps()
			tool.attach_map_image_download_control()
			geolocation.map.getContainer().querySelector('.uca-maps-xyz-control').click()

			const probe = document.createElement('div')
			probe.style.cssText = 'background-color: var(--tool_uca_maps)'
			tool.xyz_panel.appendChild(probe)
			const hue = getComputedStyle(probe).backgroundColor
			const unpainted = document.createElement('div')
			tool.xyz_panel.appendChild(unpainted)
			assert.notEqual(hue, getComputedStyle(unpainted).backgroundColor, 'expected the tool hue to resolve')
			unpainted.remove()

			const header = getComputedStyle(tool.xyz_panel.querySelector('.uca-maps-panel-header'))
			assert.equal(header.borderTopColor, hue, 'expected the hue as the header\'s top edge')
			assert.equal(header.borderTopWidth, '4px')
			assert.notEqual(header.backgroundColor, hue, 'expected no title on the hue')

			const chrome = (node) => {
				const style = getComputedStyle(node)
				return [style.backgroundColor, style.color, style.paddingTop, style.paddingLeft, style.fontSize, style.borderRadius, style.whiteSpace, style.opacity, style.cursor].join(' | ')
			}
			const xyz_add		= tool.xyz_panel.querySelector('.uca-maps-xyz-add-button')
			const image_btn		= tool.map_image_panel.querySelector('.uca-maps-map-image-button')
			const object_btn	= tool.panel_node.querySelector('.uca-maps-object-section .uca-maps-property-add-button')
			const delete_btn	= tool.panel_node.querySelector('.uca-maps-object-section .uca-maps-property-delete')
			assert.isOk(image_btn, 'expected the map-image download button')
			assert.isOk(object_btn, 'expected the object section\'s Add button')
			assert.isOk(delete_btn, 'expected the property row\'s ✕')
			assert.equal(getComputedStyle(xyz_add).backgroundColor, hue, 'expected the action fill on the tool hue')
			assert.equal(getComputedStyle(xyz_add).cursor, 'pointer')
			assert.equal(chrome(image_btn), chrome(xyz_add), 'expected the map-image button on the shared action chrome')
			assert.equal(chrome(object_btn), chrome(xyz_add), 'expected the object section\'s buttons on the shared action chrome')

			// the ✕ is the secondary variant of the same mixin
			const secondary = document.createElement('div')
			secondary.style.cssText = 'background-color: var(--bg_fill_inverse)'
			tool.panel_node.appendChild(secondary)
			assert.equal(getComputedStyle(delete_btn).backgroundColor, getComputedStyle(secondary).backgroundColor, 'expected the ✕ on the secondary fill')
			assert.equal(getComputedStyle(delete_btn).cursor, 'pointer')

			for (const node of [xyz_add, image_btn, object_btn, delete_btn]) {
				node.disabled = true
			}
			assert.equal(getComputedStyle(xyz_add).opacity, '0.4', 'expected a disabled action dimmed')
			assert.equal(getComputedStyle(xyz_add).cursor, 'default')
			assert.equal(chrome(image_btn), chrome(xyz_add), 'expected the map-image button dimmed as the shared chrome')
			assert.equal(chrome(object_btn), chrome(xyz_add), 'expected the object section\'s buttons dimmed as the shared chrome')
			assert.equal(getComputedStyle(delete_btn).opacity, '0.4', 'expected the ✕ dimmed by the mixin too')
			assert.equal(getComputedStyle(delete_btn).cursor, 'default')
		})
	})

	it('with the tool CSS, a panel line takes the tint of its type: error by default, success, warning, working', async function() {

		await with_tool_css(async () => {
			tool.attach_file_upload()
			const message = tool.upload_panel.querySelector('.uca-maps-upload-message')
			message.hidden = false

			const tint_of = (token) => {
				const probe = document.createElement('div')
				probe.style.backgroundColor = 'var(' + token + ')'
				tool.upload_panel.appendChild(probe)
				const value = getComputedStyle(probe).backgroundColor
				probe.remove()
				return value
			}
			const expected = {
				error	: tint_of('--uca_maps_msg_error_bg'),
				ok		: tint_of('--uca_maps_msg_ok_bg'),
				warning	: tint_of('--uca_maps_msg_warning_bg'),
				info	: tint_of('--bg_surface_alt')
			}
			assert.equal(new Set(Object.values(expected)).size, 4, 'expected four distinct tints to tell apart')

			delete message.dataset.type
			assert.equal(getComputedStyle(message).backgroundColor, expected.error, 'expected an untyped line read as an error')
			for (const type of ['error', 'ok', 'warning', 'info']) {
				message.dataset.type = type
				assert.equal(getComputedStyle(message).backgroundColor, expected[type], 'expected the ' + type + ' tint')
			}
		})
	})

	it('with the tool CSS, every "nothing here yet" line looks the same: the console\'s and the object list\'s', async function() {

		await with_tool_css(async () => {
			tool.attach_console()
			tool.attach_object_viewer()
			// the vector list holds the seeded polygon: the empty line is the raster list's
			tool.object_viewer_control.getContainer().click()

			const console_line	= tool.panel_node.querySelector('.uca-maps-empty-state')
			const list_line		= tool.object_viewer_panel.querySelector('.uca-maps-empty-state')
			assert.isOk(console_line, 'expected the console\'s empty line on the shared class')
			assert.isOk(list_line, 'expected the object list\'s empty line on the shared class')

			const look = (node) => {
				const style = getComputedStyle(node)
				return [style.color, style.fontStyle, style.paddingTop, style.marginTop].join(' | ')
			}
			assert.equal(look(list_line), look(console_line), 'expected one look for both')

			const probe = document.createElement('span')
			probe.style.color = 'var(--fg_muted)'
			tool.panel_node.appendChild(probe)
			assert.equal(getComputedStyle(console_line).color, getComputedStyle(probe).color, 'expected the muted ink')
			assert.equal(getComputedStyle(console_line).fontStyle, 'italic')
		})
	})

	// the UCA console is the one panel left anchored: centred, it would cover
	// the very geometry it inspects
	it('the image, objects, XYZ, UA, upload and search panels open centred under their title; the console stays by its button', function() {

		geolocation.section_lang = 'lg-spa' // gates UA in
		const cases = [
			['attach_map_image_download_control',	'map_image_panel',		'map_image_control',		'Download map as image'],
			['attach_object_viewer',				'object_viewer_panel',	'object_viewer_control',	'Objects'],
			['attach_xyz_basemaps',					'xyz_panel',			'xyz_control',				'XYZ basemaps'],
			['attach_administrative_units',			'ua_panel',				'ua_control',				'Administrative Units'],
			['attach_file_upload',					'upload_panel',			'upload_control',			'Upload file to map'],
			['attach_place_search',					'place_search_panel',	'place_search_control',		'Place search']
		]
		for (const [attach, panel_key, control_key, title] of cases) {
			tool[attach]()
			const panel = tool[panel_key]
			tool[control_key].getContainer().click()
			assert.equal(panel.hidden, false, panel_key + ': expected open after its click')
			assert.isTrue(panel.classList.contains('uca-maps-panel-centered'), panel_key + ': expected the centred variant')
			assert.equal(panel.querySelectorAll('.uca-maps-panel-header').length, 1, panel_key + ': expected toolbar.js\'s header only')
			const title_node = panel.querySelector(':scope > .uca-maps-panel-header > .uca-maps-panel-title')
			assert.equal(title_node && title_node.textContent, title, panel_key + ': expected the header titled')
			assert.isOk(panel.querySelector(':scope > .uca-maps-panel-header > .uca-maps-panel-close'), panel_key + ': expected the ×')
			assert.equal(panel.style.getPropertyValue('--uca_maps_anchor_top') + panel.style.getPropertyValue('--uca_maps_anchor_left'), '', panel_key + ': expected no anchoring beside its button')
		}

		tool.attach_console()
		tool.map_control.getContainer().click()
		assert.isFalse(tool.panel_node.classList.contains('uca-maps-panel-centered'), 'expected the console not centred')
		assert.notEqual(tool.panel_node.style.getPropertyValue('--uca_maps_anchor_left'), '', 'expected the console anchored beside its button')

		// what the phone rule lays every panel against: the bar's live right edge
		const map_rect	= geolocation.map.getContainer().getBoundingClientRect()
		const bar_rect	= tool.map_control.getContainer().parentNode.getBoundingClientRect()
		assert.equal(
			tool.panel_node.style.getPropertyValue('--uca_maps_bar_edge'),
			Math.round(bar_rect.right - map_rect.left + 8) + 'px',
			'expected the bar\'s edge measured on show'
		)
		// and below the core's view box, which the map cannot stack above
		const view_box = geolocation.map.getContainer().parentNode.querySelector(':scope > .map_inputs')
		assert.isOk(view_box, 'expected the core\'s view box beside the map')
		const box_bottom = Math.round(view_box.getBoundingClientRect().bottom - map_rect.top + 8)
		assert.equal(
			tool.panel_node.style.getPropertyValue('--uca_maps_panel_top'),
			Math.max(8, box_bottom) + 'px',
			'expected the panel\'s phone top measured below the view box'
		)
	})

	it('with the tool CSS, the console renders beside its button, with no inline top/left', async function() {

		await with_tool_css(async () => {
			tool.attach_console()
			tool.map_control.getContainer().click()
			const panel			= tool.panel_node
			const map_rect		= geolocation.map.getContainer().getBoundingClientRect()
			const button_rect	= tool.map_control.getContainer().getBoundingClientRect()
			const rect			= panel.getBoundingClientRect()
			assert.equal(panel.style.top + panel.style.left, '', 'expected no inline top/left: it would beat the phone rule')
			assert.equal(Math.round(rect.left - map_rect.left), Math.round(button_rect.right - map_rect.left + 8), 'expected the console right of its button')
			assert.equal(Math.round(rect.top - map_rect.top), Math.round(button_rect.top - map_rect.top), 'expected the console level with its button')
		})
	})

	it('on a phone every panel lies beside the bar and below the view box, so another button switches panels', async function() {

		await with_tool_css(() => with_phone_rules('.uca-maps-panel', () => {
			tool.attach_console()
			tool.attach_xyz_basemaps()
			tool.attach_file_upload()
			const map_node	= geolocation.map.getContainer()
			const map_rect	= map_node.getBoundingClientRect()
			const view_box	= map_node.parentNode.querySelector(':scope > .map_inputs')
			const cases = [
				[tool.map_control, tool.panel_node, 'console'],
				[tool.xyz_control, tool.xyz_panel, 'XYZ (centred on a desktop)'],
				[tool.upload_control, tool.upload_panel, 'upload (centred on a desktop)']
			]
			let previous = null
			for (const [control, panel, name] of cases) {
				// no close in between: the bar stays reachable while a panel is open
				control.getContainer().click()
				assert.isFalse(panel.hidden, name + ': expected open')
				if (previous) assert.isTrue(previous.hidden, name + ': expected the previous panel switched off')
				const rect		= panel.getBoundingClientRect()
				const bar_rect	= control.getContainer().parentNode.getBoundingClientRect()
				assert.isAtLeast(Math.round(rect.left), Math.round(bar_rect.right), name + ': expected beside the bar, not over it')
				assert.isAtLeast(Math.round(rect.top), Math.round(view_box.getBoundingClientRect().bottom), name + ': expected below the view box')
				assert.isAtMost(Math.round(rect.right), Math.round(map_rect.right), name + ': expected inside the map')
				assert.isAtMost(Math.round(rect.bottom), Math.round(map_rect.bottom), name + ': expected inside the map')
				previous = panel
			}
		}))
	})

	it('on a phone every control in a panel is a 44px target with 16px text, and the projection fields stand one per line', async function() {

		await with_tool_css(() => with_phone_rules('.uca-maps-', () => {
			tool.attach_xyz_basemaps()
			tool.attach_file_upload()
			// the phone tier's own selector (scripts/tool_viewport_check.ts): a
			// checkbox or radio is judged by its label
			const controls = 'button, select, input:not([type=hidden]):not([type=checkbox]):not([type=radio]), textarea, [role=button]'
			for (const [control, panel, name] of [[tool.xyz_control, tool.xyz_panel, 'XYZ'], [tool.upload_control, tool.upload_panel, 'upload']]) {
				control.getContainer().click()
				const rendered = [...panel.querySelectorAll(controls)].filter((el) => el.getBoundingClientRect().width > 0)
				assert.isAtLeast(rendered.length, 3, name + ': expected its controls rendered')
				for (const el of rendered) {
					const rect = el.getBoundingClientRect()
					assert.isAtLeast(Math.round(Math.min(rect.width, rect.height)), 44, name + ': ' + el.className + ' expected a 44px target')
					if (el.matches('input, select, textarea')) {
						assert.isAtLeast(parseFloat(getComputedStyle(el).fontSize), 16, name + ': ' + el.className + ' expected 16px text')
					}
				}
			}

			const row		= tool.upload_panel.querySelector('.uca-maps-upload-epsg-row')
			const fields	= ['.uca-maps-upload-epsg', '.uca-maps-upload-zone', '.uca-maps-upload-band'].map((selector) => row.querySelector(selector))
			const tops		= fields.map((field) => Math.round(field.getBoundingClientRect().top))
			assert.isTrue(tops[0] < tops[1] && tops[1] < tops[2], 'expected EPSG, zone and band one per line')
			for (const label of row.querySelectorAll(':scope > span')) {
				assert.isAtMost(label.getBoundingClientRect().height, parseFloat(getComputedStyle(label).fontSize) * 2, label.textContent + ' expected its label on one line, not one letter per line')
			}
		}))
	})

	// a refusal lands under the form that fired it; in a panel that scrolls (a
	// phone) it would sit below the fold, so it is scrolled into view
	it('on a phone a panel message below the fold is scrolled into the panel\'s view', async function() {

		await with_tool_css(() => with_phone_rules('.uca-maps-', async () => {
			tool.attach_file_upload()
			tool.upload_control.getContainer().click()
			const panel		= tool.upload_panel
			assert.isAbove(panel.scrollHeight, panel.clientHeight + 1, 'expected the upload panel to scroll')
			panel.scrollTop = 0
			const message	= panel.querySelector('.uca-maps-upload-message')
			const submit	= panel.querySelector('.uca-maps-upload-submit')
			// the line is hidden (no box) until shown; the button it sits under is not
			assert.isAbove(submit.getBoundingClientRect().bottom, panel.getBoundingClientRect().bottom, 'expected the form\'s button, and the line under it, below the fold')

			submit.click() // no file chosen: refused
			const frames = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
			// the scroll is smooth: wait for it to start, then to settle
			let last = -1
			for (let i = 0; i < 90 && (message.hidden || panel.scrollTop===0 || panel.scrollTop!==last); i++) {
				last = panel.scrollTop
				await frames()
			}
			assert.isFalse(message.hidden, 'expected the refusal shown')
			const rect	= message.getBoundingClientRect()
			const view	= panel.getBoundingClientRect()
			assert.isAtLeast(Math.round(rect.top), Math.round(view.top), 'expected the message inside the panel\'s view')
			assert.isAtMost(Math.round(rect.bottom), Math.round(view.bottom), 'expected the message inside the panel\'s view')
		}))
	})

	// 'nearest': a line that appears already in view moves neither the panel nor
	// the page, or every refusal would jump the form the user is filling
	it('a panel message that appears in view keeps the panel and the page still', async function() {

		await with_tool_css(async () => {
			tool.attach_xyz_basemaps()
			tool.xyz_control.getContainer().click()
			const panel		= tool.xyz_panel
			const form		= panel.querySelector('.uca-maps-xyz-add-form')
			// a panel that scrolls, the form's top line (where the message lands)
			// 60px into its view: 'start' would lift it to the top, 'nearest' must not
			panel.style.maxHeight = '200px'
			const into = form.getBoundingClientRect().top - panel.getBoundingClientRect().top + panel.scrollTop
			panel.scrollTop = into - 60
			assert.isAbove(panel.scrollHeight - panel.clientHeight, panel.scrollTop + 60, 'expected room to scroll further')
			const scroller	= document.scrollingElement
			const page_top	= scroller.scrollTop
			const panel_top	= panel.scrollTop

			form.querySelector('.uca-maps-xyz-add-button').click() // no URL: refused
			const frames = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
			for (let i = 0; i < 15; i++) await frames()

			assert.isFalse(panel.querySelector('.uca-maps-xyz-message').hidden, 'expected the refusal shown')
			assert.equal(panel.scrollTop, panel_top, 'expected the panel still')
			assert.equal(scroller.scrollTop, page_top, 'expected the page still')
		})
	})

	it('on a phone the bar keeps the size of the map\'s other controls, and a map shorter than the bar scrolls it in its own box', async function() {

		await with_tool_css(() => with_phone_rules('.uca-maps-toolbar', () => {
			// the whole bar, in the tool's order: 13 squares, taller than the map
			geolocation.section_lang = 'lg-spa' // gates UA in
			tool.attach_console()
			tool.attach_map_image_download_control()
			tool.attach_object_viewer()
			tool.attach_onexone()
			tool.attach_xyz_basemaps()
			tool.attach_wms_services()
			tool.attach_catastro()
			tool.attach_administrative_units()
			tool.attach_file_upload()
			tool.attach_place_search()
			tool.attach_geolocate()
			tool.attach_legend()
			tool.attach_roman_empire()
			const map_node	= geolocation.map.getContainer()
			const bar		= map_node.querySelector('.uca-maps-toolbar')
			const buttons	= [...bar.querySelectorAll('.uca-maps-toolbar-button')]
			assert.equal(buttons.length, 13, 'expected the whole bar built')
			// the same squares as Leaflet's zoom beside it, and the zoom bar, now a
			// flex item of the corner, as wide as its own buttons
			const zoom		= map_node.querySelector('.leaflet-control-zoom')
			const zoom_link	= zoom.querySelector('a').getBoundingClientRect()
			for (const button of buttons) {
				const rect = button.getBoundingClientRect()
				assert.deepEqual([Math.round(rect.width), Math.round(rect.height)], [Math.round(zoom_link.width), Math.round(zoom_link.height)], button.className + ': expected the zoom\'s square')
			}
			assert.isAtMost(zoom.getBoundingClientRect().width - zoom_link.width, 6, 'expected the zoom bar as wide as its own buttons')

			const bar_rect	= bar.getBoundingClientRect()
			const map_rect	= map_node.getBoundingClientRect()
			assert.isAbove(bar.scrollHeight, bar.clientHeight + 1, 'expected the bar to scroll in its own box')
			assert.isAtMost(Math.round(bar_rect.bottom), Math.round(map_rect.bottom), 'expected the bar inside the map')
			assert.equal(getComputedStyle(bar).overflowY, 'auto', 'expected the bar\'s own scroll')
		}))
	})

	// The panels live inside Leaflet's container, which sets its own 12px
	// Helvetica; they take the page's font and base size instead (html is the
	// app's 1rem), with one smaller step for secondary text. Every text node a
	// panel draws from local state is walked: one rule off the two steps shows.
	it('with the tool CSS, every panel text reads in the page\'s font at its base size or one smaller step, not Leaflet\'s', async function() {

		await with_tool_css(async () => {
			const root		= getComputedStyle(document.documentElement)
			const map		= getComputedStyle(geolocation.map.getContainer())
			const base		= parseFloat(root.fontSize)
			const page_font	= /^system-ui\b/ // core's page font (fonts.less .global_font), which html carries
			assert.match(map.fontFamily, /Helvetica Neue/, 'expected Leaflet\'s own font on the map, or this proves nothing')

			mount_roman(WITH_PLEIADES)
			const panels = [
				['attach_console',						'panel_node',			'map_control'],
				['attach_map_image_download_control',	'map_image_panel',		'map_image_control'],
				['attach_object_viewer',				'object_viewer_panel',	'object_viewer_control'],
				['attach_xyz_basemaps',					'xyz_panel',			'xyz_control'],
				['attach_wms_services',					'wms_panel',			'wms_control'],
				['attach_file_upload',					'upload_panel',			'upload_control'],
				['attach_place_search',					'place_search_panel',	'place_search_control'],
				['attach_legend',						'legend_panel',			'legend_control'],
				['attach_roman_empire',					'roman_panel',			'roman_control']
			]
			for (const [attach, , control_key] of panels) {
				tool[attach]()
				tool[control_key].getContainer().click() // opening populates the lists
			}
			seeded_layer(1).openPopup() // the console's object section

			let measured = 0
			for (const [, panel_key] of panels) {
				const panel = tool[panel_key]
				assert.equal(getComputedStyle(panel).fontSize, root.fontSize, panel_key + ': expected the page\'s base size (1rem)')
				let panel_measured = 0
				const walker = document.createTreeWalker(panel, NodeFilter.SHOW_TEXT)
				while (walker.nextNode()) {
					const text		= walker.currentNode.textContent.trim()
					const element	= walker.currentNode.parentElement
					// the × is a glyph drawn at its own size, not text
					if (text==='' || element.classList.contains('uca-maps-panel-close')) continue
					const style	= getComputedStyle(element)
					const size	= parseFloat(style.fontSize)
					const label	= panel_key + ' "' + text.slice(0, 30) + '"'
					assert.isTrue([base, base * 0.85].some((step) => Math.abs(size - step) < 0.05), label + ': expected ' + base + 'px or ' + (base * 0.85) + 'px, got ' + style.fontSize)
					assert.match(style.fontFamily, page_font, label + ': expected core\'s page font')
					panel_measured++
				}
				assert.isAtLeast(panel_measured, 3, panel_key + ': expected its texts walked')
				measured += panel_measured
			}
			assert.isAtLeast(measured, 80, 'expected the panels\' texts walked at all')

			// which step: an action button is body text, a list title the smaller one
			const add		= tool.xyz_panel.querySelector('.uca-maps-xyz-add-button')
			const secondary	= tool.xyz_panel.querySelector('.uca-maps-xyz-list-title')
			assert.equal(getComputedStyle(add).fontSize, root.fontSize, 'expected an action button at the base size, as core buttons')
			assert.closeTo(parseFloat(getComputedStyle(secondary).fontSize), base * 0.85, 0.05, 'expected the one smaller step')

			// the Roma suggestions hang from the map, outside every panel
			open_roman()
			seed_roman_list('pleiades', [roman_hit('Saguntum', 39.68, -0.27)])
			const dropdown = getComputedStyle(tool.roman_dropdown)
			assert.isOk(tool.roman_dropdown.querySelector('.uca-maps-roman-result-name'), 'expected a suggestion drawn')
			assert.match(dropdown.fontFamily, page_font, 'expected the Roma suggestions in core\'s page font, not Leaflet\'s')
			assert.equal(dropdown.fontSize, root.fontSize, 'expected the Roma suggestions at the page\'s base size')
		})
	})

	it('with the tool CSS, the console is wider than a panel and an object\'s controls never scroll it sideways', async function() {

		await with_tool_css(async () => {
			tool.attach_console()
			tool.map_control.getContainer().click()
			seeded_layer(1).openPopup()

			// a plain panel anchored by its button, as the console is
			const plain = create_toolbar_panel(tool, {class_name: 'uca-maps-test-plain-panel'})
			plain.hidden = false

			const panel = tool.panel_node
			assert.isOk(panel.querySelector('.uca-maps-style-controls input[type="range"]'), 'expected the style sliders on screen')
			assert.isAbove(panel.offsetWidth, plain.offsetWidth, 'expected the console wider than a plain panel')
			assert.isAtMost(panel.scrollWidth, panel.clientWidth, 'expected no sideways scroll in the console')
			remove_toolbar_panel(tool, plain)

			// narrower than a slider's intrinsic ~130px plus its label: without
			// min-width:0 the range keeps that width and pushes past the edge
			panel.style.width = '16rem'
			assert.isAtMost(panel.scrollWidth, panel.clientWidth, 'expected the sliders to shrink with a narrow console, not scroll it sideways')
			panel.style.width = ''
		})
	})

	it('a button reads pressed exactly while its panel is open, however the panel closes', function() {

		tool.attach_console()
		tool.attach_map_image_download_control()
		tool.attach_wms_services()

		const ACTIVE		= 'uca-maps-toolbar-button-active'
		const uca_control	= geolocation.map.getContainer().querySelector('.uca-maps-control')
		const img_control	= geolocation.map.getContainer().querySelector('.uca-maps-map-image-control')
		const wms_control	= geolocation.map.getContainer().querySelector('.uca-maps-wms-control')
		const pressed		= () => [uca_control, img_control, wms_control].map((node) => node.classList.contains(ACTIVE))

		assert.deepEqual(pressed(), [false, false, false], 'expected nothing pressed before any click')

		uca_control.click()
		assert.deepEqual(pressed(), [true, false, false], 'expected UCA pressed by opening its panel')

		img_control.click()
		assert.deepEqual(pressed(), [false, true, false], 'expected UCA released when a sibling closed its panel')

		img_control.click()
		assert.deepEqual(pressed(), [false, false, false], 'expected IMG released by its own toggle-off')

		wms_control.click()
		assert.deepEqual(pressed(), [false, false, true], 'expected WMS pressed by opening its centered panel')

		tool.wms_panel.querySelector('.uca-maps-panel-close').click()
		assert.deepEqual(pressed(), [false, false, false], 'expected WMS released by its panel\'s ×')
	})



	// XYZ BASEMAPS (xyz_basemaps.js). The fixture has no geo_provider, so the
	// core takes its VARIOUS branch and builds a layer_control with arcgis and
	// osm: the "existing control" path this module must clean up (v6 listed
	// OSM twice).

	it('attach_xyz_basemaps seeds v6\'s defaults minus Google, replaces the core\'s arcgis/osm (no duplicate), activates the first', function() {

		tool.attach_xyz_basemaps()

		const control = geolocation.map.getContainer().querySelector('.uca-maps-xyz-control')
		assert.isOk(control, 'expected the "XYZ" toggle button')
		assert.isOk(tool.xyz_panel, 'expected the xyz panel built')
		assert.equal(tool.xyz_panel.hidden, true, 'expected the panel hidden by default')
		assert.deepEqual(tool.basemaps, DEFAULT_BASEMAPS, 'expected the defaults seeded')

		// no leftover arcgis/osm from the core's own VARIOUS branch
		const tile_entries = Object.values(geolocation.layer_control._layers)
			.filter((entry) => entry.layer instanceof L.TileLayer)
		assert.equal(tile_entries.length, 2, 'expected exactly 2 base layers registered, no leftovers/duplicates')
		assert.deepEqual(tile_entries.map((entry) => entry.name).sort(), ['ARCGIS', 'OSM'], 'expected exactly the default names, no duplicate "OSM"')

		// v6 shipped a third default fetched from mt1.google.com, an
		// undocumented endpoint whose use Google's terms prohibit
		const live_tiles = []
		geolocation.map.eachLayer((layer) => { if (layer instanceof L.TileLayer) live_tiles.push(layer) })
		assert.isAtLeast(live_tiles.length, 1, 'expected a tile layer on the map to check')
		for (const layer of [...live_tiles, ...tile_entries.map((entry) => entry.layer)]) {
			assert.notMatch(layer._url, /google/i, 'expected no Google Maps tiles, on the map or offered by the control')
		}

		assert.equal(geolocation.map.hasLayer(tool._xyz_tile_layers[0]), true, 'expected the first basemap (OSM) active on the map')
		assert.equal(geolocation.map.hasLayer(tool._xyz_tile_layers[1]), false, 'expected the other basemap NOT active')
	})

	it('attach_xyz_basemaps takes over an OSM-provider record: builds a layer_control, drops its raw layer, stops theme_observer', function() {

		// the core's OSM branch: no layer_control, one raw tile layer on the map.
		// The fixture's own control is removed for real, not just unreferenced,
		// or it lingers unremovable in the map's DOM
		let disconnect_calls = 0
		geolocation.map.removeControl(geolocation.layer_control)
		const raw_tile_layer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png').addTo(geolocation.map)
		geolocation.layer_control	= false
		geolocation.tile_layer		= raw_tile_layer
		geolocation.theme_observer	= { disconnect: () => { disconnect_calls++ } }

		tool.attach_xyz_basemaps()

		assert.isOk(geolocation.layer_control, 'expected a fresh layer_control created')
		assert.equal(geolocation.map.hasLayer(raw_tile_layer), false, 'expected the raw OSM tile layer removed from the map')
		assert.equal(disconnect_calls, 1, 'expected theme_observer.disconnect() called exactly once')
		assert.equal(geolocation.map.hasLayer(tool._xyz_tile_layers[0]), true, 'expected our own first basemap active instead')
	})

	it('attach_xyz_basemaps also sweeps an UNTRACKED raw layer (the GOOGLE/ARCGIS providers keep no reference to it)', function() {

		// the core's GOOGLE/ARCGIS branches add an anonymous layer kept in no
		// property: only `map.eachLayer` finds it. The fixture's control is
		// removed for real first, as in the OSM takeover
		geolocation.map.removeControl(geolocation.layer_control)
		const untracked_layer = L.tileLayer('https://server.arcgisonline.com/{z}/{y}/{x}').addTo(geolocation.map)
		geolocation.layer_control = false

		tool.attach_xyz_basemaps()

		assert.equal(geolocation.map.hasLayer(untracked_layer), false, 'expected the untracked provider layer removed')
		assert.equal(geolocation.map.hasLayer(tool._xyz_tile_layers[0]), true, 'expected our own first basemap active instead')
	})

	it('add_basemap validates url/name/zoom, then appends and activates the new entry', function() {

		tool.attach_xyz_basemaps()

		assert.deepEqual(
			tool.add_basemap({url: '', name: 'x', minzoom: 0, maxzoom: 18}),
			{ok: false, error: 'The base map URL is required.'}
		)
		assert.deepEqual(
			tool.add_basemap({url: 'not-a-url', name: 'x', minzoom: 0, maxzoom: 18}),
			{ok: false, error: 'Please enter a valid URL.'}
		)
		assert.deepEqual(
			tool.add_basemap({url: 'https://example.com/{z}/{x}/{y}.png', name: '', minzoom: 0, maxzoom: 18}),
			{ok: false, error: 'The base map name is required.'}
		)
		assert.deepEqual(
			tool.add_basemap({url: 'https://example.com/{z}/{x}/{y}.png', name: 'x', minzoom: -1, maxzoom: 18}),
			{ok: false, error: 'Min zoom must be an integer between 0 and 22.'}
		)
		assert.deepEqual(
			tool.add_basemap({url: 'https://example.com/{z}/{x}/{y}.png', name: 'x', minzoom: 0, maxzoom: 23}),
			{ok: false, error: 'Max zoom must be an integer between 0 and 22.'}
		)
		assert.deepEqual(
			tool.add_basemap({url: 'https://example.com/{z}/{x}/{y}.png', name: 'x', minzoom: 18, maxzoom: 2}),
			{ok: false, error: 'Min zoom cannot be greater than max zoom.'}
		)
		assert.equal(tool.basemaps.length, 2, 'expected no basemap appended by any of the failed validations')

		const result = tool.add_basemap({
			url: 'https://example.com/{z}/{x}/{y}.png', name: '<b>Custom</b>', attribution: '<img src=x onerror=alert(1)>me', minzoom: '2', maxzoom: '18'
		})
		assert.deepEqual(result, {ok: true})
		assert.equal(tool.basemaps.length, 3, 'expected the new basemap appended')
		assert.deepEqual(
			tool.basemaps[2],
			{url: 'https://example.com/{z}/{x}/{y}.png', name: 'Custom', attribution: 'me', minzoom: 2, maxzoom: 18},
			'expected strip_tags on both name AND attribution (Leaflet renders attribution via innerHTML), parsed integer zooms'
		)
		assert.equal(geolocation.map.hasLayer(tool._xyz_tile_layers[2]), true, 'expected the newly added basemap activated')
	})

	it('an entity-typed basemap name or attribution shows as text in the layer control and the attribution, never as markup', function() {

		tool.attach_xyz_basemaps()
		const container		= geolocation.map.getContainer()
		const control_names	= () => Array.from(
			container.querySelectorAll('.leaflet-control-layers-base label'),
			(label) => label.textContent.trim()
		)
		const attribution	= () => container.querySelector('.leaflet-control-attribution')
		const url			= 'https://example.com/{z}/{x}/{y}.png'

		// strip_tags decodes the entities: without the escape, Leaflet's innerHTML
		// would turn the decoded text back into an element
		const typed = '&lt;b&gt;x&lt;/b&gt;'
		assert.deepEqual(tool.add_basemap({url: url, name: typed, attribution: typed, minzoom: 0, maxzoom: 18}), {ok: true})
		assert.include(control_names(), '<b>x</b>', 'expected the name shown as literal text in the layer control')
		assert.include(attribution().textContent, '<b>x</b>', 'expected the attribution shown as literal text')
		assert.isNull(container.querySelector('.leaflet-control-layers b, .leaflet-control-attribution b'), 'expected no <b> element created')

		// an ordinary name is not double-escaped on the way
		const name = 'Mapa & Cartografía'
		assert.deepEqual(tool.add_basemap({url: url, name: name, attribution: 'Diputació & Ajuntament', minzoom: 0, maxzoom: 18}), {ok: true})
		assert.include(control_names(), name, 'expected the "&" and the accent shown as typed in the layer control')
		assert.include(attribution().textContent, 'Diputació & Ajuntament', 'expected the attribution shown as typed')
		tool.xyz_control.getContainer().click() // opening the panel lists self.basemaps
		const panel_names = Array.from(tool.xyz_panel.querySelectorAll('.uca-maps-xyz-item-name'), (node) => node.textContent)
		assert.include(panel_names, name, 'expected the panel list to show the name as typed')
	})

	it('delete_basemap refuses to remove the last remaining basemap; removes any other and reactivates index 0', function() {

		tool.attach_xyz_basemaps()

		assert.deepEqual(tool.delete_basemap(1), {ok: true}) // ARCGIS gone
		assert.equal(tool.basemaps.length, 1)
		assert.equal(tool.basemaps[0].name, 'OSM', 'expected OSM (index 0) the sole survivor')

		const refused = tool.delete_basemap(0)
		assert.equal(refused.ok, false)
		assert.equal(refused.error, 'At least one base map must remain.')
		assert.equal(tool.basemaps.length, 1, 'expected the last basemap NOT removed')
		assert.equal(geolocation.map.hasLayer(tool._xyz_tile_layers[0]), true, 'expected the sole remaining basemap still active')
	})

	it('move_basemap swaps two adjacent entries and reactivates whatever ends up at index 0', function() {

		tool.attach_xyz_basemaps()

		assert.deepEqual(tool.move_basemap(0, 1), {ok: true}) // OSM<->ARCGIS
		assert.deepEqual(tool.basemaps.map((b) => b.name), ['ARCGIS', 'OSM'])
		assert.equal(geolocation.map.hasLayer(tool._xyz_tile_layers[0]), true, 'expected the new index-0 entry (ARCGIS) active')

		assert.deepEqual(tool.move_basemap(0, -1), {ok: false}, 'expected refusal moving index 0 further up')
		assert.deepEqual(tool.move_basemap(1, 1), {ok: false}, 'expected refusal moving the last entry further down')
	})

	it('the panel form validates, adds and deletes through the real DOM (populate_xyz_basemaps)', function() {

		tool.attach_xyz_basemaps()
		const panel = tool.xyz_panel

		const add_btn = panel.querySelector('.uca-maps-xyz-add-button')
		const message = panel.querySelector('.uca-maps-xyz-message')

		add_btn.click() // every field empty -> the URL error
		assert.equal(message.hidden, false, 'expected the error message shown')
		assert.equal(message.textContent, 'The base map URL is required.')
		assert.equal(panel.querySelectorAll('.uca-maps-xyz-item').length, 0, 'expected the list not yet populated by a failed add')

		panel.querySelector('.uca-maps-xyz-url').value			= 'https://example.com/{z}/{x}/{y}.png'
		panel.querySelector('.uca-maps-xyz-name').value			= 'DOM basemap'
		panel.querySelector('.uca-maps-xyz-minzoom').value		= 0
		panel.querySelector('.uca-maps-xyz-maxzoom').value		= 18
		add_btn.click()

		assert.equal(message.hidden, true, 'expected the error message cleared on success')
		const items = panel.querySelectorAll('.uca-maps-xyz-item')
		assert.equal(items.length, 3, 'expected the list rebuilt with the new entry')
		assert.equal(items[2].querySelector('.uca-maps-xyz-item-name').textContent, 'DOM basemap')

		items[2].querySelector('.uca-maps-xyz-delete').click()
		assert.equal(panel.querySelectorAll('.uca-maps-xyz-item').length, 2, 'expected the row removed from the DOM')
	})

	it('detach_xyz_basemaps removes the button/panel AND every tile layer it added from the live map', async function() {

		tool.attach_xyz_basemaps()
		const map_container_node = geolocation.map.getContainer()
		const tile_layers = tool._xyz_tile_layers
		assert.isOk(tool.xyz_control, 'expected the control attached first')

		// this fixture's default provider (VARIOUS) already had a
		// layer_control — attach_xyz_basemaps reused it (file header,
		// xyz_basemaps.js), so detach must leave the control itself in
		// place, only stripped of the tile layers THIS tool added
		const reused_control = geolocation.layer_control

		await tool.destroy(false, false, false)

		assert.equal(tool.xyz_control, null, 'expected xyz_control cleared')
		assert.equal(tool.xyz_panel, null, 'expected xyz_panel cleared')
		assert.equal(tool.basemaps, null, 'expected basemaps cleared')
		assert.isNotOk(
			map_container_node.querySelector('.uca-maps-xyz-control'),
			'expected the button removed from the DOM'
		)
		for (const tile_layer of tile_layers) {
			assert.equal(geolocation.map.hasLayer(tile_layer), false, 'expected every tile layer this tool added removed from the map')
		}
		assert.equal(geolocation.layer_control, reused_control, 'expected the REUSED core control left in place (not this tool\'s to destroy)')
	})

	it('detach_xyz_basemaps removes the layer_control ENTIRELY when this tool is the one that created it (OSM-provider takeover)', async function() {

		// the fixture's control removed for real first, or it lingers in the DOM
		geolocation.map.removeControl(geolocation.layer_control)
		geolocation.layer_control	= false
		geolocation.tile_layer		= L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png').addTo(geolocation.map)

		tool.attach_xyz_basemaps()
		assert.equal(tool._xyz_created_layer_control, true, 'expected this tool to have created the control')
		const map_container_node = geolocation.map.getContainer()
		assert.isOk(map_container_node.querySelector('.leaflet-control-layers'), 'expected a real Leaflet layer_control in the DOM')

		await tool.destroy(false, false, false)

		assert.equal(geolocation.layer_control, false, 'expected the control this tool created fully removed, property reset')
		assert.isNotOk(
			map_container_node.querySelector('.leaflet-control-layers'),
			'expected the layer_control removed from the DOM — no control left stuck to the map'
		)
	})



	// WMS (wms_services.js) — plain WMS tile layers on the map, as v6: the
	// layer_control is never touched. GetCapabilities is always stubbed; the
	// guarded fetch is test/unit/tool_uca_maps_get_wms_layers.test.ts's.

	it('search_wms_layers refuses a non-absolute-http(s) URL without touching the server', async function() {

		tool.attach_wms_services()

		let called = false
		stub_tool_request(async function(options) { called = true; return real_tool_request(options) })

		const result = await tool.search_wms_layers('not-a-url')

		assert.equal(result.ok, false)
		assert.equal(called, false, 'expected the server never contacted for an invalid URL')
	})

	// a rejection would leave the panel's "Search" button disabled: its click
	// handler re-enables it only once the awaited call settles
	it('search_wms_layers never rejects, even when tool_request throws unexpectedly', async function() {

		tool.attach_wms_services()
		stub_tool_request(async function() { throw new Error('boom') })

		const result = await tool.search_wms_layers('https://example.com/geoserver/wms')

		assert.equal(result.ok, false)
		assert.isOk(result.error)
	})

	// the record can be closed while GetCapabilities is in flight
	it('search_wms_layers drops a response that arrives after detach_wms_services already ran', async function() {

		tool.attach_wms_services()

		let resolve_tool_request
		stub_tool_request(() => new Promise((resolve) => { resolve_tool_request = resolve }))

		const pending = tool.search_wms_layers('https://example.com/geoserver/wms')

		await tool.destroy(false, false, false)
		assert.equal(tool.wms_panel, null, 'expected the panel already torn down')

		resolve_tool_request({ok: true, data: {url: 'https://example.com/geoserver/wms', xml: SAMPLE_CAPABILITIES_XML}})
		const result = await pending

		assert.equal(result.ok, false)
		assert.equal(tool._wms_search_results, null, 'expected the late response NOT to resurrect state on the torn-down instance')
	})

	// one row per lookup that can throw: a live failure keeps its page toast,
	// one left in flight by teardown has none
	it('a lookup that throws toasts while the tool lives, and never once it is torn down mid-flight', async function() {

		geolocation.section_lang = 'lg-spa' // Catastro and UA exist only for es/cat/eus
		tool.attach_wms_services()
		mount_roman()
		tool.attach_catastro()
		tool.attach_administrative_units()
		tool.attach_place_search()

		const rows = [
			{label: 'place search', run: () => search_places(tool, 'Sagunto')},
			{label: 'wms search', run: () => tool.search_wms_layers('https://example.com/geoserver/wms')},
			{label: 'roman search', run: () => search_roman(tool, 'pleiades', {query: 'Saguntum', type: 'name'})},
			{label: 'roman add', run: () => { tool._roman_results = [{id: '265849'}]; return add_roman_result(tool, 0) }},
			{label: 'catastro', run: () => check_catastro_at_point(tool, L.latLng(40.15, -3.65))},
			{label: 'ua', run: () => check_administrative_unit_at_point(tool, L.latLng(40.45, -3.65))}
		]

		const toasts	= []
		const token		= event_manager.subscribe('api_error', (error) => toasts.push(error))
		const failures	= []
		stub_tool_request(() => new Promise((resolve, reject) => { failures.push(reject) }))
		try {
			// control: alive, each exception reaches the page toast
			for (const row of rows) {
				const pending = row.run()
				assert.equal(failures.length, 1, 'expected the request in flight: ' + row.label)
				failures.pop()(new Error('Boom.'))
				await pending
			}
			assert.equal(toasts.length, rows.length, 'expected one toast per live failure')
			assert.isTrue(toasts.every((toast) => toast.code==='client.tool_uca_maps_failed'))

			const pending = rows.map((row) => row.run())
			assert.equal(failures.length, rows.length, 'expected every lookup in flight')
			await tool.destroy(false, false, false)
			for (const fail of failures) fail(new Error('Boom.'))
			await Promise.all(pending)

			assert.deepEqual(
				toasts.slice(rows.length).map((toast) => toast.message), [],
				'expected NO toast from a lookup the closed tool left in flight'
			)
		} finally {
			event_manager.unsubscribe(token)
		}
	})

	it('search_wms_layers (mocked server) stores the parsed results; the panel lists them with an "Add" button', async function() {

		// the guarded GetCapabilities fetch is the server's: awaited calls here,
		// not a DOM click racing its microtasks
		tool.attach_wms_services()
		const panel = tool.wms_panel

		let requested_options = null
		stub_tool_request(async function(options) {
			requested_options = options
			return {ok: true, data: {url: 'https://example.com/geoserver/wms', xml: SAMPLE_CAPABILITIES_XML}}
		})

		const result = await tool.search_wms_layers('https://example.com/geoserver/wms?ignored=1')

		assert.equal(result.ok, true)
		assert.equal(requested_options.action, 'get_wms_layers')
		assert.equal(requested_options.options.url, 'https://example.com/geoserver/wms?ignored=1')
		assert.deepEqual(tool._wms_search_results, {
			base_url: 'https://example.com/geoserver/wms',
			layers: [{name: 'topo:layer1', title: 'Layer One'}]
		})

		populate_wms_search_results(tool, panel)
		const result_items = panel.querySelectorAll('.uca-maps-wms-result-item')
		assert.equal(result_items.length, 1)
		assert.equal(result_items[0].querySelector('.uca-maps-wms-result-title').textContent, 'Layer One')

		// the "Add" button's own click handler (render_wms_services.js) is sync
		result_items[0].querySelector('.uca-maps-wms-result-add').click()

		assert.equal(tool.wms_layers.length, 1, 'expected the layer added')
		assert.deepEqual(tool.wms_layers[0], {
			url: 'https://example.com/geoserver/wms', name: 'topo:layer1', title: 'Layer One', opacity: 0.7, visible: true
		})
		assert.equal(geolocation.map.hasLayer(tool._wms_tile_layers[0]), true, 'expected the newly added layer active on the map')

		tool.clear_wms_search()
		populate_wms_search_results(tool, panel)
		assert.equal(tool._wms_search_results, null, 'expected clear_wms_search to drop the stored results')
		assert.equal(panel.querySelectorAll('.uca-maps-wms-result-item').length, 0, 'expected the results list rebuilt empty')
	})

	it('a WMS server with no queryable layer leaves a warning line, not an error, and no result', async function() {

		tool.attach_wms_services()
		const panel = tool.wms_panel
		const no_queryable_layer = SAMPLE_CAPABILITIES_XML.replace(' queryable="1"', '')
		stub_tool_request(async () => ({ok: true, data: {url: 'https://example.com/geoserver/wms', xml: no_queryable_layer}}))

		panel.querySelector('.uca-maps-wms-url').value = 'https://example.com/geoserver/wms'
		panel.querySelector('.uca-maps-wms-search-button').click()
		const message = panel.querySelector('.uca-maps-wms-message')
		await until(() => !message.hidden)

		assert.equal(message.hidden, false, 'expected a line once the answer is in')
		assert.equal(message.textContent, 'No queryable layers found on this server.')
		assert.equal(message.dataset.type, 'warning', 'expected nothing found told apart from a failure')
		assert.equal(panel.querySelectorAll('.uca-maps-wms-result-item').length, 0, 'expected no result listed')
	})

	it('toggle_wms_layer shows/hides the live layer; set_wms_layer_opacity updates it and refuses out-of-range values', function() {

		tool.attach_wms_services()
		tool.add_wms_layer({url: 'https://example.com/geoserver/wms', name: 'topo:layer1', title: 'Layer One'})

		const tile_layer = tool._wms_tile_layers[0]
		assert.equal(geolocation.map.hasLayer(tile_layer), true, 'expected visible right after add')

		assert.deepEqual(tool.toggle_wms_layer(0), {ok: true})
		assert.equal(tool.wms_layers[0].visible, false)
		assert.equal(geolocation.map.hasLayer(tile_layer), false)

		assert.deepEqual(tool.toggle_wms_layer(0), {ok: true})
		assert.equal(tool.wms_layers[0].visible, true)
		assert.equal(geolocation.map.hasLayer(tile_layer), true)

		assert.deepEqual(tool.set_wms_layer_opacity(0, '0.4'), {ok: true})
		assert.equal(tool.wms_layers[0].opacity, 0.4)

		assert.deepEqual(tool.set_wms_layer_opacity(0, '1.5'), {ok: false}, 'expected an out-of-range opacity refused')
		assert.equal(tool.wms_layers[0].opacity, 0.4, 'expected the refused value NOT applied')
	})

	it('delete_wms_layer takes the layer off the map and the list; the survivor keeps its own tile layer at the new index', function() {

		tool.attach_wms_services()
		tool.add_wms_layer({url: 'https://example.com/geoserver/wms', name: 'topo:layer1', title: 'Layer One'})
		tool.add_wms_layer({url: 'https://example.com/geoserver/wms', name: 'topo:layer2', title: 'Layer Two'})

		const [first_tile_layer, second_tile_layer] = tool._wms_tile_layers

		assert.deepEqual(tool.delete_wms_layer(0), {ok: true})
		assert.equal(tool.wms_layers.length, 1)
		assert.equal(tool.wms_layers[0].name, 'topo:layer2', 'expected the survivor to be the second-added layer')
		assert.equal(geolocation.map.hasLayer(first_tile_layer), false, 'expected the deleted layer off the map')
		assert.deepEqual(tool._wms_tile_layers, [second_tile_layer], 'expected only the survivor\'s tile layer kept, at its new index')
		assert.equal(geolocation.map.hasLayer(second_tile_layer), true, 'expected the survivor still on the map')

		// index 0 now drives the survivor's own tile layer
		tool.toggle_wms_layer(0)
		assert.equal(geolocation.map.hasLayer(second_tile_layer), false, 'expected toggle_wms_layer(0) to hide the survivor')
	})

	// "centred" here is what toolbar.js does (the class, no anchoring); the
	// geometry is measured by the WMS layout test, with the tool CSS
	it('attach_wms_services builds its button, the "wms" pane and an empty layer list; its panel opens centred, its × closes it', function() {

		tool.attach_wms_services()
		const panel		= tool.wms_panel
		const control	= geolocation.map.getContainer().querySelector('.uca-maps-wms-control')

		assert.isOk(control, 'expected the "WMS" toggle button')
		assert.equal(panel.hidden, true, 'expected the panel hidden by default')
		assert.deepEqual(tool.wms_layers, [], 'expected no layers pre-added: WMS layers live for the session only')
		assert.isOk(geolocation.map.getPane('wms'), 'expected the dedicated "wms" pane created')
		assert.isTrue(panel.classList.contains('uca-maps-panel-centered'), 'expected the centered variant')
		const title = panel.querySelector(':scope > .uca-maps-panel-header > .uca-maps-panel-title')
		assert.equal(title.textContent, 'WMS services', 'expected toolbar.js to build the header title')
		assert.equal(panel.querySelectorAll('.uca-maps-panel-header').length, 1, 'expected ONE header — render_wms_services no longer builds its own')

		control.click()
		assert.equal(panel.hidden, false, 'expected the panel open after its own click')
		assert.equal(panel.style.getPropertyValue('--uca_maps_anchor_top'), '', 'expected no anchor top: anchor_panel_to_button must not run')
		assert.equal(panel.style.getPropertyValue('--uca_maps_anchor_left'), '', 'expected no anchor left: anchor_panel_to_button must not run')

		const close = panel.querySelector('.uca-maps-panel-header > .uca-maps-panel-close')
		assert.isOk(close, 'expected the × in the header')
		assert.isOk(close.getAttribute('aria-label'), 'expected the × to carry an accessible name')

		close.click()
		assert.equal(panel.hidden, true, 'expected the × to close the panel')

		// the toggle reads the DOM, so the next click on the button reopens it
		control.click()
		assert.equal(panel.hidden, false, 'expected the button to reopen a panel its × closed')
	})

	it('a centered panel\'s × fires on_hide, like being closed by a sibling', function() {

		let hidden_calls = 0
		const panel = create_toolbar_panel(tool, {
			class_name	: 'uca-maps-test-centered-panel',
			centered	: true,
			title		: 'Test',
			on_hide		: () => { hidden_calls++ }
		})
		try {
			panel.hidden = false
			panel.querySelector('.uca-maps-panel-close').click()
			assert.equal(panel.hidden, true)
			assert.equal(hidden_calls, 1, 'expected on_hide fired by the ×')

			panel.querySelector('.uca-maps-panel-close').click()
			assert.equal(hidden_calls, 1, 'expected no second on_hide for a panel already closed')
		} finally {
			remove_toolbar_panel(tool, panel)
		}
	})

	it('the eye shows the layer\'s state and toggles it in place', function() {

		tool.attach_wms_services()
		tool.add_wms_layer({url: 'https://example.com/geoserver/wms', name: 'topo:layer1', title: 'Layer One'})
		geolocation.map.getContainer().querySelector('.uca-maps-wms-control').click()

		const panel			= tool.wms_panel
		const tile_layer	= tool._wms_tile_layers[0]
		const eye			= panel.querySelector('.uca-maps-wms-list .uca-maps-wms-eye')

		assert.isNotOk(panel.querySelector('.uca-maps-wms-checkbox'), 'expected the checkbox gone')
		assert.isOk(eye.getAttribute('aria-label'), 'expected the eye to carry an accessible name')
		// eye_node draws one path; eye_off_node adds the strike as a second one
		assert.equal(eye.getAttribute('aria-pressed'), 'true', 'expected a new layer shown (added visible)')
		assert.equal(eye.querySelectorAll('svg path').length, 1, 'expected the open eye on a visible layer')

		eye.click()
		assert.equal(geolocation.map.hasLayer(tile_layer), false, 'expected the eye to take the layer off the map')
		assert.equal(eye.getAttribute('aria-pressed'), 'false')
		assert.equal(eye.querySelectorAll('svg path').length, 2, 'expected the struck eye on a hidden layer')
		assert.equal(panel.querySelector('.uca-maps-wms-list .uca-maps-wms-eye'), eye, 'expected the SAME button, updated in place (keyboard focus survives)')

		eye.click()
		assert.equal(geolocation.map.hasLayer(tile_layer), true, 'expected the eye to put the layer back')
		assert.equal(eye.getAttribute('aria-pressed'), 'true')
		assert.equal(eye.querySelectorAll('svg path').length, 1)

		// a rebuild (close + reopen runs populate_wms_layers) draws from the
		// stored state, not from a default
		eye.click()
		const control = geolocation.map.getContainer().querySelector('.uca-maps-wms-control')
		control.click()
		control.click()
		const rebuilt_eye = panel.querySelector('.uca-maps-wms-list .uca-maps-wms-eye')
		assert.notEqual(rebuilt_eye, eye, 'expected a fresh node from the rebuild')
		assert.equal(rebuilt_eye.getAttribute('aria-pressed'), 'false', 'expected the hidden state to survive the rebuild')
		assert.equal(rebuilt_eye.querySelectorAll('svg path').length, 2, 'expected the struck eye after the rebuild')
	})

	// a value set before type='range' is sanitised against the default
	// 0..100 step 1: a 0.7 layer would show its slider at 1
	it('the opacity slider shows the layer\'s stored opacity, when added and after a rebuild', function() {

		tool.attach_wms_services()
		tool.add_wms_layer({url: 'https://example.com/geoserver/wms', name: 'topo:layer1', title: 'Layer One'})
		const control	= geolocation.map.getContainer().querySelector('.uca-maps-wms-control')
		const panel		= tool.wms_panel
		control.click()

		const slider = panel.querySelector('.uca-maps-wms-list .uca-maps-wms-opacity')
		assert.equal(slider.value, '0.7', 'expected the slider at the new layer\'s 0.7, not rounded to 1')

		tool.set_wms_layer_opacity(0, '0.3')
		control.click()
		control.click()
		assert.equal(
			panel.querySelector('.uca-maps-wms-list .uca-maps-wms-opacity').value,
			'0.3',
			'expected the rebuilt slider at the stored 0.3'
		)
	})

	// long names used to be squeezed by the slider; the panel sits where v6's
	// modal box did, centred and 5rem below the map top
	it('with the tool CSS, a WMS layer name keeps its width and the panel sits centred near the map top', async function() {

		await with_tool_css(async () => {
			tool.attach_wms_services()
			for (let i = 1; i <= 3; i++) {
				tool.add_wms_layer({
					url		: 'https://example.com/geoserver/wms',
					name	: 'topo:layer' + i,
					title	: 'Límites administrativos históricos del municipio, capa ' + i
				})
			}
			geolocation.map.getContainer().querySelector('.uca-maps-wms-control').click()

			const panel = tool.wms_panel
			const rem	= parseFloat(getComputedStyle(document.documentElement).fontSize)

			for (const item of panel.querySelectorAll('.uca-maps-wms-list .uca-maps-wms-item')) {
				const item_width	= item.getBoundingClientRect().width
				const title_width	= item.querySelector('.uca-maps-wms-item-title').getBoundingClientRect().width
				const range_width	= item.querySelector('.uca-maps-wms-opacity').getBoundingClientRect().width
				assert.isAbove(title_width / item_width, 0.5, `expected the name to keep most of its row (name ${title_width}px of ${item_width}px)`)
				assert.isAtMost(range_width, 6 * rem + 1, `expected the opacity range held at 6rem (${range_width}px)`)
			}

			const panel_rect	= panel.getBoundingClientRect()
			const map_rect		= geolocation.map.getContainer().getBoundingClientRect()
			const dx = (panel_rect.left + panel_rect.width / 2) - (map_rect.left + map_rect.width / 2)
			const dy = (panel_rect.top - map_rect.top) - 5 * rem
			assert.isAtMost(Math.abs(dx), 2, `expected the panel centred horizontally on the map (off by ${dx}px)`)
			assert.isAtMost(Math.abs(dy), 2, `expected the panel 5rem below the map top (off by ${dy}px)`)
		})
	})

	it('detach_wms_services removes the button/panel AND every WMS tile layer it added from the live map', async function() {

		tool.attach_wms_services()
		tool.add_wms_layer({url: 'https://example.com/geoserver/wms', name: 'topo:layer1', title: 'Layer One'})
		const map_container_node = geolocation.map.getContainer()
		const tile_layers = tool._wms_tile_layers

		await tool.destroy(false, false, false)

		assert.equal(tool.wms_control, null, 'expected wms_control cleared')
		assert.equal(tool.wms_panel, null, 'expected wms_panel cleared')
		assert.equal(tool.wms_layers, null, 'expected wms_layers cleared')
		assert.isNotOk(
			map_container_node.querySelector('.uca-maps-wms-control'),
			'expected the button removed from the DOM'
		)
		for (const tile_layer of tile_layers) {
			assert.equal(geolocation.map.hasLayer(tile_layer), false, 'expected every WMS tile layer this tool added removed from the map')
		}
	})

	// CATASTRO (catastro.js) AND UA (administrative_units.js) — both exist only
	// for an es/cat/eus section_lang, which the fixture does not set, and both
	// SWAP the base map (find_active_tile_layer). Every lookup is stubbed.

	it('attach_catastro/attach_administrative_units are a no-op without section_lang or with a non-Spanish one (v6 parity)', function() {

		assert.equal(geolocation.section_lang, undefined, 'expected the shared fixture to set no section_lang')
		for (const section_lang of [undefined, 'lg-eng']) {
			geolocation.section_lang = section_lang
			assert.equal(is_spanish_official_lang(tool), false, 'expected ' + section_lang + ' not an official language of Spain')

			tool.attach_catastro()
			tool.attach_administrative_units()

			assert.equal(tool.catastro_control, null, 'expected no "Catastro" button for ' + section_lang)
			assert.equal(tool.ua_control, null, 'expected no "UA" button for ' + section_lang)
		}
	})

	it('attach_catastro builds the toggle button once section_lang is es/cat/eus', function() {

		geolocation.section_lang = 'lg-cat'
		assert.equal(is_spanish_official_lang(tool), true)

		tool.attach_catastro()
		tool.attach_catastro() // second call: must be a no-op, never a duplicate

		const controls = geolocation.map.getContainer().querySelectorAll('.uca-maps-catastro-control')
		assert.equal(controls.length, 1, 'expected exactly one "Catastro" button')
		assert.equal(is_catastro_enabled(tool), false, 'expected Catastro off by default')
	})

	// as v6, Catastro SWAPS the active basemap (marked in the map's own
	// layer-control) rather than laying a translucent overlay on top of it
	it('clicking "Catastro" swaps the active basemap for the cadastral map; a second click restores the previous one', function() {

		geolocation.section_lang = 'lg-spa'
		tool.attach_catastro()

		const previous_base_layer = find_active_tile_layer(geolocation.map)
		assert.isOk(previous_base_layer, 'expected a basemap already on the map before arming (test fixture default)')

		tool.catastro_control.getContainer().click()
		assert.equal(is_catastro_enabled(tool), true, 'expected Catastro armed after one click')
		assert.isOk(tool._catastro_tile_layer, 'expected the cadastral tile layer built')
		assert.equal(geolocation.map.hasLayer(tool._catastro_tile_layer), true, 'expected the cadastral layer active on the map')
		assert.equal(geolocation.map.hasLayer(previous_base_layer), false, 'expected the PREVIOUS basemap removed while Catastro is active — a swap, not an overlay')
		assert.isOk(geolocation.layer_control, 'expected a layer_control to exist (created if none did)')
		assert.isOk(Object.values(geolocation.layer_control._layers).some((entry) => entry.layer===tool._catastro_tile_layer), 'expected Catastro registered as a base layer, so the control marks it selected')

		tool.catastro_control.getContainer().click()
		assert.equal(is_catastro_enabled(tool), false, 'expected Catastro disarmed after a second click')
		assert.equal(tool._catastro_tile_layer, null, 'expected the cadastral tile layer cleared')
		assert.equal(geolocation.map.hasLayer(previous_base_layer), true, 'expected the previous basemap restored')
	})

	// both swap the basemap: one at a time, as v6's only_one_active_control.
	// Before, UA remembered Catastro's WMS as "the previous basemap" and put it
	// back after Catastro had let go — a cadastral layer nothing could remove
	it('Catastro and UA take turns on the basemap: CAT → UA → CAT → UA, then closing UA, leaves only the original basemap', function() {

		geolocation.section_lang = 'lg-spa'
		tool.attach_catastro()
		tool.attach_administrative_units()

		const map				= geolocation.map
		const original			= find_active_tile_layer(map)
		const wms_on_map		= () => {
			const layers = []
			map.eachLayer((layer) => { if (layer instanceof L.TileLayer.WMS) layers.push(layer) })
			return layers
		}
		const click_cat	= () => tool.catastro_control.getContainer().click()
		const click_ua	= () => tool.ua_control.getContainer().click()
		assert.isOk(original, 'expected a basemap on the map before arming (test fixture default)')

		click_cat()
		const cat_layer = tool._catastro_tile_layer
		assert.deepEqual(wms_on_map(), [cat_layer], 'expected Catastro alone on the map')

		click_ua()
		assert.equal(is_catastro_enabled(tool), false, 'expected arming UA to disarm Catastro')
		assert.equal(map.hasLayer(cat_layer), false, 'expected Catastro\'s WMS off the map')
		assert.deepEqual(wms_on_map(), [tool._ua_tile_layer], 'expected UA alone on the map')

		click_cat()
		assert.equal(tool.ua_panel.hidden, true, 'expected arming Catastro to close the UA panel')
		assert.equal(tool._ua_tile_layer, null, 'expected arming Catastro to disarm UA')
		assert.deepEqual(wms_on_map(), [tool._catastro_tile_layer], 'expected Catastro alone on the map')

		click_ua()
		assert.equal(is_catastro_enabled(tool), false, 'expected Catastro disarmed again')
		assert.deepEqual(wms_on_map(), [tool._ua_tile_layer], 'expected UA alone on the map')

		click_ua()
		assert.deepEqual(wms_on_map(), [], 'expected no WMS left once both are off')
		assert.equal(map.hasLayer(original), true, 'expected the original basemap back')
		const entries = geolocation.layer_control ? Object.values(geolocation.layer_control._layers) : []
		assert.isFalse(entries.some((entry) => entry.layer instanceof L.TileLayer.WMS), 'expected no WMS left in the layer control')
		assert.equal(tool._basemap_swap_armed, null, 'expected no swap holding the basemap')
	})

	it('check_catastro_at_point (found) creates a polygon with a visible "url" property, not hidden uca_maps bookkeeping', async function() {

		arm_catastro()

		let requested_options = null
		stub_tool_request(async function(options) {
			requested_options = options
			return {ok: true, data: parcel_found()}
		})

		const before_layer_count = active_group().getLayers().length
		await check_catastro_at_point(tool, L.latLng(40.15, -3.65))

		assert.equal(requested_options.action, 'get_catastro_parcel')
		assert.isOk(Array.isArray(requested_options.options.bbox) && requested_options.options.bbox.length===4, 'expected a 4-number bbox')

		const layers = active_group().getLayers()
		assert.equal(layers.length, before_layer_count + 1, 'expected one new polygon added to the active FeatureGroup')
		const created = layers[layers.length - 1]
		assert.equal(created.feature.properties.url, 'https://example.com/parcel', 'expected a REGULAR, visible "url" property (v6 parity)')
		assert.equal(created.feature.properties.uca_maps.catastro, true)
	})

	// v6 prints any URL-valued property as a "Más información" link; here only
	// the parcel's own url, titled "Catastro"
	it('the console shows a parcel\'s url as a read-only "Catastro" link; the same key typed by hand stays editable text', async function() {

		tool.attach_console()
		arm_catastro()
		stub_tool_request(async function() {
			return {ok: true, data: parcel_found('https://example.com/parcel?rc1=1&rc2=2')}
		})
		await check_catastro_at_point(tool, L.latLng(40.15, -3.65))

		const layers	= active_group().getLayers()
		const parcel	= layers[layers.length - 1]
		parcel.openPopup()

		const find_url_row = () => Array.from(tool.panel_node.querySelectorAll('.uca-maps-properties-list .uca-maps-property-item'))
			.find(item => item.querySelector('.uca-maps-property-link') || (item.querySelector('.uca-maps-property-key') || {}).textContent==='url:')

		const row	= find_url_row()
		const link	= row && row.querySelector('a.uca-maps-property-link')
		assert.isOk(link, 'expected the parcel url rendered as a link')
		assert.equal(link.textContent, 'Catastro', 'expected the link titled "Catastro", not v6\'s "Más información"')
		assert.equal(link.getAttribute('href'), 'https://example.com/parcel?rc1=1&rc2=2')
		assert.equal(link.target, '_blank')
		assert.include(link.rel, 'noopener', 'expected no window.opener handed to the third-party page')
		assert.isNotOk(row.querySelector('input'), 'expected no editable input for the parcel url')
		assert.isOk(row.querySelector('.uca-maps-property-delete'), 'expected it still deletable, like every property')

		// a non-http(s) value never becomes an href, parcel or not
		parcel.feature.properties.url = 'javascript:alert(1)'
		parcel.closePopup() // a popup already open fires no second popupopen
		parcel.openPopup()
		assert.isNotOk(tool.panel_node.querySelector('.uca-maps-property-link'), 'expected a javascript: url kept out of any href')
		const fallback = find_url_row() && find_url_row().querySelector('input.uca-maps-property-value')
		assert.isOk(fallback, 'expected the row still there, falling back to editable text')
		assert.equal(fallback.value, 'javascript:alert(1)')

		// the same key on an ordinary polygon is plain editable text
		parcel.feature.properties.url = 'https://example.com/parcel'
		delete parcel.feature.properties.uca_maps.catastro
		parcel.closePopup()
		parcel.openPopup()
		assert.isNotOk(tool.panel_node.querySelector('.uca-maps-property-link'), 'expected no link without the catastro mark')
		assert.isOk(find_url_row().querySelector('input.uca-maps-property-value'), 'expected the url editable text on a non-parcel')

		// the link row's ✕ really deletes the property
		parcel.feature.properties.uca_maps.catastro = true
		parcel.closePopup()
		parcel.openPopup()
		find_url_row().querySelector('.uca-maps-property-delete').click()
		assert.notProperty(parcel.feature.properties, 'url', 'expected the ✕ on the link row to delete the url')
	})

	it('check_catastro_at_point (not found) shows the not-found line, creates nothing', async function() {

		arm_catastro()

		stub_tool_request(async () => ({ok: true, data: {found: false}}))

		const before_layer_count = active_group().getLayers().length
		await check_catastro_at_point(tool, L.latLng(40.15, -3.65))

		assert.equal(
			active_group().getLayers().length,
			before_layer_count,
			'expected no polygon created on a "not found" result'
		)
		const banner = geolocation.node.querySelector('.uca-maps-catastro-message .text')
		assert.isOk(banner, 'expected an in-component message banner')
		assert.equal(banner.textContent, 'No parcel could be found at this point.', 'expected the not-found line, not the lookup failure\'s')
		assert.isTrue(banner.parentElement.classList.contains('warning'), 'expected a warning, as UA\'s: nothing failed')
	})

	// the banner tints every line it holds with the last type
	it('each Catastro lookup replaces the banner line: a failure, then "not found", leaves one warning', async function() {

		arm_catastro()

		stub_tool_request(async () => ({ok: false, error: {is_api_error: true, code: 'client.timeout', message: 'The request timed out', transport: true}}))
		await check_catastro_at_point(tool, L.latLng(40.15, -3.65))
		const banner = () => geolocation.node.querySelector('.uca-maps-catastro-message')
		assert.isTrue(banner().classList.contains('error'), 'expected the failure as an error')

		stub_tool_request(async () => ({ok: true, data: {found: false}}))
		await check_catastro_at_point(tool, L.latLng(40.15, -3.65))
		const lines = Array.from(banner().querySelectorAll('.text'), (node) => node.textContent)
		assert.deepEqual(lines, ['No parcel could be found at this point.'], 'expected the failure line replaced')
		assert.isTrue(banner().classList.contains('warning') && !banner().classList.contains('error'), 'expected the banner a warning only')
	})

	it('a refusal\'s reason sits on its own line: Catastro\'s core banner and the panel lines', async function() {

		// with the tool CSS or not at all: without it white-space is never pre-line
		await with_tool_css(async () => {
			arm_catastro()
			stub_tool_request(async () => ({ok: false, error: {
				is_api_error	: true,
				code			: 'request.invalid_options',
				label_key		: 'error_request_invalid_options',
				message			: 'Coordinates out of range'
			}}))
			await check_catastro_at_point(tool, L.latLng(40.15, -3.65))

			const text = geolocation.node.querySelector('.uca-maps-catastro-message .text')
			assert.isOk(text, 'expected core\'s banner line')
			assert.equal(text.textContent, 'The cadastral parcel could not be looked up.\nCoordinates out of range')
			assert.equal(getComputedStyle(text).whiteSpace, 'pre-line', 'expected the line break kept in the banner')

			// every panel line shares one mixin; the upload one stands for all
			tool.attach_file_upload()
			const line = tool.upload_panel.querySelector('.uca-maps-upload-message')
			assert.equal(getComputedStyle(line).whiteSpace, 'pre-line', 'expected the line break kept in a panel line')
		})
	})

	it('a found parcel, or disarming Catastro, takes the banner of an earlier lookup away', async function() {

		const banner = () => geolocation.node.querySelector('.uca-maps-catastro-message')

		arm_catastro()
		stub_tool_request(async () => ({ok: true, data: {found: false}}))
		await check_catastro_at_point(tool, L.latLng(40.15, -3.65))
		assert.isOk(banner(), 'expected the not-found banner first')

		stub_tool_request(async () => ({ok: true, data: parcel_found()}))
		await check_catastro_at_point(tool, L.latLng(40.15, -3.65))
		assert.isNull(banner(), 'expected no banner beside the parcel just found')

		stub_tool_request(async () => ({ok: true, data: {found: false}}))
		await check_catastro_at_point(tool, L.latLng(40.15, -3.65))
		assert.isOk(banner(), 'expected the not-found banner again')
		tool.catastro_control.getContainer().click() // disarm
		assert.isNull(banner(), 'expected no banner once Catastro is disarmed')
	})

	it('check_catastro_at_point refuses overlapping lookups (busy guard) — only the first reaches tool_request', async function() {

		arm_catastro()

		let call_count = 0
		let resolve_first
		stub_tool_request(() => new Promise((resolve) => {
			call_count++
			resolve_first = () => resolve({ok: true, data: {found: false}})
		}))

		const first = check_catastro_at_point(tool, L.latLng(40.15, -3.65))
		const second = check_catastro_at_point(tool, L.latLng(40.16, -3.66)) // dropped: busy

		resolve_first()
		await Promise.all([first, second])

		assert.equal(call_count, 1, 'expected the second, overlapping lookup never to reach tool_request')
	})

	it('detach_catastro removes the button AND restores the previous basemap on the live map', async function() {

		geolocation.section_lang = 'lg-spa'
		tool.attach_catastro()

		const previous_base_layer = find_active_tile_layer(geolocation.map)
		tool.catastro_control.getContainer().click() // arm
		const tile_layer = tool._catastro_tile_layer
		const map_container_node = geolocation.map.getContainer()

		await tool.destroy(false, false, false)

		assert.equal(tool.catastro_control, null, 'expected catastro_control cleared')
		assert.isNotOk(map_container_node.querySelector('.uca-maps-catastro-control'), 'expected the button removed from the DOM')
		assert.equal(geolocation.map.hasLayer(tile_layer), false, 'expected the cadastral layer removed from the map')
		assert.equal(geolocation.map.hasLayer(previous_base_layer), true, 'expected the previous basemap restored on teardown, not left blank')
	})

	// a parcel drawn after the disarm would land on a map no longer in Catastro mode
	it('check_catastro_at_point drops a response that arrives after the user disarms Catastro mid-request', async function() {

		arm_catastro()

		let resolve_tool_request
		stub_tool_request(() => new Promise((resolve) => { resolve_tool_request = resolve }))

		const before_layer_count = active_group().getLayers().length
		const pending = check_catastro_at_point(tool, L.latLng(40.15, -3.65))

		tool.catastro_control.getContainer().click() // disarm WHILE the request is in flight
		assert.equal(is_catastro_enabled(tool), false, 'expected Catastro disarmed')

		resolve_tool_request({ok: true, data: parcel_found()})
		await pending

		assert.equal(
			active_group().getLayers().length,
			before_layer_count,
			'expected the late "found" response NOT to create a parcel after Catastro was disarmed'
		)
	})

	// UA exists only for es/cat/eus; opening its panel is arming it
	const arm_ua = function() {
		geolocation.section_lang = 'lg-spa'
		tool.attach_administrative_units()
		tool.ua_control.getContainer().click()
	}

	describe('administrative units (UA)', function() {

		it('attach_administrative_units builds the button+panel (level select) once section_lang is es/cat/eus', function() {

			geolocation.section_lang = 'lg-eus'
			tool.attach_administrative_units()
			tool.attach_administrative_units() // second call: must be a no-op

			const controls = geolocation.map.getContainer().querySelectorAll('.uca-maps-ua-control')
			assert.equal(controls.length, 1, 'expected exactly one "UA" button')
			assert.isOk(tool.ua_panel, 'expected the UA panel built')
			assert.equal(tool.ua_panel.hidden, true, 'expected the panel hidden by default')
			assert.isOk(tool.ua_panel.querySelector('.uca-maps-ua-level-select'), 'expected the level select rendered')
		})

		// v6's UA_on swaps the basemap for AU.AdministrativeUnit, as Catastro does:
		// laid over it, the units would be read against a second map
		it('opening the "UA" panel swaps the active basemap; closing it restores the previous one', function() {

			geolocation.section_lang = 'lg-spa'
			tool.attach_administrative_units()

			const previous_base_layer = find_active_tile_layer(geolocation.map)
			assert.isOk(previous_base_layer, 'expected a basemap already on the map before arming (test fixture default)')

			tool.ua_control.getContainer().click()
			assert.equal(tool.ua_panel.hidden, false, 'expected the panel open')
			assert.isOk(tool._ua_tile_layer, 'expected the AU.AdministrativeUnit tile layer built')
			assert.equal(geolocation.map.hasLayer(tool._ua_tile_layer), true, 'expected it active on the map')
			assert.equal(geolocation.map.hasLayer(previous_base_layer), false, 'expected the PREVIOUS basemap removed while UA is active — a swap, not an overlay')

			tool.ua_control.getContainer().click()
			assert.equal(tool.ua_panel.hidden, true, 'expected the panel closed')
			assert.equal(tool._ua_tile_layer, null, 'expected the tile layer cleared')
			assert.equal(geolocation.map.hasLayer(previous_base_layer), true, 'expected the previous basemap restored')
		})

		// the exclusivity close (toolbar.js) never passes through UA's own toggle:
		// only the panel's on_hide disarms it then
		it('a sibling panel opening force-closes AND disarms UA — not just visually hidden', function() {

			geolocation.section_lang = 'lg-spa'
			tool.attach_administrative_units()
			tool.attach_wms_services()

			tool.ua_control.getContainer().click() // arm UA
			assert.isOk(tool._ua_tile_layer, 'expected UA armed')
			const armed_tile_layer = tool._ua_tile_layer
			const armed_click_handler = tool._ua_click_handler

			tool.wms_control.getContainer().click() // opens a SIBLING panel — forces UA's panel shut

			assert.equal(tool.ua_panel.hidden, true, 'expected the UA panel force-closed')
			assert.equal(tool._ua_tile_layer, null, 'expected the overlay tile layer disarmed, not left running behind a closed panel')
			assert.equal(tool._ua_click_handler, null, 'expected the map click listener disarmed too')
			assert.equal(geolocation.map.hasLayer(armed_tile_layer), false, 'expected the overlay actually removed from the map')

			// reopening UA must not leak a second, duplicate overlay/listener
			// alongside a stale reference to the one already torn down
			tool.ua_control.getContainer().click()
			assert.notEqual(tool._ua_tile_layer, armed_tile_layer, 'expected a fresh overlay, not the disarmed one')
			assert.notEqual(tool._ua_click_handler, armed_click_handler, 'expected a fresh click listener')
		})

		it('the UA level select sets the level the next lookup asks for', async function() {

			arm_ua()

			const select = tool.ua_panel.querySelector('.uca-maps-ua-level-select')
			assert.equal(select.value, 'Municipio', 'expected v6\'s default level selected')
			select.value = 'Provincia'
			select.dispatchEvent(new Event('change'))

			let requested_options = null
			stub_tool_request(async function(options) {
				requested_options = options
				return {ok: true, data: {found: false}}
			})
			await check_administrative_unit_at_point(tool, L.latLng(40.45, -3.65))

			assert.equal(requested_options.options.level, 'Provincia', 'expected the picked level sent, not the default')
		})

		it('check_administrative_unit_at_point (found) adds the unit as an object in the active group, asking for the level', async function() {

			arm_ua() // level defaults to 'Municipio'

			let requested_options = null
			stub_tool_request(async function(options) {
				requested_options = options
				return {ok: true, data: {found: true, feature: {
					type: 'Feature',
					geometry: {type: 'Polygon', coordinates: [[[-3.71,40.40],[-3.60,40.40],[-3.60,40.50],[-3.71,40.50],[-3.71,40.40]]]},
					properties: {nameunit: 'Test municipality'}
				}}}
			})

			const before_layer_count = active_group().getLayers().length
			await check_administrative_unit_at_point(tool, L.latLng(40.45, -3.65))
			await settle_map(geolocation.map) // the polygon is fitted, which animates

			assert.equal(requested_options.action, 'get_administrative_unit')
			assert.equal(requested_options.options.level, 'Municipio')

			const layers = active_group().getLayers()
			assert.equal(layers.length, before_layer_count + 1, 'expected one new object added to the active FeatureGroup')
			assert.equal(layers[layers.length - 1].feature.properties.nameunit, 'Test municipality', 'expected the raw IGN properties kept, v6 parity')
		})

		it('check_administrative_unit_at_point (not found) shows an in-panel message, creates nothing', async function() {

			arm_ua()

			stub_tool_request(async () => ({ok: true, data: {found: false}}))

			const before_layer_count = active_group().getLayers().length
			await check_administrative_unit_at_point(tool, L.latLng(40.45, -3.65))

			assert.equal(
				active_group().getLayers().length,
				before_layer_count,
				'expected no object created on a "not found" result'
			)
			const message = tool.ua_panel.querySelector('.uca-maps-ua-message')
			assert.equal(message.hidden, false, 'expected the in-panel message shown')
			assert.equal(message.dataset.type, 'warning', 'expected "not found" as a warning, not an error')
		})

		// a click while a lookup runs, or while Geoman edits a shape, is not a lookup
		it('check_administrative_unit_at_point asks nothing while a lookup is in flight or Geoman is editing', async function() {

			arm_ua()

			let call_count = 0
			let resolve_first = null
			stub_tool_request(() => new Promise((resolve) => {
				call_count++
				resolve_first = () => resolve({ok: true, data: {found: false}})
			}))

			const first = check_administrative_unit_at_point(tool, L.latLng(40.45, -3.65))
			await check_administrative_unit_at_point(tool, L.latLng(40.46, -3.66)) // dropped: busy
			assert.equal(call_count, 1, 'expected the overlapping lookup never to reach tool_request')
			resolve_first()
			await first

			const original_global_edit_mode_enabled = geolocation.map.pm.globalEditModeEnabled
			geolocation.map.pm.globalEditModeEnabled = () => true
			try {
				await check_administrative_unit_at_point(tool, L.latLng(40.45, -3.65))
			} finally {
				geolocation.map.pm.globalEditModeEnabled = original_global_edit_mode_enabled
			}
			assert.equal(call_count, 1, 'expected no lookup while Geoman is in global edit mode')

			// control: idle and not editing, a click asks again
			const control = check_administrative_unit_at_point(tool, L.latLng(40.45, -3.65))
			assert.equal(call_count, 2, 'expected an idle click to reach tool_request')
			resolve_first()
			await control
		})

		// closed by its own toggle here; a sibling panel's close disarms through on_hide
		it('check_administrative_unit_at_point drops a response that arrives after the UA panel is closed mid-request', async function() {

			arm_ua()

			let resolve_tool_request
			stub_tool_request(() => new Promise((resolve) => { resolve_tool_request = resolve }))

			const before_layer_count = active_group().getLayers().length
			const pending = check_administrative_unit_at_point(tool, L.latLng(40.45, -3.65))

			tool.ua_control.getContainer().click() // close WHILE the request is in flight
			assert.equal(tool.ua_panel.hidden, true, 'expected the panel closed')

			resolve_tool_request({ok: true, data: {found: true, feature: {
				type: 'Feature',
				geometry: {type: 'Point', coordinates: [-3.65, 40.45]},
				properties: {}
			}}})
			await pending

			assert.equal(
				active_group().getLayers().length,
				before_layer_count,
				'expected the late "found" response NOT to create an object after the panel was closed'
			)
		})

		it('detach_administrative_units removes the button/panel AND restores the previous basemap', async function() {

			geolocation.section_lang = 'lg-spa'
			tool.attach_administrative_units()

			const previous_base_layer = find_active_tile_layer(geolocation.map)
			tool.ua_control.getContainer().click() // arm
			const tile_layer = tool._ua_tile_layer
			const map_container_node = geolocation.map.getContainer()

			await tool.destroy(false, false, false)

			assert.equal(tool.ua_control, null, 'expected ua_control cleared')
			assert.equal(tool.ua_panel, null, 'expected ua_panel cleared')
			assert.isNotOk(map_container_node.querySelector('.uca-maps-ua-control'), 'expected the button removed from the DOM')
			assert.equal(geolocation.map.hasLayer(tile_layer), false, 'expected the AU.AdministrativeUnit layer removed from the map')
			assert.equal(geolocation.map.hasLayer(previous_base_layer), true, 'expected the previous basemap restored on teardown, not left blank')
		})
	})

	// basemap_swap.js, shared by Catastro and UA: a map click is the lookup, and
	// disarming undoes all of the swap, the layer control it had to create included
	for (const swap of [
		{key: 'catastro', attach: 'attach_catastro', control: 'catastro_control', action: 'get_catastro_parcel', extra: {}},
		{key: 'ua', attach: 'attach_administrative_units', control: 'ua_control', action: 'get_administrative_unit', extra: {level: 'Municipio'}}
	]) {
		it(`${swap.key}: a map click asks with the view and clicked pixel; disarming unhooks click, layer and the control it made`, async function() {

			const map		= geolocation.map
			const toggle	= () => tool[swap.control].getContainer().click()
			const handler	= () => tool[`_${swap.key}_click_handler`]

			geolocation.section_lang = 'lg-spa'
			tool[swap.attach]()

			let requested = null
			stub_tool_request(async (options) => {
				requested = options
				return {ok: true, data: {found: false}}
			})

			// with the fixture's own layer control
			const fixture_control = geolocation.layer_control
			toggle() // arm
			const armed_handler	= handler()
			const tile_layer	= tool[`_${swap.key}_tile_layer`]
			assert.isTrue(map.listens('click', armed_handler), 'expected the map click armed')
			assert.isNotOk(tool[`_${swap.key}_created_layer_control`], 'expected the existing control reused, not a new one')

			// a pixel off the diagonal, so x and y cannot stand for each other
			const latlng = map.containerPointToLatLng(L.point(37, 101))
			map.fire('click', {latlng})
			assert.isOk(requested, 'expected the click to reach tool_request')
			await until(() => !tool[`_${swap.key}_busy`])
			assert.isFalse(tool[`_${swap.key}_busy`], 'expected the lookup settled')

			const bounds	= map.getBounds()
			const size		= map.getSize()
			const point		= map.latLngToContainerPoint(latlng)
			assert.equal(requested.action, swap.action)
			assert.deepEqual(requested.options, {
				tipo			: geolocation.tipo,
				section_id		: geolocation.section_id,
				section_tipo	: geolocation.section_tipo,
				bbox			: [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()],
				width			: size.x,
				height			: size.y,
				x				: point.x,
				y				: point.y,
				...swap.extra
			})

			toggle() // disarm
			assert.isFalse(map.listens('click', armed_handler), 'expected the map click unhooked')
			assert.strictEqual(geolocation.layer_control, fixture_control, 'expected the fixture\'s control kept')
			assert.isFalse(
				Object.values(fixture_control._layers).some((entry) => entry.layer===tile_layer),
				'expected the WMS out of the basemap list'
			)

			// without one (the core's OSM branch): the swap creates a control and removes it again.
			// The fixture's control is removed for real, as in the XYZ takeover
			map.removeControl(fixture_control)
			geolocation.layer_control = false
			const original_base_layer = find_active_tile_layer(map)
			assert.isOk(original_base_layer, 'expected the fixture basemap on the map')

			toggle() // arm
			const created_control = geolocation.layer_control
			assert.isOk(created_control, 'expected a layer control created')
			assert.isTrue(tool[`_${swap.key}_created_layer_control`], 'expected the creation recorded')
			assert.isTrue(map.getContainer().contains(created_control.getContainer()), 'expected the created control on the map')

			toggle() // disarm
			assert.isFalse(map.getContainer().contains(created_control.getContainer()), 'expected the created control gone from the map')
			assert.strictEqual(geolocation.layer_control, false, 'expected no control left behind')
			assert.isTrue(map.hasLayer(original_base_layer), 'expected the original basemap back')
		})
	}

	// each panel's own lead says what failed; a REASON_CODES refusal adds the
	// server's reason on its own line, which core's error_text alone drops
	it('a refusal with a reason shows the panel\'s lead, then the reason: UA, WMS, place and Roman searches', async function() {

		arm_ua()
		tool.attach_wms_services()
		tool.attach_place_search()
		mount_roman(WITH_PLEIADES)

		const reason = 'Coordinates out of range'
		stub_tool_request(async () => ({ok: false, error: {
			is_api_error	: true,
			code			: 'request.invalid_options',
			label_key		: 'error_request_invalid_options',
			message			: reason,
			transport		: false
		}}))

		const ua_line = () => tool.ua_panel.querySelector('.uca-maps-ua-message')
		const rows = [
			{
				label	: 'ua',
				lead	: 'The administrative unit could not be looked up.',
				run		: async () => {
					await check_administrative_unit_at_point(tool, L.latLng(40.45, -3.65))
					assert.equal(ua_line().dataset.type, 'error', 'expected the UA refusal as an error')
					return ua_line().textContent
				}
			},
			{
				label	: 'wms search',
				lead	: 'The WMS server could not be queried.',
				run		: async () => (await tool.search_wms_layers('https://example.com/geoserver/wms')).error
			},
			{
				label	: 'place search',
				lead	: 'The place search could not be completed.',
				run		: async () => (await search_places(tool, 'Sagunto')).error
			},
			{
				label	: 'roman search',
				lead	: 'The search could not be completed.',
				run		: async () => (await search_roman(tool, 'pleiades', {query: 'Saguntum', type: 'name'})).error
			},
			{
				label	: 'roman add',
				lead	: 'The search could not be completed.',
				run		: async () => {
					tool._roman_results = [{id: '265849'}]
					return (await add_roman_result(tool, 0)).error
				}
			}
		]
		for (const row of rows) {
			assert.equal(await row.run(), `${row.lead}\n${reason}`, row.label)
		}
	})



	// UPLOAD FILE TO MAP, vector half (vector_upload.js). The round-trip tests
	// run the real service_upload transport and upload_vector_layer action.

	/**
	* Releases what a test staged for real and nobody ingested, through the door
	* the upload queue uses for a removed row. Answers each release's response.
	*/
	const release_staged = async function(staged) {
		const answers = []
		for (const file_data of staged) {
			answers.push(await data_manager.request({body: {
				dd_api	: 'dd_utils_api',
				action	: 'delete_uploaded_file',
				options	: {key_dir: file_data.key_dir, file_name: file_data.tmp_name}
			}}))
		}
		return answers
	}

	// the two halves share the guard's sentence; "no request" is counted at every
	// door, service_upload's XHR included, not at tool_request alone
	it('both upload halves refuse a missing file with upload_no_file, sending no request by any door', async function() {

		tool.attach_file_upload()

		const rows = [
			{label: 'vector', run: () => tool.upload_vector_file(null, {})},
			{label: 'image', run: () => tool.upload_image_file(null)}
		]
		for (const row of rows) {
			const {result, sent} = await requests_sent_by(row.run)
			assert.deepEqual(
				result, {ok: false, error: tool.get_tool_label('upload_no_file') || 'Please choose a file first.'},
				`expected the no-file sentence, not the transport catch: ${row.label}`
			)
			assert.deepEqual(sent, [], `expected NO request of any kind without a file: ${row.label}`)
		}
	})

	// a server without GDAL answers tool.dependency_unavailable and the case is skipped, never passed
	it('upload_vector_file (real round trip) uploads a .geojson file and creates a matching object (skipped without GDAL)', async function() {

		tool.attach_file_upload()

		let response = null
		stub_tool_request(async function(options) {
			response = await real_tool_request(options)
			return response
		})

		const before_layer_count = active_group().getLayers().length
		const result = await tool.upload_vector_file(sample_vector_file(), {})
		await settle_map(geolocation.map) // the new object is fitted, which animates

		if (response && response.ok!==true) {
			assert.equal(
				response.error?.code, 'tool.dependency_unavailable',
				`expected the only acceptable failure to be a missing GDAL binary — full response: ${JSON.stringify(response)}`
			)
			this.skip()
		}

		assert.isTrue(result.ok, `expected the upload to succeed — full result: ${JSON.stringify(result)}`)
		assert.equal(result.feature_count, 1, 'expected exactly the one uploaded feature')
		assert.equal(
			active_group().getLayers().length,
			before_layer_count + 1,
			'expected one new object added to the active FeatureGroup via pm:create'
		)
	})

	it('upload_vector_file (real round trip) brings a malformed EPSG code back as request.invalid_options, with no GDAL needed', async function() {

		tool.attach_file_upload()

		let response	= null
		let sent		= null
		stub_tool_request(async function(options) {
			sent		= options
			response	= await real_tool_request(options)
			return response
		})

		const file = sample_vector_file()

		// the EPSG format check runs BEFORE the ogr2ogr call (vector_upload.ts),
		// so this exercises the real staged-upload + server round trip without
		// depending on GDAL being installed. The reason must survive to the
		// panel: core's error_text alone shows only "Invalid request options".
		// The refusal leaves the staged file behind, so it is released here.
		try {
			const result = await tool.upload_vector_file(file, {epsg: 'not-a-code', zone: '30', band: 'N'})

			assert.equal(result.ok, false)
			assert.isOk(response, 'expected tool_request to have been reached')
			assert.equal(response.error && response.error.code, 'request.invalid_options')
			assert.equal(
				result.error,
				(tool.get_tool_label('upload_error_rejected') || 'The file could not be loaded.') + "\nInvalid EPSG code 'not-a-code'",
				'expected the panel\'s lead and the server\'s own reason'
			)
			// all three reach the wire: a dropped zone or band would make the server
			// refuse every UTM projection, and nothing else here would notice
			assert.deepInclude(sent.options, {epsg: 'not-a-code', zone: '30', band: 'N'})
		} finally {
			if (sent?.options?.file_data) {
				await release_staged([sent.options.file_data])
			}
		}
	})

	// a quiet drop, not the catch: building objects on a destroyed tool throws,
	// and the catch would answer an error and toast it
	it('upload_vector_file drops a response that arrives after detach_file_upload already ran', async function() {

		tool.attach_file_upload()

		let resolve_tool_request
		let staged = null
		stub_tool_request((options) => new Promise((resolve) => {
			staged = options.options.file_data
			resolve_tool_request = resolve
		}))

		const toasts	= []
		const token		= event_manager.subscribe('api_error', (error) => toasts.push(error))
		try {
			const before_layer_count = active_group().getLayers().length
			const pending = tool.upload_vector_file(sample_vector_file(), {})

			// the real staging upload runs first: tool_request has no "about to be
			// called" hook, so its arrival is polled
			await until(() => resolve_tool_request)
			assert.isOk(resolve_tool_request, 'expected tool_request reached within the wait budget')

			await tool.destroy(false, false, false)
			assert.equal(tool.upload_panel, null, 'expected the panel already torn down')

			resolve_tool_request({ok: true, data: {geojson: SAMPLE_UPLOAD_GEOJSON, feature_count: 1}})
			const result = await pending

			assert.deepEqual(result, {ok: false}, 'expected a quiet drop, with no error for a panel that is gone')
			assert.equal(toasts.length, 0, 'expected NO toast for an upload the closed tool left in flight')
			assert.equal(active_group().getLayers().length, before_layer_count, 'expected no object created')
		} finally {
			event_manager.unsubscribe(token)
			if (staged) {
				await release_staged([staged])
			}
		}
	})


	// UPLOAD FILE TO MAP, image half (image_upload.js), in the same panel. Only
	// the browser half is here — the panel, the refusal, the overlay lifecycle
	// — on carriers built by hand (IMAGE_DESCRIPTOR); the server half is
	// test/unit/tool_uca_maps_image_overlay.test.ts's.

	it('attach_file_upload builds one button and one hidden panel carrying both the vector and the image sub-flows', function() {

		tool.attach_file_upload()

		assert.isOk(
			geolocation.map.getContainer().querySelector('.uca-maps-upload-control'),
			'expected the "Upload file to map" toggle button'
		)
		assert.equal(tool.upload_panel.hidden, true, 'expected the panel hidden by default')
		assert.isOk(
			tool.upload_panel.querySelector('.uca-maps-upload-image-file'),
			'expected the image file input in the same panel'
		)
		assert.isOk(
			tool.upload_panel.querySelector('.uca-maps-upload-file'),
			'expected the vector file input still there — one row, one panel'
		)
		// the vector half uploads from its own button, the image half on pick,
		// so it has none (the header's × is toolbar.js's)
		assert.deepEqual(
			Array.from(tool.upload_panel.querySelectorAll(':scope > :not(.uca-maps-panel-header) button, :scope > button')).map(b => b.className),
			['uca-maps-upload-projections-button', 'uca-maps-upload-submit'],
			'expected v6\'s projections toggle and the vector Upload button, nothing in the image half'
		)
	})

	it('each half owns its status line: under the vector Upload button, under the image picker', function() {

		tool.attach_file_upload()

		const children	= Array.from(tool.upload_panel.children)
		const index		= (selector) => children.indexOf(tool.upload_panel.querySelector(selector))
		const messages	= tool.upload_panel.querySelectorAll('.uca-maps-upload-message')

		assert.equal(messages.length, 2, 'expected one status line per sub-flow')
		assert.equal(children.indexOf(messages[0]), index('.uca-maps-upload-submit') + 1, 'expected the vector line under its Upload button')
		assert.equal(children.indexOf(messages[1]), index('.uca-maps-upload-image-file') + 1, 'expected the image line under the image picker')
		assert.isAbove(
			index('.uca-maps-upload-epsg-row'), index('.uca-maps-upload-file'),
			'expected the projection fields BELOW the picker, in v6\'s order'
		)
		assert.isAbove(
			index('.uca-maps-upload-submit'), index('.uca-maps-upload-epsg-row'),
			'expected the Upload button after the fields it reads'
		)
	})

	it('the vector half is v6\'s modal: title, picker, projections toggle, EPSG/zone/band fields, projections list, then Upload', function() {

		tool.attach_file_upload()

		const panel		= tool.upload_panel
		const children	= Array.from(panel.children)
		const index		= (selector) => children.indexOf(panel.querySelector(selector))

		const title = panel.querySelector('.uca-maps-upload-vector-title')
		assert.isOk(title, 'expected the vector half titled, as the image half is')
		assert.equal(title.textContent, tool.get_tool_label('upload_vector_title') || 'Upload vector file')

		const order = [
			'.uca-maps-upload-vector-title', '.uca-maps-upload-file', '.uca-maps-upload-projections-button',
			'.uca-maps-upload-epsg-row', '.uca-maps-upload-projections-list', '.uca-maps-upload-submit',
			'.uca-maps-upload-message'
		].map(index)
		assert.deepEqual(order, [...order].sort((a, b) => a - b), 'expected v6\'s order, got ' + order)
		assert.notInclude(order, -1)

		const row		= panel.querySelector('.uca-maps-upload-epsg-row')
		const inputs	= Array.from(row.querySelectorAll('input'))
		assert.deepEqual(inputs.map(i => i.placeholder), ['32619', '19', 'N'], 'expected v6\'s three fields and placeholders')
		assert.deepEqual(inputs.map(i => i.getAttribute('aria-label')), ['EPSG', 'zone', 'band'])
		assert.deepEqual(
			Array.from(row.querySelectorAll('span')).map(s => s.textContent),
			['EPSG: ', 'zone: ', 'band: ']
		)
	})

	it('"Default projections" shows and hides v6\'s 18 codes', function() {

		tool.attach_file_upload()

		const button	= tool.upload_panel.querySelector('.uca-maps-upload-projections-button')
		const list		= tool.upload_panel.querySelector('.uca-maps-upload-projections-list')

		assert.equal(button.type, 'button')
		assert.equal(list.hidden, true, 'expected the list closed at first, as in v6')
		assert.equal(button.getAttribute('aria-expanded'), 'false')
		assert.equal((list.textContent.match(/EPSG:\d+/g) || []).length, 18)
		assert.include(list.textContent, 'EPSG:25830')

		button.click()
		assert.equal(list.hidden, false)
		assert.equal(button.getAttribute('aria-expanded'), 'true')

		button.click()
		assert.equal(list.hidden, true)
		assert.equal(button.getAttribute('aria-expanded'), 'false')
	})

	it('the epsg.io link follows the typed EPSG code, escaped', function() {

		tool.attach_file_upload()

		const input	= tool.upload_panel.querySelector('.uca-maps-upload-epsg')
		const link	= tool.upload_panel.querySelector('.uca-maps-upload-epsg-link')
		assert.equal(link.getAttribute('href'), 'https://epsg.io/')
		assert.equal(link.rel, 'noopener noreferrer')

		input.value = '25830'
		input.dispatchEvent(new Event('input'))
		assert.equal(link.getAttribute('href'), 'https://epsg.io/25830')
		assert.equal(link.textContent, 'https://epsg.io/25830')

		input.value = '"><b>x'
		input.dispatchEvent(new Event('input'))
		assert.equal(link.getAttribute('href'), 'https://epsg.io/' + encodeURIComponent('"><b>x'))
		assert.equal(link.children.length, 0, 'expected text only, never markup')
	})

	it('choosing an image uploads it, and its result lands in the image half only', async function() {

		tool.attach_file_upload()

		const picker	= tool.upload_panel.querySelector('.uca-maps-upload-image-file')
		const messages	= tool.upload_panel.querySelectorAll('.uca-maps-upload-message')
		const file		= image_file()

		let asked_for		= null
		let disabled_during	= null
		tool.upload_image_file = async function(given) {
			asked_for		= given
			disabled_during	= picker.disabled
			return {ok: true, georeferenced: true}
		}

		pick_file(picker, file)
		await tick()

		assert.equal(asked_for, file, 'expected the upload fired by the pick, with no second click')
		assert.equal(disabled_during, true, 'expected the picker disabled for the round trip')
		assert.equal(picker.disabled, false, 'expected the picker enabled again afterwards')
		assert.equal(picker.value, '', 'expected the picker emptied, so the same file can be picked again')
		assert.equal(messages[0].hidden, true, 'expected the vector half\'s line untouched')
		assert.equal(messages[1].hidden, false, 'expected the result in the image half')
		assert.equal(messages[1].textContent, tool.get_tool_label('upload_image_success_placed') || 'Image placed at its own coordinates.')
		assert.equal(messages[1].dataset.type, 'ok', 'expected a success, not the error tint')
	})

	it('an upload of either half that outlives the panel writes nothing to it', async function() {

		const rows = [
			{
				label	: 'vector',
				picker	: '.uca-maps-upload-file',
				line	: 0,
				method	: 'upload_vector_file',
				start	: (panel, picker) => {
					load_file(picker, vector_file())
					panel.querySelector('.uca-maps-upload-submit').click()
				}
			},
			{
				label	: 'image',
				picker	: '.uca-maps-upload-image-file',
				line	: 1,
				method	: 'upload_image_file',
				start	: (_panel, picker) => pick_file(picker, image_file())
			}
		]
		for (const row of rows) {
			tool.attach_file_upload()

			const panel		= tool.upload_panel
			const picker	= panel.querySelector(row.picker)
			const submit	= panel.querySelector('.uca-maps-upload-submit')
			const message	= panel.querySelectorAll('.uca-maps-upload-message')[row.line]

			let settle = null
			tool[row.method] = function() {
				return new Promise((resolve) => { settle = resolve })
			}

			row.start(panel, picker)
			await tick()
			assert.isOk(settle, `expected the upload in flight: ${row.label}`)

			detach_file_upload(tool) // the panel's own teardown, as destroy() runs it
			assert.equal(tool.upload_panel, null, `expected the panel already torn down: ${row.label}`)
			const left = {hidden: message.hidden, text: message.textContent, submit: submit.disabled}
			settle({ok: false, error: 'late answer'})
			await tick()

			assert.equal(message.isConnected, false, `expected the panel gone: ${row.label}`)
			assert.deepEqual(
				{hidden: message.hidden, text: message.textContent, submit: submit.disabled}, left,
				`expected the late answer never written: ${row.label}`
			)
			assert.equal(picker.disabled, true, `expected the detached picker left as it was: ${row.label}`)
		}
	})

	/** Runs `fn` with window.setTimeout recorded: each timer's id, delay and callback. */
	const timers_set_by = async function(fn) {
		const timers	= []
		const original	= window.setTimeout
		window.setTimeout = function(callback, ms, ...rest) {
			const id = original.call(window, callback, ms, ...rest)
			timers.push({id, ms, callback})
			return id
		}
		try {
			await fn()
		} finally {
			window.setTimeout = original
		}
		return timers
	}

	// the map is the confirmation of a success, so its line goes; an error, or
	// a file that read nothing, is read while fixing the input, so it stays
	it('a success or caveat line hides after UPLOAD_MESSAGE_MS; an error or "read nothing" stays until the next gesture', async function() {

		assert.isAtLeast(UPLOAD_MESSAGE_MS, 1000, 'expected a couple of seconds, long enough to be read')
		assert.isAtMost(UPLOAD_MESSAGE_MS, 3000, 'expected a couple of seconds, not a lingering line')

		tool.attach_file_upload()

		const panel			= tool.upload_panel
		const messages		= panel.querySelectorAll('.uca-maps-upload-message')
		const vector_picker	= panel.querySelector('.uca-maps-upload-file')
		const image_picker	= panel.querySelector('.uca-maps-upload-image-file')
		const submit		= panel.querySelector('.uca-maps-upload-submit')

		const halves = {
			vector	: {
				method	: 'upload_vector_file',
				message	: messages[0],
				run		: () => {
					load_file(vector_picker, vector_file())
					submit.click()
				},
				// the next Upload clears the line before its own answer
				next	: {hidden: true}
			},
			image	: {
				method	: 'upload_image_file',
				message	: messages[1],
				run		: () => pick_file(image_picker, image_file()),
				// the next pick replaces it with its neutral working line
				next	: {hidden: false, text: 'Uploading the image…', type: 'info'}
			}
		}
		const rows = [
			{
				half	: 'image',
				answer	: {ok: true, georeferenced: false},
				text	: tool.get_tool_label('upload_image_success_viewport') || 'The image carries no coordinates: placed over the current view.',
				type	: 'warning',
				hides	: true
			},
			{half: 'image', answer: {ok: false, error: 'the ingest refused it'}, text: 'the ingest refused it', type: 'error', hides: false},
			{
				half	: 'vector',
				answer	: {ok: true, feature_count: 2},
				text	: (tool.get_tool_label('upload_success_message') || 'File uploaded successfully.') + ' (2)',
				type	: 'ok',
				hides	: true,
				// only a success empties the picker: a failure keeps the file for the retry
				check	: () => assert.equal(vector_picker.value, '', 'expected the picker emptied after a success')
			},
			{
				half	: 'vector',
				answer	: {ok: true, feature_count: 0},
				text	: tool.get_tool_label('upload_no_features') || 'No objects could be read from this file.',
				type	: 'warning',
				hides	: false
			},
			{half: 'vector', answer: {ok: false, error: 'zone and band do not match'}, text: 'zone and band do not match', type: 'error', hides: false}
		]
		for (const row of rows) {
			const half		= halves[row.half]
			const message	= half.message
			const label		= `${row.half} ${JSON.stringify(row.answer)}`
			tool[half.method] = async function() { return row.answer }

			const timers = await timers_set_by(async () => {
				half.run()
				await tick()
			})

			assert.equal(message.hidden, false, `expected the line shown: ${label}`)
			assert.equal(message.textContent, row.text, label)
			assert.equal(message.dataset.type, row.type, label)
			if (row.check) {
				row.check()
			}
			if (row.hides) {
				const timer = timers.find((candidate) => candidate.id===message._uca_maps_hide_timer)
				assert.isOk(timer, `expected a hide timer armed: ${label}`)
				assert.equal(timer.ms, UPLOAD_MESSAGE_MS, label)
				timer.callback()
				assert.equal(message.hidden, true, `expected the line gone once its timer fires: ${label}`)
				continue
			}
			assert.isNull(message._uca_maps_hide_timer, `expected NO hide timer, the line stays: ${label}`)

			// the next gesture is what removes it, before its own answer
			let settle = null
			tool[half.method] = () => new Promise((resolve) => { settle = resolve })
			half.run()
			assert.equal(message.hidden, half.next.hidden, `expected the next gesture to take the line: ${label}`)
			if (!half.next.hidden) {
				assert.equal(message.textContent, half.next.text, label)
				assert.equal(message.dataset.type, half.next.type, label)
			}
			settle({ok: false})
			await tick()
		}
	})

	it('UP closed by a SIBLING panel reopens clean too, in both halves', async function() {

		tool.attach_file_upload()
		tool.attach_map_image_download_control()

		const panel			= tool.upload_panel
		const messages		= panel.querySelectorAll('.uca-maps-upload-message')
		const vector_picker	= panel.querySelector('.uca-maps-upload-file')
		const image_picker	= panel.querySelector('.uca-maps-upload-image-file')
		tool.upload_vector_file	= async function() { return {ok: false, error: 'vector refused'} }
		tool.upload_image_file	= async function() { return {ok: false, error: 'image refused'} }

		tool.upload_control.getContainer().click()

		load_file(vector_picker, vector_file())
		panel.querySelector('.uca-maps-upload-epsg').value = '25830'
		panel.querySelector('.uca-maps-upload-submit').click()
		pick_file(image_picker, image_file())
		await tick()
		assert.equal(messages[0].hidden, false, 'expected the vector error shown')
		assert.equal(messages[1].hidden, false, 'expected the image error shown')

		// closed by toolbar.js close_other_toolbar_panels, never by UP's own toggle
		tool.map_image_control.getContainer().click()
		assert.equal(panel.hidden, true, 'expected UP closed by the sibling')
		tool.upload_control.getContainer().click()

		assert.equal(messages[0].hidden, true, 'expected no vector message')
		assert.equal(messages[1].hidden, true, 'expected no image message')
		assert.equal(vector_picker.files.length, 0, 'expected no vector file chosen')
		assert.equal(image_picker.value, '', 'expected no image file chosen')
		assert.equal(panel.querySelector('.uca-maps-upload-epsg').value, '', 'expected EPSG empty')
	})

	it('reopening UP mid-upload leaves that half\'s file and working line alone', async function() {

		tool.attach_file_upload()

		const panel		= tool.upload_panel
		const toggle	= () => tool.upload_control.getContainer().click()
		const picker	= panel.querySelector('.uca-maps-upload-image-file')
		const message	= panel.querySelectorAll('.uca-maps-upload-message')[1]

		let settle = null
		tool.upload_image_file = function() {
			return new Promise((resolve) => { settle = resolve })
		}

		toggle()
		pick_file(picker, image_file())
		await tick()
		assert.isOk(settle, 'expected the upload in flight')
		assert.equal(message.hidden, false, 'expected the working line shown')

		toggle()
		toggle()
		assert.equal(message.hidden, false, 'expected the working line kept while the upload runs')
		assert.equal(picker.disabled, true, 'expected the picker still locked')

		settle({ok: true, georeferenced: true})
		await tick()
		assert.equal(message.textContent, tool.get_tool_label('upload_image_success_placed') || 'Image placed at its own coordinates.')
		assert.equal(picker.disabled, false)
	})

	it('reopening UP mid vector upload leaves its file, fields and controls alone', async function() {

		tool.attach_file_upload()

		const panel		= tool.upload_panel
		const toggle	= () => tool.upload_control.getContainer().click()
		const picker	= panel.querySelector('.uca-maps-upload-file')
		const submit	= panel.querySelector('.uca-maps-upload-submit')
		const message	= panel.querySelectorAll('.uca-maps-upload-message')[0]
		const inputs	= Array.from(panel.querySelectorAll('.uca-maps-upload-epsg-row input'))
		const file		= vector_file()

		let settle = null
		tool.upload_vector_file = function() {
			return new Promise((resolve) => { settle = resolve })
		}

		toggle()
		load_file(picker, file)
		inputs[0].value = '25830'
		inputs[1].value = '30'
		inputs[2].value = 'N'
		submit.click()
		await tick()
		assert.isOk(settle, 'expected the upload in flight')

		toggle()
		toggle()
		assert.equal(picker.files[0], file, 'expected the file kept while the upload runs')
		assert.deepEqual(inputs.map(i => i.value), ['25830', '30', 'N'], 'expected the fields kept')
		assert.equal(picker.disabled, true, 'expected the picker still locked')
		assert.equal(submit.disabled, true, 'expected Upload still locked')

		settle({ok: true, feature_count: 1})
		await tick()
		assert.equal(message.textContent, (tool.get_tool_label('upload_success_message') || 'File uploaded successfully.') + ' (1)')
		assert.equal(submit.disabled, false)
	})

	it('reopening UP starts clean, as v6\'s rebuilt modal: no message, no file, no projection', async function() {

		tool.attach_file_upload()

		const panel		= tool.upload_panel
		const toggle	= () => tool.upload_control.getContainer().click()
		const picker	= panel.querySelector('.uca-maps-upload-file')
		const epsg		= panel.querySelector('.uca-maps-upload-epsg')
		const link		= panel.querySelector('.uca-maps-upload-epsg-link')
		const list		= panel.querySelector('.uca-maps-upload-projections-list')
		const message	= panel.querySelectorAll('.uca-maps-upload-message')[0]
		tool.upload_vector_file = async function() { return {ok: false, error: 'Please choose a file first.'} }

		toggle()
		assert.equal(panel.hidden, false, 'expected UP open')

		load_file(picker, vector_file())
		epsg.value = '25830'
		epsg.dispatchEvent(new Event('input'))
		panel.querySelector('.uca-maps-upload-zone').value = '30'
		panel.querySelector('.uca-maps-upload-band').value = 'N'
		panel.querySelector('.uca-maps-upload-projections-button').click()
		panel.querySelector('.uca-maps-upload-submit').click()
		await tick()
		assert.equal(message.hidden, false, 'expected the error shown')

		toggle()
		assert.equal(panel.hidden, true, 'expected UP closed')
		toggle()

		assert.equal(message.hidden, true, 'expected no message on reopening')
		assert.equal(picker.files.length, 0, 'expected no file chosen')
		assert.deepEqual(
			Array.from(panel.querySelectorAll('.uca-maps-upload-epsg-row input')).map(i => i.value),
			['', '', ''], 'expected EPSG, zone and band empty'
		)
		assert.equal(link.getAttribute('href'), 'https://epsg.io/', 'expected the epsg.io link back to its base')
		assert.equal(list.hidden, true, 'expected the projections list closed')
	})

	it('the teardown cancels a pending hide timer', async function() {

		tool.attach_file_upload()

		const picker	= tool.upload_panel.querySelector('.uca-maps-upload-image-file')
		const message	= tool.upload_panel.querySelectorAll('.uca-maps-upload-message')[1]
		tool.upload_image_file = async function() { return {ok: true, georeferenced: true} }

		pick_file(picker, image_file())
		await tick()
		const timer = message._uca_maps_hide_timer
		assert.isOk(timer, 'expected a hide timer armed')

		const cleared			= []
		const original_clear	= window.clearTimeout
		window.clearTimeout = function(id) {
			cleared.push(id)
			return original_clear.call(window, id)
		}
		try {
			await tool.destroy(false, false, false)
		} finally {
			window.clearTimeout = original_clear
		}
		assert.include(cleared, timer, 'expected the armed timer itself cancelled, not just forgotten')
		assert.equal(message._uca_maps_hide_timer, null, 'expected the timer cancelled with the panel')
	})

	it('choosing a vector file uploads nothing; Upload sends it with the EPSG, zone and band typed, and a failure keeps it', async function() {

		tool.attach_file_upload()

		const picker	= tool.upload_panel.querySelector('.uca-maps-upload-file')
		const submit	= tool.upload_panel.querySelector('.uca-maps-upload-submit')
		const messages	= tool.upload_panel.querySelectorAll('.uca-maps-upload-message')
		tool.upload_panel.querySelector('.uca-maps-upload-epsg').value = '25830'
		tool.upload_panel.querySelector('.uca-maps-upload-zone').value = '30'
		tool.upload_panel.querySelector('.uca-maps-upload-band').value = 'N'

		let asked_for = null
		tool.upload_vector_file = async function(file, projection) {
			asked_for = {file, projection}
			return {ok: false, error: 'no coordinate system'}
		}

		const file = vector_file()
		pick_file(picker, file)
		await tick()
		assert.equal(asked_for, null, 'expected choosing the file to upload nothing')

		submit.click()
		await tick()

		assert.deepEqual(
			asked_for, {file, projection: {epsg: '25830', zone: '30', band: 'N'}},
			'expected Upload to send the chosen file with the three fields\' values'
		)
		// the retry is: correct the fields, press Upload again
		assert.equal(picker.files[0], file, 'expected the file kept after a failure')
		assert.equal(submit.disabled, false, 'expected Upload enabled again')
		assert.equal(messages[0].textContent, 'no coordinate system', 'expected the error in the vector half')
		assert.equal(messages[1].hidden, true, 'expected the image half\'s line untouched')
	})

	/** The body core's tool_request sends for `action` and `options`, captured, never sent. */
	const tool_request_body = async function(action, options) {
		let body = null
		const original = data_manager.request
		data_manager.request = async function(request) {
			body = request.body
			return {ok: true, data: null}
		}
		try {
			await tool_uca_maps.prototype.tool_request.call(tool, {action, options})
		} finally {
			data_manager.request = original
		}
		return body
	}

	/** A real 1x1 PNG: the staging endpoint checks the file signature. */
	const png_file = () => new File(
		[Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0))],
		'plan.png', {type: 'image/png'}
	)

	/**
	* Stands in for core's create, the ingest, the file check and delete, so no
	* record is ever written; the staging upload stays real (service_upload).
	* `ingest` answers per call; every staged file is kept for release_staged.
	* The file check answers "no file" unless `file_check` says otherwise.
	*/
	const no_image_file = () => ({ok: false, error: {is_api_error: true, code: 'media.file_not_found', message: 'The image is no longer on the server.', transport: false}})
	const stub_image_record_doors = function(new_id, ingest, delete_answer, file_check=no_image_file) {
		const original_request = data_manager.request
		const seen = {created: [], deleted: [], staged: [], checked: []}
		data_manager.request = async function(options) {
			const body = options && options.body
			if (body && body.action==='create') {
				seen.created.push(body)
				return {ok: true, data: new_id}
			}
			if (body && body.action==='tool_request' && body.source && body.source.action==='process_uploaded_file') {
				seen.staged.push(body.options.file_data)
				return ingest()
			}
			if (body && body.action==='tool_request' && body.source && body.source.action==='get_image_file') {
				seen.checked.push(body.options)
				return file_check()
			}
			if (body && body.action==='delete') {
				seen.deleted.push(body)
				return delete_answer()
			}
			return original_request.apply(this, arguments)
		}
		seen.restore = async function() {
			data_manager.request = original_request
			return await release_staged(seen.staged)
		}
		return seen
	}

	// only a refusal raised before the file moved, with no file found after it,
	// proves the record empty; any other answer may still be filling it, so it
	// is named, never deleted
	it('only a refusal raised before the file moved, on a record with no file, deletes it; any other failure names it', async function() {

		const NEW_ID	= 987654
		const reason	= 'The staged file is not an image'
		const refusal	= {is_api_error: true, code: 'request.invalid_options', label_key: 'error_request_invalid_options', message: reason, transport: false}
		const record_left = 'Image record ' + NEW_ID + ' may have been left empty: review it.'
		const rows = [
			{
				label	: 'a clean ingest',
				ingest	: null,
				answer	: null,
				deletes	: false,
				result	: {ok: true, section_id: NEW_ID}
			},
			{
				label	: 'an envelope refusal',
				ingest	: refusal,
				answer	: {ok: true, data: [NEW_ID]},
				deletes	: true,
				result	: {ok: false, error: `The image could not be loaded.\n${reason}`, staged_untouched: true}
			},
			{
				label	: 'a timeout: the server may still finish',
				ingest	: {is_api_error: true, code: 'client.timeout', message: 'The request timed out', transport: true},
				answer	: null,
				deletes	: false,
				result	: {ok: false, error: `The request timed out\n${record_left}`, staged_untouched: false}
			},
			{
				// what a resend gets while the first attempt is still ingesting
				label	: 'an idempotency replay: an envelope, yet the ingest is running',
				ingest	: {is_api_error: true, code: 'idempotency.in_progress', message: 'Still running', transport: false},
				answer	: null,
				deletes	: false,
				result	: {ok: false, error: `Still running\n${record_left}`, staged_untouched: false}
			},
			{
				// persistUploadedMedia refusing AFTER the file is in the media tree
				label	: 'a failure after the move: the file is on disk',
				ingest	: {is_api_error: true, code: 'db.lock_timeout', message: 'Lock timeout', transport: false},
				answer	: null,
				deletes	: false,
				result	: {ok: false, error: `Lock timeout\n${record_left}`, staged_untouched: false}
			},
			{
				// a resend re-run after a restart: the first run consumed the staged file
				label	: 'a staged file already consumed',
				ingest	: {is_api_error: true, code: 'media.file_not_found', message: 'Staged upload not found', transport: false},
				answer	: null,
				deletes	: false,
				result	: {ok: false, error: `The image could not be loaded.\nStaged upload not found\n${record_left}`, staged_untouched: false}
			},
			{
				label	: 'an envelope refusal whose delete is refused',
				ingest	: refusal,
				answer	: {ok: false, error: {is_api_error: true, code: 'perm.denied', message: 'Permission denied', transport: false}},
				deletes	: true,
				result	: {ok: false, error: `The image could not be loaded.\n${reason}\n${record_left}`, staged_untouched: true}
			},
			{
				// core answers no id for a record it did not find, or one it kept
				label	: 'an envelope refusal whose delete removes nothing',
				ingest	: refusal,
				answer	: {ok: true, data: []},
				deletes	: true,
				result	: {ok: false, error: `The image could not be loaded.\n${reason}\n${record_left}`, staged_untouched: true}
			},
			{
				// a refusal core raises after the move one day: the file is the fact
				label	: 'an envelope refusal on a record that holds a file',
				ingest	: refusal,
				check	: () => ({ok: true, data: {file_path: '/image/1.5MB/0/rsc29_rsc170_' + NEW_ID + '.jpg', quality: '1.5MB'}}),
				answer	: null,
				deletes	: false,
				result	: {ok: false, error: `The image could not be loaded.\n${reason}\n${record_left}`, staged_untouched: true}
			},
			{
				label	: 'an envelope refusal whose file check fails',
				ingest	: refusal,
				check	: () => ({ok: false, error: {is_api_error: true, code: 'client.timeout', message: 'The request timed out', transport: true}}),
				answer	: null,
				deletes	: false,
				result	: {ok: false, error: `The image could not be loaded.\n${reason}\n${record_left}`, staged_untouched: true}
			}
		]

		const released = []
		for (const row of rows) {
			const seen = stub_image_record_doors(
				NEW_ID,
				() => (row.ingest ? {ok: false, error: row.ingest} : {ok: true, data: true}),
				() => row.answer,
				row.check
			)
			let result
			try {
				result = await ingest_image_upload(tool, png_file())
			} finally {
				released.push(...await seen.restore())
			}

			assert.equal(seen.created.length, 1, `expected the record minted before the ingest: ${row.label}`)
			assert.equal(seen.created[0].source.section_tipo, IMAGE_SECTION_TIPO, `expected it minted in the Images section: ${row.label}`)
			assert.deepEqual(result, row.result, row.label)
			const pre_move = row.ingest===refusal
			assert.deepEqual(seen.checked, pre_move
				? [{tipo: IMAGE_COMPONENT_TIPO, section_tipo: IMAGE_SECTION_TIPO, section_id: NEW_ID}]
				: [], `expected the minted record's file checked only after a pre-move refusal: ${row.label}`)
			if (row.deletes) {
				assert.deepEqual(seen.deleted, [{
					action	: 'delete',
					source	: {delete_mode: 'delete_record', section_tipo: IMAGE_SECTION_TIPO, section_id: NEW_ID}
				}], `expected the minted record, and only it, deleted once: ${row.label}`)
			} else {
				assert.deepEqual(seen.deleted, [], `expected nothing deleted: ${row.label}`)
			}
		}
		assert.equal(released.length, rows.length, 'expected every row\'s staged file released')
		assert.isTrue(released.every((answer) => answer && answer.ok!==false), `expected the staging left clean: ${JSON.stringify(released)}`)
	})

	// a request.invalid_options refusal of the step after the ingest: the
	// image's lead, then the server's reason on its own line
	it('an image refusal with a reason shows its lead, then the reason: the map overlay and an associated image', async function() {

		tool.attach_file_upload()
		const layer = seeded_layer(1)
		tool.active_console_layer = layer

		const reason	= 'Coordinates out of range'
		const rows		= [
			{label: 'overlay', action: 'get_image_overlay', run: () => tool.upload_image_file(png_file())},
			{label: 'associate_image', action: 'get_image_file', run: () => associate_image(tool, layer, png_file())}
		]
		const seen = stub_image_record_doors(9100, () => ({ok: true, data: true}), () => ({ok: true, data: []}))
		let released = []
		try {
			for (const row of rows) {
				let asked = null
				stub_tool_request(async function(options) {
					if (options.action!==row.action) {
						return real_tool_request(options)
					}
					asked = options.action
					return {ok: false, error: {
						is_api_error	: true,
						code			: 'request.invalid_options',
						label_key		: 'error_request_invalid_options',
						message			: reason,
						transport		: false
					}}
				})
				const result = await row.run()
				assert.equal(asked, row.action, `expected the step after the ingest reached: ${row.label}`)
				assert.deepEqual(result, {ok: false, error: `The image could not be loaded.\n${reason}`}, row.label)
			}
		} finally {
			released = await seen.restore()
		}
		assert.deepEqual(object_images(layer), [], 'expected nothing hung off the object')
		assert.equal(released.length, rows.length, 'expected both staged files released')
	})

	// a link can fail past the stage too: a stage that names no file, or an
	// ingested image the server does not serve
	it('import_linked_images names a link whose stage brings no file, or whose ingested image is not served', async function() {

		const layer = seeded_layer(1)
		tool.active_console_layer = layer
		const empty		= {url: 'https://images.example/empty.jpg'}
		const unserved	= {url: 'https://images.example/unserved.jpg'}
		layer.feature.properties.images = [empty, unserved]
		layer.feature.properties.uca_maps = {}

		const reason	= 'No displayable version'
		const seen		= stub_linked_import((url) => (url===empty.url ? {ok: true, data: {}} : staged_answer('unserved.jpg')))
		const stub_body	= data_manager.request
		let stage_body	= null
		data_manager.request = function(options, ...rest) {
			const body = options?.body
			if (body?.source?.action==='stage_external_image' && !stage_body) {
				stage_body = body
			}
			return stub_body.call(this, options, ...rest)
		}
		stub_tool_request(async function(options) {
			return options.action==='get_image_file'
				? {ok: false, error: {is_api_error: true, code: 'request.invalid_options', message: reason, transport: false}}
				: real_tool_request(options)
		})
		try {
			const result = await import_linked_images(tool, layer)

			assert.deepEqual(result.failures, [
				{url: empty.url, error: 'The image could not be loaded.'},
				{url: unserved.url, error: `The image could not be loaded.\n${reason}`}
			], 'expected each link named with why it failed')
			assert.equal(result.imported, 0)
			assert.equal(seen.created, 1, 'expected a record minted only for the link that staged a file')
			assert.deepEqual(layer.feature.properties.images, [empty, unserved], 'expected both links kept')
			assert.deepEqual(object_images(layer), [], 'expected nothing hung off the object')

			data_manager.request = stub_body
			assert.deepEqual(stage_body, await tool_request_body('stage_external_image', stage_body.options),
				'expected the stage sent as tool_request builds it, its own timeout apart')
		} finally {
			data_manager.request = stub_body
			seen.restore()
		}
	})

	it('import_linked_images asks nothing while an import is already running', async function() {

		const layer = seeded_layer(1)
		tool.active_console_layer = layer
		layer.feature.properties.images = [{url: 'https://images.example/a.jpg'}]
		layer.feature.properties.uca_maps = {}

		let stage = null
		const seen = stub_linked_import(() => new Promise((resolve) => { stage = resolve }))
		try {
			const first = import_linked_images(tool, layer)
			await until(() => stage)

			const second = await import_linked_images(tool, layer)
			assert.deepEqual(second, {ok: false, imported: 0, failures: []}, 'expected the second run refused outright')
			assert.equal(seen.stages.length, 1, 'expected only the first run to download anything')

			// control: the first run is unaffected and imports its link
			stage(staged_answer('a.jpg'))
			assert.equal((await first).imported, 1, 'expected the running import to finish its link')
		} finally {
			seen.restore()
		}
	})

	it('attach_image_overlays rebuilds a saved overlay from its carrier rectangle', async function() {

		const carrier = add_image_carrier()

		tool.attach_image_overlays()

		// the plugin loads on demand (classic <script>), so the overlay
		// appears asynchronously
		await await_overlay(carrier)

		assert.isOk(carrier._uca_maps_overlay, 'expected the overlay rebuilt from properties.uca_maps.image')
		assert.equal(
			geolocation.map.hasLayer(carrier._uca_maps_overlay), true,
			'expected the overlay actually on the map'
		)
		assert.equal(tool._image_overlays.length, 1, 'expected the overlay tracked for teardown')
	})

	it('a coordinate-less image keeps its own aspect ratio and does not fill the viewport', function() {

		// v6 stretches the image onto map.getBounds(): every image distorts the
		// moment the map is not square, and it hides the map it must be placed
		// against. Both departures are deliberate (corners_from_viewport).
		const viewport	= geolocation.map.getSize()
		assert.isAbove(viewport.x, 0, 'expected a laid-out map — every assertion below is in its pixels')
		assert.isAbove(viewport.y, 0, 'expected a laid-out map — every assertion below is in its pixels')
		const map_ratio	= viewport.x / viewport.y

		// a deliberately NON-square image, so a stretched result is unmissable
		const corners = corners_from_viewport(geolocation.map, {width: 400, height: 100})

		// measured back in PIXELS, as degrees of lat and lon differ on screen.
		// Unrounded (map.project): latLngToContainerPoint rounds to whole pixels,
		// which on a short map moves a 4:1 ratio by more than any tolerance means
		const to_point	= (c) => geolocation.map.project(L.latLng(c[0], c[1]))
		const tl		= to_point(corners.top_left)
		const tr		= to_point(corners.top_right)
		const bl		= to_point(corners.bottom_left)
		const drawn_w	= tr.x - tl.x
		const drawn_h	= bl.y - tl.y
		assert.isAbove(drawn_h, 1, 'expected an image tall enough to measure a ratio on')

		assert.closeTo(drawn_w / drawn_h, 4, 0.01, 'expected the image\'s own 4:1 ratio preserved, not the map\'s')
		assert.isAbove(
			Math.abs(drawn_w / drawn_h - map_ratio), 0.05,
			'expected the image NOT stretched to the viewport ratio (the v6 bug this replaces)'
		)

		// half the shorter side, and centred in the container
		assert.closeTo(drawn_w, Math.min(viewport.x, viewport.y) * 0.5, 1, 'expected half the shorter viewport side')
		const in_container = (c) => geolocation.map.latLngToContainerPoint(L.latLng(c[0], c[1]))
		assert.closeTo((in_container(corners.top_left).x + in_container(corners.top_right).x) / 2, viewport.x / 2, 1, 'expected horizontally centred')
		assert.closeTo((in_container(corners.top_left).y + in_container(corners.bottom_left).y) / 2, viewport.y / 2, 1, 'expected vertically centred')
	})

	it('create_image_object flags the object is_raster so the object viewer lists it as a raster', async function() {

		// the PRODUCTION builder, not a hand-made carrier: object_viewer.js
		// splits its two lists on properties.uca_maps.is_raster and its own
		// header names THIS row as what fills the raster one, so the flag has
		// to be written where the object is actually created
		const carrier = await create_image_object(tool, image_descriptor())

		await settle_map(geolocation.map)

		assert.equal(carrier.feature.properties.uca_maps.is_raster, true, 'expected is_raster written by the builder')
		assert.isOk(carrier.feature.properties.uca_maps.image, 'expected the image descriptor stored on the object')

		const objects = collect_objects(tool)

		assert.equal(objects.raster_objects.length, 1, 'expected the image in the RASTER list')
		assert.equal(
			objects.vector_objects.some((el) => el.layer===carrier), false,
			'expected the image NOT in the vector list'
		)
	})

	// a plain image lands at an arbitrary spot, so the next gesture is moving
	// it: v6 uploads straight into edit mode. The builder fills a MISSING flag,
	// it never decides for a caller that set one
	it('create_image_object hands a new image back editable, as v6 does, and keeps an interactive flag already given', async function() {

		for (const [given, expected] of [[undefined, true], [false, false]]) {
			const descriptor = image_descriptor()
			if (given===undefined) {
				delete descriptor.interactive
			} else {
				descriptor.interactive = given
			}

			const carrier = await create_image_object(tool, descriptor)
			await settle_map(geolocation.map)

			assert.equal(
				carrier.feature.properties.uca_maps.image.interactive, expected,
				`expected interactive ${expected} for a descriptor giving ${given}`
			)
		}
	})

	it('the carrier is sealed from Geoman editing but still removable', async function() {

		// component_geolocation.js click handler calls layer.pm.enable() on
		// every layer of the clicked FeatureGroup — which painted four vertex
		// circles over the image, competing with this module's three handles.
		// Removal must survive: Geoman's remove tool is how an image is deleted
		const carrier = await create_image_object(tool, image_descriptor())
		await settle_map(geolocation.map)

		assert.equal(carrier.pm.options.allowEditing, false, 'expected Geoman editing refused on the carrier')
		assert.notEqual(carrier.pm.options.allowRemoval, false, 'expected Geoman removal still allowed')

		// and the enable() the component fires on click must be a no-op
		carrier.pm.enable()
		assert.equal(carrier.pm.enabled(), false, 'expected pm.enable() to leave the carrier un-edited')
	})

	it('dragging the carrier carries the picture, the handles and the stored corners with it', async function() {

		// Geoman's drag mode grabs the CARRIER, a transparent rectangle: unless
		// the picture follows, the user drags an invisible box and nothing seems
		// to move. v6 could not drag an image at all
		const carrier = await create_image_object(tool, image_descriptor())
		await settle_map(geolocation.map)

		const before	= JSON.parse(JSON.stringify(carrier.feature.properties.uca_maps.image.corners))
		const handles	= carrier._uca_maps_handles
		assert.equal(handles && handles.length, 3, 'expected the three handles up (a new image is editable)')

		const delta_lat = 0.01
		const delta_lng = 0.02

		// what Geoman itself does: move the layer, then announce it
		carrier.fire('pm:dragstart')
		carrier.setLatLngs(carrier.getLatLngs()[0].map(
			(el) => L.latLng(el.lat + delta_lat, el.lng + delta_lng)
		))
		carrier.fire('pm:dragend')

		const after = carrier.feature.properties.uca_maps.image.corners
		for (const key of ['top_left', 'top_right', 'bottom_left']) {
			assert.closeTo(after[key][0], before[key][0] + delta_lat, 1e-9, key + ' lat followed the carrier')
			assert.closeTo(after[key][1], before[key][1] + delta_lng, 1e-9, key + ' lng followed the carrier')
		}

		// TRANSLATION ONLY: the shape is the handles' job, so the drag must not
		// have skewed or scaled anything
		assert.closeTo(
			after.top_right[1] - after.top_left[1],
			before.top_right[1] - before.top_left[1], 1e-9,
			'expected the width unchanged by a drag'
		)

		// the picture itself, and every handle, at the stored corners
		const overlay = carrier._uca_maps_overlay
		assert.isOk(overlay, 'expected the picture on the map')
		const placed = {top_left: overlay._topLeft, top_right: overlay._topRight, bottom_left: overlay._bottomLeft}
		const keys = ['top_left', 'top_right', 'bottom_left']
		keys.forEach((key, index) => {
			for (const [label, latlng] of [['picture', placed[key]], ['handle', handles[index].getLatLng()]]) {
				assert.closeTo(latlng.lat, after[key][0], 1e-9, `expected the ${label}'s ${key} moved with the carrier`)
				assert.closeTo(latlng.lng, after[key][1], 1e-9, `expected the ${label}'s ${key} moved with the carrier`)
			}
		})
	})

	it('two concurrent hydrations never paint the same image twice', async function() {

		// hydrate_image_overlays runs un-serialized on every layer-data event
		// and the plugin load suspends: without a synchronous claim on the
		// carrier, an edit during that window starts a second rebuild that
		// paints a duplicate only one of which anything can reach afterwards
		const carrier = add_image_carrier()

		tool.attach_image_overlays()
		event_manager.publish('updated_layer_data_' + geolocation.id_base, {})
		event_manager.publish('updated_layer_data_' + geolocation.id_base, {})

		await await_overlay(carrier)
		// let any racing rebuild finish before counting
		await tick(100)

		assert.equal(tool._image_overlays.length, 1, 'expected exactly one overlay, not a stacked duplicate')
	})

	/** The overlay plugin, loaded as the tool loads it, so a test can wrap its factory first. */
	const rotated_plugin_loaded = function() {
		if (L.imageOverlay.rotated) {
			return Promise.resolve()
		}
		return new Promise((resolve, reject) => {
			const script	= document.createElement('script')
			script.src		= new URL('../../../tools/tool_uca_maps/js/lib/leaflet-imageoverlay-rotated/leaflet-imageoverlay-rotated.js', import.meta.url).href
			script.onload	= resolve
			script.onerror	= reject
			document.head.appendChild(script)
		})
	}

	// the claim on the carrier is released in a finally: a throw while building
	// the picture must not leave it claimed, or no later hydration could paint it
	it('a hydration that throws releases its claim on the carrier, so the next one paints a single overlay', async function() {

		await rotated_plugin_loaded()
		const original_rotated	= L.imageOverlay.rotated
		let throws				= 1
		L.imageOverlay.rotated = function(...args) {
			if (throws > 0) {
				throws--
				throw new Error('Boom.')
			}
			return original_rotated.apply(this, args)
		}
		const toasts	= []
		const token		= event_manager.subscribe('api_error', (error) => toasts.push(error))
		try {
			const carrier = add_image_carrier()
			tool.attach_image_overlays()
			await until(() => toasts.length > 0)

			assert.deepEqual(toasts.map((toast) => toast.message), ['Boom.'], 'expected the rebuild rejected with the throw, and reported once')
			assert.isUndefined(carrier._uca_maps_overlay, 'expected no picture from the failed build')
			assert.notProperty(carrier, '_uca_maps_overlay_pending', 'expected the claim released by the failure')

			event_manager.publish(`updated_layer_data_${geolocation.id_base}`, {})
			await await_overlay(carrier)
			await tick(100)
			assert.isOk(carrier._uca_maps_overlay, 'expected the next hydration to paint the picture')
			assert.equal(tool._image_overlays.length, 1, 'expected exactly one overlay')
		} finally {
			L.imageOverlay.rotated = original_rotated
			event_manager.unsubscribe(token)
		}
	})

	it('hiding an uploaded image hides the picture, not just its carrier', async function() {

		const carrier = add_image_carrier()
		tool.attach_image_overlays()
		await await_overlay(carrier)

		apply_display(carrier, false)

		assert.equal(
			carrier._uca_maps_overlay._image.style.display, 'none',
			'expected the overlay hidden too — hiding only the transparent carrier would leave the picture painted and unselectable'
		)

		apply_display(carrier, true)
		assert.notEqual(carrier._uca_maps_overlay._image.style.display, 'none', 'expected it shown again')
	})

	it('an image carrier\'s console shows v6\'s sections: image controls, downloads, properties, never the geometry ones', async function() {

		const carrier = add_image_carrier()
		tool.attach_console()
		tool.attach_image_overlays()
		await await_overlay(carrier)

		// the carrier is built by hand here, so it carries no popup — fire the
		// selection event the console actually listens to (object_console.js
		// hydrate's 'popupopen' handler reads popup._source and nothing else)
		select_carrier(carrier)

		const section = tool.panel_node.querySelector('.uca-maps-object-section')
		assert.isOk(section.querySelector('.uca-maps-image-view'), 'expected the "View image" link')
		assert.isOk(section.querySelector('.uca-maps-image-opacity'), 'expected the opacity control')
		assert.isOk(section.querySelector('.uca-maps-image-z-index'), 'expected the z-index control')

		// what v6 adds after them (special_tools.js:6526-6568 + info_console_load_properties)
		const order = ['.uca-maps-image-view', '.uca-maps-download-section', '.uca-maps-object-images', '.uca-maps-properties-editor']
			.map((selector) => {
				const node = section.querySelector(selector)
				assert.isOk(node, 'expected ' + selector + ' for an image carrier')
				return Array.from(section.children).indexOf(node)
			})
		assert.deepEqual(order, [...order].sort((a, b) => a - b), 'expected image controls, download, images, properties — in that order')
		assert.isOk(section.querySelector('.uca-maps-property-pdf-button'), 'expected the PDF export, which rides in the properties block')

		// and what v6 never shows for a picture
		for (const selector of ['.uca-maps-object-type', '.uca-maps-object-info', '.uca-maps-elevation-section', '.uca-maps-geoman',
			'.uca-maps-centroid', '.uca-maps-uncertainty', '.uca-maps-style-controls', '.uca-maps-hierarchy-controls']) {
			assert.isNotOk(section.querySelector(selector), 'expected NO ' + selector + ' for an image carrier')
		}
	})

	it('"Download image" is v6\'s form: GeoTIFF/png/jpg, seven qualities at 0.8, a name — right after the image controls', function() {

		const carrier = add_image_carrier()
		tool.attach_console()
		select_carrier(carrier)

		const section	= tool.panel_node.querySelector('.uca-maps-object-section')
		const download	= section.querySelector('.uca-maps-image-download-section')
		assert.isOk(download, 'expected the image download section')

		const format = download.querySelector('.uca-maps-image-download-format')
		assert.deepEqual(Array.from(format.options).map(o => o.value), ['geotiff', 'png', 'jpg'])
		assert.equal(format.value, 'geotiff', 'expected v6\'s first format selected')

		const quality = download.querySelector('.uca-maps-image-download-quality')
		assert.deepEqual(Array.from(quality.options).map(o => o.value), ['0.4', '0.6', '0.8', '0.9', '1', '1.5', '2'])
		assert.equal(quality.value, '0.8', 'expected v6\'s "medium" selected')

		assert.equal(download.querySelector('.uca-maps-image-download-name').value, 'image')

		const children = Array.from(section.children)
		assert.isBelow(children.indexOf(download), children.indexOf(section.querySelector('.uca-maps-download-section')),
			'expected the image download before the vector one, as v6')
	})

	it('"Download image" sends the CURRENT corners and v6\'s quality as a width — never the opacity', async function() {

		const carrier = add_image_carrier()
		const image = carrier.feature.properties.uca_maps.image
		image.opacity = 0.3
		tool.attach_console()
		select_carrier(carrier)

		// a handle drag that nobody saved yet: the download must follow it
		image.corners.top_right = [40.47, -3.63]

		let sent		= null
		let transport	= null
		const restore	= stub_image_download(async function(request, transport_options) {
			sent		= request
			transport	= transport_options
			return {ok: false, error: {code: 'request.invalid_options'}}
		})

		try {
			const download = tool.panel_node.querySelector('.uca-maps-image-download-section')
			download.querySelector('.uca-maps-image-download-quality').value = '2'
			download.querySelector('.uca-maps-image-download-format').value = 'jpg'
			download.querySelector('.uca-maps-image-download-button').click()
			await until(() => sent, 100)

			assert.equal(sent.action, 'image_download')
			assert.equal(sent.options.section_tipo, IMAGE_DESCRIPTOR.section_tipo)
			assert.equal(sent.options.section_id, IMAGE_DESCRIPTOR.section_id)
			assert.equal(sent.options.tipo, IMAGE_DESCRIPTOR.tipo)
			assert.equal(sent.options.file_path, IMAGE_DESCRIPTOR.file_path, 'expected the file the map shows named, for the server to match')
			assert.deepEqual(sent.options.corners.top_right, [40.47, -3.63], 'expected the live corners, not the uploaded ones')
			assert.equal(sent.options.format, 'jpg')
			assert.equal(sent.options.width, image_download_width(geolocation.map, image.corners, 2))
			assert.equal(sent.options.file_name, 'image')
			assert.notProperty(sent.options, 'opacity', 'expected opacity left out: it is how the map shows the picture')
			assert.equal(transport.timeout, IMAGE_DOWNLOAD_TIMEOUT_MS, 'expected its own timeout, past the default 5 s per attempt')
			assert.isAtLeast(IMAGE_DOWNLOAD_TIMEOUT_MS, 4 * 60 * 1000, 'expected room for its four GDAL runs of 60 s')
			assert.isTrue(transport.busy_notice, 'expected the slow-server cue kept, which a long timeout turns off by default')
		} finally {
			restore()
		}

		// the rest of the request is exactly what tool_request would send
		assert.deepEqual(Object.keys(transport).sort(), ['body', 'busy_notice', 'timeout'], 'expected nothing but the body and the two transport options')
		assert.deepEqual(transport.body, await tool_request_body('image_download', transport.body.options),
			'expected the body tool_request builds: dd_api, prevent_lock and the source included')
	})

	it('"Download image" saves what the server sends, under its name and type', async function() {

		const carrier = add_image_carrier()
		const restore = stub_image_download(async function() {
			return {ok: true, data: {content_base64: btoa('x'), mime: 'image/png', filename: 'plan.png'}}
		})
		try {
			const captured = await capture_download(() => tool.download_image(carrier, 'png', 0.8, 'plan'))
			assert.equal(captured.name, 'plan.png', 'expected the server\'s file name on the anchor')
			assert.equal(captured.blob && captured.blob.type, 'image/png', 'expected the server\'s mime on the blob')
		} finally {
			restore()
		}
	})

	it('"Download image" refused: its own line names what failed and why', async function() {

		const carrier = add_image_carrier()
		tool.attach_console()
		select_carrier(carrier)

		const gone		= 'The image shown on the map is no longer on the server.'
		const restore	= stub_image_download(async function() {
			return {ok: false, error: {is_api_error: true, code: 'media.file_not_found', message: gone, transport: false}}
		})
		try {
			const download	= tool.panel_node.querySelector('.uca-maps-image-download-section')
			const line		= download.querySelector('.uca-maps-download-message')
			assert.isTrue(line.hidden, 'expected no line before any attempt')

			download.querySelector('.uca-maps-image-download-button').click()
			await until(() => !line.hidden, 100)

			assert.isFalse(line.hidden, 'expected the refusal shown under the button')
			assert.equal(line.textContent, 'The image could not be downloaded.\n' + gone)
		} finally {
			restore()
		}
	})

	it('image_download_width is v6\'s quality over the fitted on-screen size, and never moves the map', function() {

		const map		= geolocation.map
		const corners	= image_descriptor().corners
		const center	= map.getCenter()
		const zoom		= map.getZoom()

		const one = image_download_width(map, corners, 1)
		assert.isAbove(one, 1)
		assert.closeTo(image_download_width(map, corners, 2), one * 2, 1, 'expected twice the pixels at "Excelente"')
		assert.closeTo(image_download_width(map, corners, 0.4), one * 0.4, 1)

		assert.deepEqual([map.getCenter(), map.getZoom()], [center, zoom], 'expected the map not moved by measuring')

		// fitted, not "as seen now": zooming the map changes nothing
		map.setZoom(zoom - 2, {animate: false})
		const zoomed = [map.getCenter(), map.getZoom()]
		assert.equal(image_download_width(map, corners, 1), one, 'expected the same width at any current zoom')
		assert.deepEqual([map.getCenter(), map.getZoom()], zoomed, 'expected the zoomed map not moved by measuring')
		map.setView(center, zoom, {animate: false})
	})

	it('"Download image" with an empty name is refused without asking the server', async function() {

		const carrier = add_image_carrier()
		let asked = false
		const restore	= stub_image_download(async function() { asked = true; return {ok: false} })
		const toasts	= []
		const token		= event_manager.subscribe('api_error', (error) => toasts.push(error))
		try {
			const result = await tool.download_image(carrier, 'png', 0.8, '   ')
			assert.equal(asked, false, 'expected no request for an empty name')
			assert.deepEqual(result, {ok: false, error: 'Please enter a name for the file'}, 'expected the reason for the section\'s line')
			assert.equal(toasts.length, 0, 'expected the line alone to say it, no page toast')
		} finally {
			restore()
			event_manager.unsubscribe(token)
		}
	})

	it('"View image" is left out, not pointed at the bare file, when the descriptor names no record', function() {

		tool.attach_console()

		for (const missing of ['section_id', 'section_tipo']) {
			const carrier = add_image_carrier()
			delete carrier.feature.properties.uca_maps.image[missing]
			select_carrier(carrier)

			assert.equal(tool.get_image_href(carrier), null, 'expected no target without ' + missing)
			assert.isNotOk(tool.panel_node.querySelector('.uca-maps-image-view'), 'expected no link without ' + missing)
			assert.isOk(tool.panel_node.querySelector('.uca-maps-image-z-index'), 'expected the rest of the image controls still there')
		}

		const zero = add_image_carrier()
		zero.feature.properties.uca_maps.image.section_id = 0
		assert.equal(tool.get_image_href(zero), null, 'expected no target for section_id 0')
	})

	it('"View image" opens the Images record the upload created, as v6, not the bare file', async function() {

		const carrier = add_image_carrier()
		tool.attach_console()
		select_carrier(carrier)

		const link = tool.panel_node.querySelector('.uca-maps-image-view')
		const url = new URL(link.href, window.location.href)
		assert.equal(url.pathname, new URL(DEDALO_CORE_URL + '/page/', window.location.href).pathname, 'expected the core page, not the media tree')
		assert.equal(url.searchParams.get('tipo'), IMAGE_DESCRIPTOR.section_tipo)
		assert.equal(url.searchParams.get('id'), String(IMAGE_DESCRIPTOR.section_id))
		assert.equal(url.searchParams.get('mode'), 'edit')
		assert.equal(url.searchParams.get('menu'), 'true', 'expected v6\'s menu=true')
		assert.equal(url.searchParams.get('session_save'), 'false', 'expected this window\'s navigation left alone')
		assert.equal(link.target, '_blank')
	})

	it('the z-index is v6\'s 0..1000 slider: showing the stored value, previewing on input, committing on release', async function() {

		const carrier = add_image_carrier()
		carrier.feature.properties.uca_maps.image.z_index = 640
		tool.attach_console()
		tool.attach_image_overlays()
		await await_overlay(carrier)
		select_carrier(carrier)

		const slider = tool.panel_node.querySelector('.uca-maps-image-z-index')
		assert.equal(slider.type, 'range', 'expected a slider, as v6, not a number box')
		assert.equal(slider.min, '0')
		assert.equal(slider.max, '1000')
		// above 100 on purpose: with `value` set before `max` it would read 100
		assert.equal(slider.value, '640', 'expected the stored z-index, not a clamped one')

		let commits = 0
		const original = geolocation.update_draw_data
		geolocation.update_draw_data = function() { commits++; return original.apply(this, arguments) }

		slider.value = '850'
		slider.dispatchEvent(new Event('input'))
		assert.equal(carrier.feature.properties.uca_maps.image.z_index, 850, 'expected the preview written while dragging')
		assert.equal(carrier._uca_maps_overlay.options.zIndex, 850, 'expected the live overlay restacked while dragging')
		assert.equal(commits, 0, 'expected NO commit mid-drag')

		slider.dispatchEvent(new Event('change'))
		assert.equal(commits, 1, 'expected exactly one commit on release')
	})

	it('a z-index outside 0..1000 is bounded where it is used, so the slider and the overlay agree', async function() {

		// the old number box could store anything; nothing validated it
		const carrier = add_image_carrier()
		carrier.feature.properties.uca_maps.image.z_index = 1500
		tool.attach_console()
		tool.attach_image_overlays()
		await await_overlay(carrier)
		select_carrier(carrier)

		const slider = tool.panel_node.querySelector('.uca-maps-image-z-index')
		assert.equal(slider.value, '1000', 'expected the slider at its top')
		assert.equal(carrier._uca_maps_overlay.options.zIndex, 1000, 'expected the overlay stacked where the slider says')
		assert.equal(carrier.feature.properties.uca_maps.image.z_index, 1500, 'expected NO silent rewrite just for showing it')

		tool.set_image_display(carrier, {z_index: -5}, false)
		assert.equal(carrier.feature.properties.uca_maps.image.z_index, 0, 'expected a write bounded too')
	})

	it('set_image_display writes the live overlay AND the descriptor that gets saved', async function() {

		const carrier = add_image_carrier()
		tool.attach_image_overlays()
		await await_overlay(carrier)

		tool.set_image_display(carrier, {opacity: 0.4, z_index: 300}, false)

		assert.equal(carrier.feature.properties.uca_maps.image.opacity, 0.4, 'expected the stored opacity updated')
		assert.equal(carrier.feature.properties.uca_maps.image.z_index, 300, 'expected the stored z-index updated')
		assert.equal(carrier._uca_maps_overlay.options.opacity, 0.4, 'expected the live overlay updated too')

		// out-of-range input is clamped, never stored raw
		tool.set_image_display(carrier, {opacity: 5}, false)
		assert.equal(carrier.feature.properties.uca_maps.image.opacity, 1, 'expected opacity clamped to 1')
	})

	it('a wholesale FeatureGroup reload does not stack a second copy of every image', async function() {

		// layers_loader() rebuilds a FeatureGroup from scratch on a layer
		// switch/reload and fires NO 'pm:remove' — the carriers are simply
		// replaced by new objects. An overlay is not a drawn object, so
		// nothing in the engine would take the old ones off the map.
		const stale = add_image_carrier()
		tool.attach_image_overlays()
		await await_overlay(stale)
		const stale_overlay = stale._uca_maps_overlay
		assert.equal(geolocation.map.hasLayer(stale_overlay), true, 'expected the first overlay on the map')

		// the reload: the old carrier is gone from the group, a new one takes
		// its place, and only the layer-data event announces it
		active_group().removeLayer(stale)
		const fresh = add_image_carrier()
		event_manager.publish('updated_layer_data_' + geolocation.id_base, {})

		await await_overlay(fresh)

		assert.isOk(fresh._uca_maps_overlay, 'expected the new carrier to get its overlay')
		assert.equal(geolocation.map.hasLayer(stale_overlay), false, 'expected the stale overlay swept off the map')
		assert.equal(tool._image_overlays.length, 1, 'expected exactly one tracked overlay, not two stacked')
	})

	// IMAGE EDIT MODE (image_edit.js) — the overlay's three control points as
	// draggable handles, on the same hand-built carriers.

	it('the console offers "Activar edición" and it reflects the stored state', async function() {

		const carrier = await add_image_carrier_with_overlay()
		tool.attach_console()
		select_carrier(carrier)

		const checkbox = tool.panel_node.querySelector('.uca-maps-object-section .uca-maps-image-edit')
		assert.isOk(checkbox, 'expected the "Activar edición" checkbox in the image branch')
		assert.equal(checkbox.checked, false, 'expected edit mode off for a descriptor that never stored it')

		tool.set_image_interactive(carrier, true)
		select_carrier(carrier)

		assert.equal(
			tool.panel_node.querySelector('.uca-maps-object-section .uca-maps-image-edit').checked, true,
			'expected the re-rendered checkbox to read the stored flag, not a cached one'
		)
	})

	it('set_image_interactive puts three draggable handles on the map and persists the flag', async function() {

		const carrier = await add_image_carrier_with_overlay()

		tool.set_image_interactive(carrier, true)

		assert.equal(carrier._uca_maps_handles.length, 3, 'expected one handle per stored control point')
		for (const handle of carrier._uca_maps_handles) {
			assert.equal(geolocation.map.hasLayer(handle), true, 'expected the handle actually on the map')
			assert.equal(handle.options.draggable, true, 'expected the handle draggable')
			// a handle is a control, not a drawn object: Geoman must not edit,
			// snap to, or — worst — collect it into the component's data
			assert.equal(handle.options.pmIgnore, true, 'expected Geoman to ignore the handle')
		}
		assert.equal(
			carrier.feature.properties.uca_maps.image.interactive, true,
			'expected the flag stored on the descriptor, which is what survives a save'
		)
	})

	it('dragging a handle moves the overlay, the stored corners and the carrier together', async function() {

		const carrier = await add_image_carrier_with_overlay()
		tool.set_image_interactive(carrier, true)

		const before = JSON.parse(JSON.stringify(carrier.feature.properties.uca_maps.image.corners))
		const handle = carrier._uca_maps_handles[1] // top_right
		handle.setLatLng(L.latLng(40.47, -3.60))
		handle.fire('drag')

		const after = carrier.feature.properties.uca_maps.image.corners
		assert.deepEqual(after.top_right, [40.47, -3.60], 'expected the dragged corner stored')
		assert.deepEqual(after.top_left, before.top_left, 'expected the other two corners untouched')
		assert.deepEqual(after.bottom_left, before.bottom_left, 'expected the other two corners untouched')

		// the overlay is what the user sees: the plugin keeps its corners in these three
		const overlay = carrier._uca_maps_overlay
		assert.closeTo(overlay._topRight.lat, 40.47, 1e-9, 'expected the image itself moved with the handle')
		assert.closeTo(overlay._topRight.lng, -3.60, 1e-9, 'expected the image itself moved with the handle')
		assert.deepEqual([overlay._topLeft.lat, overlay._topLeft.lng], before.top_left, 'expected the image\'s other corners untouched')
		assert.deepEqual([overlay._bottomLeft.lat, overlay._bottomLeft.lng], before.bottom_left, 'expected the image\'s other corners untouched')

		// the carrier is what can be clicked and deleted — an overlay that
		// moved away from it would be unselectable
		const bounds = carrier.getBounds()
		assert.closeTo(bounds.getNorth(), 40.47, 1e-9, 'expected the carrier outline to follow the handle')
		assert.closeTo(bounds.getEast(), -3.60, 1e-9, 'expected the carrier outline to follow the handle')
	})

	it('a drag marks the record dirty only when the gesture ends', async function() {

		const carrier = await add_image_carrier_with_overlay()
		tool.set_image_interactive(carrier, true)

		let commits = 0
		const original = geolocation.update_draw_data
		geolocation.update_draw_data = function() { commits++; return original.apply(this, arguments) }

		const handle = carrier._uca_maps_handles[0]
		handle.setLatLng(L.latLng(40.465, -3.665))
		handle.fire('drag')
		assert.equal(commits, 0, 'expected NO commit mid-drag — commit() re-renders the panel being dragged against')

		handle.fire('dragend')
		assert.equal(commits, 1, 'expected exactly one commit when the gesture ends')
	})

	it('switching edit mode off removes the handles', async function() {

		const carrier = await add_image_carrier_with_overlay()
		tool.set_image_interactive(carrier, true)
		const handles = carrier._uca_maps_handles.slice()

		tool.set_image_interactive(carrier, false)

		assert.isNotOk(carrier._uca_maps_handles, 'expected the handles untracked')
		for (const handle of handles) {
			assert.equal(geolocation.map.hasLayer(handle), false, 'expected the handle off the map')
		}
		assert.equal(carrier.feature.properties.uca_maps.image.interactive, false, 'expected the flag stored off')
	})

	it('an overlay rebuilt from saved data comes back with the handles the user left showing', async function() {

		const carrier = add_image_carrier()
		// exactly what a record saved with edit mode on hands back on load
		carrier.feature.properties.uca_maps.image.interactive = true

		tool.attach_image_overlays()
		await until(() => carrier._uca_maps_handles)

		assert.isOk(carrier._uca_maps_handles, 'expected the stored edit mode restored, not silently dropped')
		assert.equal(carrier._uca_maps_handles.length, 3)
	})

	it('hiding the object hides its handles, in both directions', async function() {

		const carrier = await add_image_carrier_with_overlay()
		tool.set_image_interactive(carrier, true)

		// hiding an object with edit mode ON must not leave three circles
		// floating over an invisible image — still draggable, still moving it
		apply_display(carrier, false)
		for (const handle of carrier._uca_maps_handles) {
			assert.equal(handle._icon.style.display, 'none', 'expected the handle hidden with its object')
		}

		apply_display(carrier, true)
		assert.notEqual(carrier._uca_maps_handles[0]._icon.style.display, 'none', 'expected it shown again')

		// and the other direction: turning edit mode ON for an already hidden
		// object must not paint the handles either
		tool.set_image_interactive(carrier, false)
		apply_display(carrier, false)
		tool.set_image_interactive(carrier, true)

		for (const handle of carrier._uca_maps_handles) {
			assert.equal(handle._icon.style.display, 'none', 'expected handles born hidden on a hidden object')
		}
	})

	it('teardown removes every overlay and handle the tool put on the map', async function() {

		const carrier = await add_image_carrier_with_overlay()
		tool.set_image_interactive(carrier, true)
		const overlay = carrier._uca_maps_overlay
		const handles = carrier._uca_maps_handles.slice()

		await tool.destroy(false, false, false)

		assert.equal(geolocation.map.hasLayer(overlay), false, 'expected the overlay removed on teardown')
		for (const handle of handles) {
			assert.equal(
				geolocation.map.hasLayer(handle), false,
				'expected the handle removed on teardown — nothing else in the engine tracks it'
			)
		}
	})

	it('deleting the carrier takes its overlay and its handles off the map with it', async function() {

		const carrier = await add_image_carrier_with_overlay()
		tool.set_image_interactive(carrier, true)
		const overlay = carrier._uca_maps_overlay
		const handles = carrier._uca_maps_handles.slice()

		geolocation.map.fire('pm:remove', {layer: carrier})

		assert.equal(geolocation.map.hasLayer(overlay), false, 'expected the orphaned image removed from the map')
		assert.equal(tool._image_overlays.length, 0, 'expected the overlay untracked')
		for (const handle of handles) {
			assert.equal(geolocation.map.hasLayer(handle), false, 'expected the handle removed with its object')
		}
	})


	/**
	* PLACE SEARCH, GEOLOCATION AND SCALE BAR — the three always-present
	* controls. The place search never reaches Nominatim: tool_request is
	* stubbed with a hand-written envelope.
	*/

	it('attach_place_search adds exactly one button and one hidden panel, idempotently', function() {

		tool.attach_place_search()
		tool.attach_place_search() // second call: a no-op, never a duplicate

		const map_container_node = geolocation.map.getContainer()
		const controls = map_container_node.querySelectorAll('.uca-maps-place-search-control')
		assert.equal(controls.length, 1, 'expected exactly one button')
		assert.isOk(tool.place_search_panel, 'expected the panel built')
		assert.equal(tool.place_search_panel.hidden, true, 'expected the panel hidden by default')
	})

	it('search_places refuses an empty query without asking the server', async function() {

		tool.attach_place_search()

		let asked = false
		stub_tool_request(async function() { asked = true; return {} })

		const result = await search_places(tool, '   ')

		assert.equal(result.ok, false, 'expected a caller-fault verdict')
		assert.isOk(result.error, 'expected a message to show in the panel')
		assert.equal(asked, false, 'expected NO request for an empty query')
	})

	it('search_places asks in the record\'s language, and each hit is a row that moves the map when clicked', async function() {

		tool.attach_place_search()
		// hits are named in the record's language; set one only forwarding can match
		geolocation.section_lang = 'lg-cat'

		const sent = []
		stub_tool_request(async function(options) {
			sent.push(options)
			return { ok: true, data: { results: [
				{ name: 'Sagunt', point: [39.68, -0.27], bbox: [39.6, -0.35, 39.75, -0.2] },
				{ name: 'Sagunto, Spain', point: [39.67, -0.28], bbox: null }
			] } }
		})

		const result = await search_places(tool, ' Sagunto ')
		assert.equal(result.ok, true)
		assert.equal(result.results.length, 2)
		assert.equal(sent.length, 1)
		assert.equal(sent[0].action, 'search_places')
		assert.equal(sent[0].options.query, 'Sagunto', 'expected the query trimmed')
		assert.equal(sent[0].options.lang, 'lg-cat', 'expected the record\'s language forwarded')

		// the panel's own render path (render_place_search.js), reached the
		// way the Search button reaches it
		populate_place_search_results(tool, tool.place_search_panel)
		const rows = tool.place_search_panel.querySelectorAll('.uca-maps-place-search-result-button')
		assert.equal(rows.length, 2, 'expected one row per hit')
		assert.equal(rows[0].textContent, 'Sagunt')

		// the second hit has no box: the click lands on its point exactly
		rows[1].click()
		const center = geolocation.map.getCenter()
		assert.closeTo(center.lat, 39.67, 1e-6, 'expected the click to centre the map on its own hit')
		assert.closeTo(center.lng, -0.28, 1e-6, 'expected the click to centre the map on its own hit')
	})

	it('search_places toasts a request that throws, but not once the tool is torn down mid-flight', async function() {

		tool.attach_place_search()

		const toasts	= []
		const token		= event_manager.subscribe('api_error', (error) => toasts.push(error))
		let fail = null
		stub_tool_request(() => new Promise((resolve, reject) => { fail = reject }))
		try {
			// control: alive, the exception reaches the page toast
			const alive = search_places(tool, 'Sagunto')
			fail(new Error('Boom.'))
			assert.equal((await alive).ok, false)
			assert.equal(toasts.length, 1, 'expected the live failure toasted')
			assert.equal(toasts[0].code, 'client.tool_uca_maps_failed')

			const pending = search_places(tool, 'Sagunto')
			await tool.destroy(false, false, false)
			assert.equal(tool.place_search_panel, null, 'expected the panel already torn down')
			fail(new Error('Boom.'))

			assert.equal((await pending).ok, false)
			assert.equal(toasts.length, 1, 'expected NO toast for a search the closed tool left in flight')
		} finally {
			event_manager.unsubscribe(token)
		}
	})

	it('focus_place_result fits the bounding box, and falls back to a point zoom without one', async function() {

		tool.attach_place_search()
		// a box degrees wide: a point zoom around its centre could not show both corners
		const bbox = [35.0, -6.0, 43.0, 3.0]
		tool._place_results = [
			{ name: 'with bbox', point: [39.0, -1.5], bbox: bbox },
			{ name: 'no bbox', point: [40.0, -1.0], bbox: null }
		]

		const map		= geolocation.map
		const box		= L.latLngBounds([bbox[0], bbox[1]], [bbox[2], bbox[3]])
		const box_zoom	= map.getBoundsZoom(box)
		assert.isBelow(box_zoom, map.getMaxZoom(), 'expected a box that needs a wider view than the point zoom')

		assert.equal(focus_place_result(tool, 0), true)
		assert.equal(map.getZoom(), box_zoom, 'expected the zoom that fits the box, not the point zoom')
		assert.isTrue(map.getBounds().contains(box.getSouthWest()), 'expected the box\'s south-west corner in view')
		assert.isTrue(map.getBounds().contains(box.getNorthEast()), 'expected the box\'s north-east corner in view')

		assert.equal(focus_place_result(tool, 1), true)
		const center = geolocation.map.getCenter()
		assert.closeTo(center.lat, 40.0, 1e-6, 'expected the map centred on the point')
		assert.closeTo(center.lng, -1.0, 1e-6, 'expected the map centred on the point')

		assert.equal(focus_place_result(tool, 99), false, 'expected an out-of-range index to move nothing')
	})

	it('Search reopens from zero: field, hits and message, also when a SIBLING closed it', async function() {

		tool.attach_place_search()
		tool.attach_map_image_download_control()

		const panel		= tool.place_search_panel
		const toggle	= () => tool.place_search_control.getContainer().click()
		const input		= panel.querySelector('.uca-maps-place-search-input')
		const message	= panel.querySelector('.uca-maps-place-search-message')
		const rows		= () => panel.querySelectorAll('.uca-maps-place-search-result-button').length

		stub_tool_request(async function() {
			return { ok: true, data: { results: [{ name: 'Sagunt', point: [39.68, -0.27], bbox: null }] } }
		})

		const search = async (text) => {
			input.value = text
			panel.querySelector('.uca-maps-place-search-button').click()
			await tick()
		}

		toggle()
		await search('Sagunto')
		assert.equal(rows(), 1, 'expected the hit listed')
		toggle()
		toggle()
		assert.equal(input.value, '', 'expected the field emptied on reopen')
		assert.equal(rows(), 0, 'expected no hits on reopen')
		assert.equal(tool._place_results, null, 'expected the stored hits dropped')

		await search('   ')
		assert.equal(message.hidden, false, 'expected the empty-query message shown')
		// closed by toolbar.js close_other_toolbar_panels, never by Search's own toggle
		tool.map_image_control.getContainer().click()
		assert.equal(panel.hidden, true, 'expected Search closed by the sibling')
		toggle()
		assert.equal(message.hidden, true, 'expected no message on reopen')
	})

	it('reopening Search mid-search keeps its query, and the answer still lands', async function() {

		tool.attach_place_search()

		const panel		= tool.place_search_panel
		const toggle	= () => tool.place_search_control.getContainer().click()
		const input		= panel.querySelector('.uca-maps-place-search-input')
		const button	= panel.querySelector('.uca-maps-place-search-button')

		let settle = null
		stub_tool_request(function() {
			return new Promise((resolve) => { settle = resolve })
		})

		toggle()
		input.value = 'Sagunto'
		button.click()
		await tick()
		assert.isOk(settle, 'expected the search in flight')

		toggle()
		toggle()
		assert.equal(input.value, 'Sagunto', 'expected the query kept while the search runs')

		settle({ ok: true, data: { results: [{ name: 'Sagunt', point: [39.68, -0.27], bbox: null }] } })
		await tick()
		assert.equal(panel.querySelectorAll('.uca-maps-place-search-result-button').length, 1, 'expected the late hit listed')
		assert.equal(button.disabled, false)
	})

	it('a search in flight refuses Enter and locks Clear until it answers', async function() {

		tool.attach_place_search()

		const panel		= tool.place_search_panel
		const input		= panel.querySelector('.uca-maps-place-search-input')
		const button	= panel.querySelector('.uca-maps-place-search-button')
		const clear		= panel.querySelector('.uca-maps-place-search-clear-button')
		const enter		= () => input.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', bubbles: true}))

		const pending = []
		stub_tool_request(function() {
			return new Promise((resolve) => { pending.push(resolve) })
		})

		tool.place_search_control.getContainer().click()
		input.value = 'Sagunto'
		enter()
		await tick()
		assert.equal(pending.length, 1, 'expected Enter to start the first search')
		assert.equal(button.disabled, true, 'expected Search locked while it runs')
		assert.equal(clear.disabled, true, 'expected Clear locked while it runs')

		enter()
		button.click()
		await tick()
		assert.equal(pending.length, 1, 'expected no second search while the first runs')

		pending[0]({ ok: true, data: { results: [{ name: 'Sagunt', point: [39.68, -0.27], bbox: null }] } })
		await tick()
		assert.equal(button.disabled, false, 'expected Search unlocked by the answer')
		assert.equal(clear.disabled, false, 'expected Clear unlocked by the answer')
		assert.equal(input.value, 'Sagunto', 'expected the query kept under its hits')

		enter()
		await tick()
		assert.equal(pending.length, 2, 'expected Enter to search again once unlocked')
		pending[1]({ ok: true, data: { results: [] } })
		await tick()
		// nothing found is a warning, not a failure
		const message = panel.querySelector('.uca-maps-place-search-message')
		assert.isFalse(message.hidden, 'expected an answer with no hits to say so')
		assert.equal(message.textContent, 'No places found.')
		assert.equal(message.dataset.type, 'warning')
	})

	it('a failed search shows its error in the panel and drops the previous hits from the list', async function() {

		tool.attach_place_search()

		const panel		= tool.place_search_panel
		const input		= panel.querySelector('.uca-maps-place-search-input')
		const message	= panel.querySelector('.uca-maps-place-search-message')
		const rows		= () => panel.querySelectorAll('.uca-maps-place-search-result-button').length
		const error		= {is_api_error: true, code: 'request.invalid_options', message: 'Nominatim is down', transport: false}

		let answer = { ok: true, data: { results: [{ name: 'Sagunt', point: [39.68, -0.27], bbox: null }] } }
		stub_tool_request(async () => answer)

		tool.place_search_control.getContainer().click()
		input.value = 'Sagunto'
		panel.querySelector('.uca-maps-place-search-button').click()
		await tick()
		assert.equal(rows(), 1, 'expected the first answer listed')

		answer = { ok: false, error: error }
		panel.querySelector('.uca-maps-place-search-button').click()
		await tick()

		assert.isFalse(message.hidden, 'expected the failure shown in the panel')
		assert.equal(message.textContent, tool_error_text(error, 'The place search could not be completed.'))
		assert.equal(message.dataset.type, 'error')
		assert.equal(rows(), 0, 'expected no stale hits under the error')
	})

	it('detach_place_search removes the button and panel', async function() {

		tool.attach_place_search()
		const map_container_node	= geolocation.map.getContainer()
		const panel					= tool.place_search_panel
		assert.isTrue(panel.isConnected, 'expected the panel in the page before teardown')

		await tool.destroy(false, false, false)

		assert.isFalse(panel.isConnected, 'expected the panel taken out of the map, not just forgotten')
		assert.equal(tool.place_search_control, null, 'expected place_search_control cleared')
		assert.equal(tool.place_search_panel, null, 'expected place_search_panel cleared')
		assert.isNotOk(
			map_container_node.querySelector('.uca-maps-place-search-control'),
			'expected the button removed from the DOM'
		)
	})

	it('attach_geolocate adds exactly one button and no panel, idempotently', function() {

		const map_container_node	= geolocation.map.getContainer()
		const panels				= () => map_container_node.querySelectorAll('.uca-maps-panel').length
		const panels_before			= panels()

		tool.attach_geolocate()
		tool.attach_geolocate()

		assert.equal(map_container_node.querySelectorAll('.uca-maps-geolocate-control').length, 1)
		assert.equal(panels(), panels_before, 'expected no panel added')
		assert.equal(is_geolocate_enabled(tool), false, 'expected it to start disarmed')
	})

	it('toggling geolocation arms it, and toggling again cancels the lookup', function() {

		tool.attach_geolocate()

		// the map is rebuilt for every test, so these stubs need no restore
		let located = 0
		let stopped = 0
		geolocation.map.locate		= function() { located++; return this }
		geolocation.map.stopLocate	= function() { stopped++; return this }

		toggle_geolocate(tool)
		assert.equal(is_geolocate_enabled(tool), true, 'expected the button armed')
		assert.equal(located, 1, 'expected the browser lookup started')

		toggle_geolocate(tool)
		assert.equal(is_geolocate_enabled(tool), false, 'expected the button disarmed')
		assert.equal(stopped, 1, 'expected an in-flight lookup cancelled, not left running')
	})

	it('a position fix drops ONE marker in the active layer and marks the record dirty — never saves', function() {

		tool.attach_geolocate()

		// the core's own 'pm:create' handler already marks the record dirty;
		// the tool's commit() after it only repeats that. What matters is that
		// nothing here reaches the save door: the user's Save stays the only writer
		// the component is rebuilt for every test, so these stubs need no restore
		let commits = 0
		let saves = 0
		const original_update	= geolocation.update_draw_data
		geolocation.update_draw_data	= function() { commits++; return original_update.apply(this, arguments) }
		geolocation.save				= function() { saves++ }

		const before = active_group().getLayers().length

		const marker = create_position_marker(tool, L.latLng(40.44, -3.70))

		assert.isOk(marker, 'expected a marker created')
		const after = active_group().getLayers().length
		assert.equal(after, before + 1, 'expected exactly one new object in the active layer')
		assert.isAbove(commits, 0, 'expected the record marked dirty')
		assert.equal(saves, 0, 'expected NO save — nothing here writes')
	})

	it('a position fix with no FeatureGroup to land in says so and draws nothing', function() {

		tool.attach_geolocate()

		// the core's 'pm:create' handler would throw adding to a group that does not exist
		geolocation.active_layer_id = 99
		assert.isNotOk(geolocation.FeatureGroup[99], 'expected no group for the active layer')

		const toasts	= []
		const created	= []
		const token		= event_manager.subscribe('api_error', (error) => toasts.push(error))
		geolocation.map.on('pm:create', (event) => created.push(event.layer))
		try {
			const marker = create_position_marker(tool, L.latLng(40.44, -3.70))
			assert.isNull(marker, 'expected no marker')
			assert.equal(created.length, 0, 'expected nothing handed to the draw pipeline')
			assert.equal(toasts.length, 1, 'expected the user told why nothing was drawn')
			assert.equal(toasts[0].message, 'Select a map layer before using geolocation.')
		} finally {
			event_manager.unsubscribe(token)
		}
	})

	it('a second locationfound while disarmed drops nothing — v6 re-binds a listener per click and drops N markers', function() {

		tool.attach_geolocate()

		const group		= active_group()
		const before	= group.getLayers().length

		// armed: one fix, one marker, and the control disarms itself
		toggle_geolocate(tool)
		geolocation.map.fire('locationfound', {latlng: L.latLng(40.44, -3.70)})
		assert.equal(group.getLayers().length, before + 1)
		assert.equal(is_geolocate_enabled(tool), false, 'expected one fix per click')

		// disarmed: the listener is still bound (bound once at attach), and
		// must ignore anything the map reports
		geolocation.map.fire('locationfound', {latlng: L.latLng(40.45, -3.71)})
		assert.equal(group.getLayers().length, before + 1, 'expected no marker while disarmed')
	})

	it('detach_geolocate removes the button and its listeners', async function() {

		tool.attach_geolocate()
		const map					= geolocation.map
		const map_container_node	= map.getContainer()
		const found_handler			= tool._geolocate_found_handler
		const error_handler			= tool._geolocate_error_handler
		assert.isTrue(map.listens('locationfound', found_handler), 'expected the fix listener bound at attach')
		assert.isTrue(map.listens('locationerror', error_handler), 'expected the error listener bound at attach')

		await tool.destroy(false, false, false)

		assert.equal(tool.geolocate_control, null, 'expected geolocate_control cleared')
		assert.isNotOk(map_container_node.querySelector('.uca-maps-geolocate-control'))
		// a disarmed handler ignores a fix anyway, so only the map's own list tells
		// a removed listener from one left behind on the core's map
		assert.isFalse(map.listens('locationfound', found_handler), 'expected the fix listener off the map')
		assert.isFalse(map.listens('locationerror', error_handler), 'expected the error listener off the map')
	})

	it('attach_scale_bar adds exactly one graphic scale WITH its compass rose, idempotently', async function() {

		tool.attach_scale_bar()
		tool.attach_scale_bar()

		const map_container_node = geolocation.map.getContainer()
		const scales = map_container_node.querySelectorAll('.uca-maps-scale')
		assert.equal(scales.length, 1, 'expected exactly one scale bar')

		// the compass is half of what v6 draws here: its hand-patched copy of
		// leaflet-graphicscale builds one
		assert.isOk(scales[0].querySelector('.uca-maps-scale-compass'), 'expected the compass rose')

		// map furniture, not tool chrome: the exported map image keeps it
		assert.isFalse(is_toolbar_node(tool, scales[0]), 'expected the scale NOT registered as chrome')

		// two offset rows of divisions: the "double line" checker bar, not a
		// single stroke
		const rows = scales[0].querySelectorAll('.uca-maps-scale-row')
		assert.equal(rows.length, 2, 'expected a double-line bar')
		assert.isAbove(rows[0].children.length, 1, 'expected the bar split into divisions')
		assert.equal(
			rows[0].children.length, rows[1].children.length,
			'expected both rows split the same way'
		)
		assert.notEqual(
			rows[0].children[0].classList.contains('filled'),
			rows[1].children[0].classList.contains('filled'),
			'expected the second row offset by one division — that is what makes the checker'
		)

		// one stroke between the rows, not the first row's bottom plus the
		// second's top; and the same fill height in both rows
		await with_tool_css(() => {
			const top_division		= rows[0].children[0]
			const bottom_division	= rows[1].children[0]
			assert.equal(getComputedStyle(top_division).borderBottomWidth, '1px', 'expected the shared stroke on the first row')
			assert.equal(getComputedStyle(bottom_division).borderTopWidth, '0px', 'expected no second stroke on top of the second row')
			assert.isAbove(top_division.clientHeight, 0, 'expected the bar laid out')
			assert.equal(bottom_division.clientHeight, top_division.clientHeight, 'expected both rows to fill the same height')
		})

		assert.isOk(
			scales[0].querySelector('.uca-maps-scale-labels').textContent.trim(),
			'expected the bar labelled with a distance'
		)
	})

	it('the scale redraws on every map move — a bar frozen at the old view lies about the map', function() {

		tool.attach_scale_bar()

		const labels_node = geolocation.map.getContainer().querySelector('.uca-maps-scale-labels')
		const drawn = labels_node.textContent
		assert.isOk(drawn, 'expected the bar drawn on attach')

		// NOT driven by a zoom change: this suite's map takes its zoom bounds
		// from its own base layer (maxZoom 11), so setView() cannot move it far
		// enough to change the rounded distance. What matters is the listener
		// itself — wipe what is drawn and prove a map move puts it back.
		labels_node.replaceChildren()
		assert.equal(labels_node.textContent, '', 'expected the wipe to take')

		geolocation.map.fire('move')

		assert.equal(labels_node.textContent, drawn, 'expected the bar redrawn by the map move')
	})

	it('detach removes the scale bar', async function() {

		tool.attach_scale_bar()
		const map					= geolocation.map
		const map_container_node	= map.getContainer()
		const control				= tool.scale_control
		assert.isOk(map_container_node.querySelector('.uca-maps-scale'), 'expected the scale bar drawn before teardown')

		await tool.destroy(false, false, false)

		assert.equal(tool.scale_control, null, 'expected scale_control cleared')
		assert.isNotOk(
			map_container_node.querySelector('.uca-maps-scale'),
			'expected the scale bar removed on teardown'
		)
		assert.isFalse(map.listens('move', control._redraw, control), 'expected the move listener off the map')
		// a redraw left bound would read the removed control's null _map and throw
		map.fire('move')
	})

	it('a scale attached before its map loads leaves no load hook behind once detached', function() {

		// the suite's map is already loaded, so whenReady runs at once there:
		// only a map with no view yet makes it queue a 'load' listener
		const container = document.createElement('div')
		container.style.cssText = 'width:300px;height:200px'
		document.body.appendChild(container)
		const map	= L.map(container)
		const owner	= {geolocation: {map}}
		try {
			attach_scale_bar(owner)
			const control = owner.scale_control
			assert.isTrue(map.listens('load', control._redraw, control), 'expected the redraw queued for load')

			detach_scale_bar(owner)
			assert.isFalse(map.listens('load', control._redraw, control), 'expected the load hook removed with the control')
			// loading now must not reach the removed control (its _map is null)
			map.setView([39.47, -0.38], 10)
		} finally {
			map.remove()
			container.remove()
		}
	})

	it('attach_legend adds the button, the panel and the overlay, idempotently', function() {

		tool.attach_legend()
		tool.attach_legend()

		const map_container_node = geolocation.map.getContainer()
		assert.equal(
			map_container_node.querySelectorAll('.uca-maps-legend-control').length, 1,
			'expected exactly one Legend button'
		)
		assert.equal(
			map_container_node.querySelectorAll('.uca-maps-legend-panel').length, 1,
			'expected exactly one Legend panel'
		)
		assert.equal(
			map_container_node.querySelectorAll('.uca-maps-legend-overlay').length, 1,
			'expected exactly one legend overlay'
		)
		assert.deepEqual(tool.legend, empty_legend(), 'expected the session legend seeded empty')
	})

	// one default blue on the map: a new pin and a new symbol wear the colour
	// Leaflet gives a new object (v6's editor used that blue too)
	it('a new pin and a new symbol start in the blue of a new map object', function() {

		const new_object_blue = L.polygon([[39.4, -0.4], [39.5, -0.4], [39.5, -0.3]]).options.color
		tool.attach_legend()
		tool.legend_control.getContainer().click()
		const panel = tool.legend_panel
		panel.querySelector('.uca-maps-legend-add-column').click()
		panel.querySelector('.uca-maps-legend-add-element').click()

		const icon = tool.legend.columns[0].elements[0].icon
		assert.equal(decode_symbol(icon).querySelector('path').getAttribute('fill'), new_object_blue, 'expected the pin in the map\'s blue')

		// the editor as opened, not the helper: what seeds its colour inputs
		panel.querySelector('.uca-maps-legend-symbol-button').click()
		const editor = panel.querySelector('.uca-maps-legend-symbol-editor')
		assert.isFalse(editor.hidden, 'expected the editor open')
		assert.equal(editor.querySelector('.uca-maps-legend-symbol-fill').value, new_object_blue, 'expected the editor\'s fill to start in the map\'s blue')
		assert.equal(editor.querySelector('.uca-maps-legend-symbol-stroke').value, new_object_blue, 'expected the editor\'s border to start in the map\'s blue')
	})

	it('the legend overlay is map CONTENT, not tool chrome — so it stays in the exported image', function() {

		tool.attach_legend()

		// the screenshot skips every node registered through toolbar.js. The
		// panel and its button are chrome; the legend is what a user exports a
		// map WITH, so it must not be registered
		assert.isTrue(is_toolbar_node(tool, tool.legend_panel), 'expected the panel registered as chrome')
		assert.isTrue(
			is_toolbar_node(tool, tool.legend_control.getContainer()),
			'expected the button registered as chrome'
		)
		assert.isFalse(
			is_toolbar_node(tool, tool.legend_overlay.getContainer()),
			'expected the overlay NOT registered — it must survive the screenshot filter'
		)
	})

	it('the overlay draws only what there is to draw, and the checkbox hides it', function() {

		tool.attach_legend()
		const overlay = tool.legend_overlay.getContainer()

		// empty legend: nothing on the map. v6 leaves an empty box floating
		// there, which is noise, not information
		assert.isTrue(overlay.hidden, 'expected no overlay while the legend is empty')

		// 'topleft' is this tool's button column, 'topright' Geoman's draw bar,
		// 'bottomright' the scale bar: the one free corner is bottomleft
		assert.isOk(
			overlay.closest('.leaflet-bottom.leaflet-left'),
			'expected the overlay in Leaflet\'s bottomleft corner'
		)

		// a column just created — no name, no elements — draws nothing, so the
		// overlay stays away: "empty" is measured in what would be DRAWN
		tool.add_legend_column()
		assert.isTrue(overlay.hidden, 'expected no overlay for a column with nothing in it')

		// a legend with columns but NO title is still a legend — the hidden
		// branch is "nothing at all", not "no title"
		tool.set_legend_column_name(0, 'Periodo')
		assert.isFalse(overlay.hidden, 'expected the overlay with columns but no title')
		tool.delete_legend_column(0)
		assert.isTrue(overlay.hidden, 'expected it hidden again once emptied')

		tool.set_legend_title('Simbología')
		assert.isFalse(overlay.hidden, 'expected the overlay once it has a title')
		assert.equal(overlay.querySelector('.uca-maps-legend-overlay-title').textContent, 'Simbología')

		tool.add_legend_column()
		tool.set_legend_column_name(0, 'Periodo')
		tool.add_legend_element(0)
		tool.set_legend_element_name(0, 0, 'Neolítico')

		assert.equal(overlay.querySelectorAll('.uca-maps-legend-overlay-column').length, 1)
		assert.equal(overlay.querySelector('.uca-maps-legend-overlay-column-name').textContent, 'Periodo')
		const element_node = overlay.querySelector('.uca-maps-legend-overlay-element')
		assert.equal(element_node.querySelector('span').textContent, 'Neolítico')
		assert.equal(element_node.querySelector('img').getAttribute('src'), default_element_icon())

		// "Mostrar leyenda" off hides the drawing, it does not wipe the data
		tool.set_legend_visible(false)
		assert.isTrue(overlay.hidden, 'expected the overlay hidden')
		assert.equal(tool.legend.columns.length, 1, 'expected the columns kept')

		tool.set_legend_visible(true)
		assert.isFalse(overlay.hidden, 'expected the overlay back')
	})

	it('every legend text is stripped of tags, and a bad index changes nothing', function() {

		tool.attach_legend()

		tool.set_legend_title('<b>Leyenda</b>')
		tool.add_legend_column()
		tool.set_legend_column_name(0, '<i>Periodo</i>')
		tool.add_legend_element(0)
		tool.set_legend_element_name(0, 0, '<script>x</script>Neolítico')

		assert.equal(tool.legend.legend, 'Leyenda')
		assert.equal(tool.legend.columns[0].name, 'Periodo')
		assert.equal(tool.legend.columns[0].elements[0].name, 'xNeolítico')

		assert.deepEqual(tool.delete_legend_column(7), {ok: false})
		assert.deepEqual(tool.delete_legend_element(0, 7), {ok: false})
		assert.deepEqual(tool.set_legend_column_name(7, 'x'), {ok: false})
		assert.deepEqual(tool.add_legend_element(7), {ok: false})
		assert.equal(tool.legend.columns.length, 1, 'expected the legend untouched')

		assert.deepEqual(tool.delete_legend_element(0, 0), {ok: true})
		assert.equal(tool.legend.columns[0].elements.length, 0)
		assert.deepEqual(tool.delete_legend_column(0), {ok: true})
		assert.equal(tool.legend.columns.length, 0)
	})

	it('an icon must be an allowed type under 2 MB; a good one lands as a data URL of its exact bytes', async function() {

		tool.attach_legend()
		tool.add_legend_column()
		tool.add_legend_element(0)

		const rejected_type = await tool.set_legend_element_icon(
			0, 0, new File([new Uint8Array([1, 2, 3])], 'note.txt', {type: 'text/plain'})
		)
		assert.isFalse(rejected_type.ok, 'expected a non-image refused')
		assert.isOk(rejected_type.error, 'expected the refusal to say why')

		// checked BEFORE reading the file — the point is not loading 30 MB into
		// memory only to throw it away afterwards
		const rejected_size = await tool.set_legend_element_icon(
			0, 0, new File([new Uint8Array(MAX_ICON_BYTES + 1)], 'big.png', {type: 'image/png'})
		)
		assert.isFalse(rejected_size.ok, 'expected an oversized icon refused')
		assert.isOk(rejected_size.error, 'expected the refusal to say why')
		assert.equal(
			tool.legend.columns[0].elements[0].icon, default_element_icon(),
			'expected a refused icon to leave the pin in place'
		)

		// the ceiling is v6's, inclusive: a file AT 2 MB is accepted — without
		// this case a `>` turned into a `>=` reads as green. Varied bytes, so a
		// base64 chunk that drops or repeats bytes cannot pass for the file
		const ceiling_bytes = Uint8Array.from({length: MAX_ICON_BYTES}, (_value, index) => (index * 7 + (index >> 15)) & 255)
		const at_the_ceiling = await tool.set_legend_element_icon(
			0, 0, new File([ceiling_bytes], 'exact.png', {type: 'image/png'})
		)
		assert.isTrue(at_the_ceiling.ok, 'expected a file exactly at the 2 MB ceiling accepted')
		const stored_prefix = 'data:image/png;base64,'
		const stored_icon = tool.legend.columns[0].elements[0].icon
		assert.isTrue(stored_icon.startsWith(stored_prefix), 'expected the icon stored as a PNG data URL')
		const decoded = atob(stored_icon.slice(stored_prefix.length))
		assert.equal(decoded.length, MAX_ICON_BYTES, 'expected every byte of the file in the data URL')
		let first_mismatch = -1
		for (let index=0; index<decoded.length && first_mismatch===-1; index++) {
			if (decoded.charCodeAt(index)!==ceiling_bytes[index]) first_mismatch = index
		}
		assert.equal(first_mismatch, -1, 'expected the data URL to carry the file byte for byte')
		// back to the pin, so the last case has to land its own icon
		tool.legend.columns[0].elements[0].icon = default_element_icon()

		const accepted = await tool.set_legend_element_icon(
			0, 0, pin_png()
		)
		assert.isTrue(accepted.ok, 'expected a small PNG accepted')
		assert.isTrue(
			tool.legend.columns[0].elements[0].icon.startsWith('data:image/png;base64,'),
			'expected the icon stored as a data URL, never uploaded'
		)
	})

	it('type and size are checked BEFORE the file is read, not after', async function() {

		tool.attach_legend()
		tool.add_legend_column()
		tool.add_legend_element(0)

		// NOT a Blob: file.arrayBuffer() would THROW on it. So this only
		// returns a refusal if both checks happen before the read — a refactor
		// that reads first (loading a 30 MB file into memory just to throw it
		// away) turns this red instead of staying quietly green
		const not_readable = {type: 'application/pdf', size: 10, name: 'plan.pdf'}
		const by_type = await tool.set_legend_element_icon(0, 0, not_readable)
		assert.isFalse(by_type.ok, 'expected the type refused without reading')

		const oversized = {type: 'image/png', size: MAX_ICON_BYTES + 1, name: 'big.png'}
		const by_size = await tool.set_legend_element_icon(0, 0, oversized)
		assert.isFalse(by_size.ok, 'expected the size refused without reading')

		assert.equal(tool.legend.columns[0].elements[0].icon, default_element_icon())
	})

	it('the panel edits the same legend the overlay draws', function() {

		tool.attach_legend()

		// open it the way a user does — populate_legend_columns only runs on show
		tool.legend_control.getContainer().click()

		const panel		= tool.legend_panel
		const overlay	= tool.legend_overlay.getContainer()
		assert.isFalse(panel.hidden, 'expected the panel open')
		assert.isOk(panel.querySelector('.uca-maps-legend-empty'), 'expected the empty-state line')

		const title_input = panel.querySelector('.uca-maps-legend-title-input')
		title_input.value = 'Simbología'
		title_input.dispatchEvent(new Event('input'))
		assert.equal(tool.legend.legend, 'Simbología', 'expected typing to reach the legend')
		assert.isFalse(overlay.hidden, 'expected the overlay drawn once the panel gives it a title')
		assert.equal(overlay.querySelector('.uca-maps-legend-overlay-title').textContent, 'Simbología', 'expected the overlay to draw the typed title')

		panel.querySelector('.uca-maps-legend-add-column').click()
		assert.equal(panel.querySelectorAll('.uca-maps-legend-column').length, 1)
		assert.isNotOk(panel.querySelector('.uca-maps-legend-empty'), 'expected the empty-state line gone')

		panel.querySelector('.uca-maps-legend-add-element').click()
		assert.equal(panel.querySelectorAll('.uca-maps-legend-element').length, 1)
		assert.equal(overlay.querySelectorAll('.uca-maps-legend-overlay-element').length, 1, 'expected the overlay to draw the added element')

		const show_checkbox = panel.querySelector('.uca-maps-legend-show')
		assert.isTrue(show_checkbox.checked, 'expected the legend shown by default, as in v6')
		show_checkbox.checked = false
		show_checkbox.dispatchEvent(new Event('change'))
		assert.isFalse(tool.legend.enable, 'expected the checkbox to reach the legend')
		assert.isTrue(overlay.hidden, 'expected the checkbox to hide the overlay')

		panel.querySelector('.uca-maps-legend-delete-element').click()
		assert.equal(panel.querySelectorAll('.uca-maps-legend-element').length, 0)
		panel.querySelector('.uca-maps-legend-delete-column').click()
		assert.equal(panel.querySelectorAll('.uca-maps-legend-column').length, 0)
	})

	it('the column and element name inputs write to THEIR OWN slot', function() {

		tool.attach_legend()
		tool.legend_control.getContainer().click()

		const panel = tool.legend_panel
		panel.querySelector('.uca-maps-legend-add-column').click()
		panel.querySelector('.uca-maps-legend-add-element').click()

		// driven through the DOM on purpose: calling the prototype mutators
		// directly (as the strip_tags/index gate above does) cannot catch a
		// listener wired to the wrong slot, or to the wrong mutator entirely
		const column_input = panel.querySelector('.uca-maps-legend-column-name')
		column_input.value = 'Periodo'
		column_input.dispatchEvent(new Event('input'))

		const element_input = panel.querySelector('.uca-maps-legend-element-name')
		element_input.value = 'Neolítico'
		element_input.dispatchEvent(new Event('input'))

		assert.equal(tool.legend.columns[0].name, 'Periodo', 'expected the column name in the column')
		assert.equal(tool.legend.columns[0].elements[0].name, 'Neolítico', 'expected the element name in the element')
		assert.equal(tool.legend.legend, '', 'expected the legend title untouched by either input')

		// the row carries its pin and its upload button
		const row = panel.querySelector('.uca-maps-legend-element')
		assert.equal(row.querySelector('img').getAttribute('src'), default_element_icon())
		assert.isOk(row.querySelector('.uca-maps-legend-upload-icon'), 'expected the icon button')
	})

	it('the icon picker reports a refused or unreadable file in the panel, and an accepted one repaints the row', async function() {

		tool.attach_legend()
		tool.legend_control.getContainer().click()

		const panel = tool.legend_panel
		panel.querySelector('.uca-maps-legend-add-column').click()
		panel.querySelector('.uca-maps-legend-add-element').click()

		const message	= panel.querySelector('.uca-maps-legend-message')
		const row_src	= () => panel.querySelector('.uca-maps-legend-element img').getAttribute('src')
		assert.isTrue(message.hidden, 'expected the message line hidden while nothing failed')

		// the picker is a throwaway file input: catch it instead of opening the OS chooser
		const pick = async function(file, done) {
			let picker = null
			const original_click = HTMLInputElement.prototype.click
			HTMLInputElement.prototype.click = function() { picker = this }
			try {
				panel.querySelector('.uca-maps-legend-upload-icon').click()
			} finally {
				HTMLInputElement.prototype.click = original_click
			}
			assert.isOk(picker, 'expected the upload button to open a file picker')
			pick_file(picker, file)
			await until(done)
		}

		await pick(new File(['x'], 'note.txt', {type: 'text/plain'}), () => !message.hidden)
		assert.isFalse(message.hidden, 'expected the refusal shown in the panel')
		assert.equal(message.textContent, 'Icon file type not allowed (PNG, JPEG, GIF, WebP or SVG only).')
		assert.equal(message.dataset.type, 'error')
		assert.equal(row_src(), default_element_icon(), 'expected the pin kept')

		// a file the browser fails to read, whichever reading API asks for it
		const original_read		= FileReader.prototype.readAsDataURL
		const original_buffer	= Blob.prototype.arrayBuffer
		FileReader.prototype.readAsDataURL = function() {
			setTimeout(() => this.dispatchEvent(new ProgressEvent('error')))
		}
		Blob.prototype.arrayBuffer = () => Promise.reject(new DOMException('unreadable', 'NotReadableError'))
		try {
			await pick(pin_png(), () => !message.hidden)
		} finally {
			FileReader.prototype.readAsDataURL	= original_read
			Blob.prototype.arrayBuffer			= original_buffer
		}
		assert.isFalse(message.hidden, 'expected the failed read shown in the panel')
		assert.equal(message.textContent, 'The icon could not be read.')
		assert.equal(row_src(), default_element_icon(), 'expected the pin kept')

		await pick(pin_png(), () => row_src()!==default_element_icon())
		assert.isTrue(message.hidden, 'expected the old message cleared by the next pick')
		assert.isTrue(row_src().startsWith('data:image/png;base64,'), 'expected the row repainted with the uploaded icon')
		assert.equal(row_src(), tool.legend.columns[0].elements[0].icon, 'expected the row to show the stored icon')
	})

	it('the Legend toggle reads the DOM, so a sibling panel closing it never jams it shut', function() {

		tool.attach_legend()
		tool.attach_xyz_basemaps()

		const button = tool.legend_control.getContainer()

		button.click()
		assert.isFalse(tool.legend_panel.hidden, 'expected the first click to open')
		button.click()
		assert.isTrue(tool.legend_panel.hidden, 'expected the second click to close')

		// a sibling panel opening force-closes this one WITHOUT going through
		// its own toggle (toolbar.js close_other_toolbar_panels): a cached
		// "is open" flag would desync here and the next click would do nothing
		button.click()
		assert.isFalse(tool.legend_panel.hidden, 'expected it open again')
		tool.xyz_control.getContainer().click()
		assert.isTrue(tool.legend_panel.hidden, 'expected the sibling to have closed it')
		button.click()
		assert.isFalse(tool.legend_panel.hidden, 'expected one click to reopen it')
	})

	it('the Legend panel is centered, labels its fields, and adds where the new item appears', function() {

		tool.attach_legend()
		tool.legend_control.getContainer().click()

		const panel = tool.legend_panel
		assert.isTrue(panel.classList.contains('uca-maps-panel-centered'), 'expected the wide centered variant')
		assert.equal(panel.querySelectorAll('.uca-maps-panel-header').length, 1, 'expected toolbar.js\'s header only')
		assert.isOk(panel.querySelector('.uca-maps-panel-close'), 'expected the × to close it')

		const title_input = panel.querySelector('.uca-maps-legend-title-input')
		assert.isOk(title_input.closest('label').querySelector('.uca-maps-legend-field-label').textContent, 'expected a visible title label')

		// "+ Add group" sits AFTER the list: the new group appears right above it
		const list		= panel.querySelector('.uca-maps-legend-columns')
		const add_group	= panel.querySelector('.uca-maps-legend-add-column')
		assert.isTrue(Boolean(list.compareDocumentPosition(add_group) & Node.DOCUMENT_POSITION_FOLLOWING), 'expected Add group after the list')

		add_group.click()
		const card = panel.querySelector('.uca-maps-legend-column')
		const group_input = card.querySelector('.uca-maps-legend-column-name')
		assert.isOk(group_input.closest('label').querySelector('.uca-maps-legend-field-label').textContent, 'expected a visible group label')
		assert.equal(document.activeElement, group_input, 'expected the new group\'s name focused')

		const elements_list	= card.querySelector('.uca-maps-legend-elements')
		const add_element	= card.querySelector('.uca-maps-legend-add-element')
		assert.isTrue(Boolean(elements_list.compareDocumentPosition(add_element) & Node.DOCUMENT_POSITION_FOLLOWING), 'expected Add element after its elements')

		add_element.click()
		const element_input = panel.querySelector('.uca-maps-legend-element-name')
		assert.equal(document.activeElement, element_input, 'expected the new element\'s name focused')
		assert.isOk(element_input.getAttribute('aria-label'), 'expected the element name to carry an accessible name')
	})

	it('deleting a group that has elements asks first, in the panel; an empty group goes at once', function() {

		tool.attach_legend()
		tool.legend_control.getContainer().click()
		const panel = tool.legend_panel

		panel.querySelector('.uca-maps-legend-add-column').click()
		panel.querySelector('.uca-maps-legend-delete-column').click()
		assert.equal(tool.legend.columns.length, 0, 'expected an empty group deleted without asking')

		panel.querySelector('.uca-maps-legend-add-column').click()
		panel.querySelector('.uca-maps-legend-add-element').click()

		const confirm_node = panel.querySelector('.uca-maps-legend-confirm')
		assert.isTrue(confirm_node.hidden, 'expected no question before the click')

		panel.querySelector('.uca-maps-legend-delete-column').click()
		assert.isFalse(confirm_node.hidden, 'expected the question shown')
		assert.equal(tool.legend.columns.length, 1, 'expected nothing deleted yet')
		assert.equal(document.activeElement, confirm_node.querySelector('.uca-maps-legend-confirm-cancel'), 'expected Cancel focused, the safe answer')

		confirm_node.querySelector('.uca-maps-legend-confirm-cancel').click()
		assert.isTrue(confirm_node.hidden, 'expected Cancel to close the question')
		assert.equal(tool.legend.columns[0].elements.length, 1, 'expected the group and its element kept')

		panel.querySelector('.uca-maps-legend-delete-column').click()
		panel.querySelector('.uca-maps-legend-confirm-delete').click()
		assert.equal(tool.legend.columns.length, 0, 'expected the group deleted on Delete')
		assert.isOk(panel.querySelector('.uca-maps-legend-empty'), 'expected the list rebuilt empty')
	})

	it('↑/↓ reorder groups and elements, are disabled at the ends, and keep focus on the moved item', function() {

		tool.attach_legend()
		tool.add_legend_column()
		tool.set_legend_column_name(0, 'A')
		tool.add_legend_column()
		tool.set_legend_column_name(1, 'B')
		tool.add_legend_element(1)
		tool.set_legend_element_name(1, 0, 'x')
		tool.add_legend_element(1)
		tool.set_legend_element_name(1, 1, 'y')
		tool.legend_control.getContainer().click()
		const panel = tool.legend_panel

		const rows = () => panel.querySelectorAll('.uca-maps-legend-column-row')
		assert.isTrue(rows()[0].querySelector('.uca-maps-legend-move-up').disabled, 'expected the first group unable to go up')
		assert.isTrue(rows()[1].querySelector('.uca-maps-legend-move-down').disabled, 'expected the last group unable to go down')

		rows()[1].querySelector('.uca-maps-legend-move-up').click()
		assert.deepEqual(tool.legend.columns.map((column) => column.name), ['B', 'A'], 'expected the groups swapped')
		assert.equal(panel.querySelectorAll('.uca-maps-legend-column-name')[0].value, 'B', 'expected the list rebuilt in the new order')
		// B is now first: its ↑ is disabled, so focus lands on its ↓
		assert.equal(document.activeElement, rows()[0].querySelector('.uca-maps-legend-move-down'), 'expected focus kept on the moved group')

		const element_rows = () => panel.querySelectorAll('.uca-maps-legend-column')[0].querySelectorAll('.uca-maps-legend-element-row')
		element_rows()[0].querySelector('.uca-maps-legend-move-down').click()
		assert.deepEqual(tool.legend.columns[0].elements.map((element) => element.name), ['y', 'x'], 'expected the elements swapped')
		assert.equal(document.activeElement, element_rows()[1].querySelector('.uca-maps-legend-move-up'), 'expected focus kept on the moved element')

		const overlay_names = [...tool.legend_overlay.getContainer().querySelectorAll('.uca-maps-legend-overlay-column-name')].map((node) => node.textContent)
		assert.deepEqual(overlay_names, ['B', 'A'], 'expected the overlay redrawn in the new order')

		assert.deepEqual(tool.move_legend_column(0, -1), {ok: false}, 'expected no move past the top')
		assert.deepEqual(tool.move_legend_column(0, 2), {ok: false}, 'expected only a one-step move')
		assert.deepEqual(tool.move_legend_element(0, 1, 1), {ok: false}, 'expected no move past the bottom')
		assert.deepEqual(tool.move_legend_element(7, 0, 1), {ok: false}, 'expected a bad group refused')
	})

	it('set_legend_element_symbol draws a valid symbol and refuses anything else', async function() {

		tool.attach_legend()
		tool.add_legend_column()
		tool.add_legend_element(0)
		const element = tool.legend.columns[0].elements[0]

		for (const bad of [
			{shape: 'star', fill: picked_colour(), stroke: picked_colour()},
			{shape: 'area', fill: picked_colour().slice(1), stroke: picked_colour()},
			{shape: 'area', fill: picked_colour(), stroke: '"/><script>x</script>'},
			// String([x]) === x: a coercing check would pass it and then throw
			{shape: 'area', fill: [picked_colour()], stroke: picked_colour()},
			null
		]) {
			assert.deepEqual(tool.set_legend_element_symbol(0, 0, bad), {ok: false})
		}
		assert.equal(element.icon, default_element_icon(), 'expected a refused symbol to leave the pin')
		assert.notProperty(element, 'symbol')
		assert.deepEqual(tool.set_legend_element_symbol(0, 7, {shape: 'area', fill: picked_colour(), stroke: picked_colour()}), {ok: false})

		assert.deepEqual(tool.set_legend_element_symbol(0, 0, {shape: 'area', fill: picked_colour(), stroke: default_symbol_colour()}), {ok: true})
		const rect = decode_symbol(element.icon).querySelector('rect')
		assert.isOk(rect, 'expected an area drawn as a rectangle')
		assert.equal(rect.getAttribute('fill'), picked_colour())
		assert.equal(rect.getAttribute('stroke'), default_symbol_colour())
		assert.deepEqual(element.symbol, {shape: 'area', fill: picked_colour(), stroke: default_symbol_colour()}, 'expected the values kept to reopen the editor')
		assert.equal(tool.legend_overlay.getContainer().querySelector('.uca-maps-legend-overlay-element img').getAttribute('src'), element.icon, 'expected the overlay to draw it')

		tool.set_legend_element_symbol(0, 0, {shape: 'area', fill: picked_colour().toUpperCase(), stroke: picked_colour()})
		assert.equal(element.symbol.fill, picked_colour(), 'expected the colour stored lowercase')

		tool.set_legend_element_symbol(0, 0, {shape: 'line', fill: picked_colour(), stroke: picked_colour()})
		const line = decode_symbol(element.icon).querySelector('line')
		assert.isOk(line, 'expected a line drawn as a line')
		assert.isNull(line.getAttribute('fill'), 'expected a line with no fill')

		tool.set_legend_element_symbol(0, 0, {shape: 'point', fill: picked_colour(), stroke: picked_colour()})
		assert.isOk(decode_symbol(element.icon).querySelector('circle'), 'expected a point drawn as a circle')

		// an uploaded image replaces the drawn symbol
		const uploaded = await tool.set_legend_element_icon(
			0, 0, pin_png()
		)
		assert.isTrue(uploaded.ok)
		assert.notProperty(element, 'symbol', 'expected the symbol dropped once an image replaces it')
	})

	it('the symbol opens its own editor, and each gesture repaints the row in place', function() {

		tool.attach_legend()
		tool.legend_control.getContainer().click()
		const panel = tool.legend_panel
		panel.querySelector('.uca-maps-legend-add-column').click()
		panel.querySelector('.uca-maps-legend-add-element').click()

		const symbol_btn	= panel.querySelector('.uca-maps-legend-symbol-button')
		const row_icon		= symbol_btn.querySelector('img')
		const editor		= panel.querySelector('.uca-maps-legend-symbol-editor')
		assert.equal(row_icon.getAttribute('src'), default_element_icon(), 'expected the pin inside the symbol button')
		assert.isTrue(editor.hidden, 'expected the editor closed')
		assert.equal(symbol_btn.getAttribute('aria-expanded'), 'false')

		symbol_btn.click()
		assert.isFalse(editor.hidden, 'expected the symbol to open its editor')
		assert.equal(symbol_btn.getAttribute('aria-expanded'), 'true')
		assert.isNotOk(editor.querySelector('[aria-pressed="true"]'), 'expected no shape pressed while the pin is shown')
		assert.isOk(editor.querySelector('.uca-maps-legend-upload-icon'), 'expected image upload offered in the editor')

		editor.querySelector('[data-shape="area"]').click()
		const element = tool.legend.columns[0].elements[0]
		assert.equal(element.symbol.shape, 'area')
		assert.equal(row_icon.getAttribute('src'), element.icon, 'expected the row repainted')
		assert.isTrue(row_icon.isConnected, 'expected the row repainted IN PLACE, the list not rebuilt')
		assert.equal(editor.querySelector('[data-shape="area"]').getAttribute('aria-pressed'), 'true')

		// the colour input survives its own input event: a rebuild would close the native picker
		const fill_input = editor.querySelector('.uca-maps-legend-symbol-fill')
		fill_input.value = picked_colour()
		fill_input.dispatchEvent(new Event('input'))
		assert.equal(element.symbol.fill, picked_colour(), 'expected the fill to reach the symbol')
		assert.isTrue(fill_input.isConnected, 'expected the colour input kept')
		assert.isFalse(editor.hidden, 'expected the editor still open')
		assert.equal(decode_symbol(row_icon.getAttribute('src')).querySelector('rect').getAttribute('fill'), picked_colour())

		const stroke_label = editor.querySelector('.uca-maps-legend-symbol-stroke').closest('label').querySelector('.uca-maps-legend-field-label')
		const border_text = stroke_label.textContent
		editor.querySelector('[data-shape="line"]').click()
		assert.isTrue(fill_input.closest('label').hidden, 'expected no fill for a line')
		assert.notEqual(stroke_label.textContent, border_text, 'expected the one line colour not called a border')
		assert.equal(element.symbol.fill, picked_colour(), 'expected the fill kept for a later area or point')

		// a rebuilt list reopens the editor on the STORED symbol, not the defaults
		populate_legend_columns(tool, panel)
		const rebuilt = panel.querySelector('.uca-maps-legend-symbol-editor')
		assert.notEqual(rebuilt, editor, 'expected a fresh editor')
		assert.equal(rebuilt.querySelector('[data-shape="line"]').getAttribute('aria-pressed'), 'true', 'expected the stored shape pressed')
		assert.equal(rebuilt.querySelector('.uca-maps-legend-symbol-fill').value, picked_colour(), 'expected the stored fill')
	})

	it('detach removes the button, the panel and the overlay', async function() {

		tool.attach_legend()
		const map_container_node = geolocation.map.getContainer()

		await tool.destroy(false, false, false)

		assert.equal(tool.legend, null, 'expected the session legend cleared')
		assert.equal(tool.legend_control, null, 'expected legend_control cleared')
		assert.equal(tool.legend_panel, null, 'expected legend_panel cleared')
		assert.equal(tool.legend_overlay, null, 'expected legend_overlay cleared')
		assert.isNotOk(map_container_node.querySelector('.uca-maps-legend-control'), 'expected the button removed')
		assert.isNotOk(map_container_node.querySelector('.uca-maps-legend-panel'), 'expected the panel removed')
		assert.isNotOk(map_container_node.querySelector('.uca-maps-legend-overlay'), 'expected the overlay removed')
	})

	it('detach_file_upload removes the button and panel', async function() {

		tool.attach_file_upload()
		const map_container_node = geolocation.map.getContainer()

		await tool.destroy(false, false, false)

		assert.equal(tool.upload_control, null, 'expected upload_control cleared')
		assert.equal(tool.upload_panel, null, 'expected upload_panel cleared')
		assert.isNotOk(
			map_container_node.querySelector('.uca-maps-upload-control'),
			'expected the button removed from the DOM'
		)
		assert.isNotOk(
			map_container_node.querySelector('.uca-maps-upload-panel'),
			'expected the panel removed from the DOM'
		)
	})

	/**
	* ROMAN EMPIRE (roman_empire.js) — three gazetteers searched from one
	* centred panel; a hit becomes a REAL object of the record. No gazetteer is
	* reached: the install's answer (mount_roman) and every search are stubbed.
	*/

	// a stubbed answer settles within SETTLE_MS; a wait shorter than the debounce
	// would pass "nothing travels" without the timer ever having fired
	const SETTLE_MS			= 50
	const AFTER_DEBOUNCE_MS	= LIVE_SEARCH_DELAY_MS + SETTLE_MS

	// a document without focus gets no focus events in Chrome: these gates fail
	// loudly on the runner's state first, never as a silent pending test
	const require_document_focus = function() {
		assert.isTrue(document.hasFocus(), 'the runner page has no focus: the focus gates cannot run')
	}

	it('attach_roman_empire adds exactly one button and one hidden panel, idempotently', function() {

		mount_roman()
		tool.attach_roman_empire() // second call: a no-op, never a duplicate

		const map_container_node = geolocation.map.getContainer()
		assert.equal(
			map_container_node.querySelectorAll('.uca-maps-roman-control').length, 1,
			'expected exactly one Roma button'
		)
		assert.isOk(tool.roman_panel, 'expected the panel built')
		assert.equal(tool.roman_panel.hidden, true, 'expected the panel hidden by default')
		assert.equal(tool._roman_source, null, 'expected no list, so no source owning one')
	})

	it('the panel is centred, closes with ×, and shows the three sources AT ONCE in v6 order', function() {

		// all three at once, as v6's modal: a source selector would hide two
		mount_roman()

		const panel = tool.roman_panel
		assert.isTrue(panel.classList.contains('uca-maps-panel-centered'), 'expected the centred panel')

		const sections = Array.from(panel.querySelectorAll('.uca-maps-roman-source'))
		assert.deepEqual(sections.map((one) => one.dataset.source), ['pleiades', 'pelagios', 'dare'], 'expected Pleiades, Pelagios, DARE')
		for (const section of sections) {
			assert.equal(section.hidden, false, 'expected every source visible: ' + section.dataset.source)
			assert.equal(section.querySelectorAll('.uca-maps-roman-input').length, 1, 'expected one field per source')
		}

		open_roman()
		assert.equal(panel.hidden, false)
		panel.querySelector('.uca-maps-panel-close').click()
		assert.equal(panel.hidden, true, 'expected × to close the panel')
	})

	it('Pleiades picks name or id with two radios, and the choice reaches the search', async function() {

		mount_roman(WITH_PLEIADES)
		await load_roman_capabilities(tool) // Pleiades enabled BEFORE it is driven

		const section	= tool.roman_panel.querySelector('.uca-maps-roman-pleiades')
		const radios	= section.querySelectorAll('.uca-maps-roman-pleiades-type input[type="radio"]')
		assert.equal(radios.length, 2, 'expected two radios, not a select')
		assert.isNotOk(section.querySelector('select'), 'expected no select in the Pleiades section')
		assert.equal(radios[0].name, radios[1].name, 'expected ONE radio group')
		assert.equal(radios[0].value, 'name')
		assert.isTrue(radios[0].checked, 'expected "by name" chosen by default, as in v6')

		const sent = []
		stub_tool_request(async function(options) {
			sent.push(options)
			return { ok: true, data: { results: [] } }
		})

		radios[1].click()
		const input = section.querySelector('.uca-maps-roman-input')
		assert.isFalse(input.disabled, 'expected the Pleiades field enabled by its capability')
		input.value = '7'
		input.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', bubbles: true}))
		await tick(SETTLE_MS)

		assert.equal(sent.length, 1, 'expected one search: an id of one digit is a query')
		assert.equal(sent[0].action, 'search_pleiades')
		assert.equal(sent[0].options.type, 'id', 'expected the checked radio forwarded')
	})

	it('two Roman panels on one page keep their own Pleiades choice: each radio group has its own name', async function() {

		mount_roman(WITH_PLEIADES)
		// a second tool on the same page, as when two records' maps are open at once
		const other = new tool_uca_maps()
		other.model				= 'tool_uca_maps'
		other.caller			= geolocation
		other.geolocation		= geolocation
		other.map_ready			= true
		other.mode				= 'edit'
		other.get_tool_label	= () => undefined
		other.get_capabilities	= async () => ({ ok: true, data: { gazetteers: structuredClone(WITH_PLEIADES) } })
		other.attach_roman_empire()
		try {
			const radios = (owner) => owner.roman_panel.querySelectorAll('.uca-maps-roman-pleiades-type input[type="radio"]')
			assert.notEqual(radios(tool)[0].name, radios(other)[0].name, 'expected one group name per panel')

			radios(other)[1].click()
			assert.isTrue(radios(other)[1].checked, 'expected the second panel searching by id')
			assert.isTrue(radios(tool)[0].checked, 'expected the first panel still searching by name')
		} finally {
			await other.destroy(false, false, false)
		}
	})

	it('search_roman refuses an empty query, and Pelagios with no layer, without asking the server', async function() {

		mount_roman()

		let asked = false
		stub_tool_request(async function() { asked = true; return {} })

		const empty = await search_roman(tool, 'pleiades', { query: '   ' })
		assert.equal(empty.ok, false, 'expected a caller-fault verdict')
		assert.isOk(empty.error, 'expected a message to show in the panel')

		const no_layer = await search_roman(tool, 'pelagios', { query: 'Gades', datasets: [] })
		assert.equal(no_layer.ok, false, 'expected Pelagios with no layer refused')
		assert.isOk(no_layer.error)

		assert.equal(asked, false, 'expected NO request in either case')
	})

	it('each source sends its OWN action and its own fields', async function() {

		mount_roman()

		const sent = []
		stub_tool_request(async function(options) {
			sent.push(options)
			return { ok: true, data: { results: [] } }
		})

		await search_roman(tool, 'pleiades', { query: 'Gades', type: 'id' })
		await search_roman(tool, 'pelagios', { query: 'Gades', datasets: ['provinces'] })
		await search_roman(tool, 'dare', { query: 'Gades', name_type: 'ass', type_id: '11', country: 'ES' })

		assert.deepEqual(sent.map((one) => one.action), ['search_pleiades', 'search_pelagios', 'search_dare'])
		assert.equal(sent[0].options.type, 'id', 'expected the Pleiades search type forwarded')
		assert.equal(sent[0].options.value, 'Gades')
		assert.deepEqual(sent[1].options.datasets, ['provinces'], 'expected the chosen layers forwarded')
		assert.equal(sent[2].options.name_type, 'ass')
		assert.equal(sent[2].options.type_id, '11')
		assert.equal(sent[2].options.country, 'ES')
	})

	it('the hits render one clickable row each, and a row DRAWS the place on the map', async function() {

		mount_roman()
		// open: a list never shows over a closed panel
		open_roman()

		stub_tool_request(async function() {
			return { ok: true, data: { results: [
				roman_hit('Gades', 36.53, -6.29),
				roman_hit('Gadir', 36.54, -6.30)
			] } }
		})

		const result = await search_roman(tool, 'dare', { query: 'Gad', name_type: 'mss' })
		assert.equal(result.ok, true)
		assert.equal(result.results.length, 2)
		assert.equal(tool._roman_source, 'dare', 'expected the list to know which source found it')

		populate_roman_results(tool, tool.roman_panel)
		const rows = tool.roman_dropdown.querySelectorAll('.uca-maps-roman-result-button')
		assert.equal(rows.length, 2, 'expected one row per hit')
		assert.include(rows[0].textContent, 'Gades')
		assert.equal(tool.roman_dropdown.hidden, false, 'expected the suggestion list open')

		// unlike the place search (which only moves the view), adding a hit
		// creates a real object through the SAME pm:create door every import
		// in this tool uses
		const feature_group	= active_group()
		const before		= feature_group.getLayers().length
		const added			= await add_roman_result(tool, 0)
		assert.equal(added.ok, true, 'expected the place added')
		assert.equal(added.created, 1, 'expected exactly one layer created')
		assert.equal(
			feature_group.getLayers().length, before + 1,
			'expected one more object in the active FeatureGroup'
		)
	})

	it('a hit whose geometry Leaflet cannot build is reported, never a silent success', async function() {

		mount_roman()

		tool._roman_results = [{ name: 'no geometry', feature: { type: 'Feature', properties: {}, geometry: null } }]
		const added = await add_roman_result(tool, 0)

		assert.equal(added.ok, false, 'expected a failure verdict')
		assert.isOk(added.error, 'expected a message for the panel')
	})

	it('a Pleiades hit carries only an id, so its geometry is fetched before drawing', async function() {

		mount_roman()

		// captured, asserted after: add_roman_result's catch would swallow an
		// assertion thrown inside the stub
		let asked = null
		stub_tool_request(async function(options) {
			asked = options
			return { ok: true, data: { place: {
				type		: 'FeatureCollection',
				features	: [roman_feature('Gades', 36.53, -6.29)]
			} } }
		})

		tool._roman_results = [{ name: 'Gades', id: '256135' }]
		const added = await add_roman_result(tool, 0)

		assert.isOk(asked, 'expected the server asked for the geometry')
		assert.equal(asked.action, 'get_pleiades_place', 'expected the geometry fetched by id')
		assert.equal(asked.options.id, '256135', 'expected the hit id forwarded')
		assert.equal(added.ok, true)
		assert.equal(added.created, 1)
	})

	it('create_roman_objects fits the LARGEST geometry of a multi-part place, listed first or last', function() {

		mount_roman()

		const small	= { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[[0, 0], [0.01, 0], [0.01, 0.01], [0, 0.01], [0, 0]]] } }
		const big	= { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[[10, 10], [12, 10], [12, 12], [10, 12], [10, 10]]] } }

		// both orders: "the last part wins" and "the first part wins" each fail one
		for (const [label, features] of [['first', [big, small]], ['last', [small, big]]]) {
			// far from both parts and more than four zoom steps off either fit: Leaflet
			// then jumps without animating, so getBounds reads the fitted view at once
			geolocation.map.setView([-40, 120], 15, {animate: false})
			const created = create_roman_objects(tool, { type: 'FeatureCollection', features: features })
			assert.equal(created, 2, 'expected both parts created, the bigger listed ' + label)
			assert.isTrue(
				geolocation.map.getBounds().contains(L.latLng(11, 11)),
				'expected the map fitted to the bigger part, listed ' + label
			)
		}
	})

	it('a source this install cannot serve stays in view, disabled and saying why', function() {

		mount_roman()

		tool._roman_gazetteers = { configured: false, pleiades: false, pelagios: [] }
		refresh_roman_sources(tool, tool.roman_panel)

		for (const source of ['pleiades', 'pelagios']) {
			const section = tool.roman_panel.querySelector('.uca-maps-roman-' + source)
			assert.equal(section.hidden, false, 'expected the section still shown: ' + source)
			assert.equal(section.querySelector('.uca-maps-roman-input').disabled, true, 'expected its field disabled: ' + source)
			assert.equal(
				section.querySelector('.uca-maps-roman-unavailable').hidden, false,
				'expected the missing-data reason shown, not silence: ' + source
			)
		}
		const dare = tool.roman_panel.querySelector('.uca-maps-roman-dare')
		assert.equal(dare.querySelector('.uca-maps-roman-input').disabled, false, 'expected DARE always available')
		assert.equal(dare.querySelector('.uca-maps-roman-unavailable').hidden, true)
	})

	it('the layer checkboxes come from the INSTALL, never from a client-side copy of the list', async function() {

		mount_roman({ configured: true, pleiades: true, pelagios: ['provinces', 'roads_high'] })

		await load_roman_capabilities(tool)

		const boxes = tool.roman_panel.querySelectorAll('.uca-maps-roman-dataset-checkbox')
		assert.equal(boxes.length, 2, 'expected exactly the layers the install reported')
		assert.deepEqual(Array.from(boxes).map((box) => box.value), ['provinces', 'roads_high'])
		assert.isTrue(Array.from(boxes).every((box) => box.checked), 'expected every layer selected by default')
		assert.isTrue(
			Array.from(tool.roman_panel.querySelectorAll('.uca-maps-roman-input')).every((input) => !input.disabled),
			'expected every source enabled when the install serves them all'
		)
	})

	// SUGGESTIONS AS YOU TYPE — v6 searches on every keyup in the three blocks
	// (`special_tools_roman_empire.js`); here a debounced input does.

	it('each source declares its minimum query: Pleiades 3 by name and 1 by id, Pelagios 2, DARE 3', function() {

		assert.equal(roman_min_query('pleiades', 'name'), 3, 'Pleiades by name: 3 (v6 strlen > 2)')
		assert.equal(roman_min_query('pleiades', 'id'), 1, 'an id is exact, one digit is a query')
		assert.equal(roman_min_query('pelagios'), 2, 'Pelagios: 2 (v6 strlen >= 2)')
		assert.equal(roman_min_query('dare'), 3, 'DARE: 3 (v6 strlen >= 3)')
	})

	it('typing searches by itself, and below the minimum nothing travels', async function() {

		mount_roman()
		open_roman() // a list shows only over an open panel

		let asked = 0
		stub_tool_request(async function() {
			asked++
			return { ok: true, data: { results: [
				roman_hit('Gades', 36.53, -6.29)
			] } }
		})

		const input = tool.roman_panel.querySelector('.uca-maps-roman-dare .uca-maps-roman-input')

		// below the minimum: no request, not even after the debounce window
		input.value = 'Ga'
		input.dispatchEvent(new Event('input'))
		await tick(AFTER_DEBOUNCE_MS)
		assert.equal(asked, 0, 'expected NO request for a query under the minimum')

		// at the minimum: one request, and the list renders itself
		input.value = 'Gades'
		input.dispatchEvent(new Event('input'))
		await tick(AFTER_DEBOUNCE_MS)

		assert.equal(asked, 1, 'expected exactly one request after typing')
		assert.equal(
			tool.roman_dropdown.querySelectorAll('.uca-maps-roman-result-button').length, 1,
			'expected the suggestion rendered without pressing anything'
		)
		assert.equal(tool.roman_dropdown.hidden, false, 'expected the list open by itself')
	})

	it('a burst of keystrokes is ONE request, not one per character (v6 fires per keyup)', async function() {

		mount_roman()

		let asked = 0
		stub_tool_request(async function() {
			asked++
			return { ok: true, data: { results: [] } }
		})

		const input = tool.roman_panel.querySelector('.uca-maps-roman-dare .uca-maps-roman-input')
		for (const value of ['Gad', 'Gade', 'Gades', 'Gadesx']) {
			input.value = value
			input.dispatchEvent(new Event('input'))
			await tick(LIVE_SEARCH_DELAY_MS / 4) // well inside the debounce window
		}
		await tick(AFTER_DEBOUNCE_MS)

		assert.equal(asked, 1, 'expected the burst collapsed into a single request')
	})

	it('a slow early search never overwrites the results of the last one typed', async function() {

		mount_roman()

		let release_first
		let call = 0
		stub_tool_request(function() {
			call++
			if (call===1) {
				return new Promise((resolve) => { release_first = () => resolve({ ok: true, data: { results: [
					roman_hit('STALE', 0, 0)
				] } }) })
			}
			return Promise.resolve({ ok: true, data: { results: [
				roman_hit('FRESH', 1, 1)
			] } })
		})

		const first	= search_roman(tool, 'dare', { query: 'Gades', name_type: 'mss' })
		const second	= await search_roman(tool, 'pelagios', { query: 'Gadir', datasets: ['provinces'] })
		assert.equal(second.ok, true)
		assert.equal(second.results[0].name, 'FRESH')

		release_first()
		const stale = await first

		assert.equal(stale.ok, false, 'expected the overtaken search to report nothing')
		assert.equal(tool._roman_results[0].name, 'FRESH', 'expected the newest results kept')
		assert.equal(tool._roman_source, 'pelagios', 'expected the list owned by the newest search, across fields')
	})

	// THE TYPEAHEAD — the hits are a list anchored to the field, not a block
	// inside the panel, and choosing one IS adding it.

	it('the suggestion list hangs from the MAP, not from the panel (the panel would clip it)', function() {

		mount_roman()

		const map_container_node = geolocation.map.getContainer()
		assert.isOk(tool.roman_dropdown, 'expected the list built')
		assert.equal(tool.roman_dropdown.hidden, true, 'expected it closed until something is typed')
		assert.equal(tool.roman_dropdown.parentNode, map_container_node, 'expected it parented to the map container')
		assert.isNotOk(
			tool.roman_panel.querySelector('.uca-maps-roman-dropdown'),
			'expected it OUTSIDE the panel, whose overflow would clip it'
		)
	})

	it('the arrows walk the list and Enter draws the highlighted place', async function() {

		mount_roman()
		open_roman() // a list shows only over an open panel

		stub_tool_request(async function() {
			return { ok: true, data: { results: [
				roman_hit('first', 36.5, -6.2),
				roman_hit('second', 39.9, -0.2)
			] } }
		})

		const input = tool.roman_panel.querySelector('.uca-maps-roman-dare .uca-maps-roman-input')
		input.value = 'Gades'
		input.dispatchEvent(new Event('input'))
		await tick(AFTER_DEBOUNCE_MS)

		const rows = tool.roman_dropdown.querySelectorAll('.uca-maps-roman-result-button')
		assert.equal(rows.length, 2)
		assert.equal(tool._roman_active_index, -1, 'expected nothing highlighted until the user walks the list')

		input.dispatchEvent(new KeyboardEvent('keydown', {key: 'ArrowDown', bubbles: true}))
		input.dispatchEvent(new KeyboardEvent('keydown', {key: 'ArrowDown', bubbles: true}))
		assert.equal(tool._roman_active_index, 1, 'expected the second row highlighted')
		assert.isTrue(rows[1].classList.contains('is-active'), 'expected the highlight in the DOM, not only in a flag')

		const feature_group	= active_group()
		const before		= feature_group.getLayers()

		input.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', bubbles: true}))
		await tick(SETTLE_MS)

		const drawn = feature_group.getLayers().filter((layer) => !before.includes(layer))
		assert.equal(drawn.length, 1, 'expected Enter to draw one place')
		const at = drawn[0].getLatLng()
		assert.closeTo(at.lat, 39.9, 1e-6, 'expected the highlighted "second" drawn, not the first row')
		assert.closeTo(at.lng, -0.2, 1e-6, 'expected the highlighted "second" drawn, not the first row')
		assert.equal(tool.roman_dropdown.hidden, true, 'expected the list closed after choosing')
	})

	it('Escape closes the list without clearing what was typed', async function() {

		mount_roman()
		open_roman() // a list shows only over an open panel

		stub_tool_request(async function() {
			return { ok: true, data: { results: [
				roman_hit('Gades', 36.5, -6.2)
			] } }
		})

		const input = tool.roman_panel.querySelector('.uca-maps-roman-dare .uca-maps-roman-input')
		input.value = 'Gades'
		input.dispatchEvent(new Event('input'))
		await tick(AFTER_DEBOUNCE_MS)
		assert.equal(tool.roman_dropdown.hidden, false)

		input.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true}))

		assert.equal(tool.roman_dropdown.hidden, true, 'expected the list closed')
		assert.equal(input.value, 'Gades', 'expected the typed text untouched')
		assert.equal(tool._roman_active_index, -1, 'expected the highlight forgotten')
	})

	it('a click on the map closes the list, and closing the panel takes it with it', async function() {

		mount_roman()
		const map_container_node = geolocation.map.getContainer()
		map_container_node.querySelector('.uca-maps-roman-control').click() // open the panel, as a user would
		seed_roman_list('dare', [roman_hit('Gades', 36.5, -6.2)])
		assert.equal(tool.roman_dropdown.hidden, false)

		map_container_node.dispatchEvent(new MouseEvent('mousedown', {bubbles: true}))
		assert.equal(tool.roman_dropdown.hidden, true, 'expected a click outside to close it')

		// and a SIBLING panel forcing the Roma panel shut must close it too —
		// that path is toolbar.js's on_hide, not the click-outside listener:
		// Leaflet stops mousedown propagation inside its own controls, so the
		// map-level listener never sees a click on another tool button
		populate_roman_results(tool, tool.roman_panel)
		assert.equal(tool.roman_dropdown.hidden, false)
		tool.attach_object_viewer()
		map_container_node.querySelector('.uca-maps-object-viewer-control').click()
		assert.equal(tool.roman_panel.hidden, true, 'expected the Roma panel forced shut by its sibling')
		assert.equal(tool.roman_dropdown.hidden, true, 'expected the sibling panel to close the list as well')
	})

	it('teardown cancels a pending as-you-type search instead of firing it into a dead panel', async function() {

		mount_roman()

		let asked = 0
		stub_tool_request(async function() { asked++; return { ok: true, data: { results: [] } } })

		const input = tool.roman_panel.querySelector('.uca-maps-roman-dare .uca-maps-roman-input')
		input.value = 'Gades'
		input.dispatchEvent(new Event('input'))

		assert.isOk(tool._roman_search_timer, 'expected the search waiting out the debounce')
		await tool.destroy(false, false, false) // BEFORE the debounce window elapses
		// the dead tool also refuses a late search, so only the timer shows the cancel
		assert.isNull(tool._roman_search_timer, 'expected teardown to clear the waiting timer')
		await tick(AFTER_DEBOUNCE_MS)

		assert.equal(asked, 0, 'expected the pending search cancelled by teardown')
	})

	it('scrolling the panel carries the list with its field, and closes it once the field leaves the view', function() {

		mount_roman()
		open_roman()
		const panel = tool.roman_panel
		make_panel_scrollable(panel)

		// DARE's field in the middle of the view, then the list opened under it
		const input = panel.querySelector('.uca-maps-roman-dare .uca-maps-roman-input')
		panel.scrollTop += input.getBoundingClientRect().top - panel.getBoundingClientRect().top - panel.clientHeight / 2
		seed_roman_list('dare', [roman_hit('Gades', 36.5, -6.2)])
		const anchored_top = tool.roman_dropdown.style.top

		panel.scrollTop -= 20
		panel.dispatchEvent(new Event('scroll'))
		assert.equal(tool.roman_dropdown.hidden, false, 'expected a scroll that keeps the field in view to keep the list')
		assert.notEqual(tool.roman_dropdown.style.top, anchored_top, 'expected the list moved with its field')
		const container_top = tool.roman_dropdown.parentNode.getBoundingClientRect().top
		assert.equal(
			tool.roman_dropdown.style.top,
			Math.round(input.getBoundingClientRect().bottom - container_top + 2) + 'px',
			'expected the list right under its field'
		)

		panel.scrollTop = 0 // DARE is the last source: its field is now below the view
		panel.dispatchEvent(new Event('scroll'))
		assert.equal(tool.roman_dropdown.hidden, true, 'expected the list closed once its field left the view')
	})

	// hiding a message at the panel's bottom makes the browser clamp scrollTop
	// and fire `scroll`, which must not close the list nor drop its search
	it('a scroll the layout causes by itself never closes the list it just opened', async function() {

		mount_roman()
		open_roman()
		const panel = tool.roman_panel
		make_panel_scrollable(panel)

		const block		= panel.querySelector('.uca-maps-roman-dare')
		const input		= block.querySelector('.uca-maps-roman-input')
		const message	= block.querySelector('.uca-maps-roman-message')
		stub_tool_request(async function() {
			return { ok: true, data: { results: [roman_hit('Gades', 36.5, -6.2)] } }
		})

		input.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', bubbles: true})) // empty: an error under DARE
		await tick(SETTLE_MS)
		assert.equal(message.hidden, false, 'expected the empty-query message under DARE')

		panel.scrollTop = panel.scrollHeight // at the bottom: hiding that message has to clamp
		const bottom = panel.scrollTop
		let scrolls = 0
		panel.addEventListener('scroll', () => scrolls++)

		input.value = 'Gades'
		input.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', bubbles: true}))
		await tick(SETTLE_MS)
		await two_frames()

		assert.equal(message.hidden, true, 'expected the message cleared by the hits')
		assert.isBelow(panel.scrollTop, bottom, 'expected the browser to clamp scrollTop — else this gate proves nothing')
		assert.isAbove(scrolls, 0, 'expected the clamp to fire scroll — else this gate proves nothing')
		assert.equal(tool.roman_dropdown.hidden, false, 'expected the list still open after the layout scroll')
	})

	// the panel swallows mousedown before it bubbles to the map's listener, so a
	// click inside it needs its own check
	it('a click inside the panel, on another source\'s field, closes the list', async function() {

		mount_roman(WITH_PLEIADES)
		await load_roman_capabilities(tool) // Pleiades enabled BEFORE it is driven
		open_roman()
		seed_roman_list('pleiades', [{ name: 'Roma', id: '423025' }])

		const own_input		= tool.roman_panel.querySelector('.uca-maps-roman-pleiades .uca-maps-roman-input')
		const other_input	= tool.roman_panel.querySelector('.uca-maps-roman-dare .uca-maps-roman-input')

		own_input.dispatchEvent(new MouseEvent('mousedown', {bubbles: true}))
		assert.equal(tool.roman_dropdown.hidden, false, 'expected a click in the list\'s own field to keep it open')

		other_input.dispatchEvent(new MouseEvent('mousedown', {bubbles: true}))
		assert.equal(tool.roman_dropdown.hidden, true, 'expected a click in another source\'s field to close it')
	})

	it('a search still in flight never opens its list once the user has moved to another field', async function() {

		mount_roman(WITH_PLEIADES)
		await load_roman_capabilities(tool)
		open_roman() // open: a closed panel hides any list anyway

		let release_first
		stub_tool_request(function() {
			return new Promise((resolve) => { release_first = () => resolve({ ok: true, data: { results: [
				{ name: 'Roma', id: '423025' }
			] } }) })
		})

		const pleiades_input	= tool.roman_panel.querySelector('.uca-maps-roman-pleiades .uca-maps-roman-input')
		const dare_input		= tool.roman_panel.querySelector('.uca-maps-roman-dare .uca-maps-roman-input')

		pleiades_input.value = 'Rom'
		pleiades_input.dispatchEvent(new Event('input'))
		await tick(AFTER_DEBOUNCE_MS) // the Pleiades search is now in flight

		dare_input.value = 'V' // below DARE's minimum: nothing travels, the list is closed
		dare_input.dispatchEvent(new Event('input'))

		release_first()
		await tick(SETTLE_MS)

		assert.equal(tool.roman_dropdown.hidden, true, 'expected the late Pleiades answer NOT to open its list')
		assert.equal(tool._roman_results, null, 'expected the late answer discarded')
	})

	it('a search refused before travelling still outdates the older one in flight', async function() {

		mount_roman()

		let release_first
		stub_tool_request(function() {
			return new Promise((resolve) => { release_first = () => resolve({ ok: true, data: { results: [
				roman_hit('STALE', 0, 0)
			] } }) })
		})

		const first		= search_roman(tool, 'dare', { query: 'Gades', name_type: 'mss' })
		const refused	= await search_roman(tool, 'pelagios', { query: 'Gadir', datasets: [] })
		assert.equal(refused.ok, false, 'expected Pelagios with no layer refused')

		release_first()
		const stale = await first

		assert.equal(stale.ok, false, 'expected the older search outdated by the refused one')
		assert.equal(tool._roman_results, null, 'expected no stale list kept')
	})

	// every opening starts clean, as v6 rebuilds its modal on every click
	// (special_tools_roman_empire.js)
	it('reopening the panel starts clean: fields, messages, list and filters', async function() {

		mount_roman({ configured: true, pleiades: true, pelagios: ['provinces', 'roads_high'] })
		await load_roman_capabilities(tool)

		const control	= geolocation.map.getContainer().querySelector('.uca-maps-roman-control')
		const panel		= tool.roman_panel
		control.click() // open

		for (const input of panel.querySelectorAll('.uca-maps-roman-input')) {
			input.value = 'Gades'
		}
		panel.querySelector('.uca-maps-roman-pleiades-type input[value="id"]').checked = true
		for (const select of panel.querySelectorAll('.uca-maps-roman-dare-filters select')) {
			select.selectedIndex = 1
		}
		panel.querySelector('.uca-maps-roman-dataset-checkbox').checked = false
		const message = panel.querySelector('.uca-maps-roman-dare .uca-maps-roman-message')
		message.textContent	= 'an old error'
		message.hidden		= false
		seed_roman_list('dare', [roman_hit('Gades', 36.5, -6.2)])

		control.click() // close
		control.click() // reopen

		for (const input of panel.querySelectorAll('.uca-maps-roman-input')) {
			assert.equal(input.value, '', 'expected every field empty on reopening')
		}
		assert.isTrue(panel.querySelector('.uca-maps-roman-pleiades-type input[value="name"]').checked, 'expected Pleiades back to "by name"')
		for (const select of panel.querySelectorAll('.uca-maps-roman-dare-filters select')) {
			assert.equal(select.selectedIndex, 0, 'expected every DARE filter back to its first option')
		}
		for (const box of panel.querySelectorAll('.uca-maps-roman-dataset-checkbox')) {
			assert.isTrue(box.checked, 'expected every Pelagios layer checked again')
		}
		assert.equal(message.hidden, true, 'expected the old message gone')
		assert.equal(tool.roman_dropdown.hidden, true, 'expected no list open')
		assert.equal(tool._roman_results, null, 'expected the old hits forgotten')
	})

	// a label stretched across its grid cell turns the blank space beside the
	// name into a click that toggles the layer
	it('the twelve Pelagios layers show with no inner scroll, each on one line and only as wide as its box and name', async function() {

		// with the tool CSS or not at all: without it the list is a plain block that
		// never scrolls, and a <label> is inline and already this narrow
		await with_tool_css(async () => {
			mount_roman({ configured: true, pleiades: true, pelagios: [
				'places_high', 'places_medium', 'places_low', 'places_subsites',
				'fortifications', 'provinces', 'provinces_label', 'roads_high',
				'roads_low', '10m_lakes', '10m_lakes_label', '10m_rivers_lake_centerlines'
			] })
			await load_roman_capabilities(tool)

			open_roman()

			const container = tool.roman_panel.querySelector('.uca-maps-roman-datasets')
			assert.equal(getComputedStyle(container).display, 'grid', 'expected the tool CSS applied — else this gate proves nothing')
			const rows = Array.from(container.querySelectorAll('.uca-maps-roman-dataset-row'))
			assert.equal(rows.length, 12, 'expected the twelve layers rendered — zero rows would pass the loops below')

			assert.isAtMost(
				container.scrollHeight, container.clientHeight + 1,
				'expected every layer visible without scrolling inside the list'
			)
			// a wrapped identifier reads as two layers: no row taller than the shortest
			const one_line = Math.min(...rows.map((row) => row.getBoundingClientRect().height))
			for (const row of rows) {
				assert.isAtMost(row.getBoundingClientRect().height, one_line + 1, 'expected the layer name on a single line: ' + row.textContent)
				assert.isBelow(row.scrollWidth, row.clientWidth + 2, 'expected the layer name not overflowing its row: ' + row.textContent)
				const box	= row.querySelector('input').getBoundingClientRect().width
				const name	= row.querySelector('span').getBoundingClientRect().width
				assert.isAtMost(
					row.getBoundingClientRect().width, box + name + 12,
					'expected no clickable blank space beside the layer: ' + row.textContent
				)
			}
		})
	})

	it('detach_roman_empire removes the button and panel', async function() {

		mount_roman()
		const map_container_node = geolocation.map.getContainer()

		await tool.destroy(false, false, false)

		assert.equal(tool.roman_control, null, 'expected roman_control cleared')
		assert.equal(tool.roman_panel, null, 'expected roman_panel cleared')
		assert.equal(tool.roman_dropdown, null, 'expected the suggestion list cleared')
		assert.isNotOk(
			map_container_node.querySelector('.uca-maps-roman-dropdown'),
			'expected the suggestion list removed from the map container'
		)
		assert.equal(tool._roman_results, null, 'expected the session hits cleared')
		assert.isNotOk(
			map_container_node.querySelector('.uca-maps-roman-control'),
			'expected the button removed from the DOM'
		)
		assert.isNotOk(
			map_container_node.querySelector('.uca-maps-roman-panel'),
			'expected the panel removed from the DOM'
		)
	})


	// the Pleiades geometry is fetched AFTER choosing, so its error can arrive
	// once the panel was closed and reopened clean
	it('a late error from drawing a Pleiades hit never lands in the panel reopened clean', async function() {

		mount_roman(WITH_PLEIADES)
		await load_roman_capabilities(tool)

		const control	= geolocation.map.getContainer().querySelector('.uca-maps-roman-control')
		const panel		= tool.roman_panel
		const message	= panel.querySelector('.uca-maps-roman-pleiades .uca-maps-roman-message')
		let release
		let asked = 0
		stub_tool_request(function() {
			asked++
			return new Promise((resolve) => { release = () => resolve({ ok: true, data: { place: null } }) })
		})
		const choose_roma = () => {
			seed_roman_list('pleiades', [{ name: 'Roma', id: '423025' }])
			tool.roman_dropdown.querySelector('.uca-maps-roman-result-button')
				.dispatchEvent(new MouseEvent('mousedown', {bubbles: true, cancelable: true}))
		}
		control.click() // open

		// control half: with the panel left alone, the error IS shown
		choose_roma()
		release()
		await tick(SETTLE_MS)
		assert.equal(message.hidden, false, 'expected a geometry-less place reported under Pleiades')

		choose_roma()
		assert.equal(asked, 2, 'expected the second geometry request sent — else release() replays the first')
		control.click() // close
		control.click() // reopen: clean
		release()
		await tick(SETTLE_MS)
		assert.equal(message.hidden, true, 'expected the late error dropped by the reopened panel')
	})

	it('↑/↓ and Enter in one source\'s field never walk nor pick another source\'s list', async function() {

		mount_roman(WITH_PLEIADES)
		await load_roman_capabilities(tool)
		open_roman()

		const panel				= tool.roman_panel
		const pleiades_input	= panel.querySelector('.uca-maps-roman-pleiades .uca-maps-roman-input')
		const dare_input		= panel.querySelector('.uca-maps-roman-dare .uca-maps-roman-input')
		const asked = []
		stub_tool_request(async function(options) {
			asked.push(options.action)
			return { ok: true, data: { results: [] } }
		})
		seed_roman_list('pleiades', [{ name: 'Roma', id: '423025' }, { name: 'Roma Vecchia', id: '423026' }])

		// control: the list's OWN field walks it
		pleiades_input.dispatchEvent(new KeyboardEvent('keydown', {key: 'ArrowDown', bubbles: true}))
		assert.equal(tool._roman_active_index, 0, 'expected ↓ in its own field to walk the list')

		// two ↓: walking the two-row Pleiades list from 0 would end on 1
		dare_input.dispatchEvent(new KeyboardEvent('keydown', {key: 'ArrowDown', bubbles: true}))
		dare_input.dispatchEvent(new KeyboardEvent('keydown', {key: 'ArrowDown', bubbles: true}))
		assert.equal(tool._roman_active_index, 0, 'expected ↓ in DARE not to walk the Pleiades list')

		pleiades_input.dispatchEvent(new KeyboardEvent('keydown', {key: 'ArrowDown', bubbles: true}))
		assert.equal(tool._roman_active_index, 1, 'expected ↓ in its own field to reach the last row')
		dare_input.dispatchEvent(new KeyboardEvent('keydown', {key: 'ArrowUp', bubbles: true}))
		assert.equal(tool._roman_active_index, 1, 'expected ↑ in DARE not to walk the Pleiades list')

		dare_input.value = 'Gades'
		dare_input.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', bubbles: true}))
		await tick(SETTLE_MS)
		assert.deepEqual(asked, ['search_dare'], 'expected Enter in DARE to search DARE, never to draw the active Pleiades row')
	})

	it('detach_roman_empire removes the capture listener it put on the map container', async function() {

		const container	= geolocation.map.getContainer()
		const is_capture	= (opts) => opts===true || Boolean(opts && opts.capture)
		const added		= []
		const removed	= []
		container.addEventListener = function(type, fn, opts) {
			if (type==='mousedown' && is_capture(opts)) { added.push(fn) }
			return EventTarget.prototype.addEventListener.call(this, type, fn, opts)
		}
		container.removeEventListener = function(type, fn, opts) {
			if (type==='mousedown' && is_capture(opts)) { removed.push(fn) }
			return EventTarget.prototype.removeEventListener.call(this, type, fn, opts)
		}

		try {
			mount_roman()
			assert.equal(added.length, 1, 'expected ONE capture mousedown listener on the map container')
			await tool.destroy(false, false, false)
			assert.include(removed, added[0], 'expected teardown to remove that same listener, in capture')
		} finally {
			delete container.addEventListener
			delete container.removeEventListener
		}
	})

	// a keystroke still waiting out the debounce would take a NEWER token than the
	// cancelled search and reopen the list after Esc, or over a closed panel
	it('closing the list cancels a keystroke still waiting out the debounce', async function() {

		mount_roman()
		const control	= geolocation.map.getContainer().querySelector('.uca-maps-roman-control')
		control.click() // open

		let asked = 0
		stub_tool_request(async function() {
			asked++
			return { ok: true, data: { results: [roman_hit('Gades', 36.5, -6.2)] } }
		})
		const input = tool.roman_panel.querySelector('.uca-maps-roman-dare .uca-maps-roman-input')
		const type_gades = () => {
			input.value = 'Gades'
			input.dispatchEvent(new Event('input'))
		}

		// control half: left alone, the keystroke DOES search and open the list
		type_gades()
		await tick(AFTER_DEBOUNCE_MS)
		assert.equal(asked, 1, 'expected the debounced search sent')
		assert.equal(tool.roman_dropdown.hidden, false)

		type_gades()
		input.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true}))
		await tick(AFTER_DEBOUNCE_MS)
		assert.equal(asked, 1, 'expected Esc to cancel the waiting search')
		assert.equal(tool.roman_dropdown.hidden, true, 'expected the list to stay closed after Esc')

		type_gades()
		tool.roman_panel.querySelector('.uca-maps-panel-close').click() // the ×
		await tick(AFTER_DEBOUNCE_MS)
		assert.equal(asked, 1, 'expected the × to cancel the waiting search')
		assert.equal(tool.roman_dropdown.hidden, true, 'expected no list over a closed panel')
	})

	it('Tab into another field closes the list, as a click there does', async function() {

		require_document_focus()
		mount_roman(WITH_PLEIADES)
		await load_roman_capabilities(tool)
		open_roman()

		const panel				= tool.roman_panel
		const pleiades_input	= panel.querySelector('.uca-maps-roman-pleiades .uca-maps-roman-input')
		const dare_input		= panel.querySelector('.uca-maps-roman-dare .uca-maps-roman-input')
		seed_roman_list('pleiades', [{ name: 'Roma', id: '423025' }])

		pleiades_input.focus() // its own field: the list stays
		assert.equal(tool.roman_dropdown.hidden, false, 'expected focus on the list\'s own field to keep it open')

		dare_input.focus()
		assert.equal(document.activeElement, dare_input, 'expected DARE focused — else no focusin happened')
		assert.equal(tool.roman_dropdown.hidden, true, 'expected focus moving to another field to close the list')
	})

	it('opening the panel focuses the first ENABLED field', async function() {

		require_document_focus()
		// only DARE needs no local data: with none, Pleiades and Pelagios are disabled
		mount_roman()
		await load_roman_capabilities(tool)
		const control = geolocation.map.getContainer().querySelector('.uca-maps-roman-control')
		control.click()
		assert.equal(
			document.activeElement,
			tool.roman_panel.querySelector('.uca-maps-roman-dare .uca-maps-roman-input'),
			'expected the focus on DARE, the only enabled field'
		)
		control.click() // close

		// control half: with Pleiades available, it is the first field
		tool._roman_gazetteers = { configured: true, pleiades: true, pelagios: [] }
		refresh_roman_sources(tool, tool.roman_panel)
		control.click()
		assert.equal(
			document.activeElement,
			tool.roman_panel.querySelector('.uca-maps-roman-pleiades .uca-maps-roman-input'),
			'expected the focus on Pleiades, the first field'
		)
	})

	// the list is owned from the moment a field ARMS a search, so going elsewhere
	// cancels it waiting, in flight or open
	it('leaving the field cancels its search, whether waiting or in flight', async function() {

		require_document_focus()
		mount_roman(WITH_PLEIADES)
		await load_roman_capabilities(tool)
		open_roman()

		const panel				= tool.roman_panel
		const pleiades_input	= panel.querySelector('.uca-maps-roman-pleiades .uca-maps-roman-input')
		const dare_input		= panel.querySelector('.uca-maps-roman-dare .uca-maps-roman-input')
		let asked = 0
		let release = null
		stub_tool_request(function() {
			asked++
			return new Promise((resolve) => { release = () => resolve({ ok: true, data: { results: [{ name: 'Roma', id: '423025' }] } }) })
		})
		const type_roma = () => {
			pleiades_input.value = 'Roma'
			pleiades_input.dispatchEvent(new Event('input'))
		}

		// waiting out the debounce, then Tab into DARE
		type_roma()
		dare_input.focus()
		await tick(AFTER_DEBOUNCE_MS)
		assert.equal(asked, 0, 'expected Tab away to cancel the waiting search')

		// waiting, then a click in DARE
		type_roma()
		dare_input.dispatchEvent(new MouseEvent('mousedown', {bubbles: true}))
		await tick(AFTER_DEBOUNCE_MS)
		assert.equal(asked, 0, 'expected a click away to cancel the waiting search')

		// in flight, then Tab into DARE
		pleiades_input.focus()
		type_roma()
		await tick(AFTER_DEBOUNCE_MS)
		assert.equal(asked, 1, 'expected the search sent — else the next check proves nothing')
		dare_input.focus()
		release()
		await tick(SETTLE_MS)
		assert.equal(tool.roman_dropdown.hidden, true, 'expected no Pleiades list under a field the user left')
	})

	it('pressing the panel\'s scrollbar keeps the list; pressing a control closes it', function() {

		mount_roman()
		open_roman()
		const panel = tool.roman_panel
		seed_roman_list('dare', [roman_hit('Gades', 36.5, -6.2)])
		assert.equal(tool.roman_dropdown.hidden, false)

		// Chrome targets the scrolling element itself when its scrollbar is pressed
		panel.dispatchEvent(new MouseEvent('mousedown', {bubbles: true}))
		assert.equal(tool.roman_dropdown.hidden, false, 'expected the scrollbar press to leave the list to the scroll')

		panel.querySelector('.uca-maps-roman-dare-filters select').dispatchEvent(new MouseEvent('mousedown', {bubbles: true}))
		assert.equal(tool.roman_dropdown.hidden, true, 'expected a press on a filter to close it')
	})

	it('a late answer never opens the list under a field scrolled out of view', async function() {

		mount_roman(WITH_PLEIADES)
		await load_roman_capabilities(tool)
		open_roman()
		const panel = tool.roman_panel
		make_panel_scrollable(panel)

		const input = panel.querySelector('.uca-maps-roman-pleiades .uca-maps-roman-input')
		let release = null
		stub_tool_request(function() {
			return new Promise((resolve) => { release = () => resolve({ ok: true, data: { results: [{ name: 'Roma', id: '423025' }] } }) })
		})
		const search_roma = async () => {
			release = null
			input.value = 'Roma'
			input.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', bubbles: true}))
			await until(() => release!==null)
			assert.isNotNull(release, 'expected the search sent')
		}

		// control half: the field in view, the answer opens the list
		await search_roma()
		release()
		await tick(SETTLE_MS)
		assert.equal(tool.roman_dropdown.hidden, false, 'expected the list open under a field in view')
		tool.close_roman_suggestions()

		await search_roma()
		panel.scrollTop = panel.scrollHeight // Pleiades, the first source, leaves the view
		assert.isBelow(input.getBoundingClientRect().top, panel.getBoundingClientRect().top + 1, 'expected the field scrolled out of view — else this gate proves nothing')
		// let that scroll's event pass FIRST: dispatched after the answer, it would
		// close the list on its own and this gate would never see the open-time check
		await two_frames()
		release()
		await tick(SETTLE_MS)
		assert.equal(tool.roman_dropdown.hidden, true, 'expected no list under a field out of view')
	})

	it('a source that turns out unavailable takes its open list with it', async function() {

		mount_roman(WITH_PLEIADES)
		await load_roman_capabilities(tool)
		open_roman()
		const seed_pleiades = () => {
			seed_roman_list('pleiades', [{ name: 'Roma', id: '423025' }])
			assert.equal(tool.roman_dropdown.hidden, false)
		}

		// control half: still available, the list stays
		seed_pleiades()
		refresh_roman_sources(tool, tool.roman_panel)
		assert.equal(tool.roman_dropdown.hidden, false, 'expected the list kept while its source is available')

		tool._roman_gazetteers = { configured: false, pleiades: false, pelagios: [] }
		refresh_roman_sources(tool, tool.roman_panel)
		assert.equal(tool.roman_dropdown.hidden, true, 'expected the list closed')
		assert.equal(tool._roman_results, null, 'expected the hits forgotten')
		assert.equal(tool._roman_source, null, 'expected no owner left')
	})

	it('a Pleiades error lands under Pleiades even after DARE took the list', async function() {

		mount_roman(WITH_PLEIADES)
		await load_roman_capabilities(tool)
		open_roman()
		const panel = tool.roman_panel

		let release = null
		stub_tool_request(function(options) {
			if (options.action==='search_dare') {
				return Promise.resolve({ ok: true, data: { results: [] } })
			}
			return new Promise((resolve) => { release = () => resolve({ ok: true, data: { place: null } }) })
		})
		seed_roman_list('pleiades', [{ name: 'Roma', id: '423025' }])
		tool.roman_dropdown.querySelector('.uca-maps-roman-result-button')
			.dispatchEvent(new MouseEvent('mousedown', {bubbles: true, cancelable: true}))
		assert.isFunction(release, 'expected the Pleiades geometry request in flight')

		await search_roman(tool, 'dare', { query: 'Gades', name_type: 'mss' })
		assert.equal(tool._roman_source, 'dare', 'expected DARE to own the list now')

		release()
		await tick(SETTLE_MS)
		assert.equal(panel.querySelector('.uca-maps-roman-pleiades .uca-maps-roman-message').hidden, false, 'expected the error under Pleiades')
		assert.equal(panel.querySelector('.uca-maps-roman-dare .uca-maps-roman-message').hidden, true, 'expected nothing under DARE')
	})

	// with the list open, Tab walks the list instead of closing it and wandering
	// off through the panel
	it('with its list open, Tab walks from the field into the list and through it', async function() {

		require_document_focus()
		mount_roman(WITH_PLEIADES)
		await load_roman_capabilities(tool)
		open_roman()

		const panel	= tool.roman_panel
		const input	= panel.querySelector('.uca-maps-roman-dare .uca-maps-roman-input')
		const key	= (target, name, shift) => {
			const event = new KeyboardEvent('keydown', {key: name, shiftKey: Boolean(shift), bubbles: true, cancelable: true})
			target.dispatchEvent(event)
			return event
		}
		const seed = () => {
			seed_roman_list('dare', [
				roman_hit('Gades', 36.5, -6.2),
				roman_hit('Gadir', 36.6, -6.3)
			])
			input.focus()
		}

		// control half: no list, Tab is the browser's own
		input.focus()
		assert.isFalse(key(input, 'Tab').defaultPrevented, 'expected Tab left alone with no list open')

		seed()
		const rows = tool.roman_dropdown.querySelectorAll('.uca-maps-roman-result-button')
		assert.isTrue(key(input, 'Tab').defaultPrevented)
		assert.equal(document.activeElement, rows[0], 'expected Tab from the field onto the first row')
		assert.equal(tool._roman_active_index, 0, 'expected the focused row to be the highlighted one')

		key(rows[0], 'Tab')
		assert.equal(document.activeElement, rows[1], 'expected Tab to the next row')
		key(rows[1], 'Tab', true)
		assert.equal(document.activeElement, rows[0], 'expected Shift+Tab back one row')
		key(rows[0], 'Tab', true)
		assert.equal(document.activeElement, input, 'expected Shift+Tab on the first row back to the field')
		assert.equal(tool.roman_dropdown.hidden, false, 'expected the list open all along')

		// past the last row: the list closes, the focus goes on after the field
		key(input, 'Tab')
		key(rows[0], 'ArrowDown')
		assert.equal(document.activeElement, rows[1], 'expected ↓ to walk the focused rows too')
		key(rows[1], 'Tab')
		assert.equal(tool.roman_dropdown.hidden, true, 'expected Tab past the last row to close the list')
		assert.equal(
			document.activeElement,
			panel.querySelector('.uca-maps-roman-dare-filters select'),
			'expected the focus on the control right after the field'
		)

		// Esc in a row: closed, back in the field
		seed() // rebuilds the rows: query them again
		key(input, 'Tab')
		key(tool.roman_dropdown.querySelector('.uca-maps-roman-result-button'), 'Escape')
		assert.equal(tool.roman_dropdown.hidden, true, 'expected Esc to close the list')
		assert.equal(document.activeElement, input, 'expected Esc to hand the focus back to the field')

		// Enter in a row draws it and hands the focus back to the field
		seed()
		const feature_group	= active_group()
		const before		= feature_group.getLayers().length
		key(input, 'Tab')
		const fresh_rows = tool.roman_dropdown.querySelectorAll('.uca-maps-roman-result-button')
		key(fresh_rows[0], 'Enter')
		await until(() => feature_group.getLayers().length===before + 1)
		assert.equal(feature_group.getLayers().length, before + 1, 'expected Enter on the focused row to draw it')
		assert.equal(tool.roman_dropdown.hidden, true)
		assert.equal(document.activeElement, input, 'expected the focus back in the field, not lost on <body>')
	})

	it('walking the list by keyboard freezes it: no waiting or in-flight search rebuilds it', async function() {

		require_document_focus()
		mount_roman()
		open_roman()
		const panel	= tool.roman_panel
		const input	= panel.querySelector('.uca-maps-roman-dare .uca-maps-roman-input')
		const tab	= (target) => target.dispatchEvent(new KeyboardEvent('keydown', {key: 'Tab', bubbles: true, cancelable: true}))

		let asked = 0
		let release = null
		stub_tool_request(function() {
			asked++
			return new Promise((resolve) => { release = () => resolve({ ok: true, data: { results: [
				roman_hit('NEW', 0, 0)
			] } }) })
		})
		const seed = () => {
			seed_roman_list('dare', [roman_hit('Gades', 36.5, -6.2)])
			input.focus()
		}

		// a keystroke still waiting out the debounce, then Tab into the list
		seed()
		input.value = 'Gadesx'
		input.dispatchEvent(new Event('input'))
		tab(input)
		const row = document.activeElement
		assert.isTrue(row.classList.contains('uca-maps-roman-result-button'), 'expected the focus on a row')
		await tick(AFTER_DEBOUNCE_MS)
		assert.equal(asked, 0, 'expected the waiting search cancelled by entering the list')
		assert.equal(document.activeElement, row, 'expected the focus still on its row')

		// a search already in flight, then Tab into the list
		seed()
		input.value = 'Gadesy'
		input.dispatchEvent(new Event('input'))
		await tick(AFTER_DEBOUNCE_MS)
		assert.equal(asked, 1, 'expected the search in flight — else the next check proves nothing')
		tab(input)
		const held = document.activeElement
		release()
		await tick(SETTLE_MS)
		assert.isTrue(document.contains(held), 'expected the focused row not rebuilt by the late answer')
		assert.equal(document.activeElement, held, 'expected the focus kept, not dropped to <body>')
		assert.notInclude(tool.roman_dropdown.textContent, 'NEW', 'expected the late hits discarded')
	})

	// the capability answer can land with the panel already open: disabling the
	// focused field must not drop the focus to <body>, nor move it when the
	// focused control stays usable
	it('a capability answer that disables the focused field moves the focus to the first usable one', async function() {

		require_document_focus()
		let answer = null
		tool.get_capabilities = function() { return new Promise((resolve) => { answer = resolve }) }
		tool.attach_roman_empire()
		open_roman()
		const panel		= tool.roman_panel
		const pleiades	= panel.querySelector('.uca-maps-roman-pleiades .uca-maps-roman-input')
		assert.equal(document.activeElement, pleiades, 'expected the panel opened on Pleiades — else the answer disables nothing focused')

		answer({ ok: true, data: { gazetteers: { configured: false, pleiades: false, pelagios: [] } } })
		await tick()

		assert.isTrue(pleiades.disabled, 'expected Pleiades disabled by the answer')
		assert.equal(
			document.activeElement,
			panel.querySelector('.uca-maps-roman-dare .uca-maps-roman-input'),
			'expected the focus on DARE, the first field still usable, not on <body>'
		)
	})

	it('a capability answer leaves alone a focused control that stays usable', async function() {

		require_document_focus()
		let answer = null
		tool.get_capabilities = function() { return new Promise((resolve) => { answer = resolve }) }
		tool.attach_roman_empire()
		open_roman()
		const select = tool.roman_panel.querySelector('.uca-maps-roman-dare-filters select')
		select.focus()
		assert.equal(document.activeElement, select)

		answer({ ok: true, data: { gazetteers: { configured: false, pleiades: false, pelagios: [] } } })
		await tick()

		assert.isTrue(tool.roman_panel.querySelector('.uca-maps-roman-pleiades .uca-maps-roman-input').disabled, 'expected the answer applied')
		assert.equal(document.activeElement, select, 'expected the focus kept on the DARE filter')
	})

	it('whatever closes the list, a focused row hands the focus back to its field', async function() {

		require_document_focus()
		mount_roman(WITH_PLEIADES)
		await load_roman_capabilities(tool)
		open_roman()
		const panel = tool.roman_panel
		make_panel_scrollable(panel)
		const dare = panel.querySelector('.uca-maps-roman-dare .uca-maps-roman-input')
		const focus_a_row = (source) => {
			seed_roman_list(source, [roman_hit('Gades', 36.5, -6.2)])
			const row = tool.roman_dropdown.querySelector('.uca-maps-roman-result-button')
			row.focus()
			assert.equal(document.activeElement, row, 'expected a row focused — else nothing below is lost')
		}

		// the panel's scroll takes the field out of view: the focus goes back
		// to it WITHOUT scrolling the panel back, which would undo the user's scroll
		panel.scrollTop += dare.getBoundingClientRect().top - panel.getBoundingClientRect().top - panel.clientHeight / 2
		focus_a_row('dare')
		panel.scrollTop = 0 // DARE is the last source: its field is now below the view
		panel.dispatchEvent(new Event('scroll'))
		assert.equal(tool.roman_dropdown.hidden, true, 'expected the scroll to close the list')
		assert.equal(document.activeElement, dare, 'expected the focus back in DARE, not on <body>')
		assert.equal(panel.scrollTop, 0, 'expected the user\'s scroll kept')

		// the owning source turns unavailable: its field is disabled, so the
		// focus goes on to the first usable one
		focus_a_row('pleiades')
		tool._roman_gazetteers = { configured: false, pleiades: false, pelagios: [] }
		refresh_roman_sources(tool, panel)
		assert.equal(tool.roman_dropdown.hidden, true, 'expected the unavailable source\'s list closed')
		assert.equal(document.activeElement, dare, 'expected the focus on DARE, not on <body>')
	})

	it('Tab past the last row enters a radio group at its CHECKED radio', async function() {

		require_document_focus()
		mount_roman(WITH_PLEIADES)
		await load_roman_capabilities(tool)
		open_roman()
		const panel		= tool.roman_panel
		const input		= panel.querySelector('.uca-maps-roman-pleiades .uca-maps-roman-input')
		const by_id		= panel.querySelector('.uca-maps-roman-pleiades-type input[value="id"]')
		by_id.checked = true

		seed_roman_list('pleiades', [{ name: 'Roma', id: '423025' }])
		input.focus()
		input.dispatchEvent(new KeyboardEvent('keydown', {key: 'Tab', bubbles: true, cancelable: true}))
		document.activeElement.dispatchEvent(new KeyboardEvent('keydown', {key: 'Tab', bubbles: true, cancelable: true}))

		assert.equal(document.activeElement, by_id, 'expected the checked "by id" radio, as native Tab would')
		assert.isTrue(by_id.checked, 'expected the search type untouched')
	})

	it('while the keyboard is in the list, the pointer moves the focus with the highlight', async function() {

		require_document_focus()
		mount_roman()
		open_roman()
		const panel	= tool.roman_panel
		const input	= panel.querySelector('.uca-maps-roman-dare .uca-maps-roman-input')
		seed_roman_list('dare', [
			roman_hit('Gades', 36.5, -6.2),
			roman_hit('Gadir', 36.6, -6.3),
			roman_hit('Gadara', 32.6, 35.7)
		])
		const rows = tool.roman_dropdown.querySelectorAll('.uca-maps-roman-result-button')

		// control half: typing in the field, hovering only highlights
		input.focus()
		rows[1].dispatchEvent(new MouseEvent('mouseenter'))
		assert.equal(document.activeElement, input, 'expected the field to keep the focus while typing')
		assert.equal(tool._roman_active_index, 1)

		// ↓ twice in the field, then Tab: onto the row ALREADY highlighted
		tool._roman_active_index = -1
		input.dispatchEvent(new KeyboardEvent('keydown', {key: 'ArrowDown', bubbles: true}))
		input.dispatchEvent(new KeyboardEvent('keydown', {key: 'ArrowDown', bubbles: true}))
		assert.equal(tool._roman_active_index, 1)
		input.dispatchEvent(new KeyboardEvent('keydown', {key: 'Tab', bubbles: true, cancelable: true}))
		assert.equal(document.activeElement, rows[1], 'expected Tab onto the highlighted row, not the first')

		rows[2].dispatchEvent(new MouseEvent('mouseenter'))
		assert.equal(document.activeElement, rows[2], 'expected the hovered row to take the focus')
		assert.equal(tool._roman_active_index, 2, 'expected the highlight on the focused row')
		assert.isTrue(rows[2].classList.contains('is-active'))
	})
})


// @license-end
