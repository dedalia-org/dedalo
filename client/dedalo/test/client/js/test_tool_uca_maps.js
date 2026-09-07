// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global it, describe, beforeEach, afterEach, assert, L, turf */
/*eslint no-undef: "error"*/
'use strict';

/**
 * TEST_TOOL_UCA_MAPS
 *
 * Client-side coverage for tool_uca_maps, hito 2 checkpoint 2a (the object
 * console shell — see tools/tool_uca_maps/js/object_console.js file header
 * for the full architecture: this tool's modal self-closes right after
 * attaching its console to the LIVE map; the console's lifetime is tied to
 * component_geolocation, never to the modal).
 *
 * LEFT TOOLBAR REFACTOR (2026-09-04, before hito 4 — CLAUDE.local.md "Left
 * toolbar: un botón por funcionalidad"): the "UCA" button's panel used to
 * also carry server capabilities and the map-image-download picker as
 * collapsible sections; both moved to their own button+panel
 * (`map_image_download.js` / `capabilities_panel.js`, both built through
 * `toolbar.js`). Assertions that used to read `.uca-maps-capabilities`/
 * `.uca-maps-map-image-download` inside `tool.panel_node` now read
 * `tool.capabilities_panel`/`tool.map_image_panel` instead.
 *
 * Two layers, matching the project convention (test_tool_dev_template.js):
 *
 * 1. STRUCTURAL — module export, constructor-seeded properties, prototype
 *    wiring. Fixture-free, always reliable.
 *
 * 2. LIVE MAP — builds a REAL component_geolocation instance (same fixture/
 *    pattern as test_component_geolocation.js: TLD `test`, tipo `test100`)
 *    with a seeded drawn polygon, then exercises tool_uca_maps' console
 *    plumbing directly against it: attach/idempotency, the toggle control,
 *    popupopen-driven selection, and the on_close_actions/
 *    on_geolocation_destroyed lifecycle split. Deliberately bypasses
 *    tool_common's init()/get_instance() ceremony (ddo_map resolution, tool
 *    registration lookups) — none of that is exercised by this tool (file
 *    header of tool_uca_maps.js: `ontology`-less by design) and none of it
 *    is what checkpoint 2a needs proven; `self.geolocation`/`self.map_ready`
 *    are set directly, matching how tool_uca_maps.prototype.init resolves
 *    them in production (get_caller_by_model, verbatim).
 */

import { elements } from './elements.js'
import { get_instance } from '../../../core/common/js/instances.js'
import { ui } from '../../../core/common/js/ui.js'
import { tool_uca_maps } from '../../../tools/tool_uca_maps/js/tool_uca_maps.js'
import {
	find_layer_id,
	set_style_field,
	set_property,
	delete_property,
	download_vector,
	toggle_centroid,
	toggle_uncertainty,
	set_hierarchy,
	RESERVED_PROPERTY_KEYS
} from '../../../tools/tool_uca_maps/js/object_console.js'
import { download_map_image } from '../../../tools/tool_uca_maps/js/map_image_download.js'
import { collect_objects, set_object_display, center_on_object } from '../../../tools/tool_uca_maps/js/object_viewer.js'
import { is_onexone_enabled, create_onexone_rectangle } from '../../../tools/tool_uca_maps/js/onexone.js'
import { DEFAULT_BASEMAPS } from '../../../tools/tool_uca_maps/js/xyz_basemaps.js'



