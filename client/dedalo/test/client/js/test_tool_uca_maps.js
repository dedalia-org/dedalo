// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global it, describe, assert, L, turf, DEDALO_MEDIA_URL */
/*eslint no-undef: "error"*/
'use strict';

/**
 * TEST_TOOL_UCA_MAPS
 * STRUCTURAL: pure exports and the constructor. LIVE MAP (tool_uca_maps_fixture.js): the object
 * console, the tool's lifecycle, and the toolbar with its CSS. The other feature groups are the
 * test_tool_uca_maps_* suites; the server actions are test/unit/tool_uca_maps_*.
 */

import { resolve_error_policy } from '../../../core/common/js/error_policy.js'
import { error_text } from '../../../core/common/js/render_api_error.js'
import { IMAGE_COMPONENT_TIPO, IMAGE_SECTION_TIPO } from '../../../tools/tool_uca_maps/js/image_upload.js'
import {
	ALLOWED_ICON_TYPES,
	empty_legend,
	MAX_ICON_BYTES
} from '../../../tools/tool_uca_maps/js/legend.js'
import { download_map_image } from '../../../tools/tool_uca_maps/js/map_image_download.js'
import {
	computed_property_keys,
	delete_property,
	download_object_pdf,
	download_vector,
	find_layer_id,
	format_polygon_area,
	RESERVED_PROPERTY_KEYS,
	set_hierarchy,
	set_property,
	set_style_field,
	toggle_centroid,
	toggle_uncertainty
} from '../../../tools/tool_uca_maps/js/object_console.js'
import { fetch_elevation, layer_center } from '../../../tools/tool_uca_maps/js/object_elevation.js'
import {
	associate_image,
	external_images_enabled,
	import_linked_images,
	linked_images,
	MAX_OBJECT_IMAGES,
	object_image_url,
	object_images,
	remove_object_image
} from '../../../tools/tool_uca_maps/js/object_image.js'
import { create_onexone_rectangle, is_onexone_enabled } from '../../../tools/tool_uca_maps/js/onexone.js'
import { exception_text, upload_refusal_text } from '../../../tools/tool_uca_maps/js/panel_error_text.js'
import { format_distance, round_distance } from '../../../tools/tool_uca_maps/js/scale_bar.js'
import { tool_uca_maps } from '../../../tools/tool_uca_maps/js/tool_uca_maps.js'
import { create_toolbar_panel, remove_toolbar_panel } from '../../../tools/tool_uca_maps/js/toolbar.js'
import { parse_wms_capabilities_xml } from '../../../tools/tool_uca_maps/js/wms_services.js'
import { detach_xyz_basemaps } from '../../../tools/tool_uca_maps/js/xyz_basemaps.js'
import {
	capture_download,
	layer_by_uid,
	picked_colour,
	resolve_token,
	roman_hit,
	staged_answer,
	stub_image_download,
	tick,
	toasts_during,
	tool_sheet,
	two_frames,
	until,
	use_live_map,
	WITH_PLEIADES,
	with_tool_css
} from './tool_uca_maps_fixture.js'



