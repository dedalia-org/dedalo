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
		// pairs, one per functionality (CLAUDE.local.md "Left toolbar").
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

	it('edit() stacks the dev-only "DEV" button above "UCA"/"IMG" (attach order = corner order)', async function() {

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
			return 'unknown'
		})
		assert.deepEqual(classes, ['DEV', 'UCA', 'IMG'], 'expected DEV first (topmost), then UCA, then IMG')
	})

	it('opening one panel closes any other panel already open (only one at a time)', function() {

		tool.attach_capabilities_panel()
		tool.attach_console()
		tool.attach_map_image_download_control()

		const dev_control	= geolocation.map.getContainer().querySelector('.uca-maps-capabilities-control')
		const uca_control	= geolocation.map.getContainer().querySelector('.uca-maps-control')
		const img_control	= geolocation.map.getContainer().querySelector('.uca-maps-map-image-control')

		dev_control.click()
		assert.equal(tool.capabilities_panel.hidden, false, 'expected DEV open after its own click')

		uca_control.click()
		assert.equal(tool.panel_node.hidden, false, 'expected UCA open after its own click')
		assert.equal(tool.capabilities_panel.hidden, true, 'expected DEV closed by opening UCA')

		img_control.click()
		assert.equal(tool.map_image_panel.hidden, false, 'expected IMG open after its own click')
		assert.equal(tool.panel_node.hidden, true, 'expected UCA closed by opening IMG')
		assert.equal(tool.capabilities_panel.hidden, true, 'expected DEV to stay closed')

		// re-clicking IMG's own button still just toggles IT — no stale flag
		// from being force-closed by a sibling earlier (toolbar.js
		// is_toolbar_panel_visible file comment)
		uca_control.click()
		assert.equal(tool.panel_node.hidden, false, 'expected UCA reopened by its own click, even though a sibling force-closed it earlier')
		assert.equal(tool.map_image_panel.hidden, true, 'expected IMG closed by reopening UCA')
	})

})

// @license-end