describe('TOOL_UCA_MAPS CLIENT TEST', function() {

	this.timeout(10000)

	it('module exports the tool constructor', function() {
		assert.equal(typeof tool_uca_maps, 'function', 'expected tool_uca_maps to be a constructor function')
	})

	it('construct seeds the documented instance properties', function() {
		const instance = new tool_uca_maps()

		assert.equal(typeof instance, 'object', 'expected instance to be an object')
		assert.equal(instance.id, null, 'expected id null')
		assert.equal(instance.model, null, 'expected model null')
		assert.equal(instance.mode, null, 'expected mode null')
		assert.equal(instance.node, null, 'expected node null')
		assert.equal(instance.ar_instances, null, 'expected ar_instances null')
		assert.equal(instance.events_tokens, null, 'expected events_tokens null')
		assert.equal(instance.status, null, 'expected status null')
		assert.equal(instance.type, null, 'expected type null')
		assert.equal(instance.caller, null, 'expected caller null')
		assert.equal(instance.langs, null, 'expected langs null')
		assert.equal(instance.geolocation, null, 'expected geolocation null')
		assert.equal(instance.map_ready, false, 'expected map_ready false')
		assert.equal(instance.map_control, null, 'expected map_control null')
		assert.equal(instance.panel_node, null, 'expected panel_node null')
		assert.equal(instance.console_visible, false, 'expected console_visible false')
		assert.equal(instance.active_console_layer, null, 'expected active_console_layer null')
		assert.equal(instance._popupopen_handler, null, 'expected _popupopen_handler null')
		assert.equal(instance._pmcreate_handler, null, 'expected _pmcreate_handler null')
		assert.equal(instance._pmremove_handler, null, 'expected _pmremove_handler null')
		assert.equal(instance.map_image_control, null, 'expected map_image_control null')
		assert.equal(instance.map_image_panel, null, 'expected map_image_panel null')
		assert.equal(instance.map_image_panel_visible, false, 'expected map_image_panel_visible false')
		assert.equal(instance.capabilities_control, null, 'expected capabilities_control null')
		assert.equal(instance.capabilities_panel, null, 'expected capabilities_panel null')
		assert.equal(instance.capabilities_panel_visible, false, 'expected capabilities_panel_visible false')
		assert.equal(instance.object_viewer_control, null, 'expected object_viewer_control null')
		assert.equal(instance.object_viewer_panel, null, 'expected object_viewer_panel null')
		assert.equal(instance.object_viewer_panel_visible, false, 'expected object_viewer_panel_visible false')
		assert.equal(instance.onexone_control, null, 'expected onexone_control null')
		assert.equal(instance._onexone_popupopen_handler, null, 'expected _onexone_popupopen_handler null')
		assert.equal(instance._onexone_pmremove_handler, null, 'expected _onexone_pmremove_handler null')
		assert.equal(instance.xyz_control, null, 'expected xyz_control null')
		assert.equal(instance.xyz_panel, null, 'expected xyz_panel null')
		assert.equal(instance.basemaps, null, 'expected basemaps null')
		assert.equal(instance._xyz_tile_layers, null, 'expected _xyz_tile_layers null')
		assert.equal(instance._xyz_took_over_tiles, false, 'expected _xyz_took_over_tiles false')
		assert.equal(instance._xyz_created_layer_control, false, 'expected _xyz_created_layer_control false')
		assert.equal(instance._toolbar_nodes, null, 'expected _toolbar_nodes null')
	})

	it('prototype is wired with the lifecycle methods', function() {
		// common lifecycle delegated from tool_common / common via wire_tool
		assert.equal(typeof tool_uca_maps.prototype.render, 'function', 'expected render wired')
		assert.equal(typeof tool_uca_maps.prototype.refresh, 'function', 'expected refresh wired')
		assert.equal(typeof tool_uca_maps.prototype.edit, 'function', 'expected edit wired')
		// tool-specific overrides defined on the module
		assert.equal(typeof tool_uca_maps.prototype.init, 'function', 'expected init defined')
		assert.equal(typeof tool_uca_maps.prototype.build, 'function', 'expected build defined')
		assert.equal(typeof tool_uca_maps.prototype.destroy, 'function', 'expected destroy defined')
		assert.equal(typeof tool_uca_maps.prototype.wait_for_map, 'function', 'expected wait_for_map defined')
		assert.equal(typeof tool_uca_maps.prototype.get_capabilities, 'function', 'expected get_capabilities defined')
		// hito 2 checkpoint 2a additions
		assert.equal(typeof tool_uca_maps.prototype.attach_console, 'function', 'expected attach_console defined')
		// left toolbar refactor (2026-09-04) — one attach_* per functionality
		assert.equal(typeof tool_uca_maps.prototype.attach_map_image_download_control, 'function', 'expected attach_map_image_download_control defined')
		assert.equal(typeof tool_uca_maps.prototype.attach_capabilities_panel, 'function', 'expected attach_capabilities_panel defined')
		// hito 4 — functionality #4, "Objects"
		assert.equal(typeof tool_uca_maps.prototype.attach_object_viewer, 'function', 'expected attach_object_viewer defined')
		assert.equal(typeof tool_uca_maps.prototype.collect_objects, 'function', 'expected collect_objects defined')
		assert.equal(typeof tool_uca_maps.prototype.set_object_display, 'function', 'expected set_object_display defined')
		assert.equal(typeof tool_uca_maps.prototype.center_on_object, 'function', 'expected center_on_object defined')
		// hito 7 — functionality #7, "1x1"
		assert.equal(typeof tool_uca_maps.prototype.attach_onexone, 'function', 'expected attach_onexone defined')
		// hito 9 — functionality #5, "XYZ basemaps"
		assert.equal(typeof tool_uca_maps.prototype.attach_xyz_basemaps, 'function', 'expected attach_xyz_basemaps defined')
		assert.equal(typeof tool_uca_maps.prototype.add_basemap, 'function', 'expected add_basemap defined')
		assert.equal(typeof tool_uca_maps.prototype.delete_basemap, 'function', 'expected delete_basemap defined')
		assert.equal(typeof tool_uca_maps.prototype.move_basemap, 'function', 'expected move_basemap defined')
		assert.equal(typeof tool_uca_maps.prototype.on_close_actions, 'function', 'expected on_close_actions defined')
		assert.equal(typeof tool_uca_maps.prototype.close_transient_modal, 'function', 'expected close_transient_modal defined')
		assert.equal(typeof tool_uca_maps.prototype.on_geolocation_destroyed, 'function', 'expected on_geolocation_destroyed defined')
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
	* Three seeded drawn shapes — layer_id 1 = polygon, 2 = circle, 3 = marker —
	* loaded into their own FeatureGroups by get_map(). One combined fixture
	* (not per-type beforeEach variants) so every test in this suite can reach
	* every geometry-type branch without duplicating the get_instance/render/
	* get_map ceremony per type (review-diff tests-lens finding, 2026-09-02:
	* only Polygon was covered — style/centroid/hierarchy gating and
	* compute_info's per-type formulas are untestable against one geometry).
	* Circle reconstruction: `component_geolocation.js load_layer`'s own
	* `pointToLayer` rebuilds an `L.Circle` from a Point feature carrying
	* `properties.shape==='circle'` + `properties.radius` (metres) — verbatim.
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

	let geolocation, tool, map_container

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

		// get_map() only auto-loads self.active_layer_id (1, the polygon) —
		// layer_id 2/3 (circle/marker) need the SAME 'full' load the core
		// itself uses for its own multi-layer case (handle_click_no_tag,
		// component_geolocation.js) to get a FeatureGroup at all
		geolocation.layers_loader({ load: 'full', layer_id: null })

		// tool_uca_maps.prototype.init's real work, without the get_instance/
		// tool_common ceremony this suite deliberately bypasses (see file header)
		tool					= new tool_uca_maps()
		tool.model				= 'tool_uca_maps'
		tool.caller				= geolocation
		tool.geolocation		= geolocation
		tool.map_ready			= true
		// tool_common.prototype.init's own default (`self.mode = options.mode ||
		// 'edit'`), replicated here because this suite bypasses init() (file
		// header) — without it `create_source()` (common.js) builds
		// `source.mode: null`, which the server's rqo schema REJECTS wholesale as
		// request.invalid_rqo (source.mode). This was a silent, undetected gap:
		// every self.tool_request() call in this suite — including
		// self.get_capabilities(), used since hito 1 — has been failing this way
		// the whole time; nothing before hito 3's vector_download tests actually
		// asserted the round-trip SUCCEEDED (the capabilities DOM assertion only
		// checked the container renders — see render_capabilities' `!capabilities`
		// branch, which degrades to an inline error li rather than throwing).
		tool.mode				= 'edit'
		tool.get_tool_label		= () => undefined // force the '||' fallback label strings

	})

	afterEach(async function() {
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
		// left toolbar refactor (2026-09-04): capabilities/map-image no longer
		// live inside the "UCA" panel — attach_console() builds functionality
		// #3's own content only
		assert.isNotOk(
			tool.panel_node.querySelector('.uca-maps-capabilities-body'),
			'expected capabilities NOT built into the "UCA" panel any more (moved to its own panel)'
		)
		assert.isNotOk(
			tool.panel_node.querySelector('.uca-maps-map-image-row'),
			'expected map-image-download NOT built into the "UCA" panel any more (moved to its own panel)'
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

	it('find_layer_id resolves the FeatureGroup that owns a layer', function() {

		tool.attach_console()

		const feature_group = geolocation.FeatureGroup[1]
		assert.isOk(feature_group, 'expected FeatureGroup[1] loaded from the seeded lib_data')
		const layers = feature_group.getLayers()
		assert.equal(layers.length, 1, 'expected the one seeded polygon layer')

		assert.equal(find_layer_id(tool, layers[0]), 1, 'expected find_layer_id to resolve layer_id 1')
		assert.equal(find_layer_id(tool, {}), null, 'expected null for a layer owned by no FeatureGroup')
	})

	it('opening a drawn layer\'s popup selects it in the console', function() {

		tool.attach_console()

		const layer = geolocation.FeatureGroup[1].getLayers()[0]
		layer.openPopup()

		assert.strictEqual(tool.active_console_layer, layer, 'expected the clicked layer selected')
		assert.equal(tool.panel_node.hidden, false, 'expected the panel shown once a geometry is selected')
		assert.isOk(
			tool.panel_node.querySelector('.uca-maps-object-section').textContent.includes('Polygon'),
			'expected the object section to name the geometry type'
		)
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



	// checkpoint 2b — object functions over the same selection plumbing 2a
	// proved (style/properties/download/centroid/uncertainty/hierarchy).
	// Exercises object_console.js's exported mutation functions directly
	// (same rationale as the rest of this describe block: no get_instance/
	// tool_common ceremony needed) against the seeded polygon layer.

	it('set_style_field writes properties.uca_maps.style and applies it live', function() {

		const layer = geolocation.FeatureGroup[1].getLayers()[0]

		set_style_field(tool, layer, 'fillColor', '#ff0000')

		assert.equal(layer.feature.properties.uca_maps.style.fillColor, '#ff0000', 'expected style written to properties.uca_maps')
		assert.equal(layer.options.fillColor, '#ff0000', 'expected setStyle applied live')
	})

	it('set_property/delete_property CRUD custom properties, reserved keys refused', function() {

		const layer = geolocation.FeatureGroup[1].getLayers()[0]

		assert.equal(set_property(tool, layer, 'custom_key', 'custom_value'), true, 'expected a non-reserved key accepted')
		assert.equal(layer.feature.properties.custom_key, 'custom_value', 'expected the value written')

		for (const reserved of RESERVED_PROPERTY_KEYS) {
			assert.equal(set_property(tool, layer, reserved, 'x'), false, 'expected reserved key "' + reserved + '" refused')
		}

		delete_property(tool, layer, 'custom_key')
		assert.equal('custom_key' in layer.feature.properties, false, 'expected the property removed')
	})

	/**
	* Shared URL.createObjectURL spy — every download_vector format ends by
	* building a Blob and handing it to this same global (review-diff
	* tests-lens finding, 2026-09-02, against the original download_geojson: a
	* throw-only assertion would still pass for a bug that serialized {} or
	* the wrong layer). Restored in a `finally` so a failing assertion can
	* never leak the spy into a later test.
	* @param {Function} fn - runs with the spy installed
	* @returns {Promise<Blob|null>} the captured Blob, or null if none was built
	*/
	const capture_download_blob = async function(fn) {
		const original_create_object_url = URL.createObjectURL
		let captured_blob = null
		URL.createObjectURL = (blob) => {
			captured_blob = blob
			return 'blob:uca-maps-test-mock'
		}
		try {
			await fn()
		} finally {
			URL.createObjectURL = original_create_object_url
		}
		return captured_blob
	}//end capture_download_blob

	it('download_vector(\'geojson\') stays 100% client-side and downloads the real GeoJSON', async function() {

		const layer = geolocation.FeatureGroup[1].getLayers()[0]

		const captured_blob = await capture_download_blob(() => download_vector(tool, layer, 'geojson'))

		assert.isOk(captured_blob, 'expected download_vector to build a Blob')
		assert.equal(captured_blob.type, 'application/geo+json', 'expected the GeoJSON MIME type')

		const parsed = JSON.parse(await captured_blob.text())
		assert.equal(parsed.type, 'Feature', 'expected the serialized payload to be the layer\'s own GeoJSON Feature')
		assert.equal(parsed.geometry.type, 'Polygon', 'expected the seeded polygon\'s own geometry type')
	})

	/**
	* download_vector('shp'/'kml') round-trips through the REAL server action
	* (`vector_download.ts`, hito 3) — this suite's own ephemeral server
	* (`bun run test:client`, AGENTS.md) runs in the same container as the
	* GDAL binaries (`tools/tool_uca_maps/dev/Dockerfile.dev`), so this is a
	* genuine end-to-end exercise, not a mock. Tolerates GDAL being absent on
	* whatever machine eventually runs this suite (tool.dependency_unavailable
	* is a legitimate, gated outcome — the shape assertion only runs when the
	* conversion actually happened), same discipline as the server-side
	* `HAVE_GDAL`-gated native test (test/unit/tool_uca_maps_vector_download.test.ts).
	*/
	it('download_vector(\'shp\') downloads a real zip via the server\'s ogr2ogr, or reports GDAL unavailable', async function() {

		const layer = geolocation.FeatureGroup[1].getLayers()[0]
		let response = null
		const original_tool_request = tool.tool_request
		tool.tool_request = async function(options) {
			response = await original_tool_request.call(tool, options)
			return response
		}

		const captured_blob = await capture_download_blob(() => download_vector(tool, layer, 'shp'))

		if (response && response.ok!==true) {
			assert.equal(
				response.error && response.error.code, 'tool.dependency_unavailable',
				'expected the only acceptable failure to be a missing GDAL binary — full response: ' + JSON.stringify(response)
			)
			return
		}

		assert.isOk(captured_blob, 'expected download_vector to build a Blob from the server response')
		assert.equal(captured_blob.type, 'application/zip', 'expected the shapefile zip MIME type')

		const bytes = new Uint8Array(await captured_blob.arrayBuffer())
		assert.isAbove(bytes.length, 0, 'expected a non-empty zip')
		// ZIP local-file-header magic ('PK\x03\x04') — the same real-archive
		// proof the native test asserts server-side.
		assert.deepEqual(Array.from(bytes.slice(0, 4)), [0x50, 0x4b, 0x03, 0x04], 'expected real ZIP magic bytes')
	})

	it('download_vector(\'kml\') downloads real WGS84 KML via the server\'s ogr2ogr, or reports GDAL unavailable', async function() {

		const layer = geolocation.FeatureGroup[1].getLayers()[0]
		let response = null
		const original_tool_request = tool.tool_request
		tool.tool_request = async function(options) {
			response = await original_tool_request.call(tool, options)
			return response
		}

		const captured_blob = await capture_download_blob(() => download_vector(tool, layer, 'kml'))

		if (response && response.ok!==true) {
			assert.equal(
				response.error && response.error.code, 'tool.dependency_unavailable',
				'expected the only acceptable failure to be a missing GDAL binary — full response: ' + JSON.stringify(response)
			)
			return
		}

		assert.isOk(captured_blob, 'expected download_vector to build a Blob from the server response')
		assert.equal(captured_blob.type, 'application/vnd.google-earth.kml+xml', 'expected the KML MIME type')

		const text = await captured_blob.text()
		assert.include(text, '<kml', 'expected real KML content, not an empty/garbage file')
	})

	it('toggle_centroid creates a linked marker in the same FeatureGroup, and removes it on toggle-off', function() {

		const layer = geolocation.FeatureGroup[1].getLayers()[0]
		const layers_before = geolocation.FeatureGroup[1].getLayers().length

		toggle_centroid(tool, layer)

		const centroid_uid = layer.feature.properties.uca_maps.centroid_uid
		assert.isOk(centroid_uid, 'expected a centroid_uid recorded on the parent')

		const layers_after_create = geolocation.FeatureGroup[1].getLayers()
		assert.equal(layers_after_create.length, layers_before + 1, 'expected one new layer (the centroid marker) added')

		const centroid_layer = layers_after_create.find((candidate) =>
			candidate.feature
			&& candidate.feature.properties
			&& candidate.feature.properties.uca_maps
			&& candidate.feature.properties.uca_maps.uid===centroid_uid
		)
		assert.isOk(centroid_layer, 'expected to find the centroid marker by its uid')
		assert.equal(
			centroid_layer.feature.properties.uca_maps.centroid_of,
			layer.feature.properties.uca_maps.uid,
			'expected the centroid marker linked back to the parent by uid'
		)

		toggle_centroid(tool, layer)

		assert.equal(layer.feature.properties.uca_maps.centroid_uid, undefined, 'expected centroid_uid cleared')
		assert.equal(
			geolocation.FeatureGroup[1].getLayers().length, layers_before,
			'expected the centroid marker removed again'
		)
	})

	it('toggle_uncertainty preserves the v6 1/area bug (value is 1/area, not area)', function() {

		const layer = geolocation.FeatureGroup[1].getLayers()[0]
		const area_m2 = turf.area(layer.toGeoJSON())

		toggle_uncertainty(tool, layer)

		const uncertainty = layer.feature.properties.uca_maps.uncertainty
		assert.isOk(uncertainty, 'expected uncertainty recorded')
		assert.equal(
			uncertainty.value, (1 / area_m2).toFixed(20) + ' m²',
			'expected the preserved v6 bug: 1/area, not area, formatted as if it were m²'
		)
		assert.isAtLeast(uncertainty.scale_tier, 1, 'expected a scale tier assigned')
		assert.isAtMost(uncertainty.scale_tier, 6, 'expected a scale tier within the 6-tier v6 scale')

		toggle_uncertainty(tool, layer)
		assert.equal(layer.feature.properties.uca_maps.uncertainty, undefined, 'expected uncertainty cleared on second toggle')
	})

	it('set_hierarchy preserves the v6 opposite-jump-on-uncheck bug', function() {

		const layer = geolocation.FeatureGroup[1].getLayers()[0]

		set_hierarchy(tool, layer, 'back', true)
		let hierarchy = layer.feature.properties.uca_maps.hierarchy
		assert.equal(hierarchy.bringToBack, true, 'expected bringToBack true after checking it')
		assert.equal(hierarchy.bringToFront, false, 'expected bringToFront forced false (mutually exclusive on check)')

		set_hierarchy(tool, layer, 'back', false)
		hierarchy = layer.feature.properties.uca_maps.hierarchy
		assert.equal(hierarchy.bringToBack, false, 'expected bringToBack false after unchecking it')
		assert.equal(
			hierarchy.bringToFront, false,
			'expected the preserved v6 bug: bringToFront NOT set true even though the layer visually jumped to front'
		)
	})

	it('render_selected_object builds the full 2b section set for a polygon', function() {

		tool.attach_console() // panel_node only exists once the console is attached (2a)

		const layer = geolocation.FeatureGroup[1].getLayers()[0]
		layer.openPopup()

		const section = tool.panel_node.querySelector('.uca-maps-object-section')
		assert.isOk(section.querySelector('.uca-maps-style-controls'), 'expected style controls for a polygon')
		assert.isOk(section.querySelector('.uca-maps-centroid'), 'expected a centroid checkbox for a polygon')
		assert.isOk(section.querySelector('.uca-maps-uncertainty'), 'expected an uncertainty checkbox for a polygon')
		assert.isOk(section.querySelector('.uca-maps-hierarchy-controls'), 'expected hierarchy checkboxes for a polygon')
		assert.isOk(section.querySelector('.uca-maps-properties-editor'), 'expected the properties editor')
		assert.isOk(section.querySelector('.uca-maps-download-format'), 'expected the format select (GeoJSON/SHP/KML)')
		assert.isOk(section.querySelector('.uca-maps-download-button'), 'expected the download button')

		const options = Array.from(section.querySelectorAll('.uca-maps-download-format option')).map(o => o.value)
		assert.deepEqual(options, ['geojson', 'shp', 'kml'], 'expected the three vector formats, in menu order')
	})



	// review-diff tests-lens finding, 2026-09-02: the suite above only ever
	// selected the seeded Polygon (layer_id 1) — style/centroid/uncertainty/
	// hierarchy gating and compute_info's per-type formulas are untestable
	// against one geometry. Circle (layer_id 2) and Marker (layer_id 3) close
	// the two gaps the reviewer flagged as the required minimum; Polyline was
	// explicitly graded optional by the same review and is left for a future
	// checkpoint.

	it('compute_info: Marker shows coordinates only, no style/centroid/uncertainty/hierarchy sections', function() {

		tool.attach_console()
		const layer = geolocation.FeatureGroup[3].getLayers()[0]
		assert.instanceOf(layer, L.Marker, 'expected the seeded marker to load as an L.Marker')

		const info = tool.compute_info(layer)
		assert.equal(info.label_key, 'coordinates', 'expected the Marker info label')
		assert.equal(info.value, geolocation.str_lat_lng(layer.getLatLng()), 'expected the same formatting as the core\'s own popup')

		layer.openPopup()
		const section = tool.panel_node.querySelector('.uca-maps-object-section')
		assert.isNotOk(section.querySelector('.uca-maps-style-controls'), 'expected NO style controls for a marker')
		assert.isNotOk(section.querySelector('.uca-maps-centroid'), 'expected NO centroid checkbox for a marker')
		assert.isNotOk(section.querySelector('.uca-maps-uncertainty'), 'expected NO uncertainty checkbox for a marker')
		assert.isNotOk(section.querySelector('.uca-maps-hierarchy-controls'), 'expected NO hierarchy checkboxes for a marker')
		assert.isOk(section.querySelector('.uca-maps-properties-editor'), 'expected the properties editor to still be offered')
		assert.isOk(section.querySelector('.uca-maps-download-button'), 'expected the download button to still be offered')
	})

	it('compute_info: Circle shows center/radius/area (core\'s own circumference-as-area formula), has style/centroid/hierarchy but NOT uncertainty', function() {

		tool.attach_console()
		const layer = geolocation.FeatureGroup[2].getLayers()[0]
		assert.instanceOf(layer, L.Circle, 'expected the seeded circle to reconstruct as an L.Circle (shape:"circle"+radius)')

		const info = tool.compute_info(layer)
		assert.equal(info.label_key, 'center_radius_area')
		const expected_area = (2 * Math.PI * layer.getRadius()).toFixed(2)
		assert.isOk(info.value.includes(expected_area), 'expected the same circumference-as-"area" formula as get_popup_content')

		layer.openPopup()
		const section = tool.panel_node.querySelector('.uca-maps-object-section')
		assert.isOk(section.querySelector('.uca-maps-style-controls'), 'expected style controls for a circle')
		assert.isOk(section.querySelector('.uca-maps-centroid'), 'expected a centroid checkbox for a circle')
		assert.isNotOk(section.querySelector('.uca-maps-uncertainty'), 'expected NO uncertainty checkbox for a circle (matches v6: polygon-only)')
		assert.isOk(section.querySelector('.uca-maps-hierarchy-controls'), 'expected hierarchy checkboxes for a circle')
	})

	it('toggle_centroid also works for a Circle (not just Polygon)', function() {

		const layer = geolocation.FeatureGroup[2].getLayers()[0]

		toggle_centroid(tool, layer)
		assert.isOk(layer.feature.properties.uca_maps.centroid_uid, 'expected a centroid recorded on the circle')

		toggle_centroid(tool, layer)
		assert.equal(layer.feature.properties.uca_maps.centroid_uid, undefined, 'expected the centroid cleared on toggle-off')
	})

	it('edit() (the real production entry point) attaches every functionality\'s own button+panel when geolocation+map_ready', async function() {

		// this suite deliberately bypasses init()/get_instance() (file header)
		// but edit() itself — render_tool_uca_maps.prototype.edit, wired onto
		// tool_uca_maps.prototype.edit by wire_tool() — was never exercised
		// directly by any other test here; every assertion so far went
		// through tool.attach_console() called by hand (review-diff
		// tests-lens finding, 2026-09-02: the actual gate
		// `if (self.geolocation && self.map_ready) { self.attach_console() }`
		// inside edit() had no coverage of its own). Left toolbar refactor
		// (2026-09-04): edit() now attaches THREE independent button+panel
		// pairs, one per functionality (CLAUDE.local.md "Left toolbar");
		// hito 4 adds a fourth ("Objects").
		tool.type		= 'tool'
		tool.mode		= 'edit'
		tool.context	= { label: 'Mapas UCA' }

		assert.isNotOk(tool.map_control, 'expected no control before edit() runs')
		assert.isNotOk(tool.map_image_control, 'expected no map-image control before edit() runs')

		const wrapper = await tool.edit({})

		assert.isOk(wrapper, 'expected edit() to return a wrapper node')
		assert.isOk(tool.map_control, 'expected edit()\'s gate to have called attach_console()')
		assert.isOk(tool.panel_node, 'expected the "UCA" panel built via edit()')
		assert.isOk(tool.map_image_control, 'expected edit()\'s gate to have called attach_map_image_download_control()')
		assert.isOk(tool.map_image_panel, 'expected the map-image-download panel built via edit()')
		// capabilities_control is SHOW_DEVELOPER-gated (capabilities_panel.js) —
		// this suite's own server always runs with DEDALO_DEV_MODE=true
		// (scripts/client_test_server.ts), so a logged-in session here is
		// always a dev session
		assert.isOk(tool.capabilities_control, 'expected edit()\'s gate to have called attach_capabilities_panel() (suite runs DEDALO_DEV_MODE=true)')
		assert.isOk(tool.capabilities_panel, 'expected the capabilities panel built via edit()')
		assert.isOk(tool.object_viewer_control, 'expected edit()\'s gate to have called attach_object_viewer()')
		assert.isOk(tool.object_viewer_panel, 'expected the "Objects" panel built via edit()')
	})



	// hito 3, checkpoint 3b — "Download map as image" (functionality #10).
	// Left toolbar refactor (2026-09-04): its own button+panel, no longer a
	// section inside the "UCA" panel — see map_image_download.js
	// attach_map_image_download_control / render_map_image_download_panel.

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

		control.click()
		assert.equal(tool.map_image_panel.hidden, false, 'expected the panel shown after one click')
		control.click()
		assert.equal(tool.map_image_panel.hidden, true, 'expected the panel hidden again after a second click')
	})

	it('download_map_image(\'png\') captures the live map client-side, no server round-trip', async function() {

		tool.attach_console()
		tool.attach_map_image_download_control()

		let tool_request_called = false
		const original_tool_request = tool.tool_request
		tool.tool_request = async function(options) {
			tool_request_called = true
			return original_tool_request.call(tool, options)
		}

		const captured_blob = await capture_download_blob(() => download_map_image(tool, 'png'))

		assert.isOk(captured_blob, 'expected download_map_image to build a Blob')
		assert.equal(captured_blob.type, 'image/png', 'expected a real PNG capture')
		assert.isAbove(captured_blob.size, 0, 'expected a non-empty capture')
		assert.equal(tool_request_called, false, 'expected NO server round-trip for the PNG format (same principle as GeoJSON, 2b/3a)')

		tool.tool_request = original_tool_request
	})

	/**
	* download_map_image('jpg'/'geotiff') round-trips through the REAL server
	* action (`raster_download.ts`, hito 3b) — same tolerant-of-a-missing-
	* binary discipline as 3a's SHP/KML tests (this suite's own ephemeral
	* server runs in the same container that now has both GDAL and
	* ImageMagick).
	*/
	it('download_map_image(\'jpg\') downloads a real flattened JPEG via the server\'s ImageMagick, or reports it unavailable', async function() {

		tool.attach_console()
		tool.attach_map_image_download_control()

		let response = null
		const original_tool_request = tool.tool_request
		tool.tool_request = async function(options) {
			response = await original_tool_request.call(tool, options)
			return response
		}

		const captured_blob = await capture_download_blob(() => download_map_image(tool, 'jpg'))

		if (response && response.ok!==true) {
			assert.equal(response.error && response.error.code, 'tool.dependency_unavailable', 'expected the only acceptable failure to be a missing ImageMagick binary — full response: ' + JSON.stringify(response))
			return
		}

		assert.isOk(captured_blob, 'expected download_map_image to build a Blob from the server response')
		assert.equal(captured_blob.type, 'image/jpeg', 'expected the JPEG MIME type')
		assert.isAbove(captured_blob.size, 0, 'expected a non-empty JPEG')
	})

	it('download_map_image(\'geotiff\') downloads a real georeferenced TIFF via the server\'s GDAL, or reports it unavailable', async function() {

		tool.attach_console()
		tool.attach_map_image_download_control()

		let response = null
		const original_tool_request = tool.tool_request
		tool.tool_request = async function(options) {
			response = await original_tool_request.call(tool, options)
			return response
		}

		const captured_blob = await capture_download_blob(() => download_map_image(tool, 'geotiff'))

		if (response && response.ok!==true) {
			assert.equal(response.error && response.error.code, 'tool.dependency_unavailable', 'expected the only acceptable failure to be a missing GDAL binary — full response: ' + JSON.stringify(response))
			return
		}

		assert.isOk(captured_blob, 'expected download_map_image to build a Blob from the server response')
		assert.equal(captured_blob.type, 'image/tiff', 'expected the GeoTIFF MIME type')

		const bytes = new Uint8Array(await captured_blob.arrayBuffer())
		assert.isAbove(bytes.length, 0, 'expected a non-empty GeoTIFF')
		// TIFF magic bytes: little-endian 'II*\0' (0x49 0x49 0x2A 0x00) — GDAL's
		// own default byte order.
		assert.deepEqual(Array.from(bytes.slice(0, 4)), [0x49, 0x49, 0x2a, 0x00], 'expected real TIFF magic bytes')
	})



	// hito 4 — functionality #4 of the audit, "Objects" (object_viewer.js):
	// read-only vector/rasterized object lists over the ACTIVE FeatureGroup
	// (v6 parity, object_viewer.js file header).
	//
	// (!) tool.geolocation.active_layer_id is NOT 1 after this suite's own
	// beforeEach: `layers_loader({load:'full', layer_id:null})` calls the
	// core's own `load_layer` once per seeded layer_id (1, then 2, then 3,
	// `component_geolocation.js` array order) and `load_layer` unconditionally
	// sets `self.active_layer_id = layer_id` at ITS OWN end — so after the
	// 'full' load, active_layer_id is 3 (the LAST one loaded, the marker), not
	// 1. Every test below sets `geolocation.active_layer_id` EXPLICITLY before
	// asserting which FeatureGroup is "active", rather than relying on
	// whatever the fixture happens to leave behind.

	it('attach_object_viewer builds its own button+panel with both (empty, unpopulated) list sections', function() {

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

		// NOT populated at attach time (review-diff simplification finding,
		// hito 4 — matches every sibling panel, which also builds its content
		// lazily on first open, not at attach)
		assert.equal(vector_list.children.length, 0, 'expected the Vector Objects list still empty before the first open')
		assert.equal(raster_list.children.length, 0, 'expected the Rasterized Objects list still empty before the first open')

		control.click()
		assert.equal(tool.object_viewer_panel.hidden, false, 'expected the panel shown after one click')

		// the first open is what populates it — the seeded polygon (active
		// layer 1) is listed now
		const vector_items = vector_list.querySelectorAll('.uca-maps-object-viewer-item')
		assert.equal(vector_items.length, 1, 'expected the one seeded polygon in Vector Objects')
		assert.isOk(
			raster_list.querySelector('.uca-maps-object-viewer-placeholder'),
			'expected Rasterized Objects to show its empty-state placeholder — no raster-overlay support ported yet (functionality #11)'
		)

		control.click()
		assert.equal(tool.object_viewer_panel.hidden, true, 'expected the panel hidden again after a second click')
	})

	it('collect_objects reads the ACTIVE FeatureGroup only (v6 parity), with a display-only nameless fallback', function() {

		geolocation.active_layer_id = 1 // the seeded polygon
		tool.attach_object_viewer()

		let {vector_objects, raster_objects} = collect_objects(tool)
		assert.equal(vector_objects.length, 1, 'expected only the active layer\'s (1, polygon) one object')
		assert.equal(raster_objects.length, 0, 'expected no raster objects (functionality #11 not ported)')
		assert.equal(vector_objects[0].name, 'Untitled object', 'expected the display-only nameless fallback')
		assert.equal(vector_objects[0].display, true, 'expected visible by default')
		assert.equal(
			geolocation.FeatureGroup[1].getLayers()[0].feature.properties.name, undefined,
			'expected collect_objects to NEVER write the nameless fallback back into properties (deliberate v6 deviation, file header)'
		)

		geolocation.active_layer_id = 3 // switch to the seeded marker's FeatureGroup
		;({vector_objects, raster_objects} = collect_objects(tool))
		assert.equal(vector_objects.length, 1, 'expected the marker FeatureGroup\'s one object once active_layer_id changes')
		assert.instanceOf(vector_objects[0].layer, L.Marker, 'expected the seeded marker')
	})

	it('set_object_display hides/shows a Polygon (DOM style + persisted properties.uca_maps.display) and marks the FeatureGroup dirty', function() {

		tool.attach_console() // hydrate()'s reapply_all/commit plumbing lives here
		geolocation.active_layer_id = 1
		tool.attach_object_viewer()

		const layer = geolocation.FeatureGroup[1].getLayers()[0]
		assert.instanceOf(layer, L.Polygon, 'expected the seeded polygon')

		set_object_display(tool, layer, false)
		assert.equal(layer.feature.properties.uca_maps.display, false, 'expected display persisted false')
		assert.equal(layer._path.style.display, 'none', 'expected the Path DOM node hidden')

		set_object_display(tool, layer, true)
		assert.equal(layer.feature.properties.uca_maps.display, true, 'expected display persisted true again')
		assert.notEqual(layer._path.style.display, 'none', 'expected the Path DOM node shown again')
	})

	it('set_object_display works for a Marker too (icon + shadow, not _path)', function() {

		tool.attach_console()
		geolocation.active_layer_id = 3
		tool.attach_object_viewer()

		const layer = geolocation.FeatureGroup[3].getLayers()[0]
		assert.instanceOf(layer, L.Marker, 'expected the seeded marker')

		set_object_display(tool, layer, false)
		assert.equal(layer.feature.properties.uca_maps.display, false, 'expected display persisted false')
		assert.equal(layer._icon.style.display, 'none', 'expected the marker icon hidden')

		set_object_display(tool, layer, true)
		assert.notEqual(layer._icon.style.display, 'none', 'expected the marker icon shown again')
	})

	it('set_object_display seeds .feature on a layer freshly drawn via Geoman (pm:create never assigns one)', function() {

		tool.attach_console()
		geolocation.active_layer_id = 1
		tool.attach_object_viewer()

		// simulate a shape Geoman just created and nobody has clicked open in
		// the "UCA" console yet — component_geolocation.js's own init_feature
		// never assigns .feature (only the L.geoJson restore path does), so a
		// FRESH layer genuinely reaches this module with none (review-diff
		// correctness finding, hito 4: a bare `layer.feature.properties` read
		// silently no-oped on exactly this layer before)
		const layer = geolocation.FeatureGroup[1].getLayers()[0]
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

		const layer = geolocation.FeatureGroup[1].getLayers()[0]

		tool.object_viewer_control.getContainer().click() // show + populate
		const checkbox = tool.object_viewer_panel.querySelector('.uca-maps-object-viewer-vector-list .uca-maps-object-viewer-checkbox')
		assert.isOk(checkbox, 'expected the seeded polygon\'s checkbox')
		assert.equal(checkbox.checked, true, 'expected checked (visible) by default')

		checkbox.checked = false
		checkbox.dispatchEvent(new Event('change'))

		assert.equal(layer.feature.properties.uca_maps.display, false, 'expected the checkbox change to reach set_object_display')
		assert.equal(layer._path.style.display, 'none', 'expected the checkbox change to hide the Path DOM node too')

		// re-checking it must show it again — proves the handler reads
		// checkbox.checked itself rather than blindly inverting the stored
		// value every time it fires (review-diff robustness finding, hito 4)
		checkbox.checked = true
		checkbox.dispatchEvent(new Event('change'))
		assert.equal(layer.feature.properties.uca_maps.display, true, 'expected display persisted true again')
		assert.notEqual(layer._path.style.display, 'none', 'expected the Path DOM node shown again')
	})

	it('the panel refreshes itself while left open, on the next updated_layer_data_<id_base> publish', function() {

		geolocation.active_layer_id = 1
		tool.attach_object_viewer()

		tool.object_viewer_control.getContainer().click() // open — populates once
		const vector_list = tool.object_viewer_panel.querySelector('.uca-maps-object-viewer-vector-list')
		assert.equal(vector_list.querySelectorAll('.uca-maps-object-viewer-item').length, 1, 'expected the one seeded polygon')

		// simulate a second object appearing in the SAME FeatureGroup while
		// the panel is still open (a new Geoman pm:create, or an edit
		// elsewhere) — the core's own update_draw_data is what every one of
		// Geoman's pm:create/pm:update/pm:edit/pm:remove handlers already
		// call (component_geolocation.js), so firing it directly here is the
		// same signal a real draw/edit/delete would produce
		const extra = L.circle([40.41, -3.70], {radius: 50}).addTo(geolocation.FeatureGroup[1])
		extra.feature = extra.toGeoJSON()
		geolocation.update_draw_data(1)

		assert.equal(
			vector_list.querySelectorAll('.uca-maps-object-viewer-item').length, 2,
			'expected the panel to pick up the new object WITHOUT being closed and reopened'
		)
	})

	it('the panel does NOT refresh itself while closed (no wasted rebuild)', function() {

		geolocation.active_layer_id = 1
		tool.attach_object_viewer() // never opened

		const vector_list = tool.object_viewer_panel.querySelector('.uca-maps-object-viewer-vector-list')
		assert.equal(vector_list.children.length, 0, 'expected still unpopulated (never opened)')

		geolocation.update_draw_data(1)

		assert.equal(vector_list.children.length, 0, 'expected the closed panel to stay untouched by the live-refresh subscription')
	})

	it('center_on_object fits the map to a Polygon\'s bounds, masked via camera_is_moving (component_geolocation.js\'s own dragend/zoomend guard)', function() {

		geolocation.active_layer_id = 1
		tool.attach_object_viewer()

		const layer = geolocation.FeatureGroup[1].getLayers()[0]

		let fit_bounds_called_with = null
		let camera_is_moving_during_call = null
		const original_fit_bounds = geolocation.map.fitBounds
		geolocation.map.fitBounds = function(bounds, options) {
			fit_bounds_called_with = bounds
			camera_is_moving_during_call = geolocation.camera_is_moving
			return original_fit_bounds.call(this, bounds, options)
		}

		center_on_object(tool, layer)

		assert.isOk(fit_bounds_called_with, 'expected map.fitBounds to be called')
		assert.isOk(fit_bounds_called_with.equals(layer.getBounds()), 'expected the layer\'s own bounds')
		assert.equal(camera_is_moving_during_call, true, 'expected camera_is_moving raised DURING the move (CLAUDE.local.md "Tres leyes de component_geolocation")')
		assert.equal(geolocation.camera_is_moving, false, 'expected camera_is_moving lowered again afterwards')

		geolocation.map.fitBounds = original_fit_bounds
	})

	it('center_on_object (v6\'s "eye" icon) moves a Marker through move_camera (the single masked door), zoom 16 (v6\'s own hardcoded level)', function() {

		geolocation.active_layer_id = 3
		tool.attach_object_viewer()

		const layer = geolocation.FeatureGroup[3].getLayers()[0]
		const latlng = layer.getLatLng()

		let move_camera_called_with = null
		const original_move_camera = geolocation.move_camera
		geolocation.move_camera = function(lat, lon, zoom) {
			move_camera_called_with = {lat, lon, zoom}
			return original_move_camera.call(this, lat, lon, zoom)
		}

		center_on_object(tool, layer)

		assert.isOk(move_camera_called_with, 'expected move_camera to be called — never a bare map.setView')
		assert.equal(move_camera_called_with.lat, latlng.lat, 'expected the marker\'s own latitude')
		assert.equal(move_camera_called_with.lon, latlng.lng, 'expected the marker\'s own longitude')
		assert.equal(move_camera_called_with.zoom, 16, 'expected v6\'s own hardcoded zoom level')

		geolocation.move_camera = original_move_camera
	})

	it('center_on_object never marks the record dirty — a "Center" click is read-only (functionality #4 has no edit affordance)', function() {

		geolocation.active_layer_id = 1
		tool.attach_object_viewer()

		const layer = geolocation.FeatureGroup[1].getLayers()[0]

		geolocation.is_data_changed = false
		center_on_object(tool, layer)
		assert.equal(geolocation.is_data_changed, false, 'expected NO dirty flag from a read-only "Center" click on a Polygon')

		geolocation.active_layer_id = 3
		const marker = geolocation.FeatureGroup[3].getLayers()[0]
		geolocation.is_data_changed = false
		center_on_object(tool, marker)
		assert.equal(geolocation.is_data_changed, false, 'expected NO dirty flag from a read-only "Center" click on a Marker either')
	})

	it('a hidden display state survives a reload (reapply_all/reapply_display, hydrate())', function() {

		tool.attach_console() // hydrate() — the only path that subscribes updated_layer_data_<id_base>
		geolocation.active_layer_id = 1
		tool.attach_object_viewer()

		const layer = geolocation.FeatureGroup[1].getLayers()[0]
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

	it('detach_object_viewer removes the control and panel', async function() {

		tool.attach_object_viewer()
		const map_container_node = geolocation.map.getContainer()
		assert.isOk(tool.object_viewer_control, 'expected the control attached first')
		assert.isOk(
			map_container_node.querySelector('.uca-maps-object-viewer-control'),
			'expected the button in the DOM before teardown'
		)

		await tool.destroy(false, false, false)

		assert.equal(tool.object_viewer_control, null, 'expected object_viewer_control cleared')
		assert.equal(tool.object_viewer_panel, null, 'expected object_viewer_panel cleared')
		assert.isNotOk(
			map_container_node.querySelector('.uca-maps-object-viewer-control'),
			'expected the button removed from the DOM'
		)
	})



	// hito 7 — functionality #7 of the audit, "1x1" (onexone.js): a toggle
	// button (NO panel — see onexone.js file header) that arms a mode where
	// clicking an existing Marker creates a 1 m-radius rectangle around it,
	// auto-flagged as uncertainty (functionality #3). layer_id 3 (the seeded
	// marker) is this block's own subject throughout.

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

		const marker = geolocation.FeatureGroup[3].getLayers()[0]
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
		assert.equal(
			rectangle.feature.properties.uca_maps.onexone_of,
			marker.feature.properties.uca_maps.uid,
			'expected the rectangle linked back to the marker by uid'
		)
		assert.isOk(
			rectangle.feature.properties.uca_maps.uncertainty,
			'expected row 7\'s own description honoured: "marcado automáticamente como incertidumbre"'
		)
	})

	it('create_onexone_rectangle is idempotent — a marker that already has one does not get a second', function() {

		const marker = geolocation.FeatureGroup[3].getLayers()[0]
		create_onexone_rectangle(tool, marker)
		const layers_after_first = geolocation.FeatureGroup[3].getLayers().length

		create_onexone_rectangle(tool, marker)
		assert.equal(
			geolocation.FeatureGroup[3].getLayers().length, layers_after_first,
			'expected the second call to no-op (onexone_uid guard, v6 parity: is_oneXone)'
		)
	})

	it('create_onexone_rectangle skips a centroid marker — not a real drawn point a user could 1x1', function() {

		const parent = geolocation.FeatureGroup[1].getLayers()[0] // seeded polygon
		toggle_centroid(tool, parent)
		const centroid_uid = parent.feature.properties.uca_maps.centroid_uid
		const centroid = geolocation.FeatureGroup[1].getLayers().find((candidate) =>
			candidate.feature && candidate.feature.properties.uca_maps
			&& candidate.feature.properties.uca_maps.uid===centroid_uid
		)
		const layers_before = geolocation.FeatureGroup[1].getLayers().length

		create_onexone_rectangle(tool, centroid)

		assert.equal(
			geolocation.FeatureGroup[1].getLayers().length, layers_before,
			'expected no rectangle created for a centroid marker (centroid_of guard)'
		)
	})

	it('create_onexone_rectangle skips a Marker while Geoman is mid-edit elsewhere on the map (v6\'s geoman_edition_mode guard)', function() {

		const marker = geolocation.FeatureGroup[3].getLayers()[0]
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

	it('popupopen only arms a rectangle while 1x1 mode is on (not before, not after clicking the button)', function() {

		tool.attach_onexone()
		const marker = geolocation.FeatureGroup[3].getLayers()[0]
		const layers_before = geolocation.FeatureGroup[3].getLayers().length

		marker.openPopup() // 1x1 mode still off
		assert.equal(geolocation.FeatureGroup[3].getLayers().length, layers_before, 'expected no rectangle while disarmed')
		marker.closePopup()

		tool.onexone_control.getContainer().click() // arm it
		marker.openPopup()
		assert.equal(
			geolocation.FeatureGroup[3].getLayers().length, layers_before + 1,
			'expected one rectangle created once armed and the marker is clicked'
		)
	})

	it('deleting the rectangle clears the marker\'s onexone_uid (usable again); deleting the marker does NOT cascade-delete the rectangle', function() {

		tool.attach_onexone()
		const marker = geolocation.FeatureGroup[3].getLayers()[0]
		create_onexone_rectangle(tool, marker)

		const onexone_uid = marker.feature.properties.uca_maps.onexone_uid
		const rectangle = geolocation.FeatureGroup[3].getLayers().find((candidate) =>
			candidate.feature && candidate.feature.properties.uca_maps
			&& candidate.feature.properties.uca_maps.uid===onexone_uid
		)

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
		const second_rectangle = geolocation.FeatureGroup[3].getLayers().find((candidate) =>
			candidate.feature && candidate.feature.properties.uca_maps
			&& candidate.feature.properties.uca_maps.uid===second_uid
		)
		geolocation.FeatureGroup[3].removeLayer(marker)
		geolocation.map.fire('pm:remove', {layer: marker})

		assert.isOk(
			geolocation.FeatureGroup[3].hasLayer(second_rectangle),
			'expected NO cascade delete (deliberate deviation from v6, onexone.js file header): the rectangle stands alone'
		)
	})

	it('detach_onexone removes the button and stops both map listeners', async function() {

		tool.attach_onexone()
		const map_container_node = geolocation.map.getContainer()
		assert.isOk(tool.onexone_control, 'expected the control attached first')

		await tool.destroy(false, false, false)

		assert.equal(tool.onexone_control, null, 'expected onexone_control cleared')
		assert.equal(tool._onexone_popupopen_handler, null, 'expected _onexone_popupopen_handler cleared')
		assert.equal(tool._onexone_pmremove_handler, null, 'expected _onexone_pmremove_handler cleared')
		assert.isNotOk(
			map_container_node.querySelector('.uca-maps-onexone-control'),
			'expected the button removed from the DOM'
		)
	})



	// left toolbar refactor (2026-09-04) — dev-only server-capabilities
	// diagnostic (capabilities_panel.js), NOT one of the 15 functionalities
	// in docs/Funcionalidades de tool_leaflet_special_tools.md, so it is
	// SHOW_DEVELOPER-gated instead of getting an end-user button (see
	// CLAUDE.local.md "Left toolbar"). This suite's own server always runs
	// with DEDALO_DEV_MODE=true (scripts/client_test_server.ts), so a
	// logged-in session here is always a dev session — attach_capabilities_panel
	// is asserted to actually build the button+panel, not merely tolerated.

	it('attach_capabilities_panel builds its own dev-only button+panel (SHOW_DEVELOPER===true in this suite)', function() {

		tool.attach_capabilities_panel()

		const control = geolocation.map.getContainer().querySelector('.uca-maps-capabilities-control')
		assert.isOk(control, 'expected the capabilities toggle button (suite runs DEDALO_DEV_MODE=true)')
		assert.isOk(tool.capabilities_panel, 'expected the capabilities panel built')
		assert.equal(tool.capabilities_panel.hidden, true, 'expected the panel hidden by default')

		control.click()
		assert.equal(tool.capabilities_panel.hidden, false, 'expected the panel shown after one click')
		control.click()
		assert.equal(tool.capabilities_panel.hidden, true, 'expected the panel hidden again after a second click')
	})

	it('detach_capabilities_panel removes the dev-only control and panel', async function() {

		tool.attach_capabilities_panel()
		const map_container_node = geolocation.map.getContainer()
		assert.isOk(tool.capabilities_control, 'expected the control attached first')
		assert.isOk(
			map_container_node.querySelector('.uca-maps-capabilities-control'),
			'expected the button in the DOM before teardown'
		)

		await tool.destroy(false, false, false)

		assert.equal(tool.capabilities_control, null, 'expected capabilities_control cleared')
		assert.equal(tool.capabilities_panel, null, 'expected capabilities_panel cleared')
		assert.isNotOk(
			map_container_node.querySelector('.uca-maps-capabilities-control'),
			'expected the button removed from the DOM'
		)
	})



	// left toolbar refinements (2026-09-04, Sergio's validation feedback on
	// hito 3c): "DEV" stacks above the two real functionalities, and opening
	// one panel closes any other one already open.

	it('edit() stacks the dev-only "DEV" button above "UCA"/"IMG"/"OBJ"/"1x1"/"XYZ" (attach order = corner order)', async function() {

		tool.type		= 'tool'
		tool.mode		= 'edit'
		tool.context	= { label: 'Mapas UCA' }

		await tool.edit({})

		const corner = tool.map_control.getContainer().closest('.leaflet-top.leaflet-left')
		assert.isOk(corner, 'expected the "UCA" button inside Leaflet\'s topleft corner')

		const buttons = Array.from(corner.querySelectorAll('.uca-maps-toolbar-button'))
		const classes = buttons.map((button) => {
			if (button.classList.contains('uca-maps-capabilities-control'))	return 'DEV'
			if (button.classList.contains('uca-maps-control'))				return 'UCA'
			if (button.classList.contains('uca-maps-map-image-control'))		return 'IMG'
			if (button.classList.contains('uca-maps-object-viewer-control'))	return 'OBJ'
			if (button.classList.contains('uca-maps-onexone-control'))		return '1x1'
			if (button.classList.contains('uca-maps-xyz-control'))			return 'XYZ'
			return 'unknown'
		})
		assert.deepEqual(classes, ['DEV', 'UCA', 'IMG', 'OBJ', '1x1', 'XYZ'], 'expected DEV first (topmost), then UCA, IMG, OBJ, 1x1, XYZ')
	})

	it('opening one panel closes any other panel already open (only one at a time)', function() {

		tool.attach_capabilities_panel()
		tool.attach_console()
		tool.attach_map_image_download_control()
		tool.attach_object_viewer()

		const dev_control	= geolocation.map.getContainer().querySelector('.uca-maps-capabilities-control')
		const uca_control	= geolocation.map.getContainer().querySelector('.uca-maps-control')
		const img_control	= geolocation.map.getContainer().querySelector('.uca-maps-map-image-control')
		const obj_control	= geolocation.map.getContainer().querySelector('.uca-maps-object-viewer-control')

		dev_control.click()
		assert.equal(tool.capabilities_panel.hidden, false, 'expected DEV open after its own click')

		uca_control.click()
		assert.equal(tool.panel_node.hidden, false, 'expected UCA open after its own click')
		assert.equal(tool.capabilities_panel.hidden, true, 'expected DEV closed by opening UCA')

		img_control.click()
		assert.equal(tool.map_image_panel.hidden, false, 'expected IMG open after its own click')
		assert.equal(tool.panel_node.hidden, true, 'expected UCA closed by opening IMG')
		assert.equal(tool.capabilities_panel.hidden, true, 'expected DEV to stay closed')

		obj_control.click()
		assert.equal(tool.object_viewer_panel.hidden, false, 'expected OBJ open after its own click')
		assert.equal(tool.map_image_panel.hidden, true, 'expected IMG closed by opening OBJ')

		// re-clicking IMG's own button still just toggles IT — no stale flag
		// from being force-closed by a sibling earlier (toolbar.js
		// is_toolbar_panel_visible file comment)
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



	// hito 9 — functionality #5, "XYZ basemaps" (js/xyz_basemaps.js). This
	// suite's default fixture (elements.js, no context.features.geo_provider
	// stamped) falls to component_geolocation's own 'VARIOUS' default branch,
	// which already builds a real layer_control seeded with arcgis+osm —
	// exactly the "existing control" path xyz_basemaps.js must clean up
	// (v6's real "OSM duplicated" bug, file header of xyz_basemaps.js).

	it('attach_xyz_basemaps seeds the 3 v6 defaults, replaces the core\'s own arcgis/osm base layers (no duplicates), and activates the first', function() {

		tool.attach_xyz_basemaps()

		const control = geolocation.map.getContainer().querySelector('.uca-maps-xyz-control')
		assert.isOk(control, 'expected the "XYZ" toggle button')
		assert.isOk(tool.xyz_panel, 'expected the xyz panel built')
		assert.equal(tool.xyz_panel.hidden, true, 'expected the panel hidden by default')
		assert.deepEqual(tool.basemaps, DEFAULT_BASEMAPS, 'expected the 3 v6 defaults seeded')

		// the fix: exactly 3 tile entries in the control, no leftover
		// arcgis/osm from the core's own VARIOUS branch, no duplicate names
		const tile_entries = Object.values(geolocation.layer_control._layers)
			.filter((entry) => entry.layer instanceof L.TileLayer)
		assert.equal(tile_entries.length, 3, 'expected exactly 3 base layers registered, no leftovers/duplicates')
		assert.deepEqual(tile_entries.map((entry) => entry.name).sort(), ['ARCGIS', 'Google Maps', 'OSM'], 'expected exactly the 3 v6 default names, no duplicate "OSM"')

		assert.equal(geolocation.map.hasLayer(tool._xyz_tile_layers[0]), true, 'expected the first basemap (OSM) active on the map')
		assert.equal(geolocation.map.hasLayer(tool._xyz_tile_layers[1]), false, 'expected the other basemaps NOT active')
		assert.equal(geolocation.map.hasLayer(tool._xyz_tile_layers[2]), false, 'expected the other basemaps NOT active')
	})

	it('attach_xyz_basemaps takes over an OSM-provider record (no layer_control yet): builds one, drops the raw tile layer, disconnects theme_observer', function() {

		// simulate component_geolocation's OSM branch (component_geolocation.js:897-907)
		// instead of this fixture's real VARIOUS branch — geolocation.layer_control
		// stays false, a single raw tile layer is added directly to the map.
		// The fixture's own default (VARIOUS) control is removed for real first,
		// not just unreferenced — else it lingers, unremovable, in the map's DOM
		let disconnect_calls = 0
		geolocation.map.removeControl(geolocation.layer_control)
		const raw_tile_layer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png').addTo(geolocation.map)
		geolocation.layer_control	= false
		geolocation.tile_layer		= raw_tile_layer
		geolocation.theme_observer	= { disconnect: () => { disconnect_calls++ } }

		tool.attach_xyz_basemaps()

		assert.isOk(geolocation.layer_control, 'expected a fresh layer_control created')
		assert.notEqual(geolocation.layer_control, false)
		assert.equal(geolocation.map.hasLayer(raw_tile_layer), false, 'expected the raw OSM tile layer removed from the map')
		assert.equal(disconnect_calls, 1, 'expected theme_observer.disconnect() called exactly once')
		assert.equal(geolocation.map.hasLayer(tool._xyz_tile_layers[0]), true, 'expected our own first basemap active instead')
	})

	it('attach_xyz_basemaps also sweeps an UNTRACKED raw layer (GOOGLE/ARCGIS providers store no reference on geolocation at all)', function() {

		// component_geolocation.js's GOOGLE/ARCGIS branches (:909-923) call
		// `.addTo(self.map)` on an anonymous layer, never assigning it to any
		// named property — only `map.eachLayer` can find it (review-diff
		// correctness finding, hito 9). Real removal of the fixture's own
		// default control first — see the OSM-takeover test above.
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
		assert.equal(tool.basemaps.length, 3, 'expected no basemap appended by any of the failed validations')

		const result = tool.add_basemap({
			url: 'https://example.com/{z}/{x}/{y}.png', name: '<b>Custom</b>', attribution: '<img src=x onerror=alert(1)>me', minzoom: '2', maxzoom: '18'
		})
		assert.deepEqual(result, {ok: true})
		assert.equal(tool.basemaps.length, 4, 'expected the new basemap appended')
		assert.deepEqual(
			tool.basemaps[3],
			{url: 'https://example.com/{z}/{x}/{y}.png', name: 'Custom', attribution: 'me', minzoom: 2, maxzoom: 18},
			'expected strip_tags on both name AND attribution (Leaflet renders attribution via innerHTML), parsed integer zooms'
		)
		assert.equal(geolocation.map.hasLayer(tool._xyz_tile_layers[3]), true, 'expected the newly added basemap activated')
	})

	it('delete_basemap refuses to remove the last remaining basemap; removes any other and reactivates index 0', function() {

		tool.attach_xyz_basemaps()

		assert.deepEqual(tool.delete_basemap(1), {ok: true}) // ARCGIS gone
		assert.equal(tool.basemaps.length, 2)
		assert.deepEqual(tool.delete_basemap(1), {ok: true}) // Google Maps gone
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
		assert.deepEqual(tool.basemaps.map((b) => b.name), ['ARCGIS', 'OSM', 'Google Maps'])
		assert.equal(geolocation.map.hasLayer(tool._xyz_tile_layers[0]), true, 'expected the new index-0 entry (ARCGIS) active')

		assert.deepEqual(tool.move_basemap(0, -1), {ok: false}, 'expected refusal moving index 0 further up')
		assert.deepEqual(tool.move_basemap(2, 1), {ok: false}, 'expected refusal moving the last entry further down')
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
		assert.equal(items.length, 4, 'expected the list rebuilt with the new entry')
		assert.equal(items[3].querySelector('.uca-maps-xyz-item-name').textContent, 'DOM basemap')

		items[3].querySelector('.uca-maps-xyz-delete').click()
		assert.equal(panel.querySelectorAll('.uca-maps-xyz-item').length, 3, 'expected the row removed from the DOM')
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

		// real removal of the fixture's own default control first — see the
		// OSM-takeover test above (otherwise it lingers, unremovable, in the DOM)
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

})

// @license-end