/**
* Runs `fn` with the tool sheet's phone rules applied at the suite's desktop
* width, where the phone @media never matches: the rules inside it whose
* selector names `selector_part` are lifted out of the loaded sheet and applied
* unconditionally. Call inside with_tool_css.
* @returns {Promise<*>}
*/
const with_phone_rules = async function(selector_part, fn) {
	const sheet = tool_sheet()
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
* Runs `fn` with the WHOLE tool sheet re-applied, in its own order, its phone
* @media made unconditional: unlike with_phone_rules, a later desktop rule still
* beats an earlier phone one, so a cascade-order bug shows. Call inside with_tool_css.
* @returns {Promise<*>}
*/
const with_phone_cascade = async function(fn) {
	const sheet = tool_sheet()
	const unwrap = (rule) => (rule instanceof CSSMediaRule && /max-width:\s*600px/.test(rule.conditionText))
		? [...rule.cssRules].map(unwrap).join('\n')
		: rule.cssText
	const style = document.createElement('style')
	style.textContent = [...sheet.cssRules].map(unwrap).join('\n')
	document.head.appendChild(style)
	try {
		return await fn()
	} finally {
		style.remove()
	}
}

/** An object's gallery already at the cap. */
const full_gallery = () => ({ images: Array.from(
	{length: MAX_OBJECT_IMAGES},
	(value, index) => ({file_path: '/' + index + '.jpg', section_tipo:'test3', section_id:index, tipo:'test99', name:null})
) })

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



describe('TOOL_UCA_MAPS (structural)', function() {

	this.timeout(10000)

	it('a new instance starts unattached and idle, and the prototype carries what no other test calls', function() {

		// what the attach_* guards and destroy() read: an attach that sees a
		// stale value skips its work, a detach that sees one undoes another's
		const instance = new tool_uca_maps()
		const initial = {
			geolocation						: null,
			map_ready						: false,
			console_control					: null,
			_popupopen_handler				: null,
			_popupclose_handler				: null,
			_click_handler					: null,
			_catastro_busy					: false,
			_catastro_credit				: null,
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

		// wire_tool's delegates and members other tests reach only indirectly
		for (const name of ['render', 'refresh', 'init', 'build', 'close_transient_modal', 'clear_roman_search']) {
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

	// the editor holds the record's own names (title, groups), plus the overlay's
	// shown flag the record never carries
	it('empty_legend seeds an empty legend in the record\'s names, shown', function() {

		assert.deepEqual(empty_legend(), {title: '', enable: true, groups: []})

		assert.deepEqual(
			ALLOWED_ICON_TYPES,
			['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml'],
			'expected v6\'s own accepted icon types'
		)
		assert.equal(MAX_ICON_BYTES, 2000000, 'expected v6\'s own 2 MB ceiling')
	})

	it('upload_refusal_text: an upload refusal is the panel\'s lead, then the receiver\'s reason', function() {

		// the upload transport publishes no page notice, so this line is the only one
		const refusal = {is_api_error: true, code: 'media.upload_rejected', label_key: 'x', message: 'File content verification failed: not a JPEG — rejected'}
		assert.equal(upload_refusal_text(refusal, 'The image could not be loaded.'), 'The image could not be loaded.\n' + refusal.message)
	})

	it('upload_refusal_text: any other code, or a refusal with no reason, is core\'s error_text', function() {

		const other = {
			is_api_error	: true,
			code			: 'request.invalid_options',
			label_key		: 'error_request_invalid_options',
			message			: 'Invalid request options'
		}
		const bare = {
			is_api_error	: true,
			code			: 'media.upload_rejected',
			label_key		: 'error_media_upload_rejected',
			message			: '  '
		}

		for (const api_error of [other, bare]) {
			const text = upload_refusal_text(api_error, 'LEAD')
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
			{name: 'topo:layer2', title: 'Layer Two', crs: 'EPSG:3857'},
			{name: 'topo:layer3', title: 'topo:layer3', crs: 'EPSG:3857'},
			{name: 'topo:layer4', title: 'Layer Four', crs: 'EPSG:3857'}
		], 'expected queryable="0" kept: the attribute counts, not its value')
		assert.equal(result.version, '1.3.0', 'expected the service\'s own version')
	})

	// the CRS a layer is saved with: the map's own when offered, a geographic one
	// otherwise, inherited from the parents, and null when none can be drawn
	it('parse_wms_capabilities_xml gives each layer the CRS it is saved with, inherited from its parents', function() {

		const xml = `<?xml version="1.0" encoding="UTF-8"?>
			<WMT_MS_Capabilities version="1.1.1">
				<Capability>
					<Layer>
						<SRS>EPSG:25830 EPSG:4326</SRS>
						<Layer queryable="1"><Name>a</Name><SRS>EPSG:3857</SRS></Layer>
						<Layer queryable="1"><Name>b</Name></Layer>
					</Layer>
					<Layer>
						<SRS>EPSG:25830</SRS>
						<Layer queryable="1"><Name>c</Name><SRS>EPSG:4258</SRS></Layer>
						<Layer queryable="1"><Name>d</Name></Layer>
					</Layer>
				</Capability>
			</WMT_MS_Capabilities>`

		const result = parse_wms_capabilities_xml(xml)

		assert.equal(result.version, '1.1.1')
		assert.deepEqual(result.layers.map((layer) => [layer.name, layer.crs]), [
			['a', 'EPSG:3857'], ['b', 'EPSG:4326'], ['c', 'EPSG:4258'], ['d', null]
		])
		assert.equal(parse_wms_capabilities_xml(xml.replace('version="1.1.1"', 'version="1.0.0"')).version, '1.1.1', 'expected an unknown version saved as 1.1.1')
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
		assert.deepEqual(result.layers, [{name: 'topo:child2', title: 'Child Two', crs: 'EPSG:3857'}], 'expected only the real leaf, never a bogus entry for the unnamed group')
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



describe('TOOL_UCA_MAPS (live map)', function() {

	this.timeout(20000)

	let geolocation, tool
	const {
		offer_catastro,
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
		requests_sent_by
	} = use_live_map((mounted) => ({geolocation, tool} = mounted))

	/** A square ring of `side_deg` degrees, the polygon a reshape test sets. */
	const square = (side_deg) => [[40.45, -3.655], [40.45, -3.655 + side_deg], [40.45 + side_deg, -3.655 + side_deg], [40.45 + side_deg, -3.655]]

	// what edit() reads of a tool that went through init()
	const run_edit = function() {
		tool.type		= 'tool'
		tool.mode		= 'edit'
		tool.context	= { label: 'Mapas UCA' }
		return tool.edit({})
	}



	it('attach_console adds exactly one control and one hidden panel, idempotently', function() {

		tool.attach_console()
		tool.attach_console() // second call: must be a no-op, never a duplicate

		const controls = geolocation.map.getContainer().querySelectorAll('.uca-maps-control')
		assert.equal(controls.length, 1, 'expected exactly one map control')
		assert.isOk(tool.console_panel, 'expected console_panel built')
		assert.equal(tool.console_panel.hidden, true, 'expected panel hidden by default')
		assert.equal(
			geolocation.map.getContainer().contains(tool.console_panel), true,
			'expected the panel appended to the map\'s own DOM container'
		)
	})

	it('the control toggles panel visibility (Show/Hide)', function() {

		tool.attach_console()
		const control = geolocation.map.getContainer().querySelector('.uca-maps-control')

		control.click()
		assert.equal(tool.console_panel.hidden, false, 'expected panel shown after one click')

		control.click()
		assert.equal(tool.console_panel.hidden, true, 'expected panel hidden again after a second click')
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

	// an associated image is stored as a media-relative path: v6 stores an
	// absolute URL, which breaks on a host change
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
			assert.equal(seen.stages[0].retries, 1, 'expected the stage sent once: a resend of its retryable refusal would read outcome_unknown')

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
			const before = tool.console_panel.querySelector('.uca-maps-object-linked-import')
			assert.isOk(before, 'expected the import button')

			before.click()
			await until(() => !before.isConnected, 100, 0)
			assert.isFalse(before.isConnected, 'expected the commit to re-render the console')
			await tick()

			const lines = [...tool.console_panel.querySelectorAll('.uca-maps-object-linked-failure')]
			assert.equal(lines.length, 1, 'expected the failed link listed in the new panel')
			assert.include(lines[0].textContent, refused.url, 'expected the failure to name its link')
			assert.include(tool.console_panel.querySelector('.uca-maps-object-linked-import').textContent, '1',
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

		const button = () => tool.console_panel.querySelector('.uca-maps-object-linked-import')
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

	// core's page notice says why, once and translated (details.reason_key):
	// the download's own line stays empty rather than repeat it
	it('a refused download leaves its line to core\'s notice', async function() {

		const layer		= seeded_layer(1)
		const refusal	= {is_api_error: true, code: 'request.invalid_options', details: {reason_key: 'file_name_unusable'}, message: 'The file name has no usable characters.', transport: false}

		stub_tool_request(async function() {
			return {ok: false, error: refusal}
		})
		const rows = [
			{label: 'vector', run: () => download_vector(tool, layer, 'shp')},
			{label: 'pdf', run: () => download_object_pdf(tool, layer)},
			{label: 'map image', run: () => download_map_image(tool, 'jpg')}
		]
		for (const row of rows) {
			assert.deepEqual(await row.run(), {ok: false}, row.label)
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
		const object_section = () => tool.console_panel.querySelector('.uca-maps-object-section')

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
				box		: () => tool.console_panel.querySelector('.uca-maps-image-download-section'),
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

		stub_tool_request(async function() {
			throw new Error('Boom.')
		})
		const restore_image_download = stub_image_download(async () => { throw new Error('Boom.') })
		try {
			// no envelope ever reached data_manager, so nothing else toasts it
			await toasts_during(async (toasts) => {
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
			})
		} finally {
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
		const heading = () => tool.console_panel.querySelector('.uca-maps-object-section .uca-maps-object-type').textContent
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
		assert.equal(tool.console_panel.hidden, true, 'expected the panel to stay closed when a geometry is selected')
		assert.isOk(
			tool.console_panel.querySelector('.uca-maps-object-section').textContent.includes('Polygon'),
			'expected the object section to name the geometry type'
		)

		// and the content keeps tracking the selection while it IS open
		// (`console_control` is the L.Control; the clickable node is its container)
		geolocation.map.getContainer().querySelector('.uca-maps-control').click()
		assert.equal(tool.console_panel.hidden, false, 'expected the UCA button to open it')
		seeded_layer(3).openPopup()
		assert.equal(tool.console_panel.hidden, false, 'expected a selection not to close an open panel either')
	})

	it('on_close_actions keeps the console alive; on_geolocation_destroyed is the real teardown', async function() {

		tool.attach_console()
		assert.equal(
			geolocation.map.getContainer().querySelectorAll('.uca-maps-control').length, 1,
			'expected the control attached'
		)

		// the tool's own modal closing must NOT tear the console down (tool_uca_maps.js on_close_actions)
		tool.on_close_actions()
		assert.equal(
			geolocation.map.getContainer().querySelectorAll('.uca-maps-control').length, 1,
			'expected the control to survive on_close_actions'
		)
		assert.isOk(tool.geolocation, 'expected the geolocation reference to survive on_close_actions')
		assert.isOk(tool.console_panel, 'expected console_panel to survive on_close_actions')

		// component_geolocation itself being torn down IS the real teardown trigger
		const map_container_node = geolocation.map.getContainer()
		await tool.on_geolocation_destroyed()

		assert.equal(
			map_container_node.querySelectorAll('.uca-maps-control').length, 0,
			'expected the control removed by real teardown'
		)
		assert.equal(tool.geolocation, null, 'expected the geolocation reference cleared')
		assert.equal(tool.console_panel, null, 'expected console_panel cleared')
		assert.equal(tool.console_control, null, 'expected console_control cleared')
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

	/**
	* Destroys the map component as core does, the map dropped BEFORE its destroy
	* event is announced, and waits for the tool teardown that event starts: every
	* detach_* runs against a map that is already gone.
	*/
	const destroy_map_component = async function() {
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
	}//end destroy_map_component

	it('destroying the map component tears the tool down through its event, with the map already gone', async function() {

		await run_edit()
		assert.isOk(tool.console_control, 'precondition: edit() attached the console')

		await destroy_map_component()

		assert.equal(tool.status, 'destroyed', 'expected the tool instance destroyed')
		assert.isNull(tool.geolocation, 'expected the geolocation reference cleared')
		for (const key of [
			'console_control', 'console_panel', 'map_image_control', 'object_viewer_control', 'onexone_control',
			'xyz_control', 'wms_control', 'catastro_control', 'ua_control', 'upload_control',
			'place_search_control', 'geolocate_control', 'scale_control', 'legend_control', 'roman_control',
			'_toolbar_bar'
		]) {
			assert.isNull(tool[key], 'expected ' + key + ' released')
		}
	})

	// with the map gone a detach cannot disarm: only reset_armed_layer_state drops
	// what the armed layer left on the tool. `set` are the slots arming fills here
	for (const armed of [
		{key: 'ua', control: 'ua_control', set: ['click_handler', 'tile_layer']},
		{key: 'catastro', control: 'catastro_control', set: ['click_handler', 'tile_layer', 'core_source', 'attribution']}
	]) {
		it(`destroying the map component with ${armed.key} armed leaves none of its armed-layer state on the tool`, async function() {

			geolocation.section_lang = 'lg-spa' // gates Catastro and UA in
			offer_catastro()
			await run_edit()
			tool[armed.control].getContainer().click() // arm
			assert.equal(tool._armed_layer && tool._armed_layer.key, armed.key, 'precondition: ' + armed.key + ' armed')
			for (const name of armed.set) {
				assert.isOk(tool[`_${armed.key}_${name}`], 'precondition: arming set _' + armed.key + '_' + name)
			}

			await destroy_map_component()

			// only the slots the precondition saw filled: asserting one that never
			// left its initial value could not fail
			assert.isNull(tool._armed_layer, 'expected nothing left armed')
			for (const name of armed.set) {
				assert.isNull(tool[`_${armed.key}_${name}`], 'expected _' + armed.key + '_' + name + ' released')
			}
		})
	}



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
		const badge	= tool.console_panel.querySelector('.uca-maps-object-section .uca-maps-uncertainty-badge')
		const area	= format_polygon_area(polygon.feature.properties.uca_maps.uncertainty.area_m2)
		assert.isOk(badge, 'expected the badge beside the checked box')
		assert.isTrue(badge.textContent.endsWith(' — ' + area), 'expected the badge to end with "' + area + '", got "' + badge.textContent + '"')
		assert.equal(
			tool.console_panel.querySelector('.uca-maps-object-section .uca-maps-uncertainty-scale').getAttribute('title'), area,
			'expected the scale\'s title to carry the same area'
		)
	})

	it('the uncertainty scale rings the polygon\'s own tier on any polygon, not only a 1x1\'s tier 1', function() {

		tool.attach_console()
		const polygon = seeded_layer(1)
		toggle_uncertainty(tool, polygon)
		const ring_cx = () => tool.console_panel.querySelector('.uca-maps-object-section .uca-maps-uncertainty-scale svg circle').getAttribute('cx')

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

		const section = tool.console_panel.querySelector('.uca-maps-object-section')

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

		const controls = tool.console_panel.querySelector('.uca-maps-style-controls')

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
		const color = tool.console_panel.querySelector('.uca-maps-style-color')
		assert.isOk(color, 'expected a single colour field (v6 polygon_circle_style)')
		assert.equal(color.type, 'color')
		assert.isNotOk(
			tool.console_panel.querySelector('.uca-maps-style-stroke-color'),
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
			tool.console_panel.querySelectorAll('.uca-maps-properties-list .uca-maps-property-item'),
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
		const add_row = tool.console_panel.querySelector('.uca-maps-property-add')
		const message = tool.console_panel.querySelector('.uca-maps-property-add-message')
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
			const reference = tool.console_panel.querySelector('.uca-maps-object-section .uca-maps-empty-state')
			assert.isOk(reference, 'expected the console\'s own placeholder to compare with')
			// read now: selecting an object below replaces the placeholder
			const reference_look = look(reference)
			assert.include(reference_look, 'italic', 'expected the reference itself styled')

			open_console_on(1)
			const gallery_empty = tool.console_panel.querySelector('.uca-maps-object-gallery-empty')

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

		const images = tool.console_panel.querySelector('.uca-maps-object-images')
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

		const picker = tool.console_panel.querySelector('.uca-maps-object-image-file')

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
		const box = () => tool.console_panel.querySelector('.uca-maps-geoman input')
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
		const section = tool.console_panel.querySelector('.uca-maps-object-section')
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
		const section = tool.console_panel.querySelector('.uca-maps-object-section')
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
			offer_catastro()
			assert.isNotOk(geolocation.map.getContainer().querySelector('.uca-maps-toolbar-button'), 'expected no button before edit() runs')
			await run_edit()

			const corner = tool.console_control.getContainer().closest('.leaflet-top.leaflet-left')
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
		assert.equal(tool.console_panel.hidden, false, 'expected UCA open after its own click')

		img_control.click()
		assert.equal(tool.map_image_panel.hidden, false, 'expected IMG open after its own click')
		assert.equal(tool.console_panel.hidden, true, 'expected UCA closed by opening IMG')

		obj_control.click()
		assert.equal(tool.object_viewer_panel.hidden, false, 'expected OBJ open after its own click')
		assert.equal(tool.map_image_panel.hidden, true, 'expected IMG closed by opening OBJ')
		assert.equal(tool.console_panel.hidden, true, 'expected UCA to stay closed')

		// a sibling closed UCA: its own button still reopens it, since the
		// toggle reads the panel's `hidden`, never a flag of its own
		uca_control.click()
		assert.equal(tool.console_panel.hidden, false, 'expected UCA reopened by its own click, even though a sibling force-closed it earlier')
		assert.equal(tool.map_image_panel.hidden, true, 'expected IMG closed by reopening UCA')
		assert.equal(tool.object_viewer_panel.hidden, true, 'expected OBJ closed by reopening UCA')
	})

	it('"1x1" has no panel to close/be closed by — arming it does not touch an already-open panel', function() {

		tool.attach_console()
		tool.attach_onexone()

		const uca_control		= geolocation.map.getContainer().querySelector('.uca-maps-control')
		const onexone_control	= geolocation.map.getContainer().querySelector('.uca-maps-onexone-control')

		uca_control.click()
		assert.equal(tool.console_panel.hidden, false, 'expected UCA open after its own click')

		onexone_control.click()
		assert.equal(is_onexone_enabled(tool), true, 'expected 1x1 armed by its own click')
		assert.equal(tool.console_panel.hidden, false, 'expected UCA to stay open — 1x1 has no panel, so it never enters the exclusivity set')
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
		assert.equal(tool.console_panel.hidden, false, 'expected the click on the link to reach the button\'s handler')

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
			offer_catastro()
			await run_edit()

			const corner	= tool.console_control.getContainer().closest('.leaflet-top.leaflet-left')
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

			const hue = resolve_token(tool.xyz_panel, '--tool_uca_maps')
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
			const object_btn	= tool.console_panel.querySelector('.uca-maps-object-section .uca-maps-property-add-button')
			const delete_btn	= tool.console_panel.querySelector('.uca-maps-object-section .uca-maps-property-delete')
			assert.isOk(image_btn, 'expected the map-image download button')
			assert.isOk(object_btn, 'expected the object section\'s Add button')
			assert.isOk(delete_btn, 'expected the property row\'s ✕')
			// the fill is the generated one (the hue clamped for its ink), not the raw hue
			const fill = resolve_token(tool.xyz_panel, '--tool_fill')
			assert.notEqual(fill, 'rgba(0, 0, 0, 0)', 'expected the generated tool fill to resolve, or the equality proves nothing')
			assert.equal(getComputedStyle(xyz_add).backgroundColor, fill, 'expected the action fill on the generated tool fill')
			assert.equal(getComputedStyle(xyz_add).cursor, 'pointer')
			assert.equal(chrome(image_btn), chrome(xyz_add), 'expected the map-image button on the shared action chrome')
			assert.equal(chrome(object_btn), chrome(xyz_add), 'expected the object section\'s buttons on the shared action chrome')

			// the ✕ is the secondary variant of the same mixin
			assert.equal(getComputedStyle(delete_btn).backgroundColor, resolve_token(tool.console_panel, '--bg_fill_inverse'), 'expected the ✕ on the secondary fill')
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

	// today the generated pair equals the raw hue and brand ink, so sentinels on
	// the tokens are what tell a binding to the pair from one to the raw hue
	it('with the tool CSS, the highlighted Roma suggestion sits on the generated tool fill and its ink', async function() {

		await with_tool_css(async () => {
			mount_roman()
			open_roman()
			seed_roman_list('dare', [roman_hit('Saguntum', 39.68, -0.27), roman_hit('Valentia', 39.47, -0.37)])
			const dropdown	= geolocation.map.getContainer().querySelector('.uca-maps-roman-dropdown')
			const buttons	= dropdown.querySelectorAll('.uca-maps-roman-result-button')
			assert.equal(buttons.length, 2, 'expected the two seeded suggestions')

			dropdown.style.setProperty('--tool_fill', 'rgb(1, 2, 3)')
			dropdown.style.setProperty('--tool_on_fill', 'rgb(4, 5, 6)')
			try {
				buttons[0].classList.add('is-active')
				const active = getComputedStyle(buttons[0])
				assert.equal(active.backgroundColor, 'rgb(1, 2, 3)', 'expected the active row on the generated tool fill')
				assert.equal(active.color, 'rgb(4, 5, 6)', 'expected the active row in the ink tuned for that fill')
				assert.notEqual(getComputedStyle(buttons[1]).backgroundColor, 'rgb(1, 2, 3)', 'expected only the active row highlighted')
			} finally {
				dropdown.style.removeProperty('--tool_fill')
				dropdown.style.removeProperty('--tool_on_fill')
			}
		})
	})

	it('with the tool CSS, a panel line takes the tint of its type: error by default, success, warning, working', async function() {

		await with_tool_css(async () => {
			tool.attach_file_upload()
			const message = tool.upload_panel.querySelector('.uca-maps-upload-message')
			message.hidden = false

			const tint_of = (token) => resolve_token(tool.upload_panel, token)
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

			const console_line	= tool.console_panel.querySelector('.uca-maps-empty-state')
			const list_line		= tool.object_viewer_panel.querySelector('.uca-maps-empty-state')
			assert.isOk(console_line, 'expected the console\'s empty line on the shared class')
			assert.isOk(list_line, 'expected the object list\'s empty line on the shared class')

			const look = (node) => {
				const style = getComputedStyle(node)
				return [style.color, style.fontStyle, style.paddingTop, style.marginTop].join(' | ')
			}
			assert.equal(look(list_line), look(console_line), 'expected one look for both')

			assert.equal(getComputedStyle(console_line).color, resolve_token(tool.console_panel, '--fg_muted', 'color'), 'expected the muted ink')
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
		tool.console_control.getContainer().click()
		assert.isFalse(tool.console_panel.classList.contains('uca-maps-panel-centered'), 'expected the console not centred')
		assert.notEqual(tool.console_panel.style.getPropertyValue('--uca_maps_anchor_left'), '', 'expected the console anchored beside its button')

		// what the phone rule lays every panel against: the bar's live right edge
		const map_rect	= geolocation.map.getContainer().getBoundingClientRect()
		const bar_rect	= tool.console_control.getContainer().parentNode.getBoundingClientRect()
		assert.equal(
			tool.console_panel.style.getPropertyValue('--uca_maps_bar_edge'),
			Math.round(bar_rect.right - map_rect.left + 8) + 'px',
			'expected the bar\'s edge measured on show'
		)
		// and below the core's view box, which the map cannot stack above
		const view_box = geolocation.map.getContainer().parentNode.querySelector(':scope > .map_inputs')
		assert.isOk(view_box, 'expected the core\'s view box beside the map')
		const box_bottom = Math.round(view_box.getBoundingClientRect().bottom - map_rect.top + 8)
		assert.equal(
			tool.console_panel.style.getPropertyValue('--uca_maps_panel_top'),
			Math.max(8, box_bottom) + 'px',
			'expected the panel\'s phone top measured below the view box'
		)
	})

	it('with the tool CSS, the console renders beside its button, with no inline top/left', async function() {

		await with_tool_css(async () => {
			tool.attach_console()
			tool.console_control.getContainer().click()
			const panel			= tool.console_panel
			const map_rect		= geolocation.map.getContainer().getBoundingClientRect()
			const button_rect	= tool.console_control.getContainer().getBoundingClientRect()
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
				[tool.console_control, tool.console_panel, 'console'],
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

	// Roma's 46rem comes AFTER the shared phone rule: only its own restatement
	// keeps it from overflowing a phone, and only the sheet's order shows that
	it('on a phone the wide Roman panel still stretches between the bar and the map edge', async function() {

		mount_roman()
		await with_tool_css(() => with_phone_cascade(() => {
			open_roman()
			const panel = tool.roman_panel
			assert.isFalse(panel.hidden, 'expected the Roman panel open')
			assert.isTrue(panel.classList.contains('uca-maps-panel-centered'), 'expected the centred panel the 46rem names')
			const map_rect	= geolocation.map.getContainer().getBoundingClientRect()
			const rem		= parseFloat(getComputedStyle(document.documentElement).fontSize)
			const rect		= panel.getBoundingClientRect()
			assert.equal(getComputedStyle(panel).right, (0.5 * rem) + 'px', 'expected the phone rule\'s right edge')
			assert.equal(Math.round(rect.right), Math.round(map_rect.right - 0.5 * rem), 'expected the width the phone rule gives, not 46rem')
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
			// the scroll is smooth: wait for it to start, then to settle
			let last = -1
			for (let i = 0; i < 90 && (message.hidden || panel.scrollTop===0 || panel.scrollTop!==last); i++) {
				last = panel.scrollTop
				await two_frames()
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
			for (let i = 0; i < 15; i++) await two_frames()

			assert.isFalse(panel.querySelector('.uca-maps-xyz-message').hidden, 'expected the refusal shown')
			assert.equal(panel.scrollTop, panel_top, 'expected the panel still')
			assert.equal(scroller.scrollTop, page_top, 'expected the page still')
		})
	})

	it('on a phone the bar keeps the size of the map\'s other controls, and a map shorter than the bar scrolls it in its own box', async function() {

		await with_tool_css(() => with_phone_rules('.uca-maps-toolbar', () => {
			// the whole bar, in the tool's order: 13 squares, taller than the map
			geolocation.section_lang = 'lg-spa' // gates UA in
			offer_catastro()
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

	/** Every panel the tool hangs from its bar: [attach, panel key, control key]. */
	const TOOLBAR_PANELS = [
		['attach_console',						'console_panel',		'console_control'],
		['attach_map_image_download_control',	'map_image_panel',		'map_image_control'],
		['attach_object_viewer',				'object_viewer_panel',	'object_viewer_control'],
		['attach_xyz_basemaps',					'xyz_panel',			'xyz_control'],
		['attach_wms_services',					'wms_panel',			'wms_control'],
		['attach_file_upload',					'upload_panel',			'upload_control'],
		['attach_place_search',					'place_search_panel',	'place_search_control'],
		['attach_legend',						'legend_panel',			'legend_control'],
		['attach_roman_empire',					'roman_panel',			'roman_control']
	]

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
			for (const [attach, , control_key] of TOOLBAR_PANELS) {
				tool[attach]()
				tool[control_key].getContainer().click() // opening populates the lists
			}
			seeded_layer(1).openPopup() // the console's object section

			let measured = 0
			for (const [, panel_key] of TOOLBAR_PANELS) {
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

	// Every box the tool hangs from the map sits outside .wrapper_tool, so only
	// the `data-tool` scope gives it the generated tokens: without it the action
	// buttons lose their fill and a checkbox falls back to the app's accent.
	it('with the tool CSS, every box on the map carries the tool scope: buttons and checkboxes take the tool fill', async function() {

		await with_tool_css(async () => {
			mount_roman(WITH_PLEIADES)
			for (const [attach] of TOOLBAR_PANELS) {
				tool[attach]()
			}

			// the generated values, read under a scope of their own
			const scope = document.createElement('div')
			scope.setAttribute('data-tool', 'tool_uca_maps')
			document.body.appendChild(scope)
			const fill	= resolve_token(scope, '--tool_fill')
			const ink	= resolve_token(scope, '--tool_on_fill', 'color')
			scope.remove()
			assert.notEqual(fill, 'rgba(0, 0, 0, 0)', 'expected main.css\'s generated tokens loaded, or this proves nothing')

			const bar = geolocation.map.getContainer().querySelector('.uca-maps-toolbar')
			for (const [label, node] of [['bar', bar], ['roman_dropdown', tool.roman_dropdown], ...TOOLBAR_PANELS.map(([, key]) => [key, tool[key]])]) {
				assert.equal(node.getAttribute('data-tool'), 'tool_uca_maps', label + ': expected the tool scope')
				assert.isNull(node.closest('.wrapper_tool'), label + ': expected outside .wrapper_tool, or the scope is not what paints it')

				const checkbox = document.createElement('input')
				checkbox.type = 'checkbox'
				node.appendChild(checkbox)
				assert.equal(getComputedStyle(checkbox).accentColor, fill, label + ': expected a checkbox in the tool fill')
				checkbox.remove()
			}

			const add = tool.xyz_panel.querySelector('.uca-maps-xyz-add-button')
			assert.equal(getComputedStyle(add).backgroundColor, fill, 'expected an action button in the generated fill')
			assert.equal(getComputedStyle(add).color, ink, 'expected an action button in the fill\'s own ink')
		})
	})

	it('with the tool CSS, the console is wider than a panel and an object\'s controls never scroll it sideways', async function() {

		await with_tool_css(async () => {
			tool.attach_console()
			tool.console_control.getContainer().click()
			seeded_layer(1).openPopup()

			// a plain panel anchored by its button, as the console is
			const plain = create_toolbar_panel(tool, {class_name: 'uca-maps-test-plain-panel'})
			plain.hidden = false

			const panel = tool.console_panel
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
})


// @license-end
